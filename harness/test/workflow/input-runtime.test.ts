import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify } from 'yaml';
import { loadConfig } from '../../src/config.ts';
import { openDatabase } from '../../src/state/db.ts';
import { buildAggregateInput, aggregateWorkflow } from '../../src/state/aggregate-input.ts';
import { serveOnce, TaskRouter } from '../../src/task-cli.ts';
import { createWorkflow, workflowSnapshot, workflowScheduler, StageRouter, formalGates, decideFormalGate } from '../../src/workflow/runtime.ts';
import { activateFaceInput, readRunInputSnapshot } from '../../src/workflow/inputs.ts';
import type { RunSpec, RunHandle, RunResult } from '../../src/runtime/interfaces.ts';
import { removeTemp } from '../fixtures/platform.ts';
import { Scheduler } from '../../src/runtime/scheduler.ts';
import { RuntimeService } from '../../src/api/server.ts';
import { ApiClient } from '../../src/api/client.ts';
import { withStateEvent } from '../../src/state/tx.ts';

function fixture(t: TestContext, gated = false, planProducer = false) {
  const root = mkdtempSync(join(tmpdir(), 'avh-input-runtime-')), home = join(root, 'home');
  let cleanup = () => removeTemp(root); t.after(() => cleanup());
  const project = join(root, 'workspace/sample'), tools = join(root, 'tools'), knowledge = join(root, 'knowledge');
  for (const path of [project, tools, join(tools, '审查/perception'), knowledge, join(home, 'config'), join(home, 'state')]) mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  writeFileSync(join(project, 'plan.json'), JSON.stringify({ face: { mode: 'preserve' } }));
  for (const file of ['tool.mjs', 'project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) writeFileSync(join(tools, file), '');
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: '1', t: {} }));
  const stages = ['face', 'outfit'].map((id, i) => ({ id, needs: i ? ['face'] : [], produces: [id], requires: [`${id}_ok`],
    gates: gated && id === 'outfit' ? ['accept'] : [], invalidated_by: ['plan', 'face_input'], source: 'fixture' }));
  if (planProducer) {
    stages[0]!.needs = ['plan'];
    stages.unshift({ id: 'plan', needs: [], produces: ['plan'], requires: ['plan_ok'], gates: [], invalidated_by: [], source: 'fixture' });
  }
  const definition = { schema: 'process/0.1', id: 'inputs', version: '1', applies_to: {}, artifacts: ['plan', 'face_input', 'face', 'outfit'], stages,
    checks: ['face', 'outfit'].map(id => ({ id: `${id}_ok`, observe: `${id}.read`, on: id, scope: 'edit', rule: 'ok == true', severity: 'blocking', maturity: 'accepted', source: 'fixture' })),
    gates: gated ? [{ id: 'accept', kind: 'approve', binds: 'outfit', source: 'fixture' }] : [], milestones: [] };
  const capabilities = { schema: 'capabilities/0.1', process: 'inputs', version: '1', artifacts: {
    plan: { paths: ['plan.json'], format: 'json' }, face_input: { source: { kind: 'runtime', input: 'face_input' } },
    face: { paths: ['face.txt'] }, outfit: { paths: ['outfit.txt'] } },
    stages: Object.fromEntries(['face', 'outfit'].map(id => [id, { mode: 'tool', command: ['node', '{toolRoot}/tool.mjs'], allowedWrites: [`${id}.txt`] }])),
    observers: Object.fromEntries(['face', 'outfit'].map(id => [`${id}.read`, { command: ['node', '{toolRoot}/observe.mjs', '{out}', '{runDir}'] }])) };
  if (planProducer) {
    definition.checks.push({ id: 'plan_ok', observe: 'plan.read', on: 'plan', scope: 'edit', rule: 'ok == true', severity: 'blocking', maturity: 'accepted', source: 'fixture' });
    capabilities.stages.plan = { mode: 'tool', command: ['node', '{toolRoot}/tool.mjs'], allowedWrites: ['plan.json'] };
    capabilities.observers['plan.read'] = { command: ['node', '{toolRoot}/observe.mjs', '{out}', '{runDir}'] };
  }
  writeFileSync(join(tools, 'observe.mjs'), `import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2],JSON.stringify({schema:'observation/0.1',metrics:{ok:true},notes:[process.env.AVH_PLAN,process.env.AVH_ACCEPTED_MANUAL_FACE_SHA256??'']}));`);
  writeFileSync(join(knowledge, 'process.yaml'), stringify(definition)); writeFileSync(join(knowledge, 'capabilities.yaml'), stringify(capabilities));
  writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: join(root, 'workspace'), toolRoot: tools, knowledgeRoot: knowledge,
    exportRoots: [], knownBodies: [], projectAliases: {}, sampleNames: ['sample'], processDefinitions: { inputs: { definition: 'process.yaml', capabilities: 'capabilities.yaml' } },
    defaultProfile: 'inputs', thresholdsFile: 'thresholds.yaml', providers: [] }));
  const config = loadConfig(home), path = join(home, 'state/harness.db'); let db = openDatabase(path);
  const id = createWorkflow(db, config, project, 'inputs'), snapshot = workflowSnapshot(db, id);
  const projectId = String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(id)!.project_id);
  for (const [index, name] of ['s1', 's2'].entries()) {
    const values = { schema: 'manual-values/0.1', sourceSha256: 'a'.repeat(64), rendererPath: 'Body/Face', meshName: 'Face', values: { key: index }, submittedSha256: String(index).repeat(64) };
    db.prepare(`INSERT INTO face_manual_session(id,project_id,project_path,target_id,state,version,accepted_json)
      VALUES(?,?,?,'target','accepted',?,?)`).run(name, projectId, join(root, name), index + 1, JSON.stringify(values));
  }
  const starts: Array<{ run: RunSpec; plan: any; toolRoot: string; manual?: string }> = [];
  let hold = false, onStart: ((spec: RunSpec) => void) | undefined;
  t.mock.method(TaskRouter.prototype, 'canDispatch', () => true);
  t.mock.method(TaskRouter.prototype, 'start', function(this: TaskRouter, run: RunSpec): RunHandle {
    mkdirSync(join(home, 'runs', run.runId), { recursive: true });
    starts.push({ run, toolRoot: this.spec.tool!.env.AVH_TOOL_ROOT!, plan: JSON.parse(this.spec.tool!.env.AVH_PLAN!), ...(this.spec.tool!.env.AVH_ACCEPTED_MANUAL_FACE_SHA256 ? { manual: readFileSync(join(project, '_harness/face/accepted-manual.json'), 'utf8') } : {}) });
    onStart?.(run); return { ref: `fake-${run.runId}` };
  });
  t.mock.method(TaskRouter.prototype, 'observe', async () => ({ state: hold ? 'running' : 'exited' }));
  t.mock.method(TaskRouter.prototype, 'collect', async function(this: TaskRouter, handle: RunHandle): Promise<RunResult> {
    const started = starts.find(item => `fake-${item.run.runId}` === handle.ref)!;
    if (started.run.stageId === 'plan') writeFileSync(join(project, 'plan.json'), JSON.stringify({ face: { mode: 'preserve' }, changedOutput: true }));
    else writeFileSync(join(project, `${started.run.stageId}.txt`), 'identical bytes for every input');
    return { exitStatus: 0, outputs: {} };
  });
  cleanup = () => { if (db.isOpen) db.close(); removeTemp(root); };
  return { home, project, config, id, snapshot, starts, get db() { return db; },
    activate: (name: string, activationId = name) => activateFaceInput(db, id, { mode: name === 'preserve' ? 'preserve' : 'manual', manualSessionId: name, activationId }),
    hold: (value: boolean) => { hold = value; }, onStart: (fn?: (spec: RunSpec) => void) => { onStart = fn; },
    tick: async () => { await serveOnce(db, config); assert.equal(db.prepare("SELECT reason FROM event WHERE action='tick_failed' ORDER BY seq DESC LIMIT 1").get(), undefined); }, scheduler: () => workflowScheduler(db, config, id),
    restart: () => { db.close(); db = openDatabase(path); } };
}

test('accepted input invalidates completed preserve face before outfit can dispatch', async t => {
  const f = fixture(t); await f.tick();
  assert.equal(f.starts[0]!.plan.face.mode, 'preserve');
  assert.throws(() => f.db.prepare("UPDATE run_input_snapshot SET effective_plan_json='{}'").run(), /immutable/);
  assert.throws(() => f.db.prepare('DELETE FROM run_input_snapshot').run(), /retained/);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM stage_completion WHERE stage_id='face'").get()!.n, 1,
    JSON.stringify(f.db.prepare('SELECT action,reason FROM event ORDER BY seq').all()));
  f.activate('s1'); await f.tick();
  assert.deepEqual(f.starts.map(item => item.run.stageId), ['face', 'face']);
  assert.equal(f.starts[1]!.plan.face.manualSessionId, 's1');
  assert.equal(JSON.parse(f.starts[1]!.manual!).values.key, 0);
  await f.tick(); assert.equal(f.starts.at(-1)!.run.stageId, 'outfit');
});

test('same-byte s1 to s2 invalidates approval and rollback s1 cannot resurrect old completion', async t => {
  const f = fixture(t, true); f.activate('s1'); await f.tick(); await f.tick();
  const oldGate = formalGates(f.db, f.id)[0]!;
  await decideFormalGate(f.db, f.config, f.id, 'accept', true, 's1', oldGate.artifactHash, undefined, undefined, oldGate.inputHashes);
  await f.tick(); const oldCompletions = f.db.prepare('SELECT COUNT(*) n FROM stage_completion').get()!.n;
  f.activate('s2');
  assert.equal(formalGates(f.db, f.id)[0]!.status, 'stale');
  await assert.rejects(decideFormalGate(f.db, f.config, f.id, 'accept', true, 'old page', oldGate.artifactHash, undefined, undefined, oldGate.inputHashes), /变化/);
  await f.tick(); await f.tick();
  assert.equal(formalGates(f.db, f.id)[0]!.artifactHash, oldGate.artifactHash);
  assert.notEqual(formalGates(f.db, f.id)[0]!.status, 'approved');
  f.activate('s1', 'rollback-s1');
  assert.notEqual(aggregateWorkflow(f.db, f.id, f.snapshot.definition).stages.face!.status, 'passed');
  await f.tick(); assert.equal(f.starts.at(-1)!.plan.face.manualSessionId, 's1');
  assert.ok(Number(f.db.prepare('SELECT COUNT(*) n FROM stage_completion').get()!.n) > Number(oldCompletions));
});

test('a gate bound to runtime inputs names the missing --expect-inputs instead of claiming the inputs changed', async t => {
  const f = fixture(t, true); f.activate('s1'); await f.tick(); await f.tick();
  const gate = formalGates(f.db, f.id)[0]!;
  assert.ok(Object.values(gate.inputHashes!).some(Boolean), 'the fixture gate must be bound to a runtime input');
  await assert.rejects(decideFormalGate(f.db, f.config, f.id, 'accept', true, '看过方案', gate.artifactHash), (error: unknown) => {
    const message = String((error as Error).message);
    assert.match(message, /--expect-inputs/);
    assert.match(message, /face_input/);
    assert.ok(message.includes(JSON.stringify(gate.inputHashes!)), message);
    assert.doesNotMatch(message, /已变化/);
    return true;
  });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM gate_decision').get()!.n, 0);
  // The guard is a diagnosis, not a relaxation: the same decision with the shown token still goes through.
  await decideFormalGate(f.db, f.config, f.id, 'accept', true, 's1', gate.artifactHash, undefined, undefined, gate.inputHashes);
  assert.equal(formalGates(f.db, f.id)[0]!.status, 'approved');
});

for (const moment of ['running', 'verifying', 'human'] as const) test(`input change during ${moment}, then restart, keeps old Run input and rejects new-input completion`, async t => {
  const f = fixture(t, moment === 'human'); f.activate('s1');
  if (moment === 'running') f.hold(true);
  if (moment === 'verifying') {
    const verifier = f.scheduler().verifier;
    const verification = t.mock.method(Object.getPrototypeOf(verifier), 'verify', async () => {
      f.activate('s2');
      throw new Error('synthetic interruption before verification returns');
    });
    const interruption = t.mock.method(Scheduler.prototype as any, 'failVerification', () => {});
    // Leave the persisted state exactly where a terminated process would leave it, without rewriting Task facts.
    t.after(() => { verification.mock.restore(); interruption.mock.restore(); });
    (f as any).resumeVerification = () => { verification.mock.restore(); interruption.mock.restore(); };
  }
  await f.tick();
  if (moment === 'human') { await f.tick(); }
  const old = f.starts.at(-1)!, frozen = readRunInputSnapshot(f.db, old.run.runId)!;
  assert.equal(frozen.plan.face.manualSessionId, 's1');
  if (moment !== 'verifying') f.activate('s2');
  if (moment === 'verifying') {
    assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(old.run.taskId)!.status, 'VERIFYING');
    (f as any).resumeVerification();
  }
  f.onStart(); f.restart(); f.hold(false);
  assert.deepEqual(readRunInputSnapshot(f.db, old.run.runId), frozen);
  await f.scheduler().tick(() => false);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stage_completion WHERE run_id=?').get(old.run.runId)!.n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM out_of_bounds_change WHERE artifact='face_input'").get()!.n, 0);
  const observed = JSON.parse(readFileSync(join(f.home, 'runs', old.run.runId, 'checks', `observe-${old.run.stageId}.read`, 'metrics.json'), 'utf8'));
  assert.equal(JSON.parse(observed.notes[0]).face.manualSessionId, 's1');
  assert.equal(observed.notes[1], frozen.manualValuesSha256);
});

test('intended outbox replay after input and tool changes launches the original frozen s1 contract', async t => {
  const f = fixture(t); f.activate('s1');
  const interruption = t.mock.method(Scheduler.prototype, 'launch', async () => {});
  await f.tick(); interruption.mock.restore();
  assert.equal(f.starts.length, 0);
  const runId = String(f.db.prepare('SELECT id FROM run').get()!.id), frozen = readRunInputSnapshot(f.db, runId)!;
  assert.equal(f.db.prepare('SELECT status FROM dispatch_outbox').get()!.status, 'intended');
  assert.equal(frozen.plan.face.manualSessionId, 's1');
  f.activate('s2');
  const changed = structuredClone(f.snapshot); changed.toolRoot = join(f.home, 'unselected-new-tools');
  withStateEvent(f.db, { workflowId: f.id, actor: 'human', entityType: 'stage_contract', entityId: 'face', action: 'selected',
    reason: 'Fixture later tool selection', payload: { selection: { snapshot: changed, deployment: [] } } }, () => {});
  f.restart(); await f.scheduler().tick(() => true);
  assert.equal(f.starts[0]!.run.runId, runId);
  assert.equal(f.starts[0]!.plan.face.manualSessionId, 's1');
  assert.equal(f.starts[0]!.toolRoot, f.snapshot.toolRoot);
  assert.deepEqual(readRunInputSnapshot(f.db, runId), frozen);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stage_completion WHERE run_id=?').get(runId)!.n, 0);
});

test('preflight Router and persisted READY cannot reuse a spec compiled before adoption', async t => {
  const f = fixture(t); f.activate('s1');
  f.db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('ready',?,'face','fixture','face','READY')").run(f.id);
  const router = new StageRouter(f.db, f.config, f.snapshot);
  assert.equal(JSON.parse(router.router('ready').spec.tool!.env.AVH_PLAN!).face.manualSessionId, 's1');
  f.activate('s2'); await serveOnce(f.db, f.config, () => router);
  assert.equal(f.starts[0]!.plan.face.manualSessionId, 's2');
});

test('formal input adoption is not an executor file side effect when a stopped tool failure is retried', async t => {
  const f = fixture(t); f.activate('s1'); f.hold(true);
  const scheduler = f.scheduler(); scheduler.config.stageRetries!.face = 1;
  await scheduler.tick(() => true);
  const old = f.starts[0]!; f.activate('s2'); f.hold(false);
  t.mock.method(TaskRouter.prototype, 'collect', async () => ({ exitStatus: 1, outputs: {}, errorClass: 'tool_failure', noSideEffects: true }));
  await scheduler.tick(() => false);
  assert.equal(f.db.prepare('SELECT status FROM task WHERE id=?').get(old.run.taskId)!.status, 'READY');
  assert.equal(readRunInputSnapshot(f.db, old.run.runId)!.plan.face.manualSessionId, 's1');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM out_of_bounds_change').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stage_completion').get()!.n, 0);
});

test('new plan output is checked with the Run face revision rather than a later activation', async t => {
  const f = fixture(t, false, true); f.activate('s1'); f.hold(true); await f.tick();
  const old = f.starts[0]!; assert.equal(old.run.stageId, 'plan');
  f.activate('s2'); f.hold(false); await f.scheduler().tick(() => false);
  const observed = JSON.parse(readFileSync(join(f.home, 'runs', old.run.runId, 'checks', 'observe-plan.read', 'metrics.json'), 'utf8'));
  const outputPlan = JSON.parse(observed.notes[0]);
  assert.equal(outputPlan.changedOutput, true, 'check the produced plan instead of the earlier dispatch plan');
  assert.equal(outputPlan.face.manualSessionId, 's1', 'output readback must retain the Run input revision');
  assert.equal(observed.notes[1], old.run.inputSnapshot!.manualValuesSha256);
  assert.equal((buildAggregateInput(f.db, f.id).plan.face as { manualSessionId: string }).manualSessionId, 's2');
});

test('activation is idempotent, preserves base plan and tool package, and ignores draft preference revisions', t => {
  const f = fixture(t), before = f.db.prepare('SELECT plan_json,process_hash FROM workflow WHERE id=?').get(f.id);
  const first = f.activate('s1'), again = f.activate('s1'); assert.deepEqual(first, again);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM workflow_input_revision').get()!.n, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM event WHERE action='face_input_adopted'").get()!.n, 1);
  f.activate('s2'); assert.deepEqual(f.activate('s1'), first, 'replaying s1 must not move the current input backwards');
  assert.equal((buildAggregateInput(f.db, f.id).plan.face as { manualSessionId: string }).manualSessionId, 's2');
  assert.notEqual(f.activate('s1','rollback').faceInputHash, first.faceInputHash);
  assert.deepEqual(f.db.prepare('SELECT plan_json,process_hash FROM workflow WHERE id=?').get(f.id), before);
  const projectId = String(f.db.prepare('SELECT project_id FROM workflow WHERE id=?').get(f.id)!.project_id);
  f.db.prepare("INSERT INTO face_preference(project_id,mode,revision) VALUES(?,'ai',42)").run(projectId);
  assert.equal((buildAggregateInput(f.db, f.id).plan.face as { manualSessionId: string }).manualSessionId, 's1');
  assert.throws(() => activateFaceInput(f.db, f.id, { activationId: 'rollback', mode: 'preserve' }), /不同输入/);
  assert.throws(() => activateFaceInput(f.db, f.id, { activationId: 'stale', mode: 'preserve', expectedRevision: 0 }), /已变化/);
  assert.throws(() => f.db.prepare("UPDATE workflow_input_revision SET face_input_hash='fake'").run(), /immutable/);
});

test('legacy intended face Run without a snapshot is preserved for recovery, never filled from current input', async t => {
  const f = fixture(t); f.activate('s2');
  f.db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('legacy',?,'face','fixture','face','RUNNING')").run(f.id);
  f.db.prepare("INSERT INTO run(id,task_id,attempt,status) VALUES('legacy-run','legacy',1,'pending')").run();
  f.db.prepare("INSERT INTO dispatch_outbox(id,run_id) VALUES('legacy-outbox','legacy-run')").run();
  f.restart(); await f.tick();
  assert.equal(f.starts.length, 0); assert.equal(readRunInputSnapshot(f.db,'legacy-run'), undefined);
  assert.equal(f.db.prepare("SELECT status FROM task WHERE id='legacy'").get()!.status, 'RECOVERY_REQUIRED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stage_completion').get()!.n, 0);
});

for (const verified of [false, true]) test(`legacy VERIFYING face Run without snapshot cannot infer input (${verified ? 'persisted verdicts' : 'before verifier'})`, async t => {
  const f = fixture(t); f.activate('s2');
  // Upgrade residue has no snapshot, even when the former process contract did not declare face_input.
  f.db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('legacy',?,'face','fixture','face','VERIFYING')").run(f.id);
  f.db.prepare("INSERT INTO run(id,task_id,attempt,status,result_json) VALUES('legacy-run','legacy',1,'exited',?)")
    .run(JSON.stringify({ exitStatus: 0, outputs: {}, ...(verified ? { verdictIds: ['historic-verdict'] } : {}) }));
  f.restart();
  const scheduler = f.scheduler(), legacy = structuredClone(scheduler.definition);
  legacy.artifacts = legacy.artifacts.filter(id => id !== 'face_input');
  for (const stage of legacy.stages) stage.invalidated_by = stage.invalidated_by.filter(id => id !== 'face_input');
  await new Scheduler(f.db, f.id, legacy, scheduler.executor, scheduler.verifier, scheduler.fingerprinter, scheduler.config).tick(() => false);
  assert.equal(f.db.prepare("SELECT status FROM task WHERE id='legacy'").get()!.status, 'FAILED');
  assert.equal(readRunInputSnapshot(f.db, 'legacy-run'), undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM stage_completion').get()!.n, 0);
  assert.equal(f.starts.length, 0);
});

test('RuntimeService exposes the frozen input token and rejects an old same-byte gate page', async t => {
  const f = fixture(t, true); f.activate('s1'); await f.tick(); await f.tick();
  const service = new RuntimeService({ home: f.home, scheduler: false }); await service.start();
  const api = await ApiClient.connect(f.home);
  try {
    const old = (await api.call<any[]>('gate.list'))[0]!;
    assert.equal(old.inputHashes.face_input, buildAggregateInput(f.db,f.id).artifactHashes.face_input);
    f.activate('s2');
    await assert.rejects(api.call('gate.decide', { gate: old.gate, approve: true, note: 'old page', expectedHash: old.artifactHash, expectedInputs: old.inputHashes }), /变化/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM gate_decision').get()!.n, 0);
  } finally { api.close(); await service.stop(); }
});

test('a frozen legacy recolour Gate is projected with preview evidence through the real API', async t => {
  const f = fixture(t);
  const definition = structuredClone(f.snapshot.definition) as any;
  definition.artifacts.push('materials');
  definition.stages = [{ id: 'recolor', needs: [], produces: ['materials'], requires: [], gates: ['recolor_approval'], invalidated_by: [] }];
  definition.checks = [];
  definition.gates = [{ id: 'recolor_approval', kind: 'approve', binds: 'materials' }];
  f.db.exec('DROP TRIGGER workflow_definition_no_update');
  f.db.prepare('UPDATE workflow_definition SET definition_json=? WHERE workflow_id=?').run(JSON.stringify(definition), f.id);
  f.db.prepare("INSERT INTO artifact_version(workflow_id,kind,hash) VALUES(?,?,?)").run(f.id, 'materials', 'a'.repeat(64));
  const service = new RuntimeService({ home: f.home, scheduler: false }); await service.start();
  const api = await ApiClient.connect(f.home);
  try {
    const gates = await api.call<any[]>('gate.list');
    assert.equal(gates.length, 1);
    assert.equal(gates[0].gate, `${f.id}:recolor_approval`);
    assert.equal(gates[0].preview, 'recolor-candidates');
    assert.equal(gates[0].status, 'pending');
  } finally { api.close(); await service.stop(); }
});
