import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installBundledPack, managedPacks } from '../src/managed-pack.ts';
import { removeTemp, windows } from './fixtures/platform.ts';

test('a bundled pack is installed once per content; a changed bundle lands beside the old copy, never over it', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-bundled-')); t.after(() => removeTemp(root));
  const bundle = join(root, 'bundle'), home = join(root, 'home');
  mkdirSync(join(bundle, 'tools', 'harness', '__pycache__'), { recursive: true }); mkdirSync(home);
  writeFileSync(join(bundle, 'pack.json'), JSON.stringify({ schema: 'harness-managed-pack/0.1', id: 'builtin-x', version: '1.0.0', channel: 'builtin', description: 'test' }));
  writeFileSync(join(bundle, 'tools', 'harness', 'tool.py'), 'print(1)\n');
  writeFileSync(join(bundle, 'tools', 'run.sh'), '#!/bin/sh\n'); chmodSync(join(bundle, 'tools', 'run.sh'), 0o755);
  writeFileSync(join(bundle, 'tools', 'harness', '__pycache__', 'tool.cpython-314.pyc'), 'bytecode');
  const prior = process.env.AVH_BUNDLED_ROOT; process.env.AVH_BUNDLED_ROOT = bundle;
  t.after(() => { if (prior === undefined) delete process.env.AVH_BUNDLED_ROOT; else process.env.AVH_BUNDLED_ROOT = prior; });
  const first = installBundledPack(home);
  assert.equal(first.root, join(home, 'managed', 'packs', 'builtin-x'));
  assert.equal(existsSync(join(first.root, 'tools', 'harness', '__pycache__')), false);
  // Windows has no executable bit to keep.
  if (!windows) assert.ok(statSync(join(first.root, 'tools', 'run.sh')).mode & 0o100, 'a runner stays executable once installed');
  writeFileSync(join(bundle, 'tools', 'harness', '__pycache__', 'tool.cpython-314.pyc'), 'other bytecode');
  assert.equal(installBundledPack(home).root, first.root, 'bytecode alone is not a new pack');
  writeFileSync(join(bundle, 'tools', 'harness', 'tool.py'), 'print(2)\n');
  const second = installBundledPack(home);
  assert.match(second.info.id, /^builtin-x\+[0-9a-f]{12}$/); assert.equal(second.info.bundledFrom, 'builtin-x');
  assert.equal(readFileSync(join(first.root, 'tools', 'harness', 'tool.py'), 'utf8'), 'print(1)\n', 'the installed copy is never rewritten');
  assert.equal(readFileSync(join(second.root, 'tools', 'harness', 'tool.py'), 'utf8'), 'print(2)\n');
  assert.equal(installBundledPack(home).root, second.root);
  assert.deepEqual(managedPacks(home).map(pack => pack.id).sort(), ['builtin-x', second.info.id].sort());
});

test('the bundled pack is the same pack whatever the umask of the process that installs it', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-bundled-umask-')); t.after(() => removeTemp(root));
  const bundle = join(root, 'bundle'), home = join(root, 'home');
  mkdirSync(join(bundle, 'knowledge', 'process'), { recursive: true }); mkdirSync(home);
  writeFileSync(join(bundle, 'pack.json'), JSON.stringify({ schema: 'harness-managed-pack/0.1', id: 'builtin-y', version: '1.0.0', channel: 'builtin', description: 'test' }));
  writeFileSync(join(bundle, 'knowledge', 'process', 'x.yaml'), 'a: 1\n');
  for (const dir of [bundle, join(bundle, 'knowledge'), join(bundle, 'knowledge', 'process')]) chmodSync(dir, 0o755);
  const prior = process.env.AVH_BUNDLED_ROOT; process.env.AVH_BUNDLED_ROOT = bundle;
  t.after(() => { if (prior === undefined) delete process.env.AVH_BUNDLED_ROOT; else process.env.AVH_BUNDLED_ROOT = prior; });
  const umask = process.umask(0o002);
  try {
    const first = installBundledPack(home);
    process.umask(0o022);
    // A terminal (umask 002) and the service (umask 022) must not each install their own copy of the same bundle.
    assert.equal(installBundledPack(home).root, first.root);
    assert.deepEqual(managedPacks(home).map(pack => pack.id), ['builtin-y']);
  } finally { process.umask(umask); }
});
