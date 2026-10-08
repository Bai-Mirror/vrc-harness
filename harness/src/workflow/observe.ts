import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { planValue } from '../process/aggregate.ts';
import { evaluateRule, parseRule, type RuleValue } from '../process/rule.ts';
import type { Check, ProcessDefinition, Verdict } from '../process/types.ts';
import type { RunResult, RunSpec, Verifier } from '../runtime/interfaces.ts';
import { cancelChecks, runCheckCommand } from '../exec/check-runner.ts';
import { hostArgv } from '../host-platform.ts';
import type { ObserverSpec } from './capabilities.ts';

/**
 * Metrics an observer reports: `{schema: observation/0.1, metrics: {name: number | boolean | null}}`.
 * null means "not measured" and is treated like an absent metric: the rule cannot pass on it.
 * Structured evidence that is not a metric — lists of paths, per-group rows — belongs in the optional
 * `details` field, because the metric map accepts only numbers, booleans and null.
 */
export interface Observation {
  schema: 'observation/0.1';
  metrics: Record<string, RuleValue | null>;
  details?: Record<string, unknown>;
  notes?: string[];
}
type Observed = { metrics: Record<string, RuleValue | null> } | { failure: 'no_data' | 'error'; reason: string };

export function parseObservation(text: string): Observation {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('观测结果应为对象');
  if (raw.schema !== 'observation/0.1') throw new Error('观测结果 schema 应为 observation/0.1');
  const metrics = raw.metrics;
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) throw new Error('观测结果缺少 metrics 映射');
  for (const [name, value] of Object.entries(metrics))
    if (value !== null && typeof value !== 'number' && typeof value !== 'boolean')
      throw new Error(`指标 ${name} 应为数值、真假值或 null`);
  const details = raw.details;
  if (details !== undefined && details !== null && (typeof details !== 'object' || Array.isArray(details)))
    throw new Error('观测结果 details 应为对象');
  return raw as unknown as Observation;
}

export interface ObservationContext {
  definition: ProcessDefinition;
  observers: Record<string, ObserverSpec>;
  thresholds: Record<string, RuleValue>;
  project: string;
  toolRoot: string;
  runRoot: string;
  /** The Runtime's home, masked from command observers. */
  harnessHome?: string;
  plan: () => Record<string, unknown>;
  /** The Workflow's frozen input Manifest, given to command observers as AVH_MANIFEST. */
  manifest?: unknown;
  /** Machine-specific values frozen with the Workflow. */
  variables?: Record<string, string>;
  /** Throws when a tool the observer runs is no longer the one the Workflow froze. */
  verifyTool?: (argv: string[]) => void;
  /** Restore the tool contract actually selected for this Run, independently of today's stage selection. */
  forRun?: (run: RunSpec) => ObservationContext;
}

export function substitute(argv: string[], values: Record<string, string>): string[] {
  return argv.map(arg => arg.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const value = values[name];
    if (!value) throw new Error(`能力清单需要尚未配置的运行变量：${name}`);
    return value;
  }));
}

/** Evaluates a stage's checks from independent observations; a Provider's own account is never read. */
export class ObservationVerifier implements Verifier {
  readonly context: ObservationContext;
  constructor(context: ObservationContext) { this.context = context; }

  async verify(run: RunSpec, _result: RunResult, hashes: Record<string, string>): Promise<Verdict[]> {
    if (this.context.forRun) return new ObservationVerifier(this.context.forRun(run)).verify(run, _result, hashes);
    const { definition } = this.context;
    const stage = definition.stages.find(item => item.id === run.stageId);
    if (!stage) throw new Error(`流程没有阶段 ${run.stageId}`);
    const runDirectory = join(this.context.runRoot, run.runId);
    const plan = run.expectedOutputs.includes('plan') && _result.runtimeObservedPlan
      ? _result.runtimeObservedPlan : run.inputSnapshot?.plan ?? this.context.plan();
    const cache = new Map<string, Observed>();
    const verdicts: Verdict[] = [];
    for (const id of stage.requires) {
      const check = definition.checks.find(item => item.id === id)!;
      if (check.maturity === 'deprecated') continue;
      if (check.when && !planValue(plan, check.when)) {
        // Only a false `when` may yield not_applicable; it is bound to the plan it was read from.
        verdicts.push({ id: '', checkId: check.id, scope: check.scope, artifactHash: hashes.plan ?? '',
          result: 'not_applicable', basis: check.when });
        continue;
      }
      let observed = cache.get(check.observe);
      if (!observed) { observed = await this.observe(check.observe, runDirectory, run.stageId, plan,
        run.inputSnapshot?.baseline.face_input, run.inputSnapshot?.manualValuesSha256); cache.set(check.observe, observed); }
      verdicts.push({ id: '', checkId: check.id, scope: check.scope, artifactHash: hashes[check.on] ?? '',
        ...this.judge(check, observed) });
    }
    return verdicts;
  }

  private judge(check: Check, observed: Observed): { result: Verdict['result']; basis: string } {
    if ('failure' in observed) return { result: observed.failure, basis: `${check.observe}: ${observed.reason}` };
    let rule;
    try { rule = parseRule(check.rule); }
    catch (error) { return { result: 'error', basis: `rule ${check.rule}: ${(error as Error).message}` }; }
    const outcome = evaluateRule(rule, observed.metrics, this.context.thresholds);
    const values = Object.entries(outcome.used).map(([name, value]) => `${name}=${value === null ? '缺' : String(value)}`).join(', ');
    return { result: outcome.result,
      basis: `${check.observe}: ${check.rule}${values ? ` | ${values}` : ''}${outcome.message ? ` | ${outcome.message}` : ''}` };
  }

  private async observe(id: string, runDirectory: string, stageId: string, plan: Record<string, unknown>, faceInputHash?: string,
    manualValuesSha256?: string): Promise<Observed> {
    const spec = this.context.observers[id];
    if (!spec) return { failure: 'error', reason: '能力清单没有这个观测' };
    let path: string;
    if (spec.kind === 'run-file') {
      path = join(runDirectory, spec.runFile);
    } else {
      try { this.context.verifyTool?.(spec.command); }
      catch (error) { return { failure: 'error', reason: (error as Error).message }; }
      const checkId = `observe-${id}`;
      path = join(runDirectory, 'checks', checkId.replace(/[^A-Za-z0-9_.-]/g, '_'), 'metrics.json');
      const run = await runCheckCommand(hostArgv(substitute(spec.command, { project: this.context.project, runDir: runDirectory,
        toolRoot: this.context.toolRoot, out: path, ...(this.context.variables ?? {}) })), { project: this.context.project, runDirectory, checkId,
        timeoutMs: spec.timeoutSec * 1000, readonly: [this.context.toolRoot], harnessHome: this.context.harnessHome,
        extraEnv: { AVH_RUN_DIR: runDirectory, AVH_PROJECT_DIR: this.context.project, AVH_TOOL_ROOT: this.context.toolRoot, AVH_STAGE: stageId,
          AVH_MANIFEST: JSON.stringify(this.context.manifest ?? {}), AVH_PLAN: JSON.stringify(plan),
          ...(faceInputHash ? { AVH_FACE_INPUT_HASH: faceInputHash } : {}),
          ...(manualValuesSha256 ? { AVH_ACCEPTED_MANUAL_FACE_SHA256: manualValuesSha256 } : {}) } });
      const isolation = run.isolation === 'none' ? `（未隔离：${run.isolationNote}）` : '';
      if (run.timedOut) return { failure: 'error', reason: `观测超时${isolation}` };
      if (run.status !== 0) return { failure: 'error',
        reason: `观测退出码 ${run.status ?? run.signal}${isolation}: ${(run.stderr || run.stdout).slice(0, 300)}` };
    }
    if (!existsSync(path) || !statSync(path).isFile()) return { failure: 'no_data', reason: '没有观测结果' };
    try { return { metrics: parseObservation(readFileSync(path, 'utf8')).metrics }; }
    catch (error) { return { failure: 'error', reason: `观测结果无效: ${(error as Error).message}` }; }
  }

  cancel(run: RunSpec): Promise<'confirmed' | 'not_confirmed'> {
    return cancelChecks(join(this.context.runRoot, run.runId));
  }
}
