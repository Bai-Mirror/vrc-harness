import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { productionContext, reconcileProduction } from '../../src/production-proposals.ts';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parse, stringify } from 'yaml';
import { ApiClient } from '../../src/api/client.ts';
import { API_VERSION, apiEndpoint, type EventMessage } from '../../src/api/protocol.ts';
import { RuntimeService } from '../../src/api/server.ts';
import { defaultUnityLockPath, currentExplorationLimit,loadConfig, refreshAssetSearchRoots } from '../../src/config.ts';
import { explorationContext, explorationImages, performExploration } from '../../src/asset-exploration.ts';
import { approveProduction } from '../../src/production-proposals.ts';
import { recordPackEvaluation, registerPackCandidate } from '../../src/managed-pack-candidate.ts';
import { ServiceManager, unitFile, unitName } from '../../src/service/manager.ts';
import { openDatabase, SCHEMA_VERSION } from '../../src/state/db.ts';
import { upsertBoothFile, upsertBoothItem } from '../../src/booth/catalog.ts';
import { FAKE_PROVIDER, fakeCommand, inheritedModify, removeTemp, windows } from '../fixtures/platform.ts';
import { probeEndpoint } from '../../src/api/protocol.ts';
import { windowsHelper } from '../../src/exec/windows-helper.ts';
import { waitFor, waitUntil } from '../fixtures/wait.ts';

const PROCESS = {
  schema: 'process/0.1', id: 'api-flow', version: 'v1', applies_to: {}, artifacts: ['plan'],
  stages: [{ id: 'plan', needs: [], produces: ['plan'], requires: ['titled'], gates: ['approval'], invalidated_by: [] }],
  checks: [{ id: 'titled', observe: 'plan.inspect', on: 'plan', scope: 'edit', rule: 'title_length > 0', severity: 'blocking', maturity: 'accepted' }],
  gates: [{ id: 'approval', kind: 'approve', binds: 'plan' }, { id: 'client_test', kind: 'do', binds: 'plan' }],
  milestones: [{ id: 'UPLOAD_READY', requires_stages: 'all' }, { id: 'CLIENT_VERIFIED', after: 'UPLOAD_READY', gates: ['client_test'] }],
};

test('Windows Runtime endpoints reuse the same home across path spelling without merging different homes',()=>{
  const canonical='C:\\Users\\Example\\Harness';
  for(const home of ['C:/Users/Example/Harness','c:\\users\\example\\harness\\','C:\\Users\\Example\\other\\..\\Harness'])
    assert.equal(apiEndpoint(home,'win32'),apiEndpoint(canonical,'win32'));
  assert.notEqual(apiEndpoint(canonical,'win32'),apiEndpoint(canonical+'Other','win32'));
});
const CAPABILITIES = { schema: 'capabilities/0.1', process: 'api-flow', version: '1',
  artifacts: { plan: { paths: ['_harness/plan.yaml'], format: 'yaml' } },
  stages: { plan: { mode: 'provider', goal: '写方案', allowedWrites: ['_harness/'],
    contextBudgetChars: 2000, contextCoverage: ['plan.core'], context: [
      { id: 'plan-core', path: 'context.md', heading: '核心', required: true, covers: ['plan.core'] },
      { id: 'no-roots', path: 'context.md', heading: '尚无根', priority: 20,
        when: [{ path: 'memory.avatarRoots.count', equals: 0 }] },
      { id: 'prior-plan-failure', path: 'context.md', heading: '历史失败', priority: 30,
        when: [{ path: 'memory.cases.failureStageIds', includes: 'plan' }] },
    ] } },
  observers: { 'plan.inspect': { command: ['node', '{toolRoot}/inspect.mjs', '{project}', '{out}'] } } };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-api-'));
  const home = join(root, 'home'), workspace = join(root, 'workspace'), project = join(workspace, 'sample');
  const tools = join(root, 'tools'), knowledge = join(root, 'knowledge'), exportRoot = join(root, 'export');
  for (const dir of [join(home, 'config'), project, join(tools, '审查/perception'), knowledge, exportRoot]) mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  for (const file of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) writeFileSync(join(tools, file), '');
  writeFileSync(join(tools, 'inspect.mjs'), '');
  writeFileSync(join(knowledge, 'api.process.yaml'), stringify(PROCESS));
  writeFileSync(join(knowledge, 'api.capabilities.yaml'), stringify(CAPABILITIES));
  writeFileSync(join(knowledge, 'context.md'), '# API 上下文\n## 核心\n保持需求。\n## 尚无根\n先确认 Avatar 根。\n## 历史失败\n读取结构化失败证据后再修复。\n');
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: '1', t: {} }));
  const fake = fakeCommand(join(root, 'fake-codex'), FAKE_PROVIDER);
  writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: workspace, toolRoot: tools, knowledgeRoot: knowledge,
    exportRoots: [exportRoot], knownBodies: [], projectAliases: {}, sampleNames: ['sample'],
    processDefinitions: { 'api-flow': { definition: 'api.process.yaml', capabilities: 'api.capabilities.yaml' } },
    defaultProfile: 'api-flow', thresholdsFile: 'thresholds.yaml',
    providers: [{ id: 'fake', type: 'codex-cli', executable: fake, roles: ['executor'], writable: [], maxConcurrentRuns: 1 }] }));
  const services: RuntimeService[] = []; const clients: ApiClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const service of services) await service.stop().catch(() => {});
    removeTemp(root);
  });
  const start = async (options: Partial<ConstructorParameters<typeof RuntimeService>[0]> = {}) => {
    const service = new RuntimeService({ home, scheduler: false, pollMs: 50, ...options });
    services.push(service); await service.start(); return service;
  };
  const connect = async () => { const client = await ApiClient.connect(home); clients.push(client); return client; };
  return { root, home, project, start, connect };
}
for (const scope of ['home', 'workspace'] as const) test(`Windows formal startup refuses inherited Modify in ${scope} before scheduling`,
  { skip: !windows }, async t => {
    windowsHelper();
    const f = fixture(t), target = scope === 'home' ? f.home : join(f.root, 'workspace');
    const restore = inheritedModify(t, target);
    try {
    const writable = join(target, 'writable.txt'); writeFileSync(writable, 'yes');
    const message = /无法设置完整性标签[\s\S]*修改[\s\S]*完全控制[\s\S]*LOCALAPPDATA/;
    await assert.rejects(f.start({ scheduler: true }), message);
    assert.equal(await probeEndpoint(apiEndpoint(f.home)), false, 'no API or scheduler was started');
    assert.equal(existsSync(join(f.home, 'state', 'harness.db')), false, 'startup fails before opening runtime state');
    await assert.rejects(new ServiceManager(f.home).start(1000, 100), message, 'GUI/CLI gets the actionable error directly');
    assert.equal(existsSync(join(f.home, 'logs', 'service.log')), false, 'no detached launcher was started');
    } finally { restore(); }
    await f.start();
    const client = await f.connect();
    assert.equal((await client.call<{ scheduler: { state: string } }>('service.status')).scheduler.state, 'stopped',
      'the same installation starts normally after the user fixes the fixture permissions');
  });

test('technical review API binds current files, rejects stale review and accepts only the selected change',async t=>{
  const f=fixture(t);await f.start();const client=await f.connect();
  const workflow=await client.call<{id:string}>('workflow.create',{project:'sample',profile:'api-flow'});
  const db=openDatabase(join(f.home,'state/harness.db'));t.after(()=>db.close());
  const id='technical-review-task';db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES(?,?,'plan','review','test','WAITING_HUMAN')").run(id,workflow.id);
  const first='workspace:Assets/_Harness/first.meta',second='workspace:Assets/Vendor/second.meta';
  mkdirSync(join(f.project,'Assets/_Harness'),{recursive:true});mkdirSync(join(f.project,'Assets/Vendor'),{recursive:true});
  writeFileSync(join(f.project,first.slice(10)),'first version');writeFileSync(join(f.project,second.slice(10)),'second version');
  for(const artifact of [first,second])db.prepare('INSERT INTO out_of_bounds_change(workflow_id,stage_id,artifact) VALUES(?,\'plan\',?)').run(workflow.id,artifact);
  const detail=await client.call<{reviewToken:string;outOfBounds:any[]}>('task.show',{id});assert.equal(detail.outOfBounds.length,2);assert.match(detail.reviewToken,/^[a-f0-9]{64}$/);
  writeFileSync(join(f.project,first.slice(10)),'changed after viewing');
  await assert.rejects(()=>client.call('task.acceptChanges',{id,paths:[first],note:'核对技术改动。',expectedReviewToken:detail.reviewToken}),/技术审阅记录或文件已变化/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM out_of_bounds_change WHERE accepted=1').get()!.n,0);
  const current=await client.call<{reviewToken:string}>('task.show',{id});
  const result=await client.call<{accepted:number;remaining:number;acceptedPaths:string[]}>('task.acceptChanges',{id,paths:[first],note:'仅确认所选文件。',expectedReviewToken:current.reviewToken});
  assert.equal(result.accepted,1);assert.equal(result.remaining,1);assert.deepEqual(result.acceptedPaths,[first]);
  assert.equal(db.prepare('SELECT accepted FROM out_of_bounds_change WHERE artifact=?').get(second)!.accepted,0);
});

test('the upload hand-over is refused until this project\'s Workflow reaches UPLOAD_READY, and allowed after',async t=>{
  const f=fixture(t);await f.start();const client=await f.connect();
  // This asserts a state gate, not latency: a starved host can take minutes to start the fixture service and answer.
  const workflow=await client.call<{id:string}>('workflow.create',{project:'sample',profile:'api-flow'},180000);
  const db=openDatabase(join(f.home,'state/harness.db'));t.after(()=>db.close());
  const projectId=String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflow.id)!.project_id);
  assert.equal(db.prepare('SELECT status FROM workflow WHERE id=?').get(workflow.id)!.status,'active');
  const open=()=>client.call('project.upload.open',{projectId},180000);
  // The real call path: the API is reachable outside the GUI, so a hidden button is not the guard.
  await assert.rejects(open,/交付还没通过验证/,
    'before UPLOAD_READY the hand-over must not open');
  // Cancelled is not "after UPLOAD_READY" either, and an unknown project is still a not-found.
  db.prepare("UPDATE workflow SET status='cancelled' WHERE id=?").run(workflow.id);
  await assert.rejects(open,/交付还没通过验证/);
  await assert.rejects(()=>client.call('project.upload.open',{projectId:'missing-project'},180000),/项目不存在/);
  // Reached: the status gate lets it through, and what it asks for next is the configured Unity editor.
  db.prepare("UPDATE workflow SET status='upload_ready' WHERE id=?").run(workflow.id);
  await assert.rejects(open,/尚未配置 Unity 编辑器路径/);
  // Client verification is after it as well.
  db.prepare("UPDATE workflow SET status='client_verified' WHERE id=?").run(workflow.id);
  await assert.rejects(open,/尚未配置 Unity 编辑器路径/);
});

test('local maintenance API preserves explicit scope, compare-and-swap and replay receipts',async t=>{
  const f=fixture(t);await f.start();const client=await f.connect();
  const project=await client.call<{id:string}>('project.create',{name:'local-maintenance',mode:'selection',request:'保持原要求'});
  const view=await client.call<{token:string;current:unknown}>('project.maintenance.show',{projectId:project.id});
  assert.equal(view.current,null);
  const input={projectId:project.id,candidateId:null,scope:'project',expectedToken:view.token,commandId:'return-official'};
  const receipt=await client.call<{id:string}>('project.maintenance.adopt',input);
  assert.equal((await client.call<{id:string}>('project.maintenance.adopt',input)).id,receipt.id);
  await assert.rejects(()=>client.call('project.maintenance.adopt',{...input,commandId:'stale'}),/状态已变化/);
  await assert.rejects(()=>client.call('project.maintenance.adopt',{...input,scope:'global'}),/明确选择/);
  assert.equal((await client.call<{current:{candidateId:string|null}}>('project.maintenance.show',{projectId:project.id})).current.candidateId,null);
});

test('handshake reports the API and schema versions; reads return structured views', async t => {
  const f = fixture(t);
  await f.start();
  const client = await f.connect();
  assert.equal(client.hello.api, API_VERSION);
  assert.equal(client.hello.schema, SCHEMA_VERSION);
  assert.deepEqual(await client.call('project.list'), []);
  assert.deepEqual(await client.call('workflow.list'), []);
  assert.deepEqual(await client.call('gate.list'), []);
  assert.deepEqual(await client.call('managed.candidate.list'), []);
  const status = await client.call<{ scheduler: { state: string }; lease: { cycle: number } }>('service.status');
  assert.equal(status.scheduler.state, 'stopped');
  await assert.rejects(client.call('no.such.method'), (error: Error & { code?: string }) => error.code === 'UNKNOWN_METHOD');
  await assert.rejects(client.call('workflow.show', {}), (error: Error & { code?: string }) => error.code === 'BAD_REQUEST');
  await assert.rejects(client.call('task.show', { id: 'missing' }), (error: Error & { code?: string }) => error.code === 'NOT_FOUND');
});

test('production API rejects stale approval, replays an accepted command and reports cancellation', async t => {
  const f = fixture(t); await f.start(); const client = await f.connect();
  await client.call('project.create', { name: 'proposal-sample' });
  const project = (await client.call<Array<{ id: string }>>('project.list'))[0]!;
  const file = join(f.root, 'body.unitypackage'); writeFileSync(file, 'approved source');
  const asset = await client.call<{ id: string }>('asset.save', { path: file, name: 'Test body', kind: 'avatar', status: 'ready', license: 'personal', tags: [] });
  await client.call('project.asset.attach', { projectId: project.id, assetId: asset.id, role: 'source' });
  const db = openDatabase(join(f.home, 'state/harness.db')); t.after(() => db.close());
  const proposal = async (commandId: string) => {
    const message = await client.call<{ id: string; revision: number }>('project.message.add', { projectId: project.id, content: 'Use this body', commandId });
    // The scheduler's proposal consumer is exercised separately; seed its persisted result to test the socket API.
    db.prepare(`INSERT INTO production_proposal(id,project_id,revision,profile,request,inputs_json,context_json,status)
      VALUES(?,?,?,?,?,?,?,'proposed')`).run(message.id, project.id, message.revision, 'api-flow', 'Use this body',
      JSON.stringify([{ id: asset.id, path: file, name: 'Test body', kind: 'avatar', role: 'source',
        sha256: createHash('sha256').update('approved source').digest('hex') }]), productionContext(db, project.id));
    return message;
  };
  const old = await proposal('first'), current = await proposal('second');
  await assert.rejects(client.call('project.production.approve', { id: old.id, revision: old.revision, commandId: 'stale' }), /旧提案不能批准/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM workflow').get()!.n, 0);
  const decision = { id: current.id, revision: current.revision, commandId: 'accepted' };
  const accepted = await client.call<{ workflowId: string }>('project.production.approve', decision);
  assert.deepEqual(await client.call('project.production.approve', decision), accepted);
  await assert.rejects(client.call('project.production.reject', { id: current.id, revision: current.revision }), /已经开始制作/);
  const listed = await client.call<Array<{ id: string; status: string; inputs: unknown[] }>>('project.production.list', { projectId: project.id });
  assert.equal(listed.find(p => p.id === current.id)!.status, 'working');
  assert.deepEqual(listed[0]!.inputs, [{ id: asset.id, name: 'Test body', kind: 'avatar' }]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM workflow').get()!.n, 1);
  await client.call('workflow.cancel', { id: accepted.workflowId, note: 'Test cancellation' });
  reconcileProduction(db);
  const after = await client.call<Array<{ id: string; status: string }>>('project.production.list', { projectId: project.id });
  assert.equal(after.find(p => p.id === current.id)!.status, 'cancelled');
  assert.equal(readFileSync(file, 'utf8'), 'approved source');
});

test('commands run through the CLI; subscribers are told when state changes', async t => {
  const f = fixture(t);
  await f.start();
  const client = await f.connect();
  const events: EventMessage[] = [];
  const before = await client.subscribe(event => events.push(event));
  const created = await client.call<{ id: string }>('workflow.create', { project: 'sample', profile: 'api-flow' });
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  const list = await client.call<Array<{ id: string; status: string; stagesTotal: number }>>('workflow.list');
  assert.deepEqual(list.map(row => [row.id, row.status, row.stagesTotal]), [[created.id, 'active', 1]]);
  const view = await client.call<{ next: string; knowledgeVersion:string; stages: Array<{ id: string }> }>('workflow.show', { id: created.id });
  assert.equal(view.stages[0]!.id, 'plan');
  const preview=await client.call<Array<{stageId:string;coverage:string[];decisions:Array<{id:string;selected:boolean}>;text:string}>>(
    'workflow.context.preview',{id:created.id,stageId:'plan',modelFamily:'codex'});
  assert.equal(preview[0]!.stageId,'plan');
  assert.deepEqual(preview[0]!.coverage,['plan.core']);
  assert.deepEqual(preview[0]!.decisions.map(item=>[item.id,item.selected]),
    [['prior-plan-failure',false],['plan-core',true],['no-roots',true]]);
  assert.match(preview[0]!.text,/先确认 Avatar 根/);
  assert.deepEqual(await client.call('workflow.context.diff',{id:created.id,modelFamily:'codex'}),
    {base:null,target:{id:created.id,knowledgeVersion:view.knowledgeVersion},modelFamily:'codex',stages:[]});
  assert.deepEqual(await client.call('context.telemetry',{workflowId:created.id}),{samples:[],groups:[],diagnostics:[]});
  await waitUntil(() => events.some(event => event.event === 'changed' && (event.seq ?? 0) > before),
    { what: 'a change notification to reach the subscriber', timeoutMs: 30_000, intervalMs: 25 });
  assert.ok(events.some(event => event.event === 'changed' && (event.seq ?? 0) > before), 'a change notification arrived');
  const failed = client.call('workflow.create', { project: 'sample', profile: 'api-flow' });
  await assert.rejects(failed, /进行中的正式 Workflow/);
  await assert.rejects(client.call('gate.decide', { gate: `${created.id}:x`, approve: true }), (error: Error & { code?: string }) =>
    error.code === 'BAD_REQUEST' && /expectedHash/.test(error.message));
  const cancelled = await client.call<{ message: string }>('workflow.cancel', { id: created.id, note: '测试' });
  assert.match(cancelled.message, /已取消/);
  const after = await client.call<Array<{ action: string }>>('events.after', { seq: before });
  assert.ok(after.some(event => event.action === 'cancelled'));
  // An ended Workflow leaves nothing for the person: its last Tasks drop out of the inbox whatever their state.
  const tasks = await client.call<Array<{ workflowId: string; needsYou: boolean }>>('task.list');
  assert.ok(tasks.filter(task => task.workflowId === created.id).every(task => !task.needsYou));
});

test('project task reads keep a failed needsYou task available to the GUI redo entry', async t => {
  const f = fixture(t); await f.start(); const client = await f.connect();
  const workflow = await client.call<{ id: string }>('workflow.create', { project: 'sample', profile: 'api-flow' });
  const db = openDatabase(join(f.home, 'state/harness.db')); t.after(() => db.close());
  const taskId = 'failed-project-task';
  db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES(?,?, 'plan',?,'test','FAILED')")
    .run(taskId, workflow.id, '需要人工重做');
  const rows = await client.call<Array<{ id: string; status: string; needsYou: boolean }>>('task.list', { project: f.project });
  const failed = rows.find(row => row.id === taskId);
  assert.deepEqual(failed && { status: failed.status, needsYou: failed.needsYou }, { status: 'FAILED', needsYou: true });
  const openOnly = await client.call<Array<{ id: string }>>('task.list', { project: f.project, openOnly: true });
  assert.equal(openOnly.some(row => row.id === taskId), false, 'openOnly is unsuitable for the L0 redo source');
});

test('context diff isolates frozen knowledge changes using the target project facts', async t => {
  const f=fixture(t);await f.start();const client=await f.connect();
  const first=await client.call<{id:string}>('workflow.create',{project:'sample',profile:'api-flow'});
  await client.call('workflow.cancel',{id:first.id,note:'建立版本对比基线'});
  writeFileSync(join(f.root,'knowledge/context.md'),'# API 上下文\n## 核心\n保持需求，并记录审美缺口。\n## 尚无根\n先确认 Avatar 根。\n## 历史失败\n读取结构化失败证据后再修复。\n');
  const second=await client.call<{id:string}>('workflow.create',{project:'sample',profile:'api-flow'});
  const diff=await client.call<{base:{id:string};target:{id:string};summary:{changed:number};stages:Array<{stageId:string;
    items:Array<{id:string;status:string;before:{content:string}|null;after:{content:string}|null}>}>}>(
    'workflow.context.diff',{id:second.id,modelFamily:'codex'});
  assert.equal(diff.base.id,first.id);assert.equal(diff.target.id,second.id);assert.equal(diff.summary.changed,1);
  const core=diff.stages[0]!.items.find(item=>item.id==='plan-core')!;
  assert.equal(core.status,'content-changed');assert.match(core.before!.content,/保持需求/);assert.match(core.after!.content,/审美缺口/);
  // Unchanged items travel without their text, so a full pack stays under the message limit.
  const unchanged=diff.stages[0]!.items.filter(item=>item.status==='unchanged');
  assert.ok(unchanged.length>0);assert.ok(unchanged.every(item=>item.before?.content===''&&item.after?.content===''));
  await assert.rejects(client.call('workflow.context.diff',{id:second.id,baseId:'missing'}),/对比 Workflow 不存在/);
});

test('GUI can start a project-scoped AI candidate authoring Task without touching the active pack',async t=>{
  const f=fixture(t);await f.start();const client=await f.connect();
  await client.call('workflow.create',{project:'sample',profile:'api-flow'});
  const project=(await client.call<Array<{id:string;path:string}>>('project.list'))[0]!;
  const installed=await client.call<{id:string;root:string}>('managed.installBuiltin');
  const authoring=await client.call<{candidateId:string;sourceRoot:string;taskId:string;status:string}>(
    'managed.candidate.authoring.create',{projectId:project.id,basePackId:installed.id,reason:'蒸馏鞋底穿模失败案例'});
  assert.equal(authoring.status,'running');assert.match(authoring.candidateId,/^local-/);
  assert.ok(authoring.sourceRoot.startsWith(join(project.path,'_harness/candidate-packs/')));
  const detail=await client.call<{status:string;allowedWrites:string[];goal:string}>('task.show',{id:authoring.taskId});
  assert.equal(detail.status,'READY');assert.ok(detail.allowedWrites.every(path=>path.startsWith('_harness/candidate-packs/')));
  assert.match(detail.goal,/不得修改当前能力包/);
  assert.deepEqual(await client.call('managed.candidate.list'),[],'an unfinished authoring Task is not a candidate');
});

test('configuration updates are validated before they replace the working file', async t => {
  const f = fixture(t);
  await f.start();
  const client = await f.connect();
  const before = await client.call<{ defaultProfile: string; exportRoots: string[] }>('config.view');
  assert.equal(before.defaultProfile, 'api-flow');
  await client.call('config.update', { defaultProfile: 'api-flow', exportRoots: [join(f.root, 'export')], providerTypes: [] });
  assert.deepEqual((await client.call<{ providers: unknown[] }>('config.view')).providers, []);
  await assert.rejects(client.call('config.update', { workspaceRoot: join(f.root, 'missing') }), /配置没有保存/);
  const after = await client.call<{ workspaceRoot: string; defaultProfile: string }>('config.view');
  assert.equal(after.defaultProfile, 'api-flow');
  assert.equal(after.workspaceRoot, join(f.root, 'workspace'));
});

test('a subscription CLI is never left able to execute (decision D-34)', async t => {
  const f = fixture(t);
  await f.start();
  const client = await f.connect();
  // Selecting both subscription CLIs must not arm either one to run work.
  await client.call('config.update', { defaultProfile: 'api-flow', exportRoots: [join(f.root, 'export')],
    providerTypes: ['codex-cli', 'claude-cli'] });
  // Read the stored configuration: config.view reports only id and type, so the role and write boundary,
  // which is where the decision actually lives, have to be read from the file the Runtime will load.
  const stored = parse(readFileSync(join(f.home, 'config/harness.yaml'), 'utf8')) as
    { providers?: Array<{ id: string; type?: string; adapter?: string; roles?: string[]; writable?: unknown[] }> };
  const providers = stored.providers ?? [];
  const subscriptions = providers.filter(p => ['codex-cli', 'claude-cli'].includes(String(p.type ?? p.adapter)));
  // Either setup declines to keep them, or it keeps them only for a non-executing role. It may never leave
  // one able to run work, so assert the invariant rather than one of the two acceptable shapes.
  for (const provider of subscriptions) {
    assert.ok(!(provider.roles ?? []).includes('executor'), `${provider.id} must not keep the executor role`);
    assert.deepEqual(provider.writable ?? [], [], `${provider.id} must not be able to write into the project`);
  }
  // An API provider is unaffected: only the subscription route is withdrawn.
  for (const provider of providers.filter(p => !['codex-cli', 'claude-cli'].includes(String(p.type ?? p.adapter)))) {
    assert.ok(Array.isArray(provider.roles) && provider.roles.length, `${provider.id} keeps its roles`);
  }
});

test('DeepSeek and GLM through pi are turned on, changed and off from settings; other Providers stay as they were', async t => {
  const f = fixture(t); await f.start(); const client = await f.connect();
  type View = { providers: Array<{ id: string; type: string; upstream?: string; model?: string; baseUrl?: string; secret?: string }>;
    piDefaults: Record<string, { model: string; secret: string }> };
  await client.call('config.update', { pi: [{ upstream: 'deepseek' }, { upstream: 'zhipu', model: 'glm-4.7' }] });
  let view = await client.call<View>('config.view');
  assert.deepEqual(view.providers, [{ id: 'fake', type: 'codex-cli' },
    { id: 'deepseek', type: 'pi-cli', upstream: 'deepseek', secret: 'pi-deepseek', model: '', baseUrl: '' },
    { id: 'glm', type: 'pi-cli', upstream: 'zhipu', secret: 'pi-zhipu', model: 'glm-4.7', baseUrl: '' }],
    'a default reads back empty, so the form shows the default instead of pinning it');
  assert.deepEqual(view.piDefaults.zai, { model: 'glm-5.3-flash', secret: 'pi-zai' });
  const yaml = readFileSync(join(f.home, 'config/harness.yaml'), 'utf8');
  assert.doesNotMatch(yaml, /deepseek-flash/, 'defaults stay implicit in the file');
  await client.call('config.update', { pi: [{ upstream: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4' }] });
  view = await client.call<View>('config.view');
  assert.deepEqual(view.providers.slice(1), [{ id: 'glm', type: 'pi-cli', upstream: 'zai', secret: 'pi-zai', model: '', baseUrl: 'https://api.z.ai/api/paas/v4' }]);
  await assert.rejects(client.call('config.update', { pi: [{ upstream: 'zai', baseUrl: 'http://api.example' }] }), /只允许 HTTPS/);
  await assert.rejects(client.call('config.update', { pi: [{ upstream: 'zai' }, { upstream: 'zhipu' }] }), /各只能选一个/);
  await client.call('config.update', { pi: [] });
  assert.deepEqual((await client.call<View>('config.view')).providers, [{ id: 'fake', type: 'codex-cli' }]);
});

test('configuration edits keep the person\'s comments and leave the previous file as a backup', async t => {
  const f = fixture(t); const configPath = join(f.home, 'config/harness.yaml');
  writeFileSync(configPath, `# 我的备注：这份配置手工维护\n${readFileSync(configPath, 'utf8')}`);
  await f.start(); const client = await f.connect();
  const result = await client.call<{ configBackup: string }>('config.update', { exportRoots: [join(f.root, 'export')] });
  assert.match(readFileSync(configPath, 'utf8'), /^# 我的备注：这份配置手工维护$/m);
  assert.match(readFileSync(result.configBackup, 'utf8'), /^# 我的备注：这份配置手工维护$/m);
  assert.ok(result.configBackup.startsWith(join(f.home, 'config/backups/')));
});

test('activating the built-in pack swaps in the profiles it ships and says which ones it dropped', async t => {
  const f = fixture(t); await f.start(); const client = await f.connect();
  const installed = await client.call<{ id: string }>('managed.installBuiltin');
  const result = await client.call<{ removedProfiles: string[]; configBackup: string }>('managed.activate', { id: installed.id, reason: 'use the built-in pack' });
  assert.deepEqual(result.removedProfiles, ['api-flow']);
  const view = await client.call<{ defaultProfile: string; profiles: string[] }>('config.view');
  assert.equal(view.defaultProfile, 'pc-recolor-outfit'); assert.ok(view.profiles.includes('pc-recolor-outfit'));
  assert.match(readFileSync(result.configBackup, 'utf8'), /api-flow/);
});

test('the Unity editor is set from config management, and only an editor that exists is accepted', async t => {
  const f = fixture(t); await f.start(); const client = await f.connect();
  await assert.rejects(client.call('config.update', { unityEditor: join(f.root, 'no-such-unity') }), /Unity 编辑器不可用：找不到/);
  const editor = join(f.root, 'Unity'); writeFileSync(editor, '#!/bin/sh\n'); chmodSync(editor, 0o755);
  await client.call('config.update', { unityEditor: editor });
  const view = await client.call<{ unity: { editor?: string; lockPath: string } | null }>('config.view');
  assert.equal(view.unity?.editor, editor);
  assert.equal(view.unity?.lockPath, defaultUnityLockPath(realpathSync(f.home)), 'the lock path defaults where the loader names it');
  await client.call('config.update', { unityEditor: '' });
  assert.equal((await client.call<{ unity: { editor?: string } | null }>('config.view')).unity?.editor, editor, 'empty keeps the editor');
});

test('collaborative learning is opt-in from settings and leaving it removes the upstream', async t => {
  const f = fixture(t); await f.start(); const client = await f.connect();
  assert.equal((await client.call<{ contributions: boolean }>('config.view')).contributions, false);
  await client.call('config.update', { contributions: true, contributorName: ' 喵 ' });
  let view = await client.call<{ contributions: boolean; contributorName: string }>('config.view');
  assert.deepEqual([view.contributions, view.contributorName], [true, '喵']);
  assert.match(readFileSync(join(f.home, 'config/harness.yaml'), 'utf8'), /endpoint: https:\/\/harness\.nymiro\.moe\/v1\/contributions/);
  await client.call('config.update', { contributions: false, contributorName: '' });
  view = await client.call('config.view');
  assert.deepEqual([view.contributions, view.contributorName], [false, '']);
  await assert.rejects(client.call('config.update', { contributorName: 'x'.repeat(65) }), /最多 64 个字符/);
});

test('a changed built-in pack installed beside the old one can be activated', async t => {
  const f = fixture(t); await f.start(); const client = await f.connect();
  const first = await client.call<{ id: string }>('managed.installBuiltin');
  const bundle = join(f.root, 'bundle'); cpSync(fileURLToPath(new URL('../../builtin/', import.meta.url)), bundle, { recursive: true });
  writeFileSync(join(bundle, 'knowledge/context/changed.md'), '# changed\n');
  const prior = process.env.AVH_BUNDLED_ROOT; process.env.AVH_BUNDLED_ROOT = bundle;
  t.after(() => { if (prior === undefined) delete process.env.AVH_BUNDLED_ROOT; else process.env.AVH_BUNDLED_ROOT = prior; });
  const second = await client.call<{ id: string }>('managed.installBuiltin');
  assert.equal(second.id.startsWith(`${first.id}+`), true, second.id);
  await client.call('managed.activate', { id: second.id, reason: 'use the upgraded pack' });
  const packs = await client.call<Array<{ id: string; active: boolean }>>('managed.list');
  assert.deepEqual(packs.filter(pack => pack.active).map(pack => pack.id), [second.id]);
  await assert.rejects(client.call('managed.activate', { id: `${first.id}+../x`, reason: 'escape' }), /规则包 ID 无效/);
});

test('a directory placed under managed packs cannot bypass the signed server update boundary',async t=>{
  const f=fixture(t);const injected=join(f.home,'managed/packs/local-candidate');mkdirSync(injected,{recursive:true});
  writeFileSync(join(injected,'pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:'local-candidate',version:'9.9.9',channel:'stable',description:'not signed'}));
  await f.start();const client=await f.connect();
  await assert.rejects(client.call('managed.activate',{id:'local-candidate',reason:'try local promotion'}),/不是已验证的服务端签名版本/);
  const config=await client.call<{knowledgeRoot:string}>('config.view');assert.notEqual(config.knowledgeRoot,join(injected,'knowledge'));
});

test('commands carry every parameter to the CLI: a redo keeps its note', async t => {
  const f = fixture(t);
  const service = await f.start();
  const seen: string[][] = [];
  // The command runner is the service's only path to the CLI; record what reaches it.
  (service as unknown as { command: (args: string[]) => Promise<string> }).command = async args => { seen.push(args); return 'ok'; };
  const client = await f.connect();
  await client.call('task.redo', { id: 'task-1', note: '素体改用 kaguya none' });
  await client.call('task.redo', { id: 'task-2' });
  assert.deepEqual(seen, [['task', 'redo', 'task-1', '--note', '素体改用 kaguya none'], ['task', 'redo', 'task-2']]);
});

test('the GUI product catalog and project proposals persist through the Runtime API', async t => {
  const f = fixture(t);
  await f.start();
  const client = await f.connect();
  const workflow = await client.call<{ id: string }>('workflow.create', { project: 'sample', profile: 'api-flow' });
  const project = (await client.call<Array<{ id: string }>>('project.list'))[0]!;
  const saved = await client.call<{ id: string }>('asset.save', { path: '/assets/coat.unitypackage', name: '蓝色外套',
    kind: 'outfit', status: 'candidate', license: 'personal', tags: ['Kaguya', '外套'] });
  const assets = await client.call<Array<{ id: string; name: string; tags: string[] }>>('asset.list');
  assert.deepEqual(assets.map(asset => [asset.id, asset.name, asset.tags]), [[saved.id, '蓝色外套', ['Kaguya', '外套']]]);
  const message = await client.call<{ id: string; status: string }>('project.message.add', { projectId: project.id, content: '鞋底不能穿模' });
  assert.equal(message.status, 'queued');
  assert.deepEqual(await client.call('project.message.list', { projectId: project.id }), [{ id: message.id, role: 'user',
    content: '鞋底不能穿模', status: 'proposed', revision: 1, interactionStatus: 'queued', taskId: null, taskStatus: null, error: null, resultJson: null,
    createdAt: (await client.call<Array<{ createdAt: string }>>('project.message.list', { projectId: project.id }))[0]!.createdAt }]);
  const activity = await client.call<Array<{ entityType: string; action: string; subject?: string }>>('events.recent');
  assert.ok(activity.some(item => item.entityType === 'asset' && item.action === 'saved' && item.subject === '蓝色外套'),
    'an asset event names the asset');
  const listed = (await client.call<Array<{ workflow?: { id: string; stagesPassed: number; stagesTotal: number } }>>('project.list'))[0]!;
  assert.equal(listed.workflow?.id, workflow.id);
  assert.ok(listed.workflow!.stagesTotal > 0 && listed.workflow!.stagesPassed === 0, 'progress counts the stages of the Workflow');
  assert.ok(activity.some(item => item.entityType === 'interaction' && item.action === 'submitted'));
  await client.call('project.asset.attach', { projectId: project.id, assetId: saved.id, role: 'candidate' });
  const linked = await client.call<Array<{ id: string; attached: boolean; role: string }>>('project.asset.list', { projectId: project.id });
  assert.deepEqual(linked.map(item => [item.id,item.attached,item.role]), [[saved.id,true,'candidate']]);
  await client.call('project.asset.detach', { projectId: project.id, assetId: saved.id });
  await client.call('asset.remove', { id: saved.id });
  assert.deepEqual(await client.call('asset.list'), []);
  assert.ok(workflow.id);
});

test('BOOTH catalog and validated per-project file plans are exposed without leaking the session',async t=>{
  const f=fixture(t);await f.start();const client=await f.connect();
  const project=(await client.call<Array<{id:string}>>('project.list'))[0]??await (async()=>{
    await client.call('workflow.create',{project:'sample',profile:'api-flow'});return(await client.call<Array<{id:string}>>('project.list'))[0]!;})();
  const db=openDatabase(join(f.home,'state/harness.db'));t.after(()=>db.close());
  upsertBoothItem(db,{itemId:'123',name:'春日衣装',shopName:'Example',owned:true,status:'available',tags:['Kaguya']});
  upsertBoothFile(db,{downloadableId:'456',itemId:'123',filename:'spring.zip',byteSize:10,status:'available'});
  await client.call('booth.session.set',{session:'abcdefghijklmnop1234'});
  assert.deepEqual(await client.call('booth.status'),{connected:true,items:1,owned:1,files:1,materialized:0,job:null,last:null});
  const catalog=await client.call<Array<{itemId:string;owned:boolean;tags:string[];fileCount:number}>>('booth.catalog');
  assert.deepEqual(catalog.map(item=>[item.itemId,item.owned,item.tags,item.fileCount]),[['123',true,['Kaguya'],1]]);
  const plan=await client.call<{id:string}>('booth.plan.create',{projectId:project.id,rationale:'只需要衣装主包',
    files:[{downloadableId:'456',purpose:'衣装装配'}]});
  const plans=await client.call<Array<{id:string;status:string;fileCount:number;readyCount:number}>>('booth.plan.list',{projectId:project.id});
  assert.deepEqual(plans.map(item=>[item.id,item.status,item.fileCount,item.readyCount]),[[plan.id,'validated',1,0]]);
  assert.doesNotMatch(JSON.stringify(await client.call('booth.status')),/abcdefghijklmnop1234/);
  await client.call('booth.session.clear');
  assert.deepEqual(await client.call('booth.status'),{connected:false,items:1,owned:1,files:1,materialized:0,job:null,last:null});
});

test('BOOTH sync runs as one background job that a second call cannot start twice',async t=>{
  const f=fixture(t);let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  const fetcher=(async(input:URL|string,init?:RequestInit)=>{const url=String(input);
    if(url.includes('library?page=1')){await gate;return new Response('<article><a href="/items/1">一</a><a href="/downloadables/11">下载</a></article>');}
    if(url.includes('library'))return new Response('<main></main>');
    if(url.endsWith('/items/1.json'))return Response.json({name:'一'});
    if(url.endsWith('/downloadables/11'))return new Response(null,{status:302,headers:{location:'https://cdn.example/one.zip'}});
    if(init?.method==='HEAD')return new Response(null,{headers:{'content-length':'5'}});
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  await f.start({boothRequests:{fetcher,intervalMs:0}});const client=await f.connect();
  await client.call('booth.session.set',{session:'abcdefghijklmnop1234'});
  assert.equal((await client.call<{started:boolean}>('booth.sync')).started,true);
  await assert.rejects(client.call('booth.sync'),/同步正在进行/);
  await assert.rejects(client.call('booth.plan.materialize',{planId:'none'}),/同步正在进行/);
  assert.equal((await client.call<{job:{kind:string}|null}>('booth.status')).job?.kind,'sync');
  release();
  let status:{job:unknown;last:{ok:boolean;message:string}|null};
  do{await new Promise(resolve=>setTimeout(resolve,20));status=await client.call('booth.status');}while(status.job);
  assert.equal(status.last?.ok,true,status.last?.message);
  assert.match(status.last!.message,/1 个商品、1 个文件/);
  const db=openDatabase(join(f.home,'state/harness.db'));t.after(()=>db.close());
  assert.equal((db.prepare("SELECT count(*) AS n FROM event WHERE entity_type='booth' AND action='sync_finished'").get() as {n:number}).n,1);
});

test('a failed BOOTH materialization redacts credentials from the job and event',async t=>{
  const f=fixture(t);
  const shapes=[
    {name:'colon',text:'Cookie: a=colon-cookie; b=second-colon-cookie',secrets:['colon-cookie','second-colon-cookie']},
    {name:'equals',text:'cookie=a=equal-cookie; b=second-equal-cookie',secrets:['equal-cookie','second-equal-cookie']},
    {name:'comma',text:'Set-Cookie: a=first-cookie; Expires=Wed, 21 Oct 2015 07:28:00 GMT, auth=second-cookie; Path=/',secrets:['first-cookie','second-cookie']},
    {name:'json',text:'{"cookie":"a=json-cookie; b=\\"json-escaped-cookie\\""}',secrets:['json-cookie','json-escaped-cookie']},
    // A URL inside the quoted value: cutting the URL first ate the escaped quote's backslash and ended the field early.
    {name:'json-url',text:'{"cookie":"a=json-url-cookie; url=https://x.test/a;b=\\"json-url-escaped\\""}',secrets:['json-url-cookie','json-url-escaped']},
  ];
  const cases=shapes.flatMap((shape,index)=>[0,1].map(cause=>({
    id:String(456+index*2+cause),name:`${shape.name}-${cause?'cause':'plain'}`,cause:Boolean(cause),text:shape.text,secrets:shape.secrets,
  })));
  const byId=new Map(cases.map(item=>[item.id,item]));
  const fetcher=(async(input:URL|string)=>{
    const url=String(input),match=/downloadables\/(\d+)|cdn\.example\/(\d+)\//.exec(url),id=match?.[1]??match?.[2],item=id?byId.get(id):undefined;
    if(!id||!item)throw new Error(`unexpected ${url}`);
    if(url.includes('/downloadables/'))return new Response(null,{status:302,
      headers:{location:`https://cdn.example/${id}/${item.name}.zip?X-Amz-Signature=url-secret-${id}`}});
    const detail=`GET https://cdn.example/${id}/${item.name}.zip?X-Amz-Signature=url-secret-${id} ${item.text}`;
    if(item.cause)throw new TypeError('fetch failed',{cause:new Error(detail)});
    throw new Error(detail);
  }) as typeof fetch;
  await f.start({boothRequests:{fetcher,intervalMs:0}});const client=await f.connect();
  await client.call('booth.session.set',{session:'abcdefghijklmnop1234'});
  const project=await client.call<{id:string}>('project.create',{name:'materialize-redaction',mode:'selection',request:'衣装'});
  const db=openDatabase(join(f.home,'state/harness.db'));t.after(()=>db.close());
  upsertBoothItem(db,{itemId:'123',name:'春日衣装',owned:true,status:'available'});
  for(const item of cases)upsertBoothFile(db,{downloadableId:item.id,itemId:'123',filename:`${item.name}.zip`,status:'available'});
  for(const item of cases){
    const plan=await client.call<{id:string}>('booth.plan.create',{projectId:project.id,files:[{downloadableId:item.id,purpose:'衣装装配'}]});
    await client.call('booth.plan.materialize',{planId:plan.id});
    const outcome=await boothJob(client);
    assert.equal(outcome.ok,false,item.name);
    const event=db.prepare("SELECT reason FROM event WHERE entity_type='booth' AND entity_id=? AND action='materialize_stopped' ORDER BY seq DESC LIMIT 1").get(plan.id) as {reason:string};
    const row=db.prepare('SELECT error FROM asset_selection_plan WHERE id=?').get(plan.id) as {error:string};
    const persisted=[row.error,outcome.message,event.reason];
    for(const text of persisted){
      assert.match(text,/凭据已隐去/,item.name);
      for(const secret of [...item.secrets,`url-secret-${item.id}`,'abcdefghijklmnop1234'])assert.doesNotMatch(text,new RegExp(secret),item.name);
    }
    assert.equal(outcome.message,event.reason,item.name);
  }
});

/** A BOOTH whose one file answers GET only (a signed URL), and whose bytes the test can change. */
function boothFile(files:{body:string},gate?:Promise<void>){
  return(async(input:URL|string,init?:RequestInit)=>{const url=String(input),headers=(init?.headers??{}) as Record<string,string>;
    if(url.includes('library?page=1')){await gate;return new Response('<article><a href="/items/123">春日衣装</a><a href="/downloadables/456">下载</a></article>');}
    if(url.includes('library'))return new Response('<main></main>');
    if(url.endsWith('/items/123.json'))return Response.json({name:'春日衣装',category:{name:'3D衣装'}});
    if(url.endsWith('/downloadables/456'))return new Response(null,{status:302,headers:{location:'https://cdn.example/456/spring.zip?X-Amz-Signature=secret'}});
    if(init?.method==='HEAD')return new Response(null,{status:403});
    if(headers.range)return new Response(null,{status:206,headers:{'content-range':`bytes 0-0/${files.body.length}`}});
    if(url.startsWith('https://cdn.example/'))return new Response(files.body,{headers:{'content-length':String(files.body.length)}});
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
}
async function boothJob(client:ApiClient):Promise<{ok:boolean;message:string;result?:Record<string,unknown>}>{
  let status:{job:unknown;last:{ok:boolean;message:string;result?:Record<string,unknown>}|null};
  do{await new Promise(resolve=>setTimeout(resolve,20));status=await client.call('booth.status');}while(status.job);
  return status.last!;
}

test('BOOTH sync takes a mode, and pool versions are removed only on an explicit request once nothing needs them',async t=>{
  const f=fixture(t);let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  await f.start({boothRequests:{fetcher:boothFile({body:'abc'},gate),intervalMs:0}});const client=await f.connect();
  await client.call('booth.session.set',{session:'abcdefghijklmnop1234'});
  await assert.rejects(client.call('booth.sync',{mode:'full'}),(error:Error&{code?:string})=>error.code==='BAD_REQUEST');
  await client.call('booth.sync',{mode:'deep'});
  await assert.rejects(client.call('booth.pool.remove',{sha256:['0'.repeat(64)]}),(error:Error&{code?:string})=>error.code==='CONFLICT');
  release();
  const synced=await boothJob(client);
  assert.equal(synced.ok,true,synced.message);assert.match(synced.message,/^深度同步完成：1 个商品、1 个文件/);
  assert.deepEqual([synced.result?.mode,synced.result?.probes],['deep',{'head:http-403 range:ok':1}]);
  await client.call('workflow.create',{project:'sample',profile:'api-flow'});
  const project=(await client.call<Array<{id:string}>>('project.list'))[0]!;
  const plan=await client.call<{id:string}>('booth.plan.create',{projectId:project.id,files:[{downloadableId:'456',purpose:'衣装'}]});
  await client.call('booth.plan.materialize',{planId:plan.id});
  const fetched=await boothJob(client);
  assert.match(fetched.message,/已就绪 1 个文件（下载 1 个，复用素材池 0 个）/);
  assert.deepEqual((await client.call<Array<{readyCount:number}>>('booth.plan.list',{projectId:project.id})).map(item=>item.readyCount),[1]);
  type Pool={root:string;entries:Array<{sha256:string;path:string;removable:boolean;blockers:string[];plans:Array<{planId:string}>}>};
  const listed=await client.call<Pool>('booth.pool.list');
  assert.equal(listed.root,join(f.home,'materialized','pool'));
  const [entry]=listed.entries;
  assert.deepEqual([entry!.plans.map(item=>item.planId),entry!.removable],[[plan.id],false]);
  const kept=await client.call<{removed:unknown[];kept:Array<{blockers:string[]}>}>('booth.pool.remove',{sha256:[entry!.sha256]});
  assert.deepEqual(kept.removed,[]);assert.match(kept.kept[0]!.blockers.join(),/锁定了这个版本/);
  await assert.rejects(client.call('booth.plan.release',{planId:'no-such-plan'}),(error:Error&{code?:string})=>error.code==='NOT_FOUND');
  await client.call('booth.plan.release',{planId:plan.id});
  await client.call('booth.pool.pin',{sha256:entry!.sha256,pinned:true});
  assert.deepEqual((await client.call<{kept:Array<{blockers:string[]}>}>('booth.pool.remove',{sha256:entry!.sha256})).kept[0]!.blockers,['已固定保留']);
  await client.call('booth.pool.pin',{sha256:entry!.sha256,pinned:false});
  const dry=await client.call<{removed:Array<{sha256:string}>;dryRun:boolean}>('booth.pool.remove',{sha256:[entry!.sha256],dryRun:true});
  assert.deepEqual([dry.dryRun,dry.removed.length,existsSync(entry!.path)],[true,1,true]);
  const removed=await client.call<{removed:Array<{sha256:string}>;freedBytes:number}>('booth.pool.remove',{sha256:[entry!.sha256]});
  assert.deepEqual([removed.removed.map(item=>item.sha256),removed.freedBytes,existsSync(entry!.path)],[[entry!.sha256],3,false]);
  const db=openDatabase(join(f.home,'state/harness.db'));t.after(()=>db.close());
  assert.equal((db.prepare("SELECT count(*) AS n FROM event WHERE entity_type='booth_pool' AND action='removed'").get() as {n:number}).n,1);
  assert.equal((await client.call<Pool>('booth.pool.list')).entries[0]!.blockers[0],'已删除');
});

test('a Workflow started from BOOTH files alone reads the version its plan pinned, not a newer one',async t=>{
  const f=fixture(t);const remote={body:'abc'};
  await f.start({boothRequests:{fetcher:boothFile(remote),intervalMs:0}});const client=await f.connect();
  await client.call('booth.session.set',{session:'abcdefghijklmnop1234'});
  await client.call('booth.sync');await boothJob(client);
  const create=(name:string)=>client.call<{id:string;path:string}>('project.create',{name,mode:'selection',request:`${name} 的造型`});
  const fetchFor=async(projectId:string)=>{const plan=await client.call<{id:string}>('booth.plan.create',{projectId,files:[{downloadableId:'456',purpose:'衣装'}]});
    await client.call('booth.plan.materialize',{planId:plan.id});const outcome=await boothJob(client);assert.equal(outcome.ok,true,outcome.message);
    return (outcome.result as {files:Array<{path:string;sha256:string}>}).files[0]!;};
  const first=await create('booth-a'),second=await create('booth-b');
  const v1=await fetchFor(first.id);
  remote.body='abcd';
  const v2=await fetchFor(second.id);
  assert.notEqual(v2.path,v1.path);
  const workflow=await client.call<{id:string}>('workflow.create',{project:first.path,projectId:first.id,profile:'api-flow'});
  const db=openDatabase(join(f.home,'state/harness.db'));t.after(()=>db.close());
  const manifest=JSON.parse((db.prepare('SELECT manifest_json AS json FROM workflow_definition WHERE workflow_id=?').get(workflow.id) as {json:string}).json) as
    {assets:Array<{store:string;item:string;role:string;name:string}>};
  assert.deepEqual(manifest.assets,[{store:'library',item:v1.path,role:'outfit',name:'春日衣装'}]);
  assert.equal(readFileSync(manifest.assets[0]!.item,'utf8'),'abc');
});

test('new-avatar intake persists the goal, selected library assets, outfit variants and avatar-root lineage', async t => {
  const f = fixture(t);
  await f.start();
  const client = await f.connect();
  const asset = await client.call<{ id: string }>('asset.save', { path: '/assets/winter.zip', name: '冬季衣装',
    kind: 'outfit', status: 'ready', license: 'personal', tags: ['Kaguya'] });
  const created = await client.call<{ id: string; path: string }>('project.create', { name: 'new-avatar', mode: 'selection',
    request: '用现有素材制作两个造型', faceConcept: '同一个温柔脸部方向', assetIds: [asset.id] });
  assert.equal(created.path, join(f.root, 'workspace', 'new-avatar'));
  assert.ok((await client.call<Array<{ id: string }>>('project.list')).some(project => project.id === created.id));
  assert.deepEqual(await client.call('project.brief.get', { projectId: created.id }), {
    projectId: created.id, intakeMode: 'selection', customerRequest: '用现有素材制作两个造型',
    faceConcept: '同一个温柔脸部方向', status: 'direction_pending', updatedAt: (await client.call<{ updatedAt: string }>('project.brief.get', { projectId: created.id })).updatedAt,
  });
  const linked = await client.call<Array<{ id: string; attached: boolean }>>('project.asset.list', { projectId: created.id });
  assert.deepEqual(linked.map(item => [item.id, item.attached]), [[asset.id, true]]);
  const variant = await client.call<{ id: string }>('project.variant.save', { projectId: created.id, name: '衣装 A', description: '冬季私服', status: 'planned' });
  const base = await client.call<{ id: string }>('project.root.save', { projectId: created.id, objectPath: 'Kaguya-base', scenePath: 'Assets/Main.unity', role: 'baseline', activeState: 'inactive' });
  const ft = await client.call<{ id: string }>('project.root.save', { projectId: created.id, variantId: variant.id, derivedFrom: base.id,
    objectPath: 'Kaguya-A-FT', scenePath: 'Assets/Main.unity', role: 'plugin_derivative', pluginProfile: 'FaceTracking', activeState: 'active' });
  await client.call('project.variant.asset.attach', { variantId: variant.id, assetId: asset.id, role: 'used' });
  const roots = await client.call<Array<{ id: string; variantId?: string; derivedFrom?: string; observedAt?: string }>>('project.root.list', { projectId: created.id });
  assert.deepEqual(roots.find(root => root.id === ft.id), { id: ft.id, projectId: created.id, variantId: variant.id, derivedFrom: base.id,
    scenePath: 'Assets/Main.unity', objectPath: 'Kaguya-A-FT', role: 'plugin_derivative', pluginProfile: 'FaceTracking', activeState: 'active', blueprintId: '', observedAt: roots.find(root => root.id === ft.id)!.observedAt });
  const variantAssets = await client.call<Array<{ id: string; attached: boolean; role: string }>>('project.variant.asset.list', { variantId: variant.id });
  assert.deepEqual(variantAssets.map(item => [item.id,item.attached,item.role]), [[asset.id,true,'used']]);
  await assert.rejects(client.call('project.variant.remove', { projectId: created.id, id: variant.id }), /仍关联 1 个头像根/);
  const workflow = await client.call<{ id: string }>('workflow.create', { project: created.path, projectId: created.id, profile: 'api-flow' });
  const view = await client.call<{ request: string }>('workflow.show', { id: workflow.id });
  assert.equal(view.request, '用现有素材制作两个造型');
  const manifestDb = openDatabase(join(f.home, 'state/harness.db')); t.after(() => manifestDb.close());
  const frozenManifest = JSON.parse((manifestDb.prepare('SELECT manifest_json AS json FROM workflow_definition WHERE workflow_id=?')
    .get(workflow.id) as { json: string }).json) as { faceConcept: string; variants: Array<{ id: string; assets: Array<{ item: string; role: string }> }> };
  assert.equal(frozenManifest.faceConcept, '同一个温柔脸部方向');
  assert.deepEqual(frozenManifest.variants, [{ id: variant.id, name: '衣装 A', description: '冬季私服',
    assets: [{ item: '/assets/winter.zip', role: 'used' }] }]);
  const task={id:'case-task'};
  manifestDb.prepare(`INSERT INTO task(id,workflow_id,stage_id,goal,inputs_json,capability,expected_outputs_json,retry_policy_json,status)
    VALUES(?,?,'plan','fixture','{}','provider','[]','{}','FAILED')`).run(task.id,workflow.id);
  manifestDb.prepare("INSERT INTO run(id,task_id,attempt,status,result_json) VALUES(?,?,1,'exited','{}')").run('case-run',task.id);
  manifestDb.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)
    VALUES(?, 'runtime','run','case-run','context_compiled','fixture',?)`).run(workflow.id,
      JSON.stringify({schema:'context-telemetry/0.1',modelFamily:'codex',selected:[]}));
  manifestDb.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)
    VALUES(?,'runtime','task',?,'VERIFYING->FAILED','菜单检查缺少证据','{"proof":"execution_failed"}')`).run(workflow.id,task.id);
  manifestDb.prepare(`INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result,basis)
    VALUES('case-run:titled',?,'titled','edit','case-hash','violation','missing title')`).run(workflow.id);
  const context = await client.call<{ path: string; compact: string; state: { workflow: { id: string; stages: Array<{ id: string; status: string }> };
    roots: unknown[];cases:Array<{taskId:string;stage:string;outcome:string;attempts:number;modelFamilies:string[];reason:string;evidence:string[];at:string}>;
    evidence: { artifacts: unknown[]; verdicts: number; events: number } } }>(
    'project.context', { projectId: created.id });
  assert.equal(context.path, join(created.path, '_harness/state/project.yaml'));
  assert.match(context.compact, /同一个温柔脸部方向/);
  assert.match(context.compact, /Kaguya-A-FT/);
  assert.equal(context.state.workflow.id, workflow.id);
  assert.equal(context.state.workflow.stages.find(stage => stage.id === 'plan')?.status, 'blocked');
  assert.deepEqual(context.state.cases,[{taskId:task.id,stage:'plan',outcome:'failure',attempts:1,modelFamilies:['codex'],
    reason:'菜单检查缺少证据',evidence:['case-run:titled:violation'],at:context.state.cases[0]!.at}]);
  assert.match(context.compact,/历史案例：plan\[failure\/1次\]/);
  const recalled=await client.call<Array<{decisions:Array<{id:string;selected:boolean}>;text:string}>>(
    'workflow.context.preview',{id:workflow.id,stageId:'plan',modelFamily:'codex'});
  assert.equal(recalled[0]!.decisions.find(item=>item.id==='prior-plan-failure')?.selected,true);
  assert.match(recalled[0]!.text,/读取结构化失败证据后再修复/);
  assert.deepEqual(context.state.evidence, { artifacts: [], verdicts: 1, events: context.state.evidence.events });
  // The file in the project is the portable summary of the archive: no absolute path, no customer wording.
  const durable = readFileSync(context.path, 'utf8');
  assert.match(durable, /harness-project-state\/0.2/);
  assert.ok(!durable.includes(created.path) && !durable.includes(f.root), 'the project file carries no local path');
  assert.ok(!durable.includes('用现有素材制作两个造型'), 'the customer\'s own request stays in the sensitive partition');
});

test('rejecting a stage\'s Gate can send the stage back: the reason becomes its redo note', async t => {
  const f = fixture(t);
  const service = await f.start();
  const client = await f.connect();
  const created = await client.call<{ id: string }>('workflow.create', { project: 'sample', profile: 'api-flow' });
  const db = openDatabase(join(f.home, 'state/harness.db'));
  t.after(() => db.close());
  db.prepare(`INSERT INTO task (id, workflow_id, stage_id, goal, capability, expected_outputs_json, retry_policy_json, status)
    VALUES ('plan-task', ?, 'plan', 'Complete stage plan', 'plan', '["plan"]', '{}', 'WAITING_HUMAN')`).run(created.id);
  const seen: string[][] = [];
  (service as unknown as { command: (args: string[]) => Promise<string> }).command = async args => { seen.push(args); return 'ok'; };
  const gate = `${created.id}:approval`;
  await client.call('gate.decide', { gate, approve: false, redo: true, note: '换成粉色款', expectedHash: 'h1' });
  assert.deepEqual(seen, [['gate', 'reject', gate, '--note', '换成粉色款', '--expect-hash', 'h1'],
    ['task', 'redo', 'plan-task', '--note', '换成粉色款']]);
  // An approval may come without a note; a redo may not, and only a stage's Gate has a stage to send back.
  await client.call('gate.decide', { gate, approve: true, note: '', expectedHash: 'h2' });
  assert.deepEqual(seen.at(-1), ['gate', 'approve', gate, '--note', '经 TUI 批准当前版本', '--expect-hash', 'h2']);
  await assert.rejects(client.call('gate.decide', { gate, approve: false, redo: true, expectedHash: 'h3' }), /写明原因/);
  await assert.rejects(client.call('gate.decide', { gate: `${created.id}:client_test`, approve: false, redo: true, note: 'x',
    expectedHash: 'h4' }), /不属于某个阶段/);
  assert.equal(seen.length, 3, 'a refused request changes nothing');
});

test('one service per home; a stale socket file is replaced; the socket is private', { skip: windows && 'a named pipe has no file; see the Windows test below' }, async t => {
  const f = fixture(t);
  mkdirSync(join(f.home, 'run'), { recursive: true });
  writeFileSync(apiEndpoint(f.home), 'stale');
  await f.start();
  assert.equal(statSync(apiEndpoint(f.home)).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.home, 'run')).mode & 0o777, 0o700);
  await assert.rejects(f.start(), /已有 Runtime 服务在运行/);
});

test('Windows: one service per home, and its named pipe refuses a Low integrity process', { skip: !windows }, async t => {
  const f = fixture(t);
  await f.start();
  await assert.rejects(f.start(), /已有 Runtime 服务在运行/);
  // What a sandboxed Run is: a restricted token at Low integrity. The pipe is a Medium object it cannot open for writing.
  const connect = `const s = require('node:net').createConnection(${JSON.stringify(apiEndpoint(f.home))});
s.on('connect', () => { console.log('connected'); process.exit(0); }); s.on('error', error => { console.log(error.code); process.exit(0); });`;
  const low = spawnSync(windowsHelper(), ['sandbox', '--low', '--', process.execPath, '-e', connect], { encoding: 'utf8' });
  assert.match(low.stdout, /EPERM|EACCES/, low.stderr);
  const medium = spawnSync(process.execPath, ['-e', connect], { encoding: 'utf8' });
  assert.match(medium.stdout, /connected/);
});

test('malformed and oversized messages are refused without taking the service down', async t => {
  const f = fixture(t);
  await f.start();
  const socket = createConnection(apiEndpoint(f.home));
  let received = '';
  socket.setEncoding('utf8').on('data', (data: string) => { received += data; });
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('not json\n');
  await waitUntil(() => received.includes('BAD_REQUEST'),
    { what: 'the malformed frame to be answered with BAD_REQUEST', timeoutMs: 30_000, intervalMs: 25 });
  assert.match(received, /BAD_REQUEST/);
  socket.on('error', () => {}); // the service closes the connection while we are still writing
  socket.write('x'.repeat(9 * 1024 * 1024));
  await new Promise(resolve => socket.once('close', resolve));
  const client = await f.connect();
  assert.equal((await client.call<{ api: number }>('hello')).api, API_VERSION);
});

test('scheduler child: pause waits for the round, resume restarts it, an unexpected exit restarts with backoff; reads stay fast during slow commands', async t => {
  const f = fixture(t);
  // Stands in for the CLI: `serve` idles until SIGTERM (after a short "round"), `doctor` is slow, `crash` exits.
  const fakeCli = join(f.root, 'fake-cli.mjs');
  writeFileSync(fakeCli, `import { existsSync, writeFileSync } from 'node:fs';
const [cmd] = process.argv.slice(2);
if (cmd === 'serve') {
  const marker = process.env.AVH_FAKE_CRASH_ONCE;
  if (marker && !existsSync(marker)) { writeFileSync(marker, 'crashed'); process.exit(3); }
  const stop = () => setTimeout(() => process.exit(0), 200);
  process.on('SIGTERM', stop);
  // The real CLI's stop on Windows, where the service cannot send SIGTERM: its stdin closes.
  if (process.env.AVH_STOP_ON_STDIN_END === '1') { process.stdin.on('end', stop); process.stdin.resume(); }
  setInterval(() => {}, 1000);
} else if (cmd === 'doctor') setTimeout(() => console.log('OK\\tNode\\tfake'), 1500);
`);
  process.env.AVH_FAKE_CRASH_ONCE = join(f.root, 'crash-marker');
  t.after(() => { delete process.env.AVH_FAKE_CRASH_ONCE; });
  await f.start({ scheduler: true, cliPath: fakeCli, intervalMs: 200 });
  const client = await f.connect();
  const state = async () => (await client.call<{ scheduler: { state: string; restarts: number; pid: number | null } }>('service.status')).scheduler;
  await waitFor(async () => (await state()).restarts,
    { what: 'the crashed scheduler to be restarted and counted', ready: restarts => restarts >= 1, timeoutMs: 30_000, intervalMs: 50 });
  assert.equal((await state()).restarts, 1, 'the crashed scheduler was counted');
  await waitFor(async () => (await state()).state,
    { what: 'the restarted scheduler to report running', ready: value => value === 'running', timeoutMs: 30_000, intervalMs: 50 });
  assert.equal((await state()).state, 'running', 'and restarted after backoff');
  const slow = client.call<{ checks: unknown[] }>('doctor.run');
  const started = Date.now();
  await client.call('hello');
  assert.ok(Date.now() - started < 500, 'the API answers while a slow command runs');
  assert.equal((await slow).checks.length, 1);
  assert.deepEqual(await client.call('service.pause'), { state: 'pausing' });
  await waitFor(async () => (await state()).state,
    { what: 'the scheduler child to report paused', ready: value => value === 'paused', timeoutMs: 30_000, intervalMs: 25 });
  assert.equal((await state()).state, 'paused');
  assert.equal((await state()).pid, null);
  await client.call('service.resume');
  assert.equal((await state()).state, 'running');
});

test('systemd user unit: one unit per Harness home, the right environment, and time for a safe stop', () => {
  assert.equal(unitName(join(homedir(), '.avatar-harness')), 'avh-runtime.service');
  assert.match(unitName('/srv/other-home'), /^avh-runtime-[0-9a-f]{8}\.service$/);
  const unit = unitFile('/srv/example-home/.avatar-harness', 1500, '/usr/bin/node', '/opt/avh/bin/avh.js');
  assert.match(unit, /^Environment="AVH_HOME=\/srv\/example-home\/\.avatar-harness"$/m);
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/opt\/avh\/bin\/avh\.js" service run --interval 1500$/m);
  assert.match(unit, /^TimeoutStopSec=150$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  const withPath = unitFile('/srv/example-home/.avatar-harness', 1500, '/usr/bin/node', '/opt/avh/bin/avh.js', '/srv/example-home/.npm-global/bin:/usr/bin');
  assert.match(withPath, /^Environment="PATH=\/srv\/example-home\/\.npm-global\/bin:\/usr\/bin"$/m);
});

test('with the real CLI the scheduler child runs rounds, and pausing leaves no scheduler process', async t => {
  const f = fixture(t);
  await f.start({ scheduler: true, intervalMs: 200 });
  const client = await f.connect();
  const status = async () => client.call<{ scheduler: { state: string; pid: number | null }; lease: { cycle: number } }>('service.status');
  await waitFor(async () => (await status()).lease.cycle,
    { what: 'two scheduler rounds to take the lease', ready: cycle => cycle >= 2, timeoutMs: 30_000, intervalMs: 100 });
  assert.ok((await status()).lease.cycle >= 2, 'at least two scheduler rounds took the lease');
  const pid = (await status()).scheduler.pid!;
  await client.call('service.pause');
  await waitFor(async () => (await status()).scheduler.state,
    { what: 'the real CLI scheduler child to report paused', ready: value => value === 'paused', timeoutMs: 60_000, intervalMs: 50 });
  assert.equal((await status()).scheduler.state, 'paused');
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the scheduler process is gone');
});

for (const residue of [false, true]) test(`real service.pause drains ${residue ? 'a previously stopped child residue' : 'an active dispatched unit'} without new work`, async t => {
  const f = fixture(t), tools = join(f.root, 'tools'), knowledge = join(f.root, 'knowledge');
  writeFileSync(join(tools, 'make-plan.mjs'), `import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
setTimeout(()=>{mkdirSync(join(process.env.AVH_PROJECT_DIR,'_harness'),{recursive:true});
writeFileSync(join(process.env.AVH_PROJECT_DIR,'_harness/plan.yaml'),'title: actual paused tool output\\n');},3000);`);
  // This is the exact failure class observed in the real project: a producer emitted an array metric.
  writeFileSync(join(tools, 'inspect.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[3],JSON.stringify({schema:'observation/0.1',metrics:{title_length:8,invalid_array:[]}}));`);
  writeFileSync(join(knowledge, 'api.capabilities.yaml'), stringify({ ...CAPABILITIES, stages: {
    plan: { mode: 'tool', command: [process.execPath, '{toolRoot}/make-plan.mjs'], allowedWrites: ['_harness/'], maxCheckRetries: 2 },
  } }));
  await f.start({ scheduler: false, intervalMs: 100 }); const client = await f.connect();
  const workflow = await client.call<{id:string}>('workflow.create', { project: 'sample', profile: 'api-flow' });
  const db = openDatabase(join(f.home,'state/harness.db')); t.after(()=>db.close());
  const count = () => Number(db.prepare('SELECT COUNT(*) n FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=?').get(workflow.id)!.n);
  if (residue) execFileSync(process.execPath,[fileURLToPath(new URL('../../bin/avh.js',import.meta.url)),'serve','--once'],
    { env: {...process.env,AVH_HOME:f.home},encoding:'utf8' });
  else await client.call('service.resume');
  await waitFor(count, { what: 'an actual supervised tool unit to be dispatched', ready: n => n > 0, timeoutMs: 60_000, intervalMs: 25 });
  assert.equal(count(),1,'an actual supervised tool unit was dispatched');
  await waitFor(() => String(db.prepare('SELECT status FROM run').get()!.status),
    { what: 'the dispatched Run to leave pending', ready: status => status !== 'pending', timeoutMs: 30_000, intervalMs: 50 });
  assert.equal(db.prepare('SELECT status FROM run').get()!.status,'running');
  await client.call('service.pause');
  const state = async () => (await client.call<{scheduler:{state:string,pid:number|null}}>('service.status')).scheduler;
  const pausing = await state(); assert.equal(pausing.state,'pausing'); assert.ok(pausing.pid);
  await client.call('service.pause'); await client.call('service.resume');
  assert.equal((await state()).pid,pausing.pid,'duplicate pause or premature resume never creates a second scheduler');
  const began=Date.now(); await client.call('hello'); assert.ok(Date.now()-began<1000,'API stays responsive while finishing the unit');
  try {
    await waitFor(async () => (await state()).state,
      { what: 'the service to finish pausing its dispatched unit', ready: value => value === 'paused', timeoutMs: 120_000, intervalMs: 50 });
  } catch (error) {
    t.diagnostic(JSON.stringify({status:await client.call('service.status'),
      runs:db.prepare('SELECT id,status,result_json,process_ref FROM run').all(),
      tasks:db.prepare('SELECT id,status FROM task').all(),events:db.prepare('SELECT action,reason FROM event ORDER BY seq DESC LIMIT 5').all()}));
    throw error;
  }
  assert.equal((await state()).state,'paused'); assert.equal((await state()).pid,null);
  assert.equal(count(),1,'validator error is not a second engineering Run');
  assert.equal(db.prepare('SELECT status FROM run').get()!.status,'exited');
  assert.equal(JSON.parse(String(db.prepare('SELECT result_json FROM run').get()!.result_json)).exitStatus,0);
  assert.equal(db.prepare('SELECT status FROM task').get()!.status,'BLOCKED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lock').get()!.n,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM verdict WHERE result='error'").get()!.n,1);
  assert.equal(readFileSync(join(f.project,'_harness/plan.yaml'),'utf8'),'title: actual paused tool output\n');
});

test('avh service start, status and stop manage a detached service for this home', async t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
  // A temporary home never has a systemd unit, so start falls back to a detached process with a log.
  const env = { ...process.env, AVH_HOME: f.home };
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  t.after(() => { try { run('service', 'stop'); } catch { /* already stopped */ } });
  assert.match(run('service', 'start', '--interval', '500'), /后台服务已启动（后台进程/);
  assert.match(run('service', 'start'), /已在运行/);
  const client = await f.connect();
  assert.equal((await client.call<{ home: string }>('hello')).home, f.home);
  client.close();
  assert.match(run('service', 'status'), /状态: 运行中/);
  assert.match(run('service', 'stop'), /已停止/);
  assert.throws(() => run('service', 'status'), (error: Error & { status?: number; stdout?: string }) =>
    error.status === 3 && /未运行/.test(error.stdout ?? ''));
});

test('Provider credentials can be stored, cleared and checked through the API, but never read back', async t => {
  const f = fixture(t);
  await f.start();
  const client = await f.connect();
  assert.deepEqual(await client.call('secret.status', { ids: ['pi-deepseek'] }), { 'pi-deepseek': false });
  assert.deepEqual(await client.call('secret.set', { id: 'pi-deepseek', value: 'sk-api-XYZ' }), { ok: true });
  const status = await client.call('secret.status', { ids: ['pi-deepseek', 'pi-glm'] });
  assert.deepEqual(status, { 'pi-deepseek': true, 'pi-glm': false });
  assert.doesNotMatch(JSON.stringify(status), /sk-api-XYZ/);
  await assert.rejects(client.call('secret.set', { id: '../config/harness.yaml', value: 'x' }), (error: Error & { code?: string }) => error.code === 'BAD_REQUEST');
  assert.deepEqual(await client.call('secret.clear', { id: 'pi-deepseek' }), { cleared: true });
  assert.deepEqual(await client.call('secret.status', { ids: ['pi-deepseek'] }), { 'pi-deepseek': false });
});

test('the project archive: what is known, inferred, missing or stale and what comes next; a refresh writes and checks it', async t => {
  const f = fixture(t);
  await f.start();
  const client = await f.connect();
  await client.call('workflow.create', { project: 'sample', profile: 'api-flow' });
  const project = (await client.call<Array<{ id: string; path: string }>>('project.list'))[0]!;
  type Overview = { known: Array<{ id: string; text: string }>; inferred: unknown[]; missing: Array<{ kind: string; text: string }>;
    stale: unknown[]; unknown: Array<{ id: string; attribute: string }>; next: Array<{ kind: string; text: string }>;
    archive: { write: { status: string } | null; shareable: { ok: boolean; blockers: Array<{ code: string }> } } };
  // Nothing has been observed or written yet: the export stays blocked, and the Workflow's next step leads.
  const first = await client.call<Overview>('project.facts', { projectId: project.id });
  assert.equal(first.archive.write, null);
  assert.ok(first.archive.shareable.blockers.some(item => item.code === 'projection_missing'));
  assert.equal(first.next[0]?.kind, 'workflow');
  const refreshed = await client.call<{ write: { status: string; revision: number }; check: { state: string };
    status: { verifiedRevision: number } }>('project.archive.refresh', { projectId: project.id });
  assert.equal(refreshed.write.status, 'verified');
  assert.equal(refreshed.check.state, 'consistent');
  assert.equal(refreshed.status.verifiedRevision, refreshed.write.revision);
  const overview = await client.call<Overview>('project.facts', { projectId: project.id });
  assert.equal(overview.archive.write?.status, 'verified');
  // The sample project is not a Unity project yet: its editor version is unknown, and missing as a dependency.
  const version = overview.unknown.find(item => item.attribute === 'unity.version')!;
  assert.ok(overview.missing.some(item => item.kind === 'unity'));
  // A person corrects it: appended as their statement, the archive follows at once.
  const corrected = await client.call<{ status: string; value: string; archive: { status: string } }>('project.fact.confirm',
    { projectId: project.id, factId: version.id, decision: 'correct', value: '2022.3.22f1', note: '工程将用这个版本' });
  assert.deepEqual([corrected.status, corrected.value, corrected.archive.status], ['user_confirmed', '2022.3.22f1', 'verified']);
  assert.ok((await client.call<Overview>('project.facts', { projectId: project.id })).known.some(item => item.text === 'Unity 版本：2022.3.22f1'));
  await assert.rejects(client.call('project.fact.confirm', { projectId: project.id, factId: version.id, decision: 'confirm' }),
    (error: Error & { code?: string }) => error.code === 'STALE');
  await assert.rejects(client.call('project.fact.confirm', { projectId: project.id, factId: 'missing', decision: 'reject' }),
    (error: Error & { code?: string }) => error.code === 'NOT_FOUND');
  // Classifying a path is a person's registration; Harness's own partitions and paths outside the project are refused.
  assert.deepEqual(await client.call('project.files.classify', { projectId: project.id, path: 'Assets/Mine/', match: 'tree',
    shareLayer: 'A', rights: 'transferable', note: '自己做的部分' }), { ok: true, registered: 1 });
  for (const path of ['../outside.txt', '_harness/state/project.json'])
    await assert.rejects(client.call('project.files.classify', { projectId: project.id, path, shareLayer: 'A', rights: 'transferable', note: 'x' }),
      (error: Error & { code?: string }) => error.code === 'BAD_REQUEST');
  const manifest = JSON.parse(readFileSync(join(project.path, '_harness', 'archive.json'), 'utf8')) as { files: Array<{ path: string }> };
  assert.ok(manifest.files.some(file => file.path === '_harness/state/facts.json'));
});

test('material directory consent is explicit, persistent and immediately consumed by an existing runtime config', async t => {
  const f = fixture(t); await f.start(); const client = await f.connect();
  const config = loadConfig(f.home), tools = config.toolRoot, providers = config.providers;
  const source = join(f.root, 'sources'); mkdirSync(source);
  const body = join(source, 'body.unitypackage'); writeFileSync(body, 'original source');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC', 'base64');
  writeFileSync(join(source, 'look.png'), png);
  type Sources = { roots: string[]; revision: string; scope: string };
  const initial = await client.call<Sources>('asset.sources.list');
  assert.deepEqual(initial.roots, []); assert.equal(initial.scope, 'installation');
  await assert.rejects(client.call('asset.sources.grant', { path: source, expectedRevision: initial.revision }), /明确允许/);
  await assert.rejects(client.call('asset.sources.grant', { path: body, consent: true, expectedRevision: initial.revision }), /文件夹/);
  assert.deepEqual(await client.call('asset.sources.list'), initial, 'refused requests never persist consent');
  let granted = await client.call<Sources>('asset.sources.grant', { path: source, consent: true, expectedRevision: initial.revision });
  assert.deepEqual(granted.roots, [realpathSync(source)]);
  await assert.rejects(client.call('asset.sources.revoke', { path: realpathSync(source), expectedRevision: initial.revision }), /已更新/);
  assert.deepEqual((await client.call<Sources>('asset.sources.list')).roots, granted.roots);
  const live = refreshAssetSearchRoots(config);
  assert.deepEqual(live.assetSearchRoots, granted.roots); assert.equal(live.providers, providers); assert.equal(live.toolRoot, tools);
  assert.deepEqual(config.assetSearchRoots, [], 'the stale config instance has not been replaced');
  await client.call('project.create', { name: 'source-consent' });
  const project = (await client.call<Array<{ id: string; path: string }>>('project.list'))[0]!;
  const message = await client.call<{ id: string; revision: number }>('project.message.add', { projectId: project.id, content: 'Use the available body', commandId: 'source-test' });
  const db = openDatabase(join(f.home, 'state/harness.db')); t.after(() => db.close());
  const root = explorationContext(db, config, project.id, message.id).roots[0]!.id;
  const listRequest = { op: 'list' as const, target: root, offset: 0 };
  const listed = performExploration(db, config, project.id, listRequest) as { entries: Array<{ id: string; name: string }> };
  const picture = listed.entries.find(entry => entry.name === 'look.png')!.id;
  const imageRequest = { op: 'inspect' as const, target: picture };
  const observed = performExploration(db, config, project.id, imageRequest);
  // Seed completed receipt owners; the observations themselves use the real broker, without a paid model.
  db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('receipt-owner',?,'receipt','receipt','test','completed','{}')").run(project.id);
  for (const [ordinal, request, result] of [[1, listRequest, listed], [2, imageRequest, observed]] as const) {
    const task = `receipt-${ordinal}`;
    db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES(?,'receipt-owner','observe','observe','readonly','PASSED')").run(task);
    db.prepare('INSERT INTO interaction_exploration(interaction_id,ordinal,task_id,request_json,result_json) VALUES(?,?,?,?,?)')
      .run(message.id, ordinal, task, JSON.stringify(request), JSON.stringify(result));
  }
  assert.equal(explorationImages(db, config, project.id, 1).length, 1);
  const receipt = explorationContext(db, config, project.id, message.id).history[0]!.receiptId;
  assert.ok(performExploration(db, config, project.id, { op: 'recall', target: receipt, offset: 0 }));
  const resource = listed.entries.find(entry => entry.name === 'body.unitypackage')!.id;
  const selected = performExploration(db, config, project.id, { op: 'select', target: resource, kind: 'avatar' }) as { assetId: string };
  const actual = db.prepare('SELECT id FROM exploration_resource WHERE project_id=? AND path=?').get(project.id, realpathSync(body))!;
  db.prepare(`INSERT INTO production_proposal(id,project_id,revision,profile,request,inputs_json,context_json,status)
    VALUES(?,?,?,?,?,?,?,'proposed')`).run(message.id, project.id, message.revision, 'api-flow', 'Use the available body',
      JSON.stringify([{ id: selected.assetId, path: realpathSync(body), name: 'body.unitypackage', kind: 'avatar', role: 'candidate', resourceId: actual.id,
        sha256: createHash('sha256').update('original source').digest('hex') }]), productionContext(db, project.id));
  const revoked = await client.call<Sources>('asset.sources.revoke', { path: granted.roots[0], expectedRevision: granted.revision });
  assert.deepEqual(revoked.roots, []); assert.deepEqual(loadConfig(f.home).assetSearchRoots, []);
  const hidden = explorationContext(db, config, project.id, message.id);
  assert.deepEqual(hidden.roots, []); assert.deepEqual(hidden.history, []); assert.equal(hidden.progress.executedOperations, 2);
  assert.deepEqual(explorationImages(db, config, project.id, 1), []);
  for (const request of [listRequest, imageRequest, { op: 'select' as const, target: resource, kind: 'avatar' as const }, { op: 'recall' as const, target: receipt, offset: 0 }])
    assert.throws(() => performExploration(db, config, project.id, request), /授权|范围/);
  assert.throws(() => approveProduction(db, config, message.id, 'revoked-approval', message.revision), /授权|范围/);
  await assert.rejects(client.call('project.production.approve', { id: message.id, revision: message.revision, commandId: 'api-revoked-approval' }), /授权|范围/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM workflow_definition').get()!.n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM project_asset WHERE project_id=?').get(project.id)!.n, 1, 'revocation preserves existing associated candidates');
  granted = await client.call<Sources>('asset.sources.grant', { path: source, consent: true, expectedRevision: revoked.revision });
  const approval = { id: message.id, revision: message.revision, commandId: 'authorized-approval' };
  const accepted = await client.call<{ workflowId: string }>('project.production.approve', approval);
  const frozen = db.prepare('SELECT manifest_json FROM workflow_definition WHERE workflow_id=?').get(accepted.workflowId)!.manifest_json;
  await client.call('asset.sources.revoke', { path: granted.roots[0], expectedRevision: granted.revision });
  assert.deepEqual(await client.call('project.production.approve', approval), accepted, 'revocation does not rewrite the already accepted command');
  assert.equal(db.prepare('SELECT manifest_json FROM workflow_definition WHERE workflow_id=?').get(accepted.workflowId)!.manifest_json, frozen);
  assert.equal(readFileSync(body, 'utf8'), 'original source'); assert.deepEqual(readFileSync(join(source, 'look.png')), png);
  assert.deepEqual(refreshAssetSearchRoots(config).assetSearchRoots, []);
  const configFile = join(f.home, 'config/harness.yaml'), saved = readFileSync(configFile, 'utf8');
  writeFileSync(configFile, 'assetSearchRoots: [');
  assert.deepEqual(refreshAssetSearchRoots({ ...config, assetSearchRoots: [source] }).assetSearchRoots, [], 'unreadable consent never retains old access');
  writeFileSync(configFile, saved);
  const events = db.prepare("SELECT payload_json FROM event WHERE entity_type='asset_sources'").all();
  assert.ok(events.length >= 4); assert.ok(events.every(event => !String(event.payload_json).includes(source)), 'audit metadata does not duplicate private source paths');
});

test('GUI-facing report API admits a failed single-family observation and opt-out cancels its payload',async t=>{
  const f=fixture(t);await f.start();const client=await f.connect();
  const db=openDatabase(join(f.home,'state/harness.db'));t.after(()=>db.close());
  const source=join(f.root,'candidate-report-source');cpSync(new URL('../../builtin/',import.meta.url),source,{recursive:true});
  const manifest=JSON.parse(readFileSync(join(source,'pack.json'),'utf8'));manifest.id='report-candidate';manifest.channel='candidate';manifest.version='report-1';writeFileSync(join(source,'pack.json'),JSON.stringify(manifest));
  registerPackCandidate(db,f.home,source,{basePackId:'builtin-linux-rc5',sourceKind:'ai',reason:'private customer reason',impact:{},permissions:{}});
  const results=[{caseId:'private-project-case',modelFamily:'deepseek',attempt:1,result:'error' as const,evidenceRef:'private/local'}];
  recordPackEvaluation(db,'report-candidate',{suiteId:'single',suiteVersion:'1',isolation:'process',baselineResults:results,results});
  const candidates=await client.call<Array<{id:string;decision:{eligible:boolean};reportDecision:{eligible:boolean}}>>('managed.candidate.list');
  const candidate=candidates.find(item=>item.id==='report-candidate')!;assert.equal(candidate.reportDecision.eligible,true);assert.equal(candidate.decision.eligible,false);
  await client.call('sharing.choose',{noticeShown:true});assert.equal((await client.call<{active:boolean}>('sharing.state')).active,false);
  await assert.rejects(()=>client.call('managed.contribution.authorize',{candidateId:candidate.id,consentText:'report'}),/开启回传/);
  await client.call('sharing.choose',{enabled:true});
  const item=await client.call<{id:string;bundlePath:string}>('managed.contribution.authorize',{candidateId:candidate.id,consentText:'only structured report'});
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(item.bundlePath,'pack/candidate-report.json'),'utf8'))).sort(),['category','evaluation','purpose','schema','sourceKind']);
  assert.equal((await client.call<{pendingReports:number}>('sharing.state')).pendingReports,1);
  // DATA/D8: the query already walks receipt → candidate → evaluation, and says plainly that no release is known yet.
  const trace=await client.call<{schema:string;receiptId:string|null;candidateId:string;evaluationId:string;release:unknown;installed:unknown;complete:boolean;refresh:{recorded:number}}>(
    'managed.contribution.trace',{candidateId:'report-candidate'});
  assert.equal(trace.schema,'harness-contribution-trace/0.1');assert.equal(trace.receiptId,null);
  assert.equal(trace.candidateId,'report-candidate');assert.equal(trace.release,null);assert.equal(trace.installed,null);
  assert.equal(trace.complete,false);assert.equal(trace.refresh.recorded,0);
  await assert.rejects(()=>client.call('managed.contribution.trace',{}),/receiptId 或 candidateId/);
  await assert.rejects(()=>client.call('managed.contribution.trace',{receiptId:'f'.repeat(32)}),/没有这条贡献记录/);
  await client.call('sharing.choose',{enabled:false});assert.equal(existsSync(item.bundlePath),false);
  assert.equal((await client.call<{pendingReports:number}>('sharing.state')).pendingReports,0);
  assert.equal((await client.call<Array<{status:string}>>('managed.contribution.list'))[0]!.status,'cancelled');
  await client.call('sharing.choose',{enabled:true});
  await assert.rejects(()=>client.call('managed.contribution.submit',{id:item.id}),/已取消/);
});


test('advanced GUI exploration depth updates the running guard and invalid settings roll back',async t=>{
 const f=fixture(t);await f.start();const client=await f.connect(),running=loadConfig(f.home);
 assert.equal(currentExplorationLimit(running),72);
 await client.call('config.update',{coordination:{maxExplorationOperations:240}});
 assert.equal((await client.call<{coordination:{maxExplorationOperations:number}}>('config.view')).coordination.maxExplorationOperations,240);
 assert.equal(currentExplorationLimit(running),240,'existing consumer reads new limit without restarting or clearing evidence');
 await assert.rejects(()=>client.call('config.update',{coordination:{maxExplorationOperations:0}}),/配置没有保存/);
 assert.equal(currentExplorationLimit(running),240);
 await assert.rejects(()=>client.call('config.update',{coordination:{maxExplorationOperations:240,spendingApproval:true}}),/未知探索配置/);
});

test('canonical recovery assets resolve a relative imported project and reject traversal without partial adoption', async t => {
  const f=fixture(t);mkdirSync(join(f.home,'state'),{recursive:true});const db=openDatabase(join(f.home,'state/harness.db'));t.after(()=>db.close());
  db.prepare("INSERT INTO workspace(id,path) VALUES('import-workspace',?)").run(join(f.root,'workspace'));
  db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES('import-project','import-workspace','private','sample','{}','imported','h','k')`).run();
  db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('analysis-workflow','import-project','avh-task/0.1','avh-task/0.1','k','active','{}')").run();
  db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('analysis-task','analysis-workflow','work','inspect','diagnostician','PASSED')").run();
  db.prepare(`INSERT INTO project_recovery(id,project_id,source_kind,source_path,source_hash,mode,status,analysis_task_id)
    VALUES('recovery','import-project','folder',?,'frozen-original','deep','ready','analysis-task')`).run(f.project);
  mkdirSync(join(f.project,'_Harness/Recovery'),{recursive:true});writeFileSync(join(f.project,'candidate.png'),'synthetic image asset');
  const analysis=join(f.project,'_Harness/Recovery/analysis.json');
  writeFileSync(analysis,JSON.stringify({classification:'asset_bundle',assetCandidates:[{path:'candidate.png',kind:'texture'}]}));
  await f.start();const client=await f.connect();
  const adopted=await client.call<{created:string[]}>('project.recovery.adoptAssets',{id:'recovery'});
  assert.equal(adopted.created.length,1);
  assert.equal(db.prepare('SELECT path FROM asset WHERE id=?').get(adopted.created[0]!)!.path,join(f.project,'candidate.png'));
  assert.equal(db.prepare('SELECT project_id FROM project_asset WHERE asset_id=?').get(adopted.created[0]!)!.project_id,'import-project');
  const before=db.prepare('SELECT count(*) AS n FROM asset').get()!.n;
  writeFileSync(join(f.root,'outside.png'),'outside');writeFileSync(join(f.project,'second.png'),'second synthetic asset');
  writeFileSync(analysis,JSON.stringify({classification:'mixed',assetCandidates:[{path:'second.png'},{path:'../../outside.png'}]}));
  await assert.rejects(client.call('project.recovery.adoptAssets',{id:'recovery'}),/越界或不存在/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM asset').get()!.n,before,'preceding candidate insert rolls back');
  assert.equal(readFileSync(join(f.root,'outside.png'),'utf8'),'outside');
  db.prepare("UPDATE project_recovery SET status='failed' WHERE id='recovery'").run();
  await assert.rejects(client.call('project.recovery.adoptAssets',{id:'recovery'}),/结构化结果不完整/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM asset').get()!.n,before,'historical Task PASS cannot authorize a failed takeover');
  assert.equal(db.prepare("SELECT status FROM task WHERE id='analysis-task'").get()!.status,'PASSED','old evidence is retained');
  db.prepare("UPDATE project_recovery SET status='ready' WHERE id='recovery'").run();
  const applied=await client.call<{taskId:string}>('project.recovery.apply',{id:'recovery'});
  assert.equal(db.prepare('SELECT w.project_id FROM task t JOIN workflow w ON w.id=t.workflow_id WHERE t.id=?').get(applied.taskId)!.project_id,'import-project');
  assert.equal(db.prepare('SELECT count(*) AS n FROM project').get()!.n,1);
  assert.equal(db.prepare("SELECT apply_task_id FROM project_recovery WHERE id='recovery'").get()!.apply_task_id,applied.taskId);
  assert.equal(db.prepare("SELECT analysis_task_id FROM project_recovery WHERE id='recovery'").get()!.analysis_task_id,'analysis-task');
  assert.equal(db.prepare("SELECT status FROM task WHERE id='analysis-task'").get()!.status,'PASSED');
  assert.equal(db.prepare("SELECT path FROM project WHERE id='import-project'").get()!.path,'sample');
});
