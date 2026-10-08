import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeTemp, windows } from './fixtures/platform.ts';
import { copyTreeExact, packTreeHash, writeModesSidecar } from '../src/pack-hash.ts';

// Names and keys that collate differently by locale: Czech puts "ch" after "h", Chinese orders Han by pinyin,
// and most locales ignore case and punctuation at first.
const NAMES = ['ch.md', 'h.md', 'c.md', 'Zeta.md', 'alpha.md', '_x.md', '汉.md', '字.md', '阿.md'];

test('pack hashes and signed payloads are the same bytes whatever the process locale', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-pack-hash-')); t.after(() => removeTemp(root));
  const pack = join(root, 'pack');
  mkdirSync(join(pack, 'ch'), { recursive: true }); mkdirSync(join(pack, 'h'));
  for (const name of NAMES) { writeFileSync(join(pack, name), name); writeFileSync(join(pack, 'ch', name), name); }
  const script = `import { canonicalJson, packTreeHash } from ${JSON.stringify(new URL('../src/pack-hash.ts', import.meta.url).href)};
    const keys = Object.fromEntries(${JSON.stringify(NAMES)}.map(name => [name, 1]));
    console.log(packTreeHash(${JSON.stringify(pack)}).hash + ' ' + canonicalJson({ nested: keys, ...keys }));`;
  const run = (locale: string) => execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, LC_ALL: locale, LANG: locale }, encoding: 'utf8' }).trim();
  const english = run('en_US.UTF-8');
  for (const locale of ['cs_CZ.UTF-8', 'zh_CN.UTF-8', 'C']) assert.equal(run(locale), english, locale);
});

test('a pack hashes the same on Linux and Windows: Windows uses the modes Linux gives the same tree', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-pack-modes-')); t.after(() => removeTemp(root));
  const pack = join(root, 'pack');
  mkdirSync(join(pack, 'tools'), { recursive: true }); mkdirSync(join(pack, 'knowledge'));
  writeFileSync(join(pack, 'pack.json'), '{"id":"x"}\n');
  writeFileSync(join(pack, 'tools', 'run.py'), 'print(1)\n');
  writeFileSync(join(pack, 'knowledge', 'a.md'), '# a\n');
  // What a signed release carries: directories 0755, files 0644, and 0755 for an executable file. Unpacking on Windows
  // records the executable file beside the tree instead of in its mode.
  writeModesSidecar(pack, ['tools/run.py']);
  const EXPECTED = '24435ec54471392869a674f3aa257b17fb4c29f205c751dd934f173f10693bff';
  assert.equal(packTreeHash(pack, true).hash, EXPECTED, 'the Windows rule');
  if (!windows) {
    for (const dir of [pack, join(pack, 'tools'), join(pack, 'knowledge')]) chmodSync(dir, 0o755);
    for (const file of [join(pack, 'pack.json'), join(pack, 'knowledge', 'a.md')]) chmodSync(file, 0o644);
    chmodSync(join(pack, 'tools', 'run.py'), 0o755);
    assert.equal(packTreeHash(pack, false).hash, EXPECTED, 'the modes Linux reads from the tree');
  }
  // A copy carries the recorded modes with it.
  copyTreeExact(pack, join(root, 'copy'), () => true, true);
  assert.equal(packTreeHash(join(root, 'copy'), true).hash, EXPECTED);
});
