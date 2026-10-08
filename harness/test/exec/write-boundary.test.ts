import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LinuxWriteBoundary, type WritePolicy } from '../../src/exec/write-boundary.ts';
import { bwrapWritablePaths } from '../../src/exec/sandbox.ts';
import { removeTemp } from '../fixtures/platform.ts';

test('atomic sibling paths do not leave a redundant file mount under their writable directory', t => {
  const root=mkdtempSync(join(tmpdir(),'avh-atomic-mount-'));t.after(()=>removeTemp(root));
  const run=join(root,'run'),face=join(root,'Face');mkdirSync(run);mkdirSync(face);
  const input=join(face,'design.json');writeFileSync(input,'old');
  assert.deepEqual(bwrapWritablePaths(root,run,[],[input,input+'.writing']),[realpathSync(run),realpathSync(face)]);
  assert.deepEqual(bwrapWritablePaths(root,run,[],[input]),[realpathSync(run),realpathSync(input)],'a file-only policy still gets its precise bind');
});

test('WriteBoundary records semantic strength and keeps masked state behind bwrap', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-boundary-'));
  t.after(() => removeTemp(root));
  const run = join(root, 'run'), state = join(root, 'state'), guard = join(run, 'guard');
  mkdirSync(run); mkdirSync(state); mkdirSync(join(guard, 'projects'), { recursive: true });
  const policy: WritePolicy = { project: root, repository: root, runDirectory: run,
    writableRoots: [], writableFiles: [], readonlyWithinWritable: 'git-metadata',
    maskedDirs: [{ path: state, readonlyRebinds: [
      { source: join(guard, 'projects'), target: join(state, 'projects') },
      { source: join(guard, 'settings.json'), target: join(state, 'settings.json') },
      { source: join(guard, 'CLAUDE.md'), target: join(state, 'CLAUDE.md') }], writableFiles: [] }],
    privateTemp: true, network: false, minStrength: 'prevent', owner: 'outer' };
  const boundary = new LinuxWriteBoundary();
  const launch = boundary.spawnOptions(policy, { kind: 'bwrap', strength: 'prevent' },
    { baseline: {}, head: '', writable: [run], readonly: [] });
  assert.deepEqual(launch.writeBoundary, { kind: 'bwrap', strength: 'prevent' });
  assert.equal(launch.stateIsolation?.directory, state);
  assert.equal(launch.stateIsolation?.guardDirectory, guard);
  assert.deepEqual(boundary.probe({ ...policy, maskedDirs: [], owner: 'self' }),
    { kind: 'self', strength: 'prevent' });
});

test('a deterministic tool gets the Runtime\'s own bwrap first; others keep codex first; a refusal names what was tried', () => {
  const calls: string[] = [];
  const boundary = (codex: boolean, bwrap: boolean) => new LinuxWriteBoundary({
    codex: () => { calls.push('codex'); return codex ? { available: true } : { available: false, reason: 'no codex' }; },
    bwrap: () => { calls.push('bwrap'); return bwrap ? { available: true } : { available: false, reason: 'no bwrap' }; } });
  const policy: WritePolicy = { project: '/p', repository: '/p', runDirectory: '/r', writableRoots: [], writableFiles: [],
    readonlyWithinWritable: 'git-metadata', maskedDirs: [], privateTemp: true, network: false, minStrength: 'prevent', owner: 'outer' };
  assert.deepEqual(boundary(true, true).probe({ ...policy, prefer: 'bwrap' }), { kind: 'bwrap', strength: 'prevent' });
  assert.deepEqual(calls.splice(0), ['bwrap'], 'codex is not even probed');
  assert.deepEqual(boundary(true, true).probe(policy), { kind: 'codex', strength: 'prevent' });
  assert.deepEqual(calls.splice(0), ['codex']);
  assert.deepEqual(boundary(true, false).probe({ ...policy, prefer: 'bwrap' }), { kind: 'codex', strength: 'prevent' });
  assert.throws(() => boundary(false, false).probe({ ...policy, prefer: 'bwrap' }), /OS sandbox: bwrap: no bwrap; codex: no codex$/);
  assert.deepEqual(boundary(false, false).probe({ ...policy, minStrength: 'detect' }),
    { kind: 'scan', strength: 'detect', reason: 'codex: no codex; bwrap: no bwrap' });
});
