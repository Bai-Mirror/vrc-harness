import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runtimeModule } from '../../src/module-path.ts';
import { harnessVersion } from '../../src/provenance.ts';
import { loadProcess } from '../../src/process/load.ts';
import { loadCapabilities } from '../../src/workflow/capabilities.ts';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error plain JavaScript build helper without type declarations
import { leftoverTsSpecifiers, rewriteTsSpecifiers, shippedPackFiles } from '../../scripts/build-lib.mjs';
import { removeTemp, windows } from '../fixtures/platform.ts';
import { windowsToolPath } from '../../src/host-platform.ts';

const tools = fileURLToPath(new URL('../../builtin/tools/harness/', import.meta.url));
/** The pack's Python tools as the Runtime runs them: UTF-8 text on every platform, and 7-Zip on PATH. */
const toolEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ...process.env, PYTHONUTF8: '1', ...(windows ? { PATH: windowsToolPath(process.env.PATH) } : {}), ...extra });

test('packaging refuses to replace delivery evidence when the AI diagnosis is missing', t => {
  const project = mkdtempSync(join(tmpdir(), 'avh-package-diagnosis-'));
  const library = join(project, 'library');
  mkdirSync(library);
  t.after(() => removeTemp(project));
  const result = spawnSync('python3', [join(tools, 'package.py'), '--project', project, '--library', library],
    { encoding: 'utf8', env: toolEnv() });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /缺少 _harness\/delivery\/diagnosis\.json/);
});

test('packaging refuses a diagnosis that pre-passes client-only checks', t => {
  const project = mkdtempSync(join(tmpdir(), 'avh-package-client-claims-'));
  const library = join(project, 'library'), delivery = join(project, '_harness', 'delivery');
  mkdirSync(library); mkdirSync(delivery, { recursive: true });
  t.after(() => removeTemp(project));
  const client_checks = ['upload', 'network_sync', 'saved_reload', 'vr_gestures', 'platform_rendering'].map(id =>
    ({ id, title: id, status: id === 'upload' ? 'passed' : 'pending', steps: ['执行'], expected: '正常' }));
  writeFileSync(join(delivery, 'diagnosis.json'), JSON.stringify({ schema: 'delivery-diagnosis/0.1', verdict: 'ready',
    blockers: [], verified: [], client_checks }));
  const result = spawnSync('python3', [join(tools, 'package.py'), '--project', project, '--library', library],
    { encoding: 'utf8', env: toolEnv() });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /客户端检查 upload 必须保持 pending/);
});

test('packaging stops before mutation when structured diagnosis still has blockers', t => {
  const project = mkdtempSync(join(tmpdir(), 'avh-package-blocked-'));
  const library = join(project, 'library'), delivery = join(project, '_harness', 'delivery');
  mkdirSync(library); mkdirSync(delivery, { recursive: true });
  t.after(() => removeTemp(project));
  writeFileSync(join(delivery, 'diagnosis.json'), JSON.stringify({ schema: 'delivery-diagnosis/0.1', verdict: 'blocked',
    blockers: [{ id: 'compile', reason: '冷编译证据缺失' }], verified: [], client_checks: [] }));
  const result = spawnSync('python3', [join(tools, 'package.py'), '--project', project, '--library', library],
    { encoding: 'utf8', env: toolEnv() });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不打包：冷编译证据缺失/);
});

test('delivery observer exposes a blocking metric for the embedded client diagnosis', t => {
  const project = mkdtempSync(join(tmpdir(), 'avh-observe-diagnosis-'));
  const delivery = join(project, '_harness', 'delivery');
  const out = join(project, 'observation.json');
  mkdirSync(delivery, { recursive: true });
  t.after(() => removeTemp(project));
  const makeArchive = [
    'import io,sys,zipfile',
    'target=sys.argv[1]',
    'inner=io.BytesIO()',
    "z=zipfile.ZipFile(inner,'w'); z.writestr('Packages/manifest.json','{\"dependencies\":{}}'); z.close()",
    "z=zipfile.ZipFile(target,'w'); z.writestr('sample_工程.zip',inner.getvalue()); z.writestr('交付说明.txt','ok\\n'); z.writestr('_追加素材（非客户自备）/来源说明.txt',''); z.writestr('客户端验收与诊断.md','已验证：编辑器回归\\n待客户端：上传与 VR 手势\\n'); z.close()",
  ].join(';');
  assert.equal(spawnSync('python3', ['-c', makeArchive, join(delivery, 'sample_交付.zip')], { env: toolEnv() }).status, 0);
  const observed = spawnSync('python3', [join(tools, 'observe_package.py'), '--out', out],
    { encoding: 'utf8', env: toolEnv({ AVH_PROJECT_DIR: project }) });
  assert.equal(observed.status, 0, observed.stderr);
  const report = JSON.parse(readFileSync(out, 'utf8')) as { metrics: Record<string, unknown> };
  assert.equal(report.metrics.delivery_diagnosis_present, true);
});

/** A synthetic SOP 90 total package whose project zip holds exactly these members. */
function writeSyntheticTotal(project: string, members: string[]): void {
  const script = [
    'import io,json,sys,zipfile',
    'from pathlib import Path',
    'project,members=Path(sys.argv[1]),json.loads(sys.argv[2])',
    'delivery=project/"_harness"/"delivery";delivery.mkdir(parents=True,exist_ok=True)',
    'inner=io.BytesIO()',
    'z=zipfile.ZipFile(inner,"w")',
    'for name in members:z.writestr(name,"synthetic")',
    'z.close()',
    'with zipfile.ZipFile(delivery/"Synthetic_交付.zip","w") as z:',
    '    z.writestr("Synthetic_工程.zip",inner.getvalue())',
    '    z.writestr("交付说明.txt","synthetic\\n")',
    '    z.writestr("_追加素材（非客户自备）/来源说明.txt","")',
    '    z.writestr("客户端验收与诊断.md","Pending actual client checks\\n")',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script, project, JSON.stringify(members)], { encoding: 'utf8', env: toolEnv() });
  assert.equal(result.status, 0, result.stderr);
}

test('the package observer asks for the plugin directories the source project had, and notices a lost one', t => {
  const project = mkdtempSync(join(tmpdir(), 'avh-observe-plugin-dirs-'));
  mkdirSync(join(project, 'library'));
  t.after(() => removeTemp(project));
  const observer = join(tools, 'observe_package.py'), out = join(project, 'observation.json');
  const plugin = join(project, 'Packages', 'vendor.package');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'package.json'), '{"name":"vendor.package"}\n');
  const observe = (script = observer) => {
    const result = spawnSync('python3', [script, '--out', out], { encoding: 'utf8', env: toolEnv({ AVH_PROJECT_DIR: project }) });
    assert.equal(result.status, 0, result.stderr);
    return (JSON.parse(readFileSync(out, 'utf8')) as { metrics: Record<string, number> }).metrics;
  };
  writeSyntheticTotal(project, ['Packages/vendor.package/package.json', 'Assets/item.txt']);
  assert.equal(observe().plugin_internal_dirs_in_source, 0);
  assert.equal(observe().missing_plugin_internal_dirs_in_zip, 0, 'a plugin that ships no internal directory asks for none');
  mkdirSync(join(plugin, 'Library'));
  writeFileSync(join(plugin, 'Library', 'cache.bin'), 'cache');
  assert.equal(observe().plugin_internal_dirs_in_source, 1);
  writeSyntheticTotal(project, ['Packages/vendor.package/package.json', 'Packages/vendor.package/Library/cache.bin']);
  assert.equal(observe().missing_plugin_internal_dirs_in_zip, 0, 'the source directory is in the zip at the same path');
  writeSyntheticTotal(project, ['Packages/vendor.package/package.json']);
  assert.equal(observe().missing_plugin_internal_dirs_in_zip, 1, 'dropping a source plugin directory fails');
  writeSyntheticTotal(project, ['Packages/vendor.package/package.json', 'Packages/other.package/Library/cache.bin']);
  assert.equal(observe().missing_plugin_internal_dirs_in_zip, 1, 'a same-named directory elsewhere cannot stand in for the source path');
  rmSync(join(plugin, 'Library', 'cache.bin'));
  assert.equal(observe().missing_plugin_internal_dirs_in_zip, 0, 'an empty directory carries no data a zip could lose');
  const mutant = join(project, 'mutant_package.py');
  writeFileSync(mutant, readFileSync(observer, 'utf8').replace('missing_dirs = missing_plugin_dirs(source_dirs, inner_names)', 'missing_dirs = []'));
  assert.equal(observe(mutant).missing_plugin_internal_dirs_in_zip, 0, 'mutation: the old reading never counts a lost directory');
});

test('packaging preserves retained dependencies, omits source-excluded inputs, and blocks residual data', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-package-excluded-'));
  t.after(() => removeTemp(root));
  const project = join(root, 'Avatar'), library = join(root, 'library');
  for (const path of ['Assets/_Harness/Optimize', 'Assets/Kept', 'Packages/com.kept', 'Packages/com.base',
    '_harness/delivery', '_harness/intake', '_harness/setup'])
    mkdirSync(join(project, path), { recursive: true });
  for (const path of ['Some-excluded-item/files', 'Some-kept-item/files'])
    mkdirSync(join(library, path), { recursive: true });
  writeFileSync(join(project, 'Assets/Kept/thing.prefab'), 'kept data');
  writeFileSync(join(project, 'Packages/com.kept/package.json'), '{"name":"com.kept","dependencies":{"com.base":"1.0.0"}}\n');
  writeFileSync(join(project, 'Packages/com.base/package.json'), '{"name":"com.base"}\n');
  writeFileSync(join(project, 'Packages/manifest.json'), JSON.stringify({ dependencies: { 'com.kept': '1.0.0', 'com.base': '1.0.0' } }));
  writeFileSync(join(project, 'Packages/vpm-manifest.json'), JSON.stringify({
    dependencies: { 'com.kept': { version: '1.0.0' }, 'com.base': { version: '1.0.0' } },
    locked: { 'com.kept': { version: '1.0.0' }, 'com.base': { version: '1.0.0' } } }));
  writeFileSync(join(project, 'Assets/_Harness/Optimize/texture_plan.json'), JSON.stringify({ textures: [] }));
  writeFileSync(join(project, 'Assets/_Harness/Optimize/Avatar.prefab'), '%YAML 1.1\n');
  writeFileSync(join(project, '_harness/intake/inventory.json'), JSON.stringify({ items: [
    { item: 'excluded-item', name: 'Excluded Part', store: 'library', role: 'other', found: true, files: [{ name: 'excluded.zip', selected: true, sha256: 'x' }] },
    { item: 'kept-item', name: 'Kept Part', store: 'library', role: 'outfit', found: true, files: [{ name: 'kept.zip', selected: true, sha256: 'y' }] },
    { item: join(library, 'Some-excluded-item/files/excluded.zip'), name: 'Excluded dependency source', store: 'local', role: 'other', found: true,
      files: [{ name: 'excluded.zip', selected: true, sha256: 'x' }] }] }));
  writeFileSync(join(project, '_harness/setup/import.json'), JSON.stringify({ packages: [
    { item: 'kept-item', zip: 'kept.zip', roots: ['Assets/Kept'] }] }));
  writeFileSync(join(library, 'Some-excluded-item/files/excluded.zip'), 'excluded package');
  writeFileSync(join(library, 'Some-kept-item/files/kept.zip'), 'kept package');
  // `package` clears its own output directory, so the diagnosis the package stage consumes is written per run.
  const writeDiagnosis = () => writeFileSync(join(project, '_harness/delivery/diagnosis.json'), JSON.stringify({
    schema: 'delivery-diagnosis/0.1', verdict: 'ready', blockers: [], verified: [],
    client_checks: ['upload', 'network_sync', 'saved_reload', 'vr_gestures', 'platform_rendering']
      .map(id => ({ id, title: id, status: 'pending', steps: ['执行'], expected: '正常' })) }));
  const plan = {
    unused: [{ item: 'excluded-item', reason: 'client_declined', note: '客户用厂商工具自行安装' },
      { item: join(library, 'Some-excluded-item/files/excluded.zip'), reason: 'client_declined', note: '客户自行安装' }],
    obligations: [{ input: 'excluded-item', role: 'other', action: 'exclude', reason: '客户自行安装' },
      { input: join(library, 'Some-excluded-item/files/excluded.zip'), role: 'other', action: 'exclude', reason: '客户自行安装' }],
    outfits: [{ item: 'kept-item', id: 'kept', prefab: 'Assets/Kept/thing.prefab', assembly: 'merge' }],
  };
  const run = (script = join(tools, 'package.py')) => {
    writeDiagnosis();
    return spawnSync('python3', [script, '--project', project, '--library', library], { encoding: 'utf8',
      env: toolEnv({ AVH_MANIFEST: JSON.stringify({ schema: 'manifest/0.1', request: 'fit one accessory' }),
        AVH_PLAN: JSON.stringify(plan), AVH_TOOL_ROOT: join(tools, '..'), PYTHONPATH: tools }) });
  };
  const inspect = () => {
    const script = [
      'import io,json,sys,zipfile',
      'from pathlib import Path',
      'project=Path(sys.argv[1])',
      'total=next((project/"_harness"/"delivery").iterdir())',
      'with zipfile.ZipFile(total) as z:',
      '    names=z.namelist()',
      '    note=z.read("交付说明.txt").decode("utf-8")',
      '    project_zip=next(n for n in names if n.endswith("_工程.zip"))',
      '    inner=zipfile.ZipFile(io.BytesIO(z.read(project_zip)))',
      '    inner_names=inner.namelist()',
      '    manifest=json.loads(inner.read("Packages/manifest.json"))',
      '    material_zip=next(n for n in names if n.endswith("_素材.zip"))',
      '    material=zipfile.ZipFile(io.BytesIO(z.read(material_zip)))',
      '    material_names=material.namelist()',
      '    sources=material.read("_追加素材（非客户自备）/来源说明.txt").decode("utf-8")',
      'print(json.dumps({"inner":inner_names,"material":material_names,"note":note,"manifest":manifest,"sources":sources},ensure_ascii=False))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', script, project], { encoding: 'utf8', env: toolEnv() });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as { inner: string[]; material: string[]; note: string;
      manifest: { dependencies: Record<string, unknown> }; sources: string };
  };
  const fixed = run();
  assert.equal(fixed.status, 0, fixed.stderr + fixed.stdout);
  const delivered = inspect();
  assert.ok(delivered.inner.includes('Assets/Kept/thing.prefab'), 'the kept product still ships');
  assert.ok(delivered.inner.includes('Packages/com.kept/package.json'));
  assert.ok(delivered.inner.includes('Packages/com.base/package.json'), 'a retained package dependency remains in the delivery');
  assert.deepEqual(Object.keys(delivered.manifest.dependencies).sort(), ['com.base', 'com.kept'],
    'packaging does not rewrite retained package dependencies');
  assert.ok(delivered.material.includes('_追加素材（非客户自备）/kept.zip'));
  assert.ok(!delivered.material.some(name => name.endsWith('excluded.zip')), 'the excluded source package is not in the material zip');
  assert.ok(!delivered.sources.includes('excluded-item'), 'the source note does not list the excluded product');
  assert.match(delivered.note, /## 客户自行安装/);
  assert.ok(delivered.note.includes('excluded-item') && delivered.note.includes('客户用厂商工具自行安装'),
    'the delivery note names the excluded product and carries its installation disposition');
  // A dependency recovered before its source was excluded remains a delivery blocker, including the Unity sidecar.
  mkdirSync(join(project, 'Assets/_Harness/Recolor/Dependencies'), { recursive: true });
  writeFileSync(join(project, 'Assets/_Harness/Recolor/Dependencies/old.mat'), 'stale dependency');
  writeFileSync(join(project, 'Assets/_Harness/Recolor/Dependencies/old.mat.meta'), 'fileFormatVersion: 2\n');
  writeFileSync(join(project, 'Assets/_Harness/Recolor/dependency-receipt.json'), JSON.stringify({
    schema: 'material-dependency-receipt/0.1', request_sha256: 'r', packages: [{
      anchor: join(library, 'Some-excluded-item/files/excluded.zip'),
      archive: join(library, 'Some-excluded-item/files/excluded.zip'), sha256: 'x',
      assets: [{ path: 'Assets/_Harness/Recolor/Dependencies/old.mat', sha256: 'a', meta_sha256: 'b' }],
    }],
  }));
  const dependencyBlocked = run();
  assert.notEqual(dependencyBlocked.status, 0, 'excluded dependency output must block delivery');
  assert.match(dependencyBlocked.stderr, /排除的依赖来源仍有派生数据/);
  rmSync(join(project, 'Assets/_Harness/Recolor/Dependencies/old.mat'));
  rmSync(join(project, 'Assets/_Harness/Recolor/Dependencies/old.mat.meta'));
  const dependencyClean = run();
  assert.equal(dependencyClean.status, 0, dependencyClean.stderr + dependencyClean.stdout);
  // Mutation: if the delivery receipt check is removed, the stale dependency is copied into the package.
  writeFileSync(join(project, 'Assets/_Harness/Recolor/Dependencies/old.mat'), 'stale dependency');
  writeFileSync(join(project, 'Assets/_Harness/Recolor/Dependencies/old.mat.meta'), 'fileFormatVersion: 2\n');
  const dependencyMutant = join(root, 'mutant_dependency_package.py');
  writeFileSync(dependencyMutant, readFileSync(join(tools, 'package.py'), 'utf8')
    .replace('assert_dependency_receipt_absent(project, copy)', 'pass  # mutation'));
  const dependencyBroken = run(dependencyMutant);
  assert.equal(dependencyBroken.status, 0, dependencyBroken.stderr + dependencyBroken.stdout);
  const brokenDelivery = inspect();
  assert.ok(brokenDelivery.inner.some(name => name.endsWith('old.mat')), 'mutation: stale dependency output ships');
  // A stale setup receipt that says an excluded product was imported is a technical defect, not a reason to edit
  // the delivery copy. The real package path blocks it; removing that check is the mutation and must be observable.
  mkdirSync(join(project, 'Assets/Excluded'), { recursive: true });
  writeFileSync(join(project, 'Assets/Excluded/part.prefab'), 'excluded data');
  writeFileSync(join(project, '_harness/setup/import.json'), JSON.stringify({ packages: [
    { item: 'excluded-item', zip: 'excluded.zip', roots: [], paths: ['Assets/Excluded/part.prefab'] },
    { item: 'kept-item', zip: 'kept.zip', roots: ['Assets/Kept'] }] }));
  const rejected = run();
  assert.notEqual(rejected.status, 0, 'residual excluded data must block packaging');
  assert.match(rejected.stderr, /一致排除商品的数据仍在交付工程中/);
  const mutant = join(root, 'mutant_package.py');
  writeFileSync(mutant, readFileSync(join(tools, 'package.py'), 'utf8')
    .replace('assert_excluded_data_absent(project, copy, import_record, excluded)', 'pass  # mutation'));
  const broken = run(mutant);
  assert.equal(broken.status, 0, broken.stderr + broken.stdout);
  const mutantDelivery = inspect();
  assert.ok(mutantDelivery.inner.some(name => name.startsWith('Assets/Excluded/')),
    'mutation: without the pre-delivery check residual excluded data ships');
});

/**
 * The smallest project that reaches the delivery and cold-copy steps. `item` chooses how the Manifest names the
 * product: a library folder (`<名>-<商品号>/files/`, what a BOOTH purchase looks like) or one absolute file path
 * (what a project made in Harness registers). Those are the two shapes `intake.item_files` resolves, and the
 * delivery has to read the Manifest the same way the intake and setup already do.
 */
function coldFixture(t: TestContext, item: 'folder' | 'file') {
  const root = mkdtempSync(join(tmpdir(), 'avh-package-cold-'));
  t.after(() => removeTemp(root));
  const project = join(root, 'Avatar'), library = join(root, 'library');
  for (const path of ['Assets/_Harness/Optimize', '_harness/delivery', '_harness/intake', '_harness/setup'])
    mkdirSync(join(project, path), { recursive: true });
  writeFileSync(join(project, 'Assets/_Harness/Optimize/texture_plan.json'), JSON.stringify({ textures: [] }));
  writeFileSync(join(project, 'Assets/_Harness/Optimize/Avatar.prefab'), '%YAML 1.1\n');
  const packaged = item === 'folder' ? 'kept.zip' : 'registered.unitypackage';
  const source = item === 'folder' ? join(library, 'Some-kept-item', 'files', packaged) : join(library, packaged);
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, 'vendor package bytes');
  writeFileSync(join(project, '_harness/intake/inventory.json'), JSON.stringify({ items: [{
    item: item === 'folder' ? 'kept-item' : source, name: 'Kept Product', store: 'library', role: 'outfit', found: true,
    folder: item === 'folder' ? 'Some-kept-item' : null, files: [{ name: packaged, selected: true, sha256: 'y' }] }] }));
  writeFileSync(join(project, '_harness/setup/import.json'), JSON.stringify({ packages: [] }));
  // `package` clears its own output directory, so the diagnosis the stage consumes is written per run.
  const writeDiagnosis = () => writeFileSync(join(project, '_harness/delivery/diagnosis.json'), JSON.stringify({
    schema: 'delivery-diagnosis/0.1', verdict: 'ready', blockers: [], verified: [],
    client_checks: ['upload', 'network_sync', 'saved_reload', 'vr_gestures', 'platform_rendering']
      .map(id => ({ id, title: id, status: 'pending', steps: ['执行'], expected: '正常' })) }));
  const plan = { unused: [], obligations: [], outfits: [] };
  const run = (script = join(tools, 'package.py')) => {
    writeDiagnosis();
    return spawnSync('python3', [script, '--project', project, '--library', library], { encoding: 'utf8',
      env: toolEnv({ AVH_MANIFEST: JSON.stringify({ schema: 'manifest/0.1', request: 'fit one accessory' }),
        AVH_PLAN: JSON.stringify(plan), AVH_TOOL_ROOT: join(tools, '..'), PYTHONPATH: tools }) });
  };
  /** Read the shipped archive directly: the members of the project zip, the added material and the source note. */
  const inspect = () => {
    const script = [
      'import io,json,sys,zipfile',
      'from pathlib import Path',
      'project=Path(sys.argv[1])',
      'total=next((project/"_harness"/"delivery").iterdir())',
      'generators=("Assets/_HarnessTools/","Assets/Editor/AvatarGen/","Assets/_HarnessColdProbe/")',
      'with zipfile.ZipFile(total) as z:',
      '    names=z.namelist()',
      '    project_zip=next(n for n in names if n.endswith("_工程.zip"))',
      '    inner=zipfile.ZipFile(io.BytesIO(z.read(project_zip))).namelist()',
      '    material_zip=next(n for n in names if n.endswith("_素材.zip"))',
      '    material=zipfile.ZipFile(io.BytesIO(z.read(material_zip))).namelist()',
      'print(json.dumps({"inner":inner,"material":material,"generator":any(n.startswith(generators) for n in inner)},ensure_ascii=False))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', script, project], { encoding: 'utf8', env: toolEnv() });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as { inner: string[]; material: string[]; generator: boolean };
  };
  return { root, project, run, inspect };
}

/** Every `.cs` under a directory, so the probe's injected tree can be read as one body of source. */
function csFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...csFiles(path));
    else if (entry.name.endsWith('.cs')) found.push(path);
  }
  return found;
}

/**
 * The cross-assembly types the injected probe sources call, and the ones its injected tree defines. The probe is
 * its own assembly, so it has no automatic reference to the review package the way the working project's
 * Assembly-CSharp-Editor does: every type it names has to be injected next to it.
 */
function probeClosure(probe: string) {
  const text = csFiles(probe).map(file => readFileSync(file, 'utf8'));
  const referenced = new Set(text.flatMap(body => [...body.matchAll(/global::AvatarAudit\.([A-Z]\w*)/g)].map(match => match[1]!)));
  const defined = new Set(text.flatMap(body => [...body.matchAll(/\b(?:class|struct|enum|interface)\s+([A-Za-z_]\w*)/g)].map(match => match[1]!)));
  return { referenced, missing: [...referenced].filter(name => !defined.has(name)) };
}

test('packaging copies an item the Manifest names as one absolute file path, as setup does', t => {
  const f = coldFixture(t, 'file');
  const fixed = f.run();
  assert.equal(fixed.status, 0, fixed.stderr + fixed.stdout);
  assert.deepEqual(f.inspect().material.filter(name => name.endsWith('.unitypackage')),
    ['_追加素材（非客户自备）/registered.unitypackage'], 'the registered file itself ships as the added material');
  // Mutation: the lookup that only understood `<名>-<商品号>/files/` is the defect — restore it and this item is
  // reported as missing from a library that never held it as a folder.
  const legacy = readFileSync(join(tools, 'package.py'), 'utf8')
    .replace('from intake import item_files', 'from intake import find_item')
    .replace(["        located = item_files(library, item['item'])", '        files = located[1] if located else []'].join('\n'),
      ["        folder = find_item(library, item['item'])",
        "        files = sorted((folder / 'files').iterdir()) if folder and (folder / 'files').is_dir() else []"].join('\n'));
  assert.ok(!legacy.includes('located = item_files'), 'the mutation really drops the shared resolver call');
  const mutant = join(f.root, 'legacy_package.py');
  writeFileSync(mutant, legacy);
  const broken = f.run(mutant);
  assert.notEqual(broken.status, 0, 'mutation: the folder-only lookup cannot find a file-path item');
  assert.match(broken.stderr, /素材库里找不到/);
});

test('the cold-import probe carries the review sources it calls, and none of them reach the delivery', t => {
  const f = coldFixture(t, 'folder');
  const fixed = f.run();
  assert.equal(fixed.status, 0, fixed.stderr + fixed.stdout);
  const probe = join(f.project, '_harness_build', 'cold', 'project', 'Assets', '_HarnessColdProbe');
  const asmdef = JSON.parse(readFileSync(join(probe, 'Editor', 'AVH.Harness.ColdProbe.asmdef'), 'utf8')) as { references: string[] };
  assert.ok(asmdef.references.includes('AvatarAudit.Editor'), 'the probe names the assembly that defines the types it calls');
  assert.ok(existsSync(join(probe, 'AvatarAudit', 'Editor', 'AvatarAudit.Editor.asmdef')), 'that assembly is injected beside the probe');
  const closure = probeClosure(probe);
  assert.ok(closure.referenced.has('AuditRunner') && closure.referenced.has('AuditPartInventory'),
    `the probe really calls the review package: ${[...closure.referenced].sort().join(', ')}`);
  assert.deepEqual(closure.missing, [], 'every type the injected probe sources call is defined inside the probe');
  // Non-leakage, read off the shipped archive rather than from the tool's own bookkeeping: the review sources are
  // in the cold copy, and the project zip the customer gets carries neither them nor the probe.
  const shipped = f.inspect();
  assert.equal(shipped.generator, false);
  assert.ok(!shipped.inner.some(name => name.startsWith('Assets/_HarnessColdProbe/')));
  assert.ok(!shipped.inner.some(name => name.startsWith('Assets/_HarnessTools/')));
  // Mutation: without the review sources the probe has no definition for the types its stages call.
  const mutant = join(f.root, 'no_review_package.py');
  writeFileSync(mutant, readFileSync(join(tools, 'package.py'), 'utf8')
    .replace('    copy_tree(audit, cold / PROBE / AUDIT)\n', '    pass  # mutation: no review sources\n'));
  assert.equal(f.run(mutant).status, 0, 'the delivery itself still succeeds without them');
  assert.ok(probeClosure(probe).missing.length > 0, 'mutation: the probe is left without AuditRunner and AuditPartInventory');
});

test('runtimeModule picks .ts beside sources and .js beside compiled modules', () => {  // A file URL is absolute only with a drive on Windows.
  const [base, root] = windows ? ['file:///C:/p', 'C:\\p\\'] : ['file:///p', '/p/'];
  const path = (rest: string) => `${root}${windows ? rest.replaceAll('/', '\\') : rest}`;
  assert.equal(runtimeModule(`${base}/src/task-cli.ts`, './exec/unity-worker'), path('src/exec/unity-worker.ts'));
  assert.equal(runtimeModule(`${base}/dist/task-cli.js`, './exec/unity-worker'), path('dist/exec/unity-worker.js'));
  assert.throws(() => runtimeModule(`${base}/src/a.ts`, './b.ts'), /扩展名/);
});

test('build rewrites relative .ts specifiers and reports leftovers', () => {
  const source = [
    "import { a } from './sandbox.ts';", "import { b } from \"../host-platform.ts\";",
    "const c = await import('./lazy.ts');", "import x from 'pkg.ts';", "const url = './not-an-import.ts';",
  ].join('\n');
  const out = rewriteTsSpecifiers(source) as string;
  assert.match(out, /from '\.\/sandbox\.js'/);
  assert.match(out, /from "\.\.\/host-platform\.js"/);
  assert.match(out, /import\('\.\/lazy\.js'\)/);
  assert.match(out, /from 'pkg\.ts'/, 'bare package specifiers stay as they are');
  assert.match(out, /'\.\/not-an-import\.ts'/, 'plain strings are not module specifiers');
  assert.deepEqual(leftoverTsSpecifiers(out), []);
  assert.deepEqual(leftoverTsSpecifiers(source), ['./sandbox.ts', '../host-platform.ts', './lazy.ts']);
});

test('an installed build reports the commit recorded at build time, not the surrounding repository', () => {
  const info = { packageVersion: '0.1.0-rc.1', commit: 'abcdef123456', dirty: false, builtAt: '2026-09-27T00:00:00Z' };
  assert.equal(harnessVersion('/nonexistent', info), 'abcdef123456');
  assert.equal(harnessVersion('/nonexistent', { ...info, dirty: true }), 'abcdef123456+dirty');
  assert.equal(harnessVersion('/nonexistent', { ...info, commit: null }), '0.1.0-rc.1+nogit');
});

// The built-in pack must run from its own files: an installed Harness has no private workspace to borrow tools from.
const builtinRoot = fileURLToPath(new URL('../../builtin/', import.meta.url));
/** Files that ship: tracked or new-but-not-ignored. Ignored local leftovers in a worktree are not part of the pack. */
function builtinFiles(): string[] {
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '.'], { cwd: builtinRoot, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split('\0').filter(Boolean).map(name => join(builtinRoot, name));
}

test('standalone built-in Python tools import from the pack alone', () => {
  const loader = 'import importlib.util,sys\np=sys.argv[1]\ns=importlib.util.spec_from_file_location("builtin_tool",p)\n'
    + 'm=importlib.util.module_from_spec(s)\ns.loader.exec_module(m)';
  for (const name of readdirSync(tools).filter(file => file.endsWith('.py') && !file.startsWith('blender_'))) {
    const result = spawnSync('python3', ['-c', loader, join(tools, name)], { encoding: 'utf8', cwd: tools,
      env: toolEnv({ PYTHONDONTWRITEBYTECODE: '1' }) });
    assert.equal(result.status, 0, `${name} does not import: ${result.stderr.slice(-400)}`);
  }
});

test('application-bound Blender tools import from the pack in the actual Blender runtime', t => {
  const blender = process.env.AVH_TEST_BLENDER ?? (windows ? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' : '/usr/bin/blender');
  if (!existsSync(blender)) { t.skip('Actual Blender runtime unavailable; its bundled helper imports are unverified on this host'); return; }
  const root = mkdtempSync(join(tmpdir(), 'avh-package-blender-'));
  t.after(() => removeTemp(root));
  const isolated = join(root, 'tools'); cpSync(tools, isolated, { recursive: true });
  const names = readdirSync(isolated).filter(file => file.startsWith('blender_') && file.endsWith('.py'));
  assert.ok(names.length > 0);
  const loader = `import importlib.util,sys\nsys.dont_write_bytecode=True\nsys.path.insert(0,${JSON.stringify(isolated)})\n` +
    `for name in ${JSON.stringify(names)}:\n p=${JSON.stringify(isolated)}+'/'+name\n s=importlib.util.spec_from_file_location(name[:-3],p)\n m=importlib.util.module_from_spec(s)\n s.loader.exec_module(m)\n print('imported '+name)\n`;
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python-expr', loader], {
    encoding: 'utf8', timeout: 90_000, windowsHide: true, cwd: root,
    env: toolEnv({ PYTHONDONTWRITEBYTECODE: '1', BLENDER_USER_CONFIG: join(root, 'config'), BLENDER_USER_SCRIPTS: join(root, 'scripts'), BLENDER_USER_DATAFILES: join(root, 'data') }),
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of names) assert.ok(result.stdout.includes('imported ' + name), `Blender never imported ${name}`);
});

test('every cross-assembly C# type the stage tools call is defined inside the pack', () => {
  const files = builtinFiles().filter(file => file.endsWith('.cs'));
  const sources = files.map(file => readFileSync(file, 'utf8'));
  const stageSources = files.filter(file => file.split(sep).join('/').includes('/tools/harness/unity/')).map(file => readFileSync(file, 'utf8'));
  const references = new Set(stageSources.flatMap(text => [...text.matchAll(/global::(AvatarAudit)\.([A-Z]\w*)|\b(AvatarBuild)\.([A-Z]\w*)\s*\./g)]
    .map(match => `${match[1] ?? match[3]}.${match[2] ?? match[4]}`)));
  assert.ok(references.has('AvatarAudit.AuditRunner') && references.has('AvatarBuild.BuildArtifact'));
  const missing = [...references].filter(reference => {
    const [namespace, type] = reference.split('.');
    return !sources.some(text => new RegExp(`namespace\\s+${namespace}\\b`).test(text)
      && new RegExp(`(class|struct|interface|enum)\\s+${type}\\b`).test(text));
  });
  assert.deepEqual(missing, []);
});

test('every file a shipped capability manifest refers to is in the package', () => {
  // Only the source tree is checked elsewhere; an installed Harness has nothing but the package, and a missing
  // context file stops every formal Workflow at creation.
  const files = new Set<string>(shippedPackFiles(join(builtinRoot, '..')));
  const processDir = join(builtinRoot, 'knowledge', 'process');
  const thresholds = parseYaml(readFileSync(join(processDir, 'thresholds.yaml'), 'utf8'));
  const missing: string[] = [];
  for (const name of readdirSync(processDir).filter(file => file.endsWith('.capabilities.yaml'))) {
    const profile = name.slice(0, -'.capabilities.yaml'.length);
    const capabilities = loadCapabilities(readFileSync(join(processDir, name), 'utf8'),
      loadProcess(readFileSync(join(processDir, `${profile}.process.yaml`), 'utf8'), thresholds));
    for (const stage of Object.values(capabilities.stages)) for (const item of stage.context)
      if (!files.has(`builtin/knowledge/${item.path}`)) missing.push(`${profile}: knowledge/${item.path}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('the npm package and the desktop bundle ship the same versioned pack files', () => {
  const files: string[] = shippedPackFiles(join(builtinRoot, '..'));
  for (const required of ['builtin/pack.json', 'builtin/tools/unpack_unitypackage.py',
    'builtin/tools/构建/BuildArtifact.cs', 'builtin/tools/审查/unity/Editor/AuditIO.cs']) assert.ok(files.includes(required), required);
  assert.ok(files.some(file => file.startsWith('builtin/evaluation/')), 'the evaluation suite ships');
  assert.deepEqual(files.filter(file => /__pycache__|\.pyc$|\.gitignore$/.test(file)), []);
  // A Docker build context has no .git: the list must come out the same without one.
  const context = mkdtempSync(join(tmpdir(), 'avh-no-git-'));
  try {
    cpSync(join(builtinRoot, '..', 'package.json'), join(context, 'package.json'));
    cpSync(builtinRoot, join(context, 'builtin'), { recursive: true });
    assert.deepEqual(shippedPackFiles(context), files);
  } finally { rmSync(context, { recursive: true, force: true }); }
});

/**
 * Client nicknames must not appear in this public repository in any form, so the list of them stays private: a
 * maintainer points AVH_PRIVACY_TERMS at it before a release. Structural patterns are checked everywhere.
 */
function privateTerms(): string[] {
  const path = process.env.AVH_PRIVACY_TERMS;
  return path ? readFileSync(path, 'utf8').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')) : [];
}
test('the built-in pack carries no client identifiers, private workspace names or local paths', () => {
  const pattern = /COMM-[0-9A-Fa-f]{8}|\/home\/[a-z]|vrc[-]processing|\/data\/vrc|\/fast\/unity/;
  const terms = privateTerms();
  const hits = builtinFiles().filter(file => !/\.(png|jpg|fbx|asset|unitypackage)$/i.test(file))
    .flatMap(file => readFileSync(file, 'utf8').split('\n').map((line, i) =>
      pattern.test(line) || terms.some(term => line.includes(term)) ? `${file}:${i + 1}` : '').filter(Boolean));
  assert.deepEqual(hits, []);
});

test('built-in regression stages rebuild the refreshed copy first and let the fit probe finish Play', () => {
  const root = new URL('../../builtin/knowledge/process/', import.meta.url);
  const definition = loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml', root), 'utf8'),
    parseYaml(readFileSync(new URL('thresholds.yaml', root), 'utf8')) as Record<string, unknown>);
  const manifest = loadCapabilities(readFileSync(new URL('pc-recolor-outfit.capabilities.yaml', root), 'utf8'), definition);
  // Each regression stage rebuilds a copy of its own: build_pre/build keep the pre/final slots to themselves.
  for (const [stage, slot] of [['regression_pre', 'regression_pre'], ['regression', 'regression']] as const) {
    const capability = manifest.stages[stage]!;
    assert.match(String(capability.prepareCommand?.join(' ')), new RegExp(`build_copy\\.py --slot ${slot}`));
    const steps = capability.unitySteps ?? [];
    assert.equal(steps[0]?.method, 'AVH.Harness.BuildStage.Run', `${stage} must rebuild after the prepare command`);
    const fit = steps.find(step => step.method === 'AVH.Harness.HarnessFitStage.Run');
    assert.equal(fit?.quit, false, `${stage}: the fit probe exits Unity itself`);
    assert.ok(steps.every(step => step.project === `_harness_build/${slot}/project`));
  }
});

test('the recolor recipe script counts as versioned inside a managed pack, not only in git', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-recipe-pack-'));
  t.after(() => removeTemp(root));
  const probe = (toolRoot: string) => spawnSync('python3', ['-c', [
    'import importlib.util,json,sys', 'from pathlib import Path',
    's=importlib.util.spec_from_file_location("observe_recolor",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
    'print(json.dumps(m.script_versioned(Path(sys.argv[2]),"harness/recolor.py")))'].join('\n'),
    join(tools, 'observe_recolor.py'), toolRoot], { encoding: 'utf8', env: toolEnv({ PYTHONDONTWRITEBYTECODE: '1' }) });
  for (const [dir, manifest] of [['pack', { schema: 'harness-managed-pack/0.1', id: 'p1', version: '1.0.0' }], ['loose', null]] as const) {
    mkdirSync(join(root, dir, 'tools', 'harness'), { recursive: true });
    writeFileSync(join(root, dir, 'tools', 'harness', 'recolor.py'), '');
    if (manifest) writeFileSync(join(root, dir, 'pack.json'), JSON.stringify(manifest));
  }
  assert.deepEqual(JSON.parse(probe(join(root, 'pack', 'tools')).stdout), [true, 'managed-pack:p1@1.0.0']);
  assert.deepEqual(JSON.parse(probe(join(root, 'loose', 'tools')).stdout), [false, 'untracked']);
});
