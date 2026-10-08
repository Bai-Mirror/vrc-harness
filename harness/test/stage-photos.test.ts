import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import { stringify } from 'yaml';
import { RuntimeService } from '../src/api/server.ts';
import { ApiClient } from '../src/api/client.ts';
import { openDatabase } from '../src/state/db.ts';
import { previewStatesForPlan } from '../src/runtime/scheduler.ts';
import { projectDeliveryPhotos, projectRecolorPreview, renderedImageDigest } from '../src/stage-photos.ts';
import { materialAxisConfig } from './fixtures/material-axis.ts';
import { removeTemp } from './fixtures/platform.ts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function crc(bytes: Buffer) { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function chunk(type: string, bytes: Buffer) { const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(type, 4); bytes.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, -4)), out.length - 4); return out; }
// Synthetic pixels exercise the PNG decoder only; these are never advertised as Unity renders.
function png(seed = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(128); header.writeUInt32BE(128, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((128 * 3 + 1) * 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) for (let c = 0; c < 3; c++)
    pixels[(y * (128 * 3 + 1)) + 1 + x * 3 + c] = (seed * 61 + c * 23 + (x ^ y)) & 255;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const CAMERA = { schema: 'camera-spec/0.1', projection: 'orthographic', width: 128, height: 128, ortho_size: 1.2,
  position: [0, 1, 5], rotation: [0, 0, 0], background: [0.235, 0.235, 0.255], lights: 'studio-2key-flat-ambient' };

const MATERIALS_HASH = 'a'.repeat(64), BUILD_HASH = 'b'.repeat(64);
const RECOLOR_RUN = 'recolor-run', REGRESSION_RUN = 'regression-run';
const PLAN = { schema: 'plan/0.2', body: 'Luna 素体（演示）', outfits: [{ id: 'kimono', label: '春樱和服' }, { id: 'yukata', label: '夏日浴衣' }],
  default_outfit: 'kimono', recolor: { targets: [{ part: 'hair' }], candidates: 3 } };

interface Fixture { home: string; project: string; client: ApiClient; service: RuntimeService }
/** A stopped-scheduler Runtime over one Workflow whose recolour Run and regression Run exist on disk. */
async function fixture(t: TestContext, options: { status?: string; plan?: any; states?: string[] } = {}): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'avh-stage-photos-')); t.after(() => removeTemp(root));
  const home = join(root, 'home'), workspace = join(root, 'workspace'), project = join(root, 'project');
  const tools = join(home, 'tools'), knowledge = join(home, 'knowledge');
  for (const path of [join(home, 'config'), join(home, 'state'), join(home, 'runs'), workspace, project, tools, knowledge]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: workspace, toolRoot: tools, knowledgeRoot: knowledge,
    exportRoots: [], knownBodies: [], projectAliases: {}, sampleNames: [], providers: [], processDefinitions: { fixture: 'fixture.yaml' },
    defaultProfile: 'fixture', thresholdsFile: 'thresholds.yaml' }));
  writeFileSync(join(knowledge, 'thresholds.yaml'), 'schema: thresholds/0.1\nversion: "1"\nt: {}\n');
  writeFileSync(join(knowledge, 'fixture.yaml'), stringify({ schema: 'process/0.1', id: 'fixture', version: '1', applies_to: {},
    artifacts: ['materials', 'build'], stages: [], checks: [], gates: [], milestones: [] }));
  execFileSync('git', ['init', '-q', project]);
  for (const name of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) {
    mkdirSync(dirname(join(tools, name)), { recursive: true }); writeFileSync(join(tools, name), '');
  }
  const put = (path: string, bytes: Buffer | string) => {
    const absolute = join(project, path); mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, bytes);
    return { path, sha256: hash(readFileSync(absolute)) };
  };
  put('Assets/_Harness/Recolor/recipe.json', JSON.stringify({ schema: 'recolor-recipe/0.2', chosen: 'B', reason: '演示：粉白配色',
    tiers: [{ id: 'A', label: '原值' }, { id: 'B', label: '粉白' }, { id: 'C', label: '更亮' }] }));
  const db = openDatabase(join(home, 'state/harness.db'));
  db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('workspace', workspace);
  db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('project','workspace','sample',?,'{}','active','test','test')").run(project);
  db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('workflow','project','fixture','hash','test',?,?)")
    .run(options.status ?? 'active', JSON.stringify(options.plan ?? PLAN));
  db.prepare("INSERT INTO artifact_version(workflow_id,kind,hash) VALUES('workflow','materials',?)").run(MATERIALS_HASH);
  db.prepare("INSERT INTO artifact_version(workflow_id,kind,hash) VALUES('workflow','build',?)").run(BUILD_HASH);
  for (const [id, stage, method, hashes] of [['recolor-task', 'recolor', 'AVH.Harness.RecolorStage.Run', { materials: MATERIALS_HASH }],
    ['regression-task', 'regression', 'AVH.Harness.RegressionStage.Run', { build: BUILD_HASH }]] as const) {
    const run = stage === 'recolor' ? RECOLOR_RUN : REGRESSION_RUN;
    db.prepare('INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES(?,?,?,?,?,?)').run(id, 'workflow', stage, stage, 'test', 'PASSED');
    db.prepare('INSERT INTO run(id,task_id,attempt,status,result_json) VALUES(?,?,1,?,?)').run(run, id, 'exited',
      JSON.stringify({ exitStatus: 0, outputs: {}, unitySteps: [{ method, exitCode: 0 }] }));
    db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('workflow','runtime','run',?,'unity_unit_intended','synthetic fixture')").run(run);
    db.prepare('INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json,run_id) VALUES(?,?,?,?)')
      .run('workflow', stage, JSON.stringify(hashes), run);
  }
  db.close();
  const write = (path: string, bytes: Buffer | string) => { const absolute = join(home, path); mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, bytes); };
  let seed = 0;
  const states = options.states ?? ['kimono', 'yukata'];
  for (const tier of ['A', 'B', 'C']) for (const state of states) {
    write(`runs/${RECOLOR_RUN}/candidates/${tier}_${state}.png`, png(++seed));
    write(`runs/${RECOLOR_RUN}/candidates/${tier}_${state}.json`, JSON.stringify({ ...CAMERA, candidate: tier, avatar_state: { 'AVH/Outfit': 1 } }));
  }
  const photos = ['kimono', 'yukata'].map((outfit, index) => {
    write(`runs/${REGRESSION_RUN}/photos/outfit_AVH_Outfit${index}.png`, png(40 + index));
    write(`runs/${REGRESSION_RUN}/photos/outfit_AVH_Outfit${index}.json`, JSON.stringify(CAMERA));
    return { photo: `outfit_AVH_Outfit${index}.png`, named: [outfit], worn: [outfit] };
  });
  write(`runs/${REGRESSION_RUN}/coverage.json`, JSON.stringify({ schema: 'coverage/0.1', photos }));
  const bind = openDatabase(join(home, 'state/harness.db'));
  for (const [run, stage, directory] of [[RECOLOR_RUN, 'recolor', 'candidates'], [REGRESSION_RUN, 'regression', 'photos']] as const) {
    const row = bind.prepare('SELECT result_json FROM run WHERE id=?').get(run) as { result_json: string };
    const result = JSON.parse(row.result_json); result.previewDigests = { [stage]: renderedImageDigest(join(home, 'runs', run), directory) };
    if (stage === 'recolor') result.previewStates = states;
    bind.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(result), run);
  }
  bind.close();
  const service = new RuntimeService({ home, scheduler: false, pollMs: 50 });
  await service.start();
  const client = await ApiClient.connect(home);
  t.after(async () => { client.close(); await service.stop(); });
  return { home, project, client, service };
}

const params = { projectId: 'project', workflowId: 'workflow' };

test('the recolour Gate reads the candidates of the version it binds, through the real API', async t => {
  const f = await fixture(t);
  const preview = await f.client.call<any>('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.source, 'unity');
  assert.equal(preview.artifactHash, MATERIALS_HASH);
  assert.equal(preview.chosenTier, 'B');
  assert.match(preview.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'the set names when its stage was recorded');
  assert.deepEqual(preview.tiers.map((tier: any) => [tier.id, tier.chosen]), [['A', false], ['B', true], ['C', false]]);
  assert.deepEqual(preview.images.map((image: any) => image.id), ['A_kimono', 'A_yukata', 'B_kimono', 'B_yukata', 'C_kimono', 'C_yukata']);
  assert.deepEqual(preview.images.filter((image: any) => image.chosen).map((image: any) => image.id), ['B_kimono', 'B_yukata']);
  assert.equal(preview.images[0].outfitLabel, '春樱和服');
  // No host path leaves the interface, and no render tool is named for the person to run.
  assert.doesNotMatch(JSON.stringify(preview), /\/(runs|candidates|photos)\//);
  assert.equal(JSON.stringify(preview).includes(JSON.stringify(f.home).slice(1, -1)), false);
  const reads = await f.client.call<any[]>('project.recolor.preview.images',
    { ...params, expectedHash: MATERIALS_HASH, previewSha256: preview.previewSha256, ids: preview.images.map((image: any) => image.id) });
  assert.deepEqual(reads.map(read => read.id), preview.images.map((image: any) => image.id));
  for (const read of reads) assert.match(read.dataUrl, /^data:image\/png;base64,/);
  assert.equal(reads[0].sha256, preview.images[0].sha256);
  // The decision card asks for the chosen tier's row only (F27b). A subset of the listed ids is a legal batch, and it
  // returns exactly those pictures, still bound to the digest of the whole set.
  const strip = await f.client.call<any[]>('project.recolor.preview.images',
    { ...params, expectedHash: MATERIALS_HASH, previewSha256: preview.previewSha256, ids: ['B_kimono', 'B_yukata'] });
  assert.deepEqual(strip.map(read => read.id), ['B_kimono', 'B_yukata']);
  assert.equal(strip.every(read => read.previewSha256 === preview.previewSha256), true);
  assert.deepEqual(strip.map(read => read.sha256), preview.images.filter((image: any) => image.chosen).map((image: any) => image.sha256));

  // A version that did not render these pictures, a batch that is not the listed set, and an unknown project.
  const other = await f.client.call<any>('project.recolor.preview', { ...params, expectedHash: 'f'.repeat(64) });
  assert.equal(other.status, 'missing');
  assert.match(other.reason, /重新运行配色阶段/);
  await assert.rejects(f.client.call('project.recolor.preview', { ...params, expectedHash: 'not-a-digest' }), /版本无效/);
  await assert.rejects(f.client.call('project.recolor.preview.images',
    { ...params, expectedHash: MATERIALS_HASH, previewSha256: '0'.repeat(64), ids: ['A_kimono'] }), /发生了变化/);
  await assert.rejects(f.client.call('project.recolor.preview.images',
    { ...params, expectedHash: MATERIALS_HASH, previewSha256: preview.previewSha256, ids: ['Z_kimono'] }), /不在当前候选/);
  await assert.rejects(f.client.call('project.recolor.preview.images',
    { ...params, expectedHash: MATERIALS_HASH, previewSha256: preview.previewSha256, ids: Array(25).fill('A_kimono') }), /批次无效/);
  await assert.rejects(f.client.call('project.recolor.preview', { ...params, projectId: 'other', expectedHash: MATERIALS_HASH }), /所属制作流程/);

  // The bytes on disk are the ones the person saw: a changed picture withdraws the whole set.
  writeFileSync(join(f.home, `runs/${RECOLOR_RUN}/candidates/A_kimono.png`), png(99));
  await assert.rejects(f.client.call('project.recolor.preview.images',
    { ...params, expectedHash: MATERIALS_HASH, previewSha256: preview.previewSha256, ids: ['A_kimono'] }), /发生了变化/);
});

test('candidates from a different edit of the artefact are reported missing instead of shown', async t => {
  const f = await fixture(t);
  assert.equal((await f.client.call<any>('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH })).status, 'ready');
  const db = openDatabase(join(f.home, 'state/harness.db'));
  db.prepare("INSERT INTO artifact_version(workflow_id,kind,hash) VALUES('workflow','materials',?)").run('c'.repeat(64));
  db.close();
  // The pictures still belong to the older version: neither the old nor the new hash may show them.
  for (const expectedHash of [MATERIALS_HASH, 'c'.repeat(64)]) {
    const preview = await f.client.call<any>('project.recolor.preview', { ...params, expectedHash });
    assert.equal(preview.status, 'missing', `${expectedHash.slice(0, 4)} must not show pictures of another version`);
    assert.match(preview.reason, /重新运行配色阶段/);
  }
});

test('image replacement before first view or after view withdraws the bound evidence', async t => {
  const before = await fixture(t);
  writeFileSync(join(before.home, `runs/${RECOLOR_RUN}/candidates/B_kimono.png`), png(101));
  const first = await before.client.call<any>('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH });
  assert.equal(first.status, 'missing');
  assert.match(first.reason, /完成后发生了变化/);

  const after = await fixture(t);
  const shown = await after.client.call<any>('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH });
  assert.equal(shown.status, 'ready');
  writeFileSync(join(after.home, `runs/${RECOLOR_RUN}/candidates/B_kimono.png`), png(102));
  await assert.rejects(after.client.call('project.recolor.preview.images', { ...params, expectedHash: MATERIALS_HASH,
    previewSha256: shown.previewSha256, ids: ['B_kimono'] }), /完成后发生变化|发生了变化/);
});

test('a missing chosen-tier or comparison-tier outfit withdraws the complete candidate set', async t => {
  for (const file of ['B_yukata.png', 'A_yukata.png']) {
    const f = await fixture(t);
    rmSync(join(f.home, `runs/${RECOLOR_RUN}/candidates/${file}`));
    const db = openDatabase(join(f.home, 'state/harness.db'));
    const row = db.prepare('SELECT result_json FROM run WHERE id=?').get(RECOLOR_RUN) as { result_json: string };
    const runResult = JSON.parse(row.result_json); runResult.previewDigests.recolor = renderedImageDigest(join(f.home, `runs/${RECOLOR_RUN}`), 'candidates');
    db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(runResult), RECOLOR_RUN); db.close();
    await assert.rejects(f.client.call<any>('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH }), /必要的档位与服装组合/);
  }
});

test('legal fixed, mixed, and independent outfit states match the Unity recolour renderer', async t => {
  const cases = [
    { plan: { ...PLAN, outfits: [{ id: 'body', activation: 'fixed' }] }, states: ['original'], expected: ['A_original', 'B_original', 'C_original'] },
    { plan: { ...PLAN, outfits: [{ id: 'body', activation: 'fixed' }, { id: 'kimono', activation: 'exclusive' }] }, states: ['kimono'], expected: ['A_kimono', 'B_kimono', 'C_kimono'] },
    { plan: { ...PLAN, outfits: [{ id: 'hair', activation: 'independent' }] }, states: ['hair'], expected: ['A_hair', 'B_hair', 'C_hair'] },
  ];
  for (const item of cases) {
    const f = await fixture(t, item);
    const preview = await f.client.call<any>('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH });
    assert.equal(preview.status, 'ready', JSON.stringify(item.plan));
    assert.deepEqual(preview.images.map((image: any) => image.id), item.expected);
  }
});

test('material-axis groups are excluded from recolour states while instance members remain complete', async t => {
  const plan = { schema: 'plan/0.3', body: 'fixture', avatar_config: materialAxisConfig(), recolor: { targets: [], candidates: 3 } };
  const f = await fixture(t, { plan, states: previewStatesForPlan(plan) });
  const ready = await f.client.call<any>('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.images.map((image: any) => image.id), ['A_long', 'A_short', 'B_long', 'B_short', 'C_long', 'C_short']);

  rmSync(join(f.home, `runs/${RECOLOR_RUN}/candidates/B_long.png`));
  rmSync(join(f.home, `runs/${RECOLOR_RUN}/candidates/B_long.json`));
  const db = openDatabase(join(f.home, 'state/harness.db'));
  const row = db.prepare('SELECT result_json FROM run WHERE id=?').get(RECOLOR_RUN) as { result_json: string };
  const result = JSON.parse(row.result_json); result.previewDigests.recolor = renderedImageDigest(join(f.home, `runs/${RECOLOR_RUN}`), 'candidates');
  db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(result), RECOLOR_RUN); db.close();
  await assert.rejects(f.client.call('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH }), /档位与服装组合.*B_long/);
});

test('missing preview files and permission errors are controlled at the real API boundary', async t => {
  for (const [kind, file] of [['png', 'A_kimono.png'], ['spec', 'A_kimono.json'], ['permission', 'A_kimono.png']] as const) {
    const f = await fixture(t);
    const absolute = join(f.home, `runs/${RECOLOR_RUN}/candidates/${file}`);
    const shown = await f.client.call<any>('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH });
    assert.equal(shown.status, 'ready');
    if (kind === 'permission') { chmodSync(absolute, 0); if (process.platform === 'win32') { rmSync(absolute); mkdirSync(absolute); } }
    else rmSync(absolute);
    await assert.rejects(f.client.call('project.recolor.preview.images', { ...params, expectedHash: MATERIALS_HASH,
      previewSha256: shown.previewSha256, ids: ['A_kimono'] }), error => {
      assert.doesNotMatch(String(error), /[A-Za-z]:\\|\\\\|\/tmp\//);
      return /文件|读取|权限|候选图|发生变化/.test(String(error));
    });
    if (kind === 'permission') chmodSync(absolute, 0o644);
  }
});

test('a candidate directory that is a link out of the Run is refused, not read', async t => {
  const f = await fixture(t);
  const outside = join(f.home, '..', 'outside-candidates'); mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'A_kimono.png'), png(5));
  writeFileSync(join(outside, 'A_kimono.json'), JSON.stringify({ ...CAMERA, candidate: 'A' }));
  const candidates = join(f.home, `runs/${RECOLOR_RUN}/candidates`);
  removeTemp(candidates);
  symlinkSync(outside, candidates, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.client.call('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH }), /链接|越出/);
});

test('the project page reads the finished outfit photos once delivery is ready, through the real API', async t => {
  const f = await fixture(t, { status: 'upload_ready' });
  const photos = await f.client.call<any>('project.delivery.photos', params);
  assert.equal(photos.status, 'ready');
  assert.equal(photos.source, 'unity');
  assert.equal(photos.buildHash, BUILD_HASH);
  assert.match(photos.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.deepEqual(photos.photos.map((photo: any) => photo.label), ['春樱和服', '夏日浴衣']);
  const reads = await f.client.call<any[]>('project.delivery.photos.images',
    { ...params, previewSha256: photos.previewSha256, ids: photos.photos.map((photo: any) => photo.id) });
  assert.equal(reads.length, 2);
  for (const read of reads) assert.match(read.dataUrl, /^data:image\/png;base64,/);
  await assert.rejects(f.client.call('project.delivery.photos.images',
    { ...params, previewSha256: photos.previewSha256, ids: ['not-a-photo'] }), /不在当前候选/);

  // A build that did not take these photos shows nothing.
  const db = openDatabase(join(f.home, 'state/harness.db'));
  db.prepare("INSERT INTO artifact_version(workflow_id,kind,hash) VALUES('workflow','build',?)").run('d'.repeat(64));
  db.close();
  const stale = await f.client.call<any>('project.delivery.photos', params);
  assert.equal(stale.status, 'missing');
  assert.match(stale.reason, /重新运行回归阶段/);
});

test('a Workflow that has not reached delivery shows no finished photos', async t => {
  const f = await fixture(t, { status: 'active' });
  const photos = await f.client.call<any>('project.delivery.photos', params);
  assert.equal(photos.status, 'missing');
  assert.match(photos.reason, /还没到可上传/);
});

test('a grouped plan names the outfit each finished photo shows, from the state the stage recorded', async t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-stage-photos-plan-')); t.after(() => removeTemp(root));
  const home = join(root, 'home'), project = join(root, 'project');
  for (const path of [join(home, 'state'), join(home, 'runs'), project]) mkdirSync(path, { recursive: true });
  const plan = { schema: 'plan/0.3', avatar_config: { groups: [
    { id: 'outfit', label: '衣装', activation: 'exclusive', default: 'kimono', parameter: { name: 'AVH/Outfit', type: 'Int' },
      members: [{ id: 'kimono', label: '春樱和服' }, { id: 'yukata', label: '夏日浴衣' }] },
    { id: 'ring', label: '戒指', activation: 'independent', members: [{ id: 'ring', label: '星光戒指', parameter: { name: 'AVH/Ring' } }] }] } };
  const db = openDatabase(join(home, 'state/harness.db'));
  db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('workspace', root);
  db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('project','workspace','sample',?,'{}','active','test','test')").run(project);
  db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('workflow','project','fixture','hash','test','upload_ready',?)")
    .run(JSON.stringify(plan));
  db.prepare("INSERT INTO artifact_version(workflow_id,kind,hash) VALUES('workflow','build',?)").run(BUILD_HASH);
  db.prepare('INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES(?,?,?,?,?,?)').run('regression-task', 'workflow', 'regression', 'regression', 'test', 'PASSED');
  db.prepare('INSERT INTO run(id,task_id,attempt,status,result_json) VALUES(?,?,1,?,?)').run(REGRESSION_RUN, 'regression-task', 'exited',
    JSON.stringify({ exitStatus: 0, outputs: {}, unitySteps: [{ method: 'AVH.Harness.RegressionStage.Run', exitCode: 0 }] }));
  db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('workflow','runtime','run',?,'unity_unit_intended','synthetic fixture')").run(REGRESSION_RUN);
  db.prepare('INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json,run_id) VALUES(?,?,?,?)')
    .run('workflow', 'regression', JSON.stringify({ build: BUILD_HASH }), REGRESSION_RUN);
  const write = (path: string, bytes: Buffer | string) => { const absolute = join(home, path); mkdirSync(dirname(absolute), { recursive: true }); writeFileSync(absolute, bytes); };
  const states = [{ 'AVH/Outfit': 1, 'AVH/Ring': 0 }, { 'AVH/Outfit': 0, 'AVH/Ring': 1 }];
  states.forEach((state, index) => {
    write(`runs/${REGRESSION_RUN}/photos/group_${index}.png`, png(index + 7));
    write(`runs/${REGRESSION_RUN}/photos/group_${index}.json`, JSON.stringify(CAMERA));
  });
  write(`runs/${REGRESSION_RUN}/coverage.json`, JSON.stringify({ schema: 'coverage/0.2', photos: states.map(state => ({ ...CAMERA, avatar_state: state })) }));
  const bound = openDatabase(join(home, 'state/harness.db'));
  const row = bound.prepare('SELECT result_json FROM run WHERE id=?').get(REGRESSION_RUN) as { result_json: string };
  const result = JSON.parse(row.result_json); result.previewDigests = { regression: renderedImageDigest(join(home, 'runs', REGRESSION_RUN), 'photos') };
  bound.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(result), REGRESSION_RUN); bound.close();
  const photos = projectDeliveryPhotos(db, 'project', 'workflow');
  db.close();
  assert.equal(photos.status, 'ready');
  assert.deepEqual(photos.status === 'ready' ? photos.photos.map(photo => photo.label) : [], ['衣装：夏日浴衣', '衣装：春樱和服']);
});

test('a candidate set whose camera or size differs is refused instead of shown side by side', async t => {
  const f = await fixture(t);
  const spec = join(f.home, `runs/${RECOLOR_RUN}/candidates/C_yukata.json`);
  writeFileSync(spec, JSON.stringify({ ...CAMERA, ortho_size: 2.4, candidate: 'C' }));
  const db = openDatabase(join(f.home, 'state/harness.db'));
  const row = db.prepare('SELECT result_json FROM run WHERE id=?').get(RECOLOR_RUN) as { result_json: string };
  const runResult = JSON.parse(row.result_json); runResult.previewDigests.recolor = renderedImageDigest(join(f.home, `runs/${RECOLOR_RUN}`), 'candidates');
  db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(runResult), RECOLOR_RUN); db.close();
  await assert.rejects(f.client.call('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH }), /同一机位/);
  writeFileSync(spec, JSON.stringify({ ...CAMERA, candidate: 'A' }));
  const db2 = openDatabase(join(f.home, 'state/harness.db'));
  const row2 = db2.prepare('SELECT result_json FROM run WHERE id=?').get(RECOLOR_RUN) as { result_json: string };
  const runResult2 = JSON.parse(row2.result_json); runResult2.previewDigests.recolor = renderedImageDigest(join(f.home, `runs/${RECOLOR_RUN}`), 'candidates');
  db2.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(runResult2), RECOLOR_RUN); db2.close();
  await assert.rejects(f.client.call('project.recolor.preview', { ...params, expectedHash: MATERIALS_HASH }), /档位与机位规格不一致/);
  writeFileSync(spec, JSON.stringify({ ...CAMERA, candidate: 'C' }));
  const db4 = openDatabase(join(f.home, 'state/harness.db'));
  const row4 = db4.prepare('SELECT result_json FROM run WHERE id=?').get(RECOLOR_RUN) as { result_json: string };
  const runResult4 = JSON.parse(row4.result_json); runResult4.previewDigests.recolor = renderedImageDigest(join(f.home, `runs/${RECOLOR_RUN}`), 'candidates');
  db4.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify(runResult4), RECOLOR_RUN); db4.close();
  const db3 = openDatabase(join(f.home, 'state/harness.db'));
  const direct = projectRecolorPreview(db3, 'project', 'workflow', MATERIALS_HASH);
  db3.close();
  assert.equal(direct.status, 'ready');
  assert.equal(direct.status === 'ready' && direct.images.length, 6);
});

