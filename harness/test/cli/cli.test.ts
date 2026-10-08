import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify } from 'yaml';
import { openDatabase } from '../../src/state/db.ts';
import { defaultUnityLockPath, loadConfig, type UnityConfig } from '../../src/config.ts';
import { unityPlan } from '../../src/exec/unity-steps.ts';
import { LinuxUnityLauncher } from '../../src/exec/unity-launcher.ts';
import { escapeRegExp, fakeCommand, removeTemp, useHome, windows } from '../fixtures/platform.ts';
import { writeSecret } from '../../src/providers/secrets.ts';

// Build explicit synthetic orders so privacy scans never need fixture exceptions.
const syntheticOrder = ['COMM', 'a1b2c3d4'].join('-');
const otherSyntheticOrder = ['COMM', 'deadbeef'].join('-');

const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-cli-'));
  t.after(() => removeTemp(root));
  const home = join(root, 'home'); const workspace = join(root, 'workspace');
  const tools = join(root, 'tools'); const knowledge = join(root, 'knowledge'); const exportRoot = join(root, 'export');
  for (const dir of [home, workspace, tools, knowledge, exportRoot, join(home, 'config'), join(knowledge, 'process'), join(tools, '审查/perception')]) mkdirSync(dir, { recursive: true });
  for (const file of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) writeFileSync(join(tools, file), '');
  writeFileSync(join(knowledge, 'process/synthetic-flow.yaml'), readFileSync(new URL('../fixtures/process.yaml', import.meta.url)));
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: '1', t: { max_count: { value: 10, unit: 'items', maturity: 'accepted', source: 'test' } } }));
  writeFileSync(join(knowledge, 'stage-rules.yaml'), stringify({ 'synthetic-flow': { setup: { claimPatterns: ['完成'] } } }));
  const config = {
    workspaceRoot: workspace, toolRoot: tools, knowledgeRoot: knowledge, exportRoots: [exportRoot],
    knownBodies: ['ExampleBody'], projectAliases: { [`${syntheticOrder}_Good`]: ['Example'] }, sampleNames: ['ExampleSample'],
    defaultProfile: 'synthetic-flow', processDefinitions: { 'synthetic-flow': 'process/synthetic-flow.yaml' },
    thresholdsFile: 'thresholds.yaml', stageRulesFile: 'stage-rules.yaml',
  };
  const configPath = join(home, 'config/harness.yaml');
  writeFileSync(configPath, stringify(config));
  function run(...args: string[]) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, AVH_HOME: home } }); }
  // The pack verbs need the running service; these two paths are decided before it is contacted, and
  // they are the ones the argument handling gets wrong (決定記録 D-97).
  test('managed refuses a stray argument and a missing pack id before reaching the service', () => {
    const stray = run('managed', 'list', 'extra');
    assert.match(stray.stderr, /未知参数/);
    const missing = run('managed', 'activate');
    assert.match(missing.stderr, /用法/);
  });
  // DATA/D8: the trace chain had no user surface. Its arguments are decided before the service is contacted too.
  test('managed trace names exactly one of a receipt or a candidate', () => {
    assert.match(run('managed', 'trace').stderr, /用法/);
    assert.match(run('managed', 'trace', '--receipt', 'a'.repeat(32), '--candidate', 'b').stderr, /用法/);
    assert.match(run('managed', 'trace', '--receipt', 'a'.repeat(32), 'extra').stderr, /未知参数/);
    assert.match(run('managed', 'trace', '--candidate').stderr, /缺少参数/);
  });
  function project(name: string, valid = true): string {
    const path = join(workspace, name);
    mkdirSync(path);
    if (valid) { mkdirSync(join(path, 'ProjectSettings')); writeFileSync(join(path, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n'); }
    writeFileSync(join(path, '_施工记录.md'), '测试记录 ExampleBody\n');
    return path;
  }
  return { root, home, workspace, knowledge, config, configPath, run, project };
}

// 流程判据 F26：警告接受必须先有正常人工入口，且入口的错误要先说清楚参数问题。
test('warning list and accept are reachable from the command line', t => {
  const f = fixture(t);
  const list = f.run('warning', 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /workflow\tstage\tcheck/);
  assert.match(f.run('warning', 'accept', 'wf:check').stderr, /--note/);
  assert.match(f.run('warning', 'accept', 'nocolon', '--note', 'x').stderr, /格式/);
  assert.match(f.run('warning', 'accept', 'wf:check', '--note', 'x').stderr, /不是正式制作流程|找不到制作流程/);
});
test('init keeps an existing configuration and creates home directories', t => {
  const f = fixture(t);
  const original = readFileSync(f.configPath, 'utf8');
  const result = f.run('workspace', 'init');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /未覆盖/);
  assert.equal(readFileSync(f.configPath, 'utf8'), original);
  assert.ok(existsSync(join(f.home, 'reports')));
});
test('doctor names a global Codex instruction file in temporary CODEX_HOME', t => {
  const f = fixture(t), codexHome = join(f.root, 'codex-home');
  mkdirSync(codexHome); writeFileSync(join(codexHome, 'AGENTS.md'), 'synthetic instruction');
  const result = spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8',
    env: { ...process.env, AVH_HOME: f.home, CODEX_HOME: codexHome, HOME: f.root } });
  assert.match(result.stdout, /这个文件会影响每个 Codex 任务/);
  assert.match(result.stdout, /codex-home[\\/]AGENTS\.md/);
});
test('doctor on Windows checks Claude Code like any Provider, ready once a token is saved; ~/.claude/CLAUDE.md does not reach it', { skip: !windows && 'Windows Claude Runs' }, t => {
  const f = fixture(t);
  const claude = fakeCommand(join(f.root, 'claude'), "if (process.argv[2] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }\nprocess.exit(3);");
  writeFileSync(f.configPath, stringify({ ...f.config, providers: [{ id: 'claude', type: 'claude-cli', executable: claude, roles: ['research'] }] }));
  mkdirSync(join(f.root, '.claude')); writeFileSync(join(f.root, '.claude', 'CLAUDE.md'), 'the person\'s own instruction');
  const doctor = () => spawnSync(process.execPath, [cli, 'doctor'], { encoding: 'utf8',
    env: { ...process.env, AVH_HOME: f.home, HOME: f.root, USERPROFILE: f.root } });
  const missing = doctor();
  assert.doesNotMatch(missing.stdout, /暂不启用/, 'Claude is no longer reported as disabled on Windows');
  assert.match(missing.stdout, /FAIL\tProvider claude\tversion=9\.9\.9 \(Claude Code\); login=missing; [^\n]*还没有保存/);
  assert.doesNotMatch(missing.stdout, /每个 Claude 任务/, 'a Windows Claude Run has its own configuration directory');
  writeSecret(f.home, 'claude-oauth-token', 'sk-ant-oat01-DOCTOR-VALUE');
  const ready = doctor();
  assert.match(ready.stdout, /OK\tProvider claude\tversion=9\.9\.9 \(Claude Code\); login=ready/);
  assert.doesNotMatch(ready.stdout + ready.stderr, /DOCTOR-VALUE/);
});
test('import report and brief include generated_from provenance', t => {
  const f = fixture(t); const project = f.project('ExampleSample');
  const result = f.run('project', 'import', project, '--kind', 'sample', '--json');
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as { report: { generated_from: Record<string, string> }; briefPath: string };
  assert.match(output.report.generated_from.harness_version, /^[0-9a-f]{12}(?:\+dirty)?$/);
  assert.match(output.report.generated_from.knowledge_version, /^unknown:/);
  assert.match(output.report.generated_from.interpretation_hash, /^[0-9a-f]{12}$/);
  assert.match(readFileSync(output.briefPath, 'utf8'), /来源版本：Harness .*；知识层 .*；导入解释/);
});

test('init writes a generic template in an empty AVH_HOME', t => {
  const f = fixture(t);
  rmSync(f.home, { recursive: true });
  const result = f.run('workspace', 'init');
  assert.equal(result.status, 0, result.stderr);
  const template = readFileSync(f.configPath, 'utf8');
  assert.match(template, /workspaceRoot: \/path\/to\/avatar-workspace/);
  assert.match(template, /stateDbPath: state\/harness.db/);
  assert.match(template, /stageRules: process\/example-flow-stage-rules.yaml/);
  assert.match(template, /projectAliases:\s*\n  ExampleProject:\s*\n    - ExampleAlias/);
  assert.ok(existsSync(join(f.home, 'state')));
});

test('projectAliases rejects the former list form when loading configuration', t => {
  const f = fixture(t);
  writeFileSync(f.configPath, stringify({ ...f.config, projectAliases: ['Example'] }));
  assert.throws(() => loadConfig(f.home), /projectAliases: 列表写法已不支持，请改为按项目目录名映射/);
  const result = f.run('project', 'import-all');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /projectAliases: 列表写法已不支持/);
});

test('the contribution upstream needs no token and the contributor name is optional', t => {
  const f = fixture(t);
  writeFileSync(f.configPath, stringify({ ...f.config, contributionUpstream: { endpoint: 'https://harness.example/v1/contributions' },
    contributorName: '  喵  ' }));
  const loaded = loadConfig(f.home);
  assert.deepEqual(loaded.contributionUpstream, { endpoint: 'https://harness.example/v1/contributions' });
  assert.equal(loaded.contributorName, '喵');
  writeFileSync(f.configPath, stringify({ ...f.config, contributorName: '' }));
  assert.equal(loadConfig(f.home).contributorName, undefined, 'an empty name means no name');
  writeFileSync(f.configPath, stringify({ ...f.config, contributorName: 'x'.repeat(65) }));
  assert.throws(() => loadConfig(f.home), /contributorName: 最多 64 个字符/);
});

test('a CLI installed but never run leaves no state directory, and the configuration still loads', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'fresh-home')); useHome(t, join(f.root, 'fresh-home'));
  const provider = (type: string, stateDirs?: string[]) => ({ id: type, type, executable: '/bin/true', roles: ['executor'],
    ...(stateDirs ? { stateDirs } : {}) });
  writeFileSync(f.configPath, stringify({ ...f.config, providers: [provider('codex-cli'), provider('claude-cli')] }));
  assert.deepEqual(loadConfig(f.home).providers.map(item => item.stateDirs), [[], []]);
  writeFileSync(f.configPath, stringify({ ...f.config, providers: [provider('codex-cli', ['~/named-but-missing'])] }));
  assert.throws(() => loadConfig(f.home), /providers\[0\]\.stateDirs\[0\]: 目录不可用/, 'a directory named explicitly is still required');
});

test('a pi Provider names its service; model, key name, address and roles default from it, and bad values are refused', t => {
  const f = fixture(t);
  const write = (providers: unknown[]) => writeFileSync(f.configPath, stringify({ ...f.config, providers }));
  write([{ id: 'deepseek', type: 'pi-cli', upstream: 'deepseek' }, { id: 'glm', type: 'pi-cli', upstream: 'zhipu', roles: ['executor'] },
    { id: 'glm-intl', type: 'pi-cli', upstream: 'zai', executable: 'pi-dev', model: 'glm-4.7', baseUrl: 'https://proxy.example/api/paas/v4/',
      secret: 'my-zai', effort: 'high', allowedTools: ['read', 'bash'], maxConcurrentRuns: 2 }]);
  const [deepseek, glm, intl] = loadConfig(f.home).providers;
  assert.deepEqual(deepseek, { id: 'deepseek', adapter: 'pi-cli', executable: 'pi', roles: ['executor', 'diagnostician', 'research'],
    upstream: 'deepseek', model: 'deepseek-flash', secret: 'pi-deepseek', writable: [], stateDirs: [], network: true, sandbox: 'outer',
    maxConcurrentRuns: 1, capabilities: {} }, 'no family: routing counts it as codex, and its context is compiled for its model');
  assert.deepEqual([glm!.model, glm!.secret, glm!.baseUrl, glm!.roles], ['glm-5.3-flash', 'pi-zhipu', 'https://open.bigmodel.cn/api/coding/paas/v4', ['executor']]);
  assert.deepEqual([intl!.executable, intl!.model, intl!.secret, intl!.baseUrl, intl!.effort, intl!.allowedTools, intl!.maxConcurrentRuns],
    ['pi-dev', 'glm-4.7', 'my-zai', 'https://proxy.example/api/paas/v4', 'high', ['read', 'bash'], 2]);
  for (const [entry, message] of [
    [{ upstream: 'openai' }, /upstream: 应为 deepseek/],
    [{ upstream: 'deepseek', sandbox: 'self' }, /只能是 outer/],
    [{ upstream: 'deepseek', baseUrl: 'http://api.example/v1' }, /只允许 HTTPS/],
    [{ upstream: 'deepseek', baseUrl: 'https://user:pw@api.example/v1' }, /不得包含凭据/],
    [{ upstream: 'deepseek', secret: '../config' }, /凭据名/],
    [{ upstream: 'deepseek', effort: 'extreme' }, /effort: 应为/],
    [{ upstream: 'deepseek', allowedTools: ['browser'] }, /没有工具 browser/],
    [{ upstream: 'deepseek', model: '--help' }, /模型名/],
    [{ upstream: 'deepseek', stateDirs: ['~'] }, /不用配置/],
  ] as const) {
    write([{ id: 'p', type: 'pi-cli', ...entry }]);
    assert.throws(() => loadConfig(f.home), message, JSON.stringify(entry));
  }
});

test('doctor checks the Unity editor a configuration would start', t => {
  const f = fixture(t);
  const editor = join(f.root, 'Editor', 'Unity'), lockPath = join(f.home, 'state/unity-batch.lock');
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { editor, lockPath } }));
  assert.match(f.run('doctor').stdout, new RegExp(`FAIL\tUnity 编辑器\t找不到：${escapeRegExp(editor)}`));
  mkdirSync(join(f.root, 'Editor')); writeFileSync(editor, '#!/bin/sh\n'); chmodSync(editor, 0o755);
  assert.match(f.run('doctor').stdout, new RegExp(`OK\tUnity 编辑器\t${escapeRegExp(editor)}`));
});

test('the machine Unity slot count is refused when the configuration loads and shown, with its source, by doctor', t => {
  const f = fixture(t);
  const previous = process.env.AVH_UNITY_SLOTS;
  t.after(() => { if (previous === undefined) delete process.env.AVH_UNITY_SLOTS; else process.env.AVH_UNITY_SLOTS = previous; });
  delete process.env.AVH_UNITY_SLOTS;
  assert.deepEqual(loadConfig(f.home).unitySlots, { count: windows ? 2 : 1, source: 'default' });
  assert.match(f.run('doctor').stdout, /OK\tUnity 槽位\t\d+ 个（缺省）/);
  process.env.AVH_UNITY_SLOTS = '3';
  assert.deepEqual(loadConfig(f.home).unitySlots, { count: 3, source: 'env' });
  assert.match(f.run('doctor').stdout, /OK\tUnity 槽位\t3 个（环境变量 AVH_UNITY_SLOTS）/);
  // A blank value means unset, as it does for every other optional variable; anything else must be refused, because
  // the launcher would otherwise be the first to notice — in the middle of a Run.
  for (const bad of ['0', '-1', '2.5', 'nine', '9', 'one']) {
    process.env.AVH_UNITY_SLOTS = bad;
    assert.throws(() => loadConfig(f.home), /AVH_UNITY_SLOTS: 应为 1 至 8 的整数/, bad);
    const doctor = f.run('doctor');
    assert.match(doctor.stdout, /FAIL\tUnity 槽位\t/, bad);
    assert.equal(doctor.status, 1, `a refused slot count must fail doctor: ${bad}`);
  }
  process.env.AVH_UNITY_SLOTS = '  ';
  assert.deepEqual(loadConfig(f.home).unitySlots, { count: windows ? 2 : 1, source: 'default' });
});

test('the configured Unity editor is what the launcher starts, even beside a legacy runner script', t => {
  const f = fixture(t);
  const previous = process.env.UNITY_BIN; delete process.env.UNITY_BIN;
  t.after(() => { if (previous !== undefined) process.env.UNITY_BIN = previous; });
  const editor = '/opt/unity/2022.3.22f1/Editor/Unity', lockPath = join(f.home, 'state/unity-batch.lock');
  const step = { method: 'Example.Batch.Run', quit: true, env: {} };
  const started = () => new LinuxUnityLauncher(loadConfig(f.home).unity!).plan(step, f.workspace, f.home).argv[0];
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { editor, lockPath } }));
  assert.equal(loadConfig(f.home).unity!.runner, editor, 'an editor alone is enough');
  assert.equal(started(), editor);
  const legacy = join(f.root, 'unity_run.sh');
  writeFileSync(legacy, 'U=${UNITY_BIN:-/opt/legacy/Editor/Unity}\n');
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { runner: legacy, editor, lockPath } }));
  assert.equal(started(), editor, 'the editor wins over the legacy script default');
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { runner: legacy, lockPath } }));
  assert.equal(started(), '/opt/legacy/Editor/Unity', 'a legacy config keeps working');
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { editor } }));
  assert.equal(loadConfig(f.home).unity!.lockPath, defaultUnityLockPath(realpathSync(f.home)), 'an editor alone is a complete section');
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { runner: 'unity_run.sh', editor, lockPath } }));
  assert.equal(started(), editor, 'the relative runner an early wizard wrote is ignored beside an editor');
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { lockPath } }));
  assert.throws(() => loadConfig(f.home), /unity.editor: 需要 Unity 可执行文件的绝对路径/);
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { editor: 'Unity', lockPath } }));
  assert.throws(() => loadConfig(f.home), /必须为绝对路径/);
});

test('unity configuration loads defaults and rejects unsafe seed and environment paths', t => {
  const f = fixture(t);
  const unity = { runner: join(f.root, 'unity-runner'), lockPath: join(f.root, 'unity.lock') };
  writeFileSync(f.configPath, stringify({ ...f.config, unity }));
  const defaults = loadConfig(f.home).unity!;
  assert.deepEqual(defaults, { ...unity, busyExitCode: 5, homeSeedFrom: [],
    projectScratch: ['Library', 'Temp', 'Logs', 'UserSettings', 'obj'], defaultTimeoutSec: 3600,
    passEnv: ['DISPLAY', 'WAYLAND_DISPLAY', 'PATH', 'LANG', 'XDG_RUNTIME_DIR'] });
  const priorLang = process.env.LANG;
  process.env.LANG = 'C.UTF-8';
  try {
    const step = { method: 'Example.Batch.Run', quit: true, env: {} };
    const plan = (config: UnityConfig) => unityPlan(config, step, f.workspace, f.home, 1, join(f.home, 'unity-home'));
    assert.equal(plan(defaults).env.PATH, process.env.PATH);
    assert.equal(plan(defaults).env.LANG, 'C.UTF-8');
    writeFileSync(f.configPath, stringify({ ...f.config, unity: { ...unity, passEnv: ['DISPLAY'] } }));
    const explicit = loadConfig(f.home).unity!;
    assert.deepEqual(explicit.passEnv, ['DISPLAY', 'PATH']);
    assert.equal(plan(explicit).env.PATH, process.env.PATH);
  } finally { if (priorLang === undefined) delete process.env.LANG; else process.env.LANG = priorLang; }
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { ...unity, homeSeedFrom: ['../outside'] } }));
  assert.throws(() => loadConfig(f.home), /unity 相对路径不得越界/);
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { ...unity, passEnv: ['HOME'] } }));
  assert.throws(() => loadConfig(f.home), /unity.passEnv: 不得覆盖隔离环境/);
  writeFileSync(f.configPath, stringify({ ...f.config, unity: { ...unity, passEnv: ['DBUS_SESSION_BUS_ADDRESS'] } }));
  assert.throws(() => loadConfig(f.home), /unity.passEnv: 不得覆盖隔离环境/);
});

test('decisionTables config maps headings and rejects incomplete mappings', t => {
  const f = fixture(t);
  const decisionTables = [{ glob: '_长程任务_*/待用户复核_*.md', columns: {
    id: '编号', project: '工程', question: '问题', choice: '我选的', answer: '你的意见', flag: '编号', time: '时间',
  } }];
  writeFileSync(f.configPath, stringify({ ...f.config, import: { decisionTables } }));
  assert.deepEqual(loadConfig(f.home).importByProfile['synthetic-flow']?.decisionTables, decisionTables);
  writeFileSync(f.configPath, stringify({ ...f.config, import: { decisionTables: [{ glob: '../outside.md', columns: decisionTables[0]!.columns }] } }));
  assert.throws(() => loadConfig(f.home), /decisionTables\[0\]\.glob/);
  writeFileSync(f.configPath, stringify({ ...f.config, import: { decisionTables: [{ glob: 'x.md', columns: { id: '编号' } }] } }));
  assert.throws(() => loadConfig(f.home), /decisionTables\[0\]\.columns\.project/);
});

test('import config loads ledger patterns, alias groups, meta programs and decision titles', t => {
  const f = fixture(t);
  const settings = { externalLedgerFiles: ['待问用户*.md'], aliasGroups: { 三单: ['ProjectA', 'ProjectB', 'ProjectC'] },
    metaPrograms: ['_长程任务_meta'], decisionTitlePatterns: ['拍板', '用户定'] };
  writeFileSync(f.configPath, stringify({ ...f.config, import: settings }));
  const loaded = loadConfig(f.home).importByProfile['synthetic-flow']!;
  assert.deepEqual(loaded.externalLedgerFiles, settings.externalLedgerFiles);
  assert.deepEqual(loaded.aliasGroups, settings.aliasGroups);
  assert.deepEqual(loaded.metaPrograms, settings.metaPrograms);
  assert.deepEqual(loaded.decisionTitlePatterns, settings.decisionTitlePatterns);
  writeFileSync(f.configPath, stringify({ ...f.config, import: { metaPrograms: 'wrong' } }));
  assert.throws(() => loadConfig(f.home), /import\.metaPrograms: 应为字符串列表/);
  writeFileSync(f.configPath, stringify({ ...f.config, import: { decisionTitlePatterns: ['['] } }));
  assert.throws(() => loadConfig(f.home), /import\.decisionTitlePatterns\[0\]: 正则无效/);
});

test('Provider state directories expand home, merge defaults, and reject missing named directories', t => {
  const f = fixture(t);
  useHome(t, f.root);
  for (const path of ['.codex', '.claude', '.dsh', 'state-extra', 'agy-state']) mkdirSync(join(f.root, path));
  const provider = (type: string, stateDirs?: string[]) => ({ id: type, type, executable: '/bin/true',
    roles: type === 'agy' ? ['reviewer'] : ['executor'], ...(stateDirs ? { stateDirs } : {}) });
  const save = (entries: object[]) => writeFileSync(f.configPath, stringify({ ...f.config, providers: entries }));
  save([provider('codex-cli', ['~/state-extra']), provider('claude-cli'),
    provider('legacy-dsh-task', ['~/state-extra']), provider('agy', ['~/agy-state'])]);
  const loaded = loadConfig(f.home).providers;
  assert.deepEqual(loaded.map(item => item.stateDirs), [
    [join(f.root, '.codex'), join(f.root, 'state-extra')], [join(f.root, '.claude')],
    [join(f.root, '.dsh'), join(f.root, 'state-extra')], [join(f.root, 'agy-state')],
  ]);
  assert.ok(loaded.every(item => item.network === true));
  assert.deepEqual(loaded.map(item => item.sandbox), ['self', 'outer', 'self', 'outer']);
  assert.deepEqual(loaded.map(item => item.family), ['codex', 'codex', 'dsh', 'codex']);
  assert.deepEqual(loadConfig(f.home).routing, {
    timezone: 'UTC', workdays: [], windows: [],
    codexQuotaThresholdPercent: 85,
  });
  writeFileSync(f.configPath, stringify({ ...f.config, routing: { timezone: 'UTC', workdays: [6],
    windows: [{ start: '10:00', end: '11:00' }], codexQuotaThresholdPercent: 90 },
    providers: [provider('codex-cli')] }));
  assert.equal(loadConfig(f.home).routing.codexQuotaThresholdPercent, 90);
  writeFileSync(f.configPath, stringify({ ...f.config, routing: { timezone: 'Invalid/Zone' },
    providers: [provider('codex-cli')] }));
  assert.throws(() => loadConfig(f.home), /routing.timezone/);
  save([{ ...provider('codex-cli'), id: 'daily', model: 'gpt-6-sol', effort: 'medium' },
    { ...provider('codex-cli'), id: 'top', model: 'gpt-6-astra', effort: 'high', roles: ['research'] }]);
  assert.deepEqual(loadConfig(f.home).providers.map(item => [item.id, item.model, item.effort]),
    [['daily', 'gpt-6-sol', 'medium'], ['top', 'gpt-6-astra', 'high']]);
  save([{ ...provider('codex-cli'), sandbox: 'invalid' }]);
  assert.throws(() => loadConfig(f.home), /providers\[0\]\.sandbox/);
  save([provider('codex-cli', ['~/missing'])]);
  assert.throws(() => loadConfig(f.home), /providers\[0\]\.stateDirs\[1\]: 目录不可用/);
  save([provider('agy')]);
  assert.throws(() => loadConfig(f.home), /providers\[0\]\.stateDirs: agy 需要配置状态目录/);
  save([{ ...provider('claude-cli'), network: 'yes' }]);
  assert.throws(() => loadConfig(f.home), /providers\[0\]\.network: 应为布尔值/);
  save([{ ...provider('claude-cli'), network: false }]);
  assert.equal(loadConfig(f.home).providers[0]?.network, false);
  rmSync(join(f.root, '.claude'), { recursive: true });
  assert.deepEqual(loadConfig(f.home).providers[0]?.stateDirs, [], 'a missing default is left out, not fatal');
});

test('import-all uses only each project own aliases in long-term and archived ledgers', t => {
  const f = fixture(t);
  const first = `${syntheticOrder}_First`; const second = `${otherSyntheticOrder}_Second`;
  f.project(first); f.project(second);
  writeFileSync(f.configPath, stringify({ ...f.config, projectAliases: { [first]: ['FirstAlias'], [second]: ['SecondAlias'] } }));
  const ledger = join(f.workspace, '_长程任务_2026');
  mkdirSync(join(ledger, '_归档'), { recursive: true });
  writeFileSync(join(ledger, '账本.md'), [
    '- [ ] A-001 FirstAlias 待办 — 负责：测试',
    '- [ ] B-001 SecondAlias 待办 — 负责：测试',
  ].join('\n'));
  writeFileSync(join(ledger, '_归档', '停滞项_2026.md'), [
    '- [ ] A-002 FirstAlias 归档待办 — 负责：测试',
    '- [ ] B-002 SecondAlias 归档待办 — 负责：测试',
  ].join('\n'));
  const result = f.run('project', 'import-all');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const db = openDatabase(join(f.home, 'state/harness.db'));
  const rows = db.prepare('SELECT report_json FROM import_report').all() as { report_json: string }[];
  db.close();
  assert.equal(rows.length, 2);
  const reports = Object.fromEntries(rows.map(row => {
    const report = JSON.parse(row.report_json) as { projectPath: string; externalLedger: { id: string }[] };
    return [report.projectPath.split(/[\\/]/).at(-1), report.externalLedger.map(item => item.id).sort()];
  }));
  assert.deepEqual(reports[first], ['A-001', 'A-002']);
  assert.deepEqual(reports[second], ['B-001', 'B-002']);
});

test('import-all and list count cleanup separately from blocking review failures', t => {
  const f = fixture(t);
  const name = `${syntheticOrder}_Good`; f.project(name);
  writeFileSync(join(f.root, 'tools', 'project_fingerprint.py'),
    'import json, sys\njson.dump({"ok": True}, open(sys.argv[sys.argv.index("--out") + 1], "w"))\n');
  writeFileSync(join(f.root, 'tools', '审查/perception/strip_audit.py'),
    'import json\nprint(json.dumps({"project":"synthetic","findings":[{"path":"Assets/TempA","strip":True,"status":"present"},{"path":"Assets/TempB","strip":True,"status":"present"}]}))\n');
  const all = f.run('project', 'import-all');
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /项目\tkind\t素体首选\t状态计数\t复核失败\t待清理\t未收结/);
  const allRow = all.stdout.split('\n').find(line => line.startsWith(`${name}\t`))!;
  assert.deepEqual(allRow.split('\t').slice(-3), ['0', '2', '0']);
  const list = f.run('project', 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /项目\tkind\t最近导入\t状态计数\t复核失败\t待清理\t未收结/);
  const listRow = list.stdout.split('\n').find(line => line.startsWith(`${name}\t`))!;
  assert.deepEqual(listRow.split('\t').slice(-3), ['0', '2', '0']);
});

test('loads per-process stage rules and retains legacy stageRulesFile support', t => {
  const f = fixture(t);
  assert.deepEqual(loadConfig(f.home).importByProfile['synthetic-flow']?.stageRules?.setup?.claimPatterns, ['完成']);
  writeFileSync(join(f.knowledge, 'process/synthetic-rules.yaml'), stringify({
    schema: 'stage-rules/0.1', process: 'synthetic-flow',
    stageRules: { setup: { claimPatterns: ['已完成'], verificationIds: ['artifacts'], notApplicablePatterns: ['不适用'] } },
  }));
  const { stageRulesFile: _legacy, ...withoutLegacy } = f.config;
  writeFileSync(f.configPath, stringify({ ...withoutLegacy, processDefinitions: {
    'synthetic-flow': { definition: 'process/synthetic-flow.yaml', stageRules: 'process/synthetic-rules.yaml' },
  } }));
  assert.equal(f.run('doctor').status, 0);
  assert.deepEqual(loadConfig(f.home).importByProfile['synthetic-flow']?.stageRules?.setup?.claimPatterns, ['已完成']);
});

test('per-process stage rules reject mismatched process, unknown stage, and invalid pattern', t => {
  const f = fixture(t);
  const { stageRulesFile: _legacy, ...withoutLegacy } = f.config;
  writeFileSync(f.configPath, stringify({ ...withoutLegacy, processDefinitions: {
    'synthetic-flow': { definition: 'process/synthetic-flow.yaml', stageRules: 'process/synthetic-rules.yaml' },
  } }));
  const path = join(f.knowledge, 'process/synthetic-rules.yaml');
  const rule = (process: string, stageRules: object) => writeFileSync(path, stringify({ schema: 'stage-rules/0.1', process, stageRules }));
  rule('other-flow', { setup: {} });
  assert.match(f.run('doctor').stdout, /processDefinitions\.synthetic-flow\.stageRules\.process/);
  rule('synthetic-flow', { nonexistent: {} });
  assert.match(f.run('doctor').stdout, /processDefinitions\.synthetic-flow\.stageRules\.stageRules\.nonexistent/);
  rule('synthetic-flow', { setup: { claimPatterns: ['['] } });
  assert.match(f.run('doctor').stdout, /processDefinitions\.synthetic-flow\.stageRules\.stageRules\.setup\.claimPatterns\[0\]: 正则无效/);
});

test('rejects both stage rule sources for the same process', t => {
  const f = fixture(t);
  writeFileSync(f.configPath, stringify({ ...f.config, processDefinitions: {
    'synthetic-flow': { definition: 'process/synthetic-flow.yaml', stageRules: 'process/synthetic-rules.yaml' },
  } }));
  const result = f.run('doctor');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /processDefinitions\.synthetic-flow\.stageRules: 与 stageRulesFile\.synthetic-flow 同时配置/);
});

test('doctor identifies a bad config field and a stage id absent from its process', t => {
  const f = fixture(t);
  writeFileSync(f.configPath, stringify({ ...f.config, workspaceRoot: join(f.root, 'missing') }));
  const missing = f.run('doctor');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /workspaceRoot/);
  writeFileSync(f.configPath, stringify(f.config));
  writeFileSync(join(f.knowledge, 'stage-rules.yaml'), stringify({ 'synthetic-flow': { nonexistent: {} } }));
  const badStage = f.run('doctor');
  assert.notEqual(badStage.status, 0);
  assert.match(badStage.stdout, /stageRulesFile\.synthetic-flow\.nonexistent/);
});

test('doctor reports isolation mode and rejects state inside workspace', t => {
  const f = fixture(t);
  const healthy = f.run('doctor');
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr);
  assert.match(healthy.stdout, /执行器写范围.*(?:OS 级隔离可用|仅越界扫描)/);
  assert.match(healthy.stdout, /UNKNOWN\tProvider\t未声明 Provider/);
  writeFileSync(f.configPath, stringify({ ...f.config, stateDbPath: join(f.workspace, 'state.db') }));
  const invalid = f.run('doctor');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout, /stateDbPath/);
});

test('import-all continues after one project fails; list and brief use persisted report', t => {
  const f = fixture(t);
  const good = f.project(`${syntheticOrder}_Good`);
  f.project(`${otherSyntheticOrder}_Bad`, false);
  const original = readFileSync(join(good, '_施工记录.md'), 'utf8');
  const all = f.run('project', 'import-all');
  assert.notEqual(all.status, 0);
  assert.match(all.stdout, new RegExp(String.raw`${syntheticOrder}_Good`));
  assert.match(all.stdout, /导入失败 1 项/);
  assert.match(all.stderr, new RegExp(String.raw`${otherSyntheticOrder}_Bad.*Missing ProjectSettings`));
  assert.equal(readFileSync(join(good, '_施工记录.md'), 'utf8'), original);
  const db = openDatabase(join(f.home, 'state/harness.db'));
  const rows = db.prepare('SELECT id FROM import_report').all() as { id: string }[];
  db.close();
  assert.equal(rows.length, 1);
  const list = f.run('project', 'list');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, new RegExp(String.raw`${syntheticOrder}_Good`));
  assert.doesNotMatch(list.stdout, new RegExp(String.raw`${otherSyntheticOrder}_Bad`));
  const brief = f.run('project', 'brief', rows[0]!.id);
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stdout, new RegExp(String.raw`接手简报：${syntheticOrder}_Good`));
  const byName = f.run('project', 'brief', `${syntheticOrder}_Good`);
  assert.equal(byName.stdout, brief.stdout);
  assert.ok(existsSync(join(f.home, 'reports', `${rows[0]!.id}.md`)));
  const one = f.run('project', 'import', good, '--json');
  assert.equal(one.status, 0, one.stderr);
  assert.equal(JSON.parse(one.stdout).report.projectPath, good);
});
