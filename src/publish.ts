import { randomUUID } from 'node:crypto';
import { Api, InMemoryAuthProvider, InMemoryKVS, fetchWithTimeout, renderUriTemplate,
  type Document, type SignedDocument, PermissionError, NotFoundError } from '@concrnt/client';
import { Schemas, semantics } from '@concrnt/worldlib';
import type { Config } from './config.js';
import { HttpError } from './retry.js';

// query/commitのHTTPエラーを型で保持し、レスポンス本文をログに出さない。
export class AuthenticatedApi extends Api {
  override async fetchHost<T>(host: string, path: string, init: RequestInit = {}, timeoutms?: number): Promise<T> {
    const response = await fetchWithTimeout(`https://${host}${path}`, init, timeoutms);
    if (response.status === 403) throw new PermissionError('Concrnt access denied');
    if (response.status === 404) throw new NotFoundError('Concrnt resource not found', '');
    if (!response.ok) throw new HttpError(response.status);
    return response.json() as Promise<T>;
  }
}

export function createSession(config: Pick<Config, 'host' | 'subkey'>) {
  const auth = new InMemoryAuthProvider(undefined, config.subkey);
  return { auth, ccid: auth.getCCID(), api: new AuthenticatedApi(config.host, auth, new InMemoryKVS()) };
}
export type Session = ReturnType<typeof createSession>;

export async function verifySession(session: Session): Promise<void> {
  // worldlib Client.checkSubkeyStatusと同じschema/kind判定。unknownで続行しない。
  const key = await session.api.getDocument(semantics.subkey(session.ccid, session.auth.getCKID()!), undefined, { cache: 'no-cache' });
  if (key.kind !== 'record' || key.schema !== 'https://schema.concrnt.net/subkey.json') {
    throw new Error('Concrnt subkeyが失効しているか、登録内容が不正です。');
  }
}

export function targetTimelines(ccid: string, additional: readonly string[] = []): string[] {
  return [...new Set([semantics.homeTimeline(ccid, 'main'), ...additional])];
}

export function summaryDocument(ccid: string, additional: readonly string[], text: string): Document<{ body: string }> {
  return { kind: 'record', key: semantics.post(ccid, 'main', randomUUID()),
    author: ccid, schema: Schemas.markdownMessage, value: { body: text },
    // SDK Document.distributesはstring[]。宛先ごとの別投稿は作らない。
    createdAt: new Date(), distributes: targetTimelines(ccid, additional) };
}

export async function prepareSummary(session: Session, doc: Document<{ body: string }>): Promise<string> {
  // Api.commit() 2.0.5と同じ署名・reference形式を一度だけ作る。
  // SDK commitには生レスポンスのconsole出力があるため、準備と送信を分ける。
  const self = await session.api.getResource<SignedDocument>(semantics.user(session.ccid));
  const document = JSON.stringify(doc);
  const [signature, keyid] = await session.auth.signSub(document);
  return JSON.stringify({ document, proof: { type: 'concrnt-ecrecover-subkey', signature,
    key: semantics.subkey(session.ccid, keyid) }, references: { [semantics.user(session.ccid)]: self } });
}

export async function sendSummary(session: Session, payload: string): Promise<void> {
  const server = await session.api.getServer(session.api.defaultHost);
  const endpoint = renderUriTemplate(server, 'net.concrnt.core.commit', {});
  await session.api.fetchHost(session.api.defaultHost, endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload,
  });
}
