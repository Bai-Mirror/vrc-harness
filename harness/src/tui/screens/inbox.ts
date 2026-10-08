import { Box, Text, useInput } from 'ink';
import type { GateRow, TaskRow } from '../../api/read-model.ts';
import type { WorkflowRow } from '../../workflow/view.ts';
import { decideGate } from '../actions.ts';
import { Cell, h, Loading, Title, useData, useListNav, useUi } from '../core.ts';
import { firstLine, gateState, shortHash, stageLabel, taskState } from '../format.ts';

type Item = { kind: 'gate'; gate: GateRow } | { kind: 'task'; task: TaskRow };

/** The default screen: everything that waits for a person, decisions first. */
export function InboxScreen(props: { height: number; active: boolean }): ReturnType<typeof h> {
  const ui = useUi();
  const gates = useData<GateRow[]>('gate.list');
  const tasks = useData<TaskRow[]>('task.list');
  const workflows = useData<WorkflowRow[]>('workflow.list');
  const items: Item[] = [
    ...(gates.data ?? []).filter(gate => gate.status === 'pending' || gate.status === 'stale').map(gate => ({ kind: 'gate' as const, gate })),
    ...(tasks.data ?? []).filter(task => task.needsYou).map(task => ({ kind: 'task' as const, task })),
  ];
  const rows = Math.max(1, props.height - 7);
  const nav = useListNav(items.length, rows);
  useInput((input, key) => {
    if (nav.handle(input, key)) return;
    const item = items[nav.index];
    if (!key.return || !item) return;
    if (item.kind === 'task') ui.push({ screen: 'task', taskId: item.task.id });
    else void decideGate(ui, item.gate, item.gate.formal && item.gate.binds === 'plan'
      ? () => ui.push({ screen: 'plan', workflowId: item.gate.workflowId }) : undefined);
  }, { isActive: props.active });

  if (!gates.data || !tasks.data) return h(Loading, { what: '待办', error: gates.error ?? tasks.error });
  const running = (workflows.data ?? []).filter(row => row.status === 'active' || row.status === 'upload_ready');
  if (!items.length) return h(Box, { flexDirection: 'column' },
    h(Title, { text: '首页', hint: '从这里继续' }),
    h(Text, { color: 'green', bold: true }, '✓ 现在不需要你处理'),
    running.length ? h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, { bold: true }, '正在制作'),
      ...running.slice(0, 5).map(row => h(Text, { key: row.id }, `  ${row.projectName}  ${row.stagesPassed}/${row.stagesTotal}  ${row.next}`)),
      h(Text, { dimColor: true }, '后台会继续工作；按 2 查看项目详情。'))
      : h(Box, { flexDirection: 'column', marginTop: 1 },
        h(Text, { bold: true }, '开始制作'),
        h(Text, null, '  还没有进行中的项目。按 Ctrl+K，选择“新建工程”或“导入已有工程”。')),
    h(Box, { marginTop: 1, flexDirection: 'column' },
      h(Text, { bold: true }, '常用入口'),
      h(Text, { dimColor: true }, '  2 项目   3 素材   4 后台   5 核心与 AI   6 设置   ? 帮助')));
  const visible = items.slice(nav.offset, nav.offset + rows);
  return h(Box, { flexDirection: 'column' },
    h(Title, { text: '首页', hint: '从这里继续' }),
    h(Text, { color: 'yellow', bold: true }, `下一步：有 ${items.length} 项需要你处理`),
    h(Text, { dimColor: true }, '选中第一项并按 Enter；界面会说明影响，再让你批准、修改或重做。'),
    h(Box, { marginTop: 1 }),
    h(Title, { text: '需要你处理', hint: '决定优先，问题其次' }),
    h(Box, null, h(Cell, { width: 2 }), h(Cell, { width: 18, dim: true }, '状态'), h(Cell, { width: 20, dim: true }, '项目'),
      h(Text, { dimColor: true }, '事项')),
    ...visible.map((item, i) => {
      const selected = nav.offset + i === nav.index;
      if (item.kind === 'gate') {
        const [label, tone] = gateState(item.gate.status);
        return h(Box, { key: item.gate.gate },
          h(Cell, { width: 2, tone: 'info' }, selected ? '›' : ' '), h(Cell, { width: 18, tone }, label),
          h(Cell, { width: 20, bold: selected }, item.gate.projectName),
          h(Text, { wrap: 'truncate-end', bold: selected }, `${item.gate.question} · ${item.gate.binds} ${shortHash(item.gate.artifactHash)}`));
      }
      const [label, tone] = taskState(item.task.status);
      return h(Box, { key: item.task.id },
        h(Cell, { width: 2, tone: 'info' }, selected ? '›' : ' '), h(Cell, { width: 18, tone }, label),
        h(Cell, { width: 20, bold: selected }, item.task.projectName),
        h(Text, { wrap: 'truncate-end', bold: selected }, `${item.task.formal ? stageLabel(item.task.stage) : item.task.goal}${
          item.task.waitReason ? ` · ${firstLine(item.task.waitReason)}` : ''}`));
    }));
}
