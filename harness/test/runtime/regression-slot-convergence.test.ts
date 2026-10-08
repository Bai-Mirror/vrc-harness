import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Check, ProcessDefinition, Stage, Verdict } from '../../src/process/types.ts';
import type { Executor, Fingerprinter, Observation, RunHandle, RunResult, RunSpec, Verifier } from '../../src/runtime/interfaces.ts';
import { Scheduler } from '../../src/runtime/scheduler.ts';
import { aggregateWorkflow } from '../../src/state/aggregate-input.ts';
import { openDatabase } from '../../src/state/db.ts';
import { rederivedBy } from '../fixtures/build-slots.ts';
import { removeTemp } from '../fixtures/platform.ts';

/**
 * PF1 D5 in the shape the back half of `pc-recolor-outfit` actually has:
 * build_pre -> regression_pre -> build -> regression -> performance.
 *
 * `regression_pre`/`regression` rebuild and measure `Assets/_BuildArtifacts` in the copy they mirror, and the
 * manifest used to point them at `_harness_build/pre|final/project` -- the `build_pre`/`build` artifact another
 * stage owns. A same-source rebuild is a new version (measured on the A copy: 8 of 26 members change), so the
 * owner's checks observe a version that is gone, the owner re-runs, and the regression is invalidated again: one
 * paid Provider Run per lap, forever.
 *
 * These tests drive the scheduler itself. `rederives` is the only thing that differs between the two worlds, and
 * it is read from the published capability manifest: a round that copies its own slot replaces no upstream version.
 */

const stage = (id: string, produces: string[], needs: string[], invalidatedBy: string[], requires: string[]): Stage =>
  ({ id, needs, produces, requires, gates: [], invalidated_by: invalidatedBy });
const check = (id: string, on: string): Check =>
  ({ id, observe: 'synthetic', on, scope: 'build', rule: 'synthetic', severity: 'blocking', maturity: 'accepted' });

interface Shape {
  artifacts: string[];
  stages: Stage[];
  checks: Check[];
  /** Per stage: the check id it requires, and the artifact that check is `on`. */
  checksByStage: Record<string, { checkId: string; on: string }>;
}

/** Mirrors the real back half: two producers with checks on their own artifact, three measuring stages. */
function backHalf(): Shape {
  return {
    artifacts: ['source', 'build_pre', 'build'],
    stages: [stage('build_pre', ['build_pre'], [], ['source'], ['build_pre_ok']),
      stage('regression_pre', [], ['build_pre'], ['build_pre'], ['regression_pre_ok']),
      stage('build', ['build'], ['regression_pre'], ['source'], ['build_ok']),
      stage('regression', [], ['build'], ['build'], ['regression_ok']),
      stage('performance', [], ['regression'], ['build', 'build_pre'], ['performance_ok'])],
    checks: [check('build_pre_ok', 'build_pre'), check('regression_pre_ok', 'build_pre'),
      check('build_ok', 'build'), check('regression_ok', 'build'), check('performance_ok', 'build')],
    checksByStage: {
      build_pre: { checkId: 'build_pre_ok', on: 'build_pre' },
      regression_pre: { checkId: 'regression_pre_ok', on: 'build_pre' },
      build: { checkId: 'build_ok', on: 'build' },
      regression: { checkId: 'regression_ok', on: 'build' },
      performance: { checkId: 'performance_ok', on: 'build' },
    },
  };
}

function definition(shape: Shape): ProcessDefinition {
  return { schema: 'process/0.1', id: 'synthetic', version: 'v1', applies_to: {}, artifacts: shape.artifacts,
    stages: shape.stages, checks: shape.checks, gates: [], milestones: [] };
}

class RebuildingExecutor implements Executor {
  starts: RunSpec[] = [];
  onCollect?: (stageId: string) => void;
  start(spec: RunSpec): RunHandle { this.starts.push(spec); return { ref: `handle-${spec.runId}` }; }
  observe(_handle: RunHandle): Observation { return { state: 'exited' }; }
  cancel(_handle: RunHandle): 'confirmed' { return 'confirmed'; }
  collect(handle: RunHandle): RunResult {
    const spec = this.starts.find(item => item.runId === handle.ref.replace('handle-', ''))!;
    this.onCollect?.(spec.stageId);
    return { exitStatus: 0, outputs: {} };
  }
}

class MutableFingerprinter implements Fingerprinter {
  readonly hashes: Record<string, string>;
  constructor(hashes: Record<string, string>) { this.hashes = hashes; }
  fingerprint(): Record<string, string> { return { ...this.hashes }; }
}

class PassingVerifier implements Verifier {
  private readonly shape: Shape;
  constructor(shape: Shape) { this.shape = shape; }
  verify(spec: RunSpec, _result: RunResult, hashes: Record<string, string>): Verdict[] {
    const target = this.shape.checksByStage[spec.stageId]!;
    return [{ id: `${spec.runId}:${target.checkId}`, checkId: target.checkId, scope: 'build',
      artifactHash: hashes[target.on] ?? '', result: 'pass' }];
  }
}

function fixture(t: TestContext, shape: Shape, rederives: Record<string, string[]>) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-regression-slot-'));
  const db = openDatabase(join(dir, 'state.sqlite'));
  t.after(() => { if (db.isOpen) db.close(); removeTemp(dir); });
  db.prepare("INSERT INTO workspace (id, path) VALUES ('ws', '/synthetic/workspace')").run();
  db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('p', 'ws', 'sample', '/synthetic/project', '{}', 'active', 'h', 'k')`).run();
  db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
    VALUES ('w', 'p', 'synthetic', 'hash', 'k', 'active', '{}')`).run();
  const process = definition(shape);
  const executor = new RebuildingExecutor();
  const fingerprinter = new MutableFingerprinter({ source: 's1', build_pre: 'pre-1', build: 'final-1' });
  const verifier = new PassingVerifier(shape);
  let generation = 0;
  executor.onCollect = stageId => {
    // The Run's own copy is rebuilt; whether that replaces an upstream *version* is exactly the question.
    for (const kind of rederives[stageId] ?? []) fingerprinter.hashes[kind] = `${kind}-rebuild-${++generation}`;
  };
  const round = (): Promise<void> => new Scheduler(db, 'w', process, executor, verifier, fingerprinter,
    { maxRetries: 0, slotCapacity: {},
      stageCheckRetries: Object.fromEntries(shape.stages.map(item => [item.id, 0])) }).tick();
  const rounds = async (n: number): Promise<void> => { for (let i = 0; i < n; i++) await round(); };
  return { db, round, rounds };
}

function completionOf(db: DatabaseSync, stageId: string): Record<string, string> | undefined {
  const row = db.prepare('SELECT artifact_hashes_json FROM stage_completion WHERE stage_id = ? ORDER BY seq DESC LIMIT 1')
    .get(stageId) as { artifact_hashes_json: string } | undefined;
  return row ? JSON.parse(row.artifact_hashes_json) as Record<string, string> : undefined;
}
function outOfBounds(db: DatabaseSync): Array<{ stage_id: string; artifact: string; accepted: number }> {
  return (db.prepare('SELECT stage_id, artifact, accepted FROM out_of_bounds_change ORDER BY seq').all() as
    Array<{ stage_id: string; artifact: string; accepted: number }>).map(row => ({ ...row }));
}
function runCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM run').get() as { n: number }).n);
}
/** The aggregate is the authority on a stage: a PASSED Task whose completion is stale reads as `open` there. */
function stageStates(db: DatabaseSync, shape: Shape): Record<string, { status: string; reasonCodes: string[] }> {
  const aggregate = aggregateWorkflow(db, 'w', definition(shape));
  return Object.fromEntries(Object.entries(aggregate.stages).map(([id, state]) =>
    [id, { status: state.status, reasonCodes: state.reasonCodes ?? [] }]));
}
function settled(db: DatabaseSync, shape: Shape): boolean {
  return Object.values(stageStates(db, shape)).every(state => state.status === 'passed');
}
function acceptAll(db: DatabaseSync): number {
  return Number(db.prepare('UPDATE out_of_bounds_change SET accepted = 1 WHERE accepted = 0').run().changes);
}

test('the published manifest lets the back half settle with one Run per stage', async t => {
  const shape = backHalf();
  // Read the fix out of the manifest itself: a round that copies the slot an upstream artifact lives in re-derives it.
  const rederives = Object.fromEntries(['regression_pre', 'regression'].map(id => [id, rederivedBy(id)]));
  assert.deepEqual(rederives, { regression_pre: [], regression: [] },
    'the regression rounds must not rebuild an upstream slot; otherwise this test models the looping shape below');
  const x = fixture(t, shape, rederives);
  await x.rounds(24);
  assert.equal(settled(x.db, shape), true, JSON.stringify(stageStates(x.db, shape)));
  assert.deepEqual(stageStates(x.db, shape), Object.fromEntries(shape.stages.map(item =>
    [item.id, { status: 'passed', reasonCodes: [] }])), 'no stage is left open on a stale version');
  assert.equal(runCount(x.db), shape.stages.length, 'one Run per stage: nothing is re-derived into a new version');
  assert.deepEqual(outOfBounds(x.db), [], 'no re-derivation for a person to review');
  // Each regression round completes on the upstream version it was given, because its own Run did not replace it.
  assert.equal(completionOf(x.db, 'regression_pre')!.build_pre, 'pre-1');
  assert.equal(completionOf(x.db, 'regression')!.build, 'final-1');
});

test('a regression round that rebuilds the upstream slot never settles the back half', async t => {
  const shape = backHalf();
  const x = fixture(t, shape, { regression_pre: ['build_pre'], regression: ['build'] });
  const laps: string[] = [];
  let sawStaleEvidence = false;
  for (let round = 0; round < 7; round++) {
    // Every time the Runtime asks, the person accepts the change: this is not a shortage of answers.
    acceptAll(x.db);
    await x.round();
    const states = stageStates(x.db, shape);
    sawStaleEvidence ||= Object.values(states).some(state =>
      state.reasonCodes.some(code => /stale|invalidat/.test(code)));
    laps.push(`runs=${runCount(x.db)} reviews=${outOfBounds(x.db).length} ` +
      Object.entries(states).map(([id, state]) => `${id}:${state.status}(${state.reasonCodes.join('|')})`).join(' '));
  }
  t.diagnostic(laps.join('\n'));
  assert.equal(settled(x.db, shape), false, 'a rebuild that replaces the version the other stage measured never settles');
  assert.ok(runCount(x.db) > shape.stages.length, `stages re-run beyond their first pass: ${runCount(x.db)}`);
  assert.ok(outOfBounds(x.db).length >= 1, `the re-derivation is charged for review: ${outOfBounds(x.db).length}`);
  assert.ok(sawStaleEvidence, 'the loop shows up as stale evidence or an invalidated completion');
});
