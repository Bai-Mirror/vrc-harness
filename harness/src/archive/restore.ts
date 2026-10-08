import {inTransaction} from './facts.ts';
import {restoreStageContracts,missingStageContractReason} from './stage-contract.ts';
import {restoreRecordContent} from './restore-record.ts';
import { restoreProductionInputs, restoreProductionRunInputs, type ProductionInputDocument } from './production.ts';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sha256File } from '../file-hash.ts';
import { hostPlatform, rejectCloudSyncedPath } from '../host-platform.ts';
import { installKnowledgeRelease, listKnowledgeReleases, type KnowledgeOffer } from '../knowledge-release.ts';
import { registerPackCandidate } from '../managed-pack-candidate.ts';
import { bundledPackInfo, installBundledPack, managedPacks } from '../managed-pack.ts';
import { MODES_SIDECAR, ordinal, packTreeHash, writeModesSidecar } from '../pack-hash.ts';
import { harnessVersion, packageVersion } from '../provenance.ts';
import { SCHEMA_VERSION } from '../state/db.ts';
import { artifactFingerprint } from '../workflow/artifacts.ts';
import type { CapabilityManifest } from '../workflow/capabilities.ts';
import { describeWorkflow } from '../workflow/view.ts';
import { ARCHIVE_MANIFEST, ARCHIVE_SCHEMA, LEGACY_SCHEMAS, SCHEMAS, type FactRecord, type Invalidation } from './contract.ts';
import { validateFact, type NewFact } from './facts.ts';
import { projectOverview } from './overview.ts';
import { frozenContent, packAt, samePack, type PackIdentity } from './packs.ts';
import { safePointProblem, type ArchiveManifest } from './projection.ts';
import { archiveSafePoint } from './refresh.ts';
import { BUILTIN_RULES, classifier, registerEntries, storedEntries, validateEntry, walkProject, type NewEntry } from './registry.ts';
import { fileHash } from '../workflow/artifacts.ts';
import { extract7z, list7z, read7zMember, sevenZip, test7z } from './sevenzip.ts';
import {
  compareMembers, FILES_PATH, LEVEL_TEXT, MANIFEST_PATH, PACKS_PREFIX, parseShareFiles, parseShareManifest, safeName,
  unsafeMembers, verifyPackageTree, type PackRequirement, type ShareFiles, type ShareLevel, type ShareManifest, type TreeCheck,
} from './share-package.ts';
import { harnessOwned, projectLineage, renameRetrying, syncContent, type ShareProgress } from './share.ts';

/**
 * Restoring a share package into a Harness of the same version (docs/project-share.md): recognise the package, unpack
 * it into an isolated directory and verify every member, hash, path and version before anything else happens; decide
 * from the project's stable archive id and its lineage whether it is a new project, an update of one this machine has
 * not changed since, or a conflicting copy placed beside it (nothing is ever overwritten silently); place the project,
 * match the capability packs its Workflows were frozen from, restore project packs as candidates only, rebuild the
 * state database from the archive's facts and events, and hand the person a reconciliation. Unpacked files alone are
 * never a restore.
 */

export interface RestoreEnvironment {
  home: string;
  workspaceRoot: string;
  /** This machine's values for the frozen run variables (asset library, template project). */
  workflowVariables: Record<string, string>;
  /** Contact the Harness server for a signed release of a missing pack (only when the person allowed it). */
  allowNetwork?: boolean;
  knowledge?: { fetcher?: typeof fetch; endpoint?: string; trustedKeys?: Record<string, string>; channel?: string };
  onProgress?: (progress: ShareProgress) => void;
}
export interface RestoreOptions {
  /** Restore beside an existing copy of the project even when it would be an update or is already present. */
  asCopy?: boolean;
  /** Directory name in the workspace (a new project or a copy). */
  name?: string;
  /** The decision the person saw in the check; a different one refuses (the local project changed meanwhile). */
  expect?: DecisionKind;
}
export type DecisionKind = 'new' | 'update' | 'same' | 'conflict';
export interface RestoreDecision {
  kind: DecisionKind;
  action: 'new' | 'update' | 'copy' | 'none';
  text: string;
  projectId?: string;
  projectPath?: string;
  target?: string;
}
export interface PackPlan {
  workflowId: string; current: boolean; status: string;
  requirement: Pick<PackRequirement, 'id' | 'version' | 'channel' | 'contentHash'>;
  resolution: 'installed' | 'bundled' | 'release' | 'candidate' | 'missing' | 'history';
  root?: string; releaseId?: string; text: string;
}
export interface RestoreCheck {
  archive: string;
  bytes: number;
  sha256: string;
  ok: boolean;
  problems: string[];
  warnings: string[];
  manifest?: { shareId: string; name: string; purpose: ShareManifest['purpose']; archiveId: string; revision: number; createdAt: string; level: ShareLevel; levelText: string;
    levelReasons: string[]; producer: ShareManifest['producer']; selection: ShareManifest['selection']; files: number; bytes: number;
    optional: ShareManifest['optional'] };
  compatibility?: { harness: { package: string; here: string; same: boolean }; stateSchema: { package: number; here: number; ok: boolean } };
  decision?: RestoreDecision;
  packs: PackPlan[];
  projectPacks: Array<{ id: string; version: string | null; contentHash: string; ok: boolean; text: string }>;
  /** What this machine will still lack after the restore, in words. */
  missing: string[];
  verified?: TreeCheck['checked'];
}
export interface RestoreResult {
  status: 'restored' | 'blocked' | 'unchanged';
  check: RestoreCheck;
  restoreId?: string;
  projectId?: string;
  path?: string;
  reconciliation?: Reconciliation;
}

const emit = (env: RestoreEnvironment, phase: string, done?: number, total?: number): void =>
  env.onProgress?.({ phase, ...(done === undefined ? {} : { done }), ...(total === undefined ? {} : { total }) });
const KNOWN_SCHEMAS = new Set<string>([...Object.values(SCHEMAS), ...Object.values(LEGACY_SCHEMAS)]);
const FINAL_WORKFLOW = new Set(['client_verified', 'cancelled']);

interface Docs {
  production?: ProductionInputDocument;
  archive: ArchiveManifest;
  present: Set<string>;
  state: StateDoc;
  facts: FactRecord[];
  registry?: { entries?: Array<{ source: { type: string; ref: string }; category: string; layer: string; rights: string; sensitivity: string;
    restore: string | null; reason: string; paths: Array<{ path: string; match: string; sha256: string | null; order: number }> }> };
  workflows: WorkflowDoc[];
  decisions?: { workflows?: DecisionDoc[] };
  evidence?: EvidenceDoc;
  events?: { events?: EventDoc[]; runs?: RunDoc[] };
  packs?: { candidates?: Array<{ id: string; registered: boolean; basePackId: string | null; version: string | null; contentHash: string | null;
    sourceKind: string | null; permissions: Record<string, unknown> | null; restoreFrom: string; draft: { path: string } | null }>;
    trials?: Array<{ id: string; candidateId: string; status: string; mode: string }> };
  sensitive?: { identity?: { orderNumber?: string }; brief?: { goal?: string } | null; humanEvents?: EventDoc[]; manifests?: Array<{ workflowId: string; request: string }>;
    blueprints?: Array<{ rootId: string; blueprintId: string }>; messages?: MessageDoc[] };
  conversation?: { messages?: MessageDoc[] };
  sources?: { assets?: Array<{ id: string; name: string; kind: string; status: string; role: string; license: string; tags: string[];
    location: { in: string; path?: string; file?: string } }>; booth?: Array<{ files?: Array<{ downloadableId: string; filename: string; selected: boolean;
      item: { name: string } }> }> };
}
interface StateDoc {
  project: { kind: string; lifecycle: string; identity: Record<string, unknown> };
  brief: { intakeMode: string; status: string; faceConcept: string } | null;
  variants: Array<{ id: string; name: string; description: string; status: string }>;
  roots: Array<{ id: string; variantId: string | null; derivedFrom: string | null; scenePath: string; objectPath: string; role: string; pluginProfile: string;
    activeState: string }>;
  assets: Array<{ id: string; name: string; kind: string; status: string; role: string; location: { in: string; path?: string; file?: string } }>;
  workflow: { id: string; createdAt: string | null; stages: Array<{ id: string; codes: string[]; reasons: string[] }> } | null;
  tasks: Array<{ id: string; workflowId: string; formal: boolean; stage: string; status: string; attempts: number; updatedAt: string }>;
}
interface WorkflowDoc { id: string; profile: string; status: string; processId: string; processHash: string; knowledgeVersion: string; frozenAt: string;
  current: boolean; definition: { stages: Array<{ id: string; produces: string[] }>; gates: Array<{ id: string; binds: string }>; checks: Array<{ id: string; on: string }> };
  capabilities: CapabilityManifest; thresholds: unknown; tools: Record<string, string>; contexts: Record<string, string>; variables: string[];
  manifest: { schema: string; profile: string; assets: Array<{ store: string; role: string | null; variant: string | null; name: string | null; item: string;sha256?:string|null;location?:'project'|'external' }>;
    variants: unknown } | null }
interface DecisionDoc { workflowId: string; plans: Array<{ order: number; hash: string; observedAt: string; error?: string }>; currentPlan: Record<string, unknown> | null;
  gates: Array<{ order: number; gateId: string; result: string; artifactHash: string; inputHashes?: Record<string,string>; selection?:unknown; recordedAt: string }>;
  rejections: Array<{ order: number; gate: string; artifactHash: string | null; at: string }> }
interface EvidenceDoc { workflowId: string | null; verdicts: Array<{ id: string; checkId: string; scope: string; result: string; basis: string | null;
  artifactHash: string; inputHashes?: Record<string,string>; recordedAt: string }>; artifacts: Array<{ order: number; kind: string; hash: string | null; observedAt: string }>;
  completions: Array<{ order: number; stage: string; artifactHashes: Record<string, string>; runId: string | null; recordedAt: string }>;
  outOfBounds?: Array<{ order: number; stage: string; artifact: string; accepted: boolean; recordedAt: string }> }
interface EventDoc { order: number; at: string; workflowId: string | null; actor: string; entityType: string; entityId: string; action: string; reason: string; payload: unknown }
interface RunDoc { id: string; taskId: string; attempt: number; status: string; provider: string | null; exitStatus: number | null; errorClass: string | null }
interface MessageDoc { id: string; role: string; status: string; content: string; at: string }

function readJson<T>(dir: string, path: string): T { return JSON.parse(readFileSync(join(dir, ...path.split('/')), 'utf8')) as T; }
/** The project archive inside an unpacked package, every file checked against its schema. */
function readDocs(dir: string): { docs?: Docs; problems: string[] } {
  const problems: string[] = [];
  let archive: ArchiveManifest;
  try { archive = readJson<ArchiveManifest>(dir, ARCHIVE_MANIFEST); } catch (error) { return { problems: [`工程档案清单无法读取：${(error as Error).message}`] }; }
  if (archive.schema !== ARCHIVE_SCHEMA) return { problems: [`工程档案清单的 schema 不认识：${String(archive.schema)}`] };
  const present = new Set<string>(), parsed = new Map<string, unknown>();
  for (const file of archive.files) {
    if (!existsSync(join(dir, ...file.path.split('/')))) continue;
    present.add(file.path);
    if (!KNOWN_SCHEMAS.has(file.schema)) { problems.push(`${file.path} 的 schema ${file.schema} 不认识，本机的 Harness 读不了`); continue; }
    if (!file.path.endsWith('.json')) continue;
    try {
      const value = readJson<{ schema?: string }>(dir, file.path);
      if (value?.schema !== file.schema) { problems.push(`${file.path} 的 schema 与档案清单不符`); continue; }
      parsed.set(file.path, value);
    } catch (error) { problems.push(`${file.path} 无法读取：${(error as Error).message}`); }
  }
  const get = <T>(path: string): T | undefined => parsed.get(path) as T | undefined;
  const state = get<StateDoc>('_harness/state/project.json');
  if (!state) problems.push('缺少 _harness/state/project.json');
  if (problems.length || !state) return { problems };
  const facts = ['_harness/state/facts.json', '_harness/optional/facts.json', '_harness/sensitive/facts.json']
    .flatMap(path => get<{ facts?: FactRecord[] }>(path)?.facts ?? []);
  return { problems, docs: { archive, present, state, facts, registry: get('_harness/state/registry.json'),
    workflows: get<{ workflows?: WorkflowDoc[] }>('_harness/state/workflows.json')?.workflows ?? [], decisions: get('_harness/records/decisions.json'),
    production: get('_harness/state/production.json'), evidence: get('_harness/evidence/index.json'), events: get('_harness/records/events.json'), packs: get('_harness/packs/index.json'),
    sensitive: get('_harness/sensitive/project.json'), conversation: get('_harness/sensitive/conversation.json'), sources: get('_harness/records/sources.json') } };
}

/** The project this database already has under the package's archive id, and how its state relates to the package. */
function decide(db: DatabaseSync, manifest: ShareManifest, options: RestoreOptions): RestoreDecision {
  const local = db.prepare(`SELECT i.project_id AS id FROM project_archive_identity i WHERE i.archive_id = ?`).get(manifest.project.archiveId) as
    { id: string } | undefined;
  if (!local) return { kind: 'new', action: 'new', text: '本机还没有这个项目：恢复为新项目' };
  const path = localPath(db, local.id);
  const name = path ? relative(dirname(path), path) : local.id;
  const known = new Set(projectLineage(db, local.id));
  if (known.has(manifest.shareId)) return { kind: 'same', action: options.asCopy ? 'copy' : 'none', projectId: local.id, projectPath: path,
    text: `本机的「${name}」已经包含这个分享包的内容（或更新的版本）${options.asCopy ? '：按要求另存为并列副本' : '：不需要恢复'}` };
  const last = db.prepare('SELECT share_id, revision, content_json FROM project_sync WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(local.id) as
    { share_id: string; revision: number; content_json: string } | undefined;
  const latest = (db.prepare('SELECT MAX(number) AS n FROM project_revision WHERE project_id = ?').get(local.id) as { n: number | null }).n;
  const busy = safePointProblem(db, local.id);
  const descends = Boolean(last && manifest.project.lineage.includes(last.share_id) && latest === last.revision);
  // The state database has not moved since the sync point; the files must not have either (an edit in Unity, say).
  const changes = descends && !busy && path && existsSync(path) ? localChanges(db, local.id, path, JSON.parse(last!.content_json) as Record<string, string>) : [];
  if (descends && !changes.length && !busy && path && existsSync(path) && !options.asCopy)
    return { kind: 'update', action: 'update', projectId: local.id, projectPath: path,
      text: `这是本机「${name}」的新版本，本机在上次同步后没有改动：原位更新，旧文件夹保留为备份` };
  return { kind: 'conflict', action: 'copy', projectId: local.id, projectPath: path,
    text: busy ? `本机的「${name}」正在执行任务：恢复为并列副本，不动它`
      : options.asCopy ? '按要求恢复为并列副本'
        : descends && !(path && existsSync(path)) ? `本机登记的「${name}」目录已不存在：恢复为并列副本`
          : changes.length ? `本机的「${name}」在上次同步后改动了文件（${changes.slice(0, 3).join('、')}${changes.length > 3 ? ' 等' : ''}）：恢复为并列副本，不会覆盖`
            : `本机的「${name}」在上次同步后有改动，或来自另一条修改线：恢复为并列副本，不会覆盖` };
}
/** What changed in a project's files since a sync point (archive files Harness rewrites itself aside). */
function localChanges(db: DatabaseSync, projectId: string, root: string, content: Record<string, string>): string[] {
  const registry = classifier([...BUILTIN_RULES, ...storedEntries(db, projectId)]);
  const walked = walkProject(root, directory => registry.skipped(directory));
  const changes: string[] = [], seen = new Set<string>();
  for (const path of walked.files) {
    if (harnessOwned(path) || registry.classify(path)?.shareLayer === 'excluded') continue;
    seen.add(path);
    const want = content[path];
    if (!want) changes.push(`新增 ${path}`);
    else if (fileHash(join(root, ...path.split('/'))) !== want) changes.push(`改动 ${path}`);
    if (changes.length >= 20) return changes;
  }
  for (const path of Object.keys(content)) if (!seen.has(path)) { changes.push(`删除 ${path}`); if (changes.length >= 20) break; }
  return changes;
}
function localPath(db: DatabaseSync, projectId: string): string | undefined {
  const row = db.prepare('SELECT p.path, w.path AS workspace FROM project p LEFT JOIN workspace w ON w.id = p.workspace_id WHERE p.id = ?').get(projectId) as
    { path: string; workspace: string | null } | undefined;
  if (!row) return undefined;
  return isAbsolute(row.path) ? row.path : row.workspace ? join(row.workspace, row.path) : undefined;
}
function uniqueTarget(workspace: string, name: string): string {
  let target = join(workspace, name);
  for (let i = 2; existsSync(target); i++) target = join(workspace, `${name}-${i}`);
  return target;
}

/** Where each Workflow's capability pack comes from on this machine. */
async function planPacks(db: DatabaseSync, docs: Docs, manifest: ShareManifest, env: RestoreEnvironment, install: boolean): Promise<PackPlan[]> {
  const plans: PackPlan[] = [];
  let offers: KnowledgeOffer[] | undefined;
  for (const workflow of docs.workflows) {
    const requirement = manifest.dependencies.packs.find(item => item.workflowId === workflow.id && !item.selectionSeq)
      ?? { id: null, version: null, channel: null, contentHash: null, current: workflow.current, status: workflow.status, workflowId: workflow.id };
    const base = { workflowId: workflow.id, current: workflow.current, status: workflow.status,
      requirement: { id: requirement.id, version: requirement.version, channel: requirement.channel, contentHash: requirement.contentHash } };
    const live = workflow.current && !FINAL_WORKFLOW.has(workflow.status);
    const bindable = (root: string): boolean => frozenContent(root, workflow.tools, workflow.contexts).ok;
    if (requirement.channel === 'candidate' || workflow.knowledgeVersion.startsWith('candidate:')) {
      plans.push({ ...base, resolution: live ? 'candidate' : 'history', text: live
        ? `制作流程用的是本项目候选能力包 ${requirement.id ?? ''}：恢复为候选后，需要在本机重新评测并批准试用才能继续`
        : '历史制作流程：用的是本项目候选能力包，只作记录' });
      continue;
    }
    const wanted = requirement.id && requirement.version && requirement.contentHash
      ? { id: requirement.id, version: requirement.version, contentHash: requirement.contentHash } : undefined;
    const installed = wanted ? managedPacks(env.home).map(pack => packAt(pack.root)).find((pack): pack is PackIdentity => Boolean(pack) && samePack(pack!, wanted))
      : undefined;
    if (installed && bindable(installed.root)) { plans.push({ ...base, resolution: 'installed', root: installed.root, text: `本机已安装能力包 ${installed.id} ${installed.version}` }); continue; }
    const bundled = bundledPackInfo();
    if (wanted && bundled && (bundled.bundledFrom ?? bundled.id) === wanted.id && bundled.version === wanted.version) {
      let root: string | undefined;
      if (install) { const done = installBundledPack(env.home); const pack = packAt(done.root); if (pack && samePack(pack, wanted) && bindable(done.root)) root = done.root; }
      if (!install || root) { plans.push({ ...base, resolution: 'bundled', ...(root ? { root } : {}), text: `使用同版 Harness 自带的能力包 ${wanted.id} ${wanted.version}` }); continue; }
    }
    if (wanted && env.allowNetwork) {
      try {
        offers ??= (await listKnowledgeReleases({ channel: env.knowledge?.channel ?? 'dev', supportedSchema: SCHEMA_VERSION, ...(env.knowledge?.fetcher ? { fetcher: env.knowledge.fetcher } : {}),
          ...(env.knowledge?.endpoint ? { endpoint: env.knowledge.endpoint } : {}), ...(env.knowledge?.trustedKeys ? { trustedKeys: env.knowledge.trustedKeys } : {}) })).offers;
        const offer = offers.find(item => item.manifest.packId === wanted.id && item.manifest.version === wanted.version && item.manifest.contentHash === wanted.contentHash);
        if (offer) {
          let root: string | undefined;
          if (install) {
            const done = await installKnowledgeRelease(db, env.home, offer, { supportedSchema: SCHEMA_VERSION, ...(env.knowledge?.fetcher ? { fetcher: env.knowledge.fetcher } : {}),
              ...(env.knowledge?.trustedKeys ? { trustedKeys: env.knowledge.trustedKeys } : {}) });
            db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json) VALUES ('human', 'managed_pack', ?, 'installed', ?, ?)`)
              .run(done.id, '恢复分享包时安装已签名的能力包', JSON.stringify({ version: offer.manifest.version, releaseId: offer.manifest.releaseId }));
            if (bindable(done.root)) root = done.root;
          }
          if (!install || root) { plans.push({ ...base, resolution: 'release', ...(root ? { root } : {}), releaseId: offer.manifest.releaseId,
            text: `从 Harness 服务器下载已签名的能力包 ${wanted.id} ${wanted.version}（约 ${Math.max(1, Math.round(offer.archive.size / 1024 ** 2))} MB）` }); continue; }
        }
      } catch (error) { plans.push({ ...base, resolution: live ? 'missing' : 'history', text: `查询 Harness 服务器失败：${(error as Error).message}` }); continue; }
    }
    plans.push({ ...base, resolution: live ? 'missing' : 'history', text: live
      ? `缺少能力包 ${requirement.id ?? '（原机的开发目录）'} ${requirement.version ?? ''}：制作流程待安装后继续${env.allowNetwork ? '（Harness 服务器上也没有这个签名发行）' : '（可以允许从 Harness 服务器查找）'}`
      : '历史制作流程：本机没有它的能力包，只作记录' });
  }
  return plans;
}
interface Prepared { check: RestoreCheck; work: string; extracted: string; manifest?: ShareManifest; files?: ShareFiles; docs?: Docs;
  /** Mode sidecars written beside carried pack drafts (Windows): files of the restored project, not of the package. */
  sidecars?: Record<string, string> }
/**
 * Everything a restore checks before it may write: the package's members (portable, no links, within limits, equal to
 * its content list), `7z t`, an isolated unpack verified file by file, the archive's schemas and the versions.
 */
async function prepare(db: DatabaseSync, env: RestoreEnvironment, archivePath: string, options: RestoreOptions, install: boolean): Promise<Prepared> {
  const archive = resolve(archivePath);
  const check: RestoreCheck = { archive, bytes: 0, sha256: '', ok: false, problems: [], warnings: [], packs: [], projectPacks: [], missing: [] };
  const work = join(env.workspaceRoot, `.harness-restore-${randomUUID().slice(0, 8)}`), extracted = join(work, 'package');
  const fail = (problem: string): Prepared => { check.problems.push(problem); return { check, work, extracted }; };
  if (!existsSync(archive) || !statSync(archive).isFile()) return fail(`找不到分享包：${archive}`);
  const zip = sevenZip();
  if ('problem' in zip) return fail(zip.problem);
  check.bytes = statSync(archive).size;
  check.sha256 = sha256File(archive);
  emit(env, 'list');
  let listed;
  try { listed = list7z(archive); } catch (error) { return fail((error as Error).message); }
  const unsafe = unsafeMembers(listed);
  if (unsafe.length) { check.problems.push(...unsafe); return { check, work, extracted }; }
  for (const doc of [MANIFEST_PATH, FILES_PATH]) if (!listed.some(member => member.path === doc && !member.directory))
    return fail(`不是 Harness 分享包：缺少 ${doc}`);
  let manifest: ShareManifest, files: ShareFiles;
  try { manifest = parseShareManifest(read7zMember(archive, MANIFEST_PATH).toString('utf8')); } catch (error) { return fail((error as Error).message); }
  let filesText: string;
  try { filesText = read7zMember(archive, FILES_PATH).toString('utf8'); files = parseShareFiles(filesText); } catch (error) { return fail((error as Error).message); }
  check.manifest = { shareId: manifest.shareId, name: manifest.project.name, purpose: manifest.purpose,
    archiveId: manifest.project.archiveId, revision: manifest.project.revision,
    createdAt: manifest.createdAt, level: manifest.level, levelText: manifest.levelText, levelReasons: manifest.levelReasons, producer: manifest.producer,
    selection: manifest.selection, files: manifest.integrity.files, bytes: manifest.integrity.bytes, optional: manifest.optional };
  const here = packageVersion();
  check.compatibility = { harness: { package: manifest.producer.version, here, same: manifest.producer.version === here },
    stateSchema: { package: manifest.producer.stateSchema, here: SCHEMA_VERSION, ok: manifest.producer.stateSchema <= SCHEMA_VERSION } };
  if (!check.compatibility.stateSchema.ok) check.problems.push(`分享包来自更新的 Harness（状态库 schema ${manifest.producer.stateSchema}），本机只支持到 ${SCHEMA_VERSION}：先更新 Harness`);
  if (manifest.producer.archiveSchema !== ARCHIVE_SCHEMA) check.problems.push(`工程档案格式 ${manifest.producer.archiveSchema} 不认识`);
  if (!check.compatibility.harness.same) check.warnings.push(`分享包由 Harness ${manifest.producer.version} 制作，本机是 ${here}：按同版合同恢复，能力包按精确版本匹配`);
  const mismatch = compareMembers(listed, files);
  if (mismatch.length) check.problems.push(...mismatch.slice(0, 20));
  if (check.problems.length) return { check, work, extracted, manifest, files };
  emit(env, 'test');
  const tested = test7z(archive);
  if (!tested.ok) return fail(`7z 完整性测试未通过：${tested.detail}`);
  try {
    const space = statfsSync(env.workspaceRoot);
    if (space.bavail * space.bsize < manifest.integrity.bytes + 256 * 1024 * 1024) return fail(`工作区剩余空间不足：需要约 ${Math.ceil(manifest.integrity.bytes / 1024 ** 3) + 1} GB`);
  } catch { /* statfs is advisory */ }
  emit(env, 'extract');
  mkdirSync(extracted, { recursive: true });
  try { extract7z(archive, extracted); } catch (error) { rmSync(work, { recursive: true, force: true }); return fail((error as Error).message); }
  emit(env, 'verify');
  const verified = verifyPackageTree(extracted, manifest, files, filesText);
  check.verified = verified.checked;
  if (verified.problems.length) { check.problems.push(...verified.problems); return { check, work, extracted, manifest, files }; }
  // Only what the package holds is verified; the modes it lists are set (or, on Windows, recorded beside the tree) after.
  const sidecars = normalizePackModes(extracted, files);
  const read = readDocs(extracted);
  if (read.problems.length || !read.docs) { check.problems.push(...read.problems); return { check, work, extracted, manifest, files }; }
  const docs = read.docs;
  if (docs.archive.archiveId !== manifest.project.archiveId) check.problems.push('工程档案的身份与分享清单不符');

  check.decision = decide(db, manifest, options);
  if (check.decision.action === 'new' || check.decision.action === 'copy') {
    const name = safeName(options.name?.trim() || `${manifest.project.name}${check.decision.action === 'copy' ? '-copy' : ''}`);
    check.decision.target = uniqueTarget(env.workspaceRoot, name);
  } else if (check.decision.action === 'update') check.decision.target = check.decision.projectPath;
  check.packs = await planPacks(db, docs, manifest, env, install && check.decision.action !== 'none');
  for (const pack of manifest.dependencies.projectPacks) {
    const source = pack.from.startsWith(PACKS_PREFIX) ? join(extracted, ...pack.from.split('/').filter(Boolean)) : join(extracted, ...pack.from.split('/').filter(Boolean));
    let hash: string | undefined;
    try { hash = packTreeHash(source).hash; } catch { hash = undefined; }
    const ok = hash === pack.contentHash;
    check.projectPacks.push({ id: pack.id, version: pack.version, contentHash: pack.contentHash, ok,
      text: ok ? `本项目候选能力包 ${pack.id}：内容哈希一致，恢复为候选（不会成为正式版本）`
        : `本项目候选能力包 ${pack.id}：内容哈希在本机无法复现，不登记${process.platform === 'win32' ? '（多为原机的文件权限位与 Windows 不同）' : ''}` });
  }
  check.missing = receiverMissing(db, env, docs, manifest, check.packs);
  check.ok = check.problems.length === 0 && check.decision.action !== 'none';
  if (check.decision.action === 'none') check.warnings.push(check.decision.text);
  return { check, work, extracted, manifest, files, docs, sidecars };
}

/**
 * Carried packs keep their exact file modes: set them (POSIX) or record them beside the tree (Windows). Returns the
 * sidecars this wrote into the project itself (relative path → SHA-256): they belong to the restored project's files.
 */
function normalizePackModes(dir: string, files: ShareFiles): Record<string, string> {
  const roots = new Map<string, string[]>();
  for (const entry of files.entries) {
    const match = /^(share\/packs\/[^/]+|_harness\/candidate-packs\/[^/]+)\//.exec(entry.path);
    if (!match || entry.kind !== 'file') continue;
    const executable = roots.get(match[1]!) ?? [];
    if (entry.mode === 0o755) executable.push(entry.path.slice(match[1]!.length + 1));
    roots.set(match[1]!, executable);
    if (process.platform !== 'win32') chmodSync(join(dir, ...entry.path.split('/')), entry.mode ?? 0o644);
  }
  const listed = new Set(files.entries.map(entry => entry.path)), written: Record<string, string> = {};
  for (const [root, executable] of roots) {
    const absolute = join(dir, ...root.split('/'));
    if (process.platform === 'win32') {
      // A sidecar the package carries (a Windows sender's draft) was verified with the rest; it stays as it is.
      const sidecar = `${root}${MODES_SIDECAR}`;
      if (listed.has(sidecar)) continue;
      writeModesSidecar(absolute, executable);
      if (!root.startsWith('share/') && existsSync(`${absolute}${MODES_SIDECAR}`)) written[sidecar] = sha256File(`${absolute}${MODES_SIDECAR}`);
      continue;
    }
    const settle = (directory: string): void => {
      chmodSync(directory, 0o755);
      for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) settle(join(directory, entry.name));
    };
    settle(absolute);
  }
  return written;
}

/** What this machine lacks for the project, in the words the reconciliation shows. */
function receiverMissing(db: DatabaseSync, env: RestoreEnvironment, docs: Docs, manifest: ShareManifest, packs: PackPlan[]): string[] {
  const missing = manifest.dependencies.missing.map(item => item.text);
  for (const pack of packs) if (pack.resolution === 'missing' || pack.resolution === 'candidate') missing.push(pack.text);
  const current = docs.workflows.find(workflow => workflow.current && !FINAL_WORKFLOW.has(workflow.status));
  for (const name of current?.variables ?? []) if (!variableValue(env, name)) missing.push(`本机没有设置运行目录“${name}”：用到它的阶段重做前需要设置`);
  for (const asset of docs.state.assets.filter(item => item.location.in === 'library'))
    missing.push(`素材库文件 ${asset.location.file ?? asset.name}（${asset.name}）不随分享包：重做导入素材的阶段时需要`);
  for (const plan of docs.sources?.booth ?? []) for (const file of plan.files ?? []) {
    if (!file.selected) continue;
    const ready = db.prepare("SELECT 1 FROM materialized_file WHERE downloadable_id = ? AND status = 'ready'").get(file.downloadableId);
    if (!ready) missing.push(`BOOTH 商品「${file.item.name}」的 ${file.filename}：付费素材不随包转交，需要接收者自己购买或下载`);
  }
  return [...new Set(missing)];
}
function variableValue(env: RestoreEnvironment, name: string): string | undefined {
  return env.workflowVariables[name] || (name === 'assetLibrary' ? join(env.home, 'materialized', 'assets') : undefined);
}

/** Check a package without writing anything into this machine's projects (the unpack is removed again). */
export async function checkRestore(db: DatabaseSync, env: RestoreEnvironment, archivePath: string, options: RestoreOptions = {}): Promise<RestoreCheck> {
  const prepared = await prepare(db, env, archivePath, options, false);
  rmSync(prepared.work, { recursive: true, force: true });
  return prepared.check;
}

/** Ids of the package, as they are written here: kept for a new project or an update, fresh for a copy beside one. */
class Ids {
  private readonly map = new Map<string, string>();
  readonly copy: boolean; readonly sourceProject: string; readonly project: string;
  constructor(copy: boolean, sourceProject: string, project: string) { this.copy = copy; this.sourceProject = sourceProject; this.project = project; }
  id(old: string): string {
    if (old === this.sourceProject) return this.project;
    if (!this.copy) return old;
    let next = this.map.get(old);
    if (!next) { next = randomUUID(); this.map.set(old, next); }
    return next;
  }
  /** A verdict id is `<run id>:<check id>`: its Run part follows the Run. */
  verdict(old: string): string {
    const at = old.lastIndexOf(':');
    return at > 0 ? `${this.id(old.slice(0, at))}${old.slice(at)}` : this.id(old);
  }
  /** An event's entity: an id, or `<project>:<asset>` for a project's asset link. */
  entity(old: string): string {
    if (old.startsWith(`${this.sourceProject}:`)) return `${this.project}${old.slice(this.sourceProject.length)}`;
    return this.id(old);
  }
  /** Strings in an event payload that name a mapped id. */
  deep(value: unknown): unknown {
    if (typeof value === 'string') return value === this.sourceProject ? this.project : this.copy && this.map.has(value) ? this.map.get(value) : value;
    if (Array.isArray(value)) return value.map(item => this.deep(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.deep(item)]));
    return value;
  }
}

/** How a Task restored from another machine stands here: a Run's outcome there cannot be known here. */
function restoredTaskStatus(status: string, stageCodes: string[]): { status: string; reason: string } {
  if (['PASSED', 'FAILED', 'CANCELLED', 'BLOCKED', 'READY', 'PENDING'].includes(status)) return { status, reason: '按原机状态恢复' };
  if (status === 'WAITING_HUMAN' && stageCodes.some(code => ['gate_pending', 'out_of_bounds', 'warning_unaccepted'].includes(code)))
    return { status, reason: '恢复后仍等你决定' };
  return { status: 'RECOVERY_REQUIRED', reason: `原机上这一步${status === 'RUNNING' ? '正在执行' : status === 'VERIFYING' ? '正在检查' : status === 'WAITING_HUMAN' ? '在等处理' : '需要核对'}，结果无法在本机确认：核对后再继续` };
}

interface Pending { workflowId: string; reason: string; requirement: PackPlan['requirement']; frozen: WorkflowDoc; manifest: Record<string, unknown> | null }

/** Restore a package: all checks first; then place, rebuild, match packs, write the archive and record the restore. */
export async function restoreShare(db: DatabaseSync, env: RestoreEnvironment, archivePath: string, options: RestoreOptions = {}): Promise<RestoreResult> {
  const prepared = await prepare(db, env, archivePath, options, true);
  const { check, work, extracted, manifest, docs } = prepared;
  try {
    if (!check.ok || !manifest || !docs || !check.decision) return { status: check.decision?.action === 'none' && !check.problems.length ? 'unchanged' : 'blocked', check };
    const decision = check.decision;
    if (options.expect && options.expect !== decision.kind)
      return { status: 'blocked', check: { ...check, ok: false, problems: [`恢复方式已变化（检查时是 ${options.expect}，现在是 ${decision.kind}）：请重新检查后再恢复`] } };
    rejectCloudSyncedPath(decision.target!);
    emit(env, 'place');
    // The package's own documents are not the project: they move out before the project takes its place.
    const docsDir = join(work, 'share');
    renameRetrying(join(extracted, 'share'), docsDir);
    const target = decision.target!;
    let backup: string | undefined;
    if (decision.action === 'update') {
      const problem = safePointProblem(db, decision.projectId!);
      if (problem) return { status: 'blocked', check: { ...check, ok: false, problems: [`本机的项目正在执行任务（${problem}）：不能更新，稍后再试或恢复为并列副本`] } };
      const now = new Date(), pad = (n: number) => String(n).padStart(2, '0');
      backup = `${target}.before-restore-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      renameRetrying(target, backup);
      if (existsSync(join(backup, '.git'))) renameRetrying(join(backup, '.git'), join(extracted, '.git'));
    }
    try { renameRetrying(extracted, target); }
    catch (error) {
      if (backup) { if (existsSync(join(extracted, '.git'))) renameRetrying(join(extracted, '.git'), join(backup, '.git')); renameRetrying(backup, target); }
      throw new Error(`无法把工程放到 ${target}：${(error as Error).message}`);
    }
    const root = realpathSync(target);
    if (!existsSync(join(root, '.git'))) {
      try { execFileSync(hostPlatform.toolCommand('git'), ['init', '--quiet', root], { stdio: 'pipe', timeout: 120_000, windowsHide: true }); }
      catch (error) { check.warnings.push(`无法在工程里建立 Git 仓库：${(error as Error).message}`); }
    }
    emit(env, 'rebuild');
    let rebuilt: { projectId: string; restoreId: string; pending: Pending[]; counts: Record<string, number> };
    try { rebuilt = rebuild(db, env, { manifest, docs, decision, root, check, backup }); }
    catch (error) {
      // Nothing may stay half-restored: the project directory goes back to how it was.
      try {
        if (decision.action === 'update' && backup) {
          renameRetrying(root, join(work, 'failed'));
          if (existsSync(join(work, 'failed', '.git'))) renameRetrying(join(work, 'failed', '.git'), join(backup, '.git'));
          renameRetrying(backup, target);
        } else rmSync(root, { recursive: true, force: true });
      } catch { /* the error below still reports the failure; the directory is named in it */ }
      throw new Error(`恢复没有完成，已撤回放置的工程：${(error as Error).message}`);
    }
    emit(env, 'packs');
    const candidateResults = restoreCandidates(db, env, rebuilt.projectId, docs, manifest, root, docsDir, check);
    for (const result of candidateResults) db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
      VALUES (NULL, 'runtime', 'project_restore', ?, ?, ?, ?)`).run(rebuilt.restoreId, result.ok ? 'candidate_restored' : 'candidate_not_restored', result.text,
      JSON.stringify({ projectId: rebuilt.projectId, candidateId: result.id }));
    observeDormantArtifacts(db, rebuilt.projectId, root, rebuilt.pending);
    // The project keeps its own record of where it came from (docs/project-archive.md §2: share/, never shared on).
    try {
      const fixed = JSON.parse((db.prepare('SELECT report_json FROM project_restore WHERE id = ?').get(rebuilt.restoreId) as { report_json: string }).report_json) as
        Record<string, unknown>;
      // Relative facts only: where the package and the project lie on this machine stays in the state database.
      mkdirSync(join(root, '_harness', 'share'), { recursive: true });
      writeFileSync(join(root, '_harness', 'share', `restore-${rebuilt.restoreId.slice(0, 8)}.json`), restoreRecordContent(rebuilt.restoreId,fixed));
    } catch (error) { check.warnings.push(`恢复记录没有写进工程：${(error as Error).message}`); }
    emit(env, 'safe-point');
    const write = await archiveSafePoint(db, env.home, rebuilt.projectId);
    const revision = (db.prepare('SELECT number, digest FROM project_revision WHERE project_id = ? ORDER BY number DESC LIMIT 1').get(rebuilt.projectId) as
      { number: number; digest: string } | undefined);
    const content = { ...syncContent(prepared.files!.entries), ...prepared.sidecars };
    if (revision) db.prepare(`INSERT INTO project_sync (project_id, share_id, direction, revision, digest, lineage_json, content_json) VALUES (?, ?, 'restore', ?, ?, ?, ?)`)
      .run(rebuilt.projectId, manifest.shareId, revision.number, revision.digest, JSON.stringify([...manifest.project.lineage, manifest.shareId].slice(-500)),
        JSON.stringify(Object.fromEntries(Object.entries(content).sort(([a], [b]) => ordinal(a, b)))));
    if (write.status === 'failed') check.warnings.push(`恢复后的工程档案写入失败：${write.error}`);
    return { status: 'restored', check, restoreId: rebuilt.restoreId, projectId: rebuilt.projectId, path: root,
      reconciliation: restoreReconciliation(db, rebuilt.projectId) ?? undefined };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/** The state database side of a restore, in one transaction: nothing of it stays when any part fails. */
function rebuild(db: DatabaseSync, env: RestoreEnvironment, input: { manifest: ShareManifest; docs: Docs; decision: RestoreDecision; root: string;
  check: RestoreCheck; backup?: string }): { projectId: string; restoreId: string; pending: Pending[]; counts: Record<string, number> } {
  const { manifest, docs, decision, root, check } = input;
  const update = decision.action === 'update';
  const projectId = update ? decision.projectId! : randomUUID();
  const ids = new Ids(decision.action === 'copy', manifest.project.sourceProjectId, projectId);
  const counts: Record<string, number> = { facts: 0, factsA: 0, factsB: 0, factsC: 0, workflows: 0, tasks: 0, verdicts: 0, decisions: 0, completions: 0,
    messages: 0, registrations: 0, events: 0, runs: 0, variants: 0, roots: 0, assets: 0 };
  const restoreId = randomUUID();
  const pending: Pending[] = [];
  const pathChanges: string[] = [`工程位置：原机的「${manifest.project.name}」→ ${root}`];
  if (input.backup) pathChanges.push(`更新前的工程文件夹保留在 ${input.backup}`);
  db.exec('BEGIN IMMEDIATE');
  try {
    // Workspace and project.
    let workspace = db.prepare('SELECT id FROM workspace WHERE path = ?').get(env.workspaceRoot) as { id: string } | undefined;
    if (!workspace) {
      workspace = { id: randomUUID() };
      db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run(workspace.id, env.workspaceRoot);
    }
    const identity = { ...docs.state.project.identity, ...(docs.sensitive?.identity?.orderNumber ? { orderNumber: docs.sensitive.identity.orderNumber } : {}) };
    const latestWorkflow = docs.workflows.find(workflow => workflow.current);
    if (update) db.prepare('UPDATE project SET identity_json = ?, lifecycle = ? WHERE id = ?').run(JSON.stringify(identity), docs.state.project.lifecycle, projectId);
    else {
      const kind = ['client', 'private', 'history', 'sample'].includes(docs.state.project.kind) ? docs.state.project.kind : 'private';
      db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projectId, workspace.id, kind, root, JSON.stringify(identity), docs.state.project.lifecycle || 'restored', harnessVersion(),
          latestWorkflow?.knowledgeVersion ?? 'restored');
      db.prepare('INSERT INTO project_archive_identity (project_id, archive_id, origin) VALUES (?, ?, ?)').run(projectId,
        decision.action === 'copy' ? randomUUID() : manifest.project.archiveId, decision.action === 'copy' ? 'created' : 'adopted');
    }

    // The person's direction, looks and roots.
    const brief = docs.state.brief;
    if (brief) db.prepare(`INSERT INTO project_brief (project_id, intake_mode, customer_request, face_concept, status) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET intake_mode = excluded.intake_mode, customer_request = excluded.customer_request,
      face_concept = excluded.face_concept, status = excluded.status, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(projectId, ['conversation', 'selection', 'import'].includes(brief.intakeMode) ? brief.intakeMode : 'import', docs.sensitive?.brief?.goal ?? '',
        brief.faceConcept ?? '', ['draft', 'direction_pending', 'direction_approved', 'archived'].includes(brief.status) ? brief.status : 'draft');
    const variantIds = new Set(docs.state.variants.map(variant => ids.id(variant.id)));
    const rootIds = new Set(docs.state.roots.map(item => ids.id(item.id)));
    if (update) {
      for (const row of db.prepare('SELECT id FROM avatar_root WHERE project_id = ?').all(projectId) as Array<{ id: string }>)
        if (!rootIds.has(row.id)) db.prepare('DELETE FROM avatar_root WHERE id = ?').run(row.id);
      for (const row of db.prepare('SELECT id FROM project_variant WHERE project_id = ?').all(projectId) as Array<{ id: string }>)
        if (!variantIds.has(row.id)) db.prepare('DELETE FROM project_variant WHERE id = ?').run(row.id);
    }
    for (const variant of docs.state.variants) {
      db.prepare(`INSERT INTO project_variant (id, project_id, name, description, status) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, description = excluded.description, status = excluded.status`).run(ids.id(variant.id), projectId, variant.name,
        variant.description ?? '', ['planned', 'working', 'delivery', 'archived'].includes(variant.status) ? variant.status : 'planned');
      counts.variants++;
    }
    const blueprints = new Map((docs.sensitive?.blueprints ?? []).map(item => [item.rootId, item.blueprintId]));
    const roots = [...docs.state.roots];
    const placed = new Set<string>();
    while (roots.length) {
      const index = roots.findIndex(item => !item.derivedFrom || placed.has(item.derivedFrom) || !docs.state.roots.some(other => other.id === item.derivedFrom));
      const item = roots.splice(index < 0 ? 0 : index, 1)[0]!;
      db.prepare(`INSERT INTO avatar_root (id, project_id, variant_id, derived_from, scene_path, object_path, role, plugin_profile, active_state, blueprint_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET variant_id = excluded.variant_id, derived_from = excluded.derived_from,
        scene_path = excluded.scene_path, object_path = excluded.object_path, role = excluded.role, plugin_profile = excluded.plugin_profile,
        active_state = excluded.active_state, blueprint_id = excluded.blueprint_id`).run(ids.id(item.id), projectId,
        item.variantId && variantIds.has(ids.id(item.variantId)) ? ids.id(item.variantId) : null,
        item.derivedFrom && placed.has(item.derivedFrom) ? ids.id(item.derivedFrom) : null, item.scenePath ?? '', item.objectPath,
        ['baseline', 'working', 'plugin_derivative', 'delivery'].includes(item.role) ? item.role : 'working', item.pluginProfile ?? '',
        ['active', 'inactive', 'unknown'].includes(item.activeState) ? item.activeState : 'unknown', blueprints.get(item.id) ?? '');
      placed.add(item.id);
      counts.roots++;
    }

    // Messages: the whole conversation when it came along, otherwise the decisions the person accepted (layer A).
    const messages = docs.conversation?.messages ?? docs.sensitive?.messages;
    const insertMessage = db.prepare(`INSERT INTO project_message (id, project_id, role, content, status, created_at) SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM project_message WHERE id = ?)`);
    if (messages) for (const message of messages) {
      const id = ids.id(message.id);
      counts.messages += Number(insertMessage.run(id, projectId, message.role === 'harness' ? 'harness' : 'user', message.content,
        ['note', 'proposed', 'accepted', 'rejected'].includes(message.status) ? message.status : 'note', message.at, id).changes);
    } else for (const fact of docs.facts.filter(item => item.source.type === 'project' && item.objectId.startsWith('decision:') && item.attribute === 'accepted')) {
      const id = ids.id(fact.objectId.slice('decision:'.length));
      counts.messages += Number(insertMessage.run(id, projectId, 'user', String(fact.value), 'accepted', fact.recordedAt, id).changes);
    }

    // Assets inside the project come along; library files stay on the sender's machine.
    for (const asset of docs.state.assets) {
      if (asset.location.in !== 'project' || !asset.location.path) continue;
      const path = join(root, ...asset.location.path.split('/'));
      const source = docs.sources?.assets?.find(item => item.id === asset.id);
      let id = (db.prepare('SELECT id FROM asset WHERE path = ?').get(path) as { id: string } | undefined)?.id;
      if (!id) {
        id = db.prepare('SELECT 1 FROM asset WHERE id = ?').get(ids.id(asset.id)) ? randomUUID() : ids.id(asset.id);
        db.prepare(`INSERT INTO asset (id, path, name, kind, status, license, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, path, asset.name,
          ['avatar', 'outfit', 'texture', 'animation', 'package', 'other'].includes(asset.kind) ? asset.kind : 'other',
          ['candidate', 'ready', 'blocked', 'archived'].includes(asset.status) ? asset.status : 'candidate', source?.license ?? 'unknown',
          JSON.stringify(source?.tags ?? []));
      }
      db.prepare(`INSERT INTO project_asset (project_id, asset_id, role) VALUES (?, ?, ?) ON CONFLICT(project_id, asset_id) DO UPDATE SET role = excluded.role`)
        .run(projectId, id, ['candidate', 'source', 'used', 'rejected'].includes(asset.role) ? asset.role : 'candidate');
      counts.assets++;
    }

    // Stored fact records with their history, in the order they were recorded; derived ones come back with their tables.
    const stored = docs.facts.filter(fact => ['import_scan', 'harness_scan', 'takeover_analysis', 'user'].includes(fact.source.type));
    const byId = new Map(stored.map(fact => [fact.id, fact]));
    const ordered: FactRecord[] = [], done = new Set<string>();
    const place = (fact: FactRecord, depth = 0): void => {
      if (done.has(fact.id)) return;
      done.add(fact.id);
      const prior = fact.supersedes ? byId.get(fact.supersedes) : undefined;
      if (prior && depth < 10_000) place(prior, depth + 1);
      ordered.push(fact);
    };
    for (const fact of [...stored].sort((a, b) => ordinal(a.recordedAt, b.recordedAt) || ordinal(a.id, b.id))) place(fact);
    const insertFact = db.prepare(`INSERT INTO project_fact (id, project_id, object_id, attribute, value_json, source_type, source_ref, locator_json,
      input_fingerprint, observer, observed_at, status, evidence_level, confidence, scope, invalidation_json, share_layer, supersedes, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const written = new Set<string>();
    for (const fact of ordered) {
      const id = ids.id(fact.id);
      if (db.prepare('SELECT 1 FROM project_fact WHERE id = ?').get(id)) { written.add(fact.id); continue; }
      const invalidation: Invalidation[] = (fact.invalidation ?? []).map(condition => condition.kind === 'fact' ? { ...condition, factId: ids.id(condition.factId) }
        : condition.kind === 'artifact' ? { ...condition, workflowId: ids.id(condition.workflowId) } : condition);
      const record: NewFact = { objectId: fact.objectId, attribute: fact.attribute, value: fact.value, source: { type: fact.source.type as NewFact['source']['type'], ref: fact.source.ref },
        locator: fact.locator ?? {}, inputFingerprint: fact.inputFingerprint, observer: fact.observer, observedAt: fact.observedAt, status: fact.status,
        evidenceLevel: fact.evidenceLevel, confidence: fact.confidence, scope: fact.scope, invalidation, shareLayer: fact.shareLayer };
      try { validateFact(record); }
      catch (error) { check.warnings.push(`跳过一条不合约的事实记录（${fact.objectId} ${fact.attribute}）：${(error as Error).message}`); continue; }
      const supersedes = fact.supersedes && (written.has(fact.supersedes) || db.prepare('SELECT 1 FROM project_fact WHERE id = ?').get(ids.id(fact.supersedes)))
        ? ids.id(fact.supersedes) : null;
      insertFact.run(id, projectId, record.objectId, record.attribute, JSON.stringify(record.value ?? null), record.source.type, record.source.ref,
        JSON.stringify(record.locator ?? {}), record.inputFingerprint ?? null, record.observer, record.observedAt!, record.status, record.evidenceLevel,
        record.confidence ?? null, record.scope, JSON.stringify(invalidation), record.shareLayer, supersedes, fact.recordedAt);
      written.add(fact.id);
      counts.facts++;
      counts[`facts${fact.shareLayer}`] = (counts[`facts${fact.shareLayer}`] ?? 0) + 1;
    }

    // The classification registry: what the sender's people and scans registered stays registered here.
    const registrations: NewEntry[] = (docs.registry?.entries ?? []).flatMap(group => group.paths.map(path => ({ order: path.order,
      entry: { path: path.path, match: path.match as 'file' | 'tree', category: group.category, shareLayer: group.layer as NewEntry['shareLayer'],
        rights: group.rights as NewEntry['rights'], sensitivity: group.sensitivity as NewEntry['sensitivity'],
        source: { type: group.source.type as NewEntry['source']['type'], ref: group.source.ref }, sha256: path.sha256, restore: group.restore, reason: group.reason } })))
      .sort((a, b) => a.order - b.order).map(item => item.entry);
    const valid = registrations.filter(entry => {
      try { validateEntry(entry); return true; }
      catch (error) { check.warnings.push(`跳过一条无法登记的分类（${entry.path}）：${(error as Error).message}`); return false; }
    });
    counts.registrations += registerEntries(db, projectId, valid);

    // Workflows: frozen definitions bound to the matching pack here; one whose pack is missing waits (no definition yet,
    // so the scheduler does not run it) until the pack is installed.
    const decisions = new Map((docs.decisions?.workflows ?? []).map(item => [item.workflowId, item]));
    const requests = new Map((docs.sensitive?.manifests ?? []).map(item => [item.workflowId, item.request]));
    for (const workflow of docs.workflows) {
      const id = ids.id(workflow.id);
      const plan = check.packs.find(item => item.workflowId === workflow.id);
      const current = decisions.get(workflow.id)?.currentPlan ?? {};
      const exists = db.prepare('SELECT 1 FROM workflow WHERE id = ?').get(id);
      if (exists) db.prepare('UPDATE workflow SET status = ?, plan_json = ? WHERE id = ?').run(workflow.status, JSON.stringify(current), id);
      else db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, projectId, workflow.processId, workflow.processHash, workflow.knowledgeVersion, workflow.status, JSON.stringify(current));
      counts.workflows++;
      const manifestJson = frozenManifest(workflow, root, requests.get(workflow.id));
      if (db.prepare('SELECT 1 FROM workflow_definition WHERE workflow_id = ?').get(id)) continue;
      const content = plan?.root ? frozenContent(plan.root, workflow.tools, workflow.contexts) : undefined;
      if (content?.ok || plan?.resolution === 'history') {
        insertDefinition(db, id, workflow, manifestJson, content?.ok ? content.contexts : {}, content?.ok ? join(plan!.root!, 'tools') : '', variables(env, workflow));
        if (content?.ok) pathChanges.push(`制作流程 ${id.slice(0, 8)} 的工具与上下文改用本机的能力包：${plan!.root}`);
      } else pending.push({ workflowId: id, reason: plan?.text ?? '缺少能力包', requirement: plan?.requirement ?? { id: null, version: null, channel: null, contentHash: null },
        frozen: { ...workflow, id }, manifest: manifestJson });
    }
    const latest = docs.workflows.find(workflow => workflow.current);
    const wf = latest ? ids.id(latest.id) : undefined;
    const decisionDoc = latest ? decisions.get(latest.id) : undefined;
    // The current plan's revision (older revisions travel as hashes in the archive document only).
    const lastPlan = decisionDoc?.plans.at(-1);
    if (wf && lastPlan && !db.prepare('SELECT 1 FROM plan_revision WHERE workflow_id = ? AND hash = ? AND observed_at = ?').get(wf, lastPlan.hash, lastPlan.observedAt))
      db.prepare('INSERT INTO plan_revision (workflow_id, hash, content_json, error, observed_at) VALUES (?, ?, ?, ?, ?)').run(wf, lastPlan.hash,
        lastPlan.error || !decisionDoc?.currentPlan ? null : JSON.stringify(decisionDoc.currentPlan), lastPlan.error || !decisionDoc?.currentPlan ? (lastPlan.error ?? '方案内容未随档案保存') : null,
        lastPlan.observedAt);
    const evidence = docs.evidence;
    if (wf && evidence?.workflowId === latest!.id) {
      for (const artifact of [...evidence.artifacts].sort((a, b) => a.order - b.order))
        if (!db.prepare('SELECT 1 FROM artifact_version WHERE workflow_id = ? AND kind = ? AND hash = ? AND observed_at = ?').get(wf, artifact.kind, artifact.hash ?? '', artifact.observedAt))
          db.prepare('INSERT INTO artifact_version (workflow_id, kind, hash, observed_at) VALUES (?, ?, ?, ?)').run(wf, artifact.kind, artifact.hash ?? '', artifact.observedAt);
      for (const verdict of evidence.verdicts) {
        const id = ids.verdict(verdict.id);
        if (db.prepare('SELECT 1 FROM verdict WHERE id = ?').get(id)) continue;
        db.prepare(`INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result, basis, input_hashes_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, wf, verdict.checkId, verdict.scope, verdict.artifactHash, verdict.result, verdict.basis, verdict.inputHashes ? JSON.stringify(verdict.inputHashes) : null, verdict.recordedAt);
        counts.verdicts++;
      }
    }
    for (const workflow of docs.workflows) {
      const id = ids.id(workflow.id), doc = decisions.get(workflow.id);
      for (const gate of [...(doc?.gates ?? [])].sort((a, b) => a.order - b.order)) {
        if (db.prepare('SELECT 1 FROM gate_decision WHERE workflow_id = ? AND gate_id = ? AND artifact_hash = ? AND recorded_at = ?').get(id, gate.gateId, gate.artifactHash, gate.recordedAt)) continue;
        db.prepare('INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result, input_hashes_json, selection_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, gate.gateId, gate.artifactHash,
          ['approved', 'chosen', 'done'].includes(gate.result) ? gate.result : 'approved', gate.inputHashes ? JSON.stringify(gate.inputHashes) : null, gate.selection ? JSON.stringify(gate.selection) : null, gate.recordedAt);
        counts.decisions++;
      }
    }

    // Tasks and Runs: a Run's outcome on another machine is not known here.
    const stageCodes = new Map((docs.state.workflow?.stages ?? []).map(stage => [stage.id, stage.codes ?? []]));
    const runs = docs.events?.runs ?? [];
    const taskChanges: Array<{ id: string; workflowId: string; from: string; to: string; reason: string }> = [];
    for (const task of docs.state.tasks.filter(item => item.formal && docs.workflows.some(workflow => workflow.id === item.workflowId))) {
      const workflow = docs.workflows.find(item => item.id === task.workflowId)!;
      const stage = workflow.definition.stages.find(item => item.id === task.stage);
      if (!stage) continue;
      const id = ids.id(task.id), workflowId = ids.id(task.workflowId);
      const mapped = restoredTaskStatus(task.status, workflow.current ? stageCodes.get(task.stage) ?? [] : []);
      const capability = workflow.capabilities?.stages?.[task.stage] as { maxRetries?: number; maxCheckRetries?: number } | undefined;
      const existing = db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string } | undefined;
      if (existing) { if (existing.status !== mapped.status) db.prepare('UPDATE task SET status = ? WHERE id = ?').run(mapped.status, id); }
      else db.prepare(`INSERT INTO task (id, workflow_id, stage_id, goal, capability, expected_outputs_json, retry_policy_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, workflowId, task.stage, `Complete stage ${task.stage}`, task.stage, JSON.stringify(stage.produces),
          JSON.stringify({ maxRetries: capability?.maxRetries ?? 0, maxCheckRetries: capability?.maxCheckRetries ?? 0 }), mapped.status);
      if (!existing || existing.status !== mapped.status) taskChanges.push({ id, workflowId, from: task.status, to: mapped.status, reason: mapped.reason });
      counts.tasks++;
      const own = runs.filter(run => run.taskId === task.id).sort((a, b) => a.attempt - b.attempt);
      for (const run of own) {
        const runId = ids.id(run.id);
        if (db.prepare('SELECT 1 FROM run WHERE id = ? OR (task_id = ? AND attempt = ?)').get(runId, id, run.attempt)) continue;
        const finished = run.exitStatus !== null || run.errorClass !== null;
        db.prepare('INSERT INTO run (id, task_id, attempt, status, provider, process_ref, result_json) VALUES (?, ?, ?, ?, ?, NULL, ?)').run(runId, id, run.attempt,
          ['pending', 'running'].includes(run.status) ? 'restored' : run.status, run.provider,
          finished ? JSON.stringify({ exitStatus: run.exitStatus, ...(run.errorClass ? { errorClass: run.errorClass } : {}), outputs: {}, restored: true }) : null);
        counts.runs++;
      }
      // A Task to be reconciled needs a Run to reconcile: one stands in for the Run that happened elsewhere.
      if (mapped.status === 'RECOVERY_REQUIRED' && !db.prepare('SELECT 1 FROM run WHERE task_id = ?').get(id)
        && !docs.production?.snapshots.some(snapshot=>snapshot.task_id===task.id)) {
        db.prepare("INSERT INTO run (id, task_id, attempt, status, provider, process_ref, result_json) VALUES (?, ?, ?, 'restored', NULL, NULL, NULL)")
          .run(randomUUID(), id, Math.max(1, task.attempts));
        counts.runs++;
      }
    }
    if (wf && evidence?.workflowId === latest!.id) {
      // Warnings a person accepted: derived facts of the latest Workflow, re-attached to the verdict they accepted.
      for (const fact of docs.facts.filter(item => item.source.type === 'workflow' && item.attribute === 'warningAccepted' && item.scope === `workflow:${latest!.id}`)) {
        const checkId = fact.objectId.slice('check:'.length);
        const verdict = [...evidence.verdicts].filter(item => item.checkId === checkId && item.artifactHash === fact.inputFingerprint && item.recordedAt <= fact.recordedAt).at(-1);
        if (!verdict) continue;
        const verdictId = ids.verdict(verdict.id);
        if (db.prepare('SELECT 1 FROM warning_acceptance WHERE workflow_id = ? AND verdict_id = ? AND recorded_at = ?').get(wf, verdictId, fact.recordedAt)) continue;
        db.prepare('INSERT INTO warning_acceptance (workflow_id, verdict_id, recorded_at) VALUES (?, ?, ?)').run(wf, verdictId, fact.recordedAt);
      }
      // Writes a stage made outside its artifacts hold that stage for a person here as well.
      const outside = evidence.outOfBounds ?? (docs.state.workflow?.stages ?? []).flatMap(stage => stage.reasons
        .map(reason => /^out-of-bounds change: (.+)$/.exec(reason)?.[1]).filter((artifact): artifact is string => Boolean(artifact))
        .map((artifact, order) => ({ order, stage: stage.id, artifact, accepted: false, recordedAt: new Date(0).toISOString() })));
      for (const change of outside) {
        if (db.prepare('SELECT 1 FROM out_of_bounds_change WHERE workflow_id = ? AND stage_id = ? AND artifact = ? AND recorded_at = ?').get(wf, change.stage, change.artifact, change.recordedAt)) continue;
        db.prepare('INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact, accepted, recorded_at) VALUES (?, ?, ?, ?, ?)').run(wf, change.stage, change.artifact,
          change.accepted ? 1 : 0, change.recordedAt);
      }
    }

    // History: the events that came along (process records, B; people's own words, C), then what the restore did.
    const workflowIds = new Set(docs.workflows.map(workflow => workflow.id));
    const history = [...(docs.events?.events ?? []), ...(docs.sensitive?.humanEvents ?? [])]
      .filter(event => event.workflowId === null || workflowIds.has(event.workflowId)).sort((a, b) => a.order - b.order);
    const insertEvent = db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const selected=restoreStageContracts(db,projectId,root,env.home,docs.production?.stageContracts??[],old=>ids.id(old),name=>variableValue(env,name));
    if(docs.production)docs.production.missingInputs=[...(docs.production.missingInputs??[]),...selected.missing];
    const eventSequences = selected.sequences;
    const seen = db.prepare(`SELECT seq FROM event WHERE occurred_at = ? AND actor = ? AND entity_type = ? AND entity_id = ? AND action = ? LIMIT 1`);
    const gateEntity = (id: string): string => { const at = id.lastIndexOf(':'); return at > 0 ? `${ids.id(id.slice(0, at))}${id.slice(at)}` : ids.id(id); };
    for (const event of history) {
      if(docs.production?.stageContracts && event.entityType==='stage_contract' && event.action==='selected')continue;
      const entityId = event.entityType === 'gate' ? gateEntity(event.entityId) : ids.entity(event.entityId);
      const existingEvent = seen.get(event.at,event.actor,event.entityType,entityId,event.action);
      if (existingEvent) { eventSequences.set(event.order,Number(existingEvent.seq)); continue; }
      insertEvent.run(event.workflowId ? ids.id(event.workflowId) : null, event.actor, event.entityType, entityId, event.action, event.reason || '（空）',
        JSON.stringify(ids.deep(event.payload ?? {})), event.at);
      eventSequences.set(event.order,Number(db.prepare('SELECT last_insert_rowid() AS seq').get()!.seq));
      counts.events++;
    }
    if(docs.production?.stageContracts?.length) {
      const originals=docs.production.snapshots.flatMap(snapshot=>[snapshot.run_id,snapshot.task_id,snapshot.workflow_id,snapshot.workflow_input_revision_id]).concat(docs.production.stageContracts.map(contract=>contract.workflowId)).filter(Boolean);
      docs.production.stageContractRecovery={ids:Object.fromEntries(originals.map(old=>[old,ids.id(old)])),sequences:Object.fromEntries(eventSequences)};
    }
    restoreProductionInputs(db, projectId, root, docs.production, old => ids.id(old), seq => eventSequences.get(seq));
    // Required input snapshots restore their actual Run owners even when optional process records were omitted.
    if (wf && evidence?.workflowId === latest!.id)for (const completion of [...evidence.completions].sort((a, b) => a.order - b.order)) {
      const hashes = JSON.stringify(completion.artifactHashes);
      if (db.prepare('SELECT 1 FROM stage_completion WHERE workflow_id = ? AND stage_id = ? AND artifact_hashes_json = ? AND recorded_at = ?').get(wf, completion.stage, hashes, completion.recordedAt)) continue;
      const run = completion.runId ? ids.id(completion.runId) : null;
      db.prepare('INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json, run_id, recorded_at) VALUES (?, ?, ?, ?, ?)').run(wf, completion.stage, hashes,
        run && db.prepare('SELECT 1 FROM run WHERE id = ?').get(run) ? run : null, completion.recordedAt);
      counts.completions++;
    }
    for (const workflow of docs.workflows) {
      const id = ids.id(workflow.id);
      if (!db.prepare("SELECT 1 FROM event WHERE entity_type = 'workflow' AND entity_id = ? AND action = 'created'").get(id))
        insertEvent.run(id, 'runtime', 'workflow', id, 'created', '从分享包恢复：原创建时间', JSON.stringify({ restoredFrom: manifest.shareId }),
          workflow.current ? docs.state.workflow?.createdAt ?? workflow.frozenAt : workflow.frozenAt);
      for (const rejection of decisions.get(workflow.id)?.rejections ?? []) {
        const entity = `${id}:${rejection.gate}`;
        if (db.prepare(`SELECT 1 FROM event WHERE entity_type = 'gate' AND entity_id = ? AND action = 'rejected' AND json_extract(payload_json, '$.hash') IS ?`).get(entity, rejection.artifactHash)) continue;
        insertEvent.run(id, 'runtime', 'gate', entity, 'rejected', '驳回（原话未随分享提供）', JSON.stringify({ hash: rejection.artifactHash, restoredFrom: manifest.shareId }), rejection.at);
      }
    }
    for (const change of taskChanges) db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json) VALUES (?, 'runtime', 'task', ?, ?, ?, ?)`)
      .run(change.workflowId, change.id, `restored->${change.to}`, change.reason, JSON.stringify({ from: change.from, restoredFrom: manifest.shareId }));

    // The fixed part of the reconciliation, and the event that says a restore happened.
    const report = { shareId: manifest.shareId, archive: { archiveId: manifest.project.archiveId, revision: manifest.project.revision, digest: manifest.project.digest },
      name: manifest.project.name, createdAt: manifest.createdAt, producer: manifest.producer, level: manifest.level, levelText: manifest.levelText,
      levelReasons: manifest.levelReasons, selection: manifest.selection, decision: { kind: decision.kind, action: decision.action, text: decision.text },
      package: { path: check.archive, sha256: check.sha256, bytes: check.bytes }, counts, pathChanges, missing: check.missing,
      packs: check.packs.map(({ root: _root, ...plan }) => plan), projectPacks: check.projectPacks, warnings: check.warnings, backup: input.backup ?? null,
      tasks: taskChanges.filter(change => change.to === 'RECOVERY_REQUIRED').map(change => ({ taskId: change.id, from: change.from })),
      trials: (docs.packs?.trials ?? []).filter(trial => ['approved', 'active'].includes(trial.status)).map(trial => ({ candidateId: trial.candidateId, mode: trial.mode })) };
    db.prepare(`INSERT INTO project_restore (id, project_id, share_id, archive_id, source_revision, source_digest, decision, pending_json, report_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(restoreId, projectId, manifest.shareId, manifest.project.archiveId, manifest.project.revision,
      manifest.project.digest, decision.action === 'none' ? 'copy' : decision.action, JSON.stringify(pending), JSON.stringify(report));
    db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json) VALUES (NULL, 'runtime', 'project', ?, 'restored', ?, ?)`)
      .run(projectId, `从分享包恢复（${{ new: '新项目', update: '更新', copy: '并列副本', none: '' }[decision.action]}）：${LEVEL_TEXT[manifest.level]}`,
        JSON.stringify({ projectId, restoreId, shareId: manifest.shareId, revision: manifest.project.revision }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { projectId, restoreId, pending, counts };
}

function variables(env: RestoreEnvironment, workflow: WorkflowDoc): Record<string, string> {
  return Object.fromEntries(workflow.variables.flatMap(name => { const value = variableValue(env, name); return value ? [[name, value]] : []; }));
}
/** The frozen input Manifest as this machine reads it: project paths here; the customer's words when they came along. */
function frozenManifest(workflow: WorkflowDoc, root: string, request: string | undefined): Record<string, unknown> | null {
  if (!workflow.manifest) return null;
  return { schema: workflow.manifest.schema, profile: workflow.manifest.profile,
    assets: workflow.manifest.assets.map(asset => ({ store: asset.store, item: (asset.location==='project'||asset.location===undefined&&/\//.test(asset.item)) && !asset.item.includes('..') ? join(root, ...asset.item.split('/')) : asset.item,
      ...(asset.sha256?{sha256:asset.sha256}:{}),
      ...(asset.role ? { role: asset.role } : {}), ...(asset.variant ? { variant: asset.variant } : {}), ...(asset.name ? { name: asset.name } : {}) })),
    request: request ?? '（原始需求没有随分享提供：以已批准的方案和已确认的决定为准）', variants: workflow.manifest.variants };
}
function insertDefinition(db: DatabaseSync, id: string, workflow: WorkflowDoc, manifest: Record<string, unknown> | null,
  contexts: Record<string, { sha256: string; content: string }>, toolRoot: string, frozenVariables: Record<string, string>): void {
  db.prepare(`INSERT INTO workflow_definition (workflow_id, profile, definition_json, capabilities_json, thresholds_json, manifest_json, tools_json, contexts_json,
    tool_root, variables_json, frozen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, workflow.profile, JSON.stringify(workflow.definition),
    JSON.stringify(workflow.capabilities), JSON.stringify(workflow.thresholds ?? {}), manifest ? JSON.stringify(manifest) : null, JSON.stringify(workflow.tools),
    JSON.stringify(contexts), toolRoot, JSON.stringify(frozenVariables), workflow.frozenAt);
}

/**
 * A Workflow waiting for its pack still has artifacts in the project: their fingerprints are taken here, so a version
 * that differs from the one the sender recorded (and the approvals of it) shows as changed right away.
 */
function observeDormantArtifacts(db: DatabaseSync, projectId: string, root: string, pending: Pending[]): void {
  for (const item of pending) {
    for (const [kind, spec] of Object.entries(item.frozen.capabilities?.artifacts ?? {}).sort(([a], [b]) => ordinal(a, b))) {
      let hash: string | undefined;
      try { hash = artifactFingerprint(root, spec); } catch { continue; }
      const last = db.prepare('SELECT hash FROM artifact_version WHERE workflow_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1').get(item.workflowId, kind) as { hash: string } | undefined;
      if (!last && !hash) continue;
      if ((last?.hash ?? '') === (hash ?? '')) continue;
      db.prepare('INSERT INTO artifact_version (workflow_id, kind, hash) VALUES (?, ?, ?)').run(item.workflowId, kind, hash ?? '');
      db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json) VALUES (?, 'runtime', 'artifact_version', ?, 'observed', ?, ?)`)
        .run(item.workflowId, kind, '恢复后在本机重新计算的产物指纹与原机记录的不同', JSON.stringify({ hash: hash ?? null, projectId }));
    }
  }
}

/** Project candidate packs: registered here as candidates after their content verifies; never activated or promoted. */
function restoreCandidates(db: DatabaseSync, env: RestoreEnvironment, projectId: string, docs: Docs, manifest: ShareManifest, root: string, docsDir: string,
  check: RestoreCheck): Array<{ id: string; ok: boolean; text: string }> {
  const results: Array<{ id: string; ok: boolean; text: string }> = [];
  for (const pack of manifest.dependencies.projectPacks) {
    const verified = check.projectPacks.find(item => item.id === pack.id);
    if (!verified?.ok) { results.push({ id: pack.id, ok: false, text: verified?.text ?? `本项目候选能力包 ${pack.id} 没有通过校验` }); continue; }
    const source = pack.from.startsWith(PACKS_PREFIX) ? join(docsDir, ...pack.from.slice('share/'.length).split('/').filter(Boolean))
      : join(root, ...pack.from.split('/').filter(Boolean));
    const declared = docs.packs?.candidates?.find(item => item.id === pack.id);
    try {
      const row = registerPackCandidate(db, env.home, source, { basePackId: declared?.basePackId ?? 'unknown', sourceKind: 'import',
        sourceRef: `share:${manifest.shareId}`, reason: '从分享包恢复的本项目候选能力包（需要在本机重新评测）', impact: {}, permissions: declared?.permissions ?? {} });
      if (row.contentHash !== pack.contentHash) { results.push({ id: pack.id, ok: false, text: `本项目候选能力包 ${pack.id} 登记后的内容哈希不一致` }); continue; }
      if (!pack.from.startsWith(PACKS_PREFIX) && !db.prepare('SELECT 1 FROM managed_pack_authoring WHERE candidate_id = ?').get(pack.id)
        && !db.prepare('SELECT 1 FROM managed_pack_authoring WHERE source_root = ?').get(source))
        db.prepare(`INSERT INTO managed_pack_authoring (id, project_id, base_pack_id, candidate_id, source_root, reason, status) VALUES (?, ?, ?, ?, ?, ?, 'registered')`)
          .run(randomUUID(), projectId, declared?.basePackId ?? 'unknown', pack.id, source, '从分享包恢复');
      results.push({ id: pack.id, ok: true, text: `本项目候选能力包 ${pack.id} 已恢复为候选（${row.status}）：需要在本机评测并批准试用后才会用于新的制作流程` });
    } catch (error) { results.push({ id: pack.id, ok: false, text: `本项目候选能力包 ${pack.id} 未通过重验：${(error as Error).message}` }); }
  }
  return results;
}

export interface Reconciliation {
  restoreId: string; at: string;
  decision: { kind: string; action: string; text: string };
  source: { shareId: string; name: string; revision: number; archiveId: string; createdAt: string; harness: string; level: ShareLevel; levelText: string };
  path: string; backup: string | null;
  restored: Record<string, number>;
  pathChanges: string[];
  missing: string[];
  pending: Array<{ workflowId: string; text: string; bound: boolean }>;
  candidates: string[];
  recovery: Array<{ taskId: string; stage: string; text: string }>;
  stale: Array<{ id: string; text: string; because: string[] }>;
  continuable: string[];
  next: string[];
  /** What the receiver can do now: the package's level, lowered by what is still missing here. */
  level: ShareLevel; levelText: string;
  warnings: string[];
}
/** The reconciliation of the project's latest restore: its fixed part, and what the project says now. */
export function restoreReconciliation(db: DatabaseSync, projectId: string): Reconciliation | null {
  const row = db.prepare('SELECT id, pending_json, report_json, created_at FROM project_restore WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(projectId) as
    { id: string; pending_json: string; report_json: string; created_at: string } | undefined;
  if (!row) return null;
  const report = JSON.parse(row.report_json) as { shareId: string; name: string; createdAt: string; producer: { version: string }; level: ShareLevel;
    archive: { archiveId: string; revision: number }; decision: { kind: string; action: string; text: string }; counts: Record<string, number>; pathChanges: string[];
    missing: string[]; warnings: string[]; backup: string | null; trials: Array<{ candidateId: string }> };
  const pending = (JSON.parse(row.pending_json) as Pending[]).map(item => ({ workflowId: item.workflowId, text: item.reason,
    bound: Boolean(db.prepare('SELECT 1 FROM workflow_definition WHERE workflow_id = ?').get(item.workflowId)) }));
  const candidates = (db.prepare(`SELECT reason FROM event WHERE entity_type = 'project_restore' AND entity_id = ? ORDER BY seq`).all(row.id) as Array<{ reason: string }>)
    .map(item => item.reason);
  if (report.trials.length) candidates.push(`原机批准过的本项目试用（${report.trials.map(item => item.candidateId).join('、')}）不随恢复生效：需要在本机重新批准`);
  const recovery = (db.prepare(`SELECT t.id, t.stage_id FROM task t JOIN workflow w ON w.id = t.workflow_id WHERE w.project_id = ? AND t.status = 'RECOVERY_REQUIRED' ORDER BY t.rowid`)
    .all(projectId) as Array<{ id: string; stage_id: string }>).map(task => ({ taskId: task.id, stage: task.stage_id,
      text: `阶段 ${task.stage_id} 在原机上的执行结果无法在本机确认：核对产物后选择“按已完成核对”或“重新执行”` }));
  const overview = projectOverview(db, projectId);
  const stale = overview.stale.map(fact => ({ id: fact.id, text: fact.text, because: fact.staleBecause ?? [] }));
  const workflow = db.prepare(`SELECT w.id FROM workflow w JOIN workflow_definition d ON d.workflow_id = w.id WHERE w.project_id = ? ORDER BY w.rowid DESC LIMIT 1`)
    .get(projectId) as { id: string } | undefined;
  const view = workflow ? describeWorkflow(db, workflow.id) : undefined;
  const continuable = view && !FINAL_WORKFLOW.has(view.status) ? view.stages.filter(stage => ['open', 'running', 'deciding'].includes(stage.display ?? stage.status)
    || (stage.status === 'blocked' && (stage.codes ?? []).every(code => code === 'gate_pending'))).map(stage => stage.id) : [];
  const livePending = pending.filter(item => !item.bound);
  const next: string[] = [];
  if (livePending.length) next.push(`安装制作流程需要的能力包，然后完成恢复（${livePending.length} 个制作流程在等待）`);
  if (recovery.length) next.push(`核对 ${recovery.length} 个在原机未结束的阶段`);
  if (stale.length) next.push(`${stale.length} 项结论的依据已变化，需要重新核对或重新批准`);
  const vpm = overview.missing.filter(item => item.kind === 'vpm');
  if (vpm.length) next.push(`解析 ${vpm.length} 个 VPM 依赖（Harness 可代为执行）`);
  if (view?.next && !FINAL_WORKFLOW.has(view.status)) next.push(view.next);
  const selectionReason=missingStageContractReason(db,projectId);
  if(selectionReason)next.unshift(selectionReason);
  const lowered: ShareLevel = report.level === 'observe_only' ? 'observe_only'
    : livePending.length || report.missing.length || selectionReason ? 'needs_dependencies' : report.level;
  return { restoreId: row.id, at: row.created_at, decision: report.decision,
    source: { shareId: report.shareId, name: report.name, revision: report.archive.revision, archiveId: report.archive.archiveId, createdAt: report.createdAt,
      harness: report.producer.version, level: report.level, levelText: LEVEL_TEXT[report.level] },
    path: localPath(db, projectId) ?? '', backup: report.backup, restored: report.counts, pathChanges: report.pathChanges, missing: report.missing,
    pending, candidates, recovery, stale, continuable:selectionReason?[]:continuable, next, level: lowered, levelText: LEVEL_TEXT[lowered], warnings: report.warnings };
}

/**
 * Bind the Workflows a restore left waiting for their capability pack, now that the pack is on this machine (installed
 * through the update service or the bundled pack). A candidate pack's Workflow waits for an approved trial.
 */
export function completeRestore(db: DatabaseSync, env: RestoreEnvironment, projectId: string): Array<{ workflowId: string; bound: boolean; text: string }> {
  const row = db.prepare('SELECT id, pending_json FROM project_restore WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(projectId) as
    { id: string; pending_json: string } | undefined;
  if (!row) return [];
  const results: Array<{ workflowId: string; bound: boolean; text: string }> = [];
  for (const item of JSON.parse(row.pending_json) as Pending[]) {
    if (db.prepare('SELECT 1 FROM workflow_definition WHERE workflow_id = ?').get(item.workflowId)) { results.push({ workflowId: item.workflowId, bound: true, text: '已绑定' }); continue; }
    const wanted = item.requirement.id && item.requirement.version && item.requirement.contentHash
      ? { id: item.requirement.id, version: item.requirement.version, contentHash: item.requirement.contentHash } : undefined;
    let packRoot: string | undefined;
    if (item.requirement.channel === 'candidate' || item.frozen.knowledgeVersion.startsWith('candidate:')) {
      const candidateId = item.frozen.knowledgeVersion.split(':')[1] ?? item.requirement.id;
      const trial = db.prepare(`SELECT t.content_hash, c.root FROM managed_pack_trial t JOIN managed_pack_candidate c ON c.id = t.candidate_id
        WHERE t.project_id = ? AND t.candidate_id = ? AND t.status IN ('approved', 'active') ORDER BY t.created_at DESC LIMIT 1`).get(projectId, candidateId) as
        { content_hash: string; root: string } | undefined;
      if (trial && (!item.requirement.contentHash || trial.content_hash === item.requirement.contentHash)) packRoot = trial.root;
      else { results.push({ workflowId: item.workflowId, bound: false, text: `本项目候选能力包 ${candidateId} 还没有在本机批准试用` }); continue; }
    } else if (wanted) packRoot = managedPacks(env.home).map(pack => packAt(pack.root)).find((pack): pack is PackIdentity => Boolean(pack) && samePack(pack!, wanted))?.root;
    if (!packRoot) { results.push({ workflowId: item.workflowId, bound: false, text: `本机还没有能力包 ${item.requirement.id ?? ''} ${item.requirement.version ?? ''}` }); continue; }
    const content = frozenContent(packRoot, item.frozen.tools, item.frozen.contexts);
    if (!content.ok) { results.push({ workflowId: item.workflowId, bound: false, text: `能力包与冻结内容不一致：${content.problem}` }); continue; }
    db.exec('BEGIN IMMEDIATE');
    try {
      insertDefinition(db, item.workflowId, item.frozen, item.manifest, content.contexts, join(packRoot, 'tools'), variables(env, item.frozen));
      db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json) VALUES (?, 'runtime', 'workflow', ?, 'restore_bound', ?, ?)`)
        .run(item.workflowId, item.workflowId, `能力包已就绪，制作流程恢复完成：${packRoot}`, JSON.stringify({ projectId, restoreId: row.id }));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    results.push({ workflowId: item.workflowId, bound: true, text: '能力包已就绪，制作流程可以继续' });
  }
  const retained=db.prepare('SELECT document_json FROM production_archive_reference WHERE project_id=?').get(projectId);
  if(retained)inTransaction(db,()=>{
    const document=JSON.parse(String(retained.document_json)) as ProductionInputDocument;
    if(!document.stageContracts?.length)return;
    const ids=document.stageContractRecovery?.ids??{};
    const mapped=(old:string)=>ids[old]??old;
    const selected=restoreStageContracts(db,projectId,localPath(db,projectId)!,env.home,document.stageContracts,mapped,name=>variableValue(env,name));
    const sequences=new Map(Object.entries(document.stageContractRecovery?.sequences??{}).map(([old,local])=>[Number(old),local]));
    for(const [old,local] of selected.sequences)sequences.set(old,local);
    const prior=document.missingInputs??[];
    const inputs=document.snapshots.filter(snapshot=>prior.includes(`stage-contract:${snapshot.run_id}`));
    const problems:string[]=[];
    restoreProductionRunInputs(db,projectId,inputs,mapped,seq=>selected.sequences.get(seq),problems);
    const recovered=new Set<string>();
    for(const contract of document.stageContracts)if(selected.sequences.has(contract.seq))recovered.add(`stage-contract-input:${contract.workflowId}:${contract.seq}`);
    for(const input of inputs) {
      const restored=db.prepare('SELECT stage_tool_selection_json,effective_plan_sha256,manual_values_sha256 FROM run_input_snapshot WHERE run_id=?').get(mapped(input.run_id));
      const originalSelection=JSON.parse(input.stage_tool_selection_json);
      if(restored && selected.sequences.has(originalSelection.selectionSeq) && JSON.parse(String(restored.stage_tool_selection_json)).selectionSeq===selected.sequences.get(originalSelection.selectionSeq)
        && restored.effective_plan_sha256===input.effective_plan_sha256 && restored.manual_values_sha256===input.manual_values_sha256)recovered.add(`stage-contract:${input.run_id}`);
    }
    document.stageContractRecovery={ids,sequences:Object.fromEntries(sequences)};
    document.missingInputs=[...new Set([...prior.filter(key=>!recovered.has(key)),...selected.missing,...problems])];
    document.recoveredMissingInputs=[...new Set([...(document.recoveredMissingInputs??[]),...prior.filter(key=>recovered.has(key))])];
    db.prepare('UPDATE production_archive_reference SET document_json=? WHERE project_id=?').run(JSON.stringify(document),projectId);
    for(const contract of document.stageContracts)results.push({workflowId:mapped(contract.workflowId),bound:selected.sequences.has(contract.seq),
      text:selected.sequences.has(contract.seq)?`已采用的修复包 ${contract.pack?.id??''} 已完成恢复`:missingStageContractReason(db,projectId)!});
  });
  return results;
}

/** Search the project's conversation (restored or local): matching messages, never fed to an agent by this. */
export function searchConversation(db: DatabaseSync, projectId: string, query: string): Array<{ id: string; role: string; status: string; at: string; excerpt: string }> {
  const needle = query.trim();
  if (!needle) return [];
  const escaped = needle.replace(/[\\%_]/g, '\\$&');
  return (db.prepare(`SELECT id, role, status, content, created_at FROM project_message WHERE project_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY created_at, rowid LIMIT 100`)
    .all(projectId, `%${escaped}%`) as Array<{ id: string; role: string; status: string; content: string; created_at: string }>).map(row => {
    const at = row.content.indexOf(needle);
    const start = Math.max(0, at - 40);
    return { id: row.id, role: row.role, status: row.status, at: row.created_at,
      excerpt: `${start > 0 ? '…' : ''}${row.content.slice(start, at + needle.length + 60)}${at + needle.length + 60 < row.content.length ? '…' : ''}` };
  });
}

