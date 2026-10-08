import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { CONTRIBUTION_ZONE, ContributionPacer, inContributionZone, retryAfterMs, sendPaced } from '../src/sharing/pacing.ts';
import { SHARING_PATHS } from '../src/shared/sharing.ts';

type StubReply = number | { status: number; headers?: Record<string, string> };
/** A stub deployment: it answers with the replies it was given, in order, and remembers when each request arrived. */
async function stub(t: test.TestContext, replies: StubReply[]): Promise<{ url: string; arrivals: number[] }> {
  const arrivals: number[] = [];
  let index = 0;
  const server = createServer((_request, response) => {
    arrivals.push(Date.now());
    const reply = replies[Math.min(index++, replies.length - 1)]!;
    const status = typeof reply === 'number' ? reply : reply.status;
    response.writeHead(status, { 'content-type': 'application/json', ...(typeof reply === 'number' ? {} : reply.headers ?? {}) });
    response.end(JSON.stringify({ error: `stub ${status}` }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stub deployment did not bind a port');
  return { url: `http://127.0.0.1:${address.port}`, arrivals };
}

const post = (url: string) => (): Promise<Response> => fetch(`${url}/v1/contributions`, { method: 'POST' });
/** 600 requests a minute is 100 ms a request: the same leaky bucket, small enough to test with. */
const quick = (): ContributionPacer => new ContributionPacer({ requestsPerMinute: 600 });

test('the contribution zone is exactly the two nginx paths, and its numbers are read from the deployed configuration', () => {
  assert.deepEqual([...CONTRIBUTION_ZONE.paths], ['/v1/installations', '/v1/contributions']);
  for (const path of CONTRIBUTION_ZONE.paths) assert.ok(inContributionZone(path), path);
  for (const path of ['/v1/records', '/v1/contributions/status', '/v1/consents/revoke', '/v1/health', '/v1/installations-x'])
    assert.equal(inContributionZone(path), false, path);
  // The same two paths the client actually posts to, so renaming one cannot quietly take it out of the pacing.
  assert.deepEqual([...CONTRIBUTION_ZONE.paths], [SHARING_PATHS.installations, SHARING_PATHS.contributions]);
  // The zone, its rate and its burst come from the file that declares them: a change there must show up as drift here.
  const config = readFileSync(new URL(`../../${CONTRIBUTION_ZONE.config}`, import.meta.url), 'utf8');
  assert.match(config, new RegExp(`zone=${CONTRIBUTION_ZONE.name}:\\d+m\\s+rate=${CONTRIBUTION_ZONE.requestsPerMinute}r/m`));
  assert.match(config, new RegExp(`limit_req zone=${CONTRIBUTION_ZONE.name} burst=${CONTRIBUTION_ZONE.burst} nodelay`));
});

test('a 429 from the limit is waited out and retried, and the application answer that follows is returned', async t => {
  const deployment = await stub(t, [429, 200]);
  const pacer = quick();
  const response = await sendPaced('/v1/contributions', post(deployment.url), { pacer });
  assert.equal(response.status, 200);
  assert.equal(deployment.arrivals.length, 2, 'the first answer was the proxy refusing, so the request went again');
  const gap = deployment.arrivals[1]! - deployment.arrivals[0]!;
  assert.ok(gap >= pacer.intervalMs - 25, `the retry waited ${gap} ms, less than the ${pacer.intervalMs} ms refill`);
});

test('a 429 is never handed back as the answer: once the attempts run out it is an error, not a pass', async t => {
  const deployment = await stub(t, [429]);
  await assert.rejects(sendPaced('/v1/contributions', post(deployment.url), { attempts: 3, pacer: quick() }),
    /answered HTTP 429 on all 3 attempts.*reverse proxy refusing, not an application answer/s);
  assert.equal(deployment.arrivals.length, 3);
});

test('a 403 is the application answering: it comes back once and is not confused with the proxy limit', async t => {
  const deployment = await stub(t, [403]);
  const response = await sendPaced('/v1/contributions', post(deployment.url), { attempts: 3, pacer: quick() });
  assert.equal(response.status, 403);
  assert.equal(deployment.arrivals.length, 1, 'a 403 answers the request, so asking again would only repeat it');
});

test('the delay the deployment names in Retry-After is used instead of the module’s own interval', async t => {
  const deployment = await stub(t, [{ status: 429, headers: { 'retry-after': '0' } }, 403]);
  // A 6r/m interval would be over ten seconds; the deployment said to come back at once.
  const started = Date.now();
  const response = await sendPaced('/v1/contributions', post(deployment.url), { pacer: new ContributionPacer() });
  assert.equal(response.status, 403);
  assert.ok(Date.now() - started < 5_000, `Retry-After was ignored: the request took ${Date.now() - started} ms`);
});

test('requests to the contribution zone keep to the deployment’s burst and refill rate', async t => {
  const deployment = await stub(t, [200]);
  const pacer = quick();
  for (let i = 0; i < 5; i++) assert.equal((await sendPaced('/v1/contributions', post(deployment.url), { pacer })).status, 200);
  const gaps = deployment.arrivals.slice(1).map((at, index) => at - deployment.arrivals[index]!);
  assert.equal(gaps.length, 4);
  assert.ok(gaps[0]! < pacer.intervalMs / 2, `the burst must go at once, not wait ${gaps[0]} ms`);
  // Requests 4 and 5 are past the burst, so each waits out the refill before it is sent.
  for (const gap of gaps.slice(CONTRIBUTION_ZONE.burst - 1)) assert.ok(gap >= pacer.intervalMs - 25, `a paced request went after only ${gap} ms`);
});

test('a path outside the zone is not paced: only the contribution endpoints share that budget', async t => {
  const deployment = await stub(t, [200]);
  const pacer = new ContributionPacer();  // 6r/m: pacing a health check at that rate would stall the whole run
  const started = Date.now();
  for (let i = 0; i < 4; i++) assert.equal((await sendPaced('/v1/health', () => fetch(`${deployment.url}/v1/health`), { pacer })).status, 200);
  assert.ok(Date.now() - started < 5_000, `an unzoned path was paced: 4 requests took ${Date.now() - started} ms`);
});

test('Retry-After parses the forms a proxy may send, and says nothing when there is none', () => {
  const reply = (value?: string): Response => new Response(null, { status: 429, headers: value === undefined ? {} : { 'retry-after': value } });
  assert.equal(retryAfterMs(reply('2')), 2_000);
  assert.equal(retryAfterMs(reply('0')), 0);
  assert.equal(retryAfterMs(reply('later')), undefined);
  assert.equal(retryAfterMs(reply()), undefined);
  const at = Date.parse('2026-10-04T12:00:00Z');
  assert.equal(retryAfterMs(reply(new Date(at + 5_000).toUTCString()), at), 5_000);
});

test('the online driver still proves revocation with the application’s 403 and paces through this module', () => {
  const source = readFileSync(new URL('../scripts/online-report-validation.mjs', import.meta.url), 'utf8');
  assert.match(source, /denied\.status === 403/, 'the driver must still require the application’s own 403');
  assert.doesNotMatch(source, /status\s*===?\s*429/, 'a 429 is the reverse proxy refusing: it may not stand in for an answer');
  assert.match(source, /sendPaced\(/, 'the driver must pace the contribution zone through the shared module');
  assert.match(source, /ContributionPacer\(/, 'the driver must spend the zone budget on purpose, not discover it as 429');
});
