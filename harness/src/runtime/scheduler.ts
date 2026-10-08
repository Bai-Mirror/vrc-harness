import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ProcessDefinition, StageResult, Verdict } from '../process/types.ts';
import { activeInvalidations } from '../process/aggregate.ts';
import { aggregateWorkflow, buildAggregateInput } from '../state/aggregate-input.ts';
import { recordEventOnce, withStateEvent } from '../state/tx.ts';
import { SchedulerLeaseLostError } from '../state/scheduler-lease.ts';
import type { Executor, Fingerprinter, RunResult, RunSpec, Verifier, ErrorClass } from './interfaces.ts';
import { reconcile, refreshFingerprints, type IdleFingerprintCadence, type ReconcileHooks } from './reconcile.ts';
import { DEFAULT_REDO_NOTE, transitionTask, type TaskStatus } from './transitions.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { projectSafePoint } from '../archive/projection.ts';
import { observeFinishedRun } from '../sharing/producers.ts';
import { freezeRunInput, readRunInputSnapshot, resolveWorkflowInput, type RunInputSnapshot } from '../workflow/inputs.ts';
import { evidenceInputHashes } from '../process/evidence.ts';
import { renderedImageDigest } from '../stage-photos.ts';
import { dirname, join } from 'node:path';

export interface SchedulerConfig {
  /** Number of additional Runs after the first attempt. */
  maxRetries: number;
  /** Per-stage override of maxRetries for Tasks this scheduler creates. */
  stageRetries?: Record<string, number>;
  /** Per-stage bounded repair Runs after independent verification fails. */
  stageCheckRetries?: Record<string, number>;
  slotCapacity: Record<string, number>;
  stageSlots?: Record<string, string[]>;
  providerRegistry?: ProviderRegistry;
  /** Resolve tool selection in the same transaction as Run inputs, even when an executor is substituted. */
  beforeDispatch?: (stageId: string) => Promise<void>;
  dispatchBlocked?: () => boolean;
  stageDispatchAllowed?: (stageId: string) => boolean;
  freezeInputExtras?: (spec: RunSpec) => Pick<RunInputSnapshot, 'stageToolSelection' | 'faceSelection'>;
  /** Renew the scheduler lease between long synchronous steps; supplied by the serving cycle that holds it. */
  heartbeat?: () => void;
  /** Fingerprint cadence for Workflows with no work in flight; see ReconcileHooks. */
  idleFingerprintRefreshMs?: number;
  /** Last full scan per Workflow; owned by the serving loop that sets the window. */
  idleFingerprintCadence?: IdleFingerprintCadence;
}
/**
 * What the serving cycle contributes to every Scheduler it builds for one round: its lease heartbeat and the idle
 * fingerprint cadence. Both belong to the cycle, not to the Workflow, so they are threaded rather than configured
 * per Workflow.
 */
export type CycleRuntime = Pick<SchedulerConfig, 'heartbeat' | 'idleFingerprintRefreshMs' | 'idleFingerprintCadence'>;
interface TaskRow { id: string; stage_id: string; status: TaskStatus; retry_policy_json: string }
interface RunRow { id: string; task_id: string; attempt: number; status: string; process_ref: string | null }
/** The RecolorStage state list: non-fixed entries are rendered one at a time; all-fixed plans use original. */
export function previewStatesForPlan(plan: Record<string, any> | undefined): string[] {
  const states = Array.isArray(plan?.outfits)
    ? plan.outfits.filter((item: any) => item?.activation !== 'fixed').map((item: any) => String(item?.id ?? '')).filter(Boolean)
    : Array.isArray(plan?.avatar_config?.groups) ? plan.avatar_config.groups
      .filter((group: any) => group?.kind !== 'material' && group?.activation !== 'fixed')
      .flatMap((group: any) => Array.isArray(group.members) ? group.members.map((item: any) => String(item?.id ?? '')).filter(Boolean) : []) : [];
  return states.length ? states : ['original'];
}
/** A residue Run belongs to a finished Task but still counts as pending or running. */
export type OrphanOutcome =
  | { runId: string; outcome: 'closed'; taskStatus: string; unit: string; exitStatus?: number; releasedLocks: number }
  | { runId: string; outcome: 'unconfirmed'; taskStatus: string; reason: string }
  | { runId: string; outcome: 'none' };
/** `residue` is present only when cancel targeted a finished Task; empty means nothing was left over. */
export interface CancelResult { confirmed: boolean; releasedLocks?: number; residue?: OrphanOutcome[] }
export const FINISHED_TASK_STATUSES: readonly TaskStatus[] = ['CANCELLED', 'FAILED', 'PASSED'];
const FINISHED_SQL = FINISHED_TASK_STATUSES.map(status => `'${status}'`).join(', ');

export class Scheduler implements ReconcileHooks {
  readonly db: DatabaseSync;
  readonly workflowId: string;
  readonly definition: ProcessDefinition;
  readonly executor: Executor;
  readonly verifier: Verifier;
  readonly fingerprinter: Fingerprinter;
  readonly config: SchedulerConfig;
  readonly heartbeat?: () => void;
  readonly idleFingerprintRefreshMs?: number;
  readonly idleFingerprintCadence?: IdleFingerprintCadence;
  constructor(
    db: DatabaseSync, workflowId: string, definition: ProcessDefinition,
    executor: Executor, verifier: Verifier, fingerprinter: Fingerprinter,
    config: SchedulerConfig,
  ) {
    this.db = db; this.workflowId = workflowId; this.definition = definition;
    this.executor = executor; this.verifier = verifier; this.fingerprinter = fingerprinter; this.config = config;
    this.heartbeat = config.heartbeat; this.idleFingerprintRefreshMs = config.idleFingerprintRefreshMs;
    this.idleFingerprintCadence = config.idleFingerprintCadence;
    if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) throw new Error('Invalid maxRetries');
    for (const capacity of Object.values(config.slotCapacity))
      if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid slot capacity');
  }

  get artifactKinds(): string[] { return this.definition.artifacts; }

  /**
   * Observe the artifacts on the current state, ignoring the idle cadence. A final status transition must not rest
   * on a fingerprint the idle window may have left from before the person's last edit; the serving cycle calls this
   * for that one transition instead of rescanning every settled Workflow every round.
   */
  async refreshArtifacts(): Promise<void> { await refreshFingerprints(this); }

  private requiresInputSnapshot(stageId: string): boolean {
    return this.definition.artifacts.includes('face_input') || ['face', 'face_design', 'manual_handoff'].includes(stageId);
  }

  private projectId(): string {
    const row = this.db.prepare('SELECT project_id FROM workflow WHERE id = ?')
      .get(this.workflowId) as { project_id: string } | undefined;
    if (!row) throw new Error(`Unknown workflow ${this.workflowId}`);
    return row.project_id;
  }
  private harnessHome(): string {
    const location = String((this.db.prepare('PRAGMA database_list').all() as { name: string; file?: string }[])
      .find(item => item.name === 'main')?.file ?? '');
    return dirname(dirname(location));
  }
  private task(id: string): TaskRow {
    const row = this.db.prepare('SELECT id, stage_id, status, retry_policy_json FROM task WHERE id = ?')
      .get(id) as TaskRow | undefined;
    if (!row) throw new Error(`Unknown task ${id}`);
    return row;
  }
  private run(id: string): RunRow {
    const row = this.db.prepare('SELECT id, task_id, attempt, status, process_ref FROM run WHERE id = ?')
      .get(id) as RunRow | undefined;
    if (!row) throw new Error(`Unknown run ${id}`);
    return row;
  }
  spec(runId: string): RunSpec {
    const run = this.run(runId);
    const task = this.task(run.task_id);
    const stage = this.definition.stages.find(item => item.id === task.stage_id)!;
    const inputSnapshot = readRunInputSnapshot(this.db, runId);
    return { runId, taskId: task.id, workflowId: this.workflowId, projectId: this.projectId(),
      stageId: stage.id, attempt: run.attempt, idempotencyKey: runId, expectedOutputs: stage.produces,
      ...(inputSnapshot ? { inputSnapshot } : {}) };
  }

  /** One round: reconcile, derive stages, create Tasks, dispatch, observe, and verify. */
  async tick(mayDispatch: () => boolean = () => true): Promise<void> {
    this.config.providerRegistry?.freeze(this.db, this.workflowId);
    const refreshed = await reconcile(this, mayDispatch);
    await this.resumeVerifyingTasks();
    if (!mayDispatch() || this.config.dispatchBlocked?.()) return;
    const humanObserved = await this.resumeHumanTasks();
    let states = aggregateWorkflow(this.db, this.workflowId, this.definition).stages;
    // An `open` stage is one this round will create and dispatch a Task for. The idle cadence may still hold a
    // fingerprint from before the person's last edit; acting on it would start downstream work and only notice the
    // change afterwards. Observe once more, so the decision this round makes rests on the artifacts as they are now.
    // A human Task that resumed above already observed this round; that observation counts for both boundaries.
    if (!refreshed && !humanObserved && this.definition.stages.some(stage => states[stage.id]!.status === 'open')) {
      await refreshFingerprints(this);
      states = aggregateWorkflow(this.db, this.workflowId, this.definition).stages;
    }
    const temporary = Boolean(this.db.prepare("SELECT 1 FROM workflow WHERE id = ? AND process_hash = 'avh-task/0.1'")
      .get(this.workflowId));
    const hashes = temporary ? buildAggregateInput(this.db, this.workflowId).artifactHashes : {};
    for (const stage of this.definition.stages) {
      if (!mayDispatch()) break;
      if (this.config.stageDispatchAllowed?.(stage.id) === false) continue;
      const state = states[stage.id]!;
      const latest = this.db.prepare(`SELECT id, status FROM task WHERE workflow_id = ? AND stage_id = ?
        ORDER BY rowid DESC LIMIT 1`).get(this.workflowId, stage.id) as { id: string; status: TaskStatus } | undefined;
      // A finished Task (passed, failed or cancelled) is redone only on a request made after it finished; one made while
      // it was held was answered by the Run that followed.
      const request = latest && ['PASSED', 'FAILED', 'CANCELLED'].includes(latest.status) ? this.db.prepare(`SELECT reason FROM event
        WHERE workflow_id = ? AND entity_type = 'task' AND entity_id = ? AND actor = 'human' AND action = 'requested_redo'
          AND seq > (SELECT MAX(seq) FROM event WHERE entity_type = 'task' AND entity_id = ?
            AND (action LIKE '%->PASSED' OR action LIKE '%->FAILED' OR action LIKE '%->CANCELLED'))
        ORDER BY seq DESC LIMIT 1`).get(this.workflowId, latest.id, latest.id) as { reason: string } | undefined
        : undefined;
      const redo = Boolean(request);
      if (temporary && latest?.status === 'PASSED' && !redo) {
        const completion = this.db.prepare(`SELECT artifact_hashes_json FROM stage_completion
          WHERE workflow_id = ? AND stage_id = ? ORDER BY seq DESC LIMIT 1`)
          .get(this.workflowId, stage.id) as { artifact_hashes_json: string } | undefined;
        if (completion) {
          const recorded = JSON.parse(completion.artifact_hashes_json) as Record<string, string>;
          const changed = activeInvalidations(this.definition, stage, buildAggregateInput(this.db, this.workflowId).plan).filter(kind => !hashes[kind] || recorded[kind] !== hashes[kind]);
          if (changed.length) {
            const reason = `产物已变化: ${changed.join(', ')}`;
            const seen = this.db.prepare(`SELECT 1 FROM event WHERE workflow_id = ? AND entity_type = 'task'
              AND entity_id = ? AND action = 'evidence_invalidated' AND reason = ? LIMIT 1`)
              .get(this.workflowId, latest.id, reason);
            if (!seen) withStateEvent(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'task',
              entityId: latest.id, action: 'evidence_invalidated', reason, payload: { artifacts: changed } }, () => {});
          }
        }
        continue;
      }
      if (!redo && (state.status === 'waiting' || state.status === 'passed' || state.status === 'not_applicable')) continue;
      // A formal stage held for a person (blocked checks, an undecided gate) whose inputs changed since it ran is
      // answered by running again on the new inputs: the old result is about artifacts that no longer exist.
      let superseded = Boolean(latest && this.db.prepare("SELECT 1 FROM event WHERE entity_type='task' AND entity_id=? AND action='input_superseded'").get(latest.id));
      if (!temporary && latest && (latest.status === 'BLOCKED' || latest.status === 'WAITING_HUMAN')) {
        const stale = this.staleInputs(latest.id, activeInvalidations(this.definition, stage, buildAggregateInput(this.db, this.workflowId).plan));
        if (stale.length) {
          transitionTask(this.db, latest.id, 'CANCELLED', 'cancel_confirmed',
            `上游产物已变化（${stale.join(', ')}），旧结果作废，按新输入重做`);
          superseded = true;
        }
      }
      const active = this.db.prepare(`SELECT id FROM task WHERE workflow_id = ? AND stage_id = ?
        AND status NOT IN ('PASSED', 'FAILED', 'CANCELLED') LIMIT 1`)
        .get(this.workflowId, stage.id);
      if (active) continue;
      // Failed/cancelled work needs explicit authorization (a redo request); temporary PASSED work was handled above.
      if (latest && latest.status !== 'PASSED' && !superseded && !redo) continue;
      const id = randomUUID();
      withStateEvent(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'task',
        entityId: id, action: 'created', reason: `stage ${stage.id} requires work` }, () => {
        this.db.prepare(`INSERT INTO task (id, workflow_id, stage_id, goal, capability, expected_outputs_json,
          retry_policy_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`)
          .run(id, this.workflowId, stage.id, `Complete stage ${stage.id}${redo && !temporary && request!.reason !== DEFAULT_REDO_NOTE
            ? `；修改意见：${request!.reason}` : ''}`, stage.id,
            JSON.stringify(stage.produces), JSON.stringify({ maxRetries: this.config.stageRetries?.[stage.id] ?? this.config.maxRetries,
              maxCheckRetries: this.config.stageCheckRetries?.[stage.id] ?? 0 }));
      });
      transitionTask(this.db, id, 'READY', 'ready', 'stage dependencies satisfied');
    }
    const ready = this.db.prepare(`SELECT id FROM task WHERE workflow_id = ? AND status = 'READY' ORDER BY rowid`)
      .all(this.workflowId) as { id: string }[];
    for (const row of ready) {
      if (!mayDispatch()) break;
      const latest = this.db.prepare('SELECT result_json FROM run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1')
        .get(row.id) as { result_json: string | null } | undefined;
      const result = latest?.result_json ? JSON.parse(latest.result_json) as RunResult : undefined;
      if (result?.errorClass === 'rate_limit' && result.retryAfter && Date.parse(result.retryAfter) > Date.now()) {
        recordEventOnce(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'task', entityId: row.id,
          action: 'route_waiting', reason: `额度用完，${new Date(result.retryAfter).toLocaleString()} 后继续` });
        continue;
      }
      await this.dispatch(row.id);
    }
    // The second pass observes what dispatch started; the artifacts were scanned at the top of this same round, and
    // nothing since then has written them (dispatch starts a unit, it does not run it here). A scan is a Git listing
    // plus a stat-and-hash of every member of every artifact kind, so repeating it doubled the largest synchronous
    // cost of a round. `finish` still refreshes fingerprints for the Run it collects.
    await reconcile(this, mayDispatch, { fingerprints: false });
    // The project archive is for formal product Workflows. Write only at a safe point: changing it while a Run's
    // boundary scanner is active would make a Runtime-owned status refresh look like executor workspace drift. The
    // safe point checks the whole project (another Workflow's Run may be working in it) and walks the project tree
    // again only after Tasks changed it.
    const activeRun = this.db.prepare(`SELECT 1 FROM task WHERE workflow_id=? AND status IN ('RUNNING','VERIFYING') LIMIT 1`)
      .get(this.workflowId);
    if (!temporary && !activeRun) try {
      // The archive write is long and goes to the state store: the heartbeat renews the lease at its write boundary
      // and throws once another cycle owns the scheduler, so a lost lease aborts the round instead of writing here.
      projectSafePoint(this.db, this.projectId(), { tree: 'auto',
        ...(this.heartbeat ? { heartbeat: this.heartbeat } : {}) });
    } catch (error) {
      if (error instanceof SchedulerLeaseLostError) throw error;
      recordEventOnce(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'project_state',
        entityId: this.projectId(), action: 'projection_failed', reason: (error as Error).message });
    }
  }

  /** The kinds among `kinds` whose current hash differs from the one recorded when the Task's latest Run started. */
  private staleInputs(taskId: string, kinds: string[]): string[] {
    const run = this.db.prepare('SELECT id FROM run WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(taskId);
    const frozen = run && readRunInputSnapshot(this.db, String(run.id));
    const row = this.db.prepare('SELECT inputs_json FROM task WHERE id = ?').get(taskId) as { inputs_json: string | null } | undefined;
    const baseline = frozen?.baseline ?? (row?.inputs_json ? (JSON.parse(row.inputs_json) as { baseline?: Record<string, string> }).baseline : undefined);
    if (!baseline || !kinds.length) return [];
    const current = buildAggregateInput(this.db, this.workflowId).artifactHashes;
    return kinds.filter(kind => baseline[kind] !== current[kind]);
  }

  private resources(stageId: string): string[] {
    return [`project:${this.projectId()}`, ...(this.config.stageSlots?.[stageId] ?? []).map(name => `slot:${name}`)];
  }
  private availableResources(stageId: string, taskId?: string): string[] | undefined {
    const result: string[] = [];
    for (const resource of this.resources(stageId)) {
      if (this.executor.canDispatch && !this.executor.canDispatch(resource, taskId)) return undefined;
      if (resource.startsWith('project:')) {
        if (this.db.prepare('SELECT 1 FROM lock WHERE resource = ?').get(resource)) return undefined;
        result.push(resource);
        continue;
      }
      const name = resource.slice('slot:'.length);
      const capacity = this.config.slotCapacity[name];
      if (!capacity) throw new Error(`Unconfigured slot ${name}`);
      const index = Array.from({ length: capacity }, (_, i) => `${resource}:${i}`)
        .find(key => !this.db.prepare('SELECT 1 FROM lock WHERE resource = ?').get(key));
      if (!index) return undefined;
      result.push(index);
    }
    return result;
  }
  private async dispatch(taskId: string): Promise<void> {
    const task = this.task(taskId);
    if (this.config.dispatchBlocked?.() || this.config.stageDispatchAllowed?.(task.stage_id) === false) return;
    // READY may have been persisted before an upstream input changed.
    const state = aggregateWorkflow(this.db, this.workflowId, this.definition).stages[task.stage_id]!;
    if (state.status === 'waiting' || state.status === 'not_applicable') return;
    if (this.config.beforeDispatch) await this.config.beforeDispatch(task.stage_id);
    if (this.config.dispatchBlocked?.() || this.config.stageDispatchAllowed?.(task.stage_id) === false) return;
    const resources = this.availableResources(task.stage_id, taskId);
    if (!resources) return;
    const attempt = (this.db.prepare('SELECT COALESCE(MAX(attempt), 0) AS n FROM run WHERE task_id = ?')
      .get(taskId) as { n: number }).n + 1;
    const runId = randomUUID();
    // `beforeDispatch` may have done long work (freezing a production baseline). Dispatching is a state-store write;
    // a lease taken over meanwhile must abort the round here rather than start a Run under the new owner.
    this.heartbeat?.();
    transitionTask(this.db, taskId, 'RUNNING', 'run_intended', `Run attempt ${attempt} intended`, () => {
      const baseline = buildAggregateInput(this.db, this.workflowId).artifactHashes;
      this.db.prepare('UPDATE task SET inputs_json = ? WHERE id = ?').run(JSON.stringify({ baseline }), taskId);
      this.db.prepare(`INSERT INTO run (id, task_id, attempt, status) VALUES (?, ?, ?, 'pending')`)
        .run(runId, taskId, attempt);
      this.db.prepare('INSERT INTO dispatch_outbox (id, run_id) VALUES (?, ?)').run(randomUUID(), runId);
      const extras = this.config.freezeInputExtras?.(this.spec(runId));
      freezeRunInput(this.db, this.workflowId, runId, baseline, extras);
      for (const resource of resources) {
        this.db.prepare(`INSERT INTO lock_epoch (resource, fencing) VALUES (?, 1)
          ON CONFLICT(resource) DO UPDATE SET fencing = fencing + 1`).run(resource);
        const epoch = this.db.prepare('SELECT fencing FROM lock_epoch WHERE resource = ?')
          .get(resource) as { fencing: number };
        this.db.prepare(`INSERT INTO lock (resource, run_id, fencing, lease_until)
          VALUES (?, ?, ?, '9999-12-31T23:59:59Z')`).run(resource, runId, epoch.fencing);
      }
    });
    await this.launch(runId);
  }

  async launch(runId: string): Promise<void> {
    const outbox = this.db.prepare('SELECT status FROM dispatch_outbox WHERE run_id = ?')
      .get(runId) as { status: string };
    if (outbox.status !== 'intended') return;
    try {
      if (this.requiresInputSnapshot(this.task(this.run(runId).task_id).stage_id) && !readRunInputSnapshot(this.db, runId))
        throw new Error('历史 Run 缺少冻结输入，不能按当前选择重放。');
      const handle = await this.executor.start(this.spec(runId));
      if (!handle.ref) throw new Error('Executor returned empty handle');
      // Starting the unit is the long step. Check ownership before its handle is persisted: a lost lease must
      // propagate out of this catch (below) instead of being recorded as this Run's failure or a recovery demand.
      this.heartbeat?.();
      withStateEvent(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'run',
        entityId: runId, action: 'launched', reason: 'executor start returned handle' }, () => {
        this.db.prepare("UPDATE dispatch_outbox SET status = 'launched', launched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE run_id = ? AND status = 'intended'").run(runId);
        this.db.prepare("UPDATE run SET process_ref = ?, status = 'running' WHERE id = ?").run(handle.ref, runId);
      });
      withStateEvent(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'run',
        entityId: runId, action: 'acked', reason: 'executor handle persisted' }, () => {
        this.db.prepare("UPDATE dispatch_outbox SET status = 'acked', acked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE run_id = ? AND status = 'launched'").run(runId);
      });
    } catch (error) {
      if (error instanceof SchedulerLeaseLostError) throw error;
      const typed = error as Error & { errorClass?: ErrorClass; noSideEffects?: boolean };
      const retryable = typed.errorClass === 'rate_limit' || (typed.errorClass === 'timeout' && typed.noSideEffects === true);
      if (retryable || typed.noSideEffects === true) {
        this.completeFailure(runId, { exitStatus: 1, errorClass: typed.errorClass,
          noSideEffects: typed.noSideEffects, errorMessage: String(typed.message ?? error), outputs: {} });
      } else transitionTask(this.db, this.run(runId).task_id, 'RECOVERY_REQUIRED', 'start_uncertain',
        `executor start has no confirmed outcome: ${typed.errorClass ?? 'unknown'}: ${String(typed.message ?? '').slice(0, 300)}`);
    }
  }

  unknown(runId: string, detail?: string): void {
    const run = this.run(runId);
    if (this.task(run.task_id).status !== 'RUNNING') return;
    transitionTask(this.db, run.task_id, 'RECOVERY_REQUIRED', 'unknown_run',
      `executor state unknown; preserve locks and do not redispatch${detail ? `: ${detail}` : ''}`);
  }

  private release(runId: string): void {
    this.db.prepare('DELETE FROM lock WHERE run_id = ?').run(runId);
  }
  private completeFailure(runId: string, result: RunResult, changedKinds: string[] = [], anyChange = false): void {
    const run = this.run(runId);
    if (result.errorClass === 'rate_limit' && (!result.retryAfter || !Number.isFinite(Date.parse(result.retryAfter))))
      result.retryAfter = new Date(Date.now() + 15 * 60_000).toISOString();
    const retryable = result.retryable === true || result.errorClass === 'rate_limit' ||
      (result.errorClass === 'tool_failure' && result.noSideEffects === true) ||
      (result.errorClass === 'timeout' && result.noSideEffects === true);
    const maxRetries = (JSON.parse(this.task(run.task_id).retry_policy_json) as { maxRetries: number }).maxRetries;
    const outside = result.outOfBoundsPaths ?? [];
    const charged = (this.db.prepare('SELECT result_json FROM run WHERE task_id = ? AND attempt < ? ORDER BY attempt')
      .all(run.task_id, run.attempt) as { result_json: string | null }[])
      .filter(item => !item.result_json || (JSON.parse(item.result_json) as RunResult).errorClass !== 'rate_limit').length;
    const retry = retryable && (result.errorClass === 'rate_limit' || result.retryable === true || !anyChange) && outside.length === 0 &&
      (result.errorClass === 'rate_limit' || charged < maxRetries);
    const human = result.errorClass === 'auth' || result.errorClass === 'permission_denied';
    transitionTask(this.db, run.task_id, retry ? 'READY' : human ? 'WAITING_HUMAN' : 'FAILED',
      retry ? 'retry_authorized' : human ? 'human_needed' : 'execution_failed',
      retry ? `Retryable ${result.errorClass} on attempt ${run.attempt}` : `Run failed: ${result.errorClass ?? 'nonzero exit'}`,
      () => {
        this.db.prepare("UPDATE run SET status = 'exited', result_json = ? WHERE id = ?")
          .run(JSON.stringify(result), runId);
        this.db.prepare("UPDATE dispatch_outbox SET status = 'closed' WHERE run_id = ? AND status != 'closed'").run(runId);
        const stageId = this.task(run.task_id).stage_id;
        for (const kind of changedKinds) this.db.prepare(`INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact)
          VALUES (?, ?, ?)`).run(this.workflowId, stageId, kind);
        for (const path of outside) this.db.prepare(`INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact)
          VALUES (?, ?, ?)`).run(this.workflowId, stageId, `workspace:${path}`);
        this.release(runId);
      });
    observeFinishedRun(this.db, runId);
  }

  private onlyManagedMetadata(taskId: string, kind: string): boolean {
    const start = this.db.prepare("SELECT seq FROM event WHERE entity_type='task' AND entity_id=? AND action LIKE '%->RUNNING' ORDER BY seq DESC LIMIT 1").get(taskId);
    if (!start) return false;
    const changes = this.db.prepare("SELECT payload_json FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='artifact_version' AND entity_id=? AND action='observed' AND seq>? ORDER BY seq")
      .all(this.workflowId, kind, start.seq);
    return changes.length > 0 && changes.every(row => JSON.parse(String(row.payload_json)).managedSideEffect === 'unity-new-metadata');
  }
  async finish(runId: string, result: RunResult): Promise<void> {
    const run = this.run(runId);
    if (this.task(run.task_id).status !== 'RUNNING') return;
    // Carrying the collected result into the state store is a write. A lease taken over while the unit was
    // collected must stop the round here, before the Task is advanced on it.
    this.heartbeat?.();
    // Persist the supervisor's exit fact before any best-effort evidence collection can fail.
    this.db.prepare("UPDATE run SET status = 'exited', result_json = ? WHERE id = ? AND status IN ('running', 'pending')")
      .run(JSON.stringify(result), runId);
    // Capture after the exit fact is durable, and replace any executor-supplied image identity.
    delete result.previewDigests;
    if (result.exitStatus === 0 && !result.errorClass && result.unitySteps?.some(step =>
      step.exitCode === 0 && !step.timedOut && step.status !== 'not_started') &&
      this.db.prepare("SELECT 1 FROM event WHERE actor='runtime' AND entity_type='run' AND entity_id=? AND action='unity_unit_intended'").get(runId)) {
      const directory = this.task(run.task_id).stage_id === 'recolor' ? 'candidates' : this.task(run.task_id).stage_id === 'regression' ? 'photos' : undefined;
      if (directory) {
        let digest: string | undefined;
        try { digest = renderedImageDigest(join(this.harnessHome(), 'runs', runId), directory); }
        catch { digest = undefined; }
        if (digest) result.previewDigests = { [this.task(run.task_id).stage_id]: digest };
        else result = { ...result, errorClass: 'verifier_failure', previewEvidenceError: '渲染完成证据未能完整采集：图片或规格 JSON 缺失或不可读' };
        if (directory === 'candidates') {
          const plan = this.spec(runId).inputSnapshot?.plan as Record<string, any> | undefined;
          result.previewStates = previewStatesForPlan(plan);
        }
      }
    }
    await refreshFingerprints(this);
    const spec = this.spec(runId);
    const beforeRow = this.db.prepare('SELECT inputs_json FROM task WHERE id = ?').get(run.task_id) as { inputs_json: string };
    const baseline = spec.inputSnapshot?.baseline ?? (JSON.parse(beforeRow.inputs_json) as { baseline: Record<string, string> }).baseline;
    const current = buildAggregateInput(this.db, this.workflowId).artifactHashes;
    const stage = this.definition.stages.find(item => item.id === spec.stageId)!;
    // A plan producer's output is new evidence, not the approved input plan supplied at dispatch.
    const outputPlan = stage.produces.includes('plan')
      ? spec.inputSnapshot?.workflowInputRevisionId
        ? resolveWorkflowInput(this.db, this.workflowId, spec.inputSnapshot.workflowInputRevisionId).plan
        : JSON.parse(String(this.db.prepare('SELECT plan_json FROM workflow WHERE id=?').get(this.workflowId)!.plan_json))
      : undefined;
    result = { ...result, runtimeObservedPlan: outputPlan };
    const changedKinds = this.artifactKinds.filter(kind => kind !== 'face_input' && baseline[kind] !== current[kind] && !stage.produces.includes(kind) &&
      !this.onlyManagedMetadata(run.task_id, kind));
    if (result.exitStatus !== 0 || result.errorClass) {
      const anyChange = this.artifactKinds.some(kind => kind !== 'face_input' && baseline[kind] !== current[kind]);
      this.completeFailure(runId, result, changedKinds, anyChange);
      return;
    }
    transitionTask(this.db, run.task_id, 'VERIFYING', 'run_exited', `Run ${runId} exited`, () => {
      this.db.prepare("UPDATE run SET status = 'exited', result_json = ? WHERE id = ?")
        .run(JSON.stringify(result), runId);
      for (const kind of changedKinds) {
        this.db.prepare(`INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact)
          VALUES (?, ?, ?)`).run(this.workflowId, stage.id, kind);
      }
      for (const path of result.outOfBoundsPaths ?? []) this.db.prepare(`INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact)
        VALUES (?, ?, ?)`).run(this.workflowId, stage.id, `workspace:${path}`);
      // Locks stay held until the Task leaves VERIFYING (transitionTask releases them).
    });
    observeFinishedRun(this.db, runId);
    await this.verifyRun(runId, result);
  }

  private async verifyRun(runId: string, result: RunResult): Promise<void> {
    const run = this.run(runId);
    const spec = this.spec(runId);
    const current = buildAggregateInput(this.db, this.workflowId).artifactHashes;
    if (this.requiresInputSnapshot(spec.stageId) && !spec.inputSnapshot) {
      this.failVerification(run.task_id, '历史 Run 缺少冻结输入，保留结果并要求受管续接。'); return;
    }
    const inputHashes = spec.inputSnapshot?.baseline ?? current;
    if (this.definition.stages.find(stage => stage.id === spec.stageId)?.invalidated_by.includes('face_input') && inputHashes.face_input !== current.face_input)
      recordEventOnce(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'run', entityId: runId,
        action: 'input_superseded', reason: 'Verify old Run with frozen input; current-input completion is forbidden' });
    let verdicts: Verdict[];
    const verificationHashes = { ...current, ...(!spec.expectedOutputs.includes('plan') && inputHashes.plan ? { plan: inputHashes.plan } : {}) };
    try { verdicts = await this.verifier.verify(spec, result, verificationHashes); }
    catch (error) {
      if (error instanceof SchedulerLeaseLostError) throw error;
      if (this.task(run.task_id).status === 'VERIFYING')
        this.failVerification(run.task_id, `Verifier failed: ${String(error)}`);
      return;
    }
    // Independent verification is the long step of this path. Check ownership before its verdicts are recorded: a
    // lost lease must stop the round here, not be turned into a failed check or a settled Task.
    this.heartbeat?.();
    if (this.task(run.task_id).status !== 'VERIFYING') return;
    const seen = new Set<string>();
    for (const reported of verdicts) {
      // A malformed verifier result must end verification: a Task stuck in VERIFYING would hold the project lock.
      if (seen.has(reported.checkId)) { this.failVerification(run.task_id, `Duplicate verifier check ${reported.checkId}`); return; }
      seen.add(reported.checkId);
      const verdict = { ...reported, id: `${runId}:${reported.checkId}`,
        inputHashes: evidenceInputHashes(this.definition, { checkId: reported.checkId }, inputHashes) };
      const existing = this.db.prepare('SELECT check_id, scope, artifact_hash, result, basis, input_hashes_json FROM verdict WHERE id = ?')
        .get(verdict.id) as { check_id: string; scope: string; artifact_hash: string; result: string; basis: string | null; input_hashes_json: string | null } | undefined;
      if (existing) {
        if (existing.check_id !== verdict.checkId || existing.scope !== verdict.scope ||
          existing.artifact_hash !== verdict.artifactHash || existing.result !== verdict.result ||
          existing.basis !== (verdict.basis ?? null) ||
          (existing.input_hashes_json !== JSON.stringify(verdict.inputHashes) &&
            !(existing.input_hashes_json === null && Object.keys(verdict.inputHashes).length === 0))) {
          this.failVerification(run.task_id, `Verifier changed Verdict ${verdict.id}`); return;
        }
        continue;
      }
      withStateEvent(this.db, { workflowId: this.workflowId, actor: 'verifier', entityType: 'verdict',
        entityId: verdict.id, action: 'recorded', reason: `verification of Run ${runId}` }, () => {
          this.db.prepare(`INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result, basis, input_hashes_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(verdict.id, this.workflowId, verdict.checkId,
              verdict.scope, verdict.artifactHash, verdict.result, verdict.basis ?? null, JSON.stringify(verdict.inputHashes));
        });
    }
    withStateEvent(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'run',
      entityId: runId, action: 'verified', reason: 'verifier returned evidence' }, () => {
        this.db.prepare('UPDATE run SET result_json = ? WHERE id = ?')
          .run(JSON.stringify({ ...result, verifiedArtifactHashes: current, verdictIds: verdicts.map(item => `${runId}:${item.checkId}`) }), runId);
      });
    this.recordVerifiedArtifacts(spec, verdicts, current);
    this.settle(run.task_id);
  }

  /**
   * Record the outputs an independent check confirmed, so a gate-less Task can complete.
   * Completion requires every produced artifact to have a version, but versions were only written when a
   * Gate decision refreshed one. A Task with expected outputs and no Gate therefore produced evidence,
   * passed its checks, and then blocked on a missing artifact. Record only when every verdict for this Run
   * passed, so completion still means evidence rather than a declaration. The hash must be the same value
   * the verdicts carry, because a verdict whose hash differs from the recorded version reads as stale.
   */
  private recordVerifiedArtifacts(spec: RunSpec, verdicts: Verdict[], hashes: Record<string, string>): void {
    if (!spec.expectedOutputs.length || !verdicts.length) return;
    if (verdicts.some(item => item.result !== 'pass')) return;
    for (const kind of spec.expectedOutputs) {
      const hash = hashes[kind];
      if (!hash) continue;
      if (buildAggregateInput(this.db, this.workflowId).artifactHashes[kind] === hash) continue;
      withStateEvent(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'artifact_version',
        entityId: kind, action: 'observed', reason: '独立检查全部通过，写入产物版本以便阶段完成' },
      () => this.db.prepare('INSERT INTO artifact_version (workflow_id, kind, hash) VALUES (?, ?, ?)')
        .run(this.workflowId, kind, hash));
    }
  }

  private async resumeVerifyingTasks(): Promise<void> {
    const rows = this.db.prepare(`SELECT r.id, r.result_json FROM task t JOIN run r ON r.task_id = t.id
      WHERE t.workflow_id = ? AND t.status = 'VERIFYING' AND r.attempt =
        (SELECT MAX(attempt) FROM run WHERE task_id = t.id) AND r.status = 'exited'`)
      .all(this.workflowId) as { id: string; result_json: string | null }[];
    for (const row of rows) {
      if (!row.result_json) continue;
      const result = JSON.parse(row.result_json) as RunResult & { verdictIds?: string[] };
      if (result.verdictIds) this.settle(this.run(row.id).task_id);
      else await this.verifyRun(row.id, result);
    }
  }

  private failVerification(taskId: string, reason: string): void {
    transitionTask(this.db, taskId, 'FAILED', 'execution_failed', reason);
  }
  /** A failed independent check is repair input for the next bounded Run, not an AI self-report or an immediate human chore. */
  /**
   * Check repairs are charged only after the Run reached independent verification.  A Run attempt also
   * counts rate limits and confirmed no-side-effect execution failures, neither of which supplied repair
   * evidence to the executor.  The verified event is durable alongside the Run and is written immediately
   * before settlement, so it includes the current failed verification without introducing another counter.
   */
  private verifiedCheckAttempts(taskId: string): number {
    return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM run r WHERE r.task_id = ? AND EXISTS (
      SELECT 1 FROM event e WHERE e.workflow_id = ? AND e.entity_type = 'run' AND e.entity_id = r.id
        AND e.actor = 'runtime' AND e.action = 'verified'
    )`).get(taskId, this.workflowId) as { n: number }).n);
  }
  private blockOrRetryChecks(taskId: string, reason: string): void {
    transitionTask(this.db, taskId, 'BLOCKED', 'check_failed', reason);
    const maxCheckRetries = (JSON.parse(this.task(taskId).retry_policy_json) as { maxCheckRetries?: number }).maxCheckRetries ?? 0;
    const attempts = this.verifiedCheckAttempts(taskId);
    if (attempts <= maxCheckRetries)
      transitionTask(this.db, taskId, 'READY', 'retry_authorized',
        `Independent checks requested repair attempt ${attempts + 1}/${maxCheckRetries + 1}: ${reason}`);
  }
  private settle(taskId: string): void {
    const task = this.task(taskId);
    const last = this.db.prepare('SELECT id, result_json FROM run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1')
      .get(taskId) as { id: string; result_json: string | null } | undefined;
    const record = last?.result_json ? JSON.parse(last.result_json) as RunResult & { verdictIds?: string[]; verifiedArtifactHashes?: Record<string,string> } : undefined;
    const current = buildAggregateInput(this.db, this.workflowId).artifactHashes;
    const stage = this.definition.stages.find(item => item.id === task.stage_id)!;
    const frozen = last && readRunInputSnapshot(this.db, last.id);
    if (this.requiresInputSnapshot(task.stage_id) && !frozen) {
      if (task.status === 'VERIFYING') this.failVerification(taskId, '历史 Run 缺少冻结输入，保留结果并要求受管续接。');
      else transitionTask(this.db, taskId, 'CANCELLED', 'cancel_confirmed', '历史 Run 缺少冻结输入，保留结果并要求受管续接。');
      return;
    }
    if (stage.invalidated_by.includes('face_input') && (!frozen || frozen.baseline.face_input !== current.face_input)) {
      // Verification has returned (or was already persisted). No executor is active at this safe point.
      withStateEvent(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'run', entityId: last!.id,
        action: 'verification_cancel_confirmed', reason: 'Independent verification finished for superseded input' }, () => {});
      withStateEvent(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'task', entityId: taskId,
        action: 'input_superseded', reason: 'Run input differs from current formally adopted input' }, () => {
        transitionTask(this.db, taskId, 'CANCELLED', 'cancel_confirmed', '旧输入的执行结果保留；按新输入重做。');
      });
      return;
    }
    // Presence, not truthiness: an artifact whose version was recorded before anything hashed it carries
    // an empty hash, and a Task that produced it has still produced it.
    const hasOutputs = stage.produces.every(kind => current[kind] !== undefined);
    const freshChecks = new Set((this.db.prepare(`SELECT check_id FROM verdict WHERE workflow_id = ?
      AND id IN (SELECT value FROM json_each(?))`).all(this.workflowId,
        JSON.stringify(record?.verdictIds ?? [])) as { check_id: string }[]).map(row => row.check_id));
    const hasVerdict = Boolean(record?.verdictIds?.length) && stage.requires.every(id => freshChecks.has(id));
    const proofFailure = this.db.prepare(`SELECT check_id, result, basis FROM verdict WHERE workflow_id = ?
      AND id IN (SELECT value FROM json_each(?)) AND result = 'error'`).all(this.workflowId,
      JSON.stringify(record?.verdictIds ?? [])) as { check_id: string; result: string; basis: string | null }[];
    const requiredProofFailures = proofFailure.filter(row => stage.requires.includes(row.check_id));
    if (requiredProofFailures.length) {
      transitionTask(this.db, taskId, 'BLOCKED', 'check_failed', requiredProofFailures.length
        ? `Independent verification could not establish evidence: ${requiredProofFailures.map(row => `${row.check_id}: ${row.basis ?? row.result}`).join('; ')}`
        : 'Verifier produced no required Verdict');
      return;
    }
    if (!hasOutputs || !hasVerdict) {
      this.blockOrRetryChecks(taskId, !hasOutputs ? 'Expected artifact missing' : 'Verifier produced no Verdict');
      return;
    }
    let state: StageResult = aggregateWorkflow(this.db, this.workflowId, this.definition).stages[stage.id]!;
    const codes = state.reasonCodes ?? [];
    if (codes.some(code => code === 'out_of_bounds' || code === 'warning_unaccepted')) {
      transitionTask(this.db, taskId, 'WAITING_HUMAN', 'human_needed', state.reasons.join('; '));
      return;
    }
    const blockingCheck = codes.some(code => !['gate_pending', 'completion_missing', 'completion_invalidated'].includes(code));
    if (blockingCheck) {
      this.blockOrRetryChecks(taskId, state.reasons.join('; '));
      return;
    }
    // A passed aggregate has no reasons; an empty list must not park a verified redo.
    if (codes.length > 0 && codes.every(code => code === 'gate_pending')) {
      transitionTask(this.db, taskId, 'WAITING_HUMAN', 'human_needed', state.reasons.join('; '));
      return;
    }
    const completionForRun = last && this.db.prepare('SELECT 1 FROM stage_completion WHERE run_id = ?')
      .get(last.id);
    if (!completionForRun && (state.status === 'passed' ||
      (state.status === 'open' && codes.every(code => code === 'completion_missing' || code === 'completion_invalidated')))) {
      withStateEvent(this.db, { workflowId: this.workflowId, actor: 'runtime', entityType: 'stage_completion',
        entityId: stage.id, action: 'recorded', reason: `Task ${taskId} verified` }, () => {
          const hashes = Object.fromEntries(stage.invalidated_by.map(kind => [kind,
            stage.produces.includes(kind) ? (record?.verifiedArtifactHashes ?? current)[kind] : (frozen?.baseline ?? current)[kind]]));
          const previewDigest = record?.previewDigests?.[stage.id];
          if (previewDigest) hashes.previewDigest = previewDigest;
          this.db.prepare(`INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json, run_id)
            VALUES (?, ?, ?, ?)`).run(this.workflowId, stage.id, JSON.stringify(hashes), last?.id ?? null);
        });
      state = aggregateWorkflow(this.db, this.workflowId, this.definition).stages[stage.id]!;
    }
    if (state.status === 'passed') transitionTask(this.db, taskId, 'PASSED', 'verified', 'stage aggregate passed with current evidence');
    else if (state.reasonCodes?.length && state.reasonCodes.every(code => code === 'gate_pending'))
      transitionTask(this.db, taskId, 'WAITING_HUMAN', 'human_needed', state.reasons.join('; '));
    else this.blockOrRetryChecks(taskId, state.reasons.join('; ') || 'stage did not pass');
  }
  /** Resume parked Tasks whose human decision arrived. Returns whether it observed the artifacts on the way. */
  private async resumeHumanTasks(): Promise<boolean> {
    const rows = this.db.prepare(`SELECT id, stage_id FROM task WHERE workflow_id = ? AND status = 'WAITING_HUMAN'`)
      .all(this.workflowId) as { id: string; stage_id: string }[];
    const needsHuman = (state: { reasonCodes?: string[] }): boolean =>
      Boolean(state.reasonCodes?.some(code => ['out_of_bounds', 'gate_pending', 'warning_unaccepted'].includes(code)));
    // A parked Task is on the idle cadence. The moment its human decision arrives and it is about to resume, the
    // artifacts have to be observed again: the decision binds the hash the person saw, and the idle window may not
    // have noticed an edit made after it. One observation per round is enough, and only when a Task actually resumes.
    let observed = false;
    const observeBeforeResuming = async (): Promise<void> => {
      if (observed) return;
      observed = true;
      await refreshFingerprints(this);
    };
    for (const row of rows) {
      const redo = this.db.prepare(`SELECT 1 FROM event e WHERE e.actor = 'human'
        AND e.entity_type = 'task' AND e.entity_id = ? AND e.action = 'requested_redo'
        AND e.seq > (SELECT MAX(seq) FROM event WHERE entity_type = 'task'
          AND entity_id = ? AND action LIKE '%->WAITING_HUMAN') LIMIT 1`).get(row.id, row.id);
      if (redo) {
        await observeBeforeResuming();
        transitionTask(this.db, row.id, 'READY', 'human_requested_redo', 'human requested a new Run');
        continue;
      }
      const latest = this.db.prepare('SELECT result_json FROM run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1')
        .get(row.id) as { result_json: string | null } | undefined;
      if (latest?.result_json) {
        const result = JSON.parse(latest.result_json) as RunResult;
        if (result.errorClass === 'auth' || result.errorClass === 'permission_denied') continue;
      }
      let state = aggregateWorkflow(this.db, this.workflowId, this.definition).stages[row.stage_id]!;
      if (needsHuman(state)) continue;
      await observeBeforeResuming();
      // Re-derive on the fresh fingerprints: the human decision may have gone stale because the artifact changed.
      state = aggregateWorkflow(this.db, this.workflowId, this.definition).stages[row.stage_id]!;
      if (needsHuman(state)) continue;
      try {
        transitionTask(this.db, row.id, 'VERIFYING', 'human_approved', 'human decision now present');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Guard human_approved')) continue;
        throw error;
      }
      this.settle(row.id);
    }
    return observed;
  }

  /** Cancel only after the active external operation confirms it has stopped. */
  async cancelTask(taskId: string, reason: string, runId?: string): Promise<CancelResult> {
    if (!reason.trim()) throw new Error('Task transition reason is required');
    const task = this.task(taskId);
    const owner = this.db.prepare('SELECT workflow_id FROM task WHERE id = ?')
      .get(taskId) as { workflow_id: string };
    if (owner.workflow_id !== this.workflowId) throw new Error('Task belongs to another workflow');
    if (FINISHED_TASK_STATUSES.includes(task.status)) return this.cancelFinished(taskId, reason, runId);
    const run = this.db.prepare('SELECT id, status, process_ref FROM run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1')
      .get(taskId) as { id: string; status: string; process_ref: string | null } | undefined;
    if (run && (run.status === 'pending' || run.status === 'cancelled') &&
      this.executor.confirmNeverStarted?.(run.id)) {
      let releasedLocks = 0;
      const finish = () => {
        this.db.prepare("UPDATE run SET status = 'cancelled', result_json = ? WHERE id = ?")
          .run(JSON.stringify({ exitStatus: 143, noSideEffects: true, outputs: {}, cancellationNote: reason }), run.id);
        this.db.prepare("UPDATE dispatch_outbox SET status = 'closed' WHERE run_id = ? AND status != 'closed'").run(run.id);
        releasedLocks = Number(this.db.prepare('DELETE FROM lock WHERE run_id = ?').run(run.id).changes);
        this.db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
          VALUES (?, 'human', 'run', ?, 'cancelled_no_side_effects', ?, ?)`).run(
            this.workflowId, run.id, reason, JSON.stringify({ releasedLocks }));
      };
      transitionTask(this.db, taskId, 'CANCELLED', 'cancel_confirmed', reason, finish);
      return { confirmed: true, releasedLocks };
    }
    if (task.status === 'VERIFYING') {
      if (!run || !this.verifier.cancel || await this.verifier.cancel(this.spec(run.id)) !== 'confirmed') return { confirmed: false };
      if (this.task(taskId).status !== 'VERIFYING') return { confirmed: false };
      transitionTask(this.db, taskId, 'CANCELLED', 'cancel_confirmed', reason, () => {
        this.db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason)
          VALUES (?, 'runtime', 'run', ?, 'verification_cancel_confirmed', ?)`)
          .run(this.workflowId, run.id, reason);
      });
      return { confirmed: true };
    }
    if (task.status === 'RUNNING' || task.status === 'RECOVERY_REQUIRED') {
      if (!run) return { confirmed: false };
      if (!run.process_ref || await this.executor.cancel({ ref: run.process_ref }) !== 'confirmed') return { confirmed: false };
      let cancelled: RunResult;
      try { cancelled = await this.executor.collect({ ref: run.process_ref }); }
      catch { return { confirmed: false }; }
      if (this.task(taskId).status !== task.status) return { confirmed: false };
      transitionTask(this.db, taskId, 'CANCELLED', 'cancel_confirmed', reason, () => {
        for (const path of cancelled.outOfBoundsPaths ?? []) this.db.prepare(`INSERT INTO out_of_bounds_change
          (workflow_id, stage_id, artifact) VALUES (?, ?, ?)`).run(this.workflowId, task.stage_id, `workspace:${path}`);
        // Close the Run with the lock: a pending/running Run row keeps holding its Provider slot.
        this.db.prepare(`UPDATE run SET status = 'cancelled', result_json = ? WHERE id = ?
          AND status IN ('pending', 'running')`).run(JSON.stringify({ ...cancelled, cancellationNote: reason }), run.id);
        this.db.prepare("UPDATE dispatch_outbox SET status = 'closed' WHERE run_id = ? AND status != 'closed'").run(run.id);
        this.release(run.id);
      });
      observeFinishedRun(this.db, run.id);
      return { confirmed: true };
    }
    transitionTask(this.db, taskId, 'CANCELLED', 'cancel_confirmed', reason);
    return { confirmed: true };
  }

  /** Clean residue Runs of a finished Task; the Task status itself is not changed. */
  private async cancelFinished(taskId: string, reason: string, runId?: string): Promise<CancelResult> {
    const ids = (this.db.prepare(`SELECT id FROM run WHERE task_id = ? AND status IN ('pending', 'running')
      ${runId ? 'AND id = ?' : ''} ORDER BY attempt`).all(...(runId ? [taskId, runId] : [taskId])) as { id: string }[])
      .map(row => row.id);
    const residue: OrphanOutcome[] = [];
    for (const id of ids) {
      const outcome = await this.closeOrphanRun(id, 'human', reason);
      if (outcome.outcome !== 'none') residue.push(outcome);
    }
    return { confirmed: residue.every(item => item.outcome === 'closed'), residue,
      releasedLocks: residue.reduce((sum, item) => sum + (item.outcome === 'closed' ? item.releasedLocks : 0), 0) };
  }

  /** Close every residue Run in this workflow. */
  async closeOrphanRuns(): Promise<OrphanOutcome[]> {
    const rows = this.db.prepare(`SELECT r.id FROM run r JOIN task t ON t.id = r.task_id
      WHERE t.workflow_id = ? AND r.status IN ('pending', 'running') AND t.status IN (${FINISHED_SQL})
      ORDER BY r.rowid`).all(this.workflowId) as { id: string }[];
    const outcomes: OrphanOutcome[] = [];
    for (const row of rows) outcomes.push(await this.closeOrphanRun(row.id));
    return outcomes;
  }

  /**
   * A residue Run keeps its Provider slot and locks until the executor confirms that its unit is gone,
   * exited, or stopped on request. Closing is conditional on the Run still being active, so concurrent
   * serve processes write at most one close event.
   */
  async closeOrphanRun(runId: string, actor: 'runtime' | 'human' = 'runtime', note = ''): Promise<OrphanOutcome> {
    const row = this.db.prepare(`SELECT r.status, r.process_ref, t.status AS task_status FROM run r
      JOIN task t ON t.id = r.task_id WHERE r.id = ? AND t.workflow_id = ?`).get(runId, this.workflowId) as
      { status: string; process_ref: string | null; task_status: TaskStatus } | undefined;
    if (!row || !['pending', 'running'].includes(row.status) || !FINISHED_TASK_STATUSES.includes(row.task_status))
      return { runId, outcome: 'none' };
    let unit: string | undefined;
    let failure = '';
    if (!row.process_ref) {
      if (row.status === 'pending' && this.executor.confirmNeverStarted?.(runId)) unit = 'never started';
      else failure = 'no process handle; executor cannot confirm the unit never started';
    } else {
      const handle = { ref: row.process_ref };
      let observed: string;
      try { observed = (await this.executor.observe(handle)).state; } catch { observed = 'unknown'; }
      if (observed === 'exited') unit = 'exited';
      else {
        let stop: string;
        try { stop = await this.executor.cancel(handle); } catch { stop = 'not_confirmed'; }
        if (stop === 'confirmed') unit = observed === 'running' ? 'stopped by runtime' : 'confirmed stopped or absent';
        else failure = `unit ${observed}; executor could not confirm it stopped`;
      }
    }
    if (!unit) {
      const reason = `task ${row.task_status}; ${failure}; slot kept`;
      recordEventOnce(this.db, { workflowId: this.workflowId, actor, entityType: 'run', entityId: runId,
        action: 'orphan_run_unconfirmed', reason });
      return { runId, outcome: 'unconfirmed', taskStatus: row.task_status, reason };
    }
    const exitStatus = this.executor.recordedExitStatus?.(runId);
    const reason = `task ${row.task_status}; unit ${unit}${exitStatus === undefined ? '' : `; exitStatus=${exitStatus}`}` +
      (note ? `; ${note}` : '');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const closed = this.db.prepare(`UPDATE run SET status = 'cancelled', result_json = ? WHERE id = ?
        AND status IN ('pending', 'running')
        AND (SELECT status FROM task WHERE id = run.task_id) IN (${FINISHED_SQL})`)
        .run(JSON.stringify({ exitStatus: exitStatus ?? null, outputs: {}, orphanNote: reason,
          ...(unit === 'never started' ? { noSideEffects: true } : {}) }), runId).changes;
      if (!Number(closed)) {
        this.db.exec('ROLLBACK');
        return { runId, outcome: 'none' };
      }
      this.db.prepare("UPDATE dispatch_outbox SET status = 'closed' WHERE run_id = ? AND status != 'closed'").run(runId);
      const releasedLocks = Number(this.db.prepare('DELETE FROM lock WHERE run_id = ?').run(runId).changes);
      this.db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
        VALUES (?, ?, 'run', ?, 'orphan_run_closed', ?, ?)`).run(this.workflowId, actor, runId, reason,
        JSON.stringify({ taskStatus: row.task_status, unit, exitStatus: exitStatus ?? null, releasedLocks }));
      this.db.exec('COMMIT');
      return { runId, outcome: 'closed', taskStatus: row.task_status, unit,
        ...(exitStatus === undefined ? {} : { exitStatus }), releasedLocks };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
