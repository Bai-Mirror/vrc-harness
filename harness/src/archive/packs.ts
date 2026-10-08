import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hostPlatform } from '../host-platform.ts';
import { packTreeHash } from '../pack-hash.ts';

/**
 * Which capability pack a Workflow was frozen from, and whether this machine has exactly that pack. A pack is
 * identified by its id (a changed bundle installed beside its predecessor as `<id>+<hash>` counts as its original id),
 * its version and its content hash (for such a bundle, the hash it was installed with).
 */
export interface PackIdentity { id: string; version: string; channel: string; contentHash: string; root: string }

/** The pack whose root is `root` (pack.json, knowledge/, tools/); undefined when it is not one. */
export function packAt(root: string): PackIdentity | undefined {
  try {
    const info = JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8')) as { schema?: string; id?: string; version?: string;
      channel?: string; bundledFrom?: string; contentHash?: string };
    if (info.schema !== 'harness-managed-pack/0.1' || typeof info.id !== 'string' || typeof info.version !== 'string') return undefined;
    return { id: info.bundledFrom ?? info.id, version: info.version, channel: info.channel ?? 'unknown',
      contentHash: info.contentHash ?? packTreeHash(root).hash, root };
  } catch { return undefined; }
}
/** The pack a frozen tool root belongs to (`<pack>/tools`). */
export function packOfToolRoot(toolRoot: string): PackIdentity | undefined {
  if (!toolRoot || basename(toolRoot) !== 'tools') return undefined;
  return packAt(dirname(toolRoot));
}
export function samePack(a: Pick<PackIdentity, 'id' | 'version' | 'contentHash'>, b: Pick<PackIdentity, 'id' | 'version' | 'contentHash'>): boolean {
  return a.id === b.id && a.version === b.version && a.contentHash === b.contentHash;
}

const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
/**
 * The frozen content a Workflow needs from its pack, read from `root` and checked against the frozen hashes: every
 * tool by `tools/<path>`, every context by `knowledge/<path>`. Returns the contexts' text, or the first mismatch.
 */
export function frozenContent(root: string, tools: Record<string, string>, contexts: Record<string, string>):
  { ok: true; contexts: Record<string, { sha256: string; content: string }> } | { ok: false; problem: string } {
  for (const [path, hash] of Object.entries(tools)) {
    const file = join(root, 'tools', ...path.split('/'));
    if (!hostPlatform.within(join(root, 'tools'), file) || !existsSync(file) || !statSync(file).isFile()) return { ok: false, problem: `缺少工具 ${path}` };
    if (digest(readFileSync(file)) !== hash) return { ok: false, problem: `工具 ${path} 的内容与冻结时不同` };
  }
  const out: Record<string, { sha256: string; content: string }> = {};
  for (const [path, hash] of Object.entries(contexts)) {
    const file = join(root, 'knowledge', ...path.split('/'));
    if (!hostPlatform.within(join(root, 'knowledge'), file) || !existsSync(file) || !statSync(file).isFile()) return { ok: false, problem: `缺少上下文 ${path}` };
    const content = readFileSync(file, 'utf8');
    if (digest(content) !== hash) return { ok: false, problem: `上下文 ${path} 的内容与冻结时不同` };
    out[path] = { sha256: hash, content };
  }
  return { ok: true, contexts: out };
}
