import type { Verdict } from '../process/types.ts';
import type { ChangeEvidence } from '../exec/git-scan.ts';

/** `network`: the model service could not be reached or was unavailable (reported by the pi adapter); the Run fails. */
export type ErrorClass = 'auth' | 'rate_limit' | 'timeout' | 'protocol' | 'tool_failure' | 'verifier_failure' | 'permission_denied'
  | 'network';
export interface RunSpec {
  runId: string;
  taskId: string;
  workflowId: string;
  projectId: string;
  stageId: string;
  attempt: number;
  /** Stable across retries of start for this Run; adapters must deduplicate it. */
  idempotencyKey: string;
  expectedOutputs: string[];
  /** Immutable Runtime snapshot, also supplied during replay, collection and independent verification. */
  inputSnapshot?: import('../workflow/inputs.ts').RunInputSnapshot;
  /** Absolute project paths authorized by a CLI Task. Undefined preserves generic Run behavior. */
  allowedWrites?: string[];
}
export interface RunHandle { ref: string }
export type Observation = { state: 'running' } | { state: 'exited' } | { state: 'unknown' };
export interface RunResult {
  /** Runtime readback of a newly produced plan. Assigned by finish(), never trusted from the executor. */
  runtimeObservedPlan?: Record<string, unknown>;
  /** Supervisor's structured exit; exitStatus remains for v0.1 scheduler compatibility. */
  exit?: import('../exec/run-supervisor.ts').ExitStatus;
  exitStatus: number;
  errorClass?: ErrorClass;
  /** True only when an independent check established that timeout caused no side effects. */
  noSideEffects?: boolean;
  /** Unity tool failure may retry within the Task's declared retry limit. */
  retryable?: boolean;
  unitySteps?: import('../exec/unity-steps.ts').UnityEvidence[];
  /** Supervised deterministic preparation, recorded only from the Runtime's completed unit. */
  prepare?: { status: 'finished'; exitStatus: number; errorClass?: ErrorClass; outOfBoundsPaths: string[] };
  errorMessage?: string;
  retryAfter?: string;
  outputs: Record<string, string>;
  /** Workspace paths changed outside this Run's project, from an independent git scan. */
  outOfBoundsPaths?: string[];
  /** Runtime-owned digests of image lists present when supervised render steps completed. */
  previewDigests?: Record<string, string>;
  /** Render states derived from the frozen outfit record when the recolour Run ended. */
  previewStates?: string[];
  /** A controlled failure while collecting render-complete evidence. */
  previewEvidenceError?: string;
  scanEvidence?: ChangeEvidence[];
  /** Changes outside the project observed during the Run; attribution is not claimed. */
  externalChanges?: ChangeEvidence[];
}
export interface Executor {
  /** Optional external resource check before a Run is reserved; taskId names the Task asking. */
  canDispatch?(resource: string, taskId?: string): boolean;
  start(spec: RunSpec): Promise<RunHandle> | RunHandle;
  observe(handle: RunHandle): Promise<Observation> | Observation;
  cancel(handle: RunHandle): Promise<'confirmed' | 'not_confirmed'> | 'confirmed' | 'not_confirmed';
  confirmNeverStarted?(runId: string): boolean;
  /** Exit status the unit recorded, if any; a source of evidence only, never proof that the unit stopped. */
  recordedExitStatus?(runId: string): number | undefined;
  collect(handle: RunHandle): Promise<RunResult> | RunResult;
}
export interface Verifier {
  verify(spec: RunSpec, result: RunResult, artifactHashes: Record<string, string>): Promise<Verdict[]> | Verdict[];
  /** Confirm that external verification for this Run has stopped before cancellation. */
  cancel?(spec: RunSpec): Promise<'confirmed' | 'not_confirmed'> | 'confirmed' | 'not_confirmed';
}
export interface Fingerprinter {
  /** A missing kind is omitted. Hashes are observations, not Provider claims. */
  fingerprint(workflowId: string, kinds: string[], heartbeat?: () => void): Promise<Record<string, string>> | Record<string, string>;
  /** Which members changed since the version last recorded for the kind, when member lists are kept. */
  changeOf?(workflowId: string, kind: string): { added: string[]; removed: string[]; modified: string[] } | undefined;
  /** Independently classified new Unity metadata inside this Run's frozen managed write scope. */
  managedChangeOf?(workflowId: string, kind: string): boolean;
  /** A new version of the kind was recorded: keep its member list for the next comparison. */
  recorded?(workflowId: string, kind: string): void;
  /** The kind is still at its recorded version: keep its member list if none is kept yet. */
  unchanged?(workflowId: string, kind: string): void;
}
