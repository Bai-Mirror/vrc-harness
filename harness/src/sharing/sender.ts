import type { DatabaseSync } from 'node:sqlite';
import { MAX_BATCH_RECORDS, MAX_QUEUED_RECORDS } from '../shared/sharing.ts';
import { flushSharing } from './client.ts';
import { sharingState } from './state.ts';

/**
 * DATA/D3 automatic periodic sending (D-13): while the person is joined, the Runtime uploads the records its producers
 * queued without anyone opening the settings page and pressing send. The manual `sharing.flush` entry stays as it was.
 *
 * This consumer only decides *when* to try; the record whitelist, the bounded queue, the one claim/settle path and the
 * installation credential all stay in sharing/state.ts and sharing/client.ts. What it adds:
 * - nothing is attempted unless `sharingState(...).active`, so a computer that never joined sends nothing and a
 *   confirmed revocation stops the sender before its next attempt (the old payload is deleted, never re-sent);
 * - a failed attempt waits longer every time (the base interval doubling) up to a cap, so an offline computer does not
 *   hammer the server; a success returns to the base interval;
 * - the queue lives in SQLite, so a restart after being offline resumes at the base interval and picks the still-queued
 *   records up again. Only the current backoff is in memory, and losing it on restart is the intended recovery.
 */
export const SHARING_SEND_INTERVAL_MS = 15 * 60_000;
/** After repeated failures the interval doubles up to this: an offline computer tries less, but keeps trying. */
export const SHARING_SEND_MAX_BACKOFF_MS = 2 * 3600_000;
/** One attempt drains up to this many batches; the queue itself is bounded by MAX_QUEUED_RECORDS. */
const MAX_BATCHES_PER_ATTEMPT = Math.ceil(MAX_QUEUED_RECORDS / MAX_BATCH_RECORDS) + 1;

export interface SharingSenderOptions {
  db: DatabaseSync;
  home: string;
  /** The contribution server origin, the same one the manual flush uses. */
  server: string;
  /** Test hook: the network call. Left out, flushSharing uses the global fetch. */
  fetcher?: typeof fetch;
  /** How long a successful attempt waits before the next one. */
  intervalMs?: number;
  /** The ceiling the interval doubles to after failures. */
  maxBackoffMs?: number;
  /** Test hooks for the timer, so an attempt can be driven without waiting for it. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SharingSenderStatus {
  running: boolean;
  intervalMs: number;
  /** How long the next automatic attempt waits: the base interval, or more after failures. */
  backoffMs: number;
  lastAttemptAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
}

export class SharingSender {
  private readonly options: Required<Omit<SharingSenderOptions, 'fetcher'>> & { fetcher?: typeof fetch };
  private handle: unknown;
  private delayMs: number;
  private stopped = true;
  private inFlight = false;
  private lastAttemptAt: string | null = null;
  private lastSentAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: SharingSenderOptions) {
    const intervalMs = options.intervalMs ?? SHARING_SEND_INTERVAL_MS;
    const maxBackoffMs = options.maxBackoffMs ?? SHARING_SEND_MAX_BACKOFF_MS;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('sharing sender interval must be positive');
    if (!Number.isFinite(maxBackoffMs) || maxBackoffMs < intervalMs) throw new Error('sharing sender backoff cap must not be below the interval');
    this.options = { db: options.db, home: options.home, server: options.server, fetcher: options.fetcher, intervalMs, maxBackoffMs,
      setTimer: options.setTimer ?? ((callback, ms) => setTimeout(callback, ms)),
      clearTimer: options.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout)) };
    this.delayMs = intervalMs;
  }

  /** Starts the timer. A restart creates a new sender, which begins again at the base interval. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.delayMs = this.options.intervalMs;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== undefined) { this.options.clearTimer(this.handle); this.handle = undefined; }
  }

  /** What the Runtime reports with `sharing.state`, so an automatic channel is observable, not implicit. */
  status(): SharingSenderStatus {
    return { running: !this.stopped, intervalMs: this.options.intervalMs, backoffMs: this.delayMs,
      lastAttemptAt: this.lastAttemptAt, lastSentAt: this.lastSentAt, lastError: this.lastError };
  }

  /**
   * One attempt now. The timer calls it; a test can call it directly. Attempts never overlap, so a slow request cannot
   * make the Runtime open a second one. Returns what this attempt sent and how many records are still queued.
   */
  async attempt(): Promise<{ sent: number; pending: number }> {
    if (this.inFlight) return { sent: 0, pending: sharingState(this.options.db).counts.queued };
    this.inFlight = true;
    let sent = 0;
    let failed = false;
    try {
      for (let round = 0; round < MAX_BATCHES_PER_ATTEMPT; round++) {
        // The guard every automatic attempt passes: without an explicit join, the current notice shown and no
        // revocation waiting, nothing leaves this computer — not even a request for an installation credential.
        if (!sharingState(this.options.db).active) break;
        this.lastAttemptAt = new Date().toISOString();
        const result = await flushSharing(this.options.db, this.options.home, this.options.server, this.options.fetcher);
        sent += result.sent;
        // Another batch waits: keep draining. No progress (a claimed batch the server rejects) stops the round, so a
        // poisoned batch cannot spin here; the next attempt retries it after the backoff.
        if (!result.pending || !result.sent) break;
      }
    } catch (error) {
      failed = true;
      this.lastError = (error as Error).message;
    } finally {
      this.inFlight = false;
    }
    if (failed) this.delayMs = Math.min(this.delayMs * 2, this.options.maxBackoffMs);
    else {
      this.delayMs = this.options.intervalMs;
      this.lastError = null;
      if (sent) this.lastSentAt = new Date().toISOString();
    }
    return { sent, pending: sharingState(this.options.db).counts.queued };
  }

  private schedule(): void {
    if (this.stopped) return;
    const handle = this.options.setTimer(() => {
      this.handle = undefined;
      void this.attempt().finally(() => this.schedule());
    }, this.delayMs);
    // A background sender must never be the reason the process stays alive.
    (handle as { unref?: () => void } | undefined)?.unref?.();
    this.handle = handle;
  }
}
