import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync, copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {planDetails, planSummary} from '../src/shared/plan-view.ts';
import {materialAxisConfig} from './fixtures/material-axis.ts';
import {removeTemp} from './fixtures/platform.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));

test('material axis independently owns exact slots while instance owners and legacy projection remain intact', () => {
  const check = (config: any) => spawnSync('python3', ['-c',
    'import sys,json;sys.path.insert(0,sys.argv[1]);from avatar_config import validate,physical_rows;c=json.load(sys.stdin);print(json.dumps({"metrics":validate(c,{"items":[{"item":"vendor","role":"other","prefabs":["Assets/short.prefab","Assets/long.prefab"]}]}),"rows":physical_rows(c)}))', tools],
    {input: JSON.stringify(config), encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
  const config = materialAxisConfig(); const valid = check(config);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).metrics.parameter_bits, 16);
  assert.deepEqual(JSON.parse(valid.stdout).rows.map((r: any) => r.id), ['short', 'long']);
  const mutations: Array<(c: any) => void> = [
    c => c.groups[1].bindings[1].instance = 'missing',
    c => c.groups[1].bindings[1].slot = true,
    c => c.groups[1].bindings[1].renderer = '../Surface',
    c => c.groups[1].bindings[1].source_material = 'Packages/external.mat',
    c => delete c.groups[1].members[0].materials.long,
    c => c.groups[1].members[0].materials.long = 'missing',
    c => c.groups[1].members[0].instance = 'short',
    c => c.groups[1].activation = 'independent',
    c => c.groups[1].default = 'unknown',
    c => c.groups[1].parameter.name = 'Style',
    c => c.groups[1].bindings.push({...c.groups[1].bindings[0], id: 'duplicate'}),
    c => c.material_presets[0].adjustment = {gradient: true},
    c => c.material_presets[0].adjustment = {value: Number.NaN},
    c => c.material_presets.push({id: 'unused', material: 'Assets/unused.mat'}),
    c => c.groups[0].members[1].instance = 'short',
  ];
  for (const mutate of mutations) { const c = structuredClone(config); mutate(c); assert.notEqual(check(c).status, 0); }
  const fixed = structuredClone(config) as any;
  fixed.groups[0] = {id: 'always', label: '共同穿着', activation: 'fixed', members: fixed.groups[0].members};
  assert.equal(check(fixed).status, 0, 'fixed activation remains compatible');
  const plan = {avatar_config: config};
  assert.ok(planSummary(plan).some(([label, value]) => label === '发色' && value.includes('切换造型保留颜色') && value.includes('2 个造型') && value.includes('warm')));
  assert.ok(planDetails(plan).some(([label, value]) => label.includes('材质槽') && value.includes('Nested/Strands [1]')));
  assert.ok(planDetails(plan).some(([label, value]) => label.includes('颜色预设') && value === 'Assets/mixed.mat'));
});

test('formal plan observation includes material sources and rejects a missing preset before submission', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-axis-plan-')); t.after(() => removeTemp(root));
  for (const dir of ['_harness/intake', 'Assets']) mkdirSync(join(root, dir), {recursive: true});
  const config = materialAxisConfig();
  const items = [{item: 'body', role: 'body', prefabs: ['Assets/body.prefab']}, {item: 'vendor', role: 'other', prefabs: ['Assets/short.prefab', 'Assets/long.prefab']}]
    .map(i => ({...i, found: true, files: [{selected: true, name: i.item, sha256: 'fixture'}]}));
  const inventory = JSON.stringify({schema: 'inventory/0.1', items});
  writeFileSync(join(root, '_harness/intake/inventory.json'), inventory);
  writeFileSync(join(root, '_harness/intake/plan-catalog.json'), JSON.stringify({schema: 'plan-catalog/0.1', inventorySha256: createHash('sha256').update(inventory).digest('hex'), items, variants: []}));
  for (const file of ['steel.mat', 'warm.mat', 'mixed.mat', 'original.mat']) writeFileSync(join(root, 'Assets', file), 'fixture');
  const plan = {schema: 'plan/0.3', body: 'body', body_prefab: 'Assets/body.prefab', avatar_config: config,
    menu: {mode: 'assemble', vendor_policy: 'preserve_and_merge', tree: [{group: 'shape'}, {group: 'shade'}]},
    recolor: {targets: [{part: 'eye', hue_shift: 0, saturation: 1, value: 1}], candidates: 3}, face: {mode: 'preserve'}, optimization: {mode: 'preserve'},
    obligations: items.map(i => ({input: i.item, role: i.role, action: 'use', target: i.item, due_stage: 'outfit'}))};
  const observe = (script = join(tools, 'plan.py')) => {
    const result = spawnSync('python3', [script, 'observe', '--project', root, '--out', join(root, 'result.json')],
      {encoding: 'utf8', env: {...process.env, AVH_PLAN: JSON.stringify(plan), PYTHONDONTWRITEBYTECODE: '1'}});
    assert.equal(result.status, 0, result.stderr); return JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')).metrics.plan_source_contract_valid;
  };
  assert.equal(observe(), true);
  unlinkSync(join(root, 'Assets/mixed.mat')); assert.equal(observe(), false);
  writeFileSync(join(root, 'Assets/mixed.mat'), 'fixture');
  const fixed = config.groups[0] as any; fixed.activation = 'fixed'; delete fixed.selector; delete fixed.default; delete fixed.parameter; plan.menu.tree = [{group: 'shade'}];
  assert.equal(observe(), true, 'fixed visibility plus independent color remains valid');
  plan.menu.mode = 'preserve'; assert.equal(observe(), false, 'material axes cannot fall into preservation');
  copyFileSync(join(tools, 'avatar_config.py'), join(root, 'avatar_config.py'));
  const mutant = join(root, 'mutant.py'); writeFileSync(mutant, readFileSync(join(tools, 'plan.py'), 'utf8').replace("any(g['activation'] != 'fixed'", "any(g['activation'] == 'independent'"));
  assert.equal(observe(mutant), true, 'legacy preservation guard revived the unavailable color menu');
});
