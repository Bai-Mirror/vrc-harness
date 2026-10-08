// The specificity scan is the criterion, not the finding list: what these tests pin down is that an identifier
// only counts inside the generic areas, that an allowance is scoped to a path and a line shape and carries a
// reason, and that the committed configuration is what the repository passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanSpecificity, compileConfig, readConfig, globToRegExp, DEFAULT_CONFIG } from '../tools/specificity-scan.mjs';

const cli = fileURLToPath(new URL('../tools/specificity-scan.mjs', import.meta.url));
const harnessRoot = fileURLToPath(new URL('..', import.meta.url));
const config = () => readConfig(DEFAULT_CONFIG);

/**
 * Make one listed file unreadable to this user and return a function that gives the read back, or null when the
 * host cannot construct the failure (no icacls on Windows, POSIX running as root) — the check below is about the
 * failure path, so it skips rather than asserting a condition it did not set up. The read must be restored before
 * the fixture removes its directory: a deny-read ACE also makes the recursive removal fail.
 */
function denyReading(path) {
  const user = process.env.USERNAME;
  const deny = () => {
    if (process.platform === 'win32') {
      if (!user) return false;
      execFileSync('icacls', [path, '/deny', `${user}:(R)`], { stdio: 'ignore', windowsHide: true });
    } else chmodSync(path, 0o000);
    return true;
  };
  const restore = () => {
    try {
      if (process.platform === 'win32') { if (user) execFileSync('icacls', [path, '/remove:d', user], { stdio: 'ignore', windowsHide: true }); }
      else chmodSync(path, 0o600);
    } catch { /* the fixture removes the directory anyway */ }
  };
  try { if (!deny()) return null; } catch { return null; }
  try { readFileSync(path); restore(); return null; } catch { return restore; }
}


function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'specificity-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(join(dir, path.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(dir, ...path.split('/')), text);
  };
  // Every declared scope needs a file: an empty one is a silent no-op and the scan refuses to give a verdict.
  for (const scope of ['src', 'builtin/tools', 'builtin/knowledge/process']) put(`${scope}/placeholder.txt`, 'example\n');
  return { dir, put };
}

test('an identifier counts in the generic areas and is only reported in knowledge body and tests', t => {
  const { dir, put } = fixture(t);
  put('src/runtime/thing.ts', 'const base = "Milfy";\n');
  put('builtin/tools/harness/helper.py', '# product: GoldenHour\n');
  put('builtin/knowledge/process/flow.yaml', '- {id: a, when: [{path: mem, equals: Kaguya}]}\n');
  put('builtin/knowledge/context/guide.md', '写给 Kaguya 的执行方\n');
  put('builtin/knowledge/bodies/Kaguya.md', '# Kaguya 素体\n\n- **适用条件**：仅该素体\n');
  put('test/thing.test.ts', 'const name = "MMN";\n');
  put('src/logo.png', 'Milfy');
  const report = scanSpecificity(dir, config());
  assert.deepEqual(report.findings.map(finding => [finding.path, finding.line, finding.pattern]),
    [['builtin/knowledge/process/flow.yaml', 1, 'dev-body'], ['builtin/tools/harness/helper.py', 1, 'dev-product'],
      ['src/runtime/thing.ts', 1, 'dev-body']]);
  assert.equal(report.clean, false);
  assert.deepEqual(report.knowledge.map(entry => [entry.path, entry.occurrences, entry.appliesTo.length > 0]),
    [['builtin/knowledge/bodies/Kaguya.md', 1, true], ['builtin/knowledge/context/guide.md', 1, false]]);
  assert.equal(report.coverage.blockingFiles, 6);
  assert.deepEqual(report.coverage.scopes, { src: 2, 'builtin/tools': 2, 'builtin/knowledge/process': 2 });
});

test('a declared scope with nothing to scan refuses to report clean', t => {
  const { dir } = fixture(t);
  rmSync(join(dir, 'builtin/knowledge/process'), { recursive: true, force: true });
  assert.throws(() => scanSpecificity(dir, config()), /builtin\/knowledge\/process/);
  assert.equal(spawnSync(process.execPath, [cli, '--root', dir], { encoding: 'utf8', windowsHide: true }).status, 2);
});

test('a listed file that cannot be read refuses a verdict instead of counting as clean', t => {
  const { dir, put } = fixture(t);
  put('src/readable.ts', 'const name = "example";\n');
  put('src/unreadable.ts', 'const name = "example";\n');
  // A file the scan listed but cannot read is not evidence that it is clean: dropping it would let any repository
  // pass by making one file unreadable, which is the same silent no-op as an empty declared scope.
  const restore = denyReading(join(dir, 'src', 'unreadable.ts'));
  if (!restore) {
    t.skip('this host cannot make a file unreadable to the test user');
    return;
  }
  try {
    assert.throws(() => scanSpecificity(dir, config()), /unreadable\.ts/);
    const run = spawnSync(process.execPath, [cli, '--root', dir], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /未能给出结论/);
    assert.match(run.stderr, /unreadable\.ts/);
  } finally { restore(); }
});

test('an allowance is scoped to a path and a line shape, and must carry a reason', t => {
  const { dir, put } = fixture(t);
  put('src/named.ts', 'const base = "Milfy";\nconst other = "Milfy";\n');
  const scoped = { ...config(), allow: [{ path: 'src/named.ts', pattern: 'dev-body', text: '^const base', reason: '文档字符串里的举例' }] };
  const report = scanSpecificity(dir, scoped);
  assert.deepEqual(report.findings.map(finding => [finding.line, finding.disposition]), [[1, 'allowed'], [2, 'blocking']]);
  assert.equal(report.clean, false);
  assert.equal(report.findings[0].reason, '文档字符串里的举例');
  const elsewhere = { ...config(), allow: [{ ...scoped.allow[0], path: 'src/other.ts' }] };
  assert.equal(scanSpecificity(dir, elsewhere).findings.every(finding => finding.disposition === 'blocking'), true);
  assert.throws(() => compileConfig({ ...config(), allow: [{ path: 'src/named.ts', pattern: 'dev-body' }] }), /缺少理由/);
});

test('an allowance covers one pattern in one file and never leaks to the next occurrence', t => {
  const { dir, put } = fixture(t);
  // The same over-fit written by a different vendor and in a different file stays a finding: the allowance below
  // names one file and one pattern, so nothing about the shape of the first occurrence protects the second.
  put('builtin/tools/one.py', '# GoldenHour\n');
  put('builtin/tools/two.py', '# GoldenHour\n');
  put('builtin/tools/one.py.md', 'Kaguya 05f82bba46c9e1818b31881d39b5e753\n');
  const scoped = { ...config(), allow: [{ path: 'builtin/tools/one.py', pattern: 'dev-product', reason: '注释里引用了触发该判据的商品' }] };
  const report = scanSpecificity(dir, scoped);
  assert.deepEqual(report.findings.map(finding => [finding.path, finding.pattern, finding.disposition]),
    [['builtin/tools/one.py', 'dev-product', 'allowed'],
      ['builtin/tools/one.py.md', 'dev-body', 'blocking'], ['builtin/tools/one.py.md', 'asset-guid', 'blocking'],
      ['builtin/tools/two.py', 'dev-product', 'blocking']]);
  assert.deepEqual(report.unusedAllowances, []);
});

test('the detector answers for the registered identifiers and says so about the rest', t => {
  const { dir, put } = fixture(t);
  // A vendor of the same kind that the development set never used: it is not a finding, because the list is the
  // development set and nothing else. This is the limit of the guarantee, pinned so it is not read as a general
  // "no hard-coded names" check.
  put('src/other.ts', 'const vendor = "FrostHalo";\nconst body = "Body_alt";\n');
  const report = scanSpecificity(dir, config());
  assert.deepEqual(report.findings, []);
  assert.equal(report.clean, true);
});

test('the committed configuration clears the repository it ships with', () => {
  const report = scanSpecificity(harnessRoot, config());
  assert.deepEqual(report.findings.filter(finding => finding.disposition === 'blocking'), []);
  assert.equal(report.clean, true);
  assert.equal(report.summary['asset-guid'], undefined);
  assert.ok(report.coverage.blockingFiles > 200, String(report.coverage.blockingFiles));
  assert.deepEqual(Object.entries(report.coverage.scopes).filter(([, count]) => !count), []);
  assert.deepEqual(report.unusedAllowances, []);
});

test('knowledge findings never fail the run, but say whether the file declares its scope', t => {
  const { dir, put } = fixture(t);
  put('src/clean.ts', 'const name = "example";\n');
  put('builtin/knowledge/cases/scoped.md', '例子用了 Milfy。\n\n- **适用条件**：仅该素体\n');
  put('builtin/knowledge/context/unscoped.md', '例子用了 Milfy。\n');
  const report = scanSpecificity(dir, config());
  assert.equal(report.clean, true);
  assert.deepEqual(report.knowledge.map(entry => [entry.path, entry.appliesTo, entry.markerCount]),
    [['builtin/knowledge/cases/scoped.md', ['适用条件'], 1], ['builtin/knowledge/context/unscoped.md', [], 0]]);
});

test('a knowledge file that states its basis in prose counts as scoped', t => {
  const { dir, put } = fixture(t);
  put('src/clean.ts', 'const name = "example";\n');
  // The knowledge body declares where an example comes from in more than one wording; the marker list is the
  // published criterion for that, so a wording it does not know reports a sourced file as unsourced.
  put('builtin/knowledge/context/calibrated.md', '标定示例（单一案例，一个 Milfy 工程）：…\n');
  put('builtin/knowledge/context/sourced.md', '依据是一个 Kaguya 工程 4 套、一个 Milfy 工程 12 套的建档与编排。\n');
  const report = scanSpecificity(dir, config());
  assert.deepEqual(report.knowledge.map(entry => [entry.path, entry.appliesTo]),
    [['builtin/knowledge/context/calibrated.md', ['标定示例']], ['builtin/knowledge/context/sourced.md', ['依据是']]]);
});

test('an unusable configuration issues no verdict instead of scanning nothing', () => {
  const base = config();
  const bad = [
    { ...base, version: 2 }, { ...base, scopes: [] }, { ...base, scopes: ['/abs'] }, { ...base, scopes: ['../out'] },
    { ...base, extensions: [] }, { ...base, patterns: [] },
    { ...base, patterns: [{ id: 'Bad_Id', description: 'x', regex: 'a' }] },
    { ...base, patterns: [{ id: 'dev-body', description: 'x', regex: 'a' }, { id: 'dev-body', description: 'x', regex: 'b' }] },
    { ...base, patterns: [{ id: 'a-b', regex: 'a' }] },
    { ...base, patterns: [{ id: 'a-b', description: 'x', regex: '' }] },
    { ...base, patterns: [{ id: 'a-b', description: 'x', regex: '.*' }] },
    { ...base, patterns: [{ id: 'a-b', description: 'x', regex: 'a', flags: '' }] },
    { ...base, allow: [{ path: 'src/**', pattern: 'not-a-pattern', reason: '为什么这一处合理' }] },
    { ...base, allow: [{ path: 'src/**', pattern: 'dev-body', reason: '短' }] },
  ];
  for (const entry of bad) assert.throws(() => compileConfig(entry), Error, JSON.stringify(entry.patterns ?? entry.scopes));
});

test('the CLI reports findings as exit 1, refuses a broken configuration as exit 2, and answers clean as 0', t => {
  const { dir, put } = fixture(t);
  put('src/thing.ts', 'const base = "Milfy";\n');
  const run = steps => spawnSync(process.execPath, [cli, '--root', dir, ...steps], { encoding: 'utf8', windowsHide: true });
  const found = run([]);
  assert.equal(found.status, 1);
  assert.match(found.stdout, /未放行/);
  assert.match(found.stdout, /src\/thing\.ts:1/);
  const json = run(['--json']);
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).findings[0].pattern, 'dev-body');
  writeFileSync(join(dir, 'broken.json'), '{');
  const broken = run(['--config', join(dir, 'broken.json')]);
  assert.equal(broken.status, 2);
  assert.equal(broken.stdout, '');
  assert.match(broken.stderr, /未能给出结论/);
  put('src/thing.ts', 'const base = "example";\n');
  assert.equal(run([]).status, 0);
});

test('paths are matched as repository-relative globs including zero directories', () => {
  assert.equal(globToRegExp('src/**').test('src/a/b.ts'), true);
  assert.equal(globToRegExp('src/**').test('gui/a.ts'), false);
  assert.equal(globToRegExp('builtin/tools/**/*.cs').test('builtin/tools/a.cs'), true);
  assert.equal(globToRegExp('builtin/tools/**/*.cs').test('builtin/tools/x/y/a.cs'), true);
  assert.equal(globToRegExp('builtin/tools/**/*.cs').test('builtin/tools/a.py'), false);
  assert.equal(globToRegExp('builtin/knowledge/process/*.yaml').test('builtin/knowledge/process/a.yaml'), true);
  assert.equal(globToRegExp('builtin/knowledge/process/*.yaml').test('builtin/knowledge/process/sub/a.yaml'), false);
});

test('the configuration file is the published list of identifiers', () => {
  const published = JSON.parse(readFileSync(new URL('../tools/specificity-scan.config.json', import.meta.url), 'utf8'));
  assert.equal(published.version, 1);
  assert.deepEqual(published.scopes, ['src', 'builtin/tools', 'builtin/knowledge/process']);
  assert.deepEqual(published.reportOnlyScopes, ['builtin/knowledge/context', 'builtin/knowledge/bodies', 'builtin/knowledge/cases']);
  assert.ok(published.patterns.every(pattern => pattern.description.length > 10));
  assert.ok(published.allow.every(entry => entry.reason.trim().length > 8));
  // Every identifier intake.py carries sits in a comment or docstring line, so its exemptions are line shapes: a
  // whole-file exemption there would also cover any future line that branches on a vendor's naming.
  const intake = published.allow.filter(entry => entry.path === 'builtin/tools/harness/intake.py');
  assert.equal(intake.length, 3);
  assert.ok(intake.every(entry => typeof entry.text === 'string' && entry.text.length));
});
