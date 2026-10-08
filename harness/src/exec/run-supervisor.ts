import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hostPlatform } from '../host-platform.ts';
import { WindowsRunSupervisor } from './windows-supervisor.ts';

export interface ExitStatus { code: number; signal?: NodeJS.Signals; timedOut: boolean; cancelled: boolean }
export interface RunLimits { memoryMax?: string; runtimeMaxSec?: number }
export interface RunSupervisor {
  launch(runId: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string, limits: RunLimits): Promise<string>;
  state(ref: string): 'running' | 'exited' | 'not_found' | 'unknown';
  stop(ref: string): Promise<'confirmed' | 'not_confirmed'>;
  neverStarted(runId: string): boolean;
  recordedExit(runId: string): ExitStatus | undefined;
}

export const UNIT_STOP_TIMEOUT_SEC = 5;
const LIVE_STATES = new Set(['active', 'activating', 'deactivating', 'reloading']);
const STATE_READS = 3;
const STATE_REREAD_MS = 200;
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
export const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;

function unitName(runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid Run ID for systemd unit');
  return `avh-run-${runId}`;
}
function show(unit: string): Record<string, string> | undefined {
  try {
    const call = (args: string[]): { stdout: string; stderr: string; status: number | null } => {
      const result = spawnSync('busctl', ['--user', ...args], { encoding: 'utf8' });
      return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), status: result.status };
    };
    const found = call(['call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager', 'GetUnit', 's', `${unit}.service`]);
    if (found.status !== 0) return found.stderr.includes('not loaded') || found.stderr.includes('NoSuchUnit')
      ? { LoadState: 'not-found', ActiveState: 'inactive', ControlGroup: '' } : undefined;
    const path = /^o "([^"]+)"$/.exec(found.stdout)?.[1] ?? '';
    if (!path) return undefined;
    const property = (iface: string, key: string): string => {
      const value = call(['get-property', 'org.freedesktop.systemd1', path, iface, key]);
      if (value.status !== 0) throw new Error(value.stderr);
      return /^s "(.*)"$/.exec(value.stdout)?.[1] ?? '';
    };
    return { LoadState: 'loaded', ActiveState: property('org.freedesktop.systemd1.Unit', 'ActiveState'),
      ControlGroup: property('org.freedesktop.systemd1.Service', 'ControlGroup') };
  } catch { return undefined; }
}
function cgroupEmpty(group: string): boolean {
  if (!group) return true;
  const path = join('/sys/fs/cgroup', group);
  if (!existsSync(path)) return true;
  try {
    if (readFileSync(join(path, 'cgroup.procs'), 'utf8').trim()) return false;
    return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .every(entry => cgroupEmpty(join(group, entry.name)));
  } catch { return false; }
}
export function unitProcessCount(ref: string): number | undefined {
  const state = show(ref);
  if (!state) return undefined;
  const count = (group: string): number => {
    if (!group) return 0;
    const path = join('/sys/fs/cgroup', group);
    if (!existsSync(path)) return 0;
    const own = readFileSync(join(path, 'cgroup.procs'), 'utf8').trim().split('\n').filter(Boolean).length;
    return own + readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .reduce((total, entry) => total + count(join(group, entry.name)), 0);
  };
  try { return count(state.ControlGroup ?? ''); } catch { return undefined; }
}

/** The exit a Run's wrapper (or its stopper) recorded in exit.json, whichever platform supervised it. */
export function recordedExitIn(runRoot: string, runId: string): ExitStatus | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(join(runRoot, runId, 'exit.json'), 'utf8')) as
      { exit?: ExitStatus; exitStatus?: number; timedOut?: boolean };
    if (raw.exit && Number.isSafeInteger(raw.exit.code)) return raw.exit;
    return Number.isSafeInteger(raw.exitStatus) ? { code: raw.exitStatus!, timedOut: !!raw.timedOut,
      cancelled: false } : undefined;
  } catch { return undefined; }
}

/** Only the Linux implementation interprets unit names; refs remain opaque to callers. */
export class LinuxRunSupervisor implements RunSupervisor {
  private readonly runRoot: string;
  private readonly cancelTimeoutMs: number;
  private readonly read: typeof show;
  /** `read` looks a unit up in systemd; tests replace it to reproduce the moments around a unit's exit. */
  constructor(runRoot: string, cancelTimeoutMs = DEFAULT_CANCEL_TIMEOUT_MS, read: typeof show = show) {
    if (cancelTimeoutMs <= UNIT_STOP_TIMEOUT_SEC * 1000)
      throw new Error('cancelTimeoutMs must exceed TimeoutStopSec');
    this.runRoot = runRoot;
    this.cancelTimeoutMs = cancelTimeoutMs;
    this.read = read;
  }
  refFor(runId: string): string { return unitName(runId); }
  loaded(ref: string): boolean { return show(ref)?.LoadState === 'loaded'; }
  runId(ref: string): string {
    if (!ref.startsWith('avh-run-')) throw new Error('Unexpected Run handle');
    const id = ref.slice('avh-run-'.length);
    unitName(id);
    return id;
  }
  async launch(runId: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string, limits: RunLimits): Promise<string> {
    const unit = unitName(runId);
    const args = ['--user', `--unit=${unit}`, '--collect', '--wait',
      '--property=KillMode=control-group', `--property=TimeoutStopSec=${UNIT_STOP_TIMEOUT_SEC}s`,
      ...Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([name, value]) => `--setenv=${name}=${value}`)];
    if (limits.memoryMax) args.push(`--property=MemoryMax=${limits.memoryMax}`);
    if (limits.runtimeMaxSec) args.push(`--property=RuntimeMaxSec=${limits.runtimeMaxSec}s`);
    const child = spawn('systemd-run', [...args, ...argv], { stdio: 'ignore' });
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.unref();
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(cwd, 'exit.json')) || show(unit)?.LoadState === 'loaded') return unit;
      if (child.exitCode !== null || spawnError) break;
      await delay(50);
    }
    if (spawnError && show(unit)?.LoadState === 'not-found')
      throw Object.assign(spawnError, { noSideEffects: true });
    throw new Error(`systemd Run ${unit} could not be confirmed`);
  }
  state(ref: string): 'running' | 'exited' | 'not_found' | 'unknown' {
    const runId = this.runId(ref);
    // A unit that is shutting down is still running. One that vanishes between two reads, or reads as stopped while
    // its processes are still leaving, is read again: both happen in the last moments of a normal exit.
    for (let attempt = 0; ; attempt++) {
      const state = this.read(ref);
      if (existsSync(join(this.runRoot, runId, 'exit.json')) && state && !LIVE_STATES.has(state.ActiveState) &&
        cgroupEmpty(state.ControlGroup ?? '')) return 'exited';
      if (state && LIVE_STATES.has(state.ActiveState)) return 'running';
      if (state?.LoadState === 'not-found') return 'not_found';
      if (attempt === STATE_READS - 1) return 'unknown';
      pause(STATE_REREAD_MS);
    }
  }
  neverStarted(runId: string): boolean {
    return !existsSync(join(this.runRoot, runId, 'command.json')) &&
      show(unitName(runId))?.LoadState === 'not-found';
  }
  recordedExit(runId: string): ExitStatus | undefined { return recordedExitIn(this.runRoot, runId); }
  async stop(ref: string): Promise<'confirmed' | 'not_confirmed'> {
    const runId = this.runId(ref);
    const prior = show(ref);
    if (!prior) return 'not_confirmed';
    if (prior.LoadState !== 'not-found') {
      const marker = join(this.runRoot, runId, 'cancel-requested');
      if (!existsSync(marker)) hostPlatform.writePrivate(marker, '', { flag: 'wx' });
      try { execFileSync('busctl', ['--user', 'call', 'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'StopUnit',
        'ss', `${ref}.service`, 'replace'],
      { timeout: this.cancelTimeoutMs, encoding: 'utf8' }); }
      catch { return 'not_confirmed'; }
    }
    const deadline = Date.now() + this.cancelTimeoutMs;
    while (Date.now() <= deadline) {
      const state = show(ref);
      if (state && state.ActiveState !== 'active' && state.ActiveState !== 'activating' &&
        cgroupEmpty(state.ControlGroup ?? '')) {
        const exit = join(this.runRoot, runId, 'exit.json');
        if (!existsSync(exit)) hostPlatform.writePrivate(exit,
          JSON.stringify({ exitStatus: 143, exit: { code: 143, signal: 'SIGTERM', timedOut: false, cancelled: true } }),
          { flag: 'wx' });
        return 'confirmed';
      }
      await delay(100);
    }
    return 'not_confirmed';
  }
}
/** Linux supervises Runs with systemd; Windows with Job Objects (see windows-supervisor.ts). */
export function createRunSupervisor(runRoot: string, cancelTimeoutMs?: number): RunSupervisor & {
  refFor(runId: string): string; runId(ref: string): string; loaded(ref: string): boolean } {
  return process.platform === 'win32' ? new WindowsRunSupervisor(runRoot, cancelTimeoutMs)
    : new LinuxRunSupervisor(runRoot, cancelTimeoutMs);
}
