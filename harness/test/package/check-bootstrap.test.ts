import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeTemp, windows } from '../fixtures/platform.ts';

test('release check prepares the Windows helper before source consumers in a fresh worktree', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-check-bootstrap-'));
  t.after(() => removeTemp(root));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'node_modules/typescript/bin'), { recursive: true });
  copyFileSync(new URL('../../scripts/check.mjs', import.meta.url), join(root, 'scripts/check.mjs'));
  // check.mjs imports this at load time, even with --skip-tests, so a stand-in without it cannot start at all.
  copyFileSync(new URL('../../scripts/unit-suite.mjs', import.meta.url), join(root, 'scripts/unit-suite.mjs'));
  writeFileSync(join(root, 'scripts/build-native.mjs'), "import {writeFileSync} from 'node:fs';writeFileSync('native-ready','ready');\n");
  writeFileSync(join(root, 'node_modules/typescript/bin/tsc'),
    `if (${windows} && !require('node:fs').existsSync('native-ready')) process.exit(23);\n`);
  // Deliberately stop before packaging. Reaching the build proves the real command ordered both typechecks correctly.
  writeFileSync(join(root, 'scripts/build.mjs'), "throw Error('build-barrier');\n");
  const log = join(root, 'check.log');
  const result = spawnSync(process.execPath, [join(root, 'scripts/check.mjs'), '--skip-tests', '--log', log],
    { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /OK\s+typecheck GUI/);
  assert.match(result.stdout, /FAIL build/);
  assert.match(readFileSync(log, 'utf8'), /build-barrier/);
  assert.equal(existsSync(join(root, 'native-ready')), windows, 'Linux does not build a Windows executable');
});
