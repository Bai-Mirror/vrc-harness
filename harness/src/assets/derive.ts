import type { DatabaseSync } from 'node:sqlite';
import { deriveAvatarTags, findInText, loadDictionary, localEntryRows, matchToken, resolveAvatar, upsertLocalEntry,
  type AvatarDictionary, type AvatarEntry, type DerivedTag, type Evidence } from './avatars.ts';
import { boothCategoryRule, isThreeD, universalBasis, type CategoryRule } from './classify.ts';
import { bodyNames, discoverCandidates, storeCandidates, type DiscoveryFile, type DiscoveryItem } from './discovery.ts';
import { classifyFile, type FileKind } from './file-kinds.ts';
import { boothRows, boothSubject, loadSubject, localRows, localSubject, parseSubjectId, type Subject } from './subjects.ts';
import { BODY_CATEGORY, currentTaxonomy, findCategory, isReserved, subtree, type Taxonomy } from './taxonomy.ts';
import { fold, foldKey } from './text.ts';

/**
 * Keeps the catalog derived from the stored index: file kinds, categories, avatar tags, universal markers and search
 * text, plus what the dictionary learns from owned bodies and what discovery asks about. Everything is computed from
 * rows already in the state database, so it runs after a BOOTH sync, after a dictionary or vocabulary change, and
 * lazily before a catalog read; an item is derived again only when its row, its files, the dictionary version or the
 * vocabulary version changed.
 */
const coded = (code: 'BAD_REQUEST' | 'NOT_FOUND', message: string): Error => Object.assign(new Error(message), { code });
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const BATCH = 100;

function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

interface ClassificationRow { category_id: string | null; source: string; suggestion_id: string | null; dismissed_suggestion_id: string | null }
function classification(db: DatabaseSync, subject: string): ClassificationRow | undefined {
  return db.prepare('SELECT category_id, source, suggestion_id, dismissed_suggestion_id FROM asset_classification WHERE subject = ?').get(subject) as
    ClassificationRow | undefined;
}

/**
 * Apply a BOOTH rule: a confident rule fills an item that has no category and was never set by hand; otherwise a rule
 * that points elsewhere becomes a suggestion (unless the person already turned that suggestion down). A manual choice
 * is final: no suggestion is kept for it.
 */
function applyCategoryRule(db: DatabaseSync, subject: string, rule: CategoryRule, taxonomy: Taxonomy): void {
  const row = classification(db, subject);
  const target = rule.target && taxonomy.categories.some(item => item.id === rule.target) ? rule.target : null;
  let category = row?.category_id ?? null, source = row?.source ?? 'none', suggestion: string | null = null, reason = '';
  if (source !== 'manual') {
    if (category === null && rule.confident && target) { category = target; source = 'auto'; }
    else if (target && target !== category && target !== row?.dismissed_suggestion_id) { suggestion = target; reason = rule.reason; }
  }
  const basis = JSON.stringify({ rule: rule.rule, reason: rule.reason, ...rule.basis });
  db.prepare(`INSERT INTO asset_classification (subject, category_id, source, suggestion_id, suggestion_reason, basis_json) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(subject) DO UPDATE SET category_id = excluded.category_id, source = excluded.source, suggestion_id = excluded.suggestion_id,
    suggestion_reason = excluded.suggestion_reason, basis_json = excluded.basis_json,
    updated_at = CASE WHEN asset_classification.category_id IS excluded.category_id AND asset_classification.suggestion_id IS excluded.suggestion_id
      THEN asset_classification.updated_at ELSE ${now} END`).run(subject, category, source, suggestion, reason, basis);
}

interface TagRow { avatar: string; key: string; source: DerivedTag['source']; confidence: DerivedTag['confidence'];
  status: 'confirmed' | 'pending' | 'rejected'; decidedBy: 'rule' | 'human'; evidence: Evidence[] }
/**
 * Write an item's avatar tags: derived ones first (variation names and tags confirmed as the author's claim, the
 * description pending), then the person's decisions on top. Decisions are stored apart, so they survive every resync.
 */
function writeTags(db: DatabaseSync, subject: string, derived: DerivedTag[], dict: AvatarDictionary): void {
  const rows = new Map<string, TagRow>();
  for (const tag of derived) rows.set(tag.entry.key, { avatar: tag.entry.canonical, key: tag.entry.key, source: tag.source, confidence: tag.confidence,
    status: tag.confidence === 'low' ? 'pending' : 'confirmed', decidedBy: 'rule', evidence: tag.evidence.map(item => ({ ...item })) });
  const decisions = db.prepare('SELECT avatar_key, avatar, decision FROM asset_avatar_decision WHERE subject = ? ORDER BY decided_at').all(subject) as
    Array<{ avatar_key: string; avatar: string; decision: 'confirm' | 'reject' }>;
  for (const decision of decisions) {
    // A decision follows its avatar through dictionary changes (a name later merged into another resolves to it).
    const entry = resolveAvatar(dict, decision.avatar), key = entry?.key ?? decision.avatar_key;
    const current = rows.get(key);
    if (decision.decision === 'reject') { if (current) { current.status = 'rejected'; current.decidedBy = 'human'; } continue; }
    if (current) { current.status = 'confirmed'; current.decidedBy = 'human'; current.evidence.push({ source: 'manual', text: '人工确认' }); }
    else rows.set(key, { avatar: entry?.canonical ?? decision.avatar, key, source: 'manual', confidence: 'high', status: 'confirmed', decidedBy: 'human',
      evidence: [{ source: 'manual', text: '人工添加' }] });
  }
  db.prepare('DELETE FROM asset_avatar_tag WHERE subject = ?').run(subject);
  const insert = db.prepare(`INSERT INTO asset_avatar_tag (subject, avatar_key, avatar, source, confidence, status, decided_by, evidence, evidence_json,
    dictionary_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows.values()) insert.run(subject, row.key, row.avatar, row.source, row.confidence, row.status, row.decidedBy,
    row.evidence[0]?.text ?? '', JSON.stringify(row.evidence), dict.version);
}

function fileKindsOf(db: DatabaseSync, itemId: string): FileKind[] {
  return (db.prepare('SELECT kind FROM booth_file_kind WHERE item_id = ?').all(itemId) as Array<{ kind: FileKind }>).map(row => row.kind);
}

/** Derive one item now, whatever its stamps say. Callers hold the transaction. */
export function deriveSubject(db: DatabaseSync, subject: Subject, dict: AvatarDictionary, taxonomy: Taxonomy, filesStamp = ''): void {
  if (subject.source === 'booth')
    applyCategoryRule(db, subject.id, boothCategoryRule({ category: subject.boothCategory, parent: subject.boothParent, name: subject.name, tags: subject.tags }), taxonomy);
  else if (!classification(db, subject.id)) {
    // Normally made by the asset table's trigger; a row that predates it is filled the same way.
    const mapped = ({ avatar: 'body', outfit: 'outfit', texture: 'texture', animation: 'toy' } as Record<string, string>)[subject.local?.kind ?? ''];
    db.prepare(`INSERT OR IGNORE INTO asset_classification (subject, category_id, source, legacy_kind) VALUES (?, ?, 'legacy', ?)`)
      .run(subject.id, mapped && taxonomy.categories.some(item => item.id === mapped) ? mapped : null, subject.local?.kind ?? null);
  }
  const eligible = subject.source === 'local' || isThreeD(subject.boothCategory, subject.boothParent);
  const bodies = subject.source === 'booth' ? dict.entries.filter(entry => entry.bodyItemId === subject.ref) : [];
  const derived = !eligible ? [] : deriveAvatarTags(dict, subject.source === 'booth'
    ? { variations: subject.variations, tags: subject.tags, description: subject.description, body: { entries: bodies, title: subject.name } }
    : { tags: subject.tags });
  writeTags(db, subject.id, derived, dict);
  const categoryId = classification(db, subject.id)?.category_id ?? null;
  const universal = eligible ? universalBasis({ categoryId, name: subject.name, tags: subject.tags,
    fileKinds: subject.source === 'booth' ? fileKindsOf(db, subject.ref) : [] }) : '';
  const strong = fold([subject.name, subject.shop, ...subject.tags, ...subject.variations, subject.source === 'booth' ? subject.ref : '',
    subject.local ? subject.local.path.split(/[\\/]/).pop() ?? '' : ''].join('\n'));
  const listing = subject.source === 'booth' && /^\d{1,15}$/.test(subject.ref) ? Number(subject.ref) : null;
  db.prepare(`INSERT INTO asset_derivation (subject, source, ref, source_updated_at, files_stamp, dictionary_version, taxonomy_version, eligible,
      universal_basis, search_strong, search_weak, listing_key, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subject) DO UPDATE SET source_updated_at = excluded.source_updated_at, files_stamp = excluded.files_stamp,
      dictionary_version = excluded.dictionary_version, taxonomy_version = excluded.taxonomy_version, eligible = excluded.eligible,
      universal_basis = excluded.universal_basis, search_strong = excluded.search_strong, search_weak = excluded.search_weak,
      listing_key = excluded.listing_key, acquired_at = excluded.acquired_at, derived_at = ${now}`)
    .run(subject.id, subject.source, subject.ref, subject.updatedAt, filesStamp, dict.version, taxonomy.version, eligible ? 1 : 0, universal,
      strong, fold(subject.description), listing, subject.acquiredAt);
}

/** File kinds for files new, renamed or classified with an older dictionary. */
function deriveFiles(db: DatabaseSync, dict: AvatarDictionary, force: boolean): number {
  const rows = db.prepare(`SELECT f.downloadable_id AS id, f.item_id AS itemId, f.filename, k.filename AS known, k.dictionary_version AS version
    FROM booth_file f LEFT JOIN booth_file_kind k ON k.downloadable_id = f.downloadable_id`).all() as
    Array<{ id: string; itemId: string; filename: string; known: string | null; version: string | null }>;
  const stale = rows.filter(row => force || row.known !== row.filename || row.version !== dict.version);
  const orphans = Number((db.prepare('SELECT count(*) AS n FROM booth_file_kind WHERE downloadable_id NOT IN (SELECT downloadable_id FROM booth_file)')
    .get() as { n: number }).n);
  for (let i = 0; i < stale.length || (i === 0 && orphans); i += BATCH) transaction(db, () => {
    if (i === 0 && orphans) db.prepare('DELETE FROM booth_file_kind WHERE downloadable_id NOT IN (SELECT downloadable_id FROM booth_file)').run();
    const upsert = db.prepare(`INSERT INTO booth_file_kind (downloadable_id, item_id, filename, kind, avatars_json, reason, dictionary_version)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(downloadable_id) DO UPDATE SET item_id = excluded.item_id, filename = excluded.filename,
      kind = excluded.kind, avatars_json = excluded.avatars_json, reason = excluded.reason, dictionary_version = excluded.dictionary_version, derived_at = ${now}`);
    for (const row of stale.slice(i, i + BATCH)) {
      const result = classifyFile(dict, row.filename);
      upsert.run(row.id, row.itemId, row.filename, result.kind, JSON.stringify(result.avatars), result.reason, dict.version);
    }
  });
  return stale.length;
}

function filesStamps(db: DatabaseSync): Map<string, string> {
  const stamps = new Map<string, string[]>();
  for (const row of db.prepare('SELECT item_id AS itemId, downloadable_id AS id, filename FROM booth_file ORDER BY item_id, downloadable_id').all() as
    Array<{ itemId: string; id: string; filename: string }>) {
    const list = stamps.get(row.itemId) ?? []; list.push(`${row.id}=${row.filename}`); stamps.set(row.itemId, list);
  }
  return new Map([...stamps].map(([item, list]) => [item, list.join('|')]));
}

/** Items whose row, files, dictionary or vocabulary changed since they were derived. */
function deriveItems(db: DatabaseSync, dict: AvatarDictionary, taxonomy: Taxonomy, force: boolean, also: Set<string>): number {
  const known = new Map((db.prepare(`SELECT subject, source_updated_at AS updatedAt, files_stamp AS stamp, dictionary_version AS dictionary,
    taxonomy_version AS taxonomy FROM asset_derivation`).all() as Array<{ subject: string; updatedAt: string; stamp: string; dictionary: string; taxonomy: number }>)
    .map(row => [row.subject, row]));
  const stamps = filesStamps(db);
  const fresh = (id: string, updatedAt: string, stamp: string): boolean => {
    const row = known.get(id);
    return !force && !!row && row.updatedAt === updatedAt && row.stamp === stamp && row.dictionary === dict.version && row.taxonomy === taxonomy.version;
  };
  const booth = (db.prepare('SELECT item_id AS id, updated_at AS updatedAt FROM booth_item').all() as Array<{ id: string; updatedAt: string }>)
    .filter(row => also.has(row.id) || !fresh(`booth:${row.id}`, row.updatedAt, stamps.get(row.id) ?? '')).map(row => row.id);
  const local = (db.prepare('SELECT id, updated_at AS updatedAt FROM asset').all() as Array<{ id: string; updatedAt: string }>)
    .filter(row => !fresh(`local:${row.id}`, row.updatedAt, '')).map(row => row.id);
  // Rows whose item is gone (a BOOTH index rebuilt elsewhere; local rows are removed by the asset table's trigger).
  const orphaned = db.prepare(`SELECT subject FROM asset_derivation WHERE (source = 'booth' AND ref NOT IN (SELECT item_id FROM booth_item))
    OR (source = 'local' AND ref NOT IN (SELECT id FROM asset))`).all() as Array<{ subject: string }>;
  if (orphaned.length) transaction(db, () => {
    for (const { subject } of orphaned) for (const table of ['asset_derivation', 'asset_avatar_tag']) db.prepare(`DELETE FROM ${table} WHERE subject = ?`).run(subject);
  });
  for (let i = 0; i < booth.length; i += BATCH) {
    const rows = boothRows(db, booth.slice(i, i + BATCH));
    transaction(db, () => { for (const row of rows) deriveSubject(db, boothSubject(row), dict, taxonomy, stamps.get(row.item_id) ?? ''); });
  }
  for (let i = 0; i < local.length; i += BATCH) {
    const rows = localRows(db, local.slice(i, i + BATCH));
    transaction(db, () => { for (const row of rows) deriveSubject(db, localSubject(row), dict, taxonomy); });
  }
  return booth.length + local.length;
}

/** BOOTH items that are bodies: in the body category (or below it), or, not yet classified, in BOOTH's 3Dキャラクター. */
export function bodyItemIds(db: DatabaseSync, itemIds?: string[]): Set<string> {
  const taxonomy = currentTaxonomy(db), body = new Set(subtree(taxonomy, BODY_CATEGORY).map(item => item.id));
  const scope = itemIds ? 'WHERE i.item_id IN (SELECT value FROM json_each(?))' : '';
  const rows = db.prepare(`SELECT i.item_id AS id, c.subject, c.category_id AS categoryId FROM booth_item i
    LEFT JOIN asset_classification c ON c.subject = 'booth:' || i.item_id ${scope}`).all(...(itemIds ? [JSON.stringify(itemIds)] : [])) as
    Array<{ id: string; subject: string | null; categoryId: string | null }>;
  const found = new Set(rows.filter(row => row.subject && row.categoryId !== null && body.has(row.categoryId)).map(row => row.id));
  // Items not classified yet (before their first derivation): BOOTH's own category decides, read from the stored JSON.
  const unclassified = rows.filter(row => !row.subject).map(row => row.id);
  if (unclassified.length && body.has(BODY_CATEGORY)) for (const subject of boothRows(db, unclassified).map(boothSubject)) {
    const rule = boothCategoryRule({ category: subject.boothCategory, parent: subject.boothParent, name: subject.name, tags: subject.tags });
    if (rule.confident && rule.target === BODY_CATEGORY) found.add(subject.ref);
  }
  return found;
}

/**
 * Owned bodies teach the dictionary: an owned 3Dキャラクター product whose title names a known avatar marks that
 * avatar as owned (with the product as its body); one whose title gives one clean new name adds that avatar. An
 * ownership learned this way is withdrawn when the product is no longer owned. Returns the body products whose
 * avatar changed: ownership is not part of the dictionary version, so those items are derived again by name.
 */
function learnOwnedBodies(db: DatabaseSync, dict: AvatarDictionary): Set<string> {
  const bodies = [...bodyItemIds(db)];
  const owned = (bodies.length ? boothRows(db, bodies) : []).filter(row => row.owned === 1).map(boothSubject)
    .sort((a, b) => a.ref.length - b.ref.length || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const desired = new Map<string, { canonical: string; itemId: string }>();
  const added: Array<{ canonical: string; aliases: string[]; itemId: string }> = [];
  for (const body of owned) {
    const named = [...new Set([...findInText(dict, body.name).map(match => match.entry),
      ...body.variations.map(variation => matchToken(dict, variation)).filter((entry): entry is AvatarEntry => entry !== undefined)])];
    if (named.length) { for (const entry of named) if (!desired.has(entry.key)) desired.set(entry.key, { canonical: entry.canonical, itemId: body.ref }); continue; }
    const names = bodyNames(dict, body.name);
    if (names.canonical && !added.some(item => foldKey(item.canonical) === foldKey(names.canonical!)))
      added.push({ canonical: names.canonical, aliases: names.aliases, itemId: body.ref });
  }
  const updates = [...desired].filter(([key, want]) => { const entry = dict.lookup.get(key)!; return !entry.owned || entry.bodyItemId !== want.itemId; });
  const withdrawn = localEntryRows(db).filter(row => row.owned === 1 && row.owned_by === 'learned' && !desired.has(row.canonical_key)
    && !added.some(item => foldKey(item.canonical) === row.canonical_key));
  const touched = new Set<string>();
  if (!updates.length && !added.length && !withdrawn.length) return touched;
  transaction(db, () => {
    for (const [key, want] of updates) {
      const previous = dict.lookup.get(key)!.bodyItemId;
      if (previous) touched.add(previous);
      upsertLocalEntry(db, { canonical: want.canonical, owned: { value: true, by: 'learned', bodyItemId: want.itemId }, origin: 'learned' });
      touched.add(want.itemId);
    }
    for (const item of added) {
      upsertLocalEntry(db, { canonical: item.canonical, aliases: item.aliases, owned: { value: true, by: 'learned', bodyItemId: item.itemId },
        origin: 'learned', note: `来自已购素体商品 ${item.itemId}` });
      touched.add(item.itemId);
    }
    for (const row of withdrawn) {
      db.prepare(`UPDATE avatar_dictionary_entry SET owned = 0, owned_by = NULL, body_item_id = NULL, updated_at = ${now} WHERE canonical_key = ?`)
        .run(row.canonical_key);
      if (row.body_item_id) touched.add(row.body_item_id);
    }
  });
  return touched;
}

function runDiscovery(db: DatabaseSync, dict: AvatarDictionary): { pending: number; changed: boolean } {
  const bodies = bodyItemIds(db);
  const derivations = new Map((db.prepare(`SELECT ref, eligible FROM asset_derivation WHERE source = 'booth'`).all() as Array<{ ref: string; eligible: number }>)
    .map(row => [row.ref, row.eligible === 1]));
  const items: DiscoveryItem[] = boothRows(db).map(boothSubject).map(subject => ({ itemId: subject.ref, name: subject.name, shop: subject.shopKey,
    owned: subject.owned, body: bodies.has(subject.ref), eligible: derivations.get(subject.ref) ?? isThreeD(subject.boothCategory, subject.boothParent),
    variations: subject.variations, tags: subject.tags }));
  const shops = new Map(items.map(item => [item.itemId, item.shop]));
  const files: DiscoveryFile[] = (db.prepare(`SELECT item_id AS itemId, filename, avatars_json AS avatars FROM booth_file_kind`).all() as
    Array<{ itemId: string; filename: string; avatars: string }>).map(row => ({ itemId: row.itemId, shop: shops.get(row.itemId) ?? '',
    filename: row.filename, avatars: JSON.parse(row.avatars) as string[] }));
  return storeCandidates(db, discoverCandidates(dict, items, files));
}

export interface RefreshResult {
  items: number; files: number; learned: boolean; candidates: number;
  dictionaryVersion: string; taxonomyVersion: number; changed: boolean;
}
/**
 * Bring the catalog up to date with the stored index, dictionary and vocabulary. Cheap when nothing changed; safe to
 * call before every read. `force` derives everything again (the on-demand command).
 */
export function refreshAssetIndex(db: DatabaseSync, options: { force?: boolean } = {}): RefreshResult {
  const force = options.force === true;
  const taxonomy = currentTaxonomy(db);
  let dict = loadDictionary(db);
  const touched = learnOwnedBodies(db, dict), learned = touched.size > 0;
  if (learned) dict = loadDictionary(db);
  const files = deriveFiles(db, dict, force);
  const items = deriveItems(db, dict, taxonomy, force, touched);
  let candidates = (db.prepare(`SELECT count(*) AS n FROM avatar_dictionary_candidate WHERE status = 'pending'`).get() as { n: number }).n;
  let discovered = false;
  if (files || items || learned || force) ({ pending: candidates, changed: discovered } = runDiscovery(db, dict));
  const changed = files > 0 || items > 0 || learned || discovered;
  if (changed) db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json) VALUES ('runtime', 'asset_catalog', 'catalog',
    'derived', '素材索引已按当前词表和角色字典更新', ?)`).run(JSON.stringify({ items, files, learned, candidates, dictionaryVersion: dict.version,
    taxonomyVersion: taxonomy.version }));
  return { items, files, learned, candidates, dictionaryVersion: dict.version, taxonomyVersion: taxonomy.version, changed };
}

function requireSubject(db: DatabaseSync, id: string): Subject {
  if (!parseSubjectId(id)) throw coded('BAD_REQUEST', `素材 id 应为 booth:<商品 ID> 或 local:<素材 ID>：${id}`);
  const subject = loadSubject(db, id);
  if (!subject) throw coded('NOT_FOUND', `素材不存在：${id}`);
  return subject;
}
function rederive(db: DatabaseSync, subject: Subject): void {
  const stamps = subject.source === 'booth' ? filesStamps(db).get(subject.ref) ?? '' : '';
  deriveSubject(db, subject, loadDictionary(db), currentTaxonomy(db), stamps);
}

/** A person puts an item into a category (or into 未分类 with null). This is final: rules never change it again. */
export function assignCategory(db: DatabaseSync, id: string, category: string | null, actor = 'human'): { id: string; category: { id: string; path: string } | null } {
  const subject = requireSubject(db, id), taxonomy = currentTaxonomy(db);
  const target = category === null || isReserved(category) ? null : findCategory(taxonomy, category);
  if (category !== null && !isReserved(category) && !target) throw coded('BAD_REQUEST', `分类不存在：${category}`);
  if (target?.hidden) throw coded('BAD_REQUEST', `分类「${target.path}」已停用，不能再分配`);
  transaction(db, () => {
    db.prepare(`INSERT INTO asset_classification (subject, category_id, source) VALUES (?, ?, 'manual') ON CONFLICT(subject) DO UPDATE SET
      category_id = excluded.category_id, source = 'manual', suggestion_id = NULL, suggestion_reason = '', dismissed_suggestion_id = NULL,
      updated_at = ${now}`).run(subject.id, target?.id ?? null);
    db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json) VALUES (?, 'asset', ?, 'category_assigned', ?, ?)`)
      .run(actor, subject.id, `归类为${target ? `「${target.path}」` : '未分类'}`, JSON.stringify({ categoryId: target?.id ?? null, taxonomyVersion: taxonomy.version }));
    rederive(db, subject);
  });
  return { id: subject.id, category: target ? { id: target.id, path: target.path } : null };
}

/** Turn down the pending category suggestion of an item; the same suggestion is not made again. */
export function dismissSuggestion(db: DatabaseSync, id: string, actor = 'human'): void {
  const subject = requireSubject(db, id), row = classification(db, subject.id);
  if (!row?.suggestion_id) throw coded('NOT_FOUND', `这个素材没有待确认的分类建议：${id}`);
  transaction(db, () => {
    db.prepare(`UPDATE asset_classification SET dismissed_suggestion_id = suggestion_id, suggestion_id = NULL, suggestion_reason = '', updated_at = ${now}
      WHERE subject = ?`).run(subject.id);
    db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json) VALUES (?, 'asset', ?, 'suggestion_dismissed', '分类建议被拒绝', ?)`)
      .run(actor, subject.id, JSON.stringify({ suggestion: row.suggestion_id }));
  });
}

export type AvatarDecision = 'confirm' | 'reject' | 'add' | 'clear';
/**
 * A person's word on one avatar of one item: confirm or reject a derived tag, add an avatar chosen from the dictionary,
 * or clear an earlier decision. Only dictionary avatars can be added; a new name comes through the review queue or AI.
 */
export function decideAvatar(db: DatabaseSync, id: string, avatar: string, decision: AvatarDecision, actor = 'human'): void {
  const subject = requireSubject(db, id), dict = loadDictionary(db);
  const entry = resolveAvatar(dict, avatar);
  const existing = db.prepare('SELECT avatar_key, avatar FROM asset_avatar_tag WHERE subject = ? AND (avatar_key = ? OR avatar_key = ?)')
    .get(subject.id, entry?.key ?? '', foldKey(avatar)) as { avatar_key: string; avatar: string } | undefined;
  if ((decision === 'confirm' || decision === 'add') && !entry)
    throw coded('BAD_REQUEST', `角色字典里没有「${avatar}」：新角色要先在待确认里采纳，或由 AI 加入字典`);
  if (decision === 'reject' && !entry && !existing) throw coded('NOT_FOUND', `这个素材没有角色标签「${avatar}」`);
  const key = entry?.key ?? existing!.avatar_key, name = entry?.canonical ?? existing!.avatar;
  transaction(db, () => {
    if (decision === 'clear') db.prepare('DELETE FROM asset_avatar_decision WHERE subject = ? AND avatar_key = ?').run(subject.id, key);
    else db.prepare(`INSERT INTO asset_avatar_decision (subject, avatar_key, avatar, decision) VALUES (?, ?, ?, ?) ON CONFLICT(subject, avatar_key)
      DO UPDATE SET avatar = excluded.avatar, decision = excluded.decision, decided_at = ${now}`).run(subject.id, key, name, decision === 'reject' ? 'reject' : 'confirm');
    db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json) VALUES (?, 'asset', ?, ?, ?, ?)`)
      .run(actor, subject.id, `avatar_${decision}`, `${{ confirm: '确认', add: '添加', reject: '移除', clear: '撤回对' }[decision]}适配角色「${name}」`,
        JSON.stringify({ avatar: name, source: 'manual' }));
    rederive(db, subject);
  });
}
