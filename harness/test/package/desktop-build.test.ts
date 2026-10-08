import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeTemp, windows } from '../fixtures/platform.ts';

// The remap is only observable on bytes a real compiler produced, so this test needs rustc on the host.
// A host without it has a missing prerequisite, not a broken wrapper, and the skip names what is absent.
const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' }).status === 0;

test('desktop release command remaps real rustc source strings and forwards CLI arguments before DEB repair', { skip: !rustc && 'rustc is not installed' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-desktop-build-'));
  t.after(() => removeTemp(root));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'node_modules/@tauri-apps/cli'), { recursive: true });
  for (const file of ['build-desktop.mjs', 'rust-build-env.mjs'])
    copyFileSync(new URL(`../../scripts/${file}`, import.meta.url), join(root, 'scripts', file));
  writeFileSync(join(root, 'node_modules/@tauri-apps/cli/tauri.js'), `
const {spawnSync}=require('node:child_process'),{writeFileSync}=require('node:fs'),{join}=require('node:path');
writeFileSync('args.json',JSON.stringify(process.argv.slice(2)));
const source=join(process.cwd(),'probe.rs');writeFileSync(source,'fn main(){println!("{}",file!());}');
const result=spawnSync('rustc',[source,'-o','probe${windows ? '.exe' : ''}',...process.env.CARGO_ENCODED_RUSTFLAGS.split('\\x1f')],{encoding:'utf8'});
if(result.error)throw result.error;if(result.status!==0){console.error(result.stderr);process.exit(result.status);}
`);
  writeFileSync(join(root, 'scripts/fix-linux-deb.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('deb-fixed','ok');\n");
  const result = spawnSync(process.execPath, [join(root, 'scripts/build-desktop.mjs'), '--verbose', '--bundles', 'deb'],
    { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'args.json'), 'utf8')), ['build', '--verbose', '--bundles', 'deb']);
  assert.equal(readFileSync(join(root, 'deb-fixed'), 'utf8'), 'ok');
  const binary = readFileSync(join(root, `probe${windows ? '.exe' : ''}`));
  assert.equal(binary.includes(Buffer.from(root)), false, 'private source path is absent from actual compiled bytes');
  const unremapped = spawnSync('rustc', [join(root, 'probe.rs'), '-o', join(root, `unremapped${windows ? '.exe' : ''}`)],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(unremapped.status, 0, unremapped.stderr);
  assert.ok(readFileSync(join(root, `unremapped${windows ? '.exe' : ''}`)).includes(Buffer.from(root)),
    'the same real compiler exposes the private source path when remapping is removed');
  const run = spawnSync(join(root, `probe${windows ? '.exe' : ''}`), [], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /^\/harness[\\/]probe.rs/);
});

test('the shipped build command runs the remapping wrapper rather than the Tauri CLI directly', () => {
  // The wrapper only protects a release when something invokes it. The entry point used to call the
  // Tauri CLI directly, so a built release kept the builder's private home path hundreds of times
  // while the test above stayed green: it proved the wrapper works, never that anyone used it.
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts['tauri:build'] ?? '', /scripts[\\/]build-desktop\.mjs/,
    'tauri:build must go through scripts/build-desktop.mjs, or the path remap never applies to a release');
});
