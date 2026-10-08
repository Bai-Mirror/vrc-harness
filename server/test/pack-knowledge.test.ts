import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { extractPackArchive } from '../../harness/src/knowledge-release.ts';
import { packTreeHash } from '../../harness/src/managed-pack-candidate.ts';
import { verifyPackRelease, type SignedPackRelease } from '../../harness/src/managed-pack-update.ts';
import { SCHEMA_VERSION } from '../../harness/src/state/db.ts';
import { writeModesSidecar } from '../../harness/src/pack-hash.ts';
import { extractTarGz, writeTar } from '../src/tar.ts';
import { keyPair, script, tempDir } from './helpers.ts';

const keys = keyPair();
const LONG = 'knowledge/a-rather-long-directory-name-for-testing-ustar-prefix-splitting/and-another-long-segment-here-too';

/** Directories 0775 and files 0664 as a umask-002 checkout leaves them, plus the cases the packer must handle. */
function sourcePack(root: string): string {
  const pack = join(root, 'source');
  for (const dir of ['knowledge/process', 'tools/__pycache__', 'empty', LONG]) mkdirSync(join(pack, dir), { recursive: true });
  writeFileSync(join(pack, 'pack.json'), JSON.stringify({ schema: 'harness-managed-pack/0.1', id: 'builtin-x', version: '1.0.0',
    channel: 'builtin', description: 'test pack', bundledFrom: 'old', contentHash: 'stale' }));
  writeFileSync(join(pack, 'knowledge', 'process', '流程.yaml'), 'stages: []\n');
  writeFileSync(join(pack, LONG, 'deeply-nested-knowledge-file-name.md'), '# deep\n');
  writeFileSync(join(pack, 'tools', 'run.sh'), '#!/bin/sh\necho hi\n');
  writeFileSync(join(pack, 'tools', 'private.txt'), 'owner only\n');
  writeFileSync(join(pack, 'tools', '__pycache__', 'x.cpython-314.pyc'), 'bytecode');
  writeFileSync(join(pack, 'tools', 'stray.pyc'), 'bytecode');
  const settle = (dir: string): void => {
    chmodSync(dir, 0o775);
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) settle(join(dir, entry.name)); else chmodSync(join(dir, entry.name), 0o664);
  };
  settle(pack);
  chmodSync(join(pack, 'tools', 'run.sh'), 0o775);
  chmodSync(join(pack, 'tools', 'private.txt'), 0o600);
  if (process.platform === 'win32') writeModesSidecar(pack, ['tools/run.sh']);
  return pack;
}

function packKnowledge(root: string, pack: string, out: string, extra: string[] = []): ReturnType<typeof spawnSync> {
  const keyFile = join(root, 'key.pem');
  writeFileSync(keyFile, keys.privatePem, { mode: 0o600 });
  return spawnSync(process.execPath, [script('pack-knowledge.mjs'), '--pack', pack, '--version', '0.1.0-dev.2', '--channel', 'dev',
    '--key', keyFile, '--key-id', 'test-key', '--out', out, '--issued-at', '2026-09-28T00:00:00Z', ...extra], { encoding: 'utf8' });
}

/** Reads the ustar headers byte by byte, independently of src/tar.ts. */
function headers(archive: Buffer) {
  const tar = gunzipSync(archive), found = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every(byte => byte === 0)) break;
    const field = (start: number, length: number): string => {
      const raw = block.subarray(start, start + length), end = raw.indexOf(0);
      return raw.subarray(0, end < 0 ? length : end).toString('utf8');
    };
    const size = parseInt(field(124, 12), 8), name = field(0, 100), prefix = field(345, 155);
    found.push({ path: prefix ? `${prefix}/${name}` : name, name, prefix, mode: field(100, 8), uid: field(108, 8), gid: field(116, 8), size,
      mtime: field(136, 12), type: field(156, 1), magic: block.toString('latin1', 257, 265), uname: field(265, 32), gname: field(297, 32) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

test('a pack with 0775 directories is normalized, archived deterministically, and unpacks to the signed content hash', t => {
  const root = tempDir(t), pack = sourcePack(root);
  const first = packKnowledge(root, pack, join(root, 'out1'));
  assert.equal(first.status, 0, String(first.stderr));
  const out = join(root, 'out1'), archive = readFileSync(join(out, 'vrc-knowledge-0.1.0-dev.2.tar.gz'));
  const manifest = JSON.parse(readFileSync(join(out, 'vrc-knowledge-0.1.0-dev.2.json'), 'utf8')) as SignedPackRelease;
  verifyPackRelease(manifest, { 'test-key': keys.publicPem }, SCHEMA_VERSION);
  assert.deepEqual({ ...manifest, signature: '', contentHash: '' }, { schema: 'harness-pack-release/0.1', releaseId: 'vrc-knowledge-0.1.0-dev.2',
    packId: 'vrc-knowledge-0.1.0-dev.2', version: '0.1.0-dev.2', contentHash: '', issuedAt: '2026-09-28T00:00:00Z',
    minimumStateSchema: SCHEMA_VERSION, previousPackIds: [], keyId: 'test-key', signature: '' });

  const entries = headers(archive);
  const paths = entries.map(entry => entry.path);
  assert.deepEqual(paths, [...paths].sort((a, b) => Buffer.compare(Buffer.from(a.replace(/\/$/, '')), Buffer.from(b.replace(/\/$/, '')))), 'byte order');
  assert.deepEqual(paths, ['empty/', 'knowledge/', `${LONG.split('/').slice(0, 2).join('/')}/`, `${LONG}/`,
    `${LONG}/deeply-nested-knowledge-file-name.md`, 'knowledge/process/', 'knowledge/process/流程.yaml', 'pack.json', 'tools/',
    'tools/private.txt', 'tools/run.sh']);
  for (const entry of entries) {
    assert.equal(entry.magic, 'ustar\u0000' + '00', entry.path);
    assert.deepEqual([entry.uid, entry.gid, entry.mtime, entry.uname, entry.gname], ['0000000', '0000000', '00000000000', '', ''], entry.path);
    assert.ok(!entry.path.startsWith('./') && !entry.path.startsWith('/'), entry.path);
    assert.equal(entry.type, entry.path.endsWith('/') ? '5' : '0', entry.path);
    assert.equal(entry.mode, entry.path.endsWith('/') || entry.path === 'tools/run.sh' ? '0000755' : '0000644', entry.path);
  }
  assert.ok(entries.find(entry => entry.path.endsWith('deeply-nested-knowledge-file-name.md'))!.prefix, 'a long path uses the prefix field');

  const unpacked = join(root, 'unpacked');
  extractTarGz(archive, unpacked);
  assert.equal(packTreeHash(unpacked).hash, manifest.contentHash);
  assert.notEqual(packTreeHash(pack).hash, manifest.contentHash, 'the source keeps its own modes; only the release is normalized');
  assert.deepEqual(JSON.parse(readFileSync(join(unpacked, 'pack.json'), 'utf8')), { schema: 'harness-managed-pack/0.1',
    id: 'vrc-knowledge-0.1.0-dev.2', version: '0.1.0-dev.2', channel: 'dev', description: 'test pack' });
  assert.equal(statSync(join(unpacked, 'empty')).isDirectory(), true);

  const client = join(root, 'client');
  extractPackArchive(archive, client);
  assert.equal(packTreeHash(client).hash, manifest.contentHash, "the client's own extractor agrees");

  assert.equal(packKnowledge(root, pack, join(root, 'out2')).status, 0);
  assert.deepEqual(readFileSync(join(root, 'out2', 'vrc-knowledge-0.1.0-dev.2.tar.gz')), archive, 'the same pack gives the same bytes');
  assert.equal(readFileSync(join(root, 'out2', 'vrc-knowledge-0.1.0-dev.2.json'), 'utf8'), readFileSync(join(out, 'vrc-knowledge-0.1.0-dev.2.json'), 'utf8'));
  const again = packKnowledge(root, pack, out);
  assert.notEqual(again.status, 0, 'an existing release is never overwritten');
});

test('the pack id, release id and previous packs can be chosen', t => {
  const root = tempDir(t), pack = sourcePack(root), out = join(root, 'out');
  const result = packKnowledge(root, pack, out, ['--pack-id', 'vrc-custom-2', '--release-id', 'knowledge-2026-09', '--previous', 'builtin-linux-rc5',
    '--previous', 'vrc-knowledge-0.1.0-dev.1', '--minimum-state-schema', '20']);
  assert.equal(result.status, 0, String(result.stderr));
  const manifest = JSON.parse(readFileSync(join(out, 'knowledge-2026-09.json'), 'utf8')) as SignedPackRelease;
  assert.deepEqual([manifest.packId, manifest.releaseId, manifest.previousPackIds, manifest.minimumStateSchema],
    ['vrc-custom-2', 'knowledge-2026-09', ['builtin-linux-rc5', 'vrc-knowledge-0.1.0-dev.1'], 20]);
  const prefixed = packKnowledge(root, pack, join(root, 'out-prefix'), ['--id-prefix', 'rules']);
  assert.equal(prefixed.status, 0, String(prefixed.stderr));
  assert.match(String(prefixed.stdout), /"packId": "rules-0\.1\.0-dev\.2"/);
});

test('the packer refuses what the client could not install or unpack', t => {
  const root = tempDir(t);
  const refuse = (name: string, extra: string[], prepare?: (pack: string) => void): void => {
    const pack = sourcePack(join(root, name));
    prepare?.(pack);
    const result = packKnowledge(root, pack, join(root, `out-${name}`), extra);
    assert.notEqual(result.status, 0, name);
    assert.match(String(result.stderr), /pack-knowledge: /, name);
  };
  refuse('builtin-channel', ['--channel', 'builtin']);
  refuse('candidate-channel', ['--channel', 'candidate']);
  refuse('files-channel', ['--channel', 'files']);
  refuse('bad-id', ['--pack-id', 'not a valid id']);
  refuse('bad-previous', ['--previous', 'builtin-linux-rc5+0123456789ab']);
  if (process.platform !== 'win32') refuse('case-twins', [], pack => { writeFileSync(join(pack, 'Readme.md'), 'a'); writeFileSync(join(pack, 'README.md'), 'b'); });
  else t.diagnostic('Case-twin filesystem fixture requires a case-sensitive host; archive path rejection remains tested.');
  refuse('symlink', [], pack => symlinkSync(process.platform === 'win32' ? pack : 'pack.json', join(pack, 'link.json'), process.platform === 'win32' ? 'junction' : 'file'));
  if (process.platform !== 'win32') refuse('windows-name', [], pack => writeFileSync(join(pack, 'knowledge', 'what?.md'), 'x'));
  else t.diagnostic('An illegal Windows filename cannot be created on Windows; malformed archive names remain rejected.');
  refuse('no-pack-json', [], pack => writeFileSync(join(pack, 'pack.json'), '{"schema":"other"}'));
});

test('the archive writer and reader refuse entries outside the format', t => {
  assert.throws(() => writeTar([{ path: '../escape', type: 'file', mode: 0o644, data: Buffer.alloc(0) }]), /not allowed/);
  assert.throws(() => writeTar([{ path: 'x', type: 'file', mode: 0o600, data: Buffer.alloc(0) }]), /not allowed/);
  assert.throws(() => writeTar([{ path: 'd', type: 'dir', mode: 0o644 }]), /not allowed/);
  assert.throws(() => writeTar([{ path: `${'a'.repeat(160)}/${'b'.repeat(101)}`, type: 'file', mode: 0o644, data: Buffer.alloc(0) }]), /does not fit/);
  const root = tempDir(t), good = writeTar([{ path: 'd', type: 'dir', mode: 0o755 }, { path: 'd/f', type: 'file', mode: 0o644, data: Buffer.from('x') }]);
  const gz = (tar: Buffer): Buffer => gzipSync(tar);
  const tampered = Buffer.from(good);
  tampered[600] = 0x41; // inside the second header: its checksum no longer matches
  assert.throws(() => extractTarGz(gz(tampered), join(root, 'a')), /checksum/);
  const symlink = Buffer.from(good);
  symlink[156] = 0x32; // typeflag "2"
  let sum = 0;
  symlink.fill(0x20, 148, 156);
  for (let i = 0; i < 512; i++) sum += symlink[i]!;
  symlink.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  assert.throws(() => extractTarGz(gz(symlink), join(root, 'b')), /type "2" is not allowed/);
});
