/**
 * Contribution sharing (回传共享): the data policy, the notice every interface shows, and the one validator of the
 * structured records a client may upload (`harness-records/0.1`, plan §3.5 and design 13).
 *
 * The Runtime queues records through this validator, and the server (server/src/harness.ts) accepts a batch only
 * through the very same function, so what a client sends and what the server takes cannot drift apart. No imports and
 * no platform APIs on purpose: the GUI bundles this file and the server image copies it alone.
 *
 * A record carries only whitelisted fields: enumerations, bounded counts, version strings and public BOOTH numbers.
 * There is no field for free text, a path, a project, an account or a time; an unknown field fails the whole record.
 * Extending the schema means changing this file, which both sides then use, and a new schema or notice version.
 */

export const RECORD_SCHEMA = 'harness-records/0.1';
export const RECORD_RECEIPT_SCHEMA = 'harness-records-receipt/0.1';
/** Bumped whenever what is shared, where it goes or why changes: a person then sees the notice again before uploads resume. */
export const SHARING_NOTICE_VERSION = 3;
/**
 * How long the server keeps an upload. Ninety days leave the maintainer time to review uploads and fold what is useful
 * into a signed release (dev releases come every few weeks), while raw uploads do not pile up: what a release accepted
 * is kept apart, and everything else is deleted. The server's RETENTION_DAYS can change it; the notice names this value.
 */
export const DEFAULT_RETENTION_DAYS = 90;
/**
 * How long the operator's backups may still hold data after the server deleted it or the person revoked it: the
 * snapshots are kept at most this long. The server states its own value through BACKUP_DAYS in the data policy; the
 * notice names this one so that what it tells the person does not depend on reading /v1/capabilities first.
 */
export const DEFAULT_BACKUP_DAYS = 90;
/** Records per upload request. */
export const MAX_BATCH_RECORDS = 200;
/** The local queue: records older than this, or beyond this many, are dropped unsent. */
export const MAX_QUEUE_DAYS = 30;
export const MAX_QUEUED_RECORDS = 2000;
export const MAX_QUEUED_CONTRIBUTIONS = 200;

export const RECORD_ENUMS = {
  category: ['tool-reliability', 'asset-compat', 'asset-classification'],
  /** What Harness did. */
  action: ['provider-run', 'tool-run', 'unity-build', 'unity-play', 'booth-sync', 'booth-fetch', 'package-import', 'vpm-resolve',
    'vpm-add', 'vpm-migrate', 'asset-classify', 'asset-investigate', 'fit-check', 'outfit-fit', 'face-shape', 'menu-build',
    'performance-optimize', 'upload-prepare'],
  /** The default category vocabulary (参考站对照清单 §6.1). */
  assetType: ['avatar', 'outfit', 'hair', 'accessory', 'texture', 'toy', 'plugin', 'unclassified'],
  /** Public components whose versions matter for compatibility. Anything else is left out, never named. */
  component: ['harness', 'unity', 'vrchat-sdk-avatars', 'vrchat-sdk-base', 'vpm-cli', 'blender', 'codex-cli', 'claude-code', 'pi',
    'liltoon', 'poiyomi', 'unitychan-toon', 'sunao', 'mtoon', 'modular-avatar', 'ndmf', 'vrcfury', 'avatar-optimizer',
    'textranstool', 'lilycal-inventory', 'gesture-manager', 'av3emulator'],
  /** The Runtime's ErrorClass values, then the error types of asset work. */
  error: ['auth', 'rate_limit', 'timeout', 'protocol', 'tool_failure', 'verifier_failure', 'permission_denied', 'network',
    'missing-dependency', 'missing-shader', 'missing-script', 'version-mismatch', 'import-error', 'bone-mismatch',
    'blendshape-mismatch', 'mesh-penetration', 'material-broken', 'build-error', 'performance-limit', 'upload-limit', 'other'],
  repairStrategy: ['retry', 'reimport', 'install-dependency', 'update-dependency', 'downgrade-dependency', 'remap-bones',
    'merge-armature', 'adjust-blendshape', 'fix-material', 'replace-shader', 'reduce-performance', 'manual', 'other'],
  repairResult: ['fixed', 'partially-fixed', 'not-fixed', 'not-attempted'],
  /** The person's feedback, normalised: never their words. */
  feedback: ['accepted', 'rejected', 'looks-wrong', 'fit-issue', 'color-issue', 'menu-issue', 'performance-issue', 'other'],
  outcome: ['success', 'failure', 'cancelled', 'partial'],
  duration: ['lt-1m', '1-5m', '5-15m', '15-60m', 'gt-60m'],
  platform: ['linux', 'windows', 'macos', 'other'],
  model: ['gpt', 'claude', 'deepseek', 'glm', 'other', 'unknown'],
  attempt: ['first', 'retry'],
  /** Where a fit claim comes from (plan §3.2). */
  fitSource: ['author-declared', 'structure-observed', 'project-verified', 'ai-inferred'],
  fitResult: ['compatible', 'modifiable', 'incompatible', 'unknown'],
  /** Remote file kinds (参考站对照清单 §6.3). */
  fileKind: ['material', 'fit', 'other'],
  dictionaryKind: ['canonical', 'alias', 'shared-body'],
  /** Directory and component structure: counts, each rounded down to a power of two (countBucket). */
  structureCount: ['files', 'directories', 'unitypackages', 'prefabs', 'fbx', 'textures', 'materials', 'shaders', 'animations',
    'animatorControllers', 'scenes', 'scripts', 'meshes', 'skinnedMeshes', 'bones', 'blendshapes', 'physbones', 'contacts',
    'constraints', 'menus', 'parameters'],
  /** Directory and component structure: present or not. */
  structureFlag: ['avatarDescriptor', 'expressionMenu', 'expressionParameters', 'modularAvatar', 'vrcfury', 'missingScripts',
    'missingReferences', 'humanoid'],
} as const;

type Of<K extends keyof typeof RECORD_ENUMS> = (typeof RECORD_ENUMS)[K][number];
export type SharingCategory = Of<'category'>;
export type HarnessAction = Of<'action'>;
export type AssetType = Of<'assetType'>;
export type ComponentId = Of<'component'>;
export type RecordErrorType = Of<'error'>;
export type RepairStrategy = Of<'repairStrategy'>;
export type RepairResult = Of<'repairResult'>;
export type FeedbackCategory = Of<'feedback'>;
export type Outcome = Of<'outcome'>;
export type DurationBucket = Of<'duration'>;
export type RecordPlatform = Of<'platform'>;
export type ModelFamily = Of<'model'>;
export type FitSource = Of<'fitSource'>;
export type FitResult = Of<'fitResult'>;
export type FileKind = Of<'fileKind'>;
export type DictionaryKind = Of<'dictionaryKind'>;
export type StructureCount = Of<'structureCount'>;
export type StructureFlag = Of<'structureFlag'>;

/** 素材指纹: a public BOOTH product number, optionally its downloadable file number and a version. Private assets have none. */
export interface AssetFingerprint { booth: string; file?: string; version?: string }
export interface ComponentVersion { id: ComponentId; version: string }
export type RecordStructure = Partial<Record<StructureCount, number>> & Partial<Record<StructureFlag, boolean>>;
export interface SharingRecord {
  /** 随机贡献 ID: fresh random for every record, never derived from anything local. */
  id: string;
  category: SharingCategory;
  action?: HarnessAction;
  outcome?: Outcome;
  asset?: AssetFingerprint | null;
  assetType?: AssetType;
  components?: ComponentVersion[];
  structure?: RecordStructure;
  error?: RecordErrorType | null;
  repair?: { strategy: RepairStrategy; result: RepairResult } | null;
  feedback?: FeedbackCategory | null;
  duration?: DurationBucket;
  platform?: RecordPlatform;
  model?: ModelFamily;
  attempt?: 'first' | 'retry';
  fit?: { avatar: string; source: FitSource; result: FitResult } | null;
  fileKind?: FileKind;
  dictionary?: { term: string; kind: DictionaryKind; avatar: string } | null;
}
export interface RecordBatch { schema: typeof RECORD_SCHEMA; batchId: string; notice: number; records: SharingRecord[] }
/** The server's answer to a stored batch: 201 the first time, 200 for the same batch again. */
export interface RecordReceipt { schema: typeof RECORD_RECEIPT_SCHEMA; batchId: string; accepted: number; status: 'stored' }

/** Which fields each category takes: what a record may say depends on what it is about. */
const FIELDS: Record<SharingCategory, { required: readonly (keyof SharingRecord)[]; optional: readonly (keyof SharingRecord)[] }> = {
  'tool-reliability': { required: ['action', 'outcome'],
    optional: ['components', 'error', 'duration', 'platform', 'model', 'attempt', 'repair', 'feedback'] },
  'asset-compat': { required: ['action', 'outcome'],
    optional: ['asset', 'assetType', 'components', 'structure', 'error', 'repair', 'feedback', 'duration', 'platform', 'fit'] },
  'asset-classification': { required: ['asset'],
    optional: ['action', 'assetType', 'fileKind', 'fit', 'dictionary', 'components', 'structure'] },
};
const ORDER: readonly (keyof SharingRecord)[] = ['id', 'category', 'action', 'outcome', 'asset', 'assetType', 'fileKind', 'components',
  'structure', 'error', 'repair', 'feedback', 'duration', 'platform', 'model', 'attempt', 'fit', 'dictionary'];

const HEX32 = /^[0-9a-f]{32}$/;
/** A BOOTH product or downloadable number. */
const BOOTH_NUMBER = /^[1-9][0-9]{0,11}$/;
/** 2022.3.22f1, 2022.3.22f1c1, 3.7.0, 0.1.0-dev.1, 1.10.0-rc.2: digits and a few fixed suffixes, nothing that can spell a word. */
const VERSION = /^\d{1,4}(?:\.\d{1,4}){1,3}(?:[abfp]\d{1,3}(?:c\d{1,2})?)?(?:-(?:alpha|beta|rc|dev|preview|pre|next)(?:\.?\d{1,4})?)?$/;
/** A dictionary term: one short token of letters and digits (a character's public name), no spaces, paths or punctuation. */
const TERM = /^[\p{L}\p{N}][\p{L}\p{N}ー・._-]{0,31}$/u;
const MAX_COUNT_BUCKET = 2 ** 20;
const MAX_COMPONENTS = 16;

export class RecordError extends Error {
  readonly field: string;
  constructor(field: string, message: string) { super(`${field}: ${message}`); this.name = 'RecordError'; this.field = field; }
}

function plain(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecordError(field, 'must be an object');
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, field: string, keys: readonly string[]): void {
  const unknown = Object.keys(value).find(key => !keys.includes(key));
  if (unknown !== undefined) throw new RecordError(`${field}.${unknown}`, 'is not an allowed field');
}
function member<K extends keyof typeof RECORD_ENUMS>(kind: K, value: unknown, field: string): Of<K> {
  if (typeof value !== 'string' || !(RECORD_ENUMS[kind] as readonly string[]).includes(value))
    throw new RecordError(field, `must be one of ${RECORD_ENUMS[kind].join(', ')}`);
  return value as Of<K>;
}
function matching(pattern: RegExp, value: unknown, field: string, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new RecordError(field, `must be ${what}`);
  return value;
}
function nullable<T>(value: unknown, read: (value: unknown) => T): T | null { return value === null ? null : read(value); }

function assetFingerprint(value: unknown, field: string): AssetFingerprint {
  const raw = plain(value, field);
  only(raw, field, ['booth', 'file', 'version']);
  return { booth: matching(BOOTH_NUMBER, raw.booth, `${field}.booth`, 'a BOOTH product number'),
    ...(raw.file === undefined ? {} : { file: matching(BOOTH_NUMBER, raw.file, `${field}.file`, 'a BOOTH file number') }),
    ...(raw.version === undefined ? {} : { version: matching(VERSION, raw.version, `${field}.version`, 'a version such as 1.2.0') }) };
}
function components(value: unknown, field: string): ComponentVersion[] {
  if (!Array.isArray(value) || value.length > MAX_COMPONENTS) throw new RecordError(field, `must be a list of at most ${MAX_COMPONENTS}`);
  const seen = new Set<string>();
  return value.map((item, i) => {
    const raw = plain(item, `${field}[${i}]`);
    only(raw, `${field}[${i}]`, ['id', 'version']);
    const id = member('component', raw.id, `${field}[${i}].id`);
    if (seen.has(id)) throw new RecordError(`${field}[${i}].id`, `names ${id} twice`);
    seen.add(id);
    return { id, version: matching(VERSION, raw.version, `${field}[${i}].version`, 'a version such as 2022.3.22f1 or 1.2.0') };
  });
}
function structure(value: unknown, field: string): RecordStructure {
  const raw = plain(value, field);
  only(raw, field, [...RECORD_ENUMS.structureCount, ...RECORD_ENUMS.structureFlag]);
  const result: Record<string, number | boolean> = {};
  for (const key of RECORD_ENUMS.structureCount) {
    if (raw[key] === undefined) continue;
    const count = raw[key];
    if (typeof count !== 'number' || !Number.isInteger(count) || countBucket(count) !== count || count > MAX_COUNT_BUCKET)
      throw new RecordError(`${field}.${key}`, 'must be 0 or a power of two up to 2^20 (use countBucket)');
    result[key] = count;
  }
  for (const key of RECORD_ENUMS.structureFlag) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') throw new RecordError(`${field}.${key}`, 'must be true or false');
    result[key] = raw[key] as boolean;
  }
  return result as RecordStructure;
}

/**
 * Checks one record against the whitelist and returns a normalised copy (fields in a fixed order, nothing else).
 * Throws RecordError naming the first field that is not allowed.
 */
export function validateRecord(value: unknown, field = 'record'): SharingRecord {
  const raw = plain(value, field);
  const category = member('category', raw.category, `${field}.category`);
  const rules = FIELDS[category];
  only(raw, field, ['id', 'category', ...rules.required, ...rules.optional]);
  for (const key of rules.required) if (raw[key] === undefined) throw new RecordError(`${field}.${key}`, `is required for ${category}`);
  const record: Record<string, unknown> = { id: matching(HEX32, raw.id, `${field}.id`, '32 lowercase hex digits'), category };
  const at = (key: string) => `${field}.${key}`;
  const readers: Partial<Record<keyof SharingRecord, (value: unknown) => unknown>> = {
    action: value => member('action', value, at('action')),
    outcome: value => member('outcome', value, at('outcome')),
    asset: value => nullable(value, item => assetFingerprint(item, at('asset'))),
    assetType: value => member('assetType', value, at('assetType')),
    fileKind: value => member('fileKind', value, at('fileKind')),
    components: value => components(value, at('components')),
    structure: value => structure(value, at('structure')),
    error: value => nullable(value, item => member('error', item, at('error'))),
    repair: value => nullable(value, item => {
      const repair = plain(item, at('repair')); only(repair, at('repair'), ['strategy', 'result']);
      return { strategy: member('repairStrategy', repair.strategy, `${at('repair')}.strategy`),
        result: member('repairResult', repair.result, `${at('repair')}.result`) };
    }),
    feedback: value => nullable(value, item => member('feedback', item, at('feedback'))),
    duration: value => member('duration', value, at('duration')),
    platform: value => member('platform', value, at('platform')),
    model: value => member('model', value, at('model')),
    attempt: value => member('attempt', value, at('attempt')),
    fit: value => nullable(value, item => {
      const fit = plain(item, at('fit')); only(fit, at('fit'), ['avatar', 'source', 'result']);
      return { avatar: matching(BOOTH_NUMBER, fit.avatar, `${at('fit')}.avatar`, 'the BOOTH product number of the avatar'),
        source: member('fitSource', fit.source, `${at('fit')}.source`), result: member('fitResult', fit.result, `${at('fit')}.result`) };
    }),
    dictionary: value => nullable(value, item => {
      const entry = plain(item, at('dictionary')); only(entry, at('dictionary'), ['term', 'kind', 'avatar']);
      return { term: matching(TERM, entry.term, `${at('dictionary')}.term`, 'one word of at most 32 letters or digits'),
        kind: member('dictionaryKind', entry.kind, `${at('dictionary')}.kind`),
        avatar: matching(BOOTH_NUMBER, entry.avatar, `${at('dictionary')}.avatar`, 'the BOOTH product number of the avatar') };
    }),
  };
  for (const key of ORDER.slice(2)) if (raw[key] !== undefined) record[key] = readers[key]!(raw[key]);
  if (category === 'asset-classification') {
    if (!record.asset) throw new RecordError(at('asset'), 'a classification is about a public asset and needs its BOOTH number');
    if (!['assetType', 'fileKind', 'fit', 'dictionary'].some(key => record[key] !== undefined && record[key] !== null))
      throw new RecordError(field, 'a classification needs assetType, fileKind, fit or dictionary');
  }
  return record as unknown as SharingRecord;
}

/** Checks a whole upload; the first bad record fails it, with the record's position in the error. */
export function validateRecordBatch(value: unknown): RecordBatch {
  const raw = plain(value, 'batch');
  only(raw, 'batch', ['schema', 'batchId', 'notice', 'records']);
  if (raw.schema !== RECORD_SCHEMA) throw new RecordError('batch.schema', `must be ${RECORD_SCHEMA}`);
  const batchId = matching(HEX32, raw.batchId, 'batch.batchId', '32 lowercase hex digits');
  if (typeof raw.notice !== 'number' || !Number.isInteger(raw.notice) || raw.notice < 1 || raw.notice > SHARING_NOTICE_VERSION)
    throw new RecordError('batch.notice', `must be a notice version from 1 to ${SHARING_NOTICE_VERSION}`);
  if (!Array.isArray(raw.records) || !raw.records.length || raw.records.length > MAX_BATCH_RECORDS)
    throw new RecordError('batch.records', `must hold 1 to ${MAX_BATCH_RECORDS} records`);
  const ids = new Set<string>();
  const records = raw.records.map((record, i) => {
    const checked = validateRecord(record, `batch.records[${i}]`);
    if (ids.has(checked.id)) throw new RecordError(`batch.records[${i}].id`, 'appears twice');
    ids.add(checked.id);
    return checked;
  });
  return { schema: RECORD_SCHEMA, batchId, notice: raw.notice, records };
}

/** A count as the record may carry it: 0, or the largest power of two not above it. */
export function countBucket(count: number): number {
  if (!Number.isFinite(count) || count < 1) return 0;
  return Math.min(2 ** Math.floor(Math.log2(count)), MAX_COUNT_BUCKET);
}
export function durationBucket(ms: number): DurationBucket {
  const minutes = ms / 60_000;
  return minutes < 1 ? 'lt-1m' : minutes < 5 ? '1-5m' : minutes < 15 ? '5-15m' : minutes < 60 ? '15-60m' : 'gt-60m';
}
/** The first version a tool prints ("codex-cli 0.46.0", "2.0.14 (Claude Code)"), if it is one a record may carry. */
export function versionClue(text: string | null | undefined): string | undefined {
  for (const token of (text ?? '').split(/[\s(),]+/)) {
    const candidate = token.replace(/^v/, '');
    if (VERSION.test(candidate)) return candidate;
  }
  return undefined;
}
export function modelFamily(model: string | null | undefined): ModelFamily {
  const name = (model ?? '').toLowerCase();
  if (!name) return 'unknown';
  return /^(gpt|o\d|codex)/.test(name) ? 'gpt' : /claude|sonnet|opus|haiku/.test(name) ? 'claude'
    : /deepseek/.test(name) ? 'deepseek' : /glm|zhipu|z\.ai/.test(name) ? 'glm' : 'other';
}
export function recordPlatform(platform: string): RecordPlatform {
  return platform === 'linux' ? 'linux' : platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'other';
}

/** What the notice and the settings page say about each record category. */
export const SHARING_CATEGORIES: ReadonlyArray<{ id: SharingCategory; title: string; detail: string }> = [
  { id: 'tool-reliability', title: '工具可靠性',
    detail: '组件与 AI 执行方的版本、错误类别、成功或失败、按区间粗化的耗时。不含日志和对话。' },
  { id: 'asset-compat', title: '素材兼容与修复记录',
    detail: '公开 BOOTH 商品的编号与版本线索、素材类型、Unity/SDK/着色器/插件版本、按区间计数的结构特征、Harness 执行的动作、错误类型、修复策略与结果、归一化的反馈分类。自制或私有素材不带编号。' },
  { id: 'asset-classification', title: '公开素材的分类与适配',
    detail: '公开 BOOTH 商品的类别、文件类型、适配的素体及其来源，以及角色字典候选。' },
];
/** What never leaves this computer through sharing. */
export const NEVER_SHARED: readonly string[] = ['原始素材（unitypackage、模型、贴图）', 'Unity 与 Blender 工程', '对话、需求原文和其他自由文本',
  '参考图与截图', '本机路径、账号、项目名和客户信息'];

export interface SharingNotice { title: string; summary: string; shared: string[]; never: string[]; where: string; retention: string;
  queue: string; stop: string; perItem: string }
/** The notice every interface shows before anything is uploaded: GUI first run and main screen, and TUI. */
export function sharingNotice(options: { server: string; retentionDays?: number; backupDays?: number }): SharingNotice {
  const days = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const backup = options.backupDays ?? DEFAULT_BACKUP_DAYS;
  return {
    title: '自愿加入技术协作，可以随时退出',
    summary: '选择加入后，Harness 会把去标识的技术记录发回 Harness 项目的服务器，用来整理素材兼容库、修复库和评测集。关闭不影响本地制作，也不影响软件更新。',
    shared: SHARING_CATEGORIES.map(category => `${category.title}：${category.detail}`),
    never: [...NEVER_SHARED],
    where: `发往 ${options.server}，由 Harness 项目维护者运营。服务端日志不记录你的 IP 地址和上传令牌；每台电脑用一个随机令牌，不关联账号。`,
    retention: `服务器保存 ${days} 天后自动删除，被采纳进签名发行的内容除外。请求撤回时本机立即停发；服务器确认后删除尚未采纳的记录与贡献包。删除或撤回后，数据在运营者的备份中最多再保留 ${backup} 天。`,
    queue: `上传前先在本机排队（技术记录最多 ${MAX_QUEUED_RECORDS} 条、候选报告最多 ${MAX_QUEUED_CONTRIBUTIONS} 份，均不超过 ${MAX_QUEUE_DAYS} 天）；加入后由 Harness 在后台自动批量发送，连不上服务器就退避重试，不影响本地制作；过期或超量会撤销待发授权并清理载荷，保留本地成果。`,
    stop: '在「设置 → 数据与协作」可以关闭回传、查看服务器记录或请求撤回。',
    perItem: '候选评测报告需逐个授权；只含结构化结果和分母，不上传知识包、工具原文或私人材料。',
  };
}

/** The data policy the server advertises in /v1/capabilities, and the client can show. */
export interface DataPolicy {
  schema: 'harness-data-policy/0.1'; participation: 'explicit-opt-in'; noticeVersion: number; operator: string; retentionDays: number; backupDays: number;
  /** Categories enabled within an explicitly joined collaboration; never an installation-level default. */
  categories: Array<{ id: SharingCategory; defaultOn: true; endpoint: '/v1/records' }>;
  perItemAuthorization: Array<{ id: 'candidate-evaluation'; endpoint: '/v1/contributions' }>;
  neverCollected: string[]; logs: { clientAddresses: false; tokens: false };
  endpoints: { installations: string; records: string; contributions: string; status: string; revoke: string };
  recordSchemas: string[]; limits: { batchRecords: number; recordsPerDay: number };
}
export const SHARING_PATHS = { installations: '/v1/installations', records: '/v1/records', contributions: '/v1/contributions',
  status: '/v1/contributions/status', revoke: '/v1/consents/revoke' } as const;
export function dataPolicy(options: { retentionDays: number; backupDays: number; recordsPerDay: number }): DataPolicy {
  return {
    schema: 'harness-data-policy/0.1', participation:'explicit-opt-in', noticeVersion: SHARING_NOTICE_VERSION, operator: 'Harness 项目维护者',
    retentionDays: options.retentionDays, backupDays: options.backupDays,
    categories: RECORD_ENUMS.category.map(id => ({ id, defaultOn: true as const, endpoint: SHARING_PATHS.records })),
    perItemAuthorization: [{ id: 'candidate-evaluation', endpoint: SHARING_PATHS.contributions }],
    neverCollected: ['raw-assets', 'projects', 'conversations', 'free-text', 'images', 'paths', 'account-identifiers'],
    logs: { clientAddresses: false, tokens: false },
    endpoints: { ...SHARING_PATHS }, recordSchemas: [RECORD_SCHEMA],
    limits: { batchRecords: MAX_BATCH_RECORDS, recordsPerDay: options.recordsPerDay },
  };
}
