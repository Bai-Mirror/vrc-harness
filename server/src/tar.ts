import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { hashedModes, writeModesSidecar } from './harness.ts';

/**
 * Knowledge-pack archive format; the client unpacks exactly this.
 * - gzip-compressed POSIX ustar. Entry paths are relative to the pack root (`pack.json`, `knowledge/...`): no leading
 *   `./`, no wrapping directory.
 * - Only regular files (typeflag `0`, mode 0644 or 0755) and directories (typeflag `5`, mode 0755, name ending in `/`).
 *   No links, devices, pax or GNU headers; a path over 100 bytes is split into the ustar `prefix` field.
 * - Entries in byte order of their paths, so a directory precedes its contents; mtime 0, uid/gid 0, empty
 *   uname/gname. The same tree always gives the same bytes.
 */
export type TarEntry = { path: string; type: 'dir'; mode: number } | { path: string; type: 'file'; mode: number; data: Buffer };

export const ARCHIVE_MODES: ReadonlySet<number> = new Set([0o644, 0o755]);
const BLOCK = 512;
/** Unpacking bound; packTreeHash refuses trees over 512 MiB anyway. */
const MAX_UNPACKED = 600 * 1024 * 1024;
const MAGIC = 'ustar\0' + '00';

export function assertArchivePath(path: string): void {
  if (!path || path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error(`archive path is not allowed: ${JSON.stringify(path)}`);
}

function numeric(value: number, width: number): string {
  const digits = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || digits.length > width - 1) throw new Error(`value does not fit a ustar field: ${value}`);
  return `${digits.padStart(width - 1, '0')}\0`;
}

/** name (<= 100 bytes) and prefix (<= 155 bytes), split at a slash; never inside a UTF-8 sequence. */
function splitPath(full: Buffer): { name: Buffer; prefix: Buffer } {
  if (full.length <= 100) return { name: full, prefix: Buffer.alloc(0) };
  for (let slash = full.indexOf(0x2f); slash !== -1 && slash < full.length - 1; slash = full.indexOf(0x2f, slash + 1)) {
    if (full.length - slash - 1 > 100) continue;
    if (slash <= 155) return { name: full.subarray(slash + 1), prefix: full.subarray(0, slash) };
    break;
  }
  throw new Error(`path does not fit a ustar header: ${full.toString('utf8')}`);
}

function header(entry: TarEntry): Buffer {
  assertArchivePath(entry.path);
  if (!ARCHIVE_MODES.has(entry.mode) || (entry.type === 'dir' && entry.mode !== 0o755))
    throw new Error(`archive mode ${entry.mode.toString(8)} is not allowed for ${entry.type} ${entry.path}`);
  const { name, prefix } = splitPath(Buffer.from(entry.type === 'dir' ? `${entry.path}/` : entry.path, 'utf8'));
  const block = Buffer.alloc(BLOCK);
  name.copy(block, 0);
  block.write(numeric(entry.mode, 8), 100, 'latin1');
  block.write(numeric(0, 8), 108, 'latin1');
  block.write(numeric(0, 8), 116, 'latin1');
  block.write(numeric(entry.type === 'file' ? entry.data.length : 0, 12), 124, 'latin1');
  block.write(numeric(0, 12), 136, 'latin1');
  block.fill(0x20, 148, 156);
  block.write(entry.type === 'file' ? '0' : '5', 156, 'latin1');
  block.write(MAGIC, 257, 'latin1');
  block.write(numeric(0, 8), 329, 'latin1');
  block.write(numeric(0, 8), 337, 'latin1');
  prefix.copy(block, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

export function writeTar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(header(entry));
    if (entry.type !== 'file') continue;
    blocks.push(entry.data);
    const padding = -entry.data.length & (BLOCK - 1);
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(blocks);
}

/** Every file and directory under root with its mode, in byte order of the paths. */
export function treeEntries(root: string): TarEntry[] {
  const entries: TarEntry[] = [];
  const modeOf = hashedModes(root);
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name, info = lstatSync(path);
      if (info.isDirectory()) { entries.push({ path: relative, type: 'dir', mode: modeOf(relative, info) }); visit(path, relative); }
      else if (info.isFile()) entries.push({ path: relative, type: 'file', mode: modeOf(relative, info), data: readFileSync(path) });
      else throw new Error(`only regular files and directories can be archived: ${relative}`);
    }
  };
  visit(root, '');
  return entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

export function tarGzDirectory(root: string): Buffer {
  return gzipSync(writeTar(treeEntries(root)), { level: 9 });
}

function cstring(block: Buffer, start: number, length: number): Buffer {
  const raw = block.subarray(start, start + length), end = raw.indexOf(0);
  return end === -1 ? raw : raw.subarray(0, end);
}
function octal(block: Buffer, start: number, length: number): number {
  const text = cstring(block, start, length).toString('latin1').trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('tar header has an invalid numeric field');
  return parseInt(text, 8);
}
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Strict reader for the format above: anything else is refused rather than guessed at. */
export function readTar(tar: Buffer): TarEntry[] {
  const entries: TarEntry[] = [], seen = new Set<string>(), directories = new Set<string>();
  for (let offset = 0; ;) {
    if (offset + BLOCK > tar.length) throw new Error('tar archive has no end marker');
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every(byte => byte === 0)) {
      if (tar.length - offset < 2 * BLOCK || !tar.subarray(offset).every(byte => byte === 0)) throw new Error('tar archive end is malformed');
      return entries;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
    if (octal(block, 148, 8) !== sum) throw new Error('tar header checksum mismatch');
    if (block.toString('latin1', 257, 265) !== MAGIC) throw new Error('tar entry is not POSIX ustar');
    const type = String.fromCharCode(block[156]!);
    if (type !== '0' && type !== '5') throw new Error(`tar entry type ${JSON.stringify(type)} is not allowed`);
    const name = cstring(block, 0, 100), prefix = cstring(block, 345, 155);
    let path = utf8.decode(prefix.length ? Buffer.concat([prefix, Buffer.from('/'), name]) : name);
    if (type === '5' && path.endsWith('/')) path = path.slice(0, -1);
    assertArchivePath(path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`tar archive repeats a path: ${path}`);
    seen.add(key);
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent && !directories.has(parent)) throw new Error(`tar entry comes before its directory: ${path}`);
    const mode = octal(block, 100, 8), size = octal(block, 124, 12);
    if (!ARCHIVE_MODES.has(mode) || (type === '5' && mode !== 0o755)) throw new Error(`tar entry mode ${mode.toString(8)} is not allowed: ${path}`);
    offset += BLOCK;
    if (type === '5') {
      if (size !== 0) throw new Error(`tar directory entry has a body: ${path}`);
      directories.add(path);
      entries.push({ path, type: 'dir', mode });
      continue;
    }
    if (offset + size > tar.length) throw new Error('tar archive is truncated');
    entries.push({ path, type: 'file', mode, data: Buffer.from(tar.subarray(offset, offset + size)) });
    offset += size + (-size & (BLOCK - 1));
  }
}

/** Unpacks into a new directory and applies each recorded mode exactly, whatever the umask. */
export function extractTarGz(archive: Buffer, target: string): TarEntry[] {
  const entries = readTar(gunzipSync(archive, { maxOutputLength: MAX_UNPACKED }));
  mkdirSync(target);
  chmodSync(target, 0o755);
  for (const entry of entries) {
    const path = join(target, ...entry.path.split('/'));
    if (entry.type === 'dir') mkdirSync(path);
    else writeFileSync(path, entry.data, { flag: 'wx', mode: 0o600 });
    chmodSync(path, entry.mode);
  }
  if (process.platform === 'win32') writeModesSidecar(target, entries.filter(entry => entry.type === 'file' && entry.mode === 0o755).map(entry => entry.path));
  return entries;
}
