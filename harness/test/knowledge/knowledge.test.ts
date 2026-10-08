import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { knowledgeAnnotate, sequencesIndented, sourceIdBytes, sourceIdFile, sourceIdTextLine } from '../../src/knowledge-cli.ts';
import { removeTemp } from '../fixtures/platform.ts';

const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-knowledge-'));
  t.after(() => removeTemp(root));
  const knowledge = join(root, 'knowledge'); const home = join(root, 'home');
  mkdirSync(knowledge); mkdirSync(home);
  function git(...args: string[]) {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  writeFileSync(join(root, 'source.md'), 'first line  \r\nsecond line\t\r\n');
  git('add', 'source.md'); git('commit', '-qm', 'synthetic source');
  const commit = git('rev-parse', 'HEAD');
  const table = join(knowledge, 'thresholds.yaml');
  writeFileSync(table, `schema: thresholds/0.1\nversion: test\nt:\n  max_count: # keep entry comment\n    value: 10 # keep value comment\n    unit: items\n    maturity: accepted\n    source: source.md:1@${commit}\n  missing_line:\n    value: 2\n    unit: items\n    maturity: candidate\n    source: source.md:100@${commit}\n`);
  function run(...args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, AVH_HOME: home } });
  }
  return { root, knowledge, table, home, run, commit };
}

test('knowledge check fails on accepted missing verification and passes after annotation', t => {
  const f = fixture(t);
  const before = f.run('knowledge', 'check', f.knowledge);
  assert.notEqual(before.status, 0);
  assert.match(before.stdout, /t.max_count \(accepted\): verification 为空/);
  assert.match(before.stdout, /kind: spec=2/);
  assert.match(before.stdout, /visibility: local=2/);
  const dry = f.run('knowledge', 'annotate', f.table, '--sop-editorial');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry-run: 可补标 1 条/);
  assert.doesNotMatch(readFileSync(f.table, 'utf8'), /source_id:/);
  const applied = f.run('knowledge', 'annotate', f.table, '--sop-editorial', '--write');
  assert.equal(applied.status, 0, applied.stderr);
  const updated = readFileSync(f.table, 'utf8');
  assert.match(updated, /# keep entry comment/);
  assert.match(updated, /# keep value comment/);
  assert.ok(updated.indexOf('value: 10') < updated.indexOf('unit: items'));
  assert.ok(updated.indexOf('unit: items') < updated.indexOf('maturity: accepted'));
  assert.match(updated, /kind: spec/);
  assert.match(updated, /asserted_by: compile:legacy/);
  const after = f.run('knowledge', 'check', f.knowledge);
  assert.equal(after.status, 0, after.stderr + after.stdout);
  assert.match(after.stdout, /verification.kind: sop-editorial=1/);
});

test('annotate lists unavailable source without guessing and leaves it unchanged', t => {
  const f = fixture(t);
  const original = readFileSync(f.table, 'utf8').replace('maturity: candidate', 'maturity: tested');
  writeFileSync(f.table, original);
  const report = knowledgeAnnotate(f.table, true);
  assert.match(report, /无法补标 1 条/);
  assert.match(report, /t.missing_line/);
  const updated = readFileSync(f.table, 'utf8');
  assert.doesNotMatch(updated.slice(updated.indexOf('missing_line:')), /verification:/);
  assert.match(updated, /# keep value comment/);
});

test('annotate keeps the file sequence style so only added keys appear in the diff', t => {
  const f = fixture(t);
  const flush = `schema: thresholds/0.1\nversion: test\nt:\n  flush_list:\n    value: [1, 2]\n    unit: items\n    maturity: accepted\n    tags:\n    - a\n    - b\n    source: source.md:1@${f.commit}\n`;
  writeFileSync(f.table, flush);
  knowledgeAnnotate(f.table, true);
  const written = readFileSync(f.table, 'utf8');
  assert.match(written, /\n    tags:\n    - a\n    - b\n/);
  const removed = flush.split('\n').filter(line => !written.split('\n').includes(line));
  assert.deepEqual(removed, []);
  assert.equal(sequencesIndented('a:\n  - x\n'), true);
  assert.equal(sequencesIndented('a:\n- x\n'), false);
});

test('annotate lists entries with a missing or malformed source instead of skipping them', t => {
  const f = fixture(t);
  writeFileSync(f.table, `schema: thresholds/0.1\nversion: test\nt:\n  no_source:\n    value: 1\n    unit: items\n    maturity: accepted\n    source: ""\n  range_source:\n    value: 2\n    unit: items\n    maturity: accepted\n    source: source.md:1-2@${f.commit}\n`);
  const report = knowledgeAnnotate(f.table, false);
  assert.match(report, /无法补标 2 条/);
  assert.match(report, /t.range_source: .*不是「路径:行@提交」格式/);
  assert.match(report, /t.no_source: /);
});

test('annotate covers process checks and check reports every unverified accepted check', t => {
  const f = fixture(t);
  const processPath = join(f.knowledge, 'process.yaml');
  const fixtureText = readFileSync(new URL('../fixtures/process.yaml', import.meta.url), 'utf8');
  writeFileSync(processPath, fixtureText.replaceAll('    maturity: accepted\n',
    `    maturity: accepted\n    source: source.md:2@${f.commit}\n`));
  const before = f.run('knowledge', 'check', f.knowledge);
  assert.notEqual(before.status, 0);
  assert.match(before.stdout, /scene_check \(accepted\): verification 为空/);
  assert.match(before.stdout, /违规 5 条/);
  const edited = f.run('knowledge', 'annotate', processPath, '--sop-editorial', '--write');
  assert.equal(edited.status, 0, edited.stderr);
  assert.match(edited.stdout, /可补标 4 条/);
  assert.equal(f.run('knowledge', 'annotate', f.table, '--sop-editorial', '--write').status, 0);
  const after = f.run('knowledge', 'check', f.knowledge);
  assert.equal(after.status, 0, after.stderr + after.stdout);
  assert.match(after.stdout, /verification.kind: sop-editorial=5/);
});

test('annotate reports missing file and commit as unavailable', t => {
  const f = fixture(t);
  const original = readFileSync(f.table, 'utf8');
  const extra = `  missing_file:\n    value: 3\n    unit: items\n    maturity: tested\n    source: absent.md:1@${f.commit}\n` +
    `  missing_commit:\n    value: 4\n    unit: items\n    maturity: tested\n    source: source.md:1@${'f'.repeat(40)}\n`;
  writeFileSync(f.table, original + extra);
  const output = knowledgeAnnotate(f.table);
  assert.match(output, /无法补标 2 条/);
  assert.match(output, /t.missing_file/);
  assert.match(output, /t.missing_commit/);
  assert.equal(readFileSync(f.table, 'utf8'), original + extra);
});

test('source id normalizes line endings and trailing whitespace; binary hashes all bytes', t => {
  const f = fixture(t);
  const expected = createHash('sha256').update('first line').digest('hex').slice(0, 12);
  assert.equal(sourceIdTextLine('first line  \r\n'), expected);
  assert.equal(sourceIdTextLine('first line\n'), expected);
  const result = knowledgeAnnotate(f.table);
  assert.match(result, new RegExp(`source_id=${expected}`));
  const bytes = Buffer.from([0, 13, 10, 255, 32]);
  assert.equal(sourceIdBytes(bytes), createHash('sha256').update(bytes).digest('hex').slice(0, 12));
  assert.equal(sourceIdBytes(bytes), sourceIdBytes(Buffer.from(bytes)));
  const evidence = join(f.root, 'render.bin'); writeFileSync(evidence, bytes);
  assert.equal(sourceIdFile(evidence), sourceIdBytes(bytes));
  assert.equal(sourceIdFile(evidence), sourceIdFile(evidence));
});
