import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createWindowsUnityProjectAlias, sameWindowsUnityProject } from '../../src/exec/windows-unity-alias.ts';
import { windowsHelper } from '../../src/exec/windows-helper.ts';
import { EXCLUSIVE_OPEN, WindowsUnityLauncher } from '../../src/exec/windows-unity.ts';
import { runUnitySteps } from '../../src/exec/unity-steps.ts';
import { removeTemp, windows } from '../fixtures/platform.ts';
import { spawnUnityEditor } from '../fixtures/unity-slot.ts';
import { unityMachineBatchLockPath } from '../../src/exec/unity-batch-lock.ts';

test('real Unity source consumer resolves the same Windows file and rejects copied, changed and linked sources',
  { skip: !windows || !process.env.AVH_FACE_UNITY_EDITOR, timeout: 300_000 }, t => {
    const root = mkdtempSync(join(process.env.LOCALAPPDATA!, 'avh-source-identity-'));
    const project = join(root, '工程'), outside = join(root, 'outside');
    for (const dir of ['Assets/Editor', 'Assets/Source', '_harness', 'Packages', 'ProjectSettings']) mkdirSync(join(project, dir), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(project, 'Packages/manifest.json'), '{"dependencies":{}}');
    writeFileSync(join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
    for (const name of ['AvhCommon.cs', 'FaceStage.cs', 'FaceMapping.cs', 'FaceGeometry.cs', 'FaceEyes.cs'])
      copyFileSync(fileURLToPath(new URL('../../builtin/tools/harness/unity/Editor/' + name, import.meta.url)), join(project, 'Assets/Editor', name));
    copyFileSync(fileURLToPath(new URL('../fixtures/unity/UnityPathIdentityIntegration.cs', import.meta.url)), join(project, 'Assets/Editor/UnityPathIdentityIntegration.cs'));
    for (const file of ['Assets/Source/identity.dat', 'Assets/Source/copy.dat']) writeFileSync(join(project, file), 'frozen source');
    writeFileSync(join(outside, 'identity.dat'), 'frozen source');
    symlinkSync(outside, join(project, '_harness/Linked'), 'junction');
    symlinkSync(join(project, 'Assets/Source'), join(outside, 'into-project'), 'junction');
    const alias = createWindowsUnityProjectAlias(project), output = join(root, 'source-result.json');
    t.after(() => { alias.remove(); if (!process.env.AVH_FACE_KEEP_PROJECT) removeTemp(root); });
    // Identity is tested in the real editor with the same verified Runtime alias. The fixture now starts that editor
    // through the Runtime's Windows launcher (Low integrity, own profile with the account's licence), so the probe's
    // result directory has to be a labelled root as well: a Low process can only write where Harness labelled it.
    const launch = (log: string) => spawnUnityEditor(process.env.AVH_FACE_UNITY_EDITOR!, ['-batchmode', '-nographics', '-projectPath', alias.path,
      '-executeMethod', 'UnityPathIdentityIntegration.SourceRun', '-logFile', join(root, log)], {
      encoding: 'utf8', timeout: 120_000, windowsHide: true, writableRoots: [root],
      env: { ...process.env, AVH_PROJECT_DIR: alias.path, AVH_PHYSICAL_PROJECT_DIR: alias.project, AVH_UNITY_ALIAS_NONCE: alias.nonce,
        AVH_PROBE_OUTPUT: output, AVH_PROBE_OUTSIDE: join(outside, 'into-project/identity.dat') },
    });
    const positive = launch('source.log');
    assert.equal(positive.status, 0, readFileSync(join(root, 'source.log'), 'utf8').match(/.*(?:error CS|Exception).*/g)?.join('\n'));
    const evidence = JSON.parse(readFileSync(output, 'utf8')); assert.equal(evidence.ok, true); assert.equal(evidence.checks, 9);
    const consumer = join(project, 'Assets/Editor/FaceStage.cs'), fixed = readFileSync(consumer, 'utf8');
    const removed = fixed.replace('Avh.SameProjectFile(source.Str("path"), relative)',
      'Path.GetFullPath(source.Str("path")) == Path.GetFullPath(Avh.IdentityAbs(relative))');
    assert.notEqual(removed, fixed); writeFileSync(consumer, removed);
    try {
      assert.equal(launch('source-fix-removed.log').status, 1);
      assert.match(JSON.parse(readFileSync(output, 'utf8')).error, /physical source spelling|Windows source case/);
    } finally { writeFileSync(consumer, fixed); }
    if (process.env.AVH_FACE_KEEP_PROJECT) console.log('Source identity evidence: ' + root);
  });

test('real Unity accepts the Runtime-owned alias under redirected LocalAppData and rejects foreign bindings',
  { skip: !windows || !process.env.AVH_FACE_UNITY_EDITOR, timeout: 600_000 }, async t => {
    const root = mkdtempSync(join(process.env.LOCALAPPDATA!, 'avh-unity-identity-'));
    const project = join(root, '工程'), run = join(root, 'run'), home = join(root, 'home');
    t.after(() => { if (!process.env.AVH_FACE_KEEP_PROJECT) removeTemp(root); });
    for (const name of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(project, name), { recursive: true });
    mkdirSync(run); mkdirSync(home);
    writeFileSync(join(project, 'Packages/manifest.json'), '{"dependencies":{}}');
    writeFileSync(join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
    const source = fileURLToPath(new URL('../../builtin/tools/harness/unity/Editor/AvhCommon.cs', import.meta.url));
    const installed = join(project, 'Assets/Editor/AvhCommon.cs'); copyFileSync(source, installed);
    copyFileSync(fileURLToPath(new URL('../fixtures/unity/UnityPathIdentityIntegration.cs', import.meta.url)),
      join(project, 'Assets/Editor/UnityPathIdentityIntegration.cs'));
    const priorHome = process.env.AVH_HOME; process.env.AVH_HOME = home;
    t.after(() => { if (priorHome === undefined) delete process.env.AVH_HOME; else process.env.AVH_HOME = priorHome; });
    const output = join(run, 'identity.json');
    const config = { runner: process.env.AVH_FACE_UNITY_EDITOR!, lockPath: unityMachineBatchLockPath(), busyExitCode: 5,
      homeSeedFrom: [], projectScratch: ['Library', 'Temp', 'Logs', 'UserSettings', 'obj'], defaultTimeoutSec: 240, passEnv: [] };
    const launch = () => runUnitySteps(config, [{ method: 'UnityPathIdentityIntegration.Run', quit: false, env: { AVH_PROBE_OUTPUT: output } }], project, run);
    const result = await launch();
    assert.equal(result[0]?.exitCode, 0, JSON.stringify(result));
    const evidence = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(evidence.ok, true); assert.equal(evidence.checks, 4);
    if (evidence.physicalSpellingDiffers) {
      // Exercise the removed fix in the actual compiled Unity consumer, not a simulated path comparison.
      const bytes = readFileSync(installed, 'utf8');
      assert.ok(bytes.includes('PhysicalDirectory(root), PhysicalDirectory(physical)'));
      writeFileSync(installed, bytes.replace('PhysicalDirectory(root), PhysicalDirectory(physical)', 'PhysicalDirectory(root), NormalPath(physical)'));
      try { assert.equal((await launch())[0]?.exitCode, 1, 'the old consumer rejects this real redirected path'); }
      finally { writeFileSync(installed, bytes); }
    }
    if (process.env.AVH_FACE_KEEP_PROJECT) console.log('Unity identity evidence: ' + root);
  });

test('step configuration cannot replace the physical project or private Run binding', () => {
  const project = join(tmpdir(), 'managed-project'), run = join(tmpdir(), 'managed-run');
  const launcher = new WindowsUnityLauncher({ runner: join(tmpdir(), 'Unity.exe'), lockPath: join(tmpdir(), 'batch.lock'), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 30, passEnv: [] });
  const plan = launcher.plan({ method: 'Fixture.Run', quit: true, env: { AVH_PROJECT_DIR: join(tmpdir(), 'foreign'), AVH_RUN_DIR: join(tmpdir(), 'foreign-run') } }, project, run);
  assert.equal(plan.env.AVH_PROJECT_DIR, project);
  assert.equal(plan.env.AVH_RUN_DIR, run);
  assert.deepEqual(plan.writable, [project, run]);
});

test('a fresh short junction maps only to its physical project, preserves authorization roots and unlinks only itself',
  { skip: !windows && 'Windows junction semantics' }, t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-alias-')); t.after(() => removeTemp(root));
    const project = join(root, 'project'), other = join(root, 'other'); mkdirSync(project); mkdirSync(other);
    writeFileSync(join(project, 'original.txt'), 'keep');
    const first = createWindowsUnityProjectAlias(project, { profile: root });
    const second = createWindowsUnityProjectAlias(project, { profile: root });
    assert.notEqual(first.path, second.path, 'a stale or other launch alias is never adopted');
    assert.ok(first.path.length < 100);
    assert.equal(sameWindowsUnityProject(first.path, project), true);
    assert.equal(sameWindowsUnityProject(first.path, other), false);
    mkdirSync(join(project, 'Temp')); writeFileSync(join(project, 'Temp/UnityLockfile'), '');
    const lock = openSync(join(project, 'Temp/UnityLockfile'), constants.O_RDWR | EXCLUSIVE_OPEN);
    const launcher = new WindowsUnityLauncher({ runner: 'C:\\Unity.exe', lockPath: join(root, 'batch.lock'),
      busyExitCode: 5, homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 30, passEnv: [] });
    try {
      assert.equal(launcher.busy(project), true);
      assert.equal(launcher.busy(first.path), true, 'the alias shares the physical editor lock');
    } finally { closeSync(lock); }
    const denied = spawnSync(windowsHelper(), ['sandbox', '--low', '--', process.execPath, '-e',
      "require('fs').writeFileSync(process.argv[1], 'tampered')", join(first.container, 'owner.json')],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.notEqual(denied.status, 0, 'the provider Low token cannot rewrite the Runtime-owned mapping');
    first.verify(); first.remove(); second.remove();
    assert.equal(existsSync(first.container), false);
    assert.equal(readFileSync(join(project, 'original.txt'), 'utf8'), 'keep', 'cleanup never descends into the real project');
  });

test('foreign replacement, changed ownership and overlong local profiles fail closed and preserve targets',
  { skip: !windows && 'Windows junction semantics' }, t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-alias-')); t.after(() => removeTemp(root));
    const project = join(root, 'project'), foreign = join(root, 'foreign'); mkdirSync(project); mkdirSync(foreign);
    writeFileSync(join(foreign, 'keep.txt'), 'foreign');
    const alias = createWindowsUnityProjectAlias(project, { profile: root });
    rmdirSync(alias.path); symlinkSync(foreign, alias.path, 'junction');
    assert.throws(() => alias.verify(), /已变化|已替换/);
    assert.throws(() => alias.remove(), /已变化|已替换/);
    assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'foreign');
    rmdirSync(alias.path);
    const modified = createWindowsUnityProjectAlias(project, { profile: root });
    writeFileSync(join(modified.container, 'owner.json'), '{}');
    assert.throws(() => modified.verify(), /已变化/);
    assert.throws(() => modified.remove(), /已变化/);
    rmdirSync(modified.path);
    const longProfile = join(root, 'x'.repeat(80)); mkdirSync(longProfile);
    assert.throws(() => createWindowsUnityProjectAlias(project, { profile: longProfile }), /过长/);
    assert.equal(existsSync(project), true);
  });
