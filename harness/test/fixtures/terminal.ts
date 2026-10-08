import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

/** What a person would have seen: the terminal control sequences Ink writes are not part of the screen. */
export const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

/** A terminal of a chosen size that records every frame Ink writes to it. */
export class Screen extends EventEmitter {
  readonly frames: string[] = [];
  readonly isTTY = true;
  readonly columns: number; readonly rows: number;
  // Node strips types without a compiler, so this stays a plain assignment rather than a parameter property.
  constructor(columns = 100, rows = 26) { super(); this.columns = columns; this.rows = rows; }
  write = (frame: string): boolean => { this.frames.push(frame); return true; };
  /** The last frame with content; cursor placement for input methods is written as a separate, escape-only chunk. */
  last(): string {
    for (let index = this.frames.length - 1; index >= 0; index--) {
      const text = stripAnsi(this.frames[index]!);
      if (text.trim()) return text;
    }
    return '';
  }
  /** Every frame in order, as the screen a person could have read by now. */
  seen(): string { return stripAnsi(this.frames.join('')); }
}

/** Keys typed into a terminal: `readable` is the stream Ink's own input loop reads, `data` keeps other consumers working. */
export class Keys extends EventEmitter {
  isTTY = true; data: string | null = null;
  write(data: string): void { this.data = data; this.emit('readable'); this.emit('data', data); }
  setEncoding(): void {} setRawMode(): void {} resume(): void {} pause(): void {} ref(): void {} unref(): void {}
  read = (): string | null => { const data = this.data; this.data = null; return data; };
}

export interface TerminalOptions {
  columns?: number; rows?: number;
  /** How long the interface must stay unchanged, and for how many consecutive windows, before a key is finished. */
  quietMs?: number; quietWindows?: number; settleTimeoutMs?: number;
}

/**
 * A terminal driven the way a person drives it: one key at a time, each key waiting for the interface to finish what
 * the previous one started.
 *
 * Ink runs the handler for a key synchronously, but almost everything that handler does goes through the Runtime:
 * a dialog closes, one or more round trips happen, and the next dialog opens. A key delivered inside that gap has no
 * mounted handler and is dropped without a trace, so a fixed pause per key asserts against whatever frame happened
 * to be on screen when the machine was fast enough — the same test passes on an idle machine and fails on a loaded
 * one. The wait here is on the interface being idle — nothing in flight, no new frame — which is a condition about
 * the work, not a duration guessed from it.
 */
export function terminal(options: TerminalOptions = {}) {
  const columns = options.columns ?? 100, rows = options.rows ?? 26;
  const stdout = new Screen(columns, rows), stderr = new Screen(columns, rows), stdin = new Keys();
  const quietMs = options.quietMs ?? 20, quietWindows = options.quietWindows ?? 6;
  const settleTimeoutMs = options.settleTimeoutMs ?? 20_000;
  let outstanding = 0;
  /** Wraps one Runtime round trip so `settle` can tell work still in flight from an interface that has finished. */
  const track = <T,>(work: Promise<T>): Promise<T> => { outstanding++; return work.finally(() => { outstanding--; }); };
  async function settle(timeoutMs = settleTimeoutMs): Promise<void> {
    const deadline = Date.now() + timeoutMs; let quiet = 0;
    while (Date.now() < deadline) {
      const frames = stdout.frames.length;
      await delay(quietMs);
      if (outstanding === 0 && stdout.frames.length === frames) { if (++quiet >= quietWindows) return; }
      else quiet = 0;
    }
    throw new Error(`terminal did not settle within ${timeoutMs}ms (${outstanding} Runtime call(s) in flight)`);
  }
  async function press(...keys: string[]): Promise<void> { for (const key of keys) { stdin.write(key); await settle(); } }
  /** Waits for a frame showing `pattern`: a render that has not happened yet is not a failed expectation. */
  async function waitForFrame(pattern: RegExp, timeoutMs = settleTimeoutMs): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = stdout.last();
      if (pattern.test(frame)) return frame;
      await delay(20);
    }
    throw new Error(`no frame matched ${pattern} within ${timeoutMs}ms; the last frame was:\n${stdout.last()}`);
  }
  return { stdout, stderr, stdin, track, settle, press, waitForFrame };
}
