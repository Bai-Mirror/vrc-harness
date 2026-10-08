import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const windows = process.platform === 'win32';
const blender = process.env.AVH_TEST_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const python = process.env.AVH_TEST_PYTHON ?? 'python';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));

function run(root: string, script: string, args: string[]) {
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '2', '--python', script, '--', ...args], {
    windowsHide: true, encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, BLENDER_USER_CONFIG: join(root, 'config'), BLENDER_USER_SCRIPTS: join(root, 'scripts'), BLENDER_USER_DATAFILES: join(root, 'data'), PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.error, undefined, String(result.error));
  return { status: result.status, output: result.stdout + result.stderr };
}

// Six synthetic vertices exercise native filesystem/import/export behavior, not avatar or aesthetic acceptance.
const fixture = `import bpy,sys
from pathlib import Path
root=Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.read_factory_settings(use_empty=True)
mesh=bpy.data.meshes.new('PathFixture');mesh.from_pydata([(-.03,0,-.003),(-.03,0,.003),(0,0,.003),(0,0,-.003),(.03,0,.003),(.03,0,-.003)],[],[(0,1,2,3),(3,2,4,5)])
mesh.update();obj=bpy.data.objects.new('PathFixture',mesh);bpy.context.collection.objects.link(obj)
bpy.context.view_layer.objects.active=obj;obj.select_set(True)
obj.shape_key_add(name='Basis');shape=obj.shape_key_add(name='FixtureShape');left=obj.shape_key_add(name='FixtureRuntimeLeft');right=obj.shape_key_add(name='FixtureRuntimeRight')
for v in shape.data:v.co.x+=.001 if v.co.x>0 else -.001 if v.co.x<0 else 0
for i in [0,1]:left.data[i].co.z=0
for i in [4,5]:right.data[i].co.z=0
uv=mesh.uv_layers.new(name='UV')
for loop in mesh.loops:uv.data[loop.index].uv=(loop.vertex_index/2,loop.vertex_index%2)
bpy.ops.export_scene.fbx(filepath=str(root/'fixture.fbx'),use_selection=True,object_types={'MESH'},bake_anim=False,use_mesh_modifiers=False)
`;

test('actual Windows Blender long paths retain canonical source, immutable outputs and independent native FBX readback', { skip: !windows || !existsSync(blender) }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-blender-long-')); t.after(() => removeTemp(root));
  const seed = join(root, 'fixture.py'); writeFileSync(seed, fixture);
  let result = run(root, seed, [root]); assert.equal(result.status, 0, result.output);
  const project = join(root, 'project-' + 'x'.repeat(100), 'workspace-' + 'y'.repeat(75));
  const source = join(project, 'Assets/Source/fixture.fbx'); mkdirSync(join(project, 'Assets/Source'), { recursive: true });
  copyFileSync(join(root, 'fixture.fbx'), source); assert(source.length > 260);
  const before = hash(source), output = join(project, 'Assets/_Harness/Face/Catalogs', 'a'.repeat(64), 'catalog.json');
  const producer = join(tools, 'blender_face.py'), observer = join(tools, 'blender_face_observe.py');
  const args = ['catalog', '--source', source, '--output', output, '--evidence-output', join(project, 'Assets/_Harness/Face/Catalogs', 'a'.repeat(64), 'source-evidence.json'), '--project-root', project];
  result = run(root, producer, args); assert.equal(result.status, 0, result.output);
  const catalog = read(output), mesh = catalog.meshes[0], key = mesh.keys[1].id, left = mesh.keys[2].id, right = mesh.keys[3].id;
  assert.equal(catalog.source.path, realpathSync(source)); assert.equal(catalog.source.sha256, before);
  assert(!catalog.source.path.startsWith('\\\\?\\')); const catalogSha = hash(output);
  result = run(root, producer, args); assert.equal(result.status, 2); assert.match(result.output, /Output already exists/); assert.equal(hash(output), catalogSha);
  const design: any = { schema: 'face-design/0.1', revisionId: 'private-path-fixture-only', source: { ...catalog.source, catalogSha256: catalog.catalogSha256, meshId: mesh.meshId },
    units: { weights: 'blender-relative', geometry: 'meters' }, values: { [key]: .25 }, bake: [key], preserve: [left, right],
    recipe: { id: 'private-path-fixture', version: '1', sourceSha256: before, designKeys: [key], runtimeKeys: [left, right], eyeChecks: { status: 'measured', regions: [
      { side: 'left', pairs: [[1, 0]], axis: [0, 0, 1], closedMaxGapMeters: .000001, openMinGapMeters: .005, states: [{ kind: 'open', weights: {} }, { kind: 'closed', weights: { [left]: 1 } }] },
      { side: 'right', pairs: [[4, 5]], axis: [0, 0, 1], closedMaxGapMeters: .000001, openMinGapMeters: .005, states: [{ kind: 'open', weights: {} }, { kind: 'closed', weights: { [right]: 1 } }] },
    ] } }, acceptance: { positionToleranceMeters: 1e-6, deltaToleranceMeters: 1e-6, uvTolerance: 1e-6, weightTolerance: 1e-6 }, requiredChecks: ['geometry'] };
  const designFile = join(project, 'Assets/_Harness/Face/Revisions', 'b'.repeat(64), 'design.json');
  mkdirSync(join(project, 'Assets/_Harness/Face/Revisions', 'b'.repeat(64)), { recursive: true }); writeFileSync(designFile, JSON.stringify(design));
  const candidate = join(project, 'Assets/_Harness/Face/Candidates', 'c'.repeat(64));
  result = run(root, producer, ['bake', '--design', designFile, '--output-dir', candidate]); assert.equal(result.status, 0, result.output);
  const receipt = read(join(candidate, 'candidate.json')); assert.equal(receipt.productionAccepted, false);
  assert.equal(receipt.source.path, realpathSync(source));
  for (const ref of Object.values(receipt.outputs) as any[]) assert.equal(hash(join(candidate, ref.file)), ref.sha256);
  const verification = join(project, 'Assets/_Harness/Face/Catalogs', 'a'.repeat(64), 'verification.json');
  result = run(root, observer, ['--design', designFile, '--candidate-dir', candidate, '--output', verification]); assert.equal(result.status, 0, result.output);
  assert.equal(read(verification).productionAccepted, false); assert.equal(hash(source), before);
  const binaryProbe = join(root, 'binary-probe.py');
  writeFileSync(binaryProbe, `import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[sys.argv.index('--')+1])
import blender_face_common as common
common.COMPACT_FRAME_POINT_LIMIT=0
project=common.Path(sys.argv[sys.argv.index('--')+2]);source=project/'Assets/Source/fixture.fbx'
catalog=common.catalog(source);directory=project/'Assets/_Harness/Face/Catalogs'/'${'d'.repeat(64)}'
evidence=common.source_evidence(source,catalog['catalogSha256'],project,directory/'frames',True)
common.write_json(directory/'binary-evidence.json',evidence)
count=0
for mesh in evidence['meshes']:
 for key in mesh['keys']:
  for field in ('coordinates','cornerNormals','vertexNormals'):
   ref=key[field]
   if isinstance(ref,dict):
    path=project/ref['file'];assert path.is_file() and path.stat().st_size==ref['count']*12 and common.digest(path)==ref['sha256'];count+=1
assert count==12
print(json.dumps({'binaryRefsVerified':count}))
`);
  result = run(root, binaryProbe, [tools, project]); assert.equal(result.status, 0, result.output); assert.match(result.output, /"binaryRefsVerified": 12/);
  design.source.sha256 = '0'.repeat(64); const invalid = join(project, 'Assets/_Harness/Face/Revisions', 'b'.repeat(64), 'invalid.json'); writeFileSync(invalid, JSON.stringify(design));
  const rejected = join(project, 'Assets/_Harness/Face/Catalogs', 'a'.repeat(64), 'must-not-exist.json');
  result = run(root, producer, ['validate', '--design', invalid, '--output', rejected]); assert.equal(result.status, 2); assert.match(result.output, /Source\/catalog identity changed/); assert(!existsSync(rejected));
});

test('Windows face managed paths refuse external and internal child junctions and extended absolute input', { skip: !windows }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-face-path-guards-')); t.after(() => removeTemp(root));
  const project = join(root, 'project'), inside = join(project, 'Assets/Source'), outside = join(root, 'outside');
  mkdirSync(inside, { recursive: true }); mkdirSync(outside);
  writeFileSync(join(inside, 'source.fbx'), 'unit path guard only'); writeFileSync(join(outside, 'source.fbx'), 'must not be read');
  const script = `import importlib.util,pathlib,sys
s=importlib.util.spec_from_file_location('face',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
try:m.managed(pathlib.Path(sys.argv[2]).resolve(),sys.argv[3]);raise RuntimeError('unauthorized path accepted')
except ValueError:print('REFUSED')`;
  const refused = (relative: string) => { const r = spawnSync(python, ['-c', script, join(tools, 'face.py'), project, relative], { windowsHide: true, encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /REFUSED/); };
  refused('../outside/source.fbx'); refused('\\\\?\\C:\\Windows');
  for (const [name, target] of [['internal', inside], ['external', outside]]) {
    const link = join(project, 'Assets', name); symlinkSync(target, link, 'junction');
    try { refused(`Assets/${name}/source.fbx`); }
    finally { assert.equal(realpathSync(link).toLowerCase(), realpathSync(target).toLowerCase()); rmdirSync(link); }
  }
});
