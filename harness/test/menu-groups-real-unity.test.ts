import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {removeTemp} from './fixtures/platform.ts';
import {execUnityEditor, FIXTURE_RUN_DIRECTORY, unityFixtureRunDir} from './fixtures/unity-slot.ts';
const tools=fileURLToPath(new URL('../builtin/tools/harness/',import.meta.url));
// A private, prepared source project and plan are opt-in inputs. Always copy before installing or executing.
test('private real sources: every group member survives full SDK build and fresh Library cold import',
 {skip:!process.env.AVH_LOCAL_UNITY_EDITOR||!process.env.AVH_LOCAL_UNITY_REAL_SOURCE||!process.env.AVH_LOCAL_UNITY_REAL_PLAN,timeout:3600000},t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-real-groups-'));t.after(()=>removeTemp(root));
 const project=join(root,'project'),cold=join(root,'cold');mkdirSync(project);
 for(const name of ['Assets','Packages','ProjectSettings'])cpSync(join(process.env.AVH_LOCAL_UNITY_REAL_SOURCE!,name),join(project,name),{recursive:true});
 copyFileSync(process.env.AVH_LOCAL_UNITY_REAL_PLAN!,join(project,'real-plan.json'));
 execFileSync('python3',['-c','import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})',tools,project],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 copyFileSync(fileURLToPath(new URL('./fixtures/unity/RealMenuGroupsIntegration.cs',import.meta.url)),join(project,'Assets/Editor/RealMenuGroupsIntegration.cs'));
 // The B 3584-grid regression needs about 2400s and the product's own RegressionStage budget is 5400s, so the
 // fixture's editor call must not cut it short the way the old 1740000ms did. The evidence copy also carries
 // `_regression/` — the regression readings and their rendered photos — so neither vanishes with the temp project.
 function run(dir:string,method:string){
  let error:unknown;try{execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!,['-batchmode','-projectPath',dir,'-executeMethod','AVH.Harness.RealMenuGroupsIntegration.'+method,'-logFile',join(dir,'_harness/manual-run/unity-'+method+'.log')],{env:{...process.env,AVH_PROJECT_DIR:dir,AVH_MENU_GROUPS_RESULT:'real-test-result.json',AVH_RUN_DIR:join(dir,'_harness/manual-run')},timeout:3600000,windowsHide:true,stdio:'pipe'});}catch(e){error=e;}
  if(process.env.AVH_LOCAL_UNITY_EVIDENCE){const output=join(process.env.AVH_LOCAL_UNITY_EVIDENCE,'private-'+Date.now()+'-'+method);mkdirSync(output,{recursive:true});for(const path of ['real-test-result.json','real-build-report.json','_harness/manual-run',FIXTURE_RUN_DIRECTORY,'_regression'])if(existsSync(join(dir,path)))cpSync(join(dir,path),join(output,path),{recursive:true});}
  assert.equal(error,undefined,String(error));
 }
 mkdirSync(join(project,'_harness/manual-run'),{recursive:true});run(project,'Run');
 const built=JSON.parse(readFileSync(join(project,'real-test-result.json'),'utf8'));
 assert.equal(built.ok,true,JSON.stringify(built.notes));assert.equal(built.static_states,1792);assert.ok(built.runtime_events>=32);
 assert.ok(Object.values(built.metrics).filter(v=>typeof v==='boolean').every(v=>v===true),JSON.stringify(built.metrics));
 run(project,'Regression');const regression=JSON.parse(readFileSync(join(project,'_regression/coverage.json'),'utf8'));
 assert.equal(regression.static_states,1792);assert.equal(regression.business_assertion_failures,0);assert.equal(regression.runtime_assertion_failures,0);assert.ok(regression.photos.length>0);
 assert.equal(regression.source_shape_state_complete,true);assert.equal(regression.source_shape_unknown_count,0);assert.ok(regression.source_shape_pair_count>0);assert.equal(regression.source_shape_value_delta_max,0);
 mkdirSync(cold);for(const name of ['Assets','Packages','ProjectSettings'])cpSync(join(project,name),join(cold,name),{recursive:true});copyFileSync(join(project,'real-plan.json'),join(cold,'real-plan.json'));
 assert.equal(existsSync(join(cold,'Library')),false);mkdirSync(join(cold,'_harness/manual-run'),{recursive:true});run(cold,'Cold');
 // The Windows fixture launcher sets AVH_RUN_DIR to its own fixture directory, so an artifact written through
 // Avh.RunDir lands there rather than in the run directory this test passes in. Reading the old path made the
 // Cold phase look like it produced nothing while the editor had exited 0 (the axis fixture already reads here).
 const coverage=JSON.parse(readFileSync(join(unityFixtureRunDir(cold,join(cold,'_harness/manual-run')),'cold-group-coverage.json'),'utf8'));
 assert.equal(coverage.static_states,1792);assert.equal(coverage.static_failures,0);assert.equal(coverage.runtime_failures,0);assert.ok(coverage.runtime_events>=32);
 assert.ok(Object.values(coverage.metrics).filter(v=>typeof v==='boolean').every(v=>v===true),JSON.stringify(coverage.metrics));
 const missing=JSON.parse(readFileSync(join(unityFixtureRunDir(cold,join(cold,'_harness/manual-run')),'cold_missing_scripts.json'),'utf8'));assert.equal(missing.missing_scripts,0);
});
