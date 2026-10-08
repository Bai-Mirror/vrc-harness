import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_WINDOWS_UNITY_SLOTS, UNITY_SLOTS_MAX, defaultUnityLockPath, defaultUnitySlots } from '../../src/config.ts';
import { releaseUnityBatchSlot, tryTakeUnityBatchSlot, unityBatchSlotPaths, unityMachineBatchLockPath,
  unityMachineBatchSlots, waitUnityBatchSlot } from '../../src/exec/unity-batch-lock.ts';
import { WindowsUnityLauncher } from '../../src/exec/windows-unity.ts';
import { removeTemp, windows } from '../fixtures/platform.ts';

const temporaryLock = (t: test.TestContext): string => {
  const root = mkdtempSync(join(tmpdir(), 'avh-unity-slot-'));
  t.after(() => removeTemp(root));
  return join(root, 'state', 'unity-batch.lock');
};

test('the batch slot is one file per account outside AVH_HOME on Windows, so separate Homes cannot each start Unity', () => {
  const first = defaultUnityLockPath('C:\\homes\\one', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
  const second = defaultUnityLockPath('C:\\homes\\two', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
  const elsewhere = defaultUnityLockPath('C:\\homes\\one', { LOCALAPPDATA: 'D:\\Other' });
  if (process.platform === 'win32') {
    // The resource it guards is the account-wide licensing client, so one file has to cover every Harness home.
    assert.equal(first, join('C:\\Users\\u\\AppData\\Local', 'avh-unity', 'unity-batch.lock'));
    assert.equal(first, second, 'two Harness homes on one account take the same slot');
    assert.ok(!first.startsWith('C:\\homes'), 'the slot does not live under AVH_HOME');
    assert.notEqual(first, elsewhere, 'another account is a different slot');
  } else {
    // Linux licensing is per install, and the path is part of the legacy flock contract: it stays under the Home.
    assert.equal(first, join('C:\\homes\\one', 'state', 'unity-batch.lock'));
    assert.notEqual(first, second);
  }
});

test('a taken batch slot is refused and released, and waiting for it is bounded', t => {
  const path = temporaryLock(t);
  const held = tryTakeUnityBatchSlot(path);
  assert.ok(held, 'the first taker gets the slot');
  assert.equal(tryTakeUnityBatchSlot(path), undefined, 'a second taker is refused while it is held');
  assert.throws(() => waitUnityBatchSlot(path, { waitMs: 120, pollMs: 20 }), /等待机器级 Unity 槽位超时/,
    'a holder that never releases is reported, not waited on forever');
  // The callback runs while the slot is still held, which is how the Runtime's own step counts a wait.
  const waited: number[] = [];
  const taken = waitUnityBatchSlot(path, { waitMs: 5_000, pollMs: 25, onWait: ms => { waited.push(ms); releaseUnityBatchSlot(held); } });
  assert.ok(taken, 'a holder that releases is followed by a taker');
  assert.ok(waited.length >= 1, 'the wait is observable while it happens');
  releaseUnityBatchSlot(taken);
  const again = tryTakeUnityBatchSlot(path);
  assert.ok(again, 'releasing gives the slot back');
  releaseUnityBatchSlot(again);
});

test('the Runtime launcher and a development fixture contend for the same machine slot',
  { skip: !windows && 'Windows file locking' }, t => {
    const path = temporaryLock(t);
    const launcher = new WindowsUnityLauncher({ runner: 'C:\\Unity.exe', editor: 'C:\\Unity.exe', lockPath: path,
      busyExitCode: 5, homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] });
    // One slot, so this stays the plain exclusion property: the holder and the launcher cannot both have the machine.
    const previous = process.env.AVH_UNITY_SLOTS;
    process.env.AVH_UNITY_SLOTS = '1';
    try {
      const fixture = tryTakeUnityBatchSlot(path, 1);
      assert.ok(fixture, 'the fixture takes the slot the Runtime would take');
      assert.equal(launcher.acquireBatchSlot(), false, 'a fixture holding the only slot keeps the Runtime off it');
      releaseUnityBatchSlot(fixture);
      assert.equal(launcher.acquireBatchSlot(), true, 'and the Runtime starts once the fixture is done');
      launcher.release();
    } finally {
      if (previous === undefined) delete process.env.AVH_UNITY_SLOTS; else process.env.AVH_UNITY_SLOTS = previous;
    }
  });

test('the machine-level lock is a counted set of slots, so several editors hold it at once', t => {
  const path = temporaryLock(t);
  assert.deepEqual(unityBatchSlotPaths(path, 1), [path], 'one slot keeps the historical single file');
  // The first slot stays the base file, so a lane still running a one-slot build contends with the first slot of a
  // two-slot one instead of locking a file nobody else looks at.
  assert.deepEqual(unityBatchSlotPaths(path, 2), [path, `${path}.2`]);
  assert.deepEqual(unityBatchSlotPaths(path, 3), [path, `${path}.2`, `${path}.3`]);
  assert.deepEqual(unityBatchSlotPaths(path, 0), [path], 'a count that is not a count falls back to one slot');
  const first = tryTakeUnityBatchSlot(path, 2), second = tryTakeUnityBatchSlot(path, 2);
  assert.ok(first && second, 'two takers get the two slots');
  assert.notEqual(first.path, second.path, 'the takers hold different files');
  assert.equal(tryTakeUnityBatchSlot(path, 2), undefined, 'a third taker is refused while both slots are held');
  releaseUnityBatchSlot(first);
  const third = tryTakeUnityBatchSlot(path, 2);
  assert.ok(third, 'releasing one slot admits the next taker');
  releaseUnityBatchSlot(second);
  releaseUnityBatchSlot(third);
});

test('the slot count comes from AVH_UNITY_SLOTS, and without it from the platform decision', () => {
  assert.equal(defaultUnitySlots({}), process.platform === 'win32' ? DEFAULT_WINDOWS_UNITY_SLOTS : 1);
  assert.equal(defaultUnitySlots({ AVH_UNITY_SLOTS: '3' }), 3);
  assert.equal(defaultUnitySlots({ AVH_UNITY_SLOTS: '1' }), 1, 'a machine can still insist on one editor at a time');
  assert.equal(unityMachineBatchSlots({ AVH_UNITY_SLOTS: '4', AVH_HOME: 'C:\\homes\\one' }), 4,
    'the Runtime launcher and the development fixtures read the same count');
  for (const bad of ['0', '-1', '2.5', 'many', String(UNITY_SLOTS_MAX + 1)])
    assert.throws(() => defaultUnitySlots({ AVH_UNITY_SLOTS: bad }), /AVH_UNITY_SLOTS/, `${bad} must be refused`);
});

test('the Runtime launcher takes a second slot instead of queueing behind the first editor',
  { skip: !windows && 'Windows file locking' }, t => {
    const path = temporaryLock(t);
    const config = { runner: 'C:\\Unity.exe', editor: 'C:\\Unity.exe', lockPath: path, busyExitCode: 5,
      homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: 10, passEnv: [] };
    const first = new WindowsUnityLauncher(config), second = new WindowsUnityLauncher(config), third = new WindowsUnityLauncher(config);
    const previous = process.env.AVH_UNITY_SLOTS;
    process.env.AVH_UNITY_SLOTS = '2';
    try {
      assert.equal(first.acquireBatchSlot(), true, 'the first editor takes a slot');
      assert.equal(second.acquireBatchSlot(), true, 'the second editor takes the other slot instead of queueing');
      assert.equal(third.acquireBatchSlot(), false, 'a third editor is refused while both slots are held');
    } finally {
      if (previous === undefined) delete process.env.AVH_UNITY_SLOTS; else process.env.AVH_UNITY_SLOTS = previous;
      first.release(); second.release(); third.release();
    }
  });

test('a batch lock file left behind by a crashed holder still gives up the slot', t => {
  const path = temporaryLock(t);
  const created = tryTakeUnityBatchSlot(path);
  assert.ok(created, 'the directory exists once the slot has been taken once');
  releaseUnityBatchSlot(created);
  // The file survives a crash; the slot does not, because the lock is a kernel object — a share-mode handle on
  // Windows, flock(2) on Linux — that the OS drops with the process that held it. Residue on disk must not read as
  // "busy", which is why this slot needs no pid and no staleness rule.
  writeFileSync(path, '');
  const afterEmpty = tryTakeUnityBatchSlot(path);
  assert.ok(afterEmpty, 'an empty lock file left by a crash does not hold the slot');
  releaseUnityBatchSlot(afterEmpty);
  writeFileSync(path, JSON.stringify({ kind: 'unity', holder: 'dead', pid: 999_999 }));
  const afterRecord = tryTakeUnityBatchSlot(path);
  assert.ok(afterRecord, 'a stale lock record at that path does not hold the slot either');
  releaseUnityBatchSlot(afterRecord);
});

test('the machine slot directory is created on the way in, at the path the loader defaults to', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-unity-slot-'));
  t.after(() => removeTemp(root));
  const path = join(root, 'not-yet', 'deeper', 'unity-batch.lock');
  const slot = tryTakeUnityBatchSlot(path);
  assert.ok(slot, 'a first run on a machine has no lock directory yet');
  releaseUnityBatchSlot(slot);
  assert.equal(unityMachineBatchLockPath({ ...process.env, AVH_HOME: join(root, 'home') }),
    defaultUnityLockPath(join(root, 'home'), process.env), 'a fixture takes the file the loader defaults to');
});
