import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { desktopDocument, desktopPath, startMenuPath } from '../../src/gui/install.ts';
import { claudeLoginStatus, openSetupTokenWindow, setupTokenLaunch } from '../../src/gui/claude-login.ts';
import { guiRoute } from '../../src/gui/server.ts';
import { readSecret, secretMethod } from '../../src/providers/secrets.ts';
import { fakeCommand, removeTemp } from '../fixtures/platform.ts';

test('the setup-token window gets a console of its own, stays open, survives the npm install path and inherits no Claude variable', () => {
  const claude = 'C:\\ExampleHomes\\A B\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  const launch = setupTokenLaunch([claude], { ComSpec: 'C:\\Windows\\system32\\cmd.exe', USERPROFILE: 'C:\\ExampleHomes\\A B', PATH: 'C:\\bin',
    ANTHROPIC_API_KEY: 'sk-ant-api03-x', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_CONFIG_DIR: 'C:\\x', CLAUDECODE: '1' });
  assert.equal(launch.file, 'C:\\Windows\\system32\\cmd.exe');
  // start: a console window of its own; /k: it stays open to copy the token; /s: only the outer quotes are stripped.
  assert.deepEqual(launch.args, ['/d', '/c', 'start', '"Claude Code setup-token"', 'cmd.exe', '/d', '/s', '/k', `""${claude}" setup-token"`]);
  assert.equal(launch.options.windowsVerbatimArguments, true, 'cmd parses its own command line; Node must not quote it again');
  assert.equal(launch.options.detached, true);
  assert.equal(launch.options.windowsHide, false);
  assert.equal(launch.options.cwd, 'C:\\ExampleHomes\\A B');
  assert.deepEqual(Object.keys(launch.options.env ?? {}).filter(name => /^(ANTHROPIC|CLAUDE)/i.test(name)), []);
  assert.equal(launch.options.env?.PATH, 'C:\\bin');
  assert.deepEqual(setupTokenLaunch(['C:\\node.exe', 'C:\\cli.js']).args.at(-1), '""C:\\node.exe" "C:\\cli.js" setup-token"');
  for (const path of ['C:\\Tom&Jerry\\claude.exe', 'C:\\100%\\claude.exe', 'C:\\a^b\\claude.exe', 'C:\\a|b\\claude.exe'])
    assert.throws(() => setupTokenLaunch([path], {}), /无法安全传递/, path);
});

test('first run saves AI credentials in the GUI host before the Runtime can start; afterwards they go through the Runtime', () => {
  for (const method of ['secret.status', 'secret.set', 'secret.clear']) {
    assert.equal(guiRoute(method, false), 'secret', method);
    assert.equal(guiRoute(method, true), 'runtime', method);
  }
  assert.equal(guiRoute('secret.get', false), 'refused', 'no method reads a credential back');
  assert.equal(guiRoute('setup.claude.setupToken', true), 'setup');
  assert.equal(guiRoute('project.list', false), 'runtime');
  assert.equal(guiRoute('project.production.resume',true),'runtime','project continuation reaches the Runtime through the actual GUI host');
  assert.equal(guiRoute('project.production.cancel',true),'runtime','project cancellation reaches the Runtime through the actual GUI host');
  assert.equal(guiRoute('service.stop', true), 'refused');
});

test('the setup-token window opens only where Claude signs in with a saved credential, and only with Claude Code installed', async t => {
  const started: Array<[string, readonly string[]]> = [];
  const fake = ((file: string, args: readonly string[]) => {
    started.push([file, args]);
    const child = Object.assign(new EventEmitter(), { unref: () => undefined });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }) as unknown as typeof spawn;
  assert.deepEqual(claudeLoginStatus('linux').required, false, 'Linux Runs use the person\'s own login');
  await assert.rejects(openSetupTokenWindow('linux', fake), /不需要长期令牌/);
  const dir = mkdtempSync(join(tmpdir(), 'avh-claude-login-')); t.after(() => removeTemp(dir));
  const prior = process.env.PATH; t.after(() => { process.env.PATH = prior; });
  process.env.PATH = join(dir, 'empty');
  assert.equal(claudeLoginStatus('win32').installed, false);
  await assert.rejects(openSetupTokenWindow('win32', fake), /没有找到 Claude Code/);
  assert.equal(started.length, 0, 'nothing was started');
  fakeCommand(join(dir, 'claude'), 'process.exit(0);');
  process.env.PATH = dir;
  assert.deepEqual(claudeLoginStatus('win32'), { required: true, installed: true });
  assert.deepEqual(await openSetupTokenWindow('win32', fake), { opened: true });
  assert.equal(started.length, 1);
  assert.match(started[0]![1].at(-1)!, /claude(\.js)?" setup-token"$/);
});

test('the first-run AI step stores an API key before the Runtime exists, and never hands one back', t => {
  const home = mkdtempSync(join(tmpdir(), 'avh-gui-secret-')); t.after(() => removeTemp(home));
  // Before a configuration exists the GUI host answers the secret.* methods itself (guiRoute); afterwards the Runtime does.
  assert.equal(guiRoute('secret.set', false), 'secret');
  assert.deepEqual(secretMethod(home, 'secret.status', { ids: ['pi-deepseek'] }), { 'pi-deepseek': false });
  assert.deepEqual(secretMethod(home, 'secret.set', { id: 'pi-deepseek', value: ' sk-first-run-XYZ ' }), { ok: true });
  assert.equal(readSecret(home, 'pi-deepseek'), 'sk-first-run-XYZ', 'stored where the Runtime reads it');
  assert.deepEqual(readdirSync(join(home, 'config')), ['secrets'], 'no configuration is written with it');
  const status = secretMethod(home, 'secret.status', { ids: ['pi-deepseek', 'pi-zhipu'] });
  assert.deepEqual(status, { 'pi-deepseek': true, 'pi-zhipu': false });
  assert.doesNotMatch(JSON.stringify(status), /sk-first-run/);
  assert.throws(() => secretMethod(home, 'secret.set', { id: '../config/harness.yaml', value: 'x' }), /无效的凭据名/);
  assert.equal(guiRoute('secret.set', true), 'runtime', 'once configured, keys change through the Runtime');
  assert.deepEqual(secretMethod(home, 'secret.clear', { id: 'pi-deepseek' }), { cleared: true });
  assert.equal(readSecret(home, 'pi-deepseek'), undefined);
});

test('Linux desktop entry launches this installed Harness package without a terminal', () => {
  const document=desktopDocument('/opt/node 24/bin/node','/opt/Harness App/bin/avh.js');
  assert.match(document,/^Name=Harness$/m); assert.match(document,/^Terminal=false$/m);
  assert.match(document,/^Exec="\/opt\/node 24\/bin\/node" "\/opt\/Harness App\/bin\/avh\.js" gui$/m);
  assert.equal(desktopPath({XDG_DATA_HOME:'/tmp/user data'}),join('/tmp/user data','applications/avatar-harness.desktop'));
});

test("the Windows Start menu entry of avh gui is not the desktop installer's, so removing it leaves the app's alone", () => {
  const path = startMenuPath({ APPDATA: join('C:', 'Users', 'u', 'AppData', 'Roaming') });
  assert.equal(path, join('C:', 'Users', 'u', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', basename(path)));
  assert.notEqual(basename(path).toLowerCase(), 'harness.lnk', 'the NSIS installer names its shortcut after the product');
});
