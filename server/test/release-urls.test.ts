import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyReleaseUrls } from '../src/release-urls.ts';

test('verifyReleaseUrls reads each URL with HEAD and treats only 200 as published', async () => {
  const seen: Array<{ url: string; method: string | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, method: init?.method });
    return new Response(null, { status: url.endsWith('/present.exe') ? 200 : 404 });
  };
  const readings = await verifyReleaseUrls(['https://harness.test/present.exe', 'https://harness.test/missing.exe'], fetcher);
  assert.deepEqual(seen, [
    { url: 'https://harness.test/present.exe', method: 'HEAD' },
    { url: 'https://harness.test/missing.exe', method: 'HEAD' },
  ]);
  assert.deepEqual(readings, [
    { url: 'https://harness.test/present.exe', status: 200, ok: true },
    { url: 'https://harness.test/missing.exe', status: 404, ok: false },
  ]);
});

test('a URL that cannot be reached is a reading, not a thrown error', async () => {
  const offline: typeof fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const readings = await verifyReleaseUrls(['https://harness.test/offline'], offline);
  assert.deepEqual(readings, [{ url: 'https://harness.test/offline', status: 0, ok: false, error: 'getaddrinfo ENOTFOUND' }]);
});
