import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, type Stats } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { avhHome } from '../config.ts';
import { hostPlatform } from '../host-platform.ts';

export interface SandboxStatus { available: boolean; reason?: string }
/** `lowil` is the Windows boundary: a restricted Low integrity token that writes only where Harness put a Low label. */
export type SandboxKind = 'codex' | 'bwrap' | 'scan' | 'self' | 'inner-bwrap' | 'lowil';
export interface BwrapStateIsolation {
  directory: string;
  writableFiles: string[];
  readonlyFiles: string[];
  guardDirectory: string;
}

function inside(path: string, root: string): boolean {
  return hostPlatform.within(root, path);
}

function outsideProbe(paths: string[], candidates: string[]): string | undefined {
  for (const root of candidates) {
    if (paths.some(allowed => inside(resolve(root), allowed))) continue;
    const path = join(root, `.avh-negative-${randomUUID()}`);
    try { hostPlatform.writePrivate(path, 'host can write', { flag: 'wx' }); rmSync(path); return path; }
    catch { rmSync(path, { force: true }); }
  }
  return undefined;
}

export function writablePaths(project: string, runDirectory: string, whitelist: string[],
  allowedWrites: string[] = [project]): string[] {
  return [...new Set([runDirectory, ...allowedWrites, ...whitelist].map(path => {
    if (!isAbsolute(path)) throw new Error(`Writable path must be absolute: ${path}`);
    let directory = path;
    while (!existsSync(directory)) directory = dirname(directory);
    if (!statSync(directory).isDirectory()) directory = dirname(directory);
    return realpathSync(directory);
  }))];
}

/** bwrap can bind an existing file directly; Codex writable roots above must remain directories. */
export function bwrapWritablePaths(project: string, runDirectory: string, whitelist: string[],
  allowedWrites: string[] = [project]): string[] {
  const paths = [...new Set([runDirectory, ...allowedWrites, ...whitelist].map(path => {
    if (!isAbsolute(path)) throw new Error(`Writable path must be absolute: ${path}`);
    let existing = path;
    while (!existsSync(existing)) existing = dirname(existing);
    return realpathSync(existing);
  }))];
  // A child file bind is redundant under an already writable directory. Keeping it makes rename() fail with
  // EBUSY even though the declared sibling temporary file requires that same directory mount.
  return paths.filter(path => !paths.some(parent => parent !== path && statSync(parent).isDirectory() &&
    path.startsWith(parent.endsWith(sep) ? parent : parent + sep)));
}

/** The desktop app's WebView keeps its own cookie jar, a BOOTH login included, under this identifier. */
const DESKTOP_IDENTIFIER = 'app.avatar-harness.desktop';
export interface HostMasks { directories: string[]; sockets: string[] }

/**
 * Host endpoints a sandboxed Run must not reach, not even read-only. `--ro-bind / /` leaves every path socket
 * connectable and `--unshare-net` does not change that: the Runtime API decides Gates, the session bus can start
 * units outside the sandbox, and the Docker socket is root for members of the docker group. The Runtime's config
 * and state hold the BOOTH session and tokens. Only paths that exist are returned; bwrap cannot mount over a
 * missing path under the read-only root.
 */
export function hostMasks(harnessHome: string, env: NodeJS.ProcessEnv = process.env,
  options: { runtimeDirectory?: boolean } = {}): HostMasks {
  const xdg = (name: string, fallback: string): string => {
    const value = env[name];
    return value && isAbsolute(value) ? value : join(homedir(), fallback);
  };
  const existing = (paths: (string | undefined)[], kind: (info: Stats) => boolean): string[] =>
    [...new Set(paths.flatMap(path => {
      if (!path || !isAbsolute(path)) return [];
      try { return kind(statSync(path)) ? [realpathSync(path)] : []; } catch { return []; }
    }))];
  const uid = process.getuid?.();
  const directories = existing([join(harnessHome, 'run'), join(harnessHome, 'config'), join(harnessHome, 'state'),
    ...['XDG_DATA_HOME:.local/share', 'XDG_CONFIG_HOME:.config', 'XDG_CACHE_HOME:.cache'].map(entry => {
      const [name, fallback] = entry.split(':') as [string, string];
      return join(xdg(name, fallback), DESKTOP_IDENTIFIER);
    }),
    ...(options.runtimeDirectory === false ? [] : [env.XDG_RUNTIME_DIR, uid === undefined ? undefined : `/run/user/${uid}`])],
  info => info.isDirectory());
  const dockerHost = env.DOCKER_HOST?.startsWith('unix://') ? env.DOCKER_HOST.slice('unix://'.length) : undefined;
  const sockets = existing(['/run/docker.sock', '/var/run/docker.sock', dockerHost, '/run/dbus/system_bus_socket',
    env.SSH_AUTH_SOCK], info => info.isSocket()).filter(socket => !directories.some(directory => inside(socket, directory)));
  return { directories, sockets };
}

/**
 * Masks go before a Run's binds, so a writable path under a masked directory is bound back on top of the mask.
 * A mask over a path the Run only reads (its project, its executable) is dropped instead of hiding that path.
 */
export function maskArgs(masks: HostMasks, keep: (string | undefined)[] = []): string[] {
  const needed = keep.filter((path): path is string => !!path && isAbsolute(path));
  const directories = masks.directories.filter(directory => !needed.some(path => inside(path, directory)));
  return [...directories.flatMap(directory => ['--tmpfs', directory]),
    ...masks.sockets.flatMap(socket => ['--ro-bind', '/dev/null', socket])];
}

/** What a bwrap Run gets before its binds: its own PID namespace (no signalling or reading host processes) and masks. */
export function runIsolationArgs(harnessHome: string, keep: (string | undefined)[] = [],
  env: NodeJS.ProcessEnv = process.env): string[] {
  return ['--unshare-pid', '--proc', '/proc', ...maskArgs(hostMasks(harnessHome, env), keep)];
}

export function bwrapArgs(paths: string[], argv: string[], isolation?: BwrapStateIsolation,
  readonlyPaths = gitMetadataPaths(paths), prefixMounts: string[] = [], suffixMounts: string[] = []): string[] {
  return ['--die-with-parent', '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev',
    ...prefixMounts,
    ...paths.flatMap(path => ['--bind', path, path]),
    ...readonlyPaths.flatMap(path => ['--ro-bind', path, path]),
    ...(isolation ? ['--tmpfs', isolation.directory,
      '--ro-bind', join(isolation.guardDirectory, 'projects'), join(isolation.directory, 'projects'),
      '--ro-bind', join(isolation.guardDirectory, 'settings.json'), join(isolation.directory, 'settings.json'),
      '--ro-bind', join(isolation.guardDirectory, 'CLAUDE.md'), join(isolation.directory, 'CLAUDE.md'),
      ...isolation.readonlyFiles.flatMap(path => ['--ro-bind', path, path]),
      ...isolation.writableFiles.flatMap(path => ['--bind', path, path])] : []), ...suffixMounts, '--', ...argv];
}

/** Every repository metadata entry under a writable root needs a later read-only bind. */
export function gitMetadataPaths(paths: string[]): string[] {
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (directory: string): void => {
    if (seen.has(directory)) return;
    seen.add(directory);
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.name === '.git') { found.add(path); continue; }
      if (entry.isDirectory()) visit(path);
    }
  };
  for (const path of paths) {
    if (!existsSync(path)) continue;
    if (lstatSync(path).isFile()) { if (basename(path) === '.git') found.add(path); continue; }
    visit(path);
  }
  return [...found].sort();
}

/** The child's cwd (the Run directory) is the primary writable root; all other roots are explicit.
 * No `-C`: with it, this Codex CLI demands `--permission-profile`; spawn with `cwd` instead. */
export function codexSandboxArgs(runDirectory: string, paths: string[], argv: string[], profile?: string,
  network = false, includeRunDirectory = false): string[] {
  const extra = includeRunDirectory ? paths : paths.filter(path => path !== realpathSync(runDirectory));
  return ['sandbox', ...(profile ? ['-P', profile] : []), '-c', 'sandbox_mode="workspace-write"',
    // /tmp and $TMPDIR are writable by default in workspace-write; exclude them so only explicit roots are.
    '-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(extra)}`,
    ...(network ? ['-c', 'sandbox_workspace_write.network_access=true'] : []),
    '--', ...argv];
}

export function probeCodex(project: string, runDirectory: string, whitelist: string[], executable = 'codex',
  profile?: string, network = false, allowedWrites?: string[]): SandboxStatus {
  let paths: string[];
  try { paths = writablePaths(project, runDirectory, whitelist, allowedWrites); }
  catch (error) { return { available: false, reason: String(error) }; }
  if (gitMetadataPaths(paths).length) return { available: false, reason: 'Codex sandbox writable root contains .git; use bwrap read-only bind' };
  const positive = paths.map(root => join(root, `.avh-positive-${randomUUID()}`));
  const negative = outsideProbe(paths, [dirname(project), tmpdir()]);
  if (!negative) return { available: false, reason: 'No host-writable directory outside whitelist for negative probe' };
  const command = ['sh', '-c', 'for file do printf probe > "$file" || exit 1; done', 'sh'];
  const codexHome = mkdtempSync(join(tmpdir(), 'avh-codex-probe-'));
  const probeOptions = { encoding: 'utf8' as const, cwd: realpathSync(runDirectory),
    env: { ...process.env, CODEX_HOME: codexHome } };
  const good = spawnSync(executable, codexSandboxArgs(runDirectory, paths, [...command, ...positive], profile, network), probeOptions);
  const bad = good.status === 0
    ? spawnSync(executable, codexSandboxArgs(runDirectory, paths, [...command, negative], profile, network), probeOptions) : undefined;
  const passed = good.status === 0 && positive.every(existsSync) && bad?.status !== 0 && !existsSync(negative);
  for (const path of positive) rmSync(path, { force: true });
  rmSync(negative, { force: true });
  rmSync(codexHome, { recursive: true, force: true });
  return passed ? { available: true } : { available: false,
    reason: good.status !== 0 ? (good.stderr || String(good.error || `exit ${good.status}`)).trim()
      : `outside write unexpectedly succeeded or was not blocked: ${bad?.stderr?.trim() ?? ''}` };
}

/** Positive and negative probes distinguish a working sandbox from namespace failure. */
export function probeBwrap(project: string, runDirectory: string, whitelist: string[], allowedWrites?: string[],
  home = avhHome(), isolation?: BwrapStateIsolation): SandboxStatus {
  let paths: string[];
  try { paths = bwrapWritablePaths(project, runDirectory, whitelist, allowedWrites); }
  catch (error) { return { available: false, reason: String(error) }; }
  const positive = join(runDirectory, `.avh-positive-${randomUUID()}`);
  const candidates = [tmpdir(), dirname(project), join(home, 'probe')];
  const negative = outsideProbe(paths, candidates.slice(0, 2)) ?? (() => {
    const probe = candidates[2]!;
    if (paths.some(allowed => inside(resolve(probe), allowed))) return undefined;
    try { hostPlatform.mkdirPrivate(probe); }
    catch { return undefined; }
    return outsideProbe(paths, [probe]);
  })();
  if (!negative) return { available: false,
    reason: `No host-writable directory outside whitelist for negative probe; candidates: ${JSON.stringify(candidates)}; whitelist: ${JSON.stringify(paths)}` };
  const command = ['sh', '-c', 'printf probe > "$1"', 'sh'];
  // Probe with the same PID namespace and masks a Run gets, so a host that refuses them is reported here.
  const prefix = runIsolationArgs(home, [project, runDirectory]);
  const good = spawnSync('bwrap', bwrapArgs(paths, [...command, positive], isolation, gitMetadataPaths(paths), prefix),
    { encoding: 'utf8' });
  const bad = good.status === 0
    ? spawnSync('bwrap', bwrapArgs(paths, [...command, negative], isolation, gitMetadataPaths(paths), prefix),
      { encoding: 'utf8' }) : undefined;
  const passed = good.status === 0 && bad?.status !== 0 && !existsSync(negative);
  rmSync(positive, { force: true });
  rmSync(negative, { force: true });
  return passed ? { available: true } : { available: false,
    reason: good.status !== 0 ? (good.stderr || String(good.error || `exit ${good.status}`)).trim()
      : `outside write unexpectedly succeeded or was not blocked: ${bad?.stderr?.trim() ?? ''}` };
}
