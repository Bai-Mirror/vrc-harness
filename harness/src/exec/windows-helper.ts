import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPlatform } from '../host-platform.ts';

/**
 * The Windows helper (native/windows, Rust): named Job Objects that supervise a Run like a systemd unit, the restricted
 * Low integrity token that is the Windows write boundary, integrity labels, process command lines and the login
 * autostart entry. Node cannot reach these Win32 APIs itself. See docs/windows-handoff.md.
 */
export const WINDOWS_HELPER_PROTOCOL = 1;
const harnessRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export class WindowsHelperMissing extends Error {}

/**
 * Where the helper is looked for: AVH_WIN_HELPER, then the copy that goes with the code that is running. Running from
 * source prefers `npm run native:build`'s output, so an older copy left in dist/ by a previous build is not used.
 */
export function windowsHelperCandidates(env: NodeJS.ProcessEnv = process.env, root = harnessRoot,
  fromSource = import.meta.url.endsWith('.ts')): string[] {
  const packaged = join(root, 'dist', 'native', 'avh-win.exe'), built = join(root, 'native', 'windows', 'target', 'release', 'avh-win.exe');
  return [env.AVH_WIN_HELPER, ...(fromSource ? [built, packaged] : [packaged, built])].filter((path): path is string => !!path);
}

let verified: string | undefined;
/** The helper's path, checked once per process to speak the protocol this Runtime expects. */
export function windowsHelper(env: NodeJS.ProcessEnv = process.env): string {
  if (verified && existsSync(verified)) return verified;
  const path = windowsHelperCandidates(env).find(candidate => existsSync(candidate));
  if (!path) throw new WindowsHelperMissing('缺少 Windows 辅助程序 avh-win.exe：桌面版自带；从源码运行请先在 harness/ 下执行 npm run native:build（需要 Rust）');
  const result = spawnSync(path, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  let protocol: unknown;
  try { protocol = (JSON.parse(result.stdout) as { protocol?: unknown }).protocol; } catch { /* reported below */ }
  if (result.status !== 0 || protocol !== WINDOWS_HELPER_PROTOCOL)
    throw new WindowsHelperMissing(`Windows 辅助程序无法使用或版本不符（${path}；需要协议 ${WINDOWS_HELPER_PROTOCOL}）：${(result.stderr || String(result.error ?? `exit ${result.status}`)).trim()}`);
  verified = path;
  return path;
}
/** The launcher that starts a program with no window (the login autostart entry), beside the helper. */
export function windowsLauncher(env: NodeJS.ProcessEnv = process.env): string {
  const launcher = join(dirname(windowsHelper(env)), 'avh-win-launch.exe');
  if (!existsSync(launcher)) throw new WindowsHelperMissing(`缺少 ${launcher}`);
  return launcher;
}

export interface HelperResult { status: number | null; stdout: string; stderr: string }
export function runHelper(args: string[], options: SpawnSyncOptions = {}): HelperResult {
  const result = spawnSync(windowsHelper(), args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, ...options });
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: `${result.stderr ?? ''}${result.error ? String(result.error) : ''}` };
}
export function helperJson<T>(args: string[], options: SpawnSyncOptions = {}): T {
  const result = runHelper(args, options);
  if (result.status !== 0) throw new Error(`avh-win ${args[0]}: ${result.stderr.trim() || `exit ${result.status}`}`);
  return JSON.parse(result.stdout) as T;
}

export type JobState = 'running' | 'empty' | 'not_found';
/** A named job's state; undefined when it cannot be read (never taken as proof of anything). */
export function queryJob(name: string): JobState | undefined {
  try { return helperJson<{ state: JobState }>(['query', '--name', name]).state; }
  catch { return undefined; }
}
export function stopJob(name: string, waitMs: number, exitCode = 143): 'stopped' | 'not_found' | 'timeout' | undefined {
  try { return helperJson<{ state: 'stopped' | 'not_found' | 'timeout' }>(['stop', '--name', name, '--wait-ms', String(waitMs),
    '--exit-code', String(exitCode)], { timeout: waitMs + 30_000 }).state; }
  catch { return undefined; }
}

export interface WindowsProcess { pid: number; parentPid: number; name: string; path: string | null; commandLine: string | null }
export function listProcesses(name?: string): WindowsProcess[] {
  return helperJson<WindowsProcess[]>(['procs', ...(name ? ['--name', name] : [])]);
}

/**
 * Integrity labels. `low`: writable by the sandbox; `medium`: read-only inside a Low tree (.git); `private`: hidden from
 * the sandbox; `clear`: back to what the parent gives.
 */
export type LabelKind = 'low' | 'medium' | 'private' | 'clear';
export function applyLabels(entries: Array<{ path: string; kind: LabelKind }>): void {
  if (!entries.length) return;
  const result = runHelper(['label', ...entries.flatMap(entry => [`--${entry.kind}`, entry.path])], { timeout: 600_000 });
  let failures: Array<{ path: string; error?: string }> = [];
  try { failures = (JSON.parse(result.stdout) as Array<{ path: string; ok: boolean; error?: string }>).filter(item => !item.ok); }
  catch { failures = [{ path: entries.map(entry => entry.path).join(', '), error: result.stderr.trim() || `exit ${result.status}` }]; }
  if (result.status !== 0 || failures.length)
    throw new Error(`无法设置完整性标签：${failures.map(item => `${item.path}: ${item.error ?? ''}`).join('; ')}。` +
      '原因是当前进程不能给这个目录写完整性标签——它与“目录能不能写文件”是两件事。常见原因是：' +
      '该卷不支持完整性标签（exFAT、FAT32，或部分网络盘）；安全软件拦截了这次修改；' +
      '目录 ACL 只给了继承的“修改”权限、缺少写所有者（WRITE_OWNER）权限，或当前进程的令牌没有改写安全标签的权限（SeRelabelPrivilege）。' +
      '可以这样做：在失败目录的属性 → 安全 → 高级中确认当前账户拥有“完全控制”；' +
      '把工程和 Harness 数据放在本地 NTFS 卷上（HOME 推荐 %LOCALAPPDATA%\\avh）；检查安全软件是否拦截这次修改。' +
      'Harness 不会自动更改原目录权限；若仍失败，请保留上面的系统错误供排查。');
}
/** The path's mandatory label in SDDL, e.g. `S:AI(ML;OICI;NW;;;LW)`; empty when it has none. */
export function labelOf(path: string): string {
  const sddl = helperJson<Array<{ label?: string; error?: string }>>(['label', '--get', path])[0]?.label ?? '';
  return sddl.includes('(ML;') ? sddl : '';
}

/**
 * Labels are persistent file-system state, so every change is written down first in a ledger, and whoever finishes the
 * work that needed them, normally or by cancellation, clears what the ledger lists. Ledgers live in AVH_HOME/state,
 * which a sandboxed process can neither read nor write: a ledger it could edit would let it choose what Harness clears.
 */
interface Ledger { owner: string; low: string[]; medium: string[] }
function ledgerDirectory(home: string): string { return join(home, 'state', 'labels'); }
function ledgerFile(home: string, owner: string): string {
  return join(ledgerDirectory(home), `${createHash('sha256').update(resolve(owner).toLowerCase()).digest('hex').slice(0, 32)}.json`);
}
/** Label `low` writable and `medium` read-only for the work done in `owner` (a Run directory, a check's scratch). */
export function labelWithLedger(home: string, owner: string, low: string[], medium: string[] = []): void {
  hostPlatform.mkdirPrivate(ledgerDirectory(home));
  const file = ledgerFile(home, owner);
  const previous: Ledger = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Ledger : { owner: resolve(owner), low: [], medium: [] };
  hostPlatform.writePrivate(file, JSON.stringify({ owner: previous.owner, low: [...new Set([...previous.low, ...low])],
    medium: [...new Set([...previous.medium, ...medium])] } satisfies Ledger));
  applyLabels([...low.map(path => ({ path, kind: 'low' as const })), ...medium.map(path => ({ path, kind: 'medium' as const }))]);
}
/** Clear the labels of every ledger whose work was done at or below `within` (read-only ones first), then drop them. */
export function releaseLedgers(home: string, within: string): void {
  const directory = ledgerDirectory(home);
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory).filter(entry => entry.endsWith('.json'))) {
    const file = join(directory, name);
    let recorded: Ledger;
    try { recorded = JSON.parse(readFileSync(file, 'utf8')) as Ledger; } catch { continue; }
    if (!recorded.owner || !hostPlatform.within(within, recorded.owner)) continue;
    applyLabels([...recorded.medium, ...recorded.low].filter(path => existsSync(path)).map(path => ({ path, kind: 'clear' as const })));
    rmSync(file, { force: true });
  }
}
/** Ledgers still open: labels whose work never finished (a crash, a killed Runtime). */
export function openLedgers(home: string): Ledger[] {
  const directory = ledgerDirectory(home);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(entry => entry.endsWith('.json')).flatMap(name => {
    try { return [JSON.parse(readFileSync(join(directory, name), 'utf8')) as Ledger]; } catch { return []; }
  });
}

/** A check's job name: stable, so another process can stop the check (cancelChecks) or tell whether it still runs. */
export function checkJobName(runDirectory: string, name: string): string {
  return `avh-check-${createHash('sha256').update(`${resolve(runDirectory)}\0${name}`).digest('hex').slice(0, 24)}`;
}
/** The job doing a ledger's work: a check's scratch is `<Run>/checks/<name>`; any other owner is a Run's (or unit's) directory. */
function ledgerJob(owner: string): string | undefined {
  const name = basename(owner), parent = dirname(owner);
  if (basename(parent) === 'checks') return checkJobName(dirname(parent), name);
  return /^[A-Za-z0-9_-]+$/.test(name) ? `avh-run-${name}` : undefined;
}
/**
 * Clear what work that ended without releasing its labels left behind: the Runtime or the computer went down during a
 * Run, and the project stayed writable to every Low process. A ledger counts as live, and keeps its labels, while its
 * job runs, while that cannot be told, and for `graceMs` after it was written (its job may not have started yet). A
 * path that live work also labelled keeps its label. Returns the owners whose ledgers were closed.
 */
export function releaseStaleLedgers(home: string, graceMs = 10 * 60_000,
  jobState: (name: string) => JobState | undefined = queryJob): string[] {
  const directory = ledgerDirectory(home);
  if (!existsSync(directory)) return [];
  const ledgers = readdirSync(directory).filter(entry => entry.endsWith('.json')).flatMap(name => {
    const file = join(directory, name);
    try {
      const recorded = JSON.parse(readFileSync(file, 'utf8')) as Ledger, job = ledgerJob(recorded.owner);
      const ended = !!job && Date.now() - statSync(file).mtimeMs >= graceMs && ['empty', 'not_found'].includes(jobState(job) ?? 'unknown');
      return [{ file, recorded, ended }];
    } catch { return []; }
  });
  const key = (path: string) => resolve(path).toLowerCase();
  const live = new Set(ledgers.filter(ledger => !ledger.ended).flatMap(ledger => [...ledger.recorded.low, ...ledger.recorded.medium]).map(key));
  const released: string[] = [];
  for (const { file, recorded } of ledgers.filter(ledger => ledger.ended)) {
    applyLabels([...recorded.medium, ...recorded.low].filter(path => existsSync(path) && !live.has(key(path)))
      .map(path => ({ path, kind: 'clear' as const })));
    rmSync(file, { force: true });
    released.push(recorded.owner);
  }
  return released;
}
