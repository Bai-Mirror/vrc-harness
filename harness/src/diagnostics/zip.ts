import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { dirname, join, relative, sep } from 'node:path';

/**
 * A zip writer and reader for the project diagnostics bundle (D-133). ZIP rather than the share package's 7z:
 * support staff open a diagnostics bundle with whatever unpacker they already have, and the export has to verify
 * every member it just wrote without depending on an external tool being installed.
 *
 * Sizes are kept below 4 GiB and 65 535 members by the bundle's own 20 MB budget, so the 32-bit fields are exact and
 * no ZIP64 record is written. Stored (method 0) entries only: the bundle is text, the size budget is enforced
 * before writing, and a bundle that cannot be decoded by a simple reader is worse than a slightly larger one.
 */

export interface ZipEntry { path: string; bytes: Buffer; mtime?: Date }
const UINT32 = 0xffffffff;

/** CRC-32 as ZIP stores it, unsigned. */
const crc = (bytes: Buffer): number => crc32(bytes) >>> 0;
/** MS-DOS date and time, the only timestamp ZIP's classic header carries. */
function dosTime(when: Date): { date: number; time: number } {
  const year = Math.max(1980, when.getFullYear());
  return { date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2) };
}
/** ZIP stores member names with `/`; a name that is empty, absolute or climbs out is refused rather than stored. */
export function safeMemberPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error(`压缩包成员名不合法：${path}`);
  return normalized;
}

/** One buffer holding the local headers, the data and the central directory. */
export function writeZip(entries: ZipEntry[]): Buffer {
  const now = new Date();
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(safeMemberPath(entry.path), 'utf8');
    const bytes = entry.bytes;
    const stamp = dosTime(entry.mtime ?? now);
    const checksum = crc(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);          // version needed: 2.0, stored
    header.writeUInt16LE(0x0800, 6);      // UTF-8 names
    header.writeUInt16LE(0, 8);           // stored
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);          // made by
    record.writeUInt16LE(20, 6);          // needed
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0, 10);
    record.writeUInt16LE(stamp.time, 12);
    record.writeUInt16LE(stamp.date, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);          // extra
    record.writeUInt16LE(0, 32);          // comment
    record.writeUInt16LE(0, 34);          // disk
    record.writeUInt16LE(0, 36);          // internal attributes
    record.writeUInt32LE(0, 38);          // external attributes
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, directory, end]);
}

/** One member as it was stored, with the integrity facts a re-scan needs. */
export interface ReadMember { path: string; bytes: Buffer; crc: number; declared: number }

/**
 * Read every member of a zip this module wrote. Verification is the point: a truncated or edited archive must fail
 * here rather than pass as evidence, so the central directory, each local header, the declared sizes and the CRC-32
 * all have to agree with the bytes actually present.
 */
export function readZip(archive: Buffer): ReadMember[] {
  const end = findEnd(archive);
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const members: ReadMember[] = [];
  for (let index = 0; index < count; index++) {
    if (at + 46 > archive.length || archive.readUInt32LE(at) !== 0x02014b50) throw new Error('压缩包中央目录损坏，无法核对成员');
    const nameLength = archive.readUInt16LE(at + 28), extraLength = archive.readUInt16LE(at + 30), commentLength = archive.readUInt16LE(at + 32);
    const declared = archive.readUInt32LE(at + 24), expected = archive.readUInt32LE(at + 16);
    const path = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localAt = archive.readUInt32LE(at + 42);
    if (localAt + 30 > archive.length || archive.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`压缩包成员 ${path} 的本地头缺失`);
    const localName = archive.readUInt16LE(localAt + 26), localExtra = archive.readUInt16LE(localAt + 28);
    const from = localAt + 30 + localName + localExtra;
    if (declared === UINT32 || from + declared > archive.length) throw new Error(`压缩包成员 ${path} 的字节不完整`);
    const bytes = Buffer.from(archive.subarray(from, from + declared));
    if (crc(bytes) !== expected) throw new Error(`压缩包成员 ${path} 的校验和不符`);
    members.push({ path, bytes, crc: expected, declared });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}
/** The end-of-central-directory record, found from the tail (a trailing comment would shift it, but this writer stores none). */
function findEnd(archive: Buffer): number {
  for (let at = archive.length - 22; at >= 0 && at > archive.length - 22 - 0xffff; at--)
    if (archive.readUInt32LE(at) === 0x06054b50) return at;
  throw new Error('这个文件不是 zip 压缩包（缺少中央目录结尾记录）');
}

export interface TreeFile { path: string; absolute: string; size: number }
/**
 * Every regular file under `root`, relative with `/`. A symbolic link or a directory junction is reported rather than
 * followed: a bundle copies bytes, and a link would put whatever it points at into the package.
 */
export function walkFiles(root: string, limits: { maxFiles: number; maxBytes: number }): { files: TreeFile[]; links: string[]; truncated: string | null } {
  const files: TreeFile[] = [], links: string[] = [];
  let bytes = 0;
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) { links.push(path); continue; }
      if (entry.isDirectory()) { visit(join(directory, entry.name), `${path}/`); continue; }
      if (!entry.isFile()) { links.push(path); continue; }
      if (files.length >= limits.maxFiles || bytes >= limits.maxBytes) return { truncated: '文件数量或体积超过上限' } as never;
      const absolute = join(directory, entry.name);
      const size = statSync(absolute).size;
      files.push({ path, absolute, size });
      bytes += size;
    }
  };
  let truncated: string | null = null;
  try { visit(root, ''); }
  catch (error) { if (error && typeof error === 'object' && 'truncated' in error) truncated = String((error as { truncated: unknown }).truncated); else throw error; }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, links: links.sort(), truncated };
}

/** Relative path of `absolute` under `root`, with `/`, for a member name. */
export const memberOf = (root: string, absolute: string): string => relative(root, absolute).split(sep).join('/');
/** Write a buffer, creating its directory. */
export function writeFileIn(path: string, bytes: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const handle = openSync(path, 'wx');
  try { writeSync(handle, bytes); } finally { closeSync(handle); }
}
/** Read at most `limit` bytes from the end of a file, with the byte total so a caller can say what it cut. */
export function tailBytes(path: string, limit: number): { bytes: Buffer; total: number } {
  const total = statSync(path).size;
  const bytes = readFileSync(path);
  return { bytes: bytes.length > limit ? bytes.subarray(bytes.length - limit) : bytes, total };
}
