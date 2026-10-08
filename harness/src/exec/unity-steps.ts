import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { avhHome, type UnityConfig } from '../config.ts';
import { bwrapArgs, gitMetadataPaths, hostMasks, maskArgs } from './sandbox.ts';
import { createUnityLauncher } from './unity-launcher.ts';
import { licenceContention, licenceGuidance, systemUnityContentionProbe, type LicenceContention, type UnityCompetitor, type UnityContentionProbe } from './unity-license.ts';
import { defaultWindowsHomeSeeds, unityOccupancyGuidance, unityOccupancyNote, type UnityProjectOccupancy } from './windows-unity.ts';
import { hostPlatform } from '../host-platform.ts';

/** `project` runs the step on a directory inside the task's project (an isolated build copy); only it is writable then. */
export interface UnityStep { method: string; quit: boolean; timeoutSec?: number; env: Record<string, string>; project?: string }
/** The project directory a step opens: the task's project, or a copy inside it. */
export function stepProject(project: string, step: UnityStep): string {
  if (!step.project) return project;
  if (isAbsolute(step.project) || step.project.split('/').some(part => part === '..' || part === ''))
    throw new Error(`unitySteps.project 须为工程内相对路径: ${step.project}`);
  return resolve(project, step.project);
}
export interface UnityEvidence { index: number; method: string; exitCode: number; durationMs: number; log: string;
  errors: string[]; timedOut?: boolean; waits: number; status?: 'not_started'; startupCrashes?: number;
  /** Windows only: `none` when the Low integrity boundary could not be set up and the step ran unisolated. */
  isolation?: 'lowil' | 'none'; isolationNote?: string;
  /** Set when the editor aborted on the account-wide licensing client, whether or not a retry then succeeded. */
  licence?: { exitCode: number; evidence: string[]; competitors: UnityCompetitor[]; retries: number; waitedMs: number };
  /** What the person should do about it: carried to the agent and the interface with the failure. */
  guidance?: string }

/**
 * The editor died of a fatal signal while it was still initializing the project (loading assemblies, running
 * [InitializeOnLoad] code) - before any step method could run. Seen on Linux with VRCFury's Harmony patching:
 * intermittent SIGSEGV that a plain restart does not repeat. Such a crash changed nothing the step owns, so it is retried.
 */
export function crashedDuringStartup(log: string): boolean {
  const at = log.indexOf('Caught fatal signal');
  if (at < 0) return false;
  // Project load (Application::InitializeProject / FinishLoadingProject) runs before -executeMethod; a reload our method
  // triggers later has neither frame and is not retried.
  return /Application::(InitializeProject|FinishLoadingProject)\(/.test(log.slice(at, at + 20000));
}
const STARTUP_CRASH_RETRIES = 2;

/**
 * Licence-client contention: another editor on this machine brought the account-wide Unity licensing client up first, so
 * ours aborted before its code ran. The client is one per account and the mutex is global, and our editor runs at Low
 * integrity inside its own profile — measured: while another editor's client is running, our Low-integrity editor is
 * refused on the channel and its own client loses the mutex, and the retry is refused again a minute and a half later.
 * So the wait is for that client to exit, not for a startup window to close.
 *
 * The refusal is the integrity boundary, and lane U1 isolated it without an editor: opening the licensing client's own
 * pipe (`\\.\pipe\Unity-LicenseClient-<account>`) succeeds at Medium integrity and fails with `Access to the path is
 * denied` at Low, while a pipe a Low process serves accepts both. That is also why the machine-level lock is a count
 * (`unity-batch-lock.ts`): a Low client, which is what a Harness editor starts, can serve several editors at once.
 */
/** How long the step lets the mutex holder clear before it launches again. */
export const LICENCE_CONTENTION_WAIT_MS = 120_000;
/** A short settle after the holder is gone, for the mutex and the pipe to be released. */
export const LICENCE_SETTLE_MS = 5_000;
/** Launches after the first one, at most, for this diagnosis. */
export const LICENCE_CONTENTION_RETRIES = 2;
/** How often a waiting step re-reads the machine's editors and licensing clients. */
const LICENCE_POLL_MS = 5_000;
export interface UnityPlan { argv: string[]; env: NodeJS.ProcessEnv; writable: string[]; privateTmp: string; log: string;
  lockPath?: string; config?: UnityConfig;
  isolation?: { home: string; privateTemp: string; writableRoots: string[]; writableFiles: string[] } }
export type UnityLaunch = (plan: UnityPlan, timeoutMs: number) => Promise<{ code: number; timedOut: boolean;
  isolation?: { kind: 'lowil' | 'none'; note?: string }; busy?: UnityProjectOccupancy }>;

/** Hide the host session bus while restoring only display and audio sockets. */
export function unityRuntimeArgs(env: NodeJS.ProcessEnv): string[] {
  const runtime = env.XDG_RUNTIME_DIR ?? process.env.XDG_RUNTIME_DIR;
  if (!runtime || !isAbsolute(runtime) || !existsSync(runtime)) return [];
  const sockets: string[] = [];
  for (const name of ['pulse/native', 'pipewire-0', env.WAYLAND_DISPLAY].filter((x): x is string => !!x)) {
    const socket = isAbsolute(name) ? name : resolve(runtime, name);
    if ((name !== env.WAYLAND_DISPLAY && !hostPlatform.within(runtime, socket)) ||
      !existsSync(socket) || !lstatSync(socket).isSocket()) continue;
    sockets.push(socket);
  }
  return ['--tmpfs', runtime, ...[...new Set(sockets.filter(socket =>
    hostPlatform.within(runtime, socket)).map(dirname))].filter(path => path !== runtime)
    .flatMap(path => ['--dir', path]), ...sockets.flatMap(path => ['--ro-bind', path, path])];
}

export function unityBwrapArgs(plan: UnityPlan): string[] {
  // The private /tmp goes first: later binds (writable paths that live under /tmp, the X11 socket
  // directory, the runtime-socket tmpfs) must stay visible on top of it instead of being hidden by it.
  // The launcher itself must stay executable even when it lives under a path the sandbox replaces (e.g. /tmp).
  // Host masks come right after /tmp; the runtime directory is handled by unityRuntimeArgs, which keeps display and audio.
  const runner = plan.argv[0] && isAbsolute(plan.argv[0]) && existsSync(plan.argv[0]) ? ['--ro-bind', plan.argv[0], plan.argv[0]] : [];
  const masks = maskArgs(hostMasks(avhHome(), { ...plan.env, ...process.env }, { runtimeDirectory: false }), [plan.argv[0]]);
  return bwrapArgs(plan.writable.filter(existsSync), plan.argv, undefined,
    gitMetadataPaths(plan.writable), ['--bind', plan.privateTmp, '/tmp', ...masks], [...runner,
    ...(existsSync('/tmp/.X11-unix') ? ['--ro-bind', '/tmp/.X11-unix', '/tmp/.X11-unix'] : []),
    ...unityRuntimeArgs(plan.env)]);
}

function within(root: string, name: string): string {
  const path = resolve(root, name), rel = relative(root, path);
  if (!rel || !hostPlatform.within(root, path)) throw new Error('Unity path escapes root');
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = realpathSync(ancestor);
  if (!hostPlatform.within(root, actual)) throw new Error('Unity path escapes root through symlink');
  return path;
}
function privateDirectory(path: string, root: string): void {
  const rel = relative(root, path);
  if (!hostPlatform.within(root, path)) throw new Error('Private directory escapes Run');
  let current = root;
  const ensure = (directory: string): void => {
    if (!existsSync(directory)) hostPlatform.mkdirPrivate(directory);
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private directory is not a real directory');
    chmodSync(directory, 0o700);
  };
  ensure(root);
  for (const part of rel.split(sep).filter(Boolean)) { current = join(current, part); ensure(current); }
}
function seed(from: string, to: string, copied: string[], isolatedHome: string): void {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) throw new Error('Unity HOME seed cannot be a symlink');
  if (stat.isDirectory()) {
    privateDirectory(to, isolatedHome);
    for (const name of readdirSync(from)) seed(join(from, name), join(to, name), copied, isolatedHome);
  } else if (stat.isFile()) {
    privateDirectory(dirname(to), isolatedHome);
    if (existsSync(to)) rmSync(to);
    copyFileSync(from, to); chmodSync(to, 0o600); copied.push(to);
  }
}
function redactLog(log: string, copied: string[], isolatedHome: string): string {
  for (const path of copied) {
    const secret = readFileSync(path, 'utf8');
    if (secret) log = log.replaceAll(secret, '[redacted]');
    log = log.replaceAll(path, '[redacted]');
    log = log.replaceAll(join(homedir(), relative(isolatedHome, path)), '[redacted]');
  }
  return log.replaceAll(isolatedHome, '[isolated HOME]');
}
export function unityPlan(config: UnityConfig, step: UnityStep, project: string, runDir: string,
  index: number, isolatedHome: string): UnityPlan {
  const log = join(runDir, `unity-${index}.log`), privateTmp = join(runDir, 'tmp');
  const writable = [project, runDir, config.lockPath];
  const env: NodeJS.ProcessEnv = { HOME: isolatedHome, XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local/share'), XDG_CACHE_HOME: join(isolatedHome, '.cache'),
    XDG_STATE_HOME: join(isolatedHome, '.local/state'), XDG_CONFIG_DIRS: '/etc/xdg',
    AVH_RUN_DIR: runDir, AVH_PROJECT_DIR: project, TMPDIR: privateTmp };
  const authority = join(homedir(), '.Xauthority');
  if (existsSync(authority)) env.XAUTHORITY = authority;
  for (const name of config.passEnv) if (process.env[name] !== undefined) env[name] = process.env[name];
  Object.assign(env, step.env);
  return { argv: [config.runner, '--project', project, '--batch', '--method', step.method,
    ...(step.quit ? [] : ['--no-quit']), '--no-systemd', '--log', log], env, writable, privateTmp, log };
}

export const sandboxedUnityLaunch: UnityLaunch = async (plan, timeoutMs) => {
  if (!plan.config) throw new Error('Unity launch plan lacks configuration');
  const launcher = createUnityLauncher(plan.config);
  const outcome = await launcher.launch(plan, timeoutMs);
  return launcher.lastIsolation ? { ...outcome, isolation: launcher.lastIsolation } : outcome;
};

/** The licensing client's own log inside the step's isolated profile; it names the mutex the loser could not take. */
function licenceClientLog(runDir: string): string {
  const path = join(runDir, 'unity-home', 'AppData', 'Local', 'Unity', 'Unity.Licensing.Client.log');
  try { return existsSync(path) ? readFileSync(path, 'utf8').slice(-20_000) : ''; } catch { return ''; }
}

/**
 * What the step waits for before it spends another launch: the licensing client that holds the mutex to exit. A running
 * client is what defeats us — our own client cannot take the mutex, and our editor is refused on the channel — so an
 * editor that merely shares a client does not matter, but the client itself does. The wait is a fixed number of polls
 * rather than a clock, so the bound is the same for a real sleep and for an injected one.
 */
async function waitForLicenceMachine(probe: UnityContentionProbe, ownProjects: string[], clearMs: number,
  settleMs: number, sleep: (ms: number) => Promise<unknown>): Promise<{ waitedMs: number; competitors: UnityCompetitor[] }> {
  const polls = Math.max(0, Math.ceil(clearMs / LICENCE_POLL_MS));
  const serving = (list: UnityCompetitor[]): boolean => list.some(item => item.kind === 'licensing-client');
  let competitors = probe.competitors(ownProjects), used = 0;
  while (used < polls && serving(competitors)) {
    await sleep(LICENCE_POLL_MS);
    used++;
    competitors = probe.competitors(ownProjects);
  }
  const settle = Math.max(0, settleMs);
  if (settle > 0) await sleep(settle);
  return { waitedMs: used * LICENCE_POLL_MS + settle, competitors: probe.competitors(ownProjects) };
}

export async function runUnitySteps(config: UnityConfig, steps: UnityStep[], project: string, runDir: string,
  onWait: (index: number, wait: number) => void = () => {},
  launch: UnityLaunch = sandboxedUnityLaunch,
  waitBusy: (ms: number) => Promise<unknown> = delay,
  probe: UnityContentionProbe = systemUnityContentionProbe): Promise<UnityEvidence[]> {
  const isolatedHome = join(runDir, 'unity-home'), copied: string[] = [];
  const launcher = createUnityLauncher(config);
  const windows = process.platform === 'win32';
  // Scratch and lock setup happens in the worker before its child enters bwrap.
  const gitPaths = gitMetadataPaths([project]);
  for (const path of [...config.projectScratch.map(name => resolve(project, name)), config.lockPath]) {
    if (gitPaths.some(git => {
      return hostPlatform.within(git, resolve(path));
    })) throw new Error('Unity setup cannot write inside .git metadata');
  }
  privateDirectory(isolatedHome, runDir);
  // The profile folders Unity writes to: XDG directories on Linux; APPDATA and LOCALAPPDATA inside the profile on Windows.
  for (const sub of windows ? ['AppData', 'AppData/Roaming', 'AppData/Local', 'AppData/Local/Unity']
    : ['.config', '.config/unity3d', '.config/unity3d/Unity', '.config/unity3d/Unity/licenses',
      '.local', '.local/share', '.local/share/unity3d', '.local/state', '.cache']) {
    privateDirectory(join(isolatedHome, sub), isolatedHome);
  }
  const evidence: UnityEvidence[] = [];
  try {
    // Older cross-platform configs contain Linux seeds. They must not suppress the native Hub license on Windows.
    const seeds = [...new Set([...config.homeSeedFrom, ...(windows ? defaultWindowsHomeSeeds() : [])])];
    for (const name of seeds) {
      const from = within(homedir(), name), to = within(isolatedHome, name);
      if (existsSync(from)) seed(from, to, copied, isolatedHome);
    }
    for (const step of steps) for (const name of config.projectScratch) mkdirSync(within(stepProject(project, step), name), { recursive: true });
    privateDirectory(join(runDir, 'tmp'), runDir);
    // The lock's directory is ours to create: the machine-level slot on Windows lives outside AVH_HOME
    // (see defaultUnityLockPath), so nothing on the way in has made it.
    hostPlatform.mkdirPrivate(dirname(config.lockPath));
    if (!existsSync(config.lockPath)) {
      try { hostPlatform.writePrivate(config.lockPath, '', { flag: 'wx' }); }
      catch (error) { if (!existsSync(config.lockPath)) throw error; }
    }
    for (const [offset, step] of steps.entries()) {
      const index = offset + 1, timeoutMs = (step.timeoutSec ?? config.defaultTimeoutSec) * 1000;
      const plan = { ...launcher.plan(step, stepProject(project, step), runDir, index, isolatedHome), config };
      const started = Date.now(); let waits = 0, launchFailed = false, launchError = '', startupCrashes = 0;
      let licenceLaunches = 0, licenceWaitedMs = 0, contention: LicenceContention | undefined, competitors: UnityCompetitor[] = [];
      // The projects this step owns: an editor pointed at one of them is this Run's, not a competitor.
      const ownProjects = [...new Set([project, plan.env.AVH_PROJECT_DIR].filter((path): path is string => !!path))];
      let outcome: Awaited<ReturnType<UnityLaunch>>;
      for (;;) {
        try { outcome = await launch(plan, Math.max(1, timeoutMs - (Date.now() - started))); }
        catch (error) {
          launchFailed = true; launchError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
          outcome = { code: 1, timedOut: false }; break;
        }
        let remaining = timeoutMs - (Date.now() - started);
        if (outcome.code !== 0 && !outcome.timedOut && startupCrashes < STARTUP_CRASH_RETRIES && remaining > 0 &&
          existsSync(plan.log) && crashedDuringStartup(readFileSync(plan.log, 'utf8'))) {
          // Keep the crashed attempt's log beside the retry's for diagnosis, redacted like every step log.
          startupCrashes++;
          hostPlatform.writePrivate(`${plan.log}.startup-crash-${startupCrashes}`, redactLog(readFileSync(plan.log, 'utf8'), copied, isolatedHome));
          rmSync(plan.log, { force: true });
          continue;
        }
        // Licence-client contention: another editor on this machine was bringing up the account-wide client while ours
        // did, so this one aborted before its code ran. Let the winner settle, then relaunch; the holder and what the
        // person must close are kept either way, and reported when the retries are spent.
        if (outcome.code !== 0 && !outcome.timedOut) {
          const seen = licenceContention({ exitCode: outcome.code,
            log: existsSync(plan.log) ? readFileSync(plan.log, 'utf8') : '',
            clientLog: redactLog(licenceClientLog(runDir), copied, isolatedHome) });
          if (seen) {
            contention = seen;
            competitors = probe.competitors(ownProjects);
            if (licenceLaunches < LICENCE_CONTENTION_RETRIES && remaining > 0) {
              const budget = Math.min(LICENCE_CONTENTION_WAIT_MS, Math.max(0, remaining - 1000));
              const released = await waitForLicenceMachine(probe, ownProjects, budget,
                Math.min(LICENCE_SETTLE_MS, budget), waitBusy);
              licenceWaitedMs += released.waitedMs;
              // Keep the holder that was named even when it has since exited: the evidence is what the step saw.
              if (released.competitors.length) competitors = released.competitors;
              remaining = timeoutMs - (Date.now() - started);
              // Only a machine whose client has gone is worth another launch: while one is running, our own client
              // cannot take the mutex and our editor is refused on the channel, so a relaunch would only spend another
              // 60s to reach the same abort.
              if (!released.competitors.some(item => item.kind === 'licensing-client') && remaining > 0) {
                licenceLaunches++;
                continue;
              }
            }
            if (remaining <= 0) outcome = { code: 124, timedOut: true };
          }
        }
        if (outcome.code !== config.busyExitCode || outcome.timedOut) break;
        if (remaining <= 0) { outcome = { code: 124, timedOut: true }; break; }
        waits++; onWait(index, waits); await waitBusy(Math.min(30000, remaining));
      }
      let log = existsSync(plan.log) ? readFileSync(plan.log, 'utf8') : '';
      // Seeds and their paths are never retained in log or result evidence.
      log = redactLog(log, copied, isolatedHome);
      if (existsSync(plan.log)) hostPlatform.writePrivate(plan.log, log);
      const failed = outcome.code !== 0 || outcome.timedOut;
      const errors = [ ...(contention && failed ? ['另一个 Unity 占用本机授权客户端（退出码 ' + contention.exitCode + '）'] : []),
        // Why the project could not be opened comes before the log's last lines: an exited-but-unreclaimed editor and
        // a live one are the same exit code, and only this line tells the person which of the two to wait for.
        ...(failed && outcome.busy ? [unityOccupancyNote(outcome.busy) ?? '工程被占用'] : []),
        ...(launchFailed ? [`Unity launch failed${launchError ? `: ${launchError}` : ''}`] : []),
        ...log.split(/\r?\n/).slice(-200).filter(line => /error|Exception|Failed/i.test(line)) ].slice(0, 20);
      const licence = contention ? { exitCode: contention.exitCode, evidence: contention.evidence,
        competitors, retries: licenceLaunches, waitedMs: licenceWaitedMs } : undefined;
      const guidance = !failed ? undefined
        : licence ? licenceGuidance(contention!, competitors, { retries: licenceLaunches, waitedMs: licenceWaitedMs })
        : outcome.busy ? unityOccupancyGuidance(outcome.busy) : undefined;
      evidence.push({ index, method: step.method, exitCode: outcome.code, durationMs: Date.now() - started,
        log: plan.log, errors, ...(outcome.timedOut ? { timedOut: true } : {}), waits, ...(startupCrashes ? { startupCrashes } : {}),
        ...(outcome.isolation ? { isolation: outcome.isolation.kind, ...(outcome.isolation.note ? { isolationNote: outcome.isolation.note } : {}) } : {}),
        ...(licence ? { licence } : {}), ...(guidance ? { guidance } : {}) });
      if (outcome.code !== 0 || outcome.timedOut) break;
    }
    return evidence;
  } finally {
    for (const [offset] of steps.entries()) {
      const log = join(runDir, `unity-${offset + 1}.log`);
      if (existsSync(log)) hostPlatform.writePrivate(log, redactLog(readFileSync(log, 'utf8'), copied, isolatedHome));
    }
    for (const path of copied) rmSync(path, { force: true });
  }
}
