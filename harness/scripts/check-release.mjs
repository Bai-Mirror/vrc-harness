#!/usr/bin/env node
// The two release gates that decide whether a built installer may be published, run together in order:
//
//   node scripts/check-release.mjs <setup.exe>
//   npm run release:check -- <setup.exe>
//
// check:release-artifacts reads the builder's private paths back out of the shipped bytes and check:installer-location
// drives the installer through the install-location cases. Neither is part of `npm run check`, because check never
// builds an installer; a release that skipped them is a release nobody inspected. This entry point exists so the
// publish steps in deploy/README.md can name one command, and it stops at the first gate that fails.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = [
  '用法：npm run release:check -- <安装包路径>',
  '依次执行 check:release-artifacts 与 check:installer-location，任一失败即以非零状态退出。',
  '这两道判据不在 npm run check 里（check 不构建安装包），发布前必须显式执行。',
].join('\n');

const args = process.argv.slice(2);
// The installer path is required; flags alone are not a release to check.
if (!args.some(value => !value.startsWith('-'))) {
  console.error(USAGE);
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
for (const name of ['check-release-artifacts.mjs', 'check-installer-location.mjs']) {
  const result = spawnSync(process.execPath, [join(here, name), ...args], { stdio: 'inherit' });
  if (result.error) {
    console.error(`release:check: 无法运行 ${name}：${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`release:check: ${name} 未通过（退出码 ${result.status}），停止后续判据。发布前必须两道都通过。`);
    process.exit(result.status ?? 1);
  }
}
console.log('release:check: 两道发布判据都通过。');
