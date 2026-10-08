import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/check-release.mjs', import.meta.url));
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });

test('release:check prints its usage instead of guessing an installer, and stops at the first gate that fails', () => {
  // No installer path: a usage message and exit 2, the same contract as the two gates it runs.
  const empty = run([]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /npm run release:check -- <安装包路径>/);
  assert.match(empty.stderr, /check:release-artifacts/);
  assert.match(empty.stderr, /check:installer-location/);
  // A path that is not there fails the first gate; the second never runs, so its output is absent and the wrapper
  // says which gate stopped the release rather than only returning a code.
  const absent = run([join(tmpdir(), `avh-release-check-absent-${process.pid}.exe`)]);
  const output = `${absent.stdout}${absent.stderr}`;
  assert.notEqual(absent.status, 0);
  assert.match(output, /release:check: check-release-artifacts\.mjs 未通过/);
  assert.doesNotMatch(output, /check-installer-location/);
});
