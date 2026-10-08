import type { ProcessDefinition } from '../process/types.ts';
import { fileURLToPath } from 'node:url';

export type ProjectKind = 'client' | 'private' | 'history' | 'sample';
export type AssessmentStatus = 'verified' | 'claimed' | 'unknown' | 'not_applicable';
export type ReviewStatus = 'pass' | 'fail' | 'unknown' | 'not_run';
export interface Source { source: string; detail: string }
export interface LedgerItem {
  id: string; text: string; status: 'open' | 'done' | 'dropped' | 'in_progress' | 'unknown';
  source: string; sources: string[]; archived: boolean; raw: string; modifiedMs?: number;
  latestNote?: Source; relatedProjects?: string[];
}
export interface TimelineItem {
  title: string; actor: string; date: string; source: string;
  fields: Record<string, string>; raw: string;
}
export interface Review { id: string; status: ReviewStatus; reason: string; evidence: Source[];
  missingClaims?: Source[]; needsVerification?: Source[];
  archiveDetails?: { path: string; size: number; modified: string; status: ReviewStatus; reason: string }[] }
export interface StageAssessment { id: string; status: AssessmentStatus; evidence: Source[]; weakEvidence?: boolean }
export interface PendingDecision extends Source { id: string; time?: string; question: string; choice: string; starred: boolean }
export interface RelatedProgram { name: string; phase?: string; recent?: string; time?: string; mentions: number; source: string;
  mentionSources?: { source: string; count: number }[] }
export interface ImportReport {
  schema: 'import/0.1'; id: string; projectId: string; processId: string; processVersion: string; processHash: string;
  generated_from?: { harness_version: string; knowledge_version: string; interpretation_hash: string };
  workspacePath: string; projectPath: string;
  identity: { kind: ProjectKind; orderNumber?: string; unityVersion?: string; packages: Record<string, string>; base?: string };
  stateHeader: { fields: Record<string, string | string[]>; source?: string; raw?: string; time?: string };
  timeline: { count: number; recent: TimelineItem[] }; unparsedRecords: Source[];
  ledger: LedgerItem[]; ledgerDecisions: Source[]; externalLedger: LedgerItem[]; relatedLedger?: LedgerItem[];
  pendingDecisions?: PendingDecision[]; relatedPrograms?: RelatedProgram[]; timelineDecisionCount?: number;
  git: { commits: string[]; changes: string[]; reason?: string; latestCommitAt?: string };
  runningProcesses: string[];
  fingerprint: string;
  snapshotSampledFiles: string[];
  reviews: Review[]; stages: StageAssessment[];
  gaps: Source[]; blockers: Source[]; nextSteps: Source[];
  snapshotHash: string;
}
export interface ImportConfig {
  recordNames: string[]; ledgerNames: string[]; historicalDir: string;
  externalLedgerDirs: string[]; externalLedgerFiles: string[]; aliasGroups?: Record<string, string[]>; metaPrograms?: string[];
  decisionTitlePatterns: string[]; sampleNames: string[];
  decisionTables?: { glob: string; columns: { id: string; project: string; question: string; choice: string; answer: string; time?: string; flag?: string } }[];
  projectAliases?: string[];
  /** All known project names and aliases, keyed by project directory name. */
  knownProjects?: Record<string, string[]>;
  clientPattern: string; privatePattern: string;
  ignoredSnapshotDirs: string[];
  /** Files larger than this many bytes use metadata and 1 MiB samples at both ends. */
  snapshotSampleThresholdBytes: number;
  /** Maximum archive size for 7z t, in bytes. Omit for no limit. */
  maxDeliveryArchiveBytes?: number;
  /** Tool scripts live here, outside the project. Missing tools are reported, never passed. */
  toolRoot?: string;
  /** Explicit locked-version baseline. An absent baseline is not a passing comparison. */
  packageBaseline?: Record<string, string>;
  /** Frozen locked versions keyed by project directory name. */
  packageBaselineByProject?: Record<string, Record<string, string>>;
  /** Relative project paths that must not survive in a delivery project. */
  forbiddenDeliveryPaths: string[];
  /** Prefixes of unquoted project-relative artifact paths accepted in affirmative record lines. */
  artifactPathPrefixes: string[];
  deliveryArchives?: string[];
  /** External archive and delivery directories searched after project and workspace. */
  exportRoots?: string[];
  /** Known body names to match as whole terms in project records. */
  knownBodies?: string[];
  /** Stage-specific proof rules. No rule means unknown unless explicit non-applicability is recorded. */
  stageRules?: Record<string, {
    claimPatterns?: string[]; notApplicablePatterns?: string[];
    /** Project-relative file or directory globs; existence is weak claimed evidence. */
    documentPatterns?: string[];
    /** Each named review must pass; stages with zero review IDs cannot be verified. */
    verificationIds?: string[];
  }>;
  recentTimelineCount: number;
}
export const DEFAULT_IMPORT_CONFIG: ImportConfig = {
  recordNames: ['_施工记录.md', '施工记录.md'], ledgerNames: ['_任务账本.md'],
  historicalDir: '_历史工程', externalLedgerDirs: ['_长程任务_*'],
  externalLedgerFiles: ['账本*.md', '停滞项_*.md', '待问用户*.md'], decisionTitlePatterns: ['拍板'],
  sampleNames: [], metaPrograms: [], decisionTables: [],
  clientPattern: '^COMM-([0-9a-fA-F]{8})_.+$', privatePattern: '^([^_]+)_([^_]+)_([0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$',
  ignoredSnapshotDirs: ['Library', 'Temp', 'Logs'],
  snapshotSampleThresholdBytes: 64 * 1024 * 1024,
  // Without a configuration, the tools that ship in the built-in pack (the old workspace toolkit is archived).
  toolRoot: fileURLToPath(new URL('../../builtin/tools/', import.meta.url)),
  forbiddenDeliveryPaths: ['Assets/AvatarAudit', 'Assets/Editor/AvatarAudit', 'Assets/ZZZ_GeneratedAssets', 'Packages/nadena.dev.ndmf/__Generated'],
  artifactPathPrefixes: ['Assets/', 'Packages/'],
  recentTimelineCount: 3,
};
export interface ImportOptions {
  workspacePath: string; projectPath: string; definition: ProcessDefinition;
  config?: Partial<ImportConfig>; kind?: ProjectKind;
  generatedFrom?: ImportReport['generated_from'];
  /** Optional test hook, called after observation and before final snapshot. */
  beforeCommit?: () => void;
}
