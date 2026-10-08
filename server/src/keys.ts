import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

const KEY_ID = /^[a-zA-Z0-9._-]+$/;

/**
 * Reads TRUSTED_KEYS_FILE, `{"<keyId>": "<SPKI PEM>"}`. Anything malformed stops startup: a server that quietly
 * trusts nothing, or the wrong thing, is worse than one that does not start. A private key is refused outright,
 * because it must never be on the server at all.
 */
export function loadTrustedKeys(file: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file}: expected {"keyId": "public key PEM"}`);
  const keys: Record<string, string> = {};
  for (const [keyId, pem] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KEY_ID.test(keyId)) throw new Error(`${file}: invalid key id ${JSON.stringify(keyId)}`);
    if (typeof pem !== 'string') throw new Error(`${file}: key ${keyId} is not a PEM string`);
    if (/PRIVATE KEY/.test(pem)) throw new Error(`${file}: key ${keyId} is a private key; only public keys belong on the server`);
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${file}: key ${keyId} is not an Ed25519 public key`);
    keys[keyId] = pem;
  }
  return keys;
}
