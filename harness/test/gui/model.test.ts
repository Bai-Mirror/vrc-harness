import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  archiveNextView, archiveFactIsDiagnostic, attentionChecks, facePreviewMode, attempt, boothLine, cardMeta, cardNext, cardProgress, dependencyState, errorText, filterProjects, groupEvents, materializeBlocker,
  firstRunBlockers, missingRequired, homeNext, inProgress, placeholder, placeholderColors, planDetails, planSummary,
  conversationNeedsRestore, focusConversationNeed, focusTaskConversation, productionLabel, productionState, progressCheckCounts, progressEvidenceText, progressStageSummary, progressSummaryLines, projectForGate, projectRowsForWorkflow, projectTaskRows, projectWorkspaceGates, taskNeedAction, verdictTally, workbenchConversationTarget, workbenchNeeds,
  projectNext, projectState, readinessRows, schedulerControl, stageView, startReadiness, startWarnings, verdictCounts,
  NO_PI, PI_SECRETS, piChoicesFrom, piSecretFor, piStateFrom,
  importSourceLabel, IMPORT_FILTERS, pathChoices, piAddressOptions, piModelOptions, piRegionChange, PLACEHOLDER_HUES, recentProjects, samePath,
  unityEditorFilters, unityEditorNote, VRCHAT_UNITY,
} from '../../gui/src/model.ts';
import { PI_MODELS } from '../../src/shared/pi.ts';
import { VRCHAT_UNITY_VERSION } from '../../src/unity-editors.ts';
import { chosenItems, DEFAULT_SETUP_CHOICES, dependencyGroups, setupButton, sizeText } from '../../gui/src/model.ts';
import { blockerAction, bytesText, groupLayer, groupRegistration, jobShare, jobText } from '../../gui/src/model.ts';
import { onMissingLabel, restoreDecision, shareLevel } from '../../src/shared/labels.ts';
import { DEFAULT_CHOICES, includedItems, windowsSetupPlan, type WindowsProbe } from '../../src/windows-setup.ts';

const guiSources = readdirSync(new URL('../../gui/src/', import.meta.url)).filter(name => /\.tsx?$/.test(name))
  .map(name => ({ name, source: readFileSync(new URL(`../../gui/src/${name}`, import.meta.url), 'utf8') }));

test('a failed action is reported with its message and resolves false; a Tauri string rejection is reported as is', async () => {
  const reported: string[] = [];
  assert.equal(await attempt(async () => { throw new Error('配置没有通过校验'); }, message => reported.push(message)), false);
  assert.equal(await attempt(() => Promise.reject('内建 BOOTH 登录只在桌面版可用'), message => reported.push(message)), false);
  assert.equal(await attempt(async () => 'fine', message => reported.push(message)), true);
  assert.deepEqual(reported, ['配置没有通过校验', '内建 BOOTH 登录只在桌面版可用']);
  assert.equal(errorText({ message: 'HTTP 502' }), 'HTTP 502');
  assert.equal(errorText(undefined), 'undefined');
});

test('the GUI asks and reports inside the window: no native alert, confirm or prompt', () => {
  for (const { name, source } of guiSources)
    assert.doesNotMatch(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''), /(^|[^.\w])(alert|confirm|prompt)\s*\(/m, name);
});

const gate = { gate: 'w1:recolor_approval', status: 'pending', project: '/w/Luna-春樱', projectName: 'Luna-春樱', question: '批准当前 materials？',
  binds: 'materials' };
const task = { stage: 'outfit', status: 'WAITING_HUMAN', projectName: 'Luna-夏日', needsYou: true };

test('the home page says what to do now: decisions first, then a paused scheduler with a way to resume it', () => {
  const needs = homeNext({ gates: [gate, { ...gate, gate: 'w1:x', status: 'approved' }], tasks: [task], projects: [], scheduler: 'paused' });
  assert.equal(needs.title, '有 2 项需要你处理');
  assert.equal(needs.text, 'Luna-春樱：批准当前的「配色材质」？');
  assert.deepEqual([needs.action?.kind, needs.resume], ['first', true]);
  // A paused scheduler is not "nothing to do": production does not move until it runs.
  for (const scheduler of ['paused', 'stopped', 'backoff']) {
    const idle = homeNext({ gates: [], tasks: [], projects: [{ workflow: { status: 'active' } }], scheduler });
    assert.equal(idle.title, '后台已暂停，未启动新工作');
    assert.equal(idle.action?.kind, 'resume');
  }
  const calm = homeNext({ gates: [], tasks: [], projects: [{ workflow: { status: 'active' } }, { workflow: { status: 'active' } },
    { workflow: { status: 'upload_ready' } }, {}], scheduler: 'running' });
  assert.deepEqual([calm.title, calm.text, calm.action], ['现在不需要你处理', '后台正在推进 2 个项目。', undefined]);
  assert.equal(homeNext({ gates: [], tasks: [], projects: [] }).text, '正在连接后台…');
});

test('a project leads with its next step, points to its decisions, and offers to resume a paused scheduler', () => {
  assert.equal(projectNext({ hasWorkflow: false, openGates: 0, scheduler: 'running' }).title, '还没有开始制作');
  const deciding = projectNext({ hasWorkflow: true, next: '需要你决定：recolor_approval（批准或驳回，绑定 materials）', openGates: 1,
    scheduler: 'paused', status: 'active' });
  assert.deepEqual([deciding.title, deciding.tone, deciding.resume, deciding.action], ['需要你决定：确认配色效果', 'warn', true, undefined]);
  const paused = projectNext({ hasWorkflow: true, next: '阶段 intake 待开始；后台服务会自动推进', openGates: 0, scheduler: 'stopped', status: 'active' });
  assert.deepEqual([paused.title, paused.action?.kind], ['「检查素材」待开始，后台已暂停', 'resume']);
  assert.equal(projectNext({ hasWorkflow: true, next: '阶段 intake 进行中（RUNNING）', openGates: 0, scheduler: 'running', status: 'active' }).action, undefined);
});

test('the scheduler has one control whose action follows its state: never pause and resume side by side', () => {
  assert.deepEqual(schedulerControl('running').method, 'service.pause');
  for (const state of ['paused', 'stopped', 'backoff']) {
    const control = schedulerControl(state);
    assert.deepEqual([control.method, control.primary], ['service.resume', true], state);
  }
  assert.equal(schedulerControl('pausing').method, undefined);
  assert.equal(schedulerControl(undefined).method, undefined);
  assert.deepEqual(schedulerControl('paused').state, ['调度已暂停', 'warn']);
});

test('pausing current work never offers an ineffective resume action on home or project pages', () => {
  const home = homeNext({ gates: [], tasks: [], projects: [{ workflow: { status: 'active' } }], scheduler: 'pausing' });
  assert.equal(home.action, undefined);
  assert.equal(home.resume, undefined);
  assert.match(home.title, /当前步骤仍在收尾/);
  assert.equal(homeNext({ gates: [gate], tasks: [], projects: [], scheduler: 'pausing' }).resume, false);
  const project = projectNext({ hasWorkflow: true, openGates: 0, scheduler: 'pausing', status: 'active' });
  assert.equal(project.action, undefined);
  assert.match(project.text, /不会启动新工作/);
  assert.equal(projectNext({ hasWorkflow: true, openGates: 1, scheduler: 'pausing', status: 'active' }).resume, false);
});

test('the plan an approval covers is summarised from plan.yaml; anything else summarises to nothing', () => {
  const plan = { schema: 'plan/0.2', body: '7000004', outfits: [{ id: 'kimono', item: '7000001', label: '春樱和服' },
    { id: 'casual', item: '7000003', label: '日常' }], default_outfit: 'kimono',
    recolor: { targets: [{ part: 'hair', hue_shift: -20 }, { part: 'outfit:kimono', hue_shift: 10 }], candidates: 3 },
    menu: { selector: { type: 'radial', label: '衣装', parameter: 'AVH/Outfit' } }, notes: '保留素体原有表情。' };
  assert.deepEqual(planSummary(plan), [['素体', '7000004'], ['服装', '春樱和服、日常（默认穿「春樱和服」）'],
    // One separator for every kind of target: a layered one reads as a phrase with an arrow, so the list
    // is punctuated as phrases rather than as bare nouns. A relative target carries the shift it will apply:
    // naming only the part hid the numbers the stage acts on.
    ['改色', '头发（色相 -20°）；服装「春樱和服」（色相 +10°），给出 3 档候选'], ['菜单', '一个轮盘「衣装」切换服装'], ['说明', '保留素体原有表情。']]);
  assert.deepEqual(planSummary(null), []);
  assert.deepEqual(planSummary('plan: broken'), []);
  assert.deepEqual(planSummary({ outfits: 'none', recolor: { targets: 7 } }), []);
});

// A layered target names a region inside the author's own file and therefore has no `part`. Reading only
// `part` made such a plan summarise as a bare candidate count, so a person was shown nothing about the
// colours and regions they were approving. The region is displayed under the author's own name, trailing
// space included, because that name is the region's identity.
test('grouped plan approval shows independent defaults, persistence and source details through the GUI model', () => {
  const synced = { type: 'Float', saved: true, synced: true };
  const plan = { schema: 'plan/0.3', default_outfit: 'obsolete', outfits: [{ id: 'obsolete', label: 'Old global selection' }],
    avatar_config: { instances: [{ id: 'source', item: 'Inputs/source.zip', prefab: 'Assets/Source.prefab', variants: [{ id: 'light', prefab: 'Assets/Light.prefab' }] }],
      groups: [
        { id: 'outfit', label: '服装', activation: 'exclusive', default: 'second', parameter: synced, members: [{ id: 'first', label: '衣一' }, { id: 'second', label: '衣二' }] },
        { id: 'hair', label: '发型', activation: 'exclusive', default: 'short', parameter: { type: 'Int', saved: false, synced: false }, members: [{ id: 'short', label: '短发' }, { id: 'long', label: '长发' }] },
        { id: 'accessories', label: '配饰', activation: 'independent', members: [{ id: 'a', label: '腕饰', default: false, parameter: synced }, { id: 'b', label: '颈饰', default: true, parameter: { saved: false, synced: false } }] },
        { id: 'fixed', label: '共同穿戴', activation: 'fixed', members: [1, 2, 3, 4].map(i => ({ id: 'fixed' + i, label: '固定件' + i })) },
      ], shared_switches: [{ label: '外套部件', default: true, parameter: synced }] } };
  const rows = new Map(planSummary(plan));
  assert.match(rows.get('服装')!, /连续轮盘，默认「衣二」.*保存选择.*同步给其他玩家/);
  assert.match(rows.get('发型')!, /离散选项，默认「短发」.*加载时恢复默认.*仅本地/);
  assert.match(rows.get('配饰')!, /腕饰默认关闭.*颈饰默认开启/);
  assert.match(rows.get('共同穿戴')!, /固定件1、固定件2、固定件3、固定件4.*全部共同穿戴/);
  assert.match(rows.get('外套部件')!, /跨造型记忆，默认开启/);
  assert.doesNotMatch(JSON.stringify([...rows]), /Old global selection|Assets\/|Inputs\//);
  const details = JSON.stringify(planDetails(plan));
  for (const path of ['Inputs/source.zip', 'Assets/Source.prefab', 'Assets/Light.prefab']) assert.ok(details.includes(path));
});

test('a layered recolour target is described by its region, colour and promise', () => {
  const plan = { schema: 'plan/0.2', body: 'Milfy_v1.5.0.zip', body_prefab: 'Assets/PLUSONE/Milfy/Prefab/Milfy.prefab',
    outfits: [], recolor: { candidates: 1, targets: [
      { requirement_id: 'detail_eyelash_gray', layered: 'Milfy_v1.5.0/PSD/PSD_Default/Face_default.psd',
        layer: ['eyelash '], color: '#5B5B66', semantics: 'flat' },
      { requirement_id: 'outfit_main_cream', layered: 'Milfy_v1.5.0/PSD/PSD_Default/Costume_default.psd',
        layer: ['Cardigan'], color: '#FAF3EE', semantics: 'shade' },
      { part: 'hair' }] } };
  const recolour = planSummary(plan).find(([label]) => label === '改色')?.[1] ?? '';
  assert.match(recolour, /作者分层「eyelash 」 → #5B5B66 → 该区域整体换成这个颜色/, recolour);
  assert.match(recolour, /作者分层「Cardigan」 → #FAF3EE → 换成这个颜色的同时保住作者的明暗/, recolour);
  // A target with a part still reads as before, and the two kinds share one line.
  assert.match(recolour, /头发/, recolour);
  assert.match(recolour, /给出 1 档候选/, recolour);
});

// The third target form replaces the vendor material of an outfit's matching slots and carries no colour at
// all. Reading only `part` and `color` skipped it entirely, so a plan whose whole requirement was a material
// swap summarised as a bare candidate count.
test('a material recolour target names the outfit, the asset and the requirement it answers', () => {
  const plan = { schema: 'plan/0.2', body: 'Milfy_v1.5.0.zip',
    outfits: [{ id: 'dress', item: '7000003', label: '白蕾丝裙' }], default_outfit: 'dress',
    recolor: { candidates: 1, targets: [{ requirement_id: 'dress_body_tier2', outfit: 'dress',
      material: 'Assets/Vendor/Tier2/Dress_Body.mat' }] } };
  assert.deepEqual(planSummary(plan).find(([label]) => label === '改色'),
    ['改色', '要求 dress_body_tier2：服装「白蕾丝裙」的对应槽位换成「Dress_Body.mat」，给出 1 档候选']);
  // The asset path is a location, so it is available under details rather than in the approval line.
  assert.deepEqual(planDetails(plan), [['材质资产（dress_body_tier2）', 'Assets/Vendor/Tier2/Dress_Body.mat']]);
});

// A layered target reads its region from a source file the vendor shipped; that path is where the person
// checks the claim, so it belongs in details next to the material one.
test('a layer target keeps its source file in details, beside the colour the summary shows', () => {
  const plan = { schema: 'plan/0.2', outfits: [], recolor: { candidates: 1, targets: [
    { requirement_id: 'outfit_trim_cream', layered: 'Milfy_v1.5.0/PSD/Costume_default.psd', layer: ['Trim'],
      color: '#FAF3EE', semantics: 'shade' }] } };
  assert.deepEqual(planDetails(plan), [['分层源文件（outfit_trim_cream）', 'Milfy_v1.5.0/PSD/Costume_default.psd']]);
});

// 相对改色只写部件名，等于让人批准「头发」而看不到实际要应用的色相/饱和度/明度（复核指出，与按层、材质两种
// 形态同一类缺陷）。不动值（色相 0、饱和 1、明度 1）不写成 no-op。
test('a relative recolour target carries the shift it will apply, leaving no-change values out', () => {
  const recolour = (target: Record<string, unknown>) => planSummary({ schema: 'plan/0.2', recolor: { candidates: 3, targets: [target] } })
    .find(([label]) => label === '改色')?.[1] ?? '';
  assert.equal(recolour({ part: 'hair', hue_shift: -18, saturation: 0.9, value: 1.1 }),
    '头发（色相 -18°、饱和度 ×0.9、明度 ×1.1），给出 3 档候选');
  assert.equal(recolour({ part: 'eye', hue_shift: 12, saturation: 1, value: 1 }), '眼睛（色相 +12°），给出 3 档候选');
  assert.equal(recolour({ part: 'skin' }), '皮肤，给出 3 档候选');
});

test('the actual face intention is visible before plan approval while full file paths remain in requested details', () => {
  const plan = { body: 'C:\\private\\Milfy_v1.5.0.zip', outfits: [{ id: 'dress', item: 'Assets/Imported/dress.prefab', label: '白蕾丝裙' }],
    face: { mode: 'design', intent: '放大眼型，柔和下颌，保留表情系统' }, notes: '将从 C:\\private\\dress.zip 核对材质，当前未验证适配。' };
  const summary = planSummary(plan), details = planDetails(plan);
  assert.deepEqual(summary.find(row => row[0] === '素体'), ['素体', 'Milfy_v1.5.0.zip']);
  assert.match(summary.find(row => row[0] === '脸型目标')![1], /放大眼型.*不代表接受效果/);
  assert.equal(summary.some(row => row[1].includes('C:\\private') || row[1].includes('Assets/Imported')), false);
  assert.deepEqual(details, [['素体文件', plan.body], ['白蕾丝裙文件', plan.outfits[0].item], ['完整说明', plan.notes]]);
  assert.deepEqual(planSummary({ face: { mode: 'preserve' } }), [['脸型', '保留原有脸型与表情系统；仍需制作检查']]);
  assert.deepEqual(planSummary({ face: { mode: 'unknown', intent: '不能自称执行' } }), []);
  assert.deepEqual(planDetails(null), []);
});

const check = (result?: string, current = true) => ({ verdict: result ? { result, current } : undefined });
test('a stage row says where it stands: passed with its evidence, reworking after a failure, waiting for evidence, deciding', () => {
  assert.deepEqual(stageView({ id: 'intake', status: 'passed', reasons: [], checks: [check('pass'), check('pass'), check('not_applicable')] }),
    { label: '检查素材', state: ['已通过', 'ok'], mark: '✓', note: '2 项检查通过，1 项不适用' });
  assert.deepEqual(stageView({ id: 'outfit', status: 'blocked', display: 'running', reasons: ['check skeleton_missing_zero: violation'],
    task: { status: 'RUNNING', attempts: 2 }, checks: [check('pass'), check('violation')] }),
    { label: '装配服装', state: ['返工中', 'warn'], mark: '↻', note: '1 项检查未通过，正在第 2 次执行' });
  assert.equal(stageView({ id: 'plan', status: 'passed', reasons: [], checks: [check('not_applicable'), check('not_applicable')] }).note,
    '2 项检查不适用');
  // Not run yet is not a failure: no red for missing evidence.
  assert.deepEqual(stageView({ id: 'intake', status: 'blocked', reasons: ['check a: missing verdict', 'check b: missing verdict',
    'gate material_gap_confirm: undecided'], checks: [check(), check()] }).state, ['待取证', 'info']);
  assert.deepEqual(stageView({ id: 'setup', status: 'blocked', reasons: ['check guid_unique: violation'], checks: [check('violation')] }).state,
    ['未通过', 'bad']);
  assert.deepEqual(stageView({ id: 'setup', status: 'blocked', reasons: ['check guid_unique: stale verdict'], checks: [check('pass', false)] }).state,
    ['证据已过期', 'warn']);
  const deciding = stageView({ id: 'recolor', status: 'blocked', display: 'deciding', reasons: ['gate recolor_approval: undecided'],
    checks: [check('pass'), check('pass')] });
  assert.deepEqual([deciding.state, deciding.note], [['待你决定', 'warn'], '2 项检查通过 · 等你决定：确认配色效果']);
  assert.equal(stageView({ id: 'menu', status: 'waiting', reasons: ['needs recolor: not satisfied'], checks: [check()] }).note, '等「调整颜色」完成');
});

test('evidence for an older version is counted as stale, never as a pass', () => {
  assert.deepEqual(verdictCounts([check('pass'), check('pass', false), check('violation'), check('undecidable'), check()]),
    { total: 5, pass: 1, fail: 1, noData: 0, error: 0, unsure: 1, stale: 1, pending: 1, na: 0 });
});

test('workbench L0 merges a gate, warning, task and interruption by their authoritative identity', () => {
  const rows = workbenchNeeds({
    proposals: [{ id: 'proposal', workflowId: 'w', status: 'proposed', request: '改色' }],
    gates: [{ gate: 'w:g', workflowId: 'w', status: 'pending', question: '确认配色' }],
    warnings: [{ workflowId: 'w', stageId: 'regression', checkId: 'warning', text: '覆盖记录需要确认' },
      { workflowId: 'w', stageId: 'regression', checkId: 'warning', text: '重复提醒' }],
    tasks: [{ id: 'task', workflowId: 'w', stage: 'regression', goal: '核对阶段', needsYou: true, status: 'WAITING_HUMAN' }],
    interruptions: [{ id: 'proposal', workflowId: 'w', taskId: 'task', state: 'recovery_required', reason: '等待核对' }],
  });
  assert.deepEqual(rows.map(row => row.source), ['制作提案', '待决定关口', '未接受提醒', '制作中断待核对']);
  assert.equal(rows.length, 4, 'the duplicate warning and task-linked interruption do not create extra rows');
  assert.equal(rows[0]!.target, 'proposal', 'proposal identity is preserved for the conversation jump');
  assert.equal(rows[1]!.target, 'w:g', 'Gate identity is preserved for the conversation jump');
  assert.equal(workbenchConversationTarget(rows[0]!), 'production-proposal-proposal');
  assert.equal(workbenchConversationTarget(rows[1]!), 'gate-w:g');
});

test('workbench L1 lists only current attention checks and keeps future missing evidence as a count', () => {
  const stages = [
    { id: 'done', status: 'passed', reasons: [], checks: [{ id: 'ok', observe: 'avatar.fit', severity: 'blocking', verdict: { result: 'pass', current: true } }] },
    { id: 'current', status: 'blocked', display: 'running', reasons: [], checks: [{ id: 'bad', observe: 'avatar.fit', severity: 'blocking', verdict: { result: 'no_data', current: true } },
      { id: 'waiting', observe: 'avatar.verify', severity: 'warning', acceptanceRequired: true, verdict: { result: 'pass', current: true } }] },
    { id: 'future', status: 'open', reasons: [], checks: [{ id: 'future-check', observe: 'avatar.fit', severity: 'blocking' }] },
  ];
  assert.deepEqual(attentionChecks(stages).map(item => item.check.id), ['bad', 'waiting']);
  const summary = progressStageSummary(stages);
  assert.deepEqual(summary.completed.map(stage => stage.id), ['done']);
  assert.equal(summary.current?.id, 'current');
  assert.equal(summary.next?.id, 'future');
  assert.equal(summary.remaining, 0);
});

test('future stages hide old readings while L1 keeps pending, not-applicable and accepted counts', () => {
  const stages = [
    { id: 'current', status: 'blocked', display: 'running', reasons: [], checks: [
      { id: 'pass', observe: 'avatar.fit', severity: 'blocking', verdict: { result: 'pass', current: true } },
      { id: 'pending', observe: 'avatar.verify', severity: 'blocking' },
    ] },
    { id: 'future', status: 'waiting', display: 'waiting', reasons: [], checks: [
      { id: 'old-fail', observe: 'avatar.fit', severity: 'blocking', verdict: { result: 'violation', current: true } },
      { id: 'old-stale', observe: 'avatar.fit', severity: 'warning', verdict: { result: 'not_applicable', current: false } },
      { id: 'future-pending', observe: 'avatar.verify', severity: 'blocking' },
      { id: 'accepted', observe: 'avatar.fit', severity: 'warning', acceptanceRequired: false,
        verdict: { result: 'pass', current: true, accepted: true } },
    ] },
  ];
  assert.deepEqual(attentionChecks(stages).map(item => item.check.id), ['pending']);
  assert.deepEqual(progressCheckCounts(stages), { pending: 2, notApplicable: 1, accepted: 1, futurePending: 1,
    futureNotApplicable: 1, futureAccepted: 1, currentPass: 1, currentNotApplicable: 0, currentAccepted: 0, currentMissing: 1, currentExpired: 0, currentTotal: 2 });
});

test('three progress lines use scheduler, task and production facts without claiming paused work is running', () => {
  const stages = [{ id: 'outfit', status: 'running', display: 'running', reasons: [], checks: [] }];
  assert.deepEqual(progressSummaryLines({ stages, next: '等待后台服务推进', scheduler: 'paused', productionState: 'working', tasks: [] }),
    ['暂无记录', '后台已暂停，暂无新执行', '后台未启动新工作，已开始的步骤仍会核对结果']);
  assert.deepEqual(progressSummaryLines({ stages, next: '阶段 outfit 进行中（RUNNING）', scheduler: 'running', tasks: [{ stage: 'outfit', status: 'RUNNING' }] }),
    ['暂无记录', '正在装配服装', '「装配服装」执行中']);
  assert.deepEqual(progressSummaryLines({ stages, scheduler: 'running', productionState: 'working', tasks: [] })[1], '正在制作');
  assert.deepEqual(progressSummaryLines({ stages, next: '阶段 outfit 待开始；后台服务会自动推进', productionState: 'working' }),
    ['暂无记录', '未知', '未知']);
});

test('accepted warnings remain evidence but leave the actionable attention list', () => {
  const stages = [{ id: 'regression', status: 'blocked', display: 'deciding', reasons: [], checks: [
    { id: 'accepted', observe: 'avatar.fit', severity: 'warning', acceptanceRequired: true,
      verdict: { result: 'pass', current: true, accepted: true } },
    { id: 'unaccepted', observe: 'avatar.fit', severity: 'warning', acceptanceRequired: true,
      verdict: { result: 'pass', current: true, accepted: false } },
  ] }];
  assert.deepEqual(attentionChecks(stages).map(item => item.check.id), ['unaccepted']);
});

test('an accepted current warning with a non-pass result is still omitted from L1', () => {
  const stages = [{ id: 'regression', status: 'blocked', display: 'running', reasons: [], checks: [
    { id: 'accepted-violation', observe: 'avatar.fit', severity: 'warning', acceptanceRequired: false,
      verdict: { result: 'violation', current: true, accepted: true } },
    { id: 'missing', observe: 'avatar.fit', severity: 'warning', acceptanceRequired: true },
  ] }];
  assert.deepEqual(attentionChecks(stages).map(item => item.check.id), ['missing']);
});

test('completed passing stages count as valid current evidence', () => {
  const stages = [{ id: 'done', status: 'passed', display: 'passed', reasons: [], checks: [
    { id: 'pass', observe: 'avatar.fit', severity: 'blocking', verdict: { result: 'pass', current: true } },
  ] }];
  assert.deepEqual(progressCheckCounts(stages), { pending: 0, notApplicable: 0, accepted: 0, futurePending: 0,
    futureNotApplicable: 0, futureAccepted: 0, currentPass: 1, currentNotApplicable: 0, currentAccepted: 0, currentMissing: 0, currentExpired: 0, currentTotal: 1 });
});

test('valid not-applicable and accepted warning evidence completes L1 without calling either a pass', () => {
  const base = { id: 'done', status: 'passed', display: 'passed', reasons: [] as string[] };
  const notApplicable = progressCheckCounts([{ ...base, checks: [
    { id: 'pass', observe: 'avatar.fit', severity: 'blocking', verdict: { result: 'pass', current: true } },
    { id: 'na', observe: 'avatar.fit', severity: 'warning', verdict: { result: 'not_applicable', current: true } },
  ] }]);
  assert.equal(progressEvidenceText(notApplicable), '当前有效检查正常：通过 1 · 不适用 1 · 已接受提醒 0。');
  assert.equal(notApplicable.currentPass, 1); assert.equal(notApplicable.currentNotApplicable, 1); assert.equal(notApplicable.currentMissing, 0);
  const accepted = progressCheckCounts([{ ...base, checks: [
    { id: 'pass', observe: 'avatar.fit', severity: 'blocking', verdict: { result: 'pass', current: true } },
    { id: 'warning', observe: 'avatar.fit', severity: 'warning', verdict: { result: 'violation', current: true, accepted: true } },
  ] }]);
  assert.equal(progressEvidenceText(accepted), '当前有效检查正常：通过 1 · 不适用 0 · 已接受提醒 1。');
  assert.equal(accepted.currentPass, 1); assert.equal(accepted.currentAccepted, 1); assert.equal(accepted.currentMissing, 0);
});

test('a task blocked only by warning acceptance is merged into its warning row', () => {
  const rows = workbenchNeeds({ proposals: [], gates: [], warnings: [{ workflowId: 'w', stageId: 'regression', checkId: 'warn', text: '提醒' }],
    tasks: [{ id: 'task', workflowId: 'w', stage: 'regression', goal: '检查', needsYou: true, status: 'WAITING_HUMAN', stageCodes: ['warning_unaccepted'] }], interruptions: [] });
  assert.deepEqual(rows.map(row => row.source), ['未接受提醒']);
});

test('an independent human blocker stays beside a warning row', () => {
  const rows = workbenchNeeds({ proposals: [], gates: [], warnings: [{ workflowId: 'w', stageId: 'regression', checkId: 'warn', text: '提醒' }],
    tasks: [{ id: 'task', workflowId: 'w', stage: 'regression', goal: '检查', needsYou: true, status: 'WAITING_HUMAN', stageCodes: ['warning_unaccepted', 'check_failed'] }], interruptions: [] });
  assert.deepEqual(rows.map(row => row.source), ['未接受提醒', '需要人工任务']);
});

test('a failed needsYou task becomes the L0 redo action rather than disappearing with openOnly', () => {
  const rows = workbenchNeeds({ proposals: [], gates: [], warnings: [], interruptions: [], tasks: [
    { id: 'failed-task', workflowId: 'w', stage: 'outfit', goal: '重做服装阶段', needsYou: true, status: 'FAILED' },
  ] });
  assert.deepEqual(rows.map(row => ({ source: row.source, action: row.action, target: row.target })),
    [{ source: '需要人工任务', action: 'task', target: 'failed-task' }]);
});

test('temporary failed tasks return to the conversation while formal failures use redo', () => {
  assert.equal(taskNeedAction({ formal: false, status: 'FAILED' }), 'conversation');
  assert.equal(taskNeedAction({ formal: true, status: 'FAILED' }), 'redo');
});

test('continuation task projection keeps the logical project and active successor workflow', () => {
  const rows = projectTaskRows([
    { id: 'old', project: 'source', workflowId: 'old-workflow' },
    { id: 'successor', project: 'successor', workflowId: 'new-workflow' },
    { id: 'other', project: 'other', workflowId: 'other-workflow' },
  ], 'source', 'new-workflow');
  assert.deepEqual(rows.map(row => row.id), ['old', 'successor']);
});

test('the main page keeps a successor gate in the logical project workspace and change lookup', () => {
  const successorGate = { gate: 'successor:plan', project: 'successor-path', workflowId: 'successor', projectName: 'source', status: 'pending' };
  const rows = projectRowsForWorkflow([successorGate], 'source-path', 'successor');
  assert.equal(rows.length, 1, 'the project workspace must receive the successor decision card');
  assert.equal(projectRowsForWorkflow([successorGate], 'other-path', 'other').length, 0);
});

test('a deferred gate conversation restores its hidden decision card before jumping', () => {
  const gate = { key: 'gate:w:g', source: '待决定关口' as const, title: '决定', detail: '', action: 'conversation' as const, target: 'w:g' };
  const proposal = { ...gate, source: '制作提案' as const };
  assert.equal(conversationNeedsRestore(gate), true);
  assert.equal(conversationNeedsRestore(proposal), false);
});

test('conversation consumers execute restore and temporary-task focus callbacks', () => {
  const calls: string[] = [];
  const gate = { key: 'gate:w:g', source: '待决定关口' as const, title: '决定', detail: '', action: 'conversation' as const, target: 'w:g' };
  focusConversationNeed(gate, () => calls.push('restore'), id => calls.push(`focus:${id}`));
  focusTaskConversation('temporary-task', pane => calls.push(`pane:${pane}`), id => calls.push(`focus:${id}`));
  assert.deepEqual(calls, ['restore', 'focus:gate-w:g', 'pane:main', 'focus:interaction-task-temporary-task']);
});

test('the main-page ownership consumer passes successor gates to the workspace and change request lookup', () => {
  const projects = [
    { id: 'source', path: 'source-path', name: 'Source', workflow: { id: 'successor' } },
    { id: 'other', path: 'other-path', name: 'Other', workflow: { id: 'other-workflow' } },
  ];
  const gate = { gate: 'successor:plan', project: 'successor-path', workflowId: 'successor', projectName: 'Source', status: 'pending' };
  assert.deepEqual(projectWorkspaceGates([gate], projects[0]!), [gate]);
  assert.equal(projectForGate(projects, gate)?.id, 'source');
  assert.equal(projectWorkspaceGates([gate], projects[1]!).length, 0);
});

// 缺测不是不符合：把「没测到」并进「未通过」会让用户读成自己的头像有问题，下一步动作也错了
// （信息包装规范 §2.3 负级别独立成组、§4「缺测不能变零」、§6.2）。
test('a level the check could not reach is counted and named on its own, never as a failure', () => {
  const counts = verdictCounts([check('pass'), check('no_data'), check('error'), check('undecidable'), check('violation'),
    check('not_applicable'), check(), check('pass', false)]);
  assert.deepEqual(counts, { total: 8, pass: 1, fail: 1, noData: 1, error: 1, unsure: 1, na: 1, pending: 1, stale: 1 });
  assert.equal(verdictTally(counts),
    '8 项检查 · 通过 1 · 不符合 1 · 缺数据 1（需补测） · 检查出错 1（需重跑） · 无法判定 1 · 不适用 1 · 待取证 1 · 已过期 1');
  // Nothing measured and nothing known are different statements, and neither may be rendered as zero checks.
  assert.equal(verdictTally({ total: 0, pass: 0, fail: 0, noData: 0, error: 0, unsure: 0, stale: 0, pending: 0, na: 0 }), '尚无检查');
  assert.equal(verdictTally({ total: 2, pass: 0, fail: 0, noData: 2, error: 0, unsure: 0, stale: 0, pending: 0, na: 0 }),
    '2 项检查 · 通过 0 · 缺数据 2（需补测）');
});

// 复核要求单独核对的一处逻辑（信息包装规范 §6.3）：提案状态与执行进度是两套生命周期，共用一张表并按
// `progress.state ?? status` 回落，会把「提案等待批准」读成「制作中断」，也会把执行侧的词读成提案状态。
test('a production proposal and the run it starts are never read through one state slot', () => {
  const proposal = (status: string, state?: string) => ({ id: 'p', revision: 1, request: 'r', status, workflowId: 'w', inputs: [],
    ...(state ? { progress: { state, reason: '演示', token: 't', canResume: false, canCancel: false } } : {}) });
  assert.deepEqual(productionState(proposal('proposed')), ['等待批准', 'warn']);
  assert.deepEqual(productionState(proposal('working')), ['已受理，等后台开始', 'info']);
  // Once a run exists its progress is what is shown, whatever the proposal's status was.
  assert.deepEqual(productionState(proposal('working', 'recovery_required')), ['中断待核对', 'warn']);
  assert.deepEqual(productionState(proposal('proposed', 'interrupted')), ['制作未完成', 'bad']);
  // A value neither list names says so instead of falling through to the other lifecycle's word.
  assert.deepEqual(productionState(proposal('interrupted')), ['提案状态正在确认（interrupted）', 'muted']);
  assert.deepEqual(productionState(proposal('working', 'teleported')), ['制作状态正在确认（teleported）', 'muted']);
  assert.equal(productionLabel(proposal('working', 'interrupted')), '制作未完成');
});

test('an open workflow stage preserves the latest interrupted execution rather than saying it has not started', () => {
  const stage = { id: 'plan', status: 'open', reasons: ['completion_missing'], checks: [check()] };
  assert.deepEqual(stageView({ ...stage, task: { status: 'FAILED', attempts: 1 } }),
    { label: '确认制作方案', state: ['已中断', 'bad'], mark: '!', note: '处理未完成，继续制作前需要核对执行结果' });
  assert.deepEqual(stageView({ ...stage, task: { status: 'RECOVERY_REQUIRED', attempts: 1 } }),
    { label: '确认制作方案', state: ['中断待核对', 'warn'], mark: '!', note: '上次执行结果尚未确认，核对前不会重做' });
  assert.deepEqual(stageView({ ...stage, task: { status: 'RUNNING', attempts: 1 }, display: 'running' }).state,
    ['进行中', 'info']);
});

test('archive recovery keeps the blocker and executable project action while technical reasons are for diagnostics', () => {
  for (const raw of ['阶段 plan 需要核对上次执行（avh task recover）', '阶段 plan 执行失败：stage completion missing；处理后重做']) {
    const view = archiveNextView({ kind: 'workflow', text: raw });
    assert.equal(view.action, 'production');
    assert.match(view.text, /未完成|中断/);
    assert.match(view.text, /已有成果保留/);
    assert.doesNotMatch(view.text, /plan|avh task|stage completion/);
  }
  assert.deepEqual(archiveNextView({ kind: 'archive', text: '工程档案写入失败：SQLITE_BUSY；处理后刷新档案' }),
    { text: '工程档案写入未完成，当前档案尚未通过校验。可以重新扫描并刷新档案。', action: 'archive' });
  assert.equal(archiveNextView({ kind: 'recovery', text: 'AI 接手分析没有得到完整的结构化结果：result.json missing' }).text,
    'AI 接手分析未完成，暂不能按分析结果继续。请在「工程导入与 AI 恢复」中重新分析。');
  assert.equal(archiveNextView({ kind: 'classify', text: '1 个文件待归类' }).action, 'share');
});

test('face progress distinguishes candidate processing, independent engineering checks and visual acceptance', () => {
  const stage = { id: 'face', status: 'open', reasons: [], checks: [] };
  assert.deepEqual(stageView({ ...stage, display: 'running', task: { status: 'RUNNING', attempts: 1 } }).state, ['处理中', 'info']);
  assert.deepEqual(stageView({ ...stage, display: 'running', task: { status: 'VERIFYING', attempts: 1 } }),
    { label: '调整脸型', state: ['工程检查中', 'info'], mark: '▶', note: '正在独立检查脸型候选，尚未确认视觉效果' });
  const passed = stageView({ ...stage, status: 'passed', task: { status: 'PASSED', attempts: 1 }, checks: [check('pass'), check('pass')] });
  assert.deepEqual(passed.state, ['工程检查通过', 'ok']);
  assert.equal(passed.note, '2 项检查通过；脸型候选尚未进行视觉效果确认');
  assert.doesNotMatch(passed.note, /已完成|效果已确认/);
  assert.equal(stageView({ ...stage, task: { status: 'FAILED', attempts: 1 } }).state[0], '已中断');
  assert.equal(stageView({ ...stage, task: { status: 'RECOVERY_REQUIRED', attempts: 1 } }).state[0], '中断待核对');
  assert.equal(stageView({ ...stage, status: 'not_applicable' }).note, '当前方案不需要修改脸型，跳过这一步');
});

test('default progress waits for actual face work and internal intent stays in archive diagnostics', () => {
  const waiting = { id: 'face_design', status: 'waiting', reasons: [], checks: [] };
  assert.equal(facePreviewMode([waiting, { ...waiting, id: 'face' }]), null);
  assert.equal(facePreviewMode([{ ...waiting, task: { status: 'DRAFT', attempts: 0 } }]), null);
  assert.equal(facePreviewMode([{ ...waiting, display: 'not_applicable', task: { status: 'PASSED', attempts: 1 } }]), null);
  assert.equal(facePreviewMode([{ ...waiting, task: { status: 'RUNNING', attempts: 1 } }]), 'candidates');
  assert.equal(facePreviewMode([{ ...waiting, task: { status: 'FAILED', attempts: 1 } }]), 'candidates', 'started failure remains explainable');
  assert.equal(facePreviewMode([{ ...waiting, status: 'passed' }, { ...waiting, id: 'face', task: { status: 'VERIFYING', attempts: 1 } }]), 'output');
  assert.equal(archiveFactIsDiagnostic({ presentation: 'diagnostic' }), true);
  assert.equal(archiveFactIsDiagnostic({ objectId: 'intent:avatar' }), true);
  assert.equal(archiveFactIsDiagnostic({ objectId: 'question:outfit' }), false, 'real user questions stay visible');
});

test('projects in progress are those with a workflow that was not cancelled', () => {
  const projects = [{ name: 'a' }, { name: 'b', workflow: { status: 'active' } }, { name: 'c', workflow: { status: 'cancelled' } },
    { name: 'd', workflow: { status: 'upload_ready' } }];
  assert.deepEqual(inProgress(projects).map(project => project.name), ['b', 'd']);
});

test('a placeholder cover tells projects with a shared prefix apart, keeps its colour, and leaves its tint to the theme', () => {
  assert.equal(placeholder('Luna-春樱').text, '春樱');
  assert.equal(placeholder('Luna-夏日泳装').text, '夏日');
  assert.equal(placeholder('mira').text, 'Mi');
  assert.equal(placeholder('Luna-春樱').hue, placeholder('Luna-春樱').hue);
  const hues = new Set(['Luna-春樱', 'Luna-夏日泳装', 'Aoi', 'Mira-冬季', 'Nemu', 'Kei-日常'].map(name => placeholder(name).hue));
  assert.ok(hues.size >= 3, 'covers should not all share one colour');
  assert.ok([...hues].every(hue => (PLACEHOLDER_HUES as readonly number[]).includes(hue)));
  // Only the hue is set on the element: style.css takes saturation and lightness from the theme (contrast: style.test.ts).
  assert.deepEqual(placeholderColors(214), { '--hue': '214' });
});

test('recent projects: newest activity of their workflow or of the project itself first, the rest in the Runtime order', () => {
  const projects = [{ id: 'a', name: 'Aoi' }, { id: 'b', name: 'Luna-春樱', workflow: { id: 'w1' } }, { id: 'c', name: 'Mira' },
    { id: 'd', name: 'Nemu', workflow: { id: 'w3' } }];
  const events = [{ seq: 5, workflowId: 'w1' }, { seq: 9, workflowId: null, entityType: 'project', entityId: 'c' },
    { seq: 7, workflowId: 'w2' }, { seq: 3, workflowId: null, entityType: 'asset', entityId: 'a' }];
  // w2 is an older Workflow of Aoi, known only through its Tasks.
  assert.deepEqual(recentProjects(projects, events, [{ workflowId: 'w2', projectName: 'Aoi' }]).map(project => project.id), ['c', 'a', 'b', 'd']);
  assert.deepEqual(recentProjects(projects, []).map(project => project.id), ['a', 'b', 'c', 'd'], 'no events, no invented order');
});

test('locations are picked, not typed: import filters match what the importer unpacks, and detected paths come first', () => {
  const materialize = readFileSync(new URL('../../src/import/materialize.ts', import.meta.url), 'utf8');
  for (const extension of IMPORT_FILTERS.flatMap(filter => filter.extensions))
    assert.match(materialize, new RegExp(`['.]\\.?${extension}\\b`), `project.import accepts .${extension}`);
  assert.deepEqual(unityEditorFilters(true), [{ name: 'Unity 编辑器', extensions: ['exe'] }]);
  assert.deepEqual(unityEditorFilters(false), [], 'the Linux editor has no extension to filter by');
  assert.equal(VRCHAT_UNITY, VRCHAT_UNITY_VERSION);
  const editors = ['C:\\Program Files\\Unity\\Hub\\Editor\\2022.3.22f1\\Editor\\Unity.exe', 'D:\\Unity\\2022.3.6f1\\Editor\\Unity.exe'];
  const choices = pathChoices(editors, 'c:/program files/unity/hub/editor/2022.3.22f1/editor/Unity.exe', unityEditorNote);
  assert.deepEqual(choices.map(choice => [choice.note, choice.detected]), [['Unity 2022.3.22f1 · 在这台电脑上找到 · VRChat 头像使用的版本', true],
    ['Unity 2022.3.6f1 · 在这台电脑上找到', true]], 'the configured editor is a detected one, however it is spelled');
  const other = pathChoices(editors, 'E:\\Tools\\Unity.exe', unityEditorNote);
  assert.deepEqual(other.at(-1), { value: 'E:\\Tools\\Unity.exe', note: '你选择的位置', detected: false }, 'a picked editor stays listed');
  assert.equal(unityEditorNote('/srv/example-home/Unity/Hub/Editor/2022.3.22f1/Editor/Unity'), 'Unity 2022.3.22f1 · 在这台电脑上找到 · VRChat 头像使用的版本');
  assert.ok(samePath('/srv/example-home/x/', '/srv/example-home/x') && !samePath('/srv/example-home/X', '/srv/example-home/x'), 'Linux paths keep their case');
  assert.deepEqual([importSourceLabel('/p', 'directory'), importSourceLabel('/p/a.UNITYPACKAGE', 'file'), importSourceLabel('/p/a.7z', 'file')],
    ['文件夹', 'Unity 包', '压缩包']);
});

test('pi models and GLM billing are chosen from known lists; a value only the configuration file names is kept', () => {
  assert.deepEqual(piModelOptions('deepseek', '').map(option => option.value), ['', ...PI_MODELS.deepseek.filter(model => model !== 'deepseek-flash')]);
  assert.equal(piModelOptions('deepseek', '')[0]!.label, 'deepseek-flash（默认）');
  assert.deepEqual(piModelOptions('zai', 'glm-5.2').map(option => option.value).includes('glm-5.2'), true);
  assert.deepEqual(piModelOptions('zhipu', 'glm-9-secret').at(-1), { value: 'glm-9-secret', label: 'glm-9-secret（配置文件里的写法）' });
  assert.deepEqual(piAddressOptions('zhipu', '').map(option => option.value), ['', 'https://open.bigmodel.cn/api/paas/v4']);
  assert.deepEqual(piAddressOptions('zai', 'https://proxy.example/v4').at(-1)?.value, 'https://proxy.example/v4');
  // Switching the region moves the pay-as-you-go address with it and drops a model the new region's catalog lacks.
  const international = { ...NO_PI, glm: true, region: 'zai' as const, glmModel: 'glm-5.2', glmBaseUrl: 'https://api.z.ai/api/paas/v4' };
  assert.deepEqual(piRegionChange(international, 'zhipu'), { ...international, region: 'zhipu', glmModel: '', glmBaseUrl: 'https://open.bigmodel.cn/api/paas/v4' });
  const proxied = { ...international, glmModel: 'glm-5.3-flash', glmBaseUrl: 'https://proxy.example/v4' };
  assert.deepEqual(piRegionChange(proxied, 'zhipu'), { ...proxied, region: 'zhipu' }, 'a hand-written address and a shared model stay');
  assert.deepEqual(piChoicesFrom(piRegionChange(international, 'zhipu')), [{ upstream: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }]);
});

const card = (name: string, extra: Record<string, unknown> = {}) =>
  ({ name, path: `/w/${name}`, tasks: { total: 0, open: 0, needsYou: 0 }, ...extra }) as Parameters<typeof projectState>[0];
test('a card derives its state once: not started, waiting for you (decisions and tasks), or the workflow state', () => {
  const fresh = card('Luna-夏日泳装');
  assert.deepEqual(projectState(fresh, []), ['尚未开始', 'muted']);
  assert.equal(cardNext(fresh, true), '下一步：确认需求与素材，然后开始制作流程');
  assert.equal(cardProgress(fresh), null, 'a project that has not started shows no progress bar');
  // Five of thirteen stages passed; the four Tasks created so far (three done) must not read as 75 %, let alone 100 %.
  const active = card('Luna-春樱', { workflow: { status: 'active', next: '等待后台服务推进', stagesPassed: 5, stagesTotal: 13 },
    tasks: { total: 4, open: 1, needsYou: 1 } });
  const gates = [{ status: 'pending', project: '/w/Luna-春樱' }, { status: 'approved', project: '/w/Luna-春樱' }, { status: 'pending', project: '/w/x' }];
  assert.deepEqual(projectState(active, gates), ['2 项等你', 'warn']);
  assert.deepEqual(projectState(active, []), ['1 项等你', 'warn']);
  assert.equal(cardProgress(active), 5 / 13);
  assert.equal(cardNext(active, false), '后台未启动新工作，已开始的步骤仍会核对结果');
  assert.equal(cardProgress(card('a', { workflow: { status: 'active', next: '' }, tasks: { total: 0, open: 0, needsYou: 0 } })), null);
  assert.equal(cardMeta(card('b', { lastImport: { unityVersion: '2022.3.22f1', base: 'Luna' } })), 'Unity 2022.3.22f1 · Luna');
});

test('project filters and search: in progress, waiting for you, not started, ended', () => {
  const projects = [card('Luna-夏日泳装'), card('Luna-春樱', { workflow: { status: 'active', next: '' } }),
    card('Aoi', { workflow: { status: 'active', next: '' }, tasks: { total: 2, open: 1, needsYou: 1 } }),
    card('Old', { workflow: { status: 'cancelled', next: '' }, tasks: { total: 2, open: 0, needsYou: 1 } })];
  const names = (filter: Parameters<typeof filterProjects>[2], query = '') => filterProjects(projects, [], filter, query).map(p => p.name);
  assert.deepEqual(names('all'), ['Luna-夏日泳装', 'Luna-春樱', 'Aoi', 'Old']);
  assert.deepEqual(names('active'), ['Luna-春樱', 'Aoi']);
  assert.deepEqual(names('waiting'), ['Aoi'], 'an ended project has nothing waiting for you');
  assert.deepEqual(names('new'), ['Luna-夏日泳装']);
  assert.deepEqual(names('ended'), ['Old']);
  assert.deepEqual(names('all', 'luna'), ['Luna-夏日泳装', 'Luna-春樱']);
});

test('starting production needs the request; materials and outfits are shown but do not block', () => {
  const empty = startReadiness({ request: ' ', assets: 0, variants: 0 });
  assert.equal(empty.blocker, '先完成：头像需求已填写');
  assert.deepEqual(empty.items.map(item => item.done), [false, false, false]);
  const ready = startReadiness({ request: '樱花主题', assets: 3, variants: 0 });
  assert.equal(ready.blocker, undefined);
  assert.equal(ready.items[1]!.hint, '3 项已关联');
});

test('the start dialog names what is missing on this computer, Unity and AI included', () => {
  const dep = (id: string, name: string, required: boolean, ok: boolean) => ({ id, name, required, ok });
  assert.deepEqual(startWarnings([dep('git', 'git', true, true), dep('bwrap', 'bubblewrap', true, false), dep('unity', 'Unity 编辑器', true, false),
    dep('vpm', 'VPM CLI', false, false), dep('codex', 'Codex CLI', false, false), dep('claude', 'Claude Code', false, false)]),
  ['缺少必需依赖：bubblewrap', 'Unity 编辑器尚未配置：含 Unity 步骤的阶段会停下等你配置', '没有可用的 AI 执行方：请安装 Codex CLI、Claude Code 或 pi（DeepSeek、GLM）']);
  assert.deepEqual(startWarnings([dep('git', 'git', true, true), dep('codex', 'Codex CLI', false, true), dep('claude', 'Claude Code', false, false)]), []);
  assert.deepEqual(startWarnings([dep('codex', 'Codex CLI', false, false), dep('claude', 'Claude Code', false, false), dep('pi', 'pi', false, true)]), [],
    'pi alone is an AI executor');
});

test('a disabled fetch button says why; BOOTH reads as one line of facts', () => {
  assert.equal(materializeBlocker({ project: '', files: 0, busy: false }), '先勾选要获取的文件');
  assert.equal(materializeBlocker({ project: '', files: 2, busy: false }), '先选择使用这些文件的项目');
  assert.equal(materializeBlocker({ project: 'p', files: 2, busy: true }), '正在处理上一项操作');
  assert.equal(materializeBlocker({ project: 'p', files: 2, busy: false }), '');
  assert.equal(boothLine({ connected: true, owned: 4, files: 4, materialized: 0 }), '已连接 · 4 件已购 · 4 个远端文件 · 0 个已获取');
  assert.equal(boothLine({ connected: false, owned: 0, files: 0, materialized: 0 }), '未连接 BOOTH');
});

test('dependencies draw attention only when missing or degraded', () => {
  assert.deepEqual(dependencyState({ ok: true, required: true, detail: 'git version 2.53.0' }), ['正常', 'muted']);
  assert.deepEqual(dependencyState({ ok: true, required: true, detail: 'degraded' }), ['注意', 'warn']);
  assert.deepEqual(dependencyState({ ok: false, required: true, detail: '未找到' }), ['缺少', 'bad']);
  assert.deepEqual(dependencyState({ ok: false, required: false, detail: '未安装' }), ['可选', 'muted']);
  assert.deepEqual(missingRequired([{ name: 'bubblewrap', ok: false, required: true, detail: '' }, { name: 'VPM CLI', ok: false, required: false, detail: '' },
    { name: 'git', ok: true, required: true, detail: '' }]), ['bubblewrap']);
});

test('the readiness step reports management, production and preview apart, each with its own reason', () => {
  assert.deepEqual(readinessRows({ ai: false, unity: false }), [
    { label: '管理', available: true, line: '管理：可用' },
    { label: '制作', available: false, line: '制作：不可用（未配置密钥）' },
    { label: '预览', available: false, line: '预览：不可用（缺少 Unity 编辑器）' },
  ]);
  // The three are independent: management needs neither AI nor Unity; a key alone leaves previews unavailable.
  assert.deepEqual(readinessRows({ ai: true, unity: false }).map(row => [row.available, row.line]),
    [[true, '管理：可用'], [true, '制作：可用'], [false, '预览：不可用（缺少 Unity 编辑器）']]);
  assert.deepEqual(readinessRows({ blockers: ['7-Zip'], ai: true, unity: true })[0], { label: '管理', available: false, line: '管理：不可用（缺少7-Zip）' });
});

test('the first setup is never blocked by Unity, only by what Harness itself needs', () => {
  const items = [{ id: 'unity', name: 'Unity 编辑器', ok: false, required: true, detail: '未配置' },
    { id: 'git', name: 'git', ok: false, required: true, detail: '未找到' }, { id: 'vpm', name: 'VPM CLI', ok: false, required: false, detail: '未安装' }];
  assert.deepEqual(firstRunBlockers(items), ['git']);
  assert.deepEqual(firstRunBlockers(items.slice(0, 1)), [], 'a missing or unconfigured Unity alone leaves the wizard open');
});

test('the pi choices in the form follow the configuration and come back as the choices the Runtime takes', () => {
  assert.deepEqual(PI_SECRETS, { deepseek: 'pi-deepseek', zai: 'pi-zai', zhipu: 'pi-zhipu' });
  assert.deepEqual(piStateFrom([{ type: 'codex-cli' }]), NO_PI, 'nothing configured, GLM defaults to 国内');
  const providers = [{ type: 'pi-cli', upstream: 'deepseek', model: '', baseUrl: '', secret: 'pi-deepseek' },
    { type: 'pi-cli', upstream: 'zai', model: 'glm-4.7', baseUrl: 'https://api.z.ai/api/paas/v4', secret: 'my-zai' }];
  const state = piStateFrom(providers);
  assert.deepEqual(state, { deepseek: true, glm: true, region: 'zai', deepseekModel: '', glmModel: 'glm-4.7', glmBaseUrl: 'https://api.z.ai/api/paas/v4' });
  assert.deepEqual(piChoicesFrom(state), [{ upstream: 'deepseek' }, { upstream: 'zai', model: 'glm-4.7', baseUrl: 'https://api.z.ai/api/paas/v4' }]);
  assert.deepEqual(piChoicesFrom({ ...state, deepseek: false, region: 'zhipu', glmModel: '  ', glmBaseUrl: '' }), [{ upstream: 'zhipu' }],
    'blank fields mean the defaults');
  assert.equal(piSecretFor('zai', providers), 'my-zai', 'a key name the configuration chose is the one its field stands for');
  assert.equal(piSecretFor('zhipu', providers), 'pi-zhipu');
});

test('activity groups events by project, newest first, with events outside a workflow under 其他', () => {
  const events = [{ seq: 1, workflowId: null }, { seq: 2, workflowId: 'w1' }, { seq: 3, workflowId: 'w2' }, { seq: 4, workflowId: 'w1' },
    { seq: 5, workflowId: 'gone' }];
  const groups = groupEvents(events, [{ workflowId: 'w2', projectName: 'Luna-夏日泳装' }], [{ name: 'Luna-春樱', workflow: { id: 'w1' } }]);
  assert.deepEqual(groups.map(([name, rows]) => [name, rows.map(row => row.seq)]),
    [['其他', [5, 1]], ['Luna-春樱', [4, 2]], ['Luna-夏日泳装', [3]]]);
});

const row = (id: string, name: string, required: boolean, ok: boolean, detail = ok ? 'ok' : '未找到') => ({ id, name, required, ok, detail });
test('dependencies are read in clusters: one line each, open only when something in them needs attention', () => {
  const items = [row('node', 'Node', true, true), row('avh-win', 'Harness Windows 辅助程序', true, true), row('git', 'git', true, true),
    row('python', 'Python 3', true, false), row('7z', '7-Zip', true, false), row('unity', 'Unity 编辑器', true, true), row('vpm', 'VPM CLI', false, false),
    row('codex', 'Codex CLI', false, true), row('claude', 'Claude Code', false, false), row('pi', 'pi', false, false), row('mystery', '别的', false, true)];
  const groups = Object.fromEntries(dependencyGroups(items, ['python', 'claude']).map(group => [group.id, group]));
  assert.deepEqual(Object.keys(groups), ['harness', 'tools', 'unity', 'ai', 'other']);
  assert.equal(groups.harness!.summary, '全部就绪'); assert.equal(groups.harness!.attention, false);
  assert.equal(groups.tools!.summary, '将自动安装 Python 3；缺少 7-Zip'); assert.equal(groups.tools!.attention, true);
  // An optional tool that is missing and not about to be installed is named, but does not open its cluster.
  assert.equal(groups.unity!.summary, 'VPM CLI 未就绪'); assert.equal(groups.unity!.attention, false);
  assert.equal(groups.ai!.summary, '将自动安装 Claude Code；pi 未就绪'); assert.equal(groups.ai!.attention, true);
  assert.deepEqual(groups.other!.items.map(item => item.id), ['mystery']);
  assert.equal(dependencyGroups([row('git', 'git', true, true, 'degraded')])[0]!.attention, true, 'a degraded tool needs attention');
});

test('the page chooses Windows setup items exactly as the Runtime runs them, with the same defaults', () => {
  assert.deepEqual(DEFAULT_SETUP_CHOICES, DEFAULT_CHOICES);
  const ids = ['node', 'git', 'avh-win', 'python', 'blender', '7z', 'pwsh', 'unity-hub', 'unity', 'unity-license', 'dotnet', 'vpm', 'npm', 'codex', 'claude', 'pi'];
  const deps = ids.map(id => ({ id, name: id, purpose: '', required: false, ok: ['node', 'avh-win'].includes(id), detail: '' }));
  const probe: WindowsProbe = { build: 26200, winget: 'C:\\w\\winget.exe', powershellPolicy: {}, codePages: {}, longPaths: false,
    unityRoots: ['C:\\Program Files\\Unity\\Hub\\Editor'], unityAndroid: false, unityLicense: true, hubRunning: false, pythonUtf8: false,
    workspace: 'C:\\w', unityCache: 'C:\\c', logins: {} };
  const plan = windowsSetupPlan(deps, probe);
  const flags = Object.keys(DEFAULT_CHOICES) as Array<keyof typeof DEFAULT_CHOICES>;
  // Every choice off, every choice on, and each one flipped from the defaults.
  const variants = [Object.fromEntries(flags.map(flag => [flag, false])), Object.fromEntries(flags.map(flag => [flag, true])),
    ...flags.map(flag => ({ ...DEFAULT_CHOICES, [flag]: !DEFAULT_CHOICES[flag] }))];
  for (const choices of variants) assert.deepEqual(chosenItems(plan.items, choices).map(item => item.id),
    includedItems(plan.items, choices as typeof DEFAULT_CHOICES).map(item => item.id), JSON.stringify(choices));
  assert.deepEqual(setupButton(chosenItems(plan.items, DEFAULT_CHOICES)), { label: '开始配置（会请求一次管理员授权）', disabled: false });
  assert.deepEqual(setupButton([{ phase: 'user' }]), { label: '开始安装（不需要管理员授权）', disabled: false });
  assert.deepEqual(setupButton([]), { label: '没有需要做的事', disabled: true });
  assert.equal(sizeText(2812), '约 2.8 GB'); assert.equal(sizeText(65), '约 65 MB'); assert.equal(sizeText(0.4), '约 1 MB');
});

test('the environment page explains the optional face tool and its installation choice without blocking other work', () => {
  const missing = row('blender', 'Blender', false, false);
  const optional = dependencyGroups([missing])[0]!;
  assert.equal(optional.id, 'face'); assert.equal(optional.title, '脸型设计（可选）');
  assert.equal(optional.attention, false); assert.match(optional.summary, /Blender 未就绪/);
  assert.equal(missingRequired([missing]).length, 0);
  const planned = dependencyGroups([missing], ['blender'])[0]!;
  assert.equal(planned.attention, true); assert.equal(planned.summary, '将自动安装 Blender');
  assert.deepEqual(setupButton([{ phase: 'machine' }]), { label: '开始配置（会请求一次管理员授权）', disabled: false });
});

test('each share blocker is handled where it is shown, and only a path a person reviewed can be let through', () => {
  // Every blocker the share compiler raises, read from its source so that a new one cannot slip past this test.
  const source = readFileSync(new URL('../../src/archive/share.ts', import.meta.url), 'utf8');
  const raised = [...source.matchAll(/code: '([a-z0-9_]+)'/g)].map(match => match[1]!);
  const passed = /const HARNESS_BLOCKERS = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1]?.match(/[a-z_]+/g) ?? [];
  const codes = new Set([...raised, ...passed]);
  for (const code of ['secrets', 'needs_review', 'unclassified', 'rights', 'symlinks', 'active_run']) assert.ok(codes.has(code), code);
  // A credential, a link or a running task is fixed in the project, never waved through in the window.
  for (const code of codes) assert.equal(blockerAction(code) === 'acknowledge', code === 'needs_review', code);
  assert.deepEqual(['unclassified', 'rights', 'secrets'].map(blockerAction), ['classify', 'rights', 'recheck']);
  // A registration made for a group keeps the Unity project body a receiver needs to go on; a folder is registered as a tree.
  assert.deepEqual(['Assets/Paid/', 'Assets/Paid.meta', 'Packages/', 'ProjectSettings/', 'Tools/', '_施工记录.md'].map(groupLayer), ['A', 'A', 'A', 'A', 'B', 'B']);
  assert.deepEqual(groupRegistration('Assets/Paid/'), { path: 'Assets/Paid/', match: 'tree' });
  assert.deepEqual(groupRegistration('Assets/Paid.meta'), { path: 'Assets/Paid.meta', match: 'file' });
});

test('a share or restore job reads as its step and progress; every level and decision the Runtime reports has words', () => {
  assert.equal(jobText(null), '正在准备…');
  assert.equal(jobText({ phase: 'digest', done: 3, total: 12 }), '校验内容并检查敏感信息（3 / 12）');
  assert.equal(jobText({ phase: 'pack' }), '用 7z 打包…');
  assert.equal(jobShare({ done: 3, total: 12 }), 0.25);
  assert.equal(jobShare(null), null);
  // Every phase the Runtime reports while a job runs has words.
  const phases = new Set(['share.ts', 'restore.ts'].flatMap(name => [...readFileSync(new URL(`../../src/archive/${name}`, import.meta.url), 'utf8')
    .matchAll(/emit\(env, '([a-z-]+)'/g)].map(match => match[1]!)));
  assert.ok(phases.size >= 10, [...phases].join());
  for (const phase of phases) assert.doesNotMatch(jobText({ phase }), /^[a-z-]+…$/, phase);
  const missing: string[] = [];
  onMissingLabel((vocabulary, key) => missing.push(`${vocabulary}:${key}`));
  try {
    for (const level of ['continuable', 'needs_dependencies', 'observe_only']) shareLevel(level);
    for (const kind of ['new', 'update', 'same', 'conflict']) restoreDecision(kind);
  } finally { onMissingLabel(undefined); }
  assert.deepEqual(missing, []);
  assert.deepEqual(['continuable', 'needs_dependencies', 'observe_only'].map(level => shareLevel(level)[1]), ['ok', 'warn', 'bad']);
  assert.equal(bytesText(3 * 1024 ** 3), '3.0 GB'); assert.equal(bytesText(5 * 1024 ** 2), '5.0 MB'); assert.equal(bytesText(10), '1 KB');
});
