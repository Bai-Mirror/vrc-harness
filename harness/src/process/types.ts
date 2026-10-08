export type Scope = 'edit' | 'build' | 'play' | 'client';
export type Severity = 'blocking' | 'warning' | 'advisory';
export type Maturity = 'candidate' | 'tested' | 'accepted' | 'deprecated';
export type VerdictResult = 'pass' | 'violation' | 'no_data' | 'undecidable' | 'error' | 'not_applicable';
export type StageStatus = 'waiting' | 'not_applicable' | 'open' | 'blocked' | 'passed';
import type { KnowledgeMeta } from './knowledge-meta.ts';

export interface Stage {
  id: string;
  needs: string[];
  when?: string;
  produces: string[];
  requires: string[];
  gates: string[];
  invalidated_by: string[];
  source?: string;
}

export interface Check extends Partial<KnowledgeMeta> {
  id: string;
  /** Optional human-facing name supplied by the process author; it is presentation only. */
  label?: string;
  when?: string;
  observe: string;
  on: string;
  scope: Scope;
  rule: string;
  severity: Severity;
  maturity: Maturity;
  source?: string;
}

export interface Gate {
  id: string;
  kind: 'approve' | 'choose' | 'do';
  binds: string;
  /** Runtime validates and persists the concrete option, independently of the proposing AI. */
  selection?: 'face-candidate';
  /** Optional approved-plan applicability and supervised output preview confirmation. */
  when?: string;
  review?: 'face-output';
  /**
   * A rendered picture set this decision has to show before it may be approved. `face-output` and `selection` carry
   * their own identity and validation; this names a read-only picture set only, so the Gate keeps its plain approval.
   */
  preview?: 'recolor-candidates';
  source?: string;
}

export interface Milestone {
  id: string;
  after?: string;
  requires_stages?: 'all' | string[];
  evidence_on?: string;
  gates: string[];
}

export interface ProcessDefinition {
  schema: 'process/0.1';
  id: string;
  version: string;
  applies_to: Record<string, unknown>;
  artifacts: string[];
  stages: Stage[];
  checks: Check[];
  gates: Gate[];
  milestones: Milestone[];
}

export interface Verdict {
  id: string;
  checkId: string;
  scope: Scope;
  artifactHash: string;
  inputHashes?: Record<string, string>;
  result: VerdictResult;
  /** Required for not_applicable; must name the check's false when expression. */
  basis?: string;
}

export interface GateDecision {
  gateId: string;
  artifactHash: string;
  inputHashes?: Record<string, string>;
  result: 'approved' | 'chosen' | 'done';
  selection?: { schema: string; artifactHash: string; selection?: { candidateId: string }; previewSha256?: string; runId?: string; renderDigest?: string };
}

export interface WarningAcceptance {
  verdictId: string;
}

export interface StageCompletion {
  stageId: string;
  /** Fingerprints captured when the stage was completed, at least for invalidated_by. */
  artifactHashes: Record<string, string>;
}

export interface OutOfBoundsChange {
  stageId: string;
  artifact: string;
  /** An explicit confirmation closes this exception without changing the Run record. */
  accepted?: boolean;
}

export interface AggregateInput {
  artifactHashes: Record<string, string>;
  plan: Record<string, unknown>;
  verdicts: Verdict[];
  gateDecisions: GateDecision[];
  warningAcceptances: WarningAcceptance[];
  completions: StageCompletion[];
  outOfBoundsChanges: OutOfBoundsChange[];
}

export interface StageResult {
  status: StageStatus;
  reasons: string[];
  /** Parallel to reasons; additive detail for runtime decisions. */
  reasonCodes?: StageReasonCode[];
}

export type StageReasonCode =
  | 'needs_unmet' | 'out_of_bounds' | 'not_applicable' | 'missing_verdict'
  | 'stale_verdict' | 'check_failed' | 'warning_unaccepted' | 'gate_pending'
  | 'completion_missing' | 'completion_invalidated';

export interface MilestoneResult {
  status: 'reached' | 'not_reached';
  reasons: string[];
}

export interface AggregateResult {
  stages: Record<string, StageResult>;
  milestones: Record<string, MilestoneResult>;
}
