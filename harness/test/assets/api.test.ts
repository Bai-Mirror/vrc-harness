import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { ApiClient } from '../../src/api/client.ts';
import type { EventMessage } from '../../src/api/protocol.ts';
import { RuntimeService } from '../../src/api/server.ts';
import { upsertBoothFile, upsertBoothItem } from '../../src/booth/catalog.ts';
import { openDatabase } from '../../src/state/db.ts';
import { removeTemp } from '../fixtures/platform.ts';
import { waitUntil } from '../fixtures/wait.ts';

const PROCESS = {
  schema: 'process/0.1', id: 'api-flow', version: 'v1', applies_to: {}, artifacts: ['plan'],
  stages: [{ id: 'plan', needs: [], produces: ['plan'], requires: [], gates: [], invalidated_by: [] }], checks: [], gates: [], milestones: [],
};
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-assets-api-'));
  const home = join(root, 'home'), workspace = join(root, 'workspace'), tools = join(root, 'tools'), knowledge = join(root, 'knowledge');
  for (const dir of [join(home, 'config'), workspace, join(tools, '审查/perception'), knowledge, join(root, 'export')]) mkdirSync(dir, { recursive: true });
  for (const file of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) writeFileSync(join(tools, file), '');
  writeFileSync(join(knowledge, 'api.process.yaml'), stringify(PROCESS));
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: '1', t: {} }));
  writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: workspace, toolRoot: tools, knowledgeRoot: knowledge,
    exportRoots: [join(root, 'export')], knownBodies: [], projectAliases: {}, sampleNames: [], processDefinitions: { 'api-flow': 'api.process.yaml' },
    defaultProfile: 'api-flow', thresholdsFile: 'thresholds.yaml', providers: [] }));
  const services: RuntimeService[] = [], clients: ApiClient[] = [];
  t.after(async () => {
    for (const client of clients) client.close();
    for (const service of services) await service.stop().catch(() => {});
    removeTemp(root);
  });
  const start = async (options: Partial<ConstructorParameters<typeof RuntimeService>[0]> = {}) => {
    const service = new RuntimeService({ home, scheduler: false, pollMs: 50, ...options }); services.push(service); await service.start(); return service;
  };
  const connect = async () => { const client = await ApiClient.connect(home); clients.push(client); return client; };
  const database = () => { const db = openDatabase(join(home, 'state/harness.db')); t.after(() => db.close()); return db; };
  return { home, start, connect, database };
}
const code = (expected: string) => (error: Error & { code?: string }) => error.code === expected;

test('assets.* serve the shared catalog: filters, facets, detail, choices and reviewable vocabulary changes', async t => {
  const f = fixture(t);
  await f.start();
  const client = await f.connect(), db = f.database();
  upsertBoothItem(db, { itemId: '1', name: '春のワンピース', shopName: 'Alpha', owned: true, status: 'available', tags: ['しなの対応'],
    metadata: { category: { name: '3D衣装', parent: { name: '3Dモデル' } }, variations: [{ name: 'MANUKA' }], description: '対応アバター：ルルネ' } });
  upsertBoothItem(db, { itemId: '2', name: 'ロングヘアー', shopName: 'Beta', owned: true, status: 'available',
    metadata: { category: { name: '3D装飾品' }, variations: [{ name: 'MANUKA' }] } });
  upsertBoothFile(db, { downloadableId: '11', itemId: '1', filename: 'Spring_MANUKA.zip', byteSize: 10, status: 'available' });
  const events: EventMessage[] = [];
  await client.subscribe(event => events.push(event));
  const list = await client.call<{ total: number; items: Array<{ id: string; category: { path: string } | null; avatars: Array<{ name: string; status: string }> }> }>(
    'assets.items', { avatar: 'ﾏﾇｶ', sort: 'listing', direction: 'asc' });
  assert.deepEqual(list.items.map(item => [item.id, item.category?.path ?? null]), [['booth:1', '服装'], ['booth:2', null]]);
  assert.deepEqual(list.items[0]!.avatars.map(tag => [tag.name, tag.status]), [['MANUKA', 'confirmed'], ['Shinano', 'confirmed'], ['Rurune', 'pending']]);
  const counted = await client.call<{ categories: { all: number }; avatars: { items: Array<{ name: string; count: number }>; pendingItems: number } }>('assets.facets');
  assert.deepEqual([counted.categories.all, counted.avatars.items.map(item => [item.name, item.count]), counted.avatars.pendingItems],
    [2, [['MANUKA', 2], ['Shinano', 1]], 1]);
  const detail = await client.call<{ fileGroups: Array<{ kind: string; files: Array<{ filename: string }> }> }>('assets.item', { id: 'booth:1' });
  assert.deepEqual(detail.fileGroups.find(group => group.kind === 'avatar')!.files.map(file => file.filename), ['Spring_MANUKA.zip']);
  const review = await client.call<{ counts: { category: number; avatar: number }; items: Array<{ id: string; type: string }> }>('assets.review.list');
  assert.deepEqual([review.counts.category, review.counts.avatar], [1, 1]);
  const before = events.length;
  await client.call('assets.review.answer', { answers: review.items.map(item => ({ id: item.id, choice: 'accept' })) });
  assert.equal((await client.call<{ total: number }>('assets.review.list')).total, 0);
  await waitUntil(() => events.length > before, { what: 'the decision event to reach the subscriber', timeoutMs: 30_000, intervalMs: 25 });
  assert.ok(events.length > before, 'subscribers hear about decisions');
  const decided = await client.call<{ avatarTags: Array<{ name: string; status: string }> }>('assets.avatar.decide', { id: 'booth:1', avatar: 'MANUKA', decision: 'reject' });
  assert.deepEqual(decided.avatarTags.map(tag => [tag.name, tag.status]), [['Rurune', 'confirmed'], ['Shinano', 'confirmed'], ['MANUKA', 'rejected']]);
  assert.deepEqual(await client.call('assets.category.assign', { id: 'booth:2', category: null }), { id: 'booth:2', category: null });
  const proposal = await client.call<{ id: string; impact: { items: number } }>('assets.taxonomy.propose',
    { operations: [{ op: 'rename', category: 'hair', name: '头发' }], reason: '按用户说法改名' });
  const stale = await client.call<{ id: string }>('assets.taxonomy.propose', { operations: [{ op: 'hide', category: 'toy' }], reason: '暂时不用' });
  assert.deepEqual((await client.call<{ version: number }>('assets.taxonomy.apply', { proposalId: proposal.id })).version, 2);
  await assert.rejects(client.call('assets.taxonomy.apply', { proposalId: stale.id }), code('STALE'));
  await client.call('assets.taxonomy.reject', { proposalId: stale.id });
  const taxonomy = await client.call<{ version: number; categories: Array<{ path: string }>; proposals: Array<{ status: string }> }>('assets.taxonomy.get');
  assert.deepEqual([taxonomy.version, taxonomy.categories.some(item => item.path === '头发'), taxonomy.proposals.map(item => item.status)], [2, true, ['rejected', 'applied']]);
  const dictionary = await client.call<{ version: string; avatars: unknown[] }>('assets.dictionary.get');
  assert.equal(dictionary.avatars.length, 91);
  assert.equal((await client.call<{ dictionaryVersion: string }>('assets.refresh', { all: true })).dictionaryVersion, dictionary.version);
  await assert.rejects(client.call('assets.item', { id: 'booth:999' }), code('NOT_FOUND'));
  await assert.rejects(client.call('assets.item', { id: '999' }), code('BAD_REQUEST'));
  await assert.rejects(client.call('assets.category.assign', { id: 'booth:1', category: '不存在' }), code('BAD_REQUEST'));
  await assert.rejects(client.call('assets.items', { sort: 'price' }), code('BAD_REQUEST'));
  await assert.rejects(client.call('assets.avatar.decide', { id: 'booth:1', avatar: 'Nobody', decision: 'add' }), code('BAD_REQUEST'));
  const catalog = await client.call<Array<{ itemId: string; category: string }>>('booth.catalog');
  assert.deepEqual(catalog.map(item => [item.itemId, item.category]).sort(), [['1', ''], ['2', '']], 'booth.catalog is unchanged');
});

test('a BOOTH sync classifies what it stored before anyone opens the catalog', async t => {
  const f = fixture(t);
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('library?page=1')) return new Response('<article><a href="/items/1">一</a><a href="/downloadables/11">下载</a></article>');
    if (url.includes('library')) return new Response('<main></main>');
    if (url.endsWith('/items/1.json')) return Response.json({ name: '春の服', category: { name: '3D衣装', parent: { name: '3Dモデル' } },
      variations: [{ name: 'MANUKA' }], tags: [{ name: 'しなの対応' }] });
    if (url.endsWith('/downloadables/11')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/Spring_MANUKA.zip' } });
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '5' } });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  await f.start({ boothRequests: { fetcher, intervalMs: 0 } });
  const client = await f.connect();
  await client.call('booth.session.set', { session: 'abcdefghijklmnop1234' });
  await client.call('booth.sync');
  let status: { job: unknown; last: { ok: boolean; message: string; result?: { catalog?: { items: number } } } | null };
  do { await delay(20); status = await client.call('booth.status'); } while (status.job);
  assert.equal(status.last?.ok, true, status.last?.message);
  assert.equal(status.last?.result?.catalog?.items, 1);
  const db = f.database();
  assert.deepEqual({ ...db.prepare(`SELECT category_id AS category, source FROM asset_classification WHERE subject = 'booth:1'`).get() },
    { category: 'outfit', source: 'auto' });
  assert.deepEqual(db.prepare(`SELECT avatar, source, status FROM asset_avatar_tag WHERE subject = 'booth:1' ORDER BY avatar`).all().map(row => ({ ...row })),
    [{ avatar: 'MANUKA', source: 'variation', status: 'confirmed' }, { avatar: 'Shinano', source: 'tag', status: 'confirmed' }]);
  assert.deepEqual({ ...db.prepare(`SELECT kind, avatars_json AS avatars FROM booth_file_kind WHERE downloadable_id = '11'`).get() },
    { kind: 'avatar', avatars: '["MANUKA"]' });
});
