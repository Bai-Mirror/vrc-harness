import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor } from './fixtures/unity-slot.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));

test('the deadlock audit asks its question only where a position is declared, and still fails on real deadlocks',
  { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 1500000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-deadlock-audit-'));
  t.after(() => { if (!process.env.AVH_DEADLOCK_KEEP_PROJECT) removeTemp(root); });
  console.log('Deadlock audit evidence: ' + root);
  for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
  execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',
    join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
  writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
  copyFileSync(fileURLToPath(new URL('./fixtures/unity/DeadlockAuditIntegration.cs', import.meta.url)), join(root, 'Assets/Editor/DeadlockAuditIntegration.cs'));
  const unity = (log: string) => execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root,
    '-executeMethod', 'AVH.Harness.DeadlockAuditIntegration.Run', '-logFile', join(root, log)],
    { env: { ...process.env, AVH_PROJECT_DIR: root }, timeout: 900000, windowsHide: true, stdio: 'pipe' });
  try { unity('unity.log'); } catch (error) {
    assert.fail(String(error) + '\n' + readFileSync(join(root, 'unity.log'), 'utf8').match(/.*(?:error CS|Exception|failed).*/g)?.slice(-10).join('\n'));
  }
  const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
  assert.equal(result.ok, true, result.error);
  assert.equal(result.assertions, 8);

  // The mutants compile the changed production code in the same isolated project.
  const sourcePath = join(root, 'Assets/_HarnessTools/Editor/AvatarAudit.cs');
  const source = readFileSync(sourcePath, 'utf8');
  const guard = 'if (domains.Count == 0 && sources.Count == 0)';
  assert.ok(source.includes(guard), 'the production guard is not where this fixture expects it');
  const mutations: Array<[string, string, RegExp]> = [
    ['guard-removed', 'if (false)', /preserve route \(no declared position\) was counted as a deadlock/],
    ['guard-widened-to-unlocated', 'if (located.Count == 0)', /declared position whose source cannot be located must stay a failure/],
  ];
  for (const [name, replacement, message] of mutations) {
    writeFileSync(sourcePath, source.replace(guard, replacement));
    try {
      assert.throws(() => unity(name + '.log'), name);
      const failed = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
      assert.equal(failed.ok, false, name);
      assert.match(failed.error, message, name);
    } finally { writeFileSync(sourcePath, source); }
  }
});
