import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { DigestCache, digestFile, nameFinding, scanContext, windowsNameProblem } from '../../src/archive/share-scan.ts';
import { compareMembers, unsafeMembers, type ShareFiles } from '../../src/archive/share-package.ts';
import { parseListing } from '../../src/archive/sevenzip.ts';
import { guidIndex, metaPairs, referenceClosure, unitySkeleton } from '../../src/archive/unity-check.ts';
import { groupOf } from '../../src/archive/share.ts';
import { removeTemp } from '../fixtures/platform.ts';

function scratch(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'avh-scan-'));
  t.after(() => removeTemp(root));
  return root;
}

test('credentials are found by content wherever they are, named by line, and never echoed', t => {
  const root = scratch(t), home = join(root, 'home');
  mkdirSync(join(home, 'config', 'secrets'), { recursive: true });
  writeFileSync(join(home, 'config', 'secrets', 'deepseek-api-key'), 'harness-held-credential-value-42\n');
  writeFileSync(join(home, 'config', 'booth-session'), 'booth-cookie-value-0123456789abcdef');
  const context = scanContext(home, [{ path: join(root, 'project'), label: '' }], 'COMM-a1b2c3d4', false);
  const cases: Array<[string, string, string]> = [
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n', 'private_key', 'secret'],
    [`token = "sk-ant-api03-${'A'.repeat(30)}"`, 'ai_api_key', 'secret'],
    [`ghp_${'a1'.repeat(20)}`, 'github_token', 'secret'],
    ['AKIAABCDEFGHIJKLMNOP', 'aws_access_key', 'secret'],
    [`AIza${'b'.repeat(35)}`, 'google_api_key', 'secret'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'jwt', 'secret'],
    ['Cookie: _plaza_session_nktz7u=0123456789abcdefghijklmn', 'booth_session', 'secret'],
    ['authcookie_01234567-89ab-cdef-0123-456789abcdef', 'vrchat_auth', 'secret'],
    [`${'0123456789abcdef'.repeat(2)}.ABCDEFGHijklmnop`, 'zhipu_api_key', 'secret'],
    ['password: "Tr0ub4dor3xyzTr0ub4dor3"', 'secret_assignment', 'secret'],
    ['我的 key 是 harness-held-credential-value-42', 'harness_secret', 'secret'],
    ['cookie booth-cookie-value-0123456789abcdef', 'harness_secret', 'secret'],
    ['  blueprintId: avtr_00000000-1111-2222-3333-444444444444', 'blueprint_id', 'sensitive'],
    [`path: ${join(root, 'project', 'Assets')}`, 'local_path', 'sensitive'],
    ['export: C:\\Users\\someone\\Desktop\\out', 'local_path', 'sensitive'],
    ['订单 COMM-a1b2c3d4 的备注', 'order_number', 'sensitive'],
  ];
  for (const [text, detector, kind] of cases) {
    const file = join(root, `case-${detector}.txt`);
    writeFileSync(file, `第一行\n${text}\n`);
    const found = digestFile(file, context).findings;
    assert.ok(found.some(item => item.detector === detector && item.kind === kind && item.line === 2), `${detector}: ${JSON.stringify(found)}`);
    assert.ok(!JSON.stringify(found).includes('harness-held') && !JSON.stringify(found).includes('AAAAAAAAAA'), `${detector} is not echoed`);
  }
  // Ordinary Unity text is not a finding: object paths, GUIDs, URLs.
  const unity = join(root, 'Scene.unity');
  writeFileSync(unity, '%YAML 1.1\n  m_Name: /Avatar/Body\n  guid: 0123456789abcdef0123456789abcdef\n  url: https://booth.pm/items/1\n  password_hint: none\n');
  assert.deepEqual(digestFile(unity, context).findings, []);
  // A copy of a Harness configuration file is refused whatever it holds.
  writeFileSync(join(home, 'config', 'harness.yaml'), 'workspaceRoot: /somewhere/else/entirely\n');
  const withConfig = scanContext(home, [], undefined, false);
  const copied = join(root, 'harness-copy.yaml');
  writeFileSync(copied, 'workspaceRoot: /somewhere/else/entirely\n');
  assert.ok(digestFile(copied, withConfig).findings.some(item => item.detector === 'harness_config'));
});

test('a digest reads a file once: hashes, CRC as 7-Zip prints it, text or binary, and a token across a chunk boundary', t => {
  const root = scratch(t);
  const context = scanContext(join(root, 'home'), [], undefined, false);
  const big = join(root, 'big.bin');
  // The key straddles the 1 MiB chunk boundary; binary files are still searched for credentials.
  const key = `sk-ant-api03-${'Z'.repeat(40)}`;
  const buffer = Buffer.alloc(1024 * 1024 + 4096, 0x41);
  buffer[10] = 0;
  buffer.write(` ${key} `, 1024 * 1024 - 20, 'latin1');
  writeFileSync(big, buffer);
  const digest = digestFile(big, context);
  assert.equal(digest.text, false);
  assert.equal(digest.size, buffer.length);
  assert.equal(digest.crc32, (crc32(buffer) >>> 0).toString(16).toUpperCase().padStart(8, '0'));
  assert.deepEqual(digest.findings.map(item => [item.detector, item.line]), [['ai_api_key', null]]);
});

test('the digest cache lets a preview keep its size+mtime shortcut, while evidence reads the content again (DATA/D6)', t => {
  const root = scratch(t), home = join(root, 'home'), project = join(root, 'project');
  mkdirSync(home); mkdirSync(project);
  const context = scanContext(home, []);
  const file = join(project, 'asset.bin');
  // A whole second: restoring it reproduces the key exactly, which is the counter-example's whole point.
  const stamp = new Date(Math.floor(Date.now() / 1000) - 3600);
  const write = (fill: number): void => { writeFileSync(file, Buffer.alloc(4096, fill)); utimesSync(file, stamp, stamp); };
  const key = (path: string): string => { const value = lstatSync(path, { bigint: true }); return `${value.size}:${value.mtimeNs}:${value.ino}`; };
  write(0x61);
  const cache = new DigestCache(home, project, context);
  const first = cache.digest('asset.bin', file); cache.save();
  const before = key(file);
  write(0x62);
  assert.equal(key(file), before, 'the change must leave the size, modification time and file id alone');

  // A preview may stand in the cached digest: that is what the cache is for, and it costs nothing to be wrong here.
  assert.equal(cache.digest('asset.bin', file).sha256, first.sha256, 'the shortcut still stands in for the content');
  // Evidence may not: the content is read, and the disagreement is reported instead of being smoothed over.
  const checked = cache.verified('asset.bin', file);
  assert.equal(checked.digest.sha256, digestFile(file, context).sha256);
  assert.notEqual(checked.digest.sha256, first.sha256);
  assert.equal(checked.stale, true, 'the caller must be able to say the cached value was out of date');
  // Once the content has decided, the entry is current: a second read is not "stale" again, and it is not rewritten.
  assert.deepEqual(cache.verified('asset.bin', file), { digest: checked.digest, stale: false });
  assert.equal(cache.verified('asset.bin', file).stale, false);

  // The control arm: a same-size rewrite whose modification time moves on -- an ordinary edit -- changes the key, so
  // even a preview re-reads. The stamps are set explicitly: two writes may otherwise land in the same timestamp tick
  // and leave the key unchanged, which would make this arm depend on the machine's clock rather than on the cache.
  const touched = join(project, 'touched.bin');
  const moved = new Date(stamp.getTime() - 60_000);
  writeFileSync(touched, Buffer.alloc(4096, 0x61)); utimesSync(touched, moved, moved);
  const touchedCache = new DigestCache(home, 'another-project', context);
  const touchedFirst = touchedCache.digest('touched.bin', touched);
  const touchedKey = key(touched);
  writeFileSync(touched, Buffer.alloc(4096, 0x62)); utimesSync(touched, stamp, stamp);
  assert.notEqual(key(touched), touchedKey, 'the control arm needs the key to have moved');
  const touchedAgain = touchedCache.digest('touched.bin', touched);
  assert.equal(touchedAgain.sha256, digestFile(touched, context).sha256);
  assert.notEqual(touchedAgain.sha256, touchedFirst.sha256);
});

test('file names that are credentials, and names Windows cannot create, are caught by path', () => {
  for (const path of ['.env', 'config/.env.local', 'Keys/id_ed25519', 'Android/user.keystore', 'certs/server.pem', '.git-credentials', 'booth-session'])
    assert.equal(nameFinding(path)?.kind, 'secret', path);
  for (const path of ['Assets/envelope.png', 'Assets/id_rsa.pub', 'Assets/key.prefab']) assert.equal(nameFinding(path), undefined, path);
  for (const path of ['Assets/a:b.png', 'Assets/CON.txt', 'Assets/aux', 'Assets/name.', 'Assets/trailing ']) assert.ok(windowsNameProblem(path), path);
  assert.equal(windowsNameProblem('Assets/中文 名字/贴图 1.png'), undefined);
});

test('7-Zip listings parse on both platforms: separators, folders, links and CRCs', () => {
  const windows = `7-Zip 26.02\n\nListing archive: x.7z\n\n--\nPath = x.7z\nType = 7z\n\n----------\nPath = Assets\\Empty\nSize = 0\nAttributes = D\nCRC = \n\n` +
    `Path = Assets\\中文\\贴图 1.png\nSize = 3\nAttributes = A\nCRC = 83180390\n\n`;
  assert.deepEqual(parseListing(windows, true), [{ path: 'Assets/Empty', directory: true, size: 0, crc: null, link: false },
    { path: 'Assets/中文/贴图 1.png', directory: false, size: 3, crc: '83180390', link: false }]);
  const linux = `----------\nPath = share/manifest.json\nFolder = -\nSize = 2\nAttributes = A_ -rw-r--r--\nCRC = a3a6bf43\n\nPath = Assets/link\nFolder = -\nSize = 7\n` +
    `Attributes = A_ lrwxrwxrwx\nCRC = 00000000\n\nPath = Assets\\odd\nFolder = -\nSize = 1\nAttributes = A_ -rw-r--r--\n\n`;
  const parsed = parseListing(linux, false);
  assert.deepEqual(parsed.map(item => [item.path, item.link, item.crc]), [['share/manifest.json', false, 'A3A6BF43'], ['Assets/link', true, '00000000'], ['Assets\\odd', false, null]]);
  // What a restore refuses before extracting anything.
  const problems = unsafeMembers([...parsed, { path: '../escape.txt', directory: false, size: 1, crc: null, link: false },
    { path: 'C:/abs.txt', directory: false, size: 1, crc: null, link: false }, { path: 'Assets/A.png', directory: false, size: 1, crc: null, link: false },
    { path: 'Assets/a.png', directory: false, size: 1, crc: null, link: false }]);
  assert.deepEqual(problems, ['链接成员：Assets/link', '不安全的成员路径：Assets\\odd', '不安全的成员路径：../escape.txt', '不安全的成员路径：C:/abs.txt',
    '只有大小写不同的成员：Assets/A.png 与 Assets/a.png']);
  const files: ShareFiles = { schema: 'harness-share-files/1', excluded: [], entries: [
    { path: 'a.txt', kind: 'file', layer: 'A', category: 'x', source: { type: 'user', ref: 'r' }, size: 1, sha256: '0'.repeat(64), crc32: 'AAAAAAAA', reason: 'r' }] };
  assert.deepEqual(compareMembers([{ path: 'a.txt', directory: false, size: 1, crc: 'BBBBBBBB', link: false },
    { path: 'b.txt', directory: false, size: 1, crc: null, link: false }], files, []), ['a.txt 的 CRC 与清单不符', '压缩包里有清单之外的 b.txt']);
});

test('Unity checks without Unity: skeleton, .meta pairs and the GUIDs a scene reaches', t => {
  const root = scratch(t);
  const write = (path: string, text: string): void => { mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true }); writeFileSync(join(root, ...path.split('/')), text); };
  write('ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 2022.3.22f1\n');
  write('Assets/Main.unity', `%YAML 1.1\n  m_Prefab: {fileID: 1, guid: ${'1'.repeat(32)}, type: 3}\n  m_Script: {fileID: 1, guid: ${'9'.repeat(32)}, type: 3}\n  m_Font: {guid: 0000000000000000f000000000000000}\n`);
  write('Assets/Main.unity.meta', `guid: ${'3'.repeat(32)}\n`);
  write('Assets/A.prefab', `%YAML 1.1\n  m_Material: {fileID: 1, guid: ${'2'.repeat(32)}, type: 2}\n`);
  write('Assets/A.prefab.meta', `guid: ${'1'.repeat(32)}\n`);
  write('Assets/B.mat.meta', `guid: ${'2'.repeat(32)}\n`);
  write('Assets/Orphan.png', 'png');
  const files = ['ProjectSettings/ProjectVersion.txt', 'Assets/Main.unity', 'Assets/Main.unity.meta', 'Assets/A.prefab', 'Assets/A.prefab.meta', 'Assets/B.mat.meta',
    'Assets/Orphan.png', 'Assets/.hidden', 'Assets/Samples~/x.cs'];
  assert.deepEqual(unitySkeleton(files), { unity: true, missing: ['Packages/manifest.json'] });
  assert.deepEqual(unitySkeleton(['Assets/x']), { unity: false, missing: [] });
  assert.deepEqual(metaPairs(files), { missingMeta: ['Assets/Orphan.png'], orphanMeta: ['Assets/B.mat.meta'] });
  const index = guidIndex(root, files);
  const closure = referenceClosure(root, ['Assets/Main.unity'], index, path => files.includes(path));
  assert.deepEqual(closure.references.map(item => [item.from, item.guid.slice(0, 1), item.to]), [['Assets/A.prefab', '2', 'Assets/B.mat'],
    ['Assets/Main.unity', '1', 'Assets/A.prefab'], ['Assets/Main.unity', '9', null]]);
  assert.equal(closure.visited, 2);
  assert.deepEqual(groupOf('Assets/Paid/Kimono.prefab'), 'Assets/Paid/');
  assert.deepEqual(groupOf('Assets/Paid.meta'), 'Assets/Paid.meta');
});
