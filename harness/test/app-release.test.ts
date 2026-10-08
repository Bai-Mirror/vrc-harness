import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { checkForAppUpdate, compareVersions, verifyAppRelease, type SignedAppRelease } from '../src/app-release.ts';
import { releasePayload, type SignedPackRelease } from '../src/managed-pack-update.ts';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keys = { 'test-key': publicKey.export({ type: 'spki', format: 'pem' }).toString() };
function release(version: string, extra: Partial<SignedAppRelease> = {}): SignedAppRelease {
  const unsigned = { schema: 'harness-app-release/0.1' as const, releaseId: `app-${version}`, version, channel: 'dev',
    issuedAt: '2026-09-28T00:00:00Z', notes: `Harness ${version}`, minimumStateSchema: 21,
    files: [{ platform: 'linux-x64', kind: 'deb', name: `harness_${version}_amd64.deb`, size: 1, sha256: 'a'.repeat(64),
      urls: ['https://example.invalid/harness.deb'] }, { platform: 'win32-x64', kind: 'msi', name: 'harness.msi', size: 1,
      sha256: 'b'.repeat(64), urls: ['https://example.invalid/harness.msi'] }], keyId: 'test-key', signature: '', ...extra };
  const signature = sign(null, releasePayload(unsigned as unknown as SignedPackRelease), privateKey).toString('base64');
  return { ...unsigned, signature };
}

test('a signed app release verifies, and any change to it or an unknown key does not', () => {
  const good = release('0.1.0-dev.2');
  verifyAppRelease(good, keys);
  assert.throws(() => verifyAppRelease({ ...good, notes: 'changed after signing' }, keys), /signature verification failed/);
  assert.throws(() => verifyAppRelease(good, {}), /untrusted release signing key/);
  assert.throws(() => verifyAppRelease({ ...good, files: [{ ...good.files[0]!, urls: ['http://insecure'] }] }, keys), /invalid release files/);
});

test('versions order numerically, and a prerelease comes before its release', () => {
  const sorted = ['0.1.0', '0.1.0-dev.10', '0.2.0-dev.1', '0.1.0-dev.2', '0.1.0-rc.1'].sort(compareVersions);
  assert.deepEqual(sorted, ['0.1.0-dev.2', '0.1.0-dev.10', '0.1.0-rc.1', '0.1.0', '0.2.0-dev.1']);
});

test('an update check offers only the newest verified release on the channel, with the files for this platform', async () => {
  const offered = [release('0.1.0-dev.1'), release('0.1.0-dev.4'), { ...release('0.1.0-dev.9'), notes: 'tampered' },
    release('0.1.0-dev.5', { channel: 'stable' })];
  let asked = '';
  const fetcher = (async (url: string) => { asked = url; return Response.json({ releases: offered }); }) as unknown as typeof fetch;
  const result = await checkForAppUpdate('0.1.0-dev.2', { fetcher, trustedKeys: keys, platform: 'linux-x64',
    endpoint: 'https://server.invalid/v1/releases' });
  assert.equal(asked, 'https://server.invalid/v1/releases?channel=dev');
  assert.equal(result.latest?.version, '0.1.0-dev.4', 'tampered, other-channel and older releases are not offered');
  assert.equal(result.rejected, 1);
  assert.deepEqual(result.latest?.files.map(file => file.kind), ['deb']);
  const current = await checkForAppUpdate('0.1.0-dev.4', { fetcher, trustedKeys: keys, endpoint: 'https://server.invalid/v1/releases' });
  assert.equal(current.latest, undefined);
});
