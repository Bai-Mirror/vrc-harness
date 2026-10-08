import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { foldKey } from './text.ts';

/**
 * The category vocabulary shared by BOOTH and local assets: a versioned Runtime fact. The GUI, the CLI and AI context
 * all read it through currentTaxonomy(), so what a person sees and what the AI works with is one version.
 *
 * The default is the reference archive's vocabulary: 素体、服装、发型、配饰、贴图、玩具、功能插件. 未分类 is not a
 * category but the absence of one. Paths use `/` for children, at most six levels deep.
 *
 * Nobody edits the vocabulary directly: a change is a proposal (a list of operations) that shows its diff and how many
 * items it touches, and only applying it makes a new version (upgrade plan §3.4). Built-in categories keep stable ids
 * (body, outfit…), so renaming 素体 keeps every rule that looks for the body category working.
 */
export const MAX_DEPTH = 6;
export const RESERVED_NAMES = ['未分类', '未分類', 'uncategorised', 'uncategorized'];
export const UNCATEGORIZED_LABEL = '未分类';
export const DEFAULT_CATEGORIES: ReadonlyArray<{ id: string; path: string }> = [
  { id: 'body', path: '素体' }, { id: 'outfit', path: '服装' }, { id: 'hair', path: '发型' }, { id: 'accessory', path: '配饰' },
  { id: 'texture', path: '贴图' }, { id: 'toy', path: '玩具' }, { id: 'plugin', path: '功能插件' },
];
export const BODY_CATEGORY = 'body';

export interface CategoryNode { id: string; path: string; hidden: boolean }
export interface Taxonomy { version: number; categories: CategoryNode[] }

const coded = (code: 'BAD_REQUEST' | 'NOT_FOUND' | 'STALE' | 'CONFLICT', message: string): Error => Object.assign(new Error(message), { code });

export function currentTaxonomy(db: DatabaseSync): Taxonomy {
  const version = (db.prepare('SELECT max(version) AS version FROM asset_taxonomy_version').get() as { version: number | null }).version ?? 0;
  const categories = (db.prepare('SELECT id, path, hidden FROM asset_category ORDER BY position').all() as Array<{ id: string; path: string; hidden: number }>)
    .map(row => ({ id: row.id, path: row.path, hidden: row.hidden === 1 }));
  return { version, categories };
}

export const leafName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const depthOf = (path: string): number => path.split('/').length;
export const parentPathOf = (path: string): string | null => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
/** A category and everything below it. */
export function subtree(taxonomy: Taxonomy, id: string): CategoryNode[] {
  const node = taxonomy.categories.find(item => item.id === id);
  return node ? taxonomy.categories.filter(item => item.id === id || item.path.startsWith(`${node.path}/`)) : [];
}
/** A category given by id or by path (paths compare folded). */
export function findCategory(taxonomy: Taxonomy, ref: string): CategoryNode | undefined {
  const key = foldKey(ref);
  return taxonomy.categories.find(item => item.id === ref) ?? taxonomy.categories.find(item => foldKey(item.path) === key);
}
export function isReserved(name: string): boolean {
  return RESERVED_NAMES.some(reserved => foldKey(reserved) === foldKey(name));
}
export function validateName(raw: unknown): string {
  if (typeof raw !== 'string') throw coded('BAD_REQUEST', '分类名应为字符串');
  const name = raw.normalize('NFC').trim();
  if (!name) throw coded('BAD_REQUEST', '分类名不能为空');
  if (name.includes('/')) throw coded('BAD_REQUEST', `分类名不能含 /：${name}`);
  if (isReserved(name)) throw coded('BAD_REQUEST', `「${name}」是保留名，表示没有分类`);
  if ([...name].length > 40) throw coded('BAD_REQUEST', `分类名过长：${name}`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw coded('BAD_REQUEST', '分类名含控制字符');
  return name;
}

interface TreeNode { id: string; name: string; hidden: boolean; children: TreeNode[] }
function toTree(categories: CategoryNode[]): TreeNode[] {
  const roots: TreeNode[] = [], byPath = new Map<string, TreeNode>();
  for (const category of categories) {
    const node: TreeNode = { id: category.id, name: leafName(category.path), hidden: category.hidden, children: [] };
    const parent = parentPathOf(category.path);
    (parent !== null && byPath.get(parent) ? byPath.get(parent)!.children : roots).push(node);
    byPath.set(category.path, node);
  }
  return roots;
}
function flatten(nodes: TreeNode[], prefix = ''): CategoryNode[] {
  return nodes.flatMap(node => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    return [{ id: node.id, path, hidden: node.hidden }, ...flatten(node.children, path)];
  });
}
function locate(roots: TreeNode[], id: string): { node: TreeNode; siblings: TreeNode[] } | undefined {
  for (const node of roots) {
    if (node.id === id) return { node, siblings: roots };
    const inner = locate(node.children, id);
    if (inner) return inner;
  }
  return undefined;
}
function descendantIds(node: TreeNode): string[] { return [node.id, ...node.children.flatMap(descendantIds)]; }

export type TaxonomyOperation =
  | { op: 'add'; path: string }
  | { op: 'rename'; category: string; name: string }
  | { op: 'move'; category: string; parent: string | null }
  | { op: 'remove'; category: string; reassignTo?: string | null }
  | { op: 'merge'; category: string; into: string }
  | { op: 'reorder'; parent: string | null; order: string[] }
  | { op: 'hide' | 'show'; category: string };
export interface Reassignment { fromIds: string[]; fromPaths: string[]; toId: string | null; toPath: string | null }
export interface TaxonomyDiff {
  added: Array<{ id: string; path: string }>;
  removed: Array<{ id: string; path: string; reassignTo: { id: string; path: string } | null }>;
  renamed: Array<{ id: string; from: string; to: string }>;
  visibility: Array<{ id: string; path: string; hidden: boolean }>;
  reordered: boolean;
}
export interface TaxonomyImpact {
  /** Items whose category changes: reassigned from a removed category, or shown under a new path. */
  items: number;
  reassigned: Array<{ from: string; to: string | null; items: number }>;
  renamed: Array<{ from: string; to: string; items: number }>;
  /** Suggestions that pointed at a removed category and now point at its replacement (or nowhere). */
  suggestions: number;
}
export interface TaxonomyPlan { base: Taxonomy; categories: CategoryNode[]; reassign: Reassignment[]; diff: TaxonomyDiff; impact: TaxonomyImpact }

function operations(raw: unknown): TaxonomyOperation[] {
  if (!Array.isArray(raw) || !raw.length) throw coded('BAD_REQUEST', 'operations 应为非空数组');
  if (raw.length > 200) throw coded('BAD_REQUEST', '一次提案最多 200 个操作');
  return raw.map((value, index) => {
    if (!value || typeof value !== 'object') throw coded('BAD_REQUEST', `operations[${index}] 无效`);
    const op = value as Record<string, unknown>;
    const ref = (key: string): string => { if (typeof op[key] !== 'string' || !(op[key] as string).trim()) throw coded('BAD_REQUEST', `operations[${index}].${key} 应为分类 id 或路径`); return op[key] as string; };
    const optionalRef = (key: string): string | null => op[key] === null || op[key] === undefined || op[key] === '' ? null : ref(key);
    switch (op.op) {
      case 'add': return { op: 'add', path: ref('path') };
      case 'rename': return { op: 'rename', category: ref('category'), name: ref('name') };
      case 'move': return { op: 'move', category: ref('category'), parent: optionalRef('parent') };
      case 'remove': return { op: 'remove', category: ref('category'), ...('reassignTo' in op ? { reassignTo: optionalRef('reassignTo') } : {}) };
      case 'merge': return { op: 'merge', category: ref('category'), into: ref('into') };
      case 'reorder': {
        if (!Array.isArray(op.order) || !op.order.every(item => typeof item === 'string')) throw coded('BAD_REQUEST', `operations[${index}].order 应为分类列表`);
        return { op: 'reorder', parent: optionalRef('parent'), order: op.order as string[] };
      }
      case 'hide': case 'show': return { op: op.op, category: ref('category') };
      default: throw coded('BAD_REQUEST', `operations[${index}].op 无效：${String(op.op)}`);
    }
  });
}

function itemCounts(db: DatabaseSync): Map<string, number> {
  return new Map((db.prepare(`SELECT category_id AS id, count(*) AS n FROM asset_classification WHERE category_id IS NOT NULL
    GROUP BY category_id`).all() as Array<{ id: string; n: number }>).map(row => [row.id, row.n]));
}

/** Work out what a list of operations would do to the current vocabulary, without changing anything. */
export function planTaxonomy(db: DatabaseSync, rawOperations: unknown): TaxonomyPlan {
  const base = currentTaxonomy(db), ops = operations(rawOperations);
  const roots = toTree(base.categories);
  const known = new Set(base.categories.map(item => item.id));
  const newId = (): string => { let id: string; do id = `c-${randomUUID().slice(0, 8)}`; while (known.has(id)); known.add(id); return id; };
  const current = (): Taxonomy => ({ version: base.version, categories: flatten(roots) });
  const node = (ref: string): TreeNode => {
    const found = findCategory(current(), ref), located = found && locate(roots, found.id);
    if (!located) throw coded('BAD_REQUEST', `分类不存在：${ref}`);
    return located.node;
  };
  const siblingsOf = (parent: TreeNode | null): TreeNode[] => parent ? parent.children : roots;
  const unique = (siblings: TreeNode[], name: string, self?: TreeNode): void => {
    if (siblings.some(item => item !== self && foldKey(item.name) === foldKey(name))) throw coded('BAD_REQUEST', `同一层已有分类「${name}」`);
  };
  const pending: Array<{ removed: TreeNode; fromPaths: string[]; to: string | null | undefined }> = [];
  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        const names = op.path.split('/').map(validateName);
        if (names.length > MAX_DEPTH) throw coded('BAD_REQUEST', `分类最多 ${MAX_DEPTH} 层：${op.path}`);
        let siblings = roots, created = false;
        for (const name of names) {
          let next = siblings.find(item => foldKey(item.name) === foldKey(name));
          // Missing parents are made along the way, as the reference archive fills in intermediate nodes.
          if (!next) { next = { id: newId(), name, hidden: false, children: [] }; siblings.push(next); created = true; }
          siblings = next.children;
        }
        if (!created) throw coded('BAD_REQUEST', `分类已存在：${op.path}`);
        break;
      }
      case 'rename': {
        const target = node(op.category), name = validateName(op.name);
        unique(locate(roots, target.id)!.siblings, name, target);
        target.name = name;
        break;
      }
      case 'move': {
        const target = node(op.category), located = locate(roots, target.id)!;
        const parent = op.parent === null ? null : node(op.parent);
        if (parent && descendantIds(target).includes(parent.id)) throw coded('BAD_REQUEST', '不能把分类移到它自己下面');
        unique(siblingsOf(parent), target.name, target);
        located.siblings.splice(located.siblings.indexOf(target), 1);
        siblingsOf(parent).push(target);
        break;
      }
      case 'remove': case 'merge': {
        const target = node(op.category), located = locate(roots, target.id)!;
        const fromPaths = flatten([target], parentPathOf(current().categories.find(item => item.id === target.id)!.path) ?? '').map(item => item.path);
        located.siblings.splice(located.siblings.indexOf(target), 1);
        pending.push({ removed: target, fromPaths, to: op.op === 'merge' ? op.into : op.reassignTo });
        break;
      }
      case 'reorder': {
        const parent = op.parent === null ? null : node(op.parent), siblings = siblingsOf(parent);
        const listed = op.order.map(ref => {
          const found = siblings.find(item => item.id === ref) ?? siblings.find(item => foldKey(item.name) === foldKey(ref))
            ?? siblings.find(item => findCategory(current(), ref)?.id === item.id);
          if (!found) throw coded('BAD_REQUEST', `排序里的分类不在这一层：${ref}`);
          return found;
        });
        if (new Set(listed).size !== listed.length) throw coded('BAD_REQUEST', '排序里有重复的分类');
        const rest = siblings.filter(item => !listed.includes(item));
        siblings.splice(0, siblings.length, ...listed, ...rest);
        break;
      }
      case 'hide': case 'show': node(op.category).hidden = op.op === 'hide'; break;
    }
  }
  const categories = flatten(roots);
  for (const category of categories) if (depthOf(category.path) > MAX_DEPTH) throw coded('BAD_REQUEST', `分类最多 ${MAX_DEPTH} 层：${category.path}`);
  const result: Taxonomy = { version: base.version, categories };
  const counts = itemCounts(db);
  const reassign: Reassignment[] = pending.map(entry => {
    const fromIds = descendantIds(entry.removed).filter(id => base.categories.some(item => item.id === id));
    const items = fromIds.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0);
    if (entry.to === undefined && items > 0)
      throw coded('BAD_REQUEST', `「${entry.fromPaths[0]}」下还有 ${items} 个素材：删除时要给出重新归类的目标（可以是未分类）`);
    const to = entry.to ? findCategory(result, entry.to) : undefined;
    if (entry.to && !to) throw coded('BAD_REQUEST', `重新归类的目标不在修改后的分类里：${entry.to}`);
    return { fromIds, fromPaths: entry.fromPaths, toId: to?.id ?? null, toPath: to?.path ?? null };
  });
  const before = new Map(base.categories.map(item => [item.id, item])), after = new Map(categories.map(item => [item.id, item]));
  const diff: TaxonomyDiff = {
    added: categories.filter(item => !before.has(item.id)).map(item => ({ id: item.id, path: item.path })),
    removed: base.categories.filter(item => !after.has(item.id)).map(item => {
      const target = reassign.find(entry => entry.fromIds.includes(item.id));
      return { id: item.id, path: item.path, reassignTo: target?.toId ? { id: target.toId, path: target.toPath! } : null };
    }),
    renamed: categories.filter(item => before.has(item.id) && before.get(item.id)!.path !== item.path)
      .map(item => ({ id: item.id, from: before.get(item.id)!.path, to: item.path })),
    visibility: categories.filter(item => before.has(item.id) && before.get(item.id)!.hidden !== item.hidden)
      .map(item => ({ id: item.id, path: item.path, hidden: item.hidden })),
    reordered: base.categories.filter(item => after.has(item.id)).map(item => item.id).join('\n')
      !== categories.filter(item => before.has(item.id)).map(item => item.id).join('\n'),
  };
  const suggestions = reassign.length ? (db.prepare(`SELECT count(*) AS n FROM asset_classification WHERE suggestion_id IN
    (SELECT value FROM json_each(?))`).get(JSON.stringify(reassign.flatMap(entry => entry.fromIds))) as { n: number }).n : 0;
  const reassigned = reassign.map(entry => ({ from: entry.fromPaths[0]!, to: entry.toPath, items: entry.fromIds.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0) }));
  const renamed = diff.renamed.map(item => ({ from: item.from, to: item.to, items: counts.get(item.id) ?? 0 }));
  const impact: TaxonomyImpact = { items: reassigned.reduce((sum, item) => sum + item.items, 0) + renamed.reduce((sum, item) => sum + item.items, 0),
    reassigned, renamed, suggestions };
  if (!diff.added.length && !diff.removed.length && !diff.renamed.length && !diff.visibility.length && !diff.reordered)
    throw coded('BAD_REQUEST', '这些操作不会改变分类');
  return { base, categories, reassign, diff, impact };
}

export interface TaxonomyProposal {
  id: string; baseVersion: number; status: 'pending' | 'applied' | 'rejected' | 'stale'; reason: string; proposedBy: string;
  operations: TaxonomyOperation[]; categories: CategoryNode[]; diff: TaxonomyDiff; impact: TaxonomyImpact; createdAt: string; decidedAt: string | null;
}
function proposalRow(row: Record<string, unknown>, version: number): TaxonomyProposal {
  const status = row.status as TaxonomyProposal['status'];
  return { id: String(row.id), baseVersion: Number(row.base_version), status: status === 'pending' && Number(row.base_version) !== version ? 'stale' : status,
    reason: String(row.reason), proposedBy: String(row.proposed_by), operations: JSON.parse(String(row.operations_json)),
    categories: JSON.parse(String(row.result_json)).categories, diff: JSON.parse(String(row.diff_json)), impact: JSON.parse(String(row.impact_json)),
    createdAt: String(row.created_at), decidedAt: row.decided_at === null ? null : String(row.decided_at) };
}
export function listProposals(db: DatabaseSync, limit = 20): TaxonomyProposal[] {
  const version = currentTaxonomy(db).version;
  return (db.prepare(`SELECT * FROM asset_taxonomy_proposal ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>)
    .map(row => proposalRow(row, version));
}
export function getProposal(db: DatabaseSync, id: string): TaxonomyProposal {
  const row = db.prepare('SELECT * FROM asset_taxonomy_proposal WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) throw coded('NOT_FOUND', `分类修改提案不存在：${id}`);
  return proposalRow(row, currentTaxonomy(db).version);
}

/** Record a proposal. The vocabulary does not change until the proposal is applied. */
export function proposeTaxonomy(db: DatabaseSync, input: { operations: unknown; reason: string; proposedBy: 'ai' | 'human' | 'system' }): TaxonomyProposal {
  if (!input.reason.trim()) throw coded('BAD_REQUEST', '提案要写明原因');
  const plan = planTaxonomy(db, input.operations);
  const id = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO asset_taxonomy_proposal (id, base_version, operations_json, result_json, diff_json, impact_json, reason, proposed_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(id, plan.base.version, JSON.stringify(operations(input.operations)),
      JSON.stringify({ categories: plan.categories, reassign: plan.reassign }), JSON.stringify(plan.diff), JSON.stringify(plan.impact),
      input.reason.trim(), input.proposedBy);
    db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json) VALUES (?, 'asset_taxonomy', ?, 'proposed', ?, ?)`)
      .run(input.proposedBy, id, input.reason.trim(), JSON.stringify({ baseVersion: plan.base.version, diff: plan.diff, impact: plan.impact }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return getProposal(db, id);
}

/** Apply a pending proposal made against the current version: a new vocabulary version, and items reassigned with it. */
export function applyTaxonomy(db: DatabaseSync, proposalId: string, actor = 'human'): { version: number; reassigned: number } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM asset_taxonomy_proposal WHERE id = ?').get(proposalId) as Record<string, unknown> | undefined;
    if (!row) throw coded('NOT_FOUND', `分类修改提案不存在：${proposalId}`);
    if (row.status !== 'pending') throw coded('CONFLICT', `提案已${row.status === 'applied' ? '应用' : '拒绝'}`);
    const current = currentTaxonomy(db);
    if (Number(row.base_version) !== current.version)
      throw coded('STALE', `提案基于分类版本 ${String(row.base_version)}，当前已是版本 ${current.version}：请重新提出`);
    const result = JSON.parse(String(row.result_json)) as { categories: CategoryNode[]; reassign: Reassignment[] };
    const version = current.version + 1;
    db.prepare('DELETE FROM asset_category').run();
    const insert = db.prepare('INSERT INTO asset_category (id, path, position, hidden) VALUES (?, ?, ?, ?)');
    result.categories.forEach((category, position) => insert.run(category.id, category.path, position, category.hidden ? 1 : 0));
    db.prepare('INSERT INTO asset_taxonomy_version (version, categories_json, proposal_id) VALUES (?, ?, ?)')
      .run(version, JSON.stringify(result.categories), proposalId);
    let reassigned = 0;
    for (const entry of result.reassign) {
      const ids = JSON.stringify(entry.fromIds);
      reassigned += Number(db.prepare(`UPDATE asset_classification SET category_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE category_id IN (SELECT value FROM json_each(?))`).run(entry.toId, ids).changes);
      db.prepare(`UPDATE asset_classification SET suggestion_id = ? WHERE suggestion_id IN (SELECT value FROM json_each(?))`).run(entry.toId, ids);
      db.prepare(`UPDATE asset_classification SET dismissed_suggestion_id = NULL WHERE dismissed_suggestion_id IN (SELECT value FROM json_each(?))`).run(ids);
    }
    // A suggestion now equal to the category it would replace is no longer a question.
    db.prepare('UPDATE asset_classification SET suggestion_id = NULL, suggestion_reason = \'\' WHERE suggestion_id IS NOT NULL AND suggestion_id = category_id').run();
    db.prepare(`UPDATE asset_taxonomy_proposal SET status = 'applied', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(proposalId);
    db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json) VALUES (?, 'asset_taxonomy', ?, 'applied', ?, ?)`)
      .run(actor, proposalId, `分类词表更新到版本 ${version}`, JSON.stringify({ version, reassigned }));
    db.exec('COMMIT');
    return { version, reassigned };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function rejectTaxonomy(db: DatabaseSync, proposalId: string, actor = 'human'): void {
  const proposal = getProposal(db, proposalId);
  if (proposal.status === 'applied' || proposal.status === 'rejected') throw coded('CONFLICT', `提案已${proposal.status === 'applied' ? '应用' : '拒绝'}`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE asset_taxonomy_proposal SET status = 'rejected', decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(proposalId);
    db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json) VALUES (?, 'asset_taxonomy', ?, 'rejected', '分类修改提案被拒绝', '{}')`)
      .run(actor, proposalId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** The vocabulary as the API returns it: tree order, with each node's leaf name, depth and parent. */
export function taxonomyView(taxonomy: Taxonomy): { version: number; maxDepth: number; reserved: string[]; uncategorized: string;
  categories: Array<CategoryNode & { name: string; depth: number; parentId: string | null; builtin: boolean }> } {
  const byPath = new Map(taxonomy.categories.map(item => [item.path, item.id]));
  return { version: taxonomy.version, maxDepth: MAX_DEPTH, reserved: RESERVED_NAMES, uncategorized: UNCATEGORIZED_LABEL,
    categories: taxonomy.categories.map(item => ({ ...item, name: leafName(item.path), depth: depthOf(item.path),
      parentId: parentPathOf(item.path) === null ? null : byPath.get(parentPathOf(item.path)!) ?? null,
      builtin: DEFAULT_CATEGORIES.some(category => category.id === item.id) })) };
}

/**
 * The vocabulary for an AI task's context, carrying the same version numbers the GUI shows. A classification task
 * answers with category ids from this list; a name that is not in it is a proposal, not an assignment.
 */
export function vocabularyContext(taxonomy: Taxonomy, dictionaryVersion: string, avatars: number): string {
  const shown = taxonomy.categories.filter(item => !item.hidden);
  return [`素材分类词表 版本 ${taxonomy.version}（${UNCATEGORIZED_LABEL}表示没有分类）：`,
    ...shown.map(item => `- ${item.id}: ${item.path}`),
    `角色字典 版本 ${dictionaryVersion}：${avatars} 个角色。`].join('\n');
}
