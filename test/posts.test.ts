import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';
import { NotFoundError, type Api, type SignedDocument, type QueryResult } from '@concrnt/client';
import { Schemas } from '@concrnt/worldlib';
import { loadConfig, todayWindow } from '../src/config.js';
import { fetchPosts } from '../src/concrnt.js';
import { toSummarySources } from '../src/summary.js';

const config = { targetUser: `con1${'a'.repeat(38)}`, timezone: 'Asia/Tokyo', host: 'example.com' };
const window = todayWindow(config.timezone, Temporal.Instant.from('2026-09-27T05:30:00Z'));
function record(id: string, time: string, schema: string = Schemas.markdownMessage, body = '本文', extra = {}): SignedDocument {
  return { cckv: `cckv://${config.targetUser}/posts/${id}`, ccfs: `ccfs://${id}`,
    document: JSON.stringify({ kind: 'record', author: config.targetUser, createdAt: time, schema, value: { body }, ...extra }),
    proof: { type: 'test', signature: '' } };
}
function mock(pages: (QueryResult | Error)[]) {
  const calls: Parameters<Api['query']>[0][] = [];
  const api = {
    getServer: async () => ({}),
    getEntity: async () => ({ author: config.targetUser, value: { domain: 'home.example.com' } }),
    query: async (query: Parameters<Api['query']>[0], domain?: string) => {
      calls.push(query);
      assert.equal(domain, 'home.example.com');
      const page = pages.shift();
      if (page instanceof Error) throw page;
      assert.ok(page, 'unexpected extra page');
      return page;
    },
  } as unknown as Pick<Api, 'getServer' | 'getEntity' | 'query'>;
  return { api, calls };
}
const page = (items: SignedDocument[], next: string | null = null): QueryResult => ({ items, next, prev: null });

test('Raw本文を正規化し、非文字列・空本文を除外して次ページも取得する', async () => {
  const createdAt = '2026-09-27T01:00:00.123456789Z';
  const text = '  **Markdown**\n\n    インデント付き本文  \n';
  const invalid = [null, 123, false, {}, [], undefined].map((body, i) =>
    record(`invalid-${i}`, createdAt, undefined, '', { value: { body } }));
  const { api } = mock([
    page([...invalid, record('empty', createdAt, undefined, ''),
      record('spaces', createdAt, undefined, ' \t\n　')], createdAt),
    page([record('valid', createdAt, undefined, text)]),
  ]);
  const posts = await fetchPosts(config, window, api);
  assert.deepEqual(toSummarySources(posts), [{
    id: `cckv://${config.targetUser}/posts/valid`, createdAt, text,
  }]);
  assert.deepEqual(toSummarySources([]), []);
  assert.deepEqual(toSummarySources(posts.filter(p => p.id.endsWith('/spaces'))), []);
});

test('JSTと夏時間のある日の0時をUTCに変換する', () => {
  assert.equal(window.start.toString(), '2026-09-26T15:00:00Z');
  assert.equal(todayWindow('America/New_York', Temporal.Instant.from('2026-03-08T18:00Z')).start.toString(), '2026-03-08T05:00:00Z');
  assert.equal(todayWindow('America/New_York', Temporal.Instant.from('2026-11-01T18:00Z')).start.toString(), '2026-11-01T04:00:00Z');
});

test('境界を包含、本人のみ、重複排除、時系列順、本文種別の区別', async () => {
  const early = record('early', window.start.toString());
  const last = record('last', window.end.toString(), Schemas.mediaMessage, '画像の説明');
  const reply = record('reply', '2026-09-27T01:00Z', Schemas.replyMessage);
  const quote = record('quote', '2026-09-27T02:00Z', Schemas.rerouteMessage, '自分の感想');
  const next = '2026-09-27T02:00:00.123456789Z';
  const { api, calls } = mock([
    page([last, quote, record('future', '2026-09-27T05:30:00.000000001Z')], next),
    page([quote, reply, early, record('old', '2026-09-26T14:59:59.999999999Z'),
      record('other', '2026-09-27T00:00Z', undefined, '他人', { author: 'someone' }),
      record('repost', '2026-09-27T00:00Z', Schemas.rerouteMessage, '  '),
      record('reference', '2026-09-27T00:00Z', 'https://schema.concrnt.net/reference.json'),
      record('deleted', '2026-09-27T00:00Z', undefined, '', { kind: 'delete' })]),
  ]);
  const result = await fetchPosts(config, window, api);
  assert.deepEqual(result.map(p => p.id.split('/').pop()), ['early', 'reply', 'quote', 'last']);
  assert.deepEqual(result.map(p => p.kind), ['post', 'reply', 'quote', 'post']);
  assert.equal(result[2].body, '自分の感想');
  assert.equal(calls[1].until, next);
  assert.equal(calls[0].since, window.start.toString());
});

test('空の権限フィルタ済みページでもnextを辿る', async () => {
  const { api } = mock([page([], '2026-09-27T01:00:00Z'), page([record('ok', '2026-09-27T00:00Z')])]);
  assert.equal((await fetchPosts(config, window, api)).length, 1);
});
test('0件は正常終了、日付より古いnextは取得しない', async () => {
  assert.deepEqual(await fetchPosts(config, window, mock([page([])]).api), []);
  assert.deepEqual(await fetchPosts(config, window, mock([page([], '2026-09-26T14:59:59Z')]).api), []);
});
test('途中のAPIエラーは部分結果を返さない', async () => {
  const { api } = mock([page([record('x', '2026-09-27T03:00Z')], '2026-09-27T02:00:00Z'), new Error('network failed')]);
  await assert.rejects(fetchPosts(config, window, api), /2ページ目.*未完了/);
});
test('同時刻集中などによるカーソル停止はエラー', async () => {
  const cursor = '2026-09-27T01:00:00Z';
  const { api } = mock([page([], cursor), page([], cursor)]);
  await assert.rejects(fetchPosts(config, window, api), /カーソルが進みません/);
});
test('接続失敗とユーザー未解決を区別する', async () => {
  const { api } = mock([]);
  api.getServer = async () => { throw new Error('connection failed'); };
  await assert.rejects(fetchPosts(config, window, api), /APIへの接続に失敗/);
  const second = mock([]).api;
  second.getEntity = async () => { throw new NotFoundError('missing', 'cckv://missing'); };
  await assert.rejects(fetchPosts(config, window, second), /ユーザーが存在しないか/);
});
test('.envなしは明示エラー', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'concrnt-test-')), '.env');
  assert.throws(() => loadConfig(path), /.env がありません/);
});
