import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { RECORD_RECEIPT_SCHEMA, RECORD_SCHEMA, SHARING_NOTICE_VERSION } from '../../harness/src/shared/sharing.ts';
import { createInstallation, currentInstallation, linkContribution, markAccepted, prepareSharingDirs, storeRecords,
  sweepRetention, addDays, today } from '../src/sharing.ts';
import { startServer, tempDir } from './helpers.ts';

/** A whitelisted record the way a producer writes it (shared/sharing.ts validates it on both sides). */
const record = (id: string, outcome: 'success' | 'failure' = 'success') =>
  ({ id, category: 'tool-reliability', action: 'provider-run', outcome });
const batch = (batchId: string, records: unknown[]) => ({ schema: RECORD_SCHEMA, batchId, notice: SHARING_NOTICE_VERSION, records });

async function register(url: string): Promise<{ installId: string; token: string }> {
  const response = await fetch(`${url}/v1/installations`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 201);
  return await response.json() as { installId: string; token: string };
}
async function postRecords(url: string, token: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/v1/records`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test('a repeated batch id is stored once: 200 for the same records, 409 for different ones', async t => {
  const dataDir = tempDir(t), { url } = await startServer(t, { dataDir });
  const { installId, token } = await register(url);
  const batchId = 'a'.repeat(32), body = batch(batchId, [record('1'.repeat(32))]);
  const first = await postRecords(url, token, body);
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, { schema: RECORD_RECEIPT_SCHEMA, batchId, accepted: 1, status: 'stored' });

  // A retry after a lost answer is the same batch with the same bytes: the same receipt, no second copy.
  const again = await postRecords(url, token, body);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  assert.deepEqual(readdirSync(join(dataDir, 'installations', installId, 'records')), [`${batchId}.json`]);

  // The same id with changed records could duplicate or replace what the server already holds, so it is refused.
  const changed = await postRecords(url, token, batch(batchId, [record('1'.repeat(32), 'failure')]));
  assert.equal(changed.status, 409);
  assert.equal(typeof changed.body.error, 'string');
  assert.deepEqual(readdirSync(join(dataDir, 'installations', installId, 'records')), [`${batchId}.json`],
    'the refused batch changed nothing');

  // What the server holds, and when it goes, is readable by the installation that sent it.
  const status = await (await fetch(`${url}/v1/contributions/status`, { headers: { authorization: `Bearer ${token}` } })).json() as {
    retentionDays: number; records: Array<{ batchId: string; receivedDay: string; state: string; expiresDay: string }> };
  assert.equal(status.retentionDays, 90);
  assert.deepEqual(status.records.map(item => [item.batchId, item.state]), [[batchId, 'stored']]);
  assert.equal(status.records[0]!.expiresDay, addDays(status.records[0]!.receivedDay, 90),
    'an upload goes exactly one retention period after the day it arrived');
});

test('the startup sweep deletes a record batch on its retention day and keeps a younger one', async t => {
  const dataDir = tempDir(t);
  prepareSharingDirs(dataDir);
  const day = new Date('2026-01-01T00:00:00Z');
  const installation = createInstallation(dataDir, day);
  const old = 'a'.repeat(32), young = 'b'.repeat(32);
  // `createInstallation` returns the credential, not the stored record; `storeRecords` takes the installation itself.
  const stored = currentInstallation(dataDir, installation.installId)!;
  storeRecords(dataDir, stored, batch(old, [record('1'.repeat(32))]), day);
  storeRecords(dataDir, currentInstallation(dataDir, installation.installId)!, batch(young, [record('2'.repeat(32))]),
    new Date('2026-01-02T00:00:00Z'));

  // Retention is 90 days, so on 2026-04-01 only the batch received on 2026-01-01 is at or past its day.
  await startServer(t, { dataDir, retentionDays: 90, now: () => new Date('2026-04-01T00:00:00Z') });
  assert.deepEqual(readdirSync(join(dataDir, 'installations', installation.installId, 'records')), [`${young}.json`]);
  assert.equal(sweepRetention(dataDir, 90, new Date('2026-01-01T00:00:00Z')).recordBatches, 0,
    'nothing is swept before its day');
});

test('the sweep deletes an expired contribution with its marker and keeps one a release accepted', t => {
  const dataDir = tempDir(t);
  prepareSharingDirs(dataDir);
  const day = new Date('2026-01-01T00:00:00Z');
  const { installId } = createInstallation(dataDir, day);
  const expired = 'a'.repeat(32), accepted = 'b'.repeat(32);
  for (const receiptId of [expired, accepted]) {
    mkdirSync(join(dataDir, 'contributions', receiptId), { recursive: true });
    writeFileSync(join(dataDir, 'contributions', receiptId, 'meta.json'), JSON.stringify({ schema: 'harness-contribution/0.1',
      receiptId, candidateId: 'c'.repeat(32), installId, receivedAt: `${today(day)}T00:00:00.000Z` }));
    linkContribution(dataDir, installId, receiptId);
  }
  markAccepted(dataDir, 'release-2', [{ kind: 'contribution', id: accepted }], day);
  const result = sweepRetention(dataDir, 90, new Date('2026-04-01T00:00:00Z'));
  assert.equal(result.contributions, 1);
  assert.equal(existsSync(join(dataDir, 'contributions', expired)), false);
  assert.equal(existsSync(join(dataDir, 'contributions', accepted)), true, 'what a signed release accepted is kept');
  assert.deepEqual(readdirSync(join(dataDir, 'installations', installId, 'contributions')), [accepted]);
});

test('an installation idle past retention that holds nothing goes, with its token', t => {
  const dataDir = tempDir(t);
  prepareSharingDirs(dataDir);
  const stale = createInstallation(dataDir, new Date('2026-01-01T00:00:00Z'));
  const fresh = createInstallation(dataDir, new Date('2026-04-01T00:00:00Z'));
  const result = sweepRetention(dataDir, 90, new Date('2026-04-01T00:00:00Z'));
  assert.equal(result.installations, 1);
  assert.equal(existsSync(join(dataDir, 'installations', stale.installId)), false);
  assert.equal(existsSync(join(dataDir, 'installations', fresh.installId)), true);
  assert.equal(readdirSync(join(dataDir, 'tokens')).length, 1);
});
