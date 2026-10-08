import { hostPlatform } from './host-platform.ts';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalConfig } from './config.ts';
import { ordinal } from './pack-hash.ts';

export const harnessRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function git(path: string, args: string[]): string | undefined {
  try { return execFileSync(hostPlatform.toolCommand('git'), ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); }
  catch { return undefined; }
}
export interface BuildInfo { packageVersion: string; commit: string | null; dirty: boolean; builtAt: string }
/** Written by scripts/build.mjs next to the compiled modules; absent in a source checkout. */
export function buildInfo(base = import.meta.url): BuildInfo | undefined {
  if (base.endsWith('.ts')) return undefined;
  try { return JSON.parse(readFileSync(fileURLToPath(new URL('./build-info.json', base)), 'utf8')) as BuildInfo; }
  catch { return undefined; }
}
export function packageVersion(root = harnessRoot): string {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
}
let loadedVersion: string | undefined;
export function harnessVersion(root = harnessRoot, info = root === harnessRoot ? buildInfo() : undefined): string {
  // Implicit callers identify this process. Explicit roots still inspect the requested checkout afresh.
  if (arguments.length === 0) return loadedVersion ??= harnessVersion(harnessRoot, buildInfo());
  // An installed build may sit inside someone else's Git repository; trust the commit recorded at build time.
  if (info) return info.commit ? `${info.commit}${info.dirty ? '+dirty' : ''}` : `${info.packageVersion}+nogit`;
  const head = git(root, ['rev-parse', '--short=12', 'HEAD']);
  if (head) return `${head}${git(root, ['status', '--porcelain', '--untracked-files=normal', '--', '.']) ? '+dirty' : ''}`;
  return `${packageVersion(root)}+nogit`;
}
export function knowledgeVersion(config: LocalConfig, profile = config.defaultProfile): string {
  const head = git(config.knowledgeRoot, ['rev-parse', '--short=12', 'HEAD']);
  if (!head) return 'unknown:no-git-head';
  const files = config.provenanceFiles?.[profile]?.knowledge;
  if (!files?.length) return 'unknown:source-files-unavailable';
  try { return `${head}:${digest(files.map(path => digest(readFileSync(path))).join('\n')).slice(0, 12)}`; }
  catch { return 'unknown:source-unreadable'; }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => ordinal(a, b))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function interpretationHash(config: LocalConfig, profile = config.defaultProfile): string {
  const files = config.provenanceFiles?.[profile]?.interpretation;
  if (!files) return 'unknown:source-files-unavailable';
  try { return digest(JSON.stringify({ files: files.map(path => digest(readFileSync(path))),
    import: canonical(config.importSettings ?? {}) })).slice(0, 12); }
  catch { return 'unknown:source-unreadable'; }
}
