import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './contributions.ts';
import { canonicalJson, RECORD_RECEIPT_SCHEMA, RecordError, validateRecordBatch, type RecordBatch, type RecordReceipt } from './harness.ts';

/**
 * Contribution sharing on the server: anonymous installations, their record batches, what each one uploaded, and the
 * retention sweep. Everything lives in DATA_DIR as plain files:
 *
 *   installations/<installId>/installation.json      the installation: a hash of its token, days, status, today's count
 *   installations/<installId>/records/<batchId>.json one stored batch of harness-records/0.1
 *   installations/<installId>/contributions/<id>     empty marker: this installation uploaded contribution <id>
 *   tokens/<sha256 of the token>                     the installation a token belongs to
 *   accepted/contribution/<receiptId>.json           accepted into a signed release: kept by the sweep and by revocation
 *   accepted/records/<installId>.<batchId>.json      the same for a record batch
 *
 * Only a hash of each token is stored, and nothing records an address or a time finer than a day. Every function here
 * is synchronous, so two requests never interleave inside one of them.
 */

export interface Installation {
  schema: 'harness-installation/0.1'; installId: string; tokenHash: string; createdDay: string; lastSeenDay: string;
  status: 'active' | 'revoked'; revokedDay?: string;
  /** Records accepted on recordsDay, for the per-installation daily limit. */
  recordsDay?: string; recordsToday?: number;
}
interface StoredBatch { schema: 'harness-records-stored/0.1'; batchId: string; receivedDay: string; notice: number; digest: string;
  records: RecordBatch['records'] }
export interface SharingLimits { recordsPerDay: number; maxRecordsBody: number }
export const DEFAULT_SHARING_LIMITS: SharingLimits = { recordsPerDay: 2000, maxRecordsBody: 1024 * 1024 };

const TOKEN = /^hst_[A-Za-z0-9_-]{43}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;

export const today = (now: Date): string => now.toISOString().slice(0, 10);
export function addDays(day: string, days: number): string { return today(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)); }
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function dirs(dataDir: string) {
  return { installations: join(dataDir, 'installations'), tokens: join(dataDir, 'tokens'),
    acceptedContributions: join(dataDir, 'accepted', 'contribution'), acceptedRecords: join(dataDir, 'accepted', 'records') };
}
export function prepareSharingDirs(dataDir: string): void {
  for (const dir of Object.values(dirs(dataDir))) mkdirSync(dir, { recursive: true, mode: 0o700 });
}
function installationDir(dataDir: string, installId: string): string {
  if (!HEX32.test(installId)) throw new Error('invalid installation id');
  return join(dirs(dataDir).installations, installId);
}
/** Written beside the target and renamed over it, so a reader never sees half a file. */
function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}
function names(dir: string): string[] {
  try { return readdirSync(dir).filter(name => !name.startsWith('.') && !name.endsWith('.tmp')).sort(); } catch { return []; }
}
function saveInstallation(dataDir: string, installation: Installation): void {
  writeAtomic(join(installationDir(dataDir, installation.installId), 'installation.json'), `${JSON.stringify(installation, null, 2)}\n`);
}

/** A new anonymous installation. The token is returned once and never stored: only its hash is. */
export function createInstallation(dataDir: string, now = new Date()): { installId: string; token: string } {
  const installId = randomBytes(16).toString('hex'), token = `hst_${randomBytes(32).toString('base64url')}`;
  const dir = installationDir(dataDir, installId);
  mkdirSync(join(dir, 'records'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'contributions'), { mode: 0o700 });
  const day = today(now);
  saveInstallation(dataDir, { schema: 'harness-installation/0.1', installId, tokenHash: hashToken(token), createdDay: day,
    lastSeenDay: day, status: 'active' });
  // Last, so a token only ever names a complete installation.
  writeFileSync(join(dirs(dataDir).tokens, hashToken(token)), installId, { flag: 'wx', mode: 0o600 });
  return { installId, token };
}

/**
 * The installation an `Authorization: Bearer <token>` header names. 401 without a known token; 403 for a revoked one,
 * unless the caller asks about a revoked installation on purpose (status, and a repeated revocation).
 */
export function authenticate(dataDir: string, header: string | string[] | undefined, now = new Date(),
  options: { allowRevoked?: boolean } = {}): Installation {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer ([^\s]+)$/.exec(value ?? '');
  const unauthorized = () => new HttpError(401, 'a valid installation token is required (POST /v1/installations)',
    { 'www-authenticate': 'Bearer' });
  if (!match || !TOKEN.test(match[1]!)) throw unauthorized();
  const hash = hashToken(match[1]!);
  let installId: string;
  try { installId = readFileSync(join(dirs(dataDir).tokens, hash), 'utf8').trim(); } catch { throw unauthorized(); }
  if (!HEX32.test(installId)) throw unauthorized();
  const installation = readJson<Installation>(join(installationDir(dataDir, installId), 'installation.json'));
  if (!installation || !HEX64.test(installation.tokenHash) ||
    !timingSafeEqual(Buffer.from(installation.tokenHash, 'hex'), Buffer.from(hash, 'hex'))) throw unauthorized();
  if (installation.status === 'revoked' && !options.allowRevoked)
    throw new HttpError(403, 'this installation was revoked; nothing more is accepted from it');
  const day = today(now);
  if (installation.lastSeenDay !== day && installation.status === 'active') {
    installation.lastSeenDay = day;
    saveInstallation(dataDir, installation);
  }
  return installation;
}

/** The installation as it is on disk now: a request that waited for its body checks again before it stores anything. */
export function currentInstallation(dataDir: string, installId: string): Installation | undefined {
  return readJson<Installation>(join(installationDir(dataDir, installId), 'installation.json'));
}

/**
 * Stores one batch. The validator is the client's own (shared/sharing.ts): an unknown field, free text or a value outside
 * its enumerations is refused with 400. A batch id already stored with the same records answers 200 (a retry); with
 * different records, 409. Each installation may send recordsPerDay records a day.
 */
export function storeRecords(dataDir: string, installation: Installation, body: unknown, now = new Date(),
  limits: SharingLimits = DEFAULT_SHARING_LIMITS): { receipt: RecordReceipt; created: boolean } {
  let batch: RecordBatch;
  try { batch = validateRecordBatch(body); }
  catch (error) { if (error instanceof RecordError) throw new HttpError(400, error.message); throw error; }
  const digest = createHash('sha256').update(canonicalJson({ notice: batch.notice, records: batch.records })).digest('hex');
  const receipt: RecordReceipt = { schema: RECORD_RECEIPT_SCHEMA, batchId: batch.batchId, accepted: batch.records.length, status: 'stored' };
  const path = join(installationDir(dataDir, installation.installId), 'records', `${batch.batchId}.json`);
  const stored = readJson<StoredBatch>(path);
  if (stored) {
    if (stored.digest !== digest) throw new HttpError(409, 'this batch id was already used for other records');
    return { receipt, created: false };
  }
  const day = today(now);
  const sent = installation.recordsDay === day ? installation.recordsToday ?? 0 : 0;
  if (sent + batch.records.length > limits.recordsPerDay) {
    const retryAfter = Math.max(60, Math.ceil((Date.parse(`${addDays(day, 1)}T00:00:00Z`) - now.getTime()) / 1000));
    throw new HttpError(429, `an installation may send at most ${limits.recordsPerDay} records a day`, { 'retry-after': String(retryAfter) });
  }
  mkdirSync(join(installationDir(dataDir, installation.installId), 'records'), { recursive: true, mode: 0o700 });
  writeAtomic(path, `${JSON.stringify({ schema: 'harness-records-stored/0.1', batchId: batch.batchId, receivedDay: day,
    notice: batch.notice, digest, records: batch.records } satisfies StoredBatch)}\n`);
  saveInstallation(dataDir, { ...installation, recordsDay: day, recordsToday: sent + batch.records.length });
  return { receipt, created: true };
}

/** Remembers that an installation uploaded a contribution, so its status lists it and its revocation removes it. */
export function linkContribution(dataDir: string, installId: string, receiptId: string): void {
  if (!HEX32.test(receiptId)) throw new Error('invalid receipt id');
  const dir = join(installationDir(dataDir, installId), 'contributions');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, receiptId), '', { mode: 0o600 });
}

function acceptedRelease(dataDir: string, kind: 'contribution' | 'records', id: string): string | undefined {
  const base = kind === 'contribution' ? dirs(dataDir).acceptedContributions : dirs(dataDir).acceptedRecords;
  const marker = readJson<{ releaseId?: unknown }>(join(base, `${id}.json`));
  if (marker) return typeof marker.releaseId === 'string' ? marker.releaseId : 'unknown';
  return existsSync(join(base, `${id}.json`)) ? 'unknown' : undefined;
}
function contributionMeta(dataDir: string, receiptId: string): { installId?: string; candidateId?: string; receivedAt?: string } | undefined {
  return readJson(join(dataDir, 'contributions', receiptId, 'meta.json'));
}

export interface InstallationStatus {
  schema: 'harness-contribution-status/0.1'; retentionDays: number;
  installation: { installId: string; status: Installation['status']; createdDay: string; revokedDay?: string };
  records: Array<{ batchId: string; receivedDay: string; count: number; categories: Record<string, number>; state: 'stored' | 'accepted';
    releaseId?: string; expiresDay?: string }>;
  contributions: Array<{ receiptId: string; candidateId: string; receivedDay: string; state: 'stored' | 'accepted'; releaseId?: string;
    expiresDay?: string }>;
}
/** What the server holds for one installation, and when each item goes. */
export function installationStatus(dataDir: string, installation: Installation, retentionDays: number): InstallationStatus {
  const dir = installationDir(dataDir, installation.installId);
  const records = names(join(dir, 'records')).filter(name => name.endsWith('.json')).flatMap(name => {
    const batch = readJson<StoredBatch>(join(dir, 'records', name));
    if (!batch) return [];
    const categories: Record<string, number> = {};
    for (const record of batch.records) categories[record.category] = (categories[record.category] ?? 0) + 1;
    const releaseId = acceptedRelease(dataDir, 'records', `${installation.installId}.${batch.batchId}`);
    return [{ batchId: batch.batchId, receivedDay: batch.receivedDay, count: batch.records.length, categories,
      ...(releaseId ? { state: 'accepted' as const, releaseId } : { state: 'stored' as const, expiresDay: addDays(batch.receivedDay, retentionDays) }) }];
  });
  const contributions = names(join(dir, 'contributions')).flatMap(receiptId => {
    const meta = contributionMeta(dataDir, receiptId);
    if (!meta || meta.installId !== installation.installId) return [];
    const receivedDay = String(meta.receivedAt ?? '').slice(0, 10), releaseId = acceptedRelease(dataDir, 'contribution', receiptId);
    return [{ receiptId, candidateId: String(meta.candidateId ?? ''), receivedDay,
      ...(releaseId ? { state: 'accepted' as const, releaseId } : { state: 'stored' as const, expiresDay: addDays(receivedDay, retentionDays) }) }];
  });
  return { schema: 'harness-contribution-status/0.1', retentionDays,
    installation: { installId: installation.installId, status: installation.status, createdDay: installation.createdDay,
      ...(installation.revokedDay ? { revokedDay: installation.revokedDay } : {}) },
    records, contributions };
}

export interface Revocation {
  schema: 'harness-revocation/0.1'; installId: string; revoked: true; alreadyRevoked: boolean;
  removed: { recordBatches: number; records: number; contributions: string[] };
  /** Kept because a signed release already accepted them: revoking stops what comes next, it cannot unpublish a release. */
  retained: Array<{ kind: 'records' | 'contribution'; id: string; releaseId: string }>;
}
/**
 * Withdraws an installation: from now on its token uploads nothing, and every record batch and contribution it sent is
 * deleted, apart from what a signed release already accepted (listed as retained). Revoking again changes nothing and
 * says so. The installation itself stays, marked revoked, until the retention sweep removes it.
 */
export function revokeInstallation(dataDir: string, installation: Installation, now = new Date()): Revocation {
  const alreadyRevoked = installation.status === 'revoked';
  // First the status, so an upload whose body is still arriving finds the installation revoked before it stores anything.
  if (!alreadyRevoked) saveInstallation(dataDir, { ...installation, status: 'revoked', revokedDay: today(now) });
  const dir = installationDir(dataDir, installation.installId);
  const removed: Revocation['removed'] = { recordBatches: 0, records: 0, contributions: [] };
  const retained: Revocation['retained'] = [];
  for (const name of names(join(dir, 'records')).filter(name => name.endsWith('.json'))) {
    const batchId = name.slice(0, -'.json'.length), releaseId = acceptedRelease(dataDir, 'records', `${installation.installId}.${batchId}`);
    if (releaseId) { retained.push({ kind: 'records', id: batchId, releaseId }); continue; }
    const batch = readJson<StoredBatch>(join(dir, 'records', name));
    rmSync(join(dir, 'records', name), { force: true });
    removed.recordBatches++; removed.records += batch?.records.length ?? 0;
  }
  for (const receiptId of names(join(dir, 'contributions'))) {
    const releaseId = acceptedRelease(dataDir, 'contribution', receiptId);
    if (releaseId) { retained.push({ kind: 'contribution', id: receiptId, releaseId }); continue; }
    if (contributionMeta(dataDir, receiptId)?.installId === installation.installId) {
      rmSync(join(dataDir, 'contributions', receiptId), { recursive: true, force: true });
      removed.contributions.push(receiptId);
    }
    rmSync(join(dir, 'contributions', receiptId), { force: true });
  }
  return { schema: 'harness-revocation/0.1', installId: installation.installId, revoked: true, alreadyRevoked, removed, retained };
}

export interface SweepResult { recordBatches: number; contributions: number; installations: number }
/**
 * Deletes what the retention period has passed: record batches and contributions received retentionDays or more days ago,
 * and installations that are revoked or unused for as long and hold nothing any more. Anything accepted into a signed
 * release is never deleted, and releases/ is never touched. An item received on day D goes on day D + retentionDays.
 */
export function sweepRetention(dataDir: string, retentionDays: number, now = new Date()): SweepResult {
  const cutoff = addDays(today(now), -retentionDays);
  const result: SweepResult = { recordBatches: 0, contributions: 0, installations: 0 };
  const expired = (day: string) => /^\d{4}-\d\d-\d\d$/.test(day) && day <= cutoff;
  for (const receiptId of names(join(dataDir, 'contributions'))) {
    const meta = contributionMeta(dataDir, receiptId);
    if (!meta || !expired(String(meta.receivedAt ?? '').slice(0, 10)) || acceptedRelease(dataDir, 'contribution', receiptId)) continue;
    rmSync(join(dataDir, 'contributions', receiptId), { recursive: true, force: true });
    if (meta.installId && HEX32.test(meta.installId)) rmSync(join(installationDir(dataDir, meta.installId), 'contributions', receiptId), { force: true });
    result.contributions++;
  }
  const { installations, tokens } = dirs(dataDir);
  for (const installId of names(installations).filter(name => HEX32.test(name))) {
    const dir = join(installations, installId);
    for (const name of names(join(dir, 'records')).filter(name => name.endsWith('.json'))) {
      const batch = readJson<StoredBatch>(join(dir, 'records', name));
      if (!batch || !expired(batch.receivedDay) || acceptedRelease(dataDir, 'records', `${installId}.${batch.batchId}`)) continue;
      rmSync(join(dir, 'records', name), { force: true });
      result.recordBatches++;
    }
    // A marker whose contribution is gone (swept, or never stored) holds nothing.
    for (const receiptId of names(join(dir, 'contributions')))
      if (!existsSync(join(dataDir, 'contributions', receiptId))) rmSync(join(dir, 'contributions', receiptId), { force: true });
    const installation = readJson<Installation>(join(dir, 'installation.json'));
    const idle = installation ? expired(installation.status === 'revoked' ? installation.revokedDay ?? installation.lastSeenDay
      : installation.lastSeenDay) : isStale(dir, now, retentionDays);
    if (!idle || names(join(dir, 'records')).length || names(join(dir, 'contributions')).length) continue;
    if (installation?.tokenHash && HEX64.test(installation.tokenHash)) rmSync(join(tokens, installation.tokenHash), { force: true });
    rmSync(dir, { recursive: true, force: true });
    result.installations++;
  }
  return result;
}
/** A directory left without installation.json (a crash while it was created) goes once it is as old as the retention period. */
function isStale(dir: string, now: Date, retentionDays: number): boolean {
  try { return now.getTime() - lstatSync(dir).mtimeMs >= retentionDays * DAY_MS; } catch { return false; }
}

/**
 * Marks items as accepted into a signed release, which keeps them from the retention sweep and from revocation.
 * server/scripts/accept.mjs calls this once the release is published.
 */
export function markAccepted(dataDir: string, releaseId: string, items: Array<{ kind: 'contribution' | 'records'; id: string }>,
  now = new Date()): string[] {
  if (!/^[a-zA-Z0-9._-]+$/.test(releaseId)) throw new Error('invalid release id');
  prepareSharingDirs(dataDir);
  return items.map(item => {
    if (item.kind === 'contribution') {
      if (!HEX32.test(item.id) || !existsSync(join(dataDir, 'contributions', item.id))) throw new Error(`no stored contribution ${item.id}`);
    } else {
      const [installId, batchId] = item.id.split('.');
      if (!installId || !batchId || !HEX32.test(installId) || !HEX32.test(batchId) ||
        !existsSync(join(installationDir(dataDir, installId), 'records', `${batchId}.json`))) throw new Error(`no stored record batch ${item.id}`);
    }
    const path = join(item.kind === 'contribution' ? dirs(dataDir).acceptedContributions : dirs(dataDir).acceptedRecords, `${item.id}.json`);
    writeFileSync(path, `${JSON.stringify({ schema: 'harness-accepted/0.1', kind: item.kind, id: item.id, releaseId, acceptedDay: today(now) })}\n`,
      { mode: 0o644 });
    return path;
  });
}
