import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import test,{type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import type {EventMessage} from '../../src/api/protocol.ts';
import {stringify} from 'yaml';
import {loadConfig} from '../../src/config.ts';
import {openDatabase} from '../../src/state/db.ts';
import {createWorkflow,workflowScheduler} from '../../src/workflow/runtime.ts';
import {TaskRouter} from '../../src/task-cli.ts';
import {submitInteraction} from '../../src/interactions.ts';
import {productionContext,productionProposals,reconcileProduction} from '../../src/production-proposals.ts';
import {productionProgress,resumeProduction,cancelProduction} from '../../src/production-recovery.ts';
import {RuntimeService} from '../../src/api/server.ts';
import {ApiClient} from '../../src/api/client.ts';
import {removeTemp,fakeCommand,FAKE_PROVIDER} from '../fixtures/platform.ts';
import {waitFor} from '../fixtures/wait.ts';
import {writeProjectArchive,verifiedProjectionChanges} from '../../src/archive/projection.ts';
import type {Executor} from '../../src/runtime/interfaces.ts';

function fixture(t:TestContext, source = false) {
  const root=mkdtempSync(join(tmpdir(),'avh-production-recovery-'));t.after(()=>removeTemp(root));
  const home=join(root,'home'),workspace=join(root,'workspace'),project=join(workspace,'sample'),knowledge=join(root,'knowledge'),tools=join(root,'tools');
  for(const dir of [join(home,'config'),join(home,'state'),project,knowledge,join(tools,'审查/perception'),join(root,'export')])mkdirSync(dir,{recursive:true});
  execFileSync('git',['init','-q',project]);writeFileSync(join(project,'accepted.txt'),'accepted original');
  execFileSync('git',['-C',project,'add','accepted.txt']);execFileSync('git',['-C',project,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','baseline']);
  const process={schema:'process/0.1',id:'recovery-flow',version:'1',applies_to:{},artifacts:['plan'],
    stages:[{id:'plan',needs:[],produces:['plan'],requires:[],gates:[],invalidated_by:[]}],checks:[],gates:[],
    milestones:[{id:'UPLOAD_READY',requires_stages:'all',evidence_on:'plan'}]};
  const capabilities={schema:'capabilities/0.1',process:'recovery-flow',version:'1',artifacts:{plan:{paths:['_harness/plan/plan.yaml'],format:'yaml'}},
    stages:{plan:{mode:'provider',goal:'Write the plan',allowedWrites:['_harness/plan/'],maxRetries:0}},observers:{}};
  writeFileSync(join(knowledge,'process.yaml'),stringify(process));writeFileSync(join(knowledge,'capabilities.yaml'),stringify(capabilities));
  writeFileSync(join(knowledge,'thresholds.yaml'),stringify({schema:'thresholds/0.1',version:'1',t:{}}));
  for(const name of ['project_fingerprint.py','vpm_baseline_check.py','审查/perception/strip_audit.py'])writeFileSync(join(tools,name),'');
  const fake=fakeCommand(join(root,'fake-provider'),FAKE_PROVIDER);
  writeFileSync(join(home,'config/harness.yaml'),stringify({workspaceRoot:workspace,toolRoot:tools,knowledgeRoot:knowledge,
    exportRoots:[join(root,'export')],knownBodies:[],projectAliases:{},sampleNames:['sample'],
    defaultProfile:'recovery-flow',thresholdsFile:'thresholds.yaml',processDefinitions:{'recovery-flow':{definition:'process.yaml',capabilities:'capabilities.yaml'}},
    providers:[{id:'fake',type:'codex-cli',executable:fake,roles:['executor'],writable:[]}]}));
  const config=loadConfig(home),db=openDatabase(join(home,'state/harness.db'));t.after(()=>db.close());
  const body=join(root,'body.unitypackage');writeFileSync(body,'approved source');
  const sourceHash=createHash('sha256').update('approved source').digest('hex');
  const manifest=join(root,'manifest.yaml');writeFileSync(manifest,stringify({schema:'manifest/0.1',profile:'recovery-flow',request:'Make this avatar',assets:[{store:'library',item:source?body:'body',role:'body',...(source?{sha256:sourceHash}:{})}]}));
  const workflow=createWorkflow(db,config,project,'recovery-flow',manifest);
  const projectId=String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflow)!.project_id);
  const interaction=submitInteraction(db,projectId,{content:'Make this avatar',commandId:'initial'});
  db.prepare("UPDATE project_interaction SET status='completed' WHERE id=?").run(interaction.id);
  db.prepare(`INSERT INTO production_proposal(id,project_id,revision,profile,request,inputs_json,context_json,status,workflow_id)
    VALUES(?,?,1,'recovery-flow','Make this avatar','[]','{}','working',?)`).run(interaction.id,projectId,workflow);
  const row={id:interaction.id,project_id:projectId,revision:1,status:'working',workflow_id:workflow};
  if(source)db.prepare('UPDATE production_proposal SET inputs_json=?,context_json=? WHERE id=?')
    .run(JSON.stringify([{path:body,sha256:sourceHash}]),productionContext(db,projectId),row.id);
  let starts=0;
  const executor:Executor={start(){starts++;throw Object.assign(new Error('not launched'),{errorClass:'tool_failure',noSideEffects:true});},
    observe(){return {state:'unknown'};},collect(){throw new Error('not launched');},cancel(){return 'not_confirmed';}};
  const tick=()=>workflowScheduler(db,config,workflow,executor).tick();
  const command=(commandId:string)=>({projectId,id:row.id,commandId,expectedToken:productionProgress(db,row)!.token});
  return {root,home,project,projectId,config,db,workflow,row,tick,command,body,executor,starts:()=>starts};
}

test('the same production resume API preserves an early failure and freezes updated tools once without another user request',async t=>{
  const f=fixture(t,true);await f.tick();
  const original=f.db.prepare('SELECT id FROM task WHERE workflow_id=?').get(f.workflow)!;
  const frozen=String(f.db.prepare('SELECT capabilities_json FROM workflow_definition WHERE workflow_id=?').get(f.workflow)!.capabilities_json);
  mkdirSync(join(f.project,'_harness/intake'),{recursive:true});
  writeFileSync(join(f.project,'_harness/intake/inventory.json'),'original failed-plan input');
  writeFileSync(join(f.config.toolRoot,'inspect.mjs'),'console.log("updated installed tool");');
  f.config.capabilities['recovery-flow']!.stages.plan!.agentTools={'inspect-plan':['node','{toolRoot}/inspect.mjs']};
  const command=f.command('version-resume');
  assert.deepEqual(await resumeProduction(f.db,f.config,command),{requested:true});
  assert.deepEqual(await resumeProduction(f.db,f.config,command),{requested:true},'lost receipt never creates another Workflow');
  const next=String(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(f.row.id)!.workflow_id);
  assert.notEqual(next,f.workflow);assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow_definition').get()!.n,2);
  assert.equal(f.db.prepare('SELECT capabilities_json FROM workflow_definition WHERE workflow_id=?').get(f.workflow)!.capabilities_json,frozen);
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(original.id)!.status,'FAILED');
  assert.equal(f.db.prepare('SELECT status FROM workflow WHERE id=?').get(f.workflow)!.status,'cancelled');
  const event=JSON.parse(String(f.db.prepare("SELECT payload_json FROM event WHERE action='version_continued'").get()!.payload_json));
  assert.equal(readFileSync(join(event.preserved,'files/_harness/intake/inventory.json'),'utf8'),'original failed-plan input');
  const input=JSON.parse(String(f.db.prepare('SELECT manifest_json FROM workflow_definition WHERE workflow_id=?').get(next)!.manifest_json));
  assert.equal(input.request,'Make this avatar');assert.equal(input.assets[0].item,f.body);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_interaction').get()!.n,1);
  await workflowScheduler(f.db,f.config,next,f.executor).tick();assert.equal(f.starts(),2);
  assert.equal(readFileSync(join(f.project,'accepted.txt'),'utf8'),'accepted original');
});

test('version continuation refuses changed inputs, accepted production and prior construction before replacing the Workflow',async t=>{
  for(const reason of ['source','accepted','construction']){
    const f=fixture(t,true);await f.tick();
    f.config.capabilities['recovery-flow']!.stages.plan!.goal='updated tool contract';
    if(reason==='source')writeFileSync(f.body,'different source');
    if(reason==='accepted')f.db.prepare("INSERT INTO artifact_version(workflow_id,kind,hash) VALUES(?,'plan','accepted-plan')").run(f.workflow);
    if(reason==='construction')f.db.prepare("UPDATE task SET stage_id='setup' WHERE workflow_id=?").run(f.workflow);
    await assert.rejects(resumeProduction(f.db,f.config,f.command(`reject-${reason}`)),/素材已改变|已有制作成果|制作工具已更新|阶段记录无法核对|尚未确认可以安全继续/);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow_definition').get()!.n,1);
    assert.equal(f.db.prepare('SELECT status FROM workflow WHERE id=?').get(f.workflow)!.status,'active');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE action='version_continued'").get()!.n,0);
    assert.equal(f.starts(),1);
  }
});

test('project production API explains terminal failure and safely requests one formal redo without user task management',async t=>{
  const f=fixture(t);await f.tick();
  const original=f.db.prepare('SELECT id,status FROM task WHERE workflow_id=?').get(f.workflow)!;
  assert.equal(original.status,'FAILED');assert.equal(f.starts(),1);
  reconcileProduction(f.db);reconcileProduction(f.db);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE action='progress_changed'").get()!.n,1,'failure explanation is durable without duplicate messages');
  const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
  try {
    const shown=await client.call('project.production.list',{projectId:f.projectId}) as Array<{progress:{state:string;canResume:boolean;reason:string}}>; 
    assert.equal(shown[0]!.progress.state,'interrupted');assert.equal(shown[0]!.progress.canResume,true);
    assert.match(shown[0]!.progress.reason,/制作工具未完成/);
    const cmd=f.command('gui-continue');
    assert.deepEqual(await client.call('project.production.resume',cmd),{requested:true});
    assert.deepEqual(await client.call('project.production.resume',cmd),{requested:true},'lost response can be retried');
    await assert.rejects(client.call('project.production.resume',{...cmd,expectedToken:'different'}),/相同恢复命令/);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE action='requested_redo'").get()!.n,1);
  } finally {client.close();await service.stop();}
  assert.equal(productionProposals(f.db,f.projectId)[0]!.progress!.state,'resuming');
  await f.tick();assert.equal(f.starts(),2);assert.equal(f.db.prepare('SELECT count(*) AS n FROM task WHERE workflow_id=?').get(f.workflow)!.n,2);
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(original.id)!.status,'FAILED','historical failed Task is preserved');
  assert.equal(readFileSync(join(f.project,'accepted.txt'),'utf8'),'accepted original');
});

test('only exact later verified Runtime projection writes explain new recovery drift',async t=>{
  const f=fixture(t);await f.tick();
  const task=f.db.prepare('SELECT id FROM task WHERE workflow_id=?').get(f.workflow)!;
  const stopped=String(f.db.prepare("SELECT occurred_at FROM event WHERE entity_type='task' AND entity_id=? AND action LIKE '%->FAILED' ORDER BY seq DESC LIMIT 1").get(String(task.id))!.occurred_at);
  const written=writeProjectArchive(f.db,f.projectId);assert.ok(['verified','unchanged'].includes(written.status));
  const paths=['_harness/archive.json','_harness/state/project.json','_harness/records/events.json'];
  const proof=verifiedProjectionChanges(f.db,f.projectId,stopped,paths);
  assert.ok(proof);assert.equal(proof.revision,written.revision);assert.deepEqual(proof.paths,paths.slice().sort());
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM run').get()!.n,1,'read-only proof creates no execution');
  assert.equal(verifiedProjectionChanges(f.db,f.projectId,'9999-01-01T00:00:00Z',paths),undefined,'a write predating the stopped Run cannot justify drift');
  for(const path of ['_harness/plan/plan.yaml','_harness/unknown.json','accepted.txt','../elsewhere'])
    assert.equal(verifiedProjectionChanges(f.db,f.projectId,stopped,[path]),undefined,'never accepts a prefix or user output as Runtime provenance');
  const file=join(f.project,'_harness/state/project.json'),original=readFileSync(file,'utf8');
  writeFileSync(file,original+'\n');
  assert.equal(verifiedProjectionChanges(f.db,f.projectId,stopped,paths),undefined,'same-named valid JSON with different bytes is not a verified write');
  writeFileSync(file,original);
  const manifestPath=join(f.project,'_harness/archive.json'),manifest=readFileSync(manifestPath,'utf8');
  writeFileSync(manifestPath,manifest+'\n');
  assert.equal(verifiedProjectionChanges(f.db,f.projectId,stopped,paths),undefined,'self-described or altered manifests need the actual database write receipt');
  writeFileSync(manifestPath,manifest);
  assert.ok(verifiedProjectionChanges(f.db,f.projectId,stopped,paths));
  assert.equal(readFileSync(join(f.project,'accepted.txt'),'utf8'),'accepted original');
});

test('resume consumes later Runtime projection proof but refuses tampering and original unreviewed effects',async t=>{
  for(const mode of ['verified','tampered','original-outside'] as const)await t.test(mode,async st=>{
    const f=fixture(st);await f.tick();const run=f.db.prepare('SELECT * FROM run LIMIT 1').get()!;
    const recorded={...JSON.parse(String(run.result_json)),outOfBoundsPaths:mode==='original-outside'?['_harness/state/project.json']:[]};
    f.db.prepare("UPDATE run SET process_ref='fake|confirmed-exited',result_json=? WHERE id=?").run(JSON.stringify(recorded),run.id);
    writeProjectArchive(f.db,f.projectId);
    if(mode==='tampered')writeFileSync(join(f.project,'_harness/state/project.json'),'{}\n');
    st.mock.method(TaskRouter.prototype,'settledResult',async()=>({exitStatus:143,errorClass:'timeout',outputs:{},
      outOfBoundsPaths:['_harness/state/project.json','_harness/archive.json']}));
    const command=f.command('resume-after-projection');
    if(mode==='verified') {
      assert.deepEqual(await resumeProduction(f.db,f.config,command),{requested:true});
      assert.deepEqual(await resumeProduction(f.db,f.config,command),{requested:true});
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE action='later_projection_verified'").get()!.n,1);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE action='requested_redo'").get()!.n,1);
    } else {
      await assert.rejects(resumeProduction(f.db,f.config,command),/未确认的结果/);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE action='requested_redo'").get()!.n,0);
    }
    assert.equal(f.db.prepare('SELECT result_json FROM run WHERE id=?').get(String(run.id))!.result_json,JSON.stringify(recorded),'old Run evidence is never rewritten');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM task').get()!.n,1,'a request does not launch or fabricate a replacement');
    assert.equal(f.starts(),1);assert.equal(readFileSync(join(f.project,'accepted.txt'),'utf8'),'accepted original');
  });
});

test('project resume refuses stale views, newer requirements, live residue and unreviewed effects without dispatch',async t=>{
  for(const fault of ['stale','revision','residue','lock','outside','unknown'] as const)await t.test(fault,async st=>{
    const f=fixture(st);await f.tick();const input=f.command(`continue-${fault}`);
    const run=f.db.prepare('SELECT id FROM run').get()!;
    if(fault==='stale')input.expectedToken='stale';
    if(fault==='revision')f.db.prepare('UPDATE project_session SET revision=2 WHERE project_id=?').run(f.projectId);
    if(fault==='residue')f.db.prepare("UPDATE run SET status='running' WHERE id=?").run(run.id);
    if(fault==='lock')f.db.prepare("INSERT INTO lock(resource,run_id,fencing,lease_until) VALUES(?,?,1,'2099-01-01')").run('test:held',run.id);
    if(fault==='outside')f.db.prepare("INSERT INTO out_of_bounds_change(workflow_id,stage_id,artifact) VALUES(?,'plan','accepted.txt')").run(f.workflow);
    if(fault==='unknown')f.db.prepare("UPDATE run SET process_ref='fake|nonexistent',result_json=? WHERE id=?").run(JSON.stringify({exitStatus:143,outputs:{},errorClass:'timeout'}),run.id);
    if(!['stale','revision'].includes(fault))input.expectedToken=productionProgress(f.db,f.row)!.token;
    await assert.rejects(resumeProduction(f.db,f.config,input));
    assert.equal(f.starts(),1);assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE action='requested_redo'").get()!.n,0);
    assert.equal(readFileSync(join(f.project,'accepted.txt'),'utf8'),'accepted original');
  });
});

test('project cancel preserves accepted files and confirms shutdown before closing workflow',async t=>{
  const f=fixture(t);await f.tick();const input=f.command('cancel');
  assert.deepEqual(await cancelProduction(f.db,f.config,input),{confirmed:true});
  assert.deepEqual(await cancelProduction(f.db,f.config,input),{confirmed:true});
  assert.equal(f.db.prepare('SELECT status FROM workflow WHERE id=?').get(f.workflow)!.status,'cancelled');
  assert.equal(productionProposals(f.db,f.projectId)[0]!.progress!.state,'cancelled');
  assert.equal(readFileSync(join(f.project,'accepted.txt'),'utf8'),'accepted original');
  const unsafe=fixture(t);await unsafe.tick();const run=unsafe.db.prepare('SELECT id FROM run').get()!;
  unsafe.db.prepare("UPDATE run SET status='running',process_ref='fake|missing' WHERE id=?").run(run.id);
  assert.deepEqual(await cancelProduction(unsafe.db,unsafe.config,unsafe.command('unknown-cancel')),{confirmed:false});
  assert.equal(unsafe.db.prepare('SELECT status FROM workflow WHERE id=?').get(unsafe.workflow)!.status,'active');
  assert.equal(productionProgress(unsafe.db,unsafe.row)!.state,'stopping');
  unsafe.db.prepare("UPDATE task SET status='RECOVERY_REQUIRED' WHERE workflow_id=?").run(unsafe.workflow);
  unsafe.db.prepare("UPDATE run SET process_ref='fake|unreadable-execution-reference' WHERE id=?").run(run.id);
  assert.deepEqual(await cancelProduction(unsafe.db,unsafe.config,unsafe.command('malformed-cancel')),{confirmed:false},
    'an unreadable execution reference is a retained unknown outcome, not a raw exception or false shutdown');
  assert.equal(unsafe.db.prepare('SELECT status FROM workflow WHERE id=?').get(unsafe.workflow)!.status,'active');
  assert.equal(unsafe.db.prepare("SELECT count(*) AS n FROM event WHERE action='cancel_observation_failed'").get()!.n,1);
});

test('production read model shows live pi backoff from the Run log without changing recovery authority', async t => {
  const f=fixture(t);await f.tick();
  const run=f.db.prepare('SELECT id,task_id FROM run ORDER BY rowid DESC LIMIT 1').get()!;
  f.db.prepare("UPDATE task SET status='RUNNING' WHERE id=?").run(run.task_id);
  f.db.prepare("UPDATE run SET status='running',result_json=NULL WHERE id=?").run(run.id);
  const directory=join(f.home,'runs',String(run.id));mkdirSync(directory,{recursive:true});
  const service=new RuntimeService({home:f.home,scheduler:false,pollMs:20});await service.start();const client=await ApiClient.connect(f.home);
  t.after(async()=>{client.close();await service.stop();});
  const notices:EventMessage[]=[];const seq=await client.subscribe(event=>notices.push(event));
  const waitForNotice=async(count:number)=>{
    await waitFor(()=>notices.filter(event=>event.event==='progress').length,
      {what:`${count} live progress notice(s)`,ready:seen=>seen>=count,timeoutMs:30_000,intervalMs:25});
    assert.equal(notices.filter(event=>event.event==='progress').length,count,'live state reaches GUI subscribers without a DB event');
  };
  const shownProposals=async()=>await client.call('project.production.list',{projectId:f.projectId}) as ReturnType<typeof productionProposals>;
  writeFileSync(join(directory,'stdout.log'),JSON.stringify({type:'auto_retry_start',attempt:1,delayMs:5000})+'\n');
  await waitForNotice(1);
  assert.equal(f.db.prepare('SELECT MAX(seq) AS seq FROM event').get()!.seq,seq,'transient progress is not an audit event');
  assert.deepEqual(notices.filter(event=>event.event==='progress'),[{event:'progress',detail:'provider-connection'}]);
  await delay(80);assert.equal(notices.filter(event=>event.event==='progress').length,1,'unchanged backoff does not flood the GUI');
  const initial=productionProgress(f.db,f.row)!,shown=(await shownProposals())[0]!.progress!;
  assert.equal(shown.connectionRetrying,true);assert.match(shown.reason,/AI 连接中断.*正在退避重试/);
  assert.equal(shown.token,initial.token,'connection display never grants or invalidates recovery authority');
  assert.equal(shown.canResume,false,'a running retry cannot authorize another Run');
  writeFileSync(join(directory,'stdout.log'),JSON.stringify({type:'auto_retry_end',success:true})+'\n');
  await waitForNotice(2);
  assert.equal((await shownProposals())[0]!.progress!.connectionRetrying,undefined);
  f.db.prepare("UPDATE task SET status='FAILED' WHERE id=?").run(run.task_id);
  f.db.prepare("UPDATE run SET status='exited',result_json=? WHERE id=?")
    .run(JSON.stringify({exitStatus:0,errorClass:'network',errorMessage:'terminated',noSideEffects:true,outputs:{}}),run.id);
  const failed=(await shownProposals())[0]!.progress!;
  assert.match(failed.reason,/AI 连接中断.*可以继续.*无需重新描述要求/);assert.equal(failed.canResume,true);
  const command=f.command('network-continue');
  assert.deepEqual(await resumeProduction(f.db,f.config,command),{requested:true});
  assert.deepEqual(await resumeProduction(f.db,f.config,command),{requested:true});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM project_interaction').get()!.n,1,'the original requirement is preserved');
});
