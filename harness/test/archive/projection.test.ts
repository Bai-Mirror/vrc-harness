import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { localPathLeaks, portableText } from '../../src/archive/contract.ts';
import { factViews, recordFacts } from '../../src/archive/facts.ts';
import {
  archiveStatus, buildProjection, checkProjectArchive, projectSafePoint, verifiedProjectionChanges, writeProjectArchive, type ArchiveManifest,
} from '../../src/archive/projection.ts';
import { BUILTIN_RULES, classifier, registerEntries, storedEntries, type RegistryEntry } from '../../src/archive/registry.ts';
import { scanProject } from '../../src/archive/scan.ts';
import { importProject } from '../../src/import/index.ts';
import { packTreeHash } from '../../src/pack-hash.ts';
import { writeProjectState } from '../../src/project-state.ts';
import { openDatabase, SCHEMA_VERSION } from '../../src/state/db.ts';
import { SchedulerLeaseLostError } from '../../src/state/scheduler-lease.ts';
import { approvedWorkflow, archiveFixture, IMPORT_DEFINITION } from '../fixtures/archive.ts';
import { removeTemp } from '../fixtures/platform.ts';

const read = (project: string, path: string): string => readFileSync(join(project, ...path.split('/')), 'utf8');
const manifestOf = (project: string): ArchiveManifest => JSON.parse(read(project, '_harness/archive.json')) as ArchiveManifest;
const eventsOf = (project: string) => (JSON.parse(read(project, '_harness/records/events.json')) as
  { events: Array<{ action: string; reason: string; payload: unknown }> }).events;
const latestScan = (f: { db: DatabaseSync }, projectId: string) => f.db.prepare(`SELECT files, unclassified, unclassified_json, symlinks_json
  FROM project_scan WHERE project_id = ? ORDER BY seq DESC LIMIT 1`).get(projectId) as { files: number; unclassified: number;
    unclassified_json: string; symlinks_json: string };

test('files nobody registered wait in the 待分类 queue; a directory alone never classifies them', t => {
  const f = archiveFixture(t, { record: true });
  const { projectId } = f.imported();
  // After the import: a new asset, a file inside a plugin's own Library folder, an editor cache, a directory link.
  mkdirSync(join(f.project, 'Assets/Plugin/Library'), { recursive: true });
  writeFileSync(join(f.project, 'Assets/New.png'), 'png');
  writeFileSync(join(f.project, 'Assets/Plugin/Library/Tool.cs'), 'class Tool {}');
  mkdirSync(join(f.project, 'Library'));
  writeFileSync(join(f.project, 'Library/cache.bin'), 'cache');
  symlinkSync(join(f.project, 'Assets/Avatar'), join(f.project, 'Assets/Linked'), 'junction');
  scanProject(f.db, projectId, { tree: true });
  const scan = latestScan(f, projectId);
  assert.deepEqual(JSON.parse(scan.unclassified_json), ['Assets/New.png', 'Assets/Plugin/Library/Tool.cs']);
  assert.deepEqual(JSON.parse(scan.symlinks_json), ['Assets/Linked']);
  const status = archiveStatus(f.db, projectId);
  assert.ok(status.shareable.blockers.some(item => item.code === 'unclassified'));
  assert.ok(status.shareable.blockers.some(item => item.code === 'symlinks'));
  // Present at import: registered as found there, origin unknown; the Unity body is layer A but not yet transferable.
  const registry = classifier([...BUILTIN_RULES, ...storedEntries(f.db, projectId)]);
  assert.deepEqual(pick(registry.classify('Assets/Avatar/Avatar.prefab')), ['unity-asset', 'A', 'unknown', 'import_scan']);
  assert.deepEqual(pick(registry.classify('ProjectSettings/ProjectVersion.txt')), ['unity-settings', 'A', 'transferable', 'import_scan']);
  assert.deepEqual(pick(registry.classify('_施工记录.md')), ['project-record', 'C', 'unknown', 'import_scan']);
  assert.deepEqual(pick(registry.classify('Packages/com.vrchat.avatars/package.json')), ['vpm-package', 'excluded', 'unknown', 'vpm']);
  assert.equal(registry.skipped('Library/'), true);
  assert.equal(registry.skipped('Assets/Plugin/Library/'), false, 'cache rules are anchored at the project root');
  // A person classifies the new asset: it leaves the queue.
  registerEntries(f.db, projectId, [{ path: 'Assets/New.png', match: 'file', category: 'user-classified', shareLayer: 'A',
    rights: 'transferable', sensitivity: 'normal', source: { type: 'user', ref: 'test' }, reason: '自己画的贴图' }]);
  scanProject(f.db, projectId, { tree: true });
  assert.deepEqual(JSON.parse(latestScan(f, projectId).unclassified_json), ['Assets/Plugin/Library/Tool.cs']);
  // Harness's own partitions are Harness's to classify.
  assert.throws(() => registerEntries(f.db, projectId, [{ path: '_harness/state/', match: 'tree', category: 'x', shareLayer: 'A',
    rights: 'transferable', sensitivity: 'normal', source: { type: 'user', ref: 'test' }, reason: '想分享' }]), /Harness 自有分区/);
});
const pick = (entry: RegistryEntry | undefined) => entry && [entry.category, entry.shareLayer, entry.rights, entry.source.type];

test('registry precedence: source priority, then specificity, then the newest; a tie on a case-insensitive disk takes the stricter', () => {
  const entry = (path: string, match: RegistryEntry['match'], type: RegistryEntry['source']['type'], layer: RegistryEntry['shareLayer'],
    seq: number): RegistryEntry => ({ path, match, category: `${type}-${layer}`, shareLayer: layer, rights: 'unknown', sensitivity: 'normal',
    source: { type, ref: 'r' }, reason: 'r', seq });
  const registry = classifier([entry('Assets/', 'tree', 'user', 'B', 1), entry('Assets/a.png', 'file', 'import_scan', 'A', 2),
    entry('Assets/a.png', 'file', 'user', 'C', 3), entry('Assets/b.png', 'file', 'import_scan', 'A', 4), entry('Assets/b.png', 'file', 'import_scan', 'B', 5)], false);
  assert.equal(registry.classify('Assets/a.png')!.shareLayer, 'C', 'a person\'s registration beats the import\'s');
  assert.equal(registry.classify('Assets/c.png')!.shareLayer, 'B', 'a tree registration covers what nothing more specific does');
  assert.equal(registry.classify('Assets/b.png')!.shareLayer, 'B', 'the newest of equals wins');
  // On Windows `_Harness/Recovery/` and `_harness/recovery/` are one directory: the Harness file keeps its own rule,
  // anything else there takes the stricter of the two tree rules.
  const windows = classifier(BUILTIN_RULES, true), linux = classifier(BUILTIN_RULES, false);
  assert.equal(windows.classify('_Harness/Recovery/takeover.json')!.shareLayer, 'A');
  assert.equal(windows.classify('_harness/recovery/analysis.json')!.shareLayer, 'C');
  assert.equal(linux.classify('_harness/recovery/analysis.json')!.shareLayer, 'A');
  assert.equal(linux.classify('_Harness/Recovery/analysis.json')!.shareLayer, 'C');
  assert.equal(linux.classify('Top.csproj')!.shareLayer, 'excluded');
  assert.equal(linux.classify('Assets/Top.csproj'), undefined, 'root suffixes only match at the root');
});

test('portable text keeps relative paths and Unity object paths, and nothing local survives on either platform', () => {
  assert.equal(portableText('见 C:\\work\\Sample\\Assets\\a.png', [{ path: 'C:\\work\\Sample', label: '' }], true), '见 Assets\\a.png');
  assert.equal(portableText('c:/WORK/sample/Assets/a.png', [{ path: 'C:\\work\\Sample', label: '' }], true), 'Assets/a.png');
  assert.equal(portableText('另一盘：D:\\other\\x.fbx', [{ path: 'C:\\work\\Sample', label: '' }], true), '另一盘：<本机路径>');
  assert.equal(portableText('/srv/example-home/work/Sample/Assets/a.png；/srv/example-home/other', [{ path: '/srv/example-home/work/Sample', label: '' }], false),
    'Assets/a.png；<本机路径>');
  assert.equal(portableText('/Kaguya/Body 与 https://booth.pm/items/1', [], false), '/Kaguya/Body 与 https://booth.pm/items/1');
  // Under another local root nothing of the rest survives: a folder name there can name a customer.
  assert.equal(portableText('见 /srv/ws/客户甲/x.fbx 与 /srv/ws', [{ path: '/srv/ws', label: '<工作区>' }], false), '见 <工作区> 与 <工作区>');
  assert.equal(portableText('D:\\ws\\客户乙\\a 与 D:\\wsx', [{ path: 'D:\\ws', label: '<工作区>' }], true), '<工作区> 与 <本机路径>');
  assert.deepEqual(localPathLeaks({ a: 'Assets/x', b: '/Kaguya/Body', c: ['ok'] }, []), []);
  assert.deepEqual(localPathLeaks({ a: 'D:\\x\\y', b: ['/Users/u/x'], 'C:\\key': 1 }, []).map(leak => leak.pointer).sort(), ['/C:\\key', '/a', '/b/0']);
  assert.deepEqual(localPathLeaks({ a: '工程在 /w/p 里' }, [{ path: '/w/p', label: '' }], false).map(leak => leak.pointer), ['/a']);
});

/** An imported project with a Workflow, a brief and a message: every partition has something to carry. */
function populated(t: Parameters<typeof archiveFixture>[0]) {
  const f = archiveFixture(t, { record: true, git: true });
  writeFileSync(join(f.project, '_任务账本.md'), '- [ ] T1 补上客户要的裙摆 — 负责：用户\n');
  const { projectId } = f.imported();
  approvedWorkflow(f.db, projectId, f.project);
  f.db.prepare(`INSERT INTO project_brief (project_id, intake_mode, customer_request, face_concept, status) VALUES (?, 'import', ?, '温柔', 'draft')`)
    .run(projectId, '客户原话：想要樱花色的和服');
  f.db.prepare(`INSERT INTO project_message (id, project_id, role, content, status) VALUES ('m1', ?, 'user', '保留原有表情', 'accepted')`).run(projectId);
  // Free text written on this machine names local paths: a Run's reason, a person's note.
  f.db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json) VALUES ('flow-1', 'runtime', 'task', 't',
    'RUNNING->FAILED', ?, ?)`).run(`无法读取 ${join(f.project, 'Assets', 'Avatar', 'Avatar.prefab')}`, JSON.stringify({ log: join(f.root, 'home', 'runs', 'r1') }));
  f.db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason) VALUES ('flow-1', 'human', 'gate', 'flow-1:approval',
    'approved', ?)`).run(`看过 ${join(f.workspace, 'Sample')} 里的方案`);
  scanProject(f.db, projectId, { tree: true });
  return { ...f, projectId };
}

test('the projection round-trips the database with only relative paths, and each layer lands in its partition', t => {
  const f = populated(t);
  const written = writeProjectArchive(f.db, f.projectId);
  assert.equal(written.status, 'verified', written.error);
  const manifest = manifestOf(f.project);
  assert.equal(manifest.schema, 'harness-project-archive/1');
  assert.equal(manifest.revision, written.revision);
  assert.deepEqual(manifest.files.map(file => file.path).sort(), ['_harness/evidence/index.json', '_harness/optional/facts.json',
    '_harness/packs/index.json', '_harness/records/decisions.json', '_harness/records/events.json', '_harness/records/sources.json',
    '_harness/recovery/takeover.json', '_harness/sensitive/conversation.json', '_harness/sensitive/facts.json', '_harness/sensitive/project.json',
    '_harness/state/facts.json', '_harness/state/production.json', '_harness/state/project.json', '_harness/state/project.yaml', '_harness/state/registry.json', '_harness/state/workflows.json']);
  // The conversation is a document of its own (a share can carry it without the customer's other material).
  const conversation = JSON.parse(read(f.project, '_harness/sensitive/conversation.json')) as { schema: string; messages: Array<{ id: string; content: string }> };
  assert.equal(conversation.schema, 'harness-project-conversation/1');
  assert.deepEqual(conversation.messages.map(item => item.id), ['m1']);
  assert.equal((JSON.parse(read(f.project, '_harness/sensitive/project.json')) as Record<string, unknown>).messages, undefined);
  assert.equal(manifest.files.find(file => file.path === '_harness/sensitive/project.json')?.schema, 'harness-project-sensitive/2');
  const everything = manifest.files.map(file => read(f.project, file.path)).join('\n') + read(f.project, '_harness/archive.json');
  for (const local of [f.root, f.project, f.workspace, f.root.replaceAll('\\', '/')]) assert.ok(!everything.includes(local), `no ${local}`);
  assert.doesNotMatch(everything, /(^|[^A-Za-z0-9_])[A-Za-z]:[\\/]/, 'no drive-letter path');
  // Round trip: the facts of the three partitions are the database's facts, with the status they have now.
  const projected = ['state', 'optional', 'sensitive'].flatMap(partition =>
    (JSON.parse(read(f.project, `_harness/${partition}/facts.json`)) as { facts: Array<{ id: string; effectiveStatus: string; shareLayer: string }> }).facts);
  const views = factViews(f.db, f.projectId, { history: true }).filter(fact => fact.shareLayer !== 'excluded');
  assert.deepEqual(projected.map(fact => [fact.id, fact.effectiveStatus]).sort(), views.map(fact => [fact.id, fact.effectiveStatus]).sort());
  for (const fact of projected) assert.equal(fact.shareLayer, { 'A': 'A', 'B': 'B', 'C': 'C' }[fact.shareLayer]);
  // The customer's own words and the ledger's text stay in the sensitive partition; the approval sits in the decisions.
  const sensitive = ['_harness/sensitive/project.json', '_harness/sensitive/facts.json'].map(path => read(f.project, path)).join('');
  assert.match(sensitive, /想要樱花色的和服/);
  assert.match(sensitive, /补上客户要的裙摆/);
  for (const file of manifest.files.filter(item => !item.path.startsWith('_harness/sensitive/')))
    assert.doesNotMatch(read(f.project, file.path), /想要樱花色的和服|补上客户要的裙摆/, file.path);
  assert.ok(manifest.files.filter(item => item.path.startsWith('_harness/sensitive/')).every(item => item.layer === 'C'));
  const decisions = JSON.parse(read(f.project, '_harness/records/decisions.json')) as { workflows: Array<{ gates: Array<{ gateId: string; valid: boolean }> }> };
  assert.deepEqual(decisions.workflows[0]!.gates.map(gate => [gate.gateId, gate.valid]), [['approval', true]]);
  const yaml = read(f.project, '_harness/state/project.yaml');
  assert.match(yaml, /schema: harness-project-state\/0\.2/);
  assert.doesNotMatch(yaml, /想要樱花色的和服/);
  // Free text keeps what a path inside the project was, relative to it; another local place becomes a word as a whole.
  const failure = eventsOf(f.project).find(event => event.action === 'RUNNING->FAILED')!;
  assert.match(failure.reason, /^无法读取 Assets[\\/]Avatar[\\/]Avatar\.prefab$/);
  assert.deepEqual(failure.payload, { log: '<AVH_HOME>' });
  // The same database projects to the same bytes: nothing depends on the clock.
  assert.equal(buildProjection(f.db, f.projectId, manifest.archiveId).digest, manifest.digest);
  assert.equal(writeProjectArchive(f.db, f.projectId).status, 'unchanged');
});

test('a moved project keeps a valid archive: the same content from its new place, and another database keeps its identity', t => {
  const f = populated(t);
  assert.equal(writeProjectArchive(f.db, f.projectId).status, 'verified');
  const before = manifestOf(f.project);
  // The whole workspace moves elsewhere (another directory; on Windows it could as well be another drive) and the
  // state database learns its new place: the archive in it is still exactly what the database projects.
  const moved = join(f.root, 'elsewhere', 'moved-workspace');
  mkdirSync(join(f.root, 'elsewhere'));
  renameSync(f.workspace, moved);
  f.db.prepare('UPDATE workspace SET path = ?').run(moved);
  const project = join(moved, 'Sample');
  // Nothing in the archive depended on where it was: its files still verify, and every structured file projects the
  // same. Only free text that named the old place (a Run's reason, a person's note) now reads as a local path.
  const check = checkProjectArchive(f.db, f.projectId);
  assert.equal(check.state, 'outdated', check.problems.join());
  assert.deepEqual(check.changed, ['_harness/records/events.json', '_harness/sensitive/project.json']);
  for (const file of before.files) assert.ok(!read(project, file.path).includes(moved) && !read(project, file.path).includes(f.workspace), file.path);
  assert.equal(writeProjectArchive(f.db, f.projectId).status, 'verified');
  assert.equal(checkProjectArchive(f.db, f.projectId).state, 'consistent');
  assert.equal(eventsOf(project).find(event => event.action === 'RUNNING->FAILED')!.reason, '无法读取 <本机路径>');
  // Another Harness with an empty state database imports it from there: a new database project (its id derives from
  // the path) that carries the archive's portable identity over.
  const home = join(f.root, 'receiver', 'state');
  mkdirSync(home, { recursive: true });
  const receiver = openDatabase(join(home, 'harness.db'));
  t.after(() => receiver.close());
  const report = importProject(receiver, { workspacePath: moved, projectPath: project, definition: IMPORT_DEFINITION, kind: 'private',
    config: { toolRoot: '/synthetic/no-tools' } });
  assert.equal(writeProjectArchive(receiver, report.projectId).status, 'verified');
  assert.equal(manifestOf(project).archiveId, before.archiveId);
  assert.equal((receiver.prepare('SELECT origin FROM project_archive_identity WHERE project_id = ?').get(report.projectId) as { origin: string }).origin, 'adopted');
});

test('the consistency check tells an outdated archive from one that diverged from the database', t => {
  const f = populated(t);
  assert.equal(writeProjectArchive(f.db, f.projectId).status, 'verified');
  assert.deepEqual(checkProjectArchive(f.db, f.projectId), { state: 'consistent', revision: 1, problems: [], changed: [] });
  // The database moved on: outdated until the next safe point, with the files that will change.
  recordFacts(f.db, f.projectId, [{ objectId: 'project', attribute: 'note', value: '新观察', source: { type: 'harness_scan', ref: 'test' },
    observer: 'test', status: 'observed', evidenceLevel: 'observation', scope: 'project', shareLayer: 'A' }]);
  const outdated = checkProjectArchive(f.db, f.projectId);
  assert.equal(outdated.state, 'outdated');
  assert.ok(outdated.changed.includes('_harness/state/facts.json'));
  assert.equal(writeProjectArchive(f.db, f.projectId).status, 'verified');
  assert.equal(checkProjectArchive(f.db, f.projectId).state, 'consistent');
  // A projection file edited by hand: diverged, and the next write repairs it.
  writeFileSync(join(f.project, '_harness/state/facts.json'), `${read(f.project, '_harness/state/facts.json')} `);
  const diverged = checkProjectArchive(f.db, f.projectId);
  assert.equal(diverged.state, 'diverged');
  assert.match(diverged.problems.join(), /_harness\/state\/facts\.json 与档案清单记录的内容不同/);
  assert.equal(writeProjectArchive(f.db, f.projectId).status, 'verified');
  assert.equal(checkProjectArchive(f.db, f.projectId).state, 'consistent');
  // A manifest the database never fixed (copied from elsewhere): diverged.
  const manifest = manifestOf(f.project);
  writeFileSync(join(f.project, '_harness/archive.json'), JSON.stringify({ ...manifest, revision: 99 }));
  assert.match(checkProjectArchive(f.db, f.projectId).problems.join(), /状态库没有修订 99/);
});

test('a failed write is recorded, blocks a shareable export, and waits before retrying the same revision', t => {
  const f = populated(t);
  // `_harness/state` is a file: the partition cannot be written.
  mkdirSync(join(f.project, '_harness'), { recursive: true });
  writeFileSync(join(f.project, '_harness/state'), 'in the way');
  const failed = writeProjectArchive(f.db, f.projectId);
  assert.equal(failed.status, 'failed');
  const blocked = archiveStatus(f.db, f.projectId);
  assert.equal(blocked.write?.status, 'failed');
  assert.ok(blocked.shareable.blockers.some(item => item.code === 'projection_failed'), JSON.stringify(blocked.shareable));
  assert.equal(blocked.shareable.ok, false);
  const revisions = () => (f.db.prepare('SELECT COUNT(*) AS n FROM project_revision').get() as { n: number }).n;
  const count = revisions();
  const again = writeProjectArchive(f.db, f.projectId);
  const retried = again.status === 'deferred' ? again : writeProjectArchive(f.db, f.projectId);
  assert.equal(retried.status, 'deferred', 'a safe point does not hammer a failing write');
  assert.ok(revisions() <= count + 1);
  rmSync(join(f.project, '_harness/state'));
  assert.equal(writeProjectArchive(f.db, f.projectId, { force: true }).status, 'verified');
  const fixed = archiveStatus(f.db, f.projectId);
  assert.ok(!fixed.shareable.blockers.some(item => item.code === 'projection_failed' || item.code === 'projection_missing'));
  // A read-back that does not match what was written fails the write too.
  recordFacts(f.db, f.projectId, [{ objectId: 'project', attribute: 'note', value: 2, source: { type: 'harness_scan', ref: 'test' },
    observer: 'test', status: 'observed', evidenceLevel: 'observation', scope: 'project', shareLayer: 'A' }]);
  const corrupted = writeProjectArchive(f.db, f.projectId, { beforeVerify: root => writeFileSync(join(root, '_harness/records/sources.json'), '{}') });
  assert.equal(corrupted.status, 'failed');
  assert.match(corrupted.error ?? '', /sources\.json 与档案清单记录的内容不同/);
  assert.ok(archiveStatus(f.db, f.projectId).shareable.blockers.some(item => item.code === 'projection_failed'));
});

test('walking the project again without finding anything new writes no new revision', t => {
  const f = populated(t);
  assert.equal(projectSafePoint(f.db, f.projectId, { tree: true, force: true }).status, 'verified');
  const revision = (f.db.prepare('SELECT MAX(number) AS n FROM project_revision WHERE project_id = ?').get(f.projectId) as { n: number }).n;
  for (let i = 0; i < 2; i++) assert.equal(projectSafePoint(f.db, f.projectId, { tree: true, force: true }).status, 'unchanged');
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM project_scan WHERE project_id = ?').get(f.projectId) as { n: number }).n >= 3, true, 'the walks happened');
  assert.equal((f.db.prepare('SELECT MAX(number) AS n FROM project_revision WHERE project_id = ?').get(f.projectId) as { n: number }).n, revision);
  // A walk that finds something new is a change.
  writeFileSync(join(f.project, 'Assets', 'New.png'), 'png');
  assert.equal(projectSafePoint(f.db, f.projectId, { tree: true, force: true }).status, 'verified');
  assert.equal((f.db.prepare('SELECT MAX(number) AS n FROM project_revision WHERE project_id = ?').get(f.projectId) as { n: number }).n, revision + 1);
});

test('nothing is written while a Run works in the project; the legacy state file follows the archive', t => {
  const f = populated(t);
  f.db.prepare("INSERT INTO task (id, workflow_id, stage_id, goal, capability, status) VALUES ('busy', 'flow-1', 'plan', 'g', 'executor', 'RUNNING')").run();
  const deferred = projectSafePoint(f.db, f.projectId);
  assert.equal(deferred.status, 'deferred');
  assert.match(deferred.reason ?? '', /正在执行/);
  assert.equal(existsSync(join(f.project, '_harness/archive.json')), false);
  assert.ok(archiveStatus(f.db, f.projectId).shareable.blockers.some(item => item.code === 'active_run'));
  f.db.prepare("UPDATE task SET status = 'PASSED' WHERE id = 'busy'").run();
  const state = writeProjectState(f.db, f.projectId);
  assert.equal(state.path, join(f.project, '_harness', 'state', 'project.yaml'));
  assert.ok(existsSync(state.path));
  assert.match(state.compact, /项目：/, 'the conversation still gets its compact with the local path');
  assert.equal(checkProjectArchive(f.db, f.projectId).state, 'consistent');
});

test('a live setup review keeps read-side safe points from changing the protected project', t => {
  const f = populated(t);
  f.db.prepare(`INSERT INTO project_interaction(id,project_id,command_id,payload_json,revision,status)
    VALUES ('m1',?,'review-request','{}',1,'answered')`).run(f.projectId);
  f.db.prepare(`INSERT INTO production_proposal(id,project_id,revision,profile,request,inputs_json,context_json,status,workflow_id)
    VALUES ('m1',?,1,'setup-flow','original requirement','{}','{}','working','flow-1')`).run(f.projectId);
  const record = (status: string, actor = 'runtime', projectId = f.projectId, ownerPid = process.pid) => {
    f.db.prepare(`INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json)
      VALUES ('flow-1',?,'production_proposal','m1','setup_review','review',?)`).run(actor, JSON.stringify({
        action: 'resume', command: { id: 'm1', projectId, commandId: 'review-1' },
        recovery: { commandId: 'review-1', projectId, workflowId: 'flow-1', ownerPid, status, phase: 'observing' },
      }));
  };
  record('running');
  const before = latestScan(f, f.projectId);
  for (let i = 0; i < 2; i++) {
    const result = projectSafePoint(f.db, f.projectId, { tree: true, force: true });
    assert.equal(result.status, 'deferred');
    assert.match(result.reason ?? '', /核对原工程/);
  }
  assert.equal(existsSync(join(f.project, '_harness/archive.json')), false);
  assert.deepEqual(latestScan(f, f.projectId), before);
  // A GUI/human event cannot release the Runtime's live review.
  record('succeeded', 'human');
  assert.equal(projectSafePoint(f.db, f.projectId).status, 'deferred');
  record('failed');
  assert.equal(projectSafePoint(f.db, f.projectId, { force: true }).status, 'verified');
  const manifest = read(f.project, '_harness/archive.json');
  record('running');
  const owner = { proposalId: 'm1', workflowId: 'flow-1', commandId: 'review-1', ownerPid: process.pid };
  const proof = (candidate?: typeof owner) => verifiedProjectionChanges(f.db, f.projectId,
    '2000-01-01T00:00:00Z', ['_harness/archive.json'], candidate);
  assert.equal(proof(), undefined);
  assert.ok(proof(owner), 'the exact current owner may only read the verified prior receipt');
  assert.equal(proof({ ...owner, commandId: 'another-command' }), undefined);
  assert.equal(proof({ ...owner, proposalId: 'another-proposal' }), undefined);
  assert.equal(proof({ ...owner, workflowId: 'another-workflow' }), undefined);
  assert.equal(proof({ ...owner, ownerPid: 2147483647 }), undefined);
  assert.equal(projectSafePoint(f.db, f.projectId).status, 'deferred', 'read-only proof does not release writers');
  f.db.prepare(`INSERT INTO task(id,workflow_id,stage_id,goal,capability,status)
    VALUES ('during-review','flow-1','plan','g','executor','RUNNING')`).run();
  assert.equal(proof(owner), undefined, 'the read exception never bypasses a real running task');
  f.db.prepare("UPDATE task SET status='PASSED' WHERE id='during-review'").run();
  record('running', 'runtime', 'another-project');
  assert.notEqual(projectSafePoint(f.db, f.projectId, { force: true }).status, 'deferred');
  record('running', 'runtime', f.projectId, 2147483647);
  assert.notEqual(projectSafePoint(f.db, f.projectId, { force: true }).status, 'deferred', 'a dead owner is unknown, never a permanent live lock');
  assert.ok(manifest.length > 0);
});

test('a project candidate pack is recorded with what restores it: hashes, permissions and the trial scope', t => {
  const f = populated(t);
  const draft = join(f.project, '_harness/candidate-packs/local-pack');
  mkdirSync(join(draft, 'knowledge'), { recursive: true });
  writeFileSync(join(draft, 'pack.json'), '{"schema":"harness-managed-pack/0.1","id":"local-pack"}');
  const stored = join(f.root, 'home', 'managed', 'candidates', 'local-pack');
  cpSync(draft, stored, { recursive: true });
  const hash = packTreeHash(stored).hash;
  f.db.prepare(`INSERT INTO managed_pack_candidate (id, base_pack_id, version, root, content_hash, source_kind, reason, permissions_json, status)
    VALUES ('local-pack', 'builtin', '1-candidate', ?, ?, 'ai', '鞋底穿模', '{"network":false,"writes":["project","run"]}', 'evaluated')`).run(stored, hash);
  f.db.prepare(`INSERT INTO managed_pack_authoring (id, project_id, base_pack_id, candidate_id, source_root, reason, status)
    VALUES ('a1', ?, 'builtin', 'local-pack', ?, '鞋底穿模', 'registered')`).run(f.projectId, draft);
  f.db.prepare(`INSERT INTO managed_pack_trial (id, candidate_id, project_id, content_hash, mode, restrictions_json, approved_by)
    VALUES ('trial-1', 'local-pack', ?, ?, 'project', '{"network":false,"globalDefault":false}', 'local-user')`).run(f.projectId, hash);
  const packs = () => { scanProject(f.db, f.projectId, { tree: true }); assert.equal(writeProjectArchive(f.db, f.projectId).status, 'verified');
    return JSON.parse(read(f.project, '_harness/packs/index.json')) as { candidates: Array<{ id: string; contentHash: string; restoreFrom: string;
      permissions: unknown; draft: { path: string; matchesContent: boolean } }>; trials: Array<{ contentHash: string; restrictions: unknown }> }; };
  const first = packs();
  assert.deepEqual(first.candidates.map(item => [item.id, item.contentHash, item.restoreFrom, item.draft.path]),
    [['local-pack', hash, 'project-draft', '_harness/candidate-packs/local-pack/']]);
  assert.deepEqual(first.candidates[0]!.permissions, { network: false, writes: ['project', 'run'] });
  assert.deepEqual(first.trials.map(item => [item.contentHash, item.restrictions]), [[hash, { network: false, globalDefault: false }]]);
  // The draft was edited after registration: only the local candidate store still holds the registered content.
  writeFileSync(join(draft, 'knowledge', 'extra.md'), '# 后来改的\n');
  assert.equal(packs().candidates[0]!.restoreFrom, 'local-store');
});

test('the archive migration applies to an existing database and keeps its data (append-only)', t => {
  const directory = mkdtempSync(join(tmpdir(), 'avh-archive-migration-'));
  t.after(() => removeTemp(directory));
  const path = join(directory, 'state.sqlite');
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)');
  const migrations = new URL('../../src/state/migrations/', import.meta.url);
  const files = ['0001_init', '0002_task_proofs', '0003_lock_epoch', '0004_import_report', '0005_provider_snapshot', '0006_outbox_closed',
    '0007_scheduler_lease', '0008_formal_workflow', '0009_product_catalog', '0010_project_assets', '0011_project_variants',
    '0012_workflow_context', '0013_workflow_pack', '0014_workflow_variables', '0015_booth_jit_assets', '0016_managed_pack_lifecycle',
    '0017_candidate_trials', '0018_candidate_authoring', '0019_contribution_queue', '0020_contribution_receipts', '0021_project_recovery'];
  files.forEach((name, i) => { old.exec(readFileSync(new URL(`${name}.sql`, migrations), 'utf8')); old.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1); });
  old.prepare("INSERT INTO workspace (id, path) VALUES ('w', ?)").run(directory);
  old.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('p', 'w', 'private', 'p', '{"unityVersion":"2022.3.22f1"}', 'imported', 'h', 'k')`).run();
  old.prepare("INSERT INTO event (actor, entity_type, entity_id, action, reason) VALUES ('import', 'project', 'p', 'observed', 'legacy')").run();
  old.close();
  const db = openDatabase(path);
  t.after(() => db.close());
  assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 38);
  assert.ok(db.prepare('PRAGMA table_info(gate_decision)').all().some(column => column.name === 'selection_json'), 'legacy databases gain concrete decision evidence without rewriting their existing facts');
  assert.equal((db.prepare("SELECT identity_json FROM project WHERE id = 'p'").get() as { identity_json: string }).identity_json, '{"unityVersion":"2022.3.22f1"}');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n, 1);
  for (const table of ['project_fact', 'project_input_observation', 'project_file_entry', 'project_scan', 'project_archive_identity',
    'project_revision', 'project_archive_write', 'project_share', 'project_restore', 'project_sync'])
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  // The existing project can take facts right away, and they cannot be rewritten or removed.
  recordFacts(db, 'p', [{ objectId: 'project', attribute: 'unity.version', value: '2022.3.22f1', source: { type: 'user', ref: 'test' }, observer: 'user',
    status: 'user_confirmed', evidenceLevel: 'attestation', scope: 'project', shareLayer: 'A' }]);
  for (const table of ['project_fact']) {
    assert.throws(() => db.exec(`UPDATE ${table} SET scope = 'x'`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /append-only/);
  }
  db.prepare("INSERT INTO project_revision (project_id, number, digest) VALUES ('p', 1, ?)").run('0'.repeat(64));
  assert.throws(() => db.exec("UPDATE project_revision SET number = 2"), /append-only/);
  // Shares, restores and sync points are history too (migration 0023).
  const zero = '0'.repeat(64);
  db.prepare(`INSERT INTO project_share (id, project_id, archive_id, revision, digest, level, selection_json, output, package_sha256, package_bytes, files_sha256, report_json)
    VALUES ('sh', 'p', 'a', 1, ?, 'continuable', '{}', 'x.7z', ?, 1, ?, '{}')`).run(zero, zero, zero);
  db.prepare(`INSERT INTO project_restore (id, project_id, share_id, archive_id, source_revision, source_digest, decision, report_json)
    VALUES ('r', 'p', 's', 'a', 1, ?, 'new', '{}')`).run(zero);
  db.prepare("INSERT INTO project_sync (project_id, share_id, direction, revision, digest) VALUES ('p', 's', 'export', 1, ?)").run(zero);
  for (const table of ['project_share', 'project_restore', 'project_sync']) {
    assert.throws(() => db.exec(`UPDATE ${table} SET project_id = 'x'`), /append-only/, table);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /append-only/, table);
  }
  assert.throws(() => db.prepare("INSERT INTO project_sync (project_id, share_id, direction, revision, digest) VALUES ('p', 's', 'sideways', 1, ?)")
    .run('0'.repeat(64)), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO project_archive_write (project_id, revision, status, error) VALUES ('p', 1, 'verified', 'x')").run(), /CHECK/);
});

/**
 * The project scan before the archive write is long. A lease taken over meanwhile must stop the write before its
 * transaction is opened. Without the heartbeat at the write boundary the archive is written and verified under the
 * new owner, and the round only finds out on its next renewal.
 */
test('the archive write stops before its transaction when the scheduler lease was lost', t => {
  const f = archiveFixture(t, { record: true });
  const { projectId } = f.imported();
  const writes = () => Number((f.db.prepare('SELECT count(*) AS n FROM project_archive_write WHERE project_id = ?')
    .get(projectId) as { n: number }).n);
  const revisions = () => Number((f.db.prepare('SELECT count(*) AS n FROM project_revision WHERE project_id = ?')
    .get(projectId) as { n: number }).n);
  const beforeWrites = writes(), beforeRevisions = revisions();
  assert.throws(() => writeProjectArchive(f.db, projectId, { heartbeat: () => { throw new SchedulerLeaseLostError(); } }),
    /Scheduler lease lost/);
  assert.equal(writes(), beforeWrites, 'a write whose lease was already gone records nothing');
  assert.equal(revisions(), beforeRevisions, 'no revision is fixed either');
});
