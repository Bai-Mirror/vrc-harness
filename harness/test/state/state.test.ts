import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { aggregateProcess } from '../../src/process/aggregate.ts';
import { loadProcess } from '../../src/process/load.ts';
import type { AggregateInput } from '../../src/process/types.ts';
import { aggregateWorkflow, buildAggregateInput } from '../../src/state/aggregate-input.ts';
import { openDatabase, SCHEMA_VERSION } from '../../src/state/db.ts';
import { withStateEvent } from '../../src/state/tx.ts';
import { removeTemp } from '../fixtures/platform.ts';

/** Every migration file, by version: a database the Runtime opened has applied exactly these (gaps included). */
const MIGRATION_VERSIONS = readdirSync(new URL('../../src/state/migrations/', import.meta.url)).filter(name => /^\d{4}_.+\.sql$/.test(name))
  .map(name => ({ version: Number(name.slice(0, 4)) })).sort((a, b) => a.version - b.version);

function temporaryDb(t: TestContext, legacyVersion?: number): { db: DatabaseSync; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'avatar-harness-state-'));
  const path = join(directory, 'state.sqlite');
  const db = legacyVersion === undefined ? openDatabase(path) : new DatabaseSync(path);
  if (legacyVersion !== undefined) {
    db.exec('PRAGMA foreign_keys = ON; CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
    const files = readdirSync(new URL('../../src/state/migrations/', import.meta.url)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    for (const file of files) {
      const version = Number(file.slice(0,4));
      if (version > legacyVersion) continue;
      db.exec(readFileSync(new URL('../../src/state/migrations/'+file,import.meta.url),'utf8'));
      db.prepare('INSERT INTO schema_version(version) VALUES(?)').run(version);
    }
  }
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, path };
}

function seedWorkflow(db: DatabaseSync, workflowId = 'flow-1'): void {
  db.prepare('INSERT OR IGNORE INTO workspace (id, path) VALUES (?, ?)').run('workspace-1', '/synthetic/workspace');
  db.prepare(`INSERT OR IGNORE INTO project
    (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'project-1', 'workspace-1', 'sample', '/synthetic/project', '{}', 'active', 'h1', 'k1',
    );
  db.prepare(`INSERT INTO workflow
    (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      workflowId, 'project-1', 'synthetic-flow', 'process-hash', 'k1', 'active', '{"features":true}',
    );
}

const yaml = readFileSync(new URL('../fixtures/process.yaml', import.meta.url), 'utf8');
const definition = loadProcess(yaml, {
  schema: 'thresholds/0.1', version: 'fixture-1',
  t: { max_count: { value: 10, unit: 'items', maturity: 'accepted', source: 'fixture' } },
});

test('migration creates WP2 and task proof tables with WAL, foreign keys and timeout', t => {
  const { db } = temporaryDb(t);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]).map(row => row.name);
  assert.deepEqual(tables, [
    'artifact_version', 'asset', 'asset_avatar_decision', 'asset_avatar_tag', 'asset_category', 'asset_classification', 'asset_derivation',
    'asset_selection_file', 'asset_selection_pin', 'asset_selection_plan', 'asset_taxonomy_proposal', 'asset_taxonomy_version',
    'avatar_dictionary_candidate', 'avatar_dictionary_entry', 'avatar_dictionary_term', 'avatar_root',
    'booth_file', 'booth_file_kind', 'booth_file_version', 'booth_item', 'dispatch_outbox', 'event', 'exploration_resource', 'face_manual_binding', 'face_manual_session', 'face_preference', 'gate_decision', 'import_report', 'interaction_exploration', 'local_pack_adoption', 'lock', 'lock_epoch',
    'managed_pack_authoring', 'managed_pack_candidate', 'managed_pack_case_result', 'managed_pack_contribution', 'managed_pack_evaluation', 'managed_pack_release', 'managed_pack_trial',
    'out_of_bounds_change', 'plan_revision', 'pool_blob', 'production_archive_reference', 'production_archived_evidence', 'production_baseline', 'production_continuation', 'production_continuation_contract', 'production_delivery', 'production_evidence_reuse', 'production_head', 'production_proposal', 'program', 'program_project', 'project',
    'project_archive_identity', 'project_archive_write', 'project_asset', 'project_brief', 'project_fact', 'project_file_entry',
    'project_input_observation', 'project_interaction', 'project_message', 'project_package_action', 'project_recovery', 'project_restore', 'project_revision', 'project_scan', 'project_session',
    'project_share', 'project_sync',
    'project_variant', 'project_variant_asset', 'provider_snapshot', 'run', 'run_input_snapshot',
    'scheduler_lease', 'schema_version', 'sharing_consent', 'sharing_record', 'sharing_source', 'stage_completion', 'task', 'verdict', 'warning_acceptance',
    'workflow', 'workflow_definition', 'workflow_input_revision', 'workspace',
  ]);
  assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
  // Every numbered migration file is registered and applied (parallel branches may leave gaps until they merge).
  const files = readdirSync(new URL('../../src/state/migrations/', import.meta.url)).filter(name => /^\d{4}_.+\.sql$/.test(name))
    .map(name => ({ version: Number(name.slice(0, 4)) })).sort((a, b) => a.version - b.version);
  assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row => ({ ...row })), files);
  assert.equal(SCHEMA_VERSION, files.at(-1)!.version);
  assert.deepEqual(db.prepare('SELECT id, holder, host, pid, cycle, expires_at FROM scheduler_lease').all().map(row => ({ ...row })),
    [{ id: 1, holder: null, host: null, pid: null, cycle: 0, expires_at: null }]);
  assert.throws(() => db.prepare('INSERT INTO scheduler_lease (id) VALUES (2)').run(), /CHECK constraint/);
  assert.throws(() => db.prepare(`INSERT INTO project
    (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('bad', 'missing', 'sample', 'x', '{}', 'active', 'h1', 'k1')`).run(), /FOREIGN KEY/);
});

test('state and event commit together and roll back together on exception', t => {
  const { db } = temporaryDb(t);
  assert.throws(() => withStateEvent(db, {
    actor: 'test', entityType: 'workspace', entityId: 'rollback', action: 'created', reason: 'fixture',
  }, () => {
    db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run('rollback', '/synthetic/rollback');
    throw new Error('injected failure');
  }), /injected failure/);
  assert.equal((db.prepare('SELECT count(*) AS n FROM workspace').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, 0);
  const id = withStateEvent(db, {
    actor: 'test', entityType: 'workspace', entityId: 'committed', action: 'created', reason: 'fixture',
    payload: { reason: 'fixture' },
  }, () => {
    db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run('committed', '/synthetic/committed');
    return 'committed';
  });
  assert.equal(id, 'committed');
  assert.deepEqual(db.prepare('SELECT id FROM workspace').all().map(row => ({ ...row })), [{ id: 'committed' }]);
  assert.deepEqual(db.prepare('SELECT entity_id, reason, payload_json FROM event').all().map(row => ({ ...row })), [
    { entity_id: 'committed', reason: 'fixture', payload_json: '{"reason":"fixture"}' },
  ]);
});

test('append-only triggers reject update and delete of recorded facts', t => {
  const { db } = temporaryDb(t);
  seedWorkflow(db);
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('flow-1', 'scene', 's1')").run();
  db.prepare("INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result) VALUES ('v1', 'flow-1', 'scene_check', 'edit', 's1', 'pass')").run();
  db.prepare("INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result) VALUES ('flow-1', 'plan_approval', 'p1', 'approved')").run();
  db.prepare("INSERT INTO event (actor, entity_type, entity_id, action, reason) VALUES ('test', 'workflow', 'flow-1', 'created', 'fixture')").run();
  for (const [table, column] of [
    ['artifact_version', 'hash'], ['verdict', 'result'],
    ['gate_decision', 'result'], ['event', 'action'],
  ]) {
    assert.throws(() => db.exec(`UPDATE ${table} SET ${column} = 'changed'`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /append-only/);
    assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table === 'event' ? 2 : 1);
  }
});

test('dispatch outbox permits intended to launched to acked and rejects skip or reversal', t => {
  const { db } = temporaryDb(t);
  seedWorkflow(db);
  db.prepare(`INSERT INTO task (id, workflow_id, stage_id, goal, capability, status)
    VALUES ('task-1', 'flow-1', 'setup', 'observe scene', 'inspect', 'READY')`).run();
  db.prepare("INSERT INTO run (id, task_id, attempt, status) VALUES ('run-1', 'task-1', 1, 'pending')").run();
  assert.throws(() => db.prepare("INSERT INTO dispatch_outbox (id, run_id, status) VALUES ('invalid', 'run-1', 'acked')").run(), /must start intended/);
  db.prepare("INSERT INTO dispatch_outbox (id, run_id) VALUES ('dispatch-1', 'run-1')").run();
  const status = () => (db.prepare("SELECT status FROM dispatch_outbox WHERE id = 'dispatch-1'").get() as { status: string }).status;
  assert.equal(status(), 'intended');
  assert.throws(() => db.exec("UPDATE dispatch_outbox SET status = 'acked' WHERE id = 'dispatch-1'"), /invalid dispatch_outbox transition/);
  assert.equal(status(), 'intended');
  db.exec("UPDATE dispatch_outbox SET status = 'launched' WHERE id = 'dispatch-1'");
  assert.equal(status(), 'launched');
  assert.throws(() => db.exec("UPDATE dispatch_outbox SET status = 'intended' WHERE id = 'dispatch-1'"), /invalid dispatch_outbox transition/);
  db.exec("UPDATE dispatch_outbox SET status = 'acked' WHERE id = 'dispatch-1'");
  assert.equal(status(), 'acked');
  assert.throws(() => db.exec("UPDATE dispatch_outbox SET status = 'launched' WHERE id = 'dispatch-1'"), /invalid dispatch_outbox transition/);
});

test('aggregate input matches direct WP1 input and a new hash makes verdict stale', t => {
  const { db } = temporaryDb(t);
  seedWorkflow(db);
  seedWorkflow(db, 'flow-2');
  const input: AggregateInput = {
    artifactHashes: { plan: 'p1', scene: 's1', build: 'b1', fbx: 'f1', delivery_package: 'd1' },
    plan: { features: true },
    verdicts: [
      { id: 'v-old', checkId: 'scene_check', scope: 'edit', artifactHash: 's0', result: 'pass' },
      { id: 'v-scene', checkId: 'scene_check', scope: 'edit', artifactHash: 's1', result: 'pass' },
      { id: 'v-warning', checkId: 'warning_check', scope: 'build', artifactHash: 'b1', result: 'violation' },
      { id: 'v-conditional', checkId: 'conditional_check', scope: 'build', artifactHash: 'b1', result: 'pass' },
      { id: 'v-package', checkId: 'package_check', scope: 'client', artifactHash: 'd1', result: 'pass' },
    ],
    gateDecisions: [
      { gateId: 'plan_approval', artifactHash: 'p0', result: 'approved' },
      { gateId: 'plan_approval', artifactHash: 'p1', result: 'approved' },
      { gateId: 'client_test', artifactHash: 'd1', result: 'done' },
    ],
    warningAcceptances: [{ verdictId: 'v-warning' }],
    completions: [
      { stageId: 'setup', artifactHashes: { fbx: 'f1' } },
      { stageId: 'optional', artifactHashes: { plan: 'p1' } },
      { stageId: 'package', artifactHashes: { plan: 'p1' } },
    ],
    outOfBoundsChanges: [{ stageId: 'setup', artifact: 'fbx', accepted: true }],
  };
  for (const [kind, hash] of Object.entries(input.artifactHashes)) {
    db.prepare('INSERT INTO artifact_version (workflow_id, kind, hash) VALUES (?, ?, ?)').run('flow-1', kind, hash);
  }
  for (const verdict of input.verdicts) {
    db.prepare(`INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result, basis)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        verdict.id, 'flow-1', verdict.checkId, verdict.scope, verdict.artifactHash, verdict.result, verdict.basis ?? null,
      );
  }
  for (const decision of input.gateDecisions) {
    db.prepare(`INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result)
      VALUES (?, ?, ?, ?)`).run('flow-1', decision.gateId, decision.artifactHash, decision.result);
  }
  db.prepare("INSERT INTO warning_acceptance (workflow_id, verdict_id) VALUES ('flow-1', 'v-warning')").run();
  for (const completion of input.completions) {
    db.prepare(`INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json)
      VALUES (?, ?, ?)`).run('flow-1', completion.stageId, JSON.stringify(completion.artifactHashes));
  }
  db.prepare(`INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact, accepted)
    VALUES ('flow-1', 'setup', 'fbx', 1)`).run();
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('flow-2', 'scene', 'other')").run();

  assert.deepEqual(buildAggregateInput(db, 'flow-1'), input);
  assert.deepEqual(aggregateWorkflow(db, 'flow-1', definition), aggregateProcess(definition, input));
  assert.equal(aggregateWorkflow(db, 'flow-1', definition).stages.setup?.status, 'passed');
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('flow-1', 'scene', 's2')").run();
  input.artifactHashes.scene = 's2';
  assert.deepEqual(aggregateWorkflow(db, 'flow-1', definition), aggregateProcess(definition, input));
  assert.match(aggregateWorkflow(db, 'flow-1', definition).stages.setup?.reasons.join() ?? '', /stale verdict/);
  assert.equal(buildAggregateInput(db, 'flow-2').artifactHashes.scene, 'other');
  assert.throws(() => buildAggregateInput(db, 'missing'), /Unknown workflow/);
});

test('reopen retains data without repeating migration', t => {
  const { db, path } = temporaryDb(t);
  seedWorkflow(db);
  db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('flow-1', 'plan', 'p1')").run();
  db.close();
  const reopened = openDatabase(path);
  try {
    assert.deepEqual(reopened.prepare('SELECT version FROM schema_version').all().map(row => ({ ...row })), MIGRATION_VERSIONS);
    assert.equal((reopened.prepare('SELECT count(*) AS n FROM scheduler_lease').get() as { n: number }).n, 1);
    assert.deepEqual(buildAggregateInput(reopened, 'flow-1').artifactHashes, { plan: 'p1' });
    assert.equal((reopened.prepare('SELECT count(*) AS n FROM artifact_version').get() as { n: number }).n, 1);
  } finally {
    reopened.close();
  }
});

test('each migration applies once by version: one that a database lacks below its highest version is applied on open', t => {
  // Parallel branches take migration numbers ahead of each other; a database may hold a later one before an earlier lands.
  const { db, path } = temporaryDb(t);
  db.exec('DROP TABLE project_recovery'); db.exec('DROP TABLE project_package_action');
  db.exec('DELETE FROM schema_version WHERE version = 21');
  db.close();
  const reopened = openDatabase(path);
  try {
    assert.deepEqual(reopened.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row => ({ ...row })), MIGRATION_VERSIONS);
    assert.equal((reopened.prepare('SELECT count(*) AS n FROM project_recovery').get() as { n: number }).n, 0);
  } finally { reopened.close(); }
});

test('version 1 database upgrades additively and leaves legacy completions unbound', t => {
  const directory = mkdtempSync(join(tmpdir(), 'avatar-harness-upgrade-'));
  t.after(() => removeTemp(directory));
  const path = join(directory, 'old.sqlite');
  const old = new DatabaseSync(path);
  old.exec(readFileSync(new URL('../../src/state/migrations/0001_init.sql', import.meta.url), 'utf8'));
  old.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
  old.exec('INSERT INTO schema_version (version) VALUES (1)');
  seedWorkflow(old);
  old.prepare("INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json) VALUES ('flow-1', 'setup', '{}')").run();
  old.close();
  const upgraded = openDatabase(path);
  try {
    assert.deepEqual(upgraded.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row => ({ ...row })),
      MIGRATION_VERSIONS);
    assert.equal((upgraded.prepare('SELECT count(*) AS n FROM scheduler_lease').get() as { n: number }).n, 1);
    assert.deepEqual(upgraded.prepare('SELECT run_id, artifact_hashes_json FROM stage_completion').all().map(row => ({ ...row })),
      [{ run_id: null, artifact_hashes_json: '{}' }]);
  } finally { upgraded.close(); }
});

test('version 6 database gains one scheduler lease row without changing legacy events', t => {
  const { db, path } = temporaryDb(t, 6);
  db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json)
    VALUES ('runtime', 'scheduler', 'global', 'scheduler_lease_acquired', 'legacy', '{}')`).run();
  db.close();
  const upgraded = openDatabase(path);
  try {
    assert.deepEqual(upgraded.prepare('SELECT id, holder, cycle FROM scheduler_lease').all().map(row => ({ ...row })),
      [{ id: 1, holder: null, cycle: 0 }]);
    assert.equal((upgraded.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, 1);
    assert.equal((upgraded.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number }).version, SCHEMA_VERSION);
  } finally { upgraded.close(); }
});

test('version 7 database: temporary Task Workflows take the state of their latest Task', t => {
  const { db, path } = temporaryDb(t, 7);
  db.prepare("INSERT INTO workspace (id, path) VALUES ('ws', '/w')").run();
  db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('p', 'ws', 'sample', '/w/p', '{}', 'active', 'h', 'k')`).run();
  for (const [workflow, statuses] of [['done', ['FAILED', 'PASSED']], ['stopped', ['CANCELLED']], ['open', ['PASSED', 'READY']],
    ['formal', ['PASSED']]] as const) {
    db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
      VALUES (?, 'p', ?, ?, 'k', 'active', '{}')`).run(workflow, workflow === 'formal' ? 'x' : 'avh-task/0.1',
      workflow === 'formal' ? 'hash' : 'avh-task/0.1');
    statuses.forEach((status, i) => db.prepare(`INSERT INTO task (id, workflow_id, stage_id, goal, capability, status)
      VALUES (?, ?, 'work', 'g', 'executor', ?)`).run(`${workflow}-${i}`, workflow, status));
  }
  db.close();
  const upgraded = openDatabase(path);
  try {
    assert.deepEqual(Object.fromEntries((upgraded.prepare('SELECT id, status FROM workflow ORDER BY id').all() as { id: string; status: string }[])
      .map(row => [row.id, row.status])), { done: 'passed', formal: 'active', open: 'active', stopped: 'cancelled' });
  } finally { upgraded.close(); }
});

test('version 33 upgrade retains unknown evidence bindings and never invents snapshots for historic Runs', t => {
  const { db, path } = temporaryDb(t, 33); seedWorkflow(db);
  db.prepare("INSERT INTO verdict(id,workflow_id,check_id,scope,artifact_hash,result) VALUES('old-verdict','flow-1','face_ok','edit','same','pass')").run();
  db.prepare("INSERT INTO gate_decision(workflow_id,gate_id,artifact_hash,result) VALUES('flow-1','old-gate','same','approved')").run();
  db.prepare("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status,inputs_json) VALUES('old-task','flow-1','face','old','face','RUNNING','{}')").run();
  db.prepare("INSERT INTO run(id,task_id,attempt,status) VALUES('old-run','old-task',1,'running')").run();
  db.close(); const upgraded = openDatabase(path);
  try {
    assert.equal(upgraded.prepare("SELECT input_hashes_json FROM verdict WHERE id='old-verdict'").get()!.input_hashes_json, null);
    assert.equal(upgraded.prepare('SELECT input_hashes_json FROM gate_decision').get()!.input_hashes_json, null);
    assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM run_input_snapshot').get()!.n, 0);
    assert.equal(upgraded.prepare('SELECT COUNT(*) n FROM workflow_input_revision').get()!.n, 0);
    assert.equal(upgraded.prepare("SELECT status FROM run WHERE id='old-run'").get()!.status, 'running');
  } finally { upgraded.close(); }
});
