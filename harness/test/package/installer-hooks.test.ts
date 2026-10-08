import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The generated installer.nsi is rebuilt from the Tauri template on every build and must not be edited, so
// src-tauri/windows/installer-hooks.nsh is the only place the install-location defects can be fixed. That leaves the
// hook's text as the product: makensis only fails on a syntax error, and nothing at all fails when the hook quietly
// stops rejecting a location or stops deleting the memory. These assertions are what fails instead. The behaviour
// itself is read back off a built installer by scripts/check-installer-location.mjs, which runs at release time
// because it needs a real package.

const hooksPath = fileURLToPath(new URL('../../src-tauri/windows/installer-hooks.nsh', import.meta.url));
const configPath = fileURLToPath(new URL('../../src-tauri/tauri.windows.conf.json', import.meta.url));
const bytes = readFileSync(hooksPath);
/** The generated template wraps the hook bodies in `!macro`/`!macroend`; nothing else delimits them. */
const section = (text: string, open: string, close: string): string => {
  const start = text.indexOf(open);
  assert.notEqual(start, -1, `${open.trim()} is not defined`);
  const end = text.indexOf(close, start);
  assert.notEqual(end, -1, `${open.trim()} has no ${close}`);
  return text.slice(start, end);
};
const source = bytes.toString('utf8');
const macro = (name: string): string => section(source, `!macro ${name}`, '!macroend');
const func = (name: string): string => section(source, `Function ${name}`, 'FunctionEnd');

test('the hook source is UTF-8 with a byte order mark, the only encoding makensis reads Chinese in', () => {
  // Without the BOM makensis reads the file as the system ANSI codepage and stops with "Bad text encoding" on the
  // first non-ASCII byte: an install package that cannot be built at all, from a change no other check would see.
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'installer-hooks.nsh lost its UTF-8 BOM');
  const text = bytes.toString('utf8');
  assert.match(text, /Harness：上次的安装位置/, 'the message shown for a fallback install went missing');
  assert.equal(text.slice(1).includes('\uFFFD'), false, 'the file is not valid UTF-8');
});

test('tauri still points bundling at the hook that carries the fix', () => {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { bundle?: { windows?: { nsis?: { installerHooks?: string } } } };
  assert.equal(config.bundle?.windows?.nsis?.installerHooks, './windows/installer-hooks.nsh');
});

test('an unusable remembered location falls back to the default and re-points the install output', () => {
  const hook = macro('NSIS_HOOK_PREINSTALL');
  // The default the template itself would have used, so the fallback cannot drift from it.
  assert.match(hook, /StrCpy \$R9 "\$LOCALAPPDATA\\\$\{PRODUCTNAME\}"/, 'the fallback target is no longer the template default');
  assert.match(hook, /StrCpy \$INSTDIR "\$R9"/, 'the remembered location is no longer replaced');
  // $OUTDIR still names the rejected directory at this point, and every File command follows $OUTDIR: without this
  // the check would be pointless, because the payload would land in the rejected directory anyway.
  assert.ok(hook.indexOf('StrCpy $INSTDIR "$R9"') < hook.indexOf('SetOutPath "$INSTDIR"'),
    'the output path is not re-pointed after $INSTDIR changes');
  for (const reason of ['missing', 'unwritable']) {
    assert.ok(hook.includes(`"${reason}"`), `nothing rejects a location that is ${reason}`);
  }
  // The temp rule lives in its own macro because it runs once per temporary directory.
  const temp = macro('HarnessRejectIfUnderTemp');
  assert.ok(temp.includes('"temp"'), 'nothing rejects a location inside a temporary directory');
  // A temp directory is refused through the home directory too, not only through GetTempPath().
  assert.match(hook, /HarnessRejectIfUnderTemp "\$LOCALAPPDATA\\Temp"/);
  // "Is the directory there" cannot be asked here: the template's own SetOutPath $INSTDIR runs first and recreates a
  // deleted directory, measured by a run that reported "temp" for a path that did not exist and never "missing".
  assert.doesNotMatch(hook, /GetFileAttributes/, 'asking whether the directory exists cannot fail at this point');
  // A location that holds no Harness installation is a stale memory, and a directory the template recreated empty has
  // neither of the two files the previous version leaves there.
  assert.match(hook, /\$\{IfNot\} \$\{FileExists\} "\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe"/);
  assert.match(hook, /\$\{AndIfNot\} \$\{FileExists\} "\$INSTDIR\\uninstall\.exe"/);
  // Every rule has to leave the ones after it reachable: a rule that fires first for the wrong reason turns the next
  // one into dead code, which is what the existence test did until a live run reported the wrong reason for it.
  const order = ['!insertmacro HarnessRejectIfUnderTemp "$TEMP"', 'harness-install-write-probe', '"missing"'];
  const positions = order.map(fragment => hook.indexOf(fragment));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `the rules run out of order: ${positions.join(', ')}`);
  assert.ok(positions.every(position => position >= 0), `a rule went missing: ${positions.join(', ')}`);
  // Sibling names that merely share a prefix must not be treated as inside the root.
  const helper = func('HarnessPathIsUnderRoot');
  assert.match(helper, /StrCpy \$R2 "\$INSTDIR" 1 \$R1/, 'the prefix match no longer checks the following character');
});

test('the hook refuses a location only when the template restored it, so /D= and the page are respected', () => {
  const hook = macro('NSIS_HOOK_PREINSTALL');
  assert.match(hook, /\$\{AndIf\} \$R8 == \$INSTDIR/, 'a location the user chose is no longer distinguished from a restored one');
  assert.match(hook, /ReadRegStr \$R8 SHCTX "\$\{MANUPRODUCTKEY\}" ""/, 'the hook must read the key the template writes');
});

test('a silent uninstall forgets the remembered location, and an upgrade keeps it', () => {
  const hook = macro('NSIS_HOOK_POSTUNINSTALL');
  assert.match(hook, /\$\{If\} \$UpdateMode <> 1/, 'an upgrade would lose the location the new install is about to record');
  assert.match(hook, /DeleteRegKey SHCTX "\$\{MANUPRODUCTKEY\}"/,
    'the template deletes this key only behind its app-data checkbox, which a silent uninstall never creates');
  assert.match(hook, /DeleteRegKey \/ifempty SHCTX "\$\{MANUKEY\}"/, 'the vendor key is left behind empty');
});
