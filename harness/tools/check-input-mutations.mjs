import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mutate disposable copies, so verification cannot race with another test's reads of production sources.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mutations = [
  { name: 'evidence-input-comparison', path: 'src/process/evidence.ts',
    before: 'Object.entries(expectedInputs).every(([kind, hash]) => Boolean(hash) && recordedInputs?.[kind] === hash)',
    after: 'true', test: 'same-byte s1 to s2', failure: /approved.*stale|\x27approved\x27 !== \x27stale\x27/s },
  { name: 'router-snapshot-read', path: 'src/workflow/runtime.ts',
    before: 'input?.plan ?? buildAggregateInput(this.db, row.workflow_id).plan',
    after: 'buildAggregateInput(this.db, row.workflow_id).plan', test: 'intended outbox replay', failure: /\x27s2\x27 !== \x27s1\x27/ },
  { name: 'observer-snapshot-read', path: 'src/workflow/observe.ts',
    before: 'run.inputSnapshot?.plan ?? this.context.plan()', after: 'this.context.plan()',
    test: 'input change during running', failure: /\x27s2\x27 !== \x27s1\x27/ },
  { name: 'manual-content-binding', path: 'builtin/tools/harness/face.py', fixture: 'face-runtime',
    before: 'design.get("manualValuesSha256") == frozen_values_sha == digest(accepted)',
    after: 'design.get("manualValuesSha256") == digest(accepted)',
    test: 'manual readback binds', failure: /true !== false/ },
  { name: 'plan-output-input-revision', path: 'src/runtime/scheduler.ts',
    before: 'resolveWorkflowInput(this.db, this.workflowId, spec.inputSnapshot.workflowInputRevisionId).plan',
    after: 'resolveWorkflowInput(this.db, this.workflowId).plan',
    test: 'new plan output', failure: /\x27s2\x27 !== \x27s1\x27/ },
];
for (const mutation of mutations) {
  const directory = mkdtempSync(join(root, '.input-mutation-'));
  try {
    cpSync(join(root, 'src'), join(directory, 'src'), { recursive: true });
    cpSync(join(root, 'bin'), join(directory, 'bin'), { recursive: true });
    cpSync(join(root, 'package.json'), join(directory, 'package.json'));
    mkdirSync(join(directory, 'checks/workflow'), { recursive: true }); mkdirSync(join(directory, 'checks/fixtures'));
    cpSync(join(root, 'test/fixtures/platform.ts'), join(directory, 'checks/fixtures/platform.ts'));
    const fixture = mutation.fixture === 'face-runtime' ? 'checks/face-runtime.fixture.ts' : 'checks/workflow/input-runtime.fixture.ts';
    cpSync(join(root, mutation.fixture === 'face-runtime' ? 'test/face-runtime.test.ts' : 'test/workflow/input-runtime.test.ts'), join(directory, fixture));
    if (mutation.fixture === 'face-runtime') cpSync(join(root, 'builtin/tools/harness'), join(directory, 'builtin/tools/harness'), { recursive: true });
    const path = join(directory, mutation.path), source = readFileSync(path, 'utf8');
    assert.equal(source.split(mutation.before).length, 2, `Mutation target must be unique: ${mutation.name}`);
    writeFileSync(path, source.replace(mutation.before, mutation.after));
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', `--test-name-pattern=${mutation.test}`,
      join(directory, fixture)], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120000,
      env: { ...process.env, ...(mutation.fixture === 'face-runtime' ? { AVH_TEST_FACE_TOOLS: join(directory, 'builtin/tools/harness') } : {}),
        ...(process.platform === 'win32' ? { AVH_WIN_HELPER: join(root, 'native/windows/target/release/avh-win.exe') } : {}) },
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${mutation.name}: ${result.error}`);
    assert.notEqual(result.status, 0, `Surviving mutation: ${mutation.name}\n${output}`);
    assert.match(output, mutation.failure, `${mutation.name} failed for an unrelated reason:\n${output}`);
    console.log(`${mutation.name}: killed by ${mutation.test} (exit ${result.status})`);
  } finally {
    assert.ok(relative(root, directory).startsWith('.input-mutation-') && dirname(directory) === root);
    rmSync(directory, { recursive: true, force: true });
  }
}
console.log(`Input mutations killed: ${mutations.length}/${mutations.length}`);
