import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {freemem,tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {removeTemp} from './fixtures/platform.ts';
import {execUnityEditor} from './fixtures/unity-slot.ts';
const tools=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));
test('real Unity multi-group production reads every member, thin material preset and independent switch',
 {skip:!process.env.AVH_LOCAL_UNITY_EDITOR||!process.env.AVH_LOCAL_UNITY_BASELINE,timeout:1800000},async t=>{
 const root=process.env.AVH_LOCAL_UNITY_WORKSPACE ?? mkdtempSync(join(tmpdir(),'avh-menu-groups-'));if(!process.env.AVH_LOCAL_UNITY_WORKSPACE)t.after(()=>removeTemp(root));mkdirSync(root,{recursive:true});
 for(const dir of ['Assets/Editor','Packages','ProjectSettings'])mkdirSync(join(root,dir),{recursive:true});
 execFileSync('python3',['-c','import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',join(process.env.AVH_LOCAL_UNITY_BASELINE!,'Packages'),join(root,'Packages')]);
 mkdirSync(join(root,'Packages/com.vrcfury.temp'),{recursive:true});writeFileSync(join(root,'Packages/com.vrcfury.temp/package.json'),JSON.stringify({name:'com.vrcfury.temp',version:'0.0.0'}));
 writeFileSync(join(root,'ProjectSettings/ProjectVersion.txt'),'m_EditorVersion: 2022.3.22f1\n');
 execFileSync('python3',['-c','import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})',tools,root],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:'pipe'});
 copyFileSync(fileURLToPath(new URL('./fixtures/unity/MenuGroupsIntegration.cs',import.meta.url)),join(root,'Assets/Editor/MenuGroupsIntegration.cs'));
 for(const name of ['RecolorMaterialIntegration.cs'])copyFileSync(fileURLToPath(new URL('./fixtures/unity/'+name,import.meta.url)),join(root,'Assets/Editor',name));
 const resultName='result-'+randomUUID()+'.json';
 while(process.platform==='win32'&&freemem()<12*1024**3){console.log(`[menu-memory] ${(freemem()/1024**3).toFixed(2)} GiB free; waiting for 12 GiB`);await new Promise(resolve=>setTimeout(resolve,30_000));}
 const freeBeforeLaunchGiB=freemem()/1024**3;
 let error:unknown;try{execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!,['-batchmode','-projectPath',root,'-executeMethod','AVH.Harness.MenuGroupsIntegration.Run','-logFile',join(root,'unity.log')],{env:{...process.env,AVH_PROJECT_DIR:root,AVH_MENU_GROUPS_RESULT:resultName},timeout:1740000,windowsHide:true,stdio:'pipe'});}catch(e){error=e;}
 if(process.env.AVH_LOCAL_UNITY_EVIDENCE){const out=join(process.env.AVH_LOCAL_UNITY_EVIDENCE,'attempt-'+Date.now());mkdirSync(out,{recursive:true});for(const n of [resultName,'unity.log'])if(existsSync(join(root,n)))copyFileSync(join(root,n),join(out,n));
  const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(join(out,'sources.json'),JSON.stringify({freeBeforeLaunchGiB,files:Object.fromEntries(['MenuStage.cs','AvatarAudit.cs','OutfitStage.cs','LocalOperations.cs'].map(name=>[name,sha(join(root,'Assets/_HarnessTools/Editor',name))])),fixture_sha256:sha(join(root,'Assets/Editor/MenuGroupsIntegration.cs'))},null,2));}
 assert.ok(existsSync(join(root,resultName)),String(error)+' '+readFileSync(join(root,'unity.log'),'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-6).join('\n'));
 const result=JSON.parse(readFileSync(join(root,resultName),'utf8'));assert.equal(error,undefined,result.error ?? String(error));assert.equal(result.ok,true,result.error);assert.ok(result.assertions > 70);
});
