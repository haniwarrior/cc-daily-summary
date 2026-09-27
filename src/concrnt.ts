import { Api, InMemoryAuthProvider, InMemoryKVS, NotFoundError } from '@concrnt/client';
import { Schemas } from '@concrnt/worldlib';
import { Temporal } from '@js-temporal/polyfill';
import type { todayWindow } from './config.js';

export interface Post { id: string; createdAt: string; time: Temporal.Instant; body: string; kind: 'post' | 'reply' | 'quote' }
type Window = ReturnType<typeof todayWindow>;
type ReadApi = Pick<Api, 'getServer' | 'getEntity' | 'query'>;
const ordinary = new Set<string>([
  Schemas.plaintextMessage, Schemas.markdownMessage, Schemas.mediaMessage,
  Schemas.gfmMessage, Schemas.mfmMessage,
]);

export async function fetchPosts(config: { host: string; targetUser: string }, window: Window, injectedApi?: ReadApi): Promise<Post[]> {
  const api = injectedApi ?? new Api(config.host, new InMemoryAuthProvider(), new InMemoryKVS());
  // 先に接続確認し、サーバー自体の404とユーザー解決の404を区別する。
  try { await api.getServer(config.host); }
  catch (error) { throw new Error('Concrnt APIへの接続に失敗しました。', { cause: error }); }
  let domain: string;
  try {
    const entity = await api.getEntity(config.targetUser);
    if (entity.author !== config.targetUser || !entity.value?.domain) throw new Error('ユーザー応答の形式が不正です。');
    domain = entity.value.domain;
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new Error('ユーザーが存在しないか、指定サーバーからCCIDを解決できません。CCIDとCONCRNT_HOSTを確認してください。');
    }
    throw new Error('ユーザー取得に失敗しました。', { cause: error });
  }

  const posts = new Map<string, Post>();
  const cursors = new Set<string>();
  let until = window.end.toString();
  for (let pageNumber = 1; ; pageNumber++) {
    let page;
    try {
      page = await api.query({
        // 全プロフィールを含む本人の保存レコード。referenceは本文投稿として扱わない。
        prefix: `cckv://${config.targetUser}/`,
        since: window.start.toString(), until, order: 'desc', limit: 100,
      }, domain);
    } catch (error) {
      throw new Error(`履歴の${pageNumber}ページ目の取得に失敗しました。結果は未完了です。`, { cause: error });
    }
    if (!Array.isArray(page.items) || (page.next !== null && typeof page.next !== 'string')) {
      throw new Error('v2履歴APIの応答形式が想定と異なります。取得を中止しました。');
    }
    for (const item of page.items) {
      let doc;
      try { doc = JSON.parse(item.document); }
      catch { throw new Error(`${pageNumber}ページ目に不正なJSONがあります。取得を中止しました。`); }
      if (doc?.kind !== 'record' || doc.author !== config.targetUser) continue;
      // worldlib 2.0.5のschemasでreply.bodyは必須、reroute.bodyは任意。
      // 既存判定を維持し、本文付きrerouteをquoteとして扱う（参照先の本文は含めない）。
      const kind = doc.schema === Schemas.replyMessage ? 'reply'
        : doc.schema === Schemas.rerouteMessage ? 'quote' : ordinary.has(doc.schema) ? 'post' : undefined;
      if (!kind) continue;
      // 本文のないレコードで履歴取得全体を失敗させない。
      if (typeof doc.value?.body !== 'string') continue;
      // 本文なしのrepostは除外。引用先本文やreference先本文は取得しない。
      if (kind === 'quote' && !doc.value.body.trim()) continue;
      const time = Temporal.Instant.from(doc.createdAt);
      if (Temporal.Instant.compare(time, window.start) < 0 || Temporal.Instant.compare(time, window.end) > 0) continue;
      if (!item.cckv) throw new Error('投稿ID (cckv) が応答にありません。');
      posts.set(item.cckv, { id: item.cckv, createdAt: doc.createdAt, time, body: doc.value.body, kind });
    }
    // 空ページでも、権限フィルターの先にnextがあれば続ける。
    if (page.next === null) break;
    const nextTime = Temporal.Instant.from(page.next);
    if (Temporal.Instant.compare(nextTime, window.start) < 0) break;
    if (page.next === until || cursors.has(page.next) || Temporal.Instant.compare(nextTime, Temporal.Instant.from(until)) > 0) {
      throw new Error('paginationのカーソルが進みません。同時刻のレコード集中等により全件取得を保証できないため中止しました。');
    }
    cursors.add(page.next);
    until = page.next; // RFC3339Nanoをミリ秒へ丸めず、そのまま渡す。
  }
  return [...posts.values()].sort((a, b) => Temporal.Instant.compare(a.time, b.time) || a.id.localeCompare(b.id));
}
