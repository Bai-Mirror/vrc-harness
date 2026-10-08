import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { UnityConfig } from '../../src/config.ts';
import { LinuxUnityLauncher } from '../../src/exec/unity-launcher.ts';
import { removeTemp, windows } from '../fixtures/platform.ts';

test('UnityLauncher builds direct Unity argv and shares legacy flock slot', { skip: windows && 'flock and bwrap are Linux only; see test/exec/windows.test.ts' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-unity-launcher-'));
  t.after(() => removeTemp(root));
  const project = join(root, 'project'), run = join(root, 'run'), editor = join(root, 'Unity');
  mkdirSync(project); mkdirSync(run); writeFileSync(editor, '#!/bin/sh\nexit 0\n'); chmodSync(editor, 0o700);
  const config: UnityConfig = { runner: editor, lockPath: join(root, 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 30, passEnv: [] };
  const first = new LinuxUnityLauncher(config), second = new LinuxUnityLauncher(config);
  const plan = first.plan({ method: 'Example.Batch.Run', quit: true, env: {} }, project, run);
  assert.deepEqual(plan.argv, [editor, '-projectPath', project, '-force-vulkan', '-batchmode',
    '-quit', '-logFile', join(run, 'unity-1.log'), '-executeMethod', 'Example.Batch.Run']);
  assert.equal(plan.env.HOME, join(run, 'unity-home'));
  assert.equal(plan.isolation?.privateTemp, join(run, 'tmp'));
  assert.equal(plan.env.TMPDIR, '/tmp', 'the private temp is mounted at /tmp; its host path can exceed the socket path limit');
  assert.deepEqual(plan.isolation?.writableFiles, [config.lockPath]);
  assert.equal(first.acquireBatchSlot(), true);
  assert.equal(second.acquireBatchSlot(), false);
  first.release();
  assert.equal(second.acquireBatchSlot(), true);
  second.release();
});

test('UnityLauncher reads a legacy runner default without executing the script', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-unity-legacy-'));
  t.after(() => removeTemp(root));
  const script = join(root, 'unity_run.sh'), editor = join(root, 'Unity');
  writeFileSync(script, 'U=${UNITY_BIN:-' + editor + '}\nexit 99\n');
  const previous = process.env.UNITY_BIN;
  delete process.env.UNITY_BIN;
  t.after(() => { if (previous === undefined) delete process.env.UNITY_BIN; else process.env.UNITY_BIN = previous; });
  const launcher = new LinuxUnityLauncher({ runner: script, lockPath: join(root, 'lock'),
    busyExitCode: 5, homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 30, passEnv: [] });
  assert.equal(launcher.installation().editorPath, editor);
});
