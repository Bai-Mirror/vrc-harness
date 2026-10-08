/**
 * Publishing preflight. The download URLs in an app manifest are frozen at signing time, and the server checks a
 * knowledge archive exists but never an app file (`server/src/releases.ts`): a URL that 404s is discovered by the
 * person clicking it. `app-release.mjs --verify-urls` asks every URL before it reads the private key, and this is
 * that reading. The fetcher is a parameter so the status rules can be tested without a network.
 */
export interface UrlReading { url: string; status: number; ok: boolean; error?: string }

/** HEAD each URL; only exactly 200 counts as published. A failed request is a reading, never a thrown error. */
export async function verifyReleaseUrls(urls: string[], fetcher: typeof fetch = fetch, timeoutMs = 20_000): Promise<UrlReading[]> {
  const readings: UrlReading[] = [];
  for (const url of urls) {
    try {
      const response = await fetcher(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      readings.push({ url, status: response.status, ok: response.status === 200 });
    } catch (error) {
      readings.push({ url, status: 0, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return readings;
}
