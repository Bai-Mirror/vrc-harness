import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
const tools=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));
const blender=process.env.AVH_TEST_BLENDER??(process.platform==='win32'?'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe':'/usr/bin/blender');
test('real combination/bake/readback accepts 0.4 blended moving eyes and rejects stationary, weak islands and forged surfaces', {skip:!existsSync(blender),timeout:180000},t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-eye-motion-'));t.after(()=>removeTemp(root));
 const script=join(root,'fixture.py');writeFileSync(script,`
import bpy,sys,json,copy
from pathlib import Path
sys.dont_write_bytecode=True
root=Path(sys.argv[-1]);sys.path.insert(0,sys.argv[-2])
import face
from blender_face_common import catalog,validate_design
bpy.ops.wm.read_factory_settings(use_empty=True)
rigdata=bpy.data.armatures.new('Skeleton');rig=bpy.data.objects.new('Rig',rigdata);bpy.context.collection.objects.link(rig);rig.select_set(True);bpy.context.view_layer.objects.active=rig
bpy.ops.object.mode_set(mode='EDIT')
for name,x in [('Head',0),('LeftEye',-.02),('RightEye',.02)]:
 b=rigdata.edit_bones.new(name);b.head=(x,0,0);b.tail=(x,0,.02)
 if name!='Head':b.parent=rigdata.edit_bones['Head']
bpy.ops.object.mode_set(mode='OBJECT')
from mathutils import Quaternion,Vector,Matrix
# Real imported identity noise: matrix elements exceed the old pose cutoff,
# but actual skinning remains within the frozen one-micrometre noise floor.
rig.pose.bones['Head'].rotation_quaternion=Quaternion(Vector((0,1,0)),.000006)
points=[];faces=[]
def quad(x,y,z,size=.005):
 start=len(points);points.extend([(x-size,y,z-size),(x+size,y,z-size),(x+size,y,z+size),(x-size,y,z+size)]);faces.append(tuple(range(start,start+4)))
for x in [-.02,.02]:quad(x,0,0);quad(x,-.001,.018);quad(x,.003,0,.004);quad(x,-.002,.06,.03)
mesh=bpy.data.meshes.new('Face');mesh.from_pydata(points,[],faces);mesh.update();obj=bpy.data.objects.new('Face',mesh);bpy.context.collection.objects.link(obj);obj.parent=rig;mod=obj.modifiers.new('Skin','ARMATURE');mod.object=rig
uv=mesh.uv_layers.new(name='UV');mesh.materials.append(bpy.data.materials.new('Face'))
for loop in mesh.loops:uv.data[loop.index].uv=(mesh.vertices[loop.vertex_index].co.x,mesh.vertices[loop.vertex_index].co.z)
head=obj.vertex_groups.new(name='Head');head.add(list(range(len(points))),.6,'REPLACE')
for side,offset in [('LeftEye',0),('RightEye',16)]:
 eye=obj.vertex_groups.new(name=side);eye.add(list(range(offset,offset+4))+list(range(offset+8,offset+12)),.4,'REPLACE');eye.add(list(range(offset+12,offset+16)),.001,'REPLACE')
obj.shape_key_add(name='Basis');design=obj.shape_key_add(name='Contour');blink=obj.shape_key_add(name='Blink')
for offset in [0,16]:
 for i in range(offset+4,offset+8):blink.data[i].co.z-=.018
 for i in range(offset+4,offset+8):design.data[i].co.x+=.001
source=root/'source.blend';bpy.ops.wm.save_as_mainfile(filepath=str(source));cat=catalog(source);mesh=cat['meshes'][0];keymap={k['name']:k['id'] for k in mesh['keys'][1:]}
assert not mesh['posedRig'] and 0 < mesh['boneMotion']['sourcePoseMaxDisplacementMeters'] < 1e-6
assert max(abs(v) for row in bpy.data.objects['Rig'].pose.bones['Head'].matrix_basis-Matrix.Identity(4) for v in row)>1e-6
selected={'protectedKeys':['Blink'],'writers':[],'meshSnapshot':{'keys':[{'name':n,'frames':[{'weight':100}]} for n in keymap]},'eyeObservation':{'status':'source_controls_verified','blinkKey':'Blink','regions':[{'side':'left','eyePath':'Rig/LeftEye'},{'side':'right','eyePath':'Rig/RightEye'}]}}
d=face.combination_design(selected,cat,mesh,keymap,{'values':{'Contour':.1}},'fixture-moving-blended-eyes');recipe=d['recipe']['compensation']
assert [r['samplePolygons'] for r in recipe['regions']]==[[0],[4]]
assert all(max(row.get(n,0) for row in mesh['weights'])<.5 for n in ['LeftEye','RightEye'])
(root/'design.json').write_text(json.dumps(d));validate_design(d)
checks=0
def refuse(fn):
 global checks
 try:fn()
 except ValueError:checks+=1;return
 raise AssertionError('Invalid source/selection accepted')
m=copy.deepcopy(mesh);m['boneMotion']['bones']['LeftEye']['maxDisplacementMeters']=[0]*len(points);refuse(lambda:face.combination_design(selected,cat,m,keymap,{'values':{'Contour':.1}},'static'))
m=copy.deepcopy(mesh);del m['boneMotion'];refuse(lambda:face.combination_design(selected,cat,m,keymap,{'values':{'Contour':.1}},'missing'))
m=copy.deepcopy(mesh);m['boneMotion']['bones']['LeftEye']['maxDisplacementMeters'][0]=float('nan');refuse(lambda:face.combination_design(selected,cat,m,keymap,{'values':{'Contour':.1}},'invalid'))
bad=copy.deepcopy(d);bad['recipe']['compensation']['regions'][0]['samplePolygons']=[2];refuse(lambda:validate_design(bad))
bad=copy.deepcopy(d);bad['recipe']['compensation']['regions'][0]['surfaceIdentitySha256']='0'*64;refuse(lambda:validate_design(bad))
# Restore the old selector in a private copy of the actual production caller.
import types
old=types.ModuleType('old_face')
text=Path(face.__file__).read_text().replace('all(v in supported[name] for v in p["vertices"])','all(mesh["weights"][v].get(name, 0) > .5 for v in p["vertices"])')
exec(compile(text,face.__file__,'exec'),old.__dict__)
refuse(lambda:old.combination_design(selected,cat,mesh,keymap,{'values':{'Contour':.1}},'old-threshold'))
# Remove the physical pose fix too: the old matrix cutoff rejects this same
# real source on the actual validate/bake path, despite submicrometre skinning.
import blender_face_common as common
old_common=types.ModuleType('old_common');old_common.__file__=common.__file__
pose_text=Path(common.__file__).read_text().replace('motion["sourcePoseMaxDisplacementMeters"] > motion["poseNoiseFloorMeters"] if motion else', '')
exec(compile(pose_text,common.__file__,'exec'),old_common.__dict__)
old_cat=old_common.catalog(source);old_mesh=old_cat['meshes'][0];old_map={k['name']:k['id'] for k in old_mesh['keys'][1:]}
old_design=face.combination_design(selected,old_cat,old_mesh,old_map,{'values':{'Contour':.1}},'old-pose-cutoff')
refuse(lambda:old_common.validate_design(old_design))
(root/'result.json').write_text(json.dumps({'negativeChecks':checks,'samplePolygons':[r['samplePolygons'] for r in recipe['regions']]}))
`);
 const run=(script:string,args:string[])=>execFileSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','2','--python',script,'--',...args],{timeout:180000,windowsHide:true,env:{...process.env,BLENDER_USER_CONFIG:join(root,'config'),BLENDER_USER_SCRIPTS:join(root,'scripts')},stdio:'pipe'});
 run(script,[tools,root]);assert.equal(JSON.parse(readFileSync(join(root,'result.json'),'utf8')).negativeChecks,7);
 run(join(tools,'blender_face.py'),['bake','--design',join(root,'design.json'),'--output-dir',join(root,'candidate')]);
 run(join(tools,'blender_face_observe.py'),['--design',join(root,'design.json'),'--candidate-dir',join(root,'candidate'),'--output',join(root,'verification.json')]);
 const verification=JSON.parse(readFileSync(join(root,'verification.json'),'utf8'));assert.equal(verification.status,'required_tool_checks_passed');
});

test('real Blender launcher uses the full readback execution budget and the old local cutoff fails the caller', {skip:!existsSync(blender),timeout:60000},t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-face-budget-'));t.after(()=>removeTemp(root));
 const fixture=join(root,'source.py');writeFileSync(fixture,`import bpy,sys\nbpy.ops.wm.save_as_mainfile(filepath=sys.argv[-1])\n`);
 execFileSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','2','--python',fixture,'--',join(root,'source.blend')],{timeout:30000,windowsHide:true,stdio:'pipe'});
 const script=join(root,'launch.py');writeFileSync(script,`
import sys,json,types,os
from pathlib import Path
os.environ.pop("AVH_BLENDER_TIMEOUT_SEC",None)
sys.path.insert(0,sys.argv[1]);import face
root=Path(sys.argv[2]).resolve();binary=face.binary(sys.argv[3]);original=face.subprocess.run;calls=[]
def guarded(command,**kwargs):
 if '--python' in command:
  assert kwargs['timeout']==3600, 'Complete readback needs its actual execution budget'
  calls.append(command)
 return original(command,**kwargs)
face.subprocess.run=guarded
face.launch(root,binary,Path(sys.argv[1])/'blender_face.py',['catalog','--source',root/'source.blend','--output',root/'catalog.json'])
assert json.loads((root/'catalog.json').read_text())['schema']=='face-catalog/0.1' and len(calls)==1
old=types.ModuleType('old_face');old.__file__=face.__file__
exec(compile(Path(face.__file__).read_text().replace('timeout=blender_timeout()','timeout=900'),face.__file__,'exec'),old.__dict__)
try:old.launch(root,binary,Path(sys.argv[1])/'blender_face.py',['catalog','--source',root/'source.blend','--output',root/'old-catalog.json'])
except AssertionError:pass
else:raise AssertionError('Restored short deadline passed the real caller')
assert not (root/'old-catalog.json').exists()
`);
 execFileSync(process.platform==='win32'?'python':'python3',[script,tools,root,blender],{timeout:45000,windowsHide:true,stdio:'pipe'});
});
