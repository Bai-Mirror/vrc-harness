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

test('real plan submission and observation enforce activation, full input coverage and readable deviation evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-plan-activation-')); t.after(() => removeTemp(root));
  mkdirSync(join(root, '_harness/intake'), { recursive: true }); mkdirSync(join(root, '_harness/plan'));
  const items = [{ item: 'body', role: 'body', prefabs: ['Assets/Body.prefab'] },
    ...Array.from({ length: 6 }, (_, n) => ({ item: `item${n}`, role: 'outfit', prefabs: [`Assets/Part${n}.prefab`] })),
    { item: 'source', role: 'texture', prefabs: [] }].map(i => ({ ...i, found: true,
      files: i.item === 'source' ? [{ name: 'Layers.zip', selected: false }] : [{ name: i.item, sha256: 'a', selected: true }],
      layered: i.item === 'source' ? [{ path: 'Face.psd', bytes: 123 }] : [] }));
  const inventory = { schema: 'inventory/0.1', items };
  const manifest = { assets: items.map(i => ({ item: i.item, role: i.role })) };
  const inventoryPath = join(root, '_harness/intake/inventory.json');
  const rebuild = (script = join(tools, 'plan.py')) => { writeFileSync(inventoryPath, JSON.stringify(inventory)); execFileSync('python3', ['-c',
    'import sys,json,runpy;from pathlib import Path;module=runpy.run_path(sys.argv[1]);module["build_catalog"](Path(sys.argv[2]),json.loads(sys.argv[3]))',
    script, root, JSON.stringify(manifest)], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }); };
  rebuild();
  const catalogPath = join(root, '_harness/intake/plan-catalog.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  assert.equal(catalog.items.length, 8); assert.equal(catalog.ready, true);
  assert.equal(catalog.items.at(-1).availability, 'source_only'); assert.equal(catalog.items.at(-1).layered[0].path, 'Face.psd');
  assert.match(catalog.unmeasured.join(' '), /not layer tables/);
  const outfits = items.slice(1, 7).map((i, n) => ({ id: `p${n}`, item: i.item, prefab: i.prefabs[0], label: `P${n}`, activation: 'fixed' }));
  const plan = { schema: 'plan/0.2', body: 'body', body_prefab: 'Assets/Body.prefab', outfits,
    obligations: items.map(i => ({ input: i.item, role: i.role, action: 'use', target: i.item === 'body' ? i.prefabs[0] : i.item === 'source' ? 'body' : i.prefabs[0], due_stage: 'outfit' })),
    menu: { mode: 'preserve' }, face: { mode: 'preserve' }, optimization: { mode: 'preserve' },
    recolor: { targets: [{ part: 'eye', hue_shift: 0, saturation: 1, value: 1 }], candidates: 3 } };
  const observe = (p: unknown, tool = join(tools, 'plan.py')) => {
    const out = join(root, 'observed.json');
    const r = spawnSync('python3', [tool, 'observe', '--project', root, '--out', out], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AVH_MANIFEST: JSON.stringify(manifest), AVH_PLAN: JSON.stringify(p) }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(readFileSync(out, 'utf8')).metrics.plan_source_contract_valid;
  };
  assert.equal(observe(plan), true);
  assert.equal(observe({ ...plan, recolor: { candidates: 1, targets: [{ requirement_id: 'lash', layered: 'Face.psd', layer: ['lash'], color: '#123456', semantics: 'flat' }] } }), true,
    'a registered source-only package remains reachable to a layered plan');
  const exclusive = outfits.map(o => ({ ...o, activation: 'exclusive' }));
  assert.equal(observe({ ...plan, outfits: exclusive, default_outfit: 'p0' }), false);
  const menu = { mode: 'assemble', selector: { type: 'radial' }, component_policy: 'horizontal_across_outfits' };
  assert.equal(observe({ ...plan, outfits: exclusive, menu, default_outfit: 'p0' }), true);
  assert.equal(observe({ ...plan, outfits: exclusive.map(({ activation, ...o }) => o), default_outfit: 'p0' }), false, 'legacy preserve/exclusive is refused');
  const mixed = [...outfits.slice(0, 4), ...exclusive.slice(4)];
  assert.equal(observe({ ...plan, outfits: mixed, menu, default_outfit: 'p4' }), true);
  assert.equal(observe({ ...plan, outfits: mixed, menu, default_outfit: 'p0' }), false);
  assert.equal(observe({ ...plan, default_outfit: 'p0' }), false);
  assert.equal(observe({ ...plan, outfits: [{ ...outfits[0], activation: 'other' }, ...outfits.slice(1)] }), false);
  assert.equal(observe({ ...plan, outfits: outfits.slice(1), notes: 'The missing part will be mounted later' }), false);
  assert.equal(observe({ ...plan, outfits: [], notes: 'All parts are jointly worn as stated in obligations' }), false,
    'notes and obligations cannot substitute for mounted prefab entries');
  const deviation = { requirement: 'lash', why: 'Layer existence is unverified by the intake filename list', stands_in_for: 'defer', needs_orderer_acceptance: true };
  assert.equal(observe({ ...plan, deviations: [deviation] }), false);
  assert.equal(observe({ ...plan, deviations: [{ ...deviation, why: 'The component or layer does not exist' }] }), false);
  const text = readFileSync(inventoryPath, 'utf8');
  const evidence = [{ path: '_harness/intake/inventory.json', sha256: createHash('sha256').update(text).digest('hex'), quote: 'Face.psd' }];
  const reference = JSON.parse(execFileSync('python3', [join(tools, 'plan.py'), 'evidence', '--project', root, '--path', evidence[0]!.path, '--quote', 'Face.psd'], { encoding: 'utf8' }));
  assert.deepEqual(reference, evidence[0]);
  assert.equal(observe({ ...plan, deviations: [{ ...deviation, evidence }] }), true);
  for (const ref of [{ ...evidence[0], quote: 'invented reading' }, { ...evidence[0], sha256: 'old' }, { ...evidence[0], path: '_harness/../../outside.json' }])
    assert.equal(observe({ ...plan, deviations: [{ ...deviation, evidence: [ref] }] }), false);
  const prose = JSON.stringify({ why: 'I assume this component does not exist' }); writeFileSync(join(root, '_harness/plan/prose.json'), prose);
  assert.equal(observe({ ...plan, deviations: [{ ...deviation, evidence: [{ path: '_harness/plan/prose.json', sha256: createHash('sha256').update(prose).digest('hex'), quote: 'I assume' }] }] }), false);
  writeFileSync(join(root, '_harness/plan/draft.json'), JSON.stringify({ ...plan, outfits: exclusive, default_outfit: 'p0' }));
  assert.notEqual(spawnSync('python3', [join(tools, 'plan.py'), 'submit', '--project', root, '--draft', '_harness/plan/draft.json']).status, 0);
  // Remove the production guard: the exact false-positive must return through the actual observer.
  writeFileSync(join(root, 'avatar_config.py'), readFileSync(join(tools, 'avatar_config.py')));
  const mutant = join(root, 'mutant.py');
  // The guard now exempts a fixed activation rather than naming `independent`, so the mutation removes the
  // whole condition: a stale search string silently left the mutant identical to the real tool, and the
  // assertion then read the production behaviour instead of the removal it was meant to exercise.
  const guard = "if menu['mode'] == 'preserve' and (exclusive_ids or grouped and any(g['activation'] != 'fixed' for g in plan['avatar_config']['groups'])):";
  assert.ok(readFileSync(join(tools, 'plan.py'), 'utf8').includes(guard), 'the menu preservation guard this mutation removes');
  writeFileSync(mutant, readFileSync(join(tools, 'plan.py'), 'utf8').replace(guard, 'if False:'));
  assert.equal(observe({ ...plan, outfits: exclusive, default_outfit: 'p0' }, mutant), true);
  writeFileSync(mutant, readFileSync(join(tools, 'plan.py'), 'utf8').replace("        evidence = row.get('evidence')", "        continue\n        evidence = row.get('evidence')"));
  assert.equal(observe({ ...plan, deviations: [deviation] }, mutant), true, 'removing evidence checks revives the unsupported claim');
  writeFileSync(mutant, readFileSync(join(tools, 'plan.py'), 'utf8').replace("        rows.append({'item':", "        if not selected:\n            continue\n        rows.append({'item':"));
  rebuild(mutant); assert.equal(JSON.parse(readFileSync(catalogPath, 'utf8')).items.length, 7, 'removing retention reproduces source loss'); rebuild();
  writeFileSync(catalogPath, JSON.stringify({ ...catalog, items: catalog.items.slice(0, -1), ready: true }));
  assert.equal(observe(plan), false, 'claimed ready cannot erase a registered source');
  items.at(-1)!.found = false; rebuild();
  assert.equal(JSON.parse(readFileSync(catalogPath, 'utf8')).ready, false); assert.equal(observe(plan), false);
});
