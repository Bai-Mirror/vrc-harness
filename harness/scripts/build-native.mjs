// Build the Windows helper (native/windows, Rust): the Job Objects, Low integrity sandbox, integrity labels and login
// autostart that the Runtime needs on Windows (docs/windows-handoff.md). Usage: node scripts/build-native.mjs
// build.mjs calls it on Windows and copies the executables into dist/native. Other platforms have nothing to build.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const windowsHelpers = ['avh-win.exe', 'avh-win-launch.exe'];

/** Build the helper against the locked dependencies; returns the directory that holds the executables. */
export function buildWindowsHelper() {
  // rustup installs cargo into ~/.cargo/bin, which shells opened before the install do not have on PATH yet.
  const cargo = [process.env.CARGO_HOME && join(process.env.CARGO_HOME, 'bin', 'cargo.exe'), join(homedir(), '.cargo', 'bin', 'cargo.exe')]
    .find(path => path && existsSync(path)) ?? 'cargo';
  const result = spawnSync(cargo, ['build', '--release', '--locked', '--manifest-path', join(root, 'native', 'windows', 'Cargo.toml')],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error || result.status !== 0)
    throw new Error(`Windows 辅助程序构建失败（${result.error?.message ?? `cargo 退出码 ${result.status}`}）：需要 Rust（rustup，x86_64-pc-windows-msvc）与 Visual Studio C++ 生成工具`);
  return join(root, 'native', 'windows', 'target', 'release');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.platform === 'win32') console.error(`built ${windowsHelpers.join(', ')} -> ${buildWindowsHelper()}`);
  else console.error('Windows 辅助程序只在 Windows 上构建，这个平台用不到它');
}
