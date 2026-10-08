import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {ObservationVerifier,parseObservation} from '../src/workflow/observe.ts';
import type {ProcessDefinition} from '../src/process/types.ts';
import {windowsToolPath} from '../src/host-platform.ts';

const tools=fileURLToPath(new URL('../builtin/tools/',import.meta.url));
const python=spawnSync('python3',['--version']).status===0;
function fixture(t:test.TestContext){const root=mkdtempSync(join(tmpdir(),'avh-observer-scalars-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function observe(root:string,script:string,args:string[],env:NodeJS.ProcessEnv={}){
 const path=join(root,'observation.json');
 execFileSync('python3',[join(tools,'harness',script),...args,'--out',path],{env:{...process.env,PYTHONUTF8:'1',...(process.platform==='win32'?{PATH:windowsToolPath(process.env.PATH)}:{}),PYTHONDONTWRITEBYTECODE:'1',AVH_PROJECT_DIR:root,AVH_RUN_DIR:root,AVH_PLAN:'{}',AVH_MANIFEST:'{}',...env}});
 const bytes=readFileSync(path),reading=parseObservation(bytes.toString());
 assert.ok(Object.values(reading.metrics).every(value=>value===null||typeof value==='number'||typeof value==='boolean'));
 assert.ok(reading.notes?.every(note=>typeof note==='string'));
 return{path,bytes,reading};
}
test('actual recolor source evidence is retained while real scalar consumers distinguish managed, git, untracked and missing scripts',{skip:!python},async t=>{
 for(const [kind,expected,source] of [['managed',true,'managed-pack:fixture@1'],['git',true,'git'],['untracked',false,'untracked'],['missing',false,'missing']] as const){
  await t.test(kind,async t=>{
   const root=fixture(t),toolRoot=join(root,'tool-pack','tools');mkdirSync(join(toolRoot,'harness'),{recursive:true});
   if(kind!=='missing')copyFileSync(join(tools,'harness/recolor.py'),join(toolRoot,'harness/recolor.py'));
   if(kind==='managed')writeFileSync(join(root,'tool-pack/pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:'fixture',version:'1'}));
   if(kind==='git'){execFileSync('git',['init','--quiet',toolRoot]);execFileSync('git',['-C',toolRoot,'add','harness/recolor.py']);}
   const {bytes,reading,path}=observe(root,'observe_recolor.py',[],{AVH_TOOL_ROOT:toolRoot});
   assert.equal(reading.metrics.recipe_script_tracked,expected);
   assert.equal(JSON.parse(bytes.toString()).proof.recipe_script_source,source);
   assert.equal('recipe_script_source' in reading.metrics,false);
   const hash=createHash('sha256').update(bytes).digest('hex');
   const definition:ProcessDefinition={schema:'process/0.1',id:'recolor-script-consumer',version:'1',applies_to:{},artifacts:['recolor'],
    stages:[{id:'recolor',needs:[],produces:['recolor'],requires:['script_versioned'],gates:[],invalidated_by:[]}],
    checks:[{id:'script_versioned',observe:'material.recolor',on:'recolor',scope:'edit',rule:'recipe_script_tracked == true',severity:'blocking',maturity:'accepted'}],gates:[],milestones:[]};
   const verifier=new ObservationVerifier({definition,observers:{'material.recolor':{kind:'run-file',runFile:'observation.json'}},thresholds:{},project:root,toolRoot:tools,runRoot:join(root,'..'),plan:()=>({})});
   const runId=root.split(/[\\/]/).at(-1)!;
   const verdict=await verifier.verify({runId,taskId:'fixture',workflowId:'fixture',projectId:'fixture',stageId:'recolor',attempt:1,idempotencyKey:runId,expectedOutputs:[]},{exitStatus:0,outputs:{}},{recolor:hash});
   assert.equal(verdict[0]!.result,expected?'pass':'violation');assert.equal(verdict[0]!.artifactHash,hash);
   assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),hash);
   const legacy=JSON.parse(bytes.toString());legacy.metrics.recipe_script_source=legacy.proof.recipe_script_source;
   assert.throws(()=>parseObservation(JSON.stringify(legacy)),/recipe_script_source 应为数值、真假值或 null/);
  });
 }
});

test('an observation keeps its list-valued evidence in a details field so the Runtime accepts the metric map',()=>{
  // FX1: on the frozen version `avatar.fit` published three arrays inside `metrics`, and the Runtime's own
  // `parseObservation` turned a real workflow's `regression_pre` into `check regression_fit_probe_pre: error`.
  const sample={schema:'observation/0.1',
    metrics:{fit_probe_completed:true,fit_states_expected:2,fit_states_completed:2,fit_pierced_vertices:0,fit_body_mesh_count:1},
    details:{fit_body_paths:['Assets/Body.fbx'],
      fit_pierced_confirmed_garments:[{path:'Top',vertices:0,ray_vertices:0}],
      fit_pierced_groups:[{garment:'Top',region:'Chest',vertices:8,counted:true,views:['front'],pixels:[0,1]}]},
    notes:['状态集：期望 2，读到 2 个状态的证据']};
  const reading=parseObservation(JSON.stringify(sample));
  assert.deepEqual(reading.details?.fit_body_paths,['Assets/Body.fbx']);
  assert.equal((reading.details?.fit_pierced_groups as unknown[]).length,1);
  // Each of those readings must be rejected where it used to sit: inside the metric map.
  for(const name of ['fit_body_paths','fit_pierced_confirmed_garments','fit_pierced_groups']){
    assert.equal(name in reading.metrics,false,`${name} must not be a metric`);
    const misplaced=JSON.parse(JSON.stringify(sample));
    misplaced.metrics[name]=misplaced.details[name];
    assert.throws(()=>parseObservation(JSON.stringify(misplaced)),new RegExp(`${name} 应为数值、真假值或 null`));
  }
  // `details` is a field of the observation, not a second metric map: it must be an object when present.
  assert.throws(()=>parseObservation(JSON.stringify({schema:'observation/0.1',metrics:{ok:true},details:[]})),/details 应为对象/);
});

test('actual assets observer stage exits and missing-delivery package exit retain scalar or explicitly unmeasured metrics',{skip:!python},t=>{
 const root=fixture(t),library=join(root,'library');mkdirSync(library);
 for(const stage of ['intake','setup','outfit','package','unknown'])observe(root,'observe_assets.py',['--library',library],{AVH_STAGE:stage});
 const {reading}=observe(root,'observe_package.py',[]);
 assert.equal(reading.metrics.loose_files_in_delivery_dir,null);
 // Exercise the full archive exit too, with synthetic bytes and the Runtime's actual 7-Zip command environment.
 execFileSync('python3',['-c',String.raw`
import io,json,sys,zipfile
from pathlib import Path
root=Path(sys.argv[1]);delivery=root/'_harness/delivery';delivery.mkdir(parents=True)
inner=io.BytesIO()
with zipfile.ZipFile(inner,'w') as z:
    for name,content in [('Assets/item.txt','synthetic'),('Packages/manifest.json',json.dumps({'dependencies':{}})),('ProjectSettings/ProjectVersion.txt','m_EditorVersion: 2022.3.22f1\n'),('.gitignore','Library\n'),('README.txt','fixture')]:z.writestr(name,content)
with zipfile.ZipFile(delivery/'Synthetic_交付.zip','w') as z:
    z.writestr('Synthetic_工程.zip',inner.getvalue());z.writestr('交付说明.txt','synthetic\n');z.writestr('客户端验收与诊断.md','Pending actual client checks\n')
`,root],{env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
 const complete=observe(root,'observe_package.py',[]).reading;
 assert.equal(complete.metrics.seven_zip_test_exit_code,0);
 assert.equal(complete.metrics.delivery_diagnosis_present,true);
 assert.equal(complete.metrics.zip_top_level_entries,5);
});
