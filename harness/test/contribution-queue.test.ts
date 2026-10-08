import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeContribution, contributionRows, markContributionExported, pruneContributionQueue, submitContribution, verifyContributionReady } from '../src/contribution-queue.ts';
import { packTreeHash, recordPackEvaluation, registerPackCandidate } from '../src/managed-pack-candidate.ts';
import { openDatabase } from '../src/state/db.ts';
import { chooseSharing, pruneSharingQueue, queueSharingRecord, sharingState } from '../src/sharing/state.ts';
import { flushSharing, revokeSharing } from '../src/sharing/client.ts';
import { candidateReportDecision } from '../src/sharing/candidate-report.ts';
import { createHash, randomUUID } from 'node:crypto';
import { MAX_QUEUED_CONTRIBUTIONS, MAX_QUEUED_RECORDS, SHARING_NOTICE_VERSION } from '../src/shared/sharing.ts';
import { removeTemp } from './fixtures/platform.ts';

function fixture(t:test.TestContext,joinSharing=true){
  const root=mkdtempSync(join(tmpdir(),'avh-contribution-')),home=join(root,'home'),source=join(root,'source');
  t.after(()=>removeTemp(root));cpSync(new URL('../builtin/',import.meta.url),source,{recursive:true});
  const manifest=JSON.parse(readFileSync(join(source,'pack.json'),'utf8')) as Record<string,unknown>,base=String(manifest.id);
  Object.assign(manifest,{id:'safe-candidate',version:'1-candidate',channel:'candidate'});writeFileSync(join(source,'pack.json'),JSON.stringify(manifest));
  const db=openDatabase(join(root,'state.db'));t.after(()=>db.close());
  registerPackCandidate(db,home,source,{basePackId:base,sourceKind:'ai',sourceRef:'private-project-run',reason:'private customer details',
    impact:{projectId:'private-project',stages:['outfit']},permissions:{network:false,writes:['project','run']}});
  if(joinSharing)chooseSharing(db,{surface:'gui',noticeShown:true,enabled:true},home);
  return{root,home,source,db};
}
function qualify(f:ReturnType<typeof fixture>):void{
  const results=['codex','claude'].flatMap(modelFamily=>[{caseId:'shoe',modelFamily,attempt:1,result:'pass' as const,evidenceRef:`/private/${modelFamily}`}]);
  recordPackEvaluation(f.db,'safe-candidate',{suiteId:'fit',suiteVersion:'1',isolation:'bwrap',baselineResults:results,results});
}

test('contribution requires explicit consent and completed observation, then projects only a structured report',t=>{
  const f=fixture(t);
  assert.throws(()=>authorizeContribution(f.db,f.home,'safe-candidate','user','yes'),/not eligible/);
  qualify(f);assert.throws(()=>authorizeContribution(f.db,f.home,'safe-candidate','user',''),/explicit actor and consent/);
  const item=authorizeContribution(f.db,f.home,'safe-candidate','user','I authorize redacted contribution');
  assert.equal(item.status,'authorized');assert.equal(item.payloadHash.length,64);
  const text=readFileSync(join(item.bundlePath,'contribution.json'),'utf8'),manifest=JSON.parse(text) as {candidate:{id:string}};
  assert.equal(manifest.candidate.id,item.id);
  assert.deepEqual(readdirSync(join(item.bundlePath,'pack')),['candidate-report.json']);
  for(const secret of ['private-project','private customer details','private-project-run','/private/'])assert.doesNotMatch(text,new RegExp(secret));
  assert.notEqual(packTreeHash(join(item.bundlePath,'pack')).hash,packTreeHash(f.source).hash);
  const report=readFileSync(join(item.bundlePath,'pack','candidate-report.json'),'utf8');
  for(const secret of ['private-project','private customer','/private/','safe-candidate','codex','claude'])assert.ok(!report.includes(secret));
  assert.equal(authorizeContribution(f.db,f.home,'safe-candidate','user','again').id,item.id,'authorization is idempotent per evaluation');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM managed_pack_release').get() as {n:number}).n,0);
  assert.equal(markContributionExported(f.db,item.id).status,'exported');assert.equal(markContributionExported(f.db,item.id).status,'exported');
});

test('contribution queue starts empty and cannot export an unknown bundle',t=>{
  const f=fixture(t);assert.deepEqual(contributionRows(f.db),[]);assert.throws(()=>markContributionExported(f.db,'missing'),/not found/);
});

test('authorized contribution reaches submitted only with a matching server receipt',async t=>{
  const f=fixture(t);qualify(f);const item=authorizeContribution(f.db,f.home,'safe-candidate','user','upload');
  const receipt={schema:'harness-contribution-receipt/0.1',candidateId:item.id,payloadHash:item.payloadHash,status:'accepted',receiptId:'server-42'};
  const submitted=await submitContribution(f.db,item.id,{endpoint:'https://updates.example/contributions',token:'secret',username:' 喵 '},async(_url,init)=>{
    assert.equal((init?.headers as Record<string,string>).authorization,'Bearer secret');
    const upload=JSON.parse(String(init?.body)) as {schema:string;payloadHash:string;username:string;files:Array<{path:string;bytes:string}>};
    assert.equal(upload.schema,'harness-contribution-upload/0.1');assert.equal(upload.payloadHash,item.payloadHash);assert.equal(upload.username,'','local optional name is not included in the report purpose');
    assert.ok(upload.files.some(file=>file.path==='contribution.json'));assert.ok(upload.files.some(file=>file.path==='pack/candidate-report.json'));
    return Response.json(receipt);
  });
  assert.equal(submitted.status,'submitted');assert.equal(submitted.receipt?.receiptId,'server-42');assert.ok(submitted.submittedAt);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM managed_pack_release').get() as {n:number}).n,0,'server acceptance never promotes locally');
});

test('mismatched upstream receipt is recorded as a retryable failure',async t=>{
  const f=fixture(t);qualify(f);const item=authorizeContribution(f.db,f.home,'safe-candidate','user','upload');
  await assert.rejects(()=>submitContribution(f.db,item.id,{endpoint:'https://updates.example/contributions'},async()=>Response.json({
    schema:'harness-contribution-receipt/0.1',candidateId:'other',payloadHash:item.payloadHash,status:'accepted',receiptId:'bad'})),/does not match/);
  const failed=contributionRows(f.db)[0]!;assert.equal(failed.status,'failed');assert.match(failed.error??'',/does not match/);
});

test('authorized bundle mutation is refused before any network request',async t=>{
  const f=fixture(t);qualify(f);const item=authorizeContribution(f.db,f.home,'safe-candidate','user','upload');
  writeFileSync(join(item.bundlePath,'pack','tampered.txt'),'changed');let called=false;
  assert.throws(()=>markContributionExported(f.db,item.id),/报告之外/);
  await assert.rejects(()=>submitContribution(f.db,item.id,{endpoint:'https://updates.example/contributions'},async()=>{called=true;return new Response();}),/报告之外|changed after authorization/);
  assert.equal(called,false);assert.equal(contributionRows(f.db)[0]!.status,'failed');
});

test('a contribution goes up without a token and with an empty contributor name',async t=>{
  const f=fixture(t);qualify(f);const item=authorizeContribution(f.db,f.home,'safe-candidate','user','upload');
  const receipt={schema:'harness-contribution-receipt/0.1',candidateId:item.id,payloadHash:item.payloadHash,status:'accepted',receiptId:'anon-1'};
  const submitted=await submitContribution(f.db,item.id,{endpoint:'https://updates.example/contributions'},async(_url,init)=>{
    assert.equal((init?.headers as Record<string,string>).authorization,undefined,'no token, no Authorization header');
    assert.equal((JSON.parse(String(init?.body)) as {username:string}).username,'');
    return Response.json(receipt);
  });
  assert.equal(submitted.status,'submitted');
});

test('single-family failed evaluations are reportable without adoption or release',t=>{
  const f=fixture(t),results=[{caseId:'private-case',modelFamily:'deepseek',attempt:1,result:'error' as const,evidenceRef:'/private/failure'}];
  const evaluation=recordPackEvaluation(f.db,'safe-candidate',{suiteId:'single',suiteVersion:'1',isolation:'process',baselineResults:results.map(row=>({...row,result:'pass' as const})),results});
  assert.equal(evaluation.status,'failed');assert.equal(candidateReportDecision(f.db,'safe-candidate').eligible,true);
  const item=authorizeContribution(f.db,f.home,'safe-candidate','user','report failure');
  const report=JSON.parse(readFileSync(join(item.bundlePath,'pack/candidate-report.json'),'utf8'));
  assert.deepEqual(report.evaluation.candidate,{attempts:1,passes:0,failures:1,cases:1,modelFamilies:1,firstPassRate:0,secondPassRate:0});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM managed_pack_release').get()!.n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM managed_pack_trial').get()!.n,0);
});

test('notice alone never opts in; opt-out cancels both queues and deletes every pending status',async t=>{
  const f=fixture(t,false);chooseSharing(f.db,{surface:'gui',noticeShown:true},f.home);
  assert.equal(sharingState(f.db).active,false);assert.equal(sharingState(f.db).enabled,false);
  qualify(f);assert.throws(()=>authorizeContribution(f.db,f.home,'safe-candidate','user','yes'),/开启回传/);
  chooseSharing(f.db,{surface:'gui',enabled:true},f.home);
  for(const status of ['authorized','exported','failed']){
    const item=authorizeContribution(f.db,f.home,'safe-candidate','user','yes');
    f.db.prepare('UPDATE managed_pack_contribution SET status=? WHERE id=?').run(status,item.id);
    queueSharingRecord(f.db,{category:'tool-reliability',action:'provider-run',outcome:'failure'});
    chooseSharing(f.db,{surface:'gui',enabled:false},f.home);
    assert.equal(sharingState(f.db).counts.queued,0);assert.equal(contributionRows(f.db)[0]!.status,'cancelled');assert.equal(existsSync(item.bundlePath),false);
    let requests=0;await assert.rejects(()=>submitContribution(f.db,item.id,{endpoint:'https://unused.test'},async()=>{requests++;return new Response();}),/submit-ready/);
    chooseSharing(f.db,{surface:'gui',enabled:true},f.home);assert.equal(contributionRows(f.db)[0]!.status,'cancelled');assert.equal(requests,0);
    const renewed=authorizeContribution(f.db,f.home,'safe-candidate','user','new authorization');assert.equal(renewed.id,item.id);assert.notEqual(renewed.payloadHash,item.payloadHash);
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE action='contribution_authorized'").get()!.n,4);
});

test('revoke without an installation still removes both local queues',async t=>{
  const f=fixture(t);qualify(f);const item=authorizeContribution(f.db,f.home,'safe-candidate','user','yes');
  queueSharingRecord(f.db,{category:'tool-reliability',action:'provider-run',outcome:'success'});
  let calls=0;await revokeSharing(f.db,f.home,async()=>{calls++;return new Response();});
  assert.equal(calls,0);assert.equal(sharingState(f.db).active,false);assert.equal(sharingState(f.db).counts.queued,0);
  assert.equal(contributionRows(f.db)[0]!.status,'cancelled');assert.equal(existsSync(item.bundlePath),false);
});

test('matching hashes cannot authorize unknown private fields',async t=>{
  const f=fixture(t);qualify(f);const item=authorizeContribution(f.db,f.home,'safe-candidate','user','yes');
  const path=join(item.bundlePath,'pack/candidate-report.json'),report=JSON.parse(readFileSync(path,'utf8'));report.privatePrompt='private customer';writeFileSync(path,JSON.stringify(report));
  const manifestPath=join(item.bundlePath,'contribution.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  manifest.candidate.contentHash=packTreeHash(join(item.bundlePath,'pack')).hash;const bytes=JSON.stringify(manifest);writeFileSync(manifestPath,bytes);
  f.db.prepare('UPDATE managed_pack_contribution SET payload_hash=? WHERE id=?').run(createHash('sha256').update(bytes).update(manifest.candidate.contentHash).digest('hex'),item.id);
  assert.throws(()=>markContributionExported(f.db,item.id),/outside its authorized projection/);
  let calls=0;await assert.rejects(()=>submitContribution(f.db,item.id,{endpoint:'https://unused.test'},async()=>{calls++;return new Response();}),/outside its authorized projection/);assert.equal(calls,0);
});

test('failed cleanup revokes authorization without deleting unrelated files',async t=>{
  const f=fixture(t);qualify(f);const item=authorizeContribution(f.db,f.home,'safe-candidate','user','yes'),sentinel=join(f.root,'sentinel.txt');writeFileSync(sentinel,'keep');
  f.db.prepare('UPDATE managed_pack_contribution SET bundle_path=? WHERE id=?').run(f.root,item.id);
  assert.throws(()=>chooseSharing(f.db,{surface:'gui',enabled:false},f.home),/旧授权已撤销/);
  assert.equal(readFileSync(sentinel,'utf8'),'keep');assert.equal(contributionRows(f.db)[0]!.status,'cancelled');
  chooseSharing(f.db,{surface:'gui',enabled:true},f.home);assert.throws(()=>authorizeContribution(f.db,f.home,'safe-candidate','user','again'),/清理未完成/);
  await assert.rejects(()=>submitContribution(f.db,item.id,{endpoint:'https://unused.test'}),/submit-ready|清理未完成/);
});

test('a late receipt after opt-out cannot reopen a cancelled contribution',async t=>{
  const f=fixture(t);qualify(f);const item=authorizeContribution(f.db,f.home,'safe-candidate','user','yes');
  await assert.rejects(()=>submitContribution(f.db,item.id,{endpoint:'https://unused.test'},async()=>{chooseSharing(f.db,{surface:'gui',enabled:false},f.home);
    return Response.json({schema:'harness-contribution-receipt/0.1',candidateId:item.id,payloadHash:item.payloadHash,status:'accepted',receiptId:'late'});}),/授权已撤销/);
  const result=contributionRows(f.db)[0]!;assert.equal(result.status,'cancelled');assert.equal(result.receipt,null);assert.equal(existsSync(item.bundlePath),false);
});


test('the current notice version requires a new explicit choice across GUI, TUI and CLI; the previous version is stale',t=>{
 for(const surface of ['gui','tui','cli'] as const){
  const db=openDatabase(':memory:');try{
   db.prepare("INSERT INTO sharing_consent(action,notice_version,surface) VALUES('notice_shown',?,?)").run(SHARING_NOTICE_VERSION-1,surface);
   db.prepare("INSERT INTO sharing_consent(action,notice_version,surface) VALUES('disabled',NULL,?)").run(surface);
   db.prepare("INSERT INTO sharing_consent(action,notice_version,surface) VALUES('enabled',NULL,?)").run(surface);
   assert.equal(sharingState(db).active,false);assert.equal(sharingState(db).needsNotice,true);
   chooseSharing(db,{surface,noticeShown:true});assert.equal(sharingState(db).active,false,'notice alone cannot reuse the old on authorization');
   assert.equal(queueSharingRecord(db,{category:'tool-reliability',action:'provider-run',outcome:'success'}).queued,false);
   chooseSharing(db,{surface,enabled:true});assert.equal(sharingState(db).active,true);assert.equal(sharingState(db).noticeVersion,SHARING_NOTICE_VERSION);
   assert.deepEqual(db.prepare('SELECT action,notice_version FROM sharing_consent ORDER BY seq').all().map(row=>[row.action,row.notice_version]),[['notice_shown',SHARING_NOTICE_VERSION-1],['disabled',null],['enabled',null],['notice_shown',SHARING_NOTICE_VERSION],['enabled',SHARING_NOTICE_VERSION]]);
  }finally{db.close();}
 }
});


test('a revised explicit join cannot harvest a pending batch left by old default-on sharing',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());db.exec("INSERT INTO sharing_consent(action,notice_version,surface) VALUES('notice_shown',1,'gui'),('enabled',NULL,'gui')");
 const record=(id:string)=>JSON.stringify({id,category:'tool-reliability',action:'provider-run',outcome:'failure'});
 for(const [id,status,batch]of [['a'.repeat(32),'queued','f'.repeat(32)],['b'.repeat(32),'queued',null],['c'.repeat(32),'sent',null]])db.prepare('INSERT INTO sharing_record(id,category,record_json,status,batch_id) VALUES(?,?,?,?,?)').run(id,'tool-reliability',record(id!),status!,batch);
 assert.equal(sharingState(db).active,false);chooseSharing(db,{surface:'gui',noticeShown:true});assert.equal(sharingState(db).counts.queued,2);
 chooseSharing(db,{surface:'gui',enabled:true});assert.equal(sharingState(db).active,true);assert.equal(sharingState(db).counts.queued,0);assert.equal(sharingState(db).counts.sent,1,'sent history is retained');
 const detail=JSON.parse(String(db.prepare("SELECT detail_json FROM sharing_consent WHERE action='enabled' ORDER BY seq DESC LIMIT 1").get()!.detail_json));assert.equal(detail.discardedBeforeJoin,2);
 assert.equal(queueSharingRecord(db,{category:'tool-reliability',action:'provider-run',outcome:'failure'}).queued,true,'only newly observed records enter the current consent period');
});

test('all unsent report states expire before upload; renewed consent gets a new lifetime and submitted history remains',async t=>{
 const f=fixture(t);qualify(f);
 for(const status of ['authorized','exported','failed']){
  const item=authorizeContribution(f.db,f.home,'safe-candidate','user','new explicit report consent');
  f.db.prepare("UPDATE managed_pack_contribution SET status=?,created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(status,item.id);
  let requests=0;await assert.rejects(()=>submitContribution(f.db,item.id,{endpoint:'https://unused.test',home:f.home},async()=>{requests++;return new Response();}),/submit-ready/);
  assert.equal(requests,0);assert.equal(contributionRows(f.db)[0]!.status,'cancelled');assert.equal(existsSync(item.bundlePath),false);
  assert.throws(()=>verifyContributionReady(f.db,item.id,f.home),/submit-ready/);
 }
 const renewed=authorizeContribution(f.db,f.home,'safe-candidate','user','fresh authorization');
 assert.ok(new Date(renewed.createdAt).getTime()>Date.now()-60_000);assert.equal(verifyContributionReady(f.db,renewed.id,f.home).status,'authorized');
 f.db.prepare("UPDATE managed_pack_contribution SET status='submitted',created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(renewed.id);
 pruneContributionQueue(f.db,f.home);assert.equal(contributionRows(f.db)[0]!.status,'submitted');assert.equal(existsSync(renewed.bundlePath),true);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE action='contribution_queue_pruned'").get()!.n,3);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM managed_pack_candidate').get()!.n,1,'candidate/source成果 are retained');
});

test('report capacity cancels only the oldest unsent payload and leaves auditable rows',t=>{
 const f=fixture(t);qualify(f);const first=authorizeContribution(f.db,f.home,'safe-candidate','user','report');
 f.db.prepare("UPDATE managed_pack_contribution SET created_at=datetime('now','-1 day') WHERE id=?").run(first.id);
 for(let index=0;index<MAX_QUEUED_CONTRIBUTIONS;index++){
  const id=randomUUID(),evaluationId=randomUUID(),path=join(f.home,'contributions',id);mkdirSync(path);writeFileSync(join(path,'synthetic-payload'),'queue fixture');
  f.db.prepare("INSERT INTO managed_pack_evaluation(id,candidate_id,suite_id,suite_version,isolation,status) VALUES(?,'safe-candidate','capacity','1','process','failed')").run(evaluationId);
  f.db.prepare("INSERT INTO managed_pack_contribution(id,candidate_id,evaluation_id,payload_hash,bundle_path,authorized_by,consent_text) VALUES(?,'safe-candidate',?,?,?,'fixture','synthetic queue')")
   .run(id,evaluationId,createHash('sha256').update(id).digest('hex'),path);
 }
 pruneContributionQueue(f.db,f.home);const rows=contributionRows(f.db);
 assert.equal(rows.filter(item=>item.status==='authorized').length,MAX_QUEUED_CONTRIBUTIONS);
 assert.equal(rows.find(item=>item.id===first.id)!.status,'cancelled');assert.equal(existsSync(first.bundlePath),false);
 assert.equal(rows.length,MAX_QUEUED_CONTRIBUTIONS+1);
 assert.equal(f.db.prepare("SELECT reason FROM event WHERE action='contribution_queue_pruned'").get()!.reason,'unsent-report-capacity');
});

test('expired report cleanup refuses an unmanaged path and can never revive its authorization',async t=>{
 const f=fixture(t);qualify(f);const item=authorizeContribution(f.db,f.home,'safe-candidate','user','report'),sentinel=join(f.root,'sentinel.txt');writeFileSync(sentinel,'preserve');
 f.db.prepare("UPDATE managed_pack_contribution SET created_at='2000-01-01T00:00:00.000Z',bundle_path=? WHERE id=?").run(f.root,item.id);
 assert.throws(()=>pruneContributionQueue(f.db,f.home),/清理未完成/);assert.equal(readFileSync(sentinel,'utf8'),'preserve');
 assert.equal(contributionRows(f.db)[0]!.status,'cancelled');assert.ok(contributionRows(f.db)[0]!.error);
 let calls=0;await assert.rejects(()=>submitContribution(f.db,item.id,{endpoint:'https://unused.test',home:f.home},async()=>{calls++;return new Response();}),/清理未完成/);
 assert.equal(calls,0);assert.throws(()=>authorizeContribution(f.db,f.home,'safe-candidate','user','new consent'),/清理未完成/);
});

test('flush prunes old offline records including previously claimed batches before any network request',async t=>{
 const f=fixture(t);queueSharingRecord(f.db,{category:'tool-reliability',action:'provider-run',outcome:'failure'});
 f.db.prepare("UPDATE sharing_record SET created_at='2000-01-01T00:00:00.000Z'").run();
 queueSharingRecord(f.db,{category:'tool-reliability',action:'provider-run',outcome:'success'});
 // Simulate an offline batch that straddles expiry without triggering a new producer's prune first.
 const fresh=String(f.db.prepare('SELECT id FROM sharing_record').get()!.id);
 f.db.prepare("INSERT INTO sharing_record(id,category,record_json,created_at) VALUES(?,'tool-reliability',?,'2000-01-01T00:00:00.000Z')")
  .run('b'.repeat(32),JSON.stringify({id:'b'.repeat(32),category:'tool-reliability',action:'provider-run',outcome:'failure'}));
 f.db.prepare('UPDATE sharing_record SET batch_id=?').run('a'.repeat(32));
 let calls=0;assert.deepEqual(await flushSharing(f.db,f.home,'https://unused.test',async()=>{calls++;return new Response();}),{sent:0,pending:0});
 assert.equal(calls,0);assert.equal(sharingState(f.db).counts.queued,0);assert.equal(sharingState(f.db).active,true);
 assert.equal(f.db.prepare('SELECT id FROM sharing_record WHERE id=?').get(fresh),undefined,'an unconfirmed batch is cancelled intact, never rewritten with the same id');
});

test('the local sharing queue stays bounded and forgets listed records after the 90-day retention',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());chooseSharing(db,{surface:'gui',noticeShown:true,enabled:true});
 const insert=db.prepare("INSERT INTO sharing_record(id,category,record_json,status,created_at,sent_at) VALUES(?,'tool-reliability',?,?,?,?)");
 const record=(id:string)=>JSON.stringify({id,category:'tool-reliability',action:'provider-run',outcome:'failure'});
 const at=new Date(),total=MAX_QUEUED_RECORDS+25,id=(index:number)=>index.toString(16).padStart(32,'0');
 db.exec('BEGIN IMMEDIATE');
 for(let index=0;index<total;index++)insert.run(id(index),record(id(index)),'queued',new Date(at.getTime()-(total-index)*1000).toISOString(),null);
 // One listed record past the retention period, one inside it: only the first goes.
 insert.run('f'.repeat(32),record('f'.repeat(32)),'sent',new Date(at.getTime()-100*86_400_000).toISOString(),new Date(at.getTime()-100*86_400_000).toISOString());
 insert.run('e'.repeat(32),record('e'.repeat(32)),'sent',new Date(at.getTime()-80*86_400_000).toISOString(),new Date(at.getTime()-80*86_400_000).toISOString());
 db.exec('COMMIT');
 pruneSharingQueue(db,at);
 assert.equal(sharingState(db).counts.queued,MAX_QUEUED_RECORDS);
 assert.equal(db.prepare('SELECT 1 FROM sharing_record WHERE id=?').get(id(0)),undefined,'the oldest unsent record goes first');
 assert.equal(db.prepare('SELECT 1 FROM sharing_record WHERE id=?').get(id(24)),undefined);
 assert.ok(db.prepare('SELECT 1 FROM sharing_record WHERE id=?').get(id(25)),'records inside the bound are kept');
 assert.ok(db.prepare('SELECT 1 FROM sharing_record WHERE id=?').get(id(total-1)),'the newest unsent record stays');
 assert.equal(db.prepare('SELECT 1 FROM sharing_record WHERE id=?').get('f'.repeat(32)),undefined,'a listed record is forgotten after the retention period');
 assert.ok(db.prepare('SELECT 1 FROM sharing_record WHERE id=?').get('e'.repeat(32)),'one inside the retention period is still listed');
 // The producer's own path prunes too, so an unattended computer cannot grow the queue without bound.
 const added=queueSharingRecord(db,{category:'tool-reliability',action:'provider-run',outcome:'success'});
 assert.equal(added.queued,true);
 assert.equal(sharingState(db).counts.queued,MAX_QUEUED_RECORDS);
 assert.equal(db.prepare('SELECT 1 FROM sharing_record WHERE id=?').get(id(25)),undefined,'the new record pushed the oldest one out');
 if(added.queued)assert.ok(db.prepare('SELECT 1 FROM sharing_record WHERE id=?').get(added.id),'the newly observed record is queued');
});
