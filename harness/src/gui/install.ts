import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { harnessRoot } from '../provenance.ts';
import { windowsLauncher } from '../exec/windows-helper.ts';
import { spawnSync } from 'node:child_process';

function quote(value: string): string { return `"${value.replace(/([\\"`$])/g, '\\$1')}"`; }
export function desktopPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'applications', 'avatar-harness.desktop');
}
export function desktopDocument(node = process.execPath, cli = join(harnessRoot, 'bin', 'avh.js')): string {
  return ['[Desktop Entry]', 'Type=Application', 'Version=1.0', 'Name=Harness', 'Comment=VRChat Avatar workspace',
    `Exec=${quote(node)} ${quote(cli)} gui`, 'Icon=applications-graphics', 'Terminal=false', 'Categories=Graphics;Development;',
    'StartupNotify=true', 'Keywords=VRChat;Avatar;Unity;', ''].join('\n');
}
export function installDesktop(): string {
  if (process.platform === 'win32') return installStartMenuShortcut();
  if (process.platform !== 'linux') throw new Error('桌面入口安装目前只支持 Linux 与 Windows');
  const path=desktopPath(); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,desktopDocument(),{mode:0o644}); chmodSync(path,0o644); return path;
}
export function uninstallDesktop(): boolean {
  const path=process.platform==='win32'?startMenuPath():desktopPath(); if(!existsSync(path))return false;unlinkSync(path);return true;
}

/**
 * Windows: the per-user Start menu, where a shortcut needs no administrator. The desktop installer owns `Harness.lnk`
 * there, so this one has a name of its own and removing it never removes the installed app's.
 */
export function startMenuPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Harness (avh gui).lnk');
}
/**
 * A Start menu shortcut that opens the GUI. It starts node through the helper's launcher, which gives it a console
 * without a window: node itself is a console program, and a shortcut to it would open a console window beside the GUI.
 * The shortcut is written by the Windows Script Host's COM object, with every value passed through the environment.
 */
function installStartMenuShortcut(): string {
  const path = startMenuPath();
  mkdirSync(dirname(path), { recursive: true });
  const script = ['$shell = New-Object -ComObject WScript.Shell', '$link = $shell.CreateShortcut($env:AVH_LINK)',
    '$link.TargetPath = $env:AVH_LINK_TARGET', '$link.Arguments = $env:AVH_LINK_ARGS', '$link.WorkingDirectory = $env:AVH_LINK_DIR',
    "$link.Description = 'Harness'", '$link.Save()'].join('; ');
  const quote = (value: string) => /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  const cli = join(harnessRoot, 'bin', 'avh.js');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
    env: { ...process.env, AVH_LINK: path, AVH_LINK_TARGET: windowsLauncher(), AVH_LINK_DIR: harnessRoot,
      AVH_LINK_ARGS: ['--', process.execPath, cli, 'gui'].map(quote).join(' ') } });
  if (result.status !== 0 || !existsSync(path)) throw new Error(`无法创建开始菜单快捷方式：${(result.stderr || String(result.error ?? '')).trim()}`);
  return path;
}
