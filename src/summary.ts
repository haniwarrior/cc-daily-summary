import type { Post } from './concrnt.js';

export type SummarySource = {
  id: string;
  createdAt: string;
  text: string;
};

// fetchPostsで抽出したdocument.value.bodyを要約用の単純なデータへ変換する。
// trimは空本文の判定だけに使い、Markdownのインデント・改行等はそのまま保持する。
export function toSummarySources(posts: readonly Post[]): SummarySource[] {
  return posts
    .filter(post => typeof post.body === 'string' && post.body.trim().length > 0)
    .map(post => ({ id: post.id, createdAt: post.createdAt, text: post.body }));
}
