import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { stringify } from 'yaml';
import { confirmFact, factViews, recordFacts, storedFacts } from '../../src/archive/facts.ts';
import { projectOverview } from '../../src/archive/overview.ts';
import { scanProject } from '../../src/archive/scan.ts';
import { ingestTakeover, reconcileRecoveries, validateTakeoverFacts } from '../../src/archive/takeover.ts';
import { recoveryAnalysisSpec, recoveryApplySpec } from '../../src/import/recovery.ts';
import { compactProjectContext, projectContextFacts, projectState } from '../../src/project-state.ts';
import { parseSpec } from '../../src/task-cli.ts';
import { artifactFingerprint } from '../../src/workflow/artifacts.ts';
import { sha256File } from '../../src/file-hash.ts';
import { approvedWorkflow, archiveFixture, FLOW, FLOW_CAPABILITIES, IMPORT_DEFINITION } from '../fixtures/archive.ts';
import { importProject } from '../../src/import/index.ts';
import { sha256 } from '../../src/import/scan.ts';
import { submitInteraction } from '../../src/interactions.ts';
import { recordIntent } from '../../src/project-intent.ts';

const current = (db: DatabaseSync, projectId: string, objectId: string, attribute: string) =>
  factViews(db, projectId).find(fact => fact.objectId === objectId && fact.attribute === attribute);

test('new production awaits engineering setup while imported or attempted missing environments stay visible; intent retains diagnostic evidence', t => {
  const f = archiveFixture(t, { git: true });
  const { projectId: importedId } = f.imported();
  rmSync(join(f.project, 'ProjectSettings/ProjectVersion.txt')); scanProject(f.db, importedId);
  assert.equal(projectOverview(f.db, importedId).missing.find(item => item.kind === 'unity')?.pending, undefined);
  const requested = join(f.workspace, 'New'), projectId = `project:${sha256(requested)}`; mkdirSync(requested);
  f.db.prepare(`INSERT INTO project(id,workspace_id,path,kind,identity_json,lifecycle,harness_version,knowledge_version)
    SELECT ?,workspace_id,?,'private','{}','active',harness_version,knowledge_version FROM project WHERE id=?`).run(projectId, requested, importedId);
  scanProject(f.db, projectId);
  const interaction = submitInteraction(f.db, projectId, { content: '做一个白色角色', commandId: 'new-design' });
  const definition = { ...FLOW, stages: [...FLOW.stages, { id: 'setup', needs: ['plan'], produces: [], requires: [], gates: [], invalidated_by: [] }] };
  f.db.prepare(`INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json)
    VALUES('engineering-flow',?,'flow','process-hash','k','active','{}')`).run(projectId);
  f.db.prepare(`INSERT INTO workflow_definition(workflow_id,profile,definition_json,capabilities_json,thresholds_json)
    VALUES('engineering-flow','flow',?,?,'{}')`).run(JSON.stringify(definition), JSON.stringify(FLOW_CAPABILITIES));
  f.db.prepare(`INSERT INTO project_brief(project_id,intake_mode,customer_request,face_concept,status) VALUES(?,'conversation','','','draft')
    ON CONFLICT(project_id) DO UPDATE SET intake_mode='conversation'`).run(projectId);
  f.db.prepare(`INSERT INTO production_proposal(id,project_id,revision,profile,request,inputs_json,context_json,status,workflow_id)
    VALUES(?, ?, 1,'flow','做一个白色角色','[]','{}','working','engineering-flow')`).run(interaction.id, projectId);
  recordIntent(f.db, projectId, interaction.id, 1, [{ object: 'avatar', attribute: 'goal', content: '白色角色', sourceMessageId: interaction.id, quote: '做一个白色角色' }]);
  const overview = projectOverview(f.db, projectId);
  assert.equal(overview.missing.find(item => item.kind === 'unity')?.pending, true);
  assert.ok(overview.next.some(step => step.kind === 'engineering' && /Harness/.test(step.text)));
  assert.equal(overview.inferred.find(fact => fact.objectId === 'intent:avatar')?.presentation, 'diagnostic');
  assert.ok(overview.inferred.find(fact => fact.objectId === 'intent:avatar')?.value, 'the evidence is retained, not deleted');
  f.db.prepare(`INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('setup-live','engineering-flow','setup','setup','executor','RUNNING')`).run();
  assert.match(projectOverview(f.db, projectId).missing.find(item => item.kind === 'unity')!.text, /正在建立工程/);
  assert.equal(projectOverview(f.db, projectId).next.some(step => step.kind === 'dependency'), false);
  f.db.prepare(`UPDATE task SET status='VERIFYING' WHERE id='setup-live'`).run();
  assert.equal(projectOverview(f.db, projectId).missing.find(item => item.kind === 'unity')?.pending, true);
  f.db.prepare(`INSERT INTO run(id,task_id,attempt,status,result_json) VALUES('setup-prior-failure','setup-live',1,'exited','{"exitStatus":143,"errorClass":"network"}')`).run();
  assert.equal(projectOverview(f.db, projectId).missing.find(item => item.kind === 'unity')?.pending, undefined,
    'a retried task current state cannot erase its durable prior failed run');
  // Preserve an actual failed task in another frozen workflow; a current setup must not hide its failure history.
  f.db.prepare(`INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json)
    VALUES('earlier-engineering',?,'flow','process-hash','k','blocked','{}')`).run(projectId);
  f.db.prepare(`INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('old-setup-failed','earlier-engineering','setup','setup','executor','FAILED')`).run();
  assert.equal(projectOverview(f.db, projectId).missing.find(item => item.kind === 'unity')?.pending, undefined, 'a live setup cannot hide earlier failure');
  // An actual import into that same path must not be reclassified as "not built yet" merely by changing its brief.
  mkdirSync(join(requested, 'ProjectSettings')); writeFileSync(join(requested, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  assert.equal(importProject(f.db, { workspacePath: f.workspace, projectPath: requested, definition: IMPORT_DEFINITION, kind: 'private',
    config: { toolRoot: '/synthetic/no-tools' } }).projectId, projectId);
  rmSync(join(requested, 'ProjectSettings/ProjectVersion.txt')); scanProject(f.db, projectId);
  assert.equal(projectOverview(f.db, projectId).missing.find(item => item.kind === 'unity')?.pending, undefined,
    'actual imported history keeps its missing environment visible even under a conversation brief and unstarted setup');
  f.db.prepare(`INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('setup-failed','engineering-flow','setup','setup','executor','FAILED')`).run();
  assert.equal(projectOverview(f.db, projectId).missing.find(item => item.kind === 'unity')?.pending, undefined, 'a real failed setup is not covered by pending wording');
});

test('an import records what it observed as facts with their sources, and leaves history it cannot prove unknown', t => {
  const f = archiveFixture(t, { record: true });
  const report = f.imported();
  const version = current(f.db, report.projectId, 'project', 'unity.version')!;
  assert.equal(version.value, '2022.3.22f1');
  assert.equal(version.status, 'observed');
  assert.equal(version.evidenceLevel, 'observation');
  assert.deepEqual(version.source, { type: 'import_scan', ref: `import_report:${report.id}` });
  assert.deepEqual(version.locator, { path: 'ProjectSettings/ProjectVersion.txt', line: 1 });
  const sha = sha256File(join(f.project, 'ProjectSettings/ProjectVersion.txt'));
  assert.equal(version.inputFingerprint, sha);
  assert.deepEqual(version.invalidation, [{ kind: 'file', path: 'ProjectSettings/ProjectVersion.txt', sha256: sha }]);
  assert.deepEqual(current(f.db, report.projectId, 'project', 'vpm.locked')!.value,
    { 'com.vrchat.avatars': '3.7.0', 'nadena.dev.modular-avatar': '1.13.0' });
  // The record is a document: its claim is observed as a claim, never upgraded to verified.
  const timeline = current(f.db, report.projectId, 'project', 'history.timeline')!;
  assert.equal(timeline.evidenceLevel, 'document');
  assert.deepEqual(timeline.locator, { path: '_施工记录.md' });
  for (const attribute of ['history.approvals', 'history.verification']) {
    const fact = current(f.db, report.projectId, 'project', attribute)!;
    assert.equal(fact.effectiveStatus, 'unknown');
    assert.equal(fact.value, null);
  }
  assert.ok(storedFacts(f.db, report.projectId).every(fact => fact.status !== 'verified'), 'an import never verifies anything');
  // A repeated import of the unchanged project adds no record.
  const before = storedFacts(f.db, report.projectId).length;
  f.imported();
  assert.equal(storedFacts(f.db, report.projectId).length, before);
});

test('a project without records keeps its whole history unknown; nothing reconstructs a timeline (sample ②)', t => {
  const f = archiveFixture(t);
  const report = f.imported();
  const history = factViews(f.db, report.projectId).filter(fact => fact.attribute.startsWith('history.'));
  assert.deepEqual(history.map(fact => [fact.objectId, fact.attribute, fact.effectiveStatus, fact.value]).sort(), [
    ['project', 'history.approvals', 'unknown', null], ['project', 'history.timeline', 'unknown', null],
    ['project', 'history.verification', 'unknown', null], ['stage:menu', 'history.progress', 'unknown', null],
    ['stage:setup', 'history.progress', 'unknown', null]]);
  // The takeover analysis cannot fill it in either: history is not an inference.
  const checked = validateTakeoverFacts(f.project, { schema: 'harness-takeover-facts/1', ready: true, facts: [
    { object: 'project', attribute: 'history.progress', value: 'done', locator: { path: '.' }, basis: '看起来做完了' }] });
  assert.equal(checked.ok, false);
  assert.match((checked as { problems: string[] }).problems.join(), /历史进度、批准和验证不能作为推断写入/);
  const overview = projectOverview(f.db, report.projectId);
  assert.ok(overview.next.some(step => step.kind === 'baseline'), 'the next step starts from a baseline');
  assert.equal(overview.unknown.length, 5 + 1, 'plus the base avatar nobody named');
});

test('a changed or deleted input makes the facts bound to it stale; restoring it makes them hold again', t => {
  const f = archiveFixture(t, { record: true });
  const { projectId } = f.imported();
  const record = join(f.project, '_施工记录.md'), original = readFileSync(record, 'utf8');
  const timeline = () => current(f.db, projectId, 'project', 'history.timeline')!;
  assert.equal(timeline().effectiveStatus, 'observed');
  writeFileSync(record, `${original}\n## 2026-09-21 09:00 · menu（执行者）\n`);
  assert.equal(timeline().effectiveStatus, 'observed', 'nothing is stale before a scan observed the change');
  scanProject(f.db, projectId);
  assert.equal(timeline().effectiveStatus, 'stale');
  assert.deepEqual(timeline().invalidatedBy.map(hit => [hit.condition.kind, hit.now]), [['file', sha256File(record)]]);
  rmSync(record);
  scanProject(f.db, projectId);
  assert.deepEqual(timeline().invalidatedBy.map(hit => hit.now), [null], 'a deleted input reads as absent');
  writeFileSync(record, original);
  scanProject(f.db, projectId);
  assert.equal(timeline().effectiveStatus, 'observed', 'the same content again: the record holds again');
  // An identity input the scan reads itself is observed anew instead: a newer record replaces the import's, which stays.
  writeFileSync(join(f.project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.99f1\n');
  scanProject(f.db, projectId);
  assert.equal(current(f.db, projectId, 'project', 'unity.version')!.value, '2022.3.99f1');
  assert.deepEqual(storedFacts(f.db, projectId).filter(fact => fact.attribute === 'unity.version').map(fact => fact.source.type),
    ['import_scan', 'harness_scan']);
  // A scan that finds nothing new records nothing.
  const before = storedFacts(f.db, projectId).length;
  scanProject(f.db, projectId);
  assert.equal(storedFacts(f.db, projectId).length, before);
});

function takeoverProject(f: ReturnType<typeof archiveFixture>, facts: unknown) {
  const report = f.imported();
  mkdirSync(join(f.project, '_Harness/Recovery'), { recursive: true });
  writeFileSync(join(f.project, '_Harness/Recovery/analysis.json'), JSON.stringify({ classification: 'project', classificationConfidence: 0.8, ready: true }));
  writeFileSync(join(f.project, '_Harness/Recovery/recovery.md'), '# 接手说明\n保留原菜单。\n');
  writeFileSync(join(f.project, '_Harness/Recovery/facts.json'), JSON.stringify(facts));
  const db = f.db, workflowId = 'takeover-workflow', taskId = 'takeover-task';
  db.prepare(`INSERT INTO workflow (id, project_id, process_id, process_hash, knowledge_version, status, plan_json)
    VALUES (?, ?, 'avh-task/0.1', 'avh-task/0.1', 'k', 'active', '{}')`).run(workflowId, report.projectId);
  db.prepare(`INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES (?, ?, 'work', 'analysis', 'diagnostician', 'RUNNING')`)
    .run(taskId, workflowId);
  db.prepare(`INSERT INTO project_recovery (id, project_id, source_kind, source_path, source_hash, mode, status, analysis_task_id)
    VALUES ('recovery-1', ?, 'folder', ?, 'source-hash', 'shallow', 'analysis_pending', ?)`).run(report.projectId, f.project, taskId);
  return { projectId: report.projectId, taskId };
}
const FACTS = { schema: 'harness-takeover-facts/1', ready: true,
  facts: [
    { object: 'avatar_root:Assets/Avatar/Avatar.prefab#/Avatar', attribute: 'descriptor', value: 'present',
      locator: { path: 'Assets/Avatar/Avatar.prefab', object: '/Avatar' }, basis: '预制体上有 Avatar Descriptor', confidence: 0.9 },
    { object: 'menu:Main', attribute: 'owner', value: 'avatar_root:Assets/Avatar/Avatar.prefab#/Avatar', locator: { path: 'Assets/Avatar/Avatar.prefab' },
      basis: '菜单挂在这个根下', dependsOn: [0] },
    { object: 'dependency:lilToon', attribute: 'present', value: false, locator: { path: 'Assets/Avatar/Avatar.prefab' }, basis: '材质引用 lilToon 着色器' },
  ],
  questions: [{ id: 'menu-owner', question: '菜单是否需要保留原有分组？', about: 'menu:Main' }] };

test('takeover candidates are ingested as inferences only when the three outputs are complete; ready means only that', t => {
  const f = archiveFixture(t);
  const { projectId, taskId } = takeoverProject(f, { ...FACTS, facts: [{ ...FACTS.facts[0], locator: { path: 'Assets/Missing.prefab' } }] });
  // A Task that has not ended is not settled.
  assert.deepEqual(reconcileRecoveries(f.db, projectId), []);
  f.db.prepare("UPDATE task SET status = 'PASSED' WHERE id = ?").run(taskId);
  const [settled] = reconcileRecoveries(f.db, projectId);
  assert.equal(settled!.status, 'failed');
  assert.match(settled!.problems.join(), /locator\.path 在工程内不存在/);
  assert.equal(factViews(f.db, projectId).filter(fact => fact.source.type === 'takeover_analysis').length, 0, 'nothing of an incomplete analysis is recorded');
  const recovery = f.db.prepare("SELECT status, warnings_json FROM project_recovery WHERE id = 'recovery-1'").get() as { status: string; warnings_json: string };
  assert.equal(recovery.status, 'failed');
  assert.match(recovery.warnings_json, /不存在/);
});

test('takeover candidates stay inferred until a person confirms; a correction makes what depended on it stale', t => {
  const f = archiveFixture(t);
  const { projectId, taskId } = takeoverProject(f, FACTS);
  f.db.prepare("UPDATE task SET status = 'PASSED' WHERE id = ?").run(taskId);
  assert.deepEqual(reconcileRecoveries(f.db, projectId).map(item => item.status), ['ready']);
  const takeover = factViews(f.db, projectId).filter(fact => fact.source.type === 'takeover_analysis');
  assert.deepEqual(takeover.map(fact => fact.effectiveStatus), takeover.map(() => 'inferred'));
  const root = takeover.find(fact => fact.attribute === 'descriptor')!, menu = takeover.find(fact => fact.objectId === 'menu:Main')!;
  assert.equal(root.evidenceLevel, 'inference');
  assert.equal(root.confidence, 0.9);
  assert.deepEqual(root.locator, { path: 'Assets/Avatar/Avatar.prefab', object: '/Avatar' });
  assert.equal(root.source.ref, '_Harness/Recovery/facts.json#/facts/0');
  assert.ok(menu.invalidation.some(condition => condition.kind === 'fact' && condition.factId === root.id));
  const overview = projectOverview(f.db, projectId);
  assert.equal(overview.inferred.find(item => item.id === root.id)?.basis, '预制体上有 Avatar Descriptor');
  assert.ok(overview.missing.some(item => item.kind === 'dependency' && item.id === 'lilToon'));
  assert.ok(!overview.known.some(item => item.source.type === 'takeover_analysis'), 'an inference is never listed as known');
  // Confirming keeps the value: the dependent still holds.
  const confirmed = confirmFact(f.db, projectId, root.id, { decision: 'confirm' }, '看过预制体');
  assert.equal(confirmed.status, 'user_confirmed');
  assert.equal(confirmed.supersedes, root.id);
  assert.equal(current(f.db, projectId, 'menu:Main', 'owner')!.effectiveStatus, 'inferred');
  // Correcting it changes the value: the menu owner was derived from the old one and no longer holds.
  confirmFact(f.db, projectId, confirmed.id, { decision: 'correct', value: 'absent' }, '描述符在另一个根上');
  assert.equal(current(f.db, projectId, 'menu:Main', 'owner')!.effectiveStatus, 'stale');
  // Nothing was rewritten: all three records of the root remain, in order.
  const history = factViews(f.db, projectId, { history: true }).filter(fact => fact.attribute === 'descriptor');
  assert.deepEqual(history.map(fact => [fact.status, fact.current]), [['inferred', false], ['user_confirmed', false], ['user_confirmed', true]]);
  assert.throws(() => f.db.prepare("UPDATE project_fact SET value_json = '1'").run(), /append-only/);
  // An old record cannot be confirmed any more, and an unknown one needs a value.
  assert.throws(() => confirmFact(f.db, projectId, root.id, { decision: 'confirm' }), /更新的记录/);
  const unknown = current(f.db, projectId, 'project', 'history.approvals')!;
  assert.throws(() => confirmFact(f.db, projectId, unknown.id, { decision: 'confirm' }), /不能直接确认/);
  // Rejecting leaves the conclusion unknown.
  const lilToon = current(f.db, projectId, 'dependency:lilToon', 'present')!;
  assert.equal(confirmFact(f.db, projectId, lilToon.id, { decision: 'reject' }).status, 'unknown');
  // The inference also goes stale when the file it was read from changes.
  writeFileSync(join(f.project, 'Assets/Avatar/Avatar.prefab'), 'prefab, edited');
  scanProject(f.db, projectId);
  assert.equal(current(f.db, projectId, 'avatar_root:Assets/Avatar/Avatar.prefab#/Avatar', 'descriptor')!.effectiveStatus, 'stale');
  // A new conversation is told what is only inferred and what is unknown, and a context condition can see it.
  const state = projectState(f.db, projectId);
  assert.match(compactProjectContext(state), /待确认推断（未经确认，不能当作事实）：.*question:menu-owner/);
  assert.match(compactProjectContext(state), /已失效的结论（输入已变化，需要重新核对）：.*menu:Main owner/);
  assert.match(compactProjectContext(state), /未知（文件无法证明，不要补写）：/);
  assert.equal((projectContextFacts(state).archive as { historyUnknown: boolean }).historyUnknown, true);
});

test('a person\'s statement stands against the same observation repeated, until the observed input changes', t => {
  const f = archiveFixture(t);
  const { projectId } = f.imported();
  const version = current(f.db, projectId, 'project', 'unity.version')!;
  confirmFact(f.db, projectId, version.id, { decision: 'correct', value: '2022.3.22f1-custom' }, '实际用的是定制版编辑器');
  scanProject(f.db, projectId);
  f.imported();
  assert.deepEqual([current(f.db, projectId, 'project', 'unity.version')!.value, current(f.db, projectId, 'project', 'unity.version')!.source.type],
    ['2022.3.22f1-custom', 'user'], 'neither a scan nor a re-import of the same files replaces it');
  writeFileSync(join(f.project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.30f1\n');
  scanProject(f.db, projectId);
  assert.deepEqual([current(f.db, projectId, 'project', 'unity.version')!.value, current(f.db, projectId, 'project', 'unity.version')!.source.type],
    ['2022.3.30f1', 'harness_scan'], 'the project changed: the new observation replaces the statement');
});

test('a new analysis does not override a person\'s confirmation, and the confirmation does not hang on the analysis report', t => {
  const f = archiveFixture(t);
  const { projectId, taskId } = takeoverProject(f, FACTS);
  f.db.prepare("UPDATE task SET status = 'PASSED' WHERE id = ?").run(taskId);
  reconcileRecoveries(f.db, projectId);
  const root = current(f.db, projectId, 'avatar_root:Assets/Avatar/Avatar.prefab#/Avatar', 'descriptor')!;
  const confirmed = confirmFact(f.db, projectId, root.id, { decision: 'confirm' });
  assert.deepEqual(confirmed.invalidation.map(condition => condition.kind === 'file' ? condition.path : condition.kind), ['Assets/Avatar/Avatar.prefab']);
  // A second analysis rewrites its report and says the same, as an inference: the person's statement stays current.
  writeFileSync(join(f.project, '_Harness/Recovery/facts.json'), JSON.stringify({ ...FACTS, facts: [FACTS.facts[0]] }));
  assert.deepEqual(ingestTakeover(f.db, projectId, f.project, 'recovery-2', taskId), []);
  const now = current(f.db, projectId, 'avatar_root:Assets/Avatar/Avatar.prefab#/Avatar', 'descriptor')!;
  assert.deepEqual([now.id, now.effectiveStatus], [confirmed.id, 'user_confirmed']);
  // The asset the person confirmed changes: the statement goes stale, and a new analysis may speak again.
  writeFileSync(join(f.project, 'Assets/Avatar/Avatar.prefab'), 'prefab, rebuilt');
  scanProject(f.db, projectId);
  assert.equal(current(f.db, projectId, 'avatar_root:Assets/Avatar/Avatar.prefab#/Avatar', 'descriptor')!.effectiveStatus, 'stale');
  writeFileSync(join(f.project, '_Harness/Recovery/facts.json'), JSON.stringify({ ...FACTS, facts: [{ ...FACTS.facts[0], confidence: 0.7 }] }));
  assert.deepEqual(ingestTakeover(f.db, projectId, f.project, 'recovery-3', taskId), []);
  assert.equal(current(f.db, projectId, 'avatar_root:Assets/Avatar/Avatar.prefab#/Avatar', 'descriptor')!.effectiveStatus, 'inferred');
});

test('a statement made while a file was missing yields once the file appears', t => {
  // A project Harness made before its setup stage: no Unity project yet, and nothing ever observed its editor version.
  const f = archiveFixture(t);
  rmSync(join(f.project, 'ProjectSettings/ProjectVersion.txt'));
  const projectId = 'made-here';
  f.db.prepare("INSERT INTO workspace (id, path) VALUES ('w', ?)").run(f.workspace);
  f.db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES (?, 'w', 'client', ?, '{}', 'active', 'h', 'k')`).run(projectId, f.project);
  scanProject(f.db, projectId);
  const unknown = current(f.db, projectId, 'project', 'unity.version')!;
  assert.equal(unknown.effectiveStatus, 'unknown');
  confirmFact(f.db, projectId, unknown.id, { decision: 'correct', value: '2022.3.22f1' }, '将用这个版本');
  scanProject(f.db, projectId);
  assert.equal(current(f.db, projectId, 'project', 'unity.version')!.source.type, 'user', 'still missing: the statement stands');
  writeFileSync(join(f.project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.40f1\n');
  scanProject(f.db, projectId);
  assert.deepEqual([current(f.db, projectId, 'project', 'unity.version')!.value, current(f.db, projectId, 'project', 'unity.version')!.source.type],
    ['2022.3.40f1', 'harness_scan']);
});

test('the fact contract rejects records that would misstate their evidence', t => {
  const f = archiveFixture(t);
  const { projectId } = f.imported();
  const base = { objectId: 'project', attribute: 'x', value: 1, source: { type: 'import_scan' as const, ref: 'r' }, observer: 'test',
    scope: 'project', shareLayer: 'A' as const };
  assert.throws(() => recordFacts(f.db, projectId, [{ ...base, status: 'verified', evidenceLevel: 'observation' }]), /不能配证据等级/);
  assert.throws(() => recordFacts(f.db, projectId, [{ ...base, status: 'unknown', evidenceLevel: 'none' }]), /未知的事实不能带值/);
  assert.throws(() => recordFacts(f.db, projectId, [{ ...base, status: 'user_confirmed', evidenceLevel: 'attestation' }]), /只有用户确认/);
  assert.throws(() => recordFacts(f.db, projectId, [{ ...base, source: { type: 'takeover_analysis', ref: 'r' }, status: 'observed',
    evidenceLevel: 'observation' }]), /只能产生待确认的推断/);
  assert.throws(() => recordFacts(f.db, projectId, [{ ...base, status: 'observed', evidenceLevel: 'observation', locator: { path: join(f.project, 'a') } }]),
    /不是工程内相对路径/);
  assert.throws(() => recordFacts(f.db, projectId, [{ ...base, status: 'observed', evidenceLevel: 'observation',
    invalidation: [{ kind: 'fact', factId: 'nope' }] }]), /引用的事实不存在/);
});

test('Workflow results are verified facts bound to their artifact; an edit makes the old approval stale (sample ⑦)', t => {
  const f = archiveFixture(t, { git: true });
  const { projectId } = f.imported();
  const hash = approvedWorkflow(f.db, projectId, f.project);
  const gate = () => current(f.db, projectId, 'gate:approval', 'decision')!;
  assert.equal(gate().effectiveStatus, 'user_confirmed');
  assert.equal(gate().inputFingerprint, hash);
  assert.equal(current(f.db, projectId, 'check:titled', 'verdict')!.effectiveStatus, 'verified');
  assert.equal(current(f.db, projectId, 'stage:plan', 'completion')!.effectiveStatus, 'verified');
  assert.ok(projectOverview(f.db, projectId).known.some(item => item.objectId === 'gate:approval'));
  // The plan is edited; the scheduler's next round records the new fingerprint.
  writeFileSync(join(f.project, '_harness/plan/plan.yaml'), stringify({ title: '夏装' }));
  f.db.prepare("INSERT INTO artifact_version (workflow_id, kind, hash) VALUES ('flow-1', 'plan', ?)")
    .run(artifactFingerprint(f.project, FLOW_CAPABILITIES.artifacts.plan)!);
  for (const [objectId, attribute] of [['gate:approval', 'decision'], ['check:titled', 'verdict'], ['stage:plan', 'completion']])
    assert.equal(current(f.db, projectId, objectId, attribute)!.effectiveStatus, 'stale', `${objectId} ${attribute}`);
  const overview = projectOverview(f.db, projectId);
  assert.ok(!overview.known.some(item => item.objectId === 'gate:approval'), 'the old approval is not shown as valid');
  assert.deepEqual(overview.stale.find(item => item.objectId === 'gate:approval')?.staleBecause, ['产物 plan 已变化']);
});

test('an ended Workflow is not refreshed by the scheduler: the scan observes its artifacts, and its old approval goes stale', t => {
  const f = archiveFixture(t, { git: true });
  const { projectId } = f.imported();
  approvedWorkflow(f.db, projectId, f.project);
  f.db.prepare("UPDATE workflow SET status = 'cancelled' WHERE id = 'flow-1'").run();
  scanProject(f.db, projectId);
  assert.equal(current(f.db, projectId, 'gate:approval', 'decision')!.effectiveStatus, 'user_confirmed');
  writeFileSync(join(f.project, '_harness/plan/plan.yaml'), stringify({ title: '另一版' }));
  assert.equal(current(f.db, projectId, 'gate:approval', 'decision')!.effectiveStatus, 'user_confirmed', 'not until something observed the change');
  scanProject(f.db, projectId);
  assert.equal(current(f.db, projectId, 'gate:approval', 'decision')!.effectiveStatus, 'stale');
});

test('the takeover analysis and apply specs are valid Task specifications and ask for the structured candidates', t => {
  const f = archiveFixture(t, { git: true });
  const write = (name: string, text: string) => { const path = join(f.root, name); writeFileSync(path, text); return path; };
  const analysis = parseSpec(write('analysis.yaml', recoveryAnalysisSpec(f.project, 'folder', [f.project], [])), f.project);
  assert.deepEqual(analysis.expectedOutputs, ['_Harness/Recovery/analysis.json', '_Harness/Recovery/recovery.md', '_Harness/Recovery/facts.json']);
  assert.ok(analysis.checks.some(check => check.json === '_Harness/Recovery/facts.json' && check.expect === 'harness-takeover-facts/1'));
  assert.match(analysis.goal, /不要补写时间线/);
  assert.doesNotMatch(analysis.goal, new RegExp(f.project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the goal carries no local path');
  assert.equal(parseSpec(write('apply.yaml', recoveryApplySpec('shallow', true)), f.project).checks.length, 2);
  assert.ok(readFileSync(join(f.root, 'analysis.yaml'), 'utf8').includes('facts.json'));
});

test('ingestion reports every structural problem of the candidate facts at once', t => {
  const f = archiveFixture(t);
  const { projectId } = f.imported();
  mkdirSync(join(f.project, '_Harness/Recovery'), { recursive: true });
  writeFileSync(join(f.project, '_Harness/Recovery/facts.json'), JSON.stringify({ schema: 'wrong', ready: false, facts: [
    { object: 'spaceship:x', attribute: 'a', value: 1, locator: { path: 'C:\\abs' }, basis: '' },
    { object: 'risk:y', attribute: 'b', value: 1, locator: { path: '.' }, basis: 'ok', dependsOn: [3] }] }));
  const problems = ingestTakeover(f.db, projectId, f.project, 'r', 't');
  for (const pattern of [/analysis\.json：不存在/, /recovery\.md 不存在/, /schema 应为/, /ready 应为 true/, /facts\[0\]\.object/, /facts\[0\]\.locator\.path 应为工程内的相对路径/,
    /facts\[0\]\.basis/, /facts\[1\]\.dependsOn/]) assert.match(problems.join('\n'), pattern);
});
