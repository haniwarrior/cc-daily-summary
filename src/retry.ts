import OpenAI from 'openai';
import { ServerOfflineError, TimeoutError, NetworkError, PermissionError, NotFoundError } from '@concrnt/client';

export class HttpError extends Error {
  constructor(public status: number) { super(`Concrnt HTTP ${status}`); }
}

function sdkHttpStatus(error: unknown): number | undefined {
  // @concrnt/client 2.0.5 fetchWithCacheが型を付けずに投げる正確な書式。
  const match = error instanceof Error ? /^fetch failed on transport: (\d{3})\b/.exec(error.message) : null;
  return match ? Number(match[1]) : undefined;
}

export function retryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError || error instanceof ServerOfflineError ||
      error instanceof TimeoutError || error instanceof NetworkError) return true;
  if (error instanceof OpenAI.APIError && error.code === 'insufficient_quota') return false;
  if (error instanceof OpenAI.APIError || error instanceof HttpError) {
    const status = error.status ?? 0;
    return status === 408 || status === 429 || status >= 500;
  }
  const status = sdkHttpStatus(error);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  if (error instanceof Error && error.cause) return retryable(error.cause);
  return false;
}

// 外部エラーのmessage/bodyには秘密情報が含まれ得るので、そのままログにしない。
export function errorLabel(error: unknown): string {
  if (error instanceof Error && error.cause) return errorLabel(error.cause);
  if (error instanceof OpenAI.APIError) return `OpenAI API error (HTTP ${error.status ?? 'connection/timeout'})`;
  if (error instanceof HttpError) return error.message;
  const status = sdkHttpStatus(error);
  if (status !== undefined) return `Concrnt HTTP ${status}`;
  if (error instanceof PermissionError) return 'Concrnt access denied';
  if (error instanceof NotFoundError) return 'Concrnt resource not found';
  if (retryable(error)) return '接続失敗・タイムアウト・サーバー一時停止';
  return '設定・応答形式・認証等の恒久エラー';
}

export async function withRetry<T>(
  stage: string, operation: () => Promise<T>,
  options: { maxRetries: number; retryIntervalSeconds: number },
  deps: { sleep?: (ms: number) => Promise<void>; log?: (message: string) => void } = {},
): Promise<T> {
  const log = deps.log ?? console.error;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const again = retryable(error) && attempt < options.maxRetries;
      log(`${stage} failed: ${errorLabel(error)}; attempt ${attempt + 1}/${options.maxRetries + 1}; ${again ? `Retry ${attempt + 1}/${options.maxRetries} in ${options.retryIntervalSeconds} seconds` : 'no further retry'}`);
      if (!again) throw error;
      await sleep(options.retryIntervalSeconds * 1000);
    }
  }
}
