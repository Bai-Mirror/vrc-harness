import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/state/db.ts';
import { createProject, createWorkflow } from '../src/workflow/runtime.ts';
import { serveOnce } from '../src/task-cli.ts';
import { waitFor } from './fixtures/wait.ts';

// Downloads public pinned packages and invokes the host's real preventing sandbox and process supervisor.
// No Provider, credentials, user project, Unity license, or upload action is used.
test('the Runtime prepares and independently verifies a no-template environment with its real supervisor',
  { skip: process.env.AVH_ENVIRONMENT_IT !== '1', timeout: 900_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'avh-environment-runtime-'));
    console.log(`Environment integration evidence: ${root}`);
    const home = join(root, 'home'), workspace = join(root, 'workspace'), knowledge = join(root, 'knowledge');
    for (const path of [join(home, 'config'), join(home, 'state'), workspace, knowledge, join(root, 'exports')]) mkdirSync(path, { recursive: true });
    const builtin = fileURLToPath(new URL('../builtin/', import.meta.url));
    const definition = parse(readFileSync(join(builtin, 'knowledge/process/pc-recolor-outfit.process.yaml'), 'utf8'));
    const capabilities = parse(readFileSync(join(builtin, 'knowledge/process/pc-recolor-outfit.capabilities.yaml'), 'utf8'));
    const stage = definition.stages.find((s: { id: string }) => s.id === 'environment');
    const profile = 'environment-validation';
    writeFileSync(join(knowledge, 'process.yaml'), stringify({ schema: definition.schema, id: profile, version: '1',
      applies_to: {}, artifacts: ['environment'], stages: [{ ...stage, needs: [] }],
      checks: definition.checks.filter((c: { id: string }) => c.id === 'environment_lock_consistent'), gates: [], milestones: [] }));
    writeFileSync(join(knowledge, 'capabilities.yaml'), stringify({ schema: capabilities.schema, process: profile, version: '1',
      artifacts: { environment: capabilities.artifacts.environment }, stages: { environment: capabilities.stages.environment },
      observers: { 'environment.verify': capabilities.observers['environment.verify'] } }));
    writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: '1', t: {} }));
    writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: workspace, toolRoot: join(builtin, 'tools'),
      knowledgeRoot: knowledge, exportRoots: [join(root, 'exports')], knownBodies: [], projectAliases: {}, sampleNames: [],
      processDefinitions: { [profile]: { definition: 'process.yaml', capabilities: 'capabilities.yaml' } },
      defaultProfile: profile, thresholdsFile: 'thresholds.yaml', providers: [] }));
    const config = loadConfig(home);
    createProject(config, 'sample');
    const db = openDatabase(join(home, 'state/harness.db'));
    try {
      const workflow = createWorkflow(db, config, 'sample', profile);
      const terminal = ['PASSED', 'FAILED', 'CANCELLED', 'BLOCKED', 'RECOVERY_REQUIRED', 'WAITING_HUMAN'];
      const status = await waitFor(async () => {
        await serveOnce(db, config);
        return (db.prepare('SELECT status FROM task WHERE workflow_id=? ORDER BY rowid DESC LIMIT 1').get(workflow) as
          { status: string } | undefined)?.status;
      }, { what: 'the environment workflow to reach a terminal status', ready: value => Boolean(value && terminal.includes(value)),
        timeoutMs: 480_000, intervalMs: 2_000 });
      const runs = db.prepare('SELECT id,status,result_json FROM run WHERE task_id IN (SELECT id FROM task WHERE workflow_id=?)').all(workflow);
      const evidence = { workflow, status, runs,
        verdicts: db.prepare('SELECT check_id,result,basis FROM verdict WHERE workflow_id=?').all(workflow) };
      writeFileSync(join(root, 'result.json'), JSON.stringify(evidence, null, 2));
      assert.equal(status, 'PASSED', `Read ${join(root, 'result.json')} and its Run logs`);
      assert.ok(evidence.verdicts.some(v => v.check_id === 'environment_lock_consistent' && v.result === 'pass'));
      assert.equal((db.prepare('SELECT count(*) AS n FROM lock').get() as { n: number }).n, 0);
    } finally { db.close(); }
  });
