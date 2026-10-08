import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { relative, join } from 'node:path';
import { sha256File } from '../file-hash.ts';
import { hostPlatform } from '../host-platform.ts';

/**
 * Git on the host reads the repository's own config, which a Run may have written: an fsmonitor there runs as a
 * command on every status, and a hooks path redirects hooks. Every host git call on a project repository passes these.
 */
export const HOST_GIT_SAFETY = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];
export const DEFAULT_GIT_OUTPUT_LIMIT = 256 * 1024 * 1024;
export const DEFAULT_HASH_LIMIT = 64 * 1024 * 1024;
export interface ScanLimits { gitOutputBytes?: number; hashBytes?: number }
export type StatusSnapshot = Record<string, string>;
export interface ChangeEvidence { path: string; before?: string; after?: string; sha256?: string;
  hashStatus?: string; hashLimitBytes?: number }

function limit(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Scan limit must be a positive integer');
  return n;
}
function gitOutput(repo: string, args: string[], bytes: number): string {
  try { return execFileSync(hostPlatform.toolCommand('git'), [...HOST_GIT_SAFETY, '-C', repo, ...args],
    { encoding: 'utf8', maxBuffer: bytes }); }
  catch (error) {
    const e = error as Error & { code?: string };
    if (e.code === 'ENOBUFS' || /maxBuffer/.test(e.message))
      throw new Error(`Git scan output exceeded configured limit (${bytes} bytes)`);
    throw error;
  }
}
export function gitHead(repo: string): string {
  try { return execFileSync(hostPlatform.toolCommand('git'), [...HOST_GIT_SAFETY, '-C', repo, 'rev-parse', '--verify', 'HEAD'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return execFileSync(hostPlatform.toolCommand('git'), [...HOST_GIT_SAFETY, '-C', repo, 'hash-object', '-t', 'tree', '--stdin'],
    { encoding: 'utf8', input: '' }).trim(); }
}
export function committedOutside(repo: string, project: string, beforeHead: string, afterHead: string,
  limits: ScanLimits = {}): string[] {
  const projectRel = relative(repo, project).replaceAll('\\', '/');
  if (!hostPlatform.within(repo, project)) throw new Error('Project is outside workspace repository');
  if (beforeHead === afterHead) return [];
  const changed = committedPaths(repo, beforeHead, afterHead, undefined, limits);
  return changed.filter(path => projectRel !== '' && !hostPlatform.within(project, join(repo, path))).sort();
}
export function committedPaths(repo: string, beforeHead: string, afterHead: string,
  project?: string, limits: ScanLimits = {}): string[] {
  if (beforeHead === afterHead) return [];
  const rel = project === undefined ? undefined : relative(repo, project).replaceAll('\\', '/');
  if (project !== undefined && !hostPlatform.within(repo, project)) throw new Error('Project is outside workspace repository');
  return gitOutput(repo, ['diff', '--no-renames', '--name-only', '-z', beforeHead, afterHead, '--',
    ...(rel !== undefined ? [rel || '.'] : [])], limit(limits.gitOutputBytes, DEFAULT_GIT_OUTPUT_LIMIT))
    .split('\0').filter(Boolean);
}
export function statusSnapshot(repo: string, project?: string, limits: ScanLimits = {}): StatusSnapshot {
  const rel = project === undefined ? undefined : relative(repo, project).replaceAll('\\', '/');
  if (project !== undefined && !hostPlatform.within(repo, project)) throw new Error('Project is outside workspace repository');
  const raw = gitOutput(repo, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    ...(rel ? ['--', rel] : [])], limit(limits.gitOutputBytes, DEFAULT_GIT_OUTPUT_LIMIT));
  const records = raw.split('\0'); const result: StatusSnapshot = {};
  const add = (path: string, status: string): void => {
    if (!path) return;
    try {
      const info = lstatSync(join(repo, path), { bigint: true });
      const type = info.isFile() ? 'file' : info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : 'other';
      result[path] = `${status}:${type}:${info.size}:${info.mtimeNs}:${info.ino}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      result[path] = `${status}:absent`;
    }
  };
  for (let i = 0; i < records.length; i++) {
    const item = records[i]; if (!item || item.length < 4) continue;
    const status = item.slice(0, 2); add(item.slice(3), status);
    if (status.includes('R') || status.includes('C')) add(records[++i] ?? '', status);
  }
  return result;
}
export function outsideStatus(repo: string, project: string, limits: ScanLimits = {}): StatusSnapshot {
  const rel = relative(repo, project).replaceAll('\\', '/');
  if (!hostPlatform.within(repo, project)) throw new Error('Project is outside workspace repository');
  const all = statusSnapshot(repo, undefined, limits);
  return Object.fromEntries(Object.entries(all).filter(([path]) => rel !== '' && !hostPlatform.within(project, join(repo, path))));
}
export function changedOutside(before: StatusSnapshot, after: StatusSnapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(path => before[path] !== after[path]).sort();
}
/** Git's two status columns are evidence, but only the stat suffix can indicate a file write. */
export function metadataChanged(repo: string, path: string, before?: string, after?: string): boolean {
  const metadata = (entry?: string): string | undefined => entry?.slice(3);
  if (before === undefined) return after !== undefined;
  if (after !== undefined) return metadata(before) !== metadata(after);
  // A committed previously untracked file disappears from git status. Inspect the file itself.
  try {
    const info = lstatSync(join(repo, path), { bigint: true });
    const type = info.isFile() ? 'file' : info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'dir' : 'other';
    return metadata(before) !== `${type}:${info.size}:${info.mtimeNs}:${info.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return metadata(before) !== 'absent';
  }
}
export function changeEvidence(repo: string, before: StatusSnapshot, after: StatusSnapshot,
  limits: ScanLimits = {}): ChangeEvidence[] {
  const max = limit(limits.hashBytes, DEFAULT_HASH_LIMIT);
  const entries: ChangeEvidence[] = [];
  for (const path of changedOutside(before, after)) {
    const entry: ChangeEvidence = { path, before: before[path], after: after[path] };
    try {
      const info = lstatSync(join(repo, path));
      if (info.isFile() && info.size > max) {
        entry.hashStatus = '未哈希（超过上限）'; entry.hashLimitBytes = max;
      }
      else if (info.isFile()) {
        entry.sha256 = sha256File(join(repo, path));
      } else entry.hashStatus = '未哈希（非普通文件）';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      entry.hashStatus = '未哈希（路径不存在）';
    }
    entries.push(entry);
  }
  return entries;
}
