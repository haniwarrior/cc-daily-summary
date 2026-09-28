import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { Temporal } from '@js-temporal/polyfill';
import { createSummaryOutput, SUMMARY_PROMPT, countSummaryChars, type Generate } from '../src/llm.js';
import { loadLlmConfig } from '../src/config.js';

const time = Temporal.Instant.from('2026-09-26T16:00:00Z');
const sources = [{ id: 'cckv://example/post', createdAt: '2026-09-26T15:30:00Z', text: '**相撲**について\n喜んだ' }];
const config = { apiKey: 'test-key', model: 'test-model' };
const ok = (text: string): Awaited<ReturnType<Generate>> => ({ status: 'completed', output_text: text, output: [] });

test('0件ならキー読み込みもLLM呼び出しもしない', async () => {
  const output = await createSummaryOutput([], time, 'Asia/Tokyo', {
    loadConfig: () => { throw new Error('must not load'); },
    generate: async () => { throw new Error('must not call'); },
  });
  assert.equal(output, 'No posts to summarize.');
});

test('JSON入力とプロンプトを渡し、JSTの日付ヘッダーをアプリが付ける', async () => {
  let calls = 0;
  const output = await createSummaryOutput(sources, time, 'Asia/Tokyo', {
    loadConfig: () => config,
    generate: async request => {
      calls++;
      assert.equal(request.model, 'test-model');
      assert.equal(request.instructions, SUMMARY_PROMPT);
      assert.equal(request.store, false);
      assert.deepEqual(JSON.parse(request.input as string), { date: '2026-09-27', timezone: 'Asia/Tokyo', posts: sources });
      assert.ok(!(request.input as string).includes(config.apiKey));
      return ok(' 相撲について喜ぶ投稿が見られた。\n');
    },
  });
  assert.equal(calls, 1);
  assert.equal(output, '【2026-09-27 本日の要約】\n\n相撲について喜ぶ投稿が見られた。');
});

test('不完全・空・拒否の応答を成功として表示しない', async () => {
  for (const response of [
    { ...ok('途中の本文'), status: 'incomplete' as const },
    ok('  \n'),
    { ...ok(''), output: [{ type: 'message' as const, id: 'refused', role: 'assistant' as const,
      status: 'completed' as const, content: [{ type: 'refusal' as const, refusal: 'refused' }] }] },
  ]) {
    await assert.rejects(createSummaryOutput(sources, time, 'Asia/Tokyo', {
      loadConfig: () => config, generate: async () => response,
    }), /LLM/);
  }
});

test('API認証エラーの生データを出さず設定確認を案内する', async () => {
  await assert.rejects(createSummaryOutput(sources, time, 'Asia/Tokyo', {
    loadConfig: () => config,
    generate: async () => { throw new OpenAI.APIError(401, { message: 'secret-test-key' }, 'secret-test-key', new Headers()); },
  }), error => error instanceof Error && error.message.includes('OPENAI_API_KEY') && !error.message.includes('secret-test-key'));
});

test('キーは.envから読み取り、未設定を検出しモデルを指定できる', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'concrnt-llm-')), '.env');
  writeFileSync(path, 'OPENAI_API_KEY=');
  assert.throws(() => loadLlmConfig(path), /OPENAI_API_KEY/);
  writeFileSync(path, 'OPENAI_API_KEY=test-key');
  assert.throws(() => loadLlmConfig(path), /OPENAI_MODEL/);
  writeFileSync(path, 'OPENAI_API_KEY=test-key\nOPENAI_MODEL=custom-model');
  assert.equal(loadLlmConfig(path).model, 'custom-model');
});


test('400文字はそのまま、401文字は1回だけ再要約する（ヘッダーは対象外）', async () => {
  for (const length of [400, 401]) {
    let calls = 0;
    const output = await createSummaryOutput(sources, time, 'Asia/Tokyo', {
      loadConfig: () => config,
      generate: async request => {
        calls++;
        if (calls === 1) return ok('あ'.repeat(length));
        assert.match(request.instructions!, /400文字以内に短縮/);
        assert.equal(JSON.parse(request.input as string).summary, 'あ'.repeat(401));
        return ok('短い要約です。');
      },
    });
    assert.equal(calls, length === 400 ? 1 : 2);
    assert.equal(output.split('\n\n')[1], length === 400 ? 'あ'.repeat(400) : '短い要約です。');
  }
});

test('再要約も超過なら警告だけ出し、改行も本文もそのまま採用する', async t => {
  let calls = 0;
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  const shortened = 'あ'.repeat(200) + '\r\n\n' + 'い'.repeat(227);
  const output = await createSummaryOutput(sources, time, 'Asia/Tokyo', {
    loadConfig: () => config,
    generate: async () => { calls++; return ok(calls === 1 ? 'あ'.repeat(500) : shortened); },
  });
  assert.equal(calls, 2);
  assert.equal(output, `【2026-09-27 本日の要約】\n\n${shortened}`);
  assert.deepEqual(warnings, ['Warning: summary still exceeds 400 characters after shortening (427 chars). Using it as-is.']);
});

test('CR/LFを数えず400文字なら初回結果の改行を維持して採用する', async () => {
  const body = 'あ'.repeat(200) + '\r\n\n\r' + 'い'.repeat(200);
  assert.equal(countSummaryChars(body), 400);
  assert.equal(countSummaryChars('a b\t\r\n'), 4);
  let calls = 0;
  const output = await createSummaryOutput(sources, time, 'Asia/Tokyo', {
    loadConfig: () => config,
    generate: async () => { calls++; return ok(body); },
  });
  assert.equal(calls, 1);
  assert.equal(output, `【2026-09-27 本日の要約】\n\n${body}`);
});

test('再要約の空応答もエラーにする', async () => {
  let calls = 0;
  await assert.rejects(createSummaryOutput(sources, time, 'Asia/Tokyo', {
    loadConfig: () => config,
    generate: async () => ok(++calls === 1 ? 'あ'.repeat(401) : ''),
  }), /本文が返りません/);
  assert.equal(calls, 2);
});
