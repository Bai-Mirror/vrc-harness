import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { EventRow, TaskRow } from '../../api/read-model.ts';
import { askText, choose } from '../actions.ts';
import { Cell, h, Line, Loading, Title, useData, useListNav, useUi } from '../core.ts';
import { firstLine, schedulerState, taskState, when } from '../format.ts';
import type { UnityConfig } from '../../config.ts';
import { dependencyStatus, installPlan, type Dependency } from '../../environment.ts';
import { manageSharing } from '../sharing.ts';
import type { SharingState } from '../../sharing/state.ts';

/** What is running now, and the last things that happened anywhere. */
export function ActivityScreen(props: { height: number; active: boolean }): ReturnType<typeof h> {
  const ui = useUi();
  const tasks = useData<TaskRow[]>('task.list', { openOnly: true });
  const events = useData<EventRow[]>('events.recent', { limit: 60 });
  const open = tasks.data ?? [];
  const taskRows = Math.min(Math.max(3, open.length), Math.max(3, Math.floor((props.height - 4) / 2)));
  const nav = useListNav(open.length, taskRows);
  useInput((input, key) => {
    if (nav.handle(input, key)) return;
    if (key.return && open[nav.index]) ui.push({ screen: 'task', taskId: open[nav.index]!.id });
  }, { isActive: props.active });
  if (!tasks.data) return h(Loading, { what: '活动', error: tasks.error });
  const eventRows = Math.max(1, props.height - taskRows - 4);
  const recent = (events.data ?? []).slice(-eventRows);
  return h(Box, { flexDirection: 'column' },
    h(Title, { text: '进行中的任务', hint: `${open.length} 个 · Enter 打开` }),
    open.length ? h(Box, { flexDirection: 'column', height: taskRows },
      ...open.slice(nav.offset, nav.offset + taskRows).map((task, i) => {
        const [label, tone] = taskState(task.status);
        return h(Box, { key: task.id }, h(Cell, { width: 2, tone: 'info' }, nav.offset + i === nav.index ? '›' : ' '),
          h(Cell, { width: 14, tone }, label), h(Cell, { width: 20 }, task.projectName),
          h(Text, { wrap: 'truncate-end' }, `${task.formal ? `阶段 ${task.stage}` : task.goal}${task.waitReason ? ` · ${firstLine(task.waitReason)}` : ''}`));
      })) : h(Box, { height: taskRows }, h(Text, { dimColor: true }, '没有进行中的任务。')),
    h(Title, { text: '最近活动' }),
    ...recent.map(event => h(Box, { key: event.seq }, h(Cell, { width: 7, dim: true }, when(event.at)),
      h(Cell, { width: 9, dim: true }, event.actor), h(Cell, { width: 26 }, event.action),
      h(Text, { wrap: 'truncate-end', dimColor: true }, firstLine(event.reason)))));
}

type ProviderRow = Record<string, string>;
type PackRow = { id:string;version:string;channel:string;description:string;active:boolean };
type KnowledgeCheckRow = { releases:Array<{releaseId:string;version:string;issuedAt:string;size:number;installed:boolean;newer:boolean}>;rejected:number };
export function ProvidersScreen(props: { height: number; active: boolean }): ReturnType<typeof h> {
  const ui = useUi();
  const declared = useData<ProviderRow[]>('provider.list');
  const packs = useData<PackRow[]>('managed.list');
  const [probed, setProbed] = useState<ProviderRow[] | undefined>();
  const [probing, setProbing] = useState(false);
  useInput(input => {
    if (input === 'p' && !probing) {
      setProbing(true);
      ui.api.call<ProviderRow[]>('provider.list', { probe: true }, 300_000)
        .then(rows => { setProbed(rows); ui.notify('已探测各执行方', 'ok'); })
        .catch((error: Error) => ui.notify(`探测失败：${error.message}`, 'bad'))
        .finally(() => setProbing(false));
    } else if (input === 'i') void ui.act('已检查并安装随应用提供的正式能力包',()=>ui.api.call('managed.installBuiltin'));
    else if (input === 'u') void (async()=>{
      let check: KnowledgeCheckRow;
      try { check=await ui.api.call<KnowledgeCheckRow>('knowledge.check',{},60_000); }
      catch(error){ ui.notify(`检查能力包更新失败：${(error as Error).message}`,'bad'); return; }
      const installable=check.releases.filter(release=>!release.installed&&release.newer).slice(0,9);
      if(!installable.length){ ui.notify(check.releases.length?'没有比当前更新的能力包':'服务端没有可用的能力包发行','ok'); return; }
      const picked=await choose(ui,'安装服务端能力包',['只安装、不启用：安装后按 v 切换。已在运行的 Workflow 继续用原来的版本。',
        ...(check.rejected?[`已忽略 ${check.rejected} 个未通过签名校验的发行清单`]:[])],
      installable.map((release,index)=>({key:String(index+1),label:`${release.version} · ${(release.size/1048576).toFixed(1)} MB · ${release.issuedAt.slice(0,10)}`})));
      const release=installable[Number(picked)-1];
      if(release)await ui.act(`已安装能力包 ${release.version}`,()=>ui.api.call('knowledge.install',{releaseId:release.releaseId},30*60_000));
    })();
    else if (input === 'v' && packs.data?.some(pack=>!pack.active)) void (async()=>{
      const choices=packs.data!.filter(pack=>!pack.active).slice(0,9);
      const picked=await choose(ui,'切换或回退正式能力版本',[
        '新 Workflow 使用所选版本；已运行的 Workflow 继续固定原版本。激活前会校验签名、内容哈希和兼容性。'],
      choices.map((pack,index)=>({key:String(index+1),label:`${pack.version} · ${pack.channel}`})));
      const pack=choices[Number(picked)-1];
      if(pack)await ui.act(`已切换到 ${pack.version}`,()=>ui.api.call('managed.activate',{id:pack.id,reason:'用户从 TUI 核心管理切换正式版本'}));
    })();
  }, { isActive: props.active });
  const rows = probed ?? declared.data;
  if (!rows||!packs.data) return h(Loading, { what: '核心与执行方', error: declared.error??packs.error });
  return h(Box, { flexDirection: 'column' },
    h(Title, { text: '执行方', hint: probing ? '正在探测版本与登录状态…' : 'p 实际探测 · i 检查内置能力包 · u 检查能力包更新 · v 切换/回退版本' }),
    h(Box, null, h(Cell, { width: 18, dim: true }, 'id'), h(Cell, { width: 16, dim: true }, '类型'), h(Cell, { width: 10, dim: true }, '登录'),
      h(Cell, { width: 10, dim: true }, '额度已用'), h(Cell, { width: 10, dim: true }, '状态'), h(Text, { dimColor: true }, '沙箱')),
    ...rows.map(row => h(Box, { key: row.id }, h(Cell, { width: 18 }, row.id), h(Cell, { width: 16, dim: true }, row.type),
      h(Cell, { width: 10, tone: row.login === 'ready' ? 'ok' : row.login === 'unknown' ? 'muted' : 'bad' }, row.login),
      h(Cell, { width: 10 }, row.quota_used_percent === 'unknown' ? '—' : `${row.quota_used_percent}%`),
      h(Cell, { width: 10, tone: row.health === 'ready' ? 'ok' : row.health === 'unknown' ? 'muted' : 'bad' }, row.health),
      h(Text, { dimColor: true }, row.sandbox))),
    h(Text, { dimColor: true }, '登录与配置在终端里完成（codex login、claude 等）；Harness 只读取执行能力。'),
    h(Box,{marginTop:1},h(Title,{text:'正式知识与工具版本',hint:'版本不可变；运行中的 Workflow 不受切换影响'})),
    ...packs.data.map(pack=>h(Box,{key:pack.id},h(Cell,{width:2,tone:pack.active?'ok':'muted'},pack.active?'●':'○'),
      h(Cell,{width:18,bold:pack.active},pack.version),h(Cell,{width:12,dim:true},pack.channel),
      h(Text,{dimColor:!pack.active,wrap:'truncate-end'},`${pack.description}${pack.active?' · 当前使用':''}`))),
    !packs.data.length?h(Text,{dimColor:true},'尚未安装正式能力包；按 i 校验并安装随应用提供的版本。'):null);
}

type Status = { runtime: string; schema: number; endpoint: string; eventSeq: number; home: string;
  scheduler: { state: string; pid: number | null; intervalMs: number; restarts: number; lastExit?: { code: number | null; signal: string | null; at: string; stderr: string } };
  lease: { holder: string | null; expiresAt: string | null; cycle: number } };
type Check = { status: string; name: string; detail: string };
type ConfigView = { workspaceRoot:string;exportRoots:string[];defaultProfile:string;profiles:string[];
  providers:Array<{id:string;type:string}>;workflowVariables:{assetLibrary?:string;templateProject?:string};unity?:UnityConfig|null };
export function ServiceScreen(props: { height: number; active: boolean }): ReturnType<typeof h> {
  const ui = useUi();
  const status = useData<Status>('service.status');
  const config = useData<ConfigView>('config.view');
  const sharing = useData<SharingState>('sharing.state');
  const [doctor, setDoctor] = useState<Check[] | undefined>();
  const [deps, setDeps] = useState<Dependency[] | undefined>();
  useInput(input => {
    const state = status.data?.scheduler.state;
    if (input === 'p') {
      if (state === 'running' || state === 'backoff') void ui.act('调度将在本轮结束后暂停', () => ui.api.call('service.pause'));
      else void ui.act('调度已恢复', () => ui.api.call('service.resume'));
    } else if (input === 'd') {
      ui.notify('正在运行 doctor…', 'info');
      ui.api.call<{ checks: Check[] }>('doctor.run', {}, 300_000).then(result => { setDoctor(result.checks); ui.notify('doctor 完成', 'ok'); })
        .catch((error: Error) => ui.notify(`doctor 失败：${error.message}`, 'bad'));
    } else if (input === 'v') {
      // Checked here, in the person's session, where the installer will also run; paint the notice first.
      ui.notify('正在检查环境依赖…', 'info');
      setTimeout(() => { setDeps(dependencyStatus({ unity: config.data?.unity })); ui.notify('环境依赖检查完成', 'ok'); }, 50);
    } else if (input === 's') void manageSharing(ui);
    else if (input === 'r') void ui.act('已重新读取配置', () => ui.api.call('config.reload'));
    else if(input==='e'&&config.data)void (async()=>{
      const current=config.data!;
      const workspaceRoot=await askText(ui,'工作区：',{initial:current.workspaceRoot});if(!workspaceRoot)return;
      const templateProject=await askText(ui,'自定义工程模板（高级，留空自动准备）：',{initial:current.workflowVariables.templateProject??'',allowEmpty:true});if(templateProject===undefined)return;
      const assetLibrary=await askText(ui,'BOOTH 按需缓存目录：',{initial:current.workflowVariables.assetLibrary??''});if(!assetLibrary)return;
      const unityEditor=await askText(ui,'Unity 编辑器（可留空保持不变）：',{initial:current.unity?.editor??'',allowEmpty:true});if(unityEditor===undefined)return;
      const exportText=await askText(ui,'交付目录（多个用逗号分隔）：',{initial:current.exportRoots.join(', ')});if(!exportText)return;
      const defaultProfile=await askText(ui,'默认流程：',{initial:current.defaultProfile});if(!defaultProfile)return;
      const providerText=await askText(ui,'AI 执行方（codex-cli, claude-cli，可空）：',{
        initial:current.providers.map(provider=>provider.type).filter(type=>type==='codex-cli'||type==='claude-cli').join(', '),allowEmpty:true});
      if(providerText===undefined)return;
      await ui.act('已校验并保存配置',()=>ui.api.call('config.update',{workspaceRoot,defaultProfile,unityEditor,
        workflowVariables:{assetLibrary,templateProject},exportRoots:exportText.split(',').map(value=>value.trim()).filter(Boolean),
        providerTypes:providerText.split(',').map(value=>value.trim()).filter(Boolean)}));
    })();
  }, { isActive: props.active });
  if (!status.data||!config.data) return h(Loading, { what: '服务与配置', error: status.error??config.error });
  const data = status.data;
  const [label, tone] = schedulerState(data.scheduler.state);
  return h(Box, { flexDirection: 'column' },
    h(Title, { text: 'Runtime 服务', hint: 'p 暂停/恢复 · d doctor · v 环境依赖 · r 重载 · e 编辑配置' }),
    h(Text, null, data.runtime, h(Text, { dimColor: true }, `  schema ${data.schema}`)),
    h(Line, { tone }, `${label}${data.scheduler.pid ? `（pid ${data.scheduler.pid}，每 ${data.scheduler.intervalMs} ms 一轮）` : ''}${
      data.scheduler.restarts ? `；意外退出已重启 ${data.scheduler.restarts} 次` : ''}`),
    data.scheduler.lastExit && data.scheduler.restarts ? h(Line, { dim: true }, `上次退出 ${when(data.scheduler.lastExit.at)}：${
      data.scheduler.lastExit.code ?? data.scheduler.lastExit.signal} ${firstLine(data.scheduler.lastExit.stderr)}`) : null,
    h(Line, { dim: true }, `调度租约：${data.lease.holder ? `持有至 ${when(data.lease.expiresAt)}` : '空闲'}；已运行 ${data.lease.cycle} 轮`),
    h(Line, { dim: true }, `数据目录 ${data.home}；接口 ${data.endpoint}；事件 ${data.eventSeq}`),
    h(Box,{marginTop:1,flexDirection:'column'},h(Text,{bold:true},'运行配置'),
      h(Line,{dim:true},`工作区：${config.data.workspaceRoot}`),
      h(Line,{dim:true},`Unity 基准：${config.data.workflowVariables.templateProject??'未配置'}`),
      h(Line,{dim:true},`BOOTH 缓存：${config.data.workflowVariables.assetLibrary??'未配置'}`),
      h(Line,{dim:true},`交付：${config.data.exportRoots.join('、')} · 默认流程：${config.data.defaultProfile}`),
      h(Line,{dim:true},`AI：${config.data.providers.map(provider=>provider.type).join('、')||'未配置'}`)),
    h(Line, { dim: true }, '退出界面不会停止后台服务；已派发的执行单元是独立的系统单元，服务重启后自动对账。'),
    h(Line, null, `s 数据与协作 · ${sharing.data?.revokePending ? '本机已停发，远端撤回待送达' : sharing.data?.active ? `已加入 · 待发 ${sharing.data.counts.queued} 条，报告 ${sharing.data.pendingReports} 份` : '未加入；不发送技术记录'}`),
    deps ? h(Box, { flexDirection: 'column', marginTop: 1 }, h(Text, { bold: true }, '环境依赖'),
      ...deps.map(item => h(Box, { key: item.id },
        h(Cell, { width: 8, tone: item.ok ? 'ok' : item.required ? 'bad' : 'warn' }, item.ok ? 'OK' : item.required ? '缺失' : '可选'),
        h(Cell, { width: 18 }, item.name), h(Text, { wrap: 'truncate-end', dimColor: true }, item.ok ? item.detail : `${item.detail} · ${item.purpose}`))),
      (() => { const plan = installPlan(deps); return plan.system.length || plan.user.length
        ? h(Line, { tone: 'warn' }, `在终端运行 avh deps install 一次装齐：${[...plan.system, ...plan.user.map(step => step.id)].join('、')}（系统包会请求一次管理员授权）`)
        : null; })()) : null,
    doctor ? h(Box, { flexDirection: 'column', marginTop: 1 }, h(Text, { bold: true }, 'doctor'),
      ...doctor.slice(0, Math.max(1, props.height - 9)).map((check, i) => h(Box, { key: i },
        h(Cell, { width: 8, tone: check.status === 'OK' ? 'ok' : check.status === 'FAIL' ? 'bad' : 'warn' }, check.status),
        h(Cell, { width: 18 }, check.name), h(Text, { wrap: 'truncate-end', dimColor: true }, check.detail)))) : null);
}

export function HelpScreen(): ReturnType<typeof h> {
  const rows: Array<[string, string]> = [
    ['1 2 3 4 5 6', '首页、项目、素材、后台、核心、设置'], ['↑ ↓ / j k', '选择；PgUp PgDn Home End 翻页'],
    ['Enter', '打开所选'], ['Esc', '返回上一层；关闭对话框'], ['Ctrl+K', '命令菜单（新建 Workflow、导入、暂停调度…）'],
    ['?', '本帮助'], ['q / Ctrl+C', '退出界面（可选择是否暂停调度；后台任务默认继续）'],
    ['a', '决定 Gate（批准、驳回并重做该阶段，或只驳回你看到的那个版本）'], ['d', '重做（修改意见交给执行方；已通过的阶段必须写）'],
    ['c', '取消任务 / Workflow'], ['x', '审阅后接受越界改动'], ['v', '核对需要恢复的执行'],
    ['p', '项目内：查看方案；执行方：探测；服务：暂停/恢复'], ['n / x', '素材页：登记 / 移除本地索引'],
    ['s', '素材页：同步已连接 BOOTH 的元数据索引'], ['i / v', '核心页：安装内置能力包 / 切换或回退正式版本'],
    ['e', '设置页：编辑并校验保存运行配置'], ['b', '接手简报'],
  ];
  return h(Box, { flexDirection: 'column' }, h(Title, { text: '按键' }),
    ...rows.map(([key, text]) => h(Box, { key }, h(Cell, { width: 14, tone: 'info' }, key), h(Text, null, text))),
    h(Text, { dimColor: true }, '文字输入支持中文输入法与粘贴；输入框里 ← → 移动光标，Home/End 到头尾，Ctrl+U 清空；过长时随光标左右滚动。'));
}
