#!/usr/bin/env node
// Signs an unsigned release manifest, either schema (harness-app-release/0.1, harness-pack-release/0.1). The manifest
// must already name its keyId. The result is checked with the client's own verifier before it is written, and an
// existing output file is never overwritten.
//
//   node server/scripts/sign-release.mjs --key ~/.local/share/avh-release-keys/harness-dev-1.key --in unsigned.json --out signed.json
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { publicPemFor, RELEASE_SCHEMAS, signRelease, verifyRelease } from '../src/signing.ts';

function fail(message) {
  console.error(`sign-release: ${message}`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({ options: { key: { type: 'string' }, in: { type: 'string' }, out: { type: 'string' } }, strict: true }));
} catch (error) { fail(error.message); }
if (!values.key || !values.in || !values.out) fail('usage: sign-release.mjs --key <private key> --in <unsigned json> --out <signed json>');

try {
  const unsigned = JSON.parse(readFileSync(values.in, 'utf8'));
  if (!RELEASE_SCHEMAS.includes(unsigned?.schema)) fail(`schema must be one of ${RELEASE_SCHEMAS.join(', ')}`);
  if (typeof unsigned.keyId !== 'string' || !unsigned.keyId) fail('the unsigned manifest must name its keyId');
  const privatePem = readFileSync(values.key, 'utf8');
  const signed = signRelease(unsigned, privatePem);
  verifyRelease(signed, { [signed.keyId]: publicPemFor(privatePem) });
  writeFileSync(values.out, `${JSON.stringify(signed, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  console.log(JSON.stringify({ out: values.out, schema: signed.schema, releaseId: signed.releaseId, keyId: signed.keyId }, null, 2));
} catch (error) {
  fail(error.message);
}
