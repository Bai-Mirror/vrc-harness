import type { DatabaseSync } from 'node:sqlite';
import {validArchivedPreparation,type ArchivedPreparationProof} from '../workflow/preparation-evidence.ts';
import { aggregateProcess } from '../process/aggregate.ts';
import { resolveWorkflowInput } from '../workflow/inputs.ts';
import type {
  AggregateInput, AggregateResult, GateDecision, OutOfBoundsChange,
  ProcessDefinition, Verdict,
} from '../process/types.ts';

/** Read one workflow's ordered facts into the exact input expected by WP1. */
export function buildAggregateInput(db: DatabaseSync, workflowId: string): AggregateInput {
  const workflow = db.prepare('SELECT plan_json FROM workflow WHERE id = ?')
    .get(workflowId) as { plan_json: string } | undefined;
  if (!workflow) throw new Error(`Unknown workflow ${workflowId}`);

  const artifactHashes: Record<string, string> = {};
  const artifacts = db.prepare('SELECT kind, hash FROM artifact_version WHERE workflow_id = ? ORDER BY seq')
    .all(workflowId) as { kind: string; hash: string }[];
  for (const artifact of artifacts) artifactHashes[artifact.kind] = artifact.hash;
  const resolved = resolveWorkflowInput(db, workflowId);
  // Runtime is authoritative for logical input identity, never a Provider artifact_version claim.
  const contract = db.prepare('SELECT capabilities_json FROM workflow_definition WHERE workflow_id=?').get(workflowId);
  if (resolved.revisionId || (contract && JSON.parse(String(contract.capabilities_json)).artifacts?.face_input?.source?.kind === 'runtime'))
    artifactHashes.face_input = resolved.faceInputHash;

  const verdicts = (db.prepare(`SELECT id, check_id, scope, artifact_hash, result, basis, input_hashes_json
    FROM verdict WHERE workflow_id = ? ORDER BY seq`).all(workflowId) as {
      id: string; check_id: string; scope: Verdict['scope']; artifact_hash: string;
      result: Verdict['result']; basis: string | null;
      input_hashes_json: string | null;
    }[]).map(row => ({
      id: row.id, checkId: row.check_id, scope: row.scope,
      artifactHash: row.artifact_hash, result: row.result,
      ...(row.basis === null ? {} : { basis: row.basis }),
      ...(row.input_hashes_json === null ? {} : { inputHashes: JSON.parse(row.input_hashes_json) }),
    }));

  const gateDecisions = (db.prepare(`SELECT gate_id, artifact_hash, result, selection_json, input_hashes_json
    FROM gate_decision WHERE workflow_id = ? ORDER BY seq`).all(workflowId) as {
      gate_id: string; artifact_hash: string; result: GateDecision['result']; selection_json: string | null;
      input_hashes_json: string | null;
    }[]).map(row => ({
      gateId: row.gate_id, artifactHash: row.artifact_hash, result: row.result,
      ...(row.input_hashes_json === null ? {} : { inputHashes: JSON.parse(row.input_hashes_json) }),
      ...(row.selection_json ? { selection: JSON.parse(row.selection_json) as GateDecision['selection'] } : {}),
    }));

  const warningAcceptances = (db.prepare(`SELECT verdict_id FROM warning_acceptance
    WHERE workflow_id = ? ORDER BY seq`).all(workflowId) as { verdict_id: string }[])
    .map(row => ({ verdictId: row.verdict_id }));

  const completions = (db.prepare(`SELECT stage_id, artifact_hashes_json FROM stage_completion
    WHERE workflow_id = ? ORDER BY seq`).all(workflowId) as {
      stage_id: string; artifact_hashes_json: string;
    }[]).map(row => ({
      stageId: row.stage_id, artifactHashes: JSON.parse(row.artifact_hashes_json) as Record<string, string>,
    }));

  // Preparation evidence remains a reference to its original observed Run. No synthetic successor Run is created.
  const reused = db.prepare(`SELECT e.stage_id,e.source_workflow_id,c.artifact_hashes_json FROM production_evidence_reuse e
    JOIN stage_completion c ON c.seq=e.source_completion_seq WHERE e.workflow_id=?`).all(workflowId);
  const frozen = contract ? JSON.parse(String(db.prepare('SELECT definition_json FROM workflow_definition WHERE workflow_id=?').get(workflowId)!.definition_json)) as ProcessDefinition : undefined;
  for (const reuse of reused) {
    const stage = frozen?.stages.find(stage => stage.id === reuse.stage_id);
    const recorded = JSON.parse(String(reuse.artifact_hashes_json));
    if (!stage || stage.invalidated_by.some(kind => recorded[kind] !== artifactHashes[kind])) continue;
    const source = buildAggregateInput(db, String(reuse.source_workflow_id));
    completions.push({ stageId: stage.id, artifactHashes: recorded });
    verdicts.unshift(...source.verdicts.filter(verdict => stage.requires.includes(verdict.checkId)));
    gateDecisions.unshift(...source.gateDecisions.filter(gate => stage.gates.includes(gate.gateId)));
    warningAcceptances.push(...source.warningAcceptances);
  }

  for(const evidence of db.prepare('SELECT proof_json,proof_sha256 FROM production_archived_evidence WHERE workflow_id=? ORDER BY rowid').all(workflowId)) {
    const proof=JSON.parse(String(evidence.proof_json)) as ArchivedPreparationProof;
    if(!validArchivedPreparation(db,workflowId,proof,String(evidence.proof_sha256),artifactHashes))continue;
    completions.push({stageId:proof.stageId,artifactHashes:proof.artifactHashes});
    verdicts.unshift(...proof.verdicts);gateDecisions.unshift(...proof.gates);warningAcceptances.push(...proof.warningAcceptances);
  }

  const outOfBoundsChanges = (db.prepare(`SELECT stage_id, artifact, accepted FROM out_of_bounds_change
    WHERE workflow_id = ? ORDER BY seq`).all(workflowId) as {
      stage_id: string; artifact: string; accepted: number;
    }[]).map(row => ({
      stageId: row.stage_id, artifact: row.artifact, accepted: Boolean(row.accepted),
    } satisfies OutOfBoundsChange));

  return {
    artifactHashes,
    plan: resolved.plan,
    verdicts,
    gateDecisions,
    warningAcceptances,
    completions,
    outOfBoundsChanges,
  };
}

export function aggregateWorkflow(
  db: DatabaseSync, workflowId: string, definition: ProcessDefinition,
): AggregateResult {
  return aggregateProcess(definition, buildAggregateInput(db, workflowId));
}
