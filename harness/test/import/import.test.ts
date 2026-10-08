import assert from 'node:assert/strict';
import { chmodSync, closeSync, existsSync, ftruncateSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { openDatabase } from '../../src/state/db.ts';
import { importProject, handoffMarkdown, getImportReport } from '../../src/import/index.ts';
import { mergeLedger, parseLedger, parseRecord, sha256, snapshot } from '../../src/import/scan.ts';
import { collectArtifactClaims } from '../../src/import/review.ts';
import { DEFAULT_IMPORT_CONFIG } from '../../src/import/types.ts';
import type { ProcessDefinition } from '../../src/process/types.ts';
import { fakeCommand, removeTemp, windows } from '../fixtures/platform.ts';
import { hostPlatform } from '../../src/host-platform.ts';

// Build explicit synthetic orders so privacy scans never need fixture exceptions.
const syntheticOrder = ['COMM', 'a1b2c3d4'].join('-');
const otherSyntheticOrder = ['COMM', 'deadbeef'].join('-');

const definition: ProcessDefinition = {
  schema: 'process/0.1', id: 'synthetic', version: '1', applies_to: {}, artifacts: [],
  stages: [
    { id: 'setup', needs: [], produces: [], requires: [], gates: [], invalidated_by: [], source: 'fixture:setup' },
    { id: 'face', needs: [], produces: [], requires: [], gates: [], invalidated_by: [], source: 'fixture:face' },
    { id: 'package', needs: [], produces: [], requires: [], gates: [], invalidated_by: [], source: 'fixture:package' },
  ], checks: [], gates: [], milestones: [],
};
function fixture(t: TestContext, withHeader = true) {
  const root = mkdtempSync(join(tmpdir(), 'avh-import-test-'));
  const project = join(root, `${syntheticOrder}_Test`);
  mkdirSync(join(project, 'ProjectSettings'), { recursive: true });
  mkdirSync(join(project, 'Packages'));
  mkdirSync(join(root, '_长程任务_test', '_归档'), { recursive: true });
  writeFileSync(join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  writeFileSync(join(project, 'Packages/vpm-manifest.json'), '{"locked":{"com.test":{"version":"1.2.3"}}}');
  writeFileSync(join(project, 'artifact.txt'), 'original');
  const header = withHeader ? `<!-- 状态头:BEGIN（测试） -->
## 当前状态
- **阶段 / 交付状态**：setup 完成
- **最近一步**：准备
- **下一步**：核对交付件
- **未决 / 等用户**：等确认
- **不许动**：无
<!-- 状态头:END -->\n` : '';
  writeFileSync(join(project, '_施工记录.md'), `${header}
## 2026-09-24 10:20 · setup（Claude）
- **做了什么**：已生成产物 \`artifact.txt\`
- **怎么验**：文件存在
- **结果**：✓ 完成
- **未决**：无

## 2026-09-24 11:20 · face（Claude）
- **做了什么**：本单无面捕
- **怎么验**：需求记录
- **结果**：不适用
- **未决**：无
`);
  writeFileSync(join(project, '_任务账本.md'), `# 待办
- [ ] T1 未做 — 负责：甲 — 依赖：无 — 验收：人工 — 来源：测试
  进展：待办
- [x] T2 已做 — 负责：甲 — 依赖：无 — 验收：人工 — 来源：测试
- [-] T3 受阻 — 负责：乙 — 依赖：T1 — 验收：人工 — 来源：测试
## 已拍板
`);
  writeFileSync(join(root, '_长程任务_test', '_归档', '停滞项_demo.md'),
    `# 已归档
- [-] X1 ${syntheticOrder}_Test 等人 — 负责：甲 — 依赖：无 — 验收：确认 — 来源：测试
- [x] X2 ${syntheticOrder}_Test 已完 — 负责：甲 — 依赖：无 — 验收：确认 — 来源：测试
`);
  const db = openDatabase(join(root, 'state.sqlite'));
  t.after(() => { db.close(); removeTemp(root); });
  return { root, project, db };
}
const missingTools = { toolRoot: '/synthetic/no-tools', stageRules: {
  setup: { verificationIds: ['fingerprint'] }, face: { notApplicablePatterns: ['本单无面捕'] },
} };

test('import reuses a GUI-created workspace identity and commits its observed report and archive facts', t => {
  const f = fixture(t);
  const workspaceId = 'gui-created-workspace-uuid';
  f.db.prepare('INSERT INTO workspace(id, path) VALUES (?, ?)').run(workspaceId, realpathSync(f.root));
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.equal(f.db.prepare('SELECT workspace_id FROM project WHERE id = ?').get(report.projectId)!.workspace_id, workspaceId);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM workspace').get()!.n, 1);
  assert.equal(getImportReport(f.db, report.id).snapshotHash, report.snapshotHash);
  assert.ok(Number(f.db.prepare('SELECT count(*) AS n FROM project_fact WHERE project_id = ?').get(report.projectId)!.n) > 0);
  assert.ok(Number(f.db.prepare('SELECT count(*) AS n FROM project_file_entry WHERE project_id = ?').get(report.projectId)!.n) > 0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('first import registers its workspace once and keeps that identity on later observations', t => {
  const f = fixture(t);
  const first = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  const id = f.db.prepare('SELECT workspace_id FROM project WHERE id = ?').get(first.projectId)!.workspace_id;
  assert.match(String(id), /^workspace:[0-9a-f]{64}$/);
  const second = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.equal(second.projectId, first.projectId);
  assert.equal(f.db.prepare('SELECT workspace_id FROM project WHERE id = ?').get(second.projectId)!.workspace_id, id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM workspace').get()!.n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM import_report').get()!.n, 2);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

function registeredProject(f: ReturnType<typeof fixture>, id: string, path: string, workspaceId: string): void {
  f.db.prepare(`INSERT INTO project (id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES (?,?,'client',?,'{}','active','existing-harness','existing-knowledge')`).run(id, workspaceId, path);
}

test('import preserves an existing absolute or relative GUI project identity, brief and linked workflow', t => {
  for (const absolute of [true, false]) {
    const f = fixture(t), workspaceId = 'gui-workspace', projectId = 'gui-project';
    f.db.prepare('INSERT INTO workspace(id,path) VALUES (?,?)').run(workspaceId, realpathSync(f.root));
    const storedPath = absolute ? realpathSync(f.project) : basename(f.project);
    registeredProject(f, projectId, storedPath, workspaceId);
    f.db.prepare(`INSERT INTO project_brief(project_id,intake_mode,customer_request,status)
      VALUES (?,'conversation','Original role goal','direction_approved')`).run(projectId);
    f.db.prepare(`INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json)
      VALUES ('existing-workflow',?,'synthetic','original-hash','original-knowledge','active','{}')`).run(projectId);
    const brief = f.db.prepare('SELECT * FROM project_brief WHERE project_id=?').get(projectId);
    const linked = f.db.prepare('SELECT * FROM workflow').get();
    const before = f.db.prepare('SELECT id,workspace_id,path,lifecycle,harness_version,knowledge_version FROM project').get();
    const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
    assert.equal(report.projectId, projectId);
    assert.equal(getImportReport(f.db, report.id).projectId, projectId);
    assert.equal(f.db.prepare('SELECT project_id FROM import_report WHERE id=?').get(report.id)!.project_id, projectId);
    assert.equal(f.db.prepare('SELECT count(*) n FROM project').get()!.n, 1);
    assert.deepEqual(f.db.prepare('SELECT id,workspace_id,path,lifecycle,harness_version,knowledge_version FROM project').get(), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM project_brief WHERE project_id=?').get(projectId), brief);
    assert.deepEqual(f.db.prepare('SELECT * FROM workflow').get(), linked);
    assert.ok(Number(f.db.prepare('SELECT count(*) n FROM project_fact WHERE project_id=?').get(projectId)!.n) > 0);
    assert.ok(Number(f.db.prepare('SELECT count(*) n FROM project_file_entry WHERE project_id=?').get(projectId)!.n) > 0);
    assert.equal(f.db.prepare(`SELECT json_extract(payload_json,'$.projectId') id FROM event WHERE entity_id=?`).get(report.id)!.id, projectId);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  }
});

test('import refuses ambiguous physical project identities without merging or committing observations', t => {
  const f = fixture(t), workspaceId = 'gui-workspace';
  f.db.prepare('INSERT INTO workspace(id,path) VALUES (?,?)').run(workspaceId, realpathSync(f.root));
  registeredProject(f, 'absolute-project', realpathSync(f.project), workspaceId);
  registeredProject(f, 'relative-project', basename(f.project), workspaceId);
  assert.throws(() => importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools }), /多个已登记身份/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM project').get()!.n, 2);
  for (const table of ['import_report', 'project_fact', 'project_file_entry', 'event'])
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('import refuses occupied deterministic workspace or project identities and rolls back', t => {
  for (const collision of ['workspace', 'project']) {
    const f = fixture(t), workspace = realpathSync(f.root), project = realpathSync(f.project);
    const workspaceId = collision === 'workspace' ? `workspace:${sha256(workspace)}` : 'existing-workspace';
    f.db.prepare('INSERT INTO workspace(id,path) VALUES (?,?)').run(workspaceId, collision === 'workspace' ? join(f.root, 'another-workspace') : workspace);
    if (collision === 'project') registeredProject(f, `project:${sha256(project)}`, join(f.root, 'another-project'), workspaceId);
    const beforeWorkspace = f.db.prepare('SELECT * FROM workspace').all(), beforeProjects = f.db.prepare('SELECT * FROM project').all();
    assert.throws(() => importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools }), /UNIQUE|另一位置占用/);
    assert.deepEqual(f.db.prepare('SELECT * FROM workspace').all(), beforeWorkspace);
    assert.deepEqual(f.db.prepare('SELECT * FROM project').all(), beforeProjects);
    for (const table of ['import_report', 'project_fact', 'project_file_entry', 'event'])
      assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n, 0);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  }
});

test('handoff keeps the requested section order and merges pending and blocking content', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_施工记录.md'), `<!-- 状态头:BEGIN -->
- **未决 / 等用户**：
  P1 等待确认 — 负责：用户
  H2 单独决定
<!-- 状态头:END -->\n`);
  writeFileSync(join(f.project, '_任务账本.md'), '- [ ] P1 等待确认 — 负责：用户\n- [ ] P2 另需确认 — 负责：客户\n');
  const dir = join(f.root, '_长程任务_test');
  writeFileSync(join(dir, '待用户复核_demo.md'), `| 编号 | 工程 | 问题 | 我选的 | 你的意见 |
| --- | --- | --- | --- | --- |
| 1 | ${basename(f.project)} | 普通问题 | A | |
| 2 ☆ | ${basename(f.project)} | 优先问题 | B | |`);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, decisionTables: [{ glob: '_长程任务_*/待用户复核_*.md', columns: {
      id: '编号', flag: '编号', project: '工程', question: '问题', choice: '我选的', answer: '你的意见',
    } }] } });
  const brief = handoffMarkdown(f.db, report.id);
  assert.deepEqual([...brief.matchAll(/^## (.+)$/gm)].map(match => match[1]), [
    '当前现状', '最近施工', '等你处理', '下一步建议', '未收结条目', '交付包', '只读复核',
    '阶段状态', '已拍板', '关联长程任务', '关联的跨工程条目（涉及本工程，但不是本单独有的任务）', '已关闭', '未解析记录',
  ]);
  assert.doesNotMatch(brief, /^## (?:待决的人机缺口|复核发现的问题)$/m);
  const pending = brief.split('## 等你处理')[1]!.split('## 下一步建议')[0]!;
  assert.deepEqual([...pending.matchAll(/^### (.+)$/gm)].map(match => match[1]),
    ['状态头：未决 / 等用户', '用户负责的未关闭条目', '等你先拍板', '决定表待复核']);
  assert.equal((pending.match(/^- P1 等待确认 — 负责：用户 /gm) ?? []).length, 1);
  assert.ok(pending.indexOf('H2 单独决定') < pending.indexOf('P2 另需确认'));
  assert.ok(pending.indexOf('☆ 2') < pending.indexOf('- 1；普通问题'));
  const review = brief.split('## 只读复核')[1]!.split('## 阶段状态')[0]!;
  assert.deepEqual([...review.matchAll(/^### (.+)$/gm)].map(match => match[1]), [
    '完整性问题', '工作副本的交付前清理项', '与工具链基准的差异', '记录里提到、现在不存在（可能已清理）',
  ]);
});

test('handoff truncates long ledger content while preserving sources and related projects', t => {
  const f = fixture(t); const other = `${otherSyntheticOrder}_Other`;
  writeFileSync(join(f.project, '_任务账本.md'), `- [ ] L1 ${'长'.repeat(260)} — 负责：甲\n  注记：${'注'.repeat(175)}\n`);
  writeFileSync(join(f.root, '_长程任务_test', '任务账本_协同.md'),
    `- [ ] R1 ${basename(f.project)} ${other} ${'跨'.repeat(180)}\n  最新注记不应出现\n`);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, knownProjects: { [other]: [other] } } });
  const brief = handoffMarkdown(f.db, report.id);
  const open = brief.split('## 未收结条目')[1]!.split('## 交付包')[0]!;
  const main = /^- \[open\] (.+?) （来源：_任务账本.md:1）$/m.exec(open)?.[1];
  const note = /^  - 最新注记：(.+?) （来源：_任务账本.md:2）$/m.exec(open)?.[1];
  assert.equal(Array.from(main ?? '').length, 240); assert.ok(main?.endsWith('…'));
  assert.equal(Array.from(note ?? '').length, 160); assert.ok(note?.endsWith('…'));
  const related = brief.split('## 关联的跨工程条目')[1]!.split('## 已关闭')[0]!;
  const line = /^- \[open\] (.+?)；涉及工程：(.+?) （来源：(.+?)）$/m.exec(related);
  assert.equal(Array.from(line?.[1] ?? '').length, 160); assert.ok(line?.[1]?.endsWith('…'));
  assert.match(line?.[2] ?? '', new RegExp(String.raw`${otherSyntheticOrder}_Other`));
  assert.match(line?.[3] ?? '', /任务账本_协同.md:1/);
  assert.doesNotMatch(related, /最新注记/);
});

test('imports identity, headed record, ledger statuses and archived open item; missing tools cannot verify', t => {
  const f = fixture(t);
  const before = snapshot(f.project, ['Library', 'Temp', 'Logs']);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.equal(report.identity.kind, 'client');
  assert.equal(report.identity.orderNumber, `${syntheticOrder}`);
  assert.equal(report.identity.unityVersion, '2022.3.22f1');
  assert.equal(report.identity.packages['com.test'], '1.2.3');
  assert.equal(report.stateHeader.fields['下一步'], '核对交付件');
  assert.equal(report.timeline.count, 2);
  assert.deepEqual(report.ledger.map(x => x.status), ['open', 'done', 'dropped']);
  assert.deepEqual(report.externalLedger.map(x => [x.id, x.status, x.archived]), [['X1', 'dropped', true], ['X2', 'done', true]]);
  assert.equal(report.reviews.find(x => x.id === 'fingerprint')?.status, 'not_run');
  assert.equal(report.reviews.find(x => x.id === 'vpm_baseline')?.status, 'not_run');
  assert.equal(report.stages.find(x => x.id === 'setup')?.status, 'claimed');
  assert.equal(report.stages.find(x => x.id === 'face')?.status, 'not_applicable');
  assert.equal(report.stages.find(x => x.id === 'package')?.status, 'unknown');
  assert.equal(snapshot(f.project, ['Library', 'Temp', 'Logs']).hash, before.hash);
  assert.equal(getImportReport(f.db, report.id).snapshotHash, before.hash);
  const a = handoffMarkdown(f.db, report.id);
  const b = handoffMarkdown(f.db, report.id);
  assert.equal(a, b);
  assert.match(a, /用户决定不做：2 条/);
  assert.doesNotMatch(a.split('## 未收结条目')[1]!.split('## 交付包')[0]!, /T3|X1/);
  assert.match(a, /## 下一步建议[\s\S]*来源：/);
  const nextSection = a.split('## 下一步建议\n\n')[1]!.split('## 未收结条目')[0]!;
  for (const line of nextSection.split('\n').filter(line => line.startsWith('- ') && line !== '- 无记录')) assert.match(line, /来源：/);
});

test('legacy record without state header remains parseable and stage stays conservative', t => {
  const f = fixture(t, false);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.deepEqual(report.stateHeader.fields, {});
  assert.equal(report.timeline.count, 2);
  assert.equal(report.stages.find(x => x.id === 'setup')?.status, 'claimed');
  assert.equal(report.stages.find(x => x.id === 'package')?.status, 'unknown');
});

test('explicit passing review upgrades only the mapped claimed stage', t => {
  const f = fixture(t);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, stageRules: { setup: { verificationIds: ['artifacts'] } } } });
  assert.equal(report.reviews.find(x => x.id === 'artifacts')?.status, 'pass');
  assert.equal(report.stages.find(x => x.id === 'setup')?.status, 'verified');
  assert.equal(report.stages.find(x => x.id === 'package')?.status, 'unknown');
});

test('configured external tools use frozen project baseline; global difference is informational', t => {
  const f = fixture(t);
  const tools = join(f.root, 'tools');
  mkdirSync(join(tools, '审查', 'perception'), { recursive: true });
  writeFileSync(join(tools, 'project_fingerprint.py'), 'import json,sys\njson.dump({"ok": True}, open(sys.argv[sys.argv.index("--out")+1], "w"))\n');
  writeFileSync(join(tools, 'vpm_baseline_check.py'), 'print("checked")\n');
  writeFileSync(join(tools, '审查', 'perception', 'strip_audit.py'), 'import json\nprint(json.dumps({"project":"synthetic","findings":[]}))\n');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { toolRoot: tools, packageBaseline: { 'com.test': '9.9.9' }, packageBaselineByProject: { [basename(f.project)]: { 'com.test': '1.2.3' } },
      stageRules: { setup: { verificationIds: ['fingerprint', 'vpm_baseline', 'artifacts'] } } } });
  assert.equal(report.reviews.find(x => x.id === 'fingerprint')?.status, 'pass');
  assert.equal(report.reviews.find(x => x.id === 'vpm_baseline')?.status, 'pass');
  assert.match(report.reviews.find(x => x.id === 'vpm_baseline')!.reason, /information only/);
  assert.equal(report.reviews.find(x => x.id === 'delivery_cleanup')?.status, 'pass');
  assert.equal(report.stages.find(x => x.id === 'setup')?.status, 'verified');
  assert.equal(report.stages.find(x => x.id === 'face')?.status, 'unknown');
  const mismatch = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { toolRoot: tools, packageBaselineByProject: { [basename(f.project)]: { 'com.test': '9.9.9' } } } });
  assert.equal(mismatch.reviews.find(x => x.id === 'vpm_baseline')?.status, 'fail');
});

test('snapshot change aborts import before any state write', t => {
  const f = fixture(t);
  assert.throws(() => importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: missingTools, beforeCommit: () => writeFileSync(join(f.project, 'artifact.txt'), 'changed') }), /Project changed during import/);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM import_report').get() as { n: number }).n, 0);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM project').get() as { n: number }).n, 0);
});

test('sparse file over 2 GiB has stable sampled fingerprint and detects head and tail edits',
  { skip: windows && 'NTFS makes a file sparse only through FSCTL_SET_SPARSE; writing its tail would fill 2 GiB' }, t => {
  const f = fixture(t);
  const path = join(f.project, 'oversized.bin');
  const size = 2 * 1024 * 1024 * 1024 + 1;
  const fd = openSync(path, 'w+');
  try { ftruncateSync(fd, size); } finally { closeSync(fd); }
  assert.ok(statSync(path).blocks * 512 < size / 1024, 'fixture must remain sparse');
  const first = snapshot(f.project, ['Library', 'Temp', 'Logs']);
  assert.deepEqual(first.sampledFiles, ['oversized.bin']);
  assert.match(first.files['oversized.bin']!, /^sampled:size=2147483649;mtimeNs=.+;ino=.+;headSha256=.+;tailSha256=.+$/);
  assert.deepEqual(snapshot(f.project, ['Library', 'Temp', 'Logs']), first);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.deepEqual(report.snapshotSampledFiles, ['oversized.bin']);
  assert.match(handoffMarkdown(f.db, report.id), /抽样指纹文件：oversized\.bin/);
  const edit = openSync(path, 'r+');
  try {
    writeSync(edit, Buffer.from([1]), 0, 1, 0);
    const head = snapshot(f.project, ['Library', 'Temp', 'Logs']);
    assert.notEqual(head.files['oversized.bin'], first.files['oversized.bin']);
    writeSync(edit, Buffer.from([1]), 0, 1, size - 1);
    const tail = snapshot(f.project, ['Library', 'Temp', 'Logs']);
    assert.notEqual(tail.files['oversized.bin'], head.files['oversized.bin']);
  } finally { closeSync(edit); }
});

test('unknown naming requires explicit kind; state database inside project is refused', t => {
  const f = fixture(t);
  const other = join(f.root, 'opaque');
  mkdirSync(join(other, 'ProjectSettings'), { recursive: true });
  writeFileSync(join(other, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 1');
  assert.throws(() => importProject(f.db, { workspacePath: f.root, projectPath: other, definition }), /provide kind/);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: other, definition, kind: 'private' });
  assert.equal(report.identity.kind, 'private');
  assert.equal(existsSync(join(other, '_施工记录.md')), false);
});

test('unstructured ledger keeps checkbox state and raw record fragments', () => {
  const item = parseLedger('- [ ] unclear entry\n  still raw', '_任务账本.md')[0]!;
  assert.equal(item.status, 'open');
  assert.equal(item.id, 'unknown-1');
  assert.deepEqual(parseLedger('- [x] X-01 done\n- [x] H-002-WP6b done', 'ledger.md').map(x => [x.id, x.status]),
    [['X-01', 'done'], ['H-002-WP6b', 'done']]);
  assert.match(item.raw, /still raw/);
  const record = parseRecord('<!-- 状态头:BEGIN broken\n## 2026-01-01 00:00 · ', '_施工记录.md', 3);
  assert.equal(record.timeline.count, 1);
  assert.equal(record.timeline.recent.length, 0);
  assert.match(record.unparsedRecords.map(x => x.detail).join('\n'), /原文/);
});

test('1 merges one ID across project, long ledger and archive; archive-only remains recovered', t => {
  const f = fixture(t);
  const long = join(f.root, '_长程任务_test', '任务账本_在制.md');
  const archive = join(f.root, '_长程任务_test', '_归档', '停滞项_demo.md');
  writeFileSync(long, `# 在制\n- [-] T1 ${basename(f.project)} 旧状态 — 负责：甲 — 依赖：无 — 验收：人工 — 来源：测试\n`);
  writeFileSync(archive, `# 归档\n- [-] T1 ${basename(f.project)} 更旧 — 负责：甲 — 依赖：无 — 验收：人工 — 来源：测试\n- [-] X1 ${basename(f.project)} 仅归档 — 负责：甲 — 依赖：无 — 验收：人工 — 来源：测试\n`);
  utimesSync(long, 100, 100); utimesSync(archive, 50, 50);
  utimesSync(join(f.project, '_任务账本.md'), 200, 200);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  const all = [...report.ledger, ...report.externalLedger];
  assert.equal(all.filter(x => x.id === 'T1').length, 1);
  assert.equal(all.find(x => x.id === 'T1')?.status, 'open');
  assert.equal(all.find(x => x.id === 'T1')?.archived, false);
  assert.equal(all.find(x => x.id === 'T1')?.sources.length, 3);
  assert.equal(all.find(x => x.id === 'X1')?.archived, true);
  const brief = handoffMarkdown(f.db, report.id);
  assert.equal((brief.match(/\[open\] T1/g) ?? []).length, 1);
  assert.match(brief, /用户决定不做：2 条/);
  const fragments = mergeLedger(parseLedger('- [ ] unclear', 'local.md'), parseLedger('- [ ] unrelated', 'external.md'));
  assert.equal(fragments.ledger.length + fragments.externalLedger.length, 2);
  const newer = mergeLedger(
    parseLedger('- [ ] T9 current — 负责：甲', 'local.md', false, 100),
    parseLedger('- [-] T9 later — 负责：甲', 'archive.md', true, 200));
  assert.equal(newer.ledger[0]?.status, 'dropped');
  assert.equal(newer.ledger[0]?.archived, false);
});

test('2 checks path-like artifacts and leaves object names out; unresolved path is unknown', t => {
  const f = fixture(t);
  const file = join(f.project, 'Assets', 'Avatar.prefab');
  mkdirSync(join(f.project, 'Assets')); writeFileSync(file, 'prefab');
  const record = { file: '_施工记录.md', text: '已生成 `cardigan_OFF` `t4_menu_fixed` `Assets/Avatar.prefab`\n已输出 `Assets/Missing.prefab`' };
  const claims = collectArtifactClaims(f.project, record, DEFAULT_IMPORT_CONFIG);
  assert.deepEqual(claims.map(x => x.path), ['Assets/Avatar.prefab', 'Assets/Missing.prefab']);
  writeFileSync(join(f.project, '_施工记录.md'), record.text);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.equal(report.reviews.find(x => x.id === 'artifacts')?.status, 'unknown');
  assert.doesNotMatch(report.reviews.find(x => x.id === 'artifacts')!.reason, /cardigan_OFF|t4_menu_fixed/);
});

test('3 parses timed and date-only timeline fields; malformed entry stays out of human gaps', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_施工记录.md'), `## 2026-09-18 · 老格式\n- 执行：Claude\n- 改了：菜单\n- 怎么验 / 结果：ASSERT PASS\n- 未决：无\n\n## 2026-09-19 10:20 · 新格式（Claude）\n- **做了什么**：菜单\n- **结果**：通过\n\n## 2026-09-20 · \n- 结果：坏标题\n`);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.equal(report.timeline.count, 3);
  assert.equal(report.timeline.recent.length, 2);
  assert.equal(report.timeline.recent[0]?.fields['执行'], 'Claude');
  assert.equal(report.timeline.recent[0]?.actor, 'Claude');
  assert.equal(report.timeline.recent[0]?.fields['怎么验 / 结果'], 'ASSERT PASS');
  assert.equal(report.timeline.recent[1]?.fields['结果'], '通过');
  assert.equal(report.unparsedRecords.length, 1);
  assert.equal(report.gaps.some(x => /坏标题/.test(x.detail)), false);
  const brief = handoffMarkdown(f.db, report.id);
  assert.match(brief.split('## 未解析记录')[1]!, /坏标题/);
  assert.doesNotMatch(brief.split('## 等你处理')[1]!.split('## 下一步建议')[0]!, /坏标题/);
});

test('4 first git manifest is the frozen baseline; a changed project lock fails', t => {
  const f = fixture(t);
  const git = (args: string[]) => execFileSync('git', ['-C', f.project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']); git(['add', 'Packages/vpm-manifest.json']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial']);
  const tools = join(f.root, 'tools'); mkdirSync(tools);
  writeFileSync(join(tools, 'vpm_baseline_check.py'), 'print("checked")\n');
  const pass = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { toolRoot: tools, packageBaseline: { 'com.test': '9.9.9' } } });
  assert.equal(pass.reviews.find(x => x.id === 'vpm_baseline')?.status, 'pass');
  writeFileSync(join(f.project, 'Packages/vpm-manifest.json'), '{"locked":{"com.test":{"version":"2.0.0"}}}');
  const fail = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: { toolRoot: tools } });
  assert.equal(fail.reviews.find(x => x.id === 'vpm_baseline')?.status, 'fail');
});

test('5 archive under export root is tested; missing archive lists searched roots', t => {
  const f = fixture(t);
  const root = join(f.root, 'exports'); const folder = join(root, '个人存档'); mkdirSync(folder, { recursive: true });
  const archive = join(folder, 'Example_归档_20260924.7z');
  execFileSync(hostPlatform.toolCommand('7z'), ['a', '-bd', archive, join(f.project, 'artifact.txt')], { stdio: 'ignore' });
  writeFileSync(join(f.project, '_施工记录.md'), '已打包 `个人存档/Example_归档_20260924.7z`');
  const pass = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, exportRoots: [root] } });
  assert.equal(pass.reviews.find(x => x.id === 'delivery_archives')?.status, 'pass');
  const limited = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, exportRoots: [root], maxDeliveryArchiveBytes: 1 } });
  assert.equal(limited.reviews.find(x => x.id === 'delivery_archives')?.status, 'not_run');
  assert.match(limited.reviews.find(x => x.id === 'delivery_archives')!.reason, /exceeds configured limit.*7z t skipped/);
  writeFileSync(join(f.project, '_施工记录.md'), '已打包 `Example_不存在.zip`');
  const fail = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, exportRoots: [root] } });
  assert.equal(fail.reviews.find(x => x.id === 'delivery_archives')?.status, 'unknown');
  assert.match(handoffMarkdown(f.db, fail.id), /记录里提到、现在不存在（可能已清理）/);
});

test('5a inner ZIP member follows tested outer delivery archive', t => {
  const f = fixture(t);
  const exports = join(f.root, 'exports'); mkdirSync(exports);
  const inner = join(exports, 'Example_Unity工程.zip');
  const outer = join(exports, 'Example_交付总包.zip');
  execFileSync(hostPlatform.toolCommand('7z'), ['a', '-bd', inner, join(f.project, 'artifact.txt')], { stdio: 'ignore' });
  execFileSync(hostPlatform.toolCommand('7z'), ['a', '-bd', outer, inner], { stdio: 'ignore' });
  unlinkSync(inner);
  writeFileSync(join(f.project, '_施工记录.md'), '已打包 `Example_交付总包.zip`，内含 `Example_Unity工程.zip`');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, exportRoots: [exports] } });
  const delivery = report.reviews.find(x => x.id === 'delivery_archives')!;
  assert.equal(delivery.status, 'pass');
  assert.match(delivery.reason, /Example_Unity工程\.zip: 在 Example_交付总包\.zip 内; pass/);
  assert.equal(report.reviews.find(x => x.id === 'artifacts')?.status, 'pass');
  assert.match(report.reviews.find(x => x.id === 'artifacts')!.evidence.map(x => x.detail).join('\n'), /Example_Unity工程\.zip 在 Example_交付总包\.zip 内/);
  const limited = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, exportRoots: [exports], maxDeliveryArchiveBytes: 1 } });
  assert.equal(limited.reviews.find(x => x.id === 'delivery_archives')?.status, 'not_run');
  assert.match(limited.reviews.find(x => x.id === 'delivery_archives')!.reason, /Example_Unity工程\.zip: 在 Example_交付总包\.zip 内; not_run/);
  assert.equal(limited.reviews.find(x => x.id === 'artifacts')?.status, 'not_run');
});

test('5b spaced export root keeps whole path and tests each resolved archive once', t => {
  const f = fixture(t);
  const exports = join(f.root, 'VCC Projects'); mkdirSync(exports);
  const archive = join(exports, 'Example_交付总包.zip');
  execFileSync(hostPlatform.toolCommand('7z'), ['a', '-bd', archive, join(f.project, 'artifact.txt')], { stdio: 'ignore' });
  const record = `已打包 “${archive}”，另记 ${archive}`;
  const claims = collectArtifactClaims(f.project, { text: record, file: '_施工记录.md' },
    { ...DEFAULT_IMPORT_CONFIG, artifactPathPrefixes: [`${exports}${sep}`] });
  assert.deepEqual(claims.map(x => x.path), [archive]);
  writeFileSync(join(f.project, '_施工记录.md'), record);
  const bin = join(f.root, 'bin'); mkdirSync(bin);
  const log = join(f.root, '7z-calls.txt');
  const real7z = hostPlatform.toolCommand('7z');
  fakeCommand(join(bin, '7z'), `const { appendFileSync } = require('node:fs');\nconst { spawnSync } = require('node:child_process');\nif (process.argv[2] === 't') appendFileSync(${JSON.stringify(log)}, 't\\n');\nconst result = spawnSync(${JSON.stringify(real7z)}, process.argv.slice(2), { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);`);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, exportRoots: [exports], artifactPathPrefixes: [`${exports}${sep}`], deliveryArchives: ['Example_交付总包.zip'] } });
  assert.equal(report.reviews.find(x => x.id === 'delivery_archives')?.status, 'pass');
  assert.equal(readFileSync(log, 'utf8'), 't\n');
});

test('6 stage never claims without a rule; explicit rule can claim it', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_施工记录.md'), '## 2026-09-18 · menu（Claude）\n- 结果：菜单开关补齐 ASSERT PASS');
  const process = { ...definition, stages: [{ ...definition.stages[0]!, id: 'menu' }] };
  const noRule = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition: process, config: { toolRoot: '/synthetic/no-tools' } });
  assert.equal(noRule.stages[0]?.status, 'unknown');
  const withRule = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition: process,
    config: { toolRoot: '/synthetic/no-tools', stageRules: { menu: { claimPatterns: ['menu'] } } } });
  assert.equal(withRule.stages[0]?.status, 'claimed');
});

test('7 known bodies use construction record and asset paths; absent names remain unknown', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_建档.md'), '素体：BodyAlpha');
  writeFileSync(join(f.project, '_施工记录.md'), '## 2026-09-18 · 设定\n- 改了：BodyBeta；BodyAlphabet 只是别名');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, knownBodies: ['BodyAlpha', 'BodyBeta', 'BodyAlphabet', 'BodyAlph', 'BodyGamma'] } });
  assert.equal(report.identity.base, '最可能：BodyBeta（1 次）；其他候选：BodyAlphabet（1 次）');
  const absent = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, knownBodies: ['BodyGamma'] } });
  assert.equal(absent.identity.base, undefined);
});

test('7a body ranking uses counts and excludes weak candidates', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_建档.md'), '素体：BodyDossier，服装兼容 BodyHeader');
  writeFileSync(join(f.project, '_施工记录.md'), `<!-- 状态头:BEGIN -->\n- **素体**：BodyHeader\n<!-- 状态头:END -->\n已输出 BodyFrequent BodyFrequent BodyFrequent BodyFrequent\n已输出 BodyDossier BodyDossier\n已输出 BodyOther BodyOther\n已输出 BodyLast`);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, knownBodies: ['BodyLast', 'BodyOther', 'BodyFrequent', 'BodyDossier', 'BodyHeader'] } });
  assert.equal(report.identity.base, '最可能：BodyFrequent（4 次）；其他候选：BodyOther（2 次）、BodyDossier（2 次）');
  assert.match(handoffMarkdown(f.db, report.id), /素体：最可能：BodyFrequent（4 次）/);
});

test('WP8 state header, recent work, stale warning, next step and compact stage table', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_施工记录.md'), `<!-- 状态头:BEGIN -->
## 当前状态（2026-09-23 08:30）
- **阶段 / 交付状态**：已交付待重交
- **最近一步**：完成初包
- **下一步**：复核包
  - 通知用户
- **未决 / 等用户**：
  - 等用户确认
- **不许动**：原始素材
<!-- 状态头:END -->
## 2026-09-24 09:00 · 打包（执行甲）
- 结果：通过
## 2026-09-25 10:00 · 复核（执行乙）
- 结果：需修
`);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  const brief = handoffMarkdown(f.db, report.id);
  assert.match(brief, /状态头时间：2026-09-23 08:30/);
  for (const phrase of ['已交付待重交', '完成初包', '复核包', '通知用户', '等用户确认', '原始素材', '执行甲', '执行乙', '状态头可能过时']) assert.ok(brief.includes(phrase), phrase);
  assert.equal(report.timeline.recent.length, 2);
  assert.deepEqual(report.nextSteps.map(x => x.detail), ['复核包', '通知用户']);
  assert.doesNotMatch(brief, /核实阶段/);
  assert.match(brief, /其余 \d+ 个阶段 \| unknown/);
  assert.doesNotMatch(brief.split('## 阶段状态')[1]!.split('## 已拍板')[0]!, /\| package \| unknown/);
});

test('WP8 ledger ownership uses only main line and separates multi-project entries', t => {
  const f = fixture(t);
  const other = `${otherSyntheticOrder}_Other`;
  const long = join(f.root, '_长程任务_test', '任务账本_归属.md');
  writeFileSync(long, `- [ ] E1 ${other} 独立 — 负责：用户
  核对：${basename(f.project)} 已验
- [ ] E2 ${other} 独立 — 负责：用户
<a id="${basename(f.project)}"></a>
- [ ] E3 ${other} 独立 — 负责：用户
- [~] E4 ${basename(f.project)} 与 ${other} 协同 — 负责：甲
  进展：第一次
  恢复：最新进展
- [ ] E5 TestAliasX 无关 — 负责：甲
- [ ] E6 TestAlias 本单 — 负责：甲
`);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, projectAliases: ['TestAlias'], knownProjects: { [other]: [other] } } });
  assert.deepEqual(report.externalLedger.map(x => x.id).sort(), ['E6', 'X1', 'X2']);
  assert.deepEqual(report.relatedLedger?.map(x => x.id), ['E4']);
  assert.equal(report.relatedLedger?.[0]?.status, 'in_progress');
  const brief = handoffMarkdown(f.db, report.id);
  assert.match(brief, new RegExp(String.raw`关联的跨工程条目[\s\S]*E4.*${otherSyntheticOrder}_Other`));
  assert.doesNotMatch(brief.split('## 关联的跨工程条目')[1]!.split('## 已关闭')[0]!, /最新注记/);
  assert.doesNotMatch(brief, /\bE[1235]\b/);
});

test('WP8 dropped and in-progress statuses, user gaps and fallback steps', t => {
  const f = fixture(t, false);
  writeFileSync(join(f.project, '_任务账本.md'), `- [-] D1 放弃 — 负责：用户
- [~] P1 正在做 — 负责：用户
  核对：尚待确认
- [ ] O1 待办 — 负责：甲
`);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.deepEqual(report.ledger.map(x => x.status), ['dropped', 'in_progress', 'open']);
  assert.deepEqual(report.nextSteps.map(x => x.detail), report.ledger.slice(1).map(x => x.text));
  assert.deepEqual(report.gaps.map(x => x.detail), [report.ledger[1]!.text]);
  assert.equal(report.blockers.some(x => /D1/.test(x.detail)), false);
  const brief = handoffMarkdown(f.db, report.id);
  assert.match(brief, /最新注记：核对：尚待确认/);
  assert.doesNotMatch(brief.split('## 下一步建议')[1]!.split('## 未收结条目')[0]!, /D1/);
});

test('WP8 cleanup nonzero JSON stays informational and toolchain versions are listed', t => {
  const f = fixture(t);
  const tools = join(f.root, 'tools'); mkdirSync(join(tools, '审查', 'perception'), { recursive: true });
  writeFileSync(join(tools, '审查', 'perception', 'strip_audit.py'),
    'import json\nprint(json.dumps({"project":"synthetic","findings":[{"path":"Assets/AvatarAudit","strip":True,"status":"present"}]}, indent=2))\nraise SystemExit(1)\n');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { toolRoot: tools, packageBaseline: { 'com.test': '9.9.9' } } });
  assert.equal(report.reviews.find(x => x.id === 'delivery_cleanup')?.status, 'fail');
  assert.equal(report.blockers.some(x => /delivery_cleanup/.test(x.detail)), false);
  const brief = handoffMarkdown(f.db, report.id);
  assert.match(brief, /交付前清理项[\s\S]*Assets\/AvatarAudit/);
  assert.match(brief, /com\.test: locked=1\.2\.3, toolchain=9\.9\.9/);
  assert.doesNotMatch(brief, /Command failed|"findings"/);
});

test('WP8 discovers order-number archive and strips fullwidth notes from artifact claims', t => {
  const f = fixture(t);
  const exports = join(f.root, 'exports'); mkdirSync(exports);
  const archive = join(exports, `${syntheticOrder}_交付.zip`);
  execFileSync(hostPlatform.toolCommand('7z'), ['a', '-bd', archive, join(f.project, 'artifact.txt')], { stdio: 'ignore' });
  writeFileSync(join(f.project, '_施工记录.md'), '已输出 `Assets/Missing.prefab（临时探针）`；已生成 `artifact.txt`');
  const claims = collectArtifactClaims(f.project, { text: readFileSync(join(f.project, '_施工记录.md'), 'utf8'), file: '_施工记录.md' }, DEFAULT_IMPORT_CONFIG);
  assert.equal(claims[0]?.path, 'Assets/Missing.prefab');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, exportRoots: [exports] } });
  const delivery = report.reviews.find(x => x.id === 'delivery_archives')!;
  assert.equal(delivery.status, 'pass');
  assert.equal(delivery.archiveDetails?.[0]?.path, archive);
  const brief = handoffMarkdown(f.db, report.id);
  assert.match(brief, /7z t：pass/);
  assert.match(brief, /记录里提到、现在不存在（可能已清理）[\s\S]*Assets\/Missing\.prefab/);
  assert.doesNotMatch(brief.split('### 完整性问题')[1]!.split('### 工作副本的交付前清理项')[0]!, /Missing\.prefab/);
  // A computer without 7-Zip: nothing on PATH, and on Windows nothing where its installer puts it either.
  const saved = { PATH: process.env.PATH, ProgramFiles: process.env.ProgramFiles, 'ProgramFiles(x86)': process.env['ProgramFiles(x86)'] };
  for (const name of Object.keys(saved)) process.env[name] = join(f.root, 'no-executables');
  try {
    const without7z = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
      config: { ...missingTools, exportRoots: [exports] } });
    assert.equal(without7z.reviews.find(x => x.id === 'delivery_archives')?.status, 'not_run');
    assert.match(handoffMarkdown(f.db, without7z.id), /7z unavailable/);
  } finally { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

test('WP8b private body is certain; record frequency suppresses incidental bodies', t => {
  const f = fixture(t);
  const named = join(f.root, 'Nick_BodyAlpha_20260926');
  mkdirSync(join(named, 'ProjectSettings'), { recursive: true });
  writeFileSync(join(named, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 1');
  const direct = importProject(f.db, { workspacePath: f.root, projectPath: named, definition,
    config: { ...missingTools, knownBodies: ['BodyAlpha', 'BodyBeta'] } });
  assert.equal(direct.identity.base, 'BodyAlpha');
  writeFileSync(join(f.project, '_施工记录.md'), `BodyAlpha `.repeat(10) + 'BodyBeta BodyGamma');
  const ranked = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, knownBodies: ['BodyAlpha', 'BodyBeta', 'BodyGamma'] } });
  assert.equal(ranked.identity.base, '最可能：BodyAlpha（10 次）');
});

test('WP8b body evidence includes project asset paths', t => {
  const f = fixture(t); const assets = join(f.project, 'Assets'); mkdirSync(assets);
  writeFileSync(join(assets, 'BodyAlpha.prefab'), 'synthetic');
  writeFileSync(join(f.project, '_施工记录.md'), 'BodyBeta');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, knownBodies: ['BodyAlpha', 'BodyBeta'] } });
  assert.equal(report.identity.base, '最可能：BodyAlpha（1 次）；其他候选：BodyBeta（1 次）');
});

test('WP8b decision table reads mapped columns, only pending own rows, and star first', t => {
  const f = fixture(t); const dir = join(f.root, '_长程任务_test');
  writeFileSync(join(dir, '待用户复核_demo.md'), `| 编号 | 时间 | 工程 | 问题 | 我选的 | 你的意见 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | 09-22 | ${syntheticOrder}_Test | 已答 | A | 同意 |\n| 2 ☆ | 09-23 | ${syntheticOrder}_Test | 待答 | B |  |\n| 3 | 09-24 | ${otherSyntheticOrder}_Other | 别单 | C |  |`);
  const config = { ...missingTools, decisionTables: [{ glob: '_长程任务_*/待用户复核_*.md', columns:
    { id: '编号', time: '时间', flag: '编号', project: '工程', question: '问题', choice: '我选的', answer: '你的意见' } }] };
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config });
  assert.deepEqual(report.pendingDecisions?.map(x => [x.id, x.starred]), [['2', true]]);
  const section = handoffMarkdown(f.db, report.id).split('## 等你处理')[1]!.split('## 下一步建议')[0]!;
  assert.match(section, /☆ 2；09-23；待答；已代选：B.*待用户复核_demo.md:4/);
  assert.doesNotMatch(section, /已答|别单/);
  writeFileSync(join(dir, '待用户复核_demo.md'), readFileSync(join(dir, '待用户复核_demo.md'), 'utf8') + `\n| 4 | 09-25 | ${syntheticOrder}_Test | 普通待答 | D |  |`);
  const ordered = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config });
  assert.deepEqual(ordered.pendingDecisions?.map(x => x.id), ['2', '4']);
  const without = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.deepEqual(without.pendingDecisions, []);
});

test('WP8b reconciles closed ledger ID, retains constraint, and adds timeline decision', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_施工记录.md'), `<!-- 状态头:BEGIN -->\n- **下一步**：F-01 清理\n- **未决 / 等用户**：无\n- **不许动**：原始素材\n<!-- 状态头:END -->\n## 2026-09-25 12:00 · 用户拍板：保留原色（Claude）\n- **结果**：已记录`);
  writeFileSync(join(f.project, '_任务账本.md'), '- [x] F-01 清理完成\n');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.deepEqual(report.blockers, []);
  const brief = handoffMarkdown(f.db, report.id);
  assert.match(brief, /F-01 清理（账本：已完成 @_任务账本.md:1）/);
  assert.match(brief, /状态头有 1 处落后于账本/);
  assert.match(brief.split('## 已拍板')[1]!.split('## 关联长程任务')[0]!, /用户拍板：保留原色.*_施工记录.md:6/);
  assert.doesNotMatch(brief.split('### 完整性问题')[1]!.split('### 工作副本的交付前清理项')[0]!, /原始素材/);
});

test('WP8b related program uses task text and state header, excluding unrelated program', t => {
  const f = fixture(t); const dir = join(f.root, '_长程任务_test');
  writeFileSync(join(dir, '任务书.md'), `目标：${syntheticOrder}_Test`);
  writeFileSync(join(dir, '_施工记录.md'), `<!-- 状态头:BEGIN -->\n## 当前状态（2026-09-25 15:00）\n- **阶段 / 交付状态**：验收中\n- **最近一步**：已检查\n<!-- 状态头:END -->`);
  const other = join(f.root, '_长程任务_other'); mkdirSync(other);
  writeFileSync(join(other, '任务书.md'), `目标：${otherSyntheticOrder}_Other`);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  const section = handoffMarkdown(f.db, report.id).split('## 关联长程任务')[1]!.split('## 关联的跨工程条目')[0]!;
  assert.match(section, /_长程任务_test.*验收中.*已检查.*2026-09-25 15:00[\s\S]*本工程提及 1 次.*_长程任务_test\/任务书\.md/);
  assert.doesNotMatch(section, /_长程任务_other/);
});

test('WP8b 7z summary extracts counts and final ERROR without output tail', t => {
  const f = fixture(t); const bin = join(f.root, 'bin'); mkdirSync(bin);
  const archive = join(f.project, 'delivery.zip'); writeFileSync(archive, 'synthetic');
  const script = join(bin, '7z'); const originalPath = process.env.PATH;
  const config = { ...missingTools, deliveryArchives: ['delivery.zip'] };
  try {
    fakeCommand(script, "if (process.argv[2] === 't') process.stdout.write('Files: 4\\nSize: 12345\\nraw trailing noise\\n');");
    process.env.PATH = `${bin}${delimiter}${originalPath}`;
    const pass = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config });
    const reason = pass.reviews.find(x => x.id === 'delivery_archives')!.archiveDetails![0]!.reason;
    assert.equal(reason, '7z t 通过；文件数：4；大小：12345 B');
    assert.doesNotMatch(reason, /raw trailing/);
    fakeCommand(script, "if (process.argv[2] === 't') { process.stdout.write('ERROR: first\\nERROR: final\\n'); process.exit(7); }");
    const fail = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config });
    assert.match(fail.reviews.find(x => x.id === 'delivery_archives')!.archiveDetails![0]!.reason, /退出码 7.*ERROR: final/);
  } finally { process.env.PATH = originalPath; }
});

test('WP8c 1 related ledger lists only open entries and counts closed entries', t => {
  const f = fixture(t); const other = `${otherSyntheticOrder}_Other`;
  writeFileSync(join(f.root, '_长程任务_test', '任务账本_协同.md'),
    `- [ ] R1 ${basename(f.project)} ${other} 待办\n- [x] R2 ${basename(f.project)} ${other} 完成\n- [-] R3 ${basename(f.project)} ${other} 不做\n`);
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, knownProjects: { [other]: [other] } } });
  const section = handoffMarkdown(f.db, report.id).split('## 关联的跨工程条目')[1]!.split('## 已关闭')[0]!;
  assert.match(section, /R1/); assert.doesNotMatch(section, /R2|R3/);
  assert.match(section, /另有 2 条已关闭/);
});

test('WP8c 2 stale header compares git commit at minute precision', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_施工记录.md'), '<!-- 状态头:BEGIN -->\n## 当前状态（2026-09-25 12:00）\n<!-- 状态头:END -->');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.project, stdio: 'ignore' });
  git('init'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@example.invalid');
  const commit = (time: string) => {
    git('add', '.');
    execFileSync('git', ['commit', '-m', 'synthetic'], { cwd: f.project, stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_DATE: time, GIT_COMMITTER_DATE: time } });
  };
  commit('2026-09-25T12:00:30+12:00');
  const sameMinute = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.doesNotMatch(handoffMarkdown(f.db, sameMinute.id), /状态头可能过时/);
  writeFileSync(join(f.project, 'later.txt'), 'synthetic'); commit('2026-09-25T12:01:00+12:00');
  const later = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.match(handoffMarkdown(f.db, later.id), /状态头可能过时/);
});

test('WP8c 3 timeline actor is final fullwidth parentheses group', () => {
  const parsed = parseRecord('## 2026-09-25 12:00 · 菜单补齐（Claude子代理）（Claude）\n- 结果：完成', 'record.md', 3);
  assert.equal(parsed.timeline.recent[0]?.title, '菜单补齐（Claude子代理）');
  assert.equal(parsed.timeline.recent[0]?.actor, 'Claude');
});

test('WP8c 4 archive modification time uses local YYYY-MM-DD HH:MM', t => {
  const f = fixture(t); const archive = join(f.project, 'delivery.zip'); writeFileSync(archive, 'synthetic');
  utimesSync(archive, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  const oldZone = process.env.TZ; process.env.TZ = 'Pacific/Auckland';
  try {
    const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
      config: { ...missingTools, deliveryArchives: ['delivery.zip'] } });
    assert.equal(report.reviews.find(x => x.id === 'delivery_archives')?.archiveDetails?.[0]?.modified, '2026-01-01 13:00');
    assert.match(handoffMarkdown(f.db, report.id), /修改时间：2026-01-01 13:00/);
  } finally { if (oldZone === undefined) delete process.env.TZ; else process.env.TZ = oldZone; }
});

test('WP8c 5 review table uses cleanup and toolchain display labels without changing JSON status', t => {
  const f = fixture(t); const tools = join(f.root, 'tools'); mkdirSync(join(tools, '审查', 'perception'), { recursive: true });
  writeFileSync(join(tools, '审查', 'perception', 'strip_audit.py'),
    'import json\nprint(json.dumps({"project":"synthetic","findings":[{"path":"Assets/Cleanup","strip":True,"status":"present"}]}))\n');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, toolRoot: tools, packageBaseline: { 'com.test': '2.0.0' } } });
  assert.equal(report.reviews.find(x => x.id === 'delivery_cleanup')?.status, 'fail');
  assert.equal(report.reviews.find(x => x.id === 'toolchain_baseline')?.status, 'pass');
  const table = handoffMarkdown(f.db, report.id).split('## 只读复核')[1]!.split('### 完整性问题')[0]!;
  assert.match(table, /\| delivery_cleanup \| 待清理（1 项） \|/);
  assert.match(table, /\| toolchain_baseline \| 有差异（1 项） \|/);
  assert.doesNotMatch(table, /\| (?:delivery_cleanup|toolchain_baseline) \| (?:fail|pass) \|/);
  writeFileSync(join(tools, '审查', 'perception', 'strip_audit.py'),
    'import json\nprint(json.dumps({"project":"synthetic","findings":[]}))\n');
  const clean = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, toolRoot: tools, packageBaseline: { 'com.test': '1.2.3' } } });
  const cleanTable = handoffMarkdown(f.db, clean.id).split('## 只读复核')[1]!.split('### 完整性问题')[0]!;
  assert.match(cleanTable, /\| delivery_cleanup \| 无残留 \|/);
  assert.match(cleanTable, /\| toolchain_baseline \| 一致 \|/);
});

test('WP8c 6 toolchain lists only project packages and counts unused baseline packages', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, 'Packages/vpm-manifest.json'), '{"locked":{"com.test":{"version":"1.2.3"},"com.extra":{"version":"3"}}}');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, packageBaseline: { 'com.test': '9', 'com.unused': '1' } } });
  const review = report.reviews.find(x => x.id === 'toolchain_baseline')!;
  assert.equal(review.evidence.length, 2);
  assert.match(review.reason, /com\.extra: locked=3, toolchain=missing/);
  assert.match(review.reason, /com\.test: locked=1\.2\.3, toolchain=9/);
  assert.match(review.reason, /基准中本工程未用：1 项/);
  assert.doesNotMatch(review.reason, /com\.unused/);
});

test('WP8c 7 document patterns claim weak stage evidence, capped at three', t => {
  const f = fixture(t);
  for (const name of ['装配报告甲.md', '装配报告乙.md', '装配报告丙.md', '装配报告丁.md']) writeFileSync(join(f.project, name), 'synthetic');
  mkdirSync(join(f.project, '_捏脸甲'));
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, stageRules: { package: { documentPatterns: ['装配报告*.md', '_捏脸*/'], verificationIds: ['artifacts'] } } } });
  const stage = report.stages.find(x => x.id === 'package')!;
  assert.equal(report.reviews.find(x => x.id === 'artifacts')?.status, 'pass');
  assert.equal(stage.status, 'claimed'); assert.equal(stage.weakEvidence, true); assert.equal(stage.evidence.length, 3);
  assert.match(handoffMarkdown(f.db, report.id), /\| package \| 文档存在（弱证据） \|/);
  assert.match(stage.evidence[0]!.detail, /^文档存在：.*（\d{4}-\d\d-\d\d \d\d:\d\d）$/);
  assert.equal(report.stages.find(x => x.id === 'face')?.status, 'unknown');
  const directory = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, stageRules: { package: { documentPatterns: ['_捏脸*/'] } } } });
  assert.match(directory.stages.find(x => x.id === 'package')!.evidence[0]!.detail, /文档存在：_捏脸甲（/);
});

test('WP8c 8 brace paths expand once before artifact resolution', t => {
  const f = fixture(t); mkdirSync(join(f.project, 'Assets'));
  writeFileSync(join(f.project, 'Assets', 'x.json'), '{}'); writeFileSync(join(f.project, 'Assets', 'y.json'), '{}');
  writeFileSync(join(f.project, '_施工记录.md'), '已生成 `Assets/{x,y}.json`');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.deepEqual(collectArtifactClaims(f.project, { text: '已生成 `Assets/{x,y}.json`', file: 'record.md' }, DEFAULT_IMPORT_CONFIG)
    .map(x => x.path), ['Assets/x.json', 'Assets/y.json']);
  assert.deepEqual(collectArtifactClaims(f.project, { text: '已生成 Assets/{x,y}.json', file: 'record.md' }, DEFAULT_IMPORT_CONFIG)
    .map(x => x.path), ['Assets/x.json', 'Assets/y.json']);
  assert.deepEqual(collectArtifactClaims(f.project, { text: '已生成 `Assets/{1..2}.json`', file: 'record.md' }, DEFAULT_IMPORT_CONFIG)
    .map(x => x.path), ['Assets/{1..2}.json']);
  assert.equal(report.reviews.find(x => x.id === 'artifacts')?.status, 'pass');
  assert.equal(report.reviews.find(x => x.id === 'artifacts')?.evidence.length, 2);
});

test('WP8c 9 existing source marker is not appended again', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_施工记录.md'), '<!-- 状态头:BEGIN -->\n- **下一步**：核对（来源：原记录:7）\n<!-- 状态头:END -->');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  const section = handoffMarkdown(f.db, report.id).split('## 下一步建议')[1]!.split('## 未收结条目')[0]!;
  assert.match(section, /核对（来源：原记录:7）/);
  assert.equal((section.match(/来源：/g) ?? []).length, 1);
});

test('H-002 imports pending user page and expands configured alias group', t => {
  const f = fixture(t); const own = basename(f.project);
  writeFileSync(join(f.root, '_长程任务_test', '待问用户.md'), `- [ ] Q-01 ${own} 请用户确认 — 负责：用户\n`);
  writeFileSync(join(f.root, '_长程任务_test', '账本_三单.md'), '- [ ] G-01 三单共同复核 — 负责：执行\n');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, aliasGroups: { 三单: [own, 'ProjectB', 'ProjectC'] } } });
  const brief = handoffMarkdown(f.db, report.id);
  assert.match(brief.split('## 等你处理')[1]!.split('## 下一步建议')[0]!, /Q-01.*负责：用户/);
  assert.match(brief.split('## 关联的跨工程条目')[1]!.split('## 已关闭')[0]!,
    new RegExp(String.raw`G-01.*涉及工程：.*${syntheticOrder}_Test.*ProjectB.*ProjectC`));
  assert.deepEqual(report.relatedLedger?.find(item => item.id === 'G-01')?.relatedProjects, [own, 'ProjectB', 'ProjectC']);
});

test('H-002 group names expand only when the main line names no known project', t => {
  const f = fixture(t); const own = basename(f.project);
  writeFileSync(join(f.root, '_长程任务_test', '账本_三单.md'), [
    `- [ ] G-01 ${own}、ProjectB 三单各有产物 — 负责：执行`,
    '- [ ] G-02 三单共同验收 — 负责：执行',
  ].join('\n'));
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, aliasGroups: { 三单: [own, 'ProjectB', 'ProjectC'] } } });
  assert.deepEqual(report.relatedLedger?.find(item => item.id === 'G-01')?.relatedProjects, [own, 'ProjectB']);
  assert.deepEqual(report.relatedLedger?.find(item => item.id === 'G-02')?.relatedProjects, [own, 'ProjectB', 'ProjectC']);
});

test('H-002 shows work blocked by an open user decision', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_任务账本.md'), [
    '- [x] F-06 前置完成 — 负责：执行方',
    '- [ ] G-04 覆盖范围待定 — 负责：用户',
    '- [ ] F-07 覆盖服务器 — 负责：执行方 — 依赖：F-06、G-04 — 验收：部署',
    '- [ ] F-08 无关工作 — 负责：执行方 — 验收：G-04',
  ].join('\n'));
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  const section = handoffMarkdown(f.db, report.id).split('### 等你先拍板')[1]!.split('### 决定表待复核')[0]!;
  assert.match(section, /G-04 → F-07 覆盖服务器/);
  assert.doesNotMatch(section, /F-06 →|F-08/);
});

test('H-002 skips wildcard and abbreviated artifact paths', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_施工记录.md'), [
    '已生成 `Assets/a/*.json`', '已生成 `Assets/M_0…9.asset`',
    '已生成 `Assets/Gen/Menu/*`', '已生成 `Assets/a/?.json`',
    '已生成 `Assets/M_0...9.asset`', '已生成 `Assets/Missing.json`',
  ].join('\n'));
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  assert.deepEqual(report.reviews.find(item => item.id === 'artifacts')?.missingClaims?.map(item => item.detail), ['Assets/Missing.json']);
  const section = handoffMarkdown(f.db, report.id).split('### 记录里提到、现在不存在')[1]!;
  assert.doesNotMatch(section, /\*|M_0|\?\.json/);
});

test('H-002 shows meta programs only for samples and cites each counted file', t => {
  const f = fixture(t); const own = basename(f.project);
  const meta = join(f.root, '_长程任务_meta'); mkdirSync(meta);
  writeFileSync(join(meta, '任务书.md'), `${own} 与 ${own} 的样例统筹`);
  writeFileSync(join(meta, '任务账本.md'), `- [ ] M-01 ${own} 核对`);
  writeFileSync(join(meta, '_施工记录.md'), `<!-- 状态头:BEGIN -->\n## 当前状态\n- **最近一步**：${own} 已检查\n<!-- 状态头:END -->`);
  const config = { ...missingTools, metaPrograms: ['_长程任务_meta'] };
  const client = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config });
  assert.equal(client.relatedPrograms?.some(item => item.name === '_长程任务_meta'), false);
  const sample = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, kind: 'sample', config });
  const program = sample.relatedPrograms?.find(item => item.name === '_长程任务_meta');
  assert.deepEqual(program?.mentionSources, [
    { source: '_长程任务_meta/任务书.md', count: 2 },
    { source: '_长程任务_meta/任务账本.md', count: 1 },
    { source: '_长程任务_meta/_施工记录.md', count: 1 },
  ]);
  const section = handoffMarkdown(f.db, sample.id).split('## 关联长程任务')[1]!.split('## 关联的跨工程条目')[0]!;
  assert.match(section, /本工程提及 2 次 （来源：_长程任务_meta\/任务书\.md）/);
  assert.match(section, /本工程提及 1 次 （来源：_长程任务_meta\/任务账本\.md）/);
});

test('H-002 renders cleanup actions from audit JSON', t => {
  const f = fixture(t); const tools = join(f.root, 'tools'); mkdirSync(join(tools, '审查', 'perception'), { recursive: true });
  writeFileSync(join(tools, '审查', 'perception', 'strip_audit.py'),
    'import json\nprint(json.dumps({"project":"synthetic","findings":[{"path":"Packages/manifest.json","strip":True,"status":"present","action":"edit_json_remove_com.coplaydev.unity-mcp"},{"path":"Assets/AvatarAudit","strip":True,"status":"present","action":"delete"}]}))\n');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, toolRoot: tools } });
  const section = handoffMarkdown(f.db, report.id).split('### 工作副本的交付前清理项')[1]!.split('### 与工具链基准的差异')[0]!;
  assert.match(section, /编辑 Packages\/manifest\.json，删除依赖 com\.coplaydev\.unity-mcp/);
  assert.match(section, /删除 Assets\/AvatarAudit/);
  assert.match(section, /当前工作副本的只读检查；交付包状态见「交付包」/);
  assert.doesNotMatch(section, /需剥离/);
});

test('H-002 cross-project user item appears once in pending with group members', t => {
  const f = fixture(t); const own = basename(f.project);
  writeFileSync(join(f.root, '_长程任务_test', '账本_三单.md'),
    '- [ ] G-02 三单提交前询问 — 负责：用户\n- [ ] G-03 三单复核 — 负责：执行\n');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, aliasGroups: { 三单: [own, 'ProjectB', 'ProjectC'] } } });
  const brief = handoffMarkdown(f.db, report.id);
  const pending = brief.split('## 等你处理')[1]!.split('## 下一步建议')[0]!;
  const related = brief.split('## 关联的跨工程条目')[1]!.split('## 已关闭')[0]!;
  assert.match(pending, new RegExp(String.raw`G-02.*涉及工程：.*${syntheticOrder}_Test.*ProjectB.*ProjectC`));
  assert.doesNotMatch(related, /G-02/);
  assert.match(related, /G-03/);
});

test('H-002 limits unresolved paths to project-root relative paths', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, 'ProjectSettings', 'lilToonSetting.json'), '{}');
  writeFileSync(join(f.project, '_施工记录.md'), [
    '已生成 `lilToonSetting.json`', '已生成 `K01/pupil.json`',
    '已生成 `Assets/_Gone/x.cs`', '已生成 `/global/settings.json`',
  ].join('\n'));
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition, config: missingTools });
  const absent = report.reviews.find(item => item.id === 'artifacts')?.missingClaims;
  assert.deepEqual(absent?.map(item => item.detail), ['Assets/_Gone/x.cs']);
  const brief = handoffMarkdown(f.db, report.id);
  assert.doesNotMatch(brief.split('### 记录里提到、现在不存在')[1]!, /lilToonSetting|K01\/pupil|global\/settings/);
});

test('H-002 separates present cleanup, undecidable and information findings', t => {
  const f = fixture(t); const tools = join(f.root, 'tools'); mkdirSync(join(tools, '审查', 'perception'), { recursive: true });
  writeFileSync(join(tools, '审查', 'perception', 'strip_audit.py'),
    'import json\nprint(json.dumps({"project":"synthetic","findings":[{"path":"Assets/Strip","strip":True,"status":"present"},{"path":"Assets/Check","strip":True,"status":"undecidable"},{"path":"Assets/Info","strip":False,"status":"present"}]}))\n');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, toolRoot: tools } });
  const cleanup = report.reviews.find(item => item.id === 'delivery_cleanup')!;
  assert.deepEqual(cleanup.evidence.map(item => item.detail), ['Assets/Strip：核实清理动作']);
  assert.deepEqual(cleanup.needsVerification?.map(item => item.detail), ['Assets/Check：核实清理动作']);
  const brief = handoffMarkdown(f.db, report.id);
  assert.match(brief, /delivery_cleanup \| 待清理（1 项） \/ 需核实（1 项）/);
  assert.match(brief, /待清理 1 项[\s\S]*Assets\/Strip[\s\S]*需核实 1 项[\s\S]*Assets\/Check/);
  assert.doesNotMatch(brief, /Assets\/Info/);
  writeFileSync(join(tools, '审查', 'perception', 'strip_audit.py'),
    'import json\nprint(json.dumps({"project":"synthetic","findings":[{"path":"Assets/Check","strip":True,"status":"undecidable"}]}))\n');
  const needsCheck = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, toolRoot: tools } });
  assert.equal(needsCheck.reviews.find(item => item.id === 'delivery_cleanup')?.status, 'unknown');
  assert.match(handoffMarkdown(f.db, needsCheck.id), /delivery_cleanup \| 需核实（1 项）/);
});

test('H-002 cites state heading and recognizes configured timeline decision title', t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '_施工记录.md'), '<!-- 状态头:BEGIN -->\n## 当前状态（2026-09-25 12:00）\n<!-- 状态头:END -->\n## 2026-09-25 13:00 · 用户定 G-15 不改（执行）\n- 结果：已确认\n');
  const report = importProject(f.db, { workspacePath: f.root, projectPath: f.project, definition,
    config: { ...missingTools, decisionTitlePatterns: ['拍板', '用户定'] } });
  assert.equal(report.stateHeader.source, '_施工记录.md:2');
  const brief = handoffMarkdown(f.db, report.id);
  assert.match(brief.split('## 已拍板')[1]!.split('## 关联长程任务')[0]!, /用户定 G-15 不改/);
  assert.match(brief, /### 完整性问题[\s\S]*只收完整性复核失败，不代表工作卡点/);
  assert.doesNotMatch(brief, /阻断（复核发现的问题）/);
});
