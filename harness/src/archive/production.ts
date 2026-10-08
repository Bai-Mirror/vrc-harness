import {archiveStageContracts,type ArchivedStageContract} from './stage-contract.ts';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {workflowPreparationContract,validArchivedPreparation,type ArchivedPreparationProof} from '../workflow/preparation-evidence.ts';
import {buildAggregateInput} from '../state/aggregate-input.ts';
import {workflowSnapshot} from '../workflow/runtime.ts';
import {artifactFingerprint} from '../workflow/artifacts.ts';
import { inputSha256 } from '../workflow/inputs.ts';
import { canonicalJson } from '../pack-hash.ts';
import { SCHEMAS } from './contract.ts';

type Row = Record<string, any>;
export interface ProductionInputDocument {
  schema: string; head: string | null; sessions: Row[]; preference: Row | null; revisions: Row[]; snapshots: Row[];
  lineage: Row[]; stageContractRecovery?: {ids:Record<string,string>;sequences:Record<string,number>}; stageContracts?: ArchivedStageContract[]; baselines?: Row[]; contracts?: Row[]; reusedEvidence?: Row[]; deliveries?: Row[]; retained?: unknown; missingInputs?: string[]; recoveredMissingInputs?: string[];
}
/** Content and provenance, with no external project/baseline paths or executable process handles. */
export function productionInputDocument(db: DatabaseSync, projectId: string, portable: (value: string) => string): ProductionInputDocument {
  const logicalProjectId=String(db.prepare("SELECT logical_project_id FROM production_continuation WHERE successor_project_id=? AND state='applied' ORDER BY rowid DESC LIMIT 1").get(projectId)?.logical_project_id??projectId);
  const lineage = db.prepare(`SELECT id,activation_id,logical_project_id,predecessor_workflow_id,predecessor_project_id,
    target_revision_id,input_json,successor_project_id,successor_workflow_id,state,error,created_at,revision FROM production_continuation
    WHERE logical_project_id=? OR predecessor_project_id=? OR successor_project_id=? ORDER BY rowid`).all(projectId, projectId, projectId);
  // Checkpoints preserve identities and hashes, never foreign executable roots or process handles.
  const rawLineage = db.prepare(`SELECT id,preparation_json FROM production_continuation WHERE logical_project_id=? OR predecessor_project_id=? OR successor_project_id=?`).all(projectId,projectId,projectId);
  const checkpoints = new Map(rawLineage.map(row=> {
    const p=row.preparation_json?JSON.parse(String(row.preparation_json)):undefined;
    return [row.id,p?{checkpoint:p.checkpoint??'copy',sourceKind:p.sourceKind??'baseline',sourceFiles:p.sourceFiles??p.files,seedFiles:p.seedFiles,
      sourceContractHash:p.sourceContractHash,candidateProjectId:p.candidateProjectId,candidateWorkflowId:p.candidateWorkflowId,report:p.report,resolutions:p.resolutions,reconciliationHistory:p.reconciliationHistory}:null];
  }));
  const baselines=db.prepare(`SELECT b.workflow_id,b.source_workflow_id,b.manifest_json,b.state,b.error FROM production_baseline b JOIN workflow w ON w.id=b.workflow_id WHERE w.project_id=?`).all(projectId).map(row=>{
    const manifest=JSON.parse(String(row.manifest_json)); delete manifest.referencePath;
    return {...row,manifest_json:JSON.stringify(manifest),manifest_sha256:inputSha256(JSON.stringify(manifest))};
  });
  const contracts=db.prepare(`SELECT c.* FROM production_continuation_contract c JOIN production_continuation p ON p.id=c.continuation_id WHERE p.logical_project_id=? OR p.predecessor_project_id=? OR p.successor_project_id=?`).all(projectId,projectId,projectId).map(row=>({...row,snapshot_sha256:inputSha256(String(row.snapshot_json))}));
  const reusedEvidence=db.prepare(`SELECT e.* FROM production_evidence_reuse e JOIN workflow w ON w.id=e.workflow_id WHERE w.project_id=?`).all(projectId);
  const evidenceClosures:Row[]=reusedEvidence.map(reference=>{
    const completion=db.prepare('SELECT * FROM stage_completion WHERE seq=? AND workflow_id=?').get(reference.source_completion_seq!,reference.source_workflow_id!);
    const run=completion?.run_id?db.prepare("SELECT status,result_json FROM run WHERE id=?").get(completion.run_id):undefined;
    if(!completion||!run||run.status!=='exited'||!run.result_json)return {...reference,missing:true};
    const sourceWorkflow=String(reference.source_workflow_id),stageId=String(reference.stage_id),source=workflowSnapshot(db,sourceWorkflow),stage=source.definition.stages.find(s=>s.id===stageId)!;
    const facts=buildAggregateInput(db,sourceWorkflow);
    const proof:ArchivedPreparationProof={schema:'production-preparation-evidence/1',stageId,sourceWorkflowId:sourceWorkflow,sourceCompletionSeq:Number(completion.seq),sourceRunId:String(completion.run_id),
      contract:workflowPreparationContract(db,sourceWorkflow,stageId,String(completion.run_id)),artifactHashes:JSON.parse(String(completion.artifact_hashes_json)),outputHashes:JSON.parse(String(run.result_json)).verifiedArtifactHashes??{},
      verdicts:facts.verdicts.filter(v=>stage.requires.includes(v.checkId)),gates:facts.gateDecisions.filter(g=>stage.gates.includes(g.gateId)),warningAcceptances:facts.warningAcceptances};
    return {...reference,proof_json:canonicalJson(proof),proof_sha256:inputSha256(canonicalJson(proof))};
  });
  evidenceClosures.push(...db.prepare(`SELECT * FROM production_archived_evidence WHERE workflow_id IN (SELECT id FROM workflow WHERE project_id=?)`).all(projectId));
  const sessions = db.prepare(`SELECT DISTINCT s.id,s.parent_session_id,s.target_id,s.state,s.accepted_json,s.version FROM face_manual_session s
    WHERE s.project_id IN (?,?) OR s.id IN (SELECT session_id FROM face_manual_binding WHERE project_id=?) ORDER BY s.version,s.id`).all(projectId,logicalProjectId,projectId);
  const revisions = db.prepare(`SELECT i.* FROM workflow_input_revision i JOIN workflow w ON w.id=i.workflow_id
    WHERE w.project_id=? ORDER BY i.workflow_id,i.revision`).all(projectId);
  const snapshots = db.prepare(`SELECT s.*,r.task_id,r.attempt,r.status AS run_status,r.result_json AS source_result_json,t.workflow_id,t.stage_id,t.status AS task_status FROM run_input_snapshot s JOIN run r ON r.id=s.run_id JOIN task t ON t.id=r.task_id
    JOIN workflow w ON w.id=t.workflow_id WHERE w.project_id=? ORDER BY r.rowid`).all(projectId);
  const missingInputs: string[] = [];
  const portableRows = (rows: Row[]) => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const converted = typeof value === 'string' && key.endsWith('_json') ? portable(value) : value;
    if (converted !== value) missingInputs.push(`${row.id ?? row.run_id}:${key}`);
    return [key, converted];
  })));
  const retained = db.prepare('SELECT document_json FROM production_archive_reference WHERE project_id=?').get(projectId);
  return { schema: SCHEMAS.production, head: (db.prepare('SELECT workflow_id FROM production_head WHERE logical_project_id=?').get(logicalProjectId)?.workflow_id as string) ?? null,
    stageContracts:archiveStageContracts(db,projectId,portable),
    sessions: portableRows(sessions.map(s=>({...s,accepted_values_sha256:s.accepted_json?inputSha256(String(s.accepted_json)):null}))), preference: db.prepare('SELECT mode,revision,accepted_session_id,current_session_id FROM face_preference WHERE project_id=?').get(logicalProjectId) ?? null,
    revisions: portableRows(revisions), snapshots: portableRows(snapshots.map(row=>{const result=row.source_result_json?JSON.parse(String(row.source_result_json)):undefined;const {source_result_json,...input}=row;const producer=result?canonicalJson({exitStatus:result.exitStatus,verifiedArtifactHashes:result.verifiedArtifactHashes??{}}):null;return {...input,producer_json:producer,producer_sha256:producer?inputSha256(producer):null};})), lineage:portableRows(lineage).map(row=>({...row,checkpoint:checkpoints.get(row.id),error:row.error?portable(row.error):null})), baselines:portableRows(baselines), contracts:portableRows(contracts), reusedEvidence:portableRows(evidenceClosures), deliveries: db.prepare(`SELECT d.* FROM production_delivery d WHERE project_id=? OR project_id IN
      (SELECT successor_project_id FROM production_continuation WHERE logical_project_id=?)`).all(projectId,projectId), ...(retained ? { retained: JSON.parse(String(retained.document_json)) } : {}), missingInputs };
}

/** Restore portable inputs, preserve exact Run payloads only when their recorded digests still verify. */
export function restoreProductionInputs(db: DatabaseSync, projectId: string, root: string, document: ProductionInputDocument | undefined,
  id: (old: string) => string, eventSeq: (old: number) => number | undefined = () => undefined): void {
  if (!document) return;
  if (document.schema !== SCHEMAS.production) throw new Error('生产输入档案版本不受支持。');
  const missing = [...document.missingInputs ?? []];
  const restoredSessions=new Map<string,string>();
  for (const session of document.sessions) {
    const sessionId = id(session.id);
    if (db.prepare('SELECT 1 FROM face_manual_session WHERE id=?').get(sessionId)) continue;
    if(session.state==='accepted' && (!session.accepted_json || !session.accepted_values_sha256 || inputSha256(session.accepted_json)!==session.accepted_values_sha256)) {
      missing.push(`accepted-content:${session.id}`);continue;
    }
    // An accepted session needs no live Blender copy. Missing editor files stay missing rather than pretending usable.
    db.prepare(`INSERT INTO face_manual_session(id,project_id,project_path,target_id,state,accepted_json,version)
      VALUES(?,?,?,?,?,?,?)`).run(sessionId, projectId, join(root, '_harness', 'restored-manual', sessionId), session.target_id,
        'cancelled', session.accepted_json, session.version);
    restoredSessions.set(sessionId,session.state);
  }
  // Parents may appear after their children and IDs may be relocated. Validate the complete desired graph first.
  const parents=new Map<string,string>();
  for(const session of document.sessions) {
    if(!session.parent_session_id)continue;
    const child=id(session.id),parent=id(session.parent_session_id);
    const childRow=db.prepare('SELECT project_id FROM face_manual_session WHERE id=?').get(child);
    const parentRow=db.prepare('SELECT project_id FROM face_manual_session WHERE id=?').get(parent);
    if(!childRow || !parentRow) {missing.push(`session-parent-missing:${session.id}`);continue;}
    if(childRow.project_id!==projectId || parentRow.project_id!==projectId) {missing.push(`session-parent-project:${session.id}`);continue;}
    parents.set(child,parent);
  }
  for(const [child,parent] of parents) {
    const visited=new Set<string>([child]);let current:string|undefined=parent,cyclic=false;
    while(current) {
      if(visited.has(current)){cyclic=true;break;}visited.add(current);
      const stored:Row|undefined=db.prepare('SELECT parent_session_id FROM face_manual_session WHERE id=? AND project_id=?').get(current,projectId);
      current=parents.get(current)??(stored?.parent_session_id?String(stored.parent_session_id):undefined);
    }
    if(cyclic) {missing.push(`session-parent-cycle:${child}`);continue;}
    if(!restoredSessions.has(child)) {
      if(db.prepare('SELECT parent_session_id FROM face_manual_session WHERE id=?').get(child)?.parent_session_id!==parent)missing.push(`session-parent-conflict:${child}`);
      continue;
    }
    db.prepare('UPDATE face_manual_session SET parent_session_id=? WHERE id=? AND project_id=?').run(parent,child,projectId);
  }
  // Finalize acceptance only after lineage is restored; accepted-row immutability remains enforced.
  for(const [sessionId,state] of restoredSessions)if(state==='accepted')
    db.prepare("UPDATE face_manual_session SET state='accepted' WHERE id=? AND project_id=?").run(sessionId,projectId);
  const pref = document.preference;
  if(pref?.accepted_session_id && !db.prepare("SELECT 1 FROM face_manual_session WHERE id=? AND state='accepted'").get(id(pref.accepted_session_id)))missing.push(`accepted-session:${pref.accepted_session_id}`);
  if (pref) db.prepare(`INSERT INTO face_preference(project_id,mode,revision,accepted_session_id,current_session_id) VALUES(?,?,?,?,?)
    ON CONFLICT(project_id) DO UPDATE SET mode=excluded.mode,revision=MAX(face_preference.revision,excluded.revision)+1,
      accepted_session_id=excluded.accepted_session_id,current_session_id=excluded.current_session_id`).run(projectId, pref.mode, pref.revision,
      pref.accepted_session_id && db.prepare('SELECT 1 FROM face_manual_session WHERE id=?').get(id(pref.accepted_session_id)) ? id(pref.accepted_session_id) : null,
      pref.current_session_id && db.prepare('SELECT 1 FROM face_manual_session WHERE id=?').get(id(pref.current_session_id)) ? id(pref.current_session_id) : null);
  for (const revision of document.revisions) {
    const workflowId = id(revision.workflow_id), revisionId = id(revision.id);
    if (!db.prepare('SELECT 1 FROM workflow WHERE id=? AND project_id=?').get(workflowId, projectId)) { missing.push(`workflow:${revision.workflow_id}`); continue; }
    if (db.prepare('SELECT 1 FROM workflow_input_revision WHERE id=?').get(revisionId)) continue;
    const identity = JSON.parse(revision.face_identity_json);
    if(inputSha256(canonicalJson({schema:'workflow-input/0.1',activationId:revision.activation_id,faceIdentity:identity}))!==revision.face_input_hash) {
      missing.push(`input-identity:${revision.id}`);continue;
    }
    if (identity.manualSessionId) {
      // Keep historical identity bytes and their evidence hash together. Relocation is not a new adoption.
      if(id(identity.manualSessionId)!==identity.manualSessionId)missing.push(`relocated-session:${identity.manualSessionId}`);
      const accepted=db.prepare("SELECT accepted_json FROM face_manual_session WHERE id=? AND state='accepted'").get(identity.manualSessionId);
      if (!accepted)missing.push(`session:${identity.manualSessionId}`);
      else if(inputSha256(canonicalJson(JSON.parse(String(accepted.accepted_json))))!==identity.acceptedValuesSha256)missing.push(`session-binding:${revision.id}`);
    }
    const event = db.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)
      VALUES(?,'runtime','workflow_input',?,'restored','恢复生产输入及原采用来源',?) RETURNING seq`)
      .get(workflowId, revisionId, JSON.stringify({ originalEventSeq: revision.source_event_seq, activationId: revision.activation_id }))!;
    db.prepare(`INSERT INTO workflow_input_revision VALUES(?,?,?,?,?,?,?,?)`).run(revisionId, workflowId, revision.revision,
      revision.activation_id, event.seq!, revision.base_plan_hash, JSON.stringify(identity), revision.face_input_hash);
  }
  restoreProductionRunInputs(db,projectId,document.snapshots,id,eventSeq,missing);
  for (const delivery of document.deliveries ?? []) if (db.prepare('SELECT 1 FROM workflow WHERE id=? AND project_id=?').get(id(delivery.workflow_id),projectId))
    db.prepare('INSERT OR IGNORE INTO production_delivery(workflow_id,project_id,face_input_hash,package_hash,accepted_at) VALUES(?,?,?,?,?)')
      .run(id(delivery.workflow_id),projectId,delivery.face_input_hash,delivery.package_hash,delivery.accepted_at);
  for(const reference of document.reusedEvidence??[]) {
    const workflowId=id(reference.workflow_id);
    const unavailable=()=>missing.push(`preparation-evidence:${reference.workflow_id}:${reference.stage_id}`);
    if(reference.missing||!reference.proof_json||!reference.proof_sha256||!db.prepare('SELECT 1 FROM workflow WHERE id=? AND project_id=?').get(workflowId,projectId)){unavailable();continue;}
    const proof=JSON.parse(String(reference.proof_json)) as ArchivedPreparationProof;
    if(!validArchivedPreparation(db,workflowId,proof,reference.proof_sha256,buildAggregateInput(db,workflowId).artifactHashes)){unavailable();continue;}
    const stage=workflowSnapshot(db,workflowId).definition.stages.find(s=>s.id===proof.stageId)!;
    if(stage.produces.some(kind=>artifactFingerprint(root,workflowSnapshot(db,workflowId).capabilities.artifacts[kind]!)!==proof.outputHashes[kind])){unavailable();continue;}
    db.prepare('INSERT OR IGNORE INTO production_archived_evidence VALUES(?,?,?,?,?,?)').run(workflowId,proof.stageId,proof.sourceWorkflowId,proof.sourceCompletionSeq,reference.proof_json,reference.proof_sha256);
  }
  for(const baseline of document.baselines??[]) {
    if(inputSha256(String(baseline.manifest_json))!==baseline.manifest_sha256)missing.push(`baseline-manifest:${baseline.workflow_id}`);
    // The archive identifies an external immutable baseline, but sharing one project never manufactures its bytes.
    else if(!db.prepare("SELECT 1 FROM production_baseline WHERE workflow_id=? AND state='ready'").get(id(baseline.workflow_id)))missing.push(`baseline-content:${baseline.workflow_id}`);
  }
  for(const contract of document.contracts??[]) {
    if(inputSha256(String(contract.snapshot_json))!==contract.snapshot_sha256)missing.push(`continuation-contract:${contract.continuation_id}`);
  }
  for(const continuation of document.lineage) {
    const predecessor=id(continuation.predecessor_workflow_id);
    if(!db.prepare('SELECT 1 FROM workflow WHERE id=? AND project_id=?').get(predecessor,projectId))continue;
    // A single-project share preserves external versions as references. It cannot invent their engineering roots.
    if(continuation.successor_workflow_id && continuation.successor_workflow_id!==continuation.predecessor_workflow_id)continue;
    const revision=continuation.target_revision_id?id(continuation.target_revision_id):null;
    if(revision&&!db.prepare('SELECT 1 FROM workflow_input_revision WHERE id=?').get(revision)){missing.push(`continuation-revision:${continuation.id}`);continue;}
    const input=JSON.parse(continuation.input_json??'{}');if(input.manualSessionId)input.manualSessionId=id(input.manualSessionId);
    const activation=id(continuation.id)===continuation.id?continuation.activation_id:`restore:${projectId}:${continuation.activation_id}`;
    if(db.prepare('SELECT 1 FROM production_continuation WHERE activation_id=?').get(activation))continue;
    db.prepare(`INSERT INTO production_continuation(id,activation_id,logical_project_id,predecessor_workflow_id,predecessor_project_id,
      target_revision_id,input_json,state,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(id(continuation.id),activation,projectId,predecessor,projectId,revision,JSON.stringify(input),
        continuation.state==='preparing'?'requested':continuation.state,continuation.error??null,continuation.created_at);
    // Keep adoption and reconciliation records as provenance; cold resume must revalidate local tools and roots.
    if(continuation.checkpoint)missing.push(`preparation-content:${continuation.id}`);
  }
  if (document.head && db.prepare('SELECT 1 FROM workflow WHERE id=? AND project_id=?').get(id(document.head), projectId))
    db.prepare('INSERT INTO production_head VALUES(?,?) ON CONFLICT(logical_project_id) DO UPDATE SET workflow_id=excluded.workflow_id').run(projectId, id(document.head));
  else if (document.head) missing.push(`production-head:${document.head}`);
  db.prepare('INSERT INTO production_archive_reference VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET document_json=excluded.document_json')
    .run(projectId, JSON.stringify({ ...document, missingInputs: missing }));
}

/** Retry only immutable Run inputs, without changing preferences, accepted lineage or adoption revisions. */
export function restoreProductionRunInputs(db:DatabaseSync,projectId:string,snapshots:Row[],id:(old:string)=>string,
  eventSeq:(old:number)=>number|undefined,missing:string[]):void {
  for (const snapshot of snapshots) {
    const runId = id(snapshot.run_id);
    if (!db.prepare('SELECT 1 FROM run WHERE id=?').get(runId) && snapshot.task_id && snapshot.workflow_id) {
      const workflowId=id(snapshot.workflow_id),taskId=id(snapshot.task_id);
      if(db.prepare('SELECT 1 FROM workflow WHERE id=? AND project_id=?').get(workflowId,projectId)) {
        // Ownership travels with an input snapshot even when optional process records were excluded.
        const live=!['exited','abandoned','cancelled'].includes(snapshot.run_status);
        db.prepare(`INSERT OR IGNORE INTO task(id,workflow_id,stage_id,goal,capability,expected_outputs_json,retry_policy_json,status)
          VALUES(?,?,?,'Restore historical input owner',?,'[]','{}',?)`).run(taskId,workflowId,snapshot.stage_id,snapshot.stage_id,live?'RECOVERY_REQUIRED':snapshot.task_status);
        db.prepare('INSERT OR IGNORE INTO run(id,task_id,attempt,status) VALUES(?,?,?,?)').run(runId,taskId,snapshot.attempt,live?'restored':snapshot.run_status);
      }
    }
    if (!db.prepare('SELECT 1 FROM run WHERE id=?').get(runId)) {missing.push(`run:${snapshot.run_id}`);continue;}
    if(snapshot.producer_json && snapshot.run_status==='exited') {
      if(inputSha256(snapshot.producer_json)!==snapshot.producer_sha256)missing.push(`producer:${snapshot.run_id}`);
      else {
        const row=db.prepare("SELECT result_json FROM run WHERE id=? AND status='exited'").get(runId),producer=JSON.parse(snapshot.producer_json),prior=row?.result_json?JSON.parse(String(row.result_json)):null;
        if(!row || prior && (prior.exitStatus!==producer.exitStatus || !prior.restored&&canonicalJson(prior.verifiedArtifactHashes??{})!==canonicalJson(producer.verifiedArtifactHashes??{})))missing.push(`producer-binding:${snapshot.run_id}`);
        else if(!prior||prior.restored)db.prepare("UPDATE run SET result_json=? WHERE id=? AND status='exited'").run(JSON.stringify({...prior,...producer}),runId);
      }
    }
    if (db.prepare('SELECT 1 FROM run_input_snapshot WHERE run_id=?').get(runId)) continue;
    if (inputSha256(snapshot.effective_plan_json) !== snapshot.effective_plan_sha256 || snapshot.manual_values_json && inputSha256(snapshot.manual_values_json) !== snapshot.manual_values_sha256) {
      missing.push(`snapshot:${snapshot.run_id}`); continue;
    }
    if(snapshot.face_selection_json) {
      const choice=JSON.parse(snapshot.face_selection_json);
      if(typeof choice.content!=='string'||inputSha256(choice.content)!==choice.sha256){missing.push(`face-selection:${snapshot.run_id}`);continue;}
    }
    const revisionId = snapshot.workflow_input_revision_id ? id(snapshot.workflow_input_revision_id) : null;
    if (revisionId && !db.prepare('SELECT 1 FROM workflow_input_revision WHERE id=?').get(revisionId)) { missing.push(`snapshot-revision:${snapshot.run_id}`); continue; }
    const selection = JSON.parse(snapshot.stage_tool_selection_json);
    if (selection.selectionSeq) {
      const relocated = eventSeq(selection.selectionSeq);
      if (!relocated) { missing.push(`stage-contract:${snapshot.run_id}`); continue; }
      selection.selectionSeq = relocated;
    }
    db.prepare(`INSERT INTO run_input_snapshot VALUES(?,?,?,?,?,?,?,?,?,?)`).run(runId, revisionId, snapshot.baseline_artifact_hashes_json,
      snapshot.effective_plan_json, snapshot.effective_plan_sha256, snapshot.manual_values_json, snapshot.manual_values_sha256,
      snapshot.manual_handoff_json, JSON.stringify(selection), snapshot.face_selection_json);
  }
}
