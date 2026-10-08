import { fileURLToPath } from 'node:url';

/**
 * Path of a sibling module that a child process runs directly: `.ts` in a source checkout,
 * `.js` in the built package (Node cannot strip types under node_modules).
 */
export function runtimeModule(base: string, specifier: string): string {
  if (/\.[cm]?[jt]s$/.test(specifier)) throw new Error(`runtimeModule: 不要写扩展名 ${specifier}`);
  return fileURLToPath(new URL(`${specifier}${base.endsWith('.ts') ? '.ts' : '.js'}`, base));
}
