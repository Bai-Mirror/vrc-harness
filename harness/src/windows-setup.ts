import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AI_TOOLS, LAYERED_RECOLOR_PINS, pwshPath, unityHubPath, unityLicensed, userCommand, VPM_ENV, type Dependency } from './environment.ts';
import { hostPlatform, windowsPython } from './host-platform.ts';
import { findWindowsUnityEditors, VRCHAT_UNITY_VERSION, windowsUnityRoots } from './unity-editors.ts';
import {
  encodeCommand, powershellEnv, psQuote, runMachineSteps, WINGET_CODES, type MachineRun, type MachineStep, type RunOptions, type ScriptContext,
  type SetupStatus, type StatusItem, type StepStatus,
} from './windows-setup-script.ts';

/**
 * First-run machine setup on Windows, for a computer that was never set up for development: what to install and change
 * (computed from what is on the computer), one elevated run for every machine-level item (windows-setup-script.ts),
 * then the user-level installs, then what only the person can do (sign in to Unity Hub, log in to the AI tools, restart).
 */

/** Unity 2022.3.22f1's changeset, from Unity's release page (unity.com/releases/editor/whats-new/2022.3.22f1) and release API. */
export const UNITY_CHANGESET = '887be4894c44';
/** Download sizes from Unity's release API for 2022.3.22f1 on Windows x64: the editor, and Android support with its child modules. */
export const UNITY_EDITOR_BYTES = 2_812_392_448;
export const UNITY_ANDROID_BYTES = 1_786_111_422;
/** App Installer, which brings winget: its Microsoft Store page and its package family (Microsoft's winget documentation). */
export const APP_INSTALLER_STORE = 'ms-windows-store://pdp/?productid=9NBLGGH4NNS1';
export const APP_INSTALLER_FAMILY = 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe';
/** winget needs Windows 10 1809 (build 17763) or later. */
export const WINGET_MIN_BUILD = 17763;
/** The winget package for each dependency, with its rough download size in MB (the current installers, 09-2026). */
export const WINDOWS_PACKAGES: Record<string, { id: string; name: string; mb: number }> = {
  git: { id: 'Git.Git', name: 'Git', mb: 65 },
  python: { id: 'Python.Python.3.13', name: 'Python 3.13', mb: 30 },
  blender: { id: 'BlenderFoundation.Blender', name: 'Blender（脸型设计）', mb: 400 },
  '7z': { id: '7zip.7zip', name: '7-Zip', mb: 2 },
  dotnet: { id: 'Microsoft.DotNet.SDK.8', name: '.NET 8 SDK', mb: 225 },
  npm: { id: 'OpenJS.NodeJS.LTS', name: 'Node.js LTS（含 npm）', mb: 33 },
  pwsh: { id: 'Microsoft.PowerShell', name: 'PowerShell 7', mb: 118 },
  'unity-hub': { id: 'Unity.UnityHub', name: 'Unity Hub', mb: 185 },
};
/** Rough download size in MB of each AI tool's npm packages for Windows x64. */
const AI_DOWNLOAD_MB: Record<string, number> = { codex: 165, claude: 115, pi: 30 };

/** What the person can switch on or off before starting; everything else the computer needs is always included. */
export interface SetupChoices { utf8: boolean; pythonUtf8: boolean; unity: boolean; android: boolean; defender: boolean;
  codex: boolean; claude: boolean; pi: boolean; blender: boolean }
export const DEFAULT_CHOICES: SetupChoices = { utf8: true, pythonUtf8: true, unity: true, android: false, defender: false,
  codex: true, claude: true, pi: true, blender: false };
/** Choices from a request: booleans only, the rest from the defaults. */
export function setupChoices(value: unknown): SetupChoices {
  const given = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(DEFAULT_CHOICES).map(([key, fallback]) =>
    [key, typeof given[key] === 'boolean' ? given[key] : fallback])) as unknown as SetupChoices;
}

export type PolicyScope = 'MachinePolicy' | 'UserPolicy' | 'Process' | 'CurrentUser' | 'LocalMachine';
export type PolicyScopes = Partial<Record<PolicyScope, string>>;
/** What the plan is computed from. The real probe reads this computer; tests pass their own. */
export interface WindowsProbe {
  /** Windows build number (winget needs 17763 or later). */
  build: number;
  winget?: string;
  powershellPolicy: PolicyScopes;
  pwsh?: string;
  pwshPolicy?: PolicyScopes;
  codePages: { ACP?: string; OEMCP?: string; MACCP?: string };
  /** The ANSI code page the running system uses, which changes only after a restart. */
  activeCodePage?: number;
  longPaths: boolean;
  /** git's system core.longpaths; undefined when git is missing. */
  gitLongPaths?: boolean;
  unityHub?: string;
  unityRoots: string[];
  /** Unity.exe of the version VRChat requires, when installed. */
  unityEditor?: string;
  unityAndroid: boolean;
  unityLicense: boolean;
  hubRunning: boolean;
  /** PYTHONUTF8 is set for the user. */
  pythonUtf8: boolean;
  /** Microsoft Defender's real-time protection is on; undefined when it cannot be read. */
  defender?: boolean;
  workspace: string;
  unityCache: string;
  /** The Python the built-in stage tools run with, when one is present; the layered-recolour deps install into it. */
  python?: string;
  /**
   * Whether Codex reports a login (its Runs use the person's own); undefined when it cannot tell. Claude Code on Windows
   * signs in with a token saved for Harness, which the AI step asks for.
   */
  logins: { codex?: boolean };
}

export interface PlanItem {
  id: string;
  /** Machine items run in the one elevated script; user items after it, without elevation. */
  phase: 'machine' | 'user';
  title: string;
  detail: string;
  /** The dependency row this item installs, if any. */
  dep?: string;
  /** An optional item: included while any of these choices is on. */
  toggles?: Array<keyof SetupChoices>;
  /** Items of this plan that must not fail first. */
  requires?: string[];
  /** Included only while one of these items is: a prerequisite nothing chosen needs is left out. */
  onlyFor?: string[];
  downloadMB?: number;
  /** Takes effect after a restart. */
  restart?: boolean;
  step?: MachineStep;
  argv?: string[];
  env?: Record<string, string>;
}
export type OpenTarget = 'unity-hub' | 'restart' | 'app-installer' | 'winget-register' | 'login:codex';
export const OPEN_TARGETS: OpenTarget[] = ['unity-hub', 'restart', 'app-installer', 'winget-register', 'login:codex'];
/** Something only the person can do, with a button that opens the right place. */
export interface PersonAction {
  id: string; title: string; detail: string; buttons: Array<{ label: string; target: OpenTarget }>;
  /** Shown only while one of these plan items is chosen. */
  when?: string[];
}
export interface WindowsSetupPlan {
  winget: 'ok' | 'missing' | 'unsupported';
  items: PlanItem[];
  /** Needed but impossible here, and why. */
  blocked: Array<{ id: string; title: string; reason: string }>;
  person: PersonAction[];
  context: ScriptContext;
  /** UTF-8 is set in the registry but the running system still uses another code page. */
  restartPending: boolean;
}

const ALLOWS = new Set(['RemoteSigned', 'Unrestricted', 'Bypass']);
/** The policy that applies to the person (the process scope only lives as long as one PowerShell). */
export function effectivePolicy(scopes: PolicyScopes): { policy: string; scope: PolicyScope | 'default' } {
  for (const scope of ['MachinePolicy', 'UserPolicy', 'CurrentUser', 'LocalMachine'] as const) {
    const value = scopes[scope];
    if (value && value !== 'Undefined') return { policy: value, scope };
  }
  return { policy: 'Restricted', scope: 'default' };
}
const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:\\|\\\\[^\\]+\\)/;

/** The plan for this computer: every item that is needed, optional ones marked with their choice. */
export function windowsSetupPlan(deps: Dependency[], probe: WindowsProbe): WindowsSetupPlan {
  const missing = (id: string): Dependency | undefined => deps.find(item => item.id === id && !item.ok);
  const winget = probe.build && probe.build < WINGET_MIN_BUILD ? 'unsupported' : probe.winget ? 'ok' : 'missing';
  const items: PlanItem[] = [], blocked: WindowsSetupPlan['blocked'] = [], person: PersonAction[] = [];
  const machine = (item: Omit<PlanItem, 'phase'>) => items.push({ ...item, phase: 'machine' });
  const user = (item: Omit<PlanItem, 'phase'>) => items.push({ ...item, phase: 'user' });
  const planned = (id: string) => items.some(item => item.id === id);
  const pkg = (dep: string, detail: string, extra: Partial<PlanItem> = {}): string | undefined => {
    const info = WINDOWS_PACKAGES[dep]!, id = `winget:${info.id}`;
    if (winget !== 'ok') { blocked.push({ id, title: `安装 ${info.name}`, reason: '需要 Windows 程序包管理器 winget' }); return undefined; }
    machine({ id, title: `安装 ${info.name}`, detail, dep, downloadMB: info.mb, step: { id, kind: 'winget', package: info.id }, ...extra });
    return id;
  };

  // PowerShell scripts: npm puts a .ps1 beside each command, which PowerShell runs first and Restricted refuses.
  const policy = (shell: 'powershell' | 'pwsh', scopes: PolicyScopes | undefined, name: string) => {
    if (!scopes) return;
    const current = effectivePolicy(scopes);
    if (ALLOWS.has(current.policy)) return;
    const id = `policy:${shell}`, title = shell === 'powershell' ? '允许运行 PowerShell 脚本' : '允许运行 PowerShell 脚本（PowerShell 7）';
    if (current.scope === 'MachinePolicy' || current.scope === 'UserPolicy')
      blocked.push({ id, title, reason: `${name} 的执行策略被组策略设为 ${current.policy}，Harness 不能更改；请联系管理这台电脑的人` });
    else if (current.scope === 'CurrentUser') {
      const program = shell === 'powershell' ? 'powershell.exe' : probe.pwsh!;
      user({ id: `policy-user:${shell}`, title, detail: `你的账户单独把 ${name} 的执行策略设成了 ${current.policy}，它会盖过本机设置；改为 RemoteSigned（只影响你的账户）。`,
        argv: [program, '-NoProfile', '-NonInteractive', '-Command', 'Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force'] });
    } else machine({ id, title, detail: `把 ${name} 的本机执行策略设为 RemoteSigned：本机的脚本可以运行，从网上下载的脚本仍需签名。npm 装的命令（codex、claude、pi）在 PowerShell 里靠它运行。`,
      step: { id, kind: 'policy', shell } });
  };
  policy('powershell', probe.powershellPolicy, 'Windows PowerShell');

  if (!probe.longPaths) machine({ id: 'longpaths', title: '启用长路径支持',
    detail: '允许程序使用超过 260 个字符的路径；Unity 工程和 npm 包的路径常常很长。', step: { id: 'longpaths', kind: 'longpaths' } });
  const utf8 = ['ACP', 'OEMCP', 'MACCP'].every(name => probe.codePages[name as keyof WindowsProbe['codePages']] === '65001');
  if (!utf8) machine({ id: 'utf8', title: '系统级 UTF-8（Beta：使用 Unicode UTF-8 提供全球语言支持）', toggles: ['utf8'], restart: true,
    detail: '命令行和各种工具统一用 UTF-8 处理中文路径与文件名。需要重启电脑后生效；少数不支持 Unicode 的老程序可能显示乱码，可以随时在「区域」设置里关掉这一项。',
    step: { id: 'utf8', kind: 'utf8' } });

  const git = missing('git') ? pkg('git', '每个工程是一个 Git 仓库，改动靠它追溯。') : undefined;
  if (missing('python')) pkg('python', '内置阶段工具用 Python 运行。');
  if (missing('blender')) pkg('blender', '需要设计脸型与补偿表情时安装。Harness 会自动找到并管理它；保留原外形无需安装。', { toggles: ['blender'] });
  if (missing('7z')) pkg('7z', '交付打包与校验。');
  const dotnet = missing('dotnet') ? pkg('dotnet', 'VPM CLI 的运行时。') : undefined;
  const aiMissing = AI_TOOLS.filter(tool => missing(tool.id));
  const node = missing('npm') && aiMissing.length ? pkg('npm', '用来安装 AI 命令行工具。',
    { onlyFor: aiMissing.map(tool => `ai:${tool.id}`) }) : undefined;
  const pwshMissing = Boolean(missing('pwsh'));
  if (pwshMissing) pkg('pwsh', '新版 PowerShell；装好后默认就允许运行本机脚本。');

  // Unity: the editor VRChat requires, through Unity Hub's command line; Hub also signs the person in for a license.
  const editorNeeded = !probe.unityEditor, androidNeeded = !probe.unityAndroid;
  const hubMissing = !probe.unityHub;
  const hub = hubMissing && (editorNeeded || androidNeeded || !probe.unityLicense)
    ? pkg('unity-hub', '安装 Unity 编辑器，登录并激活 Unity 许可证。', probe.unityLicense ? { onlyFor: ['unity-editor', 'unity-android'] } : {})
    : undefined;
  const hubUsable = Boolean(probe.unityHub) || Boolean(hub);
  if (editorNeeded) {
    if (hubUsable) machine({ id: 'unity-editor', title: `安装 Unity ${VRCHAT_UNITY_VERSION}`, dep: 'unity', toggles: ['unity'],
      requires: hub ? [hub] : undefined, downloadMB: Math.round(UNITY_EDITOR_BYTES / 1e6),
      detail: `VRChat 要求的 Unity 版本，经 Unity Hub 下载约 ${gb(UNITY_EDITOR_BYTES)}，装好后约占 5.6 GB。下载可能要几十分钟，进度显示在这里。`,
      step: { id: 'unity-editor', kind: 'unity-editor', totalBytes: UNITY_EDITOR_BYTES, ...(hub ? { requires: [hub] } : {}) } });
    else blocked.push({ id: 'unity-editor', title: `安装 Unity ${VRCHAT_UNITY_VERSION}`, reason: '需要先有 Unity Hub，而 winget 不可用' });
  }
  if (androidNeeded && hubUsable) {
    const requires = [...(hub ? [hub] : []), ...(editorNeeded ? ['unity-editor'] : [])];
    machine({ id: 'unity-android', title: 'Unity 的 Android 构建支持（Quest 版头像）', dep: 'unity', toggles: ['android'],
      requires: requires.length ? requires : undefined, downloadMB: Math.round(UNITY_ANDROID_BYTES / 1e6),
      detail: `给 Quest 版头像构建用，含 OpenJDK 与 Android SDK/NDK，下载约 ${gb(UNITY_ANDROID_BYTES)}。只做 PC 版头像可以不装。`,
      step: { id: 'unity-android', kind: 'unity-android', totalBytes: UNITY_ANDROID_BYTES, ...(requires.length ? { requires } : {}) } });
  }

  if (git || probe.gitLongPaths === false) machine({ id: 'git-longpaths', title: 'Git 支持长路径',
    detail: '在 Git 的系统配置里设置 core.longpaths=true。', requires: git ? [git] : undefined,
    step: { id: 'git-longpaths', kind: 'git-longpaths', ...(git ? { requires: [git] } : {}) } });
  if (!pwshMissing) policy('pwsh', probe.pwshPolicy, 'PowerShell 7');

  // Offered only while Defender is the one scanning (another antivirus has its own settings); off unless chosen.
  if (probe.defender !== false) machine({ id: 'defender', title: 'Microsoft Defender 不扫描 Harness 工作区与 Unity 缓存', toggles: ['defender'],
    detail: `Defender 不再实时扫描 ${probe.workspace} 和 ${probe.unityCache}，Unity 导入和构建会快一些。代价：放进这些目录的恶意文件不会被实时发现。只在你信任放进去的素材时开启。`,
    step: { id: 'defender', kind: 'defender', paths: [probe.workspace, probe.unityCache] } });

  if (!probe.pythonUtf8) user({ id: 'python-utf8', title: 'Python 默认使用 UTF-8', toggles: ['pythonUtf8'],
    detail: '为当前用户设置环境变量 PYTHONUTF8=1，Python 读写文件默认用 UTF-8；之后新打开的程序生效。', argv: ['setx', 'PYTHONUTF8', '1'] });
  if (missing('vpm')) user({ id: 'vpm', title: '安装 VPM CLI', dep: 'vpm', requires: dotnet ? [dotnet] : undefined,
    detail: 'VRChat 官方的包管理命令行工具，装到你自己的用户目录。', argv: ['dotnet', 'tool', 'install', '--global', 'vrchat.vpm.cli'], env: VPM_ENV });
  for (const tool of aiMissing) {
    if (!node && missing('npm')) { blocked.push({ id: `ai:${tool.id}`, title: `安装 ${tool.name}`, reason: '需要 npm（随 Node.js LTS 安装），而 winget 不可用' }); continue; }
    user({ id: `ai:${tool.id}`, title: `安装 ${tool.name}`, dep: tool.id, toggles: [tool.id], requires: node ? [node] : undefined,
      downloadMB: AI_DOWNLOAD_MB[tool.id], detail: `${tool.purpose}。用 npm 装到你自己的用户目录，不需要管理员授权。`,
      argv: ['npm', 'install', '--global', tool.package] });
  }

  // The layered-recolour capability (recolor stage) needs three Python libraries the package does not carry
  // (决定记录 D-77). There is no managed venv and no bundled wheel: the pinned versions go into the person's own
  // site, in the interpreter the built-in stage tools themselves start (windowsPython).
  if (missing('layered-recolor')) {
    const pythonItem = 'winget:Python.Python.3.13';
    const pins = Object.entries(LAYERED_RECOLOR_PINS).map(([name, version]) => `${name}==${version}`);
    if (probe.python || planned(pythonItem))
      user({ id: 'layered-recolor-deps', title: '安装分层改色依赖', dep: 'layered-recolor',
        ...(planned(pythonItem) ? { requires: [pythonItem] } : {}),
        detail: '分层源文件（PSD）的读取与基线核对需要 psd-tools、Pillow、NumPy；按验证过的版本装到你自己的用户目录，不需要管理员授权。',
        argv: [probe.python ?? 'python', '-m', 'pip', 'install', '--user', ...pins] });
    else blocked.push({ id: 'layered-recolor-deps', title: '安装分层改色依赖', reason: '需要先有 Python 3，而 winget 不可用' });
  }

  // What stays with the person.
  if (winget === 'missing') person.push({ id: 'winget', title: '先准备好 Windows 程序包管理器（winget）',
    detail: 'Harness 用 winget 安装 Git、Python 等软件；winget 随 Windows 的「应用安装程序」提供。先试「启用 winget」；不行就在 Microsoft Store 安装或更新「应用安装程序」。完成后点「重新检查」。',
    buttons: [{ label: '启用 winget', target: 'winget-register' }, { label: '打开 Microsoft Store', target: 'app-installer' }] });
  if (winget === 'unsupported') person.push({ id: 'winget', title: '这台 Windows 太旧，不能自动安装软件',
    detail: 'winget 需要 Windows 10 1809 或更新的版本。请先更新 Windows，再回到这里。', buttons: [] });
  if (probe.hubRunning && (planned('unity-editor') || planned('unity-android'))) person.push({ id: 'hub-running', title: '开始前请退出 Unity Hub',
    detail: '安装 Unity 编辑器时 Unity Hub 不能开着：在任务栏右下角的 Unity Hub 图标上右键，选择退出。', buttons: [],
    when: ['unity-editor', 'unity-android'] });
  if (!probe.unityLicense && (probe.unityEditor || planned('unity-editor'))) person.push({ id: 'unity-license', title: '登录 Unity Hub，激活免费的 Personal 许可证',
    detail: 'Unity 编辑器要有许可证才能运行。在 Unity Hub 里用 Unity 账号登录，然后在「偏好设置 → 许可证」添加 Personal 许可证；完成后点「重新检查」。',
    buttons: probe.unityHub ? [{ label: '打开 Unity Hub', target: 'unity-hub' }] : [], ...(probe.unityEditor ? {} : { when: ['unity-editor'] }) });
  const restartPending = utf8 && probe.activeCodePage !== undefined && probe.activeCodePage !== 65001;
  if (restartPending) person.push({ id: 'restart', title: '重启电脑，让 UTF-8 设置生效', detail: '可以先完成设置，之后再重启。',
    buttons: [{ label: '立即重启', target: 'restart' }] });
  if (probe.logins.codex === false) person.push({ id: 'login:codex', title: '登录 Codex', detail: '在打开的窗口里按提示用 ChatGPT 账号登录，完成后关掉窗口。',
    buttons: [{ label: '打开 Codex 登录', target: 'login:codex' }] });

  const context: ScriptContext = { unityVersion: VRCHAT_UNITY_VERSION, unityChangeset: UNITY_CHANGESET,
    unityRoots: probe.unityRoots.filter(root => WINDOWS_ABSOLUTE.test(root)),
    ...(probe.winget && WINDOWS_ABSOLUTE.test(probe.winget) ? { winget: probe.winget } : {}),
    ...(probe.pwsh && WINDOWS_ABSOLUTE.test(probe.pwsh) ? { pwsh: probe.pwsh } : {}),
    ...(probe.unityHub && WINDOWS_ABSOLUTE.test(probe.unityHub) ? { unityHub: probe.unityHub } : {}) };
  // Machine items first (the elevated run), then user items; each kind keeps its order.
  items.sort((a, b) => a.phase === b.phase ? 0 : a.phase === 'machine' ? -1 : 1);
  return { winget, items, blocked, person, context, restartPending };
}

/** The items a run with these choices includes: optional ones by choice, then nothing whose prerequisite was left out. */
export function includedItems<T extends Pick<PlanItem, 'id' | 'toggles' | 'requires' | 'onlyFor'>>(items: T[], choices: Partial<SetupChoices>): T[] {
  const all = new Set(items.map(item => item.id));
  let chosen = items.filter(item => !item.toggles?.length || item.toggles.some(toggle => choices[toggle]));
  for (;;) {
    const ids = new Set(chosen.map(item => item.id));
    const next = chosen.filter(item => (item.requires ?? []).every(need => !all.has(need) || ids.has(need))
      && (!item.onlyFor?.length || item.onlyFor.some(other => ids.has(other))));
    if (next.length === chosen.length) return next;
    chosen = next;
  }
}
/** Totals for the plan as chosen: what needs the one elevation, what does not, the download and whether to restart. */
export function planSummary(plan: WindowsSetupPlan, choices: SetupChoices) {
  const items = includedItems(plan.items, choices);
  return { machine: items.filter(item => item.phase === 'machine'), user: items.filter(item => item.phase === 'user'),
    downloadMB: items.reduce((sum, item) => sum + (item.downloadMB ?? 0), 0), restart: items.some(item => item.restart) };
}

/** Reads what the plan needs from this computer, without changing anything. */
const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$scopes = @{}
foreach ($entry in (Get-ExecutionPolicy -List)) { $scopes[[string]$entry.Scope] = [string]$entry.ExecutionPolicy }
$codePage = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage'
$fileSystem = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem'
$winget = Get-Command winget.exe -CommandType Application | Select-Object -First 1
$defender = $null
$status = Get-MpComputerStatus
if ($status) { $defender = [bool]($status.AMServiceEnabled -and $status.RealTimeProtectionEnabled) }
[ordered]@{
  powershellPolicy = $scopes
  codePages = @{ ACP = [string]$codePage.ACP; OEMCP = [string]$codePage.OEMCP; MACCP = [string]$codePage.MACCP }
  activeCodePage = [Text.Encoding]::Default.CodePage
  longPaths = ([string]$fileSystem.LongPathsEnabled -eq '1')
  winget = $(if ($winget) { $winget.Source } else { $null })
  pythonUtf8 = [bool][Environment]::GetEnvironmentVariable('PYTHONUTF8', 'User')
  hubRunning = [bool](Get-Process -Name 'Unity Hub')
  defender = $defender
} | ConvertTo-Json -Compress -Depth 4
`;
const PWSH_POLICY = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $s = @{}; foreach ($e in (Get-ExecutionPolicy -List)) { $s[[string]$e.Scope] = [string]$e.ExecutionPolicy }; $s | ConvertTo-Json -Compress`;
function powershellJson<T>(program: string, text: string): T | undefined {
  const result = spawnSync(program, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(text)],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true, cwd: tmpdir(), env: powershellEnv() });
  const line = (result.stdout ?? '').split(/\r?\n/).find(item => item.trim().startsWith('{'));
  try { return line ? JSON.parse(line) as T : undefined; } catch { return undefined; }
}
function probeRun(argv: string[]): { ok: boolean; output: string } {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 20_000, windowsHide: true, cwd: tmpdir() });
  return { ok: !result.error && result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}
/** The real probe: one Windows PowerShell for the registry, policies and processes; the rest from the file system. */
export function probeWindowsMachine(deps: Dependency[], config?: { workspaceRoot?: string }, env: NodeJS.ProcessEnv = process.env): WindowsProbe {
  const read = powershellJson<{ powershellPolicy?: PolicyScopes; codePages?: WindowsProbe['codePages']; activeCodePage?: number;
    longPaths?: boolean; winget?: string | null; pythonUtf8?: boolean; hubRunning?: boolean; defender?: boolean | null }>('powershell.exe', PROBE_SCRIPT) ?? {};
  const pwsh = pwshPath(env);
  const editor = findWindowsUnityEditors(env).find(path => path.split(/[\\/]/).includes(VRCHAT_UNITY_VERSION));
  const has = (id: string) => deps.some(item => item.id === id && item.ok);
  const git = has('git') ? hostPlatform.resolveExecutable('git') : undefined;
  const longGit = git ? probeRun([git, 'config', '--system', '--get', 'core.longpaths']) : undefined;
  const command = (name: string) => { const path = hostPlatform.resolveExecutable(name); return path === name ? undefined : path; };
  const logins: WindowsProbe['logins'] = {};
  if (has('codex')) { try { logins.codex = probeRun(userCommand(['codex', 'login', 'status'])).ok; } catch { /* unknown */ } }
  // The layered-recolour dependencies must land in the interpreter the stage tools themselves start.
  const stagePython = has('python') ? windowsPython() : undefined;
  return {
    build: Number(release().split('.')[2]) || 0,
    ...(read.winget ? { winget: read.winget } : command('winget') ? { winget: command('winget')! } : {}),
    powershellPolicy: read.powershellPolicy ?? {},
    ...(pwsh ? { pwsh, pwshPolicy: powershellJson<PolicyScopes>(pwsh, PWSH_POLICY) ?? {} } : {}),
    codePages: read.codePages ?? {},
    ...(read.activeCodePage ? { activeCodePage: read.activeCodePage } : {}),
    longPaths: read.longPaths === true,
    ...(git ? { gitLongPaths: longGit?.ok === true && longGit.output.trim() === 'true' } : {}),
    ...(unityHubPath(env) ? { unityHub: unityHubPath(env)! } : {}),
    unityRoots: windowsUnityRoots(env),
    ...(editor ? { unityEditor: editor } : {}),
    unityAndroid: Boolean(editor && existsSync(join(dirname(editor), 'Data', 'PlaybackEngines', 'AndroidPlayer'))),
    unityLicense: unityLicensed(env),
    hubRunning: read.hubRunning === true,
    pythonUtf8: read.pythonUtf8 === true,
    ...(typeof read.defender === 'boolean' ? { defender: read.defender } : {}),
    workspace: config?.workspaceRoot || join(homedir(), 'avatar-workspace'),
    unityCache: join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Unity', 'cache'),
    ...(stagePython && WINDOWS_ABSOLUTE.test(stagePython) ? { python: stagePython } : {}),
    logins,
  };
}

/** PATH entries from the registry that this process does not have yet, appended; nothing it has changes place. */
export function mergePath(current: string | undefined, machine: string | undefined, user: string | undefined): string {
  const seen = new Set<string>(), parts: string[] = [];
  for (const source of [current, machine, user]) for (const entry of (source ?? '').split(';')) {
    const trimmed = entry.trim(), key = trimmed.replace(/[\\/]+$/, '').toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); parts.push(trimmed); }
  }
  return parts.join(';');
}
const READ_PATHS = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; @{ machine = [Environment]::GetEnvironmentVariable('Path', 'Machine'); user = [Environment]::GetEnvironmentVariable('Path', 'User') } | ConvertTo-Json -Compress`;
/** The Machine and User PATH as the registry has them now (expanded), read without elevation. */
export function registryPaths(): { machine?: string; user?: string } {
  return powershellJson<{ machine?: string; user?: string }>('powershell.exe', READ_PATHS) ?? {};
}
/**
 * After installs, this process's PATH gains what the installers added (Git, Python, npm's user directory), so the new
 * tools are found without restarting Harness.
 */
export function refreshPathFromRegistry(env: NodeJS.ProcessEnv = process.env, read: () => { machine?: string; user?: string } = registryPaths): string {
  const { machine, user } = read();
  const key = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'Path';
  env[key] = mergePath(env[key], machine, user);
  return env[key]!;
}

export interface SetupJobItem { id: string; phase: 'machine' | 'user'; title: string; status: StepStatus; reason?: string; message: string;
  done?: number; total?: number }
export interface SetupJob {
  id: string; dryRun: boolean; state: 'running' | 'done' | 'failed' | 'refused'; phase: 'machine' | 'user' | 'done';
  startedAt: string; finishedAt?: string; restartRequired: boolean; items: SetupJobItem[]; note?: string;
}
export interface SetupRunOptions {
  dryRun?: boolean;
  onUpdate?: (job: SetupJob) => void;
  /** Tests: stand-ins for the elevated run, the user-level commands and the PATH refresh. */
  runMachine?: (steps: MachineStep[], context: ScriptContext, options: RunOptions) => Promise<MachineRun>;
  runCommand?: (argv: string[], env?: Record<string, string>) => Promise<{ code: number | null; output: string }>;
  refreshPath?: () => void;
  rehearse?: Record<string, string[]>;
  elevate?: boolean;
}

const WINGET_FAILURES: Record<number, string> = {
  [WINGET_CODES.downloadFailed]: '下载失败，请检查网络后重试', [WINGET_CODES.noApplicableInstaller]: '没有适合这台电脑的安装包',
  [WINGET_CODES.noPackageFound]: 'winget 里找不到这个软件包', [WINGET_CODES.blockedByPolicy]: '这台电脑的策略禁止安装它',
  [WINGET_CODES.packageInUse]: '程序正在使用，关掉它后重试', [WINGET_CODES.installInProgress]: '另一个安装程序正在运行，等它结束后重试',
  [WINGET_CODES.diskFull]: '磁盘空间不足', [WINGET_CODES.cancelled]: '安装被取消', [WINGET_CODES.rebootToInstall]: '需要先重启电脑，再重新开始',
  [WINGET_CODES.contactSupport]: '安装程序报错',
};
/** A status line in words: what happened to the item, and why when it failed. */
export function statusMessage(item: StatusItem, titles: Map<string, string>): string {
  const message = item.message ?? '';
  switch (item.status) {
    case 'pending': return '等待';
    case 'running': return item.total ? `正在下载与安装：已下载 ${gb(item.done ?? 0)}，共约 ${gb(item.total)}` : '进行中';
    case 'skipped': return item.reason === 'requires' ? `跳过：「${titles.get(message) ?? message}」没有完成` : '已经就绪，跳过';
    case 'done': return item.reason === 'dry-run' ? `演练：将执行 ${message}` : item.reason === 'already' ? '已经装好' : '完成';
    case 'failed': {
      if (item.reason === 'busy') return '没有运行：另一个 Harness 配置正在进行，等它结束后再试';
      if (/^hub-running/.test(message)) return '失败：Unity Hub 正在运行。请先完全退出 Unity Hub（包括任务栏右下角的图标），再重新开始';
      if (/^not-applied/.test(message)) return '失败：命令完成了，但设置没有生效';
      const known = item.code !== null && item.code !== undefined ? WINGET_FAILURES[item.code] : undefined;
      return known ? `失败：${known}（winget 退出码 ${item.code}）` : `失败：${message || '没有完成'}`;
    }
  }
}

/** Runs one user-level command without a shell, from the temporary directory. */
export function runUserCommand(argv: string[], env?: Record<string, string>): Promise<{ code: number | null; output: string }> {
  let command: string[];
  try { command = userCommand(argv); } catch (error) { return Promise.resolve({ code: null, output: (error as Error).message }); }
  // A Windows PowerShell step (the per-user execution policy) must not inherit PowerShell 7's module path.
  const base = /(^|[\\/])powershell(\.exe)?$/i.test(command[0]!) ? powershellEnv() : process.env;
  return new Promise(resolve => {
    let output = '';
    const child = spawn(command[0]!, command.slice(1), { env: { ...base, ...env }, cwd: tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-4000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.once('error', error => resolve({ code: null, output: `${output}${String(error)}` }));
    child.once('close', code => resolve({ code, output }));
  });
}

/**
 * The whole setup as chosen: the machine items in one elevated run (skipped when there are none), then the PATH
 * refresh, then the user items. A declined UAC prompt stops everything; a failed item stops only what needs it.
 */
export async function runWindowsSetup(plan: WindowsSetupPlan, choices: SetupChoices, options: SetupRunOptions = {}): Promise<SetupJob> {
  const dryRun = options.dryRun ?? false;
  const items = includedItems(plan.items, choices);
  const titles = new Map(plan.items.map(item => [item.id, item.title]));
  const job: SetupJob = { id: randomUUID(), dryRun, state: 'running', phase: 'machine', startedAt: new Date().toISOString(), restartRequired: false,
    items: items.map(item => ({ id: item.id, phase: item.phase, title: item.title, status: 'pending', message: '等待',
      ...(item.step?.totalBytes ? { total: item.step.totalBytes } : {}) })) };
  const update = (): void => options.onUpdate?.(structuredClone(job));
  const view = (id: string) => job.items.find(item => item.id === id)!;
  const apply = (status: SetupStatus): void => {
    for (const entry of status.items) {
      const item = job.items.find(candidate => candidate.id === entry.id);
      if (!item) continue;
      item.status = entry.status; item.message = statusMessage(entry, titles);
      if (entry.reason) item.reason = entry.reason;
      if (typeof entry.done === 'number') item.done = entry.done;
      if (typeof entry.total === 'number') item.total = entry.total;
    }
    job.restartRequired = status.restartRequired;
  };
  const finish = (state: SetupJob['state'], note?: string): SetupJob => {
    job.state = state; job.phase = 'done'; job.finishedAt = new Date().toISOString();
    if (note) job.note = note;
    update();
    return job;
  };
  update();
  const machine = items.filter(item => item.phase === 'machine');
  if (machine.length) {
    const run = await (options.runMachine ?? runMachineSteps)(machine.map(item => item.step!), plan.context,
      { dryRun, ...(options.elevate !== undefined ? { elevate: options.elevate } : {}), ...(options.rehearse ? { rehearse: options.rehearse } : {}),
        onStatus: status => { apply(status); update(); } });
    if (run.refused || run.tampered || !run.status) {
      const note = run.refused ? '没有获得管理员授权，什么都没有改动。可以随时重新开始。'
        : run.tampered ? '配置脚本在运行前被改动过，已拒绝运行，什么都没有改动。'
        : `配置脚本没有运行：${run.log.split('\n').filter(Boolean).at(-1) ?? '原因不明'}`;
      for (const item of job.items) { item.status = item.status === 'pending' ? 'skipped' : item.status; item.message = item.status === 'skipped' ? '没有运行' : item.message; }
      return finish(run.refused ? 'refused' : 'failed', note);
    }
    apply(run.status);
    if (run.status.items.length && run.status.items.every(item => item.reason === 'busy')) {
      for (const item of job.items.filter(entry => entry.phase === 'user')) { item.status = 'skipped'; item.message = '没有运行'; }
      return finish('failed', '另一个 Harness 配置正在进行，这次什么都没有改动；等它结束后再试。');
    }
    // An item the script never reached (it stopped early) did not happen.
    for (const item of job.items.filter(entry => entry.phase === 'machine' && (entry.status === 'pending' || entry.status === 'running'))) {
      item.status = 'failed'; item.message = '失败：配置脚本提前结束';
    }
    if (!dryRun) (options.refreshPath ?? (() => { refreshPathFromRegistry(); }))();
  }
  job.phase = 'user';
  update();
  for (const item of items.filter(entry => entry.phase === 'user')) {
    const current = view(item.id);
    const blocker = (item.requires ?? []).find(need => {
      const prior = job.items.find(entry => entry.id === need);
      return prior && (prior.status === 'failed' || (prior.status === 'skipped' && prior.reason === 'requires'));
    });
    if (blocker) { Object.assign(current, { status: 'skipped', reason: 'requires', message: `跳过：「${titles.get(blocker) ?? blocker}」没有完成` }); update(); continue; }
    if (dryRun) { Object.assign(current, { status: 'done', reason: 'dry-run', message: `演练：将执行 ${item.argv!.join(' ')}` }); update(); continue; }
    Object.assign(current, { status: 'running', message: '进行中' }); update();
    const result = await (options.runCommand ?? runUserCommand)(item.argv!, item.env);
    const tail = result.output.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-2).join(' | ');
    Object.assign(current, result.code === 0 ? { status: 'done', reason: 'changed', message: '完成' }
      : { status: 'failed', reason: 'error', message: `失败：${tail || `退出码 ${result.code}`}` });
    if (item.id === 'python-utf8' && result.code === 0) process.env.PYTHONUTF8 = '1';
    update();
  }
  return finish(job.items.some(item => item.status === 'failed') ? 'failed' : 'done');
}

/** The program and arguments that open a place the person needs; nothing is started here. */
export function openCommand(target: OpenTarget, env: NodeJS.ProcessEnv = process.env): { argv: string[]; console?: boolean } {
  const console = (argv: string[]): { argv: string[]; console: boolean } => {
    const program = hostPlatform.resolveExecutable(argv[0]!);
    if (program === argv[0]) throw new Error(`没有找到 ${argv[0]}`);
    const text = `& ${psQuote(program)} ${argv.slice(1).map(psQuote).join(' ')}`.trim();
    return { argv: ['powershell.exe', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(text)], console: true };
  };
  switch (target) {
    case 'unity-hub': { const hub = unityHubPath(env); if (!hub) throw new Error('没有找到 Unity Hub'); return { argv: [hub] }; }
    case 'restart': return { argv: ['shutdown.exe', '/r', '/t', '10', '/c', 'Harness：重启电脑，让 UTF-8 设置生效'] };
    case 'app-installer': return { argv: ['explorer.exe', APP_INSTALLER_STORE] };
    case 'winget-register': return { argv: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      encodeCommand(`Add-AppxPackage -RegisterByFamilyName -MainPackage ${APP_INSTALLER_FAMILY}`)] };
    case 'login:codex': return console(['codex', 'login']);
  }
}
/** Opens it: a program detached from Harness, or a console window for a login; enabling winget is waited for. */
export function openTarget(target: OpenTarget): { ok: boolean; message: string } {
  if (!OPEN_TARGETS.includes(target)) throw new Error('未知的操作');
  const { argv, console } = openCommand(target);
  if (target === 'winget-register') {
    const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 120_000, windowsHide: true, cwd: tmpdir(), env: powershellEnv() });
    return result.status === 0 ? { ok: true, message: '已请求启用 winget；点「重新检查」看看是否可用' }
      : { ok: false, message: '没能启用 winget：请在 Microsoft Store 安装或更新「应用安装程序」' };
  }
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore', cwd: tmpdir(), windowsHide: !console, env: powershellEnv() });
  child.on('error', () => { /* reported by the next check */ });
  child.unref();
  return { ok: true, message: target === 'restart' ? '电脑将在 10 秒后重启' : '已打开' };
}
