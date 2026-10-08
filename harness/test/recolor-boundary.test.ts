import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {removeTemp} from './fixtures/platform.ts';
import {execUnityEditor} from './fixtures/unity-slot.ts';
const tools=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));
test('real Unity production imports outfit receipt metadata and rejects renderable or animated particle empty slots',
 {skip:!process.env.AVH_LOCAL_UNITY_EDITOR||!process.env.AVH_LOCAL_UNITY_BASELINE,timeout:360000},t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-recolor-boundary-'));t.after(()=>removeTemp(root));
 for(const dir of ['Assets/Editor','Packages','ProjectSettings'])mkdirSync(join(root,dir),{recursive:true});
 execFileSync('python3',['-c','import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',join(process.env.AVH_LOCAL_UNITY_BASELINE!,'Packages'),join(root,'Packages')]);
 writeFileSync(join(root,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
 execFileSync('python3',['-c','import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})',tools,root],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:'pipe'});
 copyFileSync(fileURLToPath(new URL('./fixtures/unity/RecolorBoundaryIntegration.cs',import.meta.url)),join(root,'Assets/Editor/RecolorBoundaryIntegration.cs'));
 let error:unknown;try{execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!,['-batchmode','-nographics','-projectPath',root,'-executeMethod','AVH.Harness.RecolorBoundaryIntegration.Run','-logFile',join(root,'unity.log')],{env:{...process.env,AVH_PROJECT_DIR:root},timeout:330000,windowsHide:true,stdio:'pipe'});}catch(e){error=e;}
 if(process.env.AVH_LOCAL_UNITY_EVIDENCE){const out=join(process.env.AVH_LOCAL_UNITY_EVIDENCE,'attempt-'+Date.now());mkdirSync(out,{recursive:true});for(const n of ['result.json','unity.log'])if(existsSync(join(root,n)))copyFileSync(join(root,n),join(out,n));}
 assert.ok(existsSync(join(root,'result.json')),String(error)+' '+readFileSync(join(root,'unity.log'),'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-6).join('\n'));
 const result=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));assert.equal(result.ok,true,result.error);assert.equal(result.assertions,12);
});
