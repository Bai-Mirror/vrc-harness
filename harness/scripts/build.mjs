// Compile src/ to dist/ for the packed package. Usage: node scripts/build.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leftoverTsSpecifiers, rewriteTsSpecifiers } from './build-lib.mjs';
import { buildWindowsHelper, windowsHelpers } from './build-native.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'src');
const dist = join(root, 'dist');
const suppliedCommit = process.env.AVH_BUILD_COMMIT;
if (suppliedCommit && !/^[0-9a-f]{12}$/.test(suppliedCommit)) throw new Error('AVH_BUILD_COMMIT must be a 12-character lowercase Git hash');

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
function git(args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json')],
  { stdio: 'inherit' });
execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', join(root, 'gui/vite.config.ts')],
  { cwd: join(root, 'gui'), stdio: 'inherit' });

// Files the Runtime loads by path at run time: migrations and child-process entry points written as .mjs.
for (const file of files(src)) {
  const target = join(dist, relative(src, file));
  if (file.endsWith('.sql')) { mkdirSync(dirname(target), { recursive: true }); copyFileSync(file, target); }
  else if (file.endsWith('.mjs')) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, rewriteTsSpecifiers(readFileSync(file, 'utf8')));
  }
}
const leftovers = files(dist).filter(file => /\.(m?js)$/.test(file))
  .flatMap(file => leftoverTsSpecifiers(readFileSync(file, 'utf8')).map(spec => `${relative(dist, file)}: ${spec}`));
if (leftovers.length) throw new Error(`编译产物仍引用 .ts 模块:\n${leftovers.join('\n')}`);

// A package built on Windows carries the helper that its Runtime needs there (src/exec/windows-helper.ts).
if (process.platform === 'win32') {
  const built = buildWindowsHelper();
  mkdirSync(join(dist, 'native'), { recursive: true });
  for (const name of windowsHelpers) copyFileSync(join(built, name), join(dist, 'native', name));
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const commit = suppliedCommit ?? git(['rev-parse', '--short=12', 'HEAD']) ?? null;
const dirty = suppliedCommit ? false : commit ? Boolean(git(['status', '--porcelain', '--untracked-files=normal', '--', '.'])) : false;
writeFileSync(join(dist, 'build-info.json'), `${JSON.stringify({ packageVersion: pkg.version, commit, dirty,
  builtAt: new Date().toISOString() }, null, 2)}\n`);

// The package ships the repository's license texts; the copies are generated, not tracked.
for (const name of ['LICENSE', 'LICENSE-docs.md', 'NOTICE.md']) copyFileSync(join(root, '..', name), join(root, name));
console.error(`built ${pkg.version} (${commit ?? 'nogit'}${dirty ? '+dirty' : ''}) -> ${relative(process.cwd(), dist) || dist}`);
