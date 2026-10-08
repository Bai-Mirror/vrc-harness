import { ensureProductionBaseline, productionDispatchBlocked, productionStageDispatchAllowed } from '../production-face-continuation.ts';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml, parseDocument, stringify } from 'yaml';
import { refreshAssetSearchRoots, type LocalConfig } from '../config.ts';
import { hostArgv, hostPlatform, rejectCloudSyncedPath } from '../host-platform.ts';
import type { ProcessDefinition, Stage } from '../process/types.ts';
import { planValue } from '../process/aggregate.ts';
import { faceSelectionForDispatch, validateFaceChoice, validateFaceAcceptance, type FaceChoiceInput, type FaceAcceptanceInput } from '../face-selection.ts';
import type { RuleValue } from '../process/rule.ts';
import { ProviderRegistry } from '../providers/registry.ts';
import { routeProviders } from '../providers/routing.ts';
import { harnessVersion, knowledgeVersion } from '../provenance.ts';
import type { Executor, Fingerprinter, Observation as RunObservation, RunHandle, RunResult, RunSpec } from '../runtime/interfaces.ts';
import { Scheduler, type CancelResult, type CycleRuntime } from '../runtime/scheduler.ts';
import { aggregateWorkflow, buildAggregateInput } from '../state/aggregate-input.ts';
import { DEFAULT_REDO_NOTE } from '../runtime/transitions.ts';
import { withStateEvent } from '../state/tx.ts';
import { inTransaction } from '../archive/facts.ts';
import { projectRoot } from '../archive/takeover.ts';
import { physicalWorkspace, physicalProject } from '../project-identity.ts';
import { allowedTaskPath, TaskRouter, type TaskSpec } from '../task-cli.ts';
import { compileContextPlan, contextConditionMatches, materializeContextGoal, type FrozenContextItem, type FrozenContextPlan } from './context-compiler.ts';
import { artifactMembers, memberChange, membersFingerprint, type MemberChange } from './artifacts.ts';
import { pendingNativeImport } from './native-import.ts';
import { projectStageToolInputs, recordRunStageContract, selectedStageContract } from './stage-contract.ts';
import { manifestToolReferences, manifestVariableReferences, OBSERVATIONS_DIR, toolReferences, type CapabilityManifest } from './capabilities.ts';
import { ObservationVerifier } from './observe.ts';
import { configuredUnityEditor } from '../exec/unity-launcher.ts';
import { unityEditorProblem } from '../unity-editors.ts';
import { compactProjectContext, projectContextFacts, projectState, type DurableProjectState } from '../project-state.ts';
import { parseIntentSnapshot, type IntentItem } from '../project-intent.ts';
import { parseImageInputs, verifiedImageInputs, type ImageInput } from '../image-inputs.ts';
import { activateCandidateTrial, approvedCandidateTrial, candidateTrialConfig, packCandidate } from '../managed-pack-candidate.ts';
import { localWorkflowSelection } from '../local-maintenance.ts';
import { resolveWorkflowInput, readRunInputSnapshot } from './inputs.ts';
import { evidenceFresh, evidenceInputHashes } from '../process/evidence.ts';
import { projectRecolorPreview } from '../stage-photos.ts';
import { activateFaceInput } from './inputs.ts';
import { facePreference } from '../face-policy.ts';

/** Input Manifest v0.1: which materials a Workflow starts from, and the user's request in their own words. */
export interface ManifestInput {
  schema: 'manifest/0.1';
  profile: string;
  /** `item` is a product number of the asset library, or for projects made in Harness the path of one file; `name` is for people. */
  assets: Array<{ store: 'library' | 'client'; item: string; role?: 'body' | 'outfit' | 'texture' | 'other'; variant?: string; name?: string; sha256?: string }>;
  request: string;
  faceConcept?: string;
  /** Frozen interpretations with user-source references; these never grant execution permissions. */
  requirements?: IntentItem[];
  /** Actual visual inputs frozen with the proposal, independent of importable material selection. */
  referenceImages?: ImageInput[];
  variants?: Array<{ id: string; name: string; description: string;
    assets: Array<{ item: string; role: 'candidate' | 'source' | 'used' }> }>;
}
export interface WorkflowSnapshot {
  workflowId: string;
  profile: string;
  definition: ProcessDefinition;
  capabilities: CapabilityManifest;
  thresholds: Record<string, RuleValue>;
  manifest?: ManifestInput;
  /** sha256 of each tool-root file the stages and observers run, as frozen at creation. */
  tools: Record<string, string>;
  /** Immutable tool directory selected when the Workflow was created. */
  toolRoot: string;
  /** Validated machine inputs selected at creation; capability placeholders resolve only from here. */
  variables: Record<string, string>;
  /** Exact Harness-selected knowledge text and digest, frozen per relative path. */
  contexts: Record<string, { sha256: string; content: string }>;
  frozenAt: string;
}
export type WorkflowStatus = 'active' | 'upload_ready' | 'client_verified' | 'cancelled';

/** The exact JSON representation persisted in workflow_definition.definition_json. */
export function serializeWorkflowDefinition(definition: ProcessDefinition): string {
  return JSON.stringify(definition);
}

/** Fork exactly the reviewed snapshot; creating a candidate must not consult active packages or change the logical head. */
export function forkFrozenWorkflow(db: DatabaseSync, predecessor: string, projectId: string, workflowId: string,
  snapshot: WorkflowSnapshot = workflowSnapshot(db, predecessor)): void {
  if (!db.isTransaction) throw new Error('A frozen workflow fork requires the publication transaction');
  const source = db.prepare('SELECT process_id,process_hash,knowledge_version,plan_json FROM workflow WHERE id=?').get(predecessor);
  if (!source) throw new Error('The predecessor workflow is missing');
  const original = workflowSnapshot(db, predecessor);
  const changed = canonicalWorkflowContract(snapshot) !== canonicalWorkflowContract(original);
  const hash = changed ? digest(canonicalWorkflowContract(snapshot)) : String(source.process_hash);
  db.prepare(`INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json)
    VALUES(?,?,?,?,?,'active',?)`).run(workflowId, projectId, snapshot.profile, hash,
      changed ? `successor:${hash}` : source.knowledge_version!, source.plan_json!);
  db.prepare(`INSERT INTO workflow_definition(workflow_id,profile,definition_json,capabilities_json,thresholds_json,
    manifest_json,tools_json,contexts_json,tool_root,variables_json,frozen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(workflowId,snapshot.profile,serializeWorkflowDefinition(snapshot.definition),JSON.stringify(snapshot.capabilities),JSON.stringify(snapshot.thresholds),
      snapshot.manifest ? JSON.stringify(snapshot.manifest) : null,JSON.stringify(snapshot.tools),JSON.stringify(snapshot.contexts),snapshot.toolRoot,JSON.stringify(snapshot.variables),snapshot.frozenAt);
  db.prepare('INSERT INTO provider_snapshot SELECT ?,snapshot_json,frozen_at FROM provider_snapshot WHERE workflow_id=?').run(workflowId,predecessor);
}

function canonicalWorkflowContract(snapshot: WorkflowSnapshot): string {
  return JSON.stringify({definition:snapshot.definition,capabilities:snapshot.capabilities,thresholds:snapshot.thresholds,
    manifest:snapshot.manifest,tools:snapshot.tools,contexts:snapshot.contexts,toolRoot:snapshot.toolRoot,variables:snapshot.variables});
}
type FormalTaskRow = { id: string; workflow_id: string; project_id: string; project_path: string; status: string;
  goal: string; plan_json: string; process_hash: string; stage_id: string };

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
/** A tool changed after the Workflow froze it: running it would silently change what a stage does or measures. */
export function verifyTools(toolRoot: string, frozen: Record<string, string>, paths: string[]): void {
  for (const path of paths) {
    let current: string | undefined;
    try { current = digest(readFileSync(join(toolRoot, path))); } catch { current = undefined; }
    if (current !== frozen[path])
      throw new Error(`工具 ${path} 在 Workflow 创建后${current ? '被修改' : '不见了'}；要改用新版本，需要迁移这个 Workflow`);
  }
}

export function parseManifest(text: string, profile?: string): ManifestInput {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Manifest: ${doc.errors.map(error => error.message).join('; ')}`);
  const raw = doc.toJS() as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Manifest: 应为映射');
  if (raw.schema !== 'manifest/0.1') throw new Error('Manifest: schema 应为 manifest/0.1');
  if (typeof raw.profile !== 'string' || !raw.profile) throw new Error('Manifest: 缺少 profile');
  if (profile && raw.profile !== profile) throw new Error(`Manifest: profile 为 ${raw.profile}，与 --profile ${profile} 不一致`);
  if (!Array.isArray(raw.assets) || !raw.assets.length) throw new Error('Manifest: assets 至少一项');
  const assets = raw.assets.map((entry, i) => {
    const item = entry as Record<string, unknown>;
    if (!item || typeof item !== 'object') throw new Error(`Manifest: assets[${i}] 应为映射`);
    if (item.store !== 'library' && item.store !== 'client') throw new Error(`Manifest: assets[${i}].store 应为 library 或 client`);
    if (typeof item.item !== 'string' || !item.item) throw new Error(`Manifest: assets[${i}].item 应为非空字符串`);
    if (item.role !== undefined && !['body', 'outfit', 'texture', 'other'].includes(item.role as string)) throw new Error(`Manifest: assets[${i}].role 无效`);
    if (item.variant !== undefined && (typeof item.variant !== 'string' || !item.variant)) throw new Error(`Manifest: assets[${i}].variant 应为非空字符串`);
    if (item.name !== undefined && typeof item.name !== 'string') throw new Error(`Manifest: assets[${i}].name 应为字符串`);
    if (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)))
      throw new Error(`Manifest: assets[${i}].sha256 无效`);
    return { store: item.store as 'library' | 'client', item: item.item,
      ...(item.role ? { role: item.role as 'body' | 'outfit' | 'texture' | 'other' } : {}),
      ...(item.variant ? { variant: item.variant as string } : {}),
      ...(item.sha256 ? { sha256: item.sha256 as string } : {}),
      ...(typeof item.name === 'string' && item.name.trim() ? { name: item.name.trim() } : {}) };
  });
  if (typeof raw.request !== 'string' || !raw.request.trim()) throw new Error('Manifest: request 应为用户原话');
  if (raw.faceConcept !== undefined && typeof raw.faceConcept !== 'string') throw new Error('Manifest: faceConcept 应为字符串');
  let variants: ManifestInput['variants'];
  if (raw.variants !== undefined) {
    if (!Array.isArray(raw.variants)) throw new Error('Manifest: variants 应为列表');
    const ids = new Set<string>();
    variants = raw.variants.map((entry, i) => {
      const item = entry as Record<string, unknown>;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`Manifest: variants[${i}] 应为映射`);
      for (const key of ['id', 'name']) if (typeof item[key] !== 'string' || !(item[key] as string).trim())
        throw new Error(`Manifest: variants[${i}].${key} 应为非空字符串`);
      if (ids.has(item.id as string)) throw new Error(`Manifest: variants[${i}].id 重复`);
      ids.add(item.id as string);
      if (item.description !== undefined && typeof item.description !== 'string') throw new Error(`Manifest: variants[${i}].description 应为字符串`);
      if (!Array.isArray(item.assets)) throw new Error(`Manifest: variants[${i}].assets 应为列表`);
      const variantAssets = item.assets.map((asset, j) => {
        const relation = asset as Record<string, unknown>;
        if (!relation || typeof relation !== 'object' || typeof relation.item !== 'string' || !relation.item)
          throw new Error(`Manifest: variants[${i}].assets[${j}].item 应为非空字符串`);
        if (!['candidate', 'source', 'used'].includes(String(relation.role)))
          throw new Error(`Manifest: variants[${i}].assets[${j}].role 无效`);
        return { item: relation.item, role: relation.role as 'candidate' | 'source' | 'used' };
      });
      return { id: item.id as string, name: item.name as string, description: String(item.description ?? ''), assets: variantAssets };
    });
  }
  return { schema: 'manifest/0.1', profile: raw.profile, assets, request: raw.request,
    ...(raw.requirements === undefined ? {} : {requirements:parseIntentSnapshot(raw.requirements)}),
    ...(raw.referenceImages === undefined ? {} : {referenceImages:parseImageInputs(raw.referenceImages)}),
    ...(raw.faceConcept ? { faceConcept: raw.faceConcept as string } : {}), ...(variants ? { variants } : {}) };
}

function projectDirectory(config: LocalConfig, name: string): string {
  const path = realpathSync(resolve(config.workspaceRoot, name));
  if (!relative(config.workspaceRoot, path) || !hostPlatform.within(config.workspaceRoot, path) || !statSync(path).isDirectory())
    throw new Error('项目必须位于 workspaceRoot 内');
  rejectCloudSyncedPath(path);
  if (!existsSync(join(path, '.git'))) throw new Error('项目必须是独立 Git 仓库（每项目一个仓库）');
  return path;
}
function ensureProject(db: DatabaseSync, config: LocalConfig, path: string): string {
  return inTransaction(db, () => {
    const workspace = realpathSync(config.workspaceRoot);
    let ws = physicalWorkspace(db, workspace);
    if (!ws) {
      const id = randomUUID(); withStateEvent(db, { actor: 'human', entityType: 'workspace', entityId: id, action: 'registered', reason: 'workflow create' },
        () => db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run(id, workspace));
      ws = { id, path: workspace };
    }
    const found = physicalProject(db, ws.id, ws.path, path);
    if (found) return found.id;
    const id = randomUUID(); withStateEvent(db, { actor: 'human', entityType: 'project', entityId: id, action: 'registered', reason: 'workflow create' },
      () => db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
        VALUES (?, ?, 'sample', ?, '{}', 'active', ?, ?)`).run(id, ws!.id, path, harnessVersion(), knowledgeVersion(config)));
    return id;
  });
}
/** Ignored in every Harness-created Unity project: editor caches, and the isolated build copies stages make. */
export const PROJECT_GITIGNORE = ['/[Ll]ibrary/', '/[Tt]emp/', '/[Oo]bj/', '/[Bb]uild/', '/[Bb]uilds/', '/[Ll]ogs/',
  '/_harness/environment/cache/', '/_harness/environment/candidates/',
  '/[Uu]ser[Ss]ettings/', '/[Mm]emoryCaptures/', '/[Rr]ecordings/', '*.csproj', '*.sln', '*.pidb', '*.booproj', '*.svd',
  '*.userprefs', '*.unityproj', '.vs/', '.idea/', '.vscode/', '/_harness_build/',
  // NDMF writes its build-time assets here while an avatar is processed, and deletes them afterwards.
  '/Packages/nadena.dev.ndmf/__Generated/', '/Packages/nadena.dev.ndmf/__Generated.meta',
  '/Assets/ZZZ_GeneratedAssets/', '/Assets/ZZZ_GeneratedAssets.meta',
  // lilToon rewrites its render pipeline / graphics API cache on every editor load (machine-specific, e.g. Vulkan);
  // left visible, every stage that opens Unity would appear to write outside its allowed paths.
  '/Packages/jp.lilxyzw.liltoon/Editor/CurrentRP.txt', ''].join('\n');

/**
 * A new, empty project for Harness to build: a directory in the workspace with its own Git repository and an
 * initial commit, so every later write is attributable. Refuses an existing directory.
 */
export function createProject(config: LocalConfig, name: string): string {
  if (!/^[^/\\:*?"<>|\x00-\x1f]+$/.test(name) || name === '.' || name === '..' || name.startsWith('.'))
    throw new Error(`工程名不能含路径分隔符或特殊字符: ${name}`);
  const path = join(config.workspaceRoot, name);
  if (existsSync(path)) throw new Error(`已存在: ${path}`);
  rejectCloudSyncedPath(path);
  mkdirSync(path);
  writeFileSync(join(path, '.gitignore'), PROJECT_GITIGNORE);
  const git = (...args: string[]) => execFileSync(hostPlatform.toolCommand('git'), ['-C', path, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  git('init', '-q');
  git('add', '.gitignore');
  git('-c', 'user.name=Avatar Harness', '-c', 'user.email=harness@localhost', 'commit', '-q', '-m', 'Create project');
  return path;
}

/**
 * Start a formal Workflow for a project: freeze the definition, capability manifest, thresholds, input
 * Manifest and Provider snapshot. The Workflow then runs only what was frozen here.
 */
export function createWorkflow(db: DatabaseSync, config: LocalConfig, projectName: string, profile: string,
  manifestFile?: string, options: { candidateId?: string } = {}): string {
  const path = projectDirectory(config, projectName);
  const projectId = ensureProject(db, config, path);
  const assertNoActive = (): void => {
    const active = db.prepare(`SELECT id FROM workflow WHERE project_id = ? AND process_hash <> 'avh-task/0.1'
      AND status IN ('active', 'upload_ready') LIMIT 1`).get(projectId) as { id: string } | undefined;
    if (active) throw new Error(`项目已有进行中的正式 Workflow ${active.id}；先完成或取消它`);
  };
  assertNoActive();
  const trial=options.candidateId?approvedCandidateTrial(db,projectId,options.candidateId):undefined;
  const candidate=options.candidateId?packCandidate(db,options.candidateId):undefined;
  if(options.candidateId&&!candidate)throw new Error(`unknown candidate ${options.candidateId}`);
  const local=options.candidateId?undefined:localWorkflowSelection(db,config,projectId,profile);
  const workflowConfig=candidate?candidateTrialConfig(config,candidate,profile):local?.config??config;
  config=workflowConfig;
  const definition = config.definitions[profile];
  if (!definition) throw new Error(`--profile: 未定义 ${profile}`);
  const capabilities = config.capabilities[profile];
  if (!capabilities) throw new Error(`流程 ${profile} 没有配置能力清单（processDefinitions.${profile}.capabilities），不能作为正式 Workflow 运行`);
  const manifest = manifestFile ? parseManifest(readFileSync(manifestFile, 'utf8'), profile) : undefined;
  if (manifest?.referenceImages?.length) verifiedImageInputs(path,manifest.referenceImages);
  const thresholds = Object.fromEntries(Object.entries(config.thresholdValues));
  const tools: Record<string, string> = {};
  for (const path of manifestToolReferences(capabilities)) {
    const file = join(config.toolRoot, path);
    if (!hostPlatform.within(config.toolRoot, file) || !existsSync(file) || !statSync(file).isFile())
      throw new Error(`能力清单引用的工具不存在：{toolRoot}/${path}`);
    tools[path] = digest(readFileSync(file));
  }
  const contexts: WorkflowSnapshot['contexts'] = {};
  for (const relativePath of [...new Set(Object.values(capabilities.stages).flatMap(stage => stage.context.map(item => item.path)))].sort()) {
    const file = join(config.knowledgeRoot, relativePath);
    if (!hostPlatform.within(config.knowledgeRoot, file) || !existsSync(file) || !statSync(file).isFile())
      throw new Error(`能力清单引用的上下文不存在：{knowledgeRoot}/${relativePath}`);
    const content = readFileSync(file, 'utf8');
    contexts[relativePath] = { sha256: digest(content), content };
  }
  const missingVariables = manifestVariableReferences(capabilities).filter(name => !config.workflowVariables[name]);
  if (missingVariables.length) throw new Error(`这个流程需要先在配置管理中设置：${missingVariables.join('、')}`);
  if (!config.providers.length && Object.values(capabilities.stages).some(stage => stage.mode === 'provider'))
    throw new Error('providers: 未配置，流程中有需要执行方的阶段');
  const workflowId = randomUUID();
  const variables = { ...config.workflowVariables };
  const frozen = { definition, capabilities, thresholds, tools, contexts, toolRoot: config.toolRoot, variables };
  const processHash = digest(JSON.stringify(frozen));
  const registry = new ProviderRegistry({ policyVersion: config.providerPolicyVersion, probeTtlMs: config.providerProbeTtlMs,
    routing: config.routing, home: config.home, providers: config.providers });
  const snapshot = { ...registry.snapshot(workflowId), routing: config.routing };
  // Fail now, in words the person can act on, instead of creating a Workflow that waits forever for a route.
  // Quota, balance and concurrency are temporary and dispatch re-checks them, so they do not block creation.
  const roles = [...new Set(Object.values(capabilities.stages).filter(stage => stage.mode === 'provider').map(stage => stage.role ?? 'executor'))];
  const blockers = roles.flatMap(role => {
    const withRole = snapshot.providers.filter(item => item.config.roles.includes(role));
    if (!withRole.length) return [`${role}：没有执行方配置这个角色`];
    return withRole.some(item => item.probe.health === 'ready' && item.probe.auth !== 'missing') ? []
      : [`${role}：${withRole.map(item => item.config.adapter === 'pi-cli' && item.probe.auth === 'missing'
        ? `${item.config.id} 还没有保存 API 密钥（在设置里填写）${item.probe.version ? '' : '，pi 也无法启动'}`
        : `${item.config.id} 在 Runtime 的环境里无法启动或未登录`).join('、')}`];
  });
  if (blockers.length) throw new Error(`暂时无法开始制作：${blockers.join('；')}。请在设置的 AI 连接中检查安装与登录状态；一个可用的制作连接即可承担规划和执行`);
  if (Object.values(capabilities.stages).some(stage => stage.unitySteps?.length)) {
    const where = '在设置里填写 Unity 编辑器（GUI：设置 → 配置管理；TUI：服务页按 e），或在 harness.yaml 的 unity 段写上 editor（Unity 可执行文件的绝对路径）';
    if (!config.unity) throw new Error(`这个流程有 Unity 步骤，但配置里没有 unity 段：请${where}`);
    let editor: string;
    try { editor = configuredUnityEditor(config.unity); }
    catch (error) { throw new Error(`这个流程有 Unity 步骤，但无法确定 Unity 编辑器（${(error as Error).message}）：请${where}`); }
    const problem = unityEditorProblem(editor);
    if (problem) throw new Error(`这个流程有 Unity 步骤，但 Unity 编辑器不可用（${problem}）：请${where}`);
  }
  withStateEvent(db, { workflowId, actor: 'human', entityType: 'workflow', entityId: workflowId, action: 'created',
    reason: `workflow create: ${profile}`, payload: { profile, processHash, manifest: manifestFile ?? null,
      localAdoption:local?{adoptionId:local.adoption.id,candidateId:local.candidate.id,contentHash:local.candidate.contentHash}:null,
      candidateTrial:trial?{trialId:trial.id,candidateId:trial.candidateId,contentHash:trial.contentHash,restrictions:trial.restrictions}:null } }, () => {
    assertNoActive();
    db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
      VALUES (?, ?, ?, ?, ?, 'active', '{}')`).run(workflowId, projectId, profile, processHash,
        trial?`candidate:${trial.candidateId}:${trial.contentHash}`:local?`local:${local.candidate.id}:${local.candidate.contentHash}`:knowledgeVersion(config, profile));
    db.prepare(`INSERT INTO workflow_definition (workflow_id, profile, definition_json, capabilities_json, thresholds_json,
      manifest_json, tools_json, contexts_json, tool_root, variables_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workflowId, profile, serializeWorkflowDefinition(definition),
      JSON.stringify(capabilities), JSON.stringify(thresholds), manifest ? JSON.stringify(manifest) : null, JSON.stringify(tools),
      JSON.stringify(contexts), config.toolRoot, JSON.stringify(variables));
    db.prepare('INSERT INTO provider_snapshot (workflow_id, snapshot_json) VALUES (?, ?)').run(workflowId, JSON.stringify(snapshot));
    const face = facePreference(db, projectId);
    if (profile !== 'manual-face' && capabilities.artifacts.face_input?.source?.kind === 'runtime' && face) activateFaceInput(db, workflowId, { activationId: `created:${workflowId}`,
      mode: face.mode === 'ai' ? 'design' : face.mode === 'manual' && face.acceptedSessionId ? 'manual' : 'preserve',
      ...(face.mode === 'manual' && face.acceptedSessionId ? { manualSessionId: face.acceptedSessionId } : {}) });
    if (profile !== 'manual-face') db.prepare('INSERT INTO production_head(logical_project_id,workflow_id) VALUES(?,?) ON CONFLICT(logical_project_id) DO UPDATE SET workflow_id=excluded.workflow_id').run(projectId,workflowId);
    if(trial)activateCandidateTrial(db,trial.id,workflowId);
  });
  return workflowId;
}

/** A formal Workflow id as typed: the full id or a prefix naming exactly one (the short ids the CLI and TUI print). */
export function resolveWorkflowId(db: DatabaseSync, id: string): string {
  if (db.prepare('SELECT 1 FROM workflow_definition WHERE workflow_id = ?').get(id) || !/^[0-9a-f-]{6,}$/.test(id)) return id;
  const matches = db.prepare("SELECT workflow_id FROM workflow_definition WHERE workflow_id LIKE ? || '%' LIMIT 2").all(id) as
    { workflow_id: string }[];
  if (matches.length > 1) throw new Error(`Workflow 前缀 ${id} 不唯一，请给更长的 id`);
  return matches[0]?.workflow_id ?? id;
}

export function isFormalWorkflow(db: DatabaseSync, workflowId: string): boolean {
  return Boolean(db.prepare('SELECT 1 FROM workflow_definition WHERE workflow_id = ?').get(workflowId));
}
export function workflowSnapshot(db: DatabaseSync, workflowId: string): WorkflowSnapshot {
  const row = db.prepare(`SELECT profile, definition_json, capabilities_json, thresholds_json, manifest_json, tools_json, contexts_json, tool_root, variables_json, frozen_at
    FROM workflow_definition WHERE workflow_id = ?`).get(workflowId) as { profile: string; definition_json: string;
      capabilities_json: string; thresholds_json: string; manifest_json: string | null; tools_json: string; contexts_json: string;
      tool_root: string; variables_json: string; frozen_at: string } | undefined;
  if (!row) throw new Error(`不是正式 Workflow: ${workflowId}`);
  return { workflowId, profile: row.profile, definition: JSON.parse(row.definition_json) as ProcessDefinition,
    capabilities: JSON.parse(row.capabilities_json) as CapabilityManifest,
    thresholds: JSON.parse(row.thresholds_json) as Record<string, RuleValue>,
    ...(row.manifest_json ? { manifest: JSON.parse(row.manifest_json) as ManifestInput } : {}),
    tools: JSON.parse(row.tools_json) as Record<string, string>,
    toolRoot: row.tool_root,
    variables: JSON.parse(row.variables_json) as Record<string, string>,
    contexts: JSON.parse(row.contexts_json) as WorkflowSnapshot['contexts'], frozenAt: row.frozen_at };
}
function projectPathOf(db: DatabaseSync, workflowId: string): string {
  const row = db.prepare('SELECT project_id FROM workflow WHERE id = ?')
    .get(workflowId) as { project_id: string } | undefined;
  if (!row) throw new Error(`Unknown workflow ${workflowId}`);
  return projectRoot(db, row.project_id);
}

/**
 * Record a new plan document. An unreadable plan has no fingerprint: the plan stage then lacks its output,
 * so nothing downstream starts and no `when` is judged against a document that could not be read.
 */
function observePlan(db: DatabaseSync, workflowId: string, project: string, snapshot: WorkflowSnapshot, hash: string): boolean {
  const last = db.prepare('SELECT hash, error FROM plan_revision WHERE workflow_id = ? ORDER BY seq DESC LIMIT 1')
    .get(workflowId) as { hash: string; error: string | null } | undefined;
  if (last?.hash === hash) return last.error === null;
  const spec = snapshot.capabilities.artifacts.plan!;
  let content: Record<string, unknown> | undefined; let error: string | undefined;
  try {
    const text = readFileSync(join(project, spec.paths[0]!), 'utf8');
    const value = spec.format === 'json' ? JSON.parse(text) as unknown : parseYaml(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('方案文件顶层应为映射');
    content = value as Record<string, unknown>;
  } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  withStateEvent(db, { workflowId, actor: 'runtime', entityType: 'plan_revision', entityId: hash,
    action: error ? 'plan_unreadable' : 'plan_revised', reason: error ? `方案无法读取: ${error}` : '方案有新版本' }, () => {
    db.prepare('INSERT INTO plan_revision (workflow_id, hash, content_json, error) VALUES (?, ?, ?, ?)')
      .run(workflowId, hash, content ? JSON.stringify(content) : null, error ?? null);
    if (content) db.prepare('UPDATE workflow SET plan_json = ? WHERE id = ?').run(JSON.stringify(content), workflowId);
  });
  return !error;
}

export class ArtifactFingerprinter implements Fingerprinter {
  readonly db: DatabaseSync; readonly snapshot: WorkflowSnapshot; readonly project: string;
  /** Member lists of the recorded versions, one file per kind, under AVH_HOME (not the project). */
  private readonly store?: string;
  private readonly home?: string;
  private readonly current = new Map<string, Map<string, string>>();
  constructor(db: DatabaseSync, snapshot: WorkflowSnapshot, project: string, home?: string) {
    this.db = db; this.snapshot = snapshot; this.project = project;
    this.home = home;
    if (home) this.store = join(home, 'artifacts', snapshot.workflowId);
  }
  fingerprint(workflowId: string, kinds: string[], heartbeat?: () => void): Record<string, string> {
    const hashes: Record<string, string> = {};
    let temporary: ReturnType<typeof pendingNativeImport>;
    if (this.home) {
      const run = this.db.prepare(`SELECT r.id FROM run r JOIN task t ON t.id=r.task_id
        WHERE t.workflow_id=? AND t.status IN ('RUNNING','RECOVERY_REQUIRED')
        AND r.status='running' AND EXISTS(SELECT 1 FROM event e WHERE e.entity_type='run' AND e.entity_id=r.id
        AND e.actor='runtime' AND e.action='unity_unit_intended') ORDER BY r.rowid DESC LIMIT 1`).get(workflowId);
      if (run) {
        try { temporary = pendingNativeImport(this.project, join(this.home, 'runs', String(run.id))); }
        catch { /* Invalid transactions remain ordinary changed source evidence. Process control is independent. */ }
      }
    }
    // Hashing a large project blocks the event loop, so the scheduler's renewal timer cannot fire meanwhile.
    // Renewing around every kind keeps the lease alive across the scan and reveals a takeover before its result
    // is recorded as an accepted observation.
    heartbeat?.();
    for (const kind of kinds) {
      const spec = this.snapshot.capabilities.artifacts[kind];
      if (!spec) { heartbeat?.(); continue; }
      if (spec.source?.kind === 'runtime') {
        hashes[kind] = resolveWorkflowInput(this.db, workflowId).faceInputHash;
        heartbeat?.(); continue;
      }
      const members = artifactMembers(this.project, spec);
      projectStageToolInputs(this.db,this.snapshot,members);
      // The supervised transaction explicitly binds the source baseline. Its candidate substitution is temporary,
      // so it must not invalidate accepted ancestors or dispatch a second setup while Unity is still running.
      if (temporary && members.has(temporary.modelPath)) members.set(temporary.modelPath, temporary.originalSha256);
      this.current.set(kind, members);
      const hash = membersFingerprint(members);
      if (!hash) { heartbeat?.(); continue; }
      if (kind === 'plan') {
        // Recording a plan revision writes the state store before the kind's closing renewal. Renew and check
        // ownership here, so a scan that lost the lease does not persist a plan under the new owner.
        heartbeat?.();
        if (!observePlan(this.db, workflowId, this.project, this.snapshot, hash)) { heartbeat?.(); continue; }
      }
      hashes[kind] = hash;
      heartbeat?.();
    }
    return hashes;
  }
  changeOf(_workflowId: string, kind: string): MemberChange | undefined {
    const after = this.current.get(kind);
    if (!after || !this.store) return undefined;
    try {
      const saved = JSON.parse(readFileSync(join(this.store, `${kind}.json`), 'utf8')) as { members: Record<string, string> };
      return memberChange(new Map(Object.entries(saved.members)), after);
    } catch { return undefined; }
  }
  managedChangeOf(workflowId: string, kind: string): boolean {
    const change = this.changeOf(workflowId, kind);
    if (!change?.added.length || change.removed.length || change.modified.length) return false;
    const run = this.db.prepare(`SELECT t.stage_id FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=?
      AND t.status='RUNNING' AND r.status='running' AND EXISTS(SELECT 1 FROM event e WHERE e.entity_type='run'
      AND e.entity_id=r.id AND e.actor='runtime' AND e.action='unity_unit_intended') ORDER BY r.rowid DESC LIMIT 1`).get(workflowId);
    const capability = run && this.snapshot.capabilities.stages[String(run.stage_id)];
    if (!capability?.unitySteps?.length) return false;
    const allowed = [...capability.allowedWrites, ...capability.runtimeWrites ?? []];
    return change.added.every(path => {
      if (!/^Assets\/(?:_Harness|_HarnessTools)(?:\/|\.meta$)/.test(path) || !path.endsWith('.meta') || !allowedTaskPath(path, allowed, this.project)) return false;
      try {
        const target = join(this.project, path), sibling = join(this.project, path.slice(0, -5));
        let current=this.project;for(const part of path.split('/')){current=join(current,part);if(lstatSync(current).isSymbolicLink())return false;}
        if (lstatSync(target).isSymbolicLink() || lstatSync(sibling).isSymbolicLink() || lstatSync(target).size > 1024 * 1024) return false;
        const bytes = readFileSync(target, 'utf8');
        return /^fileFormatVersion: 2\r?\n/.test(bytes) && /^guid: [a-f0-9]{32}\r?$/m.test(bytes);
      } catch { return false; }
    });
  }
  unchanged(workflowId: string, kind: string): void {
    if (this.store && this.current.has(kind) && !existsSync(join(this.store, `${kind}.json`))) this.recorded(workflowId, kind);
  }
  recorded(_workflowId: string, kind: string): void {
    if (!this.store) return;
    hostPlatform.mkdirPrivate(this.store);
    hostPlatform.writePrivate(join(this.store, `${kind}.json`), JSON.stringify({ members: Object.fromEntries(this.current.get(kind) ?? []) }));
  }
}

function render(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g, (_, path: string) => {
    let value: unknown = values;
    for (const part of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
    return value === undefined ? `（未提供 ${path}）` : typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/** The work a stage Run is asked to do, compiled from the frozen capability manifest. */
export function stageTaskSpec(snapshot: WorkflowSnapshot, stage: Stage, plan: Record<string, unknown>,
  toolRoot: string, project: string, memory?: DurableProjectState, validateInputs = true): TaskSpec {
  const capability = snapshot.capabilities.stages[stage.id]!;
  const usesProvider = capability.mode === 'provider' && (!capability.providerWhen ||
    contextConditionMatches(capability.providerWhen, { plan, manifest: snapshot.manifest ?? {} }));
  const preserves = capability.mode === 'provider' && !usesProvider;
  const inputImages=usesProvider ? snapshot.manifest?.referenceImages : undefined;
  if (validateInputs && inputImages?.length) verifiedImageInputs(project,inputImages);
  const substitute = (arg: string): string => arg.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = name === 'toolRoot' ? toolRoot : name === 'project' ? project :
      name === 'templateSource' ? snapshot.variables.templateProject || '-' : snapshot.variables[name];
    if (!value) throw new Error(`能力清单需要尚未配置的运行变量：${name}`);
    return value;
  });
  const outputs = [...new Set([...stage.produces.flatMap(kind => snapshot.capabilities.artifacts[kind]?.paths ?? []),
    ...(capability.runtimeWrites ?? []).filter(path => !path.endsWith('/'))])];
  const checks = stage.requires.map(id => snapshot.definition.checks.find(check => check.id === id)!)
    .filter(check => check.maturity !== 'deprecated');
  const context: FrozenContextItem[] = capability.context.map(spec => ({ spec, ...snapshot.contexts[spec.path]! }));
  const goalPrefix = render(capability.goal ?? `完成阶段 ${stage.id}`, { plan, manifest: snapshot.manifest ?? {}, stage: stage.id,
    profile: snapshot.profile });
  const goalSuffix = [checks.length ? `\n验收检查（Runtime 在你退出后独立测量；你的说明不作为证据）：\n${checks.map(check =>
      `- ${check.id} [${check.scope}/${check.severity}]：${check.rule}${check.when ? `（仅当 ${check.when}）` : ''}`).join('\n')}` : '',
    Object.keys(plan).length ? `\n当前方案：\n${stringify(plan).trim()}` : '',
    snapshot.manifest ? `\n输入 Manifest：\n${stringify(snapshot.manifest).trim()}` : '',
    snapshot.manifest?.requirements?.length ? '\n本次输入已冻结当前要求解释及其用户来源；被明确替代或撤回的旧要求不再生效，其他要求继续保留。旧经验不覆盖当前决定。这些解释不授予新权限，不是适配或验收证明；有真实歧义应澄清。' : '',
    inputImages?.length ? '\n本次制作的原始参考图已按冻结版本作为实际图片附件提供；结合用户当前要求理解，不能用候选素材图片或旧文字描述替代它。图片仅是设计输入，不是已完成效果或适配证明。' : '',
    usesProvider && capability.agentTools && Object.keys(capability.agentTools).length
      ? `\nHarness 提供的冻结工具（可执行命令；是否成功仍以 Runtime 独立检查为准）：\n${Object.entries(capability.agentTools)
        .map(([name, argv]) => `- ${name}: ${hostArgv(argv.map(substitute)).map(part => JSON.stringify(part)).join(' ')}`).join('\n')}` : ''
    ].filter(Boolean).join('\n');
  const contextPlan: FrozenContextPlan = { items: context, facts: { plan, manifest: snapshot.manifest ?? {}, stage: { id: stage.id },
      memory: memory ? projectContextFacts(memory) : {} },
    budgetChars: capability.contextBudgetChars, requiredCoverage: capability.contextCoverage, prefix: goalPrefix, suffix: goalSuffix };
  // The goal text and the assembly report come from one compilation, so the record of what this stage
  // was given cannot drift from what it was actually given (决定记录 D-84).
  // A pack is its knowledge, its capability manifest and its tools together, so the identity digests all
  // three; a knowledge digest alone would call two different packs the same.
  const packDigest = digest([Object.entries(snapshot.contexts).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([path, entry]) => `${path}:${entry.sha256}`).join('\n'),
    JSON.stringify(snapshot.capabilities), Object.entries(snapshot.tools).sort().map(([path, hash]) => `${path}:${hash}`).join('\n')]
    .join('\n')).slice(0, 16);
  const { goal, report: contextAssembly } = compileContextPlan(contextPlan, {
    stage: stage.id, workflow: snapshot.workflowId, pack: packDigest, frozenAt: snapshot.frozenAt });
  const tool = capability.mode === 'tool' || preserves
    ? { argv: hostArgv((preserves ? capability.otherwiseCommand! : capability.command ?? [process.execPath, '-e', '']).map(substitute)), network: capability.network === true,
      // Tools read the frozen input and the current plan; they never reach the state database.
      env: { AVH_TOOL_ROOT: toolRoot, AVH_STAGE: stage.id, AVH_MANIFEST: JSON.stringify(snapshot.manifest ?? {}), AVH_PLAN: JSON.stringify(plan) } }
    : undefined;
  const prepare = usesProvider && capability.prepareCommand
    ? { argv: hostArgv(capability.prepareCommand.map(substitute)), env: { AVH_TOOL_ROOT: toolRoot, AVH_STAGE: stage.id,
      AVH_MANIFEST: JSON.stringify(snapshot.manifest ?? {}), AVH_PLAN: JSON.stringify(plan) } }
    : undefined;
  return { schema: 'task/0.1', goal, role: capability.role ?? 'executor', ...(usesProvider && capability.provider ? { provider: capability.provider } : {}),
    ...(inputImages?.length ? {inputImages} : {}),
    contextPlan,
    // What this stage was given and what it was not, with a reason and a disposition per item. It is
    // written beside the task so a later reader can tell "did not apply" from "did not fit" without
    // recompiling, and so a stage that lost knowledge is on record instead of quietly smaller.
    contextAssembly,
    // Frozen deterministic tools perform atomic writes too. Providers do not inherit these Runtime-only files.
    allowedWrites: tool ? [...new Set([...capability.allowedWrites, ...capability.runtimeTemporaryWrites ?? []])] : capability.allowedWrites,
    ...((capability.runtimeWrites?.length || capability.runtimeTemporaryWrites?.length) ? { runtimeWrites: [...new Set([...capability.runtimeWrites ?? [], ...capability.runtimeTemporaryWrites ?? []])] } : {}),
    expectedOutputs: outputs, requiredCapabilities: capability.requiredCapabilities ?? [],
    checks: [], maxRetries: capability.maxRetries, resources: capability.resources,
    // Unity steps see the same stage, plan and input as the stage's tool.
    ...(capability.unitySteps ? { unitySteps: capability.unitySteps.map(step => ({ ...step, env: { ...step.env, AVH_STAGE: stage.id,
      AVH_PLAN: JSON.stringify(plan), AVH_MANIFEST: JSON.stringify(snapshot.manifest ?? {}),
      AVH_TOOL_ROOT: toolRoot, AVH_ASSET_LIBRARY: snapshot.variables.assetLibrary ?? '' } })) } : {}),
    ...(prepare ? { prepare } : {}),
    ...(tool ? { tool } : {}) };
}

/**
 * The person's notes for a stage Task, oldest first. Redoing a passed stage starts a new Task whose goal carries the note;
 * redoing a held one (waiting for a person, or blocked by a check) runs the same Task again, so its notes are its redo requests.
 */
export function redoNotes(db: DatabaseSync, taskId: string, goal: string): string[] {
  const requests = db.prepare(`SELECT reason FROM event WHERE entity_type = 'task' AND entity_id = ? AND actor = 'human'
    AND action = 'requested_redo' ORDER BY seq`).all(taskId) as { reason: string }[];
  return [/；修改意见：([\s\S]+)$/.exec(goal)?.[1], ...requests.map(request => request.reason)]
    .filter((note): note is string => Boolean(note?.trim()) && note !== DEFAULT_REDO_NOTE);
}

/** Routes each stage Task to a TaskRouter built from that stage's compiled spec. */
export class StageRouter implements Executor {
  readonly db: DatabaseSync; readonly config: LocalConfig; readonly snapshot: WorkflowSnapshot;
  private readonly routers = new Map<string, TaskRouter>();
  constructor(db: DatabaseSync, config: LocalConfig, snapshot: WorkflowSnapshot) { this.db = db; this.config = config; this.snapshot = snapshot; }
  private row(taskId: string): FormalTaskRow {
    const row = this.db.prepare(`SELECT t.id, t.workflow_id, w.project_id, p.path AS project_path, t.status, t.goal,
      w.plan_json, w.process_hash, t.stage_id FROM task t JOIN workflow w ON w.id = t.workflow_id
      JOIN project p ON p.id = w.project_id WHERE t.id = ?`).get(taskId) as FormalTaskRow | undefined;
    if (!row || row.workflow_id !== this.snapshot.workflowId) throw new Error(`Task ${taskId} 不属于 Workflow ${this.snapshot.workflowId}`);
    return { ...row, project_path: projectRoot(this.db, row.project_id) };
  }
  router(taskId: string, runId?:string): TaskRouter {
    const row = this.row(taskId);
    const selection=selectedStageContract(this.db,this.snapshot,row.stage_id,runId),snapshot=selection.snapshot;
    const key=runId;
    let router = key ? this.routers.get(key) : undefined;
    if (router) return router;
    const stage = snapshot.definition.stages.find(item => item.id === row.stage_id)!;
    const memory = projectState(this.db, row.project_id);
    const input = runId ? readRunInputSnapshot(this.db, runId) : undefined;
    if (runId && (snapshot.definition.artifacts.includes('face_input') || ['face','face_design','manual_handoff'].includes(row.stage_id)) && !input)
      throw new Error('历史 Run 缺少冻结输入，请从受管续接恢复。');
    const spec = stageTaskSpec(snapshot, stage, input?.plan ?? buildAggregateInput(this.db, row.workflow_id).plan,
      snapshot.toolRoot || this.config.toolRoot, row.project_path, memory, false);
    if (input?.baseline.face_input) {
      const env = { AVH_FACE_INPUT_HASH: input.baseline.face_input };
      if (spec.tool) Object.assign(spec.tool.env, env);
      if (spec.prepare) Object.assign(spec.prepare.env, env);
      for (const step of spec.unitySteps ?? []) Object.assign(step.env, env);
    }
    if(selection.deployment.length && spec.prepare) spec.prepare.env.AVH_RUNTIME_TOOL_UPDATE_JSON=JSON.stringify(selection.deployment);
    if(selection.deployment.length && spec.tool) {
      spec.tool.env.AVH_RUNTIME_TOOL_UPDATE_JSON=JSON.stringify(selection.deployment);
      const identities=(tools:Record<string,string>)=>Object.fromEntries(Object.entries(tools).map(([path,sha])=>[path.split('/').at(-1)!,sha]));
      spec.tool.env.AVH_RUNTIME_FACE_TOOL_CONTRACT_JSON=JSON.stringify({before:identities(this.snapshot.tools),after:identities(snapshot.tools)});
      // Only this frozen deterministic unit receives reviewed compiler writes.
      // Provider scopes and the normal stage's model authorization stay unchanged.
      spec.allowedWrites=[...new Set([...spec.allowedWrites,...selection.deployment.map(value=>value.path)])];
    }
    if (spec.prepare?.argv.some(arg => arg.endsWith('/harness/material_dependencies.py') || arg.endsWith('\\harness\\material_dependencies.py'))) {
      const roots = JSON.stringify(refreshAssetSearchRoots(this.config).assetSearchRoots ?? []);
      spec.prepare.env.AVH_ASSET_SEARCH_ROOTS_JSON = roots;
      for (const step of spec.unitySteps ?? []) step.env = { ...step.env, AVH_ASSET_SEARCH_ROOTS_JSON: roots };
    }
    const prepend = (text: string): void => {
      spec.goal = `${text}\n\n${spec.goal}`;
      if (spec.contextPlan) spec.contextPlan.prefix = `${text}\n\n${spec.contextPlan.prefix}`;
    };
    const compact = compactProjectContext(memory);
    prepend(`Harness 项目状态 compact（由持久化事实生成，不是旧对话摘要）：\n${compact}`);
    const notes = redoNotes(this.db, taskId, row.goal);
    const feedback = notes.at(-1);
    if (feedback) {
      prepend(notes.length === 1 ? `用户要求重做本阶段，修改意见：${feedback}`
        : `用户要求重做本阶段。修改意见按时间先后列出，以最后一条为准，前面几条没被推翻的仍要照做：\n${
          notes.map((note, i) => `${i + 1}. ${note}`).join('\n')}`);
      // Tool stages read the newest note: a recolor redo names the candidate tier to keep, for example.
      if (spec.tool) spec.tool.env.AVH_FEEDBACK = feedback;
      for (const step of spec.unitySteps ?? []) step.env.AVH_FEEDBACK = feedback;
    }
    router = new TaskRouter(this.db, this.config, row, undefined, spec);
    if (key) this.routers.set(key, router);
    return router;
  }
  settledResult(handle: RunHandle): Promise<RunResult | undefined> { return this.byHandle(handle).settledResult(handle); }
  private byHandle(handle: RunHandle): TaskRouter {
    const run = this.db.prepare('SELECT id,task_id FROM run WHERE process_ref = ?').get(handle.ref) as { id:string;task_id: string } | undefined;
    if (!run) throw new Error(`Unknown Run handle ${handle.ref}`);
    return this.router(run.task_id,run.id);
  }
  canDispatch(resource: string, taskId?: string): boolean { return taskId ? this.router(taskId).canDispatch(resource) : true; }
  async start(spec: RunSpec): Promise<RunHandle> {
    // Observations come from Runtime steps only; nothing the executor left there may be read as a metric.
    rmSync(join(this.config.home, 'runs', spec.runId, OBSERVATIONS_DIR), { recursive: true, force: true });
    const input = readRunInputSnapshot(this.db, spec.runId);
    const selected=(input ? selectedStageContract(this.db,this.snapshot,spec.stageId,spec.runId)
      : recordRunStageContract(this.db,this.snapshot,spec.stageId,spec.runId)).snapshot;
    const capability = selected.capabilities.stages[spec.stageId];
    try { verifyTools(selected.toolRoot || this.config.toolRoot, selected.tools,
      [capability?.command ?? [], capability?.prepareCommand ?? [], capability?.otherwiseCommand ?? [], ...Object.values(capability?.agentTools ?? {})].flatMap(toolReferences)); }
    catch (error) { throw Object.assign(error as Error, { errorClass: 'tool_failure' as const, noSideEffects: true }); }
    const router = this.router(spec.taskId,spec.runId), gateId = capability?.selectionGate;
    const facePlan = input?.plan ?? buildAggregateInput(this.db, this.snapshot.workflowId).plan as Record<string, any>;
    if (spec.stageId === 'face' && router.spec.tool) {
      const { manualFaceInputForDispatch, acceptedManualFaceForDispatch } = await import('../face-manual.ts');
      const manual = input ? input.manualHandoff && {
        AVH_MANUAL_FACE_HANDOFF_SHA256: input.manualHandoff.handoffSha256!, AVH_MANUAL_FACE_BASELINE_SHA256: input.manualHandoff.baselineSha256!,
        AVH_MANUAL_FACE_SUBMITTED_SHA256: input.manualHandoff.submittedSha256! } : manualFaceInputForDispatch(this.db, this.snapshot.workflowId);
      if (manual) Object.assign(router.spec.tool.env, manual);
      const row = this.row(spec.taskId);
      router.spec.tool.env.AVH_FACE_MODE = facePlan.face?.mode ?? 'preserve';
      if (input?.baseline.face_input) router.spec.tool.env.AVH_FACE_INPUT_HASH = input.baseline.face_input;
      if (facePlan.face?.mode === 'manual') {
        const content = acceptedManualFaceForDispatch(this.db, row.project_id, facePlan.face.manualSessionId, input);
        const path = join(row.project_path, '_harness/face/accepted-manual.json');
        hostPlatform.mkdirPrivate(join(row.project_path, '_harness/face'));
        if (!existsSync(path) || readFileSync(path, 'utf8') !== content) hostPlatform.writePrivate(path, content);
        router.spec.tool.env.AVH_ACCEPTED_MANUAL_FACE_SHA256 = digest(content);
      }
    }
    if (gateId && facePlan.face?.mode === 'design') {
      const gate = this.snapshot.definition.gates.find(item => item.id === gateId)!;
      try {
        if (!router.spec.tool) throw new Error('候选选择只能交给受管工具执行');
        const current = input?.faceSelection ?? faceSelectionForDispatch(this.db, this.snapshot.workflowId, gateId, gate.binds);
        const path = join(this.row(spec.taskId).project_path, '_harness/face/selection.json');
        if (input?.faceSelection && (!existsSync(path) || readFileSync(path, 'utf8') !== current.content)) hostPlatform.writePrivate(path, current.content);
        router.spec.tool.env.AVH_FACE_SELECTION_SHA256 = current.sha256;
      } catch (error) { throw Object.assign(error as Error, { errorClass: 'tool_failure' as const, noSideEffects: true }); }
    }
    return router.start(spec);
  }
  observe(handle: RunHandle): Promise<RunObservation> { return this.byHandle(handle).observe(handle); }
  cancel(handle: RunHandle): Promise<'confirmed' | 'not_confirmed'> { return this.byHandle(handle).cancel(handle); }
  collect(handle: RunHandle): Promise<RunResult> { return this.byHandle(handle).collect(handle); }
  confirmNeverStarted(runId: string): boolean {
    const run = this.db.prepare('SELECT task_id FROM run WHERE id = ?').get(runId) as { task_id: string } | undefined;
    return run ? this.router(run.task_id, runId).confirmNeverStarted(runId) : false;
  }
  recordedExitStatus(runId: string): number | undefined {
    const run = this.db.prepare('SELECT task_id FROM run WHERE id = ?').get(runId) as { task_id: string } | undefined;
    return run ? this.router(run.task_id, runId).recordedExitStatus(runId) : undefined;
  }
}

export function workflowScheduler(db: DatabaseSync, config: LocalConfig, workflowId: string, executor?: Executor,
  frozen?: WorkflowSnapshot, runtime: CycleRuntime = {}): Scheduler {
  // A caller that already holds this workflow's frozen snapshot passes it in. An idle scheduler cycle
  // rebuilds a scheduler for every active workflow, and reading the snapshot a second time for the status
  // update doubled that cost without adding information (缺陷 14).
  const snapshot = frozen ?? workflowSnapshot(db, workflowId);
  const toolRoot = snapshot.toolRoot || config.toolRoot;
  const project = projectPathOf(db, workflowId);
  const stageSlots = Object.fromEntries(Object.entries(snapshot.capabilities.stages).map(([id, stage]) => [id, stage.resources]));
  // The scheduler's shared slot keys must cover the same number of Unity editors as the
  // machine-level lock the worker takes. Other resources remain singleton slots.
  const slotCapacity = Object.fromEntries(Object.values(stageSlots).flat().map(name =>
    [name, name === 'unity_batch' ? config.unitySlots.count : 1]));
  const stageRetries = Object.fromEntries(Object.entries(snapshot.capabilities.stages).map(([id, stage]) => [id, stage.maxRetries]));
  const stageCheckRetries = Object.fromEntries(Object.entries(snapshot.capabilities.stages).map(([id, stage]) => [id, stage.maxCheckRetries]));
  const verifier = new ObservationVerifier({ definition: snapshot.definition, observers: snapshot.capabilities.observers,
    verifyTool: argv => verifyTools(toolRoot, snapshot.tools, toolReferences(argv)),
    thresholds: snapshot.thresholds, project, toolRoot, runRoot: join(config.home, 'runs'), harnessHome: config.home,
    manifest: snapshot.manifest ?? {}, variables: snapshot.variables, plan: () => buildAggregateInput(db, workflowId).plan,
    forRun: run => {
      const selected = selectedStageContract(db, snapshot, run.stageId, run.runId).snapshot;
      const root = selected.toolRoot || config.toolRoot;
      return { definition: selected.definition, observers: selected.capabilities.observers, thresholds: selected.thresholds,
        project, toolRoot: root, runRoot: join(config.home, 'runs'), harnessHome: config.home,
        manifest: selected.manifest ?? {}, variables: selected.variables, plan: () => buildAggregateInput(db, workflowId).plan,
        verifyTool: argv => verifyTools(root, selected.tools, toolReferences(argv)) };
    } });
  return new Scheduler(db, workflowId, snapshot.definition, executor ?? new StageRouter(db, config, snapshot), verifier,
    new ArtifactFingerprinter(db, snapshot, project, config.home),
    { maxRetries: 0, stageRetries, stageCheckRetries, slotCapacity, stageSlots, ...runtime,
      dispatchBlocked: () => productionDispatchBlocked(db, workflowId),
      stageDispatchAllowed: stageId => productionStageDispatchAllowed(db,workflowId,stageId),
      beforeDispatch: async stageId => { if (['face_design', 'face'].includes(stageId)) await ensureProductionBaseline(db, config, workflowId); },
      freezeInputExtras: spec => {
        const selection = recordRunStageContract(db, snapshot, spec.stageId, spec.runId);
        const gateId = selection.snapshot.capabilities.stages[spec.stageId]?.selectionGate;
        const gate = selection.snapshot.definition.gates.find(item => item.id === gateId);
        const faceSelection = gate && resolveWorkflowInput(db, workflowId).plan.face?.mode === 'design'
          ? faceSelectionForDispatch(db, workflowId, gate.id, gate.binds, false) : undefined;
        return { stageToolSelection: { ...(selection.selectionSeq ? { selectionSeq: selection.selectionSeq } : {}) },
          ...(faceSelection ? { faceSelection } : {}) };
      }, providerRegistry: new ProviderRegistry({
      policyVersion: config.providerPolicyVersion, probeTtlMs: config.providerProbeTtlMs, routing: config.routing,
      home: config.home, providers: config.providers }) });
}

/**
 * Status follows the milestones: reaching UPLOAD_READY, and losing it again when its evidence goes stale.
 * `refresh` is awaited once before a transition into `client_verified`. That status is terminal, so the Workflow
 * leaves the scanning loop: the idle fingerprint cadence must not let it be entered on a version the person changed
 * after approving it.
 */
export async function updateWorkflowStatus(db: DatabaseSync, workflowId: string, frozen?: WorkflowSnapshot,
  refresh?: () => Promise<void>): Promise<WorkflowStatus> {
  const row = db.prepare('SELECT status FROM workflow WHERE id = ?').get(workflowId) as { status: WorkflowStatus };
  // Cancelled and client-verified are final: the delivery was accepted; later work belongs to a new Workflow.
  if (row.status === 'cancelled' || row.status === 'client_verified') return row.status;
  const definition = (frozen ?? workflowSnapshot(db, workflowId)).definition;
  const compute = (): WorkflowStatus => {
    const milestones = aggregateWorkflow(db, workflowId, definition).milestones;
    return milestones.CLIENT_VERIFIED?.status === 'reached' ? 'client_verified'
      : milestones.UPLOAD_READY?.status === 'reached' ? 'upload_ready' : 'active';
  };
  let status = compute();
  if (status === 'client_verified' && refresh) {
    await refresh();
    // Re-derive on the fresh fingerprints: an edit made after the approval makes the gate stale, and the milestone
    // that would have ended the Workflow is no longer reached.
    status = compute();
  }
  if (status !== row.status) withStateEvent(db, { workflowId, actor: 'runtime', entityType: 'workflow', entityId: workflowId,
    action: `${row.status}->${status}`, reason: status === 'active' ? '里程碑证据失效或尚未达成' : `达成 ${status === 'upload_ready' ? 'UPLOAD_READY' : 'CLIENT_VERIFIED'}` },
  () => {
    db.prepare('UPDATE workflow SET status = ? WHERE id = ?').run(status, workflowId);
    if (status === 'client_verified') {
      const hashes = buildAggregateInput(db, workflowId).artifactHashes;
      const projectId = String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflowId)!.project_id);
      const packageHash = hashes.delivery_package ?? hashes.package;
      if (packageHash) db.prepare('INSERT OR IGNORE INTO production_delivery(workflow_id,project_id,face_input_hash,package_hash) VALUES(?,?,?,?)').run(workflowId,projectId,hashes.face_input ?? null,packageHash);
    }
  });
  return status;
}

export interface FormalGate {
  gate: string; workflowId: string; project: string; kind: 'approve' | 'choose' | 'do'; binds: string;
  projectId: string; selection?: 'face-candidate'; review?: 'face-output'; preview?: 'recolor-candidates';
  owner: string; status: 'waiting' | 'pending' | 'approved' | 'rejected' | 'stale'; artifactHash?: string;
  inputHashes?: Record<string, string>;
  expectedFaceRevision?: number;
}
/** Compatibility projection for frozen pre-preview definitions of the known recolour approval Gate. */
function recolorPreview(gate: { id: string; binds: string; preview?: 'recolor-candidates' }): 'recolor-candidates' | undefined {
  return gate.preview ?? (gate.id === 'recolor_approval' && gate.binds === 'materials' ? 'recolor-candidates' : undefined);
}
const ACTIVE_TASK = new Set(['PENDING', 'READY', 'RUNNING', 'VERIFYING']);
/** Gates of one formal Workflow, as the TUI and CLI show them; `waiting` means its stage is not ready for a decision. */
export function formalGates(db: DatabaseSync, workflowId: string): FormalGate[] {
  const snapshot = workflowSnapshot(db, workflowId);
  const input = buildAggregateInput(db, workflowId);
  const result = aggregateWorkflow(db, workflowId, snapshot.definition);
  const project = projectPathOf(db, workflowId);
  const projectId = String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflowId)!.project_id);
  const manualOwner=db.prepare('SELECT project_id FROM face_manual_session WHERE workflow_id=?').get(workflowId);
  const expectedFaceRevision=manualOwner ? facePreference(db,String(manualOwner.project_id))?.revision ?? 0 : undefined;
  const owners = new Map<string, string>();
  for (const stage of snapshot.definition.stages) for (const gate of stage.gates) owners.set(gate, `stage:${stage.id}`);
  for (const milestone of snapshot.definition.milestones) for (const gate of milestone.gates) owners.set(gate, `milestone:${milestone.id}`);
  const latestTask = db.prepare('SELECT status FROM task WHERE workflow_id = ? AND stage_id = ? ORDER BY rowid DESC LIMIT 1');
  return snapshot.definition.gates.flatMap(gate => {
    if (gate.when && !planValue(input.plan, gate.when)) return [];
    const hash = input.artifactHashes[gate.binds];
    const inputHashes = evidenceInputHashes(snapshot.definition, { gateId: gate.id }, input.artifactHashes);
    const decision = [...input.gateDecisions].reverse().find(item => item.gateId === gate.id);
    const rejected = hash ? db.prepare(`SELECT payload_json FROM event WHERE workflow_id = ? AND entity_type = 'gate' AND entity_id = ?
      AND action = 'rejected' AND json_extract(payload_json, '$.hash') = ? ORDER BY seq DESC`).all(workflowId, `${workflowId}:${gate.id}`, hash)
      .some(row => evidenceFresh(hash, hash, JSON.parse(String(row.payload_json)).inputHashes, inputHashes)) : false;
    const owner = owners.get(gate.id) ?? 'unattached';
    const stage = owner.startsWith('stage:') ? result.stages[owner.slice(6)] : undefined;
    if (stage?.status === 'not_applicable') return [];
    const milestone = owner.startsWith('milestone:') ? snapshot.definition.milestones.find(item => `milestone:${item.id}` === owner) : undefined;
    // While the stage works on a new version (a redo), what exists now is about to be replaced: nothing to decide yet.
    const working = stage ? ACTIVE_TASK.has((latestTask.get(workflowId, owner.slice(6)) as { status: string } | undefined)?.status ?? '')
      : false;
    const ready = stage ? !working && stage.status === 'blocked' && (stage.reasonCodes ?? []).every(code => code === 'gate_pending')
      : milestone ? (!milestone.after || result.milestones[milestone.after]?.status === 'reached') : false;
    const preview = recolorPreview(gate);
    const concrete = (!gate.selection || (decision?.selection?.schema === 'face-gate-choice/0.1' && decision.selection.artifactHash === hash && Boolean(decision.selection.selection?.candidateId))) &&
      (!gate.review || (decision?.selection?.schema === 'face-output-acceptance/0.1' && decision.selection.artifactHash === hash && /^[a-f0-9]{64}$/.test(decision.selection.previewSha256 ?? ''))) &&
      (!preview || (decision?.selection?.schema === 'recolor-preview-acceptance/0.1' && decision.selection.artifactHash === hash && /^[a-f0-9]{64}$/.test(decision.selection.previewSha256 ?? '') && Boolean(decision.selection.runId) && Boolean(decision.selection.renderDigest)));
    const status: FormalGate['status'] = decision && evidenceFresh(decision.artifactHash, hash, decision.inputHashes, inputHashes) && concrete ? 'approved'
      : rejected ? 'rejected' : decision && !working ? 'stale' : hash && ready ? 'pending' : 'waiting';
    return [{ gate: `${workflowId}:${gate.id}`, workflowId, project, projectId, kind: gate.kind, binds: gate.binds, owner, status,
      inputHashes,
      ...(expectedFaceRevision!==undefined ? {expectedFaceRevision} : {}),
      ...(gate.selection ? { selection: gate.selection } : {}),
      ...(gate.review ? { review: gate.review } : {}),
      ...(preview ? { preview } : {}),
      ...(hash ? { artifactHash: hash } : {}) }];
  });
}

/** A decision binds the artifact's hash as observed now; a later change makes it stale. */
export async function decideFormalGate(db: DatabaseSync, config: LocalConfig, workflowId: string, gateId: string,
  approve: boolean, note: string, expectedHash?: string, choice?: FaceChoiceInput, review?: FaceAcceptanceInput,
  expectedInputs?: Record<string, string>, expectedFaceRevision?: number, expectedPreviewSha256?: string): Promise<{ status: 'approved' | 'rejected'; artifactHash: string }> {
  const snapshot = workflowSnapshot(db, workflowId);
  const gate = snapshot.definition.gates.find(item => item.id === gateId);
  if (!gate) throw new Error(`Gate 不存在: ${gateId}`);
  if (db.prepare('SELECT status FROM workflow WHERE id=?').get(workflowId)?.status === 'cancelled') throw new Error('这次制作已经取消，不能继续确认决定');
  const scheduler = workflowScheduler(db, config, workflowId);
  const { refreshFingerprints } = await import('../runtime/reconcile.ts');
  await refreshFingerprints(scheduler);
  const aggregateInput = buildAggregateInput(db, workflowId);
  const hash = aggregateInput.artifactHashes[gate.binds];
  const inputHashes = evidenceInputHashes(snapshot.definition, { gateId: gateId }, aggregateInput.artifactHashes);
  if (!hash) throw new Error(`Gate 所绑产物 ${gate.binds} 尚不存在`);
  if (expectedHash && expectedHash !== hash)
    throw Object.assign(new Error(`${gate.binds} 在你查看之后已变化，请重新查看后再决定`), { code: 'STALE' });
  // "No token at all" and "a token that no longer matches" are different facts. A gate bound to runtime inputs needs
  // the token the person was shown, so a caller that never passed --expect-inputs must be told that, instead of being
  // sent to look for a change that did not happen.
  if (expectedInputs === undefined && Object.values(inputHashes).some(Boolean))
    throw Object.assign(new Error(`这个关口绑定了制作输入，批准必须同时给出 --expect-inputs（本次没有给）。` +
      `当前期望值 ${JSON.stringify(inputHashes)}；核对过这些输入后把该 JSON 原样传给 --expect-inputs 再决定。`), { code: 'STALE' });
  if (!evidenceFresh(hash, hash, expectedInputs, inputHashes))
    throw Object.assign(new Error('制作输入在你查看之后已变化，请重新查看后再决定。'), { code: 'STALE' });
  const current = formalGates(db, workflowId).find(item => item.gate === `${workflowId}:${gateId}`)!;
  if (!current) throw new Error(`Gate ${gateId} 在当前方案中不适用`);
  if (current.status === 'waiting') throw new Error(`Gate ${gateId} 还没到决定的时候（${current.owner} 未就绪）`);
  if (approve) {
    if (gate.selection && (!choice || !expectedHash)) throw new Error('请选择实际预览中的脸型候选，再确认当前版本');
    if (choice && gate.selection !== 'face-candidate') throw new Error('这个决定不接受脸型候选');
    if (gate.review && (!review || !expectedHash)) throw new Error('请查看当前工程的实际脸型效果后确认');
    if (review && gate.review !== 'face-output') throw new Error('这个决定不接受脸型效果确认');
    const preview = recolorPreview(gate);
    if (preview && (!expectedPreviewSha256 || !/^[a-f0-9]{64}$/.test(expectedPreviewSha256)))
      throw Object.assign(new Error('批准配色必须绑定你查看过的候选图清单'), { code: 'STALE' });
    const projectId = String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflowId)!.project_id);
    const recolor = preview ? projectRecolorPreview(db, projectId, workflowId, hash) : undefined;
    if (preview && (recolor?.status !== 'ready' || recolor.previewSha256 !== expectedPreviewSha256))
      throw Object.assign(new Error('候选图在你查看之后已变化，请重新查看后再决定'), { code: 'STALE' });
    const selection = gate.selection ? validateFaceChoice(db, workflowId, gateId, hash, choice!) :
      gate.review ? validateFaceAcceptance(db, workflowId, hash, review!) :
      preview && recolor?.status === 'ready' ? { schema: 'recolor-preview-acceptance/0.1', artifactHash: hash,
        previewSha256: expectedPreviewSha256, runId: recolor.runId, renderDigest: recolor.renderDigest } : undefined;
    if (current.status === 'approved') {
      const previous = db.prepare('SELECT selection_json FROM gate_decision WHERE workflow_id=? AND gate_id=? ORDER BY seq DESC LIMIT 1').get(workflowId, gateId);
      if (selection && previous?.selection_json !== JSON.stringify(selection)) throw new Error('这个版本已有不同的具体决定；请查看新的候选或效果版本后再决定');
      return { status: 'approved', artifactHash: hash };
    }
    const result = gate.kind === 'approve' ? 'approved' : gate.kind === 'choose' ? 'chosen' : 'done';
    const { recordManualFaceAcceptance } = await import('../face-manual.ts');
    withStateEvent(db, { workflowId, actor: 'human', entityType: 'gate', entityId: `${workflowId}:${gateId}`, action: 'approved',
      reason: note || 'human approved current artifact', payload: { hash, inputHashes, ...(selection ? { selection } : {}) } },
    () => {
      const now = buildAggregateInput(db, workflowId).artifactHashes;
      if (!evidenceFresh(hash, now[gate.binds], inputHashes, evidenceInputHashes(snapshot.definition, { gateId }, now)))
        throw Object.assign(new Error('制作输入已变化，请重新查看。'), { code: 'STALE' });
      db.prepare('INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result, selection_json, input_hashes_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(workflowId, gateId, hash, result, selection ? JSON.stringify(selection) : null, JSON.stringify(inputHashes));
      if (gate.review === 'face-output') recordManualFaceAcceptance(db, workflowId, expectedFaceRevision);
    });
    return { status: 'approved', artifactHash: hash };
  }
  if (current.status === 'approved') throw new Error('当前产物版本已有不可撤销的批准；请先修改产物，再对新版本作决定');
  withStateEvent(db, { workflowId, actor: 'human', entityType: 'gate', entityId: `${workflowId}:${gateId}`, action: 'rejected',
    reason: note || 'human rejected current artifact', payload: { hash, inputHashes } }, () => {});
  return { status: 'rejected', artifactHash: hash };
}

/** Internal outcome of the in-transaction re-check: another request already accepted this same reading. */
const ALREADY_ACCEPTED = 'ALREADY_ACCEPTED';

/**
 * Accept one warning reading, as the person who saw it. The acceptance binds the exact current Verdict id, so a later
 * Verdict for the same check does not inherit it and a changed artifact makes it stale rather than silently valid. It
 * never rewrites the Verdict: the record says the person accepted a warning, not that the measurement passed.
 */
export function acceptWarning(db: DatabaseSync, workflowId: string, checkId: string, reason: string, expectedVerdictId?: string): {
  verdictId: string; checkId: string; recordedAt: string; alreadyAccepted: boolean;
} {
  if (!reason.trim()) throw new Error('接受提醒必须写明原因（会记入事件，便于之后回顾）');
  if (!db.prepare('SELECT 1 FROM workflow WHERE id = ?').get(workflowId))
    throw Object.assign(new Error(`找不到制作流程 ${workflowId}`), { code: 'NOT_FOUND' });
  if (!isFormalWorkflow(db, workflowId))
    throw Object.assign(new Error('这不是正式制作流程，没有可接受的检查判据'), { code: 'BAD_REQUEST' });
  const snapshot = workflowSnapshot(db, workflowId);
  const check = snapshot.definition.checks.find(item => item.id === checkId);
  // A check of another Workflow simply is not in this frozen definition; the refusal says which one was asked for.
  if (!check) throw Object.assign(new Error(`判据 ${checkId} 不属于这个制作流程，不能接受`), { code: 'NOT_FOUND' });
  if (check.severity !== 'warning')
    throw Object.assign(new Error(check.severity === 'blocking'
      ? `判据 ${checkId} 是阻断级，不能接受；请修好产物后重新取证`
      : `判据 ${checkId} 是提示级，不影响阶段推进，不需要接受`), { code: 'BAD_REQUEST' });
  // A deprecated check is skipped by the aggregate everywhere (process/aggregate.ts), so its reading never blocks a
  // stage: accepting it would record an event that changes nothing while telling the person they unblocked something.
  // The refusal says why there is nothing to accept rather than burying it under the generic severity wording.
  if (check.maturity === 'deprecated')
    throw Object.assign(new Error(`判据 ${checkId} 已停用，不影响阶段推进，不需要接受`), { code: 'BAD_REQUEST' });
  const input = buildAggregateInput(db, workflowId);
  if (check.when && !planValue(input.plan, check.when))
    throw Object.assign(new Error(`判据 ${checkId} 在当前方案中不适用`), { code: 'BAD_REQUEST' });
  const verdict = [...input.verdicts].reverse().find(item => item.checkId === checkId);
  if (!verdict) throw Object.assign(new Error(`判据 ${checkId} 还没有结论，等它取证后再接受`), { code: 'BAD_REQUEST' });
  if (verdict.scope !== check.scope)
    throw Object.assign(new Error(`结论范围 ${verdict.scope} 与判据的 ${check.scope} 不一致，不能接受`), { code: 'BAD_REQUEST' });
  const bound = input.artifactHashes[check.on];
  if (!evidenceFresh(verdict.artifactHash, bound, verdict.inputHashes,
    evidenceInputHashes(snapshot.definition, { checkId }, input.artifactHashes)))
    throw Object.assign(new Error('这条读数已过期：它判断的产物版本不是当前版本，请重新取证后再接受'), { code: 'STALE' });
  if (verdict.result === 'pass') throw Object.assign(new Error(`判据 ${checkId} 已经通过，不需要接受`), { code: 'BAD_REQUEST' });
  if (expectedVerdictId && expectedVerdictId !== verdict.id)
    throw Object.assign(new Error('这条读数在你查看之后已变化，请重新查看后再接受'), { code: 'STALE' });
  const existing = db.prepare(`SELECT recorded_at FROM warning_acceptance WHERE workflow_id = ? AND verdict_id = ?
    ORDER BY seq DESC LIMIT 1`).get(workflowId, verdict.id) as { recorded_at: string } | undefined;
  if (existing) return { verdictId: verdict.id, checkId, recordedAt: existing.recorded_at, alreadyAccepted: true };
  if (db.prepare('SELECT status FROM workflow WHERE id=?').get(workflowId)?.status === 'cancelled')
    throw Object.assign(new Error('这次制作已经取消，不能再接受提醒'), { code: 'BAD_REQUEST' });
  let recordedAt = '', racedAt = '';
  try {
    withStateEvent(db, { workflowId, actor: 'human', entityType: 'warning', entityId: `${workflowId}:${checkId}`,
      action: 'accepted', reason, payload: { verdictId: verdict.id, artifactHash: verdict.artifactHash, result: verdict.result } },
    () => {
      // Everything the pre-checks decided is re-read inside the transaction, because another writer can commit between
      // them and this write: the request is refused rather than committing from a decision that is no longer true.
      const now = buildAggregateInput(db, workflowId);
      if (db.prepare('SELECT status FROM workflow WHERE id=?').get(workflowId)?.status === 'cancelled')
        throw Object.assign(new Error('这次制作已经取消，不能再接受提醒'), { code: 'BAD_REQUEST' });
      if (check.when && !planValue(now.plan, check.when))
        throw Object.assign(new Error(`判据 ${checkId} 在当前方案中不适用`), { code: 'BAD_REQUEST' });
      const raced = db.prepare(`SELECT recorded_at FROM warning_acceptance WHERE workflow_id = ? AND verdict_id = ?
        ORDER BY seq DESC LIMIT 1`).get(workflowId, verdict.id) as { recorded_at: string } | undefined;
      // Another request accepted this same reading while this one waited: there is nothing to write and no event to
      // record, so the caller is told it was already accepted instead of a duplicate record appearing in the history.
      if (raced) {
        racedAt = String(raced.recorded_at);
        throw Object.assign(new Error('这条读数已经接受过'), { code: ALREADY_ACCEPTED });
      }
      // What is accepted must still be the reading the person was shown.
      const current = [...now.verdicts].reverse().find(item => item.checkId === checkId);
      if (!current || current.id !== verdict.id || !evidenceFresh(verdict.artifactHash, now.artifactHashes[check.on],
        verdict.inputHashes, evidenceInputHashes(snapshot.definition, { checkId }, now.artifactHashes)))
        throw Object.assign(new Error('这条读数已变化，请重新查看后再接受'), { code: 'STALE' });
      db.prepare('INSERT INTO warning_acceptance (workflow_id, verdict_id) VALUES (?, ?)').run(workflowId, verdict.id);
      recordedAt = String((db.prepare(`SELECT recorded_at FROM warning_acceptance WHERE workflow_id = ? AND verdict_id = ?
        ORDER BY seq DESC LIMIT 1`).get(workflowId, verdict.id) as { recorded_at: string }).recorded_at);
    });
  } catch (error) {
    if ((error as { code?: string }).code === ALREADY_ACCEPTED)
      return { verdictId: verdict.id, checkId, recordedAt: racedAt, alreadyAccepted: true };
    throw error;
  }
  return { verdictId: verdict.id, checkId, recordedAt, alreadyAccepted: false };
}

/** Cancel every unfinished Task first; the Workflow is cancelled only when all of them confirmed. */
export async function cancelWorkflow(db: DatabaseSync, config: LocalConfig, workflowId: string, note: string,
  executor?: Executor): Promise<{ confirmed: boolean; tasks: Array<{ taskId: string } & CancelResult> }> {
  if (!note.trim()) throw new Error('取消 Workflow 需要说明');
  workflowSnapshot(db, workflowId);
  const scheduler = workflowScheduler(db, config, workflowId, executor);
  const open = db.prepare(`SELECT id FROM task WHERE workflow_id = ? AND status NOT IN ('PASSED', 'FAILED', 'CANCELLED') ORDER BY rowid`)
    .all(workflowId) as { id: string }[];
  const tasks: Array<{ taskId: string } & CancelResult> = [];
  for (const task of open) tasks.push({ taskId: task.id, ...await scheduler.cancelTask(task.id, `workflow cancelled: ${note}`) });
  const confirmed = tasks.every(task => task.confirmed);
  if (confirmed) withStateEvent(db, { workflowId, actor: 'human', entityType: 'workflow', entityId: workflowId,
    action: 'cancelled', reason: note }, () => db.prepare("UPDATE workflow SET status = 'cancelled' WHERE id = ?").run(workflowId));
  return { confirmed, tasks };
}

/** Provider routing for a Workflow's `provider` stages must be possible before it is worth starting. */
export function routableRoles(config: LocalConfig, profile: string): string[] {
  const capabilities = config.capabilities[profile];
  if (!capabilities) return [];
  const registry = new ProviderRegistry({ policyVersion: config.providerPolicyVersion, probeTtlMs: config.providerProbeTtlMs,
    routing: config.routing, home: config.home, providers: config.providers });
  const snapshot = { ...registry.snapshot('probe'), routing: config.routing };
  return [...new Set(Object.values(capabilities.stages).filter(stage => stage.mode === 'provider').map(stage => stage.role ?? 'executor'))]
    .filter(role => !routeProviders(snapshot, role, config.routing, {}).selected);
}
