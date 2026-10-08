import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LocalConfig } from './config.ts';
import { managedPacks } from './managed-pack.ts';
import { candidateTrialConfig, packCandidates, packTreeHash, validatedLocalCandidate } from './managed-pack-candidate.ts';
import { withStateEvent } from './state/tx.ts';

type Adoption = {id:string;scope:'project'|'local';projectId:string|null;candidateId:string|null;contentHash:string|null;
  basePackId:string|null;baseHash:string|null;evaluationId:string|null;status:string;reason:string;createdAt:string};
const columns='id,scope,project_id AS projectId,candidate_id AS candidateId,content_hash AS contentHash,base_pack_id AS basePackId,base_hash AS baseHash,evaluation_id AS evaluationId,status,reason,created_at AS createdAt';
function conflict(reason:string):never {throw Object.assign(new Error(reason),{code:'CONFLICT'});}
/** Candidate validators also serve developer tools; translate their known failures for the user control surface. */
export function maintenanceProblem(error:unknown):string {
  const reason=String((error as Error)?.message??error);
  if(reason.includes('complete isolated evaluation'))return '候选尚未完成隔离评测，请先检查候选结构并保留实际业务验证范围';
  if(reason.includes('same coverage'))return '独立评测未通过相同案例覆盖校验，请修复候选并重新验证';
  if(reason.includes('no longer matches'))return '候选内容已变化，当前摘要不再有效；请重新生成并验证候选';
  if(reason.includes('unknown candidate'))return '本地候选不存在，请刷新并重新选择';
  if(reason.includes('candidate trial cannot')||reason.includes('forbidden local-trial privilege'))return '候选改变了受保护的验收、权限或流程边界，需要独立修订并验证；当前不能采用';
  return reason;
}
export function localMaintenanceHistory(db:DatabaseSync,projectId:string):Adoption[] {
  return db.prepare(`SELECT ${columns} FROM local_pack_adoption WHERE project_id=? OR scope='local' ORDER BY rowid DESC`).all(projectId) as Adoption[];
}
/** This compact identity participates in proposal CAS and is supplied to the coordinator as read-only context. */
export function localMaintenanceIdentity(db:DatabaseSync,projectId:string) {
  const history=localMaintenanceHistory(db,projectId);
  const project=history.find(row=>row.scope==='project'&&row.status==='active');
  const local=history.find(row=>row.scope==='local'&&row.status==='active');
  const selected=project??local;
  return selected?{id:selected.id,scope:selected.scope,candidateId:selected.candidateId,contentHash:selected.contentHash}:null;
}
function token(db:DatabaseSync,projectId:string):string {
  return createHash('sha256').update(JSON.stringify(localMaintenanceHistory(db,projectId).map(row=>[row.id,row.status]))).digest('hex');
}
function activeBase(config:LocalConfig) {
  const base=managedPacks(config.home,config.knowledgeRoot).find(pack=>pack.active);
  if(!base)conflict('当前能力来源不是已安装的正式基线，请先在核心管理选择正式版本后重新验证本地修复');
  return base;
}
function checkAdoption(db:DatabaseSync,config:LocalConfig,row:Adoption,profile:string) {
  const authority=db.prepare(`SELECT a.approved_by AS approvedBy,e.entity_id AS owner,e.payload_json AS payload FROM local_pack_adoption a JOIN event e
    ON e.actor='human' AND e.entity_type='local_pack_adoption' AND e.action='selected'
    AND json_extract(e.payload_json,'$.commandId')=a.command_id WHERE a.id=? ORDER BY e.seq DESC LIMIT 1`).get(row.id) as
    {approvedBy:string;owner:string;payload:string}|undefined;
  const decision=authority?JSON.parse(authority.payload):undefined;
  if(!authority?.approvedBy.trim()||decision?.candidateId!==row.candidateId||decision?.scope!==row.scope||(row.scope==='project'&&authority.owner!==row.projectId))
    conflict('本地采用缺少对应的用户决定回执，请重新在记忆与 SOP 中选择；候选声明不授予采用权限');
  const {candidate,evaluation}=validatedLocalCandidate(db,row.candidateId!);
  assertNotStopped(db,candidate.id);
  if(candidate.contentHash!==row.contentHash||evaluation.id!==row.evaluationId)
    conflict('本地修复或验证已变化，请重新核对并采用，或回到正式版本；当前制作不会热换');
  const base=activeBase(config);
  if(base.id!==row.basePackId||packTreeHash(base.root).hash!==row.baseHash)
    conflict('正式能力已更新，与本地修复的共同基线不同。请重新基于当前版本生成并验证修复，或回到正式版本');
  return {candidate,config:candidateTrialConfig(config,candidate,profile)};
}
function assertNotStopped(db:DatabaseSync,candidateId:string):void {
  if(db.prepare(`SELECT 1 FROM local_pack_adoption WHERE candidate_id=? AND status='disabled'`).get(candidateId)||
    db.prepare(`SELECT 1 FROM managed_pack_trial t JOIN event e ON e.entity_type='managed_pack_trial' AND e.entity_id=t.id
      AND e.action='auto_disabled' WHERE t.candidate_id=? AND t.status='disabled'`).get(candidateId))
    conflict('这个本地修复已因可靠性问题停用，请生成并验证新候选');
}
export function localWorkflowSelection(db:DatabaseSync,config:LocalConfig,projectId:string,profile:string) {
  const identity=localMaintenanceIdentity(db,projectId);
  if(!identity?.candidateId)return undefined;
  const adoption=localMaintenanceHistory(db,projectId).find(row=>row.id===identity.id)!;
  return {adoption,...checkAdoption(db,config,adoption,profile)};
}
export function localMaintenanceView(db:DatabaseSync,config:LocalConfig,projectId:string) {
  if(!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId))throw new Error('项目不存在');
  const history=localMaintenanceHistory(db,projectId),identity=localMaintenanceIdentity(db,projectId);
  const base=managedPacks(config.home,config.knowledgeRoot).find(pack=>pack.active);
  const candidates=packCandidates(db).map(candidate=>{
    const evaluation=db.prepare(`SELECT id,status,suite_id AS suiteId,suite_version AS suiteVersion FROM managed_pack_evaluation
      WHERE candidate_id=? ORDER BY started_at DESC,id DESC LIMIT 1`).get(candidate.id) as {id:string;status:string;suiteId:string;suiteVersion:string}|undefined;
    let problem:string|null=null;
    try {
      if(!base||candidate.basePackId!==base.id)conflict('共同基线已不同；请基于当前正式版本重新生成并验证');
      validatedLocalCandidate(db,candidate.id);assertNotStopped(db,candidate.id);candidateTrialConfig(config,candidate,config.defaultProfile);
    }catch(error){problem=maintenanceProblem(error);}
    const ready=problem===null;
    return {id:candidate.id,version:candidate.version,reason:candidate.reason,contentHash:candidate.contentHash,sourceKind:candidate.sourceKind,
      basePackId:candidate.basePackId,evaluation,ready,defaultReady:ready&&evaluation?.suiteId!=='managed-pack-smoke',
      verification:evaluation?.suiteId==='managed-pack-smoke'?'仅结构检查；实际工程效果仍需制作流程独立验证':evaluation?`已完成隔离对照：${evaluation.suiteId} / ${evaluation.suiteVersion}`:'尚未完成隔离验证',
      problem};
  });
  let currentProblem:string|null=null;
  try{localWorkflowSelection(db,config,projectId,config.defaultProfile);}catch(error){currentProblem=maintenanceProblem(error);}
  return {token:token(db,projectId),current:identity,currentProblem,history,candidates,
    notice:'只影响后继新制作，运行中版本与已接受成果保留。切换能力不等于恢复工程；失败工程仍须核对恢复点。'};
}

/** Called from the user's local control API only. AI output has no consumer for these commands. */
export function adoptLocalCandidate(db:DatabaseSync,config:LocalConfig,projectId:string,input:{scope:'project'|'local';candidateId:string|null;
  expectedHash?:string;expectedToken:string;commandId:string},approvedBy:string) {
  if(!['project','local'].includes(input.scope)||!input.commandId||input.commandId.length>200)throw new Error('本地采用命令无效');
  if(!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId))throw new Error('项目不存在');
  return withStateEvent(db,{actor:'human',entityType:'local_pack_adoption',entityId:projectId,action:'selected',reason:'用户选择后继制作的本地能力',
    payload:{scope:input.scope,candidateId:input.candidateId,commandId:input.commandId}},()=>{
    const prior=db.prepare(`SELECT ${columns} FROM local_pack_adoption WHERE command_id=?`).get(input.commandId) as Adoption|undefined;
    if(prior){if(prior.scope!==input.scope||prior.projectId!==(input.scope==='project'?projectId:null)||prior.candidateId!==input.candidateId||prior.contentHash!==(input.expectedHash??null))
      conflict('同一命令不能用于不同本地采用决定');return prior;}
    if(token(db,projectId)!==input.expectedToken)conflict('本地维护状态已变化，请刷新后重新选择');
    let contentHash:string|null=null,basePackId:string|null=null,baseHash:string|null=null,evaluationId:string|null=null;
    if(input.candidateId){
      const {candidate,evaluation}=validatedLocalCandidate(db,input.candidateId),base=activeBase(config);
      if(candidate.contentHash!==input.expectedHash)conflict('本地修复内容与刚才显示的版本不同，请刷新');
      if(candidate.basePackId!==base.id)conflict('本地修复的基线已不同，请基于当前正式版本重新生成并验证');
      if(input.scope==='local'&&evaluation.suiteId==='managed-pack-smoke')conflict('结构检查不足以设为本机默认；先完成与修复相关的隔离对照验证，可先在本项目制作验证');
      assertNotStopped(db,candidate.id);
      candidateTrialConfig(config,candidate,config.defaultProfile);
      contentHash=candidate.contentHash;basePackId=base.id;baseHash=packTreeHash(base.root).hash;evaluationId=evaluation.id;
    }
    db.prepare(`UPDATE local_pack_adoption SET status='superseded' WHERE scope=? AND project_id IS ? AND status='active'`)
      .run(input.scope,input.scope==='project'?projectId:null);
    const id=randomUUID();
    db.prepare(`INSERT INTO local_pack_adoption(id,scope,project_id,candidate_id,content_hash,base_pack_id,base_hash,evaluation_id,command_id,approved_by,reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.scope,input.scope==='project'?projectId:null,input.candidateId,contentHash,basePackId,baseHash,evaluationId,input.commandId,approvedBy,
        input.candidateId?'用户明确采用已验证的本地版本；仅用于后继制作':'用户回到正式版本；已有工程与运行中版本不改变');
    return localMaintenanceHistory(db,projectId).find(row=>row.id===id)!;
  });
}
