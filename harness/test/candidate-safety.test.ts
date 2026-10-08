import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { enforceCandidateTrialSafety } from '../src/candidate-safety.ts';
import { approveCandidateTrial } from '../src/managed-pack-candidate.ts';
import { openDatabase } from '../src/state/db.ts';
import { removeTemp } from './fixtures/platform.ts';

function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'avh-safety-'));t.after(()=>removeTemp(root));
  const db=openDatabase(join(root,'state.db'));t.after(()=>db.close());
  db.exec(`INSERT INTO workspace(id,path) VALUES('w','/w');
    INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
      VALUES('p','w','client','/w/p','{}','active','h','k');
    INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json)
      VALUES('flow','p','x','x','candidate:c:hash','active','{}');`);
  db.prepare(`INSERT INTO managed_pack_candidate(id,base_pack_id,version,root,content_hash,source_kind,reason)
    VALUES('c','base','1-candidate','/candidate',?,'ai','fixture')`).run('a'.repeat(64));
  db.prepare(`INSERT INTO managed_pack_trial(id,candidate_id,project_id,workflow_id,content_hash,mode,status,restrictions_json,approved_by)
    VALUES('trial','c','p','flow',?,'project','active','{}','tester')`).run('a'.repeat(64));
  return db;
}
function sample(db:ReturnType<typeof openDatabase>,index:number,withRisk:boolean,passed:boolean):void{
  const task=`task-${index}`,run=`run-${index}`;
  db.prepare(`INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES(?,'flow','outfit','g','executor',?)`)
    .run(task,passed?'PASSED':'FAILED');
  db.prepare(`INSERT INTO run(id,task_id,attempt,status,result_json) VALUES(?,?,1,'exited','{}')`).run(run,task);
  db.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)
    VALUES('flow','runtime','run',?,'context_compiled','fixture',?)`).run(run,JSON.stringify({modelFamily:'codex',
      selected:withRisk?[{id:'risky-shoe-rule',sha256:'x'}]:[]}));
  if(passed)db.prepare(`INSERT INTO stage_completion(workflow_id,stage_id,artifact_hashes_json,run_id) VALUES('flow','outfit','{}',?)`).run(run);
}

test('critical candidate context regression automatically disables only the local trial',t=>{
  const db=fixture(t);for(let i=0;i<5;i++)sample(db,i,false,true);for(let i=5;i<10;i++)sample(db,i,true,false);
  const actions=enforceCandidateTrialSafety(db);assert.equal(actions.length,1);assert.equal(actions[0]!.trialId,'trial');
  assert.equal((db.prepare('SELECT status FROM managed_pack_trial WHERE id=?').get('trial') as {status:string}).status,'disabled');
  const event=db.prepare("SELECT action,payload_json AS payload FROM event WHERE entity_type='managed_pack_trial'").get() as {action:string;payload:string};
  assert.equal(event.action,'auto_disabled');assert.match(event.payload,/suspected-pollution/);
  assert.throws(()=>approveCandidateTrial(db,'p','c','tester'),/cannot be retried unchanged/);
  assert.equal(enforceCandidateTrialSafety(db).length,0,'automatic stop is idempotent');
});

test('critical local adoption stops successor use without pretending to repair an existing workflow',t=>{
  const db=fixture(t);
  db.prepare(`INSERT INTO local_pack_adoption(id,scope,project_id,candidate_id,content_hash,command_id,approved_by,reason)
    VALUES('adoption','project','p','c',?,'adopt','user','local repair')`).run('a'.repeat(64));
  db.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)
    VALUES('flow','human','workflow','flow','created','local adoption',?)`).run(JSON.stringify({localAdoption:{adoptionId:'adoption'}}));
  for(let i=0;i<5;i++)sample(db,i,false,true);for(let i=5;i<10;i++)sample(db,i,true,false);
  enforceCandidateTrialSafety(db);
  assert.equal(db.prepare("SELECT status FROM local_pack_adoption WHERE id='adoption'").get()!.status,'disabled');
  assert.equal(db.prepare("SELECT status FROM workflow WHERE id='flow'").get()!.status,'active','existing execution state is preserved');
  assert.equal(db.prepare("SELECT count(*) AS n FROM event WHERE entity_type='local_pack_adoption'").get()!.n,1);
  enforceCandidateTrialSafety(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM event WHERE entity_type='local_pack_adoption'").get()!.n,1);
});

test('candidate safety does not act before both comparison sides have enough evidence',t=>{
  const db=fixture(t);for(let i=0;i<4;i++)sample(db,i,false,true);for(let i=4;i<8;i++)sample(db,i,true,false);
  assert.deepEqual(enforceCandidateTrialSafety(db),[]);
  assert.equal((db.prepare('SELECT status FROM managed_pack_trial WHERE id=?').get('trial') as {status:string}).status,'active');
});

test('live and cancelled observations never disable a trial as failed work', t => {
  const db = fixture(t);
  for (let i = 0; i < 5; i++) sample(db, i, false, true);
  for (let i = 5; i < 10; i++) sample(db, i, true, false);
  for (const [runStatus, taskStatus] of [['running', 'RUNNING'], ['exited', 'VERIFYING'],
    ['exited', 'WAITING_HUMAN'], ['cancelled', 'CANCELLED'], ['abandoned', 'RECOVERY_REQUIRED'],
    ['exited', 'CANCELLED']]) {
    db.prepare('UPDATE run SET status=? WHERE task_id IN (SELECT id FROM task WHERE id IN (?,?,?,?,?))')
      .run(runStatus!, 'task-5', 'task-6', 'task-7', 'task-8', 'task-9');
    db.prepare('UPDATE task SET status=? WHERE id IN (?,?,?,?,?)')
      .run(taskStatus!, 'task-5', 'task-6', 'task-7', 'task-8', 'task-9');
    assert.deepEqual(enforceCandidateTrialSafety(db), [], `${runStatus}/${taskStatus}`);
  }
  db.prepare("UPDATE run SET status='exited' WHERE task_id IN (SELECT id FROM task WHERE status='CANCELLED')").run();
  db.prepare("UPDATE task SET status='FAILED' WHERE status='CANCELLED'").run();
  assert.equal(enforceCandidateTrialSafety(db).length, 1, 'settled failures still stop the affected trial');
});

test('settled quota and authorization attempts do not disable a candidate trial', t => {
  const db = fixture(t);
  for (let i = 0; i < 5; i++) sample(db, i, false, true);
  for (let i = 5; i < 10; i++) sample(db, i, true, false);
  for (const errorClass of ['rate_limit', 'auth', 'permission_denied']) {
    db.prepare('UPDATE run SET result_json=? WHERE task_id IN (?,?,?,?,?)')
      .run(JSON.stringify({exitStatus:1,outputs:{},errorClass}), 'task-5', 'task-6', 'task-7', 'task-8', 'task-9');
    assert.deepEqual(enforceCandidateTrialSafety(db), [], errorClass);
  }
  assert.equal(db.prepare('SELECT status FROM managed_pack_trial WHERE id=?').get('trial')!.status, 'active');
});
