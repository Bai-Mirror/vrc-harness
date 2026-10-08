import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { hostMasks, maskArgs, probeBwrap } from '../../src/exec/sandbox.ts';
import { checkSandboxStatus, runCheckCommand } from '../../src/exec/check-runner.ts';
import { gitHead, statusSnapshot } from '../../src/exec/git-scan.ts';
import { unityBwrapArgs } from '../../src/exec/unity-steps.ts';
import { posixPath, removeTemp, windows } from '../fixtures/platform.ts';

function root(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'avh-mask-')));
  t.after(() => removeTemp(dir));
  return dir;
}
async function listen(t: TestContext, path: string): Promise<Server> {
  const server = createServer(socket => { socket.on('error', () => undefined); socket.end('reached\n'); });
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(() => server.close());
  return server;
}
const bwrap = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'avh-mask-probe-'));
  try { mkdirSync(join(dir, 'run')); return probeBwrap(dir, join(dir, 'run'), [], [join(dir, 'run')], dir).available; }
  finally { rmSync(dir, { recursive: true, force: true }); }
})();

test('host masks cover the Runtime control files, the desktop cookie jar, the session and agent sockets',
  { skip: windows && 'bwrap masks are Linux only; Windows uses integrity labels (test/exec/windows.test.ts)' }, async t => {
  const dir = root(t), home = join(dir, 'home'), runtime = join(dir, 'runtime'), data = join(dir, 'data');
  for (const path of [join(home, 'run'), join(home, 'config'), join(home, 'state'), join(home, 'runs'), runtime,
    join(data, 'app.avatar-harness.desktop'), join(dir, 'agent')]) mkdirSync(path, { recursive: true });
  await listen(t, join(dir, 'agent', 'ssh.sock'));
  await listen(t, join(runtime, 'bus'));
  const masks = hostMasks(home, { XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(dir, 'none'),
    XDG_CACHE_HOME: join(dir, 'none'), SSH_AUTH_SOCK: join(dir, 'agent', 'ssh.sock') });
  for (const path of [join(home, 'run'), join(home, 'config'), join(home, 'state'), runtime,
    join(data, 'app.avatar-harness.desktop')]) assert.ok(masks.directories.includes(path), path);
  assert.ok(!masks.directories.includes(join(home, 'runs')), 'Run directories stay visible');
  assert.ok(masks.sockets.includes(join(dir, 'agent', 'ssh.sock')));
  assert.ok(!masks.sockets.includes(join(runtime, 'bus')), 'a socket under a masked directory needs no own mask');
  const agentOnly = hostMasks(home, { SSH_AUTH_SOCK: join(runtime, 'bus') }, { runtimeDirectory: false });
  assert.ok(agentOnly.sockets.includes(join(runtime, 'bus')), 'without the runtime mask the socket is masked by itself');
  const args = maskArgs(masks, [join(runtime, 'project')]);
  assert.ok(!args.includes(runtime), 'a mask over a path the Run reads is dropped');
  assert.deepEqual(args.slice(args.indexOf(join(dir, 'agent', 'ssh.sock')) - 2).slice(0, 3),
    ['--ro-bind', '/dev/null', join(dir, 'agent', 'ssh.sock')]);
});

test('a bwrap Run cannot reach the Runtime API, the config or an agent socket, nor see host processes',
  { skip: !bwrap && 'bwrap unavailable' }, async t => {
    const dir = root(t), home = join(dir, 'home'), run = join(dir, 'home', 'runs', 'r1');
    for (const path of [join(home, 'run'), join(home, 'config'), run, join(dir, 'agent')]) mkdirSync(path, { recursive: true });
    writeFileSync(join(home, 'config', 'booth-session'), 'cookie');
    await listen(t, join(home, 'run', 'avh.sock'));
    await listen(t, join(dir, 'agent', 'ssh.sock'));
    const connect = `const s=require('net').connect(process.argv[1]);s.on('connect',()=>{console.log('REACHED');process.exit(0)});`
      + `s.on('error',e=>{console.log('BLOCKED '+e.code);process.exit(0)})`;
    const script = [
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(connect)} ${JSON.stringify(join(home, 'run', 'avh.sock'))}`,
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(connect)} "$SSH_AUTH_SOCK"`,
      `test -e ${JSON.stringify(join(home, 'config', 'booth-session'))} && echo SESSION-VISIBLE || echo SESSION-HIDDEN`,
      'echo "PIDS=$(ls /proc | grep -c "^[0-9]")"',
      `echo written > ${JSON.stringify(join(run, 'out.txt'))}`,
    ].join('\n');
    writeFileSync(join(run, 'command.json'), JSON.stringify({ runDirectory: run, sandbox: 'bwrap', argv: ['sh', '-c', script],
      cwd: run, env: { SSH_AUTH_SOCK: join(dir, 'agent', 'ssh.sock') }, writable: [run], readonlyGitPaths: [],
      harnessHome: home, projectDirectory: run }));
    const wrapper = fileURLToPath(new URL('../../src/exec/unit-wrapper.mjs', import.meta.url));
    // Asynchronous: the listening sockets live in this process and must keep accepting while the Run connects.
    const status = await new Promise<number | null>(resolve => spawn(process.execPath, [wrapper, join(run, 'command.json')],
      { stdio: 'ignore', timeout: 30_000 }).on('close', resolve));
    const out = readFileSync(join(run, 'stdout.log'), 'utf8');
    assert.equal(status, 0, readFileSync(join(run, 'stderr.log'), 'utf8'));
    assert.equal(out.match(/BLOCKED/g)?.length, 2, out);
    assert.doesNotMatch(out, /REACHED|SESSION-VISIBLE/);
    assert.ok(Number(/PIDS=(\d+)/.exec(out)?.[1]) < 10, out);
    assert.equal(readFileSync(join(run, 'out.txt'), 'utf8'), 'written\n', 'the Run directory stays writable');
  });

test('a bwrap Run declared without network cannot reach a host listener; one with network can',
  { skip: !bwrap && 'bwrap unavailable' }, async t => {
    const dir = root(t);
    const server = createServer(socket => { socket.on('error', () => undefined); socket.end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const port = (server.address() as AddressInfo).port;
    const connect = `const s=require('net').connect(${port},'127.0.0.1');s.on('connect',()=>{console.log('REACHED');process.exit(0)});`
      + `s.on('error',e=>{console.log('BLOCKED '+e.code);process.exit(0)})`;
    const wrapper = fileURLToPath(new URL('../../src/exec/unit-wrapper.mjs', import.meta.url));
    for (const network of [false, true]) {
      const run = join(dir, `run-${network}`); mkdirSync(run);
      writeFileSync(join(run, 'command.json'), JSON.stringify({ runDirectory: run, sandbox: 'bwrap', argv: [process.execPath, '-e', connect],
        cwd: run, env: {}, writable: [run], readonlyGitPaths: [], harnessHome: join(dir, 'home'), projectDirectory: run, network }));
      const status = await new Promise<number | null>(resolve => spawn(process.execPath, [wrapper, join(run, 'command.json')],
        { stdio: 'ignore', timeout: 30_000 }).on('close', resolve));
      const out = readFileSync(join(run, 'stdout.log'), 'utf8');
      assert.equal(status, 0, readFileSync(join(run, 'stderr.log'), 'utf8'));
      assert.match(out, network ? /REACHED/ : /BLOCKED/, `network=${network}: ${out}`);
    }
  });

test('host git scans do not run a repository fsmonitor or hooks written by a Run', t => {
  const dir = root(t), repo = join(dir, 'repo'), marker = join(dir, 'fsmonitor-ran');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'a.txt'), 'a');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'a']);
  const hook = join(dir, 'monitor.sh');
  // Git for Windows runs the hook with its own sh, which wants forward slashes; a planted hook would use them too.
  writeFileSync(hook, `#!/bin/sh\necho ran >> ${JSON.stringify(posixPath(marker))}\n`); chmodSync(hook, 0o700);
  execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', posixPath(hook)]);
  writeFileSync(join(repo, 'a.txt'), 'changed');
  execFileSync('git', ['-C', repo, 'status', '--porcelain'], { stdio: 'ignore' });
  assert.ok(existsSync(marker), 'control: plain git status runs the configured fsmonitor');
  rmSync(marker);
  const snapshot = statusSnapshot(repo);
  gitHead(repo);
  assert.ok(snapshot['a.txt']?.startsWith(' M'), JSON.stringify(snapshot));
  assert.ok(!existsSync(marker), 'the scan ran the repository fsmonitor');
});

test('Unity sandbox arguments mask the Runtime control directories', t => {
  const dir = root(t), home = join(dir, 'home');
  for (const name of ['run', 'config', 'state']) mkdirSync(join(home, name), { recursive: true });
  const previous = process.env.AVH_HOME;
  process.env.AVH_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.AVH_HOME; else process.env.AVH_HOME = previous; });
  const args = unityBwrapArgs({ argv: ['/bin/true'], env: {}, writable: [], privateTmp: dir, log: join(dir, 'log') });
  for (const name of ['run', 'config', 'state'])
    assert.equal(args[args.indexOf(join(home, name)) - 1], '--tmpfs', name);
  assert.ok(args.indexOf(join(home, 'run')) > args.indexOf('/tmp'), 'masks follow the private /tmp');
});

// The check sandbox already replaces /tmp, so the home must live elsewhere, as the real ~/.avatar-harness does.
const shm = existsSync('/dev/shm') ? '/dev/shm' : undefined;
test('a sandboxed check cannot reach the Runtime API socket',
  { skip: (!checkSandboxStatus().available && 'no check sandbox') || (!shm && 'no /dev/shm') }, async t => {
    const dir = realpathSync(mkdtempSync(join(shm!, 'avh-mask-')));
    t.after(() => removeTemp(dir));
    const home = join(dir, 'home'), project = join(dir, 'project'), run = join(dir, 'run');
    for (const path of [join(home, 'run'), project, run]) mkdirSync(path, { recursive: true });
    await listen(t, join(home, 'run', 'avh.sock'));
    const connect = `const s=require('net').connect(process.argv[1]);s.on('connect',()=>{console.log('REACHED');process.exit(0)});`
      + `s.on('error',e=>{console.log('BLOCKED '+e.code);process.exit(0)})`;
    const result = await runCheckCommand([process.execPath, '-e', connect, join(home, 'run', 'avh.sock')],
      { project, runDirectory: run, checkId: 'api', timeoutMs: 20_000, harnessHome: home, isolation: 'bwrap' });
    assert.match(result.stdout, /BLOCKED/, result.stdout + result.stderr);
  });
