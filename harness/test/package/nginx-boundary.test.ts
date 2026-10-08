import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/** The DATA/D7 deployment driver is only meaningful with Docker; its entry point must say so instead of passing. */
test('the nginx boundary entry point skips loudly, with exit 3, when its tools are unavailable', () => {
  // An empty PATH makes every probe miss (docker, openssl, python3): the wrapper must skip, not fabricate a pass.
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/nginx-boundary.mjs', import.meta.url))],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /SKIPPED nginx api boundary: /);
  assert.match(result.stdout, /not evidence/);
});
