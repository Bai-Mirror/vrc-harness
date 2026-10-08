import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { checkForAppUpdate, verifyAppRelease, type SignedAppRelease } from '../../harness/src/app-release.ts';
import { installKnowledgeRelease, listKnowledgeReleases } from '../../harness/src/knowledge-release.ts';
import { packTreeHash } from '../../harness/src/managed-pack-candidate.ts';
import { installSignedPackRelease, isVerifiedRelease, verifyPackRelease, type SignedPackRelease } from '../../harness/src/managed-pack-update.ts';
import { openDatabase, SCHEMA_VERSION } from '../../harness/src/state/db.ts';
import { buildKnowledgeRelease } from '../src/pack-release.ts';
import { signRelease } from '../src/signing.ts';
import { extractTarGz, readTar } from '../src/tar.ts';
import { builtinPack, keyPair, script, spawnServer, startServer, tempDir } from './helpers.ts';

const trusted = keyPair(), untrusted = keyPair();
const trustedKeys = { 'test-key': trusted.publicPem };

function appRelease(version: string, extra: Partial<SignedAppRelease> = {}, privatePem = trusted.privatePem): SignedAppRelease {
  return signRelease<SignedAppRelease>({ schema: 'harness-app-release/0.1', releaseId: `app-${version}`, version, channel: 'dev',
    issuedAt: '2026-09-28T00:00:00Z', notes: `Harness ${version}`, minimumStateSchema: SCHEMA_VERSION,
    files: [{ platform: 'linux-x64', kind: 'deb', name: `harness_${version}_amd64.deb`, size: 1, sha256: 'a'.repeat(64),
      urls: [`https://harness.test/v1/releases/files/harness_${version}_amd64.deb`] }], keyId: 'test-key', ...extra }, privatePem);
}
function put(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
/** A small pack in a temporary directory (outside any Git work tree). */
function smallPack(root: string): string {
  const pack = join(root, 'small-pack');
  put(join(pack, 'pack.json'), { schema: 'harness-managed-pack/0.1', id: 'x', version: '1.0.0', channel: 'builtin', description: 'small' });
  put(join(pack, 'knowledge', 'process', 'notes.md'), '# notes\n');
  return pack;
}

test('only verified app releases on the channel are listed, newest first, and the client picks the newest', async t => {
  const dataDir = tempDir(t), dev = join(dataDir, 'releases', 'app', 'dev');
  put(join(dev, 'a-dev1.json'), appRelease('0.1.0-dev.1'));
  put(join(dev, 'b-dev4.json'), appRelease('0.1.0-dev.4'));
  put(join(dev, 'c-copy-of-dev1.json'), appRelease('0.1.0-dev.1'));
  put(join(dev, 'd-tampered.json'), { ...appRelease('0.1.0-dev.9'), notes: 'changed after signing' });
  put(join(dev, 'e-unsigned.json'), { ...appRelease('0.1.0-dev.8'), signature: '' });
  put(join(dev, 'f-untrusted.json'), appRelease('0.1.0-dev.7', { releaseId: 'app-untrusted' }, untrusted.privatePem));
  put(join(dev, 'g-other-channel.json'), appRelease('0.1.0-dev.6', { channel: 'stable' }));
  put(join(dev, 'h-broken.json'), '{ not json');
  put(join(dev, 'notes.txt'), 'not a manifest');
  const { url, log } = await startServer(t, { dataDir, trustedKeys });

  const body = await (await fetch(`${url}/v1/releases?channel=dev`)).json() as { releases: SignedAppRelease[] };
  assert.deepEqual(body.releases.map(release => release.version), ['0.1.0-dev.4', '0.1.0-dev.1']);
  for (const release of body.releases) verifyAppRelease(release, trustedKeys);
  const warned = log.entries.filter(entry => entry.level === 'warn').map(entry => String(entry.fields?.file)).sort();
  assert.deepEqual(warned, ['c-copy-of-dev1', 'd-tampered', 'e-unsigned', 'f-untrusted', 'g-other-channel', 'h-broken']
    .map(name => `releases/app/dev/${name}.json`));
  await fetch(`${url}/v1/releases?channel=dev`);
  assert.equal(log.entries.filter(entry => entry.level === 'warn').length, 6, 'each bad file is logged once');

  const update = await checkForAppUpdate('0.1.0-dev.2', { endpoint: `${url}/v1/releases`, trustedKeys, platform: 'linux-x64' });
  assert.equal(update.latest?.version, '0.1.0-dev.4');
  assert.equal(update.rejected, 0, 'nothing unverifiable reaches the client');
  const capabilities = await (await fetch(`${url}/v1/capabilities`)).json();
  const { dataPolicy: policy, ...releaseCapabilities } = capabilities as Record<string, unknown>;
  assert.deepEqual(releaseCapabilities, { contributions: { maxBytes: 67108864, maxFiles: 2000 }, releases: { channels: ['dev'] }, knowledge: { channels: [] } });
  assert.equal((policy as { participation: string }).participation, 'explicit-opt-in');
});

test('a listing needs a valid channel; an unknown one is simply empty', async t => {
  const { url } = await startServer(t, { dataDir: tempDir(t), trustedKeys });
  for (const query of ['', '?channel=', '?channel=..%2Fetc', '?channel=files', '?channel=.hidden'])
    for (const path of ['/v1/releases', '/v1/knowledge/releases']) assert.equal((await fetch(`${url}${path}${query}`)).status, 400, `${path}${query}`);
  assert.deepEqual(await (await fetch(`${url}/v1/releases?channel=nightly`)).json(), { releases: [] });
  assert.deepEqual(await (await fetch(`${url}/v1/knowledge/releases?channel=nightly`)).json(), { releases: [] });
});

test('knowledge releases are listed only when the manifest verifies and the archive is present', async t => {
  const root = tempDir(t), dataDir = join(root, 'data'), pack = smallPack(root);
  const build = (version: string) => buildKnowledgeRelease({ packDir: pack, version, channel: 'dev', keyId: 'test-key',
    privateKeyPem: trusted.privatePem, minimumStateSchema: SCHEMA_VERSION, issuedAt: '2026-09-28T00:00:00Z' });
  const files = join(dataDir, 'releases', 'knowledge', 'files'), dev = join(dataDir, 'releases', 'knowledge', 'dev');
  const good = build('0.1.0-dev.2'), newer = build('0.1.0-dev.4'), orphan = build('0.1.0-dev.5');
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, good.archiveName), good.archive);
  writeFileSync(join(files, newer.archiveName), newer.archive);
  put(join(dev, 'good.json'), good.manifest);
  put(join(dev, 'tampered.json'), { ...newer.manifest, contentHash: 'b'.repeat(64) });
  put(join(dev, 'orphan.json'), orphan.manifest);
  put(join(dev, 'unsigned.json'), { ...newer.manifest, releaseId: 'unsigned', signature: '' });
  const { url, log } = await startServer(t, { dataDir, trustedKeys });

  const body = await (await fetch(`${url}/v1/knowledge/releases?channel=dev`)).json() as { releases: Array<{ manifest: SignedPackRelease;
    archive: { name: string; size: number; sha256: string; url: string } }> };
  assert.equal(body.releases.length, 1);
  const [offer] = body.releases;
  verifyPackRelease(offer!.manifest, trustedKeys, SCHEMA_VERSION);
  assert.deepEqual(offer!.archive, { name: 'vrc-knowledge-0.1.0-dev.2.tar.gz', size: good.archive.length,
    sha256: createHash('sha256').update(good.archive).digest('hex'), url: 'https://harness.test/v1/knowledge/files/vrc-knowledge-0.1.0-dev.2.tar.gz' });
  assert.deepEqual(log.entries.filter(entry => entry.level === 'warn').map(entry => entry.fields?.file).sort(),
    ['orphan', 'tampered', 'unsigned'].map(name => `releases/knowledge/dev/${name}.json`));
});

test('the built-in pack goes through pack-knowledge, the server, and the client download and install', async t => {
  let db: ReturnType<typeof openDatabase> | undefined, otherDb: ReturnType<typeof openDatabase> | undefined;
  t.after(() => { if (db?.isOpen) db.close(); if (otherDb?.isOpen) otherDb.close(); });
  const root = tempDir(t), dataDir = join(root, 'data'), out = join(root, 'out');
  const keyFile = join(root, 'test-key.key'), keysFile = join(root, 'trusted-keys.json');
  writeFileSync(keyFile, trusted.privatePem, { mode: 0o600 });
  writeFileSync(keysFile, JSON.stringify(trustedKeys));
  const summary = JSON.parse(execFileSync(process.execPath, [script('pack-knowledge.mjs'), '--pack', builtinPack, '--version', '0.1.0-dev.2',
    '--channel', 'dev', '--key', keyFile, '--key-id', 'test-key', '--out', out, '--previous', 'builtin-linux-rc5'], { encoding: 'utf8' })) as
    { releaseId: string; packId: string; files: number; fileSource: string; archive: string; manifest: string };
  assert.equal(summary.packId, 'vrc-knowledge-0.1.0-dev.2');
  assert.equal(summary.fileSource, 'git');
  const tracked = execFileSync('git', ['-C', builtinPack, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.equal(summary.files, tracked.length, 'exactly the tracked files are packed');
  const archived = readTar(gunzipSync(readFileSync(summary.archive)));
  assert.ok(!archived.some(entry => entry.path.startsWith('knowledge/SOP')), 'ignored material is never packed');

  mkdirSync(join(dataDir, 'releases', 'knowledge', 'files'), { recursive: true });
  mkdirSync(join(dataDir, 'releases', 'knowledge', 'dev'), { recursive: true });
  copyFileSync(summary.archive, join(dataDir, 'releases', 'knowledge', 'files', `${summary.releaseId}.tar.gz`));
  copyFileSync(summary.manifest, join(dataDir, 'releases', 'knowledge', 'dev', `${summary.releaseId}.json`));
  const { url } = await spawnServer(t, { DATA_DIR: dataDir, TRUSTED_KEYS_FILE: keysFile, PUBLIC_BASE_URL: 'https://harness.test', SERVE_RELEASE_FILES: '1' });
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace('https://harness.test', url), init)) as typeof fetch;

  const { offers, rejected } = await listKnowledgeReleases({ endpoint: 'https://harness.test/v1/knowledge/releases', fetcher, trustedKeys,
    supportedSchema: SCHEMA_VERSION });
  assert.equal(rejected, 0);
  assert.equal(offers.length, 1);
  const home = join(root, 'home'); db = openDatabase(join(root, 'state.db'));
  const installed = await installKnowledgeRelease(db, home, offers[0]!, { fetcher, trustedKeys, supportedSchema: SCHEMA_VERSION });
  assert.equal(installed.id, 'vrc-knowledge-0.1.0-dev.2');
  assert.equal(installed.alreadyInstalled, false);
  const info = JSON.parse(readFileSync(join(installed.root, 'pack.json'), 'utf8'));
  assert.deepEqual(info, { schema: 'harness-managed-pack/0.1', id: 'vrc-knowledge-0.1.0-dev.2', version: '0.1.0-dev.2', channel: 'dev',
    description: JSON.parse(readFileSync(join(builtinPack, 'pack.json'), 'utf8')).description });
  assert.equal(existsSync(join(installed.root, 'knowledge', 'SOP')), false);

  // The same archive through this repository's reader and the client's installSignedPackRelease directly.
  const manifest = JSON.parse(readFileSync(summary.manifest, 'utf8')) as SignedPackRelease, staging = join(root, 'staging');
  extractTarGz(readFileSync(summary.archive), staging);
  assert.equal(packTreeHash(staging).hash, manifest.contentHash);
  otherDb = openDatabase(join(root, 'other.db'));
  installSignedPackRelease(otherDb, join(root, 'other-home'), staging, manifest, trustedKeys, SCHEMA_VERSION);
});

test('an installed release still verifies afterwards under umask 002 and 077', t => {
  const opened: ReturnType<typeof openDatabase>[] = [];
  t.after(() => { for (const db of opened) if (db.isOpen) db.close(); });
  const root = tempDir(t), pack = smallPack(root);
  const release = buildKnowledgeRelease({ packDir: pack, version: '0.1.0-dev.5', channel: 'dev', keyId: 'test-key',
    privateKeyPem: trusted.privatePem, minimumStateSchema: SCHEMA_VERSION });
  for (const mask of [0o002, 0o077]) {
    const staging = join(root, `staging-${mask}`), db = openDatabase(join(root, `state-${mask}.db`));
    opened.push(db);
    const previous = process.umask(mask);
    try {
      extractTarGz(release.archive, staging);
      const installed = installSignedPackRelease(db, join(root, `home-${mask}`), staging, release.manifest, trustedKeys, SCHEMA_VERSION);
      assert.equal(isVerifiedRelease(db, installed.id, installed.root), true, `umask ${mask.toString(8)}`);
    } finally {
      process.umask(previous);
    }
  }
});
