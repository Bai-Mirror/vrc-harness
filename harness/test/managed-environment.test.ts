import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { loadProcess } from '../src/process/load.ts';
import { loadCapabilities, manifestVariableReferences } from '../src/workflow/capabilities.ts';
import { removeTemp } from './fixtures/platform.ts';

const tool = fileURLToPath(new URL('../builtin/tools/harness/environment.py', import.meta.url));
const base = fileURLToPath(new URL('../builtin/knowledge/process/', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };

test('the bundled production path owns environment preparation and no longer requires a template variable', () => {
  const process = loadProcess(readFileSync(join(base, 'pc-recolor-outfit.process.yaml'), 'utf8'),
    parse(readFileSync(join(base, 'thresholds.yaml'), 'utf8')));
  const capabilities = loadCapabilities(readFileSync(join(base, 'pc-recolor-outfit.capabilities.yaml'), 'utf8'), process);
  assert.ok(!manifestVariableReferences(capabilities).includes('templateProject'));
  assert.ok(!manifestVariableReferences(capabilities).includes('templateSource'));
  assert.deepEqual(process.stages.find(s => s.id === 'setup')!.needs, ['environment']);
  const stage = process.stages.find(s => s.id === 'environment')!;
  assert.equal(capabilities.stages.environment!.mode, 'tool');
  assert.equal(capabilities.stages.environment!.network, true);
  assert.deepEqual(stage.requires, ['environment_lock_consistent']);
  assert.equal(capabilities.observers['environment.verify']!.kind, 'command');
  const raw = parse(readFileSync(join(base, 'pc-recolor-outfit.capabilities.yaml'), 'utf8'));
  raw.stages.plan.network = true;
  assert.throws(() => loadCapabilities(JSON.stringify(raw), process), /只有受管 tool/);
});

test('no-template preparation, process restart, partial publication and independent drift detection', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-environment-'));
  t.after(() => removeTemp(root));
  // Seed synthetic, hash-pinned ZIPs into the exact cache used by the CLI. Network cannot be used by this fixture.
  execFileSync('python3', ['-c', `import sys,json,zipfile,hashlib,tarfile,io
from pathlib import Path
root=Path(sys.argv[1]); project=root/'project'; cache=project/'_harness/environment/cache'; cache.mkdir(parents=True)
def archive(name,files):
    p=root/(name+'.zip')
    with zipfile.ZipFile(p,'w') as z:
        for n,v in files.items(): z.writestr(n,v)
    h=hashlib.sha256(p.read_bytes()).hexdigest(); (cache/(h+'.zip')).write_bytes(p.read_bytes())
    return {'url':'https://invalid.example/'+name,'sha256':h}
template=archive('template',{'avatar/ProjectSettings/ProjectVersion.txt':'m_EditorVersion: 2022.3.22f1\\n',
    'avatar/Packages/manifest.json':json.dumps({'dependencies':{}})})
package=archive('package',{'package.json':json.dumps({'name':'test.avatar','version':'1.0.0','dependencies':{'test.registry':'1.1.0'}}),'Editor/tool.cs':'// original'})
package.update(id='test.avatar',version='1.0.0')
tgz=root/'registry.tgz'
with tarfile.open(tgz,'w:gz') as archive:
    data=json.dumps({'name':'test.registry','version':'1.2.0','dependencies':{'test.builtin':'1.0.0'}}).encode()
    member=tarfile.TarInfo('package/package.json'); member.size=len(data); archive.addfile(member,io.BytesIO(data))
h=hashlib.sha256(tgz.read_bytes()).hexdigest(); (cache/(h+'.zip')).write_bytes(tgz.read_bytes())
registry={'id':'test.registry','version':'1.2.0','sha256':h,'url':'https://invalid.example/registry','format':'tgz'}
recipe={'schema':'environment-recipe/0.1','id':'fixture-v1','unity':'2022.3.22f1','platform':'pc',
    'maxDownloadBytes':1000000,'maxExpandedBytes':1000000,'template':template,'packages':[package],
    'registryPackages':[registry],'builtinPackages':{'test.builtin':'1.0.0'}}
(root/'recipe.json').write_text(json.dumps(recipe))
`, root], { env });
  const project = join(root, 'project'), recipe = join(root, 'recipe.json');
  const call = (action: string, extra: string[] = []) => execFileSync('python3', [tool, action, '--project', project, '--recipe', recipe, ...extra], { env, encoding: 'utf8' });
  call('prepare');
  const lock = join(project, '_harness/environment/environment-lock.json');
  const initial = readFileSync(lock, 'utf8');
  assert.deepEqual(JSON.parse(initial).packages, { 'test.avatar': '1.0.0', 'test.registry': '1.2.0' });
  assert.equal(JSON.parse(initial).source, 'managed');
  call('prepare');
  assert.equal(readFileSync(lock, 'utf8'), initial, 'a restart reuses the identical accepted baseline');
  rmSync(lock); // crash after baseline publication but before the external receipt
  call('prepare');
  assert.equal(readFileSync(lock, 'utf8'), initial, 'publication is recognized, not replayed');
  const output = join(root, 'observation.json');
  call('verify', ['--out', output]);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).metrics.environment_consistent, true);
  const source = join(project, '_harness/environment/baseline/Packages/test.avatar/Editor/tool.cs');
  writeFileSync(source, '// changed after preparation');
  call('verify', ['--out', output]);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).metrics.environment_consistent, false);
  assert.throws(() => call('prepare'), /环境内容已漂移/);
  assert.equal(readFileSync(source, 'utf8'), '// changed after preparation', 'drift never triggers destructive reset');
  assert.equal(readFileSync(lock, 'utf8'), initial);
});

test('UPM closure rejects missing or insufficient transitive dependencies before publishing, and setup preserves embedded packages', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-upm-closure-'));
  t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import sys,json
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent)); import environment as e; import setup
root=Path(sys.argv[2]); baseline=root/'baseline'; settings=baseline/'ProjectSettings'; settings.mkdir(parents=True)
(settings/'ProjectVersion.txt').write_text('m_EditorVersion: 2022.3.22f1\\n')
packages=baseline/'Packages'; packages.mkdir()
e.write(packages/'manifest.json',{'dependencies':{'test.registry':'1.2.0'}})
e.write(packages/'vpm-manifest.json',{'locked':{}})
recipe={'unity':'2022.3.22f1','packages':[]}
for version in [None,'1.1.0']:
    if version:e.write(packages/'test.registry/package.json',{'name':'test.registry','version':version})
    try:e.inspect_baseline(baseline,recipe,True);raise AssertionError('unfrozen or insufficient dependency accepted')
    except ValueError:pass
e.write(packages/'test.registry/package.json',{'name':'test.registry','version':'1.2.0'})
assert e.inspect_baseline(baseline,recipe,True)=={'test.registry':'1.2.0'}
project=root/'project';project.mkdir();receipt={}
setup.baseline(baseline,project,receipt)
assert e.read(project/'Packages/test.registry/package.json')['version']=='1.2.0'
assert receipt['embedded_packages']=={'test.registry':'1.2.0'}
`, tool, root], { env });
});

// The three documented first-compile failures are deterministic, so preparation has to remove them
// rather than leave them for a person. Each assertion below fails if its remedy is dropped.
test('preparation removes the three known first-compile failures from the baseline', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-environment-remedies-'));
  t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent)); import environment as e
root=Path(sys.argv[2])
settings=root/'ProjectSettings'; settings.mkdir(parents=True)
# The official template ships the key empty, as an empty mapping. The remedy has to handle that shape:
# looking only for platform entries beneath the key finds nothing and leaves the define absent.
(settings/'ProjectSettings.asset').write_text(
    'PlayerSettings:\\n'
    '  scriptingDefineSymbols: {}\\n'
    '  otherSetting: 3\\n', encoding='utf-8')
editor=root/'Packages'/'jp.lilxyzw.liltoon'/'Editor'; editor.mkdir(parents=True)
e.write(editor/'lilToon.Editor.asmdef', {'name':'lilToon.Editor','autoReferenced':False})
before=(settings/'ProjectSettings.asset').read_text(encoding='utf-8')
assert 'VRC_SDK_VRCSDK3' not in before, 'fixture must start without the define'
assert e.read(editor/'lilToon.Editor.asmdef')['autoReferenced'] is False, 'fixture must start unreferenced'
e.apply_first_compile_remedies(root, {})
text=(settings/'ProjectSettings.asset').read_text(encoding='utf-8')
defines={}
for line in text.splitlines():
    name,_,value=line.strip().partition(':')
    if name in ('Standalone','Android','iPhone'): defines[name]=[v.strip() for v in value.split(';')]
assert set(defines)=={'Standalone','Android','iPhone'}, text
for platform,values in defines.items():
    assert 'VRC_SDK_VRCSDK3' in values, (platform, values)
assert 'VRC_SDK_VRCSDK3' not in [l for l in text.splitlines() if l.strip().startswith('otherSetting:')][0], 'the write must not run past its own entries'
assert e.read(editor/'lilToon.Editor.asmdef')['autoReferenced'] is True
# Idempotent: preparing over an already-repaired tree must not double the define.
e.apply_first_compile_remedies(root, {})
again=(settings/'ProjectSettings.asset').read_text(encoding='utf-8')
assert again.count('VRC_SDK_VRCSDK3')==text.count('VRC_SDK_VRCSDK3'), (again, text)
print('remedies ok')
`, tool, root], { env });
});

// SRP core is what the first failure is about, and it ships inside the editor rather than the public
// registry, so the recipe must declare it and the declared version must be one the editor actually has.
test('the frozen recipe declares the editor built-ins the first compile needs', () => {
  const recipe = JSON.parse(readFileSync(join(base, '..', '..', 'tools', 'harness', 'environment-recipe.json'), 'utf8')) as {
    unity?: string; unityDependencies?: Record<string, string>; builtinPackages?: Record<string, string>;
    registryPackages?: { id: string }[];
  };
  // SRP core carries CommandBufferPool, which avatar tools call while the VCC template uses the built-in
  // pipeline and does not reference it. It has to appear twice for two different reasons: builtinPackages
  // is what preparation checks availability against, and unityDependencies is what writes the manifest
  // entry Unity resolves. Only the second fails preparation on the availability of the name it adds; only
  // the first leaves the manifest without it.
  assert.equal(recipe.builtinPackages?.['com.unity.render-pipelines.core'], '14.0.10',
    'the editor supplies SRP core, so availability has to be recorded against builtins');
  assert.equal(recipe.unityDependencies?.['com.unity.render-pipelines.core'], '14.0.10',
    'the manifest needs the dependency for CommandBufferPool to resolve');
  assert.ok(!recipe.registryPackages?.some(item => item.id === 'com.unity.render-pipelines.core'),
    'SRP core above 10.x is not downloadable from the public registry');
  assert.equal(recipe.unity, '2022.3.22f1');
  // Applying the remedies is only worth anything if preparation actually calls them: the function
  // passing on its own says nothing about whether a prepared baseline ever sees it.
  const source = readFileSync(tool, 'utf8');
  // Anchor to the statement, not the definition: the definition line also reads
  // "def apply_first_compile_remedies(target, recipe):", so a looser match passes even with the call
  // deleted, which is exactly how this assertion first failed to catch anything.
  assert.match(source, /^\s+apply_first_compile_remedies\(target, recipe\)\s*$/m,
    'prepare has to apply the first-compile remedies it defines');
  assert.match(source, /if metadata\.get\('autoReferenced'\) is False/,
    'lilToon ships its editor assembly unreferenced, so the remedy must flip it');
});

test('bad download digests and archive traversal never publish a baseline or write outside the candidate', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-environment-bad-'));
  t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import sys,zipfile,hashlib,tarfile,io
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent)); import environment as e
root=Path(sys.argv[2]); cache=root/'cache'; cache.mkdir()
h='a'*64; (cache/(h+'.zip')).write_bytes(b'corrupt')
try: e.download({'sha256':h,'url':'https://invalid.example'},cache,1000); raise AssertionError('bad cache accepted')
except ValueError: pass
archive=root/'evil.zip'
with zipfile.ZipFile(archive,'w') as z: z.writestr('../escaped','bad')
try: e.extract(archive,root/'candidate',1000); raise AssertionError('traversal accepted')
except ValueError: pass
assert not (root/'candidate').exists()
with zipfile.ZipFile(archive,'w') as z: z.writestr('huge',b'x'*1001)
try: e.extract(archive,root/'candidate',1000); raise AssertionError('budget ignored')
except ValueError: pass
for name,kind in [('../escape',tarfile.REGTYPE),('package/link',tarfile.SYMTYPE),('package/hardlink',tarfile.LNKTYPE)]:
    archive=root/'evil.tgz'
    with tarfile.open(archive,'w:gz') as tar:
        entry=tarfile.TarInfo(name);entry.type=kind;entry.linkname='../outside';tar.addfile(entry)
    try:e.extract(archive,root/'tar-candidate',1000,'tgz');raise AssertionError('unsafe tar accepted')
    except ValueError:pass
    assert not (root/'tar-candidate').exists()
`, tool, root], { env });
  assert.equal(existsSync(join(root, 'escaped')), false);
});
