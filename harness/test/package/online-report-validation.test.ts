import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dataPolicy } from '../../src/shared/sharing.ts';
import { removeTemp } from '../fixtures/platform.ts';

const driver = fileURLToPath(new URL('../../scripts/online-report-validation.mjs', import.meta.url));

/** The driver is a process of its own: it must run asynchronously, or a synchronous spawn would block the stand-in. */
function runDriver(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [driver, ...args], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

/** A stand-in deployment that records what the driver actually requests. */
async function deployment(t: test.TestContext): Promise<{ url: string; methods: string[] }> {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    methods.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') return response.end(JSON.stringify({ ok: true, service: 'harness-server', version: 'test' }));
    if (request.url === '/v1/capabilities')
      return response.end(JSON.stringify({ dataPolicy: dataPolicy({ retentionDays: 90, backupDays: 0, recordsPerDay: 2000 }) }));
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, methods };
}

test('the online driver sends only read requests unless writes are explicitly allowed', async t => {
  const stand = await deployment(t), directory = mkdtempSync(join(tmpdir(), 'avh-online-readonly-')), output = join(directory, 'evidence.json');
  t.after(() => removeTemp(directory));
  const result = await runDriver(['--endpoint', stand.url, '--output', output]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(stand.methods, ['GET /v1/health', 'GET /v1/capabilities'], 'no installation was registered');
  const evidence = JSON.parse(readFileSync(output, 'utf8')) as { mode: string; ok: boolean; requests: Array<{ method: string }> };
  assert.equal(evidence.mode, 'read-only');
  assert.equal(evidence.ok, true);
  assert.deepEqual(evidence.requests.map(item => item.method), ['GET', 'GET']);
});

test('--allow-writes is what opens the write path', async t => {
  const stand = await deployment(t), directory = mkdtempSync(join(tmpdir(), 'avh-online-writes-')), output = join(directory, 'evidence.json');
  t.after(() => removeTemp(directory));
  const result = await runDriver(['--endpoint', stand.url, '--output', output, '--allow-writes']);
  // The stand-in cannot accept a report, so the run fails -- but only after it actually tried to register.
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.ok(stand.methods.includes('POST /v1/installations'), stand.methods.join(', '));
  const evidence = JSON.parse(readFileSync(output, 'utf8')) as { mode: string; ok: boolean };
  assert.equal(evidence.mode, 'writes');
  assert.equal(evidence.ok, false);
});

test('the driver refuses an endpoint that is neither HTTPS nor this machine', async () => {
  const result = await runDriver(['--endpoint', 'http://example.com', '--allow-writes']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refused/);
});
