import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Dependency } from '../src/environment.ts';
import { npmCommand, userCommand } from '../src/environment.ts';
import {
  DEFAULT_CHOICES, effectivePolicy, includedItems, mergePath, openCommand, planSummary, refreshPathFromRegistry, registryPaths,
  runWindowsSetup, setupChoices, statusMessage, UNITY_CHANGESET, windowsSetupPlan, type PlanItem, type SetupChoices, type WindowsProbe,
} from '../src/windows-setup.ts';
import {
  bootstrapCommand, encodeCommand, EXIT_TAMPERED, machineScript, powershellEnv, psQuote, readSetupStatus, runMachineSteps, type MachineStep, type SetupStatus,
} from '../src/windows-setup-script.ts';
import { removeTemp, windows } from './fixtures/platform.ts';

// ---------------------------------------------------------------------------------------------------------------------
// The plan, from a faked computer. These run on every platform: the plan is data.

const IDS = ['node', 'git', 'avh-win', 'python', '7z', 'pwsh', 'unity-hub', 'unity', 'unity-license', 'dotnet', 'vpm', 'npm', 'codex', 'claude', 'pi'];
function deps(missing: string[]): Dependency[] {
  return IDS.map(id => ({ id, name: id, purpose: `${id} purpose`, required: ['node', 'git', 'avh-win', 'python', '7z', 'unity'].includes(id),
    ok: !missing.includes(id), detail: missing.includes(id) ? '未找到' : 'ok' }));
}
/** A computer that has never been set up: Windows 11 with nothing Harness needs, script execution Restricted, no UTF-8. */
function bare(overrides: Partial<WindowsProbe> = {}): WindowsProbe {
  return { build: 26200, winget: 'C:\\ExampleHomes\\a\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe',
    powershellPolicy: { MachinePolicy: 'Undefined', UserPolicy: 'Undefined', Process: 'Bypass', CurrentUser: 'Undefined', LocalMachine: 'Undefined' },
    codePages: { ACP: '936', OEMCP: '936', MACCP: '10008' }, activeCodePage: 936, longPaths: false, unityRoots: ['C:\\Program Files\\Unity\\Hub\\Editor'],
    unityAndroid: false, unityLicense: false, hubRunning: false, pythonUtf8: false, defender: true,
    workspace: 'C:\\ExampleHomes\\a\\avatar-workspace', unityCache: 'C:\\ExampleHomes\\a\\AppData\\Local\\Unity\\cache', logins: {}, ...overrides };
}
/** A computer where everything is done. */
function ready(overrides: Partial<WindowsProbe> = {}): WindowsProbe {
  return bare({ powershellPolicy: { LocalMachine: 'RemoteSigned' }, pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', pwshPolicy: { LocalMachine: 'RemoteSigned' },
    codePages: { ACP: '65001', OEMCP: '65001', MACCP: '65001' }, activeCodePage: 65001, longPaths: true, gitLongPaths: true,
    unityHub: 'C:\\Program Files\\Unity Hub\\Unity Hub.exe', unityEditor: 'C:\\Program Files\\Unity\\Hub\\Editor\\2022.3.22f1\\Editor\\Unity.exe',
    unityAndroid: true, unityLicense: true, pythonUtf8: true, logins: { codex: true }, ...overrides });
}
const ids = (items: Array<{ id: string }>) => items.map(item => item.id);
const WINGET_DOWNLOAD_FAILED = -1978335224;
const byId = (items: PlanItem[], id: string) => items.find(item => item.id === id)!;

test('Blender uses the existing optional one-click Windows install, without making source-preserving work install it', () => {
  const blender: Dependency = { id: 'blender', name: 'Blender', purpose: '脸型设计', required: false, ok: false, detail: '未找到' };
  const plan = windowsSetupPlan([...deps([]), blender], ready());
  const item = byId(plan.items, 'winget:BlenderFoundation.Blender');
  assert.equal(item.phase, 'machine'); assert.deepEqual(item.toggles, ['blender']);
  assert.deepEqual(item.step, { id: item.id, kind: 'winget', package: 'BlenderFoundation.Blender' });
  assert.match(machineScript([item.step!], plan.context, { statusFile: 'C:\\HarnessTest\\avh-blender-plan-only.json', dryRun: true }),
    /winget install --id 'BlenderFoundation\.Blender' -e --silent.*--source winget --scope machine/);
  assert.match(item.detail, /保留原外形无需安装/);
  assert.equal(DEFAULT_CHOICES.blender, false);
  assert.deepEqual(includedItems(plan.items, DEFAULT_CHOICES), []);
  assert.deepEqual(ids(includedItems(plan.items, setupChoices({ blender: true }))), [item.id]);
  assert.equal(setupChoices({ blender: 'true' }).blender, false, 'only an explicit boolean opts in');
  assert.equal(windowsSetupPlan([...deps([]), { ...blender, ok: true }], ready()).items.some(row => row.id === item.id), false);
  const unavailable = windowsSetupPlan([...deps([]), blender], ready({ winget: undefined }));
  assert.equal(unavailable.items.some(row => row.id === item.id), false);
  assert.match(unavailable.blocked.find(row => row.id === item.id)!.reason, /winget/, 'no fake installation when the system installer is absent');
});

test('the layered-recolour dependencies are installed into the stage-tool Python, and only while they are missing', () => {
  const missing: Dependency = { id: 'layered-recolor', name: '分层改色依赖', purpose: '', required: false, ok: false, detail: '缺少 psd-tools' };
  const python = 'C:\\Python313\\python.exe';
  const plan = windowsSetupPlan([...deps([]), missing], ready({ python }));
  const item = byId(plan.items, 'layered-recolor-deps');
  assert.equal(item.phase, 'user');
  assert.deepEqual(item.argv, [python, '-m', 'pip', 'install', '--user', 'psd-tools==1.18.0', 'Pillow==12.3.0', 'NumPy==2.5.2']);
  assert.deepEqual(item.requires, undefined, 'Python is already there');
  assert.match(item.detail, /不需要管理员授权/);
  const satisfied = windowsSetupPlan([...deps([]), { ...missing, ok: true }], ready({ python }));
  assert.equal(satisfied.items.some(row => row.id === 'layered-recolor-deps'), false, 'nothing to do when the imports work');
  // A machine that must install Python first runs the pip step after it, in whatever interpreter PATH then has.
  const fresh = windowsSetupPlan([...deps(['python']), missing], bare());
  const freshItem = byId(fresh.items, 'layered-recolor-deps');
  assert.deepEqual(freshItem.requires, ['winget:Python.Python.3.13']);
  assert.deepEqual(freshItem.argv!.slice(0, 1), ['python']);
  // No Python and no winget to install one: the item is impossible here rather than silently running `python`.
  const blocked = windowsSetupPlan([...deps(['python']), missing], bare({ winget: undefined }));
  assert.equal(blocked.items.some(row => row.id === 'layered-recolor-deps'), false);
  assert.match(blocked.blocked.find(row => row.id === 'layered-recolor-deps')!.reason, /Python/);
});

test('a computer that was never set up gets every item, in order, with what each needs first', () => {
  const plan = windowsSetupPlan(deps(IDS.filter(id => !['node', 'avh-win'].includes(id))), bare());
  assert.equal(plan.winget, 'ok');
  assert.deepEqual(ids(plan.items.filter(item => item.phase === 'machine')), ['policy:powershell', 'longpaths', 'utf8', 'winget:Git.Git',
    'winget:Python.Python.3.13', 'winget:7zip.7zip', 'winget:Microsoft.DotNet.SDK.8', 'winget:OpenJS.NodeJS.LTS', 'winget:Microsoft.PowerShell',
    'winget:Unity.UnityHub', 'unity-editor', 'unity-android', 'git-longpaths', 'defender']);
  assert.deepEqual(ids(plan.items.filter(item => item.phase === 'user')), ['python-utf8', 'vpm', 'ai:codex', 'ai:claude', 'ai:pi']);
  assert.deepEqual(byId(plan.items, 'git-longpaths').requires, ['winget:Git.Git']);
  assert.deepEqual(byId(plan.items, 'unity-editor').requires, ['winget:Unity.UnityHub']);
  assert.deepEqual(byId(plan.items, 'unity-android').requires, ['winget:Unity.UnityHub', 'unity-editor']);
  assert.deepEqual(byId(plan.items, 'vpm').requires, ['winget:Microsoft.DotNet.SDK.8']);
  assert.deepEqual(byId(plan.items, 'ai:claude').requires, ['winget:OpenJS.NodeJS.LTS']);
  assert.deepEqual(byId(plan.items, 'ai:claude').argv, ['npm', 'install', '--global', '@anthropic-ai/claude-code']);
  assert.deepEqual(byId(plan.items, 'ai:pi').argv, ['npm', 'install', '--global', '@earendil-works/pi-coding-agent']);
  assert.deepEqual(byId(plan.items, 'ai:codex').argv, ['npm', 'install', '--global', '@openai/codex']);
  assert.deepEqual(byId(plan.items, 'python-utf8').argv, ['setx', 'PYTHONUTF8', '1']);
  // The machine steps the script gets carry the same prerequisites.
  assert.deepEqual(byId(plan.items, 'unity-editor').step, { id: 'unity-editor', kind: 'unity-editor', totalBytes: 2_812_392_448, requires: ['winget:Unity.UnityHub'] });
  assert.equal(plan.context.unityChangeset, '887be4894c44');
  assert.equal(plan.context.unityVersion, '2022.3.22f1');
  // Defaults: UTF-8 on, Android and Defender off, every AI tool on.
  const chosen = includedItems(plan.items, DEFAULT_CHOICES);
  assert.ok(ids(chosen).includes('utf8'));
  assert.ok(!ids(chosen).includes('unity-android') && !ids(chosen).includes('defender'));
  const summary = planSummary(plan, DEFAULT_CHOICES);
  assert.equal(summary.restart, true, 'UTF-8 needs a restart');
  assert.equal(summary.downloadMB, 65 + 30 + 2 + 225 + 33 + 118 + 185 + 2812 + 165 + 115 + 30);
  // Unity Hub is missing, so there is no button yet; the license still has to be activated by the person.
  assert.deepEqual(plan.person.map(action => [action.id, action.buttons.map(button => button.target)]), [['unity-license', []]]);
  assert.deepEqual(plan.blocked, []);
});

test('a computer that is ready gets nothing to do and nothing to ask', () => {
  const plan = windowsSetupPlan(deps([]), ready());
  // Defender's exclusions cannot be read without elevation, so the optional item stays on offer, off by default.
  assert.deepEqual(ids(plan.items), ['defender']);
  assert.deepEqual(includedItems(plan.items, DEFAULT_CHOICES), []);
  assert.equal(planSummary(plan, DEFAULT_CHOICES).downloadMB, 0);
  assert.deepEqual(ids(windowsSetupPlan(deps([]), ready({ defender: false })).items), [], 'no Defender running, nothing to exclude');
  assert.deepEqual(plan.person, []);
  assert.deepEqual(plan.blocked, []);
  assert.equal(plan.restartPending, false);
});

test('a partly set-up computer gets only what is missing; a found Unity editor needs no Unity item', () => {
  // Scripts already allowed for this user (CurrentUser), UTF-8 on, Unity installed without Android; Git and Claude missing.
  const plan = windowsSetupPlan(deps(['git', 'claude']), ready({ powershellPolicy: { CurrentUser: 'RemoteSigned', LocalMachine: 'Undefined' },
    gitLongPaths: undefined, unityAndroid: false, logins: { codex: false } }));
  assert.deepEqual(ids(plan.items), ['winget:Git.Git', 'unity-android', 'git-longpaths', 'defender', 'ai:claude']);
  assert.equal(byId(plan.items, 'unity-android').requires, undefined, 'the editor and Hub are there');
  assert.equal(byId(plan.items, 'ai:claude').requires, undefined, 'npm is there');
  assert.deepEqual(ids(includedItems(plan.items, DEFAULT_CHOICES)), ['winget:Git.Git', 'git-longpaths', 'ai:claude']);
  assert.deepEqual(plan.person.map(action => action.id), ['login:codex']);
  assert.deepEqual(plan.person[0]!.buttons, [{ label: '打开 Codex 登录', target: 'login:codex' }]);
});

test('choices switch optional items, and what only they needed goes with them', () => {
  const plan = windowsSetupPlan(deps(['python', 'unity', 'npm', 'codex', 'claude', 'pi']), bare({ unityHub: undefined }));
  const with_ = (changes: Partial<SetupChoices>) => ids(includedItems(plan.items, { ...DEFAULT_CHOICES, ...changes }));
  assert.ok(!with_({ utf8: false }).includes('utf8'));
  assert.equal(planSummary(plan, { ...DEFAULT_CHOICES, utf8: false }).restart, false);
  // No AI tool chosen: Node.js (npm) is not installed for nothing.
  const noAi = with_({ codex: false, claude: false, pi: false });
  assert.ok(!noAi.includes('winget:OpenJS.NodeJS.LTS') && !noAi.some(id => id.startsWith('ai:')));
  assert.ok(with_({ codex: false, claude: false }).includes('winget:OpenJS.NodeJS.LTS'), 'pi alone still needs npm');
  // No Unity: Hub is still installed, because the license has to be activated in it.
  assert.ok(with_({ unity: false }).includes('winget:Unity.UnityHub') && !with_({ unity: false }).includes('unity-editor'));
  // Android without the editor it goes into is left out.
  assert.ok(!with_({ unity: false, android: true }).includes('unity-android'));
  assert.ok(with_({ android: true }).includes('unity-android'));
  assert.ok(with_({ defender: true }).includes('defender'));
  // With a license already there, Hub is only installed for an editor or module that is chosen.
  const licensed = windowsSetupPlan(deps(['unity']), bare({ unityHub: undefined, unityLicense: true }));
  assert.ok(!ids(includedItems(licensed.items, { ...DEFAULT_CHOICES, unity: false })).includes('winget:Unity.UnityHub'));
  assert.ok(ids(includedItems(licensed.items, DEFAULT_CHOICES)).includes('winget:Unity.UnityHub'));
  assert.deepEqual(setupChoices({ utf8: false, android: 'yes', unknown: true }), { ...DEFAULT_CHOICES, utf8: false });
});

test('execution policy: a Group Policy blocks the item, a restrictive per-user policy is fixed without elevation', () => {
  assert.deepEqual(effectivePolicy({ MachinePolicy: 'AllSigned', LocalMachine: 'RemoteSigned' }), { policy: 'AllSigned', scope: 'MachinePolicy' });
  assert.deepEqual(effectivePolicy({ Process: 'Bypass' }), { policy: 'Restricted', scope: 'default' }, 'a process scope does not last');
  const gpo = windowsSetupPlan(deps([]), ready({ powershellPolicy: { MachinePolicy: 'AllSigned' } }));
  assert.deepEqual(gpo.blocked.map(item => item.id), ['policy:powershell']);
  assert.match(gpo.blocked[0]!.reason, /组策略/);
  assert.deepEqual(ids(gpo.items), ['defender']);
  const perUser = windowsSetupPlan(deps([]), ready({ powershellPolicy: { CurrentUser: 'Restricted', LocalMachine: 'RemoteSigned' },
    pwshPolicy: { LocalMachine: 'AllSigned' } }));
  assert.deepEqual(ids(perUser.items), ['policy:pwsh', 'defender', 'policy-user:powershell']);
  assert.equal(byId(perUser.items, 'policy-user:powershell').phase, 'user');
  assert.deepEqual(byId(perUser.items, 'policy:pwsh').step, { id: 'policy:pwsh', kind: 'policy', shell: 'pwsh' });
});

test('without winget the packages are blocked and the person is shown how to get it; settings still go ahead', () => {
  const plan = windowsSetupPlan(deps(['git', 'npm', 'codex']), bare({ winget: undefined }));
  assert.equal(plan.winget, 'missing');
  assert.deepEqual(plan.blocked.map(item => item.id), ['winget:Git.Git', 'winget:OpenJS.NodeJS.LTS', 'winget:Unity.UnityHub', 'unity-editor', 'ai:codex']);
  assert.ok(ids(plan.items).includes('policy:powershell') && ids(plan.items).includes('utf8'));
  assert.ok(!ids(plan.items).includes('git-longpaths'), 'no Git to configure');
  const action = plan.person.find(item => item.id === 'winget')!;
  assert.deepEqual(action.buttons.map(button => button.target), ['winget-register', 'app-installer']);
  assert.equal(windowsSetupPlan(deps(['git']), bare({ build: 17134 })).winget, 'unsupported');
});

test('UTF-8 set but not yet active asks for a restart; a running Unity Hub is named before an editor install', () => {
  const plan = windowsSetupPlan(deps([]), ready({ activeCodePage: 936 }));
  assert.equal(plan.restartPending, true);
  assert.deepEqual(plan.person.map(action => [action.id, action.buttons.map(button => button.target)]), [['restart', ['restart']]]);
  const hub = windowsSetupPlan(deps(['unity']), ready({ unityEditor: undefined, hubRunning: true, unityLicense: false }));
  assert.deepEqual(hub.person.map(action => action.id), ['hub-running', 'unity-license']);
  assert.deepEqual(hub.person[1]!.buttons, [{ label: '打开 Unity Hub', target: 'unity-hub' }]);
  // Both only matter while the editor is being installed: unchecking it hides them.
  assert.deepEqual(hub.person[0]!.when, ['unity-editor', 'unity-android']);
  assert.deepEqual(hub.person[1]!.when, ['unity-editor']);
  assert.equal(windowsSetupPlan(deps([]), ready({ unityLicense: false })).person[0]!.when, undefined, 'an installed editor needs a license anyway');
});

test('status lines say what happened in words, and name the prerequisite that stopped an item', () => {
  const titles = new Map([['winget:Git.Git', '安装 Git']]);
  assert.equal(statusMessage({ id: 'x', status: 'skipped', reason: 'requires', message: 'winget:Git.Git' }, titles), '跳过：「安装 Git」没有完成');
  assert.equal(statusMessage({ id: 'x', status: 'failed', reason: 'error', message: 'winget exit code -1978335224', code: -1978335224 }, titles),
    '失败：下载失败，请检查网络后重试（winget 退出码 -1978335224）');
  assert.match(statusMessage({ id: 'x', status: 'failed', message: 'hub-running: Unity Hub is running' }, titles), /退出 Unity Hub/);
  assert.equal(statusMessage({ id: 'u', status: 'running', done: 1_400_000_000, total: 2_812_392_448 }, titles), '正在下载与安装：已下载 1.4 GB，共约 2.8 GB');
  assert.equal(statusMessage({ id: 'x', status: 'done', reason: 'already' }, titles), '已经装好');
});

// ---------------------------------------------------------------------------------------------------------------------
// The script: generated text, parsed by PowerShell, and run for real as a dry run (no elevation, no change).

const CONTEXT = { unityVersion: '2022.3.22f1', unityChangeset: UNITY_CHANGESET };
function powershell(text: string, env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(text)],
    { encoding: 'utf8', timeout: 120_000, windowsHide: true, cwd: tmpdir(), env: powershellEnv(env) });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
/** PowerShell's own parser on a script file: its errors, single-quoted strings and command names. */
function parse(file: string): { errors: string[]; strings: string[]; commands: string[] } {
  const result = powershell([
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    `$text = [IO.File]::ReadAllText(${psQuote(file)}, [Text.Encoding]::UTF8)`,
    '$tokens = $null; $errors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)',
    `$strings = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.StringConstantType -eq 'SingleQuoted' }, $true) | ForEach-Object { $_.Value })`,
    '$commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ } | Sort-Object -Unique)',
    '@{ errors = @($errors | ForEach-Object { $_.Message }); strings = $strings; commands = $commands } | ConvertTo-Json -Compress -Depth 3',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as { errors: string[]; strings: string[]; commands: string[] };
}
/** Every command the generated script may run: its own functions and the cmdlets and programs they use. */
const SCRIPT_COMMANDS = new Set(['Add-Content', 'Add-Item', 'Add-MpPreference', 'Complete-Item', 'ConvertFrom-Json', 'ConvertTo-Json', 'ConvertTo-JsonValue',
  'Find-Git', 'Find-Pwsh', 'Find-UnityEditor', 'Find-UnityHub', 'Find-Winget', 'ForEach-Object', 'Get-ChildItem', 'Get-Command', 'Get-Content',
  'Get-DownloadedBytes', 'Get-ExecutionPolicy', 'Get-ItemProperty', 'Get-LastLines', 'Get-MachinePolicy', 'Get-MpPreference', 'Get-Process',
  'Get-UnityRoots', 'Install-UnityAndroid', 'Install-UnityEditor', 'Invoke-Native', 'Invoke-UnityHub', 'Join-Path', 'Measure-Object', 'New-Item',
  'New-ItemProperty', 'New-Object', 'Out-Null', 'Save-Status', 'Select-Object', 'Set-Content', 'Set-ExecutionPolicy', 'Set-MachinePolicy',
  'Set-Registry', 'Split-Path', 'Start-Process', 'Start-Sleep', 'Step', 'Stop-Process', 'Test-DefenderExclusions', 'Test-GitLongPaths',
  'Test-Path', 'Test-PolicyAllows', 'Test-Registry', 'Test-UnityEditor', 'Update-SessionPath', 'Where-Object', 'Write-SetupLog', 'git', 'winget']);
const EVERY_KIND: MachineStep[] = [
  { id: 'policy:powershell', kind: 'policy', shell: 'powershell' }, { id: 'longpaths', kind: 'longpaths' }, { id: 'utf8', kind: 'utf8' },
  { id: 'winget:Git.Git', kind: 'winget', package: 'Git.Git' }, { id: 'winget:Unity.UnityHub', kind: 'winget', package: 'Unity.UnityHub' },
  { id: 'unity-editor', kind: 'unity-editor', totalBytes: 2_812_392_448, requires: ['winget:Unity.UnityHub'] },
  { id: 'unity-android', kind: 'unity-android', requires: ['unity-editor'] }, { id: 'git-longpaths', kind: 'git-longpaths', requires: ['winget:Git.Git'] },
  { id: 'policy:pwsh', kind: 'policy', shell: 'pwsh' },
];

test('the generated script parses as PowerShell for every choice, and runs only its own commands', { skip: !windows && 'PowerShell parser' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-parse-')); t.after(() => removeTemp(root));
  const plan = windowsSetupPlan(deps(IDS.filter(id => !['node', 'avh-win'].includes(id))), bare());
  const variants: Array<Partial<SetupChoices>> = [{}, { utf8: false, defender: true }, { android: true, unity: true }, { unity: false, codex: false, claude: false, pi: false }];
  for (const [i, choices] of variants.entries()) {
    const steps = includedItems(plan.items, { ...DEFAULT_CHOICES, ...choices }).filter(item => item.phase === 'machine').map(item => item.step!);
    const file = join(root, `setup-${i}.ps1`);
    writeFileSync(file, `\uFEFF${machineScript(steps, plan.context, { statusFile: join(root, 'status.json'), logFile: join(root, 'setup.log') })}`);
    const parsed = parse(file);
    assert.deepEqual(parsed.errors, [], `variant ${i}`);
    assert.deepEqual(parsed.commands.filter(name => !SCRIPT_COMMANDS.has(name)), [], `variant ${i} runs only known commands`);
    assert.equal(parsed.strings.includes('--changeset'), true);
    if (steps.some(step => step.kind === 'utf8')) assert.ok(parsed.strings.includes('65001'));
  }
});

test('text from the computer reaches the script only as one quoted string, whatever quotes it holds', { skip: !windows && 'PowerShell parser' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-quote-')); t.after(() => removeTemp(root));
  // Every quote PowerShell accepts as a single quote, a subexpression and a statement separator: none may escape.
  const hostile = `C:\\ExampleHomes\\O'Brien\u2019s\u2018\u201a\u201b $(Remove-Item C:\\x) \`n ; Remove-Item C:\\ -Recurse ; '\u6c49\u5b57`;
  const script = machineScript([{ id: 'defender', kind: 'defender', paths: [hostile] }], { ...CONTEXT, unityHub: `C:\\Program Files\\Unity Hub'\u2019;\\Unity Hub.exe` },
    { statusFile: join(root, `st'a\u2019tus.json`), logFile: join(root, 'setup.log') });
  const file = join(root, 'quoted.ps1');
  writeFileSync(file, `\uFEFF${script}`);
  const parsed = parse(file);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.strings.includes(hostile), 'the path is one string, unchanged');
  assert.ok(parsed.strings.includes(join(root, `st'a\u2019tus.json`)));
  assert.ok(!parsed.commands.includes('Remove-Item'));
  assert.throws(() => psQuote('line\nbreak'), /控制字符/);
  assert.throws(() => machineScript([{ id: 'defender', kind: 'defender', paths: ['relative\\path'] }], CONTEXT, { statusFile: join(root, 's.json') }), /绝对路径/);
  assert.throws(() => machineScript([{ id: 'w', kind: 'winget', package: "Git.Git'; Remove-Item C:\\ -Recurse; '" }], CONTEXT, { statusFile: join(root, 's.json') }), /无效的包名/);
  assert.throws(() => machineScript([{ id: 'u', kind: 'unity-editor' }], { unityVersion: '2022.3.22f1', unityChangeset: 'nope' }, { statusFile: join(root, 's.json') }), /changeset/);
  assert.throws(() => machineScript([{ id: 'w', kind: 'winget', package: 'Git.Git' }], CONTEXT, { statusFile: join(root, 's.json'), rehearse: { w: ['C:\\x.cmd'] } }), /演练/);
});

/** A stand-in program for a dry run's steps: prints its arguments, waits the given seconds, and exits with the given code. */
function fakeProgram(root: string): string {
  const file = join(root, 'fake.cmd');
  writeFileSync(file, ['@echo off', 'echo fake %*', 'if not "%2"=="" ping -n %2 127.0.0.1 >nul', 'exit /b %1', ''].join('\r\n'));
  return file;
}

test('a dry run of the real script changes nothing and reports each step in order: skips, failures and what depends on them',
  { skip: !windows && 'Windows PowerShell' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-dry-')); t.after(() => removeTemp(root));
  const fake = fakeProgram(root);
  // Unity Hub's install roots: one holds the editor already, so its step is skipped as done.
  const editorRoot = join(root, 'Editors');
  mkdirSync(join(editorRoot, '2022.3.22f1', 'Editor'), { recursive: true });
  writeFileSync(join(editorRoot, '2022.3.22f1', 'Editor', 'Unity.exe'), '');
  const steps: MachineStep[] = [
    { id: 'winget:Git.Git', kind: 'winget', package: 'Git.Git' },
    { id: 'git-longpaths', kind: 'git-longpaths', requires: ['winget:Git.Git'] },
    { id: 'winget:7zip.7zip', kind: 'winget', package: '7zip.7zip' },
    { id: 'defender', kind: 'defender', paths: [join(root, 'workspace')] },
    { id: 'winget:Python.Python.3.13', kind: 'winget', package: 'Python.Python.3.13' },
    { id: 'unity-editor', kind: 'unity-editor', totalBytes: 2_812_392_448 },
    { id: 'unity-android', kind: 'unity-android', requires: ['unity-editor'] },
    { id: 'winget:Microsoft.PowerShell', kind: 'winget', package: 'Microsoft.PowerShell' },
  ];
  const scratch = () => readdirSync(tmpdir()).filter(name => name.startsWith('avh-setup-') && existsSync(join(tmpdir(), name, 'setup.ps1'))).sort();
  const before = scratch();
  const seen: SetupStatus[] = [];
  const run = await runMachineSteps(steps, { ...CONTEXT, unityRoots: [editorRoot] }, {
    dryRun: true, pollMs: 100, onStatus: status => seen.push(status),
    env: { ...process.env, APPDATA: join(root, 'AppData') },
    rehearse: {
      'winget:Git.Git': [fake, '1'],                                  // fails
      'winget:7zip.7zip': [fake, '-1978335189'],                      // winget: already installed and current
      defender: [fake, '5'],                                          // an optional item fails; the run goes on
      'winget:Python.Python.3.13': [fake, '0', '3'],                  // takes a moment, so the status shows it running
      'winget:Microsoft.PowerShell': [fake, '-1978334967'],           // installed; a restart finishes it
    },
  });
  assert.equal(run.exitCode, 0, run.log);
  assert.equal(run.refused, false); assert.equal(run.tampered, false);
  const status = run.status!;
  assert.equal(status.version, 1); assert.equal(status.state, 'done'); assert.equal(status.dryRun, true);
  assert.deepEqual(status.items.map(item => [item.id, item.status, item.reason]), [
    ['winget:Git.Git', 'failed', 'error'],
    ['git-longpaths', 'skipped', 'requires'],
    ['winget:7zip.7zip', 'done', 'already'],
    ['defender', 'failed', 'error'],
    ['winget:Python.Python.3.13', 'done', 'changed'],
    ['unity-editor', 'skipped', 'already'],
    ['unity-android', 'done', 'dry-run'],
    ['winget:Microsoft.PowerShell', 'done', 'changed'],
  ]);
  assert.equal(status.items[0]!.code, 1);
  assert.match(status.items[0]!.message ?? '', /winget exit code 1/);
  assert.equal(status.items[1]!.message, 'winget:Git.Git', 'names the prerequisite');
  assert.match(status.items[6]!.message ?? '', /^Install-UnityAndroid 'unity-android'$/, 'a dry run reports the command it would run');
  assert.equal(status.items[5]!.total, 2_812_392_448);
  assert.equal(status.restartRequired, true, 'winget asked for a restart to finish');
  for (const item of status.items) assert.deepEqual(Object.keys(item).sort(), ['code', 'done', 'id', 'message', 'reason', 'status', 'total']);
  // Read while it ran: Python was seen running after Git had already failed.
  assert.ok(seen.some(snapshot => snapshot.state === 'running' && snapshot.items[4]!.status === 'running' && snapshot.items[0]!.status === 'failed'));
  // The log keeps the order the steps ran in.
  const order = [...run.log.matchAll(/== (\S+)/g)].map(match => match[1]);
  assert.deepEqual(order, steps.map(step => step.id));
  assert.deepEqual(scratch(), before, 'the scratch folder is removed');
});

test('two setups never run at once: the second reports itself busy and runs nothing', { skip: !windows && 'Windows PowerShell' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-ws-busy-')); t.after(() => removeTemp(root));
  const fake = fakeProgram(root);
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  // The first run holds the machine setup for a few seconds.
  const first = runMachineSteps([{ id: 'winget:Git.Git', kind: 'winget', package: 'Git.Git' }], CONTEXT, { dryRun: true, pollMs: 100,
    rehearse: { 'winget:Git.Git': [fake, '0', '5'] }, onStatus: status => { if (status.items[0]!.status === 'running') started(); } });
  await running;
  const second = await runMachineSteps([{ id: 'winget:7zip.7zip', kind: 'winget', package: '7zip.7zip' }], CONTEXT, { dryRun: true,
    rehearse: { 'winget:7zip.7zip': [fake, '1'] } });
  assert.deepEqual(second.status!.items.map(item => [item.id, item.status, item.reason]), [['winget:7zip.7zip', 'failed', 'busy']]);
  assert.doesNotMatch(second.log, /fake/, 'its step never ran');
  assert.equal(statusMessage(second.status!.items[0]!, new Map()), '没有运行：另一个 Harness 配置正在进行，等它结束后再试');
  const done = await first;
  assert.deepEqual(done.status!.items.map(item => [item.status, item.reason]), [['done', 'changed']]);
  // Released: the next run goes ahead.
  const after = await runMachineSteps([{ id: 'winget:7zip.7zip', kind: 'winget', package: '7zip.7zip' }], CONTEXT, { dryRun: true,
    rehearse: { 'winget:7zip.7zip': [fake, '0'] } });
  assert.equal(after.status!.items[0]!.status, 'done');
});

test('the elevated bootstrap runs the script only if its bytes are the ones Harness wrote', { skip: !windows && 'Windows PowerShell' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-tamper-')); t.after(() => removeTemp(root));
  const status = join(root, 'status.json'), file = join(root, 'setup.ps1');
  const bytes = Buffer.from(`\uFEFF${machineScript([{ id: 'longpaths', kind: 'longpaths' }], CONTEXT, { statusFile: status, dryRun: true })}`, 'utf8');
  writeFileSync(file, bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(file, Buffer.concat([bytes, Buffer.from('\nRemove-Item C:\\nothing\n')]));
  assert.equal(powershell(bootstrapCommand(file, hash)).status, EXIT_TAMPERED);
  assert.equal(existsSync(status), false, 'nothing ran');
  writeFileSync(file, bytes);
  assert.equal(powershell(bootstrapCommand(file, hash)).status, 0);
  assert.equal(readSetupStatus(status)?.state, 'done');
});

test('Unity is installed through Unity Hub\'s command line with VRChat\'s version and changeset, with download progress',
  { skip: !windows && 'Windows PowerShell' }, async t => {
  // A real (not dry) run of the Unity steps only, against a stand-in Unity Hub in temporary folders: nothing on this
  // computer changes. The install root and APPDATA are temporary folders, so a real Unity install is not seen (Windows
  // resets ProgramFiles in a child's environment, so the root is passed the way the Runtime passes it).
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-hub-')); t.after(() => removeTemp(root));
  const programs = join(root, 'Program Files'), appData = join(root, 'AppData'), editors = join(programs, 'Unity', 'Hub', 'Editor');
  const hubScript = join(root, 'fake-hub.js'), hub = join(root, 'fake-hub.cmd'), calls = join(root, 'calls.txt');
  writeFileSync(hubScript, `
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs'); const { join } = require('node:path');
const args = process.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
const downloads = join(process.env.APPDATA, 'UnityHub', 'downloads'); mkdirSync(downloads, { recursive: true });
const editor = join(${JSON.stringify(editors)}, '2022.3.22f1', 'Editor');
let step = 0;
const timer = setInterval(() => {
  appendFileSync(join(downloads, 'UnitySetup64-2022.3.22f1.exe'), Buffer.alloc(1_000_000));
  console.log('Downloading ' + (++step));
  if (step < 4) return;
  clearInterval(timer);
  mkdirSync(editor, { recursive: true }); writeFileSync(join(editor, 'Unity.exe'), '');
  if (args.includes('install-modules')) mkdirSync(join(editor, 'Data', 'PlaybackEngines', 'AndroidPlayer'), { recursive: true });
  console.log('Installed');
}, 900);
`);
  writeFileSync(hub, `@"${process.execPath}" "${hubScript}" %*\r\n`);
  const seen: SetupStatus[] = [];
  const run = await runMachineSteps([{ id: 'unity-editor', kind: 'unity-editor', totalBytes: 4_000_000 },
    { id: 'unity-android', kind: 'unity-android', requires: ['unity-editor'] }],
  { ...CONTEXT, unityHub: hub, unityRoots: [editors] }, { dryRun: false, elevate: false, pollMs: 200, onStatus: status => seen.push(status),
    env: { ...process.env, APPDATA: appData } });
  assert.equal(run.exitCode, 0, run.log);
  assert.deepEqual(run.status!.items.map(item => [item.id, item.status, item.reason]), [['unity-editor', 'done', 'changed'], ['unity-android', 'done', 'changed']]);
  assert.deepEqual(readFileSync(calls, 'utf8').trim().split(/\r?\n/), [
    '-- --headless install --version 2022.3.22f1 --changeset 887be4894c44',
    '-- --headless install-modules --version 2022.3.22f1 --module android --childModules']);
  const progress = seen.map(status => status.items[0]!).filter(item => item.status === 'running' && (item.done ?? 0) > 0);
  assert.ok(progress.length, 'the download was seen growing');
  assert.ok(progress.some(item => /^Downloading \d/.test(item.message ?? '')), 'Hub\'s last line is shown');
  assert.equal(progress[0]!.total, 4_000_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// After the elevated part: PATH, the user-level steps, and the run as a whole.

test('PATH gains what installers added to the registry, and keeps its own entries first', t => {
  assert.equal(mergePath('C:\\A;C:\\Windows\\System32', 'C:\\Windows\\system32\\;C:\\Program Files\\Git\\cmd', '%USERPROFILE%\\x;C:\\A\\'),
    'C:\\A;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;%USERPROFILE%\\x');
  assert.equal(mergePath(undefined, ';;', ''), '');
  const env: NodeJS.ProcessEnv = { Path: 'C:\\A' };
  refreshPathFromRegistry(env, () => ({ machine: 'C:\\B', user: 'C:\\ExampleHomes\\a\\AppData\\Roaming\\npm' }));
  assert.equal(env.Path, 'C:\\A;C:\\B;C:\\ExampleHomes\\a\\AppData\\Roaming\\npm');
  if (windows) {
    // The real registry, read only.
    const paths = registryPaths();
    assert.match(paths.machine ?? '', /system32/i);
    t.diagnostic(`user PATH entries: ${(paths.user ?? '').split(';').filter(Boolean).length}`);
  }
});

test('npm runs as node with npm-cli.js on Windows, and the AI tools install into the user\'s npm prefix', { skip: !windows && 'Windows npm layout' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-setup-npm-')); t.after(() => removeTemp(root));
  const nodejs = join(root, 'nodejs'), cli = join(nodejs, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  mkdirSync(join(cli, '..'), { recursive: true });
  for (const file of [join(nodejs, 'npm.cmd'), join(nodejs, 'node.exe'), cli]) writeFileSync(file, '');
  const prior = { PATH: process.env.PATH, APPDATA: process.env.APPDATA };
  t.after(() => { process.env.PATH = prior.PATH; process.env.APPDATA = prior.APPDATA; });
  process.env.PATH = nodejs; process.env.APPDATA = join(root, 'AppData');
  assert.deepEqual(npmCommand(), [join(nodejs, 'node.exe'), cli]);
  assert.deepEqual(userCommand(['npm', 'install', '--global', '@openai/codex']), [join(nodejs, 'node.exe'), cli, 'install', '--global', '@openai/codex']);
  // An npm the person installed into their prefix (npm i -g npm) wins, as npm.cmd does.
  const newer = join(root, 'AppData', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  mkdirSync(join(newer, '..'), { recursive: true }); writeFileSync(newer, '');
  assert.deepEqual(npmCommand(), [join(nodejs, 'node.exe'), newer]);
  process.env.PATH = join(root, 'empty');
  assert.throws(() => userCommand(['npm', 'install', '--global', 'x']), /找不到 npm/);
});

function userPlan(): ReturnType<typeof windowsSetupPlan> {
  return windowsSetupPlan(deps(['dotnet', 'vpm', 'npm', 'codex', 'claude', 'pi']), ready({ pythonUtf8: false }));
}

test('the user-level steps run after the elevated part, without a shell, and skip what lost its prerequisite', async () => {
  const plan = userPlan();
  const machineCalls: MachineStep[][] = [], commands: string[][] = [];
  let refreshed = 0;
  const job = await runWindowsSetup(plan, DEFAULT_CHOICES, {
    runMachine: async steps => {
      machineCalls.push(steps);
      return { exitCode: 0, refused: false, tampered: false, log: '', status: { version: 1, state: 'done', dryRun: false, restartRequired: false,
        items: [{ id: 'winget:Microsoft.DotNet.SDK.8', status: 'failed', reason: 'error', code: WINGET_DOWNLOAD_FAILED, message: 'winget exit code' },
          { id: 'winget:OpenJS.NodeJS.LTS', status: 'done', reason: 'changed' }] } };
    },
    runCommand: async argv => { commands.push(argv); return { code: argv.includes('@earendil-works/pi-coding-agent') ? 1 : 0, output: 'npm ERR! network' }; },
    refreshPath: () => { refreshed++; },
  });
  assert.deepEqual(machineCalls.map(steps => steps.map(step => step.id)), [['winget:Microsoft.DotNet.SDK.8', 'winget:OpenJS.NodeJS.LTS']]);
  assert.equal(refreshed, 1, 'PATH is refreshed once, after the elevated part');
  assert.deepEqual(commands, [['setx', 'PYTHONUTF8', '1'], ['npm', 'install', '--global', '@openai/codex'],
    ['npm', 'install', '--global', '@anthropic-ai/claude-code'], ['npm', 'install', '--global', '@earendil-works/pi-coding-agent']]);
  const state = Object.fromEntries(job.items.map(item => [item.id, [item.status, item.message]]));
  assert.deepEqual(state.vpm, ['skipped', '跳过：「安装 .NET 8 SDK」没有完成']);
  assert.deepEqual(state['ai:codex'], ['done', '完成']);
  assert.deepEqual(state['ai:pi'], ['failed', '失败：npm ERR! network']);
  assert.match(state['winget:Microsoft.DotNet.SDK.8']![1]!, /下载失败/);
  assert.equal(job.state, 'failed');
  assert.equal(job.phase, 'done');
});


test('a declined UAC prompt stops everything; a dry run executes no user-level command', async () => {
  const plan = userPlan();
  const commands: string[][] = [];
  const refused = await runWindowsSetup(plan, DEFAULT_CHOICES, {
    runMachine: async () => ({ exitCode: 1223, refused: true, tampered: false, log: '' }),
    runCommand: async argv => { commands.push(argv); return { code: 0, output: '' }; }, refreshPath: () => assert.fail('nothing to refresh'),
  });
  assert.equal(refused.state, 'refused');
  assert.match(refused.note ?? '', /没有获得管理员授权/);
  assert.ok(refused.items.every(item => item.status === 'skipped'));
  const dry = await runWindowsSetup(plan, { ...DEFAULT_CHOICES, pi: false }, { dryRun: true,
    runMachine: async (steps, _context, options) => {
      assert.equal(options.dryRun, true);
      return { exitCode: 0, refused: false, tampered: false, log: '', status: { version: 1, state: 'done', dryRun: true, restartRequired: false,
        items: steps.map(step => ({ id: step.id, status: 'done' as const, reason: 'dry-run', message: `winget install --id '${step.package}'` })) } };
    },
    runCommand: async argv => { commands.push(argv); return { code: 0, output: '' }; }, refreshPath: () => assert.fail('a dry run changes no PATH'),
  });
  assert.deepEqual(commands, []);
  assert.equal(dry.state, 'done');
  assert.deepEqual(dry.items.filter(item => item.phase === 'user').map(item => item.message), [
    '演练：将执行 setx PYTHONUTF8 1', '演练：将执行 dotnet tool install --global vrchat.vpm.cli', '演练：将执行 npm install --global @openai/codex',
    '演练：将执行 npm install --global @anthropic-ai/claude-code']);
  assert.ok(!dry.items.some(item => item.id === 'ai:pi'), 'pi was not chosen');
});

test('the places the person is sent to open the right program, never through a shell', { skip: !windows && 'Windows programs' }, () => {
  assert.deepEqual(openCommand('restart').argv.slice(0, 4), ['shutdown.exe', '/r', '/t', '10']);
  assert.deepEqual(openCommand('app-installer').argv, ['explorer.exe', 'ms-windows-store://pdp/?productid=9NBLGGH4NNS1']);
  const register = openCommand('winget-register').argv;
  assert.equal(Buffer.from(register.at(-1)!, 'base64').toString('utf16le'),
    'Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe');
});

test('a probe of this computer reads without changing anything, also when Harness was started from PowerShell 7', { skip: !windows && 'Windows' }, async t => {
  const { probeWindowsMachine } = await import('../src/windows-setup.ts');
  // PowerShell 7 puts its own modules first in PSModulePath; a Windows PowerShell child must not inherit that.
  const prior = process.env.PSModulePath;
  t.after(() => { if (prior === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = prior; });
  process.env.PSModulePath = [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'Modules'), prior].filter(Boolean).join(';');
  const probe = probeWindowsMachine([], { workspaceRoot: 'C:\\avatar-workspace' });
  assert.ok(probe.build > 0);
  assert.ok(typeof probe.longPaths === 'boolean');
  assert.ok(probe.codePages.ACP, 'the code page is read');
  assert.ok(Object.keys(probe.powershellPolicy).includes('LocalMachine'));
  assert.equal(probe.workspace, 'C:\\avatar-workspace');
  t.diagnostic(`winget ${probe.winget ? 'present' : 'missing'}; ACP ${probe.codePages.ACP}; active ${probe.activeCodePage}`);
});


test('avh deps install --dry-run plans this computer and rehearses the elevated script without asking for elevation or changing anything',
  { skip: !windows && 'Windows setup' }, async t => {
  const { main } = await import('../src/cli.ts');
  const home = mkdtempSync(join(tmpdir(), 'avh-ws-cli-'));
  const prior = { AVH_HOME: process.env.AVH_HOME, exitCode: process.exitCode };
  const log = console.log, lines: string[] = [];
  t.after(() => {
    console.log = log; process.exitCode = prior.exitCode; removeTemp(home);
    if (prior.AVH_HOME === undefined) delete process.env.AVH_HOME; else process.env.AVH_HOME = prior.AVH_HOME;
  });
  process.env.AVH_HOME = home;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  await assert.rejects(main(['deps', '--without', 'nope']), /只能是 codex、claude、pi/);
  await main(['deps', 'install', '--dry-run', '--no-unity', '--without', 'pi']);
  console.log = log;
  const output = lines.join('\n');
  assert.match(output, /演练结束：没有做任何改动|没有需要自动完成的项目/);
  assert.doesNotMatch(output, /正在请求管理员授权/, 'a dry run never asks for elevation');
  assert.doesNotMatch(output, /^OK\t安装 pi/m, 'pi was left out');
  assert.notEqual(process.exitCode, 1, output);
  t.diagnostic(output.split('\n').filter(line => /^(OK|SKIP|FAIL)\t/.test(line)).join('\n'));
});
