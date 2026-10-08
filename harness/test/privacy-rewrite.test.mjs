import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertInside, buildRules, rehearse } from '../tools/privacy-rewrite.mjs';

test('rehearsal rejects the lane root itself, parent paths and malformed replacements', () => {
  assert.throws(() => assertInside('/lane', '/lane'));
  assert.throws(() => assertInside('/lane', '/elsewhere/repo.git'));
  assert.throws(() => buildRules({ patterns: [{ literal: 'fixture', replacement: 'bad\nrule' }] }));
});

test('real filter-repo rehearsal clears all branches, filenames and messages without changing the source', async t => {
  const python = spawnSync('python', ['-m', 'git_filter_repo', '--version'], { windowsHide: true });
  if (python.status !== 0) { t.skip('Install git-filter-repo to run the real rewrite test'); return; }
  const root = mkdtempSync(join(tmpdir(), 'privacy-rewrite-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'); mkdirSync(source);
  const git = (...args) => { const r = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Example'); git('config', 'user.email', 'example@example.invalid');
  writeFileSync(join(source, 'PRIVATE_FIXTURE.txt'), 'PRIVATE_FIXTURE');
  writeFileSync(join(source, 'wide.dat'), Buffer.from('私密', 'utf16le'));
  writeFileSync(join(source, 'opaque.png'), Buffer.from([0, 42, 17]));
  const publicBinary = Buffer.from([0, 1, 255, 19, 34, 70, 81]); writeFileSync(join(source, 'public.bin'), publicBinary);
  mkdirSync(join(source, 'private-images')); writeFileSync(join(source, 'private-images', 'example.png'), Buffer.from([0, 42, 18]));
  git('add', '.'); git('commit', '-m', 'PRIVATE_FIXTURE'); git('branch', 'other');
  git('switch', 'other'); writeFileSync(join(source, 'branch-only.txt'), 'private_fixture'); git('add', '.'); git('commit', '-m', 'branch evidence'); git('switch', 'main');
  writeFileSync(join(source, 'snapshot-only.txt'), 'private_fixture');
  const snapshotBlob = git('hash-object', '-w', 'snapshot-only.txt');
  const madeTree = spawnSync('git', ['-C', source, 'mktree'], { input: '100644 blob ' + snapshotBlob + '\tsnapshot-only.txt\n', encoding: 'utf8' }); assert.equal(madeTree.status, 0);
  git('update-ref', 'refs/codex/snapshot', madeTree.stdout.trim()); git('tag', '-a', 'evidence', '-m', 'private_fixture');
  git('update-ref', 'refs/remotes/origin/old-evidence', git('rev-parse', 'HEAD'));
  const original = git('show-ref');
  const blockedOid = git('rev-parse', 'HEAD:opaque.png');
  const config = join(root, 'local.json'); writeFileSync(config, JSON.stringify({ version: 1, patterns: [{ id: 'customer-name', literal: 'private_fixture', replacement: 'customer' }, { id: 'unicode-name', literal: '私密', replacement: 'customer-wide' }], stripPaths: [], stripGlobs: ['private-images/*.png'], blockedBlobIds: [blockedOid] }));
  const mirror = join(root, 'trial.git');
  const result = await rehearse({ source, mirror, laneRoot: root, configPath: config, ruleDir: join(root, 'rules'), head: 'main' });
  assert.equal(result.clean, true); assert.equal(git('show-ref'), original); assert.equal(readFileSync(join(source, 'PRIVATE_FIXTURE.txt'), 'utf8'), 'PRIVATE_FIXTURE');
  const content = spawnSync('git', ['--git-dir=' + mirror, 'show', 'main:customer.txt'], { encoding: 'utf8' }); assert.equal(content.stdout, 'customer');
  const snapshot = spawnSync('git', ['--git-dir=' + mirror, 'cat-file', '-t', 'refs/codex/snapshot'], { encoding: 'utf8' }); assert.equal(snapshot.stdout.trim(), 'tree');
  const snapshotFile = spawnSync('git', ['--git-dir=' + mirror, 'show', 'refs/codex/snapshot:snapshot-only.txt'], { encoding: 'utf8' }); assert.equal(snapshotFile.stdout, 'customer');
  const branchFile = spawnSync('git', ['--git-dir=' + mirror, 'show', 'other:branch-only.txt'], { encoding: 'utf8' }); assert.equal(branchFile.stdout, 'customer');
  const remoteEvidence = spawnSync('git', ['--git-dir=' + mirror, 'show', 'refs/remotes/origin/old-evidence:customer.txt'], { encoding: 'utf8' }); assert.equal(remoteEvidence.stdout, 'customer');
  for (const path of ['opaque.png', 'private-images/example.png']) assert.notEqual(spawnSync('git', ['--git-dir=' + mirror, 'show', 'main:' + path]).status, 0);
  const wide = spawnSync('git', ['--git-dir=' + mirror, 'show', 'main:wide.dat']); assert.equal(wide.stdout.toString('utf16le'), 'customer-wide');
  assert.deepEqual(spawnSync('git', ['--git-dir=' + mirror, 'show', 'main:public.bin']).stdout, publicBinary);
  assert.notEqual(spawnSync('git', ['--git-dir=' + mirror, 'cat-file', '-e', blockedOid]).status, 0);
  await assert.rejects(rehearse({ source, mirror: join(source, 'accidental.git'), laneRoot: root, configPath: config, ruleDir: join(root, 'rules'), head: 'main' }));
  await assert.rejects(rehearse({ source, mirror, laneRoot: root, configPath: config, ruleDir: join(root, 'rules'), head: 'main' }));
});
