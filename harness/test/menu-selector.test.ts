import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {parse} from 'yaml';
import {loadProcess} from '../src/process/load.ts';
import {loadCapabilities} from '../src/workflow/capabilities.ts';
import {removeTemp} from './fixtures/platform.ts';
import {execUnityEditor} from './fixtures/unity-slot.ts';
const tools=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));
test('real Unity selector production excludes EditorOnly visuals and preserves inactive retained ownership',
 {skip:!process.env.AVH_LOCAL_UNITY_EDITOR||!process.env.AVH_LOCAL_UNITY_BASELINE,timeout:360000},t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-menu-selector-'));t.after(()=>removeTemp(root));
 for(const dir of ['Assets/Editor','Packages','ProjectSettings'])mkdirSync(join(root,dir),{recursive:true});
 execFileSync('python3',['-c','import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',join(process.env.AVH_LOCAL_UNITY_BASELINE!,'Packages'),join(root,'Packages')]);
 writeFileSync(join(root,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
 execFileSync('python3',['-c','import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})',tools,root],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:'pipe'});
 copyFileSync(fileURLToPath(new URL('./fixtures/unity/MenuSelectorIntegration.cs',import.meta.url)),join(root,'Assets/Editor/MenuSelectorIntegration.cs'));
 let error:unknown;try{execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!,['-batchmode','-nographics','-projectPath',root,'-executeMethod','AVH.Harness.MenuSelectorIntegration.Run','-logFile',join(root,'unity.log')],{env:{...process.env,AVH_PROJECT_DIR:root},timeout:330000,windowsHide:true,stdio:'pipe'});}catch(e){error=e;}
 if(process.env.AVH_LOCAL_UNITY_EVIDENCE){const out=join(process.env.AVH_LOCAL_UNITY_EVIDENCE,'attempt-'+Date.now());mkdirSync(out,{recursive:true});for(const n of ['result.json','unity.log'])if(existsSync(join(root,n)))copyFileSync(join(root,n),join(out,n));}
 assert.ok(existsSync(join(root,'result.json')),String(error)+' '+readFileSync(join(root,'unity.log'),'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-6).join('\n'));
 const result=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));assert.equal(result.ok,true,result.error);assert.equal(result.assertions,8);
});

test('formal menu prepare installs only exact Runtime-selected compiler bytes',t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-menu-deployment-'));t.after(()=>removeTemp(root));
 const names=['LocalOperations.cs','OutfitStage.cs','OutfitVisibility.cs','SetupStage.cs','AvhCommon.cs','FaceStage.cs','FaceGeometry.cs','FaceEyes.cs','FaceMapping.cs','MenuStage.cs','RecolorStage.cs','AvatarAudit.cs','RegressionStage.cs'];
 const installed=join(root,'Assets/_HarnessTools/Editor');mkdirSync(installed,{recursive:true});
 const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
 for(const name of names)copyFileSync(join(tools,'unity/Editor',name),join(installed,name));
 const target=join(installed,'MenuStage.cs');writeFileSync(target,'previous reviewed compiler');
 const rows=names.map(name=>({path:'Assets/_HarnessTools/Editor/'+name,before:sha(join(installed,name)),after:sha(join(tools,'unity/Editor',name))}));
 const processRoot=fileURLToPath(new URL('../builtin/knowledge/process/',import.meta.url));
 const definition=loadProcess(readFileSync(join(processRoot,'pc-recolor-outfit.process.yaml'),'utf8'),parse(readFileSync(join(processRoot,'thresholds.yaml'),'utf8')));
 const capability=loadCapabilities(readFileSync(join(processRoot,'pc-recolor-outfit.capabilities.yaml'),'utf8'),definition).stages.menu!;
 const argv=capability.prepareCommand!.slice(1).map(arg=>arg.replaceAll('{toolRoot}',fileURLToPath(new URL('../builtin/tools',import.meta.url))).replaceAll('{project}',root));
 const runDirectory=join(root,'run');mkdirSync(runDirectory);
 // ToolExecutor launches prepare in the Run directory and supplies project authority through AVH_PROJECT_DIR.
 const run=(updates:unknown)=>execFileSync('python3',argv,{cwd:runDirectory,env:{...process.env,AVH_PROJECT_DIR:root,AVH_RUNTIME_TOOL_UPDATE_JSON:JSON.stringify(updates)},encoding:'utf8',stdio:'pipe'});
 assert.equal(JSON.parse(run(rows)).verified_sources,13);assert.equal(sha(target),sha(join(tools,'unity/Editor/MenuStage.cs')));
 writeFileSync(target,'previous reviewed compiler');
 assert.throws(()=>run([]),/frozen source/);assert.equal(readFileSync(target,'utf8'),'previous reviewed compiler');
 assert.throws(()=>run(rows.map(row=>({...row,after:'forged'}))),/exact source versions/);
 assert.equal(JSON.parse(run(rows)).verified_sources,13);assert.equal(sha(target),sha(join(tools,'unity/Editor/MenuStage.cs')));
 run(rows);writeFileSync(target,'unreviewed edit');assert.throws(()=>run(rows),/exact source versions/);
});
