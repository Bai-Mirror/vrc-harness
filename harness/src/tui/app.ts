import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import type { GateRow, TaskRow } from '../api/read-model.ts';
import { choose, createProject, FOOTER_ROWS, importProject, MODAL_ROWS, newWorkflow } from './actions.ts';
import { h, UiContext, useData, useListNav, useUi, type Api, type Route, type Ui } from './core.ts';
import { schedulerState, TONE_COLOR, type Tone } from './format.ts';
import { InboxScreen } from './screens/inbox.ts';
import { ProjectScreen, ProjectsScreen } from './screens/projects.ts';
import { ConversationScreen } from './screens/conversation.ts';
import { BriefScreen, PlanScreen, TaskScreen } from './screens/detail.ts';
import { ActivityScreen, HelpScreen, ProvidersScreen, ServiceScreen } from './screens/system.ts';
import { AssetsScreen } from './screens/library.ts';

const TABS: Array<{ key: string; label: string; route: Route }> = [
  { key: '1', label: '首页', route: { screen: 'inbox' } }, { key: '2', label: '项目', route: { screen: 'projects' } },
  { key: '3', label: '素材', route: { screen: 'assets' } }, { key: '4', label: '后台', route: { screen: 'activity' } },
  { key: '5', label: '核心', route: { screen: 'providers' } }, { key: '6', label: '设置', route: { screen: 'service' } },
];
const TAB_OF: Record<string, string> = { inbox: '1', projects: '2', project: '2', plan: '2', brief: '2', assets: '3', activity: '4', task: '4',
  providers: '5', service: '6', help: '', conversation: '2' };
const TITLES: Record<string, string> = { inbox: '首页', projects: '项目', project: '项目详情', plan: '方案', brief: '接手简报',
  assets: '素材', activity: '后台活动', task: '任务详情', providers: '核心与 AI', service: '设置与服务', help: '帮助', conversation: '项目对话' };

export interface AppProps {
  api: Api;
  /** Reopens the connection after the service restarts; absent in tests. */
  reconnect?: () => Promise<Api>;
  /** Called when the person leaves; `pause` asks the service to stop scheduling at its next safe point first. */
  onExit?: (pause: boolean) => void;
}

function Header(props: { stack: Route[] }): ReactNode {
  const ui = useUi();
  const gates = useData<GateRow[]>('gate.list');
  const tasks = useData<TaskRow[]>('task.list');
  const status = useData<{ scheduler: { state: string } }>('service.status');
  const inbox = (gates.data ?? []).filter(gate => gate.status === 'pending' || gate.status === 'stale').length +
    (tasks.data ?? []).filter(task => task.needsYou).length;
  const current = TAB_OF[props.stack.at(-1)!.screen];
  const [state, tone] = ui.connected ? schedulerState(status.data?.scheduler.state ?? 'stopped') : ['未连接 Runtime 服务', 'bad' as Tone];
  return h(Box, { flexDirection: 'column' },
    h(Box, null,
      h(Text, { bold: true, color: 'cyan' }, 'Harness  '),
      ...TABS.map(tab => h(Text, { key: tab.key, inverse: tab.key === current, bold: tab.key === current },
        ` ${tab.key} ${tab.label}${tab.key === '1' && inbox ? `(${inbox})` : ''} `)),
      h(Box, { flexGrow: 1 }),
      h(Text, { color: TONE_COLOR[tone] }, `${ui.connected ? '●' : '✗'} ${state}`)),
    h(Text, { dimColor: true, wrap: 'truncate-end' }, props.stack.map(route => TITLES[route.screen]).join(' › ')));
}

function Screen(props: { route: Route; height: number; active: boolean }): ReactNode {
  const { route, height, active } = props;
  switch (route.screen) {
    case 'inbox': return h(InboxScreen, { height, active });
    case 'projects': return h(ProjectsScreen, { height, active });
    case 'assets': return h(AssetsScreen, { active });
    case 'project': return h(ProjectScreen, { height, active, projectId: route.projectId, ...(route.workflowId ? { workflowId: route.workflowId } : {}) });
    case 'conversation': return h(ConversationScreen, { height, active, projectId: route.projectId });
    case 'task': return h(TaskScreen, { height, active, taskId: route.taskId });
    case 'plan': return h(PlanScreen, { height, active, workflowId: route.workflowId });
    case 'brief': return h(BriefScreen, { height, active, project: route.project });
    case 'activity': return h(ActivityScreen, { height, active });
    case 'providers': return h(ProvidersScreen, { height, active });
    case 'service': return h(ServiceScreen, { height, active });
    case 'help': return h(HelpScreen);
  }
}

type Command = { label: string; run(): void };
function Palette(props: { commands: Command[]; onClose(): void }): ReactNode {
  const [filter, setFilter] = useState('');
  const shown = props.commands.filter(command => command.label.toLowerCase().includes(filter.toLowerCase()));
  const nav = useListNav(shown.length, MODAL_ROWS - 3);
  useInput((input, key) => {
    if (key.escape) { props.onClose(); return; }
    if (key.return) { const command = shown[nav.index]; props.onClose(); command?.run(); return; }
    if (nav.handle(input === 'j' || input === 'k' ? '' : input, key)) return;
    if (key.backspace) setFilter(filter.slice(0, -1));
    else if (input && !key.ctrl && !key.meta && !key.tab) setFilter(filter + input);
  });
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, null, h(Text, { color: 'cyan' }, '命令：'), filter || h(Text, { dimColor: true }, '输入以筛选')),
    ...shown.slice(nav.offset, nav.offset + MODAL_ROWS - 3).map((command, i) => h(Text, { key: command.label,
      inverse: nav.offset + i === nav.index }, ` ${command.label} `)));
}

export function App(props: AppProps): ReactNode {
  const app = useApp();
  const size = useWindowSize();
  const rows = Math.max(16, size?.rows ?? 24);
  const columns = Math.max(60, size?.columns ?? 80);
  const [api, setApi] = useState(props.api);
  const [connected, setConnected] = useState(true);
  const [version, setVersion] = useState(0);
  const [stack, setStack] = useState<Route[]>([{ screen: 'inbox' }]);
  const [modal, setModal] = useState<ReactNode>();
  const [message, setMessage] = useState<{ text: string; tone: Tone }>();
  const messageTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const refreshTimer = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    let live = true;
    api.onClose(() => { if (live) setConnected(false); });
    // Coalesce bursts of changes (a scheduler round writes many events) into one refresh.
    api.subscribe(() => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => { if (live) setVersion(value => value + 1); }, 250);
    }).catch(() => { if (live) setConnected(false); });
    return () => { live = false; clearTimeout(refreshTimer.current); };
  }, [api]);
  useEffect(() => {
    if (connected || !props.reconnect) return;
    const timer = setInterval(() => {
      props.reconnect!().then(next => { clearInterval(timer); setApi(next); setConnected(true); setVersion(value => value + 1); })
        .catch(() => { /* still down; try again */ });
    }, 2000);
    return () => clearInterval(timer);
  }, [connected]);

  const notify = (text: string, tone: Tone = 'info') => {
    clearTimeout(messageTimer.current);
    setMessage({ text, tone });
    messageTimer.current = setTimeout(() => setMessage(undefined), tone === 'bad' ? 12_000 : 6_000);
  };
  const ui: Ui = useMemo(() => ({
    api, version, connected, rows, columns, modal,
    push: route => setStack(previous => [...previous, route]),
    pop: () => setStack(previous => previous.length > 1 ? previous.slice(0, -1) : previous),
    tab: route => setStack([route]),
    openModal: node => setModal(node), closeModal: () => setModal(undefined),
    notify, refresh: () => setVersion(value => value + 1),
    act: async (label, run) => {
      notify(`${label.replace(/^已/, '正在')}…`, 'info');
      try { await run(); notify(label, 'ok'); setVersion(value => value + 1); return true; }
      catch (error) { notify(`${label.replace(/^已/, '')}失败：${(error as Error).message}`, 'bad'); return false; }
    },
  }), [api, version, connected, rows, columns, modal]);

  const quit = async () => {
    const choice = await choose(ui, '退出界面？', ['后台服务会继续推进任务；需要你处理的事项会留在待办里，下次打开还能看到。'],
      [{ key: 'enter', label: '退出界面' }, { key: 'p', label: '先暂停调度（本轮结束后），再退出', tone: 'warn' }]);
    if (!choice) return;
    props.onExit?.(choice === 'p');
    app.exit();
  };
  const commands: Command[] = [
    ...TABS.map(tab => ({ label: `打开 ${tab.label}`, run: () => ui.tab(tab.route) })),
    { label: '新建工程（独立 Git 仓库）', run: () => void createProject(ui) },
    { label: '新建正式 Workflow', run: () => void newWorkflow(ui) },
    { label: '导入工程 / 压缩包 / UnityPackage', run: () => void importProject(ui) },
    { label: '暂停调度（本轮结束后）', run: () => void ui.act('调度将在本轮结束后暂停', () => ui.api.call('service.pause')) },
    { label: '恢复调度', run: () => void ui.act('调度已恢复', () => ui.api.call('service.resume')) },
    { label: '刷新', run: () => ui.refresh() },
    { label: '帮助', run: () => ui.push({ screen: 'help' }) },
    { label: '退出界面', run: () => void quit() },
  ];
  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || input === 'q') { void quit(); return; }
    if (key.escape) { ui.pop(); return; }
    if (key.ctrl && input === 'k') { ui.openModal(h(Palette, { commands, onClose: () => ui.closeModal() })); return; }
    if (input === '?') { ui.push({ screen: 'help' }); return; }
    const tab = TABS.find(item => item.key === input);
    if (tab) ui.tab(tab.route);
  }, { isActive: !modal });

  const content = rows - 2 - FOOTER_ROWS - (modal ? MODAL_ROWS : 0);
  const route = stack.at(-1)!;
  return h(UiContext.Provider, { value: ui },
    h(Box, { flexDirection: 'column', height: rows, width: columns },
      h(Header, { stack }),
      h(Box, { height: content, flexDirection: 'column', overflow: 'hidden' },
        connected ? h(Screen, { key: JSON.stringify(route), route, height: content, active: !modal })
          : h(Text, { color: 'red' }, '与 Runtime 服务的连接已断开，正在重连…（服务可能在重启；avh service status 可查看）')),
      modal ? h(Box, { height: MODAL_ROWS, flexDirection: 'column', overflow: 'hidden' }, modal) : null,
      h(Text, { color: message ? TONE_COLOR[message.tone] : undefined, wrap: 'truncate-end' }, message?.text ?? ' '),
      h(Text, { dimColor: true, wrap: 'truncate-end' }, '↑↓ 选择  Enter 继续下一步  Esc 返回  1-6 切换  Ctrl+K 所有操作  ? 帮助  q 退出')));
}
