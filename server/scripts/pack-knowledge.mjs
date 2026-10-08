#!/usr/bin/env node
// Packs a capability pack directory into a signed knowledge release:
//   <out>/<releaseId>.tar.gz   the archive (format: server/src/tar.ts)
//   <out>/<releaseId>.json     the signed harness-pack-release/0.1 manifest
// Inside a Git work tree only tracked files are packed. pack.json in the release gets the release's id, version and
// channel. The pack id defaults to <id-prefix>-<version> and the release id to the pack id.
//
//   node server/scripts/pack-knowledge.mjs --pack harness/builtin --version 0.1.0-dev.2 --channel dev \
//     --key ~/.local/share/avh-release-keys/harness-dev-1.key --key-id harness-dev-1 --out /tmp/knowledge-release \
//     --previous builtin-linux-rc5
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { SCHEMA_VERSION } from '../../harness/src/state/db.ts';
import { buildKnowledgeRelease } from '../src/pack-release.ts';

function fail(message) {
  console.error(`pack-knowledge: ${message}`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({ strict: true, options: {
    pack: { type: 'string' }, version: { type: 'string' }, channel: { type: 'string' }, key: { type: 'string' },
    'key-id': { type: 'string' }, out: { type: 'string' }, previous: { type: 'string', multiple: true },
    'minimum-state-schema': { type: 'string' }, 'pack-id': { type: 'string' }, 'id-prefix': { type: 'string' },
    'release-id': { type: 'string' }, 'issued-at': { type: 'string' },
  } }));
} catch (error) { fail(error.message); }
for (const name of ['pack', 'version', 'channel', 'key', 'key-id', 'out'])
  if (!values[name]) fail(`--${name} is required (--pack --version --channel --key --key-id --out [--previous <packId>]... ` +
    '[--minimum-state-schema <n>] [--pack-id <id> | --id-prefix <prefix>] [--release-id <id>] [--issued-at <ISO time>])');

try {
  const release = buildKnowledgeRelease({
    packDir: values.pack, version: values.version, channel: values.channel, keyId: values['key-id'],
    privateKeyPem: readFileSync(values.key, 'utf8'), packId: values['pack-id'], idPrefix: values['id-prefix'],
    releaseId: values['release-id'], previousPackIds: values.previous ?? [], issuedAt: values['issued-at'],
    minimumStateSchema: values['minimum-state-schema'] === undefined ? SCHEMA_VERSION : Number(values['minimum-state-schema']),
  });
  mkdirSync(values.out, { recursive: true });
  const archivePath = join(values.out, release.archiveName), manifestPath = join(values.out, `${release.manifest.releaseId}.json`);
  writeFileSync(archivePath, release.archive, { flag: 'wx', mode: 0o644 });
  writeFileSync(manifestPath, `${JSON.stringify(release.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  const { manifest, selection } = release;
  console.log(JSON.stringify({ releaseId: manifest.releaseId, packId: manifest.packId, version: manifest.version, channel: values.channel,
    contentHash: manifest.contentHash, minimumStateSchema: manifest.minimumStateSchema, files: selection.files.length,
    fileSource: selection.source, skippedFiles: selection.skipped, archive: archivePath, archiveBytes: release.archive.length,
    manifest: manifestPath }, null, 2));
} catch (error) {
  fail(error.message);
}
