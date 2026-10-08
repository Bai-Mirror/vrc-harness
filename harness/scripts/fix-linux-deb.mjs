import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Tauri names the package after the version in tauri.conf.json, which follows package.json.
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const NAME = `Harness_${VERSION}_amd64.deb`;
const DEB = resolve(`src-tauri/target/release/bundle/deb/${NAME}`);

export function normalizeDebControl(source) {
  const match = /^Depends: (.+)$/m.exec(source);
  if (!match) throw new Error('DEB control has no Depends field');
  const dependencies = match[1].split(',').map(value => value.trim()).filter(Boolean)
    .map(value => value === 'libgtk-3-0' ? 'libgtk-3-0 | libgtk-3-0t64' : value);
  const unique = [...new Set(dependencies)];
  if (!unique.includes('libwebkit2gtk-4.1-0')) throw new Error('DEB no longer declares WebKitGTK 4.1');
  if (!unique.includes('libgtk-3-0 | libgtk-3-0t64')) throw new Error('DEB has no GTK 3 dependency');
  return source.replace(match[0], `Depends: ${unique.join(', ')}`);
}

export function fixDeb(path = DEB) {
  if (basename(path) !== NAME) throw new Error(`refusing unexpected package: ${path}`);
  const work = mkdtempSync(join(tmpdir(), 'avh-deb-'));
  const root = join(work, 'root'), next = join(dirname(path), `${basename(path)}.next`);
  try {
    execFileSync('dpkg-deb', ['-R', path, root], { stdio: 'pipe' });
    const controlPath = join(root, 'DEBIAN/control');
    const control = normalizeDebControl(readFileSync(controlPath, 'utf8'));
    writeFileSync(controlPath, control, { mode: 0o644 });
    execFileSync('dpkg-deb', ['--build', '--root-owner-group', root, next], { stdio: 'pipe' });
    renameSync(next, path);
    return control;
  } finally {
    rmSync(next, { force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // `npm run tauri:build` runs this after every bundle; only the Linux build makes a DEB.
  if (process.platform !== 'linux') console.error('只有 Linux 构建产出 DEB，无需修正');
  else {
    const control = fixDeb();
    console.log(/^Depends: .+$/m.exec(control)?.[0]);
  }
}
