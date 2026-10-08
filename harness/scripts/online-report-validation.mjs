// DATA/D4 and DATA/D7 online validation: drive the real client against a contribution server and record what came
// back. The 2026-09-30 evidence came from a throwaway script in %TEMP% that nothing in the repository could rerun; this
// is that driver, internalised: relative imports, a parameterised endpoint, and an explicit switch for writes.
//
// Usage: node scripts/online-report-validation.mjs [--endpoint <url>] [--output <file>] [--allow-writes]
//   Without --allow-writes it performs read-only preflight requests only and says so; no installation is registered
//   and no report is uploaded. Against the public server that is the default on purpose.
//   Exit 0 every requested check passed; 1 a check failed; 2 the arguments or the endpoint were refused.
//
// It carries no credential: each run registers fresh anonymous installations on the target, keeps their tokens in a
// temporary HOME, and revokes both in a finally block. No model is called, no user project is read, and no source or
// free text is uploaded -- the uploaded candidate is the shipped built-in pack with a synthetic single-family result.
//
// Against the deployed entry point the writes go through nginx, where `POST /v1/installations` and
// `POST /v1/contributions` share the `harness_contrib` limit zone (`deploy/nginx/harness.nymiro.moe.conf:20,94-96,
// 124-126`: `rate=6r/m burst=3 nodelay`, refusal as 429). The driver spends that budget deliberately and waits out a
// 429 instead of reading it as an answer: a 429 is the reverse proxy, and the check it would otherwise break --
// "a revoked credential cannot upload the old payload again" -- is proved only by the application's own 403.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorizeContribution, submitContribution } from '../src/contribution-queue.ts';
import { recordPackEvaluation, registerPackCandidate } from '../src/managed-pack-candidate.ts';
import { OFFICIAL_SERVER } from '../src/official.ts';
import { clearSecret, readSecret } from '../src/providers/secrets.ts';
import { remoteSharingStatus, revokeSharing, sharingToken } from '../src/sharing/client.ts';
import { CONTRIBUTION_ZONE, ContributionPacer, sendPaced } from '../src/sharing/pacing.ts';
import { chooseSharing, sharingState } from '../src/sharing/state.ts';
import { openDatabase } from '../src/state/db.ts';
import { SHARING_NOTICE_VERSION, SHARING_PATHS } from '../src/shared/sharing.ts';

const harnessRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
if (args.includes('--help')) {
  console.log('usage: node scripts/online-report-validation.mjs [--endpoint <url>] [--output <file>] [--allow-writes]');
  process.exit(0);
}
const endpoint = (option('--endpoint') ?? OFFICIAL_SERVER).replace(/\/+$/, '');
const allowWrites = args.includes('--allow-writes');
let origin;
try { origin = new URL(endpoint); } catch { throw new Error(`--endpoint is not a URL: ${endpoint}`); }
// The same rule the client enforces: records only leave for HTTPS, or for this machine over HTTP.
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
  console.error(`refused: ${endpoint} is neither HTTPS nor this machine`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'avh-online-report-')), home = join(root, 'home'), otherHome = join(root, 'other-home');
const source = join(root, 'synthetic-source'), started = Date.now();
mkdirSync(home); mkdirSync(otherHome);
const db = openDatabase(join(home, 'state.db')), other = openDatabase(join(otherHome, 'state.db'));
const evidence = { schema: 'online-structured-report-validation/0.1', endpoint, mode: allowWrites ? 'writes' : 'read-only',
  startedAt: new Date(started).toISOString(), synthetic: true, modelCalls: 0, sourceFilesSent: 0, requests: [], checks: [], cleanup: {},
  pacing: { zone: CONTRIBUTION_ZONE.name, requestsPerMinute: CONTRIBUTION_ZONE.requestsPerMinute, burst: CONTRIBUTION_ZONE.burst,
    paths: CONTRIBUTION_ZONE.paths, config: CONTRIBUTION_ZONE.config } };

function check(name, condition) {
  evidence.checks.push({ name, passed: Boolean(condition) });
  assert.ok(condition, name);
}
/**
 * Counts every request (retries included, so the record shows the 429s that were waited out), refuses a redirect out of
 * the chosen origin, and keeps the uploaded body for the retry check. The two contribution paths are paced to the
 * `harness_contrib` zone and a 429 is retried rather than returned; `sendPaced` throws if the limit never clears.
 */
let uploadedBody = '';
const pacer = new ContributionPacer();
const fetcher = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  assert.equal(url.origin, origin.origin, `refusing a request outside ${origin.origin}`);
  const response = await sendPaced(url.pathname, async attempt => {
    const before = Date.now();
    const answer = await fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
    evidence.requests.push({ path: url.pathname, method: init?.method ?? 'GET', status: answer.status, attempt,
      bodyBytes: typeof init?.body === 'string' ? Buffer.byteLength(init.body) : 0, elapsedMs: Date.now() - before });
    return answer;
  }, { pacer });
  if (url.pathname === SHARING_PATHS.contributions && init?.method === 'POST' && typeof init.body === 'string') uploadedBody = init.body;
  return response;
};

try {
  // Read-only preflight: what the deployment advertises must match the contract the client ships.
  const health = await (await fetcher(`${endpoint}/v1/health`)).json();
  check('the deployment answers a health read', health.ok === true && health.service === 'harness-server');
  const capabilities = await (await fetcher(`${endpoint}/v1/capabilities`)).json();
  check(`public HTTPS advertises notice ${SHARING_NOTICE_VERSION} explicit opt-in`,
    capabilities.dataPolicy?.noticeVersion === SHARING_NOTICE_VERSION && capabilities.dataPolicy?.participation === 'explicit-opt-in');
  check('public policy states a real backup period', Number.isInteger(capabilities.dataPolicy?.backupDays) && capabilities.dataPolicy.backupDays >= 0);
  check('public policy separates every request path', JSON.stringify(capabilities.dataPolicy?.endpoints) === JSON.stringify(SHARING_PATHS));
  check('public policy claims no address or token logging',
    capabilities.dataPolicy?.logs?.clientAddresses === false && capabilities.dataPolicy?.logs?.tokens === false);
  evidence.policy = { noticeVersion: capabilities.dataPolicy?.noticeVersion, retentionDays: capabilities.dataPolicy?.retentionDays,
    backupDays: capabilities.dataPolicy?.backupDays, participation: capabilities.dataPolicy?.participation };

  if (!allowWrites) {
    evidence.ok = true;
    console.log(JSON.stringify({ root, ok: true, mode: 'read-only', checks: evidence.checks.length,
      note: 'no installation was registered and no report was uploaded; pass --allow-writes for the full validation' }));
  } else {
    cpSync(join(harnessRoot, 'builtin'), source, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(source, 'pack.json'), 'utf8')), base = manifest.id;
    const candidate = `synthetic-online-${randomUUID()}`;
    Object.assign(manifest, { id: candidate, version: 'synthetic-test', channel: 'candidate' });
    writeFileSync(join(source, 'pack.json'), JSON.stringify(manifest));
    registerPackCandidate(db, home, source, { basePackId: base, sourceKind: 'human', reason: 'synthetic pipeline validation',
      impact: {}, permissions: {} });
    const cases = [{ caseId: 'synthetic-case', modelFamily: 'synthetic-family', attempt: 1, result: 'error', evidenceRef: 'synthetic' }];
    recordPackEvaluation(db, candidate, { suiteId: 'synthetic', suiteVersion: '1', isolation: 'process',
      baselineResults: cases.map(value => ({ ...value, result: 'pass' })), results: cases });
    chooseSharing(db, { surface: 'cli', noticeShown: true, enabled: true }, home);
    const draft = authorizeContribution(db, home, candidate, 'test-operator', 'authorized structured synthetic report only');
    const reportDirectory = join(draft.bundlePath, 'pack');
    const report = JSON.parse(readFileSync(join(reportDirectory, 'candidate-report.json'), 'utf8'));
    check('upload tree contains only the structured report', readdirSync(reportDirectory).join(',') === 'candidate-report.json');
    check('a failed single-family evaluation stays reportable',
      report.evaluation.status === 'failed' && report.evaluation.candidate.passes === 0 && report.evaluation.candidate.modelFamilies === 1);

    const token = await sharingToken(db, home, endpoint, fetcher);
    const submitted = await submitContribution(db, draft.id, { endpoint: `${endpoint}${SHARING_PATHS.contributions}`, token }, fetcher);
    check('authorization reaches an actual matching server receipt',
      submitted.status === 'submitted' && submitted.receipt?.candidateId === draft.id && submitted.receipt?.payloadHash === draft.payloadHash);
    evidence.contributionId = draft.id;
    evidence.payloadHash = draft.payloadHash;
    evidence.receipt = submitted.receipt;
    evidence.reportBytes = readFileSync(join(reportDirectory, 'candidate-report.json')).length;

    // The same payload over HTTP again: the server answers the same receipt, and the client does not even re-request.
    const again = await (await fetcher(`${endpoint}${SHARING_PATHS.contributions}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: uploadedBody })).json();
    check('an actual HTTP duplicate returns the same receipt', JSON.stringify(again) === JSON.stringify(submitted.receipt));
    const beforeLocal = evidence.requests.length;
    const localAgain = await submitContribution(db, draft.id, { endpoint: `${endpoint}${SHARING_PATHS.contributions}`, token }, fetcher);
    check('a local duplicate makes no new request',
      evidence.requests.length === beforeLocal && localAgain.receipt?.receiptId === submitted.receipt?.receiptId);

    const owned = await remoteSharingStatus(db, home, fetcher);
    check('the installation status owns exactly its one report',
      owned.installation.installId === sharingState(db).installation.installId && owned.contributions.length === 1);
    evidence.ownerStatus = { reports: owned.contributions.length, records: owned.records.length };

    // A second real installation must not be able to see the first one's report.
    chooseSharing(other, { surface: 'cli', noticeShown: true, enabled: true }, otherHome);
    await sharingToken(other, otherHome, endpoint, fetcher);
    const notOwned = await remoteSharingStatus(other, otherHome, fetcher);
    check('a separate actual installation cannot see the first report',
      notOwned.contributions.length === 0 && notOwned.installation.installId !== owned.installation.installId);

    const revoked = await revokeSharing(db, home, fetcher);
    check('an actual server revocation removes the synthetic report',
      revoked.revoked === true && revoked.removed.contributions.includes(submitted.receipt.receiptId));
    check('the main installation token is removed locally',
      readSecret(home, 'sharing.installation-token') === undefined && sharingState(db).installation === null);
    evidence.revocation = { revoked: revoked.revoked, removed: revoked.removed, retained: revoked.retained };

    const emptyResponse = await fetcher(`${endpoint}${SHARING_PATHS.status}`, { headers: { authorization: `Bearer ${token}` } });
    const empty = await emptyResponse.json();
    check('a revoked installation confirms it retains nothing',
      emptyResponse.status === 200 && empty.contributions.length === 0 && empty.installation.status === 'revoked');
    // Only the application's own 403 proves the revocation. The reverse proxy's 429 is waited out and retried inside
    // the fetcher, so it never reaches this line: accepting it here would hide a revocation regression behind a limit.
    const denied = await fetcher(`${endpoint}${SHARING_PATHS.contributions}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: uploadedBody });
    check('a revoked credential cannot upload the old payload again', denied.status === 403);

    const otherRevoked = await revokeSharing(other, otherHome, fetcher);
    check('the ownership-test installation is revoked too',
      otherRevoked.revoked === true && readSecret(otherHome, 'sharing.installation-token') === undefined);
    check('a report receipt never adopts or publishes a candidate',
      db.prepare('SELECT count(*) AS n FROM managed_pack_release').get().n === 0 &&
      db.prepare('SELECT count(*) AS n FROM managed_pack_trial').get().n === 0);
    evidence.ok = true;
  }
} catch (error) {
  evidence.ok = false;
  evidence.error = String(error?.message ?? error).slice(0, 400);
  process.exitCode = 1;
} finally {
  for (const [current, currentHome] of [[db, home], [other, otherHome]]) {
    try { if (sharingState(current).installation) await revokeSharing(current, currentHome, fetcher); }
    catch (error) { evidence.cleanup.remoteError = String(error?.message ?? error).slice(0, 200); }
    clearSecret(currentHome, 'sharing.installation-token');
    current.close();
  }
  for (const generated of [home, otherHome, source]) {
    assert.equal(dirname(resolve(generated)), resolve(root));
    assert.ok(['home', 'other-home', 'synthetic-source'].includes(basename(generated)));
    rmSync(generated, { recursive: true, force: true });
  }
  evidence.cleanup.localKeyAndPayloadRemoved = !existsSync(home) && !existsSync(otherHome) && !existsSync(source);
  evidence.elapsedMs = Date.now() - started;
  evidence.finishedAt = new Date().toISOString();
  const output = resolve(option('--output') ?? join(root, 'evidence.json'));
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  // The scratch tree holds nothing after the cleanup above; when the evidence lives elsewhere it goes too.
  if (dirname(output) !== resolve(root)) rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ output, ok: evidence.ok, mode: evidence.mode, checks: evidence.checks.length,
    requests: evidence.requests.length, elapsedMs: evidence.elapsedMs, cleanup: evidence.cleanup, error: evidence.error }));
}
