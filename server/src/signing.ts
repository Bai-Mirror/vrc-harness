import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { releasePayload, verifyAppRelease, verifyPackRelease, type SignedAppRelease, type SignedPackRelease } from './harness.ts';

export type SignedRelease = SignedPackRelease | SignedAppRelease;
export const RELEASE_SCHEMAS = ['harness-pack-release/0.1', 'harness-app-release/0.1'] as const;

function privateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('release signing key must be an Ed25519 private key');
  return key;
}

export function publicPemFor(privatePem: string): string {
  return createPublicKey(privateKey(privatePem)).export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Signs a release manifest the way the client verifies it: Ed25519 over the canonical JSON of every field except
 * `signature` (the client's own releasePayload), for both schemas.
 */
export function signRelease<T extends SignedRelease>(unsigned: Omit<T, 'signature'> & { signature?: string }, privatePem: string): T {
  const release = { ...unsigned, signature: '' } as T;
  const signature = sign(null, releasePayload(release as unknown as SignedPackRelease), privateKey(privatePem)).toString('base64');
  return { ...release, signature };
}

/**
 * Runs the client's verifier for the manifest's schema. Knowledge releases are not filtered by state schema here:
 * each client decides for itself whether it can run a release.
 */
export function verifyRelease(release: SignedRelease, trustedKeys: Record<string, string>): void {
  if (release.schema === 'harness-pack-release/0.1') verifyPackRelease(release, trustedKeys, Number.MAX_SAFE_INTEGER);
  else if (release.schema === 'harness-app-release/0.1') verifyAppRelease(release, trustedKeys);
  else throw new Error(`unsupported release schema ${JSON.stringify((release as { schema?: unknown }).schema)}`);
}
