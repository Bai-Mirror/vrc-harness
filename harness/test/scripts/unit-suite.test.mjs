// Guards the bound on the unit suite. Two things used to be true and must not become true again:
//   1. `npm test` and `npm run check` ran `node --test` with no per-test budget, so one stalled test never returned.
//   2. Even with a per-test budget, a test that blocks the event loop cannot be stopped from inside: measured, a
//      test blocked in `spawnSync` for 4.5s still passed under `--test-timeout=1500`. Only a parent process can end
//      that, so the check's unit-test step must stay supervised and must say which test it was in.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { UNIT_TEST_TIMEOUT_MS, TEST_SILENCE_MS, TEST_SILENCE_WITH_UNITY_MS, silenceBudgetMs, superviseSuite, unitTestArgs } from '../../scripts/unit-suite.mjs';

const harnessRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** A nested `node --test` must not be told it is a worker of the runner that is already running this file. */
function bareEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('both entry points carry a finite per-test budget and the check supervises the suite', () => {
  assert.deepEqual(unitTestArgs([], {}), ['--test', `--test-timeout=${UNIT_TEST_TIMEOUT_MS}`]);
  // A real editor run takes the machine-level Unity slot, so its files run one at a time and its silence bound widens.
  const withEditor = ['--test', `--test-timeout=${UNIT_TEST_TIMEOUT_MS}`, '--test-concurrency=1'];
  assert.deepEqual(unitTestArgs([], { AVH_LOCAL_UNITY_EDITOR: 'editor' }), withEditor);
  assert.deepEqual(unitTestArgs([], { AVH_FACE_UNITY_EDITOR: 'editor' }), withEditor);
  assert.deepEqual(unitTestArgs(['--test-concurrency=4'], { AVH_LOCAL_UNITY_EDITOR: 'editor' }), withEditor.slice(0, 2).concat('--test-concurrency=4'),
    'a caller who names a concurrency keeps it');
  assert.ok(Number.isSafeInteger(UNIT_TEST_TIMEOUT_MS), 'the per-test budget is a plain integer');
  // The longest test measured while two full suites ran at once was 80s, so the budget has to be well clear of that
  // (a slow machine is not a stall) while still being a bound someone can wait out (a stall is not a hang).
  assert.ok(UNIT_TEST_TIMEOUT_MS >= 120_000 && UNIT_TEST_TIMEOUT_MS <= 1_200_000,
    `per-test budget ${UNIT_TEST_TIMEOUT_MS}ms is outside the band a stalled test can be waited out in`);
  const scripts = JSON.parse(readFileSync(join(harnessRoot, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.test, 'node scripts/run-unit-suite.mjs', '`npm test` goes through the shared runner, not bare `node --test`');
  const launcher = readFileSync(join(harnessRoot, 'scripts/run-unit-suite.mjs'), 'utf8');
  assert.match(launcher, /unitTestArgs\(/, 'the developer entry point uses the shared budget');
  assert.match(launcher, /superviseSuite\(/, 'the developer entry point is supervised too');
  // `node --test` discovers files by name (`**/test.mjs`, `**/test-*.mjs`, `**/*-test.mjs`, `**/*.test.mjs`, ...).
  // A runner named that way is run as a test file, which starts the suite from inside itself — measured, that is
  // exactly what happened before these two files were renamed out of those patterns.
  const discovery = /(^|\/)(?:test\.[cm]?js|test-.*\.(?:[cm]?js|ts)|.*[_-]test\.(?:[cm]?js|ts)|.*\.test\.(?:[cm]?js|ts))$/;
  for (const name of readdirSync(join(harnessRoot, 'scripts')))
    assert.doesNotMatch(name, discovery, `scripts/${name} would be discovered as a test file and run the suite from inside itself`);
  const check = readFileSync(join(harnessRoot, 'scripts/check.mjs'), 'utf8');
  assert.match(check, /superviseSuite\(unitTestArgs\(/, 'the check supervises the unit tests with the shared budget');
  // A real Unity editor reports nothing for minutes at a time by design; its run must not be cut short.
  assert.ok(silenceBudgetMs({}) < silenceBudgetMs({ AVH_LOCAL_UNITY_EDITOR: 'editor' }),
    'a real Unity editor run gets the wider silence budget');
  assert.equal(silenceBudgetMs({ AVH_FACE_UNITY_EDITOR: 'editor' }), TEST_SILENCE_WITH_UNITY_MS,
    'every variable that starts a real editor widens it, not only the local one');
  assert.ok(TEST_SILENCE_MS >= 300_000 && TEST_SILENCE_WITH_UNITY_MS > TEST_SILENCE_MS);
});

test('a test that never settles is stopped by the per-test budget and reported by name', () => {
  const root = mkdtempSync(join(tmpdir(), 'avh-runner-guard-'));
  try {
    const file = join(root, 'hangs.test.mjs');
    writeFileSync(file, "import test from 'node:test';\ntest('a test that never settles', async () => { await new Promise(() => {}); });\n");
    // The budget from the entry points is minutes long; this proves the mechanism Node reports with, and that it
    // names the test, without waiting that long. The configured value itself is asserted above.
    const started = Date.now();
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=1000', file], { encoding: 'utf8', windowsHide: true, env: bareEnv() });
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, 'a test that never settles fails the run');
    assert.match(output, /a test that never settles/, 'the report names the test that was stopped');
    assert.match(output, /timed out|timeout/i, 'the report says it was the budget that stopped it');
    assert.ok(Date.now() - started < 60_000, 'and the run ends rather than waiting for a person');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a child that blocks the loop and goes silent is stopped with its whole tree', async t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-runner-stall-'));
  const grandchildPidFile = join(root, 'grandchild.pid');
  let grandchild;
  t.after(() => { try { if (grandchild) process.kill(grandchild); } catch { /* already stopped */ } rmSync(root, { recursive: true, force: true }); });
  const stall = join(root, 'stall.mjs');
  writeFileSync(stall, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
    "console.log('blocked and silent from here');",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const result = await superviseSuite([stall], { silenceMs: 900, wallClockMs: 60_000, env: bareEnv() });
  assert.match(String(result.stalled), /produced nothing/, 'the supervisor stops a run that stops producing output');
  assert.equal(result.stopConfirmed, true, 'and confirms the stopped tree actually went away');
  assert.ok(result.tail.some(line => line.includes('blocked and silent from here')), 'and keeps the last output for the report');
  await delay(500);
  grandchild = Number(readFileSync(grandchildPidFile, 'utf8'));
  assert.equal(alive(grandchild), false, 'the stopped step leaves no process behind, including the ones the child started');
});
