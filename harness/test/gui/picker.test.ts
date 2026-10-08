import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  linuxPickerCommand, linuxPickerResult, pickPathOnHost, pickRequest, windowsPickerResult, windowsPickerScript, type PickerRunner,
} from '../../src/gui/picker.ts';
import { guiRoute } from '../../src/gui/server.ts';
import { fakeCommand, removeTemp } from '../fixtures/platform.ts';

const archives = { name: '工程压缩包或 Unity 包', extensions: ['zip', '7z', 'unitypackage'] };
const folder = pickRequest({ kind: 'directory', title: '选择项目工作区', defaultPath: '/home/a/avatar-workspace' });
const file = pickRequest({ kind: 'file', title: '选择要接管的工程压缩包或 Unity 包', filters: [archives] });

test('a pick request is checked before its words reach a command line; a browser GUI asks the host for it', () => {
  assert.equal(guiRoute('setup.pickPath', false), 'setup', 'first run picks folders before a configuration exists');
  assert.equal(guiRoute('setup.pickPath', true), 'setup', 'and the host shows the dialog afterwards too, never the Runtime');
  assert.deepEqual(folder, { kind: 'directory', title: '选择项目工作区', filters: [], defaultPath: '/home/a/avatar-workspace' });
  assert.throws(() => pickRequest({ kind: 'anything' }), /文件夹或文件/);
  assert.throws(() => pickRequest({ kind: 'file', filters: [{ name: 'x | y', extensions: ['zip'] }] }), /筛选无效/);
  assert.throws(() => pickRequest({ kind: 'file', filters: [{ name: 'x', extensions: ['zip;rm'] }] }), /筛选无效/);
  assert.throws(() => pickRequest({ kind: 'directory', filters: [archives] }), /不能按文件类型筛选/);
  assert.equal(pickRequest({ kind: 'file', title: 'bad\ntitle', defaultPath: 'relative/path' }).title, '选择文件', 'a control character falls back');
  assert.equal(pickRequest({ kind: 'file', defaultPath: 'relative/path' }).defaultPath, undefined, 'only an absolute start folder is used');
});

test('Linux: zenity on GNOME and the rest, kdialog on KDE, each opening where the value is and filtering in both cases', () => {
  assert.deepEqual(linuxPickerCommand(folder, { zenity: '/usr/bin/zenity', kdialog: '/usr/bin/kdialog' }, 'ubuntu:GNOME'), { file: '/usr/bin/zenity',
    args: ['--file-selection', '--title=选择项目工作区', '--directory', '--filename=/home/a/avatar-workspace/'] });
  assert.deepEqual(linuxPickerCommand(file, { zenity: '/usr/bin/zenity' })!.args, ['--file-selection', '--title=选择要接管的工程压缩包或 Unity 包',
    '--file-filter=工程压缩包或 Unity 包 | *.zip *.ZIP *.7z *.7Z *.unitypackage *.UNITYPACKAGE']);
  assert.deepEqual(linuxPickerCommand(file, { zenity: '/usr/bin/zenity', kdialog: '/usr/bin/kdialog' }, 'KDE'), { file: '/usr/bin/kdialog',
    args: ['--title', '选择要接管的工程压缩包或 Unity 包', '--getopenfilename', homedir(),
      '*.zip *.ZIP *.7z *.7Z *.unitypackage *.UNITYPACKAGE|工程压缩包或 Unity 包'] });
  assert.deepEqual(linuxPickerCommand(folder, { kdialog: '/usr/bin/kdialog' })!.args, ['--title', '选择项目工作区', '--getexistingdirectory',
    '/home/a/avatar-workspace'], 'kdialog when it is the only one');
  assert.equal(linuxPickerCommand(folder, {}), undefined);
  assert.equal(linuxPickerResult({ code: 0, stdout: '/home/a/工程 A\n', stderr: '' }), '/home/a/工程 A');
  assert.equal(linuxPickerResult({ code: 1, stdout: '', stderr: '' }), null, 'cancelled');
  assert.throws(() => linuxPickerResult({ code: 255, stdout: '', stderr: 'cannot open display' }), /没能打开系统选择窗口：cannot open display/);
});

test('Windows: the Explorer dialog through an encoded script, and the path back as base64 so no code page can alter it', () => {
  const script = windowsPickerScript({ ...file, defaultPath: 'C:\\Users\\a\\工程' });
  const payload = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)![1]!;
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')), { folder: false, title: '选择要接管的工程压缩包或 Unity 包',
    start: 'C:\\Users\\a\\工程', names: ['工程压缩包或 Unity 包'], specs: ['*.zip;*.7z;*.unitypackage'] });
  assert.match(script, /Add-Type -TypeDefinition @'\n[\s\S]*IFileDialog[\s\S]*\n'@/, 'the C# sits in a here-string that closes on its own line');
  assert.match(script, /\$owner\.TopMost = \$true/, 'owned by a topmost window, so it opens above the browser');
  assert.equal(windowsPickerResult({ code: 0, stdout: 'CANCEL', stderr: '' }), null);
  assert.equal(windowsPickerResult({ code: 0, stdout: `PATH:${Buffer.from('D:\\头像\\Luna 工程', 'utf8').toString('base64')}`, stderr: '' }),
    'D:\\头像\\Luna 工程');
  assert.throws(() => windowsPickerResult({ code: 1, stdout: '', stderr: '#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="progress"></Obj></Objs>Add-Type : 编译失败' }),
    /没能打开系统选择窗口：Add-Type : 编译失败/, 'progress records are dropped, the error is kept');
});

test('the host shows one dialog at a time, and says plainly when this computer cannot show one', async () => {
  const calls: Array<[string, string[]]> = [];
  let release!: (value: { code: number; stdout: string; stderr: string }) => void;
  const runner: PickerRunner = (file, args) => { calls.push([file, args]); return new Promise(resolve => { release = resolve; }); };
  const first = pickPathOnHost(folder, { platform: 'linux', env: { DISPLAY: ':0' }, runner, tools: { zenity: '/usr/bin/zenity' } });
  await assert.rejects(pickPathOnHost(folder, { platform: 'linux', env: { DISPLAY: ':0' }, runner, tools: { zenity: '/usr/bin/zenity' } }),
    /已经打开了一个选择窗口/);
  release({ code: 0, stdout: '/home/a/avatar-workspace\n', stderr: '' });
  assert.equal(await first, '/home/a/avatar-workspace');
  assert.equal(calls.length, 1);
  await assert.rejects(pickPathOnHost(folder, { platform: 'linux', env: {}, runner }), /没有图形桌面会话/);
  await assert.rejects(pickPathOnHost(folder, { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, runner, tools: {} }),
    /安装 zenity（GNOME 等）或 kdialog（KDE），或改用 Harness 桌面版/);
  await assert.rejects(pickPathOnHost(folder, { platform: 'darwin', env: {}, runner }), /使用 Harness 桌面版/);
  const windows = pickPathOnHost(file, { platform: 'win32', env: { PSModulePath: 'C:\\pwsh7\\Modules', SystemRoot: 'C:\\Windows' }, runner:
    async (command, args, env) => {
      calls.push([command, args]);
      assert.equal(env.PSModulePath, undefined, 'Windows PowerShell loads its own modules');
      return { code: 0, stdout: 'CANCEL', stderr: '' };
    } });
  assert.equal(await windows, null);
  const [command, args] = calls.at(-1)!;
  assert.equal(command, 'powershell.exe');
  assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Sta', '-EncodedCommand']);
  assert.match(Buffer.from(args.at(-1)!, 'base64').toString('utf16le'), /\[HarnessPicker\]::Pick/);
});

test('Linux: the host starts the dialog program itself and returns what it printed', { skip: process.platform !== 'linux' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'avh-picker-')); t.after(() => removeTemp(dir));
  const zenity = fakeCommand(join(dir, 'zenity'), 'console.log(process.argv.slice(2).join("|")); process.exit(0);');
  const printed = await pickPathOnHost(folder, { platform: 'linux', env: { ...process.env, DISPLAY: ':0' }, tools: { zenity } });
  assert.equal(printed, '--file-selection|--title=选择项目工作区|--directory|--filename=/home/a/avatar-workspace/');
});
