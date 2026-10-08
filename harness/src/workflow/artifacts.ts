import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sha256File } from '../file-hash.ts';
import { hostPlatform } from '../host-platform.ts';
import { HOST_GIT_SAFETY } from '../exec/git-scan.ts';
import type { ArtifactSpec } from './capabilities.ts';

/**
 * An artifact kind is a set of files in the project. Its fingerprint hashes every file's path and content,
 * so any change to any member (or a member appearing or disappearing) is a new version. Paths are literal
 * files or directories; a directory stands for everything under it.
 */
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
type CacheEntry = { key: string; hash: string };
/** Content hashes keyed by path and stat, so unchanged large files are not reread every reconcile. */
const contentCache = new Map<string, CacheEntry>();

function statKey(path: string): { key: string; symlink: boolean } | undefined {
  try {
    const stat = lstatSync(path, { bigint: true });
    return { key: `${stat.size}:${stat.mtimeNs}:${stat.ino}:${stat.mode}`, symlink: stat.isSymbolicLink() };
  } catch { return undefined; }
}
export function fileHash(path: string): string | undefined {
  const stat = statKey(path);
  if (!stat) return undefined;
  if (stat.symlink) return digest(`symlink:${readlinkSync(path)}`);
  const cached = contentCache.get(path);
  if (cached?.key === stat.key) return cached.hash;
  const hash = sha256File(path);
  contentCache.set(path, { key: stat.key, hash });
  return hash;
}

function walk(root: string, path: string, out: string[]): void {
  let stat;
  try { stat = lstatSync(path); } catch { return; }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path).sort()) walk(root, join(path, entry), out);
  } else if (stat.isFile() || stat.isSymbolicLink()) out.push(relative(root, path).split(sep).join('/'));
}

/** Paths named in the artifact's list file join its members; a list naming a path outside the project is refused. */
function withListed(project: string, spec: ArtifactSpec): ArtifactSpec {
  if (!spec.listed) return spec;
  let text: string;
  try { text = readFileSync(join(project, spec.listed), 'utf8'); } catch { return spec; }
  const listed = text.split('\n').map(line => line.trim().replace(/\/+$/, '')).filter(line => line && !line.startsWith('#'));
  for (const path of listed)
    if (path.startsWith('/') || path.split('/').includes('..') || !hostPlatform.within(project, join(project, path)))
      throw new Error(`产物清单 ${spec.listed} 列出了工程外路径: ${path}`);
  return { ...spec, paths: [...spec.paths, ...listed] };
}
/** Unity keeps a GUID and import settings in `<path>.meta`; a listed file's or directory's .meta belongs to it. */
function metaCompanions(project: string, spec: ArtifactSpec): string[] {
  return spec.paths.map(path => `${path.replace(/\/+$/, '')}.meta`).filter(path => {
    try { return lstatSync(join(project, path)).isFile(); } catch { return false; }
  });
}
/** Project-relative POSIX paths of the artifact's current members, sorted. */
export function artifactFiles(project: string, spec: ArtifactSpec): string[] {
  if (spec.source?.kind === 'runtime') return [];
  const members = memberFiles(project, withListed(project, spec));
  // A leftover .meta alone does not make an absent artifact present.
  return members.length ? [...new Set([...members, ...metaCompanions(project, spec)])].sort() : [];
}
function memberFiles(project: string, spec: ArtifactSpec): string[] {
  if (spec.includeIgnored) {
    const out: string[] = [];
    for (const path of spec.paths) {
      const target = join(project, path);
      if (!hostPlatform.within(project, target)) throw new Error(`产物路径越出工程: ${path}`);
      walk(project, target, out);
    }
    return [...new Set(out)].sort();
  }
  const listed = execFileSync(hostPlatform.toolCommand('git'), [...HOST_GIT_SAFETY, '--literal-pathspecs', '-C', project, 'ls-files', '-z',
    '--cached', '--others', '--exclude-standard', '--', ...spec.paths], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  // ls-files lists deleted-but-tracked files too; a member that is gone is not part of the current version.
  return [...new Set(listed.split('\0').filter(Boolean))].filter(path => existsSync(join(project, path)) ||
    statKey(join(project, path))?.symlink).sort();
}

/** Each member's content hash, by project-relative path; empty when the artifact has no members yet. */
export function artifactMembers(project: string, spec: ArtifactSpec): Map<string, string> {
  return new Map(artifactFiles(project, spec).map(path => [path, fileHash(join(project, path)) ?? 'missing']));
}
/** The fingerprint of a member list; undefined when it is empty: an absent artifact is not an empty one. */
export function membersFingerprint(members: Map<string, string>): string | undefined {
  if (!members.size) return undefined;
  return digest([...members].map(([path, hash]) => `${path}\0${hash}`).join('\n'));
}
export function artifactFingerprint(project: string, spec: ArtifactSpec): string | undefined {
  return membersFingerprint(artifactMembers(project, spec));
}
export interface MemberChange { added: string[]; removed: string[]; modified: string[] }
/** Which members differ between two member lists. */
export function memberChange(before: Map<string, string>, after: Map<string, string>): MemberChange {
  return { added: [...after.keys()].filter(path => !before.has(path)), removed: [...before.keys()].filter(path => !after.has(path)),
    modified: [...after].filter(([path, hash]) => before.has(path) && before.get(path) !== hash).map(([path]) => path) };
}

export function clearArtifactCache(): void { contentCache.clear(); }
