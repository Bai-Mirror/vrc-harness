import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { harnessVersion, knowledgeVersion, interpretationHash } from '../../src/provenance.ts';
import { promptEvidence } from '../../src/run/evidence.ts';
import { materializeRunManifest, selectProviderWithManifest } from '../../src/run/manifest.ts';
import { classifyError, parseProviderOutput } from '../../src/providers/parse.ts';
import { parseRetryAfter } from '../../src/providers/retry-after.ts';
import { bwrapArgs, gitMetadataPaths, probeCodex } from '../../src/exec/sandbox.ts';
import { UnitExecutor } from '../../src/exec/executor.ts';
import { openDatabase } from '../../src/state/db.ts';
import type { LocalConfig } from '../../src/config.ts';
import { removeTemp, windows } from '../fixtures/platform.ts';

function temporary(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'avh-foundation-'));
  t.after(() => removeTemp(path));
  return path;
}
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

test('versions derive from Git HEAD and loaded files, with explicit non-Git fallbacks', t => {
  const root = temporary(t), code = join(root, 'code'), knowledge = join(root, 'knowledge');
  mkdirSync(code); mkdirSync(knowledge);
  writeFileSync(join(code, 'package.json'), '{"version":"9.8.7"}');
  assert.equal(harnessVersion(code), '9.8.7+nogit');
  execFileSync('git', ['-C', code, 'init', '-q']);
  writeFileSync(join(code, 'file'), 'x');
  execFileSync('git', ['-C', code, 'add', '.']);
  execFileSync('git', ['-C', code, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const head = execFileSync('git', ['-C', code, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(harnessVersion(code), head);
  writeFileSync(join(code, 'file'), 'changed');
  assert.equal(harnessVersion(code), `${head}+dirty`);
  const definition = join(knowledge, 'process.yaml'), thresholds = join(knowledge, 'thresholds.yaml'), rules = join(knowledge, 'rules.yaml');
  for (const path of [definition, thresholds, rules]) writeFileSync(path, 'a');
  const config = { knowledgeRoot: knowledge, defaultProfile: 'synthetic',
    provenanceFiles: { synthetic: { knowledge: [definition, thresholds], interpretation: [rules] } },
    importSettings: { recordNames: ['x'] } } as unknown as LocalConfig;
  assert.equal(knowledgeVersion(config), 'unknown:no-git-head');
  execFileSync('git', ['-C', knowledge, 'init', '-q']);
  execFileSync('git', ['-C', knowledge, 'add', '.']);
  execFileSync('git', ['-C', knowledge, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const before = knowledgeVersion(config), interpretation = interpretationHash(config);
  assert.match(before, /^[0-9a-f]{12}:[0-9a-f]{12}$/);
  writeFileSync(thresholds, 'b');
  assert.notEqual(knowledgeVersion(config), before);
  assert.equal(interpretationHash(config), interpretation);
  writeFileSync(rules, 'b');
  assert.notEqual(interpretationHash(config), interpretation);
});

test('failure evidence marks only actual truncation and preserves full text', t => {
  const dir = temporary(t);
  assert.deepEqual(promptEvidence('a'.repeat(1000), dir), { text: 'a'.repeat(1000), truncated: [] });
  const result = promptEvidence('b'.repeat(3000), dir);
  assert.match(result.text, /已截断，原文 3000 字/);
  assert.equal(result.truncated[0]?.keptLength, 1500);
  assert.equal(readFileSync(result.truncated[0]!.fullRef, 'utf8').length, 3000);
});

test('provider selection commits manifest payload once and materializes the same file', t => {
  const root = temporary(t), dir = join(root, 'run'), project = join(root, 'project');
  mkdirSync(dir); mkdirSync(project);
  const db = openDatabase(join(root, 'state.sqlite')); t.after(() => db.close());
  db.exec("INSERT INTO workspace(id,path) VALUES('ws','/synthetic')");
  db.prepare("INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version) VALUES('p','ws','sample',?,'{}','active','h','k')").run(project);
  db.exec("INSERT INTO workflow(id,project_id,process_id,process_hash,knowledge_version,status,plan_json) VALUES('wf','p','x','x','k','active','{}')");
  db.exec("INSERT INTO task(id,workflow_id,stage_id,goal,capability,status) VALUES('t','wf','work','x','executor','RUNNING')");
  db.exec("INSERT INTO run(id,task_id,attempt,status) VALUES('r','t',1,'pending')");
  db.prepare('INSERT INTO provider_snapshot(workflow_id,snapshot_json) VALUES (?,?)').run('wf', JSON.stringify({ providers: [
    { config: { id: 'fake', model: 'model-x' }, probe: { version: '1.2.3' } }] }));
  writeFileSync(join(dir, 'task.txt'), 'task');
  mkdirSync(join(project, 'ProjectSettings'));
  writeFileSync(join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  writeFileSync(join(dir, 'command.json'), JSON.stringify({ sandbox: 'bwrap' }));
  writeFileSync(join(dir, 'scope-before.json'), JSON.stringify({ head: 'abcdef', status: {} }));
  writeFileSync(join(dir, 'provider-request.json'), JSON.stringify({ settingsSource: 'synthetic',
    automaticMemory: 'disabled', instructionFiles: [{ path: '/synthetic/AGENTS.md', sha256: sha('rules') }] }));
  const manifest = selectProviderWithManifest(db, undefined, 'wf', 'r', 'fake', 'chosen', dir, project, [], true);
  assert.equal(manifest.prompt.sha256, sha('task'));
  assert.deepEqual(manifest.provider_snapshot, { ref: 'provider_snapshot:wf', provider_id: 'fake',
    model: 'model-x', cli_version: '1.2.3' });
  assert.equal(manifest.environment.sandbox, 'bwrap');
  assert.equal(manifest.environment.unity_version, '2022.3.22f1');
  assert.deepEqual(manifest.observability.instruction_files, [{ path: '/synthetic/AGENTS.md', sha256: sha('rules') }]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), manifest);
  rmSync(join(dir, 'manifest.json'));
  assert.deepEqual(materializeRunManifest(db, 'r', dir), manifest);
  selectProviderWithManifest(db, undefined, 'wf', 'r', 'fake', 'chosen', dir, project);
  assert.equal((db.prepare("SELECT count(*) n FROM event WHERE action='provider_selected'").get() as { n: number }).n, 1);
});

test('session limit is rate limit and local reset converts to UTC', () => {
  const message = "You've hit your session limit · resets 3:50am (Pacific/Auckland)";
  assert.equal(classifyError(message, 1), 'rate_limit');
  assert.equal(parseRetryAfter(message, new Date('2026-09-26T00:00:00Z')), '2026-09-26T14:50:00.000Z');
  const result = parseProviderOutput('claude-cli', `${JSON.stringify({ type: 'result', is_error: true, terminal_reason: 'api_error', result: message })}\n`, '', 1,
    { runId: 'r', taskId: 't', workflowId: 'wf', projectId: 'p', stageId: 'work', attempt: 1,
      idempotencyKey: 'r', expectedOutputs: [], prompt: '', role: 'executor' }, 'fake', 'x', 'y');
  assert.equal(result.errorClass, 'rate_limit');
  assert.match(result.retryAfter ?? '', /^\d{4}-/);
});

test('writable Git metadata is covered by read-only bwrap binds and Codex probe rejects it', t => {
  const root = temporary(t), project = join(root, 'project'), run = join(root, 'run');
  mkdirSync(project); mkdirSync(run); mkdirSync(join(project, '.git')); mkdirSync(join(project, '.git', 'hooks'));
  assert.deepEqual(gitMetadataPaths([project]), [join(project, '.git')]);
  const subproject = join(project, 'subproject'); mkdirSync(subproject);
  writeFileSync(join(subproject, '.git'), 'gitdir: ../.git/worktrees/subproject\n');
  assert.deepEqual(gitMetadataPaths([project]), [join(project, '.git'), join(subproject, '.git')]);
  const args = bwrapArgs([project, run], ['true']);
  assert.ok(args.join(' ').includes(`--ro-bind ${join(project, '.git')} ${join(project, '.git')}`));
  assert.match(probeCodex(project, run, []).reason ?? '', /contains \.git/);
  // Windows keeps .git read-only with an integrity label instead (test/exec/windows.test.ts).
  if (windows) return;
  const command = spawnSync('bwrap', bwrapArgs([project, run], ['sh', '-c',
    'printf ok > "$1"; printf no > "$2"', 'sh', join(project, 'ok'), join(project, '.git/hooks/x')]), { encoding: 'utf8' });
  if (/Operation not permitted|No permissions|not permitted/i.test(command.stderr) && !existsSync(join(project, 'ok'))) {
    t.diagnostic('bwrap namespace unavailable in this environment'); return;
  }
  assert.notEqual(command.status, 0);
  assert.equal(readFileSync(join(project, 'ok'), 'utf8'), 'ok');
  assert.equal(existsSync(join(project, '.git/hooks/x')), false);
});

test('self sandbox refuses a writable project containing Git metadata before launch', async t => {
  const root = temporary(t), project = join(root, 'project'), runs = join(root, 'runs');
  mkdirSync(project); mkdirSync(runs); mkdirSync(join(project, '.git'));
  const executor = new UnitExecutor({ projectDirectory: project, workspaceRepository: project, runRoot: runs,
    writableByRunner: { synthetic: [] }, sandboxByRunner: { synthetic: 'self' },
    commandFor: () => ({ runner: 'synthetic', argv: ['true'] }) });
  await assert.rejects(executor.start({ runId: 'run1', taskId: 'task', workflowId: 'wf', projectId: 'p',
    stageId: 'work', attempt: 1, idempotencyKey: 'run1', expectedOutputs: [], allowedWrites: [project] }), /read-only/);
  assert.equal(existsSync(join(runs, 'run1', 'command.json')), false);
});
