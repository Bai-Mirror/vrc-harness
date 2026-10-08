import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { planValue, warningUnaccepted } from '../process/aggregate.ts';
import type { StageStatus } from '../process/types.ts';
import { aggregateWorkflow, buildAggregateInput } from '../state/aggregate-input.ts';
import { formalGates, workflowSnapshot, type FormalGate } from './runtime.ts';
import { evidenceFresh, evidenceInputHashes } from '../process/evidence.ts';

/** Read models of formal Workflows, shared by the CLI and the local API. No writes. */

/**
 * One check with everything a conclusion needs to be traceable: which artifact and version was judged, over what scope,
 * by which method, and when. A sentence on a page is only a conclusion if it can point back at a record like this; the
 * fields are read from the Runtime's own rows and are never composed by an AI
 * (docs/zh/设计/2-功能模块/19_信息包装规范.md §7).
 */
export interface CheckView {
  id: string; label?: string; severity: string; scope: string; on: string; rule: string; observe: string; when?: string;
  /** The maturity and source of the check's method, as the frozen process declares them. */
  maturity: string; source?: string;
  verdict?: { result: string; basis: string | null; recordedAt: string; current: boolean;
    /** The Verdict's own id: what an acceptance binds, so a client can name the reading it shows. */
    id: string;
    /** The scope the verdict was recorded at; a verdict only stands while it matches the check's own scope. */
    scope: string;
    /** The artifact version this verdict was recorded against. */
    artifactHash: string;
    /** The version it must match to still count; absent when the workflow has no such artifact yet. */
    boundHash: string | null;
    /**
     * Whether a person accepted exactly this reading. A warning blocks the stage until it is accepted, and the
     * acceptance is bound to the verdict: a new reading for the same check starts unaccepted.
     */
    accepted: boolean;
    /** When the acceptance was recorded, or null while this reading has none. */
    acceptedAt: string | null };
  /**
   * Whether the Runtime would accept this reading right now: a warning of a Workflow that is still running, whose
   * evidence stands against the current version, which has not passed and has no acceptance bound to this reading. A
   * client shows its accept control from this rather than re-deciding from `severity` and `result`, so the control
   * cannot offer something the Runtime refuses — a cancelled Workflow accepts nothing, so its stages must not keep
   * offering an entry that can only come back refused. Derived by the aggregate's own judgement
   * (process/aggregate.ts `warningUnaccepted`), not by the view.
   */
  acceptanceRequired: boolean;
}
export interface StageView {
  id: string; status: StageStatus; reasons: string[]; codes: string[];
  /**
   * What to show a person: 'running' while the stage's Task is still working, even though its checks have no verdicts
   * yet; 'deciding' while it waits only for the person's decision on one of its Gates (the Gate is the thing to act on).
   * Added within API v1, so clients fall back to `status` when a service does not send it.
   */
  display?: StageStatus | 'running' | 'deciding';
  task?: { id: string; status: string; attempts: number };
  checks: CheckView[]; gates: string[]; produces: string[];
}
export interface WorkflowView {
  id: string; project: string; projectName: string; profile: string; status: string;
  createdAt: string | null; frozenAt: string; processHash: string; knowledgeVersion: string;
  request?: string;
  plan: { hash?: string; revisions: number; error?: string; approved: boolean };
  stages: StageView[];
  milestones: Array<{ id: string; status: string; reasons: string[] }>;
  gates: FormalGate[];
  next: string;
}
export interface WorkflowRow {
  id: string; project: string; projectName: string; profile: string; status: string; createdAt: string | null;
  stagesPassed: number; stagesTotal: number; current?: string; next: string;
}

const ACTIVE_TASK = new Set(['PENDING', 'READY', 'RUNNING', 'VERIFYING']);

function createdAt(db: DatabaseSync, workflowId: string): string | null {
  const row = db.prepare("SELECT occurred_at FROM event WHERE entity_type = 'workflow' AND entity_id = ? AND action = 'created' ORDER BY seq LIMIT 1")
    .get(workflowId) as { occurred_at: string } | undefined;
  return row?.occurred_at ?? null;
}

export function describeWorkflow(db: DatabaseSync, workflowId: string): WorkflowView {
  const snapshot = workflowSnapshot(db, workflowId);
  const row = db.prepare(`SELECT w.status, w.process_hash, w.knowledge_version, p.path FROM workflow w
    JOIN project p ON p.id = w.project_id WHERE w.id = ?`).get(workflowId) as
    { status: string; process_hash: string; knowledge_version: string; path: string };
  const input = buildAggregateInput(db, workflowId);
  const result = aggregateWorkflow(db, workflowId, snapshot.definition);
  const gates = formalGates(db, workflowId);
  const verdictRows = db.prepare(`SELECT id, check_id, scope, artifact_hash, result, basis, recorded_at, input_hashes_json FROM verdict
    WHERE workflow_id = ? ORDER BY seq`).all(workflowId) as { id: string; check_id: string; scope: string; artifact_hash: string;
      result: string; basis: string | null; recorded_at: string; input_hashes_json: string | null }[];
  const latestVerdict = new Map(verdictRows.map(item => [item.check_id, item]));
  // An acceptance is about one Verdict id, so a new reading never inherits the old one's acceptance.
  const acceptance = new Map((db.prepare(`SELECT verdict_id, recorded_at FROM warning_acceptance
    WHERE workflow_id = ? ORDER BY seq`).all(workflowId) as { verdict_id: string; recorded_at: string }[])
    .map(row => [row.verdict_id, row.recorded_at]));
  const stages: StageView[] = snapshot.definition.stages.map(stage => {
    const state = result.stages[stage.id]!;
    const task = db.prepare(`SELECT t.id, t.status, (SELECT COUNT(*) FROM run WHERE task_id = t.id) AS attempts FROM task t
      WHERE t.workflow_id = ? AND t.stage_id = ? ORDER BY t.rowid DESC LIMIT 1`).get(workflowId, stage.id) as
      { id: string; status: string; attempts: number } | undefined;
    const checks = stage.requires.map(id => {
      const check = snapshot.definition.checks.find(item => item.id === id)!;
      const verdict = latestVerdict.get(id);
      const bound = check.when && !planValue(input.plan, check.when) ? input.artifactHashes.plan : input.artifactHashes[check.on];
      // `label` is display metadata only. It deliberately does not participate in stage adoption or process semantics.
      return { id, ...(check.label ? { label: check.label } : {}), severity: check.severity, scope: check.scope, on: check.on, rule: check.rule, observe: check.observe,
        maturity: check.maturity, ...(check.source ? { source: check.source } : {}),
        ...(check.when ? { when: check.when } : {}),
        acceptanceRequired: row.status !== 'cancelled' && check.severity === 'warning' &&
          warningUnaccepted(snapshot.definition, check, input),
        // The recorded hash and the bound hash are what makes "证据已过期" checkable by the reader rather than asserted
        // by the interface: the verdict stands only while the two are equal.
        ...(verdict ? { verdict: { result: verdict.result, basis: verdict.basis, recordedAt: verdict.recorded_at, id: verdict.id,
          current: evidenceFresh(verdict.artifact_hash, bound, verdict.input_hashes_json ? JSON.parse(verdict.input_hashes_json) : undefined,
            evidenceInputHashes(snapshot.definition, { checkId: id }, input.artifactHashes)) && verdict.scope === check.scope,
          scope: verdict.scope, artifactHash: verdict.artifact_hash, boundHash: bound ?? null,
          accepted: acceptance.has(verdict.id), acceptedAt: acceptance.get(verdict.id) ?? null } } : {}) };
    });
    // A redo of a passed stage is working too: show it as running, not as the result it is about to replace.
    const working = task && ACTIVE_TASK.has(task.status);
    const deciding = stage.gates.some(id => ['pending', 'stale'].includes(gates.find(gate => gate.gate === `${workflowId}:${id}`)?.status ?? ''));
    return { id: stage.id, status: state.status, display: working ? 'running' : deciding ? 'deciding' : state.status, reasons: state.reasons,
      codes: state.reasonCodes ?? [], ...(task ? { task } : {}), checks, gates: stage.gates, produces: stage.produces };
  });
  const plan = db.prepare('SELECT hash, error FROM plan_revision WHERE workflow_id = ? ORDER BY seq DESC LIMIT 1')
    .get(workflowId) as { hash: string; error: string | null } | undefined;
  const revisions = (db.prepare('SELECT COUNT(*) AS n FROM plan_revision WHERE workflow_id = ?').get(workflowId) as { n: number }).n;
  const planGate = snapshot.definition.gates.find(gate => gate.binds === 'plan');
  const view: WorkflowView = { id: workflowId, project: row.path, projectName: basename(row.path), profile: snapshot.profile,
    status: row.status, createdAt: createdAt(db, workflowId), frozenAt: snapshot.frozenAt, processHash: row.process_hash,
    knowledgeVersion: row.knowledge_version, ...(snapshot.manifest ? { request: snapshot.manifest.request } : {}),
    plan: { ...(input.artifactHashes.plan ? { hash: input.artifactHashes.plan } : {}), revisions,
      ...(plan?.error ? { error: plan.error } : {}),
      approved: Boolean(planGate && gates.find(gate => gate.gate === `${workflowId}:${planGate.id}`)?.status === 'approved') },
    stages, milestones: Object.entries(result.milestones).map(([id, value]) => ({ id, status: value.status, reasons: value.reasons })),
    gates, next: '' };
  view.next = nextStep(view);
  return view;
}

/** One warning reading a person may have to accept, with the state that decides whether it still blocks. */
export interface WarningRow {
  workflowId: string; project: string; projectName: string; stage: string;
  checkId: string; scope: string; on: string; rule: string; observe: string;
  verdictId: string; result: string; recordedAt: string;
  artifactHash: string; boundHash: string | null; current: boolean;
  /**
   * Whether the check's own `when` still holds in the current plan. A warning that does not apply reads
   * `not_applicable` and is neither blocking nor something the Runtime would let a person accept.
   */
  applies: boolean;
  accepted: boolean; acceptedAt: string | null;
  /** True while this very reading is an unaccepted warning the Runtime would accept. */
  blocks: boolean;
}

/**
 * Current warning readings across formal Workflows, for the terminal and the local API. Warnings are not Gates: they
 * are readings a person accepts, so they are listed with the verdict they bind rather than as a pending decision.
 */
export function warningRows(db: DatabaseSync): WarningRow[] {
  const ids = db.prepare(`SELECT w.id FROM workflow w JOIN workflow_definition d ON d.workflow_id = w.id
    WHERE w.status <> 'cancelled' ORDER BY w.rowid`).all() as { id: string }[];
  const rows: WarningRow[] = [];
  for (const { id } of ids) {
    const snapshot = workflowSnapshot(db, id);
    const row = db.prepare(`SELECT p.path FROM workflow w JOIN project p ON p.id = w.project_id WHERE w.id = ?`)
      .get(id) as { path: string };
    const input = buildAggregateInput(db, id);
    const verdicts = db.prepare(`SELECT id, check_id, scope, artifact_hash, result, recorded_at, input_hashes_json FROM verdict
      WHERE workflow_id = ? ORDER BY seq`).all(id) as { id: string; check_id: string; scope: string; artifact_hash: string;
        result: string; recorded_at: string; input_hashes_json: string | null }[];
    const latest = new Map(verdicts.map(item => [item.check_id, item]));
    const acceptance = new Map((db.prepare(`SELECT verdict_id, recorded_at FROM warning_acceptance
      WHERE workflow_id = ? ORDER BY seq`).all(id) as { verdict_id: string; recorded_at: string }[])
      .map(item => [item.verdict_id, item.recorded_at]));
    for (const stage of snapshot.definition.stages) {
      for (const checkId of stage.requires) {
        const check = snapshot.definition.checks.find(item => item.id === checkId);
        // A deprecated check is skipped by the aggregate and never observed, so its reading cannot block a stage and
        // the Runtime refuses to accept it (runtime.ts acceptWarning). Listing it here would render "待接受" for a
        // reading nothing can act on; a verdict can still exist for it when a successor Workflow inherits evidence
        // from a source whose definition still measured the check (state/aggregate-input.ts).
        if (!check || check.severity !== 'warning' || check.maturity === 'deprecated') continue;
        const verdict = latest.get(checkId);
        if (!verdict) continue;
        const bound = check.when && !planValue(input.plan, check.when) ? input.artifactHashes.plan : input.artifactHashes[check.on];
        const current = evidenceFresh(verdict.artifact_hash, bound,
          verdict.input_hashes_json ? JSON.parse(verdict.input_hashes_json) : undefined,
          evidenceInputHashes(snapshot.definition, { checkId }, input.artifactHashes)) && verdict.scope === check.scope;
        const accepted = acceptance.has(verdict.id);
        rows.push({ workflowId: id, project: row.path, projectName: basename(row.path), stage: stage.id,
          checkId, scope: check.scope, on: check.on, rule: check.rule, observe: check.observe,
          verdictId: verdict.id, result: verdict.result, recordedAt: verdict.recorded_at,
          artifactHash: verdict.artifact_hash, boundHash: bound ?? null, current,
          applies: !check.when || planValue(input.plan, check.when),
          accepted, acceptedAt: acceptance.get(verdict.id) ?? null,
          // Each row answers for its own reading. The stage's reasons only say which warnings the stage waits on: a
          // second, valid `not_applicable` reading in the same stage is not one of them, and reading "the stage is
          // blocked by a warning" as "every warning row blocks" marked that reading as blocking too — and offered an
          // acceptance the Runtime refuses. This is the aggregate's own judgement, per check.
          blocks: warningUnaccepted(snapshot.definition, check, input) });
      }
    }
  }
  return rows;
}

/** One sentence for a person: what, if anything, they need to do now. */
export function nextStep(view: Pick<WorkflowView, 'status' | 'stages' | 'gates' | 'plan'>): string {
  if (view.status === 'cancelled') return '已取消';
  if (view.status === 'client_verified') return '已完成客户端验收';
  if (view.plan.error) return `方案文件无法读取：${view.plan.error}`;
  const pending = view.gates.find(gate => gate.status === 'pending' || gate.status === 'stale');
  if (pending?.selection === 'face-candidate') return '请选择希望继续制作的脸型候选，先查看当前版本的正面和侧面预览';
  if (pending?.review === 'face-output') return '脸型工程检查已通过，请查看实际效果，接受或提出调整要求';
  if (pending) return `需要你决定：${pending.gate.slice(pending.gate.indexOf(':') + 1)}（${pending.kind === 'do' ? '需你亲手完成' : '批准或驳回'}，绑定 ${pending.binds}）`;
  // A stage blocked only because a warning reading was never accepted is not a failure to repair: it is a decision the
  // person owns, and it is told before the generic "waiting for a person" line so the reading itself is not buried.
  const warningOnly = view.stages.find(stage => stage.status === 'blocked' && stage.codes?.length &&
    stage.codes.every(code => code === 'warning_unaccepted'));
  if (warningOnly) return `阶段 ${warningOnly.id} 有需要你确认的提醒：在阶段详情里查看当前读数并逐条接受`;
  const waiting = view.stages.find(stage => stage.task?.status === 'WAITING_HUMAN' && stage.status !== 'waiting');
  if (waiting) return `阶段 ${waiting.id} 等待人工处理：${waiting.reasons[0] ?? '查看任务详情'}`;
  const recovery = view.stages.find(stage => stage.task?.status === 'RECOVERY_REQUIRED');
  if (recovery) return `阶段 ${recovery.id} 需要核对上次执行（avh task recover）`;
  // A stage still waiting on its predecessors will run again once they pass; its old Task's result is not the person's job.
  const blocked = view.stages.find(stage => (stage.task?.status === 'BLOCKED' || stage.task?.status === 'FAILED') && stage.status !== 'waiting');
  if (blocked) return `阶段 ${blocked.id} ${blocked.task!.status === 'FAILED' ? '执行失败' : '检查未通过'}：${blocked.reasons[0] ?? '查看检查结果'}；处理后重做`;
  if (view.status === 'upload_ready') return '已到 UPLOAD_READY：请上传并按清单自测';
  const running = view.stages.find(stage => ['READY', 'RUNNING', 'VERIFYING', 'PENDING'].includes(stage.task?.status ?? ''));
  if (running) return `阶段 ${running.id} 进行中（${running.task!.status}）`;
  const open = view.stages.find(stage => stage.status === 'open');
  if (open) return `阶段 ${open.id} 待开始；后台服务会自动推进`;
  return '等待后台服务推进';
}

export function listWorkflows(db: DatabaseSync): WorkflowRow[] {
  const ids = db.prepare(`SELECT w.id FROM workflow w JOIN workflow_definition d ON d.workflow_id = w.id ORDER BY w.rowid DESC`)
    .all() as { id: string }[];
  return ids.map(({ id }) => {
    const view = describeWorkflow(db, id);
    const current = view.stages.find(stage => stage.status !== 'passed' && stage.status !== 'not_applicable');
    return { id, project: view.project, projectName: view.projectName, profile: view.profile, status: view.status,
      createdAt: view.createdAt, stagesPassed: view.stages.filter(stage => stage.status === 'passed' || stage.status === 'not_applicable').length,
      stagesTotal: view.stages.length, ...(current ? { current: current.id } : {}), next: view.next };
  });
}
