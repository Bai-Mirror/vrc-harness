import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ErrorClass } from '../runtime/interfaces.ts';
import type { CommandSpec } from '../exec/executor.ts';
import { commandFor, hostPlatform } from '../host-platform.ts';
import { parseRetryAfter } from './retry-after.ts';
import type { ProviderConfig, ProviderResult } from './types.ts';
import { isPiUpstream, PI_UPSTREAMS, type PiUpstreamInfo } from '../shared/pi.ts';

/**
 * pi (the pi coding agent CLI, `pi`) as a Provider: it reaches DeepSeek or Zhipu GLM with the person's own API key.
 * Everything pi would read from ~/.pi lives in the Run directory instead: PI_CODING_AGENT_DIR (settings, models.json,
 * auth.json) and the session directory. The key arrives as the environment variable pi reads (CommandSpec.secretEnv);
 * the prompt arrives on stdin, so its length never meets a command-line limit. See docs/cli.md.
 */
export { isPiUpstream, PI_UPSTREAMS, type PiUpstreamInfo } from '../shared/pi.ts';
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
/** pi's built-in tools; grep and find need ripgrep and fd, which pi would otherwise download at run time. */
export const PI_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'powershell'];
export const PI_AGENT_DIR = 'pi-agent';
export const PI_SESSION_DIR = 'pi-sessions';
/** One retry layer, in the same agent session. Never restart a Run to replay its tools. */
export const PI_RETRY_SETTINGS = { enabled: true, maxRetries: 2, baseDelayMs: 5000, maxAgentDelayMs: 20_000,
  provider: { maxRetries: 0, timeoutMs: 600_000, maxRetryDelayMs: 20_000 } };
export const PI_NETWORK_PRELOAD = new URL('./pi-network-diagnostics.mjs', import.meta.url).href;

/** Git Bash's MSYS shared objects are not usable by Windows Low integrity Runs. */
export function piTools(config: ProviderConfig, windows = process.platform === 'win32'): string[] {
  const tools = config.allowedTools?.length ? config.allowedTools : ['read', 'bash', 'edit', 'write'];
  return [...new Set(tools.map(tool => windows && tool === 'bash' ? 'powershell' : tool))];
}
export function piPrompt(config: ProviderConfig, prompt: string, windows = process.platform === 'win32'): string {
  return windows && piTools(config, true).includes('powershell') ? `${prompt}\n\n本次宿主是 Windows；原生命令工具为 powershell。按给出的 argv 调用程序时使用 & 调用运算符和独立参数（路径可有空格或方括号）。不要把这些命令当成 Bash 脚本，也不要重复探查 Git Bash。失败流里的未完成工具调用不会执行；保留已完成工具回传，继续当前未完成工作。` : prompt;
}
export function piShellSupported(config: ProviderConfig, version: string, windows = process.platform === 'win32'): boolean {
  if (!windows || !piTools(config, true).includes('powershell')) return true;
  const [major = 0, minor = 0, patch = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > 0 || minor > 84 || minor === 84 && patch >= 3;
}

/** Only complete JSON events determine live connection state; do not expose model text or credentials. */
export function piConnectionProgress(raw: string): { retrying: boolean; attempt?: number; delayMs?: number } {
  let progress: { retrying: boolean; attempt?: number; delayMs?: number } = { retrying: false };
  for (const line of raw.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'auto_retry_start') progress = { retrying: true,
        ...(Number.isSafeInteger(event.attempt) ? { attempt: event.attempt } : {}),
        ...(Number.isFinite(event.delayMs) ? { delayMs: event.delayMs } : {}) };
      else if (event.type === 'auto_retry_end' || event.type === 'agent_settled') progress = { retrying: false };
    } catch { /* A partial write is not a state change. */ }
  }
  return progress;
}
export function piRunConnectionProgress(directory: string) {
  let fd: number | undefined;
  try {
    fd = openSync(join(directory, 'stdout.log'), 'r');
    const size = statSync(join(directory, 'stdout.log')).size, start = Math.max(0, size - 256 * 1024);
    const bytes = Buffer.alloc(size - start); readSync(fd, bytes, 0, bytes.length, start);
    const tail = bytes.toString('utf8');
    return piConnectionProgress(start ? tail.slice(tail.indexOf('\n') + 1) : tail);
  } catch { return { retrying: false }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function piUpstream(config: ProviderConfig): PiUpstreamInfo {
  if (!isPiUpstream(config.upstream)) throw new Error(`pi Provider ${config.id} 需要 upstream：deepseek、zai 或 zhipu`);
  return PI_UPSTREAMS[config.upstream];
}
export function piSecret(config: ProviderConfig): string { return config.secret ?? piUpstream(config).secret; }
export function piModel(config: ProviderConfig): string { return config.model ?? piUpstream(config).model; }
export function piBaseUrl(config: ProviderConfig): string | undefined { return config.baseUrl ?? piUpstream(config).baseUrl; }

/**
 * Git Bash beside the git Harness uses. pi's bash tool needs bash on Windows and looks under Program Files, then on
 * PATH; naming this one keeps pi on the Git installation Harness already depends on.
 */
export function windowsGitBash(git = hostPlatform.toolCommand('git')): string | undefined {
  if (!isAbsolute(git)) return undefined;
  // Git for Windows keeps git.exe in cmd\, bin\ or mingw64\bin\, and bash.exe in bin\.
  let directory = dirname(git);
  for (let i = 0; i < 3; i++, directory = dirname(directory)) {
    const bash = join(directory, 'bin', 'bash.exe');
    if (existsSync(bash)) return bash;
  }
  return undefined;
}

/** The command for one Run: argv, environment (names only for the key), stdin, and the Run-local pi configuration it writes. */
export function piCommand(config: ProviderConfig, runDirectory: string, promptFile: string, program: string[],
  windows = process.platform === 'win32'): Omit<CommandSpec, 'runner'> {
  const upstream = piUpstream(config);
  const agentDir = join(runDirectory, PI_AGENT_DIR), sessionDir = join(runDirectory, PI_SESSION_DIR);
  hostPlatform.mkdirPrivate(agentDir); hostPlatform.mkdirPrivate(sessionDir);
  const shellPath = windows ? windowsGitBash() : undefined;
  hostPlatform.writePrivate(join(agentDir, 'settings.json'),
    JSON.stringify({ enableInstallTelemetry: false, retry: PI_RETRY_SETTINGS, httpIdleTimeoutMs: 300_000,
      ...(shellPath ? { shellPath } : {}) }), { flag: 'wx' });
  const baseUrl = piBaseUrl(config);
  if (baseUrl) hostPlatform.writePrivate(join(agentDir, 'models.json'),
    JSON.stringify({ providers: { [upstream.provider]: { baseUrl } } }), { flag: 'wx' });
  return {
    argv: [...program, '--mode', 'json', '--provider', upstream.provider, '--model', piModel(config),
      '--session-dir', sessionDir,
      // Nothing from the person's ~/.pi or from folders above the Run joins the prompt: no AGENTS.md, extensions or skills.
      '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      ...(config.effort ? ['--thinking', config.effort] : []),
      '--tools', piTools(config, windows).join(',')],
    // PI_OFFLINE stops pi's own startup traffic (update checks, telemetry, catalog refreshes, tool downloads); requests to
    // the model service are unaffected.
    env: { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0', NODE_OPTIONS: `--import=${PI_NETWORK_PRELOAD}` },
    secretEnv: { [upstream.keyVariable]: piSecret(config) },
    stdinFile: promptFile, cwd: runDirectory,
  };
}

/** The session transcripts pi wrote for a Run. */
export function piSessionFiles(runDirectory: string): string[] {
  const directory = join(runDirectory, PI_SESSION_DIR);
  try { return readdirSync(directory).map(name => join(directory, name)).filter(path => statSync(path).isFile()).sort(); }
  catch { return []; }
}

/** `pi --version`, without the caller's credentials in its environment and without pi's startup network traffic. */
export function piVersion(executable: string, source: NodeJS.ProcessEnv = process.env): { ok: boolean; output: string } {
  const [program, ...prefix] = process.platform === 'win32' ? commandFor(executable) : [executable];
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)
    && name !== 'CLAUDECODE'));
  const result = spawnSync(program!, [...prefix, '--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      PI_CODING_AGENT_DIR: join(tmpdir(), 'avh-pi-probe') } });
  // pi 0.73 prints its version on stderr once stdout is not a terminal; later versions print it on stdout.
  const version = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/).map(line => line.trim())
    .find(line => /^v?\d+\.\d+/.test(line));
  return result.status === 0 && version ? { ok: true, output: version } : { ok: false, output: '' };
}

type Failure = 'auth' | 'quota' | 'network' | 'tool';
const AUTH = /no api key|api[ _-]?key[^\n]{0,40}\b(?:invalid|incorrect|expired|revoked)|invalid[^\n]{0,20}api[ _-]?key|authentication[ _](?:fails|failed|failure|required|error)|unauthori[sz]ed|authorization token|身份验证|认证失败|令牌[^\n]{0,8}(?:无效|非法|过期)|token[^\n]{0,8}(?:非法|无效|过期)|无权访问/i;
const QUOTA = /insufficient[ _]?balance|余额不足|欠费|arrears|无可用资源包|resource package|usage limit|使用上限|额度|quota|rate[ _-]?limit|too many requests|并发数过高|频率过高|套餐已到期|(?:plan|subscription)[^\n]{0,20}expired/i;
const NETWORK = /connection error|connection refused|fetch failed|econnrefused|econnreset|enotfound|eai_again|etimedout|enetunreach|ehostunreach|socket hang up|getaddrinfo|timed out|network error|other side closed|unable to verify|certificate|self[- ]signed|\btls\b|overloaded|service unavailable|bad gateway|gateway timeout|server error|\bterminated\b/i;
/**
 * Why a pi Run failed. `primary` is the model service's error as pi reported it ("401 …" from pi 0.73, "401: {…}" from
 * later versions) or pi's own message; its leading HTTP status decides first, then the wording of both texts.
 */
export function classifyPiFailure(primary: string, secondary = ''): Failure {
  const status = Number(/^\s*(\d{3})(?=[\s:]|$)/.exec(primary)?.[1]);
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 429) return 'quota';
  if (status >= 500 && status <= 599) return 'network';
  const text = `${primary}\n${secondary}`;
  return AUTH.test(text) ? 'auth' : QUOTA.test(text) ? 'quota' : NETWORK.test(text) ? 'network' : 'tool';
}
const ERROR_CLASS: Record<Failure, ErrorClass> = { auth: 'auth', quota: 'rate_limit', network: 'network', tool: 'tool_failure' };
const EXPLANATION: Record<Failure, string> = { auth: 'API 密钥无效、缺失或没有权限', quota: '额度或余额不足，或请求过于频繁',
  network: '连不上模型服务，或服务暂时不可用', tool: 'pi 运行失败' };

/** Zhipu's usage-limit messages name the reset time in Beijing time ("将在 2026-09-29 18:00:00 重置", "reset at …"). */
export function zhipuResetTime(message: string, now = new Date()): string | undefined {
  const match = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*重置|reset at (\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/i
    .exec(message);
  if (!match) return undefined;
  const [y, mo, d, h, mi, s] = (match[1] ? match.slice(1, 7) : match.slice(7, 13)).map(value => Number(value ?? 0));
  const at = Date.UTC(y!, mo! - 1, d!, h! - 8, mi!, s!);
  return Number.isFinite(at) && at > now.getTime() && at - now.getTime() < 8 * 24 * 3600_000 ? new Date(at).toISOString() : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
/**
 * The line of an error that names its cause: the first one, after pi's warnings (such as a model id missing from its
 * catalog); pi's /login advice after it does not apply here.
 */
function excerpt(text: string): string {
  const lines = text.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const line = lines.find(item => !/^warning:/i.test(item)) ?? lines[0] ?? '';
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

export type PiOutcome = Pick<ProviderResult, 'sessionId' | 'reportedModel' | 'structuredResult' | 'usage' | 'errorClass'
  | 'errorMessage' | 'retryAfter' | 'connection'>;
/**
 * The result of `pi --mode json`: a session header, then events. JSON mode exits 0 even when the model service refused
 * the request, so success is read from the last assistant message (message_end): its stopReason and errorMessage.
 */
export function parsePiEvents(raw: string, stderr: string, exitStatus: number, timedOut = false): PiOutcome {
  const events: Record<string, unknown>[] = [];
  let malformed = 0;
  // Records are split on LF only: U+2028 and U+2029 are valid inside JSON strings.
  for (const line of raw.split('\n')) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!text.trim()) continue;
    try { const value = object(JSON.parse(text)); if (value) events.push(value); else malformed++; }
    catch { malformed++; }
  }
  const header = events.find(event => event.type === 'session');
  const replies = events.filter(event => event.type === 'message_end').map(event => object(event.message))
    .filter((message): message is Record<string, unknown> => message?.role === 'assistant');
  const final = replies.at(-1);
  const outcome: PiOutcome = { sessionId: typeof header?.id === 'string' ? header.id : null,
    reportedModel: typeof final?.responseModel === 'string' ? final.responseModel : typeof final?.model === 'string' ? final.model : null,
    structuredResult: null, usage: { inputTokens: null, outputTokens: null, costUsd: null, source: 'unknown' } };
  const interrupted = replies.filter(reply => reply.stopReason === 'error' &&
    classifyPiFailure(String(reply.errorMessage ?? '')) === 'network');
  if (interrupted.length) outcome.connection = { interruptions: interrupted.length,
    retries: events.filter(event => event.type === 'auto_retry_start').length };
  const content = Array.isArray(final?.content) ? final.content : [];
  const answer = content.map(object).filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block!.text as string).join('');
  if (answer) outcome.structuredResult = answer;
  let input = 0, output = 0, cost = 0, measured = false;
  for (const reply of replies) {
    const usage = object(reply.usage);
    if (!usage || (number(usage.input) === null && number(usage.output) === null)) continue;
    measured = true;
    input += (number(usage.input) ?? 0) + (number(usage.cacheRead) ?? 0) + (number(usage.cacheWrite) ?? 0);
    output += number(usage.output) ?? 0;
    cost += number(object(usage.cost)?.total) ?? 0;
  }
  // Token counts are the service's own; the cost is pi's estimate from its price list (zero when it has none).
  if (measured) outcome.usage = { inputTokens: input, outputTokens: output, costUsd: cost > 0 ? Math.round(cost * 1e9) / 1e9 : null,
    source: cost > 0 ? 'estimated' : 'measured' };
  // A dropped response can be billed upstream even when its final usage frame never arrived.
  if (interrupted.some(reply => typeof reply.responseId === 'string' ||
    Array.isArray(reply.content) && reply.content.some(block => {
      const item = object(block); return item && (item.text || item.thinking || item.type === 'toolCall');
    }))) outcome.usage.incomplete = true;
  const stop = typeof final?.stopReason === 'string' ? final.stopReason : undefined;
  const fail = (failure: Failure, primary: string, secondary: string): PiOutcome => {
    outcome.errorClass = ERROR_CLASS[failure];
    const detail = excerpt(primary) || excerpt(secondary);
    outcome.errorMessage = detail ? `${EXPLANATION[failure]}：${detail}` : EXPLANATION[failure];
    if (failure === 'quota') {
      const retryAfter = zhipuResetTime(`${primary}\n${secondary}`) ?? parseRetryAfter(`${primary}\n${secondary}`);
      if (retryAfter) outcome.retryAfter = retryAfter;
    }
    return outcome;
  };
  if (timedOut) { outcome.errorClass = 'timeout'; return outcome; }
  if (stop === 'error' || stop === 'aborted') {
    const primary = typeof final?.errorMessage === 'string' && final.errorMessage.trim() ? final.errorMessage : `request ${stop}`;
    return fail(classifyPiFailure(primary, stderr), primary, stderr);
  }
  if (exitStatus !== 0) return fail(classifyPiFailure(stderr), stderr, `exit ${exitStatus}`);
  if (!final || malformed) {
    outcome.errorClass = 'protocol';
    const detail = excerpt(stderr);
    outcome.errorMessage = `pi 没有给出可解析的结果${malformed ? `（${malformed} 行不是 JSON）` : ''}${detail ? `：${detail}` : ''}`;
  }
  return outcome;
}
