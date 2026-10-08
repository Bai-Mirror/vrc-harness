// The plan side of the obligation contract, exercised through the real tool rather than a copy of its rules.
//
// A plan could previously name a product, promise in its notes to attach it, attach nothing, and pass every
// check: the obligation list that exists to catch that was outside the accepted field set, so the checks
// downstream read an empty list and reported success. These cases pin the field down together with the three
// ways a plan can still evade it — staying silent, routing a promise to a stage that never proves it, and
// contradicting its own mounting declarations.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };

// A disposition row and the plan that carries them. Typed rather than inferred so the fixture keeps
// checking against the contract when a field is added or renamed.
type Disposition = { input: string; role: string; action: string; target?: string; due_stage?: string; reason?: string };
type Plan = Record<string, unknown> & { obligations: Disposition[] };
type InventoryItem = { item: string; role: string; prefabs: string[] };

const packageZip = (archive: string, prefix: string, count: number) => `import io,zipfile,tarfile,sys
with io.BytesIO() as buf:
 with tarfile.open(fileobj=buf,mode='w:gz') as package:
  for i in range(${count}):
   b=('Assets/${prefix}/${prefix}'+str(i)+'.prefab').encode();e=tarfile.TarInfo(str(i)+'/pathname');e.size=len(b);package.addfile(e,io.BytesIO(b))
 with zipfile.ZipFile(sys.argv[1],'w') as zip: zip.writestr('${archive}.unitypackage',buf.getvalue())`;

test('a plan disposes of every registered input and cannot promise what no stage proves', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-plan-obligations-'));
  t.after(() => removeTemp(root));
  const body = join(root, 'Body_v1.zip'), outfit = join(root, 'Outfit_v1.zip'), materials = join(root, 'Materials_v1.zip');
  const project = join(root, 'project');
  execFileSync('python3', ['-c', packageZip('Body', 'Body', 3), body], { env });
  execFileSync('python3', ['-c', packageZip('Outfit', 'Outfit', 2), outfit], { env });
  execFileSync('python3', ['-c', packageZip('Materials', 'Materials', 2), materials], { env });
  const manifest = { schema: 'manifest/0.1', request: '雪花浪漫与黑丝', assets: [
    { item: body, name: 'Body_v1.zip', role: 'body', store: 'client' },
    { item: outfit, name: 'Outfit_v1.zip', role: 'outfit', store: 'client' },
    { item: materials, name: 'Materials_v1.zip', role: 'texture', store: 'client' }] };
  const runEnv = { ...env, AVH_MANIFEST: JSON.stringify(manifest) };
  execFileSync('python3', [join(tools, 'intake.py'), '--library', root, '--project', project], { env: runEnv });
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8'));
  assert.equal(inventory.items.length, 3, 'the fixture registers exactly three inputs');
  const itemOf = (path: string) => (inventory.items as InventoryItem[]).find(i => i.item === path);
  const bodyItem = itemOf(body)!, outfitItem = itemOf(outfit)!, textureItem = itemOf(materials)!;
  assert.ok(bodyItem?.prefabs.length && outfitItem?.prefabs.length, 'body and outfit must expose a prefab');
  assert.equal(bodyItem.role, 'body'); assert.equal(outfitItem.role, 'outfit'); assert.equal(textureItem.role, 'texture');
  const [bodyPrefab] = bodyItem.prefabs, [outfitPrefab] = outfitItem.prefabs;

  const observed = join(root, 'observed.json');
  // The real observer runs the same validation the plan stage gates on.
  const observe = (plan: Record<string, unknown>) => {
    const result = spawnSync('python3', [join(tools, 'plan.py'), 'observe', '--out', observed, '--project', project],
      { env: { ...runEnv, AVH_PLAN: JSON.stringify(plan) }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(observed, 'utf8'));
    return { valid: report.metrics.plan_source_contract_valid, note: (report.notes ?? []).join(' ') };
  };
  const mutation = (plan: Plan, change: (rows: Disposition[]) => Disposition[]) =>
    observe({ ...plan, obligations: change(plan.obligations) });

  const dispositions: Disposition[] = [
    { input: body, role: 'body', action: 'use', target: bodyPrefab, due_stage: 'outfit' },
    { input: outfit, role: 'outfit', action: 'use', target: outfitPrefab, due_stage: 'outfit' },
    { input: materials, role: 'texture', action: 'use', target: outfit, due_stage: 'outfit' }];
  const plan: Plan = { schema: 'plan/0.2', client_gallery: false, body, body_prefab: bodyPrefab,
    outfits: [{ id: 'snow', item: outfit, prefab: outfitPrefab, label: '雪' }], default_outfit: 'snow',
    unused: [], obligations: dispositions, menu: { mode: 'assemble', selector: { type: 'radial' }, component_policy: 'horizontal_across_outfits' },
    recolor: { targets: [{ part: 'outfit:snow', hue_shift: 12, saturation: 1, value: 1 }], candidates: 3 },
    optimization: { mode: 'preserve' }, face: { mode: 'preserve' }, notes: '结构合法' };

  const accepted = observe(plan);
  assert.equal(accepted.valid, true, 'a plan that disposes of every input must be accepted: ' + accepted.note);

  // Silence is not a disposition: the field is required, and every registered input must appear in it.
  const silent: Record<string, unknown> = { ...plan }; delete silent.obligations;
  assert.equal(observe(silent).valid, false, 'a plan with no obligations must be refused');
  assert.equal(observe({ ...plan, obligations: [] }).valid, false, 'an empty obligation list must be refused');
  assert.equal(mutation(plan, rows => rows.slice(0, 2)).valid, false, 'a registered input left out must be refused');

  // A real stage id is not enough: the stage also has to turn the promise into an artifact postcondition.
  for (const stage of ['package', 'recolor', 'build']) {
    const value = mutation(plan, rows => [{ ...rows[0], due_stage: stage }, ...rows.slice(1)]);
    assert.equal(value.valid, false, `a use routed to ${stage} must be refused: no check reads it there`);
  }

  for (const [what, rows] of ([
    ['an obligation with no input', [{ ...dispositions[0]!, input: '' }, ...dispositions.slice(1)]],
    ['an input that was never registered', [{ ...dispositions[0], input: join(root, 'Ghost.zip') }, ...dispositions.slice(1)]],
    ['two obligations for one input', [dispositions[0], { ...dispositions[0] }, ...dispositions.slice(1)]],
    ['a role that contradicts the intake record', [{ ...dispositions[0], role: 'prop' }, ...dispositions.slice(1)]],
    ['an outfit restated as another role', [dispositions[0], { ...dispositions[1], role: 'other', target: body }, dispositions[2]]],
    ['an unknown action', [{ ...dispositions[0], action: 'maybe' }, ...dispositions.slice(1)]],
    ['a use with no target', [{ ...dispositions[0], target: '' }, ...dispositions.slice(1)]],
    ['an exclusion with no reason', [{ ...dispositions[0], action: 'exclude', target: undefined, reason: '' }, ...dispositions.slice(1)]],
    ['an undeclared extra field', [{ ...dispositions[0], note: 'extra' }, ...dispositions.slice(1)]]] as [string, Disposition[]][])) {
    assert.equal(mutation(plan, () => rows).valid, false, `${what} must be refused`);
  }

  // The obligation is a projection of what the plan already declares, not a second ledger.
  assert.equal(mutation(plan, rows => [rows[0], { ...rows[1], action: 'exclude', reason: 'overlap' }, rows[2]]).valid, false,
    'an input the plan mounts cannot be excluded by its obligation');
  const unusedConflict = { ...plan, outfits: [], default_outfit: null,
    recolor: { targets: [{ part: 'hair', hue_shift: 12, saturation: 1, value: 1 }], candidates: 3 },
    unused: [{ item: outfit, reason: 'overlap', note: 'duplicate' }],
    obligations: [dispositions[0], { ...dispositions[2], target: body },
      { ...dispositions[1], action: 'exclude', target: undefined, reason: 'overlap' }] };
  assert.equal(observe(unusedConflict).valid, true,
    'an input called unused is legitimately excluded: ' + observe(unusedConflict).note);
  assert.equal(observe({ ...plan, unused: [{ item: outfit, reason: 'overlap', note: 'duplicate' }] }).valid, false,
    'an input called unused cannot also be promised as used');

  // A package with no postcondition of its own is proved by the input that carries it, and the carrier has
  // to be something this stage actually checks. Promising that a texture applies would be unfalsifiable.
  const [d0, d1, d2] = dispositions;
  for (const [what, rows] of ([
    ['names no carrier', [d0, d1, { ...d2, target: '' }]],
    ['names an unregistered carrier', [d0, d1, { ...d2, target: join(root, 'Ghost.zip') }]],
    ['names a carrier that is itself excluded', [{ ...d0, action: 'exclude', target: undefined, reason: 'not this order' }, d1, { ...d2, target: body }]],
    ['names itself', [d0, d1, { ...d2, target: materials }]],
    ['names a carrier that is only deferred', [d0, d1, { ...d2, target: materials }]]] as [string, Disposition[]][])) {
    assert.equal(mutation(plan, () => rows).valid, false, `a package that ${what} must be refused`);
  }
});
