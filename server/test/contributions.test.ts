import assert from 'node:assert/strict';
import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { contributionRows, submitContribution } from '../../harness/src/contribution-queue.ts';
import { packTreeHash } from '../../harness/src/managed-pack-candidate.ts';
import { receiptIdFor } from '../src/contributions.ts';
import { createInstallation, prepareSharingDirs } from '../src/sharing.ts';
import { authorizedContribution, entries, spawnServer, startServer, tempDir } from './helpers.ts';

type Upload = { schema: string; payloadHash: string; username: string; files: Array<{ path: string; mode: number; bytes: string }>;
  directories?: Array<{ path: string; mode: number }> };

/** The exact request body the client sends, captured instead of delivered. */
async function clientUpload(fixture: ReturnType<typeof authorizedContribution>): Promise<Upload> {
  let body = '';
  await submitContribution(fixture.db, fixture.item.id, { endpoint: 'https://capture.invalid/v1/contributions' }, async (_url, init) => {
    body = String(init?.body);
    return new Response('not delivered', { status: 503 });
  }).catch(() => undefined);
  return JSON.parse(body) as Upload;
}

const tokens = new Map<string, string>();
async function tokenFor(url: string): Promise<string> {
  const saved = tokens.get(url);
  if (saved) return saved;
  const response = await fetch(`${url}/v1/installations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 201);
  const { token } = await response.json() as { token: string };
  tokens.set(url, token);
  return token;
}
async function post(url: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/v1/contributions`, { method: 'POST', headers: { 'content-type': 'application/json',
    authorization: `Bearer ${token ?? await tokenFor(url)}` },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function walk(root: string, prefix = ''): Array<{ path: string; directory: boolean; mode: number }> {
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    const path = prefix ? `${prefix}/${name}` : name, info = lstatSync(join(root, path));
    const entry = { path, directory: info.isDirectory(), mode: info.mode & 0o777 };
    return info.isDirectory() ? [entry, ...walk(root, path)] : [entry];
  });
}

test('every installation receives a different token and revoking one leaves the other active', async t => {
  const { url } = await startServer(t, { dataDir: tempDir(t) });
  const register = async () => {
    const response = await fetch(`${url}/v1/installations`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 201);
    return await response.json() as { installId: string; token: string };
  };
  const first = await register(), second = await register();
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.installId, second.installId);
  const status = async (token: string) => await fetch(`${url}/v1/contributions/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal((await status(first.token)).status, 200);
  assert.equal((await status(second.token)).status, 200);
  const revoked = await fetch(`${url}/v1/consents/revoke`, { method: 'POST', headers: {
    authorization: `Bearer ${first.token}`,
  }, body: '{}' });
  assert.equal(revoked.status, 200);
  assert.equal((await (await status(first.token)).json() as { installation: { status: string } }).installation.status, 'revoked');
  assert.equal((await (await status(second.token)).json() as { installation: { status: string } }).installation.status, 'active');
  assert.equal((await post(url, {}, first.token)).status, 403);
  assert.equal((await post(url, {}, second.token)).status, 400);
});

test('the real client submits an authorized contribution with no name, and accepts the receipt', async t => {
  const fixture = authorizedContribution(t), dataDir = tempDir(t);
  const { url } = await spawnServer(t, { DATA_DIR: dataDir });
  const health = await (await fetch(`${url}/v1/health`)).json();
  assert.deepEqual(health, { ok: true, service: 'harness-server', version: '0.1.0' });

  const submitted = await submitContribution(fixture.db, fixture.item.id, { endpoint: `${url}/v1/contributions`, token: await tokenFor(url), username: '' });
  assert.equal(submitted.status, 'submitted');
  assert.deepEqual(submitted.receipt, { schema: 'harness-contribution-receipt/0.1', candidateId: fixture.item.id,
    payloadHash: fixture.item.payloadHash, status: 'accepted', receiptId: receiptIdFor(fixture.item.payloadHash) });

  const stored = join(dataDir, 'contributions', receiptIdFor(fixture.item.payloadHash));
  const meta = JSON.parse(readFileSync(join(stored, 'meta.json'), 'utf8')) as Record<string, unknown> & { verifiedModes: {
    files: Record<string, string>; directories: Record<string, string> } };
  assert.deepEqual(Object.keys(meta).sort(), ['bytes', 'candidateId', 'contentHash', 'fileCount', 'installId', 'payloadHash', 'receiptId',
    'receivedAt', 'schema', 'username', 'verifiedModes'], 'meta.json records no address or client detail');
  assert.equal(meta.username, '');
  assert.equal(meta.bytes, walk(join(fixture.item.bundlePath)).filter(entry => !entry.directory)
    .reduce((sum, entry) => sum + statSync(join(fixture.item.bundlePath, entry.path)).size, 0));
  assert.ok(!Number.isNaN(Date.parse(String(meta.receivedAt))));
  assert.deepEqual(readdirSync(stored).sort(), ['bundle', 'meta.json']);
  assert.equal(readFileSync(join(stored, 'bundle', 'contribution.json'), 'utf8'), readFileSync(join(fixture.item.bundlePath, 'contribution.json'), 'utf8'));

  // Stored copies keep only "executable or not"; meta.json holds the exact modes, which reproduce the content hash.
  if (process.platform !== 'win32') for (const entry of walk(join(stored, 'bundle')))
    assert.ok(entry.directory ? entry.mode === 0o755 : [0o644, 0o755].includes(entry.mode), `${entry.path} ${entry.mode.toString(8)}`);
  const copy = join(tempDir(t), 'bundle');
  cpSync(join(stored, 'bundle'), copy, { recursive: true });
  for (const [path, mode] of Object.entries(meta.verifiedModes.files)) chmodSync(join(copy, path), parseInt(mode, 8));
  for (const [path, mode] of Object.entries(meta.verifiedModes.directories)) chmodSync(join(copy, path), parseInt(mode, 8));
  assert.equal(packTreeHash(join(copy, 'pack')).hash, meta.contentHash);
  assert.deepEqual(entries(join(dataDir, 'quarantine')), []);
});

test('the default technical contribution does not export a locally configured contributor name', async t => {
  const fixture = authorizedContribution(t), dataDir = tempDir(t);
  const { url, log } = await startServer(t, { dataDir });
  const submitted = await submitContribution(fixture.db, fixture.item.id, { endpoint: `${url}/v1/contributions`, token: await tokenFor(url), username: ' 喵 ' });
  assert.equal(submitted.status, 'submitted');
  const meta = JSON.parse(readFileSync(join(dataDir, 'contributions', String(submitted.receipt?.receiptId), 'meta.json'), 'utf8')) as { username: string };
  assert.equal(meta.username, '');
  assert.doesNotMatch(JSON.stringify(log.entries), /喵/, 'the name is stored, never logged');
});

test('the same payload uploaded again gets the same receipt and is stored once', async t => {
  const fixture = authorizedContribution(t), dataDir = tempDir(t);
  const { url } = await startServer(t, { dataDir });
  const upload = await clientUpload(fixture);
  const first = await post(url, upload), second = await post(url, structuredClone(upload));
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.receiptId, first.body.receiptId);
  assert.deepEqual(entries(join(dataDir, 'contributions')), [first.body.receiptId]);
  assert.deepEqual(entries(join(dataDir, 'quarantine')), []);
});

test('directory modes are recovered for bundles authorized under umask 022, 002 and 077', async t => {
  const dataDir = tempDir(t);
  const { url } = await startServer(t, { dataDir });
  for (const mask of [0o022, 0o002, 0o077]) {
    const previous = process.umask(mask);
    let fixture: ReturnType<typeof authorizedContribution>;
    try { fixture = authorizedContribution(t); } finally { process.umask(previous); }
    const submitted = await submitContribution(fixture.db, fixture.item.id, { endpoint: `${url}/v1/contributions`, token: await tokenFor(url) });
    assert.equal(submitted.status, 'submitted', `umask ${mask.toString(8)}: ${contributionRows(fixture.db)[0]?.error}`);
  }
  assert.equal(entries(join(dataDir, 'contributions')).length, 3);
});

test('a candidate whose directories are 0755 can be contributed under umask 002', async t => {
  const dataDir = tempDir(t);
  const { url } = await startServer(t, { dataDir });
  const previous = process.umask(0o002);
  let fixture: ReturnType<typeof authorizedContribution>;
  try {
    fixture = authorizedContribution(t, source => {
      const settle = (dir: string): void => {
        chmodSync(dir, 0o755);
        for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) settle(join(dir, entry.name));
      };
      settle(source);
    });
  } finally {
    process.umask(previous);
  }
  const submitted = await submitContribution(fixture.db, fixture.item.id, { endpoint: `${url}/v1/contributions`, token: await tokenFor(url) });
  assert.equal(submitted.status, 'submitted');
});

test('private files and empty source directories are excluded from the contributed observation', async t => {
  const fixture = authorizedContribution(t, source => mkdirSync(join(source, 'knowledge', 'empty-notes')));
  const dataDir = tempDir(t);
  const { url } = await startServer(t, { dataDir });
  const upload = await clientUpload(fixture);
  // The client declares every directory with its mode, the empty one included.
  const directories = walk(join(fixture.item.bundlePath, 'pack')).filter(entry => entry.directory)
    .map(entry => ({ path: `pack/${entry.path}`, mode: entry.mode }));
  assert.equal(directories.length, 0);
  assert.deepEqual([...upload.directories!].sort((a, b) => a.path < b.path ? -1 : 1),
    [...directories].map(entry => ({ ...entry, mode: process.platform === 'win32' ? 0o755 : entry.mode }))
      .sort((a, b) => a.path < b.path ? -1 : 1));
  const { directories: _omitted, ...without } = upload;
  const refused = await post(url, without);
  assert.equal(refused.status, 201);
  assert.equal((await post(url, { ...upload, directories: [{ path: 'pack/private', mode: 0o755 }] })).status, 400);
  assert.equal((await post(url, upload)).status, 200);
  assert.deepEqual(entries(join(dataDir, 'quarantine')), []);
});

test('bad uploads are refused and leave nothing behind', async t => {
  const fixture = authorizedContribution(t), dataDir = tempDir(t);
  const { url } = await startServer(t, { dataDir });
  const upload = await clientUpload(fixture);
  const file = (u: Upload, path: string) => u.files.find(entry => entry.path === path)!;
  const cases: Array<[string, (u: Upload) => unknown, number]> = [
    ['a pack file changed after authorization', u => { file(u, 'pack/candidate-report.json').bytes = Buffer.from('{"changed":true}').toString('base64'); }, 400],
    ['contribution.json changed', u => { const f = file(u, 'contribution.json'); f.bytes = Buffer.from(`${Buffer.from(f.bytes, 'base64')} `).toString('base64'); }, 400],
    ['a payloadHash that does not match', u => { u.payloadHash = 'a'.repeat(64); }, 400],
    ['an uppercase payloadHash', u => { u.payloadHash = u.payloadHash.toUpperCase(); }, 400],
    ['a file added to the pack', u => { u.files.push({ path: 'pack/extra.txt', mode: 0o644, bytes: '' }); }, 400],
    ...['../evil', 'pack/../../evil', '/etc/evil', 'pack\\evil', 'pack//evil', 'pack/./evil', 'pack/evil\u0000', 'pack/', 'meta.json', '']
      .map((path): [string, (u: Upload) => unknown, number] => [`path ${JSON.stringify(path)}`, u => { u.files.push({ path, mode: 0o644, bytes: '' }); }, 400]),
    ['no contribution.json', u => { u.files = u.files.filter(f => f.path !== 'contribution.json'); }, 400],
    ['no pack/candidate-report.json', u => { u.files = u.files.filter(f => f.path !== 'pack/candidate-report.json'); }, 400],
    ['a repeated path', u => { u.files.push({ ...file(u, 'pack/candidate-report.json') }); }, 400],
    ['a path that is a file and a directory', u => { u.files.push({ path: 'pack/knowledge', mode: 0o644, bytes: '' }); }, 400],
    ...[0o4755, 0o1644, -1, 1.5, '644', 0o200, null].map((mode): [string, (u: Upload) => unknown, number] =>
      [`mode ${String(mode)}`, u => { (file(u, 'pack/candidate-report.json') as { mode: unknown }).mode = mode; }, 400]),
    ['bytes that are not base64', u => { file(u, 'pack/candidate-report.json').bytes = 'not base64!'; }, 400],
    ['a name longer than 64 characters', u => { u.username = 'x'.repeat(65); }, 400],
    ['a name with a newline', u => { u.username = 'a\nb'; }, 400],
    ['a name with a bidi override', u => { u.username = 'a‮b'; }, 400],
    ['an unknown schema', u => { u.schema = 'harness-contribution-upload/9'; }, 400],
    ['files that are not a list', u => { (u as { files: unknown }).files = {}; }, 400],
    ['more than 2000 files', u => { for (let i = 0; i < 2001; i++) u.files.push({ path: `pack/many/${i}`, mode: 0o644, bytes: '' }); }, 413],
  ];
  for (const [name, mutate, status] of cases) {
    const bad = structuredClone(upload);
    mutate(bad);
    const response = await post(url, bad);
    assert.equal(response.status, status, `${name}: ${JSON.stringify(response.body)}`);
    assert.equal(typeof response.body.error, 'string', name);
    assert.deepEqual(entries(join(dataDir, 'quarantine')), [], `${name} left files in the quarantine`);
    assert.deepEqual(entries(join(dataDir, 'contributions')), [], `${name} was stored`);
  }
  assert.equal((await post(url, '{not json')).status, 400);
  assert.equal((await post(url, [])).status, 400);
  assert.equal((await post(url, upload)).status, 201, 'the untouched upload still goes through');
});

test('receiver rejects private content and wrong purposes even with valid hashes and privacy:false claims', async t => {
  for (const mutation of ['private-field', 'wrong-purpose', 'source-id', 'extra-file', 'privacy-claim'] as const) {
    const fixture = authorizedContribution(t), dataDir = tempDir(t), { url } = await startServer(t, { dataDir });
    const upload = await clientUpload(fixture);
    const reportPath = join(fixture.item.bundlePath, 'pack', 'candidate-report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    if (mutation === 'private-field') report.notes = 'private conversation and account';
    if (mutation === 'wrong-purpose') report.purpose = 'model-training';
    if (mutation === 'source-id') report.sourceCandidate = 'private-project-label';
    writeFileSync(reportPath, JSON.stringify(report));
    upload.files.find(file => file.path === 'pack/candidate-report.json')!.bytes = Buffer.from(JSON.stringify(report)).toString('base64');
    if (mutation === 'extra-file') {
      writeFileSync(join(fixture.item.bundlePath, 'pack', 'private.txt'), 'private customer materials');
      upload.files.push({ path: 'pack/private.txt', mode: process.platform === 'win32' ? 0o644 : 0o666 & ~process.umask(),
        bytes: Buffer.from('private customer materials').toString('base64') });
    }
    const manifestFile = upload.files.find(file => file.path === 'contribution.json')!;
    const manifest = JSON.parse(Buffer.from(manifestFile.bytes, 'base64').toString('utf8')) as
      Record<string, unknown> & { candidate: { contentHash: string } };
    manifest.candidate.contentHash = packTreeHash(join(fixture.item.bundlePath, 'pack')).hash;
    if (mutation === 'privacy-claim') manifest.privacy = { containsUserAssets: false, containsCredentials: false, containsPersonalData: false };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    manifestFile.bytes = manifestBytes.toString('base64');
    upload.payloadHash = createHash('sha256').update(manifestBytes).update(manifest.candidate.contentHash).digest('hex');
    assert.equal((await post(url, upload)).status, 400, mutation);
    assert.deepEqual(entries(join(dataDir, 'contributions')), []);
    assert.deepEqual(entries(join(dataDir, 'quarantine')), []);
  }
});

test('size limits answer 413 before anything is written', async t => {
  const fixture = authorizedContribution(t), upload = await clientUpload(fixture);
  const bytes = upload.files.reduce((sum, file) => sum + Buffer.from(file.bytes, 'base64').length, 0);
  const small = tempDir(t);
  const decoded = await startServer(t, { dataDir: small, limits: { maxBytes: bytes - 1 } });
  assert.equal((await post(decoded.url, upload)).status, 413);
  const bodyLimit = await startServer(t, { dataDir: tempDir(t), limits: { maxBodyBytes: 1024 } });
  assert.equal((await post(bodyLimit.url, upload)).status, 413);
  assert.deepEqual(entries(join(small, 'quarantine')), []);
});

test('uploads are turned away when too many are in progress or storage is short', async t => {
  const busy = await startServer(t, { dataDir: tempDir(t), maxConcurrentUploads: 0 });
  const refused = await post(busy.url, {});
  assert.equal(refused.status, 503);
  const fullDir = tempDir(t);
  prepareSharingDirs(fullDir);
  const fullToken = createInstallation(fullDir).token;
  const full = await startServer(t, { dataDir: fullDir, minFreeBytes: Number.MAX_SAFE_INTEGER });
  assert.equal((await post(full.url, {}, fullToken)).status, 507);
});

test('an upload a crash interrupted is cleared from the quarantine at startup', async t => {
  const dataDir = tempDir(t), stale = join(dataDir, 'quarantine', 'upload-stale', 'bundle');
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'contribution.json'), '{}');
  await startServer(t, { dataDir });
  assert.deepEqual(entries(join(dataDir, 'quarantine')), []);
});

test('unknown paths and methods get JSON errors', async t => {
  const { url } = await startServer(t, { dataDir: tempDir(t) });
  const missing = await fetch(`${url}/v1/nothing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not found' });
  const wrong = await fetch(`${url}/v1/contributions`);
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'POST');
  assert.equal((await fetch(`${url}/v1/health`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${url}/v1/knowledge/files/x.tar.gz`)).status, 404, 'downloads are nginx\'s job unless enabled');
});
