import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {openDatabase} from '../../src/state/db.ts';
import {productionInputDocument,restoreProductionInputs} from '../../src/archive/production.ts';
import {continuationProgress,productionDispatchBlocked} from '../../src/production-face-continuation.ts';
import {inputSha256} from '../../src/workflow/inputs.ts';
import {canonicalJson} from '../../src/pack-hash.ts';

function fixture(t:test.TestContext):DatabaseSync {
  const db=openDatabase(':memory:');t.after(()=>db.close());
  db.prepare("INSERT INTO workspace(id,path) VALUES('ws','fixture')").run();
  db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('project','ws','sample','source','{}','active','fixture','fixture')").run();
  db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('wf','project','fixture','fixture','fixture','cancelled','{}')").run();
  return db;
}

test('missing or changed accepted archive content remains a manual requirement and blocks dispatch',t=>{
  const db=fixture(t),values=JSON.stringify({schema:'manual-values/0.1',sourceSha256:'a'.repeat(64),rendererPath:'Face',meshName:'Face',values:{Contour:.25}});
  restoreProductionInputs(db,'project','restored',{schema:'harness-production-inputs/1',head:'wf',sessions:[{id:'s1',target_id:'target',state:'accepted',version:1,accepted_json:'{}',accepted_values_sha256:inputSha256(values)}],
    preference:{mode:'manual',revision:1,accepted_session_id:'s1',current_session_id:'s1'},revisions:[],snapshots:[],lineage:[]},id=>id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM face_manual_session').get()!.n,0);
  assert.equal(productionDispatchBlocked(db,'wf'),true);
  const progress=continuationProgress(db,'project');assert.equal((progress.requirement as any).mode,'manual');assert.ok(progress.missingInputs?.some((item:string)=>item==='accepted-content:s1'));
});

test('portable production lineage retains adoption and delivery identities without external copy paths',t=>{
  const db=fixture(t);
  db.prepare("INSERT INTO production_continuation(id,activation_id,logical_project_id,predecessor_workflow_id,predecessor_project_id,input_json,preparation_json,state) VALUES('c1','activation','project','wf','project','{\"mode\":\"preserve\"}','{\"source\":\"private-path\"}','failed')").run();
  db.prepare("INSERT INTO production_delivery(workflow_id,project_id,face_input_hash,package_hash) VALUES('wf','project','input','package')").run();
  const document=productionInputDocument(db,'project',value=>value);
  assert.equal(document.lineage[0]!.activation_id,'activation');assert.equal(document.lineage[0]!.input_json,'{"mode":"preserve"}');
  assert.equal(document.deliveries![0]!.package_hash,'package');assert.equal(JSON.stringify(document).includes('private-path'),false);assert.equal((document.lineage[0]!.checkpoint as any).sourceKind,'baseline');
});

test('accepted archive content requires its byte digest and its formal adoption must bind the same canonical values',t=>{
  const values=JSON.stringify({schema:'manual-values/0.1',sourceSha256:'a'.repeat(64),values:{Contour:.25}});
  for(const digest of [undefined,inputSha256(values)]) {
    const db=fixture(t),identity={manualSessionId:'s1',acceptedValuesSha256:'f'.repeat(64)},activationId='adopt';
    restoreProductionInputs(db,'project','restored',{schema:'harness-production-inputs/1',head:'wf',
      sessions:[{id:'s1',target_id:'target',state:'accepted',version:1,accepted_json:values,accepted_values_sha256:digest}],preference:{mode:'manual',revision:1,accepted_session_id:'s1'},
      revisions:[{id:'input',workflow_id:'wf',revision:1,activation_id:activationId,face_identity_json:JSON.stringify(identity),face_input_hash:inputSha256(canonicalJson({schema:'workflow-input/0.1',activationId,faceIdentity:identity})),base_plan_hash:'plan',source_event_seq:1}],snapshots:[],lineage:[]},id=>id);
    const missing=continuationProgress(db,'project').missingInputs!;
    assert.ok(missing.includes(digest?'session-binding:input':'accepted-content:s1'));
    assert.equal(productionDispatchBlocked(db,'wf'),true);
  }
});

test('restored terminal producer hashes augment only matching historical outcomes and preserve conflicting evidence',t=>{
  for(const exitStatus of [0,1]) {
    const db=fixture(t);db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('task','wf','plan','Historical producer','tool','PASSED')").run();
    db.prepare("INSERT INTO run(id,task_id,attempt,status,result_json) VALUES('run','task',1,'exited',?)").run(JSON.stringify({exitStatus,outputs:{},restored:true}));
    const producer=canonicalJson({exitStatus:0,verifiedArtifactHashes:{plan:'a'.repeat(64)}}),plan='{}';
    restoreProductionInputs(db,'project','restored',{schema:'harness-production-inputs/1',head:'wf',sessions:[],preference:null,revisions:[],lineage:[],
      snapshots:[{run_id:'run',run_status:'exited',workflow_input_revision_id:null,baseline_artifact_hashes_json:'{}',effective_plan_json:plan,effective_plan_sha256:inputSha256(plan),manual_values_json:null,manual_values_sha256:null,manual_handoff_json:null,stage_tool_selection_json:'{}',face_selection_json:null,producer_json:producer,producer_sha256:inputSha256(producer)}]},id=>id);
    const result=JSON.parse(String(db.prepare("SELECT result_json FROM run WHERE id='run'").get()!.result_json));assert.equal(result.exitStatus,exitStatus);
    if(exitStatus===0)assert.deepEqual(result.verifiedArtifactHashes,{plan:'a'.repeat(64)});
    else assert.ok(JSON.parse(String(db.prepare('SELECT document_json FROM production_archive_reference').get()!.document_json)).missingInputs.includes('producer-binding:run'));
  }
});


test('archive retains rebuild reconciliation and reviewed contract digests while missing engineering remains explicit',t=>{
  const db=fixture(t),snapshot=JSON.stringify({toolRoot:'private-tool-path',definition:{stages:[]}});
  db.prepare("INSERT INTO event(seq,actor,entity_type,entity_id,action,reason) VALUES(1,'human','production_continuation','c1','contract_adopted','Reviewed')").run();
  db.prepare(`INSERT INTO production_continuation(id,activation_id,logical_project_id,predecessor_workflow_id,predecessor_project_id,input_json,preparation_json,state)
    VALUES('c1','activation','project','wf','project','{"mode":"preserve"}',?,'preparing')`).run(JSON.stringify({sourceKind:'frozen_rebuild',checkpoint:'reconcile',source:'private-project-path',preservedRoot:'private-preserved-path',
      sourceFiles:[{path:'unexplained.txt',sha256:'a'.repeat(64)}],report:{hash:'report',unknown:[{path:'unexplained.txt',sha256:'a'.repeat(64)}]},resolutions:{eventSeq:2,reportHash:'report',retainOnly:['unexplained.txt']}}));
  db.prepare('INSERT INTO production_continuation_contract VALUES(?,?,?,?,?,?,?)').run(1,'c1','source-hash','reviewed-package','package-hash',snapshot,'token');
  const document=productionInputDocument(db,'project',value=>value.replaceAll('private-tool-path','<external>'));
  assert.equal(document.contracts![0]!.snapshot_sha256,inputSha256(snapshot));assert.ok(document.missingInputs!.some(id=>id.endsWith(':snapshot_json')));
  assert.equal(document.lineage[0]!.checkpoint.resolutions.reportHash,'report');assert.equal(JSON.stringify(document).includes('private-project-path'),false);
  const restored=fixture(t);restoreProductionInputs(restored,'project','new-root',document,id=>id);
  const retained=JSON.parse(String(restored.prepare('SELECT document_json FROM production_archive_reference').get()!.document_json));
  assert.ok(retained.missingInputs.includes('continuation-contract:c1'));assert.ok(retained.missingInputs.includes('preparation-content:c1'));
  assert.equal(restored.prepare('SELECT state,preparation_json FROM production_continuation').get()!.state,'requested');
  assert.equal(restored.prepare('SELECT state,preparation_json FROM production_continuation').get()!.preparation_json,null);
});


test('manual version parent lineage round-trips with mapped IDs and child-first archive order',t=>{
  const source=fixture(t),values=JSON.stringify({schema:'manual-values/0.1',sourceSha256:'a'.repeat(64),values:{AlternateContour:.6}});
  for(const [index,name] of ['ancestor','child','leaf'].entries())source.prepare('INSERT INTO face_manual_session(id,project_id,project_path,target_id,state,version,accepted_json,parent_session_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(name,'project',name,'target','accepted',index+1,values,index?['ancestor','child'][index-1]!:null);
  const document=productionInputDocument(source,'project',value=>value);document.sessions.reverse();
  const target=fixture(t);restoreProductionInputs(target,'project','moved-root',document,id=>id==='wf'?id:'mapped-'+id);
  assert.deepEqual(target.prepare('SELECT id,parent_session_id FROM face_manual_session ORDER BY version').all().map(row=>({...row})),[
    {id:'mapped-ancestor',parent_session_id:null},{id:'mapped-child',parent_session_id:'mapped-ancestor'},{id:'mapped-leaf',parent_session_id:'mapped-child'}]);
  assert.equal(target.prepare('SELECT document_json FROM production_archive_reference').get()!.document_json && JSON.parse(String(target.prepare('SELECT document_json FROM production_archive_reference').get()!.document_json)).missingInputs.length,0);
});

for(const problem of ['missing','foreign','cycle'])test(`invalid manual parent ${problem} is an explicit cold recovery problem`,t=>{
  const db=fixture(t),values=JSON.stringify({schema:'manual-values/0.1',sourceSha256:'a'.repeat(64),values:{AlternateContour:.6}});
  if(problem==='foreign') {
    db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('foreign','ws','sample','foreign','{}','active','fixture','fixture')").run();
    db.prepare("INSERT INTO face_manual_session(id,project_id,project_path,target_id,state,version,accepted_json) VALUES('parent','foreign','foreign','target','accepted',1,?)").run(values);
  }
  const sessions:any[]=[{id:'child',parent_session_id:'parent',target_id:'target',state:'accepted',version:2,accepted_json:values,accepted_values_sha256:inputSha256(values)}];
  if(problem==='cycle')sessions.push({...sessions[0],id:'parent',parent_session_id:'child',version:1});
  restoreProductionInputs(db,'project','restored',{schema:'harness-production-inputs/1',head:'wf',sessions,preference:null,revisions:[],snapshots:[],lineage:[]},id=>id);
  const missing=JSON.parse(String(db.prepare('SELECT document_json FROM production_archive_reference').get()!.document_json)).missingInputs;
  assert.ok(missing.includes(`session-parent-${problem==='foreign'?'project':problem}:child`),JSON.stringify(missing));
  assert.equal(db.prepare("SELECT parent_session_id FROM face_manual_session WHERE id='child'").get()!.parent_session_id,null);
  assert.equal(productionDispatchBlocked(db,'wf'),true);
});
