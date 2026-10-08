import { advanceProductionContinuations } from './production-face-continuation.ts';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync, readdirSync, mkdirSync, writeFileSync, lstatSync, readlinkSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { parseDocument } from 'yaml';
import { refreshAssetSearchRoots, type LocalConfig } from './config.ts';
import type { ProcessDefinition, Verdict } from './process/types.ts';
import { OBSERVATIONS_DIR } from './workflow/capabilities.ts';
import { aggregateWorkflow, buildAggregateInput } from './state/aggregate-input.ts';
import { recordEventOnce, withStateEvent } from './state/tx.ts';
import { acquireSchedulerLease, SchedulerLeaseLostError } from './state/scheduler-lease.ts';
import { advanceInteractions, assertCoordinatorDispatchAuthorization } from './interactions.ts';
import { FINISHED_TASK_STATUSES, Scheduler, type CancelResult, type CycleRuntime } from './runtime/scheduler.ts';
import { IDLE_FINGERPRINT_REFRESH_MS, newFingerprintCadence, type IdleFingerprintCadence } from './runtime/reconcile.ts';
import { DEFAULT_REDO_NOTE, requestHumanRedo, transitionTask } from './runtime/transitions.ts';
import type { Executor, Fingerprinter, RunResult, RunSpec, Verifier, RunHandle, Observation } from './runtime/interfaces.ts';
import { ProviderRegistry, probeProvider } from './providers/registry.ts';
import { ManagedProvider } from './providers/adapter.ts';
import type { ProviderConfig, ProviderProbe, ProviderRequest, ProviderSnapshot } from './providers/types.ts';
import { verifiedImageInputs, type ImageInput } from './image-inputs.ts';

/** Probe results shared by every Task in this process; the TTL keeps dispatch from spawning CLIs every scheduler round. */
const liveProbes = new Map<string, ProviderProbe>();
/**
 * A Task freezes which Providers and routing policy it may use. Whether a Provider can run now (installed, logged in,
 * under its quota) is a fact about now: a frozen "unavailable" would otherwise wait forever, and a frozen "ready"
 * would keep dispatching past a quota that has since been exceeded.
 */
export function liveProviderSnapshot(frozen: ProviderSnapshot, ttlMs: number, home?: string): ProviderSnapshot {
  return { ...frozen, providers: frozen.providers.map(({ config }) => {
    const key = `${config.id}\0${config.executable}`, cached = liveProbes.get(key);
    const probe = cached && ttlMs > 0 && Date.parse(cached.expiresAt) > Date.now() ? cached : probeProvider(config, ttlMs, cached, home);
    liveProbes.set(key, probe);
    return { config, probe };
  }) };
}
import { routeProviders, type RouteDecision } from './providers/routing.ts';
import { stepProject, type UnityStep, type UnityEvidence } from './exec/unity-steps.ts';
import { settleWindowsUnityEditors, unityOccupancyGuidance } from './exec/windows-unity.ts';
import { statusSnapshot as gitStatusSnapshot, changeEvidence, committedPaths, HOST_GIT_SAFETY, type ScanLimits } from './exec/git-scan.ts';
import { DEFAULT_CANCEL_TIMEOUT_MS, createRunExecutor, type UnitExecutor } from './exec/executor.ts';
import { HandoffLock } from './exec/handoff.ts';
import { createRunSupervisor } from './exec/run-supervisor.ts';
import { harnessVersion, knowledgeVersion } from './provenance.ts';
import { promptEvidence } from './run/evidence.ts';
import { selectProviderWithManifest } from './run/manifest.ts';
import { sha256File } from './file-hash.ts';
import { authorizeNativeImport, recoverNativeImport, restoredNativeImportPaths } from './workflow/native-import.ts';
import { hostPlatform, rejectCloudSyncedPath, type HostPlatform } from './host-platform.ts';
import { runtimeModule } from './module-path.ts';
import { cancelChecks, runCheckCommand } from './exec/check-runner.ts';
import { ToolRunner } from './exec/tool-runner.ts';
import { acceptWarning, formalGates, isFormalWorkflow, StageRouter, updateWorkflowStatus, workflowScheduler, workflowSnapshot } from './workflow/runtime.ts';
import { compileContext, contextAssemblyReport, contextPlanText, type ContextAssemblyReport, type FrozenContextPlan } from './workflow/context-compiler.ts';
import { projectSafePoint } from './archive/projection.ts';
import { ANALYSIS_FILE, BRIEF_FILE, TAKEOVER_FACTS_FILE, reconcileRecoveries, projectRoot, validateTakeoverOutputs } from './archive/takeover.ts';
import { inTransaction } from './archive/facts.ts';
import { warningRows } from './workflow/view.ts';
import { physicalWorkspace, physicalProject } from './project-identity.ts';

type Scope = 'edit' | 'build' | 'play' | 'client';
/** One independent check; exactly one of command, path (text readback), json (structured readback), or a fixed internal check. */
type Check = { id: string; scope?: Scope; on?: string;
  command?: string[]; exitCode?: number; timeoutSec?: number;
  path?: string; contains?: string; equals?: string;
  json?: string; field?: string; expect?: unknown; internal?: 'takeover-output' };
const CHECK_KEYS: Record<'command' | 'path' | 'json' | 'internal', string[]> = {
  command: ['command', 'exitCode', 'timeoutSec'], path: ['path', 'contains', 'equals'], json: ['json', 'field', 'expect'], internal: ['internal'] };
const SCOPES: readonly Scope[] = ['edit', 'build', 'play', 'client'];
export interface TaskSpec {
  schema: 'task/0.1'; goal: string; role: 'executor' | 'diagnostician' | 'reviewer' | 'research';
  provider?: string; allowedWrites: string[]; expectedOutputs: string[];
  inputImages?: ImageInput[];
  toolProfile?: 'coordination';
  requiredCapabilities: string[]; checks: Check[]; maxRetries: number; resources: string[];
  unitySteps?: UnityStep[];
  /** Trusted formal capability outputs; deliberately not accepted by the task YAML parser. */
  runtimeWrites?: string[];
  /** Runtime-only frozen alternatives, compiled after routing chooses the actual Provider family. */
  contextPlan?: FrozenContextPlan;
  /** What the compiled context actually contained, item by item, and what it left out and why. */
  contextAssembly?: ContextAssemblyReport;
  /** Runtime-owned deterministic bridge between a successful Provider and Unity (formal Workflow only). */
  prepare?: { argv: string[]; env: Record<string, string> };
  gate?: { id: string; question: string; bind: string };
  /** Deterministic stage work instead of a Provider (formal Workflow stages only; never parsed from task YAML). */
  tool?: { argv: string[]; env: Record<string, string>; network?: boolean };
}
type Occupant = { id: string; task_id: string; task_status: string };
type TaskRow = { id: string; workflow_id: string; project_id: string; project_path: string;
  status: string; goal: string; plan_json: string; process_hash: string; stage_id: string };

function obj(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key}: 应为映射`);
  return value as Record<string, unknown>;
}
/**
 * The tail of a supervised unit's own output, for a failure report a person can act on.
 *
 * A preparation that exits non-zero otherwise records only that it exited non-zero, while the message that
 * says why sits in the unit directory with nothing linking to it. Bounded, because a failing tool may have
 * produced a lot and the journal is read whole.
 */
export function toolDiagnostic(unitDir: string, limit = 4000): Record<string, unknown> {
  const tail = (name: string) => {
    try {
      const text = readFileSync(join(unitDir, name), 'utf8');
      return text.length <= limit ? text : `…${text.slice(-limit)}`;
    } catch { return ''; }
  };
  const stderr = tail('stderr.log'), stdout = tail('stdout.log');
  return { ...(stderr ? { stderr } : {}), ...(stdout ? { stdout } : {}) };
}
function str(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key}: 应为非空字符串`);
  return value;
}
function list(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x.trim())) throw new Error(`${key}: 应为字符串列表`);
  return value as string[];
}
export function allowedTaskPath(local: string, allowed: string[], project: string,
  host: HostPlatform = hostPlatform): boolean {
  const base = resolve(project);
  return allowed.some(root => root === '.' || host.within(resolve(base, root), resolve(base, local)) ||
    host.within(resolve(base, `${root}.meta`), resolve(base, local)));
}
function pathWithin(project: string, name: string): string {
  if (isAbsolute(name) || !name || name === '.' || name.split('/').includes('..')) throw new Error(`路径必须是项目内相对路径: ${name}`);
  const target = resolve(project, name);
  const rel = relative(project, target);
  if (!rel || !hostPlatform.within(project, target)) throw new Error(`路径越出项目: ${name}`);
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = realpathSync(ancestor);
  const actualRel = relative(project, actual);
  if (!hostPlatform.within(project, actual)) throw new Error(`路径经符号链接越出项目: ${name}`);
  return target;
}
function taskPath(project: string, runDirectory: string, name: string): string {
  if (!name.startsWith('run:')) return pathWithin(project, name);
  const local = name.slice(4);
  if (isAbsolute(local) || !local || local === '.' || local.split('/').includes('..'))
    throw new Error(`路径必须是 Run 目录内相对路径: ${name}`);
  return existsSync(runDirectory) ? pathWithin(runDirectory, local) : resolve(runDirectory, local);
}
function latestRunDirectory(db: DatabaseSync, home: string, taskId: string): string {
  const row = db.prepare('SELECT id FROM run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1')
    .get(taskId) as { id: string } | undefined;
  return join(home, 'runs', row?.id ?? '__no_run__');
}
function databaseHome(db: DatabaseSync): string {
  const row = db.prepare('PRAGMA database_list').get() as { file: string };
  return dirname(dirname(row.file));
}
/** Parse and validate a temporary Task's YAML specification against its project (as `task add` does). */
export function parseSpec(file: string, project: string): TaskSpec {
  const doc = parseDocument(readFileSync(file, 'utf8'), { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`任务 YAML: ${doc.errors.map(x => x.message).join('; ')}`);
  const raw = obj(doc.toJS(), '任务 YAML');
  if (raw.schema !== 'task/0.1') throw new Error('任务 YAML schema 应为 task/0.1');
  if (raw.runtimeWrites !== undefined) throw new Error('runtimeWrites: 只能来自冻结的正式流程，任务不能自行授予运行时输出写权');
  const role = raw.role === undefined ? 'executor' : str(raw.role, 'role');
  if (!['executor', 'diagnostician', 'reviewer', 'research'].includes(role)) throw new Error('role: 无效');
  const allowedWrites = list(raw.allowedWrites, 'allowedWrites');
  const expectedOutputs = list(raw.expectedOutputs, 'expectedOutputs');
  if (!expectedOutputs.length) throw new Error('expectedOutputs 不得为空');
  for (const path of allowedWrites) if (path !== '.') pathWithin(project, path);
  for (const path of expectedOutputs) taskPath(project, join(project, '__run_validation__'), path);
  for (const output of expectedOutputs) if (!output.startsWith('run:') &&
    !allowedTaskPath(output, allowedWrites, project))
    throw new Error(`expectedOutputs 不在 allowedWrites 中: ${output}`);
  const checks = (raw.checks === undefined ? [] : raw.checks);
  if (!Array.isArray(checks) || !checks.length) throw new Error('checks: 至少需要一项独立检查');
  const parsedChecks = checks.map((item, i): Check => {
    const check = obj(item, `checks[${i}]`);
    const id = str(check.id ?? `check-${i + 1}`, `checks[${i}].id`);
    const kinds = (['command', 'path', 'json', 'internal'] as const).filter(kind => check[kind] !== undefined);
    if (kinds.length !== 1) throw new Error(`checks[${i}]: command、path、json、internal 必须且只能有一项`);
    const kind = kinds[0]!;
    const unknown = Object.keys(check).filter(key => !['id', 'scope', 'on', ...CHECK_KEYS[kind]].includes(key));
    if (unknown.length) throw new Error(`checks[${i}]: 未知字段 ${unknown.join(', ')}`);
    if (check.scope !== undefined && !SCOPES.includes(check.scope as Scope))
      throw new Error(`checks[${i}].scope: 应为 ${SCOPES.join('、')}`);
    const on = check.on === undefined ? undefined : str(check.on, `checks[${i}].on`);
    if (on !== undefined && !expectedOutputs.includes(on)) throw new Error(`checks[${i}].on: 必须是 expectedOutputs 中的路径`);
    const common = { id, ...(check.scope === undefined ? {} : { scope: check.scope as Scope }), ...(on === undefined ? {} : { on }) };
    if (kind === 'internal') {
      if (check.internal !== 'takeover-output') throw new Error(`checks[${i}].internal: 无效`);
      if (![ANALYSIS_FILE, BRIEF_FILE, TAKEOVER_FACTS_FILE].every(path => expectedOutputs.includes(path)))
        throw new Error(`checks[${i}].internal: takeover-output 需要全部三份恢复输出`);
      if (on !== TAKEOVER_FACTS_FILE) throw new Error(`checks[${i}].on: takeover-output 必须绑定 facts.json`);
      return { ...common, internal: 'takeover-output' };
    }
    if (kind === 'command') {
      const command = list(check.command, `checks[${i}].command`);
      if (!command.length) throw new Error(`checks[${i}].command: 不得为空`);
      const exitCode = check.exitCode ?? 0;
      if (!Number.isSafeInteger(exitCode)) throw new Error(`checks[${i}].exitCode: 应为整数`);
      if (check.timeoutSec !== undefined && (!Number.isSafeInteger(check.timeoutSec) ||
        (check.timeoutSec as number) < 1 || (check.timeoutSec as number) > 3600))
        throw new Error(`checks[${i}].timeoutSec: 应为 1 至 3600 的整数`);
      return { ...common, command, exitCode: exitCode as number,
        ...(check.timeoutSec === undefined ? {} : { timeoutSec: check.timeoutSec as number }) };
    }
    if (kind === 'json') {
      const json = str(check.json, `checks[${i}].json`);
      taskPath(project, join(project, '__run_validation__'), json);
      const field = str(check.field, `checks[${i}].field`);
      if (field.split('.').some(part => !part)) throw new Error(`checks[${i}].field: 字段路径不得有空段`);
      if (!Object.hasOwn(check, 'expect')) throw new Error(`checks[${i}]: json 检查需要 expect`);
      return { ...common, json, field, expect: check.expect };
    }
    const path = str(check.path, `checks[${i}].path`);
    taskPath(project, join(project, '__run_validation__'), path);
    if (check.contains === undefined && check.equals === undefined) throw new Error(`checks[${i}]: 需要 contains 或 equals`);
    return { ...common, path, ...(check.contains === undefined ? {} : { contains: str(check.contains, `checks[${i}].contains`) }),
      ...(check.equals === undefined ? {} : { equals: str(check.equals, `checks[${i}].equals`) }) };
  });
  if (new Set(parsedChecks.map(x => x.id)).size !== parsedChecks.length) throw new Error('checks.id: 重复');
  const maxRetries = raw.maxRetries ?? 0;
  if (!Number.isSafeInteger(maxRetries) || (maxRetries as number) < 0) throw new Error('maxRetries: 应为非负整数');
  const resources = list(raw.resources ?? [], 'resources');
  let unitySteps: UnityStep[] | undefined;
  if (raw.unitySteps !== undefined) {
    if (!Array.isArray(raw.unitySteps) || !raw.unitySteps.length) throw new Error('unitySteps: 应为非空列表');
    if (!resources.includes('unity_batch')) throw new Error('unitySteps 需要 resources: [unity_batch]');
    unitySteps = raw.unitySteps.map((entry, i) => {
      const item = obj(entry, `unitySteps[${i}]`);
      if (item.quit !== undefined && typeof item.quit !== 'boolean') throw new Error(`unitySteps[${i}].quit: 应为布尔值`);
      if (item.timeoutSec !== undefined && (!Number.isSafeInteger(item.timeoutSec) || (item.timeoutSec as number) < 1))
        throw new Error(`unitySteps[${i}].timeoutSec: 应为正整数`);
      const env = item.env === undefined ? {} : obj(item.env, `unitySteps[${i}].env`);
      for (const [name, value] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' ||
          ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
            'XDG_CONFIG_DIRS', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
            'XAUTHORITY', 'TMPDIR',
            'AVH_RUN_DIR', 'AVH_PROJECT_DIR'].includes(name))
          throw new Error(`unitySteps[${i}].env.${name}: 无效或保留变量`);
      }
      return { method: str(item.method, `unitySteps[${i}].method`), quit: item.quit !== false,
        ...(item.timeoutSec === undefined ? {} : { timeoutSec: item.timeoutSec as number }), env: env as Record<string, string> };
    });
  }
  const requiredCapabilities = list(raw.requiredCapabilities ?? [], 'requiredCapabilities');
  if (raw.toolProfile !== undefined && raw.toolProfile !== 'coordination') throw new Error('toolProfile 无效');
  const inputImages = raw.inputImages === undefined ? undefined : (() => {
    if (!Array.isArray(raw.inputImages)) throw new Error('inputImages 应为图片列表');
    const images = raw.inputImages.map((entry, i) => {
      const image = obj(entry, `inputImages[${i}]`);
      const path = str(image.path, 'inputImages.path'); pathWithin(project, path);
      return { path, sha256: str(image.sha256, 'inputImages.sha256') };
    });
    verifiedImageInputs(project, images); return images;
  })();
  const gateRaw = raw.gate === undefined ? undefined : obj(raw.gate, 'gate');
  const gate = gateRaw ? { id: str(gateRaw.id ?? 'approval', 'gate.id'), question: str(gateRaw.question, 'gate.question'),
    bind: str(gateRaw.bind ?? expectedOutputs[0], 'gate.bind') } : undefined;
  if (gate && !expectedOutputs.includes(gate.bind)) throw new Error('gate.bind: 必须是 expectedOutputs 中的路径');
  return { schema: 'task/0.1', goal: str(raw.goal, 'goal'), role: role as TaskSpec['role'],
    ...(raw.provider === undefined ? {} : { provider: str(raw.provider, 'provider') }), allowedWrites, expectedOutputs,
    requiredCapabilities, ...(inputImages ? { inputImages } : {}), ...(raw.toolProfile ? { toolProfile: 'coordination' as const } : {}),
    checks: parsedChecks, maxRetries: maxRetries as number, resources,
    ...(unitySteps ? { unitySteps } : {}), ...(gate ? { gate } : {}) };
}
function definition(spec: TaskSpec): ProcessDefinition {
  return { schema: 'process/0.1', id: 'avh-task/0.1', version: '0.1', applies_to: {},
    artifacts: spec.expectedOutputs,
    stages: [{ id: 'work', needs: [], produces: spec.expectedOutputs, requires: spec.checks.map(x => x.id),
      gates: spec.gate ? [spec.gate.id] : [], invalidated_by: spec.expectedOutputs }],
    checks: spec.checks.map(check => ({ id: check.id, observe: 'independent task check', on: checkTarget(spec, check),
      scope: check.scope ?? 'edit', rule: checkRule(check), severity: 'blocking', maturity: 'accepted' })),
    gates: spec.gate ? [{ id: spec.gate.id, kind: 'approve', binds: spec.gate.bind }] : [], milestones: [] };
}
/** A check proves something about one expected output; older specs bind every check to the first. */
function checkTarget(spec: TaskSpec, check: Check): string { return check.on ?? spec.expectedOutputs[0]!; }
function checkRule(check: Check): string {
  if (check.internal) return `internal:${check.internal}`;
  return check.command ? check.command.join(' ') : check.json ? `${check.json}#${check.field} == ${JSON.stringify(check.expect)}`
    : `${check.path} readback`;
}
/** Walk a dot path from the document root; array steps take integer indexes. */
export function jsonField(document: unknown, field: string): { found: true; value: unknown } | { found: false } {
  let value = document;
  for (const step of field.split('.')) {
    if (Array.isArray(value) && /^\d+$/.test(step) && Number(step) < value.length) value = value[Number(step)];
    else if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, step))
      value = (value as Record<string, unknown>)[step];
    else return { found: false };
  }
  return { found: true, value };
}
function sha(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function hashPath(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return sha(`symlink:${readlinkSync(path)}`);
  if (stat.isFile()) return sha256File(path);
  if (stat.isDirectory()) return sha(readdirSync(path).sort().map(name => `${name}:${hashPath(join(path, name)) ?? ''}`).join('\n'));
  return undefined;
}
function gitRepo(project: string): string {
  try {
    const repo = execFileSync(hostPlatform.toolCommand('git'), [...HOST_GIT_SAFETY, 'rev-parse', '--show-toplevel'],
      { cwd: project, encoding: 'utf8' }).trim();
    if (hostPlatform.within(repo, project)) return repo;
    // Git resolves junctions and MSIX app-data redirection to physical paths. Keep the project's original spelling
    // only when its ancestor is independently the exact same repository; the lexical write boundary stays strict.
    const physicalRepo = realpathSync.native(repo), physicalProject = realpathSync.native(project);
    if (!hostPlatform.within(physicalRepo, physicalProject)) return repo;
    const suffix = relative(physicalRepo, physicalProject);
    let ancestor = resolve(project);
    for (const _part of suffix.split(sep).filter(Boolean)) ancestor = dirname(ancestor);
    const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
    return key(realpathSync.native(ancestor)) === key(physicalRepo) ? ancestor : repo;
  }
  catch { throw new Error('任务项目必须位于 Git 仓库'); }
}
function gitHead(repo: string): string {
  try { return execFileSync(hostPlatform.toolCommand('git'), [...HOST_GIT_SAFETY, 'rev-parse', '--verify', 'HEAD'],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return execFileSync(hostPlatform.toolCommand('git'), [...HOST_GIT_SAFETY, 'hash-object', '-t', 'tree', '--stdin'],
    { cwd: repo, encoding: 'utf8', input: '' }).trim(); }
}
export interface TaskScopeSnapshot { repo: string; head: string; status: Record<string, string> }
export function taskScopeSnapshot(project: string, limits: ScanLimits = {}): TaskScopeSnapshot {
  const repo = gitRepo(project);
  return { repo, head: gitHead(repo), status: gitStatusSnapshot(repo, project, limits) };
}
export function taskScopeChanges(project: string, allowed: string[], before: TaskScopeSnapshot,
  limits: ScanLimits = {}, after = gitStatusSnapshot(before.repo, project, limits)): string[] {
  const changed = new Set([...Object.keys(before.status), ...Object.keys(after)]
    .filter(path => before.status[path] !== after[path]));
  const head = gitHead(before.repo);
  if (head !== before.head) for (const path of committedPaths(before.repo, before.head, head, project, limits)) changed.add(path);
  const projectRel = relative(before.repo, project).replaceAll('\\', '/');
  return [...changed].filter(path => {
    const local = projectRel ? hostPlatform.within(project, join(before.repo, path)) ?
      hostPlatform.relativePosix(project, join(before.repo, path)) : '' : path;
    if (!local) return false; // WP4's repository scan handles paths outside the project.
    return !allowedTaskPath(local, allowed, project);
  }).sort();
}
/** A Task id as typed: the full id, or a prefix that names exactly one Task (the short ids the CLI and TUI print). */
function resolveTaskId(db: DatabaseSync, id: string): string {
  if (db.prepare('SELECT 1 FROM task WHERE id = ?').get(id)) return id;
  if (!/^[0-9a-f-]{6,}$/.test(id)) return id;
  const matches = db.prepare("SELECT id FROM task WHERE id LIKE ? || '%' LIMIT 2").all(id) as { id: string }[];
  if (matches.length > 1) throw new Error(`Task 前缀 ${id} 不唯一，请给更长的 id`);
  return matches[0]?.id ?? id;
}
function taskRow(db: DatabaseSync, id: string): TaskRow {
  const row = db.prepare(`SELECT t.id, t.workflow_id, w.project_id, p.path AS project_path, t.status,
    t.goal, w.plan_json, w.process_hash, t.stage_id FROM task t JOIN workflow w ON w.id = t.workflow_id
    JOIN project p ON p.id = w.project_id WHERE t.id = ?`).get(resolveTaskId(db, id)) as TaskRow | undefined;
  if (row && row.process_hash !== 'avh-task/0.1')
    throw new Error(`Task ${row.id} 是正式 Workflow ${row.workflow_id} 的阶段 ${row.stage_id}：用 avh workflow show ${row.workflow_id} 或 TUI 的任务详情查看`);
  if (!row) throw new Error(`找不到 Task: ${id}`);
  return { ...row, project_path: projectRoot(db, row.project_id) };
}
function specOf(row: TaskRow): TaskSpec { return (JSON.parse(row.plan_json) as { task: TaskSpec }).task; }
/** Any Task, temporary or of a formal Workflow. */
function anyTaskRow(db: DatabaseSync, id: string): TaskRow & { formal: boolean } {
  const row = db.prepare(`SELECT t.id, t.workflow_id, w.project_id, p.path AS project_path, t.status,
    t.goal, w.plan_json, w.process_hash, t.stage_id FROM task t JOIN workflow w ON w.id = t.workflow_id
    JOIN project p ON p.id = w.project_id WHERE t.id = ?`).get(resolveTaskId(db, id)) as TaskRow | undefined;
  if (!row) throw new Error(`找不到 Task: ${id}`);
  const formal = row.process_hash !== 'avh-task/0.1';
  if (formal && !isFormalWorkflow(db, row.workflow_id)) throw new Error(`找不到 Task: ${id}`);
  return { ...row, project_path: projectRoot(db, row.project_id), formal };
}
function definitionOf(db: DatabaseSync, row: TaskRow & { formal: boolean }): ProcessDefinition {
  return row.formal ? workflowSnapshot(db, row.workflow_id).definition : definition(specOf(row));
}
function registry(config: LocalConfig): ProviderRegistry {
  return new ProviderRegistry({ policyVersion: config.providerPolicyVersion, probeTtlMs: config.providerProbeTtlMs,
    routing: config.routing, home: config.home, providers: config.providers });
}
function projectPath(config: LocalConfig, name: string): string {
  const path = realpathSync(resolve(config.workspaceRoot, name));
  const rel = relative(config.workspaceRoot, path);
  if (!rel || !hostPlatform.within(config.workspaceRoot, path) || !statSync(path).isDirectory()) throw new Error('项目必须位于 workspaceRoot 内');
  rejectCloudSyncedPath(path);
  return path;
}
function ensureProject(db: DatabaseSync, config: LocalConfig, path: string): string {
  return inTransaction(db, () => {
    const workspace = realpathSync(config.workspaceRoot);
    let ws = physicalWorkspace(db, workspace);
    if (!ws) {
      const id = randomUUID(); withStateEvent(db, { actor: 'human', entityType: 'workspace', entityId: id, action: 'registered', reason: 'task add' },
        () => db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run(id, workspace));
      ws = { id, path: workspace };
    }
    const found = physicalProject(db, ws.id, ws.path, path);
    if (found) return found.id;
    const id = randomUUID(); withStateEvent(db, { actor: 'human', entityType: 'project', entityId: id, action: 'registered', reason: 'task add' },
      () => db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
        VALUES (?, ?, 'sample', ?, '{}', 'active', ?, ?)`).run(id, ws!.id, path, harnessVersion(), knowledgeVersion(config)));
    return id;
  });
}
export function taskAdd(config: LocalConfig, db: DatabaseSync, projectName: string, file: string, actor: 'human' | 'runtime' = 'human'): string {
  const path = projectPath(config, projectName);
  gitRepo(path);
  const spec = parseSpec(file, path);
  if (spec.unitySteps?.length && !config.unity) throw new Error('unitySteps 需要配置 unity');
  if (!config.providers.length) throw new Error('providers: 未配置');
  const id = randomUUID(); const workflowId = randomUUID();
  const snapshot = { ...registry(config).snapshot(workflowId), routing: config.routing };
  const decision = routeProviders(snapshot, spec.role, config.routing, { requested: spec.provider,
    capabilities: spec.requiredCapabilities });
  if (!decision.selected) throw new Error(`没有可用 Provider；${decision.reason}`);
  const projectId = ensureProject(db, config, path);
  withStateEvent(db, { workflowId, actor, entityType: 'task', entityId: id,
    action: 'created', reason: `task add: ${spec.goal}` }, () => {
    db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
      VALUES (?, ?, 'avh-task/0.1', 'avh-task/0.1', ?, 'active', ?)`)
      .run(workflowId, projectId, knowledgeVersion(config), JSON.stringify({ task: spec }));
    db.prepare(`INSERT INTO task (id, workflow_id, stage_id, goal, capability, expected_outputs_json, retry_policy_json, status)
      VALUES (?, ?, 'work', ?, ?, ?, ?, 'PENDING')`).run(id, workflowId, spec.goal, spec.role,
        JSON.stringify(spec.expectedOutputs), JSON.stringify({ maxRetries: spec.maxRetries,
          ...(spec.checks.some(check => check.internal === 'takeover-output') ? { maxCheckRetries: spec.maxRetries } : {}) }));
  });
  withStateEvent(db, { workflowId, actor: 'runtime', entityType: 'provider_snapshot', entityId: workflowId,
    action: 'frozen', reason: 'task initialization', payload: { policyVersion: snapshot.policyVersion } },
  () => db.prepare('INSERT INTO provider_snapshot (workflow_id, snapshot_json) VALUES (?, ?)').run(workflowId, JSON.stringify(snapshot)));
  transitionTask(db, id, 'READY', 'ready', 'task specification and Provider snapshot frozen');
  return id;
}

export function providerList(config: LocalConfig, probe: boolean): string {
  const reg = registry(config);
  const rows = config.providers.map(provider => {
    const status = probe ? reg.probe(provider) : undefined;
    return `${provider.id}\t${provider.adapter}\t${status ? status.evidence.version : 'declared'}\t${status?.version ?? 'unknown'}\t${status?.auth ?? 'unknown'}\t${status?.quota.usedPercent ?? 'unknown'}\t${status?.health ?? 'unknown'}\t${provider.sandbox ?? (provider.adapter === 'codex-cli' || provider.adapter === 'legacy-dsh-task' ? 'self' : 'outer')}`;
  });
  return ['id\ttype\tstate\tversion\tlogin\tquota_used_percent\thealth\tsandbox', ...rows].join('\n');
}

class TaskFingerprinter implements Fingerprinter {
  readonly project: string; readonly db: DatabaseSync; readonly home: string; readonly taskId: string;
  constructor(project: string, db: DatabaseSync, home: string, taskId: string) {
    this.project = project; this.db = db; this.home = home; this.taskId = taskId;
  }
  fingerprint(_workflowId: string, kinds: string[]): Record<string, string> {
    return Object.fromEntries(kinds.flatMap(kind => {
      const hash = hashPath(taskPath(this.project, latestRunDirectory(this.db, this.home, this.taskId), kind));
      return hash ? [[kind, hash]] : [];
    }));
  }
}
class TaskVerifier implements Verifier {
  readonly project: string; readonly spec: TaskSpec; readonly home: string;
  constructor(project: string, spec: TaskSpec, home: string) { this.project = project; this.spec = spec; this.home = home; }
  async verify(run: RunSpec, result: RunResult, hashes: Record<string, string>): Promise<Verdict[]> {
    const runDirectory = join(this.home, 'runs', run.runId);
    this.materializeReply(runDirectory, result);
    // Every check for an output binds to that output's actual bytes, not to the pre-Run baseline. The
    // aggregate treats a falsy hash as stale, so a Task producing a new artifact must record the hash of
    // what it produced; otherwise its own passing checks invalidate themselves.
    for (const on of this.spec.expectedOutputs) {
      const produced = hashPath(taskPath(this.project, runDirectory, on));
      if (produced) hashes[on] = produced;
    }
    const verdicts: Verdict[] = [];
    // Sequential on purpose: checks read the same outputs and their evidence order is stable.
    for (const check of this.spec.checks) {
      const { result, basis } = await this.evaluate(check, runDirectory);
      verdicts.push({ id: '', checkId: check.id, scope: check.scope ?? 'edit',
        artifactHash: hashes[checkTarget(this.spec, check)] ?? '', result, basis });
    }
    return verdicts;
  }
  /**
   * Save a structured reply into the Run output the checks read, when the executor did not write it.
   * A Run-directory write is not dependable — under the Windows sandbox the codex executor reported it
   * as denied and answered in its final message instead — while the adapter always captures that
   * message. Without this the checks see no artifact, the Task blocks, and a correct answer is lost.
   * Narrow by construction: only a single run-relative .json output, only when the file is absent,
   * only an object reply, and only a coordination task. The checks then re-validate it independently,
   * so this records the reply rather than vouching for it.
   */
  private materializeReply(runDirectory: string, result: RunResult): void {
    if (this.spec.toolProfile !== 'coordination' || this.spec.expectedOutputs.length !== 1) return;
    const only = this.spec.expectedOutputs[0]!;
    if (!only.startsWith('run:') || !only.endsWith('.json')) return;
    const file = join(runDirectory, only.slice(4));
    if (existsSync(file)) return;
    const reply = (result as RunResult & { structuredResult?: unknown }).structuredResult;
    if (reply === undefined || reply === null) return;
    let parsed: unknown;
    try { parsed = typeof reply === 'string' ? JSON.parse(reply) : reply; } catch { return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    try {
      mkdirSync(runDirectory, { recursive: true });
      writeFileSync(file, JSON.stringify(parsed), { flag: 'wx', mode: 0o600 });
    } catch { /* A racing writer or an unwritable Run directory leaves the checks to report no_data. */ }
  }
  private async evaluate(check: Check, runDirectory: string): Promise<{ result: Verdict['result']; basis: string }> {
    if (check.internal === 'takeover-output') {
      try {
        const output = validateTakeoverOutputs(this.project);
        return output.ok ? { result: 'pass', basis: '完整接手分析输出通过独立结构与工程路径核对；候选仍待确认' }
          : { result: 'violation', basis: output.problems.join('；') };
      } catch (error) { return { result: 'error', basis: `接手输出核对无法完成：${String(error).slice(0, 300)}` }; }
    }
    if (check.command) {
      const run = await runCheckCommand(check.command, { project: this.project, runDirectory, checkId: check.id,
        timeoutMs: (check.timeoutSec ?? 30) * 1000, harnessHome: this.home,
        extraEnv: { AVH_RUN_DIR: runDirectory, AVH_PROJECT_DIR: this.project } });
      const isolation = run.isolation === 'none' ? `isolation=none（${run.isolationNote}）` : `isolation=${run.isolation}`;
      const passed = !run.timedOut && run.status === check.exitCode;
      return { result: passed ? 'pass' : 'violation',
        basis: `exit=${run.timedOut ? 'timeout' : run.status ?? run.signal ?? 'unknown'} expected=${check.exitCode}; ${isolation}; ${(run.stderr || run.stdout || '').slice(0, 300)}` };
    }
    const target = taskPath(this.project, runDirectory, (check.json ?? check.path)!);
    const content = existsSync(target) && statSync(target).isFile() ? readFileSync(target, 'utf8') : undefined;
    if (check.json) {
      if (content === undefined) return { result: 'no_data', basis: `${check.json}: missing` };
      let document: unknown;
      try { document = JSON.parse(content); }
      catch (error) { return { result: 'error', basis: `${check.json}: invalid JSON: ${String(error).slice(0, 200)}` }; }
      const found = jsonField(document, check.field!);
      if (!found.found) return { result: 'no_data', basis: `${check.json}#${check.field}: field missing` };
      const passed = isDeepStrictEqual(found.value, check.expect);
      return { result: passed ? 'pass' : 'violation', basis: `${check.json}#${check.field}: expected ${
        JSON.stringify(check.expect)}, got ${String(JSON.stringify(found.value)).slice(0, 200)}` };
    }
    const passed = content !== undefined && (check.contains === undefined || content.includes(check.contains)) &&
      (check.equals === undefined || content === check.equals);
    return { result: passed ? 'pass' : 'violation',
      basis: `${check.path}: ${content === undefined ? 'missing' : `read ${content.length} bytes`}` };
  }
  cancel(run: RunSpec): Promise<'confirmed' | 'not_confirmed'> { return cancelChecks(join(this.home, 'runs', run.runId)); }
}

/** CLI routing stays outside WP5: selection is recorded before ManagedProvider starts. */
export class TaskRouter implements Executor {
  private readonly adapters = new Map<string, ManagedProvider>();
  private tools?: ToolRunner;
  private handoff?: HandoffLock;
  readonly db: DatabaseSync; readonly config: LocalConfig; readonly row: TaskRow; readonly reg: ProviderRegistry;
  readonly spec: TaskSpec;
  constructor(db: DatabaseSync, config: LocalConfig, row: TaskRow, reg: ProviderRegistry = registry(config),
    spec: TaskSpec = specOf(row)) {
    this.db = db; this.config = config; this.row = { ...row, project_path: projectRoot(db, row.project_id) }; this.reg = reg; this.spec = spec;
  }
  private toolRunner(): ToolRunner {
    this.tools ??= new ToolRunner({ projectDirectory: this.row.project_path, workspaceRepository: gitRepo(this.row.project_path),
      runRoot: join(this.config.home, 'runs'), handoffLockPath: join(this.config.home, 'state/unity-handoff.lock'),
      harnessHome: this.config.home, scanLimits: this.config.scanLimits }, this.spec.tool?.network === true);
    return this.tools;
  }
  private adapter(id: string): ManagedProvider | ToolRunner {
    if (id === 'tool') return this.toolRunner();
    let adapter = this.adapters.get(id);
    if (adapter) return adapter;
    const snapshot = this.snapshot(); const provider = snapshot.providers.find(x => x.config.id === id)?.config;
    if (!provider) throw new Error(`Provider ${id} 不在冻结快照`);
    const project = this.row.project_path;
    const repo = gitRepo(project);
    adapter = new ManagedProvider(provider, { projectDirectory: project, workspaceRepository: repo,
      runRoot: join(this.config.home, 'runs'), handoffLockPath: join(this.config.home, 'state/unity-handoff.lock'),
      harnessHome: this.config.home, scanLimits: this.config.scanLimits });
    this.adapters.set(id, adapter); return adapter;
  }
  private snapshot(): ProviderSnapshot {
    const saved = this.db.prepare('SELECT snapshot_json FROM provider_snapshot WHERE workflow_id = ?')
      .get(this.row.workflow_id) as { snapshot_json: string };
    return JSON.parse(saved.snapshot_json) as ProviderSnapshot;
  }
  private route(): { decision: RouteDecision; occupants: Map<string, Occupant[]> } {
    const spec = this.spec; const snapshot = liveProviderSnapshot(this.snapshot(), this.config.providerProbeTtlMs, this.config.home);
    const occupants = new Map<string, Occupant[]>();
    const decision = routeProviders(snapshot, spec.role, snapshot.routing ?? this.config.routing, { requested: spec.provider,
      capabilities: spec.requiredCapabilities,
      busy: config => {
        const runs = (this.db.prepare(`SELECT r.id, r.task_id, t.status AS task_status FROM run r
          JOIN task t ON t.id = r.task_id WHERE r.provider = ? AND r.status IN ('pending', 'running') ORDER BY r.rowid`)
          .all(config.id) as Occupant[]).filter(run =>
            !existsSync(join(this.config.home, 'runs', run.id, 'unity-steps.json')) ||
            !this.db.prepare("SELECT 1 FROM event WHERE entity_type = 'run' AND entity_id = ? AND action = 'unity_unit_intended' LIMIT 1")
              .get(run.id));
        occupants.set(config.id, runs);
        return runs.length;
      } });
    return { decision, occupants };
  }
  private selection(): { id: string; reason: string } | undefined {
    if (this.spec.tool) return { id: 'tool', reason: 'deterministic stage tool; no Provider' };
    const { decision } = this.route();
    return decision.selected ? { id: decision.selected.id, reason: decision.reason } : undefined;
  }
  /** Why no Provider can take this Task now, naming the Runs that hold full Provider slots. */
  private waitReason(): string | undefined {
    if (this.spec.tool) return undefined;
    const { decision, occupants } = this.route();
    if (decision.selected) return undefined;
    const held = decision.excluded.flatMap(entry => {
      const id = entry.slice(0, entry.indexOf(': '));
      const runs = /concurrency \d+\/\d+/.test(entry) ? occupants.get(id) ?? [] : [];
      return runs.length ? [`${id} 的槽被占用: ${runs.map(run =>
        `Run ${run.id}（任务 ${run.task_id}，${run.task_status}）`).join('，')}`] : [];
    });
    return `没有可用 Provider：${decision.excluded.join('; ') || '无候选'}${held.length ? `；${held.join('；')}` : ''}`;
  }
  canDispatch(resource: string): boolean {
    const reason = resource.startsWith('slot:unity_batch') && !this.unityHandoffFree()
      ? 'Unity 批处理槽被占用' : this.waitReason();
    if (!reason) return true;
    recordEventOnce(this.db, { workflowId: this.row.workflow_id, actor: 'runtime', entityType: 'task',
      entityId: this.row.id, action: 'route_waiting', reason });
    return false;
  }
  /**
   * The cross-process handoff lock, shared with the legacy script that writes the same file. A locker whose process
   * has exited is reclaimed here, because dispatch is what a crash must not block for good; the reclaim names the
   * holder it displaced so the record says whose lock was taken.
   */
  private handoffLock(): HandoffLock {
    return this.handoff ??= new HandoffLock(join(this.config.home, 'state/unity-handoff.lock'), reclaim =>
      recordEventOnce(this.db, { workflowId: this.row.workflow_id, actor: 'runtime', entityType: 'task',
        entityId: this.row.id, action: 'unity_handoff_reclaimed',
        reason: `回收崩溃残留的 Unity 交接锁：原持有者 ${reclaim.holder}，${
          reclaim.pid === undefined ? '未记录 pid' : `pid ${reclaim.pid}`}，${
          reclaim.reason === 'holder-exited' ? '该进程已不存在' : `旧格式锁已放置 ${Math.round(reclaim.ageMs / 3_600_000)} 小时`}` }));
  }
  /** Takes a crashed holder's lock out of the way, then says whether the handoff is actually taken. */
  private unityHandoffFree(): boolean {
    return this.handoffLock().freeForDispatch();
  }
  recordedExitStatus(runId: string): number | undefined {
    return createRunSupervisor(join(this.config.home, 'runs')).recordedExit(runId)?.code;
  }
  async start(run: RunSpec): Promise<RunHandle> {
    let providerAttempted = false;
    try {
      assertCoordinatorDispatchAuthorization(this.db,this.config,this.row.id,this.spec);
      const selected = this.selection();
      if (!selected) throw new Error('没有符合能力、权限、额度和并发约束的 Provider');
      const spec = this.spec;
      const directory = join(this.config.home, 'runs', run.runId);
      hostPlatform.mkdirPrivate(directory);
      const selectedConfig = this.snapshot().providers.find(provider => provider.config.id === selected.id)?.config;
      const modelFamily = selectedConfig?.family ?? (selectedConfig?.adapter === 'claude-cli' ? 'claude' :
        selectedConfig?.adapter === 'codex-cli' ? 'codex' : selectedConfig?.model ?? selectedConfig?.id);
      const compiledContext = spec.contextPlan ? compileContext(spec.contextPlan.items, spec.contextPlan.facts,
        { budgetChars: spec.contextPlan.budgetChars, requiredCoverage: spec.contextPlan.requiredCoverage, modelFamily }) : undefined;
      const effectiveGoal = spec.contextPlan
        ? [spec.contextPlan.prefix, spec.contextPlan.items.length ? contextPlanText(compiledContext!) : '', spec.contextPlan.suffix]
          .filter(Boolean).join('\n')
        : spec.goal;
      if (compiledContext) hostPlatform.writePrivate(join(directory, 'context-plan.json'), JSON.stringify({
        schema: 'context-plan/0.1', modelFamily: modelFamily ?? null, usedChars: compiledContext.usedChars,
        budgetChars: compiledContext.budgetChars, coverage: compiledContext.coverage, decisions: compiledContext.decisions,
      }, null, 2), { flag: 'wx' });
      // The assembly report is written here rather than where the plan was frozen, because this is the
      // first moment the model family is known: the stage compiles once to freeze a plan and the router
      // then chooses a provider, so a report made earlier would describe an assembly that never ran
      // (决定记录 D-95, 缺陷 3). This file is the run's account of what it was given.
      if (compiledContext) hostPlatform.writePrivate(join(directory, 'context-assembly.json'), JSON.stringify(
        contextAssemblyReport(compiledContext, {
          ...(spec.contextAssembly?.identity ?? { stage: 'unknown', workflow: this.row.workflow_id, pack: 'unknown', frozenAt: '' }),
          modelFamily,
        }, spec.contextPlan!.requiredCoverage), null, 2), { flag: 'wx' });
      if (compiledContext) recordEventOnce(this.db, { workflowId: this.row.workflow_id, actor: 'runtime', entityType: 'run',
        entityId: run.runId, action: 'context_compiled', reason: `context compiled for ${modelFamily ?? 'unknown'}: ${compiledContext.usedChars}/${compiledContext.budgetChars}`,
        payload: { schema: 'context-telemetry/0.1', modelFamily: modelFamily ?? null, usedChars: compiledContext.usedChars,
          budgetChars: compiledContext.budgetChars, coverage: compiledContext.coverage,
          selected: compiledContext.decisions.filter(item => item.selected).map(item => ({ ...item,
            sha256: spec.contextPlan!.items.find(source => source.spec.id === item.id)?.sha256 ?? null })) } });
      // A directory entry (trailing /) is created first, so the OS-level boundary binds exactly that directory
      // instead of its nearest existing ancestor.
      for (const path of spec.allowedWrites) if (path.endsWith('/') && path !== '/')
        mkdirSync(pathWithin(this.row.project_path, path.slice(0, -1)), { recursive: true });
      const allowedWrites = spec.allowedWrites.map(path => path === '.'
        ? this.row.project_path : pathWithin(this.row.project_path, path.endsWith('/') ? path.slice(0, -1) : path));
      const prior = this.db.prepare('SELECT id, result_json FROM run WHERE task_id = ? AND attempt < ? ORDER BY attempt DESC LIMIT 1')
        .get(run.taskId, run.attempt) as { id: string; result_json: string | null } | undefined;
      const verdicts = prior ? this.db.prepare('SELECT check_id, result, basis FROM verdict WHERE id LIKE ? ORDER BY check_id')
        .all(`${prior.id}:%`) as { check_id: string; result: string; basis: string | null }[] : [];
      const priorEvent = prior ? this.db.prepare(`SELECT reason FROM event WHERE entity_type='task' AND entity_id=?
        AND (reason LIKE 'Run failed:%' OR action LIKE '%->BLOCKED') ORDER BY seq DESC LIMIT 1`)
        .get(run.taskId) as { reason: string } | undefined : undefined;
      const priorResult = prior?.result_json ? JSON.parse(prior.result_json) as RunResult : undefined;
      const unityFailure = priorResult?.unitySteps?.find(item => item.exitCode !== 0 || item.timedOut);
      const unityEvidence = unityFailure ? `Unity 步骤 ${unityFailure.index} (${unityFailure.method}) 失败，Provider 产物保留；log=${unityFailure.log}; exit=${unityFailure.exitCode}; timeout=${Boolean(unityFailure.timedOut)}; ${unityFailure.errors.join(' | ')}` : '';
      // Keep actionable independent findings ahead of potentially large persisted Runtime metadata.
      const evidence = promptEvidence(prior ? [priorEvent?.reason ?? `Run ${prior.id} failed`, unityEvidence,
        ...verdicts.map(item => `${item.check_id}: ${item.result}; ${item.basis ?? ''}`), prior.result_json ?? ''].join('\n') : '', directory);
      const failure = evidence.text;
      const prompt = [
        `Project: ${this.row.project_path}`, `Run directory: ${directory}`,
        allowedWrites.length ? `Allowed writes: ${allowedWrites.join(', ')}` : '只读：不得改动项目内任何文件',
        'Run 目录始终可写，它不在上面的限制内：上面的限制只针对项目文件。',
        `Expected outputs: ${spec.expectedOutputs.map(path => taskPath(this.row.project_path, directory, path)).join(', ')}`,
        ...(spec.expectedOutputs.length ? ['Expected outputs 必须由你实际写出到上述路径；只在回复里给出内容不算完成。'] : []),
        '不要 git commit、不要改允许范围外的文件、不要启动 Unity（需要 Unity 的步骤由 Runtime 执行）。',
        ...(this.config.providers.find(provider => provider.id === selected.id)?.adapter === 'legacy-dsh-task' && allowedWrites.length
          ? ['本 Provider 只能写项目目录；Run 目录对你只读，其中的产物由 Runtime 生成'] : []),
        `Goal:\n${effectiveGoal}`, ...(failure ? [`Previous Run failure and check evidence:\n${failure}`] : []),
      ].join('\n');
      const request: ProviderRequest = { ...run, allowedWrites, role: spec.role, prompt,
        ...(spec.toolProfile ? { toolProfile: spec.toolProfile } : {}),
        ...(spec.inputImages?.length ? { inputImages: verifiedImageInputs(this.row.project_path, spec.inputImages) } : {}) };
      const scopeFile = join(directory, 'scope-before.json');
      if (!existsSync(scopeFile)) hostPlatform.writePrivate(scopeFile, JSON.stringify(taskScopeSnapshot(this.row.project_path, this.config.scanLimits)),
        { flag: 'wx' });
      assertCoordinatorDispatchAuthorization(this.db,this.config,this.row.id,this.spec);
      providerAttempted = true;
      if (spec.tool && !existsSync(join(directory, 'task.txt')))
        hostPlatform.writePrivate(join(directory, 'task.txt'), `${prompt}\nTool: ${JSON.stringify(spec.tool.argv)}\n`, { flag: 'wx' });
      const handle = spec.tool
        ? await this.toolRunner().start({ ...run, allowedWrites, argv: spec.tool.argv, env: { ...spec.tool.env,
          AVH_RUN_DIR: directory, AVH_PROJECT_DIR: this.row.project_path } })
        : await (this.adapter(selected.id) as ManagedProvider).start(request);
      selectProviderWithManifest(this.db, this.config, run.workflowId, run.runId, selected.id, selected.reason,
        directory, this.row.project_path, evidence.truncated, Boolean(spec.unitySteps?.length));
      return { ref: `${selected.id}|${handle.ref}` };
    } catch (error) {
      if (providerAttempted) throw error;
      throw Object.assign(new Error((error as Error).message, { cause: error }),
        { errorClass: 'tool_failure' as const, noSideEffects: true });
    }
  }
  private fromHandle(handle: RunHandle): { adapter: ManagedProvider | ToolRunner; inner: RunHandle } {
    const at = handle.ref.indexOf('|'); if (at < 1) throw new Error('Provider handle 无效');
    return { adapter: this.adapter(handle.ref.slice(0, at)), inner: { ref: handle.ref.slice(at + 1) } };
  }
  private runIdOf(handle: RunHandle): string {
    const row = this.db.prepare('SELECT id FROM run WHERE task_id = ? AND process_ref = ? ORDER BY attempt DESC LIMIT 1')
      .get(this.row.id, handle.ref) as { id: string } | undefined;
    if (!row) throw new Error(`Unknown Run handle ${handle.ref}`);
    return row.id;
  }
  private unityUnit(runId: string): { executor: UnitExecutor; handle: RunHandle } {
    const spec = this.spec, config = this.config.unity!;
    const runDir = join(this.config.home, 'runs', runId);
    const runStat = lstatSync(runDir);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error('Unity Run directory must be real');
    const unitId = `unity-${runId}`;
    const timeoutSec = spec.unitySteps!.reduce((sum, step) => sum + (step.timeoutSec ?? config.defaultTimeoutSec), 0);
    const executor = createRunExecutor({
      projectDirectory: this.row.project_path, workspaceRepository: gitRepo(this.row.project_path),
      runRoot: runDir, writableByRunner: { unity: [] }, sandboxByRunner: { unity: 'inner-bwrap' },
      runtimeMaxSec: timeoutSec + 20,
      commandFor: (_unitSpec, directory) => {
        const input = join(directory, 'unity-input.json');
        hostPlatform.writePrivate(input, JSON.stringify({ config, steps: spec.unitySteps, project: this.row.project_path, runDir }),
          { flag: 'wx' });
        // UnitExecutor deliberately gives supervisors only a narrow inherited environment.
        // Pass the validated service setting to the worker explicitly, so its machine lock
        // uses the same count as this scheduler on Windows and Linux.
        return { runner: 'unity', env: { AVH_HOME: this.config.home, AVH_UNITY_SLOTS: String(this.config.unitySlots.count) }, argv: [process.execPath,
          runtimeModule(import.meta.url, './exec/unity-worker'), input],
          cwd: runDir, timeoutMs: (timeoutSec + 10) * 1000 };
      },
    });
    return { handle: executor.refFor(unitId), executor };
  }
  private prepareUnit(runId: string): { runner: ToolRunner; handle: RunHandle; unitId: string } {
    const runDir = join(this.config.home, 'runs', runId), unitId = `prepare-${runId}`;
    const runner = new ToolRunner({ projectDirectory: this.row.project_path, workspaceRepository: gitRepo(this.row.project_path),
      runRoot: runDir, handoffLockPath: join(this.config.home, 'state/unity-handoff.lock'), harnessHome: this.config.home,
      scanLimits: this.config.scanLimits });
    return { runner, handle: runner.executor.refFor(unitId), unitId };
  }
  private absoluteAllowedWrites(runtime = false): string[] {
    return [...this.spec.allowedWrites, ...(runtime ? this.spec.runtimeWrites ?? [] : [])].map(path => path === '.' ? this.row.project_path
      : pathWithin(this.row.project_path, path.endsWith('/') ? path.slice(0, -1) : path));
  }
  private unitLaunchInProgress(runId: string, name: 'prepare' | 'unity'): boolean {
    const marker = join(this.config.home, 'runs', runId, `${name}-launching`);
    try {
      const pid = Number(readFileSync(marker, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) return false;
      process.kill(pid, 0);
      return true;
    } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }
  private unityLaunchInProgress(runId: string): boolean {
    return this.unitLaunchInProgress(runId, 'unity');
  }
  /**
   * The Unity unit's own account of a wait for the machine-level batch slot, as an event the interface can show while
   * the wait is happening. The journal is only written once every step has finished, so without this a Run waiting for
   * another editor looks exactly like one that is working.
   */
  private recordUnityWait(runId: string, runDir: string): void {
    const marker = join(runDir, 'unity-waiting.json');
    if (!existsSync(marker)) return;
    let note: { index?: number; wait?: number; since?: string; reason?: string };
    try { note = JSON.parse(readFileSync(marker, 'utf8')) as typeof note; }
    catch { return; } // A half-written marker is not a reason to stop observing.
    recordEventOnce(this.db, { workflowId: this.row.workflow_id, actor: 'runtime', entityType: 'run', entityId: runId,
      action: 'unity_waiting', reason: `Unity 步骤 ${note.index ?? 1} 等待机器级批处理槽位（第 ${note.wait ?? 1} 次，`
        + `自 ${note.since ?? '未知时间'}）：${note.reason ?? '等它释放后重试'}` });
  }
  private unityFailureMessage(failure: UnityEvidence): string {
    const detail = `Provider 产物保留；log=${failure.log}; exit=${failure.exitCode}; timeout=${Boolean(failure.timedOut)}; ${failure.errors.join(' | ')}`;
    // A diagnosed cause and what the person must do come first: the message is what the agent, the event log and the
    // interface read, and the interface keeps only its first 500 characters (api/read-model.ts).
    if (failure.guidance) return `Unity 步骤 ${failure.index} (${failure.method}) 失败：${failure.guidance}（技术细节：${detail}）`;
    return `Unity 步骤 ${failure.index} (${failure.method}) 失败，${detail}`;
  }
  private async launchUnity(runId: string): Promise<Observation> {
    const runDir = join(this.config.home, 'runs', runId), journal = join(runDir, 'unity-steps.json');
    const launching = join(runDir, 'unity-launching');
    hostPlatform.writePrivate(launching, String(process.pid), { flag: 'wx' });
    try {
      // Downstream validators also recheck the accepted native face through a temporary import.
      // Authority binds exact source/candidate bytes and never extends the model's write scope.
      authorizeNativeImport(this.row.project_path, runDir);
      hostPlatform.writePrivate(journal, JSON.stringify({ status: 'started' }), { flag: 'wx' });
      withStateEvent(this.db, { workflowId: this.row.workflow_id, actor: 'runtime', entityType: 'run',
        entityId: runId, action: 'unity_unit_intended', reason: 'Prerequisites exited; Unity unit intended' }, () => {});
      if ((this.db.prepare('SELECT status FROM task WHERE id = ?').get(this.row.id) as { status: string }).status !== 'RUNNING') {
        hostPlatform.writePrivate(journal, JSON.stringify({ status: 'cancelled' }), {});
        return { state: 'exited' };
      }
      // Unity steps are the only producers of observations. Anything the executor or a prepare command left there
      // (a pre-written avatar.fit.json, say) would otherwise be read as Runtime evidence.
      rmSync(join(runDir, OBSERVATIONS_DIR), { recursive: true, force: true });
      const unit = this.unityUnit(runId);
      try {
        await unit.executor.start({ runId: `unity-${runId}`, taskId: this.row.id,
          workflowId: this.row.workflow_id, projectId: this.row.project_id, stageId: this.row.stage_id,
          attempt: 1, idempotencyKey: `unity-${runId}`, expectedOutputs: [] });
      } catch (error) {
        if ((error as { noSideEffects?: boolean }).noSideEffects !== true) throw error;
        const evidence = [{ index: 1, method: this.spec.unitySteps![0]!.method, exitCode: 1, durationMs: 0,
          log: join(runDir, 'unity-1.log'), errors: ['Unity launch failed'], waits: 0 }];
        hostPlatform.writePrivate(journal, JSON.stringify({ status: 'finished', evidence }), {});
        return { state: 'exited' };
      }
      return { state: 'running' };
    } finally { unlinkSync(launching); }
  }
  private async launchPrepare(runId: string): Promise<Observation> {
    const runDir = join(this.config.home, 'runs', runId), journal = join(runDir, 'prepare.json');
    const launching = join(runDir, 'prepare-launching');
    hostPlatform.writePrivate(launching, String(process.pid), { flag: 'wx' });
    try {
      hostPlatform.writePrivate(journal, JSON.stringify({ status: 'started' }), { flag: 'wx' });
      withStateEvent(this.db, { workflowId: this.row.workflow_id, actor: 'runtime', entityType: 'run', entityId: runId,
        action: 'prepare_unit_intended', reason: 'Provider exited; deterministic pre-Unity preparation intended' }, () => {});
      if ((this.db.prepare('SELECT status FROM task WHERE id = ?').get(this.row.id) as { status: string }).status !== 'RUNNING') {
        hostPlatform.writePrivate(journal, JSON.stringify({ status: 'cancelled' }), {});
        return { state: 'exited' };
      }
      const unit = this.prepareUnit(runId), prepare = this.spec.prepare!;
      try {
        await unit.runner.start({ runId: unit.unitId, taskId: this.row.id, workflowId: this.row.workflow_id,
          projectId: this.row.project_id, stageId: this.row.stage_id, attempt: 1,
          idempotencyKey: unit.unitId, expectedOutputs: [], allowedWrites: this.absoluteAllowedWrites(true),
          argv: prepare.argv, env: { ...prepare.env, AVH_RUN_DIR: runDir, AVH_PROJECT_DIR: this.row.project_path } });
      } catch (error) {
        if ((error as { noSideEffects?: boolean }).noSideEffects !== true) throw error;
        hostPlatform.writePrivate(journal, JSON.stringify({ status: 'finished', result: { exitStatus: 1,
          errorClass: 'tool_failure', errorMessage: `准备步骤启动失败: ${(error as Error).message}`, outputs: {} } }), {});
        return { state: 'exited' };
      }
      return { state: 'running' };
    } finally { unlinkSync(launching); }
  }
  async observe(handle: RunHandle): Promise<Observation> {
    const x = this.fromHandle(handle), runId = this.runIdOf(handle);
    const spec = this.spec;
    if (!spec.unitySteps?.length) return x.adapter.observe(x.inner);
    const runDir = join(this.config.home, 'runs', runId);
    const journal = join(runDir, 'unity-steps.json');
    if (existsSync(journal)) {
      const intended = this.db.prepare("SELECT 1 FROM event WHERE entity_type = 'run' AND entity_id = ? AND action = 'unity_unit_intended' LIMIT 1")
        .get(runId);
      if (!intended) return { state: this.unityLaunchInProgress(runId) ? 'running' : 'unknown' };
      if (this.unityLaunchInProgress(runId)) return { state: 'running' };
      const saved = JSON.parse(readFileSync(journal, 'utf8')) as { status: string; evidence?: UnityEvidence[] };
      if (saved.status === 'started') this.recordUnityWait(runId, runDir);
      const failure = saved.status === 'finished' ? saved.evidence?.find(item => item.exitCode !== 0 || item.timedOut) : undefined;
      if (failure && !this.db.prepare("SELECT 1 FROM event WHERE entity_type = 'run' AND entity_id = ? AND action = 'unity_step_failed' LIMIT 1")
        .get(runId)) withStateEvent(this.db, { workflowId: this.row.workflow_id, actor: 'runtime',
        entityType: 'run', entityId: runId, action: 'unity_step_failed', reason: this.unityFailureMessage(failure) }, () => {});
      const unit = this.unityUnit(runId);
      const unitDir = join(runDir, `unity-${runId}`);
      if (saved.status === 'finished' && !existsSync(join(unitDir, 'command.json'))) return { state: 'exited' };
      const state = unit.executor.observe(unit.handle);
      if (state.state === 'exited' && saved.status === 'started') {
        const exit = unit.executor.collect(unit.handle) as RunResult & { timedOut?: boolean };
        const evidence = [{ index: 1, method: spec.unitySteps[0]!.method, exitCode: exit.exitStatus,
          durationMs: 0, log: join(runDir, 'unity-1.log'),
          errors: [exit.timedOut ? 'Unity unit timed out' : 'Unity launch failed'],
          ...(exit.timedOut ? { timedOut: true } : {}), waits: 0 }];
        hostPlatform.writePrivate(journal, JSON.stringify({ status: 'finished', evidence }), {});
      }
      return state;
    }
    const providerFile = join(runDir, 'unity-provider-result.json');
    const prepareJournal = join(runDir, 'prepare.json');
    if (spec.prepare && existsSync(prepareJournal)) {
      const intended = this.db.prepare("SELECT 1 FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='run' AND entity_id=? AND action='prepare_unit_intended' LIMIT 1")
        .get(this.row.workflow_id, runId);
      if (!intended) return { state: this.unitLaunchInProgress(runId, 'prepare') ? 'running' : 'unknown' };
      if (this.unitLaunchInProgress(runId, 'prepare')) return { state: 'running' };
      let saved = JSON.parse(readFileSync(prepareJournal, 'utf8')) as { status: string; result?: RunResult };
      if (saved.status === 'cancelled') return { state: 'exited' };
      const unit = this.prepareUnit(runId), unitDir = join(runDir, unit.unitId);
      if (saved.status === 'started') {
        const state = unit.runner.observe(unit.handle);
        if (state.state !== 'exited') return state;
        const result = unit.runner.collect(unit.handle);
        // Carry the unit's own output into the journal when it failed. The tool's stderr lives under
        // prepare-<runId> and nothing pointed there, so every preparation failure had to be reconstructed by
        // hand from the command and the environment before the actual message could be read.
        const failed = result.exitStatus !== 0 || Boolean(result.errorClass);
        hostPlatform.writePrivate(prepareJournal, JSON.stringify(
          failed ? { status: 'finished', result, diagnostic: toolDiagnostic(unitDir) } : { status: 'finished', result }), {});
        saved = { status: 'finished', result };
      } else if (saved.status !== 'finished' || !saved.result) return { state: 'unknown' };
      if (!saved.result || !Number.isInteger(saved.result.exitStatus)) return { state: 'unknown' };
      if (!saved.result || saved.result.exitStatus !== 0 || saved.result.errorClass) return { state: 'exited' };
      return this.launchUnity(runId);
    }
    const observed = x.adapter.observe(x.inner);
    if (observed.state !== 'exited') return observed;
    const provider = x.adapter.collect(x.inner);
    if (provider.exitStatus !== 0 || provider.errorClass) return { state: 'exited' };
    if (!existsSync(providerFile)) hostPlatform.writePrivate(providerFile, JSON.stringify(provider), { flag: 'wx' });
    return spec.prepare ? this.launchPrepare(runId) : this.launchUnity(runId);
  }
  confirmNeverStarted(runId: string): boolean {
    return createRunSupervisor(join(this.config.home, 'runs')).neverStarted(runId);
  }
  /**
   * For a person reconciling a Run the Runtime lost track of: its result, read the way a normal exit is read, once
   * everything it started (its unit, then its Unity steps) has provably finished. Starts nothing; undefined otherwise.
   */
  async settledResult(handle: RunHandle): Promise<RunResult | undefined> {
    const x = this.fromHandle(handle), runId = this.runIdOf(handle);
    if ((await x.adapter.observe(x.inner)).state !== 'exited') return undefined;
    if (this.spec.prepare) {
      const journal = join(this.config.home, 'runs', runId, 'prepare.json');
      if (!existsSync(journal)) return undefined;
      const saved = JSON.parse(readFileSync(journal, 'utf8')) as { status: string; result?: RunResult };
      if (saved.status !== 'finished') return undefined;
      const unit = this.prepareUnit(runId);
      if (existsSync(join(this.config.home, 'runs', runId, unit.unitId, 'command.json')) &&
        unit.runner.observe(unit.handle).state !== 'exited') return undefined;
      if (!saved.result || saved.result.exitStatus !== 0 || saved.result.errorClass) return this.collect(handle);
    }
    if (this.spec.unitySteps?.length) {
      const journal = join(this.config.home, 'runs', runId, 'unity-steps.json');
      if (!existsSync(journal) || (JSON.parse(readFileSync(journal, 'utf8')) as { status: string }).status !== 'finished') return undefined;
      if (existsSync(join(this.config.home, 'runs', runId, `unity-${runId}`, 'command.json'))) {
        const unit = this.unityUnit(runId);
        if (unit.executor.observe(unit.handle).state !== 'exited') return undefined;
      }
    }
    return this.collect(handle);
  }
  async cancel(handle: RunHandle): Promise<'confirmed' | 'not_confirmed'> {
    const x = this.fromHandle(handle), runId = this.runIdOf(handle);
    const journal = join(this.config.home, 'runs', runId, 'unity-steps.json');
    const prepareJournal = join(this.config.home, 'runs', runId, 'prepare.json');
    const deadline = Date.now() + DEFAULT_CANCEL_TIMEOUT_MS;
    while ((this.unityLaunchInProgress(runId) || this.unitLaunchInProgress(runId, 'prepare')) && Date.now() < deadline) await delay(50);
    if (this.unityLaunchInProgress(runId) || this.unitLaunchInProgress(runId, 'prepare')) return 'not_confirmed';
    if (existsSync(journal) && this.spec.unitySteps?.length) {
      const unit = this.unityUnit(runId);
      if (await unit.executor.cancel(unit.handle) !== 'confirmed') return 'not_confirmed';
      if (!await this.settleUnityEditors(runId)) return 'not_confirmed';
      if (await x.adapter.cancel(x.inner) !== 'confirmed') return 'not_confirmed';
      hostPlatform.writePrivate(journal, JSON.stringify({ status: 'cancelled' }), {});
      {
        try { recoverNativeImport(this.row.project_path, join(this.config.home, 'runs', runId)); }
        catch (error) { recordEventOnce(this.db, { workflowId: this.row.workflow_id, actor: 'runtime', entityType: 'run',
          entityId: runId, action: 'native_import_review_required', reason: `执行已停止；临时导入恢复需审阅：${(error as Error).message}` }); }
      }
      return 'confirmed';
    }
    if (existsSync(prepareJournal) && this.spec.prepare) {
      const unit = this.prepareUnit(runId);
      if (await unit.runner.cancel(unit.handle) !== 'confirmed') return 'not_confirmed';
      if (await x.adapter.cancel(x.inner) !== 'confirmed') return 'not_confirmed';
      hostPlatform.writePrivate(prepareJournal, JSON.stringify({ status: 'cancelled' }), {});
      return 'confirmed';
    }
    return x.adapter.cancel(x.inner);
  }
  /**
   * Windows only: a Run is cancelled only once the Unity editors it started have really stopped.
   *
   * Ending the Unity unit's job is what stops them — the job's tree is what the helper terminates, and the editor runs
   * inside a nested job of its own — but terminating a job is a request. The job reads as empty as soon as its
   * processes are marked terminated, which is *before* the kernel has released them, and the project lock they still
   * hold outlives that window: a project left locked refuses every later step with "工程被占用", permanently and
   * silently. So the editors are waited for here, and a stop is not confirmed while one of them still runs.
   *
   * A process the kernel has already ended is not one of those — it cannot run again, and only a restart reclaims it —
   * so cancellation is confirmed and the residue is recorded as the restart diagnosis that the next Unity step reports
   * (`unityOccupancyGuidance`), rather than deleting a lock file that is still held.
   */
  private async settleUnityEditors(runId: string): Promise<boolean> {
    if (process.platform !== 'win32') return true;
    // Every project a step of this task opens, not only the task's own: an isolated build step points the editor at a
    // copy inside the project, and that copy's lock is the one that would refuse the next launch. A step whose project
    // binding cannot be resolved never opened an editor, so it must not stop the cancellation itself.
    const projects = [...new Set(this.spec.unitySteps!.flatMap(step => {
      try { return [stepProject(this.row.project_path, step)]; } catch { return []; }
    }))];
    const settled = await settleWindowsUnityEditors(projects, DEFAULT_CANCEL_TIMEOUT_MS);
    if (settled.settled && settled.occupancy.kind === 'exiting')
      recordEventOnce(this.db, { workflowId: this.row.workflow_id, actor: 'runtime', entityType: 'run', entityId: runId,
        action: 'unity_editor_stuck_exiting', reason: unityOccupancyGuidance(settled.occupancy) ?? 'Unity 进程卡在退出中' });
    return settled.settled;
  }
  async collect(handle: RunHandle): Promise<RunResult> {
    const x = this.fromHandle(handle);
    const runId = this.runIdOf(handle);
    const spec = this.spec;
    const runDir = join(this.config.home, 'runs', runId);
    const providerFile = join(runDir, 'unity-provider-result.json');
    const journal = join(runDir, 'unity-steps.json');
    const prepareJournal = join(runDir, 'prepare.json');
    const result = existsSync(providerFile) && (existsSync(journal) || existsSync(prepareJournal))
      ? JSON.parse(readFileSync(providerFile, 'utf8')) as RunResult : x.adapter.collect(x.inner);
    delete result.prepare;
    if (existsSync(journal) && (JSON.parse(readFileSync(journal, 'utf8')) as { status: string }).status === 'cancelled')
      result.exitStatus = 143;
    if (spec.prepare && existsSync(prepareJournal)) {
      if (!this.db.prepare("SELECT 1 FROM event WHERE workflow_id=? AND actor='runtime' AND entity_type='run' AND entity_id=? AND action='prepare_unit_intended' LIMIT 1")
        .get(this.row.workflow_id, runId)) throw new Error('Prepare outcome has no Runtime unit intent; do not rerun');
      const saved = JSON.parse(readFileSync(prepareJournal, 'utf8')) as { status: string; result?: RunResult };
      if (saved.status === 'cancelled') result.exitStatus = 143;
      else if (saved.status !== 'finished' || !saved.result || !Number.isInteger(saved.result.exitStatus)) throw new Error('Prepare outcome unknown; do not rerun');
      else {
        result.prepare = { status: 'finished', exitStatus: saved.result.exitStatus,
          ...(saved.result.errorClass ? { errorClass: saved.result.errorClass } : {}), outOfBoundsPaths: saved.result.outOfBoundsPaths ?? [] };
        result.scanEvidence = [...(result.scanEvidence ?? []), ...(saved.result.scanEvidence ?? [])];
        result.outOfBoundsPaths = [...new Set([...(result.outOfBoundsPaths ?? []), ...(saved.result.outOfBoundsPaths ?? [])])];
        if (saved.result.exitStatus !== 0 || saved.result.errorClass) {
          result.exitStatus = saved.result.exitStatus || 1;
          result.errorClass = saved.result.errorClass ?? 'tool_failure';
          result.errorMessage = saved.result.errorMessage ?? `准备步骤退出码 ${saved.result.exitStatus}`;
          result.retryable = saved.result.retryable;
        }
      }
    }
    if (result.exitStatus === 0 && !result.errorClass && spec.unitySteps?.length) {
      if (existsSync(journal)) {
        const saved = JSON.parse(readFileSync(journal, 'utf8')) as { status: string; evidence?: RunResult['unitySteps'] };
        if (saved.status !== 'finished' || !saved.evidence) throw new Error('Unity step outcome unknown; do not rerun');
        result.unitySteps = saved.evidence;
      } else {
        result.unitySteps = spec.unitySteps.map((step, offset) => ({ index: offset + 1, method: step.method,
          status: 'not_started' as const, exitCode: 0, durationMs: 0, log: '',
          errors: ['Unity 步骤未开始：执行方退出后尚未由 observe 启动'], waits: 0 }));
      }
      const failure = result.unitySteps.find(item => item.exitCode !== 0 || item.timedOut);
      if (failure) {
        result.exitStatus = failure.exitCode || 124;
        result.errorClass = failure.timedOut ? 'timeout' : 'tool_failure';
        result.retryable = !(failure.errors[0] ?? '').startsWith('Unity launch failed');
        result.errorMessage = this.unityFailureMessage(failure);
      }
    }
    const before = JSON.parse(readFileSync(join(this.config.home, 'runs', runId, 'scope-before.json'), 'utf8')) as TaskScopeSnapshot;
    const unityAllowed = spec.unitySteps?.length && this.config.unity ?
      [...this.config.unity.projectScratch, 'Packages/packages-lock.json'] : [];
    const after = gitStatusSnapshot(before.repo, this.row.project_path, this.config.scanLimits);
    result.scanEvidence = [...(result.scanEvidence ?? []), ...changeEvidence(before.repo, before.status, after, this.config.scanLimits)];
    const runtimeIntended = this.db.prepare(`SELECT 1 FROM event WHERE actor='runtime' AND entity_type='run' AND entity_id=?
      AND action IN ('prepare_unit_intended','unity_unit_intended') LIMIT 1`).get(runId);
    let restoredPaths: string[] = [];
    if (runtimeIntended) {
      try { restoredPaths = restoredNativeImportPaths(this.row.project_path, join(this.config.home, 'runs', runId)); }
      catch { /* Changed authority is evidence to review, never an obstacle to stopping a confirmed process tree. */ }
    }
    const runtimeAllowed = runtimeIntended ? [...spec.runtimeWrites ?? [], ...restoredPaths] : [];
    const outside = taskScopeChanges(this.row.project_path, [...spec.allowedWrites, ...unityAllowed, ...runtimeAllowed], before, this.config.scanLimits, after);
    result.outOfBoundsPaths = [...new Set([...(result.outOfBoundsPaths ?? []), ...outside])];
    if ((runtimeIntended || spec.tool) && result.exitStatus === 0 && !result.errorClass && !result.outOfBoundsPaths.length) {
      for (const output of spec.expectedOutputs) {
        if (output.startsWith('run:')) continue;
        const file = pathWithin(this.row.project_path, output.replace(/\/+$/, ''));
        if (existsSync(file) && lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink())
          result.outputs[output] = sha256File(file);
      }
    }
    return result;
  }
}
export function taskScheduler(db: DatabaseSync, config: LocalConfig, id: string, executor?: Executor,
  runtime: CycleRuntime = {}): Scheduler {
  const row = taskRow(db, id); const spec = specOf(row);
  const slotCapacity = Object.fromEntries(spec.resources.map(resource =>
    [resource, resource === 'unity_batch' ? config.unitySlots.count : 1]));
  return new Scheduler(db, row.workflow_id, definition(spec), executor ?? new TaskRouter(db, config, row),
    new TaskVerifier(row.project_path, spec, config.home), new TaskFingerprinter(row.project_path, db, config.home, id),
    { maxRetries: spec.maxRetries, slotCapacity, stageSlots: { work: spec.resources }, providerRegistry: registry(config), ...runtime });
}
/**
 * One Workflow that cannot advance (its project directory moved away, say) must not stop every other one: record why,
 * once per distinct reason, and go on. A lost scheduler lease still ends the round.
 */
function tickFailed(db: DatabaseSync, workflowId: string, error: unknown): void {
  const reason = `本轮跳过这个流程：${(error as Error).message}`.slice(0, 2000);
  const last = db.prepare(`SELECT reason FROM event WHERE workflow_id = ? AND action = 'tick_failed' ORDER BY seq DESC LIMIT 1`)
    .get(workflowId) as { reason: string } | undefined;
  if (last?.reason !== reason) db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
    VALUES (?, 'runtime', 'workflow', ?, 'tick_failed', ?, '{}')`).run(workflowId, workflowId, reason);
}
export async function serveOnce(db: DatabaseSync, config: LocalConfig, executorFor?: (id: string) => Executor,
  mayDispatch: () => boolean = () => true,
  options: { idleFingerprintRefreshMs?: number; idleFingerprintCadence?: IdleFingerprintCadence } = {}): Promise<boolean> {
  config = refreshAssetSearchRoots(config);
  const lease = acquireSchedulerLease(db);
  if (!lease.acquired) {
    console.log(`另一个调度周期正在运行（持有者 ${lease.holder}，到期 ${lease.expiresAt}）`);
    return false;
  }
  // A synchronous step can outlast the renewal timer's interval, so the long-work boundaries renew explicitly.
  // `renew` throws once another cycle owns the scheduler; `assertActive` then keeps the cycle stopped, and the
  // round writes nothing further. Counted for the timing diagnostic because an idle round's cost and its renewal
  // count are what show whether the lease survived the round.
  let renewals = 0;
  const keep = (): void => { lease.renew(); lease.assertActive(); renewals++; };
  const runtime: CycleRuntime = { heartbeat: keep, ...(options.idleFingerprintRefreshMs === undefined
    ? {} : { idleFingerprintRefreshMs: options.idleFingerprintRefreshMs }),
    ...(options.idleFingerprintCadence === undefined ? {} : { idleFingerprintCadence: options.idleFingerprintCadence }) };
  try {
    // Residue Runs of finished Tasks hold Provider slots; clean them before any routing decision.
    if (mayDispatch()) advanceInteractions(db, refreshAssetSearchRoots(config));
    const orphans = db.prepare(`SELECT DISTINCT t.id, t.workflow_id, w.process_hash FROM run r JOIN task t ON t.id = r.task_id
      JOIN workflow w ON w.id = t.workflow_id WHERE r.status IN ('pending', 'running')
        AND t.status IN (${FINISHED_TASK_STATUSES.map(s => `'${s}'`).join(', ')})
      ORDER BY t.rowid`).all() as { id: string; workflow_id: string; process_hash: string }[];
    for (const row of orphans) {
      keep();
      if (row.process_hash === 'avh-task/0.1') await taskScheduler(db, config, row.id, executorFor?.(row.id), runtime).closeOrphanRuns();
      else if (isFormalWorkflow(db, row.workflow_id))
        await workflowScheduler(db, config, row.workflow_id, executorFor?.(row.workflow_id), undefined, runtime).closeOrphanRuns();
    }
    // A serve cycle that already held a Workflow as active can still create and dispatch a Task after someone
    // cancelled it (a `workflow cancel` in another process, or a cycle that reached this Workflow long after it
    // froze the list). Nothing ticks a cancelled Workflow again, so that Task's Run keeps its project lock with
    // `lease_until = 9999-12-31`: the orphan sweep above cannot reach it, because it requires a final Task.
    // Finish it the way `avh cancel <task>` finishes one — confirm the unit stopped, then close Task, Run and
    // lock together. A unit that will not confirm a stop keeps its Task, Run and lock exactly where they are.
    const abandoned = db.prepare(`SELECT t.id, t.workflow_id, w.process_hash FROM task t
      JOIN workflow w ON w.id = t.workflow_id WHERE w.status = 'cancelled'
        AND t.status NOT IN (${FINISHED_TASK_STATUSES.map(s => `'${s}'`).join(', ')}) ORDER BY t.rowid`)
      .all() as { id: string; workflow_id: string; process_hash: string }[];
    for (const row of abandoned) {
      keep();
      try {
        const temporary = row.process_hash === 'avh-task/0.1';
        if (!temporary && !isFormalWorkflow(db, row.workflow_id)) continue;
        const scheduler = temporary ? taskScheduler(db, config, row.id, executorFor?.(row.id), runtime)
          : workflowScheduler(db, config, row.workflow_id, executorFor?.(row.workflow_id), undefined, runtime);
        const result = await scheduler.cancelTask(row.id, '工作流已取消：收尾它名下仍未完成的阶段任务');
        if (!result.confirmed) recordEventOnce(db, { workflowId: row.workflow_id, actor: 'runtime', entityType: 'task',
          entityId: row.id, action: 'abandoned_task_unconfirmed',
          reason: '工作流已取消，但执行单元未能确认停止；保留任务、Run 与其项目锁' });
      } catch (error) { lease.assertActive(); tickFailed(db, row.workflow_id, error); }
    }
    const rows = db.prepare(`SELECT t.id, t.workflow_id FROM task t JOIN workflow w ON w.id = t.workflow_id
      WHERE w.process_hash = 'avh-task/0.1' AND t.rowid =
        (SELECT MAX(t2.rowid) FROM task t2 WHERE t2.workflow_id = t.workflow_id)
        AND t.status NOT IN ('FAILED', 'CANCELLED') ORDER BY t.rowid`)
      .all() as { id: string; workflow_id: string }[];
    for (const row of rows) {
      keep();
      try { await taskScheduler(db, config, row.id, executorFor?.(row.id), runtime).tick(mayDispatch); }
      catch (error) { lease.assertActive(); tickFailed(db, row.workflow_id, error); }
    }
    if (mayDispatch()) await advanceProductionContinuations(db, config, mayDispatch, keep);
    // Formal Workflows: executorFor receives the Workflow id.
    const formal = db.prepare(`SELECT w.id FROM workflow w JOIN workflow_definition d ON d.workflow_id = w.id
      WHERE w.status IN ('active', 'upload_ready') ORDER BY w.rowid`).all() as { id: string }[];
    // An idle cycle's cost has to be attributable to a phase before anyone tries to reduce it, and the
    // scheduler's own stdout is discarded, so the timings go to a file when asked for (缺陷 14).
    const timing = phaseTimer(process.env.AVH_SCHEDULER_TIMING, formal.length);
    for (const row of formal) {
      keep();
      try {
        // One frozen snapshot for both the scheduler and the milestone recomputation: they must agree
        // about the workflow they are looking at anyway. Sharing it halves the snapshot reads, which
        // measurement puts at tens of milliseconds per cycle — a real saving, but not the reason an idle
        // service costs half a core. That turned out to be the fingerprint refresh and the archive
        // projection, which this does not touch (证据/缺陷/14, 决定记录 D-97).
        const frozen = timing.measureSync('snapshot', () => workflowSnapshot(db, row.id));
        const scheduler = timing.measureSync('scheduler', () => workflowScheduler(db, config, row.id, executorFor?.(row.id), frozen, runtime));
        await timing.measure('tick', () => scheduler.tick(mayDispatch));
        // `client_verified` is terminal: the Workflow leaves this loop and is never observed again. The idle cadence
        // must not let it be entered on a version the person changed after approving it, so the status update is
        // allowed one more observation before it accepts that transition.
        await timing.measure('status', () => updateWorkflowStatus(db, row.id, frozen, () => scheduler.refreshArtifacts()));
      }
      catch (error) { lease.assertActive(); tickFailed(db, row.id, error); }
    }
    timing.finish({ leaseRenewals: renewals });
    if (mayDispatch()) await advanceProductionContinuations(db, config, mayDispatch, keep);
    // A takeover analysis that ended is settled here: its candidates enter the project's facts as inferences, and the
    // project's archive is written at this safe point.
    keep();
    try {
      for (const settled of reconcileRecoveries(db)) {
        const written = projectSafePoint(db, settled.projectId, { tree: 'auto', heartbeat: keep });
        if (written.status === 'failed') console.error(`工程档案写入失败（${settled.projectId}）：${written.error}`);
      }
    } catch (error) {
      if (error instanceof SchedulerLeaseLostError) throw error;
      console.error(`接手分析结果无法入库：${(error as Error).message}`);
    }
    keep();
    if (mayDispatch()) advanceInteractions(db, refreshAssetSearchRoots(config));
    return true;
  } finally { lease.release(); }
}
/**
 * Per-phase timings for one scheduler pass, written to a file when AVH_SCHEDULER_TIMING names one.
 *
 * The scheduler runs as a child whose stdout is discarded, so a diagnostic that only logged would be
 * invisible exactly when it is needed. With no path set every measurement is a direct call, so the
 * production path pays nothing but a closure.
 */
function phaseTimer(path: string | undefined, workflows: number): {
  measure: <T>(phase: string, run: () => Promise<T>) => Promise<T>;
  measureSync: <T>(phase: string, run: () => T) => T;
  finish: (extra?: Record<string, number>) => void;
} {
  if (!path) return { measure: (_phase, run) => run(), measureSync: (_phase, run) => run(), finish: () => {} };
  const totals = new Map<string, { ms: number; calls: number }>();
  const add = (phase: string, ms: number) => {
    const entry = totals.get(phase) ?? { ms: 0, calls: 0 };
    totals.set(phase, { ms: entry.ms + ms, calls: entry.calls + 1 });
  };
  return {
    async measure(phase, run) { const started = performance.now(); try { return await run(); } finally { add(phase, performance.now() - started); } },
    measureSync(phase, run) { const started = performance.now(); try { return run(); } finally { add(phase, performance.now() - started); } },
    finish(extra = {}) {
      const phases = Object.fromEntries([...totals].map(([phase, entry]) => [phase, {
        ms: Math.round(entry.ms), calls: entry.calls, perWorkflowMs: Math.round(entry.ms / Math.max(1, workflows)) }]));
      const total = [...totals.values()].reduce((sum, entry) => sum + entry.ms, 0);
      try {
        writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), workflows, totalMs: Math.round(total), ...extra, phases }, null, 1));
      } catch { /* a diagnostic must never break the scheduler it is measuring */ }
    },
  };
}
/** Already-dispatched units still need collection and verification before a safe pause. Unknown units retain locks. */export function hasDrainWork(db: DatabaseSync): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM run r JOIN task t ON t.id=r.task_id
    LEFT JOIN dispatch_outbox o ON o.run_id=r.id WHERE t.status IN ('RUNNING','VERIFYING')
    AND ((r.status IN ('pending','running') AND o.status IN ('launched','acked'))
      OR (t.status='VERIFYING' AND r.status='exited')) LIMIT 1`).get());
}
/** Stop dispatch immediately, then settle already-dispatched units without cancelling or issuing new work. */
export async function serve(db: DatabaseSync, config: LocalConfig, once: boolean, interval: number, drainOnly = false): Promise<void> {
  if (!Number.isSafeInteger(interval) || interval < 100) throw new Error('--interval 应为不少于 100 的毫秒数');
  const stopping = new AbortController();
  let draining = drainOnly;
  const stop = (): void => { draining = true; stopping.abort(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  // Windows cannot send the service's scheduler a SIGTERM; it closes the scheduler's stdin instead (api/server.ts).
  if (process.env.AVH_STOP_ON_STDIN_END === '1') { process.stdin.once('end', stop); process.stdin.once('error', stop); process.stdin.resume(); }
  const cadence = newFingerprintCadence();
  try {
    do {
      // The steady loop throttles settled Workflows; a single `--once` round observes everything, because a person
      // asking for one round is asking for the current state, not for a cadence decision. The cadence is created
      // once here so its window spans the loop's rounds rather than restarting every round.
      await serveOnce(db, config, undefined, () => !draining,
        once ? {} : { idleFingerprintRefreshMs: IDLE_FINGERPRINT_REFRESH_MS, idleFingerprintCadence: cadence });
      if (draining && !hasDrainWork(db) || once && !draining) break;
      if (draining) await delay(interval);
      else await delay(interval, undefined, { signal: stopping.signal }).catch(() => {});
    } while (true);
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    if (process.env.AVH_STOP_ON_STDIN_END === '1') { process.stdin.off('end', stop); process.stdin.off('error', stop); process.stdin.pause(); }
  }
}

function changedPassedOutputs(db: DatabaseSync, workflowId: string, taskId: string, project: string,
  spec: TaskSpec, home: string): string[] {
  const completion = db.prepare(`SELECT artifact_hashes_json FROM stage_completion
    WHERE workflow_id = ? AND stage_id = 'work' AND run_id IN (SELECT id FROM run WHERE task_id = ?)
    ORDER BY seq DESC LIMIT 1`)
    .get(workflowId, taskId) as { artifact_hashes_json: string } | undefined;
  if (!completion) return [];
  const recorded = JSON.parse(completion.artifact_hashes_json) as Record<string, string>;
  const runDir = latestRunDirectory(db, home, taskId);
  return spec.expectedOutputs.filter(path => {
    const current = hashPath(taskPath(project, runDir, path));
    return !current || recorded[path] !== current;
  });
}
export function taskList(db: DatabaseSync, project?: string): string {
  const rows = db.prepare(`SELECT t.id, t.status, t.goal, p.path, w.project_id, w.id AS workflow_id, w.plan_json FROM task t JOIN workflow w ON w.id = t.workflow_id
    JOIN project p ON p.id = w.project_id WHERE w.process_hash = 'avh-task/0.1' ORDER BY t.rowid`).all() as
    { id: string; status: string; goal: string; path: string; project_id: string; workflow_id: string; plan_json: string }[];
  const home = databaseHome(db);
  return ['id\tproject\tstatus\tgoal', ...rows.filter(row => !project || row.path === project || basename(row.path) === project || projectRoot(db, row.project_id) === project)
    .map(row => `${row.id}\t${basename(row.path)}\t${row.status}\t${row.goal}${row.status === 'PASSED' &&
      changedPassedOutputs(db, row.workflow_id, row.id, projectRoot(db, row.project_id),
        (JSON.parse(row.plan_json) as { task: TaskSpec }).task, home).length
      ? '；产物已变化；如需重新执行，用 avh task redo' : ''}`)].join('\n');
}
type PendingChange = { seq: number; artifact: string; recorded_at: string };
function pendingChanges(db: DatabaseSync, workflowId: string): PendingChange[] {
  return db.prepare(`SELECT seq, artifact, recorded_at FROM out_of_bounds_change
    WHERE workflow_id = ? AND accepted = 0 ORDER BY seq`).all(workflowId) as PendingChange[];
}

export function taskAcceptChanges(db: DatabaseSync, id: string, note: string, paths: string[] = []):
  { accepted: number; remaining: number; status: string; acceptedPaths: string[] } {
  if (!note.trim()) throw new Error('--note: 必须填写审阅说明');
  const row = anyTaskRow(db, id);
  const chosen = pendingChanges(db, row.workflow_id).filter(change =>
    !paths.length || paths.includes(change.artifact) ||
    (change.artifact.startsWith('workspace:') && paths.includes(change.artifact.slice('workspace:'.length))));
  withStateEvent(db, { workflowId: row.workflow_id, actor: 'human', entityType: 'task', entityId: id,
    action: 'accepted_changes', reason: note, payload: { paths, accepted: chosen.length } }, () => {
    const update = db.prepare('UPDATE out_of_bounds_change SET accepted = 1 WHERE seq = ? AND accepted = 0');
    for (const change of chosen) update.run(change.seq);
  });
  const remaining = pendingChanges(db, row.workflow_id).length;
  if (chosen.length && row.status === 'WAITING_HUMAN' && remaining === 0) {
    const run = db.prepare('SELECT status FROM run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1')
      .get(id) as { status: string } | undefined;
    const state = aggregateWorkflow(db, row.workflow_id, definitionOf(db, row)).stages[row.stage_id]!;
    if (run?.status === 'exited' && state.reasonCodes?.every(code =>
      code === 'completion_missing' || code === 'completion_invalidated'))
      transitionTask(db, id, 'VERIFYING', 'human_approved', 'out-of-bounds changes accepted');
  }
  const status = (db.prepare('SELECT status FROM task WHERE id = ?').get(id) as { status: string }).status;
  return { accepted: chosen.length, remaining, status, acceptedPaths: chosen.map(change => change.artifact) };
}

export function taskShow(db: DatabaseSync, id: string, home = databaseHome(db)): string {
  const row = taskRow(db, id); const spec = specOf(row);
  const events = db.prepare(`SELECT action, reason, occurred_at, payload_json FROM event WHERE workflow_id = ?
    AND (entity_id = ? OR entity_type IN ('verdict', 'stage_completion', 'gate_decision')
      OR (entity_type = 'run' AND entity_id IN (SELECT id FROM run WHERE task_id = ?))) ORDER BY seq`)
    .all(row.workflow_id, id, id) as { action: string; reason: string; occurred_at: string; payload_json: string }[];
  const runs = db.prepare('SELECT id, attempt, provider, status, result_json FROM run WHERE task_id = ? ORDER BY attempt')
    .all(id) as { id: string; attempt: number; provider: string | null; status: string; result_json: string | null }[];
  const state = aggregateWorkflow(db, row.workflow_id, definition(spec)).stages.work!;
  const pending = pendingChanges(db, row.workflow_id);
  const recordedHashes = buildAggregateInput(db, row.workflow_id).artifactHashes;
  const unobserved = spec.expectedOutputs.filter(path =>
    (hashPath(taskPath(row.project_path, latestRunDirectory(db, home, id), path)) ?? '') !== (recordedHashes[path] ?? ''));
  const changed = row.status === 'PASSED' ? changedPassedOutputs(db, row.workflow_id, id, row.project_path, spec, home) : [];
  const projectLocked = Boolean(db.prepare('SELECT 1 FROM lock WHERE resource = ?').get(`project:${row.project_id}`));
  const latestRouteWait = [...events].reverse().find(event => event.action === 'route_waiting');
  const readyIndex = events.findLastIndex(event => event.action.endsWith('->READY'));
  const waits = events.slice(readyIndex + 1).filter(event => event.action === 'route_waiting');
  const waiting = row.status === 'READY' && waits.length
    ? [`等待原因: ${waits.at(-1)!.reason}`, `等待开始: ${waits[0]!.occurred_at}（原因最近更新: ${waits.at(-1)!.occurred_at}）`] : [];
  const next = taskNextStep(row.status, pending.length, changed.length, projectLocked, Boolean(latestRouteWait));
  return [`Task ${id}`, `项目: ${row.project_path}`, `状态: ${row.status}`, ...waiting, `目标: ${spec.goal}`,
    `阶段原因码: ${state.reasonCodes?.join(', ') || '-'}`, `阶段原因: ${state.reasons.join('; ') || '-'}`,
    `未对账产物: ${unobserved.join(', ') || '-'}`, `已变化产物: ${changed.join(', ') || '-'}`,
    '未接受的越界记录:', ...pending.map(change => `  ${change.artifact} 记录时间=${change.recorded_at}`),
    `下一步: ${next}`, 'Runs:', ...runs.map(run => `  ${run.id} attempt=${run.attempt} provider=${run.provider ?? 'unknown'} status=${run.status} result=${run.result_json ?? 'unknown'}`),
    '事件:', ...events.map(event => {
      const payload = JSON.parse(event.payload_json) as { proof?: string };
      return `  ${event.occurred_at} ${event.action}${payload.proof ? ` [${payload.proof}]` : ''}: ${event.reason}`;
    })].join('\n');
}
/** One sentence for a person about a Task: what happens next, or what they need to do. */
export function taskNextStep(status: string, pendingChanges: number, changedOutputs: number, projectLocked: boolean,
  routeWaiting: boolean): string {
  return pendingChanges ? '审阅后 task accept-changes 或 task redo' :
    status === 'WAITING_HUMAN' ? '人工查看 gate list 后 approve/reject，或 task redo' :
    status === 'BLOCKED' ? '检查失败；修正环境后 task redo' :
    status === 'READY' && projectLocked ? '等待当前项目 Run 释放锁' :
    status === 'READY' && routeWaiting ? '等待调度条件满足（见「等待原因」）；占用方是已结束任务的残留 Run 时，serve 会自动收尾，也可 avh cancel <run id>' :
    status === 'READY' || status === 'RUNNING' || status === 'VERIFYING' ? '运行 avh serve --once' :
    status === 'PASSED' && changedOutputs ? '产物已变化；如需重新执行，用 avh task redo' :
    status === 'PASSED' ? '已通过' : status === 'RECOVERY_REQUIRED' ? '人工确认 Run 状态后再继续' : '查看事件与 Run 结果';
}
export interface TaskGate { gate: string; taskId: string; project: string; status: 'pending' | 'approved' | 'rejected' | 'stale';
  question: string; binds: string; artifactHash: string }
/** Gates of temporary Tasks, with their state against the current artifact. */
export function taskGates(db: DatabaseSync, home = databaseHome(db)): TaskGate[] {
  const rows = db.prepare(`SELECT t.id, t.workflow_id, w.project_id, w.plan_json, t.status, p.path FROM task t
    JOIN workflow w ON w.id=t.workflow_id JOIN project p ON p.id=w.project_id
    WHERE w.process_hash='avh-task/0.1' AND t.status IN ('WAITING_HUMAN', 'PASSED')
      AND t.rowid = (SELECT MAX(t2.rowid) FROM task t2 WHERE t2.workflow_id=t.workflow_id)
    ORDER BY t.rowid`).all() as { id: string; workflow_id: string; project_id: string; plan_json: string; status: string; path: string }[];
  const gates: TaskGate[] = [];
  for (const row of rows) {
    const spec = (JSON.parse(row.plan_json) as { task: TaskSpec }).task;
    if (!spec.gate) continue;
    const hash = hashPath(taskPath(projectRoot(db, row.project_id), latestRunDirectory(db, home, row.id), spec.gate.bind)) ?? 'missing';
    const decision = db.prepare('SELECT artifact_hash FROM gate_decision WHERE workflow_id = ? AND gate_id = ? ORDER BY seq DESC LIMIT 1')
      .get(row.workflow_id, spec.gate.id) as { artifact_hash: string } | undefined;
    const rejected = db.prepare(`SELECT 1 FROM event WHERE workflow_id=? AND entity_type='gate' AND entity_id=?
      AND action='rejected' AND json_extract(payload_json, '$.hash')=? ORDER BY seq DESC LIMIT 1`)
      .get(row.workflow_id, `${row.workflow_id}:${spec.gate.id}`, hash);
    const status = decision?.artifact_hash === hash ? 'approved' : rejected ? 'rejected' : decision ? 'stale' : 'pending';
    gates.push({ gate: `${row.workflow_id}:${spec.gate.id}`, taskId: row.id, project: row.path, status,
      question: spec.gate.question, binds: spec.gate.bind, artifactHash: hash });
  }
  return gates;
}
export function gateList(db: DatabaseSync, home = databaseHome(db)): string {
  const result = ['gate\ttask\tproject\tstatus\tquestion\tartifact_hash', ...taskGates(db, home).map(gate =>
    `${gate.gate}\t${gate.taskId}\t${basename(gate.project)}\t${gate.status}\t${gate.question}\t${gate.artifactHash}`)];
  const formal = db.prepare(`SELECT w.id FROM workflow w JOIN workflow_definition d ON d.workflow_id = w.id
    WHERE w.status <> 'cancelled' ORDER BY w.rowid`).all() as { id: string }[];
  for (const { id } of formal) for (const gate of formalGates(db, id)) {
    if (gate.status === 'waiting') continue;
    result.push(`${gate.gate}\t${gate.owner}\t${basename(gate.project)}\t${gate.status}\t${gate.kind} ${gate.binds}\t${gate.artifactHash ?? 'missing'}`);
  }
  return result.join('\n');
}
export function gateDecide(db: DatabaseSync, id: string, approve: boolean, note: string,
  home = databaseHome(db)): void {
  const at = id.lastIndexOf(':'); if (at < 1) throw new Error('Gate id 格式为 <workflow-id>:<gate-id>');
  const workflowId = id.slice(0, at), gateId = id.slice(at + 1);
  const row = db.prepare(`SELECT t.id FROM task t WHERE t.workflow_id = ? AND t.status = 'WAITING_HUMAN' LIMIT 1`)
    .get(workflowId) as { id: string } | undefined;
  if (!row) throw new Error('Gate 对应任务不在 WAITING_HUMAN');
  const task = taskRow(db, row.id); const spec = specOf(task);
  if (!spec.gate || spec.gate.id !== gateId) throw new Error('Gate 不存在');
  const path = taskPath(task.project_path, latestRunDirectory(db, home, task.id), spec.gate.bind);
  const hash = hashPath(path);
  if (!hash) throw new Error('Gate 所绑产物不存在');
  if (!approve && db.prepare(`SELECT 1 FROM gate_decision WHERE workflow_id=? AND gate_id=?
    AND artifact_hash=? AND result='approved' LIMIT 1`).get(workflowId, gateId, hash))
    throw new Error('当前产物版本已有不可撤销的批准；请先修改产物，再对新版本作决定');
  const prior = buildAggregateInput(db, workflowId).artifactHashes[spec.gate.bind];
  if (prior !== hash) withStateEvent(db, { workflowId, actor: 'runtime', entityType: 'artifact_version',
    entityId: spec.gate.bind, action: 'observed', reason: 'Gate decision refreshed artifact hash', payload: { hash } },
  () => db.prepare('INSERT INTO artifact_version (workflow_id, kind, hash) VALUES (?, ?, ?)')
    .run(workflowId, spec.gate!.bind, hash));
  if (approve) withStateEvent(db, { workflowId, actor: 'human', entityType: 'gate', entityId: id,
    action: 'approved', reason: note || 'human approved current artifact', payload: { hash } },
  () => {
    if (hashPath(path) !== hash) throw new Error('Gate 产物在批准期间变化，请重新检查');
    db.prepare(`INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result) VALUES (?, ?, ?, 'approved')`)
      .run(workflowId, gateId, hash);
  });
  else withStateEvent(db, { workflowId, actor: 'human', entityType: 'gate', entityId: id,
    action: 'rejected', reason: note || 'human rejected current artifact', payload: { hash } }, () => {});
}
/** Current warning readings, one line each; the person reads which one still blocks and accepts that reading. */
export function warningList(db: DatabaseSync): string {
  const rows = warningRows(db);
  // Each row answers for its own reading: whether it still applies and whether accepting it is what the Runtime would
  // do now (`blocks`, the aggregate's own `warningUnaccepted`). A stage blocked by one warning says nothing about a
  // second reading in the same stage that does not apply, which used to be listed as blocking and acceptable too.
  const state = (row: (typeof rows)[number]): string =>
    !row.current ? '已过期，需重新取证' : row.result === 'pass' ? '已通过' : row.accepted ? '已接受'
      : row.blocks ? '待接受（阻断）' : row.applies ? '待接受' : '不适用';
  return ['workflow\tstage\tcheck\tresult\tstate\tverdict\tartifact_hash\taccepted_at',
    ...rows.map(row => `${row.workflowId}\t${row.stage}\t${row.checkId}\t${row.result}\t${state(row)}\t` +
      `${row.verdictId}\t${row.artifactHash}\t${row.acceptedAt ?? ''}`)].join('\n');
}
/** The CLI form of acceptance: `<workflow-id>:<check-id>`, the current reading, and who accepted it for what reason. */
export function warningAccept(db: DatabaseSync, id: string, note: string, expectedVerdictId?: string):
  { message: string } {
  const at = id.lastIndexOf(':');
  if (at < 1) throw new Error('提醒 id 格式为 <workflow-id>:<check-id>');
  const accepted = acceptWarning(db, id.slice(0, at), id.slice(at + 1), note, expectedVerdictId);
  return { message: accepted.alreadyAccepted
    ? `这条读数已经接受过：${id}（${accepted.recordedAt}）`
    : `已接受提醒：${id}（读数 ${accepted.verdictId}，${accepted.recordedAt}）；记录里写明这是你接受的一条提醒，不是它通过了检查` };
}
export function taskRedo(db: DatabaseSync, id: string, note = DEFAULT_REDO_NOTE): void {
  const row = anyTaskRow(db, id);
  // Redoing a passed formal stage replaces what later stages built on; it needs the person's reason.
  if (row.formal && row.status === 'PASSED' && note === DEFAULT_REDO_NOTE)
    throw new Error('重做已通过的阶段需要写明修改意见（--note）；新结果会使依赖它的后续阶段重新验证');
  if (row.formal) {
    const workflow = db.prepare('SELECT status FROM workflow WHERE id = ?').get(row.workflow_id) as { status: string };
    if (workflow.status !== 'active' && workflow.status !== 'upload_ready')
      throw new Error(`Workflow ${row.workflow_id} 已${workflow.status === 'cancelled' ? '取消' : '结束'}，不能再重做其中的阶段`);
  }
  if (row.status === 'WAITING_HUMAN') requestHumanRedo(db, id, note);
  else if (row.status === 'PASSED') {
    withStateEvent(db, { workflowId: row.workflow_id, actor: 'human', entityType: 'task', entityId: id,
      action: 'requested_redo', reason: note }, () => {});
  }
  // A failed or cancelled stage of a formal Workflow is otherwise final: the person authorizes a new Task for it.
  else if (row.formal && (row.status === 'FAILED' || row.status === 'CANCELLED')) {
    const latest = db.prepare('SELECT id FROM task WHERE workflow_id = ? AND stage_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(row.workflow_id, row.stage_id) as { id: string };
    if (latest.id !== row.id) throw new Error(`阶段 ${row.stage_id} 已有更新的任务 ${latest.id.slice(0, 8)}，请重做那一个`);
    withStateEvent(db, { workflowId: row.workflow_id, actor: 'human', entityType: 'task', entityId: id,
      action: 'requested_redo', reason: note }, () => {});
  }
  else if (row.status === 'BLOCKED') {
    withStateEvent(db, { workflowId: row.workflow_id, actor: 'human', entityType: 'task', entityId: id,
      action: 'requested_redo', reason: note }, () => {});
    transitionTask(db, id, 'READY', 'retry_authorized', note);
  } else throw new Error(row.formal ? 'task redo 仅适用于 PASSED、WAITING_HUMAN、BLOCKED、FAILED 或 CANCELLED'
    : 'task redo 仅适用于 PASSED、WAITING_HUMAN 或 BLOCKED');
}
export async function cancel(db: DatabaseSync, config: LocalConfig, id: string, executor?: Executor): Promise<CancelResult> {
  const run = db.prepare('SELECT task_id FROM run WHERE id = ?').get(id) as { task_id: string } | undefined;
  const row = anyTaskRow(db, run?.task_id ?? id);
  // A finished Task has no current Run to stop; any of its residue Runs may be closed.
  if (run && !FINISHED_TASK_STATUSES.some(status => status === row.status)) {
    const latest = db.prepare('SELECT id FROM run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1')
      .get(row.id) as { id: string };
    if (latest.id !== id) throw new Error('只能取消当前 Run');
  }
  const scheduler = row.formal ? workflowScheduler(db, config, row.workflow_id, executor) : taskScheduler(db, config, row.id, executor);
  return scheduler.cancelTask(row.id, `human cancelled ${run ? 'Run' : 'Task'} ${id}`, run ? id : undefined);
}
export async function taskRecover(db: DatabaseSync, config: LocalConfig, id: string,
  mode: 'no_side_effects' | 'reconciled', note: string, force = false,
  neverStarted: (runId: string) => boolean = runId => createRunSupervisor(join(config.home, 'runs')).neverStarted(runId)): Promise<void> {
  if (!note.trim()) throw new Error('task recover 必须提供 --note');
  const row = anyTaskRow(db, id);
  id = row.id;
  if (row.status !== 'RECOVERY_REQUIRED') throw new Error('task recover 仅适用于 RECOVERY_REQUIRED');
  const run = db.prepare('SELECT id, status, process_ref FROM run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1')
    .get(id) as { id: string; status: string; process_ref: string | null } | undefined;
  if (!run) throw new Error('没有可恢复的 Run');
  if (mode === 'no_side_effects') {
    if (!force && !neverStarted(run.id))
      throw new Error('无法确认单元不存在且 Run 未启动；确认无副作用后可加 --force --note');
    transitionTask(db, id, 'READY', 'no_side_effects', note, () => {
      db.prepare("UPDATE run SET status = 'abandoned', result_json = ? WHERE id = ?")
        .run(JSON.stringify({ exitStatus: 1, noSideEffects: true, outputs: {}, recoveryNote: note }), run.id);
      db.prepare("UPDATE dispatch_outbox SET status = 'closed' WHERE run_id = ? AND status != 'closed'").run(run.id);
      db.prepare('DELETE FROM lock WHERE run_id = ?').run(run.id);
      db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason)
        VALUES (?, 'human', 'run', ?, 'recovered_no_side_effects', ?)`).run(row.workflow_id, run.id, note);
    });
  } else {
    // A Run whose unit can now be seen to have finished is collected as any exit is: its result, and the writes found
    // outside its scope for the person to review. The person's check stands in only for what cannot be read back.
    let collected: RunResult | undefined;
    if (run.process_ref) {
      const reader = row.formal ? new StageRouter(db, config, workflowSnapshot(db, row.workflow_id)) : new TaskRouter(db, config, row);
      try { collected = await reader.settledResult({ ref: run.process_ref }); } catch { collected = undefined; }
    }
    transitionTask(db, id, 'VERIFYING', 'reconciled', note, () => {
      if (collected) db.prepare("UPDATE run SET status = 'exited', result_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...collected, recoveryNote: note }), run.id);
      else db.prepare("UPDATE run SET status = 'exited', result_json = COALESCE(result_json, ?) WHERE id = ?")
        .run(JSON.stringify({ exitStatus: 0, outputs: {}, recoveryNote: note }), run.id);
      for (const path of collected?.outOfBoundsPaths ?? []) db.prepare(`INSERT INTO out_of_bounds_change (workflow_id, stage_id, artifact)
        VALUES (?, ?, ?)`).run(row.workflow_id, row.stage_id, `workspace:${path}`);
      db.prepare("UPDATE dispatch_outbox SET status = 'closed' WHERE run_id = ? AND status != 'closed'").run(run.id);
      // The Run's locks stay held through verification; leaving VERIFYING releases them.
      db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason)
        VALUES (?, 'human', 'run', ?, 'recovered_reconciled', ?)`).run(row.workflow_id, run.id,
        `${note}（${collected ? `执行单元已结束，按正常退出收取结果${collected.outOfBoundsPaths?.length ? `，越界 ${collected.outOfBoundsPaths.length} 处待审阅` : ''}` : '执行结果读不回来，按人工核对'}）`);
    });
  }
}
export function projectTaskBrief(db: DatabaseSync, projectId: string, home = databaseHome(db)): string {
  const ids = db.prepare(`SELECT t.id FROM task t JOIN workflow w ON w.id=t.workflow_id
    WHERE w.project_id=? AND w.process_hash='avh-task/0.1' ORDER BY t.rowid`).all(projectId) as { id: string }[];
  return ids.length ? `\n## Harness Tasks\n\n${ids.map(row => taskShow(db, row.id, home).split('\n').slice(0, 8).join('\n')).join('\n\n')}\n` : '';
}
