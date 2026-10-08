import assert from 'node:assert/strict';
import test from 'node:test';
// The release helper is intentionally plain ESM so it can run after Tauri without a build step.
// @ts-expect-error no declaration file is needed for this build-only helper
import { normalizeDebControl } from '../../scripts/fix-linux-deb.mjs';

test('DEB release metadata accepts pre-t64 and t64 GTK package names without duplicate dependencies', () => {
  const source='Package: harness\nDepends: libwebkit2gtk-4.1-0, libgtk-3-0, libwebkit2gtk-4.1-0, libgtk-3-0 | libgtk-3-0t64\n';
  const fixed=normalizeDebControl(source);
  assert.match(fixed,/^Depends: libwebkit2gtk-4\.1-0, libgtk-3-0 \| libgtk-3-0t64$/m);
  assert.equal((fixed.match(/libwebkit2gtk/g)??[]).length,1);
});

test('DEB release metadata refuses a package that lost its WebKit dependency',()=>{
  assert.throws(()=>normalizeDebControl('Package: harness\nDepends: libgtk-3-0\n'),/WebKitGTK/);
});
