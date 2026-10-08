import { execFileSync, spawnSync, type ExecFileSyncOptions, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { DEFAULT_UNITY_SLOT_WAIT_MS, releaseUnityBatchSlot, unityMachineBatchLockPath, unityMachineBatchSlots,
  waitUnityBatchSlot } from '../../src/exec/unity-batch-lock.ts';
import { defaultWindowsHomeSeeds, WindowsUnityLauncher } from '../../src/exec/windows-unity.ts';

/**
 * Development fixtures start real editors outside the Runtime's step loop, so they take the same machine-level Unity
 * slots the Runtime takes (`src/exec/unity-batch-lock.ts`). Both directions matter: a fixture that started an editor
 * beside an in-flight Run made that Run's Unity step abort with exit code 199, and a Run in flight would otherwise
 * make a fixture fail the same way. Fixtures contend for the same counted slots, so with more than one slot a fixture
 * and a Run can run side by side. Waiting is bounded and says what it waits for, so the suite's stall supervisor sees
 * progress rather than silence.
 *
 * On Windows they also take the Runtime's *launch* path (`WindowsUnityLauncher`): the Low-integrity helper, an own
 * profile with the account's Hub licence seeded, and Low labels on the project. A fixture that started a plain
 * Medium-integrity editor instead is the largest source of "this account's licensing client is a Medium one", and a
 * Medium client refuses Harness's Low-integrity editors on its channel (measured in lane U1; `unity-batch-lock.ts`
 * records the reading), so such a fixture could break a Run that is in flight rather than only itself. Linux keeps the
 * direct start: there is no integrity boundary to apply there, and its flock contract is unchanged.
 */

/** `execFileSync` options plus the directories a fixture's editor additionally needs to write. The Runtime's steps only
 *  ever write their project and Run directory; a fixture may legitimately keep its result or log somewhere else. */
export type UnityEditorFixtureOptions = ExecFileSyncOptions & { writableRoots?: readonly string[] };
export type UnityEditorFixtureSpawnOptions = SpawnSyncOptions & { writableRoots?: readonly string[] };

/** Where a fixture's private profile and logs live. Inside the project so it is removed with it, and so the Low label
 *  the launcher puts on the project covers the profile the editor writes. Exported so a test can assert against the
 *  same name instead of repeating it. */
export const FIXTURE_RUN_DIRECTORY = '.avh-unity-fixture';

/**
 * The Run directory a fixture's editor actually writes through `Avh.RunDir`, so a caller reads the artifacts the
 * editor produced instead of a directory it never wrote.
 *
 * The two platforms differ here, and the difference is not the caller's to choose: on Windows `execUnityEditor`
 * starts the editor through the Runtime launcher (`WindowsUnityLauncher`), which rebinds `AVH_RUN_DIR` to the
 * fixture's own directory inside the project (`FIXTURE_RUN_DIRECTORY`) whatever the caller passed — that directory
 * is the one the Low label and the launcher's cleanup cover, so it is the only one an artifact can land in. On every
 * other platform the editor receives the caller's environment unchanged, so `configured` (the `AVH_RUN_DIR` the
 * caller means) is the directory to read, and `Avh.RunDir`'s own fallback `<project>/_harness/manual-run` applies
 * when the caller set none.
 *
 * Reading one platform's directory on the other is silent: the editor exits 0, and only the later read notices
 * nothing was written.
 */
export function unityFixtureRunDir(project: string, configured?: string): string {
  if (process.platform === 'win32') return join(project, FIXTURE_RUN_DIRECTORY);
  return configured ?? join(project, '_harness', 'manual-run');
}

/** `execFileSync` waits forever without a timeout; the fixtures' own timeouts are shorter where they matter. */
const DEFAULT_FIXTURE_EDITOR_TIMEOUT_MS = 30 * 60_000;

function underUnitySlot<T>(run: () => T, label: string): T {
  const waitMs = Number(process.env.AVH_UNITY_SLOT_WAIT_MS ?? DEFAULT_UNITY_SLOT_WAIT_MS);
  let reported = 0;
  const slot = waitUnityBatchSlot(unityMachineBatchLockPath(), {
    slots: unityMachineBatchSlots(),
    waitMs: Number.isSafeInteger(waitMs) && waitMs > 0 ? waitMs : DEFAULT_UNITY_SLOT_WAIT_MS,
    onWait: waitedMs => {
      if (waitedMs - reported < 30_000) return;
      reported = waitedMs;
      console.log(`[unity-slot] 等待机器级 Unity 槽位 ${Math.round(waitedMs / 1000)}s（${label}）`);
    },
  });
  try { return run(); } finally { releaseUnityBatchSlot(slot); }
}

/** The `-projectPath` a fixture's editor arguments open; on Windows the launcher labels it and rebinds it to its alias. */
function projectArgument(args: readonly string[]): string | undefined {
  const at = args.findIndex(argument => argument.toLowerCase() === '-projectpath');
  return at >= 0 ? args[at + 1] : undefined;
}

/** Copy the account's Hub licence into the fixture's profile, exactly as `runUnitySteps` seeds a step's profile.
 *  Without it a Low-integrity editor never gets past licensing, and with the real profile it could not write its
 *  own caches: both halves are why the fixture now runs on an own profile instead of the person's. */
function seedFixtureHome(isolatedHome: string): void {
  for (const seed of defaultWindowsHomeSeeds()) {
    const from = join(homedir(), seed);
    if (!existsSync(from)) continue;
    const to = join(isolatedHome, seed);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
}

interface FixtureEditorRun { code: number; timedOut: boolean; stdout: string; stderr: string; signal: NodeJS.Signals | null }

/** Run a real editor through the Runtime's Windows launcher: same slot, Low boundary, private profile and cleanup. */
function runEditorConfined(editor: string, args: readonly string[], options?: UnityEditorFixtureOptions): FixtureEditorRun {
  const project = projectArgument(args);
  if (!project || !isAbsolute(project))
    throw new Error('Windows 上测试夹具必须给编辑器一个绝对 -projectPath：低完整性启动路径要标注并重绑该工程');
  const runDir = join(project, FIXTURE_RUN_DIRECTORY), isolatedHome = join(runDir, 'unity-home');
  mkdirSync(join(runDir, 'tmp'), { recursive: true });
  mkdirSync(join(isolatedHome, 'AppData', 'Local', 'Unity'), { recursive: true });
  mkdirSync(join(isolatedHome, 'AppData', 'Roaming'), { recursive: true });
  seedFixtureHome(isolatedHome);
  const timeoutMs = options?.timeout ?? DEFAULT_FIXTURE_EDITOR_TIMEOUT_MS;
  const configuredWait = Number(process.env.AVH_UNITY_SLOT_WAIT_MS ?? DEFAULT_UNITY_SLOT_WAIT_MS);
  const slotWaitMs = Number.isSafeInteger(configuredWait) && configuredWait > 0 ? configuredWait : DEFAULT_UNITY_SLOT_WAIT_MS;
  const launcher = new WindowsUnityLauncher({ runner: editor, editor, lockPath: unityMachineBatchLockPath(), busyExitCode: 5,
    homeSeedFrom: [], projectScratch: [], defaultTimeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)), passEnv: [] });
  const plan = launcher.planArgs([editor, ...args], project, runDir,
    { env: options?.env ?? process.env, writable: options?.writableRoots });
  let reported = 0;
  const result = launcher.launchSync(plan, timeoutMs, { slotWaitMs,
    onSlotWait: waitedMs => { if (waitedMs - reported < 30_000) return; reported = waitedMs;
      console.log(`[unity-slot] 等待机器级 Unity 槽位 ${Math.round(waitedMs / 1000)}s（${editor}）`); } });
  return { ...result, signal: result.timedOut ? 'SIGTERM' : null };
}

/** The shape `execFileSync` throws, so a fixture caller keeps reading `status`, `stdout` and `stderr` as before. */
function editorFailure(editor: string, run: FixtureEditorRun): Error {
  const detail = run.stderr.trim().slice(-2000) || run.stdout.trim().slice(-2000);
  const message = run.timedOut ? `测试夹具启动的 Unity 超过时限被中止：${editor}` : `${editor} 以退出码 ${run.code} 结束（低完整性启动路径）`;
  const error = new Error(detail ? `${message}\n${detail}` : message) as Error & {
    status?: number; stdout?: string; stderr?: string; signal?: string };
  if (!run.timedOut) error.status = run.code;
  error.stdout = run.stdout; error.stderr = run.stderr;
  if (run.timedOut) error.signal = 'SIGTERM';
  return error;
}

/** `execFileSync` for a real editor, under the machine-level Unity slot the Runtime uses. */
export function execUnityEditor(file: string, args: readonly string[], options?: UnityEditorFixtureOptions): string | Buffer {
  if (process.platform !== 'win32') return underUnitySlot(() => execFileSync(file, args as string[], options), file);
  const run = runEditorConfined(file, args, options);
  if (run.code !== 0) throw editorFailure(file, run);
  return run.stdout;
}

/** `spawnSync` for a real editor, under the machine-level Unity slot the Runtime uses. */
export function spawnUnityEditor(file: string, args: readonly string[], options?: UnityEditorFixtureSpawnOptions): SpawnSyncReturns<string | Buffer> {
  if (process.platform !== 'win32') return underUnitySlot(() => spawnSync(file, args as string[], options), file);
  const run = runEditorConfined(file, args, options);
  return { pid: -1, output: [null, run.stdout, run.stderr], stdout: run.stdout, stderr: run.stderr,
    status: run.code, signal: run.signal };
}
