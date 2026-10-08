import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { aggregateProcess } from '../../src/process/aggregate.ts';
import { loadProcess } from '../../src/process/load.ts';
import type { AggregateInput } from '../../src/process/types.ts';
import { nextStep, type WorkflowView } from '../../src/workflow/view.ts';
import { parse as parseYaml } from 'yaml';
import {
  actionText, artifactLabel, assetRole, briefState, candidateState, checkLabel, checkResultWord, gateLabel, gateText, messageState, nextText, observerLabel,
  onMissingLabel, profileTitle, providerLoginName, providerStates, providerType, readableReason, reasonsText, reasonText,
  severityLabel, stageLabel, stageState, taskState, verdictNext, verdictState, workflowState,
} from '../../gui/src/labels.ts';
import { variantSummary } from '../../gui/src/model.ts';

/** Machine words the person must never read: process ids, enum values, English Runtime phrases. */
const RAW = /\b[a-z]{3,}\b|[a-z]+_[a-z]+|\b[A-Z]+_[A-Z_]+\b|\b(RUNNING|READY)\b/;

// Real reasons: aggregate the fixture process under inputs that produce every reason format the Runtime writes.
const definition = loadProcess(readFileSync(new URL('../fixtures/process.yaml', import.meta.url), 'utf8'), {
  schema: 'thresholds/0.1', version: 'fixture-1', t: { max_count: { value: 10, unit: 'items', maturity: 'accepted', source: 'fixture' } } });
function snapshot(): AggregateInput {
  return { artifactHashes: { plan: 'p1', scene: 's1', build: 'b1', fbx: 'f1', delivery_package: 'd1' }, plan: { features: true },
    verdicts: [{ id: 'v-scene', checkId: 'scene_check', scope: 'edit', artifactHash: 's1', result: 'pass' },
      { id: 'v-warning', checkId: 'warning_check', scope: 'build', artifactHash: 'b1', result: 'pass' },
      { id: 'v-conditional', checkId: 'conditional_check', scope: 'build', artifactHash: 'b1', result: 'pass' },
      { id: 'v-package', checkId: 'package_check', scope: 'client', artifactHash: 'd1', result: 'pass' }],
    gateDecisions: [{ gateId: 'plan_approval', artifactHash: 'p1', result: 'approved' }], warningAcceptances: [],
    completions: [{ stageId: 'setup', artifactHashes: { fbx: 'f1' } }, { stageId: 'optional', artifactHashes: { plan: 'p1' } },
      { stageId: 'package', artifactHashes: { plan: 'p1' } }], outOfBoundsChanges: [] };
}
const variations: Array<(input: AggregateInput) => void> = [
  input => { input.verdicts = input.verdicts.filter(v => v.checkId !== 'scene_check'); },
  input => { input.verdicts[0]!.result = 'violation'; },
  input => { input.verdicts[0]!.result = 'no_data'; },
  input => { input.artifactHashes.scene = 's2'; },
  input => { input.verdicts[0]!.scope = 'build'; },
  input => { input.verdicts[1]!.result = 'violation'; },
  input => { input.plan.features = false; },
  input => { input.gateDecisions = []; },
  input => { input.artifactHashes.plan = 'p2'; },
  input => { input.gateDecisions[0]!.result = 'chosen'; },
  input => { input.outOfBoundsChanges.push({ stageId: 'setup', artifact: 'fbx' }); },
  input => { input.completions = input.completions.filter(c => c.stageId !== 'package'); },
  input => { input.artifactHashes.fbx = 'f2'; },
];
const reasons = new Set(variations.flatMap(vary => {
  const input = snapshot(); vary(input);
  return Object.values(aggregateProcess(definition, input).stages).flatMap(stage => stage.reasons);
}));

test('every reason the Runtime gives for a stage reads as words, not as its machine sentence', () => {
  assert.ok(reasons.size >= 12, `only ${reasons.size} distinct reasons were produced`);
  for (const reason of reasons) {
    const text = reasonText(reason);
    assert.ok(text, `no words for "${reason}"`);
    // Names in 「」 come from the vocabulary tables (covered below for the shipped process); the fixture's are synthetic.
    assert.doesNotMatch(text.replace(/「[^」]*」/g, '「」'), RAW, `"${reason}" became "${text}"`);
  }
  assert.equal(reasonText('needs intake: not satisfied'), '等「检查素材」完成');
  assert.equal(reasonText('gate material_gap_confirm: undecided'), '等你决定：确认素材缺口');
  assert.equal(reasonText('something new from a later Runtime'), undefined);
});

test('a stage with many open checks reads as a count, not as a wall of ids', () => {
  const many = [...Array.from({ length: 11 }, (_, i) => `check c${i}: missing verdict`), 'gate plan_approval: undecided'];
  assert.equal(reasonsText(many), '11 项检查待取证 · 等你决定：批准制作方案');
  assert.equal(reasonsText(['check a: violation', 'check b: violation', 'something unknown']), '2 项检查未通过');
  assert.equal(reasonsText([]), '');
});

test('the next step the Runtime writes reads as words in every branch, and says when the scheduler is paused', () => {
  const stage = (status: 'blocked' | 'open', task?: string) => ({ id: 'recolor', status, reasons: ['check x: violation'], codes: [],
    checks: [], gates: [], produces: [], ...(task ? { task: { id: 't', status: task, attempts: 1 } } : {}) });
  const views: Array<Pick<WorkflowView, 'status' | 'stages' | 'gates' | 'plan'>> = [
    { status: 'active', plan: { revisions: 1, approved: false }, stages: [], gates: [{ gate: 'w:plan_approval', workflowId: 'w', project: '/p', projectId:'p',
      kind: 'approve', binds: 'plan', owner: 'stage:plan', status: 'pending' }] },
    { status: 'active', plan: { revisions: 1, approved: true }, stages: [], gates: [{ gate: 'w:client_test', workflowId: 'w', project: '/p', projectId:'p',
      kind: 'do', binds: 'delivery_package', owner: 'milestone:CLIENT_VERIFIED', status: 'pending' }] },
    ...['WAITING_HUMAN', 'RECOVERY_REQUIRED', 'BLOCKED', 'FAILED', 'RUNNING'].map(task =>
      ({ status: 'active', plan: { revisions: 1, approved: true }, stages: [stage('blocked', task)], gates: [] })),
    // A stage blocked only by an unaccepted warning is a decision for the person, not a repair: it must read as such.
    { status: 'active', plan: { revisions: 1, approved: true }, gates: [],
      stages: [{ id: 'regression', status: 'blocked', reasons: ['check x: violation; warning not accepted'],
        codes: ['warning_unaccepted'], checks: [], gates: [], produces: [] }] },
    { status: 'active', plan: { revisions: 1, approved: true }, stages: [stage('open')], gates: [] },
    { status: 'upload_ready', plan: { revisions: 1, approved: true }, stages: [], gates: [] },
    { status: 'active', plan: { revisions: 1, approved: true }, stages: [], gates: [] },
  ];
  for (const view of views) {
    const next = nextStep(view as Pick<WorkflowView, 'status' | 'stages' | 'gates' | 'plan'>);
    for (const running of [true, false]) {
      const text = nextText(next, running);
      assert.doesNotMatch(text, RAW, `"${next}" became "${text}"`);
    }
  }
  assert.equal(nextText('阶段 intake 待开始；后台服务会自动推进', false), '「检查素材」待开始，后台已暂停');
  assert.equal(nextText('等待后台服务推进', false), '后台未启动新工作，已开始的步骤仍会核对结果');
  assert.equal(nextText('等待后台服务推进', true), '后台正在推进');
  assert.equal(nextText(nextStep(views[0]!), true), '需要你决定：批准制作方案');
  // The warning branch: the person is told the reminder is theirs to accept, before the generic "waiting for a person".
  assert.equal(nextText('阶段 regression 有需要你确认的提醒：在阶段详情里查看当前读数并逐条接受', true),
    '「最终效果与贴合检查」有提醒等你确认，查看当前读数后逐条接受');
});

test('a Gate reads as a title and a question about the artifact, keeping a free-text question as written', () => {
  assert.deepEqual(gateText({ gate: 'w1:recolor_approval', question: '批准当前 materials？', binds: 'materials' }),
    { title: '确认配色效果', question: '批准当前的「配色材质」？', approve: true });
  assert.deepEqual(gateText({ gate: 'w1:sdk_upload', question: '需要你亲手完成（delivery_package）', binds: 'delivery_package' }),
    { title: '上传到 VRChat', question: '需要你亲手完成：上传到 VRChat', approve: false });
  assert.equal(gateText({ gate: 'w2:task:confirm', question: '用这套发饰替换原来的吗？', binds: 'plan' }).question, '用这套发饰替换原来的吗？');
});

test('face execution and its engineering result have Chinese labels without implying visual approval', () => {
  assert.equal(stageLabel('face'), '调整脸型');
  assert.equal(artifactLabel('face'), '脸型工程候选');
  assert.equal(observerLabel('face.apply'), '脸型工程检查');
  assert.equal(nextText('阶段 face 进行中（VERIFYING）', true), '「调整脸型」检查中');
  assert.equal(nextText('阶段 face 执行失败：stage completion missing；处理后重做', true), '「调整脸型」执行失败，处理后重做');
  assert.equal(nextText('阶段 face 需要核对上次执行（avh task recover）', true), '「调整脸型」需要核对上次执行');
  assert.equal(reasonsText(['needs face: not satisfied']), '等「调整脸型」完成');
});

test('events read as sentences; an unknown action is marked as such and English developer notes are not shown', () => {
  assert.equal(actionText({ action: 'proposed', entityType: 'project_message' }).text, '提出了修改要求');
  assert.equal(actionText({ action: 'READY->RUNNING', entityType: 'task' }).text, '任务：执行中');
  // Each row says what it is about: the task's stage, the decision, the asset.
  assert.equal(actionText({ action: 'VERIFYING->PASSED', entityType: 'task', stageId: 'outfit' }).text, '装配服装：已通过');
  assert.match(actionText({ action: 'approved', entityType: 'gate', entityId: 'wf-1:recolor_approval' }).text, /^确认配色效果：/);
  assert.match(actionText({ action: 'saved', entityType: 'asset', entityId: 'a1', subject: '春樱和服' }).text, /^春樱和服：|^其他事件$/);
  assert.equal(actionText({ action: 'active->upload_ready', entityType: 'workflow' }).text, '制作流程：可上传');
  assert.deepEqual(actionText({ action: 'teleported' }), { text: '其他事件', known: false });
  // Reclaiming a crashed legacy holder's lock is a normal Runtime event, not a raw name in the timeline.
  assert.equal(actionText({ action: 'unity_handoff_reclaimed', entityType: 'task' }).text, '回收了崩溃残留的 Unity 交接锁');
  // Actions the Runtime writes in every Workflow and every BOOTH job read as sentences, never as raw names.
  for (const [action, entityType] of [['plan_revised', 'plan_revision'], ['plan_unreadable', 'plan_revision'], ['sync_finished', 'booth'],
    ['sync_stopped', 'booth'], ['materialize_finished', 'booth'], ['materialize_stopped', 'booth']] as const)
    assert.equal(actionText({ action, entityType }).known, true, action);
  assert.equal(readableReason('project requirement proposed'), '');
  assert.equal(readableReason('达成 UPLOAD_READY'), '达成 UPLOAD_READY');
});

test('enum values the GUI shows have words: brief, asset role, message, severity, provider probe', () => {
  assert.deepEqual(briefState('direction_pending'), ['方向待确认', 'warn']);
  assert.deepEqual(assetRole('candidate'), ['候选', 'info']);
  assert.deepEqual(messageState('proposed'), ['待确认', 'warn']);
  assert.equal(severityLabel('blocking'), '必须通过');
  assert.equal(stageLabel('regression_pre'), '首次效果检查');
  // Not probed yet is not the same as probed and still unknown.
  assert.deepEqual(providerStates({ state: 'declared', login: 'unknown', health: 'unknown' }).login, ['未探测', 'muted']);
  assert.deepEqual(providerStates({ state: '0.40.0', login: 'unknown', health: 'ready' }), { login: ['未知', 'muted'], health: ['可用', 'ok'] });
  // pi has no login of its own: what the probe calls login is whether the person's API key is stored.
  assert.deepEqual(providerStates({ type: 'pi-cli', state: 'probed', login: 'missing', health: 'unavailable' }).login, ['未保存', 'bad']);
  assert.deepEqual([providerType('pi-cli'), providerLoginName('pi-cli'), providerLoginName('codex-cli')], ['pi', 'API 密钥', '登录']);
});

test('check labels use the four author supplied names and conservatively fall back for every other check', () => {
  assert.equal(checkLabel({ label: '鞋履覆盖', stageId: 'regression', observe: 'avatar.fit' }), '鞋履覆盖');
  assert.equal(checkLabel({ stageId: 'regression', observe: 'avatar.fit' }), '最终效果与贴合检查 · 贴合检查');
  assert.equal(checkResultWord({ verdict: { result: 'pass', current: true } }), '通过');
  assert.equal(checkResultWord({ acceptanceRequired: true, verdict: { result: 'pass', current: true } }), '未接受');
  assert.equal(checkResultWord({ verdict: { result: 'violation', current: true } }), '不符合');
  assert.equal(checkResultWord({ verdict: { result: 'pass', current: false } }), '过期');
  assert.equal(checkResultWord({}), '待取证');
});

test('the outfit box names the count, or the first step when there is none (never "待建立 个衣装方案")', () => {
  assert.deepEqual(variantSummary(0), { title: '尚未建立衣装方案', hint: '用下面的「新增衣装方案」先建第一个', flows: false });
  assert.equal(variantSummary(2).title, '2 个衣装方案');
  assert.equal(variantSummary(2).flows, true);
});

// 信息包装规范 §6.1：未映射的状态值只被上报、仍以枚举名出现在屏幕上，等于把机器词给用户看。
test('a state value the vocabulary lacks says it is still being confirmed instead of showing its enum name', () => {
  const missing: string[] = [];
  onMissingLabel((vocabulary, key) => missing.push(`${vocabulary}:${key}`));
  try {
    assert.deepEqual(taskState('ORPHANED'), ['状态正在确认（ORPHANED）', 'muted']);
    assert.deepEqual(workflowState('teleported'), ['状态正在确认（teleported）', 'muted']);
    assert.deepEqual(stageState('half_done'), ['状态正在确认（half_done）', 'muted']);
  } finally { onMissingLabel(undefined); }
  assert.deepEqual(missing, ['task:ORPHANED', 'workflow:teleported', 'stage:half_done']);
});

// 信息包装规范 §6.2：没测到不是「出问题了」，它要有提示色和朝向「补测」的动作。
test('a level the check could not reach is not red, and it names its own next step', () => {
  assert.deepEqual(verdictState('no_data'), ['缺数据', 'info']);
  assert.deepEqual(verdictState('error'), ['检查出错', 'info']);
  assert.deepEqual(verdictState('undecidable'), ['无法判定', 'info']);
  assert.deepEqual(verdictState('not_applicable'), ['不适用', 'muted']);
  assert.deepEqual(verdictState('violation'), ['不符合', 'bad']);
  assert.deepEqual([verdictNext('no_data'), verdictNext('error'), verdictNext('undecidable'), verdictNext('violation'), verdictNext('pass')],
    ['补测', '补测', '补测或换判据', '修复', '']);
  // The stage's own line separates the two: a missing measurement is not a failed one.
  assert.equal(reasonsText(['check a: violation', 'check b: violation']), '2 项检查未通过');
  assert.equal(reasonsText(['check a: no_data', 'check b: error']), '1 项检查缺数据 · 1 项检查出错');
});

// 信息包装规范 §6.4：「排队回传」暗示自动上传，而队列里的记录只有用户显式发送才离开本机。
test('a queued contribution record reads as waiting on this computer, not as an upload in progress', () => {
  assert.deepEqual(candidateState('queued'), ['已准备，等你发送', 'info']);
  assert.deepEqual(candidateState('submitted'), ['已发送', 'ok']);
});

test('the shipped process has words for every stage, gate, artifact, check subject and severity it can show', t => {
  const missing: string[] = [];
  onMissingLabel((vocabulary, key) => missing.push(`${vocabulary}:${key}`));
  t.after(() => onMissingLabel(undefined));
  const dir = new URL('../../builtin/knowledge/process/', import.meta.url);
  const process = parseYaml(readFileSync(new URL('pc-recolor-outfit.process.yaml', dir), 'utf8')) as { id: string; artifacts: string[];
    stages: Array<{ id: string }>; gates: Array<{ id: string }>; checks: Array<{ observe: string; severity: string }> };
  for (const stage of process.stages) assert.notEqual(stageLabel(stage.id), stage.id.replaceAll('_', ' '), `stage ${stage.id}`);
  for (const gate of process.gates) assert.notEqual(gateLabel(gate.id), gate.id.replaceAll('_', ' '), `gate ${gate.id}`);
  for (const artifact of process.artifacts) artifactLabel(artifact);
  for (const check of process.checks) { observerLabel(check.observe); severityLabel(check.severity); }
  assert.notEqual(profileTitle(process.id), process.id);
  assert.deepEqual(missing, []);
});
