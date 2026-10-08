import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { ProcessDefinition, Verdict } from '../../src/process/types.ts';
import { openDatabase } from '../../src/state/db.ts';
import { acquireSchedulerLease } from '../../src/state/scheduler-lease.ts';
import { newFingerprintCadence, refreshFingerprints } from '../../src/runtime/reconcile.ts';
import type { Executor, Fingerprinter, Observation, RunHandle, RunResult, RunSpec, Verifier } from '../../src/runtime/interfaces.ts';
import { previewStatesForPlan, Scheduler } from '../../src/runtime/scheduler.ts';
import { UnitExecutor } from '../../src/exec/executor.ts';
import { TASK_EDGES, requestHumanRedo, transitionTask, type TaskStatus } from '../../src/runtime/transitions.ts';
import { deadPid, removeTemp } from '../fixtures/platform.ts';
import { waitUntil } from '../fixtures/wait.ts';
import { chooseSharing, sharingRecords } from '../../src/sharing/state.ts';
import { queueFinishedRun } from '../../src/sharing/producers.ts';
import { aggregateWorkflow } from '../../src/state/aggregate-input.ts';
import { taskRedo } from '../../src/task-cli.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-runtime-'));
  const path = join(dir, 'state.sqlite'); const db = openDatabase(path);
  t.after(() => { if (db.isOpen) db.close(); removeTemp(dir); });
  db.prepare("INSERT INTO workspace (id, path) VALUES ('ws', '/synthetic/workspace')").run();
  db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('p', 'ws', 'sample', '/synthetic/project', '{}', 'active', 'h', 'k')`).run();
  db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
    VALUES ('w', 'p', 'synthetic', 'hash', 'k', 'active', '{}')`).run();
  return { db, path };
}
function definition(gated = false, two = false, stageId = 'paint'): ProcessDefinition {
  const stage = (id: string) => ({ id, needs: [], produces: ['scene'], requires: ['quality'],
    gates: gated ? ['approval'] : [], invalidated_by: ['source'] });
  return { schema: 'process/0.1', id: 'synthetic', version: 'v1', applies_to: {},
    artifacts: ['source', 'scene', 'plan', 'extra'], stages: two ? [stage('paint'), stage('finish')] : [stage(stageId)],
    checks: [{ id: 'quality', observe: 'synthetic', on: 'scene', scope: 'edit', rule: 'synthetic',
      severity: 'blocking', maturity: 'accepted' }],
    gates: gated ? [{ id: 'approval', kind: 'approve', binds: 'plan' }] : [], milestones: [] };
}
class FakeExecutor implements Executor {
  canDispatch?: (resource: string) => boolean;
  confirmNeverStarted?: (runId: string) => boolean;
  starts: RunSpec[] = [];
  handles = new Map<string, RunHandle>();
  observed: Observation = { state: 'exited' };
  results: RunResult[] = [{ exitStatus: 0, outputs: {} }];
  onCollect?: () => void;
  start(spec: RunSpec): RunHandle {
    this.starts.push(spec);
    let handle = this.handles.get(spec.idempotencyKey);
    if (!handle) { handle = { ref: `handle-${spec.runId}` }; this.handles.set(spec.idempotencyKey, handle); }
    return handle;
  }
  observe(_handle: RunHandle): Observation { return this.observed; }
  cancel(_handle: RunHandle): 'confirmed' { return 'confirmed'; }
  collect(_handle: RunHandle): RunResult { this.onCollect?.(); return this.results.shift() ?? { exitStatus: 0, outputs: {} }; }
}
class FakeFingerprinter implements Fingerprinter {
  hashes: Record<string, string> = { source: 's1', scene: 'v1', plan: 'p1' };
  fingerprint(_workflowId: string, _kinds: string[]): Record<string, string> { return { ...this.hashes }; }
}
class FakeVerifier implements Verifier {
  result: Verdict['result'] | 'none' = 'pass'; count = 0;
  cancellation: 'confirmed' | 'not_confirmed' = 'confirmed';
  cancellations: RunSpec[] = [];
  cancel(spec: RunSpec): 'confirmed' | 'not_confirmed' {
    this.cancellations.push(spec);
    return this.cancellation;
  }
  verify(_spec: RunSpec, _result: RunResult, hashes: Record<string, string>): Verdict[] {
    if (this.result === 'none') return [];
    return [{ id: `verdict-${++this.count}`, checkId: 'quality', scope: 'edit',
      artifactHash: hashes.scene ?? '', result: this.result }];
  }
}
function setup(t: TestContext, gated = false, two = false, checkRetries = 0, stageId = 'paint') {
  const { db, path } = fixture(t);
  const executor = new FakeExecutor(); const fingerprinter = new FakeFingerprinter(); const verifier = new FakeVerifier();
  const process = definition(gated, two, stageId);
  const make = (database = db) => new Scheduler(database, 'w', process, executor, verifier, fingerprinter,
    { maxRetries: 1, stageCheckRetries: { [stageId]: checkRetries }, slotCapacity: { unity_batch: 1 },
      stageSlots: { paint: ['unity_batch'], finish: ['unity_batch'], [stageId]: ['unity_batch'] } });
  return { db, path, executor, fingerprinter, verifier, make };
}

test('preview state freezing follows RecolorStage fixed, exclusive, and independent rules', () => {
  assert.deepEqual(previewStatesForPlan({ outfits: [{ id: 'body', activation: 'fixed' }] }), ['original']);
  assert.deepEqual(previewStatesForPlan({ outfits: [{ id: 'body', activation: 'fixed' }, { id: 'kimono', activation: 'exclusive' }] }), ['kimono']);
  assert.deepEqual(previewStatesForPlan({ outfits: [{ id: 'hair', activation: 'independent' }] }), ['hair']);
  assert.deepEqual(previewStatesForPlan({ avatar_config: { groups: [
    { activation: 'fixed', members: [{ id: 'body' }] },
    { activation: 'exclusive', members: [{ id: 'kimono' }] },
    { activation: 'independent', members: [{ id: 'hair' }] },
    { kind: 'material', activation: 'exclusive', members: [{ id: 'warm' }, { id: 'cool' }] },
  ] } }), ['kimono', 'hair']);
});

test('Scheduler.finish saves the exit fact and closes the lock when render evidence collection throws', async t => {
  for (const shape of ['junction', 'file'] as const) {
    const x = setup(t, false, false, 0, 'recolor');
    const scheduler = x.make();
    x.executor.observed = { state: 'running' };
    await scheduler.tick();
    const runId = x.executor.starts[0]!.runId;
    assert.equal((x.db.prepare('SELECT status FROM task').get() as { status: string }).status, 'RUNNING');
    const runBase = join(dirname(dirname(x.path)), 'runs', runId);
    const candidatePath = join(runBase, 'candidates');
    mkdirSync(runBase, { recursive: true });
    if (shape === 'junction') {
      const target = join(dirname(runBase), `${runId}-candidate-target`);
      mkdirSync(target, { recursive: true });
      symlinkSync(target, candidatePath, 'junction');
      t.after(() => rmSync(target, { recursive: true, force: true }));
    } else writeFileSync(candidatePath, 'not a directory');
    x.db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason) VALUES('w','runtime','run',?,'unity_unit_intended','test')").run(runId);
    t.after(() => rmSync(runBase, { recursive: true, force: true }));
    await scheduler.finish(runId, { exitStatus: 0, outputs: {}, unitySteps: [{ index: 0, method: 'AVH.Harness.RecolorStage.Run', exitCode: 0,
      durationMs: 1, log: '', errors: [], waits: 0 }] });
    assert.equal((x.db.prepare('SELECT status FROM run WHERE id=?').get(runId) as { status: string }).status, 'exited', shape);
    assert.equal((x.db.prepare('SELECT status FROM task').get() as { status: string }).status, 'FAILED', shape);
    assert.equal((x.db.prepare('SELECT COUNT(*) n FROM lock').get() as { n: number }).n, 0, shape);
    assert.equal((x.db.prepare("SELECT COUNT(*) n FROM dispatch_outbox WHERE status <> 'closed'").get() as { n: number }).n, 0, shape);
    const result = JSON.parse(String((x.db.prepare('SELECT result_json FROM run WHERE id=?').get(runId) as { result_json: string }).result_json));
    assert.equal(result.errorClass, 'verifier_failure', shape);
    assert.match(result.previewEvidenceError, /证据未能完整采集/, shape);
    assert.doesNotMatch(result.previewEvidenceError, /[A-Za-z]:\\|\\\\|\/tmp\//, shape);
  }
});

test('safe pause drains the current Run through independent verification without paid repair or new stages', async t => {
  const x = setup(t, false, true, 2);
  x.make().definition.stages[1]!.needs = ['paint'];
  x.executor.observed = { state: 'running' };
  await x.make().tick();
  assert.equal(x.executor.starts.length, 1);
  const runId = x.executor.starts[0]!.runId;
  x.executor.observed = { state: 'exited' };
  x.verifier.result = 'violation';
  await x.make().tick(() => false);
  assert.equal(x.executor.starts.length, 1, 'the authorized repair remains READY but is not dispatched');
  assert.equal(x.db.prepare('SELECT status FROM run WHERE id=?').get(runId)!.status, 'exited');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM lock').get()!.n, 0);
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM task').get()!.n, 1, 'no next-stage Task created');
  assert.equal(x.db.prepare('SELECT status FROM task').get()!.status, 'READY');
  assert.equal(x.db.prepare('SELECT COUNT(*) n FROM verdict').get()!.n, 1);
});

test('safe pause cannot start an intended Run or release an unconfirmed unit lock', async t => {
  const x = setup(t);
  x.db.prepare(`INSERT INTO task(id,workflow_id,stage_id,goal,capability,status,retry_policy_json)
    VALUES('intended-task','w','paint','fixture','fixture','RUNNING','{"maxRetries":0}')`).run();
  x.db.prepare("INSERT INTO run(id,task_id,attempt,status) VALUES('intended-run','intended-task',1,'pending')").run();
  x.db.prepare("INSERT INTO dispatch_outbox(id,run_id,status) VALUES('intended-outbox','intended-run','intended')").run();
  await x.make().tick(() => false);
  assert.equal(x.executor.starts.length, 0);
  assert.equal(x.db.prepare('SELECT status FROM dispatch_outbox').get()!.status, 'intended');
  const y = setup(t);
  y.executor.observed = { state: 'running' };
  await y.make().tick();
  y.executor.observed = { state: 'unknown' };
  await y.make().tick(() => false);
  assert.equal(y.db.prepare('SELECT status FROM task').get()!.status, 'RECOVERY_REQUIRED');
  assert.equal(y.db.prepare('SELECT COUNT(*) n FROM lock').get()!.n, 2);
  assert.equal(y.db.prepare('SELECT status FROM run').get()!.status, 'running');
});

test('independent validator error blocks without issuing a paid engineering repair', async t => {
  for (const value of ['error'] as const) {
    const x = setup(t, false, false, 2);
    x.verifier.result = value;
    await x.make().tick();
    assert.equal(x.db.prepare('SELECT status FROM task').get()!.status, 'BLOCKED', value);
    await x.make().tick();
    assert.equal(x.executor.starts.length, 1, value);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM lock').get()!.n, 0, value);
    assert.equal(x.db.prepare('SELECT status FROM run').get()!.status, 'exited', value);
  }
});

test('repairable missing output or ordinary no-data evidence retains bounded AI repair', async t => {
  for (const value of ['no_data', 'undecidable', 'none'] as const) {
    const x = setup(t, false, false, 2);
    x.verifier.result = value;
    await x.make().tick();
    assert.equal(x.db.prepare('SELECT status FROM task').get()!.status, 'READY', value);
    await x.make().tick();
    assert.equal(x.executor.starts.length, 2, value);
  }
  const x = setup(t, false, false, 2);
  delete x.fingerprinter.hashes.scene;
  await x.make().tick();
  assert.equal(x.db.prepare('SELECT status FROM task').get()!.status, 'READY', 'missing expected output');
});

test('a real independent violation still gets the explicitly authorized bounded repair', async t => {
  const x = setup(t, false, false, 2);
  x.verifier.result = 'violation';
  await x.make().tick();
  await x.make().tick();
  assert.equal(x.executor.starts.length, 2);
  assert.equal(x.db.prepare('SELECT status FROM task').get()!.status, 'READY');
});

test('finished Runtime failure queues a single-provider report without private input, and a replay is deduplicated', async t => {
  const x = setup(t);
  chooseSharing(x.db, { surface: 'gui', noticeShown: true, enabled: true });
  x.db.prepare('INSERT INTO provider_snapshot (workflow_id, snapshot_json) VALUES (?, ?)').run('w', JSON.stringify({
    providers: [{ config: { id: 'private-account-key-label', adapter: 'pi-cli', upstream: 'deepseek', model: 'private-model-label' } }],
  }));
  x.executor.onCollect = () => x.db.prepare('UPDATE run SET provider = ?').run('private-account-key-label');
  x.executor.results = [{ exitStatus: 1, errorClass: 'timeout', outputs: { private: 'private-input-image.jpg' },
    errorMessage: 'private-account-path-and-secret' }];
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['FAILED']);
  const records = sharingRecords(x.db);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.record.model, 'deepseek');
  assert.equal(records[0]!.record.action, 'provider-run');
  assert.equal(records[0]!.record.outcome, 'failure');
  assert.equal(records[0]!.record.error, 'timeout');
  assert.doesNotMatch(JSON.stringify(records[0]!.record), /private|task|workflow|runId|secret|path|image/);
  const run = x.db.prepare('SELECT id FROM run').get() as { id: string };
  assert.deepEqual(queueFinishedRun(x.db, run.id), { queued: false, reason: 'duplicate' });
});

test('Runtime never harvests unconsented work or a Run started before joining, and sharing failure does not stop production', async t => {
  for (const choice of ['unseen', 'off', 'late', 'queue-error'] as const) {
    const x = setup(t);
    if (choice === 'off') chooseSharing(x.db, { surface: 'gui', noticeShown: true, enabled: false });
    if (choice === 'queue-error') {
      chooseSharing(x.db, { surface: 'gui', noticeShown: true, enabled: true });
      x.db.exec("CREATE TRIGGER reject_test_record BEFORE INSERT ON sharing_record BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END");
    }
    if (choice === 'late') x.executor.onCollect = () => {
      chooseSharing(x.db, { surface: 'gui', noticeShown: true, enabled: true });
      x.db.prepare("UPDATE dispatch_outbox SET intended_at = '2000-01-01T00:00:00Z', launched_at = '2000-01-01T00:00:00Z'").run();
    };
    await x.make().tick();
    assert.deepEqual(statuses(x.db), ['PASSED'], choice);
    assert.equal(sharingRecords(x.db).length, 0, choice);
    if (choice === 'queue-error') {
      const failure = x.db.prepare("SELECT reason FROM event WHERE entity_type = 'sharing' AND action = 'queue_failed'").get() as { reason: string };
      assert.doesNotMatch(failure.reason, /private diagnostic/);
    }
  }
});

test('confirmed running cancellation queues a cancelled report through the same Runtime boundary', async t => {
  const x = setup(t);
  chooseSharing(x.db, { surface: 'gui', noticeShown: true, enabled: true });
  x.executor.observed = { state: 'running' };
  x.executor.results = [{ exitStatus: 143, outputs: {} }];
  const scheduler = x.make();
  await scheduler.tick();
  const task = x.db.prepare('SELECT id FROM task').get() as { id: string };
  assert.equal((await scheduler.cancelTask(task.id, 'private cancellation request')).confirmed, true);
  assert.equal(sharingRecords(x.db)[0]!.record.outcome, 'cancelled');
  assert.equal(sharingRecords(x.db)[0]!.record.error, undefined);
  assert.doesNotMatch(JSON.stringify(sharingRecords(x.db)[0]!.record), /private/);
});
function statuses(db: DatabaseSync): string[] {
  return (db.prepare('SELECT status FROM task ORDER BY rowid').all() as { status: string }[]).map(x => x.status);
}
function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function seedPending(db: DatabaseSync, outbox: 'intended' | 'launched', status: TaskStatus = 'RUNNING') {
  db.prepare(`INSERT INTO task (id, workflow_id, stage_id, goal, capability, status)
    VALUES ('task-seed', 'w', 'paint', 'synthetic', 'paint', ?)`).run(status);
  db.prepare(`INSERT INTO run (id, task_id, attempt, status, process_ref)
    VALUES ('run-seed', 'task-seed', 1, ?, ?)`).run(outbox === 'intended' ? 'pending' : 'running', outbox === 'intended' ? null : 'handle-seed');
  db.prepare("INSERT INTO dispatch_outbox (id, run_id) VALUES ('outbox-seed', 'run-seed')").run();
  if (outbox === 'launched') db.prepare("UPDATE dispatch_outbox SET status = 'launched' WHERE id = 'outbox-seed'").run();
  db.prepare("INSERT INTO lock (resource, run_id, fencing, lease_until) VALUES ('project:p', 'run-seed', 1, '9999-12-31')").run();
}

test('success requires current output and Verdict; outbox reaches acked', async t => {
  const x = setup(t); await x.make().tick();
  assert.deepEqual(statuses(x.db), ['PASSED']); assert.equal(count(x.db, 'stage_completion'), 1);
  assert.equal(x.executor.starts[0]?.idempotencyKey, x.executor.starts[0]?.runId);
  assert.equal((x.db.prepare('SELECT status FROM dispatch_outbox').get() as { status: string }).status, 'acked');
});
test('success with missing output or Verdict remains BLOCKED', async t => {
  const x = setup(t); delete x.fingerprinter.hashes.scene; x.verifier.result = 'none';
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['BLOCKED']);
  assert.equal(count(x.db, 'stage_completion'), 0);
});
test('successful exit with expected output but no Verdict remains BLOCKED', async t => {
  const x = setup(t); x.verifier.result = 'none';
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['BLOCKED']);
  assert.equal(count(x.db, 'verdict'), 0);
});
test('Gate pending waits; human decision resumes verification', async t => {
  const x = setup(t, true); await x.make().tick(); assert.deepEqual(statuses(x.db), ['WAITING_HUMAN']);
  x.db.prepare("INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result) VALUES ('w', 'approval', 'p1', 'approved')").run();
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['PASSED']);
});
test('blocking check violation becomes BLOCKED', async t => {
  const x = setup(t); x.verifier.result = 'violation'; await x.make().tick(); assert.deepEqual(statuses(x.db), ['BLOCKED']);
});
test('independent check evidence authorizes a bounded automatic repair Run', async t => {
  const x = setup(t, false, false, 1); x.verifier.result = 'violation';
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['READY']);
  assert.equal(x.executor.starts.length, 1);
  x.verifier.result = 'pass';
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['PASSED']);
  assert.equal(x.executor.starts.length, 2);
  assert.equal((x.db.prepare('SELECT max(attempt) AS n FROM run').get() as { n: number }).n, 2);
});

test('redoing a passed stage with empty reason codes records the new completion and stays passed', async t => {
  const x = setup(t);
  x.db.prepare(`INSERT INTO workflow_definition (workflow_id, profile, definition_json, capabilities_json, thresholds_json, tool_root)
    VALUES ('w', 'synthetic', ?, '{}', '{}', '')`).run(JSON.stringify(x.make().definition));
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['PASSED']);
  const firstTask = x.executor.starts[0]!.taskId;
  const before = aggregateWorkflow(x.db, 'w', x.make().definition).stages.paint!;
  assert.equal(before.status, 'passed');
  assert.deepEqual(before.reasonCodes, [], 'the earlier completion remains valid during a same-output redo');

  taskRedo(x.db, firstTask, 'Revalidate the unchanged synthetic output');
  await x.make().tick();
  assert.equal(x.executor.starts.length, 2, 'the redo actually executes and verifies another Run');
  const secondRun = x.executor.starts[1]!;
  assert.notEqual(secondRun.taskId, firstTask);
  assert.deepEqual(statuses(x.db), ['PASSED', 'PASSED']);
  assert.equal(count(x.db, 'stage_completion'), 2);
  assert.ok(x.db.prepare('SELECT 1 FROM stage_completion WHERE run_id = ?').get(secondRun.runId),
    'the new Task completes using its own verified Run, not only the previous completion');
  assert.equal(count(x.db, 'lock'), 0);
  assert.equal((x.db.prepare("SELECT COUNT(*) AS n FROM event WHERE action LIKE '%->WAITING_HUMAN'").get() as { n: number }).n, 0);
});
test('unaccepted warning waits; acceptance resumes verification', async t => {
  const x = setup(t); x.verifier.result = 'violation';
  const scheduler = x.make(); scheduler.definition.checks[0]!.severity = 'warning';
  await scheduler.tick(); assert.deepEqual(statuses(x.db), ['WAITING_HUMAN']);
  const verdictId = (x.db.prepare('SELECT id FROM verdict').get() as { id: string }).id;
  x.db.prepare('INSERT INTO warning_acceptance (workflow_id, verdict_id) VALUES (?, ?)').run('w', verdictId);
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['PASSED']);
});
test('out-of-bounds fingerprint change waits for human', async t => {
  const x = setup(t); x.executor.onCollect = () => { x.fingerprinter.hashes.extra = 'e1'; };
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['WAITING_HUMAN']);
  assert.equal(count(x.db, 'out_of_bounds_change'), 1);
});
test('workspace path outside project reaches rule 8 and waits for human', async t => {
  const x = setup(t);
  x.executor.results = [{ exitStatus: 0, outputs: {}, outOfBoundsPaths: ['another-project/file.txt'] }];
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['WAITING_HUMAN']);
  assert.deepEqual((x.db.prepare('SELECT artifact FROM out_of_bounds_change').all() as { artifact: string }[])
    .map(row => row.artifact), ['workspace:another-project/file.txt']);
});
test('confirmed cancellation records outside workspace changes before releasing locks', async t => {
  const x = setup(t);
  seedPending(x.db, 'launched');
  x.executor.results = [{ exitStatus: 143, outputs: {}, outOfBoundsPaths: ['other/file.txt'] }];
  assert.deepEqual(await x.make().cancelTask('task-seed', 'stop'), { confirmed: true });
  assert.deepEqual(statuses(x.db), ['CANCELLED']);
  assert.equal(count(x.db, 'lock'), 0);
  const run = x.db.prepare("SELECT status, result_json FROM run WHERE id = 'run-seed'").get() as
    { status: string; result_json: string };
  assert.equal(run.status, 'cancelled');
  assert.equal(JSON.parse(run.result_json).exitStatus, 143);
  assert.equal(JSON.parse(run.result_json).cancellationNote, 'stop');
  assert.equal((x.db.prepare("SELECT status FROM dispatch_outbox WHERE run_id = 'run-seed'").get() as { status: string }).status, 'closed');
  assert.deepEqual((x.db.prepare('SELECT artifact FROM out_of_bounds_change').all() as { artifact: string }[])
    .map(row => row.artifact), ['workspace:other/file.txt']);
});
test('live legacy dsh Unity handoff blocks dispatch, then allows it when released', async t => {
  const x = setup(t);
  const lockPath = join(dirname(x.path), 'handoff.lock');
  writeFileSync(lockPath, JSON.stringify({ kind: 'unity', holder: 'dsh', pid: process.pid, since: 'now' }));
  const unit = new UnitExecutor({ projectDirectory: '/synthetic/project',
    workspaceRepository: '/synthetic/workspace', runRoot: dirname(x.path),
    writableByRunner: { shell: [] }, handoffLockPath: lockPath,
    commandFor: () => ({ argv: ['true'], runner: 'shell' }) });
  x.executor.canDispatch = resource => unit.canDispatch(resource);
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['READY']);
  assert.equal(x.executor.starts.length, 0);
  rmSync(lockPath);
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['PASSED']);
});
test('a Unity handoff left by a process that exited does not block the scheduler', async t => {
  const x = setup(t);
  const lockPath = join(dirname(x.path), 'handoff.lock');
  writeFileSync(lockPath, JSON.stringify({ kind: 'unity', holder: 'dsh', pid: deadPid(), since: '2020-01-01T00:00:00.000Z' }));
  const unit = new UnitExecutor({ projectDirectory: '/synthetic/project',
    workspaceRepository: '/synthetic/workspace', runRoot: dirname(x.path),
    writableByRunner: { shell: [] }, handoffLockPath: lockPath,
    commandFor: () => ({ argv: ['true'], runner: 'shell' }) });
  x.executor.canDispatch = resource => unit.canDispatch(resource);
  t.mock.method(console, 'error', () => {});
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['PASSED'], 'a crashed holder no longer stops dispatch for good');
  assert.equal(x.executor.starts.length, 1);
  assert.equal(existsSync(lockPath), false, 'the gate reclaimed the crashed holder\'s lock');
});
test('launched Run restart becomes RECOVERY_REQUIRED without second start', async t => {
  const x = setup(t); seedPending(x.db, 'launched'); x.executor.observed = { state: 'unknown' };
  x.db.close(); const reopened = openDatabase(x.path);
  try { await x.make(reopened).tick(); assert.deepEqual(statuses(reopened), ['RECOVERY_REQUIRED']);
    assert.equal(x.executor.starts.length, 0); assert.equal(count(reopened, 'lock'), 1); }
  finally { reopened.close(); }
});
test('a Run whose state cannot be established says why in its recovery reason', async t => {
  const x = setup(t); seedPending(x.db, 'launched');
  x.executor.observe = () => { throw new Error('busctl: connection reset\nsecond line'); };
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['RECOVERY_REQUIRED']);
  const reason = (x.db.prepare("SELECT reason FROM event WHERE action = 'RUNNING->RECOVERY_REQUIRED'").get() as { reason: string }).reason;
  assert.match(reason, /executor state unknown; preserve locks and do not redispatch: 查询执行单元出错：busctl: connection reset$/);
  const y = setup(t); seedPending(y.db, 'launched'); y.executor.observed = { state: 'unknown' };
  await y.make().tick();
  assert.match((y.db.prepare("SELECT reason FROM event WHERE action = 'RUNNING->RECOVERY_REQUIRED'").get() as { reason: string }).reason,
    /执行单元状态无法确认/);
});
test('intended-only restart launches same Run once', async t => {
  const x = setup(t); seedPending(x.db, 'intended'); x.executor.observed = { state: 'running' };
  x.db.close(); const reopened = openDatabase(x.path);
  try { await x.make(reopened).tick(); assert.deepEqual(statuses(reopened), ['RUNNING']);
    assert.equal(x.executor.starts.length, 1); assert.equal(x.executor.starts[0]?.runId, 'run-seed');
    assert.equal(count(reopened, 'run'), 1); }
  finally { reopened.close(); }
});
test('VERIFYING restart resumes verifier and reuses a partially written Verdict', async t => {
  const x = setup(t);
  x.db.prepare(`INSERT INTO task (id, workflow_id, stage_id, goal, capability, status)
    VALUES ('task-seed', 'w', 'paint', 'synthetic', 'paint', 'VERIFYING')`).run();
  x.db.prepare(`INSERT INTO run (id, task_id, attempt, status, result_json)
    VALUES ('run-seed', 'task-seed', 1, 'exited', ?)`).run(JSON.stringify({ exitStatus: 0, outputs: {} }));
  x.db.prepare(`INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result)
    VALUES ('run-seed:quality', 'w', 'quality', 'edit', 'v1', 'pass')`).run();
  x.db.close(); const reopened = openDatabase(x.path);
  try { await x.make(reopened).tick(); assert.deepEqual(statuses(reopened), ['PASSED']);
    assert.equal(count(reopened, 'verdict'), 1); assert.equal(x.executor.starts.length, 0); }
  finally { reopened.close(); }
});
test('two READY Tasks in one project dispatch one writer', async t => {
  const x = setup(t, false, true); x.executor.observed = { state: 'running' };
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['RUNNING', 'READY']);
  assert.equal(x.executor.starts.length, 1); assert.equal(count(x.db, 'lock'), 2);
});
test('named global slot capacity blocks a second project', async t => {
  const x = setup(t); x.executor.observed = { state: 'running' };
  x.db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('p2', 'ws', 'sample', '/synthetic/project2', '{}', 'active', 'h', 'k')`).run();
  x.db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
    VALUES ('w2', 'p2', 'synthetic', 'hash', 'k', 'active', '{}')`).run();
  await x.make().tick();
  const second = new Scheduler(x.db, 'w2', definition(), x.executor, x.verifier, x.fingerprinter,
    { maxRetries: 1, slotCapacity: { unity_batch: 1 }, stageSlots: { paint: ['unity_batch'] } });
  await second.tick();
  assert.deepEqual(statuses(x.db), ['RUNNING', 'READY']);
  assert.equal(x.executor.starts.length, 1);
});
test('changed upstream fingerprint creates new Task and retains PASSED history', async t => {
  const x = setup(t); await x.make().tick(); x.fingerprinter.hashes.source = 's2'; await x.make().tick();
  assert.deepEqual(statuses(x.db), ['PASSED', 'PASSED']); assert.equal(count(x.db, 'task'), 2);
});
test('rate limit retries with new Run; uncertain timeout does not', async t => {
  const x = setup(t); x.executor.results = [
    { exitStatus: 1, errorClass: 'rate_limit', retryAfter: '2000-01-01T00:00:00.000Z', outputs: {} }, { exitStatus: 0, outputs: {} },
  ];
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['READY']);
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['PASSED']);
  assert.deepEqual((x.db.prepare('SELECT attempt FROM run ORDER BY attempt').all() as { attempt: number }[]).map(r => r.attempt), [1, 2]);
  assert.deepEqual((x.db.prepare('SELECT fencing FROM lock_epoch ORDER BY resource').all() as { fencing: number }[])
    .map(row => row.fencing), [2, 2]);
  const y = setup(t); y.executor.results = [{ exitStatus: 1, errorClass: 'timeout', outputs: {} }];
  await y.make().tick(); await y.make().tick(); assert.deepEqual(statuses(y.db), ['FAILED']);
  assert.equal(count(y.db, 'run'), 1);
});
test('confirmed harmless timeout retries once; later rate limit waits without consuming retries', async t => {
  const x = setup(t); x.executor.results = [
    { exitStatus: 1, errorClass: 'timeout', noSideEffects: true, outputs: {} },
    { exitStatus: 1, errorClass: 'rate_limit', outputs: {} },
  ];
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['READY']);
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['READY']);
  await x.make().tick(); assert.deepEqual(statuses(x.db), ['READY']);
  assert.equal(count(x.db, 'run'), 2);
});
test('rate limit with maxRetries zero waits until retryAfter then dispatches', async t => {
  const x = setup(t);
  x.executor.results = [{ exitStatus: 1, errorClass: 'rate_limit', retryAfter: '9999-01-01T00:00:00.000Z', outputs: {} },
    { exitStatus: 0, outputs: {} }];
  const scheduler = () => new Scheduler(x.db, 'w', definition(), x.executor, x.verifier, x.fingerprinter,
    { maxRetries: 0, slotCapacity: {} });
  await scheduler().tick(); assert.deepEqual(statuses(x.db), ['READY']);
  await scheduler().tick(); assert.equal(count(x.db, 'run'), 1);
  assert.equal((x.db.prepare("SELECT count(*) n FROM event WHERE action='route_waiting'").get() as { n: number }).n, 1);
  const row = x.db.prepare('SELECT id, result_json FROM run LIMIT 1').get() as { id: string; result_json: string };
  x.db.prepare('UPDATE run SET result_json=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.result_json),
    retryAfter: '2000-01-01T00:00:00.000Z' }), row.id);
  await scheduler().tick(); assert.deepEqual(statuses(x.db), ['PASSED']);
  assert.equal(count(x.db, 'run'), 2);
});
test('rate limits do not charge the outfit independent-check repair budget', async t => {
  const x = setup(t, false, false, 4, 'outfit');
  x.executor.results = Array.from({ length: 4 }, () =>
    ({ exitStatus: 1, errorClass: 'rate_limit' as const, retryAfter: '2000-01-01T00:00:00.000Z', outputs: {} }));
  x.verifier.result = 'violation';
  for (let i = 0; i < 4; i++) {
    await x.make().tick();
    assert.deepEqual(statuses(x.db), ['READY'], `rate limit ${i + 1} waits without consuming a check repair`);
  }
  for (let i = 0; i < 4; i++) {
    await x.make().tick();
    assert.deepEqual(statuses(x.db), ['READY'], `independent violation ${i + 1} receives its configured repair`);
  }
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['BLOCKED'], 'the fifth independently verified violation exhausts four repairs');
  assert.equal(count(x.db, 'run'), 9);
  assert.equal((x.db.prepare("SELECT COUNT(*) AS n FROM event WHERE entity_type='run' AND action='verified'").get() as { n: number }).n, 5);

  const passing = setup(t, false, false, 4, 'outfit');
  await passing.make().tick();
  assert.deepEqual(statuses(passing.db), ['PASSED']);
  assert.equal(count(passing.db, 'run'), 1, 'a passing independent check never schedules a repair Run');
});
test('authorization start failure waits for human; uncertain start stops for recovery', async t => {
  const x = setup(t); x.executor.start = () => {
    throw Object.assign(new Error('authorization required'), { errorClass: 'auth', noSideEffects: true });
  };
  await x.make().tick(); await x.make().tick(); assert.deepEqual(statuses(x.db), ['WAITING_HUMAN']);
  const y = setup(t); let starts = 0;
  y.executor.start = () => { starts++; throw Object.assign(new Error('unknown start'), { errorClass: 'timeout' }); };
  await y.make().tick(); await y.make().tick(); assert.deepEqual(statuses(y.db), ['RECOVERY_REQUIRED']);
  assert.equal(starts, 1); assert.equal(count(y.db, 'lock'), 2);
});
test('preparation scan failure closes Run, records error, and releases locks after retries', async t => {
  const x = setup(t);
  x.executor.start = () => { throw Object.assign(new Error('synthetic scan limit'), {
    errorClass: 'tool_failure', noSideEffects: true,
  }); };
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['READY']);
  assert.equal(count(x.db, 'lock'), 0);
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['FAILED']);
  assert.equal(count(x.db, 'lock'), 0);
  const runs = x.db.prepare('SELECT status, result_json FROM run ORDER BY attempt').all() as
    { status: string; result_json: string }[];
  assert.equal(runs.length, 2);
  assert.ok(runs.every(run => run.status === 'exited' && run.result_json.includes('synthetic scan limit')));
  assert.deepEqual((x.db.prepare('SELECT status FROM dispatch_outbox').all() as { status: string }[])
    .map(row => row.status), ['closed', 'closed']);
});
test('cancelling a never-started Run confirms absence and releases locks', async t => {
  const x = setup(t);
  seedPending(x.db, 'intended');
  x.executor.confirmNeverStarted = () => true;
  assert.deepEqual(await x.make().cancelTask('task-seed', 'human confirmed absent'), { confirmed: true, releasedLocks: 1 });
  assert.deepEqual(statuses(x.db), ['CANCELLED']);
  assert.equal((x.db.prepare("SELECT status FROM run WHERE id = 'run-seed'").get() as { status: string }).status, 'cancelled');
  assert.equal((x.db.prepare("SELECT status FROM dispatch_outbox WHERE run_id = 'run-seed'").get() as { status: string }).status, 'closed');
  assert.equal(count(x.db, 'lock'), 0);
});
test('RECOVERY_REQUIRED cancellation closes a never-started Run', async t => {
  const x = setup(t);
  seedPending(x.db, 'intended', 'RECOVERY_REQUIRED');
  x.executor.confirmNeverStarted = () => true;
  assert.deepEqual(await x.make().cancelTask('task-seed', 'human confirmed absent'),
    { confirmed: true, releasedLocks: 1 });
  assert.deepEqual(statuses(x.db), ['CANCELLED']);
  assert.equal((x.db.prepare("SELECT status FROM run WHERE id = 'run-seed'").get() as { status: string }).status, 'cancelled');
  assert.equal(count(x.db, 'lock'), 0);
});

for (const [i, edge] of TASK_EDGES.entries()) test(`edge ${edge.from} -> ${edge.to} [${edge.proof}] writes event`, t => {
  const { db } = fixture(t);
  const id = `edge-${i}`;
  db.prepare('INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'w', 'paint', 'synthetic', 'paint', edge.from);
  if (['run_intended', 'run_exited', 'unknown_run', 'start_uncertain', 'retry_authorized'].includes(edge.proof)) {
    db.prepare('INSERT INTO run (id, task_id, attempt, status, result_json) VALUES (?, ?, 1, ?, ?)')
      .run(`run-${i}`, id, ['run_intended', 'start_uncertain'].includes(edge.proof) ? 'pending' : 'exited',
        edge.proof === 'retry_authorized' && edge.from === 'RUNNING' ? JSON.stringify({ errorClass: 'rate_limit' }) : null);
    db.prepare('INSERT INTO dispatch_outbox (id, run_id) VALUES (?, ?)').run(`out-${i}`, `run-${i}`);
    if (edge.proof === 'unknown_run') db.prepare("UPDATE dispatch_outbox SET status = 'launched' WHERE run_id = ?").run(`run-${i}`);
  }
  if (edge.proof === 'verified') {
    db.prepare('INSERT INTO run (id, task_id, attempt, status) VALUES (?, ?, 1, ?)')
      .run(`run-${i}`, id, 'exited');
    db.prepare('INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json, run_id) VALUES (?, ?, ?, ?)')
      .run('w', 'paint', '{}', `run-${i}`);
  }
  if (edge.proof === 'human_approved' || edge.proof === 'human_requested_redo') {
    db.prepare("INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason) VALUES ('w', 'runtime', 'task', ?, 'VERIFYING->WAITING_HUMAN', 'fixture')").run(id);
    if (edge.proof === 'human_approved') {
      db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('w', 'plan', 'p1')").run();
      db.prepare("INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result) VALUES ('w', 'approval', 'p1', 'approved')").run();
    } else requestHumanRedo(db, id, 'fixture redo');
  }
  if (edge.proof === 'cancel_confirmed' && edge.from === 'VERIFYING') {
    db.prepare('INSERT INTO run (id, task_id, attempt, status) VALUES (?, ?, 1, ?)')
      .run(`run-${i}`, id, 'exited');
    db.prepare("INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason) VALUES ('w', 'runtime', 'run', ?, 'verification_cancel_confirmed', 'fixture')")
      .run(`run-${i}`);
  }
  if (edge.proof !== 'ready')
    assert.throws(() => transitionTask(db, id, edge.to, 'ready', 'wrong proof'), /Invalid Task transition/);
  const before = (db.prepare('SELECT count(*) AS n FROM event WHERE entity_id = ?').get(id) as { n: number }).n;
  transitionTask(db, id, edge.to, edge.proof, `edge ${i}`);
  assert.equal((db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status, edge.to);
  assert.equal((db.prepare('SELECT count(*) AS n FROM event WHERE entity_id = ?').get(id) as { n: number }).n, before + 1);
});
test('table-external transition and empty reason are rejected', t => {
  const { db } = fixture(t);
  db.prepare("INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES ('edge', 'w', 'paint', 'synthetic', 'paint', 'READY')").run();
  assert.throws(() => transitionTask(db, 'edge', 'PASSED', 'verified', 'outside table'), /Invalid Task transition/);
  assert.throws(() => transitionTask(db, 'edge', 'CANCELLED', 'cancel_confirmed', ''), /reason is required/);
});

test('transition table has one target per state and proof', () => {
  const targets = new Map<string, string>();
  for (const edge of TASK_EDGES) {
    const key = `${edge.from}:${edge.proof}`;
    assert.equal(targets.get(key) ?? edge.to, edge.to, key);
    targets.set(key, edge.to);
  }
});

test('human approval requires a later decision bound to the current artifact hash', t => {
  const { db } = fixture(t);
  db.prepare("INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES ('human', 'w', 'paint', 'synthetic', 'paint', 'WAITING_HUMAN')").run();
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('w', 'plan', 'p1')").run();
  db.prepare("INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result) VALUES ('w', 'approval', 'p1', 'approved')").run();
  db.prepare("INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason) VALUES ('w', 'runtime', 'task', 'human', 'VERIFYING->WAITING_HUMAN', 'fixture')").run();
  assert.throws(() => transitionTask(db, 'human', 'VERIFYING', 'human_approved', 'old decision'), /Guard human_approved/);
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('w', 'plan', 'p2')").run();
  db.prepare("INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result) VALUES ('w', 'approval', 'p1', 'approved')").run();
  assert.throws(() => transitionTask(db, 'human', 'VERIFYING', 'human_approved', 'stale decision'), /Guard human_approved/);
  db.prepare("INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result) VALUES ('w', 'approval', 'p2', 'approved')").run();
  transitionTask(db, 'human', 'VERIFYING', 'human_approved', 'current decision');
  assert.deepEqual(statuses(db), ['VERIFYING']);
});

test('warning acceptance after waiting requires a current Verdict hash', t => {
  const { db } = fixture(t);
  db.prepare("INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES ('warning', 'w', 'paint', 'synthetic', 'paint', 'WAITING_HUMAN')").run();
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('w', 'scene', 'v1')").run();
  db.prepare("INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result) VALUES ('warning-v1', 'w', 'quality', 'edit', 'v1', 'violation')").run();
  db.prepare("INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason) VALUES ('w', 'runtime', 'task', 'warning', 'VERIFYING->WAITING_HUMAN', 'fixture')").run();
  db.prepare("INSERT INTO warning_acceptance (workflow_id, verdict_id) VALUES ('w', 'warning-v1')").run();
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('w', 'scene', 'v2')").run();
  assert.throws(() => transitionTask(db, 'warning', 'VERIFYING', 'human_approved', 'stale warning'), /Guard human_approved/);
  db.prepare("INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result) VALUES ('warning-v2', 'w', 'quality', 'edit', 'v2', 'violation')").run();
  db.prepare("INSERT INTO warning_acceptance (workflow_id, verdict_id) VALUES ('w', 'warning-v2')").run();
  transitionTask(db, 'warning', 'VERIFYING', 'human_approved', 'current warning');
  assert.deepEqual(statuses(db), ['VERIFYING']);
});

test('out-of-bounds acceptance requires current hash and is recorded after waiting', t => {
  const { db } = fixture(t);
  db.prepare("INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES ('bounds', 'w', 'paint', 'synthetic', 'paint', 'WAITING_HUMAN')").run();
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('w', 'extra', 'e1')").run();
  db.prepare("INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact, accepted) VALUES ('w', 'paint', 'extra', 1)").run();
  db.prepare("INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason) VALUES ('w', 'runtime', 'task', 'bounds', 'VERIFYING->WAITING_HUMAN', 'fixture')").run();
  assert.throws(() => transitionTask(db, 'bounds', 'VERIFYING', 'human_approved', 'old acceptance'), /Guard human_approved/);
  db.prepare("INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact) VALUES ('w', 'paint', 'extra')").run();
  db.prepare("UPDATE out_of_bounds_change SET accepted = 1 WHERE seq = 2").run();
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('w', 'extra', 'e2')").run();
  assert.throws(() => transitionTask(db, 'bounds', 'VERIFYING', 'human_approved', 'stale acceptance'), /Guard human_approved/);
  db.prepare("INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact, accepted) VALUES ('w', 'paint', 'extra', 1)").run();
  transitionTask(db, 'bounds', 'VERIFYING', 'human_approved', 'current acceptance');
  assert.deepEqual(statuses(db), ['VERIFYING']);
});

test('human redo requires a later human request and scheduler starts a new Run', async t => {
  const x = setup(t, true);
  await x.make().tick();
  const id = (x.db.prepare('SELECT id FROM task').get() as { id: string }).id;
  assert.throws(() => transitionTask(x.db, id, 'READY', 'human_requested_redo', 'no request'), /Guard human_requested_redo/);
  requestHumanRedo(x.db, id, 'redo the stage');
  x.executor.observed = { state: 'running' };
  await x.make().tick();
  assert.deepEqual(statuses(x.db), ['RUNNING']);
  assert.equal(count(x.db, 'run'), 2);
  assert.throws(() => requestHumanRedo(x.db, id, 'late'), /WAITING_HUMAN/);
});

test('VERIFYING cancellation waits for verifier stop confirmation', async t => {
  const x = setup(t);
  x.db.prepare("INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES ('verify', 'w', 'paint', 'synthetic', 'paint', 'VERIFYING')").run();
  x.db.prepare("INSERT INTO run (id, task_id, attempt, status, result_json) VALUES ('run-verify', 'verify', 1, 'exited', '{}')").run();
  assert.throws(() => transitionTask(x.db, 'verify', 'CANCELLED', 'cancel_confirmed', 'unconfirmed'), /verifier stop confirmation/);
  x.verifier.cancellation = 'not_confirmed';
  assert.deepEqual(await x.make().cancelTask('verify', 'stop verifier'), { confirmed: false });
  assert.deepEqual(statuses(x.db), ['VERIFYING']);
  x.verifier.cancellation = 'confirmed';
  assert.deepEqual(await x.make().cancelTask('verify', 'stop verifier'), { confirmed: true });
  assert.deepEqual(statuses(x.db), ['CANCELLED']);
  assert.equal(x.verifier.cancellations.length, 2);
});

test('verified requires completion for latest Run of this Task, not an old Task or Run', t => {
  const { db } = fixture(t);
  for (const id of ['old', 'new']) db.prepare('INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'w', 'paint', 'synthetic', 'paint', 'VERIFYING');
  db.prepare("INSERT INTO run (id, task_id, attempt, status) VALUES ('old-run', 'old', 1, 'exited')").run();
  db.prepare("INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json, run_id) VALUES ('w', 'paint', '{}', 'old-run')").run();
  db.prepare("INSERT INTO run (id, task_id, attempt, status) VALUES ('new-run-1', 'new', 1, 'exited')").run();
  assert.throws(() => transitionTask(db, 'new', 'PASSED', 'verified', 'old Task'), /latest exited Run/);
  db.prepare("INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json, run_id) VALUES ('w', 'paint', '{}', 'new-run-1')").run();
  db.prepare("INSERT INTO run (id, task_id, attempt, status) VALUES ('new-run-2', 'new', 2, 'exited')").run();
  assert.throws(() => transitionTask(db, 'new', 'PASSED', 'verified', 'old Run'), /latest exited Run/);
  db.prepare("INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json, run_id) VALUES ('w', 'paint', '{}', 'new-run-2')").run();
  transitionTask(db, 'new', 'PASSED', 'verified', 'latest Run');
  assert.deepEqual(statuses(db), ['VERIFYING', 'PASSED']);
});

test('a Run keeps its project and slot locks until its verification ends', async t => {
  const x = setup(t);
  x.db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
    VALUES ('w2', 'p', 'synthetic', 'hash', 'k', 'active', '{}')`).run();
  let release!: () => void; let entered = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const inner = new FakeVerifier();
  const deferred: Verifier = { async verify(spec, result, hashes) { entered = true; await held; return inner.verify(spec, result, hashes); } };
  const config = { maxRetries: 1, slotCapacity: { unity_batch: 1 }, stageSlots: { paint: ['unity_batch'] } };
  const first = new Scheduler(x.db, 'w', definition(), x.executor, deferred, x.fingerprinter, config).tick();
  await waitUntil(() => entered, { what: 'the deferred verification to start', timeoutMs: 30_000, intervalMs: 5 });
  assert.ok(entered, 'verification started');
  assert.deepEqual(statuses(x.db), ['VERIFYING']);
  assert.equal(count(x.db, 'lock'), 2, 'project and slot locks are still held while checks read the outputs');
  const second = new Scheduler(x.db, 'w2', definition(), x.executor, new FakeVerifier(), x.fingerprinter, config);
  await second.tick();
  assert.deepEqual(statuses(x.db), ['VERIFYING', 'READY']);
  assert.equal(x.executor.starts.length, 1, 'no second writer on the project during verification');
  release(); await first;
  assert.deepEqual(statuses(x.db), ['PASSED', 'READY']);
  assert.equal(count(x.db, 'lock'), 0, 'leaving VERIFYING released the locks');
  await second.tick();
  assert.equal(x.executor.starts.length, 2);
});

test('a malformed verifier result fails the Task instead of leaving it VERIFYING with the locks', async t => {
  const x = setup(t);
  const duplicate: Verifier = { verify: (_spec, _result, hashes) => [0, 1].map(i => ({ id: `d${i}`, checkId: 'quality',
    scope: 'edit' as const, artifactHash: hashes.scene ?? '', result: 'pass' as const })) };
  await new Scheduler(x.db, 'w', definition(), x.executor, duplicate, x.fingerprinter,
    { maxRetries: 1, slotCapacity: { unity_batch: 1 }, stageSlots: { paint: ['unity_batch'] } }).tick();
  assert.deepEqual(statuses(x.db), ['FAILED']);
  assert.equal(count(x.db, 'lock'), 0);
});

/**
 * A synchronous scan (a Git listing plus file hashing over a large project) blocks the event loop, so the lease's
 * renewal timer cannot fire while it runs. The regression: a cycle that lost the lease during the scan went on to
 * decide a verdict under the new owner. The cycle now renews around the scan and stops before that write.
 */
test('a fingerprint scan that lost the scheduler lease stops the round before it decides a verdict', async t => {
  const x = setup(t);
  const lease = acquireSchedulerLease(x.db);
  assert.equal(lease.acquired, true);
  if (!lease.acquired) return;
  t.after(() => { try { lease.release(); } catch { /* the lease is already someone else's */ } });
  class StealingFingerprinter extends FakeFingerprinter {
    scans = 0;
    stealing = true;
    override fingerprint(workflowId: string, kinds: string[]): Record<string, string> {
      this.scans++;
      // The scan that runs after a Run exited is the one that happens while the lease is being taken over.
      const exitedRun = x.db.prepare(`SELECT 1 FROM task t JOIN run r ON r.task_id = t.id
        WHERE t.status = 'RUNNING' AND r.status = 'exited' LIMIT 1`).get();
      if (this.stealing && exitedRun) x.db.prepare(`UPDATE scheduler_lease SET holder = 'other-host:1:other-cycle',
        host = 'other-host', pid = 1, cycle = cycle + 1 WHERE id = 1`).run();
      return super.fingerprint(workflowId, kinds);
    }
  }
  const fingerprinter = new StealingFingerprinter();
  const scheduler = new Scheduler(x.db, 'w', definition(), x.executor, x.verifier, fingerprinter,
    { maxRetries: 1, slotCapacity: { unity_batch: 1 }, stageSlots: { paint: ['unity_batch'] },
      heartbeat: () => { lease.renew(); lease.assertActive(); } });
  x.executor.observed = { state: 'running' };
  await scheduler.tick();
  assert.deepEqual(statuses(x.db), ['RUNNING']);
  x.executor.observed = { state: 'exited' };
  await assert.rejects(scheduler.tick(), /Scheduler lease lost/);
  assert.equal(count(x.db, 'verdict'), 0, 'no verdict is decided under a lease the cycle no longer owns');
  assert.deepEqual(statuses(x.db), ['RUNNING'], 'the Task is left where the lost lease found it');
  // A later cycle owns the scheduler again and collects the interrupted Run, so the abort stranded no work.
  fingerprinter.stealing = false;
  x.db.prepare("UPDATE scheduler_lease SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = 1").run();
  const successor = acquireSchedulerLease(x.db);
  assert.equal(successor.acquired, true);
  if (successor.acquired) {
    try {
      await new Scheduler(x.db, 'w', definition(), x.executor, x.verifier, fingerprinter,
        { maxRetries: 1, slotCapacity: { unity_batch: 1 }, stageSlots: { paint: ['unity_batch'] },
          heartbeat: () => { successor.renew(); successor.assertActive(); } }).tick();
    } finally { successor.release(); }
  }
  assert.deepEqual(statuses(x.db), ['PASSED'], 'the interrupted Run is collected by the next owner');
});

/**
 * The defect's premise, measured directly: a synchronous scan blocks the event loop, so the lease's renewal timer
 * cannot run and `expires_at` does not move for the whole block. Renewing at the scan's boundaries is what keeps a
 * long round's lease alive. Blocking for the 60s TTL itself would put a minute into the suite; starvation is the
 * same at any duration, and the load measurement (`证据` in the lane report) covers whole-round durations.
 */
test('the renewal timer cannot fire inside a synchronous scan, and the scan boundary renews the lease', async t => {
  const x = setup(t);
  const lease = acquireSchedulerLease(x.db);
  assert.equal(lease.acquired, true);
  if (!lease.acquired) return;
  t.after(() => { try { lease.release(); } catch { /* the lease is already someone else's */ } });
  const expiry = (): number => Date.parse(String((x.db.prepare('SELECT expires_at FROM scheduler_lease WHERE id = 1')
    .get() as { expires_at: string }).expires_at));
  let atBoundary = 0, afterBlock = 0;
  const fingerprinter: Fingerprinter = { fingerprint(_workflowId, _kinds, heartbeat) {
    heartbeat?.();
    atBoundary = expiry();
    const until = Date.now() + 6_000;
    while (Date.now() < until) { /* synchronous work: no timer callback can run until the stack unwinds */ }
    afterBlock = expiry();
    heartbeat?.();
    return {};
  } };
  const scheduler = new Scheduler(x.db, 'w', definition(), x.executor, x.verifier, fingerprinter,
    { maxRetries: 1, slotCapacity: {}, heartbeat: () => { lease.renew(); lease.assertActive(); } });
  await refreshFingerprints(scheduler);
  assert.equal(afterBlock, atBoundary, 'the renewal timer did not run inside the 6s synchronous block');
  assert.ok(expiry() > atBoundary, 'the next boundary renewal extends the lease');
});

/**
 * The per-round cadence: a Workflow with work in flight must be observed every round, because a Run may be reading
 * or writing those artifacts; a settled one is scanned on the idle window instead. Removing the in-flight condition
 * makes the second round below stay throttled and the assertion fail.
 */
test('fingerprints refresh every round while work is in flight and on the idle window once settled', async t => {
  const x = setup(t);
  let scans = 0;
  const fingerprinter: Fingerprinter = {
    fingerprint(): Record<string, string> { scans++; return { ...x.fingerprinter.hashes }; } };
  const config = { maxRetries: 1, slotCapacity: { unity_batch: 1 }, stageSlots: { paint: ['unity_batch'] },
    idleFingerprintRefreshMs: 60_000, idleFingerprintCadence: newFingerprintCadence() };
  const rounds = () => new Scheduler(x.db, 'w', definition(), x.executor, x.verifier, fingerprinter, config).tick();
  x.executor.observed = { state: 'running' };
  await rounds();
  const whileRunning = scans;
  await rounds();
  assert.ok(scans > whileRunning, 'a Run still running keeps the Workflow on the per-round cadence');
  x.executor.observed = { state: 'exited' };
  await rounds();
  const settled = scans;
  await rounds(); await rounds();
  assert.equal(scans, settled, 'a settled Workflow is not rescanned inside the idle window');
  assert.equal(x.db.prepare('SELECT status FROM task').get()!.status, 'PASSED');
});

/**
 * An `open` stage is the one this round is about to create and dispatch a Task for. The idle cadence alone would
 * decide that from the previous round's fingerprint, so a change made in between would only be noticed after the
 * downstream Run had already started. Removing the pre-dispatch observation makes `finish` start below.
 */
test('an open stage is observed before it is dispatched, inside the idle window', async t => {
  const x = setup(t, false, true);
  const cadence = newFingerprintCadence();
  const config = (blockFinish: boolean) => ({ maxRetries: 1, slotCapacity: { unity_batch: 1 },
    stageSlots: { paint: ['unity_batch'], finish: ['unity_batch'] }, idleFingerprintRefreshMs: 60_000,
    idleFingerprintCadence: cadence,
    ...(blockFinish ? { stageDispatchAllowed: (id: string): boolean => id !== 'finish' } : {}) });
  // Round 1 lets only `paint` run: `finish` is left open, and the round has already spent its cadence.
  await new Scheduler(x.db, 'w', definition(false, true), x.executor, x.verifier, x.fingerprinter, config(true)).tick();
  assert.equal(x.executor.starts.filter(run => run.stageId === 'finish').length, 0);
  // A change to an artifact `paint` was validated against, made while nothing is in flight.
  x.fingerprinter.hashes.source = 's2';
  await new Scheduler(x.db, 'w', definition(false, true), x.executor, x.verifier, x.fingerprinter, config(false)).tick();
  assert.equal(x.executor.starts.filter(run => run.stageId === 'finish').length, 0,
    'the open stage was not dispatched on the fingerprint from before the change');
});

/**
 * The verifier is a long step. A cycle whose lease is taken over while it runs must stop before recording its
 * result: without the check after `verify`, the Verdicts, the stage completion and `PASSED` were all written.
 */
test('a lease lost while the verifier runs stops the round before a verdict is recorded', async t => {
  const x = setup(t);
  const lease = acquireSchedulerLease(x.db);
  assert.equal(lease.acquired, true);
  if (!lease.acquired) return;
  t.after(() => { try { lease.release(); } catch { /* the lease is already someone else's */ } });
  const verifier: Verifier = {
    verify(_spec: RunSpec, _result: RunResult, hashes: Record<string, string>): Verdict[] {
      x.db.prepare(`UPDATE scheduler_lease SET holder = 'other-host:1:other-cycle', host = 'other-host', pid = 1,
        cycle = cycle + 1 WHERE id = 1`).run();
      return [{ id: 'v1', checkId: 'quality', scope: 'edit', artifactHash: hashes.scene ?? '', result: 'pass' }];
    },
  };
  const scheduler = new Scheduler(x.db, 'w', definition(), x.executor, verifier, x.fingerprinter,
    { maxRetries: 1, slotCapacity: { unity_batch: 1 }, stageSlots: { paint: ['unity_batch'] },
      heartbeat: () => { lease.renew(); lease.assertActive(); } });
  x.executor.observed = { state: 'running' };
  await scheduler.tick();
  x.executor.observed = { state: 'exited' };
  await assert.rejects(scheduler.tick(), /Scheduler lease lost/);
  assert.equal(count(x.db, 'verdict'), 0, 'no verdict is recorded under a lease the cycle no longer owns');
  assert.equal(count(x.db, 'stage_completion'), 0, 'no stage completion is recorded either');
  assert.notDeepEqual(statuses(x.db), ['PASSED'], 'the Task is not settled under the lost lease');
});

/**
 * Observing the execution unit is the other long step of the same path. A lease taken over meanwhile must not let
 * its result be recorded as this cycle's finding: `unknown` writes RECOVERY_REQUIRED, which is what the old code
 * did even though the round no longer owned the scheduler.
 */
test('a lease lost while the executor is observed stops the round before RECOVERY_REQUIRED', async t => {
  const x = setup(t);
  const lease = acquireSchedulerLease(x.db);
  assert.equal(lease.acquired, true);
  if (!lease.acquired) return;
  t.after(() => { try { lease.release(); } catch { /* the lease is already someone else's */ } });
  let steal = false;
  const executor = x.executor;
  executor.observe = (): Observation => {
    if (steal) {
      x.db.prepare(`UPDATE scheduler_lease SET holder = 'other-host:1:other-cycle', host = 'other-host', pid = 1,
        cycle = cycle + 1 WHERE id = 1`).run();
      return { state: 'unknown' };
    }
    return { state: 'running' };
  };
  const scheduler = new Scheduler(x.db, 'w', definition(), executor, x.verifier, x.fingerprinter,
    { maxRetries: 1, slotCapacity: { unity_batch: 1 }, stageSlots: { paint: ['unity_batch'] },
      heartbeat: () => { lease.renew(); lease.assertActive(); } });
  await scheduler.tick();
  assert.deepEqual(statuses(x.db), ['RUNNING']);
  steal = true;
  await assert.rejects(scheduler.tick(), /Scheduler lease lost/);
  assert.deepEqual(statuses(x.db), ['RUNNING'], 'the observation was not recorded as an unknown Run');
});

/**
 * `beforeDispatch` can do long work (freezing a production baseline). Dispatching is a state-store write, so a lease
 * taken over while it works must stop the round before the Run is intended. Removing the check before
 * `transitionTask` leaves an intended Run behind under the new owner.
 */
test('a lease lost while beforeDispatch works stops the round before a Run is intended', async t => {
  const x = setup(t);
  const lease = acquireSchedulerLease(x.db);
  assert.equal(lease.acquired, true);
  if (!lease.acquired) return;
  t.after(() => { try { lease.release(); } catch { /* the lease is already someone else's */ } });
  const scheduler = new Scheduler(x.db, 'w', definition(), x.executor, x.verifier, x.fingerprinter,
    { maxRetries: 1, slotCapacity: { unity_batch: 1 }, stageSlots: { paint: ['unity_batch'] },
      beforeDispatch: async () => {
        x.db.prepare(`UPDATE scheduler_lease SET holder = 'other-host:1:other-cycle', host = 'other-host', pid = 1,
          cycle = cycle + 1 WHERE id = 1`).run();
      },
      heartbeat: () => { lease.renew(); lease.assertActive(); } });
  await assert.rejects(scheduler.tick(), /Scheduler lease lost/);
  assert.equal(count(x.db, 'run'), 0, 'no Run is intended under a lease the cycle no longer owns');
  assert.deepEqual(statuses(x.db), ['READY'], 'the Task is left READY, not RUNNING');
});

/**
 * The supervisor persists the exit fact before anything else, so a Task still RUNNING next to an exited Run already
 * has its result. Observing or collecting again can advance the execution chain and overwrite a success with a
 * failure; the round must settle from the persisted `result_json` instead.
 */
test('an exited Run with a persisted result is settled from it, without observing or collecting again', async t => {
  const x = setup(t);
  x.executor.observed = { state: 'running' };
  await x.make().tick();
  const runId = x.executor.starts[0]!.runId;
  // The cycle persisted the exit fact and then stopped before verifying (a lost lease, a crash).
  x.db.prepare("UPDATE run SET status = 'exited', result_json = ? WHERE id = ?")
    .run(JSON.stringify({ exitStatus: 0, outputs: {} }), runId);
  let collects = 0, observes = 0;
  x.executor.observe = (): Observation => { observes++; return { state: 'unknown' }; };
  x.executor.collect = (_handle: RunHandle): RunResult => { collects++; throw new Error('the execution unit is gone'); };
  await x.make().tick();
  assert.equal(observes, 0, 'the execution unit is not observed again');
  assert.equal(collects, 0, 'the persisted result is used instead of collecting again');
  assert.deepEqual(statuses(x.db), ['PASSED'], 'the saved success settles the Task');
});

/**
 * The round reconciles twice: before its dispatch decisions and after them. The second pass exists to observe the
 * Runs that dispatch started, not to scan the artifacts again — a scan is a Git listing plus a stat-and-hash of
 * every member of every artifact kind, the largest synchronous step of a round, and it was being paid twice per
 * round for every Workflow with work in flight. Dropping the option that suppresses the second scan doubles the
 * count below and fails the first assertion; dropping the second pass altogether fails the second.
 */
test('a round with work in flight scans the artifacts once and still collects the Run its dispatch started', async t => {
  const config = () => ({ maxRetries: 1, slotCapacity: { unity_batch: 1 }, stageSlots: { paint: ['unity_batch'] } });
  // A Run that is still running for the whole round: exactly one scan, no post-Run scan to confuse the count.
  const running = setup(t);
  let scans = 0;
  const counting: Fingerprinter = {
    fingerprint(): Record<string, string> { scans++; return { ...running.fingerprinter.hashes }; } };
  running.executor.observed = { state: 'running' };
  await new Scheduler(running.db, 'w', definition(), running.executor, running.verifier, counting, config()).tick();
  assert.equal(running.executor.starts.length, 1, 'the round dispatched its Task');
  assert.equal(scans, 1, 'the round scanned the artifacts once, not once per reconcile');
  assert.equal(running.db.prepare('SELECT status FROM task').get()!.status, 'RUNNING');
  // A Run that exits after dispatch but before the round's second reconcile: that pass still collects it, and the
  // post-Run fingerprint `finish` takes is the second scan counted here.
  const exited = setup(t);
  let settledScans = 0;
  const countingSettled: Fingerprinter = {
    fingerprint(): Record<string, string> { settledScans++; return { ...exited.fingerprinter.hashes }; } };
  exited.executor.observed = { state: 'running' };
  await new Scheduler(exited.db, 'w', definition(), exited.executor, exited.verifier, countingSettled,
    { ...config(), beforeDispatch: async () => { exited.executor.observed = { state: 'exited' }; } }).tick();
  assert.equal(exited.db.prepare('SELECT status FROM task').get()!.status, 'PASSED',
    'the second reconcile collected the Run that exited after dispatch');
  assert.equal(settledScans, 2, 'the round scans once for the observation and once for the finished Run, never twice for the same observation');
});
