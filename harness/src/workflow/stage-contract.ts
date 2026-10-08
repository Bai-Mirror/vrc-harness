import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LocalConfig } from '../config.ts';
import { canonicalJson, packTreeHash } from '../pack-hash.ts';
import { candidateTrialConfig } from '../managed-pack-candidate.ts';
import { managedPacks } from '../managed-pack.ts';
import { sha256File } from '../file-hash.ts';
import { withStateEvent } from '../state/tx.ts';
import { buildAggregateInput } from '../state/aggregate-input.ts';
import { projectRoot } from '../archive/takeover.ts';
import { manifestToolReferences, stageDeployment, toolReferences } from './capabilities.ts';
import type { WorkflowSnapshot } from './runtime.ts';
import { readRunInputSnapshot } from './inputs.ts';
import { sameProcessDefinition } from '../process/load.ts';

type Selection = { snapshot: WorkflowSnapshot; deployment: Array<{path:string;before:string;after:string;inputSha256?:string}>;selectionSeq?:number };
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (a: unknown, b: unknown) => canonicalJson(JSON.parse(JSON.stringify(a) ?? 'null')) === canonicalJson(JSON.parse(JSON.stringify(b) ?? 'null'));
function conflict(message: string): never { throw Object.assign(new Error(message), { code:'CONFLICT' }); }
/** Selections apply only to future Runs. Historic Runs always retain the contract they actually launched. */
export function selectedStageContract(db: DatabaseSync, snapshot: WorkflowSnapshot, stageId:string, runId?:string): Selection {
  const marker=runId?db.prepare("SELECT payload_json FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='run' AND entity_id=? AND action='stage_contract_selected' ORDER BY seq DESC LIMIT 1").get(snapshot.workflowId,runId):undefined;
  const input=runId?readRunInputSnapshot(db,runId):undefined;
  const selectionSeq=input?input.stageToolSelection.selectionSeq:marker?JSON.parse(String(marker.payload_json)).selectionSeq:undefined;
  const selected = runId
    ? selectionSeq?db.prepare("SELECT seq,payload_json FROM event WHERE seq=? AND workflow_id=? AND actor='human' AND entity_type='stage_contract' AND action='selected'").get(selectionSeq,snapshot.workflowId):undefined
    : db.prepare("SELECT seq,payload_json FROM event WHERE workflow_id=? AND actor='human' AND entity_type='stage_contract' AND action='selected' ORDER BY seq DESC LIMIT 1").get(snapshot.workflowId);
  if (!selected) {
    if (selectionSeq || (!input && marker)) conflict('本次执行引用的阶段工具选择记录缺失');
    return { snapshot, deployment:[] };
  }
  const selection = JSON.parse(String(selected.payload_json)).selection as Selection;
  if (!selection?.snapshot || selection.snapshot.workflowId!==snapshot.workflowId || !Array.isArray(selection.deployment)) conflict('阶段工具选择记录无法核对');
  return {...selection,selectionSeq:Number(selected.seq)};
}
export function recordRunStageContract(db:DatabaseSync, original:WorkflowSnapshot, stageId:string, runId:string):Selection {
  const selection=selectedStageContract(db,original,stageId);
  if(selection.selectionSeq) withStateEvent(db,{workflowId:original.workflowId,actor:'runtime',entityType:'run',entityId:runId,action:'stage_contract_selected',
    reason:'冻结本次执行的阶段工具选择；不改变旧执行合同',payload:{selectionSeq:selection.selectionSeq}},()=>{});
  return selection;
}
/** Managed compiler deployment is a tool version, not changed avatar input. Unknown bytes remain ordinary drift. */
export function projectStageToolInputs(db:DatabaseSync, original:WorkflowSnapshot, members:Map<string,string>):void {
  const deployments = new Map<string, Selection['deployment'][number]>();
  // Stage prepare authority stays local. Input identity also retains reviewed compilers from earlier stages.
  const rows = db.prepare("SELECT payload_json FROM event WHERE workflow_id=? AND actor='human' AND entity_type='stage_contract' AND action='selected' ORDER BY seq").all(original.workflowId);
  for (const row of rows) {
    const selection = JSON.parse(String(row.payload_json)).selection as Selection;
    if (selection?.snapshot?.workflowId !== original.workflowId || !Array.isArray(selection.deployment)) conflict('阶段工具选择记录无法核对');
    for (const update of selection.deployment) deployments.set(update.path, update);
  }
  for(const update of deployments.values()) {
    const source='harness/unity/Editor/'+update.path.slice('Assets/_HarnessTools/Editor/'.length);
    if(!update.path.startsWith('Assets/_HarnessTools/Editor/')) continue;
    const input = original.tools[source] ?? update.inputSha256;
    if (!input) continue;
    const current=members.get(update.path);
    if(current===update.before || current===update.after) members.set(update.path,input);
  }
}
/** Change one stage capability and pin shared compiler sources for future units; accepted checks, gates and model scopes stay frozen. */
export function stageContractView(db:DatabaseSync,config:LocalConfig,original:WorkflowSnapshot,stageId:string,packId:string) {
  const stage=original.definition.stages.find(value=>value.id===stageId);
  if (!stage) conflict('找不到制作阶段');
  const task=db.prepare('SELECT id,status FROM task WHERE workflow_id=? AND stage_id=? ORDER BY rowid DESC LIMIT 1').get(original.workflowId,stageId);
  if (task && !['WAITING_HUMAN','BLOCKED','FAILED','CANCELLED','READY'].includes(String(task.status))) conflict('只能在未开工或已停止且未接受的制作阶段采用修复');
  if (db.prepare("SELECT 1 FROM stage_completion WHERE workflow_id=? AND stage_id=? LIMIT 1").get(original.workflowId,stageId)) conflict('已接受阶段不能用此入口更换工具');
  if (db.prepare("SELECT 1 FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=? AND r.status NOT IN ('exited','cancelled','abandoned') LIMIT 1").get(original.workflowId) ||
      db.prepare('SELECT 1 FROM lock l JOIN run r ON r.id=l.run_id JOIN task t ON t.id=r.task_id WHERE t.workflow_id=? LIMIT 1').get(original.workflowId) ||
      db.prepare('SELECT 1 FROM out_of_bounds_change WHERE workflow_id=? AND accepted=0 LIMIT 1').get(original.workflowId)) conflict('先核对尚未确认的执行或越界改动');
  const pack=managedPacks(config.home).find(value=>value.id===packId);
  if (!pack || pack.channel!=='builtin') conflict('阶段修复必须来自已安装的内置工具版本');
  const next=candidateTrialConfig({...config,definitions:{[original.profile]:original.definition},capabilities:{[original.profile]:original.capabilities},
    thresholdValues:original.thresholds},pack,original.profile);
  if (!sameProcessDefinition(next.definitions[original.profile]!,original.definition) || !same(next.thresholdValues,original.thresholds) ||
      !same(next.capabilities[original.profile]!.observers,original.capabilities.observers) ||
      !same(next.capabilities[original.profile]!.artifacts,original.capabilities.artifacts)) conflict('验收、Gate、观测或产物合同已变化，需要独立续接复验');
  const previous=selectedStageContract(db,original,stageId),capability=next.capabilities[original.profile]!.stages[stageId]!;
  const prior=previous.snapshot.capabilities.stages[stageId]!;
  const executionFields=['mode','providerWhen','otherwiseCommand','command','role','provider','requiredCapabilities','allowedWrites','resources','maxRetries','maxCheckRetries','unitySteps','selectionGate'] as const;
  if (executionFields.some(key=>!same(prior[key],capability[key]))) conflict('此入口不能改变执行方式、模型写权、重试额度或 Unity 作业');
  const projectId=String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(original.workflowId)!.project_id);
  const project=projectRoot(db,projectId);
  for (const parent of [project,join(project,'Assets'),join(project,'Assets/_HarnessTools'),join(project,'Assets/_HarnessTools/Editor')])
    if (existsSync(parent)&&lstatSync(parent).isSymbolicLink()) conflict('受管工具部署目录不能是链接');
  if (existsSync(join(project,'_harness/face/native-import-pending.json'))) conflict('临时导入尚未恢复，不能更换工具');
  // A source is reviewed when its bytes match the original package, the previous snapshot, or a deployment
  // that was already accepted. Each is a distinct authority and none may be dropped.
  const reviewedSource=(path:string)=>{
    const file=join(original.toolRoot,path);
    return original.tools[path] ?? (existsSync(file)&&lstatSync(file).isFile()&&!lstatSync(file).isSymbolicLink()?sha256File(file):undefined);
  };
  const isReviewed=(path:string,target:string,after:string,current:string)=>{
    const prior=previous.deployment.find(value=>value.path===target);
    return [previous.snapshot.tools[path] ?? reviewedSource(path),prior?.before,prior?.after,after].filter(Boolean).includes(current);
  };
  // What this stage deploys comes from one declaration, not from reading its command or from matching file
  // names against runtimeWrites. Both of those were tried and both drifted: a prepare command that named a
  // helper instead of listing sources produced a record missing a source the helper verifies, and matching
  // by base name picked the wrong source when two packs shipped the same file name.
  const deployment=stageDeployment(capability).map(({source,target})=>{
    const file=join(project,target);
    if (!existsSync(file)||lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile()) conflict('已安装的受管工具来源无法核对');
    // Recover only bytes matching the original package, never authority from arbitrary installed edits.
    const after=sha256File(join(pack.root,'tools',source)),current=sha256File(file);
    if (!isReviewed(source,target,after,current)) conflict('受管工具还有未经核对的编辑');
    // A stopped/cancelled unit may not have deployed the earlier selection yet. Bind the actual reviewed bytes.
    return {path:target,before:current,after,inputSha256:reviewedSource(source)};
  });
  const addedWrites=(capability.runtimeWrites??[]).filter(path=>!prior.runtimeWrites?.includes(path));
  if (addedWrites.some(path=>!deployment.some(value=>value.path===path))) conflict('新增 Runtime 写权不属于按 SHA 核对的工具部署');
  for(const observer of Object.values(original.capabilities.observers)) if(observer.kind==='command')
    for(const path of toolReferences(observer.command)) if(sha256File(join(pack.root,'tools',path))!==original.tools[path]) conflict('独立观测器执行代码已变化，需要独立续接复验');
  const snapshot=structuredClone(previous.snapshot);snapshot.toolRoot=join(pack.root,'tools');
  snapshot.capabilities.stages[stageId]=capability;
  for(const item of capability.context) {
    const file=join(pack.root,'knowledge',item.path);snapshot.contexts[item.path]={...snapshot.contexts[item.path],content:readFileSync(file,'utf8'),sha256:sha256File(file)};
  }
  snapshot.tools=Object.fromEntries(manifestToolReferences(snapshot.capabilities).map(path=>[path,sha256File(join(snapshot.toolRoot,path))]));
  const frozenToolPaths=new Set([...Object.keys(original.tools),...Object.keys(snapshot.tools)]);
  const changedFrozenTools=[...frozenToolPaths].filter(path=>original.tools[path]!==snapshot.tools[path]);
  if (changedFrozenTools.length)
    conflict('本版暂不支持在已冻结的制作流程里更换工具，原因是观察实现的依赖还没有可靠声明（dev.1.3 提供），请按 D-59 新开制作流程。');
  const selection={snapshot,deployment},input=buildAggregateInput(db,original.workflowId);
  return {workflowId:original.workflowId,stageId,taskId:task?String(task.id):null,packId,packHash:packTreeHash(pack.root).hash,
    token:digest({selection,input,task}),selection,changedTools:deployment.filter(value=>value.before!==value.after).map(value=>value.path)};
}
export function selectStageContract(db:DatabaseSync,config:LocalConfig,original:WorkflowSnapshot,stageId:string,packId:string,expectedToken:string,note:string) {
  if (!note.trim()) conflict('请说明采用修复的原因');
  const view=stageContractView(db,config,original,stageId,packId);
  if(view.token!==expectedToken)conflict('制作或工具版本已变化，请重新核对');
  withStateEvent(db,{workflowId:original.workflowId,actor:'human',entityType:'stage_contract',entityId:stageId,action:'selected',
    reason:note,payload:{packId,packHash:view.packHash,selection:view.selection,token:view.token}},()=>{});
  return {selected:true,stageId,packId};
}
