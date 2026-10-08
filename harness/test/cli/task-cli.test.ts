import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../../src/config.ts';
import { recoveryAnalysisSpec } from '../../src/import/recovery.ts';
import { validateTakeoverOutputs, reconcileRecoveries } from '../../src/archive/takeover.ts';
import { openDatabase } from '../../src/state/db.ts';
import { acquireSchedulerLease } from '../../src/state/scheduler-lease.ts';
import { cancel, gateDecide, gateList, serveOnce, taskAcceptChanges, taskAdd, taskList, taskRecover, taskRedo, taskShow, taskScheduler, TaskRouter,
  parseSpec, taskScopeSnapshot, taskScopeChanges, toolDiagnostic } from '../../src/task-cli.ts';
import { transitionTask } from '../../src/runtime/transitions.ts';
import { submitInteraction, sessionRevision, coordinatorResult, retryInteraction, advanceInteractions } from '../../src/interactions.ts';
import { RuntimeService } from '../../src/api/server.ts';
import { ApiClient } from '../../src/api/client.ts';
import { currentIntent, recordIntent } from '../../src/project-intent.ts';
import { approveProduction } from '../../src/production-proposals.ts';
import { explorationContext, explorationImages, parseExploration, performExploration } from '../../src/asset-exploration.ts';
import { hostPlatform, processAlive } from '../../src/host-platform.ts';
import { harnessVersion, knowledgeVersion } from '../../src/provenance.ts';
import type { Executor, RunHandle, RunResult, RunSpec } from '../../src/runtime/interfaces.ts';
import { checkSandboxStatus } from '../../src/exec/check-runner.ts';
import { windowsHelper } from '../../src/exec/windows-helper.ts';
import { WindowsRunSupervisor } from '../../src/exec/windows-supervisor.ts';
import { windowsUnityOccupancy } from '../../src/exec/windows-unity.ts';
import { FAKE_PROVIDER, deadPid, fakeCommand, pathPattern, removeTemp, windows } from '../fixtures/platform.ts';
import { waitFor } from '../fixtures/wait.ts';

test('temporary task YAML cannot grant trusted Runtime output permissions', t => {
  const f = fixture(t), path = f.spec();
  writeFileSync(path, readFileSync(path, 'utf8') + '\nruntimeWrites: [_harness/face/preview/]\n');
  assert.throws(() => parseSpec(path, f.project), /任务不能自行授予/);
});

test('task scope follows a Git physical repository through a project alias without allowing escaping writes', t => {
  const f = fixture(t), alias = join(f.project, '..', 'alias');
  mkdirSync(join(f.project, 'nested'));
  symlinkSync(f.project, alias, windows ? 'junction' : 'dir');
  const project = join(alias, 'nested');
  const before = taskScopeSnapshot(project);
  assert.equal(before.repo, alias, 'Git physical root is mapped back to the verified project ancestry');
  writeFileSync(join(project, 'result.txt'), 'ok');
  assert.deepEqual(taskScopeChanges(project, [], before), ['nested/result.txt']);
  assert.deepEqual(taskScopeChanges(project, ['result.txt'], before), []);
  const outside = join(f.root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(project, 'escape'), windows ? 'junction' : 'dir');
  const spec = f.spec();
  writeFileSync(spec, stringify({ schema: 'task/0.1', goal: 'reject escape', role: 'executor',
    allowedWrites: ['escape'], expectedOutputs: ['run:response.json'] }));
  assert.throws(() => parseSpec(spec, join(f.project, 'nested')), /路径越出项目|符号链接/);
});

test('optimize Run permits only the Unity scene-template settings side effect', t => {
  const f = fixture(t);
  const capabilities = parse(readFileSync(new URL('../../builtin/knowledge/process/pc-recolor-outfit.capabilities.yaml', import.meta.url), 'utf8')) as {
    stages: Record<string, { allowedWrites: string[]; runtimeWrites?: string[] }>;
  };
  const optimize = capabilities.stages.optimize!;
  const before = taskScopeSnapshot(f.project);
  const sceneTemplateSettings = 'ProjectSettings/SceneTemplateSettings.json';
  mkdirSync(join(f.project, 'ProjectSettings'));
  writeFileSync(join(f.project, sceneTemplateSettings), '{}\n', { flag: 'wx' });
  writeFileSync(join(f.project, 'ProjectSettings/其他文件.json'), '{}\n', { flag: 'wx' });

  const outOfBounds = taskScopeChanges(f.project,
    [...optimize.allowedWrites, ...(optimize.runtimeWrites ?? [])], before);
  assert.equal(outOfBounds.includes(sceneTemplateSettings), false,
    'the optimize runtimeWrites contract permits Unity’s exact scene-template settings file');
  assert.deepEqual(outOfBounds, ['ProjectSettings/其他文件.json'],
    'an unrelated ProjectSettings file remains out of bounds');
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-task-cli-'));
  t.after(() => removeTemp(root));
  const home = join(root, 'home'), workspace = join(root, 'workspace'), project = join(workspace, 'sample');
  const tools = join(root, 'tools'), knowledge = join(root, 'knowledge'), exportRoot = join(root, 'export');
  for (const dir of [join(home, 'config'), join(home, 'state'), project, join(tools, '审查/perception'), knowledge, exportRoot])
    mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  writeFileSync(join(project, 'baseline.txt'), 'baseline\n');
  execFileSync('git', ['-C', project, 'add', 'baseline.txt']);
  execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'baseline']);
  for (const file of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py'])
    writeFileSync(join(tools, file), '');
  writeFileSync(join(knowledge, 'process.yaml'), readFileSync(new URL('../fixtures/process.yaml', import.meta.url)));
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: '1',
    t: { max_count: { value: 10, unit: 'items', maturity: 'accepted', source: 'test' } } }));
  const fake = fakeCommand(join(root, 'fake-codex'), FAKE_PROVIDER);
  writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: workspace, toolRoot: tools,
    knowledgeRoot: knowledge, exportRoots: [exportRoot], knownBodies: [], projectAliases: {}, sampleNames: ['sample'],
    processDefinitions: { 'synthetic-flow': 'process.yaml' }, defaultProfile: 'synthetic-flow', thresholdsFile: 'thresholds.yaml',
    providers: [{ id: 'fake', type: 'codex-cli', executable: fake, roles: ['executor'], writable: [project], maxConcurrentRuns: 1 }] }));
  const config = loadConfig(home);
  // Direct scheduler tests deliberately control source authorization in memory; live policy is tested through the API.
  delete config.assetSearchRootsConfigPath;
  const db = openDatabase(join(home, 'state/harness.db'));
  t.after(() => db.close());
  const specPath = join(root, 'task.yaml');
  const spec = (gate = false) => {
    writeFileSync(specPath, stringify({ schema: 'task/0.1', goal: 'write result', role: 'executor',
      allowedWrites: ['result.txt'], expectedOutputs: ['result.txt'],
      checks: [{ id: 'readback', path: 'result.txt', contains: 'ok' }], maxRetries: 1,
      ...(gate ? { gate: { id: 'approval', question: 'Accept result?', bind: 'result.txt' } } : {}) }));
    return specPath;
  };
  class FakeExecutor implements Executor {
    output = 'bad'; starts: string[] = [];
    confirmNeverStarted?: (runId: string) => boolean;
    start(run: RunSpec): RunHandle { this.starts.push(run.runId); return { ref: run.runId }; }
    observe(): { state: 'exited' } { return { state: 'exited' }; }
    collect(_handle: RunHandle): RunResult { writeFileSync(join(project, 'result.txt'), this.output); return { exitStatus: 0, outputs: {} }; }
    cancel(): 'confirmed' { return 'confirmed'; }
  }
  const executor = new FakeExecutor();
  const tick = () => serveOnce(db, config, () => executor);
  return { root, home, project, config, db, spec, executor, tick };
}

test('a temporary Unity task scheduler carries the validated machine slot count', t => {
  const f = fixture(t);
  f.config.unitySlots = { count: 3, source: 'env' };
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
  const file = join(f.root, 'unity-slots-task.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'synthetic Unity task', allowedWrites: [], expectedOutputs: ['run:result.json'],
    checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }], resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  assert.equal(taskScheduler(f.db, f.config, id, f.executor).config.slotCapacity.unity_batch, 3);
});

const windowsUnitReady = (() => { if (!windows) return false; try { windowsHelper(); return true; } catch { return false; } })();
(windowsUnitReady ? test : test.skip)('a TaskRouter Unity unit records the service Unity slot count for its worker', async t => {
  const f = fixture(t);
  f.config.unitySlots = { count: 3, source: 'env' };
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
  const file = join(f.root, 'worker-slots-task.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'synthetic Unity worker', allowedWrites: [], expectedOutputs: ['run:result.json'],
    checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }], resources: ['unity_batch'],
    unitySteps: [{ method: 'Example.Batch.Run' }]}));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const row = f.db.prepare(`SELECT t.id, t.workflow_id, w.project_id, p.path AS project_path, t.status,
    t.goal, w.plan_json, w.process_hash, t.stage_id FROM task t JOIN workflow w ON w.id=t.workflow_id
    JOIN project p ON p.id=w.project_id WHERE t.id=?`).get(id) as ConstructorParameters<typeof TaskRouter>[2];
  const router = new TaskRouter(f.db, f.config, row);
  const runId = 'worker-slots', runDir = join(f.home, 'runs', runId); mkdirSync(runDir, { recursive: true });
  const unit = (router as unknown as { unityUnit: (id: string) => { executor: { start: (spec: RunSpec) => Promise<RunHandle> }; handle: RunHandle } }).unityUnit(runId);
  t.mock.method(WindowsRunSupervisor.prototype, 'loaded', () => false);
  t.mock.method(WindowsRunSupervisor.prototype, 'launch', async () => unit.handle.ref);
  await unit.executor.start({ runId: `unity-${runId}`, taskId: id, workflowId: row.workflow_id, projectId: row.project_id,
    stageId: 'work', attempt: 1, idempotencyKey: 'worker-slots', expectedOutputs: [] });
  const command = JSON.parse(readFileSync(join(runDir, `unity-${runId}`, 'command.json'), 'utf8')) as { env: Record<string, string> };
  assert.equal(command.env.AVH_UNITY_SLOTS, '3');
});

test('source revocation rebuilds an undispatched coordinator without disclosing frozen observations or inventing a user reply', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());
  f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const sources=join(f.root,'sources');mkdirSync(sources);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC','base64');
  const original=join(sources,'private-look.png');writeFileSync(original,png);
  const config=loadConfig(f.home),service=new RuntimeService({home:f.home,scheduler:false});await service.start();
  const client=await ApiClient.connect(f.home);t.after(async()=>{client.close();await service.stop();});
  type Sources={roots:string[];revision:string};
  const initial=await client.call<Sources>('asset.sources.list');
  const granted=await client.call<Sources>('asset.sources.grant',{path:sources,consent:true,expectedRevision:initial.revision});
  const input=submitInteraction(f.db,project,{content:'Explore my available materials',commandId:'withdraw-sources'});
  const root=explorationContext(f.db,config,project,input.id).roots[0]!.id;
  const listed=performExploration(f.db,config,project,{op:'list',target:root,offset:0}) as {entries:{id:string}[]};
  const receiptWorkflow=String(f.db.prepare('SELECT workflow_id FROM task WHERE id=?').get(seed)!.workflow_id);
  f.db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('observation-receipt-owner',?,'work','inspect','executor','PASSED')").run(receiptWorkflow);
  for(const [ordinal,request,result] of [
    [1,{op:'list',target:root,offset:0},listed],
    [2,{op:'inspect',target:listed.entries[0]!.id},performExploration(f.db,config,project,{op:'inspect',target:listed.entries[0]!.id})],
  ] as const) f.db.prepare('INSERT INTO interaction_exploration(interaction_id,ordinal,task_id,request_json,result_json) VALUES(?,?,?,?,?)')
    .run(input.id,ordinal,ordinal===1?seed:'observation-receipt-owner',JSON.stringify(request),JSON.stringify(result));
  advanceInteractions(f.db,config);
  const oldId=String(f.db.prepare('SELECT task_id FROM project_interaction WHERE id=?').get(input.id)!.task_id);
  const old=f.db.prepare(`SELECT t.*,w.project_id,w.plan_json,w.process_hash,p.path AS project_path FROM task t
    JOIN workflow w ON w.id=t.workflow_id JOIN project p ON p.id=w.project_id WHERE t.id=?`).get(oldId)!;
  const frozen=JSON.parse(String(old.plan_json)).task;
  assert.equal(frozen.inputImages.length,1);assert.match(frozen.goal,/private-look\.png/);
  await client.call('asset.sources.revoke',{path:granted.roots[0],expectedRevision:granted.revision});
  const router=new TaskRouter(f.db,config,old as unknown as ConstructorParameters<typeof TaskRouter>[2]);
  await assert.rejects(router.start({runId:'obsolete-disclosure',taskId:oldId,workflowId:String(old.workflow_id),projectId:project,
    stageId:'work',attempt:1,idempotencyKey:'obsolete-disclosure',expectedOutputs:[]}),/授权已变化/);
  assert.equal(existsSync(join(f.home,'runs/obsolete-disclosure')),false,'rejected before any Provider setup or request artifact');
  advanceInteractions(f.db,config);
  const current=f.db.prepare('SELECT * FROM project_interaction WHERE id=?').get(input.id)!;
  assert.notEqual(current.task_id,oldId);assert.equal(current.revision,input.revision);assert.equal(current.status,'running');
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(oldId)!.status,'CANCELLED');
  assert.equal(f.db.prepare('SELECT plan_json FROM workflow WHERE id=?').get(String(old.workflow_id))!.plan_json,old.plan_json,'old task evidence is immutable');
  const revised=f.db.prepare('SELECT w.plan_json FROM task t JOIN workflow w ON w.id=t.workflow_id WHERE t.id=?').get(String(current.task_id))!;
  const task=JSON.parse(String(revised.plan_json)).task,inputs=JSON.parse(task.goal.split('\n').at(-1)).inputs;
  assert.deepEqual(task.inputImages,[]);assert.deepEqual(inputs.exploration.history,[]);assert.deepEqual(inputs.exploration.previousObservations,[]);
  assert.deepEqual(inputs.exploration.roots,[]);assert.equal(inputs.exploration.progress.executedOperations,2);
  assert.doesNotMatch(task.goal,/private-look\.png/);assert.equal(f.db.prepare("SELECT count(*) AS n FROM project_message WHERE role='user'").get()!.n,1);
  let dispatched=0;
  f.executor.collect=handle=>{
    dispatched++;mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});
    writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({schema:'interaction-result/0.1',requestId:input.id,
      revision:input.revision,kind:'answer',text:'素材访问已经撤销，保留原请求。'}));return {exitStatus:0,outputs:{}};
  };
  for(let n=0;n<3&&f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status!=='completed';n++)
    await serveOnce(f.db,config,()=>f.executor);
  assert.equal(dispatched,1);assert.deepEqual(readFileSync(original),png);assert.equal(f.db.prepare('SELECT count(*) AS n FROM interaction_exploration').get()!.n,2);
});

test('authorization changed at launch closes the intended Run and rebuilds safely, while an already started coordinator is retained', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id),sources=join(f.root,'sources');mkdirSync(sources);
  f.config.assetSearchRoots=[sources];const input=submitInteraction(f.db,project,{content:'Explore materials',commandId:'launch-policy'});
  advanceInteractions(f.db,f.config);const oldId=String(f.db.prepare('SELECT task_id FROM project_interaction WHERE id=?').get(input.id)!.task_id);
  const old=f.db.prepare(`SELECT t.*,w.project_id,w.plan_json,w.process_hash,p.path AS project_path FROM task t
    JOIN workflow w ON w.id=t.workflow_id JOIN project p ON p.id=w.project_id WHERE t.id=?`).get(oldId)!;
  class RevokingRouter extends TaskRouter {
    override async start(run:RunSpec):Promise<RunHandle>{f.config.assetSearchRoots=[];return super.start(run);}
  }
  await serveOnce(f.db,f.config,()=>new RevokingRouter(f.db,f.config,old as unknown as ConstructorParameters<typeof TaskRouter>[2]));
  const run=f.db.prepare('SELECT * FROM run WHERE task_id=?').get(oldId)!;
  assert.equal(run.status,'exited');assert.equal(run.process_ref,null);assert.equal(JSON.parse(String(run.result_json)).noSideEffects,true);
  assert.equal(f.db.prepare('SELECT status FROM dispatch_outbox WHERE run_id=?').get(String(run.id))!.status,'closed');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM lock WHERE run_id=?').get(String(run.id))!.n,0);
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(oldId)!.status,'CANCELLED');
  const current=String(f.db.prepare('SELECT task_id FROM project_interaction WHERE id=?').get(input.id)!.task_id);assert.notEqual(current,oldId);
  f.db.prepare("UPDATE task SET status='RUNNING' WHERE id=?").run(current);
  f.db.prepare("INSERT INTO run(id,task_id,attempt,status,process_ref) VALUES('already-started',?,1,'running','fake|live')").run(current);
  f.db.prepare("INSERT INTO lock(resource,run_id,fencing,lease_until) VALUES(?,'already-started',1,'9999-12-31T23:59:59Z')").run('project:'+project);
  advanceInteractions(f.db,f.config);
  assert.equal(f.db.prepare('SELECT task_id FROM project_interaction WHERE id=?').get(input.id)!.task_id,current);
  assert.equal(f.db.prepare('SELECT status FROM run WHERE id=\'already-started\'').get()!.status,'running');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM lock').get()!.n,1,'revocation does not pretend to recall an already disclosed request or release unknown ownership');
});

test('coordinator exploration persists observations and resumes without asking the user to select files', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());
  f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const sources=join(f.root,'sources');mkdirSync(sources);writeFileSync(join(sources,'body.prefab'),'independent source bytes');
  f.config.assetSearchRoots=[sources];
  const input=submitInteraction(f.db,project,{content:'Make a character from the picture',commandId:'explore'});
  f.executor.collect=handle=>{
    const task=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const goal=JSON.parse(String(task.plan_json)).task.goal as string;
    const {inputs}=JSON.parse(goal.split('\n').at(-1)!);
    const history=inputs.exploration.history;
    const result={schema:'interaction-result/0.1',requestId:input.id,revision:input.revision,text:'正在探索素材',
      ...(history.length===0?{kind:'explore',exploration:{op:'list',target:inputs.exploration.roots[0].id}}:
        history.length===1?{kind:'explore',exploration:{op:'inspect',target:history[0].result.entries[0].id}}:
        history.length===2?{kind:'explore',exploration:{op:'select',target:history[0].result.entries[0].id,kind:'avatar'}}:
        {kind:'answer'})};
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify(result));
    return{exitStatus:0,outputs:{}};
  };
  for(let i=0;i<8;i++){await f.tick();if(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status==='completed')break;}
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'completed');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM interaction_exploration').get()!.n,3);
  assert.equal(f.db.prepare('SELECT role FROM project_asset WHERE project_id=?').get(project)!.role,'candidate');
  assert.equal(sessionRevision(f.db,project),1,'internal observation cycles do not impersonate user replies');
  assert.equal(readFileSync(join(sources,'body.prefab'),'utf8'),'independent source bytes');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_proposal').get()!.n,0,'selecting a candidate is not approval');
});

// The coordinator reply channel is not unit-testable here. The fixture dispatches through a fake
// Executor, so ManagedProvider.collect never runs and no structuredResult exists; the live path does
// persist one, which is where this was observed. What is covered: the prompt contract above, and
// TaskVerifier.materializeReply, which records a coordination reply into run:response.json when the
// executor did not write it. Verified against a real codex run on Windows, where the sandbox refused
// the Run-directory write and the reply carried the answer instead.

test('package member evidence reaches the next managed coordinator without a user handoff', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());
  f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const sources=join(f.root,'sources');mkdirSync(sources);f.config.assetSearchRoots=[sources];
  execFileSync(hostPlatform.toolCommand('python'),['-c',`import io,sys,tarfile,zipfile
raw=io.BytesIO()
with tarfile.open(fileobj=raw,mode='w:gz') as t:
 for name,data in [('abc/pathname',b'Assets/Body.prefab'),('abc/asset',b'%YAML 1.1\\nmaterial: Silver')]:
  m=tarfile.TarInfo(name);m.size=len(data);t.addfile(m,io.BytesIO(data))
with zipfile.ZipFile(sys.argv[1],'w') as z: z.writestr('Body.unitypackage',raw.getvalue())
`,join(sources,'body.zip')]);
  const input=submitInteraction(f.db,project,{content:'Inspect the character materials',commandId:'package-evidence'});
  let observed=false;
  f.executor.collect=handle=>{
    const row=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const task=JSON.parse(String(row.plan_json)).task,{inputs}=JSON.parse(task.goal.split('\n').at(-1));
    const history=inputs.exploration.history;
    assert.match(task.goal,/member:包内路径/);
    if(history.length===4){
      assert.match(history[3].result.observation.content,/material: Silver/);
      assert.match(history[3].result.observation.sha256,/^[a-f0-9]{64}$/);
      assert.equal(history[3].result.observation.nextOffset,null);observed=true;
    }
    const response=history.length===0?{kind:'explore',exploration:{op:'list',target:inputs.exploration.roots[0].id}}:
      history.length===1?{kind:'explore',exploration:{op:'inspect',target:history[0].result.entries[0].id}}:
      history.length===2?{kind:'explore',exploration:{op:'inspect',target:history[0].result.entries[0].id,container:history[1].result.inventory.paths[0]}}:
      history.length===3?{kind:'explore',exploration:{op:'inspect',target:history[0].result.entries[0].id,container:history[1].result.inventory.paths[0],member:history[2].result.inventory.paths[0]}}:{kind:'answer'};
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({
      schema:'interaction-result/0.1',requestId:input.id,revision:input.revision,text:'分析素材结构',...response}));return {exitStatus:0,outputs:{}};
  };
  for(let i=0;i<10;i++){await f.tick();if(observed)break;}
  assert.equal(observed,true);assert.equal(sessionRevision(f.db,project),1);
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'completed');
  assert.equal(existsSync(join(sources,'Assets')),false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_proposal').get()!.n,0);
});

test('bounded evidence context retrieves complete observations without losing provenance or widening access',async t=>{
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const sources=join(f.root,'sources');mkdirSync(sources);f.config.assetSearchRoots=[sources];
  const original='Original header\n'+'x'.repeat(53000)+'\nOriginal tail';
  const source=join(sources,'notes.md');writeFileSync(source,original);
  const input=submitInteraction(f.db,project,{content:'Inspect the material evidence',commandId:'recall-evidence'});
  let receipt='',collected='',done=false;const progress:number[]=[];
  f.executor.collect=handle=>{
    const row=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const {inputs}=JSON.parse(JSON.parse(String(row.plan_json)).task.goal.split('\n').at(-1));
    const context=inputs.exploration,history=context.history;progress.push(context.progress.executedOperations);
    assert.ok(JSON.stringify(context).length<60000,'the full 53k source is not repeatedly injected');
    let response:object;
    if(history.length===0)response={kind:'explore',exploration:{op:'list',target:context.roots[0].id}};
    else if(history.length===1)response={kind:'explore',exploration:{op:'inspect',target:history[0].result.entries[0].id}};
    else if(history.length===2){
      assert.equal(history[1].projection.omitted,true);assert.ok(history[1].result.content.length<=1200);
      receipt=history[1].receiptId;writeFileSync(source,'source later changed');
      response={kind:'explore',exploration:{op:'recall',target:receipt,offset:0}};
    }else{
      const last=history.at(-1);assert.equal(last.projection.omitted,false,'the requested page reaches the next model intact');
      collected+=last.result.content;
      if(last.result.nextOffset!==null)response={kind:'explore',exploration:{op:'recall',target:receipt,offset:last.result.nextOffset}};
      else{assert.equal(JSON.parse(collected).result.content,original);done=true;response={kind:'answer'};}
    }
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({
      schema:'interaction-result/0.1',requestId:input.id,revision:input.revision,text:'读取已保存观察',...response}));return {exitStatus:0,outputs:{}};
  };
  for(let i=0;i<20;i++){await f.tick();if(done)break;}
  assert.equal(done,true);assert.deepEqual(progress,[0,1,2,3,4,5,6,7]);
  assert.equal(sessionRevision(f.db,project),1);
  assert.throws(()=>performExploration(f.db,f.config,'foreign',{op:'recall',target:receipt,offset:0}),/不存在/);
  const revoked={...f.config,assetSearchRoots:[]};
  assert.throws(()=>performExploration(f.db,revoked,project,{op:'recall',target:receipt,offset:0}),/授权/);
  const hidden=explorationContext(f.db,revoked,project,input.id);
  assert.deepEqual(hidden.history,[],'revoked source contents are omitted from automatic and recalled context');
  assert.equal(hidden.progress.executedOperations,7,'revocation does not rewrite actual operation counts');
  assert.throws(()=>parseExploration({op:'recall',target:receipt,offset:-1}),/偏移/);
});

test('inspected candidate images reach the next coordinator task as verified visual observations', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const sources=join(f.root,'sources');mkdirSync(sources);f.config.assetSearchRoots=[sources];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC','base64');
  const original=join(sources,'candidate.png');writeFileSync(original,png);
  const input=submitInteraction(f.db,project,{content:'Explore the candidate appearance',commandId:'candidate-image'});let observed=false;
  f.executor.collect=handle=>{
    const row=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const task=JSON.parse(String(row.plan_json)).task,{inputs}=JSON.parse(task.goal.split('\n').at(-1));
    const history=inputs.exploration.history;
    if(history.length===2){
      assert.equal(task.inputImages.length,1);assert.equal(inputs.referenceImages.length,0);
      assert.equal(inputs.observationImages[0].target,history[0].result.entries[0].id);
      assert.equal(inputs.observationImages[0].attachmentIndex,0);
      assert.deepEqual(readFileSync(join(f.project,task.inputImages[0].path)),png);observed=true;
    }
    const response=history.length===0?{kind:'explore',exploration:{op:'list',target:inputs.exploration.roots[0].id}}:
      history.length===1?{kind:'explore',exploration:{op:'inspect',target:history[0].result.entries[0].id}}:{kind:'answer'};
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({
      schema:'interaction-result/0.1',requestId:input.id,revision:input.revision,text:'观察图片',...response}));return {exitStatus:0,outputs:{}};
  };
  for(let i=0;i<6;i++){await f.tick();if(observed)break;}
  assert.equal(observed,true);assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'completed');
  assert.deepEqual(readFileSync(original),png);assert.equal(f.db.prepare('SELECT count(*) AS n FROM asset').get()!.n,0);
  const snapshot=explorationImages(f.db,f.config,project,1)[0]!.image;
  writeFileSync(original,'later source edit');
  assert.deepEqual(readFileSync(join(f.project,snapshot.path)),png,'the observation retains the inspected bytes');
  assert.deepEqual(explorationImages(f.db,{...f.config,assetSearchRoots:[]},project,1),[],'revoked roots stop future visual disclosure');
  writeFileSync(join(f.project,snapshot.path),Buffer.concat([png,Buffer.from('changed')]));
  assert.throws(()=>explorationImages(f.db,f.config,project,1),/版本已改变/);
});

test('invalid coordinator protocol is returned as bounded repair feedback without executing operations', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const input=submitInteraction(f.db,project,{content:'Decide the design',commandId:'repair'});
  let attempts=0;
  f.executor.collect=handle=>{
    const result={schema:'interaction-result/0.1',requestId:input.id,revision:input.revision,text:'设计中',
      ...(attempts++===0?{kind:'explore',exploration:{op:'shell',target:'invalid'}}:{kind:'answer'})};
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify(result));
    return{exitStatus:0,outputs:{}};
  };
  for(let i=0;i<5;i++){await f.tick();if(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status==='completed')break;}
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'completed');
  assert.equal(attempts,2);assert.equal(sessionRevision(f.db,project),1);
  const feedback=f.db.prepare('SELECT request_json,result_json FROM interaction_exploration').get()!;
  assert.equal(JSON.parse(String(feedback.request_json)).op,'repair_response');assert.match(String(feedback.result_json),/没有执行任何操作/);
  assert.equal(readFileSync(join(f.project,'baseline.txt'),'utf8'),'baseline\n');
});

test('exploration allowance rejects an entire batch and feeds back remaining work before summarizing', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const sources=join(f.root,'sources');mkdirSync(sources);f.config.assetSearchRoots=[sources];
  // This test fixes the conservative guard at its base window; expansion is tested separately.
  f.config.assetSearchRootsConfigPath=undefined;f.config.coordination={maxExplorationOperations:24};
  for(let n=0;n<24;n++)writeFileSync(join(sources,`${n}.prefab`),'source');
  const input=submitInteraction(f.db,project,{content:'Design a character',commandId:'allowance'});
  const remaining:number[]=[];let calls=0;
  f.executor.collect=handle=>{
    const plan=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const {inputs}=JSON.parse(JSON.parse(String(plan.plan_json)).task.goal.split('\n').at(-1));
    const context=inputs.exploration,history=context.history;remaining.push(context.limits.remainingOperations);
    let response:object;
    if(!history.length)response={kind:'explore',exploration:{op:'list',target:context.roots[0].id}};
    else if(context.limits.remainingOperations===0)response={kind:'answer'};
    else {
      const start=context.limits.usedOperations-1;
      const count=history.some((h:{request:{op:string}})=>h.request.op==='exploration_feedback')?7:8;
      response={kind:'explore',exploration:{operations:history[0].result.entries.slice(start,start+count).map((e:{id:string})=>({op:'inspect',target:e.id}))}};
    }
    calls++;mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});
    writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({schema:'interaction-result/0.1',requestId:input.id,
      revision:input.revision,text:'依据观察归纳方案',...response}));return {exitStatus:0,outputs:{}};
  };
  for(let i=0;i<12;i++){await f.tick();if(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status==='completed')break;}
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'completed');
  assert.deepEqual(remaining,[24,23,15,7,7,0]);assert.equal(calls,6);
  const feedback=f.db.prepare("SELECT result_json FROM interaction_exploration WHERE json_extract(request_json,'$.op')='exploration_feedback'").get()!;
  assert.equal(JSON.parse(String(feedback.result_json)).executed,false);
  assert.equal(sessionRevision(f.db,project),1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM asset').get()!.n,0);
});

test('useful exploration continues across windows without an extra user question and still stops at the configured guard', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const sources=join(f.root,'sources');mkdirSync(sources);f.config.assetSearchRoots=[sources];
  f.config.coordination={maxExplorationOperations:72};
  for(let n=0;n<80;n++)writeFileSync(join(sources,`${n}.prefab`),'source');
  const input=submitInteraction(f.db,project,{content:'Design a character',commandId:'renewed-window'});
  const remaining:number[]=[];let calls=0;
  f.executor.collect=handle=>{
    const plan=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const {inputs}=JSON.parse(JSON.parse(String(plan.plan_json)).task.goal.split('\n').at(-1));
    const context=inputs.exploration,history=context.history;remaining.push(context.limits.remainingOperations);
    let response:object;
    if(!history.length)response={kind:'explore',exploration:{op:'list',target:context.roots[0].id}};
    else if(context.limits.remainingOperations===0)response={kind:'answer'};
    else {
      const start=context.limits.usedOperations-1;
      const count=history.some((h:{request:{op:string}})=>h.request.op==='exploration_feedback')?7:8;
      response={kind:'explore',exploration:{operations:history[0].result.entries.slice(start,start+count).map((e:{id:string})=>({op:'inspect',target:e.id}))}};
    }
    calls++;mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});
    writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({schema:'interaction-result/0.1',requestId:input.id,
      revision:input.revision,text:'依据观察归纳方案',...response}));return {exitStatus:0,outputs:{}};
  };
  for(let i=0;i<30;i++){await f.tick();if(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status==='completed')break;}
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'completed');
  assert.deepEqual(remaining,[24,23,15,31,23,15,31,23,15,7,7,0]);assert.equal(calls,12);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM project_message WHERE role='user'").get()!.n,1,'Runtime continued without asking a second user question');
  const feedback=f.db.prepare("SELECT result_json FROM interaction_exploration WHERE json_extract(request_json,'$.op')='exploration_feedback'").get()!;
  assert.equal(JSON.parse(String(feedback.result_json)).executed,false);
  assert.equal(sessionRevision(f.db,project),1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM asset').get()!.n,0);
});

test('versioned intent survives omitted chat history and changes only the cited requirement', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  let input=submitInteraction(f.db,project,{content:'白色衣服，保留脸型。',commandId:'initial'});
  let updates:unknown[]=[{object:'avatar',attribute:'clothing',content:'白色衣服',sourceMessageId:input.id,quote:'白色衣服'},
    {object:'avatar',attribute:'face',content:'保留脸型',sourceMessageId:input.id,quote:'保留脸型'}];
  const original=input.id;let calls=0;
  f.executor.collect=handle=>{
    calls++;
    const plan=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const {inputs,messages}=JSON.parse(JSON.parse(String(plan.plan_json)).task.goal.split('\n').at(-1));
    if(input.revision===3){
      assert.ok(!messages.some((m:{id:string})=>m.id===original),'old chat is outside the window');
      assert.equal(inputs.intent.find((v:{attribute:string})=>v.attribute==='face').content,'保留脸型');
      assert.equal(inputs.intent.find((v:{attribute:string})=>v.attribute==='clothing').content,'黑色衣服');
    }
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({
      schema:'interaction-result/0.1',requestId:input.id,revision:input.revision,text:'理解当前要求',
      ...(updates.length?{kind:'intent',updates}:{kind:'answer'})}));updates=[];return {exitStatus:0,outputs:{}};
  };
  await f.tick();await f.tick();
  const first=currentIntent(f.db,project);assert.equal(first.length,2);
  input=submitInteraction(f.db,project,{content:'衣服换成黑色。',commandId:'correct',expectedRevision:1});
  updates=[{object:'avatar',attribute:'clothing',content:'黑色衣服',sourceMessageId:input.id,quote:'衣服换成黑色',
    replaces:first.find(v=>v.attribute==='clothing')!.id}];
  await f.tick();await f.tick();
  const corrected=currentIntent(f.db,project);assert.equal(corrected.find(v=>v.attribute==='face')!.id,first.find(v=>v.attribute==='face')!.id);
  for(let i=0;i<30;i++)f.db.prepare("INSERT INTO project_message(id,project_id,role,content,status) VALUES(?,?,'harness','旧资料说用白衣','note')").run(`noise-${i}`,project);
  input=submitInteraction(f.db,project,{content:'继续。',commandId:'continue',expectedRevision:2});
  await f.tick();assert.equal(calls,5);
  assert.throws(()=>recordIntent(f.db,project,input.id,3,[{object:'avatar',attribute:'clothing',content:'白色衣服',
    sourceMessageId:original,quote:'白色衣服',replaces:corrected.find(v=>v.attribute==='clothing')!.id}]),/旧意见不能复活/);
  assert.throws(()=>recordIntent(f.db,project,input.id,3,[{object:'avatar',attribute:'clothing',content:'白色衣服',
    sourceMessageId:'noise-0',quote:'白衣',replaces:corrected.find(v=>v.attribute==='clothing')!.id}]),/用户原文/);
  assert.deepEqual(currentIntent(f.db,project),corrected);
  const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
  try { assert.deepEqual(await client.call('project.intent.list',{projectId:project}),corrected); }
  finally {client.close();await service.stop();}
  input=submitInteraction(f.db,project,{content:'脸型不用保留了。',commandId:'withdraw',expectedRevision:3});
  updates=[{object:'avatar',attribute:'face',content:null,sourceMessageId:input.id,quote:'脸型不用保留了',
    replaces:corrected.find(v=>v.attribute==='face')!.id}];
  await f.tick();await f.tick();
  const withdrawn=currentIntent(f.db,project);
  assert.equal(withdrawn.find(v=>v.attribute==='face')!.content,null);
  assert.equal(withdrawn.find(v=>v.attribute==='clothing')!.content,'黑色衣服');
});

test('explicit continuation resumes a stopped coordinator without replacing requirements or observations', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const sources=join(f.root,'sources');mkdirSync(sources);f.config.assetSearchRoots=[sources];
  const input=submitInteraction(f.db,project,{content:'Keep the face, change the clothing',commandId:'original'});
  let calls=0;
  f.executor.collect=handle=>{
    calls++;
    if(calls>1)return {exitStatus:143,errorClass:'timeout',adapter:'pi-cli',outputs:{}};
    const plan=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const {inputs}=JSON.parse(JSON.parse(String(plan.plan_json)).task.goal.split('\n').at(-1));
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});
    writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({schema:'interaction-result/0.1',requestId:input.id,
      revision:input.revision,kind:'explore',text:'查看素材',exploration:{op:'list',target:inputs.exploration.roots[0].id}}));
    return {exitStatus:0,outputs:{}};
  };
  for(let i=0;i<4;i++)await f.tick();
  const row=f.db.prepare('SELECT * FROM project_interaction WHERE id=?').get(input.id)!;
  assert.equal(row.status,'failed');
  const command={id:input.id,commandId:'resume',expectedRevision:1,expectedTaskId:String(row.task_id)};
  const runs=f.db.prepare('SELECT id,status,result_json FROM run WHERE task_id=?').all(row.task_id!);
  f.db.prepare("UPDATE run SET status='running' WHERE id=?").run(runs[0]!.id!);
  assert.throws(()=>retryInteraction(f.db,project,command),/尚未确认/);
  f.db.prepare("UPDATE run SET status='exited' WHERE id=?").run(runs[0]!.id!);
  f.db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify({noSideEffects:false}),runs[0]!.id!);
  assert.throws(()=>retryInteraction(f.db,project,command),/未核清的副作用/);
  f.db.prepare('UPDATE run SET result_json=? WHERE id=?').run(runs[0]!.result_json!,runs[0]!.id!);
  assert.throws(()=>retryInteraction(f.db,project,{...command,expectedRevision:0}),/请求已改变/);
  const history=f.db.prepare('SELECT * FROM interaction_exploration').all();
  const service=new RuntimeService({home:f.home,scheduler:false});await service.start();
  const client=await ApiClient.connect(f.home);
  let receipt;
  try {
    receipt=await client.call('project.message.retry',{projectId:project,...command});
    assert.deepEqual(await client.call('project.message.retry',{projectId:project,...command}),receipt);
  } finally { client.close();await service.stop(); }
  assert.throws(()=>retryInteraction(f.db,project,{...command,expectedTaskId:seed}),/同一命令/);
  assert.equal(sessionRevision(f.db,project),1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM project_message WHERE role='user'").get()!.n,1);
  assert.deepEqual(f.db.prepare('SELECT * FROM interaction_exploration').all(),history);
  assert.deepEqual(f.db.prepare('SELECT id,status,result_json FROM run WHERE task_id=?').all(row.task_id!),runs);
  f.executor.collect=handle=>{
    const plan=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const {inputs,messages}=JSON.parse(JSON.parse(String(plan.plan_json)).task.goal.split('\n').at(-1));
    assert.equal(inputs.exploration.history.length,1);
    assert.ok(messages.some((m:{content:string})=>m.content==='Keep the face, change the clothing'));
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({
      schema:'interaction-result/0.1',requestId:input.id,revision:1,kind:'answer',text:'继续原要求，尚未制作。'}));
    return {exitStatus:0,outputs:{}};
  };
  await f.tick();
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'completed');
  assert.deepEqual(retryInteraction(f.db,project,command),receipt,'lost acknowledgements cannot dispatch again');
  assert.throws(()=>retryInteraction(f.db,project,{...command,commandId:'new-retry'}),/请求已改变/);
});

test('directory selections return exact recovery and a passed read-only task can resume through the GUI API',async t=>{
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const sources=join(f.root,'sources');mkdirSync(sources);f.config.assetSearchRoots=[sources];
  writeFileSync(join(sources,'body.unitypackage'),'body');
  for(const name of ['skin','eyes']){mkdirSync(join(sources,name));writeFileSync(join(sources,name,'chosen.zip'),name);}
  f.config.capabilities[f.config.defaultProfile]={schema:'capabilities/0.1',process:f.config.defaultProfile,version:'test',artifacts:{},stages:{},observers:{}};
  const input=submitInteraction(f.db,project,{content:'Make my character from the reference',commandId:'directory-inputs'});
  let calls=0;
  f.executor.collect=handle=>{
    calls++;
    const plan=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const {inputs}=JSON.parse(JSON.parse(String(plan.plan_json)).task.goal.split('\n').at(-1));
    const history=inputs.exploration.history;
    let response:object;
    if(calls===1)response={kind:'explore',exploration:{op:'list',target:inputs.exploration.roots[0].id}};
    else if(calls<=5){
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM asset').get()!.n,0,'a rejected selection must not leave a body registration');
      const entries=history[0].result.entries;
      response={kind:'production',proposal:{request:'Use this body and textures',assetIds:[],
        selections:entries.map((entry:{id:string;name:string})=>({target:entry.id,kind:entry.name.startsWith('body')?'avatar':'texture'}))}};
    }else if(calls===6){
      const feedback=history.filter((item:{request:{op:string}})=>item.request.op==='repair_response').at(-1).result;
      assert.equal(feedback.recovery.category,'production-selection');
      assert.equal(feedback.recovery.invalidSelections.length,2);
      assert.doesNotMatch(JSON.stringify(feedback.recovery),new RegExp(sources.replaceAll('\\','\\\\')));
      response={kind:'explore',exploration:{operations:feedback.recovery.invalidSelections.map((item:{nextOperation:object})=>item.nextOperation)}};
    }else{
      const body=history[0].result.entries.find((entry:{name:string})=>entry.name.startsWith('body'));
      const actual=history.at(-1).result.results;
      response={kind:'production',proposal:{request:'Use this body and textures',assetIds:[],selections:[{target:body.id,kind:'avatar'},
        ...actual.map((item:{result:{entries:Array<{id:string}>}})=>({target:item.result.entries[0]!.id,kind:'texture'}))]}};
    }
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({
      schema:'interaction-result/0.1',requestId:input.id,revision:input.revision,text:'Prepare the materials',...response}));
    return{exitStatus:0,outputs:{}};
  };
  for(let n=0;n<8;n++){await f.tick();if(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status==='failed')break;}
  const stopped=f.db.prepare('SELECT * FROM project_interaction WHERE id=?').get(input.id)!;
  assert.equal(stopped.status,'failed');assert.equal(calls,4);
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(stopped.task_id)!.status,'PASSED');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_proposal').get()!.n,0);
  const history=f.db.prepare('SELECT * FROM interaction_exploration').all();
  const configFile=join(f.home,'config/harness.yaml');
  writeFileSync(configFile,readFileSync(configFile,'utf8')+'\n'+stringify({assetSearchRoots:[sources]}));
  const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
  try{
    const command={projectId:project,id:input.id,commandId:'resume-directory-inputs',expectedRevision:input.revision,expectedTaskId:stopped.task_id};
    const receipt=await client.call('project.message.retry',command);assert.deepEqual(await client.call('project.message.retry',command),receipt);
  }finally{client.close();await service.stop();}
  assert.deepEqual(f.db.prepare('SELECT * FROM interaction_exploration').all(),history,'retry preserves the complete failed evidence');
  for(let n=0;n<7;n++){await f.tick();if(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status==='completed')break;}
  assert.equal(calls,7,JSON.stringify({interaction:f.db.prepare('SELECT status,error FROM project_interaction WHERE id=?').get(input.id),
    history:f.db.prepare('SELECT ordinal,request_json,result_json FROM interaction_exploration WHERE interaction_id=?').all(input.id)}));
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'completed');
  const proposal=f.db.prepare('SELECT * FROM production_proposal WHERE id=?').get(input.id)!;
  assert.equal(proposal.status,'proposed');assert.equal(proposal.workflow_id,null);
  assert.equal(JSON.parse(String(proposal.inputs_json)).length,3);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM project_message WHERE role='user'").get()!.n,1);
  assert.equal(sessionRevision(f.db,project),input.revision);
  assert.equal(readFileSync(join(sources,'skin/chosen.zip'),'utf8'),'skin');
});

test('stopped coordinator network failure resumes once without a new user message', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const input=submitInteraction(f.db,project,{content:'Design from my image',commandId:'connection'});
  let calls=0;
  f.executor.collect=handle=>{
    calls++;
    if(calls===1)return {exitStatus:0,errorClass:'network',adapter:'pi-cli',outputs:{}};
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});
    writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({schema:'interaction-result/0.1',
      requestId:input.id,revision:input.revision,kind:'answer',text:'继续原设计'}));
    return {exitStatus:0,outputs:{}};
  };
  for(let i=0;i<6;i++){await f.tick();if(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status==='completed')break;}
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'completed');
  assert.equal(calls,2);assert.equal(sessionRevision(f.db,project),1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM project_message WHERE role='user'").get()!.n,1);
  assert.equal(JSON.parse(String(f.db.prepare('SELECT request_json FROM interaction_exploration').get()!.request_json)).op,'retry_connection');
  const next=submitInteraction(f.db,project,{content:'Continue',commandId:'connection-again'});
  f.executor.collect=()=>{calls++;return {exitStatus:0,errorClass:'network',adapter:'pi-cli',outputs:{}};};
  for(let i=0;i<6;i++)await f.tick();
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(next.id)!.status,'failed');
  assert.equal(calls,4,'a persistent outage gets only one additional call per interaction');
});

test('repeated exploration feedback ends in a reachable question without replaying operations', async t => {
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const sources=join(f.root,'sources');mkdirSync(sources);f.config.assetSearchRoots=[sources];
  const input=submitInteraction(f.db,project,{content:'Explore materials',commandId:'repeated'});let calls=0;
  f.executor.collect=handle=>{
    const target=String(f.db.prepare('SELECT id FROM exploration_resource WHERE project_id=?').get(project)!.id);
    calls++;mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});
    writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({schema:'interaction-result/0.1',requestId:input.id,
      revision:input.revision,kind:'explore',text:'继续探索',exploration:{op:'list',target}}));return {exitStatus:0,outputs:{}};
  };
  for(let i=0;i<8;i++)await f.tick();
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'awaiting_user');
  assert.equal(calls,4);assert.equal(f.db.prepare('SELECT count(*) AS n FROM interaction_exploration').get()!.n,3);
  assert.equal(sessionRevision(f.db,project),1);assert.match(String(f.db.prepare("SELECT content FROM project_message WHERE role='harness'").get()!.content),/没有产出工程/);
  const followup=submitInteraction(f.db,project,{content:'先看已有发现',commandId:'show-observations',replyTo:input.id,expectedRevision:1});
  f.executor.collect=handle=>{
    const plan=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const {inputs}=JSON.parse(JSON.parse(String(plan.plan_json)).task.goal.split('\n').at(-1));
    assert.equal(inputs.exploration.previousObservations[0].interactionId,input.id);
    assert.equal(inputs.exploration.previousObservations[0].request.op,'list');
    assert.deepEqual(inputs.exploration.previousObservations[0].result.entries,[]);
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});
    writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({schema:'interaction-result/0.1',requestId:followup.id,
      revision:followup.revision,kind:'answer',text:'先前可访问目录没有候选条目，未制作工程。'}));return {exitStatus:0,outputs:{}};
  };
  await f.tick();assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(followup.id)!.status,'completed');
});

test('project messages dispatch a managed coordinator, persist its question and resume from a versioned answer', async t => {
  const f = fixture(t), seed = taskAdd(f.config, f.db, 'sample', f.spec());
  f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project = (f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get() as { project_id: string }).project_id;
  const first = submitInteraction(f.db, project, { content: 'Help me decide the outfit', commandId: 'one', expectedRevision: 0 });
  assert.equal(submitInteraction(f.db, project, { content: 'Help me decide the outfit', commandId: 'one', expectedRevision: 0 }).id, first.id);
  assert.equal(sessionRevision(f.db, project), 1);
  assert.throws(() => submitInteraction(f.db, project, { content: 'different', commandId: 'one', expectedRevision: 0 }), /同一命令/);
  assert.throws(() => submitInteraction(f.db, project, { content: 'stale', commandId: 'stale', expectedRevision: 0 }), /会话已更新/);
  let current = first, kind = 'clarify';
  f.executor.collect = handle => {
    mkdirSync(join(f.home, 'runs', handle.ref), { recursive: true });
    writeFileSync(join(f.home, 'runs', handle.ref, 'response.json'), JSON.stringify({ schema: 'interaction-result/0.1',
      requestId: current.id, revision: current.revision, kind, text: kind === 'clarify' ? '希望保留哪套服装？' : '已记录保留原服装的要求，尚未施工。' }));
    return { exitStatus: 0, outputs: {} };
  };
  await f.tick();
  const firstTask = (f.db.prepare('SELECT task_id FROM project_interaction WHERE id=?').get(first.id) as { task_id: string }).task_id;
  assert.equal((f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(first.id) as { status: string }).status, 'awaiting_user', taskShow(f.db, firstTask));
  const reopen = openDatabase(join(f.home, 'state/harness.db'));
  try { assert.equal(sessionRevision(reopen, project), 1); } finally { reopen.close(); }
  current = submitInteraction(f.db, project, { content: 'Keep the original', commandId: 'two', expectedRevision: 1, replyTo: first.id });
  kind = 'answer';
  await f.tick();
  assert.equal((f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(current.id) as { status: string }).status, 'completed');
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM project_message WHERE role='harness'").get() as { n: number }).n, 2);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM project_interaction WHERE task_id IS NOT NULL').get() as { n: number }).n, 2);
  assert.equal(submitInteraction(f.db, project, { content: 'Help me decide the outfit', commandId: 'one', expectedRevision: 0 }).id, first.id,
    'a retry of an old delivered command returns its receipt even after a later revision');
  assert.equal(readFileSync(join(f.project, 'baseline.txt'), 'utf8'), 'baseline\n');
  assert.throws(() => submitInteraction(f.db, project, { content: 'late', commandId: 'three', expectedRevision: 2, replyTo: first.id }), /问题已失效/);
});

test('coordinator replies cannot claim a different revision or smuggle production operations', () => {
  const response = { schema: 'interaction-result/0.1', requestId: 'request', revision: 3, kind: 'answer', text: '说明' };
  assert.deepEqual(coordinatorResult(response, 'request', 3), { kind: 'answer', text: '说明' });
  assert.throws(() => coordinatorResult(response, 'request', 4));
  assert.throws(() => coordinatorResult({ ...response, execute: ['delete'] }, 'request', 3));
  assert.throws(() => coordinatorResult({ ...response, text: '' }, 'request', 3));
  const proposal = { request: 'Change color and preserve the face', assetIds: ['body'] };
  assert.deepEqual(coordinatorResult({ ...response, kind: 'production', proposal }, 'request', 3), { kind: 'production', text: '说明', proposal });
  assert.throws(() => coordinatorResult({ ...response, kind: 'production', proposal: { ...proposal, approved: true } }, 'request', 3));
  assert.throws(() => coordinatorResult({ ...response, kind: 'production', proposal: { ...proposal, assetIds: ['body', 'body'] } }, 'request', 3));
  const selection={target:'r_0123456789abcdef',kind:'avatar'};
  assert.deepEqual(coordinatorResult({...response,kind:'production',proposal:{...proposal,assetIds:[],selections:[selection]}},'request',3),
    {kind:'production',text:'说明',proposal:{...proposal,assetIds:[],selections:[selection]}});
  for(const selections of [[{...selection,path:'private/file'}],[{...selection,approved:true}],[],[selection,selection]])
    assert.throws(()=>coordinatorResult({...response,kind:'production',proposal:{...proposal,assetIds:[],selections}},'request',3));
  assert.throws(()=>coordinatorResult({...response,kind:'production',proposal:{...proposal,assetIds:[]}},'request',3));
  assert.throws(() => coordinatorResult({ ...response, proposal }, 'request', 3));
});

test('production coordinator cannot grant itself a local candidate or default policy',async t=>{
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());
  f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const request=submitInteraction(f.db,project,{content:'修复当前问题',commandId:'repair'});
  f.executor.collect=handle=>{
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});
    writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({schema:'interaction-result/0.1',requestId:request.id,
      revision:request.revision,kind:'production',text:'申请修复',proposal:{request:'修复',assetIds:['body'],candidateId:'unapproved',scope:'local'}}));
    return{exitStatus:0,outputs:{}};
  };
  for(let i=0;i<6&&f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(request.id)!.status!=='failed';i++){
    await f.tick();assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_pack_adoption').get()!.n,0,'bounded protocol repair never grants authority');
  }
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(request.id)!.status,'failed');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_proposal').get()!.n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM local_pack_adoption').get()!.n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow_definition').get()!.n,0);
});

test('coordinator production proposals bind inputs and never start construction without approval', async t => {
  const f = fixture(t), seed = taskAdd(f.config, f.db, 'sample', f.spec());
  f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project = (f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get() as { project_id: string }).project_id;
  const assetPath = join(f.root, 'body.unitypackage'); writeFileSync(assetPath, 'frozen source');
  f.db.prepare("INSERT INTO asset(id,path,name,kind) VALUES('body',?,'Test body','avatar')").run(assetPath);
  f.db.prepare("INSERT INTO project_asset(project_id,asset_id,role) VALUES(?,'body','source')").run(project);
  f.config.capabilities[f.config.defaultProfile] = { schema: 'capabilities/0.1', process: f.config.defaultProfile,
    version: 'test', artifacts: {}, stages: {}, observers: {} };
  let request = submitInteraction(f.db, project, { content: 'Change color', commandId: 'produce' });
  let changeInputs = false;
  f.executor.collect = handle => {
    if (changeInputs) f.db.prepare("UPDATE asset SET name='Changed selection' WHERE id='body'").run();
    mkdirSync(join(f.home, 'runs', handle.ref), { recursive: true });
    writeFileSync(join(f.home, 'runs', handle.ref, 'response.json'), JSON.stringify({ schema: 'interaction-result/0.1',
      requestId: request.id, revision: request.revision, kind: 'production', text: '请检查制作提案，尚未施工。',
      proposal: { request: 'Change color and preserve the face', assetIds: ['body'] } }));
    return { exitStatus: 0, outputs: {} };
  };
  const workflows = f.db.prepare('SELECT count(*) AS n FROM workflow').get()!.n;
  await f.tick(); await f.tick();
  const proposal = f.db.prepare('SELECT status,workflow_id,inputs_json FROM production_proposal WHERE id=?').get(request.id)!;
  assert.equal(proposal.status, 'proposed'); assert.equal(proposal.workflow_id, null);
  assert.equal(JSON.parse(String(proposal.inputs_json))[0].sha256, createHash('sha256').update('frozen source').digest('hex'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow').get()!.n, Number(workflows) + 1,
    'only the coordinator task wrapper is created, not a production workflow');
  assert.equal(f.executor.starts.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_proposal').get()!.n, 1);
  writeFileSync(assetPath, 'changed source');
  assert.throws(() => approveProduction(f.db, f.config, request.id, 'approve-drift', request.revision), /素材文件已改变/);
  assert.equal(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(request.id)!.workflow_id, null);
  writeFileSync(assetPath, 'frozen source');
  request = submitInteraction(f.db, project, { content: 'Use another color', commandId: 'changed' });
  changeInputs = true; await f.tick();
  assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(request.id)!.status, 'failed');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_proposal').get()!.n, 1);
  assert.equal(readFileSync(assetPath, 'utf8'), 'frozen source');
});

test('one managed proposal binds discovered body and supporting packages into the approved intake inputs',async t=>{
  const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());
  f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
  const faceConcept='保留原有表情，修改脸部轮廓';
  f.db.prepare("INSERT INTO project_brief(project_id,intake_mode,customer_request,face_concept) VALUES(?,'conversation','Design a character',?)").run(project,faceConcept);
  const sources=join(f.root,'sources');mkdirSync(sources);f.config.assetSearchRoots=[sources];
  execFileSync(hostPlatform.toolCommand('python'),['-c',`import io,sys,tarfile
from pathlib import Path
for name in ('body','hair','texture'):
 with tarfile.open(str(Path(sys.argv[1])/(name+'.unitypackage')),'w:gz') as package:
  for suffix,data in [('pathname',('Assets/Demo/'+name+'.prefab').encode()),('asset',b'%YAML 1.1\\n--- !u!1 &1\\nGameObject: {}\\n')]:
   member=tarfile.TarInfo('0123456789abcdef0123456789abcdef/'+suffix);member.size=len(data);package.addfile(member,io.BytesIO(data))
`,sources]);
  const hashes=['body','hair','texture'].map(name=>createHash('sha256').update(readFileSync(join(sources,name+'.unitypackage'))).digest('hex'));
  f.config.capabilities[f.config.defaultProfile]={schema:'capabilities/0.1',process:f.config.defaultProfile,version:'test',artifacts:{},stages:{},observers:{}};
  const input=submitInteraction(f.db,project,{content:'Design a character from the picture',commandId:'complete-inputs'});
  let calls=0;
  f.executor.collect=handle=>{
    calls++;
    const task=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
    const inputs=JSON.parse(JSON.parse(String(task.plan_json)).task.goal.split('\n').at(-1)!).inputs;
    assert.match(JSON.parse(String(task.plan_json)).task.goal,/selections/,'the active protocol exposes the real consumer');
    const history=inputs.exploration.history;
    const response=!history.length?{kind:'explore',exploration:{op:'list',target:inputs.exploration.roots[0].id}}:
      {kind:'production',proposal:{request:'Create a character using the chosen body, hair and textures',assetIds:[],
        selections:history[0].result.entries.map((entry:{id:string;name:string})=>({target:entry.id,
          kind:entry.name.startsWith('body')?'avatar':entry.name.startsWith('texture')?'texture':'other'}))}};
    mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});
    writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({schema:'interaction-result/0.1',requestId:input.id,
      revision:input.revision,text:'Check the design and materials before production',...response}));return {exitStatus:0,outputs:{}};
  };
  await f.tick();await f.tick();await f.tick();
  assert.equal(calls,2,'selection and proposal do not need an extra model round');
  const proposal=f.db.prepare('SELECT * FROM production_proposal WHERE id=?').get(input.id)!;
  const assets=JSON.parse(String(proposal.inputs_json));
  assert.equal(proposal.status,'proposed');assert.equal(proposal.workflow_id,null,'no construction before approval');
  assert.deepEqual(assets.map((a:{sha256:string})=>a.sha256),hashes);
  assert.equal(assets.length,3);assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_asset WHERE project_id=?').get(project)!.n,3);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_message WHERE role=\'user\'').get()!.n,1,'no fake user selection');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM interaction_exploration').get()!.n,1,'proposal bookkeeping does not consume more exploration');
  const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const client=await ApiClient.connect(f.home);
  try {
    const shown=await client.call('project.production.list',{projectId:project}) as Array<{inputs:Array<{name:string;id:string}>}>;
    assert.deepEqual(shown[0]!.inputs.map(a=>a.name),['body.unitypackage','hair.unitypackage','texture.unitypackage'],
      'the existing GUI proposal method returns every selected package, not just the body');
  } finally {client.close();await service.stop();}
  f.config.assetSearchRoots=[];
  assert.throws(()=>approveProduction(f.db,f.config,input.id,'revoked',input.revision),/授权/);
  assert.equal(f.db.prepare('SELECT workflow_id FROM production_proposal WHERE id=?').get(input.id)!.workflow_id,null);
  f.config.assetSearchRoots=[sources];const original=readFileSync(join(sources,'hair.unitypackage'));
  writeFileSync(join(sources,'hair.unitypackage'),Buffer.concat([original,Buffer.from('changed')]));
  assert.throws(()=>approveProduction(f.db,f.config,input.id,'drift',input.revision),/文件已改变/);
  writeFileSync(join(sources,'hair.unitypackage'),original);
  const workflow=approveProduction(f.db,f.config,input.id,'accept-complete-inputs',input.revision);
  assert.equal(approveProduction(f.db,f.config,input.id,'accept-complete-inputs',input.revision),workflow);
  const frozen=JSON.parse(String(f.db.prepare('SELECT manifest_json FROM workflow_definition WHERE workflow_id=?').get(workflow)!.manifest_json));
  assert.equal(frozen.faceConcept,faceConcept,'the ordinary production entry preserves the frozen face direction, without claiming it was executed');
  f.db.prepare('UPDATE project_brief SET face_concept=? WHERE project_id=?').run('A later direction',project);
  assert.equal(JSON.parse(String(f.db.prepare('SELECT manifest_json FROM workflow_definition WHERE workflow_id=?').get(workflow)!.manifest_json)).faceConcept,faceConcept);
  assert.deepEqual(frozen.assets.map((a:{sha256:string})=>a.sha256),hashes);
  assert.equal(frozen.assets[2].role,'texture','the approved input keeps the texture role through formal creation');
  execFileSync(hostPlatform.toolCommand('python'),[fileURLToPath(new URL('../../builtin/tools/harness/intake.py',import.meta.url)),
    '--library',sources,'--project',f.project],{env:{...process.env,AVH_MANIFEST:JSON.stringify(frozen)},encoding:'utf8'});
  const inventory=JSON.parse(readFileSync(join(f.project,'_harness/intake/inventory.json'),'utf8'));
  assert.equal(inventory.items.length,3,'the real intake consumer receives all frozen dependencies');
  for(const item of inventory.items){assert.equal(item.found,true);assert.equal(item.files.filter((file:{selected:boolean})=>file.selected).length,1);}
  assert.deepEqual(['body','hair','texture'].map(name=>createHash('sha256').update(readFileSync(join(sources,name+'.unitypackage'))).digest('hex')),hashes);
});

test('discovered production selections roll back together on invalid, rejected, duplicate or failed proposal persistence',async t=>{
  for(const fault of ['unissued','foreign','rejected','blocked','duplicate','persistence','stale','revoked'])await t.test(fault,async t=>{
    const f=fixture(t),seed=taskAdd(f.config,f.db,'sample',f.spec());
    f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
    const project=String(f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get()!.project_id);
    const sources=join(f.root,'sources');mkdirSync(sources);f.config.assetSearchRoots=[sources];
    for(const name of ['body','hair'])writeFileSync(join(sources,name+'.unitypackage'),name+' source');
    if(fault==='rejected'||fault==='blocked'){
      f.db.prepare("INSERT INTO asset(id,path,name,kind,status) VALUES('rejected',?,'Hair','other',?)")
        .run(join(sources,'hair.unitypackage'),fault==='blocked'?'blocked':'candidate');
      f.db.prepare("INSERT INTO project_asset(project_id,asset_id,role) VALUES(?,'rejected',?)").run(project,fault==='rejected'?'rejected':'source');
    }
    const existingAssets=Number(f.db.prepare('SELECT count(*) AS n FROM asset').get()!.n);
    f.config.capabilities[f.config.defaultProfile]={schema:'capabilities/0.1',process:f.config.defaultProfile,version:'test',artifacts:{},stages:{},observers:{}};
    if(fault==='persistence')f.db.exec("CREATE TRIGGER fail_proposal BEFORE INSERT ON production_proposal BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END");
    const input=submitInteraction(f.db,project,{content:'Choose the character materials',commandId:'atomic-'+fault});
    let calls=0;
    f.executor.collect=handle=>{
      calls++;
      const task=f.db.prepare('SELECT w.plan_json FROM workflow w JOIN task t ON t.workflow_id=w.id JOIN run r ON r.task_id=t.id WHERE r.id=?').get(handle.ref)!;
      const inputs=JSON.parse(JSON.parse(String(task.plan_json)).task.goal.split('\n').at(-1)!).inputs;
      let response:Record<string,unknown>;
      if(calls===1)response={kind:'explore',exploration:{op:'list',target:inputs.exploration.roots[0].id}};
      else {
        const entries=inputs.exploration.history[0].result.entries;
        if(fault==='foreign'){
          f.db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
            SELECT 'foreign',workspace_id,'sample',?,'{}','active','test','test' FROM project WHERE id=?`).run(join(f.root,'foreign'),project);
          f.db.prepare('UPDATE exploration_resource SET project_id=? WHERE path=? AND project_id=?').run('foreign',join(sources,'hair.unitypackage'),project);
        }
        const first={target:entries[0].id,kind:'avatar'};
        const second={target:fault==='unissued'?'r_0000000000000000':fault==='duplicate'
          ?String(f.db.prepare('SELECT id FROM exploration_resource WHERE project_id=? AND path=?').get(project,join(sources,'body.unitypackage'))!.id):entries[1].id,kind:'other'};
        response={kind:'production',proposal:{request:'Use these body and hair inputs',assetIds:[],selections:[first,second]}};
        if(fault==='stale')submitInteraction(f.db,project,{content:'Different design',commandId:'new-goal',expectedRevision:input.revision});
        if(fault==='revoked')f.config.assetSearchRoots=[];
      }
      mkdirSync(join(f.home,'runs',handle.ref),{recursive:true});writeFileSync(join(f.home,'runs',handle.ref,'response.json'),JSON.stringify({
        schema:'interaction-result/0.1',requestId:input.id,revision:input.revision,text:'Proposal pending confirmation',...response}));return {exitStatus:0,outputs:{}};
    };
    await f.tick();await f.tick();
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM production_proposal').get()!.n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM asset').get()!.n,existingAssets,'no partial global candidates after failure');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM project_asset WHERE project_id=?').get(project)!.n,existingAssets,'no partial project linkage');
    if(fault==='stale')assert.equal(f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(input.id)!.status,'superseded');
    if(fault==='rejected')assert.equal(f.db.prepare("SELECT role FROM project_asset WHERE asset_id='rejected'").get()!.role,'rejected');
    assert.equal(readFileSync(join(sources,'body.unitypackage'),'utf8'),'body source');
  });
});

test('a coordinator result arriving after newer input cannot overwrite the current conversation', async t => {
  const f = fixture(t), seed = taskAdd(f.config, f.db, 'sample', f.spec());
  f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project = (f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get() as { project_id: string }).project_id;
  const first = submitInteraction(f.db, project, { content: 'Use white', commandId: 'old', expectedRevision: 0 });
  f.executor.collect = handle => {
    submitInteraction(f.db, project, { content: 'Use black instead', commandId: 'new', expectedRevision: 1 });
    mkdirSync(join(f.home, 'runs', handle.ref), { recursive: true });
    writeFileSync(join(f.home, 'runs', handle.ref, 'response.json'), JSON.stringify({ schema: 'interaction-result/0.1',
      requestId: first.id, revision: 1, kind: 'answer', text: '旧的白色要求' }));
    return { exitStatus: 0, outputs: {} };
  };
  await f.tick();
  assert.equal((f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(first.id) as { status: string }).status, 'superseded');
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM project_message WHERE role='harness'").get() as { n: number }).n, 0);
  assert.equal(sessionRevision(f.db, project), 2);
});

test('a queued interaction survives unavailable AI and dispatches once after the connection is restored', async t => {
  const f = fixture(t), seed = taskAdd(f.config, f.db, 'sample', f.spec());
  f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project = (f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get() as { project_id: string }).project_id;
  const request = submitInteraction(f.db, project, { content: 'Please clarify', commandId: 'waiting' });
  const providers = f.config.providers;
  f.config.providers = [];
  await f.tick();
  assert.equal((f.db.prepare('SELECT status FROM project_interaction WHERE id=?').get(request.id) as { status: string }).status, 'queued');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM task').get() as { n: number }).n, 1);
  f.config.providers = providers;
  f.executor.collect = handle => {
    mkdirSync(join(f.home, 'runs', handle.ref), { recursive: true });
    writeFileSync(join(f.home, 'runs', handle.ref, 'response.json'), JSON.stringify({ schema: 'interaction-result/0.1',
      requestId: request.id, revision: 1, kind: 'clarify', text: '请说明颜色偏好。' }));
    return { exitStatus: 0, outputs: {} };
  };
  await f.tick(); await f.tick();
  assert.equal((f.db.prepare('SELECT status,error FROM project_interaction WHERE id=?').get(request.id) as { status: string }).status, 'awaiting_user');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM task').get() as { n: number }).n, 2);
  assert.equal(f.executor.starts.length, 1);
});

test('coordinator task registration rolls back with its linkage when frozen snapshot persistence fails', async t => {
  const f = fixture(t), seed = taskAdd(f.config, f.db, 'sample', f.spec());
  f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(seed);
  const project = (f.db.prepare('SELECT project_id FROM workflow LIMIT 1').get() as { project_id: string }).project_id;
  const request = submitInteraction(f.db, project, { content: 'Clarify the goal', commandId: 'atomic' });
  f.db.exec("CREATE TRIGGER fail_snapshot BEFORE INSERT ON provider_snapshot BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  await f.tick();
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM task').get() as { n: number }).n, 1);
  const row = f.db.prepare('SELECT status,task_id,error FROM project_interaction WHERE id=?').get(request.id);
  assert.equal(row!.status, 'queued'); assert.equal(row!.task_id, null); assert.match(String(row!.error), /injected failure/);
});

test('fake Provider: task add, failed independent readback, redo, then PASSED', async t => {
  const f = fixture(t); const id = taskAdd(f.config, f.db, 'sample', f.spec());
  assert.ok(f.db.prepare('SELECT 1 FROM provider_snapshot').get());
  await f.tick();
  assert.match(taskShow(f.db, id), /状态: BLOCKED/);
  assert.match(taskShow(f.db, id), /check_failed/);
  f.executor.output = 'ok'; taskRedo(f.db, id); await f.tick();
  assert.match(taskShow(f.db, id), /状态: PASSED/);
  assert.match(taskShow(f.db, id), /attempt=2/);
});
test('PASSED temporary Task records changed outputs once and waits for explicit redo', async t => {
  const f = fixture(t); const id = taskAdd(f.config, f.db, 'sample', f.spec());
  f.executor.output = 'ok'; await f.tick();
  assert.match(taskShow(f.db, id), /状态: PASSED/);
  writeFileSync(join(f.project, 'result.txt'), 'changed\n');
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM task WHERE workflow_id = (SELECT workflow_id FROM task WHERE id = ?)')
    .get(id) as { n: number }).n, 1);
  const events = f.db.prepare("SELECT reason, payload_json FROM event WHERE entity_id = ? AND action = 'evidence_invalidated'")
    .all(id) as { reason: string; payload_json: string }[];
  assert.equal(events.length, 1);
  assert.match(events[0]!.reason, /result.txt/);
  assert.deepEqual(JSON.parse(events[0]!.payload_json).artifacts, ['result.txt']);
  assert.match(taskShow(f.db, id), /产物已变化；如需重新执行，用 avh task redo/);
  assert.match(taskList(f.db), /产物已变化；如需重新执行，用 avh task redo/);
  taskRedo(f.db, id);
  await f.tick();
  await f.tick();
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM task WHERE workflow_id = (SELECT workflow_id FROM task WHERE id = ?)')
    .get(id) as { n: number }).n, 2);
});
test('task add records observed versions and command checks receive Run and project directories', async t => {
  const f = fixture(t);
  const path = join(f.root, 'environment-task.yaml');
  writeFileSync(path, stringify({ schema: 'task/0.1', goal: 'write Run artifact', role: 'executor',
    allowedWrites: [], expectedOutputs: ['run:x'], maxRetries: 0, resources: [],
    checks: [{ id: 'environment', command: [process.execPath, '-e',
      "const { existsSync } = require('node:fs'), { join } = require('node:path');" +
      "process.exit(existsSync(join(process.env.AVH_RUN_DIR, 'x')) && process.env.AVH_PROJECT_DIR === process.argv[1] ? 0 : 1)",
      f.project] }] }));
  const id = taskAdd(f.config, f.db, 'sample', path);
  const versions = f.db.prepare(`SELECT p.harness_version, p.knowledge_version AS project_knowledge,
    w.knowledge_version AS workflow_knowledge FROM task t JOIN workflow w ON w.id=t.workflow_id
    JOIN project p ON p.id=w.project_id WHERE t.id=?`).get(id) as { harness_version: string; project_knowledge: string; workflow_knowledge: string };
  assert.equal(versions.harness_version, harnessVersion());
  assert.equal(versions.project_knowledge, knowledgeVersion(f.config));
  assert.equal(versions.workflow_knowledge, knowledgeVersion(f.config));
  f.executor.collect = (handle: RunHandle): RunResult => {
    const runDir = join(f.home, 'runs', handle.ref); mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'x'), 'ok');
    return { exitStatus: 0, outputs: {} };
  };
  await f.tick();
  assert.match(taskShow(f.db, id), /状态: PASSED/);
});
test('recover never-started Run closes old attempt and permits next serve; existing unit needs force', async t => {
  const f = fixture(t); const id = taskAdd(f.config, f.db, 'sample', f.spec());
  const task = f.db.prepare('SELECT workflow_id FROM task WHERE id = ?').get(id) as { workflow_id: string };
  const workflow = f.db.prepare('SELECT project_id FROM workflow WHERE id = ?').get(task.workflow_id) as { project_id: string };
  f.db.prepare("INSERT INTO run (id, task_id, attempt, status) VALUES ('run-recover', ?, 1, 'pending')").run(id);
  f.db.prepare("INSERT INTO dispatch_outbox (id, run_id) VALUES ('out-recover', 'run-recover')").run();
  f.db.prepare("INSERT INTO lock (resource, run_id, fencing, lease_until) VALUES (?, 'run-recover', 1, '9999-12-31')")
    .run(`project:${workflow.project_id}`);
  transitionTask(f.db, id, 'RUNNING', 'run_intended', 'synthetic intended');
  transitionTask(f.db, id, 'RECOVERY_REQUIRED', 'start_uncertain', 'synthetic unknown');
  await assert.rejects(taskRecover(f.db, f.config, id, 'no_side_effects', 'checked', false, () => false),
    /--force/);
  await taskRecover(f.db, f.config, id, 'no_side_effects', 'checked unit absent', false, () => true);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, 'READY');
  assert.equal((f.db.prepare("SELECT status FROM run WHERE id = 'run-recover'").get() as { status: string }).status, 'abandoned');
  assert.equal((f.db.prepare("SELECT status FROM dispatch_outbox WHERE id = 'out-recover'").get() as { status: string }).status, 'closed');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM lock').get() as { n: number }).n, 0);
  f.executor.output = 'ok'; await f.tick();
  assert.equal((f.db.prepare('SELECT MAX(attempt) AS n FROM run WHERE task_id = ?').get(id) as { n: number }).n, 2);
  assert.match(taskShow(f.db, id), /状态: PASSED/);
});
test('cancel latest never-started Run from READY releases every lock and is idempotent', async t => {
  const f = fixture(t); const id = taskAdd(f.config, f.db, 'sample', f.spec());
  const workflow = f.db.prepare('SELECT workflow_id FROM task WHERE id = ?').get(id) as { workflow_id: string };
  const project = f.db.prepare('SELECT project_id FROM workflow WHERE id = ?').get(workflow.workflow_id) as { project_id: string };
  f.db.prepare("INSERT INTO run (id, task_id, attempt, status) VALUES ('run-stale', ?, 1, 'pending')").run(id);
  f.db.prepare("INSERT INTO dispatch_outbox (id, run_id) VALUES ('out-stale', 'run-stale')").run();
  for (const resource of [`project:${project.project_id}`, 'slot:synthetic:0'])
    f.db.prepare("INSERT INTO lock (resource, run_id, fencing, lease_until) VALUES (?, 'run-stale', 1, '9999-12-31')")
      .run(resource);
  f.executor.confirmNeverStarted = () => true;
  assert.deepEqual(await cancel(f.db, f.config, 'run-stale', f.executor), { confirmed: true, releasedLocks: 2 });
  const run = f.db.prepare("SELECT status, result_json FROM run WHERE id = 'run-stale'").get() as
    { status: string; result_json: string };
  assert.equal(run.status, 'cancelled');
  assert.equal(JSON.parse(run.result_json).noSideEffects, true);
  assert.match(JSON.parse(run.result_json).cancellationNote, /human cancelled Run run-stale/);
  assert.equal((f.db.prepare("SELECT status FROM dispatch_outbox WHERE id = 'out-stale'").get() as { status: string }).status, 'closed');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM lock').get() as { n: number }).n, 0);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, 'CANCELLED');
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM event WHERE entity_id = 'run-stale' AND action = 'cancelled_no_side_effects'")
    .get() as { n: number }).n, 1);
  assert.deepEqual(await cancel(f.db, f.config, id, f.executor), { confirmed: true, releasedLocks: 0, residue: [] });
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM lock').get() as { n: number }).n, 0);
  const next = taskAdd(f.config, f.db, 'sample', f.spec());
  f.executor.output = 'ok'; await f.tick();
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(next) as { status: string }).status, 'PASSED');
});
test('cancel repairs a CANCELLED task whose latest Run still holds a lock', async t => {
  const f = fixture(t); const id = taskAdd(f.config, f.db, 'sample', f.spec());
  const row = f.db.prepare(`SELECT w.project_id FROM task t JOIN workflow w ON w.id = t.workflow_id WHERE t.id = ?`)
    .get(id) as { project_id: string };
  f.db.prepare("INSERT INTO run (id, task_id, attempt, status) VALUES ('run-orphan', ?, 1, 'pending')").run(id);
  f.db.prepare("INSERT INTO dispatch_outbox (id, run_id) VALUES ('out-orphan', 'run-orphan')").run();
  f.db.prepare("INSERT INTO lock (resource, run_id, fencing, lease_until) VALUES (?, 'run-orphan', 1, '9999-12-31')")
    .run(`project:${row.project_id}`);
  transitionTask(f.db, id, 'CANCELLED', 'cancel_confirmed', 'synthetic old cancellation');
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  const busctl = join(bin, 'busctl');
  writeFileSync(busctl, '#!/bin/sh\necho NoSuchUnit >&2\nexit 1\n'); chmodSync(busctl, 0o700);
  const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
  const runCancel = () => spawnSync(process.execPath, [cli, 'cancel', 'run-orphan'], { encoding: 'utf8',
    env: { ...process.env, AVH_HOME: f.home, PATH: `${bin}:${process.env.PATH ?? ''}` } });
  const first = runCancel();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /已收尾残留 Run run-orphan: 任务 CANCELLED；单元 never started；已释放 1 把锁/);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM lock').get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("SELECT status FROM run WHERE id = 'run-orphan'").get() as { status: string }).status, 'cancelled');
  assert.equal((f.db.prepare("SELECT status FROM dispatch_outbox WHERE id = 'out-orphan'").get() as { status: string }).status, 'closed');
  const second = runCancel();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /无残留: run-orphan/);
  const byTask = spawnSync(process.execPath, [cli, 'cancel', id], { encoding: 'utf8',
    env: { ...process.env, AVH_HOME: f.home, PATH: `${bin}:${process.env.PATH ?? ''}` } });
  assert.equal(byTask.status, 0, byTask.stderr);
  assert.match(byTask.stdout, new RegExp(`无残留: ${id}`));
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM event WHERE entity_id = 'run-orphan' AND action = 'orphan_run_closed'")
    .get() as { n: number }).n, 1);
});
test('reconciled recovery enters verification with exited Run and closed outbox', async t => {
  const f = fixture(t); const id = taskAdd(f.config, f.db, 'sample', f.spec());
  f.db.prepare("INSERT INTO run (id, task_id, attempt, status) VALUES ('run-reconciled', ?, 1, 'pending')").run(id);
  f.db.prepare("INSERT INTO dispatch_outbox (id, run_id) VALUES ('out-reconciled', 'run-reconciled')").run();
  transitionTask(f.db, id, 'RUNNING', 'run_intended', 'synthetic intended');
  transitionTask(f.db, id, 'RECOVERY_REQUIRED', 'start_uncertain', 'synthetic unknown');
  await taskRecover(f.db, f.config, id, 'reconciled', 'human checked output');
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, 'VERIFYING');
  assert.equal((f.db.prepare("SELECT status FROM run WHERE id = 'run-reconciled'").get() as { status: string }).status, 'exited');
  assert.equal((f.db.prepare("SELECT status FROM dispatch_outbox WHERE id = 'out-reconciled'").get() as { status: string }).status, 'closed');
});

test('provider_selected event records excluded Provider and final choice', async t => {
  const f = fixture(t);
  f.config.providers.push({ ...f.config.providers[0]!, id: 'research-only', roles: ['research'] });
  const id = taskAdd(f.config, f.db, 'sample', f.spec());
  const row = f.db.prepare(`SELECT t.id, t.workflow_id, w.project_id, p.path AS project_path, t.status,
    t.goal, w.plan_json, w.process_hash, t.stage_id FROM task t JOIN workflow w ON w.id=t.workflow_id
    JOIN project p ON p.id=w.project_id WHERE t.id=?`).get(id) as ConstructorParameters<typeof TaskRouter>[2];
  const base = new TaskRouter(f.db, f.config, row).spec;
  const router = new TaskRouter(f.db, f.config, row, undefined, { ...base, contextPlan: {
    items: [{ spec: { id: 'core', path: 'core.md', priority: 1, required: true, when: [], unless: [], excludes: [],
      covers: ['core'], models: [] }, sha256: 'abc', content: 'core context' }], facts: {}, budgetChars: 1000,
    requiredCoverage: ['core'], prefix: 'work', suffix: '' } });
  (router as unknown as { adapter: () => { start: (run: RunSpec) => Promise<RunHandle> } }).adapter = () => ({
    start: async run => ({ ref: `avh-run-${run.runId}` }),
  });
  await router.start({ taskId: id, workflowId: row.workflow_id, projectId: row.project_id,
    runId: 'route-test', stageId: 'work', attempt: 1, idempotencyKey: 'route-test', expectedOutputs: ['result.txt'] });
  const route = f.db.prepare("SELECT reason FROM event WHERE action='provider_selected' ORDER BY seq DESC LIMIT 1")
    .get() as { reason: string } | undefined;
  assert.match(route?.reason ?? '', /selected=fake.*research-only: role/);
  const context = f.db.prepare("SELECT payload_json AS payload FROM event WHERE action='context_compiled' AND entity_id='route-test'")
    .get() as { payload: string };
  assert.deepEqual((JSON.parse(context.payload) as { modelFamily: string; selected: Array<{ id: string; sha256: string }> }),
    { schema: 'context-telemetry/0.1', modelFamily: 'codex', usedChars: 12, budgetChars: 1000, coverage: ['core'],
      // The decision carries its disposition and whether it was required, so a reader can tell "did not
      // apply here" from "did not fit" without parsing the reason string.
      selected: [{ id: 'core', path: 'core.md', required: true, selected: true, reason: '必选条目', chars: 12,
        priority: 1, covers: ['core'], disposition: 'selected', sha256: 'abc' }] });
  assert.match(readFileSync(join(f.home,'runs/route-test/context-plan.json'),'utf8'),/"modelFamily": "codex"/);
  // The run's own account of its assembly, written where the family is finally known. A report made
  // when the plan was frozen could not name the family, so it would describe an assembly that never ran.
  const assembly = JSON.parse(readFileSync(join(f.home,'runs/route-test/context-assembly.json'),'utf8')) as
    { schema: string; identity: { stage: string; workflow: string; pack: string; modelFamily?: string };
      budget: { unit: string; budgetChars: number }; contract: { required: string[]; covered: string[]; unmet: string[] };
      counts: Record<string, number> };
  assert.equal(assembly.schema, 'context-assembly-report/0.1');
  assert.equal(assembly.identity.modelFamily, 'codex', 'the report must name the family that actually ran');
  assert.ok(assembly.identity.workflow && assembly.identity.workflow !== 'unknown',
    `the report must name its workflow, got ${assembly.identity.workflow}`);
  // What the count counts, stated rather than left to be read as model tokens.
  assert.equal(assembly.budget.unit, 'utf16-code-units-of-item-bodies');
  assert.deepEqual(assembly.contract.covered, ['core']);
  assert.deepEqual(assembly.contract.unmet, []);
  assert.equal(assembly.counts.selected, 1);
});

test('fake Provider: Gate waits, approval resumes, changed artifact makes old approval stale', async t => {
  const f = fixture(t); f.executor.output = 'ok-v1';
  const id = taskAdd(f.config, f.db, 'sample', f.spec(true));
  await f.tick(); assert.match(taskShow(f.db, id), /状态: WAITING_HUMAN/);
  const gate = gateList(f.db).split('\n')[1]!.split('\t')[0]!;
  gateDecide(f.db, gate, true, 'reviewed v1');
  assert.throws(() => gateDecide(f.db, gate, false, 'reverse'), /不可撤销的批准/);
  await f.tick();
  assert.match(taskShow(f.db, id), /状态: PASSED/);
  f.executor.output = 'ok-v2'; writeFileSync(join(f.project, 'result.txt'), 'ok-v2');
  assert.match(taskShow(f.db, id), /产物已变化；如需重新执行，用 avh task redo/);
  await f.tick();
  assert.match(gateList(f.db), /stale/);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM task').get() as { n: number }).n, 1);
  taskRedo(f.db, id); await f.tick();
  const waiting = f.db.prepare("SELECT id FROM task WHERE status = 'WAITING_HUMAN' ORDER BY rowid DESC LIMIT 1")
    .get() as { id: string } | undefined;
  assert.ok(waiting); assert.notEqual(waiting.id, id);
  assert.match(taskShow(f.db, waiting.id), /gate_pending/);
});

test('Gate rejection records current hash; redo and cancellation use existing transitions', async t => {
  const f = fixture(t); f.executor.output = 'ok';
  const id = taskAdd(f.config, f.db, 'sample', f.spec(true)); await f.tick();
  const gate = gateList(f.db).split('\n')[1]!.split('\t')[0]!;
  gateDecide(f.db, gate, false, 'needs revision');
  assert.match(gateList(f.db), /rejected/);
  assert.match(taskShow(f.db, id), /状态: WAITING_HUMAN/);
  taskRedo(f.db, id); await f.tick();
  assert.match(taskShow(f.db, id), /human_requested_redo/);
  assert.deepEqual(await cancel(f.db, f.config, id), { confirmed: true });
  assert.match(taskShow(f.db, id), /状态: CANCELLED/);
});

test('task write scope detects untracked and committed paths outside allowedWrites', t => {
  const f = fixture(t);
  const before = taskScopeSnapshot(f.project);
  writeFileSync(join(f.project, 'result.txt'), 'ok');
  writeFileSync(join(f.project, 'outside.txt'), 'unexpected');
  assert.deepEqual(taskScopeChanges(f.project, ['result.txt'], before), ['outside.txt']);
  execFileSync('git', ['-C', f.project, 'add', 'result.txt', 'outside.txt']);
  execFileSync('git', ['-C', f.project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'changes']);
  assert.deepEqual(taskScopeChanges(f.project, ['result.txt'], before), ['outside.txt']);
});

test('Unity scratch and package lock are scan exemptions; ProjectSettings remains out of bounds', t => {
  const f = fixture(t), before = taskScopeSnapshot(f.project);
  for (const name of ['Library/cache.bin', 'Packages/packages-lock.json', 'ProjectSettings/ProjectSettings.asset']) {
    const path = join(f.project, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'synthetic');
  }
  assert.deepEqual(taskScopeChanges(f.project, ['Library', 'Packages/packages-lock.json'], before),
    ['ProjectSettings/ProjectSettings.asset']);
});

test('allowedWrites permits only the matching asset meta beside an allowed directory', t => {
  const f = fixture(t), before = taskScopeSnapshot(f.project);
  for (const name of ['Assets/_X.meta', 'Assets/Y.meta', 'Assets/_X/item.asset']) {
    const path = join(f.project, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'synthetic');
  }
  assert.deepEqual(taskScopeChanges(f.project, ['Assets/_X'], before), ['Assets/Y.meta']);
  const file = join(f.root, 'meta-task.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'create synthetic asset',
    allowedWrites: ['Assets/_X'], expectedOutputs: ['Assets/_X.meta'],
    checks: [{ id: 'meta-readback', path: 'Assets/_X.meta', contains: 'synthetic' }] }));
  assert.ok(taskAdd(f.config, f.db, 'sample', file));
});

function fakeTaskRouter(f: ReturnType<typeof fixture>, id: string,
  produce: (runId: string) => void, prompts: string[], _unityLaunch?: never,
  observation: 'exited' | 'running' = 'exited'): TaskRouter {
  const row = f.db.prepare(`SELECT t.id, t.workflow_id, w.project_id, p.path AS project_path, t.status,
    t.goal, w.plan_json, w.process_hash, t.stage_id FROM task t JOIN workflow w ON w.id=t.workflow_id
    JOIN project p ON p.id=w.project_id WHERE t.id=?`).get(id) as ConstructorParameters<typeof TaskRouter>[2];
  const router = new TaskRouter(f.db, f.config, row);
  (router as unknown as { adapter: () => unknown }).adapter = () => ({
    start: async (request: { runId: string; prompt: string; allowedWrites: string[] }) => {
      prompts.push(request.prompt);
      return { ref: `avh-run-${request.runId}` };
    },
    observe: () => ({ state: observation }),
    collect: (handle: RunHandle) => {
      produce(handle.ref.slice('avh-run-'.length));
      return { exitStatus: 0, outputs: {} };
    },
    cancel: async () => 'confirmed',
  });
  return router;
}

test('expired scheduler lease is taken over and an unexpired lease is preserved', t => {
  const f = fixture(t);
  const seed = (expiresAt: string) => f.db.prepare(`UPDATE scheduler_lease
    SET holder = 'synthetic:999999:old', host = 'synthetic', pid = 999999, expires_at = ? WHERE id = 1`)
    .run(expiresAt);
  seed(new Date(Date.now() + 60_000).toISOString());
  const before = Number((f.db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n);
  const busy = acquireSchedulerLease(f.db);
  assert.equal(busy.acquired, false);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, before);
  const expiredAt = new Date(Date.now() - 1000).toISOString();
  seed(expiredAt);
  const acquired = acquireSchedulerLease(f.db);
  assert.equal(acquired.acquired, true);
  if (acquired.acquired) acquired.release();
  const events = f.db.prepare("SELECT action, payload_json FROM event WHERE entity_type = 'scheduler'")
    .all() as { action: string; payload_json: string }[];
  assert.equal(events.length, 1);
  assert.equal(events[0]!.action, 'scheduler_lease_taken_over');
  assert.equal(JSON.parse(events[0]!.payload_json).previousHolder, 'synthetic:999999:old');
  assert.equal(JSON.parse(events[0]!.payload_json).previousExpiresAt, expiredAt);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM scheduler_lease').get() as { n: number }).n, 1);
});

test('50 empty serve cycles leave event count unchanged and reuse the single lease row', async t => {
  const f = fixture(t);
  const before = (f.db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n;
  for (let i = 0; i < 50; i++) assert.equal(await serveOnce(f.db, f.config), true);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, before);
  assert.deepEqual(f.db.prepare('SELECT id, holder, cycle FROM scheduler_lease').all().map(row => ({ ...row })),
    [{ id: 1, holder: null, cycle: 50 }]);
});

test('expired local lease held by a live process stays owned and old cycle cannot release successor', t => {
  const f = fixture(t);
  const first = acquireSchedulerLease(f.db);
  assert.equal(first.acquired, true);
  const firstCycle = (f.db.prepare('SELECT cycle FROM scheduler_lease').get() as { cycle: number }).cycle;
  f.db.prepare('UPDATE scheduler_lease SET expires_at = ? WHERE id = 1').run(new Date(Date.now() - 1000).toISOString());
  const busy = acquireSchedulerLease(f.db);
  assert.equal(busy.acquired, false);
  f.db.prepare("UPDATE scheduler_lease SET host = 'synthetic' WHERE id = 1").run();
  const successor = acquireSchedulerLease(f.db);
  assert.equal(successor.acquired, true);
  if (first.acquired) first.release();
  assert.equal((f.db.prepare('SELECT cycle FROM scheduler_lease').get() as { cycle: number }).cycle, firstCycle + 1);
  assert.notEqual((f.db.prepare('SELECT holder FROM scheduler_lease').get() as { holder: string }).holder, null);
  if (successor.acquired) successor.release();
});

test('Unity journal without visible intent stays running while launcher lives', async t => {
  const f = fixture(t);
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
  const file = join(f.root, 'unity-midpoint.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'synthetic Unity midpoint', allowedWrites: [],
    expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
    resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const router = fakeTaskRouter(f, id, () => {}, [], undefined, 'running');
  await serveOnce(f.db, f.config, () => router);
  const runId = (f.db.prepare('SELECT id FROM run WHERE task_id = ?').get(id) as { id: string }).id;
  const dir = join(f.home, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'unity-steps.json'), JSON.stringify({ status: 'started' }));
  writeFileSync(join(dir, 'unity-launching'), String(process.pid));
  assert.deepEqual(await router.observe({ ref: `fake|avh-run-${runId}` }), { state: 'running' });
  await serveOnce(f.db, f.config, () => router);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, 'RUNNING');
  writeFileSync(join(dir, 'unity-launching'), '999999');
  assert.deepEqual(await router.observe({ ref: `fake|avh-run-${runId}` }), { state: 'unknown' });
  await serveOnce(f.db, f.config, () => router);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, 'RECOVERY_REQUIRED');
});

/**
 * Whether this machine can run the helper the Windows job and process probes go through. A test that cancels a Unity
 * task reads the real process table, so it is only meaningful where that helper is built.
 */
const windowsHelperReady = (() => { if (!windows) return false; try { windowsHelper(); return true; } catch { return false; } })();

(windowsHelperReady ? test : test.skip)('a Unity task is not cancelled while an editor of its project still runs', async t => {
  const f = fixture(t);
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
  const file = join(f.root, 'unity-editor-guard.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'synthetic editor guard', allowedWrites: [],
    expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
    resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const router = fakeTaskRouter(f, id, () => {}, [], undefined, 'running');
  await serveOnce(f.db, f.config, () => router);
  const runId = (f.db.prepare('SELECT id FROM run WHERE task_id = ?').get(id) as { id: string }).id;
  const dir = join(f.home, 'runs', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'unity-steps.json'), JSON.stringify({ status: 'started' }));
  // A live editor of this task's project: the image name the Runtime's own probe lists and the -projectPath it reads.
  // Terminating the Unity unit's job is a request, so cancellation has to look at the editor itself, not only at the
  // job that reads as empty once its processes are marked terminated.
  const editor = join(f.root, 'Unity.exe'), script = join(f.root, 'editor.mjs');
  copyFileSync(process.execPath, editor);
  writeFileSync(script, 'setInterval(() => {}, 1000);');
  const child = spawn(editor, [script, '-projectPath', f.project], { stdio: 'ignore', windowsHide: true });
  t.after(() => { if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); });
  const handle = { ref: `fake|avh-run-${runId}` };
  await waitFor(() => windowsUnityOccupancy(f.project).kind, { what: 'the stand-in editor to be listed for this project',
    timeoutMs: 60_000, intervalMs: 100, ready: kind => kind === 'editor' });
  assert.equal(await router.cancel(handle), 'not_confirmed');
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, 'RUNNING',
    'a stop the editor did not get is not recorded as a confirmed cancel');
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await waitFor(() => processAlive(child.pid!), { what: 'the editor to stop', timeoutMs: 30_000, intervalMs: 50, ready: alive => !alive });
  assert.equal(await router.cancel(handle), 'confirmed', 'once no editor of the project runs, the cancel is confirmed');
});

test('a Unity handoff lock left by a crashed holder is reclaimed and dispatch continues', async t => {
  const f = fixture(t);
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
  const file = join(f.root, 'stale-handoff.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'stale handoff', allowedWrites: [],
    expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
    resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const lock = join(f.home, 'state', 'unity-handoff.lock');
  const dead = deadPid();
  writeFileSync(lock, JSON.stringify({ kind: 'unity', holder: 'dsh', pid: dead, since: '2020-01-01T00:00:00.000Z' }));
  const router = fakeTaskRouter(f, id, () => {}, [], undefined, 'running');
  await serveOnce(f.db, f.config, () => router);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, 'RUNNING',
    'the scheduler dispatches past a holder that no longer exists');
  assert.equal(existsSync(lock), false, 'the crashed holder\'s lock is taken out of the way');
  const reclaim = f.db.prepare("SELECT reason FROM event WHERE action = 'unity_handoff_reclaimed'")
    .get() as { reason: string } | undefined;
  assert.match(reclaim?.reason ?? '', new RegExp(`pid ${dead}`), 'the record names the holder whose lock was reclaimed');
});

test('a Unity handoff held by a running process still blocks the scheduler', async t => {
  const f = fixture(t);
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
  const file = join(f.root, 'live-handoff.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'live handoff', allowedWrites: [],
    expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
    resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const lock = join(f.home, 'state', 'unity-handoff.lock');
  const held = JSON.stringify({ kind: 'unity', holder: 'dsh', pid: process.pid, since: 'now' });
  writeFileSync(lock, held);
  const router = fakeTaskRouter(f, id, () => {}, [], undefined, 'running');
  await serveOnce(f.db, f.config, () => router);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, 'READY');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM run WHERE task_id = ?').get(id) as { n: number }).n, 0);
  assert.equal(readFileSync(lock, 'utf8'), held, 'a live holder\'s lock is left byte for byte');
});

test('two serve --once processes admit only one scheduler cycle', async t => {
  const f = fixture(t);
  // The check runs read-only in the sandbox: it signals through its scratch HOME and reads the release
  // file from the Run directory, both of which the sandbox exposes.
  const runDir = join(f.home, 'runs', 'held-run');
  const ready = join(runDir, 'checks', 'held-check', 'home', 'cycle-entered'), release = join(runDir, 'cycle-release');
  const checker = join(runDir, 'held-check.mjs');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(checker, `import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(join(process.env.HOME, 'cycle-entered'), 'entered');
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(release)})) Atomics.wait(wait, 0, 0, 20);
`);
  const spec = join(f.root, 'held-task.yaml');
  writeFileSync(spec, stringify({ schema: 'task/0.1', goal: 'synthetic check', role: 'executor',
    allowedWrites: ['result.txt'], expectedOutputs: ['result.txt'], maxRetries: 0,
    checks: [{ id: 'held-check', command: [process.execPath, checker] }] }));
  const id = taskAdd(f.config, f.db, 'sample', spec);
  f.db.prepare("UPDATE task SET status = 'VERIFYING' WHERE id = ?").run(id);
  f.db.prepare("INSERT INTO run (id, task_id, attempt, status, result_json) VALUES ('held-run', ?, 1, 'exited', ?)")
    .run(id, JSON.stringify({ exitStatus: 0, outputs: {} }));
  const env = { ...process.env, AVH_HOME: f.home, HOME: join(f.root, 'isolated-home'),
    CODEX_HOME: join(f.root, 'isolated-home', '.codex') };
  mkdirSync(env.CODEX_HOME, { recursive: true });
  const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
  const first = spawn(process.execPath, [cli, 'serve', '--once'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (first.exitCode === null) first.kill(); });
  let stderr = '';
  first.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  // This is an exclusion test, not a source-checkout startup benchmark (WSL mounted files load more slowly).
  await waitFor(() => existsSync(ready) || first.exitCode !== null,
    { what: 'the first serve --once cycle to enter its held check', timeoutMs: 60_000, intervalMs: 20,
      detail: () => `exit=${first.exitCode} ${stderr || 'no stderr'}` });

  assert.ok(existsSync(ready), stderr || 'first cycle did not enter');
  const before = Number((f.db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n);
  const second = spawnSync(process.execPath, [cli, 'serve', '--once'],
    { encoding: 'utf8', env, timeout: 30_000 });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /另一个调度周期正在运行（持有者 .*，到期 .*）/);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, before);
  writeFileSync(release, 'go');
  await new Promise<void>((resolve, reject) => first.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr))));
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, 'BLOCKED');
  assert.equal((f.db.prepare('SELECT cycle FROM scheduler_lease').get() as { cycle: number }).cycle, 1);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM event WHERE entity_type = 'scheduler'").get() as { n: number }).n, 0);
});

test('same serve round counts running Runs against Provider capacity', async t => {
  const f = fixture(t);
  f.config.providers[0]!.maxConcurrentRuns = 2;
  f.config.providers[0]!.writable = [];
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const name = `sample-${i}`;
    const project = join(f.root, 'workspace', name);
    mkdirSync(project); writeFileSync(join(project, 'baseline.txt'), 'baseline\n');
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, 'add', 'baseline.txt']);
    execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'baseline']);
    f.config.sampleNames.push(name);
    ids.push(taskAdd(f.config, f.db, name, f.spec()));
  }
  const routers = new Map(ids.map(id => [id, fakeTaskRouter(f, id, () => {}, [], undefined, 'running')]));
  await serveOnce(f.db, f.config, id => routers.get(id)!);
  const runs = f.db.prepare('SELECT provider, status FROM run ORDER BY rowid').all() as
    { provider: string; status: string }[];
  assert.deepEqual(runs.map(row => ({ ...row })),
    [{ provider: 'fake', status: 'running' }, { provider: 'fake', status: 'running' }]);
  assert.deepEqual((f.db.prepare('SELECT status FROM task ORDER BY rowid').all() as { status: string }[])
    .map(row => row.status), ['RUNNING', 'RUNNING', 'READY', 'READY', 'READY']);
  const selected = f.db.prepare("SELECT reason FROM event WHERE action = 'provider_selected' ORDER BY seq")
    .all() as { reason: string }[];
  assert.equal(selected.length, 2);
  assert.match(selected[0]!.reason, /concurrency=0\/2/);
  assert.match(selected[1]!.reason, /concurrency=1\/2/);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM event WHERE action = 'route_waiting'").get() as { n: number }).n, 3);
});

test('Provider capacity counts a CANCELLED Task pending Run while its absence is unconfirmed', async t => {
  const f = fixture(t);
  const old = taskAdd(f.config, f.db, 'sample', f.spec());
  f.db.prepare("INSERT INTO run (id, task_id, attempt, status, provider) VALUES ('run-held', ?, 1, 'pending', 'fake')")
    .run(old);
  transitionTask(f.db, old, 'CANCELLED', 'cancel_confirmed', 'synthetic stale state');
  const next = taskAdd(f.config, f.db, 'sample', f.spec());
  const router = fakeTaskRouter(f, next, () => {}, [], undefined, 'running');
  router.confirmNeverStarted = () => false;
  for (let i = 0; i < 2; i++) await serveOnce(f.db, f.config, () => router);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(next) as { status: string }).status, 'READY');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM run').get() as { n: number }).n, 1);
  assert.equal((f.db.prepare("SELECT status FROM run WHERE id = 'run-held'").get() as { status: string }).status, 'pending');
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM event WHERE entity_id = ? AND action = 'route_waiting'")
    .get(next) as { n: number }).n, 1);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM event WHERE entity_id = 'run-held' AND action = 'orphan_run_unconfirmed'")
    .get() as { n: number }).n, 1);
  const show = taskShow(f.db, next);
  assert.match(show, /等待原因: .*fake: concurrency 1\/1.*Run run-held（任务 [0-9a-f-]+，CANCELLED）/);
  assert.match(show, /等待开始: \d{4}-/);
});

/** A finished Task with a residue running Run that holds the project lock and the only Provider slot. */
function seedResidue(f: ReturnType<typeof fixture>, finalStatus: 'CANCELLED' | 'FAILED' = 'CANCELLED') {
  const old = taskAdd(f.config, f.db, 'sample', f.spec());
  const project = (f.db.prepare('SELECT w.project_id FROM task t JOIN workflow w ON w.id = t.workflow_id WHERE t.id = ?')
    .get(old) as { project_id: string }).project_id;
  f.db.prepare(`INSERT INTO run (id, task_id, attempt, status, provider, process_ref)
    VALUES ('run-left', ?, 1, 'pending', 'fake', NULL)`).run(old);
  f.db.prepare("INSERT INTO dispatch_outbox (id, run_id) VALUES ('out-left', 'run-left')").run();
  f.db.prepare("INSERT INTO lock (resource, run_id, fencing, lease_until) VALUES (?, 'run-left', 1, '9999-12-31')")
    .run(`project:${project}`);
  transitionTask(f.db, old, 'RUNNING', 'run_intended', 'synthetic intended');
  f.db.prepare("UPDATE run SET status = 'running', process_ref = 'fake|avh-run-run-left' WHERE id = 'run-left'").run();
  for (const next of ['launched', 'acked']) f.db.prepare("UPDATE dispatch_outbox SET status = ? WHERE id = 'out-left'").run(next);
  if (finalStatus === 'CANCELLED') transitionTask(f.db, old, 'CANCELLED', 'cancel_confirmed', 'synthetic cancel that kept the Run');
  else {
    f.db.prepare("UPDATE task SET status = 'FAILED' WHERE id = ?").run(old);
  }
  mkdirSync(join(f.home, 'runs', 'run-left'), { recursive: true });
  return old;
}
const count = (f: ReturnType<typeof fixture>, sql: string, ...args: string[]) =>
  (f.db.prepare(sql).get(...args) as { n: number }).n;
const status = (f: ReturnType<typeof fixture>, table: 'run' | 'task', id: string) =>
  (f.db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string }).status;

test('cancelling a RUNNING Task closes its Run so the next Task on the same Provider dispatches', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const a = taskAdd(f.config, f.db, 'sample', f.spec());
  const b = taskAdd(f.config, f.db, 'sample', f.spec());
  const routers = new Map([a, b].map(id => [id, fakeTaskRouter(f, id, () => {}, [], undefined, 'running')]));
  await serveOnce(f.db, f.config, id => routers.get(id)!);
  assert.equal(status(f, 'task', a), 'RUNNING');
  assert.equal(status(f, 'task', b), 'READY');
  const runA = (f.db.prepare('SELECT id FROM run WHERE task_id = ?').get(a) as { id: string }).id;
  assert.deepEqual(await cancel(f.db, f.config, a, routers.get(a)), { confirmed: true });
  assert.equal(status(f, 'run', runA), 'cancelled');
  assert.equal((f.db.prepare('SELECT status FROM dispatch_outbox WHERE run_id = ?').get(runA) as { status: string }).status, 'closed');
  assert.equal(count(f, 'SELECT count(*) AS n FROM lock'), 0);
  await serveOnce(f.db, f.config, id => routers.get(id)!);
  assert.equal(status(f, 'task', b), 'RUNNING');
  assert.equal(count(f, "SELECT count(*) AS n FROM run WHERE task_id = ? AND provider = 'fake'", b), 1);
});

test('serve closes a residue Run whose unit is gone, then dispatches the waiting Task', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const old = seedResidue(f);
  writeFileSync(join(f.home, 'runs', 'run-left', 'exit.json'), '{"exitStatus":143}');
  const next = taskAdd(f.config, f.db, 'sample', f.spec());
  const routers = new Map([old, next].map(id => [id, fakeTaskRouter(f, id, () => {}, [], undefined, 'running')]));
  (routers.get(old) as unknown as { adapter: () => unknown }).adapter = () => ({
    observe: () => ({ state: 'exited' }),
    cancel: async () => assert.fail('an exited unit needs no stop'),
  });
  await serveOnce(f.db, f.config, id => routers.get(id)!);
  assert.equal(status(f, 'run', 'run-left'), 'cancelled');
  assert.equal(status(f, 'task', old), 'CANCELLED');
  assert.equal((f.db.prepare("SELECT status FROM dispatch_outbox WHERE id = 'out-left'").get() as { status: string }).status, 'closed');
  const closed = f.db.prepare("SELECT actor, reason FROM event WHERE entity_id = 'run-left' AND action = 'orphan_run_closed'")
    .all() as { actor: string; reason: string }[];
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.actor, 'runtime');
  assert.match(closed[0]!.reason, /task CANCELLED; unit exited; exitStatus=143/);
  assert.equal(JSON.parse((f.db.prepare("SELECT result_json FROM run WHERE id = 'run-left'").get() as { result_json: string })
    .result_json).exitStatus, 143);
  assert.equal(status(f, 'task', next), 'RUNNING');
  await serveOnce(f.db, f.config, id => routers.get(id)!);
  assert.equal(count(f, "SELECT count(*) AS n FROM event WHERE action = 'orphan_run_closed'"), 1);
});

test('serve keeps the slot of a residue Run whose unit still runs until the stop is confirmed', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const old = seedResidue(f);
  const next = taskAdd(f.config, f.db, 'sample', f.spec());
  const routers = new Map([old, next].map(id => [id, fakeTaskRouter(f, id, () => {}, [], undefined, 'running')]));
  let confirmStop: (value: 'confirmed') => void = () => {};
  let stopRequested = false;
  (routers.get(old) as unknown as { adapter: () => unknown }).adapter = () => ({
    observe: () => ({ state: 'running' }),
    cancel: () => { stopRequested = true; return new Promise(resolve => { confirmStop = resolve; }); },
  });
  const serving = serveOnce(f.db, f.config, id => routers.get(id)!);
  while (!stopRequested) await delay(10);
  assert.equal(status(f, 'run', 'run-left'), 'running');
  assert.equal(count(f, "SELECT count(*) AS n FROM lock WHERE run_id = 'run-left'"), 1);
  assert.equal(status(f, 'task', next), 'READY');
  confirmStop('confirmed');
  await serving;
  assert.match((f.db.prepare("SELECT reason FROM event WHERE entity_id = 'run-left' AND action = 'orphan_run_closed'")
    .get() as { reason: string }).reason, /unit stopped by runtime/);
  assert.equal(status(f, 'task', next), 'RUNNING');
});

test('serve does not close a residue Run when the stop cannot be confirmed, and records it once', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const old = seedResidue(f);
  const next = taskAdd(f.config, f.db, 'sample', f.spec());
  const routers = new Map([old, next].map(id => [id, fakeTaskRouter(f, id, () => {}, [], undefined, 'running')]));
  let stops = 0;
  (routers.get(old) as unknown as { adapter: () => unknown }).adapter = () => ({
    observe: () => ({ state: 'unknown' }),
    cancel: async () => { stops++; return 'not_confirmed'; },
  });
  for (let i = 0; i < 3; i++) await serveOnce(f.db, f.config, id => routers.get(id)!);
  assert.equal(stops, 3);
  assert.equal(status(f, 'run', 'run-left'), 'running');
  assert.equal(count(f, "SELECT count(*) AS n FROM lock WHERE run_id = 'run-left'"), 1);
  assert.equal(count(f, "SELECT count(*) AS n FROM run WHERE task_id = ?", next), 0);
  assert.equal(status(f, 'task', next), 'READY');
  const events = f.db.prepare("SELECT reason FROM event WHERE entity_id = 'run-left' AND action = 'orphan_run_unconfirmed'")
    .all() as { reason: string }[];
  assert.equal(events.length, 1);
  assert.match(events[0]!.reason, /task CANCELLED; unit unknown; executor could not confirm it stopped; slot kept/);
  assert.match(taskShow(f.db, next), /等待原因: .*fake: concurrency 1\/1.*Run run-left（任务 [0-9a-f-]+，CANCELLED）/);
  const cli = await cancel(f.db, f.config, 'run-left', routers.get(old));
  assert.equal(cli.confirmed, false);
  assert.equal(cli.residue?.[0]?.outcome, 'unconfirmed');
  assert.equal(status(f, 'run', 'run-left'), 'running');
});

test('cancel closes a FAILED Task residue by Run id, reports no residue afterwards, and closes once when raced', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const old = seedResidue(f, 'FAILED');
  const router = fakeTaskRouter(f, old, () => {}, [], undefined, 'exited');
  const [first, second] = await Promise.all([cancel(f.db, f.config, 'run-left', router), cancel(f.db, f.config, old, router)]);
  const closed = [...first.residue!, ...second.residue!];
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0], { runId: 'run-left', outcome: 'closed', taskStatus: 'FAILED', unit: 'exited', releasedLocks: 1 });
  assert.equal(count(f, "SELECT count(*) AS n FROM event WHERE entity_id = 'run-left' AND action = 'orphan_run_closed'"), 1);
  assert.equal(status(f, 'task', old), 'FAILED');
  assert.deepEqual(await cancel(f.db, f.config, old, router), { confirmed: true, releasedLocks: 0, residue: [] });
  assert.deepEqual(await cancel(f.db, f.config, 'run-left', router), { confirmed: true, releasedLocks: 0, residue: [] });
});

test('unitySteps require unity_batch and fake Unity failure retries with evidence before readback', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: ['Library'], defaultTimeoutSec: 10, passEnv: ['DISPLAY'] };
  const file = join(f.root, 'unity-task.yaml');
  const task = { schema: 'task/0.1', goal: 'run Unity batch', allowedWrites: [], expectedOutputs: ['run:result.json'],
    checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }], maxRetries: 1,
    unitySteps: [{ method: 'Example.Batch.Run', quit: false }] };
  writeFileSync(file, stringify(task));
  assert.throws(() => taskAdd(f.config, f.db, 'sample', file), /unity_batch/);
  writeFileSync(file, stringify({ ...task, resources: ['unity_batch'],
    unitySteps: [{ method: 'Example.Batch.Run', env: { XDG_RUNTIME_DIR: '/tmp' } }] }));
  assert.throws(() => taskAdd(f.config, f.db, 'sample', file), /保留变量/);
  writeFileSync(file, stringify({ ...task, resources: ['unity_batch'] }));
  const id = taskAdd(f.config, f.db, 'sample', file), prompts: string[] = [];
  let calls = 0;
  const router = fakeTaskRouter(f, id, () => {}, prompts);
  (router as unknown as { unityUnit: (runId: string) => unknown }).unityUnit = (runId: string) => {
    const runDir = join(f.home, 'runs', runId), unitDir = join(runDir, `unity-${runId}`);
    return { handle: { ref: `avh-run-unity-${runId}` }, executor: {
      start: async () => {
        calls++;
        mkdirSync(unitDir, { recursive: true });
        writeFileSync(join(unitDir, 'command.json'), '{}');
        if (calls === 2) writeFileSync(join(runDir, 'result.json'), '{"status":"ok"}');
        writeFileSync(join(runDir, 'unity-steps.json'), JSON.stringify({ status: 'finished', evidence: [
          { index: 1, method: 'Example.Batch.Run', exitCode: calls === 1 ? 1 : 0,
            durationMs: 1, log: join(runDir, 'unity-1.log'),
            errors: calls === 1 ? ['synthetic Unity failure'] : [], waits: 0 }] }));
        writeFileSync(join(unitDir, 'exit.json'), JSON.stringify({ exitStatus: calls === 1 ? 1 : 0 }));
        return { ref: `avh-run-unity-${runId}` };
      },
      observe: () => ({ state: 'exited' }),
      collect: () => ({ exitStatus: 0, outputs: {} }),
    } };
  };
  await serveOnce(f.db, f.config, () => router);
  assert.equal(calls, 1);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM verdict').get() as { n: number }).n, 0);
  await serveOnce(f.db, f.config, () => router);
  assert.equal(calls, 2);
  const first = f.db.prepare('SELECT id, result_json FROM run WHERE task_id=? ORDER BY attempt LIMIT 1')
    .get(id) as { id: string; result_json: string };
  const failed = JSON.parse(first.result_json) as RunResult;
  assert.equal(failed.unitySteps?.[0]?.index, 1);
  assert.match(failed.errorMessage!, /Unity 步骤 1.*Provider 产物保留.*synthetic Unity failure/);
  const event = f.db.prepare("SELECT reason FROM event WHERE entity_id = ? AND action = 'unity_step_failed'")
    .get(first.id) as { reason: string };
  assert.match(event.reason, /Unity 步骤 1.*Provider 产物保留.*synthetic Unity failure/);
  assert.match(prompts[1]!, /Unity 步骤 1.*Provider 产物保留.*synthetic Unity failure/);
  assert.equal(prompts.length, 2);
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: PASSED/);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM verdict').get() as { n: number }).n, 1);
  const latest = f.db.prepare('SELECT process_ref FROM run WHERE task_id=? ORDER BY attempt DESC LIMIT 1')
    .get(id) as { process_ref: string };
  await router.collect({ ref: latest.process_ref });
  assert.equal(calls, 2); // collected evidence is durable; Unity is not launched twice
});

test('a Unity step that lost the licensing client carries what to do into the result, the event log and the retry prompt', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: ['Library'], defaultTimeoutSec: 10, passEnv: ['DISPLAY'] };
  const file = join(f.root, 'unity-licence.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'run Unity batch', allowedWrites: [], expectedOutputs: ['run:result.json'],
    checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }], maxRetries: 1, resources: ['unity_batch'],
    unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file), prompts: string[] = []; let calls = 0;
  const router = fakeTaskRouter(f, id, () => {}, prompts);
  // What `runUnitySteps` produces for the recorded failure (test/exec/unity-steps.test.ts covers that half).
  const guidance = '另一个 Unity 正在占用本机按账户共享的授权客户端（Unity 的授权客户端通道连不上，编辑器在运行步骤代码前就以退出码 199 中止），'
    + '所以这次失败不是方案或工程的问题。占用者：Unity 编辑器 PID 4242（Unity.exe，工程 C:\\other）。'
    + '需要你做的：关闭上面那个 Unity（或等它结束），再重跑这个 Unity 步骤即可；不用改配置或工程。';
  (router as unknown as { unityUnit: (runId: string) => unknown }).unityUnit = (runId: string) => {
    const runDir = join(f.home, 'runs', runId), unitDir = join(runDir, `unity-${runId}`);
    return { handle: { ref: `avh-run-unity-${runId}` }, executor: {
      start: async () => {
        calls++;
        mkdirSync(unitDir, { recursive: true });
        writeFileSync(join(unitDir, 'command.json'), '{}');
        if (calls === 2) writeFileSync(join(runDir, 'result.json'), '{"status":"ok"}');
        writeFileSync(join(runDir, 'unity-steps.json'), JSON.stringify({ status: 'finished', evidence: [
          { index: 1, method: 'Example.Batch.Run', exitCode: calls === 1 ? 199 : 0, durationMs: 1, log: join(runDir, 'unity-1.log'),
            errors: calls === 1 ? ['另一个 Unity 占用本机授权客户端（退出码 199）'] : [], waits: 0,
            ...(calls === 1 ? { licence: { exitCode: 199, evidence: ['Timed-out after 60.01s, waiting for channel: "LicenseClient-u"'],
              competitors: [{ pid: 4242, name: 'Unity.exe', commandLine: 'Unity.exe -projectPath C:\\other', project: 'C:\\other', kind: 'editor' }],
              retries: 1, waitedMs: 120_000 }, guidance } : {}) }] }));
        writeFileSync(join(unitDir, 'exit.json'), JSON.stringify({ exitStatus: calls === 1 ? 1 : 0 }));
        return { ref: `avh-run-unity-${runId}` };
      },
      observe: () => ({ state: 'exited' }),
      collect: () => ({ exitStatus: 0, outputs: {} }),
    } };
  };
  await serveOnce(f.db, f.config, () => router);
  await serveOnce(f.db, f.config, () => router);
  const first = f.db.prepare('SELECT id, result_json FROM run WHERE task_id=? ORDER BY attempt LIMIT 1')
    .get(id) as { id: string; result_json: string };
  const failed = JSON.parse(first.result_json) as RunResult;
  assert.equal(failed.exitStatus, 199);
  assert.match(failed.errorMessage!, /另一个 Unity 占用本机授权客户端/);
  assert.match(failed.errorMessage!, /需要你做的：关闭上面那个 Unity/);
  assert.equal(failed.unitySteps?.[0]?.licence?.competitors[0]?.pid, 4242, 'the holder stays in the Run result as evidence');
  const event = f.db.prepare("SELECT reason FROM event WHERE entity_id = ? AND action = 'unity_step_failed'")
    .get(first.id) as { reason: string };
  assert.match(event.reason, /需要你做的：关闭上面那个 Unity/);
  assert.match(prompts[1]!, /需要你做的：关闭上面那个 Unity/, 'the retry carries what the person must do, not only that it failed');
});

test('a Unity step waiting on the machine batch slot is in the timeline while it waits, once per wait', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: ['Library'], defaultTimeoutSec: 10, passEnv: ['DISPLAY'] };
  const file = join(f.root, 'unity-waiting.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'run Unity batch', allowedWrites: [], expectedOutputs: ['run:result.json'],
    checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }], maxRetries: 0, resources: ['unity_batch'],
    unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file), prompts: string[] = [];
  let unitRunDir = '';
  const router = fakeTaskRouter(f, id, () => {}, prompts);
  (router as unknown as { unityUnit: (runId: string) => unknown }).unityUnit = (runId: string) => {
    const runDir = join(f.home, 'runs', runId), unitDir = join(runDir, `unity-${runId}`);
    unitRunDir = runDir;
    return { handle: { ref: `avh-run-unity-${runId}` }, executor: {
      start: async () => {
        mkdirSync(unitDir, { recursive: true });
        writeFileSync(join(unitDir, 'command.json'), '{}');
        // What unity-worker.ts leaves behind: the journal says started, and the marker counts the wait.
        writeFileSync(join(runDir, 'unity-steps.json'), JSON.stringify({ status: 'started' }));
        writeFileSync(join(runDir, 'unity-waiting.json'), JSON.stringify({ schema: 'unity-waiting/0.1', index: 1, wait: 1,
          since: '2026-10-04T00:00:00.000Z', reason: 'Unity 批处理槽位被占用；等它释放后重试' }));
        return { ref: `avh-run-unity-${runId}` };
      },
      observe: () => ({ state: 'running' }),
      collect: () => ({ exitStatus: 0, outputs: {} }),
    } };
  };
  const waits = () => f.db.prepare("SELECT reason FROM event WHERE action = 'unity_waiting' ORDER BY seq").all() as { reason: string }[];
  await serveOnce(f.db, f.config, () => router);   // the Provider starts
  await serveOnce(f.db, f.config, () => router);   // the Provider exits; the Unity unit starts and is given its marker
  await serveOnce(f.db, f.config, () => router);   // observed while it waits
  assert.equal(waits().length, 1, 'the first wait is recorded while the step is still running');
  assert.match(waits()[0]!.reason, /Unity 步骤 1 等待机器级批处理槽位/);
  assert.match(waits()[0]!.reason, /自 2026-10-04T00:00:00\.000Z/);
  await serveOnce(f.db, f.config, () => router);
  assert.equal(waits().length, 1, 'looking at the same wait again does not repeat the event');
  // The step's own counter moving on is a new wait, and the timeline should show that too.
  writeFileSync(join(unitRunDir, 'unity-waiting.json'), JSON.stringify({ schema: 'unity-waiting/0.1', index: 1, wait: 2,
    since: '2026-10-04T00:00:00.000Z', reason: 'Unity 批处理槽位被占用；等它释放后重试' }));
  await serveOnce(f.db, f.config, () => router);
  assert.equal(waits().length, 2);
  assert.match(waits()[1]!.reason, /第 2 次/);
});

test('Runtime preparation is forced after Provider success and before Unity; failure blocks Unity', async t => {
  const runCase = async (prepareExit: number): Promise<{ order:string[]; status:string; result:RunResult }> => {
    const f = fixture(t); f.config.providers[0]!.writable = [];
    f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
      homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
    const file = join(f.root, `prepare-${prepareExit}.yaml`);
    writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'prepare then Unity', allowedWrites: [],
      expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
      maxRetries: 0, resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
    const id = taskAdd(f.config, f.db, 'sample', file), order:string[]=[];
    const router = fakeTaskRouter(f,id,()=>{order.push('provider');},[]);
    (router.spec as unknown as {prepare:unknown}).prepare={argv:['synthetic-prepare'],env:{}};
    (router as unknown as {prepareUnit:(runId:string)=>unknown}).prepareUnit=(runId:string)=>{
      const unitId=`prepare-${runId}`,dir=join(f.home,'runs',runId,unitId);
      return{unitId,handle:{ref:`avh-run-${unitId}`},runner:{
        start:async()=>{order.push('prepare');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'command.json'),'{}');writeFileSync(join(dir,'exit.json'),JSON.stringify({exitStatus:prepareExit}));return{ref:`avh-run-${unitId}`};},
        observe:()=>({state:'exited'}),collect:()=>({exitStatus:prepareExit,outputs:{},...(prepareExit?{errorClass:'tool_failure' as const}: {})}),
        cancel:async()=> 'confirmed' as const}};
    };
    (router as unknown as {unityUnit:(runId:string)=>unknown}).unityUnit=(runId:string)=>{
      const runDir=join(f.home,'runs',runId),dir=join(runDir,`unity-${runId}`);
      return{handle:{ref:`avh-run-unity-${runId}`},executor:{start:async()=>{order.push('unity');mkdirSync(dir,{recursive:true});
        writeFileSync(join(dir,'command.json'),'{}');writeFileSync(join(runDir,'result.json'),'{"status":"ok"}');
        writeFileSync(join(runDir,'unity-steps.json'),JSON.stringify({status:'finished',evidence:[{index:1,method:'Example.Batch.Run',exitCode:0,durationMs:1,log:'',errors:[],waits:0}]}));
        writeFileSync(join(dir,'exit.json'),'{"exitStatus":0}');return{ref:`avh-run-unity-${runId}`};},
        observe:()=>({state:'exited'}),collect:()=>({exitStatus:0,outputs:{}})}};
    };
    await serveOnce(f.db,f.config,()=>router);
    await serveOnce(f.db,f.config,()=>router);
    await serveOnce(f.db,f.config,()=>router);
    const saved=f.db.prepare('SELECT result_json FROM run WHERE task_id=?').get(id) as {result_json:string};
    return{order,status:(f.db.prepare('SELECT status FROM task WHERE id=?').get(id) as {status:string}).status,result:JSON.parse(saved.result_json) as RunResult};
  };
  const success=await runCase(0),failure=await runCase(1);
  assert.deepEqual(success.order,['provider','prepare','unity']);assert.equal(success.status,'PASSED');
  assert.deepEqual(success.result.prepare,{status:'finished',exitStatus:0,outOfBoundsPaths:[]});
  assert.deepEqual(failure.order,['provider','prepare']);assert.equal(failure.status,'FAILED');
  assert.deepEqual(failure.result.prepare,{status:'finished',exitStatus:1,errorClass:'tool_failure',outOfBoundsPaths:[]});
  assert.equal(failure.result.exitStatus,1);assert.equal(failure.result.errorClass,'tool_failure');
});

/** Exercise the real Router journals and Scheduler persistence; only external units are controlled. */
function preparationEvidenceFixture(t:TestContext,result:RunResult={exitStatus:0,outputs:{}},state:'exited'|'unknown'='exited',providerRunning=false,unitOutput:Record<string,string>={}) {
  const f=fixture(t);f.config.providers[0]!.writable=[];
  f.config.unity={runner:join(f.root,'fake-unity'),lockPath:join(f.root,'batch.lock'),busyExitCode:5,
    homeSeedFrom:[],projectScratch:[],defaultTimeoutSec:10,passEnv:[]};
  const file=join(f.root,'prepare-evidence.yaml');
  writeFileSync(file,stringify({schema:'task/0.1',goal:'retain supervised preparation evidence',allowedWrites:[],
    expectedOutputs:['run:result.json'],checks:[{id:'readback',path:'run:result.json',contains:'ok'}],
    maxRetries:0,resources:['unity_batch'],unitySteps:[{method:'Example.Batch.Run'}]}));
  const id=taskAdd(f.config,f.db,'sample',file),router=fakeTaskRouter(f,id,()=>{},[]);
  const controlled=router as unknown as {adapter:()=>{collect:(handle:RunHandle)=>RunResult;observe:()=>{state:'exited'|'running'}};prepareUnit:(runId:string)=>unknown;unityUnit:(runId:string)=>unknown};
  const provider=controlled.adapter();
  provider.collect=()=>({exitStatus:0,outputs:{},prepare:{status:'finished',exitStatus:0,outOfBoundsPaths:['Provider-forged-proof']}});
  if(providerRunning)provider.observe=()=>({state:'running'});
  controlled.adapter=()=>provider;
  router.spec.prepare={argv:['synthetic-prepare'],env:{}};
  controlled.prepareUnit=runId=>{
    const unitId=`prepare-${runId}`,directory=join(f.home,'runs',runId,unitId);
    return{unitId,handle:{ref:`avh-run-${unitId}`},runner:{start:async()=>{
      mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'command.json'),'{}');
      if(state==='exited')writeFileSync(join(directory,'exit.json'),JSON.stringify({exitStatus:result.exitStatus}));
      for(const [name,text] of Object.entries(unitOutput))writeFileSync(join(directory,name),text);
      for(const path of result.outOfBoundsPaths??[])writeFileSync(join(f.project,path),'unexpected preparation write');
      return{ref:`avh-run-${unitId}`};},observe:()=>({state}),collect:()=>structuredClone(result),cancel:async()=> 'confirmed'}};
  };
  let unityStarts=0;
  controlled.unityUnit=runId=>{
    const directory=join(f.home,'runs',runId),unit=join(directory,`unity-${runId}`);
    return{handle:{ref:`avh-run-unity-${runId}`},executor:{start:async()=>{
      unityStarts++;mkdirSync(unit,{recursive:true});writeFileSync(join(unit,'command.json'),'{}');writeFileSync(join(unit,'exit.json'),'{"exitStatus":0}');
      writeFileSync(join(directory,'result.json'),'{"status":"ok"}');
      hostPlatform.writePrivate(join(directory,'unity-steps.json'),JSON.stringify({status:'finished',evidence:[
        {index:1,method:'Example.Batch.Run',exitCode:0,durationMs:1,log:'',errors:[],waits:0}]}),{});
      return{ref:`avh-run-unity-${runId}`};},observe:()=>({state:'exited'}),collect:()=>({exitStatus:0,outputs:{}})}};
  };
  const tick=()=>serveOnce(f.db,f.config,()=>router);
  const run=()=>f.db.prepare('SELECT id,process_ref,result_json FROM run WHERE task_id=?').get(id) as {id:string;process_ref:string;result_json:string|null};
  return{...f,id,router,tick,run,unityStarts:()=>unityStarts};
}

test('preparation evidence keeps successful out-of-bounds facts in persisted RunResult and never trusts Provider preparation fields',async t=>{
  const f=preparationEvidenceFixture(t,{exitStatus:0,outputs:{},outOfBoundsPaths:['escape.txt']});
  for(let i=0;i<3;i++)await f.tick();
  const record=f.run();assert.ok(record.result_json);
  const result=JSON.parse(record.result_json) as RunResult;
  assert.deepEqual(result.prepare,{status:'finished',exitStatus:0,outOfBoundsPaths:['escape.txt']});
  assert.deepEqual(result.outOfBoundsPaths,['escape.txt']);assert.equal(result.exitStatus,0);
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.id)!.status,'WAITING_HUMAN');
  assert.ok(f.db.prepare("SELECT 1 FROM out_of_bounds_change WHERE artifact='workspace:escape.txt'").get());
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM stage_completion').get()!.n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM event WHERE actor='runtime' AND entity_id=? AND action='prepare_unit_intended'").get(record.id)!.n,1);
  const privateResult=JSON.parse(readFileSync(join(f.home,'runs',record.id,'prepare.json'),'utf8'));
  assert.equal(privateResult.status,'finished');assert.equal(privateResult.result.exitStatus,0);
});

// A preparation that fails used to record only that it exited non-zero. The message saying why sat in the
// unit's own stderr with nothing linking to it, so a real failure took a manual reconstruction of the
// command and its environment before it could even be read.
test('a failed preparation carries a diagnostic field, and a successful one does not',async t=>{
  const f=preparationEvidenceFixture(t,{exitStatus:1,outputs:{},errorClass:'tool_failure'},'exited',false,
    {stderr:'ValueError: Runtime source deployment does not match exact source versions\n',stdout:'partial'});
  for(let i=0;i<3;i++)await f.tick();
  const journal=JSON.parse(readFileSync(join(f.home,'runs',f.run().id,'prepare.json'),'utf8'));
  assert.equal(journal.status,'finished');
  assert.equal(journal.result.exitStatus,1);
  // The field is present on failure. Its content is covered by the unit test below, because this fixture
  // mocks the unit's runner and therefore does not leave real logs where the reader looks.
  assert.equal(typeof journal.diagnostic,'object','a failed preparation must carry a diagnostic');
});

test('a successful preparation does not grow a diagnostic',async t=>{
  const f=preparationEvidenceFixture(t,{exitStatus:0,outputs:{}},'exited',false,{stderr:'noise'});
  for(let i=0;i<3;i++)await f.tick();
  const journal=JSON.parse(readFileSync(join(f.home,'runs',f.run().id,'prepare.json'),'utf8'));
  assert.equal(journal.diagnostic,undefined);
});

test('the preparation diagnostic reads the unit output and bounds it',t=>{
  const dir=mkdtempSync(join(tmpdir(),'avh-diagnostic-'));t.after(()=>removeTemp(dir));
  writeFileSync(join(dir,'stderr.log'),'the reason it failed\n');
  writeFileSync(join(dir,'stdout.log'),'partial output');
  assert.deepEqual(toolDiagnostic(dir),{stderr:'the reason it failed\n',stdout:'partial output'});
  // A unit that wrote nothing yields no keys, so the journal does not grow empty fields.
  assert.deepEqual(toolDiagnostic(join(dir,'missing')),{});
  // Long output is kept from the end, where the error is, and bounded.
  writeFileSync(join(dir,'stderr.log'),'x'.repeat(9000)+'the tail');
  const bounded=String((toolDiagnostic(dir,100) as {stderr:string}).stderr);
  assert.ok(bounded.length<=101,'the diagnostic must be bounded');
  assert.ok(bounded.endsWith('the tail'),'the end of the output is the part worth keeping');
});

test('preparation evidence supplied only by a Provider is discarded before RunResult persistence',async t=>{
  const f=preparationEvidenceFixture(t);delete f.router.spec.prepare;
  for(let i=0;i<2;i++)await f.tick();
  const record=f.run();assert.ok(record.result_json);
  assert.equal((JSON.parse(record.result_json) as RunResult).prepare,undefined);
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.id)!.status,'PASSED');
  assert.equal(existsSync(join(f.home,'runs',record.id,'prepare.json')),false);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM event WHERE action='prepare_unit_intended'").get()!.n,0);
});

test('preparation evidence requires the current workflow Runtime intent and cannot authorize Unity using another actor',async t=>{
  for(const forged of ['missing','human','another-workflow'] as const) {
    const f=preparationEvidenceFixture(t,{exitStatus:0,outputs:{}},'exited',true);await f.tick();
    const record=f.run(),journal=join(f.home,'runs',record.id,'prepare.json');
    hostPlatform.writePrivate(journal,JSON.stringify({status:'finished',result:{exitStatus:0,outputs:{}}}),{});
    let workflow=String(f.db.prepare('SELECT workflow_id FROM task WHERE id=?').get(f.id)!.workflow_id);
    if(forged==='another-workflow') {
      const other=taskAdd(f.config,f.db,'sample',f.spec());
      f.db.prepare("UPDATE task SET status='CANCELLED' WHERE id=?").run(other);
      workflow=String(f.db.prepare('SELECT workflow_id FROM task WHERE id=?').get(other)!.workflow_id);
    }
    if(forged!=='missing')f.db.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason)
      VALUES(?,?,'run',?,'prepare_unit_intended','counterfeit preparation intent')`).run(workflow,forged==='human'?'human':'runtime',record.id);
    await assert.rejects(f.router.collect({ref:record.process_ref}),/no Runtime unit intent/);
    await f.tick();
    assert.equal(f.run().result_json,null,forged);assert.equal(f.unityStarts(),0,forged);
    assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.id)!.status,'RECOVERY_REQUIRED');
  }
});

test('preparation evidence cancellation and unknown outcomes do not become completed successful preparation',async t=>{
  const unknown=preparationEvidenceFixture(t,{exitStatus:0,outputs:{}},'unknown');await unknown.tick();await unknown.tick();
  const pending=unknown.run();assert.equal(pending.result_json,null);assert.equal(unknown.unityStarts(),0);
  await assert.rejects(unknown.router.collect({ref:pending.process_ref}),/Prepare outcome unknown/);
  const cancelled=preparationEvidenceFixture(t,{exitStatus:0,outputs:{}},'unknown');await cancelled.tick();
  assert.deepEqual(await cancel(cancelled.db,cancelled.config,cancelled.id,cancelled.router),{confirmed:true});
  const record=cancelled.run();assert.ok(record.result_json);
  const result=JSON.parse(record.result_json) as RunResult;
  assert.equal(result.exitStatus,143);assert.equal(result.prepare,undefined);assert.equal(cancelled.unityStarts(),0);
  assert.equal(cancelled.db.prepare('SELECT status FROM run WHERE id=?').get(record.id)!.status,'cancelled');
});

test('preparation evidence missing an actual exit code stays unknown and cannot persist a finished result',async t=>{
  const f=preparationEvidenceFixture(t);await f.tick();
  const record=f.run();hostPlatform.writePrivate(join(f.home,'runs',record.id,'prepare.json'),JSON.stringify({status:'finished',result:{outputs:{}}}),{});
  await assert.rejects(f.router.collect({ref:record.process_ref}),/Prepare outcome unknown|exit/i);
  await f.tick();assert.equal(f.run().result_json,null);assert.equal(f.unityStarts(),0);
});

test('collect is read only and cancelling before Unity starts closes Run without launch', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
  const file = join(f.root, 'cancel-before-unity.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'cancel before Unity', allowedWrites: [],
    expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
    resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const router = fakeTaskRouter(f, id, () => {}, [], undefined, 'running');
  let launches = 0;
  (router as unknown as { unityUnit: (runId: string) => unknown }).unityUnit = () => ({
    handle: { ref: 'unused' }, executor: { start: () => { launches++; throw new Error('Unity started'); } },
  });
  await serveOnce(f.db, f.config, () => router);
  const run = f.db.prepare('SELECT id, process_ref FROM run WHERE task_id = ?').get(id) as
    { id: string; process_ref: string };
  const journal = join(f.home, 'runs', run.id, 'unity-steps.json');
  const collected = await router.collect({ ref: run.process_ref });
  assert.equal(collected.exitStatus, 0);
  assert.equal(collected.unitySteps?.[0]?.status, 'not_started');
  assert.match(collected.unitySteps![0]!.errors[0]!, /未开始/);
  assert.equal(existsSync(journal), false);
  assert.equal(launches, 0);
  assert.deepEqual(await cancel(f.db, f.config, id, router), { confirmed: true });
  assert.equal(launches, 0);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, 'CANCELLED');
  const closed = f.db.prepare('SELECT status, result_json FROM run WHERE id = ?').get(run.id) as
    { status: string; result_json: string };
  assert.equal(closed.status, 'cancelled');
  assert.equal((JSON.parse(closed.result_json) as RunResult).unitySteps?.[0]?.status, 'not_started');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM lock').get() as { n: number }).n, 0);
});

test('Unity unit yields to another task in one serve round and verifies after five seconds', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
  const unitySpec = join(f.root, 'async-unity.yaml');
  writeFileSync(unitySpec, stringify({ schema: 'task/0.1', goal: 'run synthetic Unity', allowedWrites: [],
    expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
    resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const a = taskAdd(f.config, f.db, 'sample', unitySpec);
  const other = join(f.root, 'workspace', 'sample-b');
  mkdirSync(other); writeFileSync(join(other, 'baseline.txt'), 'baseline\n');
  execFileSync('git', ['init', '-q', other]);
  execFileSync('git', ['-C', other, 'add', 'baseline.txt']);
  execFileSync('git', ['-C', other, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'baseline']);
  f.config.sampleNames.push('sample-b');
  const b = taskAdd(f.config, f.db, 'sample-b', f.spec());
  const routerA = fakeTaskRouter(f, a, () => {}, []);
  const routerB = fakeTaskRouter(f, b, () => writeFileSync(join(other, 'result.txt'), 'ok\n'), []);
  let stopped = false;
  let released = false, fiveSecondsElapsed = false;
  let finishUnit = () => {};
  let signalFinished = () => {};
  const finished = new Promise<void>(resolve => { signalFinished = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  t.after(() => { stopped = true; if (timer) clearTimeout(timer); });
  (routerA as unknown as { unityUnit: (runId: string) => unknown }).unityUnit = (runId: string) => {
    const runDir = join(f.config.home, 'runs', runId), unitDir = join(runDir, `unity-${runId}`);
    return { handle: { ref: `avh-run-unity-${runId}` }, executor: {
      start: async () => {
        mkdirSync(unitDir, { recursive: true }); writeFileSync(join(unitDir, 'command.json'), '{}');
        finishUnit = () => {
          if (stopped) return;
          writeFileSync(join(runDir, 'result.json'), '{"status":"ok"}');
          writeFileSync(join(runDir, 'unity-steps.json'), JSON.stringify({ status: 'finished', evidence: [
            { index: 1, method: 'Example.Batch.Run', exitCode: 0, durationMs: 5000,
              log: join(runDir, 'unity-1.log'), errors: [], waits: 0 }] }));
          writeFileSync(join(unitDir, 'exit.json'), '{"exitStatus":0}');
          signalFinished();
        };
        timer = setTimeout(() => { fiveSecondsElapsed = true; if (released) finishUnit(); }, 5000); timer.unref();
        return { ref: `avh-run-unity-${runId}` };
      },
      observe: () => ({ state: existsSync(join(unitDir, 'exit.json')) ? 'exited' : 'running' }),
      collect: () => ({ exitStatus: 0, outputs: {} }),
      cancel: async () => { stopped = true; writeFileSync(join(unitDir, 'exit.json'), '{"exitStatus":143}'); return 'confirmed'; },
    } };
  };
  const routers = new Map([[a, routerA], [b, routerB]]);
  let roundTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([serveOnce(f.db, f.config, id => routers.get(id)!), new Promise<never>((_, reject) => {
      roundTimeout = setTimeout(() => reject(new Error('scheduler waited for the unreleased Unity unit')), 60000);
    })]);
  } finally { if (roundTimeout) clearTimeout(roundTimeout); }
  // Completion stays impossible until this round returns: prove progress, not a machine-speed benchmark.
  assert.match(taskShow(f.db, a), /状态: RUNNING/);
  assert.match(taskShow(f.db, b), /状态: PASSED/);
  released = true; if (fiveSecondsElapsed) finishUnit(); await finished;
  await serveOnce(f.db, f.config, id => routers.get(id)!);
  assert.match(taskShow(f.db, a), /状态: PASSED/);
});

test('cancelling a running Unity unit confirms stop before task cancellation', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
  const file = join(f.root, 'cancel-unity.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'cancel synthetic Unity', allowedWrites: [],
    expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
    resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const router = fakeTaskRouter(f, id, () => {}, []);
  let stopped = false;
  let signalStart: () => void = () => {};
  const started = new Promise<void>(resolve => { signalStart = resolve; });
  (router as unknown as { unityUnit: (runId: string) => unknown }).unityUnit = (runId: string) => {
    const dir = join(f.config.home, 'runs', runId, `unity-${runId}`);
    return { handle: { ref: `avh-run-unity-${runId}` }, executor: {
      start: async () => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'command.json'), '{}');
        signalStart(); await delay(100);
        return { ref: `avh-run-unity-${runId}` }; },
      observe: () => ({ state: stopped ? 'exited' : 'running' }),
      cancel: async () => { stopped = true; writeFileSync(join(dir, 'exit.json'), '{"exitStatus":143}'); return 'confirmed'; },
      collect: () => ({ exitStatus: 143, outputs: {} }),
    } };
  };
  const serving = serveOnce(f.db, f.config, () => router);
  await started;
  assert.match(taskShow(f.db, id), /状态: RUNNING/);
  const cancelling = cancel(f.db, f.config, id, router);
  await serving;
  assert.deepEqual(await cancelling, { confirmed: true });
  assert.ok(stopped);
  assert.match(taskShow(f.db, id), /状态: CANCELLED/);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM lock').get() as { n: number }).n, 0);
});

test('unknown Unity unit after launch requires recovery without relaunch', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
  const file = join(f.root, 'unknown-unity.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'unknown synthetic Unity', allowedWrites: [],
    expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
    resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file), router = fakeTaskRouter(f, id, () => {}, []);
  let starts = 0;
  (router as unknown as { unityUnit: (runId: string) => unknown }).unityUnit = (runId: string) => ({
    handle: { ref: `avh-run-unity-${runId}` }, executor: {
      start: async () => { starts++; return { ref: `avh-run-unity-${runId}` }; },
      observe: () => ({ state: 'unknown' }),
    },
  });
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: RUNNING/);
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: RECOVERY_REQUIRED/);
  await serveOnce(f.db, f.config, () => router);
  assert.equal(starts, 1);
});

test('Unity unit timeout becomes step evidence and skips checks', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 2, passEnv: [] };
  const file = join(f.root, 'timeout-unity.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'timeout synthetic Unity', allowedWrites: [],
    expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
    resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file), router = fakeTaskRouter(f, id, () => {}, []);
  (router as unknown as { unityUnit: (runId: string) => unknown }).unityUnit = (runId: string) => {
    const dir = join(f.config.home, 'runs', runId, `unity-${runId}`);
    return { handle: { ref: `avh-run-unity-${runId}` }, executor: {
      start: async () => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'command.json'), '{}');
        writeFileSync(join(dir, 'exit.json'), '{"exitStatus":124,"timedOut":true}');
        return { ref: `avh-run-unity-${runId}` }; },
      observe: () => ({ state: 'exited' }),
      collect: () => ({ exitStatus: 124, timedOut: true, outputs: {} }),
    } };
  };
  await serveOnce(f.db, f.config, () => router);
  await serveOnce(f.db, f.config, () => router);
  const result = f.db.prepare('SELECT result_json FROM run WHERE task_id = ?').get(id) as { result_json: string };
  assert.equal((JSON.parse(result.result_json) as RunResult).unitySteps?.[0]?.timedOut, true);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM verdict').get() as { n: number }).n, 0);
});

test('dispatch checks whether a Provider can run now, not when the Task froze its snapshot', async t => {
  const f = fixture(t); const executable = f.config.providers[0]!.executable; f.config.providerProbeTtlMs = 0;
  const id = taskAdd(f.config, f.db, 'sample', f.spec());
  const router = fakeTaskRouter(f, id, () => writeFileSync(join(f.project, 'result.txt'), 'ok\n'), []);
  // Windows has no execute permission to take away; the command goes missing instead.
  if (windows) renameSync(executable, `${executable}.away`); else chmodSync(executable, 0o000);
  await serveOnce(f.db, f.config, () => router);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM run WHERE task_id = ?').get(id) as { n: number }).n, 0);
  assert.ok(f.db.prepare("SELECT 1 FROM event WHERE entity_id = ? AND action = 'route_waiting' AND reason LIKE '%health/auth%'").get(id));
  if (windows) renameSync(`${executable}.away`, executable); else chmodSync(executable, 0o700);
  await serveOnce(f.db, f.config, () => router);
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: PASSED/);
});

test('observations an executor plants in its Run are gone before the Unity steps start', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  f.config.unity = { runner: join(f.root, 'fake-unity'), lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 2, passEnv: [] };
  const file = join(f.root, 'forged-observation.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'measure after the executor', allowedWrites: [],
    expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
    resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const planted = (runId: string) => join(f.config.home, 'runs', runId, 'observations', 'avatar.fit.json');
  const router = fakeTaskRouter(f, id, runId => {
    mkdirSync(join(f.config.home, 'runs', runId, 'observations'), { recursive: true });
    writeFileSync(planted(runId), '{"fit_pierced_vertices":0}');
  }, []);
  const seenAtStart: boolean[] = [];
  (router as unknown as { unityUnit: (runId: string) => unknown }).unityUnit = (runId: string) => {
    const dir = join(f.config.home, 'runs', runId, `unity-${runId}`);
    return { handle: { ref: `avh-run-unity-${runId}` }, executor: {
      start: async () => { seenAtStart.push(existsSync(planted(runId))); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'command.json'), '{}'); writeFileSync(join(dir, 'exit.json'), '{"exitStatus":124,"timedOut":true}');
        return { ref: `avh-run-unity-${runId}` }; },
      observe: () => ({ state: 'exited' }),
      collect: () => ({ exitStatus: 124, timedOut: true, outputs: {} }),
    } };
  };
  await serveOnce(f.db, f.config, () => router);
  await serveOnce(f.db, f.config, () => router);
  assert.deepEqual(seenAtStart, [false]);
});

test('systemd Unity unit runs a five-second fake runner without blocking another task',
  { skip: process.env.AVH_SYSTEMD_IT !== '1' }, async t => {
    const f = fixture(t); f.config.providers[0]!.writable = [];
    const runner = join(f.root, 'fake-unity');
    writeFileSync(runner, '#!/bin/sh\nsleep 5\nprintf \'{"status":"ok"}\' > "$AVH_RUN_DIR/result.json"\n');
    chmodSync(runner, 0o700);
    f.config.unity = { runner, lockPath: join(f.root, 'batch.lock'), busyExitCode: 5,
      homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 15, passEnv: ['XDG_RUNTIME_DIR', 'PATH'] };
    const file = join(f.root, 'systemd-unity.yaml');
    writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'run synthetic Unity', allowedWrites: [],
      expectedOutputs: ['run:result.json'], checks: [{ id: 'readback', path: 'run:result.json', contains: 'ok' }],
      resources: ['unity_batch'], unitySteps: [{ method: 'Example.Batch.Run' }] }));
    const a = taskAdd(f.config, f.db, 'sample', file);
    const other = join(f.root, 'workspace', 'sample-b');
    mkdirSync(other); writeFileSync(join(other, 'baseline.txt'), 'baseline\n');
    execFileSync('git', ['init', '-q', other]); execFileSync('git', ['-C', other, 'add', 'baseline.txt']);
    execFileSync('git', ['-C', other, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'baseline']);
    f.config.sampleNames.push('sample-b');
    const b = taskAdd(f.config, f.db, 'sample-b', f.spec());
    const routerA = fakeTaskRouter(f, a, () => {}, []);
    const routerB = fakeTaskRouter(f, b, () => writeFileSync(join(other, 'result.txt'), 'ok\n'), []);
    const routers = new Map([[a, routerA], [b, routerB]]);
    const started = performance.now();
    await serveOnce(f.db, f.config, id => routers.get(id)!);
    assert.ok(performance.now() - started < 1000);
    assert.match(taskShow(f.db, a), /状态: RUNNING/);
    assert.match(taskShow(f.db, b), /状态: PASSED/);
    await waitFor(async () => { await serveOnce(f.db, f.config, id => routers.get(id)!); return taskShow(f.db, a); },
      { what: 'the first project to pass once its writer exited', ready: shown => shown.includes('状态: PASSED'),
        timeoutMs: 30_000, intervalMs: 200, detail: () => taskShow(f.db, a) });
    assert.match(taskShow(f.db, a), /状态: PASSED/);
  });

test('empty Provider writable is eligible; read-only Run report passes without project changes', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const file = join(f.root, 'readonly.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'Read baseline.txt and report it',
    allowedWrites: [], expectedOutputs: ['run:report.md'],
    checks: [{ id: 'readback', path: 'run:report.md', contains: 'baseline' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const before = execFileSync('git', ['-C', f.project, 'status', '--porcelain'], { encoding: 'utf8' });
  const prompts: string[] = [];
  const router = fakeTaskRouter(f, id, runId => {
    writeFileSync(join(f.home, 'runs', runId, 'report.md'), 'baseline verified\n');
  }, prompts);
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: PASSED/);
  assert.equal(execFileSync('git', ['-C', f.project, 'status', '--porcelain'], { encoding: 'utf8' }), before);
  assert.match(prompts[0]!, /只读：不得改动项目内任何文件/);
  assert.match(prompts[0]!, pathPattern(f.project));
  assert.match(prompts[0]!, /不要 git commit.*不要启动 Unity/);
  assert.match(prompts[0]!, /runs[\\/].*[\\/]report\.md/);
});

// A read-only task still has to produce its Run-directory output, and the Run directory is always
// writable. Saying only "只读：不得改动项目内任何文件" told a real coordinator it could not write
// anything, so it returned the required JSON in its answer instead of writing the file, and the task
// blocked on the missing artifact. Pin the two sentences that stop that misreading.
test('a read-only task is still told to write its Run-directory output', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const file = join(f.root, 'readonly-output.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'Report the baseline',
    allowedWrites: [], expectedOutputs: ['run:report.md'],
    checks: [{ id: 'readback', path: 'run:report.md', contains: 'baseline' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const prompts: string[] = [];
  const router = fakeTaskRouter(f, id, runId => { writeFileSync(join(f.home, 'runs', runId, 'report.md'), 'baseline\n'); }, prompts);
  await serveOnce(f.db, f.config, () => router);
  const prompt = prompts[0]!;
  // The project restriction stays, but it must no longer read as a blanket ban on writing.
  assert.match(prompt, /只读：不得改动项目内任何文件/);
  assert.match(prompt, /Run 目录始终可写/);
  assert.match(prompt, /Expected outputs 必须由你实际写出/);
});

test('legacy write task explains that Run artifacts are generated by Runtime', { skip: windows && 'legacy DSH runs on Linux only (D5)' }, async t => {
  const f = fixture(t);
  f.config.providers[0]!.adapter = 'legacy-dsh-task';
  f.config.providers[0]!.balanceCheck = ['/bin/true'];
  f.config.providers[0]!.toolRoot = f.config.toolRoot;
  mkdirSync(join(f.config.toolRoot, '通用工具'), { recursive: true });
  writeFileSync(join(f.config.toolRoot, '通用工具/dsh_task.js'), '');
  const id = taskAdd(f.config, f.db, 'sample', f.spec());
  const prompts: string[] = [];
  const router = fakeTaskRouter(f, id, () => writeFileSync(join(f.project, 'result.txt'), 'ok'), prompts);
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: PASSED/);
  assert.match(prompts[0]!, /本 Provider 只能写项目目录；Run 目录对你只读，其中的产物由 Runtime 生成/);
});

test('fake self Provider external evidence does not block a read-only report', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const file = join(f.root, 'external.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'report', allowedWrites: [],
    expectedOutputs: ['run:report.md'],
    checks: [{ id: 'readback', path: 'run:report.md', contains: 'ok' }] }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const router = fakeTaskRouter(f, id, () => {}, []);
  (router as unknown as { adapter: () => unknown }).adapter = () => ({
    start: async (request: { runId: string }) => ({ ref: `avh-run-${request.runId}` }),
    observe: () => ({ state: 'exited' }),
    collect: (handle: RunHandle) => {
      writeFileSync(join(f.home, 'runs', handle.ref.slice('avh-run-'.length), 'report.md'), 'ok');
      return { exitStatus: 0, outputs: {}, outOfBoundsPaths: [],
        externalChanges: [{ path: 'outside.txt', before: ' M:file:1:2:3', after: 'clean' }] };
    },
    cancel: async () => 'confirmed',
  });
  await serveOnce(f.db, f.config, () => router);
  const run = f.db.prepare('SELECT id, result_json FROM run WHERE task_id=?').get(id) as { id: string; result_json: string };
  assert.match(taskShow(f.db, id), /状态: PASSED/);
  assert.equal(JSON.parse(run.result_json).externalChanges[0].path, 'outside.txt');
});

test('Run scan waits for human acceptance, then passes the same Run for write and read-only Tasks', async t => {
  for (const readOnly of [false, true]) {
    const f = fixture(t); f.config.providers[0]!.writable = [];
    const file = join(f.root, `scope-${readOnly}.yaml`);
    writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'scope test',
      allowedWrites: readOnly ? [] : ['result.txt'],
      expectedOutputs: readOnly ? ['run:report.md'] : ['result.txt'],
      checks: [{ id: 'readback', path: readOnly ? 'run:report.md' : 'result.txt', contains: 'ok' }] }));
    const id = taskAdd(f.config, f.db, 'sample', file);
    const router = fakeTaskRouter(f, id, runId => {
      if (readOnly) writeFileSync(join(f.home, 'runs', runId, 'report.md'), 'ok');
      else writeFileSync(join(f.project, 'result.txt'), 'ok');
      writeFileSync(join(f.project, 'escape.txt'), 'unexpected');
    }, []);
    await serveOnce(f.db, f.config, () => router);
    const show = taskShow(f.db, id);
    assert.match(show, /状态: WAITING_HUMAN/);
    assert.match(show, /escape\.txt/);
    assert.match(show, /记录时间=/);
    assert.match(show, /审阅后 task accept-changes 或 task redo/);
    const result = f.db.prepare('SELECT result_json FROM run WHERE task_id=?').get(id) as { result_json: string };
    assert.deepEqual((JSON.parse(result.result_json) as RunResult).outOfBoundsPaths, ['escape.txt']);
    const verdict = f.db.prepare('SELECT result, basis FROM verdict WHERE workflow_id=(SELECT workflow_id FROM task WHERE id=?)')
      .get(id) as { result: string; basis: string };
    assert.equal(verdict.result, 'pass'); assert.doesNotMatch(verdict.basis, /escape\.txt/);
    assert.deepEqual(taskAcceptChanges(f.db, id, 'reviewed escape', ['escape.txt']),
      { accepted: 1, remaining: 0, status: 'VERIFYING', acceptedPaths: ['workspace:escape.txt'] });
    const runCount = (f.db.prepare('SELECT COUNT(*) AS n FROM run WHERE task_id=?').get(id) as { n: number }).n;
    await serveOnce(f.db, f.config, () => router);
    assert.match(taskShow(f.db, id), /状态: PASSED/);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM run WHERE task_id=?').get(id) as { n: number }).n, runCount);
  }
});

test('accept-changes selects paths, requires a note, and records each human decision', t => {
  const f = fixture(t); const id = taskAdd(f.config, f.db, 'sample', f.spec());
  const workflowId = (f.db.prepare('SELECT workflow_id FROM task WHERE id=?').get(id) as { workflow_id: string }).workflow_id;
  for (const path of ['workspace:a.txt', 'workspace:b.txt'])
    f.db.prepare(`INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact)
      VALUES (?, 'work', ?)`).run(workflowId, path);
  assert.throws(() => taskAcceptChanges(f.db, id, '  '), /--note/);
  const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
  const invoke = (...args: string[]) => spawnSync(process.execPath, [cli, 'task', 'accept-changes', id, ...args],
    { encoding: 'utf8', env: { ...process.env, AVH_HOME: f.home } });
  const first = invoke('--path', 'a.txt', '--note', 'accepted A');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /已接受: workspace:a\.txt\n已接受 1 条；剩余 1 条/);
  assert.deepEqual((f.db.prepare(`SELECT artifact FROM out_of_bounds_change
    WHERE workflow_id=? AND accepted=0`).all(workflowId) as { artifact: string }[]).map(row => row.artifact),
    ['workspace:b.txt']);
  const second = invoke('--note', 'accepted B');
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /已接受: workspace:b\.txt\n已接受 1 条；剩余 0 条/);
  const events = f.db.prepare(`SELECT action, reason FROM event WHERE workflow_id=? AND actor='human'
    AND action IN ('accepted_changes', 'accepted') ORDER BY seq`).all(workflowId) as
    { action: string; reason: string }[];
  assert.deepEqual(events.map(event => event.action),
    ['accepted', 'accepted_changes', 'accepted', 'accepted_changes']);
  assert.deepEqual(events.filter(event => event.action === 'accepted_changes').map(event => event.reason),
    ['accepted A', 'accepted B']);
  const missing = invoke();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--note/);
});

test('accept-changes waits for a pending Gate before verification', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const file = join(f.root, 'gate-scope.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'review report', allowedWrites: [],
    expectedOutputs: ['run:report.md'], checks: [{ id: 'readback', path: 'run:report.md', contains: 'ok' }],
    gate: { id: 'approval', question: 'Accept?', bind: 'run:report.md' } }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const router = fakeTaskRouter(f, id, runId => {
    writeFileSync(join(f.home, 'runs', runId, 'report.md'), 'ok');
    writeFileSync(join(f.project, 'extra.txt'), 'unexpected');
  }, []);
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: WAITING_HUMAN/);
  assert.equal(taskAcceptChanges(f.db, id, 'reviewed').status, 'WAITING_HUMAN');
  const gate = gateList(f.db).split('\n')[1]!.split('\t')[0]!;
  gateDecide(f.db, gate, true, 'approved report');
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: PASSED/);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM run WHERE task_id=?').get(id) as { n: number }).n, 1);
});

test('accept-changes keeps an old BLOCKED Task blocked and points to redo', t => {
  const f = fixture(t); const id = taskAdd(f.config, f.db, 'sample', f.spec());
  const workflowId = (f.db.prepare('SELECT workflow_id FROM task WHERE id=?').get(id) as { workflow_id: string }).workflow_id;
  f.db.prepare(`UPDATE task SET status='BLOCKED' WHERE id=?`).run(id);
  f.db.prepare(`INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact)
    VALUES (?, 'work', 'workspace:old.txt')`).run(workflowId);
  assert.deepEqual(taskAcceptChanges(f.db, id, 'legacy review'),
    { accepted: 1, remaining: 0, status: 'BLOCKED', acceptedPaths: ['workspace:old.txt'] });
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id=?').get(id) as { status: string }).status, 'BLOCKED');
  const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
  const command = spawnSync(process.execPath, [cli, 'task', 'accept-changes', id, '--note', 'repeat review'],
    { encoding: 'utf8', env: { ...process.env, AVH_HOME: f.home } });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /已接受 0 条；剩余 0 条。任务仍为 BLOCKED；请使用 task redo/);
});

test('run: Gate binds the Run report hash and approval passes', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const file = join(f.root, 'gate-run.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1', goal: 'report', allowedWrites: [],
    expectedOutputs: ['run:report.md'], checks: [{ id: 'readback', path: 'run:report.md', contains: 'ok' }],
    gate: { id: 'approval', question: 'Accept?', bind: 'run:report.md' } }));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const router = fakeTaskRouter(f, id, runId => {
    writeFileSync(join(f.home, 'runs', runId, 'report.md'), 'ok');
  }, []);
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: WAITING_HUMAN/);
  const gate = gateList(f.db).split('\n')[1]!.split('\t')[0]!;
  gateDecide(f.db, gate, true, 'reviewed');
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: PASSED/);
});

test('retry prompt carries prior check evidence and absolute write scope', async t => {
  const f = fixture(t); f.config.providers[0]!.writable = [];
  const id = taskAdd(f.config, f.db, 'sample', f.spec());
  const prompts: string[] = []; let good = false;
  const router = fakeTaskRouter(f, id, () => writeFileSync(join(f.project, 'result.txt'), good ? 'ok' : 'bad'), prompts);
  await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: BLOCKED/);
  good = true; taskRedo(f.db, id); await serveOnce(f.db, f.config, () => router);
  assert.match(taskShow(f.db, id), /状态: PASSED/);
  assert.match(prompts[0]!, pathPattern(join(f.project, 'result.txt')));
  assert.match(prompts[1]!, /Previous Run failure and check evidence/);
  assert.match(prompts[1]!, /readback: violation/);
});

test('CLI provider list and task show use temporary AVH_HOME', t => {
  const f = fixture(t); const spec = f.spec();
  const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args],
    { encoding: 'utf8', env: { ...process.env, AVH_HOME: f.home } });
  assert.match(run('provider', 'list', '--probe').stdout, /fake\tcodex-cli\tprobed\tfake 1.0\tready/);
  assert.match(run('provider', 'list').stdout, /health\tsandbox\n.*\tself/);
  assert.match(run('doctor').stdout, /Provider fake\tversion=fake 1\.0; login=ready; quota=unknown; sandbox=self/);
  const added = run('task', 'add', 'sample', '--spec', spec);
  assert.equal(added.status, 0, added.stderr);
  const id = added.stdout.trim().replace(/^Task: /, '');
  assert.match(run('task', 'list', '--project', 'sample').stdout, new RegExp(id));
  assert.match(run('task', 'show', id).stdout, /状态: READY/);
  assert.ok(existsSync(join(f.home, 'state/harness.db')));
});

const live = process.env.AVH_PROVIDER_IT === '1' ? test : test.skip;
live('real codex-cli: read-only Task writes run:report.md in a temporary Git repository', async t => {
  const f = fixture(t);
  const path = join(f.home, 'config/harness.yaml');
  const source = readFileSync(path, 'utf8');
  writeFileSync(path, source.replace('id: fake', 'id: real-codex')
    .replace(/executable: .*fake-codex/, `executable: ${process.env.AVH_CODEX_BIN ?? 'codex'}`));
  const config = loadConfig(f.home);
  config.providers[0]!.writable = [];
  const file = join(f.root, 'live-readonly.yaml');
  writeFileSync(file, stringify({ schema: 'task/0.1',
    goal: 'Read baseline.txt in the project. Write run:report.md containing the word baseline and a short conclusion. Do not edit project files.',
    role: 'executor', allowedWrites: [], expectedOutputs: ['run:report.md'],
    checks: [{ id: 'readback', path: 'run:report.md', contains: 'baseline' }], maxRetries: 0 }));
  const id = taskAdd(config, f.db, 'sample', file);
  const before = execFileSync('git', ['-C', f.project, 'status', '--porcelain'], { encoding: 'utf8' });
  const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
  for (let i = 0; i < 30; i++) {
    const round = spawnSync(process.execPath, [cli, 'serve', '--once'],
      { encoding: 'utf8', env: { ...process.env, AVH_HOME: f.home }, timeout: 30000 });
    assert.equal(round.status, 0, round.stdout + round.stderr);
    const show = taskShow(f.db, id);
    if (show.includes('状态: PASSED')) {
      assert.equal(execFileSync('git', ['-C', f.project, 'status', '--porcelain'], { encoding: 'utf8' }), before);
      t.diagnostic(show); return;
    }
    if (show.includes('状态: FAILED') || show.includes('状态: RECOVERY_REQUIRED')) {
      const latest = f.db.prepare('SELECT id FROM run WHERE task_id=? ORDER BY attempt DESC LIMIT 1')
        .get(id) as { id: string };
      const stderr = join(f.home, 'runs', latest.id, 'stderr.log');
      assert.fail(`${show}\nProvider stderr: ${existsSync(stderr) ? readFileSync(stderr, 'utf8') : 'missing'}`);
    }
    await delay(1000);
  }
  assert.fail(taskShow(f.db, id));
});

function verdictRows(f: { db: import('node:sqlite').DatabaseSync }) {
  return f.db.prepare('SELECT check_id, scope, artifact_hash, result, basis FROM verdict ORDER BY check_id').all() as
    { check_id: string; scope: string; artifact_hash: string; result: string; basis: string }[];
}
function writeSpec(f: { root: string }, name: string, spec: Record<string, unknown>): string {
  const path = join(f.root, `${name}.yaml`);
  writeFileSync(path, stringify({ schema: 'task/0.1', goal: name, role: 'executor', maxRetries: 0, ...spec }));
  return path;
}

test('json checks read the named field from the root: a nested true cannot hide a top-level false', async t => {
  const f = fixture(t);
  const id = taskAdd(f.config, f.db, 'sample', writeSpec(f, 'json-task', {
    allowedWrites: ['report.json'], expectedOutputs: ['report.json'],
    checks: [{ id: 'top-pass', json: 'report.json', field: 'pass', expect: true, scope: 'play' },
      { id: 'nested-pass', json: 'report.json', field: 'details.0.pass', expect: true }] }));
  f.executor.collect = (): RunResult => {
    writeFileSync(join(f.project, 'report.json'), JSON.stringify({ pass: false, details: [{ pass: true }] }));
    return { exitStatus: 0, outputs: {} };
  };
  await f.tick();
  const rows = verdictRows(f);
  assert.deepEqual(rows.map(row => [row.check_id, row.scope, row.result]),
    [['nested-pass', 'edit', 'pass'], ['top-pass', 'play', 'violation']]);
  assert.match(rows[1]!.basis, /expected true, got false/);
  assert.match(taskShow(f.db, id), /状态: BLOCKED/);
});

test('json checks: missing file or field is no_data, malformed JSON is error', async t => {
  const f = fixture(t);
  taskAdd(f.config, f.db, 'sample', writeSpec(f, 'json-missing', {
    allowedWrites: ['a.json', 'b.json'], expectedOutputs: ['a.json', 'b.json'],
    checks: [{ id: 'absent-file', json: 'run:none.json', field: 'pass', expect: true },
      { id: 'absent-field', json: 'a.json', field: 'summary.pass', expect: true, on: 'a.json' },
      { id: 'broken', json: 'b.json', field: 'pass', expect: true, on: 'b.json' }] }));
  f.executor.collect = (): RunResult => {
    writeFileSync(join(f.project, 'a.json'), JSON.stringify({ summary: {} }));
    writeFileSync(join(f.project, 'b.json'), '{"pass": tru');
    return { exitStatus: 0, outputs: {} };
  };
  await f.tick();
  assert.deepEqual(verdictRows(f).map(row => [row.check_id, row.result]),
    [['absent-field', 'no_data'], ['absent-file', 'no_data'], ['broken', 'error']]);
});

test('a check bound with on: carries the hash of that output, not of the first output', async t => {
  const f = fixture(t);
  taskAdd(f.config, f.db, 'sample', writeSpec(f, 'two-outputs', {
    allowedWrites: ['a.txt', 'b.txt'], expectedOutputs: ['a.txt', 'b.txt'],
    checks: [{ id: 'first', path: 'a.txt', contains: 'A' }, { id: 'second', path: 'b.txt', contains: 'B', on: 'b.txt', scope: 'build' }] }));
  f.executor.collect = (): RunResult => {
    writeFileSync(join(f.project, 'a.txt'), 'A'); writeFileSync(join(f.project, 'b.txt'), 'B');
    return { exitStatus: 0, outputs: {} };
  };
  await f.tick();
  const sha = (path: string) => createHash('sha256').update(readFileSync(join(f.project, path))).digest('hex');
  const rows = verdictRows(f);
  assert.equal(rows.find(row => row.check_id === 'first')!.artifact_hash, sha('a.txt'));
  const second = rows.find(row => row.check_id === 'second')!;
  assert.equal(second.artifact_hash, sha('b.txt'));
  assert.equal(second.scope, 'build');
});

test('task specs reject unknown check fields, mixed check kinds and bindings outside expectedOutputs', t => {
  const f = fixture(t);
  const base = { allowedWrites: ['result.txt'], expectedOutputs: ['result.txt'] };
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ id: 'typo', path: 'result.txt', equal: 'ok' }, /未知字段 equal/],
    [{ id: 'mixed', path: 'result.txt', contains: 'ok', command: ['true'] }, /只能有一项/],
    [{ id: 'elsewhere', path: 'result.txt', contains: 'ok', on: 'other.txt' }, /on: 必须是 expectedOutputs/],
    [{ id: 'scope', path: 'result.txt', contains: 'ok', scope: 'runtime' }, /scope: 应为/],
    [{ id: 'no-expect', json: 'result.txt', field: 'pass' }, /需要 expect/],
    [{ id: 'empty-step', json: 'result.txt', field: 'a..b', expect: 1 }, /空段/],
    [{ id: 'slow', command: ['true'], timeoutSec: 99999 }, /timeoutSec/],
  ];
  for (const [check, error] of cases)
    assert.throws(() => taskAdd(f.config, f.db, 'sample', writeSpec(f, `bad-${check.id}`, { ...base, checks: [check] })), error);
});

test('a check script written by the executor runs sandboxed: it cannot write the project or read secrets',
  { skip: !checkSandboxStatus().available }, async t => {
  const f = fixture(t);
  process.env.AVH_TASK_CLI_SECRET = 'provider-api-key';
  t.after(() => { delete process.env.AVH_TASK_CLI_SECRET; });
  taskAdd(f.config, f.db, 'sample', writeSpec(f, 'planted-check', {
    allowedWrites: ['result.txt', 'check.js'], expectedOutputs: ['result.txt'],
    checks: [{ id: 'planted', command: [process.execPath, 'check.js'] }] }));
  f.executor.collect = (): RunResult => {
    writeFileSync(join(f.project, 'result.txt'), 'ok');
    // An executor that wants out plants code the host-side check will run.
    writeFileSync(join(f.project, 'check.js'), [
      "const { writeFileSync } = require('node:fs');",
      `try { writeFileSync(${JSON.stringify(join(f.project, 'planted.txt'))}, 'pwned'); } catch {}`,
      `try { writeFileSync(${JSON.stringify(join(f.home, 'state', 'planted.txt'))}, 'pwned'); } catch {}`,
      "console.log(`secret=${process.env.AVH_TASK_CLI_SECRET ?? 'absent'}`);",
      // The Runtime's configuration (with the BOOTH session) is masked on Linux and unreadable at Low integrity on Windows.
      `try { require('node:fs').readFileSync(${JSON.stringify(join(f.home, 'config', 'harness.yaml'))}); console.log('config=readable'); }`,
      "catch { console.log('config=hidden'); }", ''].join('\n'));
    return { exitStatus: 0, outputs: {} };
  };
  await f.tick();
  const row = verdictRows(f).find(item => item.check_id === 'planted')!;
  assert.equal(row.result, 'pass');
  assert.match(row.basis, windows ? /isolation=lowil/ : /isolation=bwrap/);
  assert.equal(existsSync(join(f.project, 'planted.txt')), false);
  assert.equal(existsSync(join(f.home, 'state', 'planted.txt')), false);
  const runId = (f.db.prepare('SELECT id FROM run').get() as { id: string }).id;
  const log = readFileSync(join(f.home, 'runs', runId, 'checks/planted.stdout.log'), 'utf8');
  assert.match(log, /secret=absent/);
  assert.match(log, /config=hidden/);
});

function takeoverTaskFixture(t: TestContext) {
  const f = fixture(t); f.config.providers[0]!.roles = ['diagnostician'];
  const file = join(f.root, 'takeover.yaml');
  writeFileSync(file, recoveryAnalysisSpec(f.project, 'folder', [f.project], []));
  const id = taskAdd(f.config, f.db, 'sample', file);
  const projectId = String(f.db.prepare('SELECT project_id FROM workflow WHERE id=(SELECT workflow_id FROM task WHERE id=?)').get(id)!.project_id);
  f.db.prepare(`INSERT INTO project_recovery(id,project_id,source_kind,source_path,source_hash,mode,status,analysis_task_id)
    VALUES('takeover-bound',?,'folder',?,'source','deep','analysis_pending',?)`).run(projectId,f.project,id);
  const facts = (bad: boolean) => ({schema:'harness-takeover-facts/1',ready:true,
    facts:[{object:'project',attribute:'structure',value:'present',locator:{path:bad?'Library':'baseline.txt'},basis:'actual input',...(bad?{dependsOn:[0]}:{})}],questions:[]});
  const output = (bad: boolean) => {
    const dir=join(f.project,'_Harness/Recovery');mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'analysis.json'),JSON.stringify({classification:'project',ready:true}));
    writeFileSync(join(dir,'recovery.md'),'# Existing avatar input\n');
    writeFileSync(join(dir,'facts.json'),JSON.stringify(facts(bad)));
  };
  return {...f,id,projectId,file,output};
}

test('takeover full internal check repairs invalid dependencies and absent cache through bounded real Scheduler feedback', async t => {
  const f=takeoverTaskFixture(t), prompts:string[]=[];let attempts=0;
  const router=fakeTaskRouter(f,f.id,()=>f.output(++attempts===1),prompts);
  const firstPolicy=JSON.parse(String(f.db.prepare('SELECT retry_policy_json FROM task WHERE id=?').get(f.id)!.retry_policy_json));
  assert.deepEqual(firstPolicy,{maxRetries:1,maxCheckRetries:1});
  await serveOnce(f.db,f.config,()=>router);
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.id)!.status,'READY','invalid first output cannot become PASSED');
  assert.equal(f.db.prepare('SELECT status FROM project_recovery WHERE id=?').get('takeover-bound')!.status,'analysis_pending');
  const first=f.db.prepare('SELECT result,basis FROM verdict WHERE check_id=?').get('takeover-output-valid')!;
  assert.equal(first.result,'violation');assert.match(String(first.basis),/dependsOn/);assert.match(String(first.basis),/不存在：Library/);
  await serveOnce(f.db,f.config,()=>router,()=>false);
  assert.equal(attempts,1,'paused dispatch must not issue a repair Run');
  await serveOnce(f.db,f.config,()=>router);
  assert.equal(attempts,2);assert.match(prompts[1]!,/Previous Run failure and check evidence/);
  assert.match(prompts[1]!,/takeover-output-valid: violation/);assert.match(prompts[1]!,/dependsOn/);assert.match(prompts[1]!,/不存在：Library/);
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.id)!.status,'PASSED');
  assert.equal(f.db.prepare('SELECT status,project_id FROM project_recovery WHERE id=?').get('takeover-bound')!.status,'ready');
  const inferred=f.db.prepare(`SELECT project_id,status FROM project_fact WHERE source_type='takeover_analysis'`).all();
  assert.equal(inferred.length,2);assert(inferred.every(x=>x.project_id===f.projectId&&x.status==='inferred'));
  const counts=[f.db.prepare('SELECT count(*) n FROM run').get()!.n,f.db.prepare('SELECT count(*) n FROM project_fact').get()!.n];
  await serveOnce(f.db,f.config,()=>router);assert.deepEqual(reconcileRecoveries(f.db,f.projectId),[]);
  assert.deepEqual([f.db.prepare('SELECT count(*) n FROM run').get()!.n,f.db.prepare('SELECT count(*) n FROM project_fact').get()!.n],counts);
});

test('takeover exhausted independent check becomes failed recovery without inferred facts or extra Runs', async t => {
  const f=takeoverTaskFixture(t),prompts:string[]=[];let attempts=0;
  const router=fakeTaskRouter(f,f.id,()=>{attempts++;f.output(true);},prompts);
  await serveOnce(f.db,f.config,()=>router);await serveOnce(f.db,f.config,()=>router);
  assert.equal(attempts,2);assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(f.id)!.status,'BLOCKED');
  const recovery=f.db.prepare('SELECT status,warnings_json FROM project_recovery WHERE id=?').get('takeover-bound')!;
  assert.equal(recovery.status,'failed');assert.match(String(recovery.warnings_json),/dependsOn/);assert.match(String(recovery.warnings_json),/Library/);
  assert.equal(f.db.prepare(`SELECT count(*) n FROM project_fact WHERE source_type='takeover_analysis'`).get()!.n,0);
  await serveOnce(f.db,f.config,()=>router);assert.equal(attempts,2);
});

test('cancelled takeover repair cannot dispatch a second Run or ingest candidates', async t => {
  const f=takeoverTaskFixture(t);let attempts=0;
  const router=fakeTaskRouter(f,f.id,()=>{attempts++;f.output(true);},[]);
  await serveOnce(f.db,f.config,()=>router);await cancel(f.db,f.config,f.id,router);
  await serveOnce(f.db,f.config,()=>router);assert.equal(attempts,1);
  assert.equal(f.db.prepare('SELECT status FROM project_recovery WHERE id=?').get('takeover-bound')!.status,'failed');
  assert.equal(f.db.prepare(`SELECT count(*) n FROM project_fact WHERE source_type='takeover_analysis'`).get()!.n,0);
});

test('takeover internal check is fixed and requires all expected outputs while ordinary retries remain unchanged', t => {
  const f=takeoverTaskFixture(t),raw=readFileSync(f.file,'utf8');
  writeFileSync(f.file,raw.replace('internal: takeover-output','internal: arbitrary-code'));assert.throws(()=>parseSpec(f.file,f.project),/internal: 无效/);
  writeFileSync(f.file,raw.replace('internal: takeover-output','internal: takeover-output\n    command: [unsafe]'));assert.throws(()=>parseSpec(f.file,f.project),/必须且只能/);
  writeFileSync(f.file,stringify({schema:'task/0.1',goal:'read',allowedWrites:['_Harness/Recovery/'],expectedOutputs:['_Harness/Recovery/facts.json'],
    checks:[{id:'full',internal:'takeover-output',on:'_Harness/Recovery/facts.json'}]}));assert.throws(()=>parseSpec(f.file,f.project),/需要全部三份/);
  const g=fixture(t),id=taskAdd(g.config,g.db,'sample',g.spec());
  assert.deepEqual(JSON.parse(String(g.db.prepare('SELECT retry_policy_json FROM task WHERE id=?').get(id)!.retry_policy_json)),{maxRetries:1});
  f.output(false);assert.equal(validateTakeoverOutputs(f.project).ok,true);
  writeFileSync(join(f.project,'_Harness/Recovery/analysis.json'),JSON.stringify({classification:'invented',ready:true}));
  const invalid=validateTakeoverOutputs(f.project);assert.equal(invalid.ok,false);if(!invalid.ok)assert.match(invalid.problems.join(),/classification/);
});

function importedIdentity(f: ReturnType<typeof fixture>, stored = 'sample', workspace = f.config.workspaceRoot) {
  f.db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('import-workspace', workspace);
  f.db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES('import-project','import-workspace','private',?,'{"observed":true}','imported','old-h','old-k')`).run(stored);
  f.db.prepare("INSERT INTO project_brief(project_id,intake_mode,customer_request) VALUES('import-project','import','keep my original request')").run();
  f.db.prepare("INSERT INTO import_report(id,project_id,report_json,snapshot_hash) VALUES('original-report','import-project',?,'original-sha')").run(JSON.stringify({source:'retained'}));
  return {...f.db.prepare("SELECT * FROM project WHERE id='import-project'").get()!};
}

test('relative imported physical identity is reused by task add and actual tool execution uses its absolute directory', async t => {
  const f=fixture(t),before=importedIdentity(f),id=taskAdd(f.config,f.db,f.project,f.spec());
  const row=f.db.prepare(`SELECT t.*,w.project_id,w.plan_json,w.process_hash,p.path AS project_path FROM task t
    JOIN workflow w ON w.id=t.workflow_id JOIN project p ON p.id=w.project_id WHERE t.id=?`).get(id)!;
  assert.equal(row.project_id,'import-project');assert.equal(row.project_path,'sample');
  assert.deepEqual({...f.db.prepare("SELECT * FROM project WHERE id='import-project'").get()!},before);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM project').get()!.n,1);
  assert.equal(f.db.prepare("SELECT customer_request FROM project_brief WHERE project_id='import-project'").get()!.customer_request,'keep my original request');
  const tool=join(f.root,'absolute-project.mjs');writeFileSync(tool,`import {writeFileSync} from 'node:fs';writeFileSync(process.env.AVH_PROJECT_DIR+'/result.txt','ok '+process.env.AVH_PROJECT_DIR);`);
  const spec=JSON.parse(String(row.plan_json)).task;
  const router=new TaskRouter(f.db,f.config,row as unknown as ConstructorParameters<typeof TaskRouter>[2],undefined,
    {...spec,tool:{argv:[process.execPath,tool],env:{}}});
  assert.equal(router.row.project_path,realpathSync(f.project));
  await waitFor(async()=>{
    await serveOnce(f.db,f.config,()=>router);
    return String(f.db.prepare('SELECT status FROM task WHERE id=?').get(id)!.status);
  },{what:'the absolute-path tool task to be marked PASSED',ready:status=>status==='PASSED',timeoutMs:30_000,intervalMs:100,
    detail:()=>JSON.stringify({runs:f.db.prepare('SELECT result_json FROM run WHERE task_id=?').all(id),verdicts:f.db.prepare('SELECT * FROM verdict').all()})});
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(id)!.status,'PASSED',JSON.stringify({runs:f.db.prepare('SELECT result_json FROM run WHERE task_id=?').all(id),verdicts:f.db.prepare('SELECT * FROM verdict').all(),exists:existsSync(join(f.project,'result.txt'))}));
  assert.equal(readFileSync(join(f.project,'result.txt'),'utf8'),'ok '+realpathSync(f.project));
  assert.match(taskShow(f.db,id,f.home),/sample/);
  assert.equal(f.db.prepare("SELECT project_id FROM import_report WHERE id='original-report'").get()!.project_id,'import-project');
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('relative imported project reaches the real ManagedProvider command and persisted Run with absolute paths', async t => {
  const f=fixture(t);importedIdentity(f);
  f.config.providers[0]!.writable=[];
  f.config.providers[0]!.executable=fakeCommand(join(f.root,'identity-provider'),`
    const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
    if(args[0]==='--version'){console.log('fake 1.0');process.exit(0);}
    if(args[0]==='login'){process.exit(0);}
    if(args[0]!=='exec')process.exit(2);
    const prompt=fs.readFileSync(0,'utf8'),project=/^Project: (.+)$/m.exec(prompt)?.[1];
    if(!project||!path.isAbsolute(project))throw new Error('Runtime project path must be absolute');
    const directory=path.join(project,'results'),output=path.join(directory,'result.txt'),writable=args.flatMap((arg,i)=>arg==='--add-dir'?[args[i+1]]:[]);
    if(!writable.includes(directory))throw new Error('Provider command must authorize the resolved output');
    fs.writeFileSync(output,'ok '+project);
    fs.writeFileSync(args[args.indexOf('-o')+1],'completed');
    console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-local-identity'}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));
  `);
  const spec=f.spec();writeFileSync(spec,readFileSync(spec,'utf8').replaceAll('result.txt','results/result.txt').replace('allowedWrites:\n  - results/result.txt','allowedWrites:\n  - results/'));
  const id=taskAdd(f.config,f.db,f.project,spec);
  await waitFor(async()=>{
    await serveOnce(f.db,f.config);
    return String(f.db.prepare('SELECT status FROM task WHERE id=?').get(id)!.status);
  },{what:'the relative imported project task to be marked PASSED',ready:status=>status==='PASSED',timeoutMs:30_000,intervalMs:100,
    detail:()=>taskShow(f.db,id,f.home)});
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(id)!.status,'PASSED',taskShow(f.db,id,f.home));
  assert.equal(readFileSync(join(f.project,'results/result.txt'),'utf8'),'ok '+realpathSync(f.project));
  const run=f.db.prepare('SELECT id,provider,result_json FROM run WHERE task_id=?').get(id)!;
  assert.equal(run.provider,'fake');assert.equal(JSON.parse(String(run.result_json)).exitStatus,0);
  assert.match(readFileSync(join(f.home,'runs',String(run.id),'task.txt'),'utf8'),pathPattern(realpathSync(f.project)));
  assert.equal(f.db.prepare('SELECT project_id FROM workflow WHERE id=(SELECT workflow_id FROM task WHERE id=?)').get(id)!.project_id,'import-project');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM project').get()!.n,1);
});

test('relative imported task lists and Gate decisions read the actual project output', async t => {
  const f=fixture(t);importedIdentity(f);
  const id=taskAdd(f.config,f.db,f.project,f.spec(true));f.executor.output='ok';
  await f.tick();
  const pending=gateList(f.db).split('\n')[1]!.split('\t');
  assert.equal(pending[3],'pending');assert.notEqual(pending[5],'missing');
  gateDecide(f.db,pending[0]!,true,'review actual imported output');await f.tick();
  assert.equal(gateList(f.db).split('\n')[1]!.split('\t')[3],'approved');
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(id)!.status,'PASSED');
  assert.match(taskList(f.db,f.project),new RegExp(id));
  assert.doesNotMatch(taskList(f.db,f.project),/产物已变化/);
  writeFileSync(join(f.project,'result.txt'),'changed output');
  assert.match(taskList(f.db,f.project),/产物已变化/);
  assert.equal(gateList(f.db).split('\n')[1]!.split('\t')[3],'stale');
});

test('physical identity preserves absolute and Windows case spellings and ignores missing historical locations', t => {
  const f=fixture(t),stored=windows?f.project.toUpperCase():f.project;
  importedIdentity(f,stored,windows?f.config.workspaceRoot.toUpperCase():f.config.workspaceRoot);
  f.db.prepare("INSERT INTO workspace(id,path) VALUES('removed-workspace',?)").run(join(f.root,'gone'));
  f.db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES('removed-project','import-workspace','private','gone','{}','imported','h','k')`).run();
  const id=taskAdd(f.config,f.db,'sample',f.spec());
  assert.equal(f.db.prepare('SELECT project_id FROM workflow WHERE id=(SELECT workflow_id FROM task WHERE id=?)').get(id)!.project_id,'import-project');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM workspace').get()!.n,2);
  assert.equal(f.db.prepare("SELECT path FROM project WHERE id='import-project'").get()!.path,stored);
});

test('physical identity refuses ambiguous registered projects and workspaces without new state or merging history', t => {
  const f=fixture(t);importedIdentity(f);
  f.db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES('duplicate-project','import-workspace','sample',?,'{}','active','h','k')`).run(f.project);
  const snapshot=()=>JSON.stringify(['workspace','project','workflow','task','event'].map(table=>f.db.prepare(`SELECT * FROM ${table}`).all()));
  let before=snapshot();assert.throws(()=>taskAdd(f.config,f.db,'sample',f.spec()),/同一工程有多个/);assert.equal(snapshot(),before);
  f.db.prepare("DELETE FROM project WHERE id='duplicate-project'").run();
  f.db.prepare("INSERT INTO workspace(id,path) VALUES('duplicate-workspace',?)").run(f.config.workspaceRoot+'/.');
  before=snapshot();assert.throws(()=>taskAdd(f.config,f.db,'sample',f.spec()),/同一工作区有多个/);assert.equal(snapshot(),before);
});
