import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeTemp } from '../fixtures/platform.ts';

/** A Runtime tree with the server beside it, stopped at a build barrier, so the real check.mjs can be run for real. */
function standIn(t: test.TestContext): { root: string; server: string } {
  const base = mkdtempSync(join(tmpdir(), 'avh-check-server-'));
  t.after(() => removeTemp(base));
  const root = join(base, 'harness'), server = join(base, 'server');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'node_modules/typescript/bin'), { recursive: true });
  mkdirSync(server);
  copyFileSync(new URL('../../scripts/check.mjs', import.meta.url), join(root, 'scripts/check.mjs'));
  // check.mjs gets the unit suite's per-test budget and stall supervisor from this module; without it the
  // stand-in check cannot even load, and every step it was supposed to reach silently reports nothing.
  copyFileSync(new URL('../../scripts/unit-suite.mjs', import.meta.url), join(root, 'scripts/unit-suite.mjs'));
  writeFileSync(join(root, 'scripts/build-native.mjs'), 'process.exit(0);\n');
  writeFileSync(join(root, 'node_modules/typescript/bin/tsc'), 'process.exit(0);\n');
  // Deliberately stop at the build, after the steps under test: reaching it proves they ran.
  writeFileSync(join(root, 'scripts/build.mjs'), "throw Error('build-barrier');\n");
  writeFileSync(join(root, 'trivial.test.mjs'), "import test from 'node:test';\ntest('trivial', () => {});\n");
  writeFileSync(join(root, 'scripts/nginx-boundary.mjs'), 'process.exit(Number(process.env.FIXTURE_BOUNDARY_EXIT ?? 3));\n');
  return { root, server };
}
function runCheck(root: string, extra: string[] = []) {
  return spawnSync(process.execPath, [join(root, 'scripts/check.mjs'), ...extra, '--log', join(root, 'check.log')],
    { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true });
}

test('the total check typechecks and tests the server beside the Runtime', t => {
  const { root, server } = standIn(t);
  writeFileSync(join(server, 'probe.mjs'),
    "import { appendFileSync } from 'node:fs';\nappendFileSync(new URL('ran.txt', import.meta.url), `${process.argv[2]}\\n`);\n");
  writeFileSync(join(server, 'package.json'), JSON.stringify({ name: 'fixture-server', private: true, type: 'module',
    scripts: { typecheck: 'node probe.mjs typecheck', test: 'node probe.mjs test' } }));

  const result = runCheck(root);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /OK\s+server typecheck/);
  assert.match(result.stdout, /OK\s+server tests/);
  assert.match(result.stdout, /FAIL build/);
  assert.deepEqual(readFileSync(join(server, 'ran.txt'), 'utf8').trim().split('\n'), ['typecheck', 'test'],
    'both server scripts ran from the server directory');
});

test('an unrunnable nginx boundary is reported as skipped, never as a pass', t => {
  const { root } = standIn(t);
  const result = runCheck(root, ['--nginx-boundary']);
  assert.equal(result.status, 1, 'the build barrier still ends the run');
  assert.match(result.stdout, /SKIP nginx api boundary/);
  assert.doesNotMatch(result.stdout, /OK\s+nginx api boundary/);
  assert.match(result.stdout, /跳过 1 项/);
});

test('a failing nginx boundary fails the total check', t => {
  const { root } = standIn(t);
  const result = spawnSync(process.execPath, [join(root, 'scripts/check.mjs'), '--nginx-boundary', '--log', join(root, 'check.log')],
    { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, FIXTURE_BOUNDARY_EXIT: '1' } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL nginx api boundary/);
  assert.doesNotMatch(result.stdout, /FAIL build/, 'a failed deployment check ends the run before the build');
});
