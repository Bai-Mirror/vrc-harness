import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { describeCompetitors, licenceClientEvidence, licenceContention, licenceGuidance, unityCompetitorsOf,
  type SeenProcess } from '../../src/exec/unity-license.ts';
import { removeTemp } from '../fixtures/platform.ts';

/**
 * The lines below are the recorded failure verbatim
 * (`docs/zh/工作区/证据/缺陷/19_跨车道Unity争用导致退出码199.md`): the editor's own log, and the licensing client's.
 */
const EDITOR_LOG = [
  '[Licensing::IpcConnector] Error: Connection attempt to the License Client on channel: "LicenseClient-nymiro"',
  '                          failed because Connection Refused; code: "0x8000000a"',
  '[Licensing::Module] Successfully launched the LicensingClient (PId: 1234)',
  '[Licensing::IpcConnector] Error: Connection attempt to the License Client on channel: "LicenseClient-nymiro"',
  '                          failed because channel doesn\'t exist; code: "0x80000002"',
  '[Licensing::Module] Timed-out after 60.01s, waiting for channel: "LicenseClient-nymiro"',
  "IPC channel to LicensingClient doesn't exist; aborting",
  'Application will terminate with return code 199',
].join('\n');

const CLIENT_LOG = 'ERROR - [Unity.Licensing.Client.PipeServerExecutor] Failed to acquire global mutex Unity-LicenseClient-nymiro.\n' +
  'Another instance of Unity.Licensing.Client is already running.';

test('the recorded failure is recognised as licensing-client contention', () => {
  const seen = licenceContention({ exitCode: 199, log: EDITOR_LOG, clientLog: CLIENT_LOG });
  assert.ok(seen, 'the recorded log is the diagnosis');
  assert.equal(seen.exitCode, 199);
  assert.ok(seen.evidence.some(line => /Timed-out after 60\.01s, waiting for channel/.test(line)));
  assert.ok(seen.evidence.some(line => /Failed to acquire global mutex/.test(line)), 'the client\'s own line is evidence too');
});

test('neither half alone is the diagnosis', () => {
  assert.equal(licenceContention({ exitCode: 199, log: 'Application will terminate with return code 199' }), undefined,
    'exit 199 without a licensing line is not this cause');
  assert.equal(licenceContention({ exitCode: 1, log: 'Failed to acquire global mutex Unity-LicenseClient-u' }), undefined,
    'a licensing line in a log that does not end in 199 is not this cause');
  assert.equal(licenceContention({ exitCode: 0, log: 'batch complete\n' }), undefined);
  assert.equal(licenceContention({ exitCode: 199, log: 'error CS1002: ; expected' }), undefined, 'a compile failure is not contention');
  assert.ok(licenceContention({ exitCode: 17, log: 'Failed to acquire global mutex Unity-LicenseClient-u\nx\nreturn code 199\ny' }),
    'the log may carry the code when the process code does not');
  assert.ok(licenceContention({ exitCode: 1, log: EDITOR_LOG }), 'and the recorded log is accepted whatever the collected code was');
});

test('the licensing evidence keeps the first distinct lines and stays bounded', () => {
  const repeated = Array(20).fill('IPC channel to LicensingClient doesn\'t exist; aborting').join('\n');
  assert.deepEqual(licenceClientEvidence(repeated), ["IPC channel to LicensingClient doesn't exist; aborting"]);
  assert.ok(licenceClientEvidence(Array(30).fill(0).map((_, i) =>
    `${i} Timed-out after 60.01s, waiting for channel: "LicenseClient-u${i}"`).join('\n')).length <= 6);
  assert.deepEqual(licenceClientEvidence('nothing to see'), []);
});

test('competitors are the editors that are not this step\'s, plus every licensing client', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-competitors-'));
  t.after(() => removeTemp(root));
  const ours = join(root, 'alias-1'), other = join(root, 'other-project'), missing = join(root, 'never-existed');
  mkdirSync(ours); mkdirSync(other);
  const editors: SeenProcess[] = [
    { pid: 10, name: 'Unity.exe', commandLine: `"C:\\Unity\\Unity.exe" -batchmode -projectPath "${ours}"` },
    { pid: 11, name: 'Unity.exe', commandLine: `Unity.exe -batchmode -projectPath "${other}" -executeMethod X` },
    { pid: 12, name: 'Unity.exe', commandLine: `"C:\\Unity\\Unity.exe" -projectPath "${missing}"` },
    { pid: 13, name: 'Unity.exe', commandLine: 'Unity.exe' },
  ];
  const clients: SeenProcess[] = [{ pid: 14, name: 'Unity.Licensing.Client.exe', commandLine: 'Unity.Licensing.Client.exe' }];
  const found = unityCompetitorsOf(editors, clients, [ours, join(root, 'real-project')]);
  assert.deepEqual(found.map(item => [item.pid, item.kind]), [[11, 'editor'], [12, 'editor'], [13, 'editor'], [14, 'licensing-client']],
    'our own project is excluded; a competitor whose project cannot be resolved, one with no project, and a client are all kept');
  assert.equal(found[0]!.project, other);
  assert.match(describeCompetitors(found), new RegExp(`PID 11（Unity\\.exe，工程 ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}）`));
});

test('the guidance names the holder and tells the person what to do, and does not say "wait" after waiting', () => {
  const contention = { exitCode: 199, evidence: ['Timed-out after 60.01s, waiting for channel: "LicenseClient-u"'] };
  const project = join(tmpdir(), 'avh-menu-groups-P0Qdye');
  const competitors = [
    { pid: 4242, name: 'Unity.exe', commandLine: `Unity.exe -projectPath ${project}`, project, kind: 'editor' as const },
    { pid: 4243, name: 'Unity.Licensing.Client.exe', commandLine: 'x', kind: 'licensing-client' as const },
  ];
  const waited = licenceGuidance(contention, competitors, { retries: 2, waitedMs: 120_000 });
  assert.match(waited, /另一个 Unity 正在占用/);
  assert.match(waited, /PID 4242/);
  assert.ok(waited.includes(project), 'the holder is named by the project it has open');
  assert.match(waited, /已等待 120 秒并重试 2 次/);
  assert.match(waited, /需要你做的：关闭上面那个 Unity/);
  const held = licenceGuidance(contention, competitors, { retries: 0, waitedMs: 60_000 });
  assert.match(held, /已等待 60 秒，占用者仍在运行/, 'a wait with no relaunch does not claim a retry');
  const blind = licenceGuidance(contention, [], { retries: 0, waitedMs: 0 });
  assert.match(blind, /没有在本机进程列表里看到占用者/);
  assert.match(blind, /不用改配置或工程/);
  const stale = licenceGuidance(contention,
    unityCompetitorsOf([], [{ pid: 9, name: 'Unity.Licensing.Client.exe', commandLine: 'x' }], []), { retries: 1, waitedMs: 5_000 });
  assert.match(stale, /没有看到别的 Unity 编辑器，但有 1 个 Unity 授权客户端进程/);
});
