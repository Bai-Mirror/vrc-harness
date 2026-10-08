import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { bundledPackInfo, installBundledPack, managedPacks } from '../src/managed-pack.ts';
import { loadProcess } from '../src/process/load.ts';
import { evaluateRule, parseRule } from '../src/process/rule.ts';
import { removeTemp } from './fixtures/platform.ts';

test('bundled knowledge and tools install as immutable, selectable versions', t => {
  const home = mkdtempSync(join(tmpdir(), 'avh-managed-pack-'));
  t.after(() => removeTemp(home));
  const installed = installBundledPack(home);
  const info = bundledPackInfo()!;
  assert.equal(installed.info.id, info.id);
  assert.match(readFileSync(join(installed.knowledgeRoot, 'context/plan-avatar-v1.md'), 'utf8'), /Harness 收权边界/);
  const capabilities = parse(readFileSync(join(installed.knowledgeRoot, 'process/pc-recolor-outfit.capabilities.yaml'), 'utf8')) as
    { stages: Record<string, { mode: string; context?: Array<string | { path: string }>; agentTools?: Record<string, string[]>; prepareCommand?:string[]; maxCheckRetries?:number }> };
  assert.deepEqual(['plan', 'setup', 'outfit', 'recolor', 'menu', 'regression_pre', 'optimize', 'regression', 'package']
    .filter(id => capabilities.stages[id]?.mode === 'provider'),
    ['plan', 'setup', 'outfit', 'recolor', 'menu', 'regression_pre', 'optimize', 'regression', 'package']);
  for (const id of ['setup', 'outfit', 'recolor', 'menu', 'regression_pre', 'optimize', 'regression', 'package']) {
    // A stage may open with an object-form knowledge spec (the material axis added one), so the stage's own
    // Harness doc is its first *shorthand* entry rather than literally the first element.
    const context = capabilities.stages[id]!.context?.find(entry => typeof entry === 'string');
    assert.ok(context, `${id} has Harness-selected context`);
    assert.match(readFileSync(join(installed.knowledgeRoot, context as string), 'utf8'), /Runtime/);
  }
  assert.ok(capabilities.stages.setup!.agentTools?.['setup-project']);
  assert.ok(capabilities.stages.recolor!.agentTools?.['generate-recolor-candidates']);
  assert.deepEqual(capabilities.stages.regression_pre!.prepareCommand?.slice(-2),['--slot','regression_pre']);
  assert.deepEqual(capabilities.stages.regression!.prepareCommand?.slice(-2),['--slot','regression']);
  assert.equal(capabilities.stages.package!.prepareCommand?.[1]?.endsWith('/harness/package.py'),true);
  assert.equal(capabilities.stages.regression_pre!.agentTools,undefined);
  assert.equal(capabilities.stages.regression_pre!.maxCheckRetries,3);
  assert.equal(capabilities.stages.regression!.maxCheckRetries,3);
  assert.match(readFileSync(join(installed.toolRoot, 'harness/intake.py'), 'utf8'), /AVH_MANIFEST/);
  const menuStage = readFileSync(join(installed.toolRoot, 'harness/unity/Editor/MenuStage.cs'), 'utf8');
  assert.doesNotMatch(menuStage, /本工具只做路线 A/);
  assert.match(menuStage, /InstallSelectorController/);
  assert.match(menuStage, /ModularAvatarMergeAnimator/);
  assert.match(menuStage, /ControlType\.RadialPuppet/,'whole outfits are selected by one radial control');
  assert.match(menuStage, /timeParameterActive = true/,'the radial value samples one stepped outfit timeline without transition gaps');
  assert.match(menuStage, /InstallComponentMatrix/,'semantic component sets are managed across outfits');
  assert.match(menuStage, /disable_when_on/,'a semantic component set can include displaced objects');
  assert.match(menuStage, /targetRecords/,'every semantic region records its per-outfit constituent and displaced object lists');
  const coldImportStage = readFileSync(join(installed.toolRoot, 'harness/unity/Editor/ColdImportStage.cs'), 'utf8');
  assert.match(coldImportStage, /未完整联动组成物/,'cold import proves every constituent follows its semantic region switch');
  assert.match(coldImportStage, /未正确让位\/恢复/,'cold import proves displaced objects turn off and restore with the region switch');
  assert.match(menuStage, /CopyVendorClip/,'vendor ON and OFF behavior is folded into the semantic component layer');
  assert.match(menuStage, /allow_default_off/,'vendor ON clips cannot silently enable prefab-default-off alternate meshes');
  assert.match(menuStage, /propertyOwners/,'component layers enforce one final writer per animation property');
  const avatarAudit = readFileSync(join(installed.toolRoot, 'harness/unity/Editor/AvatarAudit.cs'), 'utf8');
  assert.match(avatarAudit,/ParameterDriverMultiOwners/,'baked controllers audit event-ordered parameter writers by layer owner');
  assert.match(avatarAudit,/结果取决于状态进入顺序/,'multi-owner Driver diagnostics explain the runtime failure mode');
  assert.match(avatarAudit,/MotionTimeAudit/,'baked Motion Time clips are checked using their real length and menu values');
  assert.match(avatarAudit,/motion_time_duplicate_control_samples/,'identical radial slots are exposed as a blocking metric');
  assert.match(avatarAudit,/cycleOffsetParameterActive/,'parameter liveness includes state Motion Time, speed, mirror and cycle offset inputs');
  assert.match(menuStage, /ResolveParameter/,'vendor parameter ownership is resolved before menu generation');
  assert.match(menuStage, /GetComponentsInChildren<ModularAvatarParameters>/,'unbaked MA parameters participate in collision detection');
  assert.match(menuStage, /\["schema"\] = "menu\/0\.4"/);
  const outfitStage=readFileSync(join(installed.toolRoot,'harness/unity/Editor/OutfitStage.cs'),'utf8');
  assert.doesNotMatch(outfitStage,/BodyClothing\s*=\s*new Regex/,'object names must not decide which body parts are deleted');
  assert.match(outfitStage,/var targets = named\.Select/,'only explicit hide_body_parts may hide body objects');
  assert.match(outfitStage,/GetComponentsInChildren<MeshFilter>/,'static attachments are part of the installed-parts inventory');
  assert.match(outfitStage,/MissingHumanoidTrunkBones/,'bone coverage is measured from bones the outfit actually declares');
  // The file calls ExcludedFromBuild before defining it, and for a while it called it without defining it
  // at all, which is a CS0103 that fails the whole editor assembly rather than one code path. Assert the
  // definition exists and that it recognises both ways an object leaves the build.
  assert.match(outfitStage,/public static bool ExcludedFromBuild\(Transform transform\)/,'the exclusion predicate that MappedBones calls is defined');
  assert.match(outfitStage,/CompareTag\("EditorOnly"\)/,'EditorOnly marks a branch the build strips');
  assert.match(outfitStage,/activeInHierarchy/,'an inactive object is not part of the delivered avatar either');
  const excludedFromBuild=outfitStage.match(/public static bool ExcludedFromBuild\(Transform transform\) =>([^;]+);/)?.[1] ?? '';
  assert.match(excludedFromBuild,/transform == null/,'a missing transform cannot count as covered');
  // A prop with no mount point is measured on its own, not counted as a missing trunk bone.
  assert.match(outfitStage,/UnmountedBoneProxies/,'an unmounted prop is reported separately from trunk coverage');
  assert.match(outfitStage,/metrics\["unmounted_bone_proxies"\]/,'the separate reading reaches the observation');
  assert.match(outfitStage,/\["schema"\] = AvatarConfig\.Grouped\(plan\) \? "outfit\/0\.4" : "outfit\/0\.3"/);
  assert.match(readFileSync(join(installed.toolRoot, 'harness/avatar_config.py'), 'utf8'), /avatar-config\/0\.1/);
  assert.match(outfitStage,/bone_proxy_visuals/,'visual BoneProxy children are recorded before NDMF reparents them');
  assert.match(outfitStage,/shapechanger_set_delete_conflicts/,'same-host Set and Delete conflicts are build blockers');
  assert.match(outfitStage,/shoe_on_sock_on.*shoe_off_sock_on.*barefoot/s,'foot shape writers require the historical three-state review');
  assert.match(outfitStage,/blendshape_sync_missing_keys/,'vendor BlendshapeSync bindings must resolve both source and local keys');
  // A preserved source that reports only "something changed" cannot be acted on: on a real project every
  // recorded file hash still matched, so the difference was inside the structure and unreachable from
  // outside. The check has to name the first differing path.
  const faceStage=readFileSync(join(installed.toolRoot,'harness/unity/Editor/FaceStage.cs'),'utf8');
  assert.match(faceStage,/FirstJsonDifference\(observed, ObserveSource\(path\), ""\)/,'the preserve check locates the difference');
  assert.match(faceStage,/"Preserve source or dependency changed: " \+ difference/,'and reports it instead of a bare accusation');
  assert.match(faceStage,/static string FirstJsonDifference\(object left, object right, string at\)/,'the comparator walks both shapes');
  assert.match(menuStage,/BoneProxy 可视件路径不存在/,'the outfit selector explicitly owns visual BoneProxy children');
  const optimizeStage=readFileSync(join(installed.toolRoot,'harness/unity/Editor/OptimizeStage.cs'),'utf8');
  assert.match(optimizeStage,/optimize-design\/0\.1/,'optimization requires an explicit evidence-backed design');
  assert.match(optimizeStage,/visual_review/,'main texture changes require aesthetic evidence');
  assert.match(optimizeStage,/\["rollback"\]/,'every texture decision carries rollback settings');
  assert.match(optimizeStage,/ApplyPhysBoneActions/,'verified duplicate PhysBones can be removed through a reversible design action');
  assert.match(optimizeStage,/remove_noop/,'verified empty PhysBones require an explicit reversible design action');
  const perfStage=readFileSync(join(installed.toolRoot,'harness/unity/Editor/Perf.cs'),'utf8');
  assert.match(perfStage,/\["physbones"\] = PhysBoneInventory/,'performance evidence identifies individual PhysBones');
  assert.match(perfStage,/\["aabb_contributors"\]/,'performance evidence attributes oversized bounds to renderers');
  assert.match(perfStage,/invalid_merge_physbones/,'invalid AAO MergePhysBone configurations are measured before build');
  assert.match(perfStage,/physbone_core_humanoid_coverage/,'PhysBones may not silently absorb humanoid core chains');
  assert.match(perfStage,/endpointPosition == Vector3\.zero/,'only no-child zero-endpoint PhysBones are reported as no-op candidates');
  assert.doesNotMatch(perfStage,/shipped\.Where\(r => !\(r is ParticleSystemRenderer\)/,'particle renderers may not be hidden from AABB evidence');
  const buildCopy=readFileSync(join(installed.toolRoot,'harness/build_copy.py'),'utf8');
  assert.match(buildCopy,/before_sha256/,'applied texture changes retain an auditable before fingerprint');
  assert.match(buildCopy,/'rollback': entry\.get\('rollback'\)/,'the isolated build application carries rollback data forward');
  const packageTool=readFileSync(join(installed.toolRoot,'harness/package.py'),'utf8');
  assert.match(packageTool,/delivery-diagnosis\/0\.1/,'delivery diagnosis has a machine-readable contract');
  assert.match(packageTool,/CLIENT_CHECKS/,'client-only checks are explicitly classified');
  assert.match(packageTool,/status'\) != 'pending'/,'client-only checks cannot be claimed as pre-verified');
  assert.match(packageTool,/不打包/,'blocking diagnosis prevents package production');

  const previous = join(home, 'managed/packs/builtin-linux-rc1');
  cpSync(installed.root, previous, { recursive: true });
  writeFileSync(join(previous, 'pack.json'), JSON.stringify({ ...info, id: 'builtin-linux-rc1', version: '0.1.0-rc.1' }));
  const packs = managedPacks(home, installed.knowledgeRoot);
  assert.equal(packs.length, 2);
  assert.equal(packs.find(pack => pack.id === info.id)!.active, true);
  assert.equal(packs.find(pack => pack.id === 'builtin-linux-rc1')!.active, false);
});

test('real-fit metric shape blocks body and sole piercing while independently passing toes',()=>{
  const root=new URL('../builtin/knowledge/process/',import.meta.url);
  const thresholds=parse(readFileSync(new URL('thresholds.yaml',root),'utf8')) as Record<string,unknown>;
  const process=loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml',root),'utf8'),thresholds);
  const metrics={fit_probe_completed:true,fit_states_expected:2,fit_states_completed:2,fit_pierced_vertices:149,
    fit_max_depth_mm:14.215,fit_footwear_records:4,fit_sole_below_vertices:1922,fit_toe_pierced_vertices:0,fit_sole_signed_samples:1922};
  const result=(id:string)=>evaluateRule(parseRule(process.checks.find(check=>check.id===id)!.rule),metrics,{}).result;
  assert.equal(result('regression_fit_probe_pre'),'pass');
  assert.equal(result('regression_body_piercing_pre'),'violation');
  assert.equal(result('regression_sole_piercing_pre'),'violation');
  assert.equal(result('regression_toe_piercing_pre'),'pass');
});
