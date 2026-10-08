import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createSelectionPlan, materializeSelection, releaseSelectionPlan, upsertBoothFile, upsertBoothItem } from '../../src/booth/catalog.ts';
import { poolEntries, poolFileName, removePoolBlobs, setPoolPin } from '../../src/booth/pool.ts';
import { openDatabase } from '../../src/state/db.ts';
import { removeTemp } from '../fixtures/platform.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** Three versions of one file: v1 and v2 pinned by plans of projects p and q, v3 fetched but pinned by no plan. */
async function pool(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-pool-')), db = openDatabase(join(root, 'state.sqlite'));
  t.after(() => { db.close(); removeTemp(root); });
  db.prepare("INSERT INTO workspace(id,path) VALUES('w','/workspace')").run();
  for (const id of ['p', 'q']) db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES(?,'w','client',?,'{}','active','t','t')`).run(id, `/workspace/${id}`);
  upsertBoothItem(db, { itemId: '100', name: '衣装', owned: true, status: 'available' });
  upsertBoothFile(db, { downloadableId: '200', itemId: '100', filename: 'dress.zip', status: 'available' });
  let body = 'v1';
  const fetcher = (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('booth.pm')) return new Response(null, { status: 302, headers: { location: 'https://cdn.example/200/dress.zip' } });
    if (init?.method === 'HEAD') return new Response(null, { status: 403 });
    if ((init?.headers as Record<string, string> | undefined)?.range) return new Response(null, { status: 206, headers: { 'content-range': `bytes 0-0/${body.length}` } });
    return new Response(body, { headers: { 'content-length': String(body.length) } });
  }) as typeof globalThis.fetch;
  const materialized = join(root, 'materialized');
  const fetch = (projectId: string, pin?: string) => {
    const plan = createSelectionPlan(db, { projectId, files: [{ downloadableId: '200', purpose: '装配', ...(pin ? { sha256: pin } : {}) }] });
    return materializeSelection(db, plan, materialized, 's'.repeat(16), { fetcher, intervalMs: 0 }).then(files => ({ plan, file: files[0]! }),
      error => ({ plan, error: error as Error }));
  };
  const first = await fetch('p') as { plan: string; file: { path: string } };
  body = 'v2-longer';
  const second = await fetch('q') as { plan: string; file: { path: string } };
  // q's plan pins v2; losing v2's bytes while BOOTH serves v3 stores v3 as a version no plan pins.
  const { rmSync } = await import('node:fs'); rmSync(second.file.path, { force: true }); body = 'v3-longest';
  const stray = await materializeSelection(db, second.plan, materialized, 's'.repeat(16), { fetcher, intervalMs: 0 }).catch(error => error as Error);
  assert.match((stray as Error).message, /计划锁定的版本/);
  const entry = (hash: string) => poolEntries(db).find(item => item.sha256 === hash)!;
  return { root, db, materialized, first, second, entry, fetch, serve: (text: string) => { body = text; } };
}

test('the pool lists every version with its references, and removes on request only bytes nothing needs', async t => {
  const { db, materialized, first, entry } = await pool(t);
  const v1 = entry(sha('v1')), v3 = entry(sha('v3-longest'));
  assert.deepEqual([v1.status, v1.source, v1.retention, v1.pinned, v1.removable], ['ready', 'booth', 'cache', false, false]);
  assert.deepEqual(v1.plans.map(plan => [plan.planId, plan.projectId, plan.status]), [[first.plan, 'p', 'ready']]);
  assert.deepEqual(v1.needed, { archive: true, delivery: false });
  assert.match(v1.blockers.join(), new RegExp(`计划 ${first.plan.slice(0, 8)}（已就绪）锁定了这个版本`));
  assert.deepEqual(v1.versions.map(version => [version.downloadableId, version.itemName, version.filename, version.remote?.size]), [['200', '衣装', 'dress.zip', 2]]);
  assert.deepEqual([v3.plans, v3.removable, v3.blockers], [[], true, []]);
  // A dry run says what would go and changes nothing.
  const dry = removePoolBlobs(db, materialized, [v1.sha256, v3.sha256], { dryRun: true });
  assert.deepEqual([dry.removed.map(item => item.sha256), dry.kept.map(item => item.sha256), dry.freedBytes], [[v3.sha256], [v1.sha256], 10]);
  assert.ok(existsSync(v3.path));
  const removed = removePoolBlobs(db, materialized, [v1.sha256, v3.sha256]);
  assert.deepEqual(removed.removed, [{ sha256: v3.sha256, byteSize: 10 }]);
  assert.deepEqual(removed.kept, [{ sha256: v1.sha256, blockers: v1.blockers }]);
  assert.equal(existsSync(v3.path), false);
  assert.equal(existsSync(dirname(v3.path)), false, 'the empty <sha256> directory goes too');
  assert.equal(readFileSync(v1.path, 'utf8'), 'v1');
  assert.deepEqual(readdirSync(join(materialized, 'pool', '.trash')), []);
  const after = entry(v3.sha256);
  assert.deepEqual([after.status, after.removable, after.versions.length], ['removed', false, 1], 'the version stays as history');
  assert.ok(after.removedAt);
});

test('releasing a plan, pinning and Workflow inputs decide what may be removed', async t => {
  const { db, materialized, first, entry, fetch, serve } = await pool(t);
  const v1 = sha('v1'), path = entry(v1).path;
  releaseSelectionPlan(db, first.plan);
  assert.deepEqual([entry(v1).removable, entry(v1).needed.archive], [true, false]);
  // Kept on request.
  assert.equal(setPoolPin(db, v1, true), true);
  assert.deepEqual([entry(v1).removable, entry(v1).blockers], [false, ['已固定保留']]);
  assert.deepEqual(removePoolBlobs(db, materialized, [v1]).kept, [{ sha256: v1, blockers: ['已固定保留'] }]);
  setPoolPin(db, v1, false);
  // Input of a Workflow that is not cancelled: needed for delivery.
  db.prepare(`INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('wf-1','p','x','h','k','active','{}')`).run();
  db.prepare(`INSERT INTO workflow_definition(workflow_id,profile,definition_json,capabilities_json,thresholds_json,manifest_json)
    VALUES('wf-1','x','{}','{}','{}',?)`).run(JSON.stringify({ schema: 'manifest/0.1', profile: 'x', request: 'r',
      assets: [{ store: 'library', item: entry(v1).path, role: 'outfit' }] }));
  assert.deepEqual([entry(v1).removable, entry(v1).needed.delivery, entry(v1).workflows.map(workflow => workflow.workflowId)], [false, true, ['wf-1']]);
  assert.match(entry(v1).blockers.join(), /Workflow wf-1（制作中）以它为输入/);
  db.prepare("UPDATE workflow SET status='cancelled' WHERE id='wf-1'").run();
  assert.equal(entry(v1).removable, true);
  assert.deepEqual(removePoolBlobs(db, materialized, [v1]).removed.map(item => item.sha256), [v1]);
  // A removed version cannot be pinned; when BOOTH serves those bytes to a plan again they come back where they were.
  assert.throws(() => createSelectionPlan(db, { projectId: 'p', files: [{ downloadableId: '200', purpose: '再用', sha256: v1 }] }), /素材池里没有/);
  serve('v1');
  const again = await fetch('p') as { file: { path: string; sha256: string } };
  assert.deepEqual([again.file.sha256, again.file.path, readFileSync(path, 'utf8'), entry(v1).status], [v1, path, 'v1', 'ready']);
});

test('a local original is kept, and a path outside the materialized directory is never deleted', async t => {
  const { root, db, materialized } = await pool(t);
  const outside = join(root, 'elsewhere', 'kept.zip'); mkdirSync(dirname(outside), { recursive: true }); writeFileSync(outside, 'mine');
  db.prepare("INSERT INTO pool_blob(sha256,byte_size,path,source,retention) VALUES(?,4,?,'local','keep')").run(sha('local'), join(materialized, 'pool', 'lo', 'x'));
  db.prepare("INSERT INTO pool_blob(sha256,byte_size,path,source,retention) VALUES(?,4,?,'booth','cache')").run(sha('mine'), outside);
  const result = removePoolBlobs(db, materialized, [sha('local'), sha('mine'), sha('unknown')]);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept, [{ sha256: sha('local'), blockers: ['本地原件，长期保留'] },
    { sha256: sha('mine'), blockers: ['文件不在 Harness 的素材目录里，不由 Harness 删除'] }, { sha256: sha('unknown'), blockers: ['素材池里没有这个版本'] }]);
  assert.equal(readFileSync(outside, 'utf8'), 'mine');
});

test('pool file names are valid on Windows and Linux and keep their extension', () => {
  assert.equal(poolFileName('衣装:完全版?.zip'), '衣装_完全版_.zip');
  assert.equal(poolFileName('CON.zip'), '_CON.zip');
  assert.equal(poolFileName('dir\\evil.unitypackage'), 'evil.unitypackage');
  assert.equal(poolFileName('trailing. '), 'trailing');
  const long = poolFileName(`${'長'.repeat(150)}.unitypackage`);
  assert.equal(Array.from(long).length, 100);
  assert.ok(long.endsWith('.unitypackage'));
});
