import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** The Unity version VRChat avatars are built with; listed first when it is installed. */
export const VRCHAT_UNITY_VERSION = '2022.3.22f1';

/**
 * Unity editors installed through Unity Hub on Linux: Hub's default directory and the second install directory set
 * in Hub (its config directory is ~/.config/unityhub; UnityHub has been seen too). First-run setup offers the first.
 */
export function findUnityEditors(home = homedir(), platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') return findWindowsUnityEditors(env);
  if (platform !== 'linux') return [];
  const roots = [join(home, 'Unity/Hub/Editor')];
  for (const hub of ['unityhub', 'UnityHub']) {
    try {
      const second = JSON.parse(readFileSync(join(home, '.config', hub, 'secondaryInstallPath.json'), 'utf8')) as unknown;
      if (typeof second === 'string' && isAbsolute(second)) roots.push(second);
    } catch { /* Hub not installed, or no second directory set. */ }
  }
  const found = new Set<string>();
  for (const root of roots) {
    let versions: string[];
    try { versions = readdirSync(root); } catch { continue; }
    for (const version of versions) {
      const editor = join(root, version, 'Editor', 'Unity');
      if (!unityEditorProblem(editor)) found.add(editor);
    }
  }
  const preferred = (path: string): number => path.includes(`/${VRCHAT_UNITY_VERSION}/`) ? 0 : 1;
  return [...found].sort((a, b) => preferred(a) - preferred(b) || a.localeCompare(b));
}

/**
 * Unity editors installed through Unity Hub on Windows: Hub's default directory under Program Files and the second
 * install directory set in Hub (%APPDATA%\\UnityHub\\secondaryInstallPath.json, empty when none is set).
 */
export function findWindowsUnityEditors(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>();
  for (const root of windowsUnityRoots(env)) {
    let versions: string[];
    try { versions = readdirSync(root); } catch { continue; }
    for (const version of versions) {
      const editor = join(root, version, 'Editor', 'Unity.exe');
      if (!unityEditorProblem(editor)) found.add(editor);
    }
  }
  const preferred = (path: string): number => path.split(/[\\/]/).includes(VRCHAT_UNITY_VERSION) ? 0 : 1;
  return [...found].sort((a, b) => preferred(a) - preferred(b) || a.localeCompare(b));
}
/** Where Unity Hub installs editors on Windows: its default directory, then the second directory set in Hub. */
export function windowsUnityRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [join(env.ProgramFiles || 'C:\\Program Files', 'Unity', 'Hub', 'Editor')];
  if (env.APPDATA) {
    try {
      const second = JSON.parse(readFileSync(join(env.APPDATA, 'UnityHub', 'secondaryInstallPath.json'), 'utf8')) as unknown;
      if (typeof second === 'string' && isAbsolute(second)) roots.push(second);
    } catch { /* Hub not installed, or no second directory set. */ }
  }
  return roots;
}

/** Why a path cannot serve as the Unity editor, or undefined when it can. */
export function unityEditorProblem(path: string): string | undefined {
  if (!isAbsolute(path)) return 'Unity 编辑器路径必须是绝对路径';
  try {
    const info = statSync(path);
    if (!info.isFile()) return `不是文件：${path}`;
    if (process.platform !== 'win32' && !(info.mode & 0o111)) return `不可执行：${path}`;
  } catch { return `找不到：${path}`; }
  return undefined;
}
