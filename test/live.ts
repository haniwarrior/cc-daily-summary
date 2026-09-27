// 明示実行用。設定されたユーザーの公開履歴だけを読み取り、本文はログに出さない。
import assert from 'node:assert/strict';
import { createSession, verifySession } from '../src/publish.js';
import { loadConfig, todayWindow } from '../src/config.js';
import { fetchPosts } from '../src/concrnt.js';

const config = loadConfig();
const window = todayWindow(config.timezone);
const session = createSession(config);
await verifySession(session);
const readConfig = { host: config.host, targetUser: session.ccid };
const api = session.api;
const expected = await fetchPosts(readConfig, window, api);
const query = api.query.bind(api);
let pages = 0;
api.query = async (params, domain, options) => {
  pages++;
  return query({ ...params, limit: 5 }, domain, options);
};
const actual = await fetchPosts(readConfig, window, api);
assert.deepEqual(actual, expected);
console.log(`実API照合成功: ${actual.length} posts, limit=5で${pages}ページ。limit=100と結果一致。`);
