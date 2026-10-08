import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hostPlatform, windowsToolPath } from '../host-platform.ts';
import { DEFAULT_CANCEL_TIMEOUT_MS, recordedExitIn, UNIT_STOP_TIMEOUT_SEC, type ExitStatus, type RunLimits,
  type RunSupervisor } from './run-supervisor.ts';
import { queryJob, stopJob, windowsHelper, type JobState } from './windows-helper.ts';
import { CLAUDE_VARIABLE } from '../providers/claude.ts';

/**
 * What a Run inherits on Windows. systemd starts a Linux Run from the user manager's environment plus PATH; here the
 * Runtime's own environment is the user's session, so only these names pass: where Windows and the user's folders
 * are, locale, proxies a Provider needs, and Codex's state directory. Anything else the service happened to be
 * started with (a GUI session token, an API key) stays out of the Run. No ANTHROPIC_* or CLAUDE* variable is inherited
 * at all, whatever this list says: a Claude Run gets its configuration directory and credential from its command
 * (providers/claude.ts), and a Runtime started from inside a Claude Code session must not hand that session's
 * endpoints and tokens to the Runs it starts.
 */
export const WINDOWS_RUN_ENV = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'ALLUSERSPROFILE', 'PUBLIC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE', 'COMPUTERNAME', 'TEMP', 'TMP', 'LANG', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'ALL_PROXY', 'CODEX_HOME', 'PATH'];
export function windowsRunEnvironment(extra: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // Windows names are case-insensitive; keep the first spelling of each so no name reaches the child twice.
  const allowed = new Set(WINDOWS_RUN_ENV.map(name => name.toLowerCase()).filter(name => !CLAUDE_VARIABLE.test(name)));
  const env: Record<string, string> = {};
  const seen = new Map<string, string>();
  const put = (name: string, value: string | undefined): void => {
    if (value === undefined) return;
    const key = name.toLowerCase(), existing = seen.get(key);
    if (existing !== undefined && existing !== name) delete env[existing];
    seen.set(key, name); env[name] = value;
  };
  for (const [name, value] of Object.entries(source)) if (allowed.has(name.toLowerCase())) put(name, value);
  for (const [name, value] of Object.entries(extra)) put(name, value);
  const pathName = seen.get('path') ?? 'PATH';
  env[pathName] = windowsToolPath(env[pathName]);
  // Python on a Chinese Windows reads and writes text in the ANSI code page unless told otherwise; the pack's tools
  // (and Provider shells) exchange UTF-8.
  if (!seen.has('pythonutf8')) env.PYTHONUTF8 = '1';
  return env;
}

const STATE_READS = 3;
const STATE_REREAD_MS = 200;
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function jobName(runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid Run ID for a Windows job');
  return `avh-run-${runId}`;
}

/**
 * Windows counterpart of LinuxRunSupervisor. `avh-win unit` holds a named Job Object for the Run and exits when the
 * job's last process has; the job's name exists exactly while the Run does, like a transient unit. Refs have the same
 * form as on Linux (`avh-run-<id>`) and stay opaque to callers.
 */
export class WindowsRunSupervisor implements RunSupervisor {
  private readonly runRoot: string;
  private readonly cancelTimeoutMs: number;
  private readonly read: (name: string) => JobState | undefined;
  /** `read` looks a job up; tests replace it to reproduce the moments around a Run's exit. */
  constructor(runRoot: string, cancelTimeoutMs = DEFAULT_CANCEL_TIMEOUT_MS, read: (name: string) => JobState | undefined = queryJob) {
    if (cancelTimeoutMs <= UNIT_STOP_TIMEOUT_SEC * 1000) throw new Error('cancelTimeoutMs must exceed TimeoutStopSec');
    this.runRoot = runRoot;
    this.cancelTimeoutMs = cancelTimeoutMs;
    this.read = read;
  }
  refFor(runId: string): string { return jobName(runId); }
  loaded(ref: string): boolean { const state = this.read(ref); return state === 'running' || state === 'empty'; }
  runId(ref: string): string {
    if (!ref.startsWith('avh-run-')) throw new Error('Unexpected Run handle');
    const id = ref.slice('avh-run-'.length);
    jobName(id);
    return id;
  }
  async launch(runId: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string, limits: RunLimits): Promise<string> {
    const name = jobName(runId);
    const memory = limits.memoryMax ? parseMemory(limits.memoryMax) : undefined;
    const child = spawn(windowsHelper(), ['unit', '--name', name, '--run-dir', cwd,
      ...(memory ? ['--memory-max', String(memory)] : []),
      ...(limits.runtimeMaxSec ? ['--runtime-max-sec', String(limits.runtimeMaxSec)] : []), '--', ...argv],
    { detached: true, stdio: 'ignore', windowsHide: true, env: windowsRunEnvironment(env) });
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.unref();
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(cwd, 'exit.json')) || this.loaded(name)) return name;
      // 0 means a relaunched supervisor took over outside a job; it returns only once the job exists.
      if (spawnError || (child.exitCode !== null && child.exitCode !== 0)) break;
      await delay(50);
    }
    if (child.exitCode === 17) return name;
    if ((spawnError || child.exitCode !== null) && this.read(name) === 'not_found' && !existsSync(join(cwd, 'exit.json')))
      throw Object.assign(spawnError ?? new Error(`Windows Run supervisor exited ${child.exitCode}`), { noSideEffects: true });
    throw new Error(`Windows Run ${name} could not be confirmed`);
  }
  state(ref: string): 'running' | 'exited' | 'not_found' | 'unknown' {
    const runId = this.runId(ref);
    // The job empties and then disappears when its supervisor exits; either is "stopped" once exit.json is there.
    for (let attempt = 0; ; attempt++) {
      const state = this.read(ref);
      if (state === 'running') return 'running';
      if (existsSync(join(this.runRoot, runId, 'exit.json')) && (state === 'empty' || state === 'not_found')) return 'exited';
      if (state === 'not_found') return 'not_found';
      if (attempt === STATE_READS - 1) return 'unknown';
      pause(STATE_REREAD_MS);
    }
  }
  neverStarted(runId: string): boolean {
    return !existsSync(join(this.runRoot, runId, 'command.json')) && this.read(jobName(runId)) === 'not_found';
  }
  recordedExit(runId: string): ExitStatus | undefined { return recordedExitIn(this.runRoot, runId); }
  async stop(ref: string): Promise<'confirmed' | 'not_confirmed'> {
    const runId = this.runId(ref);
    const prior = this.read(ref);
    if (!prior) return 'not_confirmed';
    if (prior !== 'not_found') {
      const marker = join(this.runRoot, runId, 'cancel-requested');
      if (!existsSync(marker)) hostPlatform.writePrivate(marker, '', { flag: 'wx' });
      const stopped = stopJob(ref, this.cancelTimeoutMs);
      if (stopped !== 'stopped' && stopped !== 'not_found') return 'not_confirmed';
    }
    // Terminating the job ends the wrapper too, so it cannot write the exit record itself.
    const exit = join(this.runRoot, runId, 'exit.json');
    if (!existsSync(exit)) hostPlatform.writePrivate(exit,
      JSON.stringify({ exitStatus: 143, exit: { code: 143, signal: 'SIGTERM', timedOut: false, cancelled: true } }), { flag: 'wx' });
    return 'confirmed';
  }
}

/** systemd's MemoryMax syntax (bytes, or K/M/G/T suffixes) as bytes. */
export function parseMemory(value: string): number {
  const match = /^(\d+)([KMGT])?$/i.exec(value.trim());
  if (!match) throw new Error(`memoryMax: 无法理解 ${value}`);
  const power = match[2] ? 'KMGT'.indexOf(match[2].toUpperCase()) + 1 : 0;
  return Number(match[1]) * 1024 ** power;
}
