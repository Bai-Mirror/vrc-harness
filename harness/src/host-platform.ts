import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { listProcesses } from './exec/windows-helper.ts';

export interface HostPlatform {
  within(root: string, path: string): boolean;
  relativePosix(root: string, path: string): string;
  writePrivate(path: string, data: string | Uint8Array, options?: { flag?: string }): void;
  mkdirPrivate(path: string): void;
  resolveExecutable(name: string): string;
  dataHome(env?: NodeJS.ProcessEnv): string;
  toolCommand(name: 'python' | '7z' | 'git'): string;
  findProcesses(pattern: string): number[];
  cloudSyncedRoot(path: string, env?: NodeJS.ProcessEnv): string | undefined;
}

/** Platform differences are injectable so path policy can be tested on Linux. */
export class NodeHostPlatform implements HostPlatform {
  readonly caseInsensitive: boolean;
  readonly windows: boolean;
  constructor(caseInsensitive = process.platform === 'win32', windows = process.platform === 'win32') {
    this.caseInsensitive = caseInsensitive;
    this.windows = windows;
  }

  private key(path: string): string {
    const normalized = resolve(path);
    return this.caseInsensitive ? normalized.toLocaleLowerCase('en-US') : normalized;
  }
  private lexicalWithin(root: string, path: string): boolean {
    const a = this.key(root), b = this.key(path);
    return b === a || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
  }
  private physical(path: string): string {
    let ancestor = resolve(path);
    const suffix: string[] = [];
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error('Path has no existing ancestor');
      suffix.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      ancestor = parent;
    }
    return join(realpathSync(ancestor), ...suffix);
  }
  within(root: string, path: string): boolean {
    if (!this.lexicalWithin(root, path)) return false;
    try { return this.lexicalWithin(this.physical(root), this.physical(path)); }
    catch { return false; }
  }
  relativePosix(root: string, path: string): string { return relative(root, path).split(sep).join('/'); }
  writePrivate(path: string, data: string | Uint8Array, options: { flag?: string } = {}): void {
    writeFileSync(path, data, { ...options, mode: 0o600 });
    chmodSync(path, 0o600);
  }
  mkdirPrivate(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }
  resolveExecutable(name: string): string {
    if (name.includes('/') || name.includes('\\')) return name;
    const env = process.env;
    // A bare Windows name never matches the extensionless file beside an npm shim (a POSIX script Windows cannot run).
    const ext = this.windows ? [...(extname(name) ? [''] : []), ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
    for (const dir of (env.PATH ?? '').split(this.windows ? ';' : delimiter).filter(Boolean)) {
      for (const suffix of ext) {
        const candidate = join(dir, name + suffix.toLowerCase());
        try { accessSync(candidate, this.windows ? constants.F_OK : constants.X_OK); return candidate; }
        catch { /* next candidate */ }
      }
    }
    return name;
  }
  dataHome(env: NodeJS.ProcessEnv = process.env): string {
    return resolve(env.AVH_HOME || (this.windows ? join(env.LOCALAPPDATA || homedir(), 'avh') : join(homedir(), '.avatar-harness')));
  }
  toolCommand(name: 'python' | '7z' | 'git'): string {
    const configured = process.env[`AVH_TOOL_${name === '7z' ? '7Z' : name.toUpperCase()}`];
    const resolved = this.resolveExecutable(configured || (name === 'python' ? (this.windows ? 'python' : 'python3') : name));
    // 7-Zip's installer does not put it on PATH; look where it installs.
    if (this.windows && name === '7z' && !configured && resolved === '7z')
      return [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((root): root is string => !!root)
        .map(root => join(root, '7-Zip', '7z.exe')).find(path => existsSync(path)) ?? resolved;
    return resolved;
  }
  findProcesses(pattern: string): number[] {
    // Like pgrep -f: the pattern is looked for in each process's whole command line (read through the Windows helper).
    if (this.windows) return listProcesses().filter(process => process.commandLine?.includes(pattern))
      .map(process => process.pid).filter(pid => pid !== globalThis.process.pid);
    const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    if (result.status === 1) return [];
    if (result.status !== 0) throw new Error(`Cannot inspect processes: ${result.error ?? result.stderr}`);
    return result.stdout.split('\n').map(Number).filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  }
  cloudSyncedRoot(path: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!this.windows) return undefined;
    return ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']
      .map(name => env[name]).find((root): root is string => {
        if (!root) return false;
        try { return this.lexicalWithin(this.physical(root), this.physical(path)); }
        catch { return false; }
      });
  }
}

export const hostPlatform: HostPlatform = new NodeHostPlatform();

/**
 * Whether a process under `pid` still exists on this host. Signal 0 is a pure existence probe on both platforms:
 * Node asks OpenProcess on Windows and calls kill(2) on Linux, and neither one signals. `EPERM` means the process is
 * there but belongs to someone else, which still counts as alive — a lock another account's Run holds must not be
 * stolen. Anything else (ESRCH, a reused free pid) is a process that is gone.
 */
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * The argv that starts `name` without a shell. On Windows a command installed by npm is a .cmd shim, which Node can
 * only start through cmd.exe (and whose argument handling differs); the shim is read for the program it runs instead:
 * a bundled executable, or node with the package's script.
 */
export function commandFor(name: string, host: HostPlatform = hostPlatform, windows = process.platform === 'win32'): string[] {
  const resolved = host.resolveExecutable(name);
  if (!windows || !/\.(cmd|bat)$/i.test(resolved)) return [resolved];
  return npmShimCommand(resolved) ?? [resolved];
}
let windowsPythonPath: string | undefined;
/**
 * The Python interpreter itself on Windows. `python` and `python3` there are usually App Execution Aliases (the Store
 * stub or the Python install manager); asking the interpreter for sys.executable once gives the real program, which
 * a Run's Low integrity sandbox starts directly. AVH_TOOL_PYTHON overrides it.
 */
export function windowsPython(host: HostPlatform = hostPlatform): string {
  if (windowsPythonPath) return windowsPythonPath;
  const configured = process.env.AVH_TOOL_PYTHON;
  if (configured) return windowsPythonPath = host.resolveExecutable(configured);
  for (const [program, ...args] of [['py', '-3'], ['python'], ['python3']]) {
    const result = spawnSync(host.resolveExecutable(program!), [...args, '-c', 'import sys; print(sys.executable)'],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    const path = result.status === 0 ? result.stdout.trim().split(/\r?\n/).pop() : undefined;
    if (path && existsSync(path)) return windowsPythonPath = path;
  }
  return windowsPythonPath = host.toolCommand('python');
}
/**
 * A frozen command as this host runs it. Capability manifests name the interpreter `python3`, as Linux does; Windows
 * substitutes its own interpreter. Elsewhere the command is unchanged.
 */
export function hostArgv(argv: string[], windows = process.platform === 'win32'): string[] {
  if (!windows || (argv[0] !== 'python3' && argv[0] !== 'python')) return argv;
  return [windowsPython(), ...argv.slice(1)];
}

/**
 * PATH for a Windows Run or check: 7-Zip's installer does not add itself to PATH, and the pack's tools call `7z` by
 * name, so its directory is appended when the Runtime found it elsewhere.
 */
export function windowsToolPath(path: string | undefined, host: HostPlatform = hostPlatform): string {
  const sevenZip = host.toolCommand('7z');
  const directories = (path ?? '').split(';').filter(Boolean);
  if (isAbsolute(sevenZip) && !directories.some(directory => resolve(directory).toLowerCase() === dirname(sevenZip).toLowerCase()))
    directories.push(dirname(sevenZip));
  return directories.join(';');
}

export function npmShimCommand(shim: string, node = process.execPath): string[] | undefined {
  let text: string;
  try { text = readFileSync(shim, 'utf8'); } catch { return undefined; }
  const line = text.split(/\r?\n/).reverse().find(item => item.includes('%*'));
  if (!line) return undefined;
  const here = dirname(shim);
  const expand = (token: string): string => resolve(here, token.replace(/^%dp0%[\\/]?/i, ''));
  const tokens = [...line.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
  const prog = tokens.findIndex(token => /%_prog%/i.test(token));
  if (prog >= 0) {
    const script = tokens[prog + 1];
    if (!script || !/^%dp0%/i.test(script)) return undefined;
    const local = join(here, 'node.exe');
    return [existsSync(local) ? local : node, expand(script)];
  }
  const program = tokens.find(token => /^%dp0%/i.test(token) && /\.(exe|com)$/i.test(token));
  return program ? [expand(program)] : undefined;
}

export function rejectCloudSyncedPath(path: string, host: HostPlatform = hostPlatform,
  env: NodeJS.ProcessEnv = process.env): void {
  if (host.cloudSyncedRoot(path, env))
    throw new Error('工程或状态目录位于云同步目录，文件锁和状态库可能冲突；请移到本机未同步的目录。');
}
