import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const tool = fileURLToPath(new URL('../builtin/tools/harness/intake.py', import.meta.url));
const observer = fileURLToPath(new URL('../builtin/tools/harness/observe_assets.py', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;
// A folder a macOS-made zip extracted is spelled in NFD (`ハ`+U+3099) where the same folder registered by
// hand is NFC (`バ`); NTFS and ext4 keep the two as different names, so identity has to be compared composed.
const NFC_KANA = '\u30d0', NFD_KANA = '\u30cf\u3099';
const distinctForms = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'avh-norm-probe-'));
  try { mkdirSync(join(probe, NFD_KANA)); return !existsSync(join(probe, NFC_KANA)); }
  finally { removeTemp(probe); }
})();

test('a registered input spelled differently from the disk by Unicode normalization is still found and counted', { skip: !python || !distinctForms }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-intake-unicode-'));
  t.after(() => removeTemp(root));
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  const library = join(root, 'library'), project = join(root, 'project'), loose = join(root, 'loose');
  const folder = join(library, `Sleeve_${NFD_KANA}-7`);
  mkdirSync(join(folder, 'files'), { recursive: true });
  mkdirSync(loose, { recursive: true });
  const package_ = (path: string) => execFileSync('python3', ['-c', `import sys,tarfile,io
with tarfile.open(sys.argv[1],'w:gz') as archive:
    data=b'Assets/Avatar/Avatar.prefab'
    entry=tarfile.TarInfo('0/pathname'); entry.size=len(data); archive.addfile(entry,io.BytesIO(data))`, path], { env });
  package_(join(folder, 'files', 'Body.unitypackage'));
  package_(join(loose, `${NFD_KANA}_Hair.unitypackage`));
  // The person registered the NFC spelling of a file whose on-disk name is NFD.
  const registered = join(loose, `${NFC_KANA}_Hair.unitypackage`);
  assert.equal(existsSync(registered), false, 'this filesystem folds the two spellings, so the case cannot be expressed');
  const manifest = { schema: 'manifest/0.1', request: 'Change the color', assets: [
    { item: '7', store: 'library', role: 'outfit' },
    { item: registered, store: 'library', role: 'other' },
  ] };
  execFileSync('python3', [tool, '--library', library, '--project', project], { env: { ...env, AVH_MANIFEST: JSON.stringify(manifest) } });
  const items = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8')).items as
    Array<{ item: string; found: boolean; files: Array<{ name: string; selected: boolean }> }>;
  const product = items.find(item => item.item === '7')!, direct = items.find(item => item.item === registered)!;
  assert.equal(product.found, true);
  assert.deepEqual(product.files.filter(file => file.selected).map(file => file.name), ['Body.unitypackage']);
  assert.equal(direct.found, true, 'the registered spelling and the disk spelling name one input');
  assert.deepEqual(direct.files.map(file => file.name), [`${NFC_KANA}_Hair.unitypackage`]);
  assert.equal(direct.item, registered, 'the record keeps exactly what was registered; nothing is renamed');
  // The independent observer re-derives the count from the library itself, so it must agree.
  const out = join(root, 'observation.json');
  execFileSync('python3', [observer, '--library', library, '--project', project, '--out', out],
    { env: { ...env, AVH_STAGE: 'intake', AVH_MANIFEST: JSON.stringify(manifest), AVH_PROJECT_DIR: project } });
  const metrics = JSON.parse(readFileSync(out, 'utf8')).metrics;
  assert.equal(metrics.inventory_entries, 2);
  assert.equal(metrics.product_directory_count, 2, 'both registered inputs are counted although one is spelled differently on disk');
});

test('intake honors an explicit smaller body package, preserves every candidate and refuses unmatched selection', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-intake-selection-'));
  t.after(() => removeTemp(root));
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  execFileSync('python3', ['-c', `import sys,io,json,tarfile,hashlib
from pathlib import Path
root=Path(sys.argv[1]); files=root/'library'/'Avatar-1'/'files'; files.mkdir(parents=True)
(files.parent/'.booth-meta.json').write_text(json.dumps({'name':'Avatar'}))
def package(name,count,padding,prefix='Assets/Avatar/Avatar'):
    with tarfile.open(files/name,'w:gz') as archive:
        for i in range(count):
            data=(prefix+str(i)+'.prefab').encode()
            entry=tarfile.TarInfo(str(i)+'/pathname'); entry.size=len(data); archive.addfile(entry,io.BytesIO(data))
        data=bytes((i*i+i//251)%256 for i in range(padding))
        entry=tarfile.TarInfo('padding/asset'); entry.size=len(data); archive.addfile(entry,io.BytesIO(data))
package('chosen.unitypackage',65,0)
package('other.unitypackage',1,100000)
package('avatar-widget.unitypackage',2,0,'Assets/Elsewhere/Widget')
def branch_package(name,paths):
    with tarfile.open(files/name,'w:gz') as archive:
        for i,p in enumerate(paths):
            data=p.encode()
            entry=tarfile.TarInfo(str(i)+'/pathname'); entry.size=len(data); archive.addfile(entry,io.BytesIO(data))
        entry=tarfile.TarInfo('padding/asset'); entry.size=2000; archive.addfile(entry,io.BytesIO(bytes(2000)))
branch_package('two-branches.unitypackage',['Assets/Vendor/AAvatar_Eku/Thing.prefab','Assets/Vendor/Avatar/Thing.prefab'])
assert (files/'other.unitypackage').stat().st_size > (files/'chosen.unitypackage').stat().st_size
(root/'hashes.json').write_text(json.dumps({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files.iterdir()}))
`, root], { env });
  const library = join(root, 'library'), project = join(root, 'project');
  const run = (variant: string) => {
    execFileSync('python3', [tool, '--library', library, '--project', project], { env: { ...env,
      AVH_MANIFEST: JSON.stringify({ schema: 'manifest/0.1', request: 'Change the color', assets: [
        { item: '1', store: 'library', role: 'body', variant },
      ] }),
    } });
    return JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8')).items[0];
  };
  const chosen = run('chosen');
  assert.deepEqual(chosen.files.filter((f: { selected: boolean }) => f.selected).map((f: { name: string }) => f.name), ['chosen.unitypackage']);
  assert.equal(chosen.prefabs.length, 65);
  assert.ok(chosen.prefabs.includes('Assets/Avatar/Avatar64.prefab'));
  execFileSync('python3', ['-c', `import sys,json
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent))
from setup import unpack_selected
root=Path(sys.argv[2]); project=root/'project'; scratch=root/'scratch'; scratch.mkdir()
inventory=json.loads((project/'_harness/intake/inventory.json').read_text())
source=root/'library/Avatar-1/files/chosen.unitypackage'; original=source.read_bytes()
source.write_bytes(original+b'changed')
try:
    try: unpack_selected(project,root/'library',inventory,scratch,{})
    except ValueError as error: assert '不一致' in str(error)
    else: raise AssertionError('Changed source was imported')
    assert not (project/'Assets').exists()
finally: source.write_bytes(original)
`, tool, root], { env });
  const pinned = { schema: 'manifest/0.1', request: 'Keep approved bytes', assets: [{ store: 'library', role: 'body',
    item: join(library, 'Avatar-1/files/chosen.unitypackage'), sha256: '0'.repeat(64) }] };
  const drift = spawnSync('python3', [tool, '--library', library, '--project', project], {
    env: { ...env, AVH_MANIFEST: JSON.stringify(pinned) }, encoding: 'utf8' });
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /批准版本不一致/);
  const missing = run('missing');
  assert.equal(missing.files.some((f: { selected: boolean }) => f.selected), false);
  assert.deepEqual(missing.prefabs, []);
  assert.notEqual(missing.compat.conclusion, '支持');
  // The SOP decides compatibility from the paths a package installs, and forbids deciding it from the
  // package filename. So an install path that names this body supports 支持 and is recorded as the basis,
  // while a package whose name carries the body but whose install paths do not stays 待骨骼比对.
  const withBody = (variant: string) => {
    execFileSync('python3', [tool, '--library', library, '--project', project], { env: { ...env,
      AVH_MANIFEST: JSON.stringify({ schema: 'manifest/0.1', request: 'Change the color', assets: [
        { item: '1', store: 'library', role: 'body', variant: 'chosen' },
        { item: '1', store: 'library', role: 'outfit', variant },
      ] }) } });
    return JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8')).items;
  };
  const installed = withBody('chosen');
  assert.equal(installed[1].compat.conclusion, '支持');
  assert.match(installed[1].compat.basis, /预制体 Assets\/Avatar\/.*\.prefab/,
    'the basis must cite the install path the conclusion came from');
  // The body name comes from the product name and can be wrong, so both conclusions say which name was matched.
  assert.match(installed[1].compat.basis, /素体名「avatar」/, 'a supported basis names the key it matched');
  const filenameOnly = withBody('avatar-widget');
  assert.equal(filenameOnly[1].compat.conclusion, '待骨骼比对',
    'a body name that never reaches an install path is not a compatibility conclusion');
  assert.match(filenameOnly[1].compat.basis, /没有含素体名「avatar」的预制体安装路径/,
    'an unmatched basis names the key it looked for instead of asserting what the package lacks');
  // With no body at all there is no name to match, so a lone .unitypackage lists every prefab it carries.
  // That listing is what the plan may choose from, never evidence: promoting it would make 支持 and cite an
  // install path as the basis, which is the filename-tier conclusion this change exists to remove.
  execFileSync('python3', [tool, '--library', library, '--project', project], { env: { ...env,
    AVH_MANIFEST: JSON.stringify({ schema: 'manifest/0.1', request: 'Change the color', assets: [
      { item: '1', store: 'library', role: 'outfit', variant: 'chosen' },
    ] }) } });
  const noBody = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8')).items[0];
  assert.equal(noBody.compat.conclusion, '待骨骼比对',
    'an unmatched listing is not a compatibility conclusion');
  assert.equal(noBody.prefabs.length, 65, 'the plan still needs every candidate from that listing');
  assert.doesNotMatch(noBody.compat.basis, /开包路径名档/,
    'the basis must not claim the install-path tier when no path was matched');
  assert.match(noBody.compat.basis, /没有可用于路径匹配的素体名/, 'with no body there is no name to match, and it says so');
  // Two sibling branches both contain the body name, and the wrong one sorts first. The basis must cite the
  // branch where the body appears as a whole path segment, not whichever substring hit sorts first.
  const branches = withBody('two-branches')[1];
  assert.equal(branches.compat.conclusion, '支持');
  assert.match(branches.compat.basis, /Assets\/Vendor\/Avatar\/Thing\.prefab/,
    'the basis must cite the segment that names the body');
  assert.doesNotMatch(branches.compat.basis, /AAvatar_Eku/,
    'a substring hit in a sibling branch must not be cited as this body\'s evidence');
  execFileSync('python3', ['-c', `import sys,json,hashlib
from pathlib import Path
root=Path(sys.argv[1]); files=root/'library'/'Avatar-1'/'files'
assert json.loads((root/'hashes.json').read_text()) == {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files.iterdir()}
`, root], { env });
});

// Which packages ship a layered working file decides whether a colour change can name a layer instead
// of being guessed from pixels, so intake records it rather than leaving it to be rediscovered later.
// Both nesting shapes occur in real orders and one of them is easy to miss: the outfit packages hold a
// .unitypackage, so a scan that only reads the zip's own entries finds nothing.
test('intake records the vendor layered sources, including one level inside a nested unitypackage', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-intake-layered-'));
  t.after(() => removeTemp(root));
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  execFileSync('python3', ['-c', `import io,json,sys,tarfile,zipfile
from pathlib import Path
root=Path(sys.argv[1])
def product(name, number):
    folder=root/'library'/(name+'-'+number); files=folder/'files'; files.mkdir(parents=True)
    (folder/'.booth-meta.json').write_text(json.dumps({'name':name}))
    return files
def unitypackage(path, members):
    with tarfile.open(path,'w:gz') as archive:
        for index,(real,payload) in enumerate(members):
            guid=str(index).zfill(32)
            for leaf,data in (('pathname',real.encode()),('asset',payload)):
                entry=tarfile.TarInfo(guid+'/'+leaf); entry.size=len(data); archive.addfile(entry,io.BytesIO(data))
# A body-style package holding the working files directly.
files=product('Layered','1')
with zipfile.ZipFile(files/'body.zip','w') as archive:
    archive.writestr('Layered/PSD/Face_default.psd', b'8BPS direct')
    archive.writestr('Layered/PSD/Hair_default.psd', b'8BPS direct')
# An outfit-style package holding a unitypackage that holds the working files.
files=product('Nested','2')
inner=files/'inner.unitypackage'
unitypackage(inner, [('Assets/Thing/Source/Coat.psd', b'8BPS nested'), ('Assets/Thing/Prefab.prefab', b'prefab')])
with zipfile.ZipFile(files/'outfit.zip','w') as archive:
    archive.write(inner, 'Thing.unitypackage')
inner.unlink()
# A package with neither.
files=product('Plain','3')
with zipfile.ZipFile(files/'plain.zip','w') as archive:
    archive.writestr('Plain/Tex/Base.png', b'not really a png')
`, root], { env });
  const library = join(root, 'library'), project = join(root, 'project');
  execFileSync('python3', [tool, '--library', library, '--project', project], { env: { ...env,
    AVH_MANIFEST: JSON.stringify({ schema: 'manifest/0.1', request: 'Recolour by layer', assets: [
      { item: '1', store: 'library', role: 'body', name: 'Layered' },
      { item: '2', store: 'library', role: 'outfit', name: 'Nested' },
      { item: '3', store: 'library', role: 'texture', name: 'Plain' }],
    }) } });
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8'));
  const byRole = Object.fromEntries(inventory.items.map((i: { role: string; layered: unknown[] }) => [i.role, i.layered]));
  const paths = (role: string) => (byRole[role] as { path: string }[]).map(row => row.path);
  assert.deepEqual(paths('body').sort(), ['Layered/PSD/Face_default.psd', 'Layered/PSD/Hair_default.psd'],
    'a package holding the working files directly must still have them recorded');
  assert.deepEqual(paths('outfit'), ['Assets/Thing/Source/Coat.psd'],
    'a working file one level inside a nested unitypackage must not be missed');
  assert.deepEqual(paths('texture'), [], 'a package with no working file records an empty list, not a missing one');
  assert.equal((byRole.body as { bytes: number }[])[0]!.bytes > 0, true, 'the recorded size comes from the archive entry');

  // The observer is where the stage and the gate read the fact, so its metrics must agree with it.
  const observed = join(root, 'observed.json');
  const observe = spawnSync('python3', [fileURLToPath(new URL('../builtin/tools/harness/observe_assets.py', import.meta.url)),
    '--out', observed, '--project', project, '--library', library], { env: { ...env, AVH_STAGE: 'intake',
    AVH_MANIFEST: JSON.stringify({ schema: 'manifest/0.1', request: 'Recolour by layer', assets: [
      { item: '1', store: 'library', role: 'body', name: 'Layered' },
      { item: '2', store: 'library', role: 'outfit', name: 'Nested' },
      { item: '3', store: 'library', role: 'texture', name: 'Plain' }] }) }, encoding: 'utf8' });
  assert.equal(observe.status, 0, observe.stderr);
  const metrics = JSON.parse(readFileSync(observed, 'utf8')).metrics;
  assert.equal(metrics.items_with_layered_sources, 2, 'two of the three packages ship a working file');
  assert.equal(metrics.layered_sources_total, 3, 'and three working files in total');
});

// An archive that installs no geometry has no skeleton the assembly stage could compare, so citing that
// comparison as its compatibility basis describes a step that cannot happen. The判据 is what the archive
// carries — no prefab and no model file — never its name. An archive that carries models but no prefab
// keeps 待骨骼比对, because fitting that geometry to this body is exactly what assembly has to check.
test('a material-only archive is not asked to compare skeletons, while an archive carrying models still is', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-intake-material-'));
  t.after(() => removeTemp(root));
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  execFileSync('python3', ['-c', `import io,json,sys,tarfile,zipfile
from pathlib import Path
root=Path(sys.argv[1]); library=root/'library'
def product(number,name):
    folder=library/(name+'-'+number); files=folder/'files'; files.mkdir(parents=True)
    (folder/'.booth-meta.json').write_text(json.dumps({'name':name}))
    return files
def unitypackage(path,assets):
    with tarfile.open(path,'w:gz') as archive:
        for index,(real,payload) in enumerate(assets):
            guid=str(index).zfill(32)
            for leaf,data in (('pathname',real.encode()),('asset',payload)):
                entry=tarfile.TarInfo(guid+'/'+leaf); entry.size=len(data); archive.addfile(entry,io.BytesIO(data))
def packaged_zip(path,inner_name,assets):
    inner=path.parent/(path.stem+'.unitypackage'); unitypackage(inner,assets)
    with zipfile.ZipFile(path,'w') as archive: archive.write(inner,inner_name)
    inner.unlink()
product('1','Alpha')
unitypackage(library/'Alpha-1/files/AlphaBody.unitypackage',[('Assets/Fixture/Alpha/AlphaBody.prefab',b'prefab')])
# A material archive: .mat plus textures in a deeper directory, and no geometry of any kind.
product('2','Neutral')
packaged_zip(library/'Neutral-2/files/Neutral_Material_Set.zip','Neutral.unitypackage',[
    ('Assets/Fixture/Neutral/Material/Base.mat',b'mat'),
    ('Assets/Fixture/Neutral/Texture/Deep/Layer/Albedo.png',b'png')])
# The counterexample: no prefab at all, but 3D models — the bone comparison really is ahead for it.
product('3','Petal')
packaged_zip(library/'Petal-3/files/Petal_Nail_Set.zip','Petal.unitypackage',[
    ('Assets/Fixture/Petal/Nail/Nail_Long.fbx',b'fbx'),
    ('Assets/Fixture/Petal/Material/Nail.mat',b'mat')])
# A prefab that names this body still decides 支持 from its install path.
product('4','Outfit')
packaged_zip(library/'Outfit-4/files/Coat_Alpha.zip','Coat.unitypackage',[('Assets/Fixture/Alpha/Coat.prefab',b'prefab')])
# A prefab that does not name this body keeps the original 待骨骼比对 basis.
product('5','Other')
packaged_zip(library/'Other-5/files/Coat_Alpha_Alt.zip','CoatAlt.unitypackage',[('Assets/Fixture/Neutral/Coat.prefab',b'prefab')])
# Second structure: a bare .unitypackage of materials, and a model whose suffix is not .fbx.
loose=root/'loose'; loose.mkdir()
unitypackage(loose/'PaletteOnly.unitypackage',[('Assets/Fixture/Common/Material/Base.mat',b'mat'),
    ('Assets/Fixture/Common/Texture/Deep/Layer/Albedo.png',b'png')])
product('7','Shape')
packaged_zip(library/'Shape-7/files/Shape_Kit.zip','Shape.unitypackage',[('Assets/Fixture/Kit/Form.obj',b'obj')])
`, root], { env });
  const library = join(root, 'library'), project = join(root, 'project');
  const manifest = { schema: 'manifest/0.1', request: 'Recolour the outfit', assets: [
    { item: '1', store: 'library', role: 'body', name: 'Alpha' },
    { item: '2', store: 'library', role: 'texture', name: 'Neutral' },
    { item: '3', store: 'library', role: 'texture', name: 'Petal' },
    { item: '4', store: 'library', role: 'outfit', variant: 'alpha' },
    { item: '5', store: 'library', role: 'outfit', variant: 'alpha' },
    { item: join(root, 'loose', 'PaletteOnly.unitypackage'), store: 'library', role: 'other' },
    { item: '7', store: 'library', role: 'other', name: 'Shape' },
  ] };
  execFileSync('python3', [tool, '--library', library, '--project', project],
    { env: { ...env, AVH_MANIFEST: JSON.stringify(manifest) } });
  const items = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8')).items as
    Array<{ item: string; prefabs: string[]; compat: { conclusion: string; basis: string } }>;
  const byItem = (item: string) => items.find(row => row.item === item)!;
  assert.equal(byItem('1').compat.conclusion, '支持', 'the body conclusion is not touched');

  const material = byItem('2');
  assert.equal(material.compat.conclusion, '支持', 'an archive with no prefab and no model installs no geometry');
  assert.match(material.compat.basis, /纯材质\/贴图包/);
  assert.match(material.compat.basis, /无骨骼需要比对/, 'the basis must say the bone comparison does not apply');
  assert.doesNotMatch(material.compat.basis, /装配阶段比对骨骼/);
  assert.deepEqual(material.prefabs, [], 'and it really does list no prefab');

  const models = byItem('3');
  assert.equal(models.compat.conclusion, '待骨骼比对',
    'an archive with models but no prefab still has geometry whose fit has to be checked');
  assert.match(models.compat.basis, /骨骼/);
  assert.deepEqual(models.prefabs, []);
  assert.equal(byItem('7').compat.conclusion, '待骨骼比对', 'geometry is judged by suffix, not only by .fbx');

  const named = byItem('4');
  assert.equal(named.compat.conclusion, '支持', 'a prefab that names this body is unchanged');
  assert.match(named.compat.basis, /Assets\/Fixture\/Alpha\/Coat\.prefab/);
  const unnamed = byItem('5');
  assert.equal(unnamed.compat.conclusion, '待骨骼比对', 'a prefab that does not name this body is unchanged');
  assert.match(unnamed.compat.basis, /没有含素体名「alpha」的预制体安装路径/);

  const bare = byItem(join(root, 'loose', 'PaletteOnly.unitypackage'));
  assert.equal(bare.compat.conclusion, '支持', 'a bare .unitypackage of materials is the same case as the zip');
  assert.match(bare.compat.basis, /无骨骼需要比对/);

  // The check reads the record, so the new conclusion must stay one the observer accepts with a real basis.
  const observed = join(root, 'observed.json');
  const observe = spawnSync('python3', [observer, '--library', library, '--project', project, '--out', observed],
    { env: { ...env, AVH_STAGE: 'intake', AVH_MANIFEST: JSON.stringify(manifest), AVH_PROJECT_DIR: project }, encoding: 'utf8' });
  assert.equal(observe.status, 0, observe.stderr);
  assert.equal(JSON.parse(readFileSync(observed, 'utf8')).metrics.items_without_valid_compat_conclusion, 0);
});
