import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { stringify } from 'yaml';
import type { TaskDetail } from '../../api/read-model.ts';
import { planDetails, planSummary } from '../../shared/plan-view.ts';
import type { WorkflowView } from '../../workflow/view.ts';
import { acceptChanges, cancelTask, decideGate, recoverTask, redoTask } from '../actions.ts';
import { h, Loading, useData, useUi, wrapText } from '../core.ts';
import { firstLine, shortHash, shortId, taskState, TONE_COLOR, verdictState, when, type Tone } from '../format.ts';

type Styled = { text: string; tone?: Tone; bold?: boolean; dim?: boolean };
/** One labelled value as display lines, aligned under the label and wrapped to the terminal width. */
function rowLines(columns: number, label: string, value: string): Styled[] {
  const prefix = `  ${label}：`;
  const pad = `  ${' '.repeat(stringWidth(label) + 1)}`;
  const wrapWidth = Math.max(8, columns - stringWidth(prefix));
  const wrapped = wrapText(value, wrapWidth);
  return wrapped.map((line, index) => ({ text: index ? `${pad}${line}` : `${prefix}${line}` }));
}
/** Scrollable styled lines; the screens below turn their views into these. */
function StyledLines(props: { lines: Styled[]; height: number; offset: number }): ReturnType<typeof h> {
  const visible = props.lines.slice(props.offset, props.offset + props.height);
  return h(Box, { flexDirection: 'column', height: props.height + (props.lines.length > props.height ? 1 : 0), overflow: 'hidden' },
    ...visible.map((line, i) => h(Text, { key: i, color: line.tone ? TONE_COLOR[line.tone] : undefined, bold: line.bold ?? false,
      dimColor: line.dim ?? false, wrap: 'truncate-end' }, line.text || ' ')),
    props.lines.length > props.height ? h(Text, { dimColor: true },
      `— ${props.offset + 1}-${Math.min(props.offset + props.height, props.lines.length)}/${props.lines.length}（↑↓ PgUp PgDn）`) : null);
}
function useScroll(total: number, height: number, active: boolean, extra: (input: string) => void): number {
  const [offset, setOffset] = useState(0);
  const max = Math.max(0, total - height);
  useInput((input, key) => {
    if (key.upArrow || input === 'k') setOffset(Math.max(0, offset - 1));
    else if (key.downArrow || input === 'j') setOffset(Math.min(max, offset + 1));
    else if (key.pageUp) setOffset(Math.max(0, offset - height));
    else if (key.pageDown) setOffset(Math.min(max, offset + height));
    else if (key.home) setOffset(0);
    else if (key.end) setOffset(max);
    else extra(input);
  }, { isActive: active });
  return Math.min(offset, max);
}

export function taskLines(task: TaskDetail): Styled[] {
  const [label, tone] = taskState(task.status);
  const lines: Styled[] = [
    { text: `${task.formal ? `阶段 ${task.stage}` : task.goal}  ·  ${task.projectName}  ·  任务 ${shortId(task.id)}`, bold: true },
    { text: `状态：${label}`, tone }, { text: `下一步：${task.next}`, tone: task.needsYou ? 'warn' : 'info', bold: true },
  ];
  if (task.wait) lines.push({ text: `等待原因：${firstLine(task.wait.reason)}（自 ${when(task.wait.since)}）`, tone: 'warn' });
  if (!task.formal) lines.push({ text: `目标：${firstLine(task.goal)}`, dim: true });
  if (task.allowedWrites.length) lines.push({ text: `允许写入：${task.allowedWrites.join('、')}`, dim: true });
  if (task.outOfBounds.length) {
    lines.push({ text: `未接受的越界改动 ${task.outOfBounds.length} 处（x 审阅后接受）：`, tone: 'warn' });
    for (const change of task.outOfBounds) lines.push({ text: `  ${change.artifact}  ${when(change.recordedAt)}`, tone: 'warn' });
  }
  lines.push({ text: `执行 ${task.runs.length} 次：`, bold: true });
  for (const run of task.runs) lines.push({ text: `  #${run.attempt} ${run.provider ?? '—'}  ${run.status}${run.exitStatus === undefined ? '' : `  退出码 ${run.exitStatus}`}${
    run.errorClass ? `  ${run.errorClass}` : ''}${run.errorMessage ? `  ${firstLine(run.errorMessage)}` : ''}`,
  tone: run.errorClass ? 'bad' : undefined });
  const last = task.runs.at(-1);
  if (task.status === 'RECOVERY_REQUIRED' && last?.directory) lines.push({ text: `  运行目录：${last.directory}`, tone: 'warn' });
  lines.push({ text: `检查 ${task.verdicts.length} 项（最近一次执行）：`, bold: true });
  for (const verdict of task.verdicts) {
    const [result, verdictTone] = verdictState(verdict.result);
    lines.push({ text: `  ${result}${verdict.current ? '' : '（已失效）'}  ${verdict.checkId} [${verdict.scope}]  ${firstLine(verdict.basis)}`,
      tone: verdict.current ? verdictTone : 'warn' });
  }
  lines.push({ text: `事件（最近 ${task.events.length} 条）：`, bold: true });
  for (const event of task.events.slice().reverse())
    lines.push({ text: `  ${when(event.at)}  ${event.action}${event.proof ? ` [${event.proof}]` : ''}  ${firstLine(event.reason)}`, dim: true });
  return lines;
}

export function TaskScreen(props: { height: number; active: boolean; taskId: string }): ReturnType<typeof h> {
  const ui = useUi();
  const task = useData<TaskDetail>('task.show', { id: props.taskId });
  const lines = task.data ? taskLines(task.data) : [];
  const height = Math.max(3, props.height - 2);
  const offset = useScroll(lines.length, height, props.active, input => {
    const data = task.data;
    if (!data) return;
    if (input === 'd') void redoTask(ui, data.id, data.status === 'PASSED');
    else if (input === 'c' && !['PASSED', 'FAILED', 'CANCELLED'].includes(data.status)) void cancelTask(ui, data.id);
    else if (input === 'x' && data.outOfBounds.length) void acceptChanges(ui, data.id, data.outOfBounds.length);
    else if (input === 'v' && data.status === 'RECOVERY_REQUIRED') void recoverTask(ui, data.id, data.runs.at(-1)?.directory);
  });
  if (!task.data) return h(Loading, { what: '任务', error: task.error });
  return h(Box, { flexDirection: 'column' }, h(StyledLines, { lines, height, offset }),
    h(Text, { dimColor: true }, 'd 重做  c 取消  x 接受越界改动  v 核对恢复  Esc 返回'));
}

/** The plan being decided on, with every version the Runtime has seen and which ones were decided. */
export function PlanScreen(props: { height: number; active: boolean; workflowId: string }): ReturnType<typeof h> {
  const ui = useUi();
  const [technical, setTechnical] = useState(false);
  const plan = useData<{ current: unknown; revisions: Array<{ seq: number; hash: string; observedAt: string; error?: string; approved: boolean }> }>(
    'plan.show', { workflowId: props.workflowId });
  const view = useData<WorkflowView>('workflow.show', { id: props.workflowId });
  const gate = view.data?.gates.find(item => item.binds === 'plan');
  const lines: Styled[] = [];
  if (plan.data) {
    const latest = plan.data.revisions.at(-1);
    lines.push({ text: `方案版本 ${plan.data.revisions.length} 个；当前 ${shortHash(latest?.hash)}${gate ? `；${gate.status === 'approved' ? '已批准' : gate.status === 'stale' ? '批准已过期' : '未批准'}` : ''}`, bold: true });
    if (latest?.error) lines.push({ text: `当前方案无法读取：${latest.error}`, tone: 'bad' });
    if (plan.data.current) {
      // The same derivation the GUI uses (src/shared/plan-view.ts): a plan approved here and a plan approved
      // there must be described the same way. The raw file is what the person asked for with `t`.
      if (technical) {
        lines.push({ text: '技术详情：方案文件原文', bold: true });
        for (const line of stringify(plan.data.current).trimEnd().split('\n')) lines.push({ text: `  ${line}`, dim: true });
      } else {
        const summary = planSummary(plan.data.current);
        lines.push({ text: '这个方案要做什么', bold: true });
        // A summary line can name several requirements; it is wrapped, not cut off, so nothing the person is
        // approving stays out of sight (core.ts wrapText).
        if (summary.length) for (const [label, value] of summary) lines.push(...rowLines(ui.columns, label, value));
        else lines.push({ text: '  方案内容读不出可读条目；按 t 看原文。', tone: 'warn' });
        const details = planDetails(plan.data.current);
        if (details.length) {
          lines.push({ text: '文件与位置（技术详情）', dim: true });
          for (const [label, value] of details) lines.push(...rowLines(ui.columns, label, value).map(line => ({ ...line, dim: true })));
        }
      }
    } else if (!latest) lines.push({ text: '方案还没有产出：方案阶段完成后会出现在这里。', dim: true });
    lines.push({ text: '版本记录：', bold: true });
    for (const revision of plan.data.revisions.slice().reverse())
      lines.push({ text: `  ${shortHash(revision.hash)}  ${when(revision.observedAt)}  ${revision.error ? '无法读取' : revision.approved ? '有过决定' : '未决定'}`, dim: true });
  }
  const height = Math.max(3, props.height - 2);
  const offset = useScroll(lines.length, height, props.active, input => {
    if (input === 't') { setTechnical(value => !value); return; }
    if ((input === 'a' || input === 'r') && gate && view.data) {
      if (gate.status !== 'pending' && gate.status !== 'stale') { ui.notify(gate.status === 'approved' ? '当前版本已批准' : '方案阶段还没到决定的时候', 'muted'); return; }
      void decideGate(ui, { gate: gate.gate, question: '批准当前方案？', binds: 'plan', artifactHash: gate.artifactHash,
        projectName: view.data.projectName, owner: gate.owner, status: gate.status });
    }
  });
  if (!plan.data) return h(Loading, { what: '方案', error: plan.error });
  return h(Box, { flexDirection: 'column' }, h(StyledLines, { lines, height, offset }),
    h(Text, { dimColor: true }, `a 批准或驳回当前版本  t ${technical ? '看用户视图' : '看技术详情'}  ↑↓ 滚动  Esc 返回`));
}

export function BriefScreen(props: { height: number; active: boolean; project: string }): ReturnType<typeof h> {
  const brief = useData<{ markdown: string }>('project.brief', { project: props.project });
  const lines: Styled[] = (brief.data?.markdown ?? '').split('\n').map(line =>
    line.startsWith('#') ? { text: line.replace(/^#+\s*/, ''), bold: true } : { text: line });
  const height = Math.max(3, props.height - 1);
  const offset = useScroll(lines.length, height, props.active, () => {});
  if (!brief.data) return h(Loading, { what: '接手简报', error: brief.error });
  return h(StyledLines, { lines, height, offset });
}
