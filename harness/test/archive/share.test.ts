import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { factViews } from '../../src/archive/facts.ts';
import { registerEntries, type NewEntry } from '../../src/archive/registry.ts';
import { checkRestore, restoreReconciliation, restoreShare, searchConversation } from '../../src/archive/restore.ts';
import { compileShare, exportShare } from '../../src/archive/share.ts';
import { digestFile, scanContext } from '../../src/archive/share-scan.ts';
import { extract7z, list7z } from '../../src/archive/sevenzip.ts';
import { compactProjectContext, projectState } from '../../src/project-state.ts';
import { serveOnce } from '../../src/task-cli.ts';
import { describeWorkflow } from '../../src/workflow/view.ts';
import { harnessSide, has7z, receiverSide, resealPackage, senderProject, StageFake, treeText } from '../fixtures/share.ts';

const skip = !has7z && '7-Zip is not installed here';

test('a project shared with layer A alone restores at another path into an empty database, and its work continues there', { skip }, async t => {
  const f = await senderProject(t);
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  const shared = await exportShare(f.sender.db, env, f.projectId, {});
  assert.equal(shared.status, 'exported', JSON.stringify(shared.plan.blockers));
  assert.equal(shared.plan.level, 'continuable', shared.plan.levelReasons.join());
  const pkg = shared.package!;
  assert.ok(existsSync(pkg.path));

  // The receiver: an empty state database, a workspace elsewhere.
  const receiver = receiverSide(t, f.root);
  const renv = { home: receiver.home, workspaceRoot: receiver.workspace, workflowVariables: receiver.config.workflowVariables };
  const check = await checkRestore(receiver.db, renv, pkg.path);
  assert.equal(check.ok, true, check.problems.join('\n'));
  assert.equal(check.decision?.kind, 'new');
  assert.deepEqual(check.packs.filter(pack => pack.current).map(pack => pack.resolution), ['installed']);
  assert.equal((receiver.db.prepare('SELECT COUNT(*) AS n FROM project').get() as { n: number }).n, 0, 'a check writes nothing');

  const restored = await restoreShare(receiver.db, renv, pkg.path);
  assert.equal(restored.status, 'restored', restored.check.problems.join('\n'));
  const projectId = restored.projectId!;
  assert.ok(restored.path!.startsWith(receiver.workspace.slice(0, 8)));
  // Every stored fact came over with its id and its history.
  const senderFacts = factViews(f.sender.db, f.projectId, { history: true }).filter(fact => !['workflow', 'project'].includes(fact.source.type) && fact.shareLayer === 'A');
  const receiverFacts = new Set(factViews(receiver.db, projectId, { history: true }).map(fact => fact.id));
  for (const fact of senderFacts) assert.ok(receiverFacts.has(fact.id), `fact ${fact.objectId} ${fact.attribute}`);
  // The approval still binds the plan as it is here.
  const view = describeWorkflow(receiver.db, f.workflowId);
  assert.equal(view.gates.find(gate => gate.gate.endsWith(':plan_approval'))?.status, 'approved');
  // Stages and their Tasks stand as they stood on the sender (the extra stage's Task waits to be dispatched).
  assert.deepEqual(view.stages.map(stage => [stage.id, stage.status, stage.display, stage.task?.status]),
    describeWorkflow(f.sender.db, f.workflowId).stages.map(stage => [stage.id, stage.status, stage.display, stage.task?.status]));
  assert.deepEqual(view.stages.map(stage => [stage.id, stage.display, stage.task?.status]), [['plan', 'passed', 'PASSED'], ['make', 'passed', 'PASSED'], ['extra', 'running', 'READY']]);
  const reconciliation = restoreReconciliation(receiver.db, projectId)!;
  assert.equal(reconciliation.level, 'continuable');
  assert.ok(reconciliation.continuable.includes('extra'));
  // Work continues: the next round here runs the waiting stage and it passes.
  const executor = new StageFake(() => restored.path!);
  for (let i = 0; i < 4; i++) await serveOnce(receiver.db, receiver.config, () => executor);
  assert.equal(describeWorkflow(receiver.db, f.workflowId).stages.find(stage => stage.id === 'extra')?.status, 'passed');
  assert.ok(executor.starts.some(spec => spec.stageId === 'extra'));
  // The customer's words and the conversation stayed home: layer C was not chosen.
  const out = join(f.root, 'unpacked');
  mkdirSync(out);
  extract7z(pkg.path, out);
  for (const [path, text] of treeText(out)) {
    assert.doesNotMatch(text, /樱花色的和服|星星形状/, path);
  }
  assert.equal(existsSync(join(out, '_harness', 'sensitive', 'conversation.json')), false);
  assert.match(readFileSync(join(out, 'share', '恢复说明.md'), 'utf8'), /可直接续做/);
});

test('a conversation chosen for layer C travels only as its project document, is searchable after restore, and is not given to a new agent', { skip }, async t => {
  const f = await senderProject(t);
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  // Layer C is never taken as a whole: naming the layer alone includes nothing sensitive.
  const layerOnly = await compileShare(f.sender.db, env, f.projectId, { layers: ['A', 'C'] });
  const conversation = layerOnly.plan.items.find(item => item.id === 'C:_harness/sensitive/conversation.json');
  assert.ok(conversation, JSON.stringify(layerOnly.plan.items));
  assert.equal(conversation.included, false);
  assert.ok(layerOnly.plan.items.filter(item => item.layer === 'C').every(item => !item.included));
  const shared = await exportShare(f.sender.db, env, f.projectId, { include: ['C:_harness/sensitive/conversation.json'] });
  assert.equal(shared.status, 'exported', JSON.stringify(shared.plan.blockers));
  const out = join(f.root, 'unpacked');
  mkdirSync(out);
  extract7z(shared.package!.path, out);
  const holders = [...treeText(out)].filter(([, text]) => text.includes('星星形状')).map(([path]) => path);
  assert.deepEqual(holders, ['_harness/sensitive/conversation.json']);
  // Other sensitive material stayed home: it was not chosen.
  for (const [path, text] of treeText(out)) assert.doesNotMatch(text, /樱花色的和服|avtr_00000000/, path);

  const receiver = receiverSide(t, f.root);
  const renv = { home: receiver.home, workspaceRoot: receiver.workspace, workflowVariables: receiver.config.workflowVariables };
  const restored = await restoreShare(receiver.db, renv, shared.package!.path);
  assert.equal(restored.status, 'restored', restored.check.problems.join('\n'));
  const found = searchConversation(receiver.db, restored.projectId!, '星星形状');
  assert.deepEqual(found.map(item => [item.status, item.excerpt]), [['proposed', '对话原文：发饰要换成星星形状']]);
  // A new conversation starts from the compact of facts: the old conversation is not in it, the accepted decision is.
  const compact = compactProjectContext(projectState(receiver.db, restored.projectId!));
  assert.doesNotMatch(compact, /星星形状/);
  assert.match(compact, /确认使用粉白配色/);
  // After the restore the conversation is again a document of the project's own sensitive partition, and only there.
  const archived = [...treeText(restored.path!, path => path.startsWith('.git/'))].filter(([, text]) => text.includes('星星形状')).map(([path]) => path);
  assert.deepEqual(archived, ['_harness/sensitive/conversation.json']);
});

test('paid assets, credentials, absolute paths, unclassified files and links never ride in on a directory registration', { skip }, async t => {
  const f = await senderProject(t, { paid: true });
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  // All of these sit under `Assets/`, which a person registered as transferable as a whole.
  writeFileSync(join(f.project, 'Assets', 'Avatar', 'notes.txt'), `上传用的 key：${'sk-ant-api03-'}${'Q'.repeat(24)}7x${'z'.repeat(20)}\n`);
  writeFileSync(join(f.project, 'Assets', 'Avatar', 'notes.txt.meta'), 'guid: b0000000000000000000000000000001\n');
  writeFileSync(join(f.project, 'Assets', 'Avatar', 'tool.json'), JSON.stringify({ exportTo: join(f.project, 'Build') }));
  writeFileSync(join(f.project, 'Assets', 'Avatar', 'tool.json.meta'), 'guid: b0000000000000000000000000000002\n');
  mkdirSync(join(f.project, 'Tools'));
  writeFileSync(join(f.project, 'Tools', 'helper.py'), 'print(1)\n');
  symlinkSync(join(f.project, 'Assets', 'Avatar'), join(f.project, 'Assets', 'Linked'), 'junction');
  const blocked = await exportShare(f.sender.db, env, f.projectId, {});
  assert.equal(blocked.status, 'blocked');
  const codes = Object.fromEntries(blocked.plan.blockers.map(blocker => [blocker.code, blocker]));
  assert.deepEqual(Object.keys(codes).sort(), ['needs_review', 'rights', 'secrets', 'symlinks', 'unclassified']);
  assert.match(codes.secrets!.paths!.join(), /Assets\/Avatar\/notes\.txt:1（AI 服务的 API Key 或令牌）/);
  assert.doesNotMatch(JSON.stringify(blocked.plan), /QQQQQQQQ/, 'a credential is named by its path, never echoed');
  assert.deepEqual(codes.needs_review!.paths, ['Assets/Avatar/tool.json']);
  assert.deepEqual(codes.unclassified!.paths, ['Tools/helper.py']);
  assert.deepEqual(codes.symlinks!.paths, ['Assets/Linked']);
  assert.deepEqual(codes.rights!.groups!.map(group => [group.path, group.count]), [['Assets/Paid.meta', 1], ['Assets/Paid/', 2]]);
  assert.deepEqual(readdirSync(f.sender.exportRoot), [], 'nothing is written while anything blocks');

  // Fixed by the person: the credential and the link removed, the helper classified, the path reviewed; the paid
  // content stays out and becomes the receiver's to supply.
  rmSync(join(f.project, 'Assets', 'Avatar', 'notes.txt')); rmSync(join(f.project, 'Assets', 'Avatar', 'notes.txt.meta'));
  rmSync(join(f.project, 'Assets', 'Linked'), { recursive: false, force: true });
  registerEntries(f.sender.db, f.projectId, [{ path: 'Tools/', match: 'tree', category: 'user-classified', shareLayer: 'excluded', rights: 'unknown',
    sensitivity: 'normal', source: { type: 'user', ref: 'test' }, reason: '本机辅助脚本，不分享' }]);
  const shared = await exportShare(f.sender.db, env, f.projectId, { permittedOnly: true, acknowledge: ['Assets/Avatar/tool.json'] });
  assert.equal(shared.status, 'exported', JSON.stringify(shared.plan.blockers));
  assert.equal(shared.plan.level, 'needs_dependencies');
  assert.deepEqual(shared.plan.missing.map(item => [item.path, item.count]), [['Assets/Paid.meta', 1], ['Assets/Paid/', 2]]);
  const members = list7z(shared.package!.path).map(member => member.path);
  assert.ok(!members.some(path => /Paid|notes\.txt|Tools\/|Linked/.test(path)), members.join());
  const out = join(f.root, 'unpacked');
  mkdirSync(out);
  extract7z(shared.package!.path, out);
  const files = JSON.parse(readFileSync(join(out, 'share', 'files.json'), 'utf8')) as { excluded: Array<{ path: string; restore: string | null; reason: string }> };
  assert.deepEqual(files.excluded.filter(item => item.restore === 'acquire').map(item => item.path),
    ['Assets/Paid.meta', 'Assets/Paid/Kimono.prefab', 'Assets/Paid/Kimono.prefab.meta']);
  const manifest = JSON.parse(readFileSync(join(out, 'share', 'manifest.json'), 'utf8')) as { references: { external: Record<string, string> } };
  assert.equal(manifest.references.external['55555555555555555555555555555555'], 'missing:Assets/Paid/Kimono.prefab');
  assert.equal(manifest.references.external['44444444444444444444444444444444'], 'vpm:com.vrchat.avatars');
  assert.match(readFileSync(join(out, 'share', '恢复说明.md'), 'utf8'), /接收端待补齐[\s\S]*Assets\/Paid\//);
});

test('a self backup keeps imported paid assets and restores them on a new computer path', { skip }, async t => {
  const f = await senderProject(t, { paid: true });
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  const transfer = await compileShare(f.sender.db, env, f.projectId, { purpose: 'others' });
  assert.ok(transfer.plan.blockers.some(item => item.code === 'rights'));

  const shared = await exportShare(f.sender.db, env, f.projectId, { purpose: 'self' });
  assert.equal(shared.status, 'exported', JSON.stringify(shared.plan.blockers));
  assert.equal(shared.plan.purpose, 'self');
  assert.deepEqual(shared.plan.missing, []);
  const members = list7z(shared.package!.path).map(item => item.path);
  assert.ok(members.includes('Assets/Paid/Kimono.prefab'));
  assert.ok(members.includes('Assets/Paid/Kimono.prefab.meta'));

  const out = join(f.root, 'self-unpacked');
  mkdirSync(out);
  extract7z(shared.package!.path, out);
  const manifest = JSON.parse(readFileSync(join(out, 'share', 'manifest.json'), 'utf8')) as { purpose: string };
  assert.equal(manifest.purpose, 'self');
  assert.match(readFileSync(join(out, 'share', '恢复说明.md'), 'utf8'), /仅限本人使用，不得转交他人/);

  const receiver = receiverSide(t, f.root);
  const renv = { home: receiver.home, workspaceRoot: receiver.workspace, workflowVariables: receiver.config.workflowVariables };
  const check = await checkRestore(receiver.db, renv, shared.package!.path);
  assert.equal(check.ok, true, check.problems.join('\n'));
  assert.equal(check.manifest?.purpose, 'self');
  const restored = await restoreShare(receiver.db, renv, shared.package!.path);
  assert.equal(restored.status, 'restored', restored.check.problems.join('\n'));
  assert.equal(readFileSync(join(restored.path!, 'Assets', 'Paid', 'Kimono.prefab'), 'utf8'),
    readFileSync(join(f.project, 'Assets', 'Paid', 'Kimono.prefab'), 'utf8'));
});

test('an asset and its .meta travel together or not at all, and a folder with nothing shared keeps its GUID', { skip }, async t => {
  const f = await senderProject(t);
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  // Only one half of each pair may be passed on: the material itself, and the prefab's .meta.
  const half = (path: string): NewEntry => ({ path, match: 'file', category: 'user-classified', shareLayer: 'A', rights: 'not_transferable',
    sensitivity: 'normal', source: { type: 'user', ref: 'test' }, reason: '只有一半获准转交' });
  registerEntries(f.sender.db, f.projectId, [half('Assets/Avatar/Body.mat'), half('Assets/Avatar/Luna.prefab.meta')]);
  const shared = await exportShare(f.sender.db, env, f.projectId, { permittedOnly: true });
  assert.equal(shared.status, 'exported', JSON.stringify(shared.plan.blockers));
  const members = list7z(shared.package!.path), paths = members.map(member => member.path);
  for (const path of ['Assets/Avatar/Body.mat', 'Assets/Avatar/Body.mat.meta', 'Assets/Avatar/Luna.prefab', 'Assets/Avatar/Luna.prefab.meta'])
    assert.ok(!paths.includes(path), path);
  const reasons = Object.fromEntries(shared.plan.excluded.map(item => [item.path, [item.reason, item.restore]]));
  assert.deepEqual(reasons['Assets/Avatar/Body.mat.meta'], ['它对应的资源没有纳入，.meta 不单独分享', 'acquire']);
  assert.deepEqual(reasons['Assets/Avatar/Luna.prefab'], ['它的 .meta 没有纳入：资源不单独分享', 'acquire']);
  assert.deepEqual(shared.plan.metaPairs, { missingMeta: [], orphanMeta: [] });
  assert.equal(shared.plan.level, 'needs_dependencies');
  // The folder with nothing in it keeps its GUID: the folder and its .meta are both members.
  assert.ok(members.some(member => member.path === 'Assets/Avatar/Empty' && member.directory), paths.join());
  assert.ok(paths.includes('Assets/Avatar/Empty.meta'));
});

test('an approval of a version the receiver does not have is not valid after restore: a changed plan, or a plan left out', { skip }, async t => {
  const f = await senderProject(t);
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  const gate = (db: typeof f.sender.db) => describeWorkflow(db, f.workflowId).gates.find(item => item.gate.endsWith(':plan_approval'))!.status;
  assert.equal(gate(f.sender.db), 'approved');
  // The plan the person approved is left out of the package (its transfer is not permitted).
  registerEntries(f.sender.db, f.projectId, [{ path: '_harness/plan.yaml', match: 'file', category: 'user-classified', shareLayer: 'A', rights: 'not_transferable',
    sensitivity: 'normal', source: { type: 'user', ref: 'test' }, reason: '含客户素材的方案' }]);
  const partial = await exportShare(f.sender.db, env, f.projectId, { permittedOnly: true });
  assert.equal(partial.status, 'exported', JSON.stringify(partial.plan.blockers));
  assert.equal(partial.plan.level, 'needs_dependencies');
  assert.match(partial.plan.levelReasons.join(), /制作流程的产物.*未纳入/);
  assert.equal(gate(f.sender.db), 'approved', 'on the sender the approval still holds');
  const first = receiverSide(t, f.root);
  const renv = { home: first.home, workspaceRoot: first.workspace, workflowVariables: first.config.workflowVariables };
  const restored = await restoreShare(first.db, renv, partial.package!.path);
  assert.equal(restored.status, 'restored', restored.check.problems.join('\n'));
  assert.notEqual(gate(first.db), 'approved');
  const stale = restoreReconciliation(first.db, restored.projectId!)!.stale.map(item => item.text);
  assert.ok(stale.some(text => /决定 plan_approval/.test(text)), stale.join('\n'));
  assert.ok(stale.some(text => /检查 plan_has_title/.test(text)), stale.join('\n'));

  // The plan changed on the sender after the approval: the archive already says so, and so does the receiver.
  registerEntries(f.sender.db, f.projectId, [{ path: '_harness/plan.yaml', match: 'file', category: 'user-classified', shareLayer: 'A', rights: 'transferable',
    sensitivity: 'normal', source: { type: 'user', ref: 'test' }, reason: '方案' }]);
  writeFileSync(join(f.project, '_harness', 'plan.yaml'), JSON.stringify({ title: 'Luna 改', extra: true }));
  const changed = await exportShare(f.sender.db, env, f.projectId, {});
  assert.equal(changed.status, 'exported', JSON.stringify(changed.plan.blockers));
  assert.equal(gate(f.sender.db), 'stale');
  const second = harnessSide(t, f.root, 'second receiver');
  const again = await restoreShare(second.db, { home: second.home, workspaceRoot: second.workspace, workflowVariables: {} }, changed.package!.path);
  assert.equal(again.status, 'restored', again.check.problems.join('\n'));
  assert.equal(gate(second.db), 'stale');
  const decisions = JSON.parse(readFileSync(join(again.path!, '_harness', 'records', 'decisions.json'), 'utf8')) as
    { workflows: Array<{ gates: Array<{ gateId: string; valid: boolean | null }> }> };
  assert.deepEqual(decisions.workflows[0]!.gates.map(item => [item.gateId, item.valid]), [['plan_approval', false]]);
});

test('the same input gives the same members and the same content list; the 7z bytes are not promised', { skip }, async t => {
  const f = await senderProject(t);
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  const first = await exportShare(f.sender.db, env, f.projectId, {});
  const second = await exportShare(f.sender.db, env, f.projectId, {});
  assert.equal(second.status, 'exported');
  const read = (path: string, name: string): string => {
    const dir = join(f.root, `read-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir); extract7z(path, dir);
    return readFileSync(join(dir, 'share', name), 'utf8');
  };
  assert.equal(read(first.package!.path, 'files.json'), read(second.package!.path, 'files.json'));
  assert.deepEqual(list7z(first.package!.path).map(member => member.path).sort(), list7z(second.package!.path).map(member => member.path).sort());
  const one = JSON.parse(read(first.package!.path, 'manifest.json')) as Record<string, unknown>;
  const two = JSON.parse(read(second.package!.path, 'manifest.json')) as Record<string, unknown>;
  const differing = Object.keys(one).filter(key => JSON.stringify(one[key]) !== JSON.stringify(two[key]));
  // Each export is its own share (a new id, a time, and the earlier export in its lineage); the content is the same.
  assert.deepEqual(differing.sort(), ['createdAt', 'project', 'shareId']);
  assert.deepEqual({ ...(one.project as object), lineage: [] }, { ...(two.project as object), lineage: [] });
});

test('an archive written before the conversation had its own file (sensitive/1) still restores, messages included', { skip }, async t => {
  const f = await senderProject(t);
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  const shared = await exportShare(f.sender.db, env, f.projectId, { include: ['C:_harness/sensitive/conversation.json', 'C:_harness/sensitive/project.json'] });
  assert.equal(shared.status, 'exported', JSON.stringify(shared.plan.blockers));
  const dir = join(f.root, 'legacy');
  mkdirSync(dir);
  extract7z(shared.package!.path, dir);
  // Rewrite the package as a Harness of archive v1 wrote it: the messages inside sensitive/project.json.
  const path = (name: string) => join(dir, ...name.split('/'));
  const json = (name: string) => JSON.parse(readFileSync(path(name), 'utf8')) as Record<string, any>;
  const write = (name: string, value: unknown) => writeFileSync(path(name), `${JSON.stringify(value, null, 2)}\n`);
  const conversation = json('_harness/sensitive/conversation.json');
  write('_harness/sensitive/project.json', { ...json('_harness/sensitive/project.json'), schema: 'harness-project-sensitive/1', messages: conversation.messages });
  rmSync(path('_harness/sensitive/conversation.json'));
  const archive = json('_harness/archive.json');
  for (const file of archive.files as Array<Record<string, any>>) if (file.path === '_harness/sensitive/project.json') file.schema = 'harness-project-sensitive/1';
  write('_harness/archive.json', archive);
  write('share/manifest.json', { ...json('share/manifest.json'), selection: { ...json('share/manifest.json').selection, items: ['C:_harness/sensitive/project.json'] } });
  const legacy = join(f.root, 'legacy.7z');
  resealPackage(dir, legacy);

  const receiver = receiverSide(t, f.root);
  const restored = await restoreShare(receiver.db, { home: receiver.home, workspaceRoot: receiver.workspace, workflowVariables: {} }, legacy);
  assert.equal(restored.status, 'restored', restored.check.problems.join('\n'));
  assert.deepEqual(searchConversation(receiver.db, restored.projectId!, '星星形状').map(item => item.id), ['m-proposed']);
  // The brief keeps the customer's words, the root its Blueprint ID: that item was chosen.
  assert.equal((receiver.db.prepare('SELECT customer_request FROM project_brief WHERE project_id = ?').get(restored.projectId!) as { customer_request: string })
    .customer_request, '客户原话：想要樱花色的和服（仅在敏感层）');
  assert.equal((receiver.db.prepare('SELECT blueprint_id FROM avatar_root WHERE project_id = ?').get(restored.projectId!) as { blueprint_id: string }).blueprint_id,
    'avtr_00000000-1111-2222-3333-444444444444');
});

test('a same-size rewrite with its timestamp restored cannot ride into a package on the cached digest (DATA/D6)', async t => {
  const f = await senderProject(t);
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  // Under the fixture's registered `Assets/` tree, so it is an ordinary layer A member of the list.
  const notes = join(f.project, 'Assets', 'Avatar', 'notes.txt');
  const secret = `sk-ant-${'A'.repeat(24)}`;   // the scanner's key shape ...
  const benign = 'B'.repeat(secret.length);    // ... and exactly as many bytes
  // A whole second: writing it back reproduces the size+mtime+file-id key exactly.
  const stamp = new Date(Math.floor(Date.now() / 1000) - 3600);
  const write = (body: string): void => { writeFileSync(notes, body); utimesSync(notes, stamp, stamp); };
  const listed = (compiled: { entries: Array<{ path: string; sha256?: string | null }> }): string | null | undefined =>
    compiled.entries.find(entry => entry.path === 'Assets/Avatar/notes.txt')?.sha256;

  write(benign);
  const preview = await compileShare(f.sender.db, env, f.projectId, { preview: true });
  const clean = listed(preview);
  assert.ok(clean, JSON.stringify(preview.plan.blockers));
  assert.deepEqual(preview.plan.findings.filter(finding => finding.path === 'Assets/Avatar/notes.txt'), [], 'the file is innocuous to begin with');

  // Same byte count, same modification time, same file id: the key the cache trusts does not move.
  write(secret);
  // The cache still earns its keep where nothing is kept as evidence -- that is what it is for.
  assert.equal(listed(await compileShare(f.sender.db, env, f.projectId, { preview: true })), clean, 'a preview may reuse the cached digest');

  // The export forces the evidence path even when a caller asks for a preview: the planted credential is found and
  // stops the package, and the correction is visible instead of silently swapping the digest.
  const blocked = await exportShare(f.sender.db, env, f.projectId, { preview: true });
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.plan.findings.some(finding => finding.path === 'Assets/Avatar/notes.txt' && finding.kind === 'secret'),
    'the credential planted by the same-size rewrite must be reported');
  assert.ok(blocked.plan.blockers.some(blocker => blocker.code === 'secrets' &&
    (blocker.paths ?? []).some(path => path.startsWith('Assets/Avatar/notes.txt'))), JSON.stringify(blocked.plan.blockers));
  assert.ok(blocked.plan.warnings.some(warning => /内容却与上次扫描不同/.test(warning)), blocked.plan.warnings.join('\n'));

  // A compile that is not a preview carries the content's own digest, whatever the cache still holds.
  const compiled = await compileShare(f.sender.db, env, f.projectId, {});
  assert.equal(listed(compiled), digestFile(notes, scanContext(f.sender.home, [])).sha256);
  assert.notEqual(listed(compiled), clean);
});
