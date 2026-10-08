import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main } from '../src/cli.ts';
import { NodeHostPlatform } from '../src/host-platform.ts';
import { allowedTaskPath } from '../src/task-cli.ts';
import { removeTemp, windows } from './fixtures/platform.ts';

test('within uses injected case rules and rejects symlinks escaping a writable root', t => {
  const dir = mkdtempSync(join(tmpdir(), 'avh-host-'));
  t.after(() => removeTemp(dir));
  const project = join(dir, 'project'), outside = join(dir, 'outside');
  mkdirSync(join(project, 'Assets'), { recursive: true }); mkdirSync(outside);
  symlinkSync(outside, join(project, 'escape'), windows ? 'junction' : undefined);
  const linux = new NodeHostPlatform(false, false), insensitive = new NodeHostPlatform(true, true);
  assert.equal(linux.within(join(project, 'Assets'), join(project, 'assets/x')), false);
  assert.equal(insensitive.within(join(project, 'Assets'), join(project, 'assets/x')), true);
  assert.equal(allowedTaskPath('assets/x', ['Assets'], project, linux), false);
  assert.equal(allowedTaskPath('assets/x', ['Assets'], project, insensitive), true);
  assert.equal(insensitive.within(project, join(project, 'escape/x')), false);
});

test('resolveExecutable finds a PATHEXT command shim', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-pathext-'));
  t.after(() => removeTemp(root));
  const shim = join(root, 'tool.cmd'); writeFileSync(shim, 'synthetic');
  const oldPath = process.env.PATH, oldExt = process.env.PATHEXT;
  process.env.PATH = root; process.env.PATHEXT = '.EXE;.CMD';
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = oldExt;
  });
  const host = new NodeHostPlatform(true, true);
  assert.equal(host.resolveExecutable('tool'), shim);
  assert.equal(host.resolveExecutable('tool.cmd'), shim);
});

test('workspace init and doctor reject injected OneDrive home before creating state', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'avh-cloud-'));
  t.after(() => removeTemp(dir));
  const home = join(dir, 'OneDrive', 'avh');
  const oldHome = process.env.AVH_HOME, oldOneDrive = process.env.OneDrive;
  process.env.AVH_HOME = home; process.env.OneDrive = join(dir, 'OneDrive');
  t.after(() => {
    if (oldHome === undefined) delete process.env.AVH_HOME; else process.env.AVH_HOME = oldHome;
    if (oldOneDrive === undefined) delete process.env.OneDrive; else process.env.OneDrive = oldOneDrive;
  });
  const host = new NodeHostPlatform(true, true);
  await assert.rejects(main(['workspace', 'init'], host), /云同步目录.*本机未同步/);
  await assert.rejects(main(['doctor'], host), /云同步目录.*本机未同步/);
  assert.equal(existsSync(home), false);
  // Linux does not infer OneDrive semantics from an environment variable alone.
  assert.equal(new NodeHostPlatform(false, false).cloudSyncedRoot(home), undefined);
  mkdirSync(join(dir, 'OneDrive'));
  const alias = join(dir, 'alias'); symlinkSync(join(dir, 'OneDrive'), alias, windows ? 'junction' : 'dir');
  assert.equal(host.cloudSyncedRoot(join(alias, 'linked-avh')), join(dir, 'OneDrive'));
  const local = join(dir, 'local-avh');
  process.env.AVH_HOME = local;
  await main(['workspace', 'init'], host);
  assert.equal(existsSync(join(local, 'config/harness.yaml')), true);
});
