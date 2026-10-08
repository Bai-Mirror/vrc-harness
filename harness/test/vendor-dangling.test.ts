import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {removeTemp} from './fixtures/platform.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const observer = join(tools, 'observe_assets.py');
const python = process.platform === 'win32' ? 'python' : 'python3';
const observerSource = readFileSync(observer, 'utf8');
// The line that chooses each finding's proof: a material texture reference is proven by the registered
// original's own references, a renderer slot by the source file's bytes.
const slotCondition = "return vendor_origin(path, guid) if path.suffix.lower() == '.mat' else unchanged_imported_asset(project, path, origins)";

function behaviorMutant(root: string, name: string, from: string, to: string) {
  assert.ok(observerSource.includes(from), `the mutation anchor must be present: ${from}`);
  const path = join(root, name);
  writeFileSync(path, observerSource.replace(from, to));
  return path;
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-vendor-dangling-')); t.after(() => removeTemp(root));
  const project = join(root, 'project'), library = join(root, 'library'), run = join(root, 'run');
  for (const path of [join(project, 'Assets/Vendor'), join(project, 'Assets/_Harness/Outfit'), join(project, '_harness/intake'), library, run])
    mkdirSync(path, {recursive: true});
  const guid = 'd'.repeat(32), packageGuid = '1'.repeat(32);
  const prefab = `%YAML 1.1\n--- !u!23 &230100\nMeshRenderer:\n  m_GameObject: {fileID: 100100}\n  m_Materials:\n  - {fileID: 2100000, guid: ${'a'.repeat(32)}, type: 2}\n  - {fileID: 2100000, guid: ${guid}, type: 2}\n`;
  writeFileSync(join(project, 'Assets/Body.prefab'), '%YAML 1.1\n');
  writeFileSync(join(project, 'Assets/Valid.mat'), '%YAML 1.1\n');
  writeFileSync(join(project, 'Assets/Valid.mat.meta'), `guid: ${'a'.repeat(32)}\n`);
  writeFileSync(join(project, 'Assets/Vendor/Item.prefab'), prefab);
  writeFileSync(join(project, 'Assets/Vendor/Item.prefab.meta'), `guid: ${packageGuid}\n`);
  const archive = join(library, 'registered.unitypackage');
  execFileSync(python, ['-c', `import io,sys,tarfile
path,asset,guid=sys.argv[1:]
with tarfile.open(path,'w:gz') as t:
 for leaf,data in [('pathname',b'Assets/Vendor/Item.prefab'),('asset',asset.encode()),('asset.meta',('guid: '+guid+'\\n').encode())]:
  x=tarfile.TarInfo(guid+'/'+leaf);x.size=len(data);t.addfile(x,io.BytesIO(data))`, archive, prefab, packageGuid]);
  const plan = {schema: 'plan/0.2', body_prefab: 'Assets/Body.prefab', outfits: [{id: 'item', prefab: 'Assets/Vendor/Item.prefab'}]};
  const manifest = {assets: [{item: archive, role: 'outfit'}]};
  writeFileSync(join(project, '_harness/intake/inventory.json'), JSON.stringify({items: [{item: archive, files: [{name: 'registered.unitypackage', selected: true}]}]}));
  const observe = (script = observer) => {
    const out = join(run, 'observations.json'); mkdirSync(join(run, 'observations'), {recursive: true});
    execFileSync(python, [script, '--project', project, '--library', library, '--out', out], {env: {
      ...process.env, PYTHONPATH: tools, PYTHONDONTWRITEBYTECODE: '1', AVH_STAGE: 'setup', AVH_PLAN: JSON.stringify(plan),
      AVH_MANIFEST: JSON.stringify(manifest), AVH_RUN_DIR: run,
    }});
    return JSON.parse(readFileSync(out, 'utf8'));
  };
  const importSources = () => execFileSync(python, ['-c', `import json,sys
from pathlib import Path
from setup import snapshot_inputs,unpack_selected
from intake import item_files,file_digest
from plan import import_records
project,library=map(Path,sys.argv[1:]);path=project/'_harness/intake/inventory.json';inventory=json.loads(path.read_text())
for item in inventory['items']:
 item.update(found=True,role=item.get('role','outfit'))
 for entry in item.get('files',[]):
  if entry.get('selected'):
   source=next(p for p in item_files(library,item['item'])[1] if p.name==entry['name']);entry['sha256']=file_digest(source)
path.write_text(json.dumps(inventory));scratch=project/'_harness/import-scratch';scratch.mkdir(parents=True,exist_ok=True)
receipt=project/'_harness/setup/import.json';record={'schema':'setup/0.1'}
if receipt.exists():record['history']=import_records(json.loads(receipt.read_text()))
snapshots=snapshot_inputs(library,inventory,scratch);unpack_selected(project,library,inventory,scratch,record,snapshots)
receipt.parent.mkdir(parents=True,exist_ok=True);receipt.write_text(json.dumps(record))`, project, library], {
    env: {...process.env, PYTHONPATH: tools, PYTHONDONTWRITEBYTECODE: '1'}, stdio: 'pipe',
  });
  const repack = () => {
    execFileSync(python, ['-c', `import io,sys,tarfile,re
from pathlib import Path
root=Path(sys.argv[1])
with tarfile.open(sys.argv[2],'w:gz') as t:
 for p in (root/'Assets/Vendor').glob('*'):
  if p.suffix=='.meta':continue
  guid=re.search(r'guid: ([0-9a-f]{32})',Path(str(p)+'.meta').read_text()).group(1)
  for leaf,data in [('pathname',p.relative_to(root).as_posix().encode()),('asset',p.read_bytes()),('asset.meta',Path(str(p)+'.meta').read_bytes())]:
   row=tarfile.TarInfo(guid+'/'+leaf);row.size=len(data);t.addfile(row,io.BytesIO(data))`, project, archive]);
    importSources();
  };
  importSources();
  return {root, project, library, run, prefabPath: join(project, 'Assets/Vendor/Item.prefab'), observe, guid, importSources, repack};
}

test('setup classifies only byte-identical vendor missing material slots as non-blocking and records exact rows', t => {
  const f = fixture(t); const clean = f.observe();
  assert.equal(clean.metrics.broken_guid_refs, 0);
  assert.equal(clean.metrics.vendor_missing_material_slots, 1);
  assert.match(clean.notes.join('\n'), /Assets\/Vendor\/Item\.prefab.*槽位 1/);
  assert.equal(existsSync(join(f.run, 'vendor-missing-material-slots.json')), false, 'setup must only write its authorized observation output');

  // A renderer slot points out of a prefab, and nothing rewrites a prefab at import time, so this finding
  // keeps the byte-identity proof: an edited vendor prefab cannot use the exemption.
  writeFileSync(f.prefabPath, readFileSync(f.prefabPath, 'utf8') + '# changed by harness\n');
  const changed = f.observe();
  assert.equal(changed.metrics.broken_guid_refs, 1, 'edited vendor files cannot use the vendor-missing exemption');
  assert.equal(changed.metrics.vendor_missing_material_slots, 0);
  const noByteProof = behaviorMutant(f.root, 'slot-bytes-dropped.py', slotCondition, 'return vendor_origin(path, guid) if path.suffix.lower() == \'.mat\' else True');
  assert.equal(f.observe(noByteProof).metrics.broken_guid_refs, 0, 'the behavior mutant must actually exempt the edited prefab');
  assert.throws(() => assert.equal(f.observe(noByteProof).metrics.broken_guid_refs, 1), 'dropping the byte proof for renderer slots must fail the same assertion');
});

test('material override rows retain the source renderer fileID and slot', () => {
  const yaml = `--- !u!1001 &1\nPrefabInstance:\n  m_Modification:\n    m_Modifications:\n    - target: {fileID: -23001, guid: ${'a'.repeat(32)}, type: 3}\n      propertyPath: m_Materials.Array.data[1]\n      value: \n      objectReference: {fileID: 2100000, guid: ${'d'.repeat(32)}, type: 2}\n`;
  const code = "import json,sys;from pathlib import Path;from observe_assets import material_slot_refs;print(json.dumps(material_slot_refs(Path('Assets/Vendor/Item.prefab'), sys.argv[1])))";
  const rows = JSON.parse(execFileSync(python, ['-c', code, yaml], {
    env: {...process.env, PYTHONPATH: tools, PYTHONDONTWRITEBYTECODE: '1'}, encoding: 'utf8',
  }));
  assert.deepEqual(rows, [{file: 'Assets/Vendor/Item.prefab', object_path: `source:${'a'.repeat(32)}@-23001`, renderer: 'PrefabInstance@fileID:-23001', slot: 1, guid: 'd'.repeat(32)}]);
});

test('an unregistered owned provider blocks, and the owned-source search cannot be narrowed to the inventory', t => {
  const f = fixture(t);
  // The archive now supplies the missing GUID as a second asset, without changing the vendor prefab bytes.
  const provider = join(f.library, 'registered-provider.unitypackage');
  execFileSync(python, ['-c', `import io,sys,tarfile
path,guid=sys.argv[1:]
with tarfile.open(path,'w:gz') as t:
 d=b'Assets/Vendor/Missing.mat';x=tarfile.TarInfo(guid+'/pathname');x.size=len(d);t.addfile(x,io.BytesIO(d))`, provider, f.guid]);
  const withProvider = f.observe();
  assert.equal(withProvider.metrics.broken_guid_refs, 1);
  assert.match(withProvider.notes.join('\n'), /registered-provider\.unitypackage/);

  const inventoryOnly = join(f.root, 'inventory-only.py');
  writeFileSync(inventoryOnly, observerSource.replace('enumerate(registered + pool)', 'enumerate(registered)'));
  const unsafeInventory = f.observe(inventoryOnly);
  assert.equal(unsafeInventory.metrics.broken_guid_refs, 0, 'the behavior mutant must actually miss the owned provider');
  assert.throws(() => assert.equal(unsafeInventory.metrics.broken_guid_refs, 1), 'inventory-only search must fail the same owned-provider assertion');

  const changed = fixture(t); writeFileSync(changed.prefabPath, readFileSync(changed.prefabPath, 'utf8') + '# changed\n');
  const mutant = behaviorMutant(f.root, 'any-ref-paths.py',
    'if ref_paths and all(vendor_source(project / rel, guid) and vendor_texture_reference(project / rel, guid) for rel in ref_paths):',
    'if ref_paths:');
  // The test expectation must fail under the old "not found is enough" mutation.
  const unsafeChanged = changed.observe(mutant);
  assert.equal(unsafeChanged.metrics.broken_guid_refs, 0, 'the behavior mutant must actually exempt the edited file');
  assert.throws(() => assert.equal(unsafeChanged.metrics.broken_guid_refs, 1));
});

test('Python outfit observer no longer judges the ineffective raw vendor reference graph', t => {
  const f = fixture(t);
  const output = join(f.project, 'Assets/_Harness/Outfit/Avatar.prefab');
  writeFileSync(output, `%YAML 1.1\nguid: ${f.guid}\n`);
  const out = join(f.run, 'outfit.json');
  execFileSync(python, [observer, '--project', f.project, '--library', f.library, '--out', out], {env: {
    ...process.env, PYTHONPATH: tools, PYTHONDONTWRITEBYTECODE: '1', AVH_STAGE: 'outfit', AVH_PLAN: JSON.stringify({outfits: []}), AVH_MANIFEST: '{}', AVH_RUN_DIR: f.run,
  }});
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).metrics.broken_guid_refs, undefined);
});

test('loose ZIP assets and project package caches are owned GUID sources', t => {
  const f = fixture(t);
  const zip = join(f.library, 'UnregisteredDependencies.ZIP');
  execFileSync(python, ['-c', "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],'w');z.writestr('Assets/Dependency.mat','%YAML 1.1\\n');z.writestr('Assets/Dependency.mat.meta','guid: '+sys.argv[2]+'\\n');z.close()", zip, f.guid]);
  const supplied = f.observe();
  assert.equal(supplied.metrics.broken_guid_refs, 1);
  assert.match(supplied.notes.join('\n'), /UnregisteredDependencies\.ZIP/);
  for (const top of ['Packages/owned', 'Library/PackageCache/owned']) {
    const projectSource = fixture(t);
    mkdirSync(join(projectSource.project, top), {recursive: true});
    writeFileSync(join(projectSource.project, top, 'Missing.mat'), '%YAML 1.1\n');
    writeFileSync(join(projectSource.project, top, 'Missing.mat.meta'), `guid: ${projectSource.guid}\n`);
    const present = projectSource.observe();
    assert.equal(present.metrics.broken_guid_refs, 0);
    assert.equal(present.metrics.vendor_missing_material_slots, 0);
  }
});

test('vendor material texture provenance is read-only, while generated materials and post-import references block', t => {
  const f = fixture(t);
  const material = join(f.project, 'Assets/Vendor/Texture.mat');
  const materialGuid = 'b'.repeat(32);
  writeFileSync(material, `%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_SavedProperties:\n    m_TexEnvs:\n    - _MainTex:\n        m_Texture: {fileID: 2800000, guid: ${f.guid}, type: 3}\n`);
  writeFileSync(material + '.meta', `guid: ${materialGuid}\n`);
  writeFileSync(f.prefabPath, readFileSync(f.prefabPath, 'utf8').replace(f.guid, materialGuid));
  execFileSync(python, ['-c', `import io,sys,tarfile,re
from pathlib import Path
root=Path(sys.argv[1])
with tarfile.open(sys.argv[2],'w:gz') as t:
 for p in (root/'Assets/Vendor').glob('*'):
  if p.suffix=='.meta':continue
  guid=re.search(r'guid: ([0-9a-f]{32})',Path(str(p)+'.meta').read_text()).group(1)
  for leaf,data in [('pathname',p.relative_to(root).as_posix().encode()),('asset',p.read_bytes()),('asset.meta',Path(str(p)+'.meta').read_bytes())]:
   row=tarfile.TarInfo(guid+'/'+leaf);row.size=len(data);t.addfile(row,io.BytesIO(data))`, f.project, join(f.library, 'registered.unitypackage')]);
  f.importSources();
  const vendor = f.observe();
  assert.equal(vendor.metrics.broken_guid_refs, 0);
  assert.match(vendor.notes.join('\n'), /厂商材质贴图缺件提醒.*_MainTex/);
  const classify = (script = observer) => JSON.parse(execFileSync(python, [script, '--project', f.project, '--library', f.library, '--classify-material', 'Assets/Vendor/Texture.mat'], {
    env: {...process.env, PYTHONPATH: tools, PYTHONDONTWRITEBYTECODE: '1'}, encoding: 'utf8',
  }));
  assert.deepEqual(classify(), {unchanged: true, unavailable_guids: [f.guid], origin_references: [f.guid]});

  // A vendor shader package migrating its own material at import time rewrites bytes without touching a
  // single reference. The proof is that the imported member carries the same GUID, so this stays a
  // reminder; the byte-identity reading is still reported, it just no longer decides.
  const original = readFileSync(material);
  writeFileSync(material, Buffer.concat([original, Buffer.from('# migrated by the shader package\n')]));
  const migrated = f.observe();
  assert.equal(migrated.metrics.broken_guid_refs, 0, 'a material the import rewrote still carries the vendor reference');
  assert.match(migrated.notes.join('\n'), /厂商材质贴图缺件提醒.*_MainTex/);
  assert.equal(classify().unchanged, false, 'the byte-identity reading must still expose the rewrite');
  assert.deepEqual(classify().origin_references, [f.guid]);
  // Requiring the bytes to be untouched instead must fail exactly this counterexample.
  const bytesOnly = behaviorMutant(f.root, 'material-bytes-only.py', slotCondition, 'return unchanged_imported_asset(project, path, origins)');
  assert.equal(f.observe(bytesOnly).metrics.broken_guid_refs, 1, 'the byte-identity mutant must actually block the rewritten material');
  assert.throws(() => assert.equal(f.observe(bytesOnly).metrics.broken_guid_refs, 0), 'requiring byte-identical vendor bytes must fail the rewritten-material assertion');

  // A generated material carrying the same reference is never the vendor's.
  writeFileSync(material, original);
  const generated = join(f.project, 'Assets/_Harness/Outfit/Generated.mat');
  writeFileSync(generated, readFileSync(material));
  writeFileSync(generated + '.meta', `guid: ${'c'.repeat(32)}\n`);
  writeFileSync(f.prefabPath, readFileSync(f.prefabPath, 'utf8').replace(materialGuid, 'c'.repeat(32)));
  assert.equal(f.observe().metrics.broken_guid_refs, 1);

  // Restore the vendor material slot and point its texture at a GUID the imported member never carried.
  writeFileSync(f.prefabPath, readFileSync(f.prefabPath, 'utf8').replace('c'.repeat(32), materialGuid));
  // The proof is compared by GUID and never by array slot: a vendor package that migrates its own
  // material moves the slots, so the same reference sits at a different data[N] afterwards. The array
  // moved, the GUID did not, and the finding must not change.
  const moved = original.toString().replace('    - _MainTex:\n',
    '    - _BumpMap:\n        m_Texture: {fileID: 0}\n        m_Scale: {x: 1, y: 1}\n        m_Offset: {x: 0, y: 0}\n    - _MainTex:\n');
  assert.notEqual(moved, original.toString(), 'the fixture must serialize the texture entry that moves');
  writeFileSync(material, moved);
  const afterSlotMove = f.observe();
  assert.equal(afterSlotMove.metrics.broken_guid_refs, 0, 'the slot moved, the GUID did not: comparing by index must not be needed');
  assert.match(afterSlotMove.notes.join('\n'), /厂商材质贴图缺件提醒.*_MainTex/);
  const replaced = original.toString().replace(f.guid, 'e'.repeat(32));
  assert.notEqual(replaced, original.toString());
  writeFileSync(material, replaced);
  assert.equal(f.observe().metrics.broken_guid_refs, 1, 'a texture GUID the imported member never carried appeared after the import');
  // Dropping the imported-original requirement for materials leaves only "no owned source provides it",
  // which must exempt a reference that appeared after the import.
  const originDropped = behaviorMutant(f.root, 'material-origin-dropped.py', slotCondition,
    "return True if path.suffix.lower() == '.mat' else unchanged_imported_asset(project, path, origins)");
  assert.equal(f.observe(originDropped).metrics.broken_guid_refs, 0, 'the behavior mutant must actually exempt a GUID only the imported file carries');
  assert.throws(() => assert.equal(f.observe(originDropped).metrics.broken_guid_refs, 1), 'dropping the imported-original requirement must fail the same assertion');
});


test('a vendor material missing shader blocks while its texture property remains a reminder', t => {
  const f = fixture(t); const material = join(f.project, 'Assets/Vendor/Texture.mat');
  const materialGuid = 'b'.repeat(32);
  writeFileSync(material, `%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_SavedProperties:\n    m_TexEnvs:\n    - _MainTex:\n        m_Texture: {fileID: 2800000, guid: ${f.guid}, type: 3}\n`);
  writeFileSync(material+'.meta', `guid: ${materialGuid}\n`);
  writeFileSync(f.prefabPath, readFileSync(f.prefabPath,'utf8').replace(f.guid,materialGuid));
  f.repack(); assert.equal(f.observe().metrics.broken_guid_refs,0);
  writeFileSync(material, readFileSync(material,'utf8').replace('Material:\n',`Material:\n  m_Shader: {fileID: 4800000, guid: ${f.guid}, type: 3}\n`));
  f.repack(); assert.equal(f.observe().metrics.broken_guid_refs,1,'source provenance must not exempt a missing shader');
});

test('the origin proof binds the member the import selected and its recorded version, never a sibling archive', t => {
  const f=fixture(t);const material=join(f.project,'Assets/Vendor/Texture.mat'),materialGuid='b'.repeat(32);
  // The selected archive ships a material whose texture resolves, so the original the import bound
  // carries no dangling GUID at all.
  writeFileSync(material, `%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_SavedProperties:\n    m_TexEnvs:\n    - _MainTex:\n        m_Texture: {fileID: 2800000, guid: ${'0'.repeat(16)}f${'0'.repeat(15)}, type: 3}\n`);
  writeFileSync(material+'.meta',`guid: ${materialGuid}\n`);
  writeFileSync(f.prefabPath,readFileSync(f.prefabPath,'utf8').replace(f.guid,materialGuid));f.repack();
  assert.equal(f.observe().metrics.broken_guid_refs,0);
  // The imported file then acquires a dangling texture reference the selected member never carried.
  const dangling=readFileSync(material,'utf8').replace(/m_Texture: \{[^}]*\}/,`m_Texture: {fileID: 2800000, guid: ${f.guid}, type: 3}`);
  writeFileSync(material,dangling);
  assert.equal(f.observe().metrics.broken_guid_refs,1,'a GUID the selected member never carried is not the vendor\'s');
  // A registered but unselected archive does carry it. It was never the member this import selected, so
  // it must not stand in as the proof.
  const alternate=join(f.library,'unselected-alternative.unitypackage');
  execFileSync(python,['-c',`import io,sys,tarfile
path,guid,asset=sys.argv[1],sys.argv[2],sys.argv[3]
with tarfile.open(path,'w:gz') as t:
 for leaf,data in [('pathname',b'Assets/Vendor/Texture.mat'),('asset',asset.encode()),('asset.meta',('guid: '+guid+'\\n').encode())]:
  row=tarfile.TarInfo(guid+'/'+leaf);row.size=len(data);t.addfile(row,io.BytesIO(data))`,alternate,materialGuid,dangling]);
  const inventoryPath=join(f.project,'_harness/intake/inventory.json');const inventory=JSON.parse(readFileSync(inventoryPath,'utf8'));
  inventory.items.push({item:alternate,found:true,role:'outfit',files:[{name:'unselected-alternative.unitypackage',selected:false}]});writeFileSync(inventoryPath,JSON.stringify(inventory));
  assert.equal(f.observe().metrics.broken_guid_refs,1,'an unselected registered archive must not prove the imported member');
  const anyArchive=behaviorMutant(f.root,'any-registered-archive.py',
    `    package = (members if members is not None else imported_asset_members(project)).get(rel)
    if package is None:
        return None
    assets = imported_member_assets(library, package)
    if assets is None:
        return None
`,
    `    assets = {}
    for guid, rows in owned_package_assets(library, (read_json(project / '_harness' / 'intake' / 'inventory.json') or {}).get('items', [])).items():
        for candidate in rows:
            if candidate.get('path') == rel and candidate.get('bytes'):
                assets[guid] = candidate
    if not assets:
        return None
`);
  assert.equal(f.observe(anyArchive).metrics.broken_guid_refs,0,'the behavior mutant must actually accept any registered archive');
  assert.throws(()=>assert.equal(f.observe(anyArchive).metrics.broken_guid_refs,1),'matching any registered archive must fail the selected-member assertion');
});


test('receipts that do not bind the imported member block until setup records that binding', t => {
  const f=fixture(t);const receiptPath=join(f.project,'_harness/setup/import.json');
  const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
  for(const row of receipt.packages){delete row.zip;delete row.package;delete row.archive_sha256;}
  writeFileSync(receiptPath,JSON.stringify(receipt));
  const unproven=f.observe();assert.equal(unproven.metrics.broken_guid_refs,1);
  assert.match(unproven.notes.join('\n'),/缺少实际导入成员/);
  f.importSources();assert.equal(f.observe().metrics.broken_guid_refs,0);
});
