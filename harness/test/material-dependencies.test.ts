import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {removeTemp} from './fixtures/platform.ts';
import {execUnityEditor} from './fixtures/unity-slot.ts';
const tools=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));
const sources=['LocalOperations.cs','OutfitStage.cs','OutfitVisibility.cs','SetupStage.cs','AvhCommon.cs','FaceStage.cs','FaceGeometry.cs','FaceEyes.cs','FaceMapping.cs','RecolorStage.cs','MenuStage.cs','AvatarAudit.cs','RegressionStage.cs'];
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const python=(()=>{try{execFileSync('python3',['--version']);return true;}catch{return false;}})();
function fixture(t:test.TestContext){
 const root=mkdtempSync(join(tmpdir(),'avh-material-deps-'));t.after(()=>removeTemp(root));
 const project=join(root,'project'),source=join(root,'source'),other=join(root,'other');
 for(const dir of [source,other,join(project,'_harness/intake'),join(project,'Assets/_Harness/Recolor'),join(project,'Assets/_HarnessTools/Editor')])mkdirSync(dir,{recursive:true});
 for(const name of sources)copyFileSync(join(tools,'unity/Editor',name),join(project,'Assets/_HarnessTools/Editor',name));
 const anchor=join(source,'Body_Adapter.zip');writeFileSync(anchor,'frozen input');
 writeFileSync(join(project,'_harness/intake/inventory.json'),JSON.stringify({items:[{item:anchor,role:'body',files:[{name:'Body_Adapter.zip',selected:true,sha256:sha(anchor)}]}]}));
 const make=(name:string,asset='first',path='Assets/Vendor/paint.mat')=>{
  const target=join(source,name);
  execFileSync('python3',['-c',`import sys,tarfile,zipfile,io
g='1'*32
b=io.BytesIO()
with tarfile.open(fileobj=b,mode='w:gz') as t:
 for n,d in [('pathname',sys.argv[3]),('asset',sys.argv[2]),('asset.meta','fileFormatVersion: 2\\nguid: '+g+'\\n')]:
  data=d.encode();i=tarfile.TarInfo(g+'/'+n);i.size=len(data);t.addfile(i,io.BytesIO(data))
with zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('Materials.unitypackage',b.getvalue())`,target,asset,path]);
  const inventory=JSON.parse(readFileSync(join(project,'_harness/intake/inventory.json'),'utf8'));
  const registered=inventory.items.find((item:any)=>item.item===source);
  const row=registered?.files.find((file:any)=>file.name===name);
  if(row) row.sha256=sha(target);
  else if(registered) registered.files.push({name,selected:true,sha256:sha(target)});
  else inventory.items.push({item:source,role:'other',files:[{name,selected:true,sha256:sha(target)}]});
  writeFileSync(join(project,'_harness/intake/inventory.json'),JSON.stringify(inventory));
  return {anchor,archive:target,sha256:sha(target)};
 };
 const request=(packages:any[])=>writeFileSync(join(project,'Assets/_Harness/Recolor/dependencies.json'),JSON.stringify({schema:'material-dependencies/0.1',packages}));
 const invoke=(action:string,roots=[source])=>execFileSync('python3',[join(tools,'material_dependencies.py'),action,...(action==='prepare'?sources.map(n=>join(tools,'unity/Editor',n)):[]),'--project',project],{env:{...process.env,AVH_ASSET_SEARCH_ROOTS_JSON:JSON.stringify(roots),PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',stdio:'pipe'});
 return {root,project,source,other,anchor,make,request,invoke};
}
function excludedRetryFixture(t:test.TestContext){
 const f=fixture(t),row=f.make('Materials.zip');f.request([row]);f.invoke('prepare');
 const receiptPath=join(f.project,'Assets/_Harness/Recolor/dependency-receipt.json');
 const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
 const asset=join(f.project,receipt.packages[0].assets[0].path);
 const plan={unused:[{item:f.source,reason:'client_declined',note:'customer installs it'}],
  obligations:[{input:f.anchor,role:'body',action:'use',target:'outfit',due_stage:'outfit'},
   {input:f.source,role:'other',action:'exclude',reason:'customer installs it'}]};
 rmSync(join(f.project,'Assets/_Harness/Recolor/dependencies.json'));
 const env={...process.env,AVH_PLAN:JSON.stringify(plan),AVH_ASSET_SEARCH_ROOTS_JSON:JSON.stringify([f.source]),
  AVH_RUN_DIR:join(f.root,'retire-run'),PYTHONDONTWRITEBYTECODE:'1'};
 const run=(script=join(tools,'material_dependencies.py'))=>execFileSync('python3',[script,'prepare',...sources.map(n=>join(tools,'unity/Editor',n)),'--project',f.project],{env:{...env,PYTHONPATH:tools},encoding:'utf8',stdio:'pipe'});
 return { ...f, row, receiptPath, receipt, asset, plan, env, run };
}
test('actual dependency prepare replaces forged receipt with source evidence and preserves every original', {skip:!python},t=>{
 const f=fixture(t),row=f.make('Materials.zip');f.request([row]);
 writeFileSync(join(f.project,'Assets/_Harness/Recolor/dependency-receipt.json'),'forged approval');
 const before=sha(row.archive);f.invoke('prepare');
 const receipt=JSON.parse(readFileSync(join(f.project,'Assets/_Harness/Recolor/dependency-receipt.json'),'utf8'));
 assert.equal(receipt.packages[0].assets.length,1);assert.equal(readFileSync(join(f.project,receipt.packages[0].assets[0].path),'utf8'),'first');
 assert.equal(sha(row.archive),before);assert.equal(readFileSync(f.anchor,'utf8'),'frozen input');
 const discovery=JSON.parse(f.invoke('inspect'));assert.deepEqual(discovery.candidates,[row]);
});
test('a retained other accessory can anchor dependency recovery, and restoring the role filter breaks it', {skip:!python},t=>{
 const f=fixture(t),row=f.make('Materials.zip');
 const inventory=JSON.parse(readFileSync(join(f.project,'_harness/intake/inventory.json'),'utf8'));
 inventory.items.find((item:any)=>item.item===f.anchor).role='other';
 writeFileSync(join(f.project,'_harness/intake/inventory.json'),JSON.stringify(inventory));
 const discovered=JSON.parse(f.invoke('inspect'));
 assert.deepEqual(discovered.candidates,[row]);
 f.request([row]);f.invoke('prepare');
 const mutant=join(f.root,'mutant-other-anchor.py');
 writeFileSync(mutant,readFileSync(join(tools,'material_dependencies.py'),'utf8')
  .replace("if value.get('item_path') and nfc(value['item_path'].name) == nfc(Path(key).name)}",
   "if value.get('item_path') and value.get('role') != 'other' and nfc(value['item_path'].name) == nfc(Path(key).name)}"));
 const broken=execFileSync('python3',[mutant,'inspect','--project',f.project],{env:{...process.env,PYTHONPATH:tools},encoding:'utf8'});
 assert.deepEqual(JSON.parse(broken).candidates,[],'mutation: the role filter drops a valid other accessory anchor');
});
test('real prepare refuses absent source consent and changed packages before a derived write', {skip:!python},t=>{
 const f=fixture(t),row=f.make('Materials.zip');f.request([row]);
 assert.throws(()=>f.invoke('prepare',[]),/授权/);
 writeFileSync(row.archive,'drift');assert.throws(()=>f.invoke('prepare'),/观察版本/);
 assert.equal(existsSync(join(f.project,'Assets/_Harness/Recolor/Dependencies')),false);
});
test('real prepare rejects cross-product anchors, traversal and existing GUID collisions', {skip:!python},t=>{
 const f=fixture(t),row=f.make('Materials.zip');f.request([{...row,anchor:row.archive}]);
 assert.throws(()=>f.invoke('prepare'),/锚点/);
 f.request([f.make('Materials.zip','first','Assets/../../original.mat')]);assert.throws(()=>f.invoke('prepare'),/路径不安全/);
 const good=f.make('Materials.zip');f.request([good]);mkdirSync(join(f.project,'Assets/Accepted'),{recursive:true});
 writeFileSync(join(f.project,'Assets/Accepted/original.mat'),'accepted');writeFileSync(join(f.project,'Assets/Accepted/original.mat.meta'),'guid: '+ '1'.repeat(32)+'\n');
 assert.throws(()=>f.invoke('prepare'),/不能覆盖原件/);assert.equal(readFileSync(join(f.project,'Assets/Accepted/original.mat'),'utf8'),'accepted');
 assert.equal(existsSync(join(f.project,'Assets/_Harness/Recolor/Dependencies')),false);
});
test('recolor dependency recovery treats a consistently excluded source as unavailable', {skip:!python},t=>{
 const f=fixture(t),row=f.make('Materials.zip');f.request([row]);
 const plan={unused:[{item:f.anchor,reason:'client_declined',note:'customer installs it'}],
  obligations:[{input:f.anchor,role:'other',action:'exclude',reason:'customer installs it'}]};
 const env={...process.env,AVH_PLAN:JSON.stringify(plan),AVH_ASSET_SEARCH_ROOTS_JSON:JSON.stringify([f.source]),PYTHONDONTWRITEBYTECODE:'1'};
 assert.throws(()=>execFileSync('python3',[join(tools,'material_dependencies.py'),'prepare',...sources.map(n=>join(tools,'unity/Editor',n)),'--project',f.project],{env,encoding:'utf8',stdio:'pipe'}),/依赖锚点/);
 assert.equal(existsSync(join(f.project,'Assets/_Harness/Recolor/Dependencies')),false);
 // Mutation: restoring the old raw-selection consumer makes the same request write excluded material data.
 const code=`import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import material_dependencies as m
m.effective_inventory=lambda inventory,plan: inventory
m.prepare(Path(sys.argv[2]), [Path(p) for p in sys.argv[3:]])`;
 execFileSync('python3',['-c',code,tools,f.project,...sources.map(n=>join(tools,'unity/Editor',n))],{env,encoding:'utf8',stdio:'pipe'});
 assert.equal(existsSync(join(f.project,'Assets/_Harness/Recolor/Dependencies')),true);
});

test('an anchor kept while its registered common source is excluded is refused by inspect and prepare', {skip:!python},t=>{
 const f=fixture(t),row=f.make('Materials.zip');
 const inventory={items:[
  {item:f.anchor,files:[{name:'Body_Adapter.zip',selected:true,sha256:sha(f.anchor)}]},
  {item:f.source,role:'other',files:[{name:'Materials.zip',selected:true,sha256:sha(row.archive)}]},
 ]};
 writeFileSync(join(f.project,'_harness/intake/inventory.json'),JSON.stringify(inventory));
 const plan={unused:[{item:f.source,reason:'client_declined',note:'customer installs it'}],
  obligations:[{input:f.anchor,role:'other',action:'use',target:'outfit',due_stage:'outfit'},
   {input:f.source,role:'other',action:'exclude',reason:'customer installs it'}]};
 const env={...process.env,AVH_PLAN:JSON.stringify(plan),AVH_ASSET_SEARCH_ROOTS_JSON:JSON.stringify([f.source]),PYTHONDONTWRITEBYTECODE:'1'};
 const inspect=JSON.parse(execFileSync('python3',[join(tools,'material_dependencies.py'),'inspect','--project',f.project],{env,encoding:'utf8'}));
 assert.deepEqual(inspect.candidates,[],'an excluded registered source cannot become a dependency candidate');
 f.request([row]);
 assert.throws(()=>execFileSync('python3',[join(tools,'material_dependencies.py'),'prepare',...sources.map(n=>join(tools,'unity/Editor',n)),'--project',f.project],{env,encoding:'utf8',stdio:'pipe'}),/源包不是有效选择/);
 const mutant=join(f.root,'mutant-material-dependencies.py');
 writeFileSync(mutant,readFileSync(join(tools,'material_dependencies.py'),'utf8')
  .replace("if source_state == 'not-effective':\n                raise ValueError('依赖源包不是有效选择，不能恢复')","if False:\n                raise ValueError('mutation')"));
 execFileSync('python3',[mutant,'prepare',...sources.map(n=>join(tools,'unity/Editor',n)),'--project',f.project],{env:{...env,PYTHONPATH:tools},encoding:'utf8',stdio:'pipe'});
 assert.equal(existsSync(join(f.project,'Assets/_Harness/Recolor/Dependencies')),true,
  'mutation: removing the source selection check restores excluded dependency output');
});

test('dependency receipt history stays flat and excluded recolor outputs are retired on a clean-request retry', {skip:!python},t=>{
 const f=fixture(t),row=f.make('Materials.zip');
 writeFileSync(join(f.project,'_harness/intake/inventory.json'),JSON.stringify({items:[
  {item:f.anchor,files:[{name:'Body_Adapter.zip',selected:true,sha256:sha(f.anchor)}]},
  {item:f.source,role:'other',files:[{name:'Materials.zip',selected:true,sha256:sha(row.archive)}]},
 ]}));
 const plan={unused:[{item:f.source,reason:'client_declined',note:'customer installs it'}],
  obligations:[{input:f.anchor,role:'other',action:'use',target:'outfit',due_stage:'outfit'},
   {input:f.source,role:'other',action:'exclude',reason:'customer installs it'}]};
 const request={schema:'material-dependencies/0.1',packages:[row],iris_layers:[]};
 const writeRequest=()=>writeFileSync(join(f.project,'Assets/_Harness/Recolor/dependencies.json'),JSON.stringify(request));
 writeRequest();f.invoke('prepare');
 writeRequest();f.invoke('prepare');
 writeRequest();f.invoke('prepare');
 const receiptPath=join(f.project,'Assets/_Harness/Recolor/dependency-receipt.json');
 const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
 assert.equal(receipt.history.length,2);
 assert.ok(receipt.history.every((entry:any)=>!('history' in entry)),'reruns must not nest complete histories');
 assert.ok(JSON.stringify(receipt).length < JSON.stringify({...receipt,history:[...receipt.history,...receipt.history]}).length,
  'receipt growth is one record per run');
 const asset=join(f.project,receipt.packages[0].assets[0].path);
 rmSync(join(f.project,'Assets/_Harness/Recolor/dependencies.json'));
 const env={...process.env,AVH_PLAN:JSON.stringify(plan),AVH_ASSET_SEARCH_ROOTS_JSON:JSON.stringify([f.source]),
  AVH_RUN_DIR:join(f.root,'retire-run'),PYTHONDONTWRITEBYTECODE:'1'};
 execFileSync('python3',[join(tools,'material_dependencies.py'),'prepare',...sources.map(n=>join(tools,'unity/Editor',n)),'--project',f.project],{env,encoding:'utf8',stdio:'pipe'});
 assert.equal(existsSync(asset),false,'excluded derived data is removed by the managed retry');
 assert.equal(existsSync(asset+'.meta'),false);
 const retired=JSON.parse(readFileSync(receiptPath,'utf8')).retired;
 assert.equal(retired.length,1);assert.equal(retired[0].path,receipt.packages[0].assets[0].path);
 assert.equal(retired[0].sha256,receipt.packages[0].assets[0].sha256);
 assert.equal(retired[0].meta_sha256,receipt.packages[0].assets[0].meta_sha256);
 assert.equal(retired[0].run_id,'retire-run');assert.equal(retired[0].status,'deleted');
 assert.doesNotThrow(()=>execFileSync('python3',[join(tools,'material_dependencies.py'),'prepare',...sources.map(n=>join(tools,'unity/Editor',n)),'--project',f.project],{env,encoding:'utf8',stdio:'pipe'}),
  'the receipt itself is not treated as a GUID reference on the next prepare');
});

test('excluded recolor retirement refuses changed bytes, missing hashes, traversal, and active _Harness references', {skip:!python},t=>{
 const tampered=excludedRetryFixture(t);writeFileSync(tampered.asset,'changed');
 assert.throws(()=>tampered.run(),/可能被改过/);assert.equal(readFileSync(tampered.asset,'utf8'),'changed');
 const missing=excludedRetryFixture(t);const missingReceipt=JSON.parse(readFileSync(missing.receiptPath,'utf8'));
 delete missingReceipt.packages[0].assets[0].meta_sha256;writeFileSync(missing.receiptPath,JSON.stringify(missingReceipt));
 assert.throws(()=>missing.run(),/缺少 sha256\/meta_sha256/);assert.ok(existsSync(missing.asset+'.meta'));
 const traversal=excludedRetryFixture(t);const traversalReceipt=JSON.parse(readFileSync(traversal.receiptPath,'utf8'));
 traversalReceipt.packages[0].assets[0].path='Assets/_Harness/Recolor/Dependencies/../bad.mat';writeFileSync(traversal.receiptPath,JSON.stringify(traversalReceipt));
 assert.throws(()=>traversal.run(),/越界/);assert.ok(existsSync(traversal.asset));
 const referenced=excludedRetryFixture(t);mkdirSync(join(referenced.project,'Assets/_Harness/Optimize'),{recursive:true});
 writeFileSync(join(referenced.project,'Assets/_Harness/Optimize/Avatar.prefab'),'%YAML 1.1\nguid: '+'1'.repeat(32)+'\n');
 assert.throws(()=>referenced.run(),/仍被工程引用/);assert.ok(existsSync(referenced.asset));
 const localPackage=excludedRetryFixture(t);mkdirSync(join(localPackage.project,'Packages/local.fixture'),{recursive:true});
 writeFileSync(join(localPackage.project,'Packages/local.fixture/Material.asset'),'%YAML 1.1\nguid: '+'1'.repeat(32)+'\n');
 assert.throws(()=>localPackage.run(),/仍被工程引用/);assert.ok(existsSync(localPackage.asset));
});

test('excluded recolor retirement refuses a linked dependency directory', {skip:!python},t=>{
 const f=excludedRetryFixture(t), output=join(f.project,'Assets/_Harness/Recolor/Dependencies'), moved=output+'-real';
 try { renameSync(output,moved);symlinkSync(moved,output,'junction'); } catch (error) { t.skip(`junction unavailable: ${String(error)}`); return; }
 assert.throws(()=>f.run(),/链接或 junction/);assert.ok(existsSync(join(moved,'1'.repeat(32),'paint.mat')));
});

test('retirement journals a mid-delete failure and resumes on the next real prepare', {skip:!python},t=>{
 const f=excludedRetryFixture(t), mutant=join(f.root,'mutant-retire-delete.py');
 writeFileSync(mutant,readFileSync(join(tools,'material_dependencies.py'),'utf8').replace(
  "candidate['meta'].unlink()", "raise OSError('simulated delete failure')"));
 assert.throws(()=>f.run(mutant),/中途失败/);
 assert.equal(existsSync(f.asset),false);assert.equal(existsSync(f.asset+'.meta'),true);
 let receipt=JSON.parse(readFileSync(f.receiptPath,'utf8')),pending=receipt.pending_retirements.find((row:any)=>row.path===f.receipt.packages[0].assets[0].path);
 assert.equal(pending.status,'pending');assert.equal(pending.file_deleted,true);assert.equal(pending.meta_deleted,false);
 assert.equal(receipt.packages[0].assets.length,1,'the effective receipt keeps the half-deleted file for retry');
 // Pending-only recovery must still derive source eligibility and run the same preflight.
 receipt.packages[0].assets=[];writeFileSync(f.receiptPath,JSON.stringify(receipt));
 f.run();assert.equal(existsSync(f.asset),false);assert.equal(existsSync(f.asset+'.meta'),false);
 receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));assert.equal(receipt.retired[0].status,'deleted');assert.equal(receipt.packages[0].assets.length,0);
});

test('reference and hash checks are mutation-protected at the real prepare entry', {skip:!python},t=>{
 const hashCase=excludedRetryFixture(t);writeFileSync(hashCase.asset,'changed');
 const hashMutant=join(hashCase.root,'mutant-no-hash.py');
 writeFileSync(hashMutant,readFileSync(join(tools,'material_dependencies.py'),'utf8').replace(/if actual != expected:/g, 'if False:').replace("if digest(candidate['target']) != row['sha256']:", 'if False:').replace("if digest(candidate['meta']) != row['meta_sha256']:", 'if False:'));
 hashCase.run(hashMutant);assert.equal(existsSync(hashCase.asset),false,'mutation: removing hash verification must be observable');
 const refCase=excludedRetryFixture(t);mkdirSync(join(refCase.project,'Assets/_Harness/Optimize'),{recursive:true});
 writeFileSync(join(refCase.project,'Assets/_Harness/Optimize/Avatar.prefab'),'%YAML 1.1\nguid: '+'1'.repeat(32)+'\n');
 const refMutant=join(refCase.root,'mutant-no-refs.py');
 writeFileSync(refMutant,readFileSync(join(tools,'material_dependencies.py'),'utf8').replace('if references:\n            raise ValueError(', 'if False:\n            raise ValueError('));
 refCase.run(refMutant);assert.equal(existsSync(refCase.asset),false,'mutation: removing reference scanning must be observable');
 const harnessCase=excludedRetryFixture(t);mkdirSync(join(harnessCase.project,'Assets/_Harness/Optimize'),{recursive:true});
 writeFileSync(join(harnessCase.project,'Assets/_Harness/Optimize/Avatar.prefab'),'%YAML 1.1\nguid: '+'1'.repeat(32)+'\n');
 const harnessMutant=join(harnessCase.root,'mutant-skip-harness.py');
 writeFileSync(harnessMutant,readFileSync(join(tools,'material_dependencies.py'),'utf8').replace("roots = [project / 'Assets', project / 'Packages']", "roots = [project / 'Assets/Visible', project / 'Packages']"));
 harnessCase.run(harnessMutant);assert.equal(existsSync(harnessCase.asset),false,'mutation: skipping _Harness must be observable');
 const receiptCase=excludedRetryFixture(t);receiptCase.run();
 receiptCase.request([receiptCase.row]);receiptCase.invoke('prepare');
 const receipt=JSON.parse(readFileSync(receiptCase.receiptPath,'utf8'));
 assert.match(receipt.retired[0].guid_reference,/^guid: /);
 rmSync(join(receiptCase.project,'Assets/_Harness/Recolor/dependencies.json'));
 const receiptMutant=join(receiptCase.root,'mutant-receipt-reference.py');
 writeFileSync(receiptMutant,readFileSync(join(tools,'material_dependencies.py'),'utf8').replace("excluded_paths.add(str(receipt.absolute()))", 'pass'));
 assert.throws(()=>receiptCase.run(receiptMutant),/仍被工程引用/,'mutation: scanning the receipt itself must fail');
 assert.doesNotThrow(()=>receiptCase.run(),'the production scanner excludes its own receipt');
});

test('retirement scans active meta files and rejects exact spelling drift', {skip:!python},t=>{
 const referenced=excludedRetryFixture(t);writeFileSync(join(referenced.project,'Assets/Consumer.cs.meta'),'fileFormatVersion: 2\nMonoImporter:\n  defaultReferences:\n  - guid: '+'1'.repeat(32)+'\n');
 assert.throws(()=>referenced.run(),/仍被工程引用/);assert.ok(existsSync(referenced.asset));
 const metaMutant=join(referenced.root,'mutant-skip-meta.py');
 writeFileSync(metaMutant,readFileSync(join(tools,'material_dependencies.py'),'utf8').replace("if linked(path) or str(path.absolute()) in excluded_paths:", "if linked(path) or path.suffix.lower() == '.meta' or str(path.absolute()) in excluded_paths:"));
 referenced.run(metaMutant);assert.equal(existsSync(referenced.asset),false,'mutation: skipping active meta files must be observable');
 const drift=excludedRetryFixture(t);rmSync(drift.asset+'.meta');writeFileSync(drift.asset+'.META','guid: '+'1'.repeat(32)+'\n');
 assert.throws(()=>drift.run(),/大小写或 Unicode 归一化不一致/);assert.ok(existsSync(drift.asset+'.META'));
 const unreadable=excludedRetryFixture(t);writeFileSync(join(unreadable.project,'Assets/Broken.asset.meta'),'fileFormatVersion: 2\n');
 const unreadableMutant=join(unreadable.root,'mutant-meta-read-failure.py');
 writeFileSync(unreadableMutant,readFileSync(join(tools,'material_dependencies.py'),'utf8').replace('data = path.read_bytes()', "data = path.read_bytes()\n                    if path.suffix == '.meta':\n                        raise OSError('simulated meta read failure')"));
 assert.throws(()=>unreadable.run(unreadableMutant),/读取失败/);assert.ok(existsSync(unreadable.asset));
});

test('retirement rejects normalized path collisions and the normalized-exclusion mutation', {skip:!python},t=>{
 const f=fixture(t),row=f.make('Materials.zip','first','Assets/Vendor/café.mat');f.request([row]);f.invoke('prepare');
 const receipt=JSON.parse(readFileSync(join(f.project,'Assets/_Harness/Recolor/dependency-receipt.json'),'utf8'));
 const asset=join(f.project,receipt.packages[0].assets[0].path);
 const nfd=asset.replace('café.mat','cafe\u0301.mat');writeFileSync(nfd,'guid: '+'1'.repeat(32)+'\n');
 const plan={unused:[{item:f.source,reason:'client_declined'}],obligations:[{input:f.anchor,role:'body',action:'use',target:'outfit',due_stage:'outfit'},{input:f.source,role:'other',action:'exclude',reason:'client_declined'}]};
 rmSync(join(f.project,'Assets/_Harness/Recolor/dependencies.json'));
 const env={...process.env,AVH_PLAN:JSON.stringify(plan),AVH_ASSET_SEARCH_ROOTS_JSON:JSON.stringify([f.source]),AVH_RUN_DIR:join(f.root,'retire-run'),PYTHONDONTWRITEBYTECODE:'1'};
 const run=(script=join(tools,'material_dependencies.py'))=>execFileSync('python3',[script,'prepare',...sources.map(n=>join(tools,'unity/Editor',n)),'--project',f.project],{env:{...env,PYTHONPATH:tools},encoding:'utf8',stdio:'pipe'});
 assert.throws(()=>run(),/归一化后对应多个实际目录项/);assert.ok(existsSync(asset));
 const mutant=join(f.root,'mutant-normalized-exclusion.py');let code=readFileSync(join(tools,'material_dependencies.py'),'utf8');
 code=code.replace("excluded_paths = {str(Path(path).absolute()) for path in excluded}","excluded_paths = {_path_identity(path) for path in excluded}")
  .replace("excluded_paths.add(str(receipt.absolute()))","excluded_paths.add(_path_identity(receipt))")
  .replace("str(path.absolute()) in excluded_paths","_path_identity(path) in excluded_paths")
  .replace("if any(len(set(values)) > 1 for values in normalized.values()):","if False:")
  .replace("if len({entry.name for entry in ambiguous}) > 1:","if False:");writeFileSync(mutant,code);
 run(mutant);assert.equal(existsSync(asset),false,'mutation: normalized keys must not exclude a distinct consumer');
});

test('retirement reconciles contradictory pending flags and completes pending-only intents', {skip:!python},t=>{
 const f=excludedRetryFixture(t),mutant=join(f.root,'mutant-interrupt-before-delete.py');
 writeFileSync(mutant,readFileSync(join(tools,'material_dependencies.py'),'utf8').replace("candidate['target'].unlink()","raise OSError('simulated process interruption')"));
 assert.throws(()=>f.run(mutant),/中途失败/);
 let receipt=JSON.parse(readFileSync(f.receiptPath,'utf8')),row=receipt.pending_retirements[0];row.file_deleted=true;writeFileSync(f.receiptPath,JSON.stringify(receipt));
 f.run();assert.equal(existsSync(f.asset),false);assert.equal(existsSync(f.asset+'.meta'),false);
 receipt=JSON.parse(readFileSync(f.receiptPath,'utf8'));assert.equal(receipt.pending_retirements?.length||0,0);assert.equal(receipt.retired.length,1);
});

test('reselecting a source safely revokes complete and partial retirement intents', {skip:!python},t=>{
 const complete=excludedRetryFixture(t),completeMutant=join(complete.root,'mutant-unlink-file.py');
 writeFileSync(completeMutant,readFileSync(join(tools,'material_dependencies.py'),'utf8').replace("candidate['target'].unlink()", "raise OSError('simulated file lock')"));
 assert.throws(()=>complete.run(completeMutant),/中途失败/);
 complete.request([complete.row]);complete.invoke('prepare');
 assert.ok(existsSync(complete.asset));assert.ok(existsSync(complete.asset+'.meta'));
 let receipt=JSON.parse(readFileSync(complete.receiptPath,'utf8'));
 assert.equal(receipt.pending_retirements?.length||0,0);assert.equal(receipt.retired.at(-1).status,'revoked');

 const partial=excludedRetryFixture(t),partialMutant=join(partial.root,'mutant-unlink-meta.py');
 writeFileSync(partialMutant,readFileSync(join(tools,'material_dependencies.py'),'utf8').replace("candidate['meta'].unlink()", "raise OSError('simulated meta lock')"));
 assert.throws(()=>partial.run(partialMutant),/中途失败/);assert.equal(existsSync(partial.asset),false);assert.equal(existsSync(partial.asset+'.meta'),true);
 partial.request([partial.row]);partial.invoke('prepare');
 assert.ok(existsSync(partial.asset));assert.ok(existsSync(partial.asset+'.meta'));
 receipt=JSON.parse(readFileSync(partial.receiptPath,'utf8'));
 assert.equal(receipt.pending_retirements?.length||0,0);assert.equal(receipt.retired.at(-1).status,'revoked');
});

test('receipt writes use an exclusive temporary path and preserve a pre-existing tmp file', {skip:!python},t=>{
 const f=excludedRetryFixture(t),temporary=f.receiptPath+'.tmp';writeFileSync(temporary,'user backup');
 f.run();
 assert.equal(readFileSync(temporary,'utf8'),'user backup');assert.ok(existsSync(f.receiptPath));
});

test('complete preflight rejects conflicting source GUIDs without partial output', {skip:!python},t=>{
 const f=fixture(t),a=f.make('Materials_A.zip','first'),b=f.make('Materials_B.zip','second');f.request([a,b]);
 assert.throws(()=>f.invoke('prepare'),/内容冲突/);assert.equal(existsSync(join(f.project,'Assets/_Harness/Recolor/Dependencies')),false);
});

test('real Unity recolor maps enabled iris layers without recoloring skin and rejects forged recovery',
 {skip:!process.env.AVH_LOCAL_UNITY_EDITOR||!process.env.AVH_LOCAL_UNITY_BASELINE,timeout:360000},t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-recolor-unity-'));t.after(()=>removeTemp(root));
 mkdirSync(join(root,'Assets/Editor'),{recursive:true});mkdirSync(join(root,'Packages'),{recursive:true});mkdirSync(join(root,'ProjectSettings'),{recursive:true});
 execFileSync('python3',['-c','import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',join(process.env.AVH_LOCAL_UNITY_BASELINE!,'Packages'),join(root,'Packages')]);
 writeFileSync(join(root,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
 execFileSync('python3',['-c','import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})',tools,root],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:'pipe'});
 copyFileSync(fileURLToPath(new URL('./fixtures/unity/RecolorIntegration.cs',import.meta.url)),join(root,'Assets/Editor/RecolorIntegration.cs'));
 writeFileSync(join(root,'Assets/Iris.shader'),`Shader "Fixture/Iris" { Properties { _Color("Color",Color)=(1,1,1,1) _Color2nd("Iris",Color)=(0,0,1,1) _MainTexHSVG("HSVG",Vector)=(0,1,1,1) _UseMain2ndTex("Enabled",Float)=1 _Main2ndTex("Iris texture",2D)="white"{} _MainTex("Main",2D)="white"{} } SubShader { Pass { Color [_Color] } } }`);
 let error:unknown;try{execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!,['-batchmode','-nographics','-projectPath',root,'-executeMethod','AVH.Harness.RecolorIntegration.Run','-logFile',join(root,'unity.log')],{env:{...process.env,AVH_PROJECT_DIR:root},timeout:330000,stdio:'pipe'});}catch(e){error=e;}
 if(process.env.AVH_LOCAL_UNITY_EVIDENCE){const out=join(process.env.AVH_LOCAL_UNITY_EVIDENCE,'attempt-'+Date.now());mkdirSync(out,{recursive:true});for(const n of ['result.json','unity.log'])if(existsSync(join(root,n)))copyFileSync(join(root,n),join(out,n));writeFileSync(join(out,'source.json'),JSON.stringify({recolor:sha(join(root,'Assets/_HarnessTools/Editor/RecolorStage.cs'))}));}
 assert.ok(existsSync(join(root,'result.json')),String(error)+' '+readFileSync(join(root,'unity.log'),'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-6).join('\n'));
 const result=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));assert.equal(result.ok,true,result.error);assert.equal(result.assertions,23);
});

// ---------------------------------------------------------------------------------------------------
// One registered asset path, two Unicode normalization forms
//
// A product folder a macOS-made zip extracted is spelled in NFD (`ハ`+U+3099) while the same folder can be
// registered in NFC (`バ`), and NTFS and ext4 keep the two spellings as two different names. A path is
// identified by its normalized form and opened under the bytes the filesystem reports; nothing is renamed.
// The three shapes are the two directions of that mismatch plus one where only the file name carries the
// voiced sound mark, so a fix that only normalized directory names would not pass.
// ---------------------------------------------------------------------------------------------------
const NFC_KANA='\u30d0', NFD_KANA='\u30cf\u3099';
const nfc=(text:string)=>text.normalize('NFC');
/** A filesystem that folds the two spellings into one name cannot express the defect at all. */
const distinctForms=(()=>{const probe=mkdtempSync(join(tmpdir(),'avh-norm-probe-'));try{mkdirSync(join(probe,NFD_KANA));return !existsSync(join(probe,NFC_KANA));}finally{removeTemp(probe);}})();
function materialPack(path:string,asset='first',assetPath='Assets/Vendor/paint.mat'){
 execFileSync('python3',['-c',`import sys,tarfile,zipfile,io
g='1'*32
b=io.BytesIO()
with tarfile.open(fileobj=b,mode='w:gz') as t:
 for n,d in [('pathname',sys.argv[3]),('asset',sys.argv[2]),('asset.meta','fileFormatVersion: 2\\nguid: '+g+'\\n')]:
  data=d.encode();i=tarfile.TarInfo(g+'/'+n);i.size=len(data);t.addfile(i,io.BytesIO(data))
with zipfile.ZipFile(sys.argv[1],'w') as z:z.writestr('Materials.unitypackage',b.getvalue())`,path,asset,assetPath]);
}
type Shape='record NFC, disk NFD'|'record NFD, disk NFC'|'dakuten in the file name only';
function unicodeFixture(t:test.TestContext,shape:Shape){
 const root=mkdtempSync(join(tmpdir(),'avh-material-unicode-'));t.after(()=>removeTemp(root));
 const project=join(root,'project');
 // The authorized asset root is itself registered in the other form, the way a typed path would be.
 const library=join(root,`AssetLibrary_${shape==='record NFD, disk NFC'?NFC_KANA:NFD_KANA}`);
 const recordedLibrary=library.normalize(shape==='record NFD, disk NFC'?'NFC':'NFD');
 const [diskDir,recordDir,diskName,recordName]=
  shape==='record NFC, disk NFD'?[`Sleeve_${NFD_KANA}-11`,`Sleeve_${NFC_KANA}-11`,'Body_Adapter.zip','Body_Adapter.zip']:
  shape==='record NFD, disk NFC'?[`Sleeve_${NFC_KANA}-12`,`Sleeve_${NFD_KANA}-12`,'Body_Adapter.zip','Body_Adapter.zip']:
  ['Product-13','Product-13',`${NFD_KANA}_Material.zip`,`${NFC_KANA}_Material.zip`];
 const product=join(library,diskDir);mkdirSync(product,{recursive:true});
 for(const dir of [join(project,'_harness/intake'),join(project,'Assets/_Harness/Recolor'),join(project,'Assets/_HarnessTools/Editor')])mkdirSync(dir,{recursive:true});
 for(const name of sources)copyFileSync(join(tools,'unity/Editor',name),join(project,'Assets/_HarnessTools/Editor',name));
 const anchor=join(product,diskName);writeFileSync(anchor,'frozen input');
 const pack=join(product,'Common_Extra.zip');materialPack(pack);
 writeFileSync(join(project,'_harness/intake/inventory.json'),JSON.stringify({items:[
  {item:join(recordedLibrary,recordDir,recordName),role:'body',files:[{name:recordName,selected:true,sha256:sha(anchor)}]},
  {item:join(recordedLibrary,recordDir),role:'other',files:[{name:'Common_Extra.zip',selected:true,sha256:sha(pack)}]},
 ]}));
 const invoke=(action:string)=>execFileSync('python3',[join(tools,'material_dependencies.py'),action,
  ...(action==='prepare'?sources.map(n=>join(tools,'unity/Editor',n)):[]),'--project',project],
  {env:{...process.env,AVH_ASSET_SEARCH_ROOTS_JSON:JSON.stringify([recordedLibrary]),PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',stdio:'pipe'});
 return {project,anchor,pack,diskDir,invoke};
}
for(const shape of ['record NFC, disk NFD','record NFD, disk NFC','dakuten in the file name only'] as Shape[])
 test(`registered asset paths match across Unicode normalizations: ${shape}`,{skip:!python||!distinctForms},t=>{
  const f=unicodeFixture(t,shape);
  const discovered=JSON.parse(f.invoke('inspect'));
  // Exactly the sibling material pack. In the third shape the anchor's own stem matches the same
  // "material" rule, so a comparison that missed the identity would also list the anchor as its own dependency.
  assert.deepEqual(discovered.candidates,[{anchor:realpathSync(f.anchor),archive:realpathSync(f.pack),sha256:sha(f.pack)}]);
  const row=discovered.candidates[0];
  writeFileSync(join(f.project,'Assets/_Harness/Recolor/dependencies.json'),
   JSON.stringify({schema:'material-dependencies/0.1',packages:[row],iris_layers:[]}));
  f.invoke('prepare');
  const receipt=JSON.parse(readFileSync(join(f.project,'Assets/_Harness/Recolor/dependency-receipt.json'),'utf8'));
  assert.equal(receipt.packages[0].assets.length,1);
  assert.equal(readFileSync(join(f.project,receipt.packages[0].assets[0].path),'utf8'),'first');
  // Nothing was renamed or rewritten to make the match possible.
  assert.equal(readFileSync(f.anchor,'utf8'),'frozen input');
  assert.equal(nfc(readdirSync(join(f.project,'Assets/_Harness/Recolor/Dependencies'))[0]).length,32);
 });

// ---------------------------------------------------------------------------------------------------
// The recolor stage does not inherit what an earlier workflow left in its own layer
//
// `dependencies.json` and `recipe.json` are read as this stage's input by the Unity step and neither is
// rebuilt by the Runtime, so a copy a previous workflow left behind would be consumed as if this stage had
// written it: an `iris_layers` proposal the approved plan does not authorize (RecolorStage.cs throws on
// it), and a recipe from an older recipe schema. They are superseded into the Run's evidence directory.
// ---------------------------------------------------------------------------------------------------
const materialPlan={recolor:{targets:[{requirement_id:'pink',outfit:'winter',material:'Assets/Vendor/Pink.mat'}],candidates:1}};
const eyePlan={recolor:{targets:[{requirement_id:'iris',part:'eye',hue_shift:10,saturation:1.0,value:1.0}],candidates:1}};
// recolor.py writes its recipe with newline='\n'; a capture through a Windows text-mode stdout would
// arrive with CRLF and stop being byte-identical to what the tool writes.
const recipeFor=(plan:unknown)=>execFileSync('python3',['-c','import sys,json;sys.path.insert(0,sys.argv[1]);import recolor;sys.stdout.write(recolor.serialize(recolor.build_recipe(json.loads(sys.argv[2]),"")))',tools,JSON.stringify(plan)],{encoding:'utf8'}).replace(/\r\n/g,'\n');
function stageFixture(t:test.TestContext,plan:unknown){
 const f=fixture(t),run=join(f.root,'run');mkdirSync(run,{recursive:true});
 const layer=join(f.project,'Assets/_Harness/Recolor');
 const invoke=()=>execFileSync('python3',[join(tools,'material_dependencies.py'),'prepare',...sources.map(n=>join(tools,'unity/Editor',n)),'--project',f.project],
  {env:{...process.env,AVH_ASSET_SEARCH_ROOTS_JSON:JSON.stringify([f.source]),AVH_RUN_DIR:run,AVH_TOOL_ROOT:join(tools,'..'),
   AVH_PLAN:JSON.stringify(plan),PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8',stdio:'pipe'});
 const kept=()=>existsSync(join(run,'recolor-superseded'))?readdirSync(join(run,'recolor-superseded')).sort():[];
 return {...f,layer,run,invoke,kept};
}
test('recolor preparation drops an iris proposal the approved plan does not authorize, keeping the original',{skip:!python},t=>{
 const f=stageFixture(t,materialPlan),row=f.make('Materials.zip');
 const proposal={material_guid:'c'.repeat(32),texture_guid:'d'.repeat(32),source_sha256:'e'.repeat(64),expected_enabled:0.0,enable:true};
 writeFileSync(join(f.layer,'dependencies.json'),JSON.stringify({schema:'material-dependencies/0.1',packages:[row],iris_layers:[proposal]}));
 f.invoke();
 const after=JSON.parse(readFileSync(join(f.layer,'dependencies.json'),'utf8'));
 assert.deepEqual(after.iris_layers,[],'the plan has no eye target, so no iris layer may be enabled');
 assert.deepEqual(after.packages,[row],'the dependency request itself is still this stage\u2019s to make');
 assert.equal(readFileSync(join(f.project,JSON.parse(readFileSync(join(f.layer,'dependency-receipt.json'),'utf8')).packages[0].assets[0].path),'utf8'),'first');
 assert.deepEqual(f.kept(),['dependencies.json']);
 assert.deepEqual(JSON.parse(readFileSync(join(f.run,'recolor-superseded','dependencies.json'),'utf8')).iris_layers,[proposal],'the dropped proposal is preserved, not deleted');
});
test('recolor preparation leaves an iris proposal the approved plan does authorize alone',{skip:!python},t=>{
 const f=stageFixture(t,eyePlan),row=f.make('Materials.zip');
 const proposal={material_guid:'c'.repeat(32),texture_guid:'d'.repeat(32),source_sha256:'e'.repeat(64),expected_enabled:0.0,enable:true};
 const request=JSON.stringify({schema:'material-dependencies/0.1',packages:[row],iris_layers:[proposal]});
 writeFileSync(join(f.layer,'dependencies.json'),request);
 f.invoke();
 assert.equal(readFileSync(join(f.layer,'dependencies.json'),'utf8'),request);
 assert.deepEqual(f.kept(),[]);
});
test('recolor preparation supersedes a recipe that the frozen tool does not produce from the current plan',{skip:!python},t=>{
 const f=stageFixture(t,materialPlan),row=f.make('Materials.zip');f.request([row]);
 const stale=JSON.stringify({schema:'recolor-recipe/0.1',targets:[{part:'hair',hue_shift:30}]},null,2);
 writeFileSync(join(f.layer,'recipe.json'),stale);
 writeFileSync(join(f.layer,'recipe.json.meta'),'fileFormatVersion: 2\n');
 f.invoke();
 assert.equal(existsSync(join(f.layer,'recipe.json')),false,'a recipe from an older schema must not be consumed as this stage\u2019s');
 assert.equal(existsSync(join(f.layer,'recipe.json.meta')),false,'its Unity sidecar moves with it');
 assert.deepEqual(f.kept(),['recipe.json','recipe.json.meta']);
 assert.equal(readFileSync(join(f.run,'recolor-superseded','recipe.json'),'utf8'),stale);
 assert.equal(readFileSync(join(f.project,JSON.parse(readFileSync(join(f.layer,'dependency-receipt.json'),'utf8')).packages[0].assets[0].path),'utf8'),'first','the rest of the stage preparation still runs');
});
test('recolor preparation keeps a recipe the frozen tool does produce from the current plan',{skip:!python},t=>{
 const f=stageFixture(t,materialPlan),fresh=recipeFor(materialPlan);
 writeFileSync(join(f.layer,'recipe.json'),fresh);
 f.invoke();
 assert.equal(readFileSync(join(f.layer,'recipe.json'),'utf8'),fresh);
 assert.deepEqual(f.kept(),[]);
});
