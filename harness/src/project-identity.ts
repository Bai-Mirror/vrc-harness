import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const key = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
/** Removed historical locations are not identities of a present directory; other IO errors remain errors. */
function samePhysicalLocation(stored: string, current: string): boolean {
  if (!isAbsolute(stored)) return false;
  try { return key(realpathSync(stored)) === key(realpathSync(current)); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}
/** Call while holding the caller's write transaction when selecting an identity for new state. */
export function physicalWorkspace(db: DatabaseSync, directory: string): { id: string; path: string } | undefined {
  const rows = (db.prepare('SELECT id, path FROM workspace').all() as Array<{ id: string; path: string }>)
    .filter(row => samePhysicalLocation(row.path, directory));
  if (rows.length > 1) throw new Error('同一工作区有多个已登记身份，不能自动选择或合并');
  return rows[0];
}
export function physicalProject(db: DatabaseSync, workspaceId: string, workspace: string, directory: string): { id: string; path: string } | undefined {
  const rows = (db.prepare('SELECT id, path FROM project WHERE workspace_id = ?').all(workspaceId) as Array<{ id: string; path: string }>)
    .filter(row => samePhysicalLocation(isAbsolute(row.path) ? row.path : resolve(workspace, row.path), directory));
  if (rows.length > 1) throw new Error('同一工程有多个已登记身份，不能自动选择或合并');
  return rows[0];
}
