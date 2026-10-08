import assert from 'node:assert/strict';
import test from 'node:test';
import { clueText, parseClue, politeFetch, probeFile, sameVersion } from '../../src/booth/remote.ts';

const SIGNED = new URL('https://cdn.example/files/%E8%A1%A3%E8%A3%85.zip?X-Amz-Signature=secret-signature&X-Amz-Expires=60');

/** A body that records whether anyone read it or cancelled it; highWaterMark 0 so nothing is pulled unasked. */
function watchedBody(size = 1 << 20) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { seen.pulled++; controller.enqueue(new Uint8Array(size)); },
    cancel() { seen.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, seen };
}
type Answer = (method: string, headers: Record<string, string>, signal?: AbortSignal) => Response | Promise<Response>;
function fileHost(answer: Answer) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    calls.push({ method: init?.method ?? 'GET', url: String(input), headers });
    return answer(init?.method ?? 'GET', headers, init?.signal ?? undefined);
  }) as typeof fetch;
  return { request: politeFetch('secret-session-value', { fetcher, intervalMs: 0 }, { requests: 0 }), calls };
}

test('a HEAD with a length sizes the file and nothing else is sent', async () => {
  const { request, calls } = fileHost(() => new Response(null, { headers: { 'content-length': '2048', etag: '"v1"',
    'last-modified': 'Wed, 30 Sep 2026 01:00:00 GMT' } }));
  assert.deepEqual(await probeFile(request, SIGNED), { size: 2048, etag: '"v1"', lastModified: 'Wed, 30 Sep 2026 01:00:00 GMT', outcome: 'head:ok' });
  assert.deepEqual(calls.map(call => call.method), ['HEAD']);
});

test('a signed URL that refuses HEAD is sized by a one-byte Range GET whose body is never read', async () => {
  const { body, seen } = watchedBody();
  const { request, calls } = fileHost(method => method === 'HEAD'
    ? new Response('<Error>SignatureDoesNotMatch</Error>', { status: 403, headers: { 'content-type': 'application/xml' } })
    : new Response(body, { status: 206, headers: { 'content-range': 'bytes 0-0/734003200', etag: '"v2"' } }));
  assert.deepEqual(await probeFile(request, SIGNED), { size: 734003200, etag: '"v2"', outcome: 'head:http-403 range:ok' });
  assert.deepEqual(calls.map(call => [call.method, call.headers.range]), [['HEAD', undefined], ['GET', 'bytes=0-0']]);
  assert.equal(seen.pulled, 0, 'the body is not read');
  assert.equal(seen.cancelled, true, 'the body is cut off');
  // The file host never gets the BOOTH session.
  assert.ok(calls.every(call => !('cookie' in call.headers)));
});

test('a server that ignores Range and answers 200 gives its Content-Length and is cut off without sending the file', async () => {
  const { body, seen } = watchedBody();
  const { request } = fileHost(method => method === 'HEAD' ? new Response(null, { headers: { 'content-type': 'application/zip' } })
    : new Response(body, { status: 200, headers: { 'content-length': '5000000' } }));
  assert.deepEqual(await probeFile(request, SIGNED), { size: 5000000, outcome: 'head:no-length range:ok' });
  assert.equal(seen.pulled, 0);
  assert.equal(seen.cancelled, true);
});

test('when both steps fail the size stays unknown and the outcome says why, never with the signed URL', async () => {
  const cases: Array<[Answer, string]> = [
    [() => new Response(null, { status: 403 }), 'head:http-403 range:http-403'],
    [method => { if (method === 'HEAD') throw new DOMException('The operation timed out.', 'TimeoutError'); throw new TypeError('fetch failed'); },
      'head:timeout range:network'],
    [method => method === 'HEAD' ? new Response(null, { status: 405 }) : new Response(null, { status: 206, headers: { 'content-range': 'bytes 0-0/*' } }),
      'head:http-405 range:no-total'],
    // A 200 error page is not the file, whatever its length says.
    [() => new Response('<html>denied</html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': '19' } }),
      'head:html range:html'],
    [() => new Response(null, { status: 200 }), 'head:no-length range:no-length'],
  ];
  for (const [answer, outcome] of cases) {
    const probe = await probeFile(fileHost(answer).request, SIGNED);
    assert.deepEqual(probe, { outcome }, outcome);
    assert.doesNotMatch(JSON.stringify(probe), /secret-signature|cdn\.example/);
  }
});

test('an empty file answers the Range GET with 416 and its total', async () => {
  const { request } = fileHost(method => method === 'HEAD' ? new Response(null, { status: 403 })
    : new Response(null, { status: 416, headers: { 'content-range': 'bytes */0' } }));
  assert.deepEqual(await probeFile(request, SIGNED), { size: 0, outcome: 'head:http-403 range:ok' });
});

test('a probe that does not answer in time counts as timed out', async () => {
  // A host that never answers; like fetch, the request ends when the probe's signal aborts.
  const { request } = fileHost((_method, _headers, signal) => new Promise<Response>((_, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
  }));
  assert.deepEqual(await probeFile(request, SIGNED, 20), { outcome: 'head:timeout range:timeout' });
});

test('clues: canonical text, and a version is confirmed only by name and size plus any ETag and Last-Modified both sides know', () => {
  assert.equal(clueText({ size: 3, name: 'a.zip', lastModified: 'x', etag: '"e"' } as never), '{"name":"a.zip","size":3,"etag":"\\"e\\"","lastModified":"x"}');
  assert.deepEqual(parseClue(clueText({ name: 'a.zip', size: 3 })), { name: 'a.zip', size: 3 });
  assert.equal(parseClue(''), undefined);
  assert.equal(parseClue('not json'), undefined);
  const known = { name: 'a.zip', size: 3, etag: '"e1"' };
  assert.equal(sameVersion(known, { name: 'a.zip', size: 3 }), true, 'no ETag now: name and size decide');
  assert.equal(sameVersion(known, { name: 'a.zip', size: 3, etag: '"e1"', lastModified: 'x' }), true);
  assert.equal(sameVersion(known, { name: 'a.zip', size: 3, etag: '"e2"' }), false, 'a changed ETag is a new version');
  assert.equal(sameVersion(known, { name: 'b.zip', size: 3, etag: '"e1"' }), false, 'a renamed file is a new version');
  assert.equal(sameVersion(known, { name: 'a.zip', size: 4, etag: '"e1"' }), false);
  assert.equal(sameVersion(known, { name: 'a.zip', etag: '"e1"' }), false, 'without a size nothing is confirmed');
  assert.equal(sameVersion({ name: 'a.zip', size: 3, lastModified: 'x' }, { name: 'a.zip', size: 3, lastModified: 'y' }), false);
});
