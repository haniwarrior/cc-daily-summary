import { Temporal } from '@js-temporal/polyfill';
import { todayWindow, type Config } from './config.js';
import { fetchPosts } from './concrnt.js';
import { toSummarySources } from './summary.js';
import { createSummaryOutput } from './llm.js';
import { createSession, verifySession, targetTimelines, summaryDocument, prepareSummary, sendSummary } from './publish.js';
import { withRetry } from './retry.js';

const defaults = { fetchPosts, verifySession, createSummaryOutput, prepareSummary, sendSummary };
export async function runDailyJob(config: Config, dependencies: Partial<typeof defaults> = {}): Promise<void> {
  const operations = { ...defaults, ...dependencies };
  const executionTime = Temporal.Now.instant(); // retryが翌日になっても取得範囲・ヘッダーは固定
  console.log('Post fetch started');
  const posts = await withRetry('Concrnt fetch', async () => {
    const session = createSession(config);
    await operations.verifySession(session);
    console.log(`Authenticated user CCID: ${session.ccid}`);
    return operations.fetchPosts({ host: config.host, targetUser: session.ccid }, todayWindow(config.timezone, executionTime), session.api);
  }, config);
  const sources = toSummarySources(posts);
  console.log(`Fetched ${posts.length} posts; selected ${sources.length} for summary`);
  if (!sources.length) { console.log('No posts to summarize.'); return; }
  console.log('OpenAI summary started');
  const text = await withRetry('OpenAI summary', () => operations.createSummaryOutput(sources, executionTime, config.timezone,
    { loadConfig: () => config.llm }), config);
  console.log('OpenAI summary succeeded');
  console.log(text);
  const session = createSession(config);
  const timelines = targetTimelines(session.ccid, config.postTimelines);
  const doc = summaryDocument(session.ccid, config.postTimelines, text);
  console.log(`Concrnt post started: ${timelines.length} destinations: ${timelines.join(', ')}`);
  let payload: string | undefined;
  await withRetry('Concrnt post', async () => {
    const fresh = createSession(config); // offlineキャッシュを次の試行へ持ち越さない
    payload ??= await operations.prepareSummary(fresh, doc);
    await operations.sendSummary(fresh, payload); // 同じJSON・署名・key・createdAtを再送
  }, config);
  console.log(`Concrnt post succeeded: ${doc.key}`);
}
