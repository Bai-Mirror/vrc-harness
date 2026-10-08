import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
type CdpTarget = { id: string; type: string; url?: string; webSocketDebuggerUrl?: string };
import { DemoTransportError, connectDemoSocket, createOwnedTarget, findOwnedTarget, isRetryableDemoError, readOwnedEndpoint, retryTransport } from '../../scripts/gui-demo-cdp.mjs';

// The rules a screenshot run follows when it attaches to a browser, checked without a browser. Both were wrong in an
// earlier version of `scripts/gui-demo.mjs`: it drove whichever page target the browser listed first (measured: a list
// whose first entry was a foreign page, and two indistinguishable blank tabs), and its retry wrapper accepted the
// evidence assertions as well, so a first, real failure could be answered by a second, passing attempt.

interface Answer { status?: number; body?: unknown; /** Never answer at all: a browser that is there but wedged. */ silent?: boolean }
/** A stand-in for the browser's DevTools HTTP endpoint, answering `/json` and `/json/new` from the case's own state. */
function devtoolsEndpoint(answer: (request: { method: string; path: string }) => Answer | undefined) {
  const requests: string[] = [];
  const server = createServer((request, response: ServerResponse) => {
    const path = (request.url ?? '').split('?')[0];
    requests.push(`${request.method} ${path}`);
    const given = answer({ method: request.method ?? '', path });
    if (!given) { response.writeHead(404, { 'content-type': 'application/json' }); response.end('{}'); return; }
    if (given.silent) return;
    response.writeHead(given.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(given.body ?? {}));
  });
  return new Promise<{ port: number; requests: string[]; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ port: typeof address === 'object' && address ? address.port : 0, requests,
        close: () => new Promise<void>(done => server.close(() => done())) });
    });
  });
}

const own = (id: string, extra: Partial<CdpTarget> = {}): CdpTarget =>
  ({ id, type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:1/devtools/page/${id}`, ...extra });
const foreign = (id: string, url = 'https://example.invalid/welcome'): CdpTarget => ({ id, type: 'page', url });

test('reads and authenticates the DevTools port written by this browser profile', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'f33c-cdp-'));
  const server = createServer((request, response) => {
    if (request.url !== '/json/version') { response.writeHead(404); response.end(); return; }
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/owned` }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    writeFileSync(join(profile, 'DevToolsActivePort'), `${port}\n/devtools/browser/owned\n`);
    assert.equal(await readOwnedEndpoint(profile, { timeoutMs: 1_000 }), port);
    writeFileSync(join(profile, 'DevToolsActivePort'), `${port}\n/devtools/browser/foreign\n`);
    await assert.rejects(readOwnedEndpoint(profile, { timeoutMs: 100 }), DemoTransportError);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a run drives only the page it created, never one the browser happened to list', async () => {
  let list: CdpTarget[] = [foreign('foreign-restored'), foreign('foreign-blank', 'about:blank'), own('run-1')];
  const endpoint = await devtoolsEndpoint(request => request.path === '/json/new' ? { body: own('run-1') }
    : request.path === '/json' ? { body: list } : undefined);
  try {
    // Ownership is created through the endpoint, and a GET is refused there for a reason: it must be a PUT.
    const created = await createOwnedTarget(endpoint.port, { timeoutMs: 2_000 });
    assert.equal(created.id, 'run-1');
    assert.deepEqual(endpoint.requests.filter(one => one.endsWith('/json/new')), ['PUT /json/new']);

    // Two blank tabs are indistinguishable by what they look like; only the recorded id says which one is ours, so a
    // foreign blank page listed first is not a candidate (the version this test replaces chose exactly that one).
    const confirmed = await findOwnedTarget(endpoint.port, created.id, { timeoutMs: 2_000 });
    assert.equal(confirmed.id, 'run-1');
    assert.equal(confirmed.webSocketDebuggerUrl, own('run-1').webSocketDebuggerUrl);

    // Only foreign pages: the run refuses to attach, rather than adopting a page nobody claimed.
    list = [foreign('foreign-restored'), foreign('foreign-blank', 'about:blank')];
    await assert.rejects(findOwnedTarget(endpoint.port, created.id, { timeoutMs: 200 }),
      error => error instanceof DemoTransportError && /none is this run's own \(run-1\)/.test(error.message));

    // The same refusal when the page the run created is listed but has no DevTools socket to attach to.
    list = [foreign('foreign-restored'), own('run-1', { webSocketDebuggerUrl: undefined })];
    await assert.rejects(findOwnedTarget(endpoint.port, created.id, { timeoutMs: 200 }),
      error => error instanceof DemoTransportError && /has no DevTools socket/.test(error.message));

    // No page at all is a failure too, not a later crash on an undefined target.
    list = [];
    await assert.rejects(findOwnedTarget(endpoint.port, 'run-1', { timeoutMs: 200 }), DemoTransportError);
  } finally { await endpoint.close(); }
});

test('a browser that never confirms a page of this run is bounded by the deadline, not waited on', async () => {
  // The endpoint answers `/json` with foreign pages only and never answers `/json/new` at all.
  const endpoint = await devtoolsEndpoint(request => request.path === '/json' ? { body: [foreign('foreign')] }
    : request.path === '/json/new' ? { silent: true } : undefined);
  try {
    const started = Date.now();
    await assert.rejects(createOwnedTarget(endpoint.port, { timeoutMs: 300 }), DemoTransportError);
    await assert.rejects(findOwnedTarget(endpoint.port, 'run-1', { timeoutMs: 300 }), DemoTransportError);
    assert.ok(Date.now() - started < 5_000, 'both deadlines have to be bounded by the time they were given');
  } finally { await endpoint.close(); }
});

test('only transport failures are retried; a CDP protocol error is reported at once', async () => {
  assert.equal(isRetryableDemoError(new DemoTransportError('the browser exited')), true);
  assert.equal(isRetryableDemoError(new Error('the colour decision shot is missing evidence')), false);
  assert.equal(isRetryableDemoError(new Error('Runtime.evaluate: Execution context was destroyed')), false);
  assert.equal(isRetryableDemoError('a string thrown somewhere'), false);

  // A claim about what a page shows is checked once. The same error instance reaches the caller, so the first reading
  // of what the page held is the one that is reported — a retry must not replace it with a later, passing attempt.
  const failed = new Error('project-colour-decision: the control is covered by div.topbar');
  let assertions = 0;
  await assert.rejects(retryTransport(async () => { assertions++; throw failed; }, { attempts: 2, waitMs: 1 }),
    error => error === failed);
  assert.equal(assertions, 1);

  let protocolCalls = 0;
  const protocol = new Error('Runtime.evaluate: Execution context was destroyed');
  await assert.rejects(retryTransport(async () => { protocolCalls++; throw protocol; }, { attempts: 2, waitMs: 1 }),
    error => error === protocol && (error as Error).message === 'Runtime.evaluate: Execution context was destroyed');
  assert.equal(protocolCalls, 1);

  // A transport failure is retried, and can recover.
  let transports = 0;
  const retried: string[] = [];
  assert.equal(await retryTransport(async () => { transports++; if (transports === 1) throw new DemoTransportError('socket closed'); return 'shot'; },
    { attempts: 2, waitMs: 1, onRetry: (error, attempt) => retried.push(`${attempt}:${error.message}`) }), 'shot');
  assert.equal(transports, 2);
  assert.deepEqual(retried, ['1:socket closed']);

  // And it stays bounded: the failure that survives the last attempt is the one thrown.
  let always = 0;
  const last = new DemoTransportError('the browser did not answer within 300s');
  await assert.rejects(retryTransport(async () => { always++; throw last; }, { attempts: 3, waitMs: 1 }), error => error === last);
  assert.equal(always, 3);

  class FakeSocket extends EventTarget {
    readyState = 0;
    sent = 0;
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    send(payload: string) {
      this.sent++;
      const { id, method } = JSON.parse(payload) as { id: number; method: string };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ id, error: { code: -32000, message: 'Execution context was destroyed' } }),
      })));
    }
  }
  const socket = new FakeSocket();
  const connecting = connectDemoSocket(socket as unknown as WebSocket, { timeoutMs: 100, handshakeMs: 100 });
  queueMicrotask(() => { socket.readyState = 1; socket.dispatchEvent(new Event('open')); });
  const connection = await connecting;
  let protocolAttempts = 0;
  await assert.rejects(retryTransport(async () => { protocolAttempts++; return connection.send('Runtime.evaluate'); }, { attempts: 2 }),
    error => error instanceof Error && error.message === 'Runtime.evaluate: Execution context was destroyed');
  assert.equal(protocolAttempts, 1);
  assert.equal(socket.sent, 1);
  connection.close();
});
