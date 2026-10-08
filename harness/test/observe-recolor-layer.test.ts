import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { evaluateRule, parseRule } from '../src/process/rule.ts';
import { removeTemp } from './fixtures/platform.ts';

const TOOLS = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const python = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();
const deps = python && spawnSync('python3', ['-c', 'import numpy, PIL']).status === 0;

const RECOLOR = 'Assets/_Harness/Recolor';
const RENDERER_GUID = 'a'.repeat(32), MATERIAL_GUID = 'b'.repeat(32), OUTPUT_GUID = 'c'.repeat(32);

// Builds a project the observer can read: a plan with a layer target, the apply record, the two
// textures and the ledger row that claims the binding.
const build = (root: string) => {
  mkdirSync(join(root, RECOLOR), { recursive: true });
  writeFileSync(join(root, RECOLOR, 'Avatar.prefab'), `%YAML 1.1
--- !u!1001 &1001
PrefabInstance:
  m_Modification:
    m_Modifications:
    - target: {fileID: 400000, guid: ${RENDERER_GUID}, type: 3}
      propertyPath: m_Materials.Array.data[0]
      value: 
      objectReference: {fileID: 2100000, guid: ${MATERIAL_GUID}, type: 2}
`);
};
const makeTextures = (root: string) => execFileSync('python3', ['-c', `import sys
from PIL import Image
root = sys.argv[1]
original = Image.new('RGBA', (8, 8), (10, 20, 200, 255))
for x in range(2, 6):
    for y in range(2, 6):
        original.putpixel((x, y), (200, 180, 160, 255))
original.save(root + '/original.png')
edited = original.copy()
for x in range(2, 6):
    for y in range(2, 6):
        edited.putpixel((x, y), (91, 91, 102, 255))
edited.save(root + '/lash.png')
open(root + '/original.png.meta', 'w').write('guid: ' + 'd' * 32 + '\\n')
open(root + '/lash.png.meta', 'w').write('guid: ' + '${OUTPUT_GUID}' + '\\n')
# The mask is what makes "nothing outside the region moved" checkable by the observer instead of
# something it has to take the executor's word for.
mask = Image.new('L', (8, 8), 0)
for x in range(2, 6):
    for y in range(2, 6):
        mask.putpixel((x, y), 255)
mask.save(root + '/lash.mask.png')
`, join(root, RECOLOR)], { stdio: 'pipe' });

// The material the ledger names, with a texture property that really resolves to the produced texture.
// A ledger row on its own is the executor describing its own work, which is exactly what the observer
// must not accept as proof that the work happened.
const makeMaterial = (root: string) => {
  mkdirSync(join(root, 'Materials'), { recursive: true });
  writeFileSync(join(root, 'Materials', 'Avatar.mat'), `%YAML 1.1
--- !u!21 &2100000
Material:
  m_SavedProperties:
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: ${OUTPUT_GUID}, type: 3}
        m_Scale: {x: 1, y: 1}
`);
  writeFileSync(join(root, 'Materials', 'Avatar.mat.meta'), `guid: ${MATERIAL_GUID}\n`);
};

const runObserver = (root: string) => {
  const out = join(root, 'observation.json');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AVH_PROJECT_DIR: root, AVH_RUN_DIR: root,
    AVH_TOOL_ROOT: join(TOOLS, '..'),
    AVH_PLAN: JSON.stringify({ recolor: { targets: [{ requirement_id: 'lash', layered: 'Body/PSD/Face_default.psd',
      layer: ['eyelash '], color: '#5B5B66', semantics: 'flat' }], candidates: 1 } }) };
  execFileSync('python3', [join(TOOLS, 'observe_recolor.py'), '--out', out], { env, stdio: 'pipe' });
  return JSON.parse(readFileSync(out, 'utf8')) as { metrics: Record<string, unknown>; notes: string[] };
};

// With one candidate there is no tier that was not chosen, so requiring a section for it would only
// produce a heading with nothing under it. The gate asks whether the region and binding are right.
test('a single-candidate decision is not asked to list the candidates it did not choose', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-observe-decision-')); t.after(() => removeTemp(root));
  build(root);
  writeFileSync(join(root, RECOLOR, 'recipe.json'), JSON.stringify({ schema: 'recolor-recipe/0.2', targets: [],
    layerOps: [], tiers: [{ id: 'A', label: '方案原值', adjustments: [] }], candidates: 1, chosen: 'A', reason: '全部固定色' }));
  // Only the two sections that apply to a single candidate.
  writeFileSync(join(root, RECOLOR, '配色决策.md'), '# 配色决策\n\n## 选定档\n- A：方案原值\n\n## 理由\n全部目标是固定色。\n');
  const report = runObserver(root);
  assert.equal(report.metrics['color_decision_missing_sections'], 0,
    'the two applicable sections are present: ' + report.notes.join(' | '));

  // With more than one tier the third section is owed again, and its absence must show up.
  writeFileSync(join(root, RECOLOR, 'recipe.json'), JSON.stringify({ schema: 'recolor-recipe/0.2', targets: [],
    layerOps: [], tiers: [{ id: 'A', label: 'a', adjustments: [] }, { id: 'B', label: 'b', adjustments: [] }],
    candidates: 2, chosen: 'A', reason: 'r' }));
  assert.equal(runObserver(root).metrics['color_decision_missing_sections'], 1);
});

// The three layered checks are required for every recolour task, and a metric the observer never reports
// becomes no_data, which the engine does not treat as passing. Leaving them unset for a plan with no
// layered targets would therefore block every ordinary recolour, so zero is reported instead.
test('a plan with no layered targets still reports the layered metrics, as zero', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-observe-nolayer-')); t.after(() => removeTemp(root));
  build(root);
  const out = join(root, 'observation.json');
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AVH_PROJECT_DIR: root, AVH_RUN_DIR: root,
    AVH_TOOL_ROOT: join(TOOLS, '..'),
    AVH_PLAN: JSON.stringify({ recolor: { targets: [{ part: 'hair', hue_shift: 12, saturation: 1, value: 1 }], candidates: 3 } }) };
  execFileSync('python3', [join(TOOLS, 'observe_recolor.py'), '--out', out], { env, stdio: 'pipe' });
  const metrics = JSON.parse(readFileSync(out, 'utf8')).metrics as Record<string, unknown>;
  for (const name of ['layer_unverified_operations', 'layer_alpha_moved', 'layer_bindings_missing']) {
    assert.equal(metrics[name], 0, `${name} must be reported as zero rather than left missing`);
  }
});

// the part field instead yields null, and the report then says a requirement called "null" was missed.
test('the observer names an unmet layer requirement by its id, not as a missing part', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-observe-layer-')); t.after(() => removeTemp(root));
  build(root);
  const report = runObserver(root);
  const unmet = report.notes.find(note => note.includes('没有落到材质槽上')) ?? '';
  assert.match(unmet, /layer:lash/, 'the unmet requirement must be named by its requirement id');
  assert.doesNotMatch(unmet, /null/, 'a layer target has no part, and null is not a requirement name');
  // The apply record is what carries the product, so its absence is reported rather than passed over.
  assert.equal(report.metrics['layer_operations_verified'], null);
  assert.ok(report.notes.some(note => note.includes('layer-apply.json')), report.notes.join(' | '));
});

test('the observer independently reads back the product and the binding', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-observe-layer-ok-')); t.after(() => removeTemp(root));
  build(root);
  makeTextures(root);
  makeMaterial(root);
  const output = join(root, RECOLOR, 'lash.png');
  const mask = join(root, RECOLOR, 'lash.mask.png');
  const hash = createHash('sha256').update(readFileSync(output)).digest('hex');
  writeFileSync(join(root, RECOLOR, 'layer-apply.json'), JSON.stringify({ schema: 'layered-source-apply/0.1',
    operations: [{ requirement_id: 'lash', textureAsset: `${RECOLOR}/original.png`, outputAsset: `${RECOLOR}/lash.png`,
      outputSha256: hash, color: '#5B5B66', semantics: 'flat',
      maskAsset: `${RECOLOR}/lash.mask.png`, maskSha256: createHash('sha256').update(readFileSync(mask)).digest('hex'),
      maskPixels: 16 }] }));
  writeFileSync(join(root, RECOLOR, 'ledger.json'), JSON.stringify({ schema: 'recolor-ledger/0.1', rows: [
    { renderer: 'Body', slot: 0, part: 'layer:lash', material_guid: MATERIAL_GUID, texture_guid: OUTPUT_GUID }] }));
  const report = runObserver(root);
  assert.equal(report.metrics['layer_operations_verified'], 1, report.notes.join(' | '));
  // Alpha is what must not move: the region changed colour and nothing else about the image did.
  assert.equal(report.metrics['layer_alpha_preserved'], 1);
  // Binding is proven by reading the material, not by reading the ledger that claims it.
  assert.equal(report.metrics['layer_bindings_recorded'], 1, report.notes.join(' | '));
  // Locality and semantics are computed from the images and the mask, not reported by the executor.
  assert.equal(report.metrics['layer_outside_mask_changed'], 0, report.notes.join(' | '));
  assert.equal(report.metrics['layer_semantics_violations'], 0, report.notes.join(' | '));
  assert.equal(report.metrics['unmapped_color_requirements'], 0, 'the ledger row is in the variant');

  // A product that is not the one the executor reported is not evidence, so it must be refused.
  writeFileSync(output.replace('.png', '.png'), readFileSync(output));
  writeFileSync(join(root, RECOLOR, 'layer-apply.json'), JSON.stringify({ schema: 'layered-source-apply/0.1',
    operations: [{ requirement_id: 'lash', textureAsset: `${RECOLOR}/original.png`, outputAsset: `${RECOLOR}/lash.png`,
      outputSha256: 'e'.repeat(64), color: '#5B5B66', semantics: 'flat' }] }));
  const tampered = runObserver(root);
  assert.equal(tampered.metrics['layer_operations_verified'], 0, 'a hash mismatch must not count as verified');
  assert.ok(tampered.notes.some(note => note.includes('哈希不符')), tampered.notes.join(' | '));

  // And alpha moving is a failure of the locality the whole route rests on.
  execFileSync('python3', ['-c', `import sys
from PIL import Image
image = Image.open(sys.argv[1]).convert('RGBA')
pixel = image.getpixel((3, 3))
image.putpixel((3, 3), (pixel[0], pixel[1], pixel[2], 128))
image.save(sys.argv[1])
`, output], { stdio: 'pipe' });
  const moved = createHash('sha256').update(readFileSync(output)).digest('hex');
  writeFileSync(join(root, RECOLOR, 'layer-apply.json'), JSON.stringify({ schema: 'layered-source-apply/0.1',
    operations: [{ requirement_id: 'lash', textureAsset: `${RECOLOR}/original.png`, outputAsset: `${RECOLOR}/lash.png`,
      outputSha256: moved, color: '#5B5B66', semantics: 'flat' }] }));
  const alpha = runObserver(root);
  assert.equal(alpha.metrics['layer_alpha_preserved'], 0, 'a moved alpha channel must be caught');
  assert.ok(alpha.notes.some(note => note.includes('alpha 被改动')), alpha.notes.join(' | '));
});

// The ledger is the executor's own account of what it bound. If the observer accepted it, a run could
// report a binding it never made and pass; so the material itself has to say so.
test('a ledger row claiming a binding is refused when the material does not point at the product', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-observe-nobind-')); t.after(() => removeTemp(root));
  const layer = () => {
    build(root); makeTextures(root);
    const output = join(root, RECOLOR, 'lash.png');
    const mask = join(root, RECOLOR, 'lash.mask.png');
    writeFileSync(join(root, RECOLOR, 'layer-apply.json'), JSON.stringify({ schema: 'layered-source-apply/0.1',
      operations: [{ requirement_id: 'lash', textureAsset: `${RECOLOR}/original.png`, outputAsset: `${RECOLOR}/lash.png`,
        outputSha256: createHash('sha256').update(readFileSync(output)).digest('hex'), color: '#5B5B66', semantics: 'flat',
        maskAsset: `${RECOLOR}/lash.mask.png`, maskSha256: createHash('sha256').update(readFileSync(mask)).digest('hex'),
        maskPixels: 16 }] }));
    writeFileSync(join(root, RECOLOR, 'ledger.json'), JSON.stringify({ schema: 'recolor-ledger/0.1', rows: [
      { renderer: 'Body', slot: 0, part: 'layer:lash', material_guid: MATERIAL_GUID, texture_guid: OUTPUT_GUID }] }));
  };
  // The material exists and is named by the ledger, but its texture property points somewhere else.
  layer();
  mkdirSync(join(root, 'Materials'), { recursive: true });
  writeFileSync(join(root, 'Materials', 'Avatar.mat'), `%YAML 1.1
--- !u!21 &2100000
Material:
  m_SavedProperties:
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: ${'f'.repeat(32)}, type: 3}
`);
  writeFileSync(join(root, 'Materials', 'Avatar.mat.meta'), `guid: ${MATERIAL_GUID}\n`);
  const unbound = runObserver(root);
  assert.equal(unbound.metrics['layer_bindings_recorded'], 0, 'the ledger row must not stand in for the material');
  assert.ok(unbound.notes.some(note => note.includes('材质贴图属性没有指向产物')), unbound.notes.join(' | '));

  // And a material that does point at it counts, which is what makes the refusal above mean something.
  makeMaterial(root);
  assert.equal(runObserver(root).metrics['layer_bindings_recorded'], 1);
});

// Locality is the promise the whole layered route rests on: the author's texture changes only where the
// region is, and the observer can now check that itself rather than believing the executor's count.
test('a product changed outside its mask is caught even when the executor reports no such change', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-observe-outside-')); t.after(() => removeTemp(root));
  build(root); makeTextures(root); makeMaterial(root);
  const output = join(root, RECOLOR, 'lash.png');
  const mask = join(root, RECOLOR, 'lash.mask.png');
  // One pixel outside the mask moves, and the executor's own record still claims zero.
  execFileSync('python3', ['-c', `import sys
from PIL import Image
image = Image.open(sys.argv[1]).convert('RGBA')
image.putpixel((0, 0), (1, 2, 3, 255))
image.save(sys.argv[1])
`, output], { stdio: 'pipe' });
  writeFileSync(join(root, RECOLOR, 'layer-apply.json'), JSON.stringify({ schema: 'layered-source-apply/0.1',
    operations: [{ requirement_id: 'lash', textureAsset: `${RECOLOR}/original.png`, outputAsset: `${RECOLOR}/lash.png`,
      outputSha256: createHash('sha256').update(readFileSync(output)).digest('hex'), color: '#5B5B66', semantics: 'flat',
      maskAsset: `${RECOLOR}/lash.mask.png`, maskSha256: createHash('sha256').update(readFileSync(mask)).digest('hex'),
      maskPixels: 16, outsideChangedPixels: 0 }] }));
  writeFileSync(join(root, RECOLOR, 'ledger.json'), JSON.stringify({ schema: 'recolor-ledger/0.1', rows: [
    { renderer: 'Body', slot: 0, part: 'layer:lash', material_guid: MATERIAL_GUID, texture_guid: OUTPUT_GUID }] }));
  const report = runObserver(root);
  assert.equal(report.metrics['layer_outside_mask_changed'], 1, 'the executor reporting zero must not settle it');
  assert.ok(report.notes.some(note => note.includes('蒙版外改了')), report.notes.join(' | '));
});

// The ledger records writers, not slots, so one replaced slot can produce two rows: a relative iris
// target and a layered texture may share the same copy, which the observer documents as allowed. The
// check therefore has to compare the deduplicated slot count. Comparing the row count made it
// unsatisfiable for such a plan, and that is the shape the real run had (L1 §74, F21).
test('the ledger check passes when two writers share one replaced slot and still fails on a missed slot', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-observe-ledger-')); t.after(() => removeTemp(root));
  const knowledge = fileURLToPath(new URL('../builtin/knowledge/', import.meta.url));
  const definition = parse(readFileSync(join(knowledge, 'process/pc-recolor-outfit.process.yaml'), 'utf8'));
  const check = (definition.checks as { id: string; rule: string }[]).find(entry => entry.id === 'recolor_ledger_matches')!;
  const rule = parseRule(check.rule);
  const verdict = (metrics: Record<string, unknown>) => evaluateRule(rule, metrics, {}).result;
  // The variant, as the stage writes it: one override per changed slot, each with its own renderer.
  const writeVariant = (slots: number[]) => {
    mkdirSync(join(root, RECOLOR), { recursive: true });
    writeFileSync(join(root, RECOLOR, 'Avatar.prefab'), slots.map((slot, index) => `    - target: {fileID: ${400000 + index}, guid: ${RENDERER_GUID}, type: 3}
      propertyPath: m_Materials.Array.data[${slot}]
      value: 
      objectReference: {fileID: 2100000, guid: ${MATERIAL_GUID}, type: 2}
`).join(''));
  };
  const writeLedger = (parts: string[], slot = 0) => writeFileSync(join(root, RECOLOR, 'ledger.json'),
    JSON.stringify({ rows: parts.map(part => ({ renderer: 'Body', slot, part, material_guid: MATERIAL_GUID })) }));

  // One replaced slot, written by a relative target and a layered target: two rows, one slot.
  writeVariant([0]); writeLedger(['eye', 'layer:lash']);
  const shared = runObserver(root).metrics;
  assert.equal(shared['recolor_ledger_rows'], 2, 'the two writers produce two rows');
  assert.equal(shared['recolor_ledger_slots'], 1, 'but they replace one slot');
  assert.equal(shared['replaced_material_slots'], 1);
  assert.equal(verdict(shared), 'pass', 'a shared copy is allowed, so the stage passes');
  // Mutation: the replaced rule compared the row count, and cannot pass on this shape.
  assert.equal(evaluateRule(parseRule('recolor_ledger_rows == replaced_material_slots'), shared, {}).result, 'violation');
  // And the check is unknown, not passing, if the observer never reports the slot count.
  const unmeasured = { ...shared }; delete unmeasured['recolor_ledger_slots'];
  assert.equal(verdict(unmeasured), 'no_data');

  // Another structure with the same shape (two relative targets on one slot) is decided by the shape
  // rather than by the names in this fixture.
  writeLedger(['hair', 'eye']);
  assert.equal(verdict(runObserver(root).metrics), 'pass');

  // The control: a changed slot the ledger never mentions is still a failure.
  writeVariant([0, 1]); writeLedger(['eye']);
  const missed = runObserver(root).metrics;
  assert.equal(missed['replaced_material_slots'], 2);
  assert.equal(missed['recolor_ledger_slots'], 1);
  assert.equal(verdict(missed), 'violation', 'a replaced slot missing from the ledger still fails');
});
