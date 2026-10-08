import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { UnityConfig } from '../../src/config.ts';
import { releaseUnityBatchSlot, unityMachineBatchLockPath, unityMachineBatchSlots, waitUnityBatchSlot } from '../../src/exec/unity-batch-lock.ts';
import type { UnityEvidence } from '../../src/exec/unity-steps.ts';
import { runUnitySteps } from '../../src/exec/unity-steps.ts';
import { removeTemp, windows } from '../fixtures/platform.ts';

/**
 * The Windows machine-level Unity lock is a count of slots, not one file, because Unity's account-wide licensing client
 * can serve several editors at once — but only while it is the right client. Lane U1 measured this on a real machine:
 *
 *  - a client a Low-integrity editor started serves a second Low editor and a Medium editor simultaneously;
 *  - a client a Medium-integrity editor started refuses Low editors on its channel (`Connection Refused; code:
 *    0x8000000a`), after which Unity waits out its own 60s timeout and aborts with exit code 199 before any step code
 *    runs.
 *
 * Harness always starts its editors at Low integrity, so when Harness is first to need a client on an account the
 * account gets a Low one and the slots are all usable. These two tests are the real call path (`runUnitySteps` →
 * `WindowsUnityLauncher` → the Low-integrity helper → a real editor): they fail on the behaviour, not on a mocked value.
 */
const probeSource = fileURLToPath(new URL('../fixtures/unity/U1ParallelProbe.cs', import.meta.url));
const editor = process.env.AVH_LOCAL_UNITY_EDITOR;
const enabled = windows && !!editor;
const METHOD = 'AVH.Harness.U1ParallelProbe.Run';

/** Normally the tree is removed; U1_KEEP keeps it, so a failing run can be inspected instead of re-guessed. */
function cleanup(root: string): void {
  if (process.env.U1_KEEP) { console.log(`[u1] kept ${root}`); return; }
  removeTemp(root);
}

/** A minimal project whose only editor script is the probe; the editor compiles it on its first start. The source
 *  carries the project's name so no two projects here are byte-identical, which is what a real pair of projects never
 *  is either. (Measured: this does not change the build graph's dag name, which is `1900b0aE.dag` in every project.) */
function makeProject(root: string, name: string): string {
  const project = join(root, name);
  mkdirSync(join(project, 'Assets', 'Editor'), { recursive: true });
  mkdirSync(join(project, 'Packages'), { recursive: true });
  mkdirSync(join(project, 'ProjectSettings'), { recursive: true });
  writeFileSync(join(project, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} }));
  writeFileSync(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  writeFileSync(join(project, 'Assets', 'Editor', 'U1ParallelProbe.cs'),
    `${readFileSync(probeSource, 'utf8')}\n// project: ${name}\n`);
  return project;
}

/** The machine-level lock, as the Runtime takes it: the real per-account path, so this contends with every other lane
 *  on the machine instead of inventing a private lock that would serialise nothing. */
function unityConfig(): UnityConfig {
  return { runner: editor!, editor: editor!, lockPath: unityMachineBatchLockPath(), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: ['Library', 'Temp', 'Logs', 'UserSettings', 'obj'],
    defaultTimeoutSec: 900, passEnv: ['PATH'] };
}

function step(marker: string, label: string, holdMs = 0): { method: string; quit: boolean; timeoutSec: number; env: Record<string, string> } {
  return { method: METHOD, quit: true, timeoutSec: 300,
    env: { AVH_U1_OUT: marker, AVH_U1_LABEL: label, ...(holdMs > 0 ? { AVH_U1_HOLD_MS: String(holdMs) } : {}) } };
}

/** A plain Medium-integrity editor's profile: its own HOME with the account's Hub licence seeded, exactly as a
 *  development fixture or an editor started outside Harness would have to be given one. */
function mediumEnvironment(root: string, name: string): NodeJS.ProcessEnv {
  const home = join(root, name), temp = join(root, `${name}-tmp`);
  mkdirSync(join(home, 'AppData', 'Local', 'Unity'), { recursive: true });
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
  mkdirSync(temp, { recursive: true });
  const licenses = join(process.env.LOCALAPPDATA ?? '', 'Unity', 'licenses');
  if (existsSync(licenses)) cpSync(licenses, join(home, 'AppData', 'Local', 'Unity', 'licenses'), { recursive: true });
  return { ...process.env, USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), TEMP: temp, TMP: temp };
}

async function withEnvironment<T>(values: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) { previous[key] = process.env[key]; process.env[key] = value; }
  try { return await run(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`the Low-integrity step never reported ${path}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

const marker = (path: string): string => readFileSync(path, 'utf8');

/** When one editor was really running, from the editor's own clock: `<out>.ready` carries `start`, `<out>.done` `end`. */
function interval(out: string): { start: number; end: number } {
  const at = (file: string, key: string): number => {
    const found = new RegExp(`${key}=(\\d+)`).exec(readFileSync(file, 'utf8'));
    if (!found) throw new Error(`${file} carries no ${key}=`);
    return Number(found[1]);
  };
  return { start: at(`${out}.ready`, 'start'), end: at(`${out}.done`, 'end') };
}

function failure(evidence: UnityEvidence[]): string {
  const step = evidence[0];
  return `${JSON.stringify(step)}; ${step?.errors?.slice(-4).join(' | ') ?? 'no evidence'}`;
}

/** The lines that explain a non-zero editor exit, for the assertion message. */
function logEvidence(path: string): string {
  if (!existsSync(path)) return 'no log';
  const lines = readFileSync(path, 'utf8').match(/.*(?:error CS|Error|Exception|No valid|Licensing).*/g);
  return lines?.slice(-6).join(' | ') ?? 'no matching lines';
}

test('two Low-integrity Unity steps run at once on one account instead of one queueing behind the other',
  { skip: !enabled && 'Set AVH_LOCAL_UNITY_EDITOR on Windows to run real Unity integration', timeout: 1_800_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-unity-parallel-')); t.after(() => cleanup(root));
    const home = join(root, 'avh-home'); mkdirSync(home, { recursive: true });
    const unity = unityConfig();
    // The marker has to live inside a path the step may write: a Low-integrity editor can only write where Harness
    // labelled it (the project and the Run directory), so a marker beside the temp root is refused by Windows itself.
    const one = join(root, 'run-one', 'one.txt'), two = join(root, 'run-two', 'two.txt');
    const projectOne = makeProject(root, 'one'), projectTwo = makeProject(root, 'two');
    // Three slots, so one older single-slot lane still running elsewhere on this machine can hold the base file
    // without making the two steps below queue: the property under test is that two editors run at the same time.
    const [first, second] = await withEnvironment({ AVH_HOME: home, AVH_UNITY_SLOTS: '3' }, () => Promise.all([
      runUnitySteps(unity, [step(one, 'one', 8_000)], projectOne, join(root, 'run-one')),
      runUnitySteps(unity, [step(two, 'two', 8_000)], projectTwo, join(root, 'run-two')),
    ]));
    assert.equal(first[0]?.exitCode, 0, `the first step did not finish: ${failure(first)}`);
    assert.equal(second[0]?.exitCode, 0, `the second step did not finish: ${failure(second)}`);
    assert.equal(first[0]?.isolation, 'lowil', 'the steps must run under the Low-integrity boundary');
    assert.equal(second[0]?.isolation, 'lowil', 'the steps must run under the Low-integrity boundary');
    assert.match(marker(`${one}.done`), /integrity=low/, 'the first step must have run its own code, at Low integrity');
    assert.match(marker(`${two}.done`), /integrity=low/, 'the second step must have run its own code, at Low integrity');
    // The load-independent part: with one slot the second editor could only start after the first exited, so the two
    // intervals could not overlap. This is the assertion the fix has to earn, and the one its absence breaks.
    const left = interval(one), right = interval(two);
    assert.ok(left.start < right.end && right.start < left.end,
      `the two editors did not run at the same time: ${JSON.stringify({ left, right })}`);
  });

test('a Medium-integrity editor is served by the licensing client a Low-integrity step started',
  { skip: !enabled && 'Set AVH_LOCAL_UNITY_EDITOR on Windows to run real Unity integration', timeout: 1_800_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-unity-shared-client-')); t.after(() => cleanup(root));
    const home = join(root, 'avh-home'); mkdirSync(home, { recursive: true });
    const unity = unityConfig(), mediumMarker = join(root, 'medium.txt');
    const lowMarker = join(root, 'run-low', 'low.txt');
    const lowProject = makeProject(root, 'low'), mediumProject = makeProject(root, 'medium');
    // Build the Medium project's Library once, alone. A real editor a person has open has one; and a *cold* Medium
    // editor's first script compilation is refused (`error CS2012 ... Access to the path ... is denied`) whenever a
    // Low-integrity step is running, for a reason this lane measured but did not identify (see the U1 lane report).
    // Warming it keeps this test about the licensing client, which is what it is for, instead of about that.
    // It stays at Medium integrity for the same reason: a Low warm-up would leave the same Low-written artifacts a
    // Medium editor then refuses. It does hold the machine-level slot, like every other editor this suite starts.
    const warmSlot = waitUnityBatchSlot(unityMachineBatchLockPath(), { slots: unityMachineBatchSlots(),
      onWait: ms => { if (ms % 30_000 === 0) console.log(`[unity-slot] Waiting ${ms / 1000}s`); } });
    let warm: ReturnType<typeof spawnSync>;
    try {
      warm = spawnSync(editor!, ['-batchmode', '-quit', '-projectPath', mediumProject, '-logFile', join(root, 'medium-warm.log'),
        '-executeMethod', METHOD], { env: { ...mediumEnvironment(root, 'medium-home'), AVH_U1_OUT: join(root, 'medium-warm.txt'),
          AVH_U1_LABEL: 'warm' }, windowsHide: true, timeout: 900_000 });
    } finally { releaseUnityBatchSlot(warmSlot); }
    assert.equal(warm.status, 0, `the Medium project did not warm up: ${logEvidence(join(root, 'medium-warm.log'))}`);
    // The Low step holds the editor open, so its Low-integrity client is the one this account has while the Medium
    // editor starts. Nothing else may be running a client: that is what the machine-level slot guarantees here.
    const low = withEnvironment({ AVH_HOME: home, AVH_UNITY_SLOTS: '3' }, () =>
      runUnitySteps(unity, [step(lowMarker, 'low', 45_000)], lowProject, join(root, 'run-low')));
    let medium: ReturnType<typeof spawn> | undefined;
    try {
      await waitForFile(`${lowMarker}.ready`, 600_000);
      // A person's own editor is started outside Harness and takes no slot; this test starts one, so it takes the
      // slot the machine contract asks of every real editor here. It stays at Medium integrity on purpose: sharing
      // the Low client with a Medium editor is exactly what this test exists to show.
      const mediumSlot = waitUnityBatchSlot(unityMachineBatchLockPath(), { slots: unityMachineBatchSlots(),
        onWait: ms => { if (ms % 30_000 === 0) console.log(`[unity-slot] Waiting ${ms / 1000}s`); } });
      let code: number | null = null;
      try {
        medium = spawn(editor!, ['-batchmode', '-quit', '-projectPath', mediumProject,
          '-logFile', join(root, 'medium.log'), '-executeMethod', METHOD],
          { env: { ...mediumEnvironment(root, 'medium-home'), AVH_U1_OUT: mediumMarker, AVH_U1_LABEL: 'medium' },
            stdio: 'ignore', windowsHide: true });
        const done = medium;
        code = await new Promise<number | null>(resolve => {
          // The editor is not in a Job this test owns, so a stuck one has to be ended here rather than left behind.
          const limit = setTimeout(() => { try { spawnSync('taskkill', ['/PID', String(done.pid), '/T', '/F'], { windowsHide: true }); } catch { /* exited */ } }, 600_000);
          done.once('close', value => { clearTimeout(limit); resolve(value); });
        });
      } finally { releaseUnityBatchSlot(mediumSlot); }
      const log = join(root, 'medium.log');
      assert.notEqual(code, 199, `the Medium editor was refused the channel: ${logEvidence(log)}`);
      assert.equal(code, 0, `the Medium editor did not finish (exit ${code}): ${logEvidence(log)}`);
      assert.match(marker(`${mediumMarker}.done`), /integrity=medium/, 'the second editor must really be a Medium-integrity editor');
    } finally {
      await low.catch(() => undefined);
    }
    const evidence = await low;
    assert.equal(evidence[0]?.exitCode, 0, `the Low-integrity step did not finish: ${failure(evidence)}`);
    assert.match(marker(`${lowMarker}.done`), /integrity=low/);
  });
