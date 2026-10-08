import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { DEFAULT_RETENTION_DAYS } from './harness.ts';
import { loadTrustedKeys } from './keys.ts';
import { jsonLogger } from './log.ts';
import { createHarnessServer } from './server.ts';

/**
 * Environment:
 *   HOST, PORT            where to listen (127.0.0.1:8080; the container uses 0.0.0.0:8080)
 *   DATA_DIR              contributions, quarantine and releases (required)
 *   TRUSTED_KEYS_FILE     {"keyId": "Ed25519 public key PEM"}; without it every release listing is empty
 *   PUBLIC_BASE_URL       origin of knowledge archive URLs (https://harness.nymiro.moe)
 *   MIN_FREE_BYTES        free space kept on DATA_DIR's filesystem (2 GiB; 0 turns the check off)
 *   SERVE_RELEASE_FILES   1: also serve the download directories (development; nginx does it in production)
 *   RETENTION_DAYS        days an upload (record batch, contribution) is kept before the sweep deletes it (90; 1–3650);
 *                         anything accepted into a signed release is kept
 *   BACKUP_DAYS           days the operator's backups of DATA_DIR are kept (0: no backup job is installed):
 *                         stated in the data policy clients show, so it must match the backup job
 *                         (deploy/README.md); raise it only once a real backup job exists
 */
const log = jsonLogger();
const env = process.env;

function fatal(message: string): never {
  log.error(message);
  process.exit(1);
}

const dataDir = env.DATA_DIR || fatal('DATA_DIR is required');
const host = env.HOST || '127.0.0.1';
const port = Number(env.PORT || 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535) fatal(`invalid PORT ${env.PORT}`);
const minFreeBytes = Number(env.MIN_FREE_BYTES ?? 2 * 1024 ** 3);
if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) fatal(`invalid MIN_FREE_BYTES ${env.MIN_FREE_BYTES}`);
const days = (name: string, fallback: number, least: number): number => {
  const value = Number(env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < least || value > 3650) fatal(`invalid ${name} ${env[name]}: expected whole days from ${least} to 3650`);
  return value;
};
const retentionDays = days('RETENTION_DAYS', DEFAULT_RETENTION_DAYS, 1), backupDays = days('BACKUP_DAYS', 0, 0);
const publicBaseUrl = (env.PUBLIC_BASE_URL || 'https://harness.nymiro.moe').replace(/\/+$/, '');
if (!/^https?:\/\/[^/?#]+$/.test(publicBaseUrl)) fatal(`PUBLIC_BASE_URL must be an origin such as https://harness.nymiro.moe, not ${publicBaseUrl}`);

let trustedKeys: Record<string, string> = {};
if (env.TRUSTED_KEYS_FILE) {
  try { trustedKeys = loadTrustedKeys(env.TRUSTED_KEYS_FILE); } catch (error) { fatal(`cannot load trusted keys: ${(error as Error).message}`); }
}
if (!Object.keys(trustedKeys).length) log.warn('no trusted release keys: every release listing will be empty');

const version = String((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: unknown }).version);
const server = createHarnessServer({
  dataDir, version, trustedKeys, publicBaseUrl, log, minFreeBytes, serveReleaseFiles: env.SERVE_RELEASE_FILES === '1',
  retentionDays, backupDays,
});
server.listen(port, host, () => {
  const address = server.address() as AddressInfo;
  log.info('listening', { host: address.address, port: address.port, version, trustedKeys: Object.keys(trustedKeys), retentionDays, backupDays });
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
