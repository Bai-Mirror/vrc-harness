import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, openSync, readdirSync, renameSync, rmdirSync,
  rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DatabaseSync } from 'node:sqlite';
import { hostPlatform } from '../host-platform.ts';
import { parseClue, type RemoteClue } from './remote.ts';

/**
 * The global immutable version pool (docs/zh/dev0.1升级规划方案.md §5). Bytes are stored once per sha256 at
 * <materialized root>/pool/<first two hex digits>/<sha256>/<file name>, read-only and never modified. Plans pin a
 * version by its sha256 and Workflow manifests name its path; the file name stays so tools can tell a .zip from a
 * .unitypackage. `source` records where bytes came from: `booth` bytes are a cache that BOOTH can serve again, `local`
 * (imports, still to come) are the only copy and are kept. Bytes are deleted only on an explicit request, and only
 * when nothing needs them.
 */
export const POOL_DIR = 'pool';
export function poolDirectory(root: string): string { return join(root, POOL_DIR); }
export type PoolSource = 'booth' | 'local';
const now = (): string => new Date().toISOString();

/** A file name that is valid on Windows and Linux, keeps its extension, and keeps the pool path reasonably short. */
export function poolFileName(name: string): string {
  let clean = basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim();
  if (!clean || clean === '.' || clean === '..') clean = 'file';
  const ext = extname(clean).slice(0, 20);
  let stem = clean.slice(0, clean.length - extname(clean).length);
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem)) stem = `_${stem}`;
  const chars = Array.from(stem);
  if (chars.length + ext.length > 100) stem = chars.slice(0, 100 - ext.length).join('');
  return `${stem}${ext}`;
}
export function blobPath(root: string, sha256: string, name: string): string {
  return join(poolDirectory(root), sha256.slice(0, 2), sha256, poolFileName(name));
}

/** SHA-256 of a file, streamed so a large package does not stall the Runtime; undefined when the file is not there. */
export async function hashFile(path: string): Promise<string | undefined> {
  const hash = createHash('sha256');
  try { for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer); }
  catch (error) { if (['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
  return hash.digest('hex');
}

export interface Received { partial: string; sha256: string; bytes: number }
/** Stream a download into a private partial file inside the pool, hashing it on the way; the caller stores or drops it. */
export async function receive(root: string, body: ReadableStream<Uint8Array>): Promise<Received> {
  const directory = join(poolDirectory(root), '.partial');
  hostPlatform.mkdirPrivate(directory);
  const partial = join(directory, `${randomUUID()}.part`);
  const hash = createHash('sha256');
  let bytes = 0;
  const count = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); bytes += chunk.length; done(null, chunk); } });
  const fd = openSync(partial, 'wx', 0o600);
  try {
    try { await pipeline(Readable.fromWeb(body as never), count, createWriteStream(partial, { fd, autoClose: false })); fsyncSync(fd); }
    finally { try { closeSync(fd); } catch { /* A failed stream may have closed it already; keep the original error. */ } }
  } catch (error) { rmSync(partial, { force: true }); throw error; }
  return { partial, sha256: hash.digest('hex'), bytes };
}
/** Partial files a crash left behind; one materialization runs at a time, so anything older than a day is abandoned. */
export function dropStalePartials(root: string, olderThanMs = 24 * 3600_000): void {
  const directory = join(poolDirectory(root), '.partial');
  let names: string[];
  try { names = readdirSync(directory); } catch { return; }
  for (const name of names) {
    const path = join(directory, name);
    try { if (Date.now() - statSync(path).mtimeMs > olderThanMs) rmSync(path, { force: true }); } catch { /* gone already */ }
  }
}

/**
 * Make received bytes the pool's copy of their sha256, and run `record` (version rows, pins) in the same transaction,
 * so a removal cannot slip in between. A present, intact copy is kept and the new one dropped: shared bytes are never
 * overwritten. A missing or damaged copy is replaced by the received bytes, which hash to the same sha256.
 */
export async function storeReceived(db: DatabaseSync, root: string, received: Received, name: string, source: PoolSource,
  record: (path: string) => void): Promise<string> {
  const lookup = () => db.prepare('SELECT path, status FROM pool_blob WHERE sha256 = ?').get(received.sha256) as
    { path: string; status: string } | undefined;
  const before = lookup();
  // Hash outside the transaction: a large file takes seconds, and the scheduler writes to the same database.
  const intact = before && before.status !== 'removed' && await hashFile(before.path) === received.sha256;
  let kept = false, path = '';
  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const row = lookup();
    if (row && intact && row.status !== 'removed' && row.path === before!.path) {
      path = row.path; kept = true;
      db.prepare(`UPDATE pool_blob SET status = 'ready', verified_at = ? WHERE sha256 = ?`).run(now(), received.sha256);
    } else {
      // A removed or damaged blob comes back where it was: a frozen Workflow manifest may name that path.
      path = row?.path ?? blobPath(root, received.sha256, name);
      hostPlatform.mkdirPrivate(dirname(path));
      if (existsSync(path)) chmodSync(path, 0o600);
      renameSync(received.partial, path);
      chmodSync(path, 0o400);
      db.prepare(`INSERT INTO pool_blob (sha256, byte_size, path, source, retention, status) VALUES (?, ?, ?, ?, ?, 'ready')
        ON CONFLICT(sha256) DO UPDATE SET status = 'ready', removed_at = NULL, verified_at = excluded.verified_at,
          retention = CASE WHEN excluded.retention = 'keep' THEN 'keep' ELSE pool_blob.retention END`)
        .run(received.sha256, received.bytes, path, source, source === 'local' ? 'keep' : 'cache');
    }
    record(path);
    db.exec('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) { try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ } }
    rmSync(received.partial, { force: true });
    throw error;
  }
  if (kept) rmSync(received.partial, { force: true });
  return path;
}

/** Whether a blob's bytes are here and still hash to its sha256, as recorded on the blob. Returns its path when they do. */
export async function verifyBlob(db: DatabaseSync, sha256: string): Promise<string | undefined> {
  const row = db.prepare('SELECT path, status FROM pool_blob WHERE sha256 = ?').get(sha256) as { path: string; status: string } | undefined;
  if (!row || row.status === 'removed') return undefined;
  const actual = await hashFile(row.path);
  const status = actual === sha256 ? 'ready' : actual === undefined ? 'missing' : 'corrupt';
  db.prepare(`UPDATE pool_blob SET status = ?, verified_at = ? WHERE sha256 = ? AND status <> 'removed'`).run(status, now(), sha256);
  return status === 'ready' ? row.path : undefined;
}

export interface PoolVersion { downloadableId: string; itemId: string | null; itemName: string | null; filename: string; byteSize: number;
  remote: RemoteClue | null; fetchedAt: string; seenAt: string }
export interface PoolPlanReference { planId: string; projectId: string; status: string; pinnedAt: string; materializedAt: string | null }
export interface PoolWorkflowReference { workflowId: string; projectId: string; status: string }
export interface PoolEntry {
  sha256: string; byteSize: number; path: string; source: PoolSource; retention: 'cache' | 'keep'; pinned: boolean;
  status: 'ready' | 'corrupt' | 'missing' | 'removed'; storedAt: string; verifiedAt: string; removedAt: string | null;
  versions: PoolVersion[]; plans: PoolPlanReference[]; workflows: PoolWorkflowReference[];
  /** archive: a plan that is not released pins it (the project's archive records it); delivery: a Workflow that is not
   *  cancelled was frozen with it as input. */
  needed: { archive: boolean; delivery: boolean };
  removable: boolean;
  /** Why the bytes stay, in words for people; empty when removable. */
  blockers: string[];
}
const PLAN_STATUS: Record<string, string> = { draft: '草稿', validated: '已校验', materializing: '获取中', ready: '已就绪', failed: '获取失败',
  released: '已释放' };
const WORKFLOW_STATUS: Record<string, string> = { active: '制作中', upload_ready: '待上传', client_verified: '已交付' };
const pathKey = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

/** Paths named as inputs by the frozen manifests of Workflows, with the Workflows that name them. */
function manifestInputs(db: DatabaseSync): Map<string, PoolWorkflowReference[]> {
  const uses = new Map<string, PoolWorkflowReference[]>();
  const rows = db.prepare(`SELECT w.id, w.project_id AS projectId, w.status, d.manifest_json AS manifest FROM workflow w
    JOIN workflow_definition d ON d.workflow_id = w.id WHERE d.manifest_json IS NOT NULL ORDER BY w.rowid`).all() as
    Array<{ id: string; projectId: string; status: string; manifest: string }>;
  for (const row of rows) {
    let manifest: { assets?: Array<{ item?: unknown }>; variants?: Array<{ assets?: Array<{ item?: unknown }> }> };
    try { manifest = JSON.parse(row.manifest); } catch { continue; }
    const items = [...(manifest.assets ?? []), ...(manifest.variants ?? []).flatMap(variant => variant.assets ?? [])]
      .map(asset => asset.item).filter((item): item is string => typeof item === 'string' && item.length > 0);
    for (const item of new Set(items.map(pathKey))) {
      const list = uses.get(item) ?? [];
      if (!list.some(use => use.workflowId === row.id)) list.push({ workflowId: row.id, projectId: row.projectId, status: row.status });
      uses.set(item, list);
    }
  }
  return uses;
}

/** Every version in the pool, with what refers to it and whether its bytes may be removed on request. */
export function poolEntries(db: DatabaseSync): PoolEntry[] {
  const blobs = db.prepare(`SELECT sha256, byte_size AS byteSize, path, source, retention, pinned, status, stored_at AS storedAt,
    verified_at AS verifiedAt, removed_at AS removedAt FROM pool_blob ORDER BY stored_at DESC, sha256`).all() as
    Array<Omit<PoolEntry, 'pinned' | 'versions' | 'plans' | 'workflows' | 'needed' | 'removable' | 'blockers'> & { pinned: number }>;
  const versions = new Map<string, PoolVersion[]>();
  for (const row of db.prepare(`SELECT v.sha256, v.downloadable_id AS downloadableId, f.item_id AS itemId, i.name AS itemName, v.filename,
      v.byte_size AS byteSize, v.remote_version AS remote, v.fetched_at AS fetchedAt, v.seen_at AS seenAt FROM booth_file_version v
      LEFT JOIN booth_file f ON f.downloadable_id = v.downloadable_id LEFT JOIN booth_item i ON i.item_id = f.item_id
      ORDER BY v.fetched_at DESC, v.downloadable_id`).all() as Array<Omit<PoolVersion, 'remote'> & { sha256: string; remote: string }>) {
    const { sha256, remote, ...version } = row;
    versions.set(sha256, [...(versions.get(sha256) ?? []), { ...version, remote: parseClue(remote) ?? null }]);
  }
  const plans = new Map<string, PoolPlanReference[]>();
  for (const row of db.prepare(`SELECT n.sha256, n.plan_id AS planId, p.project_id AS projectId, p.status, n.pinned_at AS pinnedAt,
      n.materialized_at AS materializedAt FROM asset_selection_pin n JOIN asset_selection_plan p ON p.id = n.plan_id
      ORDER BY p.created_at, n.plan_id`).all() as unknown as Array<PoolPlanReference & { sha256: string }>) {
    const { sha256, ...reference } = row;
    const list = plans.get(sha256) ?? [];
    if (!list.some(item => item.planId === reference.planId)) list.push(reference);
    plans.set(sha256, list);
  }
  const inputs = manifestInputs(db);
  return blobs.map(blob => {
    const planRefs = plans.get(blob.sha256) ?? [], workflowRefs = inputs.get(pathKey(blob.path)) ?? [];
    const livePlans = planRefs.filter(plan => plan.status !== 'released');
    const liveWorkflows = workflowRefs.filter(workflow => workflow.status !== 'cancelled');
    const blockers = [
      ...(blob.status === 'removed' ? ['已删除'] : []),
      ...(blob.pinned ? ['已固定保留'] : []),
      ...(blob.retention === 'keep' ? ['本地原件，长期保留'] : []),
      ...livePlans.map(plan => `计划 ${plan.planId.slice(0, 8)}（${PLAN_STATUS[plan.status] ?? plan.status}）锁定了这个版本`),
      ...liveWorkflows.map(workflow => `Workflow ${workflow.workflowId.slice(0, 8)}（${WORKFLOW_STATUS[workflow.status] ?? workflow.status}）以它为输入`),
    ];
    return { ...blob, pinned: Boolean(blob.pinned), versions: versions.get(blob.sha256) ?? [], plans: planRefs, workflows: workflowRefs,
      needed: { archive: livePlans.length > 0, delivery: liveWorkflows.length > 0 }, removable: !blockers.length, blockers };
  });
}

/** Keep a version whatever refers to it, or stop keeping it. */
export function setPoolPin(db: DatabaseSync, sha256: string, pinned: boolean): boolean {
  return db.prepare('UPDATE pool_blob SET pinned = ? WHERE sha256 = ?').run(pinned ? 1 : 0, sha256).changes > 0;
}

export interface RemoveResult { removed: Array<{ sha256: string; byteSize: number }>; kept: Array<{ sha256: string; blockers: string[] }>;
  freedBytes: number; dryRun: boolean }
function emptyTrash(trash: string): void {
  let names: string[];
  try { names = readdirSync(trash); } catch { return; }
  for (const name of names) {
    const path = join(trash, name);
    try { chmodSync(path, 0o600); rmSync(path, { force: true }); } catch { /* still in use; the next removal tries again */ }
  }
}
/** Remove the directories a pool blob leaves empty: its <sha256> directory, then its <aa> directory. */
function pruneBlobDirectories(root: string, path: string): void {
  const pool = poolDirectory(root), shaDirectory = dirname(path), fanout = dirname(shaDirectory);
  if (pathKey(dirname(fanout)) !== pathKey(pool)) return;
  for (const directory of [shaDirectory, fanout]) { try { rmdirSync(directory); } catch { return; } }
}
/**
 * Delete the bytes of the named versions, and only of those nothing needs: not pinned, not a local original, pinned by no
 * plan that is not released, and input to no Workflow that is not cancelled. The decision and the move to the pool's
 * trash happen in one transaction, so a materialization either sees the version gone and fetches it again, or pins it
 * first and keeps it. Version rows stay as history. Never called automatically.
 */
export function removePoolBlobs(db: DatabaseSync, root: string, requested: string[], options: { dryRun?: boolean } = {}): RemoveResult {
  const trash = join(poolDirectory(root), '.trash');
  const result: RemoveResult = { removed: [], kept: [], freedBytes: 0, dryRun: Boolean(options.dryRun) };
  const moved: Array<{ from: string; to: string }> = [];
  emptyTrash(trash);
  db.exec('BEGIN IMMEDIATE');
  try {
    const entries = new Map(poolEntries(db).map(entry => [entry.sha256, entry]));
    for (const sha256 of new Set(requested)) {
      const entry = entries.get(sha256);
      if (!entry) { result.kept.push({ sha256, blockers: ['素材池里没有这个版本'] }); continue; }
      if (!entry.removable) { result.kept.push({ sha256, blockers: entry.blockers }); continue; }
      if (!hostPlatform.within(root, entry.path)) { result.kept.push({ sha256, blockers: ['文件不在 Harness 的素材目录里，不由 Harness 删除'] }); continue; }
      if (!options.dryRun && existsSync(entry.path)) {
        hostPlatform.mkdirPrivate(trash);
        const to = join(trash, `${sha256}-${randomUUID().slice(0, 8)}`);
        try { renameSync(entry.path, to); moved.push({ from: entry.path, to }); }
        catch (error) {
          result.kept.push({ sha256, blockers: [`文件无法移走（${(error as NodeJS.ErrnoException).code ?? '未知错误'}），可能正被其他程序使用`] });
          continue;
        }
      }
      if (!options.dryRun) db.prepare(`UPDATE pool_blob SET status = 'removed', removed_at = ? WHERE sha256 = ?`).run(now(), sha256);
      result.removed.push({ sha256, byteSize: entry.byteSize });
      result.freedBytes += entry.byteSize;
    }
    db.exec(options.dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    for (const { from, to } of moved) { try { renameSync(to, from); } catch { /* stays in the trash */ } }
    throw error;
  }
  for (const { from } of moved) pruneBlobDirectories(root, from);
  emptyTrash(trash);
  return result;
}
