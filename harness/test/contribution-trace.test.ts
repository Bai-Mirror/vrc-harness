import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { RuntimeService } from '../src/api/server.ts';
import { authorizeContribution, submitContribution } from '../src/contribution-queue.ts';
import { refreshContributionAcceptance, recordContributionAcceptance, TRACE_SCHEMA, traceContribution } from '../src/contribution-trace.ts';
import { packTreeHash, recordPackEvaluation, registerPackCandidate } from '../src/managed-pack-candidate.ts';
import { installSignedPackRelease, releasePayload, type SignedPackRelease } from '../src/managed-pack-update.ts';
import { writeSecret } from '../src/providers/secrets.ts';
import { chooseSharing, recordConsent } from '../src/sharing/state.ts';
import { openDatabase, SCHEMA_VERSION } from '../src/state/db.ts';
import { removeTemp } from './fixtures/platform.ts';

const RECEIPT_ID = 'a'.repeat(32);
const INSTALL_ID = 'b'.repeat(32);
const SERVER = 'https://updates.example';
const cli = fileURLToPath(new URL('../bin/avh.js', import.meta.url));
const run = promisify(execFile);

/** A contributed case: candidate, isolated evaluation, explicit authorization, and a matching server receipt. */
async function contributed(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-trace-')), home = join(root, 'home'), source = join(root, 'source');
  t.after(() => removeTemp(root));
  cpSync(new URL('../builtin/', import.meta.url), source, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, 'pack.json'), 'utf8')) as Record<string, unknown>;
  Object.assign(manifest, { id: 'trace-candidate', version: '1-candidate', channel: 'candidate' });
  writeFileSync(join(source, 'pack.json'), JSON.stringify(manifest));
  // The running Runtime the CLI talks to loads this home's own configuration, so the fixture carries one and keeps
  // its state database inside the home the way `stateDbPath` requires.
  for (const dir of [join(home, 'config'), join(root, 'workspace'), join(root, 'export'), join(root, 'knowledge', 'process'), join(root, 'tools')])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, 'knowledge', 'process', 'synthetic-flow.yaml'), readFileSync(new URL('./fixtures/process.yaml', import.meta.url)));
  writeFileSync(join(root, 'knowledge', 'thresholds.yaml'),
    stringify({ schema: 'thresholds/0.1', version: '1', t: { max_count: { value: 10, unit: 'items', maturity: 'accepted', source: 'test' } } }));
  for (const file of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) {
    mkdirSync(join(root, 'tools', ...file.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(root, 'tools', ...file.split('/')), '');
  }
  writeFileSync(join(home, 'config', 'harness.yaml'), stringify({ stateDbPath: 'state.db', workspaceRoot: join(root, 'workspace'),
    toolRoot: join(root, 'tools'), knowledgeRoot: join(root, 'knowledge'), exportRoots: [join(root, 'export')],
    knownBodies: [], projectAliases: {}, sampleNames: [], defaultProfile: 'synthetic-flow',
    processDefinitions: { 'synthetic-flow': 'process/synthetic-flow.yaml' }, thresholdsFile: 'thresholds.yaml' }));
  const db = openDatabase(join(home, 'state.db'));
  t.after(() => db.close());
  registerPackCandidate(db, home, source, { basePackId: 'trace-base', sourceKind: 'ai', reason: 'trace fixture', impact: {}, permissions: {} });
  const results = ['codex', 'claude'].map(modelFamily => ({ caseId: 'shoe', modelFamily, attempt: 1, result: 'pass' as const, evidenceRef: 'fixture' }));
  recordPackEvaluation(db, 'trace-candidate', { suiteId: 'fit', suiteVersion: '1', isolation: 'process', baselineResults: results, results });
  chooseSharing(db, { surface: 'gui', noticeShown: true, enabled: true }, home);
  const item = authorizeContribution(db, home, 'trace-candidate', 'user', 'authorize trace fixture');
  const receipt = { schema: 'harness-contribution-receipt/0.1', candidateId: item.id, payloadHash: item.payloadHash,
    status: 'accepted', receiptId: RECEIPT_ID };
  await submitContribution(db, item.id, { endpoint: `${SERVER}/v1/contributions`, token: 'fixture-token' }, async () => Response.json(receipt));
  return { root, home, source, db, item };
}

/** The signed release the server accepted the case into, installed and activated the way the user control does. */
function installRelease(f: { root: string; home: string; source: string; db: ReturnType<typeof openDatabase> }, releaseId = 'release-1') {
  const staging = join(f.root, `staging-${releaseId}`);
  cpSync(f.source, staging, { recursive: true });
  const manifestJson = JSON.parse(readFileSync(join(staging, 'pack.json'), 'utf8')) as Record<string, unknown>;
  Object.assign(manifestJson, { id: 'trace-stable', version: '1.0.0', channel: 'stable' });
  writeFileSync(join(staging, 'pack.json'), JSON.stringify(manifestJson));
  const keys = generateKeyPairSync('ed25519');
  const publicPem = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const unsigned: SignedPackRelease = { schema: 'harness-pack-release/0.1', releaseId, packId: 'trace-stable', version: '1.0.0',
    contentHash: packTreeHash(staging).hash, issuedAt: '2026-10-01T00:00:00Z', minimumStateSchema: SCHEMA_VERSION,
    previousPackIds: [], keyId: 'official-1', signature: '' };
  const manifest = { ...unsigned, signature: sign(null, releasePayload(unsigned), keys.privateKey).toString('base64') };
  installSignedPackRelease(f.db, f.home, staging, manifest, { 'official-1': publicPem }, SCHEMA_VERSION);
  f.db.prepare("UPDATE managed_pack_release SET status='active', activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE release_id=?")
    .run(releaseId);
  return manifest;
}

function withInstallation(f: { db: ReturnType<typeof openDatabase>; home: string }): void {
  recordConsent(f.db, 'registered', 'runtime', { installId: INSTALL_ID, server: SERVER });
  writeSecret(f.home, 'sharing.installation-token', `hst_${'c'.repeat(43)}`);
}
function statusFetcher(contributions: unknown[]): typeof fetch {
  return (async () => Response.json({ schema: 'harness-contribution-status/0.1', retentionDays: 90,
    installation: { installId: INSTALL_ID, status: 'active' }, records: [], contributions })) as typeof fetch;
}

test('a server acceptance read links a receipt through candidate and evaluation to the release and installed version', async t => {
  const f = await contributed(t);
  withInstallation(f);

  // Before the server reports acceptance the chain stops at the evaluation; installing a release does not invent one.
  const initial = traceContribution(f.db, { receiptId: RECEIPT_ID })!;
  assert.equal(initial.schema, TRACE_SCHEMA);
  assert.equal(initial.receiptId, RECEIPT_ID);
  assert.equal(initial.candidateId, 'trace-candidate');
  assert.equal(initial.evaluationId, f.item.evaluationId);
  assert.equal(initial.contributionStatus, 'submitted');
  assert.ok(!Number.isNaN(Date.parse(initial.submittedAt!)), 'the submission time is recorded');
  assert.equal(initial.release, null);
  assert.equal(initial.installed, null);
  assert.equal(initial.complete, false);

  const manifest = installRelease(f);
  const beforeAcceptance = traceContribution(f.db, { receiptId: RECEIPT_ID })!;
  assert.equal(beforeAcceptance.release, null, 'a receipt is not an adoption');
  assert.equal(beforeAcceptance.installed, null,
    'without the release edge the chain cannot name a version, even though one is installed');

  const refresher = statusFetcher([{ receiptId: RECEIPT_ID, candidateId: f.item.id, state: 'accepted', releaseId: manifest.releaseId }]);
  assert.deepEqual(await refreshContributionAcceptance(f.db, f.home, refresher), { recorded: 1 });
  assert.deepEqual(await refreshContributionAcceptance(f.db, f.home, refresher), { recorded: 0 },
    'reading the same acceptance twice records it once');

  const trace = traceContribution(f.db, { receiptId: RECEIPT_ID })!;
  assert.equal(trace.complete, true);
  assert.equal(trace.candidateId, 'trace-candidate');
  assert.equal(trace.evaluationId, f.item.evaluationId);
  assert.deepEqual({ ...trace.release! }, { releaseId: 'release-1', packId: 'trace-stable', version: '1.0.0',
    status: 'active', installedAt: trace.release!.installedAt, activatedAt: trace.release!.activatedAt });
  assert.equal(trace.installed?.version, '1.0.0');
  assert.equal(trace.installed?.active, true);
  // The candidate alone finds the same case, and the acceptance is auditable exactly once.
  assert.deepEqual(traceContribution(f.db, { candidateId: 'trace-candidate' })!.release, trace.release);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM event WHERE action='accepted_into_release'").get()!.n, 1);
});

test('an acceptance this computer never uploaded, or one already recorded, changes nothing', async t => {
  const f = await contributed(t);
  const before = f.db.prepare('SELECT count(*) AS n FROM event').get()!.n;
  assert.equal(recordContributionAcceptance(f.db, { receiptId: 'd'.repeat(32), releaseId: 'release-x' }), false,
    'an unknown receipt is ignored, never invented');
  assert.equal(recordContributionAcceptance(f.db, { receiptId: RECEIPT_ID, releaseId: 'release-1' }), true);
  assert.equal(recordContributionAcceptance(f.db, { receiptId: RECEIPT_ID, releaseId: 'release-1' }), false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM event').get()!.n, Number(before) + 1);
  assert.equal(traceContribution(f.db, { receiptId: 'd'.repeat(32) }), undefined);
  assert.throws(() => recordContributionAcceptance(f.db, { receiptId: 'not-hex', releaseId: 'release-1' }), /invalid receipt id/);
});

test('an offline or failing status read records nothing and says why without failing the trace', async t => {
  const f = await contributed(t);
  withInstallation(f);
  const failing = (async () => { throw new Error('network down'); }) as typeof fetch;
  assert.deepEqual(await refreshContributionAcceptance(f.db, f.home, failing), { recorded: 0, error: 'network down' });
  assert.equal(traceContribution(f.db, { receiptId: RECEIPT_ID })!.complete, false);
  const serverError = (async () => Response.json({ error: 'no' }, { status: 503 })) as typeof fetch;
  assert.match((await refreshContributionAcceptance(f.db, f.home, serverError)).error ?? '', /503/);
  // Without an installation there is nothing to read, and that is not an error either.
  const bare = await contributed(t);
  assert.deepEqual(await refreshContributionAcceptance(bare.db, bare.home, statusFetcher([])), { recorded: 0 });
});

/**
 * DATA/D8 asks for an update whose later result stays traceable. The Runtime could answer the chain but no user
 * surface could ask: `managed.contribution.trace` was implementable only by speaking the API directly. This drives
 * the verb the way a maintainer does, over the real service, and checks that an unreachable server leaves the
 * locally recorded chain intact instead of failing the read.
 */
test('avh managed trace prints the chain the person needs, and an incomplete one says where it stops', async t => {
  const f = await contributed(t);
  withInstallation(f);
  const manifest = installRelease(f);
  recordContributionAcceptance(f.db, { receiptId: RECEIPT_ID, releaseId: manifest.releaseId });
  const service = new RuntimeService({ home: f.home, scheduler: false, pollMs: 50 });
  t.after(async () => { await service.stop(); });
  await service.start();
  const trace = async (argv: string[]) => run(process.execPath, [cli, ...argv],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, AVH_HOME: f.home } });
  const { stdout } = await trace(['managed', 'trace', '--receipt', RECEIPT_ID]);
  for (const id of [RECEIPT_ID, 'trace-candidate', f.item.evaluationId, manifest.releaseId]) assert.ok(stdout.includes(id), `${id} must appear`);
  assert.match(stdout, /完整：回执 → 候选 → 评测 → 发行 → 本机版本/);
  assert.match(stdout, /本机\ttrace-stable 1\.0\.0\t当前启用/);
  // The status server is unreachable in this fixture: the read has to say so without breaking the chain.
  assert.match(stdout, /读取服务端\t失败/);
  assert.match(stdout, /完整/);
  // The candidate finds the same case; without the acceptance edge the chain names the evaluation it stops at.
  const noEdge = await contributed(t);
  const second = new RuntimeService({ home: noEdge.home, scheduler: false, pollMs: 50 });
  t.after(async () => { await second.stop(); });
  await second.start();
  const incomplete = await run(process.execPath, [cli, 'managed', 'trace', '--candidate', 'trace-candidate'],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, AVH_HOME: noEdge.home } });
  assert.match(incomplete.stdout, /只到评测/);
  assert.doesNotMatch(incomplete.stdout, /完整/);
});
