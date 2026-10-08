/**
 * The system file and folder picker, shown by the GUI host for a GUI that runs in a browser (`avh gui`) rather than in the
 * desktop shell, which uses Tauri's dialog plugin instead (gui/src/picker.ts chooses). Locations are chosen, never typed
 * (docs/zh/dev0.1升级规划方案.md §3.4), so this is how the browser GUI learns one. The dialog runs in the person's session,
 * like the rest of the GUI host: Windows' own Explorer dialog through Windows PowerShell, and on Linux zenity (GTK) or
 * kdialog (KDE). Each of them accepts a pasted path. Where none can be shown the error says so: there is no typed fallback.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { hostPlatform } from '../host-platform.ts';
import { encodeCommand, powershellEnv } from '../windows-setup-script.ts';

export interface PickFilter { name: string; extensions: string[] }
export interface PickRequest { kind: 'directory' | 'file'; title: string; filters: PickFilter[]; defaultPath?: string }
/** How a picker process ended: its exit code and output. */
export interface PickerRun { code: number | null; stdout: string; stderr: string }
export type PickerRunner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<PickerRun>;

const CONTROL = /[\u0000-\u001f\u007f]/;
/** A pick request from a GUI call, checked: the dialog's words and filters reach a command line. */
export function pickRequest(params: Record<string, unknown>): PickRequest {
  const kind = params.kind;
  if (kind !== 'directory' && kind !== 'file') throw new Error('选择类型只能是文件夹或文件');
  const title = typeof params.title === 'string' && params.title.trim() && params.title.length <= 120 && !CONTROL.test(params.title)
    ? params.title.trim() : kind === 'directory' ? '选择文件夹' : '选择文件';
  const raw = params.filters === undefined ? [] : params.filters;
  if (!Array.isArray(raw) || raw.length > 8) throw new Error('文件类型筛选无效');
  const filters = raw.map((item): PickFilter => {
    const filter = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const name = filter.name, extensions = filter.extensions;
    if (typeof name !== 'string' || !name.trim() || name.length > 60 || CONTROL.test(name) || /[|;*]/.test(name)
      || !Array.isArray(extensions) || !extensions.length || extensions.length > 16
      || extensions.some(extension => typeof extension !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(extension)))
      throw new Error('文件类型筛选无效');
    return { name: name.trim(), extensions: extensions as string[] };
  });
  if (kind === 'directory' && filters.length) throw new Error('选择文件夹时不能按文件类型筛选');
  // Where the dialog opens: an absolute path the GUI already shows; anything else is ignored rather than refused.
  const start = params.defaultPath;
  const defaultPath = typeof start === 'string' && start.length <= 4096 && isAbsolute(start) && !CONTROL.test(start) ? start : undefined;
  return { kind, title, filters, ...(defaultPath ? { defaultPath } : {}) };
}

/** Glob patterns for a filter, in both cases: GTK's patterns are case-sensitive, and archives often end in .ZIP. */
function patterns(filter: PickFilter): string[] {
  return [...new Set(filter.extensions.flatMap(extension => [`*.${extension.toLowerCase()}`, `*.${extension.toUpperCase()}`]))];
}

/** The Linux dialog for a request: kdialog on KDE when it is there, zenity otherwise, kdialog as the last resort. */
export function linuxPickerCommand(request: PickRequest, tools: { zenity?: string; kdialog?: string }, desktop = ''):
  { file: string; args: string[] } | undefined {
  const kde = /kde/i.test(desktop);
  const zenity = (): { file: string; args: string[] } => ({ file: tools.zenity!, args: ['--file-selection', `--title=${request.title}`,
    ...(request.kind === 'directory' ? ['--directory'] : []),
    // A trailing separator opens a folder itself instead of selecting it in its parent.
    ...(request.defaultPath ? [`--filename=${request.kind === 'directory' && !request.defaultPath.endsWith('/') ? `${request.defaultPath}/` : request.defaultPath}`] : []),
    ...request.filters.map(filter => `--file-filter=${filter.name} | ${patterns(filter).join(' ')}`)] });
  const kdialog = (): { file: string; args: string[] } => ({ file: tools.kdialog!, args: ['--title', request.title,
    ...(request.kind === 'directory' ? ['--getexistingdirectory', request.defaultPath ?? homedir()]
      : ['--getopenfilename', request.defaultPath ?? homedir(),
        ...(request.filters.length ? [request.filters.map(filter => `${patterns(filter).join(' ')}|${filter.name}`).join('\n')] : [])])] });
  if (kde && tools.kdialog) return kdialog();
  if (tools.zenity) return zenity();
  if (tools.kdialog) return kdialog();
  return undefined;
}

/**
 * The Windows dialog: Windows PowerShell compiles a small IFileOpenDialog wrapper (the Explorer dialog, with an address bar
 * that accepts a pasted path) and shows it owned by an invisible topmost window, so it opens above the browser. The request
 * travels as base64 JSON inside the encoded command, and the path comes back as base64 UTF-8: no quoting and no console
 * code page can alter either.
 */
export function windowsPickerScript(request: PickRequest): string {
  const payload = Buffer.from(JSON.stringify({ folder: request.kind === 'directory', title: request.title, start: request.defaultPath ?? '',
    names: request.filters.map(filter => filter.name),
    specs: request.filters.map(filter => filter.extensions.map(extension => `*.${extension}`).join(';')) }), 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    `Add-Type -TypeDefinition @'\n${WINDOWS_DIALOG}\n'@`,
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form',
    "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.FormBorderStyle = 'None'; $owner.Opacity = 0",
    "$owner.StartPosition = 'CenterScreen'; $owner.Width = 1; $owner.Height = 1",
    '$owner.Show(); $owner.Activate()',
    'try { $chosen = [HarnessPicker]::Pick($owner.Handle, [bool]$request.folder, [string]$request.title, [string]$request.start, [string[]]@($request.names), [string[]]@($request.specs)) }',
    'finally { $owner.Close() }',
    "if ($null -eq $chosen) { [Console]::Out.Write('CANCEL') } else { [Console]::Out.Write('PATH:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($chosen))) }",
  ].join('\n');
}
/** C# 5 (what Windows PowerShell's Add-Type compiles): IFileDialog through the FileOpenDialog coclass. */
const WINDOWS_DIALOG = String.raw`using System;
using System.IO;
using System.Runtime.InteropServices;
public static class HarnessPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] private class FileOpenDialogCom {}
  [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, [In, MarshalAs(UnmanagedType.LPArray)] FilterSpec[] filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
    void AddPlace(IShellItem item, int place);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
    void Close(int result);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attributes);
    void Compare(IShellItem other, uint hint, out int order);
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct FilterSpec {
    [MarshalAs(UnmanagedType.LPWStr)] public string Name;
    [MarshalAs(UnmanagedType.LPWStr)] public string Spec;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  private static extern void SHCreateItemFromParsingName([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context,
    [MarshalAs(UnmanagedType.LPStruct)] Guid iid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
  private const uint NoChangeDir = 0x8, PickFolders = 0x20, ForceFileSystem = 0x40, PathMustExist = 0x800, FileMustExist = 0x1000;
  private const uint FileSystemPath = 0x80058000;
  private const int Cancelled = unchecked((int)0x800704C7);
  public static string Pick(IntPtr owner, bool folder, string title, string start, string[] names, string[] specs) {
    IFileDialog dialog = (IFileDialog)new FileOpenDialogCom();
    try {
      uint options;
      dialog.GetOptions(out options);
      dialog.SetOptions(options | NoChangeDir | ForceFileSystem | PathMustExist | (folder ? PickFolders : FileMustExist));
      if (!String.IsNullOrEmpty(title)) dialog.SetTitle(title);
      if (!folder && names != null && names.Length > 0) {
        FilterSpec[] filters = new FilterSpec[names.Length];
        for (int i = 0; i < names.Length; i++) { filters[i].Name = names[i]; filters[i].Spec = specs[i]; }
        dialog.SetFileTypes((uint)filters.Length, filters);
        dialog.SetFileTypeIndex(1);
      }
      if (!String.IsNullOrEmpty(start)) {
        // Open where the current value is: a folder itself, or the folder of a file with its name filled in.
        string where = Directory.Exists(start) ? start : Path.GetDirectoryName(start);
        if (!String.IsNullOrEmpty(where) && Directory.Exists(where)) {
          try { IShellItem item; SHCreateItemFromParsingName(where, IntPtr.Zero, typeof(IShellItem).GUID, out item); dialog.SetFolder(item); }
          catch (Exception) { }
        }
        if (!folder && File.Exists(start)) dialog.SetFileName(Path.GetFileName(start));
      }
      int shown = dialog.Show(owner);
      if (shown == Cancelled) return null;
      if (shown != 0) Marshal.ThrowExceptionForHR(shown);
      IShellItem result;
      dialog.GetResult(out result);
      string path;
      result.GetDisplayName(FileSystemPath, out path);
      return path;
    } finally { Marshal.ReleaseComObject(dialog); }
  }
}`;

/** What the Windows script printed: the chosen path, or null when the person cancelled. */
export function windowsPickerResult(run: PickerRun): string | null {
  const out = run.stdout.trim();
  if (run.code === 0 && out === 'CANCEL') return null;
  const match = /^PATH:([A-Za-z0-9+/=]+)$/.exec(out);
  if (run.code === 0 && match) return Buffer.from(match[1]!, 'base64').toString('utf8');
  // Without a console Windows PowerShell reports progress as CLIXML on stderr; only the error text is kept.
  const reason = run.stderr.replace(/#< CLIXML\s*<Objs[\s\S]*?<\/Objs>/g, '').trim().split('\n').slice(-3).join(' ').slice(-400);
  throw new Error(`没能打开系统选择窗口${reason ? `：${reason}` : ''}`);
}
/** What zenity or kdialog printed: the chosen path, or null when the person cancelled (exit code 1). */
export function linuxPickerResult(run: PickerRun): string | null {
  if (run.code === 1) return null;
  const path = run.stdout.replace(/\r?\n$/, '');
  if (run.code === 0 && path) return path;
  throw new Error(`没能打开系统选择窗口${run.stderr.trim() ? `：${run.stderr.trim().slice(-400)}` : ''}`);
}

// windowsHide: no console window flashes up beside the dialog. It also hides the first window the process shows, which is
// why the Windows script shows its invisible owner window first.
const run: PickerRunner = (file, args, env) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { if (stderr.length < 65_536) stderr += chunk; });
  child.once('error', reject);
  child.once('close', code => resolve({ code, stdout, stderr }));
});

let showing = false;
/**
 * Show the system picker on this computer and resolve to the chosen path, or null when the person cancelled. One at a time:
 * a second request while a dialog is open is refused instead of stacking windows.
 */
export async function pickPathOnHost(request: PickRequest, options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv;
  runner?: PickerRunner; tools?: { zenity?: string; kdialog?: string } } = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env, runner = options.runner ?? run;
  if (showing) throw new Error('已经打开了一个选择窗口，请先在那里选好或取消');
  showing = true;
  try {
    if (platform === 'win32') {
      const result = await runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Sta',
        '-EncodedCommand', encodeCommand(windowsPickerScript(request))], powershellEnv(env));
      return windowsPickerResult(result);
    }
    if (platform === 'linux') {
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY)
        throw new Error('没有图形桌面会话，无法打开系统选择窗口；请在桌面环境里运行 Harness');
      const found = (name: string): string | undefined => { const path = hostPlatform.resolveExecutable(name); return path === name ? undefined : path; };
      const tools = options.tools ?? { zenity: found('zenity'), kdialog: found('kdialog') };
      const command = linuxPickerCommand(request, tools, env.XDG_CURRENT_DESKTOP ?? '');
      if (!command) throw new Error('这台电脑没有可用的系统选择窗口：请安装 zenity（GNOME 等）或 kdialog（KDE），或改用 Harness 桌面版');
      return linuxPickerResult(await runner(command.file, command.args, env));
    }
    throw new Error('这个平台没有接入系统选择窗口；请使用 Harness 桌面版');
  } finally { showing = false; }
}
