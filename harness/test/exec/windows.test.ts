import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { RunSpec } from '../../src/runtime/interfaces.ts';
import { UnitExecutor, type UnitExecutorConfig } from '../../src/exec/executor.ts';
import { WindowsRunSupervisor, parseMemory, windowsRunEnvironment } from '../../src/exec/windows-supervisor.ts';
import { assertLabelable, harnessPrivatePaths, protectHarnessHome } from '../../src/exec/windows-boundary.ts';
import { checkJobName, labelOf, labelWithLedger, listProcesses, openLedgers, queryJob, releaseLedgers, releaseStaleLedgers, windowsHelper, windowsHelperCandidates } from '../../src/exec/windows-helper.ts';
import { EXCLUSIVE_OPEN, WindowsUnityLauncher, defaultWindowsHomeSeeds, projectPathArgument, settleWindowsUnityEditors,
  unityOccupancyGuidance, unityOccupancyNote, windowsUnityOccupancy, type WindowsUnityProbes } from '../../src/exec/windows-unity.ts';
import { commandFor, hostArgv, npmShimCommand, processAlive } from '../../src/host-platform.ts';
import { windowsLoginName } from '../../src/service/manager.ts';
import { clearSecret, writeSecret } from '../../src/providers/secrets.ts';
import { ManagedProvider } from '../../src/providers/adapter.ts';
import { gitBashPath } from '../../src/providers/claude.ts';
import { fakeCommand, inheritedModify, pathPattern, removeTemp, windows } from '../fixtures/platform.ts';
import { waitFor } from '../fixtures/wait.ts';

/**
 * The Windows backends against the real Windows mechanisms: Job Objects through the helper, the restricted Low integrity
 * token, integrity labels. They run on Windows whenever the helper is built (npm run native:build); the Linux backends
 * have their own tests (AVH_SYSTEMD_IT).
 */
const helper = (() => { if (!windows) return false; try { windowsHelper(); return true; } catch { return false; } })();
const win = helper ? test : test.skip;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'avh-win-'));
  t.after(() => { releaseLedgers(home, dir); removeTemp(dir); });
  const repo = join(dir, 'workspace'), project = join(repo, 'project'), runs = join(dir, 'runs'), home = join(dir, 'home');
  for (const path of [project, runs, join(home, 'config'), join(home, 'state'), join(home, 'run')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, 'config', 'harness.yaml'), 'secret: booth-session\n');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'outside.txt'), 'baseline'); writeFileSync(join(project, 'inside.txt'), 'baseline');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline']);
  const lock = join(dir, 'handoff.lock');
  const config: UnitExecutorConfig = { projectDirectory: project, workspaceRepository: repo, runRoot: runs, harnessHome: home,
    writableByRunner: { node: [] }, handoffLockPath: lock,
    commandFor: () => ({ argv: [process.execPath, '-e', ''], runner: 'node' }) };
  const spec = (): RunSpec => ({ runId: `it-${crypto.randomUUID()}`, taskId: 't', workflowId: 'w', projectId: 'p',
    stageId: 's', attempt: 1, idempotencyKey: 'key', expectedOutputs: [], allowedWrites: [project] });
  return { dir, repo, project, runs, home, lock, config, spec };
}
async function untilExited(executor: UnitExecutor, ref: string): Promise<void> {
  await waitFor(() => executor.observe({ ref }).state,
    { what: `Run ${ref} to exit`, ready: state => state === 'exited', timeoutMs: 120_000, intervalMs: 100 });
}
const node = (script: string, ...args: string[]) => [process.execPath, '-e', script, ...args];

win('a real Run in an inherited Modify project reports label remediation before starting its command', async t => {
  const x = fixture(t), restore = inheritedModify(t, x.project);
  try {
  const output = join(x.project, 'started.txt');
  x.config.commandFor = () => ({ runner: 'node', argv: node("require('node:fs').writeFileSync(process.argv[1], 'started')", output) });
  await assert.rejects(new UnitExecutor(x.config).start(x.spec()), /无法设置完整性标签[\s\S]*修改[\s\S]*完全控制/);
  assert.equal(existsSync(output), false);
  } finally { restore(); }
});

/**
 * The alias containers a failed launch keeps by design, filtered to the ones whose own `owner.json` names `project`, so
 * a cleanup that never reached `alias.remove()` leaves nothing behind and no other launch's entry is ever touched.
 */
function removeAliasesFor(project: string): void {
  const profile = homedir(), physical = realpathSync(project);
  for (const name of readdirSync(profile)) {
    if (!name.startsWith('.avh-u-')) continue;
    const container = join(profile, name);
    try {
      const owner = JSON.parse(readFileSync(join(container, 'owner.json'), 'utf8')) as { project?: string };
      if (owner.project !== physical) continue;
      rmdirSync(join(container, 'p'));
      unlinkSync(join(container, 'owner.json'));
      rmdirSync(container);
    } catch { /* not this project's alias, or already removed */ }
  }
}

win('a launch that cannot write the Low label falls back to an unisolated run and records the real reason', async t => {
  const x = fixture(t);
  const runDir = join(x.runs, `label-fallback-${crypto.randomUUID()}`);
  mkdirSync(runDir, { recursive: true });
  // The state W5c measured: both roots are writable (inherited Modify) but without the WRITE_OWNER a mandatory label
  // needs, so setting one and clearing one both fail with "拒绝访问 (os error 5)". No label is half applied, and the
  // cleanup in the failure path fails the same way — which is what used to make this fallback unreachable.
  const restoreProject = inheritedModify(t, x.project), restoreRun = inheritedModify(t, runDir);
  const restore = (): void => { restoreProject(); restoreRun(); };
  const priorHome = process.env.AVH_HOME;
  process.env.AVH_HOME = x.home;
  try {
    const editor = join(x.dir, 'Unity.exe'), marker = join(x.dir, 'editor-ran.txt'), script = join(x.dir, 'editor.mjs');
    copyFileSync(process.execPath, editor);
    writeFileSync(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    // The memory and process readings are injected so the fallback, not this computer's load, decides the outcome.
    const launcher = new WindowsUnityLauncher({ runner: editor, editor, lockPath: join(x.dir, 'unity.lock'), busyExitCode: 5,
      homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 60, passEnv: [] },
      { list: () => [], alive: () => false, freeMemory: () => 8 * 1024 ** 3 });
    // The real product entry point, not prepare(): argv, profile, the label attempt, the fallback, the launch and the
    // cleanup all run, and the step's own evidence files are what the assertions read.
    const plan = launcher.planArgs([editor, script, '-projectPath', x.project], x.project, runDir);
    const result = launcher.launchSync(plan, 120_000);
    assert.equal(result.code, 0, `the stand-in editor runs unisolated: ${result.stderr}`);
    assert.equal(existsSync(marker), true, 'the step really started after the label failed');
    assert.equal(launcher.lastIsolation?.kind, 'none', 'the launch is recorded as unisolated');
    const isolation = readFileSync(join(runDir, 'unity-isolation.txt'), 'utf8');
    assert.match(isolation, /未隔离/);
    assert.match(isolation, pathPattern(x.project), 'the reason names the directory that could not be labelled');
    assert.match(isolation, /labelWithLedger/, 'and the call that failed');
    assert.match(isolation, /SetNamedSecurityInfo|拒绝访问|os error 5/, 'and the system error itself');
    // The second failure in the failure path is recorded, not thrown: that is the defect this test is the counterexample
    // for — restoring the plain `releaseLedgers` call makes this test fail before it reads this line.
    assert.match(isolation, /撤销本次标签/);
    assert.match(launcher.lastIsolation?.note ?? '', /撤销本次标签/);
    assert.equal(labelOf(x.project), '', 'nothing was labelled');
  } finally {
    // §4.1: put the ACLs back and clear whatever the failed cleanup left, whatever the assertions did.
    restore();
    try { releaseLedgers(x.home, x.dir); } catch { /* the ledger stays for the service's stale-ledger pass */ }
    removeAliasesFor(x.project);
    if (priorHome === undefined) delete process.env.AVH_HOME; else process.env.AVH_HOME = priorHome;
  }
});

win('a sandboxed Run gets its credential in its environment, cannot read the stored key, and never starts without it', async t => {
  const x = fixture(t);
  writeSecret(x.home, 'pi-test', 'sk-sandboxed-XYZ');
  // The command reports a digest of the variable and whether it could read the key file itself.
  x.config.commandFor = () => ({ runner: 'node', secretEnv: { AVH_TEST_KEY: 'pi-test' }, argv: node(`const fs = require('node:fs');
const digest = require('node:crypto').createHash('sha256').update(process.env.AVH_TEST_KEY ?? '').digest('hex');
let file; try { fs.readFileSync(process.argv[1]); file = 'read'; } catch (error) { file = error.code; }
console.log(digest + ' ' + file);`, join(x.home, 'config', 'secrets', 'pi-test')) });
  const executor = new UnitExecutor(x.config);
  const handle = await executor.start(x.spec());
  await untilExited(executor, handle.ref);
  const runDirectory = join(x.runs, executor.runIdOf(handle));
  const stdout = readFileSync(join(runDirectory, 'stdout.log'), 'utf8');
  executor.collect(handle);
  assert.equal(stdout.trim(), `${createHash('sha256').update('sk-sandboxed-XYZ').digest('hex')} EPERM`);
  assert.doesNotMatch(readFileSync(join(runDirectory, 'command.json'), 'utf8'), /sk-sandboxed-XYZ/);
  x.config.commandFor = () => ({ runner: 'node', secretEnv: { AVH_TEST_KEY: 'absent' }, argv: node('') });
  const refused = x.spec();
  await assert.rejects(new UnitExecutor(x.config).start(refused), /缺少凭据 absent/);
  assert.equal(existsSync(join(x.runs, refused.runId, 'command.json')), false, 'nothing was recorded or started');
});

win('a Claude Run gets its saved token, its own configuration directory and no inherited Claude variable, and cannot write ~/.claude', async t => {
  const x = fixture(t);
  const token = 'sk-ant-oat01-HARNESS-TEST-TOKEN-XYZ';
  writeSecret(x.home, 'claude-oauth-token', token);
  // A stand-in for the person's profile, where the Run resolves ~ (USERPROFILE is passed to every Windows Run).
  const profile = join(x.dir, 'profile');
  mkdirSync(join(profile, '.claude'), { recursive: true });
  writeFileSync(join(profile, '.claude', '.credentials.json'), '{"person":"login"}');
  writeFileSync(join(profile, '.claude.json'), '{"person":"config"}');
  // What a Runtime started from inside a Claude Code session would inherit, and a token that is not the saved one.
  const leaks = { USERPROFILE: profile, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'sk-ant-api03-LEAK',
    CLAUDE_CONFIG_DIR: join(profile, '.claude'), CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-LEAK', CLAUDE_CODE_SESSION_ID: 'leak' };
  const prior = Object.fromEntries(Object.keys(leaks).map(name => [name, process.env[name]]));
  Object.assign(process.env, leaks);
  t.after(() => { for (const [name, value] of Object.entries(prior)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  // The fake Claude runs at Low integrity like the real one: it reports what it received and tries the person's files.
  const claude = fakeCommand(join(x.dir, 'claude'), `const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const attempt = action => { try { action(); return 'ok'; } catch (error) { return error.code; } };
const config = process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync('report.json', JSON.stringify({ prompt: fs.readFileSync(0, 'utf8'), argv: process.argv.slice(2),
  token: require('node:crypto').createHash('sha256').update(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').digest('hex'),
  variables: Object.keys(process.env).filter(name => /^(ANTHROPIC|CLAUDE)/i.test(name)).sort(), config, home: process.env.HOME,
  ownConfig: attempt(() => fs.writeFileSync(path.join(config, '.claude.json'), '{}')),
  ownHome: attempt(() => fs.writeFileSync(path.join(process.env.HOME, '.bash_history'), '')),
  personalDirectory: attempt(() => fs.writeFileSync(path.join(os.homedir(), '.claude', 'planted'), 'x')),
  personalCredentials: attempt(() => fs.writeFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), '{}')),
  personalConfig: attempt(() => fs.writeFileSync(path.join(os.homedir(), '.claude.json'), '{}')) }));
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 'fake' }));`);
  const provider = new ManagedProvider({ id: 'claude', adapter: 'claude-cli', executable: claude, roles: ['research'] },
    { projectDirectory: x.project, workspaceRepository: x.repo, runRoot: x.runs, harnessHome: x.home });
  const spec = x.spec();
  const prompt = `Summarise the project.\n${'长提示'.repeat(12_000)}`; // longer than a Windows command line can carry
  const handle = await provider.start({ ...spec, role: 'research', allowedWrites: [], prompt });
  await untilExited(provider.executor, handle.ref);
  const run = join(x.runs, spec.runId);
  const report = JSON.parse(readFileSync(join(run, 'report.json'), 'utf8')) as Record<string, any>;
  const result = provider.collect(handle);
  assert.equal(result.exitStatus, 0, readFileSync(join(run, 'stderr.log'), 'utf8'));
  assert.equal(report.token, createHash('sha256').update(token).digest('hex'), 'the saved token, not an inherited one');
  const bash = gitBashPath();
  assert.deepEqual(report.variables, [...(bash ? ['CLAUDE_CODE_GIT_BASH_PATH'] : []), 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'].sort(),
    'only the variables Harness sets on purpose');
  assert.equal(report.config, join(run, 'claude-config'));
  assert.equal(report.home, join(run, 'home'));
  assert.equal(report.prompt, prompt, 'the prompt arrives on stdin');
  assert.deepEqual([report.ownConfig, report.ownHome], ['ok', 'ok'], 'the Run\'s own configuration and HOME are writable');
  assert.deepEqual([report.personalDirectory, report.personalCredentials, report.personalConfig], ['EPERM', 'EPERM', 'EPERM']);
  assert.equal(existsSync(join(profile, '.claude', 'planted')), false);
  assert.equal(readFileSync(join(profile, '.claude', '.credentials.json'), 'utf8'), '{"person":"login"}');
  assert.equal(readFileSync(join(profile, '.claude.json'), 'utf8'), '{"person":"config"}');
  // The value is in no record of the Run: command.json, provider-request.json, the logs or anything else there.
  const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  for (const file of files(run)) assert.doesNotMatch(readFileSync(file, 'latin1'), /HARNESS-TEST-TOKEN/, file);
  assert.match(readFileSync(join(run, 'command.json'), 'utf8'), /"secretEnv":\{"CLAUDE_CODE_OAUTH_TOKEN":"claude-oauth-token"\}/);
  assert.ok(files(run).some(file => file.endsWith('provider-request.json')));
  // Without a saved credential the Run is refused before anything is recorded or started.
  clearSecret(x.home, 'claude-oauth-token');
  const refused = x.spec();
  await assert.rejects(provider.start({ ...refused, role: 'research', allowedWrites: [], prompt: 'x' }), /缺少凭据 claude-oauth-token/);
  assert.equal(existsSync(join(x.runs, refused.runId, 'command.json')), false);
});

win('a Run writes its project at Low integrity, is refused everywhere else, and its labels go when it is collected', async t => {
  const x = fixture(t);
  const secret = join(x.home, 'config', 'harness.yaml');
  x.config.commandFor = () => ({ runner: 'node', argv: node(`const fs = require('node:fs');
const attempt = (label, action) => { try { action(); console.log(label + '=ok'); } catch (error) { console.log(label + '=' + error.code); } };
attempt('project', () => fs.writeFileSync(process.argv[1], 'inside'));
attempt('outside', () => fs.writeFileSync(process.argv[2], 'outside'));
attempt('git', () => fs.writeFileSync(process.argv[3], 'x'));
attempt('secret', () => fs.readFileSync(process.argv[4]));`, join(x.project, 'created.txt'), join(x.repo, 'escaped.txt'),
  join(x.repo, '.git', 'planted'), secret) });
  const executor = new UnitExecutor(x.config);
  assert.equal(executor.doctor().node?.kind, 'lowil');
  const handle = await executor.start(x.spec());
  await untilExited(executor, handle.ref);
  const stdout = readFileSync(join(x.runs, executor.runIdOf(handle), 'stdout.log'), 'utf8');
  const result = executor.collect(handle);
  assert.match(stdout, /project=ok/);
  assert.match(stdout, /outside=EPERM/);
  assert.match(stdout, /git=EPERM/, 'the repository metadata stays read-only');
  assert.match(stdout, /secret=EPERM/, 'the Runtime configuration is unreadable');
  assert.equal(existsSync(join(x.repo, 'escaped.txt')), false);
  assert.deepEqual(result.outOfBoundsPaths, []);
  const command = JSON.parse(readFileSync(join(x.runs, executor.runIdOf(handle), 'command.json'), 'utf8')) as { sandbox: string };
  assert.equal(command.sandbox, 'lowil');
  assert.equal(labelOf(x.project), '', 'collect removed the Low label again');
  assert.deepEqual(openLedgers(x.home), []);
});

win('cancellation stops the whole job, detached children included, and releases the Unity handoff', async t => {
  const x = fixture(t);
  x.config.commandFor = () => ({ runner: 'node', needsUnity: true, argv: node(
    "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' }).unref(); setTimeout(() => {}, 60000);") });
  const executor = new UnitExecutor(x.config);
  const handle = await executor.start(x.spec());
  assert.equal(executor.observe(handle).state, 'running');
  assert.equal((JSON.parse(readFileSync(x.lock, 'utf8')) as { holder: string }).holder, 'harness');
  const active = await waitFor(() => {
    const query = JSON.parse(execFileSync(windowsHelper(), ['query', '--name', handle.ref], { encoding: 'utf8' })) as { active?: number };
    return query.active ?? 0;
  }, { what: `the wrapper, the helper's command and its detached child to be in the job`, ready: count => count >= 3, timeoutMs: 30_000, intervalMs: 50 });
  assert.ok(active >= 3, `the wrapper, the helper's command and its detached child are in the job (${active})`);
  assert.equal(await executor.cancel(handle), 'confirmed');
  // An empty job is already stopped; its name disappears after the supervisor releases the last kernel handle.
  await waitFor(() => queryJob(handle.ref), { what: `the supervisor of ${handle.ref} to stop once its job emptied`, ready: job => job !== 'empty', timeoutMs: 30_000, intervalMs: 50 });
  assert.equal(queryJob(handle.ref), 'not_found');
  assert.equal(existsSync(x.lock), false);
  const exit = JSON.parse(readFileSync(join(x.runs, executor.runIdOf(handle), 'exit.json'), 'utf8')) as { exit: { cancelled: boolean } };
  assert.equal(exit.exit.cancelled, true);
  assert.equal(executor.observe(handle).state, 'exited');
});

win('a repeated start runs the command once, and its exit code outlives the job', async t => {
  const x = fixture(t);
  x.config.commandFor = () => ({ runner: 'node', argv: node(
    "require('node:fs').appendFileSync(process.argv[1], 'x'); process.stdout.write('out'); process.stderr.write('err'); process.exit(37);",
    join(x.project, 'starts.txt')) });
  const executor = new UnitExecutor(x.config), spec = x.spec();
  const first = await executor.start(spec);
  const second = await executor.start(spec);
  assert.equal(first.ref, second.ref);
  await untilExited(executor, first.ref);
  await waitFor(() => queryJob(first.ref), { what: `the supervisor of ${first.ref} to leave once its job emptied`, ready: job => job === 'not_found', timeoutMs: 30_000, intervalMs: 50 });
  assert.equal(queryJob(first.ref), 'not_found', 'the supervisor left once the job emptied');
  assert.equal(executor.collect(first).exitStatus, 37);
  assert.equal(readFileSync(join(x.project, 'starts.txt'), 'utf8'), 'x');
  assert.equal(readFileSync(join(x.runs, spec.runId, 'stdout.log'), 'utf8'), 'out');
  assert.equal(readFileSync(join(x.runs, spec.runId, 'stderr.log'), 'utf8'), 'err');
});

win('the supervisor enforces the runtime limit and records it as a timeout', async t => {
  const x = fixture(t);
  const supervisor = new WindowsRunSupervisor(x.runs);
  const runId = `it-${crypto.randomUUID()}`, directory = join(x.runs, runId); mkdirSync(directory);
  const ref = await supervisor.launch(runId, node('setTimeout(() => {}, 60000)'), {}, directory, { runtimeMaxSec: 1 });
  await waitFor(() => supervisor.state(ref), { what: `the supervisor of ${runId} to record the runtime-limit exit`, ready: state => state === 'exited', timeoutMs: 30_000, intervalMs: 100 });
  assert.equal(supervisor.state(ref), 'exited');
  assert.deepEqual(supervisor.recordedExit(runId), { code: 124, timedOut: true, cancelled: false });
});

win('a Run can neither edit the label ledger nor read the Runtime state; release clears only what the ledger lists', t => {
  const x = fixture(t);
  const run = join(x.runs, 'r'); mkdirSync(run);
  protectHarnessHome(x.home);
  labelWithLedger(x.home, run, [run, x.project]);
  const ledger = readdirSync(join(x.home, 'state', 'labels')).map(name => join(x.home, 'state', 'labels', name))[0]!;
  const probe = spawnSync(windowsHelper(), ['sandbox', '--low', '--', ...node(`const fs = require('node:fs');
for (const [label, action] of [['ledger-write', () => fs.writeFileSync(process.argv[1], '{"owner":"x","low":[],"medium":["C:\\\\\\\\"]}')],
  ['ledger-read', () => fs.readFileSync(process.argv[1])], ['state-list', () => fs.readdirSync(process.argv[2])]])
  { try { action(); console.log(label + '=ok'); } catch (error) { console.log(label + '=' + error.code); } }`, ledger, join(x.home, 'state'))],
  { encoding: 'utf8' });
  assert.match(probe.stdout, /ledger-write=EPERM/);
  assert.match(probe.stdout, /ledger-read=EPERM/);
  assert.match(probe.stdout, /state-list=EPERM/);
  assert.match(labelOf(x.project), /\(ML;OICI;NW;;;LW\)/);
  releaseLedgers(x.home, run);
  assert.equal(labelOf(x.project), '');
  assert.equal(existsSync(ledger), false);
  assert.match(labelOf(join(x.home, 'config')), /\(ML;OICI;(NRNW|NWNR);;;ME\)/, 'the Runtime\'s own labels stay');
});

win('no Low label is ever put on a drive, the user profile or anything above AVH_HOME', t => {
  const x = fixture(t);
  assert.throws(() => assertLabelable('C:\\', x.home), /盘符/);
  assert.throws(() => assertLabelable(process.env.USERPROFILE!, x.home), /包含/);
  assert.throws(() => assertLabelable(x.dir, x.home), /包含/);
  assert.throws(() => assertLabelable(join(process.env.SystemRoot!, 'Temp'), x.home), /在 /);
  assert.doesNotThrow(() => assertLabelable(x.project, x.home));
  assert.doesNotThrow(() => assertLabelable(join(x.home, 'runs', 'r'), x.home));
});

win('labels left by work that ended are cleared, never those of live work or of paths live work shares', t => {
  const dir = mkdtempSync(join(tmpdir(), 'avh-win-stale-')), home = join(dir, 'home'), runs = join(dir, 'runs');
  t.after(() => { releaseLedgers(home, dir); removeTemp(dir); });
  const paths = Object.fromEntries(['ended', 'running', 'fresh', 'shared', 'check'].map(name => [name, join(dir, 'work', name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const owner = (runId: string) => resolve(runs, runId), check = join(owner('run-checked'), 'checks', 'scene_items');
  labelWithLedger(home, owner('run-ended'), [paths.ended!]);
  labelWithLedger(home, owner('run-running'), [paths.running!, paths.shared!]);
  labelWithLedger(home, owner('run-ended-shared'), [paths.shared!]);
  labelWithLedger(home, check, [paths.check!]);
  labelWithLedger(home, owner('run-fresh'), [paths.fresh!]);
  // Every ledger but the fresh one was written before the grace period.
  const ledgers = join(home, 'state', 'labels'), old = new Date(Date.now() - 60 * 60_000);
  for (const name of readdirSync(ledgers)) {
    const file = join(ledgers, name);
    if (!(JSON.parse(readFileSync(file, 'utf8')) as { owner: string }).owner.endsWith('run-fresh')) utimesSync(file, old, old);
  }
  const running = new Set(['avh-run-run-running', checkJobName(owner('run-checked'), 'scene_items')]);
  const jobs = (name: string) => running.has(name) ? 'running' as const : 'not_found' as const;
  assert.deepEqual(releaseStaleLedgers(home, 10 * 60_000, jobs).sort(), [owner('run-ended'), owner('run-ended-shared')].sort());
  assert.equal(labelOf(paths.ended!), '', 'work that ended loses its labels');
  assert.match(labelOf(paths.running!), /LW/, 'a running Run keeps its labels');
  assert.match(labelOf(paths.shared!), /LW/, 'a path that live work also labelled keeps its label');
  assert.match(labelOf(paths.check!), /LW/, 'a check\'s scratch belongs to the check\'s job');
  assert.match(labelOf(paths.fresh!), /LW/, 'a ledger inside the grace period is left alone');
  assert.deepEqual(openLedgers(home).map(ledger => basename(ledger.owner)).sort(), ['run-fresh', 'run-running', 'scene_items']);
  assert.deepEqual(releaseStaleLedgers(home, 10 * 60_000, () => undefined), [], 'a job that cannot be read counts as live');
});

test('a Windows Run inherits the session\'s Windows variables, never its secrets, and Python speaks UTF-8', () => {
  const env = windowsRunEnvironment({ PATH: 'C:\\bin' }, { SystemRoot: 'C:\\Windows', Path: 'C:\\old', USERPROFILE: 'C:\\Users\\u',
    AVH_GUI_SESSION_TOKEN: 'token', AVH_GUI_NATIVE_TOKEN: 'token', OPENAI_API_KEY: 'sk', HTTPS_PROXY: 'http://proxy:8080' });
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
  for (const secret of ['AVH_GUI_SESSION_TOKEN', 'AVH_GUI_NATIVE_TOKEN', 'OPENAI_API_KEY']) assert.equal(env[secret], undefined, secret);
  // A Runtime started from inside a Claude Code session carries its endpoints and tokens; the person's own
  // CLAUDE_CONFIG_DIR names their login. A Run inherits none of them: Harness sets what a Claude Run needs itself.
  const claude = windowsRunEnvironment({ PATH: 'C:\\bin' }, { SystemRoot: 'C:\\Windows', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    ANTHROPIC_API_KEY: 'sk-ant', Claude_Config_Dir: 'C:\\Users\\u\\.claude', CLAUDECODE: '1', CLAUDE_CODE_OAUTH_TOKEN: 'token',
    CLAUDE_CODE_MESSAGING_TOKEN: 'token', CLAUDE_CODE_SESSION_ID: 'id' });
  assert.deepEqual(Object.keys(claude).filter(name => /^(ANTHROPIC|CLAUDE)/i.test(name)), []);
  assert.equal(claude.SystemRoot, 'C:\\Windows');
  assert.deepEqual(Object.keys(env).filter(name => name.toLowerCase() === 'path'), ['PATH'], 'one PATH, whatever its spelling');
  assert.ok(env.PATH!.startsWith('C:\\bin'));
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(parseMemory('4G'), 4 * 1024 ** 3);
  assert.equal(parseMemory('512M'), 512 * 1024 ** 2);
});

test('a Windows Run carries an explicitly managed Unity slot count without widening inherited AVH variables', () => {
  const env = windowsRunEnvironment({ PATH: 'C:\\bin', AVH_UNITY_SLOTS: '3' }, {
    SystemRoot: 'C:\\Windows', AVH_UNITY_SLOTS: '1', AVH_GUI_SESSION_TOKEN: 'token', OPENAI_API_KEY: 'sk',
  });
  assert.equal(env.AVH_UNITY_SLOTS, '3');
  assert.equal(env.AVH_GUI_SESSION_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('npm command shims are read for the program they start', { skip: !windows && 'Windows paths and shims' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'avh-shim-')); t.after(() => removeTemp(dir));
  writeFileSync(join(dir, 'codex.cmd'), ['@ECHO off', 'SETLOCAL', 'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*', ''].join('\r\n'));
  writeFileSync(join(dir, 'claude.cmd'), ['@ECHO off', '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*', ''].join('\r\n'));
  writeFileSync(join(dir, 'odd.cmd'), '@ECHO off\r\necho no program here\r\n');
  assert.deepEqual(npmShimCommand(join(dir, 'codex.cmd'), 'node.exe'), ['node.exe', join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]);
  writeFileSync(join(dir, 'node.exe'), '');
  assert.deepEqual(npmShimCommand(join(dir, 'codex.cmd'), 'node.exe')?.[0], join(dir, 'node.exe'), 'a node beside the shim wins');
  assert.deepEqual(npmShimCommand(join(dir, 'claude.cmd')), [join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]);
  assert.equal(npmShimCommand(join(dir, 'odd.cmd')), undefined);
  assert.deepEqual(commandFor(join(dir, 'claude.cmd')), [join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]);
});

test('other platforms run a frozen tool command as it is', () => {
  assert.deepEqual(hostArgv(['python3', 'x.py'], false), ['python3', 'x.py']);
});

test('a Unity command line names its project the way Windows splits arguments', () => {
  assert.equal(projectPathArgument('"C:\\Program Files\\Unity\\Editor\\Unity.exe" -batchmode -projectPath "D:\\My Projects\\Avatar" -quit'),
    'D:\\My Projects\\Avatar');
  assert.equal(projectPathArgument('Unity.exe -projectpath D:\\Avatar -logFile x'), 'D:\\Avatar');
  assert.equal(projectPathArgument('Unity.exe -batchmode'), undefined);
});

win('an open editor holds its project, and one Unity batch runs at a time on this computer', t => {
  const x = fixture(t);
  const launcher = new WindowsUnityLauncher({ runner: 'C:\\Unity.exe', editor: 'C:\\Unity.exe', lockPath: join(x.dir, 'batch.lock'),
    busyExitCode: 5, homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] });
  assert.equal(launcher.busy(x.project), false);
  mkdirSync(join(x.project, 'Temp'));
  const held = openSync(join(x.project, 'Temp', 'UnityLockfile'), constants.O_RDWR | constants.O_CREAT | EXCLUSIVE_OPEN);
  try { assert.equal(launcher.busy(x.project), true, 'the editor\'s lock file is held'); } finally { closeSync(held); }
  assert.equal(launcher.busy(x.project), false, 'a lock file nobody holds is stale');
  const other = new WindowsUnityLauncher({ ...{ runner: 'C:\\Unity.exe', editor: 'C:\\Unity.exe' }, lockPath: join(x.dir, 'batch.lock'),
    busyExitCode: 5, homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] });
  // Exclusion is the property here, so the machine is pinned to one slot: the platform default is a counted set
  // (`defaultUnitySlots`), where the second launcher legitimately takes the *next* slot instead of being refused.
  const previous = process.env.AVH_UNITY_SLOTS;
  process.env.AVH_UNITY_SLOTS = '1';
  try {
    assert.equal(launcher.acquireBatchSlot(), true);
    assert.equal(other.acquireBatchSlot(), false);
    launcher.release();
    assert.equal(other.acquireBatchSlot(), true);
  } finally {
    if (previous === undefined) delete process.env.AVH_UNITY_SLOTS; else process.env.AVH_UNITY_SLOTS = previous;
    launcher.release(); other.release();
  }
});

/** A project whose lock this test holds, and the editor records a step reads it with. */
function occupancyFixture(t: TestContext, holdLock = true) {
  const dir = mkdtempSync(join(tmpdir(), 'avh-occupancy-'));
  t.after(() => removeTemp(dir));
  const project = join(dir, 'project'), runs = join(dir, 'runs');
  mkdirSync(join(project, 'Temp'), { recursive: true }); mkdirSync(runs);
  // This test holds the lock the way an editor does; the probes decide what the process table says about it.
  const held = holdLock
    ? openSync(join(project, 'Temp', 'UnityLockfile'), constants.O_RDWR | constants.O_CREAT | EXCLUSIVE_OPEN) : undefined;
  if (held !== undefined) t.after(() => closeSync(held));
  const editor = (pid: number) => ({ pid, parentPid: 1, name: 'Unity.exe', path: 'C:\\Unity\\Unity.exe',
    commandLine: `"C:\\Unity\\Unity.exe" -projectPath "${project}" -batchmode -quit` });
  const probes = (listed: Array<ReturnType<typeof editor>>, alive: boolean): WindowsUnityProbes =>
    ({ list: () => listed, alive: () => alive, freeMemory: () => 8 * 1024 ** 3 });
  const config = { runner: process.execPath, editor: process.execPath, lockPath: join(dir, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 30, passEnv: [] };
  return { dir, project, runs, editor, probes, config };
}

test('a project a process the kernel has not released still holds is diagnosed as stuck exiting, never as free',
  { skip: !windows && 'Windows project lock and process table' }, async t => {
  const x = occupancyFixture(t), gone = 219536;
  const launcher = new WindowsUnityLauncher(x.config, x.probes([x.editor(gone)], false));
  const occupancy = launcher.occupancy(x.project);
  assert.equal(occupancy.kind, 'exiting');
  assert.deepEqual(occupancy.kind === 'exiting' ? occupancy.occupiers.map(item => item.pid) : [], [gone]);
  assert.equal(launcher.busy(x.project), true, 'the lock is still held, so the project is not free');
  assert.match(unityOccupancyGuidance(occupancy)!, new RegExp(`PID ${gone}`));
  assert.match(unityOccupancyGuidance(occupancy)!, /卡在退出中/);
  assert.match(unityOccupancyGuidance(occupancy)!, /重启电脑/);
  assert.match(unityOccupancyNote(occupancy)!, /已退出，但内核仍未回收/);
  // The refusal carries the same reading, and nothing deletes a lock that is still held.
  const plan = launcher.plan({ method: 'Fixture.Run', quit: true, env: {} }, x.project, join(x.runs, 'occupied'));
  const outcome = await launcher.launch(plan, 5_000);
  assert.equal(outcome.code, 4);
  assert.equal(outcome.busy?.kind, 'exiting');
  assert.equal(existsSync(join(x.project, 'Temp', 'UnityLockfile')), true, 'a lock that is still held is never deleted');
});

test('a live editor, an unclaimed lock and an unreadable process table are told apart from that residue',
  { skip: !windows && 'Windows project lock and process table' }, async t => {
  const x = occupancyFixture(t), pid = 4242;
  const live = new WindowsUnityLauncher(x.config, x.probes([x.editor(pid)], true));
  assert.equal(live.occupancy(x.project).kind, 'editor', 'an editor that still runs is not the residue');
  assert.equal(live.busy(x.project), true);
  assert.match(unityOccupancyGuidance(live.occupancy(x.project))!, new RegExp(`PID ${pid}`));
  assert.doesNotMatch(unityOccupancyGuidance(live.occupancy(x.project))!, /重启电脑/,
    'closing a running editor is something the person can do; a restart is not needed for it');
  assert.match(unityOccupancyGuidance(live.occupancy(x.project))!, /关闭/);
  const claimed = new WindowsUnityLauncher(x.config, x.probes([], false));
  assert.equal(claimed.occupancy(x.project).kind, 'locked', 'the lock is held and no Unity process claims it');
  assert.equal(claimed.busy(x.project), true);
  assert.match(unityOccupancyGuidance(claimed.occupancy(x.project))!, /没有 Unity 进程认领/);
  const unreadable = new WindowsUnityLauncher(x.config,
    { list: () => { throw new Error('the process table cannot be read'); }, alive: () => false, freeMemory: () => 8 * 1024 ** 3 });
  assert.equal(unreadable.busy(x.project), true, 'a process table that cannot be read never establishes that a project is free');
  const other = occupancyFixture(t, false);
  const free = new WindowsUnityLauncher(other.config, other.probes([], false));
  assert.equal(free.occupancy(other.project).kind, 'free');
  assert.equal(free.busy(other.project), false);
  assert.equal(unityOccupancyGuidance(free.occupancy(other.project)), undefined);
});

win('cancelling a Run ends the editor its step started inside the nested sandbox job and frees the project lock', async t => {
  const x = fixture(t);
  // A stand-in editor: the image name `busy()` looks for, the `-projectPath` it reads, and the exclusive project lock a
  // real editor takes. It runs inside `avh-win sandbox`, which is the nested job the launcher gives a real editor, so
  // this is the whole tree a cancel has to end — without starting a real editor (no Unity slot, no licensing).
  const editor = join(x.dir, 'Unity.exe');
  copyFileSync(process.execPath, editor);
  const script = join(x.dir, 'editor.mjs'), lockPath = join(x.project, 'Temp', 'UnityLockfile');
  mkdirSync(join(x.project, 'Temp'), { recursive: true });
  writeFileSync(script, `import { constants, openSync } from 'node:fs';
openSync(${JSON.stringify(lockPath)}, constants.O_RDWR | constants.O_CREAT | ${EXCLUSIVE_OPEN});
setInterval(() => {}, 1000);`);
  const helper = windowsHelper();
  x.config.commandFor = () => ({ runner: 'node', argv: [process.execPath, '-e',
    `const { spawn } = require('node:child_process');
spawn(${JSON.stringify(helper)}, ['sandbox', '--', ${JSON.stringify(editor)}, ${JSON.stringify(script)},
  '-projectPath', ${JSON.stringify(x.project)}], { stdio: 'ignore' }).on('close', code => process.exit(code ?? 1));`] });
  const executor = new UnitExecutor(x.config);
  const handle = await executor.start(x.spec());
  let pid: number | undefined;
  try {
    await waitFor(() => windowsUnityOccupancy(x.project), { what: 'the stand-in editor to take the project lock',
      timeoutMs: 120_000, intervalMs: 100, ready: occupancy => occupancy.kind === 'editor' });
    const occupancy = windowsUnityOccupancy(x.project);
    pid = occupancy.kind === 'editor' ? occupancy.occupiers[0]!.pid : undefined;
    assert.ok(pid, 'the real probe reads the stand-in as a live editor of this project');
    const waited = await settleWindowsUnityEditors([x.project], 300);
    assert.equal(waited.settled, false, 'a live editor is waited for, not assumed gone');
    assert.equal(waited.occupancy.kind, 'editor');
    assert.equal(await executor.cancel(handle), 'confirmed');
    await waitFor(() => !processAlive(pid!), { what: 'the editor the step started to stop', timeoutMs: 30_000, intervalMs: 50 });
    await waitFor(() => windowsUnityOccupancy(x.project), { what: 'the project lock the editor held to be free',
      timeoutMs: 30_000, intervalMs: 100, ready: occupancy => occupancy.kind === 'free' });
  } finally {
    // §4.1: a failed assertion must not leave the stand-in, its helper or the job behind.
    await executor.cancel(handle).catch(() => 'not_confirmed');
    if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
});

test('a plan built from a caller\'s own argv keeps the isolated profile and can label extra roots',
  { skip: !windows && 'Windows paths and shims' }, () => {
    // Development fixtures bring their own editor arguments (a probe method, a log path) but must get the Runtime's
    // profile, licence seed and write boundary, so this is the half of planArgs() they rely on: passing the person's
    // real environment cannot restore the real profile, and an extra root (where a fixture keeps its evidence) is
    // labelled with the rest instead of being refused by Windows.
    const launcher = new WindowsUnityLauncher({ runner: 'C:\\U\\Unity.exe', editor: 'C:\\U\\Unity.exe', lockPath: 'C:\\l',
      busyExitCode: 5, homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] });
    const plan = launcher.planArgs(['C:\\U\\Unity.exe', '-projectPath', 'C:\\p', '-executeMethod', 'A.B.C'], 'C:\\p', 'C:\\r',
      { env: { USERPROFILE: 'C:\\Users\\someone', HOME: 'C:\\Users\\someone', LOCALAPPDATA: 'C:\\Users\\someone\\AppData\\Local',
        APPDATA: 'C:\\Users\\someone\\AppData\\Roaming', AVH_PROBE_OUTPUT: 'C:\\evidence\\out.json' }, writable: ['C:\\evidence'] });
    assert.equal(plan.env.USERPROFILE, join('C:\\r', 'unity-home'), 'the real profile cannot be nominated through the environment');
    assert.equal(plan.env.HOME, join('C:\\r', 'unity-home'));
    assert.equal(plan.env.LOCALAPPDATA, join('C:\\r', 'unity-home', 'AppData', 'Local'));
    assert.equal(plan.env.TEMP, join('C:\\r', 'tmp'));
    assert.equal(plan.env.AVH_PROBE_OUTPUT, 'C:\\evidence\\out.json', 'the caller\'s own variables still reach the editor');
    assert.equal(plan.env.AVH_PROJECT_DIR, 'C:\\p');
    assert.deepEqual(plan.writable, ['C:\\p', 'C:\\r', 'C:\\evidence'], 'an extra root is labelled, not dropped');
    assert.deepEqual(plan.isolation?.writableRoots, plan.writable);
  });

test('a Windows Unity step gets its own profile folders and the Hub license as its seed', { skip: !windows && 'Windows paths and shims' }, () => {
  const launcher = new WindowsUnityLauncher({ runner: 'C:\\U\\Unity.exe', editor: 'C:\\U\\Unity.exe', lockPath: 'C:\\l',
    busyExitCode: 5, homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: ['PATH'] });
  const plan = launcher.plan({ method: 'A.B.C', quit: true, env: { AVH_STAGE: 's' } }, 'C:\\p', 'C:\\r', 2, 'C:\\r\\unity-home');
  assert.deepEqual(plan.argv, ['C:\\U\\Unity.exe', '-projectPath', 'C:\\p', '-batchmode', '-quit', '-logFile', join('C:\\r', 'unity-2.log'),
    '-executeMethod', 'A.B.C']);
  assert.equal(plan.env.USERPROFILE, 'C:\\r\\unity-home');
  assert.equal(plan.env.LOCALAPPDATA, join('C:\\r\\unity-home', 'AppData', 'Local'));
  assert.equal(plan.env.TEMP, join('C:\\r', 'tmp'));
  assert.equal(plan.env.AVH_STAGE, 's');
  assert.deepEqual(plan.writable, ['C:\\p', 'C:\\r']);
  assert.deepEqual(defaultWindowsHomeSeeds({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u'), ['AppData/Local/Unity/licenses']);
  assert.deepEqual(defaultWindowsHomeSeeds({ LOCALAPPDATA: 'D:\\Elsewhere' }, 'C:\\Users\\u'), [], 'only what lies in the profile');
});

test('the Runtime\'s private places and its login entry are named per Harness home', { skip: !windows && 'Windows paths and shims' }, () => {
  assert.deepEqual(harnessPrivatePaths('C:\\h', { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' }),
    [join('C:\\h', 'run'), join('C:\\h', 'config'), join('C:\\h', 'state'), join('C:\\L', 'app.avatar-harness.desktop'),
      join('C:\\R', 'app.avatar-harness.desktop')]);
  assert.equal(windowsLoginName('C:\\Users\\u\\AppData\\Local\\avh', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }), 'AvatarHarnessRuntime');
  assert.match(windowsLoginName('D:\\other', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }), /^AvatarHarnessRuntime-[0-9a-f]{8}$/);
});

test('the helper that goes with the running code is found first, unless AVH_WIN_HELPER names one', () => {
  const packaged = join('R', 'dist', 'native', 'avh-win.exe'), built = join('R', 'native', 'windows', 'target', 'release', 'avh-win.exe');
  assert.deepEqual(windowsHelperCandidates({}, 'R', true), [built, packaged], 'from source, a stale dist copy loses');
  assert.deepEqual(windowsHelperCandidates({}, 'R', false), [packaged, built]);
  assert.deepEqual(windowsHelperCandidates({ AVH_WIN_HELPER: 'X' }, 'R', false), ['X', packaged, built]);
});
