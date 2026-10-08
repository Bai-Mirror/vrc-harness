import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

/**
 * Test helpers for what differs between Linux and Windows: removing a temporary tree whose files a later `t.after`
 * hook still has open, and a fake command the code under test can start without a shell.
 */
export const windows = process.platform === 'win32';

/** Only for disposable fixtures owned by this test user: emulate a folder inheriting Modify, not Full Control. */
export function inheritedModify(t: { after: (fn: () => void) => void }, path: string): () => void {
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const sid = execFileSync(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-[\d-]+/)?.[0];
  if (!sid) throw new Error('Cannot identify the test user SID');
  const acl = (rights: string) => execFileSync(join(system, 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)(${rights})`],
    { stdio: 'pipe', windowsHide: true });
  const restore = () => { if (existsSync(path)) acl('F'); };
  t.after(restore);
  acl('M');
  return restore;
}

/**
 * Remove a test's temporary tree. Linux removes open files; Windows refuses until they are closed, and a fixture's
 * `t.after(() => db.close())` usually runs after its removal hook, so on Windows the removal is retried a little later.
 */
export function removeTemp(path: string): void {
  try { rmSync(path, { recursive: true, force: true }); }
  catch (error) {
    if (!windows) throw error;
    let tries = 0;
    const retry = (): void => {
      try { rmSync(path, { recursive: true, force: true }); }
      catch { if (++tries < 100) setTimeout(retry, 100); }
    };
    setTimeout(retry, 20);
  }
}

/**
 * A fake command written in JavaScript, run by the Node that runs the tests. It returns the path to configure: the
 * script itself with an executable bit on POSIX; on Windows an npm-style .cmd shim beside `<path>.js`, which the
 * Runtime resolves to `node <path>.js` exactly as it does for an npm-installed codex.
 */
export function fakeCommand(path: string, source: string): string {
  if (!windows) {
    writeFileSync(path, `#!/usr/bin/env node\n${source}\n`);
    chmodSync(path, 0o755);
    return path;
  }
  writeFileSync(`${path}.js`, `${source}\n`);
  const name = path.slice(path.lastIndexOf('\\') + 1);
  writeFileSync(`${path}.cmd`, ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL',
    'CALL :find_dp0', 'SET "_prog=node"', `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${name}.js" %*`, ''].join('\r\n'));
  return `${path}.cmd`;
}

/** A fake provider CLI that reports a version and a login, and fails anything else (the probe's view of codex). */
export const FAKE_PROVIDER = `const a = process.argv[2];
if (a === '--version') { console.log('fake 1.0'); process.exit(0); }
if (a === 'login') process.exit(0);
process.exit(1);`;

/** A regular expression matching a file path literally (Windows paths are full of backslashes). */
export function pathPattern(path: string): RegExp { return new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
/** The separator in a path pattern: `/` on POSIX, `\\` on Windows. */
export const SEP = windows ? '\\\\' : '/';
/** A path with `/` separators, for asserting paths the code returns (identity on POSIX). */
export function posixPath(path: string): string { return windows ? path.replaceAll('\\', '/') : path; }
/** Point the home directory at `path` for this test: HOME for POSIX, USERPROFILE for Windows (os.homedir reads it). */
export function useHome(t: { after: (fn: () => void) => void }, path: string): void {
  const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = path; if (windows) process.env.USERPROFILE = path;
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
}
/** Text for a RegExp source that matches `value` literally. */
export function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * A pid that names no process any more, for writing a lock a crashed holder would have left behind. The child is
 * started and reaped by `spawnSync`, then the liveness probe is written out here rather than imported, so the fixture
 * cannot agree with the product merely by sharing a bug. A just-freed pid can be handed out again, so the probe
 * decides instead of the assumption.
 */
export function deadPid(): number {
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const finished = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    if (finished.pid && !alive(finished.pid)) return finished.pid;
  }
  throw new Error('No exited child pid was available for this test');
}
