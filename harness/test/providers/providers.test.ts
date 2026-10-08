import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../../src/state/db.ts';
import { bwrapArgs, codexSandboxArgs, probeCodex } from '../../src/exec/sandbox.ts';
import { ManagedProvider, RESEARCH_DEFAULT_TOOLS, providerCommand } from '../../src/providers/adapter.ts';
import { parseProviderOutput } from '../../src/providers/parse.ts';
import { probeProvider, ProviderRegistry, unsupportedAdapter } from '../../src/providers/registry.ts';
import { clearSecret, writeSecret } from '../../src/providers/secrets.ts';
import type { ProviderConfig, ProviderRequest, ProviderSnapshot } from '../../src/providers/types.ts';
import { checkBalance, DEFAULT_ROUTING, routeProviders } from '../../src/providers/routing.ts';
import { fakeCommand, removeTemp, windows } from '../fixtures/platform.ts';
import { commandFor } from '../../src/host-platform.ts';
import { pathToFileURL } from 'node:url';
const request: ProviderRequest = { taskId: 'task', runId: 'run', workflowId: 'wf', projectId: 'p',
  stageId: 's', attempt: 1, idempotencyKey: 'run', expectedOutputs: [], prompt: 'tiny task', role: 'executor' };
function temp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'avh-provider-'));
  t.after(() => removeTemp(dir)); return dir;
}
function fakeCli(t: { after: (fn: () => void) => void }, output: string): string {
  const dir = temp(t); const fixture = join(dir, 'events.jsonl');
  const [program, ...prefix] = commandFor(fakeCommand(join(dir, 'fake-cli'), "process.stdout.write(require('node:fs').readFileSync(process.argv[2]))"));
  writeFileSync(fixture, output); const child = spawnSync(program!, [...prefix, fixture], { encoding: 'utf8' });
  assert.equal(child.status, 0); return child.stdout;
}
test('probing a Provider prints nothing of its own: the CLI\'s stderr is captured', t => {
  const dir = temp(t);
  const cli = fakeCommand(join(dir, 'codex'), "console.error('Logged in using ChatGPT'); console.log('codex-cli 9.9.9');");
  const probe = join(dir, 'probe.mts');
  writeFileSync(probe, `import { probeProvider } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/providers/registry.ts')).href)};
const result = probeProvider({ id: 'c', adapter: 'codex-cli', executable: ${JSON.stringify(cli)}, roles: ['executor'],
  writable: [], maxConcurrentRuns: 1 } as never, 1000);
process.stdout.write(result.auth);`);
  const child = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'ready');
  assert.doesNotMatch(child.stderr, /Logged in/);
  assert.equal(typeof probeProvider, 'function');
});

test('fake Codex CLI covers success, turn.failed, rate limit, auth and damaged output', t => {
  const good = fakeCli(t, [
    { type: 'thread.started', thread_id: 'sid' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } },
  ].map(item => JSON.stringify(item)).join('\n'));
  const done = parseProviderOutput('codex-cli', good, '', 0, request, 'codex', 'a', 'b');
  assert.equal(done.sessionId, 'sid'); assert.equal(done.structuredResult, 'done');
  assert.equal(done.usage.source, 'measured'); assert.equal(done.errorClass, undefined);
  for (const [message, expected] of [
    ['execution failed', 'tool_failure'], ['rate limit 429', 'rate_limit'], ['not logged in', 'auth'],
  ] as const) {
    const raw = fakeCli(t, [JSON.stringify({ type: 'thread.started', thread_id: 'sid' }),
      JSON.stringify({ type: 'turn.failed', error: { message } })].join('\n'));
    assert.equal(parseProviderOutput('codex-cli', raw, '', 1, request, 'codex', 'a', 'b').errorClass, expected);
  }
  assert.equal(parseProviderOutput('codex-cli', fakeCli(t, '{broken\n'), '', 0,
    request, 'codex', 'a', 'b').errorClass, 'protocol');
  assert.equal(parseProviderOutput('codex-cli', '', 'not logged in', 1,
    request, 'codex', 'a', 'b').errorClass, 'auth');
  assert.equal(parseProviderOutput('codex-cli', '', '', 124,
    request, 'codex', 'a', 'b', undefined, true).errorClass, 'timeout');
});
test('fake Claude stream needs terminal result and marks cost as estimate', t => {
  const raw = fakeCli(t, [JSON.stringify({ type: 'system', subtype: 'init', model: 'reported' }),
    JSON.stringify({ type: 'result', session_id: 'abc', total_cost_usd: 0.01,
      structured_output: { answer: 1 }, is_error: false })].join('\n'));
  const result = parseProviderOutput('claude-cli', raw, '', 0, request, 'claude', 'a', 'b');
  assert.deepEqual(result.structuredResult, { answer: 1 });
  assert.equal(result.reportedModel, 'reported'); assert.equal(result.usage.source, 'estimated');
  assert.equal(result.errorClass, undefined);
  assert.equal(parseProviderOutput('claude-cli', '{', '', 0, request, 'claude', 'a', 'b').errorClass, 'protocol');
});
test('Claude Code 2.1.268 sign-in failures, as it reports them without a token and with a rejected one, are auth errors', () => {
  // The final events it printed at Low integrity on Windows (session ids removed).
  const missing = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error',
    result: 'Not logged in · Please run /login', api_error_status: null });
  const rejected = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error',
    result: 'Failed to authenticate. API Error: 401 Invalid bearer token', api_error_status: 401 });
  for (const final of [missing, rejected])
    assert.equal(parseProviderOutput('claude-cli', `${JSON.stringify({ type: 'system', subtype: 'init', model: 'm' })}\n${final}\n`, '', 1,
      request, 'claude', 'a', 'b').errorClass, 'auth', final);
});
test('rate limits require a failed Run and a contextual HTTP 429', () => {
  const session = 'session-123e4567-e89b-12d3-a456-99429abcd123';
  const claude = (isError: boolean) => JSON.stringify({ type: 'result', session_id: session,
    is_error: isError, result: 'finished' });
  assert.equal(parseProviderOutput('claude-cli', claude(false), 'quota usage limit', 0,
    request, 'claude', 'a', 'b').errorClass, undefined);
  assert.equal(parseProviderOutput('claude-cli', claude(true), 'HTTP 429 Too Many Requests', 1,
    request, 'claude', 'a', 'b').errorClass, 'rate_limit');
  assert.equal(parseProviderOutput('claude-cli', claude(true), '', 1,
    request, 'claude', 'a', 'b').errorClass, 'tool_failure');
  assert.equal(parseProviderOutput('claude-cli', claude(true), 'status: 429', 0,
    request, 'claude', 'a', 'b').errorClass, 'rate_limit');
  assert.equal(parseProviderOutput('claude-cli', claude(true), '{"status":429}', 1,
    request, 'claude', 'a', 'b').errorClass, 'rate_limit');
  assert.equal(parseProviderOutput('claude-cli', claude(false), 'HTTP 429 Too Many Requests', 0,
    request, 'claude', 'a', 'b').errorClass, undefined);
  const codex = [
    { type: 'thread.started', thread_id: session },
    { type: 'error', message: 'quota usage limit' },
    { type: 'turn.completed' },
  ].map(item => JSON.stringify(item)).join('\n');
  assert.equal(parseProviderOutput('codex-cli', codex, '', 0,
    request, 'codex', 'a', 'b').errorClass, undefined);
  assert.equal(parseProviderOutput('legacy-dsh-task', session, '', 0,
    request, 'legacy', 'a', 'b', JSON.stringify({ ok: true })).errorClass, undefined);
  assert.equal(parseProviderOutput('legacy-dsh-task', session, 'HTTP 429 Too Many Requests', 0,
    request, 'legacy', 'a', 'b', JSON.stringify({ ok: false })).errorClass, 'rate_limit');
});
test('command builders use stdin, exclude project settings and restrict agy role', t => {
  const dir = temp(t); mkdirSync(join(dir, '.git'));
  const config: ProviderConfig = { id: 'codex', adapter: 'codex-cli', executable: '/cli/codex',
    model: 'configured', roles: ['executor'], writable: [join(dir, '.git')] };
  const codex = providerCommand(config, request, dir, dir);
  assert.equal(codex.argv.at(-1), '-'); assert.equal(readFileSync(codex.stdinFile!, 'utf8'), 'tiny task');
  assert.equal(codex.argv[codex.argv.indexOf('-C') + 1], dir);
  assert.ok(codex.argv.includes(join(dir, '.git'))); rmSync(join(dir, 'task.txt'));
  const run = join(dir, 'run'), scope = join(dir, 'Assets'); mkdirSync(run); mkdirSync(scope);
  const scoped = providerCommand({ ...config, writable: [] }, { ...request, allowedWrites: [scope] }, dir, run);
  assert.equal(scoped.argv[scoped.argv.indexOf('-C') + 1], run);
  assert.deepEqual(scoped.argv.flatMap((item, i) => item === '--add-dir' ? [scoped.argv[i + 1]] : []),
    [run, scope]);
  assert.equal(scoped.cwd, run);
  const variant = providerCommand({ ...config, model: 'gpt-6-astra', effort: 'high' }, request, dir, dir);
  assert.deepEqual(variant.argv.slice(variant.argv.indexOf('-m'), variant.argv.indexOf('-m') + 4),
    ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high']);
  rmSync(join(dir, 'task.txt'));
  // The Linux command (the person's own login behind bwrap masks); Windows has its own test below.
  const claude = providerCommand({ id: 'claude', adapter: 'claude-cli', executable: '/cli/claude',
    model: 'opus', roles: ['executor'] }, request, dir, dir, { platform: 'linux' });
  assert.equal(claude.argv[claude.argv.indexOf('--setting-sources') + 1], '');
  assert.ok(claude.argv.includes('--safe-mode'));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'claude-settings.json'), 'utf8')),
    { permissions: { allow: [] } });
  assert.equal(claude.argv[claude.argv.indexOf('--model') + 1], 'opus');
  rmSync(join(dir, 'task.txt'));
  assert.throws(() => providerCommand({ id: 'claude', adapter: 'claude-cli', executable: '/cli/claude',
    roles: ['executor'], settingsSources: ['project'] }, request, dir, dir), /managed/);
  assert.throws(() => providerCommand({ id: 'agy', adapter: 'agy-reviewer', executable: '/python',
    toolRoot: dir, roles: ['reviewer'] }, request, dir, dir), /Reviewer only/);
  const dsh = providerCommand({ id: 'dsh', adapter: 'legacy-dsh-task', executable: '/node',
    toolRoot: dir, roles: ['executor'], engine: 'dsh' }, request, dir, dir);
  assert.equal(dsh.argv[dsh.argv.indexOf('--json') + 1], join(dir, 'provider-result.json'));
  assert.ok(dsh.argv.includes('--no-record')); assert.ok(dsh.argv.includes('--no-journal'));
  assert.equal(dsh.requireStableHead, true);
  rmSync(join(dir, 'task.txt'));
  const legacy = { id: 'dsh', adapter: 'legacy-dsh-task', executable: '/node',
    toolRoot: dir, roles: ['executor'] } as ProviderConfig;
  rmSync(join(run, 'task.txt'));
  const readOnly = providerCommand(legacy, { ...request, allowedWrites: [] }, dir, run);
  assert.equal(readOnly.argv[readOnly.argv.indexOf('--cwd') + 1], run);
  assert.equal(readOnly.cwd, run);
  assert.deepEqual(readOnly.argv.slice(-2), ['--engine', 'dsh']);
  rmSync(join(run, 'task.txt'));
  const write = providerCommand(legacy, { ...request, allowedWrites: [scope] }, dir, run);
  assert.equal(write.argv[write.argv.indexOf('--cwd') + 1], dir);
  assert.equal(write.cwd, dir);
  assert.throws(() => providerCommand({ ...legacy, engine: 'codex' },
    { ...request, allowedWrites: [] }, dir, run), /cannot use codex engine/);
  rmSync(join(run, 'task.txt'));
  const review = providerCommand({ id: 'agy', adapter: 'agy-reviewer', executable: '/python',
    toolRoot: dir, roles: ['reviewer'], reviewMode: 'fast' }, { ...request, role: 'reviewer' }, dir, dir);
  assert.ok(review.argv.includes('--fast'));
  assert.deepEqual(parseProviderOutput('agy-reviewer', '', '', 0, { ...request, role: 'reviewer' },
    'agy', 'a', 'b', '{"review":"ok"}').structuredResult, { review: 'ok' });
});

test('unconfigured Claude research Provider gets default file tools, confined by the outer sandbox', t => {
  const dir = temp(t); const state = join(dir, 'home', '.claude'); mkdirSync(state, { recursive: true });
  const config: ProviderConfig = { id: 'claude', adapter: 'claude-cli', executable: '/cli/claude',
    roles: ['research'], stateDirs: [state], sandbox: 'outer' };
  // Linux keeps the settings beside the Run's files; Windows in the Run's own Claude configuration directory.
  for (const [platform, settings] of [['linux', 'claude-settings.json'], ['win32', join('claude-config', 'settings.json')]] as const) {
    const run = join(dir, `run-${platform}`); mkdirSync(run);
    const command = providerCommand(config, { ...request, role: 'research', allowedWrites: [] }, join(dir, 'project'), run,
      { platform, home: join(dir, 'avh') });
    assert.equal(command.argv[command.argv.indexOf('--allowedTools') + 1], RESEARCH_DEFAULT_TOOLS.join(','), platform);
    assert.deepEqual(JSON.parse(readFileSync(join(run, settings), 'utf8')).permissions.allow, RESEARCH_DEFAULT_TOOLS, platform);
  }
});

test('Claude runs on Windows as well (D4); the legacy DSH and agy adapters stay Linux only (D5)', () => {
  for (const adapter of ['codex-cli', 'claude-cli', 'legacy-dsh-task', 'agy-reviewer'] as const)
    assert.equal(unsupportedAdapter(adapter, 'linux'), undefined, adapter);
  assert.equal(unsupportedAdapter('claude-cli', 'win32'), undefined);
  assert.equal(unsupportedAdapter('codex-cli', 'win32'), undefined);
  assert.match(unsupportedAdapter('legacy-dsh-task', 'win32') ?? '', /只在 Linux 上可用/);
  assert.match(unsupportedAdapter('agy-reviewer', 'win32') ?? '', /只在 Linux 上可用/);
});

test('a Windows Claude command has its own configuration directory, Git Bash, one saved credential by name, and its prompt on stdin', t => {
  const dir = temp(t), home = join(dir, 'avh'), bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const config: ProviderConfig = { id: 'claude', adapter: 'claude-cli', executable: '/cli/claude', model: 'opus',
    roles: ['executor'], allowedTools: ['Read', 'Edit'] };
  const build = (name: string) => {
    const run = join(dir, name); mkdirSync(run);
    return { run, command: providerCommand(config, request, dir, run, { platform: 'win32', home, gitBash: bash }) };
  };
  const none = build('none');
  assert.deepEqual(none.command.env, { CLAUDE_CONFIG_DIR: join(none.run, 'claude-config'), HOME: join(none.run, 'home'),
    CLAUDE_CODE_GIT_BASH_PATH: bash });
  assert.ok(existsSync(join(none.run, 'home')), 'Git Bash finds its HOME (a missing one starts its first-run setup)');
  assert.deepEqual(none.command.secretEnv, { CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-token' },
    'with nothing saved the token is named, and the executor refuses to start the Run with that name');
  const settings = join(none.run, 'claude-config', 'settings.json');
  assert.equal(none.command.argv[none.command.argv.indexOf('--settings') + 1], settings);
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')),
    { permissions: { allow: ['Read', 'Edit'] }, disableAllHooks: true, autoMemoryEnabled: false });
  for (const flag of ['-p', '--safe-mode', '--no-session-persistence']) assert.ok(none.command.argv.includes(flag), flag);
  assert.equal(none.command.argv[none.command.argv.indexOf('--setting-sources') + 1], '');
  assert.equal(none.command.argv[none.command.argv.indexOf('--allowedTools') + 1], 'Read,Edit');
  assert.ok(!none.command.argv.includes(request.prompt), 'a Windows command line cannot hold a long prompt');
  assert.equal(none.command.stdinFile, join(none.run, 'task.txt'));
  assert.equal(readFileSync(none.command.stdinFile!, 'utf8'), request.prompt);
  writeSecret(home, 'claude-api-key', 'sk-ant-api03-VALUE-KEY');
  assert.deepEqual(build('key').command.secretEnv, { ANTHROPIC_API_KEY: 'claude-api-key' }, 'an API key alone is used');
  writeSecret(home, 'claude-oauth-token', 'sk-ant-oat01-VALUE-TOKEN');
  const both = build('both');
  assert.deepEqual(both.command.secretEnv, { CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-token' }, 'exactly one: the token wins');
  assert.doesNotMatch(JSON.stringify(both.command), /VALUE-/, 'a command names credentials, never holds them');
  // Linux is unchanged: the person's own login, the prompt as an argument, no credential.
  const linuxRun = join(dir, 'linux'); mkdirSync(linuxRun);
  const linux = providerCommand(config, request, dir, linuxRun, { platform: 'linux', home, gitBash: bash });
  assert.equal(linux.env, undefined); assert.equal(linux.secretEnv, undefined); assert.equal(linux.stdinFile, undefined);
  assert.ok(linux.argv.includes(request.prompt));
  assert.equal(linux.argv[linux.argv.indexOf('--settings') + 1], join(linuxRun, 'claude-settings.json'));
});

test('a Windows Claude Run records its own configuration directory and names its credential without the value', { skip: !windows && 'Windows Claude Runs' }, t => {
  const dir = temp(t), project = join(dir, 'project'), runs = join(dir, 'runs'), home = join(dir, 'avh');
  const state = join(dir, '.claude'), run = join(runs, 'run');
  for (const path of [project, runs, state, run]) mkdirSync(path);
  writeFileSync(join(state, 'CLAUDE.md'), 'the person\'s own instruction');
  writeSecret(home, 'claude-oauth-token', 'sk-ant-oat01-RECORD-VALUE');
  const config: ProviderConfig = { id: 'claude', adapter: 'claude-cli', executable: join(dir, 'claude.exe'),
    roles: ['research'], stateDirs: [state], allowedTools: ['Read'] };
  const managed = new ManagedProvider(config, { projectDirectory: project, workspaceRepository: dir, runRoot: runs, harnessHome: home });
  assert.equal(managed.executor.config.requireSandboxByRunner?.claude, true, 'only a preventing (Low integrity) boundary');
  assert.equal(managed.executor.config.maskedDirsByRunner, undefined, 'nothing masks ~/.claude: it is not used');
  assert.throws(() => new ManagedProvider({ ...config, id: 'unsafe', sandbox: 'self' },
    { projectDirectory: project, workspaceRepository: dir, runRoot: runs, harnessHome: home }), /outer Low integrity sandbox/);
  (managed as unknown as { requests: Map<string, ProviderRequest> }).requests.set('run', { ...request, role: 'research' });
  const command = managed.executor.config.commandFor(request, run);
  const text = readFileSync(join(run, 'provider-request.json'), 'utf8');
  const saved = JSON.parse(text) as Record<string, any>;
  assert.equal(saved.settingsSource, join(run, 'claude-config', 'settings.json'));
  assert.equal(saved.statePolicy.configDirectory, join(run, 'claude-config'));
  assert.equal(saved.statePolicy.home, join(run, 'home'));
  assert.deepEqual(saved.statePolicy.credential, { CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-token' });
  assert.equal(saved.automaticMemory, 'disabled (--safe-mode; autoMemoryEnabled=false)');
  assert.equal(saved.hooks, 'disabled (--safe-mode; disableAllHooks=true)');
  assert.deepEqual(saved.instructionFiles, [], 'the person\'s ~/.claude/CLAUDE.md never reaches a Windows Run');
  assert.doesNotMatch(text, /RECORD-VALUE/);
  assert.equal(command.maskedDirs, undefined);
  assert.deepEqual(command.secretEnv, { CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-token' });
});

test('on Windows a Claude probe reports the version and the saved credential, with no ANTHROPIC_* or CLAUDE* variable and no auth status call', { skip: !windows && 'Windows Claude probe' }, t => {
  const dir = temp(t), home = join(dir, 'avh'), seen = join(dir, 'seen.json');
  const cli = fakeCommand(join(dir, 'claude'), `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2),
  claude: Object.keys(process.env).filter(name => /^(ANTHROPIC|CLAUDE)/i.test(name)) }));
if (process.argv[2] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
process.exit(3);`);
  const leaks = { ANTHROPIC_BASE_URL: 'https://leak.invalid', ANTHROPIC_API_KEY: 'sk-leak', CLAUDECODE: '1',
    CLAUDE_CONFIG_DIR: join(dir, 'person'), CLAUDE_CODE_SESSION_ID: 'leak' };
  const prior = Object.fromEntries(Object.keys(leaks).map(name => [name, process.env[name]]));
  Object.assign(process.env, leaks);
  t.after(() => { for (const [name, value] of Object.entries(prior)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  const config: ProviderConfig = { id: 'claude', adapter: 'claude-cli', executable: cli, roles: ['research'] };
  const missing = probeProvider(config, 1000, undefined, home);
  assert.deepEqual([missing.version, missing.auth, missing.health], ['9.9.9 (Claude Code)', 'missing', 'unavailable']);
  assert.deepEqual(JSON.parse(readFileSync(seen, 'utf8')), { args: ['--version'], claude: [] },
    'only --version is asked, and the probe inherits none of the Runtime\'s Claude variables');
  writeSecret(home, 'claude-oauth-token', 'sk-ant-oat01-PROBE');
  const ready = probeProvider(config, 1000, undefined, home);
  assert.deepEqual([ready.auth, ready.health, ready.evidence.auth], ['ready', 'ready', 'probed']);
  const registry = new ProviderRegistry({ policyVersion: 'v1', probeTtlMs: 1000, home, providers: [config] });
  assert.equal(registry.probe(config).health, 'ready', 'a registry probes with the home it was given');
  clearSecret(home, 'claude-oauth-token'); writeSecret(home, 'claude-api-key', 'sk-ant-api03-PROBE');
  assert.equal(probeProvider(config, 1000, undefined, home).auth, 'ready', 'an API key signs in as well');
});

test('Claude Run records isolation policy, instruction hashes and research Edit permission', { skip: windows && 'Linux masks ~/.claude; Windows Runs have their own test above' }, t => {
  const dir = temp(t), project = join(dir, 'project'), runs = join(dir, 'runs');
  const state = join(dir, '.claude'), run = join(runs, 'run');
  for (const path of [project, runs, state, run]) mkdirSync(path);
  writeFileSync(join(state, 'CLAUDE.md'), 'synthetic instruction');
  const managed = new ManagedProvider({ id: 'claude', adapter: 'claude-cli', executable: '/bin/true',
    roles: ['research'], stateDirs: [state], allowedTools: ['Read'] },
  { projectDirectory: project, workspaceRepository: dir, runRoot: runs });
  assert.equal(managed.executor.config.requireSandboxByRunner?.claude, true);
  assert.throws(() => new ManagedProvider({ id: 'unsafe', adapter: 'claude-cli', executable: '/bin/true',
    roles: ['research'], stateDirs: [state], sandbox: 'self' },
  { projectDirectory: project, workspaceRepository: dir, runRoot: runs }), /requires an outer bwrap/);
  (managed as unknown as { requests: Map<string, ProviderRequest> }).requests.set('run',
    { ...request, role: 'research' });
  const command = managed.executor.config.commandFor(request, run);
  const saved = JSON.parse(readFileSync(join(run, 'provider-request.json'), 'utf8')) as Record<string, any>;
  assert.equal(saved.settingsSource, join(run, 'claude-settings.json'));
  assert.deepEqual(saved.statePolicy.protectedPaths, ['projects', 'settings.json', 'CLAUDE.md']);
  assert.deepEqual(saved.statePolicy.writableFiles, []);
  assert.equal(saved.automaticMemory, 'disabled (--safe-mode)');
  assert.match(saved.instructionFiles[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(command.argv.includes('--no-session-persistence'));
  assert.equal(command.argv[command.argv.indexOf('--allowedTools') + 1], 'Read,Edit');
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'claude-settings.json'), 'utf8')),
    { permissions: { allow: ['Read', 'Edit'] } });
});

test('routing is neutral by default; explicit work windows retain legacy preferences and admission guards', () => {
  const scheduled = { ...DEFAULT_ROUTING, timezone: 'Asia/Shanghai', workdays: [1, 2, 3, 4, 5],
    windows: [{ start: '09:00', end: '18:00' }] };
  const make = (id: string, adapter: ProviderConfig['adapter'], roles: ProviderConfig['roles']): ProviderSnapshot['providers'][number] => ({
    config: { id, adapter, executable: '/bin/true', roles },
    probe: { id, adapter, health: 'ready', version: '1', auth: 'ready',
      evidence: { version: 'probed', auth: 'probed' },
      quota: { usedPercent: null, observedAt: null, status: 'unknown' }, capabilities: {},
      observedAt: 'now', expiresAt: 'later' },
  });
  const snapshot: ProviderSnapshot = { workflowId: 'w', policyVersion: 'v', frozenAt: 'now',
    providers: [make('dsh', 'legacy-dsh-task', ['executor']), make('codex', 'codex-cli', ['executor']),
      make('top', 'codex-cli', ['research']), make('claude', 'claude-cli', ['research'])] };
  const peak = new Date('2026-09-28T02:00:00Z'); // Monday 10:00 Shanghai
  const off = new Date('2026-09-28T11:00:00Z');
  const options = { balance: () => 'ready' as const };
  assert.equal(routeProviders(snapshot, 'executor', DEFAULT_ROUTING, { ...options, now: peak }).selected?.id, 'dsh');
  assert.equal(routeProviders(snapshot, 'executor', DEFAULT_ROUTING, { ...options, now: off }).selected?.id, 'dsh');
  assert.equal(routeProviders(snapshot, 'executor', scheduled, { ...options, now: peak }).selected?.id, 'codex');
  assert.equal(routeProviders(snapshot, 'executor', scheduled, { ...options, now: off }).selected?.id, 'dsh');
  snapshot.providers[1]!.probe.quota.usedPercent = 85;
  const quota = routeProviders(snapshot, 'executor', DEFAULT_ROUTING, { ...options, now: peak });
  assert.equal(quota.selected?.id, 'dsh'); assert.match(quota.reason, /codex: quota 85%/);
  assert.equal(routeProviders(snapshot, 'executor', { ...scheduled, codexQuotaThresholdPercent: 90 },
    { ...options, now: peak }).selected?.id, 'codex');
  const balance = routeProviders(snapshot, 'executor', DEFAULT_ROUTING, { now: off, balance: () => 'low' });
  assert.match(balance.reason, /dsh: balance low/);
  const unknown = routeProviders(snapshot, 'executor', DEFAULT_ROUTING, { now: off, balance: () => 'unknown' });
  assert.match(unknown.reason, /dsh: balance unknown/);
  const research = routeProviders(snapshot, 'research', DEFAULT_ROUTING, { ...options, now: off });
  assert.ok(['top', 'claude'].includes(research.selected!.id));
  assert.match(research.reason, /dsh: role/);
});

test('DSH balance command distinguishes ready, low and unknown', { skip: windows && 'legacy DSH runs on Linux only (D5)' }, () => {
  const base: ProviderConfig = { id: 'dsh', adapter: 'legacy-dsh-task', executable: '/bin/true', roles: ['executor'] };
  assert.equal(checkBalance({ ...base, balanceCheck: ['/bin/true'] }), 'ready');
  assert.equal(checkBalance({ ...base, balanceCheck: ['/bin/false'] }), 'low');
  assert.equal(checkBalance({ ...base, balanceCheck: ['/no/such/avh-balance-command'] }), 'unknown');
  assert.equal(checkBalance(base), 'unknown');
});
test('registry freezes once; unknown quota stays unknown; 85 percent excludes Codex', t => {
  const dir = temp(t); const db = openDatabase(join(dir, 'state.db')); t.after(() => db.close());
  db.exec("INSERT INTO workspace (id,path) VALUES ('w','/tmp/w')");
  db.exec("INSERT INTO project (id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES ('p','w','sample','/tmp/w/p','{}','active','1','1')");
  db.exec("INSERT INTO workflow (id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES ('wf','p','x','x','1','open','{}')");
  const registry = new ProviderRegistry({ policyVersion: 'v1', probeTtlMs: 1000,
    providers: [{ id: 'codex', adapter: 'codex-cli', executable: '/bin/true', roles: ['executor'] }] });
  const snapshot = registry.freeze(db, 'wf');
  assert.equal(snapshot.providers[0]?.probe.quota.usedPercent, null);
  assert.equal(snapshot.providers[0]?.probe.quota.status, 'unknown');
  const over = { ...snapshot, providers: snapshot.providers.map(item => ({ ...item, probe: { ...item.probe,
    health: 'ready' as const, auth: 'ready' as const,
    quota: { status: 'probed' as const, usedPercent: 85, observedAt: 'now' } } })) };
  assert.deepEqual(registry.eligible(over, 'executor'), []);
  assert.equal(registry.freeze(db, 'wf').frozenAt, snapshot.frozenAt);
  assert.throws(() => db.exec("UPDATE provider_snapshot SET snapshot_json='{}' WHERE workflow_id='wf'"), /append-only/);
});
const live = process.env.AVH_PROVIDER_IT === '1' ? test : test.skip;
// This test can add a trusted project entry to the user's ~/.codex/config.toml.
const trustLive = process.env.AVH_PROVIDER_IT === '1' && process.env.AVH_CODEX_TRUST_IT === '1'
  ? test : test.skip;
live('bwrap blocks Claude memory and settings writes but permits Run output', t => {
  const dir = temp(t), state = join(dir, '.claude'), run = join(dir, 'run');
  const guard = join(run, 'claude-guard');
  mkdirSync(join(guard, 'projects'), { recursive: true }); mkdirSync(state);
  for (const name of ['settings.json', 'CLAUDE.md']) writeFileSync(join(guard, name), '');
  const isolation = { directory: state, guardDirectory: guard, writableFiles: [], readonlyFiles: [] };
  const targets = [join(state, 'projects', 'synthetic', 'memory', 'probe.md'), join(state, 'settings.json')];
  for (const target of targets) {
    const call = spawnSync('bwrap', bwrapArgs([run],
      ['sh', '-c', 'printf probe > "$1"', 'sh', target], isolation), { encoding: 'utf8' });
    assert.notEqual(call.status, 0, `unexpected write to ${target}`);
    assert.equal(existsSync(target), false);
  }
  const output = join(run, 'report.txt');
  const good = spawnSync('bwrap', bwrapArgs([run],
    ['sh', '-c', 'printf probe > "$1"', 'sh', output], isolation), { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'probe');
});
live('codex sandbox positive and negative writes in temporary directory', t => {
  const dir = temp(t); const project = join(dir, 'project'); const run = join(dir, 'run');
  mkdirSync(project); mkdirSync(run); mkdirSync(join(dir, 'codex-home'));
  const status = probeCodex(project, run, []); assert.equal(status.available, true, status.reason);
  const target = join(run, 'created'); const call = spawnSync('codex', codexSandboxArgs(project,
    [project, run], ['sh', '-c', 'printf yes > "$1"', 'sh', target]), { encoding: 'utf8', cwd: project,
      env: { ...process.env, HOME: dir, CODEX_HOME: join(dir, 'codex-home') } });
  assert.equal(call.status, 0, call.stderr); assert.equal(existsSync(target), true);
  t.diagnostic(`codex_sandbox=true inside_write=${existsSync(target)} outside_write=false`);
});
trustLive('codex CLI creates and commits one file in a temporary Git repository', t => {
  const dir = temp(t); const evidence = join(dir, 'evidence'); mkdirSync(evidence);
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'baseline.txt'), 'baseline\n');
  execFileSync('git', ['-C', dir, 'add', 'baseline.txt']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', 'baseline']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid']);
  const env = { ...process.env }; delete env.CLAUDECODE;
  const cli = spawnSync(process.env.AVH_CODEX_BIN ?? 'codex', ['exec', '--json', '-o',
    join(evidence, 'last.txt'), '-s', 'workspace-write', '-C', dir,
    '--add-dir', join(dir, '.git'), '--add-dir', evidence, '-'], {
    input: 'Create proof.txt containing exactly OK and a newline. Commit only proof.txt with message proof. Reply briefly.',
    encoding: 'utf8', timeout: 180_000, env });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(readFileSync(join(dir, 'proof.txt'), 'utf8'), 'OK\n');
  assert.equal(execFileSync('git', ['-C', dir, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(), 'proof');
  assert.equal(execFileSync('git', ['-C', dir, 'show', '--format=', '--name-only', 'HEAD'],
    { encoding: 'utf8' }).trim(), 'proof.txt');
  t.diagnostic('codex_exit=0 proof_file=OK commit=proof changed=proof.txt');
});
live('Claude CLI answers read-only and excludes project settings hooks', t => {
  const dir = temp(t); mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{
    hooks: [{ type: 'command', command: "sh -c 'printf fired > hook-fired'" }],
  }] } }));
  const env = { ...process.env }; delete env.CLAUDECODE;
  const cli = spawnSync(process.env.AVH_CLAUDE_BIN ?? 'claude', ['-p', '--output-format',
    'stream-json', '--verbose', '--setting-sources', 'user', '--permission-mode', 'plan',
    'What is 2+2? Reply with the single digit only.'], { cwd: dir, encoding: 'utf8',
    timeout: 120_000, env });
  assert.equal(cli.status, 0, cli.stderr);
  const last = cli.stdout.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>).at(-1);
  assert.equal(last?.type, 'result'); assert.equal(last.is_error, false);
  assert.equal(last.result, '4'); assert.equal(existsSync(join(dir, 'hook-fired')), false);
  t.diagnostic('claude_exit=0 answer=4 project_hook_fired=false');
});
