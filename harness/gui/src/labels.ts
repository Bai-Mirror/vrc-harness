/**
 * The GUI's words for everything it shows: the shared vocabulary (src/shared/labels.ts, also used by the TUI) plus the
 * values only the GUI shows, and translators for the Runtime's machine sentences (stage reasons, next steps, events).
 * Pure functions without DOM or React, so test/gui/labels.test.ts runs them under Node.
 */
import { lookup, stageLabel, taskState, workflowState, type State, type Tone } from '../../src/shared/labels.ts';
import { GATE_TITLES, observerLabel } from '../../src/shared/projection.ts';

export * from '../../src/shared/labels.ts';
/** The four-state reading of the Runtime's next step is derived once for both interfaces (src/shared/projection.ts). */
export * from '../../src/shared/projection.ts';

type Table = Record<string, readonly [string, Tone]>;
const table = (name: string, entries: Table) => (value: string | null | undefined): State => lookup(name, entries, value ?? '');
/** Words without a tone, for values that are facts rather than states (kinds, roles, names). */
function words(name: string, entries: Record<string, string>): (value: string | null | undefined) => string {
  const states: Table = Object.fromEntries(Object.entries(entries).map(([key, text]) => [key, [text, 'muted'] as const]));
  return value => lookup(name, states, value ?? '')[0];
}

export const briefState = table('brief', { draft: ['草稿', 'muted'], direction_pending: ['方向待确认', 'warn'],
  direction_approved: ['方向已确认', 'ok'], archived: ['已归档', 'muted'] });
export const variantState = table('variant', { planned: ['已规划', 'muted'], working: ['制作中', 'info'], delivery: ['可交付', 'ok'],
  archived: ['已归档', 'muted'] });
export const rootRole = words('root role', { baseline: '共同基线', working: '施工根', plugin_derivative: '插件派生根', delivery: '交付根' });
export const assetKind = words('asset kind', { avatar: '角色', outfit: '服装', texture: '贴图', animation: '动画', package: '素材包', other: '其他' });
export const assetState = table('asset status', { candidate: ['待确认', 'warn'], ready: ['可使用', 'ok'], blocked: ['有问题', 'bad'],
  archived: ['归档', 'muted'] });
export const assetRole = table('asset role', { candidate: ['候选', 'info'], source: ['来源', 'muted'], used: ['已使用', 'ok'],
  rejected: ['不使用', 'muted'] });
export const takeoverMode = words('takeover mode', { observe: '仅分析', shallow: '浅接手', deep: '深度改造' });
export const sourceKind = words('import source', { folder: '文件夹', archive: '压缩包', unitypackage: 'UnityPackage' });
export const recoveryState = table('recovery', { analysis_pending: ['AI 分析中', 'info'], ready: ['分析完成', 'ok'],
  apply_pending: ['改造中', 'info'], failed: ['失败', 'bad'] });
export const messageState = table('message', { note: ['备注', 'muted'], proposed: ['待确认', 'warn'], accepted: ['已采纳', 'ok'],
  rejected: ['未采纳', 'muted'] });
export const severityLabel = words('severity', { blocking: '必须通过', warning: '需要确认', advisory: '仅提示' });
/** A process supplied label is display metadata; older definitions fall back to stable stage/observer words. */
export const checkLabel = (check: { label?: string; stageId?: string; observe: string }): string =>
  check.label?.trim() || `${check.stageId ? stageLabel(check.stageId) : '检查'} · ${observerLabel(check.observe)}`;
/** One result word for the compact progress list; details such as severity live in L2. */
export const checkResultWord = (check: { severity?: string; acceptanceRequired?: boolean; verdict?: { result: string; current: boolean } }): string => {
  if (!check.verdict) return '待取证';
  if (!check.verdict.current) return '过期';
  if (check.verdict.result === 'pass') return check.acceptanceRequired ? '未接受' : '通过';
  return ({ violation: '不符合', no_data: '缺数据', error: '出错', undecidable: '无法判定', not_applicable: '不适用' } as Record<string, string>)[check.verdict.result] ?? '无法判定';
};
export const doctorState = table('doctor', { OK: ['正常', 'ok'], FAIL: ['失败', 'bad'], NOTICE: ['注意', 'warn'], MISSING: ['缺少', 'bad'],
  OPTIONAL: ['可选', 'muted'] });
export const authoringState = table('candidate authoring', { prepared: ['已准备', 'muted'], running: ['生成中', 'info'],
  registered: ['已登记为候选', 'ok'], failed: ['失败', 'bad'], cancelled: ['已取消', 'muted'] });
export const contributionState = table('contribution', { authorized: ['已授权', 'info'], exported: ['已导出', 'info'],
  submitted: ['已回传', 'ok'], failed: ['回传失败', 'bad'], cancelled: ['已取消', 'muted'] });
export const trialState = table('candidate trial', { approved: ['已批准试用', 'info'], active: ['试用中', 'info'],
  disabled: ['已自动停止', 'bad'], completed: ['已结束', 'muted'] });
export const candidateState = table('candidate', { generated: ['待评测', 'muted'], evaluating: ['评测中', 'info'], evaluated: ['已评测', 'ok'],
  rejected: ['未通过', 'bad'], failed: ['失败', 'bad'],
  // Not "排队回传": a queued record is waiting on this computer and leaves only when the person sends it. The old word
  // read as an automatic upload, which the product does not do (信息包装规范 §6.4, BOUNDARY/B12).
  queued: ['已准备，等你发送', 'info'], submitted: ['已发送', 'ok'] });
export const candidateSource = words('candidate source', { ai: 'AI 生成', distill: '案例提炼', human: '人工编写', import: '导入' });
export const packChannel = words('pack channel', { builtin: '随应用提供', candidate: '候选', stable: '稳定版', release: '正式发行' });
export const boothFileState = table('booth file', { indexed: ['已索引', 'muted'], available: ['可获取', 'ok'],
  login_required: ['需要登录', 'warn'], unavailable: ['不可获取', 'bad'] });
export const providerType = words('provider type', { 'codex-cli': 'Codex CLI', 'claude-cli': 'Claude Code', 'legacy-dsh-task': 'DSH（旧版）',
  'pi-cli': 'pi' });
const PROFILE_TITLES: Record<string, string> = { 'pc-recolor-outfit': 'PC 改色与换装' };
export const profileTitle = (id: string): string => PROFILE_TITLES[id] ?? id;

/** Login and health of an AI provider: "not probed yet" differs from "probed and still unknown". */
const providerLogin = table('provider login', { ready: ['已登录', 'ok'], missing: ['未登录', 'bad'], unknown: ['未知', 'muted'] });
const providerHealth = table('provider health', { ready: ['可用', 'ok'], unavailable: ['不可用', 'bad'], unknown: ['未知', 'muted'] });
/** pi signs in with the person's own API key, which Harness stores; its "login" is whether that key is there. */
const providerKey = table('provider key', { ready: ['已保存', 'ok'], missing: ['未保存', 'bad'], unknown: ['未知', 'muted'] });
export function providerStates(provider: { type?: string; state?: string; login?: string; health?: string }): { login: State; health: State } {
  if (!provider.state || provider.state === 'declared') return { login: ['未探测', 'muted'], health: ['未探测', 'muted'] };
  return { login: provider.type === 'pi-cli' ? providerKey(provider.login) : providerLogin(provider.login), health: providerHealth(provider.health) };
}
/** What the login line calls a Provider's credential: a CLI login, or (pi) an API key. */
export const providerLoginName = (type: string | undefined): string => type === 'pi-cli' ? 'API 密钥' : '登录';

const ENTITY_ACTIONS: Record<string, string> = {
  'project:created': '新建了项目', 'workflow:created': '开始了制作流程', 'workspace:registered': '登记了工作区',
  'project_message:proposed': '提出了修改要求', 'asset:saved': '更新了素材库', 'asset:removed': '从素材库移除了一项',
  'project_asset:attached': '把素材关联到项目', 'gate:approved': '批准了一项决定', 'gate:rejected': '驳回了一项决定',
  'managed_pack:installed': '安装了能力包', 'managed_pack:activated': '切换了能力版本', 'provider_snapshot:frozen': '固定了执行方配置',
  'booth:sync_finished': '完成了 BOOTH 同步', 'booth:sync_stopped': 'BOOTH 同步中途停止',
  'booth:materialize_finished': '取回了 BOOTH 素材文件', 'booth:materialize_stopped': '取回 BOOTH 素材中途停止',
  'vpm:check': '检查了 VPM 包', 'vpm:resolve': '解析了 VPM 依赖', 'vpm:add': '添加了 VPM 包', 'vpm:remove': '移除了 VPM 包',
  'vpm:migrate': '迁移了 VPM 工程', 'vpm:migrate-unity2022': '迁移了 VPM 工程',
};
const ACTIONS: Record<string, string> = {
  created: '已创建', registered: '已登记', proposed: '提出了修改要求', saved: '已保存', removed: '已移除', attached: '已关联',
  approved: '已批准', rejected: '已驳回', installed: '已安装', activated: '已启用', evaluated: '完成了候选评测',
  auto_disabled: '自动停止了候选试用', requested_redo: '请求重做', route_waiting: '等待可用的执行方', provider_selected: '选定了执行方',
  context_compiled: '准备了阶段上下文', frozen: '固定了配置', launched: '启动了执行单元', acked: '执行单元已确认启动',
  observed: '采集了证据', recorded: '记录了检查结论', verified: '完成了检查', evidence_invalidated: '证据已失效', cancelled: '已取消',
  accepted_changes: '接受了越界改动', accepted: '已接受', unity_unit_intended: '准备启动 Unity 步骤', unity_step_failed: 'Unity 步骤失败',
  unity_waiting: '等待 Unity 批处理槽位', unity_handoff_reclaimed: '回收了崩溃残留的 Unity 交接锁',
  prepare_unit_intended: '准备执行单元', orphan_run_unconfirmed: '上次执行无法确认', projection_failed: '项目状态文件写入失败',
  tick_failed: '调度循环出错', scheduler_lease_taken_over: '接管了调度', verification_cancel_confirmed: '检查已取消',
  recovered_no_side_effects: '核对完成：无副作用，重新排队', recovered_reconciled: '核对完成：交给检查判定',
  cancelled_no_side_effects: '已取消（无副作用）', plan_revised: '写出了新的方案版本', plan_unreadable: '方案文件读不出来',
  sync_finished: '完成了 BOOTH 同步', sync_stopped: 'BOOTH 同步中途停止', materialize_finished: '取回了 BOOTH 素材文件',
  materialize_stopped: '取回 BOOTH 素材中途停止',
};
/** An event's action as a sentence; unknown actions are "其他事件" and keep their raw name for the details. */
export function actionText(event: { action: string; entityType?: string; entityId?: string; stageId?: string; subject?: string }):
  { text: string; known: boolean } {
  // Say what the event is about: the stage for a task, the decision for a gate, the name for an asset.
  const about = event.stageId ? stageLabel(event.stageId)
    : event.entityType === 'gate' && event.entityId?.includes(':') ? GATE_TITLES[event.entityId.slice(event.entityId.lastIndexOf(':') + 1)]
    : event.subject;
  const prefixed = (text: string): string => about ? `${about}：${text.replace(/^任务：/, '')}` : text;
  const specific = event.entityType ? ENTITY_ACTIONS[`${event.entityType}:${event.action}`] : undefined;
  if (specific) return { text: prefixed(specific), known: true };
  const transition = /^(\w+)->(\w+)$/.exec(event.action);
  if (transition) {
    const to = transition[2]!;
    if (/^[A-Z_]+$/.test(to)) return { text: prefixed(`任务：${taskState(to)[0]}`), known: true };
    return { text: `制作流程：${workflowState(to)[0]}`, known: true };
  }
  const text = Object.hasOwn(ACTIONS, event.action) ? ACTIONS[event.action] : undefined;
  return text ? { text, known: true } : { text: '其他事件', known: false };
}
/** Event reasons are often English notes for developers; only a reason written for people is shown. */
export const readableReason = (reason: string): string => /[㐀-鿿]/.test(reason) ? reason : '';
export const contextChange = words('context change', { added: '新增', removed: '删除', unchanged: '未变', 'content-changed': '内容变化',
  'reason-changed': '选用理由变化', 'selection-changed': '是否注入变化' });
/** What happens around a decision on each artifact, in one sentence. */
export const gateHint = words('gate hint', {
  assets: '素材清单已整理好；确认缺口后开始写制作方案。',
  plan: '批准后，后台按这个方案准备工程，并按需要处理脸型、装配服装和改色。',
  materials: '配色已应用到工程；确认效果后可继续制作菜单。',
  delivery_package: '交付包已经生成。',
});
