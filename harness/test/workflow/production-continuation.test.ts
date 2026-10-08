import {stageContractView,selectStageContract} from '../../src/workflow/stage-contract.ts';
import { activateFaceInput as activateProduction, productionHead, advanceProductionContinuations, controlContinuation, revalidateProductionArchive, continuationProgress, copyProductionManifest, idleOnCadence } from '../../src/production-face-continuation.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/state/db.ts';
import { buildAggregateInput, aggregateWorkflow } from '../../src/state/aggregate-input.ts';
import { serveOnce, TaskRouter, taskRedo } from '../../src/task-cli.ts';
import { createWorkflow, workflowSnapshot, workflowScheduler, StageRouter, formalGates, decideFormalGate } from '../../src/workflow/runtime.ts';
import { activateFaceInput, readRunInputSnapshot } from '../../src/workflow/inputs.ts';
import type { RunSpec, RunHandle, RunResult } from '../../src/runtime/interfaces.ts';
import { removeTemp } from '../fixtures/platform.ts';
import { Scheduler } from '../../src/runtime/scheduler.ts';
import { RuntimeService } from '../../src/api/server.ts';
import { ApiClient } from '../../src/api/client.ts';
import { withStateEvent } from '../../src/state/tx.ts';
import { SchedulerLeaseLostError } from '../../src/state/scheduler-lease.ts';
import { projectState } from '../../src/project-state.ts';
import {resolveRebuildChanges,continuationContractView,adoptContinuationContract} from '../../src/production-face-rebuild.ts';
import {projectSafePoint} from '../../src/archive/projection.ts';
import {productionInputDocument,restoreProductionInputs} from '../../src/archive/production.ts';
import {sha256File} from '../../src/file-hash.ts';
import {exportShare} from '../../src/archive/share.ts';
import {restoreShare,completeRestore,restoreReconciliation} from '../../src/archive/restore.ts';
import {registerEntries} from '../../src/archive/registry.ts';
import {has7z} from '../fixtures/share.ts';
import { projectRowsForWorkflow } from '../../gui/src/model.ts';

function seedSelectedContract(f:ReturnType<typeof fixture>) {
  return withStateEvent(f.db,{workflowId:f.id,actor:'human',entityType:'stage_contract',entityId:'face',action:'selected',reason:'Synthetic approved stage contract',
    payload:{selection:{snapshot:f.snapshot,deployment:[]}}},()=>{});
}

const syntheticSetupFiles: Record<string,string> = {
  'Packages/manifest.json':'{"dependencies":{}}',
  'Packages/vpm-manifest.json':'{"dependencies":{},"locked":{}}',
  'ProjectSettings/ProjectVersion.txt':'m_EditorVersion: 2022.3.22f1\n',
  'ProjectSettings/ProjectSettings.asset':'%YAML 1.1\nPlayerSettings:\n  productName: Synthetic\n',
};
function writeSyntheticSetup(project:string) {
  for(const path of ['Packages','ProjectSettings'])mkdirSync(join(project,path),{recursive:true});
  for(const [path,content] of Object.entries(syntheticSetupFiles))writeFileSync(join(project,path),content);
}

function fixture(t: TestContext, gated = false, planProducer = false, full = false, legacy = false, archivable=false, sourceRelative='source-input.txt') {
  const root = mkdtempSync(join(tmpdir(), 'avh-input-runtime-')), home = join(root, 'home');
  const beforeCleanup:Array<()=>Promise<void>>=[]; let cleanup = () => removeTemp(root); t.after(async() => {for(const action of beforeCleanup)await action();cleanup();});
  const project = join(root, 'workspace/sample'),packRoot=join(home,'managed/packs/continuation-test'),tools = archivable?join(packRoot,'tools'):join(root, 'tools'), knowledge = archivable?join(packRoot,'knowledge'):join(root, 'knowledge');
  for (const path of [project, tools, join(tools, '审查/perception'), knowledge, join(home, 'config'), join(home, 'state')]) mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  if(archivable){for(const path of ['Assets','Packages','ProjectSettings'])mkdirSync(join(project,path));
    mkdirSync(join(project,sourceRelative,'..'),{recursive:true});writeFileSync(join(project,sourceRelative),'Frozen synthetic source material');
    writeSyntheticSetup(project);
    writeFileSync(join(packRoot,'pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:'continuation-test',version:'1',channel:'builtin',description:'Synthetic continuation contract'}));}
  writeFileSync(join(project, 'plan.json'), JSON.stringify({ face: { mode: 'preserve' } }));
  for (const file of ['tool.mjs', 'project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) writeFileSync(join(tools, file), '');
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: '1', t: {} }));
  const chain = full ? ['setup','face','outfit','recolor','menu','build_pre','regression_pre','optimize','build','regression','performance','package'] : ['setup','face','outfit'];
  const artifact = (id:string) => id==='package' ? 'delivery_package' : id;
  const stages = chain.map((id, i) => ({ id, needs: i ? [chain[i-1]] : [], produces: [artifact(id)], requires: [`${id}_ok`],
    gates: gated && id === 'outfit' ? ['accept'] : [], invalidated_by: id === 'setup' ? ['plan'] : ['plan', 'face_input'], source: 'fixture' }));
  if (planProducer) {
    stages[0]!.needs = ['plan'];
    stages.unshift({ id: 'plan', needs: [], produces: ['plan'], requires: ['plan_ok'], gates: [], invalidated_by: [], source: 'fixture' });
  }
  const definition = { schema: 'process/0.1', id: 'inputs', version: '1', applies_to: {}, artifacts: ['plan','face_input',...chain.map(artifact)], stages,
    checks: chain.map(id => ({ id: `${id}_ok`, observe: `${id}.read`, on: artifact(id), scope: 'edit', rule: 'ok == true', severity: 'blocking', maturity: 'accepted', source: 'fixture' })),
    gates: full ? [{id:'delivery',kind:'approve',binds:'delivery_package',source:'fixture'}] : gated ? [{ id: 'accept', kind: 'approve', binds: 'outfit', source: 'fixture' }] : [], milestones: full ? [{id:'CLIENT_VERIFIED',requires_stages:'all',evidence_on:'delivery_package',gates:['delivery']}] : [] };
  const capabilities = { schema: 'capabilities/0.1', process: 'inputs', version: '1', artifacts: {
    ...Object.fromEntries(chain.map(id=>[artifact(id),{paths:[`${id}.txt`]}])), plan: { paths: ['plan.json'], format: 'json' }, face_input: { source: { kind: 'runtime', input: 'face_input' } },
    face: { paths: ['face.txt'] }, outfit: { paths: ['outfit.txt'] } },
    stages: Object.fromEntries(chain.map(id => [id, { mode: 'tool', command: ['node', '{toolRoot}/tool.mjs'], allowedWrites: [`${id}.txt`] }])),
    observers: Object.fromEntries(chain.map(id => [`${id}.read`, { command: ['node', '{toolRoot}/observe.mjs', '{out}', '{runDir}'] }])) };
  if(archivable){Object.assign(capabilities.artifacts,{setup:{paths:['setup.txt','Packages','ProjectSettings']}});capabilities.stages.setup!.allowedWrites=['setup.txt','Packages/','ProjectSettings/'];}
  if (planProducer) {
    definition.checks.push({ id: 'plan_ok', observe: 'plan.read', on: 'plan', scope: 'edit', rule: 'ok == true', severity: 'blocking', maturity: 'accepted', source: 'fixture' });
    capabilities.stages.plan = { mode: 'tool', command: ['node', '{toolRoot}/tool.mjs'], allowedWrites: ['plan.json'] };
    capabilities.observers['plan.read'] = { command: ['node', '{toolRoot}/observe.mjs', '{out}', '{runDir}'] };
  }
  if(legacy) { delete (capabilities.artifacts as any).face_input;definition.artifacts=definition.artifacts.filter(id=>id!=='face_input');for(const stage of definition.stages)stage.invalidated_by=stage.invalidated_by.filter(id=>id!=='face_input'); }
  writeFileSync(join(tools, 'observe.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2],JSON.stringify({schema:'observation/0.1',metrics:{ok:true},notes:[process.env.AVH_PLAN,process.env.AVH_ACCEPTED_MANUAL_FACE_SHA256??'']}));`);
  writeFileSync(join(knowledge, 'process.yaml'), stringify(definition)); writeFileSync(join(knowledge, 'capabilities.yaml'), stringify(capabilities));
  writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: join(root, 'workspace'), toolRoot: tools, knowledgeRoot: knowledge,
    exportRoots: [], knownBodies: [], projectAliases: {}, sampleNames: ['sample'], processDefinitions: { inputs: { definition: 'process.yaml', capabilities: 'capabilities.yaml' } },
    defaultProfile: 'inputs', thresholdsFile: 'thresholds.yaml', providers: [] }));
  const config = loadConfig(home), path = join(home, 'state/harness.db'); let db = openDatabase(path);
  let manifest:string|undefined;
  if(planProducer){const asset=archivable?join(project,sourceRelative):join(root,'original-material.txt');if(!archivable)writeFileSync(asset,'frozen material');manifest=join(root,'manifest.json');writeFileSync(manifest,JSON.stringify({schema:'manifest/0.1',profile:'inputs',request:'Keep the approved plan',assets:[{store:'client',item:asset,sha256:sha256File(asset)}]}));}
  const id = createWorkflow(db, config, project, 'inputs',manifest), snapshot = workflowSnapshot(db, id);
  const projectId = String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(id)!.project_id);
  if(archivable)registerEntries(db,projectId,[sourceRelative,'Assets/','plan.json','setup.txt','face.txt','outfit.txt',...Object.keys(syntheticSetupFiles)].map(path=>({path,match:path.endsWith('/')?'tree' as const:'file' as const,category:'user-classified',shareLayer:'A' as const,rights:'transferable' as const,sensitivity:'normal' as const,source:{type:'user' as const,ref:'fixture'},reason:'Owned synthetic fixture inputs and outputs'})));
  for (const [index, name] of ['s1', 's2'].entries()) {
    const values = { schema: 'manual-values/0.1', sourceSha256: 'a'.repeat(64), rendererPath: 'Body/Face', meshName: 'Face', values: { key: index }, submittedSha256: String(index).repeat(64) };
    db.prepare(`INSERT INTO face_manual_session(id,project_id,project_path,target_id,state,version,accepted_json)
      VALUES(?,?,?,'target','accepted',?,?)`).run(name, projectId, join(root, name), index + 1, JSON.stringify(values));
  }
  const starts: Array<{ run: RunSpec; plan: any; manifest: any; toolRoot: string; manual?: string }> = [];
  let hold = false, planVersion=0, onStart: ((spec: RunSpec) => void) | undefined;
  t.mock.method(TaskRouter.prototype, 'canDispatch', () => true);
  t.mock.method(TaskRouter.prototype, 'start', function(this: TaskRouter, run: RunSpec): RunHandle {
    mkdirSync(join(home, 'runs', run.runId), { recursive: true });
    starts.push({ run, manifest:JSON.parse(this.spec.tool!.env.AVH_MANIFEST!), toolRoot: this.spec.tool!.env.AVH_TOOL_ROOT!, plan: JSON.parse(this.spec.tool!.env.AVH_PLAN!), ...(this.spec.tool!.env.AVH_ACCEPTED_MANUAL_FACE_SHA256 ? { manual: readFileSync(join(this.row.project_path, '_harness/face/accepted-manual.json'), 'utf8') } : {}) });
    onStart?.(run); return { ref: `fake-${run.runId}` };
  });
  t.mock.method(TaskRouter.prototype, 'observe', async () => ({ state: hold ? 'running' : 'exited' }));
  t.mock.method(TaskRouter.prototype, 'collect', async function(this: TaskRouter, handle: RunHandle): Promise<RunResult> {
    const started = starts.find(item => `fake-${item.run.runId}` === handle.ref)!;
    if (started.run.stageId === 'plan') writeFileSync(join(this.row.project_path, 'plan.json'), JSON.stringify({ face: { mode: 'preserve' }, changedOutput: true,...(planVersion?{approvedVersion:planVersion}:{}) }));
    else writeFileSync(join(this.row.project_path, `${started.run.stageId}.txt`), 'identical bytes for every input');
    if(archivable&&started.run.stageId==='setup')writeSyntheticSetup(this.row.project_path);
    return { exitStatus: 0, outputs: {} };
  });
  cleanup = () => { if (db.isOpen) db.close(); removeTemp(root); };
  return { beforeCleanup:(action:()=>Promise<void>)=>beforeCleanup.push(action), home, project, projectId, config, id, snapshot, starts, get db() { return db; },
    activate: (name: string, activationId = name) => activateFaceInput(db, id, { mode: name === 'preserve' ? 'preserve' : 'manual', manualSessionId: name, activationId }),
    hold: (value: boolean) => { hold = value; }, onStart: (fn?: (spec: RunSpec) => void) => { onStart = fn; },
    nextPlan:()=>planVersion++,
    tick: async () => { await serveOnce(db, config); assert.equal(db.prepare("SELECT reason FROM event WHERE action='tick_failed' ORDER BY seq DESC LIMIT 1").get(), undefined); }, scheduler: () => workflowScheduler(db, config, id),
    restart: () => { db.close(); db = openDatabase(path); } };
}


test('a sole retained delivery can recover its logical production head without latest-workflow guessing',t=>{
  const f=fixture(t);f.db.prepare('DELETE FROM production_head').run();f.db.prepare("UPDATE workflow SET status='client_verified' WHERE id=?").run(f.id);
  const id=activateProduction(f.db,f.projectId,{activationId:'post-delivery',mode:'manual',manualSessionId:'s1',expectedRevision:0});
  assert.ok(id);assert.equal(productionHead(f.db,f.projectId),f.id);assert.equal(f.db.prepare('SELECT predecessor_workflow_id FROM production_continuation').get()!.predecessor_workflow_id,f.id);
});

for(const change of ['added','modified','deleted'])test(`ordinary baseline continuation reconciles ${change} nested predecessor files before publication`,async t=>{
  const f=fixture(t),path='Assets/AlternateVendor/custom-note.txt';mkdirSync(join(f.project,'Assets/AlternateVendor'),{recursive:true});
  if(change!=='added')writeFileSync(join(f.project,path),'baseline user content');
  await f.tick();await f.tick();
  assert.equal(f.db.prepare('SELECT state FROM production_baseline WHERE workflow_id=?').get(f.id)!.state,'ready');
  if(change==='deleted')rmSync(join(f.project,path));else writeFileSync(join(f.project,path),'unexplained user edit after baseline');
  const id=activateProduction(f.db,f.projectId,{activationId:'baseline-edit',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  const before=f.starts.length;await f.tick();
  const row=f.db.prepare('SELECT * FROM production_continuation WHERE id=?').get(id)!;
  assert.equal(row.state,'preparing');assert.equal(productionHead(f.db,f.projectId),f.id);assert.equal(f.starts.length,before);
  const preparation=JSON.parse(String(row.preparation_json));assert.equal(preparation.sourceKind,'baseline_copy');
  assert.deepEqual(preparation.report.unknown.map((file:any)=>file.path),[path]);assert.equal(Boolean(preparation.report.unknown[0].deleted),change==='deleted');
  const progress=continuationProgress(f.db,f.projectId);assert.equal(progress.application!.rebuild!.checkpoint,'reconcile');
  f.restart();resolveRebuildChanges(f.db,f.projectId,id,1,preparation.report.hash,[path],'Retain this explicitly reviewed difference only in the predecessor');
  await f.tick();assert.equal(f.db.prepare('SELECT state FROM production_continuation WHERE id=?').get(id)!.state,'applied');
  assert.equal(f.starts.at(-1)!.plan.face.manualSessionId,'s1');
});

test('ordinary baseline publication refuses predecessor edits made after report approval',async t=>{
  const f=fixture(t);await f.tick();await f.tick();writeFileSync(join(f.project,'late-user-note.txt'),'first user edit');
  const id=activateProduction(f.db,f.projectId,{activationId:'post-review-edit',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  await f.tick();const preparation=JSON.parse(String(f.db.prepare('SELECT preparation_json FROM production_continuation WHERE id=?').get(id)!.preparation_json));
  resolveRebuildChanges(f.db,f.projectId,id,1,preparation.report.hash,['late-user-note.txt'],'Retain the exact reviewed change only in the predecessor');
  writeFileSync(join(f.project,'late-user-note.txt'),'unreviewed edit after approval');await f.tick();
  const row=f.db.prepare('SELECT * FROM production_continuation WHERE id=?').get(id)!;assert.equal(row.state,'failed');assert.match(String(row.error),/前驱工程已变化/);
  assert.equal(productionHead(f.db,f.projectId),f.id);assert.equal(row.successor_workflow_id,null);
});

test('formal continuation resume refreshes an invalid ordinary baseline report and preserves its decision history',async t=>{
  const f=fixture(t);await f.tick();await f.tick();writeFileSync(join(f.project,'late-user-note.txt'),'first reviewed user edit');
  const id=activateProduction(f.db,f.projectId,{activationId:'refresh-review',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  await f.tick();const old=JSON.parse(String(f.db.prepare('SELECT preparation_json FROM production_continuation WHERE id=?').get(id)!.preparation_json));
  resolveRebuildChanges(f.db,f.projectId,id,1,old.report.hash,['late-user-note.txt'],'Retain the first reviewed bytes only in the predecessor');
  const decision=f.db.prepare("SELECT * FROM event WHERE entity_id=? AND action='changes_resolved'").get(id)!;
  writeFileSync(join(f.project,'late-user-note.txt'),'unreviewed edit after approval');await f.tick();
  assert.equal(f.db.prepare('SELECT state FROM production_continuation WHERE id=?').get(id)!.state,'failed');
  controlContinuation(f.db,f.projectId,id,1,true);
  let pending=JSON.parse(String(f.db.prepare('SELECT preparation_json FROM production_continuation WHERE id=?').get(id)!.preparation_json));
  assert.equal(pending.refreshRequested,true);assert.equal(pending.report.hash,old.report.hash,'the official entry waits for the consumer safe point');
  f.restart();const before=f.starts.length;await f.tick();
  const row=f.db.prepare('SELECT * FROM production_continuation WHERE id=?').get(id)!;assert.equal(row.state,'preparing',JSON.stringify(row));
  const refreshed=JSON.parse(String(row.preparation_json));assert.equal(refreshed.checkpoint,'reconcile');assert.notEqual(refreshed.report.hash,old.report.hash);
  assert.equal(refreshed.resolutions,undefined);assert.equal(refreshed.refreshRequested,undefined);assert.equal(f.starts.length,before);
  assert.equal(refreshed.report.unknown[0].sha256,sha256File(join(f.project,'late-user-note.txt')));
  assert.equal(refreshed.sourceFiles.find((file:any)=>file.path==='late-user-note.txt').sha256,refreshed.report.unknown[0].sha256);
  assert.deepEqual(refreshed.reconciliationHistory[0].report,old.report);assert.equal(refreshed.reconciliationHistory[0].resolutions.eventSeq,decision.seq);
  assert.deepEqual(f.db.prepare('SELECT * FROM event WHERE seq=?').get(decision.seq!),decision);
  const invalidation=JSON.parse(String(f.db.prepare("SELECT payload_json FROM event WHERE entity_id=? AND action='reconciliation_invalidated'").get(id)!.payload_json));
  assert.equal(invalidation.previous.report.hash,old.report.hash);assert.equal(invalidation.previous.resolutions.eventSeq,decision.seq);
  const archived=productionInputDocument(f.db,f.projectId,value=>value);assert.equal(archived.lineage.find(row=>row.id===id)!.checkpoint.reconciliationHistory[0].report.hash,old.report.hash);
  assert.throws(()=>resolveRebuildChanges(f.db,f.projectId,id,1,old.report.hash,['late-user-note.txt'],'Reject late approval of the obsolete report'),/完整报告/);
  await f.tick();assert.equal(f.db.prepare('SELECT state FROM production_continuation WHERE id=?').get(id)!.state,'preparing');
  resolveRebuildChanges(f.db,f.projectId,id,1,refreshed.report.hash,['late-user-note.txt'],'Retain the newly reviewed bytes only in the predecessor');await f.tick();
  assert.equal(f.db.prepare('SELECT state FROM production_continuation WHERE id=?').get(id)!.state,'applied');assert.equal(f.starts.at(-1)!.plan.face.manualSessionId,'s1');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM event WHERE entity_id=? AND action='changes_resolved'").get(id)!.n,2);
});

test('a persisted older baseline copy checklist resumes with current source reconciliation',async t=>{
  const f=fixture(t);await f.tick();await f.tick();
  const id=activateProduction(f.db,f.projectId,{activationId:'old-checklist',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  let calls=0;await advanceProductionContinuations(f.db,f.config,()=>++calls<4);
  const preparation=JSON.parse(String(f.db.prepare('SELECT preparation_json FROM production_continuation WHERE id=?').get(id)!.preparation_json));
  for(const key of ['sourceKind','sourceFiles','predecessorSource','report','checkpoint','resolutions'])delete preparation[key];
  f.db.prepare('UPDATE production_continuation SET preparation_json=? WHERE id=?').run(JSON.stringify(preparation),id);
  writeFileSync(join(f.project,'new-note.txt'),'Unknown edit while Runtime was stopped');f.restart();await f.tick();
  const row=f.db.prepare('SELECT * FROM production_continuation WHERE id=?').get(id)!;assert.equal(row.state,'preparing');
  const restored=JSON.parse(String(row.preparation_json));assert.deepEqual(restored.report.unknown.map((file:any)=>file.path),['new-note.txt']);assert.equal(productionHead(f.db,f.projectId),f.id);
  resolveRebuildChanges(f.db,f.projectId,id,1,restored.report.hash,['new-note.txt'],'Retain the reviewed note only in the predecessor');await f.tick();
  assert.equal(f.db.prepare('SELECT state FROM production_continuation WHERE id=?').get(id)!.state,'applied');
});

test('formal rollback after preserve face prepares exactly one successor and applies immutable accepted values', async t => {
  const f = fixture(t); await f.tick(); await f.tick();
  f.db.prepare("INSERT INTO project_brief(project_id,intake_mode,customer_request,face_concept) VALUES(?,'conversation','Keep the approved costume','Shared face')").run(f.projectId);
  f.db.prepare("INSERT INTO project_variant(id,project_id,name) VALUES('approved-look',?,'Approved look')").run(f.projectId);
  f.db.prepare("INSERT INTO project_message(id,project_id,role,content,status) VALUES('decision',?,'user','Keep the original palette','accepted')").run(f.projectId);
  assert.equal(f.db.prepare("SELECT state FROM production_baseline WHERE workflow_id=?").get(f.id)!.state, 'ready');
  const service = new RuntimeService({home:f.home,scheduler:false}); await service.start();
  const api = await ApiClient.connect(f.home); t.after(async()=>{ api.close(); await service.stop(); });
  await api.call('project.face.manual.rollback', {projectId:f.projectId, sessionId:'s1', expectedRevision:0});
  const request = f.db.prepare('SELECT * FROM production_continuation').get()!;
  await f.tick();
  assert.equal(f.db.prepare('SELECT state,error FROM production_continuation').get()!.state, 'applied', JSON.stringify(f.db.prepare('SELECT state,error FROM production_continuation').get()));
  const head = productionHead(f.db, f.projectId)!;
  const state = projectState(f.db, String(f.db.prepare('SELECT project_id FROM workflow WHERE id=?').get(head)!.project_id));
  assert.equal(state.brief!.goal,'Keep the approved costume');assert.equal(state.variants[0]!.name,'Approved look');
  assert.equal(state.acceptedDecisions[0]!.content,'Keep the original palette');assert.equal(state.faceChoice!.acceptedVersion,'s1');
  assert.equal(state.workflow!.id,head);assert.notEqual(state.project.path,f.project);
  assert.notEqual(head, f.id); assert.equal(f.starts.at(-1)!.plan.face.manualSessionId, 's1');
  const appliedFace = f.starts.find(start => start.run.workflowId === head && start.run.stageId === 'face');
  assert.ok(appliedFace?.manual, JSON.stringify({starts:f.starts.map(s=>({stage:s.run.stageId,workflow:s.run.workflowId})), reuse:f.db.prepare('SELECT * FROM production_evidence_reuse').all(), tasks:f.db.prepare('SELECT stage_id,status FROM task WHERE workflow_id=?').all(head), aggregate:aggregateWorkflow(f.db,head,f.snapshot.definition)}));
  assert.equal(JSON.parse(appliedFace.manual).values.key, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=? AND t.stage_id='setup'").get(head)!.n,0);
  await f.tick(); assert.equal(f.starts.at(-1)!.run.stageId, 'outfit');
  assert.equal(readFileSync(join(f.project,'face.txt'),'utf8'),'identical bytes for every input');
  activateProduction(f.db,f.projectId,{activationId:String(request.activation_id),mode:'manual',manualSessionId:'s1',expectedRevision:0});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_continuation').get()!.n,1);
  await assert.rejects(api.call('project.face.manual.rollback',{projectId:f.projectId,sessionId:'s2',expectedRevision:0}), /变化/);
  await api.call('project.face.manual.rollback',{projectId:f.projectId,sessionId:'s2',expectedRevision:1}); await f.tick();
  assert.equal(f.starts.at(-1)!.plan.face.manualSessionId,'s2');
  await api.call('project.face.manual.rollback',{projectId:f.projectId,sessionId:'s1',expectedRevision:2}); await f.tick();
  assert.equal(f.starts.at(-1)!.plan.face.manualSessionId,'s1');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_continuation WHERE successor_workflow_id IS NOT NULL').get()!.n,3);
});

test('old frozen production adopts only the explicitly reviewed successor contract despite a different active package',async t=>{
  const f=fixture(t,false,true,false,true);for(let i=0;i<4;i++)await f.tick();
  const id=activateProduction(f.db,f.projectId,{activationId:'old-contract',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  await f.tick();assert.equal(f.db.prepare('SELECT state FROM production_continuation WHERE id=?').get(id)!.state,'failed');
  const targetRoot=join(f.home,'managed/packs/reviewed-target'),processRoot=join(targetRoot,'knowledge/process');mkdirSync(processRoot,{recursive:true});
  cpSync(f.snapshot.toolRoot,join(targetRoot,'tools'),{recursive:true});
  const definition=structuredClone(f.snapshot.definition),capabilities=structuredClone(f.snapshot.capabilities);
  definition.artifacts.push('face_input');for(const stage of definition.stages)if(!['intake','plan','environment','setup'].includes(stage.id))stage.invalidated_by.push('face_input');
  capabilities.artifacts.face_input={paths:[],source:{kind:'runtime',input:'face_input'}};
  const serializedCapabilities=parse(readFileSync(join(f.config.knowledgeRoot,'capabilities.yaml'),'utf8'));serializedCapabilities.artifacts.face_input={source:{kind:'runtime',input:'face_input'}};serializedCapabilities.stages.face.command=['node','{toolRoot}/face-v2.mjs'];writeFileSync(join(targetRoot,'tools/face-v2.mjs'),'new face implementation');
  writeFileSync(join(processRoot,'inputs.process.yaml'),stringify(definition));writeFileSync(join(processRoot,'inputs.capabilities.yaml'),stringify(serializedCapabilities));
  writeFileSync(join(processRoot,'thresholds.yaml'),stringify({schema:'thresholds/0.1',version:'1',t:{}}));
  writeFileSync(join(targetRoot,'pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:'reviewed-target',version:'1',channel:'builtin',description:'Reviewed successor'}));
  let view=continuationContractView(f.db,f.config,f.projectId,id,'reviewed-target');
  assert.throws(()=>adoptContinuationContract(f.db,f.config,f.projectId,id,0,'reviewed-target',view.token,'Adopt'),/已更新/);
  const tool=join(targetRoot,'tools/tool.mjs');writeFileSync(tool,'changed');
  assert.throws(()=>adoptContinuationContract(f.db,f.config,f.projectId,id,1,'reviewed-target',view.token,'Adopt'),/已变化/);writeFileSync(tool,'');
  view=continuationContractView(f.db,f.config,f.projectId,id,'reviewed-target');
  adoptContinuationContract(f.db,f.config,f.projectId,id,1,'reviewed-target',view.token,'Reviewed the complete successor contract');
  const other=join(f.home,'different-active-tools');mkdirSync(other);writeFileSync(join(other,'tool.mjs'),'do not run');f.config.toolRoot=other;
  for(let i=0;i<5;i++)await f.tick();
  const request=f.db.prepare('SELECT * FROM production_continuation WHERE id=?').get(id)!;assert.equal(request.state,'applied',JSON.stringify(request));
  const head=productionHead(f.db,f.projectId)!,snapshot=workflowSnapshot(f.db,head);assert.equal(snapshot.toolRoot,join(targetRoot,'tools'));
  assert.equal(f.starts.find(s=>s.run.workflowId===head&&s.run.stageId==='face')!.plan.face.manualSessionId,'s1');
  assert.equal(f.starts.filter(s=>s.run.stageId==='plan').length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_continuation_contract').get()!.n,1);
  assert.throws(()=>continuationContractView(f.db,f.config,f.projectId,id,'reviewed-target'),/已完成/);
});

test('historic production without a face baseline rebuilds setup from the approved plan without replanning',async t=>{
  const f=fixture(t,false,true);for(let i=0;i<4;i++)await f.tick();
  f.db.prepare('DELETE FROM production_baseline WHERE workflow_id=?').run(f.id);
  const oldFace=readFileSync(join(f.project,'face.txt'),'utf8'),before=f.starts.length;
  activateProduction(f.db,f.projectId,{activationId:'historical-rebuild',mode:'manual',manualSessionId:'s1',expectedRevision:0});
  for(let i=0;i<5;i++)await f.tick();
  const request=f.db.prepare('SELECT * FROM production_continuation').get()!;
  assert.equal(request.state,'applied',JSON.stringify(request));
  const head=productionHead(f.db,f.projectId)!;
  assert.notEqual(head,f.id);assert.equal(readFileSync(join(f.project,'face.txt'),'utf8'),oldFace);
  assert.deepEqual(f.starts.slice(before).map(s=>s.run.stageId),['setup','face','outfit']);
  assert.equal(f.starts.filter(s=>s.run.stageId==='plan').length,1);
  assert.equal(f.starts.find(s=>s.run.workflowId===head&&s.run.stageId==='face')!.plan.face.manualSessionId,'s1');
  assert.equal(f.db.prepare('SELECT source_workflow_id FROM production_baseline WHERE workflow_id=?').get(head)!.source_workflow_id,head);
});

test('a revised approved plan rebuilds preparation instead of silently restoring the older face baseline plan',async t=>{
  const f=fixture(t,false,true);for(let i=0;i<4;i++)await f.tick();
  const baseline=JSON.parse(String(f.db.prepare('SELECT manifest_json FROM production_baseline WHERE workflow_id=?').get(f.id)!.manifest_json));
  const planTask=f.db.prepare("SELECT id FROM task WHERE workflow_id=? AND stage_id='plan' ORDER BY rowid DESC LIMIT 1").get(f.id)!;
  f.nextPlan();taskRedo(f.db,String(planTask.id),'Produce the revised approved fixture plan');await f.tick();
  assert.notEqual(sha256File(join(f.project,'plan.json')),baseline.input.plan);
  activateProduction(f.db,f.projectId,{activationId:'current-approved-plan',mode:'manual',manualSessionId:'s1',expectedRevision:0});
  const before=f.starts.length;for(let i=0;i<5;i++)await f.tick();
  const request=f.db.prepare('SELECT * FROM production_continuation').get()!;
  assert.equal(request.state,'applied',JSON.stringify(request));
  assert.equal(JSON.parse(String(request.preparation_json)).sourceKind,'frozen_rebuild');
  assert.equal(f.starts.slice(before).filter(s=>s.run.stageId==='plan').length,0);
  const face=f.starts.slice(before).find(s=>s.run.stageId==='face')!;assert.equal(face.plan.approvedVersion,1);
  assert.equal(JSON.parse(readFileSync(join(String(f.db.prepare('SELECT path FROM project WHERE id=?').get(request.successor_project_id!)!.path),'plan.json'),'utf8')).approvedVersion,1);
});

test('unexplained historical edits remain preserved and prevent publication until explicit complete reconciliation',async t=>{
  const f=fixture(t,false,true);for(let i=0;i<4;i++)await f.tick();
  f.db.prepare('DELETE FROM production_baseline WHERE workflow_id=?').run(f.id);writeFileSync(join(f.project,'unknown-manual.txt'),'unexplained hand edit');
  activateProduction(f.db,f.projectId,{activationId:'historical-edit',mode:'manual',manualSessionId:'s1',expectedRevision:0});
  for(let i=0;i<3;i++)await f.tick();
  let request=f.db.prepare('SELECT * FROM production_continuation').get()!,preparation=JSON.parse(String(request.preparation_json));
  assert.equal(request.state,'preparing');assert.equal(preparation.checkpoint,'reconcile');assert.equal(productionHead(f.db,f.projectId),f.id);
  assert.equal(f.starts.filter(s=>s.run.workflowId===request.successor_workflow_id&&s.run.stageId==='face').length,0);
  assert.equal(readFileSync(join(preparation.preservedRoot,'unknown-manual.txt'),'utf8'),'unexplained hand edit');
  const paths=preparation.report.unknown.map((f:any)=>f.path);assert.deepEqual(paths,['unknown-manual.txt']);
  assert.throws(()=>resolveRebuildChanges(f.db,f.projectId,String(request.id),1,preparation.report.hash,[],'Reviewed'),/完整报告/);
  resolveRebuildChanges(f.db,f.projectId,String(request.id),1,preparation.report.hash,paths,'Retain this unrelated note in the original project only');
  const preparedFile=join(preparation.destination,'unreviewed-candidate.txt');
  writeFileSync(preparedFile,'unreviewed candidate edit');await f.tick();
  request=f.db.prepare('SELECT * FROM production_continuation').get()!;
  assert.equal(request.state,'failed');assert.match(String(request.error),/候选工程已变化/);assert.equal(productionHead(f.db,f.projectId),f.id);
  rmSync(preparedFile);controlContinuation(f.db,f.projectId,String(request.id),1,true);
  await f.tick();await f.tick();request=f.db.prepare('SELECT * FROM production_continuation').get()!;
  assert.equal(request.state,'applied',JSON.stringify(request));
  assert.equal(readFileSync(join(f.project,'unknown-manual.txt'),'utf8'),'unexplained hand edit');
});

test('cancelled historical preparation drains its managed writer and resumes the same unpublished successor',async t=>{
  const f=fixture(t,false,true);for(let i=0;i<4;i++)await f.tick();f.db.prepare('DELETE FROM production_baseline WHERE workflow_id=?').run(f.id);
  t.mock.method(TaskRouter.prototype,'cancel',async()=> 'confirmed' as const);
  const id=activateProduction(f.db,f.projectId,{activationId:'cancel-rebuild',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  await advanceProductionContinuations(f.db,f.config);f.hold(true);await f.tick();
  const request=f.db.prepare('SELECT * FROM production_continuation WHERE id=?').get(id)!;
  assert.equal(f.db.prepare("SELECT status FROM task WHERE workflow_id=? AND stage_id='setup'").get(request.successor_workflow_id!)!.status,'RUNNING');
  controlContinuation(f.db,f.projectId,id,1,false);await f.tick();
  assert.equal(f.db.prepare("SELECT status FROM task WHERE workflow_id=? AND stage_id='setup'").get(request.successor_workflow_id!)!.status,'CANCELLED');
  assert.equal(productionHead(f.db,f.projectId),f.id);assert.equal(f.starts.filter(s=>s.run.workflowId===request.successor_workflow_id&&s.run.stageId==='face').length,0);
  f.restart();f.hold(false);controlContinuation(f.db,f.projectId,id,1,true);for(let i=0;i<4;i++)await f.tick();
  const resumed=f.db.prepare('SELECT * FROM production_continuation WHERE id=?').get(id)!;assert.equal(resumed.state,'applied',JSON.stringify(resumed));
  assert.equal(resumed.successor_workflow_id,request.successor_workflow_id);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_continuation').get()!.n,1);
});

test('cold successor inputs restore preparation evidence closure and Runtime rebuild clears the missing baseline',async t=>{
  const f=fixture(t,false,true);for(let i=0;i<4;i++)await f.tick();
  activateProduction(f.db,f.projectId,{activationId:'before-cold',mode:'manual',manualSessionId:'s1',expectedRevision:0});await f.tick();
  const head=productionHead(f.db,f.projectId)!,project=f.db.prepare('SELECT p.* FROM project p JOIN workflow w ON w.project_id=p.id WHERE w.id=?').get(head)!;
  const document=productionInputDocument(f.db,String(project.id),value=>value);assert.ok(document.reusedEvidence!.length>=2);assert.equal(document.head,head);
  const coldWorkspace=join(f.config.workspaceRoot,'cold'),coldRoot=join(coldWorkspace,'restored'),coldHome=join(f.home,'cold');mkdirSync(coldWorkspace,{recursive:true});mkdirSync(join(coldHome,'state'),{recursive:true});cpSync(String(project.path),coldRoot,{recursive:true});
  const cold=openDatabase(join(coldHome,'state/harness.db'));t.after(()=>cold.close());
  const copy=(table:string,row:Record<string,any>)=>cold.prepare(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
  copy('workspace',{...f.db.prepare('SELECT * FROM workspace WHERE id=?').get(project.workspace_id!)!,path:coldWorkspace});copy('project',{...project,path:coldRoot});
  copy('workflow',f.db.prepare('SELECT * FROM workflow WHERE id=?').get(head)!);copy('workflow_definition',f.db.prepare('SELECT * FROM workflow_definition WHERE workflow_id=?').get(head)!);
  for(const artifact of f.db.prepare('SELECT * FROM artifact_version WHERE workflow_id=?').all(head))copy('artifact_version',artifact);
  restoreProductionInputs(cold,String(project.id),coldRoot,document,id=>id);
  for(const completion of f.db.prepare('SELECT * FROM stage_completion WHERE workflow_id=?').all(head))copy('stage_completion',completion);
  for(const verdict of f.db.prepare('SELECT * FROM verdict WHERE workflow_id=?').all(head))copy('verdict',verdict);
  projectSafePoint(cold,String(project.id));
  assert.equal(cold.prepare('SELECT COUNT(*) n FROM production_archived_evidence').get()!.n,document.reusedEvidence!.length);
  assert.equal(cold.prepare('SELECT COUNT(*) n FROM workflow').get()!.n,1,'foreign source engineering is represented by evidence, never fabricated');
  assert.equal(aggregateWorkflow(cold,head,workflowSnapshot(cold,head).definition).stages.plan!.status,'passed');
  assert.equal(aggregateWorkflow(cold,head,workflowSnapshot(cold,head).definition).stages.setup!.status,'passed');
  assert.ok(JSON.parse(String(cold.prepare('SELECT document_json FROM production_archive_reference').get()!.document_json)).missingInputs.includes(`baseline-content:${head}`));
  const before=f.starts.length;activateProduction(cold,String(project.id),{activationId:'cold-continue',mode:'manual',manualSessionId:'s1',expectedRevision:1});
  const config={...f.config,home:coldHome,workspaceRoot:coldWorkspace};for(let i=0;i<6;i++)await serveOnce(cold,config);
  const request=cold.prepare("SELECT * FROM production_continuation WHERE activation_id='cold-continue'").get()!;assert.equal(request.state,'applied',JSON.stringify(request));
  revalidateProductionArchive(cold,String(project.id));
  const retained=JSON.parse(String(cold.prepare('SELECT document_json FROM production_archive_reference').get()!.document_json));assert.ok(!retained.missingInputs.includes(`baseline-content:${head}`));assert.ok(retained.recoveredMissingInputs.includes(`baseline-content:${head}`));
  assert.deepEqual(f.starts.slice(before).map(s=>s.run.stageId),['setup','face','outfit']);
});

test('a successor retains genuinely external frozen material identity',async t=>{
  const f=fixture(t,false,true);for(let i=0;i<4;i++)await f.tick();
  const original=f.snapshot.manifest!.assets[0]!;
  activateProduction(f.db,f.projectId,{activationId:'external-source',mode:'manual',manualSessionId:'s1',expectedRevision:0});await f.tick();
  assert.deepEqual(workflowSnapshot(f.db,productionHead(f.db,f.projectId)!).manifest!.assets[0],original);
});

for(const frozen of [false,true])test(`inherited stage selection dispatches successor manifest through Runtime ${frozen?'frozen rebuild':'baseline copy'}`,async t=>{
  const f=fixture(t,false,true,false,false,true,'Assets/DifferentVendor/Inputs/material.data');seedSelectedContract(f);
  const historical=String(f.db.prepare("SELECT payload_json FROM event WHERE workflow_id=? AND entity_type='stage_contract' AND action='selected'").get(f.id)!.payload_json);
  for(let i=0;i<4;i++)await f.tick();
  if(frozen)f.db.prepare('DELETE FROM production_baseline WHERE workflow_id=?').run(f.id);
  const id=activateProduction(f.db,f.projectId,{activationId:'selected-contract',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  for(let i=0;i<(frozen?6:2);i++)await f.tick();
  const request=f.db.prepare('SELECT * FROM production_continuation WHERE id=?').get(id)!;assert.equal(request.state,'applied',JSON.stringify(request));
  const head=productionHead(f.db,f.projectId)!,root=String(f.db.prepare('SELECT p.path FROM project p JOIN workflow w ON w.project_id=p.id WHERE w.id=?').get(head)!.path);
  const starts=f.starts.filter(s=>s.run.workflowId===head);assert.ok(starts.some(s=>s.run.stageId==='face'));
  for(const start of starts){assert.equal(start.manifest.assets[0].item,join(root,'Assets/DifferentVendor/Inputs/material.data'));
    assert.equal(sha256File(start.manifest.assets[0].item),f.snapshot.manifest!.assets[0]!.sha256);
    assert.ok(readRunInputSnapshot(f.db,start.run.runId)!.stageToolSelection.selectionSeq);}
  assert.equal(String(f.db.prepare("SELECT payload_json FROM event WHERE workflow_id=? AND entity_type='stage_contract' AND action='selected'").get(f.id)!.payload_json),historical);
});

for(const layers of [['A'],['A','B']] as const)test(`a successor formal share continues selected stage contracts after cold restore with all sender engineering inaccessible (${layers.join('+')})`, {skip:!has7z},async t=>{
  const f=fixture(t,false,true,false,false,true,'Assets/DifferentVendor/Inputs/material.data');seedSelectedContract(f);for(let i=0;i<4;i++)await f.tick();
  activateProduction(f.db,f.projectId,{activationId:'export-successor',mode:'manual',manualSessionId:'s1',expectedRevision:0});
  await f.tick();await f.tick();
  const head=productionHead(f.db,f.projectId)!,project=f.db.prepare('SELECT p.* FROM project p JOIN workflow w ON w.project_id=p.id WHERE w.id=?').get(head)!;
  const successor=workflowSnapshot(f.db,head),asset=successor.manifest!.assets[0]!;
  assert.equal(asset.item,join(String(project.path),'Assets/DifferentVendor/Inputs/material.data'));assert.equal(asset.sha256,f.snapshot.manifest!.assets[0]!.sha256);assert.equal(asset.store,'client');
  // The fixture owner explicitly authorizes sharing the synthetic successor's files.
  registerEntries(f.db,String(project.id),['Assets/DifferentVendor/Inputs/material.data','Assets/','plan.json','setup.txt','face.txt','outfit.txt',...Object.keys(syntheticSetupFiles)].map(path=>({path,match:path.endsWith('/')?'tree' as const:'file' as const,category:'user-classified',shareLayer:'A' as const,rights:'transferable' as const,sensitivity:'normal' as const,source:{type:'user' as const,ref:'fixture'},reason:'Owned synthetic successor files'})));
  const exports=join(f.home,'exports');mkdirSync(exports);const shared=await exportShare(f.db,{home:f.home,exportRoot:exports},String(project.id),{layers:[...layers]});
  assert.equal(shared.status,'exported',JSON.stringify(shared.plan.blockers));
  const coldHome=join(f.home,'receiver'),coldWorkspace=join(f.config.workspaceRoot,'receiver');mkdirSync(join(coldHome,'state'),{recursive:true});mkdirSync(coldWorkspace);
  cpSync(join(f.home,'managed'),join(coldHome,'managed'),{recursive:true});
  assert.ok(f.project.startsWith(f.config.workspaceRoot));assert.ok(String(project.path).startsWith(f.config.workspaceRoot));
  rmSync(f.project,{recursive:true});rmSync(String(project.path),{recursive:true});
  const cold=openDatabase(join(coldHome,'state/harness.db'));t.after(()=>cold.close());
  const restored=await restoreShare(cold,{home:coldHome,workspaceRoot:coldWorkspace,workflowVariables:{}},shared.package!.path);
  assert.equal(restored.status,'restored',JSON.stringify(restored.check));
  const snapshot=workflowSnapshot(cold,head),restoredAsset=snapshot.manifest!.assets[0]!;
  assert.equal(restoredAsset.sha256,asset.sha256);assert.equal(sha256File(restoredAsset.item),asset.sha256);assert.ok(restoredAsset.item.startsWith(coldWorkspace));
  const config={...f.config,home:coldHome,stateDbPath:join(coldHome,'state/harness.db'),workspaceRoot:coldWorkspace,toolRoot:snapshot.toolRoot};
  activateProduction(cold,restored.projectId!,{activationId:'cold-successor-share',mode:'manual',manualSessionId:'s2',expectedRevision:1});
  const before=f.starts.length;for(let i=0;i<6;i++)await serveOnce(cold,config);
  const request=cold.prepare("SELECT * FROM production_continuation WHERE activation_id='cold-successor-share'").get()!;
  assert.equal(request.state,'applied',JSON.stringify(request));
  assert.deepEqual(f.starts.slice(before).map(s=>s.run.stageId),['setup','face','outfit']);
  assert.ok(f.starts.slice(before).every(s=>s.toolRoot.startsWith(coldHome)));
  for(const start of f.starts.slice(before)){assert.ok(start.manifest.assets[0].item.startsWith(coldWorkspace));assert.equal(sha256File(start.manifest.assets[0].item),asset.sha256);assert.ok(readRunInputSnapshot(cold,start.run.runId)!.stageToolSelection.selectionSeq);}
  assert.ok(!continuationProgress(cold,restored.projectId!).missingInputs?.length);
  assert.equal(f.starts.slice(before).find(s=>s.run.stageId==='face')!.plan.face.manualSessionId,'s2');
});

for(const layers of [['A'],['A','B']] as const)test(`a selected repair pack missing at cold restore blocks continuation until exact completeRestore (${layers.join('+')})`,{skip:!has7z},async t=>{
  const f=fixture(t,false,true,false,false,true,'Assets/AnotherLayout/Model/source.data');
  const repair=join(f.home,'managed/packs/reviewed-repair'),process=join(repair,'knowledge/process');
  cpSync(join(f.home,'managed/packs/continuation-test'),repair,{recursive:true});mkdirSync(process,{recursive:true});
  for(const [source,target] of [['process.yaml','inputs.process.yaml'],['capabilities.yaml','inputs.capabilities.yaml'],['thresholds.yaml','thresholds.yaml']])cpSync(join(f.config.knowledgeRoot,source!),join(process,target!));
  writeFileSync(join(repair,'pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:'reviewed-repair',version:'7',channel:'builtin',description:'Synthetic exact reviewed repair'}));
  const view=stageContractView(f.db,f.config,f.snapshot,'face','reviewed-repair');
  selectStageContract(f.db,f.config,f.snapshot,'face','reviewed-repair',view.token,'Adopt the reviewed synthetic repair contract');
  for(let i=0;i<4;i++)await f.tick();assert.ok(f.starts.every(start=>start.toolRoot===join(repair,'tools')));
  const originalInputs=f.db.prepare('SELECT run_id FROM run_input_snapshot').all().map(row=>String(row.run_id));
  const exports=join(f.home,'exports');mkdirSync(exports);const shared=await exportShare(f.db,{home:f.home,exportRoot:exports},f.projectId,{layers:[...layers]});
  assert.equal(shared.status,'exported',JSON.stringify(shared.plan.blockers));
  const dependency=shared.plan.dependencies.packs.find(pack=>pack.selectionSeq);assert.equal(dependency?.id,'reviewed-repair');assert.equal(dependency?.version,'7');assert.ok(dependency?.contentHash);
  const coldHome=join(f.home,'receiver'),workspace=join(f.config.workspaceRoot,'receiver');mkdirSync(join(coldHome,'state'),{recursive:true});mkdirSync(workspace);
  cpSync(join(f.home,'managed/packs/continuation-test'),join(coldHome,'managed/packs/continuation-test'),{recursive:true});
  const cold=openDatabase(join(coldHome,'state/harness.db'));t.after(()=>cold.close());
  const env={home:coldHome,workspaceRoot:workspace,workflowVariables:{}};
  const restored=await restoreShare(cold,env,shared.package!.path);assert.equal(restored.status,'restored',JSON.stringify(restored.check));
  const projectId=restored.projectId!,base=workflowSnapshot(cold,f.id),config={...f.config,home:coldHome,stateDbPath:join(coldHome,'state/harness.db'),workspaceRoot:workspace,toolRoot:base.toolRoot};
  assert.equal(cold.prepare("SELECT COUNT(*) n FROM event WHERE entity_type='stage_contract' AND action='selected'").get()!.n,0);
  assert.ok(restoreReconciliation(cold,projectId)!.next.some(text=>/缺少已采用的修复包 reviewed-repair/.test(text)));
  assert.ok(completeRestore(cold,env,projectId).some(result=>!result.bound&&/reviewed-repair/.test(result.text)));
  const id=activateProduction(cold,projectId,{activationId:'missing-repair',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  const before=f.starts.length;for(let i=0;i<2;i++)await serveOnce(cold,config);
  let request=cold.prepare('SELECT * FROM production_continuation WHERE id=?').get(id)!;
  assert.equal(request.state,'waiting',JSON.stringify(request));assert.equal(request.successor_workflow_id,null);assert.equal(f.starts.length,before);assert.equal(productionHead(cold,projectId),f.id);
  assert.match(continuationProgress(cold,projectId).application!.reason,/缺少已采用的修复包 reviewed-repair/);
  const installed=join(coldHome,'managed/packs/reviewed-repair');cpSync(repair,installed,{recursive:true});writeFileSync(join(installed,'tools/tool.mjs'),'wrong bytes with the same ID and version');
  assert.ok(completeRestore(cold,env,projectId).some(result=>!result.bound));await serveOnce(cold,config);assert.equal(f.starts.length,before);
  writeFileSync(join(installed,'tools/tool.mjs'),'');
  const completed=completeRestore(cold,env,projectId);assert.ok(completed.some(result=>result.bound&&/reviewed-repair/.test(result.text)),JSON.stringify(completed));
  assert.equal(cold.prepare('SELECT revision FROM face_preference WHERE project_id=?').get(projectId)!.revision,1,'repairing Run inputs must not invent a new face adoption');
  const count=Number(cold.prepare("SELECT COUNT(*) n FROM event WHERE entity_type='stage_contract' AND action='selected'").get()!.n);assert.equal(count,1);
  completeRestore(cold,env,projectId);assert.equal(Number(cold.prepare("SELECT COUNT(*) n FROM event WHERE entity_type='stage_contract' AND action='selected'").get()!.n),count);
  for(const run of originalInputs){assert.ok(readRunInputSnapshot(cold,run),'Historical Run input recovered');assert.ok(readRunInputSnapshot(cold,run)!.stageToolSelection.selectionSeq);}
  const retained=JSON.parse(String(cold.prepare('SELECT document_json FROM production_archive_reference').get()!.document_json));assert.ok(!retained.missingInputs.some((key:string)=>key.startsWith('stage-contract')));
  assert.ok(!restoreReconciliation(cold,projectId)!.next.some(text=>/缺少已采用的修复包/.test(text)));
  assert.ok(f.project.startsWith(f.config.workspaceRoot));rmSync(f.project,{recursive:true});
  for(let i=0;i<6;i++)await serveOnce(cold,config);
  request=cold.prepare('SELECT * FROM production_continuation WHERE id=?').get(id)!;assert.equal(request.state,'applied',JSON.stringify(request));
  const starts=f.starts.slice(before);assert.deepEqual(starts.map(start=>start.run.stageId),['setup','face','outfit']);
  for(const start of starts){assert.equal(start.toolRoot,join(installed,'tools'));assert.ok(readRunInputSnapshot(cold,start.run.runId)!.stageToolSelection.selectionSeq);assert.ok(start.manifest.assets[0].item.startsWith(workspace));}
});

for(const tamper of [false,true])test(`a real cold share restores frozen preparation producers and continues through managed Runtime rebuilding${tamper?' with a changed receipt retained explicitly':''}`, {skip:!has7z},async t=>{
  const f=fixture(t,false,true,false,false,true);for(let i=0;i<4;i++)await f.tick();
  const exports=join(f.home,'exports');mkdirSync(exports);const shared=await exportShare(f.db,{home:f.home,exportRoot:exports},f.projectId,{layers:['A']});
  assert.equal(shared.status,'exported',JSON.stringify(shared.plan.blockers));
  const coldHome=join(f.home,'receiver'),coldWorkspace=join(f.config.workspaceRoot,'receiver');mkdirSync(join(coldHome,'state'),{recursive:true});mkdirSync(coldWorkspace);
  cpSync(join(f.home,'managed'),join(coldHome,'managed'),{recursive:true});
  const cold=openDatabase(join(coldHome,'state/harness.db'));t.after(()=>cold.close());
  const restored=await restoreShare(cold,{home:coldHome,workspaceRoot:coldWorkspace,workflowVariables:{}},shared.package!.path);
  assert.equal(restored.status,'restored',JSON.stringify(restored.check));
  const snapshot=workflowSnapshot(cold,f.id),asset=snapshot.manifest!.assets[0]!;assert.equal(asset.sha256,f.snapshot.manifest!.assets[0]!.sha256);assert.equal(sha256File(asset.item),asset.sha256);assert.ok(asset.item.startsWith(coldWorkspace));
  const producer=(db:typeof cold)=>JSON.parse(String(db.prepare("SELECT r.result_json FROM stage_completion c JOIN run r ON r.id=c.run_id WHERE c.workflow_id=? AND c.stage_id='plan'").get(f.id)!.result_json));
  assert.deepEqual(producer(cold).verifiedArtifactHashes,producer(f.db).verifiedArtifactHashes);
  const receipt=cold.prepare('SELECT id FROM project_restore WHERE project_id=?').get(restored.projectId!)!;const receiptPath=`_harness/share/restore-${String(receipt.id).slice(0,8)}.json`;
  if(tamper)writeFileSync(join(coldWorkspace,'sample',receiptPath),'Unreviewed receipt edit');
  const config={...f.config,home:coldHome,stateDbPath:join(coldHome,'state/harness.db'),workspaceRoot:coldWorkspace,toolRoot:snapshot.toolRoot};
  activateProduction(cold,restored.projectId!,{activationId:'cold-real-share',mode:'manual',manualSessionId:'s1',expectedRevision:0});
  const before=f.starts.length;for(let i=0;i<6;i++)await serveOnce(cold,config);
  let request=cold.prepare('SELECT * FROM production_continuation').get()!;let preparation=JSON.parse(String(request.preparation_json));
  assert.equal(preparation.sourceKind,'frozen_rebuild');
  if(tamper){assert.equal(request.state,'preparing');assert.deepEqual(preparation.report.unknown.map((f:any)=>f.path),[receiptPath]);
    resolveRebuildChanges(cold,restored.projectId!,String(request.id),1,preparation.report.hash,[receiptPath],'Retain the edited restore receipt only in the predecessor');
    for(let i=0;i<6;i++)await serveOnce(cold,config);request=cold.prepare('SELECT * FROM production_continuation').get()!;
  }else assert.deepEqual(preparation.report.unknown,[]);
  assert.equal(request.state,'applied',JSON.stringify(request));
  assert.deepEqual(f.starts.slice(before).map(s=>s.run.stageId),['setup','face','outfit']);
  assert.ok(f.starts.slice(before).every(s=>s.toolRoot.startsWith(coldHome)));
  assert.ok(!continuationProgress(cold,restored.projectId!).missingInputs?.length);
  const face=f.starts.slice(before).find(s=>s.run.stageId==='face')!;assert.equal(face.plan.face.manualSessionId,'s1');
  assert.equal(aggregateWorkflow(cold,face.run.workflowId,snapshot.definition).stages.outfit!.status,'passed');
});

test('active outfit writer is reconciled with old snapshot before successor is copied', async t => {
  const f=fixture(t); await f.tick(); await f.tick(); f.hold(true); await f.tick();
  const old=f.starts.at(-1)!; assert.equal(old.run.stageId,'outfit');
  activateProduction(f.db,f.projectId,{activationId:'accepted-s1',mode:'manual',manualSessionId:'s1',expectedRevision:0});
  await f.tick(); assert.equal(f.db.prepare('SELECT state FROM production_continuation').get()!.state,'waiting');
  const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const api=await ApiClient.connect(f.home);f.beforeCleanup(async()=>{api.close();await service.stop();});
  const progress=await api.call<any>('project.production.versions',{projectId:f.projectId});assert.equal(progress.requirement.manualVersion,1);assert.equal(progress.making.mode,'preserve');assert.equal(progress.making.runId,old.run.runId);assert.equal(progress.making.inputHash,readRunInputSnapshot(f.db,old.run.runId)!.baseline.face_input);
  const frozenSnapshot=f.db.prepare('SELECT * FROM run_input_snapshot WHERE run_id=?').get(old.run.runId)!;f.db.exec('DROP TRIGGER run_input_snapshot_no_update');
  f.db.prepare("UPDATE run_input_snapshot SET effective_plan_json='{}' WHERE run_id=?").run(old.run.runId);
  const missing=await api.call<any>('project.production.versions',{projectId:f.projectId});assert.equal(missing.making.mode,'unknown');assert.ok(missing.missingInputs.includes('producing-input:'+old.run.runId));
  f.db.prepare('UPDATE run_input_snapshot SET effective_plan_json=? WHERE run_id=?').run(frozenSnapshot.effective_plan_json!,old.run.runId);
  assert.equal(f.db.prepare('SELECT successor_workflow_id FROM production_continuation').get()!.successor_workflow_id,null);
  assert.equal(readRunInputSnapshot(f.db,old.run.runId)!.plan.face.mode,'preserve');
  f.restart(); f.hold(false); await f.tick(); await f.tick();
  assert.equal(f.db.prepare('SELECT state,error FROM production_continuation').get()!.state,'applied',JSON.stringify(f.db.prepare('SELECT state,error FROM production_continuation').get()));
  assert.equal(f.starts.at(-1)!.plan.face.manualSessionId,'s1');
});

// Windows host measurement: ~292.8s unloaded; descendant reruns can exceed 300s under full-suite load.
test('same-byte replacement and rollback rerun every face descendant under the inherited tool contract', { timeout: 900_000 }, async t => {
  const f=fixture(t,false,false,true);
  for(let i=0;i<12;i++)await f.tick();
  const accept = async()=>{ const head=productionHead(f.db,f.projectId)!;const gate=formalGates(f.db,head)[0]!;await decideFormalGate(f.db,f.config,head,'delivery',true,'accept tested package',gate.artifactHash,undefined,undefined,gate.inputHashes);await f.tick(); };
  await accept();
  const modes=['s1','s2','s1']; let revision=0;
  for(const mode of modes) {
    activateProduction(f.db,f.projectId,{activationId:`apply-${revision}`,mode:'manual',manualSessionId:mode,expectedRevision:revision++});
    const before=f.starts.length;
    for(let i=0;i<11;i++)await f.tick();
    const starts=f.starts.slice(before);
    assert.deepEqual(starts.map(s=>s.run.stageId),['face','outfit','recolor','menu','build_pre','regression_pre','optimize','build','regression','performance','package']);
    assert.ok(starts.every(s=>s.plan.face.manualSessionId===mode && s.toolRoot===f.snapshot.toolRoot));
    assert.equal(JSON.parse(starts[0]!.manual!).values.key,mode==='s1'?0:1);
    await accept();
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_continuation').get()!.n,3);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_delivery').get()!.n,4);
  assert.equal(f.db.prepare('SELECT COUNT(DISTINCT face_input_hash) n FROM production_delivery').get()!.n,4);
});

test('logical upload gate follows the managed successor and exposes its pending gate to the GUI project workspace',async t=>{
  const f=fixture(t,false,false,true);for(let i=0;i<12;i++)await f.tick();
  const accept=async()=>{const head=productionHead(f.db,f.projectId)!,gate=formalGates(f.db,head)[0]!;
    await decideFormalGate(f.db,f.config,head,'delivery',true,'Accept the independently checked synthetic package',gate.artifactHash,undefined,undefined,gate.inputHashes);await f.tick();};
  await accept();assert.equal(f.db.prepare('SELECT status FROM workflow WHERE id=?').get(f.id)!.status,'client_verified');
  const service=new RuntimeService({home:f.home,scheduler:false});await service.start();const api=await ApiClient.connect(f.home);f.beforeCleanup(async()=>{api.close();await service.stop();});
  const upload=()=>api.call('project.upload.open',{projectId:f.projectId});
  await assert.rejects(upload,/尚未配置 Unity 编辑器路径/);
  activateProduction(f.db,f.projectId,{activationId:'upload-current-requirement',mode:'manual',manualSessionId:'s1',expectedRevision:0});
  await assert.rejects(upload,/交付还没通过验证/,'pending adoption cannot upload the superseded requirements');
  await f.tick();assert.notEqual(productionHead(f.db,f.projectId),f.id);
  await assert.rejects(upload,/交付还没通过验证/,'an active successor cannot borrow its accepted predecessor status');
  for(let i=0;i<10;i++)await f.tick();
  const projects=await api.call<Array<{id:string;path:string;workflow?:{id:string}}>>('project.list');
  const gates=await api.call<Array<{gate:string;workflowId:string;project:string;status:string}>>('gate.list');
  const logical=projects.find(project=>project.id===f.projectId)!;
  const pending=gates.filter(gate=>gate.status==='pending');
  assert.ok(pending.length,'the successor must expose a real pending decision');
  assert.ok(projectRowsForWorkflow(pending,logical.path,logical.workflow?.id).length,
    'the main page/workbench ownership rule must retain the successor gate even when its physical path changed');
  await accept();
  await assert.rejects(upload,/尚未配置 Unity 编辑器路径/,'the accepted successor passes the status gate');
});

test('interrupted copy resumes its persisted checklist and duplicate adoption produces one successor', async t => {
  const f=fixture(t);await f.tick();await f.tick();
  const id=activateProduction(f.db,f.projectId,{activationId:'copy-resume',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  let calls=0; await advanceProductionContinuations(f.db,f.config,()=>++calls<4);
  const partial=f.db.prepare('SELECT preparation_json,state FROM production_continuation WHERE id=?').get(id)!;
  assert.ok(partial.preparation_json); assert.equal(f.db.prepare('SELECT successor_workflow_id FROM production_continuation').get()!.successor_workflow_id,null);
  f.restart(); activateProduction(f.db,f.projectId,{activationId:'copy-resume',mode:'manual',manualSessionId:'s1',expectedRevision:0});
  await f.tick();await f.tick();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_continuation WHERE successor_workflow_id IS NOT NULL').get()!.n,1);
  assert.equal(f.starts.at(-1)!.plan.face.manualSessionId,'s1');
});

test('cancelled preparation keeps old output and needs an explicit current-revision resume', async t => {
  const f=fixture(t);await f.tick();await f.tick();
  const id=activateProduction(f.db,f.projectId,{activationId:'cancel-copy',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  controlContinuation(f.db,f.projectId,id,1,false); await f.tick();
  assert.equal(productionHead(f.db,f.projectId),f.id); assert.equal(f.starts.length,2);
  assert.equal(readFileSync(join(f.project,'face.txt'),'utf8'),'identical bytes for every input');
  controlContinuation(f.db,f.projectId,id,1,true);await f.tick();
  assert.notEqual(productionHead(f.db,f.projectId),f.id);
});

test('filesystem failure does not enable a partial successor or overwrite existing destination bytes', async t => {
  const f=fixture(t);await f.tick();await f.tick();
  const id=activateProduction(f.db,f.projectId,{activationId:'disk-failure',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  const destination=join(f.config.workspaceRoot,`continuation-${id}`);mkdirSync(destination);
  writeFileSync(join(destination,'plan.json'),'unrelated existing bytes');
  await f.tick();
  assert.equal(f.db.prepare('SELECT state FROM production_continuation').get()!.state,'failed');
  assert.equal(f.db.prepare('SELECT successor_workflow_id FROM production_continuation').get()!.successor_workflow_id,null);
  assert.equal(readFileSync(join(destination,'plan.json'),'utf8'),'unrelated existing bytes');
  assert.equal(readFileSync(join(f.project,'face.txt'),'utf8'),'identical bytes for every input');
  rmSync(join(destination,'plan.json'));controlContinuation(f.db,f.projectId,id,1,true);await f.tick();
  assert.equal(f.db.prepare('SELECT state FROM production_continuation').get()!.state,'applied');
});

test('failure to persist the continuation rolls back preference, formal revision and activation event together', async t => {
  const f=fixture(t);await f.tick();
  f.db.exec("CREATE TRIGGER reject_continuation BEFORE INSERT ON production_continuation BEGIN SELECT RAISE(ABORT,'simulated disk persistence failure'); END");
  assert.throws(()=>activateProduction(f.db,f.projectId,{activationId:'lost-acceptance',mode:'manual',manualSessionId:'s1',expectedRevision:0}),/persistence failure/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM face_preference').get()!.n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM workflow_input_revision').get()!.n,0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM event WHERE action='face_input_adopted'").get()!.n,0);
});

test('shipped browser rollback drives Runtime and exposes retained accepted delivery files', {skip:process.env.AVH_GUI_IT!=='1',timeout:600_000}, async t=>{
  const {headlessBrowser,testBrowser}=await import('../fixtures/headless-browser.ts');
  if(!testBrowser){t.skip('No test browser');return;}
  const {runGui}=await import('../../src/gui/server.ts');
  const f=fixture(t,false,false,true);
  for(let i=0;i<12;i++)await f.tick();
  const gate=formalGates(f.db,f.id)[0]!;await decideFormalGate(f.db,f.config,f.id,'delivery',true,'Accept fixture delivery',gate.artifactHash,undefined,undefined,gate.inputHashes);
  await f.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_delivery').get()!.n,1);
  const unknown='Assets/AnotherPublisher/review-note.txt';mkdirSync(join(f.project,'Assets/AnotherPublisher'),{recursive:true});writeFileSync(join(f.project,unknown),'Late user change requiring baseline reconciliation');
  const service=new RuntimeService({home:f.home,scheduler:false});await service.start();
  const controller=new AbortController();let resolveAddress!:(url:string)=>void;
  const address=new Promise<string>(resolve=>resolveAddress=resolve);
  const gui=runGui(f.home,{open:false,signal:controller.signal,onReady:resolveAddress});
  void gui.catch(error=>{console.error('GUI startup:',error);resolveAddress('');});
  let browser:Awaited<ReturnType<typeof headlessBrowser>>|undefined;
  f.beforeCleanup(async()=>{try{await browser?.close();controller.abort();await gui;}finally{await service.stop();}});
  const profile=mkdtempSync(join(tmpdir(),'avh-browser-continuation-'));
  f.beforeCleanup(async()=>removeTemp(profile));
  browser=await headlessBrowser(profile);
  await browser.send('Page.navigate',{url:await address});
  await browser.waitFor("Boolean(document.querySelector('[data-nav=projects]'))");
  await browser.click('关闭回传','.dialog button');await browser.waitFor("!document.querySelector('.dialog-backdrop')");
  await browser.evaluate("document.querySelector('[data-nav=projects]').click()");
  await browser.click('sample','.project-card');
  await browser.click('工作面');
  await browser.click('已接受的脸型版本');
  await browser.click('回退到此版本');
  await browser.waitFor("document.body.innerText.includes('将') && document.body.innerText.includes('对应版本')");
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_continuation').get()!.n,1);
  await f.tick();
  assert.equal(productionHead(f.db,f.projectId),f.id);
  await browser.waitFor("document.body.innerText.includes('以下旧工程修改无法确认来源') && document.body.innerText.includes('AnotherPublisher/review-note.txt')");
  await browser.click('这些修改仅保留在旧工程','label');
  await browser.evaluate(`(()=>{const input=document.querySelector('[aria-label="对账说明"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Retain the reviewed user note only in the predecessor');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await browser.click('记录对账并继续制作');
  const {waitUntil}=await import('../fixtures/wait.ts');
  await waitUntil(()=>Boolean(f.db.prepare("SELECT 1 FROM event WHERE action='changes_resolved'").get()),{what:'the GUI reconciliation API to persist its report-bound human decision',timeoutMs:30_000});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM event WHERE action='changes_resolved'").get()!.n,1);
  await f.tick();
  assert.notEqual(productionHead(f.db,f.projectId),f.id);
  assert.equal(f.starts.at(-1)!.plan.face.manualSessionId,'s2');
  await browser.waitFor("document.body.innerText.includes('正在制作对应版本')");
  await browser.click('最后接受的交付物与历史版本');await browser.click('查看交付文件');
  await browser.waitFor("document.body.innerText.includes('交付文件与接受时的内容一致')");
  if(process.env.AVH_GUI_EVIDENCE_DIR){const {mkdirSync,writeFileSync}=await import('node:fs');mkdirSync(process.env.AVH_GUI_EVIDENCE_DIR,{recursive:true});
    const shot=await browser.send('Page.captureScreenshot',{format:'png'});writeFileSync(join(process.env.AVH_GUI_EVIDENCE_DIR,'continuation-browser.png'),Buffer.from(shot.data,'base64'));}
});

test('cancellation and superseding adoption during an actual async copy cannot publish an obsolete successor',async t=>{
  const f=fixture(t);await f.tick();await f.tick();
  const id=activateProduction(f.db,f.projectId,{activationId:'cancel-in-flight',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  const preparing=advanceProductionContinuations(f.db,f.config);
  controlContinuation(f.db,f.projectId,id,1,false);await preparing;
  assert.equal(f.db.prepare('SELECT state FROM production_continuation WHERE id=?').get(id)!.state,'cancelled');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_continuation WHERE successor_workflow_id IS NOT NULL').get()!.n,0);
  controlContinuation(f.db,f.projectId,id,1,true);
  const oldCopy=advanceProductionContinuations(f.db,f.config);
  activateProduction(f.db,f.projectId,{activationId:'supersede-in-flight',mode:'manual',manualSessionId:'s2',expectedRevision:1});await oldCopy;
  assert.equal(f.db.prepare('SELECT state FROM production_continuation WHERE id=?').get(id)!.state,'superseded');
  await f.tick();
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_continuation WHERE successor_workflow_id IS NOT NULL').get()!.n,1);
  assert.equal(f.starts.at(-1)!.plan.face.manualSessionId,'s2');
});

test('publication refuses a target created during copy and preserves those independent bytes',async t=>{
  const f=fixture(t);await f.tick();await f.tick();
  const id=activateProduction(f.db,f.projectId,{activationId:'publish-race',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  const destination=join(f.config.workspaceRoot,`continuation-${id}`),target=join(destination,'plan.json');
  const {existsSync}=await import('node:fs');let injected=false;
  await advanceProductionContinuations(f.db,f.config,()=>{
    if(!injected && existsSync(`${target}.avh-copying`)){writeFileSync(target,'concurrent independent bytes');injected=true;}return true;
  });
  assert.equal(injected,true);
  assert.equal(readFileSync(target,'utf8'),'concurrent independent bytes');
  assert.equal(f.db.prepare('SELECT state FROM production_continuation').get()!.state,'failed');
  assert.equal(f.db.prepare('SELECT successor_workflow_id FROM production_continuation').get()!.successor_workflow_id,null);
});

/**
 * Preparation copies and reconciles a whole project before it publishes. A lease taken over meanwhile must stop the
 * round rather than publish a successor under the new owner, and must not be recorded as this continuation's
 * failure. Without the guard every stage below writes anyway.
 */
test('a lease lost during continuation preparation stops the round instead of failing the continuation', async t => {
  const f=fixture(t);await f.tick();await f.tick();
  const id=activateProduction(f.db,f.projectId,{activationId:'lease-lost',mode:'manual',manualSessionId:'s1',expectedRevision:0})!;
  await assert.rejects(advanceProductionContinuations(f.db,f.config,()=>true,()=>{throw new SchedulerLeaseLostError();}),
    /Scheduler lease lost/);
  assert.equal(f.db.prepare('SELECT state FROM production_continuation WHERE id=?').get(id)!.state,'requested',
    'a lost lease is not recorded as this continuation\'s failure');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM production_continuation WHERE successor_workflow_id IS NOT NULL').get()!.n,0,
    'no successor is published under a lease the cycle no longer owns');
});

/**
 * The project-idle verdict a preparation copy consults per file is three queries, one of which scans the Task table
 * (rows carry whole prompts, so a scan reads megabytes of pages: measured 10.7 ms per check against 0.14 ms cached).
 * On a real 25,237-file baseline that paid once per file read on the order of a hundred gigabytes and held one
 * scheduler round for fifteen minutes. `idleOnCadence` reuses only a "still idle" verdict, and the copy still asks
 * its guard for every file, so the caller's own conditions — cancellation, drift — are answered as promptly as
 * before. Setting the shipped window to zero makes the first assertion fail.
 */
test('the project-idle verdict of a preparation copy is reused only inside a recheck window', async t => {
  let checks = 0;
  const idle = (): boolean => { checks++; return true; };
  const shipped = idleOnCadence(idle);
  for (let call = 0; call < 40; call++) assert.equal(shipped(), true);
  assert.equal(checks, 1, 'the shipped window answers a whole burst from one verdict');
  checks = 0;
  const perCall = idleOnCadence(idle, 0);
  for (let call = 0; call < 40; call++) assert.equal(perCall(), true);
  assert.equal(checks, 40, 'a zero window asks every time');
  // Only a "still idle" verdict is reused. Inside its window the copy can miss a project that just became busy — the
  // bounded blind spot this window buys — but a "not idle" verdict is never reused, and a zero window asks every time.
  checks = 0;
  let busy = false;
  const cadence = idleOnCadence(() => { checks++; return !busy; }, 60_000);
  assert.equal(cadence(), true);
  busy = true;
  assert.equal(cadence(), true, 'inside the window the previous "still idle" verdict is reused');
  assert.equal(checks, 1, 'and the database was not asked again');
  const perCall2 = idleOnCadence(() => { checks++; return !busy; }, 0);
  assert.equal(perCall2(), false, 'a zero window asks every time and sees the busy project');
  assert.equal(perCall2(), false);
  t.after(() => { /* no files are created: this test only exercises the cadence */ });
});

/**
 * The copy still consults its guard for every file: the cadence belongs to the database verdict, not to the loop, so
 * a caller that stops the copy (cancellation, a lost lease, source drift) is answered on the file it happens on.
 */
test('a preparation copy asks its guard for every file even when the idle verdict is reused', async t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-copy-guard-'));
  t.after(() => removeTemp(root));
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  const files = Array.from({ length: 40 }, (_, index) => {
    const path = `f${index}.txt`;
    writeFileSync(join(source, path), `content ${index}\n`);
    return { path, sha256: sha256File(join(source, path)) };
  });
  let calls = 0;
  // The shape a caller uses: its own condition AND the cached idle verdict, evaluated for every file.
  const guard = (): boolean => ++calls < 4 && idleOnCadence(() => true)();
  await assert.rejects(copyProductionManifest(source, join(root, 'copy'), files, guard), /准备已停止/);
  assert.equal(calls, 4, 'the caller\'s own condition is asked once per file, and it stopped the copy on the fourth');
});

