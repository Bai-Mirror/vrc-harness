import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {copyFile as copyFileAsync} from 'node:fs/promises';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LocalConfig } from './config.ts';
import { loadConfig, refreshAssetSearchRoots } from './config.ts';
import { verifiedProjectionChanges } from './archive/projection.ts';
import { canonicalJson } from './pack-hash.ts';
import { resolveExplorationResource } from './asset-exploration.ts';
import { productionContext } from './production-proposals.ts';
import { productionBusinessContext } from './production-version-resume.ts';
import { projectRoot } from './archive/takeover.ts';
import { facePreparationFailureEvidence } from './face-continuation-evidence.ts';
import { localMaintenanceIdentity, localWorkflowSelection } from './local-maintenance.ts';
import { sha256File } from './file-hash.ts';
import { aggregateWorkflow, buildAggregateInput } from './state/aggregate-input.ts';
import { withStateEvent } from './state/tx.ts';
import type { RunResult, RunSpec } from './runtime/interfaces.ts';
import type { Verdict } from './process/types.ts';
import { checkSandboxStatus } from './exec/check-runner.ts';
import { ObservationVerifier } from './workflow/observe.ts';
import { artifactMembers, membersFingerprint } from './workflow/artifacts.ts';
import { toolReferences, manifestToolReferences } from './workflow/capabilities.ts';
import { createWorkflow, verifyTools, workflowSnapshot, type WorkflowSnapshot } from './workflow/runtime.ts';
import { reviewOwnerAlive, type SetupReview } from './setup-review.ts';

function conflict(message: string): never { throw Object.assign(new Error(message), { code: 'CONFLICT' }); }
// Frozen snapshots are JSON: absent optional fields and in-memory undefined fields have the same meaning.
const normalized=(value:unknown)=>JSON.parse(JSON.stringify(value)??'null');
const equal = (a: unknown, b: unknown) => canonicalJson(normalized(a)) === canonicalJson(normalized(b));
const ANCESTORS = ['intake', 'plan', 'environment'];
const KNOWN = ['.vsconfig', '_harness/face/preparation.json'];
function regular(root: string, path: string): string {
  if(lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory())conflict('续接根目录不是普通目录');
  const target = resolve(root, path), rel = relative(resolve(root), target);
  if (isAbsolute(path) || !rel || rel.startsWith('..') || isAbsolute(rel)) conflict('续接记录包含工程外路径');
  let cursor = resolve(root);
  for (const part of rel.split(/[\\/]/)) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) conflict('续接输入包含链接'); }
  if (!lstatSync(target).isFile()) conflict('续接输入不是普通文件');
  return target;
}
function json(file: string): any { return JSON.parse(readFileSync(file, 'utf8')); }
async function asyncHash(file:string):Promise<string>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}

/** Exact stopped-unit facts explain these two outputs; a newly broadened write scope is never retrospective proof. */
export function setupRuntimeChanges(db: DatabaseSync, config: Pick<LocalConfig,'home'>, snapshot: WorkflowSnapshot, project: string,
  runId: string, result: RunResult): Array<{path: string; sha256: string}> {
  const paths = [...new Set(result.outOfBoundsPaths ?? [])].sort();
  if (paths.some(path => !KNOWN.includes(path))) conflict('旧工程准备还有无法核对的改动，不能自动续接');
  const runRoot = join(config.home, 'runs', runId);
  if (!db.prepare("SELECT 1 FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='run' AND entity_id=? AND action='unity_unit_intended'")
    .get(snapshot.workflowId, runId)) conflict('旧工程准备没有受管 Unity 来源');
  if (!db.prepare("SELECT 1 FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='run' AND entity_id=? AND action='prepare_unit_intended'")
    .get(snapshot.workflowId,runId))conflict('旧工程准备没有受管前置执行来源');
  const preparation=json(regular(runRoot,'prepare.json'));
  if(preparation.status!=='finished'||preparation.result?.exitStatus!==0||preparation.result?.errorClass||
    preparation.result?.externalChanges?.length||preparation.result?.outOfBoundsPaths?.length||
    result.prepare?.status!=='finished'||result.prepare.exitStatus!==0||result.prepare.errorClass||result.prepare.outOfBoundsPaths?.length)
    conflict('旧工程前置准备结果无法确认');
  const provider = json(regular(runRoot, 'unity-provider-result.json')) as RunResult;
  if (provider.exitStatus!==0 || provider.errorClass || (provider.outOfBoundsPaths?.length ?? 0) || provider.externalChanges?.length ||
      provider.scanEvidence?.some(entry => paths.includes(entry.path))) conflict('不能把执行方先前的修改归给 Unity');
  const input = json(regular(runRoot, `unity-${runId}/unity-input.json`));
  const expectedSteps=snapshot.capabilities.stages.setup!.unitySteps;
  if (resolve(input.project) !== resolve(project) || resolve(input.runDir) !== resolve(runRoot) || !expectedSteps ||
      input.steps?.length!==expectedSteps.length || input.steps.some((step:any,index:number)=>{
        const expected=expectedSteps[index]!;
        const {env:_,...actualStep}=step,{env:expectedEnv,...expectedStep}=expected;
        return !equal(actualStep,expectedStep) || Object.entries(expectedEnv??{}).some(([key,value])=>step.env?.[key]!==value) ||
          step.env?.AVH_STAGE!=='setup' ||
          !equal(JSON.parse(step.env?.AVH_PLAN??'null'),buildAggregateInput(db,snapshot.workflowId).plan) ||
          !equal(JSON.parse(step.env?.AVH_MANIFEST??'null'),snapshot.manifest);
      })) conflict('Unity 作业与旧工程准备不一致');
  const journal = json(regular(runRoot, 'unity-steps.json'));
  if (journal.status !== 'finished' || !Array.isArray(journal.evidence) || !journal.evidence.length ||
      !equal(journal.evidence, result.unitySteps) || journal.evidence[0].method !== 'AVH.Harness.SetupStage.Run' ||
      !Number.isInteger(journal.evidence[0].exitCode)) conflict('旧 Unity 执行结果无法确认');
  const refs = ['harness/unity/Editor/FaceStage.cs', 'harness/unity/Editor/SetupStage.cs', 'harness/unity/Editor/AvhCommon.cs'];
  // Older Workflows froze hashes while their toolRoot could remain a mutable checkout. The installed exact old
  // bytes are the source used by that stopped Unity unit; never substitute the new checkout's source for them.
  for (const path of refs) if (!/^[a-f0-9]{64}$/.test(snapshot.tools[path]??'') ||
      sha256File(regular(project, `Assets/_HarnessTools/Editor/${path.split('/').at(-1)}`)) !== snapshot.tools[path])
    conflict('工程准备的受管源码已变化');
  const facts = paths.map(path => {
    const file = regular(project, path), sha256 = sha256File(file);
    const evidence = result.scanEvidence?.filter(entry => entry.path === path);
    if (!evidence?.length || evidence.some(entry => entry.sha256 !== sha256 || entry.hashStatus))
      conflict('工程准备记录之后文件已变化，不能自动续接');
    if (path === '.vsconfig') {
      const value = json(file);
      if (!equal(Object.keys(value).sort(), ['components', 'version']) || value.version !== '1.0' ||
          !equal(value.components, ['Microsoft.VisualStudio.Workload.ManagedGame'])) conflict('Unity 环境文件不是已知受管内容');
    } else {
      const value = json(file);
      if (value.schema !== 'face-preparation/0.1' || value.sourcePrefab !== buildAggregateInput(db, snapshot.workflowId).plan.body_prefab ||
          value.scope !== 'Runtime isolated work project; source model bytes preserved' || !Array.isArray(value.models) || !value.models.length)
        conflict('脸型源准备记录无法核对');
      regular(project, value.sourcePrefab);
      const seen = new Set<string>();
      for (const model of value.models) {
        const before = model.sourceBefore, after = model.sourceAfter;
        if (!before || !after || model.readable !== true || typeof after.path !== 'string' || !after.path.startsWith('Assets/') ||
            !after.path.toLowerCase().endsWith('.fbx') || before.path !== after.path || before.sha256 !== after.sha256 || seen.has(after.path))
          conflict('脸型源准备的模型身份无法核对');
        seen.add(after.path);
        if (sha256File(regular(project, after.path)) !== after.sha256 || sha256File(regular(project, `${after.path}.meta`)) !== after.metaSha256 ||
            !/^\s*isReadable:\s*1\s*$/m.test(readFileSync(regular(project, `${after.path}.meta`), 'utf8')))
          conflict('准备后的源模型或导入配置已变化');
      }
    }
    return { path, sha256 };
  });
  return facts;
}

/** The GUI may offer source-backed review; it still does not authorize a replay or claim that migration is complete. */
function setupFailureCanBeReviewed(db:DatabaseSync,snapshot:WorkflowSnapshot,project:string,result:RunResult,
  stopped?:{taskId:string;runId:string;status:string}):boolean {
  if(!Number.isInteger(result.exitStatus))return false;
  if(stopped?.status==='BLOCKED' && !validationBlockIsCurrent(db,snapshot,project,result,stopped))return false;
  if(result.errorClass)return stopped?.status!=='BLOCKED';
  const steps=snapshot.capabilities.stages.setup?.unitySteps;
  if(result.exitStatus!==0||result.outOfBoundsPaths?.length||result.externalChanges?.length||!steps?.length||
    result.unitySteps?.length!==steps.length||result.unitySteps.some((step,index)=>step.method!==steps[index]!.method||
      step.exitCode!==0||step.timedOut||step.status==='not_started'))return false;
  if(db.prepare("SELECT 1 FROM stage_completion WHERE workflow_id=? AND stage_id='setup'").get(snapshot.workflowId))return false;
  return snapshot.definition.stages.find(stage=>stage.id==='setup')!.requires.some(id=>{
    const check=snapshot.definition.checks.find(check=>check.id===id);
    if(!check||check.severity!=='blocking')return false;
    const spec=snapshot.capabilities.artifacts[check.on];if(!spec)return false;
    const hash=membersFingerprint(artifactMembers(project,spec));if(!hash)return false;
    const latest=db.prepare('SELECT result,artifact_hash FROM verdict WHERE workflow_id=? AND check_id=? AND scope=? ORDER BY rowid DESC LIMIT 1')
      .get(snapshot.workflowId,id,check.scope);
    return (latest?.result==='violation'||stopped?.status==='BLOCKED'&&latest?.result==='error')&&latest.artifact_hash===hash;
  });
}

/** BLOCKED is reviewable only for this stopped Run's independently recorded, current validation failure. */
function validationBlockIsCurrent(db:DatabaseSync,snapshot:WorkflowSnapshot,project:string,result:RunResult,
  stopped:{taskId:string;runId:string;status:string}):boolean {
  if(result.exitStatus!==0||result.errorClass||result.outOfBoundsPaths?.length||result.externalChanges?.length)return false;
  if(db.prepare("SELECT 1 FROM out_of_bounds_change WHERE workflow_id=? AND accepted=0").get(snapshot.workflowId)||
    db.prepare("SELECT 1 FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=? AND r.status NOT IN ('exited','cancelled','abandoned')").get(snapshot.workflowId)||
    db.prepare('SELECT 1 FROM lock l JOIN run r ON r.id=l.run_id JOIN task t ON t.id=r.task_id WHERE t.workflow_id=?').get(snapshot.workflowId)||
    db.prepare("SELECT 1 FROM stage_completion WHERE workflow_id=? AND stage_id NOT IN ('intake','plan','environment')").get(snapshot.workflowId)||
    db.prepare("SELECT 1 FROM task WHERE workflow_id=? AND stage_id NOT IN ('intake','plan','environment','setup')").get(snapshot.workflowId))return false;
  const transition=db.prepare("SELECT seq,actor,action,payload_json FROM event WHERE workflow_id=? AND entity_type='task' AND entity_id=? AND action LIKE '%->%' ORDER BY seq DESC LIMIT 1")
    .get(snapshot.workflowId,stopped.taskId);
  if(transition?.actor!=='runtime'||transition.action!=='VERIFYING->BLOCKED'||JSON.parse(String(transition.payload_json)).proof!=='check_failed')return false;
  const verified=db.prepare("SELECT seq FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='run' AND entity_id=? AND action='verified' ORDER BY seq DESC LIMIT 1")
    .get(snapshot.workflowId,stopped.runId);
  if(!verified||Number(verified.seq)>=Number(transition.seq))return false;
  const verdictIds=(result as RunResult&{verdictIds?:unknown}).verdictIds;
  if(!Array.isArray(verdictIds)||!verdictIds.length||new Set(verdictIds).size!==verdictIds.length)return false;
  let validationFailure=false;
  for(const id of snapshot.definition.stages.find(stage=>stage.id==='setup')!.requires){
    const check=snapshot.definition.checks.find(check=>check.id===id)!;
    const latest=db.prepare('SELECT id,result,artifact_hash FROM verdict WHERE workflow_id=? AND check_id=? AND scope=? ORDER BY rowid DESC LIMIT 1')
      .get(snapshot.workflowId,id,check.scope);
    if(!latest||latest.id!==`${stopped.runId}:${id}`||!verdictIds.includes(latest.id))return false;
    const recorded=db.prepare("SELECT seq FROM event WHERE workflow_id=? AND actor='verifier' AND entity_type='verdict' AND entity_id=? AND action='recorded' ORDER BY seq DESC LIMIT 1")
      .get(snapshot.workflowId,latest.id);
    if(!recorded||Number(recorded.seq)>=Number(verified.seq))return false;
    if(['violation','error'].includes(String(latest.result))&&check.severity==='blocking'){
      const spec=snapshot.capabilities.artifacts[check.on],hash=spec&&membersFingerprint(artifactMembers(project,spec));
      if(!hash||latest.artifact_hash!==hash)return false;
      validationFailure=true;
    }else if(!['pass','not_applicable'].includes(String(latest.result)))return false;
  }
  const stage=aggregateWorkflow(db,snapshot.workflowId,snapshot.definition).stages.setup;
  if(!validationFailure||stage?.status!=='blocked'||stage.reasonCodes?.some(code=>code!=='check_failed'))return false;
  for(const asset of snapshot.manifest?.assets??[]){
    if(!asset.sha256||lstatSync(asset.item).isSymbolicLink()||!lstatSync(asset.item).isFile()||sha256File(asset.item)!==asset.sha256)return false;
  }
  return Boolean(snapshot.manifest);
}

export function canReviewFailedSetup(db:DatabaseSync,workflowId:string,taskId:string):boolean {
  try {
    const location=String(db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file??'');
    if(!location)return false;
    const run=db.prepare("SELECT r.id,r.status AS run_status,r.result_json,t.status,t.stage_id FROM run r JOIN task t ON t.id=r.task_id WHERE t.id=? AND t.workflow_id=? AND t.stage_id IN ('setup','face_design') AND t.status IN ('FAILED','BLOCKED') ORDER BY r.attempt DESC LIMIT 1").get(taskId,workflowId);
    if(!run?.result_json||run.run_status!=='exited')return false;
    const result=JSON.parse(String(run.result_json)) as RunResult;
    const snapshot=workflowSnapshot(db,workflowId);
    if(run.stage_id==='face_design'){facePreparationFailureEvidence(db,dirname(dirname(location)),snapshot,String(run.id),result);return true;}
    if(!Number.isInteger(result.exitStatus)||result.prepare?.status!=='finished'||result.prepare.exitStatus!==0||result.prepare.errorClass||result.externalChanges?.length)return false;
    if(!db.prepare("SELECT 1 FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='run' AND entity_id=? AND action='unity_unit_intended'").get(workflowId,run.id))return false;
    const project=projectRoot(db,String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflowId)!.project_id));
    if(!setupFailureCanBeReviewed(db,snapshot,project,result,{taskId,runId:String(run.id),status:String(run.status)}))return false;
    setupRuntimeChanges(db,{home:dirname(dirname(location))},snapshot,project,String(run.id),result);
    return true;
  }catch{return false;}
}

/** A new complete snapshot inherits only independently rechecked, byte-identical accepted ancestors. No fake Run exits. */
export async function continueFailedSetup(db: DatabaseSync, config: LocalConfig, snapshot: WorkflowSnapshot,
  input: {projectId: string; id: string; commandId: string; expectedToken: string}, runId: string, result: RunResult,
  assertCurrent: () => void): Promise<{requested: true}> {
  const baseline=config, selection=localWorkflowSelection(db,baseline,input.projectId,snapshot.profile);
  config=selection?.config??baseline;
  const project = projectRoot(db,input.projectId);
  const failedStage=String(db.prepare('SELECT t.stage_id FROM run r JOIN task t ON t.id=r.task_id WHERE r.id=? AND t.workflow_id=?').get(runId,snapshot.workflowId)?.stage_id??'');
  const fromFace=failedStage==='face_design';
  const knownRuntimePaths=fromFace?[]:KNOWN;
  const parent = join(config.home, 'production', 'continuations'); mkdirSync(parent, { recursive: true });
  const lockPath = join(parent, `${input.projectId}.lock`);
  if(existsSync(lockPath)){
    let owner:any;try{owner=json(regular(parent,`${input.projectId}.lock`));}catch{conflict('上次核对的来源尚未确认，原制作保留');}
    if(owner.projectId!==input.projectId||owner.workflowId!==snapshot.workflowId||owner.runId!==runId||
      !Number.isSafeInteger(owner.ownerPid)||owner.ownerPid<=0)conflict('上次核对的来源尚未确认，原制作保留');
    if(reviewOwnerAlive(owner.ownerPid))conflict('Harness 正在核对这次制作，请稍后查看');
    // Reclaim only an owned, stopped review; this is not permission to repeat an old production unit.
    unlinkSync(lockPath);
  }
  let descriptor: number;
  try { descriptor = openSync(lockPath, 'wx', 0o600); } catch { return conflict('Harness 正在核对这次制作，请稍后查看'); }
  writeFileSync(descriptor,JSON.stringify({projectId:input.projectId,workflowId:snapshot.workflowId,runId,commandId:input.commandId,ownerPid:process.pid}));
  const preserved = join(parent, randomUUID()); mkdirSync(preserved);
  const reviewOwner={proposalId:input.id,workflowId:snapshot.workflowId,commandId:input.commandId,ownerPid:process.pid};
  const review=(status:SetupReview['status'],phase?:SetupReview['phase'],error?:string,workflowId=snapshot.workflowId)=>
    withStateEvent(db,{actor:'runtime',workflowId,entityType:'production_proposal',entityId:input.id,action:'setup_review',
      reason:status==='failed'?'恢复核对未通过；原制作与工程保留':'核对原制作并保留可继续的工程',
      payload:{action:'resume',command:input,recovery:{commandId:input.commandId,projectId:input.projectId,workflowId,ownerPid:process.pid,status,phase,...(error?{error}:{})},
        ...(status==='running'?{result:{pending:true}}:status==='succeeded'?{result:{requested:true}}:{})}},()=>{});
  try {
    review('running','preserving');
    const controls=()=>({home:config.home,workspaceRoot:config.workspaceRoot,toolRoot:config.toolRoot,knowledgeRoot:config.knowledgeRoot,
      definitions:config.definitions,capabilities:config.capabilities,thresholds:config.thresholdValues,variables:config.workflowVariables,
      unity:config.unity,providers:config.providers,localSelection:localWorkflowSelection(db,baseline,input.projectId,snapshot.profile)?.adoption??localMaintenanceIdentity(db,input.projectId)});
    const frozenControls=canonicalJson(controls());
    const diskFingerprint=canonicalJson({...loadConfig(config.home),assetSearchRoots:undefined});
    const recorded=JSON.parse(String(db.prepare('SELECT result_json FROM run WHERE id=?').get(runId)!.result_json)) as RunResult;
    // Post-exit archive projections have their own byte-for-byte Runtime receipt; they never explain an original side effect.
    const laterPaths=(result.outOfBoundsPaths??[]).filter(path=>!knownRuntimePaths.includes(path));
    const stopped=db.prepare("SELECT occurred_at FROM event WHERE workflow_id=? AND entity_type='task' AND (action LIKE '%->FAILED' OR action LIKE '%->BLOCKED') ORDER BY seq DESC LIMIT 1").get(snapshot.workflowId);
    const projectionProof=laterPaths.length&&stopped&&!(recorded.outOfBoundsPaths??[]).some(path=>!knownRuntimePaths.includes(path))
      ? verifiedProjectionChanges(db,input.projectId,String(stopped.occurred_at),laterPaths,reviewOwner):undefined;
    if(laterPaths.length&&!projectionProof)conflict('旧工程准备还有无法核对的改动，不能自动续接');
    const managedResult={...result,outOfBoundsPaths:(result.outOfBoundsPaths??[]).filter(path=>knownRuntimePaths.includes(path))};
    const runtimeEvidence=()=>fromFace?facePreparationFailureEvidence(db,config.home,snapshot,runId,managedResult)
      :setupRuntimeChanges(db,config,snapshot,project,runId,managedResult);
    const assertStopped = () => {
      assertCurrent();
      const proposal = db.prepare('SELECT revision,context_json,inputs_json,workflow_id FROM production_proposal WHERE id=? AND project_id=?').get(input.id,input.projectId)!;
      const task = db.prepare('SELECT t.id,t.stage_id,t.status,r.status AS run_status FROM run r JOIN task t ON t.id=r.task_id WHERE r.id=? AND t.workflow_id=? AND r.attempt=(SELECT MAX(attempt) FROM run WHERE task_id=t.id)').get(runId,snapshot.workflowId);
      if (!task || !['setup','face_design'].includes(String(task.stage_id)) || task.stage_id!==failedStage ||
          !['FAILED','BLOCKED'].includes(String(task.status)) || task.run_status !== 'exited' || proposal.workflow_id !== snapshot.workflowId ||
          result.externalChanges?.length ||
          db.prepare("SELECT 1 FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=? AND r.status NOT IN ('exited','cancelled','abandoned')").get(snapshot.workflowId) ||
          db.prepare('SELECT 1 FROM lock l JOIN run r ON r.id=l.run_id JOIN task t ON t.id=r.task_id WHERE t.workflow_id=?').get(snapshot.workflowId))
        conflict('旧工程准备仍有未确认的执行结果');
      if(fromFace)runtimeEvidence();
      else {
        if(!setupFailureCanBeReviewed(db,snapshot,project,recorded,{taskId:String(task.id),runId,status:String(task.status)}) ||
            (task.status==='BLOCKED'&&!setupFailureCanBeReviewed(db,snapshot,project,
              {...managedResult,verdictIds:(recorded as RunResult&{verdictIds?:string[]}).verdictIds} as RunResult,
              {taskId:String(task.id),runId,status:String(task.status)})) ||
            result.prepare?.status !== 'finished' || result.prepare.exitStatus !== 0 || result.prepare.errorClass)
          conflict('旧工程准备仍有未确认的执行结果');
        if (db.prepare("SELECT 1 FROM stage_completion WHERE workflow_id=? AND stage_id NOT IN ('intake','plan','environment')").get(snapshot.workflowId) ||
            db.prepare("SELECT 1 FROM task WHERE workflow_id=? AND stage_id NOT IN ('intake','plan','environment','setup')").get(snapshot.workflowId))
          conflict('已有工程准备后的成果，不能自动换制作版本');
      }
      if (db.prepare('SELECT revision FROM project_session WHERE project_id=?').get(input.projectId)?.revision !== proposal.revision ||
          productionBusinessContext(productionContext(db,input.projectId)) !== productionBusinessContext(String(proposal.context_json))) conflict('原要求或素材上下文已变化');
      const assets = JSON.parse(String(proposal.inputs_json)) as Array<{path:string;sha256:string;resourceId?:string}>;
      if (!snapshot.manifest || assets.length !== snapshot.manifest.assets.length) conflict('原素材输入无法完整核对');
      for (const asset of assets) {
        const frozen = snapshot.manifest.assets.find(value => value.item === asset.path);
        if (!frozen?.sha256 || frozen.sha256 !== asset.sha256 || lstatSync(asset.path).isSymbolicLink() || !lstatSync(asset.path).isFile() || sha256File(asset.path) !== asset.sha256)
          conflict('原素材已变化，不能继续旧方案');
        if (asset.resourceId && resolveExplorationResource(db,refreshAssetSearchRoots(config),input.projectId,asset.resourceId).path !== asset.path)
          conflict('素材目录授权已变化');
      }
    };
    assertStopped();
    const changes = runtimeEvidence();
    const definition = config.definitions[snapshot.profile], capabilities = config.capabilities[snapshot.profile];
    if (!definition || !capabilities || !equal(snapshot.thresholds,config.thresholdValues) || !equal(snapshot.variables,config.workflowVariables))
      conflict('验收标准或工程输入配置已变化，需要重新核对原方案');
    const accepted = aggregateWorkflow(db,snapshot.workflowId,snapshot.definition);
    const oldInput = buildAggregateInput(db,snapshot.workflowId);
    const kinds = new Set<string>();
    for (const id of ANCESTORS) {
      const oldStage = snapshot.definition.stages.find(stage=>stage.id===id), nextStage = definition.stages.find(stage=>stage.id===id);
      if (!oldStage || !equal(oldStage,nextStage) || !equal(snapshot.capabilities.stages[id],capabilities.stages[id]) || accepted.stages[id]?.status !== 'passed')
        conflict('已接受的前序制作合同已变化，不能自动继承');
      const stageCapability=capabilities.stages[id]!;
      verifyTools(config.toolRoot,snapshot.tools,[stageCapability.command??[],stageCapability.prepareCommand??[],stageCapability.otherwiseCommand??[],
        ...Object.values(stageCapability.agentTools??{})].flatMap(toolReferences));
      for (const kind of [...oldStage.produces,...oldStage.invalidated_by]) kinds.add(kind);
      for (const checkId of oldStage.requires) {
        const oldCheck=snapshot.definition.checks.find(check=>check.id===checkId), nextCheck=definition.checks.find(check=>check.id===checkId);
        if (!equal(oldCheck,nextCheck) || !oldCheck || !equal(snapshot.capabilities.observers[oldCheck.observe],capabilities.observers[oldCheck.observe]) ||
            capabilities.observers[oldCheck.observe]?.kind !== 'command') conflict('前序检查不能独立复验，暂不能自动继承');
        verifyTools(config.toolRoot,snapshot.tools,toolReferences((capabilities.observers[oldCheck.observe] as {command:string[]}).command));
      }
      for (const gateId of oldStage.gates) if (!equal(snapshot.definition.gates.find(gate=>gate.id===gateId),definition.gates.find(gate=>gate.id===gateId)))
        conflict('已接受的用户决定含义已变化');
      for (const ref of capabilities.stages[id]!.context) if (sha256File(regular(config.knowledgeRoot,ref.path)) !== snapshot.contexts[ref.path]?.sha256)
        conflict('前序制作知识已变化');
    }
    const currentHashes = (): Record<string,string> => Object.fromEntries([...kinds].map(kind => {
      if (!equal(snapshot.capabilities.artifacts[kind],capabilities.artifacts[kind])) conflict('前序产物合同已变化');
      const hash=membersFingerprint(artifactMembers(project,capabilities.artifacts[kind]!));
      if (!hash || hash!==oldInput.artifactHashes[kind]) conflict('已接受的方案或环境产物已变化');
      return [kind,hash];
    }));
    const hashes=currentHashes();
    const gates=db.prepare('SELECT * FROM gate_decision WHERE workflow_id=? ORDER BY seq').all(snapshot.workflowId);
    for (const decision of gates) {
      const gate=snapshot.definition.gates.find(g=>g.id===decision.gate_id);
      if (!gate || !ANCESTORS.some(id=>snapshot.definition.stages.find(s=>s.id===id)!.gates.includes(gate.id)) || decision.artifact_hash!==hashes[gate.binds] ||
          !db.prepare("SELECT 1 FROM event WHERE workflow_id=? AND actor='human' AND entity_type='gate' AND entity_id=? AND action='approved' AND json_extract(payload_json,'$.hash')=?").get(snapshot.workflowId,`${snapshot.workflowId}:${gate.id}`,decision.artifact_hash))
        conflict('原用户决定无法按同一产物版本继承');
    }
    const fullFiles: Array<{path:string;sha256:string}> = [];
    // These are Runtime/Unity caches, not accepted engineering evidence. Never delete the original cache tree.
    const cacheExclusions=['Library','Temp','Logs','Obj','obj','.git'];
    const collect = async (directory:string,copyRoot?:string):Promise<Array<{path:string;sha256:string}>> => {
      const files:Array<{path:string;sha256:string}>=[];
      for(const name of readdirSync(directory).sort()){
      const source=join(directory,name),info=lstatSync(source); if(info.isSymbolicLink())conflict('部分工程含链接，需要先核对');
      const path=relative(project,source).replaceAll('\\','/');
      if(cacheExclusions.includes(path))continue;
      if(info.isDirectory()){files.push(...await collect(source,copyRoot));continue;}
      if(!info.isFile())conflict('部分工程含未知文件类型');
      const sha256=await asyncHash(source);
      if(copyRoot){const target=join(copyRoot,path);mkdirSync(dirname(target),{recursive:true});await copyFileAsync(source,target);if(await asyncHash(target)!==sha256)conflict('部分工程备份校验失败');}
      files.push({path,sha256});
      }
      return files;
    };
    fullFiles.push(...await collect(project));
    // Keep transaction-relevant Git control bytes without copying object caches, logs or hooks.
    const gitControls=['.git/HEAD','.git/config','.git/index','.git/packed-refs'].filter(path=>existsSync(join(project,path)));
    const controlFiles=gitControls.map(path=>({path,sha256:sha256File(regular(project,path))}));
    let projectSnapshotRoot=join(preserved,'project'),reusedFrom:{directory:string;evidenceSha256:string}|undefined;
    for(const name of readdirSync(parent).sort()){
      const directory=join(parent,name);if(directory===preserved||!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink())continue;
      if(!existsSync(join(directory,'evidence.json'))||!existsSync(join(directory,'manifest.json')))continue;
      const prior=json(regular(directory,'evidence.json'));
      if(prior.schema!=='setup-version-continuation/0.1'||prior.runId!==runId||!equal(prior.snapshot,snapshot)||!equal(prior.result,result))continue;
      if(!equal(prior.files,fullFiles)||!equal(prior.controlFiles,controlFiles)||!equal(prior.changes,changes)||!equal(json(regular(directory,'manifest.json')),snapshot.manifest))
        conflict('已有完整工程备份与当前工程不一致，需要核对新的变化；原备份不会覆盖或重复复制');
      const backup=prior.projectSnapshotRoot??join(directory,'project');
      if(typeof backup!=='string'||relative(parent,resolve(backup)).startsWith('..')||isAbsolute(relative(parent,resolve(backup))))conflict('旧工程备份不在受管目录');
      for(const file of [...fullFiles,...controlFiles])if(await asyncHash(regular(backup,file.path))!==file.sha256)conflict('旧工程备份字节已变化，不能复用');
      projectSnapshotRoot=backup;reusedFrom={directory,evidenceSha256:await asyncHash(regular(directory,'evidence.json'))};break;
    }
    if(!reusedFrom){
      const copied=await collect(project,projectSnapshotRoot);if(!equal(copied,fullFiles))conflict('保存期间工程又有变化');
      for(const file of controlFiles){const target=join(projectSnapshotRoot,file.path);mkdirSync(dirname(target),{recursive:true});await copyFileAsync(regular(project,file.path),target);
        if(await asyncHash(target)!==file.sha256)conflict('工程控制记录备份校验失败');}
    }
    if(!checkSandboxStatus().available)conflict('无法保护原工程进行独立复验，暂不能自动续接');
    const tools=Object.fromEntries(manifestToolReferences(capabilities).map(path=>[path,sha256File(regular(config.toolRoot,path))]));
    const verifyId=`setup-continuation-${randomUUID()}`;
    const verifier=new ObservationVerifier({definition,observers:capabilities.observers,thresholds:config.thresholdValues,project,toolRoot:config.toolRoot,
      runRoot:join(config.home,'runs'),harnessHome:config.home,manifest:snapshot.manifest,variables:snapshot.variables,plan:()=>oldInput.plan,
      verifyTool:argv=>verifyTools(config.toolRoot,tools,toolReferences(argv))});
    const verdicts:Verdict[]=[];
    review('running','observing');
    for(const id of ANCESTORS){
      const spec:RunSpec={runId:`${verifyId}-${id}`,taskId:'continuation-observation',workflowId:snapshot.workflowId,projectId:input.projectId,stageId:id,
        attempt:1,idempotencyKey:`${verifyId}-${id}`,expectedOutputs:[]};
      const readings=await verifier.verify(spec,{exitStatus:0,outputs:{}},hashes);
      if(readings.some(reading=>!['pass','not_applicable'].includes(reading.result)))conflict('前序成果独立复验未通过，原制作保留');
      verdicts.push(...readings.map(reading=>({...reading,id:`${verifyId}:${id}:${reading.checkId}`})));
    }
    const assertControlsUnchanged=()=>{assertStopped();currentHashes();
      if(!equal(gitControls.map(path=>({path,sha256:sha256File(regular(project,path))})),controlFiles))conflict('核对期间工程控制记录已变化');
      if(frozenControls!==canonicalJson(controls()) || diskFingerprint!==canonicalJson({...loadConfig(config.home),assetSearchRoots:undefined}))conflict('核对期间制作配置已变化');
      if(projectionProof&&!equal(verifiedProjectionChanges(db,input.projectId,projectionProof.after,projectionProof.paths,reviewOwner),projectionProof))conflict('后续档案投影已变化');
      if(!equal(runtimeEvidence(),changes))conflict('工程准备核对证据已变化');
      verifyTools(config.toolRoot,tools,Object.keys(tools));};
    if(!equal(await collect(project),fullFiles))conflict('核对期间工程又有变化');
    if(reusedFrom){
      if(await asyncHash(regular(reusedFrom.directory,'evidence.json'))!==reusedFrom.evidenceSha256)conflict('旧工程备份记录已变化');
      for(const file of [...fullFiles,...controlFiles])if(await asyncHash(regular(projectSnapshotRoot,file.path))!==file.sha256)conflict('核对期间旧工程备份又有变化');
      if(!equal(await collect(project),fullFiles))conflict('核对期间工程又有变化');
    }
    assertControlsUnchanged();
    writeFileSync(join(preserved,'evidence.json'),JSON.stringify({schema:'setup-version-continuation/0.1',snapshot,runId,result,restartStage:'setup',failedStage,localSelection:selection?.adoption??localMaintenanceIdentity(db,input.projectId),files:fullFiles,controlFiles,cacheExclusions,changes,projectionProof,gates,verdicts,projectSnapshotRoot,reusedFrom},null,2),{flag:'wx'});
    const manifestFile=join(preserved,'manifest.json');writeFileSync(manifestFile,JSON.stringify(snapshot.manifest),{flag:'wx'});
    review('running','committing');
    const response=withStateEvent(db,{actor:'human',workflowId:snapshot.workflowId,entityType:'production_proposal',entityId:input.id,action:'resume_requested',
      reason:'已核对工程准备结果；保留原方案继续',payload:{action:'resume',command:input,result:{requested:true}}},()=>{
      assertControlsUnchanged();
      db.prepare("UPDATE workflow SET status='cancelled' WHERE id=? AND status='active'").run(snapshot.workflowId);
      const workflowId=createWorkflow(db,baseline,project,snapshot.profile,manifestFile);
      for(const [kind,hash] of Object.entries(hashes))db.prepare('INSERT INTO artifact_version(workflow_id,kind,hash) VALUES(?,?,?)').run(workflowId,kind,hash);
      db.prepare('INSERT INTO plan_revision(workflow_id,hash,content_json,error) VALUES(?,?,?,NULL)').run(workflowId,hashes.plan!,JSON.stringify(oldInput.plan));
      db.prepare('UPDATE workflow SET plan_json=? WHERE id=?').run(JSON.stringify(oldInput.plan),workflowId);
      for(const reading of verdicts)db.prepare('INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result,basis) VALUES(?,?,?,?,?,?,?)')
        .run(reading.id,workflowId,reading.checkId,reading.scope,reading.artifactHash,reading.result,reading.basis??null);
      for(const decision of gates)withStateEvent(db,{actor:'runtime',workflowId,entityType:'gate',entityId:`${workflowId}:${decision.gate_id}`,action:'inherited',
        reason:'同一产物与未变决定语义继承原用户决定',payload:{previousWorkflow:snapshot.workflowId,previousDecisionSeq:decision.seq,artifactHash:decision.artifact_hash}},()=>
        db.prepare('INSERT INTO gate_decision(workflow_id,gate_id,artifact_hash,result,selection_json) VALUES(?,?,?,?,?)')
          .run(workflowId,decision.gate_id,decision.artifact_hash,decision.result,decision.selection_json??null));
      for(const id of ANCESTORS)withStateEvent(db,{actor:'runtime',workflowId,entityType:'stage_completion',entityId:id,action:'inherited_after_reverification',
        reason:'原成果保持不变且独立复验通过；没有新制作执行',payload:{previousWorkflow:snapshot.workflowId,previousCompletion:
          db.prepare('SELECT seq,run_id FROM stage_completion WHERE workflow_id=? AND stage_id=? ORDER BY seq DESC LIMIT 1').get(snapshot.workflowId,id),verifyId}},()=>
        db.prepare('INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json,run_id) VALUES(?,?,?,NULL)')
          .run(workflowId,id,JSON.stringify(Object.fromEntries(definition.stages.find(stage=>stage.id===id)!.invalidated_by.map(kind=>[kind,hashes[kind]])))));
      if(ANCESTORS.some(id=>aggregateWorkflow(db,workflowId,definition).stages[id]?.status!=='passed'))conflict('复验结果未形成可续接的前序状态');
      db.prepare("UPDATE production_proposal SET workflow_id=?,status='working' WHERE id=? AND workflow_id=?").run(workflowId,input.id,snapshot.workflowId);
      withStateEvent(db,{actor:'runtime',workflowId,entityType:'production_proposal',entityId:input.id,action:'setup_version_continued',reason:'新完整制作版本从工程准备接续',
        payload:{previousWorkflow:snapshot.workflowId,workflowId,preserved,runId,changes,verifyId,restartStage:'setup',failedStage,localSelection:selection?.adoption??localMaintenanceIdentity(db,input.projectId)}},()=>{});
      review('succeeded',undefined,undefined,workflowId);
      return {requested:true};
    });
    return response as {requested:true};
  } catch(error){
    const reason=String(error instanceof Error?error.message:error).slice(0,1000);
    writeFileSync(join(preserved,'failure.json'),JSON.stringify({command:input,runId,error:reason}),{flag:'wx'});
    review('failed',undefined,reason);
    throw error;
  } finally {closeSync(descriptor);unlinkSync(lockPath);}
}
