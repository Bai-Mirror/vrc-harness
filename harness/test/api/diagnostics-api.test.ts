import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ApiClient } from '../../src/api/client.ts';
import { RuntimeService } from '../../src/api/server.ts';
import { readZip } from '../../src/diagnostics/zip.ts';
import { FIXTURE_PRIVATE, diagnosticsFixture } from '../fixtures/diagnostics.ts';
import { waitFor } from '../fixtures/wait.ts';

/**
 * The diagnostics bundle through the Runtime API, which is what the GUI and any other client uses: the preview is a
 * synchronous read that records `avh doctor`'s reading and creates no bundle, and the export runs as an
 * `avh project diagnose` background job followed through `project.archive.job` -- exactly the share/restore shape, so
 * one GUI follower can wait for either. The export carries the manifest the preview returned (R28 P1-3), which is how
 * the GUI binds the button to the list the person actually saw.
 */
type Job = { job: { id: string; kind: string; progress?: { phase: string } } | null;
  last: { id: string; ok: boolean; result?: any; error?: string } | null };
type Plan = { schema: string; issues: Array<{ runId: string | null; category: string }>; items: unknown[];
  manifest: Array<{ path: string; sha256: string }>; manifestDigest: string; generatedAt: string };

test('the Runtime previews with no side effect and exports the bundle as a background job', async t => {
  const f = diagnosticsFixture(t);
  // The service opens its own connection to the state database.
  f.db.close();
  const service = new RuntimeService({ home: f.home, scheduler: false, pollMs: 50 });
  await service.start();
  t.after(async () => { await service.stop().catch(() => {}); });
  const client = await ApiClient.connect(f.home);
  t.after(() => client.close());

  const preview = await client.call<{ plan: Plan }>('project.diagnostics.preview', { projectId: f.projectId });
  assert.equal(preview.plan.schema, 'harness-diagnostics/0.1');
  assert.ok(preview.plan.issues.some(issue => issue.runId === f.runs.setupFailed && issue.category === 'environment'));
  assert.ok(!existsSync(join(f.home, 'state', 'diagnostics')), '预览不建留任何包目录');
  // R28 P1-3: the preview records the doctor reading and lists it, so the export's manifest can match this one.
  assert.ok(preview.plan.manifest.some(member => member.path === 'attachments/environment/doctor.txt'),
    preview.plan.manifest.map(member => member.path).join('\n'));
  assert.ok(/^[a-f0-9]{64}$/.test(preview.plan.manifestDigest));
  await assert.rejects(client.call('project.diagnostics.preview', { projectId: 'nope' }), /项目不存在/);
  await assert.rejects(client.call('project.diagnostics.preview', { projectId: f.projectId, since: 'not-a-time' }), /可解析的时间/);

  // A caller that confirmed the preview hands the manifest back; the CLI recompiles and packs exactly those members.
  const out = join(f.home, 'state', 'diagnostics');
  const started = await client.call<{ id: string }>('project.diagnostics.export',
    { projectId: f.projectId, out, expectDigest: preview.plan.manifestDigest, generatedAt: preview.plan.generatedAt });
  assert.ok(started.id);
  const last = await waitFor(async () => {
    const state = await client.call<Job>('project.archive.job');
    if (state.job?.id === started.id) return undefined;
    assert.equal(state.last?.id, started.id);
    return state.last ?? undefined;
  }, { what: `diagnostics job ${started.id} to finish`, timeoutMs: 240_000, intervalMs: 100 });
  assert.equal(last!.ok, true, last!.error);
  assert.equal(last!.result.status, 'exported');
  const path = last!.result.package.path as string;
  assert.ok(existsSync(path), path);
  const files = new Map(readZip(readFileSync(path)).map(member => [member.path, member.bytes]));
  assert.ok(files.has('report.md') && files.has('diagnostics.json'));
  assert.deepEqual([...files.keys()].sort(), preview.plan.manifest.map(member => member.path).sort(), '导出的成员清单要与预览一致');
  const report = files.get('report.md')!.toString('utf8');
  assert.match(report, /厂商材质齐备（vendor_material_complete）/);
  assert.match(report, /初步归类（建议，不是结论）\*\*：环境/);
  assert.match(report, /最远阶段：setup/);
  assert.ok(!report.includes(FIXTURE_PRIVATE.apiKey));

  // A confirmation that is no longer current is refused with "re-preview" and writes no second package (R28 P1-3).
  const stale = await client.call<{ id: string }>('project.diagnostics.export',
    { projectId: f.projectId, out, expectDigest: 'f'.repeat(64), generatedAt: preview.plan.generatedAt });
  const refused = await waitFor(async () => {
    const state = await client.call<Job>('project.archive.job');
    if (state.job?.id === stale.id) return undefined;
    assert.equal(state.last?.id, stale.id);
    return state.last ?? undefined;
  }, { what: `stale diagnostics job ${stale.id} to finish`, timeoutMs: 240_000, intervalMs: 100 });
  assert.equal(refused!.result.status, 'refused');
  assert.match(refused!.result.refusal.reason, /内容已变化，请重新预览/);
  assert.equal(readdirSync(out).length, 1, '拒绝时不能再写出第二个包');
});
