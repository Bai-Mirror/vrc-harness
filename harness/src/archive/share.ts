import {archiveStageContracts} from './stage-contract.ts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statfsSync,
  statSync, utimesSync, writeFileSync, writeSync, chmodSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { sha256File } from '../file-hash.ts';
import { hostPlatform, rejectCloudSyncedPath } from '../host-platform.ts';
import { MODES_SIDECAR, ordinal, packTreeHash } from '../pack-hash.ts';
import { packageVersion } from '../provenance.ts';
import { SCHEMA_VERSION } from '../state/db.ts';
import { artifactFiles } from '../workflow/artifacts.ts';
import type { CapabilityManifest } from '../workflow/capabilities.ts';
import { ARCHIVE_MANIFEST, ARCHIVE_SCHEMA, localRoots, type ShareLayer } from './contract.ts';
import { factViews, latestFormalWorkflow } from './facts.ts';
import { packOfToolRoot } from './packs.ts';
import { archiveStatus, checkProjectArchive, type ArchiveManifest } from './projection.ts';
import { archiveSafePoint } from './refresh.ts';
import { ARCHIVE_PARTITIONS, BUILTIN_RULES, classifier, harnessOwned, storedEntries, walkProject, type RegistryEntry } from './registry.ts';
import { list7z, pack7z, sevenZip, test7z, extract7z } from './sevenzip.ts';
import { DigestCache, nameFinding, scanContext, windowsNameProblem, type FileDigest, type ScanFinding } from './share-scan.ts';
import {
  byPath, compareMembers, FILES_PATH, json, LEVEL_TEXT, MANIFEST_PATH, PACKS_PREFIX, README_PATH, safeName, SHARE_DOCS, SHARE_FILES_SCHEMA,
  SHARE_SCHEMA, SELF_NOTICE, sha256, verifyPackageTree, type MissingDependency, type PackRequirement, type ProjectPackRequirement, type ShareExclusion,
  type ShareFileEntry, type ShareFiles, type ShareLevel, type ShareManifest, type SharePurpose,
} from './share-package.ts';
import { projectRoot } from './takeover.ts';
import { guidIndex, metaPairs, referenceClosure, unitySkeleton, type MetaPairs } from './unity-check.ts';

/**
 * The share compiler (docs/project-share.md): from the classification registry, the project archive, the reference
 * closure of the registered Avatar roots and the layers a person chose, an explicit list of relative paths, each with
 * its category, source, size, SHA-256 and the reason it is in; everything left out is listed with its reason. The
 * package is then copied by that list into an isolated staging directory, packed with 7z from the list, tested,
 * compared member by member, and unpacked cold and verified before it is handed over. Nothing is ever trimmed
 * silently: what cannot go is either a blocker, or a named degradation of what the receiver can do with the package.
 */

export interface ShareOptions {
  /** Chosen for every user-facing export; direct legacy callers retain the recipient behavior. */
  purpose?: SharePurpose;
  /** Layers to include; A always. B takes every B item not in `exclude`; C items need `include`, one by one. */
  layers?: string[];
  /** Optional items chosen explicitly (every C item must be named here). */
  include?: string[];
  /** B items left out of a B selection. */
  exclude?: string[];
  /** Share only what may be transferred; the rest is listed as 接收端待补齐. */
  permittedOnly?: boolean;
  /** Paths whose sensitive findings (local paths, Blueprint IDs, the order number) a person reviewed. */
  acknowledge?: string[];
  /** The project's name in the package (the directory name the receiver gets). */
  name?: string;
  /** Who receives it: kept in this database only, never in the package. */
  recipient?: string;
  /** Output file (.7z); the default is in the first export root. Never overwritten. */
  out?: string;
  /**
   * An interactive preview that shows a plan and writes nothing: it may reuse the cached digest of a file whose size,
   * modification time and file id are unchanged. Never set this for a package, a manifest or a record -- DATA/D6
   * forbids reusing old evidence for a same-size content change, so the default re-reads the content, and
   * `exportShare` forces the default whatever a caller passes.
   */
  preview?: boolean;
}
export interface ShareProgress { phase: string; done?: number; total?: number }
export interface ShareEnvironment {
  home: string;
  /** Where a package goes when no output file is named. */
  exportRoot?: string;
  onProgress?: (progress: ShareProgress) => void;
  /** Opt-in: open the cold-unpacked project in this Unity editor (batch mode) and require it to exit cleanly. */
  unityCheck?: { editor: string; timeoutSec: number };
}
export interface ShareBlocker {
  code: string; text: string;
  paths?: string[]; count?: number;
  /** A person may review these paths and let them go (they need an acknowledgement, not a fix). */
  acknowledgeable?: boolean;
  /** Paths grouped by directory, with a count (and the files' layer), for a person to act on one group at a time. */
  groups?: Array<{ path: string; count: number; bytes: number; layer?: 'A' | 'B' | 'C' }>;
}
export interface ShareFinding { path: string; detector: string; kind: 'secret' | 'sensitive'; line: number | null; text: string; acknowledged: boolean }
export interface ShareItem { id: string; layer: 'B' | 'C'; text: string; files: number; bytes: number; included: boolean; problem?: string }
export interface SharePlan {
  projectId: string; archiveId: string | null; revision: number | null; digest: string | null; name: string; purpose: SharePurpose;
  ready: boolean;
  level: ShareLevel; levelText: string; levelReasons: string[];
  blockers: ShareBlocker[];
  warnings: string[];
  items: ShareItem[];
  included: { files: number; dirs: number; bytes: number; byLayer: Record<'A' | 'B' | 'C', { files: number; bytes: number }> };
  excluded: ShareExclusion[];
  missing: MissingDependency[];
  findings: ShareFinding[];
  required: ShareManifest['required'];
  dependencies: ShareManifest['dependencies'];
  references: ShareManifest['references'];
  metaPairs: MetaPairs;
  receiver: string[];
  selection: { layers: string[]; items: string[]; exclude: string[]; permittedOnly: boolean; acknowledge: string[] };
}
type Planned = ShareFileEntry & { absolute: string };
export interface CompiledShare { plan: SharePlan; entries: Planned[]; excluded: ShareExclusion[]; sourceProjectId: string; lineage: string[] }

const HARNESS_BLOCKERS = new Set(['projection_failed', 'projection_missing', 'projection_outdated', 'active_run', 'scan_missing']);
/** What each archive file is, for a person choosing optional items. */
const ARCHIVE_ITEM_TEXT: Record<string, string> = {
  '_harness/records/events.json': '施工事件与 Run 摘要（过程记录）',
  '_harness/optional/facts.json': '可选层的事实记录',
  '_harness/sensitive/conversation.json': '完整对话（全部项目消息）',
  '_harness/sensitive/project.json': '原始需求、订单号、人工决定的原话、Blueprint ID 与导入源名称',
  '_harness/sensitive/facts.json': '敏感层事实（账本与施工记录原文、原始需求、Blueprint ID）',
};
const RESTORE_TEXT: Record<string, string> = { vpm: '接收端按 vpm-manifest 解析', regenerate: '接收端由 Unity 或阶段重新生成', acquire: '接收端待补齐' };

export { harnessOwned };
/** The project's content at a sync point: every file of the package but the archive and what the package itself carries. */
export function syncContent(entries: Array<Pick<ShareFileEntry, 'path' | 'kind' | 'sha256'>>): Record<string, string> {
  return Object.fromEntries(entries.filter(entry => entry.kind === 'file' && entry.sha256 && !entry.path.startsWith('share/') && !harnessOwned(entry.path))
    .map(entry => [entry.path, entry.sha256!]).sort(([a], [b]) => ordinal(a!, b!)));
}

const emit = (env: ShareEnvironment, phase: string, done?: number, total?: number): void =>
  env.onProgress?.({ phase, ...(done === undefined ? {} : { done }), ...(total === undefined ? {} : { total }) });
/** The directory group a path belongs to (its first two levels), for grouping many files into what a person can act on. */
export function groupOf(path: string): string {
  const parts = path.split('/');
  return parts.length <= 2 ? path : `${parts[0]}/${parts[1]}/`;
}
function readArchiveManifest(root: string): ArchiveManifest | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(root, ...ARCHIVE_MANIFEST.split('/')), 'utf8')) as ArchiveManifest;
    return manifest?.schema === ARCHIVE_SCHEMA && Array.isArray(manifest.files) ? manifest : undefined;
  } catch { return undefined; }
}
const caseInsensitive = process.platform === 'win32';
const fold = (path: string): string => caseInsensitive ? path.toLowerCase() : path;

/** Every share id this project's state descends from: the shares it was restored from and exported as, transitively. */
export function projectLineage(db: DatabaseSync, projectId: string): string[] {
  const rows = db.prepare('SELECT share_id, lineage_json FROM project_sync WHERE project_id = ? ORDER BY seq').all(projectId) as
    Array<{ share_id: string; lineage_json: string }>;
  const ids: string[] = [];
  for (const row of rows) for (const id of [...(JSON.parse(row.lineage_json) as string[]), row.share_id]) if (!ids.includes(id)) ids.push(id);
  return ids.slice(-500);
}

/**
 * Build the explicit list and every check, without writing a package. A safe point runs first (fingerprints, scan,
 * archive write and read-back), exactly as `avh project archive`, so the list describes a consistent revision.
 */
export async function compileShare(db: DatabaseSync, env: ShareEnvironment, projectId: string, options: ShareOptions = {}): Promise<CompiledShare> {
  emit(env, 'safe-point');
  await archiveSafePoint(db, env.home, projectId);
  const root = projectRoot(db, projectId);
  const status = archiveStatus(db, projectId);
  const check = checkProjectArchive(db, projectId);
  const blockers: ShareBlocker[] = [], warnings: string[] = [];
  for (const blocker of status.shareable.blockers) if (HARNESS_BLOCKERS.has(blocker.code)) blockers.push({ code: blocker.code, text: blocker.text });
  if (check.state !== 'consistent' && !blockers.some(item => item.code.startsWith('projection') || item.code === 'active_run'))
    blockers.push({ code: 'archive_inconsistent', text: `工程档案与状态库不一致（${check.state}）：${check.problems[0] ?? '请刷新档案'}` });
  const archive = readArchiveManifest(root);
  if (!archive) blockers.push({ code: 'archive_missing', text: '工程里没有可用的档案清单（_harness/archive.json）' });
  const project = db.prepare('SELECT identity_json, workspace_id FROM project WHERE id = ?').get(projectId) as { identity_json: string; workspace_id: string };
  const identity = JSON.parse(project.identity_json) as { orderNumber?: string };
  const workspace = (db.prepare('SELECT path FROM workspace WHERE id = ?').get(project.workspace_id) as { path: string } | undefined)?.path;

  const layers = new Set((options.layers ?? ['A']).map(layer => layer.trim().toUpperCase()).filter(layer => ['A', 'B', 'C'].includes(layer)));
  layers.add('A');
  const include = new Set(options.include ?? []), exclude = new Set(options.exclude ?? []), acknowledge = new Set(options.acknowledge ?? []);
  const purpose = options.purpose ?? 'others';
  if (purpose !== 'self' && purpose !== 'others') throw new Error('必须选择本人迁移/备份或交给他人');
  if (purpose === 'self' && options.permittedOnly) throw new Error('本人迁移包包含完整工程，不使用转交权筛选');
  const permittedOnly = options.permittedOnly === true;
  const chosen = (item: string, layer: 'B' | 'C'): boolean => include.has(item) || (layer === 'B' && layers.has('B') && !exclude.has(item));

  emit(env, 'walk');
  const entries = [...BUILTIN_RULES, ...storedEntries(db, projectId)];
  const registry = classifier(entries);
  const walked = walkProject(root, directory => registry.skipped(directory));
  if (walked.truncated) blockers.push({ code: 'too_many_files', text: '工程文件超过遍历上限，无法生成完整清单' });
  const onDisk = new Set(walked.files);
  const archiveFiles = new Map((archive?.files ?? []).map(file => [fold(file.path), file]));

  const planned: Planned[] = [];
  const excluded = new Map<string, ShareExclusion>();
  const exclude_ = (key: string, path: string, bytes: number, reason: string, restore: string | null): void => {
    const prior = excluded.get(key);
    if (prior) { prior.count++; prior.bytes += bytes; return; }
    excluded.set(key, { path, count: 1, bytes, reason, restore });
  };
  const items = new Map<string, ShareItem>();
  const unclassified: string[] = [], rightsProblems: Array<{ path: string; bytes: number; rights: string; layer: 'A' | 'B' | 'C' }> = [];
  const missing: Array<{ path: string; bytes: number }> = [], reserved: string[] = [];
  const size = (path: string): number => { try { return statSync(join(root, ...path.split('/'))).size; } catch { return 0; } };

  for (const path of walked.files) {
    const bytes = size(path);
    if (path.split('/')[0]!.toLowerCase() === 'share') { reserved.push(path); continue; }
    if (fold(path).startsWith('_harness/share/')) { exclude_('_harness/share/', '_harness/share/', bytes, '分享方案与恢复对账按收件人保存在本机，不随分享包转交', null); continue; }
    const entry = registry.classify(path);
    if (!entry) { unclassified.push(path); continue; }
    if (entry.shareLayer === 'excluded') {
      const key = entry.match === 'tree' ? entry.path : path;
      exclude_(key, key, bytes, entry.reason, entry.restore ?? null);
      continue;
    }
    const archiveFile = archiveFiles.get(fold(path));
    if (!archiveFile && ARCHIVE_PARTITIONS.some(partition => fold(path).startsWith(partition))) {
      exclude_(path, path, bytes, '不属于当前工程档案修订的旧文件', null);
      continue;
    }
    // The archive's own files go by the manifest: its layer, and its spelling (Windows may hold them in a folder
    // another tool created with other capitals).
    const layer = (archiveFile?.layer ?? entry.shareLayer) as 'A' | 'B' | 'C';
    const packagePath = archiveFile?.path ?? path;
    const item = layer === 'A' ? undefined : archiveFile ? `${layer}:${archiveFile.path}` : `${layer}:${entry.path}`;
    if (item) {
      const record = items.get(item) ?? { id: item, layer: layer as 'B' | 'C', text: archiveFile ? ARCHIVE_ITEM_TEXT[archiveFile.path] ?? archiveFile.path
        : `${entry.reason}（${entry.path}）`, files: 0, bytes: 0, included: chosen(item, layer as 'B' | 'C') };
      record.files++; record.bytes += bytes;
      items.set(item, record);
      if (!record.included) {
        exclude_(`item:${item}`, entry.match === 'tree' || archiveFile ? (archiveFile?.path ?? entry.path) : path, bytes,
          layer === 'C' ? '可选敏感内容：没有逐项选择' : '可选非敏感内容：没有选择', null);
        continue;
      }
    }
    if (purpose === 'others' && !archiveFile && entry.rights !== 'transferable') {
      if (!permittedOnly) { rightsProblems.push({ path, bytes, rights: entry.rights, layer }); continue; }
      if (layer === 'A') { missing.push({ path, bytes }); exclude_(path, path, bytes, `转交权${entry.rights === 'not_transferable' ? '不允许' : '未确认'}：接收端待补齐`, 'acquire'); }
      else exclude_(path, path, bytes, `转交权${entry.rights === 'not_transferable' ? '不允许' : '未确认'}：可选内容不随包`, null);
      if (item) items.get(item)!.problem = '部分文件转交权不允许或未确认';
      continue;
    }
    planned.push({ path: packagePath, absolute: join(root, ...path.split('/')), kind: 'file', layer, category: archiveFile ? `archive-${archiveFile.partition}` : entry.category,
      source: archiveFile ? { type: 'archive', ref: ARCHIVE_MANIFEST } : entry.source, size: bytes, sha256: null, crc32: null,
      reason: archiveFile ? `工程档案 ${archiveFile.partition} 分区（${layer} 层）` : entry.reason, ...(item ? { item } : {}) });
  }
  if (reserved.length) blockers.push({ code: 'reserved_share', text: '工程根目录的 share/ 与分享包的说明目录重名：先改名或移出工程', paths: reserved.slice(0, 20), count: reserved.length });
  // Groups keep the strictest layer of their files, so a person's registration of the group keeps it where it was.
  const group = (list: Array<{ path: string; bytes: number; layer?: 'A' | 'B' | 'C' }>) => [...list.reduce((map, item) => {
    const key = groupOf(item.path), prior = map.get(key) ?? { path: key, count: 0, bytes: 0, ...(item.layer ? { layer: item.layer } : {}) };
    prior.count++; prior.bytes += item.bytes;
    if (item.layer && (!prior.layer || item.layer < prior.layer)) prior.layer = item.layer;
    return map.set(key, prior);
  }, new Map<string, { path: string; count: number; bytes: number; layer?: 'A' | 'B' | 'C' }>()).values()].sort(byPath);
  if (unclassified.length) blockers.push({ code: 'unclassified', text: `${unclassified.length} 个文件还没有登记（待分类）：先归类再分享，不会按目录名推断`,
    count: unclassified.length, paths: unclassified.slice(0, 50), groups: group(unclassified.map(path => ({ path, bytes: size(path) }))) });
  if (rightsProblems.length) blockers.push({ code: 'rights', text: `${rightsProblems.length} 个文件的转交权不允许或未确认：确认转交权，或选择只分享获准内容`,
    count: rightsProblems.length, paths: rightsProblems.slice(0, 50).map(item => item.path), groups: group(rightsProblems) });
  const links = walked.symlinks.filter(path => registry.classify(path)?.shareLayer !== 'excluded');
  if (links.length) blockers.push({ code: 'symlinks', text: `${links.length} 个符号链接或目录联接：分享包不收链接，请换成实际文件或移出工程`, paths: links.slice(0, 50), count: links.length });

  // Project candidate packs: a draft in the project travels with the project; registered content that exists only in
  // this machine's candidate store travels in the package, checked against its registered hash.
  const workflows = db.prepare(`SELECT w.id, w.status, w.knowledge_version, d.tool_root, d.capabilities_json FROM workflow w
    JOIN workflow_definition d ON d.workflow_id = w.id WHERE w.project_id = ? ORDER BY w.rowid`).all(projectId) as
    Array<{ id: string; status: string; knowledge_version: string; tool_root: string; capabilities_json: string }>;
  const latest = latestFormalWorkflow(db, projectId);
  const projectPacks: ProjectPackRequirement[] = [];
  const candidateRows = db.prepare(`SELECT c.id, c.version, c.root, c.content_hash FROM managed_pack_candidate c WHERE c.id IN (
    SELECT candidate_id FROM managed_pack_authoring WHERE project_id = ? UNION SELECT candidate_id FROM managed_pack_trial WHERE project_id = ?)
    ORDER BY c.id`).all(projectId, projectId) as Array<{ id: string; version: string; root: string; content_hash: string }>;
  const unavailablePacks: string[] = [];
  for (const candidate of candidateRows) {
    const usedBy = workflows.filter(row => row.knowledge_version.startsWith(`candidate:${candidate.id}:`)).map(row => row.id);
    const draftRow = db.prepare('SELECT source_root FROM managed_pack_authoring WHERE candidate_id = ? AND project_id = ?').get(candidate.id, projectId) as
      { source_root: string } | undefined;
    let draftHash: string | undefined;
    try { if (draftRow && hostPlatform.within(root, draftRow.source_root) && existsSync(draftRow.source_root)) draftHash = packTreeHash(draftRow.source_root).hash; }
    catch { draftHash = undefined; }
    if (draftHash === candidate.content_hash && draftRow) {
      const rel = hostPlatform.relativePosix(root, draftRow.source_root);
      // The draft's hash covers its executable bits: they travel in the list, as they do for a pack from the store.
      const modes = packModes(draftRow.source_root), prefix = fold(`${rel}/`);
      for (const file of planned) {
        const mode = fold(file.path).startsWith(prefix) ? modes[file.path.slice(prefix.length)] : undefined;
        if (mode) file.mode = mode;
      }
      projectPacks.push({ id: candidate.id, version: candidate.version, contentHash: candidate.content_hash, from: `${rel}/`, usedBy });
      continue;
    }
    let storeHash: string | undefined;
    try { if (existsSync(candidate.root)) storeHash = packTreeHash(candidate.root).hash; } catch { storeHash = undefined; }
    if (storeHash !== candidate.content_hash) {
      unavailablePacks.push(candidate.id);
      warnings.push(`本项目候选能力包 ${candidate.id} 的登记内容在本机已不可用，不能随包提供`);
      continue;
    }
    const from = `${PACKS_PREFIX}${safeName(candidate.id)}/`;
    const modes = packModes(candidate.root);
    for (const rel of treeFiles(candidate.root)) {
      const absolute = join(candidate.root, ...rel.split('/'));
      planned.push({ path: `${from}${rel}`, absolute, kind: 'file', layer: 'A', category: 'project-pack', source: { type: 'local-store', ref: `managed-pack-candidate:${candidate.id}` },
        size: statSync(absolute).size, sha256: null, crc32: null, reason: `本项目候选能力包 ${candidate.id} 的登记内容（按内容哈希重验）`,
        ...(modes[rel] ? { mode: modes[rel] } : {}) });
    }
    projectPacks.push({ id: candidate.id, version: candidate.version, contentHash: candidate.content_hash, from, usedBy });
  }

  // .meta companions stay together: an asset whose .meta cannot go does not go either (and the reverse).
  const byPackagePath = new Map(planned.map(file => [file.path, file]));
  const drop = (file: Planned, reason: string): void => {
    byPackagePath.delete(file.path);
    if (file.layer === 'A') missing.push({ path: file.path, bytes: file.size });
    exclude_(file.path, file.path, file.size, reason, file.layer === 'A' ? 'acquire' : null);
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const file of [...byPackagePath.values()]) {
      if (file.path.startsWith(PACKS_PREFIX)) continue;
      if (file.path.endsWith('.meta')) {
        const asset = file.path.slice(0, -'.meta'.length);
        if (onDisk.has(asset) && !byPackagePath.has(asset)) { drop(file, '它对应的资源没有纳入，.meta 不单独分享'); changed = true; }
      } else if (onDisk.has(`${file.path}.meta`) && !byPackagePath.has(`${file.path}.meta`)) { drop(file, '它的 .meta 没有纳入：资源不单独分享'); changed = true; }
    }
  }
  // A folder whose .meta goes and whose files do not keeps its GUID as an empty folder.
  const dirs: Planned[] = [];
  const withFiles = new Set<string>();
  for (const path of byPackagePath.keys()) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) withFiles.add(parts.slice(0, i).join('/')); }
  const hasFileUnder = (dir: string): boolean => withFiles.has(dir);
  for (const file of byPackagePath.values()) {
    if (!file.path.endsWith('.meta')) continue;
    const dir = file.path.slice(0, -'.meta'.length);
    let isDir = false;
    try { isDir = lstatSync(join(root, ...dir.split('/'))).isDirectory(); } catch { isDir = false; }
    if (isDir && !hasFileUnder(dir)) dirs.push({ path: `${dir}/`, absolute: join(root, ...dir.split('/')), kind: 'dir', layer: file.layer, category: 'unity-folder',
      source: file.source, size: 0, sha256: null, crc32: null, reason: '保留文件夹及其 .meta（GUID）' });
  }
  const included = [...byPackagePath.values()];

  // Paths two file systems would not keep apart, or that Windows cannot create.
  const folded = new Map<string, string>(), collisions: string[] = [], badNames: string[] = [];
  for (const file of [...included, ...dirs]) {
    const key = file.path.toLowerCase(), prior = folded.get(key);
    if (prior !== undefined && prior !== file.path) collisions.push(`${prior} 与 ${file.path}`);
    folded.set(key, file.path);
    const problem = windowsNameProblem(file.path);
    if (problem) badNames.push(`${file.path}：${problem}`);
  }
  if (collisions.length) blockers.push({ code: 'case_collision', text: '有只是大小写不同的路径，Windows 上无法同时存在：先改名', paths: collisions.slice(0, 20), count: collisions.length });
  if (badNames.length) blockers.push({ code: 'windows_names', text: '有 Windows 上无法创建的文件名：先改名', paths: badNames.slice(0, 20), count: badNames.length });

  // Read every file once: size, SHA-256, CRC32 and the content detectors.
  const context = scanContext(env.home, localRoots(root, [...(workspace ? [{ path: workspace, label: '<工作区>' }] : []),
    { path: env.home, label: '<AVH_HOME>' }]), identity.orderNumber);
  const cache = new DigestCache(env.home, projectId, context);
  const findings: ShareFinding[] = [];
  const sensitivity = (file: Planned): string => file.source.type === 'archive'
    ? (file.layer === 'C' ? 'sensitive' : 'normal') : registry.classify(file.path)?.sensitivity ?? 'normal';
  let done = 0, restated = 0;
  for (const file of included) {
    emit(env, 'digest', done++, included.length);
    let digest: FileDigest;
    if (options.preview === true) digest = cache.digest(file.path, file.absolute);
    else {
      // Anything that may be kept as evidence reads the content: the size+mtime key is a hint, never the answer.
      const checked = cache.verified(file.path, file.absolute);
      if (checked.stale) restated++;
      digest = checked.digest;
    }
    Object.assign(file, { size: digest.size, sha256: digest.sha256, crc32: digest.crc32 });
    const named = nameFinding(file.path);
    for (const finding of [...(named ? [named] : []), ...digest.findings] as ScanFinding[]) {
      // A sensitive item the person chose one by one is shared knowingly; a credential never is.
      const known = finding.kind === 'sensitive' && file.layer === 'C' && sensitivity(file) === 'sensitive';
      findings.push({ path: file.path, detector: finding.detector, kind: finding.kind, line: finding.line, text: finding.text,
        acknowledged: finding.kind === 'sensitive' && (known || acknowledge.has(file.path)) });
    }
  }
  emit(env, 'digest', done, included.length);
  cache.save();
  if (restated) warnings.push(`${restated} 个文件的大小与修改时间没有变，内容却与上次扫描不同：已按内容重新扫描，缓存不决定清单`);
  const secrets = findings.filter(item => item.kind === 'secret');
  if (secrets.length) blockers.push({ code: 'secrets', text: `${new Set(secrets.map(item => item.path)).size} 个文件含凭据、访问令牌、私钥或登录态：这类内容永远不能分享，先移除或改写`,
    paths: [...new Set(secrets.map(item => `${item.path}${item.line ? `:${item.line}` : ''}（${item.text}）`))].slice(0, 50) });
  const review = findings.filter(item => item.kind === 'sensitive' && !item.acknowledged);
  if (review.length) blockers.push({ code: 'needs_review', acknowledgeable: true,
    text: `${new Set(review.map(item => item.path)).size} 个文件含本机路径、Blueprint ID 或订单号：请逐个检查，确认可以交给对方后再分享`,
    paths: [...new Set(review.map(item => item.path))].slice(0, 100) });

  // The reference closure of the registered roots: what the scenes need, and where it is.
  const seeds = (db.prepare(`SELECT DISTINCT scene_path FROM avatar_root WHERE project_id = ? AND scene_path <> '' ORDER BY scene_path`).all(projectId) as
    Array<{ scene_path: string }>).map(row => row.scene_path).filter(path => onDisk.has(path));
  const index = guidIndex(root, walked.files);
  const closure = referenceClosure(root, seeds, index, path => onDisk.has(path));
  const inPackage = new Set([...included.map(file => file.path), ...dirs.map(dir => dir.path.slice(0, -1))]);
  const external: Record<string, string> = {}, referencedMissing = new Set<string>();
  for (const reference of closure.references) {
    if (reference.to && inPackage.has(reference.to)) continue;
    if (!reference.to) { external[reference.guid] = 'absent'; continue; }
    const entry = registry.classify(reference.to);
    if (entry?.restore === 'vpm') external[reference.guid] = `vpm:${reference.to.split('/')[1]}`;
    else if (entry?.restore === 'regenerate') external[reference.guid] = `regenerate:${reference.to}`;
    else { external[reference.guid] = `missing:${reference.to}`; referencedMissing.add(reference.to); }
  }
  const absent = closure.references.filter(reference => !reference.to);
  if (absent.length) warnings.push(`头像根引用的 ${new Set(absent.map(item => item.guid)).size} 个资源在工程里本来就不存在（发送端就缺）`);
  if (closure.unread.length) warnings.push(`${closure.unread.length} 个场景或资源不是文本序列化，未检查其中的引用：${closure.unread.slice(0, 3).join('、')}`);
  if (!seeds.length) warnings.push('没有登记头像根的场景，未做引用检查');

  // .meta pairs: the package may not be worse than the project.
  const source = metaPairs(walked.files.filter(path => registry.classify(path)?.shareLayer !== 'excluded'));
  const packagePairs = metaPairs(included.filter(file => !file.path.startsWith(PACKS_PREFIX)).map(file => file.path), dirs.map(dir => dir.path));
  const introduced = [...packagePairs.missingMeta.filter(path => !source.missingMeta.includes(path)),
    ...packagePairs.orphanMeta.filter(path => !source.orphanMeta.includes(path))];
  if (introduced.length) warnings.push(`分享会让 ${introduced.length} 个 .meta 配对不完整：${introduced.slice(0, 3).join('、')}`);
  if (source.missingMeta.length || source.orphanMeta.length)
    warnings.push(`工程本身有 ${source.missingMeta.length} 个资源缺少 .meta、${source.orphanMeta.length} 个 .meta 没有资源`);

  // What the project needs to go on, and whether the package has it.
  const skeletonSource = unitySkeleton(walked.files), skeletonPackage = unitySkeleton(inPackage);
  const required: ShareManifest['required'] = [];
  required.push(!skeletonSource.unity ? { id: 'unity-project', text: 'Unity 工程主体', status: 'not_applicable', detail: '工程还没有建立 Unity 工程' }
    : skeletonPackage.unity && !skeletonPackage.missing.length ? { id: 'unity-project', text: 'Unity 工程主体（Assets、Packages、ProjectSettings 与 .meta）', status: 'included' }
      : { id: 'unity-project', text: 'Unity 工程主体', status: 'missing', detail: `缺少 ${[...(skeletonPackage.unity ? [] : ['ProjectSettings/ProjectVersion.txt']), ...skeletonPackage.missing].join('、')}` });
  const archiveA = (archive?.files ?? []).filter(file => file.layer === 'A');
  const archiveIncluded = archiveA.every(file => inPackage.has(file.path));
  required.push({ id: 'archive', text: '工程档案 A 层（事实、决定、证据索引、恢复信息）', status: archive && archiveIncluded ? 'included' : 'missing' });
  let artifactMembers: string[] = [];
  if (latest) {
    const capabilities = JSON.parse(workflows.find(row => row.id === latest.id)?.capabilities_json ?? '{}') as CapabilityManifest;
    for (const spec of Object.values(capabilities.artifacts ?? {})) {
      if (spec.includeIgnored) continue;
      try { artifactMembers.push(...artifactFiles(root, spec)); } catch { /* not a Git work tree: the scan registered nothing either */ }
    }
    artifactMembers = [...new Set(artifactMembers)];
    const out = artifactMembers.filter(path => !inPackage.has(path) && !archiveFiles.has(fold(path)));
    required.push(!artifactMembers.length ? { id: 'workflow-artifacts', text: '制作流程的产物', status: 'not_applicable' }
      : out.length ? { id: 'workflow-artifacts', text: '制作流程的产物', status: 'partial', detail: `${out.length} 个成员未纳入：相关检查与批准在接收端会失效` }
        : { id: 'workflow-artifacts', text: '制作流程的产物', status: 'included' });
  }
  const livePackMissing = latest && workflows.some(row => row.id === latest.id && row.knowledge_version.startsWith('candidate:')
    && unavailablePacks.some(id => row.knowledge_version.startsWith(`candidate:${id}:`)));
  required.push(!candidateRows.length ? { id: 'project-packs', text: '本项目候选能力包', status: 'not_applicable' }
    : unavailablePacks.length ? { id: 'project-packs', text: '本项目候选能力包', status: livePackMissing ? 'missing' : 'partial', detail: `不可用：${unavailablePacks.join('、')}` }
      : { id: 'project-packs', text: '本项目候选能力包', status: 'included' });

  const current = factViews(db, projectId).filter(fact => fact.objectId === 'project');
  const fact = (attribute: string) => current.find(item => item.attribute === attribute && ['observed', 'user_confirmed'].includes(item.effectiveStatus))?.value;
  const vpm = (fact('vpm.locked') && typeof fact('vpm.locked') === 'object' ? fact('vpm.locked') : {}) as Record<string, string>;
  const packs: PackRequirement[] = workflows.map(row => {
    const pack = packOfToolRoot(row.tool_root);
    return { workflowId: row.id, current: row.id === latest?.id, status: row.status, id: pack?.id ?? null, version: pack?.version ?? null,
      channel: pack?.channel ?? null, contentHash: pack?.contentHash ?? null };
  });
  for(const contract of archiveStageContracts(db,projectId,value=>value)) {
    const workflow=workflows.find(row=>row.id===contract.workflowId);
    packs.push({workflowId:contract.workflowId,current:contract.workflowId===latest?.id,status:workflow?.status??'active',
      selectionSeq:contract.seq,stageId:contract.stageId,id:contract.pack?.id??null,version:contract.pack?.version??null,channel:contract.pack?.channel??null,contentHash:contract.pack?.contentHash??null});
  }
  const missingGroups: MissingDependency[] = group(missing).map(item => ({ ...item,
    text: `${item.path}：${item.count} 个文件未随包提供（转交权不允许或未确认），接收端需自行取得` }));
  if (referencedMissing.size) warnings.push(`头像根引用的 ${referencedMissing.size} 个资源没有随包提供：${[...referencedMissing].slice(0, 3).join('、')}`);

  // How far the receiver gets with this package.
  const levelReasons: string[] = [];
  for (const item of required) if (item.status === 'missing') levelReasons.push(`${item.text}：${item.detail ?? '缺失'}`);
  const observeOnly = levelReasons.length > 0;
  if (!observeOnly) {
    for (const item of required) if (item.status === 'partial') levelReasons.push(`${item.text}：${item.detail}`);
    if (missingGroups.length) levelReasons.push(`${missing.length} 个文件接收端待补齐`);
    if (referencedMissing.size) levelReasons.push(`头像根引用的 ${referencedMissing.size} 个资源未随包提供`);
  }
  const level: ShareLevel = observeOnly ? 'observe_only' : levelReasons.length ? 'needs_dependencies' : 'continuable';

  const receiver: string[] = [purpose === 'self' ? SELF_NOTICE : '交给他人的工程包',
    '用同版 Harness 恢复：avh project restore <分享包>，或在项目页选择“从分享包恢复”'];
  const unityVersion = (fact('unity.version') as string | undefined) ?? null;
  if (unityVersion) receiver.push(`用 Unity ${unityVersion} 打开`);
  if (Object.keys(vpm).length) receiver.push(`解析 VPM 依赖（Harness 恢复后可代为执行）：${Object.entries(vpm).map(([id, version]) => `${id} ${version}`).join('、')}`);
  for (const pack of packs.filter(item => item.current && item.id)) receiver.push(`${pack.selectionSeq?'已采用的修复包':'能力包'} ${pack.id} ${pack.version}：同版 Harness 自带或从 Harness 服务器安装`);
  if (projectPacks.length) receiver.push(`本项目候选能力包（${projectPacks.map(item => item.id).join('、')}）恢复为候选，需要在接收端重新评测并批准试用`);
  if (missingGroups.length) receiver.push(`补齐 ${missing.length} 个未随包提供的文件（见 share/files.json 的 excluded）`);

  const name = safeName(options.name?.trim() || (identity.orderNumber && basename(root).includes(identity.orderNumber)
    && !include.has('C:_harness/sensitive/project.json') ? `project-${(archive?.archiveId ?? projectId).slice(0, 8)}` : basename(root)));
  const byLayer = { A: { files: 0, bytes: 0 }, B: { files: 0, bytes: 0 }, C: { files: 0, bytes: 0 } };
  for (const file of included) { byLayer[file.layer].files++; byLayer[file.layer].bytes += file.size; }
  const exclusions = [...excluded.values()].map(item => ({ ...item, path: item.path })).sort(byPath);
  const plan: SharePlan = {
    projectId, archiveId: archive?.archiveId ?? null, revision: archive?.revision ?? null, digest: archive?.digest ?? null, name, purpose,
    ready: blockers.length === 0, level, levelText: LEVEL_TEXT[level], levelReasons, blockers, warnings,
    items: [...items.values()].sort((a, b) => ordinal(a.id, b.id)),
    included: { files: included.length, dirs: dirs.length, bytes: included.reduce((sum, file) => sum + file.size, 0), byLayer },
    excluded: exclusions, missing: missingGroups, findings,
    required, dependencies: { unity: unityVersion, vpm, packs, projectPacks, missing: missingGroups },
    references: { seeds, checked: closure.visited, external, unread: closure.unread }, metaPairs: packagePairs, receiver,
    selection: { layers: [...layers].sort(), items: [...items.values()].filter(item => item.included).map(item => item.id).sort(ordinal),
      exclude: [...exclude].sort(ordinal), permittedOnly, acknowledge: [...acknowledge].sort(ordinal) },
  };
  return { plan, entries: [...included, ...dirs].sort(byPath), excluded: exclusions, sourceProjectId: projectId, lineage: projectLineage(db, projectId) };
}

/** Relative paths of every file under a pack tree. */
function treeFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => ordinal(a.name, b.name))) {
      if (entry.isDirectory()) visit(join(directory, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
    }
  };
  visit(root, '');
  return out;
}
/** Executable files of a pack tree: from the file system on POSIX, from the modes sidecar on Windows. */
function packModes(root: string): Record<string, number> {
  if (process.platform === 'win32') {
    try { return JSON.parse(readFileSync(`${root}${MODES_SIDECAR}`, 'utf8')) as Record<string, number>; } catch { return {}; }
  }
  return Object.fromEntries(treeFiles(root).filter(rel => statSync(join(root, ...rel.split('/'))).mode & 0o111).map(rel => [rel, 0o755]));
}

/** The content list a package carries: the entries without local paths, and every exclusion with its reason. */
export function shareFilesDocument(compiled: CompiledShare): ShareFiles {
  return { schema: SHARE_FILES_SCHEMA, entries: compiled.entries.map(({ absolute: _absolute, ...entry }) => entry), excluded: compiled.excluded };
}

export interface ShareResult {
  status: 'blocked' | 'exported';
  plan: SharePlan;
  shareId?: string;
  package?: { path: string; bytes: number; sha256: string; members: number; test: string; cold: { files: number; bytes: number; archiveFiles: number;
    references: number }; unity?: { ok: boolean; detail: string } };
}

const FIXED_TIME = new Date('2000-01-01T00:00:00Z');
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Rename, retrying briefly where Windows refuses while a scanner still has the file open. */
export function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      if (attempt >= 20 || !RETRYABLE.has((error as { code?: string }).code ?? '')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * Math.min(attempt + 1, 5));
    }
  }
}
/**
 * Copy one file and prove the copy is the content that was listed. The list was read from the content before the copy
 * (`DigestCache.verified`), so a mismatch here means the file changed after it was listed -- the package is abandoned
 * rather than handed over with bytes nobody scanned.
 */
function copyVerified(source: string, target: string, expected: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const input = openSync(source, 'r'), output = openSync(target, 'wx');
  try {
    for (let read = readSync(input, buffer, 0, buffer.length, null); read > 0; read = readSync(input, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, read));
      writeSync(output, buffer, 0, read);
    }
  } finally { closeSync(input); closeSync(output); }
  if (hash.digest('hex') !== expected) throw new Error(`文件在导出过程中被改动：${source}`);
}

/** Default package name in the export root: the project, its revision and the local time. */
function defaultOutput(env: ShareEnvironment, plan: SharePlan): string {
  const now = new Date(), pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const directory = env.exportRoot ?? join(env.home, 'exports');
  let path = join(directory, `${plan.name}-${plan.purpose}-r${plan.revision ?? 0}-${stamp}.7z`);
  for (let i = 2; existsSync(path); i++) path = join(directory, `${plan.name}-${plan.purpose}-r${plan.revision ?? 0}-${stamp}-${i}.7z`);
  return path;
}

/**
 * Compile, and when nothing blocks, write the package: copy by the list into an isolated staging directory, pack from
 * the list, `7z t`, compare members with the list, unpack cold into a clean directory and verify it, then move the
 * package into place and record the export. A package that fails any step is removed, never handed over.
 */
export async function exportShare(db: DatabaseSync, env: ShareEnvironment, projectId: string, options: ShareOptions = {}): Promise<ShareResult> {
  const zip = sevenZip();
  // A package is evidence, so its list is always read from the content; a caller's preview flag stops here.
  const compiled = await compileShare(db, env, projectId, { ...options, preview: false });
  const plan = compiled.plan;
  if ('problem' in zip) plan.blockers.push({ code: 'no_7zip', text: zip.problem });
  plan.ready = plan.blockers.length === 0;
  if (!plan.ready || 'problem' in zip) return { status: 'blocked', plan };
  const out = resolve(options.out ?? defaultOutput(env, plan));
  if (!/\.7z$/i.test(out)) throw new Error('分享包文件名应以 .7z 结尾');
  if (existsSync(out)) throw new Error(`目标文件已存在，不会覆盖：${out}`);
  mkdirSync(dirname(out), { recursive: true });
  rejectCloudSyncedPath(dirname(out));
  const need = plan.included.bytes * 2 + 64 * 1024 * 1024;
  try {
    const space = statfsSync(dirname(out));
    if (space.bavail * space.bsize < need) throw new Error(`输出位置剩余空间不足：需要约 ${Math.ceil(need / 1024 ** 3)} GB`);
  } catch (error) { if ((error as Error).message.startsWith('输出位置')) throw error; }

  const shareId = randomUUID();
  const work = join(dirname(out), `.harness-share-${shareId.slice(0, 8)}`);
  const stage = join(work, 'stage'), cold = join(work, 'cold'), temporary = join(work, 'package.7z');
  mkdirSync(stage, { recursive: true });
  try {
    let done = 0;
    for (const entry of compiled.entries) {
      emit(env, 'copy', done++, compiled.entries.length);
      const target = join(stage, ...entry.path.replace(/\/$/, '').split('/'));
      if (entry.kind === 'dir') { mkdirSync(target, { recursive: true }); continue; }
      copyVerified(entry.absolute, target, entry.sha256!);
      if (entry.mode === 0o755 && process.platform !== 'win32') chmodSync(target, 0o755);
      utimesSync(target, FIXED_TIME, FIXED_TIME);
    }
    const files = shareFilesDocument(compiled);
    const filesText = json(files);
    const archive = readArchiveManifest(projectRoot(db, projectId))!;
    const manifest: ShareManifest = {
      schema: SHARE_SCHEMA, shareId, createdAt: new Date().toISOString(), purpose: plan.purpose,
      producer: { name: 'harness', version: packageVersion(), stateSchema: SCHEMA_VERSION, archiveSchema: ARCHIVE_SCHEMA, sevenZip: zip.version },
      project: { name: plan.name, archiveId: plan.archiveId!, revision: plan.revision!, digest: plan.digest!, sourceProjectId: compiled.sourceProjectId,
        lineage: compiled.lineage },
      selection: { layers: plan.selection.layers, items: plan.selection.items, permittedOnly: plan.selection.permittedOnly },
      level: plan.level, levelText: plan.levelText, levelReasons: plan.levelReasons,
      required: plan.required,
      optional: plan.items.map(item => ({ id: item.id, layer: item.layer, text: item.text, included: item.included, files: item.files, bytes: item.bytes })),
      dependencies: plan.dependencies, references: plan.references,
      integrity: { files: plan.included.files, dirs: plan.included.dirs, bytes: plan.included.bytes, filesSha256: sha256(filesText), metaPairs: plan.metaPairs,
        archive: { manifest: ARCHIVE_MANIFEST, revision: archive.revision, digest: archive.digest, files: archive.files.length } },
      receiver: plan.receiver,
    };
    mkdirSync(join(stage, 'share'), { recursive: true });
    writeFileSync(join(stage, ...FILES_PATH.split('/')), filesText);
    writeFileSync(join(stage, ...MANIFEST_PATH.split('/')), json(manifest));
    writeFileSync(join(stage, ...README_PATH.split('/')), restoreReadme(manifest, files));
    for (const doc of SHARE_DOCS) utimesSync(join(stage, ...doc.split('/')), FIXED_TIME, FIXED_TIME);

    emit(env, 'pack');
    const members = [...compiled.entries.map(entry => entry.path.replace(/\/$/, '')), ...SHARE_DOCS].sort(ordinal);
    pack7z(temporary, stage, members, join(work, 'members.txt'));
    emit(env, 'test');
    const tested = test7z(temporary);
    if (!tested.ok) throw new Error(`7z 完整性测试未通过：${tested.detail}`);
    const listed = list7z(temporary);
    const mismatch = compareMembers(listed, files);
    if (mismatch.length) throw new Error(`压缩包成员与清单不一致：${mismatch.slice(0, 5).join('；')}`);
    rmSync(stage, { recursive: true, force: true });

    emit(env, 'verify');
    mkdirSync(cold);
    extract7z(temporary, cold);
    const verified = verifyPackageTree(cold, manifest, files, filesText);
    if (verified.problems.length) throw new Error(`冷解包校验未通过：${verified.problems.slice(0, 5).join('；')}`);
    let unity: { ok: boolean; detail: string } | undefined;
    if (env.unityCheck) {
      unity = unityOpenCheck(env.unityCheck, cold, join(work, 'unity.log'));
      if (!unity.ok) throw new Error(`Unity 打开检查未通过：${unity.detail}`);
    }
    rmSync(cold, { recursive: true, force: true });

    renameRetrying(temporary, out);
    const packageSha = sha256File(out), bytes = statSync(out).size;
    const report = { ...plan, shareId, package: { path: out, bytes, sha256: packageSha } };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`INSERT INTO project_share (id, project_id, archive_id, revision, digest, level, selection_json, output, package_sha256, package_bytes,
        files_sha256, report_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(shareId, projectId, manifest.project.archiveId, manifest.project.revision,
        manifest.project.digest, plan.level, JSON.stringify({ ...plan.selection, ...(options.recipient?.trim() ? { recipient: options.recipient.trim() } : {}) }),
        out, packageSha, bytes, manifest.integrity.filesSha256, JSON.stringify(report));
      db.prepare(`INSERT INTO project_sync (project_id, share_id, direction, revision, digest, lineage_json, content_json) VALUES (?, ?, 'export', ?, ?, ?, ?)`)
        .run(projectId, shareId, manifest.project.revision, manifest.project.digest, JSON.stringify(compiled.lineage), JSON.stringify(syncContent(compiled.entries)));
      db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json) VALUES (NULL, 'runtime', 'project_share', ?, 'exported', ?, ?)`)
        .run(shareId, `导出分享包：${LEVEL_TEXT[plan.level]}`, JSON.stringify({ projectId, revision: manifest.project.revision, level: plan.level,
          files: plan.included.files, bytes: plan.included.bytes, layers: plan.selection.layers, items: plan.selection.items }));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { status: 'exported', plan, shareId, package: { path: out, bytes, sha256: packageSha, members: listed.length, test: tested.detail,
      cold: { files: verified.checked.files, bytes: verified.checked.bytes, archiveFiles: verified.checked.archiveFiles, references: verified.checked.references },
      ...(unity ? { unity } : {}) } };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** Opt-in: open the unpacked project in Unity's batch mode and require a clean exit. */
function unityOpenCheck(unity: { editor: string; timeoutSec: number }, project: string, log: string): { ok: boolean; detail: string } {
  const result = spawnSync(unity.editor, ['-batchmode', '-nographics', '-quit', '-projectPath', project, '-logFile', log],
    { timeout: unity.timeoutSec * 1000, windowsHide: true, encoding: 'utf8' });
  let tail = '';
  try { tail = readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-5).join('；'); } catch { tail = ''; }
  if (result.error) return { ok: false, detail: `无法启动 Unity：${result.error.message}` };
  return result.status === 0 ? { ok: true, detail: 'Unity 在批处理模式下打开并正常退出' }
    : { ok: false, detail: `Unity 退出码 ${result.status}${tail ? `：${tail}` : ''}（常见原因：VPM 依赖尚未解析）` };
}

const megabytes = (bytes: number): string => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
/** 恢复说明.md: what the package is and how to go on, readable without Harness. */
export function restoreReadme(manifest: ShareManifest, files: ShareFiles): string {
  const lines = [
    `# ${manifest.project.name}：${manifest.purpose === 'self' ? '本人迁移/备份包' : '可继续制作的工程分享包'}`, '',
    `- 用途：**${manifest.purpose === 'self' ? SELF_NOTICE : '交给他人'}**`,
    `- 状态：**${manifest.levelText}**${manifest.levelReasons.length ? `（${manifest.levelReasons.join('；')}）` : ''}`,
    `- 工程档案：修订 ${manifest.project.revision}，摘要 ${manifest.project.digest.slice(0, 12)}；分享包 ${manifest.shareId}`,
    `- 制作：Harness ${manifest.producer.version}（状态库 schema ${manifest.producer.stateSchema}），7-Zip ${manifest.producer.sevenZip}，${manifest.createdAt}`,
    `- 内容：${manifest.integrity.files} 个文件，共 ${megabytes(manifest.integrity.bytes)}；逐个文件的大小与 SHA-256 见 share/files.json`,
    '', '## 用 Harness 继续', '',
    '同版 Harness：`avh project restore <本文件所在的 .7z>`，或在 Harness 的项目页选择“从分享包恢复”。恢复会先校验全部内容，再建立项目；不会覆盖本机已有的工作。',
    '', '## 不用 Harness 时', '',
    '- Unity 工程在压缩包根目录：`Assets/`、`Packages/`、`ProjectSettings/`（每个资源都有对应的 `.meta`）。',
    ...(manifest.dependencies.unity ? [`- Unity 版本：${manifest.dependencies.unity}。`] : []),
    ...(Object.keys(manifest.dependencies.vpm).length ? [`- VPM 依赖（用 VCC 或 vpm 解析）：${Object.entries(manifest.dependencies.vpm).map(([id, version]) => `${id} ${version}`).join('、')}。`] : []),
    '- 工程档案在 `_harness/`（开放格式 JSON）：`_harness/state/project.json` 是当前状态（方向、造型、头像根、制作流程与阶段、待处理项），'
      + '`_harness/records/decisions.json` 是方案与批准，`_harness/evidence/index.json` 是检查结论与产物指纹，`_harness/state/facts.json` 是逐条事实（含来源与证据等级）。',
    ...(manifest.selection.items.includes('C:_harness/sensitive/conversation.json') ? ['- 完整对话在 `_harness/sensitive/conversation.json`，只作查阅资料。'] : []),
    '', '## 需要做的事', '', ...manifest.receiver.map(item => `- ${item}`),
    '', '## 依赖', '',
    ...manifest.dependencies.packs.filter(pack => pack.current).map(pack => `- 制作能力包：${pack.id ?? '未知'} ${pack.version ?? ''}（${pack.channel ?? ''}）`),
    ...manifest.dependencies.projectPacks.map(pack => `- 本项目候选能力包：${pack.id}（${pack.from}，内容哈希 ${pack.contentHash.slice(0, 12)}）`),
    ...(manifest.dependencies.missing.length ? ['', '## 接收端待补齐', '', ...manifest.dependencies.missing.map(item => `- ${item.text}`)] : []),
    '', '## 没有随包提供的内容', '',
    ...summarizeExclusions(files.excluded).map(item => `- ${item}`),
    '', '## 可选内容', '',
    ...(manifest.optional.length ? manifest.optional.map(item => `- ${item.included ? '已附带' : '未附带'}（${item.layer === 'C' ? '敏感' : '非敏感'}）：${item.text}`) : ['- 无']),
    '',
  ];
  return `${lines.join('\n')}\n`;
}
function summarizeExclusions(excluded: ShareExclusion[]): string[] {
  const byReason = new Map<string, { count: number; paths: string[]; restore: string | null }>();
  for (const item of excluded) {
    const key = `${item.reason}\0${item.restore ?? ''}`;
    const prior = byReason.get(key) ?? { count: 0, paths: [], restore: item.restore };
    prior.count += item.count; if (prior.paths.length < 3) prior.paths.push(item.path);
    byReason.set(key, prior);
  }
  return [...byReason].map(([key, value]) => `${key.split('\0')[0]}：${value.count} 个（${value.paths.join('、')}${value.paths.length < value.count ? ' 等' : ''}）${
    value.restore ? `，${RESTORE_TEXT[value.restore] ?? value.restore}` : ''}`);
}

/** The shares written from this project, newest first (local records). */
export function projectShares(db: DatabaseSync, projectId: string): Array<{ id: string; revision: number; level: ShareLevel; output: string; bytes: number;
  sha256: string; selection: unknown; at: string }> {
  return (db.prepare(`SELECT id, revision, level, output, package_bytes, package_sha256, selection_json, created_at FROM project_share
    WHERE project_id = ? ORDER BY seq DESC`).all(projectId) as Array<{ id: string; revision: number; level: ShareLevel; output: string;
      package_bytes: number; package_sha256: string; selection_json: string; created_at: string }>)
    .map(row => ({ id: row.id, revision: row.revision, level: row.level, output: row.output, bytes: row.package_bytes, sha256: row.package_sha256,
      selection: JSON.parse(row.selection_json) as unknown, at: row.created_at }));
}

export type { RegistryEntry, ShareLayer };
