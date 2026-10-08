import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { UnityConfig } from '../../src/config.ts';
import { crashedDuringStartup, runUnitySteps, unityBwrapArgs, unityPlan, unityRuntimeArgs, type UnityStep } from '../../src/exec/unity-steps.ts';
import { probeBwrap } from '../../src/exec/sandbox.ts';
import { removeTemp, useHome, windows } from '../fixtures/platform.ts';

test('Unity runtime mount masks session bus and restores only selected sockets', { skip: windows && 'Unix sockets and bwrap mounts are Linux only' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-sockets-'));
  t.after(() => removeTemp(root));
  mkdirSync(join(root, 'pulse'));
  const servers = ['bus', 'pulse/native', 'pipewire-0', 'wayland-0'].map(name => createServer());
  await Promise.all(servers.map((server, i) => new Promise<void>(resolve => server.listen(join(root,
    ['bus', 'pulse/native', 'pipewire-0', 'wayland-0'][i]!), resolve))));
  t.after(() => servers.forEach(server => server.close()));
  const args = unityRuntimeArgs({ XDG_RUNTIME_DIR: root, WAYLAND_DISPLAY: 'wayland-0' });
  assert.deepEqual(args, ['--tmpfs', root, '--dir', join(root, 'pulse'),
    '--ro-bind', join(root, 'pulse/native'), join(root, 'pulse/native'),
    '--ro-bind', join(root, 'pipewire-0'), join(root, 'pipewire-0'),
    '--ro-bind', join(root, 'wayland-0'), join(root, 'wayland-0')]);
  assert.ok(!args.includes(join(root, 'bus')));
  const full = unityBwrapArgs({ argv: ['/bin/true'], env: { XDG_RUNTIME_DIR: root, WAYLAND_DISPLAY: 'wayland-0' },
    writable: [], privateTmp: root, log: join(root, 'log') });
  assert.ok(full.includes('--tmpfs'));
  assert.ok(full.includes(join(root, 'pulse/native')));
  assert.ok(!full.includes(join(root, 'bus')));
});

test('bwrap Unity cannot see the host session bus', { skip: process.env.AVH_SYSTEMD_IT !== '1' }, async t => {
  const f = fixture(t);
  const runtime = join(f.root, 'runtime'); mkdirSync(runtime);
  const bus = createServer();
  await new Promise<void>(resolve => bus.listen(join(runtime, 'bus'), resolve));
  t.after(() => bus.close());
  const runner = f.config.runner;
  writeFileSync(runner, '#!/bin/sh\ntest ! -S "$XDG_RUNTIME_DIR/bus"\n'); chmodSync(runner, 0o700);
  f.config.passEnv = ['XDG_RUNTIME_DIR'];
  const prior = process.env.XDG_RUNTIME_DIR; process.env.XDG_RUNTIME_DIR = runtime;
  t.after(() => { if (prior === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = prior; });
  assert.ok(probeBwrap(f.project, f.runDir, [], [f.project, f.runDir, f.config.lockPath]).available);
  const evidence = await runUnitySteps(f.config, [f.step], f.project, f.runDir);
  assert.equal(evidence[0]?.exitCode, 0);
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-unity-'));
  t.after(() => removeTemp(root));
  const project = join(root, 'project'), runDir = join(root, 'run');
  mkdirSync(project); mkdirSync(runDir);
  const config: UnityConfig = { runner: join(root, 'runner'), lockPath: join(root, 'lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: ['Library', 'Temp'], defaultTimeoutSec: 2, passEnv: ['DISPLAY'] };
  const step: UnityStep = { method: 'Example.Batch.Run', quit: false, env: { EXAMPLE_MODE: 'test' } };
  return { root, project, runDir, config, step };
}

test('Unity argv, isolated environment and project-wide write paths', t => {
  const f = fixture(t), previous = process.env.DISPLAY;
  process.env.DISPLAY = ':77';
  try {
    const plan = unityPlan(f.config, f.step, f.project, f.runDir, 1, join(f.runDir, 'unity-home'));
    assert.deepEqual(plan.argv, [f.config.runner, '--project', f.project, '--batch', '--method',
      f.step.method, '--no-quit', '--no-systemd', '--log', join(f.runDir, 'unity-1.log')]);
    assert.equal(plan.env.HOME, join(f.runDir, 'unity-home'));
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_DIRS'])
      assert.ok(plan.env[name]);
    assert.equal(plan.env.DISPLAY, ':77'); assert.equal(plan.env.AVH_RUN_DIR, f.runDir);
    assert.equal(plan.privateTmp, join(f.runDir, 'tmp'));
    assert.deepEqual(plan.writable, [f.project, f.runDir, f.config.lockPath]);
  } finally { if (previous === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = previous; }
});

test('Unity bwrap binds lock files without granting their parent directories', t => {
  const f = fixture(t);
  const git = join(f.project, '.git');
  mkdirSync(git);
  for (const lock of [f.config.lockPath, join(f.root, 'locks', 'batch.lock')]) {
    mkdirSync(join(lock, '..'), { recursive: true });
    writeFileSync(lock, '');
    f.config.lockPath = lock;
    const plan = unityPlan(f.config, f.step, f.project, f.runDir, 1, join(f.runDir, 'unity-home'));
    const args = unityBwrapArgs(plan);
    const binds = args.flatMap((arg, index) => arg === '--bind' ? [[args[index + 1], args[index + 2]]] : []);
    assert.ok(binds.some(([source, target]) => source === lock && target === lock));
    assert.ok(!binds.some(([source]) => source === join(lock, '..')));
    const readonly = args.indexOf(git);
    assert.ok(readonly > args.indexOf(f.project));
    assert.deepEqual(args.slice(readonly - 1, readonly + 2), ['--ro-bind', git, git]);
  }
});

test('Unity bwrap keeps project writes while protecting Git metadata',
  { skip: process.env.AVH_SYSTEMD_IT !== '1' }, t => {
    const f = fixture(t), git = join(f.project, '.git');
    mkdirSync(join(git, 'hooks'), { recursive: true });
    mkdirSync(join(f.runDir, 'tmp'));
    writeFileSync(f.config.lockPath, '');
    const plan = unityPlan(f.config, f.step, f.project, f.runDir, 1, join(f.runDir, 'unity-home'));
    const argv = ['/bin/sh', '-c', 'printf ok > "$1"; printf forbidden > "$2"', 'sh',
      join(f.project, 'created.txt'), join(git, 'hooks', 'x')];
    const args = unityBwrapArgs({ ...plan, argv });
    const writable = args.indexOf(f.project), readonly = args.indexOf(git);
    assert.ok(readonly > writable);
    assert.deepEqual(args.slice(readonly - 1, readonly + 2), ['--ro-bind', git, git]);
    assert.ok(probeBwrap(f.project, f.runDir, [], plan.writable).available);
    const result = spawnSync('bwrap', args, { encoding: 'utf8', env: plan.env, cwd: f.runDir });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(f.project, 'created.txt'), 'utf8'), 'ok');
    assert.equal(existsSync(join(git, 'hooks', 'x')), false);
  });

test('Unity worker refuses unsandboxed setup writes inside Git metadata', async t => {
  const f = fixture(t), git = join(f.project, '.git');
  mkdirSync(git);
  f.config.projectScratch = ['.git/hooks'];
  await assert.rejects(runUnitySteps(f.config, [f.step], f.project, f.runDir), /inside \.git/);
  assert.equal(existsSync(join(git, 'hooks')), false);
  f.config.projectScratch = [];
  f.config.lockPath = join(git, 'lock');
  await assert.rejects(runUnitySteps(f.config, [f.step], f.project, f.runDir), /inside \.git/);
  assert.equal(existsSync(f.config.lockPath), false);
});

test('Unity seed copies are deleted after success and failure; busy lock waits are recorded', async t => {
  const f = fixture(t), home = join(f.root, 'real-home');
  useHome(t, home);
  const source = join(home, '.config/unity3d/Unity/licenses/license');
  mkdirSync(join(home, '.config/unity3d/Unity/licenses'), { recursive: true });
  writeFileSync(source, 'synthetic-secret');
  f.config.homeSeedFrom = ['.config/unity3d/Unity/licenses'];
  for (const finalCode of [0, 1]) {
    let calls = 0; const waits: number[] = [];
    const result = await runUnitySteps(f.config, [f.step], f.project, f.runDir,
      (_index, wait) => waits.push(wait), async plan => {
        calls++;
        const copied = join(plan.env.HOME!, '.config/unity3d/Unity/licenses/license');
        assert.equal(readFileSync(copied, 'utf8'), 'synthetic-secret');
        writeFileSync(plan.log, `Error at ${copied}: synthetic-secret\n`);
        return { code: calls <= 2 ? 5 : finalCode, timedOut: false };
      }, async () => {});
    assert.equal(calls, 3); assert.deepEqual(waits, [1, 2]);
    assert.equal(result[0]!.index, 1);
    assert.equal(result[0]!.exitCode, finalCode);
    assert.ok(!existsSync(join(f.runDir, 'unity-home/.config/unity3d/Unity/licenses/license')));
    assert.doesNotMatch(JSON.stringify(result) + readFileSync(join(f.runDir, 'unity-1.log'), 'utf8'),
      /synthetic-secret|licenses[\\/]+license/);
  }
});

test('legacy Linux seeds do not suppress the Windows Hub license, and its isolated copy is removed', { skip: !windows }, async t => {
  const f = fixture(t), home = join(f.root, 'home');
  useHome(t, home);
  const prior = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = join(home, 'AppData', 'Local');
  t.after(() => { if (prior === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prior; });
  const relativeLicense = 'AppData/Local/Unity/licenses/UnityEntitlementLicense.xml';
  const source = join(home, relativeLicense);
  mkdirSync(join(home, 'AppData/Local/Unity/licenses'), { recursive: true });
  writeFileSync(source, 'synthetic-native-license');
  f.config.homeSeedFrom = ['.config/unity3d/Unity/licenses'];
  const result = await runUnitySteps(f.config, [f.step], f.project, f.runDir, () => {}, async plan => {
    const copied = join(plan.env.HOME!, relativeLicense);
    assert.equal(readFileSync(copied, 'utf8'), 'synthetic-native-license');
    writeFileSync(plan.log, 'synthetic-native-license');
    return { code: 0, timedOut: false };
  });
  assert.equal(result[0]!.exitCode, 0);
  assert.equal(existsSync(join(f.runDir, 'unity-home', relativeLicense)), false);
  assert.equal(readFileSync(source, 'utf8'), 'synthetic-native-license');
  assert.doesNotMatch(readFileSync(join(f.runDir, 'unity-1.log'), 'utf8'), /synthetic-native-license/);
});

test('a Unity crash while the project is still loading is retried; a crash in the step method is not', async t => {
  const f = fixture(t);
  const startup = 'Caught fatal signal - signo:11\nObtained 3 stack frames.\n#0 in VF.Utils.HarmonyUtils:Patch\n#1 in Application::InitializeProject()\n';
  const inMethod = 'Caught fatal signal - signo:11\n#0 in MonoManager::FinalizeReload()\n#1 in AssetDatabase::Refresh()\n';
  assert.equal(crashedDuringStartup(startup), true);
  assert.equal(crashedDuringStartup('Caught fatal signal\n#13 in Application::FinishLoadingProject()\n'), true);
  assert.equal(crashedDuringStartup(inMethod), false, 'a reload the step triggered may have done part of its work');
  assert.equal(crashedDuringStartup('Exiting batchmode successfully now!\n'), false);
  let calls = 0;
  const evidence = await runUnitySteps(f.config, [f.step], f.project, f.runDir, () => {}, async plan => {
    calls++;
    writeFileSync(plan.log, calls === 1 ? startup : 'batch complete\n');
    return { code: calls === 1 ? 139 : 0, timedOut: false };
  });
  assert.equal(calls, 2);
  assert.equal(evidence[0]!.exitCode, 0);
  assert.equal(evidence[0]!.startupCrashes, 1);
  assert.match(readFileSync(join(f.runDir, 'unity-1.log.startup-crash-1'), 'utf8'), /InitializeProject/);
  calls = 0;
  const failed = await runUnitySteps(f.config, [f.step], f.project, f.runDir, () => {}, async plan => {
    calls++;
    writeFileSync(plan.log, inMethod);
    return { code: 139, timedOut: false };
  });
  assert.equal(calls, 1, 'not retried');
  assert.equal(failed[0]!.exitCode, 139);
});

test('Unity rejects a Provider-created symlink for isolated HOME', async t => {
  const f = fixture(t), outside = join(f.root, 'outside');
  // A junction on Windows: it needs no privilege, and lstat reports it as a link just the same.
  mkdirSync(outside); symlinkSync(outside, join(f.runDir, 'unity-home'), windows ? 'junction' : undefined);
  await assert.rejects(runUnitySteps(f.config, [f.step], f.project, f.runDir), /Private directory/);
  assert.deepEqual(readdirSync(outside), []);
});

test('Unity launch failure identifies the failing step after an earlier success', async t => {
  const f = fixture(t);
  let calls = 0;
  const evidence = await runUnitySteps(f.config, [f.step, { ...f.step, method: 'Example.Batch.Second' }],
    f.project, f.runDir, () => {}, async plan => {
      calls++;
      writeFileSync(plan.log, calls === 1 ? 'batch complete\n' : 'Error: synthetic second step\n');
      if (calls === 2) throw new Error('synthetic launcher error');
      return { code: 0, timedOut: false };
    });
  assert.equal(calls, 2);
  assert.deepEqual(evidence.map(step => [step.index, step.method, step.exitCode]),
    [[1, f.step.method, 0], [2, 'Example.Batch.Second', 1]]);
  assert.match(evidence[1]!.errors.join(' '), /Unity launch failed.*synthetic second step/);
});

/** The recorded abort: Unity never reached the step, and its log blames licensing. */
const LICENCE_ABORT = ["IPC channel to LicensingClient doesn't exist; aborting",
  'Application will terminate with return code 199'].join('\n');
const OTHER_EDITOR = { pid: 4242, name: 'Unity.exe', commandLine: 'Unity.exe -batchmode -projectPath C:\\other\\project', kind: 'editor' as const };

test('a step that aborts on the licensing client waits for the holder to exit, then retries and succeeds', async t => {
  const f = fixture(t);
  f.config.defaultTimeoutSec = 60;
  let calls = 0, listings = 0;
  const holder = { pid: 437364, name: 'Unity.Licensing.Client.exe',
    commandLine: '"Unity.Licensing.Client.exe" "--namedPipe" "Unity-LicenseClient-u"', kind: 'licensing-client' as const };
  // The holder's client is there for the first two listings and gone after the wait.
  const probe = { competitors: () => { listings++; return listings <= 2 ? [OTHER_EDITOR, holder] : [OTHER_EDITOR]; } };
  const evidence = await runUnitySteps(f.config, [f.step], f.project, f.runDir, () => {}, async plan => {
    calls++;
    writeFileSync(plan.log, calls === 1 ? LICENCE_ABORT : 'batch complete\n');
    return { code: calls === 1 ? 199 : 0, timedOut: false };
  }, async () => {}, probe);
  assert.equal(calls, 2, 'the step launched again once the mutex holder was gone');
  assert.ok(listings >= 3, 'and waited for it first');
  assert.equal(evidence[0]!.exitCode, 0);
  assert.equal(evidence[0]!.licence?.retries, 1);
  assert.equal(evidence[0]!.licence?.waitedMs, 10_000, 'one poll for the holder, then the settle');
  assert.equal(evidence[0]!.waits, 0, 'this was not a busy batch slot');
  assert.equal(evidence[0]!.guidance, undefined, 'a step that recovered asks the person for nothing');
});

test('a licensing client that stays is not launched into: it is waited out, then named', async t => {
  const f = fixture(t);
  f.config.defaultTimeoutSec = 60;
  let calls = 0;
  const holder = { pid: 437364, name: 'Unity.Licensing.Client.exe',
    commandLine: '"Unity.Licensing.Client.exe" "--namedPipe" "Unity-LicenseClient-u"', kind: 'licensing-client' as const };
  const evidence = await runUnitySteps(f.config, [f.step], f.project, f.runDir, () => {}, async plan => {
    calls++;
    writeFileSync(plan.log, LICENCE_ABORT);
    return { code: 199, timedOut: false };
  }, async () => {}, { competitors: () => [OTHER_EDITOR, holder] });
  assert.equal(calls, 1, 'a relaunch while the mutex holder runs would only spend another 60s to reach the same abort');
  assert.equal(evidence[0]!.exitCode, 199);
  assert.equal(evidence[0]!.licence?.retries, 0);
  assert.equal(evidence[0]!.licence?.waitedMs, 65_000, 'the bounded wait ran and is reported');
  assert.deepEqual(evidence[0]!.licence?.competitors.map(item => item.pid), [4242, 437364]);
  assert.match(evidence[0]!.errors[0]!, /另一个 Unity 占用本机授权客户端（退出码 199）/);
  assert.match(evidence[0]!.guidance!, /另一个 Unity 正在占用/);
  assert.match(evidence[0]!.guidance!, /PID 4242/);
  assert.match(evidence[0]!.guidance!, /已等待 65 秒，占用者仍在运行/);
  assert.match(evidence[0]!.guidance!, /需要你做的：关闭上面那个 Unity/);
});

test('an exit 199 that the log does not establish as contention is reported as itself and not waited on', async t => {
  const f = fixture(t);
  let calls = 0, listings = 0;
  const evidence = await runUnitySteps(f.config, [f.step], f.project, f.runDir, () => {}, async plan => {
    calls++;
    writeFileSync(plan.log, 'error CS1002: ; expected\nApplication will terminate with return code 199\n');
    return { code: 199, timedOut: false };
  }, async () => {}, { competitors: () => { listings++; return [OTHER_EDITOR]; } });
  assert.equal(calls, 1);
  assert.equal(listings, 0, 'the machine is only inspected once the log establishes this cause');
  assert.equal(evidence[0]!.licence, undefined);
  assert.equal(evidence[0]!.guidance, undefined);
});

test('a project a process the kernel has not released still holds is reported as needing a restart, not as "busy"',
  async t => {
  const f = fixture(t);
  let calls = 0;
  // What the Windows launcher reports when it refuses to start (see windows-unity.ts): the lock is held by an editor the
  // operating system has already ended. The exit code alone cannot say that, so it travels with the refusal.
  const stuck = { pid: 219536, commandLine: 'Unity.exe -projectPath ' + f.project, exited: true };
  const evidence = await runUnitySteps(f.config, [f.step], f.project, f.runDir, () => {}, async () => {
    calls++;
    return { code: 4, timedOut: false, busy: { kind: 'exiting' as const, occupiers: [stuck] } };
  });
  assert.equal(calls, 1, 'an editor the kernel has already ended cannot be waited out; a relaunch would only fail again');
  assert.equal(evidence[0]!.exitCode, 4);
  assert.equal(evidence[0]!.waits, 0);
  assert.match(evidence[0]!.errors[0]!, /Unity 进程 219536 已退出，但内核仍未回收它/);
  assert.match(evidence[0]!.guidance!, /卡在退出中/);
  assert.match(evidence[0]!.guidance!, /重启电脑/);
  assert.equal(evidence[0]!.licence, undefined);
});

test('a project a live editor holds is named as the editor to close, and no restart is asked for', async t => {
  const f = fixture(t);
  const live = { pid: 4242, commandLine: 'Unity.exe -projectPath ' + f.project, exited: false };
  const evidence = await runUnitySteps(f.config, [f.step], f.project, f.runDir, () => {}, async () =>
    ({ code: 4, timedOut: false, busy: { kind: 'editor' as const, occupiers: [live] } }));
  assert.equal(evidence[0]!.exitCode, 4);
  assert.match(evidence[0]!.errors[0]!, /Unity 编辑器 4242 正在运行并打开本工程/);
  assert.match(evidence[0]!.guidance!, /PID 4242/);
  assert.doesNotMatch(evidence[0]!.guidance!, /重启电脑/);
});
