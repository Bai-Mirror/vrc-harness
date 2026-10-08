import type { DatabaseSync } from 'node:sqlite';
import type { Executor, Fingerprinter, RunResult, RunSpec } from './interfaces.ts';
import { withStateEvent } from '../state/tx.ts';
import { resolveWorkflowInput } from '../workflow/inputs.ts';

export interface ReconcileHooks {
  db: DatabaseSync;
  workflowId: string;
  artifactKinds: string[];
  executor: Executor;
  fingerprinter: Fingerprinter;
  spec(runId: string): RunSpec;
  launch(runId: string): Promise<void>;
  finish(runId: string, result: RunResult): Promise<void>;
  /** `detail` says what could not be established, for the person who has to check the Run. */
  unknown(runId: string, detail?: string): void;
  /**
   * Renew the scheduler lease between long synchronous steps. Throws once the cycle no longer owns it, so the
   * caller stops instead of writing results under a lease that was taken over. Optional: the paths that are not a
   * scheduled cycle (a gate decision, an archive safe point) hold no lease and pass nothing.
   */
  heartbeat?: () => void;
  /**
   * Minimum interval between full fingerprint scans of a Workflow with no work in flight. `0`/absent scans every
   * round. A scheduled cycle sets it: one large project's scan takes tens of seconds, and rescanning every settled
   * Workflow every round starves the round. Change detection is delayed by at most this window, never dropped. The
   * window is only honoured together with a cadence to read the last scan time from.
   */
  idleFingerprintRefreshMs?: number;
  /** When each Workflow was last fully fingerprinted. Owned by the serving loop so the cadence spans its rounds. */
  idleFingerprintCadence?: IdleFingerprintCadence;
}

/** Default idle window for the serving loop: settled Workflows are rescanned at most this often. */
export const IDLE_FINGERPRINT_REFRESH_MS = 5 * 60_000;

/**
 * The last full fingerprint scan per Workflow. It spans the rounds of one serving loop and belongs to that loop, so
 * nothing outlives the loop that made the cadence decision.
 */
export interface IdleFingerprintCadence { lastFullRefresh: Map<string, number> }
export function newFingerprintCadence(): IdleFingerprintCadence { return { lastFullRefresh: new Map() }; }

/**
 * A Workflow with work in flight is fingerprinted every round: a Run is about to read or write those artifacts, and a
 * dispatched Task is about to be given them. PENDING/READY count because this round is about to dispatch them.
 * A parked Task (BLOCKED/WAITING_HUMAN) is not in flight: its staleness check runs on the idle cadence instead, so an
 * upstream change reaches it within one window.
 */
function hasWorkInFlight(db: DatabaseSync, workflowId: string): boolean {
  if (db.prepare(`SELECT 1 FROM task WHERE workflow_id = ? AND status IN
    ('PENDING','READY','RUNNING','VERIFYING','RECOVERY_REQUIRED') LIMIT 1`).get(workflowId)) return true;
  return Boolean(db.prepare(`SELECT 1 FROM run r JOIN task t ON t.id = r.task_id
    WHERE t.workflow_id = ? AND r.status IN ('pending','running') LIMIT 1`).get(workflowId));
}

function fingerprintRefreshDue(hooks: ReconcileHooks): boolean {
  const window = hooks.idleFingerprintRefreshMs ?? 0;
  const cadence = hooks.idleFingerprintCadence;
  if (window <= 0 || !cadence || hasWorkInFlight(hooks.db, hooks.workflowId)) return true;
  const last = cadence.lastFullRefresh.get(hooks.workflowId);
  return last === undefined || Date.now() - last >= window;
}

/** Observe reality before making scheduling decisions. Missing fingerprints are not invented. */
export async function refreshFingerprints(hooks: ReconcileHooks): Promise<void> {
  const heartbeat = hooks.heartbeat;
  heartbeat?.();
  const observed = await hooks.fingerprinter.fingerprint(hooks.workflowId, hooks.artifactKinds, heartbeat);
  for (const kind of hooks.artifactKinds) {
    heartbeat?.();
    // Logical inputs already have an immutable Runtime revision. They are never missing file artifacts.
    if (kind === 'face_input') { observed[kind] = resolveWorkflowInput(hooks.db, hooks.workflowId).faceInputHash; continue; }
    const hash = observed[kind];
    const row = hooks.db.prepare(`SELECT hash FROM artifact_version WHERE workflow_id = ? AND kind = ?
      ORDER BY seq DESC LIMIT 1`).get(hooks.workflowId, kind) as { hash: string } | undefined;
    if (hash === undefined && !row) continue;
    if (row?.hash === (hash ?? '')) { hooks.fingerprinter.unchanged?.(hooks.workflowId, kind); continue; }
    // Which files changed: a stage rerun that nobody asked for has to be traceable to the member that caused it.
    const change = row ? hooks.fingerprinter.changeOf?.(hooks.workflowId, kind) : undefined;
    withStateEvent(hooks.db, {
      workflowId: hooks.workflowId, actor: 'runtime', entityType: 'artifact_version',
      entityId: kind, action: 'observed', reason: `fingerprint changed${change ? `: ${describeChange(change)}` : ''}`,
      payload: { hash, ...(hooks.fingerprinter.managedChangeOf?.(hooks.workflowId, kind) ? { managedSideEffect: 'unity-new-metadata' } : {}), ...(change ? { change: { added: change.added.slice(0, 50), removed: change.removed.slice(0, 50),
        modified: change.modified.slice(0, 50), counts: [change.added.length, change.removed.length, change.modified.length] } } : {}) },
    }, () => hooks.db.prepare('INSERT INTO artifact_version (workflow_id, kind, hash) VALUES (?, ?, ?)')
      .run(hooks.workflowId, kind, hash ?? ''));
    hooks.fingerprinter.recorded?.(hooks.workflowId, kind);
  }
}
function describeChange(change: { added: string[]; removed: string[]; modified: string[] }): string {
  const parts = ([['增', change.added], ['删', change.removed], ['改', change.modified]] as const)
    .filter(([, paths]) => paths.length).map(([label, paths]) =>
      `${label} ${paths.length}（${paths.slice(0, 3).join('、')}${paths.length > 3 ? ' 等' : ''}）`);
  return parts.join('；') || '成员未变（内容相同）';
}

export interface ReconcileOptions {
  /**
   * Whether this pass observes the artifacts again. A Scheduler round reconciles twice — before its dispatch
   * decisions and after them — and the second pass is there to observe the Runs that dispatch started, not to repeat
   * the scan the first pass just did. Nothing between them can change the project's files (dispatch only starts a
   * unit), and the path that does need the fingerprints of a finished Run (`finish`) refreshes them itself.
   */
  fingerprints?: boolean;
}

/**
 * Observe reality before making scheduling decisions. Returns whether this call refreshed the fingerprints, so the
 * round can tell a fresh view from a throttled one.
 */
export async function reconcile(hooks: ReconcileHooks, mayLaunch: () => boolean = () => true,
  options: ReconcileOptions = {}): Promise<boolean> {
  // A settled Workflow is observed on a cadence, not every round. The cheap part (Run observation below) still
  // runs every round, so a Run that exits is collected promptly whatever the fingerprint cadence.
  let refreshed = false;
  if (options.fingerprints !== false && fingerprintRefreshDue(hooks)) {
    await refreshFingerprints(hooks);
    hooks.idleFingerprintCadence?.lastFullRefresh.set(hooks.workflowId, Date.now());
    refreshed = true;
  }
  const rows = hooks.db.prepare(`SELECT r.id, r.status, r.process_ref, r.result_json, o.status AS outbox_status
    FROM run r JOIN task t ON t.id = r.task_id
    JOIN dispatch_outbox o ON o.run_id = r.id
    WHERE t.workflow_id = ? AND t.status = 'RUNNING'
      AND r.attempt = (SELECT MAX(attempt) FROM run WHERE task_id = r.task_id)
      AND (r.status IN ('pending', 'running')
        -- An exit fact is persisted before the post-exit work, so a cycle that stopped there (a lost lease, a crash)
        -- leaves a RUNNING Task with an exited Run. Settle it from that persisted result below, or the Task would
        -- never be collected.
        OR (r.status = 'exited' AND r.result_json IS NOT NULL)) ORDER BY r.rowid`)
    .all(hooks.workflowId) as { id: string; status: string; process_ref: string | null; result_json: string | null;
      outbox_status: string }[];
  for (const row of rows) {
    // The exit fact is durable because the supervisor persists it before doing anything else. A Task left RUNNING
    // next to an exited Run therefore already has its result: settle from it rather than observing or collecting
    // again, either of which can advance the execution chain and overwrite a success with a failure.
    if (row.status === 'exited' && row.result_json) {
      let saved: RunResult;
      try { saved = JSON.parse(row.result_json) as RunResult; }
      catch { hooks.heartbeat?.(); hooks.unknown(row.id, '保存的执行结果无法解析'); continue; }
      await hooks.finish(row.id, saved);
      continue;
    }
    if (row.outbox_status === 'intended') {
      if (mayLaunch()) await hooks.launch(row.id); // same Run and idempotency key; pause never starts an intended unit
      continue;
    }
    if (!row.process_ref) { hooks.heartbeat?.(); hooks.unknown(row.id, 'Run 没有执行单元句柄'); continue; }
    let observation;
    try { observation = await hooks.executor.observe({ ref: row.process_ref }); }
    catch (error) { hooks.heartbeat?.(); hooks.unknown(row.id, `查询执行单元出错：${message(error)}`); continue; }
    // Observing the unit is the long step of this path. A lease taken over meanwhile must stop the round here,
    // rather than let its outcome be recorded as this cycle's finding (`unknown` writes RECOVERY_REQUIRED).
    hooks.heartbeat?.();
    if (observation.state === 'unknown') { hooks.unknown(row.id, '执行单元状态无法确认（既不在运行，也没有退出记录）'); continue; }
    if (observation.state === 'exited') {
      let result: RunResult;
      try { result = await hooks.executor.collect({ ref: row.process_ref }); }
      catch (error) { hooks.heartbeat?.(); hooks.unknown(row.id, `读取执行结果出错：${message(error)}`); continue; }
      await hooks.finish(row.id, result);
    }
  }
  return refreshed;
}
function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);
}
