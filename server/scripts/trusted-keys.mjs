#!/usr/bin/env node
// Writes the server's TRUSTED_KEYS_FILE, {"keyId": "public key PEM"}, adding the given public keys to what the file
// already holds. Only Ed25519 public keys are accepted; a private key is refused.
//
//   node server/scripts/trusted-keys.mjs --out /docker/harness-server/config/trusted-keys.json \
//     harness-dev-1=$HOME/.local/share/avh-release-keys/harness-dev-1.pub
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

function fail(message) {
  console.error(`trusted-keys: ${message}`);
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true, strict: true });
} catch (error) { fail(error.message); }
const { values, positionals } = parsed;
if (!values.out || !positionals.length) fail('usage: trusted-keys.mjs --out <trusted-keys.json> <keyId>=<public key file>...');

try {
  const keys = existsSync(values.out) ? JSON.parse(readFileSync(values.out, 'utf8')) : {};
  if (!keys || typeof keys !== 'object' || Array.isArray(keys)) fail(`${values.out} is not a {keyId: PEM} object`);
  for (const pair of positionals) {
    const at = pair.indexOf('='), keyId = pair.slice(0, at), file = pair.slice(at + 1);
    if (at < 1 || !/^[a-zA-Z0-9._-]+$/.test(keyId) || !file) fail(`expected <keyId>=<public key file>, not ${pair}`);
    const pem = readFileSync(file, 'utf8');
    if (/PRIVATE KEY/.test(pem)) fail(`${file} is a private key; only public keys go to the server`);
    if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') fail(`${file} is not an Ed25519 public key`);
    if (keys[keyId] !== undefined && keys[keyId] !== pem) fail(`${keyId} is already trusted with a different key; remove it from ${values.out} first`);
    keys[keyId] = pem;
  }
  const temporary = `${values.out}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(keys, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  renameSync(temporary, values.out);
  console.log(JSON.stringify({ out: values.out, keyIds: Object.keys(keys) }, null, 2));
} catch (error) {
  fail(error.message);
}
