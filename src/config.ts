import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { InMemoryAuthProvider, IsCCID } from '@concrnt/client';
import { Temporal } from '@js-temporal/polyfill';

export interface Config {
  subkey: string; host: string; postTimelines: string[]; postTime: string; timezone: string;
  llm: LlmConfig; retryIntervalSeconds: number; maxRetries: number;
}

function readEnv(path = fileURLToPath(new URL('../.env', import.meta.url))) {
  let source: string;
  try { source = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('.env がありません。プロジェクト直下に .env.example をコピーしてください。');
    }
    throw new Error('.env を読み込めません。', { cause: error });
  }
  return parse(source);
}

export interface LlmConfig { apiKey: string; model: string; summaryMaxChars: number }

export function parsePostTimelines(value?: string): string[] {
  const timelines = [...new Set((value ?? '').split(',').map(item => item.trim()).filter(Boolean))];
  for (const [index, timeline] of timelines.entries()) {
    try {
      const uri = new URL(timeline);
      if (uri.protocol !== 'cckv:' || !uri.hostname || uri.pathname.length <= 1 ||
          uri.username || uri.password || uri.search || uri.hash || /\s/.test(timeline)) throw new Error();
    } catch {
      // 設定値をそのままログに含めず、何番目の項目かだけを示す。
      throw new Error(`POST_TIMELINE の${index + 1}件目は、cckv://所有者/パス形式のv2 Timeline URIで指定してください。`);
    }
  }
  return timelines;
}

export function loadLlmConfig(path?: string): LlmConfig {
  const env = readEnv(path);
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('.env に OPENAI_API_KEY を設定してください。');
  const model = env.OPENAI_MODEL?.trim();
  if (!model) throw new Error('.env に OPENAI_MODEL を設定してください。');
  const value = env.SUMMARY_MAX_CHARS?.trim() ?? '';
  const summaryMaxChars = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(summaryMaxChars) || summaryMaxChars <= 0) {
    throw new Error('SUMMARY_MAX_CHARS は正の整数（JavaScriptの安全な整数範囲内）で指定してください。');
  }
  return { apiKey, model, summaryMaxChars };
}

export function loadConfig(path?: string): Config {
  const env = readEnv(path);
  const subkey = env.CONCRNT_SUBKEY?.trim();
  if (!subkey) throw new Error('CONCRNT_SUBKEY を設定してください。');
  try {
    const auth = new InMemoryAuthProvider(undefined, subkey);
    if (!IsCCID(auth.getCCID()) || !auth.canSignSub()) throw new Error();
  } catch { throw new Error('CONCRNT_SUBKEY の形式が不正です。'); }
  const timezone = env.TIMEZONE?.trim() || '';
  try {
    if (!timezone || /^[+-]/.test(timezone)) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    Temporal.Now.zonedDateTimeISO(timezone);
  } catch { throw new Error('TIMEZONE に有効なIANA timezoneを設定してください。'); }
  const host = env.CONCRNT_HOST?.trim();
  if (!host) throw new Error('.env に CCID解決先の CONCRNT_HOST（Concrnt v2サーバー）を設定してください。');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+(?::\d+)?$/i.test(host)) {
    throw new Error('CONCRNT_HOST はドメイン名で指定してください（https://やパスは不要）。');
  }
  const postTime = env.POST_TIME?.trim() || '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(postTime)) throw new Error('POST_TIME は00:00〜23:59のHH:mm形式で指定してください。');
  const integer = (key: string, fallback: string, min: number) => {
    const value = env[key]?.trim() ?? fallback;
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > 2147483) {
      throw new Error(`${key} は${min}以上2147483以下の整数で指定してください。`);
    }
    return number;
  };
  return { subkey, timezone, host, postTime, postTimelines: parsePostTimelines(env.POST_TIMELINE),
    llm: loadLlmConfig(path), retryIntervalSeconds: integer('RETRY_INTERVAL_SECONDS', '60', 1),
    maxRetries: integer('MAX_RETRIES', '3', 0) };
}

export function todayWindow(timezone: string, end = Temporal.Now.instant()) {
  return { start: end.toZonedDateTimeISO(timezone).startOfDay().toInstant(), end };
}

export function formatTime(instant: Temporal.Instant, timezone: string): string {
  const date = instant.toZonedDateTimeISO(timezone);
  return `${date.toPlainDate()} ${date.toPlainTime().toString({ smallestUnit: 'second' })} ${date.offset}`;
}
