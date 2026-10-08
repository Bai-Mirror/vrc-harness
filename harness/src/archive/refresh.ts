import type { DatabaseSync } from 'node:sqlite';
import { refreshFingerprints, type ReconcileHooks } from '../runtime/reconcile.ts';
import { ArtifactFingerprinter, workflowSnapshot } from '../workflow/runtime.ts';
import { latestFormalWorkflow, workflowIsLive } from './facts.ts';
import { projectSafePoint, safePointProblem, type ArchiveWriteResult } from './projection.ts';
import { projectRoot } from './takeover.ts';

/**
 * A full safe point on request (`avh project archive`, a share, a restore): the scheduler refreshes a live Workflow's
 * artifact fingerprints every round, so an edit made since the last round is fingerprinted first; then the project is
 * observed, walked, and its archive written and verified (a failed write is retried at once).
 */
export async function archiveSafePoint(db: DatabaseSync, home: string, projectId: string): Promise<ArchiveWriteResult> {
  const workflow = latestFormalWorkflow(db, projectId);
  if (workflow && workflowIsLive(workflow.status) && !safePointProblem(db, projectId)) {
    const snapshot = workflowSnapshot(db, workflow.id);
    const fingerprinter = new ArtifactFingerprinter(db, snapshot, projectRoot(db, projectId), home);
    await refreshFingerprints({ db, workflowId: workflow.id, artifactKinds: snapshot.definition.artifacts, fingerprinter } as unknown as ReconcileHooks);
  }
  return projectSafePoint(db, projectId, { tree: true, force: true });
}
