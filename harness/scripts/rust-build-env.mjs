import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Release executables must not retain the builder's private source or Cargo paths in panic/debug strings. */
export function rustBuildEnvironment(root, env = process.env, home = homedir()) {
  const flags = env.CARGO_ENCODED_RUSTFLAGS !== undefined ? env.CARGO_ENCODED_RUSTFLAGS.split('\x1f').filter(Boolean)
    : (env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
  for (const [source, target] of [[resolve(home), '/builder'], [resolve(root), '/harness']]) {
    // rustc accepts paths as Cargo passes them; cover both spellings used by Windows dependencies.
    for (const path of new Set([source, source.replaceAll('\\', '/')])) flags.push(`--remap-path-prefix=${path}=${target}`);
  }
  return { ...env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') };
}
