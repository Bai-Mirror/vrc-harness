import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import type { SharingNotice } from '../shared/sharing.ts';
import type { SharingState } from '../sharing/state.ts';
import type { CandidateReport } from '../shared/candidate-report.ts';
import { choose, MODAL_ROWS } from './actions.ts';
import { h, type Ui } from './core.ts';

/** One scrollable notice: joining cannot skip the rest of the current data policy on a short terminal. */
function Notice(props: { ui: Ui; notice: SharingNotice; state: SharingState; done(key?: string): void }): ReturnType<typeof h> {
  const width = Math.max(20, Math.min(96, props.ui.columns - 4));
  const source = [props.notice.summary, ...props.notice.shared, `不发送：${props.notice.never.join('、')}`, props.notice.where,
    props.notice.retention, props.notice.queue, props.notice.perItem];
  const lines = source.flatMap(text => {
    const rows: string[] = []; let line = '';
    for (const char of text) { if (stringWidth(line + char) > width) { rows.push(line); line = ''; } line += char; }
    rows.push(line); return rows;
  });
  const height = Math.max(1, MODAL_ROWS - 8), last = Math.max(0, lines.length - height);
  const [offset, setOffset] = useState(0);
  useInput((input, key) => {
    if (key.escape) props.done();
    else if (key.downArrow || input === 'j') setOffset(value => Math.min(last, value + 1));
    else if (key.upArrow || input === 'k') setOffset(value => Math.max(0, value - 1));
    else if (key.pageDown) setOffset(value => Math.min(last, value + height));
    else if (key.pageUp) setOffset(value => Math.max(0, value - height));
    else if (key.end) setOffset(last);
    else if (input === 'o') props.done('off');
    else if (input === 'x') props.done('revoke');
    else if (input === 'r' && props.state.installation) props.done('remote');
    else if (input === 'f' && props.state.active && props.state.counts.queued) props.done('flush');
    else if (input === 'c' && props.state.active) props.done('candidate');
    else if (input === 'a' && offset === last && !props.state.revokePending) props.done('on');
  });
  return h(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1, width: width + 4 },
    h(Text, { bold: true }, '数据与协作 · 自愿加入，可以随时退出'),
    h(Text, null, props.state.revokePending ? '本机已停止；远端撤回待送达，请重试撤回。' : props.state.active ? '已加入技术协作' : '未加入；不发送技术记录'),
    h(Text, null, `待发 ${props.state.counts.queued} 条 · 已发 ${props.state.counts.sent} 条 · 待发报告 ${props.state.pendingReports} 份`),
    ...lines.slice(offset, offset + height).map((line, index) => h(Text, { key: index, wrap: 'truncate-end' }, line)),
    h(Text, { dimColor: true }, `↑↓ / PgUp PgDn 阅读说明 ${offset + 1}–${Math.min(lines.length, offset + height)}/${lines.length}`),
    h(Text, null, `${offset === last && !props.state.revokePending ? '[a] 明确加入' : '读完说明后可加入'} · [o] 关闭回传 · [x] 停止并撤回`),
    h(Text, null, `${props.state.installation ? '[r] 服务器记录 · ' : ''}${props.state.active ? '[f] 发送待发记录 · [c] 候选技术报告 · ' : ''}Esc 返回`));
}

interface ReportPreview {
  candidateId: string; version: string; reason: string; basePackId: string; contentHash: string; evaluationId: string; reportHash: string;
  evaluation: { suiteId: string; suiteVersion: string; isolation: string; startedAt: string };
  rateDenominators: { baseline: number; candidate: number }; report: CandidateReport;
}
function ReportReview(props: { ui: Ui; preview: ReportPreview; done(confirmed: boolean): void }): ReturnType<typeof h> {
  const preview = props.preview, rate = (value: number | null) => value === null ? '未测' : `${(100 * value).toFixed(1)}%`;
  const summary = (name: 'baseline' | 'candidate', title: string) => {
    const item = preview.report.evaluation[name];
    return [`${title}：${item.cases} 个案例，${item.modelFamilies} 个模型家族，${item.attempts} 次尝试（通过 ${item.passes}、未通过 ${item.failures}）。`,
      `首次通过率 ${rate(item.firstPassRate)}，两次内累计通过率 ${rate(item.secondPassRate)}；比率分母为 ${preview.rateDenominators[name]} 个案例×模型组合。`];
  };
  const content = [`本地候选：${preview.version}；${preview.reason}`, `本地基准：${preview.basePackId}；评测 ${preview.evaluation.suiteId} ${preview.evaluation.suiteVersion}（${preview.evaluation.isolation}）。`,
    `评测状态：${preview.report.evaluation.status === 'passed' ? '通过' : '未通过'}；不代表真实业务完成或被维护者采纳。`,
    ...summary('baseline', '基准结果'), ...summary('candidate', '候选结果'),
    `实际报告用途：改进产品；类别：候选评测；来源分类：${({ ai: 'AI生成', distill: '经验整理', human: '人工', import: '导入', unknown: '未知' } as Record<string, string>)[preview.report.sourceKind]}。`,
    '上传范围：仅上述评测状态、来源分类、基准/候选统计和比率。附随机报告身份、内容摘要和这次明确授权凭据。',
    '本地候选名称、原因、基准标识、评测标识、案例原名、模型原名与路径不上传；不发送知识包、工具、原文或私人材料。',
    '确认只授权这份当前版本报告；后续仍可选择暂不发送。接收不代表采纳、启用或发布。'];
  const width = Math.max(20, Math.min(96, props.ui.columns - 4)), lines = content.flatMap(text => {
    const rows: string[] = []; let line = '';
    for (const char of text) { if (stringWidth(line + char) > width) { rows.push(line); line = ''; } line += char; } rows.push(line); return rows;
  });
  const height = Math.max(1, MODAL_ROWS - 5), last = Math.max(0, lines.length - height), [offset, setOffset] = useState(0);
  useInput((input, key) => {
    if (key.escape || input === 'n') props.done(false);
    else if (key.downArrow || input === 'j') setOffset(value => Math.min(last, value + 1));
    else if (key.upArrow || input === 'k') setOffset(value => Math.max(0, value - 1));
    else if (key.pageDown) setOffset(value => Math.min(last, value + height));
    else if (key.pageUp) setOffset(value => Math.max(0, value - height));
    else if (key.end) setOffset(last);
    else if (input === 'y' && offset === last) props.done(true);
  });
  return h(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1, width: width + 4 },
    h(Text, { bold: true }, `查看技术报告 · ${preview.version}`),
    ...lines.slice(offset, offset + height).map((line, index) => h(Text, { key: index, wrap: 'truncate-end' }, line)),
    h(Text, { dimColor: true }, `↑↓ / PgUp PgDn 查看 ${offset + 1}–${Math.min(lines.length, offset + height)}/${lines.length}`),
    h(Text, null, offset === last ? '[y] 明确授权这份报告 · [n] 不授权 · Esc 返回' : '查看完报告与上传范围后可授权 · Esc 返回'));
}

async function candidateReport(ui: Ui): Promise<void> {
  const candidates = await ui.api.call<Array<{ id: string; version: string; reason: string; reportDecision: { eligible: boolean; reasons: string[] } }>>('managed.candidate.list');
  const eligible = candidates.filter(item => item.reportDecision.eligible).slice(0, 9);
  if (!eligible.length) { ui.notify('尚无可回传的已完成技术评测报告；正在执行的候选不会发送。', 'info'); return; }
  const picked = await choose(ui, '查看候选技术报告', ['选择后先查看实际统计、基准和上传范围；这里不会授权或发送。'],
    eligible.map((item, index) => ({ key: String(index + 1), label: `${item.version} · ${item.reason.split('\n')[0]!.slice(0, 32)}` })));
  const candidate = eligible[Number(picked) - 1]; if (!candidate) return;
  const preview = await ui.api.call<ReportPreview>('managed.contribution.preview', { candidateId: candidate.id });
  const confirmed = await new Promise<boolean>(resolve => ui.openModal(h(ReportReview, { ui, preview,
    done: (value: boolean) => { ui.closeModal(); resolve(value); } })));
  if (!confirmed) return;
  const report = await ui.api.call<{ id: string }>('managed.contribution.authorize', { candidateId: candidate.id,
    expectedEvaluationId: preview.evaluationId, expectedContentHash: preview.contentHash, expectedReportHash: preview.reportHash,
    authorizedBy: 'local-user', consentText: '用户在 TUI 审阅并授权这份结构化技术评测报告' });
  ui.refresh();
  const send = await choose(ui, '报告已授权', ['可以现在发送，或保留在有限待发队列。关闭回传会取消未发送报告并清理载荷。'],
    [{ key: 'y', label: '现在发送' }, { key: 'n', label: '暂不发送' }]);
  if (send === 'y') await ui.act('已发送技术报告；接收不代表采纳或发布', () => ui.api.call('managed.contribution.submit', { id: report.id }));
}

/** TUI is a consumer of the existing Runtime consent/queue/ownership contract. */
export async function manageSharing(ui: Ui): Promise<void> {
  try {
    const [state, notice] = await Promise.all([ui.api.call<SharingState>('sharing.state'), ui.api.call<SharingNotice>('sharing.notice')]);
    const action = await new Promise<string | undefined>(resolve => ui.openModal(h(Notice, { ui, state, notice,
      done: (key?: string) => { ui.closeModal(); resolve(key); } })));
    if (action === 'on' || action === 'off') await ui.act(action === 'on' ? '已明确加入技术协作' : '回传已关闭；本地制作和软件更新照常使用',
      () => ui.api.call('sharing.choose', { surface: 'tui', noticeShown: true, enabled: action === 'on' }));
    else if (action === 'flush') await ui.act('已发送当前获准的待发记录', () => ui.api.call('sharing.flush'));
    else if (action === 'candidate') await candidateReport(ui);
    else if (action === 'remote') {
      const remote = await ui.api.call<{ records?: unknown[]; contributions?: unknown[] } | null>('sharing.remoteStatus');
      await choose(ui, '服务器记录', [remote ? `服务器保存 ${(remote.records ?? []).length} 批技术记录、${(remote.contributions ?? []).length} 份贡献报告。` : '没有本机安装记录。'],
        [{ key: 'enter', label: '返回' }]);
    } else if (action === 'revoke') {
      const confirm = await choose(ui, '停止并撤回这台安装的数据？', [
        '本机立即停止回传并清空待发记录和未发送报告。服务器确认后删除尚未采纳的数据；已发布内容会在结果中单列。',
        '离线时本机仍停止发送，远端撤回会显示待送达；本地制作和独立软件更新不受影响。'], [{ key: 'y', label: '停止并撤回', tone: 'bad' }, { key: 'n', label: '返回' }]);
      if (confirm === 'y') {
        try {
          const result = await ui.api.call<{ revoked: boolean }>('sharing.revoke');
          ui.notify(result.revoked ? '服务器已确认撤回；本机已停止回传' : '本机已停止回传；没有服务器安装需要撤回', 'ok');
        } catch (error) {
          const current = await ui.api.call<SharingState>('sharing.state').catch(() => null);
          ui.notify(`${current?.revokePending ? '本机已停止；远端撤回待送达' : '撤回尚未完成'}：${(error as Error).message}`, 'warn');
        }
        finally { ui.refresh(); }
      }
    }
  } catch (error) { ui.notify(`数据与协作：${(error as Error).message}`, 'bad'); ui.refresh(); }
}
