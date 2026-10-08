import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTemp } from './fixtures/platform.ts';

const TOOLS = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const python = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();

test('preserved-menu delivery instructions do not invent a new outfit selector', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-preserved-delivery-')); t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1]); from package import delivery_note
project=Path(sys.argv[2]); record=project/'Assets/_Harness/Menu/menu.json'; record.parent.mkdir(parents=True)
record.write_text(json.dumps({'route':'preserve','parameters':[],'controls':[]}))
optimization=project/'Assets/_Harness/Optimize/optimize.json'; optimization.parent.mkdir(parents=True)
optimization.write_text(json.dumps({'mode':'preserve'}))
outfit=project/'Assets/_Harness/Outfit/outfit.json'; outfit.parent.mkdir(parents=True)
outfit.write_text(json.dumps({'outfits':[{'id':'fixed-part','label':'Part','activation':'fixed','prefab':'Assets/Part.prefab'}]}))
note=delivery_note(project,'Example',{'request':'Keep the original menu'}, {})
assert '共同穿戴（fixed）' in note
assert '保留原菜单与交互' in note
assert '逐项测试原有菜单' in note
assert '单一衣装轮盘＋' not in note
assert '逐档测试衣装轮盘' not in note
assert '没有新增优化器或修改贴图导入设置' in note
assert 'AAO Trace And Optimize' not in note
from build_copy import apply_plan
meta=project/'original.png.meta'; meta.write_text(chr(10).join(['maxTextureSize: 4096','streamingMipmaps: 0','']))
before=meta.read_bytes()
assert apply_plan(project,{'schema':'texture-plan/0.1','mode':'preserve','textures':[]}) == []
assert meta.read_bytes() == before
record.write_text(json.dumps({'route':'A','parameters':['Outfit'],'controls':[]}))
assert '逐档测试衣装轮盘' in delivery_note(project,'Example',{},{})
`, TOOLS, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('delivery notes list vendor animation omissions without hiding other dependency failures', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-animation-delivery-')); t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1]); from package import delivery_note
project = Path(sys.argv[2]); outfit = project/'Assets/_Harness/Outfit'; outfit.mkdir(parents=True)
(outfit/'outfit.json').write_text(json.dumps({'vendor_missing_animation_references': [
  {'controller':'Assets/KUMALY/Animation/Controllers/KUMALY_FX.controller','state':'Idle','guid':'36102e3c16390604c99a172cd1c85d6b'}]}))
note = delivery_note(project, 'Example', {}, {})
assert '厂商动画缺件提醒（该状态不播放，不阻断）' in note
assert 'KUMALY_FX.controller' in note and '状态 Idle' in note and '36102e3c16390604c99a172cd1c85d6b' in note
(outfit/'outfit.json').write_text(json.dumps({}))
assert '厂商动画缺件提醒' not in delivery_note(project, 'Example', {}, {})
`, TOOLS, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('the delivery note reports the default-hidden parts and the choices left to the user, and invents neither', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-visibility-note-')); t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1]); from package import delivery_note
project = Path(sys.argv[2]); outfit = project/'Assets/_Harness/Outfit'; outfit.mkdir(parents=True)
plain = delivery_note(project, 'Example', {}, {})
assert '## 默认关闭的部件' not in plain and '## 需要你确认的取舍' not in plain, 'empty sections must not be invented'
(outfit/'local-operation-receipt.json').write_text(json.dumps({'schema':'local-operation-receipt/0.1','operations':[
  {'id':'hide_variant','kind':'object_state','path':'_Outfit/Outfit_a/SizeBig','active':False,'rationale':'body keys are all zero, so the default size stays'},
  {'id':'hide_test','kind':'object_state','path':'_Outfit/Outfit_a/ClippingTest','active':False,'exclude_from_build':True,'rationale':'vendor test mesh'},
  {'id':'show_other','kind':'object_state','path':'_Outfit/Outfit_a/SizeDefault','active':True}],
  'user_review':[{'question':'两条裤袜只留一条，留哪条？','detail':'同部位同半径','options':['黑丝','白裤袜']},'两双鞋只能留一双。']}))
note = delivery_note(project, 'Example', {}, {})
assert '## 默认关闭的部件' in note and 'body keys are all zero' in note and '并从构建中排除' in note
assert 'ClippingTest' in note and 'SizeBig' in note and 'SizeDefault' not in note
assert '## 需要你确认的取舍' in note and '留哪条' in note and '黑丝／白裤袜' in note and '两双鞋只能留一双' in note
# A reason the executor wrote with its own full stop must not render as '。。' (GI2): the template adds one.
(outfit/'local-operation-receipt.json').write_text(json.dumps({'schema':'local-operation-receipt/0.1','operations':[
  {'id':'hide_period','kind':'object_state','path':'_Outfit/Outfit_a/SizeMid','active':False,
   'rationale':'这一件与同部位的另两件重合。'}]}))
period = delivery_note(project, 'Example', {}, {})
assert '。。' not in period, 'a duplicated full stop reached the delivery note'
assert '这一件与同部位的另两件重合。' in period and '_Outfit/Outfit_a/SizeMid' in period
# D-143: a closure the executor made because of a visible interpenetration reaches the user with its reading.
(outfit/'local-operation-receipt.json').write_text(json.dumps({'schema':'local-operation-receipt/0.1','operations':[
  {'id':'hide_inner_dress','kind':'object_state','path':'_Outfit/Outfit_inner/Dress','active':False,
   'rationale':'衣物互穿读数：visible_interpenetration_pairs=1，本件从 Outer/Coat 里穿出并被渲图确认 214 个顶点'}],
  'user_review':[]}))
assert 'visible_interpenetration_pairs=1' in delivery_note(project, 'Example', {}, {})
assert '_Outfit/Outfit_inner/Dress' in delivery_note(project, 'Example', {}, {})
# D-143 ③: a pair the executor KEPT for the user (ask_user) reaches the delivery note as a trade-off — with the
# parts, the criterion, the evidence and the reason — and never as a hidden part.
(outfit/'local-operation-receipt.json').write_text(json.dumps({'schema':'local-operation-receipt/0.1','operations':[],
  'user_review':[],
  'interpenetration_decisions':[{'objects':['_Outfit/Outfit_inner/Dress','_Outfit/Outfit_outer/Coat'],
   'decision':'ask_user','criterion':'订单点名的件优先保留','evidence':'confirmed=64, depth_max=0.96mm',
   'rationale':'订单点名要露出的里层裙从外套里穿出，要不要保留请你定'},
   {'objects':['_Outfit/Outfit_inner/Hide','_Outfit/Outfit_outer/Cape'],'decision':'close','rationale':'内层被披风盖住'}]}))
kept = delivery_note(project, 'Example', {}, {})
assert '## 需要你确认的取舍' in kept and '订单点名要露出的里层裙' in kept
assert '保留 _Outfit/Outfit_inner/Dress ↔ _Outfit/Outfit_outer/Coat' in kept
assert '依据准则：订单点名的件优先保留' in kept and '依据证据：confirmed=64, depth_max=0.96mm' in kept
assert 'Hide' not in kept, 'a closed pair belongs in the hidden parts, not in the trade-offs'
# The visibility record's recorded decisions are the fallback for a receipt that does not carry the reason.
(outfit/'local-operation-receipt.json').unlink()
(outfit/'visibility.json').write_text(json.dumps({'schema':'outfit-visibility/0.1','hidden_by_decision':[
  {'path':'_Outfit/Outfit_a/SizeBig','operation':'hide_variant','rationale':'同一几何的副本'}]}))
assert '同一几何的副本' in delivery_note(project, 'Example', {}, {})
# Mutation: with neither record the sections must disappear again, so the assertions above are about the records.
(outfit/'visibility.json').unlink()
assert '## 默认关闭的部件' not in delivery_note(project, 'Example', {}, {})
`, TOOLS, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('a numbered trade-off reaches the delivery note with its options, recommendation, current choice and how to answer', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-trade-off-note-')); t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1]); from package import delivery_note
project = Path(sys.argv[2]); outfit = project/'Assets/_Harness/Outfit'; outfit.mkdir(parents=True)
record = outfit/'local-operation-receipt.json'
option_a = {'id': 'A', 'label': '关掉 LUNALICE 的裙装与高跟鞋', 'operations': [
    {'kind': 'object_state', 'path': '_Outfit/Outfit_lunalice/Dress_Skirt', 'active': False, 'rationale': '同部位冲突，配饰让位'},
    {'kind': 'object_state', 'path': '_Outfit/Outfit_lunalice/Shoes_Highheels', 'active': False, 'rationale': '同部位冲突，配饰让位'}]}
option_b = {'id': 'B', 'label': '两件都保留', 'operations': []}
record.write_text(json.dumps({'schema': 'local-operation-receipt/0.1', 'operations': [], 'user_review': [
    {'id': 'T1', 'question': '腰臀与脚部谁让位？', 'detail': '同部位同半径；confirmed=329、324',
     'options': [option_a, option_b], 'recommended': 'A', 'current': 'B'}],
  'interpenetration_decisions': [
    {'objects': ['_Outfit/Outfit_snowflake/Coat', '_Outfit/Outfit_lunalice/Dress_Skirt'], 'decision': 'ask_user',
     'rationale': '两件都是订单点名的整套来源', 'review': 'T1'}]}))
note = delivery_note(project, 'Example', {}, {})
assert '## 需要你确认的取舍' in note, 'the trade-off section must be there'
assert '- T1 腰臀与脚部谁让位？' in note, 'the trade-off must be listed by its number'
assert '依据：同部位同半径；confirmed=329、324。' in note
assert 'A 关掉 LUNALICE 的裙装与高跟鞋（关掉 _Outfit/Outfit_lunalice/Dress_Skirt；关掉 _Outfit/Outfit_lunalice/Shoes_Highheels）（推荐）' in note, note
assert 'B 两件都保留（保持现状，什么也不改）（当前）' in note, note
assert '涉及：_Outfit/Outfit_snowflake/Coat ↔ _Outfit/Outfit_lunalice/Dress_Skirt' in note, 'the kept pair names its number'
assert '要改的话，在重做意见里写编号，例如「T1 选 A」' in note, 'the user must be told to answer by number'
assert note.count('关掉 LUNALICE 的裙装与高跟鞋') == 1, 'the options must not be written twice'
# Mutation: without the number the user cannot name the choice, so it must fall back to prose rather than
# rendering marks and an instruction no rework feedback could use.
broken = json.loads(record.read_text())
broken['user_review'][0].pop('id')
record.write_text(json.dumps(broken))
loose = delivery_note(project, 'Example', {}, {})
assert '（推荐）' not in loose and '（当前）' not in loose and '要改的话' not in loose, loose
assert '腰臀与脚部谁让位？' in loose, 'the unnumbered trade-off must still reach the user'
# Mutation: without the record the section disappears, so the assertions above are about the record.
record.unlink()
assert '## 需要你确认的取舍' not in delivery_note(project, 'Example', {}, {})
`, TOOLS, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('setup refuses differing existing settings before overwriting or deleting project work', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-preserve-')); t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1]); import setup
root=Path(sys.argv[2]); project=root/'project'; template=root/'template'
for base in (project,template): (base/'ProjectSettings').mkdir(parents=True)
(project/'ProjectSettings/Settings.asset').write_text('user changes')
(project/'ProjectSettings/Extra.asset').write_text('keep extra')
(template/'ProjectSettings/Settings.asset').write_text('baseline')
try: setup.baseline(template,project,{})
except ValueError as error: assert '保留原内容' in str(error)
else: raise AssertionError('Existing settings were overwritten')
assert (project/'ProjectSettings/Settings.asset').read_text() == 'user changes'
assert (project/'ProjectSettings/Extra.asset').read_text() == 'keep extra'
assert not (project/'Packages').exists()
`, TOOLS, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('setup removes only a VPM manifest BOM so strict downstream JSON readers accept the copied file', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-bom-')); t.after(() => removeTemp(root));
  const template = join(root, 'template'), project = join(root, 'project');
  execFileSync('python3', ['-c', `import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1]); import setup
root = Path(sys.argv[2]); template = root/'template'; project = root/'project'
(template/'ProjectSettings').mkdir(parents=True); (template/'Packages').mkdir()
project.mkdir()
(template/'ProjectSettings/EditorSettings.asset').write_bytes(b'editor-settings\\x00bytes')
(template/'Packages/vpm-manifest.json').write_bytes(b'\\xef\\xbb\\xbf{"locked": {}}')
(template/'Packages/manifest.json').write_bytes(b'{"dependencies": {}}')
setup.baseline(template, project, {})
`, TOOLS, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const sourceManifest = readFileSync(join(template, 'Packages', 'vpm-manifest.json'));
  const copiedManifest = readFileSync(join(project, 'Packages', 'vpm-manifest.json'));
  assert.deepEqual(JSON.parse(copiedManifest.toString('utf8')), { locked: {} }, 'a strict downstream JSON reader parses the setup output');
  assert.deepEqual(copiedManifest, Buffer.from('{"locked": {}}'), 'only the leading UTF-8 BOM is removed');
  assert.deepEqual(sourceManifest, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"locked": {}}')]), 'the template remains byte-for-byte unchanged');
  assert.deepEqual(readFileSync(join(project, 'ProjectSettings', 'EditorSettings.asset')), Buffer.from('editor-settings\0bytes'));
  assert.deepEqual(readFileSync(join(project, 'Packages', 'manifest.json')), Buffer.from('{"dependencies": {}}'));
});

test('the package check leaves out items the approved plan declined, and only those', { skip: !python && 'python3 is not installed' }, t => {
  const project = mkdtempSync(join(tmpdir(), 'avh-package-metrics-')); t.after(() => removeTemp(project));
  const file = (path: string, body: string) => { mkdirSync(join(project, path, '..'), { recursive: true }); writeFileSync(join(project, path), body); };
  const used = 'a'.repeat(32);
  // The delivered avatar reaches one file of item A; B and C are imported but nothing references them.
  file('Assets/_Harness/Optimize/Avatar.prefab', `%YAML 1.1\n--- !u!21 &1\n  m_Material: {fileID: 2100000, guid: ${used}, type: 2}\n`);
  file('Assets/VendorA/body.mat', '%YAML 1.1\n'); file('Assets/VendorA/body.mat.meta', `fileFormatVersion: 2\nguid: ${used}\n`);
  file('Assets/VendorB/shoe.mat', '%YAML 1.1\n'); file('Assets/VendorB/shoe.mat.meta', `fileFormatVersion: 2\nguid: ${'b'.repeat(32)}\n`);
  file('_harness/setup/import.json', JSON.stringify({ packages: [{ item: 'A', roots: ['Assets/VendorA'] }, { item: 'B', roots: ['Assets/VendorB'] },
    { item: 'C', roots: [] }] }));
  const measure = (plan: unknown) => JSON.parse(execFileSync('python3', ['-c', `import json, sys; from pathlib import Path
sys.path.insert(0, ${JSON.stringify(TOOLS)}); import observe_assets as o
notes = []; m = o.package_metrics(Path(${JSON.stringify(project)}), None, {'assets': [{'item': 'A'}, {'item': 'B'}, {'item': 'C'}]}, json.loads(sys.argv[1]), notes)
print(json.dumps({'unused': m['assets_without_external_refs'], 'notes': notes}))`, JSON.stringify(plan)],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })) as { unused: number; notes: string[] };
  assert.equal(measure({}).unused, 2, 'B and C count when the plan declined nothing');
  const unusedRow = { item: 'C', reason: 'unsupported', note: '不支持本素体' };
  // D-115: a decline is exempt only when the unused row agrees with the item's single exclude obligation.
  const declined = measure({ unused: [unusedRow], obligations: [{ input: 'C', action: 'exclude', reason: 'unsupported' }] });
  assert.equal(declined.unused, 1, 'only B still counts');
  assert.ok(declined.notes.some(note => note.includes("['C']")));
  assert.equal(measure({ unused: [unusedRow] }).unused, 2, 'an unused row without its exclude obligation does not discharge C');
});

test('build_copy gives each slot its own copy, and only the optimize-layer slots apply the texture plan', { skip: !python && 'python3 is not installed' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-build-slots-')); t.after(() => removeTemp(root));
  const project = join(root, 'project');
  mkdirSync(join(project, 'Assets/_Harness/Optimize'), { recursive: true });
  writeFileSync(join(project, 'tex.png.meta'), 'maxTextureSize: 4096\nstreamingMipmaps: 0\n');
  writeFileSync(join(project, 'Assets/_Harness/Optimize/texture_plan.json'), JSON.stringify({ schema: 'texture-plan/0.1',
    textures: [{ path: 'tex.png', guid: 'g', action: 'downscale', target_max_size: 1024, compressed: true }] }));
  const script = `import json, os, sys
from pathlib import Path
tools, project = sys.argv[1], Path(sys.argv[2])
sys.path.insert(0, tools)
import build_copy
os.environ['AVH_PROJECT_DIR'] = str(project)
def run(slot):
    sys.argv = ['build_copy.py', '--slot', slot]
    build_copy.main()
    return json.loads((project / '_harness_build' / slot / 'project/.texture_plan_applied.json').read_text())
original = (project / 'tex.png.meta').read_text()
# The regression slots measure the same layers as the builds they belong to, in copies of their own.
for slot, layer, planned in (('regression', 'final', True), ('regression_pre', 'pre', False)):
    record = run(slot)
    assert record['slot'] == slot and record['layer'] == layer, record
    meta = (project / '_harness_build' / slot / 'project/tex.png.meta').read_text()
    if planned:
        assert 'maxTextureSize: 1024' in meta and meta != original, meta
    else:
        assert meta == original, 'the pre layer must not apply the optimize texture plan'
        assert 'texture_changes' not in record, record
# The two upstream slots keep working unchanged.
run('pre'); run('final')
assert json.loads((project / '_harness_build/pre/project/.texture_plan_applied.json').read_text())['layer'] == 'pre'
assert json.loads((project / '_harness_build/final/project/.texture_plan_applied.json').read_text())['layer'] == 'final'
`;
  execFileSync('python3', ['-c', script, TOOLS, project], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('build_copy never mirrors the previous delivery package into a copy', { skip: !python && 'python3 is not installed' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-build-delivery-')); t.after(() => removeTemp(root));
  const project = join(root, 'project');
  const file = (path: string, body: string) => { mkdirSync(join(project, path, '..'), { recursive: true }); writeFileSync(join(project, path), body); };
  file('_harness/delivery/Avatar_交付.zip', 'x'.repeat(1024));
  file('_harness/delivery/notes.txt', 'previous round');
  file('_harness/intake/inventory.json', '{}');
  // A copy that already carries the old delivery package from before this change: the refresh has to reclaim it.
  file('_harness_build/pre/project/_harness/delivery/Avatar_交付.zip', 'x'.repeat(1024));
  const script = `import json, os, sys
from pathlib import Path
tools, project = sys.argv[1], Path(sys.argv[2])
sys.path.insert(0, tools)
import build_copy
os.environ['AVH_PROJECT_DIR'] = str(project)
sys.argv = ['build_copy.py', '--slot', 'pre']
build_copy.main()
copy = project / '_harness_build/pre/project'
assert not (copy / '_harness/delivery').exists(), 'the delivery package must not enter the copy'
record = json.loads((copy / '.texture_plan_applied.json').read_text())
assert record['removed'] >= 1, record
assert (copy / '_harness/intake/inventory.json').read_text() == '{}', 'the rest of _harness/ is still mirrored'
`;
  execFileSync('python3', ['-c', script, TOOLS, project], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('a Workflow made in the GUI (items are file paths) gets through intake, its check and setup unpacking', { skip: !python && 'python3 is not installed' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-gui-items-')); t.after(() => removeTemp(root));
  const project = join(root, 'project'), library = join(root, 'library'), files = join(root, 'files');
  for (const dir of [project, library, files]) mkdirSync(dir, { recursive: true });
  // Two .unitypackage streams built by Python's own tarfile and gzip: a body with one prefab, an outfit inside a zip.
  const make = (out: string, guid: string, asset: string) => `
import gzip, io, tarfile
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w') as tar:
    for name, data in (('${guid}/pathname', b'${asset}'), ('${guid}/asset', b'%YAML 1.1\\n'), ('${guid}/asset.meta', b'fileFormatVersion: 2\\nguid: ${guid}\\n')):
        info = tarfile.TarInfo(name); info.size = len(data); tar.addfile(info, io.BytesIO(data))
open(${JSON.stringify(out)}, 'wb').write(gzip.compress(buf.getvalue()))`;
  const body = join(files, 'Kaguya_v1.unitypackage'), outfit = join(files, '777-Sakura_Kimono.zip');
  execFileSync('python3', ['-c', make(body, 'a'.repeat(32), 'Assets/Kaguya/Kaguya.prefab')]);
  execFileSync('python3', ['-c', `${make(join(root, 'kimono.unitypackage'), 'b'.repeat(32), 'Assets/Kimono/Kimono_Kaguya.prefab')}
import zipfile
with zipfile.ZipFile(${JSON.stringify(outfit)}, 'w') as z: z.write(${JSON.stringify(join(root, 'kimono.unitypackage'))}, 'Kimono_Kaguya.unitypackage')`]);
  const manifest = { schema: 'manifest/0.1', profile: 'pc-recolor-outfit', request: '和服', assets: [
    { store: 'library', item: body, role: 'body', name: 'Kaguya 素体' }, { store: 'library', item: outfit, role: 'outfit', name: '春樱和服' }] };
  const env = { ...process.env, AVH_MANIFEST: JSON.stringify(manifest), PYTHONDONTWRITEBYTECODE: '1' };
  execFileSync('python3', [join(TOOLS, 'intake.py'), '--library', library, '--project', project], { env, encoding: 'utf8' });
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8')) as
    { items: Array<{ item: string; found: boolean; files: Array<{ selected: boolean }>; prefabs: string[] }> };
  assert.deepEqual(inventory.items.map(item => [item.found, item.files.filter(file => file.selected).length]), [[true, 1], [true, 1]]);
  assert.deepEqual(inventory.items.map(item => item.prefabs), [['Assets/Kaguya/Kaguya.prefab'], ['Assets/Kimono/Kimono_Kaguya.prefab']]);
  const metrics = JSON.parse(execFileSync('python3', ['-c', `import json, sys; from pathlib import Path
sys.path.insert(0, ${JSON.stringify(TOOLS)}); import observe_assets as o
print(json.dumps(o.intake_metrics(Path(${JSON.stringify(project)}), Path(${JSON.stringify(library)}), json.loads(sys.argv[1]), [])))`,
    JSON.stringify(manifest)], { env, encoding: 'utf8' })) as { inventory_entries: number; product_directory_count: number };
  assert.equal(metrics.product_directory_count, metrics.inventory_entries, 'inventory_count_match holds for file items');
  const unpacked = JSON.parse(execFileSync('python3', ['-c', `import json, sys; from pathlib import Path
sys.path.insert(0, ${JSON.stringify(TOOLS)}); import setup
project = Path(${JSON.stringify(project)}); scratch = project / 'scratch'; scratch.mkdir(); record = {}
inventory = json.loads((project / '_harness/intake/inventory.json').read_text(encoding='utf-8'))
print(json.dumps(setup.unpack_selected(project, Path(${JSON.stringify(library)}), inventory, scratch, record)))`], { env, encoding: 'utf8' })) as string[];
  assert.deepEqual(unpacked, ['Assets/Kaguya', 'Assets/Kimono']);
  assert.equal(readFileSync(join(project, 'Assets/Kaguya/Kaguya.prefab'), 'utf8'), '%YAML 1.1\n');
});


test('approved exclusions disable setup selection, snapshots, and import while preserving intake evidence', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-exclusion-')); t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import gzip,io,json,os,sys,tarfile
from pathlib import Path
sys.path.insert(0,sys.argv[1]); import setup
root=Path(sys.argv[2]); library=root/'library'; project=root/'project'; template=root/'template'; scratch=root/'scratch'
for p in (library,project,template,scratch): p.mkdir()
(template/'ProjectSettings').mkdir(); (template/'Packages').mkdir()
(template/'ProjectSettings/ProjectVersion.txt').write_text('m_EditorVersion: 2022.3.22f1\\n')
(template/'Packages/manifest.json').write_text(json.dumps({'dependencies':{}}))
(template/'Packages/vpm-manifest.json').write_text(json.dumps({'locked':{},'dependencies':{}}))
def product(item,name,asset):
 folder=library/(name+'-'+item); files=folder/'files'; files.mkdir(parents=True); path=files/(name+'.unitypackage')
 guid='a'*32 if item=='kept' else 'b'*32; buf=io.BytesIO()
 with tarfile.open(fileobj=buf,mode='w') as tar:
  for leaf,data in ((guid+'/pathname',asset.encode()),(guid+'/asset',b'prefab')):
   info=tarfile.TarInfo(leaf); info.size=len(data); tar.addfile(info,io.BytesIO(data))
 path.write_bytes(gzip.compress(buf.getvalue())); return path
kept=product('kept','Kept','Assets/Kept/Thing.prefab'); excluded=product('excluded','Excluded','Assets/Excluded/Thing.prefab')
def row(item,role,path):
 return {'item':item,'role':role,'found':True,'files':[{'name':path.name,'selected':True,'sha256':setup.file_digest(path),'packages':[path.name]}]}
inventory={'items':[row('kept','outfit',kept),row('excluded','other',excluded)]}
plan={'unused':[{'item':'excluded','reason':'client_declined','note':'customer installs it'}],
 'obligations':[{'input':'kept','role':'outfit','action':'use','target':'kept','due_stage':'outfit'},
 {'input':'excluded','role':'other','action':'exclude','reason':'customer installs it'}]}
excluded_items=setup.excluded_items(plan); effective=setup.effective_inventory(inventory,excluded_items)
assert effective['items'][1]['files'][0]['selected'] is False
assert inventory['items'][1]['files'][0]['selected'] is True
(project/'_harness/intake').mkdir(parents=True)
(project/'_harness/intake/inventory.json').write_text(json.dumps(inventory))
os.environ.update({'AVH_PLAN':json.dumps(plan),'AVH_PROJECT_DIR':str(project),'AVH_RUN_DIR':str(scratch)})
sys.argv=['setup.py','--template',str(template),'--library',str(library),'--project',str(project)]
setup.main()
record=json.loads((project/'_harness/setup/import.json').read_text())
assert (project/'Assets/Kept/Thing.prefab').is_file()
assert not (project/'Assets/Excluded').exists(); assert [p['item'] for p in record['packages']]==['kept']
# Mutation: omitting the approved exclusion from the setup projection imports the excluded package again.
mutant_project=root/'mutant-project'; mutant_project.mkdir(); mutant_scratch=root/'mutant-scratch'; mutant_scratch.mkdir()
mutant_inventory=setup.effective_inventory(inventory, None); mutant_record={}
mutant_snapshots=setup.snapshot_inputs(library,mutant_inventory,mutant_scratch)
mutant_roots=setup.unpack_selected(mutant_project,library,mutant_inventory,mutant_scratch,mutant_record,mutant_snapshots)
assert 'Assets/Excluded' in mutant_roots, 'mutation: without the exclusion projection setup imports excluded data'
`, TOOLS, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('rerunning setup preserves import history and blocks excluded data in shared and direct Assets layouts', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-history-')); t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import gzip,io,json,os,sys,tarfile
from pathlib import Path
sys.path.insert(0,sys.argv[1]); import setup,package as delivery
root=Path(sys.argv[2])
def package(path, guid, asset):
 path.parent.mkdir(parents=True,exist_ok=True); buf=io.BytesIO()
 with tarfile.open(fileobj=buf,mode='w') as tar:
  for leaf,data in ((guid+'/pathname',asset.encode()),(guid+'/asset',b'%YAML 1.1\\n'),(guid+'/asset.meta',('fileFormatVersion: 2\\nguid: '+guid+'\\n').encode())):
   info=tarfile.TarInfo(leaf);info.size=len(data);tar.addfile(info,io.BytesIO(data))
 path.write_bytes(gzip.compress(buf.getvalue()))
def run(layout):
 base=root/layout;library=base/'library';project=base/'project';template=base/'template';scratch=base/'scratch'
 for p in (library,project,template,scratch):p.mkdir(parents=True)
 (template/'ProjectSettings').mkdir();(template/'Packages').mkdir()
 (template/'ProjectSettings/ProjectVersion.txt').write_text('m_EditorVersion: 2022.3.22f1\\n')
 (template/'Packages/manifest.json').write_text(json.dumps({'dependencies':{}}))
 (template/'Packages/vpm-manifest.json').write_text(json.dumps({'locked':{},'dependencies':{}}))
 entries={'kept':('Kept','Assets/Shared/Kept.prefab' if layout=='shared' else 'Assets/Kept.prefab'),
          'excluded':('Excluded','Assets/Shared/Excluded.prefab' if layout=='shared' else 'Assets/Excluded.prefab')}
 inventory=[]
 for item,(name,asset) in entries.items():
  path=library/(name+'-'+item)/'files'/(name+'.unitypackage');package(path,('a' if item=='kept' else 'b')*32,asset)
  inventory.append({'item':item,'role':'outfit','found':True,'files':[{'name':path.name,'selected':True,'sha256':setup.file_digest(path),'packages':[path.name]}]})
 (project/'_harness/intake').mkdir(parents=True);(project/'_harness/intake/inventory.json').write_text(json.dumps({'items':inventory}))
 def invoke(plan):
  os.environ.update({'AVH_PLAN':json.dumps(plan),'AVH_PROJECT_DIR':str(project),'AVH_RUN_DIR':str(scratch)})
  sys.argv=['setup.py','--template',str(template),'--library',str(library),'--project',str(project)]
  setup.main()
 use={'obligations':[{'input':'kept','action':'use','reason':'keep'},{'input':'excluded','action':'use','reason':'keep'}]}
 sizes=[]; receipts=[]
 for _ in range(4):
  invoke(use)
  path=project/'_harness/setup/import.json'; sizes.append(path.stat().st_size)
  receipts.append(json.loads(path.read_text()))
 old=receipts[-1]
 assert len(old['packages'])==2
 assert len(old['history'])==3
 assert all('history' not in entry for entry in old['history']), 'setup history must stay flat'
 assert all(later > earlier for earlier,later in zip(sizes,sizes[1:])), 'successful history retains each predecessor'
 assert sizes[-1] - sizes[-2] <= sizes[-2] - sizes[-3] + 64, 'history growth must remain linear'
 declined={'unused':[{'item':'excluded','reason':'client_declined','note':'customer installs it'}],
  'obligations':[{'input':'kept','action':'use','reason':'keep'},{'input':'excluded','action':'exclude','reason':'customer installs it'}]}
 try:invoke(declined)
 except ValueError as error:assert '旧导入数据' in str(error),error
 else:raise AssertionError('setup allowed excluded historical data to survive')
 current=json.loads((project/'_harness/setup/import.json').read_text())
 assert current==old,'a blocked retry must not overwrite the prior receipt'
 try:delivery.assert_excluded_data_absent(project,project,old,{}, {'items':inventory},declined)
 except SystemExit as error:assert '排除商品' in str(error),error
 else:raise AssertionError('package check ignored preserved import history')
for layout in ('shared','direct'):run(layout)
`, TOOLS, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('environment VPM requirements apply the approved exclusion before installation planning', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-environment-exclusion-')); t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1]); import environment
project=Path(sys.argv[2]); path=project/'_harness/intake/vpm-requirements.json'; path.parent.mkdir(parents=True)
rows=[{'item':'kept','role':'other','entry':'kept.url','repository':'https://repo.invalid/kept.json'},
 {'item':'excluded','role':'other','entry':'excluded.url','repository':'https://repo.invalid/excluded.json'}]
path.write_text(json.dumps({'schema':'vpm-requirements/0.1','requirements':rows}))
(project/'_harness/intake/inventory.json').write_text(json.dumps({'items':[
 {'item':'kept','files':[{'selected':True,'kind':'vpm','name':'kept.url'}]},
 {'item':'excluded','files':[{'selected':True,'kind':'vpm','name':'excluded.url'}]}]}))
os.environ['AVH_PLAN']=json.dumps({'unused':[{'item':'excluded','reason':'unsupported','note':'customer installs it'}],
 'obligations':[{'input':'excluded','role':'other','action':'exclude','reason':'customer installs it'}]})
assert [row['item'] for row in environment.vpm_requirements(project)]==['kept']
# Mutation: without the exclusion set the installer request for the excluded product remains.
environment.effective_inventory=lambda inventory, plan: inventory
assert [row['item'] for row in environment.vpm_requirements(project)]==['kept','excluded']
`, TOOLS, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('independent setup observers use the approved effective selection for every excluded input shape', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-observer-effective-selection-')); t.after(() => removeTemp(root));
  execFileSync('python3', ['-c', `import gzip,io,json,os,sys,tarfile
from pathlib import Path
sys.path.insert(0,sys.argv[1]);import observe_assets,observe_project
root=Path(sys.argv[2]);project=root/'project';library=root/'library';out=root/'observation.json'
(project/'_harness/intake').mkdir(parents=True);(project/'_harness/setup').mkdir(parents=True);(library/'Common-common/files').mkdir(parents=True)
guid='c'*32;buf=io.BytesIO()
with tarfile.open(fileobj=buf,mode='w') as tar:
 for leaf,data in ((guid+'/pathname',b'Assets/Common/Shared.mat'),(guid+'/asset',b'%YAML 1.1\\n'),(guid+'/asset.meta',('fileFormatVersion: 2\\nguid: '+guid+'\\n').encode())):
  info=tarfile.TarInfo(leaf);info.size=len(data);tar.addfile(info,io.BytesIO(data))
(library/'Common-common/files/Common_material.unitypackage').write_bytes(gzip.compress(buf.getvalue()))
items=[
 {'item':'unity','files':[{'name':'Body.unitypackage','selected':True,'kind':'unitypackage','packages':['Body.unitypackage']}]},
 {'item':'vpm','files':[{'name':'Plugin.url','selected':True,'kind':'vpm'}]},
 {'item':'texture','files':[{'name':'skin.png','selected':True,'kind':'texture','projectPath':'Assets/_HarnessTextures/'+'d'*64+'.png','sha256':'d'*64}]},
 {'item':'common','files':[{'name':'Common_material.unitypackage','selected':True,'kind':'unitypackage','packages':['Common_material.unitypackage']}]},]
inventory={'items':items};(project/'_harness/intake/inventory.json').write_text(json.dumps(inventory));(project/'_harness/setup/import.json').write_text(json.dumps({'packages':[]}))
plan={'unused':[{'item':item,'reason':'client_declined','note':'customer installs it'} for item in ('unity','vpm','texture','common')],
 'obligations':[{'input':item,'action':'exclude','reason':'customer installs it'} for item in ('unity','vpm','texture','common')]}
os.environ.update({'AVH_PLAN':json.dumps(plan),'AVH_RUN_DIR':str(root)})
notes=[];metrics=observe_assets.setup_metrics(project,library,{'assets':[{'item':item} for item in ('unity','vpm','texture','common')]},notes)
assert metrics['missing_common_material_packs']==0,metrics
assert observe_project.vpm_import_closure(project,inventory,[{'item':'vpm','kind':'vpm','zip':'Plugin.url'}],plan)==([],[])
os.environ['AVH_RUN_DIR']=str(root);sys.argv=['observe_project.py','--project',str(project),'--out',str(out),'--environment-tool',str(Path(sys.argv[1])/'environment.py'),'--environment-recipe',str(Path(sys.argv[1])/'environment-recipe.json')]
observe_project.main();observed=json.loads(out.read_text());assert observed['metrics']['remaining_unopened_archives']==0,observed
observe_assets.effective_inventory=lambda inventory,plan: inventory
assert observe_assets.setup_metrics(project,library,{'assets':[{'item':'common'}]},[] )['missing_common_material_packs']==1
observe_project.effective_inventory=lambda inventory,plan: inventory
assert observe_project.vpm_import_closure(project,inventory,[{'item':'vpm','kind':'vpm','zip':'Plugin.url'}],plan)[1]
observe_project.main();mutated=json.loads(out.read_text());assert mutated['metrics']['remaining_unopened_archives']>0,mutated
`, TOOLS, root], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
});

test('approved direct textures traverse intake, frozen setup import and independent content verification', {skip:!python}, t=>{
  const root=mkdtempSync(join(tmpdir(),'avh-direct-texture-'));t.after(()=>removeTemp(root));
  execFileSync('python3',['-c',`import base64,hashlib,json,os,sys,subprocess
from pathlib import Path
sys.path.insert(0,sys.argv[1]);import intake,setup
root=Path(sys.argv[2]);library=root/'library';library.mkdir();project=root/'project';project.mkdir();scratch=root/'scratch';scratch.mkdir()
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
source=library/'skin.png';source.write_bytes(png);digest=hashlib.sha256(png).hexdigest()
manifest={'schema':'manifest/0.1','request':'use this texture','assets':[{'item':str(source),'store':'library','role':'texture','sha256':digest}]}
env={**os.environ,'AVH_MANIFEST':json.dumps(manifest)}
subprocess.run([sys.executable,str(Path(sys.argv[1])/'intake.py'),'--library',str(library),'--project',str(project)],env=env,check=True)
inventory=json.loads((project/'_harness/intake/inventory.json').read_text(encoding='utf-8'));entry=inventory['items'][0]['files'][0]
assert entry['selected'] and entry['kind']=='texture' and entry['sha256']==digest
assert inventory['items'][0]['prefabs']==[]
record={};snapshots=setup.snapshot_inputs(library,inventory,scratch)
source.write_bytes(b'changed after snapshot')
assert setup.unpack_selected(project,library,inventory,scratch,record,snapshots)==['Assets/_HarnessTextures']
target=project/entry['projectPath'];assert target.read_bytes()==png
(project/'_harness/setup').mkdir();(project/'_harness/setup/import.json').write_text(json.dumps(record))
(project/'Packages').mkdir();(project/'Packages/manifest.json').write_text('{}')
def verify():
 out=root/'observation.json';subprocess.run([sys.executable,str(Path(sys.argv[1])/'observe_project.py'),'--project',str(project),'--environment-tool',str(Path(sys.argv[1])/'environment.py'),'--environment-recipe',str(Path(sys.argv[1])/'environment-recipe.json'),'--out',str(out)],check=True)
 metrics=json.loads(out.read_text())['metrics']
 assert metrics['package_resolution_consistent'] is False,'texture-only fixture has no accepted environment'
 return metrics['unresolved_unpack_conflicts']
assert verify()==0
target.write_bytes(b'changed project');assert verify()==1
try: setup.unpack_selected(project,library,inventory,scratch,{},snapshots)
except ValueError as error: assert '保留现有工程' in str(error)
else: raise AssertionError('overwrote existing texture')
assert target.read_bytes()==b'changed project'
try: setup.snapshot_inputs(library,inventory,scratch)
except ValueError as error: assert '清点版本' in str(error)
else: raise AssertionError('accepted changed source')
source.write_bytes(png);bad=library/'fake.jpg';bad.write_bytes(png)
try:intake.choose_files([bad],'texture',None,None)
except ValueError:pass
else:raise AssertionError('accepted mismatched image format')
assert not intake.choose_files([source],'other',None,None)[0]['selected']
`,TOOLS,root],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},encoding:'utf8'});
});


test('actual recolor generator writes canonical bytes accepted by the independent recipe replay observer', {skip:!python},t=>{
 const project=mkdtempSync(join(tmpdir(),'avh-recolor-replay-'));t.after(()=>removeTemp(project));
 const out=join(project,'observation.json'),recipe=join(project,'Assets/_Harness/Recolor/recipe.json');
 const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',AVH_PROJECT_DIR:project,AVH_RUN_DIR:project,AVH_TOOL_ROOT:join(TOOLS,'..'),AVH_PLAN:JSON.stringify({recolor:{targets:[{part:'eye',hue_shift:20,saturation:1,value:1}],candidates:3}})};
 const generate=()=>execFileSync('python3',[join(TOOLS,'recolor.py')],{env,stdio:'pipe'});
 const observe=()=>{execFileSync('python3',[join(TOOLS,'observe_recolor.py'),'--out',out],{env,stdio:'pipe'});return JSON.parse(readFileSync(out,'utf8')).metrics.rerun_recipe_hash_equal;};
 generate();assert.equal(observe(),true,'Actual first generated recipe must survive byte-for-byte replay on this host');
 const before=readFileSync(recipe);generate();assert.deepEqual(readFileSync(recipe),before);
 const numericEquivalent={...env,AVH_PLAN:env.AVH_PLAN.replace('"saturation":1','"saturation":1.0').replace('"value":1','"value":1.0')};
 execFileSync('python3',[join(TOOLS,'recolor.py')],{env:numericEquivalent,stdio:'pipe'});
 assert.deepEqual(readFileSync(recipe),before,'YAML float spelling and Runtime JSON integer spelling must produce identical bytes');
 assert.equal(observe(),true,'Independent Runtime replay must consume the numeric-equivalent generated recipe');
 writeFileSync(recipe,before.toString('utf8').replace('"hue_shift": 20.0','"hue_shift": 21.0'));assert.equal(observe(),false,'Real numeric edits must remain visible');
 writeFileSync(recipe,before.toString('utf8').replaceAll('\n','\r\n'));assert.equal(observe(),false,'Independent observer must detect noncanonical or edited bytes');
});

// A fixed colour is the requirement itself, so it must not be scaled into candidate tiers: a candidate
// that shifted it would be a candidate that violates the order, and choosing one cannot grant permission
// to change a frozen requirement. The recipe therefore carries these operations through untouched and
// offers one candidate, which has to survive the same independent replay as the relative form.
test('a fixed layer colour is carried through untouched and offers a single candidate', {skip:!python},t=>{
 const project=mkdtempSync(join(tmpdir(),'avh-recolor-layer-'));t.after(()=>removeTemp(project));
 const out=join(project,'observation.json'),recipe=join(project,'Assets/_Harness/Recolor/recipe.json');
 const layer={requirement_id:'lash',layered:'Body/PSD/Face_default.psd',layer:['eyelash '],color:'#5B5B66',semantics:'flat'};
 const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',AVH_PROJECT_DIR:project,AVH_RUN_DIR:project,AVH_TOOL_ROOT:join(TOOLS,'..'),
   AVH_PLAN:JSON.stringify({recolor:{targets:[layer],candidates:3}})};
 execFileSync('python3',[join(TOOLS,'recolor.py')],{env,stdio:'pipe'});
 const first=JSON.parse(readFileSync(recipe,'utf8'));
 assert.equal(first.schema,'recolor-recipe/0.3');
 assert.equal(first.candidates,1,'a plan of fixed colours has nothing to vary');
 assert.deepEqual(first.tiers.map((entry:{id:string})=>entry.id),['A']);
 assert.ok(first.tiers.every((entry:{adjustments:unknown[]})=>entry.adjustments.length===0),
   'a fixed colour must not appear as an adjustable value');
 // The layer path keeps its trailing space: trimming would name a different layer.
 assert.deepEqual(first.layerOps,[{requirement_id:'lash',layered:'Body/PSD/Face_default.psd',layer:['eyelash '],
   color:'#5B5B66',semantics:'flat'}]);
 // With nothing to choose between, feedback is a revision request rather than a tier pick.
 execFileSync('python3',[join(TOOLS,'recolor.py')],{env:{...env,AVH_FEEDBACK:'睫毛再深一点'},stdio:'pipe'});
 assert.match(JSON.parse(readFileSync(recipe,'utf8')).reason,/睫毛再深一点/);
 // Regenerating from the same plan and no feedback must be byte-identical, so reset first: the run
 // above recorded a revision request and that reason legitimately differs.
 execFileSync('python3',[join(TOOLS,'recolor.py')],{env,stdio:'pipe'});
 const before=readFileSync(recipe);
 assert.doesNotMatch(JSON.parse(before.toString('utf8')).reason,/睫毛再深一点/,'a fresh run must not keep the old feedback');
 execFileSync('python3',[join(TOOLS,'recolor.py')],{env,stdio:'pipe'});
 assert.deepEqual(readFileSync(recipe),before,'regenerating without feedback must be byte-identical');
 execFileSync('python3',[join(TOOLS,'observe_recolor.py'),'--out',out],{env,stdio:'pipe'});
 assert.equal(JSON.parse(readFileSync(out,'utf8')).metrics.rerun_recipe_hash_equal,true,
   'the independent replay must accept a recipe made of fixed colour operations');
 // A mixed plan keeps the relative target adjustable and the fixed one untouched.
 execFileSync('python3',[join(TOOLS,'recolor.py')],{env:{...env,AVH_PLAN:JSON.stringify({recolor:{targets:
   [{part:'hair',hue_shift:12,saturation:1,value:1},layer],candidates:3}})},stdio:'pipe'});
 const both=JSON.parse(readFileSync(recipe,'utf8'));
 assert.equal(both.candidates,3);
 assert.ok(both.tiers.every((entry:{adjustments:{part:string}[]})=>entry.adjustments.length===1&&entry.adjustments[0].part==='hair'),
   'only the relative target varies');
 assert.equal(both.layerOps.length,1,'the fixed operation is still carried through');
});

// The observer is reachable on its own — it re-runs the recipe over the stored plan — so it cannot lean on the
// plan gate having validated the target shapes. A target that is not an object used to reach `'material' in t`
// and die with `TypeError: argument of type 'NoneType' is not iterable`: a traceback where the plan gate and
// the recipe entry point both refuse the same input in words the person can act on. The three forms now come
// from that one classifier, so the observer refuses the same shapes for the same reason.
test('the recolor observer refuses a non-object colour target in words, not with a traceback', {skip:!python},t=>{
 const project=mkdtempSync(join(tmpdir(),'avh-recolor-refusal-'));t.after(()=>removeTemp(project));
 const out=join(project,'observation.json');
 const observe=(targets:unknown)=>{
   const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',AVH_PROJECT_DIR:project,AVH_RUN_DIR:project,
     AVH_TOOL_ROOT:join(TOOLS,'..'),AVH_PLAN:JSON.stringify({recolor:{targets,candidates:3}})};
   return spawnSync('python3',[join(TOOLS,'observe_recolor.py'),'--out',out],{env,encoding:'utf8'});
 };
 // Every malformed shape the plan gate refuses must be refused here too, by name, leaving no observation behind.
 for(const [targets,shape] of [[[null],'NoneType'],[[1],'int']] as const){
   const refused=observe(targets);
   assert.notEqual(refused.status,0,`targets ${JSON.stringify(targets)} must not be observed`);
   assert.match(refused.stderr,/每个配色目标都必须是对象/,`${shape} must be named in the refusal`);
   assert.match(refused.stderr,new RegExp(shape),'the refusal names the shape it received');
   assert.doesNotMatch(refused.stderr,/Traceback/,'a refusal is not a crash');
   assert.equal(existsSync(out),false,'a refused plan must not leave an observation behind');
 }
 // Control arms: the refusal is about the target shapes, not about observing a plan at all.
 for(const targets of [[],[{part:'eye',hue_shift:20}]]){
   const accepted=observe(targets);
   assert.equal(accepted.status,0,`targets ${JSON.stringify(targets)} must still be observable`);
   assert.equal(existsSync(out),true);
   rmSync(out,{force:true});
 }
});

test('setup dependency observation exempts only absent vendor controller motions', {skip:!python},t=>{
 const root=mkdtempSync(join(tmpdir(),'avh-vendor-animation-observer-'));t.after(()=>removeTemp(root));
 const project=join(root,'project'), library=join(root,'library');
 const file=(path:string,body:string)=>{mkdirSync(join(project,path,'..'),{recursive:true});writeFileSync(join(project,path),body);};
 const controllerGuid='a'.repeat(32), missingGuid='b'.repeat(32);
 file('Assets/Vendor/KUMALY_FX.controller.meta',`fileFormatVersion: 2\nguid: ${controllerGuid}\n`);
 const controller=(motion:string)=>`%YAML 1.1\n--- !u!110 &11000000\nAnimatorState:\n  m_Name: Idle\n  m_Motion: ${motion}\n`;
 file('Assets/Vendor/KUMALY_FX.controller',controller(`{fileID: 7400000, guid: ${missingGuid}, type: 2}`));
 file('Assets/Body.prefab',`%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Component:\n  - component: {fileID: 2}\n--- !u!95 &2\nAnimator:\n  m_Controller: {fileID: 9100000, guid: ${controllerGuid}, type: 2}\n`);
 const run=(mutate:boolean)=>{
   if(mutate) file('Assets/Vendor/KUMALY_FX.controller',controller(`{fileID: 7400000, guid: ${missingGuid}, type: 2}\n  m_Extra: {fileID: 1, guid: ${missingGuid}, type: 2}`));
   const notes:string[]=[];
   return JSON.parse(execFileSync('python3',['-c',`import json,os,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1]);import observe_assets
os.environ['AVH_PLAN']=json.dumps(json.loads(sys.argv[4]))
metrics=observe_assets.setup_metrics(Path(sys.argv[2]),Path(sys.argv[3]),{},[])
print(json.dumps(metrics))`,TOOLS,project,library,JSON.stringify({body_prefab:'Assets/Body.prefab',outfits:[]})],{encoding:'utf8'}));
 };
 const reminded=run(false); assert.equal(reminded.vendor_missing_animation_references,1); assert.equal(reminded.broken_guid_refs,0);
 const blocked=run(true); assert.equal(blocked.vendor_missing_animation_references,0); assert.equal(blocked.broken_guid_refs,1);
});
