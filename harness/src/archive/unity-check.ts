import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Checks of a Unity project that need no Unity: the project skeleton, `.meta` companions, and the GUID references
 * reachable from the registered Avatar roots' scenes (text-serialized YAML only; a binary scene is reported as
 * unchecked). Used on the sender, to know what a package needs, and on an unpacked package, to prove it holds it.
 */

/** Unity's built-in resources: not files of the project. */
const BUILTIN_GUID = /^(?:0{16}[def]0{15}|0{32})$/;
const GUID_REFERENCE = /guid:\s*([0-9a-f]{32})/g;
const META_GUID = /^guid:\s*([0-9a-f]{32})\s*$/m;

/** Files and folders Unity does not import (and gives no .meta): hidden names, `name~`, `cvs`, `*.tmp`. */
export function unityIgnored(segment: string): boolean {
  return segment.startsWith('.') || segment.endsWith('~') || segment.toLowerCase() === 'cvs' || segment.toLowerCase().endsWith('.tmp');
}
/** Whether a path of the project is an imported Unity asset (and so has a .meta): under Assets/, or inside a package. */
function metaExpected(path: string): boolean {
  const parts = path.split('/');
  if (parts.some(unityIgnored)) return false;
  if (parts[0] === 'Assets') return parts.length >= 2;
  return parts[0] === 'Packages' && parts.length >= 3;
}

export interface MetaPairs { missingMeta: string[]; orphanMeta: string[] }
/**
 * `.meta` companions over a set of files (and explicit empty folders): every asset file and folder needs its `.meta`,
 * and every `.meta` needs its asset. Sorted, so two runs over the same set compare equal.
 */
export function metaPairs(files: Iterable<string>, emptyDirs: Iterable<string> = []): MetaPairs {
  const fileSet = new Set(files), dirs = new Set<string>();
  for (const dir of emptyDirs) dirs.add(dir.replace(/\/$/, ''));
  for (const file of fileSet) { const parts = file.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  const missingMeta: string[] = [], orphanMeta: string[] = [];
  for (const path of [...fileSet].filter(item => !item.endsWith('.meta')).concat([...dirs])) {
    if (metaExpected(path) && !fileSet.has(`${path}.meta`)) missingMeta.push(path);
  }
  for (const file of fileSet) {
    if (!file.endsWith('.meta')) continue;
    const asset = file.slice(0, -'.meta'.length);
    if (metaExpected(asset) && !fileSet.has(asset) && !dirs.has(asset)) orphanMeta.push(file);
  }
  const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
  return { missingMeta: [...new Set(missingMeta)].sort(order), orphanMeta: orphanMeta.sort(order) };
}

/** A .meta's GUID. */
export function metaGuid(text: string): string | undefined { return META_GUID.exec(text)?.[1]; }

/** GUID → asset path, from the `.meta` files among `paths` (relative), read under `root`. */
export function guidIndex(root: string, paths: Iterable<string>): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of paths) {
    if (!path.endsWith('.meta')) continue;
    let text: string;
    try { text = readFileSync(join(root, ...path.split('/')), 'utf8'); } catch { continue; }
    const guid = metaGuid(text);
    if (guid && !index.has(guid)) index.set(guid, path.slice(0, -'.meta'.length));
  }
  return index;
}

const MAX_YAML_BYTES = 64 * 1024 * 1024, MAX_VISITED = 20_000;
/** The file's text when it is a text-serialized Unity asset (`%YAML`), else undefined. */
function yamlText(absolute: string): string | undefined {
  let size: number;
  try { size = statSync(absolute).size; } catch { return undefined; }
  if (size > MAX_YAML_BYTES) return undefined;
  const head = Buffer.alloc(5);
  const fd = openSync(absolute, 'r');
  try { readSync(fd, head, 0, 5, 0); } finally { closeSync(fd); }
  if (head.toString('latin1') !== '%YAML') return undefined;
  return readFileSync(absolute, 'utf8');
}

export interface Reference { from: string; guid: string; to: string | null }
export interface Closure {
  /** Scenes the walk started from. */
  seeds: string[];
  /** Text assets read. */
  visited: number;
  /** Every distinct GUID reference found, with the asset it resolves to (null: no .meta has it). */
  references: Reference[];
  /** Seeds or referenced assets that exist but are binary-serialized or too large: their references were not read. */
  unread: string[];
  truncated: boolean;
}
/**
 * Follow GUID references from the seed scenes through text assets. `exists` says whether an asset path is present under
 * `root`; references to absent assets are recorded (with the path the index gives, if any) and not followed.
 */
export function referenceClosure(root: string, seeds: string[], index: Map<string, string>, exists: (path: string) => boolean): Closure {
  const queue = [...new Set(seeds)].filter(exists);
  const seen = new Set(queue), references = new Map<string, Reference>(), unread: string[] = [];
  let visited = 0, truncated = false;
  while (queue.length) {
    if (visited >= MAX_VISITED) { truncated = true; break; }
    const path = queue.shift()!;
    const text = yamlText(join(root, ...path.split('/')));
    if (text === undefined) { if (seeds.includes(path) || /\.(unity|prefab|mat|asset|controller|anim|overrideController)$/.test(path)) unread.push(path); continue; }
    visited++;
    for (const match of text.matchAll(GUID_REFERENCE)) {
      const guid = match[1]!;
      if (BUILTIN_GUID.test(guid)) continue;
      const to = index.get(guid) ?? null;
      const key = `${path}\0${guid}`;
      if (!references.has(key)) references.set(key, { from: path, guid, to });
      if (to && !seen.has(to) && exists(to)) { seen.add(to); queue.push(to); }
    }
  }
  const order = (a: Reference, b: Reference): number => a.from < b.from ? -1 : a.from > b.from ? 1 : a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
  return { seeds: [...new Set(seeds)].sort(), visited, references: [...references.values()].sort(order), unread: [...new Set(unread)].sort(), truncated };
}

/**
 * The parts of a Unity project a person expects to find: `ProjectSettings/ProjectVersion.txt` makes it a Unity
 * project; it then needs `Assets/` and a package manifest (Unity's or VPM's). A project Harness has not set up yet (no
 * ProjectVersion.txt) is not a Unity project and has no skeleton to check.
 */
export function unitySkeleton(paths: Iterable<string>): { unity: boolean; missing: string[] } {
  const all = new Set(paths);
  const has = (path: string): boolean => all.has(path);
  if (!has('ProjectSettings/ProjectVersion.txt')) return { unity: false, missing: [] };
  const missing = [
    ...([...all].some(path => path.startsWith('Assets/')) ? [] : ['Assets/']),
    ...(has('Packages/manifest.json') || has('Packages/vpm-manifest.json') ? [] : ['Packages/manifest.json']),
  ];
  return { unity: true, missing };
}
