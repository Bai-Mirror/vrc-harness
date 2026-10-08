import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The one bounded, link-free local file read shared by every picture the GUI reads back: the face renders inside the
 * project, the recolour candidates and the outfit photos inside one Run directory. Keeping one implementation means a
 * path that a face preview refuses cannot be read through a later picture API, and every reader states whose picture it
 * was (`label`) so the refusal names the right thing to the person.
 */
export function previewFail(label: string, message: string): never { throw new Error(`${label}：${message}`); }

function controlledFsError(label: string, error: unknown): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') previewFail(label, '所需文件已不存在');
  if (code === 'EACCES' || code === 'EPERM') previewFail(label, '没有权限读取所需文件');
  if (code) previewFail(label, '所需文件读取失败');
  throw error;
}

export function checkedPreviewFile(root: string, path: unknown, maxBytes: number, label: string): string {
  if (typeof path !== 'string' || /[\\:\x00-\x1f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))
    previewFail(label, '文件路径无效');
  const base = resolve(root), target = join(base, path);
  try {
  for (let current = base, i = -1; i < path.split('/').length; i++) {
    if (i >= 0) current = join(current, path.split('/')[i]!);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) previewFail(label, '文件路径包含链接');
  }
  const actual = realpathSync(target), location = relative(realpathSync(base), actual);
  if (!location || location.startsWith('..') || resolve(base, location) !== actual) previewFail(label, '文件路径越出允许目录');
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.size > maxBytes) previewFail(label, '文件类型或大小无效');
  return target;
  } catch (error) { return controlledFsError(label, error); }
}

export function previewFile(root: string, path: unknown, maxBytes: number, label: string): Buffer {
  let bytes: Buffer;
  try { bytes = readFileSync(checkedPreviewFile(root, path, maxBytes, label)); }
  catch (error) { return controlledFsError(label, error); }
  if (bytes.length > maxBytes) previewFail(label, '文件过大');
  return bytes;
}
