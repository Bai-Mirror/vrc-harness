import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { UnitExecutor } from '../../src/exec/executor.ts';
import { releaseLedgers, windowsHelper } from '../../src/exec/windows-helper.ts';
import { ManagedProvider, providerCommand } from '../../src/providers/adapter.ts';
import { parseProviderOutput } from '../../src/providers/parse.ts';
import { classifyPiFailure, windowsGitBash, zhipuResetTime, PI_RETRY_SETTINGS, PI_NETWORK_PRELOAD, piTools, piPrompt, piConnectionProgress } from '../../src/providers/pi.ts';
import { piChoices, withPiChoices } from '../../src/shared/pi.ts';
import { probeProvider } from '../../src/providers/registry.ts';
import { REDACTED_SECRET, redactSecretValues, writeSecret } from '../../src/providers/secrets.ts';
import type { ProviderConfig, ProviderRequest, ProviderResult, ProviderSnapshot } from '../../src/providers/types.ts';
import { DEFAULT_ROUTING, providerFamily, routeProviders } from '../../src/providers/routing.ts';
import type { RunHandle } from '../../src/runtime/interfaces.ts';
import { fakeCommand, removeTemp, windows } from '../fixtures/platform.ts';
import { readIfPresent, waitFor } from '../fixtures/wait.ts';

/**
 * The pi adapter (src/providers/pi.ts). Event streams below follow what pi 0.73.1 and 0.87.1 print in `--mode json`
 * (recorded against a local stand-in for the model service, never a real one): 0.73 repeats the whole message in each
 * message_update and formats a service error as "401 <message>", 0.87 sends deltas, adds agent_settled and formats it
 * as "401: {<error object>}".
 */
const request: ProviderRequest = { taskId: 'task', runId: 'run', workflowId: 'wf', projectId: 'p', stageId: 's', attempt: 1,
  idempotencyKey: 'run', expectedOutputs: [], prompt: 'tiny task', role: 'executor' };
function temp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'avh-pi-')); t.after(() => removeTemp(dir)); return dir;
}
const pi = (upstream: ProviderConfig['upstream'], extra: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ id: 'p', adapter: 'pi-cli', executable: '/cli/pi', roles: ['executor'], upstream, ...extra });

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
const usage = (u: Usage) => ({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
  totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost } });
type Reply = { text?: string; tool?: string; stopReason?: string; errorMessage?: string; usage?: Usage; model?: string; responseModel?: string };
/** A `pi --mode json` stream in the shape of one pi version. */
function stream(version: '0.73' | '0.87', replies: Reply[], provider = 'deepseek'): string {
  const lines: unknown[] = [{ type: 'session', version: 3, id: 'session-1', timestamp: '2026-09-29T05:54:15.940Z', cwd: '/work/run' },
    { type: 'agent_start' }, { type: 'turn_start' },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'tiny task' }], timestamp: 1 } }];
  if (version === '0.87') lines.splice(3, 0, { type: 'message_end', message: { role: 'system', content: '', timestamp: 1 } });
  for (const reply of replies) {
    const message = { role: 'assistant', content: [...(reply.tool ? [{ type: 'toolCall', id: 'call_1', name: reply.tool, arguments: {} }] : []),
      ...(reply.text !== undefined ? [{ type: 'text', text: reply.text }] : [])], api: 'openai-completions', provider,
      model: reply.model ?? 'deepseek-v4-pro', ...(reply.responseModel ? { responseModel: reply.responseModel } : {}),
      usage: usage(reply.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }),
      stopReason: reply.stopReason ?? (reply.tool ? 'toolUse' : 'stop'), ...(reply.errorMessage ? { errorMessage: reply.errorMessage } : {}),
      timestamp: 2 };
    lines.push({ type: 'message_start', message: { ...message, content: [], stopReason: version === '0.87' ? 'pending' : 'stop' } });
    lines.push(version === '0.73' ? { type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', delta: 'x', partial: message } }
      : { type: 'message_update', usage: message.usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } });
    lines.push({ type: 'message_end', message });
    if (reply.tool) lines.push({ type: 'tool_execution_end', toolCallId: 'call_1', toolName: reply.tool,
      result: { content: [{ type: 'text', text: 'ok' }] }, isError: false });
    lines.push({ type: 'turn_end', message, toolResults: [] });
  }
  lines.push({ type: 'agent_end', messages: [], ...(version === '0.87' ? { willRetry: false } : {}) });
  if (version === '0.87') lines.push({ type: 'agent_settled' });
  return `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;
}
const parse = (raw: string, stderr = '', exit = 0, timedOut = false): ProviderResult =>
  parseProviderOutput('pi-cli', raw, stderr, exit, request, 'p', 'a', 'b', undefined, timedOut);

test('each service runs pi with its own provider, model and key variable; the prompt goes to stdin, never the command line', t => {
  const dir = temp(t);
  const mainland = { providers: { zai: { baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' } } };
  const cases = [
    { upstream: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', env: { DEEPSEEK_API_KEY: 'pi-deepseek' }, models: undefined },
    { upstream: 'zai', provider: 'zai', model: 'glm-5.3-flash', env: { ZAI_API_KEY: 'pi-zai' }, models: undefined },
    { upstream: 'zhipu', provider: 'zai', model: 'glm-5.3-flash', env: { ZAI_API_KEY: 'pi-zhipu' }, models: mainland },
  ] as const;
  // Longer than any Windows command line, and starting like an option and a file argument would.
  const prompt = `-p @task.txt\n${'把衣服改成红色。'.repeat(8000)}`;
  for (const item of cases) {
    const run = join(dir, item.upstream); mkdirSync(run);
    const command = providerCommand(pi(item.upstream), { ...request, prompt }, dir, run);
    const flag = (name: string) => command.argv[command.argv.indexOf(name) + 1];
    assert.deepEqual([flag('--mode'), flag('--provider'), flag('--model')], ['json', item.provider, item.model], item.upstream);
    assert.equal(flag('--session-dir'), join(run, 'pi-sessions'));
    for (const off of ['--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes'])
      assert.ok(command.argv.includes(off), `${item.upstream} ${off}`);
    assert.ok(!command.argv.some(arg => arg.includes('改成红色') || arg === '-p'), 'the prompt stays out of the command line');
    assert.equal(readFileSync(command.stdinFile!, 'utf8'), piPrompt(pi(item.upstream), prompt));
    assert.deepEqual(command.secretEnv, item.env, 'the key arrives by name, as the variable pi reads');
    assert.deepEqual(command.env, { PI_CODING_AGENT_DIR: join(run, 'pi-agent'), PI_CODING_AGENT_SESSION_DIR: join(run, 'pi-sessions'),
      PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', NODE_OPTIONS: `--import=${PI_NETWORK_PRELOAD}` });
    assert.equal(command.cwd, run);
    const models = join(run, 'pi-agent', 'models.json');
    assert.deepEqual(existsSync(models) ? JSON.parse(readFileSync(models, 'utf8')) : undefined, item.models, 'only GLM 国内 moves pi\'s address');
    const settings = JSON.parse(readFileSync(join(run, 'pi-agent', 'settings.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(settings.enableInstallTelemetry, false);
    assert.deepEqual(settings.retry, PI_RETRY_SETTINGS);
    assert.equal(settings.httpIdleTimeoutMs, 300_000);
    assert.equal(flag('--tools'), windows ? 'read,powershell,edit,write' : 'read,bash,edit,write');
    assert.equal(settings.shellPath, windows ? windowsGitBash() : undefined, 'Windows names the Git Bash beside Harness\'s git');
  }
  const run = join(dir, 'explicit'); mkdirSync(run);
  const explicit = providerCommand(pi('deepseek', { model: 'deepseek-flash', baseUrl: 'http://127.0.0.1:9/v1', secret: 'my-key',
    effort: 'high', allowedTools: ['read', 'bash'] }), request, dir, run);
  const flag = (name: string) => explicit.argv[explicit.argv.indexOf(name) + 1];
  assert.deepEqual([flag('--model'), flag('--thinking'), flag('--tools')], ['deepseek-flash', 'high', windows ? 'read,powershell' : 'read,bash']);
  assert.deepEqual(explicit.secretEnv, { DEEPSEEK_API_KEY: 'my-key' });
  assert.deepEqual(JSON.parse(readFileSync(join(run, 'pi-agent', 'models.json'), 'utf8')), { providers: { deepseek: { baseUrl: 'http://127.0.0.1:9/v1' } } });
  const refused = join(dir, 'refused'); mkdirSync(refused);
  assert.throws(() => providerCommand({ ...pi('deepseek'), upstream: undefined }, request, dir, refused), /需要 upstream/);
  assert.deepEqual(readdirSync(refused), [], 'nothing is written for a Provider that cannot run');
});

test('Git Bash is found beside the git Harness uses, whichever of its folders git sits in', t => {
  const dir = temp(t), root = join(dir, 'Git');
  for (const folder of ['cmd', 'bin', join('mingw64', 'bin')]) mkdirSync(join(root, folder), { recursive: true });
  assert.equal(windowsGitBash(join(root, 'cmd', 'git.exe')), undefined, 'no bash.exe, no answer');
  writeFileSync(join(root, 'bin', 'bash.exe'), '');
  for (const git of [join(root, 'cmd', 'git.exe'), join(root, 'bin', 'git.exe'), join(root, 'mingw64', 'bin', 'git.exe')])
    assert.equal(windowsGitBash(git), join(root, 'bin', 'bash.exe'), git);
  assert.equal(windowsGitBash('git'), undefined, 'a git not found on PATH names no bash');
});

test('a finished pi Run reads its answer, model, session and summed usage from either version\'s stream', () => {
  for (const version of ['0.73', '0.87'] as const) {
    const result = parse(stream(version, [
      { tool: 'write', usage: { input: 101, output: 11, cacheRead: 0, cacheWrite: 0, cost: 0.00005 } },
      { text: 'DONE: wrote the file', usage: { input: 103, output: 13, cacheRead: 40, cacheWrite: 2, cost: 0.00006 },
        ...(version === '0.87' ? { responseModel: 'deepseek-v4-pro-0925' } : {}) }]));
    assert.equal(result.errorClass, undefined, version);
    assert.equal(result.structuredResult, 'DONE: wrote the file');
    assert.equal(result.sessionId, 'session-1');
    assert.equal(result.reportedModel, version === '0.87' ? 'deepseek-v4-pro-0925' : 'deepseek-v4-pro');
    assert.deepEqual(result.usage, { inputTokens: 101 + 103 + 40 + 2, outputTokens: 24, costUsd: 0.00011, source: 'estimated' });
  }
  const unpriced = parse(stream('0.73', [{ text: 'ok', usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }], 'zai'));
  assert.deepEqual(unpriced.usage, { inputTokens: 5, outputTokens: 1, costUsd: null, source: 'measured' },
    'a model pi has no price for is not free, its cost is unknown');
  assert.equal(parse(stream('0.87', [{ text: 'cut short', stopReason: 'length' }])).errorClass, undefined, 'a long answer cut short still ended');
});

test('a refused request fails the Run although pi exits 0, classified from the service error of either version', () => {
  const cases: Array<[string, string, string]> = [
    ['401 Authentication Fails, Your api key: ****0000 is invalid', 'auth', 'API 密钥无效'],
    ['401: {"message":"Authentication Fails, Your api key: ****0000 is invalid","type":"authentication_error"}', 'auth', 'API 密钥无效'],
    ['401: {"code":"1002","message":"Authorization Token非法，请确认Authorization Token正确传递。"}', 'auth', 'API 密钥无效'],
    ['402 Insufficient Balance', 'rate_limit', '额度或余额不足'],
    ['402: {"message":"Insufficient Balance","type":"unknown_error"}', 'rate_limit', '额度或余额不足'],
    ['429 Rate Limit Reached', 'rate_limit', '额度或余额不足'],
    ['429: {"code":"1113","message":"余额不足或无可用资源包,请充值。"}', 'rate_limit', '额度或余额不足'],
    ['500: {"message":"Internal server error","type":"server_error"}', 'network', '连不上模型服务'],
    ['Connection error.', 'network', '连不上模型服务'],
    ['400 Model Not Exist', 'tool_failure', 'pi 运行失败'],
  ];
  for (const version of ['0.73', '0.87'] as const) for (const [message, errorClass, words] of cases) {
    const result = parse(stream(version, [{ stopReason: 'error', errorMessage: message }]));
    assert.equal(result.exitStatus, 0);
    assert.equal(result.errorClass, errorClass, `${version} ${message}`);
    assert.match(result.errorMessage ?? '', new RegExp(`^${words}`), message);
    assert.ok(result.errorMessage!.includes(message.slice(0, 20)), 'the service\'s own words are kept');
  }
  const aborted = parse(stream('0.87', [{ stopReason: 'aborted' }]), '', 143);
  assert.equal(aborted.errorClass, 'tool_failure');
});

test('pi failing before any answer is classified from its own message; an empty or damaged stream is a protocol failure', () => {
  const header = `${JSON.stringify({ type: 'session', version: 3, id: 'session-1', timestamp: 't', cwd: '/w' })}\n`;
  const noKey = parse(header, 'No API key found for deepseek.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /x/docs/providers.md\n', 1);
  assert.equal(noKey.errorClass, 'auth');
  assert.equal(noKey.errorMessage, 'API 密钥无效、缺失或没有权限：No API key found for deepseek.', 'pi\'s /login advice does not apply here');
  // pi 0.73 warns first when its catalog lacks the model (glm-5.3); the cause is the line after.
  const glm = parse(header, 'Warning: Model "glm-5.3" not found for provider "zai". Using custom model id.\nNo API key found for zai.\n', 1);
  assert.deepEqual([glm.errorClass, glm.errorMessage], ['auth', 'API 密钥无效、缺失或没有权限：No API key found for zai.']);
  assert.equal(parse('', 'Unknown provider "zai". Use --list-models to see available providers/models.', 1).errorClass, 'tool_failure');
  assert.equal(parse('', 'fetch failed: getaddrinfo ENOTFOUND api.deepseek.com', 1).errorClass, 'network');
  const silent = parse(header, '', 0);
  assert.equal(silent.errorClass, 'protocol', 'a prompt that never reached the model is not a success');
  assert.match(silent.errorMessage ?? '', /pi 没有给出可解析的结果/);
  assert.equal(parse(`${stream('0.87', [{ text: 'ok' }])}{broken\n`).errorClass, 'protocol');
  assert.equal(parse(stream('0.73', [{ text: 'partial' }]), '', 124, true).errorClass, 'timeout');
  // Records are split on LF only: a line separator inside an answer is text.
  assert.equal(parse(stream('0.87', [{ text: 'one two' }])).structuredResult, 'one two');
});

test('the failure class comes from the leading HTTP status first, then the words; numbers elsewhere do not count', () => {
  assert.equal(classifyPiFailure('403 Forbidden'), 'auth');
  assert.equal(classifyPiFailure('503 Service Unavailable'), 'network');
  assert.equal(classifyPiFailure('Your GLM Coding Plan subscription has expired'), 'quota');
  assert.equal(classifyPiFailure('已达到 5 小时的使用上限'), 'quota');
  assert.equal(classifyPiFailure('无权访问该模型'), 'auth');
  assert.equal(classifyPiFailure('Request timed out.'), 'network');
  assert.equal(classifyPiFailure('wrote /runs/429/401.txt then crashed'), 'tool', 'a path is not a status');
  assert.equal(classifyPiFailure('', 'No API key found for zai.'), 'auth', 'pi\'s own message counts when the service said nothing');
});

test('a Zhipu usage limit waits until the reset it names, read as Beijing time', () => {
  const now = new Date('2026-09-29T06:00:00Z');
  assert.equal(zhipuResetTime('已达到 5 小时的使用上限。您的限额将在 2026-09-29 18:00:00 重置。', now), '2026-09-29T10:00:00.000Z');
  assert.equal(zhipuResetTime('Usage limit reached for 5 hour. Your limit will reset at 2026-09-29 18:00:00', now), '2026-09-29T10:00:00.000Z');
  assert.equal(zhipuResetTime('将在 2026-09-29 12:00:00 重置', now), undefined, 'a reset already past is no wait');
  assert.equal(zhipuResetTime('log line 2026-09-29 18:00:00 end', now), undefined, 'a timestamp alone is no reset time');
  // A Run reads the reset against the present: three hours from now, in Beijing's wall-clock time.
  const reset = new Date(Math.floor(Date.now() / 1000) * 1000 + 3 * 3600_000);
  const beijing = new Date(reset.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  const limited = parse(stream('0.73', [{ stopReason: 'error', errorMessage: `429 已达到 5 小时的使用上限。您的限额将在 ${beijing} 重置。` }]));
  assert.equal(limited.errorClass, 'rate_limit');
  assert.equal(limited.retryAfter, reset.toISOString());
  assert.equal(parse(stream('0.87', [{ stopReason: 'error', errorMessage: '402 Insufficient Balance' }])).retryAfter, undefined,
    'an empty balance names no time; the scheduler waits its default');
});

test('probing pi reports its version from either stream and whether the key is stored, and passes no credentials to it', t => {
  const dir = temp(t), home = join(dir, 'home'), seen = join(dir, 'env.json');
  const script = (where: 'stdout' | 'stderr') => `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));
if (process.argv[2] !== '--version') process.exit(3);
process.${where}.write('0.${where === 'stderr' ? '73.1' : '87.1'}\\n');`;
  const old = fakeCommand(join(dir, 'pi-old'), script('stderr')), current = fakeCommand(join(dir, 'pi-new'), script('stdout'));
  process.env.AVH_TEST_API_KEY = 'sk-must-not-reach-pi'; process.env.AVH_TEST_TOKEN = 'token-must-not-reach-pi';
  t.after(() => { delete process.env.AVH_TEST_API_KEY; delete process.env.AVH_TEST_TOKEN; });
  const missing = probeProvider({ ...pi('deepseek'), executable: old }, 1000, undefined, home);
  assert.deepEqual([missing.version, missing.auth, missing.health, missing.quota.status], ['0.73.1', 'missing', 'unavailable', 'unknown']);
  const env = JSON.parse(readFileSync(seen, 'utf8')) as Record<string, string>;
  assert.equal(env.AVH_TEST_API_KEY, undefined); assert.equal(env.AVH_TEST_TOKEN, undefined);
  assert.equal(env.PI_OFFLINE, '1', 'no update check or telemetry from a probe');
  writeSecret(home, 'pi-zhipu', 'sk-stored-value');
  const ready = probeProvider({ ...pi('zhipu'), executable: current }, 1000, undefined, home);
  assert.deepEqual([ready.version, ready.auth, ready.health, ready.evidence.auth], ['0.87.1', 'ready', 'ready', 'probed']);
  assert.equal(probeProvider({ ...pi('zhipu'), executable: old }, 1000, undefined, home).health, windows ? 'unavailable' : 'ready',
    'Windows does not advertise an older CLI without the required native shell as ready');
  assert.equal(probeProvider({ ...pi('zai'), executable: current }, 1000, undefined, home).auth, 'missing', 'each region has its own key');
  const absent = probeProvider({ ...pi('zhipu'), executable: join(dir, 'no-such-pi') }, 1000, undefined, home);
  assert.deepEqual([absent.version, absent.health, absent.auth], [null, 'unavailable', 'ready'],
    'a stored key is reported as stored even while pi itself is missing');
});

test('a pi Run is recorded with its per-Run configuration and the key\'s name only; pi never runs without the outer sandbox', t => {
  const dir = temp(t), project = join(dir, 'project'), runs = join(dir, 'runs'), run = join(runs, 'run');
  for (const path of [project, run]) mkdirSync(path, { recursive: true });
  const managed = new ManagedProvider(pi('zhipu'), { projectDirectory: project, workspaceRepository: dir, runRoot: runs, harnessHome: join(dir, 'home') });
  assert.equal(managed.executor.config.requireSandboxByRunner?.p, true);
  assert.equal(managed.executor.config.sandboxByRunner?.p, 'outer');
  assert.throws(() => new ManagedProvider(pi('zhipu', { sandbox: 'self' }), { projectDirectory: project, workspaceRepository: dir, runRoot: runs }),
    /outer sandbox/);
  (managed as unknown as { requests: Map<string, ProviderRequest> }).requests.set('run', request);
  managed.executor.config.commandFor(request, run);
  const saved = JSON.parse(readFileSync(join(run, 'provider-request.json'), 'utf8')) as Record<string, any>;
  assert.match(saved.settingsSource, /pi-agent/);
  assert.deepEqual(saved.statePolicy, { writableRoots: [], configDirectory: join(run, 'pi-agent'), sessionDirectory: join(run, 'pi-sessions'),
    upstream: 'zhipu', model: 'glm-5.3-flash', endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4',
    tools: piTools(pi('zhipu')), retryPolicy: 'pi-agent-session/2-retries; SDK retries disabled; no whole-Run replay',
    credential: { variable: 'ZAI_API_KEY', secret: 'pi-zhipu' } });
  assert.match(saved.automaticMemory, /--no-context-files/);
  assert.deepEqual(saved.instructionFiles, []);
});

test('a credential printed by the Run is removed from the logs and transcripts it leaves; nothing else is rewritten', t => {
  const dir = temp(t), home = join(dir, 'home');
  writeSecret(home, 'pi-deepseek', 'sk-printed-0123456789');
  writeSecret(home, 'short', 'abc');
  const leaked = join(dir, 'stdout.log'), clean = join(dir, 'stderr.log'), missing = join(dir, 'absent.log');
  writeFileSync(leaked, 'key=sk-printed-0123456789 and again sk-printed-0123456789\n');
  writeFileSync(clean, 'nothing here abc\n');
  const before = statSync(clean).mtimeMs;
  assert.deepEqual(redactSecretValues(home, { DEEPSEEK_API_KEY: 'pi-deepseek', X: 'short', Y: 'gone' }, [leaked, clean, missing]), [leaked]);
  assert.equal(readFileSync(leaked, 'utf8'), `key=${REDACTED_SECRET} and again ${REDACTED_SECRET}\n`);
  assert.equal(readFileSync(clean, 'utf8'), 'nothing here abc\n', 'a value too short to be a key is left alone');
  assert.equal(statSync(clean).mtimeMs, before);
  assert.deepEqual(redactSecretValues(home, undefined, [leaked]), []);
});

test('a pi Provider keeps its actual family, every stage role, and requires its stored key', () => {
  const probe = (auth: 'ready' | 'missing') => ({ id: 'x', adapter: 'pi-cli' as const, health: auth === 'ready' ? 'ready' as const : 'unavailable' as const,
    version: '0.87.1', auth, evidence: { version: 'probed' as const, auth: 'probed' as const },
    quota: { usedPercent: null, observedAt: null, status: 'unknown' as const }, capabilities: {}, observedAt: 'now', expiresAt: 'later' });
  const entry = withPiChoices([], [{ upstream: 'deepseek' }])[0]!;
  const config: ProviderConfig = { ...pi('deepseek'), id: 'deepseek', roles: entry.roles as ProviderConfig['roles'] };
  const dsh: ProviderConfig = { id: 'dsh', adapter: 'legacy-dsh-task', executable: '/bin/true', roles: ['executor', 'diagnostician'] };
  const snapshot = (auth: 'ready' | 'missing'): ProviderSnapshot => ({ workflowId: 'w', policyVersion: 'v', frozenAt: 'now',
    providers: [{ config, probe: probe(auth) }, { config: dsh, probe: { ...probe('ready'), id: 'dsh', adapter: 'legacy-dsh-task' } }] });
  const peak = new Date('2026-09-28T02:00:00Z'); // Monday 10:00 Shanghai, when the codex family is preferred
  assert.equal(providerFamily(config), 'pi-cli');
  for (const role of ['executor', 'diagnostician', 'research'] as const)
    assert.equal(routeProviders(snapshot('ready'), role, DEFAULT_ROUTING, { now: peak, balance: () => 'ready' }).selected?.id, 'deepseek', role);
  const missing = routeProviders(snapshot('missing'), 'executor', DEFAULT_ROUTING, { now: peak, balance: () => 'ready' });
  assert.equal(missing.selected?.id, 'dsh');
  assert.match(missing.reason, /deepseek: health\/auth/);
});

test('pi choices from the GUI keep one Provider per service family, its place and its other settings', () => {
  const codex = { id: 'codex', type: 'codex-cli', executable: 'codex', roles: ['executor'] };
  const glm = { id: 'glm', type: 'pi-cli', upstream: 'zhipu', secret: 'pi-zhipu', roles: ['executor'], maxConcurrentRuns: 2, model: 'glm-4.7' };
  const added = withPiChoices([codex], piChoices([{ upstream: 'deepseek' }, { upstream: 'zai', model: ' glm-5.3-flash ' }]));
  assert.deepEqual(added, [codex,
    { id: 'deepseek', type: 'pi-cli', executable: 'pi', upstream: 'deepseek', roles: ['executor', 'diagnostician', 'research'], writable: [] },
    { id: 'glm', type: 'pi-cli', executable: 'pi', upstream: 'zai', roles: ['executor', 'diagnostician', 'research'], writable: [], model: 'glm-5.3-flash' }]);
  const switched = withPiChoices([glm, codex], piChoices([{ upstream: 'zai' }]));
  assert.deepEqual(switched, [{ id: 'glm', type: 'pi-cli', upstream: 'zai', roles: ['executor'], maxConcurrentRuns: 2 }, codex],
    'the region changes in place; the default key name follows it; the model left empty returns to the default');
  assert.deepEqual(withPiChoices([glm, codex], []), [codex], 'a service turned off leaves the configuration');
  assert.deepEqual(withPiChoices([{ id: 'deepseek', type: 'codex-cli' }], piChoices([{ upstream: 'deepseek' }])).map(entry => entry.id),
    ['deepseek', 'deepseek-2'], 'a taken id is not reused');
  assert.throws(() => piChoices([{ upstream: 'zai' }, { upstream: 'zhipu' }]), /各只能选一个/);
  assert.throws(() => piChoices([{ upstream: 'openai' }]), /只能是/);
  assert.throws(() => piChoices([{ upstream: 'deepseek', model: 3 }]), /应为文字/);
});

/** A Git repository, project, Run root and Harness home, as the Windows executor tests make them. */
function workspace(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'avh-pi-run-'));
  const repo = join(dir, 'workspace'), project = join(repo, 'project'), runs = join(dir, 'runs'), home = join(dir, 'home');
  t.after(() => { if (windows) releaseLedgers(home, dir); removeTemp(dir); });
  for (const path of [project, runs, join(home, 'config'), join(home, 'state'), join(home, 'run')]) mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(project, 'inside.txt'), 'baseline');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline']);
  return { dir, repo, project, runs, home };
}
async function finished(provider: { observe(handle: RunHandle): { state: string } }, handle: RunHandle): Promise<void> {
  await waitFor(() => provider.observe(handle).state,
    { what: `Run ${handle.ref} to exit`, ready: state => state === 'exited', timeoutMs: 180_000, intervalMs: 100 });
}
const helper = (() => { if (!windows) return false; try { windowsHelper(); return true; } catch { return false; } })();
/** A real Run needs the platform's supervisor and sandbox: the Windows helper, or systemd and bwrap (AVH_SYSTEMD_IT). */
const runnable = windows ? helper : process.env.AVH_SYSTEMD_IT === '1';
const realRun = runnable ? test : test.skip;
const records = (run: string): string[] => ['command.json', 'provider-request.json', 'stdout.log', 'stderr.log']
  .map(name => join(run, name)).concat(existsSync(join(run, 'pi-sessions')) ? readdirSync(join(run, 'pi-sessions')).map(name => join(run, 'pi-sessions', name)) : []);

realRun('a pi Run gets its key in its environment, confined to the project; the key appears in no record or log it leaves', async t => {
  const x = workspace(t), key = `sk-fake-${randomUUID()}`;
  writeSecret(x.home, 'pi-deepseek', key);
  // A stand-in pi that behaves like a model printing what its shell sees: the key goes to stdout, stderr and its transcript.
  const cli = fakeCommand(join(x.dir, 'pi'), `const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const args = process.argv.slice(2), flag = name => args[args.indexOf(name) + 1];
const prompt = fs.readFileSync(0, 'utf8'), field = name => new RegExp('^' + name + ': (.+)$', 'm').exec(prompt)[1].trim();
const key = process.env.DEEPSEEK_API_KEY || '';
const attempt = action => { try { action(); return 'ok'; } catch (error) { return error.code; } };
const facts = { digest: crypto.createHash('sha256').update(key).digest('hex'), provider: flag('--provider'), model: flag('--model'),
  project: attempt(() => fs.writeFileSync(path.join(field('Project'), 'from-pi.txt'), 'inside')),
  outside: attempt(() => fs.writeFileSync(field('Outside'), 'outside')),
  secret: attempt(() => fs.readFileSync(field('Secret'))),
  agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
process.stderr.write('shell saw ' + key + '\\n');
fs.writeFileSync(path.join(flag('--session-dir'), 'session.jsonl'), JSON.stringify({ type: 'message', text: 'echo ' + key }) + '\\n');
const reply = (text, stopReason) => ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }],
  provider: flag('--provider'), model: flag('--model'), usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason } });
process.stdout.write([{ type: 'session', version: 3, id: 'fake-session', cwd: process.cwd() }, reply('echo ' + key, 'toolUse'),
  reply(JSON.stringify(facts), 'stop'), { type: 'agent_end', messages: [] }].map(line => JSON.stringify(line)).join('\\n') + '\\n');`);
  const outside = join(x.repo, 'escaped.txt');
  const managed = new ManagedProvider(pi('deepseek', { executable: cli }), { projectDirectory: x.project, workspaceRepository: x.repo,
    runRoot: x.runs, harnessHome: x.home });
  const run: ProviderRequest = { ...request, runId: `pi-${randomUUID()}`, allowedWrites: [x.project],
    prompt: `Project: ${x.project}\nOutside: ${outside}\nSecret: ${join(x.home, 'config', 'secrets', 'pi-deepseek')}\n` };
  const handle = await managed.start(run);
  await finished(managed, handle);
  const result = managed.collect(handle);
  const directory = join(x.runs, run.runId);
  assert.equal(result.errorClass, undefined, readFileSync(join(directory, 'stderr.log'), 'utf8'));
  const facts = JSON.parse(String(result.structuredResult)) as Record<string, string>;
  assert.equal(facts.digest, createHash('sha256').update(key).digest('hex'), 'the key reached the command\'s environment');
  assert.deepEqual([facts.provider, facts.model, facts.offline], ['deepseek', 'deepseek-flash', '1']);
  assert.equal(facts.agentDir, join(directory, 'pi-agent'));
  assert.equal(facts.project, 'ok');
  assert.notEqual(facts.outside, 'ok', 'a write outside the project is refused');
  assert.equal(existsSync(outside), false);
  if (windows) assert.equal(facts.secret, 'EPERM', 'the stored key itself is unreadable to the Run');
  assert.equal(readFileSync(join(x.project, 'from-pi.txt'), 'utf8'), 'inside');
  const files = records(directory);
  assert.ok(files.some(file => file.endsWith('session.jsonl')));
  for (const file of files) assert.ok(!readFileSync(file, 'utf8').includes(key), `the key is not in ${file}`);
  assert.ok(readFileSync(join(directory, 'stdout.log'), 'utf8').includes(REDACTED_SECRET), 'what was printed is marked, not dropped');
  assert.ok(!JSON.stringify(result).includes(key), 'nor in the result stored in the state database');
  assert.deepEqual(result.artifacts, [join(directory, 'pi-sessions', 'session.jsonl')]);
  const command = JSON.parse(readFileSync(join(directory, 'command.json'), 'utf8')) as { sandbox: string; secretEnv: Record<string, string> };
  assert.deepEqual(command.secretEnv, { DEEPSEEK_API_KEY: 'pi-deepseek' });
  assert.equal(command.sandbox, windows ? 'lowil' : 'bwrap');
});

/**
 * The real pi CLI, when AVH_PI_CLI names it (for example a shim from `npm install --prefix <scratch>
 * @earendil-works/pi-coding-agent`). Nothing here reaches a model service: one Run has no key, the other talks to a
 * stand-in on 127.0.0.1.
 */
const realPi = process.env.AVH_PI_CLI && runnable ? test : test.skip;
realPi('the real pi starts inside the sandbox and, without a key, fails as an authentication problem', async t => {
  const x = workspace(t), config = pi('deepseek', { id: 'pi', executable: process.env.AVH_PI_CLI! });
  const executor = new UnitExecutor({ projectDirectory: x.project, workspaceRepository: x.repo, runRoot: x.runs, harnessHome: x.home,
    writableByRunner: { pi: [] }, sandboxByRunner: { pi: 'outer' }, requireSandboxByRunner: { pi: true }, networkByRunner: { pi: true },
    commandFor: (spec, directory) => {
      const command = providerCommand(config, { ...request, ...spec, prompt: 'Say hello.' }, x.project, directory);
      // No key at all, whatever the session around the test has: pi must stop before it reaches the network.
      return { ...command, secretEnv: undefined, env: { ...command.env, DEEPSEEK_API_KEY: '' } };
    } });
  const spec = { ...request, runId: `pi-${randomUUID()}`, allowedWrites: [x.project] };
  const handle = await executor.start(spec);
  await finished(executor, handle);
  const exit = executor.collect(handle).exitStatus, directory = join(x.runs, spec.runId);
  const stderr = readFileSync(join(directory, 'stderr.log'), 'utf8');
  const result = parseProviderOutput('pi-cli', readFileSync(join(directory, 'stdout.log'), 'utf8'), stderr, exit, spec, 'pi', 'a', 'b');
  assert.equal(exit, 1, stderr);
  assert.match(stderr, /No API key found for deepseek/);
  assert.equal(result.errorClass, 'auth');
  assert.equal(result.sessionId !== null, true, 'pi got as far as its session header');
  assert.equal((JSON.parse(readFileSync(join(directory, 'command.json'), 'utf8')) as { sandbox: string }).sandbox, windows ? 'lowil' : 'bwrap');
});

for (const upstream of ['deepseek', 'zhipu'] as const)
realPi(`the real pi works a task through its tools inside the sandbox, against a stand-in ${upstream} service on this computer`, async t => {
  const x = workspace(t), key = `sk-local-${randomUUID()}`;
  writeSecret(x.home, `pi-${upstream}`, key);
  const target = join(x.project, 'from-model.txt').replaceAll('\\', '/'), outside = join(x.repo, 'escaped.txt').replaceAll('\\', '/');
  const steps = [{ tool: 'write', args: { path: target, content: 'written by pi\n' } },
    { tool: windows ? 'powershell' : 'bash', args: { command: windows
      ? `Write-Output shell-ran; try { [IO.File]::WriteAllText('${outside}', 'x') } catch { Write-Output outside-refused }`
      : `echo shell-ran; echo x > '${outside}' || echo outside-refused` } }, { text: 'DONE' }];
  let turn = 0, authorized = 0;
  const models: string[] = [];
  const server = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', chunk => { body += chunk; });
    incoming.on('end', () => {
      if (incoming.headers.authorization === `Bearer ${key}`) authorized++;
      models.push((JSON.parse(body) as { model: string }).model);
      const step = steps[Math.min(turn++, steps.length - 1)]!;
      const send = (value: unknown) => response.write(`data: ${JSON.stringify({ id: `c${turn}`, object: 'chat.completion.chunk', created: 1,
        model: 'deepseek-v4-pro', ...value as object })}\n\n`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (step.tool) {
        send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${turn}`, type: 'function',
          function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: step.text }, finish_reason: null }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const managed = new ManagedProvider(pi(upstream, { executable: process.env.AVH_PI_CLI!, baseUrl: `http://127.0.0.1:${port}/v1` }),
    { projectDirectory: x.project, workspaceRepository: x.repo, runRoot: x.runs, harnessHome: x.home });
  const run: ProviderRequest = { ...request, runId: `pi-${randomUUID()}`, allowedWrites: [x.project], prompt: 'Write the file, then report.' };
  const handle = await managed.start(run);
  await finished(managed, handle);
  const result = managed.collect(handle), directory = join(x.runs, run.runId);
  assert.equal(result.errorClass, undefined, readFileSync(join(directory, 'stderr.log'), 'utf8'));
  assert.equal(result.structuredResult, 'DONE');
  assert.equal(authorized, steps.length, 'every request carried the stored key');
  assert.deepEqual([...new Set(models)], [upstream === 'deepseek' ? 'deepseek-flash' : 'glm-5.3-flash'], 'the model id reaches the service');
  assert.equal(readFileSync(join(x.project, 'from-model.txt'), 'utf8'), 'written by pi\n');
  assert.equal(existsSync(join(x.repo, 'escaped.txt')), false);
  assert.match(readFileSync(join(directory, 'stdout.log'), 'utf8'), /shell-ran/, 'pi\'s shell tool ran inside the sandbox');
  assert.equal(result.usage.inputTokens, 300);
  for (const file of records(directory)) assert.ok(!readFileSync(file, 'utf8').includes(key), `the key is not in ${file}`);
});

test('Windows pi selects a native shell, and complete retry events drive connection status', () => {
  assert.deepEqual(piTools(pi('deepseek'), true), ['read', 'powershell', 'edit', 'write']);
  assert.deepEqual(piTools(pi('deepseek', { allowedTools: ['write'] }), true), ['write']);
  assert.deepEqual(piTools(pi('deepseek'), false), ['read', 'bash', 'edit', 'write']);
  const start = JSON.stringify({ type: 'auto_retry_start', attempt: 2, delayMs: 10000 });
  assert.deepEqual(piConnectionProgress(start + '\n{"type":'), { retrying: true, attempt: 2, delayMs: 10000 });
  assert.deepEqual(piConnectionProgress(start + '\n' + JSON.stringify({ type: 'auto_retry_end', success: true })), { retrying: false });
});

test('a recovered stream keeps completed usage and flags missing upstream billing frames', () => {
  const raw = stream('0.87', [{ text: 'partial', stopReason: 'error', errorMessage: 'terminated' },
    { text: 'DONE', usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }]);
  const result = parse(raw);
  assert.equal(result.errorClass, undefined);
  assert.equal(result.structuredResult, 'DONE');
  assert.deepEqual(result.connection, { interruptions: 1, retries: 0 });
  assert.equal(result.usage.costUsd, 0.01);
  assert.equal(result.usage.incomplete, true);
});

for (const mode of ['recover', 'exhaust', 'cancel'] as const)
realPi(`the real pi ${mode}s a terminated stream without replaying completed or partial tools`, async t => {
  const x = workspace(t), key = `local-${randomUUID()}`;
  writeSecret(x.home, 'pi-deepseek', key);
  const marker = join(x.project, 'marker.txt').replaceAll('\\', '/');
  const target = join(x.project, 'complete.txt').replaceAll('\\', '/');
  const partial = join(x.project, 'partial.txt').replaceAll('\\', '/');
  let requests = 0;
  const bodies: Array<{ messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }> }> = [];
  const server = createServer((incoming, response) => {
    let body = '';
    incoming.on('data', chunk => body += chunk);
    incoming.on('end', () => {
      bodies.push(JSON.parse(body));
      const index = requests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: unknown, finish: string | null = null) => response.write(`data: ${JSON.stringify({
        id: `local-${index}`, object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash',
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      const tool = (name: string, args: unknown, finish = true) => {
        send({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${index}`, type: 'function',
          function: { name, arguments: JSON.stringify(args) } }] });
        if (finish) send({}, 'tool_calls');
      };
      if (index === 0 && mode !== 'cancel') {
        tool(windows ? 'powershell' : 'bash', { command: windows
          ? `[IO.File]::AppendAllText('${marker}', 'x'); Write-Output marker-written`
          : `printf x >> '${marker}'; echo marker-written` });
      } else if (mode !== 'recover' || index === 1) {
        send({ role: 'assistant', reasoning_content: 'unfinished inference' });
        tool('write', { path: partial, content: 'must not be written' }, false);
        setTimeout(() => response.destroy(), 150);
        return;
      } else if (index === 2) {
        tool('write', { path: target, content: 'complete' });
      } else { send({ role: 'assistant', content: 'DONE' }); send({}, 'stop'); }
      response.write(`data: ${JSON.stringify({ id: `local-${index}`, choices: [], usage: {
        prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = pi('deepseek', { executable: process.env.AVH_PI_CLI!,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` });
  const managed = new ManagedProvider(config, { projectDirectory: x.project, workspaceRepository: x.repo,
    runRoot: x.runs, harnessHome: x.home });
  const run = { ...request, runId: `pi-${randomUUID()}`, allowedWrites: [x.project], prompt: 'Run the task.' };
  const handle = await managed.start(run), directory = join(x.runs, run.runId);
  if (mode === 'cancel') {
    const retrying = await waitFor(() => {
      const log = readIfPresent(join(directory, 'stdout.log'));
      return Boolean(log && piConnectionProgress(log).retrying);
    }, { what: `${mode} mode to report a retrying pi connection in stdout.log`, timeoutMs: 60_000, intervalMs: 50 });
    assert.equal(retrying, true);
    assert.equal(await managed.cancel(handle), 'confirmed');
  } else {
    await finished(managed, handle);
    const result = managed.collect(handle);
    assert.equal(readFileSync(marker, 'utf8'), 'x', 'a completed non-idempotent tool is invoked exactly once');
    assert.equal(result.usage.incomplete, true);
    const transport = readFileSync(join(directory, 'stderr.log'), 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return {}; } }).filter(event => event.type === 'harness_pi_transport');
    assert.ok(transport.some(event => event.event === 'headers' && event.status === 200));
    assert.ok(transport.some(event => event.event === 'error' && event.code === 'UND_ERR_SOCKET'), 'the TCP reset has causal evidence');
    assert.ok(!JSON.stringify(transport).includes('unfinished inference'), 'diagnostics exclude model text');
    assert.equal(result.connection?.retries, mode === 'recover' ? 1 : 2);
    assert.equal(result.connection?.interruptions, mode === 'recover' ? 1 : 3);
    if (mode === 'recover') {
      assert.equal(result.errorClass, undefined, readFileSync(join(directory, 'stderr.log'), 'utf8'));
      assert.equal(result.structuredResult, 'DONE');
      assert.equal(readFileSync(target, 'utf8'), 'complete');
      assert.ok(bodies[2]!.messages.some(message => message.role === 'tool'));
      assert.ok(!JSON.stringify(bodies[2]).includes('unfinished inference'));
      assert.equal(result.usage.inputTokens, 300);
    } else {
      assert.equal(result.errorClass, 'network');
      assert.equal(result.usage.inputTokens, 100);
      assert.ok(!existsSync(target));
    }
  }
  assert.equal(requests, mode === 'cancel' ? 1 : 4, 'no SDK retry multiplier or whole-Run replay');
  assert.equal(existsSync(partial), false, 'a partial tool call never writes');
  for (const file of records(directory)) assert.ok(!readFileSync(file, 'utf8').includes(key));
});
