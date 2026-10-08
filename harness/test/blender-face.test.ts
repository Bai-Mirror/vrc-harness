import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

// An actual optional Blender integration test, never a simulated bpy/FBX result.
const blender = process.env.AVH_TEST_BLENDER ?? (process.platform === 'win32'
  ? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' : '/usr/bin/blender');
const tool = fileURLToPath(new URL('../builtin/tools/harness/blender_face.py', import.meta.url));
const observer = fileURLToPath(new URL('../builtin/tools/harness/blender_face_observe.py', import.meta.url));
const sourceMapping = fileURLToPath(new URL('../builtin/tools/harness/blender_face_mapping.py', import.meta.url));
type Json = Record<string, any>;
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'));

function run(root: string, script: string, args: string[]) {
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '2', '--python', script, '--', ...args], {
    encoding: 'utf8', timeout: 90_000, windowsHide: true,
    env: { ...process.env, BLENDER_USER_CONFIG: join(root, 'blender-config'), BLENDER_USER_SCRIPTS: join(root, 'blender-scripts'), BLENDER_USER_DATAFILES: join(root, 'blender-data') },
  });
  assert.equal(result.error, undefined, String(result.error));
  return { status: result.status, output: result.stdout + result.stderr };
}

function success(result: ReturnType<typeof run>) { assert.equal(result.status, 0, result.output); }
function fails(result: ReturnType<typeof run>, message: RegExp) {
  assert.equal(result.status, 2, result.output); assert.match(result.output, message);
}

const fixtureScript = `
import bpy,sys
from pathlib import Path
root=Path(sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.read_factory_settings(use_empty=True)
mesh=bpy.data.meshes.new('VerifiedFaceMesh')
mesh.from_pydata([(-.03,0,-.003),(-.03,0,.003),(0,0,.003),(0,0,-.003),(.03,0,.003),(.03,0,-.003)],[],[(0,1,2,3),(3,2,4,5)])
mesh.update();obj=bpy.data.objects.new('Face',mesh);bpy.context.collection.objects.link(obj)
bpy.context.view_layer.objects.active=obj;obj.select_set(True)
uv=mesh.uv_layers.new(name='FaceUV')
for poly in mesh.polygons:
 for i in poly.loop_indices:
  v=mesh.vertices[mesh.loops[i].vertex_index];uv.data[i].uv=((v.co.x+.03)/.06,(v.co.z+.003)/.006)
mesh.materials.append(bpy.data.materials.new('Skin'));mesh.materials.append(bpy.data.materials.new('Lips'));mesh.polygons[1].material_index=1
basis=obj.shape_key_add(name='Basis');design=obj.shape_key_add(name='ContourWidth');left=obj.shape_key_add(name='VendorOriginalKeyA');right=obj.shape_key_add(name='VendorOriginalKeyB')
design.slider_min=-1;design.slider_max=2;design.value=.3
left.value=.25;left.slider_min=-1;left.slider_max=2
for v in design.data:v.co.x+=.002 if v.co.x>0 else -.002 if v.co.x<0 else 0
for i in [0,1]:left.data[i].co.z=0
for i in [4,5]:right.data[i].co.z=0
rigdata=bpy.data.armatures.new('FaceSkeleton');rig=bpy.data.objects.new('Rig',rigdata);bpy.context.collection.objects.link(rig)
obj.select_set(False);rig.select_set(True);bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='EDIT')
head=rigdata.edit_bones.new('Head');head.head=(0,0,0);head.tail=(0,0,.1)
bpy.ops.object.mode_set(mode='OBJECT');obj.parent=rig;mod=obj.modifiers.new('Skinning','ARMATURE');mod.object=rig
group=obj.vertex_groups.new(name='Head');group.add(list(range(6)),1,'REPLACE')
bpy.ops.wm.save_as_mainfile(filepath=str(root/'source.blend'))
`;

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-blender-face-test-')); t.after(() => removeTemp(root));
  const script = join(root, 'fixture.py'); writeFileSync(script, fixtureScript); success(run(root, script, [root]));
  const source = join(root, 'source.blend'), catalogPath = join(root, 'catalog.json');
  success(run(root, tool, ['catalog', '--source', source, '--output', catalogPath]));
  const catalog = read(catalogPath), mesh = catalog.meshes[0], key = (name: string) => mesh.keys.find((k: Json) => k.name === name).id;
  const designKey = key('ContourWidth'), left = key('VendorOriginalKeyA'), right = key('VendorOriginalKeyB');
  const design: Json = {
    schema: 'face-design/0.1', revisionId: 'draft-approved-1',
    source: { ...catalog.source, catalogSha256: catalog.catalogSha256, meshId: mesh.meshId },
    units: { weights: 'blender-relative', geometry: 'meters' },
    values: { [designKey]: -.5 }, bake: [designKey], preserve: [left, right],
    recipe: { id: 'synthetic-fixture', version: '1', sourceSha256: catalog.source.sha256,
      designKeys: [designKey], runtimeKeys: [left, right], eyeChecks: { status: 'measured', regions: [
        { side: 'left', pairs: [[1, 0]], axis: [0, 0, 1], closedMaxGapMeters: .000001, openMinGapMeters: .005,
          states: [{ kind: 'open', weights: {} }, { kind: 'closed', weights: { [left]: 1 } }] },
        { side: 'right', pairs: [[4, 5]], axis: [0, 0, 1], closedMaxGapMeters: .000001, openMinGapMeters: .005,
          states: [{ kind: 'open', weights: {} }, { kind: 'closed', weights: { [right]: 1 } }] },
      ] } },
    acceptance: { positionToleranceMeters: .000001, deltaToleranceMeters: .000001, uvTolerance: .000001, weightTolerance: .000001 },
    requiredChecks: ['geometry', 'closedEyes'],
  };
  const designPath = join(root, 'design.json'); writeFileSync(designPath, JSON.stringify(design));
  return { root, source, catalog, mesh, design, designPath, designKey, left, right };
}

test('source render-corner mapping permits UV/material splits and rejects real attribute drift, ambiguity and forged readback', { skip: !existsSync(blender) }, t => {
  const f = fixture(t), evidencePath = join(f.root, 'source-evidence.json'), catalogPath = join(f.root, 'mapping-catalog.json');
  success(run(f.root, tool, ['catalog', '--source', f.source, '--output', catalogPath, '--evidence-output', evidencePath]));
  assert.equal(read(evidencePath).meshes[0].meshId, read(catalogPath).meshes[0].meshId);
  const script = join(f.root, 'mapping-check.py');
  writeFileSync(script, `import sys,json,copy,struct\nfrom pathlib import Path\nsys.dont_write_bytecode=True\nsys.path.insert(0,str(Path(sys.argv[-2]).parent))\nfrom blender_face_mapping import match,vectors_hash,frame_facts,verify_source_mapping\nfrom blender_face_common import digest\nroot=Path(sys.argv[-1]);mesh=json.loads((root/'source-evidence.json').read_text())['meshes'][0]\nbasis=mesh['keys'][0]['coordinates'];keys=mesh['keys'][1:];count=sum(len(p['vertices']) for p in mesh['polygons'])\nf32=lambda v:struct.unpack('<f',struct.pack('<f',v))[0]\nvertices=[];normals=[];uv=[];control=[];subs=[{'topology':'Triangles','indices':[]} for _ in mesh['materials']]\nfor pi,p in enumerate(mesh['polygons']):\n offset=len(vertices)\n for ci,vi in enumerate(p['vertices']):\n  vertices.append([f32(v*.01) for v in basis[vi]]);normals.append(mesh['cornerNormals'][pi][ci]);uv.append(p['uv']['FaceUV'][ci]+[0,0]);control.append(vi)\n for ci in range(1,len(p['vertices'])-1):subs[p['material']]['indices'] += [offset,offset+ci,offset+ci+1]\nframes=[];snapkeys=[]\nfor k in keys:\n delta=[[f32((k['coordinates'][vi][a]-basis[vi][a])*.01) for a in range(3)] for vi in control];zero=[[0,0,0] for _ in control]\n frames.append({'name':k['name'],'frames':[{'weight':100,'vertices':delta,'normals':zero,'tangents':zero}]})\n snapkeys.append({'name':k['name'],'frames':[{'weight':100,**{a+'Sha256':vectors_hash(v) for a,v in [('vertices',delta),('normals',zero),('tangents',zero)]}}]})\ntarget={'targetId':'actual-synthetic-source','meshSha256':'frozen-actual-mesh','mesh':{'path':'source.blend','sha256':digest(root/'source.blend')},'rendererPath':'Face','rendererIndex':0,'bones':['Rig/Head'],'worldMatrix':[100,0,0,0,0,100,0,0,0,0,100,0,0,0,0,1],'meshSnapshot':{'vertices':vertices,'normals':normals,'keys':snapkeys,'uv':[uv]+[[]]*7,'weights':{'counts':[1]*count,'values':[{'bone':0,'weight':1} for _ in control]},'submeshes':subs}}\nevidence={'schema':'face-unity-frame-evidence/0.1','meshSha256':target['meshSha256'],'sourceModel':target['mesh'],'rendererPath':'Face','rendererIndex':0,'bones':[{'index':0,'name':'Head','path':'Rig/Head'}],'frames':frames}\nproof=match(mesh,target,evidence);assert len(proof['unityToBlenderVertex'])==8 and len(set(proof['unityToBlenderVertex']))==6;assert proof['unityToBlenderVertex']==control\nchecks=0\ndef refuse(m,t,e):\n global checks\n try:match(m,t,e)\n except ValueError:checks+=1;return\n raise AssertionError('Altered source facts passed')\nt=copy.deepcopy(target);t['meshSnapshot']['uv'][0][0][0]+=.01;refuse(mesh,t,evidence)\nt=copy.deepcopy(target);t['meshSnapshot']['normals'][0]=[1,0,0];refuse(mesh,t,evidence)\nt=copy.deepcopy(target);t['meshSnapshot']['weights']['values'][0]['weight']=.5;refuse(mesh,t,evidence)\ne=copy.deepcopy(evidence);e['frames'][0]['frames'][0]['vertices'][0][0]+=.0001;t=copy.deepcopy(target);t['meshSnapshot']['keys'][0]['frames'][0]['verticesSha256']=vectors_hash(e['frames'][0]['frames'][0]['vertices']);refuse(mesh,t,e)\nt=copy.deepcopy(target);t['meshSnapshot']['submeshes'][0]['indices'][1:3]=reversed(t['meshSnapshot']['submeshes'][0]['indices'][1:3]);refuse(mesh,t,evidence)\nm=copy.deepcopy(mesh);m['polygons'].append(copy.deepcopy(m['polygons'][0]));m['cornerNormals'].append(copy.deepcopy(m['cornerNormals'][0]));refuse(m,target,evidence)\ne=copy.deepcopy(evidence);e['frames'][0]['frames'][0]['normals'][0][0]=1;refuse(mesh,target,e)\n# Actual float32 bytes are consumed and hashed, rather than trusting their JSON SHA.\ne=copy.deepcopy(evidence)\nfor key in e['frames']:\n for field in ['vertices','normals','tangents']:\n  values=key['frames'][0][field];sha=vectors_hash(values);path=root/(sha+'.bin');path.write_bytes(b''.join(struct.pack('<fff',*v) for v in values));key['frames'][0][field]={'file':path.name,'sha256':sha,'encoding':'float32-le','count':count}\nassert match(mesh,target,e,root)==proof\nbad=copy.deepcopy(e);bad['frames'][0]['frames'][0]['vertices']['file']='missing.bin'\ntry:frame_facts(target,bad,root)\nexcept (ValueError,FileNotFoundError):checks+=1\nelse:raise AssertionError('Missing binary accepted')\n(root/'result.json').write_text(json.dumps({'checks':checks,'sourceControlPoints':6,'renderVertices':8,'mapping':proof,'productionAccepted':False}))\n`);
  const independentCheck = `
# Recompute the immutable mapping from source files in a fresh readback path.
from blender_face_mapping import map_source
directory=root/'_harness'/'face';directory.mkdir(parents=True)
unity_file=directory/'source-evidence.json';unity_file.write_text(json.dumps(evidence))
target['frameEvidence']={'file':unity_file.relative_to(root).as_posix(),'sha256':digest(unity_file)}
obs=directory/'observation.json';obs.write_text(json.dumps({'targets':[target]}))
mapping_file=root/'source-mapping.json'
map_source(obs,target['targetId'],root/'mapping-catalog.json',root/'source-evidence.json',mapping_file)
verify_source_mapping(mapping_file,obs,root/'mapping-catalog.json')
forged=json.loads(mapping_file.read_text());forged['unityToBlenderVertex'][0]=1
mapping_file.write_text(json.dumps(forged))
try:verify_source_mapping(mapping_file,obs,root/'mapping-catalog.json')
except ValueError:checks+=1
else:raise AssertionError('Rewritten correspondence report passed independent readback')
# Exercise the real binary authoring/readback path at a small scale without
# allocating a commercial avatar's millions of native source frame points.
import blender_face_common as common
common.COMPACT_FRAME_POINT_LIMIT=1
binary_directory=root/'Assets'/'_Harness'/'Face'/'Catalogs'/'binary-test'/'frames'
binary_evidence=common.source_evidence(root/'source.blend',json.loads((root/'mapping-catalog.json').read_text())['catalogSha256'],root,binary_directory,True)
assert binary_evidence['meshes'][0]['meshId']==mesh['meshId']
binary_file=binary_directory.parent/'source-evidence.json';binary_file.write_text(json.dumps(binary_evidence))
binary_mapping=binary_directory.parent/'source-mapping.json'
map_source(obs,target['targetId'],root/'mapping-catalog.json',binary_file,binary_mapping)
verify_source_mapping(binary_mapping,obs,root/'mapping-catalog.json')
ref=binary_evidence['meshes'][0]['keys'][1]['coordinates'];(root/ref['file']).write_bytes(b'bad')
try:verify_source_mapping(binary_mapping,obs,root/'mapping-catalog.json')
except ValueError:checks+=1
else:raise AssertionError('Changed binary Blender source frame accepted')
# Imported source frames remain authoritative, while raw native frames remain
# available. This models a measured import discrepancy, without guessing why.
common.COMPACT_FRAME_POINT_LIMIT=200000
coordinated=copy.deepcopy(evidence);coordinated['frames'][0]['frames'][0]['vertices'][0][0]+=.000000075
controlled_target=copy.deepcopy(target)
controlled_target['meshSnapshot']['keys'][0]['frames'][0]['verticesSha256']=vectors_hash(coordinated['frames'][0]['frames'][0]['vertices'])
source_frames=directory/'imported-source-evidence.json';source_frames.write_text(json.dumps(coordinated))
controlled_target['frameEvidence']={'file':source_frames.relative_to(root).as_posix(),'sha256':digest(source_frames)}
imported_obs=directory/'imported-observation.json';imported_obs.write_text(json.dumps({'targets':[controlled_target]}))
imported_mapping=root/'imported-mapping.json'
measured=map_source(imported_obs,controlled_target['targetId'],root/'mapping-catalog.json',root/'source-evidence.json',imported_mapping)
assert measured['frameSemantics']['coordinatedControlPoints']==6
assert measured['frameSemantics']['rawNativeMaxResidualMeters']>.000007
verify_source_mapping(imported_mapping,imported_obs,root/'mapping-catalog.json')
design=json.loads((root/'design.json').read_text())
design['recipe']['sourceCorrespondence']={'schema':'face-source-correspondence/0.1','projectRoot':str(root),'sourceMapping':{'file':imported_mapping.name,'sha256':digest(imported_mapping)},'observation':{'file':imported_obs.relative_to(root).as_posix(),'sha256':digest(imported_obs)},'blenderCatalog':{'file':'mapping-catalog.json','sha256':digest(root/'mapping-catalog.json')}}
_,effective,expected,_=common.validate_design(design)
key=effective['keys'][1];raw_key=mesh['keys'][1]
assert abs((float(key['coordinates'][0][0])-raw_key['coordinates'][0][0])-.0000075)<1e-7
bad=copy.deepcopy(coordinated);duplicate=control.index(3,4)
bad['frames'][0]['frames'][0]['vertices'][duplicate][0]+=.000001
controlled_target['meshSnapshot']['keys'][0]['frames'][0]['verticesSha256']=vectors_hash(bad['frames'][0]['frames'][0]['vertices'])
source_frames.write_text(json.dumps(bad));controlled_target['frameEvidence']['sha256']=digest(source_frames)
imported_obs.write_text(json.dumps({'targets':[controlled_target]}))
try:map_source(imported_obs,controlled_target['targetId'],root/'mapping-catalog.json',root/'source-evidence.json',root/'contradictory-import.json')
except ValueError:checks+=1
else:raise AssertionError('Contradictory imported deltas at one native control point accepted')
`;
  writeFileSync(script, readFileSync(script, 'utf8').replace("(root/'result.json').write_text", `${independentCheck}\n(root/'result.json').write_text`));
  success(run(f.root, script, [sourceMapping, f.root]));
  const result = read(join(f.root, 'result.json'));
  assert.equal(result.checks, 11); assert.equal(result.productionAccepted, false);
  assert.equal(hash(f.source), f.catalog.source.sha256);
});

test('imported registration applies frozen skin pruning without relaxing geometry, rig or weight checks', { skip: !existsSync(blender) }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-face-skin-import-')); t.after(() => removeTemp(root));
  const script = join(root, 'skin-import.py');
  writeFileSync(script, `
import sys,copy,json
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(sys.argv[-2]).parent))
from blender_face_mapping import imported_coordinate_matrix
identity=[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]
points=[[0,0,0],[.01,0,0],[0,.02,0],[0,0,.03],[.004,.006,.009]]
names=['Head','Cheek','Jaw','Brow','Lip','Eye']
native={'vertices':points,'worldMatrix':identity,'bones':[{'name':n,'headWorld':[0,0,.01*i]} for i,n in enumerate(names)],'weights':[{'Head':.999997746,'Cheek':.000002254} for _ in points]}
evidence={'bones':[{'index':i,'name':n,'path':'Rig/'+n,'meshLocalPosition':[0,0,.01*i]} for i,n in enumerate(names)],'importer':{'skinWeights':'Standard','maxBonesPerVertex':4,'minBoneWeight':.001}}
target={'bones':['Rig/'+n for n in names],'worldMatrix':sum(identity,[]),'meshSnapshot':{'vertices':copy.deepcopy(points),'weights':{'counts':[1]*len(points),'values':[{'bone':0,'weight':1} for _ in points]}}}
checks=0
def passed():
 global checks
 proof={};m=imported_coordinate_matrix(native,target,evidence,proof)
 assert [list(r) for r in m]==[[1,0,0],[0,1,0],[0,0,1]]
 assert proof['matchedVertices']==len(points) and proof['maxWeightError']<=1e-6
 checks+=1
def rejected(fragment):
 global checks
 try:imported_coordinate_matrix(native,target,evidence)
 except ValueError as error:assert fragment in str(error),str(error);checks+=1
 else:raise AssertionError('Unsupported or changed source accepted: '+fragment)
def weights(value):
 target['meshSnapshot']['weights']={'counts':[len(value)]*len(points),'values':[{'bone':names.index(n),'weight':w} for _ in points for n,w in value.items()]}
passed()
saved=copy.deepcopy(evidence['importer']);evidence.pop('importer');rejected('skinImportPolicyObserved');evidence['importer']=copy.deepcopy(saved)
for field,value in [('minBoneWeight',float('nan')),('minBoneWeight',-1),('minBoneWeight',2),('maxBonesPerVertex',0),('maxBonesPerVertex',256),('maxBonesPerVertex',True),('skinWeights','Other')]:
 evidence['importer'][field]=value;rejected('Invalid observed skin import policy');evidence['importer']=copy.deepcopy(saved)
del evidence['importer']['minBoneWeight'];rejected('Incomplete observed skin import policy');evidence['importer']=copy.deepcopy(saved)
target['meshSnapshot']['vertices'][4][0]+=.00002;rejected('positions');target['meshSnapshot']['vertices']=copy.deepcopy(points)
evidence['bones'][1]['meshLocalPosition'][0]+=.001;rejected('boneOrigins');evidence['bones'][1]['meshLocalPosition'][0]=0
weights({'Jaw':1});rejected('skinWeights');weights({'Head':1})
native['weights']=[{'Head':.8,'Cheek':.2} for _ in points];rejected('skinWeights')
evidence['importer']={'skinWeights':'Custom','maxBonesPerVertex':1,'minBoneWeight':.1};passed()
evidence['importer']={'skinWeights':'Custom','maxBonesPerVertex':2,'minBoneWeight':.3};passed()
evidence['importer']['minBoneWeight']=.9;passed()
native['weights']=[{'Head':.4,'Cheek':.2,'Jaw':.2,'Brow':.1,'Lip':.1} for _ in points]
evidence['importer']={'skinWeights':'Standard','maxBonesPerVertex':1,'minBoneWeight':.2}
weights({'Head':4/9,'Cheek':2/9,'Jaw':2/9,'Lip':1/9});passed()
weights({'Head':4/9,'Cheek':2/9,'Jaw':2/9,'Brow':1/9});passed()
weights({'Head':.5,'Cheek':.25,'Brow':.125,'Lip':.125});rejected('skinWeights')
evidence['importer']={'skinWeights':'Custom','maxBonesPerVertex':6,'minBoneWeight':0};weights(native['weights'][0]);passed()
weights({'Head':.4,'Cheek':.2,'Jaw':.2,'Brow':.10000763088464737,'Lip':.09999237209558487});rejected('skinWeights')
weights({'Head':.4001,'Cheek':.1999,'Jaw':.2,'Brow':.1,'Lip':.1});rejected('skinWeights')
native['weights']=[{'Head':.5,'Cheek':.5} for _ in points];evidence['importer']['minBoneWeight']=.9;weights({'Cheek':1});passed()
weights({'Head':1});passed()
native['weights']=[{} for _ in points];weights({});passed()
(Path(sys.argv[-1])/'result.json').write_text(json.dumps({'checks':checks}))
`);
  success(run(root, script, [sourceMapping, root]));
  assert.equal(read(join(root, 'result.json')).checks, 26);
});

test('new imported-source reconstruction is refused by the real CLI', { skip: !existsSync(blender) }, t => {
  const f=fixture(t);
  fails(run(f.root,tool,['import-source','--observation','missing','--target-id','historical','--native-catalog','missing','--native-evidence','missing','--output-dir',join(f.root,'forbidden')]),/historical evidence only/);
  assert.equal(existsSync(join(f.root,'forbidden')),false);
});

test('actual Blender bakes a negative design value, independently preserves UV/materials/bones/runtime deltas and tagged eye controls', { skip: !existsSync(blender) }, t => {
  const f = fixture(t), original = hash(f.source), output = join(f.root, 'candidate');
  assert.equal(f.mesh.keys[1].sliderMin, -1); assert.equal(f.mesh.keys[1].sliderMax, 2);
  assert.equal(f.mesh.keys[2].name, 'VendorOriginalKeyA');
  success(run(f.root, tool, ['bake', '--design', f.designPath, '--output-dir', output]));
  const verification = join(f.root, 'verification.json');
  success(run(f.root, observer, ['--design', f.designPath, '--candidate-dir', output, '--output', verification]));
  const result = read(verification), receipt = read(join(output, 'candidate.json'));
  assert.equal(result.status, 'required_tool_checks_passed'); assert.equal(result.productionAccepted, false);
  assert.equal(result.geometry.vertexCount, 6); assert.deepEqual(result.geometry.uvLayers, ['FaceUV']);
  assert.deepEqual(result.geometry.materialSlots, ['Skin', 'Lips']); assert.deepEqual(result.geometry.bones, ['Head']);
  assert.ok(result.geometry.maxPositionErrorMeters < 1e-6); assert.ok(result.geometry.maxPreservedDeltaErrorMeters < 1e-6);
  assert.equal(result.eyeChecks.complete, true); assert.equal(receipt.productionAccepted, false); assert.equal(hash(f.source), original);
  assert.equal(receipt.defaultWeights.VendorOriginalKeyA, .25);
  assert.equal(receipt.preservedKeys[0].originalSliderMin, -1); assert.equal(receipt.preservedKeys[0].originalSliderMax, 2);
  fails(run(f.root, tool, ['bake', '--design', f.designPath, '--output-dir', output]), /already|new and separate/);
  const rebakeCatalog = join(f.root, 'rebake-catalog.json'); success(run(f.root, tool, ['catalog', '--source', join(output, 'candidate.blend'), '--output', rebakeCatalog]));
  const frozen = read(rebakeCatalog), duplicate = structuredClone(f.design);
  duplicate.source = { ...frozen.source, catalogSha256: frozen.catalogSha256, meshId: frozen.meshes[0].meshId };
  duplicate.recipe.sourceSha256 = frozen.source.sha256; const duplicatePath = join(f.root, 'rebake.json'); writeFileSync(duplicatePath, JSON.stringify(duplicate));
  fails(run(f.root, tool, ['bake', '--design', duplicatePath, '--output-dir', join(f.root, 'duplicate-bake')]), /Already baked face candidate/);
});

test('source identity, recipe roles, units, no-data, unsupported compensation and eye negative controls block before writing', { skip: !existsSync(blender) }, t => {
  const f = fixture(t), original = hash(f.source);
  const cases: [string, (d: Json) => void, RegExp][] = [
    ['wrong-source', d => d.source.sha256 = '0'.repeat(64), /identity changed/],
    ['wrong-catalog', d => d.source.catalogSha256 = '0'.repeat(64), /identity changed/],
    ['wrong-mesh', d => d.source.meshId = '0'.repeat(64), /mesh identity/],
    ['wrong-unit', d => d.units.weights = 'unity-percent', /Explicit Blender-relative/],
    ['wrong-key', d => d.bake = ['missing'], /partition/],
    ['duplicate', d => d.bake.push(f.designKey), /partition/],
    ['runtime-bake', d => { d.bake.push(f.left); d.preserve = [f.right]; d.values[f.left] = 1; }, /Runtime expression/],
    ['range', d => d.values[f.designKey] = -2, /observed source range/],
    ['no-recipe', d => delete d.recipe, /source-bound versioned recipe/],
    ['no-eyes', d => delete d.recipe.eyeChecks, /Missing eye-region recipe/],
    ['missing-eye-tags', d => d.recipe.eyeChecks.regions[0].pairs = [], /actual upper\/lower/],
    ['fake-eye-success', d => d.recipe.eyeChecks.regions[0].states[1].weights = {}, /eye check\/control failed/],
    ['missing-open-control', d => d.recipe.eyeChecks.regions[0].states.shift(), /open-eye negative control/],
    ['unmeasured-half', d => d.recipe.eyeChecks.regions[0].states.push({ kind: 'half', weights: { [f.left]: .5 } }), /State-specific minimum gap/],
    ['compensation', d => d.recipe.compensation = { unsupported: 'not silently ignored' }, /Unsupported frozen face compensation recipe/],
  ];
  for (const [name, edit, message] of cases) {
    const design = structuredClone(f.design); edit(design);
    const path = join(f.root, `${name}.json`), output = join(f.root, name); writeFileSync(path, JSON.stringify(design));
    fails(run(f.root, tool, ['bake', '--design', path, '--output-dir', output]), message); assert.equal(existsSync(output), false, name);
  }
  assert.equal(hash(f.source), original);
});

test('unsupported eye recipes may produce explicitly incomplete geometry candidates, but cannot satisfy required closed eyes', { skip: !existsSync(blender) }, t => {
  const f = fixture(t); f.design.recipe.eyeChecks = { status: 'unsupported', reason: 'No validated eye-region tags for this source' };
  const write = () => writeFileSync(f.designPath, JSON.stringify(f.design)); write();
  fails(run(f.root, tool, ['bake', '--design', f.designPath, '--output-dir', join(f.root, 'blocked')]), /Required closed-eye check/);
  f.design.requiredChecks = ['geometry']; write();
  const candidate = join(f.root, 'geometry-only'); success(run(f.root, tool, ['bake', '--design', f.designPath, '--output-dir', candidate]));
  const verification = join(f.root, 'incomplete.json'); success(run(f.root, observer, ['--design', f.designPath, '--candidate-dir', candidate, '--output', verification]));
  assert.equal(read(verification).eyeChecks.complete, false); assert.equal(read(verification).productionAccepted, false);
  assert.equal(read(verification).status, 'geometry_verified_eye_checks_unavailable');
});

test('absolute/multi-frame sources are recorded and rejected rather than flattened or silently losing interpolation', { skip: !existsSync(blender) }, t => {
  const f = fixture(t), absolute = join(f.root, 'absolute.blend'), script = join(f.root, 'absolute.py');
  writeFileSync(script, `import bpy,sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[sys.argv.index('--')+1],use_scripts=False)\nbpy.data.objects['Face'].data.shape_keys.use_relative=False\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])\n`);
  success(run(f.root, script, [f.source, absolute]));
  const path = join(f.root, 'absolute-catalog.json'); success(run(f.root, tool, ['catalog', '--source', absolute, '--output', path]));
  const catalog = read(path), mesh = catalog.meshes[0]; assert.equal(mesh.relativeKeys, false); assert.ok(new Set(mesh.keys.map((k: Json) => k.frame)).size > 1);
  f.design.source = { ...catalog.source, catalogSha256: catalog.catalogSha256, meshId: mesh.meshId }; f.design.recipe.sourceSha256 = catalog.source.sha256;
  writeFileSync(f.designPath, JSON.stringify(f.design)); fails(run(f.root, tool, ['bake', '--design', f.designPath, '--output-dir', join(f.root, 'blocked')]), /Absolute\/multi-frame/);
});

test('actual rig poses remain blocked while FBX import identity noise does not count as a pose', { skip: !existsSync(blender) }, t => {
  const f = fixture(t), source = join(f.root, 'posed.blend'), script = join(f.root, 'posed.py');
  writeFileSync(script, `import bpy,sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[-2],use_scripts=False)\nrig=next(o for o in bpy.data.objects if o.type=='ARMATURE')\nrig.pose.bones['Head'].rotation_mode='XYZ'\nrig.pose.bones['Head'].rotation_euler.z=.05\nbpy.context.view_layer.update()\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])\n`);
  success(run(f.root, script, [f.source, source]));
  const catalogPath = join(f.root, 'posed-catalog.json'); success(run(f.root, tool, ['catalog', '--source', source, '--output', catalogPath]));
  const catalog = read(catalogPath), mesh = catalog.meshes[0]; assert.equal(mesh.posedRig, true);
  const ids = Object.fromEntries(f.mesh.keys.map((old: Json) => [old.id, mesh.keys.find((key: Json) => key.name === old.name).id]));
  const design = structuredClone(f.design);
  design.source = { ...catalog.source, catalogSha256: catalog.catalogSha256, meshId: mesh.meshId };
  design.recipe.sourceSha256 = catalog.source.sha256;
  design.values = Object.fromEntries(Object.entries(design.values).map(([id, value]) => [ids[id], value]));
  for (const field of ['bake', 'preserve']) design[field] = design[field].map((id: string) => ids[id]);
  for (const field of ['designKeys', 'runtimeKeys']) design.recipe[field] = design.recipe[field].map((id: string) => ids[id]);
  const designPath = join(f.root, 'posed-design.json'); writeFileSync(designPath, JSON.stringify(design));
  const output = join(f.root, 'posed-candidate');
  fails(run(f.root, tool, ['bake', '--design', designPath, '--output-dir', output]), /Animated\/driven\/posed sources/);
  assert.equal(existsSync(output), false);
});

test('independent readback rejects changed geometry, retained deltas, UV, material slots and skeleton even with freshly hashed receipts', { skip: !existsSync(blender) }, t => {
  const f = fixture(t), candidate = join(f.root, 'candidate'); success(run(f.root, tool, ['bake', '--design', f.designPath, '--output-dir', candidate]));
  for (const [name, edit, message] of [
    ['geometry', 'obj.data.vertices[0].co.x+=.005\nobj.data.shape_keys.key_blocks[0].data[0].co.x+=.005', /Geometry or preserved/],
    ['delta', "obj.data.shape_keys.key_blocks['VendorOriginalKeyA'].data[0].co.x+=.005", /Geometry or preserved/],
    ['uv', 'obj.data.uv_layers[0].data[0].uv.x+=.1', /UV corner/],
    ['material', "obj.data.materials[0].name='WrongMaterial'", /Material slot/],
    ['bone', "rig.data.bones['Head'].name='WrongBone'", /Skinning weights|Skeleton/],
  ] as const) {
    const copy = join(f.root, name); cpSync(candidate, copy, { recursive: true }); const fbx = join(copy, 'candidate.fbx'), script = join(f.root, `${name}.py`);
    writeFileSync(script, `import bpy,sys\nbpy.ops.wm.read_factory_settings(use_empty=True)\nbpy.ops.import_scene.fbx(filepath=sys.argv[-1],use_anim=False)\nobj=next(o for o in bpy.data.objects if o.type=='MESH')\nrig=next(o for o in bpy.data.objects if o.type=='ARMATURE')\n${edit}\nbpy.ops.export_scene.fbx(filepath=sys.argv[-1],use_selection=False,object_types={'ARMATURE','MESH'},add_leaf_bones=False,bake_anim=False,use_mesh_modifiers=False)\n`);
    success(run(f.root, script, [fbx])); const receiptPath = join(copy, 'candidate.json'), receipt = read(receiptPath); receipt.outputs.fbx.sha256 = hash(fbx); writeFileSync(receiptPath, JSON.stringify(receipt));
    fails(run(f.root, observer, ['--design', f.designPath, '--candidate-dir', copy, '--output', join(f.root, `${name}-verification.json`)]), message);
  }
  const old = structuredClone(f.design); old.revisionId = 'old-revision'; const oldPath = join(f.root, 'old.json'); writeFileSync(oldPath, JSON.stringify(old));
  fails(run(f.root, observer, ['--design', oldPath, '--candidate-dir', candidate, '--output', join(f.root, 'old-result.json')]), /different frozen design revision/);
  const metadataDir = join(f.root, 'metadata-tamper'); cpSync(candidate, metadataDir, { recursive: true });
  const receiptPath = join(metadataDir, 'candidate.json'), receipt = read(receiptPath); receipt.defaultWeights.VendorOriginalKeyA = 1; writeFileSync(receiptPath, JSON.stringify(receipt));
  fails(run(f.root, observer, ['--design', f.designPath, '--candidate-dir', metadataDir, '--output', join(f.root, 'metadata-result.json')]), /default weights changed/);
  for (const [name, mutation, pattern] of [
    ['editable-geometry', "obj.data.vertices[0].co.x+=.005\nobj.data.shape_keys.key_blocks[0].data[0].co.x+=.005", /Editable candidate geometry/],
    ['editable-expression', "obj.data.shape_keys.key_blocks['VendorOriginalKeyA'].data[0].co.x+=.005", /Editable candidate expression displacement/],
    ['editable-uv', 'obj.data.uv_layers[0].data[0].uv.x+=.1', /Editable candidate topology\/UV/],
  ] as const) {
    const copy = join(f.root, name); cpSync(candidate, copy, { recursive: true });
    const blend = join(copy, 'candidate.blend'), script = join(f.root, `${name}.py`);
    writeFileSync(script, `import bpy,sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[-1],use_scripts=False)\nobj=bpy.data.objects['Face']\n${mutation}\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])\n`);
    success(run(f.root, script, [blend]));
    const receiptPath = join(copy, 'candidate.json'), receipt = read(receiptPath);
    receipt.outputs.blend.sha256 = hash(blend); writeFileSync(receiptPath, JSON.stringify(receipt));
    fails(run(f.root, observer, ['--design', f.designPath, '--candidate-dir', copy, '--output', join(f.root, `${name}-result.json`)]), pattern);
  }
});

test('linked blend libraries require separate authorized dependency handling and are refused', { skip: !existsSync(blender) }, t => {
  const f = fixture(t), linked = join(f.root, 'linked.blend'), script = join(f.root, 'linked.py');
  writeFileSync(script, `import bpy,sys\nbpy.ops.wm.read_factory_settings(use_empty=True)\nwith bpy.data.libraries.load(sys.argv[-2],link=True) as (source,target):\n target.meshes=['VerifiedFaceMesh']\nobj=bpy.data.objects.new('LinkedFace',target.meshes[0]);bpy.context.collection.objects.link(obj)\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])\n`);
  success(run(f.root, script, [f.source, linked]));
  fails(run(f.root, tool, ['catalog', '--source', linked, '--output', join(f.root, 'linked-catalog.json')]), /External linked libraries/);
});

test('automatic source scripts do not execute and sources without shape data cannot produce face candidates', { skip: !existsSync(blender) }, t => {
  const f = fixture(t), scripted = join(f.root, 'scripted.blend'), noKeys = join(f.root, 'no-keys.blend'), sentinel = join(f.root, 'autoexec-sentinel');
  const script = join(f.root, 'scripted.py');
  writeFileSync(script, `import bpy,sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[-4],use_scripts=False)\ntext=bpy.data.texts.new('autorun.py');text.write('from pathlib import Path\\nPath('+repr(sys.argv[-1])+').write_text("unexpected")\\n');text.use_module=True\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-3])\nbpy.data.objects['Face'].shape_key_clear()\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-2])\n`);
  success(run(f.root, script, [f.source, scripted, noKeys, sentinel]));
  success(run(f.root, tool, ['catalog', '--source', scripted, '--output', join(f.root, 'scripted-catalog.json')]));
  assert.equal(existsSync(sentinel), false);
  const unsafe = spawnSync(blender, ['--background', '--factory-startup', '--python', tool, '--', 'catalog', '--source', scripted, '--output', join(f.root, 'unsafe.json')], {
    encoding: 'utf8', timeout: 90_000, windowsHide: true,
    env: { ...process.env, BLENDER_USER_CONFIG: join(f.root, 'config'), BLENDER_USER_SCRIPTS: join(f.root, 'scripts'), BLENDER_USER_DATAFILES: join(f.root, 'data') },
  });
  assert.equal(unsafe.error, undefined); assert.equal(unsafe.status, 2, unsafe.stdout + unsafe.stderr);
  assert.match(unsafe.stdout + unsafe.stderr, /Launch Blender with --disable-autoexec/); assert.equal(existsSync(sentinel), false);
  const catalogPath = join(f.root, 'no-keys.json'); success(run(f.root, tool, ['catalog', '--source', noKeys, '--output', catalogPath]));
  const catalog = read(catalogPath); assert.equal(catalog.meshes[0].keys.length, 0);
  f.design.source = { ...catalog.source, catalogSha256: catalog.catalogSha256, meshId: catalog.meshes[0].meshId };
  writeFileSync(f.designPath, JSON.stringify(f.design));
  fails(run(f.root, tool, ['bake', '--design', f.designPath, '--output-dir', join(f.root, 'no-data-output')]), /No shape-key data/);
  assert.equal(existsSync(join(f.root, 'no-data-output')), false);
});

const compensation = {
  schema: 'face-compensation/0.1', method: 'idw-endpoint-transfer', version: '1', neighbors: 2, power: 1,
  pointToleranceMeters: 1e-8, halfErrorToleranceMeters: 1e-5,
  quality: { minimumTriangleAreaMetersSquared: 1e-12, minAreaRatio: .05, maxAreaRatio: 20,
    minEdgeRatio: .2, maxEdgeRatio: 5, minNormalDot: 0, maxDihedralIncreaseDegrees: 25 },
};

test('native regional additive production preserves visemes and design deltas, closes each eye independently, and rejects unchanged compensation', { skip: !existsSync(blender) }, t => {
  const root=mkdtempSync(join(tmpdir(),'avh-additive-face-'));t.after(()=>removeTemp(root));
  const script=join(root,'eyes.py');writeFileSync(script,`import bpy,sys,json
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(sys.argv[-2]).parent))
from blender_face_common import catalog,FBX_EXPORT
from face import combination_design
root=Path(sys.argv[-1]);bpy.ops.wm.read_factory_settings(use_empty=True)
vertices=[];faces=[];groups=[];inner=[]
for side,x in [('LeftEye',-.03),('RightEye',.03)]:
 for z0,z1,depth,bone in [(-.012,-.003,-.001,'Head'),(.003,.012,-.001,'Head'),(-.005,.005,0,side)]:
  at=len(vertices);vertices.extend([(x-.007,depth,z0),(x+.007,depth,z0),(x+.007,depth,z1),(x-.007,depth,z1)]);faces.append(tuple(range(at,at+4)));groups.extend([bone]*4)
  if bone=='Head':inner.extend([(at+2,side,-1),(at+3,side,-1)] if z0<0 else [(at,side,1),(at+1,side,1)])
mesh=bpy.data.meshes.new('Face');mesh.from_pydata(vertices,[],faces);mesh.update();mesh.materials.append(bpy.data.materials.new('Skin'))
uv=mesh.uv_layers.new(name='UV')
for loop in mesh.loops:uv.data[loop.index].uv=(vertices[loop.vertex_index][0],vertices[loop.vertex_index][2])
obj=bpy.data.objects.new('Face',mesh);bpy.context.collection.objects.link(obj);obj.shape_key_add(name='Basis')
design=obj.shape_key_add(name='EyeDesign');blink=obj.shape_key_add(name='Blink');wink=obj.shape_key_add(name='WinkLeft');mouth=obj.shape_key_add(name='vrc.v_pp')
for i,side,sign in inner:
 design.data[i].co.z+=sign*.002;blink.data[i].co.z=0
 if side=='LeftEye':wink.data[i].co.z=0
rigdata=bpy.data.armatures.new('Skeleton');rig=bpy.data.objects.new('Rig',rigdata);bpy.context.collection.objects.link(rig);bpy.context.view_layer.objects.active=rig;rig.select_set(True);bpy.ops.object.mode_set(mode='EDIT')
for name,x in [('Head',0),('LeftEye',-.03),('RightEye',.03)]:
 bone=rigdata.edit_bones.new(name);bone.head=(x,0,0);bone.tail=(x,0,.01)
bpy.ops.object.mode_set(mode='OBJECT');obj.parent=rig;mod=obj.modifiers.new('Skin','ARMATURE');mod.object=rig
for name in set(groups):obj.vertex_groups.new(name=name).add([i for i,n in enumerate(groups) if n==name],1,'REPLACE')
bpy.ops.export_scene.fbx(filepath=str(root/'source.fbx'),**FBX_EXPORT)
cat=catalog(root/'source.fbx');target=cat['meshes'][0];keymap={k['name']:k['id'] for k in target['keys'][1:]}
selected={'protectedKeys':['Blink','WinkLeft','vrc.v_pp'],'writers':[{'kind':'descriptor-viseme','key':'vrc.v_pp'}],'unmeasuredWriters':[],
 'meshSnapshot':{'keys':[{'name':k,'frames':[{'weight':100}]} for k in keymap]},
 'eyeObservation':{'status':'source_controls_verified','blinkKey':'Blink','regions':[{'side':'left','eyePath':'Rig/LeftEye'},{'side':'right','eyePath':'Rig/RightEye'}]}}
design=combination_design(selected,cat,target,keymap,{'values':{'EyeDesign':1}},'additive-fixture')
(root/'design.json').write_text(json.dumps(design))
`);
  success(run(root,script,[tool,root]));const designPath=join(root,'design.json'),out=join(root,'candidate');
  success(run(root,tool,['bake','--design',designPath,'--output-dir',out]));
  success(run(root,observer,['--design',designPath,'--candidate-dir',out,'--output',join(root,'verification.json')]));
  const receipt=read(join(out,'candidate.json')),verification=read(join(root,'verification.json'));
  assert.equal(receipt.compensation.method,'regional-additive');
  assert.deepEqual(receipt.compensation.coefficients.Blink,[1,1]);assert.deepEqual(receipt.compensation.coefficients.WinkLeft,[1,0]);
  assert.deepEqual(receipt.compensation.coefficients['vrc.v_pp'],[0,0]);assert.deepEqual(receipt.compensation.coefficients.EyeDesign,[0,0]);
  assert.equal(verification.eyeChecks.complete,true);assert.ok(verification.compensation.maxStateErrorMeters<.0001);
  const check=join(root,'check.py');writeFileSync(check,`import sys,json,bpy
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[-2]).parent));from blender_face_common import load_source
root=Path(sys.argv[-1]);load_source(root/'source.fbx');original=[v.co.copy() for v in bpy.data.objects['Face'].data.shape_keys.key_blocks[0].data]
load_source(root/'candidate/candidate.blend');obj=bpy.data.objects['Face'];basis=obj.data.shape_keys.key_blocks[0];key=obj.data.shape_keys.key_blocks['EyeDesign']
assert key.value==0 and key.slider_min==-1 and key.slider_max==0
assert max((2*b.co-k.co-p).length for b,k,p in zip(basis.data,key.data,original))<1e-6
`);success(run(root,check,[tool,root]));
  // Actual wrong output, not a mocked intermediate: disable compensation in a
  // private copy of the production tool. The observer must reject the FBX.
  const mutant=join(root,'mutant-tools');cpSync(join(fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url))),mutant,{recursive:true});
  const transfer=join(mutant,'blender_face_transfer.py');const code=readFileSync(transfer,'utf8');assert.ok(code.includes('new = [d-shift[i]*sum(c*m[i] for c,m in zip(co,masks))'));
  writeFileSync(transfer,code.replace('new = [d-shift[i]*sum(c*m[i] for c,m in zip(co,masks)) for i,d in enumerate(original)]','new = [d.copy() for d in original]'));
  const bad=join(root,'uncompensated');success(run(root,join(mutant,'blender_face.py'),['bake','--design',designPath,'--output-dir',bad]));
  fails(run(root,observer,['--design',designPath,'--candidate-dir',bad,'--output',join(root,'bad-verification.json')]),/expression displacement differs|Geometry or preserved/);
});

test('self-intersection quality confirms existing boundary contacts and still rejects new intersections', { skip: !existsSync(blender) }, t => {
 const root=mkdtempSync(join(tmpdir(),'avh-boundary-contact-'));t.after(()=>removeTemp(root));const script=join(root,'quality.py');
 writeFileSync(script,`import sys,copy
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[-1]).parent))
import blender_face_transfer as transfer
from face import TRANSFER
# Seeded synthetic triangles, unrelated to any vendor mesh. An ulp-sized
# coordinate change exposes a BVH boundary false negative in the source.
p=[[5.123245239875649e-16,.04964731241931959,.47604054028587445],[.001,.05987721145906279,.4650273819081301],[1.250603686380841e-15,.058210475776627704,.46509305814131013],[6.469884051405594e-17,.05282256130882739,.4746403352609111],[-.0003,.052510062761622844,.4709017417470624],[1.5607297958480535e-15,.053036070952766676,.4708128907865062]]
q=copy.deepcopy(p);q[1][0]*=1.0000001;q[4][0]*=.9999999
polys=[{'vertices':[0,1,2]},{'vertices':[3,4,5]}];limits=dict(TRANSFER['quality']);limits.pop('findingPolicy',None)
r=transfer.quality(p,q,polys,limits)['selfIntersections']
assert r['added']==0 and r['baselineEdgeConfirmations']+r['candidateBoundaryFalsePositives']==1,r
separated=[[-.01,-.01,0],[.01,-.01,0],[0,.01,0],[-.005,0,.005],[.005,0,.005],[0,0,.015]]
crossed=copy.deepcopy(separated)
for v in crossed[3:]:v[2]-=.01
old,new,confirmed,rejected=transfer.refine_intersections(crossed,crossed,[(0,1,2),(3,4,5)],set(),{(0,1)})
assert old==new=={(0,1)} and confirmed==1 and rejected==0
try:transfer.quality(separated,crossed,polys,limits)
except ValueError as e:assert 'new non-adjacent self-intersections' in str(e),str(e)
else:raise AssertionError('New intersection passed')
# Remove only the baseline confirmation and exercise the same quality entry.
transfer.refine_intersections=lambda before,after,faces,old,new:(old,new,0,0)
try:transfer.quality(p,q,polys,limits)
except ValueError as e:assert 'new non-adjacent self-intersections' in str(e),str(e)
else:raise AssertionError('Removing the fix must reproduce the false rejection')
`);success(run(root,script,[tool]));
});

test('visual-review quality records new intersections and collapse without hiding technical failures', { skip: !existsSync(blender) }, t => {
 const root=mkdtempSync(join(tmpdir(),'avh-quality-review-'));t.after(()=>removeTemp(root));const script=join(root,'quality.py');
 writeFileSync(script,`import sys,copy,math
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[-1]).parent))
from blender_face_transfer import quality
from face import TRANSFER
p=[[-.01,-.01,0],[.01,-.01,0],[0,.01,0],[-.005,0,.005],[.005,0,.005],[0,0,.015]]
q=copy.deepcopy(p)
for v in q[3:]:v[2]-=.01
polys=[{'vertices':[0,1,2]},{'vertices':[3,4,5]}]
r=quality(p,q,polys,TRANSFER['quality'])
assert r['complete'] and not r['passed'] and r['selfIntersections']['added']==1,r
f=r['findings'][0]
assert not f['originalHasSamePair'] and f['planePenetrationBoundMeters']>0 and f['needsUserReview'],f
q=copy.deepcopy(p);q[1]=q[0]
r=quality(p,q,polys,TRANSFER['quality'])
assert r['complete'] and not r['passed'] and any(f['kind']=='newly degenerate triangle' for f in r['findings']),r
q[0][0]=math.nan
try:quality(p,q,polys,TRANSFER['quality'])
except ValueError as e:assert 'non-finite' in str(e)
else:raise AssertionError('Technical data failure was incorrectly converted to visual review')
`);success(run(root,script,[tool]));
});

test('real Blender quality groups reversed edges by region/type, retains raw flags and identifies the source small edge', {skip:!existsSync(blender)},t=>{
  const root=mkdtempSync(join(tmpdir(),'avh-quality-groups-'));t.after(()=>removeTemp(root));const script=join(root,'review.py');
  writeFileSync(script,`import sys,copy
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[-1]).parent))
from blender_face_transfer import quality
from face import TRANSFER
p=[[0,0,0],[.00009,0,0],[0,.02,0],[0,-.02,0]]
q=copy.deepcopy(p);q[1][0]=.00011
polys=[{'vertices':[0,1,2]},{'vertices':[1,0,3]}]
r=quality(p,q,polys,TRANSFER['quality'],[{'side':'left','centerMeters':[0,0,0],'radiusMeters':.05}])
groups=[g for g in r['reviewGroups'] if g['kind']=='near-degenerate edge became visible']
assert len(groups)==1,groups
g=groups[0]
assert g['region']=='left-eye' and g['baseline']=='source-small-edge',g
assert g['rawCount']==2 and g['uniqueCount']==1,g
assert g['maximumChangeMeters']>0 and g['maximumFootprintMeters']>0,g
assert len(r['findings'])>=g['rawCount'] and not r['passed'],r
assert 'not visible defect size' in r['reviewLimitations'][0],r
`);success(run(root,script,[tool]));
});

test('near-degenerate edges use a frozen absolute visibility limit while visible damage still fails', { skip: !existsSync(blender) }, t => {
 const root=mkdtempSync(join(tmpdir(),'avh-edge-absolute-'));t.after(()=>removeTemp(root));const script=join(root,'quality.py');
 writeFileSync(script,`import sys,copy
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[-1]).parent))
from blender_face_transfer import quality
from face import TRANSFER
limits=dict(TRANSFER['quality']);limits.pop('findingPolicy',None);polys=[{'vertices':[0,1,2]}]
source=[[0,0,0],[.0000001,0,0],[0,.0000001,0]];candidate=[[0,0,0],[.000004,0,0],[0,.0000001,0]]
assert quality(source,candidate,polys,limits)['baselineDegenerateTriangles']==1
bad=copy.deepcopy(candidate);bad[1][0]=.0002
try:quality(source,bad,polys,limits)
except ValueError as e:assert 'became visible' in str(e)
else:raise AssertionError('Visible edge damage passed')
legacy=dict(limits);legacy.pop('nearDegenerateEdgeMeters')
try:quality(source,candidate,polys,legacy)
except ValueError as e:assert 'edge distortion' in str(e)
else:raise AssertionError('Removing the fix must reproduce the false rejection')
`);success(run(root,script,[tool]));
});

test('source-bound endpoint compensation closes a changed eye that unchanged deltas cannot close, preserves open controls and independently checks half weights', { skip: !existsSync(blender) }, t => {
  const f = fixture(t), script = join(f.root, 'eye-design.py'), source = join(f.root, 'eye-source.blend');
  writeFileSync(script, `import bpy,sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[-2],use_scripts=False)\nkey=bpy.data.objects['Face'].data.shape_keys.key_blocks['ContourWidth']\nfor v in key.data:v.co.z+=.002 if v.co.z>0 else -.002\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])\n`);
  success(run(f.root, script, [f.source, source]));
  const catalogPath = join(f.root, 'eye-catalog.json'); success(run(f.root, tool, ['catalog', '--source', source, '--output', catalogPath]));
  const catalog = read(catalogPath), mesh = catalog.meshes[0];
  const remap: Record<string, string> = Object.fromEntries(f.mesh.keys.map((old: Json) => [old.id, mesh.keys.find((key: Json) => key.name === old.name).id]));
  const design = structuredClone(f.design); design.source = { ...catalog.source, catalogSha256: catalog.catalogSha256, meshId: mesh.meshId };
  design.recipe.sourceSha256 = catalog.source.sha256;
  for (const field of ['bake', 'preserve']) design[field] = design[field].map((id: string) => remap[id]);
  for (const field of ['designKeys', 'runtimeKeys']) design.recipe[field] = design.recipe[field].map((id: string) => remap[id]);
  for (const region of design.recipe.eyeChecks.regions) for (const state of region.states)
    state.weights = Object.fromEntries(Object.entries(state.weights).map(([id, value]) => [remap[id], value]));
  design.values = { [remap[f.designKey]]: 1 };
  const designPath = join(f.root, 'eye-design.json'); writeFileSync(designPath, JSON.stringify(design));
  const original = hash(source);
  // A real source/design with only the global basis shift leaves a 4mm gap.
  fails(run(f.root, tool, ['bake', '--design', designPath, '--output-dir', join(f.root, 'unchanged-delta')]), /eye check\/control failed/);
  design.recipe.compensation = compensation; writeFileSync(designPath, JSON.stringify(design));
  const candidate = join(f.root, 'compensated'); success(run(f.root, tool, ['bake', '--design', designPath, '--output-dir', candidate]));
  const verification = join(f.root, 'compensated-verification.json'); success(run(f.root, observer, ['--design', designPath, '--candidate-dir', candidate, '--output', verification]));
  const result = read(verification);
  assert.equal(result.productionAccepted, false); assert.equal(result.eyeChecks.complete, true);
  assert.ok(result.compensation.maxCompensationMeters > .0019); assert.ok(result.compensation.maxHalfErrorMeters < 1e-5);
  assert.ok(result.compensation.maxEndpointErrorMeters < 1e-6);
  for (const region of result.eyeChecks.regions) {
    assert.ok(region.states.find((s: Json) => s.kind === 'closed').gapsMeters[0] < 1e-6);
    assert.ok(region.states.find((s: Json) => s.kind === 'open').gapsMeters[0] > .0099);
  }
  assert.equal(hash(source), original);
  const nonlinear = structuredClone(design); nonlinear.recipe.compensation.neighbors = 4; nonlinear.recipe.compensation.power = 2;
  const nonlinearPath = join(f.root, 'nonlinear.json'); writeFileSync(nonlinearPath, JSON.stringify(nonlinear));
  fails(run(f.root, tool, ['bake', '--design', nonlinearPath, '--output-dir', join(f.root, 'unverified-half-weight')]), /half-weight transfer exceeds frozen tolerance/);
  // Explicit range expansion is measured as part of a new candidate, never
  // silently clamped to the original [-1, 2] slider.
  design.values[remap[f.designKey]] = 3;
  writeFileSync(designPath, JSON.stringify(design)); fails(run(f.root, tool, ['bake', '--design', designPath, '--output-dir', join(f.root, 'unrecorded-expansion')]), /observed source range/);
  design.rangeOverrides = { [remap[f.designKey]]: { originalMin: -1, originalMax: 2, newMin: -1, newMax: 4 } };
  const forgedRange = structuredClone(design); forgedRange.rangeOverrides[remap[f.designKey]].originalMin = -2;
  const forgedRangePath = join(f.root, 'forged-range.json'); writeFileSync(forgedRangePath, JSON.stringify(forgedRange));
  fails(run(f.root, tool, ['bake', '--design', forgedRangePath, '--output-dir', join(f.root, 'forged-range')]), /original limits differ/);
  writeFileSync(designPath, JSON.stringify(design));
  const expanded = join(f.root, 'expanded'); success(run(f.root, tool, ['bake', '--design', designPath, '--output-dir', expanded]));
  const expandedVerification = join(f.root, 'expanded-verification.json'); success(run(f.root, observer, ['--design', designPath, '--candidate-dir', expanded, '--output', expandedVerification]));
  assert.deepEqual(read(expandedVerification).rangeOverrides, design.rangeOverrides); assert.ok(read(expandedVerification).compensation.maxCompensationMeters > .0059);
});

test('contradictory control displacement and newly damaged/creased topology cannot pass compensated candidate quality', { skip: !existsSync(blender) }, t => {
  const f = fixture(t);
  for (const [name, mutation, pattern] of [
    ['contradiction', "basis=obj.data.shape_keys.key_blocks[0]\nbasis.data[1].co=basis.data[0].co\nobj.data.vertices[1].co=basis.data[0].co", /contradictory design displacement/],
    ['fold', 'key.data[1].co.y+=.012', /new dihedral crease/],
    ['flip', 'key.data[1].co.z-=.01', /triangle flip/],
    ['degenerate', 'key.data[1].co=key.data[0].co', /degenerate triangle|edge distortion/],
  ] as const) {
    const source = join(f.root, `${name}.blend`), script = join(f.root, `${name}.py`);
    writeFileSync(script, `import bpy,sys\nbpy.ops.wm.open_mainfile(filepath=sys.argv[-2],use_scripts=False)\nobj=bpy.data.objects['Face'];key=obj.data.shape_keys.key_blocks['ContourWidth']\n${mutation}\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])\n`);
    success(run(f.root, script, [f.source, source]));
    const catalogPath = join(f.root, `${name}-catalog.json`); success(run(f.root, tool, ['catalog', '--source', source, '--output', catalogPath]));
    const catalog = read(catalogPath), mesh = catalog.meshes[0], id = (label: string) => mesh.keys.find((key: Json) => key.name === label).id;
    const design = { ...f.design, source: { ...catalog.source, catalogSha256: catalog.catalogSha256, meshId: mesh.meshId },
      values: { [id('ContourWidth')]: 1 }, bake: [id('ContourWidth')], preserve: [id('VendorOriginalKeyA'), id('VendorOriginalKeyB')],
      recipe: { id: 'quality-controls', version: '1', sourceSha256: catalog.source.sha256,
        designKeys: [id('ContourWidth')], runtimeKeys: [id('VendorOriginalKeyA'), id('VendorOriginalKeyB')], compensation,
        eyeChecks: { status: 'unsupported', reason: 'Geometry-only negative control' } }, requiredChecks: ['geometry'] };
    const designPath = join(f.root, `${name}-design.json`); writeFileSync(designPath, JSON.stringify(design));
    const output = join(f.root, `${name}-candidate`); fails(run(f.root, tool, ['bake', '--design', designPath, '--output-dir', output]), pattern);
    assert.equal(existsSync(output), false);
  }
});


test('native baking bounds residual sliders, reads exact float32 ranges and rejects an over-baked editable upper limit', { skip: !existsSync(blender) }, t => {
 const f=fixture(t);f.design.route='native-fbx/1';f.design.values[f.designKey]=1.3;f.design.rangeOverrides={[f.designKey]:{originalMin:-1,originalMax:2,newMin:-2.6,newMax:3.1}};
 f.design.recipe.compensation={schema:'face-compensation/0.1',method:'idw-endpoint-transfer',version:'1',neighbors:2,power:1,pointToleranceMeters:1e-8,halfErrorToleranceMeters:1e-5,quality:{minimumTriangleAreaMetersSquared:1e-12,minAreaRatio:.05,maxAreaRatio:20,minEdgeRatio:.2,maxEdgeRatio:5,minNormalDot:0,maxDihedralIncreaseDegrees:25}};
 const beyond=structuredClone(f.design);beyond.values[f.designKey]=2.5;const beyondPath=join(f.root,'beyond-source.json');writeFileSync(beyondPath,JSON.stringify(beyond));
 fails(run(f.root,tool,['bake','--design',beyondPath,'--output-dir',join(f.root,'beyond-source-output')]),/original editable upper limit/);assert.equal(existsSync(join(f.root,'beyond-source-output')),false);
 writeFileSync(f.designPath,JSON.stringify(f.design));const output=join(f.root,'native');success(run(f.root,tool,['bake','--design',f.designPath,'--output-dir',output]));
 success(run(f.root,observer,['--design',f.designPath,'--candidate-dir',output,'--output',join(f.root,'native-verification.json')]));
 const receipt=read(join(output,'candidate.json'));assert.deepEqual(receipt.retainedKeyNames,['ContourWidth','VendorOriginalKeyA','VendorOriginalKeyB']);assert.equal(receipt.fbxSettings.export.apply_scale_options,'FBX_SCALE_UNITS');assert.equal(receipt.productionAccepted,false);
 const inspect=join(f.root,'native-values.py');writeFileSync(inspect,`import bpy,sys,json
from pathlib import Path
p=Path(sys.argv[-1]);bpy.ops.wm.open_mainfile(filepath=str(p/'candidate.blend'),use_scripts=False);k=bpy.data.objects['Face'].data.shape_keys.key_blocks['ContourWidth'];(p/'values.json').write_text(json.dumps([k.value,k.slider_min,k.slider_max]))
`);success(run(f.root,inspect,[output]));assert.deepEqual(read(join(output,'values.json')),[0,Math.fround(-1.3),Math.fround(2-1.3)]);
 // Repair the receipt hashes after an actual editable-file mutation. A valid
 // receipt must never let the pre-bake upper bound pass independent readback.
 const mutate=join(f.root,'over-baked-upper.py');writeFileSync(mutate,`import bpy,sys,json,hashlib
from pathlib import Path
p=Path(sys.argv[-1]);bpy.ops.wm.open_mainfile(filepath=str(p/'candidate.blend'),use_scripts=False);k=bpy.data.objects['Face'].data.shape_keys.key_blocks['ContourWidth'];k.slider_max=3.1;bpy.ops.wm.save_as_mainfile(filepath=str(p/'candidate.blend'));r=json.loads((p/'candidate.json').read_text());r['outputs']['blend']['sha256']=hashlib.sha256((p/'candidate.blend').read_bytes()).hexdigest();(p/'candidate.json').write_text(json.dumps(r))
`);
 const oldObserver=join(f.root,'old-observer.py');writeFileSync(oldObserver,`import sys\nsys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url)).replaceAll('\\','/'))})\n`+readFileSync(observer,'utf8').replace('stored(expanded["newMin"])','expanded["newMin"]').replace('stored(expanded["newMax"])','expanded["newMax"]'));
 fails(run(f.root,oldObserver,['--design',f.designPath,'--candidate-dir',output,'--output',join(f.root,'old-range-result.json')]),/Editable runtime key default\/range\/frame semantics changed/);
 success(run(f.root,mutate,[output]));
 fails(run(f.root,observer,['--design',f.designPath,'--candidate-dir',output,'--output',join(f.root,'over-baked-range-result.json')]),/Editable runtime key default\/range\/frame semantics changed/);
});

test('native readback preserves indexed topology for near-coincident points and still rejects real UV, geometry and winding drift', { skip: !existsSync(blender) }, t => {
 const f=fixture(t), script=join(f.root,'near-points.py'),source=join(f.root,'near.blend'),catalogPath=join(f.root,'near-catalog.json');
 writeFileSync(script,`import bpy,sys\nfrom pathlib import Path\nroot=Path(sys.argv[-1]);bpy.ops.wm.open_mainfile(filepath=str(root/'source.blend'),use_scripts=False);obj=bpy.data.objects['Face']\nfor key in obj.data.shape_keys.key_blocks:\n for point in key.data:point.co.z*=.0025\nfor vertex,point in zip(obj.data.vertices,obj.data.shape_keys.key_blocks[0].data):vertex.co=point.co\nbpy.ops.wm.save_as_mainfile(filepath=str(root/'near.blend'))\n`);success(run(f.root,script,[f.root]));success(run(f.root,tool,['catalog','--source',source,'--output',catalogPath]));
 const cat=read(catalogPath),mesh=cat.meshes[0],key=(n:string)=>mesh.keys.find((k:Json)=>k.name===n).id,designKey=key('ContourWidth');
 const design={...f.design,route:'native-fbx/1',source:{...cat.source,catalogSha256:cat.catalogSha256,meshId:mesh.meshId},values:{[designKey]:.1},bake:[designKey],preserve:mesh.keys.slice(2).map((k:Json)=>k.id),recipe:{id:'indexed-near-points',version:'1',sourceSha256:cat.source.sha256,designKeys:[designKey],runtimeKeys:mesh.keys.slice(2).map((k:Json)=>k.id),eyeChecks:{status:'unsupported',reason:'This fixture isolates native indexed correspondence'}},acceptance:{positionToleranceMeters:.0001,deltaToleranceMeters:.0001,uvTolerance:1e-6,weightTolerance:1e-6},requiredChecks:['geometry']};
 const designPath=join(f.root,'near-design.json'),output=join(f.root,'near-candidate');writeFileSync(designPath,JSON.stringify(design));success(run(f.root,tool,['bake','--design',designPath,'--output-dir',output]));
 const mutate=join(f.root,'near-roundtrip.py');writeFileSync(mutate,`
import bpy,sys,json,hashlib
from pathlib import Path
sys.path.insert(0,sys.argv[-3]);from blender_face_common import load_source,FBX_EXPORT
root=Path(sys.argv[-2]);mode=sys.argv[-1];fbx=root/'candidate.fbx';load_source(fbx);obj=bpy.data.objects['Face'];blocks=obj.data.shape_keys.key_blocks
if mode=='near':
 shift=blocks[0].data[1].co.z-blocks[0].data[0].co.z
 for key in blocks:key.data[0].co.z+=shift;key.data[1].co.z-=shift
elif mode=='uv':obj.data.uv_layers[0].data[0].uv.x+=.1
elif mode=='geometry':
 for key in blocks:key.data[0].co.x+=.01
elif mode=='winding':obj.data.polygons[0].flip()
for vertex,point in zip(obj.data.vertices,blocks[0].data):vertex.co=point.co
bpy.ops.export_scene.fbx(filepath=str(fbx),**FBX_EXPORT)
receipt=json.loads((root/'candidate.json').read_text());receipt['outputs']['fbx']['sha256']=hashlib.sha256(fbx.read_bytes()).hexdigest();(root/'candidate.json').write_text(json.dumps(receipt))
`);
 const toolDir=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));success(run(f.root,mutate,[toolDir,output,'near']));
 const oldObserver=join(f.root,'nearest-observer.py');writeFileSync(oldObserver,`import sys\nsys.path.insert(0,${JSON.stringify(toolDir.replaceAll('\\','/'))})\n`+readFileSync(observer,'utf8').replace('if indexed_topology:', 'if False:'));
 const args=['--design',designPath,'--candidate-dir',output,'--output',join(f.root,'near-verification.json')];fails(run(f.root,oldObserver,args),/Polygon winding\/connectivity changed/);success(run(f.root,observer,args));
 const original=readFileSync(join(output,'candidate.fbx')),receipt=readFileSync(join(output,'candidate.json'));
 for(const [mode,reason] of [['uv',/UV corner coordinates changed/],['geometry',/Geometry or preserved relative-key displacement|Indexed source geometry/],['winding',/Polygon winding\/connectivity changed/]] as const){writeFileSync(join(output,'candidate.fbx'),original);writeFileSync(join(output,'candidate.json'),receipt);success(run(f.root,mutate,[toolDir,output,mode]));fails(run(f.root,observer,args),reason);}
});


test('native production FBX retains inherited non-target and preserved target defaults without baking their geometry', { skip: !existsSync(blender) }, t => {
 const f=fixture(t),toolDir=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url)),script=join(f.root,'default-source.py'),source=join(f.root,'defaults.fbx'),catPath=join(f.root,'defaults-catalog.json');
 writeFileSync(script,`import bpy,sys\nfrom pathlib import Path\np=Path(sys.argv[-1]);sys.path.insert(0,sys.argv[-2]);from blender_face_common import FBX_EXPORT\nbpy.ops.wm.open_mainfile(filepath=str(p/'source.blend'),use_scripts=False);obj=bpy.data.objects['Face'];other=obj.copy();other.data=obj.data.copy();other.name='Other';other.location.x+=.1;bpy.context.collection.objects.link(other);bpy.ops.export_scene.fbx(filepath=str(p/'defaults.fbx'),**FBX_EXPORT)\n`);success(run(f.root,script,[toolDir,f.root]));success(run(f.root,tool,['catalog','--source',source,'--output',catPath]));
 const cat=read(catPath),mesh=cat.meshes.find((m:Json)=>m.objectName==='Face'),id=(n:string)=>mesh.keys.find((k:Json)=>k.name===n).id;
 const design={...f.design,route:'native-fbx/1',source:{...cat.source,catalogSha256:cat.catalogSha256,meshId:mesh.meshId},values:{[id('ContourWidth')]:.1},bake:[id('ContourWidth')],preserve:[id('VendorOriginalKeyA'),id('VendorOriginalKeyB')],recipe:{id:'inherited-fbx-defaults',version:'1',sourceSha256:cat.source.sha256,designKeys:[id('ContourWidth')],runtimeKeys:[id('VendorOriginalKeyA'),id('VendorOriginalKeyB')],eyeChecks:{status:'unsupported',reason:'This fixture isolates default channel metadata and unbaked geometry'}},requiredChecks:['geometry']};
 const path=join(f.root,'defaults-design.json'),output=join(f.root,'defaults-candidate');writeFileSync(path,JSON.stringify(design));success(run(f.root,tool,['bake','--design',path,'--output-dir',output]));success(run(f.root,observer,['--design',path,'--candidate-dir',output,'--output',join(f.root,'defaults-verification.json')]));
 const old=join(f.root,'zero-defaults-producer.py'),start=readFileSync(tool,'utf8').indexOf('        # FBX writes basis coordinates'),end=readFileSync(tool,'utf8').indexOf('        if current.get("fbxFileUnits"):',start),text=readFileSync(tool,'utf8');assert.ok(start>=0&&end>start);
 writeFileSync(old,`import sys\nsys.path.insert(0,${JSON.stringify(toolDir.replaceAll('\\','/'))})\n`+text.slice(0,start)+`        for other in bpy.data.objects:\n            if other.type == "MESH" and other.data.shape_keys:\n                for key in other.data.shape_keys.key_blocks:\n                    key.value = 0\n`+text.slice(end));
 const bad=join(f.root,'zero-defaults-candidate');success(run(f.root,old,['bake','--design',path,'--output-dir',bad]));fails(run(f.root,observer,['--design',path,'--candidate-dir',bad,'--output',join(f.root,'zero-defaults-verification.json')]),/Non-face FBX default shape weights changed/);
});


test('native FBX export preserves centimeter and meter headers and independently verifies physical geometry', {skip:!existsSync(blender)},t=>{
  const f=fixture(t),toolRoot=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url)).replaceAll('\\','/');
  for(const [mode,factor,original] of [['FBX_SCALE_NONE',1,10],['FBX_SCALE_UNITS',100,100]] as const){
    const source=join(f.root,`units-${factor}.fbx`),script=join(f.root,`export-units-${factor}.py`);
    writeFileSync(script,`import bpy,sys
from pathlib import Path
sys.path.insert(0,${JSON.stringify(toolRoot)})
from blender_face_common import fbx_file_units
bpy.ops.wm.open_mainfile(filepath=sys.argv[-2],use_scripts=False)
bpy.ops.export_scene.fbx(filepath=sys.argv[-1],use_selection=False,object_types={'ARMATURE','MESH'},apply_unit_scale=True,apply_scale_options='${mode}',add_leaf_bones=False,bake_anim=False,use_mesh_modifiers=False)
fbx_file_units(sys.argv[-1],${original})
`);
    success(run(f.root,script,[f.source,source]));
    const catalogPath=join(f.root,`units-${factor}-catalog.json`);success(run(f.root,tool,['catalog','--source',source,'--output',catalogPath]));
    const cat=read(catalogPath),mesh=cat.meshes[0],key=mesh.keys.find((k:Json)=>k.name==='ContourWidth').id,runtime=mesh.keys.filter((k:Json)=>!['Basis','ContourWidth'].includes(k.name)).map((k:Json)=>k.id);
    assert.deepEqual(cat.fbxFileUnits,{UnitScaleFactor:factor,OriginalUnitScaleFactor:original});
    const design={...f.design,route:'native-fbx/1',source:{...cat.source,catalogSha256:cat.catalogSha256,meshId:mesh.meshId},values:{[key]:.5},bake:[key],preserve:runtime,
      recipe:{...f.design.recipe,sourceSha256:cat.source.sha256,designKeys:[key],runtimeKeys:runtime,eyeChecks:{status:'unsupported',reason:'File-unit roundtrip fixture; geometry and skinning are independently observed'}},requiredChecks:['geometry']};
    const designPath=join(f.root,`units-${factor}-design.json`),output=join(f.root,`units-${factor}-candidate`);writeFileSync(designPath,JSON.stringify(design));
    success(run(f.root,tool,['bake','--design',designPath,'--output-dir',output]));
    assert.deepEqual(read(join(output,'candidate.json')).fbxFileUnits,cat.fbxFileUnits);
    success(run(f.root,observer,['--design',designPath,'--candidate-dir',output,'--output',join(f.root,`units-${factor}-observation.json`)]));
    const mutate=join(f.root,'alter-unit-history.py');writeFileSync(mutate,`import sys,json,hashlib
from pathlib import Path
sys.path.insert(0,${JSON.stringify(toolRoot)})
from blender_face_common import fbx_file_units
p=Path(sys.argv[-1]);fbx_file_units(p/'candidate.fbx',123)
r=json.loads((p/'candidate.json').read_text());r['outputs']['fbx']['sha256']=hashlib.sha256((p/'candidate.fbx').read_bytes()).hexdigest();(p/'candidate.json').write_text(json.dumps(r))
`);
    success(run(f.root,mutate,[output]));fails(run(f.root,observer,['--design',designPath,'--candidate-dir',output,'--output',join(f.root,`units-${factor}-forged-observation.json`)]),/FBX file units differ/);
  }
});
