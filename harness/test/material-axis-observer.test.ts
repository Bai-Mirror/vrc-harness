import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {removeTemp} from './fixtures/platform.ts';
import {loadProcess} from '../src/process/load.ts';
import {evaluateRule, parseRule} from '../src/process/rule.ts';
import {parse} from 'yaml';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
test('formal recolor observation requires exact preset identities, complete slot coverage and current source bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-axis-observer-')); t.after(() => removeTemp(root));
  const layer = 'Assets/_Harness/Recolor';
  const bindings = [{id: 'strand', instance: 'braid', renderer: 'Detail/Surface', slot: 2, source_material: 'Assets/Source.mat'},
    {id: 'fringe', instance: 'cropped', renderer: 'Surface', slot: 0, source_material: 'Assets/Source.mat'}];
  const members = ['silver', 'gold', 'gradient'].map(id => ({id, label: id, materials: {strand: id, fringe: id}}));
  const plan = {schema: 'plan/0.3', avatar_config: {groups: [{id: 'color', kind: 'material', activation: 'exclusive', default: 'gold', bindings, members}],
    material_presets: members.map(m => ({id: m.id, material: 'Assets/' + m.id + '.mat'}))}, recolor: {targets: [], candidates: 1}};
  const rows = [{instance: 'braid', object: '_Items/Braid'}, {instance: 'cropped', object: '_Items/Crop'}];
  const write = (path: string, value: string) => {mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), value);};
  const guids = new Map(members.map((m, i) => [m.id, String(i + 1).repeat(32)]));
  for (const m of members) {write('Assets/' + m.id + '.mat', 'Material: fixture'); write('Assets/' + m.id + '.mat.meta', 'guid: ' + guids.get(m.id));}
  write('Assets/Source.mat', 'Material: untouched');
  write('Assets/_Harness/Outfit/outfit.json', JSON.stringify({outfits: rows}));
  write('Assets/_Harness/Outfit/Avatar.prefab', 'fixture'); write(layer + '/Avatar.prefab', 'fixture');
  write(layer + '/recipe.json', '{}'); write(layer + '/ledger.json', '{"rows":[]}');
  write(layer + '/AxisPresets/presets.json', '{}');
  const files = Object.fromEntries(['Assets/Source.mat', 'Assets/_Harness/Outfit/outfit.json', 'Assets/_Harness/Outfit/Avatar.prefab', layer + '/Avatar.prefab', layer + '/recipe.json', layer + '/AxisPresets/presets.json',
    ...members.flatMap(m => ['Assets/' + m.id + '.mat', 'Assets/' + m.id + '.mat.meta'])].map(path => [path, sha(readFileSync(join(root, path)))]));
  const entries = members.flatMap(m => bindings.map(b => ({group: 'color', member: m.id, binding: b.id, renderer: rows.find(r => r.instance === b.instance)!.object + '/' + b.renderer,
    slot: b.slot, default: m.id === 'gold', expected_guid: guids.get(m.id), actual_guid: guids.get('gold')})));
  const report = {schema: 'material-selection-readback/0.1', files, plan_sha256: sha(JSON.stringify(plan)), material_axis_bindings: entries,
    material_default_slots: bindings.map(b => ({renderer: rows.find(r => r.instance === b.instance)!.object + '/' + b.renderer, slot: b.slot, actual_guid: guids.get('gold'), original_guid: 'a'.repeat(32)}))};
  const observe = (value: any = report, script = join(tools, 'observe_recolor.py')) => {
    write('observations/material-selection-readback.json', JSON.stringify(value));
    execFileSync('python3', [script, '--out', join(root, 'observed.json')], {env: {...process.env, PYTHONDONTWRITEBYTECODE: '1', AVH_PROJECT_DIR: root, AVH_RUN_DIR: root, AVH_TOOL_ROOT: join(tools, '..'), AVH_PLAN: JSON.stringify(plan)}});
    return JSON.parse(readFileSync(join(root, 'observed.json'), 'utf8')).metrics;
  };
  const positive = observe(); assert.equal(positive.material_axis_presets_verified, true); assert.equal(positive.replaced_material_slots, 2); assert.equal(positive.recolor_ledger_slots, 2);
  // A plan with no recolor targets still owes every axis member a landed slot: the reading is a verdict
  // rather than the `null` (no data) that made the source-mapped gate unsatisfiable for this shape.
  assert.equal(positive.unmapped_color_requirements, 0);
  assert.equal(positive.recolor_materials_shared_by_multiple_meshes, 0); assert.equal(positive.recolor_materials_outside_own_dir, 0);
  const collateral = structuredClone(report); collateral.material_default_slots.push({renderer: '_Body/Unrelated', slot: 0, actual_guid: guids.get('gold'), original_guid: 'a'.repeat(32)});
  const leaked = observe(collateral); assert.equal(leaked.material_axis_presets_verified, true, 'declared axis itself still matches');
  assert.equal(leaked.recolor_materials_outside_own_dir, 1, 'verified vendor GUID is not a global exemption');
  assert.equal(leaked.recolor_materials_shared_by_multiple_meshes, 1);
  assert.notEqual(leaked.replaced_material_slots, leaked.recolor_ledger_slots);
  const scopeMutant = join(root, 'scope-mutant.py');
  const observerSource = readFileSync(join(tools, 'observe_recolor.py'), 'utf8');
  const widened = observerSource.replace(/        selected_guids = \{guid for guid in selected_guids if all\([\s\S]*?r.get\('original_guid'\)\)\}\r?\n/, '');
  assert.notEqual(widened, observerSource); writeFileSync(scopeMutant, widened);
  const escaped = observe(collateral, scopeMutant);
  assert.equal(escaped.recolor_materials_outside_own_dir, 0, 'reverted slot scoping hides the collateral write');
  assert.equal(escaped.recolor_materials_shared_by_multiple_meshes, 0);
  const mutations: Array<(r: any) => void> = [
    r => r.material_axis_bindings.pop(),
    r => r.material_axis_bindings.push({...r.material_axis_bindings[0]}),
    r => r.material_axis_bindings.find((b: any) => b.default).actual_guid = guids.get('silver'),
    r => r.material_axis_bindings[0].expected_guid = guids.get('gold'),
    r => r.material_axis_bindings[0].renderer = '_Items/Wrong/Surface',
    r => delete r.files['Assets/Source.mat'],
    r => delete r.files[layer + '/AxisPresets/presets.json'],
    r => r.plan_sha256 = 'stale',
  ];
  for (const mutate of mutations) {const r = structuredClone(report); mutate(r); assert.equal(observe(r).material_axis_presets_verified, false);}
  // Fail-closed in the other direction: an axis that did not verify must report its members as unmapped
  // rather than as "no data", which is what made the source-mapped gate unsatisfiable for this shape.
  const incomplete = structuredClone(report); incomplete.material_axis_bindings.pop();
  const shortfall = observe(incomplete);
  assert.equal(shortfall.material_axis_presets_verified, false);
  assert.equal(shortfall.unmapped_color_requirements, members.length, 'every member of an unverified axis is an unmapped requirement');
  write('Assets/gold.mat', 'Material: changed after readback'); assert.equal(observe().material_axis_presets_verified, false); write('Assets/gold.mat', 'Material: fixture');
  const mutant = join(root, 'mutant.py'); writeFileSync(mutant, readFileSync(join(tools, 'observe_recolor.py'), 'utf8').replace('axis_valid, axis_guids, axis_slots = material_axis_selection(project, run, plan)', 'axis_valid, axis_guids, axis_slots = True, set(), set()'));
  const wrong = structuredClone(report); wrong.material_axis_bindings.pop(); assert.equal(observe(wrong, mutant).material_axis_presets_verified, true, 'reverted observer revives incomplete coverage');
  const definition = loadProcess(readFileSync(new URL('../builtin/knowledge/process/pc-recolor-outfit.process.yaml', import.meta.url), 'utf8'), parse(readFileSync(new URL('../builtin/knowledge/process/thresholds.yaml', import.meta.url), 'utf8')));
  const check = definition.checks.find(c => c.id === 'recolor_material_axis_presets_verified')!;
  assert.equal(evaluateRule(parseRule(check.rule), {material_axis_presets_verified: true}, {}).result, 'pass');
  assert.equal(evaluateRule(parseRule(check.rule), {material_axis_presets_verified: false}, {}).result, 'violation');
  assert.equal(evaluateRule(parseRule(check.rule), {}, {}).result, 'no_data');
});
