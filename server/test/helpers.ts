import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { authorizeContribution, type ContributionRow } from '../../harness/src/contribution-queue.ts';
import { recordPackEvaluation, registerPackCandidate } from '../../harness/src/managed-pack-candidate.ts';
import { openDatabase } from '../../harness/src/state/db.ts';
import { chooseSharing } from '../../harness/src/sharing/state.ts';
import type { Logger } from '../src/log.ts';
import { createHarnessServer, type ServerOptions } from '../src/server.ts';

export const serverRoot = fileURLToPath(new URL('..', import.meta.url));
export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const builtinPack = join(repoRoot, 'harness', 'builtin');
export const script = (name: string): string => join(serverRoot, 'scripts', name);

export function tempDir(t: TestContext, prefix = 'harness-server-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function keyPair(): { publicPem: string; privatePem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

export interface CapturedLog extends Logger { entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> }
export function captureLog(): CapturedLog {
  const entries: CapturedLog['entries'] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>): void => { entries.push({ level, message, fields }); };
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

/** The server in this process, on a random port. */
export async function startServer(t: TestContext, options: Partial<ServerOptions> & { dataDir: string }): Promise<{ url: string; log: CapturedLog }> {
  const log = captureLog();
  const server = createHarnessServer({ version: 'test', trustedKeys: {}, publicBaseUrl: 'https://harness.test', log, ...options });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log };
}

/** src/main.ts in its own process, configured through the environment the way the container does it. */
export async function spawnServer(t: TestContext, env: Record<string, string>): Promise<{ url: string; output: () => string }> {
  const child = spawn(process.execPath, [join(serverRoot, 'src', 'main.ts')], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', MIN_FREE_BYTES: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(() => new Promise<void>(resolve => {
    if (child.exitCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  }));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15_000);
    child.stdout.on('data', () => {
      const listening = /"message":"listening".*"port":(\d+)/.exec(output);
      if (listening) { clearTimeout(timer); resolve(Number(listening[1])); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited with ${code}:\n${output}`)); });
  });
  return { url: `http://127.0.0.1:${port}`, output: () => output };
}

/**
 * An authorized contribution made by the real client code, the way the client's own tests make one: the built-in pack
 * as a candidate, qualified by two model families, then authorized into a local outbox bundle. The candidate holds the
 * current built-in contract, including newly referenced tools, plus private files that must stay local. Only the
 * projected observation is contributed; original pack bytes and source filesystem modes do not leave this fixture.
 */
export function authorizedContribution(t: TestContext, prepare?: (source: string) => void):
  { root: string; home: string; db: ReturnType<typeof openDatabase>; item: ContributionRow } {
  const root = mkdtempSync(join(tmpdir(), 'harness-contribution-')), home = join(root, 'home'), source = join(root, 'source');
  cpSync(builtinPack, source, { recursive: true, filter: path => !path.split(/[\\/]/).includes('__pycache__') && !path.endsWith('.pyc') });
  writeFileSync(join(source, 'knowledge', 'private-notes.md'), '# kept to the owner\n');
  chmodSync(join(source, 'knowledge', 'private-notes.md'), 0o600);
  writeFileSync(join(source, 'tools', 'helper.sh'), '#!/bin/sh\n');
  chmodSync(join(source, 'tools', 'helper.sh'), 0o711);
  const manifest = JSON.parse(readFileSync(join(source, 'pack.json'), 'utf8')) as Record<string, unknown>, base = String(manifest.id);
  Object.assign(manifest, { id: 'safe-candidate', version: '1-candidate', channel: 'candidate' });
  writeFileSync(join(source, 'pack.json'), JSON.stringify(manifest));
  prepare?.(source);
  const db = openDatabase(join(root, 'state.db'));
  chooseSharing(db, { surface: 'gui', noticeShown: true, enabled: true });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  registerPackCandidate(db, home, source, { basePackId: base, sourceKind: 'ai', sourceRef: 'private-project-run', reason: 'private customer details',
    impact: { projectId: 'private-project', stages: ['outfit'] }, permissions: { network: false, writes: ['project', 'run'] } });
  const results = ['codex', 'claude'].map(modelFamily => ({ caseId: 'shoe', modelFamily, attempt: 1, result: 'pass' as const, evidenceRef: `/private/${modelFamily}` }));
  recordPackEvaluation(db, 'safe-candidate', { suiteId: 'fit', suiteVersion: '1', isolation: 'bwrap', baselineResults: results, results });
  return { root, home, db, item: authorizeContribution(db, home, 'safe-candidate', 'user', 'I authorize this redacted contribution') };
}

export function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
