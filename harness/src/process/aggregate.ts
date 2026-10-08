import type {
  AggregateInput, AggregateResult, Check, Gate, GateDecision, MilestoneResult,
  ProcessDefinition, Stage, StageResult, Verdict,
} from './types.ts';
import type { StageReasonCode } from './types.ts';
import { evidenceFresh, evidenceInputHashes } from './evidence.ts';

function stageResult(status: StageResult['status'], reasons: string[], codes: StageReasonCode[]): StageResult {
  return { status, reasons, reasonCodes: codes };
}

function checkCode(issue: string): StageReasonCode {
  if (issue.includes('missing verdict')) return 'missing_verdict';
  if (issue.includes('stale verdict')) return 'stale_verdict';
  if (issue.includes('warning not accepted')) return 'warning_unaccepted';
  return 'check_failed';
}

/** Truth of a `plan.<path>` condition, optionally negated with `!`: a missing or empty value is false. */
export function planValue(plan: Record<string, unknown>, expression: string): boolean {
  const [test, expected] = expression.replace(/^!/, '').split(' == ');
  const path = test!.slice('plan.'.length).split('.');
  let value: unknown = plan;
  for (const part of path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return expression.startsWith('!');
    value = (value as Record<string, unknown>)[part];
  }
  const nonempty = expected !== undefined ? value === JSON.parse(expected) : Array.isArray(value) ? value.length > 0
    : value !== null && typeof value === 'object' ? Object.keys(value).length > 0
    : !!value;
  return expression.startsWith('!') ? !nonempty : nonempty;
}

function latest<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i]!)) return items[i];
  return undefined;
}

/** A skipped optional producer has no required output. Approved plan changes still invalidate its consumers. */
export function activeInvalidations(definition: ProcessDefinition, stage: Stage, plan: Record<string, unknown>): string[] {
  return stage.invalidated_by.filter(artifact => {
    const producers = definition.stages.filter(item => item.produces.includes(artifact));
    return !producers.length || producers.some(item => !item.when || planValue(plan, item.when));
  });
}

function verdictIssue(definition: ProcessDefinition, check: Check, input: AggregateInput, evidenceOnly = false): string | undefined {
  if (check.maturity === 'deprecated') return undefined;
  const applicable = !check.when || planValue(input.plan, check.when);
  if (evidenceOnly && !applicable) return undefined;
  const verdict = latest(input.verdicts, item => item.checkId === check.id);
  if (!verdict) return `check ${check.id}: missing verdict`;
  if (verdict.scope !== check.scope) return `check ${check.id}: scope ${verdict.scope} differs from ${check.scope}`;
  const expectedHash = applicable ? input.artifactHashes[check.on] : input.artifactHashes.plan;
  if (!evidenceFresh(verdict.artifactHash, expectedHash, verdict.inputHashes,
    evidenceInputHashes(definition, { checkId: check.id }, input.artifactHashes))) return `check ${check.id}: stale verdict`;
  if (!applicable) {
    if (verdict.result === 'not_applicable' && verdict.basis === check.when) return undefined;
    return `check ${check.id}: false when requires a plan-bound not_applicable verdict with basis`;
  }
  if (verdict.result === 'pass') return undefined;
  if (!evidenceOnly && check.severity === 'warning' &&
      input.warningAcceptances.some(event => event.verdictId === verdict.id)) return undefined;
  return `check ${check.id}: ${verdict.result}${check.severity === 'warning' && !evidenceOnly ? '; warning not accepted' : ''}`;
}

/**
 * Whether this check's current reading is exactly the warning the aggregate reports as `warning_unaccepted`: a warning
 * whose evidence stands against the current version, has not passed, and has no acceptance bound to this very reading.
 * A client offering "accept this warning" has to use this same judgement — a check that does not apply, is stale,
 * belongs to another scope, or already passed is not acceptable, and re-deriving that in the interface drifted from
 * the Runtime once already (a blocking failure and a valid `not_applicable` both got an accept control that was refused).
 */
export function warningUnaccepted(definition: ProcessDefinition, check: Check, input: AggregateInput): boolean {
  const issue = verdictIssue(definition, check, input);
  return Boolean(issue && checkCode(issue) === 'warning_unaccepted');
}

function gateIssue(definition: ProcessDefinition, gate: Gate, input: AggregateInput): string | undefined {
  if (gate.when && !planValue(input.plan, gate.when)) return undefined;
  const decision: GateDecision | undefined = latest(input.gateDecisions, item => item.gateId === gate.id);
  if (!decision) return `gate ${gate.id}: undecided`;
  if (!evidenceFresh(decision.artifactHash, input.artifactHashes[gate.binds], decision.inputHashes,
    evidenceInputHashes(definition, { gateId: gate.id }, input.artifactHashes)))
    return `gate ${gate.id}: stale decision`;
  const expected = gate.kind === 'approve' ? 'approved' : gate.kind === 'choose' ? 'chosen' : 'done';
  if (decision.result !== expected) return `gate ${gate.id}: expected ${expected}`;
  if (gate.selection && (decision.selection?.schema !== 'face-gate-choice/0.1' || decision.selection.artifactHash !== decision.artifactHash ||
      typeof decision.selection.selection?.candidateId !== 'string' || !decision.selection.selection.candidateId)) return `gate ${gate.id}: concrete selection missing`;
  if (gate.review && (decision.selection?.schema !== 'face-output-acceptance/0.1' || decision.selection.artifactHash !== decision.artifactHash ||
      !/^[a-f0-9]{64}$/.test(decision.selection.previewSha256 ?? ''))) return `gate ${gate.id}: actual preview confirmation missing`;
  const recolorPreview = gate.preview === 'recolor-candidates' || (gate.id === 'recolor_approval' && gate.binds === 'materials');
  if (recolorPreview && (decision.selection?.schema !== 'recolor-preview-acceptance/0.1' ||
      decision.selection.artifactHash !== decision.artifactHash || !/^[a-f0-9]{64}$/.test(decision.selection.previewSha256 ?? '') ||
      !decision.selection.runId || !decision.selection.renderDigest))
    return `gate ${gate.id}: recolour preview confirmation missing`;
  return undefined;
}

/** Derive all states from one immutable snapshot. Record order is chronological (newest last). */
export function aggregateProcess(definition: ProcessDefinition, input: AggregateInput): AggregateResult {
  const checks = new Map(definition.checks.map(check => [check.id, check]));
  const gates = new Map(definition.gates.map(gate => [gate.id, gate]));
  const stages = new Map(definition.stages.map(stage => [stage.id, stage]));
  const milestoneDefs = new Map(definition.milestones.map(milestone => [milestone.id, milestone]));
  const stageResults: Record<string, StageResult> = {};
  const milestoneResults: Record<string, MilestoneResult> = {};

  function stageState(id: string): StageResult {
    if (stageResults[id]) return stageResults[id];
    const stage = stages.get(id)!;
    const unmet = stage.needs.filter(need => {
      const status = stageState(need).status;
      return status !== 'passed' && status !== 'not_applicable';
    });
    if (unmet.length) return stageResults[id] = stageResult('waiting', unmet.map(need => `needs ${need}: not satisfied`), unmet.map(() => 'needs_unmet'));
    const outOfBounds = input.outOfBoundsChanges
      .filter(change => change.stageId === id && !stage.produces.includes(change.artifact) && !change.accepted)
      .map(change => `out-of-bounds change: ${change.artifact}`);
    if (outOfBounds.length) return stageResults[id] = stageResult('blocked', outOfBounds, outOfBounds.map(() => 'out_of_bounds'));
    if (stage.when && !planValue(input.plan, stage.when))
      return stageResults[id] = stageResult('not_applicable', [`when ${stage.when} is false in plan`], ['not_applicable']);
    const reasons: string[] = [];
    const codes: StageReasonCode[] = [];
    for (const id of stage.requires) {
      const check = checks.get(id)!;
      if (check.severity === 'advisory' || check.maturity === 'deprecated') continue;
      const issue = verdictIssue(definition, check, input);
      if (issue) { reasons.push(issue); codes.push(checkCode(issue)); }
    }
    for (const id of stage.gates) {
      const issue = gateIssue(definition, gates.get(id)!, input);
      if (issue) { reasons.push(issue); codes.push('gate_pending'); }
    }
    if (reasons.length) return stageResults[id] = stageResult('blocked', reasons, codes);
    const completion = latest(input.completions, item => item.stageId === id);
    if (!completion) return stageResults[id] = stageResult('open', ['stage completion missing'], ['completion_missing']);
    const stale = activeInvalidations(definition, stage, input.plan).filter(artifact =>
      !input.artifactHashes[artifact] || completion.artifactHashes[artifact] !== input.artifactHashes[artifact]);
    if (stale.length) return stageResults[id] = stageResult('open', stale.map(artifact => `completion invalidated by ${artifact}`), stale.map(() => 'completion_invalidated'));
    return stageResults[id] = stageResult('passed', [], []);
  }

  function milestoneState(id: string): MilestoneResult {
    if (milestoneResults[id]) return milestoneResults[id];
    const milestone = milestoneDefs.get(id)!;
    const reasons: string[] = [];
    if (milestone.after && milestoneState(milestone.after).status !== 'reached')
      reasons.push(`after ${milestone.after}: not reached`);
    const required = milestone.requires_stages === 'all'
      ? definition.stages.map(stage => stage.id)
      : milestone.requires_stages ?? [];
    for (const stageId of required) {
      const status = stageState(stageId).status;
      if (status !== 'passed' && status !== 'not_applicable') reasons.push(`stage ${stageId}: ${status}`);
    }
    if (milestone.evidence_on) {
      for (const check of definition.checks) {
        if (check.on !== milestone.evidence_on || check.severity !== 'blocking' || check.maturity === 'deprecated') continue;
        const issue = verdictIssue(definition, check, input, true);
        if (issue) reasons.push(issue);
      }
    }
    for (const id of milestone.gates) {
      const issue = gateIssue(definition, gates.get(id)!, input);
      if (issue) reasons.push(issue);
    }
    return milestoneResults[id] = { status: reasons.length ? 'not_reached' : 'reached', reasons };
  }

  for (const stage of definition.stages) stageState(stage.id);
  for (const milestone of definition.milestones) milestoneState(milestone.id);
  return { stages: stageResults, milestones: milestoneResults };
}
