import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readIfPresent, waitFor, waitScale, WAIT_SCALE_ENV, waitUntil } from './wait.ts';

// The helper exists because tests used to poll a fixed number of times and then read the artifact
// anyway: under load the read reported ENOENT for a file that had not been written yet. These tests
// pin the two properties that make the new shape safe: it returns the moment the fact is ready, and
// it throws — naming what was awaited and what was last observed — instead of returning on timeout.

test('a conditional wait resolves with the ready value and stops polling as soon as it is ready', async () => {
  let polls = 0;
  const value = await waitFor(() => { polls++; return polls >= 3 ? `poll-${polls}` : undefined; },
    { what: 'the third probe', timeoutMs: 5_000, intervalMs: 1 });
  assert.equal(value, 'poll-3');
  assert.equal(polls, 3, 'the wait must not keep polling after the fact is available');
});

test('a conditional wait that never becomes ready throws and names the fact and the last observation', async () => {
  await assert.rejects(
    waitFor(() => 'running', { what: 'the fixture unit to exit', ready: () => false, timeoutMs: 20, intervalMs: 5, detail: () => 'run dir /tmp/x' }),
    /timed out after 20ms waiting for the fixture unit to exit; last observed: running; run dir \/tmp\/x/);
});

test('waitUntil is the boolean form and also throws instead of returning on timeout', async () => {
  let ready = false;
  setTimeout(() => { ready = true; }, 10);
  await waitUntil(() => ready, { what: 'the fixture flag', timeoutMs: 5_000, intervalMs: 2 });
  await assert.rejects(waitUntil(() => false, { what: 'a flag that never flips', timeoutMs: 15, intervalMs: 5 }),
    /timed out after 15ms waiting for a flag that never flips/);
});

test(`${WAIT_SCALE_ENV} multiplies the budget, so a loaded machine can buy time without changing the fact`, async () => {
  assert.equal(waitScale(), 1);
  process.env[WAIT_SCALE_ENV] = '3';
  try {
    assert.equal(waitScale(), 3);
    await assert.rejects(waitFor(() => undefined, { what: 'the scaled fact', timeoutMs: 10, intervalMs: 1 }),
      /timed out after 30ms waiting for the scaled fact/);
  } finally { delete process.env[WAIT_SCALE_ENV]; }
});

test('readIfPresent reads a written file and reports an absent one as undefined, not ENOENT', () => {
  const root = mkdtempSync(join(tmpdir(), 'avh-wait-fixture-'));
  const path = join(root, 'later.json');
  assert.equal(readIfPresent(path), undefined);
  writeFileSync(path, '{"written":true}');
  assert.equal(readIfPresent(path), '{"written":true}');
});
