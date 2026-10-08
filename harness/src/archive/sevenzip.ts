import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostPlatform } from '../host-platform.ts';

/**
 * 7-Zip as the transfer format of a share package, and nothing more: what goes in is decided by the share compiler's
 * explicit list (share.ts). Every call passes fixed arguments; a list file names the members, so no directory glob or
 * wildcard ever selects content (`-spd` turns wildcard matching off, `-r-` recursion).
 */

export interface SevenZipMember {
  /** Member path with `/` separators (7-Zip on Windows prints `\`). */
  path: string;
  directory: boolean;
  size: number;
  /** CRC32 as 7-Zip prints it (8 upper-case hex digits); null for a directory. */
  crc: string | null;
  /** A symbolic or hard link: never accepted in a share package. */
  link: boolean;
}

const MAX_OUTPUT = 512 * 1024 * 1024;
const windows = process.platform === 'win32';

/** The 7-Zip executable, or an explanation of why it cannot be run. */
export function sevenZip(): { command: string; version: string } | { problem: string } {
  const command = hostPlatform.toolCommand('7z');
  const probe = spawnSync(command, [], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (probe.error || probe.status !== 0) return { problem: `找不到可用的 7-Zip（${command}）：分享包用 7z 格式打包与校验，需要先安装 7-Zip` };
  const version = /7-Zip[^\n]*?(\d+\.\d+)/.exec(probe.stdout)?.[1] ?? 'unknown';
  return { command, version };
}
function command(): string {
  const found = sevenZip();
  if ('problem' in found) throw new Error(found.problem);
  return found.command;
}
function run(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command(), args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT, timeout: options.timeoutMs ?? 6 * 3600_000,
    windowsHide: true, ...(options.cwd ? { cwd: options.cwd } : {}) });
  if (result.error) throw new Error(`7-Zip 无法运行：${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Pack exactly the listed members of `cwd` (relative `/` paths: files, and empty directories) into a new 7z archive.
 * Modification times are the only time kept; creation and access times are not stored.
 */
export function pack7z(archive: string, cwd: string, members: string[], listFile: string): void {
  writeFileSync(listFile, `${members.join('\n')}\n`, 'utf8');
  const result = run(['a', '-t7z', archive, '-spd', '-sse', '-scsUTF-8', '-sccUTF-8', '-r-', '-mx=5', '-mtc=off', '-mta=off', '-mtm=on',
    '-bd', '-bb0', '-y', `@${listFile}`], { cwd });
  if (result.status !== 0) throw new Error(`7-Zip 打包失败（退出码 ${result.status}）：${lastLines(result.stderr || result.stdout)}`);
}

/** `7z t`: the archive's own integrity check. */
export function test7z(archive: string): { ok: boolean; detail: string } {
  const result = run(['t', '-bd', '-sccUTF-8', archive]);
  const ok = result.status === 0 && /Everything is Ok/.test(result.stdout);
  return { ok, detail: ok ? 'Everything is Ok' : lastLines(result.stderr || result.stdout) };
}

/** Every member of the archive, as 7-Zip lists it. */
export function list7z(archive: string): SevenZipMember[] {
  const result = run(['l', '-slt', '-bd', '-sccUTF-8', archive]);
  if (result.status !== 0) throw new Error(`无法读取压缩包内容（7-Zip 退出码 ${result.status}）：${lastLines(result.stderr || result.stdout)}`);
  return parseListing(result.stdout);
}
/** The technical listing (`l -slt`): one block of `key = value` lines per member after the `----------` line. */
export function parseListing(output: string, onWindows = windows): SevenZipMember[] {
  const text = output.replace(/\r\n/g, '\n');
  const start = text.search(/^-{10,}$/m);
  if (start < 0) return [];
  const members: SevenZipMember[] = [];
  for (const block of text.slice(start).replace(/^-{10,}\n/, '').split(/\n\n+/)) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const at = line.indexOf(' = ');
      if (at > 0) fields.set(line.slice(0, at), line.slice(at + 3));
      else if (line.endsWith(' =')) fields.set(line.slice(0, -2), '');
    }
    const path = fields.get('Path');
    if (path === undefined) continue;
    const attributes = fields.get('Attributes') ?? '';
    const directory = fields.get('Folder') === '+' || /^D/.test(attributes) || / d[rwx-]{9}/.test(attributes);
    const link = / l[rwx-]{9}/.test(attributes) || Boolean(fields.get('Symbolic Link')) || Boolean(fields.get('Hard Link'));
    members.push({ path: onWindows ? path.replaceAll('\\', '/') : path, directory, size: Number(fields.get('Size') || 0),
      crc: fields.get('CRC') ? fields.get('CRC')!.toUpperCase() : null, link });
  }
  return members;
}

/** Extract everything into `target` (an empty, new directory). The caller validates the member list first. */
export function extract7z(archive: string, target: string): void {
  const result = run(['x', '-y', '-bd', '-bb0', '-sccUTF-8', `-o${target}`, archive]);
  if (result.status !== 0) throw new Error(`解压失败（7-Zip 退出码 ${result.status}）：${lastLines(result.stderr || result.stdout)}`);
}

/** One member's bytes (a small document such as share/manifest.json); the caller checks that it is listed. */
export function read7zMember(archive: string, member: string): Buffer {
  const out = execFileSync(command(), ['e', '-so', '-bd', '-spd', '-sccUTF-8', archive, member],
    { maxBuffer: MAX_OUTPUT, timeout: 600_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
}

function lastLines(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).slice(-4).join('；').slice(0, 600);
}
/** Where 7-Zip is expected to write its list file and temporary data for one operation. */
export const listFileIn = (directory: string): string => join(directory, 'members.txt');
