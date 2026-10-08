import {selectedStageContract} from '../../src/workflow/stage-contract.ts';
import {workflowSnapshot} from '../../src/workflow/runtime.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/state/db.ts';
import {archiveStageContracts,restoreStageContracts} from '../../src/archive/stage-contract.ts';
import {sha256File} from '../../src/file-hash.ts';
import {inputSha256} from '../../src/workflow/inputs.ts';
import {removeTemp} from '../fixtures/platform.ts';

function fixture(t:test.TestContext) {
  const temp=mkdtempSync(join(tmpdir(),'avh-selection-archive-')),source=join(temp,'source'),target=join(temp,'target'),home=join(temp,'home'),receiver=join(temp,'receiver');
  const pack=join(home,'managed/packs/frozen');
  for(const dir of [join(source,'Assets/OtherLayout'),join(pack,'tools'),join(pack,'knowledge')])mkdirSync(dir,{recursive:true});
  writeFileSync(join(source,'Assets/OtherLayout/source.bin'),'synthetic material');writeFileSync(join(pack,'tools/maker.mjs'),'frozen executor');writeFileSync(join(pack,'knowledge/context.md'),'frozen context');
  writeFileSync(join(pack,'pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:'frozen',version:'1',channel:'builtin'}));
  const db=openDatabase(':memory:');t.after(()=>{db.close();removeTemp(temp);});
  db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('ws',temp);
  db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('project','ws','sample',?,'{}','active','test','test')").run(source);
  for(const id of ['wf','mapped-wf']) {
    db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES(?,'project','test','hash','test','active','{}')").run(id);
    db.prepare("INSERT INTO workflow_definition(workflow_id,profile,definition_json,capabilities_json,thresholds_json,tools_json,contexts_json,tool_root) VALUES(?,'test','{}','{}','{}','{}','{}',?)").run(id,join(pack,'tools'));
  }
  const snapshot={workflowId:'wf',profile:'test',definition:{},capabilities:{},thresholds:{},tools:{'maker.mjs':sha256File(join(pack,'tools/maker.mjs'))},toolRoot:join(pack,'tools'),
    contexts:{'context.md':{content:'frozen context',sha256:sha256File(join(pack,'knowledge/context.md'))}},variables:{assetLibrary:'private-library'},frozenAt:'frozen',
    manifest:{schema:'manifest/0.1',profile:'test',request:'private customer wording',assets:[{store:'client',item:join(source,'Assets/OtherLayout/source.bin'),sha256:sha256File(join(source,'Assets/OtherLayout/source.bin'))}],
      variants:[{id:'other',assets:[{item:join(source,'Assets/OtherLayout/source.bin'),role:'source'}]}]}};
  for(let i=0;i<2;i++)db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json,occurred_at) VALUES('wf','human','stage_contract','face','selected','Synthetic selected contract',?,'same-instant')").run(JSON.stringify({selection:{snapshot,deployment:[]}}));
  const contracts=archiveStageContracts(db,'project',value=>value);
  cpSync(source,target,{recursive:true});cpSync(join(home,'managed'),join(receiver,'managed'),{recursive:true});rmSync(source,{recursive:true});rmSync(home,{recursive:true});
  return {db,temp,source,target,receiver,contracts,restore:()=>restoreStageContracts(db,'project',target,receiver,contracts,old=>old==='wf'?'mapped-wf':old,name=>name==='assetLibrary'?join(receiver,'library'):undefined)};
}

test('required selected snapshots relocate verified material and exact tools without losing same-time decisions',t=>{
  const f=fixture(t),result=f.restore();assert.deepEqual(result.missing,[]);assert.equal(result.sequences.size,2);assert.equal(new Set(result.sequences.values()).size,2);
  for(const seq of result.sequences.values()) {
    const payload=JSON.parse(String(f.db.prepare('SELECT payload_json FROM event WHERE seq=?').get(seq)!.payload_json)),snapshot=payload.selection.snapshot;
    assert.equal(snapshot.workflowId,'mapped-wf');assert.equal(snapshot.toolRoot,join(f.receiver,'managed/packs/frozen/tools'));
    assert.equal(snapshot.variables.assetLibrary,join(f.receiver,'library'));assert.equal(snapshot.contexts['context.md'].content,'frozen context');
    assert.equal(snapshot.manifest.assets[0].item,join(f.target,'Assets/OtherLayout/source.bin'));assert.equal(snapshot.manifest.variants[0].assets[0].item,snapshot.manifest.assets[0].item);
  }
  assert.deepEqual([...f.restore().sequences],[...result.sequences]);
  assert.ok(!JSON.stringify(f.contracts).includes(f.source));assert.ok(!JSON.stringify(f.contracts).includes('private-library'));assert.ok(!JSON.stringify(f.contracts).includes('private customer wording'));
});

for(const tamper of ['digest','pack','material','escape'])test(`selected archive reports ${tamper} as missing input instead of falling back`,t=>{
  const f=fixture(t);
  if(tamper==='digest')f.contracts[0]!.sha256='0'.repeat(64);
  if(tamper==='pack')writeFileSync(join(f.receiver,'managed/packs/frozen/tools/maker.mjs'),'changed tool');
  if(tamper==='material')writeFileSync(join(f.target,'Assets/OtherLayout/source.bin'),'changed material');
  if(tamper==='escape')for(const row of f.contracts){const payload=JSON.parse(row.payload);payload.selection.snapshot.manifest.assets[0].item='../escape';row.payload=JSON.stringify(payload);row.sha256=inputSha256(row.payload);}
  const result=f.restore();assert.ok(result.missing.length);assert.equal(result.sequences.size,tamper==='digest'?1:0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM event WHERE workflow_id='mapped-wf' AND entity_type='stage_contract'").get()!.n,tamper==='digest'?1:0);
});

test('restored selection order survives an older contract completing after a newer one',t=>{
  const f=fixture(t),first=f.contracts[0]!;first.sha256='0'.repeat(64);
  const partial=f.restore();assert.equal(partial.sequences.size,1);
  first.sha256=inputSha256(first.payload);const restored=f.restore();assert.deepEqual(restored.missing,[]);
  const last=f.contracts.at(-1)!;
  assert.equal(selectedStageContract(f.db,workflowSnapshot(f.db,'mapped-wf'),'face').selectionSeq,restored.sequences.get(last.seq),'The latest original selection must remain the future Run contract');
  const count=f.db.prepare("SELECT COUNT(*) n FROM event WHERE workflow_id='mapped-wf' AND entity_type='stage_contract'").get()!.n;
  f.restore();assert.equal(f.db.prepare("SELECT COUNT(*) n FROM event WHERE workflow_id='mapped-wf' AND entity_type='stage_contract'").get()!.n,count);
});
