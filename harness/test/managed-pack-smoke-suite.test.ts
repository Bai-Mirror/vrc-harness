import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluatePackCandidate } from '../src/managed-pack-evaluator.ts';
import { registerPackCandidate } from '../src/managed-pack-candidate.ts';
import { openDatabase } from '../src/state/db.ts';
import { removeTemp } from './fixtures/platform.ts';

const bundledId = (JSON.parse(readFileSync(new URL('../builtin/pack.json', import.meta.url), 'utf8')) as { id: string }).id;
const bundledSuite = new URL('../builtin/evaluation/smoke/', import.meta.url);

/** The bundled pack installed as the baseline, plus a candidate copy the ordinary entry can evaluate. */
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-smoke-suite-')), home = join(root, 'home'), source = join(root, 'source');
  t.after(() => removeTemp(root));
  cpSync(new URL('../builtin/', import.meta.url), source, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, 'pack.json'), 'utf8')) as Record<string, unknown>;
  Object.assign(manifest, { id: 'candidate-fit-v2', version: '0.2.0-candidate.1', channel: 'candidate' });
  writeFileSync(join(source, 'pack.json'), JSON.stringify(manifest));
  const baseline = join(home, 'managed/packs', bundledId);
  mkdirSync(join(home, 'managed/packs'), { recursive: true });
  cpSync(new URL('../builtin/', import.meta.url), baseline, { recursive: true });
  const db = openDatabase(join(root, 'state.db'));
  t.after(() => db.close());
  registerPackCandidate(db, home, source, { basePackId: bundledId, sourceKind: 'ai', reason: 'suite fixture', impact: {}, permissions: {} });
  return { root, home, source, db };
}

test('the shipped smoke suite runs its whole contract, not one case, through the ordinary entry', async t => {
  const f = fixture(t);
  const suite = JSON.parse(readFileSync(new URL('suite.json', bundledSuite), 'utf8')) as { id: string; cases: Array<{ id: string; command: string[] }> };
  assert.equal(suite.id, 'managed-pack-smoke');
  assert.ok(suite.cases.length > 1, 'the packaged suite carries more than one case');
  assert.deepEqual([...new Set(suite.cases.flatMap(item => item.command))].filter(part => part.endsWith('.mjs')).sort(),
    ['{suite}/verify-pack-contract.mjs', '{suite}/verify-pack.mjs'], 'every case runs a real checker');

  const evaluation = await evaluatePackCandidate(f.db, f.home, 'candidate-fit-v2', fileURLToPath(bundledSuite), { allowProcessFallback: true });
  assert.equal(evaluation.status, 'passed');
  const rows = f.db.prepare("SELECT case_id, model_family, evidence_ref FROM managed_pack_case_result WHERE subject='candidate'").all() as
    Array<{ case_id: string; model_family: string; evidence_ref: string }>;
  assert.deepEqual(rows.map(row => row.case_id).sort(), suite.cases.map(item => item.id).sort());
  assert.ok(rows.every(row => existsSync(join(f.home, row.evidence_ref))), 'every case left owned evidence');
  assert.deepEqual([...new Set(rows.map(row => row.model_family))], ['deterministic'],
    'structural checks are not labelled with model families: that would fake D5 coverage');
});

test('a pack that names a tool it does not ship fails the contract check', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-smoke-broken-'));
  t.after(() => removeTemp(root));
  cpSync(new URL('../builtin/', import.meta.url), root, { recursive: true });
  const checker = fileURLToPath(new URL('verify-pack-contract.mjs', bundledSuite));
  const run = (aspect: string) => spawnSync(process.execPath, [checker, root, aspect], { encoding: 'utf8', windowsHide: true });
  assert.equal(run('process-definitions').status, 0, 'the untouched pack passes');

  // A definition the pack ships but whose tool it does not: the check must cover every definition it finds.
  writeFileSync(join(root, 'knowledge/process/extra.process.yaml'),
    'schema: process/0.1\nid: extra\nversion: "1"\nstages:\n  - id: do-thing\n    needs: []\n    command: [python3, "{toolRoot}/harness/nonexistent-tool.py"]\n');
  const broken = run('process-definitions');
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /missing tool harness\/nonexistent-tool.py/);

  const capability = join(root, 'knowledge/process/pc-recolor-outfit.capabilities.yaml');
  writeFileSync(capability, readFileSync(capability, 'utf8').replace('command: [python3,', 'command: [curl,'));
  const executable = run('capability-commands');
  assert.equal(executable.status, 1);
  assert.match(executable.stdout, /executable not allowed: curl/);
});

test('a suite that declares several families records multi-family evidence through the same entry', async t => {
  const f = fixture(t), suite = join(f.root, 'family-suite');
  mkdirSync(suite);
  const checker = join(suite, 'check.mjs');
  writeFileSync(checker, "console.log(JSON.stringify({result:'pass'}));\n");
  const families = ['gpt', 'claude', 'deepseek'];
  writeFileSync(join(suite, 'suite.json'), JSON.stringify({ schema: 'harness-pack-evaluation/0.1', id: 'family-coverage', version: '1',
    cases: families.map(family => ({ id: `stage-${family}`, modelFamily: family, attempts: 1, timeoutMs: 5000,
      command: [process.execPath, checker] })) }));
  const evaluation = await evaluatePackCandidate(f.db, f.home, 'candidate-fit-v2', suite, { allowProcessFallback: true });
  assert.equal(evaluation.status, 'passed');
  assert.equal((evaluation.summary.candidate as { modelFamilies: number }).modelFamilies, families.length);
  assert.equal(f.db.prepare("SELECT count(DISTINCT model_family) AS n FROM managed_pack_case_result WHERE subject='candidate'").get()!.n, families.length,
    'the ordinary entry records one result per declared family, which is what D5 counts coverage by');
});
