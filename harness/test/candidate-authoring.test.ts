import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { attachAuthoringTask, authoringTaskSpec, candidateAuthoringRows, prepareCandidateAuthoring,
  reconcileCandidateAuthoring } from '../src/candidate-authoring.ts';
import { packCandidates } from '../src/managed-pack-candidate.ts';
import { openDatabase } from '../src/state/db.ts';
import { posixPath, removeTemp } from './fixtures/platform.ts';

function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'avh-authoring-')),home=join(root,'home'),project=join(root,'workspace/project'),base=join(root,'base');
  t.after(()=>removeTemp(root));mkdirSync(project,{recursive:true});cpSync(new URL('../builtin/',import.meta.url),base,{recursive:true});
  const info=JSON.parse(readFileSync(join(base,'pack.json'),'utf8')) as {id:string};
  const db=openDatabase(join(root,'state.db'));t.after(()=>db.close());
  db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('w',join(root,'workspace'));
  db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES('p','w','client',?,'{}','active','h','k')`).run(project);
  db.prepare(`INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json)
    VALUES('flow','p','avh-task/0.1','avh-task/0.1','k','active','{}')`).run();
  return{root,home,project,base,baseId:info.id,db};
}

test('AI authoring stays in the project until its evidence-backed Task passes, then registers without promotion',t=>{
  const f=fixture(t),draft=prepareCandidateAuthoring(f.db,'p',f.base,f.baseId,'distill failed shoe fitting cases','shoe-fit-candidate');
  assert.match(posixPath(draft.sourceRoot), /_harness\/candidate-packs\/shoe-fit-candidate$/);
  assert.deepEqual(JSON.parse(readFileSync(join(draft.sourceRoot,'pack.json'),'utf8')).channel,'candidate');
  const spec=authoringTaskSpec(draft,f.project,[{stage:'outfit',outcome:'failure',reason:'sole piercing'}]);
  assert.match(spec,/sole piercing/);assert.match(spec,/authoring-report\.json/);
  f.db.prepare(`INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('author-task','flow','work','g','executor','READY')`).run();
  attachAuthoringTask(f.db,draft.id,'author-task');reconcileCandidateAuthoring(f.db,f.home);
  assert.equal(packCandidates(f.db).length,0,'READY output never registers');
  f.db.prepare("UPDATE task SET status='PASSED' WHERE id='author-task'").run();reconcileCandidateAuthoring(f.db,f.home);
  assert.equal(candidateAuthoringRows(f.db,'p')[0]!.status,'registered');
  assert.deepEqual(packCandidates(f.db).map(item=>[item.id,item.status,item.sourceKind]),[['shoe-fit-candidate','generated','ai']]);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM managed_pack_release').get() as {n:number}).n,0,
    'local authoring never creates a release');
});

test('failed AI authoring is retained for diagnosis and cannot register',t=>{
  const f=fixture(t),draft=prepareCandidateAuthoring(f.db,'p',f.base,f.baseId,'test failure','broken-candidate');
  f.db.prepare(`INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('failed-task','flow','work','g','executor','FAILED')`).run();
  attachAuthoringTask(f.db,draft.id,'failed-task');reconcileCandidateAuthoring(f.db,f.home);
  const result=candidateAuthoringRows(f.db,'p')[0]!;assert.equal(result.status,'failed');assert.match(result.error!,/FAILED/);
  assert.equal(packCandidates(f.db).length,0);
});
