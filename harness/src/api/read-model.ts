import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { artifactFingerprint, fileHash } from '../workflow/artifacts.ts';
import { projectRoot } from '../archive/takeover.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ImportReport } from '../import/types.ts';
import type { RunResult } from '../runtime/interfaces.ts';
import { buildAggregateInput } from '../state/aggregate-input.ts';
import { taskGates, taskNextStep, type TaskSpec } from '../task-cli.ts';
import { formalGates, isFormalWorkflow, workflowSnapshot } from '../workflow/runtime.ts';
import { describeWorkflow } from '../workflow/view.ts';

/**
 * Structured, read-only views for the local API. Interfaces render these; they never read tables directly,
 * so the storage schema can change behind this module.
 */
export interface ProjectRow {
  id: string; path: string; name: string; kind: string;
  lastImport?: { reportId: string; at: string; counts: Record<'verified' | 'claimed' | 'unknown' | 'not_applicable', number>;
    base?: string; unityVersion?: string; failedReviews: number; unresolved: number };
  workflow?: { id: string; profile: string; status: string; next: string };
  tasks: { total: number; open: number; needsYou: number };
}
export interface TaskRow {
  id: string; workflowId: string; formal: boolean; project: string; projectName: string; stage: string;
  status: string; goal: string; updatedAt: string | null; waitReason?: string; needsYou: boolean;
}
export interface RunView {
  id: string; attempt: number; provider: string | null; status: string;
  exitStatus?: number | null; errorClass?: string; errorMessage?: string; unitySteps?: number;
  /** Where the Run's logs and evidence are, for a person checking it by hand. */
  directory?: string;
}
export interface TaskDetail extends TaskRow {
  reviewToken?:string;
  role?: string; allowedWrites: string[]; expectedOutputs: string[]; next: string;
  wait?: { reason: string; since: string; updated: string };
  runs: RunView[];
  verdicts: Array<{ checkId: string; scope: string; result: string; basis: string | null; recordedAt: string; current: boolean }>;
  outOfBounds: Array<{ seq: number; artifact: string; recordedAt: string; changes?: {added:string[];removed:string[];modified:string[];counts:number[]} }>;
  events: Array<{ seq: number; at: string; actor: string; action: string; reason: string; proof?: string }>;
}
export interface GateRow {
  gate: string; workflowId: string; formal: boolean; project: string; projectName: string; owner: string;
  status: string; question: string; binds: string; artifactHash?: string;
  inputHashes?: Record<string, string>;
  projectId?: string; selection?: 'face-candidate'; review?: 'face-output'; preview?: 'recolor-candidates';
}
export interface EventRow { seq: number; at: string; workflowId: string | null; actor: string; entityType: string;
  entityId: string; action: string; reason: string;
  /** What the event is about, for a reader: the stage of a task event, the name of an asset. */
  stageId?: string; subject?: string }

const NEEDS_YOU = new Set(['WAITING_HUMAN', 'BLOCKED', 'RECOVERY_REQUIRED', 'FAILED']);
/** A Workflow that has ended leaves nothing for the person to do, whatever its last Tasks' states. */
const ENDED_WORKFLOW = new Set(['cancelled', 'client_verified']);
function count(db: DatabaseSync, sql: string, ...args: string[]): number {
  return Number((db.prepare(sql).get(...args) as { n: number }).n);
}

function projectDisplayName(db: DatabaseSync, path: string): string {
  const manual = db.prepare('SELECT project_id,version FROM face_manual_session WHERE project_path=?').get(path);
  const parent = manual && db.prepare('SELECT path FROM project WHERE id=?').get(manual.project_id!);
  return parent ? `${basename(String(parent.path))} · 手动脸型${manual.version ? '版本 ' + manual.version : '草稿'}` : basename(path);
}

export function projectRows(db: DatabaseSync): ProjectRow[] {
  const projects = db.prepare('SELECT id,path,kind FROM project p WHERE NOT EXISTS (SELECT 1 FROM production_continuation c WHERE c.successor_project_id=p.id) ORDER BY path').all() as { id: string; path: string; kind: string }[];
  return projects.map(project => {
    const report = db.prepare(`SELECT id, created_at, report_json FROM import_report WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(project.id) as { id: string; created_at: string; report_json: string } | undefined;
    let lastImport: ProjectRow['lastImport'];
    if (report) {
      const parsed = JSON.parse(report.report_json) as ImportReport;
      const counts = { verified: 0, claimed: 0, unknown: 0, not_applicable: 0 };
      for (const stage of parsed.stages) counts[stage.status]++;
      lastImport = { reportId: report.id, at: report.created_at, counts,
        ...(parsed.identity.base ? { base: parsed.identity.base } : {}),
        ...(parsed.identity.unityVersion ? { unityVersion: parsed.identity.unityVersion } : {}),
        failedReviews: parsed.reviews.filter(review => review.status === 'fail').length,
        unresolved: [...parsed.ledger, ...parsed.externalLedger].filter(item => item.status !== 'done' && item.status !== 'dropped').length };
    }
    const formal = db.prepare('SELECT workflow_id AS id FROM production_head WHERE logical_project_id=?').get(project.id) ?? db.prepare(`SELECT w.id FROM workflow w JOIN workflow_definition d ON d.workflow_id = w.id
      WHERE w.project_id = ? AND w.process_id<>'manual-face' ORDER BY w.rowid DESC LIMIT 1`).get(project.id) as { id: string } | undefined;
    const view = formal ? describeWorkflow(db, String(formal.id)) : undefined;
    return { id: project.id, path: project.path, name: projectDisplayName(db, project.path), kind: project.kind,
      ...(lastImport ? { lastImport } : {}),
      // Progress counts stages, not tasks: a Workflow creates a stage's Task only when the stage can start.
      ...(view ? { workflow: { id: view.id, profile: view.profile, status: view.status, next: view.next,
        stagesPassed: view.stages.filter(stage => stage.status === 'passed').length, stagesTotal: view.stages.length } } : {}),
      tasks: { total: count(db, 'SELECT COUNT(*) AS n FROM task t JOIN workflow w ON w.id = t.workflow_id WHERE w.project_id = ?', project.id),
        open: count(db, `SELECT COUNT(*) AS n FROM task t JOIN workflow w ON w.id = t.workflow_id WHERE w.project_id = ?
          AND t.status NOT IN ('PASSED', 'FAILED', 'CANCELLED')`, project.id),
        // The same count the inbox shows for this project.
        needsYou: taskRows(db, { project: project.path }).filter(task => task.needsYou).length } };
  });
}

type RawTask = { id: string; workflow_id: string; process_hash: string; path: string; stage_id: string; status: string;
  goal: string; plan_json: string; workflow_status: string };
function taskBase(db: DatabaseSync, raw: RawTask): TaskRow {
  const last = db.prepare(`SELECT occurred_at FROM event WHERE entity_type = 'task' AND entity_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(raw.id) as { occurred_at: string } | undefined;
  const wait = raw.status === 'READY' ? db.prepare(`SELECT reason FROM event WHERE entity_type = 'task' AND entity_id = ?
    AND action = 'route_waiting' ORDER BY seq DESC LIMIT 1`).get(raw.id) as { reason: string } | undefined : undefined;
  const formal = raw.process_hash !== 'avh-task/0.1';
  return { id: raw.id, workflowId: raw.workflow_id, formal, project: raw.path, projectName: projectDisplayName(db, raw.path), stage: raw.stage_id,
    status: raw.status, goal: formal ? `阶段 ${raw.stage_id}` : raw.goal, updatedAt: last?.occurred_at ?? null,
    ...(wait ? { waitReason: wait.reason } : {}), needsYou: NEEDS_YOU.has(raw.status) && !ENDED_WORKFLOW.has(raw.workflow_status) };
}
const TASK_SQL = `SELECT t.id, t.workflow_id, w.process_hash, p.path, t.stage_id, t.status, t.goal, w.plan_json,
  w.status AS workflow_status FROM task t JOIN workflow w ON w.id = t.workflow_id JOIN project p ON p.id = w.project_id`;

/** Latest Task of each stage of each Workflow, newest first; `project` filters by name or path. */
export function taskRows(db: DatabaseSync, filter: { project?: string; openOnly?: boolean } = {}): TaskRow[] {
  const rows = db.prepare(`${TASK_SQL} WHERE t.rowid = (SELECT MAX(rowid) FROM task WHERE workflow_id = t.workflow_id
    AND stage_id = t.stage_id) ORDER BY t.rowid DESC`).all() as RawTask[];
  // A formal stage waiting on its predecessors runs again once they pass: its old Task is not the person's job. Nor is a
  // stage waiting for a Gate decision: the Gate is listed for the person, and rejecting it can redo the stage.
  const stages = new Map<string, Map<string, string>>();
  const stageDisplay = (row: RawTask): string | undefined => {
    if (row.process_hash === 'avh-task/0.1' || ENDED_WORKFLOW.has(row.workflow_status)) return undefined;
    if (!stages.has(row.workflow_id)) stages.set(row.workflow_id,
      new Map(describeWorkflow(db, row.workflow_id).stages.map(stage => [stage.id, stage.display ?? stage.status])));
    return stages.get(row.workflow_id)!.get(row.stage_id);
  };
  return rows.filter(row => !filter.project || row.path === filter.project || basename(row.path) === filter.project)
    .filter(row => !filter.openOnly || !['PASSED', 'FAILED', 'CANCELLED'].includes(row.status))
    .map(row => {
      const task = taskBase(db, row);
      return task.needsYou && ['waiting', 'deciding'].includes(stageDisplay(row) ?? '') ? { ...task, needsYou: false } : task;
    });
}

export function taskReviewToken(db:DatabaseSync,id:string):string {
  const task=db.prepare('SELECT t.workflow_id,w.project_id FROM task t JOIN workflow w ON w.id=t.workflow_id WHERE t.id=?').get(id);
  if(!task)throw Object.assign(new Error('找不到技术审阅任务'),{code:'NOT_FOUND'});
  const project=projectRoot(db,String(task.project_id)),formal=isFormalWorkflow(db,String(task.workflow_id));
  const spec=formal?workflowSnapshot(db,String(task.workflow_id)).capabilities.artifacts:{};
  const rows=db.prepare('SELECT seq,artifact FROM out_of_bounds_change WHERE workflow_id=? AND accepted=0 ORDER BY seq').all(task.workflow_id);
  const bound=rows.map(row=>{
    const artifact=String(row.artifact),path=artifact.startsWith('workspace:')?artifact.slice(10):undefined;
    const safe=path&&!path.startsWith('/')&&!/[\\:\x00-\x1f]/.test(path)&&!path.split('/').some(p=>!p||p==='.'||p==='..');
    const hash=safe?fileHash(join(project,path)):spec[artifact]?artifactFingerprint(project,spec[artifact]!):null;
    return{seq:row.seq,artifact,hash:hash??null};
  });
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex');
}
export function taskDetail(db: DatabaseSync, id: string, home?: string): TaskDetail {
  const raw = db.prepare(`${TASK_SQL} WHERE t.id = ?`).get(id) as RawTask | undefined;
  if (!raw) throw Object.assign(new Error(`找不到任务 ${id}`), { code: 'NOT_FOUND' });
  const base = taskBase(db, raw);
  let spec: Partial<TaskSpec> = {};
  if (!base.formal) spec = (JSON.parse(raw.plan_json) as { task: TaskSpec }).task;
  else {
    const snapshot = workflowSnapshot(db, raw.workflow_id);
    const capability = snapshot.capabilities.stages[raw.stage_id];
    const stage = snapshot.definition.stages.find(item => item.id === raw.stage_id);
    spec = { ...(capability?.role ? { role: capability.role } : {}), allowedWrites: capability?.allowedWrites ?? [],
      expectedOutputs: (stage?.produces ?? []).flatMap(kind => snapshot.capabilities.artifacts[kind]?.paths ?? []) };
  }
  const events = (db.prepare(`SELECT seq, occurred_at, actor, action, reason, payload_json FROM event WHERE workflow_id = ?
    AND (entity_id = ? OR (entity_type = 'run' AND entity_id IN (SELECT id FROM run WHERE task_id = ?)))
    ORDER BY seq DESC LIMIT 200`).all(raw.workflow_id, id, id) as { seq: number; occurred_at: string; actor: string;
      action: string; reason: string; payload_json: string }[]).reverse();
  const runs = (db.prepare('SELECT id, attempt, provider, status, result_json FROM run WHERE task_id = ? ORDER BY attempt')
    .all(id) as { id: string; attempt: number; provider: string | null; status: string; result_json: string | null }[]).map(run => {
      const result = run.result_json ? JSON.parse(run.result_json) as Partial<RunResult> : undefined;
      return { id: run.id, attempt: run.attempt, provider: run.provider, status: run.status,
        ...(home ? { directory: join(home, 'runs', run.id) } : {}),
        ...(result && 'exitStatus' in result ? { exitStatus: result.exitStatus ?? null } : {}),
        ...(result?.errorClass ? { errorClass: result.errorClass } : {}),
        ...(result?.errorMessage ? { errorMessage: result.errorMessage.slice(0, 500) } : {}),
        ...(result?.unitySteps ? { unitySteps: result.unitySteps.length } : {}) };
    });
  const input = buildAggregateInput(db, raw.workflow_id);
  const checks = base.formal ? workflowSnapshot(db, raw.workflow_id).definition.checks : [];
  const verdicts = (db.prepare(`SELECT check_id, scope, artifact_hash, result, basis, recorded_at FROM verdict WHERE id IN
    (SELECT value FROM json_each(COALESCE((SELECT json_extract(result_json, '$.verdictIds') FROM run WHERE task_id = ?
      ORDER BY attempt DESC LIMIT 1), '[]'))) ORDER BY check_id`).all(id) as { check_id: string; scope: string; artifact_hash: string;
      result: string; basis: string | null; recorded_at: string }[]).map(row => {
      const on = checks.find(check => check.id === row.check_id)?.on;
      const current = on ? row.artifact_hash === input.artifactHashes[on] || row.artifact_hash === input.artifactHashes.plan
        : Object.values(input.artifactHashes).includes(row.artifact_hash);
      return { checkId: row.check_id, scope: row.scope, result: row.result, basis: row.basis, recordedAt: row.recorded_at, current };
    });
  const outOfBounds = db.prepare(`SELECT seq, artifact, recorded_at FROM out_of_bounds_change WHERE workflow_id = ? AND accepted = 0
    ORDER BY seq`).all(raw.workflow_id) as { seq: number; artifact: string; recorded_at: string }[];
  const readyAt = events.findLastIndex(event => event.action.endsWith('->READY'));
  const waits = events.slice(readyAt + 1).filter(event => event.action === 'route_waiting');
  const projectLocked = Boolean(db.prepare(`SELECT 1 FROM lock l JOIN workflow w ON l.resource = 'project:' || w.project_id
    WHERE w.id = ?`).get(raw.workflow_id));
  const changed = raw.status === 'PASSED' && !base.formal && events.some(event => event.action === 'evidence_invalidated') ? 1 : 0;
  return { ...base, ...(spec.role ? { role: spec.role } : {}), allowedWrites: spec.allowedWrites ?? [],
    expectedOutputs: spec.expectedOutputs ?? [],
    next: base.formal ? describeWorkflow(db, raw.workflow_id).next
      : taskNextStep(raw.status, outOfBounds.length, changed, projectLocked, waits.length > 0),
    ...(raw.status === 'READY' && waits.length ? { wait: { reason: waits.at(-1)!.reason, since: waits[0]!.occurred_at,
      updated: waits.at(-1)!.occurred_at } } : {}),
    ...(outOfBounds.length?{reviewToken:taskReviewToken(db,id)}:{}),runs, verdicts, outOfBounds: outOfBounds.map(row => {
      const latest = db.prepare("SELECT payload_json FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='artifact_version' AND entity_id=? AND action='observed' ORDER BY seq DESC LIMIT 1").get(raw.workflow_id,row.artifact);
      const changes = latest ? JSON.parse(String(latest.payload_json)).change : undefined;
      return { seq: row.seq, artifact: row.artifact, recordedAt: row.recorded_at, ...(changes ? {changes} : {}) };
    }),
    events: events.map(event => {
      const payload = JSON.parse(event.payload_json) as { proof?: string };
      return { seq: event.seq, at: event.occurred_at, actor: event.actor, action: event.action, reason: event.reason,
        ...(payload.proof ? { proof: payload.proof } : {}) };
    }) };
}

export function gateRows(db: DatabaseSync, home: string): GateRow[] {
  const temporary = taskGates(db, home).map(gate => ({ gate: gate.gate, workflowId: gate.gate.slice(0, gate.gate.lastIndexOf(':')),
    formal: false, project: gate.project, projectName: projectDisplayName(db, gate.project), owner: `task:${gate.taskId}`, status: gate.status,
    question: gate.question, binds: gate.binds, artifactHash: gate.artifactHash }));
  const formal = (db.prepare(`SELECT w.id FROM workflow w JOIN workflow_definition d ON d.workflow_id = w.id
    WHERE w.status <> 'cancelled' ORDER BY w.rowid`).all() as { id: string }[])
    .flatMap(({ id }) => formalGates(db, id)).filter(gate => gate.status !== 'waiting').map(gate => ({ gate: gate.gate,
      workflowId: gate.workflowId, formal: true, project: gate.project, projectId: gate.projectId, projectName: projectDisplayName(db, gate.project), owner: gate.owner,
      inputHashes: gate.inputHashes,
      ...(gate.expectedFaceRevision!==undefined ? {expectedFaceRevision:gate.expectedFaceRevision} : {}),
      ...(gate.selection ? { selection: gate.selection } : {}),
      ...(gate.review ? { review: gate.review } : {}),
      ...(gate.preview ? { preview: gate.preview } : {}),
      status: gate.status, question: gate.review === 'face-output' ? '查看当前工程的实际脸型效果，接受或提出调整要求'
        : gate.preview === 'recolor-candidates' ? '查看 Unity 渲染的配色候选图，批准当前版本或提出调整要求'
        : gate.selection === 'face-candidate' ? '选择希望继续制作的脸型候选' : gate.kind === 'do' ? `需要你亲手完成（${gate.binds}）` : `批准当前 ${gate.binds}？`, binds: gate.binds,
      ...(gate.artifactHash ? { artifactHash: gate.artifactHash } : {}) }));
  return [...temporary, ...formal];
}

/** The latest Task of the stage that owns a formal Gate; undefined for a Gate a stage does not own. */
export function gateStageTask(db: DatabaseSync, gate: string): string | undefined {
  const workflowId = gate.slice(0, gate.lastIndexOf(':'));
  if (!isFormalWorkflow(db, workflowId)) return undefined;
  const owner = formalGates(db, workflowId).find(item => item.gate === gate)?.owner;
  if (!owner?.startsWith('stage:')) return undefined;
  return (db.prepare('SELECT id FROM task WHERE workflow_id = ? AND stage_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(workflowId, owner.slice(6)) as { id: string } | undefined)?.id;
}

export function eventsAfter(db: DatabaseSync, seq: number, limit = 200): EventRow[] {
  return (db.prepare(`SELECT e.seq, e.occurred_at, e.workflow_id, e.actor, e.entity_type, e.entity_id, e.action, e.reason,
      t.stage_id, a.name AS asset_name FROM event e
    LEFT JOIN task t ON e.entity_type = 'task' AND t.id = e.entity_id
    LEFT JOIN asset a ON e.entity_type = 'asset' AND a.id = e.entity_id
    WHERE e.seq > ? ORDER BY e.seq LIMIT ?`).all(seq, Math.min(Math.max(limit, 1), 1000)) as { seq: number; occurred_at: string;
      workflow_id: string | null; actor: string; entity_type: string; entity_id: string; action: string; reason: string;
      stage_id: string | null; asset_name: string | null }[])
    .map(row => ({ seq: row.seq, at: row.occurred_at, workflowId: row.workflow_id, actor: row.actor, entityType: row.entity_type,
      entityId: row.entity_id, action: row.action, reason: row.reason, ...(row.stage_id ? { stageId: row.stage_id } : {}),
      ...(row.asset_name ? { subject: row.asset_name } : {}) }));
}
/** The newest events, oldest first. */
export function recentEvents(db: DatabaseSync, limit = 50): EventRow[] {
  const newest = latestEventSeq(db);
  return eventsAfter(db, Math.max(0, newest - Math.min(Math.max(limit, 1), 500)), limit);
}
export function latestEventSeq(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM event').get() as { n: number }).n);
}
