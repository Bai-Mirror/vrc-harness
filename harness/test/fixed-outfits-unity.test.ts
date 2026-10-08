import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor, unityFixtureRunDir } from './fixtures/unity-slot.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const options = { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 1800000 };
function integration(t: test.TestContext, fixture: string) {
  const root = mkdtempSync(join(tmpdir(), 'avh-plan-contract-'));
  t.after(() => { if (!process.env.AVH_PLAN_CONTRACT_KEEP_PROJECT) removeTemp(root); });
  console.log('Plan contract Unity evidence: ' + root);
  for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
  execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)', join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
  // BuildArtifact's full preprocessing chain includes VRCFury's always-on compressor hook.
  // Its temp package must be registered during initial import, before batch execution starts.
  mkdirSync(join(root, 'Packages/com.vrcfury.temp'), { recursive: true });
  writeFileSync(join(root, 'Packages/com.vrcfury.temp/package.json'), JSON.stringify({ name: 'com.vrcfury.temp', version: '0.0.0' }));
  writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
  for (const name of [fixture, 'RecolorMaterialIntegration']) copyFileSync(fileURLToPath(new URL(`./fixtures/unity/${name}.cs`, import.meta.url)), join(root, `Assets/Editor/${name}.cs`));
  const run = (name: string) => {
    rmSync(join(root, 'result.json'), { force: true });
    let error: unknown;
    try { execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root, '-executeMethod', `AVH.Harness.${fixture}.Run`, '-logFile', join(root, name + '.log')], { env: { ...process.env, AVH_PROJECT_DIR: root }, timeout: 600000, windowsHide: true, stdio: 'pipe' }); } catch (e) { error = e; }
    let result;
    try { result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')); } catch { assert.fail(String(error) + '\n' + readFileSync(join(root, name + '.log'), 'utf8').match(/.*(?:error CS|Exception|failed).*/g)?.slice(-12).join('\n')); }
    copyFileSync(join(root, 'result.json'), join(root, name + '.result.json'));
    return result as { ok: boolean; error?: string; assertions: number };
  };
  const result = run('positive'); assert.equal(result.ok, true, result.error); assert.ok(result.assertions > 0);
  console.log(`${fixture}: ${result.assertions} assertions`);
  return { root, run };
}
test('four fixed, four exclusive and mixed outfits survive actual production, build, regression and cold assertions', options, t => {
  const { root, run } = integration(t, 'FixedOutfitsIntegration');
  const path = join(root, 'Assets/_HarnessTools/Editor/RecolorStage.cs'); const source = readFileSync(path, 'utf8');
  const from = 'root.gameObject.SetActive(OutfitStage.Fixed(outfit) || outfit.Str("id") == exclusiveId);';
  assert.ok(source.includes(from));
  try { writeFileSync(path, source.replace(from, 'root.gameObject.SetActive(outfit.Str("id") == exclusiveId);')); const result = run('fixed-restore-mutant'); assert.equal(result.ok, false); assert.match(result.error!, /recolor activation mismatch/); }
  finally { writeFileSync(path, source); }
});
test('variant material mapping keeps a duplicate sibling renderer distinct from a Modular Avatar menu item', options, t => {
  const { root, run } = integration(t, 'FixedOutfitsIntegration');
  const path = join(root, 'Assets/_HarnessTools/Editor/OutfitStage.cs'); const source = readFileSync(path, 'utf8');
  const structural = 'var target = StructuralTarget(renderer.transform, source.transform, instance.transform);';
  assert.ok(source.includes(structural));
  try {
    writeFileSync(path, source.replace(structural,
      'var target = relative.Length == 0 ? instance.transform : AvatarAudit.Locate(instance.transform, relative);'));
    const result = run('duplicate-sibling-locate-mutant'); assert.equal(result.ok, false);
    assert.match(result.error!, /变体渲染器不能映射：Phone/);
  } finally { writeFileSync(path, source); }
});
test('variant materials recover unique names after deleting a preceding sibling', options, t => {
  const { root, run } = integration(t, 'FixedOutfitsIntegration');
  const path = join(root, 'Assets/_HarnessTools/Editor/OutfitStage.cs'); const source = readFileSync(path, 'utf8');
  const fallback = 'return useFind ? root.Find(row.Str("renderer")) : AvatarAudit.Locate(root, row.Str("renderer"));';
  assert.ok(source.includes(fallback));
  try {
    writeFileSync(path, source.replace(fallback, 'return null;'));
    const result = run('unique-sibling-no-fallback-mutant'); assert.equal(result.ok, false);
    assert.match(result.error!, /Unique-name material fallback failed after sibling deletion/);
  } finally { writeFileSync(path, source); }
});
test('second-layer eye adjustment and lash texture share the final slot copy alongside vendor material selection', options, t => {
  const { root, run } = integration(t, 'RecolorSameSlotIntegration');
  const out = join(root, 'observed.json');
  execFileSync('python3', [join(tools, 'observe_recolor.py'), '--out', out], { env: { ...process.env, AVH_PROJECT_DIR: root,
    AVH_RUN_DIR: unityFixtureRunDir(root, join(root, '_harness/manual-run')), AVH_TOOL_ROOT: join(tools, '..'), AVH_PLAN: readFileSync(join(root, 'fixture-plan.json'), 'utf8').trim() }, stdio: 'pipe' });
  const metrics = JSON.parse(readFileSync(out, 'utf8')).metrics;
  for (const name of ['material_write_conflicts', 'material_bindings_missing', 'material_plan_unverified']) assert.equal(metrics[name], 0, name);
  const path = join(root, 'Assets/_HarnessTools/Editor/RecolorStage.cs'); const source = readFileSync(path, 'utf8');
  const from = 'var layerCopy = copies.Values.FirstOrDefault(c => c.Material == source);'; assert.ok(source.includes(from));
  try { writeFileSync(path, source.replace(from, 'Copy layerCopy = null;')); const result = run('same-slot-mutant'); assert.equal(result.ok, false); assert.match(result.error!, /Final slot lost second-layer eye adjustment/); }
  finally { writeFileSync(path, source); }
});

test('recolor observes source shape baselines across independent Unity processes', options, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-recolor-shape-baseline-'));
  t.after(() => { if (!process.env.AVH_PLAN_CONTRACT_KEEP_PROJECT) removeTemp(root); });
  console.log('Recolor shape baseline Unity evidence: ' + root);
  for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
  execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)', join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
  mkdirSync(join(root, 'Packages/com.vrcfury.temp'), { recursive: true });
  writeFileSync(join(root, 'Packages/com.vrcfury.temp/package.json'), JSON.stringify({ name: 'com.vrcfury.temp', version: '0.0.0' }));
  writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
  for (const name of ['RecolorShapeBaselineIntegration', 'RecolorMaterialIntegration']) copyFileSync(fileURLToPath(new URL(`./fixtures/unity/${name}.cs`, import.meta.url)), join(root, `Assets/Editor/${name}.cs`));
  const run = (method: string, label: string) => {
    rmSync(join(root, 'result.json'), { force: true });
    execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root, '-executeMethod', `AVH.Harness.RecolorShapeBaselineIntegration.${method}`, '-logFile', join(root, label + '.log')], { env: { ...process.env, AVH_PROJECT_DIR: root }, timeout: 600000, windowsHide: true, stdio: 'pipe' });
    copyFileSync(join(root, 'result.json'), join(root, label + '.result.json'));
    return JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) as { ok: boolean; group_defaults_match?: boolean; notes?: string[] };
  };
  run('Prepare', 'prepare');
  const positive = run('Observe', 'positive');
  assert.equal(positive.ok, true);
  assert.equal(positive.group_defaults_match, true, JSON.stringify(positive));
  const installed = join(root, 'Assets/_HarnessTools/Editor/AvatarAudit.cs');
  const source = readFileSync(installed, 'utf8');
  const initialization = 'if (AvatarConfig.Grouped(plan)) SourceShapeAudit.CaptureSources(plan, record);';
  assert.ok(source.includes(initialization));
  try {
    writeFileSync(installed, source.replace(initialization, 'if (false) SourceShapeAudit.CaptureSources(plan, record);'));
    const negative = run('Observe', 'without-source-baseline');
    assert.equal(negative.ok, true);
    assert.equal(negative.group_defaults_match, false, JSON.stringify(negative));
    assert.ok(negative.notes?.some(note => note.includes('尚未完整读回')));
  } finally { writeFileSync(installed, source); }
});
