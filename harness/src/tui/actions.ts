import { Box, Text } from 'ink';
import type { GateRow } from '../api/read-model.ts';
import { Dialog, h, TextPrompt, type Ui } from './core.ts';
import { gateState, shortHash } from './format.ts';

/** Rows reserved at the bottom of the screen for dialogs and prompts; a prompt's first line sits at the top of it. */
export const MODAL_ROWS = 10;
export const FOOTER_ROWS = 2;
export const promptRow = (ui: Ui): number => Math.max(2, ui.rows - FOOTER_ROWS - MODAL_ROWS);

export function askText(ui: Ui, label: string, options: { initial?: string; hint?: string; allowEmpty?: boolean } = {}): Promise<string | undefined> {
  return new Promise(resolve => {
    ui.openModal(h(TextPrompt, { label, row: promptRow(ui), initial: options.initial, hint: options.hint, allowEmpty: options.allowEmpty,
      onSubmit: (value: string) => { ui.closeModal(); resolve(value); }, onCancel: () => { ui.closeModal(); resolve(undefined); } }));
  });
}
export function choose(ui: Ui, title: string, body: Array<string | ReturnType<typeof h>>,
  options: Array<{ key: string; label: string; tone?: 'ok' | 'bad' | 'warn' | 'info' | 'muted' }>): Promise<string | undefined> {
  return new Promise(resolve => {
    ui.openModal(h(Dialog, { title, body, options, width: Math.min(ui.columns, 100),
      onChoose: (key: string) => { ui.closeModal(); resolve(key); }, onCancel: () => { ui.closeModal(); resolve(undefined); } }));
  });
}

/** The person decides about the version they were shown: the hash on screen travels with the decision. */
export async function decideGate(ui: Ui, gate: Pick<GateRow, 'gate' | 'question' | 'binds' | 'artifactHash' | 'inputHashes' | 'projectName' | 'owner' | 'status' | 'preview'>,
  view?: () => void): Promise<void> {
  if (!gate.artifactHash) { ui.notify(`${gate.binds} 还不存在，暂时不能决定`, 'warn'); return; }
  const [state] = gateState(gate.status);
  const imageGate = gate.preview === 'recolor-candidates';
  // A stage's Gate can send the stage back with the reason; the reason reaches its executor as the redo note.
  const stage = gate.owner.startsWith('stage:') ? gate.owner.slice(6) : undefined;
  const choice = await choose(ui, `决定 ${gate.gate.slice(gate.gate.lastIndexOf(':') + 1)}（${state}）`, [
    `项目：${gate.projectName}`, gate.question,
    ...(imageGate ? [h(Text, { color: 'yellow' }, '配色批准必须在同一项目的 GUI 中查看 Unity 候选图后完成；TUI 不提供无图批准。')] : []),
    h(Box, null, h(Text, { dimColor: true }, `绑定 ${gate.binds} 的当前版本 ${shortHash(gate.artifactHash)}；产物之后再变，这个决定就会过期。`)),
  ], [...(imageGate ? [] : [{ key: 'a', label: '批准', tone: 'ok' as const }]), ...(stage ? [{ key: 'd', label: '驳回并重做', tone: 'bad' as const }] : []),
    { key: 'r', label: stage ? '只驳回' : '驳回', tone: 'bad' }, ...(view ? [{ key: 'v', label: '查看内容' }] : [])]);
  if (choice === 'v') { view!(); return; }
  if (choice !== 'a' && choice !== 'r' && choice !== 'd') return;
  if (imageGate && choice === 'a') { ui.notify('请在同一项目的 GUI 查看配色候选图后批准。', 'warn'); return; }
  const note = await askText(ui, choice === 'a' ? '批准说明（可空）：' : choice === 'd' ? `驳回原因（会交给阶段 ${stage} 的执行方重做）：` : '驳回原因：',
    { allowEmpty: choice === 'a' });
  if (note === undefined) return;
  await ui.act(choice === 'a' ? '已批准' : choice === 'd' ? `已驳回，阶段 ${stage} 将按原因重做` : '已驳回',
    () => ui.api.call('gate.decide', { gate: gate.gate, approve: choice === 'a', ...(note ? { note } : {}),
      ...(choice === 'd' ? { redo: true } : {}), expectedHash: gate.artifactHash,
      ...(gate.inputHashes ? { expectedInputs: gate.inputHashes } : {}) }, 300_000));
}

export async function redoTask(ui: Ui, taskId: string, passed: boolean): Promise<void> {
  const note = await askText(ui, passed ? '修改意见（会交给执行方）：' : '修改意见（会交给执行方，可空）：', { allowEmpty: !passed,
    hint: passed ? '已通过的阶段重做后，依赖它的后续阶段会重新验证。Enter 确认  Esc 取消' : undefined });
  if (note === undefined) return;
  await ui.act('已记录重做请求', () => ui.api.call('task.redo', { id: taskId, ...(note ? { note } : {}) }));
}
export async function cancelTask(ui: Ui, taskId: string): Promise<void> {
  const choice = await choose(ui, '取消这个任务？', ['正在执行的单元会被停止并确认退出；已经写入的改动保留，并按越界规则记录。'],
    [{ key: 'y', label: '取消任务', tone: 'bad' }, { key: 'n', label: '不取消' }]);
  if (choice === 'y') await ui.act('已取消', () => ui.api.call('task.cancel', { id: taskId }, 300_000));
}
export async function acceptChanges(ui: Ui, taskId: string, count: number): Promise<void> {
  const note = await askText(ui, `接受 ${count} 处越界改动的审阅说明：`);
  if (note) await ui.act('已接受越界改动', () => ui.api.call('task.acceptChanges', { id: taskId, note }));
}
export async function recoverTask(ui: Ui, taskId: string, runDirectory?: string): Promise<void> {
  const choice = await choose(ui, '核对上次执行', [
    '上次执行的结果无法自动确认。请先检查运行目录和工程，再选择：',
    ...(runDirectory ? [`运行目录：${runDirectory}`] : []),
    'n：确认执行单元不存在且没有产生任何改动，重新排队执行。',
    'r：已核对执行结果，交给独立检查判定（执行单元确已结束时，照常收取它的结果与越界扫描）。'],
  [{ key: 'n', label: '无副作用，重新执行' }, { key: 'r', label: '已核对，进入检查' }]);
  if (!choice) return;
  const note = await askText(ui, '核对说明：');
  if (!note) return;
  await ui.act('已恢复', () => ui.api.call('task.recover', { id: taskId, mode: choice === 'n' ? 'no_side_effects' : 'reconciled', note }));
}
export async function cancelWorkflow(ui: Ui, workflowId: string): Promise<void> {
  const choice = await choose(ui, '取消整个 Workflow？', ['所有未完成的任务会先被取消并确认停止；已完成的证据保留。取消后不能恢复，只能新建。'],
    [{ key: 'y', label: '取消 Workflow', tone: 'bad' }, { key: 'n', label: '不取消' }]);
  if (choice !== 'y') return;
  const note = await askText(ui, '取消原因：');
  if (note) await ui.act('已取消 Workflow', () => ui.api.call('workflow.cancel', { id: workflowId, note }, 600_000));
}
export async function newWorkflow(ui: Ui, project?: string): Promise<void> {
  const target = project ?? await askText(ui, '工程目录名（位于工作区内）：');
  if (!target) return;
  const profile = await askText(ui, '流程：', { initial: 'pc-recolor-outfit' });
  if (!profile) return;
  const manifest = await askText(ui, '输入 Manifest 文件路径（可空）：', { allowEmpty: true });
  if (manifest === undefined) return;
  await ui.act('已创建 Workflow', () => ui.api.call('workflow.create', { project: target, profile, ...(manifest ? { manifest } : {}) }));
}
export async function createProject(ui: Ui): Promise<void> {
  const name = await askText(ui, '项目名称：');
  if (!name) return;
  const request = await askText(ui, '描述你想做的头像或修改（也可稍后补充）：', { allowEmpty: true });
  if (request === undefined) return;
  let id: string | undefined;
  if (await ui.act('已建立项目，AI 将帮助理解目标', async () => {
    const result = await ui.api.call<{ id: string }>('project.create', { name, request, mode: 'conversation' }); id = result.id;
  }) && id) ui.push({ screen: 'conversation', projectId: id });
}
export async function importProject(ui: Ui): Promise<void> {
  const path = await askText(ui, '文件夹、压缩工程或 UnityPackage 路径：');if(!path)return;
  const mode=await choose(ui,'如何接手？',['AI 会先判断输入是工程、素材包还是混合内容，并生成可审计的恢复分析。'],[
    {key:'s',label:'浅接手（保留原做法）'},{key:'d',label:'深度改造（隔离副本）'},{key:'o',label:'仅分析'}]);if(!mode)return;
  const distill=await choose(ui,'是否提取可复用做法？',['只生成本地候选记录；不会直接晋升或替换正式能力包。'],[
    {key:'n',label:'不提取'},{key:'y',label:'提取候选'}]);if(!distill)return;
  await ui.act('已安全导入并建立 AI 分析任务', () => ui.api.call('project.import', { path,mode:mode==='s'?'shallow':mode==='d'?'deep':'observe',distill:distill==='y' }, 600_000));
}
