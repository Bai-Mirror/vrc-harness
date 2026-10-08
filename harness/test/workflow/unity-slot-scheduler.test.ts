import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LocalConfig } from '../../src/config.ts';
import type { Executor, RunHandle, RunResult, RunSpec } from '../../src/runtime/interfaces.ts';
import { openDatabase } from '../../src/state/db.ts';
import { workflowScheduler, type WorkflowSnapshot } from '../../src/workflow/runtime.ts';
import { removeTemp } from '../fixtures/platform.ts';

const definition = { schema: 'process/0.1', id: 'slot-test', version: 'v1', applies_to: {}, artifacts: ['scene'],
  stages: [{ id: 'outfit', needs: [], produces: ['scene'], requires: ['quality'], gates: [], invalidated_by: [] }],
  checks: [{ id: 'quality', observe: 'synthetic', on: 'scene', scope: 'edit', rule: 'true', severity: 'blocking', maturity: 'accepted' }],
  gates: [], milestones: [] } as const;
const capabilities = { schema: 'capabilities/0.1', artifacts: {}, observers: {},
  stages: { outfit: { resources: ['unity_batch'], maxRetries: 0, maxCheckRetries: 0 } } } as const;

class HoldingExecutor implements Executor {
  readonly starts: RunSpec[] = [];
  start(spec: RunSpec): RunHandle { this.starts.push(spec); return { ref: spec.runId }; }
  observe(): { state: 'running' } { return { state: 'running' }; }
  cancel(): 'confirmed' { return 'confirmed'; }
  collect(): RunResult { return { exitStatus: 143, outputs: {} }; }
}

function fixture(t: test.TestContext, slots: number) {
  const root = mkdtempSync(join(tmpdir(), 'avh-unity-scheduler-'));
  t.after(() => removeTemp(root));
  const home = join(root, 'home'); mkdirSync(home);
  const db = openDatabase(join(home, 'state.sqlite')); t.after(() => db.close());
  db.prepare("INSERT INTO workspace(id,path) VALUES('ws',?)").run(root);
  const config = { home, toolRoot: root, unitySlots: { count: slots, source: 'env' }, providers: [],
    providerPolicyVersion: 'test', providerProbeTtlMs: 0, routing: {} } as unknown as LocalConfig;
  const executor = new HoldingExecutor();
  let projectOrdinal = 0, workflowOrdinal = 0;
  const create = (projectId?: string) => {
    const id = projectId ?? `p${++projectOrdinal}`, project = join(root, id);
    if (!projectId) {
      mkdirSync(project);
      db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES(?,'ws','sample',?,'{}','active','h','k')")
        .run(id, project);
    }
    const workflowId = `w${++workflowOrdinal}`;
    db.prepare("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES(?,?,'slot-test','hash','k','active','{}')")
      .run(workflowId, id);
    const snapshot = { workflowId, profile: 'slot-test', definition, capabilities, thresholds: {}, tools: {}, toolRoot: root,
      variables: {}, contexts: {}, frozenAt: new Date().toISOString() } as unknown as WorkflowSnapshot;
    const scheduler = workflowScheduler(db, config, workflowId, executor, snapshot);
    scheduler.fingerprinter.fingerprint = () => ({ scene: 'baseline' });
    scheduler.fingerprinter.unchanged = () => {};
    return { id, workflowId, scheduler };
  };
  return { db, executor, create };
}

test('workflowScheduler dispatches up to the configured Unity slots and frees the next workflow after release', async t => {
  const f = fixture(t, 3);
  const workflows = [f.create(), f.create(), f.create(), f.create()];
  for (const workflow of workflows) await workflow.scheduler.tick();
  assert.equal(f.executor.starts.length, 3);
  assert.deepEqual(f.db.prepare('SELECT status FROM task ORDER BY rowid').all().map(row => row.status),
    ['RUNNING', 'RUNNING', 'RUNNING', 'READY']);
  assert.deepEqual(f.db.prepare("SELECT resource FROM lock WHERE resource LIKE 'slot:unity_batch:%' ORDER BY resource").all()
    .map(row => row.resource), ['slot:unity_batch:0', 'slot:unity_batch:1', 'slot:unity_batch:2']);
  const firstTask = f.db.prepare('SELECT id FROM task WHERE workflow_id=?').get(workflows[0]!.workflowId) as { id: string };
  assert.equal((await workflows[0]!.scheduler.cancelTask(firstTask.id, 'release a Unity slot')).confirmed, true);
  await workflows[3]!.scheduler.tick();
  assert.equal(f.executor.starts.length, 4, 'the fourth workflow starts once one slot is released');
});

test('workflowScheduler retains project exclusion and respects a one-slot machine', async t => {
  const same = fixture(t, 3), first = same.create(), second = same.create(first.id);
  await first.scheduler.tick(); await second.scheduler.tick();
  assert.equal(same.executor.starts.length, 1, 'two workflows for one project never overlap');

  const single = fixture(t, 1), workflows = [single.create(), single.create(), single.create(), single.create()];
  for (const workflow of workflows) await workflow.scheduler.tick();
  assert.equal(single.executor.starts.length, 1, 'a one-slot machine stays serial');
});
