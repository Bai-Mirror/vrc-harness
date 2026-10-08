import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { projectRoot } from './archive/takeover.ts';
import { hostArgv } from './host-platform.ts';
import { sha256File } from './file-hash.ts';
import { canonicalJson } from './pack-hash.ts';
import { aggregateWorkflow, buildAggregateInput } from './state/aggregate-input.ts';
import type { RunResult } from './runtime/interfaces.ts';
import { toolReferences } from './workflow/capabilities.ts';
import type { WorkflowSnapshot } from './workflow/runtime.ts';

function conflict(message: string): never { throw Object.assign(new Error(message), { code: 'CONFLICT' }); }
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function regular(root: string, path: string): string {
  const target=resolve(root,path),rel=relative(resolve(root),target);
  if(isAbsolute(path)||!rel||rel.startsWith('..')||isAbsolute(rel)||lstatSync(root).isSymbolicLink())
    conflict('脸型续作证据路径无效');
  let cursor=resolve(root);
  for(const part of rel.split(/[\\/]/)){cursor=join(cursor,part);if(lstatSync(cursor).isSymbolicLink())conflict('脸型续作证据包含链接');}
  if(!lstatSync(target).isFile())conflict('脸型续作证据不是普通文件');
  return target;
}

/** Only a proven failed pre-preview tool unit can reopen setup under a new complete contract. */
export function facePreparationFailureEvidence(db: DatabaseSync, home: string, snapshot: WorkflowSnapshot,
  runId: string, result: RunResult): Array<{path:string;sha256:string}> {
  const run=db.prepare(`SELECT r.status AS run_status,r.result_json,t.id,t.status,t.stage_id,w.project_id FROM run r
    JOIN task t ON t.id=r.task_id JOIN workflow w ON w.id=t.workflow_id WHERE r.id=? AND t.workflow_id=?
    AND r.attempt=(SELECT MAX(attempt) FROM run WHERE task_id=t.id)`).get(runId,snapshot.workflowId);
  if(!run||run.run_status!=='exited'||run.status!=='FAILED'||run.stage_id!=='face_design'||!run.result_json)
    conflict('脸型执行尚未形成可核对的失败记录');
  const recorded=JSON.parse(String(run.result_json)) as RunResult;
  const validFailure=(value:RunResult)=>Number.isInteger(value.exitStatus)&&value.exitStatus>0&&value.errorClass==='tool_failure'&&
    value.prepare?.status==='finished'&&value.prepare.exitStatus===value.exitStatus&&value.prepare.errorClass==='tool_failure'&&
    !value.prepare.outOfBoundsPaths?.length&&!value.outOfBoundsPaths?.length&&!value.externalChanges?.length&&!value.unitySteps?.length;
  if(!validFailure(recorded)||!validFailure(result)||result.exitStatus!==recorded.exitStatus)
    conflict('脸型旧失败不是已核对的受管前置工具失败');
  if(db.prepare(`SELECT 1 FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=? AND r.status NOT IN ('exited','cancelled','abandoned')`).get(snapshot.workflowId)||
    db.prepare('SELECT 1 FROM lock l JOIN run r ON r.id=l.run_id JOIN task t ON t.id=r.task_id WHERE t.workflow_id=?').get(snapshot.workflowId)||
    db.prepare('SELECT 1 FROM out_of_bounds_change WHERE workflow_id=? AND accepted=0').get(snapshot.workflowId))
    conflict('脸型执行仍有未确认的运行、锁或改动');
  if(db.prepare("SELECT 1 FROM task WHERE workflow_id=? AND stage_id NOT IN ('intake','plan','environment','setup','face_design')").get(snapshot.workflowId)||
    db.prepare("SELECT 1 FROM stage_completion WHERE workflow_id=? AND stage_id NOT IN ('intake','plan','environment','setup')").get(snapshot.workflowId)||
    db.prepare("SELECT 1 FROM gate_decision WHERE workflow_id=? AND gate_id IN ('face_choice','face_appearance')").get(snapshot.workflowId))
    conflict('已有脸型选择或后续成果，不能自动返回工程准备');
  if(aggregateWorkflow(db,snapshot.workflowId,snapshot.definition).stages.setup?.status!=='passed')
    conflict('原工程准备成果已经变化，不能自动继承原方案');
  const project=projectRoot(db,String(run.project_id)),runRoot=join(home,'runs',runId),unit=`prepare-${runId}`;
  const read=(path:string)=>JSON.parse(readFileSync(regular(runRoot,path),'utf8'));
  if(!db.prepare("SELECT 1 FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='run' AND entity_id=? AND action='prepare_unit_intended'").get(snapshot.workflowId,runId)||
    db.prepare("SELECT 1 FROM event WHERE workflow_id=? AND entity_type='run' AND entity_id=? AND action='unity_unit_intended'").get(snapshot.workflowId,runId)||
    existsSync(join(runRoot,'unity-steps.json'))||existsSync(join(runRoot,`unity-${runId}`)))
    conflict('脸型前置执行来源或预览执行状态无法确认');
  const preparation=read('prepare.json'),provider=read('unity-provider-result.json'),command=read(`${unit}/command.json`),
    request=read(`${unit}/tool-request.json`),exit=read(`${unit}/exit.json`);
  if(preparation.status!=='finished'||preparation.result?.exitStatus!==recorded.exitStatus||preparation.result?.errorClass!=='tool_failure'||
    preparation.result?.outOfBoundsPaths?.length||preparation.result?.externalChanges?.length||exit.exitStatus!==recorded.exitStatus||exit.exit?.code!==recorded.exitStatus||exit.exit?.cancelled||exit.timedOut||exit.exit?.timedOut||
    provider.exitStatus!==0||provider.errorClass||provider.outOfBoundsPaths?.length||provider.externalChanges?.length)
    conflict('脸型前置失败与实际进程回执不一致');
  const capability=snapshot.capabilities.stages.face_design,toolRoot=command.env?.AVH_TOOL_ROOT;
  if(!capability?.prepareCommand||typeof toolRoot!=='string'||!isAbsolute(toolRoot))conflict('脸型前置工具合同缺失');
  const expected=hostArgv(capability.prepareCommand.map(arg=>arg.replaceAll('{toolRoot}',toolRoot).replaceAll('{project}',project)));
  const input=buildAggregateInput(db,snapshot.workflowId);
  if(command.runner!=='tool'||resolve(command.projectDirectory)!==resolve(project)||resolve(command.runDirectory)!==resolve(runRoot,unit)||
    resolve(command.cwd)!==resolve(runRoot,unit)||command.env?.AVH_STAGE!=='face_design'||
    !equal(JSON.parse(command.env?.AVH_PLAN??'null'),input.plan)||!equal(JSON.parse(command.env?.AVH_MANIFEST??'null'),snapshot.manifest)||
    !equal(command.argv,expected)||!equal(request.argv,expected))conflict('脸型前置工具回执与原方案不一致');
  for(const path of toolReferences(capability.prepareCommand))if(!snapshot.tools[path]||sha256File(regular(toolRoot,path))!==snapshot.tools[path])
    conflict('脸型旧工具来源字节已变化，不能用新工具解释旧失败');
  const expectedWrites=[...capability.allowedWrites,...new Set([...(capability.runtimeWrites??[]),...(capability.runtimeTemporaryWrites??[])])]
    .map(path=>path==='.'?project:resolve(project,path));
  if(!equal(request.allowedWrites,expectedWrites))conflict('脸型前置工具写入边界与旧合同不一致');
  return ['prepare.json','unity-provider-result.json',`${unit}/command.json`,`${unit}/tool-request.json`,`${unit}/exit.json`]
    .map(path=>({path:`run:${path}`,sha256:sha256File(regular(runRoot,path))}));
}
