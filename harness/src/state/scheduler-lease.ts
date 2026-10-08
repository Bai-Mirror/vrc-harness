import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';

const TTL_MS = 60_000;
const RENEW_MS = 5_000;
type LeaseRow = { holder: string | null; host: string | null; pid: number | null; cycle: number; expires_at: string | null };

function currentLease(db: DatabaseSync): LeaseRow {
  const row = db.prepare('SELECT holder, host, pid, cycle, expires_at FROM scheduler_lease WHERE id = 1').get() as LeaseRow | undefined;
  if (!row) throw new Error('Scheduler lease row missing');
  return row;
}
function liveOnThisHost(state: LeaseRow): boolean {
  if (state.host !== hostname() || state.pid === null || !Number.isSafeInteger(state.pid) || state.pid < 1) return false;
  try { process.kill(state.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export type SchedulerLeaseAttempt =
  | { acquired: false; holder: string; expiresAt: string }
  | { acquired: true; release: () => void; assertActive: () => void; renew: () => void };

/** The lease row no longer names this holder: another cycle owns the scheduler. */
export class SchedulerLeaseLostError extends Error {
  constructor() { super('Scheduler lease lost'); this.name = 'SchedulerLeaseLostError'; }
}

/** Serialize scheduler cycles through the single lease row. */
export function acquireSchedulerLease(db: DatabaseSync): SchedulerLeaseAttempt {
  db.exec('BEGIN IMMEDIATE');
  let cycle: number;
  const holder = `${hostname()}:${process.pid}:${randomUUID()}`;
  try {
    const previous = currentLease(db);
    if (previous.holder &&
      (Date.parse(previous.expires_at ?? '') > Date.now() || liveOnThisHost(previous))) {
      db.exec('COMMIT');
      return { acquired: false, holder: previous.holder, expiresAt: previous.expires_at ?? '' };
    }
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    cycle = previous.cycle + 1;
    db.prepare(`UPDATE scheduler_lease SET holder = ?, host = ?, pid = ?, cycle = ?, expires_at = ? WHERE id = 1`)
      .run(holder, hostname(), process.pid, cycle, expiresAt);
    if (previous.holder) db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json)
      VALUES ('runtime', 'scheduler', 'global', 'scheduler_lease_taken_over', ?, ?)`).run(
      `Expired scheduler lease taken over from ${previous.holder}`,
      JSON.stringify({ previousHolder: previous.holder, previousExpiresAt: previous.expires_at,
        holder, host: hostname(), pid: process.pid, cycle, expiresAt }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  let lost: Error | undefined;
  let released = false;
  /**
   * Extend the lease. The timer alone cannot keep a cycle alive: a long synchronous step (a Git scan or file
   * hashing over a large project) blocks the event loop, so the timer never fires and `expires_at` goes stale
   * while the cycle is still working. Callers therefore renew explicitly at long-work boundaries, and a renewal
   * that finds the row renamed means another cycle owns the scheduler: the current cycle must stop, not write.
   */
  const renew = (): void => {
    if (lost) throw lost;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare(`UPDATE scheduler_lease SET expires_at = ?
        WHERE id = 1 AND holder = ? AND cycle = ?`).run(new Date(Date.now() + TTL_MS).toISOString(), holder, cycle);
      if (result.changes !== 1) throw new SchedulerLeaseLostError();
      db.exec('COMMIT');
    } catch (error) {
      lost = lost ?? (error as Error);
      try { db.exec('ROLLBACK'); } catch { /* the transaction is already gone; the loss itself is the fact */ }
      throw lost;
    }
  };
  const timer = setInterval(() => { try { renew(); } catch { clearInterval(timer); } }, RENEW_MS);
  timer.unref();
  return {
    acquired: true,
    assertActive: () => { if (lost) throw lost; },
    renew,
    release: () => {
      if (released) return;
      released = true; clearInterval(timer);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`UPDATE scheduler_lease SET holder = NULL, host = NULL, pid = NULL, expires_at = NULL
          WHERE id = 1 AND holder = ? AND cycle = ?`).run(holder, cycle);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
