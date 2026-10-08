import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { UnityConfig } from './config.ts';
import { configuredUnityEditor } from './exec/unity-launcher.ts';
import { windowsHelper } from './exec/windows-helper.ts';
import { commandFor, hostPlatform, npmShimCommand, windowsPython } from './host-platform.ts';
import { withoutClaudeVariables } from './providers/claude.ts';
import { findUnityEditors, unityEditorProblem, VRCHAT_UNITY_VERSION } from './unity-editors.ts';
import {
  machineScript, runMachineSteps, runMachineStepsSync, stepSucceeded, WINGET_CODES, WINGET_PACKAGE, type MachineRun, type MachineStep,
} from './windows-setup-script.ts';

/**
 * The host programs Harness depends on, how to tell whether each is usable, and how to get a missing one.
 * First run and settings show this list; missing system packages are installed in one elevated step
 * (design 00: 「展示下载与安装清单，一次确认后自动配置」). Windows builds a fuller machine setup from it
 * (windows-setup.ts).
 */
export type InstallStep =
  /** Distribution packages. Each entry lists alternative names; the first the package manager offers is used. */
  | { kind: 'system'; packages: string[][] }
  /** A user-level command, run after system packages, without elevation. */
  | { kind: 'user'; argv: string[]; env?: Record<string, string> }
  | { kind: 'manual'; hint: string };
export interface Dependency {
  id: string; name: string; purpose: string; required: boolean; ok: boolean; version?: string; detail: string;
  install?: InstallStep;
}

/** The official VPM CLI targets .NET 8; on a newer runtime it only starts with major roll-forward. */
export const VPM_ENV = { DOTNET_ROLL_FORWARD: 'Major' };
/** AI command-line tools Windows installs with npm into the person's own npm prefix; pi is how Harness reaches DeepSeek and GLM. */
export const AI_TOOLS = [
  { id: 'codex', name: 'Codex CLI', package: '@openai/codex', purpose: 'AI 执行方（用 ChatGPT 订阅额度）' },
  { id: 'claude', name: 'Claude Code', package: '@anthropic-ai/claude-code', purpose: 'AI 执行方（用 Claude 订阅额度）' },
  { id: 'pi', name: 'pi', package: '@earendil-works/pi-coding-agent', purpose: 'AI 执行方：用 API 密钥连接 DeepSeek、GLM' },
] as const;
/** A dotnet global tool lands in ~/.dotnet/tools, which is on PATH only after the next login. */
export function vpmExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const found = hostPlatform.resolveExecutable('vpm');
  if (found !== 'vpm') return found;
  const home = env.HOME || homedir();
  const tool = join(home, '.dotnet', 'tools', process.platform === 'win32' ? 'vpm.exe' : 'vpm');
  try { accessSync(tool, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return tool; } catch { return undefined; }
}
/** VPM with the roll-forward it needs, unless the user chose another policy. */
export function vpmEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, DOTNET_ROLL_FORWARD: env.DOTNET_ROLL_FORWARD ?? VPM_ENV.DOTNET_ROLL_FORWARD };
}
/**
 * npm without a shell. On Windows, Node's own npm.cmd runs `node npm-cli.js` (preferring an npm installed into the global
 * prefix, as npm.cmd does); a .cmd itself can only be started through cmd.exe.
 */
export function npmCommand(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const npm = hostPlatform.resolveExecutable('npm');
  if (npm === 'npm') return undefined;
  if (process.platform !== 'win32') return [npm];
  const directory = dirname(npm), node = join(directory, 'node.exe');
  const cli = [env.APPDATA ? join(env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js') : '',
    join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(path => path && existsSync(path));
  if (cli && existsSync(node)) return [node, cli];
  return npmShimCommand(npm);
}
/** A user-level step's argv as this host starts it: npm and npm-installed commands without a shell on Windows. */
export function userCommand(argv: string[]): string[] {
  if (process.platform !== 'win32') return argv;
  if (argv[0] === 'npm') {
    const npm = npmCommand();
    if (!npm) throw new Error('找不到 npm：先安装 Node.js LTS');
    return [...npm, ...argv.slice(1)];
  }
  return [...commandFor(argv[0]!), ...argv.slice(1)];
}

/**
 * The first line a probe prints. Probes run in the temporary directory, never the Runtime's own: some programs write
 * there (the VPM CLI's crash reporter leaves Sentry/<hash>/.installation in its working directory when it cannot use
 * its cache folder).
 */
function firstLine(command: string, args: string[], options: SpawnSyncOptions = {}): string | undefined {
  // npm-installed CLIs are .cmd shims on Windows; start what they run.
  const [program, ...prefix] = process.platform === 'win32' ? commandFor(command) : [command];
  const result = spawnSync(program!, [...prefix, ...args], { encoding: 'utf8', timeout: 15_000, windowsHide: true, cwd: tmpdir(), ...options });
  if (result.error || result.status !== 0) return undefined;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').find(Boolean)?.trim();
}
function onPath(name: string): string | undefined {
  const path = hostPlatform.resolveExecutable(name);
  return path === name ? undefined : path;
}

/** Match the face tool's installed-program discovery; no workflow path setting is needed. */
export function blenderStatus(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  probe: (command: string, args: string[]) => string | undefined = firstLine): Dependency {
  const candidates = [onPath('blender')];
  if (platform === 'win32') {
    for (const base of new Set([env.ProgramFiles, env.ProgramW6432].filter(Boolean) as string[])) {
      const directory = join(base, 'Blender Foundation');
      try {
        candidates.push(...readdirSync(directory).filter(name => name.startsWith('Blender '))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(name => join(directory, name, 'blender.exe')));
      } catch { /* Not installed under this Program Files root. */ }
    }
  } else candidates.push(platform === 'darwin' ? '/Applications/Blender.app/Contents/MacOS/Blender' : '/usr/bin/blender');
  for (const path of new Set(candidates.filter(Boolean) as string[])) {
    try { if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue; } catch { continue; }
    const version = probe(path, ['--version']);
    if (version?.startsWith('Blender ')) return { id: 'blender', name: 'Blender', required: false, ok: true, version,
      detail: `${version}（自动找到）`, purpose: '脸型设计与表情补偿；保留原外形时不需要' };
  }
  return { id: 'blender', name: 'Blender', required: false, ok: false, detail: '脸型设计尚未就绪；保留原外形仍可继续',
    purpose: '脸型设计与表情补偿；保留原外形时不需要', install: platform === 'win32'
      ? { kind: 'system', packages: [['BlenderFoundation.Blender']] }
      : { kind: 'manual', hint: '脸型设计需要 Blender；安装后 Harness 会自动找到，保留原外形无需安装' } };
}

/**
 * The pinned versions of the layered-recolour dependencies. The capability's own doctor (layer_source.py)
 * refuses rather than degrades when they are missing, so the versions this build was verified against are
 * named here instead of being left to whatever pip resolves (决定记录 D-77; read with `pip show` on the
 * machine the two verification avatars ran on).
 */
export const LAYERED_RECOLOR_PINS = { 'psd-tools': '1.18.0', Pillow: '12.3.0', NumPy: '2.5.2' } as const;
/** One import probe, the same three imports layer_source.py's doctor needs, printed as one line. */
const LAYERED_RECOLOR_PROBE = [
  'import importlib, importlib.metadata as md',
  'out = []',
  'for dist, mod in [("psd-tools", "psd_tools"), ("Pillow", "PIL"), ("NumPy", "numpy")]:',
  '    try:',
  '        importlib.import_module(mod)',
  '        out.append(dist + "=" + md.version(dist))',
  '    except Exception:',
  '        out.append(dist + "=missing")',
  'print(",".join(out))',
].join('\n');
/** The interpreter the built-in stage tools run with: on Windows the real program a Run starts (host-platform.ts). */
export function toolPython(): string {
  return process.platform === 'win32' ? windowsPython() : hostPlatform.toolCommand('python');
}
/**
 * Whether this Python can import the layered-recolour dependencies, and which ones it cannot. A missing
 * import is reported as this computer's fact; `run` is injectable so a test does not need the dependency
 * installed, and so "missing" is never inferred from a machine that happens to have it.
 */
export function layeredRecolorStatus(python: string = toolPython(),
  run: (command: string, args: string[]) => string | undefined = firstLine): Dependency {
  const versions = Object.fromEntries((run(python, ['-c', LAYERED_RECOLOR_PROBE]) ?? '').split(',')
    .map(part => part.split('=')).filter(pair => pair.length === 2 && pair[0] && pair[1]).map(pair => [pair[0]!, pair[1]!]));
  const missing = Object.keys(LAYERED_RECOLOR_PINS).filter(name => !versions[name] || versions[name] === 'missing');
  const pinned = Object.entries(LAYERED_RECOLOR_PINS).map(([name, version]) => `${name}==${version}`).join(' ');
  const install: InstallStep = { kind: 'manual', hint: `用制作阶段实际使用的 Python 安装：${python} -m pip install --user ${pinned}` };
  return { id: 'layered-recolor', name: '分层改色依赖', purpose: '分层源文件（PSD）的读取、基线与区域核对（assets.layered_source）',
    required: false, ok: missing.length === 0,
    detail: missing.length ? `缺少 ${missing.join('、')}；${install.hint}` : Object.entries(LAYERED_RECOLOR_PINS).map(([name]) => `${name} ${versions[name]}`).join('、'),
    install };
}

/** Only the Unity part of the configuration matters here, so interfaces can pass what the Runtime API gives them. */
export function dependencyStatus(config?: { unity?: UnityConfig | null }): Dependency[] {
  const linux = process.platform === 'linux', windows = process.platform === 'win32';
  // Windows installs through winget (one elevated step); the names are winget package ids.
  const pkg = (debian: string[][], winget: string): string[][] => windows ? [[winget]] : debian;
  const node = Number(process.versions.node.split('.')[0]);
  const python = hostPlatform.toolCommand('python');
  const sevenZip = firstLine(hostPlatform.toolCommand('7z'), [])?.replace(/\s*:.*$/, '');
  const runtimes = onPath('dotnet') ? spawnSync('dotnet', ['--list-runtimes'], { encoding: 'utf8', timeout: 15_000, cwd: tmpdir(), windowsHide: true }) : undefined;
  const dotnet = runtimes?.status === 0 ? runtimes.stdout.split('\n').filter(line => line.startsWith('Microsoft.NETCore.App'))
    .map(line => line.split(' ')[1]).join('、') || undefined : undefined;
  const vpm = vpmExecutable();
  const vpmVersion = vpm ? firstLine(vpm, ['--version'], { env: vpmEnvironment() })?.replace(/\+.*$/, '') : undefined;
  const unity = unityStatus(config);
  const browser = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].find(onPath);
  // On Windows the AI command-line tools are installed with npm, without elevation; elsewhere the person installs them.
  const ai = (tool: typeof AI_TOOLS[number], hint: string): InstallStep =>
    windows ? { kind: 'user', argv: ['npm', 'install', '--global', tool.package] } : { kind: 'manual', hint };
  const deps: Array<Dependency | undefined> = [
    { id: 'node', name: 'Node', purpose: 'Harness 自身的运行时', required: true, ok: node >= 24, version: process.version,
      detail: node >= 24 ? process.version : `${process.version}，需要 24 或更高版本`,
      install: { kind: 'manual', hint: '桌面包自带 Node；命令行版请安装 Node 24 或更高版本' } },
    dep('git', 'git', '每个工程是一个 Git 仓库，改动靠它追溯', true, firstLine('git', ['--version']), { kind: 'system', packages: pkg([['git']], 'Git.Git') }),
    linux ? dep('bwrap', 'bubblewrap', '执行方与工具的写边界（沙箱）；工具阶段没有它不能运行', true, firstLine('bwrap', ['--version']),
      { kind: 'system', packages: [['bubblewrap']] }) : undefined,
    linux ? systemdStatus() : undefined,
    windows ? windowsHelperStatus() : undefined,
    dep('python', 'Python 3', '内置阶段工具', true, firstLine(python, ['--version']), { kind: 'system', packages: pkg([['python3']], 'Python.Python.3.13') }),
    layeredRecolorStatus(),
    blenderStatus(),
    dep('7z', '7-Zip', '交付打包与校验', true, sevenZip, { kind: 'system', packages: pkg([['7zip', 'p7zip-full']], '7zip.7zip') }),
    windows ? dep('pwsh', 'PowerShell 7', '新版 PowerShell，供命令行工具与脚本使用', false, pwshVersion(), { kind: 'system', packages: [['Microsoft.PowerShell']] }) : undefined,
    windows ? unityHubStatus() : undefined,
    unity,
    windows ? unityLicenseStatus() : undefined,
    dep('dotnet', '.NET', 'VPM 工具的运行时', false, dotnet, { kind: 'system', packages: pkg([['dotnet-sdk-10.0', 'dotnet-sdk-8.0']], 'Microsoft.DotNet.SDK.8') }),
    { id: 'vpm', name: 'VPM CLI', purpose: '检查、解析与迁移工程的 VPM 依赖', required: false, ok: Boolean(vpmVersion),
      ...(vpmVersion ? { version: vpmVersion } : {}),
      detail: vpmVersion ?? (vpm ? `${vpm} 无法运行（通常是缺 .NET 运行时）` : '未安装'),
      install: { kind: 'user', argv: ['dotnet', 'tool', 'install', '--global', 'vrchat.vpm.cli'], env: VPM_ENV } },
    windows ? npmStatus() : undefined,
    dep('codex', 'Codex CLI', AI_TOOLS[0].purpose, false, firstLine('codex', ['--version']),
      ai(AI_TOOLS[0], 'npm install -g @openai/codex，然后运行 codex login')),
    // A Claude Code session's own variables (endpoints, tokens) must not reach even a version probe.
    dep('claude', 'Claude Code', AI_TOOLS[1].purpose, false, firstLine('claude', ['--version'], { env: withoutClaudeVariables(process.env) }),
      ai(AI_TOOLS[1], 'npm install -g @anthropic-ai/claude-code，然后运行 claude 登录')),
    dep('pi', 'pi', AI_TOOLS[2].purpose, false, firstLine('pi', ['--version']),
      ai(AI_TOOLS[2], 'npm install -g @earendil-works/pi-coding-agent，然后在设置里填 DeepSeek 或 GLM 的 API 密钥')),
    linux ? dep('browser', 'Chrome/Chromium', '「avh gui」以应用窗口打开界面（桌面包不需要）', false, browser,
      { kind: 'manual', hint: '安装 Google Chrome 或 Chromium；桌面包自带界面，不需要浏览器' }) : undefined,
  ];
  return deps.filter((item): item is Dependency => Boolean(item));
}

function dep(id: string, name: string, purpose: string, required: boolean, version: string | undefined,
  install: InstallStep): Dependency {
  return { id, name, purpose, required, ok: Boolean(version), ...(version ? { version } : {}), detail: version ?? '未找到', install };
}
/** The Windows helper that supervises Runs and draws their write boundary: without it nothing can run. */
function windowsHelperStatus(): Dependency {
  const base = { id: 'avh-win', name: 'Harness Windows 辅助程序', purpose: '监管每个执行单元，并给执行方划定写边界（沙箱）', required: true };
  try { return { ...base, ok: true, detail: windowsHelper() }; }
  catch (error) {
    return { ...base, ok: false, detail: (error as Error).message,
      install: { kind: 'manual', hint: '桌面版自带；从源码运行时在 harness/ 下执行 npm run native:build（需要 Rust）' } };
  }
}
function systemdStatus(): Dependency {
  const state = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8', timeout: 10_000, cwd: tmpdir() });
  const text = (state.stdout ?? '').trim();
  const ok = /running|degraded/.test(text);
  return { id: 'systemd', name: 'systemd 用户实例', purpose: '监管每个执行单元，并让后台服务随登录启动', required: true, ok,
    detail: ok ? text : text || '不可用', install: { kind: 'manual', hint: '需要 systemd 用户实例；WSL 请在 /etc/wsl.conf 里启用 systemd' } };
}
/** PowerShell 7: on PATH, or where its installer puts it. */
export function pwshPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const installed = join(env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return onPath('pwsh') ?? (existsSync(installed) ? installed : undefined);
}
function pwshVersion(): string | undefined {
  const pwsh = pwshPath();
  return pwsh ? firstLine(pwsh, ['--version']) : undefined;
}
/** Unity Hub where its installer puts it (per machine, or per user). */
export function unityHubPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return [join(env.ProgramFiles || 'C:\\Program Files', 'Unity Hub', 'Unity Hub.exe'),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Unity Hub', 'Unity Hub.exe')] : [])].find(path => existsSync(path));
}
function unityHubStatus(): Dependency {
  const hub = unityHubPath();
  return { id: 'unity-hub', name: 'Unity Hub', purpose: '安装 Unity 编辑器，登录并激活 Unity 许可证', required: false, ok: Boolean(hub),
    detail: hub ?? '未找到', install: { kind: 'system', packages: [['Unity.UnityHub']] } };
}
/** A Unity license on this computer: Hub's entitlement license, or a legacy serial license file. */
export function unityLicensed(env: NodeJS.ProcessEnv = process.env): boolean {
  const hub = join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Unity', 'licenses');
  try { if (readdirSync(hub).some(name => /\.(xml|ulf)$/i.test(name))) return true; } catch { /* no Hub license */ }
  return existsSync(join(env.ProgramData || 'C:\\ProgramData', 'Unity', 'Unity_lic.ulf'));
}
function unityLicenseStatus(): Dependency {
  const ok = unityLicensed();
  return { id: 'unity-license', name: 'Unity 许可证', purpose: 'Unity 编辑器运行需要；免费的 Personal 许可证即可', required: false, ok,
    detail: ok ? '已激活' : '未激活',
    install: { kind: 'manual', hint: '打开 Unity Hub，登录 Unity 账号，在「偏好设置 → 许可证」添加免费的 Personal 许可证' } };
}
function npmStatus(): Dependency {
  const npm = npmCommand();
  let version: string | undefined;
  const cli = npm?.find(part => part.endsWith('npm-cli.js'));
  if (cli) try { version = (JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8')) as { version?: string }).version; } catch { /* unknown */ }
  return { id: 'npm', name: 'npm', purpose: '安装 AI 命令行工具（随 Node.js LTS 一起安装）', required: false, ok: Boolean(npm),
    ...(version ? { version: `npm ${version}` } : {}), detail: npm ? (version ? `npm ${version}` : npm.join(' ')) : '未找到',
    install: { kind: 'system', packages: [['OpenJS.NodeJS.LTS']] } };
}
function unityStatus(config?: { unity?: UnityConfig | null }): Dependency {
  // Found editors are used without being named anywhere, so the hint never sends the person to a settings page.
  const hint = { kind: 'manual' as const, hint: process.platform === 'win32' ? `一键配置会通过 Unity Hub 安装 Unity ${VRCHAT_UNITY_VERSION}`
    : `用 Unity Hub 安装 Unity ${VRCHAT_UNITY_VERSION}；装好后 Harness 会自动找到它` };
  const base = { id: 'unity', name: 'Unity 编辑器', purpose: '工程初始化、构建与回归检查里的 Unity 步骤', required: true, install: hint };
  if (config?.unity) {
    let editor = '', problem: string | undefined;
    try { editor = configuredUnityEditor(config.unity); problem = unityEditorProblem(editor); }
    catch (error) { problem = (error as Error).message; }
    return { ...base, ok: !problem, detail: problem ?? editor, ...(problem ? {} : { version: versionOf(editor) }) };
  }
  const found = findUnityEditors()[0];
  // Before the first setup there is nothing to configure yet: the setup wizard fills in the editor it found, so a
  // found editor is enough. Once Harness is configured without one, the configuration has to name it.
  if (found && !config) return { ...base, ok: true, detail: `找到了 ${found}；完成设置时使用它`, version: versionOf(found) };
  return found
    ? { ...base, ok: false, detail: `未配置；找到了 ${found}`, install: { kind: 'manual', hint: `在设置里把 Unity 编辑器填为 ${found}` } }
    : { ...base, ok: false, detail: '未配置，也没有在 Unity Hub 的安装目录里找到' };
}
function versionOf(editor: string): string | undefined { return /\b\d{4}\.\d+\.\d+[abcfp]\d+\b/.exec(editor)?.[0]; }

export interface InstallPlan {
  /** Resolved package names for one elevated install; empty when nothing is missing or no apt is available. */
  system: string[];
  user: Array<{ id: string; argv: string[]; env?: Record<string, string> }>;
  manual: Array<{ id: string; name: string; hint: string }>;
}
const PACKAGE = /^[a-z0-9][a-z0-9.+-]*$/;
/** Missing dependencies only. A system package with no candidate in the package manager becomes a manual step. */
export function installPlan(deps: Dependency[], candidate: (name: string) => boolean = aptCandidate,
  platform: NodeJS.Platform = process.platform): InstallPlan {
  const plan: InstallPlan = { system: [], user: [], manual: [] };
  if (platform === 'win32') return windowsInstallPlan(deps, candidate === aptCandidate ? () => Boolean(onPath('winget')) : candidate);
  const apt = process.platform === 'linux' && Boolean(onPath('apt-get'));
  for (const item of deps.filter(entry => !entry.ok && entry.install)) {
    const step = item.install!;
    if (step.kind === 'system') {
      for (const alternatives of step.packages) {
        const chosen = apt ? alternatives.find(name => PACKAGE.test(name) && candidate(name)) : undefined;
        if (chosen) plan.system.push(chosen);
        else plan.manual.push({ id: item.id, name: item.name, hint: `用系统的包管理器安装：${alternatives.join(' 或 ')}` });
      }
    } else if (step.kind === 'user') plan.user.push({ id: item.id, argv: step.argv, ...(step.env ? { env: step.env } : {}) });
    else plan.manual.push({ id: item.id, name: item.name, hint: step.hint });
  }
  plan.system = [...new Set(plan.system)];
  return plan;
}
/** Windows: every missing system package through winget, which is part of Windows 10/11 (App Installer). */
function windowsInstallPlan(deps: Dependency[], candidate: (name: string) => boolean): InstallPlan {
  const plan: InstallPlan = { system: [], user: [], manual: [] };
  for (const item of deps.filter(entry => !entry.ok && entry.install)) {
    const step = item.install!;
    if (step.kind === 'system') {
      for (const alternatives of step.packages) {
        const chosen = alternatives.find(name => WINGET_PACKAGE.test(name) && candidate(name));
        if (chosen) plan.system.push(chosen);
        else plan.manual.push({ id: item.id, name: item.name, hint: `需要 Windows 程序包管理器 winget 才能自动安装（${alternatives[0]}）` });
      }
    } else if (step.kind === 'user') plan.user.push({ id: item.id, argv: step.argv, ...(step.env ? { env: step.env } : {}) });
    else plan.manual.push({ id: item.id, name: item.name, hint: step.hint });
  }
  plan.system = [...new Set(plan.system)];
  return plan;
}
/** The machine steps that install these winget packages; refuses an invalid package id before anything is written. */
export function wingetSteps(packages: string[]): MachineStep[] {
  if (packages.some(name => !WINGET_PACKAGE.test(name))) throw new Error('安装计划里有无效的包名');
  return packages.map(name => ({ id: `winget:${name}`, kind: 'winget' as const, package: name }));
}
/**
 * The elevated PowerShell that installs these packages and writes each outcome to `resultFile`: the package part of
 * the machine setup script (windows-setup-script.ts), one UAC prompt for all of them.
 */
export function wingetScript(packages: string[], resultFile: string): string {
  return machineScript(wingetSteps(packages), {}, { statusFile: resultFile });
}
/** Each package's outcome from an elevated run, in the shape the command line and GUI print. */
function wingetResults(packages: string[], run: MachineRun): InstallResult[] {
  return packages.map(name => {
    const item = run.status?.items.find(entry => entry.id === `winget:${name}`);
    const ok = stepSucceeded(item);
    const output = !item || item.status === 'pending' || item.status === 'running'
      ? run.refused ? '没有获得管理员授权，没有安装' : '没有完成（授权被拒绝或安装被中断）'
      : item.code === undefined || item.code === null ? (item.message ?? '') : `退出码 ${item.code}${item.code === WINGET_CODES.updateNotApplicable || item.code === WINGET_CODES.alreadyInstalled ? '（已安装）' : ''}`;
    return { step: `winget：${name}`, ok, output };
  });
}
function aptCandidate(name: string): boolean {
  const policy = spawnSync('apt-cache', ['policy', name], { encoding: 'utf8', timeout: 30_000, cwd: tmpdir(), env: { ...process.env, LC_ALL: 'C' } });
  const line = /Candidate:\s*(\S+)/.exec(policy.stdout ?? '')?.[1];
  return Boolean(line && line !== '(none)');
}

export interface InstallResult { step: string; ok: boolean; output: string }
/**
 * Runs the plan: every system package in one elevated command (a single password prompt), then the user-level
 * steps. The elevation must come from inside the person's session (the GUI host or a terminal): the background
 * Runtime is a systemd user service outside the login session, where polkit may find no agent to ask.
 * Windows' fuller setup (settings, Unity, progress) is windows-setup.ts; this runs the package part of it.
 */
export function runInstallPlan(plan: InstallPlan, options: { elevate?: string; stdio?: 'inherit' | 'pipe' } = {}): InstallResult[] {
  const results: InstallResult[] = [];
  const run = (label: string, command: string, args: string[], env?: Record<string, string>): boolean => {
    const result = spawnSync(command, args, { encoding: 'utf8', stdio: options.stdio ?? 'pipe', timeout: 3_600_000,
      env: { ...process.env, ...env } });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`.trim().slice(-2000);
    const ok = !result.error && result.status === 0;
    results.push({ step: label, ok, output });
    return ok;
  };
  if (plan.system.length && process.platform === 'win32') {
    const installed = wingetResults(plan.system, runMachineStepsSync(wingetSteps(plan.system), {}));
    results.push(...installed);
    if (installed.some(item => !item.ok)) return results;
  } else if (plan.system.length) {
    if (plan.system.some(name => !PACKAGE.test(name))) throw new Error('安装计划里有无效的包名');
    const script = `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ${plan.system.join(' ')}`;
    if (!run(`系统包：${plan.system.join(' ')}`, options.elevate ?? 'pkexec', ['sh', '-c', script])) return results;
  }
  for (const step of plan.user) {
    let argv: string[];
    try { argv = userCommand(step.argv); } catch (error) { results.push({ step: `${step.id}：${step.argv.join(' ')}`, ok: false, output: (error as Error).message }); continue; }
    run(`${step.id}：${step.argv.join(' ')}`, argv[0]!, argv.slice(1), step.env);
  }
  return results;
}

/** The same plan without blocking: the GUI host keeps serving while a package manager works for minutes. */
export async function runInstallPlanAsync(plan: InstallPlan, options: { elevate?: string } = {}): Promise<InstallResult[]> {
  const results: InstallResult[] = [];
  const run = (label: string, command: string, args: string[], env?: Record<string, string>): Promise<boolean> => new Promise(resolve => {
    let output = '';
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-4000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.once('error', error => { results.push({ step: label, ok: false, output: `${output}${String(error)}`.trim().slice(-2000) }); resolve(false); });
    child.once('close', code => { results.push({ step: label, ok: code === 0, output: output.trim().slice(-2000) }); resolve(code === 0); });
  });
  if (plan.system.length && process.platform === 'win32') {
    // The elevated installs take minutes; the GUI host keeps answering meanwhile.
    const installed = wingetResults(plan.system, await runMachineSteps(wingetSteps(plan.system), {}));
    results.push(...installed);
    if (installed.some(item => !item.ok)) return results;
  } else if (plan.system.length) {
    if (plan.system.some(name => !PACKAGE.test(name))) throw new Error('安装计划里有无效的包名');
    const script = `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ${plan.system.join(' ')}`;
    if (!await run(`系统包：${plan.system.join(' ')}`, options.elevate ?? 'pkexec', ['sh', '-c', script])) return results;
  }
  for (const step of plan.user) {
    let argv: string[];
    try { argv = userCommand(step.argv); } catch (error) { results.push({ step: `${step.id}：${step.argv.join(' ')}`, ok: false, output: (error as Error).message }); continue; }
    await run(`${step.id}：${step.argv.join(' ')}`, argv[0]!, argv.slice(1), step.env);
  }
  return results;
}
