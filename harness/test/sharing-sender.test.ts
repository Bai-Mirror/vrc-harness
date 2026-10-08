import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/state/db.ts';
import { chooseSharing, queueSharingRecord, sharingState } from '../src/sharing/state.ts';
import { revokeSharing } from '../src/sharing/client.ts';
import { SharingSender, SHARING_SEND_INTERVAL_MS, SHARING_SEND_MAX_BACKOFF_MS } from '../src/sharing/sender.ts';
import { DEFAULT_BACKUP_DAYS, MAX_BATCH_RECORDS, RECORD_RECEIPT_SCHEMA, SHARING_NOTICE_VERSION, sharingNotice } from '../src/shared/sharing.ts';
import { removeTemp } from './fixtures/platform.ts';

const INSTALL_ID = 'a'.repeat(32);
const TOKEN = `hst_${'b'.repeat(43)}`;
const SERVER = 'https://contrib.test';

function fixture(t: test.TestContext): { root: string; home: string; db: ReturnType<typeof openDatabase> } {
  const root = mkdtempSync(join(tmpdir(), 'avh-sharing-sender-'));
  t.after(() => removeTemp(root));
  const home = join(root, 'home');
  const db = openDatabase(join(root, 'state.db'));
  t.after(() => db.close());
  return { root, home, db };
}

interface Uploaded { batchId: string; notice: number; records: Array<{ id: string; category: string }> }
/** The contribution server as the client sees it, recording every request so a counterexample can assert none. */
function serverMock(mode: { failing: boolean } = { failing: false }): { calls: string[]; bodies: Uploaded[]; fetcher: typeof fetch } {
  const calls: string[] = [], bodies: Uploaded[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (mode.failing) return Response.json({ error: 'offline' }, { status: 503 });
    if (url.endsWith('/v1/installations'))
      return Response.json({ schema: 'harness-installation/0.1', installId: INSTALL_ID, token: TOKEN, retentionDays: 90 }, { status: 201 });
    if (url.endsWith('/v1/records')) {
      const body = JSON.parse(String(init?.body)) as Uploaded;
      bodies.push(body);
      return Response.json({ schema: RECORD_RECEIPT_SCHEMA, batchId: body.batchId, accepted: body.records.length, status: 'stored' }, { status: 201 });
    }
    if (url.endsWith('/v1/consents/revoke'))
      return Response.json({ schema: 'harness-revocation/0.1', installId: INSTALL_ID, revoked: true, alreadyRevoked: false,
        removed: { recordBatches: 1, records: 1, contributions: [] }, retained: [] });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { calls, bodies, fetcher };
}

/** Drives the sender's timer without waiting: it records what was scheduled and fires one callback at a time. */
function fakeClock(): { setTimer: (callback: () => void, ms: number) => unknown; clearTimer: (handle: unknown) => void;
  delays: () => number[]; fire: () => Promise<void> } {
  let sequence = 0;
  const queue: Array<{ id: number; ms: number; callback: () => void }> = [];
  return {
    setTimer: (callback, ms) => { const entry = { id: ++sequence, ms, callback }; queue.push(entry); return entry; },
    clearTimer: handle => { const index = queue.findIndex(entry => entry === handle); if (index >= 0) queue.splice(index, 1); },
    delays: () => queue.map(entry => entry.ms),
    fire: async () => {
      const entry = queue.shift();
      assert.ok(entry, 'a timer callback is scheduled');
      entry.callback();
      for (let round = 0; round < 10; round++) await new Promise(resolve => setTimeout(resolve, 0));
    },
  };
}

function joined(f: { db: ReturnType<typeof openDatabase>; home: string }): void {
  chooseSharing(f.db, { surface: 'gui', noticeShown: true, enabled: true }, f.home);
}

test('the timer batches every allowed category and sends it without any manual flush', async t => {
  const f = fixture(t); joined(f);
  queueSharingRecord(f.db, { category: 'tool-reliability', action: 'provider-run', outcome: 'failure' });
  queueSharingRecord(f.db, { category: 'asset-compat', action: 'fit-check', outcome: 'success' });
  assert.equal(sharingState(f.db).counts.queued, 2);
  const server = serverMock(), clock = fakeClock();
  const sender = new SharingSender({ db: f.db, home: f.home, server: SERVER, fetcher: server.fetcher,
    intervalMs: 100, maxBackoffMs: 400, ...clock });
  t.after(() => sender.stop());
  sender.start();
  assert.deepEqual(clock.delays(), [100], 'the sender waits one interval before its first attempt');
  await clock.fire();

  const uploads = server.calls.filter(url => url.endsWith('/v1/records'));
  assert.equal(uploads.length, 1, 'one batch carries the records of every valid category');
  assert.deepEqual(server.bodies[0]!.records.map(record => record.category).sort(), ['asset-compat', 'tool-reliability']);
  assert.equal(server.bodies[0]!.notice, SHARING_NOTICE_VERSION);
  assert.deepEqual(sharingState(f.db).counts, { queued: 0, sent: 2, rejected: 0 });
  assert.ok(sender.status().lastSentAt);
  assert.deepEqual(clock.delays(), [100], 'a success returns to the base interval');
});

test('a timer attempt before the person joins sends nothing, not even an installation request', async t => {
  const f = fixture(t);
  chooseSharing(f.db, { surface: 'gui', noticeShown: true }, f.home);
  // A record left by the old default-on contract, before the revised notice: it must not leave through the sender.
  const record = (id: string) => JSON.stringify({ id, category: 'tool-reliability', action: 'provider-run', outcome: 'failure' });
  f.db.prepare("INSERT INTO sharing_record(id,category,record_json) VALUES(?, 'tool-reliability', ?)").run('c'.repeat(32), record('c'.repeat(32)));
  const server = serverMock(), clock = fakeClock();
  const sender = new SharingSender({ db: f.db, home: f.home, server: SERVER, fetcher: server.fetcher,
    intervalMs: 100, maxBackoffMs: 400, ...clock });
  t.after(() => sender.stop());
  sender.start();
  await clock.fire();
  // `assert.equal` on the length, not `deepEqual(calls, [])`: the assertion signature would narrow `calls` to never[].
  assert.equal(server.calls.length, 0, 'nothing is sent while the person has not joined');
  assert.equal(sender.status().lastAttemptAt, null, 'the guard runs before any attempt is recorded');
  assert.equal(sharingState(f.db).counts.queued, 1, 'the unjoined computer keeps its own record');

  // The guard is live, not a start-up decision: joining makes the next timer attempt carry new records.
  joined(f);
  assert.equal(sharingState(f.db).counts.queued, 0, 'joining discards what was queued before the change of choice');
  queueSharingRecord(f.db, { category: 'tool-reliability', action: 'provider-run', outcome: 'success' });
  await clock.fire();
  assert.equal(server.calls.filter(url => url.endsWith('/v1/records')).length, 1);
  assert.equal(sharingState(f.db).counts.sent, 1);
});

test('after a confirmed revocation the sender never sends the old payload again', async t => {
  const f = fixture(t); joined(f);
  queueSharingRecord(f.db, { category: 'tool-reliability', action: 'provider-run', outcome: 'failure' });
  const server = serverMock(), clock = fakeClock();
  const sender = new SharingSender({ db: f.db, home: f.home, server: SERVER, fetcher: server.fetcher,
    intervalMs: 100, maxBackoffMs: 400, ...clock });
  t.after(() => sender.stop());
  sender.start();
  await clock.fire();
  assert.equal(sharingState(f.db).counts.sent, 1);

  queueSharingRecord(f.db, { category: 'tool-reliability', action: 'provider-run', outcome: 'failure' });
  await revokeSharing(f.db, f.home, server.fetcher);
  assert.equal(sharingState(f.db).active, false);
  assert.equal(sharingState(f.db).counts.queued, 0, 'revocation empties the unsent queue');
  const before = server.calls.length;
  await clock.fire();
  assert.equal(server.calls.length, before, 'a revoked installation opens no request, not even to register again');
  assert.equal(sharingState(f.db).counts.sent, 0, 'the local copies of what the server no longer holds are gone');
});

test('a failing attempt backs off to the cap and a working attempt returns to the base interval', async t => {
  const f = fixture(t); joined(f);
  queueSharingRecord(f.db, { category: 'tool-reliability', action: 'provider-run', outcome: 'success' });
  const mode = { failing: true }, server = serverMock(mode), clock = fakeClock();
  const sender = new SharingSender({ db: f.db, home: f.home, server: SERVER, fetcher: server.fetcher,
    intervalMs: 100, maxBackoffMs: 400, ...clock });
  t.after(() => sender.stop());
  sender.start();
  const delays: number[] = [];
  for (let attempt = 0; attempt < 4; attempt++) { delays.push(clock.delays()[0]!); await clock.fire(); }
  assert.deepEqual(delays, [100, 200, 400, 400], 'each failure doubles the wait until the cap');
  assert.equal(sender.status().backoffMs, 400);
  assert.equal(sharingState(f.db).counts.queued, 1, 'a failed attempt leaves the batch queued');
  assert.match(sender.status().lastError ?? '', /503/);
  assert.equal(clock.delays()[0], 400, 'the sender keeps trying at the cap, it does not give up');

  mode.failing = false;
  await clock.fire();
  assert.equal(sharingState(f.db).counts.sent, 1);
  assert.equal(sender.status().backoffMs, 100, 'recovery returns to the base interval');
  assert.equal(sender.status().lastError, null);
});

test('a restart after being offline resumes at the base interval and sends what is still queued', async t => {
  const f = fixture(t); joined(f);
  queueSharingRecord(f.db, { category: 'tool-reliability', action: 'provider-run', outcome: 'success' });
  const offline = serverMock({ failing: true }), firstClock = fakeClock();
  const first = new SharingSender({ db: f.db, home: f.home, server: SERVER, fetcher: offline.fetcher,
    intervalMs: 100, maxBackoffMs: 400, ...firstClock });
  first.start();
  await firstClock.fire(); await firstClock.fire();
  assert.equal(first.status().backoffMs, 400);
  first.stop();
  assert.deepEqual(firstClock.delays(), [], 'a stopped sender leaves no timer behind');

  const online = serverMock(), secondClock = fakeClock();
  const second = new SharingSender({ db: f.db, home: f.home, server: SERVER, fetcher: online.fetcher,
    intervalMs: 100, maxBackoffMs: 400, ...secondClock });
  t.after(() => second.stop());
  assert.equal(second.status().backoffMs, 100, 'the in-memory backoff is gone after a restart');
  second.start();
  assert.deepEqual(secondClock.delays(), [100]);
  await secondClock.fire();
  assert.equal(sharingState(f.db).counts.sent, 1, 'the queued record survived the restart');
  assert.equal(sharingState(f.db).counts.queued, 0);
});

test('one attempt drains a queue larger than a single batch without waiting another interval', async t => {
  const f = fixture(t); joined(f);
  for (let index = 0; index < MAX_BATCH_RECORDS + 10; index++)
    queueSharingRecord(f.db, { category: 'tool-reliability', action: 'provider-run', outcome: 'success' });
  const server = serverMock(), clock = fakeClock();
  const sender = new SharingSender({ db: f.db, home: f.home, server: SERVER, fetcher: server.fetcher,
    intervalMs: 100, maxBackoffMs: 400, ...clock });
  t.after(() => sender.stop());
  const result = await sender.attempt();
  assert.deepEqual(result, { sent: MAX_BATCH_RECORDS + 10, pending: 0 });
  assert.equal(server.calls.filter(url => url.endsWith('/v1/records')).length, 2);
  assert.deepEqual(sharingState(f.db).counts, { queued: 0, sent: MAX_BATCH_RECORDS + 10, rejected: 0 });
});

test('overlapping attempts cannot double-send a claimed batch', async t => {
  const f = fixture(t); joined(f);
  queueSharingRecord(f.db, { category: 'tool-reliability', action: 'provider-run', outcome: 'success' });
  const server = serverMock(), clock = fakeClock();
  const sender = new SharingSender({ db: f.db, home: f.home, server: SERVER, fetcher: server.fetcher,
    intervalMs: 100, maxBackoffMs: 400, ...clock });
  t.after(() => sender.stop());
  const [first, second] = await Promise.all([sender.attempt(), sender.attempt()]);
  assert.equal(first.sent + second.sent, 1, 'the second concurrent attempt finds the batch already claimed');
  assert.equal(server.calls.filter(url => url.endsWith('/v1/records')).length, 1);
});

test('the default interval and cap are the documented constants', t => {
  const f = fixture(t);
  const sender = new SharingSender({ db: f.db, home: f.home, server: SERVER });
  assert.deepEqual(sender.status(), { running: false, intervalMs: SHARING_SEND_INTERVAL_MS, backoffMs: SHARING_SEND_INTERVAL_MS,
    lastAttemptAt: null, lastSentAt: null, lastError: null });
  assert.ok(SHARING_SEND_MAX_BACKOFF_MS > SHARING_SEND_INTERVAL_MS);
});

test('the notice a person consents to describes sending as automatic and names the backup tail', () => {
  const notice = sharingNotice({ server: SERVER });
  assert.match(notice.summary, /发回/);
  assert.match(notice.queue, /自动批量发送/, 'the consent text must match what the Runtime now does by itself');
  assert.equal(DEFAULT_BACKUP_DAYS, 90, 'the operator snapshots are kept about ninety days');
  assert.match(notice.retention, /删除或撤回后，数据在运营者的备份中最多再保留 90 天/,
    'a person must be told that deleting or revoking still leaves it in a backup for a while');
  const stated = sharingNotice({ server: SERVER, retentionDays: 30, backupDays: 7 }).retention;
  assert.match(stated, /服务器保存 30 天后自动删除[\s\S]*最多再保留 7 天/, 'a server that states other periods is quoted as-is');
});
