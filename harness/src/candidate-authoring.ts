import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { stringify } from 'yaml';
import { registerPackCandidate } from './managed-pack-candidate.ts';
import type { ManagedPackInfo } from './managed-pack.ts';

const ID=/^[a-zA-Z0-9._-]+$/,BASE_ID=/^[a-zA-Z0-9._-]+(\+[0-9a-f]{12})?$/;
export interface AuthoringRow {id:string;projectId:string;basePackId:string;candidateId:string;sourceRoot:string;taskId:string|null;
  reason:string;status:'prepared'|'running'|'registered'|'failed'|'cancelled';error:string|null;createdAt:string;updatedAt:string}

function inside(root:string,path:string):boolean{const rel=relative(resolve(root),resolve(path));return rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..');}
function row(value:Record<string,unknown>):AuthoringRow{return{id:String(value.id),projectId:String(value.project_id),basePackId:String(value.base_pack_id),
  candidateId:String(value.candidate_id),sourceRoot:String(value.source_root),taskId:value.task_id as string|null,reason:String(value.reason),
  status:value.status as AuthoringRow['status'],error:value.error as string|null,createdAt:String(value.created_at),updatedAt:String(value.updated_at)};}
export function candidateAuthoringRows(db:DatabaseSync,projectId?:string):AuthoringRow[]{
  const values=(projectId?db.prepare('SELECT * FROM managed_pack_authoring WHERE project_id=? ORDER BY created_at DESC').all(projectId):
    db.prepare('SELECT * FROM managed_pack_authoring ORDER BY created_at DESC').all()) as Record<string,unknown>[];return values.map(row);
}

/** Clone a stable pack into a project-owned draft. The AI never writes managed storage or the active pack. */
export function prepareCandidateAuthoring(db:DatabaseSync,projectId:string,baseRoot:string,basePackId:string,reason:string,
  candidateId=`local-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${randomUUID().slice(0,8)}`):AuthoringRow{
  if(!ID.test(candidateId)||!BASE_ID.test(basePackId))throw new Error('invalid candidate or base pack id');
  const project=db.prepare('SELECT path FROM project WHERE id=?').get(projectId) as {path:string}|undefined;
  if(!project)throw new Error('project not found');if(!reason.trim())throw new Error('authoring reason is required');
  const parent=join(project.path,'_harness','candidate-packs'),target=join(parent,candidateId);
  if(!inside(parent,target)||existsSync(target))throw new Error('candidate draft path already exists or escapes project');
  mkdirSync(parent,{recursive:true});cpSync(baseRoot,target,{recursive:true,errorOnExist:true,force:false});
  const manifestPath=join(target,'pack.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as ManagedPackInfo;
  if(manifest.schema!=='harness-managed-pack/0.1'||manifest.id!==basePackId)throw new Error('base pack manifest does not match selected pack');
  const next={...manifest,id:candidateId,version:`${manifest.version}-candidate.${Date.now()}`,channel:'candidate',
    description:`AI candidate: ${reason.trim().slice(0,200)}`};
  const temporary=`${manifestPath}.next`;writeFileSync(temporary,`${JSON.stringify(next,null,2)}\n`,{mode:0o600});renameSync(temporary,manifestPath);
  const id=randomUUID();db.prepare(`INSERT INTO managed_pack_authoring(id,project_id,base_pack_id,candidate_id,source_root,reason)
    VALUES(?,?,?,?,?,?)`).run(id,projectId,basePackId,candidateId,target,reason.trim());return candidateAuthoringRows(db,projectId).find(item=>item.id===id)!;
}

export function authoringTaskSpec(authoring:AuthoringRow,projectPath:string,cases:unknown[]):string{
  const relativeRoot=relative(projectPath,authoring.sourceRoot).split(sep).join('/'),report=`${relativeRoot}/authoring-report.json`;
  return stringify({schema:'task/0.1',role:'executor',goal:`根据 Harness 提供的结构化成功/失败案例改进候选能力包 ${authoring.candidateId}。\n`+
    `只能编辑 ${relativeRoot}；不得修改当前能力包、正式流程验收标准或权限边界。可以改进知识条目和创建工具，但必须在 authoring-report.json 说明变更、案例依据、权限和风险。\n`+
    `案例：${JSON.stringify(cases)}`,allowedWrites:[`${relativeRoot}/`],expectedOutputs:[report],resources:[],maxRetries:1,
    checks:[{id:'candidate-report',json:report,field:'ready',expect:true}]});
}

export function attachAuthoringTask(db:DatabaseSync,id:string,taskId:string):void{
  const changed=db.prepare(`UPDATE managed_pack_authoring SET task_id=?,status='running',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND status='prepared'`).run(taskId,id);if(!changed.changes)throw new Error('candidate authoring is no longer prepared');
}

/** Register passed drafts automatically; failed Tasks remain inspectable and never enter candidate storage. */
export function reconcileCandidateAuthoring(db:DatabaseSync,home:string):AuthoringRow[]{
  const active=candidateAuthoringRows(db).filter(item=>item.status==='running'&&item.taskId);
  for(const item of active){
    const task=db.prepare('SELECT status FROM task WHERE id=?').get(item.taskId) as {status:string}|undefined;
    if(!task)continue;if(['FAILED','CANCELLED'].includes(task.status)){
      db.prepare(`UPDATE managed_pack_authoring SET status=?,error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(task.status==='CANCELLED'?'cancelled':'failed',`authoring Task ended ${task.status}`,item.id);continue;
    }
    if(task.status!=='PASSED')continue;
    try{registerPackCandidate(db,home,item.sourceRoot,{basePackId:item.basePackId,sourceKind:'ai',sourceRef:item.taskId!,reason:item.reason,
      impact:{authoringId:item.id,projectId:item.projectId},permissions:{network:false,writes:['project','run']}});
      db.prepare(`UPDATE managed_pack_authoring SET status='registered',error=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(item.id);
    }catch(error){db.prepare(`UPDATE managed_pack_authoring SET status='failed',error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(String((error as Error).message).slice(0,2000),item.id);}
  }
  return candidateAuthoringRows(db);
}
