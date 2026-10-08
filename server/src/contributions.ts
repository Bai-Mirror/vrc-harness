import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packTreeHash, type ContributionReceipt } from './harness.ts';
import { validateCandidateReport } from '../../harness/src/shared/candidate-report.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export interface ContributionLimits { maxFiles: number; maxBytes: number; maxBodyBytes: number }
/** 64 MiB decoded is the client's own upload limit; 90 MiB of JSON covers base64's 4/3 growth plus the envelope. */
export const DEFAULT_LIMITS: ContributionLimits = { maxFiles: 2000, maxBytes: 64 * 1024 * 1024, maxBodyBytes: 90 * 1024 * 1024 };

const HEX64 = /^[0-9a-f]{64}$/;
const CONTRIBUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Json = Record<string, unknown>;
interface UploadFile { mode: number; bytes: string; size: number }
export interface Accepted { receipt: ContributionReceipt; created: boolean }

export function contributionDirs(dataDir: string): { contributions: string; quarantine: string } {
  return { contributions: join(dataDir, 'contributions'), quarantine: join(dataDir, 'quarantine') };
}

/** Creates the data layout and empties the quarantine: anything left there is an upload that a crash interrupted. */
export function prepareDataDir(dataDir: string): void {
  const { contributions, quarantine } = contributionDirs(dataDir);
  mkdirSync(contributions, { recursive: true, mode: 0o700 });
  mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(quarantine)) rmSync(join(quarantine, entry), { recursive: true, force: true });
  for (const kind of ['app', 'knowledge']) mkdirSync(join(dataDir, 'releases', kind, 'files'), { recursive: true });
}

/** Derived from the payload hash, so a repeated upload lands on the same receipt without any index to keep. */
export function receiptIdFor(payloadHash: string): string {
  return createHash('sha256').update('harness-contribution-receipt/0.1\n').update(payloadHash).digest('hex').slice(0, 32);
}

/**
 * Checks one upload completely, then stores it once per payloadHash:
 * 1. shape, limits and paths, before anything is decoded;
 * 2. payloadHash = sha256(contribution.json bytes + candidate.contentHash), as authorizeContribution computes it;
 * 3. the files are written to a private quarantine directory, and packTreeHash(pack) must equal candidate.contentHash;
 * 4. the checked tree moves to contributions/<receiptId>/ in one rename.
 * Nothing is executed or unpacked, and on any failure the quarantine directory is removed. meta.json names the
 * installation that uploaded it, so that installation's status lists it and its revocation deletes it.
 */
export function acceptContribution(dataDir: string, body: unknown, limits: ContributionLimits = DEFAULT_LIMITS, now = new Date(),
  installId?: string): Accepted {
  const upload = object(body, 'request body');
  if (Object.keys(upload).some(key => !['schema', 'payloadHash', 'username', 'files', 'directories'].includes(key)))
    throw new HttpError(400, 'upload contains fields outside the authorized projection');
  if (upload.schema !== 'harness-contribution-upload/0.1') throw new HttpError(400, 'unsupported upload schema');
  const payloadHash = upload.payloadHash;
  if (typeof payloadHash !== 'string' || !HEX64.test(payloadHash)) throw new HttpError(400, 'payloadHash must be 64 lowercase hex digits');
  const username = contributorName(upload.username);
  const files = uploadFiles(upload.files, limits);
  const directories = impliedDirectories(files.keys());
  const declared = declaredDirectories(upload.directories, files, directories, limits);
  for (const directory of directories) if (files.has(directory)) throw new HttpError(400, `path is both a file and a directory: ${directory}`);

  const manifestBytes = Buffer.from(files.get('contribution.json')!.bytes, 'base64');
  const { candidateId, contentHash } = contributionManifest(manifestBytes);
  if ([...files.keys()].sort().join(',') !== 'contribution.json,pack/candidate-report.json' ||
    [...directories].sort().join(',') !== 'pack') throw new HttpError(400, 'only the structured candidate report may be contributed');
  const report = files.get('pack/candidate-report.json')!;
  if (report.size > 64 * 1024) throw new HttpError(413, 'structured candidate report is too large');
  try { validateCandidateReport(JSON.parse(Buffer.from(report.bytes, 'base64').toString('utf8'))); }
  catch { throw new HttpError(400, 'candidate report does not match its authorized content projection'); }
  if (createHash('sha256').update(manifestBytes).update(contentHash).digest('hex') !== payloadHash)
    throw new HttpError(400, 'payloadHash does not match contribution.json');

  const receiptId = receiptIdFor(payloadHash);
  const receipt: ContributionReceipt = { schema: 'harness-contribution-receipt/0.1', candidateId, payloadHash, status: 'accepted', receiptId };
  const { contributions, quarantine } = contributionDirs(dataDir);
  const work = mkdtempSync(join(quarantine, 'upload-'));
  try {
    const bundle = join(work, 'bundle'), at = (path: string): string => join(bundle, ...path.split('/'));
    mkdirSync(bundle, { mode: 0o700 });
    // Sorted, a directory comes right after its parent: each mkdir finds its parent in place.
    for (const directory of [...directories].sort()) mkdirSync(at(directory), { mode: 0o700 });
    let bytes = 0;
    for (const [path, file] of files) {
      writeFileSync(at(path), Buffer.from(file.bytes, 'base64'), { flag: 'wx', mode: 0o600 });
      chmodSync(at(path), file.mode);
      bytes += file.size;
      file.bytes = ''; // the text is on disk now; let it go before hashing
    }
    const directoryModes = matchContentHash(at, directories, declared, files, contentHash);
    const meta = {
      schema: 'harness-contribution-meta/0.1', receiptId, payloadHash, candidateId, contentHash,
      receivedAt: now.toISOString(), ...(installId ? { installId } : {}), username, bytes, fileCount: files.size,
      // The stored copy keeps only "executable or not"; these are the exact modes the content hash was verified with.
      verifiedModes: {
        files: Object.fromEntries([...files].map(([path, file]) => [path, octalMode(file.mode)])),
        directories: Object.fromEntries([...directoryModes].map(([path, mode]) => [path, octalMode(mode)])),
      },
    };
    writeFileSync(join(work, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    for (const [path, file] of files) chmodSync(at(path), file.mode & 0o111 ? 0o755 : 0o644);
    for (const directory of directories) chmodSync(at(directory), 0o755);
    chmodSync(bundle, 0o755);
    const target = join(contributions, receiptId);
    if (existsSync(target)) return { receipt, created: false };
    try {
      renameSync(work, target);
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) return { receipt, created: false };
      throw error;
    }
    return { receipt, created: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function object(value: unknown, what: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${what} must be an object`);
  return value as Json;
}

function contributorName(value: unknown): string {
  if (value === undefined || value === '') return '';
  throw new HttpError(400, 'structured observations do not include contributor names');
}

/** A relative `/`-separated path that stays inside the bundle and can exist on the server's filesystem. */
function bundlePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || !value.isWellFormed()) throw new HttpError(400, 'invalid path');
  const parts = value.split('/');
  if (value.startsWith('/') || /[\\\p{Cc}]/u.test(value) || parts.some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255))
    throw new HttpError(400, `path is not allowed: ${JSON.stringify(value)}`);
  return value;
}

/** Permission bits only (no setuid, setgid, sticky or type bits), readable by the owner so the tree can be hashed. */
function permissionBits(value: unknown, kind: 'file' | 'directory'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0o777)
    throw new HttpError(400, `${kind} mode must be permission bits between 0 and 0o777`);
  if (kind === 'file' && !(value & 0o400)) throw new HttpError(400, 'file mode must let the owner read the file');
  if (kind === 'directory' && (value & 0o700) !== 0o700) throw new HttpError(400, 'directory mode must give the owner full access');
  return value;
}

/** Decoded size of canonical padded base64, or -1. Checked before anything is decoded. */
function base64Size(text: string): number {
  if (text.length % 4) return -1;
  let padding = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47) { if (padding) return -1; }
    else if (c === 61 && i >= text.length - 2) padding++;
    else return -1;
  }
  return (text.length / 4) * 3 - padding;
}

function uploadFiles(value: unknown, limits: ContributionLimits): Map<string, UploadFile> {
  if (!Array.isArray(value)) throw new HttpError(400, 'files must be an array');
  if (value.length > limits.maxFiles) throw new HttpError(413, `an upload may hold at most ${limits.maxFiles} files`);
  const files = new Map<string, UploadFile>();
  let total = 0;
  for (const item of value) {
    const entry = object(item, 'file entry'), path = bundlePath(entry.path);
    if (path !== 'contribution.json' && !path.startsWith('pack/'))
      throw new HttpError(400, `path is outside the contribution bundle layout: ${JSON.stringify(path)}`);
    if (files.has(path)) throw new HttpError(400, `path appears twice: ${path}`);
    const mode = permissionBits(entry.mode, 'file');
    const size = typeof entry.bytes === 'string' ? base64Size(entry.bytes) : -1;
    if (size < 0) throw new HttpError(400, `bytes of ${path} are not base64`);
    total += size;
    if (total > limits.maxBytes) throw new HttpError(413, `an upload may hold at most ${limits.maxBytes} decoded bytes`);
    files.set(path, { mode, bytes: entry.bytes as string, size });
    delete entry.bytes; // one reference to the base64 text, so it can be released once written
  }
  for (const required of ['contribution.json', 'pack/candidate-report.json']) if (!files.has(required)) throw new HttpError(400, `upload has no ${required}`);
  return files;
}

/** Every directory the paths imply, including `pack` itself. */
function impliedDirectories(paths: Iterable<string>, into = new Set<string>(), includeSelf = false): Set<string> {
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length + (includeSelf ? 1 : 0); i++) into.add(parts.slice(0, i).join('/'));
  }
  return into;
}

/**
 * Optional `directories: [{path, mode}]`, which the client does not send yet. Without it directory modes are
 * inferred (see matchContentHash) and an empty directory cannot be reproduced. When present it must list every
 * directory under pack/, and it may add empty ones.
 */
function declaredDirectories(value: unknown, files: Map<string, UploadFile>, directories: Set<string>,
  limits: ContributionLimits): Map<string, number> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, 'directories must be an array');
  if (value.length > limits.maxFiles) throw new HttpError(413, `an upload may declare at most ${limits.maxFiles} directories`);
  const modes = new Map<string, number>();
  for (const item of value) {
    const entry = object(item, 'directory entry'), path = bundlePath(entry.path);
    if (!path.startsWith('pack/')) throw new HttpError(400, `directory is outside pack/: ${JSON.stringify(path)}`);
    if (files.has(path)) throw new HttpError(400, `path is both a file and a directory: ${path}`);
    if (modes.has(path)) throw new HttpError(400, `directory appears twice: ${path}`);
    modes.set(path, permissionBits(entry.mode, 'directory'));
  }
  impliedDirectories(modes.keys(), directories, true);
  for (const directory of directories) if (directory !== 'pack' && !modes.has(directory)) throw new HttpError(400, `directories does not list ${directory}`);
  return modes;
}

function contributionManifest(bytes: Buffer): { candidateId: string; contentHash: string } {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new HttpError(400, 'contribution.json is not JSON'); }
  const manifest = object(parsed, 'contribution.json');
  const only = (value: Json, keys: string): void => {
    if (Object.keys(value).sort().join(',') !== keys.split(',').sort().join(','))
      throw new HttpError(400, 'contribution.json contains unauthorized fields');
  };
  only(manifest, 'schema,purpose,category,projection,candidate,authorization');
  if (manifest.schema !== 'harness-contribution/0.1') throw new HttpError(400, 'unsupported contribution.json schema');
  if (manifest.purpose !== 'product-improvement' || manifest.category !== 'candidate-evaluation' ||
    manifest.projection !== 'structured-observation/0.1') throw new HttpError(400, 'contribution purpose or category is invalid');
  const candidate = object(manifest.candidate, 'contribution.json candidate');
  only(candidate, 'id,contentHash');
  const authorization = object(manifest.authorization, 'contribution.json authorization');
  only(authorization, 'explicit,revision');
  if (authorization.explicit !== true || typeof authorization.revision !== 'string' || !CONTRIBUTION_ID.test(authorization.revision))
    throw new HttpError(400, 'contribution requires explicit revision-bound authorization');
  if (typeof candidate.id !== 'string' || !CONTRIBUTION_ID.test(candidate.id)) throw new HttpError(400, 'contribution.json requires an anonymous contribution UUID');
  if (typeof candidate.contentHash !== 'string' || !HEX64.test(candidate.contentHash))
    throw new HttpError(400, 'contribution.json has an invalid candidate.contentHash');
  return { candidateId: candidate.id, contentHash: candidate.contentHash };
}

/**
 * packTreeHash covers directory modes, which the upload does not carry. The client's bundle directories all come
 * from one cpSync under one umask, so they share one mode: try the mode that umask gives beside the files' modes
 * first, then the modes the common umasks give. Declared modes are used as they are. The pack root's own mode is not
 * part of the hash.
 */
function matchContentHash(at: (path: string) => string, directories: Set<string>, declared: Map<string, number> | undefined,
  files: Map<string, UploadFile>, contentHash: string): Map<string, number> {
  const inner = [...directories].filter(directory => directory !== 'pack');
  const attempts: Array<(directory: string) => number> = declared
    ? [directory => declared.get(directory)!]
    : candidateDirectoryModes(files).map(mode => () => mode);
  for (const modeOf of attempts) {
    for (const directory of inner) chmodSync(at(directory), modeOf(directory));
    if (packTreeHash(at('pack')).hash === contentHash) return new Map(inner.map(directory => [directory, modeOf(directory)]));
    if (!inner.length) break;
  }
  throw new HttpError(400, 'pack content does not match candidate.contentHash');
}

function candidateDirectoryModes(files: Map<string, UploadFile>): number[] {
  const counts = new Map<number, number>();
  for (const [path, file] of files) if (path.startsWith('pack/')) counts.set(file.mode & 0o666, (counts.get(file.mode & 0o666) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
  const derived = common | ((common & 0o444) >> 2);
  return [...new Set([derived, 0o755, 0o775, 0o700, 0o750, 0o770, 0o777])].filter(mode => (mode & 0o700) === 0o700);
}

function octalMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}
