import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { avhHome } from '../config.ts';
import { hostPlatform } from '../host-platform.ts';
import { gitHead, outsideStatus } from './git-scan.ts';
import { bwrapWritablePaths, gitMetadataPaths, writablePaths } from './sandbox.ts';
import { applyLabels, labelWithLedger, releaseLedgers, windowsHelper } from './windows-helper.ts';
import { verifyBoundary, type BoundaryPrepared, type BoundaryProbe, type BoundarySpawnOptions, type BoundaryVerification,
  type WriteBoundary, type WritePolicy } from './write-boundary.ts';

type ProbeResult = { available: boolean; reason?: string };
let lowProbe: { result: ProbeResult; until: number } | undefined;

/**
 * The positive and negative probe of the Windows boundary: a Low process must write where a Low label is and must be
 * refused one directory beside it. The mechanism does not depend on the Run's paths, so a pass is kept for a while.
 */
export function probeLowIntegrity(): ProbeResult {
  if (lowProbe && lowProbe.until > Date.now()) return lowProbe.result;
  let result: ProbeResult;
  let scratch: string | undefined;
  try {
    const helper = windowsHelper();
    scratch = mkdtempSync(join(tmpdir(), 'avh-lowil-probe-'));
    const allowed = join(scratch, 'allowed'); mkdirSync(allowed);
    applyLabels([{ path: allowed, kind: 'low' }]);
    const write = (target: string) => spawnSync(helper, ['sandbox', '--low', '--', process.execPath, '-e',
      "require('fs').writeFileSync(process.argv[1], 'probe')", target], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const positive = join(allowed, 'positive'), negative = join(scratch, 'negative');
    const good = write(positive);
    const bad = good.status === 0 ? write(negative) : undefined;
    result = good.status === 0 && existsSync(positive) && bad?.status !== 0 && !existsSync(negative) ? { available: true }
      : { available: false, reason: good.status !== 0 ? (good.stderr || String(good.error ?? `exit ${good.status}`)).trim()
        : 'a write outside the Low label was not refused' };
  } catch (error) { result = { available: false, reason: (error as Error).message }; }
  finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  lowProbe = { result, until: Date.now() + (result.available ? 10 * 60_000 : 0) };
  return result;
}
export function resetLowIntegrityProbe(): void { lowProbe = undefined; }

/**
 * A Low label opens a whole tree to every Low process on the machine for as long as it is there, so only paths inside
 * Harness's own areas may get one: never a drive root, the user's profile or anything above AVH_HOME.
 */
export function assertLabelable(path: string, home = avhHome()): void {
  const target = resolve(path);
  const root = parse(target).root;
  const refuse = (why: string): never => { throw new Error(`不能给 ${target} 设 Low 标签：${why}`); };
  if (target === root || dirname(target) === root) refuse('太靠近盘符根目录');
  for (const guarded of [homedir(), home, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
    process.env.ProgramData].filter((value): value is string => !!value)) {
    if (hostPlatform.within(target, guarded)) refuse(`它包含 ${guarded}`);
  }
  for (const system of [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
    .filter((value): value is string => !!value)) if (hostPlatform.within(system, target)) refuse(`它在 ${system} 里`);
}

/**
 * Windows counterpart of LinuxWriteBoundary. The Run's command gets a restricted Low integrity token (`lowil`): it can
 * write only where a Low label is. prepare labels the Run's writable roots Low and their Git metadata back to Medium
 * (read-only), recording both in a ledger under AVH_HOME/state, out of the Run's reach (labelWithLedger); release
 * clears them again. What bwrap does with masks
 * (hiding the Runtime's control endpoints, configuration and state) is done once for the whole AVH_HOME by
 * `protectHarnessHome`, and named pipes and processes are Medium objects a Low process cannot write to anyway.
 */
export class WindowsWriteBoundary implements WriteBoundary {
  private readonly probes: { lowil(policy: WritePolicy): ProbeResult };
  constructor(probes: Partial<WindowsWriteBoundary['probes']> = {}) {
    this.probes = { lowil: () => probeLowIntegrity(), ...probes };
  }
  probe(policy: WritePolicy): BoundaryProbe {
    if (policy.owner === 'self' || policy.owner === 'inner-bwrap') return { kind: policy.owner, strength: 'prevent' };
    // A masked directory keeps a Provider's own state file writable while guard files hide the rest; labels label whole
    // trees and cannot say that.
    const result: ProbeResult = policy.maskedDirs.length
      ? { available: false, reason: 'masked directories need bind mounts, which Windows labels cannot express' }
      : this.probes.lowil(policy);
    if (result.available) return { kind: 'lowil', strength: 'prevent' };
    const reason = `lowil: ${result.reason}`;
    if (policy.minStrength === 'prevent') throw new Error(`Provider requires an OS sandbox: ${reason}`);
    return { kind: 'scan', strength: 'detect', reason };
  }
  prepare(policy: WritePolicy, probe: BoundaryProbe): BoundaryPrepared {
    const writable = probe.kind === 'lowil'
      ? bwrapWritablePaths(policy.project, policy.runDirectory, policy.writableRoots, policy.allowedWrites)
      : writablePaths(policy.project, policy.runDirectory, policy.writableRoots, policy.allowedWrites);
    if (policy.writableFiles.length) {
      if (probe.kind !== 'lowil') throw new Error('Writable files require a labelled boundary');
      for (const file of policy.writableFiles) {
        if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Writable file is missing: ${file}`);
        writable.push(realpathSync(file));
      }
    }
    const readonly = policy.readonlyWithinWritable === 'git-metadata' ? gitMetadataPaths(writable) : [];
    if ((probe.kind === 'self' || probe.kind === 'scan') && readonly.length)
      throw new Error(`${probe.kind} sandbox cannot guarantee .git read-only within a writable root`);
    const prepared = { baseline: outsideStatus(policy.repository, policy.project, policy.scanLimits),
      head: gitHead(policy.repository), writable, readonly };
    if (probe.kind === 'lowil') {
      for (const path of writable) assertLabelable(path);
      protectHarnessHomeOnce(policy.harnessHome ?? avhHome());
      labelWithLedger(policy.harnessHome ?? avhHome(), policy.runDirectory, writable, readonly);
    }
    return prepared;
  }
  spawnOptions(policy: WritePolicy, probe: BoundaryProbe, prepared: BoundaryPrepared): BoundarySpawnOptions {
    return { sandbox: probe.kind, sandboxExecutable: hostPlatform.resolveExecutable(policy.sandboxExecutable ?? 'codex'),
      helperExecutable: windowsHelper(), sandboxProfile: policy.sandboxProfile, writable: prepared.writable,
      readonlyGitPaths: probe.kind === 'lowil' ? prepared.readonly : [], network: policy.network,
      writeBoundary: { kind: probe.kind, strength: probe.strength } };
  }
  verify(policy: WritePolicy, probe: BoundaryProbe, prepared: BoundaryPrepared): BoundaryVerification {
    return verifyBoundary(policy, probe, prepared);
  }
  release(policy: WritePolicy): void { releaseLedgers(policy.harnessHome ?? avhHome(), policy.runDirectory); }
}

/**
 * What the Linux sandbox masks, made unreadable to Low processes once and for all: the Runtime's control files,
 * configuration (with the BOOTH session) and state database, and the desktop app's WebView data (its cookie jar holds
 * the BOOTH login). A Medium label with no-read-up keeps the Runtime (Medium) reading them as before.
 */
export function harnessPrivatePaths(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const desktop = 'app.avatar-harness.desktop';
  return [join(home, 'run'), join(home, 'config'), join(home, 'state'),
    ...[env.LOCALAPPDATA, env.APPDATA].filter((value): value is string => !!value).map(root => join(root, desktop))];
}
export function protectHarnessHome(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const paths = harnessPrivatePaths(home, env).filter(path => existsSync(path));
  applyLabels(paths.map(path => ({ path, kind: 'private' as const })));
}
/** Fail before scheduling, on the actual volumes and inherited ACLs, rather than only probing TEMP. */
export function preflightWindowsDirectories(home: string, workspace: string): void {
  for (const name of ['run', 'config', 'state', 'runs']) hostPlatform.mkdirPrivate(join(home, name));
  protectHarnessHome(home);
  for (const root of [join(home, 'runs'), workspace]) {
    let scratch: string | undefined;
    try {
      scratch = mkdtempSync(join(root, '.avh-label-probe-'));
      assertLabelable(scratch, home);
      applyLabels([{ path: scratch, kind: 'low' }]);
      applyLabels([{ path: scratch, kind: 'clear' }]);
    } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  }
}
const protectedHomes = new Set<string>();
/**
 * The same, once per process and home, before the first Low process starts: the service does it when it starts, but a
 * scheduler round, a CLI command or a check may be the first to run a Run's command.
 */
export function protectHarnessHomeOnce(home: string): void {
  const key = resolve(home).toLowerCase();
  if (protectedHomes.has(key)) return;
  protectHarnessHome(home);
  protectedHomes.add(key);
}
