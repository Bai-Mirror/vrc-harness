import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const compose = join(repo, 'deploy', 'harness-server', 'docker-compose.yml');

test('Compose passes the operator backup period from .env and defaults to no backup', t => {
  const available = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (available.status !== 0) {
    t.skip('Docker Compose is unavailable; this check needs its actual interpolation path');
    return;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'harness-compose-policy-'));
  try {
    const env = { ...process.env };
    // The fixture .env is the operator input, independent of the test host's Compose settings.
    delete env.BACKUP_DAYS;
    delete env.HARNESS_REPO;
    for (const key of Object.keys(env)) if (key.startsWith('COMPOSE_')) delete env[key];
    for (const [setting, expected] of [[undefined, '0'], ['', '0'], ['37', '37'], ['90', '90']] as const) {
      writeFileSync(join(scratch, '.env'), setting === undefined ? '' : `BACKUP_DAYS=${setting}\n`);
      const parsed = spawnSync('docker', ['compose', '--project-directory', scratch, '--env-file', join(scratch, '.env'),
        '-f', compose, 'config', '--format', 'json'], { cwd: scratch, env, encoding: 'utf8' });
      assert.equal(parsed.status, 0, parsed.stderr);
      const config = JSON.parse(parsed.stdout) as { services: { 'harness-server': { environment: { BACKUP_DAYS: string } } } };
      assert.equal(config.services['harness-server'].environment.BACKUP_DAYS, expected, `.env BACKUP_DAYS=${String(setting)}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
