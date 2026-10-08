import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor } from './fixtures/unity-slot.ts';
const tools=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));
const blender=process.env.AVH_TEST_BLENDER??(process.platform==='win32'?'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe':'/usr/bin/blender');
test('native FBX uses the identical importer and metadata, preserves key slots and rejects real UV and skinning faults', {skip:!process.env.AVH_FACE_UNITY_EDITOR||!existsSync(blender),timeout:600000},t=>{
 const parent=mkdtempSync(join(tmpdir(),'avh-native-face-')),root=join(parent,'nested-project-comparison');t.after(()=>{if(!process.env.AVH_FACE_KEEP_PROJECT)removeTemp(parent);});
 for(const dir of ['Assets/Editor','Assets/Source','Assets/_Harness/Face','Packages','ProjectSettings'])mkdirSync(join(root,dir),{recursive:true});
 writeFileSync(join(root,'Packages/manifest.json'),'{"dependencies":{}}');writeFileSync(join(root,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
 for(const name of ['FaceStage.cs','FaceMapping.cs','FaceGeometry.cs','FaceEyes.cs','AvhCommon.cs'])copyFileSync(join(tools,'unity/Editor',name),join(root,'Assets/Editor',name));
 copyFileSync(fileURLToPath(new URL('./fixtures/unity/FaceNativeIntegration.cs',import.meta.url)),join(root,'Assets/Editor/FaceNativeIntegration.cs'));
 const script=join(root,'fixture.py');writeFileSync(script,`import bpy,sys,json
from pathlib import Path
root=Path(sys.argv[-1]);sys.path.insert(0,sys.argv[-2])
from blender_face_common import FBX_EXPORT
bpy.ops.wm.read_factory_settings(use_empty=True)
rigdata=bpy.data.armatures.new('Skeleton');rig=bpy.data.objects.new('Rig',rigdata);bpy.context.collection.objects.link(rig);rig.select_set(True);bpy.context.view_layer.objects.active=rig
bpy.ops.object.mode_set(mode='EDIT');bone=rigdata.edit_bones.new('Head');bone.head=(0,0,0);bone.tail=(0,0,.1);bpy.ops.object.mode_set(mode='OBJECT')
for name,offset in [('Face',0),('Other',.1)]:
 mesh=bpy.data.meshes.new(name);mesh.from_pydata([(-.03,offset,-.003),(-.03,offset,.003),(.03,offset,.003),(.03,offset,-.003)],[],[(0,1,2),(0,2,3)]);mesh.update()
 obj=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(obj);obj.parent=rig;mod=obj.modifiers.new('Skin','ARMATURE');mod.object=rig;obj.vertex_groups.new(name='Head').add(list(range(4)),1,'REPLACE')
 uv=mesh.uv_layers.new(name='UV');mesh.materials.append(bpy.data.materials.new(name+'Material'))
 for loop in mesh.loops:uv.data[loop.index].uv=(mesh.vertices[loop.vertex_index].co.x,mesh.vertices[loop.vertex_index].co.z)
 if name=='Face':
  obj.shape_key_add(name='Basis');key=obj.shape_key_add(name='Contour');runtime=obj.shape_key_add(name='Runtime')
  for v in key.data:v.co.x+=.002 if v.co.x>0 else -.002
  for v in runtime.data:v.co.z=0
 if name=='Other':
  obj.shape_key_add(name='Basis');key=obj.shape_key_add(name='InheritedDefault');key.value=.65
  for v in key.data:v.co.x+=.0005
bpy.ops.export_scene.fbx(filepath=str(root/'Assets/Source/source.fbx'),**FBX_EXPORT)
`);
 const runBlender=(script:string,args:string[])=>execFileSync(blender,['--background','--factory-startup','--disable-autoexec','--python-exit-code','2','--python',script,'--',...args],{windowsHide:true,timeout:120000,stdio:'pipe'});
 const unity=(method:string,log:string)=>execUnityEditor(process.env.AVH_FACE_UNITY_EDITOR!,['-batchmode','-nographics','-projectPath',root,'-executeMethod',method,'-logFile',join(root,log)],{windowsHide:true,timeout:300000,stdio:'pipe',env:{...process.env,AVH_PROJECT_DIR:root}});
 try{
  runBlender(script,[tools,root]);unity('AVH.Harness.FaceNativeIntegration.Seed','seed.log');
  runBlender(join(tools,'blender_face.py'),['catalog','--source',join(root,'Assets/Source/source.fbx'),'--output',join(root,'Assets/_Harness/Face/catalog.json')]);
  const designScript=join(root,'design.py');writeFileSync(designScript,`import json,sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1]);import face\np=Path(sys.argv[2]);cat=face.read(p/'Assets/_Harness/Face/catalog.json');obs=face.read(p/face.OBSERVATION);target=next(t for t in obs['targets'] if t['meshSnapshot']['keys']);mesh,keymap=face.mapped_mesh(target,cat);design=face.combination_design(target,cat,mesh,keymap,{'values':{'Contour':.1}},'test');face.write(p/'Assets/_Harness/Face/design-input.json',design)\n`);
  execFileSync(process.platform==='win32'?'python':'python3',[designScript,tools,root],{windowsHide:true});
  runBlender(join(tools,'blender_face.py'),['bake','--design',join(root,'Assets/_Harness/Face/design-input.json'),'--output-dir',join(root,'Assets/_Harness/Face/Candidates/test')]);
  runBlender(join(tools,'blender_face_observe.py'),['--design',join(root,'Assets/_Harness/Face/design-input.json'),'--candidate-dir',join(root,'Assets/_Harness/Face/Candidates/test'),'--output',join(root,'Assets/_Harness/Face/readback.json')]);
  unity('AVH.Harness.FaceNativeIntegration.Run','native.log');
  // Remove only the precision fix in the actual compiled production consumer.
  // The measured subtexel positive must now fail on ExposureProfile, before
  // the following negative controls can hide a regression.
  const eyesPath=join(root,'Assets/Editor/FaceEyes.cs'),eyes=readFileSync(eyesPath,'utf8');
  assert.ok(eyes.includes('size>0?.25f/size:1e-6f'));
  writeFileSync(eyesPath,eyes.replace('size>0?.25f/size:1e-6f','1e-6f'));
  try { assert.throws(()=>unity('AVH.Harness.FaceNativeIntegration.RunUvChecks','uv-fix-removed.log')); }
  finally { writeFileSync(eyesPath,eyes); }
  const removed=JSON.parse(readFileSync(join(root,'uv-result.json'),'utf8'));
  assert.equal(removed.ok,false);assert.match(removed.error,/Native eye source position\/UV surface coverage is incomplete/);
  assert.equal(removed.checks,7,'Removed fix must fail at the measured positive, after the original controls');
 }catch(error){console.log('Native integration evidence: '+root);throw new Error(String(error)+' '+['seed.log','native.log','native-result.json'].filter(n=>existsSync(join(root,n))).map(n=>readFileSync(join(root,n),'utf8').match(/.*(?:error CS|Exception|failed|error\":).*/g)?.slice(-8).join('\n')).join('\n'));}
 const result=JSON.parse(readFileSync(join(root,'native-result.json'),'utf8'));assert.equal(result.ok,true,result.error);assert.ok(result.checks>=7);assert.equal(result.productionAccepted,false);
 if(process.env.AVH_FACE_KEEP_PROJECT)console.log('Native integration evidence: '+root);
});
