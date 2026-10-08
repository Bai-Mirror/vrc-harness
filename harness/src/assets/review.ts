import type { DatabaseSync } from 'node:sqlite';
import { addNotAvatar, loadDictionary, resolveAvatar, upsertLocalEntry, type AvatarEntry } from './avatars.ts';
import { assignCategory, decideAvatar, dismissSuggestion, refreshAssetIndex } from './derive.ts';
import { parseSubjectId, stringList } from './subjects.ts';
import { currentTaxonomy } from './taxonomy.ts';

/**
 * The review queue (待确认): what the rules could not settle, asked as questions with choices, never as text to fill
 * in. It holds category suggestions that differ from an item's non-manual category, avatar tags waiting for a person
 * (description matches), and dictionary candidates from discovery: a new avatar, another spelling of one, or two
 * avatars sharing a body. Answers are accept, reject, "same as X" or "shares a body with X", where X is chosen from
 * the dictionary.
 */
const coded = (code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT', message: string): Error => Object.assign(new Error(message), { code });

export type ReviewType = 'category' | 'avatar' | 'dictionary';
export type ReviewChoice = 'accept' | 'reject' | 'same_as' | 'shares_body';
export interface ReviewOption { choice: ReviewChoice; label: string; target?: string; needsTarget?: boolean }
export interface ReviewItem {
  id: string; type: ReviewType;
  /** Display group, as the reference review page groups them. */
  group: '分类建议' | '待确认角色' | '新角色' | '另一种写法' | '共用素体';
  question: string;
  subject?: { id: string; name: string; shop: string; thumbnail: string | null };
  detail: Record<string, unknown>;
  options: ReviewOption[];
}

/**
 * Review ids: `category:<item>`, `avatar:<item>:<avatar key>`, `avatars:<item>` (every pending avatar of one item) and
 * `dictionary:<candidate>`, each part URI-encoded so an item id may contain any character.
 */
export function reviewId(type: 'category' | 'avatar' | 'avatars' | 'dictionary', ...parts: string[]): string {
  return [type, ...parts.map(part => encodeURIComponent(part))].join(':');
}
function subjects(db: DatabaseSync, ids: string[]): Map<string, { id: string; name: string; shop: string; thumbnail: string | null }> {
  const booth = ids.map(parseSubjectId).filter(item => item?.source === 'booth').map(item => item!.ref);
  const local = ids.map(parseSubjectId).filter(item => item?.source === 'local').map(item => item!.ref);
  const out = new Map<string, { id: string; name: string; shop: string; thumbnail: string | null }>();
  for (const row of db.prepare('SELECT item_id AS ref, name, shop_name AS shop, images_json AS images FROM booth_item WHERE item_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(booth)) as Array<{ ref: string; name: string; shop: string; images: string }>)
    out.set(`booth:${row.ref}`, { id: `booth:${row.ref}`, name: row.name, shop: row.shop, thumbnail: stringList(row.images)[0] ?? null });
  for (const row of db.prepare('SELECT id AS ref, name FROM asset WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(local)) as Array<{ ref: string; name: string }>)
    out.set(`local:${row.ref}`, { id: `local:${row.ref}`, name: row.name, shop: '', thumbnail: null });
  return out;
}

export function reviewList(db: DatabaseSync, query: { type?: ReviewType; limit?: number; offset?: number } = {}): {
  items: ReviewItem[]; total: number; counts: Record<ReviewType, number> & { total: number }; taxonomyVersion: number; dictionaryVersion: string } {
  const taxonomy = currentTaxonomy(db), dict = loadDictionary(db), paths = new Map(taxonomy.categories.map(item => [item.id, item.path]));
  const categoryRows = (db.prepare(`SELECT subject, category_id AS categoryId, suggestion_id AS suggestionId, suggestion_reason AS reason, basis_json AS basis
    FROM asset_classification WHERE suggestion_id IS NOT NULL AND source <> 'manual' AND (category_id IS NULL OR suggestion_id <> category_id)
    ORDER BY subject`).all() as Array<{ subject: string; categoryId: string | null; suggestionId: string; reason: string; basis: string }>)
    .filter(row => paths.has(row.suggestionId));
  const avatarRows = db.prepare(`SELECT subject, avatar_key AS avatarKey, avatar, source, confidence, evidence, evidence_json AS evidenceJson
    FROM asset_avatar_tag WHERE status = 'pending' ORDER BY subject, avatar`).all() as
    Array<{ subject: string; avatarKey: string; avatar: string; source: string; confidence: string; evidence: string; evidenceJson: string }>;
  const candidates = db.prepare(`SELECT id, kind, name, related, aliases_json AS aliases, evidence_json AS evidence, items, shops, strength, origin
    FROM avatar_dictionary_candidate WHERE status = 'pending' ORDER BY CASE strength WHEN 'strong' THEN 0 ELSE 1 END, items DESC, shops DESC, name`).all() as
    Array<{ id: string; kind: 'new' | 'alias' | 'shares_body'; name: string; related: string | null; aliases: string; evidence: string; items: number;
      shops: number; strength: string; origin: string }>;
  const people = subjects(db, [...new Set([...categoryRows.map(row => row.subject), ...avatarRows.map(row => row.subject)])]);
  const pickTarget: Pick<ReviewOption, 'needsTarget'> = { needsTarget: true };
  const items: ReviewItem[] = [
    ...categoryRows.map(row => ({ id: reviewId('category', row.subject), type: 'category' as const, group: '分类建议' as const,
      question: `归为「${paths.get(row.suggestionId)}」？当前：${row.categoryId ? paths.get(row.categoryId) ?? '未分类' : '未分类'}`,
      subject: people.get(row.subject), detail: { current: row.categoryId ? { id: row.categoryId, path: paths.get(row.categoryId) ?? null } : null,
        suggestion: { id: row.suggestionId, path: paths.get(row.suggestionId) }, reason: row.reason, basis: JSON.parse(row.basis) as unknown },
      options: [{ choice: 'accept' as const, label: `采纳：${paths.get(row.suggestionId)}` }, { choice: 'reject' as const, label: '不采纳' }] })),
    ...avatarRows.map(row => ({ id: reviewId('avatar', row.subject, row.avatarKey), type: 'avatar' as const, group: '待确认角色' as const,
      question: `适配「${row.avatar}」？`, subject: people.get(row.subject),
      detail: { avatar: row.avatar, source: row.source, confidence: row.confidence, claim: '作者声明', evidence: row.evidence,
        evidenceList: JSON.parse(row.evidenceJson) as unknown[] },
      options: [{ choice: 'accept' as const, label: '是，适配' }, { choice: 'reject' as const, label: '不适配' }] })),
    ...candidates.map(row => {
      const group = row.kind === 'new' ? '新角色' as const : row.kind === 'alias' ? '另一种写法' as const : '共用素体' as const;
      const question = row.kind === 'new' ? `「${row.name}」是角色吗？` : row.kind === 'alias' ? `「${row.name}」是「${row.related}」的另一种写法吗？`
        : `「${row.name}」和「${row.related}」共用素体吗？`;
      const options: ReviewOption[] = row.kind === 'shares_body'
        ? [{ choice: 'accept', label: '共用素体' }, { choice: 'reject', label: '不是' }]
        : [{ choice: 'accept', label: row.kind === 'new' ? '是角色' : `同一个：${row.related}` },
          { choice: 'same_as', label: '同一个…', ...pickTarget }, { choice: 'shares_body', label: '共用素体…', ...pickTarget },
          { choice: 'reject', label: '不是' }];
      return { id: reviewId('dictionary', row.id), type: 'dictionary' as const, group, question,
        detail: { kind: row.kind, name: row.name, related: row.related, aliases: stringList(row.aliases), evidence: JSON.parse(row.evidence) as unknown[],
          items: row.items, shops: row.shops, strength: row.strength, origin: row.origin }, options };
    }),
  ];
  const selected = query.type ? items.filter(item => item.type === query.type) : items;
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000), offset = Math.max(query.offset ?? 0, 0);
  const counts = { category: categoryRows.length, avatar: avatarRows.length, dictionary: candidates.length, total: items.length };
  return { items: selected.slice(offset, offset + limit), total: selected.length, counts, taxonomyVersion: taxonomy.version, dictionaryVersion: dict.version };
}

export interface ReviewAnswer { id: string; choice: ReviewChoice; target?: string }
function targetEntry(db: DatabaseSync, target: string | undefined): AvatarEntry {
  if (!target) throw coded('BAD_REQUEST', '这个答案要从角色字典里选一个角色');
  const entry = resolveAvatar(loadDictionary(db), target);
  if (!entry) throw coded('BAD_REQUEST', `角色字典里没有「${target}」`);
  return entry;
}

/** Answer one question. Dictionary answers change the dictionary version, so every item is derived again. */
export function answerReview(db: DatabaseSync, answer: ReviewAnswer, actor = 'human'): { id: string; choice: ReviewChoice; dictionaryVersion?: string } {
  const [type, ...encoded] = answer.id.split(':');
  let rest: string[];
  try { rest = encoded.map(part => decodeURIComponent(part)); } catch { throw coded('BAD_REQUEST', `无法识别的待确认项：${answer.id}`); }
  if (type === 'category' && rest.length === 1) {
    const subject = rest[0]!;
    const row = db.prepare('SELECT suggestion_id AS suggestion FROM asset_classification WHERE subject = ? AND source <> \'manual\'').get(subject) as
      { suggestion: string | null } | undefined;
    if (!row?.suggestion) throw coded('NOT_FOUND', `待确认项不存在或已处理：${answer.id}`);
    if (answer.choice === 'accept') assignCategory(db, subject, row.suggestion, actor);
    else if (answer.choice === 'reject') dismissSuggestion(db, subject, actor);
    else throw coded('BAD_REQUEST', '分类建议只能采纳或不采纳');
    return { id: answer.id, choice: answer.choice };
  }
  if ((type === 'avatar' && rest.length === 2) || (type === 'avatars' && rest.length === 1)) {
    const subject = rest[0]!;
    const keys = type === 'avatars' ? (db.prepare(`SELECT avatar_key AS key FROM asset_avatar_tag WHERE subject = ? AND status = 'pending'`).all(subject) as Array<{ key: string }>).map(row => row.key)
      : [rest[1]!];
    if (answer.choice !== 'accept' && answer.choice !== 'reject') throw coded('BAD_REQUEST', '角色标签只能确认或移除');
    const tags = keys.map(key => db.prepare(`SELECT avatar FROM asset_avatar_tag WHERE subject = ? AND avatar_key = ? AND status = 'pending'`).get(subject, key) as
      { avatar: string } | undefined);
    if (!tags.length || tags.some(tag => !tag)) throw coded('NOT_FOUND', `待确认项不存在或已处理：${answer.id}`);
    for (const tag of tags) decideAvatar(db, subject, tag!.avatar, answer.choice === 'accept' ? 'confirm' : 'reject', actor);
    return { id: answer.id, choice: answer.choice };
  }
  if (type !== 'dictionary' || rest.length !== 1) throw coded('BAD_REQUEST', `无法识别的待确认项：${answer.id}`);
  const id = rest[0]!;
  const row = db.prepare(`SELECT kind, name, related, aliases_json AS aliases, evidence_json AS evidence, origin, status FROM avatar_dictionary_candidate WHERE id = ?`).get(id) as
    { kind: 'new' | 'alias' | 'shares_body'; name: string; related: string | null; aliases: string; evidence: string; origin: string; status: string } | undefined;
  if (!row) throw coded('NOT_FOUND', `待确认项不存在：${answer.id}`);
  if (row.status !== 'pending') throw coded('CONFLICT', `待确认项已处理：${answer.id}`);
  const aliases = stringList(row.aliases);
  const bodyItem = row.origin === 'owned-body' ? (JSON.parse(row.evidence) as Array<{ itemId?: string }>)[0]?.itemId ?? null : null;
  const owned = bodyItem ? { value: true, by: 'learned', bodyItemId: bodyItem } : undefined;
  let status: 'accepted' | 'rejected' = 'accepted';
  db.exec('BEGIN IMMEDIATE');
  try {
    const choice = answer.choice === 'accept' && row.kind === 'alias' ? 'same_as' : answer.choice;
    const target = answer.choice === 'accept' && row.kind === 'alias' ? row.related ?? undefined : answer.target;
    if (row.kind === 'shares_body') {
      if (choice === 'accept') {
        const other = targetEntry(db, row.related ?? undefined);
        upsertLocalEntry(db, { canonical: row.name, sharesBodyWith: [other.canonical], origin: 'review' });
        upsertLocalEntry(db, { canonical: other.canonical, sharesBodyWith: [row.name], origin: 'review' });
      } else if (choice === 'reject') status = 'rejected';
      else throw coded('BAD_REQUEST', '共用素体的问题只能回答是或不是');
    } else if (choice === 'accept') {
      upsertLocalEntry(db, { canonical: row.name, aliases, ...(owned ? { owned } : {}), origin: 'review' });
    } else if (choice === 'same_as') {
      const entry = targetEntry(db, target);
      upsertLocalEntry(db, { canonical: entry.canonical, aliases: [row.name, ...aliases], ...(owned ? { owned } : {}), origin: 'review' });
    } else if (choice === 'shares_body') {
      const entry = targetEntry(db, target);
      upsertLocalEntry(db, { canonical: row.name, aliases, sharesBodyWith: [entry.canonical], ...(owned ? { owned } : {}), origin: 'review' });
      upsertLocalEntry(db, { canonical: entry.canonical, sharesBodyWith: [row.name], origin: 'review' });
    } else if (choice === 'reject') {
      status = 'rejected';
      // "Not an avatar": remembered as a dictionary fact, so discovery stops offering the name anywhere.
      if (row.kind === 'new') addNotAvatar(db, row.name, 'review');
    } else throw coded('BAD_REQUEST', `无效的答案：${String(answer.choice)}`);
    db.prepare(`UPDATE avatar_dictionary_candidate SET status = ?, decision_json = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(status, JSON.stringify({ choice: answer.choice, target: target ?? null }), id);
    db.prepare(`INSERT INTO event (actor, entity_type, entity_id, action, reason, payload_json) VALUES (?, 'avatar_dictionary', ?, ?, ?, ?)`)
      .run(actor, id, `candidate_${status}`, `角色字典待确认：${row.name}（${answer.choice}）`, JSON.stringify({ kind: row.kind, choice: answer.choice, target: target ?? null }));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const refreshed = refreshAssetIndex(db);
  return { id: answer.id, choice: answer.choice, dictionaryVersion: refreshed.dictionaryVersion };
}
