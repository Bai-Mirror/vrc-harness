import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, type Stats, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { checkKnowledgeReleases, extractPackArchive, installKnowledgeRelease, type KnowledgeOffer } from '../src/knowledge-release.ts';
import { managedPacks } from '../src/managed-pack.ts';
import { packTreeHash } from '../src/managed-pack-candidate.ts';
import { isVerifiedRelease, releasePayload, type SignedPackRelease } from '../src/managed-pack-update.ts';
import { openDatabase, SCHEMA_VERSION } from '../src/state/db.ts';
import { removeTemp, windows } from './fixtures/platform.ts';
import { hashedModes } from '../src/pack-hash.ts';

interface Entry { path: string; mode: number; type?: string; body?: Buffer }
/** A minimal ustar writer, independent of the one the server uses. */
function ustar(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), body = entry.body ?? Buffer.alloc(0);
    let name = entry.path, prefix = '';
    if (Buffer.byteLength(name) > 100) { const cut = name.lastIndexOf('/', 155); prefix = name.slice(0, cut); name = name.slice(cut + 1); }
    header.write(name, 0, 100); header.write(`${entry.mode.toString(8).padStart(7, '0')}\0`, 100, 8);
    header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12); header.write('00000000000\0', 136, 12);
    header.write(entry.type ?? '0', 156, 1); header.write('ustar\0', 257, 6); header.write('00', 263, 2); header.write(prefix, 345, 155);
    header.fill(32, 148, 156); let sum = 0; for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function treeEntries(root: string): Entry[] {
  const out: Entry[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), rel = relative(root, path).split(sep).join('/'), info = statSync(path);
      if (info.isDirectory()) { out.push({ path: rel, mode: 0o755, type: '5' }); visit(path); }
      else out.push({ path: rel, mode: info.mode & 0o111 ? 0o755 : 0o644, body: readFileSync(path) });
    }
  };
  visit(root); return out;
}
function normalize(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    chmodSync(path, entry.isDirectory() ? 0o755 : statSync(path).mode & 0o111 ? 0o755 : 0o644);
  }
  chmodSync(root, 0o755);
}

const ENDPOINT = 'https://updates.test/v1/knowledge/releases';
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-knowledge-')); t.after(() => removeTemp(root));
  const home = join(root, 'home'), staging = join(root, 'staging');
  cpSync(new URL('../builtin/', import.meta.url), staging, { recursive: true });
  // A group-writable source tree: the release must still hash the same after unpacking.
  chmodSync(join(staging, 'knowledge'), 0o775);
  const pack = JSON.parse(readFileSync(join(staging, 'pack.json'), 'utf8')) as Record<string, unknown>;
  Object.assign(pack, { id: 'vrc-knowledge-0.1.0-dev.9', version: '0.1.0-dev.9', channel: 'dev' });
  writeFileSync(join(staging, 'pack.json'), JSON.stringify(pack)); normalize(staging);
  const keys = generateKeyPairSync('ed25519'), publicPem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const signed = (fields: Partial<SignedPackRelease>): SignedPackRelease => {
    const unsigned: SignedPackRelease = { schema: 'harness-pack-release/0.1', releaseId: 'knowledge-0.1.0-dev.9', packId: 'vrc-knowledge-0.1.0-dev.9',
      version: '0.1.0-dev.9', contentHash: packTreeHash(staging).hash, issuedAt: '2026-09-28T06:00:00Z', minimumStateSchema: SCHEMA_VERSION,
      previousPackIds: [], keyId: 'test-1', signature: '', ...fields };
    return { ...unsigned, signature: sign(null, releasePayload(unsigned), keys.privateKey).toString('base64') };
  };
  const offer = (archiveBytes: Buffer, fields: Partial<SignedPackRelease> = {}): KnowledgeOffer => ({ manifest: signed(fields),
    archive: { name: 'knowledge.tar.gz', size: archiveBytes.length, sha256: createHash('sha256').update(archiveBytes).digest('hex'),
      url: `https://updates.test/v1/knowledge/files/${fields.releaseId ?? 'knowledge-0.1.0-dev.9'}.tar.gz` } });
  const served = new Map<string, Buffer>();
  const serve = (offers: KnowledgeOffer[], bytes: Buffer[]): typeof fetch => {
    offers.forEach((item, index) => served.set(item.archive.url, bytes[index]!));
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith(ENDPOINT)) return Response.json({ releases: offers });
      const body = served.get(url); return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 });
    }) as typeof fetch;
  };
  const db = openDatabase(join(root, 'state.db')); t.after(() => db.close());
  const archive = gzipSync(ustar(treeEntries(staging)));
  return { root, home, staging, db, archive, offer, serve, trustedKeys: { 'test-1': publicPem } };
}

test('a signed knowledge release installs from its archive and hashes exactly as signed', async t => {
  const f = fixture(t), good = f.offer(f.archive), fetcher = f.serve([good], [f.archive]);
  const options = { endpoint: ENDPOINT, fetcher, trustedKeys: f.trustedKeys, supportedSchema: SCHEMA_VERSION };
  const before = await checkKnowledgeReleases(f.db, f.home, undefined, options);
  assert.deepEqual(before.releases.map(r => [r.releaseId, r.installed, r.newer]), [['knowledge-0.1.0-dev.9', false, true]]);
  const umask = process.umask(0o077);
  let installed;
  try { installed = await installKnowledgeRelease(f.db, f.home, good, options); } finally { process.umask(umask); }
  assert.equal(installed.alreadyInstalled, false);
  assert.equal(packTreeHash(installed.root).hash, good.manifest.contentHash);
  assert.equal(isVerifiedRelease(f.db, installed.id, installed.root), true);
  assert.deepEqual(managedPacks(f.home).map(pack => [pack.id, pack.channel]), [['vrc-knowledge-0.1.0-dev.9', 'dev']]);
  assert.deepEqual(readdirSync(join(f.home, 'managed/staging')), []);
  assert.equal((await checkKnowledgeReleases(f.db, f.home, undefined, options)).releases[0]!.installed, true);
  assert.equal((await installKnowledgeRelease(f.db, f.home, good, options)).alreadyInstalled, true);
});

test('an archive that differs from the release, escapes the pack or carries links is refused and leaves nothing', async t => {
  const f = fixture(t), options = (fetcher: typeof fetch) => ({ fetcher, trustedKeys: f.trustedKeys, supportedSchema: SCHEMA_VERSION });
  const good = f.offer(f.archive);
  // Bytes that are not the announced archive.
  const other = gzipSync(ustar([{ path: 'pack.json', mode: 0o644, body: Buffer.from('{}') }]));
  await assert.rejects(installKnowledgeRelease(f.db, f.home, good, options(f.serve([good], [other]))), /大小|校验值/);
  const cases: Array<[string, Entry[], RegExp]> = [
    ['escape', [...treeEntries(f.staging), { path: '../escaped.txt', mode: 0o644, body: Buffer.from('x') }], /not allowed/],
    ['absolute', [{ path: '/tmp/escaped.txt', mode: 0o644, body: Buffer.from('x') }], /not allowed/],
    ['symlink', [...treeEntries(f.staging), { path: 'knowledge/link', mode: 0o777, type: '2' }], /entry type/],
    ['world-writable', [...treeEntries(f.staging).map(e => e.path === 'pack.json' ? { ...e, mode: 0o666 } : e)], /file mode/],
    // Well-formed, hashed and announced correctly, but not the tree the manifest signed.
    ['tampered', treeEntries(f.staging).map(e => e.path === 'pack.json' ? { ...e, body: Buffer.concat([e.body!, Buffer.from(' ')]) } : e), /content hash mismatch/],
  ];
  for (const [name, entries, expected] of cases) {
    const bytes = gzipSync(ustar(entries)), offer = f.offer(bytes, { releaseId: `knowledge-${name}`, packId: `vrc-knowledge-${name}` });
    await assert.rejects(installKnowledgeRelease(f.db, f.home, offer, options(f.serve([offer], [bytes]))), expected, name);
  }
  assert.equal(existsSync(join(f.root, 'escaped.txt')), false);
  assert.equal(existsSync('/tmp/escaped.txt') && readFileSync('/tmp/escaped.txt', 'utf8') === 'x', false);
  assert.deepEqual(readdirSync(join(f.home, 'managed/staging')), []);
  assert.equal(existsSync(join(f.home, 'managed/packs')) ? readdirSync(join(f.home, 'managed/packs')).length : 0, 0);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM managed_pack_release').get() as { n: number }).n, 0);
});

test('offers that fail verification are never listed or installable', async t => {
  const f = fixture(t), good = f.offer(f.archive);
  const forged = { ...good, manifest: { ...good.manifest, version: '9.9.9' } };
  const plainHttp = { ...f.offer(f.archive, { releaseId: 'knowledge-http', packId: 'vrc-knowledge-http' }) };
  plainHttp.archive = { ...plainHttp.archive, url: 'http://updates.test/k.tar.gz' };
  const fetcher = f.serve([forged, plainHttp, good], [f.archive, f.archive, f.archive]);
  const result = await checkKnowledgeReleases(f.db, f.home, undefined, { endpoint: ENDPOINT, fetcher, trustedKeys: f.trustedKeys, supportedSchema: SCHEMA_VERSION });
  assert.equal(result.rejected, 2);
  assert.deepEqual(result.releases.map(r => r.releaseId), ['knowledge-0.1.0-dev.9']);
  await assert.rejects(installKnowledgeRelease(f.db, f.home, forged, { fetcher, trustedKeys: f.trustedKeys, supportedSchema: SCHEMA_VERSION }), /signature/);
});

test('the extractor applies archived modes exactly and refuses an archive without an end marker', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-untar-')); t.after(() => removeTemp(root));
  const bytes = ustar([{ path: 'tools/run.py', mode: 0o755, body: Buffer.from('print(1)\n') }, { path: 'a/b.md', mode: 0o644, body: Buffer.from('# b\n') }]);
  const umask = process.umask(0o077);
  try { extractPackArchive(bytes, join(root, 'out')); } finally { process.umask(umask); }
  // Windows keeps no modes: the executable one is recorded beside the tree, and the hash reads it from there.
  const mode = windows ? hashedModes(join(root, 'out')) : (_name: string, info: Stats) => info.mode & 0o777;
  assert.equal(mode('tools/run.py', statSync(join(root, 'out/tools/run.py'))), 0o755);
  assert.equal(mode('a/b.md', statSync(join(root, 'out/a/b.md'))), 0o644);
  assert.equal(mode('a', statSync(join(root, 'out/a'))), 0o755);
  assert.throws(() => extractPackArchive(bytes.subarray(0, bytes.length - 1024), join(root, 'cut')), /end marker/);
});
