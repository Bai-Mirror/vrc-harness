import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * What the BOOTH index sync and file fetching share: polite requests, where a downloadable points, and what its file
 * looks like from outside (the remote version clue). A downloadable resolves to a signed file URL; that URL is used at
 * once and never stored, logged or put in an error message, because it carries a signature.
 */

/** BOOTH is read one request at a time, at most one per interval: a burst reads as scraping and puts the account at risk. */
export const BOOTH_REQUEST_INTERVAL_MS = 1000;
/** A size probe that has not answered in this long counts as timed out. */
export const PROBE_TIMEOUT_MS = 30_000;

/** Throttling, a server error or a lost session: stop at once, keep what was already written, mark nothing unavailable. */
export class BoothSyncStopped extends Error {}

export function boothHost(url: string | URL): boolean {
  try { const host = new URL(url).hostname; return host === 'booth.pm' || host.endsWith('.booth.pm'); } catch { return false; }
}

export interface RequestOptions { fetcher?: typeof fetch; intervalMs?: number; sleep?: (ms: number) => Promise<unknown> }
/** `file`: a request for the signed file URL. It never carries the session, and its status alone never stops the work. */
export type BoothRequest = (url: string | URL, init?: RequestInit, file?: boolean) => Promise<Response>;

const STOPPED = {
  sync: { rest: '已停止同步；已写入的索引保留，其余未改动。', later: '请过一段时间再同步。' },
  fetch: { rest: '已停止获取；已取回的文件保留，计划可以稍后继续。', later: '请过一段时间再获取。' },
};
/** Requests to BOOTH hosts go out at most one per interval and carry the session; the file host gets neither. */
export function politeFetch(session: string, options: RequestOptions, counter: { requests: number },
  activity: 'sync' | 'fetch' = 'sync'): BoothRequest {
  const fetcher = options.fetcher ?? fetch, interval = options.intervalMs ?? BOOTH_REQUEST_INTERVAL_MS, sleep = options.sleep ?? delay;
  const words = STOPPED[activity];
  let next = 0;
  return async (url, init = {}, file = false) => {
    const booth = boothHost(url);
    if (booth) { const wait = next - Date.now(); if (wait > 0) await sleep(wait); next = Date.now() + interval; }
    counter.requests++;
    const response = await fetcher(url, { ...init, headers: { 'user-agent': 'AvatarHarness/0.1 BOOTH index sync',
      ...(booth && !file ? { cookie: `_plaza_session_nktz7u=${session}` } : {}), ...(init.headers as Record<string, string> | undefined) } });
    if (response.status === 429) throw new BoothSyncStopped(`BOOTH 返回 HTTP 429（请求过多），${words.rest}${words.later}`);
    if (booth && !file && response.status >= 500) throw new BoothSyncStopped(`BOOTH 返回 HTTP ${response.status}（服务端错误），${words.rest}`);
    if (booth && !file && (response.status === 401 || response.status === 403)) throw new BoothSyncStopped('BOOTH 会话已失效，请重新连接');
    return response;
  };
}

/** Drop a response body unread: a file host that ignores a Range header would otherwise send the whole file. */
function discard(response: Response): void { response.body?.cancel().catch(() => { /* already closed */ }); }

export type Resolved = { kind: 'file'; location: URL; name: string } | { kind: 'unavailable'; outcome: string };
/**
 * Where a downloadable points now. 404 and 410 mean BOOTH no longer offers it; anything else that is not a redirect
 * means the session or the page changed, and `stop` says what to throw. The location is for immediate use only.
 */
export async function resolveDownloadable(request: BoothRequest, downloadableId: string, stop: (status: number) => Error): Promise<Resolved> {
  const response = await request(`https://booth.pm/downloadables/${downloadableId}`, { redirect: 'manual' });
  discard(response);
  if (response.status === 404 || response.status === 410) return { kind: 'unavailable', outcome: `resolve:http-${response.status}` };
  if (response.status < 300 || response.status >= 400) throw stop(response.status);
  const location = response.headers.get('location');
  if (!location) return { kind: 'unavailable', outcome: 'resolve:no-location' };
  const url = new URL(location, 'https://booth.pm');
  return { kind: 'file', location: url, name: fileName(url, downloadableId) };
}
/** The file name is the last path segment of the signed URL; its query (the signature) is never looked at. */
function fileName(url: URL, downloadableId: string): string {
  try { return decodeURIComponent(basename(url.pathname)) || `${downloadableId}.bin`; } catch { return `${downloadableId}.bin`; }
}

/** What BOOTH shows of a file without sending it: the name it serves it under, and size, ETag and Last-Modified if known. */
export interface RemoteClue { name: string; size?: number; etag?: string; lastModified?: string }
/** The stored form: fixed key order, absent parts left out, so equal clues are equal text. */
export function clueText(clue: RemoteClue): string {
  return JSON.stringify({ name: clue.name, ...(clue.size === undefined ? {} : { size: clue.size }),
    ...(clue.etag ? { etag: clue.etag } : {}), ...(clue.lastModified ? { lastModified: clue.lastModified } : {}) });
}
/** A stored clue, or undefined for none (files indexed before clues were kept store an empty string). */
export function parseClue(text: string | null | undefined): RemoteClue | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || typeof value.name !== 'string') return undefined;
    return { name: value.name, ...(Number.isSafeInteger(value.size) ? { size: value.size as number } : {}),
      ...(typeof value.etag === 'string' && value.etag ? { etag: value.etag } : {}),
      ...(typeof value.lastModified === 'string' && value.lastModified ? { lastModified: value.lastModified } : {}) };
  } catch { return undefined; }
}
/**
 * Whether BOOTH still serves the version a clue describes, as far as it lets anyone tell: the same name and the same
 * known size, and the same ETag and Last-Modified wherever both sides have one. Without a size nothing is confirmed.
 */
export function sameVersion(known: RemoteClue, current: RemoteClue): boolean {
  if (known.name !== current.name || known.size === undefined || current.size === undefined || known.size !== current.size) return false;
  if (known.etag && current.etag && known.etag !== current.etag) return false;
  if (known.lastModified && current.lastModified && known.lastModified !== current.lastModified) return false;
  return true;
}
/** The version headers of a file response, for its clue. */
export function versionHeaders(response: Response): Pick<RemoteClue, 'etag' | 'lastModified'> {
  const etag = response.headers.get('etag')?.trim(), lastModified = response.headers.get('last-modified')?.trim();
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
}

export interface Probe extends Pick<RemoteClue, 'size' | 'etag' | 'lastModified'> {
  /** What each step saw, e.g. `head:ok`, `head:http-403 range:ok`, `head:timeout range:network`. */
  outcome: string;
}
const html = (response: Response) => /^text\/html\b/i.test(response.headers.get('content-type') ?? '');
const digits = (value: string | null) => value && /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
/**
 * The size of a signed file URL without downloading it. HEAD first; a signed URL is often valid for GET only, so when
 * HEAD fails or gives no length, a GET for the first byte (`Range: bytes=0-0`) and its Content-Range total. Neither
 * body is read: a server that ignores the Range header and answers 200 gives its Content-Length and is cut off there.
 * An error page's length is never taken for the file's size. The outcome codes never contain the URL.
 */
export async function probeFile(request: BoothRequest, location: URL, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe> {
  const steps: string[] = [];
  const attempt = async (step: 'head' | 'range'): Promise<Probe | undefined> => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await request(location, step === 'head' ? { method: 'HEAD', redirect: 'follow', signal }
        : { method: 'GET', redirect: 'follow', signal, headers: { range: 'bytes=0-0' } }, true);
    } catch (error) {
      if (error instanceof BoothSyncStopped) throw error;
      steps.push(`${step}:${(error as Error).name === 'TimeoutError' ? 'timeout' : 'network'}`);
      return undefined;
    }
    discard(response); controller.abort();
    const found = (size: number): Probe => ({ size, ...versionHeaders(response), outcome: [...steps, `${step}:ok`].join(' ') });
    const answered = step === 'head' ? response.ok : [200, 206, 416].includes(response.status);
    if (!answered) { steps.push(`${step}:http-${response.status}`); return undefined; }
    if (html(response)) { steps.push(`${step}:html`); return undefined; }
    if (step === 'head') {
      const size = digits(response.headers.get('content-length'));
      if (size === undefined) { steps.push('head:no-length'); return undefined; }
      return found(size);
    }
    if (response.status === 206 || response.status === 416) {
      // 206: `bytes 0-0/<total>`; 416 (an empty file has no byte 0): `bytes */<total>`.
      const total = /^bytes\s+(?:\d+-\d+|\*)\/(\d+)\s*$/i.exec(response.headers.get('content-range') ?? '')?.[1];
      if (total !== undefined && Number.isSafeInteger(Number(total))) return found(Number(total));
      steps.push(response.status === 206 ? 'range:no-total' : 'range:http-416'); return undefined;
    }
    const size = digits(response.headers.get('content-length'));
    if (size === undefined) { steps.push('range:no-length'); return undefined; }
    return found(size);
  };
  return await attempt('head') ?? await attempt('range') ?? { outcome: steps.join(' ') };
}
