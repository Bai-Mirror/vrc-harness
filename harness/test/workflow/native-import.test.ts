import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../src/state/db.ts';
import type { LocalConfig } from '../../src/config.ts';
import { taskScopeSnapshot } from '../../src/task-cli.ts';
import { ArtifactFingerprinter, StageRouter, stageTaskSpec, type WorkflowSnapshot } from '../../src/workflow/runtime.ts';
import { authorizeNativeImport, pendingNativeImport, recoverNativeImport, restoredNativeImportPaths } from '../../src/workflow/native-import.ts';
import { refreshFingerprints } from '../../src/runtime/reconcile.ts';
import { ToolRunner } from '../../src/exec/tool-runner.ts';
import { createRunExecutor } from '../../src/exec/executor.ts';
import { Scheduler } from '../../src/runtime/scheduler.ts';
import { buildAggregateInput } from '../../src/state/aggregate-input.ts';
import { freezeRunInput } from '../../src/workflow/inputs.ts';
import { withStateEvent } from '../../src/state/tx.ts';
import { projectFaceCandidatePreview } from '../../src/face-preview.ts';
import { removeTemp } from '../fixtures/platform.ts';
import { readIfPresent, waitFor, waitUntil } from '../fixtures/wait.ts';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

test('formal deterministic face tool can atomically replace its input and still reports ungranted sibling writes', async t => {
  const f=fixture(t),capability=f.snapshot.capabilities.stages.face!;
  const input='Assets/_Harness/Face/design.json',temporary=input+'.writing',forbidden='Assets/_Harness/Face/ungranted.json';
  f.put(forbidden,'protected sibling');
  capability.allowedWrites=[input];capability.runtimeTemporaryWrites=[temporary];capability.runtimeWrites=['_harness/face/output.json'];
  delete capability.selectionGate;
  const face=fileURLToPath(new URL('../../builtin/tools/harness/face.py',import.meta.url));
  capability.command=['python3','-c',`import runpy,sys\nfrom pathlib import Path\nf=runpy.run_path(sys.argv[1])\nf['write'](Path(sys.argv[2]),{'atomic':'new'},True)\nPath(sys.argv[3]).write_text('escape')`,face,join(f.project,input),join(f.project,forbidden)];
  const stage=f.snapshot.definition.stages[0]!;
  const spec=stageTaskSpec(f.snapshot,stage,{},f.root,f.project);
  assert.ok(spec.allowedWrites.includes(temporary),'the deterministic write consumer receives its frozen atomic temporary path');
  assert.equal(spec.allowedWrites.includes('_harness/face/output.json'),false);
  const runner=new StageRouter(f.db,f.config,f.snapshot);
  const handle=await runner.start({runId:f.runId,taskId:'task',workflowId:'workflow',projectId:'project',stageId:'face',attempt:1,idempotencyKey:f.runId,expectedOutputs:[]});
  f.onStop(()=>runner.cancel(handle));
  f.db.prepare('UPDATE run SET process_ref=? WHERE id=?').run(handle.ref,f.runId);
  await waitFor(async()=>(await runner.observe(handle)).state,
    {what:'the deterministic face tool unit to exit',ready:state=>state==='exited',timeoutMs:120_000,intervalMs:50});
  const result=await runner.collect(handle);
  await runner.cancel(handle);
  assert.equal(result.exitStatus,0,(result.errorMessage??'')+'; '+readFileSync(join(f.runDirectory,'stderr.log'),'utf8'));
  assert.deepEqual(JSON.parse(readFileSync(join(f.project,input),'utf8')),{atomic:'new'});
  assert.equal(existsSync(join(f.project,temporary)),false);
  assert.ok(result.outOfBoundsPaths?.includes(forbidden),'parent mount availability must not exempt a genuine out-of-scope sibling edit');
  capability.mode='provider';delete capability.command;
  assert.deepEqual(stageTaskSpec(f.snapshot,stage,{},f.root,f.project).allowedWrites,[input],'model executor never receives temporary Runtime authority');
});
function fixture(t: test.TestContext, stageId = 'face') {
  const root = mkdtempSync(join(tmpdir(), 'avh-native-import-')), runId='native-'+randomUUID();
  const stops:Array<()=>Promise<unknown>>=[];let closeDb=()=>{};
  t.after(async()=>{for(const stop of stops)await stop();closeDb();removeTemp(root);});
  const project = join(root, 'project'), home = join(root, 'home'), runDirectory = join(home, 'runs', runId);
  mkdirSync(project); mkdirSync(join(home, 'state'), { recursive: true }); mkdirSync(runDirectory, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const put = (path: string, value: any) => { const bytes = typeof value === 'string' ? value : JSON.stringify(value);
    const target = join(project, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); return hash(bytes); };
  const modelPath = 'Assets/Source/model.fbx', candidatePath = 'Assets/_Harness/Face/Candidates/revision/candidate.fbx';
  const originalSha256 = put(modelPath, 'source bytes'), metaSha256 = put(modelPath + '.meta', 'source importer bytes');
  const candidateSha256 = put(candidatePath, 'candidate bytes');
  const observationSha256 = put('_harness/face/observation.json', {schema:'face-unity-observation/0.1',targets:[{targetId:'target',mesh:{path:modelPath,sha256:originalSha256,metaSha256}}]});
  const receiptFile = 'Assets/_Harness/Face/Candidates/revision/candidate.json';
  const receiptSha256 = put(receiptFile, {route:'native-fbx/1',productionAccepted:false,source:{sha256:originalSha256},outputs:{fbx:{file:'candidate.fbx',sha256:candidateSha256}}});
  put('Assets/_Harness/Face/design.json', {route:'native-fbx/1',mode:'design',targetId:'target',observationSha256,candidateReceipt:{file:receiptFile,sha256:receiptSha256}});
  const backup = '_harness/face/native-import/transaction/original.fbx'; put(backup, 'source bytes'); put(backup + '.meta', 'source importer bytes');
  const pending = {schema:'face-native-import-transaction/0.1',modelPath,backup,originalSha256,metaSha256,candidateSha256};
  const db = openDatabase(join(home, 'state', 'harness.db')); closeDb=()=>db.close();
  db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('workspace',root);
  db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('project','workspace','sample',?,'{}','active','test','test')").run(project);
  db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('workflow','project','fixture','hash','test','active','{\"face\":{\"mode\":\"design\"}}')").run();
  const stage = {id:'face',needs:[],produces:['source'],requires:[],gates:[],invalidated_by:[]};
  const definition = {schema:'process/0.1',id:'fixture',version:'1',applies_to:{},artifacts:['source'],stages:[stage],checks:[],gates:[{id:'choice',kind:'choose',binds:'source'}],milestones:[]};
  const capability = {mode:'tool',command:[process.execPath,'-e','setInterval(()=>{},1000)'],allowedWrites:[],context:[],selectionGate:'choice',resources:[],maxRetries:0};
  const capabilities = {schema:'capabilities/0.1',process:'fixture',version:'1',artifacts:{source:{paths:[modelPath]}},stages:{face:capability},observers:{}};
  db.prepare("INSERT INTO workflow_definition(workflow_id,profile,definition_json,capabilities_json,thresholds_json,tools_json,tool_root) VALUES('workflow','fixture',?,?,'{}','{}',?)").run(JSON.stringify(definition),JSON.stringify(capabilities),root);
  db.prepare("INSERT INTO provider_snapshot(workflow_id,snapshot_json) VALUES('workflow','{\"providers\":[]}')").run();
  db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('task','workflow','face','test','test','RUNNING')").run();
  db.prepare("INSERT INTO run(id,task_id,attempt,status) VALUES(?,'task',1,'running')").run(runId);
  const config={home,workspaceRoot:root,toolRoot:root,knowledgeRoot:root,providers:[],scanLimits:{},providerProbeTtlMs:0} as unknown as LocalConfig;
  const snapshot={workflowId:'workflow',profile:'fixture',definition,capabilities,thresholds:{},tools:{},toolRoot:root,contexts:{},variables:{}} as unknown as WorkflowSnapshot;
  const event=()=>db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('workflow','runtime','run',?,'unity_unit_intended','test')").run(runId);
  const swap=()=>{put('_harness/face/native-import-pending.json',pending);put(modelPath,'candidate bytes');};
  if(stageId!=='face') {
    stage.id=stageId;
    (capabilities.stages as Record<string,typeof capability>)[stageId]=capability;
    delete (capabilities.stages as Partial<Record<string,typeof capability>>).face;
    db.prepare("UPDATE task SET stage_id=? WHERE id='task'").run(stageId);
  }
  withStateEvent(db,{workflowId:'workflow',actor:'runtime',entityType:'run',entityId:runId,action:'fixture_input_frozen',reason:'Direct supervised executor fixtures retain their original input'},()=>
    freezeRunInput(db,'workflow',runId,buildAggregateInput(db,'workflow').artifactHashes));
  return {root,project,home,runId,runDirectory,db,config,snapshot,put,modelPath,candidatePath,pending,event,swap,onStop:(stop:()=>Promise<unknown>)=>stops.push(stop)};
}

for(const stageId of ['face','outfit']) test(`Runtime observation keeps ${stageId}'s authorized temporary import at its source version and sees unrelated tampering`,async t=>{
  const f=fixture(t,stageId);authorizeNativeImport(f.project,f.runDirectory);f.event();
  const fingerprinter=new ArtifactFingerprinter(f.db,f.snapshot,f.project,f.home);
  const hooks={db:f.db,workflowId:'workflow',artifactKinds:['source'],fingerprinter} as unknown as Parameters<typeof refreshFingerprints>[0];
  await refreshFingerprints(hooks);const before=f.db.prepare('SELECT count(*) AS n FROM artifact_version').get()!.n;
  f.swap();await refreshFingerprints(hooks);
  assert.match((projectFaceCandidatePreview(f.db,'project','workflow') as {reason:string}).reason,/源文件恢复后原预览会重新可用/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM artifact_version').get()!.n,before,'same-path comparison must not publish a stale source version');
  f.put(f.modelPath,'unrelated changed bytes');await refreshFingerprints(hooks);
  assert.equal(Number(f.db.prepare('SELECT count(*) AS n FROM artifact_version').get()!.n),Number(before)+1,'unbound tampering is still a new version');
});

test('formal face polling authorizes a SHA-bound commercial receipt larger than 128 MB before Unity dispatch', async t=>{
  let stop: (()=>Promise<unknown>) | undefined;t.after(()=>stop?.());
  const f=fixture(t),capability=f.snapshot.capabilities.stages.face!;
  delete capability.selectionGate;
  capability.command=[process.execPath,'-e','process.exit(0)'];
  capability.unitySteps=[{method:'AVH.Harness.FaceStage.Apply',env:{},quit:true,timeoutSec:10}];
  f.config.unity={defaultTimeoutSec:10,projectScratch:[]} as unknown as LocalConfig['unity'];
  const receipt='Assets/_Harness/Face/Candidates/revision/candidate.json';
  const value=JSON.parse(readFileSync(join(f.project,receipt),'utf8'));
  // Use valid JSON, not a sparse file: the real reader must parse the frozen producer evidence.
  value.compensation={perStateEvidence:'x'.repeat(128*1024*1024)};
  const receiptSha256=f.put(receipt,value);
  const input=JSON.parse(readFileSync(join(f.project,'Assets/_Harness/Face/design.json'),'utf8'));
  input.candidateReceipt.sha256=receiptSha256;f.put('Assets/_Harness/Face/design.json',input);
  const router=new StageRouter(f.db,f.config,f.snapshot);
  const handle=await router.start({runId:f.runId,taskId:'task',workflowId:'workflow',projectId:'project',stageId:'face',attempt:1,idempotencyKey:f.runId,expectedOutputs:[]});
  f.db.prepare("UPDATE run SET process_ref=? WHERE id=?").run(handle.ref,f.runId);
  stop=()=>router.cancel(handle);
  f.onStop(stop);
  const authorityPath=join(f.runDirectory,'native-import-authority.json');
  let lastState='';
  const authorityText=await waitFor(async()=>{
    lastState=(await router.observe(handle)).state;return readIfPresent(authorityPath);
  },{what:'the native-import authority a receipt larger than 128 MB authorizes',timeoutMs:120_000,intervalMs:100,
    detail:()=>`last run state ${lastState}; ${authorityPath} was not written`});
  const authority=JSON.parse(authorityText!);
  assert.equal(authority.candidateSha256,hash('candidate bytes'));
  assert.ok(f.db.prepare("SELECT 1 FROM event WHERE entity_id=? AND action='unity_unit_intended'").get(f.runId),'formal observation reached the supervised Unity dispatch');
  await router.cancel(handle);
  f.put(f.candidatePath,'changed candidate');
  assert.throws(()=>authorizeNativeImport(f.project,join(f.home,'runs','refused')),/来源或候选未核清/,'large receipt permission never exempts binary tampering');
});

test('formal downstream Unity launch freezes native authority before execution and collects only exact restored bytes',async t=>{
  const f=fixture(t,'outfit'),capability=f.snapshot.capabilities.stages.outfit!;
  delete capability.selectionGate;
  capability.command=[process.execPath,'-e',''];
  capability.unitySteps=[{method:'AVH.Harness.OutfitStage.Run',env:{},quit:true,timeoutSec:10}];
  f.config.unity={projectScratch:[],defaultTimeoutSec:10} as unknown as LocalConfig['unity'];
  const stageRouter=new StageRouter(f.db,f.config,f.snapshot);
  const spec={runId:f.runId,taskId:'task',workflowId:'workflow',projectId:'project',stageId:'outfit',attempt:1,idempotencyKey:f.runId,expectedOutputs:[]};
  const handle=await stageRouter.start(spec);
  f.onStop(()=>stageRouter.cancel(handle));
  f.db.prepare("UPDATE run SET process_ref=? WHERE id=?").run(handle.ref,f.runId);
  const router=stageRouter.router('task',f.runId);
  let calls=0;
  (router as unknown as {unityUnit:(runId:string)=>unknown}).unityUnit=()=>({handle:{ref:'fixture-unity'},executor:{
    start:async()=>{
      calls++;
      assert.ok(existsSync(join(f.runDirectory,'native-import-authority.json')),'actual launch must freeze authority before any native import');
      f.swap();assert.ok(pendingNativeImport(f.project,f.runDirectory));
      f.put(f.modelPath,'source bytes');rmSync(join(f.project,'_harness/face/native-import-pending.json'));
      writeFileSync(join(f.runDirectory,'unity-steps.json'),JSON.stringify({status:'finished',evidence:[{index:1,method:'AVH.Harness.OutfitStage.Run',exitCode:0,durationMs:1,log:'fixture',errors:[],waits:0}]}));
      return {ref:'fixture-unity'};
    },observe:()=>({state:'exited'}),collect:()=>({exitStatus:0,outputs:{}}),cancel:async()=> 'confirmed'
  }});
  await waitFor(async()=>{await router.observe(handle);return calls;},
    {what:'the frozen native authority to reach the supervised Unity launch',timeoutMs:120_000,intervalMs:25});
  assert.equal(calls,1);
  const result=await router.collect(handle);
  assert.equal(result.exitStatus,0);
  assert.equal(result.outOfBoundsPaths?.includes(f.modelPath),false,'restored source must not enter technical review');
  f.put(f.modelPath,'real ungranted change');
  assert.ok((await router.collect(handle)).outOfBoundsPaths?.includes(f.modelPath),'authority never exempts a true source mutation');
  await router.cancel(handle);
});

test('interrupted native import restores exact source bytes, archives evidence and refuses changed metadata or backup',t=>{
  const f=fixture(t);authorizeNativeImport(f.project,f.runDirectory);f.swap();
  assert.ok(pendingNativeImport(f.project,f.runDirectory));
  f.put(f.pending.backup,'tampered');assert.throws(()=>recoverNativeImport(f.project,f.runDirectory),/无法核对/);
  assert.equal(readFileSync(join(f.project,f.modelPath),'utf8'),'candidate bytes');f.put(f.pending.backup,'source bytes');
  f.put(f.modelPath+'.meta','tampered');assert.throws(()=>recoverNativeImport(f.project,f.runDirectory),/已变化/);
  f.put(f.modelPath+'.meta','source importer bytes');recoverNativeImport(f.project,f.runDirectory);
  assert.equal(readFileSync(join(f.project,f.modelPath),'utf8'),'source bytes');
  assert.equal(existsSync(join(f.project,'_harness/face/native-import-pending.json')),false);
  assert.deepEqual(restoredNativeImportPaths(f.project,f.runDirectory),[f.modelPath,f.modelPath+'.meta']);
});

for(const stageId of ['face','outfit']) test(`a reconstructed ${stageId} StageRouter polls, stops and collects a real Run even when its candidate selection is stale`,async t=>{
  const f=fixture(t,stageId),runner=new ToolRunner({projectDirectory:f.project,workspaceRepository:f.project,runRoot:join(f.home,'runs'),harnessHome:f.home});
  writeFileSync(join(f.runDirectory,'scope-before.json'),JSON.stringify(taskScopeSnapshot(f.project)));
  const spec={runId:f.runId,taskId:'task',workflowId:'workflow',projectId:'project',stageId,attempt:1,idempotencyKey:f.runId,expectedOutputs:[]};
  const inner=await runner.start({...spec,argv:[process.execPath,'-e','setInterval(()=>{},1000)'],allowedWrites:[],env:{}});
  f.onStop(()=>runner.cancel(inner));const handle={ref:'tool|'+inner.ref};f.db.prepare('UPDATE run SET process_ref=? WHERE id=?').run(handle.ref,f.runId);
  const unity=createRunExecutor({projectDirectory:f.project,workspaceRepository:f.project,runRoot:f.runDirectory,
    writableByRunner:{unity:[]},commandFor:()=>({runner:'unity',argv:[process.execPath,'-e','setInterval(()=>{},1000)'],cwd:f.runDirectory})});
  const unitySpec={...spec,runId:'unity-'+f.runId,idempotencyKey:'unity-'+f.runId};const unityHandle=await unity.start(unitySpec);f.onStop(()=>unity.cancel(unityHandle));
  f.config.unity={defaultTimeoutSec:10,projectScratch:[]} as unknown as LocalConfig['unity'];
  f.snapshot.capabilities.stages[stageId]!.unitySteps=[{method:'AVH.Harness.FaceStage.Apply',env:{},quit:true,timeoutSec:10}];
  writeFileSync(join(f.runDirectory,'unity-steps.json'),JSON.stringify({status:'started'}));f.event();authorizeNativeImport(f.project,f.runDirectory);
  f.swap(); // No chosen Gate at all: startup would reject it, but an existing Run remains controllable.
  const fresh=()=>new StageRouter(f.db,f.config,f.snapshot);
  assert.equal((await fresh().observe(handle)).state,'running');
  assert.equal(await fresh().cancel(handle),'confirmed');
  assert.equal(readFileSync(join(f.project,f.modelPath),'utf8'),'source bytes','confirmed process stop also recovers the interrupted transaction');
  assert.equal(existsSync(join(f.project,'_harness/face/native-import-pending.json')),false);
  assert.equal((await fresh().observe(handle)).state,'exited');
  await waitUntil(()=>existsSync(join(f.runDirectory,'exit.json')),
    {what:`the confirmed stop of ${f.runId} to publish its exit record`,timeoutMs:120_000,intervalMs:50});
  const collected=await fresh().collect(handle);assert.equal(typeof collected.exitStatus,'number');
  assert.equal(collected.outOfBoundsPaths?.includes(f.modelPath),false,'restored source metadata is a bound Runtime side effect');
  await assert.rejects(fresh().start({...spec,stageId}),error=>(error as {noSideEffects?:boolean}).noSideEffects===true);
});

for(const fault of ['new-managed','modified-managed','foreign','mixed'] as const) test(`formal finish classifies only new supervised managed Unity metadata: ${fault}`,async t=>{
  const f=fixture(t),snapshot=f.snapshot;
  const path=fault==='foreign'?'Assets/Vendor/asset.prefab':'Assets/_Harness/Face/Generated/asset.prefab';f.put(path,'asset bytes');
  snapshot.definition.artifacts.push('prior');snapshot.capabilities.artifacts.prior={paths:[path]};
  snapshot.capabilities.stages.face!.unitySteps=[{method:'AVH.Harness.FaceStage.Apply',env:{},quit:true,timeoutSec:10}];
  snapshot.capabilities.stages.face!.allowedWrites=['Assets/'];
  if(fault==='modified-managed')f.put(path+'.meta','fileFormatVersion: 2\nguid: '+ 'a'.repeat(32)+'\n');
  const printer=new ArtifactFingerprinter(f.db,snapshot,f.project,f.home);
  const scheduler=new Scheduler(f.db,'workflow',snapshot.definition,{} as any,{verify:()=>[]},printer,{maxRetries:0,slotCapacity:{}});
  await refreshFingerprints(scheduler);
  f.db.prepare('UPDATE task SET inputs_json=? WHERE id=\'task\'').run(JSON.stringify({baseline:buildAggregateInput(f.db,'workflow').artifactHashes}));
  f.db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('workflow','runtime','task','task','READY->RUNNING','test')").run();f.event();
  f.put(path+'.meta','fileFormatVersion: 2\nguid: '+ 'b'.repeat(32)+'\n');if(fault==='mixed')f.put(path,'changed asset bytes');
  await refreshFingerprints(scheduler);await scheduler.finish(f.runId,{exitStatus:0,outputs:{}});
  const rows=f.db.prepare('SELECT artifact FROM out_of_bounds_change').all();
  assert.equal(rows.length,fault==='new-managed'?0:1,'only generated metadata may leave the technical review queue automatically');
  if(rows.length)assert.equal(rows[0]!.artifact,'prior');
  const events=f.db.prepare("SELECT payload_json FROM event WHERE entity_type='artifact_version' AND entity_id='prior' ORDER BY seq DESC LIMIT 1").get()!;
  assert.equal(JSON.parse(String(events.payload_json)).managedSideEffect,fault==='new-managed'?'unity-new-metadata':undefined);
});
