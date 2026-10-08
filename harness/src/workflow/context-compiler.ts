import { ordinal } from '../pack-hash.ts';
export type ContextScalar = string | number | boolean | null;

export interface ContextCondition {
  path: string;
  exists?: boolean;
  equals?: ContextScalar;
  includes?: ContextScalar;
}

export interface ContextReference {
  id: string;
  path: string;
  heading?: string;
  priority: number;
  required: boolean;
  when: ContextCondition[];
  unless: ContextCondition[];
  excludes: string[];
  covers: string[];
  models: string[];
}

export interface FrozenContextItem {
  spec: ContextReference;
  sha256: string;
  content: string;
}

export interface ContextDecision {
  id: string;
  path: string;
  heading?: string;
  required: boolean;
  selected: boolean;
  reason: string;
  chars: number;
  priority: number;
  covers: string[];
  // Why this item ended where it did, as a value rather than as prose. A report that had to parse the
  // reason string to tell "not applicable here" from "did not fit" would break on the first rewording,
  // and telling those two apart is the whole point of counting them (决定记录 D-84).
  disposition: ContextDisposition;
}

export type ContextDisposition =
  | 'selected'
  | 'not-applicable'
  | 'excluded-by-condition'
  | 'out-of-budget'
  | 'mutually-exclusive'
  | 'same-section-already-injected'
  | 'model-family-mismatch';

export interface CompiledContext {
  text: string;
  decisions: ContextDecision[];
  usedChars: number;
  budgetChars: number;
  coverage: string[];
  missingCoverage: string[];
}

/** Bumped when the selection policy changes, so a report can be read against the rules that made it. */
export const CONTEXT_POLICY_VERSION = '1';
export const CONTEXT_REPORT_SCHEMA = 'context-assembly-report/0.1';

export interface ContextAssemblyIdentity {
  stage: string;
  /** Which Workflow this assembly belongs to. A report that cannot name its run cannot be compared to one. */
  workflow: string;
  /** Digest over the knowledge text, the capability manifest and the tool digests: a pack identity is all
   * three, so a knowledge digest alone cannot stand in for it. */
  pack: string;
  frozenAt: string;
  modelFamily?: string;
}

export interface ContextAssemblyReport {
  schema: string;
  policy: string;
  identity: ContextAssemblyIdentity;
  budget: { budgetChars: number; usedChars: number; overageChars: number; requiredChars: number;
    selectedOptionalChars: number; droppedForBudgetChars: number; unit: string };
  counts: Record<ContextDisposition | 'total', number>;
  contract: { required: string[]; covered: string[]; unmet: string[] };
  decisions: ContextDecision[];
}

/**
 * The assembly decisions as a durable, machine-readable fact rather than a log nobody consumes.
 *
 * It answers what the stage was actually given and what it was not, and why — separating "this item
 * does not apply here" from "this item did not fit", which are different facts about a run and are
 * counted apart. The coverage it reports is declared coverage: an item declaring a key is evidence
 * that the stage was offered that knowledge, not proof the model took it in.
 */
export function contextAssemblyReport(compiled: CompiledContext, identity: ContextAssemblyIdentity,
                                      requiredCoverage: string[] = []): ContextAssemblyReport {
  const counts: Record<string, number> = { total: compiled.decisions.length };
  for (const decision of compiled.decisions) counts[decision.disposition] = (counts[decision.disposition] ?? 0) + 1;
  const requiredChars = compiled.decisions.filter(d => d.selected && d.required).reduce((sum, d) => sum + d.chars, 0);
  const required = [...new Set(requiredCoverage)].sort();
  return {
    schema: CONTEXT_REPORT_SCHEMA, policy: CONTEXT_POLICY_VERSION, identity,
    budget: { budgetChars: compiled.budgetChars, usedChars: compiled.usedChars,
      overageChars: Math.max(0, compiled.usedChars - compiled.budgetChars), requiredChars,
      selectedOptionalChars: compiled.usedChars - requiredChars,
      droppedForBudgetChars: compiled.decisions.filter(d => d.disposition === 'out-of-budget').reduce((sum, d) => sum + d.chars, 0),
      // What the numbers count. Reporting a character count without its unit invites it to be read as
      // model tokens, which it is not.
      unit: 'utf16-code-units-of-item-bodies' },
    counts: counts as ContextAssemblyReport['counts'],
    // The keys this task demanded, what the selected items declare, and the gap between them. Deriving
    // the gap from those two keeps it correct whether or not the compile was allowed to continue.
    contract: { required, covered: compiled.coverage, unmet: required.filter(key => !compiled.coverage.includes(key)) },
    decisions: compiled.decisions,
  };
}

export interface FrozenContextPlan {
  items: FrozenContextItem[];
  facts: Record<string, unknown>;
  budgetChars: number;
  requiredCoverage: string[];
  prefix: string;
  suffix: string;
}

function at(root: Record<string, unknown>, path: string): unknown {
  let value: unknown = root;
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function contextConditionMatches(condition: ContextCondition, facts: Record<string, unknown>): boolean {
  const value = at(facts, condition.path);
  if (condition.exists !== undefined && (value !== undefined) !== condition.exists) return false;
  if (Object.hasOwn(condition, 'equals') && value !== condition.equals) return false;
  if (Object.hasOwn(condition, 'includes')) {
    if (Array.isArray(value)) return value.includes(condition.includes);
    if (typeof value === 'string' && typeof condition.includes === 'string') return value.includes(condition.includes);
    return false;
  }
  return true;
}

/** Exact item payload selected from a frozen Markdown file. */
export function contextItemContent(markdown: string, heading?: string): string {
  if (!heading) return markdown.trim();
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(line => /^#{1,6}\s+/.test(line) && line.replace(/^#{1,6}\s+/, '').trim() === heading);
  if (start < 0) throw new Error(`上下文小节不存在：${heading}`);
  const level = /^#+/.exec(lines[start]!)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const match = /^(#+)\s+/.exec(lines[i]!);
    if (match && match[1]!.length <= level) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

function modelMatches(patterns: string[], family?: string): boolean {
  if (!patterns.length) return true;
  if (!family) return false;
  return patterns.some(pattern => pattern === family || (pattern.endsWith('*') && family.startsWith(pattern.slice(0, -1))));
}

/** Deterministically compile frozen knowledge items; the agent never chooses what to read. */
export function compileContext(items: FrozenContextItem[], facts: Record<string, unknown>, options: {
  budgetChars: number; requiredCoverage?: string[]; modelFamily?: string;
}): CompiledContext {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.spec.id)) throw new Error(`上下文条目 id 重复：${item.spec.id}`);
    ids.add(item.spec.id);
  }
  const decisions: ContextDecision[] = [];
  // One recorder for every outcome, so each decision carries the same fields. Filling them in at seven
  // separate push sites is how a report ends up with a field that is present on six of them.
  const record = (spec: FrozenContextItem['spec'], content: string, selected: boolean,
                  reason: string, disposition: ContextDisposition) => {
    decisions.push({ id: spec.id, path: spec.path, heading: spec.heading, required: spec.required === true,
      selected, reason, chars: content.length, priority: spec.priority, covers: spec.covers, disposition });
  };
  const eligible = items.map(item => {
    const content = contextItemContent(item.content, item.spec.heading);
    const base = { item, content };
    if (!modelMatches(item.spec.models, options.modelFamily)) {
      record(item.spec, content, false, options.modelFamily
        ? `模型家族 ${options.modelFamily} 不匹配 ${item.spec.models.join(', ')}` : '尚未选择模型家族', 'model-family-mismatch');
      return undefined;
    }
    const failed = item.spec.when.find(rule => !contextConditionMatches(rule, facts));
    if (failed) {
      record(item.spec, content, false, `触发条件不成立：${failed.path}`, 'not-applicable');
      return undefined;
    }
    const blocked = item.spec.unless.find(rule => contextConditionMatches(rule, facts));
    if (blocked) {
      record(item.spec, content, false, `排除条件成立：${blocked.path}`, 'excluded-by-condition');
      return undefined;
    }
    return base;
  }).filter((item): item is { item: FrozenContextItem; content: string } => Boolean(item))
    .sort((a, b) => Number(b.item.spec.required) - Number(a.item.spec.required) ||
      b.item.spec.priority - a.item.spec.priority || ordinal(a.item.spec.id, b.item.spec.id));

  const selected: typeof eligible = [];
  const excluded = new Set<string>();
  const injected = new Map<string, string>();
  let used = 0;
  for (const candidate of eligible) {
    const spec = candidate.item.spec;
    if (excluded.has(spec.id)) {
      if (spec.required) throw new Error(`必选上下文条目被互斥排除：${spec.id}`);
      record(spec, candidate.content, false, '被更高优先级条目互斥排除', 'mutually-exclusive');
      continue;
    }
    const earlier = selected.find(entry => spec.excludes.includes(entry.item.spec.id));
    if (earlier) {
      if (spec.required || earlier.item.spec.required) throw new Error(`必选上下文条目互斥：${earlier.item.spec.id} 与 ${spec.id}`);
      record(spec, candidate.content, false, `与更高优先级条目 ${earlier.item.spec.id} 互斥`, 'mutually-exclusive');
      continue;
    }
    const selector = `${spec.path}#${spec.heading ?? ''}`, first = injected.get(selector);
    if (first) {
      record(spec, candidate.content, false, `同一小节已由 ${first} 注入`, 'same-section-already-injected');
      continue;
    }
    const cost = candidate.content.length;
    if (!spec.required && used + cost > options.budgetChars) {
      record(spec, candidate.content, false, `超出上下文预算 ${options.budgetChars} 字符`, 'out-of-budget');
      continue;
    }
    selected.push(candidate); used += cost; injected.set(selector, spec.id);
    for (const id of spec.excludes) excluded.add(id);
    record(spec, candidate.content, true,
      spec.required ? '必选条目' : spec.when.length ? `触发条件成立；优先级 ${spec.priority}` : `阶段默认；优先级 ${spec.priority}`,
      'selected');
  }
  const coverage = [...new Set(selected.flatMap(item => item.item.spec.covers))].sort();
  const missingCoverage = (options.requiredCoverage ?? []).filter(key => !coverage.includes(key));
  if (missingCoverage.length) throw new Error(`上下文覆盖不足：${missingCoverage.join('、')}`);
  const text = selected.map(({ item, content }) =>
    `--- ${item.spec.id} · ${item.spec.path}${item.spec.heading ? `#${item.spec.heading}` : ''} (sha256:${item.sha256}) ---\n${content}`).join('\n\n');
  return { text, decisions, usedChars: used, budgetChars: options.budgetChars, coverage, missingCoverage };
}

export function contextPlanText(compiled: CompiledContext): string {
  const explanation = compiled.decisions.map(item =>
    `- ${item.selected ? '注入' : '跳过'} ${item.id}：${item.reason}（${item.chars} 字符，覆盖 ${item.covers.join('、') || '无声明'}）`).join('\n');
  return `Harness 上下文计划：已用 ${compiled.usedChars}/${compiled.budgetChars} 字符；覆盖 ${compiled.coverage.join('、') || '无声明'}。\n${explanation}\n\n` +
    `以下是 Harness 编译并冻结的规范输入，不要自行遍历知识目录：\n${compiled.text}`;
}

export function materializeContextGoal(plan: FrozenContextPlan, modelFamily?: string): string {
  const compiled = compileContext(plan.items, plan.facts,
    { budgetChars: plan.budgetChars, requiredCoverage: plan.requiredCoverage, modelFamily });
  return [plan.prefix, plan.items.length ? contextPlanText(compiled) : '', plan.suffix].filter(Boolean).join('\n');
}

/**
 * The goal text and the assembly report from one compilation, so what the stage was given and what it
 * was not given cannot disagree: they come from the same pass rather than from two.
 */
export function compileContextPlan(plan: FrozenContextPlan, identity: ContextAssemblyIdentity, modelFamily?: string):
  { goal: string; report: ContextAssemblyReport } {
  const compiled = compileContext(plan.items, plan.facts,
    { budgetChars: plan.budgetChars, requiredCoverage: plan.requiredCoverage, modelFamily });
  return { goal: [plan.prefix, plan.items.length ? contextPlanText(compiled) : '', plan.suffix].filter(Boolean).join('\n'),
    report: contextAssemblyReport(compiled, identity, plan.requiredCoverage) };
}
