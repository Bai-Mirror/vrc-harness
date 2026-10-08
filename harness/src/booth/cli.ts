import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '../api/client.ts';
import { avhHome, loadConfig } from '../config.ts';
import { hostPlatform } from '../host-platform.ts';
import { openDatabase } from '../state/db.ts';
import { releaseSelectionPlan } from './catalog.ts';
import { poolEntries, removePoolBlobs, setPoolPin, type PoolEntry } from './pool.ts';
import type { SyncProgress, SyncResult } from './sync.ts';

/**
 * `avh booth …`. A sync goes through the running Runtime service, which runs one BOOTH job at a time at no more than one
 * request per second; the pool commands work on the state database directly and are safe beside a running service
 * (pool.ts decides and moves bytes inside one transaction).
 */
const USAGE = '用法: avh booth sync [--deep] [--json] | booth pool [--json] | booth pool pin|unpin <版本> | booth pool remove <版本>... [--dry-run] | booth plan release <计划 id>';

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}
function noExtra(args: string[]): void { if (args.length) throw new Error(`未知参数: ${args.join(' ')}`); }
export function sizeText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '大小未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return unit ? `${value.toFixed(1)} ${units[unit]}` : `${bytes} B`;
}
function database() {
  const config = loadConfig();
  hostPlatform.mkdirPrivate(dirname(config.stateDbPath));
  return { db: openDatabase(config.stateDbPath), root: join(config.home, 'materialized') };
}
/** A version named by its sha256 or a unique prefix of at least 12 hex digits. */
function versionId(entries: PoolEntry[], typed: string): string {
  const value = typed.toLowerCase();
  if (!/^[0-9a-f]{12,64}$/.test(value)) throw new Error(`版本应写 sha256（至少前 12 位十六进制）: ${typed}`);
  const matches = entries.filter(entry => entry.sha256.startsWith(value));
  if (matches.length !== 1) throw new Error(matches.length ? `版本前缀不唯一: ${typed}` : `素材池里没有这个版本: ${typed}`);
  return matches[0]!.sha256;
}

const STATUS: Record<PoolEntry['status'], string> = { ready: '就绪', corrupt: '校验失败', missing: '文件缺失', removed: '已删除' };
export function poolText(entries: PoolEntry[]): string {
  const live = entries.filter(entry => entry.status !== 'removed'), removable = live.filter(entry => entry.removable);
  const bytes = (list: PoolEntry[]) => list.reduce((sum, entry) => sum + entry.byteSize, 0);
  return ['版本\t大小\t状态\t来源\t引用\t可以删除\t文件',
    ...entries.map(entry => [entry.sha256.slice(0, 12), sizeText(entry.byteSize), STATUS[entry.status],
      `${entry.source === 'booth' ? 'BOOTH' : '本地'}${entry.retention === 'keep' ? '·长期保留' : '·缓存'}${entry.pinned ? '·已固定' : ''}`,
      `计划 ${entry.plans.length} · Workflow ${entry.workflows.length}`,
      entry.removable ? '是' : `否：${entry.blockers.join('；')}`,
      entry.versions.map(version => `${version.downloadableId} ${version.filename}`).join('，') || '—'].join('\t')),
    `共 ${live.length} 个版本，占用 ${sizeText(bytes(live))}；可以删除 ${removable.length} 个，共 ${sizeText(bytes(removable))}`].join('\n');
}

function progressText(progress: SyncProgress): string {
  return progress.phase === 'library' ? `读取素材库：第 ${progress.pages} 页` : `同步：${progress.items}/${progress.itemsTotal} 个商品，已发 ${progress.requests} 次请求`;
}
async function sync(args: string[]): Promise<void> {
  const deep = flag(args, '--deep'), json = flag(args, '--json');
  noExtra(args);
  let client: ApiClient;
  try { client = await ApiClient.connect(avhHome()); }
  catch (error) { throw new Error(`${(error as Error).message}：BOOTH 同步由 Runtime 服务统一执行（每秒最多 1 次请求），先运行 avh service start`); }
  try {
    const started = await client.call<{ startedAt: string }>('booth.sync', { mode: deep ? 'deep' : 'quick' });
    let shown = '';
    type Status = { job: { startedAt: string; progress?: SyncProgress } | null;
      last: { ok: boolean; message: string; finishedAt: string; result?: SyncResult } | null };
    for (;;) {
      await delay(1000);
      const status = await client.call<Status>('booth.status');
      if (status.job?.startedAt === started.startedAt) {
        const line = status.job.progress ? progressText(status.job.progress) : '';
        if (line && line !== shown && !json) { console.error(line); shown = line; }
        continue;
      }
      const last = status.last;
      if (!last || last.finishedAt < started.startedAt) throw new Error('BOOTH 同步已结束，但 Runtime 没有给出结果（可能重启过）');
      if (json) console.log(JSON.stringify({ ok: last.ok, message: last.message, result: last.result ?? null }, null, 2));
      else {
        console.log(last.message);
        const probes = Object.entries(last.result?.probes ?? {}).sort((a, b) => b[1] - a[1]);
        for (const [outcome, count] of probes) console.log(`探测\t${outcome}\t${count}`);
      }
      if (!last.ok) process.exitCode = 1;
      return;
    }
  } finally { client.close(); }
}

async function pool(args: string[]): Promise<void> {
  const action = args[0] && !args[0].startsWith('--') ? args.shift()! : 'list';
  const { db, root } = database();
  try {
    if (action === 'list') {
      const json = flag(args, '--json'); noExtra(args);
      const entries = poolEntries(db);
      console.log(json ? JSON.stringify({ root: join(root, 'pool'), entries }, null, 2) : poolText(entries));
    } else if (action === 'pin' || action === 'unpin') {
      const typed = args.shift(); if (!typed) throw new Error(USAGE); noExtra(args);
      const sha256 = versionId(poolEntries(db), typed);
      setPoolPin(db, sha256, action === 'pin');
      console.log(`${action === 'pin' ? '已固定保留' : '已取消固定'}: ${sha256}`);
    } else if (action === 'remove') {
      const dryRun = flag(args, '--dry-run');
      if (!args.length) throw new Error(USAGE);
      const entries = poolEntries(db);
      const result = removePoolBlobs(db, root, args.map(typed => versionId(entries, typed)), { dryRun });
      if (result.removed.length && !dryRun)
        db.prepare(`INSERT INTO event (actor,entity_type,entity_id,action,reason,payload_json) VALUES ('human','booth_pool','pool','removed',?,?)`)
          .run(`removed ${result.removed.length} pool version(s) on request`, JSON.stringify({ removed: result.removed, freedBytes: result.freedBytes }));
      for (const item of result.removed) console.log(`${dryRun ? '可以删除' : '已删除'}\t${item.sha256.slice(0, 12)}\t${sizeText(item.byteSize)}`);
      for (const item of result.kept) console.log(`保留\t${item.sha256.slice(0, 12)}\t${item.blockers.join('；')}`);
      console.log(`${dryRun ? '演练：可以释放' : '已释放'} ${sizeText(result.freedBytes)}`);
      if (result.kept.length && !dryRun) process.exitCode = 1;
    } else throw new Error(USAGE);
  } finally { db.close(); }
}

function plan(command: string | undefined, args: string[]): void {
  if (command !== 'release') throw new Error(USAGE);
  const typed = args.shift(); if (!typed) throw new Error(USAGE); noExtra(args);
  const { db } = database();
  try {
    const matches = (db.prepare('SELECT id FROM asset_selection_plan WHERE id LIKE ? ESCAPE \'\\\'').all(`${typed.replace(/[\\%_]/g, '\\$&')}%`) as
      Array<{ id: string }>).map(row => row.id);
    if (matches.length !== 1) throw new Error(matches.length ? `计划 id 前缀不唯一: ${typed}` : `选择计划不存在: ${typed}`);
    releaseSelectionPlan(db, matches[0]!);
    console.log(`已释放计划 ${matches[0]}：它锁定的版本不再因这个计划保留`);
  } finally { db.close(); }
}

export async function boothCommand(command: string | undefined, args: string[]): Promise<void> {
  if (command === 'sync') await sync(args);
  else if (command === 'pool') await pool(args);
  else if (command === 'plan') plan(args.shift(), args);
  else throw new Error(USAGE);
}
