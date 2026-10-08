// D-138 integration: the real outfit stage measures the assembled default state on a synthetic avatar —
// visible-part inventory with sources, same-position contact area, vendor group evidence — writes
// visibility.json, honours recorded closures without relaxing the fixed check, and refuses an unjustified
// closure. Every mutation removes one production point and must make the same fixture fail.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor, unityFixtureRunDir } from './fixtures/unity-slot.ts';
import { parseObservation } from '../src/workflow/observe.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
/** This file drives the editor synchronously, so its backoff between launch attempts has to block too. */
const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const options = { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 3600000 };
function integration(t: test.TestContext, fixture: string) {
  const root = mkdtempSync(join(tmpdir(), 'avh-outfit-visibility-'));
  t.after(() => { if (!process.env.AVH_VISIBILITY_KEEP_PROJECT) removeTemp(root); });
  console.log('Outfit visibility Unity evidence: ' + root);
  for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
  execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)', join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
  mkdirSync(join(root, 'Packages/com.vrcfury.temp'), { recursive: true });
  writeFileSync(join(root, 'Packages/com.vrcfury.temp/package.json'), JSON.stringify({ name: 'com.vrcfury.temp', version: '0.0.0' }));
  writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
  for (const name of [fixture, 'RecolorMaterialIntegration']) copyFileSync(fileURLToPath(new URL(`./fixtures/unity/${name}.cs`, import.meta.url)), join(root, `Assets/Editor/${name}.cs`));
  const run = (name: string) => {
    rmSync(join(root, 'result.json'), { force: true });
    let error: unknown;
    // The account's licence client is a singleton: another editor holding it makes a launch exit 199 before
    // `-executeMethod` runs. Retry that instead of reading it as a verdict — the same guard the fit probe's
    // render-piercing fixture carries, needed now that this fixture launches a dozen editors in a row.
    for (let attempt = 1; ; attempt++) {
      try {
        error = undefined;
        execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root, '-executeMethod', `AVH.Harness.${fixture}.Run`, '-logFile', join(root, name + '.log')], { env: { ...process.env, AVH_PROJECT_DIR: root }, timeout: 900000, windowsHide: true, stdio: 'pipe' });
        break;
      } catch (e) {
        error = e;
        if ((e as { status?: number }).status !== 199 || attempt >= 12) break;
        console.log(`[unity] ${name}: exit 199 (another editor holds the account's licence client), retry ${attempt}/12 in 20s`);
        sleepSync(20_000);
      }
    }
    let result;
    try { result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')); } catch { assert.fail(String(error) + '\n' + readFileSync(join(root, name + '.log'), 'utf8').match(/.*(?:error CS|Exception|failed).*/g)?.slice(-12).join('\n')); }
    copyFileSync(join(root, 'result.json'), join(root, name + '.result.json'));
    return result as { ok: boolean; error?: string; assertions: number };
  };
  const installed = (name: string) => join(root, 'Assets/_HarnessTools/Editor', name);
  // D-143 reuses the fit probe's render confirmation, which lives in its own installed folder.
  const auditInstalled = (name: string) => join(root, 'Assets/_HarnessTools/AvatarAudit/Editor', name);
  const sources = join(fileURLToPath(new URL('../builtin/tools/', import.meta.url)), '审查/unity/Editor');
  const mutate = (name: string, before: string, after: string) => {
    const path = installed(name); const source = readFileSync(path, 'utf8');
    assert.ok(source.includes(before), `mutation anchor missing in ${name}: ${before}`);
    writeFileSync(path, source.replace(before, after));
  };
  const mutateRegex = (path: string, pattern: RegExp, after: string) => {
    const source = readFileSync(path, 'utf8');
    assert.ok(pattern.test(source), `mutation anchor missing in ${path}: ${pattern}`);
    writeFileSync(path, source.replace(pattern, after));
  };
  const restore = (name: string) => copyFileSync(join(tools, 'unity/Editor', name), installed(name));
  const restoreAudit = (name: string) => copyFileSync(join(sources, name), auditInstalled(name));
  const result = run('positive');
  assert.equal(result.ok, true, result.error); assert.ok(result.assertions > 0);
  console.log(`${fixture}: ${result.assertions} assertions`);
  // Reinstating the old path-keyed dictionary must make the duplicate-sibling scenario fail.
  mutate('OutfitVisibility.cs',
    'PartByPath(entries, notes), roles, hiddenByDecision ?? new List<object>(), decisions);',
    'entries.ToDictionary(entry => entry.Path, entry => entry.BodyPart, StringComparer.Ordinal),\n                roles, hiddenByDecision ?? new List<object>(), decisions);');
  const duplicateMutant = run('duplicate-path-mutant');
  assert.equal(duplicateMutant.ok, false);
  assert.match(duplicateMutant.error!, /重名渲染器|ArgumentException|可见性读数变成 no_data/);
  restore('OutfitVisibility.cs');
  return { root, run, mutate, restore, mutateRegex, installed, auditInstalled, restoreAudit };
}
test('the assembled default state lists visible parts, measures same-position overlap and honours recorded closures', options, t => {
  const { root, run, mutate, restore, mutateRegex, installed, auditInstalled, restoreAudit } = integration(t, 'OutfitVisibilityIntegration');
  // D-148 real path: the fixture wrote a recipe whose trade-off is one numbered item with executable options, a
  // recommendation and the option the recipe really used; the Runtime accepted it (the fixture's own assertions
  // passed) and the observation that run produced is readable by the Runtime's own parser.
  const runDir = unityFixtureRunDir(root, process.env.AVH_RUN_DIR);
  const observation = parseObservation(readFileSync(join(runDir, 'observations', 'clothing.install.json'), 'utf8'));
  assert.equal(observation.schema, 'observation/0.1');
  assert.equal(observation.metrics.local_operations_valid, true,
    'the observation of the run that accepted the numbered recipe must say so');
  assert.ok('visible_interpenetration_pairs' in observation.metrics,
    'the observation must carry the metric the blocking check reads');
  // Removing the band (counting every triangle of an AABB-intersecting pair) must resurrect the two honest
  // layers, so the epsilon measurement is the point that keeps them out.
  mutate('OutfitVisibility.cs', 'if (distance[i0] > EpsilonMm || distance[i1] > EpsilonMm || distance[i2] > EpsilonMm) continue;', 'if (EpsilonMm < 0f) continue;');
  const band = run('band-mutant'); assert.equal(band.ok, false); assert.match(band.error!, /对数不对|合理上下层|六对应达到最小量/);
  restore('OutfitVisibility.cs');
  // Widening the band to 1 mm swallows the 0.5 mm honest fit.
  mutate('OutfitVisibility.cs', 'public const float EpsilonMm = 0.1f;', 'public const float EpsilonMm = 1.0f;');
  const epsilon = run('epsilon-mutant'); assert.equal(epsilon.ok, false); assert.match(epsilon.error!, /对数不对|合理上下层|六对应达到最小量/);
  restore('OutfitVisibility.cs');
  // Counting the body skin turns the garment lying on the body into an overlap.
  mutate('OutfitVisibility.cs', 'entry.BodySkin = bodyNames.Contains(renderer.gameObject.name) && !InAssemblyLayer(entry.Path);', 'entry.BodySkin = false;');
  const skin = run('body-skin-mutant'); assert.equal(skin.ok, false); assert.match(skin.error!, /对数不对|素体皮肤|六对应达到最小量/);
  restore('OutfitVisibility.cs');
  // Not deducting the recorded closures makes the fixed check report the parts the executor decided on.
  mutate('OutfitStage.cs', 'OutfitPerf.Time("DeductRecordedClosures", () => OutfitMeasure.DeductRecordedClosures(records, LocalOperations.RecordedClosures(operations)))', 'OutfitPerf.Time("DeductRecordedClosures", () => new List<object>())');
  const deduction = run('deduction-mutant'); assert.equal(deduction.ok, false); assert.match(deduction.error!, /记录在案|固定件|这条关闭应带理由/);
  restore('OutfitStage.cs');
  // Dropping user_review from the recipe's top-level fields rejects the executor's review list.
  mutate('LocalOperations.cs', 'input.Keys.Except(new[] { "schema", "observation_sha256", "operations", "user_review", "interpenetration_decisions" }).Any()', 'input.Keys.Except(new[] { "schema", "observation_sha256", "operations", "interpenetration_decisions" }).Any()');
  const review = run('user-review-mutant'); assert.equal(review.ok, false); assert.match(review.error!, /user_review|字段无效/);
  restore('LocalOperations.cs');
  // Dropping the rationale requirement lets a part disappear with no stated reason.
  mutate('LocalOperations.cs', 'var rationale = op.Str("rationale");\n                    if (string.IsNullOrWhiteSpace(rationale)) throw new Exception("局部对象状态必须写明 rationale");\n                    if (rationale.Length > 8192) throw new Exception("局部对象状态 rationale 过长");', 'var rationale = op.Str("rationale") ?? "";');
  const rationale = run('rationale-mutant'); assert.equal(rationale.ok, false); assert.match(rationale.error!, /rationale/);
  restore('LocalOperations.cs');
  // D-143: the inner/outer order is what makes a poke a poke. Forcing the first-listed part to be the inner
  // layer counts the belt worn outside the coat and the fully covered skirt as interpenetrations.
  mutate('OutfitVisibility.cs',
    '            var forwardInner = forwardBand > 0 && (double)forward.Inside / forwardBand >= InnerMajorityRatio\n'
    + '                && forwardScore > 0 && forwardScore >= backwardScore;\n'
    + '            var backwardInner = backwardBand > 0 && (double)backward.Inside / backwardBand >= InnerMajorityRatio\n'
    + '                && backwardScore > 0 && backwardScore > forwardScore;',
    '            var forwardInner = forwardBand > 0;\n            var backwardInner = false;');
  const layerOrder = run('layer-order-mutant'); assert.equal(layerOrder.ok, false);
  assert.match(layerOrder.error!, /六对应达到最小量|①的外层应是外套|①的确认顶点数应达到最小量|最大确认量应是各确认对里最大的确认顶点数|⑩成片穿出应越护栏/);
  restore('OutfitVisibility.cs');
  // D-143: "with the inner layer off the OUTER one shows there" is dropped: anything visible counts, so a poke
  // that opens onto a lining is confirmed.
  mutateRegex(auditInstalled('FitRenderConfirm.cs'),
    /bool garmentVisible = idCut != 0 && pathById\(paths, idCut, out cutPath\)\r?\n\s+&& string\.Equals\(cutPath, candidate\.Garment, StringComparison\.Ordinal\);/,
    'bool garmentVisible = idCut != 0;');
  const identity = run('garment-identity-mutant'); assert.equal(identity.ok, false);
  assert.match(identity.error!, /⑤关掉里层后露出的是别的件|六对应达到最小量/);
  restoreAudit('FitRenderConfirm.cs');
  // D-143: the depth check is dropped, so a poke shadowed by a nearer surface of its OWN layer is confirmed.
  mutateRegex(auditInstalled('FitRenderConfirm.cs'),
    /bool depthMatched = bodyFrontmost && frontDepth > 0f\r?\n\s+&& Math\.Abs\(frontDepth - eyeDepth\) \* 1000f <= options\.DepthToleranceMm;/,
    'bool depthMatched = bodyFrontmost;');
  const depth = run('depth-mutant'); assert.equal(depth.ok, false);
  assert.match(depth.error!, /⑥同一件的更近表面占着像素|六对应达到最小量/);
  restoreAudit('FitRenderConfirm.cs');
  // D-143: dropping the calibrated minimum admits the seam where one cell pokes out.
  mutateRegex(installed('OutfitVisibility.cs'),
    /MinVisibleInterpenetrationVertices = \d+;/, 'MinVisibleInterpenetrationVertices = 0;');
  const minimum = run('minimum-mutant'); assert.equal(minimum.ok, false);
  assert.match(minimum.error!, /六对应达到最小量|④缝线处应被提出/);
  restore('OutfitVisibility.cs');
  // D-143 ③: without the body-part classification every part lands in "其他" and the ears stop sharing a part.
  mutate('OutfitVisibility.cs', 'entry.BodyPart = BodyPart(renderer, parts, (entry.Min + entry.Max) * 0.5f, entry.Min != entry.Max);', 'entry.BodyPart = UnknownPart;');
  const parts = run('body-part-mutant'); assert.equal(parts.ok, false);
  assert.match(parts.error!, /应归到「头」|按身体部位的摘要里应有「头」一节/);
  restore('OutfitVisibility.cs');
  // D-143 ③: a decision the recipe does not carry must leave the pair counted; ignoring that lets every undecided
  // pair pass the gate silently.
  mutateRegex(installed('OutfitVisibility.cs'), /pair\.Counted = true;\n/, 'pair.Counted = false;\n');
  const undecided = run('undecided-mutant'); assert.equal(undecided.ok, false);
  assert.match(undecided.error!, /没有决定时 6 对都应按未决定计入阻断|阻断计数应是未决定的 6 对|①里层裙子顶出外套应被计入/);
  restore('OutfitVisibility.cs');
  // D-143 ③: the guard rails are what stops a broad, deep interpenetration from being accepted as a judgement call.
  mutate('OutfitVisibility.cs', 'if (pair.OutOfBounds)\n                return $"决定写了 accept，但这一对超出护栏', 'if (false)\n                return $"决定写了 accept，但这一对超出护栏');
  const guard = run('guard-mutant'); assert.equal(guard.ok, false);
  assert.match(guard.error!, /越界却被 accept 的两对必须阻断|⑩的 accept 应因越界而不生效/);
  restore('OutfitVisibility.cs');
  // GI2: the depth gate. A pair whose deepest sample only reaches the instrument's range has no measured depth,
  // so its `accept` must not take effect. Removing just that clause must break the fixture; the vertex guard and
  // every measurement/decision path stay in place, so only the depth gate is under test.
  mutateRegex(installed('OutfitVisibility.cs'),
    / \|\| pair\.DepthAtLeast\r?\n\s+/, '');
  const depthGuard = run('depth-guard-mutant'); assert.equal(depthGuard.ok, false);
  assert.match(depthGuard.error!, /⑪深度只到量程上界|⑪的 accept 应因深度只到量程上界/);
  restore('OutfitVisibility.cs');
  // D-148: a trade-off handed to the user is refused unless it is a numbered item with 2–4 executable options,
  // one recommendation, a current option that is what the recipe did, and an observation-bound object. Each
  // mutation removes exactly one of those rules, and the fixture's own refusal case must then stop refusing.
  mutate('LocalOperations.cs', 'if (options.Count < 2 || options.Count > 4)', 'if (false)');
  const optionCount = run('trade-off-count-mutant'); assert.equal(optionCount.ok, false);
  assert.match(optionCount.error!, /方案只有 1 个 应被拒|方案超过 4 个 应被拒/);
  restore('LocalOperations.cs');
  mutate('LocalOperations.cs', 'if (recommended == null || !optionIds.Contains(recommended))', 'if (false)');
  const recommended = run('trade-off-recommended-mutant'); assert.equal(recommended.ok, false);
  assert.match(recommended.error!, /推荐不止一个 应被拒|推荐不在方案里 应被拒/);
  restore('LocalOperations.cs');
  mutate('LocalOperations.cs', 'if (!observed.Contains(path))', 'if (false)');
  const unobserved = run('trade-off-object-mutant'); assert.equal(unobserved.ok, false);
  assert.match(unobserved.error!, /方案引用的对象不在观察内 应被拒/);
  restore('LocalOperations.cs');
  mutate('LocalOperations.cs', 'if (operation == null || !Recoverable(operation))', 'if (operation == null)');
  const permanent = run('trade-off-permanent-mutant'); assert.equal(permanent.ok, false);
  assert.match(permanent.error!, /方案里用了不可恢复的操作 应被拒/);
  restore('LocalOperations.cs');
  mutate('LocalOperations.cs', 'if (chosen.ContainsKey(pair.Key) && operation == null)', 'if (false)');
  const drift = run('trade-off-current-mutant'); assert.equal(drift.ok, false);
  assert.match(drift.error!, /当前方案与配方实际生效的操作不符 应被拒/);
  restore('LocalOperations.cs');
  // D-148 ①: an `ask_user` pair without a number has no options a rework feedback could name.
  mutate('LocalOperations.cs', 'if (review == null || !known.Contains(review))', 'if (false)');
  const unnumbered = run('trade-off-number-mutant'); assert.equal(unnumbered.ok, false);
  assert.match(unnumbered.error!, /ask_user 没写编号 应被拒|ask_user 的编号不存在 应被拒/);
  restore('LocalOperations.cs');
  // D-149: the role a source has in the order is what lets an accessory set yield to the main clothing; dropping
  // it from the by-body-part evidence leaves the criterion with nothing to read.
  mutate('OutfitVisibility.cs', '["role"] = RoleOf(roles, group.First().Path),', '');
  const role = run('part-role-mutant'); assert.equal(role.ok, false);
  assert.match(role.error!, /每个来源都要写出它在订单里的角色|都应读作 outfit/);
  restore('OutfitVisibility.cs');
  // The dependency-observation order is NOT mutated here: the synthetic fixture restores every material and both
  // walks read 0, so moving the call would survive this suite. That invariant is pinned by the source-level
  // mutation in outfit-visible-overlaps.test.ts instead (see ScenarioDependencyOrder's own note).
});
