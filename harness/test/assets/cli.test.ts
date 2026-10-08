import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { upsertBoothFile, upsertBoothItem } from '../../src/booth/catalog.ts';
import { openDatabase } from '../../src/state/db.ts';
import { removeTemp } from '../fixtures/platform.ts';

const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-assets-cli-'));
  t.after(() => removeTemp(root));
  const home = join(root, 'home'), tools = join(root, 'tools'), knowledge = join(root, 'knowledge');
  for (const dir of [join(home, 'config'), join(home, 'state'), join(root, 'workspace'), join(tools, '审查/perception'), join(knowledge, 'process'), join(root, 'export')])
    mkdirSync(dir, { recursive: true });
  for (const file of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) writeFileSync(join(tools, file), '');
  writeFileSync(join(knowledge, 'process/flow.yaml'), stringify({ schema: 'process/0.1', id: 'flow', version: 'v1', applies_to: {}, artifacts: ['plan'],
    stages: [{ id: 'plan', needs: [], produces: ['plan'], requires: [], gates: [], invalidated_by: [] }], checks: [], gates: [], milestones: [] }));
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: '1', t: {} }));
  writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: join(root, 'workspace'), toolRoot: tools, knowledgeRoot: knowledge,
    exportRoots: [join(root, 'export')], knownBodies: [], projectAliases: {}, sampleNames: [], defaultProfile: 'flow',
    processDefinitions: { flow: 'process/flow.yaml' }, thresholdsFile: 'thresholds.yaml' }));
  const db = openDatabase(join(home, 'state/harness.db'));
  upsertBoothItem(db, { itemId: '1', name: '春のワンピース', shopName: 'Alpha', owned: true, status: 'available', tags: ['しなの対応'],
    metadata: { category: { name: '3D衣装' }, variations: [{ name: 'MANUKA' }], description: '対応アバター：ルルネ' } });
  upsertBoothItem(db, { itemId: '2', name: 'ロングヘアー', shopName: 'Beta', owned: true, status: 'available', metadata: { category: { name: '3D装飾品' } } });
  upsertBoothFile(db, { downloadableId: '11', itemId: '1', filename: 'Spring_MANUKA.zip', byteSize: 10, status: 'available' });
  db.close();
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'assets', ...args], { encoding: 'utf8', env: { ...process.env, AVH_HOME: home } });
  return { root, home, run };
}

test('avh assets lists, filters and answers the review queue with the same rules as the API', t => {
  const f = fixture(t);
  const listed = f.run('list', '--category', '服装', '--avatar', 'マヌカ');
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n').slice(0, 2), ['id\t名称\t分类\t适配角色\t店铺', 'booth:1\t春のワンピース\t服装\tMANUKA、Shinano（待确认 1）\tAlpha']);
  assert.match(listed.stdout, /# 共 1 件/);
  const json = JSON.parse(f.run('list', '--json', '--sort', 'name', '--asc').stdout) as { total: number; items: Array<{ id: string }> };
  assert.deepEqual([json.total, json.items.map(item => item.id)], [2, ['booth:2', 'booth:1']]);
  const review = f.run('review');
  assert.equal(review.status, 0, review.stderr);
  const lines = review.stdout.trim().split('\n');
  const hair = lines.find(line => line.startsWith('category:'))!.split('\t')[0]!;
  const rurune = lines.find(line => line.startsWith('avatar:'))!.split('\t')[0]!;
  assert.match(review.stdout, /分类建议 1 项，待确认角色 1 项/);
  assert.equal(f.run('review', 'answer', hair, '--choice', 'accept').status, 0);
  assert.equal(f.run('review', 'answer', rurune, '--choice', 'reject').status, 0);
  assert.match(f.run('review').stdout, /分类建议 0 项，待确认角色 0 项/);
  assert.match(f.run('show', 'booth:1').stdout, /Rurune\trejected\tdescription\/low/);
  assert.equal(f.run('avatar', 'booth:1', '--reject', 'MANUKA').status, 0);
  assert.match(f.run('list', '--avatar', 'MANUKA').stdout, /# 共 0 件/);
  assert.equal(f.run('assign', 'booth:2', '--category', '配饰').status, 0);
  assert.match(f.run('facets').stdout, /配饰\t1/);
  const bad = f.run('list', '--sort', 'price');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /sort 只能是/);
});

test('avh assets changes the vocabulary only through a proposal, and imports a personal dictionary into the state database', t => {
  const f = fixture(t);
  const operations = join(f.root, 'operations.json');
  writeFileSync(operations, JSON.stringify([{ op: 'add', path: '服装/上衣' }]));
  const proposed = f.run('taxonomy', 'propose', '--operations', operations, '--reason', '上衣单独一类');
  assert.equal(proposed.status, 0, proposed.stderr);
  const id = /提案 (\S+)（基于分类版本 1）/.exec(proposed.stdout)?.[1];
  assert.ok(id, proposed.stdout);
  assert.match(proposed.stdout, /新增 服装\/上衣/);
  assert.match(f.run('taxonomy').stdout, /^分类词表 版本 1/);
  assert.match(f.run('taxonomy', 'apply', id!).stdout, /版本 2/);
  assert.match(f.run('taxonomy').stdout, /^分类词表 版本 2\n[\s\S]*  上衣/);
  const mine = join(f.root, 'my-avatars.yaml');
  writeFileSync(mine, stringify({ avatars: [{ canonical: 'Karuru', aliases: ['カルル'], owned: true, booth_item_id: 555 }], not_avatars: ['おまけ2'] }));
  const imported = f.run('dictionary', 'import', mine);
  assert.equal(imported.status, 0, imported.stderr);
  const dictionary = JSON.parse(f.run('dictionary', '--json').stdout) as { avatars: Array<{ canonical: string; owned: boolean; bodyItemId: string | null; origin: string }> };
  assert.deepEqual(dictionary.avatars.find(item => item.canonical === 'Karuru'), { canonical: 'Karuru', aliases: ['カルル'], sharesBodyWith: [], owned: true,
    bodyItemId: '555', origin: 'import' });
  assert.match(f.run('refresh', '--all').stdout, /已更新 2 件素材/);
  const usage = f.run('frobnicate');
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /用法: avh assets list/);
});
