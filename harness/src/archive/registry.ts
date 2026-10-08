import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, ordinal } from '../pack-hash.ts';
import { isPortablePath, SHARE_LAYERS, type Rights, type Sensitivity, type ShareLayer } from './contract.ts';
import { inTransaction } from './facts.ts';

/**
 * The classification registry (登记项): every project path Harness knows gets a category, a share layer, transfer
 * rights, a sensitivity and the source that registered it. A file no registration covers is unclassified (待分类): it
 * never becomes shareable because of the directory it is in. Built-in rules are code, versioned with the archive
 * schema; every other registration is an append-only row with its provenance.
 */

export type RegistrySource = 'harness' | 'unity' | 'user' | 'vpm' | 'workflow' | 'import_scan';
/** Which registration wins when several cover a path; higher first. Harness's own partitions cannot be overridden. */
export const SOURCE_PRIORITY: Record<RegistrySource, number> = { harness: 100, user: 90, vpm: 70, workflow: 60, import_scan: 40, unity: 20 };
export type RegistryMatch = 'file' | 'tree' | 'root-suffix';
export interface RegistryEntry {
  /** Relative to the project root, `/` separators; a tree ends with `/`; a root-suffix is a file name ending. */
  path: string;
  match: RegistryMatch;
  category: string;
  shareLayer: ShareLayer;
  rights: Rights;
  sensitivity: Sensitivity;
  source: { type: RegistrySource; ref: string };
  /** Content hash when the registering source knew it. */
  sha256?: string | null;
  /** How a receiver gets an excluded path back: `vpm` (resolve the lock), `regenerate` (Unity or a stage makes it). */
  restore?: string | null;
  reason: string;
  /** Database order; 0 for a built-in rule. */
  seq: number;
  /** Built-in only: the tree walk does not enter this tree (caches, VCS data). */
  walk?: false;
}
type Rule = Omit<RegistryEntry, 'source' | 'seq'>;
const HARNESS_REF = 'harness:rules/1';
const UNITY_REF = 'harness:unity-defaults/1';

const harness = (path: string, match: RegistryMatch, category: string, shareLayer: ShareLayer, reason: string,
  extra: Partial<Rule> = {}): RegistryEntry => ({ path, match, category, shareLayer, rights: 'transferable', sensitivity: 'normal',
  reason, ...extra, source: { type: 'harness', ref: HARNESS_REF }, seq: 0 });
const cache = (path: string, match: RegistryMatch = 'tree'): RegistryEntry => harness(path, match, 'regenerable', 'excluded',
  '可再生的缓存或构建副本，接收端由 Unity 或阶段重新生成', { rights: 'unknown', restore: 'regenerate', ...(match === 'tree' ? { walk: false } : {}) });

/** Harness-owned partitions, caches and VCS data. Anchored at the project root: a same-named folder inside a plugin is not matched. */
export const HARNESS_RULES: readonly RegistryEntry[] = [
  harness('_harness/archive.json', 'file', 'archive-manifest', 'A', '工程档案清单'),
  harness('_harness/face/accepted-manual.json', 'file', 'production-materialization', 'excluded', '接受内容由生产输入档案保存，Runtime 在派发时重新生成此副本', {restore:'regenerate'}),
  harness('_harness/state/production.json', 'file', 'production-inputs', 'A', '脸型接受内容、冻结输入与工程交付谱系'),
  harness('_harness/state/', 'tree', 'archive-state', 'A', '项目事实与当前状态投影'),
  harness('_harness/records/', 'tree', 'archive-records', 'B', '施工事件记录'),
  harness('_harness/records/decisions.json', 'file', 'archive-records', 'A', '方案、批准与已确认决定'),
  harness('_harness/records/sources.json', 'file', 'archive-records', 'A', '导入、素材与依赖来源'),
  harness('_harness/evidence/', 'tree', 'archive-evidence', 'A', '证据索引'),
  harness('_harness/recovery/', 'tree', 'archive-recovery', 'A', '接手与补证记录'),
  harness('_harness/recovery/takeover.json', 'file', 'archive-recovery', 'A', 'Harness 校验后的接手摘要'),
  harness('_harness/packs/', 'tree', 'archive-packs', 'A', '本项目能力包的恢复信息'),
  harness('_harness/optional/', 'tree', 'archive-optional', 'B', '可选分享的非敏感资料'),
  harness('_harness/sensitive/', 'tree', 'archive-sensitive', 'C', '原始需求、对话与私人命名等敏感资料', { sensitivity: 'sensitive' }),
  harness('_harness/share/', 'tree', 'archive-share', 'C', '分享方案与对账报告（按收件人保存）', { sensitivity: 'sensitive' }),
  harness('_harness/candidate-packs/', 'tree', 'project-pack-draft', 'A', '本项目候选能力包草稿（同版 Harness 恢复为项目候选）'),
  // What the takeover analysis Task writes: raw AI output about the project, reviewed item by item before any share.
  harness('_Harness/Recovery/', 'tree', 'takeover-analysis', 'C', 'AI 接手分析的原始输出', { sensitivity: 'sensitive' }),
  harness('_Harness/Incoming/', 'tree', 'import-original', 'C', '导入时隔离保存的原始输入，可能含付费素材', { rights: 'unknown', sensitivity: 'sensitive' }),
  harness('.git/', 'tree', 'vcs', 'excluded', '工程自己的版本库，不随工程分享', { rights: 'unknown', walk: false }),
  ...['Library/', 'Temp/', 'Logs/', 'obj/', 'Build/', 'Builds/', 'MemoryCaptures/', 'Recordings/', 'UserSettings/', '_harness_build/',
    '.vs/', '.idea/', '.vscode/', 'Packages/nadena.dev.ndmf/__Generated/', 'Assets/ZZZ_GeneratedAssets/'].map(path => cache(path)),
  ...['Packages/nadena.dev.ndmf/__Generated.meta', 'Assets/ZZZ_GeneratedAssets.meta', 'Packages/jp.lilxyzw.liltoon/Editor/CurrentRP.txt']
    .map(path => cache(path, 'file')),
  ...['.csproj', '.sln', '.userprefs', '.pidb', '.booproj', '.svd', '.unityproj'].map(suffix => cache(suffix, 'root-suffix')),
];
const unity = (path: string, match: RegistryMatch, category: string, reason: string): RegistryEntry => ({ path, match, category,
  shareLayer: 'A', rights: 'transferable', sensitivity: 'normal', reason, source: { type: 'unity', ref: UNITY_REF }, seq: 0 });
/** The Unity project's own configuration; lowest priority, so any provenance registration of these paths wins. */
export const UNITY_RULES: readonly RegistryEntry[] = [
  unity('ProjectSettings/', 'tree', 'unity-settings', 'Unity 工程设置（内容仍须经导出时的敏感信息检查）'),
  ...['Packages/manifest.json', 'Packages/vpm-manifest.json', 'Packages/packages-lock.json'].map(path =>
    unity(path, 'file', 'unity-manifest', 'Unity/VPM 依赖声明')),
  ...['.gitignore', '.gitattributes', '.vsconfig'].map(path => unity(path, 'file', 'project-config', '工程配置文件')),
];
export const BUILTIN_RULES: readonly RegistryEntry[] = [...HARNESS_RULES, ...UNITY_RULES];

/** What a file present in an imported project is, judged by where it is. Rights stay unknown for anything third-party-able. */
export function categorize(path: string): Pick<RegistryEntry, 'category' | 'shareLayer' | 'rights' | 'sensitivity' | 'reason'> {
  const top = path.split('/')[0]!;
  if (top === 'Assets') return path.endsWith('.meta')
    ? { category: 'unity-meta', shareLayer: 'A', rights: 'unknown', sensitivity: 'normal', reason: 'Unity 资源的 .meta（GUID 与导入设置）' }
    : { category: 'unity-asset', shareLayer: 'A', rights: 'unknown', sensitivity: 'normal', reason: 'Unity 工程资源，来源与转交权未知' };
  if (top === 'ProjectSettings') return { category: 'unity-settings', shareLayer: 'A', rights: 'transferable', sensitivity: 'normal', reason: 'Unity 工程设置' };
  if (['Packages/manifest.json', 'Packages/vpm-manifest.json', 'Packages/packages-lock.json'].includes(path))
    return { category: 'unity-manifest', shareLayer: 'A', rights: 'transferable', sensitivity: 'normal', reason: 'Unity/VPM 依赖声明' };
  if (top === 'Packages') return { category: 'unity-package-embedded', shareLayer: 'A', rights: 'unknown', sensitivity: 'normal', reason: '工程内嵌的包，来源与转交权未知' };
  if (!path.includes('/') && ['.gitignore', '.gitattributes', '.vsconfig'].includes(path))
    return { category: 'project-config', shareLayer: 'A', rights: 'transferable', sensitivity: 'normal', reason: '工程配置文件' };
  if (!path.includes('/') && /\.(md|txt)$/i.test(path))
    return { category: 'project-record', shareLayer: 'C', rights: 'unknown', sensitivity: 'sensitive', reason: '工程根目录的工作记录，可能含客户信息' };
  return { category: 'project-file', shareLayer: 'B', rights: 'unknown', sensitivity: 'normal', reason: '工程内的其他文件，来源与转交权未知' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Stored registrations.

export type NewEntry = Omit<RegistryEntry, 'seq' | 'walk' | 'source'> & { source: { type: Exclude<RegistrySource, 'harness' | 'unity'>; ref: string } };
function invalid(message: string): never { throw Object.assign(new Error(message), { code: 'BAD_REQUEST' }); }
export function validateEntry(entry: NewEntry): void {
  if (entry.match !== 'file' && entry.match !== 'tree') invalid(`登记方式无效：${entry.match}`);
  if (!isPortablePath(entry.path, { tree: entry.match === 'tree' })) invalid(`登记路径不是工程内的可移植相对路径：${entry.path}`);
  if (!entry.category.trim()) invalid('登记缺少类别');
  if (!SHARE_LAYERS.includes(entry.shareLayer)) invalid(`分享层级无效：${entry.shareLayer}`);
  if (!['transferable', 'not_transferable', 'unknown'].includes(entry.rights)) invalid(`转交权无效：${entry.rights}`);
  if (!['normal', 'sensitive', 'secret'].includes(entry.sensitivity)) invalid(`敏感度无效：${entry.sensitivity}`);
  if (!['user', 'vpm', 'workflow', 'import_scan'].includes(entry.source.type)) invalid(`登记来源无效：${entry.source.type}`);
  if (!entry.source.ref.trim() || !entry.reason.trim()) invalid('登记缺少来源引用或理由');
  if (entry.sensitivity === 'secret' && entry.shareLayer !== 'excluded') invalid('凭据类内容只能登记为不分享');
  if (entry.source.type === 'user' && BUILTIN_RULES.some(rule => rule.source.type === 'harness' && rule.shareLayer !== 'excluded' &&
    (rule.match === 'tree' ? `${entry.path}`.startsWith(rule.path) : rule.path === entry.path)))
    invalid(`Harness 自有分区由 Harness 归类，不能手动登记：${entry.path}`);
}

type EntryRow = { seq: number; path: string; match: 'file' | 'tree'; category: string; share_layer: ShareLayer; rights: Rights;
  sensitivity: Sensitivity; source_type: RegistrySource; source_ref: string; sha256: string | null; restore: string | null; reason: string };
function entryFromRow(row: EntryRow): RegistryEntry {
  return { path: row.path, match: row.match, category: row.category, shareLayer: row.share_layer, rights: row.rights,
    sensitivity: row.sensitivity, source: { type: row.source_type, ref: row.source_ref }, sha256: row.sha256, restore: row.restore,
    reason: row.reason, seq: row.seq };
}
/**
 * The registrations in force: the newest row of each path, match and source type (an older one it repeats or replaces
 * is history). Built-in rules are not included.
 */
export function storedEntries(db: DatabaseSync, projectId: string): RegistryEntry[] {
  return (db.prepare(`SELECT seq, path, match, category, share_layer, rights, sensitivity, source_type, source_ref, sha256, restore, reason
    FROM project_file_entry WHERE seq IN (SELECT MAX(seq) FROM project_file_entry WHERE project_id = ? GROUP BY path, match, source_type)
    ORDER BY path, seq`).all(projectId) as EntryRow[]).map(entryFromRow);
}
const attributes = (entry: Pick<RegistryEntry, 'category' | 'shareLayer' | 'rights' | 'sensitivity' | 'restore' | 'source'>): string =>
  canonicalJson([entry.category, entry.shareLayer, entry.rights, entry.sensitivity, entry.restore ?? null, entry.source.ref]);
/**
 * Append registrations. One that repeats the registration in force for its path, match and source type is skipped,
 * so a repeated scan or import adds nothing. Returns how many rows were appended.
 */
export function registerEntries(db: DatabaseSync, projectId: string, entries: NewEntry[]): number {
  for (const entry of entries) validateEntry(entry);
  if (!entries.length) return 0;
  return inTransaction(db, () => {
    const existing = new Map(storedEntries(db, projectId).map(entry => [`${entry.path}\0${entry.match}\0${entry.source.type}`, attributes(entry)]));
    const insert = db.prepare(`INSERT INTO project_file_entry (project_id, path, match, category, share_layer, rights, sensitivity,
      source_type, source_ref, sha256, restore, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let written = 0;
    for (const entry of entries) {
      const key = `${entry.path}\0${entry.match}\0${entry.source.type}`, value = attributes(entry);
      if (existing.get(key) === value) continue;
      insert.run(projectId, entry.path, entry.match, entry.category, entry.shareLayer, entry.rights, entry.sensitivity, entry.source.type,
        entry.source.ref, entry.sha256 ?? null, entry.restore ?? null, entry.reason);
      existing.set(key, value);
      written++;
    }
    return written;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Classification.

const LAYER_STRICTNESS: Record<ShareLayer, number> = { A: 0, B: 1, C: 2, excluded: 3 };
const RIGHTS_STRICTNESS: Record<Rights, number> = { transferable: 0, unknown: 1, not_transferable: 2 };
const SENSITIVITY_STRICTNESS: Record<Sensitivity, number> = { normal: 0, sensitive: 1, secret: 2 };
/** Two registrations tie (the same directory under two spellings on a case-insensitive disk): the stricter of each wins. */
function stricter(a: RegistryEntry, b: RegistryEntry): RegistryEntry {
  const layer = LAYER_STRICTNESS[a.shareLayer] >= LAYER_STRICTNESS[b.shareLayer] ? a : b;
  return { ...layer, rights: RIGHTS_STRICTNESS[a.rights] >= RIGHTS_STRICTNESS[b.rights] ? a.rights : b.rights,
    sensitivity: SENSITIVITY_STRICTNESS[a.sensitivity] >= SENSITIVITY_STRICTNESS[b.sensitivity] ? a.sensitivity : b.sensitivity };
}
export interface Classifier {
  /** The registration that decides a file's classification; undefined: unclassified. */
  classify(path: string): RegistryEntry | undefined;
  /** Whether the tree walk skips a directory (given with a trailing `/`). */
  skipped(directory: string): boolean;
}
/**
 * Precedence: the highest source priority; then the most specific match (a file over a tree, a longer tree over a
 * shorter one, a root suffix last); then the newest registration; a remaining tie takes the stricter attributes.
 * Paths compare case-insensitively where the file system does (Windows).
 */
export function classifier(entries: readonly RegistryEntry[], caseInsensitive = process.platform === 'win32'): Classifier {
  const key = (path: string): string => caseInsensitive ? path.toLowerCase() : path;
  const files = new Map<string, RegistryEntry[]>(), trees = new Map<string, RegistryEntry[]>(), suffixes: RegistryEntry[] = [];
  for (const entry of entries) {
    if (entry.match === 'root-suffix') { suffixes.push(entry); continue; }
    const map = entry.match === 'file' ? files : trees;
    map.set(key(entry.path), [...(map.get(key(entry.path)) ?? []), entry]);
  }
  const specificity = (entry: RegistryEntry): number => entry.match === 'file' ? Number.MAX_SAFE_INTEGER : entry.match === 'tree' ? entry.path.length : 0;
  const pick = (candidates: RegistryEntry[]): RegistryEntry | undefined => {
    let best: RegistryEntry | undefined;
    for (const entry of candidates) {
      if (!best) { best = entry; continue; }
      const order = SOURCE_PRIORITY[entry.source.type] - SOURCE_PRIORITY[best.source.type] || specificity(entry) - specificity(best) || entry.seq - best.seq;
      if (order > 0) best = entry;
      else if (order === 0) best = stricter(best, entry);
    }
    return best;
  };
  return {
    classify(path: string): RegistryEntry | undefined {
      const candidates = [...(files.get(key(path)) ?? [])];
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) candidates.push(...(trees.get(key(`${parts.slice(0, i).join('/')}/`)) ?? []));
      if (parts.length === 1) candidates.push(...suffixes.filter(entry => key(path).endsWith(key(entry.path))));
      return pick(candidates);
    },
    skipped(directory: string): boolean {
      const winner = pick(trees.get(key(directory)) ?? []);
      return winner?.walk === false;
    },
  };
}

export const MAX_WALK_FILES = 500_000;
/**
 * The project's files, as sorted relative paths, without entering skipped trees; symbolic links are listed apart and
 * never followed. Special files are ignored.
 */
export function walkProject(root: string, skip: Classifier['skipped']): { files: string[]; symlinks: string[]; truncated: boolean } {
  const files: string[] = [], symlinks: string[] = [];
  let truncated = false;
  const visit = (directory: string, prefix: string): void => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => ordinal(a.name, b.name))) {
      if (truncated) return;
      const rel = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) { symlinks.push(rel); continue; }
      if (entry.isDirectory()) { if (!skip(`${rel}/`)) visit(join(directory, entry.name), `${rel}/`); continue; }
      if (!entry.isFile()) continue;
      files.push(rel);
      if (files.length >= MAX_WALK_FILES) truncated = true;
    }
  };
  visit(root, '');
  return { files, symlinks, truncated };
}

/** Archive partitions (docs/project-archive.md §2), where Harness writes the projection itself. */
export const ARCHIVE_PARTITIONS: readonly string[] = ['_harness/state/', '_harness/records/', '_harness/evidence/', '_harness/recovery/',
  '_harness/packs/', '_harness/optional/', '_harness/sensitive/'];
/** Paths Harness itself rewrites in a project (the archive and its local share records): never the person's content. */
export function harnessOwned(path: string): boolean {
  const key = path.toLowerCase();
  return key === '_harness/archive.json' || key.startsWith('_harness/share/') || ARCHIVE_PARTITIONS.some(partition => key.startsWith(partition));
}

/**
 * The walk as the registry sees it: counts, the unclassified files and the symbolic links. The archive's own files
 * are not counted: the walk runs before each write, and counting them would make the next walk differ from this one.
 */
export function classifyTree(root: string, entries: readonly RegistryEntry[], caseInsensitive = process.platform === 'win32'):
  { files: number; unclassified: string[]; symlinks: string[]; truncated: boolean; layers: Record<ShareLayer, number>; rightsUnknownA: number } {
  const registry = classifier(entries, caseInsensitive);
  const walked = walkProject(root, directory => registry.skipped(directory));
  const unclassified: string[] = [];
  const layers: Record<ShareLayer, number> = { A: 0, B: 0, C: 0, excluded: 0 };
  let rightsUnknownA = 0, files = 0;
  for (const path of walked.files) {
    if (harnessOwned(path)) continue;
    files++;
    const entry = registry.classify(path);
    if (!entry) { unclassified.push(path); continue; }
    layers[entry.shareLayer]++;
    if (entry.shareLayer === 'A' && entry.rights !== 'transferable') rightsUnknownA++;
  }
  return { files, unclassified, symlinks: walked.symlinks, truncated: walked.truncated, layers, rightsUnknownA };
}

/** Whether a path exists as a regular file right now (used to register only what is there). */
export function isFile(path: string): boolean { try { return lstatSync(path).isFile(); } catch { return false; } }
