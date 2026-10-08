import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { stringify } from 'yaml';
import { loadConfig, type LocalConfig } from '../../src/config.ts';
import type { ImportReport } from '../../src/import/types.ts';
import type { ProcessDefinition } from '../../src/process/types.ts';
import { openDatabase } from '../../src/state/db.ts';
import { removeTemp } from './platform.ts';

/**
 * A synthetic project for the diagnostics tests: a real workspace and directory tree, a real state database, and real
 * Run directories under `<AVH_HOME>/runs`. Three situations the bundle has to describe come out of it -- a setup Run
 * that lost its Provider connection, a vendor material the package never shipped, and a recolor source the plan
 * excludes -- and the logs carry the private values the redaction tests need.
 *
 * Nothing here is a specific product's asset: the vendor names, the check ids and the private values are synthetic, so
 * the fixture cannot stand in for "it works on the real project".
 */
export const DIAGNOSTICS_PROCESS: ProcessDefinition = {
  schema: 'process/0.1', id: 'synthetic-diagnostics', version: 'v1', applies_to: {},
  artifacts: ['plan', 'scene', 'texture'],
  stages: [
    { id: 'setup', needs: [], produces: ['plan'], requires: ['setup_complete'], gates: ['setup_approval'], invalidated_by: [] },
    { id: 'make', needs: ['setup'], produces: ['scene'], requires: ['vendor_material_complete'], gates: [], invalidated_by: ['plan'] },
    { id: 'recolor', needs: ['make'], produces: ['texture'], requires: ['recolor_source_allowed'], gates: [], invalidated_by: ['scene'] },
    // A deterministic stage: its stdout is the tool's own output and travels as before, unlike a Provider's session log.
    { id: 'package', needs: ['recolor'], produces: [], requires: [], gates: [], invalidated_by: [] },
  ],
  checks: [
    { id: 'setup_complete', observe: 'setup.inspect', on: 'plan', scope: 'edit', rule: 'complete == true', severity: 'blocking',
      maturity: 'accepted', label: '准备步骤完成' },
    { id: 'vendor_material_complete', observe: 'material.inspect', on: 'scene', scope: 'edit', rule: 'missing == 0', severity: 'blocking',
      maturity: 'accepted', label: '厂商材质齐备' },
    { id: 'recolor_source_allowed', observe: 'recolor.inspect', on: 'texture', scope: 'edit', rule: 'excluded_sources_used == 0',
      severity: 'blocking', maturity: 'accepted', label: '换色来源在计划内' },
  ],
  gates: [{ id: 'setup_approval', kind: 'approve', binds: 'plan' }],
  milestones: [],
};
/** How each stage is carried out. The Chinese stage names come from the process definition's own stage labels. */
export const DIAGNOSTICS_CAPABILITIES = {
  schema: 'capabilities/0.1', process: 'synthetic-diagnostics', version: '1',
  artifacts: { plan: { paths: ['_harness/plan.yaml'], format: 'yaml' as const }, scene: { paths: ['scene'] }, texture: { paths: ['texture'] } },
  stages: {
    setup: { mode: 'provider', goal: '准备', context: [], contextBudgetChars: 2000, contextCoverage: [], allowedWrites: ['_harness'], resources: [], maxRetries: 1, maxCheckRetries: 0 },
    make: { mode: 'provider', goal: '制作', context: [], contextBudgetChars: 2000, contextCoverage: [], allowedWrites: ['scene'], resources: [], maxRetries: 1, maxCheckRetries: 0 },
    recolor: { mode: 'provider', goal: '换色', context: [], contextBudgetChars: 2000, contextCoverage: [], allowedWrites: ['texture'], resources: [], maxRetries: 1, maxCheckRetries: 0 },
    package: { mode: 'tool', command: ['node', '{toolRoot}/package.mjs', '{project}'], context: [], contextBudgetChars: 2000, contextCoverage: [], allowedWrites: [], resources: [], maxRetries: 1, maxCheckRetries: 0 },
  },
  observers: {
    'setup.inspect': { command: ['node', '{toolRoot}/setup.mjs', '{project}', '{out}'] },
    'material.inspect': { command: ['node', '{toolRoot}/material.mjs', '{project}', '{out}'] },
    'recolor.inspect': { command: ['node', '{toolRoot}/recolor.mjs', '{project}', '{out}'] },
  },
};

/** The private values the fixture writes into logs. The tests assert about these, never about a real person's. */
export const FIXTURE_PRIVATE = {
  order: 'COMM-deadbeef_Luna',
  windowsPath: 'C:\\Users\\private-person\\work\\Luna\\Assets',
  linuxPath: '/home/private-person/work/Luna/Assets',
  apiKey: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX',
  booth: '_plaza_session_fixture=ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  word: 'PRIVATE_CUSTOMER_HANDLE',
  path: 'Assets/Vendor/Private/Package.prefab',
  unitypackage: 'Assets/Vendor/Private/Package.unitypackage',
  texture: 'Assets/Vendor/Private/Body_Diffuse.png',
};

export interface DiagnosticsFixture {
  root: string; home: string; workspace: string; project: string; config: LocalConfig;
  db: ReturnType<typeof openDatabase>;
  projectId: string; workflowId: string;
  runs: { setupFailed: string; setupOk: string; makeFailed: string; recolor: string; packageFailed: string };
  /** A private vocabulary file, written so its words must be replaced too. */
  privacyWords: string;
}

export function diagnosticsFixture(t: TestContext): DiagnosticsFixture {
  const root = mkdtempSync(join(tmpdir(), 'avh-diagnostics-'));
  const home = join(root, 'home'), workspace = join(root, 'workspace'), project = join(workspace, 'Luna');
  const packRoot = join(home, 'managed', 'packs', 'test-pack');
  const tools = join(packRoot, 'tools'), knowledge = join(packRoot, 'knowledge');
  for (const dir of ['config', 'state', 'runs', 'exports', 'tools', 'knowledge'])
    mkdirSync(join(home, dir), { recursive: true });
  mkdirSync(tools, { recursive: true });
  mkdirSync(knowledge, { recursive: true });
  mkdirSync(join(project, 'ProjectSettings'), { recursive: true });
  mkdirSync(join(project, 'Packages'), { recursive: true });
  mkdirSync(join(project, 'Assets', 'Vendor', 'Private'), { recursive: true });
  writeFileSync(join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  writeFileSync(join(project, 'Packages/vpm-manifest.json'), JSON.stringify({ locked: { 'com.vrchat.avatars': { version: '3.7.0' } } }));
  // Material originals that must never travel: a package, a texture and a prefab.
  writeFileSync(join(project, ...FIXTURE_PRIVATE.unitypackage.split('/')), 'PK\u0003\u0004 synthetic package bytes');
  writeFileSync(join(project, ...FIXTURE_PRIVATE.texture.split('/')), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  writeFileSync(join(project, ...FIXTURE_PRIVATE.path.split('/')), 'prefab');
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: 't1', t: {} }));
  writeFileSync(join(knowledge, 'synthetic.process.yaml'), stringify(DIAGNOSTICS_PROCESS));
  writeFileSync(join(knowledge, 'synthetic.capabilities.yaml'), stringify(DIAGNOSTICS_CAPABILITIES));
  // A managed pack, so the bundle can name the capability pack it was frozen from (id, version, content hash).
  writeFileSync(join(packRoot, 'pack.json'), `${JSON.stringify({ schema: 'harness-managed-pack/0.1', id: 'test-pack', version: '1.2.3',
    channel: 'dev', description: 'synthetic diagnostics fixture' })}\n`);
  for (const name of ['setup.mjs', 'material.mjs', 'recolor.mjs']) writeFileSync(join(tools, name), '// synthetic observer\n');
  // The read-only reviews a configuration requires to exist (config.ts reads them from the tool root at load time).
  mkdirSync(join(tools, '审查', 'perception'), { recursive: true });
  for (const name of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py'])
    writeFileSync(join(tools, ...name.split('/')), '');
  writeFileSync(join(home, 'config', 'harness.yaml'), stringify({
    workspaceRoot: workspace, toolRoot: tools, knowledgeRoot: knowledge, exportRoots: [join(home, 'exports')],
    knownBodies: [], projectAliases: {}, sampleNames: [], defaultProfile: 'synthetic-diagnostics',
    thresholdsFile: 'thresholds.yaml',
    processDefinitions: { 'synthetic-diagnostics': { definition: 'synthetic.process.yaml', capabilities: 'synthetic.capabilities.yaml' } },
    providers: [],
    import: { packageBaseline: { 'com.vrchat.avatars': '3.7.0', 'nadena.dev.modular-avatar': '1.13.0' } },
  }));
  const privacyWords = join(home, 'config', 'privacy-words.json');
  writeFileSync(privacyWords, JSON.stringify({ version: 1, patterns: [
    { id: 'customer-handle', literal: FIXTURE_PRIVATE.word, replacement: '<CUSTOMER>' },
    { id: 'workstation', regex: 'DEVBOX-[0-9]+', replacement: '<DEVBOX>' },
  ] }));
  const config = loadConfig(home);
  const db = openDatabase(join(home, 'state', 'harness.db'));
  t.after(() => { if (db.isOpen) db.close(); removeTemp(root); });

  const workspaceId = 'ws-1';
  db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run(workspaceId, workspace);
  db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES (?, ?, 'client', ?, ?, 'active', 'test-harness', 'test-knowledge')`)
    .run('p-1', workspaceId, project, JSON.stringify({ orderNumber: FIXTURE_PRIVATE.order, name: 'Luna' }));
  const projectId = 'p-1', workflowId = 'w-1';
  db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
    VALUES (?, ?, 'synthetic-diagnostics', 'hash-1', 'k-1', 'active', '{}')`).run(workflowId, projectId);
  const toolRoot = tools;
  db.prepare(`INSERT INTO workflow_definition (workflow_id, profile, definition_json, capabilities_json, thresholds_json, tools_json, tool_root)
    VALUES (?, 'synthetic-diagnostics', ?, ?, '{}', ?, ?)`)
    .run(workflowId, JSON.stringify(DIAGNOSTICS_PROCESS), JSON.stringify(DIAGNOSTICS_CAPABILITIES),
      JSON.stringify({ 'setup.mjs': 'a'.repeat(64), 'material.mjs': 'b'.repeat(64), 'recolor.mjs': 'c'.repeat(64) }), toolRoot);
  // The artifacts the stage checks read. Without them every verdict is stale and the Runtime aggregator (which the
  // diagnostics bundle now reuses, R28 P1-4) would report a state the fixture never meant to build.
  for (const kind of ['plan', 'scene', 'texture'])
    db.prepare('INSERT INTO artifact_version (workflow_id, kind, hash) VALUES (?, ?, ?)').run(workflowId, kind, 'e'.repeat(64));

  // Tasks: setup and make ran and completed; recolor's task is waiting for the person after the check blocked it.
  const task = (id: string, stage: string, status: string): void => {
    db.prepare('INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, workflowId, stage, `阶段 ${stage}`, 'provider', status);
  };
  task('t-setup', 'setup', 'PASSED');
  task('t-make', 'make', 'PASSED');
  task('t-recolor', 'recolor', 'WAITING_HUMAN');
  task('t-package', 'package', 'FAILED');
  db.prepare(`INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json) VALUES (?, 'setup', '{}')`).run(workflowId);
  db.prepare(`INSERT INTO stage_completion (workflow_id, stage_id, artifact_hashes_json) VALUES (?, 'make', ?)`)
    .run(workflowId, JSON.stringify({ plan: 'e'.repeat(64) }));
  db.prepare(`INSERT INTO gate_decision (workflow_id, gate_id, artifact_hash, result) VALUES (?, 'setup_approval', ?, 'approved')`)
    .run(workflowId, 'e'.repeat(64));

  const runs = { setupFailed: 'run-setup-1', setupOk: 'run-setup-2', makeFailed: 'run-make-1', recolor: 'run-recolor-1',
    packageFailed: 'run-package-1' };
  const run = (id: string, taskId: string, attempt: number, status: string, result: Record<string, unknown> | null, provider = 'fake-codex'): void => {
    db.prepare('INSERT INTO run (id, task_id, attempt, status, provider, result_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, taskId, attempt, status, provider, result === null ? null : JSON.stringify(result));
  };
  // ① A network interruption during setup, then the retry that succeeded.
  run(runs.setupFailed, 't-setup', 1, 'exited', { exitStatus: 1, errorClass: 'network',
    errorMessage: `连接中断：${FIXTURE_PRIVATE.linuxPath} 的会话已断开` });
  run(runs.setupOk, 't-setup', 2, 'exited', { exitStatus: 0, outputs: {}, verdictIds: [`${runs.setupOk}:setup_complete`] });
  // ② The make Run failed in a deterministic tool, and its observation found the vendor's package incomplete.
  run(runs.makeFailed, 't-make', 1, 'exited', { exitStatus: 2, errorClass: 'tool_failure',
    errorMessage: `材质导入失败：${FIXTURE_PRIVATE.windowsPath}\\Vendor`,
    verdictIds: [`${runs.makeFailed}:vendor_material_complete`] });
  // ③ The recolor Run succeeded, but the observation says it used a source the plan excludes.
  run(runs.recolor, 't-recolor', 1, 'exited', { exitStatus: 0, outputs: {},
    verdictIds: [`${runs.recolor}:recolor_source_allowed`] });
  // ④ A deterministic tool stage that failed: its stdout is the tool's own output, not a model's session.
  run(runs.packageFailed, 't-package', 1, 'exited', { exitStatus: 3, errorClass: 'tool_failure',
    errorMessage: '打包工具退出码 3' });

  // The verdict ids carry the Run they were observed in (`<runId>:<checkId>`), which is the only recorded link
  // between a reading and a Run directory (R28 P2-2).
  const verdict = (runId: string, checkId: string, result: string, basis: string, at: string, artifact = 'e'.repeat(64)): void => {
    db.prepare(`INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result, basis, recorded_at)
      VALUES (?, ?, ?, 'edit', ?, ?, ?, ?)`).run(`${runId}:${checkId}`, workflowId, checkId, artifact, result, basis, at);
  };
  verdict(runs.setupOk, 'setup_complete', 'pass', 'setup.inspect: complete == true | complete=true', '2026-10-01T10:05:00.000Z');
  verdict(runs.makeFailed, 'vendor_material_complete', 'no_data', `material.inspect: 观测结果无效: 缺件清单不可读（${FIXTURE_PRIVATE.order}）`, '2026-10-02T09:30:00.000Z');
  verdict(runs.recolor, 'recolor_source_allowed', 'violation', `recolor.inspect: excluded_sources_used == 0 | excluded_sources_used=2 | 用到了计划排除的来源 ${FIXTURE_PRIVATE.path}`,
    '2026-10-03T08:00:00.000Z');

  // Runs' events, which are also the timeline and where a Run's own timestamp comes from.
  const event = (entityType: string, entityId: string, action: string, reason: string, payload: Record<string, unknown>, at: string): void => {
    db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json, occurred_at)
      VALUES (?, 'runtime', ?, ?, ?, ?, ?, ?)`).run(workflowId, entityType, entityId, action, reason, JSON.stringify(payload), at);
  };
  event('run', runs.setupFailed, 'failed', 'Run failed: network', { errorClass: 'network' }, '2026-10-01T10:00:00.000Z');
  event('run', runs.setupOk, 'exited', `重试成功（订单 ${FIXTURE_PRIVATE.order}）`, { exitStatus: 0 }, '2026-10-01T10:04:00.000Z');
  event('run', runs.makeFailed, 'failed', 'Run failed: tool_failure', { errorClass: 'tool_failure' }, '2026-10-02T09:20:00.000Z');
  event('run', runs.recolor, 'exited', 'Run exited', { exitStatus: 0 }, '2026-10-03T07:50:00.000Z');
  event('check', 'vendor_material_complete', 'decided', '判据无法判定', {}, '2026-10-02T09:30:00.000Z');
  event('check', 'recolor_source_allowed', 'decided', '判据未通过', {}, '2026-10-03T08:00:00.000Z');
  event('project', projectId, 'diagnosed', `客户 ${FIXTURE_PRIVATE.word} 的工程`, {}, '2026-10-03T09:00:00.000Z');

  // The import report that recorded the vendor's own omissions; `material.inspect` reads the same archive.
  const report: ImportReport = {
    schema: 'import/0.1', id: 'import-1', projectId, processId: 'synthetic-diagnostics', processVersion: 'v1', processHash: 'hash-1',
    workspacePath: '<workspace>', projectPath: '<project>',
    identity: { kind: 'client', orderNumber: FIXTURE_PRIVATE.order, unityVersion: '2022.3.22f1', packages: { 'com.vrchat.avatars': '3.7.0' } },
    stateHeader: { fields: {} }, timeline: { count: 0, recent: [] }, unparsedRecords: [],
    ledger: [], ledgerDecisions: [], externalLedger: [], git: { commits: [], changes: [] }, runningProcesses: [],
    fingerprint: 'fp', snapshotSampledFiles: [], snapshotHash: 'snap-1',
    reviews: [
      { id: 'delivery_archive', status: 'fail', reason: `archive misses ${FIXTURE_PRIVATE.unitypackage}: the vendor never shipped the material textures`,
        evidence: [] },
      { id: 'avatar_references', status: 'unknown', reason: `${FIXTURE_PRIVATE.path} 引用的材质在工程与交付包里都找不到`, evidence: [] },
      { id: 'toolchain_baseline', status: 'pass', reason: '与工具链基准一致', evidence: [] },
    ],
    stages: [], gaps: [], blockers: [], nextSteps: [],
  };
  db.prepare('INSERT INTO import_report (id, project_id, report_json, snapshot_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('import-1', projectId, JSON.stringify(report), 'snap-1', '2026-09-30T00:00:00.000Z');

  // ---- The Run directories: real files, with the private values in them.
  const runDir = (id: string): string => { const path = join(home, 'runs', id); mkdirSync(path, { recursive: true }); return path; };
  const setupFailed = runDir(runs.setupFailed);
  writeFileSync(join(setupFailed, 'stderr.log'), [
    `connecting to provider (order ${FIXTURE_PRIVATE.order})`,
    `reading ${FIXTURE_PRIVATE.windowsPath}`,
    `reading ${FIXTURE_PRIVATE.linuxPath}`,
    // This machine's own project and home directories: the export must name them `<PROJECT>` and `<AVH_HOME>`.
    `project ${project}`,
    `home ${home}`,
    `host DEVBOX-42`,
    `key ${FIXTURE_PRIVATE.apiKey}`,
    `cookie ${FIXTURE_PRIVATE.booth}`,
    `customer ${FIXTURE_PRIVATE.word}`,
    'network reset by peer after 30s',
    'aborting',
  ].join('\n'));
  writeFileSync(join(setupFailed, 'stdout.log'), 'started\nexiting with 1\n');
  writeFileSync(join(setupFailed, 'exit.json'), JSON.stringify({ exitStatus: 1, errorClass: 'network' }));
  writeFileSync(join(setupFailed, 'prepare.json'), JSON.stringify({ status: 'finished', exitStatus: 0 }));
  const makeFailed = runDir(runs.makeFailed);
  writeFileSync(join(makeFailed, 'stderr.log'), `material import failed for ${FIXTURE_PRIVATE.path}\n`);
  writeFileSync(join(makeFailed, 'exit.json'), JSON.stringify({ exitStatus: 2, errorClass: 'tool_failure' }));
  mkdirSync(join(makeFailed, 'checks', 'observe-material.inspect'), { recursive: true });
  writeFileSync(join(makeFailed, 'checks', 'observe-material.inspect', 'metrics.json'),
    JSON.stringify({ schema: 'observation/0.1', metrics: { missing: 2, missing_paths: [FIXTURE_PRIVATE.path] } }));
  // A Unity log with an error buried in import noise: the window must keep the lines around it and not the noise.
  writeFileSync(join(makeFailed, 'unity-1.log'), [
    ...Array.from({ length: 200 }, (_, index) => `- Importing asset ${index} (${FIXTURE_PRIVATE.linuxPath}/noise)`),
    `Assets/Vendor/Private/Package.prefab: Material slot 3 references a missing texture (${FIXTURE_PRIVATE.texture})`,
    ...Array.from({ length: 200 }, (_, index) => `- Importing asset extra ${index}`),
  ].join('\n'));
  const recolor = runDir(runs.recolor);
  writeFileSync(join(recolor, 'stderr.log'), `recolor used ${FIXTURE_PRIVATE.path}\n`);
  writeFileSync(join(recolor, 'exit.json'), JSON.stringify({ exitStatus: 0 }));
  mkdirSync(join(recolor, 'observations'), { recursive: true });
  writeFileSync(join(recolor, 'observations', 'recolor_source_allowed.json'),
    JSON.stringify({ schema: 'observation/0.1', metrics: { excluded_sources_used: 2 } }));
  // The tool Run's own stdout, which is evidence about the tool and travels as it always did.
  const packageFailed = runDir(runs.packageFailed);
  writeFileSync(join(packageFailed, 'stdout.log'), 'packing project\nmanifest written\npackager error: archive member rejected\n');
  writeFileSync(join(packageFailed, 'stderr.log'), 'packager error: archive member rejected\n');
  writeFileSync(join(packageFailed, 'exit.json'), JSON.stringify({ exitStatus: 3, errorClass: 'tool_failure' }));
  // A vendor's omission is often a *note* on an observation that still passes: nothing blocks, and only the issue
  // list can carry it (R28 P2-5). The second note is a plain limitation, so the two categories are distinguishable.
  mkdirSync(join(home, 'runs', runs.setupOk, 'observations'), { recursive: true });
  writeFileSync(join(home, 'runs', runs.setupOk, 'observations', 'setup_complete.json'),
    JSON.stringify({ schema: 'observation/0.1', metrics: { complete: true }, notes: [
      `厂商缺件：${FIXTURE_PRIVATE.order} 委托的材质包未随交付提供，先用工程内旧贴图继续`,
      '本机没有安装 Android 构建模块，导出步骤暂不可用',
    ] }));
  // The dependency and retirement receipt the material stage leaves in the project (R28 P2-5): a real project file,
  // summarised by whitelisted fields and never copied.
  mkdirSync(join(project, 'Assets', '_Harness', 'Recolor'), { recursive: true });
  writeFileSync(join(project, 'Assets', '_Harness', 'Recolor', 'dependency-receipt.json'),
    JSON.stringify({ schema: 'material-dependency-receipt/0.1', request_sha256: 'r'.repeat(64),
      packages: [{ package: 'Vendor/Package', assets: [{ path: FIXTURE_PRIVATE.path, sha256: 'a'.repeat(64) }] }],
      retired: [{ path: FIXTURE_PRIVATE.path, status: 'deleted', run_id: runs.recolor, sha256: 'a'.repeat(64) }],
      pending_retirements: [], history: [{ at: '2026-10-02T00:00:00.000Z' }] }));
  return { root, home, workspace, project, config, db, projectId, workflowId, runs, privacyWords };
}
