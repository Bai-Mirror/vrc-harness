import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { compareVersions, sha256File, type SignedAppRelease, type SignedPackRelease } from './harness.ts';
import type { Logger } from './log.ts';
import { verifyRelease, type SignedRelease } from './signing.ts';

export type ReleaseKind = 'app' | 'knowledge';
export interface KnowledgeOffer { manifest: SignedPackRelease; archive: { name: string; size: number; sha256: string; url: string } }

const MAX_MANIFEST_BYTES = 256 * 1024;
const SCHEMA: Record<ReleaseKind, SignedRelease['schema']> = { app: 'harness-app-release/0.1', knowledge: 'harness-pack-release/0.1' };

/** A channel is a directory under releases/<kind>/; `files` holds the downloads and is never a channel. */
export function validChannel(channel: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(channel) && channel !== 'files';
}

type Ordered = { version: string; issuedAt: string; releaseId: string };
function newestFirst(a: Ordered, b: Ordered): number {
  return compareVersions(b.version, a.version) || Date.parse(b.issuedAt) - Date.parse(a.issuedAt)
    || (a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0);
}

/**
 * Release manifests as the maintainer placed them in DATA_DIR/releases/<kind>/<channel>/*.json. Every listing reads
 * and verifies them again with the trusted keys, so removing or replacing a file takes effect at once; a manifest
 * that fails is left out and logged once per version of the file.
 */
export class ReleaseCatalog {
  readonly #dataDir: string;
  readonly #root: string;
  readonly #trustedKeys: Record<string, string>;
  readonly #publicBaseUrl: string;
  readonly #log: Logger;
  readonly #warned = new Set<string>();
  readonly #hashes = new Map<string, string>();

  constructor(dataDir: string, trustedKeys: Record<string, string>, publicBaseUrl: string, log: Logger) {
    this.#dataDir = dataDir;
    this.#root = join(dataDir, 'releases');
    this.#trustedKeys = trustedKeys;
    this.#publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
    this.#log = log;
  }

  channels(kind: ReleaseKind): string[] {
    try {
      return readdirSync(join(this.#root, kind), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && validChannel(entry.name)).map(entry => entry.name).sort();
    } catch {
      return [];
    }
  }

  app(channel: string): SignedAppRelease[] {
    const releases: SignedAppRelease[] = [], ids = new Set<string>();
    for (const { file, manifest } of this.#verified('app', channel)) {
      const release = manifest as SignedAppRelease;
      if (release.channel !== channel) { this.#warn(file, `manifest names channel ${release.channel}`); continue; }
      if (ids.has(release.releaseId)) { this.#warn(file, `duplicate releaseId ${release.releaseId}`); continue; }
      ids.add(release.releaseId);
      releases.push(release);
    }
    return releases.sort(newestFirst);
  }

  knowledge(channel: string): KnowledgeOffer[] {
    const offers: KnowledgeOffer[] = [], ids = new Set<string>();
    for (const { file, manifest } of this.#verified('knowledge', channel)) {
      const release = manifest as SignedPackRelease;
      if (ids.has(release.releaseId) || ids.has(`pack:${release.packId}`)) { this.#warn(file, `duplicate releaseId or packId ${release.releaseId}`); continue; }
      const name = `${release.releaseId}.tar.gz`, archive = this.#archive(join(this.#root, 'knowledge', 'files', name));
      if (!archive) { this.#warn(file, `archive files/${name} is missing`); continue; }
      ids.add(release.releaseId).add(`pack:${release.packId}`);
      offers.push({ manifest: release, archive: { name, ...archive, url: `${this.#publicBaseUrl}/v1/knowledge/files/${name}` } });
    }
    return offers.sort((a, b) => newestFirst(a.manifest, b.manifest));
  }

  #verified(kind: ReleaseKind, channel: string): Array<{ file: string; manifest: SignedRelease }> {
    const directory = join(this.#root, kind, channel);
    let names: string[];
    try { names = readdirSync(directory).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort(); } catch { return []; }
    const found: Array<{ file: string; manifest: SignedRelease }> = [];
    for (const name of names) {
      const file = join(directory, name);
      try {
        const info = lstatSync(file);
        if (!info.isFile()) throw new Error('not a regular file');
        if (info.size > MAX_MANIFEST_BYTES) throw new Error('manifest file is too large');
        const manifest = JSON.parse(readFileSync(file, 'utf8')) as SignedRelease;
        if (manifest?.schema !== SCHEMA[kind]) throw new Error(`expected schema ${SCHEMA[kind]}`);
        verifyRelease(manifest, this.#trustedKeys);
        found.push({ file, manifest });
      } catch (error) {
        this.#warn(file, (error as Error).message);
      }
    }
    return found;
  }

  /** Size and SHA-256 of a download, hashed again only when the file changes. */
  #archive(path: string): { size: number; sha256: string } | undefined {
    let info;
    try { info = lstatSync(path); } catch { return undefined; }
    if (!info.isFile() || info.size === 0) return undefined;
    const key = `${path}\0${info.size}\0${info.mtimeMs}\0${info.ino}`;
    let sha256 = this.#hashes.get(key);
    if (!sha256) { sha256 = sha256File(path); this.#hashes.set(key, sha256); }
    return { size: info.size, sha256 };
  }

  #warn(file: string, reason: string): void {
    let version = '';
    try { const info = lstatSync(file); version = `${info.size}:${info.mtimeMs}`; } catch { /* already gone */ }
    const key = `${file}\0${version}\0${reason}`;
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#log.warn('release manifest left out', { file: relative(this.#dataDir, file).split('\\').join('/'), reason });
  }
}
