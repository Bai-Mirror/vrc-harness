import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml } from 'yaml';
import { assetsApi } from './api.ts';
import { addNotAvatar, upsertLocalEntry } from './avatars.ts';
import type { ItemSummary } from './catalog.ts';
import { refreshAssetIndex } from './derive.ts';
import type { ReviewItem } from './review.ts';
import type { TaxonomyProposal } from './taxonomy.ts';

/**
 * `avh assets …`: the same catalog the local API serves (assets.*), for the terminal and for scripts. Reads print TSV
 * or, with --json, the API's JSON. Changing the category vocabulary takes a proposal file (operations in JSON, the
 * format assets.taxonomy.propose takes) and a separate apply, so a change is always reviewed before it takes effect.
 */
export const ASSETS_USAGE = 'assets list [--category 分类] [--avatar 角色] [--bucket unknown|universal] [--pending] [--query 词] [--source booth|local] '
  + '[--sort name|listing|acquired|adaptation] [--asc|--desc] [--limit N] [--offset N] [--json] | assets facets [--query 词] [--category 分类] [--top N] [--json] '
  + '| assets show <id> [--json] | assets assign <id> --category <分类|未分类> | assets avatar <id> --confirm|--reject|--add|--clear <角色> '
  + '| assets review [--type category|avatar|dictionary] [--json] | assets review answer <待确认 id> --choice accept|reject|same_as|shares_body [--target 角色] '
  + '| assets taxonomy [--json] | assets taxonomy propose --operations <JSON 文件> --reason 原因 [--by ai|human] | assets taxonomy apply|reject <提案 id> '
  + '| assets dictionary [--json] | assets dictionary import <YAML 文件> | assets refresh [--all]';

function take(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name}: 缺少参数`);
  args.splice(i, 2);
  return value;
}
function has(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}
function done(args: string[]): void { if (args.length) throw new Error(`未知参数: ${args.join(' ')}`); }
function int(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} 应为非负整数`);
  return number;
}
const call = (db: DatabaseSync, method: string, params: Record<string, unknown> = {}): unknown => assetsApi(db, method, params);
const json = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

function adaptation(item: ItemSummary): string {
  const confirmed = item.avatars.filter(tag => tag.status === 'confirmed').map(tag => tag.name);
  const pending = item.avatars.filter(tag => tag.status === 'pending').length;
  const base = confirmed.length ? confirmed.join('、') : { universal: '通用', unknown: '未识别', none: '—', tagged: '' }[item.adaptation];
  return pending ? `${base}（待确认 ${pending}）` : base;
}

export function assetsCommand(command: string | undefined, input: string[], open: () => DatabaseSync): void {
  const args = [...input];
  const db = open();
  try {
    if (command === 'list') {
      const asJson = has(args, '--json'), pending = has(args, '--pending'), asc = has(args, '--asc'), desc = has(args, '--desc');
      const params = { category: take(args, '--category'), avatar: take(args, '--avatar'), bucket: take(args, '--bucket'), query: take(args, '--query'),
        source: take(args, '--source'), sort: take(args, '--sort'), limit: int(take(args, '--limit'), '--limit'), offset: int(take(args, '--offset'), '--offset'),
        ...(pending ? { includePending: true } : {}), ...(asc ? { direction: 'asc' } : desc ? { direction: 'desc' } : {}) };
      done(args);
      const result = call(db, 'assets.items', params) as { total: number; offset: number; items: ItemSummary[]; taxonomyVersion: number; dictionaryVersion: string };
      if (asJson) { json(result); return; }
      console.log(['id\t名称\t分类\t适配角色\t店铺', ...result.items.map(item => [item.id, item.name, item.category?.path ?? '未分类',
        adaptation(item), item.shop].join('\t'))].join('\n'));
      console.log(`# 共 ${result.total} 件；显示第 ${result.items.length ? result.offset + 1 : 0}–${result.offset + result.items.length} 件；分类词表 v${result.taxonomyVersion}，角色字典 ${result.dictionaryVersion}`);
    } else if (command === 'facets') {
      const asJson = has(args, '--json');
      const params = { query: take(args, '--query'), category: take(args, '--category'), top: int(take(args, '--top'), '--top') };
      done(args);
      const result = call(db, 'assets.facets', params) as { categories: { all: number; uncategorized: number; nodes: Array<{ name: string; depth: number; count: number }> };
        avatars: { items: Array<{ name: string; count: number; pending: number }>; more: number; unknown: number; universal: number; pendingItems: number } };
      if (asJson) { json(result); return; }
      console.log([`全部\t${result.categories.all}`, ...result.categories.nodes.map(node => `${'  '.repeat(node.depth - 1)}${node.name}\t${node.count}`),
        `未分类\t${result.categories.uncategorized}`, '', '适配角色\t数量\t待确认',
        ...result.avatars.items.map(item => `${item.name}\t${item.count}\t${item.pending}`),
        ...(result.avatars.more ? [`# 另有 ${result.avatars.more} 个角色`] : []),
        `通用\t${result.avatars.universal}`, `未识别适配\t${result.avatars.unknown}`, `有待确认角色的素材\t${result.avatars.pendingItems}`].join('\n'));
    } else if (command === 'show') {
      const id = args.shift(); if (!id) throw new Error('用法: avh assets show <id>');
      const asJson = has(args, '--json'); done(args);
      const item = call(db, 'assets.item', { id }) as ItemSummary & { avatarTags: Array<{ name: string; status: string; source: string; confidence: string; evidence: string }>;
        fileGroups: Array<{ label: string; files: Array<{ filename: string; avatars: string[]; byteSize: number | null }> }> };
      if (asJson) { json(item); return; }
      console.log([`${item.name}（${item.id}）`, `分类：${item.category?.path ?? '未分类'}${item.category ? `（${item.categorySource}）` : ''}`,
        ...(item.suggestion ? [`建议：${item.suggestion.path}（${item.suggestion.reason}）`] : []),
        `适配：${adaptation(item)}`, ...item.avatarTags.map(tag => `  ${tag.name}\t${tag.status}\t${tag.source}/${tag.confidence}\t${tag.evidence}`),
        ...item.fileGroups.flatMap(group => group.files.length ? [group.label, ...group.files.map(file =>
          `  ${file.filename}${file.avatars.length ? `\t${file.avatars.join('、')}` : ''}\t${file.byteSize ?? '大小未知'}`)] : [])].join('\n'));
    } else if (command === 'assign') {
      const id = args.shift(); if (!id) throw new Error('用法: avh assets assign <id> --category <分类|未分类>');
      const category = take(args, '--category'); if (category === undefined) throw new Error('--category: 缺少参数'); done(args);
      const result = call(db, 'assets.category.assign', { id, category }) as { category: { path: string } | null };
      console.log(`已归类：${id} → ${result.category?.path ?? '未分类'}`);
    } else if (command === 'avatar') {
      const id = args.shift(); if (!id) throw new Error('用法: avh assets avatar <id> --confirm|--reject|--add|--clear <角色>');
      const decisions = (['confirm', 'reject', 'add', 'clear'] as const).map(decision => [decision, take(args, `--${decision}`)] as const).filter(([, value]) => value !== undefined);
      if (decisions.length !== 1) throw new Error('--confirm、--reject、--add、--clear 选一个'); done(args);
      const [decision, avatar] = decisions[0]!;
      call(db, 'assets.avatar.decide', { id, avatar, decision });
      console.log(`已记录：${id} ${decision} ${avatar}`);
    } else if (command === 'review' && args[0] === 'answer') {
      args.shift();
      const id = args.shift(); if (!id) throw new Error('用法: avh assets review answer <待确认 id> --choice …');
      const choice = take(args, '--choice'), target = take(args, '--target'); done(args);
      call(db, 'assets.review.answer', { id, choice, ...(target ? { target } : {}) });
      console.log(`已处理：${id}（${choice}${target ? ` ${target}` : ''}）`);
    } else if (command === 'review') {
      const asJson = has(args, '--json'), type = take(args, '--type'); done(args);
      const result = call(db, 'assets.review.list', { type, limit: 1000 }) as { items: ReviewItem[]; counts: Record<string, number> };
      if (asJson) { json(result); return; }
      console.log(['id\t分组\t问题\t素材\t可选答案', ...result.items.map(item => [item.id, item.group, item.question, item.subject?.name ?? '',
        item.options.map(option => `${option.choice}${option.needsTarget ? '（--target 角色）' : ''}`).join(' / ')].join('\t'))].join('\n'));
      console.log(`# 分类建议 ${result.counts.category} 项，待确认角色 ${result.counts.avatar} 项，角色字典 ${result.counts.dictionary} 项`);
    } else if (command === 'taxonomy' && (args[0] === 'propose' || args[0] === 'apply' || args[0] === 'reject')) {
      const action = args.shift()!;
      if (action === 'propose') {
        const file = take(args, '--operations'), reason = take(args, '--reason'), by = take(args, '--by') ?? 'ai'; done(args);
        if (!file || !reason) throw new Error('用法: avh assets taxonomy propose --operations <JSON 文件> --reason 原因 [--by ai|human]');
        const operations = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        const proposal = call(db, 'assets.taxonomy.propose', { operations: Array.isArray(operations) ? operations : (operations as { operations?: unknown }).operations,
          reason, proposedBy: by }) as TaxonomyProposal;
        console.log([`提案 ${proposal.id}（基于分类版本 ${proposal.baseVersion}）`, ...proposal.diff.added.map(item => `  新增 ${item.path}`),
          ...proposal.diff.renamed.map(item => `  改名 ${item.from} → ${item.to}`),
          ...proposal.diff.removed.map(item => `  删除 ${item.path}${item.reassignTo ? `，素材归入 ${item.reassignTo.path}` : '，素材归入未分类'}`),
          ...proposal.diff.visibility.map(item => `  ${item.hidden ? '停用' : '启用'} ${item.path}`), ...(proposal.diff.reordered ? ['  调整顺序'] : []),
          `影响 ${proposal.impact.items} 件素材；应用：avh assets taxonomy apply ${proposal.id}`].join('\n'));
      } else {
        const id = args.shift(); if (!id) throw new Error(`用法: avh assets taxonomy ${action} <提案 id>`); done(args);
        if (action === 'apply') console.log(`分类词表已更新到版本 ${(call(db, 'assets.taxonomy.apply', { proposalId: id }) as { version: number }).version}`);
        else { call(db, 'assets.taxonomy.reject', { proposalId: id }); console.log(`已拒绝提案 ${id}`); }
      }
    } else if (command === 'taxonomy') {
      const asJson = has(args, '--json'); done(args);
      const result = call(db, 'assets.taxonomy.get') as { version: number; categories: Array<{ id: string; name: string; depth: number; hidden: boolean }>;
        proposals: TaxonomyProposal[] };
      if (asJson) { json(result); return; }
      console.log([`分类词表 版本 ${result.version}`, ...result.categories.map(item => `${'  '.repeat(item.depth - 1)}${item.name}\t${item.id}${item.hidden ? '\t已停用' : ''}`),
        ...result.proposals.filter(item => item.status === 'pending' || item.status === 'stale').map(item => `# 提案 ${item.id}：${item.reason}（${item.status === 'stale' ? '已过期' : '待应用'}）`)].join('\n'));
    } else if (command === 'dictionary' && args[0] === 'import') {
      args.shift();
      const file = args.shift(); if (!file) throw new Error('用法: avh assets dictionary import <YAML 文件>'); done(args);
      console.log(importDictionary(db, file));
    } else if (command === 'dictionary') {
      const asJson = has(args, '--json'); done(args);
      const result = call(db, 'assets.dictionary.get') as { version: string; avatars: Array<{ canonical: string; aliases: string[]; owned: boolean; origin: string }>; notAvatars: string[] };
      if (asJson) { json(result); return; }
      console.log([`角色字典 ${result.version}：${result.avatars.length} 个角色，${result.avatars.reduce((sum, item) => sum + item.aliases.length, 0)} 个别名，${result.notAvatars.length} 个排除词`,
        ...result.avatars.map(item => `${item.canonical}\t${item.aliases.join('、')}\t${item.owned ? '已拥有' : ''}\t${item.origin}`)].join('\n'));
    } else if (command === 'refresh') {
      const all = has(args, '--all'); done(args);
      const result = call(db, 'assets.refresh', { all }) as { items: number; files: number; candidates: number; dictionaryVersion: string; taxonomyVersion: number };
      console.log(`已更新 ${result.items} 件素材、${result.files} 个文件；角色字典待确认 ${result.candidates} 项；分类词表 v${result.taxonomyVersion}，角色字典 ${result.dictionaryVersion}`);
    } else throw new Error(`用法: avh ${ASSETS_USAGE}`);
  } finally { db.close(); }
}

/**
 * Bring a person's own dictionary into this computer's state database (the reference archive's format: avatars with
 * canonical, aliases, shares_body_with, owned, booth_item_id; not_avatars). It stays local: nothing is written to
 * the shipped seed or the repository.
 */
export function importDictionary(db: DatabaseSync, file: string): string {
  const document = parseYaml(readFileSync(file, 'utf8')) as { avatars?: unknown; not_avatars?: unknown } | null;
  const avatars = Array.isArray(document?.avatars) ? document.avatars : [];
  const terms = Array.isArray(document?.not_avatars) ? document.not_avatars.filter((term): term is string => typeof term === 'string') : [];
  let count = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const raw of avatars) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.canonical !== 'string' || !entry.canonical.trim()) continue;
      const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      const body = typeof entry.booth_item_id === 'string' || typeof entry.booth_item_id === 'number' ? String(entry.booth_item_id) : null;
      upsertLocalEntry(db, { canonical: entry.canonical, aliases: list(entry.aliases), sharesBodyWith: list(entry.shares_body_with), origin: 'import',
        ...(entry.owned === true ? { owned: { value: true, by: 'import', bodyItemId: body } } : {}) });
      count++;
    }
    for (const term of terms) addNotAvatar(db, term, 'import');
    db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json) VALUES ('human', 'avatar_dictionary', 'local', 'imported', ?, ?)`)
      .run(`导入本机角色字典：${count} 个角色、${terms.length} 个排除词`, JSON.stringify({ avatars: count, notAvatars: terms.length }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const refreshed = refreshAssetIndex(db);
  return `已导入 ${count} 个角色、${terms.length} 个排除词；角色字典 ${refreshed.dictionaryVersion}，已重新推导 ${refreshed.items} 件素材`;
}
