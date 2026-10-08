import { createPublicKey, verify } from 'node:crypto';
import { releasePayload, type SignedPackRelease } from './managed-pack-update.ts';
import { officialEndpoints, TRUSTED_RELEASE_KEYS } from './official.ts';

/** A signed software release: which files exist for which platform, and where to get them. */
export interface AppReleaseFile { platform: string; kind: string; name: string; size: number; sha256: string; urls: string[] }
export interface SignedAppRelease {
  schema: 'harness-app-release/0.1'; releaseId: string; version: string; channel: string; issuedAt: string; notes: string;
  minimumStateSchema: number; files: AppReleaseFile[]; keyId: string; signature: string;
}
const SAFE = /^[a-zA-Z0-9._-]+$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Same signature scheme as pack releases: Ed25519 over the canonical JSON of every field but the signature. */
export function verifyAppRelease(release: SignedAppRelease, trustedKeys: Record<string, string> = TRUSTED_RELEASE_KEYS): void {
  if (release.schema !== 'harness-app-release/0.1') throw new Error('unsupported app release schema');
  if (!SAFE.test(release.releaseId) || !SAFE.test(release.keyId) || !SAFE.test(release.channel)) throw new Error('invalid release identifiers');
  if (!VERSION.test(release.version)) throw new Error('invalid release version');
  if (Number.isNaN(Date.parse(release.issuedAt))) throw new Error('invalid release issue time');
  if (!Array.isArray(release.files) || release.files.some(file => !SAFE.test(file.platform) || !SAFE.test(file.kind) ||
    !/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || !Array.isArray(file.urls) ||
    file.urls.some(url => !/^https:\/\//.test(url)))) throw new Error('invalid release files');
  const pem = trustedKeys[release.keyId];
  if (!pem) throw new Error(`untrusted release signing key ${release.keyId}`);
  const signature = Buffer.from(release.signature ?? '', 'base64');
  if (!signature.length || !verify(null, releasePayload(release as unknown as SignedPackRelease), createPublicKey(pem), signature))
    throw new Error('release signature verification failed');
}

/** Semantic version order, prereleases before their release: 0.1.0-dev.2 < 0.1.0-dev.10 < 0.1.0. */
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a), pb = VERSION.exec(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const x = pa[4].split('.'), y = pb[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1; if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]!) ? Number(x[i]) : undefined, ny = /^\d+$/.test(y[i]!) ? Number(y[i]) : undefined;
    if (nx !== undefined && ny !== undefined) { if (nx !== ny) return nx - ny; continue; }
    if (nx !== undefined) return -1; if (ny !== undefined) return 1;
    const order = x[i]!.localeCompare(y[i]!); if (order) return order;
  }
  return 0;
}

export interface UpdateCheck {
  current: string; channel: string; checkedAt: string;
  latest?: { version: string; notes: string; issuedAt: string; files: AppReleaseFile[] };
  /** Releases the server offered that failed verification: never shown as updates. */
  rejected: number;
}
/** Asks the server for newer signed releases on the channel; only verified ones count. */
export async function checkForAppUpdate(current: string, options: { channel?: string; platform?: string; fetcher?: typeof fetch;
  trustedKeys?: Record<string, string>; endpoint?: string } = {}): Promise<UpdateCheck> {
  const channel = options.channel ?? 'dev';
  const response = await (options.fetcher ?? fetch)(`${options.endpoint ?? officialEndpoints().releases}?channel=${encodeURIComponent(channel)}`,
    { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`更新服务返回 HTTP ${response.status}`);
  const body = await response.json() as { releases?: unknown };
  const offered = Array.isArray(body.releases) ? body.releases as SignedAppRelease[] : [];
  let rejected = 0;
  const verified = offered.filter(release => { try { verifyAppRelease(release, options.trustedKeys); return true; } catch { rejected++; return false; } })
    .filter(release => release.channel === channel && compareVersions(release.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const newest = verified[0];
  return { current, channel, checkedAt: new Date().toISOString(), rejected, ...(newest ? { latest: { version: newest.version,
    notes: newest.notes, issuedAt: newest.issuedAt, files: newest.files.filter(file => file.platform === platform || file.platform === 'any') } } : {}) };
}
