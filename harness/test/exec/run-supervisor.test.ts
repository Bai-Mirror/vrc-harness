import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LinuxRunSupervisor } from '../../src/exec/run-supervisor.ts';
import { removeTemp } from '../fixtures/platform.ts';

test('RunSupervisor keeps unit refs opaque and reads structured exit after restart', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-supervisor-'));
  t.after(() => removeTemp(root));
  const runId = 'synthetic-1', directory = join(root, runId);
  mkdirSync(directory);
  const first = new LinuxRunSupervisor(root);
  const ref = first.refFor(runId);
  assert.equal(first.runId(ref), runId);
  assert.throws(() => first.runId('unexpected'), /Unexpected Run handle/);
  assert.throws(() => first.refFor('invalid/name'), /Invalid Run ID/);
  writeFileSync(join(directory, 'exit.json'), JSON.stringify({ exitStatus: 143,
    exit: { code: 143, signal: 'SIGTERM', timedOut: false, cancelled: true } }));
  assert.deepEqual(new LinuxRunSupervisor(root).recordedExit(runId),
    { code: 143, signal: 'SIGTERM', timedOut: false, cancelled: true });
});

test('a unit in its last moments is not reported as unknown: shutting down is running, a vanished read is read again', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-supervisor-'));
  t.after(() => removeTemp(root));
  const runId = 'exiting-1';
  mkdirSync(join(root, runId));
  type Read = { LoadState: string; ActiveState: string; ControlGroup: string } | undefined;
  const reads = (...sequence: Read[]) => {
    const calls: Read[] = [...sequence];
    return () => calls.length > 1 ? calls.shift() : calls[0];
  };
  const unit = (ActiveState: string): Read => ({ LoadState: 'loaded', ActiveState, ControlGroup: '' });
  const gone: Read = { LoadState: 'not-found', ActiveState: 'inactive', ControlGroup: '' };
  const supervisor = (read: () => Read) => new LinuxRunSupervisor(root, undefined, read);
  const ref = supervisor(reads(gone)).refFor(runId);
  // Main process gone, unit still stopping: nothing to collect yet, and nothing wrong.
  assert.equal(supervisor(reads(unit('deactivating'))).state(ref), 'running');
  writeFileSync(join(root, runId, 'exit.json'), JSON.stringify({ exitStatus: 0 }));
  assert.equal(supervisor(reads(unit('deactivating'))).state(ref), 'running');
  // The unit was collected between two D-Bus reads: the next read finds it gone, and the exit record decides.
  assert.equal(supervisor(reads(undefined, gone)).state(ref), 'exited');
  assert.equal(supervisor(reads(unit('inactive'))).state(ref), 'exited');
  // Reads that keep failing are still unknown: the person has to check the Run.
  assert.equal(supervisor(reads(undefined, undefined, undefined)).state(ref), 'unknown');
});
