import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const sourceTools = process.env.AVH_TEST_FACE_TOOLS ?? fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const python = process.env.AVH_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const blender = process.env.AVH_TEST_BLENDER ?? (process.platform === 'win32' ? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' : '/usr/bin/blender');
const cs = ['FaceStage.cs', 'FaceGeometry.cs', 'FaceEyes.cs', 'FaceMapping.cs', 'AvhCommon.cs', 'LocalOperations.cs', 'OutfitStage.cs', 'SetupStage.cs'];
const py = ['blender_face.py', 'blender_face_observe.py', 'blender_face_common.py', 'blender_face_transfer.py', 'blender_face_mapping.py'];
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
type Json = Record<string, any>;
const read = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'));
const serialize = (path: string, value: Json) => writeFileSync(path, JSON.stringify(value));

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-face-runtime-')); t.after(() => removeTemp(root));
  const project = join(root, 'project'), tools = join(root, 'tools');
  for (const dir of ['Assets/_HarnessTools/Editor', 'Assets/Source', '_harness/face']) mkdirSync(join(project, dir), { recursive: true });
  mkdirSync(tools);
  for (const name of [...py, 'face.py']) copyFileSync(join(sourceTools, name), join(tools, name));
  for (const name of cs) {
    copyFileSync(join(sourceTools, 'unity/Editor', name), join(tools, name));
    copyFileSync(join(tools, name), join(project, 'Assets/_HarnessTools/Editor', name));
  }
  const sources = [...cs, ...py].map(name => join(tools, name));
  return { root, project, tools, sources };
}

function run(f: ReturnType<typeof fixture>, action: string, args: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(python, [join(f.tools, 'face.py'), action, '--project', f.project,
    ...(action === 'inspect' ? [] : ['--sources', ...f.sources]), ...args], {
    encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { ...process.env, AVH_MANIFEST: '{}', AVH_PLAN: '{}', ...env },
  });
  assert.equal(result.error, undefined, String(result.error));
  return { code: result.status, output: result.stdout + result.stderr, value: result.status === 0 ? JSON.parse(result.stdout) as Json : undefined };
}

function succeeded(result: ReturnType<typeof run>) { assert.equal(result.code, 0, result.output); return result.value!; }
function failed(result: ReturnType<typeof run>, pattern: RegExp) { assert.equal(result.code, 2, result.output); assert.match(result.output, pattern); }

function observed(f: ReturnType<typeof fixture>, overrides: Json = {}) {
  for (const path of ['Assets/Source/source.fbx', 'Assets/Source/avatar.prefab']) {
    if (!existsSync(join(f.project, path))) writeFileSync(join(f.project, path), path);
    writeFileSync(join(f.project, path + '.meta'), 'fixture metadata');
  }
  const identity = (path: string) => ({ path, sha256: hash(join(f.project, path)), metaSha256: hash(join(f.project, path + '.meta')), guid: 'fixture', localId: 1, dependencyHash: 'fixture' });
  const targetId = 'a'.repeat(64);
  const target: Json = { targetId, rendererPath: 'Face', rendererIndex: 0, mesh: identity('Assets/Source/source.fbx'),
    meshSnapshot: { name: 'Face', vertices: [[], [], [], []], keys: ['Contour', 'Runtime'].map(name => ({ name, frames: [{ weight: 100 }] })) },
    defaultWeights: { Contour: 0, Runtime: 25 }, protectedKeys: ['Runtime'], writers: [{ kind: 'animation', key: 'Runtime' }], unmeasuredWriters: [], ...overrides };
  const observation = { schema: 'face-unity-observation/0.1', sourcePrefab: identity('Assets/Source/avatar.prefab'), dependencies: [identity('Assets/Source/source.fbx')], targets: [target] };
  const path = join(f.project, '_harness/face/observation.json'); serialize(path, observation);
  return { observation, target, targetId, path, sha256: hash(path) };
}

test('face consumes the Runtime input identity and independent readback rejects same-byte output bound to another input', t => {
  const f = fixture(t); observed(f); const input = '1'.repeat(64), env = { AVH_FACE_INPUT_HASH: input, AVH_PLAN: '{"face":{"mode":"preserve"}}' };
  succeeded(run(f, 'preserve', [], env));
  const design = join(f.project,'Assets/_Harness/Face/design.json'); assert.equal(read(design).faceInputHash, input);
  serialize(join(f.project,'_harness/face/output.json'), { faceInputHash: input, inputSha256: hash(design) });
  assert.equal(succeeded(run(f,'input-check',[],env)).metrics.face_input_bound,true);
  assert.equal(succeeded(run(f,'input-check',[],{...env,AVH_FACE_INPUT_HASH:'2'.repeat(64)})).metrics.face_input_bound,false);
  serialize(join(f.project,'_harness/face/output.json'), { faceInputHash: input, inputSha256: '3'.repeat(64) });
  assert.equal(succeeded(run(f,'input-check',[],env)).metrics.face_input_bound,false);
});

test('manual readback binds accepted content to the frozen SHA even if project files are coherently rewritten', t => {
  const f = fixture(t); observed(f);
  const accepted = join(f.project, '_harness/face/accepted-manual.json'), design = join(f.project, 'Assets/_Harness/Face/design.json');
  mkdirSync(join(f.project, 'Assets/_Harness/Face'), { recursive: true });
  serialize(accepted, { values: { key: 0 } }); const frozen = hash(accepted), input = '1'.repeat(64);
  const env = { AVH_FACE_INPUT_HASH: input, AVH_ACCEPTED_MANUAL_FACE_SHA256: frozen, AVH_PLAN: '{"face":{"mode":"manual","manualSessionId":"s1"}}' };
  const projectBinding = () => {
    serialize(design, { faceInputHash: input, manualSessionId: 's1', manualValuesSha256: hash(accepted) });
    serialize(join(f.project, '_harness/face/output.json'), { faceInputHash: input, inputSha256: hash(design) });
  };
  projectBinding(); assert.equal(succeeded(run(f, 'input-check', [], env)).metrics.face_input_bound, true);
  serialize(accepted, { values: { key: 1 } }); projectBinding();
  assert.equal(succeeded(run(f, 'input-check', [], env)).metrics.face_input_bound, false);
});

test('face tool contract works before observation and preserve has no Blender dependency or fake candidate', t => {
  const f = fixture(t); const contract = succeeded(run(f, 'contract'));
  assert.equal(Object.keys(contract.tools).length, 14); assert.equal(existsSync(join(f.project, '_harness/face/observation.json')), false);
  const observation = observed(f), original = hash(join(f.project, 'Assets/Source/source.fbx'));
  const result = succeeded(run(f, 'preserve', ['--blender', join(f.root, 'not-installed')], { AVH_PLAN: '{"face":{"mode":"preserve"}}' }));
  assert.equal(result.mode, 'preserve'); assert.equal(result.productionAccepted, false);
  assert.deepEqual(read(join(f.project, 'Assets/_Harness/Face/design.json')), { schema: 'face-unity-design/0.1', mode: 'preserve', observationSha256: observation.sha256 });
  assert.equal(existsSync(join(f.project, 'Assets/_Harness/Face/Candidates')), false);
  assert.equal(hash(join(f.project, 'Assets/Source/source.fbx')), original);
  failed(run(f, 'preserve', [], { AVH_MANIFEST: '{"faceConcept":"小脸"}' }), /silently ignore/);
  failed(run(f, 'preserve', [], { AVH_PLAN: '{"face":{"mode":"design"}}' }), /silently ignore/);
  writeFileSync(join(f.project, 'Assets/_HarnessTools/Editor/FaceStage.cs'), 'changed');
  failed(run(f, 'contract'), /differs from frozen source/);
  copyFileSync(join(f.tools, 'FaceStage.cs'), join(f.project, 'Assets/_HarnessTools/Editor/FaceStage.cs'));
  writeFileSync(join(f.project, 'Assets/_HarnessTools/Editor/FaceEyes.cs'), 'changed eye helper');
  failed(run(f, 'contract'), /differs from frozen source: FaceEyes/);
  copyFileSync(join(f.tools, 'FaceEyes.cs'), join(f.project, 'Assets/_HarnessTools/Editor/FaceEyes.cs'));
  copyFileSync(join(sourceTools, 'unity/Editor/FacePreviewStage.cs'), join(f.project, 'Assets/_HarnessTools/Editor/FacePreviewStage.cs'));
  failed(run(f, 'contract'), /Installed face preview requires its frozen source/);
});

test('paged face inspection exposes real identities/key protection and refuses stale source metadata', t => {
  const f = fixture(t), o = observed(f);
  const targets = succeeded(run(f, 'inspect', ['--section', 'targets', '--limit', '1']));
  assert.equal(targets.rows[0].targetId, o.targetId); assert.equal(targets.observationSha256, o.sha256);
  const keys = succeeded(run(f, 'inspect', ['--section', 'keys', '--target-id', o.targetId, '--offset', '1', '--limit', '1']));
  assert.equal(keys.rows[0].name, 'Runtime'); assert.equal(keys.rows[0].defaultUnityPercent, 25); assert.equal(keys.rows[0].protected, true);
  failed(run(f, 'inspect', ['--section', 'keys', '--target-id', '../source']), /SHA256 Unity targetId/);
  failed(run(f, 'inspect', ['--limit', '65']), /Invalid face catalog\/observation page/);
  writeFileSync(join(f.project, 'Assets/Source/source.fbx.meta'), 'changed'); failed(run(f, 'inspect'), /source metadata changed/);
});

test('Runtime face compiler deployment requires every exact frozen target before changing sources', t => {
  const f = fixture(t), installed = join(f.project, 'Assets/_HarnessTools/Editor');
  const old = join(installed, 'FaceStage.cs'); writeFileSync(old, 'prior frozen source');
  const updates = cs.map(name => ({ path: 'Assets/_HarnessTools/Editor/' + name,
    before: hash(join(installed, name)), after: hash(join(f.tools, name)) }));
  failed(run(f, 'contract', ['--install']), /differs from frozen source/);
  const changed = join(installed, 'AvhCommon.cs'), original = readFileSync(changed);
  writeFileSync(changed, 'unreviewed source edit');
  failed(run(f, 'contract', ['--install'], { AVH_RUNTIME_TOOL_UPDATE_JSON: JSON.stringify(updates) }), /exact source versions/);
  assert.equal(readFileSync(old, 'utf8'), 'prior frozen source', 'no compiler may be changed before all targets pass');
  writeFileSync(changed, original);
  const extra = [...updates, { path: 'Assets/Source/avatar.prefab', before: '0'.repeat(64), after: '0'.repeat(64) }];
  failed(run(f, 'contract', ['--install'], { AVH_RUNTIME_TOOL_UPDATE_JSON: JSON.stringify(extra) }), /unknown targets/);
  const env = { AVH_RUNTIME_TOOL_UPDATE_JSON: JSON.stringify(updates) };
  succeeded(run(f, 'contract', ['--install'], env));
  assert.equal(hash(old), hash(join(f.tools, 'FaceStage.cs')));
  succeeded(run(f, 'contract', ['--install'], env));
  failed(run(f, 'execute', ['--install'], env), /only available to Runtime contract/);
  writeFileSync(old, 'prior frozen source');
  const helper = join(f.tools, 'face.py'), fixed = readFileSync(helper, 'utf8');
  writeFileSync(helper, fixed.replace('install=args.install or', 'install=False and'));
  failed(run(f, 'contract', ['--install'], env), /differs from frozen source/);
  assert.equal(readFileSync(old, 'utf8'), 'prior frozen source');
});

const fbxFixture = `import bpy,sys
from pathlib import Path
root=Path(sys.argv[-1]);bpy.ops.wm.read_factory_settings(use_empty=True)
mesh=bpy.data.meshes.new('Face');mesh.from_pydata([(-.02,0,-.003),(-.02,0,.003),(.02,0,.003),(.02,0,-.003)],[],[(0,1,2,3)]);mesh.update()
obj=bpy.data.objects.new('Face',mesh);bpy.context.collection.objects.link(obj);bpy.context.view_layer.objects.active=obj;obj.select_set(True)
uv=mesh.uv_layers.new(name='FaceUV')
for loop in mesh.loops:uv.data[loop.index].uv=((mesh.vertices[loop.vertex_index].co.x+.02)/.04,(mesh.vertices[loop.vertex_index].co.z+.003)/.006)
mesh.materials.append(bpy.data.materials.new('Skin'));basis=obj.shape_key_add(name='Basis');design=obj.shape_key_add(name='Contour');runtime=obj.shape_key_add(name='Runtime')
for v in design.data:v.co.x+=.002 if v.co.x>0 else -.002
for v in runtime.data:v.co.z=0
arm=bpy.data.armatures.new('Skeleton');rig=bpy.data.objects.new('Rig',arm);bpy.context.collection.objects.link(rig);obj.select_set(False);rig.select_set(True);bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='EDIT');bone=arm.edit_bones.new('Head');bone.head=(0,0,0);bone.tail=(0,0,.1);bpy.ops.object.mode_set(mode='OBJECT')
obj.parent=rig;modifier=obj.modifiers.new('Skin','ARMATURE');modifier.object=rig;group=obj.vertex_groups.new(name='Head');group.add(list(range(4)),1,'REPLACE');obj.select_set(True)
bpy.ops.export_scene.fbx(filepath=str(root/'Assets/Source/source.fbx'),use_selection=True,object_types={'ARMATURE','MESH'},add_leaf_bones=False,bake_anim=False,use_mesh_modifiers=False)
`;

test('managed Blender operations honor a bounded operation deadline on the real subprocess path', t => {
  if (!existsSync(blender)) { t.skip('Blender not installed'); return; }
  const f=fixture(t),script=join(f.root,'slow.py');writeFileSync(script,'import time\ntime.sleep(2)\n');
  const code='import importlib.util,sys; from pathlib import Path; spec=importlib.util.spec_from_file_location("face",sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.launch(Path(sys.argv[2]),{"path":sys.argv[3],"sha256":module.digest(sys.argv[3])},Path(sys.argv[4]),[])';
  const invoke=(seconds:string)=>spawnSync(python,['-c',code,join(f.tools,'face.py'),f.project,blender,script],{encoding:'utf8',timeout:20000,windowsHide:true,env:{...process.env,AVH_BLENDER_TIMEOUT_SEC:seconds}});
  const interrupted=invoke('1');assert.equal(interrupted.error,undefined);assert.notEqual(interrupted.status,0);assert.match(interrupted.stderr,/TimeoutExpired/);
  const completed=invoke('8');assert.equal(completed.error,undefined);assert.equal(completed.status,0,completed.stdout+completed.stderr);
  const invalid=invoke('0');assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/between 1 and 86400/);
});

test('known source role and stale-version failures are returned before Blender catalog work', t => {
  const f = fixture(t), o = observed(f, { unmeasuredWriters: ['Fixture.UnknownWriter: not evaluated as a shape writer'] });
  const request = { schema: 'face-request/0.2', observationSha256: o.sha256, targetId: o.targetId,
    candidates: [{ id: 'first', values: { Contour: .25 } }, { id: 'second', values: { Contour: .5 } }] };
  const path = join(f.project, '_harness/face/request.json'); serialize(path, request);
  const missingBlender = ['--blender', join(f.root, 'must-not-be-started')];
  failed(run(f, 'candidates', missingBlender), /unmeasured shape writers: Fixture.UnknownWriter/);
  assert.equal(existsSync(join(f.project, 'Assets/_Harness/Face/Catalogs')), false);
  serialize(path, { ...request, observationSha256: '0'.repeat(64) });
  failed(run(f, 'candidates', missingBlender), /Stale candidate request observation/);
  serialize(path, { schema: 'face-request/0.1', observationSha256: o.sha256, targetId: o.targetId, values: { Contour: .5 } });
  failed(run(f, 'prepare', missingBlender), /Historical face requests are read-only/);
  serialize(path, { ...request, observationSha256: o.sha256 });
  const ready = observed(f); serialize(path, { ...request, observationSha256: ready.sha256 });
  failed(run(f, 'candidates', missingBlender), /No installed Blender was discovered/);
});

test('legacy single drafts cannot start reconstruction or bypass the native candidate selection', t => {
  const f=fixture(t),o=observed(f);
  serialize(join(f.project,'_harness/face/request.json'),{schema:'face-request/0.1',observationSha256:o.sha256,targetId:o.targetId,values:{Contour:.5}});
  failed(run(f,'prepare',['--blender',join(f.root,'must-not-start')]),/Historical face requests are read-only/);
  assert.equal(existsSync(join(f.project,'Assets/_Harness/Face/Catalogs')),false);
});

test('multiple actual combinations freeze before a Runtime-bound selection; AI choices, stale choices and partial recovery cannot bake', { skip: !existsSync(blender) }, t => {
  const f = fixture(t), fixturePath = join(f.root, 'fixture.py'); writeFileSync(fixturePath, fbxFixture);
  const created = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python', fixturePath, '--', f.project], { encoding: 'utf8', timeout: 90_000, windowsHide: true,
    env: { ...process.env, BLENDER_USER_CONFIG: join(f.root, 'config'), BLENDER_USER_SCRIPTS: join(f.root, 'scripts'), BLENDER_USER_DATAFILES: join(f.root, 'data') } });
  assert.equal(created.error, undefined); assert.equal(created.status, 0, created.stdout + created.stderr);
  const o = observed(f), requestPath = join(f.project, '_harness/face/request.json');
  const request = { schema: 'face-request/0.2', observationSha256: o.sha256, targetId: o.targetId,
    candidates: [{ id: 'a', values: { Contour: .25 } }, { id: 'b', values: { Contour: .5 } }] };
  serialize(requestPath, { ...request, selectedCandidateId: 'b' }); failed(run(f, 'candidates', ['--blender', blender]), /AI cannot authorize/);
  serialize(requestPath, request);
  const collection = succeeded(run(f, 'candidates', ['--blender', blender])); assert.equal(collection.route, 'native-fbx/1'); assert.equal(collection.sourceAuthority, undefined); assert.equal(collection.sourceMapping, undefined); assert.equal(collection.candidates.length, 2); assert.equal(collection.productionAccepted, false);
  const pointer = join(f.project, '_harness/face/candidates.json'), pointerSha = hash(pointer), preview = read(join(f.project, 'Assets/_Harness/Face/preview-input.json'));
  assert.equal(preview.collectionSha256, pointerSha); assert.deepEqual(preview.candidates.map((i: Json) => i.weightsUnityPercent.Contour), [25, 50]);
  assert.equal(existsSync(join(f.project, 'Assets/_Harness/Face/Candidates')), false, 'candidate design validation must not bake before selection');
  const validationPath = join(f.project, collection.candidates[0].validation.file), validationBytes = readFileSync(validationPath);
  assert.equal(read(validationPath).status,'shape_combination_validated'); assert.equal(read(validationPath).compensation,null);
  const validationTime = statSync(validationPath).mtimeMs;
  const setDirectory = join(f.project, 'Assets/_Harness/Face/CandidateSets', collection.id);
  const setBefore = readdirSync(setDirectory, { recursive: true }).filter((path): path is string => typeof path === 'string')
    .filter(path => statSync(join(setDirectory, path)).isFile()).sort().map(path => [path, hash(join(setDirectory, path))]);
  succeeded(run(f, 'candidates', ['--blender', blender]));
  assert.equal(hash(pointer), pointerSha); assert.deepEqual(readFileSync(validationPath), validationBytes);
  assert.equal(statSync(validationPath).mtimeMs, validationTime, 'revalidation may write new evidence but must not overwrite frozen validation');
  const forgedValidation = read(validationPath); forgedValidation.vertexCount += 1;
  serialize(validationPath, forgedValidation);
  failed(run(f, 'candidates', ['--blender', blender]), /recovery differs from actual source\/design/);
  assert.equal(hash(pointer), pointerSha); assert.equal(existsSync(join(f.project, 'Assets/_Harness/Face/Candidates')), false);
  writeFileSync(validationPath, validationBytes);
  failed(run(f, 'prepare', ['--blender', blender]), /Runtime-authorized selection SHA/);
  const selectionPath = join(f.project, '_harness/face/selection.json');
  const selection = { schema: 'face-selection/0.1', requestSha256: hash(requestPath), candidateSetSha256: pointerSha,
    observationSha256: o.sha256, targetId: o.targetId, candidateId: 'b', gateId: 'unit-fixture-formal-gate' };
  serialize(selectionPath, { ...selection, candidateSetSha256: '0'.repeat(64) });
  failed(run(f, 'prepare', ['--blender', blender], { AVH_FACE_SELECTION_SHA256: hash(selectionPath) }), /another candidate set/);
  serialize(selectionPath, selection);
  failed(run(f, 'prepare', ['--blender', blender], { AVH_FACE_SELECTION_SHA256: '0'.repeat(64) }), /Selection bytes differ/);
  const env = { AVH_PLAN: '{"face":{"mode":"design"}}', AVH_FACE_SELECTION_SHA256: hash(selectionPath) };
  const prepared = succeeded(run(f, 'execute', ['--blender', blender], env)); assert.equal(prepared.candidateId, 'b'); assert.equal(prepared.reused, false); assert.equal(prepared.productionAccepted, false);
  const input = read(join(f.project, 'Assets/_Harness/Face/design.json')); assert.equal(input.candidateSetSha256, pointerSha); assert.equal(input.gateId, selection.gateId);
  assert.match(input.blenderVerification.file, /^Assets\/_Harness\/Face\/Candidates\//);
  const receiptPath = join(f.project, input.candidateReceipt.file), receipt = read(receiptPath);
  assert.equal(input.route,'native-fbx/1'); assert.deepEqual(receipt.retainedKeyNames,['Contour','Runtime']); assert.equal(receipt.fbxSettings.export.apply_scale_options,'FBX_SCALE_CUSTOM');
  const baked = receiptPath.replace('candidate.json', 'candidate.fbx'), editable = receiptPath.replace('candidate.json', 'candidate.blend');
  const before = { fbxHash: hash(baked), fbxTime: statSync(baked).mtimeMs, blendHash: hash(editable), blendTime: statSync(editable).mtimeMs };
  const recovered = succeeded(run(f, 'execute', ['--blender', blender], env)); assert.equal(recovered.reused, true); assert.equal(recovered.productionAccepted, false);
  assert.deepEqual({ fbxHash: hash(baked), fbxTime: statSync(baked).mtimeMs, blendHash: hash(editable), blendTime: statSync(editable).mtimeMs }, before, 'recovery must not rebake or rewrite either output');
  unlinkSync(join(f.project,input.blenderVerification.file));
  const resumedVerification=succeeded(run(f,'execute',['--blender',blender],env));
  assert.equal(resumedVerification.reused,true,'a complete hash-bound bake may resume an interrupted independent observation');
  assert.deepEqual({ fbxHash: hash(baked), fbxTime: statSync(baked).mtimeMs, blendHash: hash(editable), blendTime: statSync(editable).mtimeMs },before,'missing observation must not cause a rebake');
  assert.deepEqual(readdirSync(setDirectory, { recursive: true }).filter((path): path is string => typeof path === 'string')
    .filter(path => statSync(join(setDirectory, path)).isFile()).sort().map(path => [path, hash(join(setDirectory, path))]), setBefore,
    'candidate validation recovery and selected production must leave the entire Gate-selected upstream artifact unchanged');
  assert.ok(receipt.compensation); assert.equal(read(join(f.project, input.blenderVerification.file)).productionAccepted, false);
  const compiler = join(f.tools, 'FaceStage.cs'); writeFileSync(compiler, readFileSync(compiler, 'utf8') + '\n// reviewed compiler correction\n');
  const updates = cs.map(name => ({ path: 'Assets/_HarnessTools/Editor/' + name,
    before: hash(join(f.project, 'Assets/_HarnessTools/Editor', name)), after: hash(join(f.tools, name)) }));
  failed(run(f, 'execute', ['--blender', blender], env), /differs from frozen source/);
  const upgraded = { ...collection.tools, 'FaceStage.cs': hash(compiler) };
  const upgradeEnv = { ...env, AVH_RUNTIME_TOOL_UPDATE_JSON: JSON.stringify(updates),
    AVH_RUNTIME_FACE_TOOL_CONTRACT_JSON: JSON.stringify({ before: collection.tools, after: upgraded }) };
  failed(run(f, 'execute', ['--blender', blender], { ...upgradeEnv,
    AVH_RUNTIME_FACE_TOOL_CONTRACT_JSON: JSON.stringify({ before: {}, after: upgraded }) }), /Frozen candidate tools/);
  const retained = succeeded(run(f, 'execute', ['--blender', blender], upgradeEnv));
  assert.equal(retained.candidateId, 'b'); assert.equal(retained.reused, true);
  assert.equal(hash(pointer), pointerSha); assert.equal(hash(selectionPath), env.AVH_FACE_SELECTION_SHA256);
  assert.deepEqual({ fbxHash: hash(baked), fbxTime: statSync(baked).mtimeMs, blendHash: hash(editable), blendTime: statSync(editable).mtimeMs }, before);
  const producer = join(f.tools, 'blender_face.py'), producerBytes = readFileSync(producer);
  writeFileSync(producer, Buffer.concat([producerBytes, Buffer.from('\n# changed producer\n')]));
  failed(run(f, 'execute', ['--blender', blender], { ...upgradeEnv,
    AVH_RUNTIME_FACE_TOOL_CONTRACT_JSON: JSON.stringify({ before: collection.tools, after: { ...upgraded, 'blender_face.py': hash(producer) } }) }), /Frozen candidate tools/);
  writeFileSync(producer, producerBytes);
  const bridge = join(f.tools, 'face.py'), fixedBridge = readFileSync(bridge, 'utf8');
  writeFileSync(bridge, fixedBridge.replace('if not compatible and set(previous) == set(identities):', 'if False:'));
  failed(run(f, 'execute', ['--blender', blender], upgradeEnv), /Frozen candidate tools/);
  writeFileSync(bridge, fixedBridge);
  // A partial or identity-changed artifact is not a recovery checkpoint.
  const changed = structuredClone(receipt); changed.revisionId = 'other'; serialize(receiptPath, changed);
  failed(run(f, 'execute', ['--blender', blender], upgradeEnv), /Candidate identity changed/); serialize(receiptPath, receipt);
  writeFileSync(baked, 'partial'); failed(run(f, 'execute', ['--blender', blender], upgradeEnv), /Changed candidate cannot be reused/);
});


test('interrupted native import recovers only the hash-bound managed source and refuses unrelated edits', t => {
 const f=fixture(t);const o=observed(f);const model=join(f.project,'Assets/Source/source.fbx'),meta=model+'.meta';
 const original=readFileSync(model),candidate=Buffer.from('new native FBX fixture');
 const backup=join(f.project,'_harness/face/native-import/case/original.fbx');mkdirSync(join(f.project,'_harness/face/native-import/case'),{recursive:true});writeFileSync(backup,original);
 const pending=join(f.project,'_harness/face/native-import-pending.json');
 const record={schema:'face-native-import-transaction/0.1',modelPath:'Assets/Source/source.fbx',backup:'_harness/face/native-import/case/original.fbx',originalSha256:hash(model),candidateSha256:createHash('sha256').update(candidate).digest('hex'),metaSha256:hash(meta)};
 const script='import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import face;print(face.recover_native_import(Path(sys.argv[2])))';
 const recover=()=>spawnSync(python,['-c',script,f.tools,f.project],{encoding:'utf8',windowsHide:true});
 writeFileSync(model,candidate);serialize(pending,record);assert.equal(recover().status,0);assert.deepEqual(readFileSync(model),original);assert.equal(existsSync(pending),false);
 writeFileSync(model,'unrelated edit');serialize(pending,record);const refused=recover();assert.notEqual(refused.status,0);assert.match(refused.stderr,/refuses changed/);assert.equal(readFileSync(model,'utf8'),'unrelated edit');assert.equal(existsSync(pending),true);
});

function manualFixture(t: test.TestContext, overrides: Json = {}) {
  const f = fixture(t), script = join(f.root, 'fixture.py'); writeFileSync(script, fbxFixture);
  const made = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '2', '--python', script, '--', f.project], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  const o = observed(f, overrides);
  succeeded(run(f, 'manual-open', ['--target-id', o.targetId, '--blender', blender]));
  const directory = join(f.project, '_harness/manual-face');
  const edit = (code: string) => {
    const script = join(f.root, 'user.py');
    writeFileSync(script, `import bpy,sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[-1],use_scripts=False)\nobj=bpy.data.objects['Face']\n${code}\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1],check_existing=False)\n`);
    const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '2', '--python', script, '--', join(directory, 'edit.blend')], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    copyFileSync(join(directory, 'edit.blend'), join(directory, 'submitted.blend'));
  };
  const done = () => run(f, 'manual-execute', ['--blender', blender], {
    AVH_MANUAL_FACE_HANDOFF_SHA256: hash(join(directory, 'handoff.json')),
    AVH_MANUAL_FACE_BASELINE_SHA256: hash(join(directory, 'baseline.json')),
    AVH_MANUAL_FACE_SUBMITTED_SHA256: hash(join(directory, 'submitted.blend')),
  });
  return { ...f, o, directory, edit, done };
}

test('manual saved key values use the actual shared combination, compensation, FBX and independent readback path', { skip: !existsSync(blender) }, t => {
  const f = manualFixture(t), original = hash(join(f.project, 'Assets/Source/source.fbx'));
  f.edit("obj.data.shape_keys.key_blocks['Contour'].value=.25\nobj.data.shape_keys.key_blocks['Contour'].slider_min=-1");
  const result = succeeded(f.done()); assert.match(result.candidateId, /^manual-/); assert.equal(result.productionAccepted, false);
  const values = read(join(f.directory, 'values.json')); assert.equal(values.values.Contour, .25);
  assert.deepEqual(values.rangeOverrides.Contour, { originalMin: 0, originalMax: 1, newMin: -1, newMax: 1 });
  assert.equal(values.values.Runtime, undefined);
  const unity = read(join(f.project, 'Assets/_Harness/Face/design.json'));
  assert.equal(unity.mode, 'design'); assert.equal(unity.weightsUnityPercent.Contour, 25); assert.equal(unity.gateId, 'manual_done');
  const receipt = read(join(f.project, unity.candidateReceipt.file)); assert.ok(receipt.compensation); assert.deepEqual(receipt.retainedKeyNames, ['Contour', 'Runtime']);
  assert.equal(existsSync(join(f.project, unity.candidateReceipt.file.replace('candidate.json', 'candidate.fbx'))), true);
  assert.equal(read(join(f.project, unity.blenderVerification.file)).productionAccepted, false);
  assert.equal(hash(join(f.project, 'Assets/Source/source.fbx')), original);
  const accepted = join(f.project, '_harness/face/accepted-manual.json');
  copyFileSync(join(f.directory, 'values.json'), accepted);
  failed(run(f, 'execute', ['--blender', blender], { AVH_FACE_MODE: 'manual' }), /已接受手动脸型的 Runtime 授权/);
  const adopted = succeeded(run(f, 'execute', ['--blender', blender], { AVH_FACE_MODE: 'manual', AVH_ACCEPTED_MANUAL_FACE_SHA256: hash(accepted) }));
  assert.equal(adopted.candidateId, result.candidateId);
  assert.equal(adopted.reused, true, 'accepted input uses the same immutable compensation and FBX output');
  failed(run(f, 'candidates', ['--blender', blender]), /Runtime 冻结的输入授权/);
  const frozenValues = read(join(f.directory, 'values.json'));
  frozenValues.values.Contour = .9; writeFileSync(join(f.directory, 'values.json'), JSON.stringify(frozenValues));
  failed(f.done(), /冻结键值与独立重读结果不一致/);
});

test('manual handoff rejects actual saved mesh edits before any candidate is produced', { skip: !existsSync(blender) }, t => {
  const f = manualFixture(t); f.edit('obj.data.vertices[0].co.x+=.01');
  failed(f.done(), /有警告未采纳.*网格/); assert.equal(existsSync(join(f.directory, 'values.json')), false);
  assert.equal(existsSync(join(f.project, 'Assets/_Harness/Face/Candidates')), false);
});

test('manual handoff rejects actual protected key values and protected range edits before baking', { skip: !existsSync(blender) }, t => {
  const f = manualFixture(t); f.edit("obj.data.shape_keys.key_blocks['Runtime'].value=.5");
  failed(f.done(), /有警告未采纳.*受保护表情键.*Runtime/); assert.equal(existsSync(join(f.directory, 'values.json')), false);
  assert.equal(existsSync(join(f.project, 'Assets/_Harness/Face/Candidates')), false);
  f.edit("obj.data.shape_keys.key_blocks['Runtime'].value=.25\nobj.data.shape_keys.key_blocks['Runtime'].slider_min=-1");
  failed(f.done(), /有警告未采纳.*受保护表情键.*Runtime/);
});

test('manual handoff rejects actual shape-key vertex edits and unauthorized saved input before baking', { skip: !existsSync(blender) }, t => {
  const f = manualFixture(t); f.edit("obj.data.shape_keys.key_blocks['Contour'].data[0].co.x+=.01");
  failed(run(f, 'manual-execute', ['--blender', blender]), /缺少当前 Runtime 授权/);
  failed(f.done(), /有警告未采纳.*网格.*形态键顶点/);
  assert.equal(existsSync(join(f.project, 'Assets/_Harness/Face/Candidates')), false);
});

test('manual handoff missing Blender provides a Chinese install requirement and retry entry without changing the source', t => {
  const f = fixture(t), o = observed(f), original = hash(join(f.project, 'Assets/Source/source.fbx'));
  failed(run(f, 'manual-open', ['--target-id', o.targetId, '--blender', join(f.root, 'missing-blender')]), /未找到 Blender.*4\.2.*重新检测.*blender.org\/download/);
  assert.equal(hash(join(f.project, 'Assets/Source/source.fbx')), original);
  assert.equal(existsSync(join(f.project, '_harness/manual-face/edit.blend')), false);
});

test('manual handoff always opens all-protected source keys for viewing and rejects adoption without a design key', { skip: !existsSync(blender) }, t => {
  const f = manualFixture(t, { protectedKeys: ['Contour', 'Runtime'] });
  assert.ok(existsSync(join(f.directory, 'edit.blend')));
  assert.deepEqual(read(join(f.directory, 'baseline.json')).editable, []);
  f.edit('pass');
  failed(f.done(), /没有可采纳的造型键.*全部受保护/);
  assert.equal(existsSync(join(f.directory, 'values.json')), false);
});
