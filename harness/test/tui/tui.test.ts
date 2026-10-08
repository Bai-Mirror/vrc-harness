import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { render } from 'ink';
import stringWidth from 'string-width';
import type { EventMessage } from '../../src/api/protocol.ts';
import { App } from '../../src/tui/app.ts';
import { h, inputWindow, type Api } from '../../src/tui/core.ts';
import { configDocument, findProfiles, SetupWizard } from '../../src/tui/setup.ts';
import { loadConfig } from '../../src/config.ts';
import { installBundledPack } from '../../src/managed-pack.ts';
import { stringify } from 'yaml';
import { escapeRegExp, removeTemp, useHome } from '../fixtures/platform.ts';
import { waitFor } from '../fixtures/wait.ts';

/** A terminal of a chosen size that records every frame, and keys typed into it. */
class Screen extends EventEmitter {
  readonly frames: string[] = [];
  readonly isTTY = true;
  readonly columns: number; readonly rows: number;
  constructor(columns: number, rows: number) { super(); this.columns = columns; this.rows = rows; }
  write = (frame: string) => { this.frames.push(frame); return true; };
  /** The last frame with content; cursor placement for input methods is written as a separate, escape-only chunk. */
  last(): string {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const text = this.frames[i]!.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
      if (text.trim()) return text;
    }
    return '';
  }
}
class Keys extends EventEmitter {
  isTTY = true; data: string | null = null;
  write(data: string) { this.data = data; this.emit('readable'); this.emit('data', data); }
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
  read = () => { const data = this.data; this.data = null; return data; };
}
const KEY = { enter: '\r', escape: '\u001b', down: '\u001b[B', up: '\u001b[A', ctrlK: '\u000b' };

class FakeApi implements Api {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private readonly listeners: Array<(event: EventMessage) => void> = [];
  private readonly closers: Array<() => void> = [];
  readonly data: Record<string, unknown>;
  constructor(data: Record<string, unknown>) { this.data = data; }
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const value = this.data[method];
    if (value === undefined) throw new Error(`fake has no ${method}`);
    return structuredClone(typeof value === 'function' ? (value as (p: unknown) => unknown)(params) : value) as T;
  }
  async subscribe(listener: (event: EventMessage) => void): Promise<number> { this.listeners.push(listener); return 1; }
  onClose(listener: () => void): void { this.closers.push(listener); }
  close(): void {}
  emit(event: EventMessage): void { for (const listener of this.listeners) listener(event); }
  drop(): void { for (const closer of this.closers) closer(); }
  count(method: string): number { return this.calls.filter(call => call.method === method).length; }
}

const WF = 'wf-1111-2222';
const PLAN_HASH = '3f2a1b9c77aa';
function fixtureData(): Record<string, unknown> {
  const stage = (id: string, status: string, task?: { id: string; status: string }, display?: string) => ({ id, status,
    ...(display ? { display } : {}), reasons: status === 'blocked'
    ? [`check scene_items: violation`] : [], codes: [], ...(task ? { task: { ...task, attempts: 1 } } : {}), gates: id === 'plan' ? ['plan_approval'] : [],
  produces: [], checks: id === 'make' ? [
    { id: 'scene_items', severity: 'blocking', scope: 'edit', on: 'scene', rule: 'items > 1', observe: 'scene.count',
      verdict: { result: 'violation', basis: 'scene.count: items > 1 | items=1', recordedAt: '2026-09-27T08:00:00Z', current: true } },
    { id: 'menu_ok', severity: 'blocking', scope: 'build', on: 'build', rule: 'ok == true', observe: 'menu.dump',
      verdict: { result: 'pass', basis: 'menu.dump: ok == true | ok=true', recordedAt: '2026-09-27T07:00:00Z', current: false } }] : [] });
  const view = { id: WF, project: '/w/晨光头像', projectName: '晨光头像', profile: 'pc-recolor-outfit', status: 'active',
    createdAt: null, frozenAt: '2026-09-27T06:00:00Z', processHash: 'abc', knowledgeVersion: 'k', request: '两套服装互斥切换',
    plan: { hash: PLAN_HASH, revisions: 1, approved: false },
    stages: [stage('plan', 'blocked', { id: 'task-plan', status: 'WAITING_HUMAN' }, 'deciding'), stage('make', 'blocked', { id: 'task-make', status: 'BLOCKED' }),
      stage('extra', 'waiting')],
    milestones: [{ id: 'UPLOAD_READY', status: 'not_reached', reasons: [] }],
    gates: [{ gate: `${WF}:plan_approval`, workflowId: WF, project: '/w/晨光头像', kind: 'approve', binds: 'plan', owner: 'stage:plan',
      status: 'pending', artifactHash: PLAN_HASH }],
    next: '需要你决定：plan_approval（批准或驳回，绑定 plan）' };
  return {
    'project.intent.list': [],
    'gate.list': [{ gate: `${WF}:plan_approval`, workflowId: WF, formal: true, project: '/w/晨光头像', projectName: '晨光头像',
      owner: 'stage:plan', status: 'pending', question: '批准当前 plan？', binds: 'plan', artifactHash: PLAN_HASH }],
    'task.list': [
      { id: 'task-make', workflowId: WF, formal: true, project: '/w/晨光头像', projectName: '晨光头像', stage: 'make', status: 'BLOCKED',
        goal: '阶段 make', updatedAt: null, needsYou: true },
      { id: 'task-other', workflowId: 'wf-2', formal: false, project: '/w/另一个工程', projectName: '另一个工程', stage: 'work', status: 'RUNNING',
        goal: '渲染预览', updatedAt: null, needsYou: false }],
    'workflow.list': [{ id: WF, project: '/w/晨光头像', projectName: '晨光头像', profile: 'pc-recolor-outfit', status: 'active',
      createdAt: null, stagesPassed: 0, stagesTotal: 3, current: 'plan', next: view.next }],
    'workflow.show': view,
    'project.list': [{ id: 'p1', path: '/w/晨光头像', name: '晨光头像', kind: 'sample', workflow: { id: WF, profile: 'pc-recolor-outfit',
      status: 'active', next: view.next }, tasks: { total: 2, open: 2, needsYou: 1 } }],
    // A plan as plan/0.2 actually writes it, with all three recolor target forms (relative, layer, material):
    // the summary a person approves has to name each of them, and the terminal must derive it the same way
    // the desktop GUI does (src/shared/plan-view.ts).
    'plan.show': { current: { schema: 'plan/0.2', body: '7000004', body_prefab: 'Assets/PLUSONE/Milfy/Prefab/Milfy.prefab',
      outfits: [{ id: 'daily', item: '7000001', label: '日常服' }, { id: 'dress', item: '7000003', label: '礼服' }],
      default_outfit: 'daily', menu: { mode: 'preserve' }, face: { mode: 'preserve' }, optimization: { mode: 'preserve' },
      recolor: { candidates: 3, targets: [
        { part: 'hair', hue_shift: -20, saturation: 1, value: 1 },
        { requirement_id: 'outfit_trim_cream', layered: 'Milfy_v1.5.0/PSD/Costume_default.psd', layer: ['Trim'],
          color: '#FAF3EE', semantics: 'flat' },
        { requirement_id: 'dress_body_tier2', outfit: 'dress', material: 'Assets/Vendor/Tier2/Dress_Body.mat' }] } },
      revisions: [{ seq: 1, hash: PLAN_HASH, observedAt: '2026-09-27T06:30:00Z', approved: false }] },
    'task.show': { id: 'task-make', workflowId: WF, formal: true, project: '/w/晨光头像', projectName: '晨光头像', stage: 'make',
      status: 'BLOCKED', goal: '阶段 make', updatedAt: null, needsYou: true, allowedWrites: ['scene/'], expectedOutputs: ['scene'],
      next: '阶段 make 检查未通过：check scene_items: violation；处理后重做', runs: [{ id: 'r1', attempt: 1, provider: 'tool', status: 'exited', exitStatus: 0 }],
      verdicts: [{ checkId: 'scene_items', scope: 'edit', result: 'violation', basis: 'scene.count: items > 1 | items=1', recordedAt: '2026-09-27T08:00:00Z', current: true }],
      outOfBounds: [], events: [{ seq: 9, at: '2026-09-27T08:00:00Z', actor: 'runtime', action: 'VERIFYING->BLOCKED', reason: 'check scene_items: violation' }] },
    'service.status': { runtime: 'avh 0.1.0-dev.1 (abc)', schema: 8, endpoint: '/h/run/avh.sock', eventSeq: 9, home: '/h',
      scheduler: { state: 'running', pid: 42, intervalMs: 1000, restarts: 0 }, lease: { holder: null, expiresAt: null, cycle: 3 } },
    'config.view': { workspaceRoot: '/w', exportRoots: ['/exports'], defaultProfile: 'pc-recolor-outfit', profiles: ['pc-recolor-outfit'],
      providers: [{ id: 'codex', type: 'codex-cli' }], workflowVariables: { assetLibrary: '/cache', templateProject: '/template' } },
    'events.recent': [{ seq: 9, at: '2026-09-27T08:00:00Z', workflowId: WF, actor: 'runtime', entityType: 'task', entityId: 'task-make',
      action: 'VERIFYING->BLOCKED', reason: 'check scene_items: violation' }],
    'provider.list': [{ id: 'codex', type: 'codex-cli', state: 'declared', version: 'unknown', login: 'unknown', quota_used_percent: 'unknown',
      health: 'unknown', sandbox: 'self' }],
    'managed.list': [{ id: 'pack-1', version: '0.1.0', channel: 'stable', description: '内置正式能力', active: true },
      { id: 'pack-0', version: '0.0.9', channel: 'stable', description: '上一正式版本', active: false }],
    'asset.list': [{ id: 'asset-1', path: '/assets/coat.unitypackage', name: '蓝色外套', kind: 'outfit', status: 'candidate',
      license: 'personal', tags: ['Kaguya'] }],
    'booth.status': { connected: true, items: 1, owned: 1, files: 2, materialized: 1 },
    'booth.catalog': [{ itemId: '123', name: '春日衣装', shopName: 'Example', category: '3D衣装', fileCount: 2, materializedCount: 1, status: 'available' }],
    'gate.decide': { message: 'approve' }, 'task.redo': { message: 'ok' }, 'service.pause': { state: 'pausing' },
    'asset.save': { ok: true }, 'asset.remove': { ok: true }, 'booth.sync': { started: true, startedAt: '2026-09-28T00:00:00.000Z' },
    'managed.installBuiltin': { id: 'pack-1' }, 'managed.activate': { ok: true },
    'knowledge.check': { rejected: 1, releases: [
      { releaseId: 'knowledge-0.2.0', version: '0.2.0', issuedAt: '2026-09-28T06:00:00Z', size: 2097152, installed: false, newer: true },
      { releaseId: 'knowledge-0.1.1', version: '0.1.1', issuedAt: '2026-09-20T06:00:00Z', size: 1048576, installed: true, newer: true },
      { releaseId: 'knowledge-0.0.1', version: '0.0.1', issuedAt: '2026-09-01T06:00:00Z', size: 1048576, installed: false, newer: false }] },
    'knowledge.install': { id: 'vrc-knowledge-0.2.0', version: '0.2.0', alreadyInstalled: false },
    'config.update': { ok: true }, 'config.reload': { ok: true },
  };
}

function mount(t: TestContext, columns = 100, rows = 30, data = fixtureData()) {
  const stdout = new Screen(columns, rows); const stdin = new Keys(); const api = new FakeApi(data);
  let exited: boolean | undefined;
  const instance = render(h(App, { api, onExit: pause => { exited = pause; } }),
    { stdout: stdout as never, stdin: stdin as never, stderr: new Screen(columns, rows) as never, debug: true, exitOnCtrlC: false, patchConsole: false });
  t.after(() => instance.unmount());
  const settle = () => delay(80);
  const press = async (...keys: string[]) => { for (const key of keys) { stdin.write(key); await settle(); } };
  return { stdout, api, press, settle, exited: () => exited };
}

test('the inbox lists decisions and tasks that wait for a person, with Chinese state words', async t => {
  const ui = mount(t);
  await ui.settle();
  const frame = ui.stdout.last();
  assert.match(frame, /1 首页\(2\)/);
  assert.match(frame, /待决定/);
  assert.match(frame, /批准当前 plan？ · plan 3f2a1b9c/);
  assert.match(frame, /检查未通过/);
  assert.doesNotMatch(frame, /渲染预览/, 'running work is not in the inbox');
  assert.match(frame, /● 调度运行中/);
});

test('project conversation answers the bound question and approves only the displayed proposal revision', async t => {
  const data = { ...fixtureData(), 'project.message.list': [{ id: 'question', role: 'harness', content: '希望什么颜色？',
    revision: 4, interactionStatus: 'awaiting_user', error: null }], 'project.message.add': { id: 'reply', revision: 5 },
    'project.production.list': [{ id: 'proposal', revision: 4, request: '改为黑白并保留脸型', status: 'proposed', inputs: [{ name: '素体' }] }],
    'project.production.approve': { workflowId: 'new-workflow' } };
  const ui = mount(t, 100, 30, data); await ui.settle(); await ui.press('2', KEY.enter, 'm');
  assert.match(ui.stdout.last(), /项目对话/);
  await ui.press(KEY.down, KEY.enter);
  while (/\[n\]/.test(ui.stdout.last())) await ui.press('n');
  assert.match(ui.stdout.last(), /批准并开始/); await ui.press('a');
  const approval = ui.api.calls.find(c => c.method === 'project.production.approve')!;
  assert.equal(approval.params.id, 'proposal'); assert.equal(approval.params.revision, 4);
  await ui.press('m', '黑白配色', KEY.enter);
  const reply = ui.api.calls.find(c => c.method === 'project.message.add')!;
  assert.equal(reply.params.replyTo, 'question'); assert.equal(reply.params.expectedRevision, 4);
  assert.equal(reply.params.content, '黑白配色'); assert.equal(typeof reply.params.commandId, 'string');
});

test('project conversation can resume a failed request without composing a replacement message', async t => {
  const ui=mount(t,100,30,{...fixtureData(), 'project.message.list': [{id:'request',role:'user',content:'保留脸型',
    revision:2,interactionStatus:'failed',taskId:'stopped-task',error:'处理超时'}], 'project.production.list': [],
    'project.message.retry': {id:'request',revision:2,status:'queued'}});
  await ui.settle();await ui.press('2',KEY.enter,'m',KEY.enter);
  assert.match(ui.stdout.last(),/从中断处继续/);
  await ui.press('c');
  const command=ui.api.calls.find(c=>c.method==='project.message.retry')!;
  assert.equal(command.params.id,'request');assert.equal(command.params.expectedRevision,2);
  assert.equal(command.params.expectedTaskId,'stopped-task');
  assert.equal(ui.api.count('project.message.add'),0);
});

test('project conversation exposes current interpretations with the original words', async t => {
  const ui=mount(t,100,30,{...fixtureData(),'project.message.list':[],'project.production.list':[],
    'project.intent.list':[{id:'current',content:'保留脸型',quote:'脸不要改'}]});
  await ui.settle();await ui.press('2',KEY.enter,'m',KEY.enter);
  assert.match(ui.stdout.last(),/当前要求的理解/);assert.match(ui.stdout.last(),/脸不要改/);
  assert.equal(ui.api.count('project.message.add'),0);
});

test('project conversation explains interrupted production and sends project resume or cancel without asking for task identifiers',async t=>{
  for(const action of ['resume','cancel'] as const)await t.test(action,async st=>{
    const ui=mount(st,100,30,{...fixtureData(),'project.message.list':[],
      'project.production.list':[{id:'production',revision:1,request:'参考图制作头像',status:'working',inputs:[{name:'素材'}],
        progress:{state:'interrupted',reason:'制作未完成，已有成果保留。',token:'current-token',canResume:true,canCancel:true}}],
      [`project.production.${action}`]:action==='resume'?{requested:true}:{confirmed:true}});
    await ui.settle();await ui.press('2',KEY.enter,'m');assert.match(ui.stdout.last(),/制作未完成/);
    await ui.press(KEY.enter);while(/\[n\]/.test(ui.stdout.last()))await ui.press('n');
    assert.match(ui.stdout.last(),/核对并继续制作/);assert.match(ui.stdout.last(),/取消这次制作/);
    await ui.press(action==='resume'?'c':'x');
    const command=ui.api.calls.find(c=>c.method===`project.production.${action}`)!;
    assert.equal(command.params.id,'production');assert.equal(command.params.expectedToken,'current-token');
    assert.equal(typeof command.params.projectId,'string');
    assert.equal(ui.api.count('project.message.add'),0);assert.equal(ui.api.count('task.redo'),0);
  });
});

test('default TUI project creation asks for intent instead of a process or manifest', async t => {
  const ui = mount(t, 100, 30, { ...fixtureData(), 'project.create': { id: 'new-project' },
    'project.message.list': [], 'project.production.list': [] });
  await ui.settle(); await ui.press('2', 'n', '新头像', KEY.enter, '保留脸型改成黑白', KEY.enter);
  assert.deepEqual(ui.api.calls.find(c => c.method === 'project.create')!.params,
    { name: '新头像', request: '保留脸型改成黑白', mode: 'conversation' });
  assert.equal(ui.api.calls.some(c => c.method === 'workflow.create'), false);
  assert.match(ui.stdout.last(), /项目对话/);
});

test('the material tab reads the real Runtime catalog rather than a project placeholder', async t => {
  const ui=mount(t); await ui.settle(); await ui.press('3'); const frame=ui.stdout.last();
  assert.match(frame,/蓝色外套/); assert.match(frame,/待确认/); assert.match(frame,/Kaguya/);
  assert.match(frame,/春日衣装/); assert.match(frame,/BOOTH 已连接/);
  assert.ok(ui.api.calls.some(call=>call.method==='asset.list'));
});

test('the material tab follows a running BOOTH sync and shows how the last one ended', async t => {
  const running=mount(t,100,30,{...fixtureData(),'booth.status':{connected:true,items:1,owned:1,files:2,materialized:1,last:null,
    job:{kind:'sync',startedAt:'2026-09-28T00:00:00.000Z',progress:{phase:'items',pages:2,items:3,itemsTotal:10,requests:9}}}});
  await running.settle(); await running.press('3','s');
  assert.match(running.stdout.last(),/正在同步 BOOTH 索引：3\/10 个商品/);
  assert.ok(!running.api.calls.some(call=>call.method==='booth.sync'),'no second sync while one runs');
  const stopped=mount(t,100,30,{...fixtureData(),'booth.status':{connected:true,items:1,owned:1,files:2,materialized:1,job:null,
    last:{kind:'sync',ok:false,message:'BOOTH 返回 HTTP 429（请求过多），已停止同步',finishedAt:'2026-09-28T00:01:00.000Z'}}});
  await stopped.settle(); await stopped.press('3');
  assert.match(stopped.stdout.last(),/上次同步：BOOTH 返回 HTTP 429/);
});

test('the material tab can register and remove local assets and sync an existing BOOTH session', async t => {
  const ui=mount(t); await ui.settle(); await ui.press('3','n');
  for(const value of ['新围巾','/assets/scarf.unitypackage','outfit','personal','winter, scarf']) await ui.press(value,KEY.enter);
  assert.ok(ui.api.calls.some(call=>call.method==='asset.save'&&call.params.name==='新围巾'));
  await ui.press('s'); assert.ok(ui.api.calls.some(call=>call.method==='booth.sync'));
  await ui.press('x','y'); assert.ok(ui.api.calls.some(call=>call.method==='asset.remove'&&call.params.id==='asset-1'));
});

test('the core tab installs, lists, and explicitly rolls back immutable managed packs', async t => {
  const ui=mount(t); await ui.settle(); await ui.press('5');
  assert.match(ui.stdout.last(),/正式知识与工具版本/); assert.match(ui.stdout.last(),/0\.0\.9/);
  await ui.press('i'); assert.ok(ui.api.calls.some(call=>call.method==='managed.installBuiltin'));
  await ui.press('v','1'); assert.ok(ui.api.calls.some(call=>call.method==='managed.activate'&&call.params.id==='pack-0'));
  // Only newer, not yet installed releases are offered, and installing never activates.
  await ui.press('u'); assert.match(ui.stdout.last(),/0\.2\.0 · 2\.0 MB/); assert.doesNotMatch(ui.stdout.last(),/0\.1\.1 ·|0\.0\.1 ·/);
  assert.match(ui.stdout.last(),/已忽略 1 个/);
  await ui.press('1'); assert.ok(ui.api.calls.some(call=>call.method==='knowledge.install'&&call.params.releaseId==='knowledge-0.2.0'));
  assert.equal(ui.api.calls.filter(call=>call.method==='managed.activate').length,1);
});

test('the settings tab edits configuration through Runtime validation instead of a file shortcut', async t => {
  const ui=mount(t);await ui.settle();await ui.press('6');assert.match(ui.stdout.last(),/工作区：\/w/);
  await ui.press('e');for(const value of ['/new-workspace','/new-template','/new-cache','/opt/unity/Editor/Unity','/deliver-a, /deliver-b','pc-recolor-outfit','codex-cli, claude-cli'])await ui.press('\u0015',value,KEY.enter);
  const update=ui.api.calls.find(call=>call.method==='config.update');assert.ok(update);assert.deepEqual(update.params.exportRoots,['/deliver-a','/deliver-b']);
  assert.equal(update.params.unityEditor,'/opt/unity/Editor/Unity');
  assert.deepEqual(update.params.providerTypes,['codex-cli','claude-cli']);
});

test('accepting every current value in the settings editor saves each field unchanged', async t => {
  const ui=mount(t);await ui.settle();await ui.press('6','e');
  for(let i=0;i<7;i++)await ui.press(KEY.enter);
  const update=ui.api.calls.find(call=>call.method==='config.update');assert.ok(update);
  assert.equal(update.params.workspaceRoot,'/w');assert.equal(update.params.defaultProfile,'pc-recolor-outfit');
  assert.equal(update.params.unityEditor,'','an empty Unity editor keeps the current one');
  assert.deepEqual(update.params.workflowVariables,{assetLibrary:'/cache',templateProject:'/template'});
  assert.deepEqual(update.params.exportRoots,['/exports']);assert.deepEqual(update.params.providerTypes,['codex-cli']);
});

test('each prompt in a chain starts from its own value, not the previous answer', async t => {
  const ui=mount(t); await ui.settle(); await ui.press('3','n');
  for(const value of ['新围巾','/assets/scarf.unitypackage']) await ui.press(value,KEY.enter);
  await ui.press(KEY.enter,KEY.enter,KEY.enter);
  const save=ui.api.calls.find(call=>call.method==='asset.save');assert.ok(save);
  assert.equal(save.params.path,'/assets/scarf.unitypackage');assert.equal(save.params.kind,'package');
  assert.equal(save.params.license,'unknown');assert.deepEqual(save.params.tags,[]);
});

/** No Unity Hub installation for the wizard to find (Windows looks under Program Files and %APPDATA%). */
function emptyUnityHub(t:{after:(fn:()=>void)=>void},home:string):void{
  const prior={ProgramFiles:process.env.ProgramFiles,APPDATA:process.env.APPDATA};
  process.env.ProgramFiles=join(home,'no-programs');process.env.APPDATA=join(home,'no-appdata');
  t.after(()=>{for(const [name,value] of Object.entries(prior))if(value===undefined)delete process.env[name];else process.env[name]=value;});
}

test('the setup wizard reaches AI and summary without asking the user for an engineering template', async t => {
  const home=mkdtempSync(join(tmpdir(),'avh-setup-home-'));t.after(()=>removeTemp(home));
  useHome(t,home);emptyUnityHub(t,home);
  const stdout=new Screen(100,30),stdin=new Keys();
  const instance=render(h(SetupWizard,{home:join(home,'.avatar-harness'),onDone:()=>{}}),
    {stdout:stdout as never,stdin:stdin as never,stderr:new Screen(100,30) as never,debug:true,exitOnCtrlC:false,patchConsole:false});
  t.after(()=>instance.unmount());
  const press=async(key:string)=>{stdin.write(key);await delay(150);};
  await delay(150);await press(KEY.enter);
  await waitFor(() => stdout.last(), { what: 'the setup wizard to show the Unity step', ready: frame => /\[Enter\] 继续/.test(frame), timeoutMs: 30_000, intervalMs: 100 });
  await press(KEY.enter);await press(KEY.enter);await press(KEY.enter);
  assert.match(stdout.last(),/Unity 编辑器（可留空）：/);
  await press('/no/such/Unity');await press(KEY.enter);assert.match(stdout.last(),new RegExp(`找不到：${escapeRegExp(resolve('/no/such/Unity'))}`));
  await press('\u0015');await press(KEY.enter);
  assert.match(stdout.last(),/选择要使用的执行方/);
  await press(KEY.enter);assert.match(stdout.last(),/贡献者用户名（可留空）：/);
  await press('喵');await press(KEY.enter);
  assert.match(stdout.last(),/contributorName: 喵/);
});

test('the setup wizard offers the export directory its own default after the workspace step', async t => {
  const home=mkdtempSync(join(tmpdir(),'avh-setup-home-'));t.after(()=>removeTemp(home));
  useHome(t,home);emptyUnityHub(t,home);
  const stdout=new Screen(100,30),stdin=new Keys();
  const instance=render(h(SetupWizard,{home:join(home,'.avatar-harness'),onDone:()=>{}}),
    {stdout:stdout as never,stdin:stdin as never,stderr:new Screen(100,30) as never,debug:true,exitOnCtrlC:false,patchConsole:false});
  t.after(()=>instance.unmount());
  const press=async(key:string)=>{stdin.write(key);await delay(150);};
  await delay(150);await press(KEY.enter);
  await waitFor(() => stdout.last(), { what: 'the setup wizard to show the workspace step', ready: frame => /\[Enter\] 继续/.test(frame), timeoutMs: 30_000, intervalMs: 100 });
  await press(KEY.enter);assert.match(stdout.last(),new RegExp(`工作区目录：${escapeRegExp(join(home,'avatar-workspace'))}`));
  await press(KEY.enter);assert.match(stdout.last(),new RegExp(`交付导出目录：${escapeRegExp(join(home,'avatar-exports'))}`));
});

test('a gate decision carries the hash the person was shown, and a Chinese note typed through the prompt', async t => {
  const ui = mount(t);
  await ui.settle();
  await ui.press(KEY.enter);
  assert.match(ui.stdout.last(), /决定 plan_approval（待决定）/);
  assert.match(ui.stdout.last(), /绑定 plan 的当前版本 3f2a1b9c/);
  await ui.press('a');
  assert.match(ui.stdout.last(), /批准说明（可空）：/);
  await ui.press('看过了', '，可以');
  await ui.press(KEY.enter);
  await ui.settle();
  const decide = ui.api.calls.find(call => call.method === 'gate.decide')!;
  assert.deepEqual(decide.params, { gate: `${WF}:plan_approval`, approve: true, note: '看过了，可以', expectedHash: PLAN_HASH });
  assert.match(ui.stdout.last(), /已批准/);
});

test('TUI hides approval for a recolour preview Gate and directs the person to the same project GUI', async t => {
  const data = fixtureData();
  data['gate.list'] = [{ gate: `${WF}:recolor_approval`, workflowId: WF, formal: true, project: '/w/晨光头像', projectName: '晨光头像',
    owner: 'stage:recolor', status: 'pending', question: '查看 Unity 渲染的配色候选图，批准当前版本或提出调整要求', binds: 'materials', artifactHash: PLAN_HASH,
    preview: 'recolor-candidates' }];
  const ui = mount(t, 100, 30, data);
  await ui.settle();
  await ui.press(KEY.enter);
  assert.match(ui.stdout.last(), /同一项目的 GUI 中查看 Unity 候选图/);
  assert.doesNotMatch(ui.stdout.last(), /\[a\] 批准/);
  await ui.press('r');
  assert.match(ui.stdout.last(), /驳回原因/);
  await ui.press('不接受当前候选图', KEY.enter);
  await ui.settle();
  const decide = ui.api.calls.find(call => call.method === 'gate.decide')!;
  assert.equal(decide.params.approve, false);
});

test('rejecting a stage\'s Gate can send the stage back with the reason as its redo note', async t => {
  const ui = mount(t);
  await ui.settle();
  await ui.press(KEY.enter);
  assert.match(ui.stdout.last(), /\[d\] 驳回并重做/);
  assert.match(ui.stdout.last(), /\[r\] 只驳回/);
  await ui.press('d');
  assert.match(ui.stdout.last(), /驳回原因（会交给阶段 plan 的执行方重做）：/);
  await ui.press('医疗噩梦改用 Pink 款');
  await ui.press(KEY.enter);
  await ui.settle();
  assert.deepEqual(ui.api.calls.find(call => call.method === 'gate.decide')!.params,
    { gate: `${WF}:plan_approval`, approve: false, note: '医疗噩梦改用 Pink 款', redo: true, expectedHash: PLAN_HASH });
  assert.match(ui.stdout.last(), /已驳回，阶段 plan 将按原因重做/);
});

test('a long note scrolls sideways with the cursor, so what is being typed stays visible', async t => {
  const ui = mount(t, 60, 24);
  await ui.settle();
  await ui.press(KEY.enter, 'a');
  const note = `${'甲乙丙丁戊'.repeat(6)}末尾可见`;
  await ui.press(note);
  const line = () => ui.stdout.last().split('\n').find(row => row.includes('批准说明'))!;
  assert.match(line(), /批准说明（可空）：….*末尾可见$/);
  assert.ok(stringWidth(line()) <= 60);
  await ui.press('\u001b[H');
  assert.match(line(), /批准说明（可空）：甲乙丙.*…$/);
  assert.doesNotMatch(line(), /末尾可见/);
});

test('keys that arrive together each count: a held arrow moves a row per key, a held Backspace deletes a character per key', async t => {
  const data = fixtureData();
  const extra = (id: string) => ({ id, workflowId: 'wf-3', formal: false, project: '/w/第三个', projectName: '第三个', stage: 'work',
    status: 'WAITING_HUMAN', goal: `任务 ${id}`, updatedAt: null, needsYou: true });
  (data['task.list'] as unknown[]).push(extra('task-x'), extra('task-y'));
  const ui = mount(t, 100, 30, data);
  await ui.settle();
  await ui.press(`${KEY.down}${KEY.down}`);
  assert.match(ui.stdout.last(), /› 等你处理 +第三个 +任务 task-x/);
  await ui.press(KEY.up, KEY.up, KEY.enter, 'a', 'abc', '\u007f\u007f');
  assert.match(ui.stdout.last(), /批准说明（可空）：a$/m);
  await ui.press(KEY.enter);
  await ui.settle();
  assert.equal(ui.api.calls.find(call => call.method === 'gate.decide')!.params.note, 'a');
});

test('checking a lost Run shows where its evidence is, and the choice goes to the Runtime with the note', async t => {
  const data = fixtureData();
  const lost = { id: 'task-lost', workflowId: WF, formal: true, project: '/w/晨光头像', projectName: '晨光头像', stage: 'recolor',
    status: 'RECOVERY_REQUIRED', goal: '阶段 recolor', updatedAt: null, needsYou: true };
  data['task.list'] = [lost];
  data['gate.list'] = [];
  data['task.show'] = { ...lost, allowedWrites: [], expectedOutputs: [], next: '阶段 recolor 需要核对上次执行（avh task recover）',
    runs: [{ id: 'run-9', attempt: 1, provider: 'tool', status: 'running', directory: '/h/runs/run-9' }],
    verdicts: [], outOfBounds: [], events: [] };
  data['task.recover'] = { message: 'ok' };
  const ui = mount(t, 100, 30, data);
  await ui.settle();
  assert.match(ui.stdout.last(), /需核对上次执行 +晨光头像/, 'the state word does not run into the project name');
  await ui.press(KEY.enter);
  assert.match(ui.stdout.last(), /运行目录：\/h\/runs\/run-9/);
  await ui.press('v');
  assert.match(ui.stdout.last(), /核对上次执行[\s\S]*运行目录：\/h\/runs\/run-9/);
  await ui.press('r', '日志无异常，产物齐全', KEY.enter);
  await ui.settle();
  assert.deepEqual(ui.api.calls.find(call => call.method === 'task.recover')!.params,
    { id: 'task-lost', mode: 'reconciled', note: '日志无异常，产物齐全' });
});

test('inputWindow keeps the cursor in view and marks cut text on either side', () => {
  const chars = [...'abcdefghij'];
  assert.deepEqual(inputWindow(chars, 10, 20), { text: 'abcdefghij', cursorX: 10 });
  // At the end one column is left for the cursor; elsewhere the character under the cursor stays in view.
  assert.deepEqual(inputWindow(chars, 10, 6), { text: '…ghij', cursorX: 5 });
  assert.deepEqual(inputWindow(chars, 0, 6), { text: 'abcde…', cursorX: 0 });
  assert.deepEqual(inputWindow(chars, 5, 6), { text: '…cdef…', cursorX: 4 });
  // Chinese characters are two columns wide: the window counts columns, not characters.
  const wide = [...'中文输入法测试'];
  const end = inputWindow(wide, wide.length, 9);
  assert.equal(end.text, '…法测试');
  assert.ok(end.cursorX <= 8 && stringWidth(end.text) <= 8);
});

test('projects, a Workflow with its stages and evidence, the plan, and back with Esc', async t => {
  const ui = mount(t);
  await ui.settle();
  await ui.press('2');
  assert.match(ui.stdout.last(), /晨光头像/);
  await ui.press(KEY.enter);
  let frame = ui.stdout.last();
  // The four states are the sentence's tense, not a badge: this page says which question it is answering,
  // with the same reading the GUI derives (src/shared/projection.ts).
  assert.match(frame, /需要你做什么\s+需要你决定：批准制作方案/);
  assert.match(frame, /项目目标：两套服装互斥切换/);
  assert.match(frame, /!\s+确认制作方案/, 'the overview exposes the decision without presenting technical state first');
  await ui.press('t');
  frame = ui.stdout.last();
  assert.match(frame, /下一步：需要你决定：plan_approval/, 'the technical view keeps the Runtime sentence as it is');
  assert.match(frame, /! 确认制作方案\s+待你决定/, 'a stage waiting only for a decision is not shown as failed');
  await ui.press(KEY.down);
  frame = ui.stdout.last();
  assert.match(frame, /make/);
  assert.match(frame, /不符合 .*scene_items/);
  assert.match(frame, /通过·已失效/, 'evidence for an older version is shown as no longer current');
  await ui.press('p');
  // The plan screen leads with what the approval covers, derived by the same shared projection the GUI uses.
  // A layer target and a material target are named here, not only once `t` shows the file itself.
  assert.match(ui.stdout.last(), /这个方案要做什么/);
  assert.match(ui.stdout.last(), /改色：头发（色相 -20°）；作者分层「Trim」 → #FAF3EE → 该区域整体换成这个颜色/, ui.stdout.last());
  assert.match(ui.stdout.last(), /要求 dress_body_tier2：服装「礼服」的对应槽位换成「Dress_Body\.mat」/, ui.stdout.last());
  assert.match(ui.stdout.last(), /文件与位置（技术详情）[\s\S]*Milfy_v1\.5\.0\/PSD\/Costume_default\.psd/, ui.stdout.last());
  assert.doesNotMatch(ui.stdout.last(), /body_prefab:/, 'the raw plan file is not the default view');
  await ui.press('t');
  assert.match(ui.stdout.last(), /技术详情：方案文件原文/);
  assert.match(ui.stdout.last(), /body_prefab:/, 'the file itself is one key away');
  await ui.press('t');
  assert.match(ui.stdout.last(), /这个方案要做什么/, 'the user view comes back');
  await ui.press(KEY.escape);
  await ui.settle();
  assert.match(ui.stdout.last(), /需要你做什么/);
});

test('a task shows why it stopped; redoing a failed check asks for an optional note', async t => {
  const ui = mount(t);
  await ui.settle();
  await ui.press(KEY.down, KEY.enter);
  assert.match(ui.stdout.last(), /下一步：阶段 make 检查未通过/);
  assert.match(ui.stdout.last(), /不符合  scene_items \[edit\]/);
  await ui.press('d');
  assert.match(ui.stdout.last(), /修改意见（会交给执行方，可空）：/);
  await ui.press(KEY.enter);
  await ui.settle();
  assert.deepEqual(ui.api.calls.find(call => call.method === 'task.redo')!.params, { id: 'task-make' });
});

test('a change from the Runtime refreshes what is on screen; a lost connection says so', async t => {
  const ui = mount(t);
  await ui.settle();
  const before = ui.api.count('gate.list');
  ui.api.emit({ event: 'changed', seq: 10 });
  await delay(400);
  assert.ok(ui.api.count('gate.list') > before, 'data was fetched again');
  ui.api.drop();
  await ui.settle();
  assert.match(ui.stdout.last(), /✗ 未连接 Runtime 服务/);
  assert.match(ui.stdout.last(), /连接已断开，正在重连/);
});

test('leaving the interface is separate from stopping work: q asks, and can pause scheduling first', async t => {
  const ui = mount(t);
  await ui.settle();
  await ui.press('q');
  assert.match(ui.stdout.last(), /退出界面？/);
  assert.match(ui.stdout.last(), /后台服务会继续推进任务/);
  await ui.press('p');
  assert.equal(ui.exited(), true);
});

test('Ctrl+K opens the command menu; typing filters it', async t => {
  const ui = mount(t);
  await ui.settle();
  await ui.press(KEY.ctrlK);
  assert.match(ui.stdout.last(), /命令：/);
  await ui.press('暂停');
  assert.match(ui.stdout.last(), /暂停调度（本轮结束后）/);
  assert.doesNotMatch(ui.stdout.last(), /打开 执行方/);
  await ui.press(KEY.enter);
  await ui.settle();
  assert.equal(ui.api.count('service.pause'), 1);
});

test('at 80×24 every screen fits: no line wider than the terminal, no more lines than rows', async t => {
  const ui = mount(t, 80, 24);
  for (const keys of [[], ['2'], [KEY.enter], [KEY.down], ['p'], [KEY.escape, KEY.escape, '3'], ['4'], ['5'], ['?']]) {
    await ui.press(...keys);
    await ui.settle();
    const lines = ui.stdout.last().split('\n');
    assert.ok(lines.length <= 24, `${lines.length} lines after ${JSON.stringify(keys)}`);
    for (const line of lines) assert.ok(stringWidth(line) <= 80, `too wide (${stringWidth(line)}): ${line}`);
  }
});

test('the setup wizard finds process profiles and builds its config document from them', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-'));
  t.after(() => removeTemp(root));
  mkdirSync(join(root, 'process'));
  for (const name of ['a.process.yaml', 'a.capabilities.yaml', 'b.process.yaml', 'thresholds.yaml']) writeFileSync(join(root, 'process', name), '');
  const found = findProfiles(root);
  assert.deepEqual(found.profiles, [{ id: 'a', definition: 'process/a.process.yaml', capabilities: 'process/a.capabilities.yaml' },
    { id: 'b', definition: 'process/b.process.yaml' }]);
  const config = configDocument({ workspaceRoot: '/w', knowledgeRoot: root, toolRoot: '/t', exportRoot: '/e', profiles: found.profiles,
    thresholds: found.thresholds!, defaultProfile: 'a', codex: false, claude: true });
  // A subscription CLI keeps its analysis roles but never the executor role (decisions D-34 and D-8).
  assert.deepEqual((config.providers as Array<{ roles: string[] }>)[0]!.roles, ['diagnostician', 'research']);
  assert.deepEqual(config.processDefinitions, { a: { definition: 'process/a.process.yaml', capabilities: 'process/a.capabilities.yaml' },
    b: 'process/b.process.yaml' });
  assert.deepEqual((config.providers as Array<{ id: string }>).map(provider => provider.id), ['claude']);
  assert.equal(config.contributorName, undefined, 'no name, no field');
  assert.equal(config.unity, undefined, 'no editor, no unity section');
  const withUnity = configDocument({ workspaceRoot: '/w', knowledgeRoot: root, toolRoot: '/t', exportRoot: '/e', profiles: found.profiles,
    thresholds: found.thresholds!, defaultProfile: 'a', codex: true, claude: false,
    unity: { editor: '/opt/unity/Editor/Unity', lockPath: '/h/state/unity-batch.lock' } });
  assert.deepEqual(withUnity.unity, { editor: '/opt/unity/Editor/Unity', lockPath: '/h/state/unity-batch.lock',
    homeSeedFrom: ['.config/unity3d/Unity/licenses', '.local/share/unity3d/Unity/Unity_lic.ulf'],
    passEnv: ['DISPLAY', 'WAYLAND_DISPLAY', 'PATH', 'LANG', 'XDG_RUNTIME_DIR'] });
  const named = configDocument({ workspaceRoot: '/w', knowledgeRoot: root, toolRoot: '/t', exportRoot: '/e', profiles: found.profiles,
    thresholds: found.thresholds!, defaultProfile: 'a', codex: true, claude: false, contributorName: ' 喵 ' });
  assert.equal(named.contributorName, '喵');
  assert.throws(() => configDocument({ workspaceRoot: '/w', knowledgeRoot: root, toolRoot: '/t', exportRoot: '/e', profiles: found.profiles,
    thresholds: found.thresholds!, defaultProfile: 'a', codex: true, claude: false, contributorName: 'x'.repeat(65) }), /最多 64 个字符/);
});

test('what the setup wizard writes is a configuration the Runtime loads, Unity and contributor included', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-wizard-config-')); t.after(() => removeTemp(root));
  const home = join(root, 'home'), workspaceRoot = join(root, 'workspace'), exportRoot = join(root, 'exports');
  const editor = join(root, 'Editor', 'Unity');
  for (const dir of [join(home, 'config'), join(home, 'materialized', 'assets'), workspaceRoot, exportRoot, join(root, 'Editor')]) mkdirSync(dir, { recursive: true });
  writeFileSync(editor, '#!/bin/sh\n'); chmodSync(editor, 0o755);
  const managed = installBundledPack(home), found = findProfiles(managed.knowledgeRoot);
  const document = configDocument({ workspaceRoot, exportRoot, knowledgeRoot: managed.knowledgeRoot, toolRoot: managed.toolRoot,
    profiles: found.profiles, thresholds: found.thresholds!, defaultProfile: 'pc-recolor-outfit', codex: true, claude: false,
    assetLibraryRoot: join(home, 'materialized', 'assets'), contributorName: '喵',
    unity: { editor, lockPath: join(home, 'state', 'unity-batch.lock') },
    pi: [{ upstream: 'deepseek' }, { upstream: 'zhipu' }] });
  writeFileSync(join(home, 'config', 'harness.yaml'), stringify(document));
  const config = loadConfig(home);
  assert.equal(config.unity?.editor, editor);
  assert.equal(config.workflowVariables.assetLibrary, join(home, 'materialized', 'assets'));
  assert.equal(config.contributorName, '喵');
  assert.ok(config.capabilities['pc-recolor-outfit'], 'the built-in process loads with its capability manifest');
  assert.deepEqual(config.providers.map(provider => [provider.id, provider.adapter, provider.upstream ?? null, provider.secret ?? null]),
    [['codex', 'codex-cli', null, null], ['deepseek', 'pi-cli', 'deepseek', 'pi-deepseek'], ['glm', 'pi-cli', 'zhipu', 'pi-zhipu']]);
  // Every stage role of the built-in process is one a first-run pi Provider takes.
  const roles = new Set(Object.values(config.capabilities['pc-recolor-outfit']!.stages).filter(stage => stage.mode === 'provider')
    .map(stage => stage.role ?? 'executor'));
  for (const role of roles) assert.ok(config.providers[1]!.roles.includes(role as never), role);
});

test('the interface reaches the Runtime only through the local API: no value import of state, scheduler or runtime modules', () => {
  const root = fileURLToPath(new URL('../../src/tui/', import.meta.url));
  const files = (function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name))
      : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
  })(root);
  const forbidden = /^\.\.\/(\.\.\/)?(state|runtime|exec|providers|import|process)\/|^\.\.\/(\.\.\/)?(task-cli|cli|config|knowledge-cli)\.ts$|^\.\.\/(\.\.\/)?api\/(server|read-model)\.ts$|^\.\.\/(\.\.\/)?workflow\//;
  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^import\s+(type\s+)?[^'"]*from\s+'([^']+)'/gm))
      if (!match[1] && forbidden.test(match[2]!)) offenders.push(`${relative(root, file)}: ${match[2]}`);
    for (const match of source.matchAll(/import\(\s*'([^']+)'\s*\)/g))
      if (forbidden.test(match[1]!)) offenders.push(`${relative(root, file)}: import(${match[1]})`);
  }
  assert.deepEqual(offenders, []);
});
