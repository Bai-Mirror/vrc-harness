#!/usr/bin/env node
// Drives a built NSIS installer through the install-location cases the Tauri template gets wrong.
//
//   node scripts/check-installer-location.mjs [--json] <setup.exe>
//
// The installer remembers the last install location in HKCU\Software\avatar-harness\Harness and restores it over the
// default $LOCALAPPDATA\Harness on every later run. Two things follow from that, and both were measured on a real
// package (lane L15, section 4): a remembered location that no longer exists installs a whole copy into a dead tree,
// and a silent uninstall never removes the memory, because the template's cleanup sits behind a checkbox that silent
// mode never creates. src-tauri/windows/installer-hooks.nsh is what fixes both, and this entry point is what reads
// the fix back off a built installer: a hook that compiles is not a hook that runs.
//
// Everything it changes lives in the installer's own registry key and one directory under %LOCALAPPDATA%. It backs
// the key up and moves any existing %LOCALAPPDATA%\Harness aside before it starts, and puts both back in a finally
// block, so a failure still leaves the machine as it was. It never touches the Harness home directory
// (%LOCALAPPDATA%\avh) or a running service, and it checks that the home's config is byte-identical afterwards.
//
// Windows only: NSIS, and the registry key, exist nowhere else.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The installer's own key: its default value is the remembered location, and the MUI language is remembered there too. */
const VENDOR_KEY = 'HKCU\\Software\\avatar-harness';
const LOCATION_KEY = `${VENDOR_KEY}\\Harness`;
/** Written by the hook when it refuses the remembered location; the reason is what proves which rule fired. */
const REJECTED_VALUE = 'RejectedInstallLocation';
const REJECTED_REASON_VALUE = 'RejectedInstallLocationReason';
const PRODUCT = 'Harness';
const INSTALL_TIMEOUT = 300_000, UNINSTALL_TIMEOUT = 120_000;
/**
 * Named outright rather than left to PATH: this machine's PATH has a Unix `whoami` from the Windows git install, so
 * `spawnSync('whoami.exe', …)` runs `/usr/bin/whoami` and fails on `/user`. The other two have the same exposure and
 * cost nothing to pin. Matches what test/fixtures/platform.ts already does for whoami and icacls.
 */
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const REG = join(SYSTEM32, 'reg.exe');
const ICACLS = join(SYSTEM32, 'icacls.exe');
const WHOAMI = join(SYSTEM32, 'whoami.exe');

/** Sleep without a child process: the uninstaller runs in the background for a moment even when asked to run in place. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** A Windows command line is passed through verbatim: NSIS reads /D=<path> itself, and a quoted path breaks it. */
function run(file, args, timeout) {
  return spawnSync(file, args, { windowsVerbatimArguments: true, timeout, encoding: 'utf8', windowsHide: true });
}
/** The value of a registry value, read without depending on reg.exe's output language. */
function regValue(key, name) {
  const result = run(REG, name === undefined ? ['query', key, '/ve'] : ['query', key, '/v', name]);
  if (result.status !== 0) return undefined;
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    const at = line.indexOf('REG_');
    if (at < 0) continue;
    const space = line.indexOf(' ', at);
    return space < 0 ? '' : line.slice(space).trim();
  }
  return undefined;
}
function regKeyExists(key) {
  return run(REG, ['query', key]).status === 0;
}
/** `reg delete` on a key that is already gone fails; that is the state we want either way. */
function regDeleteTree(key) {
  run(REG, ['delete', key, '/f']);
}
function dirFileCount(path) {
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    count += entry.isDirectory() ? dirFileCount(join(path, entry.name)) : 1;
  }
  return count;
}
function removeDir(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5 });
}
/**
 * A file count that does not throw. A directory under a deny ACE can be impossible even to list — a plain `(W)` deny
 * blocks SYNCHRONIZE as well, so opening it to list files is refused (measured) — and that must read as "no reading
 * taken" rather than abort the case that was about to report one.
 */
function safeDirFileCount(path) {
  try { return dirFileCount(path); } catch { return undefined; }
}
/** The current user as a SID, for an ACL that has to work whatever the account is called in this locale. */
function currentUserSid() {
  const result = run(WHOAMI, ['/user', '/fo', 'csv', '/nh']);
  const sid = /S-1-5[\d-]+/.exec(result.stdout ?? '');
  if (!sid) throw new Error(`无法取得当前用户 SID：${result.stdout}`);
  return sid[0];
}
/** SHA-256 of the Harness home's config, so the run can prove it left the real home alone. */
function homeConfigDigest() {
  const config = join(process.env.LOCALAPPDATA, 'avh', 'config', 'harness.yaml');
  return existsSync(config) ? createHash('sha256').update(readFileSync(config)).digest('hex') : undefined;
}
/** NSIS uninstallers copy themselves to %TEMP% and return at once unless `_?=` tells them to run in place. */
function uninstall(directory) {
  const uninstaller = join(directory, 'uninstall.exe');
  if (!existsSync(uninstaller)) return { ran: false };
  const started = Date.now();
  const result = run(uninstaller, ['/S', `_?=${directory}`], UNINSTALL_TIMEOUT);
  // Running in place blocks this process, but a leftover uninstall.exe keeps the directory non-empty, so wait for the
  // file count to stop falling rather than for it to reach zero. Reaching zero is the common case and ends at once.
  let last = dirFileCount(directory), stable = 0;
  const deadline = Date.now() + 60_000;
  while (last > 0 && Date.now() < deadline && stable < 3) {
    sleep(400);
    const now = dirFileCount(directory);
    stable = now < last ? 0 : stable + 1;
    last = now;
  }
  const seconds = (Date.now() - started) / 1000;
  const leftBehind = last;
  removeDir(directory);
  return { ran: true, status: result.status, seconds, leftBehind };
}

class Report {
  constructor() { this.checks = []; this.notes = []; }
  check(label, ok, detail) { this.checks.push({ label, ok: Boolean(ok), detail: detail ?? '' }); return Boolean(ok); }
  note(text) { this.notes.push(text); }
  get failures() { return this.checks.filter(check => !check.ok); }
}

/** The cases run against one installer, with the remembered location as the only thing that varies between them. */
function cases(setup, defaultDir, report) {
  const stamp = `${process.pid}-${Date.now()}`;
  const fresh = () => { regDeleteTree(LOCATION_KEY); removeDir(defaultDir); };

  // 1. The remembered location is gone: the install has to land on the default and record why it moved. The path is
  //    outside %TEMP% on purpose, so the temp rule cannot be what answers for it — the template's own
  //    `SetOutPath $INSTDIR` recreates a deleted directory before the hook runs, so "gone" presents itself as a
  //    directory holding no Harness installation, and this is the case that reads that back.
  {
    const gone = join(process.env.LOCALAPPDATA, `${PRODUCT}-location-f5-gone-${stamp}`);
    fresh();
    removeDir(gone);
    try {
      run(REG, ['add', LOCATION_KEY, '/ve', '/t', 'REG_SZ', '/d', gone, '/f']);
      const installed = run(setup, ['/S'], INSTALL_TIMEOUT);
      const onDefault = existsSync(join(defaultDir, 'avatar-harness-desktop.exe'));
      report.check('① 位置记忆指向不存在的目录 → /S 安装落到默认位置', installed.status === 0 && onDefault,
        `exit=${installed.status} 默认位置有 exe=${onDefault}`);
      report.check('① 安装后位置记忆指向实际安装目录', regValue(LOCATION_KEY) === defaultDir, `记忆=${regValue(LOCATION_KEY)}`);
      report.check('① 记录了被拒绝的位置与原因',
        regValue(LOCATION_KEY, REJECTED_VALUE) === gone && regValue(LOCATION_KEY, REJECTED_REASON_VALUE) === 'missing',
        `${REJECTED_VALUE}=${regValue(LOCATION_KEY, REJECTED_VALUE)} ${REJECTED_REASON_VALUE}=${regValue(LOCATION_KEY, REJECTED_REASON_VALUE)}`);
      const removed = uninstall(defaultDir);
      report.check('④ 静默卸载后位置记忆键已删除', !regKeyExists(LOCATION_KEY), `键存在=${regKeyExists(LOCATION_KEY)} 卸载=${removed.status}`);
    } finally { removeDir(gone); }
  }

  // 2. The remembered location is a real directory inside %TEMP%: existing and writable, and still not a place to
  //    install into. This is the exact state a previous dry run left on the machine.
  {
    const temporary = join(tmpdir(), `avh-location-temp-${stamp}`);
    fresh();
    mkdirSync(temporary, { recursive: true });
    run(REG, ['add', LOCATION_KEY, '/ve', '/t', 'REG_SZ', '/d', temporary, '/f']);
    const installed = run(setup, ['/S'], INSTALL_TIMEOUT);
    const onDefault = existsSync(join(defaultDir, 'avatar-harness-desktop.exe'));
    const wroteTemporary = existsSync(join(temporary, 'avatar-harness-desktop.exe'));
    report.check('② 位置记忆指向 %TEMP% 下的目录 → /S 安装回落默认位置', installed.status === 0 && onDefault && !wroteTemporary,
      `exit=${installed.status} 默认位置有 exe=${onDefault} 临时目录被写入=${wroteTemporary}`);
    report.check('② 记录的原因说明是临时目录', regValue(LOCATION_KEY, REJECTED_REASON_VALUE) === 'temp',
      `${REJECTED_REASON_VALUE}=${regValue(LOCATION_KEY, REJECTED_REASON_VALUE)}`);
    const removed = uninstall(defaultDir);
    report.check('④ 静默卸载后位置记忆键已删除（临时位置这一轮）', !regKeyExists(LOCATION_KEY),
      `键存在=${regKeyExists(LOCATION_KEY)} 卸载=${removed.status}`);
    removeDir(temporary);
  }

  // 2b. A remembered location that is still there and outside %TEMP%, but cannot be written: an install into it
  //     would fail part way through and leave a half-written tree behind, which is the worst of the three states.
  {
    const denied = join(process.env.LOCALAPPDATA, `${PRODUCT}-location-f5-deny`);
    fresh();
    removeDir(denied);
    let sid, reported = false;
    try {
      mkdirSync(denied, { recursive: true });
      sid = currentUserSid();
      // Deny write-data and append-data, not the whole write right: `(W)` also denies SYNCHRONIZE, which makes the
      // directory impossible to open for listing at all (measured), so the case could not read back what it set up.
      // This is the state an install cannot write into while everything else about the directory still works.
      const acl = run(ICACLS, [denied, '/deny', `*${sid}:(WD,AD)`]);
      if (acl.status !== 0) report.note(`无法给 ${denied} 加拒绝写权限（icacls exit=${acl.status}），本项读数不可信`);
      run(REG, ['add', LOCATION_KEY, '/ve', '/t', 'REG_SZ', '/d', denied, '/f']);
      const installed = run(setup, ['/S'], INSTALL_TIMEOUT);
      const onDefault = existsSync(join(defaultDir, 'avatar-harness-desktop.exe'));
      const wroteDenied = safeDirFileCount(denied);
      report.check('② 位置记忆指向不可写目录 → /S 安装回落默认位置', installed.status === 0 && onDefault && wroteDenied === 0,
        `exit=${installed.status} 默认位置有 exe=${onDefault} 拒绝目录文件数=${wroteDenied ?? '(读不到)'}`);
      report.check('② 记录的原因说明是目录不可写', regValue(LOCATION_KEY, REJECTED_REASON_VALUE) === 'unwritable',
        `${REJECTED_REASON_VALUE}=${regValue(LOCATION_KEY, REJECTED_REASON_VALUE)}`);
      const rejected = regValue(LOCATION_KEY, REJECTED_VALUE);
      report.check('② 记录的不可写位置就是被拒绝的那个目录', rejected === denied, `${REJECTED_VALUE}=${rejected}`);
      const removed = uninstall(defaultDir);
      report.check('④ 静默卸载后位置记忆键已删除（不可写这一轮）', !regKeyExists(LOCATION_KEY),
        `键存在=${regKeyExists(LOCATION_KEY)} 卸载=${removed.status}`);
      reported = true;
    } catch (error) {
      report.note(`无法构造"不可写目录"用例：${error.message}`);
    } finally {
      if (sid) run(ICACLS, [denied, '/remove:d', `*${sid}`]);
      run(ICACLS, [denied, '/reset', '/t', '/q']);
      try { removeDir(denied); } catch (error) { report.note(`未能删除 ${denied}：${error.message}`); }
    }
    // A reading that could not be taken is a failure, never a pass: the ACL case is the only place the writability
    // rule is read off a real installer.
    if (!reported) report.check('② 位置记忆指向不可写目录 → /S 安装回落默认位置', false, '本项未能执行，读数缺失');
  }

  // 3. A location that is still there, writable and outside %TEMP% has to be kept, or the fix would break the upgrade
  //    path it shares code with. /D= is how the first install chooses it; the second run passes no /D=, so the
  //    location can only come from the registry.
  {
    const kept = join(process.env.LOCALAPPDATA, `${PRODUCT}-location-f5`);
    fresh();
    const first = run(setup, ['/S', `/D=${kept}`], INSTALL_TIMEOUT);
    const firstOk = first.status === 0 && existsSync(join(kept, 'avatar-harness-desktop.exe'));
    report.check('③ 用 /D= 指定目录安装成功', firstOk, `exit=${first.status} exe=${existsSync(join(kept, 'avatar-harness-desktop.exe'))}`);
    report.check('③ 安装把该目录记为位置记忆', regValue(LOCATION_KEY) === kept, `记忆=${regValue(LOCATION_KEY)}`);
    const second = run(setup, ['/S'], INSTALL_TIMEOUT);
    const amongDefault = dirFileCount(defaultDir);
    report.check('③ 已存在且可写的旧位置仍被沿用（升级路径）',
      second.status === 0 && existsSync(join(kept, 'avatar-harness-desktop.exe')) && amongDefault === 0,
      `exit=${second.status} 目标有 exe=${existsSync(join(kept, 'avatar-harness-desktop.exe'))} 默认位置文件数=${amongDefault}`);
    report.check('③ 沿用时不留拒绝记录', regValue(LOCATION_KEY, REJECTED_VALUE) === undefined,
      `${REJECTED_VALUE}=${regValue(LOCATION_KEY, REJECTED_VALUE)}`);
    const removed = uninstall(kept);
    report.check('④ 静默卸载后位置记忆键已删除（沿用这一轮）', !regKeyExists(LOCATION_KEY),
      `键存在=${regKeyExists(LOCATION_KEY)} 卸载=${removed.status}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const inputs = args.filter(value => !value.startsWith('--'));
  if (process.platform !== 'win32') {
    console.error('检查安装位置需要 Windows：NSIS 与 HKCU 注册表键只存在于 Windows。');
    process.exit(2);
  }
  if (!inputs.length) {
    console.error('用法: node scripts/check-installer-location.mjs [--json] <安装包.exe>');
    process.exit(2);
  }
  const setup = resolve(inputs[0]);
  if (!existsSync(setup)) {
    console.error(`找不到安装包：${setup}`);
    process.exit(2);
  }

  const report = new Report();
  // NSIS parses /D= out of the raw command line and forbids quotes, so a path with a space cannot be passed through
  // verbatim. Say so instead of failing somewhere inside the installer.
  const spaced = [setup, tmpdir(), process.env.LOCALAPPDATA].filter(value => value.includes(' '));
  if (spaced.length) {
    console.error(`检查目录不能含空格（NSIS 的 /D= 不接受引号）：${spaced.join('、')}`);
    process.exit(2);
  }

  const defaultDir = join(process.env.LOCALAPPDATA, PRODUCT);
  const homeBefore = homeConfigDigest();
  report.note(`安装包 ${setup}`);
  report.note(`默认位置 ${defaultDir}；临时目录 ${tmpdir()}；用户 HOME 配置摘要 ${homeBefore ?? '(不存在)'}`);

  // The generated template is rebuilt from scratch every time, so the hook has to be wired into it: an unwired hook
  // compiles, ships and does nothing.
  const generated = join(resolve(setup, '..'), '..', '..', 'nsis', 'x64', 'installer.nsi');
  if (existsSync(generated)) {
    const text = readFileSync(generated, 'utf8');
    report.check('生成的 installer.nsi 插入了 PREINSTALL/POSTUNINSTALL 钩子',
      text.includes('!insertmacro NSIS_HOOK_PREINSTALL') && text.includes('!insertmacro NSIS_HOOK_POSTUNINSTALL'), generated);
    report.check('模板仍在 .onInit 里恢复上次安装位置（修复的前提）', text.includes('Call RestorePreviousInstallLocation'), generated);
  } else {
    report.note(`未找到生成的 installer.nsi（${generated}），跳过接线断言；安装/卸载实测不受影响。`);
  }

  // Isolation: the vendor key and the default directory are the only state this touches, and both go back in finally.
  const backupDir = mkdtempSync(join(tmpdir(), 'avh-location-backup-'));
  const backupFile = join(backupDir, 'avatar-harness.reg');
  const hadKey = regKeyExists(VENDOR_KEY);
  const parked = join(process.env.LOCALAPPDATA, `${PRODUCT}-f5-parked-${process.pid}`);
  const hadDefault = existsSync(defaultDir);
  const filesBefore = dirFileCount(defaultDir);
  try {
    if (hadKey) {
      const exported = run(REG, ['export', VENDOR_KEY, backupFile, '/y']);
      if (exported.status !== 0) throw new Error(`无法备份注册表键 ${VENDOR_KEY}: ${exported.stderr}`);
    }
    if (hadDefault) renameSync(defaultDir, parked);
    report.note(`隔离：注册表键 ${hadKey ? `已备份到 ${backupFile}` : '原本不存在'}；默认目录 ${hadDefault ? `已移到 ${parked}` : '原本不存在'}`);
    cases(setup, defaultDir, report);
  } catch (error) {
    // An unexpected failure still has to print what was read: the first run of this check died in a helper and threw
    // away readings from three cases that had already run, which is the opposite of what a check is for.
    report.check('检查过程没有意外失败', false, error instanceof Error ? error.message : String(error));
  } finally {
    regDeleteTree(VENDOR_KEY);
    if (hadKey) {
      const imported = run(REG, ['import', backupFile]);
      report.note(imported.status === 0 ? `注册表键已恢复（默认值=${regValue(LOCATION_KEY)}）` : `恢复注册表键失败：${imported.stderr}`);
    } else {
      report.note('注册表键原本不存在，保持删除。');
    }
    removeDir(defaultDir);
    if (hadDefault) {
      if (existsSync(parked)) renameSync(parked, defaultDir);
      else report.note(`严重：备份的目录 ${parked} 不见了，未能恢复 ${defaultDir}。`);
    }
    report.note(`默认位置文件数：开始 ${filesBefore}，结束 ${dirFileCount(defaultDir)}`);
    report.check('未改动 Harness 正式 HOME 的配置', homeConfigDigest() === homeBefore, `${homeBefore} → ${homeConfigDigest()}`);
    removeDir(backupDir);
  }

  if (args.includes('--json')) console.log(JSON.stringify({ checks: report.checks, notes: report.notes }, null, 2));
  else {
    for (const check of report.checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.label}${check.detail ? `  [${check.detail}]` : ''}`);
    for (const note of report.notes) console.log(`     ${note}`);
    console.log(`${report.failures.length ? '失败' : '通过'}：${report.checks.length} 项检查，${report.failures.length} 项失败`);
  }
  process.exit(report.failures.length ? 1 : 0);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invoked) main();
