import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse} from 'yaml';
import {loadProcess} from '../src/process/load.ts';
import {loadCapabilities} from '../src/workflow/capabilities.ts';
import {removeTemp} from './fixtures/platform.ts';
const tools=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));
const env={...process.env,PYTHONDONTWRITEBYTECODE:'1'};
const python=spawnSync('python3',['--version']).status===0;

test('setup freezes accepted-environment verification and checks resolved package identities rather than counts',()=>{
 const base=fileURLToPath(new URL('../builtin/knowledge/process/',import.meta.url));
 const definition=loadProcess(readFileSync(join(base,'pc-recolor-outfit.process.yaml'),'utf8'),parse(readFileSync(join(base,'thresholds.yaml'),'utf8')));
 const caps=loadCapabilities(readFileSync(join(base,'pc-recolor-outfit.capabilities.yaml'),'utf8'),definition);
 assert.equal(definition.checks.find(check=>check.id==='vpm_locked_match')!.rule,'package_resolution_consistent == true');
 for(const id of ['project.initialize','assets.import']){
  const argv=(caps.observers[id] as {command:string[]}).command;
  assert.ok(argv.includes('{toolRoot}/harness/environment.py'));assert.ok(argv.includes('{toolRoot}/harness/environment-recipe.json'));
 }
});

test('actual package observer distinguishes VPM, embedded UPM and builtin resolution with immutable baseline proof',{skip:!python},t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-package-resolution-'));t.after(()=>removeTemp(root));
 const result=execFileSync('python3',['-c',String.raw`
import sys,json,shutil,subprocess
from pathlib import Path
tools=Path(sys.argv[1]);root=Path(sys.argv[2]);sys.path.insert(0,str(tools));import environment as e
reports=[]
def seed(name,extra=False):
    directory=root/name;source=directory/'source';project=directory/'project';source.mkdir(parents=True);project.mkdir()
    settings=source/'ProjectSettings';settings.mkdir();(settings/'ProjectVersion.txt').write_text('m_EditorVersion: 2022.3.22f1\n')
    packages=source/'Packages'
    data={'vendor.avatar':{'name':'vendor.avatar','version':'1.0.0','dependencies':{'other.registry':'1.1.0'}},
          'other.registry':{'name':'other.registry','version':'1.2.0','dependencies':{'test.builtin':'1.0.0'}}}
    locked={'vendor.avatar':{'version':'1.0.0'}}
    if extra:
        data['new.vendor.helper']={'name':'new.vendor.helper','version':'2.0.0'};locked['new.vendor.helper']={'version':'2.0.0'}
    e.write(packages/'manifest.json',{'dependencies':{'other.registry':'1.2.0'}})
    e.write(packages/'vpm-manifest.json',{'dependencies':{k:{'version':v['version']} for k,v in locked.items()},'locked':locked})
    upm={k:{'source':'embedded','version':'file:'+k,'dependencies':v.get('dependencies',{}),'depth':0} for k,v in data.items()}
    upm['test.builtin']={'source':'builtin','version':'1.0.0','dependencies':{},'depth':1}
    e.write(packages/'packages-lock.json',{'dependencies':upm})
    for key,value in data.items():e.write(packages/key/'package.json',value);(packages/key/'content.cs').write_text('// pinned original bytes')
    recipe={'schema':'environment-recipe/0.1','id':name,'unity':'2022.3.22f1','platform':'pc','maxDownloadBytes':1000000,'maxExpandedBytes':1000000,
            'template':{'url':'https://invalid.example/template','sha256':'a'*64},'packages':[],'builtinPackages':{'test.builtin':'1.0.0','test.orphan':'1.0.0'}}
    recipePath=directory/'recipe.json';e.write(recipePath,recipe)
    # The real Runtime environment tool publishes and independently rereads this custom accepted version. No network.
    subprocess.run([sys.executable,str(tools/'environment.py'),'prepare','--project',str(project),'--recipe',str(recipePath),'--source',str(source)],check=True,capture_output=True)
    baseline=project/'_harness/environment/baseline';shutil.copytree(baseline/'Packages',project/'Packages');shutil.copytree(baseline/'ProjectSettings',project/'ProjectSettings')
    return directory,project,recipePath,baseline
def observe(directory,project,recipe):
    before=e.tree(project);out=directory/'observation.json'
    subprocess.run([sys.executable,str(tools/'observe_project.py'),'--project',str(project),'--environment-tool',str(tools/'environment.py'),'--environment-recipe',str(recipe),'--out',str(out)],check=True,capture_output=True)
    assert e.tree(project)==before,'observer modified project or accepted baseline'
    return e.read(out)
d,p,r,b=seed('first');positive=observe(d,p,r)
assert positive['metrics']['package_resolution_consistent'] is True
assert positive['metrics']['vpm_locked_entries']==1 and positive['metrics']['vpm_package_dirs']==1 and positive['metrics']['upm_embedded_packages']==1
reports.append('valid non-Unity-prefix UPM plus VPM and builtin closure')
d2,p2,r2,b2=seed('approved-next-environment',True);assert observe(d2,p2,r2)['metrics']['package_resolution_consistent'] is True
reports.append('legitimate next accepted environment has a different VPM set')
def edit(path,fn):value=e.read(path);fn(value);e.write(path,value)
faults=['missing-vpm','equal-count-wrong-vpm','upm-added-to-vpm','missing-upm','unknown-prefix-package','same-metadata-modified-content','wrong-name','wrong-version','missing-lock','wrong-source','wrong-file-path','wrong-lock-dependencies','missing-transitive-lock','builtin-wrong-version','manifest-drift','baseline-drift','recipe-drift','orphan-lock','known-builtin-orphan-cycle']
for mode in faults:
    shutil.rmtree(p/'Packages');shutil.copytree(b/'Packages',p/'Packages')
    recipeBytes=r.read_bytes();baselineBytes=(b/'Packages/other.registry/content.cs').read_bytes()
    packages=p/'Packages';lock=packages/'packages-lock.json';vpm=packages/'vpm-manifest.json'
    if mode=='missing-vpm':shutil.rmtree(packages/'vendor.avatar')
    if mode=='equal-count-wrong-vpm':edit(vpm,lambda x:x.update(locked={'wrong.avatar':{'version':'1.0.0'}}))
    if mode=='upm-added-to-vpm':edit(vpm,lambda x:x['locked'].update({'other.registry':{'version':'1.2.0'}}))
    if mode=='missing-upm':shutil.rmtree(packages/'other.registry')
    if mode=='unknown-prefix-package':e.write(packages/'com.unity.counterfeit/package.json',{'name':'com.unity.counterfeit','version':'1.0.0'})
    if mode=='same-metadata-modified-content':(packages/'other.registry/content.cs').write_text('// different payload')
    if mode=='wrong-name':edit(packages/'other.registry/package.json',lambda x:x.update(name='another.id'))
    if mode=='wrong-version':edit(packages/'other.registry/package.json',lambda x:x.update(version='1.3.0'))
    if mode=='missing-lock':lock.unlink()
    if mode=='wrong-source':edit(lock,lambda x:x['dependencies']['other.registry'].update(source='registry'))
    if mode=='wrong-file-path':edit(lock,lambda x:x['dependencies']['other.registry'].update(version='file:../outside'))
    if mode=='wrong-lock-dependencies':edit(lock,lambda x:x['dependencies']['other.registry'].update(dependencies={}))
    if mode=='missing-transitive-lock':edit(lock,lambda x:x['dependencies'].pop('test.builtin'))
    if mode=='builtin-wrong-version':edit(lock,lambda x:x['dependencies']['test.builtin'].update(version='9.0.0'))
    if mode=='manifest-drift':edit(packages/'manifest.json',lambda x:x['dependencies'].update({'other.registry':'1.0.0'}))
    if mode=='baseline-drift':(b/'Packages/other.registry/content.cs').write_text('// baseline drift')
    if mode=='recipe-drift':edit(r,lambda x:x.update(id='not accepted'))
    if mode=='orphan-lock':edit(lock,lambda x:x['dependencies'].update({'unknown.orphan':{'source':'builtin','version':'1.0.0'}}))
    if mode=='known-builtin-orphan-cycle':edit(lock,lambda x:x['dependencies'].update({'test.orphan':{'source':'builtin','version':'1.0.0','dependencies':{'test.orphan':'1.0.0'}}}))
    reading=observe(d,p,r);assert reading['metrics']['package_resolution_consistent'] is False,mode
    assert reading['notes'],mode
    r.write_bytes(recipeBytes);(b/'Packages/other.registry/content.cs').write_bytes(baselineBytes);reports.append(mode)
print(json.dumps(reports))
`,tools,root],{env,encoding:'utf8'});
 assert.equal(JSON.parse(result).length,21);
});
