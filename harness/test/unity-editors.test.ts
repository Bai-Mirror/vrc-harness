import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findUnityEditors, findWindowsUnityEditors, unityEditorProblem } from '../src/unity-editors.ts';
import { removeTemp, windows } from './fixtures/platform.ts';

test('Unity editors are found in Hub\'s default and second install directories, the VRChat version first', t => {
  const home = mkdtempSync(join(tmpdir(), 'avh-unity-editors-')); t.after(() => removeTemp(home));
  const second = join(home, 'fast/Editors');
  const editors = [join(home, 'Unity/Hub/Editor/6000.0.1f1/Editor/Unity'), join(second, '2022.3.22f1/Editor/Unity'),
    join(second, '2019.4.31f1/Editor/Unity')];
  for (const editor of editors) { mkdirSync(join(editor, '..'), { recursive: true }); writeFileSync(editor, ''); chmodSync(editor, 0o755); }
  mkdirSync(join(second, 'broken/Editor'), { recursive: true }); writeFileSync(join(second, 'broken/Editor/Unity'), '');
  mkdirSync(join(home, '.config/unityhub'), { recursive: true });
  writeFileSync(join(home, '.config/unityhub/secondaryInstallPath.json'), JSON.stringify(second));
  // Windows has no executable bit, so a file named like the editor counts there; the Linux listing is checked on Linux.
  if (!windows) {
    assert.deepEqual(findUnityEditors(home, 'linux'), [editors[1], editors[2], editors[0]]);
    assert.match(unityEditorProblem(join(second, 'broken/Editor/Unity')) ?? '', /不可执行/);
  }
  assert.match(unityEditorProblem('Unity') ?? '', /绝对路径/);
  assert.equal(unityEditorProblem(editors[1]!), undefined);
});

test('Unity editors on Windows are found under Program Files and in Hub\'s second install directory, the VRChat version first',
  { skip: !windows && 'Windows install locations' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-unity-editors-win-')); t.after(() => removeTemp(root));
  const programs = join(root, 'Program Files'), appData = join(root, 'AppData', 'Roaming'), second = join(root, 'D', 'Unity');
  const editors = [join(programs, 'Unity', 'Hub', 'Editor', '6000.5.9f1', 'Editor', 'Unity.exe'),
    join(second, '2022.3.22f1', 'Editor', 'Unity.exe')];
  for (const editor of editors) { mkdirSync(join(editor, '..'), { recursive: true }); writeFileSync(editor, ''); }
  mkdirSync(join(programs, 'Unity', 'Hub', 'Editor', 'empty', 'Editor'), { recursive: true });
  mkdirSync(join(appData, 'UnityHub'), { recursive: true });
  writeFileSync(join(appData, 'UnityHub', 'secondaryInstallPath.json'), JSON.stringify(second));
  assert.deepEqual(findWindowsUnityEditors({ ProgramFiles: programs, APPDATA: appData }), [editors[1], editors[0]]);
  writeFileSync(join(appData, 'UnityHub', 'secondaryInstallPath.json'), '""');
  assert.deepEqual(findWindowsUnityEditors({ ProgramFiles: programs, APPDATA: appData }), [editors[0]], 'Hub writes "" when none is set');
});
