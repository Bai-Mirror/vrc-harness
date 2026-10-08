import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {ObservationVerifier,parseObservation} from '../src/workflow/observe.ts';
import type {ProcessDefinition} from '../src/process/types.ts';

const tools=process.env.AVH_PACKAGE_OBSERVER_TEST_TOOLS??fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));
const python=spawnSync('python3',['--version']).status===0;
test('actual observer verifies frozen bytes and separately admits proven minimal Unity metadata derivations',{skip:!python},async t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-package-meta-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const consumed=JSON.parse(execFileSync('python3',['-c',String.raw`
import sys,json,shutil,subprocess
from pathlib import Path
tools=Path(sys.argv[1]);root=Path(sys.argv[2]);sys.path.insert(0,str(tools));import environment as e
meta=lambda guid: 'fileFormatVersion: 2\nguid: '+guid+'\nMonoImporter:\n  externalObjects: {}\n  serializedVersion: 2\n  defaultReferences: []\n  executionOrder: 0\n  icon: {instanceID: 0}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n'
orphans=['Editor/Old.cs.meta','Runtime/Old.cs.meta']
reports=[];observations=[]
def seed(name,source_fault=None):
    directory=root/name;source=directory/'source';project=directory/'project';source.mkdir(parents=True);project.mkdir()
    settings=source/'ProjectSettings';settings.mkdir();(settings/'ProjectVersion.txt').write_text('m_EditorVersion: 2022.3.22f1\n')
    packages=source/'Packages';folder=packages/'vendor.avatar'
    e.write(packages/'manifest.json',{'dependencies':{}})
    e.write(packages/'vpm-manifest.json',{'dependencies':{'vendor.avatar':{'version':'1.0.0'}},'locked':{'vendor.avatar':{'version':'1.0.0'}}})
    e.write(packages/'packages-lock.json',{'dependencies':{'vendor.avatar':{'source':'embedded','version':'file:vendor.avatar','dependencies':{},'depth':0}}})
    e.write(folder/'package.json',{'name':'vendor.avatar','version':'1.0.0'})
    (folder/'content.cs').write_text('// actual paired source bytes')
    (folder/'content.cs.meta').write_text(meta('c'*32))
    for rel in ['Runtime/License.txt','Runtime/nested/package.json','ShaderLibrary/Time.cginc']:
        target=folder/rel;target.parent.mkdir(parents=True,exist_ok=True);target.write_text('frozen paired source '+rel)
    (folder/'Existing').mkdir();(folder/'Existing.meta').write_text('fileFormatVersion: 2\nguid: '+'d'*32+'\nfolderAsset: yes\nDefaultImporter:\n  externalObjects: {}\n')
    for rel,guid in zip(orphans,['a'*32,'b'*32]):
        path=folder/rel;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(meta(guid))
    if source_fault=='zero-guid':(folder/orphans[0]).write_text(meta('0'*32))
    if source_fault=='duplicate-guid':(folder/orphans[0]).write_text(meta('a'*32)+'guid: '+'b'*32+'\n')
    if source_fault=='bad-format':(folder/orphans[0]).write_text(meta('a'*32).replace('fileFormatVersion: 2','fileFormatVersion: 1'))
    if source_fault=='shared-guid':(folder/orphans[0]).write_text(meta('c'*32))
    recipe={'schema':'environment-recipe/0.1','id':name,'unity':'2022.3.22f1','platform':'pc','maxDownloadBytes':1000000,'maxExpandedBytes':1000000,
            'template':{'url':'https://invalid.example/template','sha256':'a'*64},'packages':[],'builtinPackages':{}}
    recipePath=directory/'recipe.json';e.write(recipePath,recipe)
    subprocess.run([sys.executable,str(tools/'environment.py'),'prepare','--project',str(project),'--recipe',str(recipePath),'--source',str(source)],check=True,capture_output=True)
    baseline=project/'_harness/environment/baseline';shutil.copytree(baseline/'Packages',project/'Packages');shutil.copytree(baseline/'ProjectSettings',project/'ProjectSettings')
    return directory,project,recipePath,baseline
def observe(directory,project,recipe):
    before=e.tree(project);out=directory/'observation.json'
    subprocess.run([sys.executable,str(tools/'observe_project.py'),'--project',str(project),'--environment-tool',str(tools/'environment.py'),'--environment-recipe',str(recipe),'--out',str(out)],check=True,capture_output=True)
    assert e.tree(project)==before,'observer altered project/baseline'
    observations.append(str(out))
    return e.read(out)
d,p,r,b=seed('pristine');reading=observe(d,p,r)
assert reading['metrics']['package_resolution_consistent'] is True
assert reading['proof']['package_content_derived_removals']==[]
reports.append('pristine frozen metadata remains byte-exact')
d,p,r,b=seed('derived-removal');folder=p/'Packages/vendor.avatar'
for rel in orphans:(folder/rel).unlink()
before_source=e.tree(b);reading=observe(d,p,r)
assert reading['metrics']['package_resolution_consistent'] is True
derived=reading['proof']['package_content_derived_removals'];assert len(derived)==2
assert {x['path'] for x in derived}==set(orphans)
for item in derived:assert item['sourceSha256']==e.digest(b/'Packages/vendor.avatar'/item['path'])
assert e.tree(b)==before_source
reports.append('only source-proven valid orphan metadata removal has original SHA receipt')
faults=['paired-meta-modified','paired-meta-missing','paired-directory-meta-missing','real-source-missing','unknown-file','new-orphan','existing-orphan-modified',
        'source-orphan-zero-guid','source-orphan-duplicate-guid','source-orphan-bad-format','source-orphan-shared-guid','baseline-drift','recipe-drift','new-paired-file-with-missing-meta']
for mode in faults:
    source_fault={'source-orphan-zero-guid':'zero-guid','source-orphan-duplicate-guid':'duplicate-guid','source-orphan-bad-format':'bad-format','source-orphan-shared-guid':'shared-guid'}.get(mode)
    d,p,r,b=seed(mode,source_fault);folder=p/'Packages/vendor.avatar'
    if mode=='paired-meta-modified':(folder/'content.cs.meta').write_text(meta('e'*32))
    if mode=='paired-meta-missing':(folder/'content.cs.meta').unlink()
    if mode=='paired-directory-meta-missing':(folder/'Existing.meta').unlink()
    if mode=='real-source-missing':(folder/'content.cs').unlink()
    if mode=='unknown-file':(folder/'unknown.bin').write_bytes(b'new')
    if mode=='new-orphan':(folder/'new.cs.meta').write_text(meta('e'*32))
    if mode=='existing-orphan-modified':(folder/orphans[0]).write_text(meta('e'*32))
    if mode.startswith('source-orphan-'):(folder/orphans[0]).unlink()
    if mode=='baseline-drift':(b/'Packages/vendor.avatar'/orphans[0]).write_text(meta('e'*32))
    if mode=='recipe-drift':x=e.read(r);x['id']='changed';e.write(r,x)
    if mode=='new-paired-file-with-missing-meta':(folder/orphans[0]).unlink();(folder/orphans[0][:-5]).write_text('// unknown replacement')
    reading=observe(d,p,r);assert reading['metrics']['package_resolution_consistent'] is False,mode
    assert reading['notes'],mode
    if mode not in ['baseline-drift','recipe-drift']:
        changes=reading['proof']['package_content_differences'];assert changes and all('sourceSha256' in x and 'installedSha256' in x for x in changes),mode
    reports.append(mode)
profiles={'Runtime/License.txt':('TextScriptImporter',False),'Runtime/nested/package.json':('TextScriptImporter',False),
          'ShaderLibrary/Time.cginc':('ShaderIncludeImporter',False),'ShaderLibrary':('DefaultImporter',True),'package.json':('PackageManifestImporter',False)}
def generated(profile,guid):
    importer,folder=profile
    return 'fileFormatVersion: 2\nguid: '+guid+'\n'+('folderAsset: yes\n' if folder else '')+importer+':\n  externalObjects: {}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n'
def add_generated(folder):
    for index,(rel,profile) in enumerate(profiles.items()):
        (folder/(rel+'.meta')).write_text(generated(profile,format(index+1,'032x')))
d,p,r,b=seed('generated-minimal');folder=p/'Packages/vendor.avatar';add_generated(folder)
for rel in orphans:(folder/rel).unlink()
reading=observe(d,p,r);assert reading['metrics']['package_resolution_consistent'] is True
receipts=reading['proof']['package_content_generated_metadata'];assert len(receipts)==5
assert {x['pairedPath'] for x in receipts}==set(profiles)
assert all(x['installedSha256']==e.digest(folder/x['path']) and x['sourcePairedSha256'] for x in receipts)
assert len(reading['proof']['package_content_derived_removals'])==2
reports.append('source-proven minimal actual Unity file/directory profiles and orphan removal')
for mode in ['generated-userdata','generated-external-objects','generated-bundle','generated-unknown-field','generated-wrong-importer',
             'generated-zero-guid','generated-duplicate-guid','generated-shared-source-guid','generated-shared-installed-guid',
             'generated-paired-source-modified','generated-paired-source-deleted','generated-unknown-pair','generated-directory-kind-changed','baseline-unrecorded-empty-directory']:
    d,p,r,b=seed(mode);folder=p/'Packages/vendor.avatar';add_generated(folder);target=folder/'Runtime/License.txt.meta';text=target.read_text()
    if mode=='generated-userdata':target.write_text(text.replace('  userData: ','  userData: unsafe'))
    if mode=='generated-external-objects':target.write_text(text.replace('externalObjects: {}','externalObjects: {unsafe: 1}'))
    if mode=='generated-bundle':target.write_text(text.replace('  assetBundleName: ','  assetBundleName: unsafe'))
    if mode=='generated-unknown-field':target.write_text(text+'  extra: true\n')
    if mode=='generated-wrong-importer':target.write_text(text.replace('TextScriptImporter','DefaultImporter'))
    if mode=='generated-zero-guid':target.write_text(text.replace(format(1,'032x'),'0'*32))
    if mode=='generated-duplicate-guid':target.write_text(text+'guid: '+'e'*32+'\n')
    if mode=='generated-shared-source-guid':target.write_text(text.replace(format(1,'032x'),'a'*32));(folder/orphans[0]).unlink()
    if mode=='generated-shared-installed-guid':target.write_text(text.replace(format(1,'032x'),format(2,'032x')))
    if mode=='generated-paired-source-modified':(folder/'Runtime/License.txt').write_text('changed')
    if mode=='generated-paired-source-deleted':(folder/'Runtime/License.txt').unlink()
    if mode=='generated-unknown-pair':(folder/'unknown.txt').write_text('new');(folder/'unknown.txt.meta').write_text(generated(('TextScriptImporter',False),'e'*32))
    if mode=='generated-directory-kind-changed':shutil.rmtree(folder/'ShaderLibrary');(folder/'ShaderLibrary').write_text('wrong kind')
    if mode=='baseline-unrecorded-empty-directory':
        before=e.tree(b);(b/'Packages/vendor.avatar/Unrecorded').mkdir();assert e.tree(b)==before
        (folder/'Unrecorded').mkdir();(folder/'Unrecorded.meta').write_text(generated(('DefaultImporter',True),'e'*32))
    reading=observe(d,p,r);assert reading['metrics']['package_resolution_consistent'] is False,mode
    assert reading['proof']['package_content_differences'],mode
    reports.append(mode)
print(json.dumps({"reports":reports,"observations":observations}))
`,tools,root],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8'}));
 assert.equal(consumed.reports.length,31);
 const definition:ProcessDefinition={schema:'process/0.1',id:'actual-observer-consumer',version:'1',applies_to:{},artifacts:['fbx'],
   stages:[{id:'setup',needs:[],produces:['fbx'],requires:['package_resolution'],gates:[],invalidated_by:[]}],
   checks:[{id:'package_resolution',observe:'project.initialize',on:'fbx',scope:'edit',rule:'package_resolution_consistent == true',severity:'blocking',maturity:'accepted'}],gates:[],milestones:[]};
 for(const [index,path] of consumed.observations.entries()){
   const raw=readFileSync(path,'utf8'),reading=parseObservation(raw),before=createHash('sha256').update(raw).digest('hex');
   assert.ok(Object.values(reading.metrics).every(value=>value===null||typeof value==='number'||typeof value==='boolean'));
   assert.ok(reading.notes?.every(note=>typeof note==='string'));
   const verifier=new ObservationVerifier({definition,observers:{'project.initialize':{kind:'run-file',runFile:'observation.json'}},thresholds:{},
     project:root,toolRoot:tools,runRoot:root,plan:()=>({})});
   // Every actual Python output lives in its own Run-shaped directory; no stand-in metrics are injected.
   const runId=path.substring(root.length+1).split(/[\\/]/)[0]!;
   const verdicts=await verifier.verify({runId,taskId:'readback',workflowId:'consumer',projectId:'fixture',stageId:'setup',attempt:1,idempotencyKey:runId,expectedOutputs:[]},
     {exitStatus:0,outputs:{}},{fbx:before});
   assert.equal(verdicts[0]!.result,reading.metrics.package_resolution_consistent?'pass':'violation',consumed.reports[index]);
   assert.equal(verdicts[0]!.artifactHash,before);
   assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),before,'consumer must retain the complete original proof bytes');
 }
 assert.equal(consumed.observations.length,31);
 assert.throws(()=>parseObservation(JSON.stringify({schema:'observation/0.1',metrics:{package_content_derived_removals:[]}})),/应为数值、真假值或 null/);
 assert.throws(()=>parseObservation(JSON.stringify({schema:'observation/0.1',metrics:{package_content_generated_metadata:{unsafe:true}}})),/应为数值、真假值或 null/);
});
