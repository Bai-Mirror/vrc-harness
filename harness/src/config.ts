import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { loadProcess } from './process/load.ts';
import type { ProcessDefinition } from './process/types.ts';
import { DEFAULT_IMPORT_CONFIG, type ImportConfig } from './import/types.ts';
import type { ProviderConfig } from './providers/types.ts';
import { DEFAULT_ROUTING, type RoutingPolicy } from './providers/routing.ts';
import { isPiUpstream, PI_THINKING_LEVELS, PI_TOOLS, PI_UPSTREAMS } from './providers/pi.ts';
import { isSecretId } from './providers/secrets.ts';
import { DEFAULT_GIT_OUTPUT_LIMIT, DEFAULT_HASH_LIMIT, type ScanLimits } from './exec/git-scan.ts';
import { hostPlatform, rejectCloudSyncedPath } from './host-platform.ts';
import { loadCapabilities, type CapabilityManifest } from './workflow/capabilities.ts';
import type { RuleValue } from './process/rule.ts';

type MapValue = Record<string, unknown>;
export interface LocalConfig {
  home: string;
  workspaceRoot: string;
  /** User-granted read-only source directories for material exploration. Never model writable roots. */
  assetSearchRoots?: string[];
  /** Private configuration source; only source authorization is refreshed in a running scheduler. */
  assetSearchRootsConfigPath?: string;
  /** Internal read-only exploration guard, expandable in advanced settings; it grants no extra source or spending rights. */
  coordination?: {maxExplorationOperations:number};
  toolRoot: string;
  knowledgeRoot: string;
  /** Validated machine-specific paths referenced by managed capabilities, e.g. assetLibrary and templateProject. */
  workflowVariables: Record<string, string>;
  exportRoots: string[];
  knownBodies: string[];
  projectAliases: Record<string, string[]>;
  sampleNames: string[];
  stateDbPath: string;
  defaultProfile: string;
  definitions: Record<string, ProcessDefinition>;
  /** Profiles that can run as formal Workflows: how each is carried out and measured. */
  capabilities: Record<string, CapabilityManifest>;
  /** `t.<name>` values from the thresholds table, as rules read them. */
  thresholdValues: Record<string, RuleValue>;
  thresholdsVersion: string;
  importByProfile: Record<string, ImportConfig>;
  providers: Array<ProviderConfig & { maxConcurrentRuns: number }>;
  providerPolicyVersion: string;
  providerProbeTtlMs: number;
  routing: RoutingPolicy;
  unity?: UnityConfig;
  /** How many Unity editors this machine may run at once, and whether the environment or the platform decided it. */
  unitySlots: UnitySlotsSetting;
  scanLimits: Required<ScanLimits>;
  provenanceFiles?: Record<string, { knowledge: string[]; interpretation: string[] }>;
  importSettings?: Record<string, unknown>;
  /** Each installation registers its own token with this server. No shared client credential is configured. */
  contributionUpstream?: { endpoint: string };
  /** Name sent with contributions, set during first-run setup. Optional: contributions work without it. */
  contributorName?: string;
}
export interface UnityConfig {
  runner: string; lockPath: string; busyExitCode: number; homeSeedFrom: string[];
  projectScratch: string[]; defaultTimeoutSec: number; passEnv: string[];
  /** The Unity executable. Without it, runner names the executable, or a legacy unity_run.sh whose default is read. */
  editor?: string;
}
export const DEFAULT_COORDINATION_MAX_OPERATIONS=72;
function coordinationSettings(value:unknown):NonNullable<LocalConfig['coordination']>{
  const raw=value===undefined?{}:object(value,'coordination');
  if(Object.keys(raw).some(key=>key!=='maxExplorationOperations'))throw new Error('coordination: 未知探索配置');
  const limit=raw.maxExplorationOperations??DEFAULT_COORDINATION_MAX_OPERATIONS;
  if(!Number.isSafeInteger(limit)||(limit as number)<24)throw new Error('coordination.maxExplorationOperations: 应为至少24的安全整数');
  return{maxExplorationOperations:limit as number};
}
/** A running coordinator re-reads only this guard, so an advanced change does not replay or replace old receipts. */
export function currentExplorationLimit(config:LocalConfig):number{
  if(!config.assetSearchRootsConfigPath)return coordinationSettings(config.coordination).maxExplorationOperations;
  try{return coordinationSettings(document(config.assetSearchRootsConfigPath,'协调探索配置').coordination).maxExplorationOperations;}
  catch{return 24;}
}
function contributionUpstream(value:unknown):LocalConfig['contributionUpstream']{
  if(value===undefined)return undefined;
  const raw=object(value,'contributionUpstream'),endpoint=string(raw.endpoint,'contributionUpstream.endpoint');
  if(raw.tokenEnv!==undefined)throw new Error('contributionUpstream.tokenEnv 已停用：每台安装会单独注册令牌');
  let url:URL;try{url=new URL(endpoint);}catch{throw new Error('contributionUpstream.endpoint: URL 无效');}
  if(url.username||url.password||url.search||url.hash)throw new Error('contributionUpstream.endpoint: 不得包含凭据、查询或片段');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','::1'].includes(url.hostname)))
    throw new Error('contributionUpstream.endpoint: 只允许 HTTPS 或本机 HTTP');
  return{endpoint:url.toString()};
}
function contributorName(value:unknown):string|undefined{
  if(value===undefined||value===null)return undefined;
  if(typeof value!=='string')throw new Error('contributorName: 应为字符串');
  const name=value.trim();
  if(name.length>64||/[\u0000-\u001f\u007f]/.test(name))throw new Error('contributorName: 最多 64 个字符，不能含控制字符');
  return name||undefined;
}
/**
 * The batch lock every Unity step shares, unless a legacy setup named the one its own scripts use.
 *
 * On Windows it sits outside AVH_HOME, at one path per account: the resource it guards is Unity's licensing client,
 * whose pipe `LicenseClient-<account>` and mutex `Unity-LicenseClient-<account>` are machine-wide. A second Harness home,
 * another worktree or a development fixture that took a lock of its own would serialise nothing and could fail an
 * in-flight Run with exit code 199 (see `exec/unity-batch-lock.ts`). On Linux the path is unchanged: licensing is
 * per-install there, and the file is part of the legacy flock contract.
 */
export function defaultUnityLockPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return join(home, 'state', 'unity-batch.lock');
  const profile = env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : homedir();
  return join(profile, 'avh-unity', 'unity-batch.lock');
}
/** The most editors one machine may be asked to run at once; a bound, not a promise that the machine has the memory. */
export const UNITY_SLOTS_MAX = 8;
/** How many Unity editors may run at once on this machine when nothing says otherwise. */
export const DEFAULT_WINDOWS_UNITY_SLOTS = 2;
/**
 * How many batch slots the machine-level lock has, i.e. how many Unity editors may run at once on one account.
 *
 * The resource the lock guards is Unity's licensing client, and one client can serve several editors — but only while it
 * is the *right* client: measured on Windows (lane U1), a client a Low-integrity editor started serves every other
 * editor, Low or Medium, while a client a Medium editor started refuses Low editors on its channel (`Connection Refused;
 * code: 0x8000000a`, then Unity's own 60s timeout and exit code 199). Harness always starts its editors at Low
 * integrity, so when Harness is the first to need a client on this account the account gets a Low one and several
 * Harness editors share it. Windows therefore allows `DEFAULT_WINDOWS_UNITY_SLOTS` at a time; the count is a ceiling,
 * not a memory guarantee.
 *
 * Linux keeps its historical single slot: licensing there is per install, the path is part of the legacy flock
 * contract, and this change could not be measured on a Linux host. `AVH_UNITY_SLOTS` raises or lowers the count on
 * either platform; both platforms read the same variable and the same counting code.
 */
export function defaultUnitySlots(env: NodeJS.ProcessEnv = process.env): number {
  return unitySlotsSetting(env).count;
}
/** The machine's slot count together with where it came from, so `doctor` can show both. */
export interface UnitySlotsSetting { count: number; source: 'env' | 'default' }
/**
 * Reads `AVH_UNITY_SLOTS` and refuses anything that is not a positive integer within `UNITY_SLOTS_MAX`.
 *
 * `loadConfig` calls this, so a typo is reported where the configuration is read — before a single task is scheduled —
 * instead of in the middle of a Run, where the launcher is the first thing to ask. An empty or blank value means
 * "unset" and falls back to the platform decision, as an unset environment variable does everywhere else.
 */
export function unitySlotsSetting(env: NodeJS.ProcessEnv = process.env): UnitySlotsSetting {
  const raw = env.AVH_UNITY_SLOTS;
  const text = raw === undefined ? '' : raw.trim();
  if (text !== '') {
    const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > UNITY_SLOTS_MAX)
      throw new Error(`AVH_UNITY_SLOTS: 应为 1 至 ${UNITY_SLOTS_MAX} 的整数，当前为「${raw}」`);
    return { count: value, source: 'env' };
  }
  return { count: process.platform === 'win32' ? DEFAULT_WINDOWS_UNITY_SLOTS : 1, source: 'default' };
}
function unitySettings(value: unknown, home: string): UnityConfig | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, 'unity');
  const editor = raw.editor === undefined ? undefined : string(raw.editor, 'unity.editor');
  if (raw.runner === undefined && editor === undefined) throw new Error('unity.editor: 需要 Unity 可执行文件的绝对路径');
  // With an editor, a runner only matters to legacy configs; the relative runner an early wizard wrote is ignored.
  const configuredRunner = raw.runner === undefined ? undefined : string(raw.runner, 'unity.runner');
  const runner = configuredRunner === undefined || (editor !== undefined && !isAbsolute(configuredRunner)) ? editor! : configuredRunner;
  const lockPath = raw.lockPath === undefined ? defaultUnityLockPath(home) : string(raw.lockPath, 'unity.lockPath');
  if (!isAbsolute(runner) || !isAbsolute(lockPath) || (editor !== undefined && !isAbsolute(editor)))
    throw new Error('unity.editor、unity.runner 和 unity.lockPath 必须为绝对路径');
  const homeSeedFrom = strings(raw.homeSeedFrom ?? [], 'unity.homeSeedFrom');
  const projectScratch = strings(raw.projectScratch ?? ['Library', 'Temp', 'Logs', 'UserSettings', 'obj'], 'unity.projectScratch');
  for (const path of [...homeSeedFrom, ...projectScratch])
    if (isAbsolute(path) || !path || path === '.' || path.split('/').some(part => part === '..' || !part))
      throw new Error('unity 相对路径不得越界');
  // Unity's build system starts helpers such as uname and needs PATH; audio clients find their server through
  // XDG_RUNTIME_DIR, and without it FMOD can hang while opening the audio device in a Play step.
  const configuredPassEnv = strings(raw.passEnv ?? ['DISPLAY', 'WAYLAND_DISPLAY', 'PATH', 'LANG', 'XDG_RUNTIME_DIR'], 'unity.passEnv');
  const passEnv = [...new Set([...configuredPassEnv, 'PATH'])];
  if (passEnv.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('unity.passEnv: 无效变量名');
  if (passEnv.some(name => ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'XDG_STATE_HOME', 'XDG_CONFIG_DIRS', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY', 'TMPDIR',
    'AVH_RUN_DIR', 'AVH_PROJECT_DIR'].includes(name)))
    throw new Error('unity.passEnv: 不得覆盖隔离环境');
  const busyExitCode = raw.busyExitCode ?? 5, defaultTimeoutSec = raw.defaultTimeoutSec ?? 3600;
  if (!Number.isSafeInteger(busyExitCode) || (busyExitCode as number) < 1 || (busyExitCode as number) > 255)
    throw new Error('unity.busyExitCode: 应为 1 至 255');
  if (!Number.isSafeInteger(defaultTimeoutSec) || (defaultTimeoutSec as number) < 1)
    throw new Error('unity.defaultTimeoutSec: 应为正整数');
  return { runner, lockPath, busyExitCode: busyExitCode as number, defaultTimeoutSec: defaultTimeoutSec as number,
    homeSeedFrom, projectScratch, passEnv, ...(editor === undefined ? {} : { editor }) };
}
function routing(value: unknown): RoutingPolicy {
  if (value === undefined) return { ...DEFAULT_ROUTING };
  const raw = object(value, 'routing');
  const timezone = raw.timezone === undefined ? DEFAULT_ROUTING.timezone : string(raw.timezone, 'routing.timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new Error('routing.timezone: 无效时区'); }
  const workdays = raw.workdays === undefined ? DEFAULT_ROUTING.workdays : raw.workdays;
  if (!Array.isArray(workdays) || workdays.some(day => !Number.isInteger(day) || day < 1 || day > 7))
    throw new Error('routing.workdays: 应为 1 至 7 的列表');
  const windowsRaw = raw.windows === undefined ? DEFAULT_ROUTING.windows : raw.windows;
  if (!Array.isArray(windowsRaw)) throw new Error('routing.windows: 应为列表');
  const windows = windowsRaw.map((entry, i) => {
    const item = object(entry, `routing.windows[${i}]`);
    const start = string(item.start, `routing.windows[${i}].start`);
    const end = string(item.end, `routing.windows[${i}].end`);
    if (![start, end].every(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) || start >= end)
      throw new Error(`routing.windows[${i}]: 时段无效`);
    return { start, end };
  });
  const threshold = raw.codexQuotaThresholdPercent ?? DEFAULT_ROUTING.codexQuotaThresholdPercent;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 100)
    throw new Error('routing.codexQuotaThresholdPercent: 应为 0 至 100');
  return { timezone, workdays: workdays as number[], windows, codexQuotaThresholdPercent: threshold };
}
function providers(value: unknown, defaultToolRoot: string): LocalConfig['providers'] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('providers: 应为列表');
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const key = `providers[${index}]`; const raw = object(entry, key);
    const id = string(raw.id, `${key}.id`);
    if (ids.has(id)) throw new Error(`${key}.id: 重复 ${id}`);
    ids.add(id);
    const adapter = string(raw.type ?? raw.adapter, `${key}.type`);
    if (!['codex-cli', 'claude-cli', 'legacy-dsh-task', 'agy-reviewer', 'agy', 'pi-cli'].includes(adapter))
      throw new Error(`${key}.type: 不支持 ${adapter}`);
    if (adapter === 'pi-cli') return piProvider(raw, key, id);
    const roles = strings(raw.roles ?? raw.rolesAllowed, `${key}.roles`);
    if (!roles.length || roles.some(role => !['executor', 'diagnostician', 'reviewer', 'research'].includes(role)) ||
      (adapter === 'agy' || adapter === 'agy-reviewer') && roles.some(role => role !== 'reviewer'))
      throw new Error(`${key}.roles: 无效`);
    const writable = strings(raw.writable ?? [], `${key}.writable`).map((path, i) => directory(path, `${key}.writable[${i}]`));
    // A CLI installed but never run has no state directory yet. Its default is then left out rather than failing the
    // whole configuration; the Provider probe reports it as not logged in. Directories named explicitly stay required.
    const defaults = (adapter === 'codex-cli' ? ['~/.codex'] : adapter === 'claude-cli' ? ['~/.claude'] :
      adapter === 'legacy-dsh-task' ? ['~/.dsh'] : []).filter(path => existsSync(join(homedir(), path.slice(2))));
    const stateDirs = [...new Set([...defaults, ...strings(raw.stateDirs ?? [], `${key}.stateDirs`)]
      .map((path, i) => directory(path, `${key}.stateDirs[${i}]`)))];
    if ((adapter === 'agy' || adapter === 'agy-reviewer') && !stateDirs.length)
      throw new Error(`${key}.stateDirs: agy 需要配置状态目录`);
    const network = raw.network === undefined ? true : raw.network;
    if (typeof network !== 'boolean') throw new Error(`${key}.network: 应为布尔值`);
    const sandbox = raw.sandbox ?? (adapter === 'codex-cli' || adapter === 'legacy-dsh-task' ? 'self' : 'outer');
    if (sandbox !== 'self' && sandbox !== 'outer') throw new Error(`${key}.sandbox: 应为 self 或 outer`);
    const family = raw.family ?? (adapter === 'legacy-dsh-task' ? 'dsh' : 'codex');
    if (family !== 'codex' && family !== 'dsh') throw new Error(`${key}.family: 应为 codex 或 dsh`);
    const balanceCheck = raw.balanceCheck === undefined ? undefined : strings(raw.balanceCheck, `${key}.balanceCheck`);
    if (balanceCheck && !balanceCheck.length) throw new Error(`${key}.balanceCheck: 不得为空`);
    const max = raw.maxConcurrentRuns ?? 1;
    if (!Number.isSafeInteger(max) || (max as number) < 1) throw new Error(`${key}.maxConcurrentRuns: 应为正整数`);
    const capabilities = raw.capabilities === undefined ? {} : object(raw.capabilities, `${key}.capabilities`);
    for (const [name, status] of Object.entries(capabilities))
      if (!['declared', 'probed', 'unknown'].includes(String(status))) throw new Error(`${key}.capabilities.${name}: 无效`);
    const timeoutMs = raw.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1))
      throw new Error(`${key}.timeoutMs: 应为正整数`);
    const engine = raw.engine;
    if (engine !== undefined && engine !== 'dsh' && engine !== 'codex') throw new Error(`${key}.engine: 无效`);
    const reviewMode = raw.reviewMode;
    if (reviewMode !== undefined && reviewMode !== 'fast' && reviewMode !== 'wide') throw new Error(`${key}.reviewMode: 无效`);
    return { id, adapter: adapter === 'agy' ? 'agy-reviewer' : adapter,
      executable: string(raw.executable, `${key}.executable`), roles,
      writable, stateDirs, network, sandbox, family, ...(balanceCheck ? { balanceCheck } : {}), maxConcurrentRuns: max, capabilities,
      ...(raw.model === undefined ? {} : { model: string(raw.model, `${key}.model`) }),
      ...(raw.effort === undefined ? {} : { effort: string(raw.effort, `${key}.effort`) }),
      ...(['legacy-dsh-task', 'agy', 'agy-reviewer'].includes(adapter) || raw.toolRoot !== undefined
        ? { toolRoot: raw.toolRoot === undefined ? defaultToolRoot : directory(raw.toolRoot, `${key}.toolRoot`) } : {}),
      ...(raw.sessionRoot === undefined ? {} : { sessionRoot: directory(raw.sessionRoot, `${key}.sessionRoot`) }),
      ...(raw.settingsSources === undefined ? {} : { settingsSources: strings(raw.settingsSources, `${key}.settingsSources`) }),
      ...(raw.allowedTools === undefined ? {} : { allowedTools: strings(raw.allowedTools, `${key}.allowedTools`) }),
      ...(raw.reasoningEffort === undefined ? {} : { reasoningEffort: string(raw.reasoningEffort, `${key}.reasoningEffort`) }),
      ...(raw.permissionMode === undefined ? {} : { permissionMode: string(raw.permissionMode, `${key}.permissionMode`) }),
      ...(engine === undefined ? {} : { engine }), ...(reviewMode === undefined ? {} : { reviewMode }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    } as LocalConfig['providers'][number];
  });
}

/** A pi-cli Provider: which service, and everything else defaulted from it (providers/pi.ts). */
function piProvider(raw: MapValue, key: string, id: string): LocalConfig['providers'][number] {
  if (!isPiUpstream(raw.upstream)) throw new Error(`${key}.upstream: 应为 deepseek、zai（智谱 GLM 国际）或 zhipu（智谱 GLM 国内）`);
  const upstream = PI_UPSTREAMS[raw.upstream];
  const executable = raw.executable === undefined ? 'pi' : string(raw.executable, `${key}.executable`);
  const roles = strings(raw.roles ?? raw.rolesAllowed ?? ['executor', 'diagnostician', 'research'], `${key}.roles`);
  if (!roles.length || roles.some(role => !['executor', 'diagnostician', 'reviewer', 'research'].includes(role)))
    throw new Error(`${key}.roles: 无效`);
  const model = raw.model === undefined ? upstream.model : string(raw.model, `${key}.model`).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) throw new Error(`${key}.model: 模型名只能含字母、数字和 . _ : / -`);
  let baseUrl = upstream.baseUrl;
  if (raw.baseUrl !== undefined) {
    let url: URL;
    try { url = new URL(string(raw.baseUrl, `${key}.baseUrl`).trim()); } catch { throw new Error(`${key}.baseUrl: URL 无效`); }
    if (url.username || url.password || url.search || url.hash) throw new Error(`${key}.baseUrl: 不得包含凭据、查询或片段`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      throw new Error(`${key}.baseUrl: 只允许 HTTPS（或本机 HTTP）`);
    baseUrl = url.toString().replace(/\/$/, '');
  }
  const secret = raw.secret === undefined ? upstream.secret : string(raw.secret, `${key}.secret`);
  if (!isSecretId(secret)) throw new Error(`${key}.secret: 凭据名只能用小写字母、数字和 . _ -`);
  const effort = raw.effort === undefined ? undefined : string(raw.effort, `${key}.effort`);
  if (effort !== undefined && !PI_THINKING_LEVELS.includes(effort)) throw new Error(`${key}.effort: 应为 ${PI_THINKING_LEVELS.join('、')} 之一`);
  const allowedTools = raw.allowedTools === undefined ? undefined : strings(raw.allowedTools, `${key}.allowedTools`);
  const unknownTool = allowedTools?.find(tool => !PI_TOOLS.includes(tool));
  if (unknownTool) throw new Error(`${key}.allowedTools: pi 没有工具 ${unknownTool}（可用：${PI_TOOLS.join('、')}）`);
  if ((raw.sandbox ?? 'outer') !== 'outer') throw new Error(`${key}.sandbox: pi 没有自己的沙箱，只能是 outer`);
  if (raw.stateDirs !== undefined && strings(raw.stateDirs, `${key}.stateDirs`).length)
    throw new Error(`${key}.stateDirs: pi 的状态放在每个 Run 的目录里，不用配置`);
  const writable = strings(raw.writable ?? [], `${key}.writable`).map((path, i) => directory(path, `${key}.writable[${i}]`));
  const network = raw.network === undefined ? true : raw.network;
  if (typeof network !== 'boolean') throw new Error(`${key}.network: 应为布尔值`);
  // Preserve the actual provider family; the context compiler names its model rather than pretending it is Codex.
  const family = raw.family;
  if (family !== undefined && family !== 'codex' && family !== 'dsh') throw new Error(`${key}.family: 应为 codex 或 dsh`);
  const balanceCheck = raw.balanceCheck === undefined ? undefined : strings(raw.balanceCheck, `${key}.balanceCheck`);
  const max = raw.maxConcurrentRuns ?? 1;
  if (!Number.isSafeInteger(max) || (max as number) < 1) throw new Error(`${key}.maxConcurrentRuns: 应为正整数`);
  const capabilities = raw.capabilities === undefined ? {} : object(raw.capabilities, `${key}.capabilities`);
  for (const [name, status] of Object.entries(capabilities))
    if (!['declared', 'probed', 'unknown'].includes(String(status))) throw new Error(`${key}.capabilities.${name}: 无效`);
  const timeoutMs = raw.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || (timeoutMs as number) < 1))
    throw new Error(`${key}.timeoutMs: 应为正整数`);
  return { id, adapter: 'pi-cli', executable, roles: roles as ProviderConfig['roles'], upstream: raw.upstream, model, secret,
    ...(raw.imageModel === undefined ? {} : { imageModel: string(raw.imageModel, `${key}.imageModel`) }),
    ...(baseUrl ? { baseUrl } : {}), writable, stateDirs: [], network, sandbox: 'outer', ...(family ? { family } : {}),
    ...(balanceCheck?.length ? { balanceCheck } : {}), maxConcurrentRuns: max as number,
    capabilities: capabilities as Record<string, 'declared' | 'probed' | 'unknown'>,
    ...(effort ? { effort } : {}), ...(allowedTools ? { allowedTools } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }) };
}

function object(value: unknown, key: string): MapValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key}: 应为映射`);
  return value as MapValue;
}
function string(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key}: 应为非空字符串`);
  return value;
}
function strings(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${key}: 应为字符串列表`);
  return value as string[];
}
function stringMap(value: unknown, key: string): Record<string, string> {
  const raw = object(value, key);
  for (const [name, item] of Object.entries(raw)) string(item, `${key}.${name}`);
  return raw as Record<string, string>;
}
function stringLists(value: unknown, key: string): Record<string, string[]> {
  if (Array.isArray(value)) throw new Error(`${key}: 列表写法已不支持，请改为按项目目录名映射到简称列表`);
  const raw = object(value, key);
  for (const [name, aliases] of Object.entries(raw)) {
    string(name, `${key} 的项目目录名`);
    strings(aliases, `${key}.${name}`);
  }
  return raw as Record<string, string[]>;
}
function document(path: string, key: string): MapValue {
  let source: string;
  try { source = readFileSync(path, 'utf8'); } catch (error) { throw new Error(`${key}: 无法读取 ${path}: ${String(error)}`); }
  const parsed = parseDocument(source, { uniqueKeys: true });
  if (parsed.errors.length) throw new Error(`${key}: ${parsed.errors.map(error => error.message).join('; ')}`);
  return object(parsed.toJS(), key);
}
function directory(value: unknown, key: string): string {
  const input = string(value, key);
  const raw = input === '~' ? homedir() : input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
  if (!isAbsolute(raw)) throw new Error(`${key}: 必须为绝对路径`);
  try { const path = realpathSync(raw); if (!statSync(path).isDirectory()) throw new Error('不是目录'); return path; }
  catch (error) { throw new Error(`${key}: 目录不可用 ${raw}: ${String(error)}`); }
}
/** Read current consent without replacing frozen tool, provider, or workflow settings. */
export function refreshAssetSearchRoots(config: LocalConfig): LocalConfig {
  if (!config.assetSearchRootsConfigPath) return config;
  try {
    const root = document(config.assetSearchRootsConfigPath, '素材目录授权');
    return { ...config, assetSearchRoots: strings(root.assetSearchRoots ?? [], 'assetSearchRoots')
      .map((path, i) => directory(path, `assetSearchRoots[${i}]`)) };
  } catch {
    // Missing or damaged consent never retains old access, and must not stop unrelated running work.
    return { ...config, assetSearchRoots: [] };
  }
}
function file(root: string, value: unknown, key: string): string {
  const raw = string(value, key);
  const path = resolve(root, raw);
  if (!hostPlatform.within(root, path)) throw new Error(`${key}: 不得越出所在目录`);
  try {
    const actual = realpathSync(path);
    if (!hostPlatform.within(root, actual)) throw new Error('符号链接越出所在目录');
    if (!statSync(actual).isFile()) throw new Error('不是文件');
    readFileSync(actual);
    return actual;
  }
  catch (error) { throw new Error(`${key}: 文件不可用 ${path}: ${String(error)}`); }
}
function importSettings(value: unknown): Partial<ImportConfig> {
  if (value === undefined) return {};
  const raw = object(value, 'import');
  const result: Partial<ImportConfig> = {};
  for (const key of ['recordNames', 'ledgerNames', 'externalLedgerDirs', 'externalLedgerFiles', 'metaPrograms', 'decisionTitlePatterns', 'ignoredSnapshotDirs', 'forbiddenDeliveryPaths', 'artifactPathPrefixes', 'deliveryArchives'] as const) {
    if (raw[key] !== undefined) Object.assign(result, { [key]: strings(raw[key], `import.${key}`) });
  }
  if (raw.aliasGroups !== undefined) {
    const groups = object(raw.aliasGroups, 'import.aliasGroups');
    result.aliasGroups = Object.fromEntries(Object.entries(groups).map(([name, members]) => [name, strings(members, `import.aliasGroups.${name}`)]));
  }
  for (const [index, pattern] of (result.decisionTitlePatterns ?? []).entries()) {
    try { new RegExp(pattern, 'i'); }
    catch (error) { throw new Error(`import.decisionTitlePatterns[${index}]: 正则无效: ${String(error)}`); }
  }
  if (raw.decisionTables !== undefined) {
    if (!Array.isArray(raw.decisionTables)) throw new Error('import.decisionTables: 应为列表');
    result.decisionTables = raw.decisionTables.map((entry, i) => {
      const key = `import.decisionTables[${i}]`; const item = object(entry, key); const columns = object(item.columns, `${key}.columns`);
      const required = ['id', 'project', 'question', 'choice', 'answer'] as const;
      const mapped = Object.fromEntries(required.map(name => [name, string(columns[name], `${key}.columns.${name}`)]));
      for (const name of ['time', 'flag'] as const) if (columns[name] !== undefined) mapped[name] = string(columns[name], `${key}.columns.${name}`);
      const glob = string(item.glob, `${key}.glob`);
      if (glob.startsWith('/') || glob.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${key}.glob: 应为工作区内相对通配`);
      return { glob, columns: mapped as NonNullable<ImportConfig['decisionTables']>[number]['columns'] };
    });
  }
  for (const key of ['historicalDir', 'clientPattern', 'privatePattern'] as const) {
    if (raw[key] !== undefined) Object.assign(result, { [key]: string(raw[key], `import.${key}`) });
  }
  for (const key of ['snapshotSampleThresholdBytes', 'maxDeliveryArchiveBytes', 'recentTimelineCount'] as const) {
    if (raw[key] !== undefined) {
      if (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0) throw new Error(`import.${key}: 应为非负整数`);
      Object.assign(result, { [key]: raw[key] });
    }
  }
  if (raw.packageBaseline !== undefined) result.packageBaseline = stringMap(raw.packageBaseline, 'import.packageBaseline');
  if (raw.packageBaselineByProject !== undefined) {
    const projects = object(raw.packageBaselineByProject, 'import.packageBaselineByProject');
    result.packageBaselineByProject = Object.fromEntries(Object.entries(projects).map(([name, packages]) =>
      [name, stringMap(packages, `import.packageBaselineByProject.${name}`)]));
  }
  for (const key of ['clientPattern', 'privatePattern'] as const) {
    try { new RegExp((result[key] ?? DEFAULT_IMPORT_CONFIG[key]) as string); }
    catch (error) { throw new Error(`import.${key}: 正则无效: ${String(error)}`); }
  }
  return result;
}
function validateStageRules(value: unknown, key: string, definition: ProcessDefinition): ImportConfig['stageRules'] {
  const rules = object(value, key);
  const stageIds = new Set(definition.stages.map(stage => stage.id));
  for (const [stageId, value] of Object.entries(rules)) {
    if (!stageIds.has(stageId)) throw new Error(`${key}.${stageId}: stage id 不在流程定义中`);
    const rule = object(value, `${key}.${stageId}`);
    for (const field of ['claimPatterns', 'notApplicablePatterns', 'verificationIds', 'documentPatterns']) {
      if (rule[field] === undefined) continue;
      const values = strings(rule[field], `${key}.${stageId}.${field}`);
      if (field === 'documentPatterns') {
        for (const [index, pattern] of values.entries()) {
          if (isAbsolute(pattern) || pattern.includes('\\') || pattern.split('/').some(part => !part || part === '.' || part === '..'))
            throw new Error(`${key}.${stageId}.${field}[${index}]: 须为项目根相对通配`);
        }
        continue;
      }
      if (field !== 'verificationIds') for (const [index, pattern] of values.entries()) {
        try { new RegExp(pattern, 'i'); }
        catch (error) { throw new Error(`${key}.${stageId}.${field}[${index}]: 正则无效: ${String(error)}`); }
      }
    }
  }
  return rules as ImportConfig['stageRules'];
}
/** The loader already validated the table's shape against the definitions; rules only need the values. */
function thresholdTable(document: MapValue): Record<string, RuleValue> {
  const table = document.t && typeof document.t === 'object' && !Array.isArray(document.t) ? document.t as MapValue : {};
  const values: Record<string, RuleValue> = {};
  for (const [name, entry] of Object.entries(table)) {
    const value = entry && typeof entry === 'object' ? (entry as MapValue).value : undefined;
    if (typeof value === 'number' || typeof value === 'boolean') values[name] = value;
  }
  return values;
}
export function avhHome(env = process.env): string {
  return hostPlatform.dataHome(env);
}
export function loadConfig(home = avhHome()): LocalConfig {
  rejectCloudSyncedPath(home);
  // Read before anything is scheduled: a typo in the machine's Unity slot count must be reported where the
  // configuration is read, not in the middle of a Run whose launcher is the first to ask for the count.
  const unitySlots = unitySlotsSetting();
  try { home = realpathSync(home); }
  catch (error) { throw new Error(`AVH_HOME: 目录不可用 ${home}: ${String(error)}`); }
  const root = document(join(home, 'config/harness.yaml'), 'config/harness.yaml');
  const workspaceRoot = directory(root.workspaceRoot, 'workspaceRoot');
  rejectCloudSyncedPath(workspaceRoot);
  if (hostPlatform.within(workspaceRoot, home)) throw new Error('AVH_HOME: 必须在工作区外，状态库不能写入工作区');
  const toolRoot = directory(root.toolRoot, 'toolRoot');
  const knowledgeRoot = directory(root.knowledgeRoot, 'knowledgeRoot');
  const rawVariables = root.workflowVariables === undefined ? {} : object(root.workflowVariables, 'workflowVariables');
  const workflowVariables: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawVariables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`workflowVariables.${name}: 名称无效`);
    workflowVariables[name] = directory(value, `workflowVariables.${name}`);
  }
  for (const name of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py'])
    file(toolRoot, name, `toolRoot/${name}`);
  const exportRoots = strings(root.exportRoots, 'exportRoots').map((path, i) => directory(path, `exportRoots[${i}]`));
  for (const [index, path] of exportRoots.entries()) {
    if (hostPlatform.within(workspaceRoot, path)) throw new Error(`exportRoots[${index}]: 必须在工作区外`);
  }
  const knownBodies = strings(root.knownBodies, 'knownBodies');
  const projectAliases = stringLists(root.projectAliases, 'projectAliases');
  const sampleNames = strings(root.sampleNames, 'sampleNames');
  const rawDb = root.stateDbPath === undefined ? 'state/harness.db' : string(root.stateDbPath, 'stateDbPath');
  const stateDbPath = resolve(home, rawDb);
  const dbRel = relative(home, stateDbPath);
  if (!hostPlatform.within(home, stateDbPath) || dbRel === '') throw new Error('stateDbPath: 必须在 AVH_HOME 内');
  if (existsSync(stateDbPath) && !statSync(stateDbPath).isFile()) throw new Error('stateDbPath: 不是文件');
  let ancestor = stateDbPath;
  while (!existsSync(ancestor)) ancestor = resolve(ancestor, '..');
  const actual = realpathSync(ancestor);
  if (!hostPlatform.within(home, actual)) throw new Error('stateDbPath: 符号链接越出 AVH_HOME');
  if (hostPlatform.within(workspaceRoot, stateDbPath)) throw new Error('stateDbPath: 必须在工作区外');
  const profileFiles = object(root.processDefinitions, 'processDefinitions');
  const thresholdPath = file(knowledgeRoot, root.thresholdsFile, 'thresholdsFile');
  const thresholds = document(thresholdPath, 'thresholdsFile');
  const ruleRoot = root.stageRulesFile === undefined ? {} : document(file(knowledgeRoot, root.stageRulesFile, 'stageRulesFile'), 'stageRulesFile');
  const definitions: Record<string, ProcessDefinition> = {};
  const capabilities: Record<string, CapabilityManifest> = {};
  const thresholdValues = thresholdTable(thresholds);
  const importByProfile: Record<string, ImportConfig> = {};
  const provenanceFiles: NonNullable<LocalConfig['provenanceFiles']> = {};
  const shared = importSettings(root.import);
  for (const [id, value] of Object.entries(profileFiles)) {
    const key = `processDefinitions.${id}`;
    const entry = typeof value === 'string' ? { definition: value } : object(value, key);
    if (typeof value !== 'string') {
      const unknown = Object.keys(entry).filter(name => !['definition', 'stageRules', 'capabilities'].includes(name));
      if (unknown.length) throw new Error(`${key}: 未知字段 ${unknown.join(', ')}`);
      if (entry.stageRules !== undefined) string(entry.stageRules, `${key}.stageRules`);
    }
    const path = file(knowledgeRoot, entry.definition, `${key}.definition`);
    try { definitions[id] = loadProcess(readFileSync(path, 'utf8'), thresholds); }
    catch (error) { throw new Error(`${key}: ${String(error)}`); }
    if (definitions[id].id !== id) throw new Error(`${key}: 文件 id 为 ${definitions[id].id}`);
    if (entry.stageRules !== undefined && Object.hasOwn(ruleRoot, id)) throw new Error(`${key}.stageRules: 与 stageRulesFile.${id} 同时配置`);
    let rules: ImportConfig['stageRules'];
    if (entry.stageRules !== undefined) {
      const ruleKey = `${key}.stageRules`;
      const rule = document(file(knowledgeRoot, entry.stageRules, ruleKey), ruleKey);
      string(rule.schema, `${ruleKey}.schema`);
      if (string(rule.process, `${ruleKey}.process`) !== id) throw new Error(`${ruleKey}.process: 应为 ${id}`);
      rules = validateStageRules(rule.stageRules, `${ruleKey}.stageRules`, definitions[id]);
    } else {
      rules = validateStageRules(ruleRoot[id] ?? {}, `stageRulesFile.${id}`, definitions[id]);
    }
    let capabilityPath: string | undefined;
    if (entry.capabilities !== undefined) {
      capabilityPath = file(knowledgeRoot, entry.capabilities, `${key}.capabilities`);
      try { capabilities[id] = loadCapabilities(readFileSync(capabilityPath, 'utf8'), definitions[id]); }
      catch (error) { throw new Error(`${key}.capabilities: ${error instanceof Error ? error.message : String(error)}`); }
    }
    provenanceFiles[id] = { knowledge: [path, thresholdPath, ...(capabilityPath ? [capabilityPath] : [])], interpretation: entry.stageRules !== undefined
      ? [file(knowledgeRoot, entry.stageRules, `${key}.stageRules`)]
      : root.stageRulesFile === undefined ? [] : [file(knowledgeRoot, root.stageRulesFile, 'stageRulesFile')] };
    importByProfile[id] = { ...DEFAULT_IMPORT_CONFIG, ...shared, toolRoot, exportRoots, knownBodies, sampleNames, stageRules: rules };
  }
  if (!Object.keys(definitions).length) throw new Error('processDefinitions: 至少需要一个流程定义');
  for (const id of Object.keys(ruleRoot)) if (!definitions[id]) throw new Error(`stageRulesFile.${id}: 没有对应流程定义`);
  const defaultProfile = string(root.defaultProfile, 'defaultProfile');
  if (!definitions[defaultProfile]) throw new Error(`defaultProfile: 未定义 ${defaultProfile}`);
  const providerPolicyVersion = root.providerPolicyVersion === undefined ? 'local/0.1' : string(root.providerPolicyVersion, 'providerPolicyVersion');
  const providerProbeTtlMs = root.providerProbeTtlMs === undefined ? 60000 : root.providerProbeTtlMs;
  if (!Number.isSafeInteger(providerProbeTtlMs) || (providerProbeTtlMs as number) < 0)
    throw new Error('providerProbeTtlMs: 应为非负整数');
  const scan = root.scanLimits === undefined ? {} : object(root.scanLimits, 'scanLimits');
  const scanLimit = (name: 'gitOutputBytes' | 'hashBytes', fallback: number): number => {
    const value = scan[name] ?? fallback;
    if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`scanLimits.${name}: 应为正整数`);
    return value as number;
  };
  return { home, workspaceRoot, coordination:coordinationSettings(root.coordination),toolRoot, knowledgeRoot, workflowVariables, exportRoots, knownBodies, projectAliases, sampleNames, stateDbPath, defaultProfile, definitions,
    unitySlots,
    assetSearchRoots: strings(root.assetSearchRoots ?? [], 'assetSearchRoots').map((path, i) => directory(path, `assetSearchRoots[${i}]`)),
    assetSearchRootsConfigPath: join(home, 'config/harness.yaml'),
    capabilities, thresholdValues, thresholdsVersion: String(thresholds.version ?? 'unknown'), importByProfile,
    provenanceFiles, importSettings: root.import === undefined ? {} : object(root.import, 'import'),
    providers: providers(root.providers, toolRoot), providerPolicyVersion, providerProbeTtlMs: providerProbeTtlMs as number,
    routing: routing(root.routing), scanLimits: { gitOutputBytes: scanLimit('gitOutputBytes', DEFAULT_GIT_OUTPUT_LIMIT),
      hashBytes: scanLimit('hashBytes', DEFAULT_HASH_LIMIT) },
    ...(root.contributionUpstream===undefined?{}:{contributionUpstream:contributionUpstream(root.contributionUpstream)}),
    ...(contributorName(root.contributorName)===undefined?{}:{contributorName:contributorName(root.contributorName)}),
    ...(root.unity === undefined ? {} : { unity: unitySettings(root.unity, home) }) };
}
