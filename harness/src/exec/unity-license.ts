import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { hostPlatform } from '../host-platform.ts';
import { listProcesses } from './windows-helper.ts';
import { projectPathArgument } from './windows-unity.ts';
import { sameWindowsUnityProject } from './windows-unity-alias.ts';

/**
 * Unity's licensing client is one per signed-in account on the whole machine: the named pipe `LicenseClient-<account>`
 * and the global mutex `Unity-LicenseClient-<account>` are shared by every editor the account starts, including one the
 * person opened themselves. When two editors bring a client up at the same time, the loser's channel never appears, it
 * waits out Unity's own 60s timeout and aborts with exit code 199 — before a line of the step's code runs, so the step
 * produced no evidence about the plan at all.
 *
 * Unity's log blames licensing, which is what makes this expensive: a reader goes after the licence while the cause is a
 * second editor. This module recognises the abort from the log and names the editor holding the machine, so the Runtime
 * can wait for it, retry, and otherwise tell the person what to close.
 */

/** Unity's exit code when the licensing client channel never appears. */
export const UNITY_LICENCE_EXIT_CODE = 199;

/**
 * The lines Unity and its licensing client write for this abort. Each was taken from the recorded failure
 * (`docs/zh/工作区/证据/缺陷/19_跨车道Unity争用导致退出码199.md`); nothing here is a guess about Unity's wording.
 */
const LICENCE_MARKERS: RegExp[] = [
  /Timed-out after [\d.]+s, waiting for channel: "?LicenseClient/i,
  /IPC channel to LicensingClient doesn'?t exist/i,
  /Failed to acquire global mutex Unity-LicenseClient/i,
  /Another instance of Unity\.Licensing\.Client is already running/i,
  /Connection attempt to the License Client on channel/i,
];

/** The lines that establish the abort, in file order and deduplicated. */
export function licenceClientEvidence(text: string): string[] {
  const seen = new Set<string>(), found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!LICENCE_MARKERS.some(marker => marker.test(line))) continue;
    const trimmed = line.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    found.push(trimmed.slice(0, 300));
  }
  return found.slice(0, 6);
}

export interface LicenceContention {
  /** The lines that establish it. */
  evidence: string[];
  /** The editor's exit code. */
  exitCode: number;
}

/**
 * Whether this step aborted on the licensing client. Both halves are required: a licensing line alone can appear in a log
 * whose abort was something else, and 199 alone is not specific to licensing. The four-step reading in the recorded
 * failure (exit code, the wait and channel lines, another editor on the machine, the client's own mutex line) is what
 * this keeps, so a step is never diagnosed as contention on one line.
 */
export function licenceContention(options: { exitCode: number; log?: string; clientLog?: string }): LicenceContention | undefined {
  const evidence = licenceClientEvidence(`${options.log ?? ''}\n${options.clientLog ?? ''}`);
  if (!evidence.length) return undefined;
  if (options.exitCode !== UNITY_LICENCE_EXIT_CODE && !/return code\s+199\b/i.test(options.log ?? '')) return undefined;
  return { evidence, exitCode: options.exitCode };
}

export interface UnityCompetitor {
  pid: number;
  name: string;
  commandLine: string;
  /** The project the competitor named, when its command line names one. */
  project?: string;
  kind: 'editor' | 'licensing-client';
}

export interface SeenProcess { pid: number; name: string; commandLine: string | null }

/** Editors and licensing clients visible on this machine. Never throws: a probe is evidence, not a precondition. */
function visibleUnityProcesses(): { editors: SeenProcess[]; clients: SeenProcess[] } {
  try {
    if (process.platform === 'win32')
      return { editors: listProcesses('Unity.exe'), clients: listProcesses('Unity.Licensing.Client.exe') };
    if (process.platform === 'linux') {
      const seen = (pattern: string, name: string): SeenProcess[] => hostPlatform.findProcesses(pattern).map(pid => {
        let commandLine = '';
        try { commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' '); }
        catch { /* exited between the listing and the read */ }
        return { pid, name, commandLine };
      });
      return { editors: seen('Editor/Unity', 'Unity'), clients: seen('Unity.Licensing.Client', 'Unity.Licensing.Client') };
    }
  } catch { /* an unreadable process list must not fail a Unity step */ }
  return { editors: [], clients: [] };
}

export interface UnityContentionProbe {
  /** Editors and licensing clients on this machine that are not this step's own; what a wait waits for. */
  competitors(ownProjects: string[]): UnityCompetitor[];
}

/**
 * Whether an editor's `-projectPath` is one of this step's own projects. A path that cannot be resolved physically is
 * compared as written and otherwise counts as a competitor: an editor we cannot place is reported, not taken for ours.
 */
function isOwnProject(known: string[], value: string): boolean {
  const lexical = (path: string): string => resolve(path).toLowerCase();
  if (known.some(path => lexical(path) === lexical(value))) return true;
  try { return known.some(path => sameWindowsUnityProject(path, value)); }
  catch { return false; }
}

/**
 * The competitors among a process listing: every editor not pointed at one of this step's own projects, and every
 * licensing client (it holds the mutex even when its editor has gone).
 */
export function unityCompetitorsOf(editors: SeenProcess[], clients: SeenProcess[], ownProjects: string[]): UnityCompetitor[] {
  const found: UnityCompetitor[] = [];
  for (const editor of editors) {
    let project: string | undefined, mine = false;
    if (editor.commandLine) {
      const value = projectPathArgument(editor.commandLine);
      if (value !== undefined) { project = value; mine = isOwnProject(ownProjects, value); }
    }
    if (mine) continue;
    found.push({ pid: editor.pid, name: editor.name, commandLine: editor.commandLine ?? '',
      ...(project ? { project } : {}), kind: 'editor' });
  }
  for (const client of clients)
    found.push({ pid: client.pid, name: client.name, commandLine: client.commandLine ?? '', kind: 'licensing-client' });
  return found;
}

/** The live machine: another editor, or a licensing client left over from one, is what the wait waits for. */
export const systemUnityContentionProbe: UnityContentionProbe = {
  competitors(ownProjects: string[]): UnityCompetitor[] {
    const { editors, clients } = visibleUnityProcesses();
    return unityCompetitorsOf(editors, clients, ownProjects);
  },
};

/** One competitor, as a person reads it: what it is and where it points. */
export function describeCompetitor(competitor: UnityCompetitor): string {
  const where = competitor.project && isAbsolute(competitor.project) ? `，工程 ${competitor.project}` : '';
  return `${competitor.kind === 'editor' ? 'Unity 编辑器' : 'Unity 授权客户端'} PID ${competitor.pid}（${competitor.name}${where}）`;
}

export function describeCompetitors(competitors: UnityCompetitor[]): string {
  return competitors.map(describeCompetitor).join('；');
}

/**
 * What the person should do, in the words the Runtime's own failure message carries to the agent and the interface.
 * `waited` is what the step already did on its own — how long it waited and how many launches it spent — so the
 * instruction is not "wait" when the wait has been spent.
 */
export function licenceGuidance(contention: LicenceContention, competitors: UnityCompetitor[],
  waited: { retries: number; waitedMs: number }): string {
  const editors = competitors.filter(item => item.kind === 'editor');
  const clients = competitors.filter(item => item.kind === 'licensing-client');
  const head = '另一个 Unity 正在占用本机按账户共享的授权客户端（Unity 的授权客户端通道连不上，编辑器在运行步骤代码前就以退出码 ' +
    `${contention.exitCode} 中止），所以这次失败不是方案或工程的问题。`;
  const who = editors.length
    ? `占用者：${describeCompetitors(editors)}${clients.length ? `；另有 ${clients.length} 个 Unity 授权客户端进程` : ''}。`
    : clients.length
      ? `没有看到别的 Unity 编辑器，但有 ${clients.length} 个 Unity 授权客户端进程仍在运行（${describeCompetitors(clients)}）。`
      : '这次没有在本机进程列表里看到占用者（可能是别的账户的 Unity，或授权客户端正在退出）。';
  const seconds = Math.round(waited.waitedMs / 1000);
  const done = waited.waitedMs > 0
    ? `Harness 已等待 ${seconds} 秒${waited.retries > 0 ? `并重试 ${waited.retries} 次` : ''}，占用者仍在运行。`
    : 'Harness 没有等到占用者退出。';
  return `${head}${who}${done}需要你做的：关闭上面那个 Unity（或等它结束），再重跑这个 Unity 步骤即可；不用改配置或工程。`;
}
