import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const layer = 'Assets/_Harness/Recolor', guid = 'b'.repeat(32), rendererGuid = 'a'.repeat(32);
const target = { requirement_id: 'pink', outfit: 'winter', material: 'Assets/Vendor/Bag/Pink.mat' };
const plan = { recolor: { targets: [target], candidates: 1 } };
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
function fixture(root: string) {
  for (const dir of [layer, 'Assets/_Harness/Outfit', 'Assets/Vendor/Bag', 'observations']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, target.material), 'Material:\n');
  writeFileSync(join(root, target.material + '.meta'), `guid: ${guid}\n`);
  writeFileSync(join(root, 'Assets/_Harness/Outfit/Avatar.prefab'), 'fixture input');
  writeFileSync(join(root, 'Assets/_Harness/Outfit/outfit.json'), '{}');
  const overrides = [1, 2].map(id => `    - target: {fileID: ${id}, guid: ${rendererGuid}, type: 3}\n      propertyPath: m_Materials.Array.data[0]\n      value: \n      objectReference: {fileID: 2100000, guid: ${guid}, type: 2}\n`).join('');
  writeFileSync(join(root, layer, 'Avatar.prefab'), overrides);
  const rows = [1, 2].map(id => ({ renderer: `_Outfit/Outfit_winter/Bag${id}`, slot: 0, ...target, material_guid: guid }));
  writeFileSync(join(root, layer, 'ledger.json'), JSON.stringify({ rows }));
  const recipe = execFileSync('python3', ['-c', 'import sys,json;sys.path.insert(0,sys.argv[1]);import recolor;print(recolor.serialize(recolor.build_recipe(json.loads(sys.argv[2]),"")),end="")', tools, JSON.stringify(plan)], { encoding: 'utf8' });
  writeFileSync(join(root, layer, 'recipe.json'), recipe);
  const files = Object.fromEntries([target.material, target.material + '.meta', 'Assets/_Harness/Outfit/Avatar.prefab',
    'Assets/_Harness/Outfit/outfit.json', `${layer}/Avatar.prefab`, `${layer}/recipe.json`].map(path => [path, sha(readFileSync(join(root, path)))]));
  const report = { schema: 'material-selection-readback/0.1', plan_sha256: sha(JSON.stringify(plan)), files,
    bindings: rows.map(r => ({ ...r, expected_guid: guid, actual_guid: guid })),
    slots: rows.map(r => ({ renderer: r.renderer, slot: 0, material_guid: guid, original_guid: 'c'.repeat(32) })) };
  writeFileSync(join(root, 'observations/material-selection-readback.json'), JSON.stringify(report));
  return { rows, report };
}
function observe(root: string, p: unknown = plan, script = join(tools, 'observe_recolor.py'), extraEnv: Record<string, string> = {}) {
  const out = join(root, 'observation.json');
  execFileSync('python3', [script, '--out', out], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AVH_PROJECT_DIR: root,
    AVH_RUN_DIR: root, AVH_TOOL_ROOT: join(tools, '..'), AVH_PLAN: JSON.stringify(p), ...extraEnv }, stdio: 'pipe' });
  return JSON.parse(readFileSync(out, 'utf8'));
}
test('material targets require actual current GUID bindings; vendor sharing is allowed only for verified selection', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-observe-material-')); t.after(() => removeTemp(root));
  const { rows, report } = fixture(root);
  const positive = observe(root).metrics;
  for (const name of ['unmapped_color_requirements', 'layer_unverified_operations', 'material_plan_unverified',
    'material_bindings_missing', 'material_write_conflicts', 'recolor_materials_shared_by_multiple_meshes', 'recolor_materials_outside_own_dir']) assert.equal(positive[name], 0, name);
  assert.equal(positive.replaced_material_slots, 2); assert.equal(positive.recolor_ledger_rows, 2);
  // The ledger still claims the desired GUID, while a separate Unity reload found the old one.
  report.bindings[0]!.actual_guid = 'c'.repeat(32); report.slots[0]!.material_guid = 'c'.repeat(32);
  writeFileSync(join(root, 'observations/material-selection-readback.json'), JSON.stringify(report));
  const rejected = observe(root).metrics;
  assert.equal(rejected.material_bindings_missing, 1); assert.equal(rejected.unmapped_color_requirements, 1);
  assert.equal(rejected.recolor_materials_outside_own_dir, 1); assert.equal(rejected.recolor_materials_shared_by_multiple_meshes, 1);
  // Removing the actual-GUID checks from the production observer must revive the false claim.
  const mutant = join(root, 'mutant.py');
  const source = readFileSync(join(tools, 'observe_recolor.py'), 'utf8');
  writeFileSync(mutant, source.replace("b.get('actual_guid') == guid", 'True').replace("slot_map.get(slot_key(b, target.get('outfit'))) == guid", 'True'));
  assert.equal(observe(root, plan, mutant).metrics.material_bindings_missing, 0);
  assert.equal(observe(root, plan, mutant).metrics.unmapped_color_requirements, 0);
  assert.equal(rows[0]!.material_guid, guid, 'negative control keeps the executor claim intact');
});
test('missing, stale and empty-hit observations cannot certify plan executability', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-current-')); t.after(() => removeTemp(root));
  const { report } = fixture(root);
  for (const change of ['missing', 'plan', 'input', 'output', 'target', 'zero']) {
    fixture(root);
    if (change === 'missing') writeFileSync(join(root, 'observations/material-selection-readback.json'), '{}');
    if (change === 'plan') writeFileSync(join(root, 'observations/material-selection-readback.json'), JSON.stringify({ ...report, plan_sha256: 'old' }));
    if (change === 'input') writeFileSync(join(root, 'Assets/_Harness/Outfit/Avatar.prefab'), 'new input');
    if (change === 'output') writeFileSync(join(root, layer, 'Avatar.prefab'), 'new output');
    if (change === 'target') writeFileSync(join(root, target.material + '.meta'), 'guid: ' + 'd'.repeat(32));
    if (change === 'zero') writeFileSync(join(root, 'observations/material-selection-readback.json'), JSON.stringify({ ...report, bindings: [] }));
    const metrics = observe(root).metrics;
    assert.equal(metrics.material_plan_unverified, 1, change); assert.equal(metrics.material_bindings_missing, 1, change);
  }
});
test('unverified outside writes and conflicting claims retain blocking metrics', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-conflicts-')); t.after(() => removeTemp(root));
  const { report, rows } = fixture(root);
  report.slots.push({ renderer: 'Unselected', slot: 0, material_guid: guid, original_guid: 'c'.repeat(32) });
  writeFileSync(join(root, 'observations/material-selection-readback.json'), JSON.stringify(report));
  writeFileSync(join(root, layer, 'ledger.json'), JSON.stringify({ rows: [...rows, { renderer: rows[0]!.renderer, slot: 0, part: 'outfit:winter', material_guid: guid }] }));
  const metrics = observe(root).metrics;
  assert.equal(metrics.material_write_conflicts, 1); assert.equal(metrics.recolor_materials_outside_own_dir, 1);
  assert.equal(metrics.recolor_materials_shared_by_multiple_meshes, 1);
});

test('relative and layered writers sharing a final copy do not conflict with a material selection in another slot', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-combined-')); t.after(() => removeTemp(root));
  const { rows } = fixture(root);
  const combined = [...rows, { renderer: 'Face', slot: 0, part: 'eye', material_guid: 'd'.repeat(32) },
    { renderer: 'Face', slot: 0, part: 'layer:lash', material_guid: 'd'.repeat(32) }];
  writeFileSync(join(root, layer, 'ledger.json'), JSON.stringify({ rows: combined }));
  assert.equal(observe(root).metrics.material_write_conflicts, 0);
  const mutant = join(root, 'mutant.py');
  const source = readFileSync(join(tools, 'observe_recolor.py'), 'utf8');
  const guard = "len(w) > 1 and any(writer.startswith('material:') for writer in w)";
  assert.ok(source.includes(guard)); writeFileSync(mutant, source.replace(guard, 'len(w) > 1'));
  assert.equal(observe(root, plan, mutant).metrics.material_write_conflicts, 1);
});

test('thin members use separate actual slot readbacks while global writers still conflict', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-members-')); t.after(() => removeTemp(root));
  const {rows, report} = fixture(root);
  const second = {...target, requirement_id:'white', outfit:'summer'};
  const groupedPlan = {...plan, avatar_config:{schema:'avatar-config/0.1'}, recolor:{targets:[target,second],candidates:1}};
  const combined = [...rows,...rows.map(r=>({...r,...second}))];
  const groupedReport = {...report, plan_sha256:sha(JSON.stringify(groupedPlan)),
    bindings:combined.map(r=>({...r,expected_guid:guid,actual_guid:guid})),
    slots:combined.map(r=>({renderer:r.renderer,slot:0,member:r.outfit,material_guid:guid,original_guid:'c'.repeat(32)}))};
  const save = () => writeFileSync(join(root,'observations/material-selection-readback.json'),JSON.stringify(groupedReport));
  save();writeFileSync(join(root,layer,'ledger.json'),JSON.stringify({rows:combined}));
  let metrics=observe(root,groupedPlan).metrics;
  assert.equal(metrics.material_bindings_missing,0);assert.equal(metrics.material_write_conflicts,0);
  groupedReport.slots[2]!.material_guid='c'.repeat(32);save();
  assert.equal(observe(root,groupedPlan).metrics.material_bindings_missing,1,'default member cannot prove the other member');
  writeFileSync(join(root,layer,'ledger.json'),JSON.stringify({rows:[...combined,{renderer:rows[0]!.renderer,slot:0,part:'hair',material_guid:guid}]}));
  metrics=observe(root,groupedPlan).metrics;assert.equal(metrics.material_write_conflicts,2,'global writer conflicts with both members');
});

test('grouped relative color requires current per-member bindings, not default prefab or ledger claims', t => {
  const root=mkdtempSync(join(tmpdir(),'avh-relative-members-'));t.after(()=>removeTemp(root));
  const {rows,report}=fixture(root);
  const p={avatar_config:{schema:'avatar-config/0.1'},recolor:{targets:[{part:'outfit:winter',hue_shift:30,saturation:1,value:1}],candidates:1}};
  const relative=rows.map(r=>({renderer:r.renderer,slot:0,part:'outfit:winter',original_guid:'c'.repeat(32),material_guid:guid}));
  writeFileSync(join(root,layer,'ledger.json'),JSON.stringify({rows:relative}));
  const reload={...report,plan_sha256:sha(JSON.stringify(p)),relative_bindings:relative.map(r=>({...r,actual_guid:guid}))};
  const save=()=>writeFileSync(join(root,'observations/material-selection-readback.json'),JSON.stringify(reload));save();
  assert.equal(observe(root,p).metrics.unmapped_color_requirements,0);
  reload.relative_bindings[0]!.actual_guid='c'.repeat(32);save();
  assert.equal(observe(root,p).metrics.unmapped_color_requirements,1);
  reload.relative_bindings[0]!.actual_guid=guid;reload.plan_sha256='stale';save();
  assert.equal(observe(root,p).metrics.unmapped_color_requirements,1);
});
test('an untouched outfit using the same vendor asset does not invalidate verified selection', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-shared-')); t.after(() => removeTemp(root));
  const { report } = fixture(root);
  report.slots.push({ renderer: '_Outfit/Outfit_other/Bag', slot: 0, material_guid: guid, original_guid: guid });
  writeFileSync(join(root, 'observations/material-selection-readback.json'), JSON.stringify(report));
  const metrics = observe(root).metrics;
  assert.equal(metrics.recolor_materials_outside_own_dir, 0);
  assert.equal(metrics.recolor_materials_shared_by_multiple_meshes, 0);
  assert.equal(metrics.replaced_material_slots, 2);
});
test('without material targets, existing relative and layered metrics remain unchanged individually', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-legacy-')); t.after(() => removeTemp(root));
  const { rows } = fixture(root);
  // Measured against the pre-change observer: freeze every existing metric without
  // depending on a historical Git object remaining available after integration.
  const legacy = { replaced_material_slots: 2, recolor_materials_shared_by_multiple_meshes: 1,
    recolor_materials_outside_own_dir: 1, recolor_ledger_rows: 2, recolor_ledger_slots: 2, layer_alpha_moved: 0,
    layer_bindings_missing: 0, layer_outside_mask_changed: 0, layer_semantics_violations: 0,
    layer_operations_verified: null, rerun_recipe_hash_equal: false, recipe_script_tracked: true,
    candidate_tier_count: 0, candidate_tier_shortfall: 1, distinct_camera_specs: null, color_decision_missing_sections: 2,
    // The region route reports the same shape of readings for every recolour task, as zero when there are no
    // region targets: a metric the observer never reports becomes no_data, which the engine does not pass.
    region_operations_verified: 0, region_unverified_operations: 0, region_mask_mismatches: 0, region_alpha_moved: 0,
    region_outside_mask_changed: 0, region_cross_painted_pixels: 0, region_semantics_violations: 0,
    region_bindings_missing: 0, region_ambiguous_pixels: 0, region_record_mismatches: 0,
    region_transparent_rgb_changed: 0, region_write_conflicts: 0 };
  for (const targets of [[{ part: 'hair', hue_shift: 12, saturation: 1, value: 1 }],
    [{ requirement_id: 'lash', layered: 'source.psd', layer: ['lash'], color: '#123456', semantics: 'flat' }]]) {
    writeFileSync(join(root, layer, 'ledger.json'), JSON.stringify({ rows: rows.map(r => ({ ...r, outfit: undefined, requirement_id: undefined, part: 'hair' })) }));
    const p = { recolor: { targets, candidates: 3 } };
    const current = observe(root, p).metrics;
    for (const name of ['material_plan_unverified', 'material_bindings_missing', 'material_write_conflicts']) { assert.equal(current[name], 0); delete current[name]; }
    const relative = 'part' in targets[0]!;
    assert.deepEqual(current, { ...legacy, unmapped_color_requirements: relative ? 0 : 1,
      layer_unverified_operations: relative ? 0 : 1, relative_target_count: relative ? 1 : 0 });
  }
});

// NumPy and Pillow are needed by one route, not by the task. Before this the observer imported both before it
// looked at whether there was anything to compute for that route, so a plain relative or material recolour
// died with ModuleNotFoundError on a machine that need not have them — the old capability was blocked by a
// module it never used (R6 第 3 项).
test('a recolour with no region or layer target runs on a machine without NumPy or Pillow', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-nodeps-')); t.after(() => removeTemp(root));
  const { rows } = fixture(root);
  writeFileSync(join(root, layer, 'ledger.json'), JSON.stringify({ rows: rows.map(r => ({ ...r, outfit: undefined, requirement_id: undefined, part: 'hair' })) }));
  // A record left by an earlier run is not a reason to import anything either: it is not this task's product.
  writeFileSync(join(root, layer, 'region-apply.json'), JSON.stringify({ schema: 'mesh-region-apply/0.1', groups: [] }));
  writeFileSync(join(root, layer, 'layer-apply.json'), JSON.stringify({ schema: 'layered-source-apply/0.1', operations: [] }));
  const plan = { recolor: { targets: [{ part: 'hair', hue_shift: 12, saturation: 1, value: 1 }], candidates: 3 } };
  const normal = observe(root, plan);
  // A stub package that raises the same error a machine without the dependency raises, so the control does not
  // depend on what this machine happens to have installed.
  const blocked = join(root, 'blocked'); mkdirSync(join(blocked, 'PIL'), { recursive: true });
  writeFileSync(join(blocked, 'numpy.py'), "raise ModuleNotFoundError(\"No module named 'numpy'\")\n");
  writeFileSync(join(blocked, 'PIL', '__init__.py'), "raise ModuleNotFoundError(\"No module named 'PIL'\")\n");
  const without = observe(root, plan, join(tools, 'observe_recolor.py'), { PYTHONPATH: blocked });
  for (const name of ['region_operations_verified', 'region_unverified_operations', 'region_write_conflicts',
    'region_record_mismatches', 'region_transparent_rgb_changed']) assert.equal(without.metrics[name], 0, name);
  assert.equal(without.metrics['layer_operations_verified'], null);
  assert.deepEqual(without.metrics, normal.metrics, 'the missing dependency must not change a single reading');
  assert.deepEqual(without.notes, normal.notes);
  assert.ok(without.notes.some((note: string) => note.includes('region-apply.json')), without.notes.join(' | '));
  // Mutation: with the import put back before the early return, the same run must fail — otherwise the check
  // would only be proving that this machine happens to lack nothing.
  const source = readFileSync(join(tools, 'observe_recolor.py'), 'utf8');
  const anchor = "    wanted = ['region:' + str(target.get('requirement_id')) for target in region_targets]";
  assert.ok(source.includes(anchor), 'the mutation target must exist in the shipped observer');
  const mutant = join(root, 'observe_importing.py');
  writeFileSync(mutant, source.replace(anchor, `    import numpy\n    from PIL import Image\n${anchor}`));
  const failed = spawnSync('python3', [mutant, '--out', join(root, 'mutant.json')], { encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AVH_PROJECT_DIR: root, AVH_RUN_DIR: root,
      AVH_TOOL_ROOT: join(tools, '..'), AVH_PLAN: JSON.stringify(plan), PYTHONPATH: blocked } });
  assert.notEqual(failed.status, 0, 'the pre-fix ordering must fail on a machine without the modules');
  assert.match(failed.stderr, /ModuleNotFoundError|No module named/);
});
