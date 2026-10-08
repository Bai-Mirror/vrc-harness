import { createReadStream, lstatSync, readFileSync, statfsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { acceptContribution, DEFAULT_LIMITS, HttpError, prepareDataDir, type ContributionLimits } from './contributions.ts';
import { dataPolicy, DEFAULT_RETENTION_DAYS, SHARING_PATHS } from './harness.ts';
import type { Logger } from './log.ts';
import { ReleaseCatalog, validChannel, type ReleaseKind } from './releases.ts';
import { authenticate, createInstallation, currentInstallation, DEFAULT_SHARING_LIMITS, installationStatus, linkContribution,
  prepareSharingDirs, revokeInstallation, storeRecords, sweepRetention, type Installation, type SharingLimits } from './sharing.ts';

export interface ServerOptions {
  dataDir: string;
  version: string;
  trustedKeys: Record<string, string>;
  /** Origin that archive URLs in knowledge listings point at, e.g. https://harness.nymiro.moe */
  publicBaseUrl: string;
  log: Logger;
  limits?: Partial<ContributionLimits>;
  /** Uploads received at once; more are turned away with 503 so request bodies cannot pile up in memory. */
  maxConcurrentUploads?: number;
  /** Free space DATA_DIR keeps; an upload that would go below it gets 507. 0 turns the check off. */
  minFreeBytes?: number;
  /** Also serve /v1/releases/files/ and /v1/knowledge/files/ from DATA_DIR. In production nginx serves them. */
  serveReleaseFiles?: boolean;
  /** Days an upload is kept before the sweep deletes it (RETENTION_DAYS); what a signed release accepted is kept. */
  retentionDays?: number;
  /** Days the operator keeps backups of DATA_DIR (BACKUP_DAYS): only stated in the data policy, the server keeps none. */
  backupDays?: number;
  sharing?: Partial<SharingLimits>;
  /** How often the retention sweep runs (also once at start); 0 turns it off. */
  sweepIntervalMs?: number;
  /** Test hook: the clock. */
  now?: () => Date;
}

const DOWNLOAD = /^\/v1\/(releases|knowledge)\/files\/([a-zA-Z0-9_+-][a-zA-Z0-9._+-]*)$/;
/** Installation and revocation requests carry no more than a small JSON object. */
const SMALL_BODY = 4096;

export function createHarnessServer(options: ServerOptions): Server {
  prepareDataDir(options.dataDir);
  prepareSharingDirs(options.dataDir);
  const limits: ContributionLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const sharingLimits: SharingLimits = { ...DEFAULT_SHARING_LIMITS, ...options.sharing };
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS, backupDays = options.backupDays ?? 0;
  const catalog = new ReleaseCatalog(options.dataDir, options.trustedKeys, options.publicBaseUrl, options.log);
  const maxUploads = options.maxConcurrentUploads ?? 2, minFree = options.minFreeBytes ?? 0;
  const now = options.now ?? (() => new Date());
  let uploads = 0;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://harness.invalid');
    switch (url.pathname) {
      case '/v1/health':
        allow(request, 'GET', 'HEAD');
        return send(response, 200, { ok: true, service: 'harness-server', version: options.version });
      case '/v1/capabilities':
        allow(request, 'GET', 'HEAD');
        return send(response, 200, {
          contributions: { maxBytes: limits.maxBytes, maxFiles: limits.maxFiles },
          releases: { channels: catalog.channels('app') },
          knowledge: { channels: catalog.channels('knowledge') },
          dataPolicy: dataPolicy({ retentionDays, backupDays, recordsPerDay: sharingLimits.recordsPerDay }),
        });
      case '/v1/releases':
        allow(request, 'GET', 'HEAD');
        return send(response, 200, { releases: catalog.app(channel(url)) });
      case '/v1/knowledge/releases':
        allow(request, 'GET', 'HEAD');
        return send(response, 200, { releases: catalog.knowledge(channel(url)) });
      case SHARING_PATHS.installations:
        allow(request, 'POST');
        return installation(request, response);
      case SHARING_PATHS.records:
        allow(request, 'POST');
        return records(request, response);
      case SHARING_PATHS.status:
        allow(request, 'GET', 'HEAD');
        return send(response, 200, installationStatus(options.dataDir, authorized(request, true), retentionDays));
      case SHARING_PATHS.revoke:
        allow(request, 'POST');
        return revoke(request, response);
      case SHARING_PATHS.contributions:
        allow(request, 'POST');
        return contribution(request, response);
    }
    const download = DOWNLOAD.exec(url.pathname);
    if (download && options.serveReleaseFiles) {
      allow(request, 'GET', 'HEAD');
      return serveFile(request, response, download[1] === 'releases' ? 'app' : 'knowledge', download[2]!);
    }
    throw new HttpError(404, 'not found');
  }

  /** The caller's installation. A refused request's body is read and dropped, so the client gets the answer, not a reset. */
  function authorized(request: IncomingMessage, allowRevoked = false): Installation {
    try { return authenticate(options.dataDir, request.headers.authorization, now(), { allowRevoked }); }
    catch (error) { request.resume(); throw error; }
  }
  function checkStorage(bytes: number): void {
    if (!minFree) return;
    const { bavail, bsize } = statfsSync(options.dataDir);
    if (bavail * bsize - bytes < minFree) throw new HttpError(507, 'the server is out of storage for contributions');
  }
  /** After a body arrived: the installation may have been revoked while it did. */
  function stillActive(installId: string): Installation {
    const current = currentInstallation(options.dataDir, installId);
    if (current?.status !== 'active') throw new HttpError(403, 'this installation was revoked; nothing more is accepted from it');
    return current;
  }
  async function json(request: IncomingMessage, limit: number, optional = false): Promise<unknown> {
    const body = await readBody(request, limit);
    if (optional && !body.length) return {};
    try { return JSON.parse(body.toString('utf8')) as unknown; } catch { throw new HttpError(400, 'request body is not JSON'); }
  }

  async function installation(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkStorage(SMALL_BODY);
    const body = await json(request, SMALL_BODY, true);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'request body must be a JSON object');
    const created = createInstallation(options.dataDir, now());
    options.log.info('installation registered');
    send(response, 201, { schema: 'harness-installation/0.1', ...created, retentionDays });
  }

  async function records(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const caller = authorized(request);
    const declared = Number(request.headers['content-length']);
    if (declared > sharingLimits.maxRecordsBody) {
      request.resume();
      throw new HttpError(413, `request body is larger than ${sharingLimits.maxRecordsBody} bytes`);
    }
    checkStorage(Number.isFinite(declared) ? declared : sharingLimits.maxRecordsBody);
    const body = await json(request, sharingLimits.maxRecordsBody);
    const { receipt, created } = storeRecords(options.dataDir, stillActive(caller.installId), body, now(), sharingLimits);
    options.log.info(created ? 'records stored' : 'records were already stored', { count: receipt.accepted });
    send(response, created ? 201 : 200, receipt);
  }

  async function revoke(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const caller = authorized(request, true);
    await json(request, SMALL_BODY, true);
    const result = revokeInstallation(options.dataDir, currentInstallation(options.dataDir, caller.installId) ?? caller, now());
    options.log.info(result.alreadyRevoked ? 'installation was already revoked' : 'installation revoked', {
      recordBatches: result.removed.recordBatches, contributions: result.removed.contributions.length, retained: result.retained.length });
    send(response, 200, result);
  }

  async function contribution(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const caller = authorized(request);
    if (uploads >= maxUploads) {
      request.resume();
      throw new HttpError(503, 'too many uploads in progress; try again shortly', { 'retry-after': '30' });
    }
    const declared = Number(request.headers['content-length']);
    if (declared > limits.maxBodyBytes) throw new HttpError(413, `request body is larger than ${limits.maxBodyBytes} bytes`);
    checkStorage(Number.isFinite(declared) ? declared : limits.maxBodyBytes);
    uploads++;
    try {
      // A full upload is ~85 MiB of JSON: drop each copy (bytes, text) as soon as the next one exists.
      let body: Buffer | undefined = await readBody(request, limits.maxBodyBytes);
      let text: string | undefined = body.toString('utf8');
      body = undefined;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new HttpError(400, 'request body is not JSON'); }
      text = undefined;
      const installId = stillActive(caller.installId).installId;
      const { receipt, created } = acceptContribution(options.dataDir, parsed, limits, now(), installId);
      if (created || storedOwner(receipt.receiptId) === installId) linkContribution(options.dataDir, installId, receipt.receiptId);
      options.log.info(created ? 'contribution stored' : 'contribution was already stored', { receiptId: receipt.receiptId });
      send(response, created ? 201 : 200, receipt);
    } finally {
      uploads--;
    }
  }
  function storedOwner(receiptId: string): string | undefined {
    try { return (JSON.parse(readFileSync(join(options.dataDir, 'contributions', receiptId, 'meta.json'), 'utf8')) as { installId?: string }).installId; }
    catch { return undefined; }
  }

  function serveFile(request: IncomingMessage, response: ServerResponse, kind: ReleaseKind, name: string): void {
    const path = join(options.dataDir, 'releases', kind, 'files', name);
    let info;
    try { info = lstatSync(path); } catch { throw new HttpError(404, 'not found'); }
    if (!info.isFile()) throw new HttpError(404, 'not found');
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size, 'x-content-type-options': 'nosniff' });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(path).on('error', () => response.destroy()).pipe(response);
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof HttpError) { send(response, error.status, { error: error.message }, error.headers); return; }
      // The path only: a query string could carry something personal. Token-like text never reaches the log.
      options.log.error('request failed', { path: new URL(request.url ?? '/', 'http://harness.invalid').pathname,
        error: scrub(String((error as Error)?.message ?? error)) });
      send(response, 500, { error: 'internal server error' });
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;

  const sweep = (): void => {
    try {
      const swept = sweepRetention(options.dataDir, retentionDays, now());
      if (swept.recordBatches || swept.contributions || swept.installations) options.log.info('retention sweep', { ...swept, retentionDays });
    } catch (error) { options.log.error('retention sweep failed', { error: scrub(String((error as Error)?.message ?? error)) }); }
  };
  const interval = options.sweepIntervalMs ?? 6 * 3600_000;
  if (interval > 0) {
    sweep();
    const timer = setInterval(sweep, interval);
    timer.unref();
    server.on('close', () => clearInterval(timer));
  }
  return server;
}

/** Tokens and token hashes out of anything logged. */
export function scrub(text: string): string {
  return text.replace(/hst_[A-Za-z0-9_-]+/g, 'hst_…').replace(/[0-9a-f]{64}/g, '<sha256>');
}

function allow(request: IncomingMessage, ...methods: string[]): void {
  if (!methods.includes(request.method ?? '')) {
    request.resume();
    throw new HttpError(405, 'method not allowed', { allow: methods.join(', ') });
  }
}

function channel(url: URL): string {
  const value = url.searchParams.get('channel');
  if (value === null) throw new HttpError(400, 'channel is required');
  if (!validChannel(value)) throw new HttpError(400, 'invalid channel');
  return value;
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers,
  });
  response.end(text);
}

/**
 * Past the limit the rest of the body is read and dropped rather than the connection cut, so a client that is still
 * sending gets the 413 instead of a reset. nginx caps request bodies before they get here.
 */
function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    request.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, `request body is larger than ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!over) resolve(Buffer.concat(chunks, size)); });
    request.on('error', reject);
    request.on('close', () => { if (!over && !request.complete) reject(new HttpError(400, 'request body was cut off')); });
  });
}
