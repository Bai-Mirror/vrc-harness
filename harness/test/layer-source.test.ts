import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';

const tool = fileURLToPath(new URL('../builtin/tools/harness/layer_source.py', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;
const deps = python && spawnSync('python3', ['-c', 'import psd_tools, numpy']).status === 0;

/**
 * What `doctor` needs before it can report anything: it checks Pillow, NumPy and psd-tools in that order and
 * returns at the first one its interpreter cannot import, so on a host missing one of them the probe test
 * below would fail for the absent dependency rather than for a broken probe. The gap is named instead, so a
 * skipped run says which prerequisite this host lacks, and a host that has all three still runs the test.
 */
function doctorPrerequisite(): string | false {
  if (!python) return 'python3 is not installed';
  const missing = ['PIL', 'numpy', 'psd_tools'].filter(name =>
    spawnSync('python3', ['-c', `import ${name}`]).status !== 0);
  if (missing.length) return `this python3 cannot import ${missing.join(', ')}`;
  // The floor the dependency declares, which is the last gate before the probe would report `ready`.
  return spawnSync('python3', ['-c', 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)']).status === 0
    ? false : 'this python3 is older than the 3.10 floor doctor checks';
}
const doctorSkip = doctorPrerequisite();

// The layer path is the contract that stops "change only this part" from becoming a guess, so the
// rules around it are asserted directly: an exact match, a trailing space that is part of the name,
// and a refusal when the path is ambiguous or absent. The real source file is exercised in
// docs/zh/工作区/证据/分层源区域来源实测.md; what is checked here is the logic a small edit could break.
const script = `import sys
sys.path.insert(0, sys.argv[1])
import layer_source as ls


class Layer:
    def __init__(self, name, children=(), blend='BlendMode.NORMAL', visible=True, kind='pixel', effects=()):
        self.name, self._children, self.blend_mode = name, list(children), blend
        self.visible, self.kind, self.effects, self.bbox = visible, kind, list(effects), (0, 0, 4, 4)

    def __iter__(self):
        return iter(self._children)

    def is_group(self):
        return bool(self._children)


# psd-tools renders the blend mode as an enum, so a plain comparison to 'normal' silently fails and
# every layer in the file looks unsupported.
assert ls.blend_name(Layer('a')) == 'normal', ls.blend_name(Layer('a'))
assert ls.blend_name(Layer('a', blend='BlendMode.MULTIPLY')) == 'multiply'
assert ls.blend_name(Layer('a', blend='BlendMode.LINEAR_DODGE')) == 'linear dodge'

lash = Layer('eyelash ', [Layer('base'), Layer('shadow', blend='BlendMode.MULTIPLY')])
root = Layer('Root', [lash, Layer('Skin', [Layer('eyelash shadow')])])

rows = ls.walk(root)
paths = [row['path'] for row in rows]
# A trailing space belongs to the name: trimming it would silently match a different layer.
assert ['eyelash '] in paths, paths
assert ['eyelash ', 'base'] in paths
assert ['Skin', 'eyelash shadow'] in paths
assert all(isinstance(part, str) for path in paths for part in path)
# The path is an array of names rather than a joined string, so a name containing a slash stays
# unambiguous about where one name ends and the next begins.
assert ls.walk(Layer('Root', [Layer('a/b')]))[0]['path'] == ['a/b']

flagged = ls.unsupported(rows)
reasons = {tuple(entry['layer']): entry['reason'] for entry in flagged}
assert len(flagged) == 1, flagged
assert 'multiply' in reasons[('eyelash ', 'shadow')], reasons
assert not [p for p in reasons if p[-1] == 'base'], 'a normal layer is in range'
assert not [p for p in reasons if p[-1] == 'Skin'], 'a normal group is in range'

# Zero matches and more than one match are both refused: picking either would be a guess.
assert ls.find_layer(root, ['eyelash ', 'base']).name == 'base'
for bad in (['eyelash'], ['Skin', 'eyelash'], ['eyelash  ', 'base'], ['eyelash ', 'base', 'x']):
    try:
        ls.find_layer(root, bad)
    except SystemExit as error:
        assert '0 \\u4e2a' in str(error), (bad, str(error))
    else:
        raise AssertionError('a path with no match was accepted: ' + repr(bad))
duplicate = Layer('Root', [Layer('dup'), Layer('dup')])
try:
    ls.find_layer(duplicate, ['dup'])
except SystemExit as error:
    assert '2 \\u4e2a' in str(error), str(error)
else:
    raise AssertionError('an ambiguous path was accepted')
print('ok')
`;

test('layer source resolves an exact layer path, keeps a trailing space, and refuses ambiguity', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-layer-source-'));
  t.after(() => removeTemp(root));
  const file = join(root, 'check.py');
  writeFileSync(file, script);
  const output = execFileSync('python3', [file, join(tool, '..')], { encoding: 'utf8' });
  assert.match(output, /ok/);
});

// The two colour semantics make different promises, so they are checked against different things: a
// flat fill owes the region one exact colour, while a shading-preserving one owes it the target's hue
// with the author's light and dark intact. Treating either as the other would either pass a region that
// lost its shading or fail one that never promised exactness.
test('the two colour semantics keep the promises they make and neither moves anything else', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-layer-semantics-'));
  t.after(() => removeTemp(root));
  const script = `import sys
import numpy
sys.path.insert(0, sys.argv[1])
import layer_source as ls

# A 2x2 region inside a 4x4 texture, with a soft edge on one pixel, on a blue background so a leak is
# visible rather than plausible.
pixels = numpy.zeros((4, 4, 4), dtype=numpy.uint8)
pixels[:, :, :3] = (10, 20, 200)
pixels[:, :, 3] = 255
region = numpy.zeros((4, 4), dtype=numpy.uint8)
region[1:3, 1:3] = 255
region[1, 3] = 128            # a half-covered edge pixel
# Three lightnesses inside the region, so "the shading survives" is checkable as an order.
pixels[1, 1, :3] = (200, 180, 160)
pixels[1, 2, :3] = (120, 120, 120)
pixels[2, 1, :3] = (60, 40, 20)
pixels[2, 2, :3] = (30, 30, 30)
target = (91, 91, 102)

flat = ls.recolour_pixels(pixels, region, '#5B5B66', 'flat')
assert tuple(flat[1, 1, :3]) == target, tuple(flat[1, 1, :3])
assert tuple(flat[2, 2, :3]) == target, tuple(flat[2, 2, :3])
# Outside the mask nothing moves, including the background and the alpha channel.
outside = region == 0
assert numpy.array_equal(flat[outside], pixels[outside]), 'a flat fill reached outside the region'
assert numpy.array_equal(flat[:, :, 3], pixels[:, :, 3]), 'alpha moved'
# A soft edge is coverage, so it lands between the original and the target rather than on either.
edge = tuple(int(v) for v in flat[1, 3, :3])
assert all(pixels[1, 3, i] > edge[i] > target[i] or pixels[1, 3, i] < edge[i] < target[i] for i in range(3)), edge

shade = ls.recolour_pixels(pixels, region, '#5B5B66', 'shade')
assert tuple(shade[1, 1, :3]) != target, 'a shading-preserving change must not flatten the region'
# The lightest pixel stays the lightest and the darkest stays the darkest: the order survives.
def lightness(row, column):
    return int(shade[row, column, :3].max())
assert lightness(1, 1) > lightness(2, 1) > lightness(2, 2), 'the shading order changed'
assert numpy.array_equal(shade[outside], pixels[outside]), 'shading reached outside the region'
assert numpy.array_equal(shade[:, :, 3], pixels[:, :, 3]), 'alpha moved'
# Both take the target's hue, which is why they can share one region definition at all.
for result in (flat, shade):
    inside = result[region > 0][:, :3]
    assert int(inside[:, 2].mean()) > int(inside[:, 0].mean()), 'the target is a blue grey'
print('ok')
`;
  const file = join(root, 'semantics.py');
  writeFileSync(file, script);
  const output = execFileSync('python3', [file, join(tool, '..')], { encoding: 'utf8' });
  assert.match(output, /ok/);
});

// Two ways a recipe can be wrong in a way that used to pass quietly: a semantics nobody implemented fell
// through to shade and applied a promise the recipe never made, and a region with no covered pixel
// produced an unchanged texture, which looks satisfied while nothing happened. Both must refuse.
test('an unimplemented semantics and an empty region are refused rather than quietly applied', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-layer-refuse-'));
  t.after(() => removeTemp(root));
  const script = `import sys
import numpy
sys.path.insert(0, sys.argv[1])
import layer_source as ls

pixels = numpy.zeros((4, 4, 4), dtype=numpy.uint8)
pixels[:, :, :3] = (10, 20, 200)
pixels[:, :, 3] = 255
region = numpy.zeros((4, 4), dtype=numpy.uint8)
region[1:3, 1:3] = 255

# A semantics the tool does not implement must not silently become one it does.
try:
    ls.recolour_pixels(pixels, region, '#5B5B66', 'tint')
    raise AssertionError('an unimplemented semantics was accepted')
except ValueError as error:
    assert '不支持的改色语义' in str(error), error

# A region with nothing in it cannot fulfil the requirement, and returning the texture unchanged would
# hide that behind a successful-looking run.
empty = numpy.zeros((4, 4), dtype=numpy.uint8)
try:
    ls.recolour_pixels(pixels, empty, '#5B5B66', 'flat')
    raise AssertionError('an empty region was accepted')
except ValueError as error:
    assert '没有像素' in str(error), error

# The same recipe on the same input is the same bytes, which is what lets an observer replay it.
first = ls.recolour_pixels(pixels, region, '#5B5B66', 'shade')
second = ls.recolour_pixels(pixels, region, '#5B5B66', 'shade')
assert numpy.array_equal(first, second), 'the same recipe produced different bytes'
assert numpy.array_equal(ls.recolour_pixels(first, region, '#5B5B66', 'shade'), second), \\
    're-applying did not settle'
print('ok')
`;
  const file = join(root, 'refuse.py');
  writeFileSync(file, script);
  const output = execFileSync('python3', [file, join(tool, '..')], { encoding: 'utf8' });
  assert.match(output, /ok/);
});

// The dependency is a delivery change, so the probe has to do more than report that an import worked:
// a library can import and still lack the calls this tool makes. And when it is genuinely absent the
// answer must be a refusal, because a stage that quietly continues without the capability would
// promise a region nothing can read.
test('the dependency probe exercises the surface it needs and refuses when it is absent', { skip: doctorSkip }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-layer-doctor-'));
  t.after(() => removeTemp(root));
  const check = `import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
sys.meta_path.insert(0, type('Blocker', (), {
    'find_spec': lambda self, name, path=None, target=None: (_ for _ in ()).throw(ImportError('absent'))
        if name == 'psd_tools' or name.startswith('psd_tools.') else None})())
import layer_source


class Args:
    action = 'doctor'
    source = None
    out = sys.argv[2] + '/blocked.json'


code = layer_source.doctor(Args())
report = json.loads(Path(Args.out).read_text())
# A missing dependency must stop the work rather than let it proceed unmeasured.
assert code == 1, code
assert report['ready'] is False, report
assert any(entry['ok'] is False and 'psd-tools' in entry['check'] for entry in report['checks']), report['checks']
print('ok')
`;
  const file = join(root, 'doctor.py');
  writeFileSync(file, check);
  const output = execFileSync('python3', [file, join(tool, '..'), root], { encoding: 'utf8' });
  assert.match(output, /ok/);

  // And on a machine that has it, the probe reports the versions it actually used.
  const healthy = join(root, 'healthy.json');
  const ran = spawnSync('python3', [tool, 'doctor', '--out', healthy], { encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const report = JSON.parse(readFileSync(healthy, 'utf8'));
  assert.equal(report.ready, true);
  assert.match(report.versions['psd-tools'], /^\d+\.\d+/);
  assert.ok(report.checks.every((entry: { ok: boolean | null }) => entry.ok !== false), 'no check may fail here');
  // Opening the file in hand is the only check that proves the version can read this vendor's file,
  // so without one that check is reported as unproven rather than passed.
  assert.equal(report.checks.find((entry: { check: string }) => entry.check.includes('open the source')).ok, null);
});

// resolve is a declared agent tool, and it used to hand the parsed --source list straight to psd_tools,
// so every call crashed before reading a file and the stage went looking for the PSD on disk instead.
// The real action is exercised on a synthetic PSD; the crash is reproduced from the same shipped file.
test('resolve reads exactly one layered source and refuses several', { skip: !deps }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-layer-resolve-'));
  t.after(() => removeTemp(root));
  const psd = join(root, 'source.psd');
  const texture = join(root, 'texture.png');
  const other = join(root, 'other.png');
  const make = `import sys
from psd_tools import PSDImage
from PIL import Image
psd = PSDImage.frompil(Image.new('RGBA', (8, 8), (10, 20, 200, 255)))
psd.save(sys.argv[1])
# The matching candidate is the composite itself; the other is a same-size texture that does not match,
# so accepting several --texture candidates is exercised rather than assumed.
composite = PSDImage.open(sys.argv[1]).composite(force=True).convert('RGBA')
composite.save(sys.argv[2])
Image.new('RGBA', (8, 8), (250, 10, 10, 255)).save(sys.argv[3])
`;
  execFileSync('python3', ['-c', make, psd, texture, other], { stdio: 'pipe' });
  const out = join(root, 'resolve.json');
  const run = (...args: string[]) => spawnSync('python3', [tool, 'resolve', '--out', out, ...args], { encoding: 'utf8' });
  const ran = run('--source', psd, '--texture', other, '--texture', texture);
  assert.equal(ran.status, 0, ran.stderr);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.match, texture, 'the composite match must win over the other candidate');
  assert.equal(report.source, psd);
  assert.match(report.sourceSha256, /^[0-9a-f]{64}$/);

  // Mutation: passing the list again is the shipped defect, and it must still crash on this real call.
  // The anchor starts at resolve's own refusal line, because other actions open a source the same way.
  const mutant = join(root, 'mutant.py');
  const preFix = /(raise SystemExit\('resolve needs at least one --texture candidate'\)\r?\n\s*)psd = PSDImage\.open\(args\.source_one\)/;
  const source = readFileSync(tool, 'utf8');
  assert.ok(preFix.test(source), 'the mutation target must exist in the shipped resolver');
  writeFileSync(mutant, source.replace(preFix, '$1psd = PSDImage.open(args.source)'));
  const crashed = spawnSync('python3', [mutant, 'resolve', '--source', psd, '--texture', texture, '--out', out], { encoding: 'utf8' });
  assert.notEqual(crashed.status, 0, 'the pre-fix resolver must still crash');
  assert.match(crashed.stderr, /'list' object has no attribute 'read'/);

  // Several sources are refused with a message rather than silently getting the first.
  const several = run('--source', psd, '--source', psd, '--texture', texture);
  assert.notEqual(several.status, 0);
  assert.match(several.stderr, /只接受一个 --source/);
});
