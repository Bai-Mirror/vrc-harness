import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor, unityFixtureRunDir } from './fixtures/unity-slot.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));

test('real Unity material selection expands thin variants, refuses zero/conflicts and survives independent observation',
  { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 1200000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-target-'));
  t.after(() => { if (!process.env.AVH_MATERIAL_KEEP_PROJECT) removeTemp(root); });
  console.log('Material integration evidence: ' + root);
  for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
  execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',
    join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
  writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
  copyFileSync(fileURLToPath(new URL('./fixtures/unity/RecolorMaterialIntegration.cs', import.meta.url)), join(root, 'Assets/Editor/RecolorMaterialIntegration.cs'));
  const unity = (log: string, method = 'Run', extraEnv: Record<string, string> = {}) => execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root,
    '-executeMethod', 'AVH.Harness.RecolorMaterialIntegration.' + method, '-logFile', join(root, log)],
    { env: { ...process.env, AVH_PROJECT_DIR: root, ...extraEnv }, timeout: 330000, windowsHide: true, stdio: 'pipe' });
  try { unity('unity.log'); } catch (error) {
    assert.fail(String(error) + '\n' + readFileSync(join(root, 'unity.log'), 'utf8').match(/.*(?:error CS|Exception|failed).*/g)?.slice(-10).join('\n'));
  }
  const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
  assert.equal(result.ok, true, result.error); assert.equal(result.assertions, 20);
  const plan = { recolor: { targets: [{ requirement_id: 'bag_pink', outfit: 'winter', material: 'Assets/Authorized/Vendor/Bag/Pink.mat' }], candidates: 1 } };
  // Keep the exact authorized plan serialization used by the Unity fixture.
  // The run directory is the one the editor actually wrote: the Windows fixture launcher rebinds AVH_RUN_DIR to its
  // own directory inside the project, so reading the caller's value there finds nothing.
  const runDir = unityFixtureRunDir(root, join(root, '_harness/manual-run'));
  const reportPath = join(runDir, 'observations/material-selection-readback.json');
  const envPlan = '{"recolor":{"targets":[{"requirement_id":"bag_pink","outfit":"winter","material":"Assets/Authorized/Vendor/Bag/Pink.mat"}],"candidates":1}}';
  const observe = () => {
    const out = join(root, 'observation.json');
    execFileSync('python3', [join(tools, 'observe_recolor.py'), '--out', out], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1',
      AVH_PROJECT_DIR: root, AVH_RUN_DIR: runDir, AVH_TOOL_ROOT: join(tools, '..'), AVH_PLAN: envPlan }, stdio: 'pipe' });
    return JSON.parse(readFileSync(out, 'utf8')).metrics;
  };
  assert.ok(existsSync(reportPath));
  assert.equal(JSON.parse(envPlan).recolor.targets[0].material, plan.recolor.targets[0]!.material);
  const metrics = observe();
  for (const name of ['material_plan_unverified', 'material_bindings_missing', 'material_write_conflicts',
    'unmapped_color_requirements', 'recolor_materials_shared_by_multiple_meshes', 'recolor_materials_outside_own_dir']) assert.equal(metrics[name], 0, name);
  assert.equal(metrics.replaced_material_slots, 3); assert.equal(metrics.recolor_ledger_rows, 3);
  unity('tampered-binding.log', 'Tamper', { AVH_PLAN: envPlan });
  const tampered = observe();
  assert.equal(tampered.material_bindings_missing, 1);
  assert.equal(tampered.unmapped_color_requirements, 1);

  // Mutation runs compile the modified production code in this isolated project. Each anchor is pinned to the current
  // source: the conflict guard became a three-element key (renderer, slot, scope) when independent menu groups landed,
  // and this entry still named the two-element dictionary lookup, so the loop stopped here instead of mutating.
  const sourcePath = join(root, 'Assets/_HarnessTools/Editor/RecolorStage.cs'), source = readFileSync(sourcePath, 'utf8');
  const mutations = [
    ['selection-removed', 'materials[slot] = selection.Material;', 'materials[slot] = source;'],
    ['zero-guard-removed', 'if (slots.Count == 0) throw new Exception', 'if (false) throw new Exception'],
    ['conflict-guard-removed', 'if (collision.Value != null)', 'if (collision.Value != null && false)'],
  ];
  for (const [name, from, to] of mutations) {
    assert.ok(source.includes(from!), name + ': the mutation anchor is stale, the production source moved under it');
    let mutant = source.replace(from!, to!);
    // With the refusal gone the second claim of a slot must overwrite rather than throw on the duplicate key, or the
    // editor would still fail — with a different message, and the mutation would look detected for the wrong reason.
    if (name === 'conflict-guard-removed') mutant = mutant.replace('claimed.Add((renderer, slot, scope), writer);', 'claimed[(renderer, slot, scope)] = writer;');
    writeFileSync(sourcePath, mutant);
    try {
      assert.throws(() => unity(name + '.log'), name);
      const failed = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
      assert.equal(failed.ok, false, name);
      assert.match(failed.error, name === 'selection-removed' ? /Not all same-directory slots replaced/ : /Expected refusal/, name);
    } finally { writeFileSync(sourcePath, source); }
  }
});
