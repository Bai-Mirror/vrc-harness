import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp, windows } from './fixtures/platform.ts';

const tool = fileURLToPath(new URL('../builtin/tools/harness/observe_assets.py', import.meta.url));
const python = windows ? 'python' : 'python3';

test('the setup observer detects omitted approved direct packages without reading unapproved siblings', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-direct-observer-')); t.after(() => removeTemp(root));
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  execFileSync(python, ['-c', `import io,json,tarfile,zipfile,sys
from pathlib import Path
r=Path(sys.argv[1]);lib=r/'library';lib.mkdir();project=r/'project';(project/'Assets').mkdir(parents=True)
def package(path,guid,zipped=True):
    data=io.BytesIO()
    with tarfile.open(fileobj=data,mode='w:gz') as archive:
        name=('Assets/Materials/'+guid+'.mat').encode();entry=tarfile.TarInfo(guid+'/pathname');entry.size=len(name);archive.addfile(entry,io.BytesIO(name))
    path.parent.mkdir(parents=True,exist_ok=True)
    if zipped:
        with zipfile.ZipFile(path,'w') as archive:archive.writestr('materials.unitypackage',data.getvalue())
    else:path.write_bytes(data.getvalue())
guids=[str(i)*32 for i in range(1,6)]
absolute=r/'inputs/materials-absolute.zip';package(absolute,guids[0])
relative=lib/'materials-relative.zip';package(relative,guids[1])
raw=r/'inputs/materials-raw.unitypackage';package(raw,guids[2],False)
package(lib/'Product-123/files/materials.zip',guids[3])
package(r/'inputs/materials-unapproved.zip',guids[4])
(project/'Assets/Avatar.prefab').write_text('%YAML 1.1\\n'+'\\n'.join('guid: '+g for g in guids))
(r/'manifest.json').write_text(json.dumps({'schema':'manifest/0.1','assets':[{'item':str(absolute)},{'item':relative.name},{'item':str(raw)},{'item':'123'}]}))
`, root], { env });
  const manifest = readFileSync(join(root, 'manifest.json'), 'utf8');
  const observe = () => {
    const output = join(root, 'observation.json');
    execFileSync(python, [tool, '--library', join(root, 'library'), '--project', join(root, 'project'), '--out', output], {
      env: { ...env, AVH_STAGE: 'setup', AVH_MANIFEST: manifest, AVH_PLAN: JSON.stringify({ body_prefab: 'Assets/Avatar.prefab', outfits: [] }) },
    });
    return JSON.parse(readFileSync(output, 'utf8'));
  };
  const absent = observe();
  assert.equal(absent.metrics.missing_common_material_packs, 4, 'all approved input forms are inspected');
  assert.equal(absent.metrics.broken_guid_refs, 5, 'unregistered or byte-unproven references remain blocking');
  assert.ok(absent.notes.some((note: string) => note.includes('来源无法证明') && note.includes('55555555555555555555555555555555')),
    'a source outside the owned pool must remain blocking');
  execFileSync(python, ['-c', `import sys
from pathlib import Path
p=Path(sys.argv[1])/'project/Assets';(p/'Materials').mkdir()
for i in range(1,5):
    g=str(i)*32;(p/'Materials'/(g+'.mat')).write_text('material');(p/'Materials'/(g+'.mat.meta')).write_text('guid: '+g)
`, root], { env });
  const installed = observe();
  assert.equal(installed.metrics.missing_common_material_packs, 0);
  assert.equal(installed.metrics.broken_guid_refs, 1, 'the unregistered sibling remains a blocking source');
});

test('package reference closure rejects deferral and inconsistent exclusions through the production observer', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-package-obligation-')); t.after(() => removeTemp(root));
  for (const path of ['Assets/_Harness/Optimize', 'Assets/Vendor', '_harness/setup', 'library']) mkdirSync(join(root, path), {recursive: true});
  const avatar = join(root, 'Assets/_Harness/Optimize/Avatar.prefab'); writeFileSync(avatar, '%YAML 1.1\n');
  const guid = '1234567890abcdef1234567890abcdef';
  writeFileSync(join(root, 'Assets/Vendor/installed.mat'), 'material'); writeFileSync(join(root, 'Assets/Vendor/installed.mat.meta'), 'guid: ' + guid);
  writeFileSync(join(root, '_harness/setup/import.json'), JSON.stringify({packages: [{item: 'unseen-install', roots: ['Assets/Vendor']}]}));
  const observe = (plan: any, script = tool) => {
    const output = join(root, 'observation.json');
    execFileSync(python, [script, '--project', root, '--library', join(root, 'library'), '--out', output], {stdio: 'pipe',
      env: {...process.env, PYTHONPATH: fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url)), PYTHONDONTWRITEBYTECODE: '1', AVH_STAGE: 'package', AVH_MANIFEST: JSON.stringify({assets: [{item: 'unseen-install', role: 'other'}]}), AVH_PLAN: JSON.stringify(plan)}});
    return JSON.parse(readFileSync(output, 'utf8')).metrics.assets_without_external_refs;
  };
  const deferred = {obligations: [{input: 'unseen-install', role: 'other', action: 'defer', reason: 'technical fitting pending'}], deviations: [{item: 'unseen-install', note: 'later'}]};
  assert.equal(observe(deferred), 1, 'deferral and deviation prose do not waive delivery usage');
  const excluded = {unused: [{item: 'unseen-install', reason: 'declined'}], obligations: [{input: 'unseen-install', role: 'other', action: 'exclude', reason: 'accepted exclusion'}]};
  assert.equal(observe(excluded), 0, 'a consistent approved exclusion remains exempt');
  for (const plan of [{unused: excluded.unused}, {...deferred, unused: excluded.unused},
    {...excluded, obligations: [...excluded.obligations, ...deferred.obligations]},
    {...excluded, avatar_config: {instances: [{item: 'unseen-install'}]}}]) assert.equal(observe(plan), 1, 'inconsistent exclusion must stay unmet');
  writeFileSync(avatar, '%YAML 1.1\nguid: ' + guid + '\n');
  assert.equal(observe(deferred), 0, 'actual reachable use closes the reference obligation');
  writeFileSync(avatar, '%YAML 1.1\n');
  const mutant = join(root, 'mutant.py');
  writeFileSync(mutant, readFileSync(tool, 'utf8').replace('declined = set(excluded_items(plan))',
    "declined = {nfc(str(e.get('item'))) for e in (plan.get('unused') or []) "
    + "if isinstance(e, dict) and e.get('item') and e.get('reason')}"));
  assert.equal(observe({...deferred, unused: excluded.unused}, mutant), 0, 'mutation exposes the automatic waiver that only reads unused');
});

test('package reference closure counts the PNG, shader and script a product is reached through, not only parseable text assets', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-package-endpoints-')); t.after(() => removeTemp(root));
  for (const path of ['Assets/_Harness/Optimize', 'Assets/VendorTex', 'Assets/VendorShader', 'Assets/VendorScript', 'Assets/VendorIdle', '_harness/setup', 'library'])
    mkdirSync(join(root, path), {recursive: true});
  const guid = (digit: string) => digit.repeat(32);
  const put = (rel: string, content: string, id: string) => {
    writeFileSync(join(root, rel), content);
    writeFileSync(join(root, rel + '.meta'), 'guid: ' + id + '\n');
  };
  put('Assets/VendorTex/used.png', 'png-bytes', guid('1'));
  put('Assets/VendorShader/used.shader', 'Shader "Vendor/Used" {}', guid('2'));
  put('Assets/VendorScript/Used.cs', 'class Used {}', guid('3'));
  put('Assets/VendorIdle/idle.png', 'png-bytes', guid('4'));
  writeFileSync(join(root, 'Assets/_Harness/Optimize/Avatar.prefab'),
    '%YAML 1.1\n' + ['1', '2', '3'].map(digit => 'guid: ' + guid(digit)).join('\n') + '\n');
  writeFileSync(join(root, '_harness/setup/import.json'), JSON.stringify({packages: [
    {item: 'tex-item', roots: ['Assets/VendorTex']}, {item: 'shader-item', roots: ['Assets/VendorShader']},
    {item: 'script-item', roots: ['Assets/VendorScript']}, {item: 'idle-item', roots: ['Assets/VendorIdle']}]}));
  const manifest = JSON.stringify({assets: ['tex-item', 'shader-item', 'script-item', 'idle-item'].map(item => ({item, role: 'other'}))});
  const observe = (script = tool) => {
    const output = join(root, 'observation.json');
    execFileSync(python, [script, '--project', root, '--library', join(root, 'library'), '--out', output], {stdio: 'pipe',
      env: {...process.env, PYTHONPATH: fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url)), PYTHONDONTWRITEBYTECODE: '1',
        AVH_STAGE: 'package', AVH_MANIFEST: manifest, AVH_PLAN: '{}'}});
    return JSON.parse(readFileSync(output, 'utf8')).metrics.assets_without_external_refs;
  };
  // Three products are reached through a reference endpoint each; the fourth has a file in its directory that
  // nothing references, which is not use. A sibling file cannot stand in for a reference either.
  assert.equal(observe(), 1, 'a PNG, a shader and a script each close the obligation of the product they belong to');
  const mutant = join(root, 'mutant.py');
  writeFileSync(mutant, readFileSync(tool, 'utf8').replace(
`            if target.suffix.lower() in TEXT_ASSETS:
                if target not in seen:
                    queue.append(target)
            else:
                seen.add(target)`,
`            if target.suffix.lower() in TEXT_ASSETS and target not in seen:
                queue.append(target)`));
  assert.equal(observe(mutant), 4, 'mutation: without the endpoint branch every reference-only product reads as unused');
});
