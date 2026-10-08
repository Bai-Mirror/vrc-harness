import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTemp } from '../fixtures/platform.ts';
// @ts-expect-error plain JavaScript release check without type declarations
import { releasePrivacyRules, scanText as scan } from '../../scripts/check-release-artifacts.mjs';

interface ScanHit { rule: string; index: number; context: string }
interface ScanReading { hits: ScanHit[]; sentinels: { builder: number; harness: number } }
const scanText = scan as (text: string, rules?: unknown) => ScanReading;
const rules = (home: string) => releasePrivacyRules(home) as unknown;

const script = fileURLToPath(new URL('../../scripts/check-release-artifacts.mjs', import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });

test('the release privacy rules separate a builder path from the remap that replaces it', () => {
  const leak = scanText([
    'C:\\Users\\builder\\Documents\\GitHub\\vrc-harness\\harness\\src\\main.rs',
    'C:/Users/builder/Documents/checkout',
    '/home/builder/work',
    'C:\\Users\\builder\\.cargo\\registry\\src\\index.crates.io-abc\\lib.rs',
  ].join('\n'), rules('C:\\Users\\builder'));
  assert.deepEqual([...new Set(leak.hits.map(hit => hit.rule))].sort(), ['cargo-registry', 'posix-home', 'user-profile']);
  assert.equal(leak.hits.filter(hit => hit.rule === 'cargo-registry').length, 1,
    'a registry path under the builder profile is a leak, not the remap sentinel');
  assert.equal(leak.sentinels.builder, 0, 'a private profile path is not a remap sentinel');
  // A home that the profile rules do not describe (a build account, a service directory) still needs its own rule.
  assert.equal(scanText('/srv/build/harness/scripts', rules('/srv/build')).hits.length, 1);
  assert.equal(scanText('/srv/build/harness/scripts', rules('/srv/build')).hits[0].rule, 'builder-home');
});

test('a remapped release is clean and its sentinels are counted', () => {
  const release = rules('C:\\Users\\builder');
  const clean = scanText([
    'panicked at /builder/.cargo/registry/src/index.crates.io-abc/tauri-2.0.0/src/lib.rs:12',
    '/harness/src-tauri/src/main.rs',
    'C:\\Users\\Public\\Documents',
    'C:\\Users\\Default\\NTUSER.DAT',
    // A shipped dependency's own documentation, not a build machine: a check that failed on this would fail always.
    '// file:///home/user/file.js',
    '// /home/example/project',
  ].join('\n'), release);
  assert.deepEqual(clean.hits, []);
  assert.deepEqual(clean.sentinels, { builder: 1, harness: 1 });
  // An account a build agent really runs as is still a leak, placeholders or not.
  assert.equal(scanText('/home/runner/work/harness', release).hits[0]?.rule, 'posix-home');
});

test('a release containing the builder paths fails the check and names the file and rule', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-release-scan-'));
  t.after(() => removeTemp(root));
  const clean = join(root, 'clean.bin'), leak = join(root, 'leak.bin');
  writeFileSync(clean, 'build root /harness and /builder/.cargo/registry/src/index.crates.io-abc/tauri/src/lib.rs\0');
  writeFileSync(leak, Buffer.concat([Buffer.from([0x00, 0x7f, 0x00]), Buffer.from('C:\\Users\\builder\\.cargo\\registry\\src\\lib.rs')]));
  const failed = run(['--quiet', clean, leak]);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /leak\.bin: user-profile @\d+: /);
  assert.match(failed.stderr, /\.cargo\\registry\\src\\lib\.rs/);
  assert.doesNotMatch(failed.stderr, /clean\.bin/);
  const passed = run(['--quiet', clean]);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /重映射哨兵 \/builder 共 1 处/);
  // An installed tree is a directory: the entry point has to walk it, not try to read it as a file.
  const tree = run(['--quiet', root]);
  assert.equal(tree.status, 1, tree.stdout + tree.stderr);
  assert.match(tree.stderr, /leak\.bin: user-profile/);
});
