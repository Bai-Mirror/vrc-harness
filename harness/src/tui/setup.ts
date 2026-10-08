import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { stringify } from 'yaml';
import { withoutExecutor } from '../shared/subscription.ts';
import { hostPlatform } from '../host-platform.ts';
import { installBundledPack } from '../managed-pack.ts';
import { findUnityEditors, unityEditorProblem } from '../unity-editors.ts';
import { dependencyStatus } from '../environment.ts';
import { withPiChoices, type PiChoice } from '../shared/pi.ts';
import { runCli } from './cli-runner.ts';
import { h, TextPrompt } from './core.ts';

/** How the TUI names installing the background service: a systemd user unit, or a Windows login entry. */
export const SERVICE_INSTALL_LABEL = process.platform === 'win32' ? '设为 Windows 登录后启动' : '安装为 systemd 用户服务';
/**
 * First run: a linear, resumable setup that writes `config/harness.yaml`, checks it with doctor, and starts the
 * background service. Only what the Runtime needs is asked; everything else keeps its default.
 */
export interface EnvCheck { name: string; ok: boolean; detail: string; required: boolean }
/** First run shows the same dependency list as settings; only what cannot be skipped blocks it. */
export function scanEnvironment(): EnvCheck[] {
  // Unity is required for Unity stages but is configured in a later step, so it does not block the first run.
  return dependencyStatus().map(item => ({ name: item.name, ok: item.ok, detail: item.ok ? item.detail : `${item.detail}（${item.purpose}）`,
    required: item.required && ['node', 'git'].includes(item.id) }));
}
export { findProfiles, type Profile } from '../managed-pack.ts';
import { findProfiles, type Profile } from '../managed-pack.ts';
export interface SetupAnswers { workspaceRoot: string; knowledgeRoot: string; toolRoot: string; exportRoot: string;
  profiles: Profile[]; thresholds: string; defaultProfile: string; codex: boolean; claude: boolean;
  assetLibraryRoot?: string; templateProject?: string; contributorName?: string;
  /** Harness starts this Unity executable for Unity steps; without it the config gets no unity section. */
  /** Leaving `lockPath` out lets `loadConfig` name the platform's machine-level batch slot (see config.ts). */
  unity?: { editor: string; lockPath?: string };
  /** Services reached through pi with the person's own API key (stored apart, in config/secrets). */
  pi?: PiChoice[] }
/** Unity licenses live under HOME; a Unity step runs with a private HOME seeded from these when they exist. */
export const UNITY_LICENSE_SEEDS = ['.config/unity3d/Unity/licenses', '.local/share/unity3d/Unity/Unity_lic.ulf'];
/** The same rule loadConfig applies, checked before anything is written. */
export function contributorNameProblem(value: string): string | undefined {
  const name = value.trim();
  return name.length > 64 || /[\u0000-\u001f\u007f]/.test(name) ? '贡献者用户名最多 64 个字符，不能含控制字符' : undefined;
}
export function configDocument(answers: SetupAnswers): Record<string, unknown> {
  const problem = contributorNameProblem(answers.contributorName ?? '');
  if (problem) throw new Error(problem);
  const providers = [
    ...(answers.codex ? [{ id: 'codex', type: 'codex-cli', executable: 'codex', roles: withoutExecutor(['executor', 'diagnostician', 'research']), writable: [] }] : []),
    ...(answers.claude ? [{ id: 'claude', type: 'claude-cli', executable: 'claude', roles: withoutExecutor(['executor', 'diagnostician', 'research']), writable: [] }] : []),
    ...withPiChoices([], answers.pi ?? []),
  ];
  return { workspaceRoot: answers.workspaceRoot, toolRoot: answers.toolRoot, knowledgeRoot: answers.knowledgeRoot,
    workflowVariables: { ...(answers.assetLibraryRoot ? { assetLibrary: answers.assetLibraryRoot } : {}),
      ...(answers.templateProject ? { templateProject: answers.templateProject } : {}) },
    exportRoots: [answers.exportRoot],
    // Early in the document, so the summary page still shows it on a short terminal.
    ...(answers.contributorName?.trim() ? { contributorName: answers.contributorName.trim() } : {}),
    knownBodies: [], projectAliases: {}, sampleNames: [],
    defaultProfile: answers.defaultProfile,
    processDefinitions: Object.fromEntries(answers.profiles.map(profile => [profile.id,
      profile.capabilities ? { definition: profile.definition, capabilities: profile.capabilities } : profile.definition])),
    thresholdsFile: answers.thresholds, providers,
    ...(answers.unity ? { unity: { editor: answers.unity.editor,
      ...(answers.unity.lockPath ? { lockPath: answers.unity.lockPath } : {}),
      homeSeedFrom: UNITY_LICENSE_SEEDS, passEnv: ['DISPLAY', 'WAYLAND_DISPLAY', 'PATH', 'LANG', 'XDG_RUNTIME_DIR'] } } : {}) };
}

type Step = 'welcome' | 'scan' | 'workspace' | 'export' | 'unity' | 'template' | 'ai' | 'contributor' | 'summary' | 'doctor' | 'service';
// Unity is launched by the Linux launcher for now; elsewhere the step is skipped and Unity is configured later.
const ORDER: Step[] = (['welcome', 'scan', 'workspace', 'export', 'unity', 'ai', 'contributor', 'summary', 'doctor', 'service'] as Step[])
  .filter(step => step !== 'unity' || process.platform === 'linux' || process.platform === 'win32');
const TITLES: Record<Step, string> = { welcome: '欢迎', scan: '检查环境', workspace: '工作区', export: '交付目录',
  unity: 'Unity', template: '基准工程', ai: 'AI 执行方', contributor: '贡献者', summary: '确认配置', doctor: '检查配置', service: '后台服务' };
function expand(path: string): string { return resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path); }

export function SetupWizard(props: { home: string; onDone(): void }): ReactNode {
  const app = useApp();
  const size = useWindowSize();
  const rows = Math.max(16, size?.rows ?? 24);
  const [step, setStep] = useState<Step>('welcome');
  const [env, setEnv] = useState<EnvCheck[]>([]);
  const [answers, setAnswers] = useState<Partial<SetupAnswers> & { unityEditor?: string }>({});
  const [error, setError] = useState<string>();
  const [doctor, setDoctor] = useState<{ ok: boolean; lines: string[] }>();
  const [busy, setBusy] = useState<string>();
  const next = () => { setError(undefined); setStep(ORDER[ORDER.indexOf(step) + 1]!); };
  const previous = (from: Step): Step => ORDER[Math.max(0, ORDER.indexOf(from) - 1)]!;
  useEffect(() => {
    try {
      const managed=installBundledPack(props.home),found=findProfiles(managed.knowledgeRoot),formal=found.profiles.find(profile=>profile.capabilities)??found.profiles[0];
      if(!formal||!found.thresholds)throw new Error('托管规则包缺少可运行流程或阈值表');
      setAnswers(previous=>({...previous,knowledgeRoot:managed.knowledgeRoot,toolRoot:managed.toolRoot,profiles:found.profiles,
        thresholds:found.thresholds!,defaultProfile:formal.id}));
    } catch(cause){setError((cause as Error).message);}
  },[]);
  useEffect(() => { if (step === 'scan' && !env.length) setEnv(scanEnvironment()); }, [step]);
  useEffect(() => {
    if (step !== 'ai') return;
    setAnswers(previous => ({ ...previous, codex: previous.codex ?? env.some(item => item.name === 'Codex CLI' && item.ok),
      claude: previous.claude ?? env.some(item => item.name === 'Claude Code' && item.ok) }));
  }, [step]);

  const directory = (key: 'workspaceRoot' | 'exportRoot', create: boolean) => (value: string) => {
    const path = expand(value);
    if (!isAbsolute(path)) { setError('请填写绝对路径'); return; }
    if (!existsSync(path)) {
      if (!create) { setError(`目录不存在：${path}`); return; }
      mkdirSync(path, { recursive: true });
    }
    if (!statSync(path).isDirectory()) { setError(`不是目录：${path}`); return; }
    setAnswers(previous => ({ ...previous, [key]: path }));
    next();
  };
  // The summary shows exactly what write() saves.
  const documentFor = (): Record<string, unknown> => configDocument({ ...answers,
    // As in the GUI: BOOTH files the built-in process reads are cached here, which its tools reach as {assetLibrary}.
    assetLibraryRoot: answers.assetLibraryRoot ?? join(props.home, 'materialized', 'assets'), unity: answers.unityEditor
    ? { editor: answers.unityEditor } : undefined } as SetupAnswers);
  const write = async () => {
    const document = documentFor();
    for (const name of ['config', 'state', 'reports', 'runs', 'materialized/assets']) hostPlatform.mkdirPrivate(join(props.home, name));
    hostPlatform.writePrivate(join(props.home, 'config', 'harness.yaml'), `# 由首次配置向导生成；可再运行 avh tui 或手工编辑。\n${stringify(document)}`);
    next();
    setBusy('正在运行 doctor…');
    const result = await runCli(['doctor'], props.home);
    setBusy(undefined);
    setDoctor({ ok: result.status === 0, lines: result.output.split('\n').filter(Boolean) });
  };
  const startService = async (install: boolean) => {
    setBusy(install ? `正在${SERVICE_INSTALL_LABEL}并启动…` : '正在启动后台服务…');
    const result = await runCli(['service', install ? 'install' : 'start'], props.home);
    setBusy(undefined);
    if (result.status === 0) props.onDone(); else setError(result.output.replace(/^avh: /, ''));
  };
  useInput((input, key) => {
    if (busy) return;
    if (step === 'welcome') { if (key.return) next(); else if (input === 'q') app.exit(); }
    else if (step === 'scan') { if (key.return && env.filter(item => item.required).every(item => item.ok)) next(); else if (input === 'q') app.exit(); }
    else if (step === 'ai') {
      if (input === 'c') setAnswers(previous => ({ ...previous, codex: !previous.codex }));
      else if (input === 'l') setAnswers(previous => ({ ...previous, claude: !previous.claude }));
      else if (key.return) next();
      else if (key.escape) setStep(previous('ai'));
    } else if (step === 'summary') { if (key.return) void write(); else if (key.escape) setStep('workspace'); }
    else if (step === 'doctor') { if (key.return) next(); else if (input === 'e') setStep('workspace'); }
    else if (step === 'service') {
      if (input === 's') void startService(false); else if (input === 'i') void startService(true); else if (input === 'q') app.exit();
    }
  }, { isActive: !['workspace', 'export', 'unity', 'template', 'contributor'].includes(step) });

  const header = h(Box, null, h(Text, { bold: true, color: 'cyan' }, 'Harness 首次配置  '),
    h(Text, { dimColor: true }, `第 ${ORDER.indexOf(step) + 1}/${ORDER.length} 步 · ${TITLES[step]}`));
  const promptRow = 4;
  // Keyed by label: TextPrompt keeps what was typed, so the next step's prompt must be a new instance.
  const prompt = (label: string, initial: string, onSubmit: (value: string) => void, back: Step, allowEmpty = false) =>
    h(TextPrompt, { key: label, label, initial, row: promptRow, onSubmit, onCancel: () => setStep(back), allowEmpty });
  let body: ReactNode;
  if (step === 'welcome') body = h(Box, { flexDirection: 'column' },
    h(Text, null, '接下来只设置工程目录、交付目录和 AI 执行方。制作规则与执行工具由 Harness 自己托管和版本化。'),
    h(Text, { dimColor: true }, `配置写在 ${join(props.home, 'config', 'harness.yaml')}，只有你能读。`),
    h(Text, null, h(Text, { color: 'cyan', bold: true }, '[Enter] '), '开始   ', h(Text, { color: 'cyan', bold: true }, '[q] '), '退出'));
  else if (step === 'scan') body = h(Box, { flexDirection: 'column' },
    ...env.map(item => h(Box, { key: item.name }, h(Box, { width: 4 }, h(Text, { color: item.ok ? 'green' : item.required ? 'red' : 'yellow' }, item.ok ? '✓' : item.required ? '✗' : '!')),
      h(Box, { width: 18 }, h(Text, null, item.name)), h(Text, { dimColor: true, wrap: 'truncate-end' }, item.detail))),
    env.filter(item => item.required).every(item => item.ok) ? h(Text, null, h(Text, { color: 'cyan', bold: true }, '[Enter] '), '继续')
      : h(Text, { color: 'red' }, '缺少必需组件，安装后重新打开 avh tui。 [q] 退出'));
  else if (step === 'workspace') body = prompt('工作区目录：', answers.workspaceRoot ?? join(homedir(), 'avatar-workspace'), directory('workspaceRoot', true), 'scan');
  else if (step === 'export') body = prompt('交付导出目录：', answers.exportRoot ?? join(homedir(), 'avatar-exports'), directory('exportRoot', true), 'workspace');
  // The prompt stays the first line: TextPrompt places the terminal cursor on promptRow.
  else if (step === 'unity') body = h(Box, { flexDirection: 'column' },
    prompt('Unity 编辑器（可留空）：', answers.unityEditor ?? findUnityEditors()[0] ?? '', value => {
      const editor = value.trim() ? expand(value.trim()) : '';
      const problem = editor ? unityEditorProblem(editor) : undefined;
      if (problem) { setError(problem); return; }
      setAnswers(previous => ({ ...previous, unityEditor: editor || undefined })); next();
    }, 'export', true),
    h(Text, { dimColor: true }, 'VRChat 头像用 Unity 2022.3.22f1。留空则先不配置 Unity 步骤：含 Unity 步骤的流程会在创建时说明缺什么。'));
  else if (step === 'template') body = h(Box, { flexDirection: 'column' },
    prompt('Unity 基准工程（可留空）：', answers.templateProject ?? process.env.AVH_TEMPLATE_PROJECT ?? '', value => {
      const path = value.trim() ? expand(value.trim()) : '';
      if (path && (!existsSync(path) || !statSync(path).isDirectory())) { setError(`目录不存在：${path}`); return; }
      setAnswers(previous => ({ ...previous, templateProject: path || undefined })); next();
    }, previous('template'), true),
    h(Text, { dimColor: true }, '默认由 Harness 获取固定版本的官方环境。自定义模板仅用于高级覆盖，并会先检查版本与依赖。'));
  else if (step === 'contributor') body = h(Box, { flexDirection: 'column' },
    prompt('贡献者用户名（可留空）：', answers.contributorName ?? '', value => {
      const problem = contributorNameProblem(value);
      if (problem) { setError(problem); return; }
      setAnswers(previous => ({ ...previous, contributorName: value.trim() })); next();
    }, 'ai', true),
    h(Text, { dimColor: true }, '本地保存的可选署名；默认技术报告只发送结构化结果，不附带署名。'));
  else if (step === 'ai') body = h(Box, { flexDirection: 'column' },
    h(Text, null, '选择要使用的执行方（至少一个；登录在各自的 CLI 里完成）：'),
    h(Text, null, h(Text, { color: 'cyan', bold: true }, '[c] '), `${answers.codex ? '☑' : '☐'} Codex CLI（执行与研究）`),
    h(Text, null, h(Text, { color: 'cyan', bold: true }, '[l] '), `${answers.claude ? '☑' : '☐'} Claude Code CLI（研究）`),
    !answers.codex && !answers.claude ? h(Text, { color: 'yellow' }, '没有执行方时，需要 AI 的阶段不会开始。') : null,
    h(Text, null, h(Text, { color: 'cyan', bold: true }, '[Enter] '), '继续   ', h(Text, { color: 'cyan', bold: true }, '[Esc] '), '上一步'));
  else if (step === 'summary') body = h(Box, { flexDirection: 'column', height: rows - 6, overflow: 'hidden' },
    ...stringify(documentFor()).trimEnd().split('\n').slice(0, rows - 9).map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, line)),
    h(Text, null, h(Text, { color: 'cyan', bold: true }, '[Enter] '), '写入配置并检查   ', h(Text, { color: 'cyan', bold: true }, '[Esc] '), '从头修改'));
  else if (step === 'doctor') body = h(Box, { flexDirection: 'column' },
    ...(doctor?.lines ?? []).slice(0, rows - 9).map((line, i) => { const [status, name, detail] = line.split('\t');
      return h(Box, { key: i }, h(Box, { width: 8 }, h(Text, { color: status === 'OK' ? 'green' : status === 'FAIL' ? 'red' : 'yellow' }, status)),
        h(Box, { width: 18 }, h(Text, null, name ?? '')), h(Text, { dimColor: true, wrap: 'truncate-end' }, detail ?? '')); }),
    doctor ? h(Text, null, doctor.ok ? '配置可用。' : h(Text, { color: 'red' }, '有检查未通过：可返回修改，或继续（相关功能会不可用）。'),
      h(Text, { color: 'cyan', bold: true }, '  [Enter] '), '继续  ', h(Text, { color: 'cyan', bold: true }, '[e] '), '修改') : null);
  else body = h(Box, { flexDirection: 'column' },
    h(Text, null, '最后启动后台服务：它负责调度任务，关掉界面后继续工作。'),
    h(Text, null, h(Text, { color: 'cyan', bold: true }, '[s] '), '现在启动（本次登录期间）'),
    h(Text, null, h(Text, { color: 'cyan', bold: true }, '[i] '), `${SERVICE_INSTALL_LABEL}（登录后自动运行）`),
    h(Text, null, h(Text, { color: 'cyan', bold: true }, '[q] '), '稍后再说（退出）'));
  return h(Box, { flexDirection: 'column', padding: 1 }, header, h(Text, null, ' '), body,
    busy ? h(Text, { color: 'cyan' }, busy) : null, error ? h(Text, { color: 'red', wrap: 'wrap' }, error) : null);
}
