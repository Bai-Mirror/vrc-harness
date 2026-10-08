import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify } from 'yaml';
import { configBackups, configProblem, restoreNewestLoadableBackup, setAsideConfig } from '../src/config-recovery.ts';
import { removeTemp } from './fixtures/platform.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-recovery-')); t.after(() => removeTemp(root));
  const home = join(root, 'home'), workspace = join(root, 'workspace'), tools = join(root, 'tools'), knowledge = join(root, 'knowledge');
  for (const dir of [join(home, 'config', 'backups'), workspace, join(tools, '审查/perception'), join(knowledge, 'process'), join(root, 'export')])
    mkdirSync(dir, { recursive: true });
  for (const file of ['project_fingerprint.py', 'vpm_baseline_check.py', '审查/perception/strip_audit.py']) writeFileSync(join(tools, file), '');
  writeFileSync(join(knowledge, 'process/synthetic-flow.yaml'), readFileSync(new URL('./fixtures/process.yaml', import.meta.url)));
  writeFileSync(join(knowledge, 'thresholds.yaml'), stringify({ schema: 'thresholds/0.1', version: '1', t: { max_count: { value: 10, unit: 'items', maturity: 'accepted', source: 'test' } } }));
  const good = stringify({ workspaceRoot: workspace, toolRoot: tools, knowledgeRoot: knowledge, exportRoots: [join(root, 'export')],
    knownBodies: [], projectAliases: {}, sampleNames: [], defaultProfile: 'synthetic-flow',
    processDefinitions: { 'synthetic-flow': 'process/synthetic-flow.yaml' }, thresholdsFile: 'thresholds.yaml' });
  const config = join(home, 'config', 'harness.yaml'), backup = (name: string) => join(home, 'config', 'backups', `harness.yaml.${name}`);
  return { home, config, backup, good };
}

test('a broken configuration is replaced by the newest backup that loads, and kept beside it', t => {
  const f = fixture(t);
  writeFileSync(f.backup('2026-09-01T00-00-00-000Z'), f.good);
  writeFileSync(f.backup('2026-09-02T00-00-00-000Z'), 'workspaceRoot: [not a path');
  writeFileSync(f.config, 'unity:\n  editor: Unity\n');
  assert.match(configProblem(f.home) ?? '', /./);
  assert.deepEqual(configBackups(f.home).map(name => name.slice(13, 23)), ['2026-09-02', '2026-09-01']);
  const result = restoreNewestLoadableBackup(f.home);
  assert.equal(result.restored, 'harness.yaml.2026-09-01T00-00-00-000Z', 'a newer backup that does not load is skipped');
  assert.equal(configProblem(f.home), undefined);
  assert.equal(readFileSync(result.keptAs, 'utf8'), 'unity:\n  editor: Unity\n', 'the broken file is kept');
});

test('without a loadable backup the broken configuration stays exactly where it was; setting aside keeps it too', t => {
  const f = fixture(t);
  writeFileSync(f.backup('2026-09-02T00-00-00-000Z'), 'broken: [');
  writeFileSync(f.config, 'broken: {');
  assert.throws(() => restoreNewestLoadableBackup(f.home), /没有一份备份能正常加载/);
  assert.equal(readFileSync(f.config, 'utf8'), 'broken: {');
  const aside = setAsideConfig(f.home);
  assert.equal(existsSync(f.config), false);
  assert.equal(readFileSync(aside, 'utf8'), 'broken: {');
  assert.equal(configProblem(f.home), undefined, 'no configuration means first run, not a problem');
});
