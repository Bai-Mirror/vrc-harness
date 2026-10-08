import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Conditional waits for product facts (a file the Runtime writes, a Run that stops, a row that
 * changes). Tests must never poll a fixed number of times and then read the artifact anyway: under
 * load that budget expires and the read reports `ENOENT` for a file that simply had not been written
 * yet, which hides the real reason and turns a timeout into a phantom failure.
 *
 * Every wait here has a deadline, reports what it was waiting for and what it last observed, and
 * throws on timeout so the caller cannot continue to read the artifact as if it existed.
 *
 * `AVH_TEST_WAIT_SCALE` multiplies every base budget. It only buys time for the same condition to
 * become true; it never weakens what is asserted and never turns a wait into an unbounded hang.
 */
export const WAIT_SCALE_ENV = 'AVH_TEST_WAIT_SCALE';

/** The load multiplier for every base budget; read per call so a test can pin the contract. */
export function waitScale(): number {
  const raw = Number(process.env[WAIT_SCALE_ENV] ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

export interface WaitOptions<T = unknown> {
  /** The awaited fact, named in the timeout error: `the native import authority file`. */
  what: string;
  /** Base deadline in milliseconds; `AVH_TEST_WAIT_SCALE` is applied on top. */
  timeoutMs?: number;
  intervalMs?: number;
  /** Ready test for the probed value; defaults to `Boolean`, i.e. "the probe is truthy". */
  ready?: (value: T) => boolean;
  /** Extra context for the timeout error, evaluated only when the wait fails. */
  detail?: () => unknown;
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

/** Reads a file a producer may not have written yet; an absent file is `undefined`, not a throw. */
export function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Polls `probe` until `ready` accepts its value, then resolves with that value. Throws once the
 * scaled deadline passes, naming the awaited fact, its budget and the last observation.
 */
export async function waitFor<T>(probe: () => T | Promise<T>, options: WaitOptions<T>): Promise<T> {
  const ready = options.ready ?? ((value: T) => Boolean(value));
  const budget = Math.max(1, Math.round((options.timeoutMs ?? 30_000) * waitScale()));
  const interval = Math.max(1, options.intervalMs ?? 25);
  const deadline = Date.now() + budget;
  let last: T | undefined;
  for (;;) {
    last = await probe();
    if (ready(last)) return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(interval, remaining));
  }
  const detail = options.detail ? `; ${describe(options.detail())}` : '';
  throw new Error(`timed out after ${budget}ms waiting for ${options.what}; last observed: ${describe(last)}${detail}`);
}

/** `waitFor` for facts that are only ever observed as a boolean. */
export async function waitUntil(probe: () => boolean | Promise<boolean>, options: WaitOptions<boolean>): Promise<void> {
  await waitFor(probe, options);
}
