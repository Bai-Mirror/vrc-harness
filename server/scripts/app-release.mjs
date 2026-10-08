#!/usr/bin/env node
// Writes a signed harness-app-release/0.1 manifest for a set of installer files, with their size and SHA-256, and
// download URLs under --base-url (default https://harness.nymiro.moe/v1/releases/files/). Copy the installers into
// DATA_DIR/releases/app/files/ first and the manifest into DATA_DIR/releases/app/<channel>/ last.
//
// The URLs are frozen into the manifest when it is signed, and the server checks knowledge archives but never an app
// file, so a URL that 404s is only discovered by the user. Every URL that will be written is printed before signing;
// --verify-urls also sends a HEAD to each one and refuses to sign unless it answers 200.
//
//   node server/scripts/app-release.mjs --version 0.1.0-dev.1 --channel dev --key <private key> --key-id harness-dev-2 \
//     --notes-file notes.md --file win32-x64:nsis:dist/Harness_0.1.0-dev.1_x64-setup.exe --out app-0.1.0-dev.1.json \
//     [--verify-urls]
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256File } from '../../harness/src/file-hash.ts';
import { SCHEMA_VERSION } from '../../harness/src/state/db.ts';
import { verifyReleaseUrls } from '../src/release-urls.ts';
import { publicPemFor, signRelease, verifyRelease } from '../src/signing.ts';

function fail(message) {
  console.error(`app-release: ${message}`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({ strict: true, options: {
    version: { type: 'string' }, channel: { type: 'string' }, key: { type: 'string' }, 'key-id': { type: 'string' },
    out: { type: 'string' }, file: { type: 'string', multiple: true }, notes: { type: 'string' }, 'notes-file': { type: 'string' },
    'release-id': { type: 'string' }, 'minimum-state-schema': { type: 'string' }, 'base-url': { type: 'string' },
    'issued-at': { type: 'string' }, 'verify-urls': { type: 'boolean' },
  } }));
} catch (error) { fail(error.message); }
for (const name of ['version', 'channel', 'key', 'key-id', 'out'])
  if (!values[name]) fail(`--${name} is required (--version --channel --key --key-id --out --file <platform>:<kind>:<path>... ` +
    '[--notes <text> | --notes-file <path>] [--release-id <id>] [--minimum-state-schema <n>] [--base-url <https url>] ' +
    '[--issued-at <ISO time>] [--verify-urls])');
if (!values.file?.length) fail('at least one --file <platform>:<kind>:<path> is required');
if (values.notes !== undefined && values['notes-file']) fail('pass --notes or --notes-file, not both');

try {
  const baseUrl = new URL(values['base-url'] ?? 'https://harness.nymiro.moe/v1/releases/files/');
  if (baseUrl.protocol !== 'https:' || !baseUrl.pathname.endsWith('/')) fail('--base-url must be an https URL ending in /');
  const files = values.file.map(spec => {
    const match = /^([^:]+):([^:]+):(.+)$/.exec(spec);
    if (!match) fail(`--file must be <platform>:<kind>:<path>, not ${spec}`);
    const [, platform, kind, path] = match, name = basename(path);
    if (!/^[a-zA-Z0-9_+-][a-zA-Z0-9._+-]*$/.test(name)) fail(`installer file name ${name} may only use letters, digits, ".", "_", "+" and "-"`);
    if (!statSync(path).isFile()) fail(`${path} is not a file`);
    return { platform, kind, name, size: statSync(path).size, sha256: sha256File(path), urls: [new URL(name, baseUrl).href] };
  });
  const names = new Set(files.map(file => file.name));
  if (names.size !== files.length) fail('two installers share a file name');
  const minimumStateSchema = values['minimum-state-schema'] === undefined ? SCHEMA_VERSION : Number(values['minimum-state-schema']);
  if (!Number.isInteger(minimumStateSchema) || minimumStateSchema < 1) fail('--minimum-state-schema must be a positive integer');
  // Before the private key is read: say which URLs the manifest will carry, and with --verify-urls prove they resolve.
  console.log('将写入清单的下载地址：');
  for (const file of files) for (const url of file.urls) console.log(`  ${file.platform}:${file.kind}  ${url}`);
  if (values['verify-urls']) {
    const readings = await verifyReleaseUrls(files.flatMap(file => file.urls));
    for (const reading of readings)
      console.log(`  HEAD ${reading.ok ? 200 : reading.status || 'unreachable'} ${reading.url}${reading.error ? ` — ${reading.error}` : ''}`);
    const missing = readings.filter(reading => !reading.ok);
    if (missing.length) fail(`这些下载地址现在取不到：${missing.map(reading => `${reading.status || 'unreachable'} ${reading.url}`).join('；')}。` +
      '先放文件、后放清单：把安装包放到 --base-url 指向的目录、确认每个 URL 返回 200 之后，再重新签名。');
  }
  const privatePem = readFileSync(values.key, 'utf8');
  const release = signRelease({
    schema: 'harness-app-release/0.1', releaseId: values['release-id'] ?? `app-${values.version}`, version: values.version,
    channel: values.channel, issuedAt: values['issued-at'] ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    notes: values['notes-file'] ? readFileSync(values['notes-file'], 'utf8') : values.notes ?? '',
    minimumStateSchema, files, keyId: values['key-id'],
  }, privatePem);
  verifyRelease(release, { [release.keyId]: publicPemFor(privatePem) });
  writeFileSync(values.out, `${JSON.stringify(release, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  console.log(JSON.stringify({ out: values.out, releaseId: release.releaseId, version: release.version, channel: release.channel,
    files: files.map(({ platform, kind, name, size, sha256 }) => ({ platform, kind, name, size, sha256 })) }, null, 2));
} catch (error) {
  fail(error.message);
}
