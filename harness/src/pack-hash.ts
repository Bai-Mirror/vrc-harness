import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync, type Stats } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Only node: modules here: the Harness server imports this file too, and signatures and pack hashes must come out
// byte for byte the same on both sides.

/**
 * Order strings by UTF-16 code unit. localeCompare follows the process locale (Czech sorts "ch" after "h", Chinese
 * orders Han by pinyin), so anything hashed or signed in that order would differ between a server and a client.
 */
export function ordinal(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** JSON with keys sorted by ordinal at every level: the bytes release signatures cover. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => ordinal(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

const MAX_FILES = 10_000;
const MAX_BYTES = 512 * 1024 * 1024;

/**
 * Windows keeps no POSIX modes (stat reports 0666 for every file and directory), so a tree there hashes with the modes
 * Linux gives it: directories 0755, files 0644, and 0755 for the files listed in `<root>.modes.json` beside the tree
 * (written when a signed release that carries such files is unpacked). A pack then hashes the same on both platforms.
 */
export const MODES_SIDECAR = '.modes.json';
function sidecarModes(root: string): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(`${root}${MODES_SIDECAR}`, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, number] => entry[1] === 0o755));
  } catch { return {}; }
}
/** The mode each entry of the tree at `root` is hashed with: what the file system says, or on Windows the Linux mode. */
export function hashedModes(root: string, windows = process.platform === 'win32'): (name: string, info: Stats) => number {
  if (!windows) return (_name, info) => info.mode & 0o777;
  const listed = sidecarModes(root);
  return (name, info) => info.isDirectory() ? 0o755 : listed[name] ?? 0o644;
}

/** Content identity of a pack tree: paths, modes and bytes of every entry, in ordinal order. */
export function packTreeHash(rootPath: string, windows = process.platform === 'win32'): { hash: string; files: number; bytes: number } {
  const root = realpathSync(rootPath);
  const modeOf = hashedModes(root, windows);
  const hash = createHash('sha256'); let files = 0; let bytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => ordinal(a.name, b.name))) {
      const path = join(directory, entry.name); const info = lstatSync(path); const name = relative(root, path).split(sep).join('/');
      if (info.isSymbolicLink()) throw new Error(`candidate pack contains symlink: ${name}`);
      if (entry.isDirectory()) { hash.update(`d\0${name}\0${modeOf(name, info)}\0`); visit(path); continue; }
      if (!entry.isFile()) throw new Error(`candidate pack contains special file: ${name}`);
      files++; bytes += info.size;
      if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error('candidate pack exceeds size limits');
      hash.update(`f\0${name}\0${modeOf(name, info)}\0${info.size}\0`); hash.update(readFileSync(path)); hash.update('\0');
    }
  };
  visit(root); return { hash: hash.digest('hex'), files, bytes };
}
/** Record the executable files of a tree for Windows hashing (see MODES_SIDECAR); nothing is written when there are none. */
export function writeModesSidecar(root: string, executable: string[]): void {
  if (!executable.length) return;
  writeFileSync(`${root}${MODES_SIDECAR}`, `${JSON.stringify(Object.fromEntries([...executable].sort(ordinal).map(name => [name, 0o755])))}\n`);
}

/**
 * Copies a pack tree so that it hashes like its source. Without a filter, Node 24's cpSync takes a native path that
 * creates directories under the process umask instead of with the source mode, and packTreeHash covers modes, so
 * every mode is set from the source afterwards whichever path cpSync took.
 */
export function copyTreeExact(source: string, target: string, filter: (path: string) => boolean = () => true,
  windows = process.platform === 'win32'): void {
  cpSync(source, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: false, filter });
  const settle = (from: string, to: string): void => {
    const info = lstatSync(from);
    if (info.isSymbolicLink() || !filter(from)) return;
    if (info.isDirectory()) for (const name of readdirSync(from)) settle(join(from, name), join(to, name));
    chmodSync(to, info.mode & 0o777);
  };
  settle(source, target);
  // The modes Windows cannot store travel with the tree (see MODES_SIDECAR).
  if (windows && existsSync(`${source}${MODES_SIDECAR}`)) {
    const listed = sidecarModes(source);
    writeModesSidecar(target, Object.keys(listed).filter(name => existsSync(join(target, ...name.split('/')))));
  }
}
