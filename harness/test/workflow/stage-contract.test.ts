import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { createHash } from 'node:crypto';
import { withStateEvent } from '../../src/state/tx.ts';
import { loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/state/db.ts';
import { RuntimeService } from '../../src/api/server.ts';
import { ApiClient } from '../../src/api/client.ts';
import { ArtifactFingerprinter, createWorkflow, StageRouter, workflowSnapshot } from '../../src/workflow/runtime.ts';
import { selectedStageContract } from '../../src/workflow/stage-contract.ts';
import { fakeCommand, FAKE_PROVIDER, removeTemp } from '../fixtures/platform.ts';

async function fixture(t:test.TestContext, faceDeployment=false, provider=false) {
  const root=mkdtempSync(join(tmpdir(),'avh-stage-contract-')),home=join(root,'home'),project=join(root,'workspace/sample');
  const old=join(root,'old'),pack=join(home,'managed/packs/update');
  for(const path of [join(home,'config'),join(home,'state'),project,join(old,'knowledge/process'),join(old,'tools'),join(pack,'knowledge/process'),join(pack,'tools')])mkdirSync(path,{recursive:true});
  execFileSync('git',['init','-q',project]);writeFileSync(join(project,'accepted.bin'),'accepted bytes');
  const stage=faceDeployment?'face':'outfit';
  const definition={schema:'process/0.1',id:'fixture',version:'1',applies_to:{},artifacts:['outfit'],
    stages:[{id:stage,needs:[],produces:['outfit'],requires:[],gates:[],invalidated_by:[]}],checks:[],gates:[],milestones:[]};
  const capabilities:any={schema:'capabilities/0.1',process:'fixture',version:'1',artifacts:{outfit:{paths:['_harness/outfit/']}},
    stages:{outfit:{mode:'tool',command:[process.execPath,'{toolRoot}/run.mjs','{project}'],allowedWrites:['_harness/outfit/'],context:[],resources:[],maxRetries:0}},observers:{}};
  const cs=['FaceStage.cs','FaceGeometry.cs','FaceEyes.cs','FaceMapping.cs','AvhCommon.cs','LocalOperations.cs','OutfitStage.cs','SetupStage.cs'];
  const py=['blender_face.py','blender_face_observe.py','blender_face_common.py','blender_face_transfer.py','blender_face_mapping.py'];
  const sources=[...cs.map(name=>'harness/unity/Editor/'+name),...py.map(name=>'harness/'+name)];
  if(faceDeployment) {
    capabilities.stages.face=capabilities.stages.outfit;delete capabilities.stages.outfit;
    capabilities.stages.face.command.push('{toolRoot}/harness/face.py',...sources.map(path=>'{toolRoot}/'+path));
    capabilities.stages.face.unitySteps=[{method:'Fixture.Run',quit:true,timeoutSec:10}];
    capabilities.stages.face.resources=['unity_batch'];
    mkdirSync(join(project,'Assets/_HarnessTools/Editor'),{recursive:true});
  }
  // Both pack shapes must declare which managed tools the stage writes, since a stage that names a helper in
  // its prepare command cannot have them inferred from the command. The replacement below carries them too,
  // as a write only the newer pack declares would read as newly granted authority and be refused.
  const managedTools=cs.map(name=>'Assets/_HarnessTools/Editor/'+name);
  if(faceDeployment) capabilities.stages.face.runtimeWrites=managedTools;
  // A provider stage replaces whichever single stage this fixture describes, so it must follow the stage
  // rename above rather than always writing outfit; doing the latter left a capabilities file describing a
  // stage the definition does not contain, which loadConfig rejects, and that blocked testing anything that
  // needed the provider shape together with frozen compiler tools.
  if(provider) capabilities.stages[stage]={mode:'provider',goal:'fixture',role:'executor',allowedWrites:['_harness/outfit/'],context:[],resources:['unity_batch'],maxRetries:0,prepareCommand:['python3','{toolRoot}/harness/material_dependencies.py'],unitySteps:[{method:'Fixture.Run'}],...(faceDeployment?{runtimeWrites:managedTools}:{})};
  for(const [path,value] of [[old,'old'],[pack,'new']] as const) {
    mkdirSync(join(path,'tools/审查/perception'),{recursive:true});
    for(const name of ['project_fingerprint.py','vpm_baseline_check.py','审查/perception/strip_audit.py'])writeFileSync(join(path,'tools',name),'');
    writeFileSync(join(path,'knowledge/process/fixture.process.yaml'),stringify(definition));
    const cap=structuredClone(capabilities);
    if(faceDeployment) {
      const builtin=fileURLToPath(new URL('../../builtin/tools/harness/',import.meta.url));
      mkdirSync(join(path,'tools/harness/unity/Editor'),{recursive:true});
      for(const name of [...py,'face.py'])copyFileSync(join(builtin,name),join(path,'tools/harness',name));
      for(const name of cs) {
        copyFileSync(join(builtin,'unity/Editor',name),join(path,'tools/harness/unity/Editor',name));
        if(path===old) {
          if(name==='FaceStage.cs')writeFileSync(join(path,'tools/harness/unity/Editor',name),'prior compiler');
          copyFileSync(join(path,'tools/harness/unity/Editor',name),join(project,'Assets/_HarnessTools/Editor',name));
        }
      }
      if(path===pack) {
        cap.stages.face.runtimeWrites=cs.map(name=>'Assets/_HarnessTools/Editor/'+name);
      }
    }
    writeFileSync(join(path,'knowledge/process/fixture.capabilities.yaml'),stringify(cap));
    writeFileSync(join(path,'knowledge/process/thresholds.yaml'),stringify({schema:'thresholds/0.1',version:'1',t:{}}));
    if(provider){mkdirSync(join(path,'tools/harness/unity/Editor'),{recursive:true});writeFileSync(join(path,'tools/harness/material_dependencies.py'),'# fixture');writeFileSync(join(path,'tools/harness/unity/Editor/RecolorStage.cs'),value+' compiler');}
    writeFileSync(join(path,'tools/run.mjs'),`import {mkdirSync,writeFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';${faceDeployment?"execFileSync('python3',[process.argv[3],'contract','--install','--project',process.argv[2],'--sources',...process.argv.slice(4)],{stdio:'pipe'});":""}const p=process.argv[2]+'/_harness/outfit';mkdirSync(p,{recursive:true});writeFileSync(p+'/value.txt',${JSON.stringify(value)});`);
  }
  writeFileSync(join(pack,'pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:'update',channel:'builtin',version:'1',description:'fixture'}));
  const fake=fakeCommand(join(root,'provider'),FAKE_PROVIDER);
  writeFileSync(join(home,'config/harness.yaml'),stringify({workspaceRoot:join(root,'workspace'),toolRoot:join(old,'tools'),knowledgeRoot:join(old,'knowledge'),
    ...(faceDeployment?{unity:{editor:process.execPath,runner:process.execPath,lockPath:join(root,'batch.lock'),busyExitCode:5,homeSeedFrom:[],projectScratch:[],defaultTimeoutSec:10,passEnv:[]}}:{}),
    ...(provider?{unity:{editor:process.execPath}}:{}),exportRoots:[],knownBodies:[],projectAliases:{},sampleNames:['sample'],defaultProfile:'fixture',processDefinitions:{fixture:{definition:'process/fixture.process.yaml',capabilities:'process/fixture.capabilities.yaml'}},thresholdsFile:'process/thresholds.yaml',providers:provider?[{id:'fake',type:'codex-cli',executable:fake,roles:['executor'],writable:[],maxConcurrentRuns:1}]:[]}));
  if(provider){mkdirSync(join(project,'Assets/_HarnessTools/Editor'),{recursive:true});writeFileSync(join(project,'Assets/_HarnessTools/Editor/RecolorStage.cs'),'old compiler');}
  const config=loadConfig(home),db=openDatabase(join(home,'state/harness.db')),id=createWorkflow(db,config,project,'fixture'),snapshot=workflowSnapshot(db,id);
  db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('task',?,?,'fixture','tool','WAITING_HUMAN')").run(id,stage);
  const service=new RuntimeService({home,scheduler:false,pollMs:50});await service.start();const client=await ApiClient.connect(home);
  t.after(async()=>{client.close();await service.stop();db.close();removeTemp(root);});
  const params={id,stageId:stage,packId:'update'};
  const view=()=>client.call<any>('workflow.stageContract.show',params);
  const select=(token:string)=>client.call('workflow.stageContract.select',{...params,expectedToken:token,note:'采用已验证的阶段修复，保留已接受成果。'});
  return {root,home,project,old,pack,config,db,id,snapshot,client,view,select,capabilities,definition};
}

type StageFixture = Awaited<ReturnType<typeof fixture>>;
const hashText = (value:string) => createHash('sha256').update(value).digest('hex');
const adoptionClosed = /本版暂不支持在已冻结的制作流程里更换工具，原因是观察实现的依赖还没有可靠声明（dev\.1\.3 提供），请按 D-59 新开制作流程。/;

function replaceFrozenDefinition(f:StageFixture, definition:unknown, thresholds:unknown, capabilities?:unknown, tools?:unknown):void {
  // Fixture-only insertion of a legacy row; production keeps this table append-only.
  f.db.exec('DROP TRIGGER workflow_definition_no_update');
  try {
    if(capabilities===undefined&&tools===undefined)
      f.db.prepare('UPDATE workflow_definition SET definition_json=?, thresholds_json=? WHERE workflow_id=?')
        .run(JSON.stringify(definition),JSON.stringify(thresholds),f.id);
    else f.db.prepare('UPDATE workflow_definition SET definition_json=?, thresholds_json=?, capabilities_json=?, tools_json=? WHERE workflow_id=?')
      .run(JSON.stringify(definition),JSON.stringify(thresholds),JSON.stringify(capabilities),JSON.stringify(tools),f.id);
  } finally {
    f.db.exec("CREATE TRIGGER workflow_definition_no_update BEFORE UPDATE ON workflow_definition BEGIN SELECT RAISE(ABORT, 'workflow_definition is append-only'); END");
  }
}

/** Use a redacted frozen definition captured from an installed historical pack. */
function historicalDefinition(f:StageFixture): void {
  const frozen=JSON.parse(readFileSync(new URL('../fixtures/stage-contract-historical.definition.json',import.meta.url),'utf8'));
  const thresholdDoc=parse(readFileSync(new URL('../fixtures/stage-contract-historical.thresholds.yaml',import.meta.url),'utf8')) as any;
  const observer=(name:string)=>({kind:'command',command:['python3','{toolRoot}/observe.py','{out}',name],timeoutSec:5});
  const observers=Object.fromEntries([...new Set(frozen.checks.map((check:any)=>String(check.observe)))].map((name:unknown)=>[String(name),observer(String(name))]));
  const capabilities:any={...structuredClone(f.snapshot.capabilities),process:frozen.id,version:frozen.version,observers,
    artifacts:Object.fromEntries(frozen.artifacts.map((kind:string)=>[kind,kind==='face_input'
      ? {paths:[],source:{kind:'runtime',input:'face_input'}} : {paths:['_harness/outfit/']}]))};
  capabilities.stages=Object.fromEntries(frozen.stages.map((stage:any)=>[stage.id,structuredClone(f.snapshot.capabilities.stages.face)]));
  const capabilityYaml=structuredClone(capabilities);
  capabilityYaml.observers=Object.fromEntries(Object.entries(observers).map(([name,entry]:any)=>[name,{command:entry.command,timeoutSec:entry.timeoutSec}]));
  delete capabilityYaml.artifacts.face_input.paths;
  const observerSource='fixture observer';
  writeFileSync(join(f.old,'tools/observe.py'),observerSource);writeFileSync(join(f.pack,'tools/observe.py'),observerSource);
  const tools={...f.snapshot.tools,'observe.py':hashText(observerSource)};
  const candidateText=readFileSync(new URL('../fixtures/stage-contract-historical.process.yaml',import.meta.url),'utf8');
  for (const root of [f.old,f.pack]) {
    writeFileSync(join(root,'knowledge/process/fixture.process.yaml'),candidateText);
    writeFileSync(join(root,'knowledge/process/fixture.capabilities.yaml'),stringify(capabilityYaml));
    writeFileSync(join(root,'knowledge/process/thresholds.yaml'),stringify(thresholdDoc));
  }
  const thresholdValues=Object.fromEntries(Object.entries(thresholdDoc.t).map(([name,entry]:any)=>[name,entry.value]));
  replaceFrozenDefinition(f,frozen,thresholdValues,capabilities,tools);
  f.snapshot.definition=frozen;
  f.snapshot.thresholds=thresholdValues;
  f.snapshot.capabilities=capabilities;
  f.snapshot.tools=tools;
}

function candidateDefinition(f:StageFixture): any {
  return parse(readFileSync(join(f.pack,'knowledge/process/fixture.process.yaml'),'utf8')) as any;
}

test('stage-tool rejects a tool-only change when the frozen definition has the historical loader shape',async t=>{
  const f=await fixture(t,true);historicalDefinition(f);
  const source='harness/unity/Editor/FaceStage.cs';writeFileSync(join(f.pack,'tools',source),'repaired compiler');
  await assert.rejects(f.view(),adoptionClosed);
});

test('stage-tool still rejects threshold, criterion, and new-check changes after semantic normalization',async t=>{
  {
    const f=await fixture(t,true);historicalDefinition(f);
    const thresholds={schema:'thresholds/0.1',version:'1',t:{limit:{value:2,unit:'items',maturity:'accepted',source:'fixture'}}};
    writeFileSync(join(f.pack,'knowledge/process/thresholds.yaml'),stringify(thresholds));
    await assert.rejects(f.view(),/threshold|验收|合同/);
  }
  {
    const f=await fixture(t,true);historicalDefinition(f);const definition=candidateDefinition(f);
    definition.checks[0].rule='face_input_bound == false';
    writeFileSync(join(f.pack,'knowledge/process/fixture.process.yaml'),stringify(definition));
    await assert.rejects(f.view(),/blocking check|验收|合同/);
  }
  {
    const f=await fixture(t,true);historicalDefinition(f);const definition=candidateDefinition(f);
    definition.checks.push({...definition.checks[0],id:'new_check',rule:'count >= 0',severity:'advisory',maturity:'candidate'});
    writeFileSync(join(f.pack,'knowledge/process/fixture.process.yaml'),stringify(definition));
    await assert.rejects(f.view(),/验收|合同/);
  }
});

test('stage-tool rejects an independent observer script hash change',async t=>{
  const f=await fixture(t,true);historicalDefinition(f);
  writeFileSync(join(f.pack,'tools/observe.py'),'changed observer');
  await assert.rejects(f.view(),/独立观测器/);
});

test('formal stopped face stage refuses a changed compiler before deployment',async t=>{
  const f=await fixture(t,true);writeFileSync(join(f.pack,'tools/harness/unity/Editor/FaceStage.cs'),'repaired compiler');
  await assert.rejects(f.view(),adoptionClosed);
});
test('formal stage-update API refuses a changed command tool',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.view(),adoptionClosed);
  await assert.rejects(f.select('old'),adoptionClosed);
  assert.equal(selectedStageContract(f.db,f.snapshot,'outfit').snapshot.toolRoot,join(f.old,'tools'));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM event WHERE workflow_id=? AND entity_type='stage_contract' AND action='selected'").get(f.id)!.n,0);
  f.db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json) VALUES(?,'runtime','run','missing-selection','stage_contract_selected','fixture missing reference',?)").run(f.id,JSON.stringify({selectionSeq:999999}));
  assert.throws(()=>selectedStageContract(f.db,f.snapshot,'outfit','missing-selection'),/选择记录缺失/);
});
test('formal stage-update rejects drift, active execution, accepted stages, changed gates and widened model authority',async t=>{
  const f=await fixture(t);copyFileSync(join(f.old,'tools/run.mjs'),join(f.pack,'tools/run.mjs'));const view=await f.view();
  f.db.prepare("UPDATE task SET status='READY' WHERE id='task'").run();
  await assert.rejects(f.select(view.token),/已变化/);
  f.db.prepare("UPDATE task SET status='RUNNING' WHERE id='task'").run();await assert.rejects(f.view(),/已停止/);
  f.db.prepare("UPDATE task SET status='WAITING_HUMAN' WHERE id='task'").run();
  f.db.prepare("INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json) VALUES(?,'outfit','{}')").run(f.id);
  await assert.rejects(f.view(),/已接受阶段/);f.db.prepare('DELETE FROM stage_completion WHERE workflow_id=?').run(f.id);
  const cap=structuredClone(f.capabilities);cap.stages.outfit.allowedWrites.push('Assets/');writeFileSync(join(f.pack,'knowledge/process/fixture.capabilities.yaml'),stringify(cap));
  await assert.rejects(f.view(),/widen writes/);
  writeFileSync(join(f.pack,'knowledge/process/fixture.capabilities.yaml'),stringify(f.capabilities));
  const definition={...f.definition,gates:[{id:'new-approval',kind:'approve',binds:'outfit'}]};writeFileSync(join(f.pack,'knowledge/process/fixture.process.yaml'),stringify(definition));
  await assert.rejects(f.view(),/change human gates/);
  writeFileSync(join(f.pack,'knowledge/process/fixture.process.yaml'),stringify(f.definition));
  f.db.prepare("INSERT INTO out_of_bounds_change(workflow_id,stage_id,artifact) VALUES(?,'outfit','source')").run(f.id);await assert.rejects(f.view(),/越界改动/);
});

test('formal unstarted stage adoption refuses a changed tool without creating a Run',async t=>{
  const f=await fixture(t);
  f.db.prepare("DELETE FROM task WHERE id='task'").run();
  await assert.rejects(f.view(),adoptionClosed);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM run').get()!.n,0);
});

test('formal unstarted adoption rejects newly created Tasks, accepted stages and active predecessor Runs',async t=>{
  const f=await fixture(t);
  copyFileSync(join(f.old,'tools/run.mjs'),join(f.pack,'tools/run.mjs'));f.db.prepare("DELETE FROM task WHERE id='task'").run();const view={token:'old'};
  f.db.prepare("INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json) VALUES(?,'outfit','{}')").run(f.id);
  await assert.rejects(f.view(),/已接受阶段/);f.db.prepare('DELETE FROM stage_completion WHERE workflow_id=?').run(f.id);
  f.db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('parent',?,'parent','fixture','tool','RUNNING')").run(f.id);
  f.db.prepare("INSERT INTO run(id,task_id,attempt,status) VALUES('parent-run','parent',1,'running')").run();
  await assert.rejects(f.view(),/尚未确认的执行/);
  f.db.prepare("UPDATE run SET status='exited' WHERE id='parent-run'").run();
  f.db.prepare("INSERT INTO out_of_bounds_change(workflow_id,stage_id,artifact) VALUES(?,'parent','source')").run(f.id);
  await assert.rejects(f.view(),/越界改动/);f.db.prepare('DELETE FROM out_of_bounds_change WHERE workflow_id=?').run(f.id);
  f.db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('task',?,'outfit','fixture','tool','READY')").run(f.id);
  await assert.rejects(f.select(view.token),/已变化/);
  f.db.prepare("UPDATE task SET status='RUNNING' WHERE id='task'").run();await assert.rejects(f.view(),/已停止/);
});


test('actual artifact observation projects only exact reviewed compiler versions and detects avatar or unreviewed tool drift',async t=>{
  const f=await fixture(t),target='Assets/_HarnessTools/Editor/LocalOperations.cs',source='harness/unity/Editor/LocalOperations.cs';
  const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
  mkdirSync(join(f.project,'Assets/_HarnessTools/Editor'),{recursive:true});writeFileSync(join(f.project,target),'old source');
  // Seed a stopped Unity workflow's frozen compiler contract and its source-bound human selection.
  const original=structuredClone(f.snapshot);original.tools[source]=sha('old source');
  original.capabilities.artifacts.fbx={paths:[target,'accepted.bin']};
  const observer=new ArtifactFingerprinter(f.db,original,f.project,f.home),baseline=observer.fingerprint(f.id,['fbx']).fbx;
  const selection={snapshot:structuredClone(original),deployment:[{path:target,before:sha('old source'),after:sha('new source')}]};
  withStateEvent(f.db,{workflowId:f.id,actor:'human',entityType:'stage_contract',entityId:'outfit',action:'selected',
    reason:'Fixture reviewed compiler deployment',payload:{selection}},()=>{});
  writeFileSync(join(f.project,target),'new source');
  assert.equal(observer.fingerprint(f.id,['fbx']).fbx,baseline,'reviewed compiler deployment must preserve avatar input identity');
  writeFileSync(join(f.project,target),'unreviewed source');assert.notEqual(observer.fingerprint(f.id,['fbx']).fbx,baseline);
  writeFileSync(join(f.project,target),'new source');writeFileSync(join(f.project,'accepted.bin'),'changed avatar input');
  assert.notEqual(observer.fingerprint(f.id,['fbx']).fbx,baseline,'real avatar edits must remain visible');
});


test('formal adoption refuses a previously implicit compiler change',async t=>{
 const f=await fixture(t,false,true),source='harness/unity/Editor/RecolorStage.cs',target='Assets/_HarnessTools/Editor/RecolorStage.cs';
 assert.equal(f.snapshot.tools[source],undefined);
 const cap=structuredClone(f.capabilities);cap.stages.outfit.prepareCommand.push('{toolRoot}/'+source);cap.stages.outfit.runtimeWrites=[target];
 writeFileSync(join(f.pack,'knowledge/process/fixture.capabilities.yaml'),stringify(cap));
 writeFileSync(join(f.project,target),'unreviewed edit');await assert.rejects(f.view(),/未经核对/);
 writeFileSync(join(f.project,target),'old compiler');await assert.rejects(f.view(),adoptionClosed);
});

test('actual StageRouter supplies freshly revoked source consent only to Runtime prepare and Unity',async t=>{
 const f=await fixture(t,false,true),consent=join(f.home,'config/harness.yaml');
 const originalConfig=readFileSync(consent,'utf8');writeFileSync(consent,originalConfig+'\nassetSearchRoots:\n  - '+JSON.stringify(f.root)+'\n');
 const current=loadConfig(f.home),first=new StageRouter(f.db,current,f.snapshot).router('task').spec;
 assert.deepEqual(JSON.parse(first.prepare!.env.AVH_ASSET_SEARCH_ROOTS_JSON),[f.root]);
 assert.deepEqual(first.unitySteps!.map(s=>JSON.parse(s.env.AVH_ASSET_SEARCH_ROOTS_JSON)),[[f.root]]);
 assert.equal(Object.hasOwn(first,'env'),false);
 writeFileSync(consent,originalConfig+'\nassetSearchRoots: []\n');
 const revoked=new StageRouter(f.db,current,f.snapshot).router('task').spec;
 assert.deepEqual(JSON.parse(revoked.prepare!.env.AVH_ASSET_SEARCH_ROOTS_JSON),[]);
});


test('official stage-tool CLI refuses a changed tool in both show and select',async t=>{
 const f=await fixture(t,false,true),source='harness/unity/Editor/RecolorStage.cs';
 const cap=structuredClone(f.capabilities);cap.stages.outfit.prepareCommand.push('{toolRoot}/'+source);
 cap.stages.outfit.runtimeWrites=['Assets/_HarnessTools/Editor/RecolorStage.cs'];
 writeFileSync(join(f.pack,'knowledge/process/fixture.capabilities.yaml'),stringify(cap));
 const invoke=(args:string[])=>execFileSync(process.execPath,['--input-type=module','-e',`import {main} from ${JSON.stringify(new URL('../../src/cli.ts',import.meta.url).href)};await main(${JSON.stringify(args)});`],{env:{...process.env,AVH_HOME:f.home},encoding:'utf8',stdio:'pipe'});
 const base=['workflow','stage-tool'];
  assert.throws(()=>invoke([...base,'show',f.id,'--stage','outfit','--pack','update']),adoptionClosed);
  assert.throws(()=>invoke([...base,'select',f.id,'--stage','outfit','--pack','update','--expect-token','old','--note','采用已验证修复']),adoptionClosed);
  assert.equal(selectedStageContract(f.db,f.snapshot,'outfit').snapshot.toolRoot,join(f.old,'tools'));
 assert.equal(readFileSync(join(f.project,'accepted.bin'),'utf8'),'accepted bytes');
});


test('formal re-adoption after cancellation remains closed for changed tools',async t=>{
 const f=await fixture(t,false,true),source='harness/unity/Editor/RecolorStage.cs',target='Assets/_HarnessTools/Editor/RecolorStage.cs';
 const cap=structuredClone(f.capabilities);cap.stages.outfit.prepareCommand.push('{toolRoot}/'+source);cap.stages.outfit.runtimeWrites=[target];
  writeFileSync(join(f.pack,'knowledge/process/fixture.capabilities.yaml'),stringify(cap));await assert.rejects(f.view(),adoptionClosed);
 const second=join(f.home,'managed/packs/update-2');cpSync(f.pack,second,{recursive:true});writeFileSync(join(second,'pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:'update-2',channel:'builtin',version:'2'}));
 writeFileSync(join(second,'tools',source),'newer compiler');f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id='task'").run();
 const params={id:f.id,stageId:'outfit',packId:'update-2'};
 writeFileSync(join(f.project,target),'unreviewed edit');await assert.rejects(f.client.call('workflow.stageContract.show',params),/未经核对/);
  writeFileSync(join(f.project,target),'old compiler');await assert.rejects(f.client.call('workflow.stageContract.show',params),adoptionClosed);
  await assert.rejects(f.client.call('workflow.stageContract.select',{...params,expectedToken:'old',note:'采用取消前未部署阶段的已验证修复'}),adoptionClosed);
});

test('actual input observation retains earlier stage compilers while the latest prepare stays stage-local',async t=>{
 const f=await fixture(t),recolor='Assets/_HarnessTools/Editor/RecolorStage.cs',menu='Assets/_HarnessTools/Editor/MenuStage.cs';
 const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
 mkdirSync(join(f.project,'Assets/_HarnessTools/Editor'),{recursive:true});writeFileSync(join(f.project,recolor),'old recolor');writeFileSync(join(f.project,menu),'old menu');
 const original=structuredClone(f.snapshot);original.tools['harness/unity/Editor/RecolorStage.cs']=sha('old recolor');original.tools['harness/unity/Editor/MenuStage.cs']=sha('old menu');
 original.capabilities.artifacts.fbx={paths:[recolor,menu,'accepted.bin']};
 const observer=new ArtifactFingerprinter(f.db,original,f.project,f.home),baseline=observer.fingerprint(f.id,['fbx']).fbx;
 const record=(path:string,before:string,after:string)=>withStateEvent(f.db,{workflowId:f.id,actor:'human',entityType:'stage_contract',entityId:'fixture',action:'selected',reason:'Fixture reviewed source update',payload:{selection:{snapshot:original,deployment:[{path,before:sha(before),after:sha(after)}]}}},()=>{});
 record(recolor,'old recolor','new recolor');writeFileSync(join(f.project,recolor),'new recolor');
 record(menu,'old menu','new menu');writeFileSync(join(f.project,menu),'new menu');
 assert.deepEqual(selectedStageContract(f.db,original,'').deployment.map(x=>x.path),[menu],'Runtime prepare must not inherit unrelated stage write authority');
 assert.equal(observer.fingerprint(f.id,['fbx']).fbx,baseline,'A later stage selection lost an earlier accepted compiler projection');
 writeFileSync(join(f.project,recolor),'unreviewed recolor');assert.notEqual(observer.fingerprint(f.id,['fbx']).fbx,baseline);
 writeFileSync(join(f.project,recolor),'new recolor');record(recolor,'new recolor','newer recolor');writeFileSync(join(f.project,recolor),'newer recolor');
 assert.equal(observer.fingerprint(f.id,['fbx']).fbx,baseline);
 record(recolor,'newer recolor','newest recolor');writeFileSync(join(f.project,recolor),'new recolor');assert.notEqual(observer.fingerprint(f.id,['fbx']).fbx,baseline,'Earlier history must not override a newer per-path selection');
});
