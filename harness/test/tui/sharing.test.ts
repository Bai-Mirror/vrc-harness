import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import test from 'node:test';
import { render } from 'ink';
import { stringify } from 'yaml';
import { RuntimeService } from '../../src/api/server.ts';
import { ApiClient } from '../../src/api/client.ts';
import { loadConfig } from '../../src/config.ts';
import { installBundledPack, findProfiles } from '../../src/managed-pack.ts';
import { registerPackCandidate, recordPackEvaluation, packCandidates } from '../../src/managed-pack-candidate.ts';
import { openDatabase } from '../../src/state/db.ts';
import { queueSharingRecord, recordConsent } from '../../src/sharing/state.ts';
import { writeSecret } from '../../src/providers/secrets.ts';
import { SHARING_NOTICE_VERSION, SHARING_PATHS, validateRecordBatch } from '../../src/shared/sharing.ts';
import { App } from '../../src/tui/app.ts';
import { h } from '../../src/tui/core.ts';
import { configDocument } from '../../src/tui/setup.ts';
import { removeTemp } from '../fixtures/platform.ts';
import { terminal } from '../fixtures/terminal.ts';
import { waitUntil } from '../fixtures/wait.ts';

const END = '\u001b[F', ESC = '\u001b';
async function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-tui-sharing-')), home = join(root, 'home'), workspace = join(root, 'workspace'), exportRoot = join(root, 'export');
  const pack = installBundledPack(home), found = findProfiles(pack.knowledgeRoot);
  for (const directory of [join(home, 'config'), workspace, exportRoot]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(home, 'config/harness.yaml'), stringify(configDocument({ workspaceRoot: workspace, exportRoot,
    knowledgeRoot: pack.knowledgeRoot, toolRoot: pack.toolRoot, profiles: found.profiles, thresholds: found.thresholds!, defaultProfile: found.profiles[0]!.id, codex: false, claude: false })));
  const config = loadConfig(home); mkdirSync(dirname(config.stateDbPath), { recursive: true }); const db = openDatabase(config.stateDbPath);
  const service = new RuntimeService({ home, scheduler: false, pollMs: 1000 }); await service.start(); const client = await ApiClient.connect(home);
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const ui = terminal();
  const api = { call: <T,>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> => { calls.push({ method, params }); return ui.track(client.call<T>(method, params, timeoutMs)); },
    subscribe: client.subscribe.bind(client), onClose: client.onClose.bind(client), close: () => {} };
  const instance = render(h(App, { api, onExit: () => {} }), { stdout: ui.stdout as never, stdin: ui.stdin as never, stderr: ui.stderr as never, debug: true, exitOnCtrlC: false, patchConsole: false });
  t.after(async () => { instance.unmount(); client.close(); await service.stop(); db.close(); removeTemp(root); });
  await ui.settle(); await ui.press('6');
  return { root, home, pack, db, client, calls, ...ui };
}

test('real TUI settings requires an explicit current-notice choice and keeps exit/rejoin queues empty', async t => {
  const f = await fixture(t); assert.match(f.stdout.last(), /s 数据与协作.*未加入/);
  await f.press('s', 'a'); assert.equal(f.calls.filter(call => call.method === 'sharing.choose').length, 0, 'cannot join before reading the policy on a short terminal');
  await f.press(END); assert.match(f.stdout.last(), /明确加入/); await f.press(ESC);
  assert.equal((await f.client.call<{ active: boolean }>('sharing.state')).active, false, 'Esc never enables sharing');
  await f.press('s', END, 'a'); assert.equal((await f.client.call<{ active: boolean }>('sharing.state')).active, true);
  const consent = f.db.prepare("SELECT surface,notice_version FROM sharing_consent WHERE action='enabled' ORDER BY seq DESC LIMIT 1").get()!;
  assert.equal(consent.surface, 'tui'); assert.equal(consent.notice_version, SHARING_NOTICE_VERSION);
  await f.press('s', 'c'); assert.match(f.stdout.last(), /尚无可回传/);
  assert.equal(f.calls.filter(call => call.method === 'managed.contribution.authorize').length, 0);
  queueSharingRecord(f.db, { category: 'tool-reliability', action: 'tool-run', outcome: 'success' });
  await f.press('s', 'o'); assert.equal((await f.client.call<{ counts: { queued: number } }>('sharing.state')).counts.queued, 0);
  assert.equal(queueSharingRecord(f.db, { category: 'tool-reliability', action: 'tool-run', outcome: 'failure' }).queued, false);
  await f.press('s', END, 'a'); assert.equal((await f.client.call<{ counts: { queued: number } }>('sharing.state')).counts.queued, 0);
  assert.equal(f.calls.filter(call => call.method === 'sharing.flush').length, 0, 'joining never sends by itself or backfills disabled work');
  assert.deepEqual(await f.client.call('project.list'), [], 'local work API remains available after contribution choices');
  await f.press('s', 'x', 'y'); assert.match(f.stdout.last(), /没有服务器安装需要撤回/);
  assert.doesNotMatch(f.stdout.last(), /服务器已确认撤回/);
  await f.client.call('sharing.choose', { surface: 'untrusted-surface', enabled: false });
  assert.equal(f.db.prepare("SELECT surface FROM sharing_consent WHERE action='disabled' ORDER BY seq DESC LIMIT 1").get()!.surface, 'gui', 'existing API fallback cannot invent new consent surfaces');
});

test('TUI withdrawal confirms ownership action and exposes actual offline pending instead of claiming deletion', async t => {
  const f = await fixture(t); await f.press('s', END, 'a');
  recordConsent(f.db, 'registered', 'runtime', { installId: 'a'.repeat(32), server: 'http://127.0.0.1:1' }); writeSecret(f.home, 'sharing.installation-token', 'hst_' + 'b'.repeat(43));
  await f.press('s', 'x', 'n'); assert.equal(f.calls.filter(call => call.method === 'sharing.revoke').length, 0);
  await f.press('s', 'x', 'y');
  const state = await f.client.call<{ active: boolean; revokePending: unknown }>('sharing.state'); assert.equal(state.active, false); assert.ok(state.revokePending);
  await f.waitForFrame(/远端撤回待送达/); assert.doesNotMatch(f.stdout.last(), /服务器已确认撤回/);
  const choices = f.calls.filter(call => call.method === 'sharing.choose').length; await f.press('s', END, 'a');
  assert.equal(f.calls.filter(call => call.method === 'sharing.choose').length, choices, 'pending revoke blocks new join'); await f.press(ESC);
});

test('real TUI report authorization names a completed candidate and opt-out removes its projected payload', async t => {
  const f = await fixture(t), source = join(f.root, 'candidate-source'); cpSync(f.pack.root, source, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, 'pack.json'), 'utf8')) as Record<string, unknown>; Object.assign(manifest, { id: 'tui-data-report', version: '0.1.0-candidate.1', channel: 'candidate' }); writeFileSync(join(source, 'pack.json'), JSON.stringify(manifest));
  const candidate = registerPackCandidate(f.db, f.home, source, { basePackId: f.pack.info.id, sourceKind: 'human', reason: 'synthetic fixture', impact: {}, permissions: { network: false, writes: ['project', 'run'] } });
  const result = { caseId: 'synthetic', modelFamily: 'deterministic', attempt: 1, result: 'pass' as const, evidenceRef: 'synthetic-only.json' };
  recordPackEvaluation(f.db, candidate.id, { suiteId: 'synthetic-only', suiteVersion: '1', isolation: 'process', baselineResults: [result], results: [result] });
  await f.press('s'); await f.waitForFrame(/数据与协作 · 自愿加入/); await f.press(END, 'a');
  await f.press('s'); await f.waitForFrame(/\[c\] 候选技术报告/);
  await f.press('c'); const chooser = await f.waitForFrame(/查看候选技术报告/);
  assert.match(chooser, /0.1.0-candidate\.1.*synthetic fixture/); await f.press(ESC);
  assert.equal(f.calls.filter(call => call.method === 'managed.contribution.authorize').length, 0);
  await f.press('s'); await f.waitForFrame(/\[c\] 候选技术报告/);
  await f.press('c'); await f.waitForFrame(/查看候选技术报告/);
  await f.press('1'); const review = await f.waitForFrame(/查看技术报告/);
  assert.match(review, /基准结果/);
  await f.press('y');
  assert.equal(f.calls.filter(call => call.method === 'managed.contribution.authorize').length, 0, 'selection and early y do not authorize');
  await f.press(ESC); assert.equal(f.calls.filter(call => call.method === 'managed.contribution.authorize').length, 0, 'Esc from preview does not authorize');
  const preview = await f.client.call<{ report: unknown; evaluationId: string; reportHash: string; contentHash: string }>('managed.contribution.preview', { candidateId: candidate.id });
  await f.press('s'); await f.waitForFrame(/\[c\] 候选技术报告/);
  await f.press('c'); await f.waitForFrame(/查看候选技术报告/);
  await f.press('1'); await f.waitForFrame(/查看技术报告/);
  for (let index = 0; index < 13; index++) await f.press('\u001b[B');
  await f.press('y', 'n'); const authorization = f.calls.find(call => call.method === 'managed.contribution.authorize'); assert.equal(authorization?.params.candidateId, candidate.id);
  assert.equal(authorization?.params.expectedReportHash, preview.reportHash); assert.equal(authorization?.params.expectedEvaluationId, preview.evaluationId);
  const displayed = f.stdout.seen().replace(/[\s│]/g, '');
  assert.match(displayed, /比率分母为1个案例×模型组合/); assert.match(displayed, /不发送知识包、工具、原文或私人材料/);
  const rows = await f.client.call<Array<{ bundlePath: string; status: string }>>('managed.contribution.list'); assert.equal(rows[0]!.status, 'authorized'); assert.ok(existsSync(rows[0]!.bundlePath));
  assert.deepEqual(JSON.parse(readFileSync(join(rows[0]!.bundlePath, 'pack/candidate-report.json'), 'utf8')), preview.report, 'actual authorized bytes are exactly the report displayed');
  assert.equal(f.calls.filter(call => call.method === 'managed.contribution.submit').length, 0, 'report submission is a separate deliberate choice');
  await f.press('s', 'o');
  await waitUntil(() => !existsSync(rows[0]!.bundlePath), { what: 'opt-out to remove the projected payload', timeoutMs: 10_000, intervalMs: 25 });
  assert.equal((await f.client.call<Array<{ status: string }>>('managed.contribution.list'))[0]!.status, 'cancelled');
});

test('viewed report cannot authorize a newer evaluation or changed candidate bytes', async t => {
  const f = await fixture(t), source = join(f.root, 'candidate-source'); cpSync(f.pack.root, source, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, 'pack.json'), 'utf8')) as Record<string, unknown>; Object.assign(manifest, { id: 'tui-stale-report', version: '0.1.0-candidate.1', channel: 'candidate' }); writeFileSync(join(source, 'pack.json'), JSON.stringify(manifest));
  const candidate = registerPackCandidate(f.db, f.home, source, { basePackId: f.pack.info.id, sourceKind: 'human', reason: 'synthetic stale report', impact: {}, permissions: { network: false, writes: ['project', 'run'] } });
  const result = { caseId: 'synthetic-one', modelFamily: 'deterministic', attempt: 1, result: 'pass' as const, evidenceRef: 'synthetic-only.json' };
  const evaluate = (caseId: string) => recordPackEvaluation(f.db, candidate.id, { suiteId: 'synthetic-only', suiteVersion: '1', isolation: 'process', baselineResults: [{ ...result, caseId }], results: [{ ...result, caseId }] });
  evaluate('first');
  await f.press('s'); await f.waitForFrame(/数据与协作 · 自愿加入/); await f.press(END, 'a');
  await f.press('s'); await f.waitForFrame(/\[c\] 候选技术报告/);
  await f.press('c'); await f.waitForFrame(/查看候选技术报告/);
  await f.press('1'); await f.waitForFrame(/查看技术报告/);
  evaluate('different-after-preview'); await f.press(END, 'y');
  await f.waitForFrame(/报告或候选版本已变化/); assert.deepEqual(await f.client.call('managed.contribution.list'), []);
  await f.press('s'); await f.waitForFrame(/\[c\] 候选技术报告/);
  await f.press('c'); await f.waitForFrame(/查看候选技术报告/);
  await f.press('1'); await f.waitForFrame(/查看技术报告/);
  const root = packCandidates(f.db)[0]!.root; writeFileSync(join(root, 'pack.json'), readFileSync(join(root, 'pack.json'), 'utf8') + '\n');
  await f.press(END, 'y'); await f.waitForFrame(/报告或候选版本已变化/); assert.deepEqual(await f.client.call('managed.contribution.list'), []);
});

test('TUI sends a bounded record batch, reads owned remote status, and confirms actual receiver withdrawal', async t => {
  const f = await fixture(t), token = 'hst_' + 'z'.repeat(43), installId = 'c'.repeat(32);
  let stored = 0, revoked = false, requests = 0;
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests++; let result: unknown;
    if (request.url === SHARING_PATHS.installations) result = { schema: 'harness-installation/0.1', installId, token };
    else {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      if (request.url === SHARING_PATHS.records) {
        const batch = validateRecordBatch(JSON.parse(Buffer.concat(chunks).toString())); assert.equal(batch.records.length, 200); stored += batch.records.length;
        result = { schema: 'harness-records-receipt/0.1', batchId: batch.batchId, accepted: batch.records.length, status: 'stored' };
      } else if (request.url === SHARING_PATHS.status) result = { records: [{}], contributions: [] };
      else { assert.equal(request.url, SHARING_PATHS.revoke); revoked = true; const removed = stored; stored = 0;
        result = { schema: 'harness-revocation/0.1', installId, revoked: true, remote: 'revoked', removed: { recordBatches: 1, records: removed, contributions: [] }, retained: [] }; }
    }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise<void>(resolve => receiver.close(() => resolve())));
  const configPath = join(f.home, 'config/harness.yaml'), address = receiver.address(); assert.ok(address && typeof address !== 'string');
  writeFileSync(configPath, readFileSync(configPath, 'utf8') + `\ncontributionUpstream:\n  endpoint: http://127.0.0.1:${address.port}/v1/contributions\n`); await f.client.call('config.reload');
  await f.press('s', END, 'a'); for (let i = 0; i < 205; i++) queueSharingRecord(f.db, { category: 'tool-reliability', action: 'tool-run', outcome: 'success' });
  await f.press('s', 'f'); assert.equal(stored, 200); assert.equal((await f.client.call<{ counts: { queued: number } }>('sharing.state')).counts.queued, 5);
  await f.press('s', 'r'); await f.waitForFrame(/服务器保存 1 批技术记录/); await f.press('\r');
  await f.press('s', 'x', 'y'); assert.equal(revoked, true); assert.equal(stored, 0); await f.waitForFrame(/服务器已确认撤回/);
  assert.equal((await f.client.call<{ counts: { queued: number } }>('sharing.state')).counts.queued, 0); assert.equal(requests, 4);
});
