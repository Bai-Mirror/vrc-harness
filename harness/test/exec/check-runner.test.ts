import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { cancelChecks, checkBwrapArgs, checkEnvironment, checkSandboxStatus, runCheckCommand } from '../../src/exec/check-runner.ts';
import { escapeRegExp, removeTemp, windows } from '../fixtures/platform.ts';
import { waitUntil } from '../fixtures/wait.ts';

const sandboxed = checkSandboxStatus().available;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-check-runner-'));
  t.after(() => removeTemp(root));
  // The check's own Harness home: on Windows the check sandbox protects it and keeps its label ledgers there.
  const project = join(root, 'project'), run = join(root, 'run'), home = join(root, 'home');
  mkdirSync(project); mkdirSync(run); mkdirSync(home);
  writeFileSync(join(project, 'input.txt'), 'input\n');
  return { root, project, run, home };
}

test('check environment keeps only locale and PATH and never forwards secrets', () => {
  const env = checkEnvironment('/scratch/home', '/scratch/tmp', { AVH_RUN_DIR: '/run' },
    { PATH: '/usr/bin', LANG: 'C.UTF-8', OPENAI_API_KEY: 'sk-secret', AWS_SECRET_ACCESS_KEY: 'x', HOME: '/home/user' }, 'linux');
  assert.deepEqual(env, { PATH: '/usr/bin', LANG: 'C.UTF-8', HOME: '/scratch/home', TMPDIR: '/scratch/tmp',
    PYTHONDONTWRITEBYTECODE: '1', AVH_RUN_DIR: '/run' });
});

test('on Windows the check environment adds what programs need to start, and its profile is the scratch home', () => {
  const env = checkEnvironment('C:\\scratch\\home', 'C:\\scratch\\tmp', { AVH_RUN_DIR: 'C:\\run' },
    { PATH: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk-secret', USERPROFILE: 'C:\\Users\\u',
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming', AVH_GUI_SESSION_TOKEN: 'token' }, 'win32');
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.AVH_GUI_SESSION_TOKEN, undefined);
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.ok(env.PATH!.startsWith('C:\\Windows\\system32'));
  assert.deepEqual([env.USERPROFILE, env.APPDATA, env.TEMP, env.TMP, env.HOME],
    ['C:\\scratch\\home', join('C:\\scratch\\home', 'AppData', 'Roaming'), 'C:\\scratch\\tmp', 'C:\\scratch\\tmp', 'C:\\scratch\\home']);
  assert.equal(env.PYTHONUTF8, '1');
});

test('check bwrap arguments: read-only root, no network, private PID namespace, project and Run read-only', () => {
  const args = checkBwrapArgs('/p', '/r', '/r/checks/c', { PATH: '/usr/bin' }, ['node', 'x.js']);
  for (const required of ['--unshare-net', '--unshare-pid', '--die-with-parent', '--new-session', '--clearenv'])
    assert.ok(args.includes(required), required);
  const pairs = (flag: string) => args.flatMap((arg, i) => arg === flag ? [`${args[i + 1]}>${args[i + 2]}`] : []);
  assert.deepEqual(pairs('--ro-bind'), ['/>/', '/p>/p', '/r>/r']);
  assert.deepEqual(pairs('--bind'), ['/r/checks/c>/r/checks/c']);
  assert.ok(args.indexOf('--tmpfs') < args.indexOf('/p'), 'project is bound back after the private /tmp');
  assert.deepEqual(args.slice(args.indexOf('--') + 1), ['node', 'x.js']);
});

test('sandboxed check cannot write outside its scratch directory or see the parent environment', { skip: !sandboxed }, async t => {
  const f = fixture(t);
  process.env.AVH_CHECK_RUNNER_SECRET = 'must-not-leak';
  t.after(() => { delete process.env.AVH_CHECK_RUNNER_SECRET; });
  const outside = join(f.root, 'escaped.txt');
  const script = [
    "const { readFileSync, writeFileSync } = require('node:fs'), { join } = require('node:path');",
    'const attempt = (path, label) => { try { writeFileSync(path, "x"); console.log(label); } catch {} };',
    `attempt(${JSON.stringify(join(f.project, 'planted.txt'))}, 'project-written');`,
    `attempt(${JSON.stringify(join(f.run, 'planted.txt'))}, 'run-written');`,
    `attempt(${JSON.stringify(outside)}, 'outside-written');`,
    "attempt(join(process.env.HOME, 'scratch.txt'), 'scratch-written');",
    "console.log(`secret=${process.env.AVH_CHECK_RUNNER_SECRET ?? 'absent'}`);",
    "process.stdout.write(readFileSync('input.txt', 'utf8'));",
  ].join('\n');
  const result = await runCheckCommand([process.execPath, '-e', script], { project: f.project, runDirectory: f.run, harnessHome: f.home, checkId: 'escape',
    timeoutMs: 10_000 });
  assert.equal(result.isolation, windows ? 'lowil' : 'bwrap');
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /project-written|run-written/);
  assert.match(result.stdout, /scratch-written/);
  assert.match(result.stdout, /secret=absent/);
  assert.match(result.stdout, /^input$/m, 'the project stays readable');
  assert.equal(existsSync(join(f.project, 'planted.txt')), false);
  assert.equal(existsSync(join(f.run, 'planted.txt')), false);
  assert.equal(existsSync(outside), false, 'a host path outside the Run is untouched');
  assert.equal(readFileSync(join(f.run, 'checks/escape.stdout.log'), 'utf8'), result.stdout);
  assert.equal(existsSync(join(f.run, 'checks/escape.pid')), false, 'the PID file is removed after exit');
});

test('check timeout kills the whole process tree and reports it', async t => {
  const f = fixture(t);
  const started = Date.now();
  // A check that leaves a detached child behind and then waits: the timeout must end both.
  const script = "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => {}, 30000);";
  const result = await runCheckCommand([process.execPath, '-e', script], { project: f.project, runDirectory: f.run, harnessHome: f.home,
    checkId: 'slow', timeoutMs: 1000 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
});

test('cancelChecks stops a running check from outside the process that started it', async t => {
  const f = fixture(t);
  const running = runCheckCommand([process.execPath, '-e', 'setTimeout(() => {}, 30000)'], { project: f.project, runDirectory: f.run, harnessHome: f.home, checkId: 'held',
    timeoutMs: 60_000 });
  await waitUntil(() => existsSync(join(f.run, 'checks/held.pid')),
    { what: 'the running check to publish its pid file', timeoutMs: 30_000, intervalMs: 10 });
  assert.ok(existsSync(join(f.run, 'checks/held.pid')));
  assert.equal(await cancelChecks(f.run), 'confirmed');
  const result = await running;
  assert.notEqual(result.status, 0);
  assert.equal(await cancelChecks(f.run), 'confirmed', 'nothing left to stop');
});

test('without a sandbox the check still gets the scrubbed environment and says it was not isolated', async t => {
  const f = fixture(t);
  process.env.AVH_CHECK_RUNNER_SECRET = 'must-not-leak';
  t.after(() => { delete process.env.AVH_CHECK_RUNNER_SECRET; });
  const result = await runCheckCommand([process.execPath, '-e', "console.log(`secret=${process.env.AVH_CHECK_RUNNER_SECRET ?? 'absent'} home=${process.env.HOME}`)"],
    { project: f.project, runDirectory: f.run, harnessHome: f.home, checkId: 'plain', timeoutMs: 10_000, isolation: 'none' });
  assert.equal(result.isolation, 'none');
  assert.ok(result.isolationNote);
  assert.match(result.stdout, /secret=absent/);
  assert.match(result.stdout, new RegExp(`home=${escapeRegExp(join(f.run, 'checks/plain/home'))}`));
});
