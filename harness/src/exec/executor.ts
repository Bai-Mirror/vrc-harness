import { existsSync, readFileSync, lstatSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Executor, Observation, RunHandle, RunResult, RunSpec } from '../runtime/interfaces.ts';
import type { ScanLimits, StatusSnapshot } from './git-scan.ts';
import { HandoffLock } from './handoff.ts';
import type { SandboxKind, SandboxStatus } from './sandbox.ts';
import { createWriteBoundary, type MaskedDir, type WritePolicy } from './write-boundary.ts';
import { createRunSupervisor, UNIT_STOP_TIMEOUT_SEC } from './run-supervisor.ts';
import { hostPlatform } from '../host-platform.ts';
import { avhHome } from '../config.ts';
import { checkSecretEnv } from '../providers/secrets.ts';

/** Kept for existing callers; executable resolution belongs to HostPlatform. */
export const resolveExecutable = (name: string): string => hostPlatform.resolveExecutable(name);

export interface CommandSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Environment variables set from Provider credentials (name → secret id, see providers/secrets.ts). command.json
   * keeps the ids only; the unit wrapper reads the values when it starts the command.
   */
  secretEnv?: Record<string, string>;
  stdinFile?: string;
  timeoutMs?: number;
  requireStableHead?: boolean;
  runner: string;
  needsUnity?: boolean;
  maskedDirs?: MaskedDir[];
}
export interface UnitExecutorConfig {
  projectDirectory: string;
  workspaceRepository: string;
  runRoot: string;
  writableByRunner: Record<string, string[]>;
  networkByRunner?: Record<string, boolean>;
  sandboxByRunner?: Record<string, 'outer' | 'self' | 'inner-bwrap'>;
  requireSandboxByRunner?: Record<string, boolean>;
  /** Runners whose write boundary should be the Runtime's own bwrap when it is available (deterministic tools). */
  preferBwrapByRunner?: Record<string, boolean>;
  maskedDirsByRunner?: Record<string, MaskedDir[]>;
  commandFor: (spec: RunSpec, runDirectory: string) => CommandSpec;
  handoffLockPath?: string;
  unityResources?: string[];
  memoryMax?: string;
  runtimeMaxSec?: number;
  cancelTimeoutMs?: number;
  codexSandboxExecutable?: string;
  codexSandboxProfile?: string;
  scanLimits?: ScanLimits;
  /** The Runtime's home: bwrap Runs mask its control socket, config and state. Defaults to AVH_HOME. */
  harnessHome?: string;
}

interface StoredCommand extends CommandSpec {
  runDirectory: string;
  sandbox: SandboxKind;
  sandboxExecutable?: string;
  sandboxProfile?: string;
  projectDirectory: string;
  writable: string[];
  readonlyGitPaths: string[];
  network: boolean;
  writeBoundary?: { kind: SandboxKind; strength: 'prevent' | 'detect' };
  harnessHome: string;
}

export { UNIT_STOP_TIMEOUT_SEC, DEFAULT_CANCEL_TIMEOUT_MS, unitProcessCount } from './run-supervisor.ts';
export function unitNeverStarted(runRoot: string, runId: string): boolean {
  return createRunSupervisor(runRoot).neverStarted(runId);
}
export function recordedExitStatus(runRoot: string, runId: string): number | undefined {
  return createRunSupervisor(runRoot).recordedExit(runId)?.code;
}

export class UnitExecutor implements Executor {
  readonly config: UnitExecutorConfig;
  private readonly root: string;
  private readonly project: string;
  private readonly repo: string;
  private readonly handoff?: HandoffLock;
  private readonly sandbox = new Map<string, SandboxStatus & { kind: SandboxKind }>();
  private readonly boundary = createWriteBoundary();
  private readonly supervisor: ReturnType<typeof createRunSupervisor>;
  constructor(config: UnitExecutorConfig) {
    if (config.cancelTimeoutMs !== undefined && config.cancelTimeoutMs <= UNIT_STOP_TIMEOUT_SEC * 1000)
      throw new Error('cancelTimeoutMs must exceed TimeoutStopSec');
    this.config = config;
    this.root = resolve(config.runRoot);
    this.project = resolve(config.projectDirectory);
    this.repo = resolve(config.workspaceRepository);
    this.supervisor = createRunSupervisor(this.root, config.cancelTimeoutMs);
    if (config.handoffLockPath) this.handoff = new HandoffLock(config.handoffLockPath);
  }
  canDispatch(resource: string): boolean {
    return !this.handoff || !(this.config.unityResources ?? ['slot:unity_batch']).some(prefix =>
      resource === prefix || resource.startsWith(`${prefix}:`)) || this.handoff.freeForDispatch();
  }
  private policy(runDirectory: string, runner: string, allowedWrites?: string[],
    command?: CommandSpec): WritePolicy {
    const roots = this.config.writableByRunner[runner];
    if (!roots) throw new Error(`No write whitelist for runner ${runner}`);
    return { project: this.project, repository: this.repo, runDirectory,
      writableRoots: roots, writableFiles: [], readonlyWithinWritable: 'git-metadata',
      maskedDirs: command?.maskedDirs ?? this.config.maskedDirsByRunner?.[runner] ?? [],
      privateTemp: true, network: this.config.networkByRunner?.[runner] ?? false,
      minStrength: this.config.requireSandboxByRunner?.[runner] || command?.maskedDirs?.length ? 'prevent' : 'detect',
      owner: this.config.sandboxByRunner?.[runner] ?? 'outer', allowedWrites,
      sandboxExecutable: this.config.codexSandboxExecutable,
      sandboxProfile: this.config.codexSandboxProfile,
      requireStableHead: command?.requireStableHead, scanLimits: this.config.scanLimits,
      harnessHome: resolve(this.config.harnessHome ?? avhHome()),
      ...(this.config.preferBwrapByRunner?.[runner] ? { prefer: 'bwrap' as const } : {}) };
  }
  doctor(): Record<string, SandboxStatus & { kind: SandboxKind }> {
    hostPlatform.mkdirPrivate(this.root);
    for (const runner of Object.keys(this.config.writableByRunner)) {
      if (this.sandbox.has(runner)) continue;
      try {
        const status = this.boundary.probe(this.policy(this.root, runner));
        this.sandbox.set(runner, { kind: status.kind, available: status.strength === 'prevent', reason: status.reason });
      } catch (error) {
        this.sandbox.set(runner, { kind: 'scan', available: false, reason: String(error) });
      }
    }
    return Object.fromEntries(this.sandbox);
  }
  private directory(runId: string): string { return join(this.root, runId); }
  runIdOf(handle: RunHandle): string { return this.supervisor.runId(handle.ref); }
  refFor(runId: string): RunHandle { return { ref: this.supervisor.refFor(runId) }; }
  private record(runId: string): StoredCommand {
    return JSON.parse(readFileSync(join(this.directory(runId), 'command.json'), 'utf8')) as StoredCommand;
  }
  async start(spec: RunSpec): Promise<RunHandle> {
    let launchAttempted = false;
    let unityAcquired = false;
    let ref: string;
    try { ref = this.supervisor.refFor(spec.runId); }
    catch (error) {
      throw Object.assign(new Error((error as Error).message, { cause: error }),
        { errorClass: 'tool_failure' as const, noSideEffects: true });
    }
    const directory = this.directory(spec.runId);
    const marker = join(directory, 'command.json');
    try {
      hostPlatform.mkdirPrivate(directory);
      const directoryStat = lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
        throw new Error('Run directory must be a real directory');
      if (existsSync(marker) || existsSync(join(directory, 'exit.json')) || this.supervisor.loaded(ref))
        return { ref };
      const command = this.config.commandFor(spec, directory);
      if (!command.argv.length || !command.runner) throw new Error('Command and runner required');
      const harnessHome = resolve(this.config.harnessHome ?? avhHome());
      // A missing credential is known now: the Run never starts rather than failing inside its unit.
      checkSecretEnv(harnessHome, command.secretEnv);
      const policy = this.policy(directory, command.runner, spec.allowedWrites, command);
      const probe = this.boundary.probe(policy);
      this.sandbox.set(command.runner, { kind: probe.kind, available: probe.strength === 'prevent', reason: probe.reason });
      const prepared = this.boundary.prepare(policy, probe);
      if (command.needsUnity) {
        if (!this.handoff) throw new Error('Unity handoff lock path required');
        this.handoff.acquire(spec.runId);
        unityAcquired = true;
      }
      const stored: StoredCommand = { ...command, cwd: command.cwd ?? directory,
        env: { ...command.env, AVH_RUN_DIR: directory, AVH_PROJECT_DIR: this.project }, runDirectory: directory,
        ...this.boundary.spawnOptions(policy, probe, prepared), projectDirectory: this.project, harnessHome };
      hostPlatform.writePrivate(join(directory, 'outside-before.json'), JSON.stringify(prepared.baseline), { flag: 'wx' });
      hostPlatform.writePrivate(join(directory, 'head-before.txt'), prepared.head, { flag: 'wx' });
      hostPlatform.writePrivate(marker, JSON.stringify(stored), { flag: 'wx' });
      const wrapper = fileURLToPath(new URL('./unit-wrapper.mjs', import.meta.url));
      launchAttempted = true;
      return { ref: await this.supervisor.launch(spec.runId, [process.execPath, wrapper, marker],
        { PATH: process.env.PATH ?? '' }, directory,
        { memoryMax: this.config.memoryMax, runtimeMaxSec: this.config.runtimeMaxSec }) };
    } catch (error) {
      if (!launchAttempted || (error as Error & { noSideEffects?: boolean }).noSideEffects) {
        if (existsSync(marker)) unlinkSync(marker);
        if (unityAcquired) this.handoff?.release(spec.runId);
        this.releaseHost(directory, spec.runId);
        throw Object.assign(new Error((error as Error).message, { cause: error }),
          { errorClass: 'tool_failure' as const, noSideEffects: true });
      }
      throw error;
    }
  }
  observe(handle: RunHandle): Observation {
    const state = this.supervisor.state(handle.ref);
    return { state: state === 'not_found' ? 'unknown' : state };
  }
  collect(handle: RunHandle): RunResult {
    const runId = this.runIdOf(handle);
    const directory = this.directory(runId);
    const result = JSON.parse(readFileSync(join(directory, 'exit.json'), 'utf8')) as RunResult;
    const command = this.record(runId);
    const prepared = { baseline: JSON.parse(readFileSync(join(directory, 'outside-before.json'), 'utf8')) as StatusSnapshot,
      head: readFileSync(join(directory, 'head-before.txt'), 'utf8'), writable: command.writable,
      readonly: command.readonlyGitPaths };
    const verified = this.boundary.verify(this.policy(directory,
      command.runner ?? Object.keys(this.config.writableByRunner)[0]!, undefined, command),
      { kind: command.sandbox, strength: command.sandbox === 'scan' ? 'detect' : 'prevent' }, prepared);
    result.scanEvidence = verified.scanEvidence;
    result.externalChanges = verified.externalChanges;
    result.outOfBoundsPaths = verified.outOfBoundsPaths;
    result.outputs = {};
    if (command.needsUnity) this.handoff?.release(runId);
    this.releaseHost(directory, runId, command.runner);
    return result;
  }
  /** Host state a boundary set up for this Run (Windows integrity labels) goes once the Run has stopped. */
  private releaseHost(directory: string, runId: string, runner?: string): void {
    if (!this.boundary.release) return;
    const name = runner ?? Object.keys(this.config.writableByRunner)[0];
    if (!name || !this.config.writableByRunner[name]) return;
    try { this.boundary.release(this.policy(directory, name)); }
    catch (error) { throw new Error(`Run ${runId} 的写边界没能撤销：${(error as Error).message}`, { cause: error }); }
  }
  async cancel(handle: RunHandle): Promise<'confirmed' | 'not_confirmed'> {
    const runId = this.runIdOf(handle);
    if (!existsSync(join(this.directory(runId), 'command.json'))) {
      return this.supervisor.state(handle.ref) === 'not_found' ? 'confirmed' : 'not_confirmed';
    }
    const stopped = await this.supervisor.stop(handle.ref);
    if (stopped === 'confirmed' && this.record(runId).needsUnity) this.handoff?.release(runId);
    if (stopped === 'confirmed') this.releaseHost(this.directory(runId), runId, this.record(runId).runner);
    return stopped;
  }
  /** Only a proven absent unit can confirm a Run which never wrote command.json. */
  confirmNeverStarted(runId: string): boolean {
    return this.supervisor.neverStarted(runId);
  }
  recordedExitStatus(runId: string): number | undefined { return this.supervisor.recordedExit(runId)?.code; }
}
export function createRunExecutor(config: UnitExecutorConfig): UnitExecutor { return new UnitExecutor(config); }
