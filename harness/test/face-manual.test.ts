import { WindowsRunSupervisor } from '../src/exec/windows-supervisor.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/state/db.ts';
import { createProject, createWorkflow, workflowSnapshot, formalGates, decideFormalGate } from '../src/workflow/runtime.ts';
import { RuntimeService } from '../src/api/server.ts';
import { ApiClient } from '../src/api/client.ts';
import { serveOnce, TaskRouter } from '../src/task-cli.ts';
import {productionHead} from '../src/production-face-continuation.ts';
import {loadProcess} from '../src/process/load.ts';
import {loadCapabilities} from '../src/workflow/capabilities.ts';
import { activateFaceInput, resolveWorkflowInput } from '../src/workflow/inputs.ts';
import { manualFaceInputForDispatch } from '../src/face-manual.ts';
import { artifactFingerprint } from '../src/workflow/artifacts.ts';
import { deflateSync } from 'node:zlib';
import { createRunSupervisor } from '../src/exec/run-supervisor.ts';
import { removeTemp, fakeCommand, FAKE_PROVIDER } from './fixtures/platform.ts';
import { waitFor } from './fixtures/wait.ts';

const tools = fileURLToPath(new URL('../builtin/tools/', import.meta.url));
const knowledge = fileURLToPath(new URL('../builtin/knowledge/', import.meta.url));
const blender = process.env.AVH_TEST_BLENDER ?? (process.platform === 'win32' ? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' : '/usr/bin/blender');
const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
type Json = Record<string, any>;

async function fixture(t: test.TestContext) {
  const beforeCleanup:Array<()=>Promise<void>>=[];
  const root = mkdtempSync(join(tmpdir(), 'avh-manual-face-')), home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(join(home, 'config'), { recursive: true }); mkdirSync(join(home, 'state')); mkdirSync(workspace); mkdirSync(join(root, 'exports'));
  writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: workspace, toolRoot: tools, knowledgeRoot: knowledge,
    exportRoots: [join(root, 'exports')], knownBodies: [], projectAliases: {}, sampleNames: [], providers: [],
    processDefinitions: { 'pc-recolor-outfit': { definition: 'process/pc-recolor-outfit.process.yaml', capabilities: 'process/pc-recolor-outfit.capabilities.yaml' } },
    defaultProfile: 'pc-recolor-outfit', thresholdsFile: 'process/thresholds.yaml',
    // This placeholder is never launched: these tests cancel before the face Unity phase.
    unity: { editor: process.execPath }, scanLimits: { gitOutputBytes: 268435456, hashBytes: 268435456 } }));
  const config = loadConfig(home), project = createProject(config, 'source'), db = openDatabase(config.stateDbPath);
  db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('workspace', workspace);
  db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('source','workspace','sample',?,'{}','active','fixture','fixture')").run(project);
  for (const path of ['Assets/Source', '_harness/face', '_harness/setup']) mkdirSync(join(project, path), { recursive: true });
  const script = join(root, 'seed.py'); writeFileSync(script, `import bpy,sys\nfrom pathlib import Path\nbpy.ops.wm.read_factory_settings(use_empty=True)\nroot=Path(sys.argv[-1])\nmesh=bpy.data.meshes.new('Face');mesh.from_pydata([(-.02,0,-.003),(-.02,0,.003),(.02,0,.003),(.02,0,-.003)],[],[(0,1,2,3)]);mesh.update()\nobj=bpy.data.objects.new('Face',mesh);bpy.context.collection.objects.link(obj);bpy.context.view_layer.objects.active=obj;obj.select_set(True)\nmesh.materials.append(bpy.data.materials.new('Skin'));uv=mesh.uv_layers.new(name='UV')\nfor loop in mesh.loops:uv.data[loop.index].uv=(mesh.vertices[loop.vertex_index].co.x,mesh.vertices[loop.vertex_index].co.z)\nobj.shape_key_add(name='Basis');key=obj.shape_key_add(name='Contour');obj.shape_key_add(name='Runtime')\nfor v in key.data:v.co.x+=.002 if v.co.x>0 else -.002\nbpy.ops.export_scene.fbx(filepath=str(root/'Assets/Source/source.fbx'),use_selection=True,object_types={'MESH'},bake_anim=False,use_mesh_modifiers=False)\n`);
  execFileSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '2', '--python', script, '--', project], { windowsHide: true, timeout: 90000, stdio: 'pipe' });
  writeFileSync(join(project, 'Assets/Source/avatar.prefab'), 'fixture prefab for Blender handoff only');
  const identity = (path: string) => {
    writeFileSync(join(project, path + '.meta'), 'fixture metadata'); return { path, sha256: hash(join(project, path)), metaSha256: hash(join(project, path + '.meta')) };
  };
  const prefab = identity('Assets/Source/avatar.prefab'), mesh = identity('Assets/Source/source.fbx'), targetId = 'a'.repeat(64);
  writeFileSync(join(project, '_harness/face/observation.json'), JSON.stringify({ schema: 'face-unity-observation/0.1', sourcePrefab: prefab, dependencies: [mesh], targets: [{
    targetId, rendererPath: 'Face', rendererIndex: 0, mesh, meshSnapshot: { name: 'Face', vertices: [[], [], [], []], keys: ['Contour', 'Runtime'].map(name => ({ name, frames: [{ weight: 100 }] })) },
    protectedKeys: ['Runtime'], defaultWeights: { Contour: 0, Runtime: 0 }, writers: [{ key: 'Runtime', kind: 'animation' }], unmeasuredWriters: [] }] }));
  writeFileSync(join(project, '_harness/setup/imported.txt'), 'Assets/Source/source.fbx\nAssets/Source/source.fbx.meta\nAssets/Source/avatar.prefab\nAssets/Source/avatar.prefab.meta\n');
  const service = new RuntimeService({ home, scheduler: false, pollMs: 50 }); let api: ApiClient;
  t.after(async () => { try {for(const cleanup of beforeCleanup)await cleanup();}finally {for(const row of db.prepare('SELECT gui_ref FROM face_manual_session WHERE gui_ref IS NOT NULL').all())await createRunSupervisor(join(home,'runs')).stop(String(row.gui_ref));api?.close(); await service.stop(); db.close(); if (!process.env.AVH_MANUAL_KEEP_PROJECT) removeTemp(root);} });
  await service.start(); api = await ApiClient.connect(home);
  const state = () => api.call<Json>('project.face.manual.state', { projectId: 'source' });
  const ready = async () => {
    for (let i = 0; i < 160; i++) {
      await serveOnce(db, config); const current = await state();
      if (['editing','opened'].includes(current.current?.status)) return current;
      if (current.current?.status === 'warning') {
        const runs = db.prepare('SELECT r.id,r.result_json FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=? ORDER BY r.rowid DESC').all(current.current.workflowId);
        const evidence = runs.map(run => ({ ...run, stderr: existsSync(join(home, 'runs', String(run.id), 'stderr.log')) ? readFileSync(join(home, 'runs', String(run.id), 'stderr.log'), 'utf8') : '',
          events: db.prepare('SELECT action,reason,payload_json FROM event WHERE workflow_id=? ORDER BY seq DESC LIMIT 8').all(current.current.workflowId) }));
        assert.fail(JSON.stringify(evidence));
      }
      await delay(100);
    }
    assert.fail('Actual managed Blender handoff did not finish');
  };
  return { root, home, config, project, db, api, state, ready, targetId, beforeCleanup:(cleanup:()=>Promise<void>)=>beforeCleanup.push(cleanup) };
}

test('manual copy preparation is observable and cancellable before a workflow exists, then resumes through the formal API', { skip: !existsSync(blender), timeout: 120000 }, async t => {
  const f = await fixture(t), source = join(f.project, 'Assets/CopyFixture'); mkdirSync(source);
  for (let i = 0; i < 600; i++) writeFileSync(join(source, i + '.txt'), Buffer.alloc(1024, 65));
  f.db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('prior-preserve','source','fixture','fixture','fixture','cancelled',?)").run('{"face":{"mode":"preserve"}}');
  assert.equal((await f.state()).mode, 'preserve');
  const opening = f.api.call<Json>('project.face.manual.open', { projectId: 'source', expectedRevision: 0 });
  const current = await waitFor(async () => (await f.state()).current,
    { what: 'the manual face session to become visible through the API', timeoutMs: 30_000, intervalMs: 10 });
  assert.equal(current.status, 'preparing'); assert.equal(current.workflowId, '', 'API must yield while the actual project copy is incomplete');
  assert.equal((await f.state()).mode, 'preserve', 'opening Blender must retain the existing preserve choice');
  const cancelled = await f.api.call('project.face.manual.cancel', { projectId: 'source', sessionId: current.id });
  assert.deepEqual(cancelled, { confirmed: true }); await opening;
  assert.equal((await f.state()).current.status, 'cancelled');
  assert.equal(f.db.prepare('SELECT workflow_id FROM face_manual_session WHERE id=?').get(current.id)!.workflow_id, null);
  const resumed = await f.api.call<Json>('project.face.manual.resume', { projectId: 'source', sessionId: current.id });
  assert.equal(resumed.current.id, current.id); assert.ok(resumed.current.workflowId);
  const projects = await f.api.call<Json[]>('project.list');
  const label = projects.find(project => project.path === resumed.current.projectPath)!.name;
  assert.match(label, /手动脸型草稿/); assert.ok(!label.includes(current.id));
  assert.equal(readdirSync(join(resumed.current.projectPath, 'Assets/CopyFixture')).length, 600);
  assert.equal((await f.ready()).current.status, 'editing');
});

test('formal manual API freezes a real saved input, cancels safely, resumes through the same entry and switches back without AI', { skip: !existsSync(blender), timeout: 180000 }, async t => {
  const f = await fixture(t), original = hash(join(f.project, 'Assets/Source/source.fbx'));
  let state = await f.api.call<Json>('project.face.mode', { projectId: 'source', mode: 'manual', expectedRevision: 0 });
  assert.equal(state.mode, 'manual');
  f.db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('policy','source','pc-recolor-outfit','fixture','fixture','cancelled',?)").run('{"face":{"mode":"design"}}');
  activateFaceInput(f.db, 'policy', { activationId: 'manual-draft-preserve', mode: 'preserve' });
  assert.equal(resolveWorkflowInput(f.db, 'policy').plan.face.mode, 'preserve', 'production must not wait for an unaccepted manual draft');
  await f.api.call('project.face.manual.open', { projectId: 'source', expectedRevision: state.revision });
  state = await f.ready(); const current = state.current;
  const snapshot = workflowSnapshot(f.db, current.workflowId);
  assert.ok(Object.values(snapshot.capabilities.stages).every(stage => stage.mode === 'tool'));
  const saved = join(f.root, 'user-save.py'); writeFileSync(saved, "import bpy,sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[-1],use_scripts=False)\nbpy.data.objects['Face'].data.shape_keys.key_blocks['Contour'].value=.25\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])\n");
  execFileSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python', saved, '--', current.blendPath], { windowsHide: true, timeout: 90000, stdio: 'pipe' });
  state = await f.api.call<Json>('project.face.manual.done', { projectId: 'source', sessionId: current.id, expectedRevision: state.revision });
  assert.equal(state.current.status, 'processing'); assert.equal(state.versions.length, 0);
  const frozen = manualFaceInputForDispatch(f.db, state.current.workflowId)!;
  assert.equal(frozen.AVH_MANUAL_FACE_SUBMITTED_SHA256, hash(join(state.current.projectPath, '_harness/manual-face/submitted.blend')));
  assert.notEqual(state.current.workflowId, current.workflowId, 'submitted input starts a new deterministic production workflow');
  const commands = Object.values(workflowSnapshot(f.db, state.current.workflowId).capabilities.stages);
  assert.ok(commands.every(stage => stage.mode === 'tool')); assert.ok(commands.find(stage => stage.command?.includes('manual-execute'))?.unitySteps?.some(step => step.method === 'AVH.Harness.FacePreviewStage.Render'));
  assert.deepEqual(await f.api.call('project.face.manual.cancel', { projectId: 'source', sessionId: current.id }), { confirmed: true });
  state = await f.api.call<Json>('project.face.manual.resume', { projectId: 'source', sessionId: current.id });
  assert.equal(state.current.status, 'processing'); assert.equal(manualFaceInputForDispatch(f.db, state.current.workflowId)?.AVH_MANUAL_FACE_SUBMITTED_SHA256, frozen.AVH_MANUAL_FACE_SUBMITTED_SHA256);
  state = await f.api.call<Json>('project.face.manual.open', { projectId: 'source', expectedRevision: state.revision });
  state = await f.ready();
  assert.equal(state.current.id, current.id, 'opening an interrupted draft must retain its saved authoring session');
  assert.equal(hash(state.current.blendPath), frozen.AVH_MANUAL_FACE_SUBMITTED_SHA256);
  state = await f.api.call<Json>('project.face.manual.done', { projectId: 'source', sessionId: current.id, expectedRevision: state.revision });
  assert.equal(manualFaceInputForDispatch(f.db, state.current.workflowId)?.AVH_MANUAL_FACE_SUBMITTED_SHA256, frozen.AVH_MANUAL_FACE_SUBMITTED_SHA256);
  assert.ok(existsSync(join(state.current.projectPath, '_harness/manual-face/submitted-prior-' + frozen.AVH_MANUAL_FACE_SUBMITTED_SHA256 + '.blend')));
  state = await f.api.call<Json>('project.face.mode', { projectId: 'source', mode: 'ai', expectedRevision: state.revision });
  assert.equal(state.current.status, 'cancelled');
  activateFaceInput(f.db, 'policy', { activationId: 'ai', mode: 'design' });
  assert.equal(resolveWorkflowInput(f.db, 'policy').plan.face.mode, 'design');
  assert.equal(resolveWorkflowInput(f.db, 'policy').plan.face.mode, 'design', 'switching back to AI must override an earlier preserve plan');
  state = await f.api.call<Json>('project.face.mode', { projectId: 'source', mode: 'preserve', expectedRevision: state.revision });
  activateFaceInput(f.db, 'policy', { activationId: 'preserve', mode: 'preserve' });
  assert.equal(resolveWorkflowInput(f.db, 'policy').plan.face.mode, 'preserve');
  assert.equal(hash(join(f.project, 'Assets/Source/source.fbx')), original);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM event WHERE action='provider_selected' AND json_extract(payload_json,'$.manifest.provider_snapshot.provider_id') != 'tool'").get()!.n, 0);
  await assert.rejects(f.api.call('project.face.mode', { projectId: 'source', mode: 'ai', expectedRevision: 0 }), /已变化/);
});

test('formal handoff cancellation keeps a recoverable entry; altered baseline cannot authorize a saved draft', { skip: !existsSync(blender), timeout: 180000 }, async t => {
  const f = await fixture(t); let state = await f.state();
  state = await f.api.call<Json>('project.face.manual.open', { projectId: 'source', expectedRevision: state.revision });
  await serveOnce(f.db, f.config);
  assert.ok(f.db.prepare("SELECT 1 FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=? AND r.status='running'").get(state.current.workflowId), 'interrupt an actual supervised background operation');
  await f.api.call('project.face.manual.cancel', { projectId: 'source', sessionId: state.current.id });
  state = await f.api.call<Json>('project.face.manual.resume', { projectId: 'source', sessionId: state.current.id });
  state = await f.ready();
  const baseline = join(state.current.projectPath, '_harness/manual-face/baseline.json'), old = JSON.parse(readFileSync(baseline, 'utf8'));
  writeFileSync(baseline, JSON.stringify({ ...old, signature: '0'.repeat(64) }));
  await assert.rejects(f.api.call('project.face.manual.done', { projectId: 'source', sessionId: state.current.id, expectedRevision: state.revision }), /交接证据.*变化|交接基线被改动/);
  assert.equal(existsSync(join(state.current.projectPath, '_harness/manual-face/submitted.blend')), false);
  assert.deepEqual(await f.api.call('project.face.manual.cancel', { projectId: 'source', sessionId: state.current.id }), { confirmed: true });
});

// Explicit synthetic Unity output fixtures test the shared human Gate consumer.
// Actual original-avatar Unity renders are a separate Windows acceptance exercise.
function previewFixture(f: Awaited<ReturnType<typeof fixture>>, state: Json) {
  const root = state.current.projectPath, workflowId = state.current.workflowId;
  const put = (path: string, value: string | Buffer) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), value); return { path, sha256: hash(join(root, path)) }; };
  const crc = (bytes: Buffer) => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let j = 0; j < 8; j++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, bytes: Buffer) => { const b = Buffer.alloc(bytes.length + 12); b.writeUInt32BE(bytes.length); b.write(type, 4); bytes.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, -4)), b.length - 4); return b; };
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((128 * 3 + 1) * 128); for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) pixels[y * (128 * 3 + 1) + 1 + x * 3] = x ^ y;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
  const source = { path: 'Assets/Source/avatar.prefab', sha256: hash(join(root, 'Assets/Source/avatar.prefab')) }, candidate = put('Assets/_Harness/Face/Generated/Avatar.prefab', 'synthetic Unity output');
  const mesh = put('Assets/_Harness/Face/Generated/FaceMesh.asset', 'synthetic Unity mesh');
  const observation = { path: '_harness/face/observation.json', sha256: hash(join(root, '_harness/face/observation.json')) };
  const refs = Object.fromEntries(['blenderCatalog', 'blenderDesign', 'candidateReceipt'].map(key => { const ref = put('Assets/_Harness/Face/' + key + '.json', '{}'); return [key, { file: ref.path, sha256: ref.sha256 }]; }));
  const input = put('Assets/_Harness/Face/design.json', JSON.stringify({ schema: 'face-unity-design/0.1', mode: 'design', observationSha256: observation.sha256, ...refs }));
  const output = put('_harness/face/output.json', JSON.stringify({ schema: 'face-unity-output/0.1', mode: 'design', sourcePrefab: source.path, avatar: candidate.path, inputSha256: input.sha256, observationSha256: observation.sha256, productionAccepted: false }));
  const images = ['before-front', 'after-front', 'before-side', 'after-side'].map(id => { const [version, view] = id.split('-'); return { ...put('_harness/face/preview/render/' + id + '.png', png), id, version, view, width: 128, height: 128 }; });
  const dependencies = [source, candidate, mesh, ...JSON.parse(readFileSync(join(root, observation.path), 'utf8')).dependencies];
  for (const ref of [...dependencies]) if (existsSync(join(root, ref.path + '.meta'))) dependencies.push({ path: ref.path + '.meta', sha256: hash(join(root, ref.path + '.meta')) });
  const manifest = put('_harness/face/preview/manifest.json', JSON.stringify({ schema: 'face-preview/0.1', productionAccepted: false, bindings: { input, output, observation, source, candidate }, dependencies, protocol: { camera: 'orthographic', pose: 'prefab-defaults', views: ['front', 'side'], center: [0, 1, 0], orthographicSize: 1 }, images }));
  const snapshot = workflowSnapshot(f.db, workflowId), hashes: Record<string, string> = {};
  for (const [kind, artifact] of Object.entries(snapshot.capabilities.artifacts)) {
    hashes[kind] = artifactFingerprint(root, artifact)!;
    f.db.prepare('INSERT INTO artifact_version(workflow_id,kind,hash) VALUES(?,?,?)').run(workflowId, kind, hashes[kind]);
  }
  for (const check of snapshot.definition.checks) f.db.prepare('INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result,basis) VALUES(?,?,?,?,?,\'pass\',\'explicit synthetic Unity consumer fixture\')')
    .run(workflowId + check.id, workflowId, check.id, check.scope, hashes[check.on!]);
  f.db.prepare("INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json) VALUES(?,'manual_handoff',?)").run(workflowId, JSON.stringify(hashes));
  const task = workflowId + '-render', run = workflowId + '-render-run';
  f.db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES(?,?,'face','synthetic Unity consumer fixture','tool','WAITING_HUMAN')").run(task, workflowId);
  f.db.prepare("INSERT INTO run(id,task_id,attempt,status,result_json) VALUES(?,?,1,'exited',?)").run(run, task, JSON.stringify({ exitStatus: 0, outputs: { [manifest.path]: manifest.sha256 }, unitySteps: [{ method: 'AVH.Harness.FacePreviewStage.Render', exitCode: 0 }] }));
  f.db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES(?,'runtime','run',?,'unity_unit_intended','explicit synthetic consumer fixture')").run(workflowId, run);
  return { manifest, faceHash: hashes.face };
}

test('saved values reach the formal accept API, create immutable versions and roll back while production uses only the accepted input', { skip: !existsSync(blender), timeout: 900000 }, async t => {
  const f = await fixture(t); let state = await f.state(); const ids: string[] = [];
  let browser:Awaited<ReturnType<typeof import('./fixtures/headless-browser.ts').headlessBrowser>>|undefined;
  if(process.env.AVH_GUI_IT==='1') {
    const {headlessBrowser,testBrowser}=await import('./fixtures/headless-browser.ts');assert.ok(testBrowser);
    const {runGui}=await import('../src/gui/server.ts'),controller=new AbortController();let ready!:(url:string)=>void;
    const address=new Promise<string>(resolve=>ready=resolve),gui=runGui(f.home,{open:false,signal:controller.signal,onReady:ready});void gui.catch(error=>{console.error(error);ready('');});
    const profile=mkdtempSync(join(tmpdir(),'avh-browser-continuation-'));f.beforeCleanup(async()=>{try{if(browser&&process.env.AVH_GUI_EVIDENCE_DIR)writeFileSync(join(process.env.AVH_GUI_EVIDENCE_DIR,'manual-request-trace.json'),JSON.stringify({requests:await browser.evaluate('window.__faceTrace'),sessions:f.db.prepare('SELECT id,state,gui_ref FROM face_manual_session').all(),events:f.db.prepare("SELECT actor,action,reason FROM event WHERE entity_type='face_manual' ORDER BY seq").all()},null,2));}finally{try{await browser?.close();}finally{controller.abort();await gui;removeTemp(profile);}}});
    browser=await headlessBrowser(profile);await browser.send('Page.navigate',{url:await address});await browser.waitFor("Boolean(document.querySelector('[data-nav=projects]'))");await browser.evaluate(`window.__faceTrace=[];const originalFetch=window.fetch;window.fetch=async(...args)=>{let request;try{request=JSON.parse(args[1]?.body)}catch{}const record=request?.method?.startsWith('project.face.')?{request,started:Date.now()}:null;if(record)window.__faceTrace.push(record);try{const response=await originalFetch(...args);if(record){record.status=response.status;record.response=await response.clone().json();record.ended=Date.now()}return response}catch(error){if(record)record.error=String(error);throw error}};`);assert.equal(await browser.evaluate('Array.isArray(window.__faceTrace)'),true);
    await browser.click('关闭回传','.dialog button');await browser.waitFor("!document.querySelector('.dialog-backdrop')");
    await browser.evaluate("document.querySelector('[data-nav=projects]').click()");await browser.click('source','.project-card');await browser.click('工作面');
  }
  const chain=['setup','face','package'],definition=loadProcess(stringify({schema:'process/0.1',id:'accept-parent',version:'1',applies_to:{},artifacts:['face_input',...chain],
    stages:chain.map((id,i)=>({id,needs:i?[chain[i-1]]:[],produces:[id],requires:[id+'_ok'],gates:[],invalidated_by:id==='setup'?[]:['face_input'],source:'fixture'})),
    checks:chain.map(id=>({id:id+'_ok',observe:id+'.read',on:id,scope:'edit',rule:'ok == true',severity:'blocking',maturity:'accepted',source:'fixture'})),
    gates:[{id:'delivery',kind:'approve',binds:'package',source:'fixture'}],milestones:[{id:'CLIENT_VERIFIED',requires_stages:'all',evidence_on:'package',gates:['delivery']}]}),{schema:'thresholds/0.1',version:'1',t:{}});
  // The observer runs inside the check sandbox. On Linux that sandbox gives /tmp a private tmpfs and binds back only
  // the project and the Run directory (exec/check-runner.ts:51-55), so a helper written under this fixture's temp root
  // is unreadable there: the check then dies with "Cannot find module '/tmp/avh-manual-face-*/parent-observer.mjs'",
  // the setup stage blocks on missing evidence, no package artifact is recorded, and the delivery gate never leaves
  // 'waiting'. An inline script needs no file the sandbox has to see, and is the pattern
  // test/production-face-unity.test.ts already uses on both platforms.
  const observer=[process.execPath,'-e',"require('fs').writeFileSync(process.argv[1],JSON.stringify({schema:'observation/0.1',metrics:{ok:true}}))"];
  const capabilities=loadCapabilities(stringify({schema:'capabilities/0.1',process:'accept-parent',version:'1',artifacts:{face_input:{source:{kind:'runtime',input:'face_input'}},...Object.fromEntries(chain.map(id=>[id,{paths:[`parent-${id}.json`]}]))},
    stages:Object.fromEntries(chain.map(id=>[id,{mode:'tool',command:[process.execPath,'{toolRoot}/harness/face.py'],allowedWrites:[`parent-${id}.json`]}])),
    observers:Object.fromEntries(chain.map(id=>[id+'.read',{command:[...observer,'{out}']}]))}),definition);
  const config={...f.config,definitions:{...f.config.definitions,'accept-parent':definition},capabilities:{...f.config.capabilities,'accept-parent':capabilities}};
  const parent=createWorkflow(f.db,config,f.project,'accept-parent');f.db.prepare('UPDATE workflow SET plan_json=? WHERE id=?').run('{"face":{"mode":"preserve"}}',parent);
  const starts=new Map<string,{path:string;stage:string;plan:Json;values:Json|null}>(),originalStart=TaskRouter.prototype.start,originalObserve=TaskRouter.prototype.observe,originalCollect=TaskRouter.prototype.collect;
  t.mock.method(TaskRouter.prototype,'start',function(this:TaskRouter,run:any){if(workflowSnapshot(this.db,this.row.workflow_id).profile!=='accept-parent')return originalStart.call(this,run);
    starts.set(run.runId,{path:this.row.project_path,stage:run.stageId,plan:run.inputSnapshot.plan,values:run.inputSnapshot.manualValues?JSON.parse(run.inputSnapshot.manualValues):null});
    return Promise.resolve({ref:'accept-parent:'+run.runId});});
  t.mock.method(TaskRouter.prototype,'observe',function(this:TaskRouter,handle:any){return handle.ref.startsWith('accept-parent:')?Promise.resolve({state:'exited' as const}):originalObserve.call(this,handle);});
  t.mock.method(TaskRouter.prototype,'collect',function(this:TaskRouter,handle:any){if(!handle.ref.startsWith('accept-parent:'))return originalCollect.call(this,handle);
    const item=starts.get(handle.ref.slice('accept-parent:'.length))!;writeFileSync(join(item.path,`parent-${item.stage}.json`),JSON.stringify({plan:item.plan,accepted:item.values}));return Promise.resolve({exitStatus:0,outputs:{}});});
  const deliver=async(expected:number|null,sessionId?:string)=>{let head='',gate:ReturnType<typeof formalGates>[number]|undefined;
    for(let i=0;i<12;i++){await serveOnce(f.db,config);head=productionHead(f.db,'source')!;gate=formalGates(f.db,head).find(g=>g.gate===`${head}:delivery`);if(gate?.status==='pending')break;}
    assert.ok(gate,JSON.stringify({head,tasks:f.db.prepare('SELECT stage_id,status FROM task WHERE workflow_id=?').all(head),events:f.db.prepare('SELECT action,reason FROM event ORDER BY seq DESC LIMIT 8').all()}));
    assert.equal(gate.status,'pending',JSON.stringify(f.db.prepare('SELECT state,error FROM production_continuation').all()));
    const project=String(f.db.prepare('SELECT p.path FROM workflow w JOIN project p ON p.id=w.project_id WHERE w.id=?').get(head)!.path),content=JSON.parse(readFileSync(join(project,'parent-package.json'),'utf8'));
    const contour=content.accepted?.values.Contour??null;if(expected===null)assert.equal(contour,null);else assert.ok(Math.abs(contour-expected)<1e-7,JSON.stringify(content.accepted));
    if(sessionId){assert.equal(content.plan.face.mode,'manual');assert.equal(content.plan.face.manualSessionId,sessionId);assert.deepEqual(content.accepted,JSON.parse(String(f.db.prepare('SELECT accepted_json FROM face_manual_session WHERE id=?').get(sessionId)!.accepted_json)));}
    await decideFormalGate(f.db,config,head,'delivery',true,'Accept fixture delivery with independently asserted immutable values',gate.artifactHash,undefined,undefined,gate.inputHashes);await serveOnce(f.db,config);
    assert.equal(f.db.prepare('SELECT status FROM workflow WHERE id=?').get(head)!.status,'client_verified');assert.ok(f.db.prepare('SELECT 1 FROM production_delivery WHERE workflow_id=?').get(head));return head;};
  await deliver(null);

  for (const value of [.1, .2]) {
    if(browser)await browser.click('在 Blender 中打开');else await f.api.call('project.face.manual.open', { projectId: 'source', expectedRevision: state.revision }); state = await f.ready();
    const script = join(f.root, 'edit-version.py'); writeFileSync(script, `import bpy,sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[-1],use_scripts=False)\nbpy.data.objects['Face'].data.shape_keys.key_blocks['Contour'].value=${value}\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])\n`);
    execFileSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python', script, '--', state.current.blendPath], { windowsHide: true, stdio: 'pipe', timeout: 90000 });
    if(browser){const sessionId=state.current.id,revision=state.revision;await browser.waitFor(`(()=>{const p=document.querySelector('.actions[data-face-session="${sessionId}"][data-face-revision="${revision}"]');const b=p&&[...p.querySelectorAll('button')].find(x=>x.textContent==='捏好了');return b&&!b.disabled})()`,300_000);
      await browser.click('捏好了');await browser.waitFor(`window.__faceTrace.some(x=>x.request.method==='project.face.manual.done'&&x.request.params.sessionId===${JSON.stringify(sessionId)}&&x.response)`,300_000);
      const trace=await browser.evaluate(`window.__faceTrace.filter(x=>x.request.method==='project.face.manual.done'&&x.request.params.sessionId===${JSON.stringify(sessionId)}).at(-1)`);assert.equal(trace.status,200,JSON.stringify(trace));assert.equal(trace.request.params.expectedRevision,revision);
      state=await f.state();assert.equal(state.current.status,'processing',JSON.stringify({state,trace}));}
    else state = await f.api.call<Json>('project.face.manual.done', { projectId: 'source', sessionId: state.current.id, expectedRevision: state.revision });
    const capability = workflowSnapshot(f.db, state.current.workflowId).capabilities.stages.face!;
    const command = capability.command!.map(arg => arg.replaceAll('{toolRoot}', f.config.toolRoot).replaceAll('{project}', state.current.projectPath));
    execFileSync(process.platform === 'win32' ? 'python' : 'python3', command.slice(1), { windowsHide: true, stdio: 'pipe', timeout: 120000, env: { ...process.env, ...manualFaceInputForDispatch(f.db, state.current.workflowId), AVH_BLENDER_BIN: blender } });
    const proof = previewFixture(f, state); state = await f.state(); assert.equal(state.current.status, 'awaiting', state.current.reason);
    const gates = await f.api.call<Json[]>('gate.list');
    const gate = gates.find(gate => gate.workflowId === state.current.workflowId && gate.review === 'face-output')!;
    assert.match(gate.projectName, /手动脸型草稿/); assert.ok(!gate.projectName.includes(state.current.id));
    const submittedSessionId=state.current.id;
    if(browser) {await browser.waitFor("(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='接受这个效果');return b&&!b.disabled})()");await browser.click('接受这个效果');await browser.waitFor(`(()=>{const p=document.querySelector('[aria-label="制作版本"]');return p&&[...p.querySelectorAll('p')].some(x=>x.textContent===${JSON.stringify(`当前要求：手动脸型版本 ${ids.length+1}`)})&&[...document.querySelectorAll('p[role="status"]')].some(x=>x.textContent==='已接受')})()`);}
    else await f.api.call('project.face.accept', { projectId: state.current.viewProjectId, workflowId: state.current.workflowId, expectedRevision: state.revision, expectedHash: proof.faceHash, previewSha256: proof.manifest.sha256 });
    state = await f.state(); assert.equal(state.current.status, 'accepted'); ids.push(state.current.id);
    assert.equal(state.current.id,submittedSessionId);assert.equal(state.production.requirement.manualSessionId,submittedSessionId);
    assert.equal(state.versions[0].version, ids.length); assert.equal(state.acceptedSessionId, state.current.id);
    assert.throws(() => f.db.prepare("UPDATE face_manual_session SET accepted_json='{}' WHERE id=?").run(state.current.id), /immutable/);
    await f.api.call('project.face.accept', { projectId: state.current.viewProjectId, workflowId: state.current.workflowId, expectedRevision: state.revision, expectedHash: proof.faceHash, previewSha256: proof.manifest.sha256 });
    assert.equal((await f.state()).versions.length, ids.length);
    await deliver(value,state.current.id);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM production_continuation WHERE activation_id=?").get('accepted:'+state.current.id)!.n,1);
  }
  if(browser){await browser.click('已接受的脸型版本');await browser.waitFor("(()=>{const p=[...document.querySelectorAll('details p')].find(x=>x.textContent.startsWith('脸型版本 1'));if(!p)return false;p.querySelector('button').click();return true})()");await browser.waitFor("document.querySelector('[aria-label=\"制作版本\"]').innerText.includes('当前要求：手动脸型版本 1')");state=await f.state();}
  else state = await f.api.call<Json>('project.face.manual.rollback', { projectId: 'source', sessionId: ids[0], expectedRevision: state.revision });
  assert.equal(state.acceptedSessionId, ids[0]); assert.equal(state.versions.length, 2);
  assert.equal(state.current.id, ids[0], 'rollback must show the actual earlier accepted preview');
  await deliver(.1,ids[0]);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_delivery').get()!.n,4);
  if(browser){await browser.waitFor("document.querySelector('[aria-label=\"制作版本\"] [role=\"status\"]').innerText==='当前要求的交付物已完成并接受。'",30_000);await browser.waitFor("document.body.innerText.includes('正在制作的版本：当前没有正在制作的版本')");await browser.click('最后接受的交付物与历史版本');await browser.click('查看交付文件');await browser.waitFor("document.body.innerText.includes('交付文件与接受时的内容一致')");if(process.env.AVH_GUI_EVIDENCE_DIR){const shot=await browser.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(process.env.AVH_GUI_EVIDENCE_DIR,'accept-replace-rollback.png'),Buffer.from(shot.data,'base64'));}}
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM production_continuation WHERE state='applied'").get()!.n,3);
  f.db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('adoption','source','pc-recolor-outfit','fixture','fixture','cancelled','{}')").run();
  activateFaceInput(f.db, 'adoption', { activationId: 'rollback', mode: 'manual', manualSessionId: ids[0] });
  assert.equal(resolveWorkflowInput(f.db, 'adoption').plan.face.manualSessionId, ids[0]);
});

test('formal scheduler never dispatches AI face design in manual mode while production continues without a draft', { skip: !existsSync(blender), timeout: 120000 }, async t => {
  const f = await fixture(t);
  const source = f.config.definitions[f.config.defaultProfile], caps = f.config.capabilities[f.config.defaultProfile];
  const stage = source.stages.find(stage => stage.id === 'face_design')!;
  const definition = { ...source, id: 'face-policy-fixture', artifacts: ['fbx','face_input'], stages: [{ ...stage, needs: [], produces: [], requires: [], gates: [], invalidated_by: ['face_input'] }], checks: [], gates: [], milestones: [] };
  const capabilities = { ...caps, process: 'face-policy-fixture', artifacts: { fbx: caps.artifacts.fbx!, face_input: caps.artifacts.face_input! }, stages: { face_design: caps.stages.face_design! }, observers: {} };
  const executable = fakeCommand(join(f.root, 'fake-policy-provider'), FAKE_PROVIDER);
  const config = { ...f.config, providers: [{ id: 'fake-policy-provider', adapter: 'codex-cli', executable, roles: ['executor'] }] as any,
    definitions: { ...f.config.definitions, 'face-policy-fixture': definition }, capabilities: { ...f.config.capabilities, 'face-policy-fixture': capabilities } };
  const workflow = createWorkflow(f.db, config, f.project, 'face-policy-fixture');
  f.db.prepare('UPDATE workflow SET plan_json=? WHERE id=?').run('{"face":{"mode":"design"}}', workflow);
  await f.api.call('project.face.mode', { projectId: 'source', mode: 'manual', expectedRevision: 0 });
  activateFaceInput(f.db, workflow, { activationId: 'manual-draft', mode: 'preserve' });
  await serveOnce(f.db, f.config); await serveOnce(f.db, f.config);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM task WHERE workflow_id=?').get(workflow)!.n, 0, 'manual choice must suppress the actual Provider dispatch path');
});

test('Windows opens the real managed Blender GUI and cancellation stops only its owned Job', { skip: process.platform !== 'win32' || !existsSync(blender), timeout: 90000 }, async t => {
  let ref: string | undefined; let supervisor: ReturnType<typeof createRunSupervisor> | undefined;
  t.after(async () => { if (ref) await supervisor!.stop(ref); });
  const f = await fixture(t); await f.api.call('project.face.manual.open', { projectId: 'source', expectedRevision: 0 }); const state = await f.ready();
  await f.api.call('project.face.manual.launch', { projectId: 'source', sessionId: state.current.id });
  const row = f.db.prepare('SELECT gui_ref FROM face_manual_session WHERE id=?').get(state.current.id)!;
  supervisor = createRunSupervisor(join(f.home, 'runs')); ref = String(row.gui_ref);
  assert.equal(supervisor.state(ref), 'running');
  assert.equal((await f.state()).current.status, 'opened');
  const submitting = f.api.call('project.face.manual.done', { projectId: 'source', sessionId: state.current.id, expectedRevision: state.revision }).then(() => true, () => false);
  assert.deepEqual(await f.api.call('project.face.manual.cancel', { projectId: 'source', sessionId: state.current.id }), { confirmed: true });
  await submitting;
  assert.equal((await f.state()).current.status, 'cancelled', 'a concurrent saved-input request cannot undo the cancellation');
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM workflow WHERE project_id=? AND status IN ('active','upload_ready')").get(state.current.viewProjectId)!.n, 0);
  assert.ok(['exited','not_found'].includes(supervisor.state(ref)));
});


test('a cancelled in-flight manual launch cannot publish a late GUI ref and duplicate launches share one managed start', {skip:process.platform!=='win32'||!existsSync(blender),timeout:180_000},async t=>{
  const f=await fixture(t);await f.api.call('project.face.manual.open',{projectId:'source',expectedRevision:0});const state=await f.ready();
  let release!:()=>void,started!:()=>void,starts=0;const entering=new Promise<void>(resolve=>started=resolve),held=new Promise<void>(resolve=>release=resolve);const stopped:string[]=[];
  t.mock.method(WindowsRunSupervisor.prototype,'launch',async()=>{starts++;started();await held;return 'fixture-delayed-gui';});
  t.mock.method(WindowsRunSupervisor.prototype,'stop',async(ref:string)=>{stopped.push(ref);return 'confirmed' as const;});
  const request={projectId:'source',sessionId:state.current.id};
  const first=f.api.call('project.face.manual.launch',request).then(()=>true,()=>false),second=f.api.call('project.face.manual.launch',request).then(()=>true,()=>false);
  await entering;
  const cancel=f.api.call('project.face.manual.cancel',request);for(let i=0;i<100&&f.db.prepare('SELECT state FROM face_manual_session WHERE id=?').get(state.current.id)!.state!=='stopping';i++)await delay(10);
  assert.equal(f.db.prepare('SELECT state FROM face_manual_session WHERE id=?').get(state.current.id)!.state,'stopping');release();
  assert.deepEqual(await Promise.all([first,second]),[false,false]);assert.deepEqual(await cancel,{confirmed:true});assert.equal(starts,1);assert.deepEqual(stopped,['fixture-delayed-gui']);
  const row=f.db.prepare('SELECT state,gui_ref FROM face_manual_session WHERE id=?').get(state.current.id)!;assert.equal(row.state,'cancelled');assert.equal(row.gui_ref,null);
});
