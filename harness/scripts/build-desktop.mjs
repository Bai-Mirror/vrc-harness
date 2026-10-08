import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rustBuildEnvironment } from './rust-build-env.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), 'build', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit', env: rustBuildEnvironment(root) });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const fixed = spawnSync(process.execPath, [fileURLToPath(new URL('./fix-linux-deb.mjs', import.meta.url))],
  { cwd: root, stdio: 'inherit' });
if (fixed.error) throw fixed.error;
process.exit(fixed.status ?? 1);
