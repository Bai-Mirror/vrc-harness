#!/usr/bin/env node
// Marks uploads as accepted into a signed release, so the retention sweep and a later revocation keep them. Run it once
// the release is published: the release must be a manifest under DATA_DIR/releases that verifies with the trusted keys.
//
//   node server/scripts/accept.mjs --data-dir /docker/harness-server/data \
//     --trusted-keys /docker/harness-server/config/trusted-keys.json --release vrc-knowledge-0.1.0-dev.1 \
//     --contribution <receiptId> [--contribution <receiptId>]... [--records <installId>.<batchId>]...
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadTrustedKeys } from '../src/keys.ts';
import { markAccepted } from '../src/sharing.ts';
import { verifyRelease } from '../src/signing.ts';

function fail(message) {
  console.error(`accept: ${message}`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({ strict: true, options: {
    'data-dir': { type: 'string' }, 'trusted-keys': { type: 'string' }, release: { type: 'string' },
    contribution: { type: 'string', multiple: true }, records: { type: 'string', multiple: true },
  } }));
} catch (error) { fail(error.message); }
const items = [...(values.contribution ?? []).map(id => ({ kind: 'contribution', id })), ...(values.records ?? []).map(id => ({ kind: 'records', id }))];
if (!values['data-dir'] || !values['trusted-keys'] || !values.release || !items.length)
  fail('usage: accept.mjs --data-dir <DATA_DIR> --trusted-keys <trusted-keys.json> --release <releaseId> ' +
    '(--contribution <receiptId> | --records <installId>.<batchId>)...');

try {
  const keys = loadTrustedKeys(values['trusted-keys']);
  let found = false;
  for (const kind of ['app', 'knowledge']) {
    const root = join(values['data-dir'], 'releases', kind);
    let channels = [];
    try { channels = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'files'); } catch { continue; }
    for (const channel of channels) for (const name of readdirSync(join(root, channel.name)).filter(name => name.endsWith('.json'))) {
      let manifest;
      try { manifest = JSON.parse(readFileSync(join(root, channel.name, name), 'utf8')); } catch { continue; }
      if (manifest?.releaseId !== values.release) continue;
      verifyRelease(manifest, keys);
      found = true;
    }
  }
  if (!found) fail(`no manifest for release ${values.release} under ${join(values['data-dir'], 'releases')} verifies; publish the release first`);
  const written = markAccepted(values['data-dir'], values.release, items);
  console.log(JSON.stringify({ release: values.release, accepted: items, markers: written }, null, 2));
} catch (error) {
  fail(error.message);
}
