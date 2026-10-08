import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../pack-hash.ts';
import { effectiveFacePlan, type FaceIdentity } from '../face-policy.ts';
import { inTransaction } from '../archive/facts.ts';

export const inputSha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export function parseInputHashes(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, hash]) =>
    key !== 'face_input' || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('输入版本令牌无效。');
  return value as Record<string, string>;
}
export interface WorkflowInput {
  revisionId?: string;
  revision: number;
  activationId: string;
  faceIdentity: FaceIdentity;
  faceInputHash: string;
  plan: Record<string, any>;
}
function workflow(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT project_id,process_id,plan_json FROM workflow WHERE id=?').get(id);
  if (!row) throw new Error(`Unknown workflow ${id}`);
  return row;
}

/** All consumers resolve the same formal input; preferences and drafts are not production input. */
export function resolveWorkflowInput(db: DatabaseSync, workflowId: string, revisionId?: string): WorkflowInput {
  const row = workflow(db, workflowId), base = JSON.parse(String(row.plan_json));
  const revision = revisionId ? db.prepare('SELECT * FROM workflow_input_revision WHERE workflow_id=? AND id=?').get(workflowId, revisionId)
    : db.prepare('SELECT * FROM workflow_input_revision WHERE workflow_id=? ORDER BY revision DESC LIMIT 1').get(workflowId);
  if (revisionId && !revision) throw new Error('输入修订不属于当前制作流程。');
  const faceIdentity: FaceIdentity = revision ? JSON.parse(String(revision.face_identity_json)) : {
    schema: 'face-input/0.1', mode: base.face?.mode ?? 'preserve',
    ...(base.face?.mode === 'manual' ? { manualSessionId: base.face.manualSessionId } : {}),
  };
  const activationId = revision ? String(revision.activation_id) : `base:${workflowId}`;
  return {
    ...(revision ? { revisionId: String(revision.id) } : {}), revision: Number(revision?.revision ?? 0), activationId, faceIdentity,
    faceInputHash: revision ? String(revision.face_input_hash) : inputSha256(canonicalJson({ schema: 'workflow-input/0.1', activationId, faceIdentity })),
    plan: row.process_id === 'manual-face' || !revision ? base : effectiveFacePlan(base, faceIdentity),
  };
}

/** Internal copies can reference original immutable input only through recorded continuation lineage. */
export function acceptedFaceOwner(db: DatabaseSync, projectId: string, sessionId: string): string {
  const direct = db.prepare('SELECT project_id FROM face_manual_session WHERE id=? AND project_id=?').get(sessionId, projectId);
  if (direct) return projectId;
  const binding = db.prepare(`SELECT s.project_id FROM face_manual_binding b JOIN production_continuation c ON c.id=b.continuation_id
    JOIN face_manual_session s ON s.id=b.session_id WHERE b.project_id=? AND b.session_id=?
    AND c.successor_project_id=b.project_id AND c.logical_project_id=s.project_id`).get(projectId, sessionId);
  if (!binding) throw new Error('手动输入不属于当前项目或受管生产谱系。');
  return String(binding.project_id);
}

export function acceptedFaceIdentity(db: DatabaseSync, projectId: string, manualSessionId: string): FaceIdentity {
  const row = db.prepare("SELECT * FROM face_manual_session WHERE id=? AND project_id=? AND state='accepted'").get(manualSessionId, acceptedFaceOwner(db, projectId, manualSessionId));
  if (!row?.accepted_json || !row.version) throw new Error('缺少已接受的手动脸型内容或版本。');
  const values = JSON.parse(String(row.accepted_json));
  if (!/^[a-f0-9]{64}$/.test(values.sourceSha256 ?? '') || typeof values.rendererPath !== 'string' || !values.rendererPath ||
      typeof values.meshName !== 'string' || !values.meshName) throw new Error('已接受脸型缺少源与目标身份。');
  return { schema: 'face-input/0.1', mode: 'manual', manualSessionId, manualVersion: Number(row.version),
    acceptedValuesSha256: inputSha256(canonicalJson(values)), sourceSha256: values.sourceSha256,
    rendererPath: values.rendererPath, meshName: values.meshName };
}

/** Internal transaction primitive for acceptance/rollback/continuation. The caller owns UI revision and safe-copy policy. */
export function activateFaceInput(db: DatabaseSync, workflowId: string,
  request: { activationId: string; mode: FaceIdentity['mode']; manualSessionId?: string; expectedRevision?: number }): WorkflowInput {
  if (!request.activationId.trim() || !['preserve', 'design', 'manual'].includes(request.mode)) throw new Error('Invalid face activation');
  return inTransaction(db, () => {
    const row = workflow(db, workflowId);
    if (row.process_id === 'manual-face') throw new Error('手动交接不能采用父生产输入。');
    const contract = db.prepare('SELECT capabilities_json FROM workflow_definition WHERE workflow_id=?').get(workflowId);
    if (contract && JSON.parse(String(contract.capabilities_json)).artifacts?.face_input?.source?.kind !== 'runtime')
      throw new Error('冻结工作流缺少版本化输入合同，请建立受管后继流程。');
    const identity: FaceIdentity = request.mode === 'manual'
      ? acceptedFaceIdentity(db, String(row.project_id), request.manualSessionId ?? '')
      : { schema: 'face-input/0.1', mode: request.mode };
    const prior = db.prepare('SELECT * FROM workflow_input_revision WHERE workflow_id=? AND activation_id=?').get(workflowId, request.activationId);
    if (prior) {
      if (canonicalJson(JSON.parse(String(prior.face_identity_json))) !== canonicalJson(identity)) throw new Error('采用事件已有不同输入。');
      return resolveWorkflowInput(db, workflowId, String(prior.id));
    }
    const current = resolveWorkflowInput(db, workflowId);
    if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) throw Object.assign(new Error('输入修订已变化。'), { code: 'STALE' });
    // Insert the source event first: the immutable revision and its audit event commit together, including nested callers.
    const event = db.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)
      VALUES(?,'runtime','workflow_input',?,'face_input_adopted','Formal face input activation',?) RETURNING seq`)
      .get(workflowId, request.activationId, JSON.stringify({ activationId: request.activationId, faceIdentity: identity }))!;
    const base = db.prepare("SELECT hash FROM artifact_version WHERE workflow_id=? AND kind='plan' ORDER BY seq DESC LIMIT 1").get(workflowId);
    const hash = inputSha256(canonicalJson({ schema: 'workflow-input/0.1', activationId: request.activationId, faceIdentity: identity }));
    db.prepare(`INSERT INTO workflow_input_revision(id,workflow_id,revision,activation_id,source_event_seq,base_plan_hash,face_identity_json,face_input_hash)
      VALUES(?,?,?,?,?,?,?,?)`).run(randomUUID(), workflowId, current.revision + 1, request.activationId, event.seq!, base?.hash ?? null, canonicalJson(identity), hash);
    return resolveWorkflowInput(db, workflowId);
  });
}

export interface RunInputSnapshot {
  workflowInputRevisionId?: string;
  baseline: Record<string, string>;
  plan: Record<string, any>;
  planSha256: string;
  manualValues?: string;
  manualValuesSha256?: string;
  manualHandoff?: Record<string, string>;
  stageToolSelection: { selectionSeq?: number };
  faceSelection?: { content: string; sha256: string };
}

/** Called in run_intended, before any external unit can start. */
export function freezeRunInput(db: DatabaseSync, workflowId: string, runId: string, baseline: Record<string, string>,
  extras: Pick<RunInputSnapshot, 'stageToolSelection' | 'faceSelection'> = { stageToolSelection: {} }): RunInputSnapshot {
  if (!db.isTransaction) throw new Error('Run inputs must be frozen in the dispatch transaction');
  if (!db.prepare('SELECT 1 FROM run r JOIN task t ON t.id=r.task_id WHERE r.id=? AND t.workflow_id=?').get(runId, workflowId))
    throw new Error('Run does not belong to the input Workflow');
  const input = resolveWorkflowInput(db, workflowId), row = workflow(db, workflowId);
  const planText = canonicalJson(input.plan);
  const snapshot: RunInputSnapshot = { ...(input.revisionId ? { workflowInputRevisionId: input.revisionId } : {}),
    baseline: { ...baseline }, plan: input.plan, planSha256: inputSha256(planText), ...extras };
  if (input.faceIdentity.mode === 'manual' && row.process_id !== 'manual-face') {
    const identity = acceptedFaceIdentity(db, String(row.project_id), input.faceIdentity.manualSessionId ?? '');
    if (canonicalJson(identity) !== canonicalJson(input.faceIdentity)) throw new Error('冻结脸型内容与正式输入身份不同。');
    const accepted = db.prepare('SELECT accepted_json FROM face_manual_session WHERE id=?').get(identity.manualSessionId!)!;
    snapshot.manualValues = String(accepted.accepted_json);
    snapshot.manualValuesSha256 = inputSha256(snapshot.manualValues);
  }
  const manual = db.prepare("SELECT input_json FROM face_manual_session WHERE workflow_id=? AND state='processing'").get(workflowId);
  if (manual?.input_json) snapshot.manualHandoff = JSON.parse(String(manual.input_json));
  db.prepare(`INSERT INTO run_input_snapshot(run_id,workflow_input_revision_id,baseline_artifact_hashes_json,effective_plan_json,effective_plan_sha256,
    manual_values_json,manual_values_sha256,manual_handoff_json,stage_tool_selection_json,face_selection_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(runId, input.revisionId ?? null, JSON.stringify(snapshot.baseline), planText, snapshot.planSha256,
      snapshot.manualValues ?? null, snapshot.manualValuesSha256 ?? null, snapshot.manualHandoff ? JSON.stringify(snapshot.manualHandoff) : null,
      JSON.stringify(snapshot.stageToolSelection), snapshot.faceSelection ? JSON.stringify(snapshot.faceSelection) : null);
  return snapshot;
}

export function readRunInputSnapshot(db: DatabaseSync, runId: string): RunInputSnapshot | undefined {
  const row = db.prepare('SELECT * FROM run_input_snapshot WHERE run_id=?').get(runId);
  if (!row) return undefined;
  if (inputSha256(String(row.effective_plan_json)) !== row.effective_plan_sha256 ||
      (row.manual_values_json && inputSha256(String(row.manual_values_json)) !== row.manual_values_sha256)) throw new Error('Run 输入快照内容校验失败。');
  const faceSelection = row.face_selection_json ? JSON.parse(String(row.face_selection_json)) : undefined;
  if (faceSelection && inputSha256(faceSelection.content) !== faceSelection.sha256) throw new Error('Run 候选选择快照校验失败。');
  return { ...(row.workflow_input_revision_id ? { workflowInputRevisionId: String(row.workflow_input_revision_id) } : {}),
    baseline: JSON.parse(String(row.baseline_artifact_hashes_json)), plan: JSON.parse(String(row.effective_plan_json)), planSha256: String(row.effective_plan_sha256),
    ...(row.manual_values_json ? { manualValues: String(row.manual_values_json), manualValuesSha256: String(row.manual_values_sha256) } : {}),
    ...(row.manual_handoff_json ? { manualHandoff: JSON.parse(String(row.manual_handoff_json)) } : {}),
    stageToolSelection: JSON.parse(String(row.stage_tool_selection_json)),
    ...(faceSelection ? { faceSelection } : {}) };
}
