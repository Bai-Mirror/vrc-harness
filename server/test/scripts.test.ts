import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { checkForAppUpdate, verifyAppRelease, type SignedAppRelease } from '../../harness/src/app-release.ts';
import { verifyPackRelease, type SignedPackRelease } from '../../harness/src/managed-pack-update.ts';
import { RECORD_SCHEMA, SHARING_NOTICE_VERSION } from '../../harness/src/shared/sharing.ts';
import { SCHEMA_VERSION } from '../../harness/src/state/db.ts';
import { loadTrustedKeys } from '../src/keys.ts';
import { createInstallation, currentInstallation, installationStatus, linkContribution, prepareSharingDirs, revokeInstallation,
  storeRecords, today } from '../src/sharing.ts';
import { signRelease } from '../src/signing.ts';
import { keyPair, script, serverRoot, startServer, tempDir } from './helpers.ts';

const run = (name: string, args: string[]) => spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8' });

test('keygen writes a usable key pair outside Git, never inside a work tree, and never over an existing key', t => {
  const inside = join(serverRoot, 'test', 'keys-must-not-be-written-here');
  const refused = run('keygen.mjs', [inside, 'dev-9']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Git work tree/);
  assert.equal(existsSync(inside), false);

  const dir = join(tempDir(t), 'keys'), made = run('keygen.mjs', [dir, 'dev-9']);
  assert.equal(made.status, 0, made.stderr);
  if (process.platform === 'win32') {
    const windowsEnv: NodeJS.ProcessEnv = { ...process.env, HARNESS_TEST_SIGNING_DIR: dir }; delete windowsEnv.PSModulePath;
    const acl = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference = 'Stop'
      $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      foreach ($path in @($env:HARNESS_TEST_SIGNING_DIR, (Join-Path $env:HARNESS_TEST_SIGNING_DIR 'dev-9.key'))) {
        $acl = Get-Acl -LiteralPath $path
        $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
        if (@($rules).Count -eq 0) { throw 'no private access rule' }
        foreach ($rule in $rules) { if ($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne 'Allow') { throw 'foreign signing-key access' } }
      }
    `], { env: windowsEnv, encoding: 'utf8', windowsHide: true });
    assert.equal(acl.status, 0, acl.stderr);
  } else {
    assert.equal(statSync(join(dir, 'dev-9.key')).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  }
  const privateKey = createPrivateKey(readFileSync(join(dir, 'dev-9.key'))), publicKey = createPublicKey(readFileSync(join(dir, 'dev-9.pub')));
  assert.equal(privateKey.asymmetricKeyType, 'ed25519');
  assert.ok(verify(null, Buffer.from('m'), publicKey, sign(null, Buffer.from('m'), privateKey)));
  assert.equal((JSON.parse(made.stdout) as { trustedKeys: Record<string, string> }).trustedKeys['dev-9'], readFileSync(join(dir, 'dev-9.pub'), 'utf8'));
  assert.equal(run('keygen.mjs', [dir, 'dev-9']).status, 2);
  assert.equal(run('keygen.mjs', [dir, 'bad id']).status, 2);
});

test('sign-release signs both manifest schemas so that the client verifies them', t => {
  const root = tempDir(t), keys = keyPair(), keyFile = join(root, 'k.key');
  writeFileSync(keyFile, keys.privatePem, { mode: 0o600 });
  const trusted = { 'test-key': keys.publicPem };
  const pack = { schema: 'harness-pack-release/0.1', releaseId: 'r1', packId: 'vrc-knowledge-1.0.0', version: '1.0.0', contentHash: 'c'.repeat(64),
    issuedAt: '2026-09-28T00:00:00Z', minimumStateSchema: SCHEMA_VERSION, previousPackIds: [], keyId: 'test-key' };
  const app = { schema: 'harness-app-release/0.1', releaseId: 'app-1.0.0', version: '1.0.0', channel: 'dev', issuedAt: '2026-09-28T00:00:00Z',
    notes: '', minimumStateSchema: SCHEMA_VERSION, keyId: 'test-key', signature: 'stale',
    files: [{ platform: 'linux-x64', kind: 'deb', name: 'a.deb', size: 1, sha256: 'd'.repeat(64), urls: ['https://harness.test/a.deb'] }] };
  for (const [name, manifest] of [['pack', pack], ['app', app]] as const) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(manifest));
    const result = run('sign-release.mjs', ['--key', keyFile, '--in', join(root, `${name}.json`), '--out', join(root, `${name}.signed.json`)]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(run('sign-release.mjs', ['--key', keyFile, '--in', join(root, `${name}.json`), '--out', join(root, `${name}.signed.json`)]).status, 2,
      'an existing output is never overwritten');
  }
  const signedPack = JSON.parse(readFileSync(join(root, 'pack.signed.json'), 'utf8')) as SignedPackRelease;
  const signedApp = JSON.parse(readFileSync(join(root, 'app.signed.json'), 'utf8')) as SignedAppRelease;
  verifyPackRelease(signedPack, trusted, SCHEMA_VERSION);
  verifyAppRelease(signedApp, trusted);
  assert.throws(() => verifyAppRelease({ ...signedApp, notes: 'changed' }, trusted), /signature verification failed/);

  writeFileSync(join(root, 'nokey.json'), JSON.stringify({ ...pack, keyId: undefined }));
  assert.equal(run('sign-release.mjs', ['--key', keyFile, '--in', join(root, 'nokey.json'), '--out', join(root, 'x.json')]).status, 2);
  writeFileSync(join(root, 'other.json'), JSON.stringify({ ...pack, schema: 'something-else/1' }));
  assert.equal(run('sign-release.mjs', ['--key', keyFile, '--in', join(root, 'other.json'), '--out', join(root, 'y.json')]).status, 2);
  writeFileSync(join(root, 'bad.json'), JSON.stringify({ ...app, version: 'not-a-version' }));
  assert.equal(run('sign-release.mjs', ['--key', keyFile, '--in', join(root, 'bad.json'), '--out', join(root, 'z.json')]).status, 2,
    'what the client would reject is not written');
  assert.equal(existsSync(join(root, 'z.json')), false);
});

test('app-release describes the installers, signs, and the client offers the update', async t => {
  const root = tempDir(t), keys = keyPair(), keyFile = join(root, 'k.key'), installer = join(root, 'avatar-harness_0.1.0-dev.1_amd64.deb');
  writeFileSync(keyFile, keys.privatePem, { mode: 0o600 });
  writeFileSync(installer, Buffer.from('pretend this is a Debian package'));
  writeFileSync(join(root, 'notes.md'), 'First dev build.\n');
  const out = join(root, 'dataDir', 'releases', 'app', 'dev');
  mkdirSync(out, { recursive: true });
  const made = run('app-release.mjs', ['--version', '0.1.0-dev.1', '--channel', 'dev', '--key', keyFile, '--key-id', 'test-key',
    '--notes-file', join(root, 'notes.md'), '--file', `linux-x64:deb:${installer}`, '--out', join(out, 'app-0.1.0-dev.1.json')]);
  assert.equal(made.status, 0, made.stderr);
  const release = JSON.parse(readFileSync(join(out, 'app-0.1.0-dev.1.json'), 'utf8')) as SignedAppRelease;
  verifyAppRelease(release, { 'test-key': keys.publicPem });
  assert.deepEqual([release.releaseId, release.notes, release.minimumStateSchema], ['app-0.1.0-dev.1', 'First dev build.\n', SCHEMA_VERSION]);
  assert.deepEqual(release.files, [{ platform: 'linux-x64', kind: 'deb', name: 'avatar-harness_0.1.0-dev.1_amd64.deb',
    size: statSync(installer).size, sha256: createHash('sha256').update(readFileSync(installer)).digest('hex'),
    urls: ['https://harness.nymiro.moe/v1/releases/files/avatar-harness_0.1.0-dev.1_amd64.deb'] }]);

  const { url } = await startServer(t, { dataDir: join(root, 'dataDir'), trustedKeys: { 'test-key': keys.publicPem } });
  const update = await checkForAppUpdate('0.1.0-dev.0', { endpoint: `${url}/v1/releases`, trustedKeys: { 'test-key': keys.publicPem }, platform: 'linux-x64' });
  assert.equal(update.latest?.version, '0.1.0-dev.1');
  assert.equal(update.latest?.files[0]?.sha256, release.files[0]?.sha256);

  assert.equal(run('app-release.mjs', ['--version', '0.1.0-dev.2', '--channel', 'dev', '--key', keyFile, '--key-id', 'test-key',
    '--file', `linux-x64:deb:${installer}`, '--base-url', 'http://insecure.example/', '--out', join(root, 'x.json')]).status, 2);
  writeFileSync(join(root, 'bad name.deb'), 'x');
  assert.equal(run('app-release.mjs', ['--version', '0.1.0-dev.2', '--channel', 'dev', '--key', keyFile, '--key-id', 'test-key',
    '--file', `linux-x64:deb:${join(root, 'bad name.deb')}`, '--out', join(root, 'y.json')]).status, 2);
});

test('app-release --verify-urls refuses to sign a manifest whose download URL is not there', t => {
  const root = tempDir(t), keys = keyPair(), keyFile = join(root, 'k.key');
  const installer = join(root, 'Harness_0.1.0-dev.1_x64-setup.exe');
  writeFileSync(keyFile, keys.privatePem, { mode: 0o600 });
  writeFileSync(installer, Buffer.from('pretend this is an NSIS installer'));
  const out = join(root, 'app-verified.json'), url = 'https://127.0.0.1:1/Harness_0.1.0-dev.1_x64-setup.exe';
  const args = ['--version', '0.1.0-dev.1', '--channel', 'dev', '--key', keyFile, '--key-id', 'test-key',
    '--file', `win32-x64:nsis:${installer}`, '--base-url', 'https://127.0.0.1:1/', '--out', out];
  // Nothing listens on port 1, so the HEAD cannot reach a server: the gate has to refuse before it signs.
  const refused = run('app-release.mjs', [...args, '--verify-urls']);
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the reading names the URL it would write');
  assert.match(refused.stderr, /先放文件、后放清单/);
  assert.equal(existsSync(out), false, 'a URL that does not resolve signs nothing');
  // Without the flag the same inputs sign, so the refusal above is the flag's doing and not an unrelated failure.
  const signed = run('app-release.mjs', args);
  assert.equal(signed.status, 0, signed.stderr);
  assert.deepEqual((JSON.parse(readFileSync(out, 'utf8')) as SignedAppRelease).files[0]?.urls, [url]);
});

test('trusted-keys builds the file the server loads, and refuses private or conflicting keys', t => {
  const root = tempDir(t), first = keyPair(), second = keyPair(), out = join(root, 'trusted-keys.json');
  writeFileSync(join(root, 'a.pub'), first.publicPem);
  writeFileSync(join(root, 'b.pub'), second.publicPem);
  writeFileSync(join(root, 'a.key'), first.privatePem);
  assert.equal(run('trusted-keys.mjs', ['--out', out, `harness-dev-1=${join(root, 'a.pub')}`]).status, 0);
  assert.equal(run('trusted-keys.mjs', ['--out', out, `harness-stable-1=${join(root, 'b.pub')}`]).status, 0);
  assert.deepEqual(loadTrustedKeys(out), { 'harness-dev-1': first.publicPem, 'harness-stable-1': second.publicPem });
  const privateRefused = run('trusted-keys.mjs', ['--out', out, `x=${join(root, 'a.key')}`]);
  assert.equal(privateRefused.status, 2);
  assert.match(privateRefused.stderr, /private key/);
  assert.equal(run('trusted-keys.mjs', ['--out', out, `harness-dev-1=${join(root, 'b.pub')}`]).status, 2);
  writeFileSync(join(root, 'with-private.json'), JSON.stringify({ x: first.privatePem }));
  assert.throws(() => loadTrustedKeys(join(root, 'with-private.json')), /private key/);
});

test('accept.mjs marks what a published release accepted, and revocation then keeps it', t => {
  const root = tempDir(t), dataDir = join(root, 'data'), keys = keyPair();
  const keyFile = join(root, 'k.key'), trustedKeys = join(root, 'trusted-keys.json');
  writeFileSync(keyFile, keys.privatePem, { mode: 0o600 });
  writeFileSync(trustedKeys, JSON.stringify({ 'test-key': keys.publicPem }));
  prepareSharingDirs(dataDir);
  const day = new Date('2026-01-01T00:00:00Z');
  const installation = createInstallation(dataDir, day), stored = currentInstallation(dataDir, installation.installId)!;

  // What the intake route leaves behind: a contribution bundle with its meta and installation marker, and a record batch.
  const receiptId = 'a'.repeat(32), batchId = 'b'.repeat(32);
  mkdirSync(join(dataDir, 'contributions', receiptId), { recursive: true });
  writeFileSync(join(dataDir, 'contributions', receiptId, 'meta.json'), JSON.stringify({ schema: 'harness-contribution-meta/0.1',
    receiptId, candidateId: 'c'.repeat(32), installId: installation.installId, receivedAt: `${today(day)}T00:00:00.000Z` }));
  linkContribution(dataDir, installation.installId, receiptId);
  storeRecords(dataDir, stored, { schema: RECORD_SCHEMA, batchId, notice: SHARING_NOTICE_VERSION,
    records: [{ id: '1'.repeat(32), category: 'tool-reliability', action: 'provider-run', outcome: 'success' }] }, day);

  // The published, signed release the operator accepts the items into.
  const release = signRelease<SignedPackRelease>({ schema: 'harness-pack-release/0.1', releaseId: 'vrc-knowledge-1.0.0',
    packId: 'vrc-knowledge', version: '1.0.0', contentHash: 'd'.repeat(64), issuedAt: '2026-01-01T00:00:00Z',
    minimumStateSchema: SCHEMA_VERSION, previousPackIds: [], keyId: 'test-key' }, keys.privatePem);
  mkdirSync(join(dataDir, 'releases', 'knowledge', 'stable'), { recursive: true });
  writeFileSync(join(dataDir, 'releases', 'knowledge', 'stable', 'pack-1.0.0.json'), JSON.stringify(release));

  // Until the operator runs it nothing is accepted, and an unknown release or item is refused rather than invented.
  const before = installationStatus(dataDir, stored, 90);
  assert.deepEqual([before.contributions.map(item => item.state), before.records.map(item => item.state)], [['stored'], ['stored']]);
  assert.equal(run('accept.mjs', ['--data-dir', dataDir, '--trusted-keys', trustedKeys, '--release', 'vrc-knowledge-9.9.9',
    '--contribution', receiptId]).status, 2, 'a release with no verifying manifest is refused');
  assert.equal(run('accept.mjs', ['--data-dir', dataDir, '--trusted-keys', trustedKeys, '--release', release.releaseId,
    '--contribution', 'e'.repeat(32)]).status, 2, 'an item the server does not hold is refused');

  const accepted = run('accept.mjs', ['--data-dir', dataDir, '--trusted-keys', trustedKeys, '--release', release.releaseId,
    '--contribution', receiptId, '--records', `${installation.installId}.${batchId}`]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), { release: release.releaseId,
    accepted: [{ kind: 'contribution', id: receiptId }, { kind: 'records', id: `${installation.installId}.${batchId}` }],
    markers: [join(dataDir, 'accepted', 'contribution', `${receiptId}.json`),
      join(dataDir, 'accepted', 'records', `${installation.installId}.${batchId}.json`)] });

  // The status the installation itself reads now names the release, which is the server half of the DATA/D8 chain.
  const status = installationStatus(dataDir, stored, 90);
  assert.deepEqual([status.contributions.map(item => [item.receiptId, item.state, item.releaseId]),
    status.records.map(item => [item.batchId, item.state, item.releaseId])],
  [[[receiptId, 'accepted', release.releaseId]], [[batchId, 'accepted', release.releaseId]]]);

  // Revocation deletes what is not accepted and lists the rest as retained: it cannot unpublish a release.
  const revoked = revokeInstallation(dataDir, stored, day);
  assert.deepEqual(revoked.removed, { recordBatches: 0, records: 0, contributions: [] });
  assert.deepEqual(revoked.retained, [{ kind: 'records', id: batchId, releaseId: release.releaseId },
    { kind: 'contribution', id: receiptId, releaseId: release.releaseId }]);
  assert.equal(existsSync(join(dataDir, 'contributions', receiptId)), true, 'what a release accepted survives revocation');
});
