import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { UnityConfig } from '../config.ts';
import { defaultUnitySlots } from '../config.ts';
import { hostPlatform } from '../host-platform.ts';
import { LinuxWriteBoundary, type WritePolicy } from './write-boundary.ts';
import { unityBwrapArgs, unityPlan, type UnityPlan, type UnityStep } from './unity-steps.ts';
import { releaseUnityBatchSlot, tryTakeUnityBatchSlot, type UnityBatchSlot } from './unity-batch-lock.ts';
import { WindowsUnityLauncher, type UnityProjectOccupancy } from './windows-unity.ts';

export interface UnityLauncher {
  installation(): { editorPath: string; version: string; licenseReady: 'unknown' };
  plan(step: UnityStep, project: string, runDir: string, index?: number, isolatedHome?: string): UnityPlan;
  busy(project: string): boolean;
  acquireBatchSlot(): boolean;
  release(): void;
  launch(plan: UnityPlan, timeoutMs: number): Promise<{ code: number; timedOut: boolean; busy?: UnityProjectOccupancy }>;
}

/** The Unity executable a configuration starts, whichever way it names it; throws when none can be determined. */
export function configuredUnityEditor(config: UnityConfig): string { return createUnityLauncher(config).installation().editorPath; }

/** Linux starts Unity in bwrap; Windows through the helper at Low integrity (windows-unity.ts). */
export function createUnityLauncher(config: UnityConfig): UnityLauncher & { lastIsolation?: { kind: 'lowil' | 'none'; note?: string } } {
  return process.platform === 'win32' ? new WindowsUnityLauncher(config) : new LinuxUnityLauncher(config);
}

/** Linux only. The old script remains for legacy callers, while Harness launches Unity itself. */
export class LinuxUnityLauncher implements UnityLauncher {
  private readonly config: UnityConfig;
  private lock: UnityBatchSlot | undefined;
  constructor(config: UnityConfig) { this.config = config; }
  private legacyRunner(): boolean { return basename(this.config.runner) === 'unity_run.sh'; }
  installation(): { editorPath: string; version: string; licenseReady: 'unknown' } {
    let editorPath = this.config.editor ?? this.config.runner;
    if (!this.config.editor && this.legacyRunner()) {
      editorPath = process.env.UNITY_BIN ?? '';
      if (!editorPath) {
        // The configured legacy script supplies a site-local default Unity path. Read only its assignment;
        // never execute it, and keep that local path out of the public repository.
        const source = readFileSync(this.config.runner, 'utf8');
        editorPath = /^U=\$\{UNITY_BIN:-([^}]+)\}$/m.exec(source)?.[1] ?? '';
      }
      if (!editorPath || !isAbsolute(editorPath)) throw new Error('Unity binary is not configured');
    }
    const version = /\b\d{4}\.\d+\.\d+[abcfp]\d+\b/.exec(editorPath)?.[0] ?? 'unknown';
    return { editorPath, version, licenseReady: 'unknown' };
  }
  plan(step: UnityStep, project: string, runDir: string, index = 1,
    isolatedHome = join(runDir, 'unity-home')): UnityPlan {
    const base = unityPlan(this.config, step, project, runDir, index, isolatedHome);
    const editor = this.installation().editorPath;
    // The sandbox mounts the Run's private temp at /tmp. Point TMPDIR there rather than at its host path: Unity
    // creates IPC sockets under TMPDIR, and a Run directory under a long home path pushes them past the 108-byte
    // sun_path limit (the compile pipeline then fails with "invalid length for use with domain sockets").
    const env = { ...base.env, TMPDIR: '/tmp', PATH: base.env.PATH ?? process.env.PATH,
      LC_ALL: step.env.LC_ALL ?? 'C', DISPLAY: base.env.DISPLAY || ':10.0',
      AVATARAUDIT_SUPPRESS_DIALOGS: base.env.AVATARAUDIT_SUPPRESS_DIALOGS ?? '1' };
    return { ...base, env, lockPath: this.config.lockPath,
      isolation: { home: isolatedHome, privateTemp: base.privateTmp,
        writableRoots: [project, runDir], writableFiles: [this.config.lockPath] },
      argv: [editor, '-projectPath', project, '-force-vulkan', '-batchmode',
        ...(step.quit ? ['-quit'] : []), '-logFile', base.log, '-executeMethod', step.method] };
  }
  busy(project: string): boolean {
    const target = realpathSync(project), name = basename(target);
    let pids: number[];
    try { pids = hostPlatform.findProcesses('Editor/Unity'); }
    catch { return true; }
    for (const pid of pids) {
      if (!existsSync(`/proc/${pid}`)) continue;
      let argv: string[];
      try { argv = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean); }
      catch { return true; }
      for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i]?.toLowerCase() !== '-projectpath') continue;
        let value = argv[i + 1]!.replace(/\/$/, '');
        if (!isAbsolute(value)) {
          try { value = resolve(readlinkSync(`/proc/${pid}/cwd`), value); }
          catch { return true; }
        }
        if (resolve(value) === target || basename(value) === name) return true;
      }
    }
    return false;
  }
  acquireBatchSlot(): boolean {
    if (this.lock) return true;
    // One slot on Linux by default, so this is the same single flock the legacy contract used; AVH_UNITY_SLOTS can
    // raise it, and the counting code is shared with Windows.
    this.lock = tryTakeUnityBatchSlot(this.config.lockPath, defaultUnitySlots());
    return this.lock !== undefined;
  }
  release(): void {
    releaseUnityBatchSlot(this.lock);
    this.lock = undefined;
  }
  private availableGiB(): number {
    const kb = /^MemAvailable:\s*(\d+) kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1];
    if (!kb) throw new Error('Cannot inspect available memory');
    return Math.floor(Number(kb) / (1024 * 1024));
  }
  async launch(plan: UnityPlan, timeoutMs: number): Promise<{ code: number; timedOut: boolean }> {
    const project = plan.env.AVH_PROJECT_DIR!, runDir = plan.env.AVH_RUN_DIR!;
    try { accessSync(plan.argv[0]!, constants.X_OK); }
    catch { return { code: 2, timedOut: false }; }
    if (this.legacyRunner() && !existsSync(join(project, 'Packages/manifest.json')))
      return { code: 2, timedOut: false };
    if (this.availableGiB() < 6) return { code: 3, timedOut: false };
    if (this.busy(project)) return { code: 4, timedOut: false };
    if (!this.acquireBatchSlot()) return { code: 5, timedOut: false };
    try {
      if (!this.busy(project)) rmSync(join(project, 'Temp/UnityLockfile'), { force: true });
      const policy: WritePolicy = { project, repository: project, runDirectory: runDir,
        writableRoots: plan.writable, writableFiles: [this.config.lockPath],
        readonlyWithinWritable: 'git-metadata',
        // The private /tmp and session sockets require Linux mount semantics; Codex cannot express them.
        maskedDirs: [{ path: '/tmp', readonlyRebinds: [], writableFiles: [] }],
        privateTemp: true, network: false, minStrength: 'prevent', owner: 'outer', allowedWrites: plan.writable };
      const boundary = new LinuxWriteBoundary().probe(policy);
      if (boundary.kind !== 'bwrap') throw new Error('Unity requires a working bwrap sandbox');
      return await new Promise(resolveDone => {
        const child = spawn('bwrap', unityBwrapArgs(plan), { env: plan.env, cwd: runDir,
          detached: true, stdio: 'ignore' });
        let timedOut = false, closedCode = 124, settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const done = (code: number): void => {
          if (settled) return;
          settled = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
          resolveDone({ code, timedOut });
        };
        const timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ }
          killTimer = setTimeout(() => {
            if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
            done(closedCode);
          }, 5000);
        }, timeoutMs);
        child.once('error', () => done(127));
        child.once('close', code => { closedCode = code ?? 1; if (!timedOut) done(closedCode); });
      });
    } finally { this.release(); }
  }
}
