import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { sha256File } from '../file-hash.ts';
import { ordinal } from '../pack-hash.ts';
import { ARCHIVE_MANIFEST, ARCHIVE_SCHEMA, isPortablePath, LEGACY_SCHEMAS, SCHEMAS, type ShareLayer } from './contract.ts';
import type { ArchiveManifest } from './projection.ts';
import { projectionDigest } from './projection.ts';
import type { SevenZipMember } from './sevenzip.ts';
import { guidIndex, metaPairs, referenceClosure, unitySkeleton, type MetaPairs } from './unity-check.ts';

/**
 * The share package format (docs/project-share.md): a 7z whose root holds the Unity project and the chosen `_harness/`
 * partitions, beside `share/manifest.json`, `share/files.json` and `share/恢复说明.md`. files.json is the explicit
 * content list; the manifest says what the package is and what it needs. The same verification runs on the sender's
 * cold unpack and on the receiver's before anything is restored.
 */

export const SHARE_SCHEMA = 'harness-share/1';
export const SHARE_FILES_SCHEMA = 'harness-share-files/1';
export const MANIFEST_PATH = 'share/manifest.json', FILES_PATH = 'share/files.json', README_PATH = 'share/恢复说明.md';
export const SHARE_DOCS: readonly string[] = [MANIFEST_PATH, FILES_PATH, README_PATH];
/** Capability packs a package carries for the receiver (project candidates from the local store). */
export const PACKS_PREFIX = 'share/packs/';

export type ShareLevel = 'continuable' | 'needs_dependencies' | 'observe_only';
export const LEVEL_TEXT: Record<ShareLevel, string> = { continuable: '可直接续做', needs_dependencies: '需补依赖', observe_only: '只能观察（无法直接续做）' };
export type SharePurpose = 'self' | 'others';
export const SHARE_PURPOSES: readonly SharePurpose[] = ['self', 'others'];
export const PURPOSE_TEXT: Record<SharePurpose, string> = { self: '本人迁移/备份', others: '交给他人' };
export const SELF_NOTICE = '仅限本人使用，不得转交他人';

export interface ShareFileEntry {
  /** Package path: relative to the project root, or under share/ for what the package itself carries. */
  path: string;
  kind: 'file' | 'dir';
  layer: Exclude<ShareLayer, 'excluded'>;
  category: string;
  /** Who registered the path (registry source, `archive` for the archive's own files, `local-store` for a carried pack). */
  source: { type: string; ref: string };
  size: number;
  sha256: string | null;
  crc32: string | null;
  reason: string;
  /** The optional item (B/C) it belongs to. */
  item?: string;
  /** 0o755 for an executable file of a carried pack (Windows keeps no mode; the receiver restores it). */
  mode?: number;
}
export interface ShareExclusion {
  /** A file, or a registered tree (ending with `/`) or directory group whose files share the reason. */
  path: string;
  count: number;
  bytes: number;
  reason: string;
  /** How the receiver gets it back: `vpm`, `regenerate`, `acquire` (接收端待补齐). */
  restore: string | null;
}
export interface ShareFiles { schema: typeof SHARE_FILES_SCHEMA; entries: ShareFileEntry[]; excluded: ShareExclusion[] }

export interface PackRequirement {
  selectionSeq?:number;
  stageId?:string;
  workflowId: string;
  /** The project's latest formal Workflow (the one that continues). */
  current: boolean;
  status: string;
  /** Identity of the pack the Workflow was frozen from, when it was a pack (pack.json beside its tools). */
  id: string | null; version: string | null; channel: string | null; contentHash: string | null;
}
export interface ProjectPackRequirement { id: string; version: string | null; contentHash: string; from: string; usedBy: string[] }
export interface MissingDependency { path: string; count: number; bytes: number; text: string }
export interface ShareManifest {
  schema: typeof SHARE_SCHEMA;
  shareId: string;
  createdAt: string;
  purpose: SharePurpose;
  producer: { name: 'harness'; version: string; stateSchema: number; archiveSchema: string; sevenZip: string };
  project: { name: string; archiveId: string; revision: number; digest: string; sourceProjectId: string; lineage: string[] };
  selection: { layers: string[]; items: string[]; permittedOnly: boolean };
  level: ShareLevel;
  levelText: string;
  levelReasons: string[];
  required: Array<{ id: string; text: string; status: 'included' | 'partial' | 'missing' | 'not_applicable'; detail?: string }>;
  optional: Array<{ id: string; layer: 'B' | 'C'; text: string; included: boolean; files: number; bytes: number }>;
  dependencies: {
    unity: string | null;
    vpm: Record<string, string>;
    packs: PackRequirement[];
    projectPacks: ProjectPackRequirement[];
    /** 接收端待补齐: what the package leaves out that the project needs. */
    missing: MissingDependency[];
  };
  references: { seeds: string[]; checked: number; external: Record<string, string>; unread: string[] };
  integrity: { files: number; dirs: number; bytes: number; filesSha256: string; metaPairs: MetaPairs;
    archive: { manifest: string; revision: number; digest: string; files: number } };
  /** What the receiver has to do, in order. */
  receiver: string[];
}

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export const byPath = <T extends { path: string }>(a: T, b: T): number => ordinal(a.path, b.path);

/** Member paths of a package: every entry (directories with a trailing `/` stripped as 7-Zip lists them) and the docs. */
export function expectedMembers(files: ShareFiles): Map<string, { directory: boolean; size: number; crc: string | null }> {
  const members = new Map<string, { directory: boolean; size: number; crc: string | null }>();
  for (const entry of files.entries) members.set(entry.path.replace(/\/$/, ''),
    { directory: entry.kind === 'dir', size: entry.kind === 'dir' ? 0 : entry.size, crc: entry.crc32 });
  return members;
}

/**
 * Compare what 7-Zip lists with what the content list says, item by item: nothing missing, nothing extra, no link,
 * sizes and CRCs equal. `docs` are the share documents, present but not in the content list.
 */
export function compareMembers(listed: SevenZipMember[], files: ShareFiles, docs: readonly string[] = SHARE_DOCS): string[] {
  const problems: string[] = [];
  const expected = expectedMembers(files);
  const seen = new Set<string>();
  for (const member of listed) {
    const key = member.path;
    if (seen.has(key)) { problems.push(`压缩包里 ${key} 出现了不止一次`); continue; }
    seen.add(key);
    if (member.link) { problems.push(`压缩包里 ${key} 是链接`); continue; }
    if (docs.includes(key)) continue;
    const want = expected.get(key);
    if (!want) { problems.push(`压缩包里有清单之外的 ${key}`); continue; }
    if (want.directory !== member.directory) problems.push(`${key} 在压缩包里${member.directory ? '是目录' : '是文件'}，与清单不符`);
    else if (!want.directory && want.size !== member.size) problems.push(`${key} 的大小与清单不符`);
    else if (!want.directory && want.crc && member.crc && want.crc !== member.crc) problems.push(`${key} 的 CRC 与清单不符`);
  }
  for (const key of expected.keys()) if (!seen.has(key)) problems.push(`压缩包缺少清单里的 ${key}`);
  for (const doc of docs) if (!seen.has(doc)) problems.push(`压缩包缺少 ${doc}`);
  return problems;
}

/**
 * Member paths a restore may extract: portable, no link, no duplicate under either case rule (a package made on Linux
 * can hold two names Windows cannot keep apart), within count and size limits.
 */
export const MAX_MEMBERS = 500_000;
export const MAX_BYTES = 256 * 1024 ** 3;
export function unsafeMembers(listed: SevenZipMember[]): string[] {
  const problems: string[] = [];
  const folded = new Map<string, string>();
  let bytes = 0;
  if (listed.length > MAX_MEMBERS) problems.push(`压缩包成员超过 ${MAX_MEMBERS} 个`);
  for (const member of listed) {
    if (!isPortablePath(member.path)) { problems.push(`不安全的成员路径：${member.path}`); continue; }
    if (member.link) problems.push(`链接成员：${member.path}`);
    const key = member.path.toLowerCase();
    const prior = folded.get(key);
    if (prior !== undefined) problems.push(prior === member.path ? `重复的成员：${member.path}` : `只有大小写不同的成员：${prior} 与 ${member.path}`);
    folded.set(key, member.path);
    bytes += member.size;
  }
  if (bytes > MAX_BYTES) problems.push('压缩包解开后超过容量上限');
  return problems.slice(0, 50);
}

export function parseShareFiles(text: string): ShareFiles {
  const value = JSON.parse(text) as ShareFiles;
  if (value?.schema !== SHARE_FILES_SCHEMA) throw new Error(`share/files.json 的 schema 不是 ${SHARE_FILES_SCHEMA}`);
  if (!Array.isArray(value.entries) || !Array.isArray(value.excluded)) throw new Error('share/files.json 结构不完整');
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== 'string' || !isPortablePath(entry.path.replace(/\/$/, '')))
      throw new Error(`share/files.json 里有不安全的路径：${String(entry?.path)}`);
    if (entry.kind === 'file' && (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.size) || entry.size < 0))
      throw new Error(`share/files.json 里 ${entry.path} 缺少大小或 sha256`);
    if (SHARE_DOCS.includes(entry.path)) throw new Error(`share/files.json 不能列出分享包说明文件 ${entry.path}`);
  }
  return value;
}
export function parseShareManifest(text: string): ShareManifest {
  const value = JSON.parse(text) as ShareManifest;
  if (value?.schema !== SHARE_SCHEMA) throw new Error(`share/manifest.json 的 schema 不是 ${SHARE_SCHEMA}（不认识的分享包格式）`);
  if (typeof value.shareId !== 'string' || !value.project || typeof value.project.archiveId !== 'string' ||
    !Number.isSafeInteger(value.project.revision) || typeof value.project.digest !== 'string' || !value.integrity || !value.dependencies)
    throw new Error('share/manifest.json 结构不完整');
  // Older packages were compiled for a recipient and only carried transferable content.
  const purpose = (value as { purpose?: unknown }).purpose ?? 'others';
  if (!SHARE_PURPOSES.includes(purpose as SharePurpose)) throw new Error(`share/manifest.json 的用途无效：${String(purpose)}`);
  return { ...value, purpose: purpose as SharePurpose };
}

/** Archive files a reader of this version knows, by schema. */
const KNOWN_ARCHIVE_SCHEMAS = new Set<string>([...Object.values(SCHEMAS), ...Object.values(LEGACY_SCHEMAS)]);

export interface TreeCheck {
  problems: string[];
  /** What was proven, for the export report and the restore check. */
  checked: { files: number; bytes: number; archiveFiles: number; unity: boolean; metaPairs: MetaPairs; references: number; unread: string[] };
}
/**
 * Verify an unpacked package directory against its own manifest and content list: every listed file present with its
 * size and SHA-256, nothing else; the project archive consistent (each file it lists present with its hash, or an
 * optional layer the package declares as left out); the Unity skeleton, `.meta` pairs no worse than the sender's
 * project, and every GUID the registered roots reach resolvable inside the package or declared external.
 */
export function verifyPackageTree(dir: string, manifest: ShareManifest, files: ShareFiles, filesText: string): TreeCheck {
  const problems: string[] = [];
  const found = new Map<string, 'file' | 'dir'>();
  const visit = (absolute: string, prefix: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`, path = join(absolute, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) { problems.push(`解开的内容里有链接：${rel}`); continue; }
      if (info.isDirectory()) { found.set(rel, 'dir'); visit(path, `${rel}/`); continue; }
      if (!info.isFile()) { problems.push(`解开的内容里有特殊文件：${rel}`); continue; }
      found.set(rel, 'file');
    }
  };
  visit(dir, '');
  if (sha256(filesText) !== manifest.integrity.filesSha256) problems.push('share/files.json 与分享清单记录的摘要不符');
  const listed = new Map(files.entries.map(entry => [entry.path.replace(/\/$/, ''), entry]));
  let bytes = 0, count = 0;
  for (const [path, entry] of listed) {
    const kind = found.get(path);
    if (!kind) { problems.push(`缺少 ${path}`); continue; }
    if (entry.kind === 'dir') { if (kind !== 'dir') problems.push(`${path} 应为目录`); continue; }
    if (kind !== 'file') { problems.push(`${path} 应为文件`); continue; }
    const absolute = join(dir, ...path.split('/'));
    const size = lstatSync(absolute).size;
    if (size !== entry.size) { problems.push(`${path} 的大小与清单不符`); continue; }
    if (sha256File(absolute) !== entry.sha256) { problems.push(`${path} 的内容与清单的 sha256 不符`); continue; }
    bytes += size; count++;
  }
  for (const [path, kind] of found) {
    if (kind === 'dir') continue;
    if (!listed.has(path) && !SHARE_DOCS.includes(path)) problems.push(`清单之外的文件：${path}`);
  }
  for (const doc of SHARE_DOCS) if (found.get(doc) !== 'file') problems.push(`缺少 ${doc}`);

  // The project archive inside: the files of its manifest, as they were written.
  let archiveFiles = 0;
  const archivePath = join(dir, ...ARCHIVE_MANIFEST.split('/'));
  if (!existsSync(archivePath)) problems.push(`缺少工程档案清单 ${ARCHIVE_MANIFEST}`);
  else {
    let archive: ArchiveManifest | undefined;
    try { archive = JSON.parse(readFileSync(archivePath, 'utf8')) as ArchiveManifest; } catch { problems.push('工程档案清单不是合法 JSON'); }
    if (archive) {
      if (archive.schema !== ARCHIVE_SCHEMA) problems.push(`工程档案清单的 schema 不是 ${ARCHIVE_SCHEMA}`);
      else {
        if (projectionDigest(archive.files) !== archive.digest) problems.push('工程档案清单的摘要与文件列表不符');
        if (archive.archiveId !== manifest.project.archiveId || archive.revision !== manifest.project.revision || archive.digest !== manifest.project.digest)
          problems.push('工程档案的身份或修订与分享清单不符');
        const chosen = new Set(manifest.selection.items);
        for (const file of archive.files) {
          const absolute = join(dir, ...file.path.split('/'));
          if (!existsSync(absolute)) {
            // Only an optional layer the person did not choose may be absent, and the manifest must say so.
            const item = `${file.layer}:${file.path}`;
            if (file.layer === 'A' || chosen.has(item)) problems.push(`工程档案缺少 ${file.path}`);
            continue;
          }
          archiveFiles++;
          if (!KNOWN_ARCHIVE_SCHEMAS.has(file.schema)) problems.push(`${file.path} 的 schema ${file.schema} 不认识`);
          if (sha256File(absolute) !== file.sha256) problems.push(`${file.path} 与工程档案清单记录的内容不同`);
        }
      }
    }
  }

  // Unity: the skeleton, .meta pairs no worse than the sender's, and the references from the registered roots.
  const projectFiles = [...found].filter(([path, kind]) => kind === 'file' && !path.startsWith('share/')).map(([path]) => path);
  const emptyDirs = files.entries.filter(entry => entry.kind === 'dir').map(entry => entry.path);
  const skeleton = unitySkeleton(projectFiles);
  const unityRequired = manifest.required.find(item => item.id === 'unity-project');
  if (unityRequired && unityRequired.status !== 'not_applicable' && !skeleton.unity) problems.push('缺少 Unity 工程（ProjectSettings/ProjectVersion.txt）');
  if (skeleton.unity && unityRequired?.status === 'included') for (const missing of skeleton.missing) problems.push(`Unity 工程缺少 ${missing}`);
  const pairs = metaPairs(projectFiles, emptyDirs);
  const declared = manifest.integrity.metaPairs;
  const newMissing = pairs.missingMeta.filter(path => !declared.missingMeta.includes(path));
  const newOrphans = pairs.orphanMeta.filter(path => !declared.orphanMeta.includes(path));
  if (newMissing.length) problems.push(`${newMissing.length} 个资源缺少 .meta（如 ${newMissing.slice(0, 3).join('、')}）`);
  if (newOrphans.length) problems.push(`${newOrphans.length} 个 .meta 没有对应资源（如 ${newOrphans.slice(0, 3).join('、')}）`);
  const present = new Set([...found.keys()]);
  const index = guidIndex(dir, projectFiles);
  const closure = referenceClosure(dir, manifest.references.seeds, index, path => present.has(path));
  const unresolved = closure.references.filter(reference => (!reference.to || !present.has(reference.to)) && !(reference.guid in manifest.references.external));
  if (unresolved.length) problems.push(`${unresolved.length} 个关键引用无法在包内解析（如 ${unresolved.slice(0, 3).map(item => `${item.from} → ${item.guid}`).join('、')}）`);
  return { problems: problems.slice(0, 100), checked: { files: count, bytes, archiveFiles, unity: skeleton.unity, metaPairs: pairs,
    references: closure.references.length, unread: closure.unread } };
}

/** A name for files and directories: letters, digits and a few separators; never empty. */
export function safeName(value: string, fallback = 'project'): string {
  const name = value.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return name || fallback;
}
/** The directory that holds a path's parent, for messages. */
export const parentOf = (path: string): string => basename(dirname(path));
