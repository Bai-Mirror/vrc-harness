import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { ApiClient } from '../../src/api/client.ts';
import { RuntimeService } from '../../src/api/server.ts';
import { createSelectionPlan, materializeSelection, upsertBoothFile, upsertBoothItem } from '../../src/booth/catalog.ts';
import { openDatabase } from '../../src/state/db.ts';
import { removeTemp } from '../fixtures/platform.ts';

const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-booth-cli-'));
  const home = join(root, 'home'), workspace = join(root, 'workspace'), tools = join(root, 'tools'), knowledge = join(root, 'knowledge');
  for (const dir of [join(home, 'config'), workspace, join(tools, '审查/perception'), join(knowledge, 'process'), join(root, 'export')]) mkdirSync(dir, { recursive: true });
  for (const file of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) writeFileSync(join(tools, file), '');
  writeFileSync(join(knowledge, 'process/synthetic-flow.yaml'), readFileSync(new URL('../fixtures/process.yaml', import.meta.url)));
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: '1', t: { max_count: { value: 10, unit: 'items', maturity: 'accepted', source: 'test' } } }));
  writeFileSync(join(home, 'config/harness.yaml'), stringify({ workspaceRoot: workspace, toolRoot: tools, knowledgeRoot: knowledge, exportRoots: [join(root, 'export')],
    knownBodies: [], projectAliases: {}, sampleNames: [], defaultProfile: 'synthetic-flow',
    processDefinitions: { 'synthetic-flow': 'process/synthetic-flow.yaml' }, thresholdsFile: 'thresholds.yaml', providers: [] }));
  const services: RuntimeService[] = [], clients: ApiClient[] = [];
  t.after(async () => { for (const client of clients) client.close(); for (const service of services) await service.stop().catch(() => {}); removeTemp(root); });
  const env = { ...process.env, AVH_HOME: home };
  return {
    root, home,
    /** The CLI as a person runs it; asynchronous, so a Runtime service in this process can answer it. */
    run: (...args: string[]) => new Promise<{ status: number; stdout: string; stderr: string }>(resolve =>
      execFile(process.execPath, [cli, ...args], { env, encoding: 'utf8' }, (error, stdout, stderr) =>
        resolve({ status: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }))),
    runSync: (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' }),
    start: async (fetcher: typeof fetch) => {
      const service = new RuntimeService({ home, scheduler: false, pollMs: 50, boothRequests: { fetcher, intervalMs: 0 } });
      services.push(service); await service.start();
      const client = await ApiClient.connect(home); clients.push(client);
      await client.call('booth.session.set', { session: 'abcdefghijklmnop1234' });
    },
  };
}

test('avh booth sync runs through the Runtime service, deep on request, and says why sizes stayed unknown', async t => {
  const f = fixture(t);
  await f.start((async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('library?page=1')) return new Response('<article><a href="/items/1">一</a><a href="/downloadables/11">下载</a><a href="/downloadables/12">下载</a></article>');
    if (url.includes('library')) return new Response('<main></main>');
    if (url.endsWith('/items/1.json')) return Response.json({ name: '一' });
    if (url.includes('/downloadables/')) return new Response(null, { status: 302, headers: { location: `https://cdn.example/${url.split('/').pop()}/f.zip` } });
    if (url.includes('/11/')) return new Response(null, { status: 403 });
    return init?.method === 'HEAD' ? new Response(null, { headers: { 'content-length': '7' } }) : new Response(null, { status: 500 });
  }) as typeof fetch);
  const deep = await f.run('booth', 'sync', '--deep');
  assert.equal(deep.status, 0, deep.stderr);
  assert.match(deep.stdout, /^深度同步完成：1 个商品、2 个文件；/);
  assert.match(deep.stdout, /1 个大小未知（head:http-403 range:http-403 ×1）/);
  assert.match(deep.stdout, /^探测\thead:http-403 range:http-403\t1$/m);
  assert.match(deep.stdout, /^探测\thead:ok\t1$/m);
  const quick = await f.run('booth', 'sync', '--json');
  assert.equal(quick.status, 0, quick.stderr);
  const report = JSON.parse(quick.stdout) as { ok: boolean; result: { mode: string; itemsRead: number; filesProbed: number } };
  // Quick: the item is unchanged and only the file whose size is unknown is probed again.
  assert.deepEqual([report.ok, report.result.mode, report.result.itemsRead, report.result.filesProbed], [true, 'quick', 0, 1]);
});

test('avh booth sync without a running Runtime service says how to start one', t => {
  const f = fixture(t);
  const result = f.runSync('booth', 'sync');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /avh service start/);
});

test('avh booth pool lists versions and removes bytes only when asked, and only of versions nothing needs', async t => {
  const f = fixture(t);
  mkdirSync(join(f.home, 'state'), { recursive: true });
  const db = openDatabase(join(f.home, 'state/harness.db'));
  db.prepare("INSERT INTO workspace(id,path) VALUES('w','/workspace')").run();
  db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES('p','w','client','/workspace/p','{}','active','t','t')`).run();
  upsertBoothItem(db, { itemId: '100', name: '衣装', owned: true, status: 'available' });
  upsertBoothFile(db, { downloadableId: '200', itemId: '100', filename: 'dress.zip', status: 'available' });
  const plan = createSelectionPlan(db, { projectId: 'p', files: [{ downloadableId: '200', purpose: '装配' }] });
  const [file] = await materializeSelection(db, plan, join(f.home, 'materialized'), 's'.repeat(16), { intervalMs: 0,
    fetcher: (async (input: URL | string) => String(input).includes('booth.pm')
      ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/200/dress.zip' } }) : new Response('abc')) as typeof fetch });
  db.close();
  const version = sha('abc').slice(0, 12);
  const listed = f.runSync('booth', 'pool');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, new RegExp(`^${version}\\t3 B\\t就绪\\tBOOTH·缓存\\t计划 1 · Workflow 0\\t否：计划 ${plan.slice(0, 8)}（已就绪）锁定了这个版本\\t200 dress\\.zip$`, 'm'));
  const refused = f.runSync('booth', 'pool', 'remove', version);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, new RegExp(`^保留\\t${version}\\t计划 ${plan.slice(0, 8)}`, 'm'));
  assert.equal(f.runSync('booth', 'plan', 'release', plan.slice(0, 8)).status, 0);
  const dry = f.runSync('booth', 'pool', 'remove', version, '--dry-run');
  assert.match(dry.stdout, new RegExp(`^可以删除\\t${version}\\t3 B$`, 'm'));
  assert.ok(existsSync(file!.path));
  const removed = f.runSync('booth', 'pool', 'remove', version);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, new RegExp(`^已删除\\t${version}\\t3 B$`, 'm'));
  assert.equal(existsSync(file!.path), false);
  const json = JSON.parse(f.runSync('booth', 'pool', '--json').stdout) as { entries: Array<{ status: string; versions: unknown[] }> };
  assert.deepEqual(json.entries.map(entry => [entry.status, entry.versions.length]), [['removed', 1]]);
  assert.match(f.runSync('booth', 'pool', 'remove', 'abc').stderr, /至少前 12 位/);
});
