/**
 * The deployment's contribution endpoints share one nginx limit zone, so a client has to spend that budget on purpose
 * instead of discovering it as an HTTP 429.
 *
 * `deploy/nginx/harness.nymiro.moe.conf:20` declares the zone `harness_contrib` with `rate=6r/m`; `:94-96`
 * (`location = /v1/installations`) and `:124-126` (`location = /v1/contributions`) both use it with
 * `burst=3 nodelay`; `:52` turns a refusal into 429. A 429 from there is the reverse proxy talking, not the
 * application: it means "slow down", so it can never be taken for the application's 403 ("this installation was
 * revoked; nothing more is accepted from it") or for a success. This module is what
 * `scripts/online-report-validation.mjs` uses to stay under the limit and to retry instead of misreading the answer.
 */

/** The numbers below are read from the deployed configuration, not guessed; keep them in step with that file. */
export const CONTRIBUTION_ZONE = {
  name: 'harness_contrib',
  requestsPerMinute: 6,
  burst: 3,
  /** The two paths nginx puts in that zone. `/v1/records` and the status route use the looser `harness_api` zone. */
  paths: ['/v1/installations', '/v1/contributions'],
  config: 'deploy/nginx/harness.nymiro.moe.conf',
} as const;

/** The one status that says "ask again later" instead of answering the request. */
export const RATE_LIMITED_STATUS = 429;

export function inContributionZone(pathname: string): boolean {
  return (CONTRIBUTION_ZONE.paths as readonly string[]).includes(pathname);
}

/** One request per interval once the burst is spent: nginx's leaky bucket refills at `rate`, plus a small margin. */
export function contributionIntervalMs(requestsPerMinute: number = CONTRIBUTION_ZONE.requestsPerMinute): number {
  return Math.ceil(60_000 / requestsPerMinute) + 250;
}

export interface PacingOptions {
  requestsPerMinute?: number;
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * A leaky bucket for the contribution zone: the first `burst` requests may go at once (nginx's `burst=3 nodelay`),
 * and every request after that waits out the refill interval. Nothing here inspects the response -- it exists so the
 * limit is respected before a 429 is ever provoked.
 */
export class ContributionPacer {
  private spent = 0;
  private last = 0;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly intervalMs: number;
  constructor(options: PacingOptions = {}) {
    this.burst = options.burst ?? CONTRIBUTION_ZONE.burst;
    this.intervalMs = contributionIntervalMs(options.requestsPerMinute ?? CONTRIBUTION_ZONE.requestsPerMinute);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }
  /** Milliseconds a request would have to wait right now; 0 while the burst lasts. Does not spend anything. */
  waitMs(): number {
    if (this.spent < this.burst) return 0;
    return Math.max(0, this.last + this.intervalMs - this.now());
  }
  /** Waits until the bucket allows one more request, then records it as spent. Returns how long it waited. */
  async reserve(): Promise<number> {
    const waited = this.waitMs();
    if (waited > 0) await this.sleep(waited);
    this.spent++;
    this.last = this.now();
    return waited;
  }
}

/** `Retry-After` when the deployment names one: seconds (the standard form a proxy sends) or an HTTP date. */
export function retryAfterMs(response: { headers: { get(name: string): string | null } }, now = Date.now()): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null || header.trim() === '') return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export interface PacedSendOptions extends PacingOptions {
  /** How many times one request may be sent in total; the last attempt's 429 is reported, never returned. */
  attempts?: number;
  /** The bucket for `/v1/installations` and `/v1/contributions`; a fresh one when omitted. */
  pacer?: ContributionPacer;
}

/**
 * Sends one request, pacing the contribution zone and retrying a 429 on the limit's clock. The response is returned
 * only when the deployment answered the request itself: after the last attempt a 429 is thrown, so a caller can never
 * mistake the reverse proxy's refusal for an application answer -- and never for a 403 it did not receive.
 */
export async function sendPaced(pathname: string, send: (attempt: number) => Promise<Response>, options: PacedSendOptions = {}): Promise<Response> {
  const pacer = options.pacer ?? new ContributionPacer(options);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? 4;
  const paced = inContributionZone(pathname);
  for (let attempt = 1; ; attempt++) {
    if (paced) await pacer.reserve();
    const response = await send(attempt);
    if (response.status !== RATE_LIMITED_STATUS) return response;
    if (attempt >= attempts)
      throw new Error(`${pathname} was answered HTTP ${RATE_LIMITED_STATUS} on all ${attempts} attempts: the deployment is rate limiting ` +
        `(${CONTRIBUTION_ZONE.config} zone ${CONTRIBUTION_ZONE.name}, ${CONTRIBUTION_ZONE.requestsPerMinute}r/m burst ${CONTRIBUTION_ZONE.burst}); ` +
        'this is the reverse proxy refusing, not an application answer');
    await sleep(retryAfterMs(response) ?? (paced ? pacer.intervalMs : 1_000));
  }
}
