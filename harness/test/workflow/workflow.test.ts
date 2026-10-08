import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sha256File } from '../../src/file-hash.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { loadConfig } from '../../src/config.ts';
import { loadProcess } from '../../src/process/load.ts';
import type { Executor, RunHandle, RunResult, RunSpec } from '../../src/runtime/interfaces.ts';
import { openDatabase } from '../../src/state/db.ts';
import { acquireSchedulerLease } from '../../src/state/scheduler-lease.ts';
import { newFingerprintCadence } from '../../src/runtime/reconcile.ts';
import { cancel, gateList, serveOnce, taskRecover, taskRedo, warningAccept, warningList } from '../../src/task-cli.ts';
import { workflowText } from '../../src/cli.ts';
import { taskRows } from '../../src/api/read-model.ts';
import { buildAggregateInput } from '../../src/state/aggregate-input.ts';
import { artifactFingerprint, artifactFiles, fileHash } from '../../src/workflow/artifacts.ts';
import { loadCapabilities, manifestToolReferences } from '../../src/workflow/capabilities.ts';
import { cancelWorkflow, createProject, createWorkflow, decideFormalGate, formalGates, parseManifest, stageTaskSpec, StageRouter,
  ArtifactFingerprinter, workflowScheduler, workflowSnapshot } from '../../src/workflow/runtime.ts';
import { stepProject } from '../../src/exec/unity-steps.ts';
import { describeWorkflow, listWorkflows, warningRows } from '../../src/workflow/view.ts';
import { checkSandboxStatus } from '../../src/exec/check-runner.ts';
import { escapeRegExp, FAKE_PROVIDER, fakeCommand, posixPath, removeTemp, windows } from '../fixtures/platform.ts';
import { waitFor } from '../fixtures/wait.ts';
import { renderVerify } from '../fixtures/verify-component.ts';
import { approveCandidateTrial, candidateTrials, recordPackEvaluation, registerPackCandidate } from '../../src/managed-pack-candidate.ts';
import { submitInteraction } from '../../src/interactions.ts';
import { currentIntent, recordIntent } from '../../src/project-intent.ts';
import { approveProduction, productionContext } from '../../src/production-proposals.ts';
import { adoptLocalCandidate, localMaintenanceIdentity, localMaintenanceView, localWorkflowSelection } from '../../src/local-maintenance.ts';
import { ApiClient } from '../../src/api/client.ts';
import { RuntimeService } from '../../src/api/server.ts';
import { renderProgressL1 } from '../fixtures/progress-l1-component.ts';

const PROCESS = {
  schema: 'process/0.1', id: 'synthetic-formal', version: 'v1', applies_to: {}, artifacts: ['plan', 'scene', 'report'],
  stages: [
    { id: 'plan', needs: [], produces: ['plan'], requires: ['plan_has_title'], gates: ['plan_approval'], invalidated_by: [] },
    { id: 'make', needs: ['plan'], produces: ['scene'], requires: ['scene_items'], gates: [], invalidated_by: ['plan'] },
    { id: 'extra', needs: ['make'], when: 'plan.extra', produces: ['report'], requires: ['report_ok'], gates: [], invalidated_by: ['scene'] },
  ],
  checks: [
    { id: 'plan_has_title', observe: 'plan.inspect', on: 'plan', scope: 'edit', rule: 'title_length > 0', severity: 'blocking', maturity: 'accepted' },
    { id: 'scene_items', observe: 'scene.count', on: 'scene', scope: 'edit', rule: 't.min_items <= items <= t.max_items and broken == 0',
      severity: 'blocking', maturity: 'accepted' },
    { id: 'report_ok', observe: 'report.check', on: 'report', scope: 'build', rule: 'ok == true', severity: 'blocking', maturity: 'accepted' },
  ],
  gates: [{ id: 'plan_approval', kind: 'approve', binds: 'plan' }, { id: 'client_test', kind: 'do', binds: 'scene' }],
  milestones: [{ id: 'UPLOAD_READY', requires_stages: 'all', evidence_on: 'scene' },
    { id: 'CLIENT_VERIFIED', after: 'UPLOAD_READY', gates: ['client_test'] }],
};
const CAPABILITIES = {
  schema: 'capabilities/0.1', process: 'synthetic-formal', version: '1',
  artifacts: { plan: { paths: ['_harness/plan.yaml'], format: 'yaml' }, scene: { paths: ['scene'] }, report: { paths: ['report.json'] } },
  stages: {
    plan: { mode: 'provider', goal: '按需求写方案：{{manifest.request}}',
      context: [
        { id: 'plan-core', path: 'SOP/plan.md', heading: '核心', required: true, covers: ['plan.constraints'] },
        { id: 'empty-variant-guidance', path: 'SOP/plan.md', heading: '无造型', priority: 20,
          when: [{ path: 'memory.variants.count', equals: 0 }] },
      ],
      contextBudgetChars: 2000, contextCoverage: ['plan.constraints'],
      agentTools: { 'inspect-input': ['node', '{toolRoot}/make.mjs', '{project}'] }, allowedWrites: ['_harness'] },
    make: { mode: 'tool', command: ['node', '{toolRoot}/make.mjs'], allowedWrites: ['scene'] },
    extra: { mode: 'provider', goal: '写报告', allowedWrites: ['report.json'] },
  },
  observers: {
    'plan.inspect': { command: ['node', '{toolRoot}/inspect-plan.mjs', '{project}', '{out}'] },
    'scene.count': { command: ['node', '{toolRoot}/count.mjs', '{project}', '{out}'] },
    'report.check': { command: ['node', '{toolRoot}/report.mjs', '{project}', '{out}'] },
  },
};
const OBSERVERS: Record<string, string> = {
  'inspect-plan.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
const plan = JSON.parse(readFileSync(process.argv[2] + '/_harness/plan.yaml', 'utf8'));
writeFileSync(process.argv[3], JSON.stringify({ schema: 'observation/0.1', metrics: { title_length: (plan.title ?? '').length } }));`,
  'count.mjs': `import { readdirSync, writeFileSync } from 'node:fs';
const names = readdirSync(process.argv[2] + '/scene');
const broken = names.includes('unmeasured') ? null : names.filter(name => name.endsWith('.broken')).length;
writeFileSync(process.argv[3], JSON.stringify({ schema: 'observation/0.1', metrics: { items: names.length, broken } }));`,
  'report.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2] + '/report.json', 'utf8'));
writeFileSync(process.argv[3], JSON.stringify({ schema: 'observation/0.1', metrics: { ok: report.ok === true } }));`,
};

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-workflow-'));
  t.after(() => removeTemp(root));
  const home = join(root, 'home'), workspace = join(root, 'workspace'), project = join(workspace, 'sample');
  const tools = join(root, 'tools'), knowledge = join(root, 'knowledge'), exportRoot = join(root, 'export');
  for (const dir of [join(home, 'config'), join(home, 'state'), project, join(tools, '审查/perception'), knowledge, exportRoot])
    mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  writeFileSync(join(project, '.gitignore'), 'Library/\n');
  execFileSync('git', ['-C', project, 'add', '.gitignore']);
  execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'init']);
  for (const file of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) writeFileSync(join(tools, file), '');
  for (const [name, source] of Object.entries(OBSERVERS)) writeFileSync(join(tools, name), source);
  // The make stage's tool: the fake executor does its work in unit tests; the systemd test replaces it.
  writeFileSync(join(tools, 'make.mjs'), '');
  writeFileSync(join(knowledge, 'synthetic.process.yaml'), stringify(PROCESS));
  writeFileSync(join(knowledge, 'synthetic.capabilities.yaml'), stringify(CAPABILITIES));
  mkdirSync(join(knowledge, 'SOP'));
  writeFileSync(join(knowledge, 'SOP/plan.md'), '# 方案规范\n## 核心\n只能使用已选素材。\n## 无造型\n没有造型时先保留审美缺口。\n');
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: 't1', t: {
    min_items: { value: 2, unit: 'items', maturity: 'accepted', source: 'test' },
    max_items: { value: 4, unit: 'items', maturity: 'accepted', source: 'test' } } }));
  const fake = fakeCommand(join(root, 'fake-codex'), FAKE_PROVIDER);
  writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: workspace, toolRoot: tools, knowledgeRoot: knowledge,
    exportRoots: [exportRoot], knownBodies: [], projectAliases: {}, sampleNames: ['sample'],
    processDefinitions: { 'synthetic-formal': { definition: 'synthetic.process.yaml', capabilities: 'synthetic.capabilities.yaml' } },
    defaultProfile: 'synthetic-formal', thresholdsFile: 'thresholds.yaml',
    providers: [{ id: 'fake', type: 'codex-cli', executable: fake, roles: ['executor'], writable: [], maxConcurrentRuns: 1 }] }));
  const config = loadConfig(home);
  const db = openDatabase(join(home, 'state/harness.db'));
  t.after(() => db.close());
  const manifestPath = join(root, 'manifest.yaml');
  writeFileSync(manifestPath, stringify({ schema: 'manifest/0.1', profile: 'synthetic-formal',
    assets: [{ store: 'library', item: '1', role: 'body' }], request: '做一个两件道具的样例' }));
  /** Stands in for Providers and tools: each stage writes what that stage produces. */
  class StageFake implements Executor {
    starts: RunSpec[] = []; plan: Record<string, unknown> = { title: 'Sample', extra: false }; items = ['a', 'b'];
    /** While set, Runs keep running: a test can look at the Workflow in the middle of a stage. */
    hold = false;
    /** Stages whose Runs fail (exit 1) while listed. */
    failing = new Set<string>();
    start(spec: RunSpec): RunHandle { this.starts.push(spec); return { ref: `fake-${spec.runId}` }; }
    observe(): { state: 'exited' | 'running' } { return { state: this.hold ? 'running' : 'exited' }; }
    cancel(): 'confirmed' { return 'confirmed'; }
    confirmNeverStarted(): boolean { return true; }
    collect(handle: RunHandle): RunResult {
      const spec = this.starts.find(item => `fake-${item.runId}` === handle.ref)!;
      if (this.failing.has(spec.stageId)) return { exitStatus: 1, errorClass: 'tool_failure', errorMessage: 'synthetic failure', outputs: {} };
      if (spec.stageId === 'plan') { mkdirSync(join(project, '_harness'), { recursive: true });
        writeFileSync(join(project, '_harness/plan.yaml'), JSON.stringify(this.plan)); }
      if (spec.stageId === 'make') { rmSync(join(project, 'scene'), { recursive: true, force: true }); mkdirSync(join(project, 'scene'));
        for (const name of this.items) writeFileSync(join(project, 'scene', name), name); }
      if (spec.stageId === 'extra') writeFileSync(join(project, 'report.json'), JSON.stringify({ ok: true }));
      return { exitStatus: 0, outputs: {} };
    }
  }
  const executor = new StageFake();
  const tick = () => serveOnce(db, config, () => executor);
  const stages = (id: string) => Object.fromEntries(describeWorkflow(db, id).stages.map(stage => [stage.id, stage.status]));
  return { root, home, project, config, db, manifestPath, executor, tick, stages };
}

test('capability manifests must cover every stage, artifact and observer, and keep metrics independent', () => {
  const definition = loadProcess(stringify(PROCESS), { schema: 'thresholds/0.1', version: '1', t: {
    min_items: { value: 2, unit: 'items', maturity: 'accepted', source: 'x' },
    max_items: { value: 4, unit: 'items', maturity: 'accepted', source: 'x' } } });
  assert.equal(loadCapabilities(stringify(CAPABILITIES), definition).stages.make!.mode, 'tool');
  const broken = (change: (value: typeof CAPABILITIES) => void) => {
    const copy = structuredClone(CAPABILITIES); change(copy); return () => loadCapabilities(stringify(copy), definition);
  };
  assert.throws(broken(copy => { delete (copy.stages as Record<string, unknown>).extra; }), /stages\.extra/);
  assert.throws(broken(copy => { delete (copy.artifacts as Record<string, unknown>).report; }), /artifacts\.report/);
  assert.throws(broken(copy => { delete (copy.observers as Record<string, unknown>)['report.check']; }), /report\.check/);
  assert.throws(broken(copy => { (copy.observers as Record<string, unknown>)['scene.count'] = { command: ['node', 'x.mjs'] }; }), /\{out\}/);
  assert.throws(broken(copy => { (copy.observers as Record<string, unknown>)['scene.count'] = { runFile: 'metrics.json' }; }), /observations\//);
  // An executor-only stage cannot be the source of its own metrics.
  assert.throws(broken(copy => {
    (copy.observers as Record<string, unknown>)['report.check'] = { runFile: 'observations/report.json' };
  }), /tool 阶段或 Unity 步骤/);
  assert.throws(broken(copy => { (copy.stages as Record<string, unknown>).make = { mode: 'none' }; }), /有产出的阶段不能是 none/);
  assert.throws(broken(copy => { (copy.stages.make as Record<string,unknown>).prepareCommand=['node','x']; }), /只有 provider 阶段/);
  assert.throws(broken(copy => { (copy.stages.extra as Record<string,unknown>).prepareCommand=['node','x']; }), /unitySteps/);
  assert.throws(broken(copy => { (copy.artifacts.plan as Record<string, unknown>).paths = ['/etc/passwd']; }), /工程内相对路径/);
  assert.throws(broken(copy => { (copy as Record<string, unknown>).process = 'other'; }), /process/);
});

test('the scheduler completes preservation without optional outputs and runs the optional producer after an approved design revision', async t => {
  const f = fixture(t), definition = f.config.definitions['synthetic-formal']!;
  const [plan, make, extra] = definition.stages;
  extra!.needs = ['plan']; extra!.when = 'plan.face.mode == "design"'; extra!.invalidated_by = ['plan'];
  make!.needs = ['extra']; make!.invalidated_by = ['plan', 'report']; definition.stages = [plan!, extra!, make!];
  f.executor.plan = { title: 'Preserve', face: { mode: 'preserve' } };
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick(); await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'preserve');
  await f.tick(); await f.tick();
  assert.deepEqual(f.stages(id), { plan: 'passed', extra: 'not_applicable', make: 'passed' });
  const projected = describeWorkflow(f.db, id);
  assert.doesNotMatch(renderProgressL1(projected), /待取证 1|证据未完整/, 'the shipped L1 consumer must treat the real not_applicable stage as skipped');
  assert.equal(existsSync(join(f.project, 'report.json')), false);
  assert.equal(f.executor.starts.filter(run => run.stageId === 'make').length, 1);
  f.executor.plan = { title: 'Design revision', face: { mode: 'design' } };
  const planTask = describeWorkflow(f.db, id).stages.find(stage => stage.id === 'plan')!.task!.id;
  taskRedo(f.db, planTask, 'design revision'); await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'design');
  for (let i = 0; i < 4; i++) await f.tick();
  assert.deepEqual(f.stages(id), { plan: 'passed', extra: 'passed', make: 'passed' });
  assert.equal(f.executor.starts.filter(run => run.stageId === 'extra').length, 1);
  assert.equal(f.executor.starts.filter(run => run.stageId === 'make').length, 2, 'new producer output reaches a new actual consumer run');
});

test('a formal concrete-choice gate rejects boolean approval without persisting a decision', async t => {
  const f = fixture(t), definition = f.config.definitions['synthetic-formal']!;
  definition.gates[0]!.kind = 'choose'; definition.gates[0]!.selection = 'face-candidate';
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick(); await f.tick();
  const gate = formalGates(f.db, id).find(item => item.gate.endsWith(':plan_approval'))!;
  assert.equal(gate.status, 'pending');
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM gate_decision').get()!.n;
  await assert.rejects(decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'approve', gate.artifactHash), /请选择实际预览/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM gate_decision').get()!.n, before);
  assert.equal(formalGates(f.db, id).find(item => item.gate.endsWith(':plan_approval'))!.status, 'pending');
  await cancelWorkflow(f.db, f.config, id, 'cancel', f.executor);
  await assert.rejects(decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'approve', gate.artifactHash), /已经取消/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM gate_decision').get()!.n, before);
});

test('conditional provider work preserves approved inputs without a model and freezes both command branches', t => {
  const f = fixture(t);
  const raw = structuredClone(CAPABILITIES);
  Object.assign(raw.stages.extra, {
    providerWhen: { path: 'plan.face.mode', equals: 'design' },
    otherwiseCommand: ['node', '{toolRoot}/preserve.mjs', '{project}'],
  });
  writeFileSync(join(f.config.toolRoot, 'preserve.mjs'), 'preserve original input');
  const capabilities = loadCapabilities(stringify(raw), f.config.definitions['synthetic-formal']!);
  f.config.capabilities['synthetic-formal'] = capabilities;
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  const frozen = workflowSnapshot(f.db, id), stage = frozen.definition.stages.find(s => s.id === 'extra')!;
  assert.ok(frozen.tools['preserve.mjs'], 'the preservation consumer is hash-frozen with the workflow');
  assert.ok(manifestToolReferences(capabilities).includes('preserve.mjs'));
  const preserve = stageTaskSpec(frozen, stage, { face: { mode: 'preserve' } }, frozen.toolRoot, f.project);
  assert.deepEqual(preserve.tool!.argv.map(posixPath), ['node', join(frozen.toolRoot, 'preserve.mjs'), f.project].map(posixPath));
  assert.equal(preserve.tool!.network, false);
  assert.equal(preserve.prepare, undefined);
  assert.equal(preserve.inputImages, undefined, 'unused picture is not sent to a model for preservation');
  assert.equal(stageTaskSpec(frozen, stage, {}, frozen.toolRoot, f.project).tool!.argv[1], preserve.tool!.argv[1]);
  const design = stageTaskSpec(frozen, stage, { face: { mode: 'design' } }, frozen.toolRoot, f.project);
  assert.equal(design.tool, undefined, 'actual design still uses the provider');
  const original = structuredClone(raw) as Record<string, any>;
  delete original.stages.extra.otherwiseCommand;
  assert.throws(() => loadCapabilities(stringify(original), frozen.definition), /必须同时用于 provider/);
  original.stages.extra.otherwiseCommand = ['node', 'x'];
  original.stages.extra.providerWhen.path = 'memory.hasWork';
  assert.throws(() => loadCapabilities(stringify(original), frozen.definition), /批准方案或冻结输入/);
  original.stages.extra.providerWhen.path = 'plan.face.mode';
  original.stages.extra.mode = 'tool';
  assert.throws(() => loadCapabilities(stringify(original), frozen.definition), /必须同时用于 provider/);
  const owned = structuredClone(raw) as Record<string, any>;
  owned.stages.extra.runtimeWrites = ['_harness/preview/'];
  owned.stages.extra.runtimeTemporaryWrites = ['_harness/input.json.writing'];
  assert.throws(() => loadCapabilities(stringify(owned), frozen.definition), /需要受管 Unity/);
  owned.stages.extra.unitySteps = [{ method: 'Fixture.Render' }];
  owned.stages.extra.resources = ['unity_batch'];
  const trusted = loadCapabilities(stringify(owned), frozen.definition);
  const compiled = stageTaskSpec({ ...frozen, capabilities: trusted, variables: {...frozen.variables, assetLibrary: '/synthetic/owned-pool'} }, stage, { face: { mode: 'design' } }, frozen.toolRoot, f.project);
  assert.equal(compiled.unitySteps?.[0].env?.AVH_ASSET_LIBRARY, '/synthetic/owned-pool');
  assert.equal(compiled.unitySteps?.[0].env?.AVH_TOOL_ROOT, frozen.toolRoot);
  assert.deepEqual(compiled.runtimeWrites, ['_harness/preview/', '_harness/input.json.writing']);
  assert.equal(compiled.expectedOutputs.includes('_harness/input.json.writing'), false, 'successful atomic writes do not leave temporary outputs');
  assert.deepEqual(compiled.allowedWrites, ['report.json'], 'provider never receives the Runtime render directory');
  for (const path of ['_harness/', '_harness/*.writing', '../escape.writing', '_harness/../escape.writing']) {
    const invalid = structuredClone(owned); invalid.stages.extra.runtimeTemporaryWrites = [path];
    assert.throws(() => loadCapabilities(stringify(invalid), frozen.definition), /精确文件|工程内相对路径/);
  }
  const durable = structuredClone(owned); durable.stages.extra.runtimeTemporaryWrites = ['report.json'];
  assert.throws(() => loadCapabilities(stringify(durable), frozen.definition), /持久产物/);
  owned.stages.extra.allowedWrites.push('_harness');
  assert.throws(() => loadCapabilities(stringify(owned), frozen.definition), /不能与执行方写范围重叠/);
});

test('a face output review is unnecessary for preservation and rejects blind approval of an actual design task', async t => {
  const f = fixture(t), definition = f.config.definitions['synthetic-formal']!, caps = f.config.capabilities['synthetic-formal']!;
  definition.artifacts = definition.artifacts.map(kind => kind === 'scene' ? 'face' : kind);
  for (const stage of definition.stages) {
    stage.produces = stage.produces.map(kind => kind === 'scene' ? 'face' : kind);
    stage.invalidated_by = stage.invalidated_by.map(kind => kind === 'scene' ? 'face' : kind);
  }
  for (const check of definition.checks) if (check.on === 'scene') check.on = 'face';
  caps.artifacts.face = caps.artifacts.scene!; delete caps.artifacts.scene;
  definition.gates.push({ id: 'face_appearance', kind: 'approve', binds: 'face', review: 'face-output', when: 'plan.face.mode == "design"' });
  definition.stages.find(stage => stage.id === 'make')!.gates.push('face_appearance');
  f.executor.plan = { title: 'Preserve', face: { mode: 'preserve' } };
  const preserve = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick(); await decideFormalGate(f.db, f.config, preserve, 'plan_approval', true, 'preserve'); await f.tick();
  assert.equal(formalGates(f.db, preserve).some(gate => gate.review), false);
  assert.equal(f.stages(preserve).make, 'passed');
  await cancelWorkflow(f.db, f.config, preserve, 'close preservation fixture before the design revision test', f.executor);
  f.executor.plan = { title: 'Design', face: { mode: 'design' } };
  const design = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick(); await decideFormalGate(f.db, f.config, design, 'plan_approval', true, 'design'); await f.tick();
  const gate = formalGates(f.db, design).find(gate => gate.review === 'face-output')!;
  assert.equal(gate.status, 'pending', 'completed technical checks expose the output review without a circular full qualification');
  const before = f.db.prepare('SELECT COUNT(*) AS n FROM gate_decision WHERE workflow_id=?').get(design)!.n;
  await assert.rejects(decideFormalGate(f.db, f.config, design, 'face_appearance', true, 'blind approve', gate.artifactHash), /实际脸型效果/);
  await assert.rejects(decideFormalGate(f.db, f.config, design, 'face_appearance', true, 'fake preview', gate.artifactHash, undefined, { previewSha256: 'a'.repeat(64) }), /图片已变化|实际效果|实际脸型/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM gate_decision WHERE workflow_id=?').get(design)!.n, before);
  assert.equal(f.stages(design).make, 'blocked');
});

function candidateFixture(t:TestContext) {
  const f=fixture(t),source=join(f.root,'candidate');
  mkdirSync(join(source,'knowledge/process'),{recursive:true});mkdirSync(join(source,'knowledge/SOP'),{recursive:true});mkdirSync(join(source,'tools'),{recursive:true});
  writeFileSync(join(source,'pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:'synthetic-candidate',version:'1-candidate',channel:'candidate',description:'test'}));
  const candidateProcess=structuredClone(PROCESS) as typeof PROCESS;
  for(const [index,check] of candidateProcess.checks.entries()){const ref=`${index+1}`.repeat(12);Object.assign(check,{source_id:ref,verification:[{kind:'sop-editorial',ref}],kind:'spec'});}
  writeFileSync(join(source,'knowledge/process/synthetic-formal.process.yaml'),stringify(candidateProcess));
  writeFileSync(join(source,'knowledge/process/synthetic-formal.capabilities.yaml'),stringify(CAPABILITIES));
  writeFileSync(join(source,'knowledge/process/thresholds.yaml'),stringify({schema:'thresholds/0.1',version:'t1',t:{
    min_items:{value:2,unit:'items',maturity:'accepted',source:'test',source_id:'111111111111',verification:[{kind:'sop-editorial',ref:'111111111111'}],kind:'spec'},
    max_items:{value:4,unit:'items',maturity:'accepted',source:'test',source_id:'222222222222',verification:[{kind:'sop-editorial',ref:'222222222222'}],kind:'spec'}}}));
  writeFileSync(join(source,'knowledge/SOP/plan.md'),'# 候选上下文\n## 核心\n候选核心\n## 无造型\n候选缺口\n');
  for(const name of [...Object.keys(OBSERVERS),'make.mjs'])writeFileSync(join(source,'tools',name),readFileSync(join(f.config.toolRoot,name)));
  registerPackCandidate(f.db,f.home,source,{basePackId:'baseline',sourceKind:'ai',reason:'project trial',impact:{},permissions:{network:false,writes:['project','run']}});
  recordPackEvaluation(f.db,'synthetic-candidate',{suiteId:'s',suiteVersion:'1',isolation:'bwrap',baselineResults:[
    {caseId:'c',modelFamily:'codex',attempt:1,result:'pass',evidenceRef:'b'}],results:[
    {caseId:'c',modelFamily:'codex',attempt:1,result:'pass',evidenceRef:'c'}]});
  f.db.prepare("INSERT INTO workspace(id,path) VALUES('trial-ws',?)").run(f.config.workspaceRoot);
  f.db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES('trial-project','trial-ws','sample',?,'{}','active','h','k')`).run(f.project);
  return {...f,source};
}

test('an approved local candidate is frozen only into a new workflow for its project',t=>{
  const f=candidateFixture(t);
  approveCandidateTrial(f.db,'trial-project','synthetic-candidate','tester');
  const id=createWorkflow(f.db,f.config,'sample','synthetic-formal',f.manifestPath,{candidateId:'synthetic-candidate'});
  const snapshot=workflowSnapshot(f.db,id);
  assert.match(posixPath(snapshot.toolRoot), /managed\/candidates\/synthetic-candidate\/tools$/);
  assert.equal(snapshot.contexts['SOP/plan.md']!.content,'# 候选上下文\n## 核心\n候选核心\n## 无造型\n候选缺口\n');
  assert.match(String((f.db.prepare('SELECT knowledge_version FROM workflow WHERE id=?').get(id) as {knowledge_version:string}).knowledge_version),
    /^candidate:synthetic-candidate:[0-9a-f]{64}$/);
  assert.equal(candidateTrials(f.db,'trial-project')[0]!.status,'active');
  assert.equal(f.config.toolRoot.endsWith('/managed/candidates/synthetic-candidate/tools'),false,'global config remains unchanged');
});

function maintenanceFixture(t:TestContext) {
  const f=candidateFixture(t),base=join(f.home,'managed/packs/baseline');
  cpSync(f.source,base,{recursive:true});
  writeFileSync(join(base,'pack.json'),JSON.stringify({schema:'harness-managed-pack/0.1',id:'baseline',version:'1',channel:'stable'}));
  writeFileSync(join(base,'knowledge/SOP/plan.md'),'# 基线上下文\n## 核心\n正式核心\n## 无造型\n正式缺口\n');
  f.config.knowledgeRoot=join(base,'knowledge');f.config.toolRoot=join(base,'tools');
  const choose=(candidateId:string|null,scope:'project'|'local'='project',commandId=crypto.randomUUID())=>{
    const view=localMaintenanceView(f.db,f.config,'trial-project');
    return adoptLocalCandidate(f.db,f.config,'trial-project',{scope,candidateId,expectedHash:view.candidates.find(c=>c.id===candidateId)?.contentHash,
      expectedToken:view.token,commandId},'test-user');
  };
  return {...f,base,choose};
}

test('ordinary production consumes local adoption, freezes it, and rollback only changes successor workflows',t=>{
  const f=maintenanceFixture(t);
  const unadopted=createWorkflow(f.db,f.config,f.project,'synthetic-formal',f.manifestPath);
  assert.match(workflowSnapshot(f.db,unadopted).contexts['SOP/plan.md']!.content,/正式核心/,'an evaluated candidate alone never enables a local policy');
  assert.equal(localMaintenanceIdentity(f.db,'trial-project'),null);
  f.db.prepare("UPDATE workflow SET status='cancelled' WHERE id=?").run(unadopted);
  f.choose('synthetic-candidate');
  const context=productionContext(f.db,'trial-project');assert.match(context,/localMaintenance/);
  const source=join(f.root,'input.unitypackage');writeFileSync(source,'approved bytes');
  f.db.prepare("INSERT INTO asset(id,path,name,kind) VALUES('body',?,'Body','avatar')").run(source);
  f.db.prepare("INSERT INTO project_asset(project_id,asset_id,role) VALUES('trial-project','body','source')").run();
  const interaction=submitInteraction(f.db,'trial-project',{content:'制作一个本地修复样例',commandId:'request'});
  f.db.prepare(`INSERT INTO production_proposal(id,project_id,revision,profile,request,inputs_json,context_json,status)
    VALUES(?,'trial-project',?,'synthetic-formal','原要求',?,?,'proposed')`).run(interaction.id,interaction.revision,
      JSON.stringify([{id:'body',path:source,kind:'avatar',name:'Body',role:'source',sha256:createHash('sha256').update('approved bytes').digest('hex')}]),productionContext(f.db,'trial-project'));
  const workflow=approveProduction(f.db,f.config,interaction.id,'approve',interaction.revision);
  const frozen=workflowSnapshot(f.db,workflow);
  assert.match(frozen.contexts['SOP/plan.md']!.content,/候选核心/);
  assert.match(String(f.db.prepare('SELECT knowledge_version FROM workflow WHERE id=?').get(workflow)!.knowledge_version),/^local:/);
  f.choose(null);
  assert.match(workflowSnapshot(f.db,workflow).contexts['SOP/plan.md']!.content,/候选核心/,'rollback never changes an in-flight snapshot');
  assert.equal(localWorkflowSelection(f.db,f.config,'trial-project','synthetic-formal'),undefined);
  f.db.prepare("UPDATE workflow SET status='cancelled' WHERE id=?").run(workflow);
  const successor=createWorkflow(f.db,f.config,f.project,'synthetic-formal',f.manifestPath);
  assert.match(workflowSnapshot(f.db,successor).contexts['SOP/plan.md']!.content,/正式核心/);
});

test('local selection CAS rejects stale commands, candidate drift, and changed upstream; project override survives a local default',t=>{
  const f=maintenanceFixture(t),view=localMaintenanceView(f.db,f.config,'trial-project'),candidate=view.candidates[0]!;
  const input={scope:'local' as const,candidateId:candidate.id,expectedHash:candidate.contentHash,expectedToken:view.token,commandId:'same'};
  const first=adoptLocalCandidate(f.db,f.config,'trial-project',input,'test-user');
  assert.equal(adoptLocalCandidate(f.db,f.config,'trial-project',input,'test-user').id,first.id,'lost response is idempotent');
  assert.throws(()=>adoptLocalCandidate(f.db,f.config,'trial-project',{...input,commandId:'stale'},'test-user'),/状态已变化/);
  f.choose(null);assert.equal(localMaintenanceIdentity(f.db,'trial-project')!.candidateId,null,'project selection overrides local default');
  f.choose(candidate.id);
  writeFileSync(join(f.base,'knowledge/SOP/plan.md'),'upstream changed');
  assert.throws(()=>createWorkflow(f.db,f.config,f.project,'synthetic-formal',f.manifestPath),/共同基线不同/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow').get()!.n,0,'upstream conflict never creates a partial workflow');
  writeFileSync(join(f.home,'managed/candidates/synthetic-candidate/knowledge/SOP/plan.md'),'unreviewed');
  const unavailable=localMaintenanceView(f.db,f.config,'trial-project');
  assert.equal(unavailable.candidates[0]!.ready,false);assert.match(unavailable.candidates[0]!.problem!,/候选内容已变化/);
  assert.match(unavailable.currentProblem!,/候选内容已变化/);
  assert.throws(()=>f.choose(candidate.id),/no longer matches/);
});

test('smoke cannot enable local default and changing adoption invalidates an ordinary pending proposal',t=>{
  const f=maintenanceFixture(t);
  f.db.prepare("UPDATE managed_pack_evaluation SET suite_id='managed-pack-smoke'").run();
  assert.throws(()=>f.choose('synthetic-candidate','local'),/结构检查不足/);
  const interaction=submitInteraction(f.db,'trial-project',{content:'制作样例',commandId:'request'});
  f.db.prepare(`INSERT INTO production_proposal(id,project_id,revision,profile,request,inputs_json,context_json,status)
    VALUES(?,'trial-project',?,'synthetic-formal','原要求','[]',?,'proposed')`).run(interaction.id,interaction.revision,productionContext(f.db,'trial-project'));
  f.choose('synthetic-candidate');
  assert.throws(()=>approveProduction(f.db,f.config,interaction.id,'approve',interaction.revision),/已更新/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow').get()!.n,0);
});

test('a local selection row without its user decision receipt cannot authorize a workflow',t=>{
  const f=maintenanceFixture(t);f.choose('synthetic-candidate');
  f.db.prepare("UPDATE local_pack_adoption SET command_id='unapproved-row'").run();
  assert.throws(()=>createWorkflow(f.db,f.config,f.project,'synthetic-formal',f.manifestPath),/缺少对应的用户决定回执/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM workflow').get()!.n,0);
});

test('local adoption cannot weaken a fixed blocking rule by changing only its threshold table',t=>{
  const f=maintenanceFixture(t),thresholds=join(f.source,'knowledge/process/thresholds.yaml');
  const manifest=JSON.parse(readFileSync(join(f.source,'pack.json'),'utf8'));manifest.id='synthetic-weaker';
  writeFileSync(join(f.source,'pack.json'),JSON.stringify(manifest));
  writeFileSync(thresholds,readFileSync(thresholds,'utf8').replace('value: 2','value: 0'));
  registerPackCandidate(f.db,f.home,f.source,{basePackId:'baseline',sourceKind:'ai',reason:'weakened threshold',impact:{},permissions:{}});
  recordPackEvaluation(f.db,'synthetic-weaker',{suiteId:'s',suiteVersion:'1',isolation:'bwrap',baselineResults:[
    {caseId:'c',modelFamily:'codex',attempt:1,result:'pass',evidenceRef:'b'}],results:[
    {caseId:'c',modelFamily:'codex',attempt:1,result:'pass',evidenceRef:'c'}]});
  assert.throws(()=>f.choose('synthetic-weaker'),/cannot change acceptance threshold min_items/);
  assert.equal(localMaintenanceIdentity(f.db,'trial-project'),null);
});

test('artifact fingerprints cover tracked and untracked members, ignore ignored files, and notice deletion', t => {
  const f = fixture(t);
  const spec = { paths: ['scene'] };
  assert.equal(artifactFingerprint(f.project, spec), undefined, 'absent is not empty');
  mkdirSync(join(f.project, 'scene')); writeFileSync(join(f.project, 'scene/a'), '1'); writeFileSync(join(f.project, 'scene/b'), '2');
  const first = artifactFingerprint(f.project, spec)!;
  execFileSync('git', ['-C', f.project, 'add', 'scene/a']);
  assert.equal(artifactFingerprint(f.project, spec), first, 'staging does not change content');
  writeFileSync(join(f.project, 'scene/b'), '3');
  assert.notEqual(artifactFingerprint(f.project, spec), first);
  rmSync(join(f.project, 'scene/a'));
  assert.deepEqual(artifactFiles(f.project, spec), ['scene/b'], 'a tracked file that was deleted is not a member');
  mkdirSync(join(f.project, 'Library')); writeFileSync(join(f.project, 'Library/cache'), 'x');
  assert.equal(artifactFingerprint(f.project, { paths: ['Library'] }), undefined, 'ignored files are not artifacts by default');
  assert.ok(artifactFingerprint(f.project, { paths: ['Library'], includeIgnored: true }));
});

test('a Workflow is refused when no Provider can take one of its stage roles', t => {
  const f = fixture(t); const providers = f.config.providers;
  f.config.providers = providers.map(provider => ({ ...provider, roles: ['research'] }));
  assert.throws(() => createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath),
    /暂时无法开始制作：executor：没有执行方配置这个角色/);
  f.config.providers = providers.map(provider => ({ ...provider, executable: join(tmpdir(), 'avh-no-such-cli') }));
  assert.throws(() => createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath),
    /executor：fake 在 Runtime 的环境里无法启动或未登录/);
  // A pi Provider without its key says what is missing, looked up in the Harness home the configuration names.
  f.config.providers = [{ ...providers[0]!, id: 'deepseek', adapter: 'pi-cli', upstream: 'deepseek', roles: ['executor'] }];
  assert.throws(() => createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath),
    /executor：deepseek 还没有保存 API 密钥（在设置里填写），pi 也无法启动/);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM workflow WHERE process_hash <> 'avh-task/0.1'").get() as { n: number }).n, 0);
});

test('manifest v0.1: the user request is required and the profile must match', () => {
  const good = { schema: 'manifest/0.1', profile: 'p', assets: [{ store: 'library', item: '1', role: 'outfit', variant: 'X' }], request: '原话',
    faceConcept: '共同脸', variants: [{ id: 'winter', name: '冬装', description: '暖色', assets: [{ item: '1', role: 'used' }] }] };
  assert.equal(parseManifest(stringify(good), 'p').assets[0]!.variant, 'X');
  assert.equal(parseManifest(stringify({ ...good, assets: [{ ...good.assets[0], sha256: 'a'.repeat(64) }] })).assets[0]!.sha256, 'a'.repeat(64));
  assert.throws(() => parseManifest(stringify({ ...good, assets: [{ ...good.assets[0], sha256: 'invalid' }] })), /sha256/);
  assert.equal(parseManifest(stringify(good), 'p').variants?.[0]?.assets[0]?.role, 'used');
  assert.throws(() => parseManifest(stringify(good), 'q'), /不一致/);
  assert.throws(() => parseManifest(stringify({ ...good, request: '' })), /request/);
  assert.throws(() => parseManifest(stringify({ ...good, assets: [{ store: 'shop', item: '1' }] })), /store/);
  assert.throws(() => parseManifest(stringify({ ...good, variants: [{ ...good.variants[0], assets: [{ item: '1', role: 'maybe' }] }] })), /role/);
});

test('approved production creates one formal workflow with pinned inputs and retries return its receipt', async t => {
  const f = fixture(t);
  const initial = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await cancelWorkflow(f.db, f.config, initial, 'Prepare proposal test');
  const projectId = String(f.db.prepare('SELECT project_id FROM workflow WHERE id=?').get(initial)!.project_id);
  const source = join(f.root, 'input.unitypackage'); writeFileSync(source, 'approved bytes');
  f.db.prepare("INSERT INTO asset(id,path,name,kind) VALUES('body',?,'Body','avatar')").run(source);
  f.db.prepare("INSERT INTO project_asset(project_id,asset_id,role) VALUES(?,'body','source')").run(projectId);
  const reference=join(f.root,'reference.png');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6AAAAAElFTkSuQmCC','base64');
  writeFileSync(reference,png);
  f.db.prepare("INSERT INTO asset(id,path,name,kind) VALUES('reference',?,'Reference','other')").run(reference);
  f.db.prepare("INSERT INTO project_asset(project_id,asset_id,role) VALUES(?,'reference','source')").run(projectId);
  const interaction = submitInteraction(f.db, projectId, { content: 'Make this', commandId: 'request' });
  recordIntent(f.db,projectId,interaction.id,interaction.revision,[{object:'avatar',attribute:'goal',content:'Make this',
    sourceMessageId:interaction.id,quote:'Make this'}]);
  const sha256 = createHash('sha256').update('approved bytes').digest('hex');
  f.db.prepare(`INSERT INTO production_proposal(id,project_id,revision,profile,request,inputs_json,context_json,status)
    VALUES(?,?,?,?,?,?,?,'proposed')`).run(interaction.id, projectId, interaction.revision, 'synthetic-formal', 'Make this',
    JSON.stringify([{ id: 'body', path: source, kind: 'avatar', name: 'Body', role: 'source', sha256 }]), productionContext(f.db, projectId));
  writeFileSync(reference,Buffer.concat([png,Buffer.from('changed')]));
  assert.throws(()=>approveProduction(f.db,f.config,interaction.id,'approval',interaction.revision),/参考图已更新/);
  assert.equal(f.db.prepare('SELECT status FROM production_proposal WHERE id=?').get(interaction.id)!.status,'proposed');
  writeFileSync(reference,png);
  const workflow = approveProduction(f.db, f.config, interaction.id, 'approval', interaction.revision);
  assert.equal(approveProduction(f.db, f.config, interaction.id, 'approval', interaction.revision), workflow);
  assert.throws(() => approveProduction(f.db, f.config, interaction.id, 'other-approval', interaction.revision), /已处理/);
  assert.equal(workflowSnapshot(f.db, workflow).manifest!.assets[0]!.sha256, sha256);
  const snapshot=workflowSnapshot(f.db,workflow);
  assert.equal(snapshot.manifest!.referenceImages!.length,1,'reference is independent of chosen importable assets');
  const image=snapshot.manifest!.referenceImages![0]!;
  writeFileSync(reference,'original source changed after approval');
  const stage=snapshot.definition.stages.find(s=>s.id==='plan')!;
  const spec=stageTaskSpec(snapshot,stage,{},snapshot.toolRoot,f.project);
  assert.deepEqual(spec.inputImages,[image]);
  assert.deepEqual(readFileSync(join(f.project,image.path)),png);
  assert.match(spec.goal,/实际图片附件/);
  writeFileSync(join(f.project,image.path),Buffer.concat([png,Buffer.from('tampered')]));
  assert.throws(()=>stageTaskSpec(snapshot,stage,{},snapshot.toolRoot,f.project),/版本已改变/);
  writeFileSync(join(f.project,image.path),png);
  writeFileSync(reference,png);
  assert.deepEqual(snapshot.manifest!.requirements,currentIntent(f.db,projectId));
  const requirement=snapshot.manifest!.requirements![0]!;
  const changed=submitInteraction(f.db,projectId,{content:'Make something else',commandId:'later',expectedRevision:1});
  recordIntent(f.db,projectId,changed.id,changed.revision,[{object:'avatar',attribute:'goal',content:'Make something else',
    sourceMessageId:changed.id,quote:'Make something else',replaces:requirement.id}]);
  assert.equal(workflowSnapshot(f.db,workflow).manifest!.requirements![0]!.content,'Make this','running production retains its frozen requirements');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM workflow WHERE status='active'").get()!.n, 1);
  assert.equal(f.db.prepare('SELECT status FROM production_proposal WHERE id=?').get(interaction.id)!.status, 'working');
});

test('formal Workflow: plan Gate, not-applicable stage, UPLOAD_READY, and a revised plan that makes the approval stale',
  { skip: !checkSandboxStatus().available && 'observers run in the check sandbox' }, async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  const frozen = workflowSnapshot(f.db, id);
  assert.equal(frozen.contexts['SOP/plan.md']!.content, '# 方案规范\n## 核心\n只能使用已选素材。\n## 无造型\n没有造型时先保留审美缺口。\n');
  writeFileSync(join(f.config.knowledgeRoot, 'SOP/plan.md'), '# 后来改动，不应进入既有 Workflow\n');
  assert.throws(() => createWorkflow(f.db, f.config, 'sample', 'synthetic-formal'), /进行中的正式 Workflow/);
  await f.tick();
  const durableState = readFileSync(join(f.project, '_harness/state/project.yaml'), 'utf8');
  assert.match(durableState, /stage: plan[\s\S]*status: WAITING_HUMAN/);
  assert.match(durableState, /stages:[\s\S]*id: plan[\s\S]*status: blocked/);
  const createdTask = describeWorkflow(f.db, id).stages[0]!.task!.id;
  const frozenGoal = new StageRouter(f.db, f.config, workflowSnapshot(f.db, id)).router(createdTask).spec.goal;
  assert.match(frozenGoal, /Harness 上下文计划：已用/);
  assert.match(frozenGoal, /以下是 Harness 编译并冻结的规范输入/);
  assert.match(frozenGoal, /注入 plan-core：必选条目/);
  assert.match(frozenGoal, /注入 empty-variant-guidance：触发条件成立/);
  assert.match(frozenGoal, /没有造型时先保留审美缺口/);
  assert.match(frozenGoal, /覆盖 plan\.constraints/);
  assert.match(frozenGoal, /只能使用已选素材/);
  assert.match(frozenGoal, /Harness 提供的冻结工具/);
  assert.match(frozenGoal, /inspect-input: "node"/);
  // The tool commands are shown as JSON strings, where a Windows path has its backslashes doubled.
  assert.match(frozenGoal, new RegExp(escapeRegExp(JSON.stringify(f.config.toolRoot).slice(1, -1))));
  assert.doesNotMatch(frozenGoal, /后来改动/);
  assert.deepEqual(f.stages(id), { plan: 'blocked', make: 'waiting', extra: 'waiting' });
  assert.match(describeWorkflow(f.db, id).stages[0]!.task!.status, /WAITING_HUMAN/);
  const gate = formalGates(f.db, id).find(item => item.gate.endsWith(':plan_approval'))!;
  assert.equal(gate.status, 'pending');
  assert.match(describeWorkflow(f.db, id).next, /需要你决定：plan_approval/);
  assert.match(gateList(f.db), /plan_approval\tstage:plan\tsample\tpending\tapprove plan/);
  await assert.rejects(decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok', 'not-the-hash'), /已变化/);
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, '看过方案');
  await f.tick(); await f.tick();
  assert.deepEqual(f.stages(id), { plan: 'passed', make: 'passed', extra: 'not_applicable' });
  assert.equal(describeWorkflow(f.db, id).status, 'upload_ready');
  assert.equal(listWorkflows(f.db)[0]!.stagesPassed, 3);
  const verdict = describeWorkflow(f.db, id).stages[1]!.checks[0]!.verdict!;
  assert.equal(verdict.result, 'pass'); assert.equal(verdict.current, true);
  assert.match(verdict.basis!, /items=2/);
  // A conclusion's identity is read from the Runtime's own rows: which artifact and version was judged, over what
  // scope, by which method, and when. Nothing here is composed by an interface or invented by a model.
  const sceneCheck = describeWorkflow(f.db, id).stages[1]!.checks[0]!;
  assert.equal(sceneCheck.on, 'scene');
  assert.equal(sceneCheck.scope, 'edit');
  assert.equal(sceneCheck.maturity, 'accepted');
  assert.match(sceneCheck.rule, /items/);
  assert.match(verdict.artifactHash, /^[0-9a-f]{8,}$/);
  assert.equal(verdict.artifactHash, verdict.boundHash, 'a current verdict still matches the artifact it binds');
  assert.match(verdict.recordedAt, /^\d{4}-\d{2}-\d{2}/);
  // The executor never saw its own work judged: the goal lists the checks the Runtime will measure.
  assert.equal(f.executor.starts.filter(spec => spec.stageId === 'extra').length, 0);

  // A revised plan: the approval no longer covers it and nothing downstream counts until it is approved again.
  f.executor.plan = { title: 'Sample v2', extra: false };
  writeFileSync(join(f.project, '_harness/plan.yaml'), JSON.stringify(f.executor.plan));
  await f.tick();
  const view = describeWorkflow(f.db, id);
  assert.equal(view.status, 'active');
  assert.equal(view.plan.revisions, 2);
  assert.equal(formalGates(f.db, id).find(item => item.gate.endsWith(':plan_approval'))!.status, 'stale');
  assert.equal(view.stages[0]!.status, 'blocked');
  assert.equal(view.stages[1]!.status, 'waiting');
  // A revised plan leaves the previous verdict behind. The point of the projection is that a reader can re-derive that
  // from the record itself instead of being told it: `current` must be the identity comparison, for every check.
  for (const stage of view.stages) for (const check of stage.checks) {
    if (!check.verdict) continue;
    assert.match(check.verdict.artifactHash, /^[0-9a-f]{8,}$/, `${check.id}: which version was judged`);
    assert.equal(check.verdict.current,
      Boolean(check.verdict.boundHash) && check.verdict.artifactHash === check.verdict.boundHash && check.verdict.scope === check.scope,
      `${check.id}: the current flag must follow from the exposed identity, not stand on its own`);
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE workflow_id = ? AND action = 'upload_ready->active'").get(id)!.n, 1);
});

test('formal Workflow: a metric the observer could not measure blocks the stage as no_data',
  { skip: !checkSandboxStatus().available && 'observers run in the check sandbox' }, async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok');
  f.executor.items = ['a', 'b', 'unmeasured'];
  await f.tick(); await f.tick();
  const make = describeWorkflow(f.db, id).stages[1]!;
  assert.equal(make.task!.status, 'BLOCKED');
  assert.equal(make.checks[0]!.verdict!.result, 'no_data');
  assert.match(make.checks[0]!.verdict!.basis!, /broken=缺/);
  assert.match(describeWorkflow(f.db, id).next, /阶段 make 检查未通过/);
});

test('formal Workflow: an unreadable plan has no fingerprint, so nothing is judged against it', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  mkdirSync(join(f.project, '_harness'));
  writeFileSync(join(f.project, '_harness/plan.yaml'), 'title: [unclosed');
  await serveOnce(f.db, f.config, () => ({ start: () => ({ ref: 'never' }), observe: () => ({ state: 'running' as const }),
    cancel: () => 'confirmed' as const, collect: () => ({ exitStatus: 0, outputs: {} }) }));
  const view = describeWorkflow(f.db, id);
  assert.equal(view.plan.hash, undefined);
  assert.match(view.plan.error!, /./);
  assert.match(view.next, /方案文件无法读取/);
  assert.equal(f.db.prepare("SELECT plan_json FROM workflow WHERE id = ?").get(id)!.plan_json, '{}');
});

test('cancelling a formal Workflow cancels its unfinished Tasks first', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  const held: Executor = { start: () => ({ ref: 'held' }), observe: () => ({ state: 'running' }), cancel: () => 'confirmed',
    collect: () => ({ exitStatus: 143, outputs: {} }) };
  await serveOnce(f.db, f.config, () => held);
  const task = describeWorkflow(f.db, id).stages[0]!.task!;
  assert.equal(task.status, 'RUNNING');
  const result = await cancelWorkflow(f.db, f.config, id, '用户改主意', held);
  assert.equal(result.confirmed, true);
  assert.equal(describeWorkflow(f.db, id).status, 'cancelled');
  assert.equal(describeWorkflow(f.db, id).next, '已取消');
  assert.deepEqual((await cancel(f.db, f.config, task.id, held)).residue, []);
});

/** A unit a serve cycle launched; it exits on its own, while its Workflow may already be cancelled. */
class DispatchedUnit implements Executor {
  state: 'running' | 'exited' = 'running';
  stopConfirmed = true;
  start(spec: RunSpec): RunHandle { return { ref: `unit-${spec.runId}` }; }
  observe(): { state: 'running' | 'exited' } { return { state: this.state }; }
  cancel(): 'confirmed' | 'not_confirmed' { return this.stopConfirmed ? 'confirmed' : 'not_confirmed'; }
  collect(): RunResult { return { exitStatus: 0, outputs: {} }; }
}

test('a Workflow cancelled mid-dispatch leaves no RUNNING Task, running Run or permanent project lock', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  const unit = new DispatchedUnit();
  // A serve cycle froze this Workflow as active and built its scheduler; the person then cancels it in another
  // process (`avh workflow cancel`). That frozen cycle still dispatches a stage, and from then on nothing ticks
  // this Workflow again — so the Run it left holds its project lock with no one to release it.
  const stale = workflowScheduler(f.db, f.config, id, unit, workflowSnapshot(f.db, id));
  const cancelled = await cancelWorkflow(f.db, f.config, id, '用户改主意');
  assert.deepEqual({ confirmed: cancelled.confirmed, tasks: cancelled.tasks.length }, { confirmed: true, tasks: 0 },
    'nothing was open to cancel at the moment the person cancelled');
  await stale.tick();
  const task = f.db.prepare('SELECT id, status FROM task WHERE workflow_id = ?').get(id) as { id: string; status: string };
  const run = f.db.prepare('SELECT id, status FROM run WHERE task_id = ?').get(task.id) as { id: string; status: string };
  const project = (f.db.prepare('SELECT project_id FROM workflow WHERE id = ?').get(id) as { project_id: string }).project_id;
  const locks = () => (f.db.prepare('SELECT resource, lease_until FROM lock ORDER BY resource').all() as
    { resource: string; lease_until: string }[]).map(row => `${row.resource}@${row.lease_until}`);
  assert.equal(task.status, 'RUNNING');
  assert.equal(run.status, 'running');
  assert.deepEqual(locks(), [`project:${project}@9999-12-31T23:59:59Z`]);
  // The unit finishes on its own. No cycle will ever observe that, because the Workflow is cancelled.
  unit.state = 'exited';
  await serveOnce(f.db, f.config, () => unit);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(task.id) as { status: string }).status, 'CANCELLED');
  assert.equal((f.db.prepare('SELECT status FROM run WHERE id = ?').get(run.id) as { status: string }).status, 'cancelled');
  assert.deepEqual(locks(), []);
});

test('a unit that will not confirm it stopped keeps its Task, Run and lock after its Workflow is cancelled', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  const unit = new DispatchedUnit();
  unit.stopConfirmed = false;
  const stale = workflowScheduler(f.db, f.config, id, unit, workflowSnapshot(f.db, id));
  await cancelWorkflow(f.db, f.config, id, '用户改主意');
  await stale.tick();
  const task = f.db.prepare('SELECT id, status FROM task WHERE workflow_id = ?').get(id) as { id: string; status: string };
  const run = f.db.prepare('SELECT id, status FROM run WHERE task_id = ?').get(task.id) as { id: string; status: string };
  assert.equal(task.status, 'RUNNING');
  const project = (f.db.prepare('SELECT project_id FROM workflow WHERE id = ?').get(id) as { project_id: string }).project_id;
  await serveOnce(f.db, f.config, () => unit);
  await serveOnce(f.db, f.config, () => unit);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(task.id) as { status: string }).status, 'RUNNING',
    'a unit still holding its project must not be closed as residue');
  assert.equal((f.db.prepare('SELECT status FROM run WHERE id = ?').get(run.id) as { status: string }).status, 'running');
  assert.deepEqual((f.db.prepare('SELECT resource FROM lock').all() as { resource: string }[]).map(row => row.resource),
    [`project:${project}`]);
  assert.equal((f.db.prepare(`SELECT count(*) AS n FROM event WHERE entity_type = 'task' AND entity_id = ?
    AND action = 'abandoned_task_unconfirmed'`).get(task.id) as { n: number }).n, 1,
  'why the residue is still there is recorded once, not on every cycle');
});

test('avh workflow create, list and show from the command line', t => {
  const f = fixture(t);
  const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, AVH_HOME: f.home } });
  const created = run('workflow', 'create', 'sample', '--profile', 'synthetic-formal', '--manifest', f.manifestPath);
  assert.equal(created.status, 0, created.stderr);
  const id = /Workflow: (\S+)/.exec(created.stdout)![1]!;
  assert.match(run('workflow', 'list').stdout, new RegExp(`${id}\\tsample\\tsynthetic-formal\\tactive\\t0/3`));
  const shown = run('workflow', 'show', id);
  assert.match(shown.stdout, /需求: 做一个两件道具的样例/);
  assert.match(shown.stdout, /下一步: /);
  assert.match(run('workflow', 'cancel', id).stderr, /--note/);
  assert.equal(readdirSync(join(f.home, 'state')).includes('harness.db'), true);
});

test('a tool stage runs as a supervised unit under the write boundary and reaches UPLOAD_READY',
  { skip: process.env.AVH_SYSTEMD_IT !== '1' && 'needs the user systemd manager and bwrap (AVH_SYSTEMD_IT=1)' }, async t => {
  const f = fixture(t);
  const toolProcess = { ...PROCESS, id: 'tool-only', artifacts: ['scene'],
    stages: [{ id: 'make', needs: [], produces: ['scene'], requires: ['scene_items'], gates: [], invalidated_by: [] }],
    checks: [PROCESS.checks[1]], gates: [], milestones: [{ id: 'UPLOAD_READY', requires_stages: 'all', evidence_on: 'scene' }] };
  const toolCapabilities = { schema: 'capabilities/0.1', process: 'tool-only', version: '1', artifacts: { scene: { paths: ['scene'] } },
    stages: { make: { mode: 'tool', command: [process.execPath, '{toolRoot}/make.mjs'], allowedWrites: ['scene/'] } },
    observers: { 'scene.count': CAPABILITIES.observers['scene.count'] } };
  const knowledge = join(f.root, 'knowledge');
  writeFileSync(join(knowledge, 'tool.process.yaml'), stringify(toolProcess));
  writeFileSync(join(knowledge, 'tool.capabilities.yaml'), stringify(toolCapabilities));
  writeFileSync(join(f.root, 'tools', 'make.mjs'), `import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const project = process.env.AVH_PROJECT_DIR;
mkdirSync(join(project, 'scene'), { recursive: true });
// Clears its own output directory first, as a packaging tool does: nothing the sandbox put there may be in the way.
for (const name of readdirSync(join(project, 'scene'))) rmSync(join(project, 'scene', name), { recursive: true });
writeFileSync(join(project, 'scene/a'), 'a'); writeFileSync(join(project, 'scene/b'), 'b');
try { writeFileSync(join(project, 'escape.txt'), 'outside allowedWrites'); } catch { /* the boundary refuses */ }
`);
  const configPath = join(f.home, 'config/harness.yaml');
  const raw = (await import('yaml')).parse((await import('node:fs')).readFileSync(configPath, 'utf8'));
  raw.processDefinitions['tool-only'] = { definition: 'tool.process.yaml', capabilities: 'tool.capabilities.yaml' };
  writeFileSync(configPath, stringify(raw));
  const config = loadConfig(f.home);
  const id = createWorkflow(f.db, config, 'sample', 'tool-only');
  const view = await waitFor(async () => { await serveOnce(f.db, config); return describeWorkflow(f.db, id); },
    { what: 'the tool-only workflow to reach upload_ready', ready: workflow => workflow.status === 'upload_ready',
      timeoutMs: 60_000, intervalMs: 200, detail: () => JSON.stringify(describeWorkflow(f.db, id).stages[0]) });
  assert.equal(view.status, 'upload_ready', JSON.stringify(view.stages[0]));
  assert.equal((await import('node:fs')).existsSync(join(f.project, 'escape.txt')), false, 'the tool could not write outside its allowed paths');
  const run = f.db.prepare("SELECT id, provider, result_json FROM run WHERE task_id = ?").get(view.stages[0]!.task!.id) as
    { id: string; provider: string; result_json: string };
  assert.equal(run.provider, 'tool');
  const command = JSON.parse(readFileSync(join(f.home, 'runs', run.id, 'command.json'), 'utf8')) as { sandbox: string };
  assert.equal(command.sandbox, 'bwrap', 'a tool runs under the Runtime\'s own mounts when bwrap is available');
});

test('a new artifact version says which members were added, removed or changed', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok');
  await f.tick(); await f.tick();
  assert.equal(describeWorkflow(f.db, id).status, 'upload_ready');
  // A Runtime that starts without the member lists (an upgrade, a lost directory) keeps one as soon as it looks.
  rmSync(join(f.home, 'artifacts'), { recursive: true, force: true });
  await f.tick();
  // Someone edits the stage's output by hand: one file changed, one removed, one added.
  const before = (f.db.prepare('SELECT MAX(seq) AS seq FROM event').get() as { seq: number }).seq;
  writeFileSync(join(f.project, 'scene', 'a'), 'edited');
  rmSync(join(f.project, 'scene', 'b'));
  writeFileSync(join(f.project, 'scene', 'c'), 'new');
  await f.tick();
  const event = f.db.prepare(`SELECT reason, payload_json FROM event WHERE entity_type = 'artifact_version' AND entity_id = 'scene'
    AND seq > ? ORDER BY seq LIMIT 1`).get(before) as { reason: string; payload_json: string };
  assert.equal(event.reason, 'fingerprint changed: 增 1（scene/c）；删 1（scene/b）；改 1（scene/a）');
  assert.deepEqual((JSON.parse(event.payload_json) as { change: unknown }).change,
    { added: ['scene/c'], removed: ['scene/b'], modified: ['scene/a'], counts: [1, 1, 1] });
});

/**
 * The scheduler must not rescan every settled Workflow every round: one large project's scan takes tens of seconds.
 * Throttling delays detection by at most one window; it must not drop it, so the edit below still reopens the stage.
 */
test('a settled Workflow is rescanned on the idle window, and a changed artifact still reopens its stage', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  // The cadence belongs to the serving loop, so one cadence spans the whole test's rounds, as it does in `serve`.
  const cadence = newFingerprintCadence();
  const round = () => serveOnce(f.db, f.config, () => f.executor, undefined, { idleFingerprintRefreshMs: 60_000, idleFingerprintCadence: cadence });
  await round();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok');
  await round(); await round();
  assert.equal(describeWorkflow(f.db, id).status, 'upload_ready');
  const sceneVersions = () => Number((f.db.prepare(`SELECT count(*) AS n FROM artifact_version
    WHERE workflow_id = ? AND kind = 'scene'`).get(id) as { n: number }).n);
  const makeTasks = () => Number((f.db.prepare(`SELECT count(*) AS n FROM task
    WHERE workflow_id = ? AND stage_id = 'make'`).get(id) as { n: number }).n);
  const before = sceneVersions();
  writeFileSync(join(f.project, 'scene', 'a'), 'edited by hand');
  // Inside the idle window the settled Workflow is not rescanned: no new version, no stage reopened.
  await round();
  assert.equal(sceneVersions(), before, 'a settled Workflow is not rescanned inside the idle window');
  assert.equal(makeTasks(), 1);
  // Once the window elapses the same edit is found and the stage reopens with the original semantics.
  await new Promise(resolve => setTimeout(resolve, 80));
  await serveOnce(f.db, f.config, () => f.executor, undefined, { idleFingerprintRefreshMs: 40, idleFingerprintCadence: cadence });
  assert.ok(sceneVersions() > before, 'the change is found once the window elapses');
  assert.ok(makeTasks() > 1, 'the stage whose input changed reopens');
});

/**
 * The renewal timer cannot fire while a synchronous scan blocks the event loop, so the scan itself renews at every
 * artifact kind. Removing that boundary renewal makes this assertion fail and lets a taken-over cycle keep writing.
 */
test('a long fingerprint scan renews the scheduler lease at every artifact kind', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  const snapshot = workflowSnapshot(f.db, id);
  const lease = acquireSchedulerLease(f.db);
  assert.equal(lease.acquired, true);
  if (!lease.acquired) return;
  t.after(() => { try { lease.release(); } catch { /* the lease is already someone else's */ } });
  let renewals = 0;
  const heartbeat = () => { lease.renew(); lease.assertActive(); renewals++; };
  new ArtifactFingerprinter(f.db, snapshot, f.project, f.home).fingerprint(id, snapshot.definition.artifacts, heartbeat);
  assert.ok(renewals >= snapshot.definition.artifacts.length + 1,
    `every artifact kind renews the lease (renewals=${renewals}, kinds=${snapshot.definition.artifacts.length})`);
  const expiresAt = Date.parse(String((f.db.prepare('SELECT expires_at FROM scheduler_lease WHERE id = 1').get() as
    { expires_at: string }).expires_at));
  assert.ok(expiresAt > Date.now(), 'the scan left the lease unexpired');
});

test('an artifact larger than one Buffer (2 GiB) is fingerprinted in chunks, with the same hash as a whole read', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-large-'));
  t.after(() => removeTemp(root));
  writeFileSync(join(root, 'small.bin'), 'delivery');
  assert.equal(sha256File(join(root, 'small.bin')), createHash('sha256').update('delivery').digest('hex'));
  // Sparse: no disk space, but every byte is read as it would be for a real delivery package.
  const big = join(root, 'total.zip');
  writeFileSync(big, '');
  truncateSync(big, 2 ** 31 + 4096);
  const expected = createHash('sha256');
  const zeros = Buffer.alloc(2 ** 24);
  for (let left = 2 ** 31 + 4096; left > 0; left -= zeros.length) expected.update(zeros.subarray(0, Math.min(left, zeros.length)));
  const hash = expected.digest('hex');
  assert.equal(sha256File(big), hash);
  assert.equal(fileHash(big), hash, 'the artifact fingerprinter reads it the same way');
});

test('a Unity .meta beside a listed artifact path is part of the artifact; alone it is not an artifact', t => {
  const f = fixture(t);
  const spec = { paths: ['Assets/Avatar.asset'] };
  mkdirSync(join(f.project, 'Assets'));
  writeFileSync(join(f.project, 'Assets/Avatar.asset.meta'), 'guid: 1');
  assert.equal(artifactFingerprint(f.project, spec), undefined, 'a leftover .meta alone is absent');
  writeFileSync(join(f.project, 'Assets/Avatar.asset'), 'data');
  const before = artifactFingerprint(f.project, spec);
  assert.deepEqual(artifactFiles(f.project, spec), ['Assets/Avatar.asset', 'Assets/Avatar.asset.meta']);
  writeFileSync(join(f.project, 'Assets/Avatar.asset.meta'), 'guid: 2');
  assert.notEqual(artifactFingerprint(f.project, spec), before, 'a new GUID is a new version');
});

test('tools are frozen with the Workflow: a changed observer script is refused, not run',
  { skip: !checkSandboxStatus().available && 'observers run in the check sandbox' }, async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  writeFileSync(join(f.root, 'tools', 'inspect-plan.mjs'), OBSERVERS['inspect-plan.mjs']!.replace('title_length', 'title_length_v2'));
  await f.tick();
  const check = describeWorkflow(f.db, id).stages[0]!.checks[0]!;
  assert.equal(check.verdict!.result, 'error');
  assert.match(check.verdict!.basis!, /inspect-plan\.mjs 在 Workflow 创建后被修改/);
  rmSync(join(f.root, 'tools', 'count.mjs'));
  await cancelWorkflow(f.db, f.config, id, 'switch', { start: () => ({ ref: 'x' }), observe: () => ({ state: 'running' }),
    cancel: () => 'confirmed', collect: () => ({ exitStatus: 0, outputs: {} }) });
  assert.throws(() => createWorkflow(f.db, f.config, 'sample', 'synthetic-formal'), /引用的工具不存在：\{toolRoot\}\/count\.mjs/);
});

test('a stage held on a check runs again by itself once its inputs change upstream',
  { skip: !checkSandboxStatus().available && 'observers run in the check sandbox' }, async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok');
  f.executor.items = ['a', 'b.broken'];
  await f.tick(); await f.tick();
  const held = describeWorkflow(f.db, id).stages[1]!;
  assert.equal(held.status, 'blocked');
  assert.equal(held.task!.status, 'BLOCKED');
  // The person answers upstream: a new plan, approved. The held make stage's old result is about the old plan.
  f.executor.plan = { title: 'Sample, second take', extra: false };
  f.executor.items = ['a', 'b'];
  taskRedo(f.db, describeWorkflow(f.db, id).stages[0]!.task!.id, '标题换一个');
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok again');
  await f.tick(); await f.tick(); await f.tick();
  const make = describeWorkflow(f.db, id).stages[1]!;
  assert.equal(make.status, 'passed', JSON.stringify(make.reasons));
  assert.notEqual(make.task!.id, held.task!.id);
  assert.equal((f.db.prepare('SELECT status FROM task WHERE id = ?').get(held.task!.id) as { status: string }).status, 'CANCELLED');
  const reason = f.db.prepare(`SELECT reason FROM event WHERE entity_id = ? AND action = 'BLOCKED->CANCELLED'`).get(held.task!.id) as { reason: string };
  assert.match(reason.reason, /上游产物已变化（plan）/);
});

test('a redone tool stage receives the person\'s note as AVH_FEEDBACK',
  { skip: !checkSandboxStatus().available && 'observers run in the check sandbox' }, async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok');
  await f.tick(); await f.tick();
  const make = describeWorkflow(f.db, id).stages[1]!.task!;
  const first = new StageRouter(f.db, f.config, workflowSnapshot(f.db, id)).router(make.id);
  assert.equal(first.spec.tool?.env.AVH_FEEDBACK, undefined, 'a first attempt has no note');
  taskRedo(f.db, make.id, '选 B');
  await f.tick();
  const redone = describeWorkflow(f.db, id).stages[1]!.task!;
  assert.notEqual(redone.id, make.id);
  const router = new StageRouter(f.db, f.config, workflowSnapshot(f.db, id)).router(redone.id);
  assert.equal(router.spec.tool?.env.AVH_FEEDBACK, '选 B');
  assert.match(router.spec.goal, /修改意见：选 B/);
});

test('a stage held at its Gate: the Gate is the person\'s item, it waits while the stage reruns, and every redo note reaches the executor',
  { skip: !checkSandboxStatus().available && 'observers run in the check sandbox' }, async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  const held = describeWorkflow(f.db, id);
  assert.equal(held.stages[0]!.display, 'deciding');
  const planTask = held.stages[0]!.task!.id;
  const inbox = () => taskRows(f.db).find(task => task.id === planTask)!.needsYou;
  assert.equal(inbox(), false, 'the Gate is listed; its stage\'s Task is not listed a second time');
  // What the executor is told, as the Runtime composes it for the next Run of this Task.
  const goal = () => new StageRouter(f.db, f.config, workflowSnapshot(f.db, id)).router(planTask).spec.goal;
  assert.doesNotMatch(goal(), /修改意见/);

  // Redone from the Task without a decision: nothing to decide while the new version is being made.
  taskRedo(f.db, planTask, '标题写成 Pink');
  assert.match(goal(), /^用户要求重做本阶段，修改意见：标题写成 Pink\n/);
  f.executor.hold = true;
  await f.tick();
  const working = describeWorkflow(f.db, id);
  assert.equal(working.stages[0]!.display, 'running');
  assert.equal(formalGates(f.db, id).find(gate => gate.gate.endsWith(':plan_approval'))!.status, 'waiting');
  assert.doesNotMatch(working.next, /需要你决定/);
  await assert.rejects(decideFormalGate(f.db, f.config, id, 'plan_approval', true, '抢先批准'), /还没到决定的时候/);
  f.executor.hold = false;
  await f.tick();
  assert.equal(formalGates(f.db, id).find(gate => gate.gate.endsWith(':plan_approval'))!.status, 'pending');

  // Rejected with a reason: only then is the stage the person's to redo; the executor sees both notes, newest last.
  await decideFormalGate(f.db, f.config, id, 'plan_approval', false, '色相 -150');
  assert.equal(describeWorkflow(f.db, id).stages[0]!.display, 'blocked');
  assert.equal(inbox(), true);
  taskRedo(f.db, planTask, '色相 -150');
  assert.match(goal(), /以最后一条为准[^\n]*\n1\. 标题写成 Pink\n2\. 色相 -150\n/);
  await f.tick();
  assert.equal(f.executor.starts.filter(spec => spec.stageId === 'plan').length, 3);
  assert.equal(describeWorkflow(f.db, id).stages[0]!.task!.id, planTask, 'a held stage reruns as the same Task');

  // Approved at last: the stage passes and the work moves on. The requests made while it was held are answered, not
  // read as a request to redo the passed plan.
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, '可以');
  await f.tick(); await f.tick();
  assert.equal(f.executor.starts.filter(spec => spec.stageId === 'plan').length, 3);
  assert.deepEqual(f.stages(id), { plan: 'passed', make: 'passed', extra: 'not_applicable' });
  assert.equal(describeWorkflow(f.db, id).stages[0]!.task!.id, planTask);
});

test('a formal stage whose Run was lost track of can be recovered: the person checks it, then it is verified as usual',
  { skip: !checkSandboxStatus().available && 'observers run in the check sandbox' }, async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok');
  // The make stage's unit can no longer be read back.
  const executor = f.executor as unknown as { observe: () => { state: string } };
  executor.observe = () => ({ state: 'unknown' });
  await f.tick(); await f.tick();
  const make = describeWorkflow(f.db, id).stages[1]!.task!;
  assert.equal(make.status, 'RECOVERY_REQUIRED');
  assert.match(describeWorkflow(f.db, id).next, /需要核对上次执行/);
  // The person finds the stage's output in place and says so; a short id is enough.
  mkdirSync(join(f.project, 'scene'), { recursive: true });
  for (const name of ['a', 'b']) writeFileSync(join(f.project, 'scene', name), name);
  await taskRecover(f.db, f.config, make.id.slice(0, 8), 'reconciled', '单元已不在，产物齐全');
  const recovered = f.db.prepare("SELECT reason FROM event WHERE action = 'recovered_reconciled'").get() as { reason: string };
  assert.match(recovered.reason, /^单元已不在，产物齐全（执行结果读不回来，按人工核对）$/);
  executor.observe = () => ({ state: 'exited' });
  await f.tick();
  assert.deepEqual(f.stages(id), { plan: 'passed', make: 'passed', extra: 'not_applicable' });
  assert.equal(describeWorkflow(f.db, id).status, 'upload_ready');
});

test('a failed stage is redone only when the person asks, as a new Task that carries their note',
  { skip: !checkSandboxStatus().available && 'observers run in the check sandbox' }, async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok');
  f.executor.failing.add('make');
  for (let i = 0; i < 6 && describeWorkflow(f.db, id).stages[1]!.task?.status !== 'FAILED'; i++) await f.tick();
  const failed = describeWorkflow(f.db, id).stages[1]!.task!;
  assert.equal(failed.status, 'FAILED');
  assert.match(describeWorkflow(f.db, id).next, /阶段 make 执行失败/);
  // Nothing happens by itself: a failed stage waits for the person.
  const starts = f.executor.starts.length;
  await f.tick();
  assert.equal(f.executor.starts.length, starts);
  f.executor.failing.delete('make');
  taskRedo(f.db, failed.id, '先清空 scene 再写');
  await f.tick(); await f.tick();
  const redone = describeWorkflow(f.db, id).stages[1]!.task!;
  assert.notEqual(redone.id, failed.id);
  assert.match((f.db.prepare('SELECT goal FROM task WHERE id = ?').get(redone.id) as { goal: string }).goal, /；修改意见：先清空 scene 再写$/);
  assert.equal(describeWorkflow(f.db, id).status, 'upload_ready');
  // Only the stage's newest Task can be redone, and only while its Workflow goes on.
  assert.throws(() => taskRedo(f.db, failed.id, '再来'), /已有更新的任务/);
  await cancelWorkflow(f.db, f.config, id, '测试结束', f.executor);
  const cancelled = describeWorkflow(f.db, id).stages[1]!.task!;
  assert.throws(() => taskRedo(f.db, cancelled.id, '再来'), /已取消/);
});

test('a passed stage can be redone with the person\'s note; the note reaches the executor; client verification is final',
  { skip: !checkSandboxStatus().available && 'observers run in the check sandbox' }, async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok');
  await f.tick(); await f.tick();
  assert.equal(describeWorkflow(f.db, id).status, 'upload_ready');
  const plan = describeWorkflow(f.db, id).stages[0]!.task!;
  assert.throws(() => taskRedo(f.db, plan.id), /修改意见/);
  taskRedo(f.db, plan.id, '颜色改成蓝色');
  await f.tick();
  const redone = describeWorkflow(f.db, id).stages[0]!.task!;
  assert.notEqual(redone.id, plan.id);
  assert.match((f.db.prepare('SELECT goal FROM task WHERE id = ?').get(redone.id) as { goal: string }).goal, /修改意见：颜色改成蓝色/);
  // The redone plan is a new version: approve it again, then finish the delivery and the client test.
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok again');
  await f.tick(); await f.tick();
  assert.equal(describeWorkflow(f.db, id).status, 'upload_ready');
  await decideFormalGate(f.db, f.config, id, 'client_test', true, '客户端实测通过');
  await f.tick();
  assert.equal(describeWorkflow(f.db, id).status, 'client_verified');
  const tasks = (f.db.prepare('SELECT COUNT(*) AS n FROM task WHERE workflow_id = ?').get(id) as { n: number }).n;
  writeFileSync(join(f.project, 'scene', 'c'), 'edited after delivery');
  await f.tick(); await f.tick();
  assert.equal(describeWorkflow(f.db, id).status, 'client_verified', 'delivered work is not restarted');
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM task WHERE workflow_id = ?').get(id) as { n: number }).n, tasks);
});

test('an artifact can name more members in a list file written by its stage; a listed path outside the project is refused', t => {
  const f = fixture(t);
  mkdirSync(join(f.project, '_harness/setup'), { recursive: true });
  mkdirSync(join(f.project, 'Assets/Vendor'), { recursive: true });
  writeFileSync(join(f.project, 'Assets/Vendor/a.fbx'), 'fbx');
  const spec = { paths: ['_harness/setup/'], listed: '_harness/setup/roots.txt' };
  writeFileSync(join(f.project, '_harness/setup/roots.txt'), '# vendor roots\nAssets/Vendor\n');
  assert.deepEqual(artifactFiles(f.project, spec), ['Assets/Vendor/a.fbx', '_harness/setup/roots.txt']);
  const before = artifactFingerprint(f.project, spec);
  writeFileSync(join(f.project, 'Assets/Vendor/a.fbx'), 'changed');
  assert.notEqual(artifactFingerprint(f.project, spec), before, 'a change to a listed member is a new version');
  writeFileSync(join(f.project, '_harness/setup/roots.txt'), '../outside\n');
  assert.throws(() => artifactFiles(f.project, spec), /工程外路径/);
});

test('project new makes its own Git repository that ignores editor caches and build copies', t => {
  const f = fixture(t);
  const path = createProject(f.config, 'Harness_Sample');
  assert.match(execFileSync('git', ['-C', path, 'log', '--oneline'], { encoding: 'utf8' }), /Create project/);
  assert.match(readFileSync(join(path, '.gitignore'), 'utf8'), /^\/_harness_build\/$/m);
  assert.match(readFileSync(join(path, '.gitignore'), 'utf8'), /^\/\[Ll\]ibrary\/$/m);
  // Caches editor plugins rewrite on every load must not look like a stage's write.
  for (const cache of ['Packages/nadena.dev.ndmf/__Generated/x.asset', 'Assets/ZZZ_GeneratedAssets/x.asset', 'Packages/jp.lilxyzw.liltoon/Editor/CurrentRP.txt',
    '.vscode/settings.json'])
    assert.equal(spawnSync('git', ['-C', path, 'check-ignore', '-q', cache]).status, 0, cache);
  assert.throws(() => createProject(f.config, 'Harness_Sample'), /已存在/);
  assert.throws(() => createProject(f.config, '../escape'), /特殊字符|分隔符/);
  const id = createWorkflow(f.db, f.config, 'Harness_Sample', 'synthetic-formal', f.manifestPath);
  assert.ok(id);
});

test('a Unity step may open a copy inside the project, never a path outside it', () => {
  const p = windows ? 'C:\\p' : '/p';
  assert.equal(stepProject(p, { method: 'M', quit: true, env: {} }), p);
  assert.equal(stepProject(p, { method: 'M', quit: true, env: {}, project: '_harness_build/copy' }), join(p, '_harness_build', 'copy'));
  assert.throws(() => stepProject(p, { method: 'M', quit: true, env: {}, project: '../x' }), /工程内相对路径/);
  assert.throws(() => stepProject(p, { method: 'M', quit: true, env: {}, project: '/abs' }), /工程内相对路径/);
});

test('a Workflow whose project directory moved away is skipped with one recorded reason, not the whole round', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  const idle: Executor = { start: () => ({ ref: 'idle' }), observe: () => ({ state: 'running' }), cancel: () => 'confirmed',
    collect: () => ({ exitStatus: 0, outputs: {} }) };
  renameSync(f.project, `${f.project}.moved`);
  t.after(() => { if (existsSync(`${f.project}.moved`)) renameSync(`${f.project}.moved`, f.project); });
  assert.equal(await serveOnce(f.db, f.config, () => idle), true, 'the round completes');
  assert.equal(await serveOnce(f.db, f.config, () => idle), true);
  const skipped = f.db.prepare("SELECT reason FROM event WHERE workflow_id = ? AND action = 'tick_failed'").all(id) as { reason: string }[];
  assert.equal(skipped.length, 1, 'the same reason is recorded once, not every second');
  assert.match(skipped[0]!.reason, /本轮跳过这个流程/);
});

test('relative imported physical identity reaches formal Router observers and Gate and cannot escape an active workflow', async t => {
  const f=fixture(t);
  f.db.prepare("INSERT INTO workspace(id,path) VALUES('import-workspace',?)").run(f.config.workspaceRoot);
  f.db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES('import-project','import-workspace','private','sample','{}','imported','old-h','old-k')`).run();
  const before={...f.db.prepare("SELECT * FROM project WHERE id='import-project'").get()!};
  const id=createWorkflow(f.db,f.config,f.project,'synthetic-formal',f.manifestPath);
  assert.equal(f.db.prepare('SELECT project_id FROM workflow WHERE id=?').get(id)!.project_id,'import-project');
  assert.throws(()=>createWorkflow(f.db,f.config,'sample','synthetic-formal',f.manifestPath),/已有进行中的正式/);
  await f.tick();await f.tick();
  const task=describeWorkflow(f.db,id).stages.find(s=>s.id==='plan')!.task!.id;
  const router=new StageRouter(f.db,f.config,workflowSnapshot(f.db,id)).router(task);
  assert.equal(router.row.project_path,realpathSync(f.project));
  assert.ok(router.spec.contextPlan);
  const gate=formalGates(f.db,id).find(g=>g.gate.endsWith(':plan_approval'))!;
  assert.equal(gate.status,'pending');assert.ok(gate.artifactHash);
  await decideFormalGate(f.db,f.config,id,'plan_approval',true,'accept actual plan',gate.artifactHash);
  for(let n=0;n<4;n++)await f.tick();
  assert.equal(f.stages(id).make,'passed');
  assert.deepEqual({...f.db.prepare("SELECT * FROM project WHERE id='import-project'").get()!},before);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM project').get()!.n,1);
});

/**
 * A warning reading on the `make` stage that fails while the stage's blocking count check still passes. Four items are
 * inside the blocking 2..4 range but break the warning's own limit, so the stage is blocked only by the warning.
 */
function addSceneWarning(f: ReturnType<typeof fixture>): void {
  const definition = f.config.definitions['synthetic-formal']!;
  definition.checks.push({ id: 'scene_item_warning', observe: 'scene.count', on: 'scene', scope: 'edit',
    rule: 'items <= 3', severity: 'warning', maturity: 'accepted' });
  definition.stages.find(stage => stage.id === 'make')!.requires.push('scene_item_warning');
}
/** Drive the real Runtime (createWorkflow → Observer → Verdict) until only an unaccepted warning blocks `make`. */
async function reachUnacceptedWarning(f: ReturnType<typeof fixture>): Promise<string> {
  f.executor.items = ['a', 'b', 'c', 'd'];
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, '接受方案');
  for (let n = 0; n < 4; n++) await f.tick();
  return id;
}

test('an unaccepted warning blocks the stage, and accepting the current reading lets it continue', async t => {
  const f = fixture(t); addSceneWarning(f);
  const id = await reachUnacceptedWarning(f);
  assert.equal(f.stages(id).make, 'blocked', 'the warning blocks the make stage');
  const view = describeWorkflow(f.db, id);
  assert.match(view.next, /有需要你确认的提醒/, 'the person is told this is their decision, not a repair');
  const warning = view.stages.find(stage => stage.id === 'make')!.checks.find(check => check.id === 'scene_item_warning')!;
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.verdict?.result, 'violation');
  assert.equal(warning.verdict?.current, true);
  assert.equal(warning.verdict?.accepted, false, 'the current reading starts unaccepted');
  const listed = warningRows(f.db).find(row => row.workflowId === id && row.checkId === 'scene_item_warning')!;
  assert.equal(listed.blocks, true);
  assert.match(warningList(f.db), /待接受（阻断）/);
  // The CLI entry records who accepted which reading and why; it never turns the reading into a pass.
  const inserted = warningAccept(f.db, `${id}:scene_item_warning`, '接受件数达到上限的提醒');
  assert.match(inserted.message, /已接受提醒/);
  const recorded = f.db.prepare(`SELECT actor, reason FROM event WHERE workflow_id = ?
    AND entity_type = 'warning' AND action = 'accepted'`).get(id) as { actor: string; reason: string };
  assert.equal(recorded.actor, 'human');
  assert.equal(recorded.reason, '接受件数达到上限的提醒');
  assert.equal(f.db.prepare("SELECT result FROM verdict WHERE check_id = 'scene_item_warning'").get()!.result, 'violation');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance').get()!.n, 1);
  for (let n = 0; n < 3; n++) await f.tick();
  assert.equal(f.stages(id).make, 'passed', 'the accepted reading lets the stage continue');
});

test('an acceptance does not carry over to a new reading of the same warning', async t => {
  const f = fixture(t); addSceneWarning(f);
  const id = await reachUnacceptedWarning(f);
  const first = warningRows(f.db).find(row => row.checkId === 'scene_item_warning')!;
  warningAccept(f.db, `${id}:scene_item_warning`, '接受第一条读数');
  for (let n = 0; n < 3; n++) await f.tick();
  assert.equal(f.stages(id).make, 'passed');
  // A redo produces a new Verdict for the same check; the old acceptance was about the old reading only.
  const task = describeWorkflow(f.db, id).stages.find(stage => stage.id === 'make')!.task!.id;
  taskRedo(f.db, task, '重新制作服装');
  for (let n = 0; n < 4; n++) await f.tick();
  assert.equal(f.stages(id).make, 'blocked', 'the new reading blocks again');
  const second = warningRows(f.db).find(row => row.checkId === 'scene_item_warning')!;
  assert.notEqual(second.verdictId, first.verdictId);
  assert.equal(second.accepted, false, 'the new reading starts unaccepted');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance').get()!.n, 1, 'nothing is accepted automatically');
  assert.match(describeWorkflow(f.db, id).next, /有需要你确认的提醒/);
});

test('acceptance refuses a blocking check and a check that belongs to another Workflow', async t => {
  const f = fixture(t); addSceneWarning(f);
  const id = await reachUnacceptedWarning(f);
  assert.throws(() => warningAccept(f.db, `${id}:scene_items`, '想接受阻断判据'), /阻断级/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance').get()!.n, 0);
  // A second Workflow with its own frozen check set: its check is not part of the first Workflow's definition.
  const base = f.config.definitions['synthetic-formal']!;
  f.config.definitions['other-formal'] = { ...structuredClone(base), id: 'other-formal',
    stages: [{ id: 'plan', needs: [], produces: ['plan'], requires: ['other_only_check'], gates: [], invalidated_by: [] }],
    checks: [{ id: 'other_only_check', observe: 'plan.inspect', on: 'plan', scope: 'edit', rule: 'title_length > 0',
      severity: 'warning', maturity: 'accepted' }],
    gates: [], milestones: [] };
  f.config.capabilities['other-formal'] = f.config.capabilities['synthetic-formal']!;
  const otherManifest = join(f.root, 'other-manifest.yaml');
  writeFileSync(otherManifest, stringify({ schema: 'manifest/0.1', profile: 'other-formal',
    assets: [{ store: 'library', item: '1', role: 'body' }], request: '另一个流程的样例' }));
  const otherProject = createProject(f.config, 'Harness_Other');
  const other = createWorkflow(f.db, f.config, otherProject, 'other-formal', otherManifest);
  assert.notEqual(other, id);
  assert.throws(() => warningAccept(f.db, `${id}:other_only_check`, '想接受别的流程的判据'), /不属于这个制作流程/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance').get()!.n, 0);
});

test('acceptance refuses a deprecated check whose reading blocks nothing and changes nothing', async t => {
  const f = fixture(t); addSceneWarning(f);
  // A reading only exists for a check the Runtime actually measured, so build the source Workflow through the real
  // Runtime and accept its one warning: that completes `make` while leaving the violation reading behind.
  f.executor.items = ['a', 'b', 'c', 'd'];
  const source = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, source, 'plan_approval', true, '接受方案');
  for (let n = 0; n < 4; n++) await f.tick();
  assert.equal(f.stages(source).make, 'blocked', 'the warning blocks the source stage until it is accepted');
  warningAccept(f.db, `${source}:scene_item_warning`, '接受来源流程的读数');
  for (let n = 0; n < 3; n++) await f.tick();
  assert.equal(f.stages(source).make, 'passed', 'the source stage is complete, with its violation reading recorded');
  // The process definition now calls that check deprecated, and the source's reading is copied by hand into a Workflow
  // whose frozen definition is the deprecated one. No current entry point is known to produce that pair: a frozen
  // definition is append-only, the observer never measures a deprecated check, and archive/restore.ts keeps an
  // existing definition only for the same Workflow id and otherwise restores the archive's own definition. This is a
  // defensive test: if a reading of a deprecated check ever reaches a Workflow, accepting it must still be refused.
  f.config.definitions['synthetic-formal']!.checks.find(check => check.id === 'scene_item_warning')!.maturity = 'deprecated';
  const successorProject = createProject(f.config, 'Harness_Successor');
  const successorManifest = join(f.root, 'successor-manifest.yaml');
  writeFileSync(successorManifest, stringify({ schema: 'manifest/0.1', profile: 'synthetic-formal',
    assets: [{ store: 'library', item: '1', role: 'body' }], request: '接续的样例' }));
  const successor = createWorkflow(f.db, f.config, successorProject, 'synthetic-formal', successorManifest);
  for (const artifact of f.db.prepare('SELECT kind, hash FROM artifact_version WHERE workflow_id = ?').all(source) as
    Array<{ kind: string; hash: string }>)
    f.db.prepare('INSERT INTO artifact_version (workflow_id, kind, hash) VALUES (?, ?, ?)').run(successor, artifact.kind, artifact.hash);
  for (const reading of f.db.prepare(`SELECT id, check_id, scope, artifact_hash, result, basis, input_hashes_json,
    recorded_at FROM verdict WHERE workflow_id = ?`).all(source) as Array<{ id: string; check_id: string; scope: string;
      artifact_hash: string; result: string; basis: string | null; input_hashes_json: string | null; recorded_at: string }>)
    f.db.prepare(`INSERT INTO verdict (id, workflow_id, check_id, scope, artifact_hash, result, basis, input_hashes_json,
      recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`restored-${reading.id}`, successor, reading.check_id, reading.scope, reading.artifact_hash, reading.result,
        reading.basis, reading.input_hashes_json, reading.recorded_at);
  // The successor really carries the measured reading, and the aggregate ignores the check it belongs to because it is
  // deprecated — so accepting it records an event that unlocks nothing.
  assert.ok(buildAggregateInput(f.db, successor).verdicts
    .find(verdict => verdict.checkId === 'scene_item_warning'), 'the successor carries the measured reading');
  const check = describeWorkflow(f.db, successor).stages.find(stage => stage.id === 'make')!.checks
    .find(item => item.id === 'scene_item_warning')!;
  assert.equal(check.maturity, 'deprecated');
  assert.equal(check.acceptanceRequired, false, 'the projection offers no acceptance for a deprecated check');
  assert.deepEqual(warningRows(f.db).filter(row => row.workflowId === successor), [],
    'no listing offers a reading nothing can act on');
  // The source reading is still listed, so the negative below is about the successor and not an empty list.
  assert.match(warningList(f.db), new RegExp(`^${escapeRegExp(source)}\\tmake\\tscene_item_warning`, 'm'));
  assert.doesNotMatch(warningList(f.db), new RegExp(`^${escapeRegExp(successor)}\\t`, 'm'),
    'the CLI does not offer the successor a deprecated reading to accept');
  // The Runtime refuses rather than writing an acceptance that unlocks nothing, and leaves no record behind.
  assert.throws(() => warningAccept(f.db, `${successor}:scene_item_warning`, '想接受已停用的判据'), /已停用/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance WHERE workflow_id = ?').get(successor)!.n, 0);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM event WHERE workflow_id = ? AND action = 'accepted'`)
    .get(successor)!.n, 0);
  // The local API refuses with the same reason; a client cannot record it either.
  const service = new RuntimeService({ home: f.home, scheduler: false, pollMs: 50 });
  await service.start();
  const client = await ApiClient.connect(f.home);
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; client.close(); await service.stop(); };
  t.after(stop);
  await assert.rejects(client.call('warning.accept', { workflowId: successor, checkId: 'scene_item_warning',
    note: '经 API 接受已停用的判据' }), /已停用/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance WHERE workflow_id = ?').get(successor)!.n, 0);
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM event WHERE workflow_id = ? AND action = 'accepted'`)
    .get(successor)!.n, 0);
  await stop();
});

test('the local API lists the warning reading and accepts exactly the one the client was shown', async t => {
  const f = fixture(t); addSceneWarning(f);
  const id = await reachUnacceptedWarning(f);
  const service = new RuntimeService({ home: f.home, scheduler: false, pollMs: 50 });
  await service.start();
  const client = await ApiClient.connect(f.home);
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; client.close(); await service.stop(); };
  t.after(stop);
  const row = (await client.call<Array<{ workflowId: string; checkId: string; accepted: boolean; current: boolean;
    blocks: boolean; verdictId: string }>>('warning.list'))
    .find(item => item.workflowId === id && item.checkId === 'scene_item_warning')!;
  assert.deepEqual({ accepted: row.accepted, current: row.current, blocks: row.blocks }, { accepted: false, current: true, blocks: true });
  // The client must send back the reading it showed: a different one is refused instead of silently accepted.
  await assert.rejects(client.call('warning.accept', { workflowId: id, checkId: 'scene_item_warning',
    note: '经 API 接受', expectedVerdictId: 'old-reading' }), /已变化/);
  await assert.rejects(client.call('warning.accept', { workflowId: id, checkId: 'scene_items', note: '想接受阻断判据' }), /阻断级/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance').get()!.n, 0, 'a refused request records nothing');
  const accepted = await client.call<{ alreadyAccepted: boolean }>('warning.accept', { workflowId: id,
    checkId: 'scene_item_warning', note: '经 API 接受当前读数', expectedVerdictId: row.verdictId });
  assert.equal(accepted.alreadyAccepted, false);
  // The words the person gave are what the record answers "why" with: read back verbatim, not a channel label.
  const recorded = f.db.prepare(`SELECT reason FROM event WHERE workflow_id = ? AND entity_type = 'warning' AND action = 'accepted'`)
    .get(id) as { reason: string };
  assert.equal(recorded.reason, '经 API 接受当前读数');
  await stop();
  for (let n = 0; n < 3; n++) await f.tick();
  assert.equal(f.stages(id).make, 'passed');
});

/**
 * Run `act` with `race` applied the instant the Runtime's transaction opens, before its own in-transaction reads.
 * Every statement here is synchronous, so a second writer cannot otherwise interleave between the pre-checks and the
 * write; this reproduces exactly that: what the pre-checks saw has already been changed when the transaction starts.
 */
function whileTransactionOpens<T>(db: ReturnType<typeof fixture>['db'], race: () => void, act: () => T): T {
  const exec = db.exec.bind(db);
  let raced = false;
  db.exec = (sql: string) => {
    if (!raced && String(sql).startsWith('BEGIN IMMEDIATE')) { raced = true; race(); }
    exec(String(sql));
  };
  try { return act(); } finally { db.exec = exec; }
}

test('an acceptance is refused when the workflow was cancelled before its transaction opened', async t => {
  const f = fixture(t); addSceneWarning(f);
  const id = await reachUnacceptedWarning(f);
  assert.throws(() => whileTransactionOpens(f.db,
    () => f.db.prepare("UPDATE workflow SET status = 'cancelled' WHERE id = ?").run(id),
    () => warningAccept(f.db, `${id}:scene_item_warning`, '在取消之后仍想接受')), /已经取消/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance').get()!.n, 0, 'the refusal records no acceptance');
  assert.equal(f.db.prepare('SELECT status FROM workflow WHERE id = ?').get(id)!.status, 'cancelled',
    'the cancellation that raced the request stands');
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM event WHERE workflow_id = ? AND action = 'accepted'`).get(id)!.n, 0,
    'the refused request leaves no accepted event behind');
});

test('an acceptance is refused when the check stopped applying before its transaction opened', async t => {
  const f = fixture(t);
  const definition = f.config.definitions['synthetic-formal']!;
  definition.checks.push({ id: 'scene_item_warning', observe: 'scene.count', on: 'scene', scope: 'edit',
    rule: 'items <= 3', severity: 'warning', maturity: 'accepted', when: 'plan.extra' });
  definition.stages.find(stage => stage.id === 'make')!.requires.push('scene_item_warning');
  f.executor.items = ['a', 'b', 'c', 'd'];
  f.executor.plan = { title: 'Sample', extra: true };
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, '接受方案');
  for (let n = 0; n < 4; n++) await f.tick();
  assert.equal(f.stages(id).make, 'blocked', 'the applicable warning blocks the stage');
  const plan = JSON.parse((f.db.prepare('SELECT plan_json FROM workflow WHERE id = ?').get(id) as { plan_json: string }).plan_json);
  assert.equal(plan.extra, true, 'the reading was measured while the check applied');
  assert.throws(() => whileTransactionOpens(f.db,
    () => f.db.prepare('UPDATE workflow SET plan_json = ? WHERE id = ?').run(JSON.stringify({ ...plan, extra: false }), id),
    () => warningAccept(f.db, `${id}:scene_item_warning`, '条件变假之后仍想接受')), /不适用/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance').get()!.n, 0,
    'a check that no longer applies is not accepted from a stale pre-check');
});

test('an acceptance that lost the race to another reports already accepted without a second record', async t => {
  const f = fixture(t); addSceneWarning(f);
  const id = await reachUnacceptedWarning(f);
  const reading = warningRows(f.db).find(row => row.workflowId === id && row.checkId === 'scene_item_warning')!;
  const message = whileTransactionOpens(f.db,
    () => f.db.prepare('INSERT INTO warning_acceptance (workflow_id, verdict_id) VALUES (?, ?)').run(id, reading.verdictId),
    () => warningAccept(f.db, `${id}:scene_item_warning`, '与另一个请求同时提交')).message;
  assert.match(message, /已经接受过/, 'the loser of the race is told the reading was already accepted');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance').get()!.n, 1, 'nothing is accepted twice');
  assert.equal(f.db.prepare(`SELECT count(*) AS n FROM event WHERE workflow_id = ? AND action = 'accepted'`).get(id)!.n, 0,
    'a request that wrote nothing records no accepted event');
});

test('a stage blocked by two unaccepted warnings at once marks both readings as blocking', async t => {
  const f = fixture(t);
  const definition = f.config.definitions['synthetic-formal']!;
  definition.checks.push(
    { id: 'scene_item_warning', observe: 'scene.count', on: 'scene', scope: 'edit', rule: 'items <= 3', severity: 'warning', maturity: 'accepted' },
    { id: 'scene_spare_warning', observe: 'scene.count', on: 'scene', scope: 'edit', rule: 'items == 5', severity: 'warning', maturity: 'accepted' });
  definition.stages.find(stage => stage.id === 'make')!.requires.push('scene_item_warning', 'scene_spare_warning');
  f.executor.items = ['a', 'b', 'c', 'd'];
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, '接受方案');
  for (let n = 0; n < 4; n++) await f.tick();
  assert.equal(f.stages(id).make, 'blocked');
  const state = describeWorkflow(f.db, id).stages.find(stage => stage.id === 'make')!;
  assert.deepEqual(state.codes, ['warning_unaccepted', 'warning_unaccepted'], 'both readings are the reason the stage waits');
  const rows = warningRows(f.db).filter(row => row.workflowId === id).map(row => [row.checkId, row.blocks]).sort();
  assert.deepEqual(rows, [['scene_item_warning', true], ['scene_spare_warning', true]],
    'both readings are listed as blocking, not just the one that happens to be alone in the list');
  assert.match(warningList(f.db), /scene_item_warning\tviolation\t待接受（阻断）/);
});

test('a warning that no longer applies is neither blocking nor acceptable beside one that does', async t => {
  const f = fixture(t);
  const definition = f.config.definitions['synthetic-formal']!;
  // Three warnings on one stage, each in a different state: one really fails, one's `when` is false so its reading is
  // a valid `not_applicable` bound to the plan, and one passes. The stage waits only on the first, and only the first
  // may be accepted — the list must not read "this stage waits on a warning" as "every warning row is one to accept".
  definition.checks.push(
    { id: 'scene_item_warning', observe: 'scene.count', on: 'scene', scope: 'edit', rule: 'items <= 3',
      severity: 'warning', maturity: 'accepted' },
    { id: 'scene_gallery_warning', observe: 'scene.count', on: 'scene', scope: 'edit', rule: 'broken == 0',
      severity: 'warning', maturity: 'accepted', when: 'plan.client_gallery' },
    { id: 'scene_floor_warning', observe: 'scene.count', on: 'scene', scope: 'edit', rule: 'items >= 1',
      severity: 'warning', maturity: 'accepted' });
  definition.stages.find(stage => stage.id === 'make')!.requires
    .push('scene_item_warning', 'scene_gallery_warning', 'scene_floor_warning');
  f.executor.items = ['a', 'b', 'c', 'd'];
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, '接受方案');
  for (let n = 0; n < 4; n++) await f.tick();
  assert.equal(f.stages(id).make, 'blocked');
  const state = describeWorkflow(f.db, id).stages.find(stage => stage.id === 'make')!;
  assert.deepEqual(state.codes, ['warning_unaccepted'], 'only the applicable warning is the reason the stage waits');
  const rows = warningRows(f.db).filter(row => row.workflowId === id)
    .map(row => [row.checkId, row.result, row.applies, row.blocks]).sort();
  assert.deepEqual(rows, [
    ['scene_floor_warning', 'pass', true, false],
    ['scene_gallery_warning', 'not_applicable', false, false], ['scene_item_warning', 'violation', true, true],
  ], 'each reading is judged on its own: neither the passing one nor the one that does not apply blocks or is offered');
  const listed = warningList(f.db);
  assert.match(listed, /scene_item_warning\tviolation\t待接受（阻断）/);
  assert.match(listed, /scene_floor_warning\tpass\t已通过/);
  assert.match(listed, /scene_gallery_warning\tnot_applicable\t不适用/,
    'the CLI says the reading does not apply instead of calling it a blocked acceptance');
  // The Runtime agrees with the list: neither the reading that does not apply nor the one that passed is one a person
  // can accept, and the reading that does apply still is — so the mixed stage is not reported as un-actionable either.
  assert.throws(() => warningAccept(f.db, `${id}:scene_gallery_warning`, '想接受一条不适用的读数'), /不适用/);
  assert.throws(() => warningAccept(f.db, `${id}:scene_floor_warning`, '想接受一条已通过的读数'), /已经通过/);
  warningAccept(f.db, `${id}:scene_item_warning`, '接受件数达到上限的提醒');
  // Accepted: the list and the projection stop asking, and the stage detail offers no control while saying so.
  assert.match(warningList(f.db), /scene_item_warning\tviolation\t已接受/);
  assert.match(warningAccept(f.db, `${id}:scene_item_warning`, '再接受一次').message, /已经接受过/);
  const acceptedView = describeWorkflow(f.db, id);
  assert.equal(acceptedView.stages.find(stage => stage.id === 'make')!.checks
    .find(check => check.id === 'scene_item_warning')!.acceptanceRequired, false);
  const accepted = renderVerify(acceptedView);
  assert.doesNotMatch(accepted.text(), /提醒等你确认/);
  assert.equal(accepted.button('接受这条提醒'), undefined);
  assert.match(accepted.text(), /已接受/, 'the reading is still shown, as accepted rather than as an action');
  for (let n = 0; n < 3; n++) await f.tick();
  assert.equal(f.stages(id).make, 'passed');
});

test('workflow show reads the shared projection, so a valid not_applicable and a cancelled Workflow ask for nothing', async t => {
  const f = fixture(t);
  const definition = f.config.definitions['synthetic-formal']!;
  // The same real Runtime state the list test builds: one warning really fails, and one's `when` is false so its reading
  // is a valid `not_applicable` bound to the plan. The shipped `workflow show` text renders that very projection.
  definition.checks.push(
    { id: 'scene_item_warning', observe: 'scene.count', on: 'scene', scope: 'edit', rule: 'items <= 3',
      severity: 'warning', maturity: 'accepted' },
    { id: 'scene_gallery_warning', observe: 'scene.count', on: 'scene', scope: 'edit', rule: 'broken == 0',
      severity: 'warning', maturity: 'accepted', when: 'plan.client_gallery' });
  definition.stages.find(stage => stage.id === 'make')!.requires
    .push('scene_item_warning', 'scene_gallery_warning');
  f.executor.items = ['a', 'b', 'c', 'd'];
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  await f.tick();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, '接受方案');
  for (let n = 0; n < 4; n++) await f.tick();
  const view = describeWorkflow(f.db, id);
  const checks = (source: ReturnType<typeof describeWorkflow>) =>
    source.stages.find(stage => stage.id === 'make')!.checks;
  assert.equal(checks(view).find(check => check.id === 'scene_item_warning')!.acceptanceRequired, true);
  assert.equal(checks(view).find(check => check.id === 'scene_gallery_warning')!.acceptanceRequired, false,
    'the Runtime does not accept a reading whose `when` no longer holds');
  const text = workflowText(view);
  assert.match(text, /scene_item_warning\tmake\tviolation\t待接受（接受后阶段才能继续）/);
  assert.match(text, /scene_gallery_warning\tmake\tnot_applicable\t不适用/,
    'a reading that does not apply is shown as such, not as one waiting to be accepted');
  // The two shipped surfaces read the one projection, so they cannot tell the person different things.
  assert.match(warningList(f.db), /scene_gallery_warning\tnot_applicable\t不适用/);
  // Cancelling answers the question for every reading: the projection turns `acceptanceRequired` off and the text must
  // stop asking, instead of keeping an entry the Runtime would refuse.
  assert.equal((await cancelWorkflow(f.db, f.config, id, '用户改主意', f.executor)).confirmed, true);
  const cancelledView = describeWorkflow(f.db, id);
  assert.equal(cancelledView.status, 'cancelled');
  assert.equal(checks(cancelledView).find(check => check.id === 'scene_item_warning')!.acceptanceRequired, false);
  const cancelled = workflowText(cancelledView);
  assert.doesNotMatch(cancelled, /待接受/, 'no reading of a cancelled Workflow awaits an acceptance');
  assert.match(cancelled, /scene_item_warning\tmake\tviolation\t已取消，无需确认/);
});

test('a warning whose evidence has moved on is listed as expired and cannot be accepted', async t => {
  const f = fixture(t); addSceneWarning(f);
  const id = await reachUnacceptedWarning(f);
  // A newer version of the artifact the reading was judged against: the conclusion no longer binds, so the person's
  // next step is to measure again, not to accept it. The Runtime refuses with the same reason the list gives.
  f.db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES (?, 'scene', ?)").run(id, 'f'.repeat(64));
  const row = warningRows(f.db).find(item => item.workflowId === id && item.checkId === 'scene_item_warning')!;
  assert.deepEqual({ current: row.current, blocks: row.blocks }, { current: false, blocks: false });
  assert.match(warningList(f.db), /scene_item_warning\tviolation\t已过期，需重新取证/);
  const check = describeWorkflow(f.db, id).stages.find(stage => stage.id === 'make')!.checks
    .find(item => item.id === 'scene_item_warning')!;
  assert.equal(check.acceptanceRequired, false);
  const ui = renderVerify(describeWorkflow(f.db, id));
  assert.doesNotMatch(ui.text(), /提醒等你确认/);
  assert.equal(ui.button('接受这条提醒'), undefined);
  assert.match(ui.text(), /证据已过期，重新取证后再接受/, 'the stage detail tells the person to measure again');
  assert.throws(() => warningAccept(f.db, `${id}:scene_item_warning`, '想接受一条已过期的读数'), /已过期/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance').get()!.n, 0);
});

test('a cancelled Workflow offers no acceptance, and its real projection renders without one', async t => {
  const f = fixture(t); addSceneWarning(f);
  const id = await reachUnacceptedWarning(f);
  const warned = (view: ReturnType<typeof describeWorkflow>) =>
    view.stages.find(stage => stage.id === 'make')!.checks.find(check => check.id === 'scene_item_warning')!;
  const active = describeWorkflow(f.db, id);
  assert.equal(active.status, 'active');
  assert.equal(warned(active).acceptanceRequired, true, "while the Workflow runs this reading is the person's to accept");
  // The shipped stage-detail component, rendered with that real projection: the banner and the control are offered.
  const running = renderVerify(active);
  assert.match(running.text(), /有 1 条提醒等你确认/);
  assert.ok(running.button('接受这条提醒'));

  assert.equal((await cancelWorkflow(f.db, f.config, id, '用户改主意', f.executor)).confirmed, true);
  const view = describeWorkflow(f.db, id);
  assert.equal(view.status, 'cancelled');
  assert.equal(warned(view).acceptanceRequired, false, 'a cancelled Workflow accepts nothing, so no client may offer it');
  // The same component over the cancelled projection: nothing to read as a decision and no control to click.
  const cancelled = renderVerify(view);
  assert.doesNotMatch(cancelled.text(), /提醒等你确认/);
  assert.equal(cancelled.button('接受这条提醒'), undefined);
  // The CLI and the Runtime agree: a cancelled Workflow's readings are not listed as awaiting anyone, and a request
  // that arrives anyway is refused rather than recorded.
  assert.deepEqual(warningRows(f.db).filter(row => row.workflowId === id), [],
    'a cancelled Workflow has no warning awaiting a person');
  assert.doesNotMatch(warningList(f.db), /scene_item_warning/);
  assert.throws(() => warningAccept(f.db, `${id}:scene_item_warning`, '在取消之后仍想接受'), /已经取消/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM warning_acceptance').get()!.n, 0);
});

/**
 * `client_verified` is terminal: the Workflow leaves the serving loop and is never observed again. The idle cadence
 * must not let it be entered on a version edited after the person approved it. Without the observation before the
 * final transition, the Workflow below ends `client_verified` on the old hash and the edit is lost for good.
 */
test('an edit made after the client approval is found before the Workflow is finalized', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  const cadence = newFingerprintCadence();
  const round = () => serveOnce(f.db, f.config, () => f.executor, undefined,
    { idleFingerprintRefreshMs: 60_000, idleFingerprintCadence: cadence });
  await round();
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok');
  await round(); await round();
  assert.equal(describeWorkflow(f.db, id).status, 'upload_ready');
  const sceneVersions = () => Number((f.db.prepare(`SELECT count(*) AS n FROM artifact_version
    WHERE workflow_id = ? AND kind = 'scene'`).get(id) as { n: number }).n);
  const before = sceneVersions();
  // The client approves the delivered version, and then the scene changes inside the idle window.
  await decideFormalGate(f.db, f.config, id, 'client_test', true, '客户端看过这个版本');
  writeFileSync(join(f.project, 'scene', 'a'), 'edited after the client approval');
  await round();
  assert.notEqual(describeWorkflow(f.db, id).status, 'client_verified',
    'the Workflow is not finalized on a version the approval no longer covers');
  assert.ok(sceneVersions() > before, 'the edit made after the approval was observed before the final status');
});

/**
 * Recording a plan revision writes the state store inside the scan. If the lease is taken over at the write
 * boundary, the scan must stop before `observePlan` runs. The old order only noticed the takeover at the kind's
 * closing renewal — after the revision had already been written.
 */
test('a plan revision is not written when the lease is lost at the write boundary', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  mkdirSync(join(f.project, '_harness'), { recursive: true });
  writeFileSync(join(f.project, '_harness/plan.yaml'), JSON.stringify({ title: 'Sample' }));
  const snapshot = workflowSnapshot(f.db, id);
  const lease = acquireSchedulerLease(f.db);
  assert.equal(lease.acquired, true);
  if (!lease.acquired) return;
  t.after(() => { try { lease.release(); } catch { /* the lease is already someone else's */ } });
  // The first renewal is the scan's opening heartbeat; the second is the plan kind's write boundary.
  let calls = 0;
  const heartbeat = (): void => {
    calls++;
    if (calls === 2) f.db.prepare(`UPDATE scheduler_lease SET holder = 'other-host:1:other-cycle', host = 'other-host',
      pid = 1, cycle = cycle + 1 WHERE id = 1`).run();
    lease.renew(); lease.assertActive();
  };
  const fingerprinter = new ArtifactFingerprinter(f.db, snapshot, f.project, f.home);
  assert.throws(() => fingerprinter.fingerprint(id, snapshot.definition.artifacts, heartbeat), /Scheduler lease lost/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM plan_revision').get()!.n, 0,
    'no plan revision is written under a lease the cycle no longer owns');
});

/**
 * A gate decision binds the hash the person saw. If the artifact changes before the next round, the parked Task must
 * not resume on that stale decision, and no downstream Run may start first. Removing the observation before a human
 * Task resumes settles the Task as PASSED and only then notices the change.
 */
test('a plan edited right after its approval does not resume the gated Task or start downstream work', async t => {
  const f = fixture(t);
  const id = createWorkflow(f.db, f.config, 'sample', 'synthetic-formal', f.manifestPath);
  const cadence = newFingerprintCadence();
  const round = () => serveOnce(f.db, f.config, () => f.executor, undefined,
    { idleFingerprintRefreshMs: 60_000, idleFingerprintCadence: cadence });
  await round();
  const planTask = f.db.prepare("SELECT id, status FROM task WHERE workflow_id = ? AND stage_id = 'plan'")
    .get(id) as { id: string; status: string };
  assert.equal(planTask.status, 'WAITING_HUMAN');
  await decideFormalGate(f.db, f.config, id, 'plan_approval', true, 'ok');
  // The plan changes after the approval but before the next round.
  writeFileSync(join(f.project, '_harness/plan.yaml'), JSON.stringify({ title: 'Edited after the approval', extra: false }));
  await round();
  assert.notEqual((f.db.prepare('SELECT status FROM task WHERE id = ?').get(planTask.id) as { status: string }).status, 'PASSED',
    'the gated Task does not settle on an approval the edit made stale');
  assert.equal(f.executor.starts.filter(run => run.stageId === 'make').length, 0,
    'no downstream Run starts on the stale approval');
});
