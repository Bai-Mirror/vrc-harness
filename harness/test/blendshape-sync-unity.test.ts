// D-139 ② integration: assembly gives a garment that carries the body's same-name shape key but has no driver
// of its own an MA BlendshapeSync pointing at the body mesh that carries the key, the full NDMF build then
// makes the garment's key actually equal the body's, a garment with its own sync is not duplicated, and a key
// nobody writes is left alone. Every mutation removes one production point and must make the same fixture fail.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor } from './fixtures/unity-slot.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const options = { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 3600000 };
function integration(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-blendshape-sync-'));
  t.after(() => { if (!process.env.AVH_BLENDSHAPE_KEEP_PROJECT) removeTemp(root); });
  console.log('Blendshape sync Unity evidence: ' + root);
  for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
  execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)', join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
  mkdirSync(join(root, 'Packages/com.vrcfury.temp'), { recursive: true });
  writeFileSync(join(root, 'Packages/com.vrcfury.temp/package.json'), JSON.stringify({ name: 'com.vrcfury.temp', version: '0.0.0' }));
  writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
  for (const name of ['BlendshapeSyncIntegration', 'RecolorMaterialIntegration'])
    copyFileSync(fileURLToPath(new URL(`./fixtures/unity/${name}.cs`, import.meta.url)), join(root, `Assets/Editor/${name}.cs`));
  const run = (name: string) => {
    rmSync(join(root, 'result.json'), { force: true });
    let error: unknown;
    try { execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root, '-executeMethod',
      'AVH.Harness.BlendshapeSyncIntegration.Run', '-logFile', join(root, name + '.log')],
      { env: { ...process.env, AVH_PROJECT_DIR: root }, timeout: 1800000, windowsHide: true, stdio: 'pipe' }); } catch (e) { error = e; }
    let result;
    try { result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')); } catch { assert.fail(String(error) + '\n' + readFileSync(join(root, name + '.log'), 'utf8').match(/.*(?:error CS|Exception|failed).*/g)?.slice(-12).join('\n')); }
    return result as { ok: boolean; error?: string; assertions: number };
  };
  const installed = (name: string) => join(root, 'Assets/_HarnessTools/Editor', name);
  const mutate = (name: string, before: string, after: string) => {
    const path = installed(name); const source = readFileSync(path, 'utf8');
    assert.ok(source.includes(before), `mutation anchor missing in ${name}: ${before}`);
    writeFileSync(path, source.replace(before, after));
  };
  const restore = (name: string) => copyFileSync(join(tools, 'unity/Editor', name), installed(name));
  const result = run('positive');
  assert.equal(result.ok, true, result.error); assert.ok(result.assertions > 0);
  console.log(`BlendshapeSyncIntegration: ${result.assertions} assertions`);
  return { run, mutate, restore };
}
test('assembly binds a body same-name shape key to a garment that has no driver, and the built avatar follows it', options, t => {
  const { run, mutate, restore } = integration(t);
  // Removing the pass must leave the stocking at the vendor default: no binding in the artifact, no follow
  // after the build.
  mutate('OutfitStage.cs', 'var shapeKeySync = OutfitPerf.Time("SyncBodyShapeKeys", () => SyncBodyShapeKeys(avatar, bodyPath));',
    'var shapeKeySync = OutfitPerf.Time("SyncBodyShapeKeys", () => new Dictionary<string, object> { ["added"] = new List<object>(), ["skipped"] = new List<object>(), ["body_meshes"] = new List<object>(), ["notes"] = new List<object>(), ["count"] = 0 });');
  const none = run('no-sync-mutant'); assert.equal(none.ok, false); assert.match(none.error!, /形态键同步|跟随的网格|Foot_highheels/);
  restore('OutfitStage.cs');
  // Binding the first body mesh instead of the one that carries the key must be caught by both the reference
  // readback and the built value.
  mutate('OutfitStage.cs', 'ReferenceMesh = BodyReference(avatar, writer.Mesh)',
    'ReferenceMesh = BodyReference(avatar, body[0])');
  const wrong = run('wrong-reference-mutant'); assert.equal(wrong.ok, false); assert.match(wrong.error!, /跟随|绑定|Foot_highheels/);
  restore('OutfitStage.cs');
  // Ignoring the garment's own BlendshapeSync makes the pass add a second binding for a key that is already
  // driven.
  mutate('OutfitStage.cs', 'if (sync?.Bindings != null) foreach (var binding in sync.Bindings) driven.Add(LocalKey(binding));',
    'if (sync?.Bindings != null) foreach (var binding in new List<BlendshapeBinding>()) driven.Add(LocalKey(binding));');
  const duplicate = run('duplicate-mutant'); assert.equal(duplicate.ok, false); assert.match(duplicate.error!, /重复补|追加绑定|绑定/);
  restore('OutfitStage.cs');
  // Removing the reload's reproduction of the pass must make the independent reload reject the artifact the
  // assembly just wrote — the assertion that covers the Verify half of the change.
  mutate('LocalOperations.cs', 'OutfitStage.SyncBodyShapeKeys(expected, AssetDatabase.GetAssetPath(body));',
    '/* the reload does not reproduce the shape-key sync pass */');
  const reload = run('reload-mutant'); assert.equal(reload.ok, false); assert.match(reload.error!, /独立重载|local_operations_valid/);
  restore('LocalOperations.cs');
  // Dropping the "the renderer is the outfit root" half of the per-outfit filter must empty that outfit's
  // declared rows and fail the record assertion.
  mutate('OutfitStage.cs', '=> row.Str("renderer") == root', '=> false && row.Str("renderer") == root');
  const rootRow = run('root-row-mutant'); assert.equal(rootRow.ok, false); assert.match(rootRow.error!, /装配记录/);
  restore('OutfitStage.cs');
});
