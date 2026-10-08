import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const intake = join(tools, 'intake.py');
const observer = join(tools, 'observe_assets.py');
const python = spawnSync('python3', ['--version']).status === 0;
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
const REPOSITORY = 'https://example.invalid/vpm/index.json';
const ALTERNATE = 'https://alt.invalid/repo/index.json';

// A vendor that publishes on VPM can ship an installation entry instead of a .unitypackage. The intake used to
// see a bundle with no importable package and record it as "no importable package", which is a statement about
// Assets/ rather than about the order's dependencies. This fixture carries only the entry, so the whole chain
// from the entry to an installed project package is exercised on synthetic bytes and no real repository.
test('a bundle carrying only a VPM installation entry becomes a pinned project dependency, in either spelling', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-intake-vpm-'));
  t.after(() => removeTemp(root));
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
unitypackage(product('1','Alpha')/'AlphaBody.unitypackage',[('Assets/Fixture/Alpha/AlphaBody.prefab',b'prefab')])
# The real shape: a Windows Internet Shortcut carrying VCC's installer link, plus screenshots and notes.
files=product('2','LightLimitChanger')
with zipfile.ZipFile(files/'Tool_v2-VCC-6.zip','w') as archive:
    archive.writestr('Tool-v2-VCC.url',
        '[{000214A0-0000-0000-C000-000000000046}]\\r\\nProp3=19,0\\r\\n[InternetShortcut]\\r\\nIDList=\\r\\n'
        'URL=vcc://vpm/addRepo?url=${REPOSITORY}\\r\\n')
    archive.writestr('install.png', b'png')
    archive.writestr('readme.txt', 'See https://noise.invalid/not-a-repo.json for the manual.\\n')
# A second spelling of the same entry: a text file whose whole content is the repository listing URL.
files=product('3','Alternate')
(files/'repository.txt').write_text('${ALTERNATE}\\n')
# Prose that mentions a URL is not an installation instruction.
files=product('4','Prose')
(files/'notes.txt').write_text('The tool is documented at https://noise.invalid/docs/index.json and elsewhere.\\nSecond line.\\n')
# A bundle that ships both is installed from its .unitypackage; the entry stays a note.
files=product('5','Mixed')
inner=files/'Mixed.unitypackage'
unitypackage(inner,[('Assets/Fixture/Mixed/Thing.prefab',b'prefab')])
with zipfile.ZipFile(files/'Mixed.zip','w') as archive:
    archive.write(inner,'Mixed.unitypackage')
    archive.writestr('Mixed.url','URL=vcc://vpm/addRepo?url=https://ignored.invalid/index.json\\n')
inner.unlink()
`, root], { env });
  const library = join(root, 'library'), project = join(root, 'project');
  const manifest = { schema: 'manifest/0.1', request: 'Install the plugins this order needs', assets: [
    { item: '1', store: 'library', role: 'body', name: 'Alpha' },
    { item: '2', store: 'library', role: 'other', name: 'LightLimitChanger' },
    { item: '3', store: 'library', role: 'other', name: 'Alternate' },
    { item: '4', store: 'library', role: 'other', name: 'Prose' },
    { item: '5', store: 'library', role: 'other', name: 'Mixed' },
  ] };
  execFileSync('python3', [intake, '--library', library, '--project', project],
    { env: { ...env, AVH_MANIFEST: JSON.stringify(manifest) } });
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8')) as {
    items: Array<{ item: string; files: Array<{ name: string; selected: boolean; kind?: string; reason: string }>;
                   compat: { conclusion: string; basis: string };
                   vpm: Array<{ entry: string; form: string; member: string; repository: string; sourceSha256: string }> }> };
  const byItem = (item: string) => inventory.items.find(row => row.item === item)!;

  const shortcut = byItem('2');
  const chosen = shortcut.files.find(file => file.selected)!;
  assert.equal(chosen.name, 'Tool_v2-VCC-6.zip');
  assert.equal(chosen.kind, 'vpm', 'an installation entry is selected as a project dependency');
  assert.deepEqual(shortcut.vpm.map(row => [row.form, row.member, row.repository]),
    [['installer-link', 'Tool-v2-VCC.url', REPOSITORY]], 'the entry, its spelling and its repository are recorded');
  assert.match(shortcut.vpm[0]!.sourceSha256, /^[0-9a-f]{64}$/, 'the approved bundle digest travels with the request');
  assert.equal(shortcut.compat.conclusion, '项目依赖', 'a VPM dependency is not a body-compatibility answer');
  assert.match(shortcut.compat.basis, /example\.invalid/, 'the basis names the repository it came from');
  assert.doesNotMatch(shortcut.compat.basis, /无可导入分包|待骨骼比对/, 'the basis must not read as an unimportable source or a fit conclusion');

  const alternate = byItem('3');
  assert.equal(alternate.files.find(file => file.selected)!.kind, 'vpm');
  assert.deepEqual(alternate.vpm.map(row => [row.form, row.repository]), [['repository-url', ALTERNATE]]);
  assert.equal(alternate.compat.conclusion, '项目依赖');

  const prose = byItem('4');
  assert.equal(prose.files.some(file => file.selected), false, 'a README that merely mentions a URL is not an entry');
  assert.deepEqual(prose.vpm, []);

  const mixed = byItem('5');
  assert.deepEqual(mixed.vpm, [], 'a bundle with an importable package is not also declared as a VPM dependency');

  const requirements = JSON.parse(readFileSync(join(project, '_harness/intake/vpm-requirements.json'), 'utf8'));
  assert.equal(requirements.schema, 'vpm-requirements/0.1');
  assert.deepEqual(requirements.requirements.map((row: { repository: string }) => row.repository).sort(),
    [ALTERNATE, REPOSITORY]);
  assert.ok(requirements.requirements.every((row: { sourceSha256: string }) => /^[0-9a-f]{64}$/.test(row.sourceSha256)));

  // The check reads the record, so the fourth conclusion has to be one the observer accepts with a real basis.
  const observed = join(root, 'observed.json');
  const observe = spawnSync('python3', [observer, '--library', library, '--project', project, '--out', observed],
    { env: { ...env, AVH_STAGE: 'intake', AVH_MANIFEST: JSON.stringify(manifest), AVH_PROJECT_DIR: project }, encoding: 'utf8' });
  assert.equal(observe.status, 0, observe.stderr);
  const metrics = JSON.parse(readFileSync(observed, 'utf8')).metrics;
  assert.equal(metrics.items_without_valid_compat_conclusion, 0);
  assert.equal(metrics.items_with_vpm_dependencies, 2);
});

// The environment prepares the recorded dependency like a frozen recipe package — same pin fields, same
// independent checks — and a repository it cannot read stops the preparation instead of quietly dropping the
// dependency. The repository read is replaced here, so this test never touches a real remote.
test('the recorded dependency is pinned and installed, and an unreadable repository stops preparation', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-vpm-environment-'));
  t.after(() => removeTemp(root));
  const output = execFileSync('python3', ['-c', `import hashlib,json,subprocess,sys,zipfile
from pathlib import Path
tools, root = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(tools))
import environment as e, setup

def archive(path, files):
    with zipfile.ZipFile(path, 'w') as z:
        for name, value in files.items(): z.writestr(name, value)
    return hashlib.sha256(path.read_bytes()).hexdigest()

REQUIREMENT = {'item': 'Tool-1', 'role': 'other', 'entry': 'Tool-v2-VCC.url', 'sourceSha256': 'a' * 64,
               'form': 'installer-link', 'member': 'Tool-v2-VCC.url', 'repository': 'https://repo.invalid/index.json'}

# A synthetic template and one frozen base package, seeded into the exact cache the tool reads so no network is used.
template = root / 'template.zip'
template_hash = archive(template, {'avatar/ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.22f1\\n',
                                   'avatar/Packages/manifest.json': json.dumps({'dependencies': {}})})
base = root / 'base.zip'
base_hash = archive(base, {'package.json': json.dumps({'name': 'fixture.base', 'version': '1.0.0'})})
tool = root / 'tool.zip'
tool_hash = archive(tool, {'package.json': json.dumps({'name': 'fixture.vpm.tool', 'version': '1.2.0',
                                                       'vpmDependencies': {'fixture.base': '>=1.0.0'}}),
                           'Editor/Tool.cs': '// vendor tool'})
recipe = {'schema': 'environment-recipe/0.1', 'id': 'vpm-fixture', 'unity': '2022.3.22f1', 'platform': 'pc',
          'maxDownloadBytes': 1000000, 'maxExpandedBytes': 1000000,
          'template': {'url': 'https://invalid.example/template', 'sha256': template_hash},
          'packages': [{'id': 'fixture.base', 'version': '1.0.0', 'url': 'https://invalid.example/base',
                        'sha256': base_hash}]}
(root / 'recipe.json').write_text(json.dumps(recipe))
listing = {'packages': {'fixture.vpm.tool': {'versions': {
    '1.2.0': {'name': 'fixture.vpm.tool', 'version': '1.2.0', 'url': 'https://repo.invalid/tool-1.2.0.zip',
              'zipSHA256': tool_hash, 'vpmDependencies': {'fixture.base': '>=1.0.0'}},
    '1.3.0-beta.1': {'name': 'fixture.vpm.tool', 'version': '1.3.0-beta.1', 'url': 'https://repo.invalid/beta.zip',
                     'zipSHA256': 'b' * 64}}}}}
real_listing = e.repository_listing
e.repository_listing = lambda url, limit: listing

def deliver(project, requirement=REQUIREMENT):
    (project / '_harness' / 'intake').mkdir(parents=True, exist_ok=True)
    (project / '_harness' / 'intake' / 'vpm-requirements.json').write_text(json.dumps(
        {'schema': 'vpm-requirements/0.1', 'requirements': [requirement]}))
    cache = project / '_harness' / 'environment' / 'cache'
    cache.mkdir(parents=True, exist_ok=True)
    for name, digest in (('template.zip', template_hash), ('base.zip', base_hash), ('tool.zip', tool_hash)):
        (cache / (digest + '.zip')).write_bytes((root / name).read_bytes())

project = root / 'project'
deliver(project)
lock = e.prepare(project, root / 'recipe.json')
baseline = project / '_harness' / 'environment' / 'baseline'
metadata = json.loads((baseline / 'Packages' / 'fixture.vpm.tool' / 'package.json').read_text())
manifest = json.loads((baseline / 'Packages' / 'vpm-manifest.json').read_text())
assert metadata['version'] == '1.2.0', metadata
assert manifest['dependencies']['fixture.vpm.tool'] == {'version': '1.2.0'}, manifest
assert manifest['locked']['fixture.vpm.tool'] == {'version': '1.2.0', 'sha256': tool_hash,
                                                  'dependencies': {'fixture.base': '>=1.0.0'}}, manifest
assert manifest['locked']['fixture.base']['sha256'] == base_hash, manifest
pin = lock['vpmRequirements']['packages'][0]
assert pin['id'] == 'fixture.vpm.tool' and pin['version'] == '1.2.0' and pin['sha256'] == tool_hash, pin
assert pin['dependencies'] == {'fixture.base': '>=1.0.0'}, pin
assert lock['vpmRequirements']['requests'] == [REQUIREMENT], lock['vpmRequirements']
assert e.verify(project / '_harness' / 'environment', e.recipe_file(root / 'recipe.json'),
                e.digest(root / 'recipe.json')) == lock, 'the accepted lock rereads clean'

# A requirement that changes after acceptance must be reported, never silently kept.
deliver(project, {**REQUIREMENT, 'repository': 'https://other.invalid/index.json'})
try:
    e.verify(project / '_harness' / 'environment', e.recipe_file(root / 'recipe.json'), e.digest(root / 'recipe.json'))
    raise AssertionError('a changed dependency was accepted')
except ValueError as error:
    assert 'VPM 依赖' in str(error), error
try:
    e.prepare(project, root / 'recipe.json')
    raise AssertionError('prepare reused a baseline that lacks the recorded dependency')
except ValueError as error:
    assert 'VPM 依赖' in str(error), error
deliver(project)

# setup copies the accepted package into the working project and reports it as the registered item's install.
record = {}
setup.baseline(baseline, project, record)
assert (project / 'Packages' / 'fixture.vpm.tool' / 'package.json').is_file(), record
assert record['vpm_packages']['fixture.vpm.tool'] == '1.2.0', record

# The setup import record has to carry the registered item's package root, or the delivered avatar's
# references to the dependency could not be traced back to the input that asked for it.
files = root / 'library' / 'Plugin-Tool-1' / 'files'
files.mkdir(parents=True)
bundle = files / 'Tool-v2-VCC.url'
archive(bundle, {'Tool-v2-VCC.url': 'URL=vcc://vpm/addRepo?url=https://repo.invalid/index.json\\n'})
inventory = {'schema': 'inventory/0.1', 'body_key': None, 'items': [
    {'item': 'Tool-1', 'role': 'other', 'found': True, 'files': [
        {'name': 'Tool-v2-VCC.url', 'selected': True, 'kind': 'vpm',
         'sha256': hashlib.sha256(bundle.read_bytes()).hexdigest()}]}]}
(root / 'scratch').mkdir()
reports = {}
setup.unpack_selected(project, root / 'library', inventory, root / 'scratch', reports)
row = reports['packages'][0]
assert row['kind'] == 'vpm' and row['roots'] == ['Packages/fixture.vpm.tool'], row
assert row['dependencies'] == [{'id': 'fixture.vpm.tool', 'version': '1.2.0'}], row

# An installation entry whose package no accepted environment holds is a hard failure, not an empty import.
bare = root / 'bare'
bare.mkdir()
(root / 'scratch2').mkdir()
try:
    setup.unpack_selected(bare, root / 'library', inventory, root / 'scratch2', {})
    raise AssertionError('an installed dependency with no accepted environment was silently skipped')
except ValueError as error:
    assert 'VPM 依赖' in str(error), error

# Item 2: reuse must honor the new pin. Two registered inputs can name the same identity and version from
# different repositories; when the bytes differ the second one must fail instead of registering a digest
# that was never downloaded while the first package stays in place.
def listing_for(archive_hash, url, dependencies=None):
    return {'packages': {'fixture.vpm.tool': {'versions': {
        '1.2.0': {'name': 'fixture.vpm.tool', 'version': '1.2.0', 'url': url, 'zipSHA256': archive_hash,
                  'vpmDependencies': dependencies if dependencies is not None else {'fixture.base': '>=1.0.0'}}}}}}

alternative = root / 'alternative.zip'
alternative_hash = archive(alternative, {'package.json': json.dumps(
    {'name': 'fixture.vpm.tool', 'version': '1.2.0', 'vpmDependencies': {'fixture.base': '>=1.0.0'}}),
    'Editor/Tool.cs': '// different bytes'})
duplicate = root / 'duplicate'
deliver(duplicate)
(duplicate / '_harness' / 'intake' / 'vpm-requirements.json').write_text(json.dumps(
    {'schema': 'vpm-requirements/0.1', 'requirements': [
        REQUIREMENT, {**REQUIREMENT, 'item': 'Tool-2', 'repository': 'https://other.invalid/index.json'}]}))
duplicate_cache = duplicate / '_harness' / 'environment' / 'cache'
(duplicate_cache / (alternative_hash + '.zip')).write_bytes(alternative.read_bytes())
listings = {'https://repo.invalid/index.json': listing_for(tool_hash, 'https://repo.invalid/tool-1.2.0.zip'),
            'https://other.invalid/index.json': listing_for(alternative_hash, 'https://other.invalid/tool-1.2.0.zip')}
e.repository_listing = lambda url, limit: listings[url]
try:
    e.prepare(duplicate, root / 'recipe.json')
    raise AssertionError('a same-version, different-hash reuse was accepted')
except ValueError as error:
    assert '归档哈希' in str(error), error
assert not (duplicate / '_harness' / 'environment' / 'baseline').exists(), 'the conflicting reuse published a baseline'

# The same identity, version and digest reused from a second input is legitimate, and the reuse still has to
# re-read the archive instead of trusting the version: the probe that found this defect measured zero
# download calls on the reuse branch.
same = root / 'same'
deliver(same)
(same / '_harness' / 'intake' / 'vpm-requirements.json').write_text(json.dumps(
    {'schema': 'vpm-requirements/0.1', 'requirements': [REQUIREMENT, {**REQUIREMENT, 'item': 'Tool-2'}]}))
e.repository_listing = lambda url, limit: listing_for(tool_hash, 'https://repo.invalid/tool-1.2.0.zip')
counted = {'downloads': 0}
product_download = e.download
def counting_download(item, cache, limit):
    if item['sha256'] == tool_hash:
        counted['downloads'] += 1
    return product_download(item, cache, limit)
e.download = counting_download
try:
    same_lock = e.prepare(same, root / 'recipe.json')
finally:
    e.download = product_download
assert counted['downloads'] == 2, counted
assert len(same_lock['vpmRequirements']['packages']) == 2, same_lock['vpmRequirements']
assert {pin['sha256'] for pin in same_lock['vpmRequirements']['packages']} == {tool_hash}

# Item 5: a declared range the installed version does not satisfy is a hard failure, and so is a range the
# checker cannot read. Neither may be treated as "the dependency exists".
def strict_project(name, dependencies):
    directory = root / name
    deliver(directory)
    archive_path = root / (name + '-tool.zip')
    archive_hash = archive(archive_path, {'package.json': json.dumps(
        {'name': 'fixture.vpm.tool', 'version': '1.2.0', 'vpmDependencies': dependencies})})
    (directory / '_harness' / 'environment' / 'cache' / (archive_hash + '.zip')).write_bytes(archive_path.read_bytes())
    e.repository_listing = lambda url, limit, h=archive_hash, d=dependencies: listing_for(h, 'https://repo.invalid/tool.zip', d)
    return directory
for name, dependencies in (('unsatisfied', {'fixture.base': '>=99.0.0'}), ('unreadable', {'fixture.base': 'later'}),
                            ('short-circuit', {'fixture.base': '>=1.0.0 || <x.1'})):
    strict = strict_project(name, dependencies)
    try:
        e.prepare(strict, root / 'recipe.json')
        raise AssertionError('an unusable VPM range was accepted: ' + name)
    except ValueError as error:
        assert '版本范围' in str(error), (name, error)
    assert not (strict / '_harness' / 'environment' / 'baseline').exists(), name

# The range shapes real VPM packages declare, including partial versions, alternatives and prerelease
# ceilings, have to decide rather than raise, or the frozen recipe itself would stop preparing.
for version, requirement, expected in [
        ('1.14.3', '>=1.14.3 <2.0.0-a', True), ('1.18.1', '^1.14.0', True),
        ('3.10.4', '>=3.7.0 <3.11.0', True), ('3.10.4', '>=3.10.4 <3.11.X', True),
        ('3.10.4', '3.2 - 3.10', True), ('1.9.16', '>=1.8.0 <2.0.0', True),
        ('1.2.3', '1.0.0 || 1.2.3', True), ('0.2.5', '^0.2.3', True), ('0.3.0', '^0.2.3', False),
        ('1.3.0', '~1.2.0', False), ('2.0.0', '1.x', False), ('1.2.3', '^1.2.3 || >=99.0.0', True)]:
    assert e.satisfies_range(version, requirement) is expected, (version, requirement)
for broken in ('', 'later', '>=', '>=1.0.0 || ', '>=1.0.0 || later', '>=1.0.0 || <x.1'):
    try:
        e.satisfies_range('1.0.0', broken)
        raise AssertionError('an unreadable range was accepted: ' + repr(broken))
    except ValueError:
        pass
# R5b item 5: parsing every alternative before deciding, not after the first satisfied one. 1.2.3 satisfies
# ^1.2.3 and 1.0.0 satisfies >=1.0.0, so an implementation that returns on the first hit never reads the
# unreadable tail and accepts text the vendor never wrote. The last case is the same shape three deep.
for version, broken in (('1.2.3', '^1.2.3 || >='), ('1.2.3', '^1.2.3 || later'),
                        ('1.0.0', '>=1.0.0 || >=1.0.0 || nope')):
    try:
        e.satisfies_range(version, broken)
        raise AssertionError('an unreadable alternative after a satisfied one was accepted: ' + repr(broken))
    except ValueError:
        pass

# Item 3: a name in a remote listing is an identity that becomes a path, so it is validated before any
# extraction or copy. The counterexample asserts nothing was unpacked or copied at all, not merely that a
# later publication step refused the result.
traversal = root / 'traversal'
deliver(traversal)
hostile = 'test.tool/../../../../escaped'
# Seed the archive the hostile pin names, so removing the name validation would reach extraction instead of a
# network error: the counterexample has to fail on the write it forbids, not on an unreachable host.
hostile_archive = root / 'hostile.zip'
hostile_hash = archive(hostile_archive, {'package.json': json.dumps({'name': hostile, 'version': '1.2.0'})})
(traversal / '_harness' / 'environment' / 'cache' / (hostile_hash + '.zip')).write_bytes(hostile_archive.read_bytes())
e.repository_listing = lambda url, limit: {'packages': {hostile: {'versions': {
    '1.2.0': {'name': hostile, 'version': '1.2.0', 'url': 'https://repo.invalid/hostile.zip',
              'zipSHA256': hostile_hash, 'vpmDependencies': {}}}}}}
touched = []
real_extract, real_copytree = e.extract, e.shutil.copytree
def recording_extract(archive_path, destination, limit, *rest):
    touched.append(str(destination))
    return real_extract(archive_path, destination, limit, *rest)
def recording_copytree(source, destination, *args, **kwargs):
    touched.append(str(destination))
    return real_copytree(source, destination, *args, **kwargs)
e.extract, e.shutil.copytree = recording_extract, recording_copytree
try:
    e.prepare(traversal, root / 'recipe.json')
    raise AssertionError('a traversal package name was accepted')
except ValueError as error:
    assert '包名' in str(error), error
finally:
    e.extract, e.shutil.copytree = real_extract, real_copytree
assert not any('escaped' in path for path in touched), touched
assert not (traversal / 'escaped').exists() and not (root / 'escaped').exists(), 'the hostile name escaped its directory'
e.repository_listing = lambda url, limit: listing

# Item 4: verify must reconcile the accepted pins with the dependency lock and the installed packages, not
# with the recorded requests alone. The doctor rewrites lock and receipt together, and the receipt is outside
# the frozen tree, so each mutation survives every earlier check and only the independent reconcile refuses it.
lock_path = project / '_harness' / 'environment' / 'environment-lock.json'
accepted_lock = lock_path.read_text(encoding='utf-8')
def doctor(change):
    value = e.read(lock_path)
    change(value)
    e.write(lock_path, value)
    e.write(baseline / '.environment-receipt.json', value)
def rejected(change, expected):
    doctor(change)
    try:
        e.verify(project / '_harness' / 'environment', e.recipe_file(root / 'recipe.json'), e.digest(root / 'recipe.json'))
        raise AssertionError('a doctored accepted pin was accepted: ' + expected)
    except ValueError as error:
        assert expected in str(error), (expected, error)
    finally:
        lock_path.write_text(accepted_lock, encoding='utf-8')
        e.write(baseline / '.environment-receipt.json', e.read(lock_path))
rejected(lambda value: value['vpmRequirements']['packages'][0].update(sha256='d' * 64), '归档哈希')
rejected(lambda value: value['vpmRequirements']['packages'][0].update(version='9.9.9'), '兑现到依赖锁')
rejected(lambda value: value['vpmRequirements']['packages'][0].update(dependencies={'fixture.base': '>=99.0.0'}), '依赖声明')
rejected(lambda value: value['vpmRequirements'].update(packages=[]), '缺少请求对应的 pin')
# R5b item 4: a pin is tied to the request's source key, not to the item alone. These keep the pin count
# and every other field intact — exactly what the review's in-memory probe did — so only the source-key
# closure can refuse them: a plaintext repository is not a fixed source, and a repository the order never
# registered is a different dependency. The item is the other half of the same key.
rejected(lambda value: value['vpmRequirements']['packages'][0].update(repository='http://repo.invalid/index.json'), 'HTTPS')
rejected(lambda value: value['vpmRequirements']['packages'][0].update(repository='https://unapproved.invalid/index.json'), '不在本单登记')
rejected(lambda value: value['vpmRequirements']['packages'][0].update(item='Tool-9'), '不在本单登记')
# One request answered is not the closure. With two registered sources, a lock that pins the first still
# leaves the second dependency uninstalled, so the missing source key is refused by name.
second = {**REQUIREMENT, 'item': 'Tool-2', 'repository': 'https://other.invalid/index.json'}
registration = project / '_harness' / 'intake' / 'vpm-requirements.json'
saved_registration = registration.read_text(encoding='utf-8')
registration.write_text(json.dumps({'schema': 'vpm-requirements/0.1', 'requirements': [REQUIREMENT, second]}))
try:
    two = e.read(lock_path)
    two['vpmRequirements']['requests'] = e.vpm_requirements(project)
    e.write(lock_path, two)
    e.write(baseline / '.environment-receipt.json', two)
    try:
        e.verify_vpm_requirements(project, baseline, e.recipe_file(root / 'recipe.json'), e.read(lock_path))
        raise AssertionError('a request with no pin was accepted')
    except ValueError as error:
        assert '缺少请求对应的 pin' in str(error) and 'Tool-2' in str(error), error
finally:
    registration.write_text(saved_registration, encoding='utf-8')
    lock_path.write_text(accepted_lock, encoding='utf-8')
    e.write(baseline / '.environment-receipt.json', e.read(lock_path))
assert e.verify(project / '_harness' / 'environment', e.recipe_file(root / 'recipe.json'),
                e.digest(root / 'recipe.json'))['vpmRequirements']['packages'], 'the restored lock rereads clean'
# A pin has to appear in the dependency declaration as well as the lock; a lock entry with no declaration is
# a mapping error, so the reconcile is called directly on a manifest that dropped it.
manifest_path = baseline / 'Packages' / 'vpm-manifest.json'
original_manifest = manifest_path.read_text(encoding='utf-8')
try:
    manifest_value = e.read(manifest_path)
    manifest_value['dependencies'].pop('fixture.vpm.tool')
    e.write(manifest_path, manifest_value)
    e.verify_vpm_requirements(project, baseline, e.recipe_file(root / 'recipe.json'), e.read(lock_path))
    raise AssertionError('a pin missing from the dependency declaration was accepted')
except ValueError as error:
    assert '依赖声明' in str(error), error
finally:
    manifest_path.write_text(original_manifest, encoding='utf-8')
assert e.verify(project / '_harness' / 'environment', e.recipe_file(root / 'recipe.json'),
                e.digest(root / 'recipe.json'))['vpmRequirements']['packages'], 'the restored manifest rereads clean'

# Item 4 continued: the setup observation joins each approved VPM entry with the registration, the accepted
# pin, the package in the project and the import record. A missing record is a pending import; a record that
# disagrees is a conflict. The pending list used to walk only .unitypackage members, so neither was visible.
inventory['items'][0]['files'][0].update(
    sha256=REQUIREMENT['sourceSha256'],
    vpm=[{'repository': REQUIREMENT['repository'], 'form': REQUIREMENT['form'], 'member': REQUIREMENT['member']}])
(project / '_harness' / 'intake').mkdir(parents=True, exist_ok=True)
(project / '_harness' / 'intake' / 'inventory.json').write_text(json.dumps(inventory))
(project / '_harness' / 'intake' / 'vpm-requirements.json').write_text(json.dumps(
    {'schema': 'vpm-requirements/0.1', 'requirements': [REQUIREMENT]}))
(project / '_harness' / 'setup').mkdir(parents=True, exist_ok=True)
def observed(change=None):
    document = json.loads(json.dumps(reports))
    if change is not None:
        change(document)
    (project / '_harness' / 'setup' / 'import.json').write_text(json.dumps(document))
    out = root / 'project-observation.json'
    subprocess.run([sys.executable, str(tools / 'observe_project.py'), '--project', str(project),
                    '--environment-tool', str(tools / 'environment.py'),
                    '--environment-recipe', str(root / 'recipe.json'), '--out', str(out)],
                   check=True, capture_output=True)
    return json.loads(out.read_text())['metrics']
clean = observed()
assert clean['remaining_unopened_archives'] == 0 and clean['vpm_import_records_consistent'] is True, clean
missing = observed(lambda document: document.update(packages=[]))
assert missing['remaining_unopened_archives'] == 1, missing
wrong = observed(lambda document: document['packages'][0].update(dependencies=[{'id': 'fixture.vpm.tool', 'version': '9.9.9'}]))
assert wrong['unresolved_unpack_conflicts'] == 1 and wrong['vpm_import_records_consistent'] is False, wrong
# R5b item 4, setup closure: the observation joins each approved entry with its pin by the same source key.
# The accepted lock is doctored together with its receipt, so every other reader still sees a consistent
# environment and only the source-key join can see these. Matching on the item alone accepted all three.
def observed_with_lock(change):
    value = e.read(lock_path)
    change(value)
    e.write(lock_path, value)
    e.write(baseline / '.environment-receipt.json', value)
    try:
        return observed()
    finally:
        lock_path.write_text(accepted_lock, encoding='utf-8')
        e.write(baseline / '.environment-receipt.json', e.read(lock_path))
plaintext = observed_with_lock(lambda value: value['vpmRequirements']['packages'][0].update(repository='http://repo.invalid/index.json'))
assert plaintext['unresolved_unpack_conflicts'] >= 1 and plaintext['vpm_import_records_consistent'] is False, plaintext
unapproved = observed_with_lock(lambda value: value['vpmRequirements']['packages'][0].update(repository='https://unapproved.invalid/index.json'))
assert unapproved['unresolved_unpack_conflicts'] >= 1 and unapproved['vpm_import_records_consistent'] is False, unapproved
unpinned = observed_with_lock(lambda value: value['vpmRequirements'].update(packages=[]))
assert unpinned['unresolved_unpack_conflicts'] >= 1 and unpinned['vpm_import_records_consistent'] is False, unpinned

# Unreadable repositories stop preparation and publish nothing.
unreadable = root / 'unreadable'
deliver(unreadable)
def unavailable(url, limit):
    raise ValueError('VPM 仓库不可用，不能跳过本单的项目依赖：' + url)
e.repository_listing = unavailable
try:
    e.prepare(unreadable, root / 'recipe.json')
    raise AssertionError('an unreachable repository did not stop preparation')
except ValueError as error:
    assert 'VPM 仓库不可用' in str(error), error
assert not (unreadable / '_harness' / 'environment' / 'baseline').exists(), 'a failed preparation published a baseline'
assert not (unreadable / '_harness' / 'environment' / 'environment-lock.json').exists(), 'a failed preparation published a lock'

# The real reader refuses a non-HTTPS repository before it opens anything.
try:
    real_listing('http://repo.invalid/index.json', 1000)
    raise AssertionError('a plaintext repository was accepted')
except ValueError as error:
    assert 'HTTPS' in str(error), error

# R5b item 3: a legitimate reuse has to end with a complete lock. A custom template is a second,
# structurally different fixture from the managed one above: no recipe packages, the dependency already in
# the tree, and a vpm-manifest whose lock entry carries the version but no digest. Reuse re-reads and
# verifies the archive, so it is sound; what it also has to do is record where those verified bytes came
# from. Without that the environment is published and every verify() afterwards refuses it.
custom = root / 'custom-template'
custom_packages = custom / 'Packages'
(custom / 'ProjectSettings').mkdir(parents=True)
(custom / 'ProjectSettings' / 'ProjectVersion.txt').write_text('m_EditorVersion: 2022.3.22f1\\n')
custom_packages.mkdir()
(custom_packages / 'manifest.json').write_text(json.dumps({'dependencies': {}}))
(custom_packages / 'vpm-manifest.json').write_text(json.dumps({
    'dependencies': {'fixture.base': {'version': '1.0.0'}, 'fixture.vpm.tool': {'version': '1.2.0'}},
    'locked': {'fixture.base': {'version': '1.0.0', 'sha256': base_hash, 'dependencies': {}},
               'fixture.vpm.tool': {'version': '1.2.0'}}}))
(custom_packages / 'fixture.base').mkdir()
(custom_packages / 'fixture.base' / 'package.json').write_text(json.dumps({'name': 'fixture.base', 'version': '1.0.0'}))
for relative, value in {'package.json': json.dumps({'name': 'fixture.vpm.tool', 'version': '1.2.0',
                                                    'vpmDependencies': {'fixture.base': '>=1.0.0'}}),
                        'Editor/Tool.cs': '// vendor tool'}.items():
    written = custom_packages / 'fixture.vpm.tool' / relative
    written.parent.mkdir(parents=True, exist_ok=True)
    written.write_text(value)
reuse = root / 'reuse'
deliver(reuse)
e.repository_listing = lambda url, limit: listing_for(tool_hash, 'https://repo.invalid/tool-1.2.0.zip')
reuse_lock = e.prepare(reuse, root / 'recipe.json', str(custom))
reused = e.read(reuse / '_harness' / 'environment' / 'baseline' / 'Packages' / 'vpm-manifest.json')['locked']['fixture.vpm.tool']
assert reused.get('sha256') == tool_hash, reused
assert reused.get('dependencies') == {'fixture.base': '>=1.0.0'}, reused
assert len(reuse_lock['vpmRequirements']['packages']) == 1, reuse_lock['vpmRequirements']
assert e.verify(reuse / '_harness' / 'environment', e.recipe_file(root / 'recipe.json'),
                e.digest(root / 'recipe.json')) == reuse_lock, 'the reused environment rereads clean'

# One item can name the same repository through two files — a shortcut and a translated copy of it, or the
# same address written as a repository listing — and the intake records each spelling as its own request.
# The same (item, id, repository) installs and is recorded once: a second pin for it is a duplicate the
# accepted-lock reconcile refuses, so it must never be written.
same_source = root / 'same-source'
deliver(same_source)
(same_source / '_harness' / 'intake' / 'vpm-requirements.json').write_text(json.dumps(
    {'schema': 'vpm-requirements/0.1', 'requirements': [
        REQUIREMENT,
        {**REQUIREMENT, 'entry': 'Tool-v2-VCC-6-copy.url', 'member': 'Tool-v2-VCC-6-copy.url'},
        {**REQUIREMENT, 'form': 'repository-url', 'entry': 'repository.txt', 'member': 'repository.txt'}]}))
e.repository_listing = lambda url, limit: listing_for(tool_hash, 'https://repo.invalid/tool-1.2.0.zip')
same_source_lock = e.prepare(same_source, root / 'recipe.json')
same_pins = same_source_lock['vpmRequirements']['packages']
assert len(same_pins) == 1 and same_pins[0]['item'] == 'Tool-1', same_pins
assert e.verify(same_source / '_harness' / 'environment', e.recipe_file(root / 'recipe.json'),
                e.digest(root / 'recipe.json')) == same_source_lock, 'the deduplicated environment rereads clean'

# Two different repositories for the same item are not a duplicate to drop: the second source is a request
# with its own key and one pin cannot answer both. It is refused before publication, so the input can be
# fixed; the same refusal after the rename would leave an environment nobody can accept.
two_sources = root / 'two-sources'
deliver(two_sources)
(two_sources / '_harness' / 'intake' / 'vpm-requirements.json').write_text(json.dumps(
    {'schema': 'vpm-requirements/0.1', 'requirements': [
        REQUIREMENT, {**REQUIREMENT, 'repository': 'https://other.invalid/index.json'}]}))
e.repository_listing = lambda url, limit: listing_for(tool_hash, 'https://repo.invalid/tool-1.2.0.zip')
try:
    e.prepare(two_sources, root / 'recipe.json')
    raise AssertionError('one pin was accepted as the answer for two different sources')
except ValueError as error:
    assert '重复登记' in str(error), error
assert not (two_sources / '_harness' / 'environment' / 'baseline').exists(), 'the duplicate pin published a baseline'

# R5b item 3 ordering: every closure check runs against the candidate. The probe replaces the reconcile
# with one that refuses, so the only observable difference is whether a baseline was published first.
ordering = root / 'ordering'
deliver(ordering)
e.repository_listing = lambda url, limit: listing_for(tool_hash, 'https://repo.invalid/tool-1.2.0.zip')
real_reconcile = e.verify_vpm_requirements
def refusing_reconcile(*rest):
    raise ValueError('依赖闭环核验拒绝')
e.verify_vpm_requirements = refusing_reconcile
try:
    e.prepare(ordering, root / 'recipe.json')
    raise AssertionError('a refused closure still published an environment')
except ValueError as error:
    assert '拒绝' in str(error), error
finally:
    e.verify_vpm_requirements = real_reconcile
refused = ordering / '_harness' / 'environment'
assert not (refused / 'baseline').exists(), 'the refused closure published a baseline'
assert not (refused / 'environment-lock.json').exists(), 'the refused closure published a lock'

# The request side of the same source key is validated where the record is read, before any resolution: a
# plaintext repository cannot be registered as a fixed source at all, so neither prepare nor verify can ever
# accept one and no candidate is published for it.
plaintext_request = root / 'plaintext-request'
deliver(plaintext_request)
(plaintext_request / '_harness' / 'intake' / 'vpm-requirements.json').write_text(json.dumps(
    {'schema': 'vpm-requirements/0.1', 'requirements': [{**REQUIREMENT, 'repository': 'http://repo.invalid/index.json'}]}))
try:
    e.prepare(plaintext_request, root / 'recipe.json')
    raise AssertionError('a plaintext request repository was accepted')
except ValueError as error:
    assert '必须固定在 HTTPS 仓库' in str(error), error
assert not (plaintext_request / '_harness' / 'environment' / 'baseline').exists(), 'a plaintext request published a baseline'
print('vpm environment fixture ok')
`, tools, root], { env, encoding: 'utf8' });
  assert.match(output, /vpm environment fixture ok/);
});

// The fixture above pre-seeds the archive cache, so it never exercises the code that actually fetches bytes.
// This one puts a double in front of urllib and drives the real `repository_listing` and `download` over it:
// the listing is parsed and budgeted, the archive is fetched, digest-checked and cached, a body that does not
// match the pin is refused without publishing cache, and the redirect handler still refuses a plaintext hop.
test('the product download path fetches, verifies and refuses bytes through a network double', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-vpm-download-'));
  t.after(() => removeTemp(root));
  const output = execFileSync('python3', ['-c', `import hashlib,json,sys
from pathlib import Path
tools, root = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(tools))
import environment as e
payload = b'archive bytes the fixture serves'
digest = hashlib.sha256(payload).hexdigest()

class Response:
    def __init__(self, body, status=200, headers=None):
        self.body, self.status, self.headers = body, status, headers or {}
    def __enter__(self): return self
    def __exit__(self, *rest): return False
    def read(self, size=-1):
        if size is None or size < 0:
            chunk, self.body = self.body, b''
        else:
            chunk, self.body = self.body[:size], self.body[size:]
        return chunk

class Network:
    def __init__(self): self.requests, self.bodies = [], {}
    def build_opener(self, *handlers): return self
    def open(self, request, timeout=None):
        self.requests.append(request)
        return Response(self.bodies[request.full_url])

network = Network()
network.bodies['https://repo.invalid/tool.zip'] = payload
network.bodies['https://repo.invalid/index.json'] = json.dumps(
    {'packages': {'fixture.tool': {'versions': {'1.0.0': {
        'name': 'fixture.tool', 'version': '1.0.0', 'url': 'https://repo.invalid/tool.zip',
        'zipSHA256': digest, 'vpmDependencies': {}}}}}}).encode()
real_build = e.urllib.request.build_opener
e.urllib.request.build_opener = network.build_opener
try:
    listing = e.repository_listing('https://repo.invalid/index.json', 100000)
    pins = e.resolve_vpm_requirement({'item': 'Tool-1', 'repository': 'https://repo.invalid/index.json'}, listing)
    assert pins[0]['sha256'] == digest and pins[0]['version'] == '1.0.0', pins
    cache = root / 'cache'
    target = e.download({'url': 'https://repo.invalid/tool.zip', 'sha256': digest}, cache, 100000)
    assert target == cache / (digest + '.zip') and target.read_bytes() == payload, target
    assert [request.full_url for request in network.requests].count('https://repo.invalid/tool.zip') == 1
    # A body that does not match the pin is a hard failure and is never published as usable cache.
    try:
        e.download({'url': 'https://repo.invalid/tool.zip', 'sha256': 'f' * 64}, root / 'bad-cache', 100000)
        raise AssertionError('a body that does not match the pin was accepted')
    except ValueError as error:
        assert '摘要不一致' in str(error), error
    assert not (root / 'bad-cache' / ('f' * 64 + '.zip')).exists()
    # A listing larger than the budget is refused by the reader, not silently truncated.
    try:
        e.repository_listing('https://repo.invalid/index.json', 4)
        raise AssertionError('an oversized listing was accepted')
    except ValueError as error:
        assert '预算' in str(error), error
finally:
    e.urllib.request.build_opener = real_build
# The redirect handler is what keeps a real fetch from downgrading to plaintext.
try:
    e.HttpsRedirect().redirect_request(None, None, 302, 'Found', {}, 'http://repo.invalid/tool.zip')
    raise AssertionError('a plaintext redirect was followed')
except ValueError as error:
    assert 'HTTPS' in str(error), error
print('vpm download path ok')
`, tools, root], { env, encoding: 'utf8' });
  assert.match(output, /vpm download path ok/);
});

// A single product can expose several VPM entries. Each file must report only the source key it carries,
// while the product-level closure still requires every approved source and rejects an unapproved one.
test('multi-entry VPM products keep per-file pins and missing observation data becomes a conflict', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-vpm-multi-entry-'));
  t.after(() => removeTemp(root));
  const output = execFileSync('python3', ['-c', `import json,sys
from pathlib import Path
tools, root = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(tools))
import setup, observe_project

first_repo = 'https://first.invalid/index.json'
second_repo = 'https://second.invalid/index.json'
first_id, second_id = 'fixture.vpm.first', 'fixture.vpm.second'
project = root / 'project'; library = root / 'library'; scratch = root / 'scratch'
(project / '_harness' / 'environment').mkdir(parents=True)
(project / 'Packages' / first_id).mkdir(parents=True)
(project / 'Packages' / second_id).mkdir(parents=True)
(project / 'Packages' / first_id / 'package.json').write_text(json.dumps({'name': first_id, 'version': '1.0.0'}))
(project / 'Packages' / second_id / 'package.json').write_text(json.dumps({'name': second_id, 'version': '2.0.0'}))
first_zip, second_zip = root / 'first.zip', root / 'second.zip'
first_zip.write_bytes(b'first entry'); second_zip.write_bytes(b'second entry')
first_sha, second_sha = 'a' * 64, 'b' * 64
pins = [
    {'item': 'Multi', 'id': first_id, 'version': '1.0.0', 'repository': first_repo, 'sha256': first_sha, 'url': 'https://first.invalid/first.zip', 'dependencies': {}},
    {'item': 'Multi', 'id': second_id, 'version': '2.0.0', 'repository': second_repo, 'sha256': second_sha, 'url': 'https://second.invalid/second.zip', 'dependencies': {}},
]
requirements = [
    {'item': 'Multi', 'repository': first_repo, 'member': 'first.url', 'entry': 'first.zip', 'sourceSha256': first_sha},
    {'item': 'Multi', 'repository': second_repo, 'member': 'second.url', 'entry': 'second.zip', 'sourceSha256': second_sha},
]
lock = {'vpmRequirements': {'requests': requirements, 'packages': pins}}
(project / '_harness' / 'environment' / 'environment-lock.json').write_text(json.dumps(lock))
item = {'item': 'Multi', 'role': 'other', 'files': [
    {'name': 'first.zip', 'selected': True, 'kind': 'vpm', 'sha256': first_sha,
     'vpm': [{'repository': first_repo, 'member': 'first.url'}]},
    {'name': 'second.zip', 'selected': True, 'kind': 'vpm', 'sha256': second_sha,
     'vpm': [{'repository': second_repo, 'member': 'second.url'}]},
]}
inventory = {'items': [item]}
(project / '_harness' / 'intake').mkdir(parents=True)
(project / '_harness' / 'intake' / 'vpm-requirements.json').write_text(json.dumps({'requirements': requirements}))
record = {}
snapshots = {(0, 'first.zip'): first_zip, (0, 'second.zip'): second_zip}
setup_result = setup.unpack_selected(project, library, inventory, scratch, record, snapshots)
rows = record['packages']
assert [row['dependencies'] for row in rows] == [
    [{'id': first_id, 'version': '1.0.0'}], [{'id': second_id, 'version': '2.0.0'}]], rows
assert setup_result == ['Packages/' + first_id, 'Packages/' + second_id], setup_result
unimported, conflicts = observe_project.vpm_import_closure(project, inventory, rows)
assert unimported == [] and conflicts == [], (unimported, conflicts)

# An unapproved source cannot be used as the second file's pin, even though the product has another approved
# source and the package identity itself is otherwise valid.
bad_lock = json.loads(json.dumps(lock)); bad_lock['vpmRequirements']['packages'][1]['repository'] = 'https://unapproved.invalid/index.json'
(project / '_harness' / 'environment' / 'environment-lock.json').write_text(json.dumps(bad_lock))
try:
    setup.unpack_selected(project, library, inventory, scratch, {}, snapshots)
    raise AssertionError('an unapproved source was assigned to a file')
except ValueError as error:
    assert 'VPM 依赖' in str(error), error
_, conflicts = observe_project.vpm_import_closure(project, inventory, rows)
assert conflicts and any('不是清点登记的仓库' in conflict for conflict in conflicts), conflicts

# All three missing-data routes are ordinary observations with the wanted product identity, never NameError.
(project / '_harness' / 'environment' / 'environment-lock.json').write_text(json.dumps(lock))
registration = project / '_harness' / 'intake' / 'vpm-requirements.json'
registration.unlink()
_, conflicts = observe_project.vpm_import_closure(project, inventory, rows)
assert conflicts and conflicts[0].startswith('Multi：缺少或无法读取'), conflicts
registration.write_text('{broken json')
_, conflicts = observe_project.vpm_import_closure(project, inventory, rows)
assert conflicts and conflicts[0].startswith('Multi：缺少或无法读取'), conflicts
registration.write_text(json.dumps({'requirements': requirements}))
(project / '_harness' / 'environment' / 'environment-lock.json').write_text(json.dumps({'vpmRequirements': {'requests': requirements}}))
_, conflicts = observe_project.vpm_import_closure(project, inventory, rows)
assert conflicts and conflicts[0].startswith('Multi：环境锁缺少项目 VPM 依赖 pin'), conflicts
print('multi-entry observation fixture ok')
`, tools, root], { env, encoding: 'utf8' });
  assert.match(output, /multi-entry observation fixture ok/);
});

test('same-source multi-file VPM evidence survives intake, prepare, setup and observe', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-vpm-same-source-'));
  t.after(() => removeTemp(root));
  const output = execFileSync('python3', ['-c', `import hashlib,json,os,subprocess,sys,zipfile
from pathlib import Path
tools, intake_path, root = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
sys.path.insert(0, str(tools))
import environment as e

repository = 'https://same.invalid/index.json'
library = root / 'library'; folder = library / 'Multi-1' / 'files'; folder.mkdir(parents=True)
def bundle(path, note):
    with zipfile.ZipFile(path, 'w') as archive:
        archive.writestr('install.url', '[InternetShortcut]\\r\\nURL=vcc://vpm/addRepo?url=' + repository + '\\r\\n')
        archive.writestr('readme.txt', note)
first, second = folder / 'First.zip', folder / 'Second.zip'
bundle(first, 'first outer bytes')
bundle(second, 'second outer bytes')
assert first.read_bytes() != second.read_bytes()
manifest = {'schema': 'manifest/0.1', 'request': 'Install the selected plugin bundles', 'assets': [
    {'item': '1', 'store': 'library', 'role': 'other', 'name': 'Multi'}]}
project = root / 'project'
env = dict(os.environ, AVH_MANIFEST=json.dumps(manifest), PYTHONDONTWRITEBYTECODE='1')
subprocess.run([sys.executable, str(intake_path), '--library', str(library), '--project', str(project)],
               env=env, check=True, capture_output=True)
inventory = json.loads((project / '_harness' / 'intake' / 'inventory.json').read_text())
selected = [file for file in inventory['items'][0]['files'] if file.get('selected')]
assert [file['name'] for file in selected] == ['First.zip', 'Second.zip'], selected
assert all(file['vpm'][0]['member'] == 'install.url' for file in selected), selected
requirements = json.loads((project / '_harness' / 'intake' / 'vpm-requirements.json').read_text())['requirements']
assert len(requirements) == 2, requirements
assert {row['entry'] for row in requirements} == {'First.zip', 'Second.zip'}, requirements
assert len({row['sourceSha256'] for row in requirements}) == 2, requirements

def archive(path, files):
    with zipfile.ZipFile(path, 'w') as archive:
        for name, value in files.items(): archive.writestr(name, value)
    return hashlib.sha256(path.read_bytes()).hexdigest()
template = root / 'template.zip'
template_hash = archive(template, {
    'avatar/ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.22f1\\n',
    'avatar/Packages/manifest.json': json.dumps({'dependencies': {}})})
base = root / 'base.zip'
base_hash = archive(base, {'package.json': json.dumps({'name': 'fixture.base', 'version': '1.0.0'})})
tool = root / 'tool.zip'
tool_hash = archive(tool, {'package.json': json.dumps({'name': 'fixture.vpm.tool', 'version': '1.0.0'})})
recipe = {'schema': 'environment-recipe/0.1', 'id': 'same-source-fixture', 'unity': '2022.3.22f1', 'platform': 'pc',
          'maxDownloadBytes': 1000000, 'maxExpandedBytes': 1000000,
          'template': {'url': 'https://same.invalid/template.zip', 'sha256': template_hash},
          'packages': [{'id': 'fixture.base', 'version': '1.0.0', 'url': 'https://same.invalid/base.zip', 'sha256': base_hash}]}
(root / 'recipe.json').write_text(json.dumps(recipe))
(project / '_harness' / 'environment' / 'cache').mkdir(parents=True)
for path, digest in ((template, template_hash), (base, base_hash), (tool, tool_hash)):
    (project / '_harness' / 'environment' / 'cache' / (digest + '.zip')).write_bytes(path.read_bytes())
listing = {'packages': {'fixture.vpm.tool': {'versions': {
    '1.0.0': {'name': 'fixture.vpm.tool', 'version': '1.0.0', 'url': 'https://same.invalid/tool.zip',
              'zipSHA256': tool_hash, 'vpmDependencies': {}}}}}}
e.repository_listing = lambda url, limit: listing
lock = e.prepare(project, root / 'recipe.json')
assert len(lock['vpmRequirements']['requests']) == 2, lock['vpmRequirements']
assert len(lock['vpmRequirements']['packages']) == 1, lock['vpmRequirements']
assert {row['entry'] for row in lock['vpmRequirements']['requests']} == {'First.zip', 'Second.zip'}

setup_path = tools / 'setup.py'
subprocess.run([sys.executable, str(setup_path), '--template', str(project / '_harness' / 'environment' / 'baseline'),
                '--library', str(library), '--project', str(project)], check=True, capture_output=True)
(project / 'Packages' / 'packages-lock.json').write_text(json.dumps({'dependencies': {}}))
out = root / 'observation.json'
subprocess.run([sys.executable, str(tools / 'observe_project.py'), '--project', str(project),
                '--environment-tool', str(tools / 'environment.py'), '--environment-recipe', str(root / 'recipe.json'),
                '--out', str(out)], check=True, capture_output=True)
metrics = json.loads(out.read_text())['metrics']
assert metrics['vpm_import_records_consistent'] is True, metrics
assert metrics['unresolved_unpack_conflicts'] == 0, metrics
assert metrics['remaining_unopened_archives'] == 0, metrics
print('same-source multi-file VPM fixture ok')
`, tools, intake, root], { env, encoding: 'utf8' });
  assert.match(output, /same-source multi-file VPM fixture ok/);
});
