import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { cancelPendingContributions } from './contribution-cleanup.ts';
import { DEFAULT_RETENTION_DAYS, MAX_QUEUE_DAYS, MAX_QUEUED_RECORDS, SHARING_NOTICE_VERSION, validateRecord,
  type SharingRecord } from '../shared/sharing.ts';

/**
 * Contribution sharing on this computer: the person's choices, the state they add up to, and the bounded queue of
 * records waiting for upload (migration 0026). Sharing starts only after the person explicitly joins; nothing is queued or sent
 * until they have seen the current notice (SHARING_NOTICE_VERSION). Turning it off stops sending and empties the queue.
 *
 * Correction to migration 0026: its first line reads "Sharing is on unless the person turned it off", which is the
 * opposite of this contract and was never true after the notice-2 revision. Sharing here is explicit opt-in — `active`
 * requires an explicit `enabled` under the current notice version plus a shown notice. The published migration is not
 * rewritten (its comment is inert and rewriting it would change an applied migration), so this module is the contract.
 */
export type SharingSurface = 'gui-setup' | 'gui' | 'tui-setup' | 'tui' | 'cli' | 'runtime';
export const SHARING_SURFACES: readonly SharingSurface[] = ['gui-setup', 'gui', 'tui-setup', 'tui', 'cli', 'runtime'];
type ConsentAction = 'notice_shown' | 'enabled' | 'disabled' | 'registered' | 'revoke_requested' | 'revoked';

export interface SharingState {
  /** What the person chose, if anything. Without a choice no sharing is active. */
  choice: 'on' | 'off' | null;
  /** The channel is open: records may be queued once the notice was shown; contributions go after their own authorization. */
  enabled: boolean;
  noticeVersion: number;
  /** When this notice version was first shown; null until then. */
  noticeShownAt: string | null;
  /** Show the notice now: sharing is not off, and this notice version has not been shown. */
  needsNotice: boolean;
  /** Records are queued and sent: on, the notice shown, and no revocation waiting for the server. */
  active: boolean;
  /** Since when sharing has been active without a break. What happened before it is never harvested (no backfill). */
  activeSince: string | null;
  /** This computer's installation on the sharing server; its token is a credential in config/secrets. */
  installation: { installId: string; server: string; registeredAt: string } | null;
  /** A revocation the server has not confirmed yet: this computer has stopped, the server still holds the data. */
  revokePending: { installId: string; server: string; requestedAt: string } | null;
  lastRevocation: { at: string; remote: string; recordBatches: number; records: number; contributions: number; retained: number } | null;
  counts: { queued: number; sent: number; rejected: number };
  pendingReports: number;
}

const now = (): string => new Date().toISOString();
export const randomRecordId = (): string => randomBytes(16).toString('hex');

export function recordConsent(db: DatabaseSync, action: ConsentAction, surface: SharingSurface, detail: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO sharing_consent (action, notice_version, surface, detail_json) VALUES (?, ?, ?, ?)')
    .run(action, ['notice_shown','enabled'].includes(action) ? SHARING_NOTICE_VERSION : null, surface, JSON.stringify(detail));
}

/** The state the consent log adds up to, folded in order. */
export function sharingState(db: DatabaseSync): SharingState {
  const rows = db.prepare('SELECT action, notice_version AS version, detail_json AS detail, recorded_at AS at FROM sharing_consent ORDER BY seq')
    .all() as Array<{ action: ConsentAction; version: number | null; detail: string; at: string }>;
  let choice: SharingState['choice'] = null, noticeShownAt: string | null = null, activeSince: string | null = null;
  let installation: SharingState['installation'] = null, revokePending: SharingState['revokePending'] = null;
  let lastRevocation: SharingState['lastRevocation'] = null;
  const isActive = () => choice === 'on' && noticeShownAt !== null && revokePending === null;
  for (const row of rows) {
    const before = isActive(), detail = JSON.parse(row.detail) as Record<string, unknown>;
    if (row.action === 'notice_shown' && row.version === SHARING_NOTICE_VERSION) noticeShownAt ??= row.at;
    else if (row.action === 'enabled') choice = row.version === SHARING_NOTICE_VERSION ? 'on' : null;
    else if (row.action === 'disabled') choice = 'off';
    else if (row.action === 'registered') installation = { installId: String(detail.installId), server: String(detail.server), registeredAt: row.at };
    else if (row.action === 'revoke_requested') revokePending = { installId: String(detail.installId), server: String(detail.server), requestedAt: row.at };
    else if (row.action === 'revoked') {
      revokePending = null; installation = null;
      const removed = (detail.removed ?? {}) as Record<string, unknown>;
      lastRevocation = { at: row.at, remote: String(detail.remote ?? 'revoked'), recordBatches: Number(removed.recordBatches ?? 0),
        records: Number(removed.records ?? 0), contributions: Array.isArray(removed.contributions) ? removed.contributions.length : 0,
        retained: Array.isArray(detail.retained) ? detail.retained.length : 0 };
    }
    if (!before && isActive()) activeSince = row.at;
    if (!isActive()) activeSince = null;
  }
  const counts = { queued: 0, sent: 0, rejected: 0 };
  for (const row of db.prepare('SELECT status, count(*) AS n FROM sharing_record GROUP BY status').all() as Array<{ status: keyof typeof counts; n: number }>)
    counts[row.status] = row.n;
  return { choice, enabled: choice === 'on', noticeVersion: SHARING_NOTICE_VERSION, noticeShownAt,
    needsNotice: choice !== 'off' && noticeShownAt === null, active: isActive(), activeSince, installation, revokePending, lastRevocation, counts, pendingReports:Number(db.prepare("SELECT count(*) AS n FROM managed_pack_contribution WHERE status IN ('authorized','exported','failed')").get()!.n) };
}

/**
 * The person's answer, from the notice or from settings: `noticeShown` records that they saw the current notice,
 * `enabled` records an explicit on or off. Turning sharing off empties the queue at once.
 */
export function chooseSharing(db: DatabaseSync, choice: { surface: SharingSurface; noticeShown?: boolean; enabled?: boolean }, home?: string): SharingState {
  if (!SHARING_SURFACES.includes(choice.surface)) throw new Error(`未知的界面：${String(choice.surface)}`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const wasActive=sharingState(db).active;
    if (choice.noticeShown && sharingState(db).noticeShownAt === null) recordConsent(db, 'notice_shown', choice.surface);
    if (choice.enabled !== undefined) {
      const discardedBeforeJoin=choice.enabled&&!wasActive?Number(db.prepare("DELETE FROM sharing_record WHERE status='queued'").run().changes):0;
      recordConsent(db, choice.enabled ? 'enabled' : 'disabled', choice.surface,discardedBeforeJoin?{discardedBeforeJoin}:{});
      if (!choice.enabled) db.prepare("DELETE FROM sharing_record WHERE status = 'queued'").run();
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if(choice.enabled===false)cancelPendingContributions(db,home);
  return sharingState(db);
}

export type SharingRecordInput = Omit<SharingRecord, 'id'> & { id?: string };
export type QueueOutcome = { queued: true; id: string } | { queued: false; reason: 'off' | 'notice' | 'duplicate' };
/**
 * The one way a producer shares a record: tool reliability from finished Provider Runs (producers.ts), and asset
 * compatibility, repair and classification records from the producers that come later. The record is checked against
 * the whitelist first (shared/sharing.ts), so a producer that puts in anything else fails loudly with RecordError.
 * While sharing is off, or the notice has not been shown, the record is dropped, not kept for later. `source` is a local
 * key (a Run id, say) that keeps the same event from being queued twice; it never leaves this computer.
 */
export function queueSharingRecord(db: DatabaseSync, input: SharingRecordInput, options: { source?: string } = {}): QueueOutcome {
  const record = validateRecord({ ...input, id: input.id ?? randomRecordId() });
  const state = sharingState(db);
  if (!state.active) return { queued: false, reason: state.enabled ? 'notice' : 'off' };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (options.source && !Number(db.prepare('INSERT OR IGNORE INTO sharing_source (ref) VALUES (?)').run(options.source).changes)) {
      db.exec('ROLLBACK');
      return { queued: false, reason: 'duplicate' };
    }
    db.prepare('INSERT INTO sharing_record (id, category, record_json) VALUES (?, ?, ?)').run(record.id, record.category, JSON.stringify(record));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  pruneSharingQueue(db);
  return { queued: true, id: record.id };
}
/** Marks a producer's event as handled without a record (one the whitelist cannot describe), so it is not looked at again. */
export function markSharingSource(db: DatabaseSync, source: string): void {
  db.prepare('INSERT OR IGNORE INTO sharing_source (ref) VALUES (?)').run(source);
}

/**
 * Keeps the queue bounded: unsent records older than MAX_QUEUE_DAYS, or beyond the newest MAX_QUEUED_RECORDS, are
 * dropped; sent and rejected ones are listed until the server would have deleted them anyway.
 */
export function pruneSharingQueue(db: DatabaseSync, at = new Date()): void {
  const days = (count: number) => new Date(at.getTime() - count * 86_400_000).toISOString();
  // A claimed batch may already be stored remotely despite a lost receipt. Never retry its id with changed bytes,
  // or move its surviving records to a new batch and duplicate them. Expire the still-pending batch as a unit.
  db.prepare(`DELETE FROM sharing_record WHERE status='queued' AND batch_id IN (SELECT batch_id FROM sharing_record
    WHERE status='queued' AND batch_id IS NOT NULL AND created_at < ?)`).run(days(MAX_QUEUE_DAYS));
  db.prepare("DELETE FROM sharing_record WHERE status = 'queued' AND created_at < ?").run(days(MAX_QUEUE_DAYS));
  db.prepare(`DELETE FROM sharing_record WHERE status='queued' AND batch_id IN (SELECT batch_id FROM sharing_record
    WHERE id IN (SELECT id FROM sharing_record WHERE status='queued' ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?)
    AND batch_id IS NOT NULL)`).run(MAX_QUEUED_RECORDS);
  db.prepare(`DELETE FROM sharing_record WHERE id IN (SELECT id FROM sharing_record WHERE status = 'queued'
    ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`).run(MAX_QUEUED_RECORDS);
  db.prepare("DELETE FROM sharing_record WHERE status IN ('sent', 'rejected') AND COALESCE(sent_at, created_at) < ?").run(days(DEFAULT_RETENTION_DAYS));
  // Producers only look back MAX_QUEUE_DAYS, so older keys can no longer match anything.
  db.prepare('DELETE FROM sharing_source WHERE seen_at < ?').run(days(2 * MAX_QUEUE_DAYS));
}

export interface LocalRecord { id: string; category: string; status: 'queued' | 'sent' | 'rejected'; record: SharingRecord;
  error: string | null; createdAt: string; sentAt: string | null }
/** The records on this computer, newest first: what will be sent, and what was. */
export function sharingRecords(db: DatabaseSync, options: { status?: LocalRecord['status']; limit?: number } = {}): LocalRecord[] {
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 50)));
  const rows = (options.status
    ? db.prepare('SELECT * FROM sharing_record WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(options.status, limit)
    : db.prepare('SELECT * FROM sharing_record ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit)) as Array<Record<string, unknown>>;
  return rows.map(row => ({ id: String(row.id), category: String(row.category), status: row.status as LocalRecord['status'],
    record: JSON.parse(String(row.record_json)) as SharingRecord, error: row.error as string | null, createdAt: String(row.created_at),
    sentAt: row.sent_at as string | null }));
}

/** The next batch to send: one already given an id and not confirmed yet, or up to `size` queued records under a new id. */
export function claimSharingBatch(db: DatabaseSync, size: number): { batchId: string; records: SharingRecord[] } | undefined {
  db.exec('BEGIN IMMEDIATE');
  try {
    let batchId = (db.prepare(`SELECT batch_id AS id FROM sharing_record WHERE status = 'queued' AND batch_id IS NOT NULL
      ORDER BY created_at, rowid LIMIT 1`).get() as { id: string } | undefined)?.id;
    if (!batchId) {
      batchId = randomRecordId();
      const claimed = db.prepare(`UPDATE sharing_record SET batch_id = ? WHERE id IN (SELECT id FROM sharing_record
        WHERE status = 'queued' AND batch_id IS NULL ORDER BY created_at, rowid LIMIT ?)`).run(batchId, size).changes;
      if (!Number(claimed)) { db.exec('COMMIT'); return undefined; }
    }
    const records = (db.prepare("SELECT record_json FROM sharing_record WHERE batch_id = ? AND status = 'queued' ORDER BY created_at, rowid")
      .all(batchId) as Array<{ record_json: string }>).map(row => JSON.parse(row.record_json) as SharingRecord);
    db.exec('COMMIT');
    return { batchId, records };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function settleSharingBatch(db: DatabaseSync, batchId: string, outcome: { sent: true } | { sent: false; error: string }): number {
  return Number((outcome.sent
    ? db.prepare(`UPDATE sharing_record SET status = 'sent', sent_at = ?, error = NULL WHERE batch_id = ? AND status = 'queued'`).run(now(), batchId)
    : db.prepare(`UPDATE sharing_record SET status = 'rejected', error = ? WHERE batch_id = ? AND status = 'queued'`)
      .run(outcome.error.slice(0, 2000), batchId)).changes);
}
/** After a confirmed revocation the local copies go too: they describe data the server no longer holds. */
export function forgetSharingRecords(db: DatabaseSync): void {
  db.prepare('DELETE FROM sharing_record').run();
}
