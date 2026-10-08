import { spawnSync } from 'node:child_process';
import { closeSync, constants, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { avhHome, defaultUnityLockPath, defaultUnitySlots } from '../config.ts';

/**
 * The batch slots every Unity run on this computer shares.
 *
 * Unity's licensing client is machine-wide for the signed-in account: the named pipe `LicenseClient-<account>` and the
 * global mutex `Unity-LicenseClient-<account>` are shared by every editor that account starts, whether the person opened
 * it or another Harness home did. Two editors that bring a client up at the same time leave the loser without a channel,
 * and it aborts with exit code 199 after Unity's own 60s timeout, before a single line of the step's code runs.
 *
 * So this lock cannot live under AVH_HOME. When it did, a second install, another worktree and a development fixture
 * each took a different file and serialised nothing: an ad-hoc editor elsewhere on the machine failed an in-flight Run
 * and the log blamed licensing. `defaultUnityLockPath` names one per-account location instead, and both the Runtime and
 * the tests take it through this module.
 *
 * It is a *count* of slots rather than one file (`defaultUnitySlots`), because an already-running client can be shared:
 * measured on Windows, a client a Low-integrity editor started served a second Low editor and a Medium editor at the
 * same time, while a client a Medium editor started refused Low editors outright. Harness starts its editors at Low
 * integrity, so when Harness is first to need a client the account gets a Low one and the slots are all usable. One
 * slot keeps the historical single path, so Linux's flock contract and any configured legacy lock path are unchanged.
 */

/** libuv's UV_FS_O_EXLOCK: open with no sharing, so no other process can open the file while the handle is open. */
export const UNITY_BATCH_EXCLUSIVE_OPEN = 0x10000000;

export interface UnityBatchSlot { fd: number; path: string }

/** The machine-level slot, at the same path `loadConfig` defaults to. Both the Runtime and the tests use this. */
export function unityMachineBatchLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return defaultUnityLockPath(avhHome(env), env);
}

/** How many machine-level slots this machine offers; both the Runtime and the fixtures ask this. */
export function unityMachineBatchSlots(env: NodeJS.ProcessEnv = process.env): number {
  return defaultUnitySlots(env);
}

/**
 * The files a machine-level lock of `slots` slots consists of. The first slot is the base path unchanged, so a
 * single-slot machine (Linux, and every existing configuration) keeps the exact file it had, and a lane still running
 * an older single-slot build contends with the first slot of a newer one instead of locking a different file entirely.
 */
export function unityBatchSlotPaths(base: string, slots: number): string[] {
  const count = Number.isSafeInteger(slots) && slots > 1 ? slots : 1;
  return Array.from({ length: count }, (_, index) => index === 0 ? base : `${base}.${index + 1}`);
}

/**
 * Takes a slot without waiting. `undefined` means every slot is held right now; any other failure throws, because
 * reporting a broken lock as "busy" would hide it as an ordinary wait. The slot's directory is created here: the
 * machine-level path sits outside AVH_HOME, so nothing else on the way in has made it.
 */
export function tryTakeUnityBatchSlot(path: string, slots = 1): UnityBatchSlot | undefined {
  for (const candidate of unityBatchSlotPaths(path, slots)) {
    const slot = tryTakeUnityBatchSlotAt(candidate);
    if (slot) return slot;
  }
  return undefined;
}

function tryTakeUnityBatchSlotAt(path: string): UnityBatchSlot | undefined {
  mkdirSync(dirname(path), { recursive: true });
  return process.platform === 'win32' ? takeWindows(path) : takeLinux(path);
}

function takeWindows(path: string): UnityBatchSlot | undefined {
  try {
    return { fd: openSync(path, constants.O_RDWR | constants.O_CREAT | UNITY_BATCH_EXCLUSIVE_OPEN, 0o600), path };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EBUSY') return undefined;
    throw new Error(`Unity batch lock failed: ${(error as Error).message}`);
  }
}

function takeLinux(path: string): UnityBatchSlot | undefined {
  const fd = openSync(path, 'a', 0o600);
  // flock(2) locks the shared open-file description. Passing it as fd 9 lets this process retain the lock after the
  // helper exits, and uses the same advisory lock as the legacy script's fd 9.
  const stdio: Array<'ignore' | number> = Array(10).fill('ignore');
  stdio[9] = fd;
  const result = spawnSync('flock', ['-n', '9'], { stdio });
  if (result.status === 0) return { fd, path };
  closeSync(fd);
  if (result.status === 1) return undefined;
  throw new Error(`flock failed: ${result.error ?? result.status}`);
}

export function releaseUnityBatchSlot(slot: UnityBatchSlot | undefined): void {
  if (slot) closeSync(slot.fd);
}

/** A synchronous sleep: the callers of `waitUnityBatchSlot` are synchronous test bodies around `execFileSync`. */
function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How long anything outside the Runtime's step loop waits for a slot before it gives up. */
export const DEFAULT_UNITY_SLOT_WAIT_MS = 30 * 60_000;

/**
 * Waits, bounded, for a free slot and returns one taken. A Runtime Unity step does not use this — it reports a busy
 * lock as `busyExitCode` so its own loop can count the wait — but everything else that starts an editor on this machine
 * does (tests, ad-hoc scripts), so work outside the Runtime cannot fail a Run that is in flight.
 */
export function waitUnityBatchSlot(path: string = unityMachineBatchLockPath(), options: {
  slots?: number; waitMs?: number; pollMs?: number; onWait?: (waitedMs: number) => void;
} = {}): UnityBatchSlot {
  const slots = options.slots ?? 1;
  const waitMs = options.waitMs ?? DEFAULT_UNITY_SLOT_WAIT_MS, pollMs = options.pollMs ?? 1000;
  const deadline = Date.now() + Math.max(0, waitMs);
  let waited = 0;
  for (;;) {
    const slot = tryTakeUnityBatchSlot(path, slots);
    if (slot) return slot;
    if (Date.now() >= deadline)
      throw new Error(`等待机器级 Unity 槽位超时：${path}（本机已有 ${slots} 个 Unity 在运行；请先关闭它或等它结束）`);
    const step = Math.min(pollMs, Math.max(1, deadline - Date.now()));
    sleepSync(step);
    waited += step;
    options.onWait?.(waited);
  }
}
