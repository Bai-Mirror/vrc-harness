import type { DatabaseSync } from 'node:sqlite';
import type { ModelFamily, RecordErrorType } from '../shared/sharing.ts';
import { RECORD_ENUMS } from '../shared/sharing.ts';
import { recordEventOnce } from '../state/tx.ts';
import { queueSharingRecord, sharingState, type QueueOutcome } from './state.ts';

/** Project/Run identifiers, prompts, tool arguments, outputs and error text stay local. */
export function queueFinishedRun(db: DatabaseSync, runId: string): QueueOutcome | undefined {
  const state = sharingState(db);
  if (!state.active || !state.activeSince) return undefined;
  const row = db.prepare(`SELECT r.status, r.provider, r.attempt, r.result_json, t.workflow_id,
    d.intended_at, d.launched_at FROM run r JOIN task t ON t.id = r.task_id
    JOIN dispatch_outbox d ON d.run_id = r.id WHERE r.id = ?`).get(runId) as
    { status: string; provider: string | null; attempt: number; result_json: string | null;
      workflow_id: string; intended_at: string; launched_at: string | null } | undefined;
  if (!row || !['exited', 'cancelled'].includes(row.status) || !row.result_json) return undefined;
  // A change of choice never harvests previous work, including a Run already in flight when sharing was enabled.
  const start = Date.parse(row.launched_at ?? row.intended_at);
  if (!Number.isFinite(start) || start < Date.parse(state.activeSince)) return undefined;
  const result = JSON.parse(row.result_json) as { exitStatus?: unknown; errorClass?: unknown };
  if (!Number.isInteger(result.exitStatus)) return undefined;
  let model: ModelFamily | undefined;
  if (row.provider) {
    const snapshotRow = db.prepare('SELECT snapshot_json FROM provider_snapshot WHERE workflow_id = ?')
      .get(row.workflow_id) as { snapshot_json: string } | undefined;
    const snapshot = snapshotRow ? JSON.parse(snapshotRow.snapshot_json) as
      { providers?: Array<{ config?: { id?: string; adapter?: string; upstream?: string } }> } : undefined;
    const config = snapshot?.providers?.find(item => item.config?.id === row.provider)?.config;
    model = config?.adapter === 'codex-cli' ? 'gpt' : config?.adapter === 'claude-cli' ? 'claude'
      : config?.adapter === 'pi-cli' && config.upstream === 'deepseek' ? 'deepseek'
      : config?.adapter === 'pi-cli' && ['zai', 'zhipu'].includes(config.upstream ?? '') ? 'glm' : 'unknown';
  }
  const error = typeof result.errorClass === 'string' &&
    (RECORD_ENUMS.error as readonly string[]).includes(result.errorClass) ? result.errorClass as RecordErrorType
    : result.exitStatus !== 0 && row.status !== 'cancelled' ? 'other' : undefined;
  const minutes = Math.max(0, Date.now() - start) / 60_000;
  return queueSharingRecord(db, { category: 'tool-reliability', action: row.provider ? 'provider-run' : 'tool-run',
    outcome: row.status === 'cancelled' ? 'cancelled' : result.exitStatus === 0 && !error ? 'success' : 'failure',
    ...(error ? { error } : {}), ...(model ? { model } : {}), attempt: row.attempt === 1 ? 'first' : 'retry',
    duration: minutes < 1 ? 'lt-1m' : minutes < 5 ? '1-5m' : minutes < 15 ? '5-15m' : minutes < 60 ? '15-60m' : 'gt-60m',
    platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos'
      : process.platform === 'linux' ? 'linux' : 'other',
  }, { source: `finished-run:${runId}` });
}

/** Optional contribution failures must not change local execution or verification. No network call is made here. */
export function observeFinishedRun(db: DatabaseSync, runId: string): void {
  try { queueFinishedRun(db, runId); }
  catch {
    try { recordEventOnce(db, { actor: 'runtime', entityType: 'sharing', entityId: runId,
      action: 'queue_failed', reason: 'Optional structured record could not be queued; local production continues' }); }
    catch { /* A database failure in an optional channel must not replace the production result. */ }
  }
}
