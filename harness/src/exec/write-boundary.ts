import { join } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { changeEvidence, changedOutside, committedOutside, gitHead, metadataChanged, outsideStatus,
  type ChangeEvidence, type ScanLimits, type StatusSnapshot } from './git-scan.ts';
import { bwrapWritablePaths, gitMetadataPaths, probeBwrap, probeCodex, writablePaths,
  type BwrapStateIsolation, type SandboxKind } from './sandbox.ts';
import { hostPlatform } from '../host-platform.ts';
import { WindowsWriteBoundary } from './windows-boundary.ts';

export interface MaskedDir {
  path: string;
  readonlyRebinds: Array<{ source: string; target: string }>;
  writableFiles: string[];
}
export interface WritePolicy {
  project: string;
  repository: string;
  runDirectory: string;
  writableRoots: string[];
  writableFiles: string[];
  readonlyWithinWritable: 'git-metadata' | 'none';
  maskedDirs: MaskedDir[];
  privateTemp: boolean;
  network: boolean;
  minStrength: 'prevent' | 'detect';
  owner: 'outer' | 'self' | 'inner-bwrap';
  allowedWrites?: string[];
  sandboxExecutable?: string;
  sandboxProfile?: string;
  requireStableHead?: boolean;
  scanLimits?: ScanLimits;
  /** Try the Runtime's own bwrap mounts before the codex sandbox (deterministic tools). */
  prefer?: 'bwrap';
  /** The Runtime's home (AVH_HOME); Windows keeps its label ledgers there. */
  harnessHome?: string;
}
export interface BoundaryProbe { kind: SandboxKind; strength: 'prevent' | 'detect'; reason?: string }
export interface BoundaryPrepared { baseline: StatusSnapshot; head: string; writable: string[]; readonly: string[] }
export interface BoundarySpawnOptions {
  sandbox: SandboxKind;
  sandboxExecutable: string;
  /** Windows: the helper that runs the command in its job, under the Low token when the sandbox is `lowil`. */
  helperExecutable?: string;
  sandboxProfile?: string;
  writable: string[];
  readonlyGitPaths: string[];
  network: boolean;
  stateIsolation?: BwrapStateIsolation;
  writeBoundary: { kind: SandboxKind; strength: 'prevent' | 'detect' };
}
export interface BoundaryVerification {
  externalChanges: ChangeEvidence[];
  outOfBoundsPaths: string[];
  scanEvidence: ChangeEvidence[];
}
export interface WriteBoundary {
  probe(policy: WritePolicy): BoundaryProbe;
  prepare(policy: WritePolicy, probe: BoundaryProbe): BoundaryPrepared;
  spawnOptions(policy: WritePolicy, probe: BoundaryProbe, prepared: BoundaryPrepared): BoundarySpawnOptions;
  verify(policy: WritePolicy, probe: BoundaryProbe, prepared: BoundaryPrepared): BoundaryVerification;
  /** Undo what prepare changed on the host once the Run has stopped (Windows integrity labels); idempotent. */
  release?(policy: WritePolicy): void;
}

function oldIsolation(mask: MaskedDir | undefined): BwrapStateIsolation | undefined {
  if (!mask) return undefined;
  const guardDirectory = mask.readonlyRebinds.find(item => item.target === join(mask.path, 'projects'))?.source;
  if (!guardDirectory) return undefined;
  return { directory: mask.path, guardDirectory: join(guardDirectory, '..'),
    readonlyFiles: mask.readonlyRebinds.filter(item => !item.source.startsWith(join(guardDirectory, '..')))
      .map(item => item.source), writableFiles: mask.writableFiles };
}

type ProbeResult = { available: boolean; reason?: string };
/** The real sandbox tests; unit tests replace them to check which boundary is chosen. */
export interface BoundaryProbes {
  codex(policy: WritePolicy): ProbeResult;
  bwrap(policy: WritePolicy, isolation?: BwrapStateIsolation): ProbeResult;
}
export class LinuxWriteBoundary implements WriteBoundary {
  private readonly probes: BoundaryProbes;
  constructor(probes: Partial<BoundaryProbes> = {}) {
    this.probes = {
      codex: policy => probeCodex(policy.project, policy.runDirectory, policy.writableRoots,
        policy.sandboxExecutable, policy.sandboxProfile, policy.network, policy.allowedWrites),
      bwrap: (policy, isolation) => probeBwrap(policy.project, policy.runDirectory, policy.writableRoots,
        [...(policy.allowedWrites ?? [policy.project]), ...policy.writableFiles], undefined, isolation),
      ...probes };
  }
  probe(policy: WritePolicy): BoundaryProbe {
    if (policy.owner === 'self' || policy.owner === 'inner-bwrap')
      return { kind: policy.owner, strength: 'prevent' };
    const isolation = oldIsolation(policy.maskedDirs[0]);
    const codex = (): ProbeResult => isolation || policy.maskedDirs.length || policy.writableFiles.length
      ? { available: false, reason: 'file binds or masked directories require bwrap' } : this.probes.codex(policy);
    const bwrap = (): ProbeResult => this.probes.bwrap(policy, isolation);
    // A deterministic tool gets the Runtime's own mounts first: the codex sandbox adds protected entries (a read-only
    // .codex) inside every writable root, which a tool that clears its own output directory cannot remove.
    const order: Array<['codex' | 'bwrap', () => ProbeResult]> = policy.prefer === 'bwrap'
      ? [['bwrap', bwrap], ['codex', codex]] : [['codex', codex], ['bwrap', bwrap]];
    const reasons: string[] = [];
    for (const [kind, attempt] of order) {
      const result = attempt();
      if (result.available) return { kind, strength: 'prevent' };
      reasons.push(`${kind}: ${result.reason}`);
    }
    const reason = reasons.join('; ');
    if (policy.minStrength === 'prevent') throw new Error(`Provider requires an OS sandbox: ${reason}`);
    return { kind: 'scan', strength: 'detect', reason };
  }
  prepare(policy: WritePolicy, probe: BoundaryProbe): BoundaryPrepared {
    const writable = probe.kind === 'bwrap'
      ? bwrapWritablePaths(policy.project, policy.runDirectory, policy.writableRoots, policy.allowedWrites)
      : writablePaths(policy.project, policy.runDirectory, policy.writableRoots, policy.allowedWrites);
    if (policy.writableFiles.length) {
      if (probe.kind !== 'bwrap') throw new Error('Writable files require a bwrap file bind');
      for (const file of policy.writableFiles) {
        if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Writable file is missing: ${file}`);
        writable.push(realpathSync(file));
      }
    }
    const readonly = policy.readonlyWithinWritable === 'git-metadata' ? gitMetadataPaths(writable) : [];
    if ((probe.kind === 'self' || probe.kind === 'scan') && readonly.length)
      throw new Error(`${probe.kind} sandbox cannot guarantee .git read-only within a writable root`);
    return { baseline: outsideStatus(policy.repository, policy.project, policy.scanLimits),
      head: gitHead(policy.repository), writable, readonly };
  }
  spawnOptions(policy: WritePolicy, probe: BoundaryProbe, prepared: BoundaryPrepared): BoundarySpawnOptions {
    return { sandbox: probe.kind, sandboxExecutable: hostPlatform.resolveExecutable(policy.sandboxExecutable ?? 'codex'),
      sandboxProfile: policy.sandboxProfile, writable: prepared.writable,
      readonlyGitPaths: probe.kind === 'bwrap' ? prepared.readonly : [],
      network: policy.network, stateIsolation: oldIsolation(policy.maskedDirs[0]),
      writeBoundary: { kind: probe.kind, strength: probe.strength } };
  }
  verify(policy: WritePolicy, probe: BoundaryProbe, prepared: BoundaryPrepared): BoundaryVerification {
    return verifyBoundary(policy, probe, prepared);
  }
}

/** The independent Git scan after a Run, the same whichever OS boundary confined it: outside changes are evidence,
 * and only a scan-only Run reports them as out of bounds (a preventing boundary already stopped such writes). */
export function verifyBoundary(policy: WritePolicy, probe: BoundaryProbe, prepared: BoundaryPrepared): BoundaryVerification {
  const after = outsideStatus(policy.repository, policy.project, policy.scanLimits);
  const evidence = changeEvidence(policy.repository, prepared.baseline, after, policy.scanLimits);
  const statusPaths = changedOutside(prepared.baseline, after);
  const head = gitHead(policy.repository);
  const committed = committedOutside(policy.repository, policy.project, prepared.head, head, policy.scanLimits);
  const external = new Map(evidence.map(entry => [entry.path, { ...entry,
    before: entry.before ?? 'not in git status', after: entry.after ?? 'not in git status' }]));
  for (const path of committed) if (!external.has(path)) external.set(path, { path,
    before: prepared.baseline[path] ?? 'not in git status', after: after[path] ?? 'not in git status' });
  if (policy.requireStableHead && head !== prepared.head)
    external.set('<workspace HEAD moved>', { path: '<workspace HEAD moved>', before: prepared.head, after: head });
  return { scanEvidence: evidence, externalChanges: [...external.values()],
    outOfBoundsPaths: probe.kind === 'scan'
      ? [...new Set([...statusPaths.filter(path => metadataChanged(policy.repository, path, prepared.baseline[path], after[path])),
        ...committed.filter(path => prepared.baseline[path] === undefined ||
          metadataChanged(policy.repository, path, prepared.baseline[path], after[path])),
        ...(policy.requireStableHead && head !== prepared.head ? ['<workspace HEAD moved>'] : [])])]
      : [] };
}

/** The write boundary of this platform: bwrap or the Codex sandbox on Linux, the Low integrity token on Windows. */
export function createWriteBoundary(): WriteBoundary {
  return process.platform === 'win32' ? new WindowsWriteBoundary() : new LinuxWriteBoundary();
}
