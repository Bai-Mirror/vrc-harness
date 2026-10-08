/**
 * One vocabulary for every interface, the terminal (src/tui) and the desktop GUI (gui/src): the words a person reads
 * for each state, and a tone. Colour is never the only signal: each state also has a word or a mark.
 *
 * No imports and no platform APIs on purpose: the Runtime and the TUI load this file directly, and the GUI bundles it.
 */
export type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'muted';
export type State = [label: string, tone: Tone];
type Table = Record<string, readonly [string, Tone, ...string[]]>;

const TASK: Table = {
  PENDING: ['排队', 'muted'], READY: ['等待开始', 'info'], RUNNING: ['执行中', 'info'], VERIFYING: ['检查中', 'info'],
  PASSED: ['已通过', 'ok'], WAITING_HUMAN: ['等你处理', 'warn'], BLOCKED: ['检查未通过', 'bad'], FAILED: ['失败', 'bad'],
  CANCELLED: ['已取消', 'muted'], RECOVERY_REQUIRED: ['需核对上次执行', 'bad'],
};
const STAGE: Table = {
  passed: ['已通过', 'ok', '✓'], not_applicable: ['不适用', 'muted', '–'], open: ['待开始', 'info', '·'],
  blocked: ['受阻', 'bad', '✗'], waiting: ['等前序', 'muted', ' '], running: ['进行中', 'info', '▶'], deciding: ['待你决定', 'warn', '!'],
};
const WORKFLOW: Table = {
  active: ['进行中', 'info'], upload_ready: ['可上传', 'ok'], client_verified: ['已验收', 'ok'], cancelled: ['已取消', 'muted'],
  passed: ['已通过', 'ok'], failed: ['失败', 'bad'],
};
const VERDICT: Table = {
  pass: ['通过', 'ok'], violation: ['不符合', 'bad'],
  // A level the check could not reach is its own group, not the bottom of the pass/fail ladder: "not measured" read as
  // red says "something is broken" when the next step is to measure it (信息包装规范 §2.3/§5, §6.2). These get a hint
  // tone and name their own next action through `verdictNext`.
  no_data: ['缺数据', 'info'], error: ['检查出错', 'info'],
  undecidable: ['无法判定', 'info'], not_applicable: ['不适用', 'muted'],
};
const GATE: Table = {
  pending: ['待决定', 'warn'], stale: ['已过期，需重新决定', 'warn'], approved: ['已批准', 'ok'], rejected: ['已驳回', 'bad'],
  waiting: ['未到时候', 'muted'],
};
const SCHEDULER: Table = {
  running: ['调度运行中', 'ok'], pausing: ['正在暂停', 'warn'], paused: ['调度已暂停', 'warn'], backoff: ['调度重启中', 'bad'],
  stopped: ['调度未运行', 'muted'],
};
/** What a receiver can do with a share package (docs/project-share.md). */
const SHARE_LEVEL: Table = {
  continuable: ['可直接续做', 'ok'], needs_dependencies: ['需补依赖', 'warn'], observe_only: ['只能观察', 'bad'],
};
/** How a restore places a package relative to what this machine already has. */
const RESTORE_DECISION: Table = {
  new: ['恢复为新项目', 'info'], update: ['更新本机的同一项目', 'warn'], same: ['本机已有这个版本', 'muted'], conflict: ['恢复为并列副本', 'warn'],
};

let reportMissing: ((vocabulary: string, key: string) => void) | undefined;
/**
 * Called with every value a vocabulary has no words for. The GUI reports them in development builds, so a new enum
 * value is noticed instead of reaching the screen silently as its raw name.
 */
export function onMissingLabel(report: ((vocabulary: string, key: string) => void) | undefined): void { reportMissing = report; }

/** The words and tone for `key`; an unknown value shows as itself, muted, and is reported. */
export function lookup(vocabulary: string, table: Table, key: string): State {
  const found = Object.hasOwn(table, key) ? table[key] : undefined;
  if (!found) { reportMissing?.(vocabulary, key); return [key, 'muted']; }
  return [found[0], found[1]];
}
/**
 * The words for a state value. An unmapped value must not reach the screen as its enum name — a new Runtime value would
 * read as a machine word — so it says the state is still being confirmed and keeps the short identifier for support
 * (信息包装规范 §6.1). Values that are names rather than states (a role, a kind) still go through `lookup`.
 */
export function lookupState(vocabulary: string, table: Table, key: string): State {
  const found = Object.hasOwn(table, key) ? table[key] : undefined;
  if (!found) { reportMissing?.(vocabulary, key); return [`状态正在确认（${key}）`, 'muted']; }
  return [found[0], found[1]];
}
export const taskState = (status: string): State => lookupState('task', TASK, status);
export const stageState = (status: string): State => lookupState('stage', STAGE, status);
export const stageMark = (status: string): string => STAGE[status]?.[2] ?? '?';
export const workflowState = (status: string): State => lookupState('workflow', WORKFLOW, status);
export const verdictState = (result: string): State => lookupState('verdict', VERDICT, result);
export const gateState = (status: string): State => lookupState('gate', GATE, status);
export const schedulerState = (status: string): State => lookupState('scheduler', SCHEDULER, status);
export const shareLevel = (level: string): State => lookupState('share level', SHARE_LEVEL, level);
export const restoreDecision = (kind: string): State => lookupState('restore decision', RESTORE_DECISION, kind);
/** What the person does about a verdict: measure again, fix, or nothing. A missing measurement is not a fault. */
export const verdictNext = (result: string): '补测' | '补测或换判据' | '修复' | '' =>
  result === 'no_data' || result === 'error' ? '补测' : result === 'undecidable' ? '补测或换判据' : result === 'violation' ? '修复' : '';

export const shortHash = (hash?: string | null): string => hash ? hash.slice(0, 8) : '—';
export const shortId = (id: string): string => id.slice(0, 8);

/** Local wall-clock time for an ISO timestamp; the date only when it is not today. */
export function when(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === now.toDateString() ? time : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

/** The first line of a possibly multi-line message, for one-line rows. */
export const firstLine = (text: string | undefined | null): string => (text ?? '').split('\n').find(line => line.trim())?.trim() ?? '';

/** Business language for people who should not need to learn process ids. */
const STAGE_LABELS: Record<string, string> = {
  intake: '检查素材', plan: '确认制作方案', environment: '准备制作环境', setup: '准备工程', face_design: '设计脸型候选', face: '调整脸型', outfit: '装配服装', recolor: '调整颜色', menu: '制作换装菜单',
  build_pre: '首次构建', regression_pre: '首次效果检查', optimize: '性能优化', build: '最终构建',
  regression: '最终效果与贴合检查', performance: '性能验收', package: '整理交付包', client_verify: '客户端验收',
};
export const stageLabel = (id: string): string => STAGE_LABELS[id] ?? id.replaceAll('_', ' ');
