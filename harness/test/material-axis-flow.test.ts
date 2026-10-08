import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse} from 'yaml';
import {loadProcess} from '../src/process/load.ts';
import {evaluateRule, parseRule} from '../src/process/rule.ts';
import {materialAxisConfig} from './fixtures/material-axis.ts';
import {removeTemp} from './fixtures/platform.ts';

/**
 * A pure material axis is the one plan shape whose colours are carried by vendor material presets
 * instead of `recolor.targets`. It has to survive the real path rather than a fixture that invents its
 * own recipe and calls the Unity step: the plan gate, the recipe tool and every `material.recolor`
 * check are exercised here against one project. Each guard is then re-checked with the fix removed, so
 * the assertions are known to be load-bearing (决定记录 D-116).
 */
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const layer = 'Assets/_Harness/Recolor';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const guid = (seed: string) => seed.repeat(32);
const presetGuids: Record<string, string> = {steel: guid('1'), warm: guid('2'), mixed: guid('3')};

interface Fixture { root: string; plan: any; avhPlan: string }

function fixture(root: string): Fixture {
  for (const dir of ['_harness/intake', 'Assets', 'observations', 'candidates',
    layer + '/AxisPresets', layer + '/MemberPresets', 'Assets/_Harness/Outfit'])
    mkdirSync(join(root, dir), {recursive: true});
  const config = materialAxisConfig() as any;
  const items = [{item: 'body', role: 'body', prefabs: ['Assets/body.prefab']},
    {item: 'vendor', role: 'other', prefabs: ['Assets/short.prefab', 'Assets/long.prefab']}]
    .map(i => ({...i, found: true, files: [{selected: true, name: i.item, sha256: 'fixture'}]}));
  const inventory = JSON.stringify({schema: 'inventory/0.1', items});
  writeFileSync(join(root, '_harness/intake/inventory.json'), inventory);
  writeFileSync(join(root, '_harness/intake/plan-catalog.json'),
    JSON.stringify({schema: 'plan-catalog/0.1', inventorySha256: sha(inventory), items, variants: []}));
  for (const file of ['steel.mat', 'warm.mat', 'mixed.mat', 'original.mat', 'body.prefab', 'short.prefab', 'long.prefab'])
    writeFileSync(join(root, 'Assets', file), 'fixture');
  for (const [id, value] of Object.entries(presetGuids)) writeFileSync(join(root, 'Assets', id + '.mat.meta'), 'guid: ' + value + '\n');
  const plan = {schema: 'plan/0.3', body: 'body', body_prefab: 'Assets/body.prefab', avatar_config: config,
    menu: {mode: 'assemble', vendor_policy: 'preserve_and_merge', tree: [{group: 'shape'}, {group: 'shade'}]},
    // No recolor target at all: every colour the plan promises is carried by the axis above.
    recolor: {targets: [], candidates: 1}, face: {mode: 'preserve'}, optimization: {mode: 'preserve'},
    obligations: items.map(i => ({input: i.item, role: i.role, action: 'use', target: i.item, due_stage: 'outfit'}))};
  return {root, plan, avhPlan: JSON.stringify(plan)};
}

function write(path: string, value: string) {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, value);
}

/** A plan shape as a new fixture: same project, a different `recolor`/`avatar_config` contract. */
function variant(f: Fixture, plan: any): Fixture {
  return {root: f.root, plan, avhPlan: JSON.stringify(plan)};
}

/** The plan a plan/0.3 submission without any colour source looks like: no targets and no axis. */
function withoutAxis(f: Fixture) {
  const config = structuredClone(f.plan.avatar_config);
  const groups = config.groups.filter((g: any) => g.kind !== 'material');
  const kept = new Set(groups.map((g: any) => g.id));
  return variant(f, {...f.plan, avatar_config: {...config, material_presets: [], groups},
    menu: {...f.plan.menu, tree: f.plan.menu.tree.filter((row: any) => kept.has(row.group))}});
}

/** An axis that is declared but not executable: one member skips one observed slot. */
function partialAxis(f: Fixture) {
  const config = structuredClone(f.plan.avatar_config);
  delete config.groups.find((g: any) => g.kind === 'material').members[0].materials.long;
  return variant(f, {...f.plan, avatar_config: config});
}

/** The formal plan gate and its observer, driven the way the Runtime drives them. */
function observePlan(f: Fixture, script = join(tools, 'plan.py')) {
  const out = join(f.root, 'plan-result.json');
  const result = spawnSync('python3', [script, 'observe', '--project', f.root, '--out', out],
    {encoding: 'utf8', env: {...process.env, AVH_PLAN: f.avhPlan, PYTHONDONTWRITEBYTECODE: '1'}});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(out, 'utf8')).metrics.plan_source_contract_valid as boolean;
}

/** The product's recipe tool, on the real project; it is what writes the stage's recipe. */
function writeRecipe(f: Fixture, script = join(tools, 'recolor.py')) {
  return spawnSync('python3', [script], {encoding: 'utf8',
    env: {...process.env, AVH_PROJECT_DIR: f.root, AVH_PLAN: f.avhPlan, PYTHONDONTWRITEBYTECODE: '1'}});
}

/** Everything the recolor observer reads back, written exactly as the stage leaves it. */
function stage(f: Fixture) {
  const root = f.root;
  const recipe = writeRecipe(f);
  assert.equal(recipe.status, 0, recipe.stderr);
  write(join(root, layer, 'ledger.json'), JSON.stringify({rows: []}));
  write(join(root, layer, 'Avatar.prefab'), 'fixture recolor variant');
  write(join(root, layer, 'AxisPresets/presets.json'), '{}');
  write(join(root, 'Assets/_Harness/Outfit/Avatar.prefab'), 'fixture outfit variant');
  write(join(root, 'Assets/_Harness/Outfit/outfit.json'), JSON.stringify({outfits: [
    {instance: 'short', object: '_Items/Short'}, {instance: 'long', object: '_Items/Long'}]}));
  for (const id of ['short', 'long']) write(join(root, layer, 'MemberPresets', id + '.anim'), 'fixture preset');
  // One tier was declared, so exactly one candidate image and one camera specification belong in the Run dir.
  write(join(root, 'candidates/A_body.png'), 'fixture candidate');
  write(join(root, 'candidates/A_body.json'), JSON.stringify({renderer: 'main', position: [0, 1, 2], rotation: [0, 0, 0]}));
  write(join(root, layer, '配色决策.md'), '# 配色决策\n\n## 选定档\n\nA\n\n## 理由\n\n方案原值\n');
  const config = f.plan.avatar_config;
  const rows = [{instance: 'short', object: '_Items/Short'}, {instance: 'long', object: '_Items/Long'}];
  const axisGroups = config.groups.filter((g: any) => g.kind === 'material');
  const entries = axisGroups.flatMap((group: any) => {
    const chosen = group.members.find((member: any) => member.id === group.default);
    return group.members.flatMap((member: any) => group.bindings.map((binding: any) => {
      const row = rows.find(r => r.instance === binding.instance)!;
      return {group: group.id, member: member.id, binding: binding.id, renderer: row.object + '/' + binding.renderer,
        slot: binding.slot, default: member.id === group.default,
        expected_guid: presetGuids[member.materials[binding.id]], actual_guid: presetGuids[chosen.materials[binding.id]]};
    }));
  });
  const files = ['Assets/steel.mat', 'Assets/warm.mat', 'Assets/mixed.mat', 'Assets/original.mat',
    'Assets/steel.mat.meta', 'Assets/warm.mat.meta', 'Assets/mixed.mat.meta',
    'Assets/_Harness/Outfit/Avatar.prefab', 'Assets/_Harness/Outfit/outfit.json', layer + '/Avatar.prefab',
    layer + '/recipe.json', layer + '/AxisPresets/presets.json', layer + '/MemberPresets/short.anim', layer + '/MemberPresets/long.anim'];
  write(join(root, 'observations/material-selection-readback.json'), JSON.stringify({
    schema: 'material-selection-readback/0.1', plan_sha256: sha(f.avhPlan), material_axis_bindings: entries,
    material_default_slots: axisGroups.flatMap((group: any) => {
      const chosen = group.members.find((member: any) => member.id === group.default);
      return group.bindings.map((binding: any) => ({
        renderer: rows.find(r => r.instance === binding.instance)!.object + '/' + binding.renderer, slot: binding.slot,
        actual_guid: presetGuids[chosen.materials[binding.id]], original_guid: guid('a')}));
    }),
    files: Object.fromEntries(files.map(path => [path, sha(readFileSync(join(root, path)))])),
  }));
}

function observeRecolor(f: Fixture, script = join(tools, 'observe_recolor.py')) {
  const out = join(f.root, 'recolor-observation.json');
  execFileSync('python3', [script, '--out', out], {env: {...process.env, PYTHONDONTWRITEBYTECODE: '1',
    AVH_PROJECT_DIR: f.root, AVH_RUN_DIR: f.root, AVH_TOOL_ROOT: join(tools, '..'), AVH_PLAN: f.avhPlan}});
  return JSON.parse(readFileSync(out, 'utf8')).metrics as Record<string, unknown>;
}

const thresholdsFile = fileURLToPath(new URL('../builtin/knowledge/process/thresholds.yaml', import.meta.url));
const processFile = fileURLToPath(new URL('../builtin/knowledge/process/pc-recolor-outfit.process.yaml', import.meta.url));
const thresholds = () => Object.fromEntries(Object.entries((parse(readFileSync(thresholdsFile, 'utf8')) as any).t)
  .map(([name, entry]: [string, any]) => [name, entry.value])) as Record<string, number>;
const definition = () => loadProcess(readFileSync(processFile, 'utf8'), parse(readFileSync(thresholdsFile, 'utf8')) as any);
/** A copy of one tool with one line replaced; the sibling modules go beside it because `plan.py` imports them by path. */
function mutate(root: string, name: string, from: string, to: string) {
  const source = readFileSync(join(tools, name), 'utf8');
  const mutant = source.replace(from, to);
  assert.notEqual(mutant, source, `${name} no longer contains the guarded line this test removes`);
  copyFileSync(join(tools, 'avatar_config.py'), join(root, 'avatar_config.py'));
  if (name !== 'plan.py') copyFileSync(join(tools, 'plan.py'), join(root, 'plan.py'));
  const path = join(root, name.replace('.py', '-mutant.py'));
  write(path, mutant);
  return path;
}

test('a pure material axis passes the plan gate, the recipe tool and every recolor check', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-axis-flow-')); t.after(() => removeTemp(root));
  const f = fixture(root);
  assert.equal(observePlan(f), true, 'the formal plan gate must accept a complete material axis with no targets');
  stage(f);
  const metrics = observeRecolor(f);
  assert.equal(metrics.unmapped_color_requirements, 0, 'an axis with no recolor targets still owes every member a landed slot');
  assert.equal(metrics.material_axis_presets_verified, true);
  assert.equal(metrics.replaced_material_slots, 2);
  assert.equal(metrics.rerun_recipe_hash_equal, true, 'the stored recipe must be what the tool produces for this plan');
  const checks = definition().checks.filter(check => check.observe === 'material.recolor');
  assert.ok(checks.length >= 17, `every recolor check is evaluated; found ${checks.length}`);
  for (const check of checks) {
    const outcome = evaluateRule(parseRule(check.rule), metrics, thresholds());
    assert.equal(outcome.result, 'pass', `${check.id}: ${check.rule} -> ${outcome.result} ${outcome.message ?? ''} ${JSON.stringify(outcome.used)}`);
  }
  // The recipe the tool wrote declares the one tier the axis can honestly offer, with no adjustments:
  // nothing authoring-side may shift a colour the axis presets already fix.
  const recipe = JSON.parse(readFileSync(join(root, layer, 'recipe.json'), 'utf8'));
  assert.deepEqual(recipe.targets, []);
  assert.deepEqual(recipe.tiers.map((tier: any) => tier.id), ['A']);
  assert.deepEqual(recipe.tiers[0].adjustments, []);
  assert.equal(recipe.chosen, 'A');
  // Removing the fix — the unconditional "targets must not be empty" gate — refuses the positive plan,
  // so the acceptance above is caused by the axis clause and not by the gate having gone quiet.
  const old = mutate(root, 'plan.py',
    "    if not recolor['targets'] and not avatar_config.material_axis(plan.get('avatar_config')):", "    if not recolor['targets']:");
  assert.equal(observePlan(f, old), false, 'without the axis clause the gate refuses a pure material axis');
  // A complete axis does not forbid ordinary targets: the two forms coexist, and the tier count still
  // follows the relative targets instead of collapsing to the axis's single tier.
  const mixed = variant(f, {...f.plan, recolor: {targets: [{part: 'eye', hue_shift: 10, saturation: 1, value: 1}], candidates: 3}});
  assert.equal(observePlan(mixed), true, 'a plan may carry an axis and ordinary targets at once');
  const mixedRecipe = writeRecipe(mixed);
  assert.equal(mixedRecipe.status, 0, mixedRecipe.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root, layer, 'recipe.json'), 'utf8')).tiers.map((tier: any) => tier.id), ['A', 'B', 'C']);
});

test('two independent axes over the same instances pass the same gates', t => {
  // Another structure of the same problem (决定记录 D-110): two material groups over the same observed
  // instances, owning different slots, with globally unique member ids and all presets consumed. A
  // mechanism that only ever saw one axis — or that let two groups claim one slot — would pass the
  // single-axis test and fail here.
  const root = mkdtempSync(join(tmpdir(), 'avh-axis-two-')); t.after(() => removeTemp(root));
  const f = fixture(root);
  const config = structuredClone(f.plan.avatar_config);
  const shade = config.groups.find((g: any) => g.kind === 'material');
  const tone = structuredClone(shade);
  tone.id = 'tone'; tone.label = '色调'; tone.default = 't_steel';
  tone.parameter = {name: 'Tone', type: 'Int', saved: true, synced: true};
  tone.bindings = [shade.bindings[0], shade.bindings[1]].map((binding: any, index: number) => ({
    ...binding, id: 't_' + binding.id, slot: binding.slot === 0 ? 1 : 0}));
  tone.members = [
    {id: 't_steel', label: 't_steel', materials: {[tone.bindings[0].id]: 'steel', [tone.bindings[1].id]: 'steel'}},
    {id: 't_mixed', label: 't_mixed', materials: {[tone.bindings[0].id]: 'mixed', [tone.bindings[1].id]: 'mixed'}},
  ];
  const two = variant(f, {...f.plan, avatar_config: {...config, groups: [...config.groups, tone]},
    menu: {...f.plan.menu, tree: [{group: 'shape'}, {group: 'shade'}, {group: 'tone'}]}});
  assert.equal(observePlan(two), true, 'two complete axes are one legal plan');
  stage(two);
  const metrics = observeRecolor(two);
  assert.equal(metrics.material_axis_presets_verified, true);
  assert.equal(metrics.unmapped_color_requirements, 0, 'every member of both axes is a landed requirement');
  // Default slots of both groups: shade slot 0/1 on the two instances, tone the other way round.
  assert.equal(metrics.replaced_material_slots, 4);
  const recipe = writeRecipe(two);
  assert.equal(recipe.status, 0, recipe.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root, layer, 'recipe.json'), 'utf8')).tiers.map((tier: any) => tier.id), ['A']);
  // The same shape with one slot owned twice is refused: the axis contract is what makes two groups
  // legal, not the number of groups.
  const clashing = structuredClone(f.plan.avatar_config);
  const clash = structuredClone(clashing.groups.find((g: any) => g.kind === 'material'));
  clash.id = 'tone'; clash.label = '色调'; clash.default = 'c_steel';
  clash.parameter = {name: 'Tone', type: 'Int', saved: true, synced: true};
  clash.bindings = clash.bindings.map((binding: any) => ({...binding, id: 'c_' + binding.id}));
  clash.members = [{id: 'c_steel', label: 'c_steel', materials: {[clash.bindings[0].id]: 'steel', [clash.bindings[1].id]: 'steel'}}];
  const clashPlan = variant(f, {...f.plan, avatar_config: {...clashing, groups: [...clashing.groups, clash]},
    menu: {...f.plan.menu, tree: [{group: 'shape'}, {group: 'shade'}, {group: 'tone'}]}});
  assert.equal(observePlan(clashPlan), false, 'two groups cannot own the same observed slot');
});

test('no targets and no usable axis stay refused by the plan gate and by the recipe tool', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-axis-none-')); t.after(() => removeTemp(root));
  const f = fixture(root);
  const none = withoutAxis(f);
  assert.equal(observePlan(none), false, 'colours in prose are not an executable plan');
  const refused = writeRecipe(none);
  assert.notEqual(refused.status, 0, 'the recipe entry point refuses it on its own');
  assert.match(refused.stderr, /独立材质轴/);
  // A declared but incomplete axis is not permission either: one member that skips a slot leaves that
  // slot with no preset to switch to, so the same refusal applies (the config contract refuses it too,
  // which is the point of there being one definition of a complete axis).
  const partial = partialAxis(f);
  assert.equal(observePlan(partial), false);
  const partialRecipe = writeRecipe(partial);
  assert.notEqual(partialRecipe.status, 0);
  assert.match(partialRecipe.stderr, /preset/);
  // Dropping the very clause the fix added makes a targetless plan executable again, so the refusal
  // above is what the clause buys rather than a property of the gate already.
  const allowed = mutate(root, 'plan.py',
    "    if not recolor['targets'] and not avatar_config.material_axis(plan.get('avatar_config')):", "    if False:");
  assert.equal(observePlan(none, allowed), true, 'with the axis requirement gone any targetless plan passes');
  // The recipe entry point carries its own copy of the rule, and its own mutant shows it is load-bearing.
  const recipeMutant = mutate(root, 'recolor.py', "    if not targets and not material_axis(plan.get('avatar_config')):", "    if False:");
  const written = writeRecipe(none, recipeMutant);
  assert.equal(written.status, 0, written.stderr);
  assert.ok(readFileSync(join(root, layer, 'recipe.json'), 'utf8').includes('"tiers"'),
    'without its guard the recipe tool would write a recipe with nothing behind it');
});

test('the observer reports every axis member as landed, and the pre-fix no-data reading fails its own check', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-axis-observe-')); t.after(() => removeTemp(root));
  const f = fixture(root);
  stage(f);
  assert.equal(observeRecolor(f).unmapped_color_requirements, 0);
  const check = definition().checks.find(c => c.id === 'recolor_source_mapped')!;
  // Before the fix a plan with no targets left this metric null, and null is `no_data`, which never
  // passes: that is why this plan shape could not clear its own recolor gate.
  const old = mutate(root, 'observe_recolor.py',
    '    wanted = relative_wanted + layer_wanted + region_wanted + material_wanted + axis_wanted',
    '    wanted = relative_wanted + layer_wanted + region_wanted + material_wanted');
  const before = observeRecolor(f, old);
  assert.equal(before.unmapped_color_requirements, null);
  assert.equal(evaluateRule(parseRule(check.rule), before, thresholds()).result, 'no_data');
  assert.equal(evaluateRule(parseRule(check.rule), observeRecolor(f), thresholds()).result, 'pass');
});
