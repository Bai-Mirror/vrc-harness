// How the unit suite is started, in one place, so `npm test` and the full check cannot drift apart — and so
// neither can wait forever.
//
// Two different stalls have to be caught, and they need two different mechanisms:
//
//   1. A test that stops making progress asynchronously (an API call that never answers, a promise that never
//      settles). `--test-timeout` bounds it and Node's reporter names the test, which is what makes it actionable.
//   2. A test that blocks the event loop synchronously. The per-test timeout is delivered by a timer, so it cannot
//      fire while the loop is blocked: measured here, a test blocked in `spawnSync` for 4.5s still passed under
//      `--test-timeout=1500`. `test/windows-setup.test.ts` blocks exactly like that, up to 120s per PowerShell call.
//      Only a parent process can stop it, so the suite runs under a supervisor that stops the whole process tree
//      when the run stops producing output.
import { spawn, spawnSync } from 'node:child_process';

/**
 * Per-test budget for the unit suite. Measured while this suite, a second full suite and two focused test loops were
 * all running at once, the longest single test took 80s — so this is a little under four times the worst case seen on
 * the busiest machine available here, long enough that a slow machine is never mistaken for a stall and short enough
 * that a real one is reported while the log is still useful. It stays below the silence budget on purpose, so a
 * stalled run is normally named by Node rather than stopped from outside without naming it.
 *
 * A test that declares its own `timeout` keeps it: Node treats the option as that test's budget and the runner flag
 * as the default, which was measured directly. The Unity integration tests budget up to 30 minutes and are therefore
 * not cut short by this value.
 */
export const UNIT_TEST_TIMEOUT_MS = 300_000;

/**
 * How long the supervised run may produce nothing at all before it is stopped. Node's reporters announce a test when
 * it starts and when it ends, so a blocked test goes silent while an ordinary slow one does not. The default suite
 * (no `AVH_LOCAL_UNITY_EDITOR`) is the one this guards; a real editor run is opted into by environment and reports
 * nothing for minutes at a time by design, so there it is widened instead of misfiring.
 */
export const TEST_SILENCE_MS = 10 * 60_000;
export const TEST_SILENCE_WITH_UNITY_MS = 60 * 60_000;
/** An absolute backstop for a run that keeps dribbling output without ever finishing. */
export const TEST_WALL_CLOCK_MS = 3 * 60 * 60_000;

/**
 * The environment variables that make the suite start a real editor. Each one names an editor a test file passes
 * straight to the machine, so the file has to hold the machine-level Unity slot while it runs (test/fixtures/unity-slot.ts).
 */
export const UNITY_TEST_ENV = ['AVH_LOCAL_UNITY_EDITOR', 'AVH_FACE_UNITY_EDITOR', 'AVH_FACE_PREVIEW_UNITY_EDITOR'];

/** Whether this environment runs real editors. */
export function unityTestEnvironment(env = process.env) {
  return UNITY_TEST_ENV.some(name => !!env[name]);
}

/**
 * `node --test` with the shared per-test budget, plus whatever the caller adds. A real-editor run is serialised:
 * concurrency would not overlap the editors anyway (they queue on one machine-level slot), it would only interleave the
 * files' output while one of them holds the lock, and a person who set an editor variable should not also have to
 * remember the flag. An explicit `--test-concurrency` from the caller is left alone.
 */
export function unitTestArgs(extra = [], env = process.env) {
  const serial = unityTestEnvironment(env) && !extra.some(arg => String(arg).startsWith('--test-concurrency')) ? ['--test-concurrency=1'] : [];
  return ['--test', `--test-timeout=${UNIT_TEST_TIMEOUT_MS}`, ...serial, ...extra];
}

/** The silence bound for this environment: a real Unity editor legitimately reports nothing for many minutes. */
export function silenceBudgetMs(env = process.env) {
  return unityTestEnvironment(env) ? TEST_SILENCE_WITH_UNITY_MS : TEST_SILENCE_MS;
}

/** Stops the runner and the test-file processes it started; a step that is stopped must not leave work behind. */
function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

/**
 * Runs `node --test` in its own process group, streaming what it prints, and stops the tree if the run goes silent
 * for `silenceMs` or exceeds `wallClockMs`. Resolves with how it ended, including the last lines seen, so the caller
 * can fail the step and say which test it was in.
 *
 * The promise always settles: a stopped run that will not go away is reported, never waited on, because the whole
 * point of supervising the step is that the caller cannot end up waiting forever.
 */
export function superviseSuite(args, options = {}) {
  const { cwd = process.cwd(), env = process.env, onOutput = () => {} } = options;
  const silenceMs = options.silenceMs ?? silenceBudgetMs(env);
  const wallClockMs = options.wallClockMs ?? TEST_WALL_CLOCK_MS;
  const stopGraceMs = options.stopGraceMs ?? 60_000;
  return new Promise(resolve => {
    const started = Date.now();
    const tail = [];
    let pending = '', lastOutput = Date.now(), stalled, stopDeadline, settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearInterval(watchdog); resolve(result); };
    const report = extra => ({ stalled, seconds: ((Date.now() - started) / 1000).toFixed(1),
      tail: [...tail, pending].filter(line => line.trim()), ...extra });
    // `detached` puts the runner and its test files in one process group, so stopping it stops all of them.
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'] });
    const consume = chunk => {
      lastOutput = Date.now();
      const text = chunk.toString();
      onOutput(text);
      const lines = (pending + text).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) { tail.push(line); if (tail.length > 40) tail.shift(); }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', error => { stalled ??= `could not start the test runner: ${error.message}`; });
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (!stalled) {
        const idle = now - lastOutput, total = now - started;
        if (idle >= silenceMs) stalled = `produced nothing for ${Math.round(idle / 1000)}s`;
        else if (total >= wallClockMs) stalled = `still running after ${Math.round(total / 1000)}s`;
        if (stalled) { stopTree(child); stopDeadline = now + stopGraceMs; }
      } else if (now >= stopDeadline) {
        stalled += `; the process tree was still there ${Math.round(stopGraceMs / 1000)}s later`;
        finish(report({ status: null, signal: null, stopConfirmed: false }));
      }
    }, 1000);
    child.on('close', (status, signal) => finish(report({ status, signal, stopConfirmed: true })));
  });
}
