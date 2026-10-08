import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, openSync, rmSync } from 'node:fs';
import { freemem, homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { UnityConfig } from '../config.ts';
import { avhHome, defaultUnitySlots } from '../config.ts';
import { hostPlatform, processAlive } from '../host-platform.ts';
import { gitMetadataPaths } from './sandbox.ts';
import { UNITY_BATCH_EXCLUSIVE_OPEN, releaseUnityBatchSlot, tryTakeUnityBatchSlot, waitUnityBatchSlot, type UnityBatchSlot } from './unity-batch-lock.ts';
import type { UnityLauncher } from './unity-launcher.ts';
import type { UnityPlan, UnityStep } from './unity-steps.ts';
import { assertLabelable, probeLowIntegrity, protectHarnessHomeOnce } from './windows-boundary.ts';
import { labelWithLedger, listProcesses, releaseLedgers, windowsHelper, type WindowsProcess } from './windows-helper.ts';
import { createWindowsUnityProjectAlias, sameWindowsUnityProject } from './windows-unity-alias.ts';
import type { WindowsUnityProjectAlias } from './windows-unity-alias.ts';

/** libuv's UV_FS_O_EXLOCK: open with no sharing, so no other process can open the file while we hold it. */
export const EXCLUSIVE_OPEN = UNITY_BATCH_EXCLUSIVE_OPEN;

/** What Unity and its licensing client need from the Windows environment; the profile folders are replaced. */
export const WINDOWS_UNITY_ENV = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432',
  'ALLUSERSPROFILE', 'PUBLIC', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'PATH', 'LANG', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY',
  'NO_PROXY'];

/**
 * Unity's own license files, copied into the isolated profile of each Unity step: the Hub's entitlement license lives
 * in %LOCALAPPDATA%\Unity\licenses, which Unity and its licensing client look up through the (redirected) environment.
 */
export function defaultWindowsHomeSeeds(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const licenses = join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Unity', 'licenses');
  const rel = relative(home, licenses);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? [rel.split('\\').join('/')] : [];
}

/** The -projectPath value in a Unity command line, as Windows splits arguments (quotes group, backslashes are literal). */
export function projectPathArgument(commandLine: string): string | undefined {
  const args: string[] = [];
  let current = '', quoted = false, started = false;
  for (const char of commandLine) {
    if (char === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && (char === ' ' || char === '\t')) { if (started) { args.push(current); current = ''; started = false; } continue; }
    current += char; started = true;
  }
  if (started) args.push(current);
  const at = args.findIndex(arg => arg.toLowerCase() === '-projectpath');
  return at >= 0 ? args[at + 1] : undefined;
}

/** The host facts a launch reads — the process table, a liveness probe and available memory. Injectable, so a test can
 *  reproduce a project a process the kernel has not released still holds, whatever this computer's memory is doing. */
export interface WindowsUnityProbes {
  list(name?: string): WindowsProcess[];
  alive(pid: number): boolean;
  freeMemory(): number;
}
const HOST_PROBES: WindowsUnityProbes = { list: listProcesses, alive: processAlive, freeMemory: freemem };

/** A process whose command line names a project: it either still runs, or the kernel has ended it and holds it still. */
export interface WindowsUnityOccupier { pid: number; commandLine: string; exited: boolean }

/**
 * What a project's `Temp/UnityLockfile` means right now.
 *
 * `editor` is a live editor: it will release the lock when it exits, so waiting for it means something. `exiting` is
 * the residue of a process the operating system has already ended — it no longer runs, but the kernel has not reclaimed
 * its process object or its open handles, so it still holds the project lock and shows in the process table. Nothing at
 * process level can reclaim that; only the kernel (in practice: a restart) can. `locked` is a held lock that no Unity
 * process names. Only `free` lets a Unity step start.
 *
 * Measured on this host (2026-10-04, Unity 2022.3.22f1), on the editor a cancelled Run left behind: the helper's own
 * `procs` lists it with its full command line and the process's project path, while `process.kill(pid, 0)`, `taskkill`
 * and .NET's `GetProcessById` all report no such process, and its one remaining thread waits on the executive. A live
 * editor of the same version (102 threads) answers the liveness probe as alive, so that probe is what separates them.
 */
export type UnityProjectOccupancy =
  | { kind: 'free' }
  | { kind: 'editor'; occupiers: WindowsUnityOccupier[] }
  | { kind: 'exiting'; occupiers: WindowsUnityOccupier[] }
  | { kind: 'locked' };

/**
 * The project's occupancy, read the way `busy()` needs it. The lock file is tried first because opening it exclusively
 * is what an editor does; the process table then says who holds it. An editor whose project path cannot be resolved
 * counts as live: an unreadable running editor path cannot establish that this project is free.
 */
export function windowsUnityOccupancy(project: string, probes: WindowsUnityProbes = HOST_PROBES): UnityProjectOccupancy {
  let lockHeld = false;
  const lockfile = join(project, 'Temp', 'UnityLockfile');
  if (existsSync(lockfile)) {
    try { closeSync(openSync(lockfile, constants.O_RDWR | EXCLUSIVE_OPEN)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') lockHeld = true; }
  }
  let editors: WindowsProcess[];
  try { editors = probes.list('Unity.exe'); }
  catch { return { kind: 'locked' }; } // A process table that cannot be read never reports a project as free.
  const occupiers: WindowsUnityOccupier[] = [];
  for (const editor of editors) {
    if (editor.commandLine === null) continue;
    const value = projectPathArgument(editor.commandLine);
    if (value === undefined) continue;
    let mine: boolean, established: boolean;
    try { mine = sameWindowsUnityProject(project, value); established = true; }
    catch { mine = true; established = false; }
    if (mine) occupiers.push({ pid: editor.pid, commandLine: editor.commandLine, exited: established && !probes.alive(editor.pid) });
  }
  if (occupiers.some(occupier => !occupier.exited)) return { kind: 'editor', occupiers };
  if (occupiers.length) return { kind: 'exiting', occupiers };
  return lockHeld ? { kind: 'locked' } : { kind: 'free' };
}

/** The instruction for the person, in the interface's own words; carried to the agent and the interface with a failure. */
export function unityOccupancyGuidance(occupancy: UnityProjectOccupancy): string | undefined {
  const pids = (list: WindowsUnityOccupier[]): string => list.map(occupier => occupier.pid).join(', ');
  if (occupancy.kind === 'exiting')
    return `有一个 Unity 进程卡在退出中（PID ${pids(occupancy.occupiers)}）：操作系统已经让它退出，但内核还没有回收它，`
      + '它仍占着工程锁（Temp/UnityLockfile）。这不是方案或工程的问题；请重启电脑后重试这一步——重启之前，这个工程无法启动任何 Unity 步骤。';
  if (occupancy.kind === 'editor')
    return `工程正被 Unity 编辑器打开（PID ${pids(occupancy.occupiers)}）；等待它退出，或先关闭它，再重试这一步。`;
  if (occupancy.kind === 'locked')
    return '工程锁 Temp/UnityLockfile 被占用，但没有 Unity 进程认领它（可能是另一个账户的编辑器，或其它程序）；请关闭占用者后重试。';
  return undefined;
}

/** The one-line machine account of the same reading, for the step's evidence list. */
export function unityOccupancyNote(occupancy: UnityProjectOccupancy): string | undefined {
  if (occupancy.kind === 'exiting')
    return `Unity 进程 ${occupancy.occupiers.map(occupier => occupier.pid).join(', ')} 已退出，但内核仍未回收它，工程锁被它占着`;
  if (occupancy.kind === 'editor')
    return `Unity 编辑器 ${occupancy.occupiers.map(occupier => occupier.pid).join(', ')} 正在运行并打开本工程`;
  if (occupancy.kind === 'locked') return '工程锁被占用，但没有 Unity 进程认领它';
  return undefined;
}

/**
 * Wait, bounded, for the editors that name these projects to stop running, and say what was left.
 *
 * Terminating a Windows job is a request: the job reads as empty as soon as its processes are marked terminated, which
 * is before the kernel has released them, and the project lock they still hold outlives that window. So cancellation
 * waits here instead of taking the empty job for an exited editor. A process the kernel has already ended is not
 * waited for — it cannot run code again, and only a restart reclaims it — but it is returned, so the caller can report
 * the reboot diagnosis rather than a silent "project busy".
 */
export async function settleWindowsUnityEditors(projects: readonly string[], timeoutMs: number,
  probes: WindowsUnityProbes = HOST_PROBES, sleep: (ms: number) => Promise<unknown> = delay,
  pollMs = 250): Promise<{ settled: boolean; occupancy: UnityProjectOccupancy }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let residue: UnityProjectOccupancy = { kind: 'free' };
    for (const project of projects) {
      const occupancy = windowsUnityOccupancy(project, probes);
      if (occupancy.kind === 'exiting') residue = occupancy;
      if (occupancy.kind === 'editor') { residue = occupancy; break; }
    }
    if (residue.kind !== 'editor') return { settled: true, occupancy: residue };
    const left = deadline - Date.now();
    if (left <= 0) return { settled: false, occupancy: residue };
    await sleep(Math.min(pollMs, left));
  }
}

/** What a blocking launch returns: the same outcome `launch` reports, plus the editor's own captured output. */
export interface WindowsUnitySyncResult { code: number; timedOut: boolean; stdout: string; stderr: string }
/** What one confined launch owns between starting and finishing: the helper arguments, the environment and the cleanup. */
interface PreparedWindowsLaunch { argv: string[]; env: NodeJS.ProcessEnv; runDir: string; project: string; home: string;
  owner: string; low: boolean; alias: WindowsUnityProjectAlias }

/**
 * Windows counterpart of LinuxUnityLauncher. Unity.exe starts directly (default D3D11, no -force-vulkan) through the
 * helper at Low integrity, so it writes only the project and its Run directory; its profile folders point into the Run
 * with the license seeded (see defaultWindowsHomeSeeds). The machine-wide batch slot is a file held open exclusively.
 * If the Low boundary cannot be set up (a volume without ACLs, say), Unity still runs in its job and the step records
 * that it ran unisolated, as decided for Windows (D2): Git scanning after the step then reports what it changed.
 */
export class WindowsUnityLauncher implements UnityLauncher {
  private readonly config: UnityConfig;
  private readonly probes: WindowsUnityProbes;
  private lock: UnityBatchSlot | undefined;
  /** How the last launch was confined, for the step's evidence. */
  lastIsolation: { kind: 'lowil' | 'none'; note?: string } | undefined;
  /** `probes` reads a project's occupancy; tests replace it to reproduce a process the kernel has not released. */
  constructor(config: UnityConfig, probes: WindowsUnityProbes = HOST_PROBES) {
    this.config = config; this.probes = probes;
  }
  installation(): { editorPath: string; version: string; licenseReady: 'unknown' } {
    const editorPath = this.config.editor ?? this.config.runner;
    if (!editorPath || !isAbsolute(editorPath)) throw new Error('Unity binary is not configured');
    return { editorPath, version: /\b\d{4}\.\d+\.\d+[abcfp]\d+\b/.exec(editorPath)?.[0] ?? 'unknown', licenseReady: 'unknown' };
  }
  plan(step: UnityStep, project: string, runDir: string, index = 1, isolatedHome = join(runDir, 'unity-home')): UnityPlan {
    const log = join(runDir, `unity-${index}.log`), privateTmp = join(runDir, 'tmp');
    const env = this.environment(isolatedHome, privateTmp, Object.assign({
      USERPROFILE: isolatedHome, HOME: isolatedHome, APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(isolatedHome, 'AppData', 'Local'), TEMP: privateTmp, TMP: privateTmp, TMPDIR: privateTmp,
      AVATARAUDIT_SUPPRESS_DIALOGS: '1' }, step.env, { AVH_RUN_DIR: runDir, AVH_PROJECT_DIR: project }));
    const editor = this.installation().editorPath;
    return { argv: [editor, '-projectPath', project, '-batchmode', ...(step.quit ? ['-quit'] : []), '-logFile', log,
      '-executeMethod', step.method], env, writable: [project, runDir], privateTmp, log, lockPath: this.config.lockPath,
    isolation: { home: isolatedHome, privateTemp: privateTmp, writableRoots: [project, runDir], writableFiles: [] } };
  }
  /**
   * The same environment, isolated profile and writable roots as `plan()`, for a caller that brings its own editor
   * arguments rather than a UnityStep. Development fixtures start real editors this way, so those editors take the
   * Runtime's path — the machine-level slot, the Low-integrity helper, an own profile with the account's Hub licence
   * seeded — instead of a plain Medium-integrity start. That is not tidiness: an editor started at Medium makes this
   * account's licensing client a Medium one, and a Medium client refuses Harness's Low-integrity editors on its channel
   * (`Connection Refused; code: 0x8000000a`, then Unity's own 60s timeout and exit code 199), so such a start can fail
   * an in-flight Run rather than only itself.
   *
   * The profile is applied *after* the caller's environment, so passing `process.env` cannot put the editor back on the
   * person's real profile; `writable` extends the labelled roots for a caller that keeps a result beside its project.
   */
  planArgs(args: readonly string[], project: string, runDir: string,
    options: { env?: NodeJS.ProcessEnv; home?: string; writable?: readonly string[] } = {}): UnityPlan {
    const isolatedHome = options.home ?? join(runDir, 'unity-home'), privateTmp = join(runDir, 'tmp');
    const writable = [...new Set([project, runDir, ...(options.writable ?? [])])];
    const env = this.environment(isolatedHome, privateTmp, {
      ...options.env, USERPROFILE: isolatedHome, HOME: isolatedHome, APPDATA: join(isolatedHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(isolatedHome, 'AppData', 'Local'), TEMP: privateTmp, TMP: privateTmp, TMPDIR: privateTmp,
      AVATARAUDIT_SUPPRESS_DIALOGS: '1', AVH_RUN_DIR: runDir, AVH_PROJECT_DIR: project });
    return { argv: [...args], env, writable, privateTmp, log: join(runDir, 'unity-fixture.log'), lockPath: this.config.lockPath,
      isolation: { home: isolatedHome, privateTemp: privateTmp, writableRoots: writable, writableFiles: [] } };
  }
  /** The pass-through host variables, with the isolated profile applied last so no caller can nominate the real one. */
  private environment(isolatedHome: string, privateTmp: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const wanted = new Set([...WINDOWS_UNITY_ENV, ...this.config.passEnv].map(name => name.toLowerCase()));
    for (const [name, value] of Object.entries(process.env)) if (wanted.has(name.toLowerCase()) && value !== undefined) env[name] = value;
    return Object.assign(env, overrides);
  }
  /** An editor has the project open: it holds Temp/UnityLockfile exclusively, and its command line names the project. */
  busy(project: string): boolean { return this.occupancy(project).kind !== 'free'; }
  /** The same reading, keeping the difference between a live editor and a process the kernel has not released. */
  occupancy(project: string): UnityProjectOccupancy { return windowsUnityOccupancy(project, this.probes); }
  acquireBatchSlot(waitMs = 0, onWait?: (waitedMs: number) => void): boolean {
    if (this.lock) return true;
    // A Runtime step reports a busy lock as `busyExitCode` and counts the wait in its own loop. Anything outside that
    // loop (a development fixture, an ad-hoc script) has no loop to count with, so it waits here — bounded, and aloud.
    this.lock = waitMs > 0
      ? waitUnityBatchSlot(this.config.lockPath, { slots: defaultUnitySlots(), waitMs, ...(onWait ? { onWait } : {}) })
      : tryTakeUnityBatchSlot(this.config.lockPath, defaultUnitySlots());
    return this.lock !== undefined;
  }
  release(): void {
    releaseUnityBatchSlot(this.lock);
    this.lock = undefined;
  }
  /**
   * Clear the labels this launch recorded without letting a cleanup failure replace what the launch actually did.
   * Windows refuses to write a Low label and to clear one for the same reasons (a volume that cannot carry a label, a
   * directory whose ACL grants Modify without WRITE_OWNER, a token without SeRelabelPrivilege — see applyLabels), so a
   * launch that could not be labelled very often cannot be unlabelled either. The ledger is left in place for the
   * service's stale-ledger pass to retry, and the failure message is returned for the caller to record.
   */
  private releaseLedgersQuietly(home: string, owner: string): string | undefined {
    try { releaseLedgers(home, owner); return undefined; }
    catch (error) { return (error as Error).message; }
  }
  /** Everything up to starting the process: validation, the slot, the Low labels, and the verified project alias. */
  private prepare(plan: UnityPlan, slotWaitMs = 0, onWait?: (waitedMs: number) => void):
  { code: number; busy?: UnityProjectOccupancy } | PreparedWindowsLaunch {
    const project = plan.env.AVH_PROJECT_DIR!, runDir = plan.env.AVH_RUN_DIR!;
    if (!existsSync(plan.argv[0]!)) return { code: 2 };
    if (this.probes.freeMemory() / 1024 ** 3 < 6) return { code: 3 };
    // The occupancy travels with the refusal: a step that cannot start has to say whether it waits for an editor or
    // for a restart, and the person reads that message (see unityOccupancyGuidance).
    const occupancy = this.occupancy(project);
    if (occupancy.kind !== 'free') return { code: 4, busy: occupancy };
    if (!this.acquireBatchSlot(slotWaitMs, onWait)) return { code: 5 };
    // The worker's own AVH_RUN_DIR is its unit's directory: collecting or cancelling that unit releases these labels too.
    const home = process.env.AVH_HOME || avhHome(), owner = process.env.AVH_RUN_DIR || runDir;
    let alias: WindowsUnityProjectAlias | undefined;
    try {
      if (!this.busy(project)) rmSync(join(project, 'Temp', 'UnityLockfile'), { force: true });
      const writable = plan.writable.filter(existsSync);
      const sandbox = probeLowIntegrity();
      let low = sandbox.available, note = sandbox.reason;
      if (low) {
        try {
          for (const path of writable) assertLabelable(path);
          protectHarnessHomeOnce(home);
          labelWithLedger(home, owner, writable, gitMetadataPaths(writable));
        } catch (error) {
          // D2: a directory that cannot take the Low label still runs Unity in its job, unisolated. Undoing what the
          // failed call recorded must not replace that reason with a second, identical failure — throwing it here is
          // what made this whole fallback unreachable — so the cleanup failure is added to the note (which reaches
          // unity-isolation.txt and the step's evidence) and its ledger is left for the stale-ledger pass to retry.
          low = false;
          note = `无法为可写目录设置 Low 完整性标签（labelWithLedger → applyLabels；可写根：${writable.join('、')}），`
            + `按设计改为未隔离运行：${(error as Error).message}`;
          const cleanup = this.releaseLedgersQuietly(home, owner);
          if (cleanup) note += `；撤销本次标签也失败（账本留给服务启动时清理）：${cleanup}`;
        }
      }
      this.lastIsolation = low ? { kind: 'lowil' } : { kind: 'none', note: note ?? 'Low integrity boundary unavailable' };
      if (!low) hostPlatform.writePrivate(join(runDir, 'unity-isolation.txt'), `未隔离：${this.lastIsolation.note}\n`);
      alias = createWindowsUnityProjectAlias(project);
      alias.verify();
      const argv = [...plan.argv], projectAt = argv.findIndex(arg => arg.toLowerCase() === '-projectpath');
      if (projectAt < 0 || !sameWindowsUnityProject(argv[projectAt + 1]!, project)) throw new Error('Unity 执行工程绑定不一致');
      argv[projectAt + 1] = alias.path;
      // These bindings override configured/pass-through variables; a provider cannot nominate the authority.
      const env = { ...plan.env, AVH_PROJECT_DIR: alias.path, AVH_PHYSICAL_PROJECT_DIR: alias.project, AVH_UNITY_ALIAS_NONCE: alias.nonce };
      hostPlatform.writePrivate(join(runDir, 'unity-project-alias.json'), JSON.stringify({ schema: 'unity-project-alias/0.1',
        project: alias.project, executionPath: alias.path, authorization: 'physical project; no additional writable root' }));
      alias.verify();
      return { argv, env, runDir, project, home, owner, low, alias };
    } catch (error) {
      // A failed launch owns nothing: its labels go back, and its fresh alias is never adopted, so it is unlinked here.
      if (alias) { try { alias.verify(); alias.remove(); } catch { /* keep the evidence the alias itself holds */ } }
      const cleanup = this.releaseLedgersQuietly(home, owner);
      this.release();
      // The failure that stopped the launch is the one that explains it, so a cleanup failure is added to it rather
      // than replacing it — and the slot is released either way (a throwing cleanup used to skip that).
      if (cleanup && error instanceof Error) error.message += `；撤销本次标签失败：${cleanup}`;
      throw error;
    }
  }
  /** Undo one prepared launch: its labels and its slot always, its alias only once no editor holds the project. */
  private finish(prepared: PreparedWindowsLaunch): void {
    const cleanup = this.releaseLedgersQuietly(prepared.home, prepared.owner);
    this.release();
    if (cleanup) {
      // The launch already happened, so a label that could not be undone is recorded rather than turned into a failure
      // of the step (the editor ran); the ledger the cleanup left behind is retried by the stale-ledger pass.
      const note = `撤销本次标签失败（releaseLedgers）：${cleanup}`, previous = this.lastIsolation;
      this.lastIsolation = { kind: previous?.kind ?? 'none', note: previous?.note ? `${previous.note}；${note}` : note };
    }
    prepared.alias.verify();
    const occupancy = this.occupancy(prepared.project);
    // A launch that is cancelled or crashes can leave an editor briefly alive, and its fresh owned alias stays until
    // that editor exits; later launches identify the same physical project and never reuse this entry. A process the
    // kernel has already ended is not an editor that may still hold the project: it can never release anything, so
    // waiting for it would keep this junction, and every later one, for the life of the machine.
    if (occupancy.kind === 'free' || occupancy.kind === 'exiting') prepared.alias.remove();
  }
  async launch(plan: UnityPlan, timeoutMs: number):
  Promise<{ code: number; timedOut: boolean; busy?: UnityProjectOccupancy }> {
    const prepared = this.prepare(plan);
    if ('code' in prepared) return { code: prepared.code, timedOut: false, ...(prepared.busy ? { busy: prepared.busy } : {}) };
    try {
      return await new Promise(resolveDone => {
        const child = spawn(windowsHelper(), ['sandbox', ...(prepared.low ? ['--low'] : []), '--', ...prepared.argv],
          { env: prepared.env, cwd: prepared.runDir, windowsHide: true, stdio: 'ignore' });
        let timedOut = false, settled = false;
        const done = (code: number): void => { if (settled) return; settled = true; clearTimeout(timer); resolveDone({ code, timedOut }); };
        // The helper holds Unity's job; ending it ends Unity and whatever Unity started (its licensing client).
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
        child.once('error', () => done(127));
        child.once('close', code => done(timedOut ? 124 : code ?? 1));
      });
    } finally { this.finish(prepared); }
  }
  /**
   * The blocking form of `launch`, for callers outside the Runtime's event loop: the development fixtures are
   * `execFileSync`-shaped, and the editors they start must take the same slot, Low-integrity helper, isolated profile
   * and cleanup a step takes. It returns the editor's exit code and captured output instead of a promise.
   */
  launchSync(plan: UnityPlan, timeoutMs: number,
    options: { slotWaitMs?: number; onSlotWait?: (waitedMs: number) => void } = {}): WindowsUnitySyncResult {
    const prepared = this.prepare(plan, options.slotWaitMs ?? 0, options.onSlotWait);
    if ('code' in prepared) return { code: prepared.code, timedOut: false, stdout: '', stderr: '' };
    try {
      const result = spawnSync(windowsHelper(), ['sandbox', ...(prepared.low ? ['--low'] : []), '--', ...prepared.argv],
        { env: prepared.env, cwd: prepared.runDir, windowsHide: true, stdio: 'pipe', encoding: 'utf8',
          timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024 });
      const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
      return { code: timedOut ? 124 : result.status ?? 1, timedOut, stdout: result.stdout ?? '',
        stderr: `${result.stderr ?? ''}${!timedOut && result.error ? String(result.error) : ''}` };
    } finally { this.finish(prepared); }
  }
}
