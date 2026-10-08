import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { projectOverview } from '../../src/archive/overview.ts';
import { buildProjection } from '../../src/archive/projection.ts';
import { createSelectionPlan, materializeSelection, upsertBoothFile, upsertBoothItem } from '../../src/booth/catalog.ts';
import { archiveFixture } from '../fixtures/archive.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

test('the project archive and overview follow the version each plan pinned, not the newest one in the pool', async t => {
  const f = archiveFixture(t);
  const { projectId } = f.imported();
  f.db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    SELECT 'other', workspace_id, 'client', 'Other', '{}', 'active', 't', 't' FROM project WHERE id = ?`).run(projectId);
  upsertBoothItem(f.db, { itemId: '100', name: '衣装', owned: true, status: 'available', category: '3D衣装' });
  upsertBoothFile(f.db, { downloadableId: '200', itemId: '100', filename: 'dress.zip', status: 'available' });
  let body = 'abc';
  const fetcher = (async (input: URL | string) => String(input).includes('booth.pm')
    ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/200/dress.zip' } })
    : new Response(body, { headers: { 'content-length': String(body.length), etag: `"${body}"` } })) as typeof fetch;
  const fetchFor = (project: string) => materializeSelection(f.db, createSelectionPlan(f.db, { projectId: project,
    files: [{ downloadableId: '200', purpose: '衣装' }] }), join(f.root, 'home', 'materialized'), 's'.repeat(16), { fetcher, intervalMs: 0 });
  await fetchFor(projectId);
  body = 'abcd';
  await fetchFor('other');
  const sources = JSON.parse(buildProjection(f.db, projectId, 'archive').files.find(file => file.path === '_harness/records/sources.json')!.content) as
    { booth: Array<{ files: Array<{ downloadableId: string; sha256: string; materialized: string; byteSize: number; remoteVersion: string }> }> };
  assert.deepEqual(sources.booth.map(plan => plan.files.map(file => [file.downloadableId, file.sha256, file.materialized, file.byteSize, file.remoteVersion])),
    [[['200', sha('abc'), 'ready', 3, '{"name":"dress.zip","size":3,"etag":"\\"abc\\""}']]]);
  assert.deepEqual(projectOverview(f.db, projectId).missing.filter(item => item.kind === 'asset'), []);
  // The pinned bytes went missing while a newer version of the same file is still here: the project lacks its file.
  f.db.prepare(`UPDATE pool_blob SET status = 'missing' WHERE sha256 = ?`).run(sha('abc'));
  assert.deepEqual(projectOverview(f.db, projectId).missing.filter(item => item.kind === 'asset'),
    [{ kind: 'asset', id: '200', text: 'BOOTH 文件 dress.zip 还没有取回' }]);
  assert.equal(JSON.parse(buildProjection(f.db, projectId, 'archive').files.find(file => file.path === '_harness/records/sources.json')!.content)
    .booth[0].files[0].materialized, 'missing');
});
