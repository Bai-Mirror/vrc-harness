import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { evaluateRule, parseRule } from '../src/process/rule.ts';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor } from './fixtures/unity-slot.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const knowledge = fileURLToPath(new URL('../builtin/knowledge/process/', import.meta.url));
const rule = 'key_follow_value_delta_max <= t.key_follow_mismatch or key_follow_geometry_p95_mm < t.key_follow_p95_mm';
type FixtureReading = { id: string; value_delta: number | null; geometry_p95_mm: number | null };
type FixtureResult = { ok: boolean; error?: string; cases: FixtureReading[] };

test('RegressionStage measures every over-threshold key-follow pair in its actual state', {
  skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 1800000
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-key-follow-geometry-'));
  t.after(() => { if (!process.env.AVH_KEY_FOLLOW_KEEP_PROJECT) removeTemp(root); });
  console.log('Key-follow geometry evidence: ' + root);
  for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
  execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',
    join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
  writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})',
    tools, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
  for (const name of ['KeyFollowGeometryIntegration', 'RecolorMaterialIntegration'])
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/' + name + '.cs', import.meta.url)), join(root, 'Assets/Editor/' + name + '.cs'));
  const unity = (log: string, extraEnv: Record<string, string> = {}) => execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root,
    '-executeMethod', 'AVH.Harness.KeyFollowGeometryIntegration.Run', '-logFile', join(root, log)],
    { env: { ...process.env, ...extraEnv, AVH_PROJECT_DIR: root, AVH_PLAN: '{}' }, timeout: 1200000, windowsHide: true, stdio: 'pipe' });
  const run = (log: string, allowFailure = false, extraEnv: Record<string, string> = {}) => {
    const resultPath = join(root, 'result.json');
    if (existsSync(resultPath)) unlinkSync(resultPath);
    try { unity(log, extraEnv); } catch (error) {
      if (allowFailure && existsSync(resultPath)) {
        copyFileSync(resultPath, join(root, log + '.result.json'));
        return JSON.parse(readFileSync(resultPath, 'utf8')) as FixtureResult;
      }
      assert.fail(String(error) + '\n' + readFileSync(join(root, log), 'utf8').match(/.*(?:error CS|Exception|failed).*/g)?.slice(-12).join('\n'));
    }
    copyFileSync(resultPath, join(root, log + '.result.json'));
    return JSON.parse(readFileSync(resultPath, 'utf8')) as FixtureResult;
  };
  const result = run('unity.log');
  assert.equal(result.ok, true, result.error);
  const pack = readFileSync(join(knowledge, 'pc-recolor-outfit.process.yaml'), 'utf8');
  assert.ok(pack.includes('rule: "' + rule + '"'), 'the process rule text moved');
  const thresholdFile = readFileSync(join(knowledge, 'thresholds.yaml'), 'utf8');
  const threshold = (name: string): number => Number(new RegExp('\\n  ' + name + ':\\n    value: ([0-9.]+)').exec(thresholdFile)![1]);
  const thresholds = { key_follow_mismatch: threshold('key_follow_mismatch'), key_follow_p95_mm: threshold('key_follow_p95_mm') };
  const cases = new Map(result.cases.map(entry => [entry.id, entry]));
  const verdict = (reading: FixtureReading) => evaluateRule(parseRule(rule), {
      key_follow_value_delta_max: reading.value_delta,
      key_follow_geometry_p95_mm: reading.geometry_p95_mm
    }, thresholds);
  const outcome = (id: string) => verdict(cases.get(id)!);
  assert.equal(outcome('no-driver').result, 'violation', JSON.stringify(outcome('no-driver')));
  assert.equal(outcome('body-selection').result, 'violation', JSON.stringify(outcome('body-selection')));
  assert.equal(outcome('multi').result, 'violation', JSON.stringify(outcome('multi')));
  assert.equal(outcome('mixed-failure').result, 'violation', JSON.stringify(outcome('mixed-failure')));
  assert.equal(outcome('geometric-pass').result, 'pass', JSON.stringify(outcome('geometric-pass')));
  assert.equal(outcome('endpoint-failure').result, 'no_data', JSON.stringify(outcome('endpoint-failure')));
  assert.equal(cases.get('endpoint-failure')!.geometry_p95_mm, null, 'an endpoint bake failure must preserve a null geometry metric');
  assert.equal(cases.get('body-unknown')!.value_delta, null, 'an unidentifiable body must preserve a null value-delta metric');
  assert.equal(cases.get('body-unknown')!.geometry_p95_mm, null, 'an unidentifiable body must preserve a null geometry metric');
  assert.equal(outcome('body-unknown').result, 'no_data', JSON.stringify(outcome('body-unknown')));
  assert.equal(outcome('piece-failure').result, 'no_data', JSON.stringify(outcome('piece-failure')));
  assert.equal(outcome('within-threshold').result, 'pass', JSON.stringify(outcome('within-threshold')));

  const editor = (name: string) => join(root, 'Assets/_HarnessTools/Editor', name);
  const audit = (name: string) => join(root, 'Assets/_HarnessTools/AvatarAudit/Editor', name);
  const mutations: Array<[string, string, string, string, RegExp]> = [
    ['geometry-null', 'RegressionStage.cs', '? Math.Round(keyGeometryWorst, 3) : null;', '? null : null;',
      /no-driver|multi|geometric/],
    ['geometry-zeroed', 'RegressionStage.cs', 'keyGeometryWorst = Math.Max(keyGeometryWorst, reading.P95DeltaMm);', 'keyGeometryWorst = 0d;',
      /no-driver|multi|geometric/],
    ['largest-pair-only', 'RegressionStage.cs', '.Where(pair => pair.Delta > 5f).ToList();', '.Where(pair => pair.Delta > 5f).Take(1).ToList();',
      /all over-threshold|non-maximum|multi/],
    ['body-all-outfit-exclusion', 'RegressionStage.cs', 'return global::AvatarAudit.AuditPartInventory.FindBodyForRegression(avatar, candidates, BodyIdentity());',
      'return avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(s => s.sharedMesh != null).OrderByDescending(s => s.sharedMesh.blendShapeCount).FirstOrDefault();', /body selector|body-selection|value/],
    ['body-identity-ignored', 'AuditPartInventory.cs', 'var parts = AuditBodyPick.SelectBodyParts(candidates, knownBodyNames);',
      'var parts = new List<SkinnedMeshRenderer>();', /identity must select the base body/],
    ['body-unknown-zeroed', 'RegressionStage.cs', 'object keyDeltaMetric = keyPairUnknown ? null : (object)Math.Round(keyDelta, 3);',
      'object keyDeltaMetric = (object)Math.Round(keyDelta, 3);', /body-unknown|value/],
    ['partial-coverage-hidden', 'RegressionStage.cs', 'if (keyGeometry == null || keyGeometryUnknown)', 'if (keyGeometry == null)',
      /coverage|failed pair|未完成/],
    ['unmeasurable-zeroed', 'AuditPartInventory.cs', 'if (bodyGeometry == null || !bodyGeometry.HasKey || bodyGeometry.Bvh0 == null || bodyGeometry.Bvh100 == null)\n                { result.Note = "身体键两端烘焙或 BVH 失败"; return result; }',
      'if (bodyGeometry == null || !bodyGeometry.HasKey || bodyGeometry.Bvh0 == null || bodyGeometry.Bvh100 == null)\n                { result.Available = true; result.P95DeltaMm = 0d; return result; }', /endpoint-failure|no_data/],
  ];
  for (const [name, file, from, to, message] of mutations) {
    const path = file === 'AuditPartInventory.cs' ? audit(file) : editor(file);
    const source = readFileSync(path, 'utf8');
    assert.ok(source.includes(from), name + ': production text not found');
    try {
      writeFileSync(path, source.replace(from, to));
      const mutant = run(name + '.log', true);
      assert.equal(mutant.ok, false, name + ' must fail its regression assertions');
      assert.match(mutant.error || '', message, name);
      console.log('Killed mutation: ' + name);
    } finally { writeFileSync(path, source); }
  }

  const path = audit('AuditPartInventory.cs');
  const source = readFileSync(path, 'utf8');
  const endpointGuard = `if (!TrySnapshotAtWeight(body, key, 0f, out v0, out t0)
                || !TrySnapshotAtWeight(body, key, 100f, out v100, out t100)
                || v0 == null || v100 == null || v0.Length == 0 || v0.Length != v100.Length
                || t0 == null || t0.Length < 3 || t100 == null || t100.Length < 3)
                return bg;`;
  const currentSnapshotFallback = `if (!TrySnapshotAtWeight(body, key, 0f, out v0, out t0)) return bg;
            if (!TrySnapshotAtWeight(body, key, 100f, out v100, out t100))
            {
                string snapshotSource;
                if (!TrySnapshot(body, out v0, out t0, out snapshotSource)) return bg;
                v100 = v0; t100 = t0;
            }`;
  const failures: Array<[string, string, string, string, string]> = [
    ['second-endpoint-fallback', 'smr.SetBlendShapeWeight(idx, weight);\n                smr.BakeMesh(scratch, true);',
      'smr.SetBlendShapeWeight(idx, weight);\n                if (weight == 100f) throw new Exception("Injected second endpoint failure");\n                smr.BakeMesh(scratch, true);',
      endpointGuard, currentSnapshotFallback],
    ['bvh-zero-fallback', 'try { bg.Bvh0 = new AuditProbes.PokeBvh(w0, t0, faces0); }',
      'try { throw new Exception("Injected BVH0 failure"); }',
      'catch { bg.Bvh0 = null; }', 'catch { bg.Bvh0 = new AuditProbes.PokeBvh(w0, t0, faces0); }'],
    ['endpoint-bvh-reused', 'try { bg.Bvh100 = new AuditProbes.PokeBvh(w100, t100, faces100); }',
      'try { throw new Exception("Injected BVH100 failure"); }',
      'catch { bg.Bvh100 = null; }', 'catch { bg.Bvh100 = bg.Bvh0; }'],
  ];
  for (const [name, injectFrom, injectTo, revertFrom, revertTo] of failures) {
    assert.ok(source.includes(injectFrom), name + ': failure injection text not found');
    const injected = source.replace(injectFrom, injectTo);
    assert.ok(injected.includes(revertFrom), name + ': fallback text not found');
    const env = { AVH_KEY_FOLLOW_FAILURE_CASE: name };
    try {
      writeFileSync(path, injected);
      const baseline = run(name + '.injected.log', false, env);
      assert.equal(baseline.ok, true, baseline.error);
      const reading = baseline.cases.find(entry => entry.id === name)!;
      assert.ok(reading, name + ': independent failure case missing');
      assert.equal(reading.geometry_p95_mm, null, name + ': unavailable geometry must remain null');
      assert.equal(verdict(reading).result, 'no_data', name + ': formal rule must report no_data');
      console.log('Failure injection passed: ' + name + ' -> null / no_data');
      writeFileSync(path, injected.replace(revertFrom, revertTo));
      const mutant = run(name + '.log', true, env);
      assert.equal(mutant.ok, false, name + ': old fallback must fail under the same injection');
      assert.match(mutant.error || '', new RegExp(name + ': failed endpoint/BVH must preserve null geometry'), name);
      console.log('Killed mutation: ' + name);
    } finally { writeFileSync(path, source); }
  }
});
