import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parseObservation} from '../src/workflow/observe.ts';
import {outfitGroupDefaultsObserver, outfitGroupDefaultsRule, outfitUnitySteps, outfitVerdicts} from './fixtures/outfit-verdicts.ts';
import {removeTemp, windows} from './fixtures/platform.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const python = windows ? 'python' : 'python3';

test('outfit defaults retain the independent source and the capability executes its read-only step after construction', () => {
  assert.equal(outfitGroupDefaultsObserver, 'avatar.observe');
  assert.equal(outfitGroupDefaultsRule, 'group_defaults_match == true');
  assert.deepEqual(outfitUnitySteps, ['AVH.Harness.OutfitStage.Run', 'AVH.Harness.OutfitStage.Observe']);
  assert.match(readFileSync(join(tools, 'unity/Editor/OutfitStage.cs'), 'utf8'), /OutfitMeasure.WriteAvatar\(AvatarPath, RecordPath\), save: false/);
});

test('grouped asset observations project single and multiple groups, variants and non-outfit instances through real rules', async t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-outfit-observers-')); t.after(() => removeTemp(root));
  const project = join(root, 'project'), run = join(root, 'run'), library = join(root, 'library');
  for (const dir of [project, join(run, 'observations'), library]) mkdirSync(dir, {recursive: true});
  const file = (rel: string, content: string) => {mkdirSync(join(project, rel, '..'), {recursive: true}); writeFileSync(join(project, rel), content);};
  const paths = ['Assets/Maker/Outer.prefab', 'Assets/Maker/Variants/OuterAlt.prefab', 'Assets/Another/Locks.prefab', 'Assets/Extras/Pin.prefab'];
  const guids = paths.map((_, i) => String(i + 1).repeat(32));
  paths.forEach((path, i) => {file(path, '%YAML 1.1\n'); file(path + '.meta', 'guid: ' + guids[i] + '\n');});
  file('Assets/Foundation.prefab', '%YAML 1.1\n');
  const references = (ids: string[]) => file('Assets/_Harness/Outfit/Avatar.prefab', '%YAML 1.1\n' + ids.map(g => 'guid: ' + g).join('\n'));
  const single = {schema: 'plan/0.3', body_prefab: 'Assets/Foundation.prefab', avatar_config: {
    instances: [{id: 'source', kind: 'outfit', prefab: paths[0]}],
    groups: [{id: 'constant', activation: 'fixed', members: [{id: 'outer', instance: 'source', label: 'Outer'}]}]}};
  const multiple = {schema: 'plan/0.3', body_prefab: 'Assets/Foundation.prefab', avatar_config: {
    instances: [{id: 'source', kind: 'outfit', prefab: paths[0], variants: [{id: 'alternate', prefab: paths[1]}]},
      {id: 'locks', kind: 'hair', prefab: paths[2]}, {id: 'pin', kind: 'accessory', prefab: paths[3]},
      {id: 'unused', kind: 'outfit', prefab: 'Assets/Unselected.prefab'}],
    groups: [{id: 'appearance', activation: 'exclusive', default: 'alt', members: [
      {id: 'base', instance: 'source', label: 'Base'}, {id: 'alt', instance: 'source', variant: 'alternate', label: 'Alt'}]},
    {id: 'hair', activation: 'independent', members: [{id: 'locks', instance: 'locks', label: 'Locks', default: true}]},
    {id: 'extras', activation: 'fixed', members: [{id: 'pin', instance: 'pin', label: 'Pin'}]},
    // A material axis has members without instance fields and must not create another physical outfit.
    {id: 'shade', kind: 'material', activation: 'exclusive', members: [{id: 'tone', materials: {slot: 'preset'}}]}]}};
  const observe = (plan: unknown, stage = 'outfit', script = join(tools, 'observe_assets.py')) => {
    const out = join(run, 'observations/assets.validate.json');
    execFileSync(python, [script, '--project', project, '--library', library, '--out', out], {stdio: 'pipe', env: {
      ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: tools,
      AVH_PLAN: JSON.stringify(plan), AVH_STAGE: stage, AVH_MANIFEST: JSON.stringify({assets: [{item: 'support.unitypackage'}]})}});
    return parseObservation(readFileSync(out, 'utf8'));
  };
  for (const plan of [single, multiple]) {
    references(guids); const observed = observe(plan);
    assert.equal(observed.metrics.outfits_without_external_refs, 0);
    // Unity supplies this observer in the integration test; here exercise the Runtime source contract.
    writeFileSync(join(run, 'observations/avatar.observe.json'), JSON.stringify({schema: 'observation/0.1', metrics: {group_defaults_match: true}}));
    assert.deepEqual((await outfitVerdicts(project, run, plan)).map(v => v.result), ['pass', 'pass']);
    references([guids[0]!, guids[2]!, guids[3]!]);
    if (plan === multiple) {
      assert.equal(observe(plan).metrics.outfits_without_external_refs, 1, 'selected variant requires its own source GUID reference');
      assert.equal((await outfitVerdicts(project, run, plan))[0]!.result, 'violation');
    }
    references([]); assert.ok(Number(observe(plan).metrics.outfits_without_external_refs) > 0);
    assert.equal((await outfitVerdicts(project, run, plan))[0]!.result, 'violation');
    references(guids); observe(plan);
  }
  const legacy = {schema: 'plan/0.2', body_prefab: 'Assets/Foundation.prefab', outfits: [{id: 'legacy', prefab: paths[0]}]};
  references([guids[0]!]); assert.equal(observe(legacy).metrics.outfits_without_external_refs, 0);
  references([]); assert.equal(observe(legacy).metrics.outfits_without_external_refs, 1);
  assert.equal(observe({outfits: []}).metrics.outfits_without_external_refs, null, 'legacy empty set remains unmeasured');

  // A package really supplies the missing dependency, so an outfit-only dangling reference is a defect.
  const dangling = '9'.repeat(32);
  execFileSync(python, ['-c', `import io,tarfile,sys
from pathlib import Path
buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w:gz') as archive:
 data=b'Assets/Support/Required.mat';entry=tarfile.TarInfo('9'*32+'/pathname');entry.size=len(data);archive.addfile(entry,io.BytesIO(data))
Path(sys.argv[1]).write_bytes(buf.getvalue())`, join(library, 'support.unitypackage')]);
  file(paths[1]!, '%YAML 1.1\n  m_Material: {fileID: 2100000, guid: ' + dangling + ', type: 2}\n');
  assert.equal(observe(multiple, 'setup').metrics.broken_guid_refs, 1, 'body is clean but the selected variant is broken');
  assert.equal(observe(single, 'setup').metrics.broken_guid_refs, 0, 'unselected variant is not an approved root');
  assert.equal(observe({...legacy, outfits: [{id: 'alt', prefab: paths[1]}]}, 'setup').metrics.broken_guid_refs, 1, 'legacy closure remains strict');
  const source = readFileSync(join(tools, 'observe_assets.py'), 'utf8');
  const mutate = (before: string, after: string, name: string) => {assert.ok(source.includes(before)); const path = join(root, name + '.py'); writeFileSync(path, source.replace(before, after)); return path;};
  references(guids);
  const noProjection = mutate('    outfits = planned_outfits(plan)\n', "    outfits = plan.get('outfits', [])\n", 'missing-outfit-projection');
  assert.equal(observe(multiple, 'outfit', noProjection).metrics.outfits_without_external_refs, null);
  rmSync(join(run, 'observations/avatar.observe.json'));
  assert.equal((await outfitVerdicts(project, run, multiple))[0]!.result, 'no_data', 'projection mutation kills the positive check');
  writeFileSync(join(run, 'observations/avatar.observe.json'), JSON.stringify({schema: 'observation/0.1', metrics: {group_defaults_match: true}}));
  const noRoots = mutate("outfits = [project / o['prefab'] for o in planned_outfits(plan) if o.get('prefab')]",
    "outfits = [project / o['prefab'] for o in plan.get('outfits', []) if o.get('prefab')]", 'missing-closure-projection');
  assert.equal(observe(multiple, 'setup', noRoots).metrics.broken_guid_refs, 0, 'root mutation reproduces the outfit-only false pass');
  file('Assets/Support/Required.mat', '%YAML 1.1\n'); file('Assets/Support/Required.mat.meta', 'guid: ' + dangling + '\n');
  assert.equal(observe(multiple, 'setup').metrics.broken_guid_refs, 0, 'installing the actual dependency repairs the same closure');
});
