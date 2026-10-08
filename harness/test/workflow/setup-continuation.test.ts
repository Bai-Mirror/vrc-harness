import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync,symlinkSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import test,{type TestContext} from 'node:test';
import {parse,stringify} from 'yaml';
import {loadConfig} from '../../src/config.ts';
import {hostArgv} from '../../src/host-platform.ts';
import {openDatabase} from '../../src/state/db.ts';
import {sha256File} from '../../src/file-hash.ts';
import {createWorkflow,workflowSnapshot,ArtifactFingerprinter,workflowScheduler,StageRouter} from '../../src/workflow/runtime.ts';
import {aggregateWorkflow} from '../../src/state/aggregate-input.ts';
import {setupRuntimeChanges,continueFailedSetup,canReviewFailedSetup} from '../../src/setup-continuation.ts';
import {TaskRouter,taskScopeSnapshot} from '../../src/task-cli.ts';
import {createRunExecutor} from '../../src/exec/executor.ts';
import {RuntimeService} from '../../src/api/server.ts';
import {ApiClient} from '../../src/api/client.ts';
import {facePreparationFailureEvidence} from '../../src/face-continuation-evidence.ts';
import {productionBusinessContext} from '../../src/production-version-resume.ts';
import {productionContext} from '../../src/production-proposals.ts';
import {registerPackCandidate,recordPackEvaluation} from '../../src/managed-pack-candidate.ts';
import {adoptLocalCandidate,localMaintenanceView,localWorkflowSelection} from '../../src/local-maintenance.ts';
import {productionProgress} from '../../src/production-recovery.ts';
import {submitInteraction} from '../../src/interactions.ts';
import {fakeCommand,FAKE_PROVIDER,removeTemp} from '../fixtures/platform.ts';
import {waitFor} from '../fixtures/wait.ts';
import {checkSandboxStatus} from '../../src/exec/check-runner.ts';
import {ObservationVerifier} from '../../src/workflow/observe.ts';
import {setupReviewStatus,isSetupReviewRunning} from '../../src/setup-review.ts';
import {writeProjectArchive,verifiedProjectionChanges,projectSafePoint} from '../../src/archive/projection.ts';

function fixture(t:TestContext,validationFailure=false,validatorError=false,faceFailure:boolean|'forged'=false){
 const root=mkdtempSync(join(tmpdir(),'avh-setup-continuation-'));t.after(()=>removeTemp(root));
 const home=join(root,'home'),project=join(root,'workspace','sample'),knowledge=join(root,'knowledge'),tools=join(root,'tools');
 for(const dir of [join(home,'config'),join(home,'state'),project,knowledge,tools,join(root,'export')])mkdirSync(dir,{recursive:true});
 execFileSync('git',['init','-q',project]);
 const put=(path:string,value:string)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,value);};
 put(join(project,'accepted-user.txt'),'keep user original');
 execFileSync('git',['-C',project,'add','.']);execFileSync('git',['-C',project,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','baseline']);
 const ancestors=['intake','plan','environment'];
 const definition={schema:'process/0.1',id:'setup-flow',version:'1',applies_to:{},artifacts:['assets','plan','environment','fbx'],
  stages:[...ancestors.map((id,i)=>({id,needs:i?[ancestors[i-1]]:[],produces:[['assets','plan','environment'][i]],requires:[`${id}_check`,...(id==='plan'?['plan_gallery_check']:[])],gates:id==='plan'?['plan_approval']:[],invalidated_by:['assets','plan','environment'].slice(0,i)})),
   {id:'setup',needs:['environment'],produces:['fbx'],requires:validationFailure?['setup_validation']:[],gates:[],invalidated_by:['plan','environment']}],
  checks:[...ancestors.map((id,i)=>({id:`${id}_check`,observe:`${id}.independent`,on:['assets','plan','environment'][i],scope:'edit',severity:'blocking',rule:'valid == true',maturity:'accepted',source:'test fixture'})),
   {id:'plan_gallery_check',observe:'plan.independent',on:'plan',scope:'edit',severity:'blocking',rule:'valid == true',when:'plan.client_gallery',maturity:'accepted',source:'test fixture'},
   ...(validationFailure?[{id:'setup_validation',observe:validatorError?'setup.independent':'environment.independent',on:'fbx',scope:'edit',severity:'blocking',rule:'valid == false',maturity:'accepted',source:'test old validator'}]:[])],
  gates:[{id:'plan_approval',kind:'approve',binds:'plan'}],milestones:[{id:'UPLOAD_READY',requires_stages:'all',evidence_on:'fbx'}]};
 const caps={schema:'capabilities/0.1',process:'setup-flow',version:'1',artifacts:{assets:{paths:['_harness/intake/input.json']},plan:{paths:['_harness/plan/plan.yaml'],format:'yaml'},
  environment:{paths:['_harness/environment/lock.json']},fbx:{paths:['_harness/setup/output.json']}},
  stages:Object.fromEntries([...ancestors.map(id=>[id,{mode:'tool',command:['node','{toolRoot}/noop.mjs'],allowedWrites:[`_harness/${id}/`],resources:[]}]),
   ['setup',{mode:'provider',goal:'prepare fixture',allowedWrites:['Assets/','Packages/'],prepareCommand:['node','{toolRoot}/noop.mjs'],resources:['unity_batch'],
    unitySteps:[{method:'AVH.Harness.SetupStage.Run',timeoutSec:1},{method:'AVH.Harness.FaceStage.Observe',timeoutSec:1}],
    agentTools:{sources:['node','{toolRoot}/harness/unity/Editor/FaceStage.cs','{toolRoot}/harness/unity/Editor/SetupStage.cs','{toolRoot}/harness/unity/Editor/AvhCommon.cs']}}]]),
  observers:Object.fromEntries(ancestors.map(id=>[`${id}.independent`,{command:['node','{toolRoot}/observe.mjs','{project}',id,'{out}']}]))};
 if(faceFailure){
  for(const [index,check] of definition.checks.entries()){
   const ref=`${index+1}`.repeat(12);Object.assign(check,{source_id:ref,verification:[{kind:'sop-editorial',ref}],kind:'spec'});
  }
  definition.artifacts.push('face_candidates');
  definition.stages.push({id:'face_design',needs:['setup'],produces:['face_candidates'],requires:[],gates:['face_choice'],invalidated_by:['fbx','plan']});
  definition.gates.push({id:'face_choice',kind:'approve',binds:'face_candidates'});
  (caps.artifacts as Record<string,unknown>).face_candidates={paths:['_harness/face/candidates.json']};
  caps.stages.face_design={mode:'provider',goal:'face candidate fixture',allowedWrites:['_harness/face/request.json'],runtimeWrites:['_harness/face/candidates.json'],resources:['unity_batch'],
    prepareCommand:['node','{toolRoot}/face-tool.mjs','candidates','--project','{project}'],unitySteps:[{method:'AVH.Harness.FacePreviewStage.RenderCandidates',timeoutSec:1}]};
  put(join(tools,'face-tool.mjs'),'process.exit(2);');
 }
 if(validatorError)caps.observers['setup.independent']={command:['node','{toolRoot}/observe-setup.mjs','{out}']};
 if(validatorError)put(join(tools,'observe-setup.mjs'),`import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],JSON.stringify({schema:'observation/0.1',metrics:{valid:false,invalid_array:[]}}));`);
 put(join(tools,'noop.mjs'),'process.exit(0);');
 put(join(tools,'observe.mjs'),`import{readFileSync,writeFileSync,existsSync}from'node:fs';import{join}from'node:path';const[p,s,out]=process.argv.slice(2);if(existsSync(join(p,'observer-write-request')))writeFileSync(join(p,'accepted-user.txt'),'unexpected observer write');const valid=readFileSync(join(p,'accepted-user.txt'),'utf8')==='keep user original'&&!readFileSync(join(p,'_harness/environment/lock.json'),'utf8').includes('reject');writeFileSync(out,JSON.stringify({schema:'observation/0.1',metrics:{valid}}));`);
 for(const name of ['FaceStage.cs','SetupStage.cs','AvhCommon.cs']){
  const rel=`harness/unity/Editor/${name}`;put(join(tools,rel),readFileSync(new URL(`../../builtin/tools/${rel}`,import.meta.url),'utf8'));
  put(join(project,'Assets/_HarnessTools/Editor',name),readFileSync(join(tools,rel),'utf8'));
 }
 for(const name of ['project_fingerprint.py','vpm_baseline_check.py','审查/perception/strip_audit.py'])put(join(tools,name),'');
 put(join(knowledge,'process.yaml'),stringify(definition));put(join(knowledge,'capabilities.yaml'),stringify(caps));put(join(knowledge,'thresholds.yaml'),stringify({schema:'thresholds/0.1',version:'1',t:{}}));
 const provider=fakeCommand(join(root,'fake-provider'),FAKE_PROVIDER),editor=fakeCommand(join(root,'fake-unity'),FAKE_PROVIDER);
 const configFile=join(home,'config/harness.yaml');
 put(configFile,stringify({workspaceRoot:join(root,'workspace'),toolRoot:tools,knowledgeRoot:knowledge,exportRoots:[join(root,'export')],knownBodies:[],projectAliases:{},sampleNames:['sample'],
  defaultProfile:'setup-flow',thresholdsFile:'thresholds.yaml',processDefinitions:{'setup-flow':{definition:'process.yaml',capabilities:'capabilities.yaml'}},
  providers:[{id:'fake',type:'codex-cli',executable:provider,roles:['executor'],writable:[]}],unity:{runner:editor,editor}}));
 const config=loadConfig(home),db=openDatabase(join(home,'state/harness.db'));t.after(()=>db.close());
 const source=join(root,'source.unitypackage');put(source,'authorized source');const sourceHash=sha256File(source);
 const manifest=join(root,'manifest.json');put(manifest,stringify({schema:'manifest/0.1',profile:'setup-flow',request:'fixture original requirement',assets:[{store:'library',item:source,role:'body',sha256:sourceHash}]}));
 const workflow=createWorkflow(db,config,project,'setup-flow',manifest),snapshot=workflowSnapshot(db,workflow);
 const projectId=String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflow)!.project_id);
 const message=submitInteraction(db,projectId,{content:'fixture original requirement',commandId:'fixture-original'});db.prepare("UPDATE project_interaction SET status='completed' WHERE id=?").run(message.id);
 db.prepare(`INSERT INTO production_proposal(id,project_id,revision,profile,request,inputs_json,context_json,status,workflow_id)VALUES(?,?,1,'setup-flow','fixture original requirement',?,?,'working',?)`)
  .run(message.id,projectId,JSON.stringify([{path:source,sha256:sourceHash}]),productionContext(db,projectId),workflow);
 put(join(project,'_harness/intake/input.json'),'{}');put(join(project,'_harness/plan/plan.yaml'),stringify({body_prefab:'Assets/Source/avatar.prefab',face:{mode:'design'}}));put(join(project,'_harness/environment/lock.json'),'valid');
 const hashes=new ArtifactFingerprinter(db,snapshot,project).fingerprint(workflow,['assets','plan','environment']);
 for(const[k,v]of Object.entries(hashes))db.prepare('INSERT INTO artifact_version(workflow_id,kind,hash)VALUES(?,?,?)').run(workflow,k,v);
 const plan={body_prefab:'Assets/Source/avatar.prefab',face:{mode:'design'}};db.prepare('UPDATE workflow SET plan_json=? WHERE id=?').run(JSON.stringify(plan),workflow);
 for(const[id,index]of ancestors.map((id,i)=>[id,i]as const)){
  db.prepare('INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result,basis)VALUES(?,?,?,?,?,?,?)').run(`old-${id}`,workflow,`${id}_check`,'edit',hashes[['assets','plan','environment'][index]!]!,'pass','fixture original source');
  db.prepare('INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json)VALUES(?,?,?)').run(workflow,id,JSON.stringify(hashes));
 }
 db.prepare('INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result,basis)VALUES(?,?,?,?,?,?,?)').run('old-gallery',workflow,'plan_gallery_check','edit',hashes.plan!,'not_applicable','plan.client_gallery');
 db.prepare("INSERT INTO gate_decision(workflow_id,gate_id,artifact_hash,result)VALUES(?,'plan_approval',?,'approved')").run(workflow,hashes.plan!);
 db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)VALUES(?,'human','gate',?,'approved','fixture human decision',?)")
  .run(workflow,`${workflow}:plan_approval`,JSON.stringify({hash:hashes.plan}));
 assert.equal(aggregateWorkflow(db,workflow,snapshot.definition).stages.environment?.status,'passed');
 const setup=db.prepare("INSERT INTO task(id,workflow_id,stage_id,status,goal,capability,inputs_json)VALUES('fixture-setup',?,'setup','FAILED','fixture','setup','{}')RETURNING id").get(workflow)!;
 // A Windows job name is derived from the run ID alone and is machine-global, and `UnitExecutor.start` declines to
 // launch while a job with that name is still loaded. Nine subtests run back to back here, so each fixture's Run
 // needs an ID of its own: reusing one let the previous subtest's supervisor, still loaded under load, silently
 // swallow the next Run — it was never started, and `observe` could answer only 'running' or 'unknown', never 'exited'.
 const unique=basename(root).replace(/^avh-setup-continuation-/,'');
 let taskId=String(setup.id),runId=`fixture-failed-setup-${unique}`;
 if(faceFailure){
  db.prepare("UPDATE task SET status='PASSED' WHERE id=?").run(taskId);
  put(join(project,'_harness/setup/output.json'),'original setup');
  const preparedHashes=new ArtifactFingerprinter(db,snapshot,project).fingerprint(workflow,['fbx']);
  db.prepare('INSERT INTO artifact_version(workflow_id,kind,hash)VALUES(?,?,?)').run(workflow,'fbx',preparedHashes.fbx!);
  db.prepare("INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json)VALUES(?,'setup',?)").run(workflow,JSON.stringify(hashes));
  taskId='fixture-face';runId=`fixture-failed-face-${unique}`;
  db.prepare("INSERT INTO task(id,workflow_id,stage_id,status,goal,capability,inputs_json)VALUES(?,?,'face_design','FAILED','face fixture','face_design','{}')").run(taskId,workflow);
 }

 put(join(project,'.vsconfig'),JSON.stringify({version:'1.0',components:['Microsoft.VisualStudio.Workload.ManagedGame']}));
 put(join(project,'Assets/Source/avatar.prefab'),'source prefab');put(join(project,'Assets/Source/source.fbx'),'source model');put(join(project,'Assets/Source/source.fbx.meta'),'fileFormatVersion: 2\nModelImporter:\n  isReadable: 1\n');
 const identity={path:'Assets/Source/source.fbx',sha256:sha256File(join(project,'Assets/Source/source.fbx')),metaSha256:sha256File(join(project,'Assets/Source/source.fbx.meta'))};
 put(join(project,'_harness/face/preparation.json'),JSON.stringify({schema:'face-preparation/0.1',sourcePrefab:plan.body_prefab,models:[{sourceBefore:identity,sourceAfter:identity,readable:true}],scope:'Runtime isolated work project; source model bytes preserved'}));
 const runRoot=join(home,'runs',runId),evidence=[{index:1,method:'AVH.Harness.SetupStage.Run',exitCode:1,durationMs:1,log:join(runRoot,'unity-1.log'),errors:['fixture tool failure'],waits:0}];
 const result={exitStatus:1,errorClass:'tool_failure' as const,outputs:{},externalChanges:[],prepare:{status:'finished' as const,exitStatus:0,outOfBoundsPaths:[]},unitySteps:evidence,
  outOfBoundsPaths:['.vsconfig','_harness/face/preparation.json'],scanEvidence:['.vsconfig','_harness/face/preparation.json'].map(path=>({path,sha256:sha256File(join(project,path))}))};
 db.prepare("INSERT INTO run(id,task_id,attempt,status,process_ref,result_json)VALUES(?,?,1,'exited','fixture|confirmed',?)").run(runId,taskId,JSON.stringify(result));
 put(join(runRoot,'unity-provider-result.json'),JSON.stringify({exitStatus:0,outputs:{},outOfBoundsPaths:[],scanEvidence:[],externalChanges:[]}));
 put(join(runRoot,`unity-${runId}/unity-input.json`),JSON.stringify({project,runDir:runRoot,steps:snapshot.capabilities.stages.setup!.unitySteps!.map(step=>({...step,env:{...step.env,AVH_STAGE:'setup',AVH_PLAN:JSON.stringify(plan),AVH_MANIFEST:JSON.stringify(snapshot.manifest)}}))}));
 put(join(runRoot,'unity-steps.json'),JSON.stringify({status:'finished',evidence}));
 put(join(runRoot,'prepare.json'),JSON.stringify({status:'finished',result:{exitStatus:0,outOfBoundsPaths:[],externalChanges:[]}}));
 db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason)VALUES(?,?,'run',?,'prepare_unit_intended','fixture managed preparation')").run(workflow,faceFailure==='forged'?'human':'runtime',runId);
 if(!faceFailure)db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason)VALUES(?,'runtime','run',?,'unity_unit_intended','fixture managed unit')").run(workflow,runId);
 for(const path of result.outOfBoundsPaths)db.prepare("INSERT INTO out_of_bounds_change(workflow_id,stage_id,artifact)VALUES(?,'setup',?)").run(workflow,`workspace:${path}`);
 if(faceFailure){
  result.exitStatus=2;result.prepare.exitStatus=2;(result.prepare as {errorClass?:string}).errorClass='tool_failure';
  result.unitySteps=[];result.outOfBoundsPaths=[];result.scanEvidence=[];
  db.prepare('DELETE FROM out_of_bounds_change WHERE workflow_id=?').run(workflow);
  rmSync(join(runRoot,'unity-steps.json'));rmSync(join(runRoot,`unity-${runId}`),{recursive:true});
  put(join(runRoot,'prepare.json'),JSON.stringify({status:'finished',result:{exitStatus:2,errorClass:'tool_failure',outOfBoundsPaths:[],externalChanges:[]}}));
  const unit=`prepare-${runId}`,argv=hostArgv(snapshot.capabilities.stages.face_design!.prepareCommand!.map(arg=>arg.replaceAll('{toolRoot}',tools).replaceAll('{project}',project)));
  const allowedWrites=[...snapshot.capabilities.stages.face_design!.allowedWrites,...snapshot.capabilities.stages.face_design!.runtimeWrites!].map(path=>resolve(project,path));
  put(join(runRoot,unit,'command.json'),JSON.stringify({runner:'tool',argv,cwd:join(runRoot,unit),runDirectory:join(runRoot,unit),projectDirectory:project,
    env:{AVH_TOOL_ROOT:tools,AVH_STAGE:'face_design',AVH_PLAN:JSON.stringify(plan),AVH_MANIFEST:JSON.stringify(snapshot.manifest)}}));
  put(join(runRoot,unit,'tool-request.json'),JSON.stringify({argv,allowedWrites}));
  put(join(runRoot,unit,'exit.json'),JSON.stringify({exitStatus:2,timedOut:false,exit:{code:2,timedOut:false,cancelled:false}}));
  db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(result),runId);
 }
 const id=message.id,row={id,project_id:projectId,revision:1,status:'working',workflow_id:workflow};
 const update=()=>{const revised=JSON.parse(JSON.stringify(caps));revised.stages.setup.runtimeWrites=['.vsconfig','_harness/face/preparation.json'];put(join(knowledge,'capabilities.yaml'),stringify(revised));return loadConfig(home);};
 const command=()=>({projectId,id,commandId:'fixture-resume',expectedToken:productionProgress(db,row)!.token});
 return{root,home,project,tools,source,knowledge,config,db,workflow,snapshot,runRoot,runId,taskId,result,id,projectId,row,update,command,put,hashes};
}

test('known Runtime setup changes require private phase facts, exact source and readback, never merely new write permissions',async t=>{
 const f=fixture(t);assert.equal(canReviewFailedSetup(f.db,f.workflow,f.taskId),true);
 assert.equal(setupRuntimeChanges(f.db,f.config,f.snapshot,f.project,f.runId,f.result).length,2);
 for(const mode of ['provider','source','file','model','other','unknown-journal','unknown-prepare','updated-tool-root','missing-frozen-source'] as const)await t.test(mode,st=>{
  const save=new Map<string,string>();const alter=(path:string,text:string)=>{save.set(path,readFileSync(path,'utf8'));writeFileSync(path,text);};
  try{
   const result=structuredClone(f.result);
   if(mode==='provider')alter(join(f.runRoot,'unity-provider-result.json'),JSON.stringify({...result,scanEvidence:[result.scanEvidence[0]]}));
   if(mode==='source')alter(join(f.project,'Assets/_HarnessTools/Editor/FaceStage.cs'),'modified executable');
   if(mode==='file')alter(join(f.project,'.vsconfig'),'{}');
   if(mode==='model')alter(join(f.project,'Assets/Source/source.fbx'),'modified source');
   if(mode==='other')result.outOfBoundsPaths.push('accepted-user.txt');
   if(mode==='unknown-journal')alter(join(f.runRoot,'unity-steps.json'),JSON.stringify({status:'started'}));
   if(mode==='unknown-prepare')alter(join(f.runRoot,'prepare.json'),JSON.stringify({status:'started'}));
   if(mode==='updated-tool-root'){
    alter(join(f.tools,'harness/unity/Editor/FaceStage.cs'),'new managed version');
    assert.equal(setupRuntimeChanges(f.db,f.config,f.snapshot,f.project,f.runId,result).length,2,'original installed bytes remain bound to old frozen SHA');
    assert.equal(canReviewFailedSetup(f.db,f.workflow,f.taskId),true);return;
   }
   if(mode==='missing-frozen-source'){
    const snapshot=structuredClone(f.snapshot);delete snapshot.tools['harness/unity/Editor/FaceStage.cs'];
    assert.throws(()=>setupRuntimeChanges(f.db,f.config,snapshot,f.project,f.runId,result));return;
   }
   assert.throws(()=>setupRuntimeChanges(f.db,f.config,f.snapshot,f.project,f.runId,result));
   if(mode!=='other')assert.equal(canReviewFailedSetup(f.db,f.workflow,f.taskId),false);
  }finally{for(const[path,text]of save)writeFileSync(path,text);}
 });
});

test('the real project resume API freezes a complete new version, independently rechecks ancestors, and preserves a partial project without replaying AI',async t=>{
 if(!checkSandboxStatus().available){t.skip('independent observation sandbox unavailable');return;}
 const f=fixture(t);f.update();
 f.put(join(f.project,'Library/cache.bin'),'rebuildable fixture cache');
 f.put(join(f.project,'custom-user-note.txt'),'preserve user note');
 t.mock.method(TaskRouter.prototype,'settledResult',async()=>f.result);
 const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
 try{
  const cmd=f.command();assert.equal(productionProgress(f.db,f.row)!.canResume,true);
  const offered=await client.call<any[]>('project.production.list',{projectId:f.projectId});assert.equal(offered[0].progress.canResume,true,'GUI consumer offers only source-backed review');
  const journal=join(f.runRoot,'unity-steps.json'),saved=readFileSync(journal,'utf8');writeFileSync(journal,'{"status":"started"}');
  try{assert.equal((await client.call<any[]>('project.production.list',{projectId:f.projectId}))[0].progress.canResume,false,'GUI does not offer unknown Unity outcome');}finally{writeFileSync(journal,saved);}
  assert.deepEqual(await client.call('project.production.resume',cmd),{requested:true});
  assert.deepEqual(await client.call('project.production.resume',cmd),{requested:true});
 }finally{client.close();await service.stop();}
 const next=String(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id);
 assert.notEqual(next,f.workflow);assert.equal(f.db.prepare('SELECT count(*) AS n FROM run').get()!.n,1,'no fabricated new production Run');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM task WHERE workflow_id=?').get(next)!.n,0,'no fake Passed Task');
 assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.taskId)!.status,'FAILED');
 const old=f.db.prepare('SELECT capabilities_json FROM workflow_definition WHERE workflow_id=?').get(f.workflow)!.capabilities_json;
 assert.equal(old,JSON.stringify(f.snapshot.capabilities));
 for(const id of ['intake','plan','environment'])assert.equal(aggregateWorkflow(f.db,next,workflowSnapshot(f.db,next).definition).stages[id]?.status,'passed');
 assert.equal(aggregateWorkflow(f.db,next,workflowSnapshot(f.db,next).definition).stages.setup?.status,'open');
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE workflow_id=? AND actor='human' AND entity_type='gate'").get(next)!.n,0,'does not invent new human approval');
 const event=JSON.parse(String(f.db.prepare("SELECT payload_json FROM event WHERE action='setup_version_continued'").get()!.payload_json));
 assert.equal(readFileSync(join(event.preserved,'project/custom-user-note.txt'),'utf8'),'preserve user note');
 assert.equal(existsSync(join(event.preserved,'project/Library/cache.bin')),false);assert.equal(readFileSync(join(f.project,'Library/cache.bin'),'utf8'),'rebuildable fixture cache');
 assert.equal(readFileSync(join(f.project,'accepted-user.txt'),'utf8'),'keep user original');
 assert.equal(f.db.prepare("SELECT basis FROM verdict WHERE workflow_id=? AND check_id='plan_gallery_check'").get(next)!.basis,'plan.client_gallery','false-when keeps exact independent N/A basis');
 assert.equal(setupReviewStatus(f.db,f.id)?.status,'succeeded');
});

test('continuation refuses changed source, ancestral meaning, failed independent reading and protected-project mutation without switching the old pointer',async t=>{
 for(const mode of ['source','contract','reading','mutation','external','lock','configuration-during-review','project-during-review'] as const)await t.test(mode,async st=>{
  if(!checkSandboxStatus().available){st.skip('independent observation sandbox unavailable');return;}
  const f=fixture(st),config=f.update();
  if(mode==='source')f.put(f.source,'changed authorized source');
  if(mode==='contract')config.definitions['setup-flow']!.stages[1]!.invalidated_by.push('environment');
  if(mode==='reading')f.put(join(f.project,'accepted-user.txt'),'independent read must reject');
  if(mode==='mutation')f.put(join(f.project,'observer-write-request'),'exercise frozen observer write denial');
  if(mode==='lock')f.db.prepare("INSERT INTO lock(resource,run_id,fencing,lease_until)VALUES('slot:unity_batch',?,1,'2099-01-01')").run(f.runId);
  if(mode==='configuration-during-review'||mode==='project-during-review'){
   const verify=ObservationVerifier.prototype.verify;
   st.mock.method(ObservationVerifier.prototype,'verify',async function(this:ObservationVerifier,...args:Parameters<typeof verify>){
    const readings=await verify.apply(this,args);
    if(mode==='configuration-during-review')f.put(join(f.home,'config/harness.yaml'),readFileSync(join(f.home,'config/harness.yaml'),'utf8')+'\ncontributorName: changed during review\n');
    else f.put(join(f.project,'custom-user-file.txt'),'concurrent user change');
    return readings;
   });
  }
  const result=structuredClone(f.result);if(mode==='external')result.externalChanges.push({} as never);
  await assert.rejects(continueFailedSetup(f.db,config,f.snapshot,f.command(),f.runId,result,()=>{}));
  assert.equal(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id,f.workflow);
  assert.equal(f.db.prepare('SELECT status FROM workflow WHERE id=?').get(f.workflow)!.status,'active');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow_definition').get()!.n,1);
  if(mode==='mutation')assert.equal(readFileSync(join(f.project,'accepted-user.txt'),'utf8'),'keep user original');
 });
});

test('GUI list exposes the owned long review and the same command returns pending without starting another observer',async t=>{
 if(!checkSandboxStatus().available){t.skip('independent observation sandbox unavailable');return;}
 const f=fixture(t);f.update();t.mock.method(TaskRouter.prototype,'settledResult',async()=>f.result);
 const verify=ObservationVerifier.prototype.verify;let calls=0;
 let entered!:()=>void,release!:()=>void;const atObservation=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);
 t.mock.method(ObservationVerifier.prototype,'verify',async function(this:ObservationVerifier,...args:Parameters<typeof verify>){
  calls++;if(calls===1){entered();await hold;}return verify.apply(this,args);
 });
 const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
 try{
  const cmd=f.command(),pending=client.call('project.production.resume',cmd);await atObservation;
  const item=(await client.call<any[]>('project.production.list',{projectId:f.projectId}))[0];
  assert.equal(item.progress.token,cmd.expectedToken,'progress does not invalidate its own command');
  assert.equal(item.progress.recovery.status,'running');assert.equal(item.progress.recovery.phase,'observing');
  assert.equal(item.progress.canResume,false);assert.equal(isSetupReviewRunning(f.db,f.projectId),true);
  assert.deepEqual(await client.call('project.production.resume',cmd),{pending:true});assert.equal(calls,1);
  release();assert.deepEqual(await pending,{requested:true});assert.equal(calls,3);
  assert.equal(isSetupReviewRunning(f.db,f.projectId),false);
 }finally{release();client.close();await service.stop();}
});

test('actual false-when basis is required and a complete failed transaction backup can be SHA-reused with fresh independent observations',async t=>{
 for(const mode of ['reuse','tampered-backup','changed-current'] as const)await t.test(mode,async st=>{
  if(!checkSandboxStatus().available){st.skip('independent observation sandbox unavailable');return;}
  const f=fixture(st),config=f.update(),cmd=f.command();
  const verify=ObservationVerifier.prototype.verify;let wrong=true,calls=0;
  st.mock.method(ObservationVerifier.prototype,'verify',async function(this:ObservationVerifier,...args:Parameters<typeof verify>){
   calls++;const readings=await verify.apply(this,args);return readings.map(reading=>wrong&&reading.result==='not_applicable'?{...reading,basis:`untrusted prefix: ${reading.basis}`} :reading);
  });
  await assert.rejects(continueFailedSetup(f.db,config,f.snapshot,cmd,f.runId,f.result,()=>{}),/复验结果未形成/);
  assert.equal(calls,3);assert.equal(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id,f.workflow);
  const failed=setupReviewStatus(f.db,f.id)!;assert.equal(failed.status,'failed');assert.match(failed.error!,/复验结果未形成/);
  assert.equal(productionProgress(f.db,f.row)!.recovery?.error,failed.error,'failure survives the disconnected request');
  const parent=join(f.home,'production/continuations');
  const old=readdirSync(parent).map(name=>join(parent,name)).find(path=>existsSync(join(path,'evidence.json')))!;
  const oldEvidence=readFileSync(join(old,'evidence.json'),'utf8'),backup=join(old,'project','accepted-user.txt');
  if(mode==='tampered-backup')writeFileSync(backup,'tampered retained backup');
  if(mode==='changed-current')f.put(join(f.project,'new-user-note.txt'),'changed after prior completed backup');wrong=false;
  const nextCmd={...f.command(),commandId:'fixture-retry'};
  if(mode!=='reuse'){
   await assert.rejects(continueFailedSetup(f.db,config,f.snapshot,nextCmd,f.runId,f.result,()=>{}),mode==='tampered-backup'?/旧工程备份字节已变化/:/已有完整工程备份与当前工程不一致/);
   assert.equal(calls,3,'reject before any new independent job');
   assert.equal(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id,f.workflow);
  }else{
   assert.deepEqual(await continueFailedSetup(f.db,config,f.snapshot,nextCmd,f.runId,f.result,()=>{}),{requested:true});
   assert.equal(calls,6,'old verdicts are not copied as current evidence');
   const event=JSON.parse(String(f.db.prepare("SELECT payload_json FROM event WHERE action='setup_version_continued'").get()!.payload_json));
   const latest=JSON.parse(readFileSync(join(event.preserved,'evidence.json'),'utf8'));
   assert.equal(latest.reusedFrom.directory,old);assert.equal(latest.projectSnapshotRoot,join(old,'project'));
   assert.equal(existsSync(join(event.preserved,'project')),false,'zero repeated project copies');
   assert.equal(readFileSync(join(old,'evidence.json'),'utf8'),oldEvidence,'prior failure evidence remains immutable');
  }
 });
});

test('review projection rejects wrong actor and wrong binding, and a dead owner is unknown rather than successful',t=>{
 const f=fixture(t),cmd=f.command();
 const append=(actor:string,projectId:string,ownerPid:number)=>f.db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)VALUES(?,?,'production_proposal',?,'setup_review','fixture review',?)")
  .run(f.workflow,actor,f.id,JSON.stringify({action:'resume',command:cmd,recovery:{commandId:cmd.commandId,projectId,workflowId:f.workflow,ownerPid,status:'running',phase:'observing'}}));
 append('provider',f.projectId,process.pid);assert.equal(setupReviewStatus(f.db,f.id),undefined);
 append('runtime','wrong-project',process.pid);assert.equal(setupReviewStatus(f.db,f.id),undefined);
 append('runtime',f.projectId,2147483647);assert.equal(setupReviewStatus(f.db,f.id)?.status,'unknown');assert.equal(isSetupReviewRunning(f.db,f.projectId),false);
 append('runtime',f.projectId,process.pid);assert.equal(setupReviewStatus(f.db,f.id)?.status,'running');assert.equal(isSetupReviewRunning(f.db,f.projectId),true);
 const owner={proposalId:f.id,workflowId:f.workflow,commandId:cmd.commandId,ownerPid:process.pid};
 assert.equal(isSetupReviewRunning(f.db,f.projectId,owner),false);
 for(const changed of [{...owner,proposalId:'wrong'}, {...owner,workflowId:'wrong'}, {...owner,commandId:'wrong'}, {...owner,ownerPid:2147483647}])
  assert.equal(isSetupReviewRunning(f.db,f.projectId,changed),true,'only all four real owner fields grant readonly exception');
});

test('setup review consumes exact later archive receipts readonly while archive writes remain deferred',async t=>{
 for(const mode of ['verified','tampered'] as const)await t.test(mode,async st=>{
  if(!checkSandboxStatus().available){st.skip('independent observation sandbox unavailable');return;}
  const f=fixture(st),config=f.update();
  f.db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,occurred_at)VALUES(?,'runtime','task',?,'RUNNING->FAILED','fixture stopped','2000-01-01T00:00:00Z')").run(f.workflow,f.taskId);
  assert.equal(writeProjectArchive(f.db,f.projectId).status,'verified');
  const paths=['_harness/archive.json','_harness/state/project.json'];
  if(mode==='tampered')writeFileSync(join(f.project,paths[1]!),'{"tampered":true}');
  const cmd=f.command(),result={...f.result,outOfBoundsPaths:[...f.result.outOfBoundsPaths,...paths]};
  const verify=ObservationVerifier.prototype.verify;
  st.mock.method(ObservationVerifier.prototype,'verify',async function(this:ObservationVerifier,...args:Parameters<typeof verify>){
   assert.equal(projectSafePoint(f.db,f.projectId,{tree:true,force:true}).status,'deferred','even the owner cannot write projections');
   assert.equal(verifiedProjectionChanges(f.db,f.projectId,'2000-01-01T00:00:00Z',paths),undefined,'unowned proof remains blocked');
   assert.ok(verifiedProjectionChanges(f.db,f.projectId,'2000-01-01T00:00:00Z',paths,{proposalId:f.id,workflowId:f.workflow,commandId:cmd.commandId,ownerPid:process.pid}));
   return verify.apply(this,args);
  });
  if(mode==='verified')assert.deepEqual(await continueFailedSetup(f.db,config,f.snapshot,cmd,f.runId,result,()=>{}),{requested:true});
  else{
   await assert.rejects(continueFailedSetup(f.db,config,f.snapshot,cmd,f.runId,result,()=>{}),/无法核对/);
   assert.equal(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id,f.workflow);
  }
 });
});

test('a successful stopped setup unit may review a real current blocking verdict without inventing an execution error',async t=>{
 if(!checkSandboxStatus().available){t.skip('independent observation sandbox unavailable');return;}
 const f=fixture(t,true);f.put(join(f.project,'_harness/setup/output.json'),'actual stopped setup output');
 const hash=new ArtifactFingerprinter(f.db,f.snapshot,f.project).fingerprint(f.workflow,['fbx']).fbx!;
 f.db.prepare('INSERT INTO artifact_version(workflow_id,kind,hash)VALUES(?,?,?)').run(f.workflow,'fbx',hash);
 const verifier=new ObservationVerifier({definition:f.snapshot.definition,observers:f.snapshot.capabilities.observers,thresholds:f.config.thresholdValues,
  project:f.project,toolRoot:f.tools,runRoot:join(f.home,'runs'),harnessHome:f.home,manifest:f.snapshot.manifest,variables:f.snapshot.variables,plan:()=>({})});
 const readings=await verifier.verify({runId:'real-old-validation',taskId:f.taskId,workflowId:f.workflow,projectId:f.projectId,stageId:'setup',attempt:1,idempotencyKey:'old-check',expectedOutputs:[]},{exitStatus:0,outputs:{}},{fbx:hash});
 assert.equal(readings[0]!.result,'violation');
 for(const reading of readings)f.db.prepare('INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result,basis)VALUES(?,?,?,?,?,?,?)').run('real-old-check',f.workflow,reading.checkId,reading.scope,reading.artifactHash,reading.result,reading.basis??null);
 const evidence=f.snapshot.capabilities.stages.setup!.unitySteps!.map((step,index)=>({index:index+1,method:step.method,exitCode:0,durationMs:1,log:'',errors:[],waits:0}));
 const result={...f.result,exitStatus:0,errorClass:undefined,outOfBoundsPaths:[] as string[],scanEvidence:[],unitySteps:evidence};
 f.put(join(f.runRoot,'unity-steps.json'),JSON.stringify({status:'finished',evidence}));
 f.db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(result),f.runId);
 f.db.prepare('DELETE FROM out_of_bounds_change WHERE workflow_id=?').run(f.workflow);
 assert.equal(canReviewFailedSetup(f.db,f.workflow,f.taskId),true);
 for(const mode of ['stale','newer-pass','unit-failed','outside','classless-nonzero'] as const){
  const saved=readFileSync(join(f.runRoot,'unity-steps.json'),'utf8'),fault=structuredClone(result);
  if(mode==='stale')f.put(join(f.project,'_harness/setup/output.json'),'different current artifact');
  if(mode==='newer-pass')f.db.prepare("INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result)VALUES('newer-pass',?,'setup_validation','edit',?,'pass')").run(f.workflow,hash);
  if(mode==='unit-failed'){fault.unitySteps[0]!.exitCode=1;f.put(join(f.runRoot,'unity-steps.json'),JSON.stringify({status:'finished',evidence:fault.unitySteps}));}
  if(mode==='outside')fault.outOfBoundsPaths.push('accepted-user.txt');
  if(mode==='classless-nonzero')fault.exitStatus=1;
  f.db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(fault),f.runId);
  assert.equal(canReviewFailedSetup(f.db,f.workflow,f.taskId),false,mode);
  if(mode==='stale')f.put(join(f.project,'_harness/setup/output.json'),'actual stopped setup output');
  if(mode==='newer-pass'){
   const again=await verifier.verify({runId:'real-rechecked-violation',taskId:f.taskId,workflowId:f.workflow,projectId:f.projectId,stageId:'setup',attempt:1,idempotencyKey:'again',expectedOutputs:[]},{exitStatus:0,outputs:{}},{fbx:hash});
   for(const reading of again)f.db.prepare('INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result,basis)VALUES(?,?,?,?,?,?,?)').run('real-rechecked-violation',f.workflow,reading.checkId,reading.scope,reading.artifactHash,reading.result,reading.basis??null);
  }
  f.db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(result),f.runId);writeFileSync(join(f.runRoot,'unity-steps.json'),saved);
 }
 const config=f.update();config.definitions['setup-flow']!.checks.find(check=>check.id==='setup_validation')!.rule='valid == true';
 t.mock.method(TaskRouter.prototype,'settledResult',async()=>result);
 // A real service reloads the revised process; no old definition or observer is hot-swapped into its Workflow.
 f.put(join(f.knowledge,'process.yaml'),stringify(config.definitions['setup-flow']));
 const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
 try{assert.equal((await client.call<any[]>('project.production.list',{projectId:f.projectId}))[0].progress.canResume,true);
  assert.deepEqual(await client.call('project.production.resume',f.command()),{requested:true});
 }finally{client.close();await service.stop();}
 const next=String(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id);
 assert.notEqual(next,f.workflow);assert.equal(JSON.parse(String(f.db.prepare('SELECT result_json FROM run WHERE id=?').get(f.runId)!.result_json)).errorClass,undefined);
 const setup=aggregateWorkflow(f.db,next,workflowSnapshot(f.db,next).definition).stages.setup!;
 assert.equal(setup.status,'blocked');assert.ok(setup.reasonCodes?.includes('missing_verdict'),'old setup checks were not inherited');
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM stage_completion WHERE workflow_id=? AND stage_id='setup'").get(next)!.n,0);
 const scheduler=workflowScheduler(f.db,config,next);let dispatched=false;
 t.mock.method(scheduler as unknown as {dispatch:(taskId:string)=>Promise<void>},'dispatch',async()=>{dispatched=true;});await scheduler.tick();
 assert.equal(dispatched,true,'ordinary scheduling reaches the executor boundary without calling a paid Provider');
 assert.equal(f.db.prepare("SELECT status FROM task WHERE workflow_id=? AND stage_id='setup'").get(next)!.status,'READY','the ordinary Scheduler makes the new setup dispatchable without a paid model');
});

async function blockedSetup(t:TestContext,validatorError=false){
 const f=fixture(t,true,validatorError);f.put(join(f.project,'_harness/setup/output.json'),'actual stopped setup output');
 const evidence=f.snapshot.capabilities.stages.setup!.unitySteps!.map((step,index)=>({index:index+1,method:step.method,exitCode:0,durationMs:1,log:'',errors:[],waits:0}));
 const result={...f.result,exitStatus:0,errorClass:undefined,outOfBoundsPaths:[] as string[],scanEvidence:[],unitySteps:evidence};
 f.put(join(f.runRoot,'unity-steps.json'),JSON.stringify({status:'finished',evidence}));
 f.db.prepare('DELETE FROM out_of_bounds_change WHERE workflow_id=?').run(f.workflow);
 f.db.prepare("UPDATE task SET status='RUNNING',inputs_json=?,retry_policy_json=? WHERE id=?").run(JSON.stringify({baseline:f.hashes}),JSON.stringify({maxRetries:0,maxCheckRetries:validatorError?2:0}),f.taskId);
 f.db.prepare("UPDATE run SET status='running',result_json=NULL WHERE id=?").run(f.runId);
 // Actual Runtime finish runs the independent observer, records Run-bound verifier evidence and settles BLOCKED.
 await workflowScheduler(f.db,f.config,f.workflow).finish(f.runId,result);
 assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.taskId)!.status,'BLOCKED');
 const recorded=JSON.parse(String(f.db.prepare('SELECT result_json FROM run WHERE id=?').get(f.runId)!.result_json));
 assert.deepEqual(recorded.verdictIds,[`${f.runId}:setup_validation`]);
 return {...f,result,recorded};
}

test('the real API offers stopped validation-BLOCKED setup and resumes with a new snapshot, preserving the old violation',async t=>{
 if(!checkSandboxStatus().available){t.skip('independent observation sandbox unavailable');return;}
 const f=await blockedSetup(t),config=f.update();
 config.definitions['setup-flow']!.checks.find(check=>check.id==='setup_validation')!.rule='valid == true';
 f.put(join(f.knowledge,'process.yaml'),stringify(config.definitions['setup-flow']));
 // Executor readback does not contain the Scheduler's database-only verdictIds.
 t.mock.method(TaskRouter.prototype,'settledResult',async()=>f.result);
 const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
 try{
  const offered=(await client.call<any[]>('project.production.list',{projectId:f.projectId}))[0].progress;
  assert.equal(offered.state,'interrupted');assert.equal(offered.canResume,true);assert.match(offered.reason,/独立检查/);
  const command=f.command();assert.deepEqual(await client.call('project.production.resume',command),{requested:true});
  assert.deepEqual(await client.call('project.production.resume',command),{requested:true});
 }finally{client.close();await service.stop();}
 const next=String(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id);
 assert.notEqual(next,f.workflow);assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.taskId)!.status,'BLOCKED');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM run').get()!.n,1,'no new AI or fake Run');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM task WHERE workflow_id=?').get(next)!.n,0);
 assert.equal(f.db.prepare('SELECT capabilities_json FROM workflow_definition WHERE workflow_id=?').get(f.workflow)!.capabilities_json,JSON.stringify(f.snapshot.capabilities));
 assert.equal(f.db.prepare('SELECT result FROM verdict WHERE id=?').get(`${f.runId}:setup_validation`)!.result,'violation');
 for(const id of ['intake','plan','environment'])assert.equal(aggregateWorkflow(f.db,next,workflowSnapshot(f.db,next).definition).stages[id]?.status,'passed');
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM stage_completion WHERE workflow_id=? AND stage_id='setup'").get(next)!.n,0);
 const event=JSON.parse(String(f.db.prepare("SELECT payload_json FROM event WHERE action='setup_version_continued'").get()!.payload_json));
 assert.equal(readFileSync(join(event.preserved,'project/accepted-user.txt'),'utf8'),'keep user original');
 assert.equal(setupReviewStatus(f.db,f.id)?.status,'succeeded');
});

test('actual API refuses unrelated or unproven BLOCKED states, stale checks, changed source and uncertain execution',async t=>{
 if(!checkSandboxStatus().available){t.skip('independent observation sandbox unavailable');return;}
 for(const mode of ['wait-human','wait-budget','unknown','new-run','lock','outside','external','error-bypass','unit-failed','prepare-failed','provider-failed','source-changed','stale-artifact','newer-pass','no-data','no-verdict-ref','foreign-run-verdict','no-verifier-event','no-verified-event','no-transition-proof','setup-complete','downstream'] as const)await t.test(mode,async st=>{
  const f=await blockedSetup(st);f.update();st.mock.method(TaskRouter.prototype,'settledResult',async()=>f.result);
  const alter=(file:string,value:string)=>writeFileSync(file,value);
  const result=structuredClone(f.recorded);
  if(mode==='wait-human'||mode==='wait-budget'||mode==='unknown')f.db.prepare('UPDATE task SET status=? WHERE id=?').run(mode==='unknown'?'RECOVERY_REQUIRED':mode==='wait-budget'?'READY':'WAITING_HUMAN',f.taskId);
  if(mode==='new-run')f.db.prepare("INSERT INTO run(id,task_id,attempt,status)VALUES('newer-unknown',?,2,'starting')").run(f.taskId);
  if(mode==='lock')f.db.prepare("INSERT INTO lock(resource,run_id,fencing,lease_until)VALUES('slot:unity_batch',?,1,'2099-01-01')").run(f.runId);
  if(mode==='outside')f.db.prepare("INSERT INTO out_of_bounds_change(workflow_id,stage_id,artifact)VALUES(?,'setup','workspace:unknown')").run(f.workflow);
  if(mode==='external')result.externalChanges=[{path:'outside'}];
  if(mode==='error-bypass')result.errorClass='tool_failure';
  if(mode==='unit-failed')result.unitySteps[0].exitCode=1;
  if(mode==='prepare-failed')result.prepare.exitStatus=1;
  if(mode==='provider-failed')alter(join(f.runRoot,'unity-provider-result.json'),JSON.stringify({exitStatus:1,errorClass:'auth'}));
  if(mode==='source-changed')alter(f.source,'changed source');
  if(mode==='stale-artifact')alter(join(f.project,'_harness/setup/output.json'),'changed setup output');
  if(mode==='newer-pass')f.db.prepare("INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result)SELECT 'newer-pass',workflow_id,check_id,scope,artifact_hash,'pass' FROM verdict WHERE id=?").run(`${f.runId}:setup_validation`);
  if(mode==='no-data')f.db.prepare("INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result)SELECT 'newer-no-data',workflow_id,check_id,scope,artifact_hash,'no_data' FROM verdict WHERE id=?").run(`${f.runId}:setup_validation`);
  if(mode==='no-verdict-ref')delete result.verdictIds;
  if(mode==='foreign-run-verdict')result.verdictIds=['some-other-run:setup_validation'];
  if(['no-verifier-event','no-verified-event'].includes(mode)){
   // Simulate missing historical evidence in this disposable fixture; production consumers never edit history.
   for(const row of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='event'").all())f.db.exec(`DROP TRIGGER "${row.name}"`);
   if(mode==='no-verifier-event')f.db.prepare("DELETE FROM event WHERE actor='verifier' AND entity_type='verdict'").run();
   else f.db.prepare("DELETE FROM event WHERE actor='runtime' AND entity_type='run' AND action='verified'").run();
  }
  if(mode==='no-transition-proof')f.db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)VALUES(?,'runtime','task',?,'VERIFYING->BLOCKED','fixture unrelated transition','{}')").run(f.workflow,f.taskId);
  if(mode==='setup-complete')f.db.prepare("INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json)VALUES(?,'setup','{}')").run(f.workflow);
  if(mode==='downstream')f.db.prepare("INSERT INTO task(id,workflow_id,stage_id,status,goal,capability,inputs_json)VALUES('downstream',?,'outfit','READY','fixture','fixture','{}')").run(f.workflow);
  f.db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(result),f.runId);
  const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
  try{
   const offered=(await client.call<any[]>('project.production.list',{projectId:f.projectId}))[0].progress;
   assert.equal(offered.canResume,false,mode);
   await assert.rejects(client.call('project.production.resume',f.command()));
   assert.equal(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id,f.workflow);
   assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow_definition').get()!.n,1);
  }finally{client.close();await service.stop();}
 });
});

test('actual stopped Executor and StageRouter readback consume only verified later projections in the resume API',async t=>{
 if(process.platform!=='win32'){t.skip('actual Windows named-job Executor readback; Linux real systemd execution is a separate opt-in');return;}
 if(!checkSandboxStatus().available){t.skip('independent observation sandbox unavailable');return;}
 for(const mode of ['verified','tampered','unknown','recorded-outside','known-changed','error-verified','error-tampered','error-unknown','error-recorded-outside'] as const)await t.test(mode,async st=>{
  const validatorError=mode.startsWith('error-'),kind=validatorError?mode.slice(6):mode;
  const f=await blockedSetup(st,validatorError);f.update();
  if(validatorError)f.put(join(f.tools,'observe-setup.mjs'),`import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],JSON.stringify({schema:'observation/0.1',metrics:{valid:false}}));`);
  // A real isolated no-op supervised process creates the stopped-unit exit. No model, and no mocked result/observe.
  const executor=createRunExecutor({projectDirectory:f.project,workspaceRepository:f.project,runRoot:join(f.home,'runs'),harnessHome:f.home,
   writableByRunner:{tool:[]},sandboxByRunner:{tool:'outer'},commandFor:()=>({runner:'tool',argv:[process.execPath,'-e','process.exit(0)'],cwd:f.runRoot})});
  const handle=await executor.start({runId:f.runId,taskId:f.taskId,workflowId:f.workflow,projectId:f.projectId,stageId:'setup',attempt:1,idempotencyKey:'actual-stopped-readback',expectedOutputs:[],allowedWrites:[]});
  await waitFor(()=>executor.observe(handle).state,
   {what:`Run ${f.runId} to report a stopped unit`,ready:state=>state==='exited',timeoutMs:60_000,intervalMs:50,
    detail:()=>`launched=${existsSync(join(f.runRoot,'command.json'))} exited=${existsSync(join(f.runRoot,'exit.json'))}`});
  const provider=executor.collect(handle);assert.equal(provider.exitStatus,0);
  f.put(join(f.runRoot,'unity-provider-result.json'),JSON.stringify(provider));
  f.put(join(f.runRoot,'scope-before.json'),JSON.stringify(taskScopeSnapshot(f.project)));
  f.db.prepare('UPDATE run SET process_ref=? WHERE id=?').run(`fake|${handle.ref}`,f.runId);
  assert.equal(writeProjectArchive(f.db,f.projectId).status,'verified');
  if(kind==='tampered')f.put(join(f.project,'_harness/state/project.json'),'tampered archive projection');
  if(kind==='unknown')f.put(join(f.project,'_harness/unknown-projection.json'),'not a Runtime projection');
  if(kind==='known-changed')f.put(join(f.project,'.vsconfig'),'{}');
  if(kind==='recorded-outside')f.db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify({...f.recorded,outOfBoundsPaths:['_harness/state/project.json']}),f.runId);
  const snapshot=workflowSnapshot(f.db,f.workflow),router=new StageRouter(f.db,loadConfig(f.home),snapshot).router(f.taskId);
  const observed=await router.settledResult({ref:`fake|${handle.ref}`});assert.ok(observed);
  assert.equal(observed.exitStatus,0);assert.equal(observed.prepare?.exitStatus,0);assert.equal(observed.unitySteps?.length,2);
  assert.ok(observed.outOfBoundsPaths?.includes('_harness/archive.json'),'actual scope collector sees Runtime projections after the stopped Run');
  assert.equal('verdictIds' in observed,false,'database-only verifier IDs are not forged by Executor');
  const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
  try{
   const before=(await client.call<any[]>('project.production.list',{projectId:f.projectId}))[0].progress;
   assert.equal(before.canResume,kind!=='recorded-outside','original scope violations cannot be relabeled as later projections');
   const command=f.command();
   if(kind==='verified'){
    assert.deepEqual(await client.call('project.production.resume',command),{requested:true});
    assert.deepEqual(await client.call('project.production.resume',command),{requested:true});
    const next=String(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id);
    assert.notEqual(next,f.workflow);assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.taskId)!.status,'BLOCKED');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM run').get()!.n,1,'no replayed or invented production');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM stage_completion WHERE workflow_id=? AND stage_id='setup'").get(next)!.n,0);
    if(validatorError)assert.equal(f.db.prepare('SELECT result FROM verdict WHERE id=?').get(`${f.runId}:setup_validation`)!.result,'error','old validator error is preserved, never inherited as PASS');
   }else{
    await assert.rejects(client.call('project.production.resume',command));
    assert.equal(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id,f.workflow);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow_definition').get()!.n,1);
   }
  }finally{client.close();await service.stop();}
 });
});

test('failed face preparation resumes through the existing API from fresh setup while preserving original approvals and failure',async t=>{
 if(!checkSandboxStatus().available){t.skip('independent observation sandbox unavailable');return;}
 const f=fixture(t,false,false,true);f.update();
 assert.equal(facePreparationFailureEvidence(f.db,f.home,f.snapshot,f.runId,f.result).length,5);
 assert.equal(canReviewFailedSetup(f.db,f.workflow,f.taskId),true);
 const original=JSON.stringify(f.db.prepare('SELECT result_json FROM run WHERE id=?').get(f.runId));
 t.mock.method(TaskRouter.prototype,'settledResult',async()=>f.result);
 const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
 let command:ReturnType<typeof f.command>;
 try{
  const offered=await client.call<any[]>('project.production.list',{projectId:f.projectId});
  assert.equal(offered[0].progress.canResume,true);
  command=f.command();assert.deepEqual(await client.call('project.production.resume',command),{requested:true});
  assert.deepEqual(await client.call('project.production.resume',command),{requested:true});
 }finally{client.close();await service.stop();}
 const next=String(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id);
 assert.notEqual(next,f.workflow);const state=aggregateWorkflow(f.db,next,workflowSnapshot(f.db,next).definition);
 for(const id of ['intake','plan','environment'])assert.equal(state.stages[id]?.status,'passed');
 assert.equal(state.stages.setup?.status,'open');assert.notEqual(state.stages.face_design?.status,'passed');
 assert.equal(f.db.prepare('SELECT count(*) n FROM task WHERE workflow_id=?').get(next)!.n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM run').get()!.n,1);
 assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.taskId)!.status,'FAILED');
 assert.equal(JSON.stringify(f.db.prepare('SELECT result_json FROM run WHERE id=?').get(f.runId)),original);
 const event=JSON.parse(String(f.db.prepare("SELECT payload_json FROM event WHERE action='setup_version_continued'").get()!.payload_json));
 assert.equal(event.failedStage,'face_design');assert.equal(event.restartStage,'setup');
 assert.equal(readFileSync(join(event.preserved,'project/_harness/setup/output.json'),'utf8'),'original setup');
 assert.equal(f.db.prepare("SELECT count(*) n FROM gate_decision WHERE workflow_id=? AND gate_id='face_choice'").get(next)!.n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM event WHERE workflow_id=? AND actor='human' AND entity_type='gate'").get(next)!.n,0);
});

test('face version continuation rejects untrusted execution, accepted downstream, changed inputs and incomplete backups without migrating',async t=>{
 if(!checkSandboxStatus().available){t.skip('independent observation sandbox unavailable');return;}
 for(const mode of ['forged-intent','forged-exit','wrong-command','wrong-write-boundary','running','lock','face-choice','downstream','source','ancestor','old-error','backup-link'] as const)await t.test(mode,async st=>{
  const f=fixture(st,false,false,mode==='forged-intent'?'forged':true),config=f.update(),result=structuredClone(f.result),unit=join(f.runRoot,`prepare-${f.runId}`);
  if(mode==='forged-exit')f.put(join(unit,'exit.json'),JSON.stringify({exitStatus:0,exit:{code:0}}));
  if(mode==='wrong-command'){const c=JSON.parse(readFileSync(join(unit,'command.json'),'utf8'));c.argv[2]='execute';f.put(join(unit,'command.json'),JSON.stringify(c));}
  if(mode==='wrong-write-boundary'){const c=JSON.parse(readFileSync(join(unit,'tool-request.json'),'utf8'));c.allowedWrites=[f.project];f.put(join(unit,'tool-request.json'),JSON.stringify(c));}
  if(mode==='running')f.db.prepare("UPDATE run SET status='running' WHERE id=?").run(f.runId);
  if(mode==='lock')f.db.prepare("INSERT INTO lock(resource,run_id,fencing,lease_until)VALUES('fixture-live-lock',?,1,'2099-01-01')").run(f.runId);
  if(mode==='face-choice')f.db.prepare("INSERT INTO gate_decision(workflow_id,gate_id,artifact_hash,result)VALUES(?,'face_choice','candidate','approved')").run(f.workflow);
  if(mode==='downstream')f.db.prepare("INSERT INTO task(id,workflow_id,stage_id,status,goal,capability)VALUES('downstream',?,'face','PASSED','fixture','face')").run(f.workflow);
  if(mode==='source')f.put(f.source,'changed authorized source');
  if(mode==='ancestor')f.put(join(f.project,'_harness/plan/plan.yaml'),'changed approved plan');
  if(mode==='old-error'){result.errorClass='timeout' as 'tool_failure';f.db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(result),f.runId);}
  if(mode==='backup-link'){const outside=join(f.root,'outside-backup');mkdirSync(outside);symlinkSync(outside,join(f.project,'linked-user-directory'),process.platform==='win32'?'junction':'dir');}
  await assert.rejects(continueFailedSetup(f.db,config,f.snapshot,f.command(),f.runId,result,()=>{}));
  assert.equal(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id,f.workflow);
  assert.equal(f.db.prepare('SELECT status FROM workflow WHERE id=?').get(f.workflow)!.status,'active');
  assert.equal(f.db.prepare('SELECT count(*) n FROM workflow').get()!.n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM run').get()!.n,1);
 });
});

test('approved technical continuation compares every business field while treating missing or null local selection compatibly',()=>{
 const context={intent:[{id:'original',content:'keep original goal'}],assets:[{id:'input',path:'source'}],brief:{customer_request:'original'}};
 assert.equal(productionBusinessContext(JSON.stringify(context)),productionBusinessContext(JSON.stringify({...context,localMaintenance:null})));
 assert.equal(productionBusinessContext(JSON.stringify(context)),productionBusinessContext(JSON.stringify({...context,localMaintenance:{id:'approved-tool-choice',contentHash:'new'}})));
 assert.notEqual(productionBusinessContext(JSON.stringify(context)),productionBusinessContext(JSON.stringify({...context,brief:{customer_request:'changed'}})));
 assert.notEqual(productionBusinessContext(JSON.stringify(context)),productionBusinessContext(JSON.stringify({...context,assets:[]})));
});

function faceLocalFixture(t:TestContext){
 const f=fixture(t,false,false,true),base=join(f.home,'managed/packs/baseline'),source=join(f.root,'local-candidate');
 for(const root of [base,source]){
  f.put(join(root,'pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:root===base?'baseline':'face-repair',version:'1',channel:root===base?'stable':'candidate',description:'fixture face preparation repair'}));
  for(const [old,next] of [['process.yaml','setup-flow.process.yaml'],['capabilities.yaml','setup-flow.capabilities.yaml'],['thresholds.yaml','thresholds.yaml']])
   f.put(join(root,'knowledge/process',next!),readFileSync(join(f.knowledge,old!),'utf8'));
  cpSync(f.tools,join(root,'tools'),{recursive:true});
 }
 f.put(join(source,'tools/face-tool.mjs'),'process.exit(0); // repaired prepare tool');
 const configFile=join(f.home,'config/harness.yaml'),settings=parse(readFileSync(configFile,'utf8'));
 Object.assign(settings,{toolRoot:join(base,'tools'),knowledgeRoot:join(base,'knowledge'),thresholdsFile:'process/thresholds.yaml',
  processDefinitions:{'setup-flow':{definition:'process/setup-flow.process.yaml',capabilities:'process/setup-flow.capabilities.yaml'}}});
 f.put(configFile,stringify(settings));const config=loadConfig(f.home);
 registerPackCandidate(f.db,f.home,source,{basePackId:'baseline',sourceKind:'ai',reason:'repair only face prepare',impact:{},permissions:{network:false,writes:['project','run']}});
 recordPackEvaluation(f.db,'face-repair',{suiteId:'fixture-face-preparation',suiteVersion:'1',isolation:'bwrap',
  baselineResults:[{caseId:'same-face',modelFamily:'codex',attempt:1,result:'pass',evidenceRef:'fixture-baseline'}],
  results:[{caseId:'same-face',modelFamily:'codex',attempt:1,result:'pass',evidenceRef:'fixture-candidate'}]});
 const choose=(candidateId:string|null)=>{
  const view=localMaintenanceView(f.db,config,f.projectId);
  return adoptLocalCandidate(f.db,config,f.projectId,{scope:'project',candidateId,expectedHash:view.candidates.find(c=>c.id===candidateId)?.contentHash,
   expectedToken:view.token,commandId:crypto.randomUUID()},'fixture-user');
 };
 const adoption=choose('face-repair');return{...f,config,base,source,choose,adoption};
}

test('the actual resume API independently rechecks and freezes the same human-adopted local face repair',async t=>{
 if(!checkSandboxStatus().available){t.skip('independent observation sandbox unavailable');return;}
 const f=faceLocalFixture(t),selection=localWorkflowSelection(f.db,f.config,f.projectId,'setup-flow')!;
 assert.equal(selection.adoption.id,f.adoption.id);assert.equal(selection.candidate.id,'face-repair');
 assert.notEqual(productionContext(f.db,f.projectId),String(f.db.prepare('SELECT context_json FROM production_proposal WHERE id=?').get(f.id)!.context_json));
 const observedRoots:string[]=[],verify=ObservationVerifier.prototype.verify;
 t.mock.method(ObservationVerifier.prototype,'verify',async function(this:ObservationVerifier,...args:Parameters<typeof verify>){
  observedRoots.push(this.context.toolRoot);return verify.apply(this,args);
 });
 t.mock.method(TaskRouter.prototype,'settledResult',async()=>f.result);
 const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
 try{assert.deepEqual(await client.call('project.production.resume',f.command()),{requested:true});}
 finally{client.close();await service.stop();}
 const next=String(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id),snapshot=workflowSnapshot(f.db,next);
 assert.notEqual(next,f.workflow);assert.equal(snapshot.toolRoot,selection.config.toolRoot);
 assert.deepEqual(observedRoots,[selection.config.toolRoot,selection.config.toolRoot,selection.config.toolRoot]);
 assert.equal(snapshot.tools['face-tool.mjs'],sha256File(join(selection.config.toolRoot,'face-tool.mjs')));
 assert.notEqual(snapshot.tools['face-tool.mjs'],f.snapshot.tools['face-tool.mjs']);
 assert.equal(aggregateWorkflow(f.db,next,snapshot.definition).stages.setup?.status,'open');
 assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.taskId)!.status,'FAILED');
 const proof=JSON.parse(String(f.db.prepare("SELECT payload_json FROM event WHERE action='setup_version_continued' ORDER BY seq DESC LIMIT 1").get()!.payload_json));
 assert.equal(proof.localSelection.id,f.adoption.id);
});

test('changing a local adoption during face ancestor recheck retains the original workflow atomically',async t=>{
 if(!checkSandboxStatus().available){t.skip('independent observation sandbox unavailable');return;}
 const f=faceLocalFixture(t),verify=ObservationVerifier.prototype.verify;let changed=false;
 t.mock.method(ObservationVerifier.prototype,'verify',async function(this:ObservationVerifier,...args:Parameters<typeof verify>){
  const result=await verify.apply(this,args);if(!changed){changed=true;f.choose(null);}return result;
 });
 await assert.rejects(continueFailedSetup(f.db,f.config,f.snapshot,f.command(),f.runId,f.result,()=>{}),/配置已变化/);
 assert.equal(changed,true);assert.equal(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.id)!.workflow_id,f.workflow);
 assert.equal(f.db.prepare('SELECT status FROM workflow WHERE id=?').get(f.workflow)!.status,'active');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow_definition').get()!.n,1);
});
