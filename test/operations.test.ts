import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { Temporal } from '@js-temporal/polyfill';
import { loadConfig, parsePostTimelines } from '../src/config.js';
import { nextRun } from '../src/schedule.js';
import { withRetry, retryable, HttpError } from '../src/retry.js';
import { createSession, targetTimelines, summaryDocument, prepareSummary } from '../src/publish.js';
import { runDailyJob } from '../src/job.js';

// テスト専用の鍵。実サーバーへの登録・通信には使用しない。
const ccid = `con1${'a'.repeat(38)}`;
const env = { CONCRNT_SUBKEY: `concrnt-subkey ${'1'.repeat(64)} ${ccid}@example.com`,
  CONCRNT_HOST: 'example.com', POST_TIMELINE: '', POST_TIME: '23:50', TIMEZONE: 'Asia/Tokyo',
  OPENAI_API_KEY: 'test-only', OPENAI_MODEL: 'test-model', RETRY_INTERVAL_SECONDS: '60', MAX_RETRIES: '3' };
function config(overrides: Record<string, string> = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'concrnt-config-')), '.env');
  writeFileSync(path, Object.entries({ ...env, ...overrides }).map(([k,v]) => `${k}=${v}`).join('\n'));
  return loadConfig(path);
}

test('全設定を接続前に検証、CCIDはsubkeyからのみ取得', () => {
  const settings = config({ TARGET_USER: 'ignored', POST_TIMELINE: '   ' });
  assert.equal(createSession(settings).ccid, ccid);
  assert.deepEqual(settings.postTimelines, []);
  assert.equal(settings.maxRetries, 3);
  for (const [key, values] of Object.entries({ CONCRNT_SUBKEY: ['', 'invalid'], CONCRNT_HOST: ['', 'https://example.com'],
    POST_TIME: ['1:23', '24:00', '23:60', 'no'], TIMEZONE: ['', '+09:00', 'unknown'],
    OPENAI_API_KEY: [''], OPENAI_MODEL: [''], RETRY_INTERVAL_SECONDS: ['0', '-1', '1.5', 'NaN'], MAX_RETRIES: ['-1', '1.5'] })) {
    for (const value of values) assert.throws(() => config({ [key]: value }), new RegExp(key));
  }
  assert.equal(config({ MAX_RETRIES: '0' }).maxRetries, 0);
});

test('JSTの次回時刻・起動直後実行なし・DSTの欠落と重複', () => {
  assert.equal(nextRun(Temporal.Instant.from('2026-09-27T14:49Z'), '23:50', 'Asia/Tokyo').toString(), '2026-09-27T14:50:00Z');
  assert.equal(nextRun(Temporal.Instant.from('2026-09-27T14:50Z'), '23:50', 'Asia/Tokyo').toString(), '2026-09-28T14:50:00Z');
  assert.equal(nextRun(Temporal.Instant.from('2026-03-08T06:00Z'), '02:30', 'America/New_York').toString(), '2026-03-08T07:30:00Z');
  assert.equal(nextRun(Temporal.Instant.from('2026-11-01T05:31Z'), '01:30', 'America/New_York').toString(), '2026-11-02T06:30:00Z');
});

test('初回+3回、待機3回。認証失敗なら待機なし', async () => {
  let calls = 0; const waits: number[] = []; const logs: string[] = [];
  await assert.rejects(withRetry('fetch', async () => { calls++; throw new HttpError(503); },
    { maxRetries: 3, retryIntervalSeconds: 60 }, { sleep: async ms => { waits.push(ms); }, log: s => logs.push(s) }));
  assert.equal(calls, 4); assert.deepEqual(waits, [60000, 60000, 60000]);
  assert.match(logs[0], /attempt 1\/4.*Retry 1\/3 in 60/);
  calls = 0;
  await assert.rejects(withRetry('post', async () => { calls++; throw new HttpError(401); },
    { maxRetries: 3, retryIntervalSeconds: 60 }, { sleep: async () => assert.fail(), log: () => {} }));
  assert.equal(calls, 1);
  assert.equal(retryable(new OpenAI.APIError(429, { code: 'insufficient_quota' }, '', new Headers())), false);
  assert.equal(retryable(new HttpError(429)), true);
  assert.equal(retryable(new Error('fetch failed on transport: 429 private body')), true);
  assert.equal(retryable(new Error('fetch failed on transport: 401 private body')), false);
});

test('Homeと全追加先へ1つのMarkdown文書を配信し、署名済み本文を作る', async () => {
  const [home] = targetTimelines(ccid);
  assert.equal(home, `cckv://${ccid}/concrnt.world/profiles/main/home-timeline`);
  const a = 'cckv://example.com/community/a';
  const b = 'cckv://example.com/community/b';
  assert.deepEqual(targetTimelines(ccid, [a, home, b, a]), [home, a, b]);
  const session = createSession(config());
  session.api.getResource = async <T>() => ({ document: '{}', proof: {} }) as T;
  const doc = summaryDocument(ccid, [a, home, b, a], '要約です。');
  const payload = JSON.parse(await prepareSummary(session, doc));
  assert.deepEqual(JSON.parse(payload.document).distributes, [home, a, b]);
  assert.equal(JSON.parse(payload.document).author, ccid);
  assert.equal(payload.proof.type, 'concrnt-ecrecover-subkey');
  assert.ok(payload.proof.key.startsWith(`cckv://${ccid}/keys/`));
});

test('追加先のCSV解析、空項目・重複除去、明らかな不正URIの検出', () => {
  const a = 'cckv://example.net/concrnt.world/communities/aaaa';
  const b = 'cckv://example.net/concrnt.world/communities/bbbb';
  for (const value of [undefined, '', '  ', ', ,']) assert.deepEqual(parsePostTimelines(value), []);
  assert.deepEqual(parsePostTimelines(`${a}, ${b} ,, ${a}`), [a, b]);
  assert.deepEqual(config({ POST_TIMELINE: `${a}, ${b} ,, ${a}` }).postTimelines, [a, b]);
  for (const value of ['aaa', 'https://example.net/a', 'cckv://example.net', 'cckv://example.net/a b', 'cckv://example.net/a?key=secret']) {
    assert.throws(() => parsePostTimelines(value), /POST_TIMELINE/);
  }
  assert.deepEqual(summaryDocument(ccid, [], '本文').distributes, targetTimelines(ccid));
  assert.deepEqual(summaryDocument(ccid, [a], '本文').distributes, [...targetTimelines(ccid), a]);
});

test('0件では要約と投稿を呼ばない', async () => {
  await runDailyJob(config(), { verifySession: async () => {}, fetchPosts: async () => [],
    createSummaryOutput: async () => assert.fail('LLM called'), sendSummary: async () => assert.fail('post called') });
});

test('投稿失敗は取得・要約を繰り返さず、同じpayloadだけを再送', async () => {
  let fetched = 0; let summarized = 0; let prepared = 0; const sent: string[] = [];
  const settings = { ...config(), retryIntervalSeconds: 0, maxRetries: 1 };
  await runDailyJob(settings, { verifySession: async () => {}, fetchPosts: async c => {
    fetched++; assert.equal(c.targetUser, ccid);
    return [{ id: 'test', createdAt: '2026-09-27T00:00Z', time: Temporal.Instant.from('2026-09-27T00:00Z'), body: '本文', kind: 'post' }];
  }, createSummaryOutput: async () => { summarized++; return '要約です。'; },
  prepareSummary: async () => { prepared++; return 'fixed-signed-payload'; },
  sendSummary: async (_, payload) => { sent.push(payload); if (sent.length === 1) throw new HttpError(503); } });
  assert.equal(fetched, 1); assert.equal(summarized, 1); assert.equal(prepared, 1);
  assert.deepEqual(sent, ['fixed-signed-payload', 'fixed-signed-payload']);
});
