import type { DatabaseSync } from 'node:sqlite';
import { withStateEvent } from '../state/tx.ts';

/** What `task redo` records when the person gives no note; it says nothing to an executor. */
export const DEFAULT_REDO_NOTE = 'human requested redo';

export type TaskStatus = 'PENDING' | 'READY' | 'RUNNING' | 'VERIFYING' | 'PASSED' |
  'WAITING_HUMAN' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'RECOVERY_REQUIRED';
export type TransitionProof = 'ready' | 'run_intended' | 'run_exited' | 'verified' |
  'human_needed' | 'check_failed' | 'execution_failed' | 'unknown_run' |
  'start_uncertain' | 'human_approved' | 'human_requested_redo' | 'retry_authorized' |
  'reconciled' | 'no_side_effects' | 'cancel_confirmed';
export interface Edge { from: TaskStatus; to: TaskStatus; proof: TransitionProof }

/** Exhaustive allowed edges. No terminal status has outgoing edges. */
export const TASK_EDGES: readonly Edge[] = [
  { from: 'PENDING', to: 'READY', proof: 'ready' },
  { from: 'READY', to: 'RUNNING', proof: 'run_intended' },
  { from: 'READY', to: 'WAITING_HUMAN', proof: 'human_needed' },
  { from: 'RUNNING', to: 'VERIFYING', proof: 'run_exited' },
  { from: 'RUNNING', to: 'RECOVERY_REQUIRED', proof: 'unknown_run' },
  { from: 'RUNNING', to: 'RECOVERY_REQUIRED', proof: 'start_uncertain' },
  { from: 'RUNNING', to: 'FAILED', proof: 'execution_failed' },
  { from: 'RUNNING', to: 'READY', proof: 'retry_authorized' },
  { from: 'RUNNING', to: 'WAITING_HUMAN', proof: 'human_needed' },
  { from: 'RUNNING', to: 'CANCELLED', proof: 'cancel_confirmed' },
  { from: 'VERIFYING', to: 'PASSED', proof: 'verified' },
  { from: 'VERIFYING', to: 'BLOCKED', proof: 'check_failed' },
  { from: 'VERIFYING', to: 'WAITING_HUMAN', proof: 'human_needed' },
  { from: 'VERIFYING', to: 'FAILED', proof: 'execution_failed' },
  { from: 'VERIFYING', to: 'CANCELLED', proof: 'cancel_confirmed' },
  { from: 'WAITING_HUMAN', to: 'VERIFYING', proof: 'human_approved' },
  { from: 'WAITING_HUMAN', to: 'READY', proof: 'human_requested_redo' },
  { from: 'WAITING_HUMAN', to: 'CANCELLED', proof: 'cancel_confirmed' },
  { from: 'BLOCKED', to: 'READY', proof: 'retry_authorized' },
  { from: 'BLOCKED', to: 'CANCELLED', proof: 'cancel_confirmed' },
  { from: 'RECOVERY_REQUIRED', to: 'VERIFYING', proof: 'reconciled' },
  { from: 'RECOVERY_REQUIRED', to: 'READY', proof: 'no_side_effects' },
  { from: 'RECOVERY_REQUIRED', to: 'CANCELLED', proof: 'cancel_confirmed' },
  { from: 'READY', to: 'CANCELLED', proof: 'cancel_confirmed' },
  { from: 'PENDING', to: 'CANCELLED', proof: 'cancel_confirmed' },
];

function assertGuard(db: DatabaseSync, taskId: string, from: TaskStatus, proof: TransitionProof): void {
  const run = db.prepare(`SELECT r.id, r.status, r.result_json, o.status AS outbox_status FROM run r
    LEFT JOIN dispatch_outbox o ON o.run_id = r.id WHERE r.task_id = ?
    ORDER BY r.attempt DESC LIMIT 1`).get(taskId) as
    { id: string; status: string; result_json: string | null; outbox_status: string | null } | undefined;
  if (proof === 'run_intended' && !(run?.status === 'pending' && run.outbox_status === 'intended'))
    throw new Error('Guard run_intended requires a pending Run and intended outbox');
  if (proof === 'run_exited' && run?.status !== 'exited')
    throw new Error('Guard run_exited requires an exited Run');
  if (proof === 'unknown_run' && !['launched', 'acked'].includes(run?.outbox_status ?? ''))
    throw new Error('Guard unknown_run requires a launched or acked outbox');
  if (proof === 'start_uncertain' && !(run?.status === 'pending' && run.outbox_status === 'intended'))
    throw new Error('Guard start_uncertain requires a pending Run and intended outbox');
  if (proof === 'retry_authorized' && from === 'RUNNING') {
    const result = run?.result_json ? JSON.parse(run.result_json) as
      { errorClass?: string; noSideEffects?: boolean; retryable?: boolean } : undefined;
    if (run?.status !== 'exited' || !(result?.errorClass === 'rate_limit' ||
      (result?.errorClass === 'tool_failure' && result.noSideEffects === true) ||
      (result?.errorClass === 'timeout' && result.noSideEffects === true) || result?.retryable === true))
      throw new Error('Guard retry_authorized requires a retryable exited Run');
  }
  if (proof === 'verified') {
    const completed = db.prepare(`SELECT 1 FROM stage_completion c JOIN task t
      ON t.workflow_id = c.workflow_id AND t.stage_id = c.stage_id
      WHERE t.id = ? AND c.run_id = ? LIMIT 1`).get(taskId, run?.id ?? null);
    if (run?.status !== 'exited' || !completed)
      throw new Error('Guard verified requires completion for the latest exited Run of this Task');
  }
  if (proof === 'human_approved' || proof === 'human_requested_redo') {
    const waiting = db.prepare(`SELECT MAX(seq) AS seq FROM event WHERE entity_type = 'task'
      AND entity_id = ? AND action LIKE '%->WAITING_HUMAN'`).get(taskId) as { seq: number | null };
    if (waiting.seq === null) throw new Error('Guard human response requires WAITING_HUMAN entry');
    const task = db.prepare('SELECT workflow_id, stage_id FROM task WHERE id = ?')
      .get(taskId) as { workflow_id: string; stage_id: string };
    if (proof === 'human_requested_redo') {
      const request = db.prepare(`SELECT 1 FROM event WHERE seq > ? AND workflow_id = ?
        AND actor = 'human' AND entity_type = 'task' AND entity_id = ?
        AND action = 'requested_redo' LIMIT 1`).get(waiting.seq, task.workflow_id, taskId);
      if (!request) throw new Error('Guard human_requested_redo requires a later human redo request');
    } else {
      const decision = db.prepare(`SELECT 1 FROM event e WHERE e.seq > ? AND e.workflow_id = ?
        AND e.actor = 'human' AND (
          (e.entity_type = 'gate_decision' AND e.action = 'recorded' AND EXISTS (
            SELECT 1 FROM gate_decision g WHERE CAST(g.seq AS TEXT) = e.entity_id
              AND g.workflow_id = e.workflow_id AND EXISTS (
                SELECT 1 FROM artifact_version a WHERE a.workflow_id = g.workflow_id
                  AND a.hash = g.artifact_hash AND a.seq = (
                    SELECT MAX(seq) FROM artifact_version WHERE workflow_id = a.workflow_id AND kind = a.kind))))
          OR (e.entity_type = 'warning_acceptance' AND e.action = 'recorded' AND EXISTS (
            SELECT 1 FROM warning_acceptance w JOIN verdict v
              ON v.workflow_id = w.workflow_id AND v.id = w.verdict_id
              WHERE CAST(w.seq AS TEXT) = e.entity_id AND w.workflow_id = e.workflow_id
                AND EXISTS (SELECT 1 FROM artifact_version a WHERE a.workflow_id = v.workflow_id
                  AND a.hash = v.artifact_hash AND a.seq = (
                    SELECT MAX(seq) FROM artifact_version WHERE workflow_id = a.workflow_id AND kind = a.kind))))
          OR (e.entity_type = 'out_of_bounds_change' AND e.action = 'accepted' AND EXISTS (
            SELECT 1 FROM out_of_bounds_change o WHERE CAST(o.seq AS TEXT) = e.entity_id
              AND o.workflow_id = e.workflow_id AND o.stage_id = ? AND o.accepted = 1
              AND json_extract(e.payload_json, '$.artifact_hash') IS (
                SELECT hash FROM artifact_version WHERE workflow_id = o.workflow_id
                  AND kind = o.artifact ORDER BY seq DESC LIMIT 1)))
        ) LIMIT 1`).get(waiting.seq, task.workflow_id, task.stage_id);
      if (!decision) throw new Error('Guard human_approved requires a later decision for a current artifact hash');
    }
  }
  if (proof === 'cancel_confirmed' && from === 'VERIFYING') {
    const confirmed = db.prepare(`SELECT 1 FROM event WHERE entity_type = 'run' AND entity_id = ?
      AND action = 'verification_cancel_confirmed' LIMIT 1`).get(run?.id ?? null);
    if (!confirmed) throw new Error('Guard cancel_confirmed requires verifier stop confirmation');
  }
}

/** The redo request is a human-authored, append-only event tied to the waiting Task. */
export function requestHumanRedo(db: DatabaseSync, taskId: string, reason: string): void {
  if (!reason.trim()) throw new Error('Redo reason is required');
  const row = db.prepare('SELECT workflow_id, status FROM task WHERE id = ?')
    .get(taskId) as { workflow_id: string; status: TaskStatus } | undefined;
  if (!row || row.status !== 'WAITING_HUMAN') throw new Error('Redo requires WAITING_HUMAN Task');
  withStateEvent(db, { workflowId: row.workflow_id, actor: 'human', entityType: 'task',
    entityId: taskId, action: 'requested_redo', reason }, () => {});
}

/** Additional writes execute in the same transaction as the status and its event. */
export function transitionTask(db: DatabaseSync, taskId: string, to: TaskStatus,
  proof: TransitionProof, reason: string, change?: () => void): void {
  if (!reason.trim()) throw new Error('Task transition reason is required');
  const row = db.prepare('SELECT status, workflow_id FROM task WHERE id = ?')
    .get(taskId) as { status: TaskStatus; workflow_id: string } | undefined;
  if (!row) throw new Error(`Unknown task ${taskId}`);
  if (!TASK_EDGES.some(edge => edge.from === row.status && edge.to === to && edge.proof === proof))
    throw new Error(`Invalid Task transition ${row.status} -> ${to} with ${proof}`);
  withStateEvent(db, {
    workflowId: row.workflow_id, actor: 'runtime', entityType: 'task', entityId: taskId,
    action: `${row.status}->${to}`, reason, payload: { proof },
  }, () => {
    const changed = db.prepare('UPDATE task SET status = ? WHERE id = ? AND status = ?')
      .run(to, taskId, row.status);
    if (changed.changes !== 1) throw new Error(`Task ${taskId} changed concurrently`);
    // A Run's project and slot locks cover its verification: no other Run may change the outputs while
    // checks read them. Every edge out of VERIFYING releases them in the same transaction.
    if (row.status === 'VERIFYING') db.prepare('DELETE FROM lock WHERE run_id IN (SELECT id FROM run WHERE task_id = ?)').run(taskId);
    // A temporary Task's Workflow has exactly the state of its latest Task; formal Workflows follow their milestones.
    db.prepare(`UPDATE workflow SET status = ? WHERE id = ? AND process_hash = 'avh-task/0.1'
      AND (SELECT MAX(rowid) FROM task WHERE workflow_id = ?) = (SELECT rowid FROM task WHERE id = ?)`)
      .run(['PASSED', 'FAILED', 'CANCELLED'].includes(to) ? to.toLowerCase() : 'active', row.workflow_id, row.workflow_id, taskId);
    change?.();
    assertGuard(db, taskId, row.status, proof);
  });
}
