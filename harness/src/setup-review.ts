import type {DatabaseSync} from 'node:sqlite';

export type SetupReview = {commandId:string;projectId:string;workflowId:string;ownerPid:number;
  status:'running'|'failed'|'succeeded'|'unknown';phase?:'preserving'|'observing'|'committing';error?:string};
export type SetupReviewOwner={proposalId:string;workflowId:string;commandId:string;ownerPid:number};
export function reviewOwnerAlive(pid:number):boolean {
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code==='EPERM';}
}
/** Projection of an existing Runtime event, never a substitute for Run completion or production evidence. */
export function setupReviewStatus(db:DatabaseSync,proposalId:string):SetupReview|undefined {
  const row=db.prepare("SELECT e.workflow_id,e.payload_json,p.project_id,p.workflow_id AS current_workflow FROM event e JOIN production_proposal p ON p.id=e.entity_id WHERE e.actor='runtime' AND e.entity_type='production_proposal' AND e.entity_id=? AND e.action='setup_review' ORDER BY e.seq DESC LIMIT 1").get(proposalId);
  if(!row)return undefined;
  try{
    const payload=JSON.parse(String(row.payload_json)),review=payload.recovery as SetupReview;
    if(payload.action!=='resume'||payload.command?.id!==proposalId||payload.command?.projectId!==row.project_id||
      !review||review.commandId!==payload.command.commandId||review.projectId!==row.project_id||review.workflowId!==row.workflow_id||
      review.workflowId!==row.current_workflow||!Number.isSafeInteger(review.ownerPid)||review.ownerPid<=0||
      !['running','failed','succeeded','unknown'].includes(review.status))return undefined;
    return review.status==='running'&&!reviewOwnerAlive(review.ownerPid)?{...review,status:'unknown',error:'上次核对的进程已退出，尚未确认完成；原制作保留。'}:review;
  }catch{return undefined;}
}
export function isSetupReviewRunning(db:DatabaseSync,projectId:string,exceptOwner?:SetupReviewOwner):boolean {
  return db.prepare('SELECT id FROM production_proposal WHERE project_id=? AND workflow_id IS NOT NULL').all(projectId)
    .some(row=>{
      const review=setupReviewStatus(db,String(row.id));if(review?.status!=='running')return false;
      return !(exceptOwner&&exceptOwner.ownerPid===process.pid&&exceptOwner.proposalId===row.id&&
        exceptOwner.workflowId===review.workflowId&&exceptOwner.commandId===review.commandId&&exceptOwner.ownerPid===review.ownerPid);
    });
}
