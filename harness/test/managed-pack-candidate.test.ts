import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { approveCandidateTrial, approvedCandidateTrial, candidateTrials, disableCandidateTrial, packCandidates, packContributionDecision, packTreeHash, recordPackEvaluation, registerPackCandidate, type CaseResult } from '../src/managed-pack-candidate.ts';
import { chooseSharing } from '../src/sharing/state.ts';
import { authorizeContribution } from '../src/contribution-queue.ts';
import { openDatabase, SCHEMA_VERSION } from '../src/state/db.ts';
import { evaluatePackCandidate } from '../src/managed-pack-evaluator.ts';
import { posixPath, removeTemp } from './fixtures/platform.ts';

function fixture(t: test.TestContext) {
  const root=mkdtempSync(join(tmpdir(),'avh-candidate-'));t.after(()=>removeTemp(root));
  const home=join(root,'home'),source=join(root,'source');
  cpSync(new URL('../builtin/',import.meta.url),source,{recursive:true});
  const manifest=JSON.parse(readFileSync(join(source,'pack.json'),'utf8')) as Record<string,unknown>;
  Object.assign(manifest,{id:'candidate-fit-v2',version:'0.2.0-candidate.1',channel:'candidate'});
  writeFileSync(join(source,'pack.json'),JSON.stringify(manifest));
  const db=openDatabase(join(root,'state.db'));t.after(()=>db.close());
  return{root,home,source,db};
}

test('current schema stores immutable candidate packs separately from active packs',t=>{
  const f=fixture(t);assert.equal(SCHEMA_VERSION,38);
  const candidate=registerPackCandidate(f.db,f.home,f.source,{basePackId:'builtin-linux-rc5',sourceKind:'ai',sourceRef:'run-123',
    reason:'tighten footwear geometry handling',impact:{stages:['regression']},permissions:{network:false,writes:['run']}});
  assert.equal(candidate.status,'generated');assert.equal(candidate.sourceKind,'ai');assert.equal(candidate.contentHash.length,64);
  const audit=candidate.impact.authorityAudit as {profiles:string[];commands:number;tools:string[];executables:string[];network:boolean;writeScope:string};
  assert.deepEqual(audit.profiles,['pc-recolor-outfit']);assert.ok(audit.commands>0);assert.ok(audit.tools.includes('harness/intake.py'));
  assert.deepEqual(audit.executables,['python3']);assert.equal(audit.network,false);assert.equal(audit.writeScope,'project-and-run');
  assert.match(posixPath(candidate.root), /managed\/candidates\/candidate-fit-v2$/);
  assert.deepEqual(packCandidates(f.db).map(item=>item.id),['candidate-fit-v2']);
  assert.equal(packTreeHash(candidate.root).hash,candidate.contentHash);
  writeFileSync(join(f.source,'pack.json'),readFileSync(join(f.source,'pack.json'),'utf8')+'\n');
  assert.throws(()=>registerPackCandidate(f.db,f.home,f.source,{basePackId:'builtin-linux-rc5',sourceKind:'ai',reason:'changed',impact:{},permissions:{}}),
    /already names different content/);
});

test('candidate registration audits declared authority and every executable before storage',t=>{
  const unknown=fixture(t);
  assert.throws(()=>registerPackCandidate(unknown.db,unknown.home,unknown.source,{basePackId:'builtin-linux-rc5',sourceKind:'ai',reason:'unsafe',impact:{},
    permissions:{network:false,writes:['project'],secretAccess:true}}),/unknown permissions: secretAccess/);
  const executable=fixture(t),path=join(executable.source,'knowledge/process/pc-recolor-outfit.capabilities.yaml');
  writeFileSync(path,readFileSync(path,'utf8').replace('command: [python3, "{toolRoot}/harness/intake.py"','command: [curl, "{toolRoot}/harness/intake.py"'));
  assert.throws(()=>registerPackCandidate(executable.db,executable.home,executable.source,{basePackId:'builtin-linux-rc5',sourceKind:'ai',reason:'unsafe',impact:{},permissions:{}}),
    /executable is not allowed: curl/);
});

function passingEvaluation(f:ReturnType<typeof fixture>):void {
  recordPackEvaluation(f.db,'candidate-fit-v2',{suiteId:'fit',suiteVersion:'1',isolation:'bwrap',baselineResults:[
    {caseId:'shoe',modelFamily:'codex',attempt:1,result:'pass',evidenceRef:'baseline.json'}],results:[
    {caseId:'shoe',modelFamily:'codex',attempt:1,result:'pass',evidenceRef:'candidate.json'}]});
}

test('local trial is evaluated, project-scoped, hash-pinned and reversible without promotion',t=>{
  const f=fixture(t);registerPackCandidate(f.db,f.home,f.source,{basePackId:'builtin-linux-rc5',sourceKind:'ai',reason:'trial',impact:{},permissions:{network:false,writes:['project','run']}});
  f.db.exec("INSERT INTO workspace(id,path) VALUES('ws','/workspace'); INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('p1','ws','sample','/workspace/one','{}','active','h','k'),('p2','ws','sample','/workspace/two','{}','active','h','k')");
  assert.throws(()=>approveCandidateTrial(f.db,'p1','candidate-fit-v2','tester'),/complete isolated evaluation/);
  passingEvaluation(f);
  const trial=approveCandidateTrial(f.db,'p1','candidate-fit-v2','tester');
  assert.equal(trial.projectId,'p1');assert.equal(trial.status,'approved');assert.equal(trial.restrictions.globalDefault,false);
  assert.deepEqual(candidateTrials(f.db,'p2'),[],'approval never propagates to another project');
  disableCandidateTrial(f.db,trial.id);assert.equal(candidateTrials(f.db,'p1')[0]!.status,'disabled');
  assert.equal(packCandidates(f.db)[0]!.status,'evaluated','local trial never promotes the candidate');
});

test('candidate registration rejects broader authority before evaluation or local trial',t=>{
  const f=fixture(t);assert.throws(()=>registerPackCandidate(f.db,f.home,f.source,
    {basePackId:'builtin-linux-rc5',sourceKind:'ai',reason:'unsafe',impact:{},permissions:{network:true}}),
    /permission audit rejects network access/);
  assert.equal(packCandidates(f.db).length,0);
});

test('candidate evaluation requires evidence and computes first-pass and all-attempt rates by model family',t=>{
  const f=fixture(t);registerPackCandidate(f.db,f.home,f.source,{basePackId:'builtin-linux-rc5',sourceKind:'distill',reason:'candidate',impact:{},permissions:{}});
  assert.throws(()=>recordPackEvaluation(f.db,'candidate-fit-v2',{suiteId:'fit',suiteVersion:'1',isolation:'bwrap',baselineResults:[],results:[]}),/requires baseline/);
  const baselineResults=[
    {caseId:'positive',modelFamily:'codex',attempt:1,result:'pass' as const,evidenceRef:'base/codex-positive.json'},
    {caseId:'negative',modelFamily:'codex',attempt:1,result:'fail' as const,evidenceRef:'base/codex-negative-1.json'},
    {caseId:'negative',modelFamily:'codex',attempt:2,result:'pass' as const,evidenceRef:'base/codex-negative-2.json'},
    {caseId:'positive',modelFamily:'claude',attempt:1,result:'pass' as const,evidenceRef:'base/claude-positive.json'},
  ];
  const evaluation=recordPackEvaluation(f.db,'candidate-fit-v2',{suiteId:'fit',suiteVersion:'1',isolation:'bwrap',results:[
    {caseId:'positive',modelFamily:'codex',attempt:1,result:'pass',evidenceRef:'run/codex-positive.json'},
    {caseId:'negative',modelFamily:'codex',attempt:1,result:'fail',evidenceRef:'run/codex-negative-1.json'},
    {caseId:'negative',modelFamily:'codex',attempt:2,result:'pass',evidenceRef:'run/codex-negative-2.json'},
    {caseId:'positive',modelFamily:'claude',attempt:1,result:'pass',evidenceRef:'run/claude-positive.json'},
  ],baselineResults});
  assert.equal(evaluation.status,'passed');
  assert.deepEqual((evaluation.summary.candidate as Record<string,unknown>),{cases:2,modelFamilies:2,attempts:4,passes:3,passRate:.75,firstPassRate:2/3,secondPassRate:1,
    byFamily:{claude:{cases:1,firstPassRate:1,secondPassRate:1},codex:{cases:2,firstPassRate:.5,secondPassRate:1}}});
  assert.equal(packCandidates(f.db)[0]!.status,'evaluated');
  assert.deepEqual(packContributionDecision(f.db,'candidate-fit-v2',{minimumModelFamilies:2,minimumFirstPassRate:.6,minimumSecondPassRate:1,allowFamilyRegression:false}).reasons,[]);
  assert.equal(packCandidates(f.db)[0]!.status,'evaluated','local qualification never promotes or installs the candidate');
});

test('Harness runs baseline and candidate commands itself and owns isolated evidence',async t=>{
  // The baseline is the real bundled pack, installed under its own id.
  const bundledId=(JSON.parse(readFileSync(new URL('../builtin/pack.json',import.meta.url),'utf8')) as {id:string}).id;
  const f=fixture(t),baseline=join(f.home,'managed/packs',bundledId),suite=join(f.root,'suite');
  mkdirSync(join(f.home,'managed/packs'),{recursive:true});cpSync(new URL('../builtin/',import.meta.url),baseline,{recursive:true});
  registerPackCandidate(f.db,f.home,f.source,{basePackId:bundledId,sourceKind:'ai',reason:'evaluate',impact:{},permissions:{}});
  mkdirSync(suite);const checker=join(suite,'check.mjs');
  writeFileSync(checker,`const subject=process.argv[2],attempt=Number(process.argv[3]);\nconst result=subject==='candidate'&&attempt===1?'fail':'pass';\nconsole.log(JSON.stringify({result}));process.exitCode=result==='pass'?0:1;\n`);
  writeFileSync(join(suite,'suite.json'),JSON.stringify({schema:'harness-pack-evaluation/0.1',id:'automatic',version:'1',cases:[
    {id:'case-1',modelFamily:'fixture-family',attempts:2,timeoutMs:5000,command:[process.execPath,checker,'{subject}','{attempt}']}]}));
  const evaluation=await evaluatePackCandidate(f.db,f.home,'candidate-fit-v2',suite,{allowProcessFallback:true});
  assert.equal(evaluation.status,'passed');
  const summary=evaluation.summary as {baseline:{firstPassRate:number};candidate:{firstPassRate:number;secondPassRate:number}};
  assert.equal(summary.baseline.firstPassRate,1);assert.equal(summary.candidate.firstPassRate,0);assert.equal(summary.candidate.secondPassRate,1);
  const evidence=f.db.prepare("SELECT evidence_ref FROM managed_pack_case_result WHERE subject='candidate' ORDER BY attempt").all() as Array<{evidence_ref:string}>;
  assert.equal(evidence.length,2);assert.ok(evidence.every(row=>existsSync(join(f.home,row.evidence_ref))));
});

test('equal totals and equal global case identities cannot hide different family case coverage',t=>{
  const f=fixture(t);registerPackCandidate(f.db,f.home,f.source,{basePackId:'builtin-linux-rc5',sourceKind:'human',reason:'compare actual cases',impact:{},permissions:{}});
  f.db.exec("INSERT INTO workspace(id,path) VALUES('ws','/workspace'); INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('p','ws','sample','/workspace/p','{}','active','h','k')");
  const result=(caseId:string,modelFamily:string,attempt=1):CaseResult=>({caseId,modelFamily,attempt,result:'pass',evidenceRef:`${modelFamily}/${caseId}/${attempt}.json`});
  const baseline=[result('shoe','family-a'),result('coat','family-a'),result('shoe','family-b'),result('hair','family-b')];
  const different=[result('hair','family-a'),result('shoe','family-a'),result('coat','family-b'),result('shoe','family-b')];
  const mismatch=recordPackEvaluation(f.db,'candidate-fit-v2',{suiteId:'fit',suiteVersion:'1',isolation:'process',baselineResults:baseline,results:different});
  assert.equal(mismatch.status,'failed');assert.equal(mismatch.summary.sameCoverage,false);
  assert.equal((mismatch.summary.candidate as {cases:number}).cases,(mismatch.summary.baseline as {cases:number}).cases);
  assert.deepEqual(Object.keys((mismatch.summary.candidate as {byFamily:object}).byFamily),Object.keys((mismatch.summary.baseline as {byFamily:object}).byFamily));
  assert.throws(()=>approveCandidateTrial(f.db,'p','candidate-fit-v2','tester'),/same coverage/);
  const policy={minimumModelFamilies:2,minimumFirstPassRate:.8,minimumSecondPassRate:.95,allowFamilyRegression:false};
  const decision=packContributionDecision(f.db,'candidate-fit-v2',policy);
  assert.equal(decision.eligible,false);assert.ok(decision.reasons.includes('基线与候选的案例或模型家族覆盖不同'));
  chooseSharing(f.db,{surface:'gui',noticeShown:true,enabled:true},f.home);
  assert.equal(authorizeContribution(f.db,f.home,'candidate-fit-v2','tester','Report this failed observation').status,'authorized');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM managed_pack_contribution').get()!.n,1);
  // The same exact identities remain comparable even when ordering and retry counts differ.
  const matching=recordPackEvaluation(f.db,'candidate-fit-v2',{suiteId:'fit',suiteVersion:'1',isolation:'process',baselineResults:baseline,
    results:[...baseline.slice().reverse(),result('coat','family-a',2)]});
  f.db.prepare("UPDATE managed_pack_evaluation SET started_at='2099-01-01T00:00:00Z' WHERE id=?").run(matching.id);
  assert.equal(matching.status,'passed');assert.equal(matching.summary.sameCoverage,true);
  assert.equal(packContributionDecision(f.db,'candidate-fit-v2',policy).eligible,true);
  const trial=approveCandidateTrial(f.db,'p','candidate-fit-v2','tester');
  assert.equal(approvedCandidateTrial(f.db,'p','candidate-fit-v2').id,trial.id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM managed_pack_evaluation').get()!.n,2,'the failed evaluation remains available');
  assert.equal(f.db.prepare('SELECT summary_json FROM managed_pack_evaluation WHERE id=?').get(mismatch.id)!.summary_json,JSON.stringify(mismatch.summary));
});

test('legacy passed count-only summaries are rechecked at new adoption and contribution without rewriting history',t=>{
  const f=fixture(t);const candidate=registerPackCandidate(f.db,f.home,f.source,{basePackId:'builtin-linux-rc5',sourceKind:'import',reason:'old comparison evidence',impact:{},permissions:{}});
  f.db.exec("INSERT INTO workspace(id,path) VALUES('ws','/workspace'); INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('p','ws','sample','/workspace/p','{}','active','h','k')");
  const result=(caseId:string,modelFamily:string):CaseResult=>({caseId,modelFamily,attempt:1,result:'pass',evidenceRef:`${modelFamily}/${caseId}.json`});
  const evaluation=recordPackEvaluation(f.db,'candidate-fit-v2',{suiteId:'old-suite',suiteVersion:'1',isolation:'process',
    baselineResults:[result('geometry','family-a'),result('geometry','family-b')],
    results:[result('recolor','family-a'),result('recolor','family-b')]});
  // Reproduce the retained data written by the previous implementation, including its incorrect summary.
  const legacySummary=JSON.stringify({...evaluation.summary,sameCoverage:true});
  f.db.prepare("UPDATE managed_pack_evaluation SET status='passed',summary_json=? WHERE id=?").run(legacySummary,evaluation.id);
  f.db.prepare(`INSERT INTO managed_pack_trial(id,candidate_id,project_id,content_hash,mode,status,restrictions_json,approved_by)
    VALUES('historic-trial','candidate-fit-v2','p',?,'project','approved','{}','tester')`).run(candidate.contentHash);
  const rowsBefore=f.db.prepare('SELECT * FROM managed_pack_case_result WHERE evaluation_id=? ORDER BY subject,model_family').all(evaluation.id);
  assert.throws(()=>approveCandidateTrial(f.db,'p','candidate-fit-v2','tester'),/same coverage/);
  assert.throws(()=>approvedCandidateTrial(f.db,'p','candidate-fit-v2'),/same coverage/,'an old approved trial cannot admit a new Workflow from an invalid comparison');
  const decision=packContributionDecision(f.db,'candidate-fit-v2',{minimumModelFamilies:2,minimumFirstPassRate:.8,minimumSecondPassRate:.95,allowFamilyRegression:false});
  assert.equal(decision.eligible,false);assert.equal(decision.summary!.sameCoverage,false);
  assert.deepEqual(decision.reasons,['基线与候选的案例或模型家族覆盖不同']);
  chooseSharing(f.db,{surface:'gui',noticeShown:true,enabled:true},f.home);
  assert.equal(authorizeContribution(f.db,f.home,'candidate-fit-v2','tester','Report historic actual outcomes').status,'authorized');
  assert.equal(f.db.prepare('SELECT summary_json FROM managed_pack_evaluation WHERE id=?').get(evaluation.id)!.summary_json,legacySummary);
  assert.equal(f.db.prepare('SELECT status FROM managed_pack_evaluation WHERE id=?').get(evaluation.id)!.status,'passed');
  assert.equal(f.db.prepare("SELECT status FROM managed_pack_trial WHERE id='historic-trial'").get()!.status,'approved','historic trial receipts are not rewritten or automatically cancelled');
  assert.deepEqual(f.db.prepare('SELECT * FROM managed_pack_case_result WHERE evaluation_id=? ORDER BY subject,model_family').all(evaluation.id),rowsBefore);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM managed_pack_contribution').get()!.n,1);
});

test('status=passed says the evaluation is usable, not that the candidate passed: zero passes is still passed',t=>{
  const f=fixture(t);registerPackCandidate(f.db,f.home,f.source,{basePackId:'builtin-linux-rc5',sourceKind:'distill',reason:'score semantics',impact:{},permissions:{}});
  const caseResult=(caseId:string,modelFamily:string,result:CaseResult['result']):CaseResult=>({caseId,modelFamily,attempt:1,result,evidenceRef:`${modelFamily}/${caseId}.json`});
  // Every candidate case fails, none of them errored, and both sides cover the same cases: the run is usable evidence.
  const failedAll=recordPackEvaluation(f.db,'candidate-fit-v2',{suiteId:'semantics',suiteVersion:'1',isolation:'process',
    baselineResults:[caseResult('recolor','family-a','pass'),caseResult('geometry','family-a','pass')],
    results:[caseResult('recolor','family-a','fail'),caseResult('geometry','family-a','fail')]});
  assert.equal(failedAll.status,'passed','a usable run of a candidate that failed every case is not a failed run');
  assert.equal((failedAll.summary.candidate as {passes:number}).passes,0);
  assert.equal((failedAll.summary.candidate as {passes:number;passRate:number}).passRate,0);
  assert.equal(failedAll.summary.sameCoverage,true);
  // The score is what carries "the candidate did not pass", and the policy gates on the score, not on `status`.
  const decision=packContributionDecision(f.db,'candidate-fit-v2',{minimumModelFamilies:1,minimumFirstPassRate:.8,minimumSecondPassRate:.95,allowFamilyRegression:false});
  assert.equal(decision.eligible,false);
  assert.ok(decision.reasons.includes('一次通过率低于晋升阈值'));
  // A run that cannot be used is the one that records `failed`: a case that errored, with the same coverage.
  const errored=recordPackEvaluation(f.db,'candidate-fit-v2',{suiteId:'semantics',suiteVersion:'1',isolation:'process',
    baselineResults:[caseResult('recolor','family-a','pass')],results:[caseResult('recolor','family-a','error')]});
  assert.equal(errored.status,'failed');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM managed_pack_evaluation').get()!.n,2,'the usable run stays on record either way');
});
