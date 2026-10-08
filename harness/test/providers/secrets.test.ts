import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { windowsHelper } from '../../src/exec/windows-helper.ts';
import { checkSecretEnv, clearSecret, hasSecret, readSecret, resolveSecretEnv, secretMethod, secretPath, writeSecret } from '../../src/providers/secrets.ts';
import { removeTemp, windows } from '../fixtures/platform.ts';

function home(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'avh-secrets-')); t.after(() => removeTemp(dir));
  return dir;
}

test('credentials are stored one per file in the private configuration and never read back as anything but themselves', t => {
  const h = home(t);
  assert.equal(secretPath(h, 'pi-deepseek'), join(h, 'config', 'secrets', 'pi-deepseek'));
  assert.equal(readSecret(h, 'pi-deepseek'), undefined);
  writeSecret(h, 'pi-deepseek', '  sk-test-value  ');
  assert.equal(readSecret(h, 'pi-deepseek'), 'sk-test-value');
  assert.equal(hasSecret(h, 'pi-deepseek'), true);
  if (!windows) assert.equal(statSync(secretPath(h, 'pi-deepseek')).mode & 0o777, 0o600);
  assert.equal(clearSecret(h, 'pi-deepseek'), true);
  assert.equal(clearSecret(h, 'pi-deepseek'), false, 'nothing left to clear');
  for (const id of ['../escape', 'Upper', '', 'a/b', 'x'.repeat(65)]) assert.throws(() => secretPath(h, id), /无效的凭据名/, id);
  for (const value of ['', '   ', 'two\nlines', 'nul\0byte']) assert.throws(() => writeSecret(h, 'pi-glm', value), /不能为空|换行/);
});

test('before a configuration exists the GUI host serves the credential methods on the same files, never returning a value', t => {
  const h = home(t);
  assert.deepEqual(secretMethod(h, 'secret.set', { id: 'claude-oauth-token', value: ' sk-ant-oat01-FIRST-RUN ' }), { ok: true });
  assert.equal(readSecret(h, 'claude-oauth-token'), 'sk-ant-oat01-FIRST-RUN', 'where the Runtime reads it once it runs');
  const status = secretMethod(h, 'secret.status', { ids: ['claude-oauth-token', 'claude-api-key'] });
  assert.deepEqual(status, { 'claude-oauth-token': true, 'claude-api-key': false });
  assert.doesNotMatch(JSON.stringify(status), /FIRST-RUN/);
  assert.deepEqual(secretMethod(h, 'secret.clear', { id: 'claude-oauth-token' }), { cleared: true });
  assert.equal(hasSecret(h, 'claude-oauth-token'), false);
  assert.throws(() => secretMethod(h, 'secret.set', { id: '../escape', value: 'x' }), /无效的凭据名/);
  assert.throws(() => secretMethod(h, 'secret.set', { id: 'claude-api-key' }), /缺少凭据内容/);
  assert.throws(() => secretMethod(h, 'secret.get', { id: 'claude-api-key' }), /未知的凭据方法/, 'there is no way to read one back');
});

test('a command asks for credentials by name; a missing one or a bad variable name is refused before it starts', t => {
  const h = home(t);
  writeSecret(h, 'claude-token', 'token-value');
  assert.deepEqual(resolveSecretEnv(h, { CLAUDE_CODE_OAUTH_TOKEN: 'claude-token' }), { CLAUDE_CODE_OAUTH_TOKEN: 'token-value' });
  assert.deepEqual(resolveSecretEnv(h, undefined), {});
  assert.throws(() => checkSecretEnv(h, { ZAI_API_KEY: 'pi-glm' }), /缺少凭据 pi-glm/);
  assert.throws(() => checkSecretEnv(h, { 'BAD-NAME': 'claude-token' }), /无效的环境变量名/);
});

/** The unit wrapper as the executor starts it: node unit-wrapper.mjs <command.json>. */
function runWrapper(t: TestContext, secretEnv: Record<string, string>, secrets: Record<string, string>) {
  const h = home(t), runDirectory = join(h, 'runs', 'r1');
  mkdirSync(runDirectory, { recursive: true });
  for (const [id, value] of Object.entries(secrets)) writeSecret(h, id, value);
  // The command reports a digest of what it received, so nothing in its argv could explain the value turning up in a record.
  const check = "process.stdout.write(require('node:crypto').createHash('sha256').update(process.env.AVH_TEST_TOKEN ?? '').digest('hex'))";
  const command = { argv: [process.execPath, '-e', check], cwd: runDirectory, env: {}, secretEnv, runDirectory, runner: 'node',
    sandbox: 'scan', writable: [runDirectory], readonlyGitPaths: [], network: true, projectDirectory: runDirectory, harnessHome: h,
    ...(windows ? { helperExecutable: windowsHelper() } : {}) };
  const file = join(runDirectory, 'command.json');
  writeFileSync(file, JSON.stringify(command));
  const wrapper = fileURLToPath(new URL('../../src/exec/unit-wrapper.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [wrapper, file], { encoding: 'utf8', timeout: 60_000 });
  const read = (name: string) => existsSync(join(runDirectory, name)) ? readFileSync(join(runDirectory, name), 'utf8') : '';
  return { result, stdout: read('stdout.log'), stderr: read('stderr.log'), exit: JSON.parse(read('exit.json') || 'null'),
    command: read('command.json') };
}
const helperReady = !windows || (() => { try { windowsHelper(); return true; } catch { return false; } })();

test('the unit wrapper gives the command its credential, which appears nowhere in the Run record',
  { skip: !helperReady && 'the Windows helper is not built (npm run native:build)' }, t => {
    const run = runWrapper(t, { AVH_TEST_TOKEN: 'test-token' }, { 'test-token': 'the-value-XYZ' });
    assert.equal(run.exit?.exit?.code, 0, run.stderr);
    assert.equal(run.stdout, createHash('sha256').update('the-value-XYZ').digest('hex'));
    assert.doesNotMatch(run.command, /the-value-XYZ/);
    assert.match(run.command, /"secretEnv":\{"AVH_TEST_TOKEN":"test-token"\}/);
  });

test('a credential removed before the command starts fails the Run with its name, never a value',
  { skip: !helperReady && 'the Windows helper is not built (npm run native:build)' }, t => {
    const run = runWrapper(t, { AVH_TEST_TOKEN: 'gone' }, { other: 'the-value-XYZ' });
    assert.equal(run.exit?.exit?.code, 127);
    assert.match(run.stderr, /缺少凭据 gone/);
    assert.doesNotMatch(run.stderr + run.stdout, /the-value-XYZ/);
  });
