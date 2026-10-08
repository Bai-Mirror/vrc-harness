import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/state/db.ts';
import { KNOWN_BASES, projectContextFacts, projectState, writeProjectState, type DurableProjectState } from '../src/project-state.ts';
import { compileContext, compileContextPlan, materializeContextGoal, type ContextReference } from '../src/workflow/context-compiler.ts';
import { removeTemp } from './fixtures/platform.ts';

const state: DurableProjectState = { schema: 'harness-project-state/0.1',
  project: { id: 'p', path: '/w/p', lifecycle: 'active',
    identity: { kind: 'personal', base: 'Kaguya', packages: { 'nadena.dev.modular-avatar': '1.13.0', 'com.vrchat.avatars': '3.7.6' } } },
  brief: null, assets: [], variants: [], roots: [], workflow: null, tasks: [], cases: [], gates: [],
  evidence: { artifacts: [], verdicts: 0, events: 0 }, acceptedDecisions: [], generatedAt: '' };

test('a context condition can test a VPM package id although the id contains dots', () => {
  const facts = { memory: projectContextFacts(state) };
  assert.deepEqual((facts.memory.project as { packageIds: string[] }).packageIds, ['com.vrchat.avatars', 'nadena.dev.modular-avatar']);
  const item = (id: string, includes: string): { spec: ContextReference; sha256: string; content: string } => ({ sha256: id, content: `# ${id}`,
    spec: { id, path: `${id}.md`, priority: 0, required: false, excludes: [], covers: [], models: [], unless: [],
      when: [{ path: 'memory.project.packageIds', includes }] } });
  const compiled = compileContext([item('ma', 'nadena.dev.modular-avatar'), item('vrcfury', 'com.vrcfury.vrcfury')], facts, { budgetChars: 1000 });
  assert.deepEqual(compiled.decisions.filter(entry => entry.selected).map(entry => entry.id), ['ma']);
  assert.deepEqual(projectContextFacts({ ...state, project: { ...state.project, identity: {} } }).project,
    { id: 'p', lifecycle: 'active', identity: {}, packageIds: [] });
});

test('the assembly report separates "does not apply here" from "did not fit"', () => {
  const facts = { memory: projectContextFacts(state) };
  const content = 'x'.repeat(60);
  const item = (id: string, over: Partial<ContextReference> = {}): { spec: ContextReference; sha256: string; content: string } =>
    ({ sha256: id, content, spec: { id, path: `${id}.md`, priority: 0, required: false, excludes: [], covers: [], models: [], unless: [],
      when: [], ...over } });
  const plan = { items: [item('fits'), item('not-applicable', { when: [{ path: 'memory.project.packageIds', includes: 'absent.pkg' }] }),
    item('too-big', { priority: -1 })], facts, budgetChars: 100, requiredCoverage: [], prefix: '', suffix: '' };
  const { goal, report } = compileContextPlan(plan, { stage: 'demo', workflow: 'w1', pack: 'abc123', frozenAt: '2026-10-03T00:00:00Z' });
  // The two facts a reader needs to tell apart: an item that was irrelevant here, and one that lost
  // out on space. A report that merges them cannot answer "did this stage lose knowledge it needed".
  assert.equal(report.counts.selected, 1);
  assert.equal(report.counts['not-applicable'], 1);
  assert.equal(report.counts['out-of-budget'], 1);
  assert.equal(report.counts.total, 3, 'every candidate is accounted for');
  assert.equal(report.counts.selected + report.counts['not-applicable'] + report.counts['out-of-budget'], report.counts.total);
  assert.equal(report.budget.droppedForBudgetChars, 60);
  assert.equal(report.budget.usedChars + report.budget.droppedForBudgetChars, 120, 'the ledger adds up');
  assert.deepEqual(report.contract.unmet, []);
  assert.equal(report.identity.pack, 'abc123');
  assert.equal(report.identity.workflow, 'w1');
  // The count says what it counts: a character count read as model tokens would be wrong by a lot.
  assert.equal(report.budget.unit, 'utf16-code-units-of-item-bodies');
  // Every decision carries the fields a reader needs, whether or not it was selected.
  assert.ok(report.decisions.every(entry => typeof entry.required === 'boolean' && entry.disposition.length > 0 && entry.covers.length >= 0));
  // The goal text is unchanged by producing a report alongside it.
  assert.equal(goal, materializeContextGoal(plan));
});

test('a required coverage key that nothing selected is reported unmet rather than lost', () => {
  const item = { sha256: 'a', content: '# a', spec: { id: 'a', path: 'a.md', priority: 0, required: false, excludes: [], covers: [],
    models: [], unless: [], when: [] } as ContextReference };
  const plan = { items: [item], facts: {}, budgetChars: 100, requiredCoverage: ['needed.key'], prefix: '', suffix: '' };
  // Compiling already refuses a coverage gap; the report's value is naming it rather than only failing.
  assert.throws(() => compileContextPlan(plan, { stage: 'demo', workflow: 'w', pack: 'k', frozenAt: 't' }), /上下文覆盖不足/);
  const covered = { ...plan, items: [{ ...item, spec: { ...item.spec, covers: ['needed.key'] } }] };
  const { report } = compileContextPlan(covered, { stage: 'demo', workflow: 'w', pack: 'k', frozenAt: 't' });
  // The required keys come from the task, not from what happened to be selected, so the gap is derived
  // from the two rather than from a field that is only meaningful on a failure that never returns.
  assert.deepEqual(report.contract.required, ['needed.key']);
  assert.deepEqual(report.contract.unmet, []);
  assert.deepEqual(report.contract.covered, ['needed.key']);
  // A required key that nothing selected cannot appear in a report at all: the compiler refuses first, so
  // the caller gets a thrown error rather than a report naming the gap. Deriving unmet from the required
  // keys keeps the reported field correct, but a failure-side report is still a gap (决定记录 D-95).
  assert.throws(() => compileContextPlan({ ...covered, requiredCoverage: ['needed.key', 'also.needed'] },
    { stage: 'demo', workflow: 'w', pack: 'k', frozenAt: 't' }), /上下文覆盖不足/);
});

test('an imported project stored relative to its workspace writes its state there, not into the process cwd', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-project-state-')); t.after(() => removeTemp(root));
  const workspace = join(root, 'workspace'), elsewhere = join(root, 'elsewhere');
  mkdirSync(join(workspace, 'sample'), { recursive: true }); mkdirSync(elsewhere);
  const db = openDatabase(join(root, 'state.sqlite')); t.after(() => db.close());
  db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run('w', workspace);
  db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('p', 'w', 'private', 'sample', '{}', 'imported', 'test', 'test')`).run();
  const cwd = process.cwd(); process.chdir(elsewhere); t.after(() => process.chdir(cwd));
  const written = writeProjectState(db, 'p');
  assert.equal(written.path, join(workspace, 'sample', '_harness', 'state', 'project.yaml'));
  assert.ok(existsSync(written.path));
  assert.equal(existsSync(join(elsewhere, 'sample')), false, 'nothing lands in the current directory');
});

test('the base avatar is one comparable name, taken from an import note or from the avatar asset alone', () => {
  const identity = (base: unknown, assets: DurableProjectState['assets'] = []) =>
    (projectContextFacts({ ...state, assets, project: { ...state.project, identity: base === undefined ? {} : { base } } }).project as
      { identity: { base?: string } }).identity.base;
  assert.equal(identity('最可能：Kaguya（12 次）；其他候选：Milfy（7 次）'), 'Kaguya');
  assert.equal(identity('milfy'), 'Milfy');
  const asset = (name: string, kind: string, path = `/library/${name}.unitypackage`) =>
    ({ id: name, name, path, kind, status: 'ready', role: 'candidate' });
  assert.equal(identity(undefined, [asset('【オリジナル3Dモデル】ミルフィ Ver1.5', 'avatar'), asset('春の服【しなの・マヌカ対応】', 'outfit')]), 'Milfy');
  // An outfit that fits many avatars names none of them as the base; two different avatars name no single base.
  assert.equal(identity(undefined, [asset('春の服【しなの・マヌカ対応】', 'outfit')]), undefined);
  assert.equal(identity(undefined, [asset('Kaguya', 'avatar'), asset('Shinano', 'avatar')]), undefined);
});

test('a project made in Harness gains its packages and editor version once setup has made the Unity project', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-project-identity-')); t.after(() => removeTemp(root));
  const project = join(root, 'workspace', 'commission');
  mkdirSync(join(project, 'Packages'), { recursive: true }); mkdirSync(join(project, 'ProjectSettings'));
  const db = openDatabase(join(root, 'state.sqlite')); t.after(() => db.close());
  db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run('w', join(root, 'workspace'));
  db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('p', 'w', 'client', ?, '{}', 'active', 'test', 'test')`).run(project);
  assert.deepEqual((projectContextFacts(projectState(db, 'p')).project as { packageIds: string[] }).packageIds, []);
  writeFileSync(join(project, 'Packages', 'vpm-manifest.json'), JSON.stringify({ locked: {
    'com.vrchat.avatars': { version: '3.10.4' }, 'nadena.dev.modular-avatar': { version: '1.18.1' } } }));
  writeFileSync(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  const facts = projectContextFacts(projectState(db, 'p')).project as { packageIds: string[]; identity: { unityVersion: string } };
  assert.deepEqual(facts.packageIds, ['com.vrchat.avatars', 'nadena.dev.modular-avatar']);
  assert.equal(facts.identity.unityVersion, '2022.3.22f1');
});

test('a stage counts as failed only after a check of it failed, not while it waits for its first verdict', () => {
  const stage = (id: string, codes: string[]) => ({ id, status: 'blocked', reasons: [], codes });
  const facts = (stages: ReturnType<typeof stage>[], cases: DurableProjectState['cases'] = []) => (projectContextFacts({ ...state, cases,
    workflow: { id: 'w', process: 'p', status: 'active', knowledgeVersion: 'k', frozenAt: null, stages } }).history as { failedStageIds: string[] }).failedStageIds;
  assert.deepEqual(facts([stage('intake', ['missing_verdict']), stage('plan', ['needs_unmet']), stage('recolor', ['gate_pending'])]), []);
  assert.deepEqual(facts([stage('outfit', ['check_failed']), stage('menu', ['missing_verdict'])]), ['outfit']);
  assert.deepEqual(facts([], [{ taskId: 't', stage: 'setup', outcome: 'failure', attempts: 2, modelFamilies: [], reason: '', evidence: [], at: '' }]), ['setup']);
});

test('a base avatar chosen from BOOTH names the base, and outfit products do not', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-booth-base-')); t.after(() => removeTemp(root));
  const db = openDatabase(join(root, 'state.sqlite')); t.after(() => db.close());
  db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run('w', root);
  db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('p', 'w', 'client', ?, '{}', 'active', 'test', 'test')`).run(join(root, 'p'));
  const item = (id: string, name: string, category: string) => {
    db.prepare(`INSERT INTO booth_item (item_id, name, item_url, category) VALUES (?, ?, ?, ?)`).run(id, name, `https://booth.pm/items/${id}`, category);
    db.prepare(`INSERT INTO booth_file (downloadable_id, item_id, filename) VALUES (?, ?, ?)`).run(`d${id}`, id, `${id}.zip`);
    db.prepare(`INSERT INTO asset_selection_file (plan_id, downloadable_id, purpose) VALUES ('plan', ?, 'use')`).run(`d${id}`);
  };
  db.prepare(`INSERT INTO asset_selection_plan (id, project_id, status) VALUES ('plan', 'p', 'ready')`).run();
  item('1', '春の服【しなの・マヌカ対応】', '3D衣装');
  assert.equal((projectContextFacts(projectState(db, 'p')).project as { identity: { base?: string } }).identity.base, undefined);
  item('2', 'オリジナル3Dモデル「ミルフィ」', '3Dキャラクター');
  assert.equal((projectContextFacts(projectState(db, 'p')).project as { identity: { base?: string } }).identity.base, 'Milfy');
});

// `memory.project.identity.base` is computed from the alias map, so a knowledge entry whose `when:` names a body
// the map does not carry can never apply. The map is a hand-written list of names, which is exactly the shape that
// silently drifts from the knowledge pack (order D-110); this reads the pack instead of trusting the list.
const routedBases = (text: string) => [...new Set([...text.matchAll(/path: memory\.project\.identity\.base, equals: (\w+)/g)]
  .map(match => match[1]))].sort();

test('every base the built-in knowledge routes on is one the alias map can recognize', () => {
  const directory = fileURLToPath(new URL('../builtin/knowledge/process', import.meta.url));
  const pack = readdirSync(directory).filter(name => name.endsWith('.yaml'))
    .map(name => readFileSync(join(directory, name), 'utf8')).join('\n');
  assert.deepEqual(routedBases(pack), Object.keys(KNOWN_BASES).sort());
  // The extraction is not vacuous: a pack that routes on another body reports it, which is what would fail here.
  assert.deepEqual(routedBases('- {when: [{path: memory.project.identity.base, equals: Newbody}]}'), ['Newbody']);
  // No entry may claim another's name: `baseName` returns nothing as soon as two bodies match, so an alias that is
  // a substring of another body's name would quietly switch a project's base off.
  for (const [canonical, aliases] of Object.entries(KNOWN_BASES))
    for (const [other, otherAliases] of Object.entries(KNOWN_BASES))
      if (other !== canonical) for (const alias of otherAliases)
        assert.ok(!canonical.toLowerCase().includes(alias.toLowerCase()), `${other} 的别名 ${alias} 会命中 ${canonical}`);
});
