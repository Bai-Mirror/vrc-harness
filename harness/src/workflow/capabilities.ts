import { isAbsolute } from 'node:path';
import { parseDocument } from 'yaml';
import type { ProcessDefinition } from '../process/types.ts';
import type { UnityStep } from '../exec/unity-steps.ts';
import type { ContextCondition, ContextReference, ContextScalar } from './context-compiler.ts';

/**
 * How a process profile is carried out on disk: which files each artifact kind is, how each stage's work is
 * done, and how each `observe` capability produces metrics. The process definition says what must hold;
 * this manifest says how the Runtime does and measures it. Frozen into the Workflow when it is created.
 */
export type RuntimeInputSource = { kind: 'runtime'; input: 'face_input' };
export interface ArtifactSpec {
  /** Runtime-managed logical input; no project file or Provider can author its identity. */
  source?: RuntimeInputSource;
  /** Git pathspecs relative to the project; tracked and untracked files, ignored files excluded. */
  paths: string[];
  /** Walk the file system under `paths` (plain relative paths) instead, for ignored outputs such as builds. */
  includeIgnored?: boolean;
  /** For the plan kind: the document the Workflow reads `plan.*` conditions from. */
  format?: 'yaml' | 'json';
  /**
   * A file (one of `paths`) listing more member paths, one per line, written by the stage that produces the
   * artifact: for vendor imports whose folders are known only after import. Listed paths are members too.
   */
  listed?: string;
}
/** Run-directory subfolder for metrics written by Runtime-controlled steps. */
export const OBSERVATIONS_DIR = 'observations';
export type StageMode = 'provider' | 'tool' | 'none';
export interface StageCapability {
  mode: StageMode;
  /** A frozen condition on approved input facts; otherwise execute the deterministic preservation command. */
  providerWhen?: ContextCondition;
  otherwiseCommand?: string[];
  /** Goal text for the executor; `{{plan.x}}`, `{{manifest.request}}`, `{{stage}}` are filled in. */
  goal?: string;
  role?: 'executor' | 'diagnostician' | 'reviewer' | 'research';
  provider?: string;
  requiredCapabilities?: string[];
  /** Harness-selected knowledge entries; strings are legacy whole-file required entries. */
  context: ContextReference[];
  contextBudgetChars: number;
  contextCoverage: string[];
  allowedWrites: string[];
  /** Additional outputs owned only by supervised Runtime preparation/Unity, never by the Provider. */
  runtimeWrites?: string[];
  /**
   * The pack files this stage deploys into the project as `source -> target`. This is the single statement
   * of what gets deployed; see `stageDeployment` for how a stage without one is derived.
   */
  deployment?: Array<{ source: string; target: string }>;
  /** Exact transient files for supervised atomic writes; granted without declaring durable outputs. */
  runtimeTemporaryWrites?: string[];
  /** Concrete Runtime-owned face choice consumed by this tool stage when face design is enabled. */
  selectionGate?: string;
  resources: string[];
  unitySteps?: UnityStep[];
  /** Frozen deterministic command which Runtime must complete after a Provider exits and before Unity starts. */
  prepareCommand?: string[];
  /** Frozen, hash-verified commands the provider may invoke. They are capabilities, not proof of success. */
  agentTools?: Record<string, string[]>;
  /** mode tool: argv run under the write boundary; `{toolRoot}`, `{project}`, `{runDir}` are substituted. */
  command?: string[];
  /** Trusted tool stages may fetch pinned public dependencies; never parsed from an executor's task YAML. */
  network?: boolean;
  maxRetries: number;
  /** Additional provider Runs automatically authorized by failed independent checks. */
  maxCheckRetries: number;
}
export type ObserverSpec =
  | { kind: 'command'; command: string[]; timeoutSec: number }
  /** Produced during the stage Run by Runtime-controlled steps (tool or Unity), read from the Run directory. */
  | { kind: 'run-file'; runFile: string };
export interface CapabilityManifest {
  schema: 'capabilities/0.1';
  process: string;
  version: string;
  artifacts: Record<string, ArtifactSpec>;
  stages: Record<string, StageCapability>;
  observers: Record<string, ObserverSpec>;
}

type Obj = Record<string, unknown>;
function object(value: unknown, at: string): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: 应为映射`);
  return value as Obj;
}
function string(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${at}: 应为非空字符串`);
  return value;
}
function strings(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${at}: 应为字符串列表`);
  return value as string[];
}
function list(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at}: 应为列表`);
  return value;
}
function only(raw: Obj, keys: string[], at: string): void {
  const unknown = Object.keys(raw).filter(key => !keys.includes(key));
  if (unknown.length) throw new Error(`${at}: 未知字段 ${unknown.join(', ')}`);
}
function relativePath(value: string, at: string): string {
  if (isAbsolute(value) || value.split('/').some(part => part === '..') || value.startsWith('run:'))
    throw new Error(`${at}: 须为工程内相对路径`);
  return value;
}
function contextCondition(value: unknown, at: string): ContextCondition {
  const item = object(value, at);
  only(item, ['path', 'exists', 'equals', 'includes'], at);
  const path = string(item.path, `${at}.path`);
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(path)) throw new Error(`${at}.path: 无效事实路径`);
  const operations = ['exists', 'equals', 'includes'].filter(key => Object.hasOwn(item, key));
  if (operations.length !== 1) throw new Error(`${at}: exists、equals、includes 必须且只能声明一个`);
  if (item.exists !== undefined && typeof item.exists !== 'boolean') throw new Error(`${at}.exists: 应为布尔值`);
  for (const key of ['equals', 'includes'] as const) if (Object.hasOwn(item, key) &&
    !['string', 'number', 'boolean'].includes(typeof item[key]) && item[key] !== null) throw new Error(`${at}.${key}: 应为标量`);
  return { path, ...(item.exists !== undefined ? { exists: item.exists as boolean } : {}),
    ...(Object.hasOwn(item, 'equals') ? { equals: item.equals as ContextScalar } : {}),
    ...(Object.hasOwn(item, 'includes') ? { includes: item.includes as ContextScalar } : {}) };
}
function contextReferences(value: unknown, at: string): ContextReference[] {
  if (!Array.isArray(value)) throw new Error(`${at}: 应为列表`);
  return value.map((raw, i) => {
    const where = `${at}[${i}]`;
    if (typeof raw === 'string') {
      const path = relativePath(string(raw, where), where);
      return { id: path, path, priority: 0, required: true, when: [], unless: [], excludes: [], covers: [], models: [] };
    }
    const item = object(raw, where);
    only(item, ['id', 'path', 'heading', 'priority', 'required', 'when', 'unless', 'excludes', 'covers', 'models'], where);
    const path = relativePath(string(item.path, `${where}.path`), `${where}.path`);
    const id = string(item.id ?? `${path}${item.heading ? `#${item.heading}` : ''}`, `${where}.id`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) throw new Error(`${where}.id: 无效条目 id`);
    const priority = item.priority ?? 0;
    if (!Number.isSafeInteger(priority) || (priority as number) < -10000 || (priority as number) > 10000)
      throw new Error(`${where}.priority: 应为 -10000 至 10000 的整数`);
    if (item.required !== undefined && typeof item.required !== 'boolean') throw new Error(`${where}.required: 应为布尔值`);
    const conditions = (key: 'when' | 'unless') => item[key] === undefined ? [] :
      (Array.isArray(item[key]) ? item[key] as unknown[] : (() => { throw new Error(`${where}.${key}: 应为列表`); })())
        .map((entry, n) => contextCondition(entry, `${where}.${key}[${n}]`));
    return { id, path, ...(item.heading === undefined ? {} : { heading: string(item.heading, `${where}.heading`) }),
      priority: priority as number, required: item.required === true, when: conditions('when'), unless: conditions('unless'),
      excludes: strings(item.excludes ?? [], `${where}.excludes`), covers: strings(item.covers ?? [], `${where}.covers`),
      models: strings(item.models ?? [], `${where}.models`) };
  });
}
function unitySteps(value: unknown, at: string): UnityStep[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${at}: 应为非空列表`);
  return value.map((entry, i) => {
    const item = object(entry, `${at}[${i}]`);
    only(item, ['method', 'quit', 'timeoutSec', 'env', 'project'], `${at}[${i}]`);
    if (item.project !== undefined && (typeof item.project !== 'string' || isAbsolute(item.project) ||
      item.project.split('/').some(part => part === '..' || part === '')))
      throw new Error(`${at}[${i}].project: 须为工程内相对路径`);
    if (item.quit !== undefined && typeof item.quit !== 'boolean') throw new Error(`${at}[${i}].quit: 应为布尔值`);
    if (item.timeoutSec !== undefined && (!Number.isSafeInteger(item.timeoutSec) || (item.timeoutSec as number) < 1))
      throw new Error(`${at}[${i}].timeoutSec: 应为正整数`);
    const env = item.env === undefined ? {} : object(item.env, `${at}[${i}].env`);
    for (const [name, v] of Object.entries(env))
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof v !== 'string') throw new Error(`${at}[${i}].env.${name}: 无效`);
    return { method: string(item.method, `${at}[${i}].method`), quit: item.quit !== false,
      ...(item.timeoutSec === undefined ? {} : { timeoutSec: item.timeoutSec as number }), env: env as Record<string, string>,
      ...(item.project === undefined ? {} : { project: item.project as string }) };
  });
}

/** Files under the tool root that stage commands and observers run, as `{toolRoot}/<path>` arguments. */
export function toolReferences(argv: string[]): string[] {
  return argv.flatMap(arg => {
    const match = /\{toolRoot\}\/(.+)$/.exec(arg);
    return match ? [match[1]!] : [];
  });
}
export function manifestToolReferences(manifest: CapabilityManifest): string[] {
  return [...new Set([...Object.values(manifest.stages).flatMap(stage => [stage.command ?? [], stage.prepareCommand ?? [], stage.otherwiseCommand ?? [],
      ...Object.values(stage.agentTools ?? {})].flatMap(toolReferences)),
    ...Object.values(manifest.observers).flatMap(observer => observer.kind === 'command' ? toolReferences(observer.command) : [])])].sort();
}
/**
 * The pack files each stage deploys into the project, as `source -> target`.
 *
 * Which tools a stage deploys was previously expressed three times: the Runtime inferred it from the
 * prepare command's tool references, each tool carried its own source list, and the capability declared
 * runtimeWrites for a different purpose. The copies drifted, and a stage whose prepare command named a
 * helper rather than listing sources ended up with a deployment record missing a source it verifies, so
 * its preparation was refused. State the mapping once instead.
 *
 * A declaration wins; where a stage has none, the tools its commands name are deployed, which preserves
 * the older manifest shape so only the stages that differ need to declare anything.
 */
export function stageDeployment(stage: StageCapability): Array<{ source: string; target: string }> {
  if (stage.deployment?.length) return stage.deployment.map(entry => ({ ...entry }));
  const targets = new Set(stage.runtimeWrites ?? []);
  return [...new Set([...toolReferences(stage.command ?? []), ...toolReferences(stage.prepareCommand ?? [])])]
    .map(source => ({ source, target: 'Assets/_HarnessTools/Editor/' + source.split('/').at(-1)! }))
    .filter(entry => targets.has(entry.target));
}

/**
 * Every stage's deployment, validated so a caller can treat it as the single statement of intent: no two
 * declarations claim one target through different paths or differ only by case, which the platform would
 * treat as one file.
 */
export function validatedDeployment(manifest: CapabilityManifest): Array<{ source: string; target: string }> {
  const resolved: Array<{ source: string; target: string }> = [];
  const claimed = new Map<string, { source: string; target: string }>();
  for (const stage of Object.values(manifest.stages)) for (const entry of stageDeployment(stage)) {
    const key = entry.target.toLowerCase();
    const prior = claimed.get(key);
    if (prior && (prior.target !== entry.target || prior.source !== entry.source))
      throw new Error(`受管工具部署目标冲突：${prior.target} 与 ${entry.target}（来源 ${prior.source} 与 ${entry.source}）`);
    if (prior) continue;
    claimed.set(key, entry);
    resolved.push({ ...entry });
  }
  return resolved;
}

/** Machine-specific placeholders a managed capability needs, excluding Runtime-owned paths. */
export function manifestVariableReferences(manifest: CapabilityManifest): string[] {  const commands = [...Object.values(manifest.stages).flatMap(stage => [stage.command ?? [], stage.prepareCommand ?? [], stage.otherwiseCommand ?? [],
      ...Object.values(stage.agentTools ?? {})].flat()),
    ...Object.values(manifest.observers).flatMap(observer => observer.kind === 'command' ? observer.command : [])];
  const runtime = new Set(['toolRoot', 'project', 'runDir', 'out', 'templateSource']);
  return [...new Set(commands.flatMap(arg => [...arg.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match => match[1]!))
    .filter(name => !runtime.has(name)))].sort();
}
/** Parse and cross-check against the process definition it serves; every reference must resolve. */
export function loadCapabilities(text: string, definition: ProcessDefinition): CapabilityManifest {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors.map(error => error.message).join('; '));
  const raw = object(doc.toJS(), 'capabilities');
  only(raw, ['schema', 'process', 'version', 'artifacts', 'stages', 'observers'], 'capabilities');
  if (raw.schema !== 'capabilities/0.1') throw new Error('schema: 应为 capabilities/0.1');
  const process = string(raw.process, 'process');
  if (process !== definition.id) throw new Error(`process: 应为 ${definition.id}`);
  const version = string(String(raw.version ?? ''), 'version');

  const artifacts: Record<string, ArtifactSpec> = {};
  const rawArtifacts = object(raw.artifacts, 'artifacts');
  for (const kind of definition.artifacts) {
    const at = `artifacts.${kind}`;
    const item = object(rawArtifacts[kind], at);
    only(item, ['source', 'paths', 'includeIgnored', 'format', 'listed'], at);
    if (item.source !== undefined) {
      const source = object(item.source, `${at}.source`);
      only(source, ['kind', 'input'], `${at}.source`);
      if (source.kind !== 'runtime' || source.input !== 'face_input' || kind !== 'face_input')
        throw new Error(`${at}.source: 未知 Runtime 输入来源`);
      if (Object.keys(item).some(key => key !== 'source')) throw new Error(`${at}: Runtime 输入不能声明文件路径或格式`);
      if (definition.stages.some(stage => stage.produces.includes(kind))) throw new Error(`${at}: Runtime 输入不能由执行阶段生成`);
      artifacts[kind] = { paths: [], source: { kind: 'runtime', input: 'face_input' } };
      continue;
    }
    const paths = strings(item.paths, `${at}.paths`).map((path, i) => relativePath(path, `${at}.paths[${i}]`));
    if (!paths.length) throw new Error(`${at}.paths: 不得为空`);
    if (item.includeIgnored !== undefined && typeof item.includeIgnored !== 'boolean') throw new Error(`${at}.includeIgnored: 应为布尔值`);
    if (item.format !== undefined && item.format !== 'yaml' && item.format !== 'json') throw new Error(`${at}.format: 应为 yaml 或 json`);
    if (item.format !== undefined && kind !== 'plan') throw new Error(`${at}.format: 只有 plan 产物可声明`);
    if (item.listed !== undefined && (typeof item.listed !== 'string' || !paths.some(path => item.listed === path ||
      (item.listed as string).startsWith(path.endsWith('/') ? path : `${path}/`))))
      throw new Error(`${at}.listed: 清单文件须位于 paths 之内`);
    artifacts[kind] = { paths, ...(item.includeIgnored ? { includeIgnored: true } : {}),
      ...(item.format ? { format: item.format as 'yaml' | 'json' } : {}),
      ...(item.listed ? { listed: item.listed as string } : {}) };
  }
  const extra = Object.keys(rawArtifacts).filter(kind => !definition.artifacts.includes(kind));
  if (extra.length) throw new Error(`artifacts: 流程定义没有这些产物种类 ${extra.join(', ')}`);
  if (definition.artifacts.includes('plan') && artifacts.plan!.paths.length !== 1)
    throw new Error('artifacts.plan.paths: 方案必须是单个文件');

  const stages: Record<string, StageCapability> = {};
  const rawStages = object(raw.stages, 'stages');
  for (const stage of definition.stages) {
    const at = `stages.${stage.id}`;
    const item = object(rawStages[stage.id], at);
    only(item, ['mode', 'providerWhen', 'otherwiseCommand', 'goal', 'role', 'provider', 'requiredCapabilities', 'context', 'contextBudgetChars', 'contextCoverage', 'allowedWrites', 'runtimeWrites', 'runtimeTemporaryWrites', 'selectionGate', 'resources', 'unitySteps', 'prepareCommand', 'agentTools',
      'command', 'network', 'maxRetries', 'maxCheckRetries', 'deployment'], at);
    const mode = string(item.mode, `${at}.mode`) as StageMode;
    if (!['provider', 'tool', 'none'].includes(mode)) throw new Error(`${at}.mode: 应为 provider、tool 或 none`);
    const providerWhen = item.providerWhen === undefined ? undefined : contextCondition(item.providerWhen, `${at}.providerWhen`);
    const otherwiseCommand = item.otherwiseCommand === undefined ? undefined : strings(item.otherwiseCommand, `${at}.otherwiseCommand`);
    if ((providerWhen || otherwiseCommand) && (mode !== 'provider' || !providerWhen || !otherwiseCommand?.length))
      throw new Error(`${at}: providerWhen 与非空 otherwiseCommand 必须同时用于 provider 阶段`);
    if (providerWhen && !/^(plan|manifest)\./.test(providerWhen.path))
      throw new Error(`${at}.providerWhen: 只能读取批准方案或冻结输入事实`);
    if (item.network !== undefined && (typeof item.network !== 'boolean' || mode !== 'tool'))
      throw new Error(`${at}.network: 只有受管 tool 阶段可声明布尔网络权限`);
    const allowedWrites = strings(item.allowedWrites ?? [], `${at}.allowedWrites`)
      .map((path, i) => path === '.' ? path : relativePath(path, `${at}.allowedWrites[${i}]`));
    const runtimeWrites = strings(item.runtimeWrites ?? [], `${at}.runtimeWrites`)
      .map((path, i) => relativePath(path, `${at}.runtimeWrites[${i}]`));
    const deployment = item.deployment === undefined ? undefined : list(item.deployment, `${at}.deployment`).map((raw, i) => {
      const at2 = `${at}.deployment[${i}]`;
      const entry = object(raw, at2);
      only(entry, ['source', 'target'], at2);
      const source = string(entry.source, `${at2}.source`).replace(/\\/g, '/');
      // A source names a file inside the pack, so it must stay inside it and keep its extension.
      if (source.startsWith('/') || source.split('/').some(part => !part || part === '.' || part === '..'))
        throw new Error(`${at2}.source: 须为包内相对路径`);
      if (!/\.(cs|py)$/.test(source)) throw new Error(`${at2}.source: 受管工具须为 .cs 或 .py`);
      const target = relativePath(string(entry.target, `${at2}.target`), `${at2}.target`);
      return { source, target };
    });
    const runtimeTemporaryWrites = strings(item.runtimeTemporaryWrites ?? [], `${at}.runtimeTemporaryWrites`)
      .map((path, i) => {
        relativePath(path, `${at}.runtimeTemporaryWrites[${i}]`);
        if (/[\\:*?\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.') || path === '.')
          throw new Error(`${at}.runtimeTemporaryWrites: 须声明精确文件，不能授予目录或通配符`);
        return path;
      });
    if (runtimeTemporaryWrites.some(path => runtimeWrites.includes(path) || stage.produces.some(kind => artifacts[kind]?.paths.includes(path))))
      throw new Error(`${at}.runtimeTemporaryWrites: 临时文件不能同时声明为持久产物`);
    for (const output of [...runtimeWrites, ...runtimeTemporaryWrites]) for (const granted of allowedWrites) {
      const a = granted.replace(/\/+$/, ''), b = output.replace(/\/+$/, '');
      if (a === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
        throw new Error(`${at}.runtimeWrites: 运行时独占输出不能与执行方写范围重叠`);
    }
    const resources = strings(item.resources ?? [], `${at}.resources`);
    const context = contextReferences(item.context ?? [], `${at}.context`);
    const contextBudgetChars = item.contextBudgetChars ?? 48000;
    if (!Number.isSafeInteger(contextBudgetChars) || (contextBudgetChars as number) < 1000 || (contextBudgetChars as number) > 500000)
      throw new Error(`${at}.contextBudgetChars: 应为 1000 至 500000 的整数`);
    const contextCoverage = strings(item.contextCoverage ?? [], `${at}.contextCoverage`);
    const contextIds = new Set(context.map(entry => entry.id));
    if (contextIds.size !== context.length) throw new Error(`${at}.context: 条目 id 不得重复`);
    // One section may be listed more than once (say, a high priority when the stage failed before and a low default);
    // the compiler injects it at most once.
    for (const entry of context) for (const excluded of entry.excludes)
      if (!contextIds.has(excluded)) throw new Error(`${at}.context.${entry.id}.excludes: 未知条目 ${excluded}`);
    const steps = item.unitySteps === undefined ? undefined : unitySteps(item.unitySteps, `${at}.unitySteps`);
    const prepareCommand = item.prepareCommand === undefined ? undefined : strings(item.prepareCommand, `${at}.prepareCommand`);
    if ((runtimeWrites.length || runtimeTemporaryWrites.length) && !steps) throw new Error(`${at}.runtimeWrites: 需要受管 Unity 步骤`);
    if (prepareCommand && !prepareCommand.length) throw new Error(`${at}.prepareCommand: 命令不得为空`);
    if (prepareCommand && mode !== 'provider') throw new Error(`${at}.prepareCommand: 只有 provider 阶段可声明`);
    if (prepareCommand && !steps) throw new Error(`${at}.prepareCommand: 需要 unitySteps`);
    const agentTools: Record<string, string[]> = {};
    if (item.agentTools !== undefined) {
      const tools = object(item.agentTools, `${at}.agentTools`);
      for (const [name, argv] of Object.entries(tools)) {
        if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`${at}.agentTools.${name}: 名称无效`);
        const parsed = strings(argv, `${at}.agentTools.${name}`);
        if (!parsed.length) throw new Error(`${at}.agentTools.${name}: 命令不得为空`);
        agentTools[name] = parsed;
      }
      if (mode !== 'provider') throw new Error(`${at}.agentTools: 只有 provider 阶段可声明`);
    }
    if (steps && !resources.includes('unity_batch')) throw new Error(`${at}: unitySteps 需要 resources: [unity_batch]`);
    const maxRetries = item.maxRetries ?? 0;
    if (!Number.isSafeInteger(maxRetries) || (maxRetries as number) < 0) throw new Error(`${at}.maxRetries: 应为非负整数`);
    const maxCheckRetries = item.maxCheckRetries ?? 0;
    if (!Number.isSafeInteger(maxCheckRetries) || (maxCheckRetries as number) < 0)
      throw new Error(`${at}.maxCheckRetries: 应为非负整数`);
    if (mode === 'provider' && item.goal === undefined) throw new Error(`${at}: provider 阶段需要 goal`);
    if (mode === 'tool' && item.command === undefined && !steps) throw new Error(`${at}: tool 阶段需要 command 或 unitySteps`);
    if (mode === 'none' && (item.goal !== undefined || item.command !== undefined || steps || allowedWrites.length))
      throw new Error(`${at}: none 阶段不执行任何工作，不能声明 goal、command、unitySteps 或 allowedWrites`);
    if (mode !== 'tool' && item.command !== undefined) throw new Error(`${at}.command: 只有 tool 阶段可声明`);
    if (mode === 'none' && stage.produces.length) throw new Error(`${at}: 有产出的阶段不能是 none`);
    const selectionGate = item.selectionGate === undefined ? undefined : string(item.selectionGate, `${at}.selectionGate`);
    if (selectionGate && (mode !== 'tool' || !definition.gates.some(gate => gate.id === selectionGate && gate.selection === 'face-candidate')))
      throw new Error(`${at}.selectionGate: 需要 tool 阶段及实际脸型候选 choose Gate`);
    if (selectionGate) {
      const ancestors = new Set<string>();
      const visit = (id: string): void => { if (ancestors.has(id)) return; ancestors.add(id); for (const need of definition.stages.find(item => item.id === id)!.needs) visit(need); };
      for (const need of stage.needs) visit(need);
      if (!definition.stages.some(item => ancestors.has(item.id) && item.gates.includes(selectionGate)))
        throw new Error(`${at}.selectionGate: 选择必须在本阶段之前的阶段完成`);
    }
    const role = item.role === undefined ? 'executor' : string(item.role, `${at}.role`);
    if (!['executor', 'diagnostician', 'reviewer', 'research'].includes(role)) throw new Error(`${at}.role: 无效`);
    stages[stage.id] = { mode, context, contextBudgetChars: contextBudgetChars as number, contextCoverage,
      ...(providerWhen ? { providerWhen, otherwiseCommand } : {}),
      ...(item.network === undefined ? {} : { network: item.network as boolean }),
      allowedWrites, resources, maxRetries: maxRetries as number,
      ...(runtimeWrites.length ? { runtimeWrites } : {}),
      ...(deployment?.length ? { deployment } : {}),
      ...(runtimeTemporaryWrites.length ? { runtimeTemporaryWrites } : {}),
      ...(selectionGate ? { selectionGate } : {}),
      maxCheckRetries: maxCheckRetries as number,
      ...(item.goal === undefined ? {} : { goal: string(item.goal, `${at}.goal`) }),
      ...(mode === 'provider' ? { role: role as StageCapability['role'] } : {}),
      ...(item.provider === undefined ? {} : { provider: string(item.provider, `${at}.provider`) }),
      ...(item.requiredCapabilities === undefined ? {} : { requiredCapabilities: strings(item.requiredCapabilities, `${at}.requiredCapabilities`) }),
      ...(steps ? { unitySteps: steps } : {}),
      ...(prepareCommand ? { prepareCommand } : {}),
      ...(Object.keys(agentTools).length ? { agentTools } : {}),
      ...(item.command === undefined ? {} : { command: strings(item.command, `${at}.command`) }) };
  }
  const extraStages = Object.keys(rawStages).filter(id => !definition.stages.some(stage => stage.id === id));
  if (extraStages.length) throw new Error(`stages: 流程定义没有这些阶段 ${extraStages.join(', ')}`);

  const observers: Record<string, ObserverSpec> = {};
  const rawObservers = object(raw.observers ?? {}, 'observers');
  const needed = new Set(definition.checks.filter(check => check.maturity !== 'deprecated').map(check => check.observe));
  for (const id of needed) {
    const at = `observers.${id}`;
    const item = object(rawObservers[id], at);
    if (item.command !== undefined) {
      only(item, ['command', 'timeoutSec'], at);
      const timeoutSec = item.timeoutSec ?? 300;
      if (!Number.isSafeInteger(timeoutSec) || (timeoutSec as number) < 1 || (timeoutSec as number) > 7200)
        throw new Error(`${at}.timeoutSec: 应为 1 至 7200`);
      const command = strings(item.command, `${at}.command`);
      if (!command.length) throw new Error(`${at}.command: 不得为空`);
      if (!command.includes('{out}')) throw new Error(`${at}.command: 必须把指标写到 {out}`);
      observers[id] = { kind: 'command', command, timeoutSec: timeoutSec as number };
    } else {
      only(item, ['runFile'], at);
      const runFile = string(item.runFile, `${at}.runFile`);
      if (isAbsolute(runFile) || runFile.split('/').some(part => part === '..' || !part)) throw new Error(`${at}.runFile: 须为 Run 目录内相对路径`);
      // The Runtime empties observations/ before its own steps run, so an executor cannot plant metrics there.
      if (!runFile.startsWith(`${OBSERVATIONS_DIR}/`)) throw new Error(`${at}.runFile: 须位于 Run 目录的 ${OBSERVATIONS_DIR}/ 下`);
      observers[id] = { kind: 'run-file', runFile };
    }
  }
  const extraObservers = Object.keys(rawObservers).filter(id => !needed.has(id));
  if (extraObservers.length) throw new Error(`observers: 没有检查使用 ${extraObservers.join(', ')}`);
  // A run-file observation must be produced by the Run of every stage that relies on it.
  for (const stage of definition.stages) {
    const capability = stages[stage.id]!;
    for (const checkId of stage.requires) {
      const check = definition.checks.find(item => item.id === checkId)!;
      const observer = observers[check.observe];
      if (observer?.kind !== 'run-file') continue;
      // Metrics must come from Runtime-controlled steps, never from what the executor wrote.
      if (capability.mode === 'none' || (capability.mode === 'provider' && !capability.unitySteps?.length))
        throw new Error(`stages.${stage.id}: 检查 ${check.id} 读取 Run 产出的 ${check.observe}，须由 tool 阶段或 Unity 步骤产出`);
    }
  }
  const manifest: CapabilityManifest = { schema: 'capabilities/0.1', process, version, artifacts, stages, observers };
  // Refuse an incoherent deployment set when the manifest loads, rather than when a stage is already
  // running and its record turns out not to describe what the tool verifies.
  validatedDeployment(manifest);
  return manifest;
}
