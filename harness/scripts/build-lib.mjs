// Helpers shared by build.mjs and its tests. Plain JavaScript so the build needs no compile step itself.
import { execFileSync } from 'node:child_process';

/** Point relative `.ts` module specifiers at the compiled `.js` files (static and dynamic imports). */
export function rewriteTsSpecifiers(source) {
  return source.replace(/((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"\n]+?)\.ts\2/g, '$1$2$3.js$2');
}

/** Relative `.ts` specifiers left in compiled output; the packed package cannot load them. */
export function leftoverTsSpecifiers(source) {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*(['"])(\.{1,2}\/[^'"\n]+?\.ts)\1/g)].map(match => match[2]);
}

/**
 * The built-in pack files a bundle ships: exactly what npm packs, so the npm package and the desktop bundle agree.
 * npm reads package.json "files" and the pack's own .gitignore allowlist, so ignored leftovers in a working tree
 * (a private tool, bytecode) never reach a bundle, and no Git checkout is needed (a Docker build context has none).
 * @param {string} root the package root
 * @returns {string[]} paths relative to root
 */
export function shippedPackFiles(root) {
  // Windows cannot start npm.cmd without a shell.
  const listed = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' }));
  const files = listed[0].files.map(file => file.path).filter(path => path.startsWith('builtin/')).sort();
  if (!files.includes('builtin/pack.json')) throw new Error('npm pack lists no built-in pack');
  return files;
}
