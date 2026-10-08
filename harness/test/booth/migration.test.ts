import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { boothCatalog, createSelectionPlan, materializeSelection, pinnedPlanFiles } from '../../src/booth/catalog.ts';
import { poolEntries } from '../../src/booth/pool.ts';
import { openDatabase } from '../../src/state/db.ts';
import { removeTemp } from '../fixtures/platform.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const MIGRATIONS = new URL('../../src/state/migrations/', import.meta.url);

/**
 * A state database as migration 0022 left it, with files fetched by the old code: one row per downloadable under
 * <home>/materialized/assets/<id>-<name>. Downloadable 201 later answered 404 and lost its name to `201.bin`;
 * downloadable 202 served the same bytes as 200.
 */
function legacy(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'avh-pool-migration-'));
  t.after(() => removeTemp(home));
  const assets = join(home, 'materialized', 'assets'); mkdirSync(assets, { recursive: true });
  const path = join(home, 'state.sqlite'), old = new DatabaseSync(path);
  old.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)');
  for (const name of readdirSync(MIGRATIONS).filter(file => /^\d{4}_.+\.sql$/.test(file) && Number(file.slice(0, 4)) <= 22).sort()) {
    old.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
    old.prepare('INSERT INTO schema_version (version) VALUES (?)').run(Number(name.slice(0, 4)));
  }
  old.exec(`INSERT INTO workspace(id,path) VALUES('w','/workspace');
    INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('p','w','client','/workspace/p','{}','active','t','t');
    INSERT INTO booth_item(item_id,name,item_url,category,owned,status) VALUES('100','衣装','https://booth.pm/ja/items/100','3D衣装',1,'available');
    INSERT INTO booth_file(downloadable_id,item_id,filename,byte_size,status) VALUES('200','100','dress.zip',3,'available'),
      ('201','100','201.bin',NULL,'unavailable'),('202','100','copy.zip',3,'available');
    INSERT INTO asset_selection_plan(id,project_id,status) VALUES('plan-a','p','ready'),('plan-b','p','ready');
    INSERT INTO asset_selection_file(plan_id,downloadable_id,purpose) VALUES('plan-a','200','装配'),('plan-a','201','发型'),('plan-b','202','备份');`);
  const files = [['200', 'dress.zip', 'abc', '2026-09-01T00:00:00.000Z'], ['201', 'hat.zip', 'hat', '2026-09-02T00:00:00.000Z'],
    ['202', 'copy.zip', 'abc', '2026-09-03T00:00:00.000Z']] as const;
  for (const [id, name, body, at] of files) {
    writeFileSync(join(assets, `${id}-${name}`), body);
    old.prepare(`INSERT INTO materialized_file(downloadable_id,path,byte_size,sha256,status,materialized_at,verified_at) VALUES(?,?,?,?,'ready',?,?)`)
      .run(id, join(assets, `${id}-${name}`), body.length, sha(body), at, at);
  }
  old.exec(`INSERT INTO materialized_ref(plan_id,downloadable_id,created_at) VALUES('plan-a','200','2026-09-01T00:00:01.000Z'),
    ('plan-a','201','2026-09-02T00:00:01.000Z'),('plan-b','202','2026-09-03T00:00:01.000Z')`);
  old.close();
  return { home, assets, path };
}

test('files fetched before the pool are recorded where they are, and every plan keeps the bytes it had', async t => {
  const { home, assets, path } = legacy(t);
  const db = openDatabase(path); t.after(() => db.close());
  // One blob per content, at the earlier fetch's path; nothing was moved.
  assert.deepEqual(db.prepare('SELECT sha256,path,byte_size AS size,source,retention,status FROM pool_blob ORDER BY stored_at').all().map(row => ({ ...row })), [
    { sha256: sha('abc'), path: join(assets, '200-dress.zip'), size: 3, source: 'booth', retention: 'cache', status: 'ready' },
    { sha256: sha('hat'), path: join(assets, '201-hat.zip'), size: 3, source: 'booth', retention: 'cache', status: 'ready' }]);
  // Each version keeps the name it was fetched under, including the one the index had lost to a 404.
  assert.deepEqual(db.prepare('SELECT downloadable_id AS id,sha256,filename,remote_version AS clue FROM booth_file_version ORDER BY id').all().map(row => ({ ...row })), [
    { id: '200', sha256: sha('abc'), filename: 'dress.zip', clue: '' }, { id: '201', sha256: sha('hat'), filename: 'hat.zip', clue: '' },
    { id: '202', sha256: sha('abc'), filename: 'copy.zip', clue: '' }]);
  assert.deepEqual({ ...db.prepare("SELECT filename,status FROM booth_file WHERE downloadable_id='201'").get() }, { filename: 'hat.zip', status: 'unavailable' });
  assert.deepEqual(db.prepare('SELECT plan_id AS plan,downloadable_id AS id,sha256,materialized_at IS NOT NULL AS fetched FROM asset_selection_pin ORDER BY plan,id').all().map(row => ({ ...row })), [
    { plan: 'plan-a', id: '200', sha256: sha('abc'), fetched: 1 }, { plan: 'plan-a', id: '201', sha256: sha('hat'), fetched: 1 },
    { plan: 'plan-b', id: '202', sha256: sha('abc'), fetched: 1 }]);
  // Readers written against 0015 still get answers from the views.
  assert.equal(db.prepare("SELECT count(*) AS n FROM materialized_file WHERE status='ready'").get()!.n, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM materialized_ref').get()!.n, 3);
  // The Workflow of this project reads the files where they always were.
  assert.deepEqual(pinnedPlanFiles(db, 'p').files.map(file => file.path).sort(), [join(assets, '200-dress.zip'), join(assets, '201-hat.zip')]);
  // A pinned plan is ready again without asking BOOTH, although BOOTH no longer offers one of its files.
  const offline = (async () => { throw new Error('BOOTH must not be asked'); }) as unknown as typeof fetch;
  const files = await materializeSelection(db, 'plan-a', join(home, 'materialized'), 's'.repeat(16), { fetcher: offline });
  assert.deepEqual(files.map(file => [file.downloadableId, file.path, file.fetched]), [['200', join(assets, '200-dress.zip'), false], ['201', join(assets, '201-hat.zip'), false]]);
  assert.deepEqual(poolEntries(db).map(entry => [entry.sha256, entry.removable]), [[sha('hat'), false], [sha('abc'), false]]);
  // A legacy version has no clue, so a new plan fetches once to learn it; the same bytes keep their old path.
  const fetcher = (async (input: URL | string) => String(input).includes('booth.pm')
    ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/200/dress.zip' } })
    : new Response('abc', { headers: { 'content-length': '3', etag: '"e"' } })) as typeof fetch;
  const plan = createSelectionPlan(db, { projectId: 'p', files: [{ downloadableId: '200', purpose: '新造型' }] });
  const [again] = await materializeSelection(db, plan, join(home, 'materialized'), 's'.repeat(16), { fetcher, intervalMs: 0 });
  assert.deepEqual([again!.path, again!.sha256, again!.fetched], [join(assets, '200-dress.zip'), sha('abc'), true]);
  assert.equal(db.prepare("SELECT remote_version AS clue FROM booth_file_version WHERE downloadable_id='200'").get()!.clue, '{"name":"dress.zip","size":3,"etag":"\\"e\\""}');
  assert.deepEqual(readdirSync(join(home, 'materialized', 'pool', '.partial')), []);
  assert.equal((boothCatalog(db)[0]!.files as Array<{ downloadableId: string; cache: string }>).find(file => file.downloadableId === '200')!.cache, 'current');
});
