import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };

// A package that ships a layered working file, so the inventory records one and a layer target has
// something real to name.
const bodyZip = `import io,sys,tarfile,zipfile
with io.BytesIO() as buf:
  with tarfile.open(fileobj=buf,mode='w:gz') as package:
    for i in range(3):
      b=('Assets/Body/Body'+str(i)+'.prefab').encode(); e=tarfile.TarInfo(str(i)+'/pathname'); e.size=len(b); package.addfile(e,io.BytesIO(b))
  with zipfile.ZipFile(sys.argv[1],'w') as archive:
    archive.writestr('Body.unitypackage',buf.getvalue())
    archive.writestr('Body/PSD/Face_default.psd',b'8BPS not a real psd')`;

const outfitZip = `import io,sys,tarfile,zipfile
with io.BytesIO() as buf:
  with tarfile.open(fileobj=buf,mode='w:gz') as package:
    for i in range(2):
      b=('Assets/Outfit/Outfit'+str(i)+'.prefab').encode(); e=tarfile.TarInfo(str(i)+'/pathname'); e.size=len(b); package.addfile(e,io.BytesIO(b))
  with zipfile.ZipFile(sys.argv[1],'w') as archive: archive.writestr('Outfit.unitypackage',buf.getvalue())`;

test('a plan may name a vendor layer as a colour region and cannot name one that is not there', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-plan-layer-'));
  t.after(() => removeTemp(root));
  const body = join(root, 'Body_v1.zip'), outfit = join(root, 'Outfit_v1.zip'), project = join(root, 'project');
  execFileSync('python3', ['-c', bodyZip, body], { env });
  execFileSync('python3', ['-c', outfitZip, outfit], { env });
  const manifest = { schema: 'manifest/0.1', request: '按层改睫毛', assets: [
    { item: body, name: 'Body_v1.zip', role: 'body', store: 'client' },
    { item: outfit, name: 'Outfit_v1.zip', role: 'outfit', store: 'client' }] };
  const runEnv = { ...env, AVH_MANIFEST: JSON.stringify(manifest) };
  execFileSync('python3', [join(tools, 'intake.py'), '--library', root, '--project', project], { env: runEnv });
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8'));
  const layered = inventory.items.flatMap((i: { layered: { path: string }[] }) => i.layered ?? []);
  assert.deepEqual(layered.map((row: { path: string }) => row.path), ['Body/PSD/Face_default.psd'],
    'the fixture must register exactly the layered file the plan will name');
  const bodyItem = inventory.items.find((i: { role: string }) => i.role === 'body');
  const outfitItem = inventory.items.find((i: { role: string }) => i.role === 'outfit');
  const [bodyPrefab] = bodyItem.prefabs, [outfitPrefab] = outfitItem.prefabs;

  const observed = join(root, 'observed.json');
  const observe = (plan: Record<string, unknown>) => {
    const result = spawnSync('python3', [join(tools, 'plan.py'), 'observe', '--out', observed, '--project', project],
      { env: { ...runEnv, AVH_PLAN: JSON.stringify(plan) }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(observed, 'utf8'));
    return { valid: report.metrics.plan_source_contract_valid as boolean, note: (report.notes ?? []).join(' ') };
  };
  const layer = (over: Record<string, unknown> = {}) => ({ requirement_id: 'lash', layered: 'Body/PSD/Face_default.psd',
    layer: ['eyelash '], color: '#5B5B66', semantics: 'flat', ...over });
  const plan = (targets: unknown[]) => ({ schema: 'plan/0.2', client_gallery: false, body, body_prefab: bodyPrefab,
    outfits: [{ id: 'snow', item: outfit, prefab: outfitPrefab, label: '雪' }], default_outfit: 'snow', unused: [],
    obligations: [
      { input: body, role: 'body', action: 'use', target: bodyPrefab, due_stage: 'outfit' },
      { input: outfit, role: 'outfit', action: 'use', target: outfitPrefab, due_stage: 'outfit' }],
    menu: { mode: 'assemble', selector: { type: 'radial' }, component_policy: 'horizontal_across_outfits' }, recolor: { targets, candidates: 3 },
    optimization: { mode: 'preserve' }, face: { mode: 'preserve' }, notes: '结构合法' });

  const accepted = observe(plan([layer()]));
  assert.equal(accepted.valid, true, 'a layer target naming a registered source must be accepted: ' + accepted.note);

  // Every candidate must satisfy the hard constraints before anyone picks one, so an order made only
  // of fixed colours has nothing to vary and one candidate is correct rather than a shortcut.
  const single = { ...plan([layer()]), recolor: { targets: [layer()], candidates: 1 } };
  assert.equal(observe(single).valid, true, 'a single candidate is right when every colour is fixed');
  const singleRelative = { ...plan([{ part: 'hair', hue_shift: 10, saturation: 1, value: 1 }]), recolor:
    { targets: [{ part: 'hair', hue_shift: 10, saturation: 1, value: 1 }], candidates: 1 } };
  assert.equal(observe(singleRelative).valid, false, 'a relative target still varies, so one candidate is refused');

  const material = { requirement_id: 'bag_pink', outfit: 'snow', material: 'Assets/Vendor/Bag/Pink.mat' };
  const materialPlan = { ...plan([material]), recolor: { targets: [material], candidates: 1 } };
  assert.equal(observe(materialPlan).valid, true, 'a material target must survive independent plan observation');
  const draftDir = join(project, '_harness/plan');
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;Path(sys.argv[1]).mkdir(parents=True,exist_ok=True)', draftDir]);
  writeFileSync(join(draftDir, 'draft.json'), JSON.stringify(materialPlan));
  const submitted = spawnSync('python3', [join(tools, 'plan.py'), 'submit', '--project', project, '--draft', '_harness/plan/draft.json'], { env: runEnv, encoding: 'utf8' });
  assert.equal(submitted.status, 0, submitted.stderr);
  assert.equal(JSON.parse(submitted.stdout).technicalFitVerified, false, 'structure must not certify unobserved slots');
  const recipe = JSON.parse(execFileSync('python3', ['-c', 'import sys,json;sys.path.insert(0,sys.argv[1]);import recolor;print(recolor.serialize(recolor.build_recipe(json.loads(sys.argv[2]),"")))', tools, JSON.stringify(materialPlan)], { encoding: 'utf8' }));
  assert.deepEqual(recipe.materialOps, [material]); assert.deepEqual(recipe.targets, []); assert.deepEqual(recipe.layerOps, []);
  for (const over of [{ outfit: 'missing' }, { material: '../outside.mat' }, { material: '_harness/Bag.mat' }, { part: 'hair' }, { color: '#123456' }, { requirement_id: '' }])
    assert.equal(observe({ ...materialPlan, recolor: { targets: [{ ...material, ...over }], candidates: 1 } }).valid, false,
      'invalid material form: ' + JSON.stringify(over));

  // Whether a layer path exists in the file is an execution-time question, answered by resolving it
  // against the PSD (see test/layer-source.test.ts). What planning can check is that the path is
  // well formed, so a blank name is refused here and a merely trimmed one is not this stage's call.
  assert.equal(observe(plan([layer({ layer: [' '] })])).valid, false, 'a blank layer name must be refused');
  assert.equal(observe(plan([layer({ layer: [] })])).valid, false, 'an empty layer path must be refused');
  assert.equal(observe(plan([layer({ layered: 'Body/PSD/Ghost.psd' })])).valid, false,
    'a layered source that was never registered must be refused');
  assert.equal(observe(plan([layer({ part: 'eye', hue_shift: 10 })])).valid, false,
    'a target that is both forms at once must be refused rather than resolved by precedence');
  assert.equal(observe(plan([layer({ semantics: 'normal' })])).valid, false, 'an unknown semantics must be refused');

  // Every target has to be an object before the three forms are told apart. Each form used to select
  // its members with isinstance(), so a non-object matched none of them and was skipped instead of
  // refused: the gate accepted recolor.targets: [null] and recolor.build_recipe then died on that same
  // plan with an AttributeError. These run through the same observe path as everything above, so the
  // counterexample is on the call the runtime makes rather than on an internal helper.
  for (const illegal of [null, 1, 'x', ['lash'], true]) {
    const verdict = observe(plan([illegal]));
    assert.equal(verdict.valid, false, 'a non-object target must be refused: ' + JSON.stringify(illegal));
    assert.match(verdict.note, /每个配色目标都必须是对象/, 'the refusal must say every target has to be an object');
  }
  assert.equal(observe(plan([layer(), null])).valid, false, 'one illegal element must not ride along with a legal target');
  assert.equal(observe(plan([{ ...layer(), material: 'Assets/Vendor/Bag/Pink.mat' }])).valid, false,
    'a layered target that also names a material must be refused rather than filed as a material op');
  assert.equal(observe(plan([{ part: 'hair', hue_shift: 8, saturation: 1, value: 1,
    material: 'Assets/Vendor/Bag/Pink.mat' }])).valid, false, 'a relative target that also names a material must be refused');
  // The ids are what the observer matches against the order's fixed colours, so one id cannot be
  // claimed by two forms at once.
  const duplicate = observe(plan([layer(), { requirement_id: 'lash', outfit: 'snow', material: 'Assets/Vendor/Bag/Pink.mat' }]));
  assert.equal(duplicate.valid, false, 'one requirement_id claimed by a layer and a material target must be refused');
  assert.match(duplicate.note, /Duplicate requirement_id/);

  // Removing the non-object guard from production must revive the false acceptance. The mutant is a
  // copy: plan.py is imported by other test files that run in parallel, so production is never edited
  // in place here. It restores the pre-fix classification — skip the element, select each list by
  // isinstance — which is what let [null] through.
  const planSource = readFileSync(join(tools, 'plan.py'), 'utf8');
  const guard = '            raise ValueError(f"每个配色目标都必须是对象，收到 {type(target).__name__}：{target!r}")';
  assert.ok(planSource.includes(guard), 'the mutation anchor must exist in production plan.py');
  const mutantPlan = join(root, 'plan-mutant.py');
  writeFileSync(mutantPlan, planSource.replace(guard, '            continue')
    .split('[t for t in targets if ').join('[t for t in targets if isinstance(t, dict) and '));
  const validateWith = (script: string) => spawnSync('python3', ['-c', `import importlib.util,json,os,sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
spec = importlib.util.spec_from_file_location('plan_under_test', sys.argv[2])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
project = Path(os.environ['AVH_PROJECT_DIR'])
try:
    module.validate(json.loads(os.environ['AVH_PLAN']), module.catalog(project, json.loads(os.environ['AVH_MANIFEST'])), project)
    print('accepted')
except ValueError as error:
    print('refused: ' + str(error))`, tools, script],
    { env: { ...runEnv, AVH_PROJECT_DIR: project, AVH_PLAN: JSON.stringify(plan([null])) }, encoding: 'utf8' });
  assert.match(validateWith(mutantPlan).stdout, /^accepted/, 'without the guard the non-object target must be accepted again');
  assert.match(validateWith(join(tools, 'plan.py')).stdout, /^refused: .*每个配色目标都必须是对象/,
    'the production module must refuse the same input');

  // The rules below are field-level, so they are checked where they are decided rather than by
  // building a whole plan for each one.
  const rules = JSON.parse(execFileSync('python3', ['-c', `import json,sys
sys.path.insert(0, sys.argv[1])
import plan
registered = {'Body/PSD/Face_default.psd'}
good = {'requirement_id': 'lash', 'layered': 'Body/PSD/Face_default.psd', 'layer': ['eyelash '],
        'color': '#5B5B66', 'semantics': 'flat'}
relative = {'part': 'hair', 'hue_shift': 10, 'saturation': 1, 'value': 1}
sys.path.insert(0, sys.argv[1])


def refused(targets, ids=()):
    try:
        plan.validate_recolor_targets(targets, registered, list(ids))
    except ValueError:
        return True
    return False


print(json.dumps({
    'acceptsBothForms': not refused([good, relative], ['snow']),
    'refusesEmptyLayerPath': refused([{**good, 'layer': []}]),
    'refusesLayerPathAsString': refused([{**good, 'layer': 'eyelash '}]),
    'refusesBlankLayerName': refused([{**good, 'layer': [' ']}]),
    'refusesBadColor': refused([{**good, 'color': '5B5B66'}]),
    'refusesShortColor': refused([{**good, 'color': '#5B5B6'}]),
    'refusesMissingSemantics': refused([{k: v for k, v in good.items() if k != 'semantics'}]),
    'refusesExtraField': refused([{**good, 'note': 'x'}]),
    'refusesBlankRequirementId': refused([{**good, 'requirement_id': ' '}]),
    'refusesDuplicateRequirementId': refused([good, {**good, 'layer': ['Skin']}]),
    'refusesUnknownPart': refused([{**relative, 'part': 'tail'}], ['snow']),
    'refusesRelativeExtraField': refused([{**relative, 'note': 'x'}], ['snow']),
    'refusesFourRelativeParts': refused([relative, {**relative, 'part': 'eye'}, {**relative, 'part': 'outfit:snow'},
                                        {**relative, 'part': 'hair'}], ['snow']),
    'refusesNineLayerTargets': refused([{**good, 'requirement_id': 'r' + str(i)} for i in range(9)]),
    'acceptsEightLayerTargets': not refused([{**good, 'requirement_id': 'r' + str(i)} for i in range(8)]),
}))`, join(tools)], { encoding: 'utf8' })) as Record<string, boolean>;
  for (const [rule, ok] of Object.entries(rules)) assert.equal(ok, true, rule);
});

// The other tests here ship a placeholder whose bytes are not a PSD, so they take the path where the source
// cannot be read and the metric is withheld. That leaves the check's own decision untested: whether a target
// that resolves to a region with no coverage is counted as unresolved. Answering it needs a real PSD, and
// specifically one with a named layer whose coverage is empty, so this fixture generates one. It is a separate
// test rather than a change to the fixture above, because replacing that one would move it off the unreadable
// path rather than add to it.
const realPsdBodyZip = `import io,sys,tarfile,zipfile,tempfile,os
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer
blank=Image.new('RGBA',(64,64),(0,0,0,0))
psd=PSDImage.frompil(blank,compression=0)
layer=PixelLayer.frompil(blank,psd,layer_name='empty_region',top=0,left=0)
layer.name='empty_region'
psd._layers.append(layer)
handle=tempfile.NamedTemporaryFile(suffix='.psd',delete=False); handle.close()
psd.save(handle.name)
data=open(handle.name,'rb').read(); os.unlink(handle.name)
with io.BytesIO() as buf:
  with tarfile.open(fileobj=buf,mode='w:gz') as package:
    for i in range(3):
      b=('Assets/Body/Body'+str(i)+'.prefab').encode(); e=tarfile.TarInfo(str(i)+'/pathname'); e.size=len(b); package.addfile(e,io.BytesIO(b))
  with zipfile.ZipFile(sys.argv[1],'w') as archive:
    archive.writestr('Body.unitypackage',buf.getvalue())
    archive.writestr('Body/PSD/Face_default.psd',data)`;

const psdTools = python && spawnSync('python3', ['-c', 'import psd_tools, PIL'], { env }).status === 0;

test('a layer target that resolves to an empty region is reported unresolved', { skip: !psdTools }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-plan-layer-empty-'));
  t.after(() => removeTemp(root));
  const body = join(root, 'Body_v1.zip'), outfit = join(root, 'Outfit_v1.zip'), project = join(root, 'project');
  execFileSync('python3', ['-c', realPsdBodyZip, body], { env });
  execFileSync('python3', ['-c', outfitZip, outfit], { env });
  const manifest = { schema: 'manifest/0.1', request: '按层改睫毛', assets: [
    { item: body, name: 'Body_v1.zip', role: 'body', store: 'client' },
    { item: outfit, name: 'Outfit_v1.zip', role: 'outfit', store: 'client' }] };
  const runEnv = { ...env, AVH_MANIFEST: JSON.stringify(manifest) };
  execFileSync('python3', [join(tools, 'intake.py'), '--library', root, '--project', project], { env: runEnv });
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8'));
  const bodyItem = inventory.items.find((i: { role: string }) => i.role === 'body');
  const outfitItem = inventory.items.find((i: { role: string }) => i.role === 'outfit');
  const [bodyPrefab] = bodyItem.prefabs, [outfitPrefab] = outfitItem.prefabs;

  const observed = join(root, 'observed.json');
  const targets = [{ requirement_id: 'lash', layered: 'Body/PSD/Face_default.psd', layer: ['empty_region'],
    color: '#5B5B66', semantics: 'flat' }];
  const plan = { schema: 'plan/0.2', client_gallery: false, body, body_prefab: bodyPrefab,
    outfits: [{ id: 'snow', item: outfit, prefab: outfitPrefab, label: '雪' }], default_outfit: 'snow', unused: [],
    obligations: [
      { input: body, role: 'body', action: 'use', target: bodyPrefab, due_stage: 'outfit' },
      { input: outfit, role: 'outfit', action: 'use', target: outfitPrefab, due_stage: 'outfit' }],
    menu: { mode: 'assemble', selector: { type: 'radial' }, component_policy: 'horizontal_across_outfits' }, recolor: { targets, candidates: 3 },
    optimization: { mode: 'preserve' }, face: { mode: 'preserve' }, notes: '结构合法' };
  const result = spawnSync('python3', [join(tools, 'plan.py'), 'observe', '--out', observed, '--project', project],
    { env: { ...runEnv, AVH_PLAN: JSON.stringify(plan) }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(readFileSync(observed, 'utf8'));

  // The source resolved here, so the metric must be reported rather than withheld: it is absent only when
  // nothing could be read, which is the path the fixture above takes with its placeholder file.
  assert.ok('plan_layer_paths_unresolved' in report.metrics,
    'a readable source must produce the reading rather than withholding it');
  assert.ok(report.metrics.plan_layer_paths_unresolved >= 1,
    'a target naming an empty region must count as unresolved, got ' +
    String(report.metrics.plan_layer_paths_unresolved));
});
