import { randomUUID } from 'node:crypto';
import { useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { askText, choose } from '../actions.ts';
import { manageLocalMaintenance } from '../local-maintenance.ts';
import { h, Loading, Title, useData, useListNav, useUi } from '../core.ts';

type Message = { id: string; role: string; content: string; revision: number | null; interactionStatus: string | null; error: string | null; taskId?: string | null };
type Proposal = { id: string; revision: number; request: string; status: string; inputs: Array<{ name: string }>;
  progress?:{state:string;reason:string;token:string;canResume:boolean;canCancel:boolean} };
const states: Record<string, string> = { queued: '等待 AI', running: 'AI 处理中', awaiting_user: '等待回答', answered: '已回答',
  completed: '已回复', failed: '处理失败', superseded: '已被新要求替代', cancelled: '已取消', proposed: '等待批准', working: '制作中', ready: '待客户端确认',
  interrupted:'制作未完成',recovery_required:'中断待核对',resuming:'等待继续',stopping:'停止待确认',awaiting_decision:'等待你的决定' };

export function ConversationScreen(props: { projectId: string; height: number; active: boolean }): ReturnType<typeof h> {
  const ui = useUi();
  const messages = useData<Message[]>('project.message.list', { projectId: props.projectId });
  const proposals = useData<Proposal[]>('project.production.list', { projectId: props.projectId });
  const intent = useData<Array<{id:string;content:string|null;quote:string}>>('project.intent.list',{projectId:props.projectId});
  const pending = useRef<{ content: string; commandId: string; expectedRevision: number; replyTo?: string } | undefined>(undefined);
  const busy = useRef(false);
  const rows = [...(messages.data ?? []).map(m => ({ id: m.id, title: `${m.role === 'user' ? '你' : 'Harness'} · ${states[m.interactionStatus ?? ''] ?? ''}`,
    text: m.content + (m.error ? `\n暂未处理：${m.error}` : ''), proposal: undefined as Proposal | undefined })),
  ...(proposals.data ?? []).map(p => ({ id: `proposal:${p.id}`, title: `制作提案 · ${p.status === 'completed' ? '已确认' : states[p.progress?.state??p.status] ?? p.status}`,
    text: `${p.request}\n素材：${p.inputs.map(a => a.name).join('、')}${p.progress?`\n${p.progress.reason}`:''}`, proposal: p })),
  ...(intent.data??[]).map(item=>({id:`intent:${item.id}`,title:'当前要求的理解',
    text:`${item.content??'这项要求已撤回'}\n原话：${item.quote}\n理解有误时可直接在对话中纠正；不代表修改已完成。`,proposal:undefined as Proposal|undefined}))];
  const nav = useListNav(rows.length, Math.max(1, props.height - 4));
  const revision = Math.max(0, ...(messages.data ?? []).map(m => m.revision ?? 0));
  const send = async () => {
    const content = await askText(ui, '向 AI 说明目标或回答问题：', { initial: pending.current?.content });
    if (!content?.trim()) return;
    const question = messages.data?.find(m => m.revision === revision && m.interactionStatus === 'awaiting_user');
    if (pending.current?.content !== content) pending.current = { content, commandId: randomUUID(), expectedRevision: revision,
      ...(question ? { replyTo: question.id } : {}) };
    const accepted = await ui.act('已收到，等待 AI 处理', async () => {
      try { await ui.api.call('project.message.add', { projectId: props.projectId, ...pending.current }); }
      catch (error) {
        if (/会话已更新|问题已失效/.test(String(error))) pending.current = undefined;
        throw error;
      }
    });
    if (accepted) pending.current = undefined;
  };
  const open = async () => {
    const selected = rows[nav.index]; if (!selected) return;
    const message = messages.data?.find(m => m.id === selected.id);
    const canRetry = message?.interactionStatus === 'failed' && message.revision === revision && Boolean(message.taskId);
    const p = selected.proposal;
    const canApprove = p?.status === 'proposed' && p.revision === revision;
    const content = [selected.text, ...(canRetry || p?.progress?.canResume ? ['原要求与已有发现仍保留。续接使用已配置的 AI，可能产生调用费用。'] : []), ...(p?.status === 'proposed' ? [
      '批准后使用已配置的 AI，可能产生调用费用；当前没有可靠费用估算。适配与成果仍需独立验证。',
      ...(!canApprove ? ['要求已更新，请等待或请求新的提案。'] : [])] : [])].join('\n');
    // Conservative CJK width keeps every requirement readable, including on a narrow terminal.
    const width = Math.max(8, Math.floor(Math.min(ui.columns, 100) / 2) - 6);
    const lines = content.split('\n').flatMap(line => {
      const chars = [...line], result: string[] = [];
      for (let i = 0; i < chars.length; i += width) result.push(chars.slice(i, i + width).join(''));
      return result.length ? result : [''];
    });
    const count = Math.max(1, Math.min(4, ui.rows - 12)), pages = Math.ceil(lines.length / count);
    let page = 0, decision: string | undefined;
    while (true) {
      decision = await choose(ui, `${selected.title} · ${page + 1}/${pages}`, lines.slice(page * count, (page + 1) * count),
        [...(page > 0 ? [{ key: 'p', label: '上一页' }] : []), ...(page + 1 < pages ? [{ key: 'n', label: '下一页' }] : []),
          ...(canApprove && page + 1 === pages ? [{ key: 'a', label: '批准并开始', tone: 'ok' as const }] : []),
          ...(canRetry ? [{ key: 'c', label: '从中断处继续' }] : []),
          ...(p?.progress?.canResume ? [{key:'c',label:'核对并继续制作'}] : []),
          ...(p?.progress?.canCancel ? [{key:'x',label:p.progress.state==='stopping'?'再次检查停止结果':'取消这次制作',tone:'warn' as const}] : []),
          ...(p?.status === 'proposed' ? [{ key: 'r', label: '放弃提案', tone: 'warn' as const }] : []), { key: 'b', label: '返回' }]);
      if (decision === 'n') { page++; continue; }
      if (decision === 'p') { page--; continue; }
      break;
    }
    if (decision === 'c' && canRetry && message) {
      await ui.act('已请求从中断处继续', () => ui.api.call('project.message.retry', { projectId: props.projectId,
        id: message.id, expectedRevision: revision, expectedTaskId: message.taskId, commandId: `retry:${message.id}:${message.taskId}` }));
      return;
    }
    if(p?.progress && ((decision==='c' && p.progress.canResume) || (decision==='x' && p.progress.canCancel))) {
      const action=decision==='c'?'resume':'cancel';
      await ui.act(action==='resume'?'已请求核对并继续制作':'已请求停止制作；已有成果保留',()=>ui.api.call(`project.production.${action}`,
        {projectId:props.projectId,id:p.id,expectedToken:p.progress!.token,commandId:`tui-${action}:${p.id}:${p.progress!.token.slice(0,32)}`}));
      return;
    }
    if (!p || !['a', 'r'].includes(decision ?? '')) return;
    await ui.act(decision === 'a' ? '制作流程已建立' : '已放弃提案', () => ui.api.call(
      decision === 'a' ? 'project.production.approve' : 'project.production.reject',
      { id: p.id, revision: p.revision, commandId: `tui-approval:${p.id}:${p.revision}` }));
  };
  useInput((input, key) => {
    if (busy.current || nav.handle(input, key)) return;
    const action = input === 'm' ? send : input==='l'?()=>manageLocalMaintenance(ui,props.projectId):key.return ? open : undefined;
    if (action) { busy.current = true; void action().finally(() => { busy.current = false; }); }
  }, { isActive: props.active });
  if (!messages.data || !proposals.data) return h(Loading, { what: '项目对话', error: messages.error ?? proposals.error });
  return h(Box, { flexDirection: 'column' }, h(Title, { text: '项目对话', hint: 'm 提出要求 / 回答  l 本地修复  Enter 查看与决定  Esc 返回' }),
    ...(intent.error ? [h(Text,{key:'intent-error',color:'red'},`当前要求暂时无法读取：${intent.error}`)] : []),
    h(Text, { dimColor: true }, 'AI 先理解并提出方案；制作提案需要你批准。'),
    ...(rows.length ? rows.slice(nav.offset, nav.offset + Math.max(1, props.height - 4)).map((row, i) =>
      h(Text, { key: row.id, wrap: 'truncate-end', inverse: nav.offset + i === nav.index }, `${row.title}  ${row.text.replace(/\n/g, ' ')}`))
      : [h(Text, { key: 'empty' }, '还没有消息，按 m 说明你的目标。')]));
}
