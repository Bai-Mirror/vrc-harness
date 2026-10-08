import { execFileSync } from 'node:child_process';
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashedModes, packTreeHash, writeModesSidecar, type SignedPackRelease } from './harness.ts';
import { publicPemFor, signRelease, verifyRelease } from './signing.ts';
import { extractTarGz, tarGzDirectory } from './tar.ts';

const SAFE = /^[a-zA-Z0-9._-]+$/;
/** The version rule verifyPackRelease applies. */
const PACK_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** Python bytecode is never part of a pack: the filter installBundledPack uses. */
const BYTECODE = /(^|\/)__pycache__(\/|$)|\.pyc$/;
/** The client refuses these channels for server releases; `files` is the server's download directory. */
const RESERVED_CHANNELS = new Set(['builtin', 'candidate', 'files']);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface PackSelection { files: string[]; directories: string[]; source: 'git' | 'directory'; skipped: number }

export interface KnowledgeReleaseOptions {
  packDir: string; version: string; channel: string; keyId: string; privateKeyPem: string; minimumStateSchema: number;
  /** Defaults to `<idPrefix>-<version>`; every release needs a new pack id (the client keeps them unique). */
  packId?: string; idPrefix?: string; releaseId?: string; previousPackIds?: string[]; issuedAt?: string;
}
export interface KnowledgeRelease { manifest: SignedPackRelease; archive: Buffer; archiveName: string; selection: PackSelection }

function walk(root: string): { files: string[]; directories: string[]; others: string[] } {
  const found = { files: [] as string[], directories: [] as string[], others: [] as string[] };
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === '.git') continue;
      const relative = prefix ? `${prefix}/${name}` : name, info = lstatSync(join(directory, name));
      if (info.isDirectory()) { found.directories.push(relative); visit(join(directory, name), relative); }
      else if (info.isFile()) found.files.push(relative);
      else found.others.push(relative);
    }
  };
  visit(root, '');
  return found;
}

function gitTracked(packDir: string): string[] | undefined {
  try {
    if (execFileSync('git', ['-C', packDir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== 'true') return undefined;
  } catch {
    return undefined; // no Git, or not a work tree: the directory is the pack
  }
  return execFileSync('git', ['-C', packDir, 'ls-files', '-z', '--cached', '--', '.'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
}

/**
 * Which files make up the pack. Inside a Git work tree only tracked files count, so ignored or untracked leftovers
 * (a private SOP folder, a local tool) can never be published; elsewhere every file and directory counts.
 * Python bytecode never counts.
 */
export function selectPackFiles(packDir: string): PackSelection {
  const present = walk(packDir), tracked = gitTracked(packDir);
  if (tracked) {
    const files = tracked.filter(path => !BYTECODE.test(path)).sort();
    for (const file of files) {
      const info = lstatSync(join(packDir, file), { throwIfNoEntry: false });
      if (!info) throw new Error(`tracked file is missing from the work tree: ${file}`);
      if (!info.isFile()) throw new Error(`only regular files can be packed: ${file}`);
    }
    const kept = new Set(files), directories = new Set<string>();
    for (const file of files) for (let at = file.indexOf('/'); at !== -1; at = file.indexOf('/', at + 1)) directories.add(file.slice(0, at));
    return { files, directories: [...directories].sort(), source: 'git', skipped: present.files.filter(path => !kept.has(path)).length };
  }
  if (present.others.length) throw new Error(`only regular files and directories can be packed: ${present.others.slice(0, 5).join(', ')}`);
  const files = present.files.filter(path => !BYTECODE.test(path)).sort();
  return { files, directories: present.directories.filter(path => !BYTECODE.test(path)).sort(), source: 'directory', skipped: present.files.length - files.length };
}

/** A pack must unpack on every client platform, and the client refuses paths that differ only in case. */
function assertPortable(paths: string[]): void {
  const seen = new Map<string, string>();
  for (const path of paths) {
    for (const part of path.split('/'))
      if (/[<>:"|?*\\\u0000-\u001f]/.test(part) || /[ .]$/.test(part) || WINDOWS_RESERVED.test(part))
        throw new Error(`pack path cannot be unpacked on every platform: ${path}`);
    const key = path.toLowerCase(), other = seen.get(key);
    if (other !== undefined) throw new Error(`pack paths differ only in case: ${other} and ${path}`);
    seen.set(key, path);
  }
}

function rewritePackJson(path: string, fields: { id: string; version: string; channel: string }): void {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('pack.json must be an object');
  const info = parsed as Record<string, unknown>;
  if (info.schema !== 'harness-managed-pack/0.1') throw new Error('pack.json schema must be harness-managed-pack/0.1');
  if (typeof info.description !== 'string' || !info.description.trim()) throw new Error('pack.json needs a description');
  writeFileSync(path, `${JSON.stringify({ schema: info.schema, id: fields.id, version: fields.version, channel: fields.channel,
    description: info.description }, null, 2)}\n`);
  chmodSync(path, 0o644);
}

function settleDirectories(directory: string): void {
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) settleDirectories(join(directory, entry.name));
}

/**
 * Builds a knowledge release:
 * 1. copies the pack's files into a temporary directory, with every directory 0755 and every file 0644, or 0755 when
 *    the source file has an executable bit;
 * 2. rewrites that copy's pack.json with the release's id, version and channel;
 * 3. hashes the copy with packTreeHash (the manifest's contentHash), archives it (see tar.ts) and signs the manifest;
 * 4. before returning, verifies the manifest with the client's verifier and checks that the archive unpacks to a tree
 *    with the same content hash.
 */
export function buildKnowledgeRelease(options: KnowledgeReleaseOptions): KnowledgeRelease {
  const { version, channel, keyId } = options;
  if (!PACK_VERSION.test(version)) throw new Error(`invalid version ${version}`);
  if (!SAFE.test(channel) || RESERVED_CHANNELS.has(channel)) throw new Error(`channel ${channel} cannot carry server releases`);
  const packId = options.packId ?? `${options.idPrefix ?? 'vrc-knowledge'}-${version}`;
  if (!SAFE.test(packId)) throw new Error(`pack id ${packId} may only use letters, digits, ".", "_" and "-"; pass --pack-id`);
  const releaseId = options.releaseId ?? packId;
  if (!SAFE.test(releaseId)) throw new Error(`invalid release id ${releaseId}`);
  const previousPackIds = options.previousPackIds ?? [];
  for (const id of previousPackIds) if (!SAFE.test(id)) throw new Error(`invalid previous pack id ${id}`);
  if (!Number.isInteger(options.minimumStateSchema) || options.minimumStateSchema < 1) throw new Error('minimum state schema must be a positive integer');
  const issuedAt = options.issuedAt ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const selection = selectPackFiles(options.packDir);
  if (!selection.files.includes('pack.json')) throw new Error(`no pack.json among the pack files in ${options.packDir}`);
  assertPortable([...selection.directories, ...selection.files]);

  const work = mkdtempSync(join(tmpdir(), 'harness-pack-'));
  try {
    const root = join(work, 'pack');
    const sourceMode = hashedModes(options.packDir), executable: string[] = [];
    mkdirSync(root);
    for (const directory of selection.directories) mkdirSync(join(root, ...directory.split('/')), { recursive: true });
    for (const file of selection.files) {
      const source = join(options.packDir, ...file.split('/')), target = join(root, ...file.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target, constants.COPYFILE_EXCL);
      const mode = sourceMode(file, lstatSync(source)) & 0o111 ? 0o755 : 0o644;
      chmodSync(target, mode);
      if (mode === 0o755) executable.push(file);
    }
    if (process.platform === 'win32') writeModesSidecar(root, executable);
    rewritePackJson(join(root, 'pack.json'), { id: packId, version, channel });
    settleDirectories(root);
    const contentHash = packTreeHash(root).hash;
    const archive = tarGzDirectory(root);
    const manifest = signRelease<SignedPackRelease>({ schema: 'harness-pack-release/0.1', releaseId, packId, version, contentHash, issuedAt,
      minimumStateSchema: options.minimumStateSchema, previousPackIds, keyId }, options.privateKeyPem);
    verifyRelease(manifest, { [keyId]: publicPemFor(options.privateKeyPem) });
    const unpacked = join(work, 'check');
    extractTarGz(archive, unpacked);
    if (packTreeHash(unpacked).hash !== contentHash) throw new Error('the archive does not unpack to the signed content hash');
    return { manifest, archive, archiveName: `${releaseId}.tar.gz`, selection };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
