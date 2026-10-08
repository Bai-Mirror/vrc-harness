import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { FIXTURE_RUN_DIRECTORY, unityFixtureRunDir } from '../fixtures/unity-slot.ts';

/** Run `body` with `process.platform` reading `platform`, then put the real one back. */
function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const actual = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try { return body(); } finally { Object.defineProperty(process, 'platform', { value: actual, configurable: true }); }
}

/**
 * The Windows fixture launcher rebinds `AVH_RUN_DIR` to its own directory inside the project, so a caller that keeps
 * reading the directory it passed in reads a directory the editor never wrote: the editor exits 0 and only the later
 * read notices (F28). Both branches matter and only one of them is exercised on any single host, so this pins both
 * here in the default suite — where `face-preview-unity`, `fixed-outfits-unity` and `recolor-material-unity` are
 * skipped without an editor variable, and Linux would otherwise have no guard at all.
 */
test('the fixture run directory follows the Windows launcher and the caller everywhere else', () => {
  const project = join('C:', 'work', 'fixture'), configured = join(project, '_harness', 'manual-run');
  withPlatform('win32', () => {
    assert.equal(unityFixtureRunDir(project, configured), join(project, FIXTURE_RUN_DIRECTORY));
    // The caller's value is exactly what the launcher discards, so returning it would read nothing.
    assert.notEqual(unityFixtureRunDir(project, configured), configured);
    assert.equal(unityFixtureRunDir(project), join(project, FIXTURE_RUN_DIRECTORY));
  });
  withPlatform('linux', () => {
    assert.equal(unityFixtureRunDir(project, configured), configured);
    assert.equal(unityFixtureRunDir(project), join(project, '_harness', 'manual-run'));
  });
});
