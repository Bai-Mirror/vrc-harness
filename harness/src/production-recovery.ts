import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LocalConfig } from './config.ts';
import { cancel as cancelTask, taskRedo } from './task-cli.ts';
import { cancelWorkflow, StageRouter, workflowSnapshot } from './workflow/runtime.ts';
import { withStateEvent } from './state/tx.ts';
import type { RunResult } from './runtime/interfaces.ts';
import { verifiedProjectionChanges } from './archive/projection.ts';
import { productionVersionChanged, resumeEarlyProductionVersion } from './production-version-resume.ts';
import { canReviewFailedSetup, continueFailedSetup } from './setup-continuation.ts';
import { localMaintenanceIdentity, localWorkflowSelection } from './local-maintenance.ts';
import { setupReviewStatus } from './setup-review.ts';
import { piRunConnectionProgress } from './providers/pi.ts';
import { join } from 'node:path';

type Proposal = { id: string; project_id: string; revision: number; status: string; workflow_id: string | null };
type Task = { id: string; stage_id: string; status: string };
function conflict(message: string): never { throw Object.assign(new Error(message), { code: 'CONFLICT' }); }
function proposal(db: DatabaseSync, projectId: string, id: string): Proposal {
  const row = db.prepare('SELECT * FROM production_proposal WHERE id=? AND project_id=?').get(id,projectId) as Proposal|undefined;
  if (!row?.workflow_id) conflict('这次制作尚未开始或不属于当前项目');
  return row;
}
function latestTasks(db: DatabaseSync, workflowId: string): Task[] {
  return db.prepare(`SELECT id,stage_id,status FROM task t WHERE workflow_id=? AND rowid=(
    SELECT MAX(rowid) FROM task WHERE workflow_id=t.workflow_id AND stage_id=t.stage_id) ORDER BY rowid`).all(workflowId) as Task[];
}
/** A projection of existing facts, never another authoritative lifecycle or success claim. */
export function productionProgress(db: DatabaseSync, row: Proposal, home?: string) {
  if (!row.workflow_id) return undefined;
  const workflow = db.prepare('SELECT status FROM workflow WHERE id=?').get(row.workflow_id)!;
  const tasks = latestTasks(db,row.workflow_id);
  const runs = db.prepare(`SELECT r.id,r.status,r.result_json FROM run r JOIN task t ON t.id=r.task_id
    WHERE t.workflow_id=? ORDER BY r.rowid`).all(row.workflow_id);
  const locks = db.prepare(`SELECT l.resource FROM lock l JOIN run r ON r.id=l.run_id JOIN task t ON t.id=r.task_id
    WHERE t.workflow_id=? ORDER BY l.resource`).all(row.workflow_id);
  const unresolved = db.prepare('SELECT seq FROM out_of_bounds_change WHERE workflow_id=? AND accepted=0').all(row.workflow_id);
  const recoveryTask = tasks.find(t=>t.status==='RECOVERY_REQUIRED');
  const failed = tasks.find(t=>['FAILED','CANCELLED','BLOCKED'].includes(t.status));
  const live = runs.some(r=>!['exited','abandoned','cancelled'].includes(String(r.status))) || locks.length>0;
  const stopped = recoveryTask ?? failed;
  const pendingCancel = db.prepare(`SELECT action FROM event WHERE entity_type='production_proposal' AND entity_id=?
    AND action IN ('cancel_requested','cancel_finished') ORDER BY seq DESC LIMIT 1`).get(row.id)?.action==='cancel_requested';
  const pendingRedo = stopped && ['FAILED','CANCELLED'].includes(stopped.status) && db.prepare(`SELECT 1 FROM event WHERE entity_type='task' AND entity_id=?
    AND action='requested_redo' AND seq>(SELECT COALESCE(MAX(seq),0) FROM event WHERE entity_type='task' AND entity_id=?
    AND (action LIKE '%->FAILED' OR action LIKE '%->CANCELLED')) LIMIT 1`).get(stopped.id,stopped.id);
  const state = workflow.status==='cancelled' ? 'cancelled' : workflow.status==='client_verified' ? 'completed'
    : workflow.status==='upload_ready' ? 'ready' : pendingCancel ? 'stopping'
    : pendingRedo ? 'resuming' : stopped ? recoveryTask || live || unresolved.length ? 'recovery_required' : 'interrupted'
    : tasks.some(t=>t.status==='WAITING_HUMAN') ? 'awaiting_decision' : 'working';
  const token=createHash('sha256').update(JSON.stringify({workflow,tasks,runs,locks,unresolved,pendingCancel,pendingRedo,
    localMaintenance:localMaintenanceIdentity(db,row.project_id)})).digest('hex');
  const recovery=setupReviewStatus(db,row.id);
  const failedRun=stopped?db.prepare('SELECT result_json FROM run WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(stopped.id):undefined;
  const failedResult=failedRun?.result_json?JSON.parse(String(failedRun.result_json)) as RunResult:undefined;
  const cause=stopped?.status==='BLOCKED'?'生成结果未通过独立检查':failedResult?.errorClass==='timeout'?
    stopped?.stage_id==='plan'?'方案准备超时':'制作处理超时':failedResult?.errorClass==='network'?'AI 连接中断':
    failedResult?.errorClass==='tool_failure'?'制作工具未完成处理':'这次制作未完成';
  const retrying = state==='working' && home && runs.filter(r=>r.status==='running').some(r=>piRunConnectionProgress(join(home,'runs',String(r.id))).retrying);
  const reason = ({cancelled:'制作已取消，已有素材、要求和证据保留。',completed:'已通过客户端确认。',ready:'已达到待交付状态，仍需客户端实测。',
    stopping:'已请求停止制作，执行是否停止仍待确认；核对前不会重做。',resuming:'已请求继续，Harness 会从未完成的工作接续。',
    recovery_required:'制作已停顿，Harness 需要先核对尚未确认的执行结果；现有成果保留。',
    interrupted:`${cause}，原要求、素材与已有成果仍保留${failedResult?.errorClass==='network'?'，核对后可以继续，无需重新描述要求':''}。`,awaiting_decision:'制作正在等待你的决定，请查看项目中的确认事项。',
    working:retrying?'AI 连接中断，正在退避重试；原要求、素材与已有成果保留，无需重新描述。':'Harness 正在推进制作。'} as Record<string,string>)[state]!;
  const setupReview=['interrupted','recovery_required'].includes(state) && Boolean(stopped) && ['setup','face_design'].includes(stopped?.stage_id??'') && ['FAILED','BLOCKED'].includes(stopped!.status) && !live &&
    canReviewFailedSetup(db,row.workflow_id,stopped!.id);
  return {state:recovery?.status==='running'?'resuming':state,reason:recovery?.status==='running'?'Harness 正在保存已有工程并独立核对原方案，请等待；无需重复要求。':recovery?.status==='failed'?`核对未通过，原制作和工程保留：${recovery.error}`:reason,token,
    ...(retrying?{connectionRetrying:true}:{}),
    ...(recovery?{recovery}:{}),canResume:recovery?.status==='running'?false:['setup','face_design'].includes(stopped?.stage_id??'')?setupReview:state==='interrupted' && Boolean(stopped) && ['FAILED','CANCELLED'].includes(stopped!.status),
    canCancel:!['cancelled','completed'].includes(state),...(stopped?{taskId:stopped.id}:{})};
}
type Command = { projectId: string; id: string; commandId: string; expectedToken: string };
function previous(db: DatabaseSync, input: Command, action: string): Record<string,unknown>|undefined {
  if (!input.commandId || input.commandId.length>200) throw new Error('恢复命令无效');
  const event = db.prepare(`SELECT payload_json FROM event WHERE entity_type='production_proposal'
    AND json_extract(payload_json,'$.command.commandId')=? ORDER BY seq DESC LIMIT 1`).get(input.commandId);
  if (!event) return undefined;
  const stored=JSON.parse(String(event.payload_json));
  if (stored.action!==action || JSON.stringify(stored.command)!==JSON.stringify(input)) conflict('相同恢复命令不能更改内容');
  if(stored.recovery){const review=setupReviewStatus(db,input.id);
    if(review?.commandId===input.commandId&&review.status==='running')return {pending:true};
    if(review?.commandId===input.commandId&&review.status==='unknown')return undefined;
    if(review?.commandId===input.commandId&&review.status==='failed')conflict(review.error??'核对未通过，原制作保留');
  }
  return stored.result ?? {confirmed:false};
}
function assertCurrent(db: DatabaseSync, row: Proposal, input: Command) {
  const current=productionProgress(db,row)!;
  if (current.token!==input.expectedToken) conflict('制作状态已更新，请查看最新进展');
  return current;
}
/** Observe the old execution without dispatching anything; only then authorize the existing formal-stage redo. */
export async function resumeProduction(db: DatabaseSync, config: LocalConfig, input: Command) {
  const old=previous(db,input,'resume'); if(old)return old;
  const row=proposal(db,input.projectId,input.id), initial=assertCurrent(db,row,input);
  if (!initial.canResume || !initial.taskId) conflict('Harness 尚未确认可以安全继续；请查看当前制作状态');
  const revision=db.prepare('SELECT revision FROM project_session WHERE project_id=?').get(input.projectId)?.revision;
  if(revision!==row.revision)conflict('要求已有新修订，需要先处理新的制作方案');
  const run=db.prepare('SELECT id,status,process_ref,result_json FROM run WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(initial.taskId);
  if(!run || run.status!=='exited' || !run.result_json)conflict('旧执行结果还没有确认，不能重做');
  const recorded=JSON.parse(String(run.result_json)) as RunResult;
  const snapshot=workflowSnapshot(db,row.workflow_id!);
  let observed:RunResult|undefined;
  if(run.process_ref) {
    try { observed=await new StageRouter(db,config,snapshot).router(initial.taskId).settledResult({ref:String(run.process_ref)}); }
    catch { observed=undefined; }
  } else if(recorded.noSideEffects===true)observed=recorded;
  if(!observed)conflict('旧执行仍有未确认的结果，Harness 不能直接重做');
  const stoppedTask=db.prepare('SELECT stage_id,status FROM task WHERE id=?').get(initial.taskId)!;
  const effective=localWorkflowSelection(db,config,input.projectId,snapshot.profile)?.config??config;
  if(['setup','face_design'].includes(String(stoppedTask.stage_id)) && ['FAILED','BLOCKED'].includes(String(stoppedTask.status)) && productionVersionChanged(effective,snapshot))
    return continueFailedSetup(db,config,snapshot,input,String(run.id),observed,()=>{assertCurrent(db,row,input);});
  if(stoppedTask.stage_id==='setup'&&stoppedTask.status==='BLOCKED')conflict('这次独立检查需要可核对的新制作版本；原工程和检查证据保留');
  let projectionProof:ReturnType<typeof verifiedProjectionChanges>;
  if(observed.outOfBoundsPaths?.length) {
    const stopped=db.prepare(`SELECT occurred_at FROM event WHERE entity_type='task' AND entity_id=?
      AND (action LIKE '%->FAILED' OR action LIKE '%->CANCELLED') ORDER BY seq DESC LIMIT 1`).get(initial.taskId);
    if(Array.isArray(recorded.outOfBoundsPaths) && recorded.outOfBoundsPaths.length===0 && stopped)
      projectionProof=verifiedProjectionChanges(db,input.projectId,String(stopped.occurred_at),observed.outOfBoundsPaths);
    if(!projectionProof)conflict('旧执行仍有未确认的结果，Harness 不能直接重做');
  }
  const task=db.prepare('SELECT stage_id FROM task WHERE id=?').get(initial.taskId)!;
  const stage=snapshot.definition.stages.find(s=>s.id===task.stage_id);
  if(!stage)conflict('制作阶段记录无法核对，暂不能自动继续');
  const capability=snapshot.capabilities.stages[stage.id]!;
  const outputs=stage.produces.flatMap(kind=>snapshot.capabilities.artifacts[kind]?.paths??[]);
  // A provider may replace unaccepted candidate files, but this is not permission to repeat arbitrary tool effects.
  const candidateOnly=capability.mode==='provider' && !capability.prepareCommand && !capability.unitySteps?.length &&
    capability.allowedWrites.length>0 && capability.allowedWrites.every(path=>outputs.includes(path) ||
      (stage.produces.length===1 && stage.produces[0]==='plan' && path.startsWith('_harness/') &&
        outputs.length>0 && outputs.every(output=>output.startsWith(path.endsWith('/')?path:`${path}/`)))) &&
    !db.prepare('SELECT 1 FROM stage_completion WHERE workflow_id=? AND stage_id=? LIMIT 1').get(row.workflow_id!,stage.id);
  if(observed.noSideEffects!==true && !candidateOnly)conflict('这项制作需要先核对已有修改，暂不能自动重做；已有成果保留');
  const completedWhileObserving=previous(db,input,'resume');if(completedWhileObserving)return completedWhileObserving;
  return withStateEvent(db,{workflowId:row.workflow_id,actor:'human',entityType:'production_proposal',entityId:row.id,
    action:'resume_requested',reason:'从中断处继续制作',payload:{action:'resume',command:input,result:{requested:true}}},()=>{
    assertCurrent(db,row,input);
    if(projectionProof) {
      const checked=verifiedProjectionChanges(db,input.projectId,projectionProof.after,projectionProof.paths);
      if(!checked || checked.manifestSha256!==projectionProof.manifestSha256)conflict('档案投影核对后又有变化，请让 Harness 重新核对');
      withStateEvent(db,{workflowId:row.workflow_id,actor:'runtime',entityType:'run',entityId:String(run.id),
        action:'later_projection_verified',reason:'新变化均为已记录并逐字回读的后续 Runtime 投影，不改变原执行证据',payload:projectionProof},()=>{});
    }
    if(db.prepare('SELECT revision FROM project_session WHERE project_id=?').get(input.projectId)?.revision!==row.revision)
      conflict('要求已更新，不能继续旧制作');
    if (productionVersionChanged(effective, snapshot)) {
      if (stage.id !== 'plan' || !candidateOnly) conflict('制作工具已更新，需要先核对已有成果；暂不能自动重复制作');
      resumeEarlyProductionVersion(db, config, snapshot, row.id, input.projectId);
    } else taskRedo(db,initial.taskId!);
    return {requested:true};
  });
}
/** Stop all execution, including residue of terminal Tasks; keep the Workflow active until stop is confirmed. */
export async function cancelProduction(db: DatabaseSync, config: LocalConfig, input: Command) {
  const old=previous(db,input,'cancel'); if(old?.confirmed===true)return old;
  const row=proposal(db,input.projectId,input.id);
  if(!old)withStateEvent(db,{workflowId:row.workflow_id,actor:'human',entityType:'production_proposal',entityId:row.id,
    action:'cancel_requested',reason:'用户取消这次制作',payload:{action:'cancel',command:input}},()=>{
    if(!assertCurrent(db,row,input).canCancel)conflict('这次制作已经结束');
    db.prepare("UPDATE production_continuation SET state='cancelled' WHERE logical_project_id=? AND state IN ('requested','waiting','preparing','failed')").run(input.projectId);
  });
  const stop=async(id:string):Promise<boolean>=>{
    try {return (await cancelTask(db,config,id)).confirmed;}
    catch(error) {
      withStateEvent(db,{workflowId:row.workflow_id,actor:'runtime',entityType:'production_proposal',entityId:row.id,
        action:'cancel_observation_failed',reason:'旧执行的停止结果无法确认',payload:{action:'cancel',command:input,result:{confirmed:false},
          target:id,error:String(error instanceof Error?error.message:error).slice(0,500)}},()=>{});
      return false;
    }
  };
  const openRuns=db.prepare(`SELECT r.id FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=?
    AND r.status IN ('pending','running') ORDER BY r.rowid`).all(row.workflow_id!);
  for(const run of openRuns)if(!await stop(String(run.id)))return {confirmed:false};
  const openTasks=db.prepare(`SELECT id FROM task WHERE workflow_id=? AND status NOT IN ('PASSED','FAILED','CANCELLED') ORDER BY rowid`).all(row.workflow_id!);
  for(const task of openTasks)if(!await stop(String(task.id)))return {confirmed:false};
  if(db.prepare(`SELECT 1 FROM lock l JOIN run r ON r.id=l.run_id JOIN task t ON t.id=r.task_id
    WHERE t.workflow_id=? LIMIT 1`).get(row.workflow_id!))return {confirmed:false};
  const result=await cancelWorkflow(db,config,row.workflow_id!,'用户取消这次制作');
  if(result.confirmed)withStateEvent(db,{workflowId:row.workflow_id,actor:'human',entityType:'production_proposal',entityId:row.id,
    action:'cancel_finished',reason:'制作执行已确认停止',payload:{action:'cancel',command:input,result:{confirmed:true}}},()=>{});
  return {confirmed:result.confirmed};
}
