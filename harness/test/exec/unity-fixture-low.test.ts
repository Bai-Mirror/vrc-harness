import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { UnityConfig } from '../../src/config.ts';
import { unityMachineBatchLockPath } from '../../src/exec/unity-batch-lock.ts';
import type { UnityEvidence } from '../../src/exec/unity-steps.ts';
import { runUnitySteps } from '../../src/exec/unity-steps.ts';
import { execUnityEditor, FIXTURE_RUN_DIRECTORY } from '../fixtures/unity-slot.ts';
import { removeTemp, windows } from '../fixtures/platform.ts';

/**
 * The development fixtures used to start their editors with `execFileSync`, at Medium integrity. Two things follow, and
 * lane U1 measured both:
 *
 *  - an editor started at Medium makes this account's Unity licensing client a Medium one, and a Medium client refuses
 *    Harness's Low-integrity editors on its channel (`Connection Refused; code: 0x8000000a`, then Unity's own 60s
 *    timeout and exit code 199), so a fixture sharing the machine with an in-flight Run could abort that Run's step;
 *  - nothing in the suite then proved that a fixture editor runs confined at all.
 *
 * `test/fixtures/unity-slot.ts` now sends every Windows fixture editor through `WindowsUnityLauncher` — the same slot,
 * Low-integrity helper, private profile with the seeded Hub licence, and Low labels a product step gets. This test is
 * the real call path (`execUnityEditor` → the launcher → the helper → a real editor) beside a real product step: it
 * fails on the behaviour, not on a mocked value. Removing the fixture's confinement (starting the editor directly, as
 * before) makes the fixture's own probe report `integrity=medium`, which is the assertion this test exists for.
 */
const probeSource = fileURLToPath(new URL('../fixtures/unity/U1ParallelProbe.cs', import.meta.url));
const editor = process.env.AVH_LOCAL_UNITY_EDITOR;
const enabled = windows && !!editor;
const METHOD = 'AVH.Harness.U1ParallelProbe.Run';
/** Long enough that a cold fixture editor is still starting while the step's editor holds the account's client. */
const STEP_HOLD_MS = 120_000;
const FIXTURE_HOLD_MS = 30_000;

function cleanup(root: string): void {
  if (process.env.U2_KEEP) { console.log(`[u2] kept ${root}`); return; }
  removeTemp(root);
}

/** A minimal project whose only editor script is the probe; the editor compiles it on its first start. The source
 *  carries the project's name so no two projects here are byte-identical, which a real pair of projects never is. */
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

async function waitForFile(path: string, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`${what} never reported ${path}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/** When one editor was really running, from the editor's own clock: `<out>.ready` carries `start`, `<out>.done` `end`. */
function interval(out: string): { start: number; end: number } {
  const at = (file: string, key: string): number => {
    const found = new RegExp(`${key}=(\\d+)`).exec(readFileSync(file, 'utf8'));
    if (!found) throw new Error(`${file} carries no ${key}=`);
    return Number(found[1]);
  };
  return { start: at(`${out}.ready`, 'start'), end: at(`${out}.done`, 'end') };
}

function reported(out: string): string {
  return existsSync(`${out}.done`) ? readFileSync(`${out}.done`, 'utf8') : `no ${out}.done`;
}

function failure(evidence: UnityEvidence[]): string {
  const step = evidence[0];
  return `${JSON.stringify(step)}; ${step?.errors?.slice(-4).join(' | ') ?? 'no evidence'}`;
}

test('a fixture editor runs at Low integrity through the Runtime launcher, beside a Low-integrity product step',
  { skip: !enabled && 'Set AVH_LOCAL_UNITY_EDITOR on Windows to run real Unity integration', timeout: 1_800_000 },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-unity-fixture-low-')); t.after(() => cleanup(root));
    const home = join(root, 'avh-home'); mkdirSync(home, { recursive: true });
    // Three slots, as the parallel-step test uses: the step takes one and the fixture takes another, and a lane still
    // running an older single-slot build on this machine can hold the base file without making either queue.
    const priorHome = process.env.AVH_HOME, priorSlots = process.env.AVH_UNITY_SLOTS;
    process.env.AVH_HOME = home; process.env.AVH_UNITY_SLOTS = '3';
    t.after(() => {
      if (priorHome === undefined) delete process.env.AVH_HOME; else process.env.AVH_HOME = priorHome;
      if (priorSlots === undefined) delete process.env.AVH_UNITY_SLOTS; else process.env.AVH_UNITY_SLOTS = priorSlots;
    });
    const unity = unityConfig();
    const fixtureProject = makeProject(root, 'fixture'), stepProject = makeProject(root, 'step');
    // The markers live where each editor may write: the step's inside the Run directory, the fixture's inside its own
    // project (both are Low-labelled by the launcher; a path outside them is refused by Windows itself).
    const runDir = join(root, 'run-step'); mkdirSync(runDir, { recursive: true });
    const stepOut = join(runDir, 'step.txt'), fixtureOut = join(fixtureProject, 'fixture.txt');
    const started = runUnitySteps(unity, [{ method: METHOD, quit: true, timeoutSec: 600,
      env: { AVH_U1_OUT: stepOut, AVH_U1_LABEL: 'step', AVH_U1_HOLD_MS: String(STEP_HOLD_MS) } }], stepProject, runDir);
    let fixtureError: unknown;
    // Another editor on this account holding the Medium-integrity licensing client aborts the step with exit code 199,
    // and `runUnitySteps` then waits that client out and retries. If it does give up, the step ends without ever
    // writing `.ready`: fail on its evidence then, instead of sitting out the whole `waitForFile` budget first.
    await Promise.race([
      waitForFile(`${stepOut}.ready`, 600_000, 'the Low-integrity product step'),
      started.then(evidence => { throw new Error(`the Low-integrity product step ended before its editor was up: ${failure(evidence)}`); }),
    ]);
    // The step's editor is up and holding the account's Low-integrity licensing client. Starting the fixture editor
    // now is the situation the old fixture could not survive: it brought up a Medium client first.
    try {
      execUnityEditor(editor!, ['-batchmode', '-nographics', '-projectPath', fixtureProject, '-executeMethod', METHOD,
        '-logFile', join(fixtureProject, 'fixture.log')],
        { timeout: 900_000, windowsHide: true, stdio: 'pipe',
          env: { ...process.env, AVH_U1_OUT: fixtureOut, AVH_U1_LABEL: 'fixture', AVH_U1_HOLD_MS: String(FIXTURE_HOLD_MS) } });
    } catch (error) { fixtureError = error; }
    const evidence = await started;
    assert.equal(fixtureError, undefined,
      `the fixture editor did not finish: ${fixtureError ? String(fixtureError).slice(0, 1200) : ''}; ${reported(fixtureOut)}; ${failure(evidence)}`);
    // The assertion the fix earns, and the one its absence breaks: a fixture editor started the old way reports
    // integrity=medium here.
    assert.match(reported(fixtureOut), /integrity=low/, 'the fixture editor must run under the Low-integrity boundary');
    // Two pieces of the launcher's own evidence, independent of the probe: it records the alias it bound the project
    // to, and the editor ran inside the fixture's own profile rather than the person's (the licence was seeded there).
    const fixtureRun = join(fixtureProject, FIXTURE_RUN_DIRECTORY);
    assert.ok(existsSync(join(fixtureRun, 'unity-project-alias.json')),
      'the fixture editor must have started through the Runtime launcher, which records the alias it bound');
    assert.ok(existsSync(join(fixtureRun, 'unity-home', 'AppData', 'Local', 'Unity')),
      'the fixture editor must run on the launcher-built profile inside its own run directory');
    assert.equal(evidence[0]?.exitCode, 0, `the product step did not finish: ${failure(evidence)}`);
    assert.equal(evidence[0]?.isolation, 'lowil', 'the product step must run under the Low-integrity boundary');
    assert.match(reported(stepOut), /integrity=low/, 'the product step must have run its own code, at Low integrity');
    const step = interval(stepOut), fixture = interval(fixtureOut);
    assert.ok(step.start < fixture.end && fixture.start < step.end,
      `the fixture editor and the product step did not run at the same time: ${JSON.stringify({ step, fixture })}`);
  });
