import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { diagnosticsTestSwitchesHonoured, exportDiagnostics, previewDiagnostics, DIAGNOSTICS_BUDGET_BYTES } from '../src/diagnostics/diagnose.ts';
import { credentialHits, redactText, sensitiveHits } from '../src/diagnostics/redact.ts';
import { readZip } from '../src/diagnostics/zip.ts';
import { taskRedo } from '../src/task-cli.ts';
import { DIAGNOSTICS_CAPABILITIES, FIXTURE_PRIVATE, diagnosticsFixture, type DiagnosticsFixture } from './fixtures/diagnostics.ts';

/**
 * The diagnostics bundle on its real path: the same `exportDiagnostics` the CLI and the Runtime API call, over real
 * Run directories and a real state database. The three situations the fixture builds are the three D-133 asks for --
 * a Provider connection lost during setup, a vendor material the package never shipped, and a recolor source the plan
 * excludes -- and each has to come out with its stage, its check, its Run and the category the fields support.
 *
 * The cases R28 (the review that rejected the first delivery) names are here one by one: a Provider reply that must not
 * travel, a private value that must not survive in metadata, a confirmed preview the export is bound to, a completion
 * the Runtime has already invalidated, an unquoted authorization header and a private-key block, a verdict that must
 * bind to its own Run, a huge log window, and the receipts and observation notes a reader needs. The second round adds
 * its own five: the person's redo note, an unterminated private key, an old Run's stage mode, a document field over the
 * ceiling, and the per-Run observation-file limit -- each with the anti-fix switch that reproduces what it replaced.
 */

const cli = fileURLToPath(new URL('../bin/avh.js', import.meta.url));
const members = (path: string): Map<string, Buffer> =>
  new Map(readZip(readFileSync(path)).map(member => [member.path, member.bytes]));
const issueFor = (plan: ReturnType<typeof previewDiagnostics>, needle: string) =>
  plan.issues.find(issue => issue.checkId === needle || issue.runId === needle || issue.text.includes(needle));

/** A second Workflow on the same project, so the cases that are about which Run a reading belongs to have a decoy. */
function addWorkflow(f: DiagnosticsFixture, id: string,
  overrides: { definition?: object; capabilities?: object } = {}): { workflowId: string; taskId: string } {
  const workflowId = id, taskId = `${id}-task`;
  const source = f.db.prepare('SELECT profile, definition_json, capabilities_json, thresholds_json, tools_json, tool_root FROM workflow_definition WHERE workflow_id = ?')
    .get(f.workflowId) as { profile: string; definition_json: string; capabilities_json: string; thresholds_json: string; tools_json: string; tool_root: string };
  f.db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
    VALUES (?, ?, 'synthetic-diagnostics', 'hash-1', 'k-1', 'active', '{}')`).run(workflowId, f.projectId);
  f.db.prepare(`INSERT INTO workflow_definition (workflow_id, profile, definition_json, capabilities_json, thresholds_json, tools_json, tool_root)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(workflowId, source.profile,
    JSON.stringify(overrides.definition ?? JSON.parse(source.definition_json)),
    JSON.stringify(overrides.capabilities ?? JSON.parse(source.capabilities_json)),
    source.thresholds_json, source.tools_json, source.tool_root);
  f.db.prepare('INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, workflowId, 'make', '阶段 make', 'provider', 'PASSED');
  return { workflowId, taskId };
}
function addRun(f: DiagnosticsFixture, runId: string, taskId: string, result: Record<string, unknown>): void {
  f.db.prepare('INSERT INTO run (id, task_id, attempt, status, provider, result_json) VALUES (?, ?, 1, ?, ?, ?)')
    .run(runId, taskId, 'exited', 'fake-codex', JSON.stringify(result));
  mkdirSync(join(f.home, 'runs', runId), { recursive: true });
}

/**
 * A Workflow whose `setup` completion is already invalidated: its plan artifact exists and both its verdict and its
 * approval are bound to it, but the recorded completion still names the older plan. This is the state R28 P1-4 built.
 */
function addInvalidatedWorkflow(f: DiagnosticsFixture, id = 'w-invalidated'): string {
  const definition = JSON.parse(JSON.stringify({
    schema: 'process/0.1', id: 'synthetic-diagnostics', version: 'v1', applies_to: {}, artifacts: ['plan', 'scene', 'texture'],
    stages: [{ id: 'setup', needs: [], produces: ['plan'], requires: ['setup_complete'], gates: ['setup_approval'], invalidated_by: ['plan'] },
      { id: 'make', needs: ['setup'], produces: ['scene'], requires: ['vendor_material_complete'], gates: [], invalidated_by: ['plan'] },
      { id: 'recolor', needs: ['make'], produces: ['texture'], requires: ['recolor_source_allowed'], gates: [], invalidated_by: ['scene'] }],
    checks: [
      { id: 'setup_complete', observe: 'setup.inspect', on: 'plan', scope: 'edit', rule: 'complete == true', severity: 'blocking', maturity: 'accepted', label: '准备步骤完成' },
      { id: 'vendor_material_complete', observe: 'material.inspect', on: 'scene', scope: 'edit', rule: 'missing == 0', severity: 'blocking', maturity: 'accepted', label: '厂商材质齐备' },
      { id: 'recolor_source_allowed', observe: 'recolor.inspect', on: 'texture', scope: 'edit', rule: 'excluded_sources_used == 0', severity: 'blocking', maturity: 'accepted', label: '换色来源在计划内' },
    ],
    gates: [{ id: 'setup_approval', kind: 'approve', binds: 'plan' }], milestones: [],
  })) as object;
  const { workflowId } = addWorkflow(f, id, { definition });
  f.db.prepare('INSERT INTO artifact_version (workflow_id, kind, hash) VALUES (?, ?, ?)').run(workflowId, 'plan', 'e'.repeat(64));
  f.db.prepare("INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES (?, ?, 'setup', '准备', 'setup', 'PASSED')")
    .run(`${workflowId}-setup-task`, workflowId);
  f.db.prepare("INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json) VALUES (?, 'setup', '{}')").run(workflowId);
  f.db.prepare("INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result) VALUES (?, 'setup_approval', ?, 'approved')")
    .run(workflowId, 'e'.repeat(64));
  f.db.prepare(`INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result, basis, recorded_at)
    VALUES (?, ?, 'setup_complete', 'edit', ?, 'pass', 'setup.inspect: complete == true', '2026-10-04T00:00:00.000Z')`)
    .run(`${workflowId}:setup_complete`, workflowId, 'e'.repeat(64));
  return workflowId;
}

test('the preview classifies the three situations from the fields, with no side effect', t => {
  const f = diagnosticsFixture(t);
  const before = statSync(f.home).mtimeMs;
  const plan = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
  assert.equal(statSync(f.home).mtimeMs, before, '预览不写任何东西');
  assert.equal(plan.schema, 'harness-diagnostics/0.1');

  // ① A Provider connection lost during setup: environment, not a product defect.
  const network = issueFor(plan, f.runs.setupFailed)!;
  assert.ok(network, '网络中断的 Run 要进问题清单');
  assert.equal(network.kind, 'failure');
  assert.equal(network.category, 'environment');
  assert.equal(network.stageId, 'setup');
  assert.equal(network.runId, f.runs.setupFailed);
  assert.equal(network.reading.errorClass, 'network');
  assert.ok(network.attachments.some(path => path.endsWith('stderr.log')), JSON.stringify(network.attachments));

  // ② The vendor's own omission: a material problem, with the import review that recorded it.
  const vendor = issueFor(plan, 'vendor_material_complete')!;
  assert.ok(vendor, '厂商缺件要进问题清单');
  assert.equal(vendor.category, 'material');
  assert.equal(vendor.checkId, 'vendor_material_complete');
  assert.equal(vendor.checkLabel, '厂商材质齐备', '判据中文名来自流程定义');
  assert.equal(vendor.stageId, 'make');
  assert.equal(vendor.reading.result, 'no_data');
  const importReview = plan.issues.find(issue => issue.reading.review === 'delivery_archive')!;
  assert.ok(importReview, '导入复核的缺件结论要进问题清单');
  assert.equal(importReview.category, 'material');

  // ③ A recolor source the plan excludes: a decision about what may be produced, not a defect in the tool.
  const recolor = issueFor(plan, 'recolor_source_allowed')!;
  assert.ok(recolor, '换色来源阻断要进问题清单');
  assert.equal(recolor.category, 'requirement_decision');
  assert.equal(recolor.checkId, 'recolor_source_allowed');
  assert.equal(recolor.stageId, 'recolor');
  assert.equal(recolor.reading.result, 'violation');

  // Every issue says the category is a suggestion and carries the field it read.
  for (const issue of plan.issues) {
    assert.ok(issue.basis.length > 0, `归类要写明依据：${issue.text}`);
    assert.ok(issue.reading && typeof issue.reading === 'object');
  }
  assert.ok(plan.items.some(item => item.included), '预览要列出将包含的清单');
  assert.ok(plan.policy.some(item => item.category === 'material'), '整类排除要写明素材原件');
  assert.ok(plan.policy.some(item => item.category === 'credential'), '整类排除要写明密钥与登录态');
  // The member manifest is the preview a person confirms (R28 P1-3): every packed member, with size and content hash.
  assert.equal(plan.manifest.length, plan.items.filter(item => item.included).length + 2);
  for (const member of plan.manifest) {
    assert.ok(member.path && member.bytes >= 0 && /^[a-f0-9]{64}$/.test(member.sha256), JSON.stringify(member));
  }
  assert.ok(/^[a-f0-9]{64}$/.test(plan.manifestDigest));
});

test('the bundle reports the workflow state, the furthest stage, the blockage and the frozen tool hash', t => {
  const f = diagnosticsFixture(t);
  const plan = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
  assert.ok(plan.workflow);
  assert.equal(plan.workflow.id, f.workflowId);
  assert.equal(plan.workflow.pack?.id, 'test-pack', '能力包 ID 要来自 workflow_definition.tool_root 指向的包');
  assert.equal(plan.workflow.pack?.version, '1.2.3');
  assert.equal(plan.workflow.frozenTools.count, 3);
  // The stage states are the Runtime aggregator's own (R28 P1-4): setup passes, make is blocked by its check, and the
  // stage after a blocked one waits. Nothing here reads a completion row or a task's PASSED as "done" by itself.
  assert.equal(plan.workflow.furthestStage, 'setup', '最远完成的阶段是聚合器判定通过的 setup');
  assert.equal(plan.workflow.blockedAt, 'make');
  assert.equal(plan.workflow.stages.find(stage => stage.id === 'make')!.aggregateStatus, 'blocked');
  assert.deepEqual(plan.workflow.stages.find(stage => stage.id === 'make')!.reasonCodes, ['check_failed']);
  assert.equal(plan.workflow.stages.find(stage => stage.id === 'recolor')!.aggregateStatus, 'waiting');
  // Every Workflow's frozen tool hash digest, not only the newest one.
  assert.equal(plan.workflowTools.length, 1);
  assert.deepEqual(plan.workflowTools.map(row => [row.workflowId, row.toolCount, row.current]), [[f.workflowId, 3, true]]);
  assert.equal(plan.workflowTools[0]!.toolDigest, plan.workflow.frozenTools.digest);
  const setup = plan.workflow.stages.find(stage => stage.id === 'setup')!;
  assert.deepEqual(setup.checks.map(check => [check.id, check.result]), [['setup_complete', 'pass']]);
  // D-133's 逐 Run 摘要 covers successful Runs too (R28 P2-5).
  assert.deepEqual(plan.runs.map(run => run.id).sort(), [f.runs.makeFailed, f.runs.packageFailed, f.runs.recolor, f.runs.setupFailed, f.runs.setupOk].sort());
  assert.ok(plan.runs.some(run => run.exitStatus === 0 && run.errorClass === null), '成功的 Run 也有一行摘要');
});

test('the export writes report.md, diagnostics.json and the attachments, all redacted', t => {
  const f = diagnosticsFixture(t);
  const result = exportDiagnostics(f.db, f.config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
  assert.equal(result.status, 'exported');
  assert.ok(existsSync(result.package!.path));
  assert.equal(result.package!.bytes, statSync(result.package!.path).size);
  const files = members(result.package!.path);
  const report = files.get('report.md')!.toString('utf8');
  const document = JSON.parse(files.get('diagnostics.json')!.toString('utf8')) as Record<string, any>;

  // ① 版本与环境, ② 阶段状态, ③ 问题清单, ④ 事件时间线.
  for (const heading of ['一、版本与环境', '二、制作流程与阶段状态', '三、问题清单', '四、事件时间线', '五、收录了什么、排除了什么'])
    assert.ok(report.includes(heading), `report.md 缺少 ${heading}`);
  assert.match(report, /初步归类（建议，不是结论）/);
  assert.match(report, /Provider 与模型族|Provider /);
  assert.match(report, /环境锁的工具链版本：com\.vrchat\.avatars 3\.7\.0/);
  assert.match(report, /最远阶段：setup/);
  assert.match(report, /卡点：make/);
  assert.match(report, /逐 Run 摘要/);
  assert.equal(document.schema, 'harness-diagnostics/0.1');
  assert.equal(document.furthestStage, 'setup');
  assert.equal(document.classification.nature, 'suggestion');
  assert.equal(document.manifest.members, result.package!.members);

  // The attachments the asks name: the failing Run's log tails, the readings, the error window and the receipts.
  const paths = [...files.keys()];
  assert.ok(paths.includes(`attachments/runs/${f.runs.setupFailed}/stderr.log`), paths.join('\n'));
  assert.ok(paths.includes(`attachments/runs/${f.runs.setupFailed}/exit.json`));
  assert.ok(paths.includes(`attachments/runs/${f.runs.makeFailed}/checks/observe-material.inspect/metrics.json`));
  assert.ok(paths.includes(`attachments/runs/${f.runs.recolor}/observations/recolor_source_allowed.json`));
  assert.ok(paths.includes('attachments/environment/receipts.md'));
  const window = files.get(`attachments/runs/${f.runs.makeFailed}/unity-1.log`)!.toString('utf8');
  assert.ok(window.includes('references a missing texture'), '错误窗口要保留出错那几行');
  assert.ok(!window.includes('- Importing asset 5 ('), '整份日志的导入噪声不进包');
  // The material originals are files in the project, and none of them may be in the package.
  for (const path of [FIXTURE_PRIVATE.unitypackage, FIXTURE_PRIVATE.texture, FIXTURE_PRIVATE.path])
    assert.ok(!paths.some(member => member.endsWith(path.split('/').pop()!)), `${path} 不应进包`);

  // ⑤ Redaction: every private value is replaced, in the report and in every attachment -- including the two documents
  // themselves, whose issue texts repeat Run error messages.
  const all = [...files.entries()].map(([, bytes]) => bytes.toString('utf8')).join('\n');
  for (const secret of [FIXTURE_PRIVATE.order, FIXTURE_PRIVATE.windowsPath, FIXTURE_PRIVATE.linuxPath,
    FIXTURE_PRIVATE.apiKey, FIXTURE_PRIVATE.booth, FIXTURE_PRIVATE.word])
    assert.ok(!all.includes(secret), `导出结果仍含 ${secret}`);
  assert.ok(all.includes('<PROJECT>'), '工程路径要替换成占位符');
  assert.ok(all.includes('<HOME>') || all.includes('<AVH_HOME>'), '用户目录要替换成占位符');
  assert.ok(all.includes('<CUSTOMER>'), '本地隐私词表要生效');
  assert.ok(all.includes('<DEVBOX>'), '本地隐私词表的正则条目要生效');
  const setupLog = files.get(`attachments/runs/${f.runs.setupFailed}/stderr.log`)!.toString('utf8');
  assert.ok(setupLog.includes('network reset by peer'), '替换不能吃掉日志本身的内容');
  assert.ok(result.plan.items.some(item => item.redactions.length), '清单要写明每个附件替换了什么');
});

test('the packed bytes carry no credential, which is what the post-export scan confirms', t => {
  const f = diagnosticsFixture(t);
  const result = exportDiagnostics(f.db, f.config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
  assert.equal(result.status, 'exported');
  for (const [path, bytes] of members(result.package!.path))
    assert.deepEqual(credentialHits(bytes.toString('utf8'), 'content'), [], `${path} 在打包后仍命中密钥类模式`);
});

test('a log tails off, and under a tight budget the error window survives while plain tails are dropped', t => {
  const f = diagnosticsFixture(t);
  const result = exportDiagnostics(f.db, f.config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
  assert.equal(result.status, 'exported');
  const plan = result.plan;
  // R28 P2-3: the budget counts the whole package -- report, machine document and zip overhead included.
  assert.ok(plan.totals.keptBytes <= DIAGNOSTICS_BUDGET_BYTES);
  assert.ok(plan.budget.reservedBytes > 0, '报告与机读文档要计入预算');
  assert.ok(plan.budget.attachmentBudgetBytes < plan.budget.limitBytes);
  assert.ok(plan.budget.estimatedPackageBytes <= DIAGNOSTICS_BUDGET_BYTES);
  // The Unity window's reason says what it left behind, so a reader knows it is a window and not the whole log.
  const window = plan.items.find(item => item.category === 'log-window')!;
  assert.ok(window, 'Unity 日志要以错误窗口收录');
  assert.match(window.reason, /不收录整份/);
  assert.ok(window.keptBytes < window.bytes, '窗口应比整份日志小');

  // Under a budget too small for everything, the error window and the readings survive and the plain log tails are
  // dropped first: the budget covers what outranks them plus a little, so some tails cannot fit.
  const prior = process.env.AVH_DIAGNOSTICS_BUDGET_BYTES;
  const higherPriority = plan.items
    .filter(item => !['log-tail', 'record', 'server-log'].includes(item.category))
    .reduce((sum, item) => sum + item.keptBytes, 0);
  process.env.AVH_DIAGNOSTICS_BUDGET_BYTES = String(plan.budget.reservedBytes + higherPriority + 100);
  try {
    const tight = exportDiagnostics(f.db, f.config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
    assert.equal(tight.status, 'exported');
    assert.ok(tight.plan.items.some(item => item.category === 'log-window' && item.included), '错误窗口要在预算内保留');
    assert.ok(tight.plan.excluded.some(item => item.category === 'log-tail'), '普通日志尾部要先被丢弃');
    assert.ok(tight.plan.excluded.every(item => /上限/.test(item.excludedBecause ?? '')));
    assert.ok(tight.plan.totals.truncated.some(note => /错误窗口优先保留/.test(note)));
    assert.ok(tight.plan.totals.truncated.some(note => /报告、机读文档与压缩开销先占用/.test(note)), '截断范围要写进报告');
    assert.ok(tight.package!.bytes <= Number(process.env.AVH_DIAGNOSTICS_BUDGET_BYTES), '最终包体不得超过上限');
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_BUDGET_BYTES;
    else process.env.AVH_DIAGNOSTICS_BUDGET_BYTES = prior;
  }
});

test('--since narrows the issue list and the timeline', t => {
  const f = diagnosticsFixture(t);
  const plan = previewDiagnostics(f.db, f.config, f.projectId, { since: '2026-10-03T00:00:00.000Z', env: { home: f.home } });
  assert.ok(!plan.issues.some(issue => issue.runId === f.runs.setupFailed), '--since 之前的 Run 不在问题清单里');
  assert.ok(!plan.issues.some(issue => issue.reading.review), '--since 之前的导入复核不在问题清单里');
  assert.ok(plan.issues.some(issue => issue.checkId === 'recolor_source_allowed'));
  assert.ok(plan.timeline.every(event => event.at >= '2026-10-03T00:00:00.000Z'));
  // A Gate decision is the latest decision per gate and carries no event time of its own, so it is always listed.
  assert.ok(plan.issues.some(issue => issue.checkId === 'setup_approval'));
});

test('the same paths are redacted whether they are spelled for Windows or for Linux', () => {
  const roots = [{ path: 'C:\\Users\\alice\\work\\Luna', label: '<PROJECT>' }, { path: '/home/alice', label: '<HOME>' }];
  const windows = redactText('see C:\\Users\\alice\\work\\Luna\\Assets and C:/Users/alice/work/Luna/Assets', { roots }).text;
  assert.ok(!/alice/i.test(windows), windows);
  const linux = redactText('see /home/alice/work/Luna/Assets', { roots }).text;
  assert.ok(!/alice/.test(linux), linux);
  assert.ok(linux.includes('<HOME>'));
  // A bare user directory no root covers is still replaced, on both platforms.
  assert.ok(!/bob/.test(redactText('C:\\Users\\bob\\x /home/bob/y /Users/bob/z', {}).text));
  // Every placeholder the spec names has to be reachable, including the material pool.
  const placeholder = (label: string, path: string, text: string): string =>
    redactText(text, { roots: [{ path, label }] }).text;
  assert.ok(placeholder('<PROJECT>', 'D:\\work\\Luna', 'at D:/work/Luna/Assets').includes('<PROJECT>'));
  assert.ok(placeholder('<AVH_HOME>', 'D:\\avh', 'at D:\\avh\\config').includes('<AVH_HOME>'));
  assert.ok(placeholder('<POOL>', 'D:\\avh\\pool', 'at D:/avh/pool/ab/cd').includes('<POOL>'));
  assert.ok(placeholder('<WORKSPACE>', 'D:\\work', 'at D:\\work\\Luna').includes('<WORKSPACE>'));
});

/** R28 P1-1: a Provider Run's stdout is the model's own session, and event payloads are a projection, not a copy. */
test('a Provider reply, a user quote and another project\'s event never travel', t => {
  const f = diagnosticsFixture(t);
  const modelReply = 'MODEL_REPLY_SHOULD_NOT_LEAVE_12345';
  const userQuote = '用户的原始要求不该出端_ABCDE';
  const foreignPayload = 'OTHER_PROJECT_PAYLOAD_SHOULD_NOT_LEAVE';
  writeFileSync(join(f.home, 'runs', f.runs.setupFailed, 'stdout.log'), [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: modelReply } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'tool output that is not evidence' } }),
  ].join('\n'));
  // The real producer (`project-intent.ts`) records a user's own quote in a payload on a workflow-less event.
  f.db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
    VALUES (NULL, 'runtime', 'interaction', 'i-1', 'intent_updated', '保存有用户原文依据的要求解释', ?)`)
    .run(JSON.stringify({ revision: 1, updates: [{ object: 'x', attribute: 'y', quote: userQuote, replaces: null }] }));
  f.db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
    VALUES (?, 'runtime', 'run', ?, 'exited', 'Run exited', ?)`)
    .run(f.workflowId, f.runs.setupOk, JSON.stringify({ exitStatus: 0, content: foreignPayload }));

  const result = exportDiagnostics(f.db, f.config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
  assert.equal(result.status, 'exported');
  const files = members(result.package!.path);
  const all = [...files.entries()].map(([, bytes]) => bytes.toString('utf8')).join('\n');
  for (const secret of [modelReply, userQuote, foreignPayload, 'tool output that is not evidence'])
    assert.ok(!all.includes(secret), `诊断包仍含原文：${secret}`);
  // The Provider Run's stdout is not a member at all; the fields that describe the Run still are.
  assert.ok(![...files.keys()].some(path => path.startsWith(`attachments/runs/${f.runs.setupFailed}/stdout.log`)), 'Provider Run 的 stdout.log 不收录');
  assert.ok(files.has(`attachments/runs/${f.runs.setupFailed}/stderr.log`), '错误字段仍以 stderr 尾部收录');
  const report = files.get('report.md')!.toString('utf8');
  assert.match(report, /errorClass/);
  // A tool stage's own stdout is the tool's output and travels as before: only the Provider's session log is special.
  assert.ok(files.has(`attachments/runs/${f.runs.packageFailed}/stdout.log`), 'tool 阶段的 stdout.log 照旧收录');
  assert.ok(files.get(`attachments/runs/${f.runs.packageFailed}/stdout.log`)!.toString('utf8').includes('packager error'));
});

/** R28 P1-2: the report, the machine document, the member names and the package name all go through the redactor. */
test('metadata takes the same redaction as the contents: project name, editor path, member and package names', t => {
  const f = diagnosticsFixture(t);
  f.db.prepare('UPDATE project SET identity_json=? WHERE id=?')
    .run(JSON.stringify({ orderNumber: FIXTURE_PRIVATE.order, name: `${FIXTURE_PRIVATE.word}-COMM-deadbeef_client` }), f.projectId);
  const config = { ...f.config, unity: { editor: 'C:\\Users\\private-person\\Unity\\Editor\\Unity.exe', runner: 'batch' } } as typeof f.config;
  const result = exportDiagnostics(f.db, config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
  assert.equal(result.status, 'exported');
  const files = members(result.package!.path);
  const all = [...files.entries()].map(([, bytes]) => bytes.toString('utf8')).join('\n');
  for (const secret of [FIXTURE_PRIVATE.word, FIXTURE_PRIVATE.order, 'COMM-deadbeef_client', 'private-person'])
    assert.ok(!all.includes(secret), `元数据仍含 ${secret}`);
  assert.ok(!result.package!.path.includes(FIXTURE_PRIVATE.word), '包文件名要脱敏');
  assert.ok(!result.package!.path.includes('COMM-deadbeef'), '包文件名不带订单号');
  for (const path of files.keys()) assert.ok(!path.includes(FIXTURE_PRIVATE.word), `成员名要脱敏：${path}`);
  // A private user path in a *meta* rule (the Unity editor), not only in a log, is still refused after the fact: the
  // post-export scan covers paths, order ids and the local vocabulary, not only credentials.
  assert.deepEqual(sensitiveHits('C:\\Users\\private-person\\x', 'content'), ['private-user-path', 'user-home-path']);
  assert.ok(sensitiveHits('COMM-deadbeef_client', 'content').includes('order-id'));
  assert.deepEqual(sensitiveHits(`see ${FIXTURE_PRIVATE.word}`, 'content', { words: [{ id: 'w', source: FIXTURE_PRIVATE.word, flags: 'g', replacement: '<X>' }] }), ['word:w']);
});

/** R28 P1-3: the export is bound to the manifest the preview showed, and refuses when the content moved. */
test('the export is bound to the preview manifest and refuses when the content changed', t => {
  const f = diagnosticsFixture(t);
  const plan = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
  const out = join(f.home, 'exports');

  // A stale digest (the preview of another state) is refused before anything is written.
  const changed = exportDiagnostics(f.db, f.config, f.projectId,
    { out, env: { home: f.home }, expect: 'f'.repeat(64), generatedAt: plan.generatedAt });
  assert.equal(changed.status, 'refused');
  assert.equal(changed.refusal?.code, 'content_changed');
  assert.match(changed.refusal!.reason, /内容已变化，请重新预览/);
  assert.ok(!existsSync(out) || readdirSync(out).length === 0, '拒绝时不得留下产物');

  // The confirmed preview's digest exports exactly those members, and its compile instant is what makes them match.
  const confirmed = exportDiagnostics(f.db, f.config, f.projectId,
    { out, env: { home: f.home }, expect: plan.manifestDigest, generatedAt: plan.generatedAt });
  assert.equal(confirmed.status, 'exported');
  assert.deepEqual([...members(confirmed.package!.path).keys()].sort(), plan.manifest.map(member => member.path).sort(),
    '导出成员清单必须与预览一致');
  for (const member of plan.manifest)
    assert.equal(confirmed.plan.manifest.find(item => item.path === member.path)?.sha256, member.sha256, `${member.path} 的内容哈希要一致`);

  // Moving the content between the two compiles is exactly the case R28 saw: doctor.txt appearing after the preview.
  const before = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
  mkdirSync(join(f.home, 'state'), { recursive: true });
  writeFileSync(join(f.home, 'state', 'doctor.txt'), 'OK\tNode\tv24.18.0\n');
  const afterDoctor = exportDiagnostics(f.db, f.config, f.projectId,
    { out, env: { home: f.home }, expect: before.manifestDigest, generatedAt: before.generatedAt });
  assert.equal(afterDoctor.status, 'refused');
  assert.equal(afterDoctor.refusal?.code, 'content_changed');
  assert.ok(afterDoctor.plan.manifest.some(member => member.path.endsWith('doctor.txt')), '重新编译后清单里多了 doctor.txt');
});

/** R28 P1-4: a completion the Runtime has invalidated is not reported as done. */
test('an invalidated completion is not shown as done, and its reason code reaches the issue list', t => {
  const f = diagnosticsFixture(t);
  const workflowId = addInvalidatedWorkflow(f);

  const plan = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
  assert.equal(plan.workflow!.id, workflowId, '最新工作流就是被作废的那个');
  const setup = plan.workflow!.stages.find(stage => stage.id === 'setup')!;
  assert.equal(setup.aggregateStatus, 'open');
  assert.deepEqual(setup.reasonCodes, ['completion_invalidated']);
  assert.notEqual(setup.status, 'done', '完成记录还在，但聚合器已经作废它');
  assert.notEqual(plan.workflow!.furthestStage, 'setup', '不能把失效的完成算作最远阶段');
  assert.equal(plan.workflow!.blockedAt, 'setup');
  const issue = plan.issues.find(item => item.stageId === 'setup' && item.reading.reasonCodes)!;
  assert.ok(issue, '失效的完成要进问题清单');
  assert.match(issue.text, /完成证据已失效/);
});

/** R28 P2-1: an unquoted authorization header and a whole private-key block. */
test('an unquoted authorization header and a private key block are removed, and the scan refuses leftovers', () => {
  const token = 'Authorization: Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const redactedHeader = redactText(`curl -H "${token}"`, {}).text;
  assert.ok(!redactedHeader.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), redactedHeader);
  assert.match(redactedHeader, /<AUTHORIZATION-HEADER>/);
  assert.ok(credentialHits(token, 'content').includes('authorization-header'), '复扫要能认出无引号授权头');
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecretbodysecretbody\n-----END RSA PRIVATE KEY-----';
  const redactedKey = redactText(key, {}).text;
  assert.ok(!redactedKey.includes('secretbody'), '私钥正文不能只换掉开头标记');
  assert.ok(!redactedKey.includes('BEGIN RSA PRIVATE KEY'), redactedKey);
  assert.match(redactedKey, /<PRIVATE-KEY>/);
  // With redaction off entirely the post-export scan is what catches it: the marker alone still counts as a credential.
  assert.ok(credentialHits(key, 'content').includes('private-key'));
});

/** R28 P2-2: a verdict binds to the Run that recorded it, never to the newest Run of the same stage. */
test('a verdict binds to its own Run, even when another workflow has a newer Run on the same stage', t => {
  const f = diagnosticsFixture(t);
  const decoy = addWorkflow(f, 'w-decoy');
  const mine = addWorkflow(f, 'w-mine');
  const mineRun = `${mine.workflowId}-run`, decoyRun = `${decoy.workflowId}-run`;
  // The current workflow's own Run is inserted first, so "the newest Run of stage make" would be the decoy's.
  addRun(f, mineRun, mine.taskId, { exitStatus: 0, verdictIds: [`${mineRun}:vendor_material_complete`] });
  f.db.prepare(`INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result, basis, recorded_at)
    VALUES (?, ?, 'vendor_material_complete', 'edit', ?, 'no_data', 'material.inspect: 缺件清单不可读', '2026-10-05T00:00:00.000Z')`)
    .run(`${mineRun}:vendor_material_complete`, mine.workflowId, 'e'.repeat(64));
  addRun(f, decoyRun, decoy.taskId, { exitStatus: 0, verdictIds: [] });
  mkdirSync(join(f.home, 'runs', decoyRun, 'checks', 'observe-material.inspect'), { recursive: true });
  writeFileSync(join(f.home, 'runs', decoyRun, 'checks', 'observe-material.inspect', 'metrics.json'),
    JSON.stringify({ schema: 'observation/0.1', metrics: { missing: 999 } }));
  mkdirSync(join(f.home, 'runs', mineRun, 'checks', 'observe-material.inspect'), { recursive: true });
  writeFileSync(join(f.home, 'runs', mineRun, 'checks', 'observe-material.inspect', 'metrics.json'),
    JSON.stringify({ schema: 'observation/0.1', metrics: { missing: 1 } }));

  const plan = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
  assert.equal(plan.workflow!.id, mine.workflowId);
  const issue = plan.issues.find(item => item.checkId === 'vendor_material_complete')!;
  assert.equal(issue.runId, mineRun, '判据要绑定记录它的那次 Run');
  assert.equal(issue.reading.runAssociation, 'run.result_json.verdictIds');
  assert.deepEqual(issue.attachments, [`attachments/runs/${mineRun}/checks/observe-material.inspect/metrics.json`]);

  // No recorded link at all: the bundle says so and reads no Run directory rather than guessing the newest one.
  f.db.prepare(`INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result, basis, recorded_at)
    VALUES ('w-mine:recolor_source_allowed', ?, 'recolor_source_allowed', 'edit', ?, 'violation', 'recolor.inspect: excluded_sources_used == 0', '2026-10-05T01:00:00.000Z')`)
    .run(mine.workflowId, 'e'.repeat(64));
  const again = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
  const unbound = again.issues.find(item => item.checkId === 'recolor_source_allowed')!;
  assert.equal(unbound.runId, null);
  assert.equal(unbound.reading.runAssociation, 'unproven');
  assert.match(unbound.text, /缺证/);
  assert.deepEqual(unbound.attachments, []);
});

/** R28 P2-3: a huge error window is bounded, keeps the last error, and says what it cut. */
test('a window far over the attachment ceiling keeps the last error and records the truncated ranges', t => {
  const f = diagnosticsFixture(t);
  const big = join(f.home, 'runs', f.runs.makeFailed, 'unity-9.log');
  const filler = 'warning: import noise line '.repeat(80);   // ~2 KB a line, as in the review's construction
  const lines = Array.from({ length: 11_000 }, (_, index) => `${index}: ${filler}`);
  lines.push(`11000: Shader error in 'Vendor/Private': Fatal error, compilation failed`);
  writeFileSync(big, lines.join('\n'));
  // The construction R28 used: the whole ±12-line window over 11,000 warnings merges into one block bigger than the
  // 20 MB budget, so the old code dropped the attachment whole and the fatal line at the end never reached the reader.
  assert.ok(Buffer.byteLength(lines.join('\n'), 'utf8') > DIAGNOSTICS_BUDGET_BYTES, '构造必须超过整包上限，复现"整项排除"');
  f.db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
    VALUES (?, 'runtime', 'run', ?, 'failed', 'Run failed: tool_failure', '{}')`).run(f.workflowId, f.runs.makeFailed);

  const result = exportDiagnostics(f.db, f.config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
  assert.equal(result.status, 'exported');
  const files = members(result.package!.path);
  const window = files.get(`attachments/runs/${f.runs.makeFailed}/unity-9.log`)!.toString('utf8');
  assert.ok(window.includes('Fatal error, compilation failed'), '最后一条错误必须保留');
  assert.ok(Buffer.byteLength(window, 'utf8') <= 512 * 1024 + 2048, '窗口必须限额');
  assert.ok(window.includes('因限额未收录第'), '截断范围要写进窗口头部');
  const item = result.plan.items.find(entry => entry.path.endsWith('unity-9.log'))!;
  assert.ok(item.included, '限额后的窗口要留在包里，而不是整项丢弃');
  assert.match(item.reason, /截断/);
  // R28 P2-3: the truncated ranges travel in `report.md`, not only inside the attachment's own header.
  assert.ok(result.plan.totals.truncated.some(note => note.includes('unity-9.log') && note.includes('未收录第')),
    JSON.stringify(result.plan.totals.truncated));
  const report = members(result.package!.path).get('report.md')!.toString('utf8');
  assert.match(report, /## 六、截断了什么/);
  assert.match(report, /未收录第/);
});

/** R28 P2-5: receipts, per-Run lines and observation notes are real readings, not a stub. */
test('the receipts summary reads the setup import, dependency and retirement receipts, and notes reach the issues', t => {
  const f = diagnosticsFixture(t);
  const result = exportDiagnostics(f.db, f.config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
  assert.equal(result.status, 'exported');
  const files = members(result.package!.path);
  const receipts = files.get('attachments/environment/receipts.md')!.toString('utf8');
  assert.match(receipts, /setup 导入记录（最近 1 次）/);
  assert.match(receipts, /import-1/);
  assert.match(receipts, /delivery_archive=fail/);
  assert.match(receipts, /依赖与退役回执（工程里找到 1 个）/);
  assert.match(receipts, /material-dependency-receipt\/0\.1/);
  assert.match(receipts, /退役 1 条/);
  assert.match(receipts, /最近一次退役 deleted/);
  // The receipt is summarised by whitelisted fields: its own bytes are not in the package.
  const receiptText = files.get(`attachments/environment/receipts.md`)!.toString('utf8');
  assert.ok(!receiptText.includes('request_sha256'), '回执原文不收录');
  // A vendor omission in an observation note is a material issue; a plain limitation is a known-limitation one.
  const notes = result.plan.issues.filter(issue => issue.reading.note);
  assert.equal(notes.length, 2, JSON.stringify(notes.map(note => note.text)));
  assert.equal(notes.find(note => note.category === 'material')?.runId, f.runs.setupOk);
  assert.match(notes.find(note => note.category === 'material')!.text, /厂商缺件/);
  assert.equal(notes.find(note => note.category === 'known_limitation')?.runId, f.runs.setupOk);
  const report = files.get('report.md')!.toString('utf8');
  assert.match(report, /观测提醒/);
  assert.match(report, /逐 Run 摘要/);
});

test('the CLI previews and exports through the same module, records avh doctor, and exits 0', t => {
  const f = diagnosticsFixture(t);
  const out = join(f.home, 'exports');
  const run = spawnSync(process.execPath, [cli, 'project', 'diagnose', f.projectId, '--out', out], {
    encoding: 'utf8', env: { ...process.env, AVH_HOME: f.home } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /诊断包预览/);
  assert.match(run.stdout, /已收录 avh doctor 的输出/, '导出前要记下 doctor 的读数');
  assert.match(run.stdout, /清单摘要：\d+ 个成员/);
  assert.match(run.stdout, /导出后已逐成员复扫：没有命中密钥、私人路径、订单号或本地隐私词表/);
  // `avh doctor` really ran against this fixture home, its reading is on disk, and it travelled in the bundle.
  const reading = readFileSync(join(f.home, 'state', 'doctor.txt'), 'utf8');
  assert.ok(reading.length > 0, 'doctor 读数已落盘');
  const bundle = readdirSync(out).find(name => name.endsWith('.zip'))!;
  const entries = readZip(readFileSync(join(out, bundle)));
  const paths = entries.map(member => member.path);
  assert.ok(paths.includes('attachments/environment/doctor.txt'), paths.join('\n'));
  // The printed preview is the same manifest the package holds (R28 P1-3): doctor.txt is in both.
  const printed = /清单摘要：(\d+) 个成员/.exec(run.stdout)![1];
  assert.equal(Number(printed), paths.length, 'CLI 打印的清单摘要要与实际包一致');
  const doctor = entries.find(member => member.path === 'attachments/environment/doctor.txt')!
    .bytes.toString('utf8');
  assert.ok(!/C:\\Users\\[^<\\]/i.test(doctor), 'doctor 读数里的本机路径同样被替换');
  const preview = spawnSync(process.execPath, [cli, 'project', 'diagnose', f.projectId, '--preview'], {
    encoding: 'utf8', env: { ...process.env, AVH_HOME: f.home } });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /只预览，没有写出任何文件/);
  // A preview leaves the recorded reading alone and does not run doctor again.
  assert.equal(readFileSync(join(f.home, 'state', 'doctor.txt'), 'utf8'), reading);
});

test('the protection switches are inert outside the test runner, so an environment variable cannot turn them off', () => {
  // A process started the way the product starts: no NODE_TEST_CONTEXT, no --test, and every switch set.
  const env: NodeJS.ProcessEnv = { ...process.env, AVH_DIAGNOSTICS_NO_REDACTION: '1', AVH_DIAGNOSTICS_NO_RESCAN: '1' };
  delete env.NODE_TEST_CONTEXT;
  const module = new URL('../src/diagnostics/diagnose.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { diagnosticsTestSwitchesHonoured } from ${JSON.stringify(module)}; console.log(diagnosticsTestSwitchesHonoured());`],
  { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'false');
  // Under the runner the same switches are what the anti-fix cases below depend on.
  assert.equal(diagnosticsTestSwitchesHonoured(), true);
});

/**
 * Anti-fix verification: each mechanism is turned off through its own switch, and the assertion that depends on it
 * must fail. Without this, a test that passes because the fixture is harmless would look the same as one that passes
 * because the mechanism works.
 */
test('mutation: turning redaction off leaks a private value, and the post-export scan is what catches it', t => {
  const f = diagnosticsFixture(t);
  const prior = process.env.AVH_DIAGNOSTICS_NO_REDACTION;
  process.env.AVH_DIAGNOSTICS_NO_REDACTION = '1';
  try {
    const result = exportDiagnostics(f.db, f.config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
    // With redaction off the packed bytes still carry the API key, and the post-export scan refuses rather than ship it.
    assert.equal(result.status, 'refused');
    assert.equal(result.refusal!.code, 'credential');
    assert.ok(result.refusal!.members.some(member => member.detectors.includes('api-key-shape')), JSON.stringify(result.refusal));
    assert.equal(result.package, undefined, '拒绝时不得留下产物');
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_NO_REDACTION;
    else process.env.AVH_DIAGNOSTICS_NO_REDACTION = prior;
  }
});

test('mutation: turning the post-export scan off ships the credential that redaction alone did not stop', t => {
  const f = diagnosticsFixture(t);
  const priorRedaction = process.env.AVH_DIAGNOSTICS_NO_REDACTION;
  const priorRescan = process.env.AVH_DIAGNOSTICS_NO_RESCAN;
  process.env.AVH_DIAGNOSTICS_NO_REDACTION = '1';
  process.env.AVH_DIAGNOSTICS_NO_RESCAN = '1';
  try {
    const result = exportDiagnostics(f.db, f.config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
    assert.equal(result.status, 'exported', '没有复扫时，未脱敏的包会被写出：这正是复扫存在的理由');
    const bytes = members(result.package!.path).get(`attachments/runs/${f.runs.setupFailed}/stderr.log`)!.toString('utf8');
    assert.ok(bytes.includes(FIXTURE_PRIVATE.apiKey), '未脱敏的包确实带着 API key');
    assert.deepEqual(credentialHits(bytes, 'content').sort(), ['api-key-shape', 'booth-session-value']);
  } finally {
    if (priorRedaction === undefined) delete process.env.AVH_DIAGNOSTICS_NO_REDACTION;
    else process.env.AVH_DIAGNOSTICS_NO_REDACTION = priorRedaction;
    if (priorRescan === undefined) delete process.env.AVH_DIAGNOSTICS_NO_RESCAN;
    else process.env.AVH_DIAGNOSTICS_NO_RESCAN = priorRescan;
  }
});

test('mutation: turning classification off loses the category the fields support', t => {
  const f = diagnosticsFixture(t);
  const prior = process.env.AVH_DIAGNOSTICS_NO_CLASSIFY;
  process.env.AVH_DIAGNOSTICS_NO_CLASSIFY = '1';
  try {
    const plan = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
    assert.notEqual(issueFor(plan, f.runs.setupFailed)!.category, 'environment');
    assert.equal(issueFor(plan, f.runs.setupFailed)!.category, 'product_defect');
    assert.notEqual(issueFor(plan, 'vendor_material_complete')!.category, 'material');
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_NO_CLASSIFY;
    else process.env.AVH_DIAGNOSTICS_NO_CLASSIFY = prior;
  }
});

/** R28 P1-1 mutation: without the projection, the Provider's session log and the raw payload travel again. */
test('mutation: turning the projection off leaks the Provider session log and the event payload', t => {
  const f = diagnosticsFixture(t);
  const modelReply = 'MODEL_REPLY_MUTATION_12345';
  const userQuote = '用户的原始要求_MUTATION';
  writeFileSync(join(f.home, 'runs', f.runs.setupFailed, 'stdout.log'),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: modelReply } }));
  f.db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
    VALUES (NULL, 'runtime', 'interaction', 'i-1', 'intent_updated', '保存有用户原文依据的要求解释', ?)`)
    .run(JSON.stringify({ revision: 1, updates: [{ quote: userQuote }] }));
  const prior = process.env.AVH_DIAGNOSTICS_NO_PROJECTION;
  process.env.AVH_DIAGNOSTICS_NO_PROJECTION = '1';
  try {
    const result = exportDiagnostics(f.db, f.config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
    assert.equal(result.status, 'exported');
    const files = members(result.package!.path);
    assert.ok(files.has(`attachments/runs/${f.runs.setupFailed}/stdout.log`), '关掉投影后 Provider 的 stdout.log 又进了包');
    const all = [...files.entries()].map(([, bytes]) => bytes.toString('utf8')).join('\n');
    assert.ok(all.includes(modelReply), '关掉投影后模型回复原文出现');
    assert.ok(all.includes(userQuote), '关掉投影后用户原话出现');
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_NO_PROJECTION;
    else process.env.AVH_DIAGNOSTICS_NO_PROJECTION = prior;
  }
});

/** R28 P1-2 mutation: without the whole-document pass, a private project name and editor path bypass the redactor. */
test('mutation: turning the metadata redaction off leaves a private name and path in the documents', t => {
  const f = diagnosticsFixture(t);
  f.db.prepare('UPDATE project SET identity_json=? WHERE id=?')
    .run(JSON.stringify({ orderNumber: FIXTURE_PRIVATE.order, name: `${FIXTURE_PRIVATE.word}-COMM-deadbeef_client` }), f.projectId);
  const config = { ...f.config, unity: { editor: 'C:\\Users\\private-person\\Unity\\Editor\\Unity.exe', runner: 'batch' } } as typeof f.config;
  const prior = process.env.AVH_DIAGNOSTICS_NO_METADATA_REDACTION;
  process.env.AVH_DIAGNOSTICS_NO_METADATA_REDACTION = '1';
  try {
    const result = exportDiagnostics(f.db, config, f.projectId, { out: join(f.home, 'exports'), env: { home: f.home } });
    // Either the metadata survives into a written package, or the post-export scan refuses it: both mean the
    // whole-document pass is what keeps it out, which is the point of the mutation.
    if (result.status === 'exported') {
      const all = [...members(result.package!.path).entries()].map(([, bytes]) => bytes.toString('utf8')).join('\n');
      assert.ok(all.includes(FIXTURE_PRIVATE.word) || all.includes('private-person'), '关掉元数据脱敏后私密值仍在包内');
    } else {
      assert.ok(result.refusal!.members.some(member => member.detectors.some(id => id === 'private-user-path' || id === 'user-home-path' || id.startsWith('word:'))),
        JSON.stringify(result.refusal));
    }
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_NO_METADATA_REDACTION;
    else process.env.AVH_DIAGNOSTICS_NO_METADATA_REDACTION = prior;
  }
});

/** R28 P1-3 mutation: without the binding, an export confirmed against another manifest still writes a bundle. */
test('mutation: without the manifest binding, a stale confirmation exports a different bundle', t => {
  const f = diagnosticsFixture(t);
  const prior = process.env.AVH_DIAGNOSTICS_NO_MANIFEST_BINDING;
  process.env.AVH_DIAGNOSTICS_NO_MANIFEST_BINDING = '1';
  try {
    const plan = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
    const result = exportDiagnostics(f.db, f.config, f.projectId,
      { out: join(f.home, 'exports'), env: { home: f.home }, expect: 'f'.repeat(64), generatedAt: plan.generatedAt });
    assert.equal(result.status, 'exported', '关掉绑定后，未经确认的清单也会被写出');
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_NO_MANIFEST_BINDING;
    else process.env.AVH_DIAGNOSTICS_NO_MANIFEST_BINDING = prior;
  }
});

/** R28 P1-4 mutation: without the aggregator, an invalidated completion reads as "done" again. */
test('mutation: without the Runtime aggregator, an invalidated completion is shown as done', t => {
  const f = diagnosticsFixture(t);
  addInvalidatedWorkflow(f);
  const prior = process.env.AVH_DIAGNOSTICS_NO_AGGREGATE;
  process.env.AVH_DIAGNOSTICS_NO_AGGREGATE = '1';
  try {
    const plan = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
    const setup = plan.workflow!.stages.find(stage => stage.id === 'setup')!;
    assert.equal(setup.aggregateStatus, null, '关掉聚合后没有状态可显示');
    assert.equal(setup.reasonCodes.length, 0, '关掉聚合后没有原因码可显示');
    assert.equal(setup.status, 'done', '完成记录与 PASSED 任务又被当成了已完成');
    assert.equal(plan.workflow!.furthestStage, 'make', '退回完成记录判断后，最远阶段又按任务 PASSED 推出去了');
    assert.ok(!plan.issues.some(issue => issue.reading.reasonCodes), '失效的完成不再进问题清单');
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_NO_AGGREGATE;
    else process.env.AVH_DIAGNOSTICS_NO_AGGREGATE = prior;
  }
});

// ---- R28, second round: the five findings the review left open ------------------------------------------------

/**
 * R28 2nd round P1: the person's own redo note is free text and must not be copied. The review drove the real
 * producer (`taskRedo` -> `human/requested_redo`, reason = the note). The second half of the same construction is why
 * the cut cannot be keyed on `actor`: a redo of a BLOCKED task also runs `transitionTask(..., note)`, whose event has
 * `actor='runtime'` and the same note in `reason`.
 */
test("a person's own redo note never travels, though the action and its object stay in the timeline", t => {
  const f = diagnosticsFixture(t);
  const note = 'PRIVATE_REDO_NOTE_把刘海改短一点_ABCDE';
  // A real PASSED stage and a real BLOCKED one: the first records one human event, the second a human event and a
  // runtime task transition that carries the same note.
  f.db.prepare(`INSERT INTO task (id, workflow_id, stage_id, goal, capability, status)
    VALUES ('t-blocked', ?, 'setup', '阶段 setup', 'provider', 'BLOCKED')`).run(f.workflowId);
  taskRedo(f.db, 't-make', note);
  taskRedo(f.db, 't-blocked', note);

  const out = join(f.home, 'exports');
  const result = exportDiagnostics(f.db, f.config, f.projectId, { out, env: { home: f.home } });
  assert.equal(result.status, 'exported');
  const files = members(result.package!.path);
  const report = files.get('report.md')!.toString('utf8');
  const document = files.get('diagnostics.json')!.toString('utf8');
  assert.ok(!report.includes(note), 'report.md 不得含用户修改意见原文');
  assert.ok(!document.includes(note), 'diagnostics.json 不得含用户修改意见原文');
  assert.ok(![...files.values()].some(bytes => bytes.toString('utf8').includes('刘海')), '任何成员都不得含该原文');

  // What stays: the action, its time and the object it names -- the task -- for both the human and the runtime event.
  const redo = result.plan.timeline.find(event => event.action === 'requested_redo')!;
  assert.ok(redo, '重做动作仍要在时间线里');
  assert.equal(redo.actor, 'human');
  assert.equal(redo.entityType, 'task');
  assert.equal(redo.entityId, 't-make');
  assert.equal(redo.reason, undefined, '运输版不复制 reason 列');
  const transition = result.plan.timeline.find(event => event.action === 'BLOCKED->READY')!;
  assert.ok(transition, 'runtime 的任务迁移也仍在时间线里');
  assert.equal(transition.actor, 'runtime');
  assert.equal(transition.entityId, 't-blocked');
  assert.equal(transition.reason, undefined, 'runtime 事件同样不复制 reason 列（恢复说明也在这一列）');
  assert.match(report, /人工动作：原话不收录/);
  assert.match(report, /时间线只保留动作、时间与关联对象/);

  // The anti-fix switch: copying the column again is exactly what leaked the note in the review.
  const prior = process.env.AVH_DIAGNOSTICS_NO_TIMELINE_TEXT;
  process.env.AVH_DIAGNOSTICS_NO_TIMELINE_TEXT = '1';
  try {
    const leaked = exportDiagnostics(f.db, f.config, f.projectId, { out, env: { home: f.home } });
    assert.equal(leaked.status, 'exported');
    const again = members(leaked.package!.path);
    assert.ok(again.get('report.md')!.toString('utf8').includes(note), '关掉投影后原文又出现在 report.md');
    assert.ok(again.get('diagnostics.json')!.toString('utf8').includes(note), '关掉投影后原文又出现在 diagnostics.json');
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_NO_TIMELINE_TEXT;
    else process.env.AVH_DIAGNOSTICS_NO_TIMELINE_TEXT = prior;
  }
});

/** R28 2nd round P2-1: a private key whose `END` never arrived must not leave its body behind. */
test('an unterminated private key block is removed whole, and the scan can still find it', t => {
  const f = diagnosticsFixture(t);
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAunterminatedbodysecret\n';
  // The unit shape first: the body must not survive just because the block never closed.
  const redacted = redactText(key, {}).text;
  assert.ok(!redacted.includes('unterminatedbodysecret'), redacted);
  assert.ok(!redacted.includes('BEGIN RSA PRIVATE KEY'), redacted);
  assert.match(redacted, /<PRIVATE-KEY>/);
  assert.ok(credentialHits(key, 'content').includes('private-key-unterminated'), '复扫要认得未闭合的私钥块');
  // A complete block followed by an unterminated one: the first is removed, the second takes the rest of the text.
  const mixed = redactText(`${'-----BEGIN RSA PRIVATE KEY-----'}\nbodyone\n${'-----END RSA PRIVATE KEY-----'}\ntail\n${key}`, {}).text;
  assert.ok(!mixed.includes('bodyone') && !mixed.includes('unterminatedbodysecret'), mixed);

  // The real path: the failing Run's stderr carries it, and the export must not ship the body.
  const log = join(f.home, 'runs', f.runs.setupFailed, 'stderr.log');
  writeFileSync(log, `${readFileSync(log, 'utf8')}\n${key}`);
  const out = join(f.home, 'exports');
  const result = exportDiagnostics(f.db, f.config, f.projectId, { out, env: { home: f.home } });
  assert.equal(result.status, 'exported');
  const files = members(result.package!.path);
  const shipped = files.get(`attachments/runs/${f.runs.setupFailed}/stderr.log`)!.toString('utf8');
  assert.ok(!shipped.includes('unterminatedbodysecret'), '未闭合私钥的正文不得出端');
  assert.ok(result.plan.items.some(item => item.redactions.some(hit => hit.id === 'private-key-unterminated')),
    JSON.stringify(result.plan.items.map(item => item.redactions)));

  // Without redaction the post-export scan is what refuses it, and it names this shape rather than the marker alone.
  const prior = process.env.AVH_DIAGNOSTICS_NO_REDACTION;
  process.env.AVH_DIAGNOSTICS_NO_REDACTION = '1';
  try {
    const refused = exportDiagnostics(f.db, f.config, f.projectId, { out, env: { home: f.home } });
    // The fixture also carries an API key, so the refusal may name several detectors; this one has to be among them.
    assert.equal(refused.status, 'refused');
    assert.equal(refused.refusal!.code, 'credential');
    assert.ok(refused.refusal!.members.some(member => member.detectors.includes('private-key-unterminated')),
      JSON.stringify(refused.refusal));
    assert.equal(refused.package, undefined);
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_NO_REDACTION;
    else process.env.AVH_DIAGNOSTICS_NO_REDACTION = prior;
  }
});

/**
 * R28 2nd round P2-2: an old Run is judged by the capabilities its own Workflow froze. The review built an old
 * Workflow whose `setup` was a provider and a newer one whose `setup` is a tool; reading the newest definition put the
 * old Run's model session into the bundle as if it were a tool's stdout.
 */
test('an old Run reads the stage mode of its own Workflow, and an unprovable mode collects no stdout', t => {
  const f = diagnosticsFixture(t);
  // The newest Workflow says `setup` is a tool; the fixture's own Workflow (which made the setup Run) says provider.
  const capabilities = JSON.parse(JSON.stringify(DIAGNOSTICS_CAPABILITIES)) as {
    stages: Record<string, { mode: string }> };
  capabilities.stages.setup = { ...capabilities.stages.setup, mode: 'tool' };
  addWorkflow(f, 'w-latest-tool-setup', { capabilities });
  const session = 'OLD_WORKFLOW_PROVIDER_SESSION_SHOULD_NOT_LEAVE';
  writeFileSync(join(f.home, 'runs', f.runs.setupFailed, 'stdout.log'), session);

  const out = join(f.home, 'exports');
  const result = exportDiagnostics(f.db, f.config, f.projectId, { out, env: { home: f.home } });
  assert.equal(result.status, 'exported');
  const files = members(result.package!.path);
  assert.ok(!files.has(`attachments/runs/${f.runs.setupFailed}/stdout.log`),
    '旧 Run 属于 provider 阶段的那个工作流，stdout 不得收录');
  assert.ok(![...files.values()].some(bytes => bytes.toString('utf8').includes(session)), '模型会话原文不得出端');

  // The anti-fix switch restores "the newest workflow decides", which is what the review measured.
  const prior = process.env.AVH_DIAGNOSTICS_LATEST_MODE_FOR_RUNS;
  process.env.AVH_DIAGNOSTICS_LATEST_MODE_FOR_RUNS = '1';
  try {
    const leaked = exportDiagnostics(f.db, f.config, f.projectId, { out, env: { home: f.home } });
    assert.equal(leaked.status, 'exported');
    assert.ok(members(leaked.package!.path).has(`attachments/runs/${f.runs.setupFailed}/stdout.log`),
      '按最新工作流判断时，旧 Run 的 provider 会话又被当成了 tool 的 stdout');
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_LATEST_MODE_FOR_RUNS;
    else process.env.AVH_DIAGNOSTICS_LATEST_MODE_FOR_RUNS = prior;
  }
});

/** R28 2nd round P2-3: a document field of arbitrary length, and a pack that measures over the limit. */
test('a document field over the ceiling is cut and recorded, and a pack over the limit is refused', t => {
  const f = diagnosticsFixture(t);
  const out = join(f.home, 'exports');
  // The review's exact construction: one event `reason` of ~21 MiB, more than the whole budget. The timeline does not
  // copy the column, so the bundle stays inside the ceiling and never writes the text.
  const hugeReason = `HUGE_EVENT_REASON_${'R'.repeat(21 * 1024 * 1024)}`;
  f.db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
    VALUES (?, 'runtime', 'run', ?, 'failed', ?, '{}')`).run(f.workflowId, f.runs.setupFailed, hugeReason);
  const result = exportDiagnostics(f.db, f.config, f.projectId, { out, env: { home: f.home } });
  assert.equal(result.status, 'exported');
  assert.ok(result.package!.bytes <= DIAGNOSTICS_BUDGET_BYTES, `实际包体 ${result.package!.bytes} 不得超过上限`);
  assert.ok(![...members(result.package!.path).values()].some(bytes => bytes.toString('utf8').includes('HUGE_EVENT_REASON')),
    '超长事件原文不得因长度而进包');

  // A field the documents do copy: a project name over the ceiling is cut to the per-field limit, and the cut is named
  // in 「截断了什么」 in report.md and in the preview's own totals.
  f.db.prepare('UPDATE project SET identity_json=? WHERE id=?')
    .run(JSON.stringify({ orderNumber: FIXTURE_PRIVATE.order, name: `COMM-project-${'x'.repeat(21 * 1024 * 1024)}` }), f.projectId);
  const capped = exportDiagnostics(f.db, f.config, f.projectId, { out, env: { home: f.home } });
  assert.equal(capped.status, 'exported');
  assert.ok(capped.package!.bytes <= DIAGNOSTICS_BUDGET_BYTES);
  assert.ok(capped.plan.totals.truncated.some(note => /文档里有 \d+ 个字段超过/.test(note)),
    JSON.stringify(capped.plan.totals.truncated));
  const report = members(capped.package!.path).get('report.md')!.toString('utf8');
  assert.match(report, /## 六、截断了什么/);
  assert.match(report, /已截断/);
  assert.ok(!report.includes('x'.repeat(2500)), '报告里不能留着超限字段的全文');

  // Without the per-field ceiling the report itself is over the limit: the pack is measured and refused, not written.
  const prior = process.env.AVH_DIAGNOSTICS_NO_DOCUMENT_CAP;
  process.env.AVH_DIAGNOSTICS_NO_DOCUMENT_CAP = '1';
  try {
    const over = exportDiagnostics(f.db, f.config, f.projectId, { out, env: { home: f.home } });
    assert.equal(over.status, 'refused');
    assert.equal(over.refusal!.code, 'over_budget');
    assert.match(over.refusal!.reason, /超过整包上限/);
    assert.equal(over.package, undefined, '超限时不得写出任何包');
    assert.ok(over.plan.warnings.some(warning => /超过整包上限/.test(warning)), '预览要预先说明导出会被拒绝');
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_NO_DOCUMENT_CAP;
    else process.env.AVH_DIAGNOSTICS_NO_DOCUMENT_CAP = prior;
  }
});

/**
 * R28 2nd round P2-4: the observation-file limit counts per Run. The review put 42 observation files in a newer Run;
 * the single global counter read them all, then `break outer`-ed past an older Run whose vendor omission note was the
 * only place a missing material was recorded.
 */
test('the observation-file limit is per Run, and every omission is named in the preview and the report', t => {
  const f = diagnosticsFixture(t);
  const flood = join(f.home, 'runs', f.runs.packageFailed, 'observations');
  mkdirSync(flood, { recursive: true });
  for (let index = 0; index < 42; index++)
    writeFileSync(join(flood, `observation-${String(index).padStart(2, '0')}.json`),
      JSON.stringify({ schema: 'observation/0.1', notes: [`较新 Run 的占位观测 ${index}`] }));
  const out = join(f.home, 'exports');

  const result = exportDiagnostics(f.db, f.config, f.projectId, { out, env: { home: f.home } });
  assert.equal(result.status, 'exported');
  const vendor = result.plan.issues.find(issue => issue.reading.note && /厂商缺件/.test(String(issue.reading.note)));
  assert.ok(vendor, '较早 Run 的厂商缺件提醒不能因为较新 Run 的文件多而消失');
  assert.equal(vendor!.runId, f.runs.setupOk);
  assert.ok(result.plan.totals.truncated.some(note => /观测文件只读了前 40 个/.test(note)),
    JSON.stringify(result.plan.totals.truncated));
  const report = members(result.package!.path).get('report.md')!.toString('utf8');
  assert.match(report, /观测文件只读了前 40 个/, '省略范围要写进 report.md');

  // The anti-fix switch: one counter for the whole project reads the newest Run's files and stops before the old Run.
  const prior = process.env.AVH_DIAGNOSTICS_GLOBAL_OBSERVATION_LIMIT;
  process.env.AVH_DIAGNOSTICS_GLOBAL_OBSERVATION_LIMIT = '1';
  try {
    const limited = previewDiagnostics(f.db, f.config, f.projectId, { env: { home: f.home } });
    assert.ok(!limited.issues.some(issue => issue.reading.note && /厂商缺件/.test(String(issue.reading.note))),
      '全项目计数时，较早 Run 的缺件提醒被跳过');
    assert.ok(limited.totals.truncated.some(note => /观测文件总数只读了前 40 个/.test(note)));
  } finally {
    if (prior === undefined) delete process.env.AVH_DIAGNOSTICS_GLOBAL_OBSERVATION_LIMIT;
    else process.env.AVH_DIAGNOSTICS_GLOBAL_OBSERVATION_LIMIT = prior;
  }
});
