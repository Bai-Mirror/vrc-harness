import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { compareVersions } from './app-release.ts';
import { managedPacks } from './managed-pack.ts';
import { installSignedPackRelease, verifyPackRelease, type SignedPackRelease } from './managed-pack-update.ts';
import { officialEndpoints, TRUSTED_RELEASE_KEYS } from './official.ts';
import { writeModesSidecar } from './pack-hash.ts';

/** A signed knowledge release as the server offers it. The archive is not signed: its unpacked tree must hash to the manifest's contentHash. */
export interface KnowledgeArchive { name: string; size: number; sha256: string; url: string }
export interface KnowledgeOffer { manifest: SignedPackRelease; archive: KnowledgeArchive }
export interface KnowledgeCheck {
  channel: string; checkedAt: string;
  current: { id: string; version: string } | null;
  releases: Array<{ releaseId: string; packId: string; version: string; issuedAt: string; size: number; installed: boolean; newer: boolean }>;
  /** Offers that failed verification: never listed or installable. */
  rejected: number;
}
interface Options { channel?: string; fetcher?: typeof fetch; endpoint?: string; trustedKeys?: Record<string, string>; supportedSchema: number }

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
// The same bounds packTreeHash enforces on the unpacked tree.
const MAX_FILES = 10_000;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

function archiveProblem(archive: KnowledgeArchive | undefined): string | undefined {
  if (!archive || typeof archive !== 'object') return 'missing archive';
  if (typeof archive.name !== 'string' || !/^[a-zA-Z0-9._+-]+$/.test(archive.name)) return 'invalid archive name';
  if (!Number.isSafeInteger(archive.size) || archive.size <= 0 || archive.size > MAX_ARCHIVE_BYTES) return 'invalid archive size';
  if (typeof archive.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(archive.sha256)) return 'invalid archive hash';
  if (typeof archive.url !== 'string' || !/^https:\/\//.test(archive.url)) return 'archive url must use https';
  return undefined;
}

/** Offers on the channel whose manifests verify against the trusted keys, newest first. */
export async function listKnowledgeReleases(options: Options): Promise<{ channel: string; offers: KnowledgeOffer[]; rejected: number }> {
  const channel = options.channel ?? 'dev';
  const response = await (options.fetcher ?? fetch)(`${options.endpoint ?? officialEndpoints().knowledge}?channel=${encodeURIComponent(channel)}`,
    { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`能力包更新服务返回 HTTP ${response.status}`);
  const body = await response.json() as { releases?: unknown };
  const offered = Array.isArray(body.releases) ? body.releases as KnowledgeOffer[] : [];
  let rejected = 0;
  const offers = offered.filter(offer => {
    try {
      verifyPackRelease(offer.manifest, options.trustedKeys ?? TRUSTED_RELEASE_KEYS, options.supportedSchema);
      if (archiveProblem(offer.archive)) throw new Error('bad archive');
      return true;
    } catch { rejected++; return false; }
  }).sort((a, b) => compareVersions(b.manifest.version, a.manifest.version));
  return { channel, offers, rejected };
}

/** Lists the verified offers against what is installed and which pack is active. */
export async function checkKnowledgeReleases(db: DatabaseSync, home: string, activeKnowledgeRoot: string | undefined,
  options: Options): Promise<KnowledgeCheck> {
  const { channel, offers, rejected } = await listKnowledgeReleases(options);
  const active = managedPacks(home, activeKnowledgeRoot).find(pack => pack.active);
  const installed = new Set((db.prepare('SELECT pack_id FROM managed_pack_release').all() as Array<{ pack_id: string }>).map(row => row.pack_id));
  return { channel, checkedAt: new Date().toISOString(), rejected, current: active ? { id: active.id, version: active.version } : null,
    releases: offers.map(({ manifest, archive }) => ({ releaseId: manifest.releaseId, packId: manifest.packId, version: manifest.version,
      issuedAt: manifest.issuedAt, size: archive.size, installed: installed.has(manifest.packId),
      newer: !active || compareVersions(manifest.version, active.version) > 0 })) };
}

function text(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length), end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString('utf8');
}
function octal(block: Buffer, start: number, length: number, what: string): number {
  const value = text(block, start, length).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error(`archive has an invalid ${what} field`);
  return value ? parseInt(value, 8) : 0;
}
function safePath(raw: string): string {
  const path = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (!path || path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error(`archive path is not allowed: ${JSON.stringify(raw)}`);
  return path;
}

/**
 * Unpacks a gzip or plain ustar archive into a new directory. Only regular files (0644/0755) and directories (0755)
 * are accepted, each mode is applied exactly, and nothing can land outside the target: the tree then hashes the
 * way the release was signed.
 */
export function extractPackArchive(archive: Buffer, target: string): { files: number; bytes: number } {
  const data = archive[0] === 0x1f && archive[1] === 0x8b ? gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES + 64 * 1024 * 1024 }) : archive;
  mkdirSync(target, { mode: 0o755 }); chmodSync(target, 0o755);
  const seen = new Set<string>(), executable: string[] = [];
  let offset = 0, files = 0, bytes = 0, ended = false;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { ended = true; break; }
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (octal(header, 148, 8, 'checksum') !== sum) throw new Error('archive header checksum mismatch');
    if (!text(header, 257, 6).startsWith('ustar')) throw new Error('archive is not a ustar tar');
    const name = text(header, 0, 100), prefix = text(header, 345, 155);
    const path = safePath(prefix ? `${prefix}/${name}` : name);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`archive repeats a path: ${path}`);
    seen.add(key);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
    const mode = octal(header, 100, 8, 'mode') & 0o7777, size = octal(header, 124, 12, 'size');
    offset += 512;
    const destination = join(target, ...path.split('/'));
    if (type === '5') {
      if (size !== 0 || mode !== 0o755) throw new Error(`archive directory must be empty-bodied with mode 0755: ${path}`);
      mkdirSync(destination, { recursive: true, mode: 0o755 });
      continue;
    }
    if (type !== '0') throw new Error(`archive entry type ${JSON.stringify(type)} is not allowed: ${path}`);
    if (mode !== 0o644 && mode !== 0o755) throw new Error(`archive file mode ${mode.toString(8)} is not allowed: ${path}`);
    if (offset + size > data.length) throw new Error('archive is truncated');
    files++; bytes += size;
    if (files > MAX_FILES || bytes > MAX_UNPACKED_BYTES) throw new Error('archive exceeds the pack size limits');
    mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
    writeFileSync(destination, data.subarray(offset, offset + size), { flag: 'wx', mode });
    chmodSync(destination, mode);
    if (mode === 0o755) executable.push(path);
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended) throw new Error('archive has no end marker');
  // Every directory hashes as 0755, including ones created implicitly or under a restrictive umask.
  const settle = (directory: string): void => {
    chmodSync(directory, 0o755);
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) settle(join(directory, entry.name));
  };
  settle(target);
  // Windows cannot keep the executable bits the release was signed with; they are recorded beside the tree instead.
  if (process.platform === 'win32') writeModesSidecar(target, executable);
  return { files, bytes };
}

/** Downloads, checks and installs one offer; it does not activate it. */
export async function installKnowledgeRelease(db: DatabaseSync, home: string, offer: KnowledgeOffer,
  options: Omit<Options, 'channel' | 'endpoint'>): Promise<{ id: string; version: string; root: string; alreadyInstalled: boolean }> {
  const trustedKeys = options.trustedKeys ?? TRUSTED_RELEASE_KEYS, { manifest, archive } = offer;
  verifyPackRelease(manifest, trustedKeys, options.supportedSchema);
  const problem = archiveProblem(archive); if (problem) throw new Error(problem);
  const existing = db.prepare('SELECT content_hash FROM managed_pack_release WHERE pack_id=?').get(manifest.packId) as { content_hash: string } | undefined;
  if (existing) {
    if (existing.content_hash !== manifest.contentHash) throw new Error(`能力包 ${manifest.packId} 已安装，但内容与此发行不同`);
    return { id: manifest.packId, version: manifest.version, root: join(home, 'managed', 'packs', manifest.packId), alreadyInstalled: true };
  }
  const response = await (options.fetcher ?? fetch)(archive.url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok) throw new Error(`下载能力包失败：HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared !== archive.size) throw new Error('能力包大小与发行清单不符');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== archive.size) throw new Error('能力包大小与发行清单不符');
  if (createHash('sha256').update(bytes).digest('hex') !== archive.sha256) throw new Error('能力包校验值与发行清单不符');
  const parent = join(home, 'managed', 'staging'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(parent, 'release-'));
  try {
    extractPackArchive(bytes, join(staging, 'pack'));
    const installed = installSignedPackRelease(db, home, join(staging, 'pack'), manifest, trustedKeys, options.supportedSchema);
    return { ...installed, version: manifest.version, alreadyInstalled: false };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
