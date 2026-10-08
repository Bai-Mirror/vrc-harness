import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanRepository, compileConfig } from '../tools/privacy-scan.mjs';
import { PRIVACY_PATTERNS } from '../src/shared/privacy-patterns.mjs';

/**
 * The rule list moved out of this tool into `src/shared/privacy-patterns.mjs` so the product's own redaction and the
 * repository scan cannot drift. R28 P2-4 found that the move also *changed* one rule: the order-number cut had been
 * narrowed to stop at Chinese punctuation, which left a name inside `（…）` visible and let a prefix-only
 * `allowedMatches` exemption swallow a longer match. The frozen snapshot below pins the historical behaviour, and the
 * case after it is the exact weakening the review constructed.
 */
const PRE_EXTRACTION_PATTERNS = [
  ['order-id', 'COMM-[0-9a-f]{8}(?:_[^\\s`"<>/\\\\]+)?', 'gi', undefined],
  ['private-user-path', '(?:[a-zA-Z]:[/\\\\]+[uU][sS][eE][rR][sS][/\\\\]+|/home/|/Users/)(?!<|\\$|%)([^/\\\\\\s"\'`<>]+)', 'g', undefined],
  ['booth-session-value', '_plaza_session_[a-z0-9_]*["\']?(?:\\s*[:=\\t]\\s*["\']?([a-z0-9%+/_=.-]{8,})|["\']?\\s*,\\s*["\']value["\']\\s*:\\s*["\']([a-z0-9%+/_=.-]{8,}))', 'gi', ['content', 'metadata']],
  ['api-key-shape', '\\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[a-z0-9_-]{35}|xox[abprs]-[a-z0-9-]{10,})', 'gi', undefined],
  ['token-assignment', '(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie)\\s*["\']?\\s*[:=]\\s*["\'](?:Bearer\\s+)?([a-z0-9%+/_=.-]{16,})', 'gi', undefined],
  ['jwt-shape', 'eyJ[a-z0-9_-]{8,}\\.[a-z0-9_-]{8,}\\.[a-z0-9_-]{8,}', 'gi', undefined],
  ['private-key', '-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----', 'g', undefined],
  ['password-assignment', '(?:password|passwd|client[_-]?secret|secret[_-]?key|auth[_-]?token)\\s*["\']?\\s*[:=]\\s*["\']?([a-z0-9_+/=.-]{20,})', 'gi', undefined],
  ['vrchat-auth', '\\bauthcookie_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'gi', undefined],
  ['credential-file', '(?:^|/)(?:\\.env(?:\\.local|\\.production)?|\\.git-credentials|\\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|booth-session|[^/]+\\.(?:p12|pfx|jks|keystore|ppk))$', 'gi', ['path']],
];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => { const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Example'); git('config', 'user.email', 'example@example.invalid');
  const commit = message => { git('add', '.'); return git('commit', '-m', message); };
  return { dir, git, commit };
}
const config = { version: 1, patterns: [{ id: 'customer-name', literal: 'PRIVATE_CUSTOMER_FIXTURE' }], syntheticUsers: ['example'] };

test('the shared rule list still behaves exactly as the pre-extraction scanner did', async t => {
  assert.deepEqual(PRIVACY_PATTERNS.map(p => [p.id, p.regex, p.flags, p.scopes]),
    PRE_EXTRACTION_PATTERNS.map(([id, regex, flags, scopes]) => [id, regex, flags, scopes ? [...scopes] : undefined]),
    '抽取不得改变任何一条历史规则');
  // The exact weakening R28 found: the old rule swallowed the whole `（…）` name, so a prefix-only allowance could not
  // hide it. The narrowed rule stopped at `（`, which made the prefix equal the allowance and the name slipped through.
  const { dir, git, commit } = fixture(t);
  mkdirSync(join(dir, 'COMM-deadbeef_client（PRIVATE_NAME）'), { recursive: true });
  writeFileSync(join(dir, 'COMM-deadbeef_client（PRIVATE_NAME）', 'report.md'), 'public');
  commit('order directory');
  const scoped = { ...config, allowedMatches: [{ id: 'order-id', value: 'COMM-deadbeef_client' }] };
  const report = await scanRepository(dir, scoped);
  const row = report.rows.find(r => r.id === 'order-id');
  assert.equal(row.headFiles, 1, '前缀精确豁免不能放过更长的一次匹配');
  assert.deepEqual(row.paths, ['[redacted-order-id]/report.md']);
  assert.equal(report.clean, false);
  void git;
});

test('scans all refs, deleted history, metadata, paths, UTF-16 and binary without printing values', async t => {
  const { dir, git, commit } = fixture(t);
  writeFileSync(join(dir, 'old.txt'), 'PRIVATE_CUSTOMER_FIXTURE'); commit('initial');
  git('branch', 'old-worktree'); git('tag', '-a', 'historical', '-m', 'PRIVATE_CUSTOMER_FIXTURE');
  rmSync(join(dir, 'old.txt')); writeFileSync(join(dir, 'safe.txt'), 'public'); commit('current');
  git('switch', '-c', 'other');
  writeFileSync(join(dir, 'PRIVATE_CUSTOMER_FIXTURE.txt'), 'safe');
  writeFileSync(join(dir, 'wide.txt'), Buffer.from('PRIVATE_CUSTOMER_FIXTURE', 'utf16le'));
  const cookie = '_plaza_' + 'session_fixture=' + 'A'.repeat(32);
  writeFileSync(join(dir, 'binary.dat'), Buffer.concat([Buffer.from([0, 1]), Buffer.from(cookie)]));
  commit('PRIVATE_CUSTOMER_FIXTURE'); git('switch', 'main');
  const report = await scanRepository(dir, config);
  assert.equal(report.coverage.commits, 3);
  const customer = report.rows.find(r => r.id === 'customer-name');
  assert.equal(customer.headFiles, 0); assert.equal(customer.historyCommits, 2); assert.equal(customer.blobs, 2); assert.equal(customer.metadataObjects, 2);
  assert.equal(report.rows.find(r => r.id === 'booth-session-value').historyCommits, 1);
  assert.ok(report.locations.some(l => l.path === '[redacted-customer-name].txt'));
  assert.ok(!JSON.stringify(report).includes('PRIVATE_CUSTOMER_FIXTURE'));
  assert.ok(!JSON.stringify(report).includes('A'.repeat(32)));
  assert.equal(report.clean, false);
});

test('public branding is preserved; explicit synthetic users and exact matches are scoped', async t => {
  const { dir, commit } = fixture(t);
  writeFileSync(join(dir, 'safe.txt'), 'nymiro@nymiro.moe harness@nymiro.moe C:\\Users\\example\\work /home/example/work'); commit('public');
  assert.equal((await scanRepository(dir, config)).clean, true);
  writeFileSync(join(dir, 'safe.txt'), 'C:\\Users\\private-person\\work'); commit('private');
  assert.equal((await scanRepository(dir, config)).rows.find(r => r.id === 'private-user-path').headFiles, 1);
});

test('exact detector-syntax allowances preserve real path detection', async t => {
  const { dir, commit } = fixture(t);
  // The rule list lives in the product module (shared with the diagnostics redactor), not in the tool that consumes it.
  const source = readFileSync(new URL('../src/shared/privacy-patterns.mjs', import.meta.url), 'utf8');
  writeFileSync(join(dir, 'detector.mjs'), source); commit('detector source');
  const example = JSON.parse(readFileSync(new URL('../tools/privacy-scan.example.json', import.meta.url), 'utf8'));
  assert.equal((await scanRepository(dir, config)).rows.find(r => r.id === 'private-user-path').headFiles, 1);
  const scoped = { ...config, allowedMatches: example.allowedMatches };
  assert.equal((await scanRepository(dir, scoped)).clean, true);
  writeFileSync(join(dir, 'real.txt'), '/home/private-person/work'); commit('real path');
  const row = (await scanRepository(dir, scoped)).rows.find(r => r.id === 'private-user-path');
  assert.equal(row.headFiles, 1); assert.deepEqual(row.paths, ['real.txt']);
});

test('CLI issues no clean verdict on malformed config and returns findings as exit 1', async t => {
  const { dir, commit } = fixture(t);
  writeFileSync(join(dir, 'secret.txt'), 'PRIVATE_CUSTOMER_FIXTURE'); commit('fixture');
  const cfg = join(dir, 'local.json'), out = join(dir, 'report.json'); writeFileSync(cfg, JSON.stringify(config));
  const cli = fileURLToPath(new URL('../tools/privacy-scan.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--repo', dir, '--config', cfg, '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(JSON.parse(readFileSync(out)).clean, false); assert.ok(!result.stdout.includes('PRIVATE_CUSTOMER_FIXTURE'));
  writeFileSync(cfg, '{');
  const failed = spawnSync(process.execPath, [cli, '--repo', dir, '--config', cfg, '--out', out], { encoding: 'utf8' }); assert.equal(failed.status, 2);
});

test('large binary files and LFS pointers fail closed; small public binary is inspected', async t => {
  const { dir, commit } = fixture(t);
  writeFileSync(join(dir, 'large.bin'), Buffer.alloc(1024));
  writeFileSync(join(dir, 'asset.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + '0'.repeat(64) + '\nsize 100\n'); commit('assets');
  const report = await scanRepository(dir, { ...config, largeBinaryBytes: 100 });
  assert.equal(report.rows.find(r => r.id === 'large-binary').headFiles, 1); assert.equal(report.coverage.lfsPointers.length, 1); assert.equal(report.clean, false);
});

test('invalid patterns fail closed instead of silently skipping a category', () => {
  assert.throws(() => compileConfig({ version: 1, patterns: [{ id: 'bad', regex: '[' }] }));
  assert.throws(() => compileConfig({ version: 1, patterns: [{ id: 'bad', regex: '.*' }] }));
});

test('BOOTH Netscape exports and browser name/value JSON are scanned with the same detector', async t => {
  const { dir, commit } = fixture(t);
  const name = '_plaza_' + 'session_fixture';
  writeFileSync(join(dir, 'netscape.txt'), 'booth.pm\tTRUE\t/\tTRUE\t0\t' + name + '\t' + 'A'.repeat(40));
  writeFileSync(join(dir, 'browser.json'), JSON.stringify({ name, value: 'B'.repeat(40) })); commit('cookies');
  assert.equal((await scanRepository(dir, config)).rows.find(r => r.id === 'booth-session-value').headFiles, 2);
});

test('reviewed opaque image hashes block publication even when their text is not decodable', async t => {
  const { dir, git, commit } = fixture(t);
  writeFileSync(join(dir, 'opaque.png'), Buffer.from([0, 42, 17])); commit('image');
  const oid = git('rev-parse', 'HEAD:opaque.png');
  const report = await scanRepository(dir, { ...config, blockedBlobIds: [oid] });
  assert.equal(report.rows.find(r => r.id === 'private-raster').headFiles, 1); assert.equal(report.clean, false);
});
