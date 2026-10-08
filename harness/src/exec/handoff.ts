import { existsSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostPlatform, processAlive } from '../host-platform.ts';

interface Handoff { kind: string; holder: string; since: string; pid: number; runId?: string }
interface Stamped { handoff: Handoff; mtimeMs: number }

/**
 * How long a lock file that names no usable pid still counts as held.
 *
 * The lock predates the `pid` field, and a damaged file cannot be trusted to name a live holder, so the file's age
 * has to stand in for one. It is deliberately conservative: a Unity step's own budget is `unity.defaultTimeoutSec`
 * (3600s by default) per step, so a live holder can legitimately keep this lock for hours, while a lock this old
 * cannot belong to one.
 */
export const LEGACY_HANDOFF_MAX_AGE_MS = 24 * 60 * 60_000;

/** A pid that could name a process on this host; a legacy or damaged lock leaves it absent or negative. */
function usablePid(handoff: Handoff): number | undefined {
  return Number.isSafeInteger(handoff.pid) && handoff.pid > 0 ? handoff.pid : undefined;
}

/**
 * The lock file with the modification time that dates it. An unreadable file still yields the conservative
 * `unknown` handoff the previous format used, so a permission problem keeps blocking rather than freeing the lock.
 */
function readStamped(path: string): Stamped | undefined {
  if (!existsSync(path)) return undefined;
  let mtimeMs: number;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return undefined; } // removed between the two calls
  let handoff: Handoff;
  try { handoff = JSON.parse(readFileSync(path, 'utf8')) as Handoff; }
  catch { handoff = { kind: 'unknown', holder: 'unknown', since: '', pid: -1 }; }
  return { handoff, mtimeMs };
}

/** Why a lock left on disk no longer holds the handoff, naming whoever left it behind. */
export interface HandoffReclaim {
  holder: string; pid?: number; since?: string; ageMs: number; reason: 'holder-exited' | 'legacy-age';
}

/**
 * Stale means the process named in the file is gone. Nothing else releases this lock: it is a plain file, so a holder
 * that crashed leaves it behind and it has to be reclaimed by reading the pid back. A holder that is still alive is
 * never displaced, and a lock that names no pid is only reclaimed once it is older than the retention above.
 */
function staleness(stamped: Stamped, now = Date.now()): HandoffReclaim | undefined {
  const { handoff, mtimeMs } = stamped;
  const named = { holder: handoff.holder, pid: usablePid(handoff), since: handoff.since, ageMs: Math.max(0, now - mtimeMs) };
  const pid = named.pid;
  if (pid !== undefined) return processAlive(pid) ? undefined : { ...named, reason: 'holder-exited' };
  return named.ageMs >= LEGACY_HANDOFF_MAX_AGE_MS ? { ...named, reason: 'legacy-age' } : undefined;
}

/**
 * The Unity handoff lock, shared with the legacy script that writes the same file.
 *
 * A holder that dies without releasing it used to block Unity dispatch forever, because the only question asked was
 * whether the file exists. The pid the holder records is what makes the difference: a lock whose pid is gone is
 * reclaimed, a lock whose pid is alive is respected exactly as before.
 */
export class HandoffLock {
  readonly path: string;
  private readonly onReclaim: (reclaim: HandoffReclaim) => void;
  constructor(path: string, onReclaim?: (reclaim: HandoffReclaim) => void) {
    this.path = path;
    this.onReclaim = onReclaim ?? (reclaim => console.error(
      `已回收崩溃残留的 Unity 交接锁 ${this.path}：原持有者 ${reclaim.holder}，` +
      `${reclaim.pid === undefined ? '未记录 pid' : `pid ${reclaim.pid}`}，` +
      `${reclaim.reason === 'holder-exited' ? '该进程已不存在' : `旧格式锁已放置 ${Math.round(reclaim.ageMs / 3_600_000)} 小时`}`));
  }
  /** The lock as it is on disk: held only while a holder that can still be running owns it. Reads, changes nothing. */
  inspect(): { held: boolean; stale?: HandoffReclaim } {
    const stamped = readStamped(this.path);
    if (!stamped) return { held: false };
    const stale = staleness(stamped);
    return stale ? { held: false, stale } : { held: true };
  }
  available(): boolean { return !this.inspect().held; }
  /** What a dispatch gate asks: take a lock whose holder is gone out of the way, then say whether it is free. */
  freeForDispatch(): boolean { this.reclaimStale(); return this.available(); }
  /**
   * Removes a lock whose holder is gone and reports who it displaced; `undefined` when the lock still holds. The file
   * is renamed aside before it is removed: rename is atomic, so two reclaimers cannot both reach the same inode, and
   * the loser never deletes a fresh holder's lock.
   */
  reclaimStale(): HandoffReclaim | undefined {
    const state = this.inspect();
    if (!state.stale) return undefined;
    const aside = `${this.path}.stale-${process.pid}`;
    try { renameSync(this.path, aside); }
    catch { return undefined; } // someone else took it out of the way first
    try { unlinkSync(aside); } catch { /* the rename already moved it aside */ }
    this.onReclaim(state.stale);
    return state.stale;
  }
  acquire(runId: string): void {
    const stamped = readStamped(this.path);
    if (stamped?.handoff.holder === 'harness' && stamped.handoff.kind === 'unity' && stamped.handoff.runId === runId) return;
    if (stamped && !staleness(stamped)) throw new Error(`Unity handoff held by ${stamped.handoff.holder}`);
    if (stamped && !this.reclaimStale()) {
      // The file changed while it was being reclaimed: never overwrite whatever is there now.
      const held = readStamped(this.path);
      if (held) throw new Error(`Unity handoff held by ${held.handoff.holder}`);
    }
    // Exclusive creation prevents replacing another owner's lock.
    hostPlatform.mkdirPrivate(dirname(this.path));
    hostPlatform.writePrivate(this.path, JSON.stringify({ kind: 'unity', holder: 'harness',
      since: new Date().toISOString(), pid: process.pid, runId } satisfies Handoff), { flag: 'wx' });
  }
  release(runId: string): void {
    const current = readStamped(this.path)?.handoff;
    if (current?.holder === 'harness' && current.kind === 'unity' && current.runId === runId)
      unlinkSync(this.path);
  }
}
