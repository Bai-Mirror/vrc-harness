import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { DatabaseSync } from 'node:sqlite';
import { avhHome, loadConfig, unitySlotsSetting, type LocalConfig } from './config.ts';
import type { ContributionTrace } from './contribution-trace.ts';
import { harnessVersion, knowledgeVersion, interpretationHash, packageVersion } from './provenance.ts';
import { openDatabase, SCHEMA_VERSION } from './state/db.ts';
import { getImportReport, handoffMarkdown, importProject } from './import/index.ts';
import type { ImportReport, ProjectKind } from './import/types.ts';
import { probeBwrap } from './exec/sandbox.ts';
import { preflightWindowsDirectories, probeLowIntegrity } from './exec/windows-boundary.ts';
import { windowsHelper } from './exec/windows-helper.ts';
import { unsupportedAdapter } from './providers/registry.ts';
import { claudeUsesSavedCredential } from './providers/claude.ts';
import { configuredUnityEditor } from './exec/unity-launcher.ts';
import { unityEditorProblem } from './unity-editors.ts';
import { cancel, gateDecide, gateList, projectTaskBrief, providerList, serve, taskAcceptChanges, taskAdd, taskGates, taskList, taskRecover, taskRedo, taskShow, warningAccept, warningList } from './task-cli.ts';
import { knowledgeCommand } from './knowledge-cli.ts';
import { cancelWorkflow, createProject, createWorkflow, decideFormalGate, isFormalWorkflow, resolveWorkflowId, workflowSnapshot } from './workflow/runtime.ts';
import { parseInputHashes } from './workflow/inputs.ts';
import { stageContractView, selectStageContract } from './workflow/stage-contract.ts';
import { archiveStatus, checkProjectArchive, type ArchiveWriteResult } from './archive/projection.ts';
import { archiveSafePoint } from './archive/refresh.ts';
import { projectRoot } from './archive/takeover.ts';
import { describeWorkflow, listWorkflows, type WorkflowView } from './workflow/view.ts';
import { runService } from './api/server.ts';
import { ApiClient } from './api/client.ts';
import { ServiceManager } from './service/manager.ts';
import { hostPlatform, rejectCloudSyncedPath, type HostPlatform } from './host-platform.ts';

const kinds: ProjectKind[] = ['client', 'private', 'history', 'sample'];
function usage(): never { throw new Error('用法: avh [tui] | avh gui [install|uninstall] [--no-open] [--port 端口] | avh --version | workspace init | doctor | deps [install] [--dry-run] [--no-utf8] [--no-python-utf8] [--no-unity] [--android] [--defender] [--without codex,claude,pi] | update check [--channel dev|stable] | update knowledge [--channel dev] [--install <发行 id>] | provider list [--probe] | project new <名称> | project import|import-all|list|brief | project archive <项目> [--check] [--json] | project share <项目> --purpose self|others [--layers A,B,C] [--include <可选项>]... [--exclude <可选项>]... [--permitted-only] [--acknowledge <路径>]... [--name <名称>] [--recipient <收件人>] [--out <文件.7z>] [--dry-run] [--unity-check] [--json] | project diagnose <项目> [--out <目录>] [--since <时间>] [--preview] [--json] [--progress] [--expect-digest <摘要>] [--generated-at <时间>] | project restore <分享包> [--check] [--as-copy] [--name <目录名>] [--allow-network] [--expect new|update|same|conflict] [--json] | project restore --complete <项目> | project conversation <项目> --search <文本> | task add <项目> --spec <YAML> | task list [--project 项目] | task show <id> | task accept-changes <id> --note 文本 [--path 路径]... | task redo <id> [--note 修改意见] | task recover <id> --no-side-effects|--reconciled --note 文本 [--force] | workflow create <项目> --profile <流程> [--manifest <YAML>] [--candidate-pack <id>] | workflow stage-tool show|select <id> --stage <阶段> --pack <版本> [--expect-token <token> --note <说明>] | workflow list | workflow show <id> | workflow cancel <id> --note 文本 | service run|start|stop|status|install|uninstall [--interval 毫秒] | managed list|install|activate <id>|trace --receipt <回执 id>|--candidate <候选 id> | serve [--once] [--interval 毫秒] | gate list|approve|reject <id> [--note 文本] [--expect-hash 哈希] | warning list | warning accept <workflow-id>:<check-id> --note 文本 [--expect-verdict 结论 id] | cancel <task|run id> | knowledge check <知识根> | knowledge annotate <文件> --sop-editorial [--write] | assets list|facets|show|assign|avatar|review|taxonomy|dictionary|refresh（详见 docs/cli.md） | booth sync [--deep] [--json] | booth pool [--json] | booth pool pin|unpin <版本> | booth pool remove <版本>... [--dry-run] | booth plan release <计划 id>'); }
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(`${name}: 缺少参数`);
  const value = args[i + 1]!;
  args.splice(i, 2);
  return value;
}
function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
function noExtra(args: string[]): void { if (args.length) throw new Error(`未知参数: ${args.join(' ')}`); }
/**
 * DATA/D8: one contributed case, from the receipt the server returned to the signed release that accepted it and
 * the version installed here. An incomplete chain says where it stops instead of reading as a failure, because a
 * receipt is not an adoption and an installation is not an acceptance.
 */
export function contributionTraceText(trace: ContributionTrace & { refresh?: { recorded: number; error?: string } }): string {
  const when = (value: string | null) => value ? value.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—';
  const lines = [
    `回执\t${trace.receiptId ?? '—'}\t提交 ${when(trace.submittedAt)}`,
    `候选\t${trace.candidateId}`,
    `评测\t${trace.evaluationId}`,
    trace.release
      ? `发行\t${trace.release.releaseId}\t${trace.release.packId} ${trace.release.version}\t${trace.release.status}\t安装 ${when(trace.release.installedAt)} · 启用 ${when(trace.release.activatedAt)}`
      : `发行\t—\t服务端还没有报告这条回执被纳入某个签名发行`,
    trace.installed
      ? `本机\t${trace.installed.packId} ${trace.installed.version}\t${trace.installed.active ? '当前启用' : '已安装但未启用'}`
      : '本机\t—\t这个能力包还没有安装到本机',
    `追溯\t${trace.complete ? '完整：回执 → 候选 → 评测 → 发行 → 本机版本' : '只到评测：还缺「发行」这一段'}`,
  ];
  if (trace.refresh) lines.push(trace.refresh.error
    ? `读取服务端\t失败（${trace.refresh.error}）；下面的链取自本机已记录的事实`
    : `读取服务端\t新记录 ${trace.refresh.recorded} 条采纳`);
  return lines.join('\n');
}
function init(host: HostPlatform = hostPlatform): void {
  const home = avhHome();
  rejectCloudSyncedPath(home, host);
  for (const name of ['config', 'state', 'reports', 'runs']) host.mkdirPrivate(join(home, name));
  const path = join(home, 'config/harness.yaml');
  if (existsSync(path)) { console.log(`配置已存在，未覆盖: ${path}`); return; }
  const example = {
    workspaceRoot: '/path/to/avatar-workspace', toolRoot: '/path/to/avatar-workspace/tools',
    knowledgeRoot: '/path/to/knowledge', exportRoots: ['/path/to/delivery'],
    knownBodies: ['ExampleBody'], projectAliases: { 'ExampleProject': ['ExampleAlias'] }, sampleNames: ['ExampleSample'],
    stateDbPath: 'state/harness.db', defaultProfile: 'example-flow',
    processDefinitions: { 'example-flow': { definition: 'process/example-flow.yaml', stageRules: 'process/example-flow-stage-rules.yaml' } },
    thresholdsFile: 'thresholds.yaml',
    // An example of the shape, not a recommendation of a route. A subscription CLI must not hold the
    // executor role (decisions D-34 and D-8); the product's execution route is an API provider, which
    // setup writes into the real configuration together with the person's key.
    providers: [{ id: 'local-codex', type: 'codex-cli', executable: 'codex', roles: ['research'], maxConcurrentRuns: 1,
      writable: [] }],
    import: { historicalDir: '_历史工程', clientPattern: '^COMM-([0-9a-fA-F]{8})_.+$', privatePattern: '^([^_]+)_([^_]+)_([0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$' },
  };
  host.writePrivate(path, `# 填写本机路径；流程、阈值和阶段规则文件位于 knowledgeRoot。\n${stringify(example)}`, { flag: 'wx' });
  console.log(`已创建配置模板: ${path}`);
}
async function doctor(host: HostPlatform = hostPlatform): Promise<void> {
  rejectCloudSyncedPath(avhHome(), host);
  let failed = false;
  const report = (name: string, ok: boolean, detail: string): void => { console.log(`${ok ? 'OK' : 'FAIL'}\t${name}\t${detail}`); if (!ok) failed = true; };
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 24;
  report('Node', nodeOk, process.version);
  try { const db = new DatabaseSync(':memory:'); db.close(); report('node:sqlite', true, '可用'); }
  catch (error) { report('node:sqlite', false, String(error)); }
  // Windows: the helper supervises every Run and draws its write boundary; nothing runs without it.
  if (process.platform === 'win32') {
    try { report('Windows 辅助程序', true, windowsHelper()); }
    catch (error) { report('Windows 辅助程序', false, (error as Error).message); }
  }
  // How many Unity editors this machine may run at once, and who decided it: a person who set AVH_UNITY_SLOTS needs to
  // see that it was read, and a typo has to fail here rather than in the middle of a Run.
  try {
    const slots = unitySlotsSetting();
    report('Unity 槽位', true, `${slots.count} 个（${slots.source === 'env' ? '环境变量 AVH_UNITY_SLOTS' : '缺省'}）`);
  } catch (error) { report('Unity 槽位', false, (error as Error).message); }
  // A Windows Claude Run has a configuration directory of its own (providers/claude.ts): ~/.claude never reaches it.
  const claudeOwnConfiguration = claudeUsesSavedCredential();
  const instructions: Array<[string, string]> = [['Codex', join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'AGENTS.md')]];
  if (!claudeOwnConfiguration) instructions.push(['Claude', join(homedir(), '.claude', 'CLAUDE.md')]);
  for (const [name, path] of instructions) if (existsSync(path)) console.log(`NOTICE\t全局指令\t这个文件会影响每个 ${name} 任务：${path}`);
  try {
    const config = loadConfig();
    report('配置', true, join(config.home, 'config/harness.yaml'));
    if (process.platform === 'win32') {
      try { preflightWindowsDirectories(config.home, config.workspaceRoot); report('工作目录安全标签', true, 'HOME 与实际工作区检查通过'); }
      catch (error) { report('工作目录安全标签', false, (error as Error).message); }
    }
    report('工具根', true, config.toolRoot);
    report('知识层', true, `${config.knowledgeRoot}; 流程 ${Object.keys(config.definitions).join(', ')}`);
    for (const line of providerList(config, true).split('\n').slice(1)) {
      const [id, type, , version, auth, quota, health, sandbox] = line.split('\t');
      const unsupported = unsupportedAdapter(type as Parameters<typeof unsupportedAdapter>[0]);
      if (unsupported) { console.log(`NOTICE\tProvider ${id}\t${unsupported}`); continue; }
      const credential = type === 'claude-cli' && claudeOwnConfiguration && auth === 'missing'
        ? '；Windows 上 Claude Code 用你为 Harness 保存的长期令牌或 Anthropic API Key 登录，还没有保存：在 GUI 的设置 → 配置管理里保存' : '';
      report(`Provider ${id}`, health === 'ready', `version=${version}; login=${auth}; quota=${quota}; sandbox=${sandbox}${credential}`);
    }
    if (!config.providers.length) console.log('UNKNOWN\tProvider\t未声明 Provider');
    const needsUnity = Object.values(config.capabilities).some(manifest => Object.values(manifest.stages).some(stage => stage.unitySteps?.length));
    if (config.unity) {
      let editor = '', problem: string | undefined;
      try { editor = configuredUnityEditor(config.unity); problem = unityEditorProblem(editor); }
      catch (error) { problem = (error as Error).message; }
      report('Unity 编辑器', !problem, problem ?? editor);
    } else if (needsUnity) console.log('NOTICE\tUnity 编辑器\t未配置：含 Unity 步骤的流程不能创建；在设置里填写 Unity 编辑器（GUI 设置 → 配置管理；TUI 服务页按 e）');
    const scratch = mkdtempSync(join(tmpdir(), 'avh-doctor-'));
    try {
      const project = join(scratch, 'project'); const run = join(scratch, 'run');
      mkdirSync(project); mkdirSync(run);
      // Windows draws the boundary with a restricted Low integrity token instead of bwrap.
      const probe = process.platform === 'win32' ? probeLowIntegrity() : probeBwrap(project, run, []);
      // Tool stages require a preventing sandbox, so on Linux (and Windows) a missing one means they cannot run at all.
      const detail = probe.available ? `OS 级隔离可用（临时目录探测${process.platform === 'win32' ? '，Low 完整性' : ''}）`
        : `仅越界扫描；${probe.reason ?? 'OS 级隔离不可用'}`;
      if (process.platform === 'linux' || process.platform === 'win32') report('执行器写范围', probe.available, detail);
      else console.log(`NOTICE\t执行器写范围\t${detail}（这个平台的隔离尚未实现）`);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  } catch (error) { report('配置/工具/知识层', false, String(error)); }
  if (process.platform === 'win32') {
    const status = await new ServiceManager(avhHome()).status();
    console.log(`${status.running ? 'OK' : 'NOTICE'}\t后台服务\t${status.running ? `运行中（${status.endpoint}）` : '未运行：avh service start 或 avh service install'}` +
      `；${status.unit?.installed ? '登录后自动启动' : '未设为登录后自动启动'}`);
  } else {
    const status = await new ServiceManager(avhHome()).status();
    console.log(`${status.running ? 'OK' : 'NOTICE'}\t后台服务\t${status.running ? `运行中（${status.endpoint}）` : '未运行：avh service start 或 avh service install'}` +
      `${status.unit ? `；systemd 用户单元${status.unit.installed ? (status.unit.enabled ? '已启用' : '已安装未启用') : '未安装'}` : '；无 systemd 用户实例'}`);
    if (status.unit?.installed && status.linger === false)
      console.log('NOTICE\t后台服务\t注销后用户服务会停止；要让任务在注销后继续，请运行 loginctl enable-linger');
  }
  if (failed) process.exitCode = 1;
}
/**
 * Lists the host dependencies; with install, fetches the missing ones: system packages in one elevated step. On Windows
 * the plan is the whole machine setup (windows-setup.ts); `--dry-run` shows what it would do and changes nothing.
 */
async function deps(install: boolean, args: string[]): Promise<void> {
  const dryRun = flag(args, '--dry-run');
  const windows = process.platform === 'win32';
  const choices = windows ? windowsChoices(args) : undefined;
  noExtra(args);
  const { dependencyStatus, installPlan, runInstallPlan } = await import('./environment.ts');
  let config: LocalConfig | undefined;
  try { config = loadConfig(); } catch { /* No configuration yet: Unity shows as not configured. */ }
  const list = dependencyStatus(config);
  for (const item of list) console.log(`${item.ok ? 'OK' : item.required ? 'MISSING' : 'OPTIONAL'}\t${item.name}\t${item.detail}\t${item.purpose}`);
  if (choices) { await windowsDeps(list, config, install, dryRun, choices); return; }
  const plan = installPlan(list);
  if (plan.system.length) console.log(`\n一次提权安装的系统包：${plan.system.join(' ')}`);
  for (const step of plan.user) console.log(`用户级安装：${step.argv.join(' ')}`);
  for (const step of plan.manual) console.log(`需要手动：${step.name}：${step.hint}`);
  if (!install) { if (plan.system.length || plan.user.length) console.log('\n运行 avh deps install 一次装齐（系统包会请求一次管理员授权）。'); return; }
  if (!plan.system.length && !plan.user.length) { console.log('\n没有可以自动安装的缺失项。'); return; }
  if (dryRun) { console.log('\n演练：没有安装任何东西。实际安装时，系统包在一次 pkexec 授权里由 apt-get 安装，之后运行上面的用户级安装。'); return; }
  const results = runInstallPlan(plan, { stdio: 'inherit' });
  for (const result of results) console.log(`${result.ok ? 'OK' : 'FAIL'}\t${result.step}`);
  if (results.some(result => !result.ok)) process.exitCode = 1;
}
/** `avh deps` switches for the optional parts of Windows setup. */
function windowsChoices(args: string[]): import('./windows-setup.ts').SetupChoices {
  const without = (option(args, '--without') ?? '').split(',').map(name => name.trim()).filter(Boolean);
  const unknown = without.filter(name => !['codex', 'claude', 'pi'].includes(name));
  if (unknown.length) throw new Error(`--without: 只能是 codex、claude、pi：${unknown.join(', ')}`);
  return { utf8: !flag(args, '--no-utf8'), pythonUtf8: !flag(args, '--no-python-utf8'), unity: !flag(args, '--no-unity'),
    android: flag(args, '--android'), defender: flag(args, '--defender'), blender: flag(args, '--blender'),
    codex: !without.includes('codex'), claude: !without.includes('claude'), pi: !without.includes('pi') };
}
const CHOICE_FLAGS: Record<string, string> = { utf8: '--no-utf8', pythonUtf8: '--no-python-utf8', unity: '--no-unity', android: '--android',
  defender: '--defender', blender: '--blender', codex: '--without codex', claude: '--without claude', pi: '--without pi' };
async function windowsDeps(list: import('./environment.ts').Dependency[], config: LocalConfig | undefined, install: boolean, dryRun: boolean,
  choices: import('./windows-setup.ts').SetupChoices): Promise<void> {
  const { includedItems, planSummary, probeWindowsMachine, runWindowsSetup, windowsSetupPlan } = await import('./windows-setup.ts');
  const plan = windowsSetupPlan(list, probeWindowsMachine(list, config));
  const summary = planSummary(plan, choices);
  const size = (mb?: number) => mb ? `（约 ${mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`}）` : '';
  const line = (item: import('./windows-setup.ts').PlanItem) => `  - ${item.title}${size(item.downloadMB)}${item.restart ? '，需要重启电脑后生效' : ''}${item.toggles ? `  [${item.toggles.map(toggle => CHOICE_FLAGS[toggle]).join(' / ')}]` : ''}`;
  if (summary.machine.length) console.log(`\n一次管理员授权里完成（Windows 只弹出一次确认，显示为「Windows PowerShell」）：\n${summary.machine.map(line).join('\n')}`);
  if (summary.user.length) console.log(`\n不需要管理员授权：\n${summary.user.map(line).join('\n')}`);
  const included = new Set(includedItems(plan.items, choices).map(item => item.id));
  const left = plan.items.filter(item => !included.has(item.id) && item.toggles);
  if (left.length) console.log(`\n这次不做的可选项：\n${left.map(line).join('\n')}`);
  for (const item of plan.blocked) console.log(`不能自动完成：${item.title}：${item.reason}`);
  if (summary.downloadMB) console.log(`\n合计下载约 ${summary.downloadMB >= 1000 ? `${(summary.downloadMB / 1000).toFixed(1)} GB` : `${summary.downloadMB} MB`}。`);
  for (const action of plan.person.filter(item => !item.when?.length || item.when.some(id => included.has(id))))
    console.log(`需要你自己完成：${action.title}：${action.detail}`);
  if (!install) {
    if (summary.machine.length || summary.user.length) console.log('\n运行 avh deps install 一次完成；加 --dry-run 只演练、不做改动。');
    return;
  }
  if (!summary.machine.length && !summary.user.length) { console.log('\n没有需要自动完成的项目。'); return; }
  if (!dryRun && summary.machine.length) console.log('\n正在请求管理员授权（请在弹出的 Windows 确认里选「是」）…');
  const printed = new Map<string, { message: string; at: number }>();
  const job = await runWindowsSetup(plan, choices, { dryRun, onUpdate: current => {
    for (const item of current.items) {
      const prior = printed.get(item.id), now = Date.now();
      // Download progress changes every few seconds; show it at most every half minute.
      if (prior?.message === item.message || (item.status === 'running' && prior && item.done !== undefined && now - prior.at < 30_000)) continue;
      if (item.status === 'pending') continue;
      printed.set(item.id, { message: item.message, at: now });
      console.log(`${{ running: '…', done: 'OK', skipped: 'SKIP', failed: 'FAIL', pending: '' }[item.status]}\t${item.title}\t${item.message}`);
    }
  } });
  if (job.note) console.log(`\n${job.note}`);
  if (job.restartRequired && !dryRun) console.log('\nUTF-8 设置要重启电脑后生效；可以先继续使用，方便时再重启。');
  if (dryRun) console.log('\n演练结束：没有做任何改动。');
  if (job.state !== 'done') process.exitCode = 1;
}
export function versionText(): string {
  return `avh ${packageVersion()} (${harnessVersion()})\nschema ${SCHEMA_VERSION} · Node ${process.version} · ${process.platform}-${process.arch}`;
}
function database(config: LocalConfig): ReturnType<typeof openDatabase> {
  hostPlatform.mkdirPrivate(dirname(config.stateDbPath));
  return openDatabase(config.stateDbPath);
}
function profile(config: LocalConfig, id: string | undefined): string {
  const selected = id ?? config.defaultProfile;
  if (!config.definitions[selected]) throw new Error(`--profile: 未定义 ${selected}`);
  return selected;
}
function saveBrief(config: LocalConfig, db: ReturnType<typeof openDatabase>, report: ImportReport): string {
  const path = join(config.home, 'reports', `${report.id}.md`);
  hostPlatform.mkdirPrivate(dirname(path));
  hostPlatform.writePrivate(path, handoffMarkdown(db, report.id));
  return path;
}
function one(config: LocalConfig, db: ReturnType<typeof openDatabase>, path: string, id: string, kind?: ProjectKind): { report: ImportReport; brief: string } {
  const projectPath = resolve(path);
  rejectCloudSyncedPath(projectPath);
  const knownProjects: Record<string, string[]> = {};
  for (const [name, aliases] of Object.entries(config.projectAliases)) {
    const order = new RegExp(config.importByProfile[id]!.clientPattern).exec(name)?.[1];
    knownProjects[name] = [name, ...(order ? [`COMM-${order}`] : []), ...aliases];
  }
  for (const entry of readdirSync(config.workspaceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !existsSync(join(config.workspaceRoot, entry.name, 'ProjectSettings/ProjectVersion.txt'))) continue;
    const order = new RegExp(config.importByProfile[id]!.clientPattern).exec(entry.name)?.[1];
    knownProjects[entry.name] = [...new Set([entry.name, ...(order ? [`COMM-${order}`] : []), ...(knownProjects[entry.name] ?? [])])];
  }
  const report = importProject(db, { workspacePath: config.workspaceRoot, projectPath, definition: config.definitions[id]!,
    config: { ...config.importByProfile[id], projectAliases: config.projectAliases[basename(projectPath)] ?? [], knownProjects }, kind,
    generatedFrom: { harness_version: harnessVersion(), knowledge_version: knowledgeVersion(config, id),
      interpretation_hash: interpretationHash(config, id) } });
  return { report, brief: saveBrief(config, db, report) };
}
function counts(report: ImportReport): string {
  const statuses = ['verified', 'claimed', 'unknown', 'not_applicable'];
  return statuses.map(status => `${status}=${report.stages.filter(stage => stage.status === status).length}`).join(' ');
}
function unresolved(report: ImportReport): number { return [...report.ledger, ...report.externalLedger].filter(item => item.status !== 'done' && item.status !== 'dropped').length; }
function failedBlockingReviews(report: ImportReport): number {
  return report.reviews.filter(review => review.status === 'fail' &&
    ['fingerprint', 'vpm_baseline', 'delivery_archives', 'artifacts'].includes(review.id)).length;
}
function cleanupCount(report: ImportReport): number {
  const review = report.reviews.find(item => item.id === 'delivery_cleanup');
  return review?.status === 'fail' ? review.evidence.length : 0;
}
function projectImport(args: string[]): void {
  const path = args.shift(); if (!path || path.startsWith('--')) usage();
  const profileId = option(args, '--profile'); const explicitKind = option(args, '--kind'); const json = flag(args, '--json');
  noExtra(args);
  if (explicitKind && !kinds.includes(explicitKind as ProjectKind)) throw new Error(`--kind: 无效 ${explicitKind}`);
  const config = loadConfig(); const db = database(config);
  try {
    const { report, brief } = one(config, db, path, profile(config, profileId), explicitKind as ProjectKind | undefined);
    if (json) console.log(JSON.stringify({ report, briefPath: brief }, null, 2));
    else console.log(`${basename(report.projectPath)}\t${report.identity.kind}\t${counts(report)}\t复核失败=${failedBlockingReviews(report)}\t待清理=${cleanupCount(report)}\t未收结=${unresolved(report)}\n报告 id: ${report.id}\n简报: ${brief}`);
  } finally { db.close(); }
}
function candidates(config: LocalConfig): string[] {
  const rules = config.importByProfile[config.defaultProfile]!;
  const matches = (name: string) => new RegExp(rules.clientPattern).test(name) || new RegExp(rules.privatePattern).test(name) || config.sampleNames.includes(name);
  const dirs = readdirSync(config.workspaceRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const found = dirs.filter(matches).map(name => join(config.workspaceRoot, name));
  const history = join(config.workspaceRoot, rules.historicalDir);
  if (existsSync(history)) for (const entry of readdirSync(history, { withFileTypes: true }).filter(x => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) found.push(join(history, entry.name));
  return [...new Set(found)];
}
function projectImportAll(args: string[]): void {
  const rawKinds = option(args, '--kinds'); noExtra(args);
  const selected = rawKinds ? rawKinds.split(',').map(x => x.trim()) : kinds;
  if (!selected.length || selected.some(x => !kinds.includes(x as ProjectKind))) throw new Error(`--kinds: 只接受 ${kinds.join(',')}`);
  const config = loadConfig(); const db = database(config); const failures: string[] = [];
  console.log('项目\tkind\t素体首选\t状态计数\t复核失败\t待清理\t未收结');
  try {
    const rules = config.importByProfile[config.defaultProfile]!;
    for (const path of candidates(config)) {
      const name = basename(path);
      const inHistory = dirname(path) === join(config.workspaceRoot, rules.historicalDir);
      const kind: ProjectKind = inHistory ? 'history' : config.sampleNames.includes(name) ? 'sample' : new RegExp(rules.clientPattern).test(name) ? 'client' : 'private';
      if (!selected.includes(kind)) continue;
      try {
        const { report } = one(config, db, path, config.defaultProfile, kind);
        console.log(`${name}\t${report.identity.kind}\t${report.identity.base ?? '未知'}\t${counts(report)}\t${failedBlockingReviews(report)}\t${cleanupCount(report)}\t${unresolved(report)}`);
      } catch (error) { failures.push(`${path}: ${String(error)}`); }
    }
  } finally { db.close(); }
  console.log(`导入失败 ${failures.length} 项`);
  for (const item of failures) console.error(item);
  if (failures.length) process.exitCode = 1;
}
function projectList(args: string[]): void {
  noExtra(args); const config = loadConfig();
  if (!existsSync(config.stateDbPath)) { console.log('项目\tkind\t最近导入\t状态计数\t复核失败\t待清理\t未收结'); return; }
  const db = database(config);
  try {
    const rows = db.prepare(`SELECT p.path, p.kind, r.created_at, r.report_json FROM project p
      JOIN import_report r ON r.id = (SELECT id FROM import_report WHERE project_id = p.id ORDER BY created_at DESC, rowid DESC LIMIT 1)
      ORDER BY p.path`).all() as { path: string; kind: string; created_at: string; report_json: string }[];
    console.log('项目\tkind\t最近导入\t状态计数\t复核失败\t待清理\t未收结');
    for (const row of rows) {
      const r = JSON.parse(row.report_json) as ImportReport;
      console.log(`${row.path}\t${row.kind}\t${row.created_at}\t${counts(r)}\t${failedBlockingReviews(r)}\t${cleanupCount(r)}\t${unresolved(r)}`);
    }
  } finally { db.close(); }
}
function projectBrief(args: string[]): void {
  const query = args.shift(); if (!query || query.startsWith('--')) usage();
  const out = option(args, '--out'); noExtra(args);
  const config = loadConfig();
  if (!existsSync(config.stateDbPath)) throw new Error('stateDbPath: 状态库不存在');
  const db = database(config);
  try {
    const rows = db.prepare(`SELECT r.id FROM import_report r JOIN project p ON p.id = r.project_id
      WHERE r.id = ? OR p.id = ? OR p.path = ? OR p.path = ? OR p.path LIKE ?
      ORDER BY r.created_at DESC, r.rowid DESC`).all(query, query, query, resolve(config.workspaceRoot, query).slice(config.workspaceRoot.length + 1), `%/${query}`) as { id: string }[];
    if (!rows.length) throw new Error(`找不到项目或报告 id: ${query}`);
    const report = getImportReport(db, rows[0]!.id);
    if (rows.some(row => getImportReport(db, row.id).projectId !== report.projectId)) throw new Error(`项目名称不唯一: ${query}；请使用报告 id`);
    const content = handoffMarkdown(db, report.id) + projectTaskBrief(db, report.projectId, config.home);
    if (out) { const target = isAbsolute(out) ? out : resolve(out); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); console.log(target); }
    else process.stdout.write(content);
  } finally { db.close(); }
}
/** A project given as its id, its directory, or its unique directory name. */
function resolveProject(db: ReturnType<typeof openDatabase>, config: LocalConfig, query: string): string {
  const rows = db.prepare('SELECT p.id, p.path, w.path AS workspace FROM project p LEFT JOIN workspace w ON w.id = p.workspace_id')
    .all() as Array<{ id: string; path: string; workspace: string | null }>;
  const exact = rows.find(row => row.id === query);
  if (exact) return exact.id;
  const absolute = (row: { path: string; workspace: string | null }) => isAbsolute(row.path) ? row.path : join(row.workspace ?? '', row.path);
  const target = resolve(config.workspaceRoot, query);
  const matches = rows.filter(row => resolve(absolute(row)) === target || basename(absolute(row)) === query);
  if (matches.length !== 1) throw new Error(matches.length ? `项目名称不唯一: ${query}；请使用项目 id` : `找不到项目: ${query}`);
  return matches[0]!.id;
}
/**
 * `project archive <项目>`: refresh the project's archive now (observe it, walk it, write and verify _harness/), then
 * check it against the state database. `--check` only checks.
 */
async function projectArchive(args: string[]): Promise<void> {
  const query = args.shift(); if (!query || query.startsWith('--')) usage();
  const check = flag(args, '--check'), json = flag(args, '--json'); noExtra(args);
  const config = loadConfig(); const db = database(config);
  try {
    const projectId = resolveProject(db, config, query);
    let write: ArchiveWriteResult | undefined;
    // The scheduler refreshes a live Workflow's fingerprints every round; without it, an edit made since would go unseen.
    if (!check) write = await archiveSafePoint(db, config.home, projectId);
    const result = { projectId, ...(write ? { write } : {}), check: checkProjectArchive(db, projectId), status: archiveStatus(db, projectId) };
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log([
      ...(write ? [`写入：${write.status}${write.revision ? `（修订 ${write.revision}）` : ''}${write.reason ? `：${write.reason}` : ''}${write.error ? `：${write.error}` : ''}`] : []),
      `一致性：${result.check.state}${result.check.problems.length ? `\n  ${result.check.problems.join('\n  ')}` : ''}`,
      `可分享工程：${result.status.shareable.ok ? '无阻断' : `受阻\n  ${result.status.shareable.blockers.map(item => item.text).join('\n  ')}`}`,
      `档案：${write?.manifest ?? join(projectRoot(db, projectId), '_harness', 'archive.json')}`].join('\n'));
    if (write?.status === 'failed' || result.check.state === 'diverged') process.exitCode = 1;
  } finally { db.close(); }
}
/** Every value of a repeatable option (`--include a --include b`), in order. */
function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let value = option(args, name); value !== undefined; value = option(args, name)) values.push(value);
  return values;
}
/** `--progress`: one JSON line per step on stderr, at most four a second (the service follows a long job with them). */
function progressReporter(enabled: boolean): ((progress: { phase: string; done?: number; total?: number }) => void) | undefined {
  if (!enabled) return undefined;
  let last = 0, phase = '';
  return progress => {
    const now = Date.now();
    if (progress.phase === phase && now - last < 250 && progress.done !== progress.total) return;
    last = now; phase = progress.phase;
    process.stderr.write(`progress ${JSON.stringify(progress)}\n`);
  };
}
const bytesText = (bytes: number): string => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
/**
 * `project share <项目>`: compile the explicit list of a shareable project and, unless `--dry-run`, write the 7z
 * package from it (docs/project-share.md). Blocked (or failed) exits 1; the report is complete either way.
 */
async function projectShare(args: string[]): Promise<void> {
  const query = args.shift(); if (!query || query.startsWith('--')) usage();
  const layers = option(args, '--layers'), include = options(args, '--include'), exclude = options(args, '--exclude');
  const acknowledge = options(args, '--acknowledge'), name = option(args, '--name'), recipient = option(args, '--recipient'), out = option(args, '--out');
  const purpose = option(args, '--purpose');
  if (purpose !== 'self' && purpose !== 'others') throw new Error('分享前必须明确指定 --purpose self（本人迁移/备份）或 --purpose others（交给他人）');
  if (purpose === 'self' && recipient) throw new Error('本人迁移包不能填写接收者');
  const dryRun = flag(args, '--dry-run'), permittedOnly = flag(args, '--permitted-only'), json = flag(args, '--json'), unityCheck = flag(args, '--unity-check');
  const progress = progressReporter(flag(args, '--progress')); noExtra(args);
  const config = loadConfig(); const db = database(config);
  const { compileShare, exportShare } = await import('./archive/share.ts');
  try {
    const projectId = resolveProject(db, config, query);
    const shareOptions = { purpose: purpose as 'self' | 'others', layers: (layers ?? 'A').split(',').map(item => item.trim()).filter(Boolean), include, exclude, acknowledge, permittedOnly,
      ...(name ? { name } : {}), ...(recipient ? { recipient } : {}), ...(out ? { out: resolve(out) } : {}) };
    if (unityCheck && !config.unity) console.error('没有配置 Unity 编辑器：跳过 Unity 打开检查');
    const env = { home: config.home, ...(config.exportRoots[0] ? { exportRoot: config.exportRoots[0] } : {}), ...(progress ? { onProgress: progress } : {}),
      ...(unityCheck && config.unity ? { unityCheck: { editor: config.unity.editor ?? config.unity.runner, timeoutSec: config.unity.defaultTimeoutSec } } : {}) };
    let result: { status: string; plan: import('./archive/share.ts').SharePlan; package?: { path: string; bytes: number; sha256: string; members: number } } | undefined;
    try {
      // A dry run only shows a plan: it may reuse the digest cache. The export that follows reads the content again.
      if (dryRun) { const compiled = await compileShare(db, env, projectId, { ...shareOptions, preview: true }); result = { status: compiled.plan.ready ? 'ready' : 'blocked', plan: compiled.plan }; }
      else result = await exportShare(db, env, projectId, shareOptions);
    } catch (error) {
      if (json) console.log(JSON.stringify({ status: 'failed', error: (error as Error).message }, null, 2));
      else console.error(`分享失败：${(error as Error).message}`);
      process.exitCode = 1; return;
    }
    const plan = result.plan;
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log([
      `${plan.name}（修订 ${plan.revision ?? '—'}）：${result.status === 'exported' ? '已导出' : result.status === 'ready' ? '可以导出' : '受阻'} · ${plan.levelText}`,
      ...plan.levelReasons.map(reason => `  ${reason}`),
      ...plan.blockers.map(blocker => `阻断：${blocker.text}${blocker.paths?.length ? `\n  ${blocker.paths.slice(0, 10).join('\n  ')}${(blocker.count ?? blocker.paths.length) > 10 ? '\n  …' : ''}` : ''}`),
      `纳入：${plan.included.files} 个文件，${bytesText(plan.included.bytes)}（A ${plan.included.byLayer.A.files} · B ${plan.included.byLayer.B.files} · C ${plan.included.byLayer.C.files}）`,
      ...plan.items.map(item => `  ${item.included ? '[√]' : '[ ]'} ${item.id}：${item.text}（${item.files} 个文件）`),
      ...(plan.missing.length ? ['接收端待补齐：', ...plan.missing.map(item => `  ${item.text}`)] : []),
      ...plan.warnings.map(warning => `注意：${warning}`),
      ...(result.package ? [`分享包：${result.package.path}（${bytesText(result.package.bytes)}，${result.package.members} 个成员，sha256 ${result.package.sha256}）`,
        '已通过：7z 完整性测试、成员与清单逐项比对、冷解包校验'] : []),
    ].join('\n'));
    if (result.status === 'blocked') process.exitCode = 1;
  } finally { db.close(); }
}
/**
 * Record `avh doctor`'s output where the exporter reads it (`state/doctor.txt`). It is recorded by the caller *before*
 * the preview it belongs to (R28 P1-3), never by the exporter itself: a doctor run inside a preview would be a side
 * effect, and inside the Runtime's event loop it would block every other request. Nothing on stdout unless asked, so a
 * `--json` caller still sees one JSON document.
 */
function recordDoctorReading(config: LocalConfig, announce: boolean): void {
  const doctor = join(config.home, 'state', 'doctor.txt');
  const reading = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/avh.js', import.meta.url)), 'doctor'],
    { encoding: 'utf8', env: { ...process.env, AVH_HOME: config.home }, windowsHide: true, timeout: 180_000 });
  const recorded = `${reading.stdout ?? ''}${reading.stderr ?? ''}`.trim();
  if (!recorded) { if (announce) console.error('avh doctor 没有输出：诊断包不含 doctor 附件。'); return; }
  hostPlatform.mkdirPrivate(dirname(doctor));
  hostPlatform.writePrivate(doctor, `${recorded}\n`);
  if (announce) console.log(`已收录 avh doctor 的输出（${recorded.split('\n').length} 行，退出码 ${reading.status ?? '未知'}）到诊断包。`);
}
/**
 * `project diagnose <项目> [--out 目录] [--since 时间]`: compile the diagnostics bundle, print the preview, then write
 * it (D-133). The preview is what a person checks before anything leaves the machine, and its member manifest -- names,
 * sizes and content hashes -- is the token the export is bound to (R28 P1-3): an export recompiles and refuses with
 * "内容已变化，请重新预览" when anything moved in between. The export rescans every packed member and refuses rather
 * than hand over a package that still carries a credential, a private path, an order id or a local vocabulary word; a
 * refusal exits 1. `--expect-digest` and `--generated-at` are how a caller that already previewed (the GUI) binds its
 * export to the very bundle it showed.
 */
async function projectDiagnose(args: string[]): Promise<void> {
  const query = args.shift(); if (!query || query.startsWith('--')) usage();
  const out = option(args, '--out'), since = option(args, '--since');
  const json = flag(args, '--json'), previewOnly = flag(args, '--preview');
  const expectDigest = option(args, '--expect-digest'), generatedAt = option(args, '--generated-at');
  // `--progress` puts one JSON line per step on stderr, which is how the GUI follows a long export.
  const progress = progressReporter(flag(args, '--progress'));
  noExtra(args);
  if (since && !Number.isFinite(Date.parse(since))) throw new Error('--since: 需要可解析的时间（例如 2026-10-01 或 2026-10-01T12:00:00Z）');
  if (generatedAt && !Number.isFinite(Date.parse(generatedAt))) throw new Error('--generated-at: 需要可解析的时间');
  const config = loadConfig(); const db = database(config);
  const { previewDiagnostics, exportDiagnostics, CATEGORY_TEXT } = await import('./diagnostics/diagnose.ts');
  try {
    const projectId = resolveProject(db, config, query);
    // An export that carries a confirmed digest reuses the reading the previewer recorded; every other run records it
    // here so that its own preview already lists `doctor.txt`.
    if (!expectDigest && !previewOnly) recordDoctorReading(config, !json);
    const options = { ...(since ? { since } : {}), env: { home: config.home, commit: harnessVersion() },
      ...(generatedAt ? { generatedAt } : {}), ...(progress ? { onProgress: progress } : {}) };
    const plan = previewDiagnostics(db, config, projectId, options);
    if (json) {
      const result = previewOnly ? { status: 'preview', plan }
        : exportDiagnostics(db, config, projectId, { ...options, out: resolve(out ?? join(config.home, 'exports')),
          ...(expectDigest ? { expect: expectDigest } : {}) });
      console.log(JSON.stringify(result, null, 2));
      if ('status' in result && result.status === 'refused') process.exitCode = 1;
      return;
    }
    console.log([
      `${plan.project.name}：诊断包预览（${plan.issues.length} 条问题，${plan.totals.included} 个附件，${bytesText(plan.totals.keptBytes)}）`,
      `  清单摘要：${plan.manifest.length} 个成员，摘要 ${plan.manifestDigest.slice(0, 16)}（导出会带上它；重新编译后不同就拒绝）`,
      `  纳入：${plan.items.filter(item => item.included).map(item => item.path).join('、') || '无'}`,
      ...plan.items.filter(item => !item.included).map(item => `  排除：${item.path}：${item.excludedBecause}`),
      ...plan.policy.map(item => `  整类排除：${item.what}`),
      `  脱敏：本地隐私词表 ${plan.privacyWords.applied} 条${plan.privacyWords.problems.length ? `（${plan.privacyWords.problems.length} 条问题已跳过）` : ''}`,
      `  问题：${plan.issues.slice(0, 20).map(issue => `${issue.checkLabel ?? issue.stageId ?? String(issue.reading.review ?? '—')}（${CATEGORY_TEXT[issue.category]}）`).join('、') || '无'}`,
      ...plan.totals.truncated.map(note => `  截断：${note}`),
      ...plan.warnings.map(warning => `  注意：${warning}`),
    ].join('\n'));
    if (previewOnly) { console.log('（--preview：只预览，没有写出任何文件。）'); return; }
    // The export recompiles in this process: pinning the preview's compile instant is what lets its manifest match.
    const result = exportDiagnostics(db, config, projectId, { ...options, generatedAt: plan.generatedAt,
      out: resolve(out ?? join(config.home, 'exports')), expect: expectDigest ?? plan.manifestDigest });
    if (result.status === 'refused') {
      console.error(`拒绝导出：${result.refusal?.reason}`);
      for (const member of result.refusal?.members ?? []) console.error(`  ${member.path}：${member.detectors.join('、')}`);
      process.exitCode = 1; return;
    }
    console.log(`诊断包：${result.package!.path}（${bytesText(result.package!.bytes)}，${result.package!.members} 个成员，sha256 ${result.package!.sha256}）\n导出后已逐成员复扫：没有命中密钥、私人路径、订单号或本地隐私词表。这个包不会自动上传，交给你自己处理。`);
  } finally { db.close(); }
}
/**
 * `project restore <分享包>`: check a share package and restore it into this Harness (`--check` only checks);
 * `--complete <项目>` binds Workflows a restore left waiting for their capability pack.
 */
async function projectRestore(args: string[]): Promise<void> {
  const complete = option(args, '--complete');
  const target = complete ? undefined : args.shift();
  if (!complete && (!target || target.startsWith('--'))) usage();
  const check = flag(args, '--check'), asCopy = flag(args, '--as-copy'), allowNetwork = flag(args, '--allow-network'), json = flag(args, '--json');
  const name = option(args, '--name'), expect = option(args, '--expect');
  const progress = progressReporter(flag(args, '--progress')); noExtra(args);
  if (expect && !['new', 'update', 'same', 'conflict'].includes(expect)) throw new Error('--expect: 只能是 new、update、same 或 conflict');
  const config = loadConfig(); const db = database(config);
  const restore = await import('./archive/restore.ts');
  const env = { home: config.home, workspaceRoot: config.workspaceRoot, workflowVariables: config.workflowVariables, allowNetwork,
    ...(progress ? { onProgress: progress } : {}) };
  try {
    if (complete) {
      const projectId = resolveProject(db, config, complete);
      const results = restore.completeRestore(db, env, projectId);
      const reconciliation = restore.restoreReconciliation(db, projectId);
      if (json) console.log(JSON.stringify({ results, reconciliation }, null, 2));
      else console.log(results.length ? results.map(item => `${item.bound ? '已绑定' : '仍在等待'}：制作流程 ${item.workflowId.slice(0, 8)}：${item.text}`).join('\n') : '这个项目没有等待中的恢复');
      if (results.some(item => !item.bound)) process.exitCode = 1;
      return;
    }
    const restoreOptions = { asCopy, ...(name ? { name } : {}), ...(expect ? { expect: expect as 'new' } : {}) };
    let result: unknown;
    try { result = check ? await restore.checkRestore(db, env, target!, restoreOptions) : await restore.restoreShare(db, env, target!, restoreOptions); }
    catch (error) {
      if (json) console.log(JSON.stringify({ status: 'failed', error: (error as Error).message }, null, 2));
      else console.error(`恢复失败：${(error as Error).message}`);
      process.exitCode = 1; return;
    }
    if (json) console.log(JSON.stringify(result, null, 2));
    const checked = (check ? result : (result as { check: unknown }).check) as import('./archive/restore.ts').RestoreCheck;
    if (!json) {
      const lines = [`分享包：${checked.archive}（${bytesText(checked.bytes)}）`,
        ...(checked.manifest ? [`项目：${checked.manifest.name}（修订 ${checked.manifest.revision}，${checked.manifest.levelText}；Harness ${checked.manifest.producer.version}）`] : []),
        ...(checked.decision ? [`方式：${checked.decision.text}${checked.decision.target ? `\n  位置：${checked.decision.target}` : ''}`] : []),
        ...checked.problems.map(problem => `问题：${problem}`), ...checked.warnings.map(warning => `注意：${warning}`),
        ...checked.packs.map(pack => `能力包：${pack.text}`), ...checked.projectPacks.map(pack => pack.text),
        ...(checked.missing.length ? ['本机还缺：', ...checked.missing.map(item => `  ${item}`)] : [])];
      if (!check) {
        const restored = result as import('./archive/restore.ts').RestoreResult;
        if (restored.status === 'restored' && restored.reconciliation) {
          const r = restored.reconciliation;
          lines.push(`已恢复：${r.path}（${r.levelText}）`, `  事实 ${r.restored.facts ?? 0} 条，制作流程 ${r.restored.workflows ?? 0} 个，任务 ${r.restored.tasks ?? 0} 个，检查结论 ${r.restored.verdicts ?? 0} 条，决定 ${r.restored.decisions ?? 0} 条`,
            ...r.pathChanges.map(item => `  ${item}`), ...r.pending.filter(item => !item.bound).map(item => `  等待：${item.text}`), ...r.candidates.map(item => `  ${item}`),
            ...r.recovery.map(item => `  需核对：${item.text}`), ...(r.stale.length ? [`  失效证据 ${r.stale.length} 项：${r.stale.slice(0, 3).map(item => item.text).join('；')}`] : []),
            ...(r.continuable.length ? [`  可继续的阶段：${r.continuable.join('、')}`] : []), ...r.next.map(item => `下一步：${item}`));
        } else lines.push(restored.status === 'unchanged' ? '没有恢复：本机已有这个版本（要另存一份用 --as-copy）' : '没有恢复：先解决上面的问题');
      } else lines.push(checked.ok ? '检查通过：可以恢复' : '检查未通过');
      console.log(lines.join('\n'));
    }
    // A package already present here is not a failure: there is simply nothing to restore.
    const status = check ? (checked.problems.length ? 'blocked' : 'ok') : (result as { status: string }).status;
    if (status === 'blocked') process.exitCode = 1;
  } finally { db.close(); }
}
/** `project conversation <项目> --search <文本>`: find messages of the project's conversation (never given to an agent). */
async function projectConversation(args: string[]): Promise<void> {
  const query = args.shift(); if (!query || query.startsWith('--')) usage();
  const search = option(args, '--search'); if (!search) usage();
  const json = flag(args, '--json'); noExtra(args);
  const config = loadConfig(); const db = database(config);
  const { searchConversation } = await import('./archive/restore.ts');
  try {
    const found = searchConversation(db, resolveProject(db, config, query), search);
    if (json) console.log(JSON.stringify(found, null, 2));
    else console.log(found.length ? found.map(item => `${item.at}\t${item.role}\t${item.status}\t${item.excerpt}`).join('\n') : '没有找到');
  } finally { db.close(); }
}
export function workflowText(view: WorkflowView): string {
  const mark: Record<string, string> = { passed: '✓', not_applicable: '－', open: '·', blocked: '✗', waiting: ' ', running: '▶', deciding: '!' };
  return [`Workflow ${view.id}`, `项目: ${view.project}`, `流程: ${view.profile}（冻结于 ${view.frozenAt}；${view.processHash.slice(0, 12)}）`,
    `状态: ${view.status}`, ...(view.request ? [`需求: ${view.request}`] : []),
    `方案: ${view.plan.error ? `无法读取（${view.plan.error}）` : view.plan.hash ? `${view.plan.hash.slice(0, 12)}${view.plan.approved ? ' 已批准' : ' 未批准'}` : '尚未产出'}；版本 ${view.plan.revisions} 个`,
    `下一步: ${view.next}`, '阶段:',
    ...view.stages.map(stage => `  ${mark[stage.display ?? stage.status] ?? '?'} ${stage.id}\t${stage.display ?? stage.status}${stage.task ? `\t任务 ${stage.task.id.slice(0, 8)} ${stage.task.status}（${stage.task.attempts} 次）` : ''}${stage.reasons.length ? `\t${stage.reasons.slice(0, 2).join('; ')}${stage.reasons.length > 2 ? ` 等 ${stage.reasons.length} 项` : ''}` : ''}`),
    '里程碑:', ...view.milestones.map(item => `  ${item.id}\t${item.status}${item.reasons.length ? `\t${item.reasons.slice(0, 2).join('; ')}` : ''}`),
    'Gate:', ...view.gates.map(gate => `  ${gate.gate}\t${gate.status}\t${gate.kind} ${gate.binds}\t${gate.owner}`),
    // A warning is not a Gate: it is a reading the person accepts or leaves blocking, so it is listed as one.
    ...warningLines(view)].join('\n');
}
/**
 * Current warning readings of one Workflow, with the state a person needs to act on. Whether a reading still asks for an
 * acceptance is the Runtime's own judgement, carried in the projection as `acceptanceRequired`; deciding it here from
 * `severity` and `result` kept offering an acceptance the Runtime refuses — a valid plan-bound `not_applicable` reading
 * and every reading of a cancelled Workflow were both shown as "待接受", while `warning list` and the GUI, reading the
 * same projection, said "不适用" and offered nothing.
 */
function warningLines(view: WorkflowView): string[] {
  const rows = view.stages.flatMap(stage => stage.checks
    .filter(check => check.severity === 'warning' && check.verdict && check.verdict.result !== 'pass')
    .map(check => ({ stage: stage.id, check })));
  if (!rows.length) return [];
  return ['提醒:', ...rows.map(({ stage, check }) => {
    const verdict = check.verdict!;
    const state = !verdict.current ? '已过期，需重新取证'
      : verdict.accepted ? `已接受（${verdict.acceptedAt}）`
      : check.acceptanceRequired ? '待接受（接受后阶段才能继续）'
      : view.status === 'cancelled' ? '已取消，无需确认'
      : verdict.result === 'not_applicable' ? '不适用'
      : '无需接受';
    return `  ${view.id}:${check.id}\t${stage}\t${verdict.result}\t${state}\t读数 ${verdict.artifactHash.slice(0, 12)}`;
  })];
}
export async function main(argv = process.argv.slice(2), host: HostPlatform = hostPlatform): Promise<void> {
  const [scope, command, ...args] = argv;
  // `avh` alone opens the terminal interface for a person; scripts use the subcommands.
  if ((scope === undefined && process.stdin.isTTY && process.stdout.isTTY) || (scope === 'tui' && command === undefined)) {
    const { runTui } = await import('./tui/index.ts');
    await runTui(avhHome());
  }
  else if (scope === 'gui') {
    if (command === 'install' || command === 'uninstall') {
      noExtra(args); const desktop = await import('./gui/install.ts');
      if (command === 'install') console.log(`已安装 Harness 桌面入口：${desktop.installDesktop()}`);
      else console.log(desktop.uninstallDesktop() ? '已移除 Harness 桌面入口' : 'Harness 桌面入口尚未安装');
      return;
    }
    const all = command === undefined ? args : [command, ...args];
    const noOpen = flag(all, '--no-open');
    const portText = option(all, '--port');
    noExtra(all);
    const port = portText === undefined ? undefined : Number(portText);
    if (port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65535)) throw new Error('--port 应为 0–65535 的整数');
    const { runGui } = await import('./gui/server.ts');
    await runGui(avhHome(), { open: !noOpen, ...(port === undefined ? {} : { port }),
      ...(process.env.AVH_GUI_SESSION_TOKEN ? { sessionToken: process.env.AVH_GUI_SESSION_TOKEN } : {}),
      ...(process.env.AVH_GUI_NATIVE_TOKEN ? { nativeToken: process.env.AVH_GUI_NATIVE_TOKEN } : {}) });
  }
  else if ((scope === '--version' || scope === 'version') && command === undefined) console.log(versionText());
  else if (scope === 'knowledge') knowledgeCommand(command, args);
  else if (scope === 'assets') (await import('./assets/cli.ts')).assetsCommand(command, args, () => database(loadConfig()));
  else if (scope === 'booth') { const { boothCommand } = await import('./booth/cli.ts'); await boothCommand(command, args); }
  else if (scope === 'workspace' && command === 'init') { noExtra(args); init(host); }
  else if (scope === 'doctor' && command === undefined) await doctor(host);
  else if (scope === 'deps' && (command === undefined || command === 'install' || command.startsWith('--'))) {
    await deps(command === 'install', command?.startsWith('--') ? [command, ...args] : args);
  }
  else if (scope === 'update' && command === 'check') {
    const channel = option(args, '--channel') ?? 'dev'; noExtra(args.filter(arg => arg !== '--channel' && arg !== channel));
    const { checkForAppUpdate } = await import('./app-release.ts');
    const result = await checkForAppUpdate(packageVersion(), { channel });
    if (!result.latest) console.log(`已是最新：${result.current}（${channel} 渠道）`);
    else {
      console.log(`有新版本：${result.latest.version}（当前 ${result.current}，${channel} 渠道，${result.latest.issuedAt}）\n${result.latest.notes}`);
      for (const file of result.latest.files) console.log(`${file.kind}\t${file.name}\t${file.size} 字节\tsha256 ${file.sha256}\n\t${file.urls.join('\n\t')}`);
    }
    if (result.rejected) console.log(`已忽略 ${result.rejected} 个未通过签名校验的发行清单`);
  }
  else if (scope === 'update' && command === 'knowledge') {
    const channel = option(args, '--channel') ?? 'dev', install = option(args, '--install');
    noExtra(args.filter(arg => ![ '--channel', channel, '--install', install ].includes(arg)));
    const { checkKnowledgeReleases, installKnowledgeRelease, listKnowledgeReleases } = await import('./knowledge-release.ts');
    const config = loadConfig(); const db = database(config);
    try {
      if (install) {
        const offer = (await listKnowledgeReleases({ channel, supportedSchema: SCHEMA_VERSION })).offers.find(item => item.manifest.releaseId === install);
        if (!offer) throw new Error(`更新服务上没有这个已签名的能力包发行：${install}`);
        const installed = await installKnowledgeRelease(db, avhHome(), offer, { supportedSchema: SCHEMA_VERSION });
        console.log(`${installed.alreadyInstalled ? '早已安装' : '已安装'}能力包 ${installed.version}（${installed.id}）。启用：GUI 核心管理，或 TUI 核心页按 v。`);
      } else {
        const result = await checkKnowledgeReleases(db, avhHome(), config.knowledgeRoot, { channel, supportedSchema: SCHEMA_VERSION });
        console.log(`当前能力包：${result.current ? `${result.current.version}（${result.current.id}）` : '未启用受管能力包'}，${channel} 渠道`);
        if (!result.releases.length) console.log('服务端没有可用的已签名能力包发行');
        for (const release of result.releases) console.log(`${release.releaseId}\t${release.version}\t${release.issuedAt}\t${release.size} 字节\t${
          release.installed ? '已安装' : release.newer ? '较新，可安装：--install ' + release.releaseId : '不比当前新'}`);
        if (result.rejected) console.log(`已忽略 ${result.rejected} 个未通过签名校验的发行清单`);
      }
    } finally { db.close(); }
  }
  else if (scope === 'project' && command === 'new') {
    const name = args.shift(); if (!name || name.startsWith('--')) usage(); noExtra(args);
    console.log(`已新建工程：${createProject(loadConfig(), name)}`);
  }
  else if (scope === 'project' && command === 'import') projectImport(args);
  else if (scope === 'project' && command === 'import-all') projectImportAll(args);
  else if (scope === 'project' && command === 'list') projectList(args);
  else if (scope === 'project' && command === 'brief') projectBrief(args);
  else if (scope === 'project' && command === 'archive') await projectArchive(args);
  else if (scope === 'project' && command === 'share') await projectShare(args);
  else if (scope === 'project' && command === 'diagnose') await projectDiagnose(args);
  else if (scope === 'project' && command === 'restore') await projectRestore(args);
  else if (scope === 'project' && command === 'conversation') await projectConversation(args);
  else if (scope === 'provider' && command === 'list') {
    const probe = flag(args, '--probe'); noExtra(args); console.log(providerList(loadConfig(), probe));
  }
  else if (scope === 'task' && command === 'add') {
    const project = args.shift(); if (!project || project.startsWith('--')) usage();
    const spec = option(args, '--spec'); if (!spec) usage(); noExtra(args);
    const config = loadConfig(); const db = database(config);
    try { console.log(`Task: ${taskAdd(config, db, project, spec)}`); } finally { db.close(); }
  }
  else if (scope === 'task' && command === 'list') {
    const project = option(args, '--project'); noExtra(args); const config = loadConfig(); const db = database(config);
    try { console.log(taskList(db, project)); } finally { db.close(); }
  }
  else if (scope === 'task' && command === 'show') {
    const id = args.shift(); if (!id) usage(); noExtra(args); const config = loadConfig(); const db = database(config);
    try { console.log(taskShow(db, id, config.home)); } finally { db.close(); }
  }
  else if (scope === 'task' && command === 'accept-changes') {
    const id = args.shift(); if (!id || id.startsWith('--')) usage();
    const note = option(args, '--note'); if (!note?.trim()) throw new Error('--note: 必须填写审阅说明');
    const paths: string[] = []; let path: string | undefined;
    while ((path = option(args, '--path')) !== undefined) paths.push(path);
    noExtra(args); const config = loadConfig(); const db = database(config);
    try {
      const result = taskAcceptChanges(db, id, note, paths);
      const summary = `已接受 ${result.accepted} 条；剩余 ${result.remaining} 条。`;
      const next = result.status === 'BLOCKED' ? '任务仍为 BLOCKED；请使用 task redo。' : `状态: ${result.status}`;
      console.log([...result.acceptedPaths.map(path => `已接受: ${path}`), `${summary}${next}`].join('\n'));
    } finally { db.close(); }
  }
  else if (scope === 'task' && command === 'redo') {
    const id = args.shift(); if (!id || id.startsWith('--')) usage(); const note = option(args, '--note'); noExtra(args);
    const config = loadConfig(); const db = database(config);
    try { taskRedo(db, id, note ?? undefined); console.log(`已记录重做请求: ${id}`); } finally { db.close(); }
  }
  else if (scope === 'task' && command === 'recover') {
    const id = args.shift(); if (!id) usage();
    const harmless = flag(args, '--no-side-effects'); const reconciled = flag(args, '--reconciled');
    const force = flag(args, '--force'); const note = option(args, '--note') ?? '';
    if (harmless === reconciled || (force && !harmless) || !note.trim()) usage();
    noExtra(args); const config = loadConfig(); const db = database(config);
    try { await taskRecover(db, config, id, harmless ? 'no_side_effects' : 'reconciled', note, force);
      console.log(`已恢复: ${id}`); } finally { db.close(); }
  }
  else if (scope === 'workflow' && command === 'create') {
    const project = args.shift(); if (!project || project.startsWith('--')) usage();
    const profileId = option(args, '--profile'); if (!profileId) usage(); const manifest = option(args, '--manifest');
    const candidateId=option(args,'--candidate-pack');noExtra(args);
    const config = loadConfig(); const db = database(config);
    try { console.log(`Workflow: ${createWorkflow(db, config, project, profileId, manifest,candidateId?{candidateId}:{})}`); } finally { db.close(); }
  }
  else if (scope === 'workflow' && command === 'stage-tool') {
    const action=args.shift(),id=args.shift();if(!id||!['show','select'].includes(action??''))usage();
    const stage=option(args,'--stage'),pack=option(args,'--pack'),token=option(args,'--expect-token'),note=option(args,'--note');
    if(!stage||!pack)throw new Error('--stage 和 --pack 必须填写');
    if(action==='select'&&(!token||!note?.trim()))throw new Error('采用修复需要 --expect-token 和 --note');
    if(action==='show'&&(token!==undefined||note!==undefined))usage();noExtra(args);
    const config=loadConfig(),db=database(config);
    try {const snapshot=workflowSnapshot(db,resolveWorkflowId(db,id));
      console.log(JSON.stringify(action==='show'?stageContractView(db,config,snapshot,stage,pack)
        :selectStageContract(db,config,snapshot,stage,pack,token!,note!)));
    }finally{db.close();}
  }
  else if (scope === 'workflow' && command === 'list') {
    noExtra(args); const config = loadConfig(); const db = database(config);
    try {
      console.log(['id\tproject\tprofile\tstatus\tstages\tnext', ...listWorkflows(db).map(row =>
        `${row.id}\t${row.projectName}\t${row.profile}\t${row.status}\t${row.stagesPassed}/${row.stagesTotal}\t${row.next}`)].join('\n'));
    } finally { db.close(); }
  }
  else if (scope === 'workflow' && command === 'show') {
    const typed = args.shift(); if (!typed) usage(); noExtra(args); const config = loadConfig(); const db = database(config);
    try { console.log(workflowText(describeWorkflow(db, resolveWorkflowId(db, typed)))); } finally { db.close(); }
  }
  else if (scope === 'workflow' && command === 'cancel') {
    const id = args.shift(); if (!id || id.startsWith('--')) usage();
    const note = option(args, '--note'); if (!note?.trim()) throw new Error('--note: 必须说明取消原因'); noExtra(args);
    const config = loadConfig(); const db = database(config);
    try {
      const result = await cancelWorkflow(db, config, resolveWorkflowId(db, id), note);
      console.log(result.confirmed ? `已取消 Workflow ${id}` : `未能确认全部任务已停止：${result.tasks.filter(task => !task.confirmed).map(task => task.taskId).join(', ')}`);
      if (!result.confirmed) process.exitCode = 2;
    } finally { db.close(); }
  }
  else if (scope === 'managed' && command) {
    // Installing and activating a bundled pack were only reachable through the service API and the GUI,
    // so a headless environment had to speak the API itself. These verbs are that path, and they go
    // through the running service rather than rewriting the config here: activation also replaces the
    // process definitions and backs the old config up, and a second copy of that logic would be a second
    // truth about which pack is active (决定记录 D-97).
    // `activate` names the pack to switch to; `trace` names the receipt or candidate to look up; the other
    // verbs take nothing, so the arguments are consumed before the check that would otherwise refuse them.
    const named = command === 'activate' ? args.shift() : undefined;
    if (command === 'activate' && (!named || named.startsWith('--'))) usage();
    const traceReceipt = command === 'trace' ? option(args, '--receipt') : undefined;
    const traceCandidate = command === 'trace' ? option(args, '--candidate') : undefined;
    if (command === 'trace') {
      // DATA/D8: the chain existed in the Runtime and had no user surface at all, so a maintainer could not read
      // back which signed release their own accepted case went into.
      if ((traceReceipt === undefined) === (traceCandidate === undefined))
        throw new Error('用法: avh managed trace --receipt <回执 id> | --candidate <候选 id>');
      noExtra(args);
    } else noExtra(args);
    const home = avhHome();
    const client = await ApiClient.connect(home).catch((error: Error) => {
      throw new Error(`需要正在运行的 Runtime 服务才能管理能力包（${error.message}）；先执行 avh service start`);
    });
    try {
      if (command === 'list') {
        const packs = await client.call('managed.list') as Array<{ id: string; channel: string; active: boolean; version?: string }>;
        console.log(['id\t通道\t版本\t选中', ...packs.map(pack =>
          `${pack.id}\t${pack.channel}\t${pack.version ?? ''}\t${pack.active ? '是' : ''}`)].join('\n'));
      } else if (command === 'install') {
        const installed = await client.call('managed.installBuiltin') as { id: string; root: string; active: boolean };
        console.log(`${installed.active ? '已是当前能力包' : '已安装'}：${installed.id}`);
        if (!installed.active) console.log(`启用它：avh managed activate ${installed.id}`);
      } else if (command === 'activate') {
        const result = await client.call('managed.activate', { id: named }) as
          { id: string; version?: string; removedProfiles?: string[]; configBackup?: string };
        console.log(`已启用：${result.id}${result.version ? `（${result.version}）` : ''}`);
        if (result.configBackup) console.log(`原配置已备份：${result.configBackup}`);
        // A pack that ships different profiles than the old one leaves workflows that cannot load.
        if (result.removedProfiles?.length) console.log(`不再提供的流程：${result.removedProfiles.join('、')}`);
      } else if (command === 'trace') {
        const trace = await client.call('managed.contribution.trace', traceReceipt ? { receiptId: traceReceipt } : { candidateId: traceCandidate }) as ContributionTrace;
        console.log(contributionTraceText(trace));
      } else usage();
    } finally { client.close(); }
  }
  else if (scope === 'service' && command) {
    const interval = Number(option(args, '--interval') ?? '1000');
    if (!Number.isSafeInteger(interval) || interval < 100) throw new Error('--interval 应为不少于 100 的毫秒数');
    const noScheduler = flag(args, '--no-scheduler'); noExtra(args);
    const home = avhHome();
    if (command === 'run') await runService({ home, intervalMs: interval, scheduler: !noScheduler });
    else {
      const manager = new ServiceManager(home);
      if (command === 'start') {
        const how = await manager.start(interval);
        console.log(how === 'already' ? '后台服务已在运行' : `后台服务已启动（${how === 'systemd-user' ? 'systemd 用户单元' : `后台进程，日志 ${manager.log}`}）`);
      } else if (command === 'stop') console.log(await manager.stop() ? '后台服务已停止' : '后台服务未运行');
      else if (command === 'status') {
        const status = await manager.status();
        console.log([`状态: ${status.running ? '运行中' : '未运行'}`, `接口: ${status.endpoint}`,
          process.platform === 'win32' ? `管理方式: 后台进程；${status.unit?.installed ? `登录后自动启动（${status.unit.path}）` : '未设为登录后自动启动（avh service install）'}`
          : status.unit ? `systemd 用户单元: ${status.unit.name}（${status.unit.installed ? (status.unit.enabled ? '已启用' : '已安装') : '未安装'}${status.unit.active ? '，活动' : ''}）` : '管理方式: 后台进程（无 systemd 用户实例）',
          ...(status.linger === undefined ? [] : [`注销后继续运行: ${status.linger ? '是' : '否（loginctl enable-linger 可开启）'}`]),
          `日志: ${status.unit && process.platform !== 'win32' ? `journalctl --user -u ${status.unit.name}` : status.log}`].join('\n'));
        if (!status.running) process.exitCode = 3;
      } else if (command === 'install' && process.platform === 'win32') {
        const entry = manager.install(interval); const how = await manager.start(interval);
        console.log(`已设为登录后自动启动：${entry}；${how === 'already' ? '后台服务已在运行' : '后台服务已启动'}`);
      } else if (command === 'uninstall' && process.platform === 'win32') {
        manager.uninstall(); console.log(`已移除登录后自动启动；${await manager.stop() ? '后台服务已停止' : '后台服务未运行'}`);
      } else if (command === 'install') console.log(`已安装并启动 systemd 用户单元：${manager.install(interval)}`);
      else if (command === 'uninstall') { manager.uninstall(); console.log('已停止并移除 systemd 用户单元'); }
      else usage();
    }
  }
  else if (scope === 'serve' && command === undefined || scope === 'serve' && command?.startsWith('--')) {
    const all = command === undefined ? args : [command, ...args]; const once = flag(all, '--once');
    const drainOnly = flag(all, '--drain'); const interval = Number(option(all, '--interval') ?? '1000'); noExtra(all);
    const config = loadConfig(); const db = database(config);
    try { await serve(db, config, once, interval, drainOnly); } finally { db.close(); }
  }
  else if (scope === 'warning' && command === 'list') {
    noExtra(args); const config = loadConfig(); const db = database(config);
    try { console.log(warningList(db)); } finally { db.close(); }
  }
  else if (scope === 'warning' && command === 'accept') {
    const id = args.shift(); if (!id || id.startsWith('--')) usage();
    const note = option(args, '--note'); if (!note?.trim()) throw new Error('--note: 必须写明接受原因');
    const expectedVerdict = option(args, '--expect-verdict'); noExtra(args);
    const config = loadConfig(); const db = database(config);
    try { console.log(warningAccept(db, id, note, expectedVerdict).message); } finally { db.close(); }
  }
  else if (scope === 'gate' && command === 'list') {
    noExtra(args); const config = loadConfig(); const db = database(config);
    try { console.log(gateList(db, config.home)); } finally { db.close(); }
  }
  else if (scope === 'gate' && (command === 'approve' || command === 'reject' || command === 'choose' || command === 'accept')) {
    const id = args.shift(); if (!id) usage(); const note = option(args, '--note') ?? '';
    const expected = option(args, '--expect-hash');
    const expectedInputsJson = option(args, '--expect-inputs');
    const expectedInputs = expectedInputsJson === undefined ? undefined : parseInputHashes(JSON.parse(expectedInputsJson));
    const faceRevision=option(args,'--expect-face-revision');
    const previewHash=option(args,'--expect-preview-hash');
    const choice = command === 'choose' ? { candidateId: option(args, '--candidate') ?? '', candidateSetSha256: option(args, '--candidate-set-hash') ?? '', previewSha256: option(args, '--preview-hash') ?? '' } : undefined;
    const review = command === 'accept' ? { previewSha256: option(args, '--preview-hash') ?? '' } : undefined;
    noExtra(args);
    const config = loadConfig(); const db = database(config);
    try {
      const at = id.lastIndexOf(':');
      if (at > 0 && isFormalWorkflow(db, id.slice(0, at))) {
        const decided = await decideFormalGate(db, config, id.slice(0, at), id.slice(at + 1), command !== 'reject', note, expected, choice, review, expectedInputs,faceRevision===undefined?undefined:Number(faceRevision),previewHash);
        console.log(`${command}: ${id}（${decided.artifactHash.slice(0, 12)}）`);
      } else {
        if (choice || review) throw new Error('脸型决定需要实际正式制作流程');
        const current = taskGates(db, config.home).find(gate => gate.gate === id);
        if (expected && current && current.artifactHash !== expected) throw new Error(`${current.binds} 在你查看之后已变化，请重新查看后再决定`);
        gateDecide(db, id, command === 'approve', note, config.home); console.log(`${command}: ${id}`);
      }
    } finally { db.close(); }
  }
  else if (scope === 'cancel') {
    const id = command; if (!id) usage(); noExtra(args); const config = loadConfig(); const db = database(config);
    try { const result = await cancel(db, config, id);
      if (result.residue) {
        if (!result.residue.length) console.log(`无残留: ${id}（任务已结束，没有 pending/running 的 Run）`);
        for (const item of result.residue) console.log(item.outcome === 'closed'
          ? `已收尾残留 Run ${item.runId}: 任务 ${item.taskStatus}；单元 ${item.unit}` +
            `${item.exitStatus === undefined ? '' : `；退出码 ${item.exitStatus}`}；已释放 ${item.releasedLocks} 把锁`
          : item.outcome === 'unconfirmed' ? `残留 Run ${item.runId} 未关闭，槽位保留: ${item.reason}` : '');
      }
      else console.log(result.confirmed
        ? `已确认取消: ${id}${result.releasedLocks === undefined ? '' : `；已释放 ${result.releasedLocks} 把锁`}`
        : `终止尚未确认: ${id}`);
      if (!result.confirmed) process.exitCode = 2; }
    finally { db.close(); }
  }
  else usage();
}
