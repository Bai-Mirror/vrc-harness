import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { evaluateRule, parseRule } from '../src/process/rule.ts';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor, FIXTURE_RUN_DIRECTORY } from './fixtures/unity-slot.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const toolRoot = fileURLToPath(new URL('../builtin/tools/', import.meta.url));
const knowledge = fileURLToPath(new URL('../builtin/knowledge/', import.meta.url));

// The plan the fixture runs the stage with, and the same one the observer is asked about afterwards. The eye
// sheet is on one surface and the sheet that is larger than its import cap on another, so one run exercises
// both the ordinary case and the critical triangles; the two shaded surfaces are the other promise, on a
// uniform author colour and on a gradient, because a fixture that only asked for flat never exercised it.
const plan = { recolor: { candidates: 1, targets: [
  { requirement_id: 'eye_left', region: { renderer: '_Outfit/Body', submesh: 0, bones: ['eye.L'] }, color: '#3E6FD9', semantics: 'flat' },
  { requirement_id: 'eye_right', region: { renderer: '_Outfit/Body', submesh: 0, bones: ['eye.R'] }, color: '#C8A24A', semantics: 'flat' },
  { requirement_id: 'eye_big', region: { renderer: '_Outfit/Big', submesh: 0, bones: ['eye.L'] }, color: '#3E6FD9', semantics: 'flat' },
  { requirement_id: 'eye_edge', region: { renderer: '_Outfit/Big', submesh: 0, bones: ['eye.C'] }, color: '#7A2E8C', semantics: 'flat' },
  { requirement_id: 'shade_left', region: { renderer: '_Outfit/Shade', submesh: 0, bones: ['eye.L'] }, color: '#3E6FD9', semantics: 'shade' },
  { requirement_id: 'shade_right', region: { renderer: '_Outfit/Shade', submesh: 0, bones: ['eye.R'] }, color: '#C8A24A', semantics: 'shade' },
  { requirement_id: 'grad_left', region: { renderer: '_Outfit/Grad', submesh: 0, bones: ['eye.L'] }, color: '#3E6FD9', semantics: 'shade' },
  { requirement_id: 'grad_right', region: { renderer: '_Outfit/Grad', submesh: 0, bones: ['eye.R'] }, color: '#C8A24A', semantics: 'shade' }] } };

// What the two ends must agree on after a real editor has exported the mesh. The masks are compared pixel for
// pixel against a region the observer derives from the plan's own bones, so the C# rasteriser and the Python
// one have to agree on the critical triangle as well as on the ordinary islands.
const REGION_CHECKS = ['recolor_region_verified', 'recolor_region_mask_from_mesh', 'recolor_region_local',
  'recolor_region_disjoint', 'recolor_region_ambiguity_reported', 'recolor_region_alpha_preserved',
  'recolor_region_semantics', 'recolor_region_bound', 'recolor_region_record_matches',
  'recolor_region_transparent_untouched', 'recolor_region_write_isolated'];

// The synthetic fixtures decide whether the rule is implemented; only a real editor decides whether the mesh
// Unity actually imported gives the same answer. This builds a skinned mesh with two islands, a triangle whose
// edge function only float64 puts outside a pixel, and a triangle with zero area, runs the stage, checks the
// product, the record, the ledger and the refusals against real textures, and then reads the whole thing back
// with the shipped observer.
//
// The project is created from the frozen baseline's packages only, so the first launch pays a full cold import
// of the SDK, lilToon, MA and NDMF; under machine load that is minutes, and the bound is set for that rather
// than for the stage, which itself takes seconds.
test('real Unity derives both iris regions from the mesh and refuses what cannot be told apart',
  { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 2700000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-region-unity-'));
  const runDir = join(root, FIXTURE_RUN_DIRECTORY);
  t.after(() => { if (!process.env.AVH_REGION_KEEP_PROJECT) removeTemp(root); });
  console.log('Region integration evidence: ' + root);
  for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
  execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',
    join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
  writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
  copyFileSync(fileURLToPath(new URL('./fixtures/unity/RecolorRegionIntegration.cs', import.meta.url)), join(root, 'Assets/Editor/RecolorRegionIntegration.cs'));
  let activePlan = plan;
  const unity = (log: string, method = 'Run') => execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root,
    '-executeMethod', `AVH.Harness.RecolorRegionIntegration.${method}`, '-logFile', join(root, log)],
    { env: { ...process.env, AVH_PROJECT_DIR: root, AVH_RUN_DIR: runDir, AVH_PLAN: JSON.stringify(activePlan) }, timeout: 2100000, windowsHide: true, stdio: 'pipe' });
  try { unity('unity.log'); } catch (error) {
    // The log only exists once the editor actually started; a launch that never got that far must still say why
    // rather than replacing its own message with a file-not-found from the diagnostic itself.
    const log = join(root, 'unity.log');
    const excerpt = existsSync(log) ? (readFileSync(log, 'utf8').match(/.*(?:error CS|Exception|failed).*/g)?.slice(-12).join('\n') ?? '') : '';
    assert.fail([String(error), excerpt].filter(Boolean).join('\n'));
  }
  const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
  assert.equal(result.ok, true, result.error);
  activePlan = JSON.parse(readFileSync(join(root, 'fixture-plan.json'), 'utf8'));
  assert.ok((activePlan.recolor.targets as { region: { renderer: string } }[]).some(target => target.region.renderer.includes('ImportedModel')),
    'the real FBX inherited renderer must be an actual region target');
  // The fixture's own assertions, counted so a silent early exit cannot look like a pass.
  assert.equal(result.assertions, 58, 'every fixture assertion must have run');
  assert.ok(!/error CS/.test(readFileSync(join(root, 'unity.log'), 'utf8')), 'the stage must compile cleanly');
  const materialReadback = JSON.parse(readFileSync(join(runDir, 'observations/material-selection-readback.json'), 'utf8'));
  assert.equal(materialReadback.region_bindings?.schema, 'region-binding-readback/0.1');
  assert.equal(materialReadback.region_bindings?.declared?.length, 4, 'every region output has a declared surface');
  assert.equal(materialReadback.region_bindings?.actual?.length, 4, 'Unity must enumerate the complete actual output set');
  assert.ok(Object.keys(materialReadback.region_bindings?.files ?? {}).some(path => path.toLowerCase().endsWith('.fbx')),
    'the independent dependency set must include the real imported FBX model');

  // And the shipped observer over the real project: the region it derives from the plan's bones has to be the
  // mask the stage wrote, pixel for pixel, on both surfaces.
  const out = join(runDir, 'observation.json');
  execFileSync('python3', [join(tools, 'observe_recolor.py'), '--out', out], { env: { ...process.env,
    PYTHONDONTWRITEBYTECODE: '1', AVH_PROJECT_DIR: root, AVH_RUN_DIR: runDir, AVH_TOOL_ROOT: toolRoot,
    AVH_PLAN: JSON.stringify(activePlan) }, stdio: 'pipe' });
  const report = JSON.parse(readFileSync(out, 'utf8')) as { metrics: Record<string, unknown>; notes: string[]; proof: Record<string, unknown> };
  const definition = parse(readFileSync(join(knowledge, 'process/pc-recolor-outfit.process.yaml'), 'utf8'));
  const verdicts = Object.fromEntries([...REGION_CHECKS, 'recolor_ledger_matches'].map(id => {
    const check = (definition.checks as { id: string; rule: string }[]).find(entry => entry.id === id)!;
    return [id, evaluateRule(parseRule(check.rule), report.metrics, {}).result as string];
  }));
  assert.deepEqual(Object.entries(verdicts).filter(([, verdict]) => verdict !== 'pass'), [], report.notes.join(' | '));
  assert.equal(report.metrics['region_operations_verified'], 8, report.notes.join(' | '));
  assert.equal(report.metrics['region_ambiguous_pixels'], 0);
  // The region report carries the recursive dependency set, so changing a referenced prefab or material after
  // Unity wrote the readback must make the published observer refuse the otherwise unchanged binding result.
  for (const suffix of ['.prefab', '.mat']) {
    const dependency = Object.keys(materialReadback.region_bindings.files).find(path => path.endsWith(suffix));
    assert.ok(dependency, `the recursive region readback must include a ${suffix} dependency`);
    const absolute = join(root, dependency!);
    const original = readFileSync(absolute);
    writeFileSync(absolute, Buffer.concat([original, Buffer.from('\n# changed after Unity readback\n')]));
    try {
      const staleOut = join(runDir, `observation-stale-${suffix.slice(1)}.json`);
      execFileSync('python3', [join(tools, 'observe_recolor.py'), '--out', staleOut], { env: { ...process.env,
        PYTHONDONTWRITEBYTECODE: '1', AVH_PROJECT_DIR: root, AVH_RUN_DIR: runDir, AVH_TOOL_ROOT: toolRoot,
        AVH_PLAN: JSON.stringify(activePlan) }, stdio: 'pipe' });
      const stale = JSON.parse(readFileSync(staleOut, 'utf8')) as { metrics: Record<string, unknown>; notes: string[] };
      const bound = evaluateRule(parseRule((definition.checks as { id: string; rule: string }[])
        .find(entry => entry.id === 'recolor_region_bound')!.rule), stale.metrics, {}).result as string;
      assert.notEqual(bound, 'pass', `${suffix} changed after readback must fail: ${stale.notes.join(' | ')}`);
    } finally { writeFileSync(absolute, original); }
  }
  // The critical triangle's own reading on the real mesh: one pixel more if the edge function is float32, four
  // more if a triangle with zero area is allowed to fill its bounding box.
  const edge = (report.proof['region_readback'] as { requirement_id: string; regionPixels: number }[])
    .find(row => row.requirement_id === 'eye_edge')!;
  assert.equal(edge.regionPixels, 1225, 'the critical triangle covers 1225 pixels in float64');
  const big = (report.proof['region_readback'] as { requirement_id: string; regionPixels: number }[])
    .find(row => row.requirement_id === 'eye_big')!;
  assert.equal(big.regionPixels, 1024 * 1024, 'the big island covers 1024x1024 pixels at 4096');

  // The shaded regions on the real project: four pixels each, shaded to the target, and the two surfaces differ
  // because their author colours do. The values are the ones the fixture checked by hand.
  const shade = (report.proof['region_readback'] as { requirement_id: string; meanAfter: number[]; regionPixels: number }[])
    .find(row => row.requirement_id === 'shade_left')!;
  assert.deepEqual(shade.meanAfter, [57, 102, 200], report.notes.join(' | '));
  const gradient = (report.proof['region_readback'] as { requirement_id: string; meanAfter: number[] }[])
    .find(row => row.requirement_id === 'grad_left')!;
  assert.notDeepEqual(gradient.meanAfter, shade.meanAfter, 'a gradient under shade is not the uniform author colour');
  assert.notDeepEqual(gradient.meanAfter, [0x3e, 0x6f, 0xd9], 'a shaded gradient is not the flat target colour');

  // Mutation: with the pre-fix expression — the original pixel's channels scaled instead of the target's — the
  // same real project is refused, so the pass above rests on the corrected formula and not on the fixture.
  const source = readFileSync(join(tools, 'observe_recolor.py'), 'utf8');
  const anchor = `    return numpy.clip(numpy.floor(aim[None, :] * ratio[:, None] + 0.5), 0, 255).astype(numpy.int16)`;
  assert.ok(source.includes(anchor), 'the mutation target must exist in the shipped observer');
  const mutant = join(root, 'observe_original_scaled.py');
  writeFileSync(mutant, source.replace(anchor,
    `    return numpy.clip(numpy.floor(before[core][:, :3].astype(numpy.float64) * ratio[:, None] + 0.5), 0, 255).astype(numpy.int16)`));
  const mutatedOut = join(root, 'observation-old-formula.json');
  execFileSync('python3', [mutant, '--out', mutatedOut], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1',
    AVH_PROJECT_DIR: root, AVH_RUN_DIR: root, AVH_TOOL_ROOT: toolRoot, AVH_PLAN: JSON.stringify(activePlan) }, stdio: 'pipe' });
  const old = JSON.parse(readFileSync(mutatedOut, 'utf8')) as { metrics: Record<string, unknown> };
  assert.ok(Number(old.metrics['region_semantics_violations']) > 0,
    'the original-scaled formula has to refuse the real shaded regions');

  const outputGuids = new Set((materialReadback.region_bindings.declared as { output_guid: string }[]).map(row => row.output_guid));
  const damaged = (method: 'transform' | 'extra-surface' | 'particle-surface', expectedActual: (rows: { renderer: string; slot: number; texture_guid: string }[]) => void) => {
    unity(`unity-${method}.log`, method === 'transform' ? 'DamageTransform' : method === 'particle-surface' ? 'DamageParticleSurface' : 'DamageExtraSurface');
    const damage = JSON.parse(readFileSync(join(root, 'damage-result.json'), 'utf8')) as { ok: boolean; error?: string; transformOverride?: boolean };
    assert.equal(damage.ok, true, damage.error);
    if (method === 'transform') assert.equal(damage.transformOverride, true, 'the damage must serialize the same-object Transform target');
    const readback = JSON.parse(readFileSync(join(runDir, 'observations/material-selection-readback.json'), 'utf8'));
    expectedActual(readback.region_bindings.actual);
    const out = join(runDir, `observation-${method}.json`);
    execFileSync('python3', [join(tools, 'observe_recolor.py'), '--out', out], { env: { ...process.env,
      PYTHONDONTWRITEBYTECODE: '1', AVH_PROJECT_DIR: root, AVH_RUN_DIR: runDir, AVH_TOOL_ROOT: toolRoot,
      AVH_PLAN: JSON.stringify(activePlan) }, stdio: 'pipe' });
    const report = JSON.parse(readFileSync(out, 'utf8')) as { metrics: Record<string, unknown>; notes: string[] };
    const bound = evaluateRule(parseRule((definition.checks as { id: string; rule: string }[])
      .find(entry => entry.id === 'recolor_region_bound')!.rule), report.metrics, {}).result as string;
    assert.notEqual(bound, 'pass', `${method} damage must fail the formal binding gate: ${report.notes.join(' | ')}`);
  };
  damaged('transform', rows => assert.equal(rows.some(row => outputGuids.has(row.texture_guid)), false,
    'a Transform-targeted override must not appear as a Renderer output binding'));
  const declaredSurfaces = new Set((materialReadback.region_bindings.declared as { renderer: string; slot: number }[])
    .map(row => `${row.renderer}#${row.slot}`));
  damaged('extra-surface', rows => assert.ok(rows.some(row => outputGuids.has(row.texture_guid)
    && !declaredSurfaces.has(`${row.renderer}#${row.slot}`)),
    'the real output set must contain a surface outside the declared ledger set'));
  damaged('particle-surface', rows => assert.ok(rows.some(row => outputGuids.has(row.texture_guid)
    && row.renderer.includes('UnledgeredParticle')),
    'the particle renderer output must be present in the actual set'));
});
