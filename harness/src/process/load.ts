import { parseDocument } from 'yaml';
import type { Check, Gate, Milestone, Maturity, ProcessDefinition, Stage } from './types.ts';
import { explicitMeta, knowledgeMeta, MATURITIES, type KnowledgeKind } from './knowledge-meta.ts';
import { tryParseRule } from './rule.ts';
import { canonicalJson } from '../pack-hash.ts';

type Obj = Record<string, unknown>;
const WHEN = /^!?plan\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?: == "[A-Za-z0-9_-]+")?$/;
const T_REF = /\bt\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\b/g;

function object(value: unknown, at: string): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: expected mapping`);
  return value as Obj;
}

function string(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${at}: expected nonempty string`);
  return value;
}

function list(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at}: expected list`);
  return value;
}

function strings(value: unknown, at: string, optional = false): string[] {
  if (optional && value === undefined) return [];
  const result = list(value, at).map((item, i) => string(item, `${at}[${i}]`));
  if (new Set(result).size !== result.length) throw new Error(`${at}: duplicate entry`);
  return result;
}

function choice<T extends string>(value: unknown, options: readonly T[], at: string): T {
  const result = string(value, at);
  if (!options.includes(result as T)) throw new Error(`${at}: unsupported ${result}`);
  return result as T;
}

function condition(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  const result = string(value, at);
  if (!WHEN.test(result)) throw new Error(`${at}: only plan.<path> truth tests or equality with a quoted string, optionally prefixed by !, are supported`);
  return result;
}

function source(value: unknown, at: string): string | undefined {
  return value === undefined ? undefined : string(value, at);
}

function uniqueIds<T extends { id: string }>(items: T[], at: string): Set<string> {
  const ids = new Set(items.map(item => item.id));
  if (ids.size !== items.length) throw new Error(`${at}: duplicate id`);
  return ids;
}

function refs(values: string[], ids: Set<string>, at: string): void {
  for (const value of values) if (!ids.has(value)) throw new Error(`${at}: undefined reference ${value}`);
}

function noCycle(nodes: { id: string; edges: string[] }[], at: string): void {
  const byId = new Map(nodes.map(node => [node.id, node.edges]));
  const seen = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) throw new Error(`${at}: cycle at ${id}`);
    if (seen.has(id)) return;
    active.add(id);
    for (const edge of byId.get(id) ?? []) visit(edge);
    active.delete(id);
    seen.add(id);
  }
  for (const node of nodes) visit(node.id);
}

export function validateThresholds(document: unknown): Map<string, { maturity: Maturity; kind: KnowledgeKind }> {
  const root = object(document, 'thresholds');
  if (root.schema !== 'thresholds/0.1') throw new Error('thresholds.schema: expected thresholds/0.1');
  string(root.version, 'thresholds.version');
  const entries = object(root.t, 'thresholds.t');
  const maturities = new Map<string, { maturity: Maturity; kind: KnowledgeKind }>();
  for (const [name, raw] of Object.entries(entries)) {
    const at = `thresholds.t.${name}`;
    const entry = object(raw, at);
    if (!Object.hasOwn(entry, 'value') || entry.value === undefined)
      throw new Error(`${at}.value: required`);
    string(entry.unit, `${at}.unit`);
    const maturity = choice(entry.maturity, MATURITIES, `${at}.maturity`);
    string(entry.source, `${at}.source`);
    maturities.set(name, { maturity, kind: knowledgeMeta(entry, at).kind });
  }
  return maturities;
}

function validateProducerFeedback(stages: Stage[], checks: Check[]): void {
  const downstream = new Map(stages.map(stage => [stage.id, [] as Stage[]]));
  const checkById = new Map(checks.map(check => [check.id, check]));
  for (const stage of stages) {
    for (const need of stage.needs) downstream.get(need)!.push(stage);
  }
  for (const stage of stages) {
    const reachable = new Set<string>();
    const downstreamProduced = new Set<string>();
    function visit(current: Stage): void {
      if (reachable.has(current.id)) return;
      reachable.add(current.id);
      for (const artifact of current.produces) downstreamProduced.add(artifact);
      for (const next of downstream.get(current.id)!) visit(next);
    }
    for (const next of downstream.get(stage.id)!) visit(next);
    for (const artifact of stage.invalidated_by) {
      if (stage.produces.includes(artifact) || downstreamProduced.has(artifact))
        throw new Error(`${stage.id}.invalidated_by: ${artifact} is produced by this stage or a downstream stage`);
    }
    for (const checkId of stage.requires) {
      const check = checkById.get(checkId)!;
      if (downstreamProduced.has(check.on))
        throw new Error(`${stage.id}.requires: check ${check.id} on ${check.on} is produced by a downstream stage`);
    }
  }
}

/** Parse and validate a frozen process/0.1 definition before aggregation. */
export function loadProcess(text: string, thresholds: Obj): ProcessDefinition {
  const thresholdMaturities = validateThresholds(thresholds);
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`YAML: ${document.errors.map(error => error.message).join('; ')}`);
  const root = object(document.toJS(), 'process');
  if (root.schema !== 'process/0.1') throw new Error('schema: expected process/0.1');
  const artifacts = strings(root.artifacts, 'artifacts');
  const artifactIds = new Set(artifacts);
  const stages: Stage[] = list(root.stages, 'stages').map((raw, i) => {
    const x = object(raw, `stages[${i}]`);
    return {
      id: string(x.id, `stages[${i}].id`),
      needs: strings(x.needs, `stages[${i}].needs`, true),
      when: condition(x.when, `stages[${i}].when`),
      produces: strings(x.produces, `stages[${i}].produces`, true),
      requires: strings(x.requires, `stages[${i}].requires`, true),
      gates: strings(x.gates, `stages[${i}].gates`, true),
      invalidated_by: strings(x.invalidated_by, `stages[${i}].invalidated_by`, true),
      source: source(x.source, `stages[${i}].source`),
    };
  });
  const checks: Check[] = list(root.checks, 'checks').map((raw, i) => {
    const x = object(raw, `checks[${i}]`);
    return {
      id: string(x.id, `checks[${i}].id`),
      ...(x.label === undefined ? {} : { label: string(x.label, `checks[${i}].label`) }),
      when: condition(x.when, `checks[${i}].when`),
      observe: string(x.observe, `checks[${i}].observe`),
      on: string(x.on, `checks[${i}].on`),
      scope: choice(x.scope, ['edit', 'build', 'play', 'client'], `checks[${i}].scope`),
      rule: string(x.rule, `checks[${i}].rule`),
      severity: choice(x.severity, ['blocking', 'warning', 'advisory'], `checks[${i}].severity`),
      maturity: choice(x.maturity, ['candidate', 'tested', 'accepted', 'deprecated'], `checks[${i}].maturity`),
      source: source(x.source, `checks[${i}].source`),
      // Validate every metadata key but keep only the ones written in the source: defaults must not change the
      // parsed definition, whose JSON is hashed into ImportReport.processHash.
      ...explicitMeta(x, knowledgeMeta(x, `checks[${i}]`)),
    };
  });
  const gates: Gate[] = list(root.gates, 'gates').map((raw, i) => {
    const x = object(raw, `gates[${i}]`);
    return {
      id: string(x.id, `gates[${i}].id`),
      kind: choice(x.kind, ['approve', 'choose', 'do'], `gates[${i}].kind`),
      binds: string(x.binds, `gates[${i}].binds`),
      ...(x.selection === undefined ? {} : { selection: choice(x.selection, ['face-candidate'] as const, `gates[${i}].selection`) }),
      ...(x.when === undefined ? {} : { when: condition(x.when, `gates[${i}].when`) }),
      ...(x.review === undefined ? {} : { review: choice(x.review, ['face-output'] as const, `gates[${i}].review`) }),
      ...(x.preview === undefined ? {} : { preview: choice(x.preview, ['recolor-candidates'] as const, `gates[${i}].preview`) }),
      source: source(x.source, `gates[${i}].source`),
    };
  });
  const milestones: Milestone[] = list(root.milestones, 'milestones').map((raw, i) => {
    const x = object(raw, `milestones[${i}]`);
    const required = x.requires_stages === undefined || x.requires_stages === 'all'
      ? x.requires_stages as 'all' | undefined
      : strings(x.requires_stages, `milestones[${i}].requires_stages`);
    return {
      id: string(x.id, `milestones[${i}].id`),
      after: x.after === undefined ? undefined : string(x.after, `milestones[${i}].after`),
      requires_stages: required,
      evidence_on: x.evidence_on === undefined ? undefined : string(x.evidence_on, `milestones[${i}].evidence_on`),
      gates: strings(x.gates, `milestones[${i}].gates`, true),
    };
  });
  const stageIds = uniqueIds(stages, 'stages');
  const checkIds = uniqueIds(checks, 'checks');
  const gateIds = uniqueIds(gates, 'gates');
  const milestoneIds = uniqueIds(milestones, 'milestones');
  for (const stage of stages) {
    refs(stage.needs, stageIds, `${stage.id}.needs`);
    refs(stage.requires, checkIds, `${stage.id}.requires`);
    refs(stage.gates, gateIds, `${stage.id}.gates`);
    refs(stage.produces, artifactIds, `${stage.id}.produces`);
    refs(stage.invalidated_by, artifactIds, `${stage.id}.invalidated_by`);
  }
  for (const check of checks) {
    refs([check.on], artifactIds, `${check.id}.on`);
    // A rule the evaluator cannot parse would record `error` forever once frozen into a Workflow; reject it at load time.
    const parsed = tryParseRule(check.rule);
    if (parsed.error) throw new Error(`${check.id}: ${parsed.error}`);
    if (check.severity !== 'advisory' && (check.kind === 'hypothesis' || check.kind === 'case'))
      throw new Error(`${check.id}: ${check.kind} check cannot be blocking or warning`);
    if (check.maturity !== 'accepted' && check.severity !== 'advisory')
      throw new Error(`${check.id}: only accepted checks may be blocking or warning`);
    for (const match of check.rule.matchAll(T_REF)) {
      const path = match[1]!;
      const threshold = thresholdMaturities.get(path);
      if (!threshold) throw new Error(`${check.id}: undefined threshold t.${path}`);
      if (check.severity !== 'advisory' && (threshold.kind === 'hypothesis' || threshold.kind === 'case'))
        throw new Error(`${check.id}: ${check.severity} check cannot reference ${threshold.kind} threshold t.${path}`);
      if (check.severity !== 'advisory' && threshold.maturity !== 'accepted')
        throw new Error(`${check.id}: ${check.severity} check requires accepted threshold t.${path} (found ${threshold.maturity})`);
    }
  }
  for (const gate of gates) {
    refs([gate.binds], artifactIds, `${gate.id}.binds`);
    if (gate.selection && gate.kind !== 'choose') throw new Error(`${gate.id}.selection requires a choose gate`);
    if (gate.review && (gate.kind !== 'approve' || gate.selection || gate.binds !== 'face')) throw new Error(`${gate.id}.review requires an approve gate bound to face`);
  }
  for (const milestone of milestones) {
    if (milestone.after) refs([milestone.after], milestoneIds, `${milestone.id}.after`);
    if (Array.isArray(milestone.requires_stages)) refs(milestone.requires_stages, stageIds, `${milestone.id}.requires_stages`);
    if (milestone.evidence_on) refs([milestone.evidence_on], artifactIds, `${milestone.id}.evidence_on`);
    refs(milestone.gates, gateIds, `${milestone.id}.gates`);
  }
  noCycle(stages.map(stage => ({ id: stage.id, edges: stage.needs })), 'needs');
  validateProducerFeedback(stages, checks);
  noCycle(milestones.map(milestone => ({ id: milestone.id, edges: milestone.after ? [milestone.after] : [] })), 'after');
  return {
    schema: 'process/0.1', id: string(root.id, 'id'), version: string(root.version, 'version'),
    applies_to: object(root.applies_to, 'applies_to'), artifacts, stages, checks, gates, milestones,
  };
}

type AnyRecord = Record<string, any>;

/**
 * Canonicalize a process definition for comparisons across loader generations.
 *
 * Workflows persist the parsed definition, so older snapshots can contain the
 * loader's explicit nulls or default metadata while a current load omits those
 * values.  Keep every value that changes process behavior and remove only
 * representation-level differences.  This is intentionally separate from
 * loadProcess: process hashes and newly frozen snapshots retain their existing
 * shape.
 */
export function normalizeProcessDefinition(value: ProcessDefinition): AnyRecord {
  // JSON.stringify omits undefined object keys but preserves explicit nulls,
  // while a live loader result can still have them (notably verification.at).
  // Remove only object properties; array elements remain in place so this
  // cannot turn a malformed list into a different valid list.
  const clean = (raw: unknown): unknown => {
    if (Array.isArray(raw)) return raw.map(clean);
    if (raw !== null && typeof raw === 'object') {
      return Object.fromEntries(Object.entries(raw as AnyRecord)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, clean(item)]));
    }
    return raw;
  };
  const item = clean(value) as AnyRecord;
  const optional = (raw: unknown): unknown => raw === null || raw === undefined ? undefined : raw;
  const list = (raw: unknown): unknown[] => raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [{ __invalid_process_list_value__: raw }];
  const records = (raw: unknown): AnyRecord[] => list(raw).map(item => item as AnyRecord);
  const put = (target: AnyRecord, key: string, raw: unknown): void => {
    const normalized = optional(raw);
    if (normalized !== undefined) target[key] = normalized;
  };
  const stages = records(item.stages).map(raw => {
    const result: AnyRecord = {
      id: raw.id, needs: list(raw.needs), produces: list(raw.produces), requires: list(raw.requires),
      gates: list(raw.gates), invalidated_by: list(raw.invalidated_by),
    };
    put(result, 'when', raw.when); put(result, 'source', raw.source);
    return result;
  });
  const checks = records(item.checks).map(raw => {
    // A human-facing label changes presentation, never acceptance or the stage-tool adoption contract.
    // Frozen process bytes still retain it for display and provenance; semantic comparison deliberately omits it.
    const result: AnyRecord = { id: raw.id, observe: raw.observe, on: raw.on, scope: raw.scope,
      rule: raw.rule, severity: raw.severity, maturity: raw.maturity };
    put(result, 'when', raw.when); put(result, 'source', raw.source);
    // These are the defaults applied by knowledgeMeta. Older frozen records
    // may have persisted them, while current definitions keep absent keys out.
    if (raw.kind !== undefined && raw.kind !== null && raw.kind !== 'spec') result.kind = raw.kind;
    put(result, 'asserted_by', raw.asserted_by); put(result, 'source_id', raw.source_id);
    put(result, 'applies_to', raw.applies_to); put(result, 'environment', raw.environment);
    put(result, 'recorded_at', raw.recorded_at);
    if (Array.isArray(raw.verification) && raw.verification.length) result.verification = raw.verification.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const normalized = { ...(entry as AnyRecord) };
      // at is an optional timestamp, unlike values inside open metadata maps.
      if (normalized.at === null) delete normalized.at;
      return normalized;
    });
    if (raw.visibility !== undefined && raw.visibility !== null && raw.visibility !== 'local') result.visibility = raw.visibility;
    if (raw.validity !== undefined && raw.validity !== null && raw.validity !== 'unknown') result.validity = raw.validity;
    put(result, 'supersedes', raw.supersedes);
    return result;
  });
  const gates = records(item.gates).map(raw => {
    const result: AnyRecord = { id: raw.id, kind: raw.kind, binds: raw.binds };
    put(result, 'selection', raw.selection); put(result, 'when', raw.when); put(result, 'review', raw.review); put(result, 'source', raw.source);
    return result;
  });
  const milestones = records(item.milestones).map(raw => {
    const result: AnyRecord = { id: raw.id, gates: list(raw.gates) };
    put(result, 'after', raw.after); put(result, 'requires_stages', raw.requires_stages); put(result, 'evidence_on', raw.evidence_on);
    return result;
  });
  return { schema: item.schema, id: item.id, version: item.version, applies_to: item.applies_to,
    artifacts: list(item.artifacts), stages, checks, gates, milestones };
}

export function sameProcessDefinition(left: ProcessDefinition, right: ProcessDefinition): boolean {
  return canonicalJson(normalizeProcessDefinition(left)) === canonicalJson(normalizeProcessDefinition(right));
}

export function sameProcessGates(left: ProcessDefinition['gates'], right: ProcessDefinition['gates']): boolean {
  const wrap = (gates: ProcessDefinition['gates']): ProcessDefinition => ({ schema: 'process/0.1', id: '', version: '', applies_to: {},
    artifacts: [], stages: [], checks: [], gates, milestones: [] });
  return canonicalJson(normalizeProcessDefinition(wrap(left)).gates) === canonicalJson(normalizeProcessDefinition(wrap(right)).gates);
}
