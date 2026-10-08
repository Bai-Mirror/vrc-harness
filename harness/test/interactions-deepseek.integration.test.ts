import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../src/config.ts';
import { openDatabase } from '../src/state/db.ts';
import { createProject } from '../src/workflow/runtime.ts';
import { cancel, serveOnce } from '../src/task-cli.ts';
import { submitInteraction } from '../src/interactions.ts';
import { piSecret } from '../src/providers/pi.ts';
import { clearSecret, readSecret, writeSecret } from '../src/providers/secrets.ts';
import { hostPlatform } from '../src/host-platform.ts';
import { waitFor } from './fixtures/wait.ts';

// Explicitly opt in: uses only the installed DeepSeek connection, and creates an isolated test workspace.
test('real DeepSeek answers and resumes a persisted clarification through the supervised Runtime', {
  skip: process.env.AVH_DEEPSEEK_INTERACTION_IT !== '1', timeout: 900_000,
}, async () => {
  const installed = loadConfig();
  const provider = installed.providers.find(p => p.adapter === 'pi-cli' && p.upstream === 'deepseek');
  assert.ok(provider, 'Configure DeepSeek in Harness first');
  const secret = readSecret(installed.home, piSecret(provider));
  assert.ok(secret, 'The installed DeepSeek credential is missing');
  const root = mkdtempSync(join(tmpdir(), 'avh-deepseek-interaction-'));
  console.log(`DeepSeek interaction evidence: ${root}`);
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  for (const p of [join(home, 'config'), join(home, 'state'), workspace, join(root, 'exports')]) mkdirSync(p, { recursive: true });
  const raw = parse(readFileSync(join(installed.home, 'config/harness.yaml'), 'utf8'));
  raw.workspaceRoot = workspace; raw.exportRoots = [join(root, 'exports')]; raw.sampleNames = []; raw.projectAliases = {};
  raw.providers = [{ id: 'deepseek-validation', type: 'pi-cli', upstream: 'deepseek', executable: provider.executable,
    ...(provider.model ? { model: provider.model } : {}), ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    roles: ['executor'], writable: [], network: true, timeoutMs: 180000, secret: 'validation-deepseek' }];
  writeFileSync(join(home, 'config/harness.yaml'), stringify(raw));
  writeSecret(home, 'validation-deepseek', secret);
  const config = loadConfig(home), project = createProject(config, 'sample');
  const original = readFileSync(join(project, '.gitignore'), 'utf8');
  const db = openDatabase(join(home, 'state/harness.db'));
  db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run('workspace', workspace);
  db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
    VALUES('sample','workspace','sample',?,'{}','active','test','test')`).run(project);
  async function settle(id: string) {
    return (await waitFor(async () => {
      await serveOnce(db, config);
      const row = db.prepare('SELECT status,error FROM project_interaction WHERE id=?').get(id)!;
      if (['awaiting_user','completed','failed','superseded','cancelled'].includes(String(row.status))) return row;
      const task = db.prepare('SELECT t.status FROM task t JOIN project_interaction i ON i.task_id=t.id WHERE i.id=?').get(id);
      if (task && ['BLOCKED','RECOVERY_REQUIRED','WAITING_HUMAN'].includes(String(task.status)))
        throw new Error(`Coordination task requires attention: ${task.status}; inspect the retained evidence`);
      return undefined;
    }, { what: `interaction ${id} to settle`, timeoutMs: 300_000, intervalMs: 2_000 }))!;
  }
  try {
    const first = submitInteraction(db, 'sample', { commandId: 'first', expectedRevision: 0,
      content: '我想给头像换一种风格，但还没决定配色。请先向我问一个配色偏好问题，不要开始制作。' });
    assert.equal((await settle(first.id)).status, 'awaiting_user');
    const reply = submitInteraction(db, 'sample', { commandId: 'reply', expectedRevision: 1, replyTo: first.id,
      content: '选择黑白搭配，保留原来的脸型和服装。这轮只需总结这些约束，不必继续提问，也不要开始制作。' });
    assert.equal((await settle(reply.id)).status, 'completed');
    assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), original);
    assert.equal(execFileSync(hostPlatform.toolCommand('git'), ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '');
    assert.equal((db.prepare('SELECT count(*) AS n FROM lock').get() as { n: number }).n, 0);
  } finally {
    const active = db.prepare("SELECT id FROM task WHERE status NOT IN ('PASSED','FAILED','CANCELLED')").all();
    for (const row of active) await cancel(db, config, String(row.id));
    writeFileSync(join(root, 'result.json'), JSON.stringify({
      interactions: db.prepare('SELECT id,revision,status,task_id,error FROM project_interaction').all(),
      runs: db.prepare('SELECT id,task_id,status,provider FROM run').all(),
      verdicts: db.prepare('SELECT check_id,result,basis FROM verdict').all(),
    }, null, 2));
    // A process whose termination cannot be confirmed retains recovery ownership and its scoped credential.
    if ((db.prepare('SELECT count(*) AS n FROM lock').get() as { n: number }).n === 0) clearSecret(home, 'validation-deepseek');
    db.close();
  }
});
