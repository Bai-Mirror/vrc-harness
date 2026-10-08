import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { applyLabels } from './windows-helper.ts';

/** A short spelling of the same physical project. It grants no filesystem access. */
export interface WindowsUnityProjectAlias {
  project: string;
  path: string;
  container: string;
  nonce: string;
  verify(): void;
  remove(): void;
}

export function sameWindowsUnityProject(left: string, right: string): boolean {
  const physical = (path: string): string => realpathSync(resolve(path)).toLowerCase();
  return physical(left) === physical(right);
}

/** Fresh per launch: stale or foreign links are never reused, and cleanup never walks the target. */
export function createWindowsUnityProjectAlias(project: string, options: {
  profile?: string;
  protect?: (container: string) => void;
} = {}): WindowsUnityProjectAlias {
  let profile = options.profile;
  if (!profile) {
    // Unlike the redirected Unity/Provider environment, userInfo refers to the actual OS account.
    try { profile = userInfo().homedir; } catch { profile = homedir(); }
  }
  if (!isAbsolute(profile)) throw new Error('Unity 短路径缺少本机用户目录');
  const parent = realpathSync(profile), target = realpathSync(project);
  if (!lstatSync(parent).isDirectory() || !lstatSync(target).isDirectory()) throw new Error('Unity 短路径需要真实目录');
  const container = mkdtempSync(join(parent, '.avh-u-'));
  const path = join(container, 'p'), marker = join(container, 'owner.json');
  const nonce = randomUUID();
  const owner = JSON.stringify({ schema: 'unity-project-alias/0.1', nonce, project: target });
  const original = lstatSync(container, { bigint: true });
  let link: ReturnType<typeof lstatSync>;
  const verify = (): void => {
    const current = lstatSync(container, { bigint: true });
    if (current.isSymbolicLink() || !current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino ||
      lstatSync(marker).isSymbolicLink() || readFileSync(marker, 'utf8') !== owner ||
      !lstatSync(path).isSymbolicLink() || !sameWindowsUnityProject(path, target))
      throw new Error('Unity 受管短路径已变化；保留证据，不使用或清理该入口');
    const currentLink = lstatSync(path);
    if (!link || currentLink.dev !== link.dev || currentLink.ino !== link.ino)
      throw new Error('Unity 受管短路径链接已替换；保留证据');
  };
  try {
    if (path.length > 100) throw new Error('本机用户目录仍过长，无法建立 Unity 兼容执行入口');
    (options.protect ?? (directory => applyLabels([{ path: directory, kind: 'medium' }])))(container);
    writeFileSync(marker, owner, { flag: 'wx', mode: 0o600 });
    symlinkSync(target, path, 'junction');
    link = lstatSync(path);
    verify();
  } catch (error) {
    // A partial or interrupted setup is intentionally retained. It is never adopted on a later run.
    throw new Error(`Unity 短执行入口准备失败：${String(error)}`);
  }
  return { project: target, path, container, nonce, verify, remove: () => {
    verify();
    // rmdir on a verified Windows junction unlinks the reparse entry; no recursive deletion is used.
    rmdirSync(path);
    unlinkSync(marker);
    rmdirSync(container);
  } };
}
