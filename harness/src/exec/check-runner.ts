import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hostPlatform, windowsToolPath } from '../host-platform.ts';
import { avhHome } from '../config.ts';
import { hostMasks, maskArgs } from './sandbox.ts';
import { probeLowIntegrity, protectHarnessHomeOnce } from './windows-boundary.ts';
import { checkJobName, labelWithLedger, listProcesses, releaseLedgers, stopJob, windowsHelper } from './windows-helper.ts';

/**
 * Independent checks run after a Provider exits, over files the Provider may have written. They get the
 * same power as a Provider or less: the project and the whole file system read-only, no network, a
 * scrubbed environment (no API keys), and only a scratch directory in the Run writable.
 */
/** `lowil`: Windows, a restricted Low integrity token in a job of its own (no network isolation; see windows-handoff.md). */
export type CheckIsolation = 'bwrap' | 'lowil' | 'none';
export interface CheckRunOptions {
  project: string;
  runDirectory: string;
  checkId: string;
  timeoutMs: number;
  extraEnv?: Record<string, string>;
  /** More directories the check reads (a tool root), bound back read-only over the private /tmp. */
  readonly?: string[];
  /** `auto` uses the platform's check sandbox when its probe passes; `bwrap` requires one (on Windows, `lowil`). */
  isolation?: CheckIsolation | 'auto';
  /** The Runtime's home, whose control socket, config and state the check must not reach. Defaults to AVH_HOME. */
  harnessHome?: string;
}
export interface CheckRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  isolation: CheckIsolation;
  isolationNote?: string;
  durationMs: number;
  logDir: string;
}

export const CHECK_PASS_ENV = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const;
const OUTPUT_LIMIT = 1024 * 1024;
let probe: { available: boolean; reason?: string } | undefined;

export function checkBwrapArgs(project: string, runDirectory: string, scratch: string, env: Record<string, string>,
  argv: string[], readonly: string[] = [], masks: string[] = []): string[] {
  // A PID namespace ends every descendant when bwrap dies, so cancelling one process group stops the whole check.
  // /tmp is private; the project and the Run are bound back read-only in case they live under /tmp.
  // No network does not mean no path sockets: `masks` hides the host endpoints (see hostMasks).
  return ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/',
    '--dev-bind', '/dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', ...masks,
    ...[project, ...readonly.filter(existsSync)].flatMap(path => ['--ro-bind', path, path]),
    '--ro-bind', runDirectory, runDirectory, '--bind', scratch, scratch, '--clearenv',
    ...Object.entries(env).flatMap(([name, value]) => ['--setenv', name, value]),
    '--chdir', project, '--', ...argv];
}

/** Probe once per process: a namespace failure must not be mistaken for a failing check. */
export function checkSandboxStatus(): { available: boolean; reason?: string } {
  if (probe) return probe;
  if (process.platform === 'win32') return probe = probeLowIntegrity();
  if (process.platform !== 'linux') return probe = { available: false, reason: `${process.platform} 上尚未实现检查沙箱` };
  const dir = mkdtempSync(join(tmpdir(), 'avh-check-probe-'));
  const result = spawnSync('bwrap', checkBwrapArgs(dir, dir, dir, { PATH: '/usr/bin:/bin' }, ['true'], [],
    maskArgs(hostMasks(avhHome()), [dir])),
    { encoding: 'utf8', timeout: 10_000 });
  rmSync(dir, { recursive: true, force: true });
  probe = result.status === 0 ? { available: true }
    : { available: false, reason: (result.stderr || String(result.error ?? `exit ${result.status}`)).trim().slice(0, 300) };
  return probe;
}
export function resetCheckSandboxProbe(): void { probe = undefined; }

/** What Windows programs need to start at all (Python fails without SystemRoot); none of it is a secret. */
export const WINDOWS_CHECK_PASS_ENV = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432'] as const;
export function checkEnvironment(home: string, tmp: string, extra: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHECK_PASS_ENV) if (source[name]) env[name] = source[name]!;
  if (platform === 'win32') {
    for (const name of WINDOWS_CHECK_PASS_ENV) if (source[name]) env[name] = source[name]!;
    env.PATH = windowsToolPath(env.PATH);
    // Python on a Chinese Windows otherwise reads and writes text in the ANSI code page.
    env.PYTHONUTF8 = '1';
    // The profile a Windows program writes to (Python's ~, git's global config) is the scratch home too.
    Object.assign(env, { USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
      TEMP: tmp, TMP: tmp });
  }
  return { ...env, HOME: home, TMPDIR: tmp, PYTHONDONTWRITEBYTECODE: '1', ...extra };
}

function checksDir(runDirectory: string): string { return join(runDirectory, 'checks'); }
function safeName(checkId: string): string { return checkId.replace(/[^A-Za-z0-9_.-]/g, '_'); }

/** Linux start time of a process, used so a recycled PID is never mistaken for a check. */
function startTicks(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return undefined; }
}
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function runCheckCommand(argv: string[], options: CheckRunOptions): Promise<CheckRunResult> {
  if (!argv.length) throw new Error('检查命令为空');
  if (process.platform === 'win32') return runWindowsCheck(argv, options);
  const dir = checksDir(options.runDirectory);
  const name = safeName(options.checkId);
  const scratch = join(dir, name);
  rmSync(scratch, { recursive: true, force: true });
  for (const path of [scratch, join(scratch, 'home'), join(scratch, 'tmp')]) hostPlatform.mkdirPrivate(path);
  const wanted = options.isolation ?? 'auto';
  const sandbox = wanted === 'none' ? { available: false, reason: '按调用方要求不隔离' } : checkSandboxStatus();
  if (wanted === 'bwrap' && !sandbox.available) throw new Error(`检查沙箱不可用: ${sandbox.reason}`);
  const isolation: CheckIsolation = sandbox.available ? 'bwrap' : 'none';
  const env = checkEnvironment(join(scratch, 'home'), isolation === 'bwrap' ? '/tmp' : join(scratch, 'tmp'), options.extraEnv);
  const [command, args] = isolation === 'bwrap'
    ? ['bwrap', checkBwrapArgs(options.project, options.runDirectory, scratch, env, argv, options.readonly,
      maskArgs(hostMasks(options.harnessHome ?? avhHome()),
        [options.project, options.runDirectory, scratch, ...(options.readonly ?? [])]))] as const
    : [argv[0]!, argv.slice(1)] as const;
  const started = Date.now();
  const child = spawn(command, args, { cwd: options.project, env: isolation === 'bwrap' ? { PATH: env.PATH ?? '' } : env,
    detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pidFile = join(dir, `${name}.pid`);
  if (child.pid) hostPlatform.writePrivate(pidFile, JSON.stringify({ pid: child.pid, start: startTicks(child.pid) ?? null }));
  const out: Buffer[] = []; const err: Buffer[] = []; let outBytes = 0; let errBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => { if (outBytes < OUTPUT_LIMIT) { out.push(chunk); outBytes += chunk.length; } });
  child.stderr.on('data', (chunk: Buffer) => { if (errBytes < OUTPUT_LIMIT) { err.push(chunk); errBytes += chunk.length; } });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, options.timeoutMs);
  const exit = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.on('error', error => { err.push(Buffer.from(String(error))); resolve({ status: null, signal: null }); });
    child.on('close', (status, signal) => resolve({ status, signal }));
  });
  clearTimeout(timer);
  // A check that leaves background processes behind does not get to keep them.
  try { if (child.pid && groupAlive(child.pid)) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  rmSync(pidFile, { force: true });
  const stdout = Buffer.concat(out).toString('utf8'); const stderr = Buffer.concat(err).toString('utf8');
  writeFileSync(join(dir, `${name}.stdout.log`), stdout, { mode: 0o600 });
  writeFileSync(join(dir, `${name}.stderr.log`), stderr, { mode: 0o600 });
  return { ...exit, timedOut, stdout, stderr, isolation,
    ...(isolation === 'none' ? { isolationNote: sandbox.reason ?? 'bwrap 不可用' } : {}),
    durationMs: Date.now() - started, logDir: dir };
}

/**
 * Windows: the check runs through the helper at Low integrity in a named job. Only its scratch directory carries a Low
 * label; the project, the Run directory and everything else stay read-only, and the Runtime's own files are unreadable
 * (protectHarnessHome). Low integrity does not isolate the network.
 */
async function runWindowsCheck(argv: string[], options: CheckRunOptions): Promise<CheckRunResult> {
  const dir = checksDir(options.runDirectory);
  const name = safeName(options.checkId);
  const scratch = join(dir, name);
  const home = options.harnessHome ?? avhHome();
  releaseLedgers(home, scratch);
  rmSync(scratch, { recursive: true, force: true });
  for (const path of [scratch, join(scratch, 'home'), join(scratch, 'home', 'AppData', 'Roaming'),
    join(scratch, 'home', 'AppData', 'Local'), join(scratch, 'tmp')]) hostPlatform.mkdirPrivate(path);
  const wanted = options.isolation ?? 'auto';
  const sandbox = wanted === 'none' ? { available: false, reason: '按调用方要求不隔离' } : checkSandboxStatus();
  if ((wanted === 'bwrap' || wanted === 'lowil') && !sandbox.available) throw new Error(`检查沙箱不可用: ${sandbox.reason}`);
  const isolation: CheckIsolation = sandbox.available ? 'lowil' : 'none';
  const env = checkEnvironment(join(scratch, 'home'), join(scratch, 'tmp'), options.extraEnv);
  const job = checkJobName(options.runDirectory, name);
  if (isolation === 'lowil') { protectHarnessHomeOnce(home); labelWithLedger(home, scratch, [scratch]); }
  const helper = windowsHelper();
  const started = Date.now();
  const child = spawn(helper, ['sandbox', ...(isolation === 'lowil' ? ['--low'] : []), '--name', job, '--', ...argv],
    { cwd: options.project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const pidFile = join(dir, `${name}.pid`);
  if (child.pid) hostPlatform.writePrivate(pidFile, JSON.stringify({ pid: child.pid, start: null, job }));
  const out: Buffer[] = []; const err: Buffer[] = []; let outBytes = 0; let errBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => { if (outBytes < OUTPUT_LIMIT) { out.push(chunk); outBytes += chunk.length; } });
  child.stderr.on('data', (chunk: Buffer) => { if (errBytes < OUTPUT_LIMIT) { err.push(chunk); errBytes += chunk.length; } });
  let timedOut = false;
  // Ending the helper ends its job, and with it everything the check started.
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);
  const exit = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.on('error', error => { err.push(Buffer.from(String(error))); resolve({ status: null, signal: null }); });
    child.on('close', (status, signal) => resolve({ status, signal }));
  });
  clearTimeout(timer);
  rmSync(pidFile, { force: true });
  if (isolation === 'lowil') releaseLedgers(home, scratch);
  const stdout = Buffer.concat(out).toString('utf8'); const stderr = Buffer.concat(err).toString('utf8');
  writeFileSync(join(dir, `${name}.stdout.log`), stdout, { mode: 0o600 });
  writeFileSync(join(dir, `${name}.stderr.log`), stderr, { mode: 0o600 });
  return { ...exit, timedOut, stdout, stderr, isolation,
    ...(isolation === 'none' ? { isolationNote: sandbox.reason ?? '检查沙箱不可用' } : {}),
    durationMs: Date.now() - started, logDir: dir };
}

/** End a check's helper process if it is still that helper (a recycled PID is left alone); true once it is gone. */
async function endWindowsHelper(pid: number, waitMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  const alive = (): boolean => listProcesses('avh-win.exe').some(process => process.pid === pid);
  if (!alive()) return true;
  try { process.kill(pid); } catch { /* exited meanwhile */ }
  for (const deadline = Date.now() + waitMs; alive() && Date.now() < deadline;) await delay(25);
  return !alive();
}

/**
 * Stop every check still running for this Run, from any process: the PID files in the Run directory
 * identify the process groups. Confirmed only when none of them is alive.
 */
export async function cancelChecks(runDirectory: string, waitMs = 5000): Promise<'confirmed' | 'not_confirmed'> {
  const dir = checksDir(runDirectory);
  if (!existsSync(dir)) return 'confirmed';
  const groups: number[] = [];
  let windowsPending = false;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.pid')) continue;
    try {
      const saved = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as { pid: number; start: string | null; job?: string };
      // Windows names each check's job; stopping the job stops the whole check wherever it was started from.
      if (saved.job) {
        const stopped = stopJob(saved.job, waitMs);
        // The helper creates the job a moment after it starts: in that moment only the helper itself exists, and ending
        // it ends the check (a job it already holds dies with it; one it has not yet created never starts anything).
        const helperGone = stopped === 'stopped' || (stopped === 'not_found' && await endWindowsHelper(saved.pid, waitMs));
        if (helperGone) rmSync(join(dir, entry), { force: true });
        else windowsPending = true;
        continue;
      }
      if (!Number.isSafeInteger(saved.pid) || saved.pid < 2) continue;
      // A recycled PID belongs to someone else; the check it named is gone.
      if (saved.start !== null && startTicks(saved.pid) !== saved.start) { rmSync(join(dir, entry), { force: true }); continue; }
      if (!groupAlive(saved.pid)) { rmSync(join(dir, entry), { force: true }); continue; }
      process.kill(-saved.pid, 'SIGKILL');
      groups.push(saved.pid);
    } catch { /* unreadable entry: the check never recorded a live group */ }
  }
  const deadline = Date.now() + waitMs;
  while (groups.some(groupAlive) && Date.now() < deadline) await delay(25);
  return groups.some(groupAlive) || windowsPending ? 'not_confirmed' : 'confirmed';
}
