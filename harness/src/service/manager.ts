import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { hostPlatform } from '../host-platform.ts';
import { harnessRoot } from '../provenance.ts';
import { apiEndpoint, probeEndpoint } from '../api/protocol.ts';
import { helperJson, windowsLauncher } from '../exec/windows-helper.ts';
import { preflightWindowsDirectories } from '../exec/windows-boundary.ts';
import { loadConfig } from '../config.ts';

/**
 * Keeps the Runtime service running in the background. Linux uses a systemd user unit when the user
 * manager is available, otherwise a detached process with a log file. Windows starts it without a window through the
 * helper's launcher, and `install` adds a per-user login entry (HKCU\...\Run) that does the same at sign-in.
 */
export interface ServiceStatus {
  running: boolean; endpoint: string; manager: 'systemd-user' | 'detached' | 'windows-login';
  unit?: { name: string; path: string; installed: boolean; enabled: boolean; active: boolean };
  /** Whether services keep running after the user logs out; undefined when it cannot be read. */
  linger?: boolean;
  log: string;
}

const DEFAULT_HOME = join(homedir(), '.avatar-harness');
export function unitName(home: string): string {
  return home === DEFAULT_HOME ? 'avh-runtime.service'
    : `avh-runtime-${createHash('sha256').update(home).digest('hex').slice(0, 8)}.service`;
}
function unitDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
}
export function unitFile(home: string, intervalMs: number, node = process.execPath, cli = join(harnessRoot, 'bin', 'avh.js'),
  path = process.env.PATH): string {
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return ['[Unit]', `Description=Avatar Harness Runtime (${home})`, '', '[Service]', 'Type=simple',
    `Environment=${quote(`AVH_HOME=${home}`)}`,
    // The user manager's PATH usually lacks per-user CLI directories (npm global, ~/.local/bin), where codex and
    // claude live; without the installing shell's PATH the service cannot start any Provider.
    ...(path ? [`Environment=${quote(`PATH=${path}`)}`] : []),
    `ExecStart=${quote(node)} ${quote(cli)} service run --interval ${intervalMs}`,
    // SIGTERM lets the scheduler finish its round; Run units are separate units and keep running.
    'KillSignal=SIGTERM', 'TimeoutStopSec=150', 'Restart=on-failure', 'RestartSec=5', '',
    '[Install]', 'WantedBy=default.target', ''].join('\n');
}

function systemctl(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: (result.stderr ?? '') + (result.error ? String(result.error) : '') };
}
export function systemdUserAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  const result = systemctl(['is-system-running']);
  return result.status !== null && !/Failed to connect|No such file/.test(result.stderr) &&
    /running|degraded|starting|maintenance/.test(result.stdout);
}
export function lingerEnabled(): boolean | undefined {
  const result = spawnSync('loginctl', ['show-user', userInfo().username, '-p', 'Linger', '--value'], { encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() === 'yes';
}

/** The login entry's value name, one per Harness home like the systemd unit. */
export function windowsLoginName(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const standard = join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'avh');
  return home.toLowerCase() === standard.toLowerCase() ? 'AvatarHarnessRuntime'
    : `AvatarHarnessRuntime-${createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 8)}`;
}
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** What a Windows service is started with: the session's environment, minus the GUI host's own session tokens. */
function windowsServiceEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AVH_HOME: home };
  delete env.AVH_GUI_SESSION_TOKEN; delete env.AVH_GUI_NATIVE_TOKEN;
  return env;
}

export class ServiceManager {
  readonly home: string; readonly endpoint: string; readonly log: string;
  constructor(home: string) {
    this.home = home; this.endpoint = apiEndpoint(home); this.log = join(home, 'logs', 'service.log');
  }
  /** The argv the Windows launcher starts: this Node and CLI, in the foreground service mode. */
  private windowsCommand(intervalMs: number): string[] {
    return [windowsLauncher(), '--log', this.log, '--env', `AVH_HOME=${this.home}`, '--',
      process.execPath, join(harnessRoot, 'bin', 'avh.js'), 'service', 'run', '--interval', String(intervalMs)];
  }
  private windowsLogin(): ServiceStatus['unit'] {
    const name = windowsLoginName(this.home);
    let value: string | null = null;
    try { value = helperJson<{ value: string | null }>(['autostart', '--get', name]).value; } catch { /* no helper: not installed */ }
    return { name, path: `${RUN_KEY}\\${name}`, installed: value !== null, enabled: value !== null, active: false };
  }
  private unit(): ServiceStatus['unit'] | undefined {
    if (process.platform === 'win32') return this.windowsLogin();
    if (!systemdUserAvailable()) return undefined;
    const name = unitName(this.home); const path = join(unitDir(), name);
    const enabled = systemctl(['is-enabled', name]).stdout.trim() === 'enabled';
    const active = systemctl(['is-active', name]).stdout.trim() === 'active';
    return { name, path, installed: existsSync(path), enabled, active };
  }
  async status(): Promise<ServiceStatus> {
    const unit = this.unit();
    const running = await probeEndpoint(this.endpoint);
    if (process.platform === 'win32') return { running, endpoint: this.endpoint, manager: unit?.installed ? 'windows-login' : 'detached',
      ...(unit?.installed ? { unit: { ...unit, active: running } } : {}), log: this.log };
    return { running, endpoint: this.endpoint, manager: unit ? 'systemd-user' : 'detached',
      ...(unit ? { unit } : {}), ...(process.platform === 'linux' ? { linger: lingerEnabled() } : {}), log: this.log };
  }
  install(intervalMs: number): string {
    if (process.platform === 'win32') {
      const name = windowsLoginName(this.home);
      hostPlatform.mkdirPrivate(join(this.home, 'logs'));
      helperJson(['autostart', '--set', name, '--', ...this.windowsCommand(intervalMs)]);
      return `${RUN_KEY}\\${name}`;
    }
    if (!systemdUserAvailable()) throw new Error('没有可用的 systemd 用户实例；请用 avh service start（后台进程）或 avh service run');
    const name = unitName(this.home); const path = join(unitDir(), name);
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(path, unitFile(this.home, intervalMs), { mode: 0o644 });
    for (const args of [['daemon-reload'], ['enable', '--now', name]]) {
      const result = systemctl(args);
      if (result.status !== 0) throw new Error(`systemctl --user ${args.join(' ')}: ${result.stderr.trim()}`);
    }
    return path;
  }
  uninstall(): void {
    if (process.platform === 'win32') { helperJson(['autostart', '--remove', windowsLoginName(this.home)]); return; }
    const name = unitName(this.home); const path = join(unitDir(), name);
    if (systemdUserAvailable()) systemctl(['disable', '--now', name]);
    rmSync(path, { force: true });
    if (systemdUserAvailable()) systemctl(['daemon-reload']);
  }
  /** Start in the background and wait until the API answers. */
  async start(intervalMs: number, waitMs = 15_000): Promise<'already' | 'systemd-user' | 'detached'> {
    if (await probeEndpoint(this.endpoint)) return 'already';
    // Surface the actionable failure in GUI/CLI, before launching a detached service that only logs it.
    if (process.platform === 'win32') preflightWindowsDirectories(this.home, loadConfig(this.home).workspaceRoot);
    const unit = process.platform === 'win32' ? undefined : this.unit();
    let how: 'systemd-user' | 'detached';
    if (process.platform === 'win32') {
      // The launcher gives the service a console without a window; the scheduler and every git, Unity or Provider
      // process below it share that console instead of each opening a window. It is left outside any job, so the
      // service keeps running after this process (a terminal, the GUI) exits.
      hostPlatform.mkdirPrivate(join(this.home, 'logs'));
      const [launcher, ...args] = this.windowsCommand(intervalMs);
      const child = spawn(launcher!, args, { detached: true, stdio: 'ignore', windowsHide: true, env: windowsServiceEnvironment(this.home) });
      child.unref();
      how = 'detached';
    } else if (unit?.installed) {
      const result = systemctl(['start', unit.name]);
      if (result.status !== 0) throw new Error(`systemctl --user start ${unit.name}: ${result.stderr.trim()}`);
      how = 'systemd-user';
    } else {
      hostPlatform.mkdirPrivate(join(this.home, 'logs'));
      const out = openSync(this.log, 'a', 0o600);
      const child = spawn(process.execPath, [join(harnessRoot, 'bin', 'avh.js'), 'service', 'run', '--interval', String(intervalMs)],
        { detached: true, stdio: ['ignore', out, out], env: { ...process.env, AVH_HOME: this.home } });
      child.unref();
      how = 'detached';
    }
    for (const deadline = Date.now() + waitMs; Date.now() < deadline;) {
      if (await probeEndpoint(this.endpoint)) return how;
      await delay(200);
    }
    throw new Error(`Runtime 服务没有在 ${waitMs / 1000} 秒内就绪；日志：${how === 'detached' ? this.log : `journalctl --user -u ${unitName(this.home)}`}`);
  }
  async stop(waitMs = 160_000): Promise<boolean> {
    const unit = this.unit();
    if (unit?.active) { systemctl(['stop', unit.name]); }
    else if (await probeEndpoint(this.endpoint)) {
      const { ApiClient } = await import('../api/client.ts');
      const client = await ApiClient.connect(this.home);
      try { await client.call('service.stop'); } finally { client.close(); }
    } else return false;
    for (const deadline = Date.now() + waitMs; Date.now() < deadline;) {
      if (!await probeEndpoint(this.endpoint)) return true;
      await delay(200);
    }
    throw new Error('Runtime 服务没有按时停止');
  }
  lastLogLines(count = 20): string[] {
    try { return readFileSync(this.log, 'utf8').trim().split('\n').slice(-count); } catch { return []; }
  }
}
