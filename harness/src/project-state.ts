import { readFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { aggregateWorkflow } from './state/aggregate-input.ts';
import type { ProcessDefinition } from './process/types.ts';
import { factViews } from './archive/facts.ts';
import { projectSafePoint } from './archive/projection.ts';
import { bodyItemIds } from './assets/derive.ts';
import { facePreference } from './face-policy.ts';

/**
 * What the project archive adds to a new conversation: the conclusions it must not take as settled. Only stored facts
 * (import, takeover analysis, scans, confirmations) appear; Workflow results reach the stage through its own checks.
 */
export interface ArchiveContext {
  inferred: Array<{ objectId: string; attribute: string; value: unknown }>;
  stale: Array<{ objectId: string; attribute: string }>;
  unknown: Array<{ objectId: string; attribute: string }>;
  missingDependencies: string[];
}

export interface DurableProjectState {
  schema: 'harness-project-state/0.1';
  project: { id: string; path: string; lifecycle: string; identity: unknown };
  brief: { intakeMode: string; goal: string; faceConcept: string; status: string } | null;
  assets: Array<{ id: string; name: string; path: string; kind: string; status: string; role: string }>;
  /** Names of the BOOTH products chosen for the project in the character category: a base avatar fetched from BOOTH. */
  boothAvatars?: string[];
  faceChoice?: { mode: string; acceptedVersion: string | null };
  variants: Array<{ id: string; name: string; description: string; status: string }>;
  roots: Array<{ id: string; variantId: string | null; derivedFrom: string | null; scenePath: string; objectPath: string;
    role: string; pluginProfile: string; activeState: string; blueprintId: string }>;
  workflow: { id: string; process: string; status: string; knowledgeVersion: string; frozenAt: string | null;
    stages: Array<{ id: string; status: string; reasons: string[]; codes?: string[] }> } | null;
  tasks: Array<{ id: string; stage: string; status: string; goal: string; updatedAt: string }>;
  cases: Array<{ taskId: string; stage: string; outcome: 'success' | 'failure'; attempts: number;
    modelFamilies: string[]; reason: string; evidence: string[]; at: string }>;
  gates: Array<{ id: string; result: string; artifactHash: string; decidedAt: string }>;
  evidence: { artifacts: Array<{ kind: string; hash: string; observedAt: string }>; verdicts: number; events: number };
  acceptedDecisions: Array<{ content: string; at: string }>;
  /** Present when the project archive holds candidates, unknowns or stale conclusions a stage must not take as settled. */
  archive?: ArchiveContext;
  generatedAt: string;
}

/** Durable project facts used to initialize a new conversation without replaying an old model's transcript. */
export function projectState(db: DatabaseSync, projectId: string): DurableProjectState {
  const state = durableState(db, projectId);
  let identity: unknown = state.project.identity;
  identity = observedIdentity(state.project.path, identity);
  const archive = archiveContext(db, projectId);
  return { ...state, project: { ...state.project, identity }, ...(archive ? { archive } : {}), generatedAt: new Date().toISOString() };
}

function archiveContext(db: DatabaseSync, projectId: string): ArchiveContext | undefined {
  const stored = factViews(db, projectId).filter(fact => fact.source.type !== 'workflow' && fact.source.type !== 'project');
  const key = (fact: { objectId: string; attribute: string }) => ({ objectId: fact.objectId, attribute: fact.attribute });
  const context: ArchiveContext = {
    inferred: stored.filter(fact => fact.effectiveStatus === 'inferred' && fact.shareLayer !== 'C').map(fact => ({ ...key(fact), value: fact.value })),
    stale: stored.filter(fact => fact.effectiveStatus === 'stale').map(key),
    unknown: stored.filter(fact => fact.effectiveStatus === 'unknown').map(key),
    missingDependencies: stored.filter(fact => fact.objectId === 'project' && fact.attribute === 'vpm.unresolved' && fact.effectiveStatus !== 'stale')
      .flatMap(fact => Array.isArray(fact.value) ? fact.value.map(String) : []),
  };
  return context.inferred.length || context.stale.length || context.unknown.length || context.missingDependencies.length ? context : undefined;
}

/**
 * The durable state from the state database alone: no file is read and nothing depends on the clock, so the project
 * archive can project it deterministically. projectState() adds what the Unity project on disk says.
 */
export function durableState(db: DatabaseSync, projectId: string): DurableProjectState {
  // A read-only import stores the project relative to its workspace; resolve it there, never against the cwd.
  const row = db.prepare(`SELECT p.id,p.path,p.lifecycle,p.identity_json AS identity,w.path AS workspace
    FROM project p LEFT JOIN workspace w ON w.id=p.workspace_id WHERE p.id=?`).get(projectId) as
    { id: string; path: string; lifecycle: string; identity: string; workspace: string | null } | undefined;
  if (!row) throw Object.assign(new Error(`项目不存在: ${projectId}`), { code: 'NOT_FOUND' });
  if (!isAbsolute(row.path) && !(row.workspace && isAbsolute(row.workspace)))
    throw new Error(`项目路径无法解析为绝对路径：${row.path}`);
  const project = { id: row.id, path: isAbsolute(row.path) ? row.path : join(row.workspace!, row.path),
    lifecycle: row.lifecycle, identity: row.identity };
  // The managed engineering copy owns its execution evidence; the logical order still owns the person's requirements.
  const owner = db.prepare(`SELECT DISTINCT logical_project_id FROM production_continuation
    WHERE successor_project_id=?`).all(projectId);
  if (owner.length > 1) throw new Error('工程版本的逻辑项目谱系不唯一，需要恢复核对。');
  const businessProjectId = owner[0] ? String(owner[0].logical_project_id) : projectId;
  const brief = db.prepare(`SELECT intake_mode AS intakeMode,customer_request AS goal,face_concept AS faceConcept,status
    FROM project_brief WHERE project_id=?`).get(businessProjectId) as DurableProjectState['brief'];
  const assets = db.prepare(`SELECT a.id,a.name,a.path,a.kind,a.status,pa.role FROM project_asset pa
    JOIN asset a ON a.id=pa.asset_id WHERE pa.project_id=? ORDER BY pa.attached_at,a.name`).all(businessProjectId) as DurableProjectState['assets'];
  // A selected product is a body when the catalog puts it in the body category (or, not yet classified, BOOTH does).
  const selected = db.prepare(`SELECT DISTINCT i.item_id AS id, i.name FROM asset_selection_plan p
    JOIN asset_selection_file s ON s.plan_id=p.id AND s.selected=1 JOIN booth_file f ON f.downloadable_id=s.downloadable_id
    JOIN booth_item i ON i.item_id=f.item_id WHERE p.project_id=?`).all(businessProjectId) as Array<{ id: string; name: string }>;
  const bodies = selected.length ? bodyItemIds(db, selected.map(row => row.id)) : new Set<string>();
  const boothAvatars = [...new Set(selected.filter(row => bodies.has(row.id)).map(row => row.name))];
  const variants = db.prepare(`SELECT id,name,description,status FROM project_variant WHERE project_id=? ORDER BY created_at`)
    .all(businessProjectId) as DurableProjectState['variants'];
  const roots = db.prepare(`SELECT id,variant_id AS variantId,derived_from AS derivedFrom,scene_path AS scenePath,
    object_path AS objectPath,role,plugin_profile AS pluginProfile,active_state AS activeState,blueprint_id AS blueprintId
    FROM avatar_root WHERE project_id=? ORDER BY rowid`).all(projectId) as DurableProjectState['roots'];
  const workflowRow = db.prepare(`SELECT w.id,w.process_id AS process,w.status,w.knowledge_version AS knowledgeVersion,
    d.frozen_at AS frozenAt FROM workflow w LEFT JOIN workflow_definition d ON d.workflow_id=w.id
    WHERE w.project_id=? ORDER BY w.rowid DESC LIMIT 1`).get(projectId) as
    { id: string; process: string; status: string; knowledgeVersion: string; frozenAt: string | null } | undefined;
  let workflow: DurableProjectState['workflow'] = null;
  let tasks: DurableProjectState['tasks'] = [], cases: DurableProjectState['cases'] = [], gates: DurableProjectState['gates'] = [];
  let evidence: DurableProjectState['evidence'] = { artifacts: [], verdicts: 0, events: 0 };
  if (workflowRow) {
    const frozen = db.prepare('SELECT definition_json AS definition FROM workflow_definition WHERE workflow_id=?')
      .get(workflowRow.id) as { definition: string } | undefined;
    const stages = frozen ? Object.entries(aggregateWorkflow(db, workflowRow.id, JSON.parse(frozen.definition) as ProcessDefinition).stages)
      .map(([id, value]) => ({ id, status: value.status, reasons: value.reasons, codes: value.reasonCodes ?? [] })) : [];
    workflow = { ...workflowRow, stages };
    tasks = db.prepare(`SELECT t.id,t.stage_id AS stage,t.status,t.goal,
      COALESCE((SELECT MAX(occurred_at) FROM event e WHERE e.entity_type='task' AND e.entity_id=t.id),'') AS updatedAt
      FROM task t WHERE t.workflow_id=? ORDER BY t.rowid`).all(workflowRow.id) as DurableProjectState['tasks'];
    const completedTasks=(db.prepare(`SELECT t.id,t.workflow_id AS workflowId,t.stage_id AS stage,t.status,
      COALESCE((SELECT MAX(occurred_at) FROM event e WHERE e.entity_type='task' AND e.entity_id=t.id),'') AS updatedAt
      FROM task t JOIN workflow w ON w.id=t.workflow_id WHERE w.project_id=? AND t.status IN ('PASSED','BLOCKED','FAILED')
      ORDER BY t.rowid DESC LIMIT 20`).all(projectId) as Array<{id:string;workflowId:string;stage:string;status:string;updatedAt:string}>).reverse();
    cases=completedTasks.map(task=>{
      const runs=db.prepare('SELECT id,attempt FROM run WHERE task_id=? ORDER BY attempt').all(task.id) as Array<{id:string;attempt:number}>;
      const modelFamilies=new Set<string>(),evidence:string[]=[];
      for(const run of runs){
        const event=db.prepare(`SELECT payload_json AS payload FROM event WHERE entity_type='run' AND entity_id=?
          AND action='context_compiled' ORDER BY seq DESC LIMIT 1`).get(run.id) as {payload:string}|undefined;
        if(event)try{const family=(JSON.parse(event.payload) as {modelFamily?:unknown}).modelFamily;if(typeof family==='string')modelFamilies.add(family);}catch{/* malformed legacy telemetry is ignored */}
        const verdicts=db.prepare('SELECT id,result FROM verdict WHERE id LIKE ? ORDER BY seq').all(`${run.id}:%`) as Array<{id:string;result:string}>;
        evidence.push(...verdicts.map(verdict=>`${verdict.id}:${verdict.result}`));
      }
      const completion=db.prepare(`SELECT artifact_hashes_json AS hashes FROM stage_completion WHERE workflow_id=? AND stage_id=?
        AND run_id IN (SELECT id FROM run WHERE task_id=?) ORDER BY seq DESC LIMIT 1`).get(task.workflowId,task.stage,task.id) as {hashes:string}|undefined;
      if(completion)try{for(const [kind,hash] of Object.entries(JSON.parse(completion.hashes) as Record<string,string>))evidence.push(`${kind}:${hash}`);}catch{/* legacy evidence remains absent */}
      const lastTransition=db.prepare(`SELECT reason,occurred_at AS at FROM event WHERE entity_type='task' AND entity_id=?
        AND (action LIKE '%->PASSED' OR action LIKE '%->BLOCKED' OR action LIKE '%->FAILED') ORDER BY seq DESC LIMIT 1`)
        .get(task.id) as {reason:string;at:string}|undefined;
      const reason=(lastTransition?.reason??task.status).slice(0,1000);
      return{taskId:task.id,stage:task.stage,outcome:task.status==='PASSED'?'success':'failure',attempts:runs.length,
        modelFamilies:[...modelFamilies].sort(),reason,evidence:[...new Set(evidence)].slice(-20),
        at:lastTransition?.at??task.updatedAt};
    });
    gates = db.prepare(`SELECT gate_id AS id,result,artifact_hash AS artifactHash,recorded_at AS decidedAt
      FROM gate_decision WHERE workflow_id=? ORDER BY rowid`).all(workflowRow.id) as DurableProjectState['gates'];
    evidence = { artifacts: db.prepare(`SELECT kind,hash,observed_at AS observedAt FROM artifact_version
        WHERE workflow_id=? ORDER BY seq`).all(workflowRow.id) as DurableProjectState['evidence']['artifacts'],
      verdicts: (db.prepare('SELECT count(*) AS n FROM verdict WHERE workflow_id=?').get(workflowRow.id) as { n: number }).n,
      events: (db.prepare('SELECT count(*) AS n FROM event WHERE workflow_id=?').get(workflowRow.id) as { n: number }).n };
  }
  const acceptedDecisions = db.prepare(`SELECT content,created_at AS at FROM project_message
    WHERE project_id=? AND status='accepted' ORDER BY created_at`).all(businessProjectId) as DurableProjectState['acceptedDecisions'];
  let identity: unknown = {};
  try { identity = JSON.parse(project.identity); } catch { identity = {}; }
  return { schema: 'harness-project-state/0.1', project: { ...project, identity }, brief: brief ?? null,
    assets, ...(boothAvatars.length ? { boothAvatars } : {}),
    ...(facePreference(db, businessProjectId) ? { faceChoice: { mode: facePreference(db, businessProjectId)!.mode, acceptedVersion: facePreference(db, businessProjectId)!.acceptedSessionId } } : {}),
    variants, roots, workflow, tasks, cases, gates, evidence, acceptedDecisions, generatedAt: '' };
}

const described = (item: { objectId: string; attribute: string }): string => `${item.objectId} ${item.attribute}`;
export function compactProjectContext(state: DurableProjectState): string {
  const lines = [`项目：${state.project.path}`, `目标：${state.brief?.goal || '尚未填写'}`,
    `共同脸部构想：${state.brief?.faceConcept || '尚未确认'}`,
    `素材：${state.assets.map(item => `${item.name}[${item.kind}/${item.role}/${item.status}]`).join('；') || '无'}`,
    `造型：${state.variants.map(item => `${item.name}[${item.status}]`).join('；') || '无'}`,
    `头像根：${state.roots.map(item => `${item.objectPath}[${item.role}/${item.activeState}]`).join('；') || '尚未观测'}`,
    `当前流程：${state.workflow ? `${state.workflow.process} · ${state.workflow.status} · 能力 ${state.workflow.knowledgeVersion}` : '未开始'}`];
  const blocked = state.workflow?.stages.filter(stage => stage.status === 'blocked' || stage.status === 'open') ?? [];
  if (blocked.length) lines.push(`当前工作：${blocked.map(stage => `${stage.id}[${stage.status}] ${stage.reasons[0] ?? ''}`).join('；')}`);
  if (state.faceChoice) lines.push(`脸型方式：${state.faceChoice.mode === 'ai' ? '让 AI 设计' : state.faceChoice.mode === 'preserve' ? '保留原脸，不设计脸型' : state.faceChoice.acceptedVersion ? '我自己来，制作使用已接受的手动输入' : '我自己来，尚未接受手动版本，制作保留原脸；不等待用户、不进行 AI 脸型设计'}`);
  if (state.tasks.length) lines.push(`最近任务：${state.tasks.slice(-3).map(task => `${task.stage}[${task.status}]`).join('；')}`);
  if (state.cases.length) lines.push(`历史案例：${state.cases.slice(-5).map(item => `${item.stage}[${item.outcome}/${item.attempts}次]`).join('；')}`);
  lines.push(`证据：${state.evidence.artifacts.length} 个产物版本，${state.evidence.verdicts} 个验证结论`);
  if (state.acceptedDecisions.length) lines.push(`已确认决定：${state.acceptedDecisions.map(item => item.content).join('；')}`);
  // The archive's candidates and gaps: what this conversation must verify rather than assume.
  const archive = state.archive;
  if (archive?.inferred.length) lines.push(`待确认推断（未经确认，不能当作事实）：${archive.inferred.slice(0, 8)
    .map(item => `${described(item)}=${JSON.stringify(item.value).slice(0, 80)}`).join('；')}${archive.inferred.length > 8 ? ` 等 ${archive.inferred.length} 项` : ''}`);
  if (archive?.stale.length) lines.push(`已失效的结论（输入已变化，需要重新核对）：${archive.stale.slice(0, 8).map(described).join('；')}${
    archive.stale.length > 8 ? ` 等 ${archive.stale.length} 项` : ''}`);
  if (archive?.unknown.length) lines.push(`未知（文件无法证明，不要补写）：${archive.unknown.slice(0, 8).map(described).join('；')}${
    archive.unknown.length > 8 ? ` 等 ${archive.unknown.length} 项` : ''}`);
  if (archive?.missingDependencies.length) lines.push(`缺失依赖：${archive.missingDependencies.join('、')}`);
  return lines.join('\n');
}

/**
 * A project created in Harness starts with an empty identity; only an import fills it. Once the setup stage has made
 * the Unity project, its package manifest and editor version say what the import would have, so they fill the gaps.
 */
function observedIdentity(projectPath: string, identity: unknown): unknown {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return identity;
  const observed = { ...identity as Record<string, unknown> };
  if (!observed.packages) try {
    const manifest = JSON.parse(readFileSync(join(projectPath, 'Packages', 'vpm-manifest.json'), 'utf8')) as
      { locked?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> };
    const listed = manifest.locked ?? manifest.dependencies;
    if (listed && typeof listed === 'object') observed.packages = Object.fromEntries(Object.entries(listed)
      .map(([id, entry]) => [id, typeof entry?.version === 'string' ? entry.version : 'unknown']));
  } catch { /* no Unity project yet */ }
  if (!observed.unityVersion) try {
    const version = /^m_EditorVersion:\s*(.+)$/m.exec(readFileSync(join(projectPath, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'))?.[1]?.trim();
    if (version) observed.unityVersion = version;
  } catch { /* no Unity project yet */ }
  return observed;
}

/**
 * Base avatars the built-in knowledge is written for, with the names their products and files usually carry.
 *
 * Exported so the invariant is checked rather than trusted: a knowledge pack that routes on a body this map does
 * not know about can never fire, because `memory.project.identity.base` is computed here. The set must stay equal
 * to the bodies the pack routes on, which is also the set of body knowledge files; a new body means one more line
 * here and no code change (order D-110 made the drift risk explicit, and the test is what closes it).
 */
export const KNOWN_BASES: Record<string, string[]> = {
  Kaguya: ['kaguya', 'かぐや', 'カグヤ'], Milfy: ['milfy', 'ミルフィ'], Kipfel: ['kipfel', 'キプフェル'],
  Shinano: ['shinano', 'しなの'], Rurune: ['rurune', 'ルルネ'], Manuka: ['manuka', 'マヌカ'],
};
/** The base avatar as one name that context conditions can compare: an import's note, or the project's avatar asset. */
function baseName(identity: unknown, assets: DurableProjectState['assets'], boothAvatars: string[] = []): string | undefined {
  const stored = identity && typeof identity === 'object' ? (identity as { base?: unknown }).base : undefined;
  if (typeof stored === 'string' && stored.trim()) {
    // An import writes 「最可能：Kaguya（12 次）；其他候选：…」 when it inferred the base from mentions.
    const likely = /^最可能：(.+?)（/.exec(stored.trim())?.[1] ?? stored.trim();
    return Object.keys(KNOWN_BASES).find(name => name.toLowerCase() === likely.toLowerCase()) ?? likely;
  }
  // Only the avatar asset names the base: outfit titles list every avatar they fit.
  const names = [...assets.filter(asset => asset.kind === 'avatar' && asset.role !== 'rejected').map(asset => `${asset.name} ${basename(asset.path)}`),
    ...boothAvatars];
  const found = Object.entries(KNOWN_BASES).filter(([, aliases]) => names.some(name =>
    aliases.some(alias => name.toLowerCase().includes(alias.toLowerCase())))).map(([name]) => name);
  return found.length === 1 ? found[0] : undefined;
}

/** Stable, bounded facts for context trigger rules; raw conversations never enter this surface. */
function packageIds(identity: unknown): string[] {
  const packages = identity && typeof identity === 'object' ? (identity as { packages?: unknown }).packages : undefined;
  return packages && typeof packages === 'object' && !Array.isArray(packages) ? Object.keys(packages).sort() : [];
}
function withBase(identity: unknown, base: string | undefined): unknown {
  if (!base || !identity || typeof identity !== 'object' || Array.isArray(identity)) return identity;
  return { ...identity as Record<string, unknown>, base };
}
const FAILURE_CODES = new Set(['check_failed', 'out_of_bounds']);
export function projectContextFacts(state: DurableProjectState): Record<string, unknown> {
  const roles = (values: Array<{ role: string }>) => Object.fromEntries([...new Set(values.map(item => item.role))].sort()
    .map(role => [role, values.filter(item => item.role === role).length]));
  // A stage failed when one of its checks failed or its executor wrote out of bounds, or an earlier Task of it ended
  // in failure. A stage that is merely waiting (for its first verdict, a decision or an upstream stage) has not failed:
  // counting those made every stage look failed on its first dispatch.
  const failedIds = [...new Set([
    ...(state.workflow?.stages.filter(stage => stage.status === 'blocked' && (stage.codes ?? []).some(code => FAILURE_CODES.has(code)))
      .map(stage => stage.id) ?? []),
    ...state.cases.filter(item => item.outcome === 'failure').map(item => item.stage)])].sort();
  const failedStages = failedIds.map(id => ({ id }));
  return {
    project: { id: state.project.id, lifecycle: state.project.lifecycle, identity: withBase(state.project.identity, baseName(state.project.identity, state.assets, state.boothAvatars)),
      // Package ids contain dots, which a condition path would split; a list lets a condition test them with includes.
      packageIds: packageIds(state.project.identity) },
    brief: state.brief ? { intakeMode: state.brief.intakeMode, goal: state.brief.goal, faceConcept: state.brief.faceConcept,
      status: state.brief.status } : null,
    assets: { count: state.assets.length, roles: roles(state.assets), ids: state.assets.map(item => item.id),
      kinds: [...new Set(state.assets.map(item => item.kind))].sort() },
    variants: { count: state.variants.length, ids: state.variants.map(item => item.id),
      activeIds: state.variants.filter(item => item.status !== 'archived').map(item => item.id) },
    avatarRoots: { count: state.roots.length, activeCount: state.roots.filter(item => item.activeState === 'active').length,
      roles: roles(state.roots), pluginProfiles: [...new Set(state.roots.map(item => item.pluginProfile).filter(Boolean))].sort() },
    preferences: { accepted: state.acceptedDecisions.map(item => item.content), count: state.acceptedDecisions.length },
    history: { failedStageIds: failedStages.map(stage => stage.id), failedStageCount: failedStages.length,
      artifactVersions: state.evidence.artifacts.length, verdicts: state.evidence.verdicts },
    cases: { successCount: state.cases.filter(item=>item.outcome==='success').length,
      failureCount: state.cases.filter(item=>item.outcome==='failure').length,
      successStageIds: [...new Set(state.cases.filter(item=>item.outcome==='success').map(item=>item.stage))].sort(),
      failureStageIds: [...new Set(state.cases.filter(item=>item.outcome==='failure').map(item=>item.stage))].sort(),
      recent: state.cases.slice(-10).map(item=>({stage:item.stage,outcome:item.outcome,attempts:item.attempts,
        modelFamilies:item.modelFamilies,reason:item.reason,evidence:item.evidence})) },
    // Context conditions can react to what the archive does not know yet (a takeover starts from a baseline).
    archive: { inferredCount: state.archive?.inferred.length ?? 0, staleCount: state.archive?.stale.length ?? 0,
      unknownCount: state.archive?.unknown.length ?? 0,
      historyUnknown: (state.archive?.unknown ?? []).some(item => item.attribute.startsWith('history.')),
      missingDependencies: state.archive?.missingDependencies ?? [] },
  };
}

/**
 * Bring the project's archive (_harness/, see docs/project-archive.md) up to date at a safe point and return the state
 * for a conversation. SQLite remains the transactional runtime state; the archive is its portable, verified projection,
 * with `_harness/state/project.yaml` as its human-readable summary. When a Run is active in the project nothing is
 * written now: the next safe point writes it.
 */
export function writeProjectState(db: DatabaseSync, projectId: string): { path: string; state: DurableProjectState; compact: string } {
  const state = projectState(db, projectId);
  projectSafePoint(db, projectId);
  const path = join(state.project.path, '_harness', 'state', 'project.yaml');
  return { path, state, compact: compactProjectContext(state) };
}
