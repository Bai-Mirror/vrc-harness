import type { DatabaseSync } from 'node:sqlite';
import { loadDictionary, resolveAvatar, type AvatarDictionary } from './avatars.ts';
import { FILE_GROUPS, type FileKind } from './file-kinds.ts';
import { loadSubject, parseSubjectId, stringList } from './subjects.ts';
import { currentTaxonomy, findCategory, isReserved, subtree, type Taxonomy } from './taxonomy.ts';
import { fold, foldKey } from './text.ts';

/**
 * Reads of the catalog: the item list with filters, the facet counts beside it and one item's detail. BOOTH products
 * and local assets appear together with the same category and 适配角色 semantics. Every answer carries the vocabulary
 * and dictionary versions it was computed with.
 */
const coded = (code: 'BAD_REQUEST' | 'NOT_FOUND', message: string): Error => Object.assign(new Error(message), { code });

export type Adaptation = 'tagged' | 'universal' | 'unknown' | 'none';
export type SortKey = 'name' | 'listing' | 'acquired' | 'adaptation';
export interface ItemQuery {
  /** A category id or path (its children included), 未分类 for items without one; empty for all. */
  category?: string;
  /** An avatar, exact after folding (aliases resolve to their avatar). */
  avatar?: string;
  /** Items without confirmed avatars: those marked universal, or those only not recognised. */
  bucket?: 'unknown' | 'universal';
  /** Count pending (unreviewed) avatar tags as matches for `avatar`. */
  includePending?: boolean;
  query?: string;
  source?: 'booth' | 'local';
  owned?: boolean;
  sort?: SortKey;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}
export interface AvatarTagView { name: string; status: 'confirmed' | 'pending' | 'rejected'; source: string; confidence: string; decidedBy: string }
export interface ItemSummary {
  id: string; source: 'booth' | 'local'; ref: string; name: string; shop: string; url: string | null; thumbnail: string | null;
  owned: boolean; status: string;
  category: { id: string; path: string } | null;
  categorySource: string;
  suggestion: { id: string; path: string; reason: string } | null;
  avatars: AvatarTagView[];
  adaptation: Adaptation;
  universalBasis: string;
  files: { count: number; bytes: number; unknownSizes: number; materialized: number };
  listing: number | null;
  acquiredAt: string | null;
  pendingReview: number;
  match?: 'strong' | 'description';
  snippet?: string;
}

interface Row {
  subject: string; source: 'booth' | 'local'; ref: string; eligible: number; universal_basis: string; search_strong: string; search_weak: string;
  listing_key: number | null; acquired_at: string | null; category_id: string | null; category_source: string | null; suggestion_id: string | null;
  suggestion_reason: string | null; booth_name: string | null; shop_name: string | null; item_url: string | null; owned: number | null;
  booth_status: string | null; images_json: string | null; local_name: string | null; local_status: string | null;
}
interface Loaded { row: Row; summary: ItemSummary; strong: string; weak: string; confirmedKeys: Set<string>; pendingKeys: Set<string>;
  names: Map<string, string> }

/** Every catalog item with its summary. Descriptions (the weak search text) are only read when a query needs them. */
function load(db: DatabaseSync, dict: AvatarDictionary, taxonomy: Taxonomy, withDescriptions = false, only?: string): Loaded[] {
  const rows = db.prepare(`SELECT d.subject, d.source, d.ref, d.eligible, d.universal_basis, d.search_strong,
      ${withDescriptions ? 'd.search_weak' : "''"} AS search_weak, d.listing_key, d.acquired_at,
      c.category_id, c.source AS category_source, c.suggestion_id, c.suggestion_reason,
      i.name AS booth_name, i.shop_name, i.item_url, i.owned, i.status AS booth_status, i.images_json,
      a.name AS local_name, a.status AS local_status
    FROM asset_derivation d LEFT JOIN asset_classification c ON c.subject = d.subject
    LEFT JOIN booth_item i ON d.source = 'booth' AND i.item_id = d.ref
    LEFT JOIN asset a ON d.source = 'local' AND a.id = d.ref
    WHERE ((d.source = 'booth' AND i.item_id IS NOT NULL) OR (d.source = 'local' AND a.id IS NOT NULL)) AND (? IS NULL OR d.subject = ?)`)
    .all(only ?? null, only ?? null) as unknown as Row[];
  const tags = new Map<string, Array<{ key: string } & AvatarTagView>>();
  for (const tag of db.prepare(`SELECT subject, avatar_key AS key, avatar AS name, status, source, confidence, decided_by AS decidedBy
    FROM asset_avatar_tag ORDER BY subject, CASE status WHEN 'confirmed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, avatar`).all() as unknown as
    Array<{ subject: string; key: string } & AvatarTagView>) {
    const list = tags.get(tag.subject) ?? []; list.push(tag); tags.set(tag.subject, list);
  }
  const files = new Map((db.prepare(`SELECT f.item_id AS item, count(*) AS count, coalesce(sum(f.byte_size), 0) AS bytes,
      sum(CASE WHEN f.byte_size IS NULL THEN 1 ELSE 0 END) AS unknownSizes, sum(CASE WHEN m.status = 'ready' THEN 1 ELSE 0 END) AS materialized
    FROM booth_file f LEFT JOIN materialized_file m ON m.downloadable_id = f.downloadable_id GROUP BY f.item_id`).all() as
    Array<{ item: string; count: number; bytes: number; unknownSizes: number; materialized: number }>).map(row => [row.item, row]));
  const categories = new Map(taxonomy.categories.map(item => [item.id, item]));
  return rows.map(row => {
    const all = tags.get(row.subject) ?? [];
    const visible = all.filter(tag => tag.status !== 'rejected');
    const confirmed = visible.filter(tag => tag.status === 'confirmed'), pending = visible.filter(tag => tag.status === 'pending');
    const adaptation: Adaptation = row.eligible !== 1 && !confirmed.length ? 'none' : confirmed.length ? 'tagged' : row.universal_basis ? 'universal' : 'unknown';
    const category = row.category_id ? categories.get(row.category_id) : undefined;
    const suggestion = row.suggestion_id && row.category_source !== 'manual' ? categories.get(row.suggestion_id) : undefined;
    const aggregate = row.source === 'booth' ? files.get(row.ref) : undefined;
    const images = row.images_json ? stringList(row.images_json) : [];
    const avatarNames = visible.flatMap(tag => { const entry = dict.lookup.get(tag.key); return [tag.name, ...(entry ? [entry.canonical, ...entry.aliases] : [])]; });
    const summary: ItemSummary = {
      id: row.subject, source: row.source, ref: row.ref, name: (row.source === 'booth' ? row.booth_name : row.local_name) ?? '',
      shop: row.shop_name ?? '', url: row.item_url, thumbnail: images[0] ?? null, owned: row.source === 'local' || row.owned === 1,
      status: (row.source === 'booth' ? row.booth_status : row.local_status) ?? '',
      category: category ? { id: category.id, path: category.path } : null, categorySource: row.category_source ?? 'none',
      suggestion: suggestion ? { id: suggestion.id, path: suggestion.path, reason: row.suggestion_reason ?? '' } : null,
      avatars: visible.map(tag => ({ name: tag.name, status: tag.status, source: tag.source, confidence: tag.confidence, decidedBy: tag.decidedBy })),
      adaptation, universalBasis: adaptation === 'universal' ? row.universal_basis : '',
      files: { count: aggregate?.count ?? 0, bytes: aggregate?.bytes ?? 0, unknownSizes: aggregate?.unknownSizes ?? 0, materialized: aggregate?.materialized ?? 0 },
      listing: row.listing_key, acquiredAt: row.acquired_at, pendingReview: pending.length + (suggestion ? 1 : 0),
    };
    return { row, summary, strong: `${row.search_strong}\n${fold(avatarNames.join('\n'))}`, weak: row.search_weak,
      confirmedKeys: new Set(confirmed.map(tag => tag.key)), pendingKeys: new Set(pending.map(tag => tag.key)),
      names: new Map(visible.map(tag => [tag.key, tag.name])) };
  });
}

/** Resolve the category filter to the ids it covers (children included), or 'none' for 未分类, or undefined for all. */
function categoryScope(taxonomy: Taxonomy, category: string | undefined): Set<string> | 'none' | undefined {
  if (category === undefined || category === '' || category === 'all') return undefined;
  if (isReserved(category) || category === 'uncategorized') return 'none';
  const node = findCategory(taxonomy, category);
  if (!node) throw coded('BAD_REQUEST', `分类不存在：${category}`);
  return new Set(subtree(taxonomy, node.id).map(item => item.id));
}
function inCategory(item: Loaded, scope: Set<string> | 'none' | undefined): boolean {
  if (scope === undefined) return true;
  // An item whose category is no longer in the vocabulary is shown as 未分类 (summary.category is null then).
  return scope === 'none' ? item.summary.category === null : item.summary.category !== null && scope.has(item.summary.category.id);
}
function queryTokens(query: string | undefined): string[] {
  return query ? fold(query).split(/\s+/u).filter(Boolean) : [];
}
function textMatch(item: Loaded, tokens: string[]): 'strong' | 'description' | undefined {
  if (!tokens.length) return 'strong';
  if (tokens.every(token => item.strong.includes(token))) return 'strong';
  return tokens.every(token => item.strong.includes(token) || item.weak.includes(token)) ? 'description' : undefined;
}
function snippet(weak: string, tokens: string[]): string {
  const at = Math.max(0, ...tokens.map(token => weak.indexOf(token)).filter(index => index >= 0).slice(0, 1));
  return weak.slice(Math.max(0, at - 30), at + 60).replace(/\s+/g, ' ').trim();
}

function filtered(db: DatabaseSync, query: ItemQuery, options: { ignoreAvatar?: boolean } = {}): { items: Array<Loaded & { match: 'strong' | 'description' }>;
  taxonomy: Taxonomy; dict: AvatarDictionary; all: Loaded[] } {
  const tokens = queryTokens(query.query);
  const taxonomy = currentTaxonomy(db), dict = loadDictionary(db), all = load(db, dict, taxonomy, tokens.length > 0);
  const scope = categoryScope(taxonomy, query.category);
  const avatarKey = !options.ignoreAvatar && query.avatar ? resolveAvatar(dict, query.avatar)?.key ?? foldKey(query.avatar) : undefined;
  const items: Array<Loaded & { match: 'strong' | 'description' }> = [];
  for (const item of all) {
    if (query.source && item.summary.source !== query.source) continue;
    if (query.owned !== undefined && item.summary.owned !== query.owned) continue;
    if (!inCategory(item, scope)) continue;
    if (avatarKey !== undefined && !item.confirmedKeys.has(avatarKey) && !(query.includePending && item.pendingKeys.has(avatarKey))) continue;
    if (!options.ignoreAvatar && query.bucket && item.summary.adaptation !== query.bucket) continue;
    const match = textMatch(item, tokens);
    if (!match) continue;
    items.push({ ...item, match });
  }
  return { items, taxonomy, dict, all };
}

function compare(a: ItemSummary, b: ItemSummary, sort: SortKey, direction: 'asc' | 'desc'): number {
  const value = (item: ItemSummary): string | number | null => sort === 'name' ? fold(item.name) : sort === 'listing' ? item.listing
    : sort === 'acquired' ? item.acquiredAt : item.adaptation === 'none' ? null : item.avatars.filter(tag => tag.status === 'confirmed').length;
  const x = value(a), y = value(b);
  // Items without a value come last whichever way the list is sorted.
  if (x === null || y === null) return x === null && y === null ? 0 : x === null ? 1 : -1;
  const order = x < y ? -1 : x > y ? 1 : 0;
  return direction === 'asc' ? order : -order;
}

export function listItems(db: DatabaseSync, query: ItemQuery = {}): { total: number; offset: number; limit: number; items: ItemSummary[];
  stats: { count: number; bytes: number; unknownSizes: number; needsReview: number }; taxonomyVersion: number; dictionaryVersion: string } {
  const { items, taxonomy, dict } = filtered(db, query);
  const sort = query.sort ?? 'listing', direction = query.direction ?? 'desc';
  const tokens = queryTokens(query.query);
  items.sort((a, b) => (a.match === b.match ? 0 : a.match === 'strong' ? -1 : 1) || compare(a.summary, b.summary, sort, direction)
    || (a.summary.id < b.summary.id ? -1 : a.summary.id > b.summary.id ? 1 : 0));
  const limit = Math.min(Math.max(query.limit ?? 120, 1), 500), offset = Math.max(query.offset ?? 0, 0);
  const page = items.slice(offset, offset + limit).map(item => ({ ...item.summary, ...(tokens.length ? { match: item.match } : {}),
    ...(tokens.length && item.match === 'description' ? { snippet: snippet(item.weak, tokens) } : {}) }));
  return { total: items.length, offset, limit, items: page,
    stats: { count: items.length, bytes: items.reduce((sum, item) => sum + item.summary.files.bytes, 0),
      unknownSizes: items.reduce((sum, item) => sum + item.summary.files.unknownSizes, 0), needsReview: items.filter(item => item.summary.pendingReview > 0).length },
    taxonomyVersion: taxonomy.version, dictionaryVersion: dict.version };
}

/**
 * Counts beside the list. Categories count the whole library, children included (the reference counted only direct
 * items while filtering with children). Avatars count what the search and category select, not the avatar filter:
 * confirmed avatars, top N by count, with pending tags and the universal / not-recognised buckets shown apart.
 */
export function facets(db: DatabaseSync, query: ItemQuery & { top?: number; avatarFilter?: string } = {}): {
  categories: { all: number; uncategorized: number; nodes: Array<{ id: string; path: string; name: string; depth: number; hidden: boolean; count: number; direct: number }> };
  avatars: { total: number; shown: number; more: number; items: Array<{ name: string; count: number; pending: number; aliases: string[]; owned: boolean }>;
    unknown: number; universal: number; pendingItems: number };
  taxonomyVersion: number; dictionaryVersion: string } {
  const { items, taxonomy, dict, all } = filtered(db, { ...query, avatar: undefined, bucket: undefined }, { ignoreAvatar: true });
  const direct = new Map<string, number>();
  for (const item of all) if (item.summary.category) direct.set(item.summary.category.id, (direct.get(item.summary.category.id) ?? 0) + 1);
  const nodes = taxonomy.categories.map(node => ({ id: node.id, path: node.path, name: node.path.slice(node.path.lastIndexOf('/') + 1),
    depth: node.path.split('/').length, hidden: node.hidden, direct: direct.get(node.id) ?? 0,
    count: subtree(taxonomy, node.id).reduce((sum, item) => sum + (direct.get(item.id) ?? 0), 0) }));
  const counts = new Map<string, { name: string; count: number; pending: number }>();
  const tally = (item: Loaded, key: string, field: 'count' | 'pending'): void => {
    const entry = counts.get(key) ?? { name: dict.lookup.get(key)?.canonical ?? item.names.get(key) ?? key, count: 0, pending: 0 };
    entry[field]++; counts.set(key, entry);
  };
  for (const item of items) {
    for (const key of item.confirmedKeys) tally(item, key, 'count');
    for (const key of item.pendingKeys) tally(item, key, 'pending');
  }
  const filter = query.avatarFilter ? fold(query.avatarFilter).trim() : '';
  const ranked = [...counts.entries()].filter(([, entry]) => entry.count > 0).map(([key, entry]) => {
    const known = dict.lookup.get(key);
    return { ...entry, aliases: known?.aliases ?? [], owned: known?.owned ?? false };
  }).filter(entry => !filter || [entry.name, ...entry.aliases].some(name => fold(name).includes(filter)))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const top = Math.min(Math.max(query.top ?? 40, 1), 500);
  return { categories: { all: all.length, uncategorized: all.filter(item => !item.summary.category).length, nodes },
    avatars: { total: ranked.length, shown: Math.min(top, ranked.length), more: Math.max(0, ranked.length - top), items: ranked.slice(0, top),
      unknown: items.filter(item => item.summary.adaptation === 'unknown').length,
      universal: items.filter(item => item.summary.adaptation === 'universal').length,
      pendingItems: items.filter(item => item.pendingKeys.size > 0).length },
    taxonomyVersion: taxonomy.version, dictionaryVersion: dict.version };
}

/** One item in full: its text, images, category basis, every avatar tag with its evidence, and its files in three groups. */
export function itemDetail(db: DatabaseSync, id: string): Record<string, unknown> {
  if (!parseSubjectId(id)) throw coded('BAD_REQUEST', `素材 id 应为 booth:<商品 ID> 或 local:<素材 ID>：${id}`);
  const subject = loadSubject(db, id);
  if (!subject) throw coded('NOT_FOUND', `素材不存在：${id}`);
  const taxonomy = currentTaxonomy(db), dict = loadDictionary(db);
  const summary = load(db, dict, taxonomy, false, id)[0]?.summary;
  if (!summary) throw coded('NOT_FOUND', `素材还没有归入目录：${id}`);
  const basis = db.prepare('SELECT basis_json AS basis, legacy_kind AS legacyKind FROM asset_classification WHERE subject = ?').get(id) as
    { basis: string; legacyKind: string | null } | undefined;
  const tags = (db.prepare(`SELECT avatar AS name, status, source, confidence, decided_by AS decidedBy, evidence, evidence_json AS evidenceJson
    FROM asset_avatar_tag WHERE subject = ? ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, avatar`).all(id) as
    Array<{ name: string; status: string; source: string; confidence: string; decidedBy: string; evidence: string; evidenceJson: string }>)
    .map(({ evidenceJson, ...tag }) => ({ ...tag, claim: tag.source === 'manual' ? '人工' : '作者声明', evidenceList: JSON.parse(evidenceJson) as unknown[] }));
  const files = subject.source !== 'booth' ? [] : (db.prepare(`SELECT f.downloadable_id AS downloadableId, f.filename, f.byte_size AS byteSize,
      f.remote_version AS remoteVersion, f.status, k.kind, k.avatars_json AS avatars, k.reason, CASE WHEN m.status = 'ready' THEN 1 ELSE 0 END AS materialized
    FROM booth_file f LEFT JOIN booth_file_kind k ON k.downloadable_id = f.downloadable_id LEFT JOIN materialized_file m ON m.downloadable_id = f.downloadable_id
    WHERE f.item_id = ? ORDER BY f.filename, f.downloadable_id`).all(subject.ref) as Array<{ downloadableId: string; filename: string; byteSize: number | null;
      remoteVersion: string; status: string; kind: FileKind | null; avatars: string | null; reason: string | null; materialized: number }>)
    .map(file => ({ ...file, kind: file.kind ?? 'other', avatars: file.avatars ? JSON.parse(file.avatars) as string[] : [], reason: file.reason ?? '',
      materialized: file.materialized === 1 }));
  return { ...summary, description: subject.description, images: subject.images, tags: subject.tags, variations: subject.variations,
    price: subject.price, publishedAt: subject.publishedAt,
    booth: subject.source === 'booth' ? { category: subject.boothCategory, parent: subject.boothParent } : null,
    local: subject.local ?? null,
    classification: { basis: basis ? JSON.parse(basis.basis) as unknown : {}, legacyKind: basis?.legacyKind ?? null },
    avatarTags: tags,
    fileGroups: FILE_GROUPS.map(group => ({ ...group, files: files.filter(file => file.kind === group.kind) })),
    taxonomyVersion: taxonomy.version, dictionaryVersion: dict.version };
}
