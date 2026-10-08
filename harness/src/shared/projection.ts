/**
 * One derivation of "what is happening" for every interface (src/tui and gui/src): the four states the person reads
 * (做了什么／在做什么／准备做什么／需要我做什么, 决定记录 D-41) and the words for the Runtime's machine sentences.
 *
 * The GUI translated the Runtime's next-step sentence and the TUI printed it as it came out of the Runtime, so one
 * workflow was described two different ways depending on which front end was open. The sentence is derived here once and
 * classified here once; each interface only chooses how to draw it.
 *
 * No imports beyond the shared vocabulary, and no platform APIs: the Runtime and the TUI load this file directly and
 * the GUI bundles it.
 */
import { stageLabel, taskState } from './labels.ts';

/** What each observer checks, so a check reads as a subject rather than an id. */
export const observerLabel = (id: string): string => ({
  'assets.validate': '素材校验', 'assets.inventory': '素材清单核对', 'assets.import': '素材导入',
  'plan.inputs': '制作输入核对', 'plan.source': '制作方案核对', 'environment.verify': '制作环境一致性',
  'project.initialize': '工程初始化', 'face.candidates': '脸型候选检查', 'face.input': '脸型采用版本核对', 'face.apply': '脸型工程检查',
  'clothing.install': '服装装配', 'material.recolor': '改色结果', 'menu.configure': '菜单配置',
  'menu.dump': '菜单与参数', 'avatar.build': '头像构建', 'avatar.observe': '头像观测', 'avatar.verify': '头像校验',
  'avatar.fit': '贴合检查', 'performance.check': '性能指标', 'delivery.package': '交付包内容',
  'delivery.cold_import': '干净工程导入',
}[id] ?? id);

/** What a plan or decision binds, for the person deciding about it. */
export const artifactLabel = (id: string): string => ({
  assets: '素材清单', plan: '制作方案', environment: '制作环境', fbx: '工程基线', face_input: '已采用脸型', face_candidates: '脸型候选方案',
  face: '脸型工程候选', outfits: '服装装配', materials: '配色材质', menu: '换装菜单', build_pre: '首次构建',
  optimization: '优化结果', build: '最终构建', delivery_package: '交付包',
}[id] ?? id);

export const GATE_TITLES: Record<string, string> = { material_gap_confirm: '确认素材缺口', plan_approval: '批准制作方案',
  face_choice: '选择脸型候选', face_appearance: '确认脸型效果', recolor_approval: '确认配色效果', sdk_upload: '上传到 VRChat',
  client_test: '客户端实测' };
export const gateLabel = (id: string): string => GATE_TITLES[id] ?? id.replaceAll('_', ' ');

/** One Runtime reason for a stage (src/process/aggregate.ts), in the person's words; undefined when it has none. */
export function reasonText(reason: string): string | undefined {
  let m: RegExpExecArray | null;
  if ((m = /^needs (\S+): not satisfied$/.exec(reason))) return `等「${stageLabel(m[1]!)}」完成`;
  if (/^check \S+: missing verdict$/.test(reason)) return '检查待取证';
  if (/^check \S+: stale verdict$/.test(reason)) return '检查证据已过期';
  if (/^check \S+: .*warning not accepted$/.test(reason)) return '有提醒待你确认';
  // A level the check could not reach keeps its own words and its own next step: reading "not measured" as "not passed"
  // turns a missing measurement into a fault (信息包装规范 §2.3, §6.2).
  if (/^check \S+: violation$/.test(reason)) return '检查未通过';
  if (/^check \S+: no_data$/.test(reason)) return '检查缺数据，需要补测';
  if (/^check \S+: error$/.test(reason)) return '检查出错，需要重跑';
  if (/^check \S+: undecidable$/.test(reason)) return '检查无法判定，需要补测或换判据';
  if (/^check \S+: scope /.test(reason)) return '检查范围与要求不一致';
  if (/^check \S+: false when/.test(reason)) return '检查需要按方案标为不适用';
  if ((m = /^gate (\S+): (undecided|expected \w+)$/.exec(reason))) return `等你决定：${gateLabel(m[1]!)}`;
  if ((m = /^gate (\S+): stale decision$/.exec(reason))) return `决定已过期，需要重新决定：${gateLabel(m[1]!)}`;
  if ((m = /^gate (\S+): concrete selection missing$/.exec(reason))) return `请选择当前实际预览中的候选：${gateLabel(m[1]!)}`;
  if ((m = /^gate (\S+): actual preview confirmation missing$/.exec(reason))) return `请查看实际效果后确认：${gateLabel(m[1]!)}`;
  if ((m = /^out-of-bounds change: (.+)$/.exec(reason))) return `有越界改动待审阅（${artifactLabel(m[1]!)}）`;
  if (/^when \S+ is false in plan$/.test(reason)) return '方案不需要这一步';
  if (reason === 'stage completion missing') return '等待执行';
  if ((m = /^completion invalidated by (\S+)$/.exec(reason))) return `「${artifactLabel(m[1]!)}」已变化，需要重做`;
  return undefined;
}
/** A stage's reasons in one short line: counted by kind, the person's words first; untranslatable ones are left out. */
export function reasonsText(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    const text = reasonText(reason);
    if (text) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const countable: Record<string, string> = { 检查待取证: '项检查待取证', 检查证据已过期: '项检查证据已过期',
    检查未通过: '项检查未通过', '检查缺数据，需要补测': '项检查缺数据', '检查出错，需要重跑': '项检查出错',
    '检查无法判定，需要补测或换判据': '项检查无法判定' };
  return [...counts].map(([text, n]) => countable[text] ? `${n} ${countable[text]}` : text).join(' · ');
}

/**
 * Which of the four questions the Runtime's next step answers. The order is fixed: what blocks the work decides the
 * state, and only then whether a result was produced (docs/zh/设计/2-功能模块/19_信息包装规范.md §2.1).
 * - `needs-you`: a person is what stands in the way
 * - `running`: a live process is what stands in the way
 * - `done`: nothing stands in the way and there is a new result
 * - `next-up`: what stands in the way is time or a prerequisite
 * - `nothing`: nothing happened; the interface must not render this as progress
 */
export type FourState = 'needs-you' | 'running' | 'done' | 'next-up' | 'nothing';
/** The word each state carries, in the same order the design lists them. */
export const FOUR_STATE_LABEL: Record<FourState, string> = {
  'needs-you': '需要你做什么', running: '在做什么', done: '做了什么', 'next-up': '准备做什么', nothing: '什么都没发生' };
export interface NextReading { state: FourState; text: string }

/**
 * The Runtime's next step (src/workflow/view.ts nextStep) as one sentence and the state it belongs to, knowing whether
 * the scheduler runs. Neither interface adds its own translation on top.
 */
export function nextReading(next: string | undefined, schedulerRunning: boolean): NextReading {
  if (!next) return { state: 'nothing', text: '尚未开始制作' };
  let m: RegExpExecArray | null;
  if ((m = /^需要你决定：(\S+?)（(批准或驳回|需你亲手完成)，绑定 (\S+)）$/.exec(next)))
    return { state: 'needs-you', text: m[2] === '需你亲手完成' ? `需要你亲手完成：${gateLabel(m[1]!)}` : `需要你决定：${gateLabel(m[1]!)}` };
  if ((m = /^阶段 (\S+) 等待人工处理：/.exec(next))) return { state: 'needs-you', text: `「${stageLabel(m[1]!)}」等你处理` };
  if ((m = /^阶段 (\S+) 需要核对上次执行/.exec(next))) return { state: 'needs-you', text: `「${stageLabel(m[1]!)}」需要核对上次执行` };
  // A warning the person has not accepted is a decision they own, not a stalled prerequisite: it must read as "needs you".
  if ((m = /^阶段 (\S+) 有需要你确认的提醒/.exec(next)))
    return { state: 'needs-you', text: `「${stageLabel(m[1]!)}」有提醒等你确认，查看当前读数后逐条接受` };
  if ((m = /^阶段 (\S+) (执行失败|检查未通过)：/.exec(next)))
    return { state: 'needs-you', text: `「${stageLabel(m[1]!)}」${m[2]}，处理后重做` };
  if (next.startsWith('已到 UPLOAD_READY')) return { state: 'needs-you', text: '可以上传了：请上传并按清单自测' };
  if (next.startsWith('请选择希望继续制作的脸型候选') || next.startsWith('脸型工程检查已通过'))
    return { state: 'needs-you', text: next };
  if (next.startsWith('方案文件无法读取')) return { state: 'needs-you', text: next };
  if (next === '已取消' || next === '已完成客户端验收') return { state: 'done', text: next };
  if ((m = /^阶段 (\S+) 进行中（(\S+)）$/.exec(next)))
    return { state: 'running', text: `「${stageLabel(m[1]!)}」${taskState(m[2]!)[0]}${schedulerRunning ? '' : '（后台已暂停）'}` };
  if ((m = /^阶段 (\S+) 待开始；/.exec(next)))
    return { state: 'next-up', text: `「${stageLabel(m[1]!)}」待开始，${schedulerRunning ? '后台会自动推进' : '后台已暂停'}` };
  if (next === '等待后台服务推进')
    return { state: 'next-up', text: schedulerRunning ? '后台正在推进' : '后台未启动新工作，已开始的步骤仍会核对结果' };
  return { state: 'next-up', text: next };
}

/** The same reading as one sentence, for callers that only need the words. */
export const nextText = (next: string | undefined, schedulerRunning: boolean): string =>
  nextReading(next, schedulerRunning).text;

/** A Gate as a person reads it: a title, the question, and what the decision binds. */
export function gateText(gate: { gate: string; question: string; binds: string }): { title: string; question: string; approve: boolean } {
  const id = gate.gate.slice(gate.gate.lastIndexOf(':') + 1);
  if (/^批准当前 \S+？$/.test(gate.question))
    return { title: gateLabel(id), question: `批准当前的「${artifactLabel(gate.binds)}」？`, approve: true };
  if (/^需要你亲手完成（\S+）$/.test(gate.question))
    return { title: gateLabel(id), question: `需要你亲手完成：${gateLabel(id)}`, approve: false };
  return { title: gate.question, question: gate.question, approve: true };
}
