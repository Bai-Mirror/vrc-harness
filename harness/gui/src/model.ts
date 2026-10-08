/**
 * What the GUI derives from Runtime data before rendering it: pure functions without DOM or React, so the decisions
 * behind each screen are tested under Node (test/gui/model.test.ts).
 */
import { gateText, nextReading, reasonsText, schedulerState, stageLabel, stageMark, stageState, taskState, workflowState,
  type FourState, type State } from './labels.ts';
import { PI_MODELS, PI_PAY_AS_YOU_GO, PI_UPSTREAMS, type PiUpstream } from '../../src/shared/pi.ts';

type GateLike = { gate: string; status: string; project?: string; projectName: string; question: string; binds: string };
type TaskLike = { stage: string; status: string; projectName: string; needsYou: boolean; waitReason?: string };
type ProjectLike = { workflow?: { status: string } };

/** A Gate the person can decide now: pending, or decided on a version that has since changed. */
export const isOpenGate = (gate: { status: string }): boolean => gate.status === 'pending' || gate.status === 'stale';
/** What a Task waits for, in one line. */
export const taskLine = (task: TaskLike): string => task.waitReason ?? `「${stageLabel(task.stage)}」${taskState(task.status)[0]}`;
/** Projects with a production workflow that has not been cancelled. */
export const inProgress = <P extends ProjectLike>(projects: P[]): P[] => projects.filter(p => p.workflow && p.workflow.status !== 'cancelled');

/** The one sentence and button at the top of a page: what to do now, and which of the four states it is. */
export type NextView = { state: FourState; title: string; text: string; tone: 'accent' | 'warn';
  action?: { kind: 'first' | 'resume'; label: string };
  /** The scheduler is not running while something else comes first: offer to resume as a second button. */
  resume?: boolean };
export function homeNext(input: { gates: GateLike[]; tasks: TaskLike[]; projects: ProjectLike[]; scheduler?: string }): NextView {
  const gates = input.gates.filter(isOpenGate), tasks = input.tasks.filter(task => task.needsYou);
  const count = gates.length + tasks.length;
  const paused = Boolean(input.scheduler) && input.scheduler !== 'running' && input.scheduler !== 'pausing';
  if (count) {
    const first = gates[0] ? `${gates[0].projectName}：${gateText(gates[0]).question}` : `${tasks[0]!.projectName}：${taskLine(tasks[0]!)}`;
    return { state: 'needs-you', title: `有 ${count} 项需要你处理`, text: first, tone: 'warn', action: { kind: 'first', label: '处理第一项' }, resume: paused };
  }
  if (input.scheduler === 'pausing') return { state: 'running', title: '正在暂停，当前步骤仍在收尾', text: '不会启动新工作；已开始的步骤会继续核对结果。', tone: 'warn' };
  if (paused) return { state: 'needs-you', title: '后台已暂停，未启动新工作', text: '继续运行后接着制作；尚未确认结束的步骤会先等待核对。', tone: 'warn',
    action: { kind: 'resume', label: '继续运行' } };
  if (!input.scheduler) return { state: 'next-up', title: '现在不需要你处理', text: '正在连接后台…', tone: 'accent' };
  const active = input.projects.filter(project => project.workflow?.status === 'active').length;
  return active
    ? { state: 'running', title: '现在不需要你处理', text: `后台正在推进 ${active} 个项目。`, tone: 'accent' }
    : { state: 'nothing', title: '现在不需要你处理', text: '还没有进行中的项目。', tone: 'accent' };
}
export function projectNext(input: { next?: string; hasWorkflow: boolean; status?: string; openGates: number; scheduler?: string }): NextView {
  const running = input.scheduler === 'running', paused = Boolean(input.scheduler) && !running && input.scheduler !== 'pausing';
  if (!input.hasWorkflow) return { state: 'next-up', title: '还没有开始制作', text: '确认需求和素材后，就可以开始制作流程。', tone: 'accent' };
  const reading = nextReading(input.next, running);
  if (input.openGates) return { state: 'needs-you', title: reading.text, text: '在下面的决定卡里批准，或者提出修改要求。', tone: 'warn', resume: paused };
  if (input.status === 'cancelled' || input.status === 'client_verified')
    return { state: 'done', title: reading.text, text: '', tone: 'accent' };
  if (input.scheduler === 'pausing') return { state: 'running', title: '正在暂停，当前步骤仍在收尾', text: '不会启动新工作；已开始的步骤会继续核对结果。', tone: 'warn' };
  if (paused) return { state: 'needs-you', title: reading.text, text: '继续运行后接着制作；尚未确认结束的步骤会先等待核对。', tone: 'warn', action: { kind: 'resume', label: '继续运行' } };
  return { state: reading.state, title: reading.text, text: '只有需要审美判断，或自动流程无法安全决定时，才会请你介入。', tone: 'accent' };
}

/** The scheduler's one control: what it says and does in each state (a pause and a resume are never both offered). */
export function schedulerControl(state: string | undefined): { state: State; hint: string; label: string; method?: string; primary?: boolean } {
  if (!state) return { state: ['正在连接', 'muted'], hint: '正在连接后台服务…', label: '正在连接…' };
  const words = schedulerState(state);
  switch (state) {
    case 'running': return { state: words, hint: '暂停会停止新工作，已开始的步骤继续收尾并核对结果。', label: '安全点暂停', method: 'service.pause' };
    case 'pausing': return { state: words, hint: '已停止新工作，正在收尾并核对当前步骤。', label: '正在暂停…' };
    case 'backoff': return { state: words, hint: '调度刚才异常退出，正在等待自动重启。', label: '立即重启', method: 'service.resume', primary: true };
    case 'paused': return { state: words, hint: '新工作已暂停；未能确认结束的步骤会等待核对，继续运行不会直接重做它们。', label: '继续运行', method: 'service.resume', primary: true };
    default: return { state: words, hint: '调度没有运行：制作不会推进。', label: '继续运行', method: 'service.resume', primary: true };
  }
}

/** The plan as a person reads it: one derivation shared with the terminal (src/shared/plan-view.ts). */
export { planDetails, planSummary } from '../../src/shared/plan-view.ts';

/** The design map's outfit box: a count when there are outfits, otherwise the first step to take. */
export function variantSummary(count: number): { title: string; hint: string; flows: boolean } {
  return count > 0
    ? { title: `${count} 个衣装方案`, hint: '只决定你最终能看到和使用的结果', flows: true }
    : { title: '尚未建立衣装方案', hint: '用下面的「新增衣装方案」先建第一个', flows: false };
}

/** The message of anything thrown: the Runtime's errors are Error objects, a Tauri command rejects with a string. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return String((error as { message?: unknown } | null)?.message ?? error);
}
/**
 * Run an action and report its failure instead of dropping it: an unhandled rejection in a click handler leaves the
 * person thinking the click was missed. Resolves to whether the action succeeded.
 */
export async function attempt(action: () => Promise<unknown>, report: (message: string) => void): Promise<boolean> {
  try { await action(); return true; } catch (error) { report(errorText(error)); return false; }
}

type CheckLike = { verdict?: { result: string; current: boolean } };
type StageLike = { id: string; status: string; display?: string; reasons: string[]; task?: { status: string; attempts: number };
  checks: CheckLike[] };
/**
 * Checks by what their evidence says now: evidence for an older version counts as stale, never as a pass.
 *
 * Every level the check could not reach keeps its own count. Lumping them together made "not measured" render as
 * "not passed", so a person read a missing measurement as a defect of their avatar
 * (信息包装规范 §2.3/§4 · 缺测不能变零；不适用 ≠ 未测 ≠ 不符合 ≠ 判不了 ≠ 检查出错).
 */
export type VerdictCounts = { total: number; pass: number; fail: number; noData: number; error: number; unsure: number;
  stale: number; pending: number; na: number };
export function verdictCounts(checks: CheckLike[]): VerdictCounts {
  const counts: VerdictCounts = { total: checks.length, pass: 0, fail: 0, noData: 0, error: 0, unsure: 0, stale: 0, pending: 0, na: 0 };
  for (const check of checks) {
    if (!check.verdict) counts.pending++;
    else if (!check.verdict.current) counts.stale++;
    else if (check.verdict.result === 'pass') counts.pass++;
    else if (check.verdict.result === 'not_applicable') counts.na++;
    else if (check.verdict.result === 'undecidable') counts.unsure++;
    else if (check.verdict.result === 'no_data') counts.noData++;
    else if (check.verdict.result === 'error') counts.error++;
    else counts.fail++;
  }
  return counts;
}
/**
 * The tally in one line. Levels that are not about the avatar's quality — a missing measurement, a tool failure, an
 * undecidable rule, a check the plan does not apply — are named rather than folded into "not passed", and "waiting for
 * evidence" and "evidence expired" are stated as such.
 */
export function verdictTally(counts: VerdictCounts): string {
  if (!counts.total) return '尚无检查';
  return [`${counts.total} 项检查`, `通过 ${counts.pass}`,
    ...(counts.fail ? [`不符合 ${counts.fail}`] : []),
    ...(counts.noData ? [`缺数据 ${counts.noData}（需补测）`] : []),
    ...(counts.error ? [`检查出错 ${counts.error}（需重跑）`] : []),
    ...(counts.unsure ? [`无法判定 ${counts.unsure}`] : []),
    ...(counts.na ? [`不适用 ${counts.na}`] : []),
    ...(counts.pending ? [`待取证 ${counts.pending}`] : []),
    ...(counts.stale ? [`已过期 ${counts.stale}`] : [])].join(' · ');
}

export type ProgressCheckLike = CheckLike & { id: string; severity: string; acceptanceRequired?: boolean; label?: string; observe: string;
  scope?: string; on?: string; rule?: string; source?: string; maturity?: string; when?: string; verdict?: CheckLike['verdict'] & {
    id?: string; artifactHash?: string; boundHash?: string | null; recordedAt?: string; accepted?: boolean; acceptedAt?: string | null } };
export type ProgressStageLike = { id: string; status: string; display?: string; reasons: string[]; checks: ProgressCheckLike[];
  codes?: string[]; task?: { id: string; status: string; attempts: number } };

const COMPLETED_STAGE_STATES = new Set(['passed', 'not_applicable']);
const ACTIONABLE_TASK_STATES = new Set(['RUNNING', 'VERIFYING', 'WAITING_HUMAN', 'FAILED', 'BLOCKED', 'RECOVERY_REQUIRED']);
/** A waiting/open stage is future unless its Task or aggregate state says it is currently actionable. */
export function actionableProgressStage(stage: ProgressStageLike): boolean {
  const state = stage.display ?? stage.status;
  return ['running', 'deciding', 'blocked'].includes(state) || stage.status === 'blocked' || ACTIONABLE_TASK_STATES.has(stage.task?.status ?? '') ||
    (!['waiting', 'open', ...COMPLETED_STAGE_STATES].includes(state) && state !== 'queued');
}

/** Only checks in current/blocked stages need attention; future stages contribute counts, never stale rows. */
export function attentionChecks(stages: ProgressStageLike[]): Array<{ stage: ProgressStageLike; check: ProgressCheckLike }> {
  return stages.flatMap(stage => {
    if ((stage.display ?? stage.status) === 'not_applicable') return [];
    if (!actionableProgressStage(stage)) return [];
    return stage.checks.filter(check => {
      // Accepted current warnings stay in evidence/L2, but are no longer actionable in L1. Expired readings remain visible.
      if (check.severity === 'warning' && check.verdict?.accepted === true && check.verdict.current !== false) return false;
      if (check.verdict?.current === false) return true;
      if (check.verdict?.result && check.verdict.result !== 'pass' && check.verdict.result !== 'not_applicable') return true;
      if (check.acceptanceRequired && check.verdict?.accepted !== true) return true;
      return !check.verdict;
    }).map(check => ({ stage, check }));
  });
}

/** Stage summary for L1: completed work is one sentence, current and next are single rows, the rest is a count. */
export function progressStageSummary(stages: ProgressStageLike[]): { completed: ProgressStageLike[]; current?: ProgressStageLike; next?: ProgressStageLike; remaining: number } {
  const completed = stages.filter(stage => COMPLETED_STAGE_STATES.has(stage.display ?? stage.status));
  const current = stages.find(stage => actionableProgressStage(stage));
  const currentIndex = current ? stages.indexOf(current) : -1;
  const next = currentIndex >= 0 ? stages.slice(currentIndex + 1).find(stage => !COMPLETED_STAGE_STATES.has(stage.display ?? stage.status))
    : stages.find(stage => !COMPLETED_STAGE_STATES.has(stage.display ?? stage.status));
  const remaining = stages.filter(stage => stage !== current && stage !== next && !completed.includes(stage)).length;
  return { completed, current, next, remaining };
}

export type ProgressCheckCounts = { pending: number; notApplicable: number; accepted: number; futurePending: number;
  futureNotApplicable: number; futureAccepted: number; currentPass: number; currentNotApplicable: number; currentAccepted: number;
  currentMissing: number; currentExpired: number; currentTotal: number };
/** Counts preserve future, not-applicable and accepted evidence without turning it into an L1 defect row. */
export function progressCheckCounts(stages: ProgressStageLike[]): ProgressCheckCounts {
  const counts: ProgressCheckCounts = { pending: 0, notApplicable: 0, accepted: 0, futurePending: 0, futureNotApplicable: 0,
    futureAccepted: 0, currentPass: 0, currentNotApplicable: 0, currentAccepted: 0, currentMissing: 0, currentExpired: 0, currentTotal: 0 };
  for (const stage of stages) for (const check of stage.checks) {
    const stageState = stage.display ?? stage.status;
    const stageNotApplicable = stageState === 'not_applicable';
    if (stageNotApplicable) { counts.notApplicable++; continue; }
    const completed = COMPLETED_STAGE_STATES.has(stageState);
    const future = !completed && !actionableProgressStage(stage);
    if (!check.verdict) { counts.pending++; if (future) counts.futurePending++; }
    if (check.verdict?.result === 'not_applicable') { counts.notApplicable++; if (future) counts.futureNotApplicable++; }
    if (check.verdict?.accepted === true) { counts.accepted++; if (future) counts.futureAccepted++; }
    if (!future) {
      counts.currentTotal++;
      if (!check.verdict) counts.currentMissing++;
      else if (check.verdict.current === false) counts.currentExpired++;
      else if (check.verdict.result === 'pass') counts.currentPass++;
      else if (check.verdict.result === 'not_applicable') counts.currentNotApplicable++;
      if (check.verdict?.current !== false && check.verdict?.accepted === true) counts.currentAccepted++;
    }
  }
  return counts;
}

/** L1 wording treats valid not-applicable and accepted readings as complete evidence, without calling them passes. */
export function progressEvidenceText(counts: ProgressCheckCounts): string {
  if (!counts.currentTotal) return '当前暂无有效检查。';
  const valid = counts.currentPass + counts.currentNotApplicable + counts.currentAccepted;
  const detail = `通过 ${counts.currentPass} · 不适用 ${counts.currentNotApplicable} · 已接受提醒 ${counts.currentAccepted}`;
  if (valid === counts.currentTotal && counts.currentMissing === 0 && counts.currentExpired === 0)
    return `当前有效检查正常：${detail}。`;
  return `当前检查证据未完整：${detail} · 待取证 ${counts.currentMissing} · 已过期 ${counts.currentExpired}。`;
}

export type ProgressSummaryStage = { id: string; display?: string; status: string; reasons: string[]; checks: ProgressCheckLike[];
  task?: { id: string; status: string; attempts: number } };
export type ProgressSummaryTask = { stage: string; status: string; needsYou?: boolean };
/** The three factual lines on L0; an unknown scheduler never turns into a claim that work is running. */
export function progressSummaryLines(input: { stages: ProgressSummaryStage[]; next?: string; scheduler?: string;
  productionState?: string; tasks?: ProgressSummaryTask[] }): [string, string, string] {
  const summary = progressStageSummary(input.stages);
  const completed = summary.completed.length ? `已完成 ${summary.completed.map(stage => stageLabel(stage.id)).join('、')}` : '暂无记录';
  const task = input.tasks?.find(item => ['RUNNING', 'VERIFYING', 'WAITING_HUMAN', 'READY'].includes(item.status));
  let current = '暂无记录';
  if (task?.status === 'WAITING_HUMAN') current = `等待你处理「${stageLabel(task.stage)}」`;
  else if (task?.status === 'READY') current = `待开始「${stageLabel(task.stage)}」`;
  else if (summary.current?.display === 'deciding' || input.productionState === 'awaiting_decision') current = '等待你的决定';
  else if (task && ['RUNNING', 'VERIFYING'].includes(task.status)) current = `正在${stageLabel(task.stage)}`;
  else if (input.productionState === 'working' && input.scheduler === 'running') current = '正在制作';
  else if (input.productionState === 'working' && input.scheduler && input.scheduler !== 'running') current = '后台已暂停，暂无新执行';
  else if (input.scheduler === undefined && input.productionState) current = '未知';
  let upcoming = '暂无记录';
  if (input.scheduler === undefined && input.next) upcoming = '未知';
  else if (input.next) upcoming = nextReading(input.next, input.scheduler === 'running').text || '暂无记录';
  return [completed, current, upcoming];
}

export type WorkbenchNeed = { key: string; source: '制作提案' | '待决定关口' | '未接受提醒' | '需要人工任务' | '制作中断待核对';
  title: string; detail: string; action: 'conversation' | 'check' | 'task' | 'recovery'; target?: string; };
export type TaskNeedAction = 'conversation' | 'recovery' | 'redo' | 'stage';
/** Temporary interaction failures are retried from their conversation; only formal Workflow Tasks support task.redo. */
export function taskNeedAction(task: { formal?: boolean; status: string }): TaskNeedAction {
  if (!task.formal) return 'conversation';
  if (task.status === 'RECOVERY_REQUIRED') return 'recovery';
  if (task.status === 'FAILED' || task.status === 'BLOCKED') return 'redo';
  return 'stage';
}
/** Keep the logical project's physical rows and the active successor workflow after continuation. */
export function projectRowsForWorkflow<T extends { project?: string; workflowId?: string }>(rows: T[], projectPath: string, workflowId?: string): T[] {
  return rows.filter(row => row.project === projectPath || Boolean(workflowId && row.workflowId === workflowId));
}
export function projectWorkspaceGates<T extends { project?: string; workflowId?: string }>(gates: T[], project: { path: string; workflow?: { id: string } }): T[] {
  return projectRowsForWorkflow(gates, project.path, project.workflow?.id);
}
export function projectForGate<P extends { path: string; name: string; workflow?: { id: string } }, G extends { project?: string; projectName?: string; workflowId?: string }>(projects: P[], gate: G): P | undefined {
  return projects.find(project => projectRowsForWorkflow([gate], project.path, project.workflow?.id).length > 0 || project.name === gate.projectName);
}
export function projectTaskRows<T extends { project?: string; workflowId?: string }>(tasks: T[], projectPath: string, workflowId?: string): T[] {
  return projectRowsForWorkflow(tasks, projectPath, workflowId);
}
/** DOM target for the identity-preserving L0 conversation jump; other needs stay in the work panel. */
export function workbenchConversationTarget(need: WorkbenchNeed): string | undefined {
  if (!need.target || need.action !== 'conversation') return undefined;
  return need.source === '制作提案' ? `production-proposal-${need.target}` : `gate-${need.target}`;
}
export function conversationNeedsRestore(need: WorkbenchNeed): boolean { return need.source === '待决定关口'; }
export function focusConversationNeed(need: WorkbenchNeed, restore: () => void, focus: (id: string) => void): void {
  if (conversationNeedsRestore(need)) restore();
  const id = workbenchConversationTarget(need);
  if (id) focus(id);
}
export function focusTaskConversation(taskId: string, setPane: (pane: 'main') => void, focus: (id: string) => void): void {
  setPane('main'); focus(`interaction-task-${taskId}`);
}
/** Merge L0 sources by workflow/stage/check identity so a gate or warning does not create duplicate rows. */
export function workbenchNeeds(input: {
  proposals: Array<{ id: string; workflowId?: string | null; status: string; request?: string }>;
  gates: Array<{ gate: string; workflowId: string; status: string; question: string; owner?: string }>;
  warnings: Array<{ workflowId: string; stageId: string; checkId: string; text: string }>;
  tasks: Array<{ id: string; workflowId?: string | null; stage: string; goal: string; needsYou: boolean; status: string; stageCodes?: string[] }>;
  interruptions: Array<{ id: string; workflowId?: string | null; taskId?: string; state: string; reason: string; canResume?: boolean }>;
}): WorkbenchNeed[] {
  const out: WorkbenchNeed[] = [], seen = new Set<string>();
  const add = (need: WorkbenchNeed) => { if (!seen.has(need.key)) { seen.add(need.key); out.push(need); } };
  for (const proposal of input.proposals.filter(item => item.status === 'proposed'))
    add({ key: `proposal:${proposal.workflowId ?? proposal.id}`, source: '制作提案', title: '制作提案待批准',
      detail: proposal.request ?? '请在项目对话中查看制作提案。', action: 'conversation', target: proposal.id });
  for (const gate of input.gates.filter(item => item.status === 'pending' || item.status === 'stale'))
    add({ key: `gate:${gate.workflowId}:${gate.gate}`, source: '待决定关口', title: gate.question, detail: '中栏决定卡是唯一批准入口。', action: 'conversation', target: gate.gate });
  for (const warning of input.warnings)
    add({ key: `check:${warning.workflowId}:${warning.stageId}:${warning.checkId}`, source: '未接受提醒', title: warning.text,
      detail: '请在制作进度的关注检查中查看当前读数。', action: 'check', target: warning.checkId });
  const interruptedTaskIds = new Set(input.interruptions.filter(item => ['interrupted', 'recovery_required'].includes(item.state))
    .map(item => item.taskId).filter((id): id is string => Boolean(id)));
  const warningStages = new Set(input.warnings.map(item => `${item.workflowId}:${item.stageId}`));
  for (const task of input.tasks.filter(item => item.needsYou && !interruptedTaskIds.has(item.id))) {
    // A task blocked only by unaccepted warnings is represented by those warning rows; retain independent human blockers.
    const stageKey = `${task.workflowId ?? ''}:${task.stage}`;
    if (task.stageCodes?.length && task.stageCodes.every(code => code === 'warning_unaccepted') && warningStages.has(stageKey)) continue;
    add({ key: `task:${task.workflowId ?? ''}:${task.id}`, source: '需要人工任务', title: task.goal,
      detail: task.status === 'RECOVERY_REQUIRED' ? '上次执行结果需要核对。' : '请查看阶段详情并继续处理。', action: task.status === 'RECOVERY_REQUIRED' ? 'recovery' : 'task', target: task.id });
  }
  for (const interruption of input.interruptions.filter(item => ['interrupted', 'recovery_required'].includes(item.state)))
    add({ key: interruption.taskId ? `task:${interruption.workflowId ?? ''}:${interruption.taskId}` : `interrupt:${interruption.workflowId ?? interruption.id}`,
      source: '制作中断待核对', title: '制作中断，等待核对', detail: interruption.reason,
      action: 'recovery', target: interruption.id });
  return out;
}
/** One stage row: name, state, a mark that does not rely on colour, and one line on why. */
export function stageView(stage: StageLike): { label: string; state: State; mark: string; note: string } {
  const shown = stage.display ?? stage.status;
  const counts = verdictCounts(stage.checks);
  const attempts = stage.task?.attempts ?? 0;
  const reasons = reasonsText(stage.reasons);
  const passed = counts.pass ? `${counts.pass} 项检查通过${counts.na ? `，${counts.na} 项不适用` : ''}` : counts.na ? `${counts.na} 项检查不适用` : '';
  // The workflow may still be open while its latest execution has stopped. Missing completion evidence alone must
  // not erase that execution's failure or suggest it has never started.
  if (shown !== 'passed' && shown !== 'not_applicable' && shown !== 'deciding') {
    const stopped: Record<string, { state: State; mark: string; note: string }> = {
      FAILED: { state: ['已中断', 'bad'], mark: '!', note: '处理未完成，继续制作前需要核对执行结果' },
      RECOVERY_REQUIRED: { state: ['中断待核对', 'warn'], mark: '!', note: '上次执行结果尚未确认，核对前不会重做' },
      BLOCKED: { state: ['未通过', 'bad'], mark: '✗', note: '生成结果未通过检查' },
      CANCELLED: { state: ['已取消', 'muted'], mark: '·', note: '这次处理已取消' },
    };
    const execution = stopped[stage.task?.status ?? ''];
    if (execution) return { label: stageLabel(stage.id), ...execution };
  }
  if (stage.id === 'face') {
    if (shown === 'passed') return { label: stageLabel(stage.id), state: ['工程检查通过', 'ok'], mark: '✓',
      note: `${passed || '工程记录已通过'}；脸型候选尚未进行视觉效果确认` };
    if (shown === 'not_applicable') return { label: stageLabel(stage.id), state: ['不适用', 'muted'], mark: '–',
      note: '当前方案不需要修改脸型，跳过这一步' };
    if (shown === 'running' && stage.task?.status === 'VERIFYING') return { label: stageLabel(stage.id), state: ['工程检查中', 'info'], mark: '▶',
      note: '正在独立检查脸型候选，尚未确认视觉效果' };
    if (shown === 'running' && stage.task?.status === 'RUNNING' && attempts <= 1) return { label: stageLabel(stage.id), state: ['处理中', 'info'], mark: '▶',
      note: '正在根据制作要求处理脸型，候选仍需工程检查与视觉效果确认' };
  }
  if (shown === 'running' && (attempts > 1 || counts.fail > 0))
    return { label: stageLabel(stage.id), state: ['返工中', 'warn'], mark: '↻',
      note: [counts.fail ? `${counts.fail} 项检查未通过` : '', `正在第 ${Math.max(attempts, 2)} 次执行`].filter(Boolean).join('，') };
  const note = shown === 'passed' ? passed || '已完成'
    : shown === 'running' ? '正在执行'
    : shown === 'deciding' ? [passed, reasonsText(stage.reasons.filter(reason => reason.startsWith('gate ')))].filter(Boolean).join(' · ')
    : shown === 'not_applicable' ? '方案不需要这一步'
    : reasons;
  if (shown === 'blocked') {
    // "Blocked" covers a stage that has simply not produced its evidence yet as much as one that failed a check.
    const failed = counts.fail > 0 || stage.reasons.some(reason => /^check \S+: violation|warning not accepted/.test(reason));
    const outOfBounds = stage.reasons.some(reason => reason.startsWith('out-of-bounds change:'));
    const stale = counts.stale > 0 || stage.reasons.some(reason => /: (stale verdict|stale decision)$/.test(reason));
    // A check that could not be measured is its own state with its own next step: "缺数据" points at measuring again,
    // not at repairing the avatar (信息包装规范 §2.3·负级别独立成组).
    const unmeasured = counts.noData > 0 || counts.error > 0 ||
      stage.reasons.some(reason => /^check \S+: (no_data|error)/.test(reason));
    const state: State = failed ? ['未通过', 'bad'] : outOfBounds ? ['有越界改动', 'bad'] : stale ? ['证据已过期', 'warn']
      : unmeasured ? ['缺数据，需要补测', 'info'] : ['待取证', 'info'];
    return { label: stageLabel(stage.id), state, mark: failed || outOfBounds ? '✗' : stale ? '!' : '·', note };
  }
  return { label: stageLabel(stage.id), state: stageState(shown), mark: stageMark(shown), note };
}

/** Archive next steps describe the user's problem; the original execution identifiers and errors stay in diagnostics. */
export function archiveNextView(step: { kind: string; text: string }): { text: string; action?: 'production' | 'archive' | 'share' } {
  if (step.kind === 'workflow') {
    if (/需要核对上次执行/.test(step.text)) return { text: '制作中断，上次执行结果尚未确认；核对前不会重做，已有成果保留。', action: 'production' };
    if (/执行失败|检查未通过/.test(step.text)) return { text: '制作未完成，需要核对执行结果后再继续；已有成果保留。', action: 'production' };
    return { text: '制作流程还有未完成的工作，请查看制作进度和待确认的决定。', action: 'production' };
  }
  if (step.kind === 'archive') return { text: '工程档案写入未完成，当前档案尚未通过校验。可以重新扫描并刷新档案。', action: 'archive' };
  if (step.kind === 'recovery') return { text: /没有得到|失败/.test(step.text)
    ? 'AI 接手分析未完成，暂不能按分析结果继续。请在「工程导入与 AI 恢复」中重新分析。'
    : '正在等待 AI 接手分析，完成后会显示接续建议。' };
  if (step.kind === 'classify' || step.kind === 'rights') return { text: step.text, action: 'share' };
  return { text: step.text };
}

/** Face images matter once the corresponding work has actually started; waiting stages are not preview errors. */
export function facePreviewMode(stages: StageLike[]): 'candidates' | 'output' | null {
  const started = (stage: StageLike | undefined) => Boolean(stage && (stage.display ?? stage.status) !== 'not_applicable' &&
    ((stage.task && (stage.task.attempts > 0 || ['RUNNING', 'VERIFYING'].includes(stage.task.status))) ||
      ['passed', 'deciding'].includes(stage.display ?? stage.status)));
  if (started(stages.find(stage => stage.id === 'face'))) return 'output';
  if (started(stages.find(stage => stage.id === 'face_design'))) return 'candidates';
  return null;
}

/** Runtime marks internal intent records; older payloads retain their explicit object identity as a fallback. */
export const archiveFactIsDiagnostic = (fact: { presentation?: string; objectId?: string }): boolean =>
  fact.presentation === 'diagnostic' || Boolean(fact.objectId?.startsWith('intent:'));

type CardProject = { name: string; path: string; workflow?: { status: string; next: string; stagesPassed?: number; stagesTotal?: number }; tasks: { total: number; open: number; needsYou: number };
  lastImport?: { unityVersion?: string; base?: string } };
type CardGate = { status: string; project?: string };
/** How many things wait for the person in a project: open decisions plus Tasks that need them. */
export const waitingIn = (project: CardProject, gates: CardGate[]): number =>
  gates.filter(gate => gate.project === project.path && isOpenGate(gate)).length + project.tasks.needsYou;
/** A project's state, derived once for its pill and its filters: not started, waiting for you, or the workflow's state. */
export function projectState(project: CardProject, gates: CardGate[]): State {
  if (!project.workflow) return ['尚未开始', 'muted'];
  const waiting = waitingIn(project, gates);
  if (waiting && project.workflow.status !== 'cancelled') return [`${waiting} 项等你`, 'warn'];
  return workflowState(project.workflow.status);
}
/** The card's main line: the next step in words, or how to start. */
export const cardNext = (project: CardProject, schedulerRunning: boolean): string =>
  project.workflow ? nextReading(project.workflow.next, schedulerRunning).text : '下一步：确认需求与素材，然后开始制作流程';
/** Share of finished Tasks, or null when there is nothing to measure yet (a Workflow without Tasks is not "done"). */
/** Share of the Workflow's stages that passed. Tasks exist only for stages that started, so they cannot measure it. */
export function cardProgress(project: CardProject): number | null {
  const passed = project.workflow?.stagesPassed, total = project.workflow?.stagesTotal;
  if (passed === undefined || !total) return null;
  return Math.min(1, Math.max(0, passed / total));
}
export const cardMeta = (project: CardProject): string =>
  [project.lastImport?.unityVersion ? `Unity ${project.lastImport.unityVersion}` : 'Unity 版本待识别', project.lastImport?.base].filter(Boolean).join(' · ');

/** The hues placeholder covers take; style.css gives each theme its saturation and lightness (contrast checked in the tests). */
export const PLACEHOLDER_HUES = [214, 250, 282, 330, 12, 38, 152, 186] as const;
/** A placeholder cover until a real preview exists: two characters of the name and a colour that stays with the project. */
export function placeholder(name: string): { text: string; hue: number } {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619) >>> 0;
  // "Luna-春樱" and "Luna-夏日泳装" share a prefix; the part after the dash tells them apart.
  const part = name.includes('-') ? name.slice(name.indexOf('-') + 1) || name : name;
  const chars = Array.from(part.trim() || name);
  const text = chars.slice(0, 2).join('');
  return { text: /^[a-z]/.test(text) ? text[0]!.toUpperCase() + text.slice(1) : text, hue: PLACEHOLDER_HUES[hash % PLACEHOLDER_HUES.length]! };
}

/** The style of an element with the `cover` class: only the hue, so the colours follow the light or dark theme. */
export const placeholderColors = (hue: number): Record<string, string> => ({ '--hue': String(hue) });

/**
 * Projects by their latest activity, newest first: the newest event of their Workflow or of the project itself (created,
 * for one). Projects without a recent event keep the Runtime's order after them. Nothing here is invented: the order is
 * only what events.recent shows.
 */
export function recentProjects<P extends { id: string; name: string; workflow?: { id: string } }>(projects: P[],
  events: Array<{ seq: number; workflowId: string | null; entityType?: string; entityId?: string }>,
  tasks: Array<{ workflowId?: string; projectName: string }> = []): P[] {
  const byWorkflow = new Map<string, string>();
  for (const task of tasks) {
    const owner = projects.find(project => project.name === task.projectName);
    if (task.workflowId && owner) byWorkflow.set(task.workflowId, owner.id);
  }
  for (const project of projects) if (project.workflow) byWorkflow.set(project.workflow.id, project.id);
  const latest = new Map<string, number>();
  for (const event of events) {
    const id = event.entityType === 'project' && event.entityId ? event.entityId : event.workflowId ? byWorkflow.get(event.workflowId) : undefined;
    if (id && (latest.get(id) ?? -1) < event.seq) latest.set(id, event.seq);
  }
  return projects.map((project, index) => ({ project, index, seq: latest.get(project.id) ?? -1 }))
    .sort((a, b) => b.seq - a.seq || a.index - b.index).map(item => item.project);
}

/** A location the person picks with the system dialog (gui/src/picker.ts): chosen, never typed (dev0.1 plan §3.4). */
export type PickFilter = { name: string; extensions: string[] };
export type PickOptions = { kind: 'directory' | 'file'; title: string; filters?: PickFilter[]; defaultPath?: string };
/** Besides a folder, what project.import unpacks (src/import/materialize.ts): archives and a .unitypackage. */
export const IMPORT_FILTERS: PickFilter[] = [{ name: '工程压缩包或 Unity 包', extensions: ['zip', '7z', 'rar', 'tar', 'gz', 'unitypackage'] }];
/** What a takeover source is, in words, as project.import will treat it: a folder, a Unity package, or an archive. */
export const importSourceLabel = (path: string, kind: 'directory' | 'file'): string =>
  kind === 'directory' ? '文件夹' : /\.unitypackage$/i.test(path) ? 'Unity 包' : '压缩包';
/** The Unity executable: Unity.exe on Windows; on Linux it has no extension, so nothing can be filtered by one. */
export const unityEditorFilters = (windows: boolean): PickFilter[] => windows ? [{ name: 'Unity 编辑器', extensions: ['exe'] }] : [];
/** The Unity version VRChat avatars are built with (src/unity-editors.ts, which the GUI cannot import). */
export const VRCHAT_UNITY = '2022.3.22f1';
/** One option of a location field: a path and a line that says where it came from. */
export type PathChoice = { value: string; note: string; detected: boolean };
/** The same location, however it is spelled: Windows paths ignore case and separator style. */
export function samePath(a: string, b: string): boolean {
  const key = (path: string) => /^[A-Za-z]:[\\/]/.test(path) ? path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : path.replace(/\/+$/, '');
  return key(a) === key(b);
}
/** A location field's options: what Harness found on this computer first, then the current value when it is another one. */
export function pathChoices(detected: string[], current: string, note: (path: string) => string): PathChoice[] {
  const found = detected.filter((path, index) => path && detected.findIndex(other => samePath(other, path)) === index);
  return [...found.map(value => ({ value, note: note(value), detected: true })),
    ...(current && !found.some(path => samePath(path, current)) ? [{ value: current, note: '你选择的位置', detected: false }] : [])];
}
/** A detected Unity editor in words: its version from the Hub folder it sits in, and whether VRChat uses that version. */
export function unityEditorNote(path: string): string {
  const parts = path.split(/[\\/]/);
  const version = parts[parts.lastIndexOf('Editor') - 1];
  if (!version || parts.lastIndexOf('Editor') < 1) return '在这台电脑上找到';
  return `Unity ${version} · 在这台电脑上找到${version === VRCHAT_UNITY ? ' · VRChat 头像使用的版本' : ''}`;
}

export type ProjectFilter = 'all' | 'active' | 'waiting' | 'new' | 'ended';
export const PROJECT_FILTERS: Array<[ProjectFilter, string]> = [['all', '全部'], ['active', '进行中'], ['waiting', '等你处理'], ['new', '未开始'],
  ['ended', '已结束']];
/** Projects matching a filter and a search text (name, base avatar or path). */
export function filterProjects<P extends CardProject>(projects: P[], gates: CardGate[], filter: ProjectFilter, query = ''): P[] {
  const text = query.trim().toLowerCase();
  const ended = (project: P) => project.workflow?.status === 'cancelled' || project.workflow?.status === 'client_verified';
  return projects.filter(project => {
    const matches = filter === 'all' ? true
      : filter === 'new' ? !project.workflow
      : filter === 'ended' ? ended(project)
      : filter === 'waiting' ? Boolean(project.workflow) && !ended(project) && waitingIn(project, gates) > 0
      : Boolean(project.workflow) && !ended(project);
    return matches && (!text || `${project.name} ${project.lastImport?.base ?? ''} ${project.path}`.toLowerCase().includes(text));
  });
}

/**
 * What starting production needs, as a checklist. Only the request blocks here: materials may also come from outfit
 * assignments or BOOTH files fetched for the project, which this count does not see, and the Runtime says so if none.
 */
export function startReadiness(input: { request: string; assets: number; variants: number }):
  { items: Array<{ label: string; done: boolean; hint: string; required: boolean; tab: 'design' | 'materials' }>; blocker?: string } {
  const items = [
    { label: '头像需求已填写', done: Boolean(input.request.trim()), required: true, tab: 'design' as const,
      hint: '在「设计目标」的「头像需求」里写清想要的风格、用途和禁忌。' },
    { label: '关联了素材', done: input.assets > 0, required: false, tab: 'materials' as const,
      hint: input.assets ? `${input.assets} 项已关联` : '在「素材」把素体和服装加入项目，或从 BOOTH 按需获取到本项目。' },
    { label: '衣装方案', done: input.variants > 0, required: false, tab: 'design' as const,
      hint: input.variants ? `${input.variants} 个方案` : '可选：想要多套造型时再建。' },
  ];
  const missing = items.filter(item => item.required && !item.done);
  return { items, ...(missing.length ? { blocker: `先完成：${missing.map(item => item.label).join('、')}` } : {}) };
}

/** What is missing on this computer for a production run, from setup.environment, in one line each. */
export function startWarnings(dependencies: Array<{ id: string; name: string; required: boolean; ok: boolean }>): string[] {
  const missing = dependencies.filter(item => item.required && !item.ok);
  const warnings = missing.map(item => item.id === 'unity' ? 'Unity 编辑器尚未配置：含 Unity 步骤的阶段会停下等你配置' : `缺少必需依赖：${item.name}`);
  const ai = dependencies.filter(item => item.id === 'codex' || item.id === 'claude' || item.id === 'pi');
  if (ai.length && !ai.some(item => item.ok)) warnings.push('没有可用的 AI 执行方：请安装 Codex CLI、Claude Code 或 pi（DeepSeek、GLM）');
  return warnings;
}

/**
 * The three capabilities the readiness step reports separately rather than as one "ready" (01_初始化与AI接入.md
 * §首次启动四步; 决定记录/D-19). Management needs neither AI nor Unity; production needs a configured AI route;
 * previews are rendered by Unity, so a missing editor only delays them. Each line carries its own reason.
 */
export type ReadinessRow = { label: string; available: boolean; line: string };
export function readinessRows(input: { blockers?: string[]; ai: boolean; unity: boolean }): ReadinessRow[] {
  const blockers = input.blockers ?? [];
  const row = (label: string, available: boolean, reason: string): ReadinessRow =>
    ({ label, available, line: `${label}：${available ? '可用' : `不可用（${reason}）`}` });
  return [
    row('管理', blockers.length === 0, `缺少${blockers.join('、')}`),
    row('制作', input.ai, '未配置密钥'),
    row('预览', input.unity, '缺少 Unity 编辑器'),
  ];
}

/** Why the "fetch selected files" button is disabled, or nothing when it can be used. */
export function materializeBlocker(input: { project: string; files: number; busy: boolean }): string {
  if (input.busy) return '正在处理上一项操作';
  if (!input.files) return '先勾选要获取的文件';
  if (!input.project) return '先选择使用这些文件的项目';
  return '';
}
/** BOOTH connection in one line of facts, instead of four figure cards. */
export const boothLine = (status: { connected: boolean; owned: number; files: number; materialized: number }): string =>
  status.connected ? `已连接 · ${status.owned} 件已购 · ${status.files} 个远端文件 · ${status.materialized} 个已获取` : '未连接 BOOTH';

type DependencyLike = { ok: boolean; required: boolean; detail: string };
/** A dependency's state: only what is missing or degraded draws attention; what works stays quiet. */
export function dependencyState(item: DependencyLike): State {
  if (item.ok) return /degraded|降级/.test(item.detail) ? ['注意', 'warn'] : ['正常', 'muted'];
  return item.required ? ['缺少', 'bad'] : ['可选', 'muted'];
}
/** Missing required dependencies, for the reason beside a blocked "finish setup" button. */
export const missingRequired = (items: Array<DependencyLike & { name: string }>): string[] =>
  items.filter(item => item.required && !item.ok).map(item => item.name);
/**
 * What blocks the first setup. Unity is not among it: the wizard uses an editor it found, the directory step can name
 * another, and a Workflow that needs Unity says so before it starts.
 */
export const firstRunBlockers = (items: Array<DependencyLike & { id: string; name: string }>): string[] =>
  missingRequired(items.filter(item => item.id !== 'unity'));

/**
 * Events grouped by project, newest first: a Workflow's events belong to its project; events without one (catalogue,
 * packs, workspace) go under 其他. Groups are ordered by their newest event.
 */
export function groupEvents<E extends { workflowId: string | null; seq: number }>(events: E[],
  tasks: Array<{ workflowId?: string; projectName: string }>, projects: Array<{ name: string; workflow?: { id: string } }>): Array<[string, E[]]> {
  const owner = new Map<string, string>();
  for (const task of tasks) if (task.workflowId) owner.set(task.workflowId, task.projectName);
  for (const project of projects) if (project.workflow) owner.set(project.workflow.id, project.name);
  const groups = new Map<string, E[]>();
  for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
    const name = (event.workflowId && owner.get(event.workflowId)) || '其他';
    groups.set(name, [...(groups.get(name) ?? []), event]);
  }
  return [...groups];
}

/** The dependency rows in the clusters a person reads; a row no cluster names goes under 其他. */
export const DEPENDENCY_GROUPS: ReadonlyArray<{ id: string; title: string; ids: readonly string[] }> = [
  { id: 'harness', title: 'Harness 本身', ids: ['node', 'avh-win', 'bwrap', 'systemd', 'browser'] },
  { id: 'tools', title: '基础工具', ids: ['git', 'python', 'layered-recolor', '7z', 'dotnet', 'pwsh'] },
  { id: 'unity', title: 'Unity', ids: ['unity-hub', 'unity', 'unity-license', 'vpm'] },
  { id: 'face', title: '脸型设计（可选）', ids: ['blender'] },
  { id: 'ai', title: 'AI 工具', ids: ['npm', 'codex', 'claude', 'pi'] },
];
export type DependencyGroup<T> = { id: string; title: string; items: T[]; attention: boolean; summary: string };
/**
 * One summary line per cluster. A cluster needs attention, and opens, only when something in it is missing and required,
 * is about to be installed (`planned`), or is degraded; what works stays folded away.
 */
export function dependencyGroups<T extends DependencyLike & { id: string; name: string }>(items: T[], planned: readonly string[] = []): DependencyGroup<T>[] {
  const named = new Set(DEPENDENCY_GROUPS.flatMap(group => group.ids));
  const groups = [...DEPENDENCY_GROUPS, { id: 'other', title: '其他', ids: items.map(item => item.id).filter(id => !named.has(id)) }];
  return groups.map(group => {
    const members = group.ids.flatMap(id => items.filter(item => item.id === id));
    const will = members.filter(item => !item.ok && planned.includes(item.id));
    const lacking = members.filter(item => !item.ok && !planned.includes(item.id) && item.required);
    const optional = members.filter(item => !item.ok && !planned.includes(item.id) && !item.required);
    const degraded = members.filter(item => item.ok && dependencyState(item)[1] === 'warn');
    const parts = [...(will.length ? [`将自动安装 ${will.map(item => item.name).join('、')}`] : []),
      ...(lacking.length ? [`缺少 ${lacking.map(item => item.name).join('、')}`] : []),
      ...(degraded.length ? [`需要注意 ${degraded.map(item => item.name).join('、')}`] : []),
      ...(optional.length ? [`${optional.map(item => item.name).join('、')} 未就绪`] : [])];
    return { id: group.id, title: group.title, items: members, attention: Boolean(will.length || lacking.length || degraded.length),
      summary: parts.length ? parts.join('；') : '全部就绪' };
  }).filter(group => group.items.length);
}

/** Windows setup choices: the person's switches for the optional items, with the Runtime's defaults (windows-setup.ts). */
export type SetupChoices = { utf8: boolean; pythonUtf8: boolean; unity: boolean; android: boolean; defender: boolean; codex: boolean;
  claude: boolean; pi: boolean; blender: boolean };
export const DEFAULT_SETUP_CHOICES: SetupChoices = { utf8: true, pythonUtf8: true, unity: true, android: false, defender: false,
  codex: true, claude: true, pi: true, blender: false };
type Choosable = { id: string; toggles?: string[]; requires?: string[]; onlyFor?: string[] };
/** The items a run with these choices includes, as the Runtime decides it (includedItems in windows-setup.ts). */
export function chosenItems<T extends Choosable>(items: T[], choices: Partial<SetupChoices>): T[] {
  const on = choices as Partial<Record<string, boolean>>;
  const all = new Set(items.map(item => item.id));
  let chosen = items.filter(item => !item.toggles?.length || item.toggles.some(toggle => on[toggle]));
  for (;;) {
    const ids = new Set(chosen.map(item => item.id));
    const next = chosen.filter(item => (item.requires ?? []).every(need => !all.has(need) || ids.has(need))
      && (!item.onlyFor?.length || item.onlyFor.some(other => ids.has(other))));
    if (next.length === chosen.length) return next;
    chosen = next;
  }
}
/** A rough download size in words. */
export const sizeText = (mb: number): string => mb >= 1000 ? `约 ${(mb / 1000).toFixed(1)} GB` : `约 ${Math.max(1, Math.round(mb))} MB`;
/** The one button's words: whether it will ask for administrator permission, and whether there is anything to do. */
export function setupButton(items: Array<{ phase: 'machine' | 'user' }>): { label: string; disabled: boolean } {
  if (!items.length) return { label: '没有需要做的事', disabled: true };
  return items.some(item => item.phase === 'machine')
    ? { label: '开始配置（会请求一次管理员授权）', disabled: false } : { label: '开始安装（不需要管理员授权）', disabled: false };
}
/** A setup step's state as a word with its tone. */
export function setupStepState(status: string): State {
  return ({ pending: ['等待', 'muted'], running: ['进行中', 'info'], done: ['完成', 'ok'], skipped: ['跳过', 'muted'], failed: ['失败', 'bad'] } as
    Record<string, State>)[status] ?? [status, 'muted'];
}

/** Services the GUI offers through pi, each with the person's own API key (src/shared/pi.ts holds their defaults). */
export type { PiUpstream };
/** The credential each service's key is stored under unless the configuration names another. */
export const PI_SECRETS: Record<PiUpstream, string> = { deepseek: PI_UPSTREAMS.deepseek.secret, zai: PI_UPSTREAMS.zai.secret,
  zhipu: PI_UPSTREAMS.zhipu.secret };
/** The pi part of the AI choices as a form holds it: DeepSeek, and GLM in one region (国内 by default). */
export type PiState = { deepseek: boolean; glm: boolean; region: 'zhipu' | 'zai'; deepseekModel: string; glmModel: string; glmBaseUrl: string };
export const NO_PI: PiState = { deepseek: false, glm: false, region: 'zhipu', deepseekModel: '', glmModel: '', glmBaseUrl: '' };
export type PiProviderView = { type: string; upstream?: string; model?: string; baseUrl?: string; secret?: string };
/** The form state for the pi Providers config.view lists (an empty model or address means the service's default). */
export function piStateFrom(providers: PiProviderView[]): PiState {
  const deepseek = providers.find(provider => provider.type === 'pi-cli' && provider.upstream === 'deepseek');
  const glm = providers.find(provider => provider.type === 'pi-cli' && (provider.upstream === 'zai' || provider.upstream === 'zhipu'));
  return { deepseek: Boolean(deepseek), glm: Boolean(glm), region: glm?.upstream === 'zai' ? 'zai' : 'zhipu',
    deepseekModel: deepseek?.model ?? '', glmModel: glm?.model ?? '', glmBaseUrl: glm?.baseUrl ?? '' };
}
/** What setup.initialize and config.update take: one choice per service turned on, defaults left out. */
export function piChoicesFrom(state: PiState): Array<{ upstream: PiUpstream; model?: string; baseUrl?: string }> {
  const choice = (upstream: PiUpstream, model: string, baseUrl = '') => ({ upstream,
    ...(model.trim() ? { model: model.trim() } : {}), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) });
  return [...(state.deepseek ? [choice('deepseek', state.deepseekModel)] : []),
    ...(state.glm ? [choice(state.region, state.glmModel, state.glmBaseUrl)] : [])];
}
/** The credential a service's key field stands for: the configured Provider's own, or the service's default. */
export function piSecretFor(upstream: PiUpstream, providers: PiProviderView[]): string {
  return providers.find(provider => provider.type === 'pi-cli' && provider.upstream === upstream)?.secret ?? PI_SECRETS[upstream];
}

/**
 * A production proposal and the run it may have started have two different lifecycles. They used to share one mapping
 * with the run's state falling back to the proposal's status, so a state the run had (中断待核对) and a status the
 * proposal had (等待批准) could be read through the same slot — the four-state risk the review asked to verify
 * (信息包装规范 §6.3). They are kept apart here, and a value neither list names says so instead of guessing.
 */
export type ProductionProgress = { state: string; reason: string; token: string; canResume: boolean; canCancel: boolean; taskId?: string;
  connectionRetrying?: boolean; recovery?: { commandId: string; status: 'running' | 'failed' | 'succeeded' | 'unknown';
    phase?: 'preserving' | 'observing' | 'committing'; error?: string } };
export type ProductionLike = { id: string; revision: number; request: string; status: string; workflowId: string | null;
  inputs: Array<{ id: string; name: string; kind: string }>; progress?: ProductionProgress };
/** The proposal's own status, before any run exists. */
const PROPOSAL_STATE: Record<string, State> = {
  proposed: ['等待批准', 'warn'], working: ['已受理，等后台开始', 'info'], ready: ['待你确认结果', 'warn'],
  completed: ['已确认', 'ok'], cancelled: ['已取消', 'muted'],
};
/** The run's progress, which is what the person watches after approving. */
const PROGRESS_STATE: Record<string, State> = {
  working: ['制作中', 'info'], interrupted: ['制作未完成', 'bad'], recovery_required: ['中断待核对', 'warn'],
  resuming: ['正在继续', 'info'], stopping: ['正在停止', 'warn'], awaiting_decision: ['等待你的决定', 'warn'],
  ready: ['待你确认结果', 'warn'], completed: ['已确认', 'ok'], cancelled: ['已取消', 'muted'],
};
/** What the proposal or its run is doing, as one state. Neither list claims the other's values. */
export function productionState(proposal: ProductionLike): State {
  const state = proposal.progress?.state;
  if (state) return PROGRESS_STATE[state] ?? [`制作状态正在确认（${state}）`, 'muted'];
  return PROPOSAL_STATE[proposal.status] ?? [`提案状态正在确认（${proposal.status}）`, 'muted'];
}
export const productionLabel = (proposal: ProductionLike): string => productionState(proposal)[0];

/** Sharing a project, restoring one, and the diagnostics bundle (D-133): what a person reads while a job runs. */
const PHASES: Record<string, string> = {
  'safe-point': '写入并校验工程档案', walk: '遍历工程文件', digest: '校验内容并检查敏感信息', copy: '按清单复制到暂存目录', pack: '用 7z 打包',
  test: '7z 完整性测试', verify: '冷解包并逐个校验', list: '读取分享包', extract: '解压到隔离目录', place: '放置工程', rebuild: '重建项目状态',
  packs: '恢复能力包',
  // The diagnostics export (`avh project diagnose`, src/diagnostics/diagnose.ts) reports the same shape of progress.
  compile: '汇总状态、判据与日志窗口', bundle: '写出诊断包成员', scan: '逐成员复扫密钥、路径与本地词表', write: '写出诊断包',
};
export function jobText(progress: { phase: string; done?: number; total?: number } | undefined | null): string {
  if (!progress) return '正在准备…';
  const label = PHASES[progress.phase] ?? progress.phase;
  return progress.total ? `${label}（${progress.done ?? 0} / ${progress.total}）` : `${label}…`;
}
export const jobShare = (progress: { done?: number; total?: number } | undefined | null): number | null =>
  progress?.total ? Math.min(1, (progress.done ?? 0) / progress.total) : null;
export const bytesText = (bytes: number): string => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
  : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * What a person can do about each share blocker right there: register the files' transfer rights, let a reviewed file
 * go, or change the files themselves (a credential, a link) and check again. Harness decides none of these for them.
 */
export type BlockerAction = 'classify' | 'rights' | 'acknowledge' | 'recheck';
export function blockerAction(code: string): BlockerAction {
  if (code === 'unclassified') return 'classify';
  if (code === 'rights') return 'rights';
  if (code === 'needs_review') return 'acknowledge';
  return 'recheck';
}
/** The layer a person's registration of a group gets: the Unity project body is needed to go on (A); the rest is optional (B). */
export function groupLayer(path: string): 'A' | 'B' {
  return /^(Assets|Packages|ProjectSettings)(\/|\.meta$|$)/.test(path) ? 'A' : 'B';
}
/** A group as `project.files.classify` takes it: a folder (ends with `/`) as a tree, anything else as one file. */
export const groupRegistration = (path: string): { path: string; match: 'tree' | 'file' } => ({ path, match: path.endsWith('/') ? 'tree' : 'file' });
export type Option = { value: string; label: string };
/**
 * The models settings offers for a service: its default (the empty value, so it follows Harness), the other known models,
 * and a model the configuration file names that is not among them, so saving never changes it unasked.
 */
export function piModelOptions(upstream: PiUpstream, current: string): Option[] {
  const fallback = PI_UPSTREAMS[upstream].model, chosen = current.trim();
  const options = [{ value: '', label: `${fallback}（默认）` },
    ...PI_MODELS[upstream].filter(model => model !== fallback).map(model => ({ value: model, label: model }))];
  return chosen && chosen !== fallback && !PI_MODELS[upstream].includes(chosen)
    ? [...options, { value: chosen, label: `${chosen}（配置文件里的写法）` }] : options;
}
/** GLM's address: the region's Coding Plan (the default), its pay-as-you-go address, or one the configuration file names. */
export function piAddressOptions(region: 'zhipu' | 'zai', current: string): Option[] {
  const chosen = current.trim();
  const options = [{ value: '', label: 'GLM Coding Plan（默认）' }, { value: PI_PAY_AS_YOU_GO[region], label: '按用量计费（没有 Coding Plan 的密钥）' }];
  return chosen && !options.some(option => option.value === chosen) ? [...options, { value: chosen, label: `配置文件里的地址：${chosen}` }] : options;
}
/**
 * Another GLM region: the pay-as-you-go address follows the region, and a model the new region's catalog lacks goes back to
 * the default; an address the configuration file names stays as it is.
 */
export function piRegionChange(state: PiState, region: 'zhipu' | 'zai'): PiState {
  const other = region === 'zhipu' ? 'zai' : 'zhipu';
  return { ...state, region, glmBaseUrl: state.glmBaseUrl.trim() === PI_PAY_AS_YOU_GO[other] ? PI_PAY_AS_YOU_GO[region] : state.glmBaseUrl,
    glmModel: !state.glmModel.trim() || PI_MODELS[region].includes(state.glmModel.trim()) ? state.glmModel : '' };
}
