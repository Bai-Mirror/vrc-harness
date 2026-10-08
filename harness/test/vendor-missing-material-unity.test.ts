import assert from 'node:assert/strict';
import {copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {freemem, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {parse as parseYaml} from 'yaml';
import {execUnityEditor, unityFixtureRunDir} from './fixtures/unity-slot.ts';
import {removeTemp} from './fixtures/platform.ts';
import {evaluateRule, parseRule} from '../src/process/rule.ts';
import {listProcesses} from '../src/exec/windows-helper.ts';
import {waitFor} from './fixtures/wait.ts';
const tools=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));
const python=process.platform==='win32'?'python':'python3';
const stage=readFileSync(join(tools,'unity/Editor/OutfitStage.cs'),'utf8');
function bodyMutation(source:string,signature:string,body:string){
 const start=source.indexOf('{',source.indexOf(signature));assert.ok(start>=0);let depth=1,end=start+1;
 while(depth&&end<source.length){if(source[end]==='{')depth++;if(source[end]==='}')depth--;end++;}
 assert.equal(depth,0);return source.slice(0,start+1)+body+source.slice(end-1);
}
test('real vendor GUIDs pass setup, whole-avatar assembly, independent Observe and delivery; behavior mutations fail',
 {skip:!process.env.AVH_LOCAL_UNITY_EDITOR||!process.env.AVH_LOCAL_UNITY_BASELINE?'Set Unity editor and isolated SDK baseline':false,timeout:3600000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-vendor-missing-unity-'));t.after(()=>removeTemp(root));
 const evidence=process.env.AVH_LOCAL_UNITY_EVIDENCE;if(evidence)mkdirSync(evidence,{recursive:true});
 const preserve=(name:string)=>{if(evidence&&existsSync(join(root,name)))cpSync(join(root,name),join(evidence,name),{recursive:true});};
 for(const path of ['Assets/Editor','Packages','ProjectSettings','owned-pool','setup-scratch'])mkdirSync(join(root,path),{recursive:true});
 cpSync(join(process.env.AVH_LOCAL_UNITY_BASELINE!,'Packages'),join(root,'Packages'),{recursive:true});
 const manifest=JSON.parse(readFileSync(join(root,'Packages/manifest.json'),'utf8'));
 for(const value of Object.values(manifest.dependencies??{}))assert.ok(!String(value).startsWith('file:'),'baseline must not reference external paths');
 writeFileSync(join(root,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
 execFileSync(python,['-c','import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})',tools,root],{stdio:'pipe',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 copyFileSync(fileURLToPath(new URL('./fixtures/unity/VendorMissingMaterialIntegration.cs',import.meta.url)),join(root,'Assets/Editor/VendorMissingMaterialIntegration.cs'));
 const capacity=()=>waitFor(()=>{
  const editors=process.platform==='win32'?listProcesses('Unity.exe').length:0;
  const gib=freemem()/1024**3;console.log(`F44 Unity capacity: ${editors} editors, ${gib.toFixed(1)} GiB free`);
  return editors<2&&gib>=6;
 },{what:'fewer than two Unity editors and the launcher memory reserve',timeoutMs:1800000,intervalMs:120000});
 const execute=async(mode:string,label:string)=>{
  await capacity();
  rmSync(join(root,'result.json'),{force:true});
  let failure:unknown;
  try{execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!,['-batchmode','-projectPath',root,'-executeMethod','AVH.Harness.VendorMissingMaterialIntegration.Run','-logFile',join(root,label+'.log')],{timeout:1800000,env:{...process.env,AVH_PROJECT_DIR:root,AVH_TOOL_ROOT:join(tools,'..'),AVH_ASSET_LIBRARY:join(root,'owned-pool'),AVH_VENDOR_FIXTURE_MODE:mode},stdio:'pipe'});}catch(error){failure=error;}
  preserve(label+'.log');if(!existsSync(join(root,'result.json'))){preserve('.avh-unity-fixture');preserve('Logs');}assert.ok(existsSync(join(root,'result.json')),`no Unity report: ${failure}`);
  const report=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));writeFileSync(join(root,label+'-result.json'),JSON.stringify(report,null,2));preserve(label+'-result.json');
  if(!report.ok){preserve('.avh-unity-fixture/observations');preserve('Assets/_Harness/Outfit');}
  assert.equal(report.ok,true,report.error);return report;
 };
 await execute('prepare','prepare');preserve('Assets/VendorFixture');
 const archive=join(root,'owned-pool','synthetic-vendor.unitypackage');
 execFileSync(python,['-c',`import io,sys,tarfile,re
from pathlib import Path
root=Path(sys.argv[1])
with tarfile.open(sys.argv[2],'w:gz') as t:
 for folder in ['Assets/VendorFixture','Assets/MigratedFixture']:
  for asset in sorted((root/folder).rglob('*')):
   if not asset.is_file() or asset.suffix=='.meta':continue
   meta=Path(str(asset)+'.meta');guid=re.search(r'guid: ([0-9a-f]{32})',meta.read_text()).group(1)
   for leaf,data in [('pathname',asset.relative_to(root).as_posix().encode()),('asset',asset.read_bytes()),('asset.meta',meta.read_bytes())]:
    row=tarfile.TarInfo(guid+'/'+leaf);row.size=len(data);t.addfile(row,io.BytesIO(data))`,root,archive]);
 mkdirSync(join(root,'_harness/intake'),{recursive:true});
 writeFileSync(join(root,'_harness/intake/inventory.json'),JSON.stringify({items:[{item:archive,role:'body',files:[{name:'synthetic-vendor.unitypackage',selected:true}]}]}));
 execFileSync(python,['-c',`import json,sys
from pathlib import Path
from setup import snapshot_inputs,unpack_selected
from intake import file_digest
root=Path(sys.argv[1]);archive=Path(sys.argv[2]);inventory={'items':[{'item':str(archive),'found':True,'role':'body','files':[{'name':archive.name,'selected':True,'sha256':file_digest(archive)}]}]}
(root/'_harness/intake/inventory.json').write_text(json.dumps(inventory));scratch=root/'setup-scratch'
record={'schema':'setup/0.1'};snapshots=snapshot_inputs(root/'owned-pool',inventory,scratch)
unpack_selected(root,root/'owned-pool',inventory,scratch,record,snapshots)
(root/'_harness/setup').mkdir(parents=True,exist_ok=True);(root/'_harness/setup/import.json').write_text(json.dumps(record))`,root,archive],{env:{...process.env,PYTHONPATH:tools,PYTHONDONTWRITEBYTECODE:'1'}});
 preserve('_harness/setup/import.json');
 for(const [kind,body,outfit]of [['body','BodyMissing',undefined],['garment','PlainBody','GarmentMissing'],['nested','NestedBody',undefined],['variant','VariantMissing',undefined],['texture','TextureBody',undefined],['own','OwnMissing',undefined],['middle','MiddleMissing',undefined],['multitail','MultipleTail',undefined],['multisubmesh','MultiSubmeshOwn',undefined]]as const){
  const out=join(root,'setup-scratch',kind+'.json');
  execFileSync(python,[join(tools,'observe_assets.py'),'--project',root,'--library',join(root,'owned-pool'),'--out',out],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',AVH_STAGE:'setup',AVH_RUN_DIR:join(root,'setup-run'),AVH_PLAN:JSON.stringify({schema:'plan/0.2',body_prefab:`Assets/VendorFixture/${body}.prefab`,outfits:outfit?[{id:'garment',prefab:`Assets/VendorFixture/${outfit}.prefab`}]:[]}),AVH_MANIFEST:'{}'}});
  preserve('setup-scratch');const observed=JSON.parse(readFileSync(out,'utf8'));assert.equal(observed.metrics.broken_guid_refs,0,JSON.stringify(observed.notes));assert.equal(observed.metrics.vendor_missing_material_slots,kind==='texture'?0:['middle','multitail','multisubmesh'].includes(kind)?2:1,kind+JSON.stringify(observed.notes));assert.match(observed.notes.join('\n'),kind==='texture'?/厂商材质贴图缺件提醒.*_MainTex/:/对象 .*槽位 \d/);assert.equal(existsSync(join(root,'setup-run','vendor-missing-material-slots.json')),false);
 }
 const hashCode="import hashlib,json,sys;from pathlib import Path;print(json.dumps({str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in Path(sys.argv[1]).rglob('*') if p.is_file()}))";
 const sources=execFileSync(python,['-c',hashCode,join(root,'Assets/VendorFixture')],{encoding:'utf8'});
 const report=await execute('check','normal');assert.equal(report.assertions,62);
 const definition=parseYaml(readFileSync(new URL('../builtin/knowledge/process/pc-recolor-outfit.process.yaml',import.meta.url),'utf8'));
 const check=definition.checks.find((row:any)=>row.id==='assembly_guid_refs_resolved');assert.equal(check.observe,'avatar.dependencies');
 for(const kind of ['body','garment','nested','variant']){
  const metrics=JSON.parse(readFileSync(join(root,kind+'-observation.json'),'utf8')).metrics;assert.equal(evaluateRule(parseRule(check.rule),metrics,{}).result,'pass');preserve(kind+'-observation.json');preserve(kind+'-record.json');
  copyFileSync(join(root,kind+'-record.json'),join(root,'Assets/_Harness/Outfit/outfit.json'));
  const note=execFileSync(python,['-c',"import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from package import delivery_note;print(delivery_note(Path(sys.argv[2]),'Synthetic',{},[]))",tools,root],{encoding:'utf8'});assert.match(note,/槽位数 2 → 1/);assert.match(note,new RegExp('d'.repeat(32)));writeFileSync(join(root,kind+'-delivery.txt'),note);preserve(kind+'-delivery.txt');
 }
 preserve('visual-result.json');if(evidence)cpSync(join(unityFixtureRunDir(root),'visual'),join(evidence,'visual'),{recursive:true});
 preserve('texture-observation.json');preserve('texture-record.json');preserve('shader-observation.json');preserve('menu-observation.json');
 copyFileSync(join(root,'texture-record.json'),join(root,'Assets/_Harness/Outfit/outfit.json'));
 const textureNote=execFileSync(python,['-c',"import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from package import delivery_note;print(delivery_note(Path(sys.argv[2]),'Synthetic',{},[]))",tools,root],{encoding:'utf8'});
 assert.match(textureNote,/厂商材质贴图缺件提醒/);assert.match(textureNote,new RegExp('f'.repeat(32)));writeFileSync(join(root,'texture-delivery.txt'),textureNote);preserve('texture-delivery.txt');
 const formalEnv={...process.env,AVH_PROJECT_DIR:root,AVH_TOOL_ROOT:join(tools,'..'),AVH_ASSET_LIBRARY:join(root,'owned-pool'),AVH_MANIFEST:'{}',
  AVH_PLAN:JSON.stringify({schema:'plan/0.2',body:'synthetic',body_prefab:'Assets/VendorFixture/BodyMissing.prefab',default_outfit:null,outfits:[]})};
 for(const [method,label]of [['AVH.Harness.OutfitStage.Run','formal-produce'],['AVH.Harness.OutfitStage.Observe','formal-observe']]){
  await capacity();execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!,['-batchmode','-projectPath',root,'-executeMethod',method,'-logFile',join(root,label+'.log')],
   {timeout:1800000,env:formalEnv,stdio:'pipe'});preserve(label+'.log');
 }
 const formal=JSON.parse(readFileSync(join(unityFixtureRunDir(root),'observations/avatar.dependencies.json'),'utf8'));
 assert.equal(evaluateRule(parseRule(check.rule),formal.metrics,{}).result,'pass');
 const clothing=JSON.parse(readFileSync(join(unityFixtureRunDir(root),'observations/clothing.install.json'),'utf8'));
 writeFileSync(join(root,'formal-body-clothing.json'),JSON.stringify(clothing,null,2));preserve('formal-body-clothing.json');
 // FX8: the controller fixture is prepared and checked through the same real Observe path.
 await execute('prepare-animation','animation-prepare');
 await execute('check-animation','animation-check');
 const noVendorAnimation=bodyMutation(stage,'static bool VendorAnimationReference','\n controllerPath = ""; motionName = ""; return false;\n ');
 writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),noVendorAnimation);
 await assert.rejects(()=>execute('check-animation','mutant-no-vendor-animation'),/vendor missing motion must be a reminder/,
   'removing the vendor-animation classification must make the fixture fail');
 const blockedMotions=JSON.parse(readFileSync(join(unityFixtureRunDir(root),'observations/avatar.dependencies.json'),'utf8'));
 assert.equal(blockedMotions.metrics.broken_guid_refs,2,'without the classification both motion identities must block');
 assert.equal(blockedMotions.metrics.vendor_missing_animation_references,0);
 const resolvedGuidGuard='|| !string.IsNullOrEmpty(AssetDatabase.GUIDToAssetPath(reference.Guid))';
 assert.ok(stage.includes(resolvedGuidGuard),'the GUID-resolution guard must be present to mutate');
 writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),stage.replace(resolvedGuidGuard,'|| false'));
 await assert.rejects(()=>execute('check-animation','mutant-allow-wrong-motion-fileid'),/vendor missing motion must be a reminder/,
   'allowing resolved GUIDs must fail the wrong-fileID control arm');
 const unblockedMotions=JSON.parse(readFileSync(join(unityFixtureRunDir(root),'observations/avatar.dependencies.json'),'utf8'));
 assert.equal(unblockedMotions.metrics.broken_guid_refs,0,'the mutation must incorrectly exempt the existing asset with the wrong fileID');
 assert.equal(unblockedMotions.metrics.vendor_missing_animation_references,2);
 writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),stage);
 const mapped=definition.checks.find((row:any)=>row.id==='mergearmature_mapped');
 assert.equal(evaluateRule(parseRule(mapped.rule),clothing.metrics,{}).result,'pass');
 writeFileSync(join(root,'formal-body-observation.json'),JSON.stringify(formal,null,2));preserve('formal-body-observation.json');
 writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),bodyMutation(stage,'public static List<object> TrimMissingTailMaterials(GameObject avatar)','\n return new List<object>();\n '));
 await assert.rejects(()=>execute('check','mutant-no-trim'),/whole-avatar trim missing/,'a no-op trim must fail the same formal-path assertion');
 const skipped=stage.replace('if (property.propertyType != SerializedPropertyType.ObjectReference) continue;','if (property.propertyType != SerializedPropertyType.ObjectReference) continue; if (value is Renderer && property.propertyPath.StartsWith("m_Materials.Array.data[")) continue;');assert.notEqual(skipped,stage);writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),skipped);
 await assert.rejects(()=>execute('check','mutant-skip-slots'),/Observe skipped real missing material slots/,'skipped slot checks must fail the same formal-path assertion');
 const blockVendor=bodyMutation(stage,'static bool VendorMaterialReference','\n return false;\n ');writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),blockVendor);
 await assert.rejects(()=>execute('check','mutant-block-vendor-material'),/vendor material missing texture the imported original carries must only remind/);
 const allowGenerated=stage.replace('if (!path.StartsWith("Assets/") || path.StartsWith("Assets/_Harness")) return false;', 'if (path.StartsWith("Assets/_Harness")) return true; if (!path.StartsWith("Assets/")) return false;');assert.notEqual(allowGenerated,stage);writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),allowGenerated);
 await assert.rejects(()=>execute('check','mutant-allow-generated-material'),/generated material internal missing reference must block/);
  // The exemption asks whether the imported archive member carries the same missing GUID. Requiring the
  // file's bytes to be untouched instead must fail the rewritten-original counterexample.
  const originCondition='return origin.List("origin_references").Any(g => g.ToString() == reference.Guid)\n                && origin.List("unavailable_guids").Any(g => g.ToString() == reference.Guid);';
  assert.ok(stage.includes(originCondition),'the imported-original condition must be present to mutate');
  writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),
    stage.replace(originCondition,'return Equals(origin["unchanged"], true) && origin.List("unavailable_guids").Any(g => g.ToString() == reference.Guid);'));
  await assert.rejects(()=>execute('check','mutant-origin-bytes-only'),/rewritten vendor material the imported original still names must only remind/,'requiring byte-identical vendor bytes must fail the rewritten-original assertion');
  // Dropping the imported-original requirement leaves only "no owned source provides it", which must
  // fail the counterexample whose reference appeared after the import.
  writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),
    stage.replace(originCondition,'return origin.List("unavailable_guids").Any(g => g.ToString() == reference.Guid);'));
  await assert.rejects(()=>execute('check','mutant-origin-dropped'),/dangling texture GUID the imported original never carried must block/,'dropping the imported-original requirement must fail the post-import-reference assertion');
 const attributeGuard=stage.split('\n').find(line=>line.includes('if (!Regex.IsMatch(property.propertyPath'))!;assert.ok(attributeGuard);
 const noAttribute=stage.replace(attributeGuard,'');assert.notEqual(noAttribute,stage);writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),noAttribute);
 await assert.rejects(()=>execute('check','mutant-untyped-material-exemption'),/vendor missing shader must block/);
 // The performance assertion above is the only thing that catches a traversal which still answers
 // correctly while rescanning and reparsing each source per reference; both caches go away together.
 const noResolutionCache=stage
  .replace('if (source.Documents == null)','if (true)')
  .replace('if (parsed != null) parsed.Roots[id] = document;','if (false) parsed.Roots[id] = document;');
 assert.notEqual(noResolutionCache,stage,'the resolution caches must be present to mutate');
 writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),noResolutionCache);
 await assert.rejects(()=>execute('check','mutant-no-resolution-cache'),/index a source file and parse a document once, not once per reference/,'per-reference rescanning and reparsing must fail the same formal-path assertion');
 // Entering a mesh's byte buffers cannot find a dependency, so the traversal must stay out of them.
 const alwaysEnter=stage.replace('if (property.isArray && !ArrayHoldsReferences(property))','if (false && property.isArray && !ArrayHoldsReferences(property))');
 assert.notEqual(alwaysEnter,stage,'the primitive-array skip must be present to mutate');
 writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),alwaysEnter);
 await assert.rejects(()=>execute('check','mutant-enter-primitive-arrays'),/a primitive array must not be entered/,'entering primitive arrays must fail the same formal-path assertion');
 const flatDirect=stage.replace('var body = Document(text, id);',String.raw`var body = Document(text, id);
 if(property.StartsWith("controls.")) {
  var leaf=property.Split('.').Last();var refs=Regex.Matches(body,@"(?m)^\s*"+Regex.Escape(leaf)+@":\s*(\{[^}]*\})");
  var index=Regex.Match(property,@"\.Array\.data\[(\d+)\]");
  return index.Success&&int.Parse(index.Groups[1].Value)<refs.Count?Parse(refs[int.Parse(index.Groups[1].Value)].Groups[1].Value,source):null;
 }
 `);assert.notEqual(flatDirect,stage);writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),flatDirect);
 await assert.rejects(()=>execute('check','mutant-first-array-index'),/full nested menu path must expose/);
  // Rule 1: a default-empty field no source locates is an observation, not a broken link. Counting it again must
  // fail the same formal-path assertion the real avatar's unlocated null references produced.
  const noUnlocated=stage.replace('if (reference.Uncertain && !reference.Nonzero && property.objectReferenceInstanceIDValue == 0)',
   'if (false && reference.Uncertain && !reference.Nonzero && property.objectReferenceInstanceIDValue == 0)');
  assert.notEqual(noUnlocated,stage,'the unlocated-default rule must be present to mutate');
  writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),noUnlocated);
  await assert.rejects(()=>execute('check','mutant-unlocated-counted-broken'),/default-empty field no source locates must not be a broken link/);
  // Rule 2, first part: a pointer the source text does locate stays blocking. Dropping it must fail the
  // dangling-GUID counterexample.
  const noLocatedPointer=stage.replace('if (raw != null) return raw.Nonzero || raw.Uncertain ? raw : null;','if (raw != null) return raw.Uncertain ? raw : null;');
  assert.notEqual(noLocatedPointer,stage,'the located-pointer guard must be present to mutate');
  writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),noLocatedPointer);
  await assert.rejects(()=>execute('check','mutant-dangling-pointer-ignored'),/a located dangling GUID must stay blocking/);
  // Rule 2, second part: an object Unity still holds an instance identity for stays blocking even though no
  // source text locates it. Dropping the identity must fail the lost-object counterexample.
  const noInstanceIdentity=stage.replace('return property.objectReferenceInstanceIDValue != 0 ? new Reference { FileId = property.objectReferenceInstanceIDValue } : null;','return null;');
  assert.notEqual(noInstanceIdentity,stage,'the instance-identity guard must be present to mutate');
  writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),noInstanceIdentity);
  await assert.rejects(()=>execute('check','mutant-lost-object-ignored'),/a lost object Unity still identifies must stay blocking/);
 writeFileSync(join(root,'Assets/_HarnessTools/Editor/OutfitStage.cs'),stage);
 const after=execFileSync(python,['-c',hashCode,join(root,'Assets/VendorFixture')],{encoding:'utf8'});assert.equal(after,sources,'vendor sources must remain byte-identical');
});
