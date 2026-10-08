import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: tools };

const relative = { part: 'hair', hue_shift: 10, saturation: 1, value: 1 };
const layer = { requirement_id: 'lash', layered: 'Body/PSD/Face.psd', layer: ['eyelash'], color: '#5B5B66', semantics: 'flat' };
const material = { requirement_id: 'pink', outfit: 'winter', material: 'Assets/Vendor/Bag/Pink.mat' };
const region = { requirement_id: 'eye_left', region: { renderer: 'Body', submesh: 0, bones: ['eye.L'] },
  color: '#3E6FD9', semantics: 'flat' };

// The recipe entry as the runtime runs it: recolor.py is its own command, handed the plan through the
// environment. It is reachable without the plan gate (observe_recolor.py re-runs build_recipe over the
// stored plan and this lane's material route passes targets straight through), so the counterexamples
// below are aimed at this entry rather than at the gate above it.
function recipeFor(targets: unknown[], script: string) {
  const project = mkdtempSync(join(tmpdir(), 'avh-recipe-entry-'));
  try {
    const result = spawnSync('python3', [script], { env: { ...env, AVH_PROJECT_DIR: project,
      AVH_PLAN: JSON.stringify({ recolor: { targets, candidates: 3 } }) }, encoding: 'utf8' });
    const written = join(project, 'Assets/_Harness/Recolor/recipe.json');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      recipe: result.status === 0 ? JSON.parse(readFileSync(written, 'utf8')) : null };
  } finally { removeTemp(project); }
}

test('the recipe entry refuses non-object, mixed and duplicated targets on its own', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-recipe-mutants-'));
  t.after(() => removeTemp(root));
  const production = join(tools, 'recolor.py');
  const run = (targets: unknown[], script = production) => recipeFor(targets, script);

  // A positive control: all four legal forms still build one recipe, so a refusal below is the entry
  // checking the shape rather than refusing everything.
  const accepted = run([relative, layer, material, region]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(accepted.recipe.targets.map((row: { part: string }) => row.part), ['hair']);
  assert.deepEqual(accepted.recipe.layerOps, [layer]);
  assert.deepEqual(accepted.recipe.materialOps, [material]);
  assert.deepEqual(accepted.recipe.regionOps, [region]);

  for (const [name, targets] of [
    ['null', [null]], ['number', [1]], ['string', ['x']], ['list', [['lash']]], ['boolean', [true]],
    ['a legal target carrying an illegal element', [layer, null]],
    ['a material target that also carries a part and a colour', [{ ...material, part: 'hair', color: '#123456' }]],
    ['a material target carrying a spare field', [{ ...material, note: 'x' }]],
    ['a layered target that also names a material', [{ ...layer, material: material.material }]],
    // A region has to name every part of itself: whoever resolves it would otherwise supply a default that
    // nobody agreed to, which is how a rectangle over half the sheet becomes "the left eye".
    ['a region with no bones', [{ ...region, region: { renderer: 'Body', submesh: 0, bones: [] } }]],
    ['a region with a bone that is not a name', [{ ...region, region: { renderer: 'Body', submesh: 0, bones: [7] } }]],
    ['a region whose submesh is not a whole number', [{ ...region, region: { renderer: 'Body', submesh: 1.5, bones: ['eye.L'] } }]],
    ['a region carrying a spare field', [{ ...region, region: { renderer: 'Body', submesh: 0, bones: ['eye.L'], side: 'left' } }]],
    ['a region that also names a part', [{ ...region, part: 'eye' }]],
  ] as [string, unknown[]][]) {
    const refused = run(targets);
    assert.equal(refused.status, 1, name + ' must be refused; stdout: ' + refused.stdout);
    assert.match(refused.stderr, /每个配色目标都必须是对象|Invalid recolor material target fields|Invalid recolor region target fields|区域目标字段不对|region of exactly|至少一个骨骼|submesh|bone/, name);
  }

  // The ids are what the observer matches against the order's fixed colours, so one id cannot be
  // claimed by two forms at once.
  const duplicate = run([layer, { ...material, requirement_id: 'lash' }]);
  assert.equal(duplicate.status, 1, 'one requirement_id claimed by two forms must be refused');
  assert.match(duplicate.stderr, /Duplicate requirement_id/);

  // Removing each guard from production must revive the acceptance it prevents. The mutants are copies:
  // other test files import recolor.py while these run, so production is never edited in place.
  const source = readFileSync(production, 'utf8');
  const mutations: [string, string, string, unknown[]][] = [
    ['classification guard', '    parts, materials, layers, regions = classify_recolor_targets(targets)',
      "    parts = [t for t in targets if isinstance(t, dict) and 'part' in t]\n" +
      "    materials = [t for t in targets if isinstance(t, dict) and 'material' in t]\n" +
      "    regions = [t for t in targets if isinstance(t, dict) and 'region' in t]\n" +
      "    layers = [t for t in targets if isinstance(t, dict) and not ({'part', 'material', 'region'} & set(t))]",
      [null]],
    ['material field set', 'validate_material_target(target)', 'pass',
      [{ ...material, part: 'hair', color: '#123456' }]],
    ['cross-form requirement_id', "claim_requirement_id(target, seen, 'material')", 'pass',
      [layer, { ...material, requirement_id: 'lash' }]],
  ];
  for (const [name, from, to, targets] of mutations) {
    assert.ok(source.includes(from), name + ': the mutation anchor must exist in production recolor.py');
    const mutant = join(root, 'recolor-' + name.replace(/[^a-z]+/g, '-') + '.py');
    writeFileSync(mutant, source.replace(from, to));
    const revived = run(targets, mutant);
    assert.equal(revived.status, 0, name + ': without the guard the target must be accepted again; stderr: ' + revived.stderr);
  }
});
