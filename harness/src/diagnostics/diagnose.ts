import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { release } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LocalConfig } from '../config.ts';
import { hostPlatform } from '../host-platform.ts';
import { harnessVersion, knowledgeVersion, packageVersion } from '../provenance.ts';
import { SCHEMA_VERSION } from '../state/db.ts';
import { aggregateWorkflow } from '../state/aggregate-input.ts';
import type { ProcessDefinition } from '../process/types.ts';
import { packOfToolRoot } from '../archive/packs.ts';
import { poolDirectory } from '../booth/pool.ts';
import { projectRoot } from '../archive/takeover.ts';
import { diagnosticRoots, readPrivacyWords, redactPath, redactText, sensitiveHits, withinRoot,
  type LocalRoot, type PrivacyWord } from './redact.ts';
import { readZip, safeMemberPath, tailBytes, writeZip, type ZipEntry } from './zip.ts';

/**
 * The project diagnostics bundle (D-133, minimal version): what a person hands to support so a product problem or a
 * product limit can be located. It is compiled from evidence this Runtime already wrote -- Run results, check verdicts,
 * Gate decisions, events, import receipts -- plus windows of the logs those Runs left. It is produced locally, never
 * uploaded, and every member is scanned again after packing; a credential in the result means no package at all.
 *
 * Minimal version, and nothing beyond it: no TUI entry, no prompt or image material, no finer classification than the
 * five categories, no connection to the contribution queue (D-127, dev.1.1). Public entry points are
 * `avh project diagnose` and the Runtime methods `project.diagnostics.preview` / `project.diagnostics.export`.
 *
 * What it never carries (D-133, D-111, 实施合同 §4.6): material originals, `*.unitypackage`, textures, models, keys,
 * tokens, BOOTH login state, signing material, prompts, Provider replies, conversation text, screenshots and renders.
 */

export const DIAGNOSTICS_SCHEMA = 'harness-diagnostics/0.1';
export const DIAGNOSTICS_REPORT_PATH = 'report.md';
export const DIAGNOSTICS_DOCUMENT_PATH = 'diagnostics.json';
/** How many bytes of evidence one bundle may hold before the lower-priority attachments are dropped. */
export const DIAGNOSTICS_BUDGET_BYTES = 20 * 1024 * 1024;
/** One attachment's own ceiling: a log travels as a window or a tail, never whole. */
const ATTACHMENT_LIMIT_BYTES = 512 * 1024;
/** Lines kept before and after a Unity error or warning line. */
const LOG_WINDOW_AROUND = 12;
/** A line worth anchoring a window on, and the narrower subset that is an error rather than a warning (R28 P2-3). */
const HOT_LINE = /\b(?:error|exception|warning|failed|failure|missing|unable to|could not)\b/i;
const ERROR_LINE = /\b(?:error|exception|failed|failure|missing|unable to|could not)\b/i;
/** Room for the zip headers and the digits a size changes as the budget is applied, so the reservation stays an upper bound. */
const ZIP_SLACK_BYTES = 4096;
const MAX_RUNS = 120;
const MAX_ISSUES = 400;
const MAX_EVENTS = 2000;
const MAX_MESSAGE_CHARS = 300;
/**
 * How long one document field may be (R28 2nd round). The budget reserves whatever the report and the machine document
 * weigh, so a single record field of arbitrary length could otherwise be the whole package: every string that reaches
 * either document is cut here, and the cut is counted into `totals.truncated`.
 */
const MAX_DOCUMENT_TEXT_CHARS = 2000;
/** How many observation files one Run contributes before that Run's remaining files are left unread (R28 2nd round). */
const MAX_OBSERVATION_FILES_PER_RUN = 40;
/** The fixed sentence the report and the machine document carry about what the timeline does and does not hold. */
const TIMELINE_WHITELIST_NOTE = '时间线只保留动作、时间与关联对象（任务／关口／Run）；事件里的自由文本——用户的重做意见、'
  + '关口批准或驳回的说明、提醒接受说明、恢复说明等——不随包出端。';
/**
 * The payload fields an event may contribute (R28 P1-1). Only the Runtime's own facts are named here, so a user's
 * quote, a Provider's reply and a tool's returned text cannot leave inside the timeline even when a new producer
 * starts recording them; an unnamed field is dropped rather than trusted.
 *
 * The `reason` column is a separate matter (R28 2nd round, second attempt). It is *not* on the timeline whitelist: the
 * column holds a Runtime sentence for some events and the person's own words for others, and the same row cannot say
 * which. An audit of the producers that put a person's text there found five paths, not one:
 *   - `task-cli.ts` `taskRedo` -> `human/requested_redo`, reason = the redo note (the case R28 reproduced);
 *   - `task-cli.ts` `gateDecide` -> `human/gate approved|rejected`, reason = the person's note;
 *   - `workflow/runtime.ts` `acceptWarning` -> `human/warning accepted`, reason = the acceptance note;
 *   - `task-cli.ts` `taskRecover` -> `human/run recovered_*`, reason = the recovery note;
 *   - the same recovery/redo note also lands in a `runtime`-actor task transition, because `taskRecover` and a
 *     `taskRedo` on a BLOCKED task call `transitionTask(..., note)` (`runtime/transitions.ts`), whose event has
 *     `actor='runtime'` and the note in `reason`.
 * Keying the cut on `actor='human'` therefore still leaked; the projection drops the column for every event.
 */
const EVENT_PAYLOAD_FIELDS = new Set([
  'schema', 'provider', 'requestedModel', 'model', 'attempt', 'stageId', 'taskId', 'runId', 'checkId', 'gateId',
  'workflowId', 'entityId', 'exitStatus', 'exitCode', 'errorClass', 'retryAfter', 'timedOut', 'runStatus', 'taskStatus',
  'status', 'result', 'decision', 'kind', 'mode', 'role', 'count', 'bytes', 'files', 'members', 'artifactHash',
  'contentHash', 'sha256', 'digest', 'selected', 'slot', 'unity', 'version', 'processRef',
]);

export type DiagnosticCategory = 'product_defect' | 'environment' | 'material' | 'requirement_decision' | 'known_limitation';
export type DiagnosticKind = 'failure' | 'blocked' | 'warning';
/** Only the runs and readings a bundle describes, so the attachment budget can be applied. */
type AttachmentCategory = 'environment' | 'run-reading' | 'check-reading' | 'log-window' | 'log-tail' | 'record' | 'server-log';

/** The Chinese name of each category; the report and the machine document both use these words. */
export const CATEGORY_TEXT: Record<DiagnosticCategory, string> = {
  product_defect: '产品缺陷', environment: '环境', material: '素材', requirement_decision: '需求决定',
  known_limitation: '已知限制命中',
};
/**
 * What each ErrorClass a Run can record means for where the problem lies. This is the "归类依据现有字段": no new
 * criterion is invented, and every reading stays visible next to the suggestion (the report says so).
 */
const ERROR_CLASS_CATEGORY: Record<string, { category: DiagnosticCategory; why: string }> = {
  tool_failure: { category: 'product_defect', why: '确定性工具非零退出：工具的输入或实现可能有问题' },
  protocol: { category: 'product_defect', why: 'Provider 协议解析失败：Harness 与执行方的接口可能变了' },
  verifier_failure: { category: 'product_defect', why: '独立观测或判据本身失败，没有形成结论' },
  network: { category: 'environment', why: '与 Provider 的连接中断：本机网络或服务端可达性' },
  timeout: { category: 'environment', why: '执行超时：机器负载、配额或任务规模' },
  rate_limit: { category: 'environment', why: 'Provider 限流：账号配额或并发' },
  auth: { category: 'environment', why: 'Provider 登录失效或缺失' },
  permission_denied: { category: 'environment', why: '本机权限不足（沙箱、文件访问或签名）' },
};
const categoryForErrorClass = (errorClass: string | null): { category: DiagnosticCategory; why: string } =>
  disabled('AVH_DIAGNOSTICS_NO_CLASSIFY') ? { category: 'product_defect', why: '未做归类（测试开关）' }
  : (errorClass ? ERROR_CLASS_CATEGORY[errorClass] : undefined)
  ?? { category: 'product_defect', why: errorClass ? `未归类的错误类别 ${errorClass}：需要人看` : 'Run 失败但没有记下错误类别' };
/** A verdict that did not pass. `not_applicable` is the plan's own statement that a check does not apply: a limit. */
function categoryForVerdict(result: string): { category: DiagnosticCategory; why: string } {
  if (disabled('AVH_DIAGNOSTICS_NO_CLASSIFY')) return { category: 'product_defect', why: '未做归类（测试开关）' };
  if (result === 'no_data') return { category: 'material', why: '判据没有拿到读数：观测对象缺失或不可读' };
  if (result === 'not_applicable') return { category: 'known_limitation', why: '计划声明这一项不适用，已记录限制' };
  if (result === 'undecidable') return { category: 'requirement_decision', why: '读数不足以判定：需要人或更高一级判据' };
  if (result === 'error') return { category: 'product_defect', why: '判据没有得出结论（规则或观测本身失败）' };
  // A violation is the reading itself: the product does what it was told and the reading does not meet the criterion,
  // so what has to change is the plan, the input or the criterion -- not a tool that crashed.
  return { category: 'requirement_decision', why: `判据结果为 ${result}：产物与判据不符，要改的是计划、输入或判据本身` };
}

export interface DiagnosticIssue {
  kind: DiagnosticKind;
  category: DiagnosticCategory;
  /** The sentence a person reads. */
  text: string;
  stageId: string | null;
  /** The check's id as the process definition spells it, and its Chinese name when the definition carries one. */
  checkId: string | null;
  checkLabel: string | null;
  runId: string | null;
  taskId: string | null;
  /** What was read: verdict result, error class, exit status, Gate decision, review status. */
  reading: Record<string, unknown>;
  /** Why the category was suggested, in the words the report repeats. */
  basis: string;
  at: string | null;
  /** Where the evidence for this issue sits inside the bundle. */
  attachments: string[];
}
export interface DiagnosticStage {
  id: string; label: string; status: 'done' | 'current' | 'pending' | 'blocked';
  taskStatus: string | null;
  /** The Runtime aggregator's own verdict for this stage and its reason codes (R28 P1-4), never a local guess. */
  aggregateStatus: string | null;
  reasons: string[];
  reasonCodes: string[];
  checks: Array<{ id: string; label: string; result: string; accepted: boolean; at: string }>;
}
export interface DiagnosticWorkflow {
  id: string; status: string; profile: string | null; knowledgeVersion: string;
  pack: { id: string; version: string; channel: string; contentHash: string } | null;
  frozenTools: { count: number; digest: string; sample: Array<{ path: string; sha256: string }> };
  stages: DiagnosticStage[]; furthestStage: string | null; blockedAt: string | null; blockedWhy: string | null;
}
/** The frozen tool hashes of every Workflow of this project, so the bundle names each one's digest and cap count. */
export interface DiagnosticWorkflowTools {
  workflowId: string; status: string; profile: string | null; current: boolean;
  toolCount: number; toolDigest: string; knowledgeVersion: string;
}
export interface DiagnosticAttachment {
  path: string; category: AttachmentCategory; reason: string;
  /** The source file's size, and how much of it the bundle carries. */
  bytes: number; keptBytes: number;
  included: boolean;
  excludedBecause?: string;
  /** What this member had to leave out, in the words `report.md` repeats under 「截断了什么」. */
  truncation?: string;
  redactions: Array<{ id: string; count: number }>;
  /** The redacted bytes, ready to pack. Not part of the document: `machineDocument` publishes the fields above. */
  buffer: Buffer;
}
/** A whole class of content the bundle never carries, named so a reader knows what was left out on purpose. */
export interface DiagnosticPolicyExclusion { category: string; what: string; why: string }
export interface DiagnosticsPlan {
  schema: typeof DIAGNOSTICS_SCHEMA;
  generatedAt: string;
  project: { id: string; name: string; path: string; hasOrderNumber: boolean };
  since: string | null;
  workflow: DiagnosticWorkflow | null;
  workflowCount: number;
  /** One line per Workflow: its frozen tool hash digest, so a bundle covers every Workflow, not only the newest. */
  workflowTools: DiagnosticWorkflowTools[];
  issues: DiagnosticIssue[];
  /**
   * The event timeline, as a sequence of actions rather than a text log (R28 2nd round): `at`, `actor`, `action` and the
   * object the event names. The event's own `reason` column is never copied -- see `TIMELINE_WHITELIST_NOTE` -- so the
   * field is present only under the anti-fix switch that reproduces the leak it replaced.
   */
  timeline: Array<{ at: string; actor: string; action: string; entityType: string; entityId: string; workflowId: string | null;
    reason?: string; payload: Record<string, unknown> }>;
  environment: Record<string, unknown>;
  /** Every member the bundle can hold, with the reason it is in and what was redacted out of it. */
  items: DiagnosticAttachment[];
  /** What was left out even though it exists on this machine, and why. */
  excluded: DiagnosticAttachment[];
  /** Categories the format refuses as a whole. */
  policy: DiagnosticPolicyExclusion[];
  /** One line per Run, successful or not (D-133's 逐 Run 摘要). */
  runs: Array<{ id: string; stageId: string; attempt: number; status: string; taskStatus: string; provider: string | null;
    errorClass: string | null; exitStatus: number | null; at: string | null }>;
  totals: { included: number; keptBytes: number; sourcesBytes: number; excluded: number; dropped: number; redactions: number; truncated: string[] };
  /** What the size budget reserved and what the pack is estimated to weigh: the two documents and the zip headers. */
  budget: { limitBytes: number; reservedBytes: number; attachmentBudgetBytes: number; estimatedPackageBytes: number };
  /**
   * Every member the pack will hold, with its size and content hash (R28 P1-3). A caller previews this, then passes
   * `manifestDigest` back on export; a recompile that produces different members is refused rather than shipped.
   */
  manifest: Array<{ path: string; bytes: number; sha256: string }>;
  manifestDigest: string;
  /** Anything the compiler had to approximate, in the words a reader needs. */
  warnings: string[];
  privacyWords: { path: string; applied: number; problems: string[] };
  /** Hash of the report and document this preview described; an export must reproduce them. */
  digest: string;
}

/** Where the exporting caller records `avh doctor`'s output, so the bundle can carry it without running it here. */
export const DOCTOR_READING_FILE = 'state/doctor.txt';
export const doctorReadingPath = (home: string): string => join(home, ...DOCTOR_READING_FILE.split('/'));

/** Where the caller's environment lives: what the Runtime knows but the state database does not. */
export interface DiagnosticsEnvironment {
  home: string;
  /** The installed build's commit, when the caller knows it (`AVH_BUILD_COMMIT` semantics belong to the CLI). */
  commit?: string;
  /**
   * `avh doctor`'s output to attach. The exporter writes it to `doctorReadingPath(home)` before exporting, because a
   * doctor run in this process would be a side effect in a preview and would block the Runtime's event loop.
   */
  doctorOutput?: string;
  /** A service log to take a window from; defaults to `<AVH_HOME>/state/service.log`. */
  serverLog?: string;
}
/** Read the doctor reading the exporting caller wrote, if it is there. Never a reason to fail an export. */
export function readDoctorReading(home: string): string | undefined {
  const path = doctorReadingPath(home);
  try { const text = readFileSync(path, 'utf8'); return text.trim() ? text : undefined; }
  catch { return undefined; }
}
export interface DiagnosticsPreviewOptions {
  since?: string;
  env?: DiagnosticsEnvironment;
  /**
   * Pin the compile instant. A preview hands its `generatedAt` and `manifestDigest` to the export, so the two compiles
   * describe the same bundle: without it the report's own timestamp would differ and no manifest could ever match.
   */
  generatedAt?: string;
  /** Progress for a caller watching a long export from a terminal or a GUI. Phases: compile, pack, scan, write. */
  onProgress?: (progress: { phase: string; done?: number; total?: number }) => void;
}
export interface DiagnosticsExportOptions extends DiagnosticsPreviewOptions {
  /** Directory the bundle goes into; created when missing. */
  out: string;
  name?: string;
  /**
   * The `manifestDigest` of the preview this export was confirmed against (R28 P1-3). Recompiling is unavoidable --
   * the export is a separate process from the preview -- so the compile is checked against the confirmed manifest and
   * refused when anything moved in between.
   */
  expect?: string;
}
export interface DiagnosticsExportResult {
  status: 'exported' | 'refused';
  plan: DiagnosticsPlan;
  package?: { path: string; bytes: number; sha256: string; members: number };
  /** The reason an export did not write anything; present only when the export was refused. */
  refusal?: { code: 'credential' | 'content_changed' | 'over_budget'; reason: string;
    members: Array<{ path: string; detectors: string[] }> };
}

/**
 * Test-only switches, read per call. They exist so the anti-fix verification can turn one mechanism off and prove the
 * test on the real path fails without it: nothing in the product sets them, they are not part of any request, and the
 * default is always the shipped behaviour. Naming them here is the point -- a mutation the reviewer cannot reproduce
 * is not evidence.
 *
 * They are honoured only under Node's test runner, which sets NODE_TEST_CONTEXT for each test file's process (or runs
 * the files in-process with --test). A shipped build never runs that way, so a variable left in someone's environment
 * cannot switch redaction or the post-export scan off.
 */
const underTestRunner = Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');
export const diagnosticsTestSwitchesHonoured = (): boolean => underTestRunner;
const disabled = (name: 'AVH_DIAGNOSTICS_NO_REDACTION' | 'AVH_DIAGNOSTICS_NO_RESCAN' | 'AVH_DIAGNOSTICS_NO_CLASSIFY'
  | 'AVH_DIAGNOSTICS_NO_PROJECTION' | 'AVH_DIAGNOSTICS_NO_METADATA_REDACTION' | 'AVH_DIAGNOSTICS_NO_MANIFEST_BINDING'
  | 'AVH_DIAGNOSTICS_NO_AGGREGATE' | 'AVH_DIAGNOSTICS_NO_TIMELINE_TEXT' | 'AVH_DIAGNOSTICS_LATEST_MODE_FOR_RUNS'
  | 'AVH_DIAGNOSTICS_NO_DOCUMENT_CAP' | 'AVH_DIAGNOSTICS_GLOBAL_OBSERVATION_LIMIT'): boolean =>
  underTestRunner && (process.env[name] === '1' || process.env[name] === 'true');
/**
 * The size budget. `AVH_DIAGNOSTICS_BUDGET_BYTES` lowers it so a test can reach the drop path without writing twenty
 * megabytes; nothing in the product sets it, and a non-positive or unparseable value is ignored rather than disabling
 * the limit.
 */
function budgetBytes(): number {
  const configured = Number(process.env.AVH_DIAGNOSTICS_BUDGET_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DIAGNOSTICS_BUDGET_BYTES;
}

const POLICY: DiagnosticPolicyExclusion[] = [
  { category: 'material', what: '素材原件、贴图、模型与 *.unitypackage', why: '属于厂商与用户的财产，体积与用途都不属于故障定位' },
  { category: 'credential', what: '密钥、访问令牌、签名材料、BOOTH 登录会话', why: '任何情况下都不出端（D-111、实施合同 §4.6）' },
  { category: 'prompt', what: '提示词原文、Provider 回复原文、对话原文', why: '属于私人内容，且可能含客户身份' },
  { category: 'image', what: '截图、渲染图与预览图', why: '最小版不收录图像；完整版另行授权（dev.1.1）' },
  { category: 'source', what: '工程文件本身（Assets、ProjectSettings、Packages 的内容）', why: '诊断包按已选字段新建，不复制工程' },
];

const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const rowsOf = <T>(db: DatabaseSync, sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...(params as never[])) as T[];
/** The zip records this writer adds for `count` members: a local header, a central record, and the end record. */
const zipOverhead = (count: number): number => 22 + count * (76 + 80);
/**
 * Cut every string a document carries to `max` characters (R28 2nd round). A record field of arbitrary length -- a
 * project name, an error message, an event sentence -- must not be able to make the report itself the whole package;
 * the caller counts the cuts so 「截断了什么」 can name how many fields were cut. Buffers are bytes and keep their
 * identity, exactly as in `deepRedact`.
 */
function capStrings(value: unknown, max: number, onCut: () => void, depth = 0): unknown {
  if (typeof value === 'string') { if (value.length <= max) return value; onCut(); return `${value.slice(0, max - 1)}…`; }
  if (Buffer.isBuffer(value)) return value;
  if (depth > 8 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => capStrings(item, max, onCut, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capStrings(item, max, onCut, depth + 1)]));
}
/**
 * Every string in a whole document through the redactor, whatever field it sits in (R28 P1-2). Buffers are bytes and
 * keep their identity, so an attachment's content is not rebuilt by this pass.
 */
function deepRedact(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (disabled('AVH_DIAGNOSTICS_NO_METADATA_REDACTION')) return value;
  if (depth > 8) return value;
  if (typeof value === 'string') return redact(value);
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(item => deepRedact(item, redact, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepRedact(item, redact, depth + 1)]));
  return value;
}
/**
 * An event payload projected onto the fields a bundle may carry (R28 P1-1): the Runtime's own facts, and nothing else.
 * A field whose name is not in the whitelist is dropped rather than copied, so a user's quote, a Provider's reply or a
 * tool's returned text cannot reach the timeline by being put in a payload.
 */
function eventPayload(value: unknown, redact: (text: string) => string, depth = 0): Record<string, unknown> {
  if (depth > 3 || !value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!EVENT_PAYLOAD_FIELDS.has(key)) continue;
    if (typeof item === 'string') out[key] = redact(clip(item, MAX_MESSAGE_CHARS));
    else if (typeof item === 'number' || typeof item === 'boolean' || item === null) out[key] = item;
    else if (Array.isArray(item)) out[key] = item.filter(entry => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean')
      .map(entry => typeof entry === 'string' ? redact(clip(entry, MAX_MESSAGE_CHARS)) : entry).slice(0, 50);
    else out[key] = eventPayload(item, redact, depth + 1);
  }
  return out;
}
/** The pre-projection behaviour, kept only so the anti-fix switch can reproduce the leak it replaces (R28 P1-1). */
function redactValue(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, redact, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, redact, depth + 1)]));
  return value;
}
/** A Run's recorded result; a malformed one is reported as malformed rather than read as success. */
function parseResult(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try { const value = JSON.parse(json) as unknown; return value && typeof value === 'object' ? value as Record<string, unknown> : { malformed: true }; }
  catch { return { malformed: true }; }
}

interface CheckDoc { id: string; label?: string; severity?: string; scope?: string; observe?: string; rule?: string; maturity?: string }
interface StageDoc { id: string; label?: string; needs?: string[]; produces?: string[]; gates?: string[]; requires?: string[];
  /** `provider` | `tool` | `none`, from the stage capabilities: what decides whether a Run's stdout is a model reply. */
  mode?: string }
interface Definitions { checks: Map<string, CheckDoc>; stages: Map<string, StageDoc>; order: string[] }
/**
 * The check and stage vocabulary the Workflow froze: ids and rules from the process definition, with the Chinese labels
 * a process author supplied (`Check.label`, presentation only). A check without a label keeps its id as its name; the
 * report never invents one, and it never re-orders the definition's own stage order.
 */
function definitionsOf(definitionJson: string | null, capabilitiesJson: string | null): Definitions {
  const checks = new Map<string, CheckDoc>(), stages = new Map<string, StageDoc>();
  let definition: { checks?: CheckDoc[]; stages?: StageDoc[] } = {};
  try { if (definitionJson) definition = JSON.parse(definitionJson) as typeof definition; }
  catch { definition = {}; }
  for (const check of definition.checks ?? []) checks.set(check.id, check);
  for (const stage of definition.stages ?? []) stages.set(stage.id, stage);
  try {
    const manifest = JSON.parse(capabilitiesJson ?? '{}') as { checks?: CheckDoc[]; stages?: Record<string, StageDoc> };
    for (const check of manifest.checks ?? []) checks.set(check.id, { ...(checks.get(check.id) ?? { id: check.id }), ...check });
    for (const [id, stage] of Object.entries(manifest.stages ?? {})) stages.set(id, { ...(stages.get(id) ?? { id }), ...stage });
  } catch { /* the definition stays the fallback; a broken manifest shows up as a frozen-file warning elsewhere */ }
  return { checks, stages, order: (definition.stages ?? []).map(stage => stage.id) };
}
const checkName = (definitions: Definitions, id: string): string => definitions.checks.get(id)?.label ?? id;
const stageName = (definitions: Definitions, id: string): string => definitions.stages.get(id)?.label ?? id;
/** Which stage a check belongs to: the stage whose `requires` names it. */
function stageOfCheck(definitions: Definitions, checkId: string): string | null {
  for (const id of definitions.order) if ((definitions.stages.get(id)?.requires ?? []).includes(checkId)) return id;
  return null;
}

/** One member of the archive, already redacted and ready to pack. */
interface BundleMember { path: string; bytes: Buffer; category: AttachmentCategory; reason: string }
interface Compiled {
  plan: DiagnosticsPlan;
  report: string;
  document: Record<string, unknown>;
  members: BundleMember[];
}

/**
 * Compile everything the bundle will hold, in memory, before anything is written: the plan a person previews, the
 * report a person reads, the machine document, and each attachment already redacted. An export writes exactly this,
 * and a preview writes nothing at all -- not even a temporary directory.
 */
function compile(db: DatabaseSync, config: LocalConfig, projectId: string, options: DiagnosticsPreviewOptions): Compiled {
  const project = db.prepare(`SELECT p.id, p.path, p.kind, p.identity_json, p.harness_version, p.knowledge_version, w.path AS workspacePath
    FROM project p JOIN workspace w ON w.id = p.workspace_id WHERE p.id = ?`)
    .get(projectId) as { id: string; path: string; kind: string; identity_json: string; harness_version: string;
      knowledge_version: string; workspacePath: string } | undefined;
  if (!project) throw new Error(`项目不存在: ${projectId}`);
  const identity = JSON.parse(project.identity_json) as { orderNumber?: string; name?: string };
  const root = projectRoot(db, projectId);
  const since = options.since && Number.isFinite(Date.parse(options.since)) ? options.since : null;
  const after = (at: string | null): boolean => !since || (at !== null && at >= since);
  const env: DiagnosticsEnvironment = options.env ?? { home: config.home };

  const vocabulary = readPrivacyWords(config.home);
  // `<POOL>` is this installation's downloaded-material store (`booth/pool.ts`); its path names a cache, not a person.
  const poolRoot = poolDirectory(config.home);
  const roots = diagnosticRoots({ project: root, home: config.home, workspaceRoot: project.workspacePath,
    pool: poolRoot, toolRoot: config.toolRoot, knowledgeRoot: config.knowledgeRoot, assetSearchRoots: config.assetSearchRoots });
  const redactOptions = { roots, words: vocabulary.words };
  const redact = (text: string): string => redactText(text, redactOptions).text;
  const warnings: string[] = [], truncated: string[] = [];
  for (const problem of vocabulary.problems) warnings.push(`${problem}（该条已跳过，见 report.md 的脱敏说明）`);

  // ---- Workflows, stages and checks --------------------------------------------------------------------------------
  const workflows = rowsOf<{ id: string; status: string; knowledge_version: string; profile: string | null; tool_root: string;
    capabilities_json: string | null; definition_json: string | null; tools_json: string | null }>(db,
    `SELECT w.id, w.status, w.knowledge_version, d.profile, d.tool_root, d.capabilities_json, d.definition_json, d.tools_json
     FROM workflow w LEFT JOIN workflow_definition d ON d.workflow_id = w.id WHERE w.project_id = ? ORDER BY w.rowid`, projectId);
  const current = workflows.at(-1);
  const definitions = definitionsOf(current?.definition_json ?? null, current?.capabilities_json ?? null);
  // A Run is judged by the capabilities its own Workflow froze, not by the newest one (R28 2nd round): a stage that is
  // a `tool` today may have been a `provider` when that Run was made, and reading today's definition made the older
  // Run's model session look like a tool's stdout.
  const definitionsByWorkflow = new Map(workflows.map(row => [row.id,
    row.id === current?.id ? definitions : definitionsOf(row.definition_json, row.capabilities_json)]));
  const workflow = current ? buildWorkflow(db, current, definitions, warnings) : null;
  if (!workflow) warnings.push('这个项目还没有正式制作流程：诊断包只有环境、项目记录与事件。');

  // ---- Gate decisions ----------------------------------------------------------------------------------------------
  const gates = current ? rowsOf<{ gateId: string; result: string; recordedAt: string; artifactHash: string }>(db,
    `SELECT gate_id AS gateId, result, recorded_at AS recordedAt, artifact_hash AS artifactHash FROM gate_decision
     WHERE workflow_id = ? AND seq IN (SELECT MAX(seq) FROM gate_decision WHERE workflow_id = ? GROUP BY gate_id)`,
    current.id, current.id) : [];

  // ---- Runs --------------------------------------------------------------------------------------------------------
  const runRows = rowsOf<{ id: string; taskId: string; workflowId: string; stageId: string; attempt: number; status: string; provider: string | null;
    resultJson: string | null; taskStatus: string; errorClass: string | null; exitStatus: number | null; errorMessage: string | null; at: string | null }>(db,
    `SELECT r.id, r.task_id AS taskId, t.workflow_id AS workflowId, t.stage_id AS stageId, r.attempt, r.status, r.provider,
       r.result_json AS resultJson, t.status AS taskStatus, json_extract(r.result_json,'$.errorClass') AS errorClass,
       json_extract(r.result_json,'$.exitStatus') AS exitStatus, json_extract(r.result_json,'$.errorMessage') AS errorMessage,
       (SELECT MAX(e.occurred_at) FROM event e WHERE e.entity_type='run' AND e.entity_id=r.id) AS at
     FROM run r JOIN task t ON t.id = r.task_id WHERE t.workflow_id IN (SELECT id FROM workflow WHERE project_id = ?)
     ORDER BY r.rowid DESC LIMIT ?`, projectId, MAX_RUNS);
  if (runRows.length >= MAX_RUNS) truncated.push(`只收录了最近 ${MAX_RUNS} 个 Run 的明细；更早的 Run 只在事件时间线里出现`);

  // ---- The issue list ----------------------------------------------------------------------------------------------
  const issues: DiagnosticIssue[] = [];
  const wanted = new Set<string>();
  const want = (issue: DiagnosticIssue, member: string): void => {
    if (!issue.attachments.includes(member)) issue.attachments.push(member);
    wanted.add(member);
  };
  for (const run of runRows) {
    if (!after(run.at)) continue;
    const failed = run.status === 'exited' && (run.errorClass !== null || (run.exitStatus !== null && run.exitStatus !== 0));
    const blocked = !failed && ['BLOCKED', 'RECOVERY_REQUIRED', 'FAILED', 'WAITING_HUMAN'].includes(run.taskStatus);
    if (!failed && !blocked) continue;
    const classified = failed ? categoryForErrorClass(run.errorClass)
      : { category: 'requirement_decision' as DiagnosticCategory, why: '任务被阻断或等待人工：可能是需求未定、素材未备，或上一次失败留下的核对' };
    const reading = { errorClass: run.errorClass, exitStatus: run.exitStatus, runStatus: run.status, taskStatus: run.taskStatus,
      provider: run.provider, attempt: run.attempt, ...(run.errorMessage ? { errorMessage: redact(clip(run.errorMessage, MAX_MESSAGE_CHARS)) } : {}),
      ...(run.errorClass ? { basis: classified.why } : {}) };
    const issue: DiagnosticIssue = {
      kind: failed ? 'failure' : 'blocked',
      category: classified.category,
      text: `阶段「${stageName(definitions, run.stageId)}」的 ${failed ? 'Run 失败' : `任务停在 ${run.taskStatus}`}：`
        + (failed ? (run.errorClass ? `错误类别 ${run.errorClass}` : `退出码 ${run.exitStatus ?? '未知'}`) : '需要人决定或处理')
        + (run.errorMessage ? `（${redact(clip(run.errorMessage, MAX_MESSAGE_CHARS))}）` : ''),
      stageId: run.stageId, checkId: null, checkLabel: null, runId: run.id, taskId: run.taskId,
      reading, basis: classified.why, at: run.at, attachments: [],
    };
    // A Provider stage writes the model's own session -- prompt turns, tool calls and its reply -- to `stdout.log`
    // (R28 P1-1), so that file never travels: the runtime and error fields above are the reading, and `stderr.log`
    // keeps what the executor reported. A tool stage's stdout is the tool's own output and travels as before.
    // Which of the two this Run is comes from the Workflow that produced it (R28 2nd round): a stage that is a `tool`
    // in the newest Workflow may have been a `provider` for an older Run. Only a stage the Run's own definition names
    // as `tool` has its stdout collected -- when the mode cannot be proven, the stdout is not collected at all.
    const runDefinitions = disabled('AVH_DIAGNOSTICS_LATEST_MODE_FOR_RUNS')
      ? definitions : definitionsByWorkflow.get(run.workflowId) ?? null;
    const stageMode = runDefinitions?.stages.get(run.stageId)?.mode ?? null;
    const skipProviderSession = !disabled('AVH_DIAGNOSTICS_NO_PROJECTION') && stageMode !== 'tool';
    for (const name of ['stderr.log', ...(skipProviderSession ? [] : ['stdout.log']), 'exit.json', 'prepare.json', 'unity-steps.json']) {
      const absolute = join(env.home, 'runs', run.id, name);
      if (existsSync(absolute)) want(issue, `attachments/runs/${run.id}/${name}`);
    }
    // The Unity log itself is reduced to a window around its error lines; one per step, newest first.
    for (const name of unityLogNames(join(env.home, 'runs', run.id))) want(issue, `attachments/runs/${run.id}/${name}`);
    issues.push(issue);
  }

  // A check that did not pass: the verdict is the reading, and its observation files are the attachment.
  const verdictRows = current ? rowsOf<{ id: string; checkId: string; result: string; basis: string | null; recordedAt: string; artifactHash: string; accepted: number }>(db,
    `SELECT v.id, v.check_id AS checkId, v.result, v.basis, v.recorded_at AS recordedAt, v.artifact_hash AS artifactHash,
       EXISTS(SELECT 1 FROM warning_acceptance a WHERE a.workflow_id = v.workflow_id AND a.verdict_id = v.id) AS accepted
     FROM verdict v WHERE v.workflow_id = ? AND v.result <> 'pass'
       AND v.seq IN (SELECT MAX(seq) FROM verdict WHERE workflow_id = ? GROUP BY check_id)`, current.id, current.id) : [];
  // Which Run a verdict belongs to is recorded, not guessed (R28 P2-2): `verdict.id` is `<runId>:<checkId>` and the
  // Run's own result lists `verdictIds`. Picking "the newest Run of the same stage" bound a different Workflow's Run
  // whenever two workflows shared a stage name. No provable link means missing evidence, said out loud.
  const runOfWorkflow = new Map(runRows.map(run => [run.id, run]));
  const runByVerdictId = new Map<string, string>();
  for (const run of runRows) {
    const recorded = parseResult(run.resultJson).verdictIds;
    if (!Array.isArray(recorded)) continue;
    for (const id of recorded) if (typeof id === 'string' && !runByVerdictId.has(id)) runByVerdictId.set(id, run.id);
  }
  const boundRun = (verdict: { id: string; checkId: string }): { runId: string | null; how: string } => {
    const recorded = runByVerdictId.get(verdict.id);
    if (recorded) return { runId: recorded, how: 'run.result_json.verdictIds' };
    const split = verdict.id.lastIndexOf(':');
    if (split > 0 && verdict.id.slice(split + 1) === verdict.checkId && runOfWorkflow.has(verdict.id.slice(0, split)))
      return { runId: verdict.id.slice(0, split), how: 'verdict.id' };
    return { runId: null, how: 'unproven' };
  };
  for (const verdict of verdictRows) {
    if (!after(verdict.recordedAt)) continue;
    const classified = categoryForVerdict(verdict.result);
    const severity = definitions.checks.get(verdict.checkId)?.severity ?? 'blocking';
    const stageId = stageOfCheck(definitions, verdict.checkId);
    const bound = boundRun(verdict);
    const runId = bound.runId;
    const issue: DiagnosticIssue = {
      kind: verdict.result === 'not_applicable' || severity === 'warning' ? 'warning' : 'blocked',
      category: classified.category,
      text: `判据「${checkName(definitions, verdict.checkId)}」（${verdict.checkId}）结果为 ${verdict.result}：`
        + redact(clip(verdict.basis ?? '没有记下读数说明', MAX_MESSAGE_CHARS))
        + (runId ? '' : '（缺证：没有记录能把这条判据绑定到某次 Run，没有读取任何 Run 目录）'),
      stageId, checkId: verdict.checkId, checkLabel: checkName(definitions, verdict.checkId), runId, taskId: null,
      reading: { result: verdict.result, basis: verdict.basis ? redact(clip(verdict.basis, MAX_MESSAGE_CHARS)) : null,
        artifactHash: verdict.artifactHash, severity, warningAccepted: Boolean(verdict.accepted),
        runAssociation: bound.how, basis_why: classified.why },
      basis: classified.why, at: verdict.recordedAt, attachments: [],
    };
    if (runId) for (const member of observationMembers(definitions, env.home, runId, verdict.checkId)) want(issue, member);
    issues.push(issue);
  }

  // A Gate decision is not a defect, but a rejection or a waiting one explains a blockage; the record is the reading.
  // Gate rows carry no event time of their own, so the `--since` window does not apply: the latest decision per gate is
  // always shown, and the issue says which artifact hash it bound.
  const gateDocs = new Map<string, { id: string; kind?: string }>();
  try {
    for (const gate of (JSON.parse(current?.definition_json ?? '{}') as { gates?: Array<{ id: string; kind?: string }> }).gates ?? [])
      gateDocs.set(gate.id, gate);
  } catch { /* the definition may be absent; the id is then the whole name */ }
  for (const gate of gates) {
    issues.push({ kind: 'warning', category: 'requirement_decision',
      text: `关口「${gateDocs.get(gate.gateId)?.id ?? gate.gateId}」的决定为 ${gate.result}（绑定产物 ${gate.artifactHash.slice(0, 12)}）`,
      stageId: stageOfCheck(definitions, gate.gateId), checkId: gate.gateId, checkLabel: null, runId: null, taskId: null,
      reading: { result: gate.result, artifactHash: gate.artifactHash, basis_why: '关口决定由人或运行时代为作出，记录的是决定本身' },
      basis: '关口决定由人或运行时代为作出，记录的是决定本身', at: gate.recordedAt, attachments: [] });
  }

  // Import reviews and missing dependencies: the material category, from the project's own records.
  const reviews = rowsOf<{ id: string; report_json: string; created_at: string }>(db,
    'SELECT id, report_json, created_at FROM import_report WHERE project_id = ? ORDER BY created_at DESC LIMIT 3', projectId);
  for (const report of reviews) {
    let parsed: { reviews?: Array<{ id: string; status: string; reason: string }> } = {};
    try { parsed = JSON.parse(report.report_json) as typeof parsed; }
    catch { warnings.push(`导入报告 ${report.id} 无法解析，其中的复核结论没有进入问题清单`); continue; }
    for (const review of parsed.reviews ?? []) {
      if (review.status !== 'fail' && review.status !== 'unknown') continue;
      if (!after(report.created_at)) continue;
      issues.push({ kind: review.status === 'fail' ? 'blocked' : 'warning', category: 'material',
        text: `导入复核「${review.id}」${review.status === 'fail' ? '未通过' : '无法判定'}：${redact(clip(review.reason, MAX_MESSAGE_CHARS))}`,
        stageId: null, checkId: null, checkLabel: null, runId: null, taskId: null,
        reading: { review: review.id, status: review.status, reportId: report.id,
          basis_why: '导入复核判断素材是否齐备；缺件属于素材来源问题' },
        basis: '导入复核判断素材是否齐备；缺件属于素材来源问题', at: report.created_at, attachments: [] });
    }
  }
  // A completion the Runtime's aggregator no longer accepts: the plan or an upstream artifact moved, so the stage's
  // completion row and a PASSED task are both stale evidence. Reporting that as "done / no issues" was R28 P1-4; the
  // reading here is the aggregator's own reason code, never a local judgement about the completion record.
  for (const stage of workflow?.stages ?? []) {
    if (!stage.reasonCodes.includes('completion_invalidated')) continue;
    issues.push({ kind: 'blocked', category: 'requirement_decision',
      text: `阶段「${stage.label}」的完成证据已失效：${stage.reasons.join('；') || '上游产物已变化'}，完成记录与任务状态都不能再当作已完成`,
      stageId: stage.id, checkId: null, checkLabel: null, runId: null, taskId: null,
      reading: { aggregateStatus: stage.aggregateStatus, reasonCodes: stage.reasonCodes, reasons: stage.reasons,
        stageCompletion: 'invalidated', basis_why: 'Runtime 聚合器判定完成证据失效：方案或上游产物已变化，需要按当前方案重做或重新确认' },
      basis: 'Runtime 聚合器判定完成证据失效：方案或上游产物已变化，需要按当前方案重做或重新确认', at: null, attachments: [] });
  }
  // An observer's notes: a vendor's own omission shows up here and does not block the stage, so the issue list is the
  // only place it can reach a reader (R28 P2-5). The note's own file is the reading; nothing is copied whole. The file
  // limit is per Run, and what it left unread is named in 「截断了什么」 (R28 2nd round): a global counter let the
  // newest Run's files exhaust the budget and silently dropped an older Run's omission.
  const observed = observationNotes(env.home, runRows);
  truncated.push(...observed.truncated);
  for (const note of observed.notes) {
    const issue: DiagnosticIssue = {
      kind: 'warning', category: note.missing ? 'material' : 'known_limitation',
      text: `观测提醒（${note.stageId}）：${redact(clip(note.text, MAX_MESSAGE_CHARS))}`,
      stageId: note.stageId, checkId: note.checkId, checkLabel: checkName(definitions, note.checkId ?? '') || null,
      runId: note.runId, taskId: null,
      reading: { note: redact(clip(note.text, MAX_MESSAGE_CHARS)), source: note.member, observer: note.observer,
        basis_why: note.missing ? '观测记录说某个素材缺失或不可用：属于素材来源问题' : '观测记录的限制说明：属于已知限制' },
      basis: note.missing ? '观测记录说某个素材缺失或不可用：属于素材来源问题' : '观测记录的限制说明：属于已知限制',
      at: null, attachments: [],
    };
    want(issue, note.member);
    issues.push(issue);
  }
  if (issues.length > MAX_ISSUES) { truncated.push(`问题清单只列出前 ${MAX_ISSUES} 条（共 ${issues.length} 条）`); issues.length = MAX_ISSUES; }

  // ---- Timeline ----------------------------------------------------------------------------------------------------
  // Only events that belong to one of this project's workflows (R28 P1-1): a `workflow_id IS NULL` event is how the
  // Runtime records project-level material, and `project-intent.ts` puts a user's own quote in exactly such a payload.
  const projectEvents = disabled('AVH_DIAGNOSTICS_NO_PROJECTION')
    ? 'e.workflow_id IS NULL OR e.workflow_id IN (SELECT id FROM workflow WHERE project_id = ?)'
    : 'e.workflow_id IN (SELECT id FROM workflow WHERE project_id = ?)';
  const eventRows = rowsOf<{ workflowId: string | null; actor: string; entityType: string; entityId: string; action: string; reason: string;
    payload: string; occurredAt: string }>(db,
    `SELECT e.workflow_id AS workflowId, e.actor, e.entity_type AS entityType, e.entity_id AS entityId, e.action, e.reason,
       e.payload_json AS payload, e.occurred_at AS occurredAt FROM event e
     WHERE ${projectEvents}
     ORDER BY e.seq DESC LIMIT ?`, projectId, MAX_EVENTS);
  // The timeline keeps the Runtime's whitelist of fields, and never the `reason` column (R28 2nd round): that column
  // carries a person's own words for some events and a Runtime sentence for others, and one row cannot say which.
  // `entityId` is added because the object an event names is what a reader follows instead of the dropped sentence.
  const timeline = eventRows.filter(event => after(event.occurredAt)).reverse().map(event =>
    ({ at: event.occurredAt, actor: event.actor, action: event.action, entityType: event.entityType,
      entityId: redact(clip(event.entityId, MAX_MESSAGE_CHARS)), workflowId: event.workflowId,
      ...(disabled('AVH_DIAGNOSTICS_NO_TIMELINE_TEXT') ? { reason: redact(event.reason) } : {}),
      payload: (disabled('AVH_DIAGNOSTICS_NO_PROJECTION')
        ? redactValue(parseResult(event.payload), redact)
        : eventPayload(parseResult(event.payload), redact)) as Record<string, unknown> }));
  if (eventRows.length >= MAX_EVENTS) truncated.push(`事件时间线只收录最近 ${MAX_EVENTS} 条；更早的事件不在包里`);

  // ---- Environment and attachments ---------------------------------------------------------------------------------
  const environment = environmentDocument(config, project, workflow, env, warnings);
  const items = collectAttachments(env, wanted, issues, roots, vocabulary.words);
  // The caller records `avh doctor`'s output *before* the preview it belongs to (R28 P1-3), so the preview already
  // names every member the export will pack. The compiler itself never runs doctor: that would be a side effect.
  const doctor = env.doctorOutput ?? readDoctorReading(env.home);
  if (doctor !== undefined) items.push(textItem('attachments/environment/doctor.txt', 'environment', 'avh doctor 的输出', doctor, redactOptions));
  else warnings.push('这次预览没有 avh doctor 的读数：导出前先把它记到 state/doctor.txt，成员清单才是完整的。');
  const serviceLog = env.serverLog ?? join(env.home, 'state', 'service.log');
  if (existsSync(serviceLog)) {
    const item = fileItem(serviceLog, 'attachments/environment/service.log', 'server-log',
      '后台服务日志的尾部（相关时段片段）', redactOptions, 256 * 1024);
    if (item) items.push(item);
    else warnings.push('后台服务日志存在但读取失败，没有收录它的片段。');
  }
  items.push(textItem('attachments/environment/receipts.md', 'record',
    'setup 导入记录、依赖与退役回执、环境锁的摘要（原文不收录）',
    receiptSummary(db, config, projectId, root, redactOptions), redactOptions));
  // A member that had to leave part of its source out says so in the report's own 「截断了什么」 section (R28 P2-3).
  for (const item of items) if (item.truncation) truncated.push(`\`${item.path}\`：${item.truncation}`);

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  // The budget: an error window first (D-133 says so), then the readings, then whole log tails and summaries. Within a
  // priority the smaller member goes first, so what the budget buys is detail rather than one enormous log.
  const priority: Record<AttachmentCategory, number> = { environment: 0, 'log-window': 1, 'run-reading': 2,
    'check-reading': 3, 'log-tail': 4, record: 5, 'server-log': 6 };
  const budget = budgetBytes();
  const ordered = [...items].sort((a, b) => priority[a.category] - priority[b.category] || a.keptBytes - b.keptBytes);
  // A member name and the package name go through the same redactor as the contents (R28 P1-2), so a project name or a
  // Run directory that carries an order number, a private path or a vocabulary word cannot travel in a file name.
  const memberName = new Map<string, string>();
  const redactMember = (path: string): string => {
    const known = memberName.get(path);
    if (known !== undefined) return known;
    const clean = redactPath(path, redactOptions);
    memberName.set(path, clean);
    return clean;
  };
  const rawAttachments = new Map<DiagnosticIssue, string[]>(issues.map(issue => [issue, [...issue.attachments]]));
  /**
   * Assemble the whole bundle from the members that survived the budget: project each path through the redactor, build
   * the report and the machine document, and hash the result. Called twice -- once to measure the fixed overhead, once
   * for the real budget -- so it must not depend on state it mutates.
   */
  const assemble = (keptPaths: Set<string>, droppedCount: number, reservedBytes: number): Compiled => {
    for (const issue of issues) issue.attachments = (rawAttachments.get(issue) ?? []).filter(path => keptPaths.has(path)).map(redactMember);
    const keptItems = items.filter(item => item.included);
    const excludedItems = items.filter(item => !item.included);
    const keptBytes = keptItems.reduce((sum, item) => sum + item.keptBytes, 0);
    const plan: DiagnosticsPlan = {
      schema: DIAGNOSTICS_SCHEMA, generatedAt,
      project: { id: projectId, name: identity.name ?? project.path.split(/[\\/]/).filter(Boolean).pop() ?? projectId,
        path: redactPath(root, redactOptions), hasOrderNumber: Boolean(identity.orderNumber) },
      since, workflow, workflowCount: workflows.length,
      workflowTools: workflows.map(row => {
        const tools = Object.entries(JSON.parse(row.tools_json ?? '{}') as Record<string, string>).sort(([a], [b]) => a.localeCompare(b));
        return { workflowId: row.id, status: row.status, profile: row.profile, current: row.id === current?.id,
          toolCount: tools.length, toolDigest: tools.length ? sha(JSON.stringify(tools)) : '', knowledgeVersion: row.knowledge_version };
      }),
      runs: runRows.map(run => ({ id: run.id, stageId: run.stageId, attempt: run.attempt, status: run.status,
        taskStatus: run.taskStatus, provider: run.provider, errorClass: run.errorClass, exitStatus: run.exitStatus, at: run.at })),
      issues, timeline, environment,
      items: items.map(item => ({ ...item, path: redactMember(item.path) })),
      excluded: excludedItems.map(item => ({ ...item, path: redactMember(item.path) })),
      policy: POLICY,
      totals: { included: keptItems.length, keptBytes, sourcesBytes: items.reduce((sum, item) => sum + item.bytes, 0),
        excluded: excludedItems.length, dropped: droppedCount,
        redactions: keptItems.reduce((sum, item) => sum + item.redactions.reduce((inner, hit) => inner + hit.count, 0), 0),
        truncated },
      budget: { limitBytes: budget, reservedBytes,
        attachmentBudgetBytes: Math.max(0, budget - reservedBytes),
        estimatedPackageBytes: keptBytes + reservedBytes + zipOverhead(keptItems.length + 2) },
      manifest: [], manifestDigest: '', warnings,
      privacyWords: { path: redactPath(vocabulary.path, redactOptions), applied: vocabulary.words.length, problems: vocabulary.problems },
      digest: '',
    };
    // No single record field may be the whole package (R28 2nd round): every string either document carries is cut to
    // the document ceiling first, and the cut is named in 「截断了什么」. The pass is deterministic, so measuring the
    // bundle and packing it apply the same cuts.
    let cappedFields = 0;
    const bounded = disabled('AVH_DIAGNOSTICS_NO_DOCUMENT_CAP')
      ? plan
      : capStrings(plan, MAX_DOCUMENT_TEXT_CHARS, () => cappedFields++) as DiagnosticsPlan;
    if (cappedFields) {
      const note = `文档里有 ${cappedFields} 个字段超过 ${MAX_DOCUMENT_TEXT_CHARS} 字，已截断（报告与机读文档里都是截断后的值）`;
      if (!bounded.totals.truncated.includes(note)) bounded.totals.truncated.push(note);
    }
    // The documents are redacted as wholes as well as field by field: a value added by a future producer cannot bypass
    // the redactor just because its author forgot to call it (R28 P1-2). Buffers are bytes and stay as they are.
    const clean = deepRedact(bounded, redact) as DiagnosticsPlan;
    const report = disabled('AVH_DIAGNOSTICS_NO_METADATA_REDACTION') ? renderReport(clean) : redact(renderReport(clean));
    const document = deepRedact(machineDocument(clean, report), redact) as Record<string, unknown>;
    clean.digest = sha(`${report}\n${JSON.stringify(document)}`);
    const members: BundleMember[] = [
      { path: DIAGNOSTICS_REPORT_PATH, bytes: Buffer.from(report, 'utf8'), category: 'record', reason: '人读的说明' },
      { path: DIAGNOSTICS_DOCUMENT_PATH, bytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8'), category: 'record', reason: '机读版' },
      ...keptItems.map(item => ({ path: redactMember(item.path), bytes: item.buffer, category: item.category, reason: item.reason })),
    ];
    clean.manifest = members.map(member => ({ path: member.path, bytes: member.bytes.length, sha256: sha(member.bytes) }));
    clean.manifestDigest = sha(JSON.stringify(clean.manifest));
    return { plan: clean, report, document, members };
  };

  // The budget counts the whole package, not only the attachments (R28 P2-3): the two documents and the zip headers
  // are always inside it, so they are measured first and reserved before an attachment is kept.
  for (const item of items) { item.included = true; delete item.excludedBecause; }
  const measured = assemble(new Set(items.map(item => item.path)), 0, 0);
  const reservedBytes = Buffer.byteLength(measured.report, 'utf8')
    + Buffer.byteLength(`${JSON.stringify(measured.document, null, 2)}\n`, 'utf8')
    + zipOverhead(items.length + 2) + ZIP_SLACK_BYTES;
  // When the two documents alone already weigh more than the whole limit, no attachment can bring it under: the export
  // measures the packed bytes and refuses rather than write a bundle over the ceiling (R28 2nd round).
  if (reservedBytes > budget) warnings.push(`报告与机读文档自身就要 ${Math.round(reservedBytes / 1024)} KB，`
    + `已超过整包上限 ${Math.round(budget / 1024)} KB：导出会拒绝，不会写出超过上限的包。`);
  const attachmentBudget = Math.max(0, budget - reservedBytes);
  let total = 0, dropped = 0;
  const kept = new Set<string>();
  for (const item of ordered) {
    if (total + item.keptBytes > attachmentBudget) {
      item.included = false;
      item.excludedBecause = `整包 ${Math.round(budget / 1024 / 1024 * 10) / 10} MB 上限（含报告、机读文档与压缩开销）放不下，按优先级丢弃`;
      dropped++;
      continue;
    }
    total += item.keptBytes;
    kept.add(item.path);
  }
  if (dropped) truncated.push(`诊断包达到 ${Math.round(budget / 1024 / 1024 * 10) / 10} MB 上限：${dropped} 个附件按优先级丢弃（错误窗口优先保留）；`
    + `报告、机读文档与压缩开销先占用 ${Math.round(reservedBytes / 1024)} KB`);
  const compiled = assemble(kept, dropped, reservedBytes);
  return compiled;
}

/** The Workflow's own summary: pack, frozen tools, stages, furthest stage and the blockage. */
function buildWorkflow(db: DatabaseSync, current: { id: string; status: string; knowledge_version: string; profile: string | null;
  tool_root: string; capabilities_json: string | null; definition_json: string | null; tools_json: string | null },
  definitions: Definitions, warnings: string[]): DiagnosticWorkflow {
  const pack = packOfToolRoot(current.tool_root);
  const tools = Object.entries(JSON.parse(current.tools_json ?? '{}') as Record<string, string>).sort(([a], [b]) => a.localeCompare(b));
  const completed = new Set(rowsOf<{ stage_id: string }>(db, 'SELECT stage_id FROM stage_completion WHERE workflow_id = ?', current.id).map(row => row.stage_id));
  const tasks = rowsOf<{ stage_id: string; status: string }>(db,
    `SELECT stage_id, status FROM task WHERE workflow_id = ? AND rowid IN (SELECT MAX(rowid) FROM task WHERE workflow_id = ? GROUP BY stage_id)`,
    current.id, current.id);
  const taskOf = new Map(tasks.map(row => [row.stage_id, row.status]));
  const verdicts = rowsOf<{ checkId: string; result: string; recordedAt: string; accepted: number }>(db,
    `SELECT v.check_id AS checkId, v.result, v.recorded_at AS recordedAt,
       EXISTS(SELECT 1 FROM warning_acceptance a WHERE a.workflow_id = v.workflow_id AND a.verdict_id = v.id) AS accepted
     FROM verdict v WHERE v.workflow_id = ? AND v.seq IN (SELECT MAX(seq) FROM verdict WHERE workflow_id = ? GROUP BY check_id)`,
    current.id, current.id);
  // The stage status is the Runtime aggregator's own answer (R28 P1-4), reason codes included: a `stage_completion`
  // row or a `PASSED` task is evidence that can be invalidated by a later plan or artifact, and the aggregator is the
  // one place that decides whether it still holds. Nothing here re-derives "done" from those records.
  let aggregate: Record<string, { status: string; reasons: string[]; reasonCodes: string[] }> = {};
  let aggregated = false;
  try {
    const definition = current.definition_json ? JSON.parse(current.definition_json) as ProcessDefinition : undefined;
    if (definition?.stages?.length && !disabled('AVH_DIAGNOSTICS_NO_AGGREGATE')) {
      for (const [id, stage] of Object.entries(aggregateWorkflow(db, current.id, definition).stages))
        aggregate[id] = { status: stage.status, reasons: stage.reasons, reasonCodes: stage.reasonCodes ?? [] };
      aggregated = true;
    }
  } catch (error) {
    warnings.push(`Runtime 聚合器无法给出 ${current.id} 的阶段状态（${(error as Error).message}）；阶段表退回任务状态，不能当作聚合结论`);
  }
  const stageStatus = (id: string, index: number): DiagnosticStage['status'] => {
    const word = aggregate[id]?.status;
    if (word === 'passed' || word === 'not_applicable') return 'done';
    if (word === 'blocked') return 'blocked';
    if (word === 'open') return 'current';
    if (word === 'waiting') return 'pending';
    // No aggregate: fall back to the records, which is exactly why the warning above says this is not an aggregate.
    const status = taskOf.get(id);
    if (['FAILED', 'BLOCKED', 'RECOVERY_REQUIRED', 'WAITING_HUMAN'].includes(status ?? '')) return 'blocked';
    if (completed.has(id) || status === 'PASSED') return 'done';
    return definitions.order.slice(0, index).every(prior => completed.has(prior) || taskOf.get(prior) === 'PASSED') ? 'current' : 'pending';
  };
  const stages: DiagnosticStage[] = definitions.order.map((id, index) => {
    const aggregatedStage = aggregate[id];
    return { id, label: stageName(definitions, id), status: stageStatus(id, index),
      taskStatus: taskOf.get(id) ?? null,
      aggregateStatus: aggregated ? aggregatedStage?.status ?? null : null,
      reasons: aggregatedStage?.reasons ?? [],
      reasonCodes: aggregatedStage?.reasonCodes ?? [],
      checks: verdicts.filter(row => (definitions.stages.get(id)?.requires ?? []).includes(row.checkId))
        .map(row => ({ id: row.checkId, label: checkName(definitions, row.checkId), result: row.result, accepted: Boolean(row.accepted), at: row.recordedAt })) };
  });
  const furthest = [...stages].reverse().find(stage => stage.status === 'done') ?? null;
  // A blockage is an aggregated `blocked` stage; an invalidated completion is what the aggregator reports as `open`
  // with that reason code, and it is the case R28 P1-4 saw reported as "done / no issues".
  const blocked = stages.find(stage => stage.status === 'blocked')
    ?? stages.find(stage => stage.reasonCodes.includes('completion_invalidated')) ?? null;
  return { id: current.id, status: current.status, profile: current.profile, knowledgeVersion: current.knowledge_version,
    pack: pack ? { id: pack.id, version: pack.version, channel: pack.channel, contentHash: pack.contentHash } : null,
    frozenTools: { count: tools.length, digest: sha(JSON.stringify(tools)), sample: tools.slice(0, 40).map(([path, hash]) => ({ path, sha256: hash })) },
    stages, furthestStage: furthest?.id ?? null, blockedAt: blocked?.id ?? null,
    blockedWhy: blocked ? (blocked.reasons.length ? blocked.reasons.join('；') : `阶段「${blocked.label}」的任务状态为 ${blocked.taskStatus}`) : null };
}

/** The observation files a verdict's readings live in, whether the observer wrote one file or a check directory. */
/**
 * The observation files a verdict's readings live in, whether the observer wrote one file per check or a
 * `checks/observe-<observer>/metrics.json`. The member keeps the whole path under the Run directory, so an observer
 * whose name carries dots and dashes is still addressable inside the bundle.
 */
function observationMembers(definitions: Definitions, home: string, runId: string, checkId: string): string[] {
  const run = join(home, 'runs', runId);
  const observe = definitions.checks.get(checkId)?.observe;
  const candidates = [join(run, 'observations', `${checkId}.json`),
    ...(observe ? [join(run, 'checks', `observe-${observe.replace(/[^A-Za-z0-9_.-]/g, '_')}`, 'metrics.json')] : [])];
  return candidates.filter(absolute => existsSync(absolute))
    .map(absolute => `attachments/runs/${runId}/${relative(run, absolute).split(sep).join('/')}`);
}
/** The Unity and licence logs of one Run directory, which travel as windows rather than whole files. */
function unityLogNames(run: string): string[] {
  try { return readdirSync(run).filter(name => /^unity-\d+\.log$/.test(name) || /Unity\.Licensing\.Client\.log$/.test(name)).sort(); }
  catch { return []; }
}

/** One observation file's own note: where it came from, and whether it names something that is missing. */
interface ObservationNote { runId: string; stageId: string; checkId: string | null; observer: string | null;
  text: string; member: string; missing: boolean }
/** What the observation read produced: the notes, and what the file limit left unread on any Run. */
interface ObservationRead { notes: ObservationNote[]; truncated: string[] }
/** A note that names a missing or unavailable thing is a material problem; anything else is a stated limit. */
const MISSING_IN_NOTE = /(缺|缺少|缺失|找不到|未提供|未随|没有提供|unavailable|missing|not\s+found|not\s+shipped)/i;
/**
 * The `notes` an observer recorded, from every Run of this project (R28 P2-5). A vendor's omission is often a note on
 * an observation that still passes, so the issue list is the only place it can reach a reader. Only the observation
 * files themselves are read, and the note's file travels as the reading -- no run directory is walked beyond these.
 *
 * The file limit is per Run (R28 2nd round). It used to be one counter outside the loop, so a Run with more files than
 * the limit both exhausted the budget and `break outer`-ed past every older Run; an older Run's vendor omission then
 * disappeared from the issue list with no warning. What each Run leaves unread is named so a reader can tell a missing
 * reminder from one that was never looked for; the anti-fix switch restores the single global counter.
 */
function observationNotes(home: string, runs: Array<{ id: string; stageId: string }>,
  limit = MAX_OBSERVATION_FILES_PER_RUN): ObservationRead {
  const notes: ObservationNote[] = [], truncated: string[] = [];
  const global = disabled('AVH_DIAGNOSTICS_GLOBAL_OBSERVATION_LIMIT');
  let total = 0;
  outer: for (const run of runs) {
    const runRoot = join(home, 'runs', run.id);
    const candidates: Array<{ absolute: string; observer: string | null; checkId: string | null }> = [];
    try {
      for (const name of readdirSync(join(runRoot, 'observations')).filter(name => name.endsWith('.json')).sort())
        candidates.push({ absolute: join(runRoot, 'observations', name), observer: null, checkId: name.slice(0, -'.json'.length) });
    } catch { /* no observations directory: nothing to read */ }
    try {
      for (const name of readdirSync(join(runRoot, 'checks')).sort()) {
        const observer = name.startsWith('observe-') ? name.slice('observe-'.length) : null;
        candidates.push({ absolute: join(runRoot, 'checks', name, 'metrics.json'), observer, checkId: null });
      }
    } catch { /* no checks directory: nothing to read */ }
    let files = 0;
    for (const candidate of candidates) {
      const used = global ? total : files;
      if (used >= limit) {
        if (global) { truncated.push(`观测文件总数只读了前 ${limit} 个（全项目计数）；后面的 Run 一个也没有读，缺件提醒可能在其中`); break outer; }
        truncated.push(`Run ${run.id} 的观测文件只读了前 ${limit} 个（还有 ${candidates.length - files} 个未读）：缺件提醒可能在这些文件里`);
        break;
      }
      if (global) total++; else files++;
      let parsed: { schema?: unknown; notes?: unknown };
      try {
        const stat = lstatSync(candidate.absolute);
        if (!stat.isFile() || stat.size > 256 * 1024) continue;
        parsed = JSON.parse(readFileSync(candidate.absolute, 'utf8')) as typeof parsed;
      } catch { continue; }
      if (!Array.isArray(parsed.notes)) continue;
      const member = `attachments/runs/${run.id}/${relative(runRoot, candidate.absolute).split(sep).join('/')}`;
      for (const note of parsed.notes) {
        if (typeof note !== 'string' || !note.trim()) continue;
        notes.push({ runId: run.id, stageId: run.stageId, checkId: candidate.checkId, observer: candidate.observer,
          text: note, member, missing: MISSING_IN_NOTE.test(note) });
      }
    }
  }
  return { notes, truncated };
}

// ---- Attachments ---------------------------------------------------------------------------------------------------

/** The one place redaction is skipped: a test switch, never a request field, and never on by default. */
function redactBytes(text: string, redactOptions: { roots: LocalRoot[]; words: PrivacyWord[] }):
  { text: string; hits: Array<{ id: string; count: number }> } {
  if (disabled('AVH_DIAGNOSTICS_NO_REDACTION')) return { text, hits: [] };
  const redacted = redactText(text, redactOptions);
  return { text: redacted.text, hits: redacted.hits.map(hit => ({ id: hit.id, count: hit.count })) };
}
function textItem(path: string, category: AttachmentCategory, reason: string, text: string,
  redactOptions: { roots: LocalRoot[]; words: PrivacyWord[] }): DiagnosticAttachment {
  const redacted = redactBytes(text, redactOptions);
  const buffer = Buffer.from(redacted.text, 'utf8');
  return { path, category, reason, bytes: buffer.length, keptBytes: buffer.length, included: true, buffer,
    redactions: redacted.hits };
}
/** One file, redacted, cut to the attachment ceiling; undefined when it is not a regular readable file. */
function fileItem(path: string, member: string, category: AttachmentCategory, reason: string,
  redactOptions: { roots: LocalRoot[]; words: PrivacyWord[] }, limit = ATTACHMENT_LIMIT_BYTES): DiagnosticAttachment | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const { bytes, total } = tailBytes(path, limit);
    const redacted = redactBytes(bytes.toString('utf8'), redactOptions);
    const buffer = Buffer.from(redacted.text, 'utf8');
    return { path: member, category, reason: `${reason}${total > bytes.length ? `（原文件 ${total} 字节，只收录尾部）` : ''}`,
      bytes: total, keptBytes: buffer.length, included: true, buffer, redactions: redacted.hits };
  } catch { return undefined; }
}
/** Compress a sorted list of line numbers into `a–b` ranges, for the truncation note. */
function rangesOf(lines: number[]): string[] {
  const ranges: string[] = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    const match = last ? /^(\d+)–(\d+)$/.exec(last) : null;
    if (match && Number(match[2]) + 1 === line) ranges[ranges.length - 1] = `${match[1]}–${line}`;
    else if (last === String(line - 1)) ranges[ranges.length - 1] = `${line - 1}–${line}`;
    else ranges.push(String(line));
  }
  return ranges;
}
/**
 * A Unity log reduced to the lines around its errors and warnings: asset-import noise is where the size is. The window
 * is bounded per file (R28 P2-3): an error is kept before a warning, the last error is kept first, and when the limit
 * is reached the lines that did not fit are named in the header rather than dropped silently. A huge log used to make
 * the window exceed the attachment ceiling and disappear whole -- including the fatal line at the end of it.
 */
function windowItem(path: string, member: string, redactOptions: { roots: LocalRoot[]; words: PrivacyWord[] }):
  DiagnosticAttachment | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    // Unity reports a broken asset as "references a missing texture", an import failure as "Failed to import", and a
    // compile error as "error CS####"; all three are what a reader is looking for, so all three anchor a window.
    const anchors = lines.map((line, index) => ({ index, error: ERROR_LINE.test(line), hot: HOT_LINE.test(line) }))
      .filter(anchor => anchor.hot)
      .map(anchor => ({ index: anchor.index, error: anchor.error }));
    if (!anchors.length) return undefined;
    // Errors newest first, then warnings newest first: the last error and everything failing around it survive a limit.
    const ordered = [...anchors.filter(anchor => anchor.error).reverse(), ...anchors.filter(anchor => !anchor.error).reverse()];
    const keep = new Set<number>(), wanted = new Set<number>();
    let bytes = 0;
    for (const anchor of ordered) {
      const radius = [anchor.index];
      for (let offset = 1; offset <= LOG_WINDOW_AROUND; offset++) {
        if (anchor.index - offset >= 0) radius.push(anchor.index - offset);
        if (anchor.index + offset < lines.length) radius.push(anchor.index + offset);
      }
      for (const at of radius) {
        wanted.add(at);
        if (keep.has(at)) continue;
        const cost = Buffer.byteLength(`${at + 1}: ${lines[at]}\n`, 'utf8');
        if (bytes + cost > ATTACHMENT_LIMIT_BYTES) continue;   // recorded as dropped below, never silently lost
        keep.add(at);
        bytes += cost;
      }
    }
    const orderedLines = [...keep].sort((a, b) => a - b);
    const dropped = [...wanted].filter(at => !keep.has(at));
    const droppedRanges = rangesOf(dropped);
    const droppedText = dropped.length ? `；因限额未收录第 ${droppedRanges.slice(0, 20).join('、')} 行${droppedRanges.length > 20 ? ' 等' : ''}（共 ${dropped.length} 行）` : '';
    const parts = [`# 错误与警告行前后的窗口（共 ${lines.length} 行，命中 ${anchors.length} 行，收录 ${orderedLines.length} 行${droppedText}）`,
      ...orderedLines.map(at => `${at + 1}: ${lines[at]}`)];
    const redacted = redactBytes(parts.join('\n'), redactOptions);
    const buffer = Buffer.from(redacted.text, 'utf8');
    return { path: member, category: 'log-window',
      reason: `Unity 日志的错误与警告窗口（原文件 ${stat.size} 字节，不收录整份${dropped.length ? `，截断 ${dropped.length} 行` : ''}）`,
      ...(dropped.length ? { truncation: `收录第 ${rangesOf(orderedLines).slice(0, 8).join('、')} 行，未收录第 ${droppedRanges.slice(0, 8).join('、')} 行`
        + `${droppedRanges.length > 8 ? ' 等' : ''}（共 ${dropped.length} 行，单附件 512 KB 限额）` } : {}),
      bytes: stat.size, keptBytes: buffer.length, included: true, buffer, redactions: redacted.hits };
  } catch { return undefined; }
}
/**
 * Read every wanted member from the Run directories. Only members this function builds itself are read, and every
 * one of them has to be inside `<AVH_HOME>/runs`; nothing else on the machine is opened for a bundle.
 */
function collectAttachments(env: DiagnosticsEnvironment, wanted: Set<string>, issues: DiagnosticIssue[],
  roots: LocalRoot[], words: PrivacyWord[]): DiagnosticAttachment[] {
  const redactOptions = { roots, words };
  const reason = new Map<string, string>();
  for (const issue of issues) for (const member of issue.attachments) if (!reason.has(member)) reason.set(member, issue.text);
  const out: DiagnosticAttachment[] = [];
  for (const member of [...wanted].sort()) {
    const relative = member.replace(/^attachments\//, '');
    const absolute = join(env.home, ...relative.split('/'));
    if (!withinRoot(absolute, join(env.home, 'runs'))) continue;
    const why = reason.get(member) ?? '这次运行留下的读数';
    const category: AttachmentCategory = member.includes('/checks/') || member.endsWith('metrics.json') || member.includes('/observations/')
      ? 'check-reading' : member.endsWith('exit.json') || member.endsWith('prepare.json') || member.endsWith('unity-steps.json') ? 'run-reading'
      : 'log-tail';
    const item = member.endsWith('.log') && /unity-/i.test(member)
      ? windowItem(absolute, member, redactOptions) ?? fileItem(absolute, member, 'log-tail', why, redactOptions)
      : fileItem(absolute, member, category, why, redactOptions);
    if (item) out.push({ ...item, reason: item.reason || why });
  }
  return out;
}
/**
 * The receipt files a project keeps under its own Harness layer, found by name and checked by schema: a dependency or
 * retirement receipt is a project file, and only whitelisted fields of it are summarised, never copied (R28 P2-5).
 */
function receiptFiles(project: string): string[] {
  const found: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 4 || found.length >= 20) return;
    let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= 20) return;
      if (entry.isDirectory()) visit(join(directory, entry.name), depth + 1);
      else if (entry.isFile() && /-receipt\.json$/.test(entry.name)) found.push(join(directory, entry.name));
    }
  };
  visit(join(project, 'Assets', '_Harness'), 0);
  return found.sort();
}
/**
 * A one-page summary of the receipts this project actually keeps: setup imports, the dependency and retirement
 * receipts, and the environment lock. Every line is a field from a record, never a record's own bytes (R28 P2-5).
 */
function receiptSummary(db: DatabaseSync, config: LocalConfig, projectId: string, project: string,
  redactOptions: { roots: LocalRoot[]; words: PrivacyWord[] }): string {
  const baseline = config.importByProfile?.[config.defaultProfile]?.packageBaseline ?? {};
  const lines = ['# 收到与锁定的摘要', '',
    `- 环境锁的工具链基准：${Object.keys(baseline).length} 项`,
    ...Object.entries(baseline).slice(0, 200).map(([name, version]) => `  - ${name} ${version}`),
    `- 本机工具根：${redactPath(config.toolRoot, redactOptions)}`,
    `- 知识层版本：${knowledgeVersion(config)}`, ''];

  const reports = rowsOf<{ id: string; created_at: string; snapshot_hash: string; report_json: string }>(db,
    'SELECT id, created_at, snapshot_hash, report_json FROM import_report WHERE project_id = ? ORDER BY created_at DESC LIMIT 5', projectId);
  lines.push(`## setup 导入记录（最近 ${reports.length} 次）`, '');
  if (!reports.length) lines.push('- 没有导入记录。');
  for (const report of reports) {
    let parsed: { reviews?: Array<{ id?: unknown; status?: unknown }>; gaps?: unknown[]; blockers?: unknown[] } = {};
    try { parsed = JSON.parse(report.report_json) as typeof parsed; }
    catch { lines.push(`- ${report.id}（${report.created_at}）：报告无法解析，只留下这份记录本身`); continue; }
    const reviews = (parsed.reviews ?? []).filter(review => review && typeof review.status === 'string');
    const countOf = (status: string): number => reviews.filter(review => review.status === status).length;
    const notPassed = reviews.filter(review => review.status === 'fail' || review.status === 'unknown')
      .map(review => `${typeof review.id === 'string' ? review.id : '未命名'}=${String(review.status)}`);
    lines.push(`- ${report.id}（${report.created_at}，快照 ${String(report.snapshot_hash).slice(0, 12)}）：`
      + `复核 ${reviews.length} 条（通过 ${countOf('pass')}、未通过 ${countOf('fail')}、无法判定 ${countOf('unknown')}）；`
      + `缺口 ${(parsed.gaps ?? []).length} 条、阻断 ${(parsed.blockers ?? []).length} 条`
      + (notPassed.length ? `；未通过或无法判定的复核：${notPassed.join('、')}` : ''));
  }

  const files = receiptFiles(project);
  lines.push('', `## 依赖与退役回执（工程里找到 ${files.length} 个）`, '');
  if (!files.length) lines.push('- 没有找到依赖或退役回执。');
  for (const file of files) {
    const named = redactPath(relative(project, file).split(sep).join('/'), redactOptions);
    let receipt: { schema?: unknown; packages?: unknown[]; retired?: unknown[]; pending_retirements?: unknown[]; history?: unknown[] } = {};
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) { lines.push(`- ${named}：文件过大或不是普通文件，只记录它的存在`); continue; }
      receipt = JSON.parse(readFileSync(file, 'utf8')) as typeof receipt;
    } catch { lines.push(`- ${named}：读取失败，只记录它的存在`); continue; }
    if (typeof receipt.schema !== 'string') { lines.push(`- ${named}：没有 schema，未按回执摘要`); continue; }
    const packages = Array.isArray(receipt.packages) ? receipt.packages : [];
    const assets = packages.reduce((sum: number, entry) => sum
      + (Array.isArray((entry as { assets?: unknown[] }).assets) ? (entry as { assets: unknown[] }).assets.length : 0), 0);
    const retired = Array.isArray(receipt.retired) ? receipt.retired as Array<{ path?: unknown; status?: unknown; run_id?: unknown }> : [];
    const pending = Array.isArray(receipt.pending_retirements) ? receipt.pending_retirements.length : 0;
    const last = retired.at(-1);
    lines.push(`- ${named}（${receipt.schema}）：包 ${packages.length} 个、文件 ${assets} 个、退役 ${retired.length} 条、待退役 ${pending} 条、`
      + `历史 ${Array.isArray(receipt.history) ? receipt.history.length : 0} 次`
      + (last ? `；最近一次退役 ${String(last.status ?? '未知')}（Run ${String(last.run_id ?? '未知')}）` : ''));
  }
  lines.push('', '- 说明：这里是白名单字段的摘要。导入报告、依赖与退役回执的原文留在工程与本机档案里，不随诊断包出端。');
  return lines.join('\n');
}

// ---- Documents -----------------------------------------------------------------------------------------------------

function environmentDocument(config: LocalConfig, project: { harness_version: string; knowledge_version: string },
  workflow: DiagnosticWorkflow | null, env: DiagnosticsEnvironment, warnings: string[]): Record<string, unknown> {
  const baseline = config.importByProfile?.[config.defaultProfile]?.packageBaseline ?? {};
  return {
    harness: { version: harnessVersion(), packageVersion: packageVersion(), commit: env.commit ?? null,
      stateSchema: SCHEMA_VERSION, projectHarnessVersion: project.harness_version },
    capabilityPack: workflow?.pack ?? null,
    capabilityProfile: workflow?.profile ?? null,
    knowledge: { version: knowledgeVersion(config), projectKnowledgeVersion: project.knowledge_version },
    environmentLock: { toolchain: baseline, count: Object.keys(baseline).length,
      note: Object.keys(baseline).length ? null : '配置里没有 import.packageBaseline：环境锁的工具链版本未能列出' },
    system: { platform: process.platform, release: release(), arch: process.arch, node: process.version },
    unity: config.unity ? { editor: config.unity.editor ?? null, runner: config.unity.runner, slots: config.unitySlots?.count ?? null } : null,
    providers: config.providers.map(provider => ({ id: provider.id, type: provider.adapter, roles: provider.roles,
      modelFamily: provider.model ?? null, family: provider.family ?? null })),
    checkVocabulary: { checks: [...new Set(workflow?.stages.flatMap(stage => stage.checks.map(check => check.id)) ?? [])].length },
    notes: warnings,
  };
}
/** The machine document: the same content as `report.md`, in a shape a program can read. */
function machineDocument(plan: DiagnosticsPlan, report: string): Record<string, unknown> {
  return {
    schema: DIAGNOSTICS_SCHEMA, generatedAt: plan.generatedAt, project: plan.project, since: plan.since,
    environment: plan.environment, workflow: plan.workflow, workflowCount: plan.workflowCount,
    workflowTools: plan.workflowTools, runs: plan.runs,
    stages: plan.workflow?.stages ?? [], furthestStage: plan.workflow?.furthestStage ?? null,
    blockedAt: plan.workflow?.blockedAt ?? null, blockedWhy: plan.workflow?.blockedWhy ?? null,
    issues: plan.issues, timeline: plan.timeline, timelineNote: TIMELINE_WHITELIST_NOTE,
    attachments: plan.items.map(item => ({ path: item.path, category: item.category, reason: item.reason, bytes: item.bytes,
      keptBytes: item.keptBytes, included: item.included,
      ...(item.excludedBecause ? { excludedBecause: item.excludedBecause } : {}),
      redactions: item.redactions.map(hit => `${hit.id}×${hit.count}`) })),
    excluded: plan.excluded.map(item => ({ path: item.path, reason: item.excludedBecause ?? item.reason, bytes: item.bytes })),
    policy: plan.policy, totals: plan.totals, budget: plan.budget, warnings: plan.warnings,
    // The manifest digest itself is the preview/export token a caller checks; it cannot live inside the pack, because
    // the pack contains this file and its own hash. The count travels so a reader knows how many members to expect.
    manifest: { members: plan.items.filter(item => item.included).length + 2 },
    privacy: { wordsFile: plan.privacyWords.path, applied: plan.privacyWords.applied, problems: plan.privacyWords.problems,
      note: '所有文档字段、成员名与包名在写出前都经过同一套脱敏；导出后逐成员复扫，命中凭据、私人路径、订单号或本地词表即拒绝。' },
    classification: { nature: 'suggestion', note: '问题清单的归类是初步建议，不是结论；每条都保留了所依据的字段。',
      categories: CATEGORY_TEXT, basis: Object.fromEntries(Object.entries(ERROR_CLASS_CATEGORY).map(([id, item]) => [id, item.category])) },
    report: { path: DIAGNOSTICS_REPORT_PATH, chars: report.length },
  };
}
/** `report.md`: the half a person reads. Simplified Chinese, with the classification stated as a suggestion. */
function renderReport(plan: DiagnosticsPlan): string {
  const lines: string[] = [`# 项目诊断包：${plan.project.name}`, '',
    `- 格式：\`${plan.schema}\`（机读版见 \`${DIAGNOSTICS_DOCUMENT_PATH}\`，内容与本文相同）`,
    `- 生成时间：${plan.generatedAt}`,
    `- 项目：\`${plan.project.path}\``,
    `- 统计范围：${plan.since ? `${plan.since} 之后` : '全部记录'}`,
    `- 归类的性质：**以下是初步归类的建议，不是结论**；每条都给出所依据的字段，请以现场复核为准。`, ''];

  const environment = plan.environment as { harness?: Record<string, unknown>; capabilityPack?: Record<string, unknown> | null;
    capabilityProfile?: string | null; knowledge?: Record<string, unknown>;
    environmentLock?: { toolchain?: Record<string, string>; note?: string | null };
    system?: Record<string, unknown>; unity?: Record<string, unknown> | null; providers?: Array<Record<string, unknown>> };
  const harness = environment.harness ?? {};
  lines.push('## 一、版本与环境', '',
    `- Harness 版本：${harness.version ?? '未知'}（包版本 ${harness.packageVersion ?? '未知'}${harness.commit ? `，构建 ${harness.commit}` : ''}）`,
    `- 状态库 schema：${harness.stateSchema ?? '未知'}；项目创建时的 Harness：${harness.projectHarnessVersion ?? '未知'}`,
    `- 能力包：${plan.workflow?.pack ? `${plan.workflow.pack.id} ${plan.workflow.pack.version}（${plan.workflow.pack.channel}），内容哈希 ${plan.workflow.pack.contentHash.slice(0, 16)}` : '未登记（流程不在能力包上，或项目还没有流程）'}`,
    `- 冻结的工具：${plan.workflow ? `${plan.workflow.frozenTools.count} 个文件，摘要 ${plan.workflow.frozenTools.digest.slice(0, 16)}` : '—'}`,
    `- 知识层：${(environment.knowledge ?? {}).version ?? '未知'}（项目冻结 ${(environment.knowledge ?? {}).projectKnowledgeVersion ?? '未知'}）`);
  if (plan.workflowTools.length) {
    lines.push(`- 本项目各工作流冻结的工具哈希摘要（共 ${plan.workflowTools.length} 个）：`);
    for (const row of plan.workflowTools)
      lines.push(`  - ${row.workflowId}${row.current ? '（最新）' : ''}：${row.toolCount} 个文件，摘要 ${row.toolDigest ? row.toolDigest.slice(0, 16) : '没有登记工具'}，状态 ${row.status}`);
  }
  const toolchain = Object.entries(environment.environmentLock?.toolchain ?? {});
  lines.push(`- 环境锁的工具链版本：${toolchain.length ? toolchain.map(([name, version]) => `${name} ${version}`).join('、') : environment.environmentLock?.note ?? '未配置'}`);
  const system = environment.system ?? {};
  lines.push(`- 系统与 Node：${system.platform ?? '?'} ${system.release ?? ''} ${system.arch ?? ''}；Node ${system.node ?? '未知'}`,
    `- Unity：${environment.unity ? `${environment.unity.editor ?? '未配置编辑器'}（并发槽 ${environment.unity.slots ?? '未知'}）` : '未配置'}`,
    `- Provider 与模型族：${(environment.providers ?? []).map(provider => `${provider.id}（${provider.type}${provider.modelFamily ? ` / ${provider.modelFamily}` : ''}）`).join('、') || '无'}`, '');

  lines.push('## 二、制作流程与阶段状态', '');
  if (plan.workflow) {
    lines.push(`- 流程 ${plan.workflow.id}（${plan.workflow.profile ?? '未知 profile'}）：状态 ${plan.workflow.status}`,
      `- 最远阶段：${plan.workflow.furthestStage ?? '还没有完成的阶段'}`,
      `- 卡点：${plan.workflow.blockedAt ? `${plan.workflow.blockedAt}（${plan.workflow.blockedWhy}）` : '没有阻断中的阶段'}`,
      `- 本项目共有 ${plan.workflowCount} 个制作流程；这里描述的是最新那个`,
      `- 阶段状态取自 Runtime 聚合器（含原因码）：完成记录或任务 PASSED 一旦被方案或上游产物作废，这里就不再显示「已完成」。`, '',
      '| 阶段 | 状态 | 任务 | 聚合器原因 | 检查 |', '|---|---|---|---|---|');
    const words: Record<DiagnosticStage['status'], string> = { done: '已完成', current: '进行中', pending: '未开始', blocked: '阻断' };
    for (const stage of plan.workflow.stages) {
      const checks = stage.checks.map(check => `${check.label}=${check.result}${check.accepted ? '（提醒已接受）' : ''}`).join('；') || '—';
      const why = [stage.aggregateStatus, ...stage.reasonCodes].filter(Boolean).join('／');
      lines.push(`| ${stage.label}（${stage.id}） | ${words[stage.status]} | ${stage.taskStatus ?? '—'} | ${why || '—'} | ${checks} |`);
    }
  } else lines.push('这个项目还没有正式制作流程。');
  lines.push('');
  lines.push(`### 逐 Run 摘要（${plan.runs.length} 条，含成功的 Run）`, '');
  if (!plan.runs.length) lines.push('- 没有记录到 Run。');
  for (const run of plan.runs)
    lines.push(`- ${run.id}：阶段 ${run.stageId} 第 ${run.attempt} 次，Run ${run.status}／任务 ${run.taskStatus}`
      + `${run.errorClass ? `，错误类别 ${run.errorClass}` : ''}${run.exitStatus === null ? '' : `，退出码 ${run.exitStatus}`}`
      + `，Provider ${run.provider ?? '—'}，时间 ${run.at ?? '未记录'}`);
  lines.push('');

  lines.push('## 三、问题清单', '', `共 ${plan.issues.length} 条。每条给出阶段、判据中文名与 ID、读数、时间、Run ID 与初步归类。`, '');
  const byCategory = new Map<DiagnosticCategory, number>();
  for (const issue of plan.issues) byCategory.set(issue.category, (byCategory.get(issue.category) ?? 0) + 1);
  if (byCategory.size) lines.push('初步归类分布（建议，不是结论）：',
    ...[...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => `- ${CATEGORY_TEXT[category]}：${count} 条`), '');
  if (!plan.issues.length) lines.push('没有记录到失败、阻断或提醒。');
  plan.issues.forEach((issue, index) => {
    lines.push(`### ${index + 1}. [${issue.kind === 'failure' ? '失败' : issue.kind === 'blocked' ? '阻断' : '提醒'}] ${issue.text}`,
      `- 阶段：${issue.stageId ?? '—'}${issue.checkId ? `；判据：${issue.checkLabel ?? ''}（${issue.checkId}）` : ''}`,
      `- 读数：\`${JSON.stringify(issue.reading)}\``,
      `- 时间：${issue.at ?? '未记录'}；Run：${issue.runId ?? '—'}；Task：${issue.taskId ?? '—'}`,
      `- **初步归类（建议，不是结论）**：${CATEGORY_TEXT[issue.category]} — ${issue.basis}`,
      `- 附件：${issue.attachments.length ? issue.attachments.map(path => `\`${path}\``).join('、') : '没有可附的读数文件'}`, '');
  });

  lines.push('## 四、事件时间线', '', `共 ${plan.timeline.length} 条，按时间正序。`, `- ${TIMELINE_WHITELIST_NOTE}`, '');
  const buckets = new Map<string, number>();
  for (const event of plan.timeline) buckets.set(event.action, (buckets.get(event.action) ?? 0) + 1);
  lines.push('动作分布：' + ([...buckets.entries()].sort((a, b) => b[1] - a[1]).map(([action, count]) => `${action} ×${count}`).join('、') || '无'), '');
  for (const event of plan.timeline.slice(-60))
    lines.push(`- ${event.at} ${event.actor} ${event.action} ${event.entityType} ${event.entityId}`
      + (event.reason !== undefined ? `：${clip(event.reason, 160)}`
        : event.actor === 'human' ? '（人工动作：原话不收录）' : ''));
  if (plan.timeline.length > 60) lines.push(`- （另有 ${plan.timeline.length - 60} 条更早的事件，见 ${DIAGNOSTICS_DOCUMENT_PATH}）`);
  lines.push('');

  lines.push('## 五、收录了什么、排除了什么', '',
    `成员共 ${plan.items.filter(item => item.included).length + 2} 个（含 \`${DIAGNOSTICS_REPORT_PATH}\` 与 \`${DIAGNOSTICS_DOCUMENT_PATH}\`）。`,
    `附件 ${plan.totals.included} 个，${Math.round(plan.totals.keptBytes / 1024)} KB；预算按整包算：上限 ${Math.round(plan.budget.limitBytes / 1024 / 1024 * 10) / 10} MB，`
    + `报告、机读文档与压缩开销先占 ${Math.round(plan.budget.reservedBytes / 1024)} KB，留给附件 ${Math.round(plan.budget.attachmentBudgetBytes / 1024)} KB；`
    + `整包估算 ≤ ${Math.round(plan.budget.estimatedPackageBytes / 1024)} KB。`, '');
  for (const item of plan.items.filter(item => item.included))
    lines.push(`- \`${item.path}\`（${item.category}，${Math.round(item.keptBytes / 1024)} KB）：${item.reason}`
      + (item.redactions.length ? `　已替换：${item.redactions.map(hit => `${hit.id}×${hit.count}`).join('、')}` : ''));
  if (plan.excluded.length) {
    lines.push('', '按预算或可读性排除：');
    for (const item of plan.excluded) lines.push(`- \`${item.path}\`：${item.excludedBecause ?? item.reason}`);
  }
  lines.push('', '整类排除（不因本包而改变）：');
  for (const item of plan.policy) lines.push(`- ${item.what}：${item.why}`);
  lines.push('',
    `脱敏：报告、机读文档、成员名与包名都走同一套脱敏（订单号、本机路径、登录态、令牌形状、本地隐私词表）。本地隐私词表：${plan.privacyWords.path}，生效 ${plan.privacyWords.applied} 条${plan.privacyWords.problems.length ? `（${plan.privacyWords.problems.length} 条问题已跳过）` : ''}。`,
    '导出后已对压缩包每个成员再扫描一次；命中密钥、私人路径、订单号或本地隐私词表即拒绝导出，不留产物。', '');
  if (plan.totals.truncated.length) {
    lines.push('## 六、截断了什么', '');
    for (const note of plan.totals.truncated) lines.push(`- ${note}`);
    lines.push('');
  }
  if (plan.warnings.length) {
    lines.push('## 七、编译时的不确定项', '');
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// ---- Public entry points -------------------------------------------------------------------------------------------

/**
 * Compile the preview and return it: every member with its reason, its size and its content hash, every exclusion with
 * its reason, and the issue list. This writes nothing at all, so a person can look before deciding; the caller passes
 * `manifestDigest` and `generatedAt` back to the export it confirms (R28 P1-3).
 */
export function previewDiagnostics(db: DatabaseSync, config: LocalConfig, projectId: string, options: DiagnosticsPreviewOptions = {}): DiagnosticsPlan {
  return compile(db, config, projectId, options).plan;
}

/**
 * Compile, check the confirmed manifest, pack, check the packed size, then scan every member of the pack again. Nothing
 * is written until every check passes, so a refusal leaves no product behind: a member that still carries a credential,
 * a private path, an order id or a local vocabulary word means no package, a compile whose members differ from the
 * confirmed preview means "re-preview" rather than a different bundle than the one a person approved (R28 P1-2, P1-3),
 * and a pack that measures over the whole-package limit is refused rather than written (R28 2nd round).
 */
export function exportDiagnostics(db: DatabaseSync, config: LocalConfig, projectId: string, options: DiagnosticsExportOptions): DiagnosticsExportResult {
  const emit = options.onProgress ?? ((): void => undefined);
  emit({ phase: 'compile' });
  const compiled = compile(db, config, projectId, options);
  const plan = compiled.plan;
  if (!disabled('AVH_DIAGNOSTICS_NO_MANIFEST_BINDING') && options.expect && options.expect !== plan.manifestDigest)
    return { status: 'refused', plan, refusal: {
      code: 'content_changed', members: [],
      reason: '内容已变化，请重新预览：这次重新编译出的成员清单与你确认过的预览不同，诊断包没有写出' } };
  const files: ZipEntry[] = compiled.members.map(member => ({ path: safeMemberPath(member.path), bytes: member.bytes }));
  emit({ phase: 'bundle', done: 0, total: files.length });
  const archive = writeZip(files);
  // The budget is a promise about the bytes actually packed, not an estimate (R28 2nd round): the report and the
  // machine document are inside the archive, so if they alone already exceed the ceiling no attachment can fix it and
  // the export refuses instead of writing an over-limit bundle.
  if (archive.length > plan.budget.limitBytes) return { status: 'refused', plan, refusal: {
    code: 'over_budget', members: [],
    reason: `诊断包实际 ${archive.length} 字节，超过整包上限 ${plan.budget.limitBytes} 字节：报告与机读文档自身就超过了预算，没有写出任何文件` } };
  emit({ phase: 'scan', done: 0, total: files.length });
  const refusal: Array<{ path: string; detectors: string[] }> = [];
  if (!disabled('AVH_DIAGNOSTICS_NO_RESCAN')) {
    // The same vocabulary the compile redacted with, read once here: a word added between the two reads would be a
    // reason to refuse the member rather than to trust the earlier pass.
    const words = readPrivacyWords(config.home).words;
    let checked = 0;
    for (const member of readZip(archive)) {
      emit({ phase: 'scan', done: ++checked, total: files.length });
      const text = member.bytes.toString('utf8');
      const detectors = [...new Set([...sensitiveHits(text, 'content', { words }),
        ...sensitiveHits(member.path, 'path', { words })])];
      if (detectors.length) refusal.push({ path: member.path, detectors });
    }
  }
  if (refusal.length) return { status: 'refused', plan, refusal: {
    code: 'credential',
    reason: `${refusal.length} 个成员在打包后仍命中密钥、私人路径、订单号或本地隐私词表：诊断包没有写出，请检查日志内容与本地隐私词表`,
    members: refusal } };
  const out = join(options.out, options.name?.trim() || `${safeName(plan.project.name)}-诊断包-${stamp()}.zip`);
  hostPlatform.mkdirPrivate(options.out);
  emit({ phase: 'write' });
  hostPlatform.writePrivate(out, archive);
  return { status: 'exported', plan, package: { path: out, bytes: archive.length, sha256: sha(archive), members: files.length } };
}

const safeName = (value: string): string => value.replace(/[\\/:*?"<>|]/g, '-').slice(0, 60) || 'project';
const stamp = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '').replace('T', '-');
