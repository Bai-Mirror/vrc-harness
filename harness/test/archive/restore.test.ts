import { acceptedFaceIdentity, inputSha256, readRunInputSnapshot } from '../../src/workflow/inputs.ts';
import { canonicalJson } from '../../src/pack-hash.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { completeRestore, checkRestore, restoreReconciliation, restoreShare } from '../../src/archive/restore.ts';
import { compileShare, exportShare } from '../../src/archive/share.ts';
import { extract7z, pack7z, read7zMember } from '../../src/archive/sevenzip.ts';
import { hostPlatform } from '../../src/host-platform.ts';
import { managedPacks } from '../../src/managed-pack.ts';
import { packCandidate, registerPackCandidate } from '../../src/managed-pack-candidate.ts';
import { releasePayload, type SignedPackRelease } from '../../src/managed-pack-update.ts';
import { packTreeHash, writeModesSidecar } from '../../src/pack-hash.ts';
import { SCHEMA_VERSION } from '../../src/state/db.ts';
import { serveOnce, taskRecover } from '../../src/task-cli.ts';
import { describeWorkflow } from '../../src/workflow/view.ts';
import { has7z, listTree, receiverSide, resealPackage, senderProject, StageFake, writeCandidate, writePack } from '../fixtures/share.ts';

const skip = !has7z && '7-Zip is not installed here';

/** A minimal ustar writer (the update service's format), for a signed release of the test pack. */
function ustar(root: string): Buffer {
  const blocks: Buffer[] = [];
  const add = (path: string, mode: number, type: string, body = Buffer.alloc(0)): void => {
    const header = Buffer.alloc(512);
    header.write(path, 0, 100); header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8);
    header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12); header.write('00000000000\0', 136, 12);
    header.write(type, 156, 1); header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    header.fill(32, 148, 156); let sum = 0; for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  };
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), rel = relative(root, path).split(sep).join('/');
      if (statSync(path).isDirectory()) { add(rel, 0o755, '5'); visit(path); } else add(rel, 0o644, '0', readFileSync(path));
    }
  };
  visit(root);
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

test('a missing generic pack is installed from a signed release or waits as 待安装; a project pack comes back only as a candidate', { skip }, async t => {
  const f = await senderProject(t);
  // A project pack, registered from the project's draft and then edited there: only the local store holds the
  // registered content, so the package carries it.
  const draft = join(f.project, '_harness', 'candidate-packs', 'luna-candidate');
  writeCandidate(draft);
  const candidate = registerPackCandidate(f.sender.db, f.sender.home, draft, { basePackId: 'test-pack', sourceKind: 'ai', reason: '鞋底穿模', impact: {},
    permissions: { network: false, writes: ['project', 'run'] } });
  f.sender.db.prepare(`INSERT INTO managed_pack_authoring (id, project_id, base_pack_id, candidate_id, source_root, reason, status)
    VALUES ('authoring-1', ?, 'test-pack', 'luna-candidate', ?, '鞋底穿模', 'registered')`).run(f.projectId, draft);
  writeFileSync(join(draft, 'knowledge', 'SOP', 'extra.md'), '# 后来改的\n');
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  const shared = await exportShare(f.sender.db, env, f.projectId, {});
  assert.equal(shared.status, 'exported', JSON.stringify(shared.plan.blockers));
  assert.deepEqual(shared.plan.dependencies.projectPacks.map(pack => [pack.id, pack.from, pack.contentHash]),
    [['luna-candidate', 'share/packs/luna-candidate/', candidate.contentHash]]);
  assert.deepEqual(shared.plan.dependencies.packs.map(pack => [pack.id, pack.version, pack.channel, pack.current]), [['test-pack', '1.0.0', 'dev', true]]);

  // A receiver without the generic pack and without the network: the Workflow waits (待安装), nothing guessed.
  const receiver = receiverSide(t, f.root, { pack: false });
  const renv = { home: receiver.home, workspaceRoot: receiver.workspace, workflowVariables: {} };
  const check = await checkRestore(receiver.db, renv, shared.package!.path);
  assert.equal(check.ok, true, check.problems.join('\n'));
  assert.deepEqual(check.packs.map(pack => [pack.resolution, pack.current]), [['missing', true]]);
  assert.deepEqual(check.projectPacks.map(pack => [pack.id, pack.ok]), [['luna-candidate', true]]);
  const restored = await restoreShare(receiver.db, renv, shared.package!.path);
  assert.equal(restored.status, 'restored', restored.check.problems.join('\n'));
  let reconciliation = restoreReconciliation(receiver.db, restored.projectId!)!;
  assert.equal(reconciliation.level, 'needs_dependencies');
  assert.deepEqual(reconciliation.pending.map(item => item.bound), [false]);
  assert.match(reconciliation.pending[0]!.text, /缺少能力包 test-pack 1\.0\.0/);
  assert.equal(receiver.db.prepare('SELECT 1 FROM workflow_definition WHERE workflow_id = ?').get(f.workflowId), undefined, 'the scheduler does not run it');
  // The project pack is a candidate here: verified, not evaluated, not a managed pack, no trial.
  assert.equal(packCandidate(receiver.db, 'luna-candidate')?.status, 'generated');
  assert.equal(packCandidate(receiver.db, 'luna-candidate')?.contentHash, candidate.contentHash);
  assert.deepEqual(managedPacks(receiver.home).map(pack => pack.id), []);
  assert.equal((receiver.db.prepare('SELECT COUNT(*) AS n FROM managed_pack_trial').get() as { n: number }).n, 0);
  assert.ok(reconciliation.candidates.some(text => /luna-candidate 已恢复为候选/.test(text)), reconciliation.candidates.join('\n'));
  // Once the pack is installed, the restore completes and the work continues.
  writePack(join(receiver.home, 'managed', 'packs', 'test-pack'));
  assert.deepEqual(completeRestore(receiver.db, renv, restored.projectId!).map(item => item.bound), [true]);
  reconciliation = restoreReconciliation(receiver.db, restored.projectId!)!;
  assert.deepEqual(reconciliation.pending.map(item => item.bound), [true]);
  const executor = new StageFake(() => restored.path!);
  for (let i = 0; i < 4; i++) await serveOnce(receiver.db, receiver.config, () => executor);
  assert.equal(describeWorkflow(receiver.db, f.workflowId).stages.find(stage => stage.id === 'extra')?.status, 'passed');

  // A pack of the same id and version with other content is not that pack, even where the files it froze agree.
  const lookalike = receiverSide(t, join(f.root, 'lookalike'));
  writeFileSync(join(lookalike.packRoot, 'knowledge', 'SOP', 'unrelated.md'), '# 另加的文件\n');
  const differs = await checkRestore(lookalike.db, { home: lookalike.home, workspaceRoot: lookalike.workspace, workflowVariables: {} }, shared.package!.path);
  assert.deepEqual(differs.packs.map(pack => pack.resolution), ['missing']);
  // Nor is a pack whose record claims that content while a tool the Workflow froze differs.
  const tampered = receiverSide(t, join(f.root, 'tampered'));
  const record = join(tampered.packRoot, 'pack.json');
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), contentHash: shared.plan.dependencies.packs[0]!.contentHash }));
  writeFileSync(join(tampered.packRoot, 'tools', 'count.mjs'), '// another tool\n');
  const claimed = await checkRestore(tampered.db, { home: tampered.home, workspaceRoot: tampered.workspace, workflowVariables: {} }, shared.package!.path);
  assert.deepEqual(claimed.packs.map(pack => pack.resolution), ['missing']);

  // Another receiver may fetch the pack: a signed release on the update service with exactly that content.
  const other = receiverSide(t, join(f.root, 'network'), { pack: false });
  const source = join(f.root, 'release-pack');
  writePack(source);
  const keys = generateKeyPairSync('ed25519'), trustedKeys = { 'test-1': keys.publicKey.export({ format: 'pem', type: 'spki' }).toString() };
  const unsigned: SignedPackRelease = { schema: 'harness-pack-release/0.1', releaseId: 'test-pack-1.0.0', packId: 'test-pack', version: '1.0.0',
    contentHash: packTreeHash(source).hash, issuedAt: '2026-09-28T06:00:00Z', minimumStateSchema: SCHEMA_VERSION, previousPackIds: [], keyId: 'test-1', signature: '' };
  const manifest = { ...unsigned, signature: sign(null, releasePayload(unsigned), keys.privateKey).toString('base64') };
  const archive = gzipSync(ustar(source));
  const endpoint = 'https://updates.test/v1/knowledge/releases', url = 'https://updates.test/v1/knowledge/files/test-pack.tar.gz';
  const fetcher = (async (input: string | URL | Request) => String(input).startsWith(endpoint)
    ? Response.json({ releases: [{ manifest, archive: { name: 'test-pack.tar.gz', size: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), url } }] })
    : new Response(new Uint8Array(archive))) as typeof fetch;
  const oenv = { home: other.home, workspaceRoot: other.workspace, workflowVariables: {}, allowNetwork: true, knowledge: { fetcher, endpoint, trustedKeys } };
  const offered = await checkRestore(other.db, oenv, shared.package!.path);
  assert.deepEqual(offered.packs.map(pack => [pack.resolution, pack.releaseId]), [['release', 'test-pack-1.0.0']]);
  const fetched = await restoreShare(other.db, oenv, shared.package!.path);
  assert.equal(fetched.status, 'restored', fetched.check.problems.join('\n'));
  assert.deepEqual(restoreReconciliation(other.db, fetched.projectId!)!.pending, []);
  assert.ok(other.db.prepare('SELECT 1 FROM workflow_definition WHERE workflow_id = ?').get(f.workflowId));
  assert.ok(existsSync(join(other.home, 'managed', 'packs', 'test-pack', 'pack.json')));
});

test('a project pack keeps its executable files on the way, from the local store or as a draft in the project', { skip }, async t => {
  for (const edited of [true, false]) {
    const f = await senderProject(t);
    const draft = join(f.project, '_harness', 'candidate-packs', 'luna-candidate');
    writeCandidate(draft);
    writeFileSync(join(draft, 'tools', 'run.sh'), '#!/bin/sh\nexit 0\n');
    // The pack's hash covers the executable bit: Windows keeps it beside the tree.
    if (process.platform === 'win32') writeModesSidecar(draft, ['tools/run.sh']); else chmodSync(join(draft, 'tools', 'run.sh'), 0o755);
    const candidate = registerPackCandidate(f.sender.db, f.sender.home, draft, { basePackId: 'test-pack', sourceKind: 'ai', reason: '鞋底穿模', impact: {},
      permissions: { network: false, writes: ['project', 'run'] } });
    f.sender.db.prepare(`INSERT INTO managed_pack_authoring (id, project_id, base_pack_id, candidate_id, source_root, reason, status)
      VALUES ('authoring-1', ?, 'test-pack', 'luna-candidate', ?, '鞋底穿模', 'registered')`).run(f.projectId, draft);
    // Edited after registration, only the local store holds the registered content; unedited, the draft travels in the project.
    if (edited) writeFileSync(join(draft, 'knowledge', 'SOP', 'extra.md'), '# 后来改的\n');
    const shared = await exportShare(f.sender.db, { home: f.sender.home, exportRoot: f.sender.exportRoot }, f.projectId, {});
    assert.equal(shared.status, 'exported', JSON.stringify(shared.plan.blockers));
    const from = edited ? 'share/packs/luna-candidate/' : '_harness/candidate-packs/luna-candidate/';
    assert.deepEqual(shared.plan.dependencies.projectPacks.map(pack => pack.from), [from]);
    const listed = JSON.parse(read7zMember(shared.package!.path, 'share/files.json').toString('utf8')) as { entries: Array<{ path: string; mode?: number }> };
    assert.equal(listed.entries.find(entry => entry.path === `${from}tools/run.sh`)?.mode, 0o755, from);

    const receiver = receiverSide(t, join(f.root, edited ? 'from-store' : 'from-draft'));
    const restored = await restoreShare(receiver.db, { home: receiver.home, workspaceRoot: receiver.workspace, workflowVariables: {} }, shared.package!.path);
    assert.equal(restored.status, 'restored', restored.check.problems.join('\n'));
    assert.deepEqual(restored.check.projectPacks.map(pack => [pack.id, pack.ok]), [['luna-candidate', true]], from);
    assert.equal(packCandidate(receiver.db, 'luna-candidate')?.contentHash, candidate.contentHash, from);
    if (!edited) assert.equal(packTreeHash(join(restored.path!, '_harness', 'candidate-packs', 'luna-candidate')).hash, candidate.contentHash);
  }
});

test('the same project comes back as the same, an update, or a copy beside it; local work is never overwritten', { skip }, async t => {
  const f = await senderProject(t);
  const env = { home: f.sender.home, exportRoot: f.sender.exportRoot };
  const first = await exportShare(f.sender.db, env, f.projectId, {});
  assert.equal(first.status, 'exported', JSON.stringify(first.plan.blockers));
  const receiver = receiverSide(t, f.root);
  const renv = { home: receiver.home, workspaceRoot: receiver.workspace, workflowVariables: {} };
  const restored = await restoreShare(receiver.db, renv, first.package!.path);
  assert.equal(restored.status, 'restored', restored.check.problems.join('\n'));
  const projects = () => (receiver.db.prepare('SELECT COUNT(*) AS n FROM project').get() as { n: number }).n;

  // The same package again: nothing to do, unless a copy is asked for; a copy has its own identity and ids.
  const same = await restoreShare(receiver.db, renv, first.package!.path);
  assert.equal(same.status, 'unchanged');
  assert.equal(same.check.decision?.kind, 'same');
  assert.equal(projects(), 1);
  const copy = await restoreShare(receiver.db, renv, first.package!.path, { asCopy: true });
  assert.equal(copy.status, 'restored', copy.check.problems.join('\n'));
  assert.equal(copy.check.decision?.action, 'copy');
  assert.equal(projects(), 2);
  assert.notEqual(copy.path, restored.path);
  const identities = receiver.db.prepare('SELECT archive_id FROM project_archive_identity').all() as Array<{ archive_id: string }>;
  assert.equal(new Set(identities.map(row => row.archive_id)).size, 2);
  assert.equal((receiver.db.prepare('SELECT COUNT(*) AS n FROM workflow').get() as { n: number }).n, 2, 'the copy runs its own Workflow');

  // Looking is not changing: a share preview on the receiver walks and archives its project again.
  const looked = await compileShare(receiver.db, { home: receiver.home }, restored.projectId!, {});
  assert.equal(looked.plan.ready, true, JSON.stringify(looked.plan.blockers));
  // The sender goes on: a newer revision of the same project updates the receiver in place, which has not changed.
  writeFileSync(join(f.project, 'Assets', 'Avatar', 'Body.mat'), '%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_Name: Body2\n');
  f.sender.db.prepare(`INSERT INTO project_variant (id, project_id, name, description, status) VALUES ('v-summer', ?, '夏装', '新造型', 'planned')`).run(f.projectId);
  const second = await exportShare(f.sender.db, env, f.projectId, {});
  assert.equal(second.status, 'exported');
  const update = await checkRestore(receiver.db, renv, second.package!.path);
  assert.equal(update.decision?.kind, 'update', update.decision?.text);
  const updated = await restoreShare(receiver.db, renv, second.package!.path, { expect: 'update' });
  assert.equal(updated.status, 'restored', updated.check.problems.join('\n'));
  assert.equal(updated.projectId, restored.projectId);
  assert.equal(updated.path, restored.path);
  assert.match(readFileSync(join(updated.path!, 'Assets', 'Avatar', 'Body.mat'), 'utf8'), /Body2/);
  const backup = updated.reconciliation!.backup!;
  assert.ok(existsSync(join(backup, 'Assets', 'Avatar', 'Body.mat')), 'the files it replaced are kept');
  assert.ok(existsSync(join(updated.path!, '.git')), 'the project keeps its own version history');
  assert.equal((receiver.db.prepare("SELECT COUNT(*) AS n FROM project_variant WHERE id = 'v-summer'").get() as { n: number }).n, 1);

  // Both sides change: the next package is a copy beside the receiver's work, which stays as it is.
  writeFileSync(join(updated.path!, 'Assets', 'Avatar', 'local.txt'), '接收方自己的改动');
  f.sender.db.prepare(`INSERT INTO project_variant (id, project_id, name, description, status) VALUES ('v-winter', ?, '冬装', '又一个造型', 'planned')`).run(f.projectId);
  const third = await exportShare(f.sender.db, env, f.projectId, {});
  const conflict = await restoreShare(receiver.db, renv, third.package!.path, { expect: 'update' });
  assert.equal(conflict.status, 'blocked', 'the decision the person saw no longer holds');
  const beside = await restoreShare(receiver.db, renv, third.package!.path);
  assert.equal(beside.status, 'restored', beside.check.problems.join('\n'));
  assert.equal(beside.check.decision?.kind, 'conflict');
  assert.match(beside.check.decision!.text, /新增 Assets\/Avatar\/local\.txt/);
  assert.notEqual(beside.projectId, restored.projectId);
  assert.equal(readFileSync(join(updated.path!, 'Assets', 'Avatar', 'local.txt'), 'utf8'), '接收方自己的改动');
});

test('a stage that was under way on the sender waits for a person after restore, with a Run to reconcile', { skip }, async t => {
  const f = await senderProject(t);
  const shared = await exportShare(f.sender.db, { home: f.sender.home, exportRoot: f.sender.exportRoot }, f.projectId, {});
  assert.equal(shared.status, 'exported', JSON.stringify(shared.plan.blockers));
  // The archive as it would read had it been written while the stage ran (Harness writes none then; a package may
  // still come from a state written that way, or from a Harness that did).
  const dir = join(f.root, 'under-way');
  mkdirSync(dir);
  extract7z(shared.package!.path, dir);
  const statePath = join(dir, '_harness', 'state', 'project.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as { tasks: Array<{ stage: string; status: string }> };
  state.tasks.find(task => task.stage === 'extra')!.status = 'RUNNING';
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const underWay = join(f.root, 'under-way.7z');
  resealPackage(dir, underWay);

  const receiver = receiverSide(t, f.root);
  const renv = { home: receiver.home, workspaceRoot: receiver.workspace, workflowVariables: receiver.config.workflowVariables };
  const restored = await restoreShare(receiver.db, renv, underWay);
  assert.equal(restored.status, 'restored', restored.check.problems.join('\n'));
  const extra = () => describeWorkflow(receiver.db, f.workflowId).stages.find(stage => stage.id === 'extra')!;
  const task = extra().task!;
  assert.equal(task.status, 'RECOVERY_REQUIRED');
  const reconciliation = restoreReconciliation(receiver.db, restored.projectId!)!;
  assert.deepEqual(reconciliation.recovery.map(item => item.taskId), [task.id]);
  assert.ok(!reconciliation.continuable.includes('extra'));
  assert.ok(receiver.db.prepare('SELECT 1 FROM run WHERE task_id = ?').get(task.id), 'a Run stands in for the one that happened elsewhere');
  // Nothing runs it again until a person has looked; then it runs here.
  const executor = new StageFake(() => restored.path!);
  await serveOnce(receiver.db, receiver.config, () => executor);
  assert.ok(!executor.starts.some(spec => spec.stageId === 'extra'));
  await taskRecover(receiver.db, receiver.config, task.id, 'no_side_effects', '原机上这一步没有留下结果', true);
  for (let i = 0; i < 4; i++) await serveOnce(receiver.db, receiver.config, () => executor);
  assert.equal(extra().status, 'passed');
});

test('a package that is not exactly what it lists is refused before anything is written', { skip }, async t => {
  const f = await senderProject(t);
  const shared = await exportShare(f.sender.db, { home: f.sender.home, exportRoot: f.sender.exportRoot }, f.projectId, {});
  assert.equal(shared.status, 'exported');
  const receiver = receiverSide(t, f.root);
  const renv = { home: receiver.home, workspaceRoot: receiver.workspace, workflowVariables: {} };
  const original = join(f.root, 'original');
  mkdirSync(original);
  extract7z(shared.package!.path, original);
  let n = 0;
  const variant = (change: (dir: string) => void): string => {
    const dir = join(f.root, `variant-${++n}`);
    cpSync(original, dir, { recursive: true });
    change(dir);
    const archive = join(f.root, `variant-${n}.7z`);
    pack7z(archive, dir, listTree(dir), join(f.root, `variant-${n}.txt`));
    return archive;
  };
  const cases: Array<[string, (dir: string) => void, RegExp]> = [
    ['an extra member', dir => writeFileSync(join(dir, 'Assets', 'extra.txt'), 'x'), /清单之外的 Assets\/extra\.txt/],
    ['changed bytes', dir => writeFileSync(join(dir, 'Assets', 'Avatar', 'Body.mat'), readFileSync(join(dir, 'Assets', 'Avatar', 'Body.mat'), 'utf8').replace('Body', 'Bodz')),
      /Assets\/Avatar\/Body\.mat 的 CRC 与清单不符/],
    ['a missing member', dir => rmSync(join(dir, 'Assets', 'Avatar', 'Luna.prefab')), /缺少清单里的 Assets\/Avatar\/Luna\.prefab/],
    ['an unknown format', dir => { const path = join(dir, 'share', 'manifest.json'); writeFileSync(path, readFileSync(path, 'utf8').replace('harness-share/1', 'harness-share/9')); },
      /不认识的分享包格式/],
    ['a newer Harness', dir => { const path = join(dir, 'share', 'manifest.json'); const manifest = JSON.parse(readFileSync(path, 'utf8')) as { producer: { stateSchema: number } };
      manifest.producer.stateSchema = 999; writeFileSync(path, JSON.stringify(manifest)); }, /来自更新的 Harness/],
  ];
  for (const [what, change, problem] of cases) {
    const archive = variant(change);
    const result = await restoreShare(receiver.db, renv, archive);
    assert.equal(result.status, 'blocked', what);
    assert.match(result.check.problems.join('\n'), problem, what);
  }
  // A member whose name climbs out of the project is refused from the listing, before anything is unpacked.
  const climbing = variant(() => undefined);
  execFileSync(hostPlatform.toolCommand('7z'), ['rn', climbing, 'Assets/Avatar/Body.mat', '../escape.mat'], { stdio: 'pipe', windowsHide: true });
  const refused = await restoreShare(receiver.db, renv, climbing);
  assert.equal(refused.status, 'blocked');
  assert.match(refused.check.problems.join('\n'), /不安全的成员路径：\.\.[\\/]escape\.mat/);
  assert.equal(existsSync(join(receiver.workspace, '..', 'escape.mat')), false);
  assert.equal((receiver.db.prepare('SELECT COUNT(*) AS n FROM project').get() as { n: number }).n, 0, 'nothing reached the state database');
  assert.deepEqual(readdirSync(receiver.workspace), [], 'nothing was left in the workspace');
});

for(const layers of [['A'],['A','B']])test(`cold export and moved restore retain immutable manual values, formal input revisions and real Run snapshots (${layers.join('+')})`, {skip}, async t => {
  const f=await senderProject(t,{frozenProjectAsset:true});
  const values=JSON.stringify({schema:'manual-values/0.1',sourceSha256:'a'.repeat(64),rendererPath:'Face',meshName:'Face',values:{Contour:.25},rangeOverrides:{},submittedSha256:'b'.repeat(64)});
  f.sender.db.prepare("INSERT INTO face_manual_session(id,project_id,project_path,target_id,state,version,accepted_json) VALUES('accepted-face',?,?,'target','accepted',1,?)").run(f.projectId,join(f.project,'manual-source'),values);
  f.sender.db.prepare("INSERT INTO face_manual_session(id,project_id,project_path,target_id,state,version,accepted_json,parent_session_id) VALUES('accepted-child',?,?,'target','accepted',2,?,'accepted-face')").run(f.projectId,join(f.project,'manual-child'),values);
  const identity=acceptedFaceIdentity(f.sender.db,f.projectId,'accepted-face');
  const event=f.sender.db.prepare("INSERT INTO event(workflow_id,actor,entity_type,entity_id,action,reason,payload_json) VALUES(?,'runtime','workflow_input','cold-input','face_input_adopted','Fixture accepted face input',?) RETURNING seq").get(f.workflowId,JSON.stringify(identity))!;
  const faceHash=inputSha256(canonicalJson({schema:'workflow-input/0.1',activationId:'cold-input',faceIdentity:identity}));
  f.sender.db.prepare('INSERT INTO workflow_input_revision VALUES(?,?,?,?,?,?,?,?)').run('cold-revision',f.workflowId,1,'cold-input',event.seq!,null,JSON.stringify(identity),faceHash);
  f.sender.db.prepare("INSERT INTO face_preference(project_id,mode,accepted_session_id,revision) VALUES(?,'manual','accepted-face',1)").run(f.projectId);
  const original=f.sender.db.prepare('SELECT * FROM run_input_snapshot ORDER BY rowid').all();assert.ok(original.length>0);
  const originalManifest=JSON.parse(String(f.sender.db.prepare('SELECT manifest_json FROM workflow_definition WHERE workflow_id=?').get(f.workflowId)!.manifest_json));
  const shared=await exportShare(f.sender.db,{home:f.sender.home,exportRoot:f.sender.exportRoot},f.projectId,{layers});
  assert.equal(shared.status,'exported',JSON.stringify(shared.plan.blockers));
  const receiver=receiverSide(t,f.root);const env={home:receiver.home,workspaceRoot:receiver.workspace,workflowVariables:{}};
  const restored=await restoreShare(receiver.db,env,shared.package!.path);assert.equal(restored.status,'restored',restored.check.problems.join('\n'));
  const row=receiver.db.prepare("SELECT accepted_json,id FROM face_manual_session WHERE project_id=? AND state='accepted'").get(restored.projectId!)!;
  assert.equal(row.accepted_json,values);
  const child=receiver.db.prepare("SELECT parent_session_id FROM face_manual_session WHERE id='accepted-child' AND project_id=?").get(restored.projectId!)!;
  assert.equal(child.parent_session_id,row.id);

  assert.equal(receiver.db.prepare("SELECT face_input_hash FROM workflow_input_revision WHERE activation_id='cold-input'").get()!.face_input_hash,faceHash);
  const manifest=JSON.parse(String(receiver.db.prepare('SELECT manifest_json FROM workflow_definition WHERE workflow_id=?').get(f.workflowId)!.manifest_json));
  assert.equal(manifest.assets[0].sha256,originalManifest.assets[0].sha256);assert.equal(manifest.assets[0].item,join(String(receiver.db.prepare('SELECT path FROM project WHERE id=?').get(restored.projectId!)!.path),'Assets/Avatar/Luna.prefab'));
  for(const snapshot of original) {
    const result=readRunInputSnapshot(receiver.db,String(snapshot.run_id));assert.ok(result,JSON.stringify({run:snapshot.run_id,retained:receiver.db.prepare('SELECT document_json FROM production_archive_reference WHERE project_id=?').get(restored.projectId!)}));
    assert.equal(result.planSha256,snapshot.effective_plan_sha256);
    const source=JSON.parse(String(f.sender.db.prepare('SELECT result_json FROM run WHERE id=?').get(snapshot.run_id!)!.result_json)),restoredRun=JSON.parse(String(receiver.db.prepare('SELECT result_json FROM run WHERE id=?').get(snapshot.run_id!)!.result_json));
    assert.deepEqual(restoredRun.verifiedArtifactHashes,source.verifiedArtifactHashes??{});
  }
  assert.ok(receiver.db.prepare("SELECT run_id FROM stage_completion WHERE workflow_id=? AND stage_id='plan'").get(f.workflowId)!.run_id);
  assert.ok(receiver.db.prepare('SELECT document_json FROM production_archive_reference WHERE project_id=?').get(restored.projectId!));
});
