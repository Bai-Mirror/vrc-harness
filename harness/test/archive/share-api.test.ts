import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiClient } from '../../src/api/client.ts';
import { RuntimeService } from '../../src/api/server.ts';
import { has7z, receiverSide, senderProject } from '../fixtures/share.ts';
import { waitFor } from '../fixtures/wait.ts';

const skip = !has7z && '7-Zip is not installed here';
const cli = fileURLToPath(new URL('../../bin/avh.js', import.meta.url));

type Job = { job: { id: string; kind: string; progress?: { phase: string } } | null; last: { id: string; ok: boolean; result?: any; error?: string } | null };
async function follow(client: ApiClient, method: string, params: Record<string, unknown>): Promise<Job['last'] & { phases: string[] }> {
  const started = await client.call<{ id: string }>(method, params);
  const phases: string[] = [];
  const last = await waitFor(async () => {
    const state = await client.call<Job>('project.archive.job');
    if (state.job?.id === started.id) {
      if (state.job.progress && !phases.includes(state.job.progress.phase)) phases.push(state.job.progress.phase);
      return undefined;
    }
    assert.equal(state.last?.id, started.id);
    return state.last ?? undefined;
  }, { what: `archive job ${started.id} to finish`, timeoutMs: 240_000, intervalMs: 100,
    detail: () => `phases ${phases.join(',') || 'none'}` });
  return { ...(last as NonNullable<Job['last']>), phases };
}

test('the Runtime API previews, exports, checks and restores as background jobs, and reports the reconciliation', { skip }, async t => {
  const f = await senderProject(t);
  const receiver = receiverSide(t, f.root);
  // The services open their own connections to the state databases.
  f.sender.db.close(); receiver.db.close();
  const services: RuntimeService[] = [], clients: ApiClient[] = [];
  t.after(async () => { for (const client of clients) client.close(); for (const service of services) await service.stop().catch(() => {}); });
  const serve = async (home: string) => {
    const service = new RuntimeService({ home, scheduler: false, pollMs: 50 }); services.push(service); await service.start();
    const client = await ApiClient.connect(home); clients.push(client); return client;
  };
  const sender = await serve(f.sender.home);
  const preview = await follow(sender, 'project.share.preview', { projectId: f.projectId, purpose: 'others', layers: ['A'] });
  assert.equal(preview.ok, true, preview.error);
  assert.equal(preview.result.status, 'ready');
  assert.equal(preview.result.plan.level, 'continuable');
  assert.ok(preview.result.plan.items.some((item: { id: string }) => item.id === 'C:_harness/sensitive/conversation.json'));
  await assert.rejects(sender.call('project.share.export', { projectId: f.projectId, purpose: 'others', out: 'relative.7z' }), /绝对路径/);
  await assert.rejects(sender.call('project.share.preview', { projectId: f.projectId, purpose: 'others', layers: ['D'] }), /只能含 A、B、C/);
  const out = join(f.sender.exportRoot, 'Luna 分享.7z');
  const exported = await follow(sender, 'project.share.export', { projectId: f.projectId, purpose: 'others', out, recipient: '测试收件人' });
  assert.equal(exported.ok, true, exported.error);
  assert.equal(exported.result.status, 'exported');
  assert.equal(exported.result.package.path, out);
  const listed = await sender.call<Array<{ output: string; selection: { recipient?: string } }>>('project.share.list', { projectId: f.projectId });
  assert.deepEqual(listed.map(item => [item.output, item.selection.recipient]), [[out, '测试收件人']]);

  const client = await serve(receiver.home);
  const check = await follow(client, 'project.restore.check', { path: out });
  assert.equal(check.ok, true, check.error);
  assert.equal(check.result.decision.kind, 'new');
  const restored = await follow(client, 'project.restore', { path: out, expect: 'new' });
  assert.equal(restored.ok, true, restored.error);
  assert.equal(restored.result.status, 'restored');
  const projectId = restored.result.projectId as string;
  const report = await client.call<{ level: string; decision: { kind: string }; restored: { facts: number } }>('project.restore.report', { projectId });
  assert.equal(report.decision.kind, 'new');
  assert.ok(report.restored.facts > 0);
  assert.deepEqual(await client.call('project.restore.complete', { projectId }), { results: [], reconciliation: await client.call('project.restore.report', { projectId }) });
  const projects = await client.call<Array<{ id: string; workflow?: { id: string } }>>('project.list');
  assert.deepEqual(projects.map(project => [project.id, project.workflow?.id]), [[projectId, f.workflowId]]);

  // The same commands for a person at a terminal: words, and an exit code that says whether it worked.
  const run = (home: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, AVH_HOME: home } });
  const text = run(f.sender.home, 'project', 'share', f.projectId, '--purpose', 'others', '--dry-run');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /可以导出 · 可直接续做/);
  assert.match(text.stdout, /\[ \] C:_harness\/sensitive\/conversation\.json：完整对话/);
  const again = run(receiver.home, 'project', 'restore', out, '--check');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /本机的「.+」已经包含这个分享包的内容/);
  const missing = run(receiver.home, 'project', 'restore', join(f.root, 'no-such.7z'), '--check');
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /找不到分享包/);
});
