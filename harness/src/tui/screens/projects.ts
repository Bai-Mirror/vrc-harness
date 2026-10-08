import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ProjectRow, TaskRow } from '../../api/read-model.ts';
import { FOUR_STATE_LABEL, nextReading, reasonsText } from '../../shared/projection.ts';
import type { StageView, WorkflowView } from '../../workflow/view.ts';
import { cancelWorkflow, createProject, decideGate, importProject, newWorkflow, redoTask } from '../actions.ts';
import { Cell, h, Line, Loading, Title, useData, useListNav, useUi } from '../core.ts';
import { firstLine, gateState, shortHash, stageLabel, stageMark, stageState, taskState, verdictState, workflowState } from '../format.ts';

type SchedulerStatus = { scheduler: { state: string } };
/** Whether the background is still starting work: both this screen's reading and the person's depend on it. */
const useSchedulerRunning = (): boolean => useData<SchedulerStatus>('service.status').data?.scheduler.state === 'running';

export function ProjectsScreen(props: { height: number; active: boolean }): ReturnType<typeof h> {
  const ui = useUi();
  const projects = useData<ProjectRow[]>('project.list');
  const running = useSchedulerRunning();
  const list = projects.data ?? [];
  const rows = Math.max(1, props.height - 3);
  const nav = useListNav(list.length, rows);
  useInput((input, key) => {
    if (nav.handle(input, key)) return;
    const project = list[nav.index];
    if (key.return && project) ui.push({ screen: 'project', projectId: project.id, ...(project.workflow ? { workflowId: project.workflow.id } : {}) });
    else if (input === 'n') void createProject(ui);
    else if (input === 'i') void importProject(ui);
  }, { isActive: props.active });
  if (!projects.data) return h(Loading, { what: '项目', error: projects.error });
  if (!list.length) return h(Box, { flexDirection: 'column' }, h(Title, { text: '项目' }),
    h(Text, null, '还没有项目。按 n 说明目标并创建项目，或按 i 接手已有工程。'));
  return h(Box, { flexDirection: 'column' },
    h(Title, { text: '项目', hint: `${list.length} 个 · Enter 打开  n 新建项目  i 导入` }),
    h(Box, null, h(Cell, { width: 2 }), h(Cell, { width: 26, dim: true }, '项目'), h(Cell, { width: 8, dim: true }, '类型'),
      h(Cell, { width: 10, dim: true }, '状态'), h(Text, { dimColor: true }, '下一步 / 最近复核')),
    ...list.slice(nav.offset, nav.offset + rows).map((project, i) => {
      const selected = nav.offset + i === nav.index;
      const [label, tone] = project.workflow ? workflowState(project.workflow.status) : ['未建流程', 'muted' as const];
      const summary = project.workflow ? nextReading(project.workflow.next, running).text : project.lastImport
        ? `复核 已核实${project.lastImport.counts.verified}/声称${project.lastImport.counts.claimed}/未知${project.lastImport.counts.unknown}${
          project.tasks.needsYou ? ` · ${project.tasks.needsYou} 项等你处理` : ''}` : '';
      return h(Box, { key: project.id },
        h(Cell, { width: 2, tone: 'info' }, selected ? '›' : ' '), h(Cell, { width: 26, bold: selected }, project.name),
        h(Cell, { width: 8, dim: true }, project.kind), h(Cell, { width: 10, tone }, label),
        h(Text, { wrap: 'truncate-end' }, summary));
    }));
}

function StageDetail(props: { stage: StageView; view: WorkflowView; height: number }): ReturnType<typeof h> {
  const { stage, view } = props;
  const [label, tone] = stageState(stage.display ?? stage.status);
  const lines: ReturnType<typeof h>[] = [
    h(Box, { key: 'head' }, h(Text, { bold: true }, `${stageLabel(stage.id)}  `), h(Text, { dimColor: true }, `(${stage.id})  `), h(Text, { color: tone === 'ok' ? 'green' : tone === 'bad' ? 'red' : undefined }, label),
      stage.task ? h(Text, { dimColor: true }, `  任务 ${taskState(stage.task.status)[0]}，${stage.task.attempts} 次执行`) : null),
    ...stage.reasons.slice(0, 3).map((reason, i) => h(Line, { key: `r${i}`, dim: true }, `· ${reason}`)),
    ...stage.gates.map(id => {
      const gate = view.gates.find(item => item.gate.endsWith(`:${id}`));
      const [state, gateTone] = gateState(gate?.status ?? 'waiting');
      return h(Line, { key: `g${id}`, tone: gateTone }, `Gate ${id}：${state}${gate?.artifactHash ? `（${gate.binds} ${shortHash(gate.artifactHash)}）` : ''}`);
    }),
    h(Line, { key: 'ch', dim: true }, `检查 ${stage.checks.length} 项：`),
    ...stage.checks.map(check => {
      const [result, checkTone] = check.verdict ? verdictState(check.verdict.result) : ['未测', 'muted' as const];
      const stale = check.verdict && !check.verdict.current;
      // The identity of the evidence: which artifact version was judged, and which one it no longer matches.
      const identity = check.verdict
        ? check.verdict.current ? shortHash(check.verdict.artifactHash)
          : `${shortHash(check.verdict.artifactHash)}→${shortHash(check.verdict.boundHash)}` : '—';
      return h(Box, { key: check.id },
        h(Cell, { width: 12, tone: stale ? 'warn' : checkTone }, stale ? `${result}·已失效` : result),
        h(Cell, { width: 11, dim: true }, `${check.scope}/${check.severity === 'blocking' ? '阻断' : check.severity === 'warning' ? '警告' : '参考'}`),
        h(Cell, { width: 19, dim: true }, identity),
        h(Text, { wrap: 'truncate-end' }, `${check.id}  ${check.verdict?.basis ? firstLine(check.verdict.basis).replace(/^[^:]+: /, '') : check.rule}`));
    }),
  ];
  return h(Box, { flexDirection: 'column', height: props.height, overflow: 'hidden', flexGrow: 1 }, ...lines.slice(0, props.height));
}

/** A project's formal Workflow: where it stands, what is next, and the evidence behind each stage. */
export function ProjectScreen(props: { height: number; active: boolean; projectId: string; workflowId?: string }): ReturnType<typeof h> {
  const ui = useUi();
  const [technical, setTechnical] = useState(false);
  const running = useSchedulerRunning();
  const workflow = useData<WorkflowView>(props.workflowId ? 'workflow.show' : 'project.list', props.workflowId ? { id: props.workflowId } : {});
  const projectTasks = useData<TaskRow[]>('task.list');
  const view = props.workflowId ? workflow.data as WorkflowView | undefined : undefined;
  const stages = view?.stages ?? [];
  const nav = useListNav(stages.length, Math.max(1, props.height - 5));
  useInput((input, key) => {
    if (input === 'm' && props.workflowId) { ui.push({ screen: 'conversation', projectId: props.projectId }); return; }
    if (!view) return;
    if (nav.handle(input, key)) return;
    const stage = stages[nav.index];
    if (key.return && stage?.task) ui.push({ screen: 'task', taskId: stage.task.id });
    else if (input === 'p') ui.push({ screen: 'plan', workflowId: view.id });
    else if (input === 'b') ui.push({ screen: 'brief', project: view.project });
    else if (input === 't') setTechnical(value => !value);
    else if (input === 'g' || input === 'a') {
      const gate = view.gates.find(item => (item.status === 'pending' || item.status === 'stale') &&
        (!stage || stage.gates.some(id => item.gate.endsWith(`:${id}`)))) ?? view.gates.find(item => item.status === 'pending' || item.status === 'stale');
      if (!gate) { ui.notify('没有待决定的 Gate', 'muted'); return; }
      void decideGate(ui, { gate: gate.gate, question: gate.kind === 'do' ? `需要你亲手完成（${gate.binds}）` : `批准当前 ${gate.binds}？`,
        binds: gate.binds, artifactHash: gate.artifactHash, projectName: view.projectName, owner: gate.owner, status: gate.status },
      gate.binds === 'plan' ? () => ui.push({ screen: 'plan', workflowId: view.id }) : undefined);
    } else if (input === 'd' && stage?.task) void redoTask(ui, stage.task.id, stage.task.status === 'PASSED');
    else if (input === 'c' && view.status !== 'cancelled') void cancelWorkflow(ui, view.id);
  }, { isActive: props.active });

  if (!props.workflowId) {
    const project = (workflow.data as unknown as ProjectRow[] | undefined)?.find(item => item.id === props.projectId);
    if (!project) return h(Loading, { what: '项目', error: workflow.error });
    const tasks = (projectTasks.data ?? []).filter(task => task.project === project.path);
    return h(ProjectWithoutWorkflow, { project, tasks, active: props.active });
  }
  if (!view) return h(Loading, { what: 'Workflow', error: workflow.error });
  const [label, tone] = workflowState(view.status);
  // The four states are the sentence's tense, not a badge (决定记录 D-41): the same reading the GUI makes.
  const reading = nextReading(view.next, running);
  const needsYou = reading.state === 'needs-you';
  const selected = stages[nav.index];
  const listHeight = Math.max(1, props.height - 4);
  const issues = stages.filter(stage => ['blocked', 'deciding'].includes(stage.display ?? stage.status));
  if (!technical) return h(Box, { flexDirection: 'column' },
    h(Box, null, h(Text, { bold: true }, view.projectName), h(Text, { dimColor: true }, `  ${view.profile}  `),
      h(Text, { color: tone === 'ok' ? 'green' : tone === 'bad' ? 'red' : 'cyan' }, label)),
    h(Box, { marginTop: 1, flexDirection: 'column' },
      h(Text, { bold: true, color: needsYou ? 'yellow' : 'cyan' }, FOUR_STATE_LABEL[reading.state]), h(Text, null, `  ${reading.text}`),
      view.request ? h(Text, { dimColor: true }, `  项目目标：${view.request}`) : null),
    h(Box, { marginTop: 1, flexDirection: 'column' }, h(Text, { bold: true }, '项目摘要'),
      h(Text, null, `  制作方案：${view.plan.hash ? (view.plan.approved ? '已批准' : '等待批准') : '尚未生成'}`),
      h(Text, null, `  制作进度：${stages.filter(stage => stage.status === 'passed').length}/${stages.length} 个阶段已完成`),
      h(Text, null, `  当前问题：${issues.length ? `${issues.length} 项需要处理` : '无阻断问题'}`)),
    h(Box, { marginTop: 1, flexDirection: 'column' }, h(Text, { bold: true }, '需要处理'),
      ...(issues.length ? issues.slice(0, Math.max(1, props.height - 13)).map(stage => h(Box, { key: stage.id },
        h(Cell, { width: 3, tone: stage.display === 'deciding' ? 'warn' : 'bad' }, stage.display === 'deciding' ? '!' : '×'),
        h(Cell, { width: 20, bold: true }, stageLabel(stage.id)),
        h(Text, { wrap: 'truncate-end', dimColor: true }, reasonsText(stage.reasons) || (stage.display === 'deciding' ? '等待你决定' : '检查未通过'))))
        : [h(Text, { key: 'none', color: 'green' }, '  ✓ 当前没有需要你介入的问题')])),
    h(Line, { dim: true }, 'm 项目对话  p 查看方案  b 项目资料  a 处理确认  t 技术详情  Esc 返回'));
  return h(Box, { flexDirection: 'column' },
    h(Box, null, h(Text, { bold: true }, view.projectName), h(Text, { dimColor: true }, `  ${view.profile}  `),
      h(Text, { color: tone === 'ok' ? 'green' : tone === 'bad' ? 'red' : 'cyan' }, label),
      h(Text, { dimColor: true }, `  方案 ${view.plan.hash ? `${shortHash(view.plan.hash)}${view.plan.approved ? ' 已批准' : ' 未批准'}` : '未产出'}`)),
    h(Line, { tone: needsYou ? 'warn' : 'info', bold: true }, `下一步：${view.next}`),
    view.request ? h(Line, { dim: true }, `需求：${view.request}`) : h(Text, null, ' '),
    h(Box, { marginTop: 0 },
      h(Box, { flexDirection: 'column', width: 26, flexShrink: 0 },
        ...stages.slice(nav.offset, nav.offset + listHeight).map((stage, i) => {
          const index = nav.offset + i;
          const [stageStatusLabel, stageTone] = stageState(stage.display ?? stage.status);
          return h(Box, { key: stage.id },
            h(Cell, { width: 2, tone: 'info' }, index === nav.index ? '›' : ' '),
            h(Cell, { width: 2, tone: stageTone }, stageMark(stage.display ?? stage.status)),
            h(Cell, { width: 13, bold: index === nav.index }, stageLabel(stage.id)),
            h(Cell, { width: 8, tone: stageTone }, stage.task && stage.status !== 'passed' && stage.display !== 'deciding'
              ? taskState(stage.task.status)[0] : stageStatusLabel));
        })),
      selected ? h(StageDetail, { stage: selected, view, height: listHeight }) : null),
    h(Line, { dim: true }, 'Enter 打开任务  p 方案  a 处理决定  d 重新执行  t 项目概览  c 取消流程  Esc 返回'));
}

function ProjectWithoutWorkflow(props: { project: ProjectRow; tasks: TaskRow[]; active: boolean }): ReturnType<typeof h> {
  const ui = useUi();
  const nav = useListNav(props.tasks.length, 10);
  useInput((input, key) => {
    if (nav.handle(input, key)) return;
    const task = props.tasks[nav.index];
    if (key.return && task) ui.push({ screen: 'task', taskId: task.id });
    else if (input === 'b') ui.push({ screen: 'brief', project: props.project.path });
    else if (input === 'm') ui.push({ screen: 'conversation', projectId: props.project.id });
    else if (input === 'n') void newWorkflow(ui, props.project.name);
  }, { isActive: props.active });
  const report = props.project.lastImport;
  return h(Box, { flexDirection: 'column' },
    h(Title, { text: props.project.name, hint: props.project.path }),
    report ? h(Text, null, `最近复核 ${report.at.slice(0, 16).replace('T', ' ')}：已核实 ${report.counts.verified}，声称 ${report.counts.claimed}，未知 ${report.counts.unknown}，复核失败 ${report.failedReviews}，未收结 ${report.unresolved}`)
      : h(Text, { dimColor: true }, '还没有复核报告。'),
    h(Text, { dimColor: true }, '按 m 与 AI 讨论制作目标；b 查看接手简报。n 高级：直接新建流程。'),
    props.tasks.length ? h(Box, { flexDirection: 'column', marginTop: 1 }, h(Text, { bold: true }, '临时任务'),
      ...props.tasks.slice(nav.offset, nav.offset + 10).map((task, i) => {
        const [label, tone] = taskState(task.status);
        return h(Box, { key: task.id }, h(Cell, { width: 2, tone: 'info' }, nav.offset + i === nav.index ? '›' : ' '),
          h(Cell, { width: 14, tone }, label), h(Text, { wrap: 'truncate-end' }, task.goal));
      })) : null);
}
