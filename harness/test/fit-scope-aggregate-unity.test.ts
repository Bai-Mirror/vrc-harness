import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor } from './fixtures/unity-slot.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));

// A garment whose coverage scope the probe had to cancel carries no pierce count; the fit stage must report it as
// unmeasured instead of summing a coerced zero. This runs the real aggregate the stage calls, in its own assembly.
test('the fit stage never reads an unmeasured garment as a clean one',
  { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 2_400_000 }, t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-fit-scope-')); t.after(() => removeTemp(root));
    for (const dir of ['Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
    execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',
      join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
    writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
    execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/FitScopeAggregateIntegration.cs', import.meta.url)),
      join(root, 'Assets/_HarnessTools/Editor/FitScopeAggregateIntegration.cs'));
    let launchError: unknown;
    try {
      execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-nographics', '-projectPath', root, '-executeMethod',
        'AVH.Harness.FitScopeAggregateIntegration.Run', '-logFile', join(root, 'unity.log')],
        { env: { ...process.env, AVH_PROJECT_DIR: root }, timeout: 2_100_000, windowsHide: true, stdio: 'pipe' });
    } catch (error) { launchError = error; }
    if (process.env.AVH_LOCAL_UNITY_EVIDENCE) {
      const evidence = join(process.env.AVH_LOCAL_UNITY_EVIDENCE, `attempt-${Date.now()}`);
      mkdirSync(evidence, { recursive: true });
      for (const name of ['result.json', 'unity.log']) if (existsSync(join(root, name))) copyFileSync(join(root, name), join(evidence, name));
      writeFileSync(join(evidence, 'sources.json'), JSON.stringify({ editor: '2022.3.22f1', fullSdk: true }, null, 2));
    }
    const log = join(root, 'unity.log');
    assert.ok(existsSync(join(root, 'result.json')),
      `${launchError ? String(launchError).slice(0, 500) : 'the editor produced no report'}; `
      + (existsSync(log) ? readFileSync(log, 'utf8').match(/.*(?:error CS|Exception|Aborting batchmode).*/g)?.slice(-8).join('\n') ?? '' : 'no log'));
    const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.assertions, 9);
  });
