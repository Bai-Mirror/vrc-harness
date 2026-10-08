import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { RunSpec } from '../../src/runtime/interfaces.ts';
import { DEFAULT_CANCEL_TIMEOUT_MS, UNIT_STOP_TIMEOUT_SEC, UnitExecutor, unitProcessCount, type UnitExecutorConfig } from '../../src/exec/executor.ts';
import { bwrapArgs, bwrapWritablePaths, codexSandboxArgs, probeBwrap, writablePaths } from '../../src/exec/sandbox.ts';
import { ManagedProvider, providerCommand } from '../../src/providers/adapter.ts';
import { HandoffLock, LEGACY_HANDOFF_MAX_AGE_MS } from '../../src/exec/handoff.ts';
import { changeEvidence, changedOutside, committedOutside, gitHead, outsideStatus } from '../../src/exec/git-scan.ts';
import { fakeCommand, deadPid, removeTemp, windows } from '../fixtures/platform.ts';
import { commandFor } from '../../src/host-platform.ts';
import { windowsHelper } from '../../src/exec/windows-helper.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'avh-exec-'));
  t.after(() => removeTemp(dir));
  const repo = join(dir, 'workspace');
  const project = join(repo, 'project');
  const runs = join(dir, 'runs');
  mkdirSync(project, { recursive: true }); mkdirSync(runs);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'outside.txt'), 'baseline');
  writeFileSync(join(project, 'inside.txt'), 'baseline');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'baseline']);
  const lock = join(dir, 'handoff.lock');
  const config: UnitExecutorConfig = { projectDirectory: project, workspaceRepository: repo,
    runRoot: runs, writableByRunner: { shell: [] }, handoffLockPath: lock,
    commandFor: () => ({ argv: ['sh', '-c', 'true'], runner: 'shell' }) };
  const spec: RunSpec = { runId: `it-${crypto.randomUUID()}`, taskId: 't', workflowId: 'w',
    projectId: 'p', stageId: 's', attempt: 1, idempotencyKey: 'key', expectedOutputs: [] };
  return { dir, repo, project, runs, lock, config, spec };
}

test('git scan records only changes outside project, including a second edit to a dirty file', t => {
  const x = fixture(t);
  const before = outsideStatus(x.repo, x.project);
  writeFileSync(join(x.project, 'inside.txt'), 'new');
  assert.deepEqual(changedOutside(before, outsideStatus(x.repo, x.project)), []);
  writeFileSync(join(x.repo, 'outside.txt'), 'first');
  const first = outsideStatus(x.repo, x.project);
  assert.deepEqual(changedOutside(before, first), ['outside.txt']);
  writeFileSync(join(x.repo, 'outside.txt'), 'second');
  assert.deepEqual(changedOutside(first, outsideStatus(x.repo, x.project)), ['outside.txt']);
  execFileSync('git', ['-C', x.repo, 'mv', 'outside.txt', 'project/moved.txt']);
  assert.deepEqual(changedOutside(before, outsideStatus(x.repo, x.project)), ['outside.txt']);
});

test('30k untracked entries scan by metadata; changed paths hash within limit', t => {
  const x = fixture(t);
  const bulk = join(x.repo, 'bulk'); mkdirSync(bulk);
  for (let i = 0; i < 30_000; i++) writeFileSync(join(bulk, `f-${i}.txt`), 'x');
  const huge = join(x.repo, 'huge.bin'); writeFileSync(huge, '');
  truncateSync(huge, 2 ** 31 + 1);
  const started = performance.now();
  const before = outsideStatus(x.repo, x.project);
  writeFileSync(join(bulk, 'f-1.txt'), 'changed');
  writeFileSync(join(bulk, 'new.txt'), 'new');
  const after = outsideStatus(x.repo, x.project);
  const elapsed = performance.now() - started;
  assert.equal(Object.keys(before).length, 30_001);
  assert.deepEqual(changedOutside(before, after), ['bulk/f-1.txt', 'bulk/new.txt']);
  const evidence = changeEvidence(x.repo, before, after);
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every(item => item.sha256));
  assert.equal(changeEvidence(x.repo, before, after, { hashBytes: 2 })[0]?.hashStatus,
    '未哈希（超过上限）');
  truncateSync(huge, 2 ** 31 + 2);
  const hugeChange = changeEvidence(x.repo, after, outsideStatus(x.repo, x.project));
  assert.equal(hugeChange[0]?.path, 'huge.bin');
  assert.equal(hugeChange[0]?.hashStatus, '未哈希（超过上限）');
  assert.throws(() => outsideStatus(x.repo, x.project, { gitOutputBytes: 1024 }),
    /Git scan output exceeded configured limit/);
  t.diagnostic(`scan_30000_baseline_compare_ms=${elapsed.toFixed(1)}`);
});

test('git scan detects committed paths outside the project and allows a project commit', t => {
  const x = fixture(t); const before = gitHead(x.repo);
  writeFileSync(join(x.project, 'inside.txt'), 'new');
  execFileSync('git', ['-C', x.repo, 'add', 'project/inside.txt']);
  execFileSync('git', ['-C', x.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'inside']);
  assert.deepEqual(committedOutside(x.repo, x.project, before, gitHead(x.repo)), []);
  writeFileSync(join(x.repo, 'outside.txt'), 'new');
  execFileSync('git', ['-C', x.repo, 'add', 'outside.txt']);
  execFileSync('git', ['-C', x.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'outside']);
  assert.deepEqual(committedOutside(x.repo, x.project, before, gitHead(x.repo)), ['outside.txt']);
});

test('git scan handles an unborn temporary repository', t => {
  const dir = mkdtempSync(join(tmpdir(), 'avh-unborn-'));
  t.after(() => removeTemp(dir));
  const project = join(dir, 'project'); mkdirSync(project);
  execFileSync('git', ['init', '-q', dir]);
  const before = gitHead(dir);
  writeFileSync(join(project, 'first.txt'), 'first');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'first']);
  assert.deepEqual(committedOutside(dir, project, before, gitHead(dir)), []);
});
test('UnitExecutor marks scan preparation error as no-side-effects before command marker', async t => {
  const x = fixture(t);
  writeFileSync(join(x.repo, 'untracked.txt'), 'x');
  const executor = new UnitExecutor({ ...x.config, scanLimits: { gitOutputBytes: 1 } });
  await assert.rejects(executor.start(x.spec), error => {
    const typed = error as Error & { errorClass?: string; noSideEffects?: boolean };
    assert.equal(typed.errorClass, 'tool_failure');
    assert.equal(typed.noSideEffects, true);
    assert.match(typed.message, /configured limit/);
    return true;
  });
  assert.equal(existsSync(join(x.runs, x.spec.runId, 'command.json')), false);
});

test('Unity handoff preserves another holder and removes only the owning Run', t => {
  const x = fixture(t); const handoff = new HandoffLock(x.lock);
  writeFileSync(x.lock, JSON.stringify({ kind: 'unity', holder: 'dsh', pid: process.pid, since: 'now' }));
  assert.equal(handoff.available(), false);
  assert.throws(() => handoff.acquire('a'), /held by dsh/);
  handoff.release('a'); assert.equal(existsSync(x.lock), true);
  rmSync(x.lock); handoff.acquire('a');
  const stored = JSON.parse(readFileSync(x.lock, 'utf8')) as { holder: string; runId: string; pid: number };
  assert.deepEqual([stored.holder, stored.runId, stored.pid], ['harness', 'a', process.pid]);
  handoff.release('b'); assert.equal(existsSync(x.lock), true);
  handoff.release('a'); assert.equal(existsSync(x.lock), false);
});

test('a Unity handoff lock left by a process that exited is reclaimed; a live holder is never displaced', t => {
  const x = fixture(t);
  const dead = deadPid();
  const stale = JSON.stringify({ kind: 'unity', holder: 'dsh', pid: dead, since: '2020-01-01T00:00:00.000Z' });
  const reclaimed: string[] = [];
  const handoff = new HandoffLock(x.lock, reclaim => reclaimed.push(`${reclaim.holder}/${reclaim.pid}/${reclaim.reason}`));

  // The crashed holder: the lock is stale, taking it says whose lock it was, and the holder is replaced.
  writeFileSync(x.lock, stale);
  assert.equal(handoff.available(), true, 'a pid that no longer exists is not a holder');
  handoff.acquire('run-a');
  assert.deepEqual(reclaimed, [`dsh/${dead}/holder-exited`], 'the reclaim names the holder it displaced');
  const stored = JSON.parse(readFileSync(x.lock, 'utf8')) as { holder: string; runId: string; pid: number };
  assert.deepEqual([stored.holder, stored.runId, stored.pid], ['harness', 'run-a', process.pid]);
  handoff.release('run-a');

  // The live holder: exactly the old behaviour, and the file is not rewritten or removed.
  const live = JSON.stringify({ kind: 'unity', holder: 'dsh', pid: process.pid, since: 'now' });
  writeFileSync(x.lock, live);
  assert.equal(handoff.available(), false, 'a holder that is still running keeps the lock');
  assert.throws(() => handoff.acquire('run-a'), /held by dsh/);
  assert.equal(readFileSync(x.lock, 'utf8'), live, 'the live holder\'s lock is left byte for byte');

  // The executor's dispatch gate is the path the Run loop asks; a crash must not stop it for good.
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.join(' ')); });
  writeFileSync(x.lock, stale);
  const executor = new UnitExecutor(x.config);
  assert.equal(executor.canDispatch('slot:unity_batch'), true, 'a dead holder does not block dispatch');
  assert.equal(existsSync(x.lock), false, 'the gate takes the stale lock out of the way');
  assert.ok(logged.some(line => line.includes('已回收崩溃残留的 Unity 交接锁') && line.includes(`pid ${dead}`)),
    'the reclaim is observable without a database');
  writeFileSync(x.lock, live);
  assert.equal(executor.canDispatch('slot:unity_batch'), false, 'a live holder still blocks dispatch');
  assert.equal(readFileSync(x.lock, 'utf8'), live);
});

test('a legacy handoff lock that names no pid blocks until it is older than the retention window', t => {
  const x = fixture(t);
  const legacy = JSON.stringify({ kind: 'unity', holder: 'dsh', since: '2020-01-01T00:00:00.000Z' });
  const handoff = new HandoffLock(x.lock, () => {});
  writeFileSync(x.lock, legacy);
  assert.equal(handoff.available(), false, 'a pid-less lock is conservative: a fresh one still holds');
  const old = (Date.now() - LEGACY_HANDOFF_MAX_AGE_MS - 60_000) / 1000;
  utimesSync(x.lock, old, old);
  assert.equal(handoff.available(), true, 'past the retention window the file age has to decide');
  assert.equal(handoff.reclaimStale()?.reason, 'legacy-age');
  assert.equal(existsSync(x.lock), false);
});

test('doctor reports the actual bwrap capability for a runner', t => {
  const x = fixture(t); const doctor = new UnitExecutor(x.config).doctor();
  assert.equal(typeof doctor.shell?.available, 'boolean');
  if (!doctor.shell?.available) assert.ok(doctor.shell?.reason);
  t.diagnostic(`shell bwrap: ${JSON.stringify(doctor.shell)}`);
});

test('Codex state directories stay outside model writable roots and network flag follows the run profile', t => {
  const x = fixture(t);
  const state = join(x.dir, 'state'); mkdirSync(state);
  const managed = new ManagedProvider({ id: 'codex', adapter: 'codex-cli', executable: 'codex',
    roles: ['executor'], writable: [x.project], stateDirs: [state], network: true }, x.config);
  assert.deepEqual(managed.executor.config.writableByRunner.codex, [x.project]);
  assert.equal(managed.executor.config.networkByRunner?.codex, true);
  const paths = writablePaths(x.project, x.runs, []);
  assert.deepEqual(paths, [x.runs, x.project]);
  const enabled = codexSandboxArgs(x.runs, paths, ['true'], undefined, true);
  const disabled = codexSandboxArgs(x.runs, paths, ['true'], undefined, false);
  assert.ok(enabled.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(!disabled.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(enabled.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([x.project])}`));
  const command = providerCommand(managed.config, { ...x.spec, prompt: 'test', role: 'executor' }, x.project, x.runs);
  assert.equal(command.argv.includes(state), false);
});

test('task writable roots use a project subdirectory and omit project root', t => {
  const x = fixture(t); const scope = join(x.project, 'Assets'); mkdirSync(scope);
  assert.deepEqual(writablePaths(x.project, x.runs, [], [scope]), [x.runs, scope]);
  assert.deepEqual(writablePaths(x.project, x.runs, [], []), [x.runs]);
});

test('bwrap binds a writable file itself while Codex retains directory roots', t => {
  const x = fixture(t);
  writeFileSync(x.lock, '');
  const bwrap = bwrapWritablePaths(x.project, x.runs, [], [x.lock]);
  const codex = writablePaths(x.project, x.runs, [], [x.lock]);
  assert.deepEqual(bwrap, [x.runs, x.lock]);
  assert.deepEqual(codex, [x.runs, x.dir]);
  const args = bwrapArgs(bwrap, ['true']);
  assert.ok(args.includes(x.lock));
  assert.ok(!args.includes(x.dir));
  assert.deepEqual(args.slice(args.indexOf(x.lock) - 1, args.indexOf(x.lock) + 2),
    ['--bind', x.lock, x.lock]);
});

test('Claude bwrap state guards follow writable roots and only credential file is writable', t => {
  const x = fixture(t), state = join(x.dir, '.claude'), guard = join(x.runs, 'guard');
  const credential = join(state, '.credentials.json'), config = join(state, '.config.json');
  const args = bwrapArgs([x.runs, x.project], ['true'], {
    directory: state, guardDirectory: guard, writableFiles: [credential], readonlyFiles: [config],
  });
  const tmpfs = args.indexOf('--tmpfs');
  assert.ok(tmpfs > args.indexOf(x.project));
  assert.deepEqual(args.slice(tmpfs, tmpfs + 2), ['--tmpfs', state]);
  assert.deepEqual(args.slice(args.indexOf(credential) - 1, args.indexOf(credential) + 2),
    ['--bind', credential, credential]);
  assert.deepEqual(args.slice(args.indexOf(config) - 1, args.indexOf(config) + 2),
    ['--ro-bind', config, config]);
  assert.ok(args.includes(join(state, 'projects')));
  assert.ok(args.includes(join(state, 'settings.json')));
  assert.ok(args.includes(join(state, 'CLAUDE.md')));
});

test('bwrap negative probe uses Harness home when tmpdir and project parent are writable', { skip: windows && 'bwrap is Linux only' }, t => {
  const x = fixture(t);
  const home = mkdtempSync(join(tmpdir(), 'avh-probe-home-'));
  t.after(() => removeTemp(home));
  const bin = join(x.dir, 'bin'); mkdirSync(bin);
  const fake = join(bin, 'bwrap');
  writeFileSync(fake, '#!/bin/sh\nfor arg do target="$arg"; done\ncase "$target" in\n  */.avh-positive-*) printf probe > "$target";;\n  *) exit 1;;\nesac\n');
  chmodSync(fake, 0o700);
  const priorPath = process.env.PATH, priorTmp = process.env.TMPDIR;
  process.env.PATH = `${bin}:${priorPath ?? ''}`;
  process.env.TMPDIR = x.dir;
  t.after(() => {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmp;
  });
  const status = probeBwrap(x.project, x.runs, [x.dir], [], home);
  assert.deepEqual(status, { available: true });
  assert.equal(existsSync(join(home, 'probe')), true);
  assert.equal(statSync(join(home, 'probe')).mode & 0o777, 0o700);
  const unavailable = probeBwrap(x.project, x.runs, [x.dir, home], [], home);
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason ?? '', /candidates:.*whitelist:/);
});

test('unit wrapper passes the same network and writable profile to Codex sandbox', { skip: windows && 'the Codex outer sandbox is not used on Windows' }, t => {
  const x = fixture(t);
  const fake = join(x.dir, 'fake-codex');
  writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "$AVH_CAPTURE"\npwd > "$AVH_CAPTURE.cwd"\n'); chmodSync(fake, 0o700);
  const wrapper = fileURLToPath(new URL('../../src/exec/unit-wrapper.mjs', import.meta.url));
  for (const network of [true, false]) {
    const directory = join(x.runs, String(network)); mkdirSync(directory);
    const capture = join(directory, 'args.txt');
    const marker = join(directory, 'command.json');
    writeFileSync(marker, JSON.stringify({ runDirectory: directory, sandbox: 'codex', sandboxExecutable: fake,
      writable: [directory, x.project], network, argv: ['true'], cwd: directory, env: { AVH_CAPTURE: capture } }));
    const result = spawnSync(process.execPath, [wrapper, marker], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(capture, 'utf8').trim().split('\n');
    assert.equal(readFileSync(`${capture}.cwd`, 'utf8').trim(), directory);
    assert.equal(args.includes('sandbox_workspace_write.network_access=true'), network);
    assert.ok(args.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([directory, x.project])}`));
  }
});

test('self sandbox runs CLI directly and collect still scans outside writes; outer keeps wrapper', t => {
  const x = fixture(t);
  const fake = fakeCommand(join(x.dir, 'fake-cli'), "require('node:fs').writeFileSync(process.env.AVH_CAPTURE, process.argv.slice(2).map(arg => `${arg}\\n`).join(''));");
  const wrapper = fileURLToPath(new URL('../../src/exec/unit-wrapper.mjs', import.meta.url));
  const self = new UnitExecutor({ ...x.config, sandboxByRunner: { shell: 'self' } });
  assert.equal(self.doctor().shell?.kind, 'self');
  const directory = join(x.runs, x.spec.runId); mkdirSync(directory);
  const capture = join(directory, 'args.txt');
  // Windows starts every command through the helper, and what an npm-style shim runs rather than the shim.
  writeFileSync(join(directory, 'command.json'), JSON.stringify({ runDirectory: directory, sandbox: 'self',
    argv: [...commandFor(fake), 'direct'], cwd: x.project, env: { AVH_CAPTURE: capture },
    ...(windows ? { helperExecutable: windowsHelper() } : {}) }));
  const direct = spawnSync(process.execPath, [wrapper, join(directory, 'command.json')], { encoding: 'utf8' });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(readFileSync(capture, 'utf8'), 'direct\n');
  writeFileSync(join(directory, 'outside-before.json'), JSON.stringify(outsideStatus(x.repo, x.project)));
  writeFileSync(join(directory, 'head-before.txt'), gitHead(x.repo));
  writeFileSync(join(x.repo, 'escaped.txt'), 'outside');
  const result = self.collect({ ref: `avh-run-${x.spec.runId}` });
  assert.deepEqual(result.outOfBoundsPaths, []);
  assert.equal(result.externalChanges?.[0]?.path, 'escaped.txt');
  mkdirSync(join(x.dir, '.claude'));
  const outer = new ManagedProvider({ id: 'claude', adapter: 'claude-cli', executable: fake,
    roles: ['executor'], sandbox: 'outer', stateDirs: [join(x.dir, '.claude')] }, x.config);
  assert.equal(outer.executor.config.sandboxByRunner?.claude, 'outer');
});

test('self and probed outer sandboxes record outside commits as external; scan mode retains violations', t => {
  for (const sandbox of ['self', 'bwrap', 'scan'] as const) {
    const x = fixture(t), directory = join(x.runs, x.spec.runId);
    mkdirSync(directory);
    writeFileSync(join(directory, 'outside-before.json'), JSON.stringify(outsideStatus(x.repo, x.project)));
    writeFileSync(join(directory, 'head-before.txt'), gitHead(x.repo));
    writeFileSync(join(directory, 'exit.json'), JSON.stringify({ exitStatus: 0, outputs: {} }));
    writeFileSync(join(directory, 'command.json'), JSON.stringify({ sandbox, requireStableHead: true }));
    writeFileSync(join(x.repo, 'outside.txt'), 'changed');
    execFileSync('git', ['-C', x.repo, 'add', 'outside.txt']);
    execFileSync('git', ['-C', x.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '-qm', 'outside edit']);
    const result = new UnitExecutor(x.config).collect({ ref: `avh-run-${x.spec.runId}` });
    assert.deepEqual(result.outOfBoundsPaths, sandbox === 'scan' ? ['outside.txt', '<workspace HEAD moved>'] : []);
    assert.deepEqual(result.externalChanges?.map(item => item.path), ['outside.txt', '<workspace HEAD moved>']);
    assert.equal(result.externalChanges?.[0]?.before, 'not in git status');
    assert.equal(result.externalChanges?.[0]?.after, 'not in git status');
    assert.notEqual(result.externalChanges?.[1]?.before, result.externalChanges?.[1]?.after);
  }
});

test('committing an unchanged untracked outside file is status evidence, not a file write', t => {
  const x = fixture(t), directory = join(x.runs, x.spec.runId);
  mkdirSync(directory);
  const file = join(x.repo, 'untracked.txt');
  writeFileSync(file, 'unchanged');
  const before = outsideStatus(x.repo, x.project);
  writeFileSync(join(directory, 'outside-before.json'), JSON.stringify(before));
  writeFileSync(join(directory, 'head-before.txt'), gitHead(x.repo));
  writeFileSync(join(directory, 'exit.json'), JSON.stringify({ exitStatus: 0, outputs: {} }));
  writeFileSync(join(directory, 'command.json'), JSON.stringify({ sandbox: 'self', requireStableHead: true }));
  execFileSync('git', ['-C', x.repo, 'add', 'untracked.txt']);
  execFileSync('git', ['-C', x.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'adopt existing']);
  const after = outsideStatus(x.repo, x.project);
  assert.ok(before['untracked.txt']?.startsWith('??:'));
  assert.equal(after['untracked.txt'], undefined);
  const result = new UnitExecutor(x.config).collect({ ref: `avh-run-${x.spec.runId}` });
  assert.deepEqual(result.outOfBoundsPaths, []);
  assert.deepEqual(result.externalChanges?.map(item => item.path), ['untracked.txt', '<workspace HEAD moved>']);
  assert.ok(result.externalChanges?.[0]?.before?.startsWith('??:'));
  assert.equal(result.externalChanges?.[0]?.after, 'not in git status');
});

test('scan mode treats staging an unchanged outside file as status evidence only', t => {
  const x = fixture(t), directory = join(x.runs, x.spec.runId);
  mkdirSync(directory);
  writeFileSync(join(x.repo, 'untracked.txt'), 'unchanged');
  writeFileSync(join(directory, 'outside-before.json'), JSON.stringify(outsideStatus(x.repo, x.project)));
  writeFileSync(join(directory, 'head-before.txt'), gitHead(x.repo));
  writeFileSync(join(directory, 'exit.json'), JSON.stringify({ exitStatus: 0, outputs: {} }));
  writeFileSync(join(directory, 'command.json'), JSON.stringify({ sandbox: 'scan', requireStableHead: true }));
  execFileSync('git', ['-C', x.repo, 'add', 'untracked.txt']);
  const result = new UnitExecutor(x.config).collect({ ref: `avh-run-${x.spec.runId}` });
  assert.deepEqual(result.outOfBoundsPaths, []);
  assert.equal(result.externalChanges?.[0]?.path, 'untracked.txt');
  assert.ok(result.externalChanges?.[0]?.before?.startsWith('??:'));
  assert.ok(result.externalChanges?.[0]?.after?.startsWith('A :'));
});

test('default cancellation wait exceeds systemd stop timeout', () => {
  assert.ok(DEFAULT_CANCEL_TIMEOUT_MS > UNIT_STOP_TIMEOUT_SEC * 1000);
});

test('configured cancellation wait must exceed systemd stop timeout', t => {
  const x = fixture(t);
  assert.throws(() => new UnitExecutor({ ...x.config, cancelTimeoutMs: UNIT_STOP_TIMEOUT_SEC * 1000 }),
    /cancelTimeoutMs must exceed TimeoutStopSec/);
});

const it = process.env.AVH_SYSTEMD_IT === '1' ? test : test.skip;
async function untilExited(executor: UnitExecutor, ref: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (executor.observe({ ref }).state === 'exited') return;
    await delay(100);
  }
  throw new Error(`Run ${ref} did not exit`);
}

it('systemd: cancellation empties the whole cgroup and releases handoff', async t => {
  const x = fixture(t);
  x.config.commandFor = () => ({ argv: ['sh', '-c', 'sleep 60 & sleep 60'], runner: 'shell', needsUnity: true });
  const executor = new UnitExecutor(x.config);
  const handle = await executor.start(x.spec);
  assert.equal(executor.observe(handle).state, 'running');
  let runningCount = 0;
  for (let i = 0; i < 50; i++) {
    runningCount = unitProcessCount(handle.ref) ?? 0;
    if (runningCount >= 3) break; // wrapper, shell, and its two sleep descendants
    await delay(50);
  }
  assert.ok(runningCount >= 3, `expected descendants before cancellation, found ${runningCount}`);
  assert.equal((JSON.parse(readFileSync(x.lock, 'utf8')) as { holder: string }).holder, 'harness');
  assert.equal(await executor.cancel(handle), 'confirmed');
  assert.equal(unitProcessCount(handle.ref), 0);
  assert.equal(existsSync(x.lock), false);
  t.diagnostic(`before_cancel_processes=${runningCount} cancel=confirmed cgroup_processes=${unitProcessCount(handle.ref)} handoff_removed=true`);
});

it('systemd: repeated start uses one unit and collected exit code survives GC', async t => {
  const x = fixture(t);
  x.config.commandFor = () => ({ argv: ['sh', '-c',
    'printf x >> "$1"; printf out; printf err >&2; exit 37', 'sh', join(x.project, 'starts.txt')], runner: 'shell' });
  const executor = new UnitExecutor(x.config);
  const first = await executor.start(x.spec);
  const second = await executor.start(x.spec);
  assert.equal(first.ref, second.ref);
  await untilExited(executor, first.ref);
  assert.equal(executor.collect(first).exitStatus, 37);
  assert.equal(readFileSync(join(x.project, 'starts.txt'), 'utf8'), 'x');
  assert.equal(readFileSync(join(x.runs, x.spec.runId, 'stdout.log'), 'utf8'), 'out');
  assert.equal(readFileSync(join(x.runs, x.spec.runId, 'stderr.log'), 'utf8'), 'err');
  let recycled = false;
  for (let i = 0; i < 50; i++) {
    const result = spawnSync('busctl', ['--user', 'call', 'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'GetUnit', 's',
      `${first.ref}.service`], { encoding: 'utf8' });
    if (result.status !== 0 && result.stderr.includes('not loaded')) { recycled = true; break; }
    await delay(50);
  }
  assert.equal(recycled, true);
  assert.equal(executor.collect(first).exitStatus, 37);
  t.diagnostic(`start_twice_one_invocation=true unit_recycled=${recycled} collect_exit=37 stdout=out stderr=err`);
});

it('systemd: bwrap write boundary, or explicit fallback scan when unavailable', async t => {
  const x = fixture(t);
  const target = join(x.repo, 'outside-created.txt');
  x.config.commandFor = () => ({ argv: ['sh', '-c',
    'printf inside > "$1"; printf outside > "$2"', 'sh', join(x.project, 'created.txt'), target], runner: 'shell' });
  const executor = new UnitExecutor(x.config);
  const status = executor.doctor().shell!;
  const handle = await executor.start(x.spec);
  await untilExited(executor, handle.ref);
  const result = executor.collect(handle);
  assert.equal(readFileSync(join(x.project, 'created.txt'), 'utf8'), 'inside');
  if (status.available) {
    assert.equal(existsSync(target), false);
    assert.equal(result.exitStatus !== 0, true);
  } else {
    assert.equal(existsSync(target), true);
    assert.deepEqual(result.outOfBoundsPaths, ['outside-created.txt']);
  }
  t.diagnostic(`bwrap=${status.available} reason=${status.reason ?? 'none'} project_write=true outside_write=${existsSync(target)} scan=${JSON.stringify(result.outOfBoundsPaths)}`);
});

test('a Claude executor finds ~/.claude at dispatch even when it appeared after the configuration was read', { skip: windows && 'Linux masks ~/.claude; a Windows Claude Run has its own configuration directory' }, t => {
  const x = fixture(t);
  const prior = process.env.HOME; process.env.HOME = join(x.dir, 'home'); mkdirSync(process.env.HOME);
  t.after(() => { if (prior === undefined) delete process.env.HOME; else process.env.HOME = prior; });
  const provider = { id: 'claude', adapter: 'claude-cli' as const, executable: '/bin/true', roles: ['research' as const],
    sandbox: 'outer' as const, stateDirs: [] };
  assert.throws(() => new ManagedProvider(provider, x.config), /Claude state directory is required/);
  mkdirSync(join(process.env.HOME, '.claude'));
  assert.doesNotThrow(() => new ManagedProvider(provider, x.config));
});
