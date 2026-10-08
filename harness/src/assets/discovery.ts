import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AvatarDictionary, AvatarEntry } from './avatars.ts';
import { findInText, matchToken, stripNameDecoration } from './avatars.ts';
import { findWord } from './classify.ts';
import { foldKey, hasCjk, isLatinKey } from './text.ts';

/**
 * Names the dictionary does not know yet, found in the person's own BOOTH index (a simple form of the reference
 * archive's discovery): bilingual variation names, names repeated across shops, owned bodies with an unknown name,
 * and files that serve two or three avatars at once. Every finding goes to the review queue as a question with
 * choices; discovery never writes the dictionary itself. A finding seen in at least two products from two shops is
 * marked strong and listed first.
 */
export type CandidateKind = 'new' | 'alias' | 'shares_body';
export interface CandidateEvidence { itemId: string; shop: string; text: string; source: 'variation' | 'tag' | 'title' | 'file' }
export interface CandidateDraft {
  id: string; kind: CandidateKind; name: string; nameKey: string; related: string | null; aliases: string[];
  evidence: CandidateEvidence[]; items: number; shops: number; strength: 'strong' | 'weak';
  origin: 'variation-bilingual' | 'variation-repeat' | 'tag-repeat' | 'owned-body' | 'shared-file';
}
export interface DiscoveryItem { itemId: string; name: string; shop: string; owned: boolean; body: boolean; eligible: boolean; variations: string[]; tags: string[] }
export interface DiscoveryFile { itemId: string; shop: string; filename: string; avatars: string[] }

/** Words that sit where a name sits (variation names, 〜対応 tags, brackets in a title) but name no avatar. */
const GENERIC_LATIN = ['pc', 'quest', 'android', 'ios', 'ver', 'version', 'full', 'fullset', 'set', 'lite', 'light', 'normal', 'standard',
  'basic', 'deluxe', 'dx', 'ex', 'sp', 'special', 'sample', 'free', 'fbx', 'blend', 'blender', 'unity', 'unitypackage', 'psd', 'png', 'zip',
  'vrm', 'vrc', 'vrchat', 'avatar', 'avatars', 'model', '3d', 'body', 'head', 'hair', 'texture', 'material', 'shader', 'liltoon', 'poiyomi',
  'physbone', 'physbones', 'vrcfury', 'mmd', 'sdk', 'gimmick', 'option', 'color', 'colour', 'type', 'new', 'original', 'package', 'bundle'];
const GENERIC_CJK = ['版', '通常', '限定', '無料', '有料', 'サンプル', '素体', '本体', '衣装', '髪', '表情', 'カラー', '差分', '対応', 'セット',
  'モデル', 'アバター', 'オリジナル', 'テクスチャ', 'マテリアル', 'シェーダー', 'ギミック', 'アクセサリー', '小物', '靴', '下着', '水着', '追加',
  'オプション', '単品', '同梱', '改変', '素材', '着せ替え', '色', 'パーツ', 'ヘア', 'アニメーション', 'モーション', '一式', '全部', '専用'];
const GENERIC_WORDS = [...GENERIC_LATIN, ...GENERIC_CJK];

/** Could this be an avatar's name? Short, not only digits, no generic product word, not a known non-avatar. */
export function plausibleName(dict: AvatarDictionary, name: string): boolean {
  const key = foldKey(name);
  const length = [...key].length;
  if (length < 2 || length > 24 || !/[\p{L}]/u.test(key) || key.split(' ').length > 3) return false;
  if (dict.notAvatarKeys.has(key)) return false;
  return findWord([key], GENERIC_WORDS) === undefined;
}

type Script = 'latin' | 'cjk' | 'mixed';
const scriptOf = (value: string): Script => isLatinKey(foldKey(value)) ? 'latin' : hasCjk(value) && !/\p{Script=Latin}/u.test(value) ? 'cjk' : 'mixed';
/** "マヌカ / MANUKA", "Rurune（ルルネ）", "しなの Shinano": two parts in two scripts, or undefined. */
export function bilingualParts(value: string): [string, string] | undefined {
  const normalized = value.normalize('NFKC').trim();
  let parts = normalized.split(/[/|・()[\]【】「」『』]+|\s+[-‐~〜]\s+/u).map(part => part.trim()).filter(Boolean);
  if (parts.length === 1) parts = normalized.split(/\s+/u).filter(Boolean);
  if (parts.length !== 2) return undefined;
  const [a, b] = parts as [string, string];
  const scripts = [scriptOf(a), scriptOf(b)];
  return scripts.includes('mixed') || scripts[0] === scripts[1] ? undefined : [a, b];
}

/**
 * The avatar name a body product's title gives, when the dictionary does not know it: the text in 「」『』【】[]()
 * or between dashes (-Karuru-). One clean name is the name; a Latin and a kana/kanji name together are the name and
 * its alias; anything else is only a guess for the review queue.
 */
export function bodyNames(dict: AvatarDictionary, title: string): { canonical?: string; aliases: string[]; guesses: string[] } {
  const normalized = title.normalize('NFKC');
  const found: string[] = [];
  for (const match of normalized.matchAll(/[「『【[(〈《"“]([^」』】\])〉》"”]{1,40})[」』】\])〉》"”]/gu)) found.push(match[1]!.trim());
  // A romanised name between dashes, as in 『カルル』-Karuru-.
  for (const match of normalized.matchAll(/[-‐~〜]\s*(\p{Script=Latin}[\p{Script=Latin}\d ._']{1,23}?)\s*[-‐~〜]/gu)) found.push(match[1]!.trim());
  const names = [...new Map(found.filter(name => plausibleName(dict, name) && !matchToken(dict, name)).map(name => [foldKey(name), name])).values()];
  if (!names.length && plausibleName(dict, normalized.trim()) && !matchToken(dict, normalized)) names.push(normalized.trim());
  if (names.length === 1) return { canonical: names[0], aliases: [], guesses: names };
  if (names.length === 2) {
    const latin = names.find(name => scriptOf(name) === 'latin'), cjk = names.find(name => scriptOf(name) === 'cjk');
    if (latin && cjk) return { canonical: latin, aliases: [cjk], guesses: names };
  }
  return { aliases: [], guesses: names };
}

const candidateId = (kind: CandidateKind, nameKey: string, related: string | null): string =>
  createHash('sha256').update(`${kind}\n${nameKey}\n${related ? foldKey(related) : ''}`).digest('hex').slice(0, 16);

export function discoverCandidates(dict: AvatarDictionary, items: DiscoveryItem[], files: DiscoveryFile[]): CandidateDraft[] {
  const drafts = new Map<string, CandidateDraft & { itemSet: Set<string>; shopSet: Set<string> }>();
  const note = (kind: CandidateKind, origin: CandidateDraft['origin'], name: string, related: AvatarEntry | null, aliases: string[],
    evidence: CandidateEvidence, strong = false): void => {
    const nameKey = foldKey(name), id = candidateId(kind, nameKey, related?.canonical ?? null);
    let draft = drafts.get(id);
    if (!draft) {
      draft = { id, kind, name, nameKey, related: related?.canonical ?? null, aliases: [], evidence: [], items: 0, shops: 0, strength: 'weak', origin,
        itemSet: new Set(), shopSet: new Set() };
      drafts.set(id, draft);
    }
    for (const alias of aliases) if (!draft.aliases.some(item => foldKey(item) === foldKey(alias))) draft.aliases.push(alias);
    if (draft.evidence.length < 8 && !draft.evidence.some(item => item.itemId === evidence.itemId && item.text === evidence.text)) draft.evidence.push(evidence);
    draft.itemSet.add(evidence.itemId); if (evidence.shop) draft.shopSet.add(foldKey(evidence.shop));
    if (strong) draft.strength = 'strong';
  };
  const unknown = (name: string): boolean => !matchToken(dict, name) && plausibleName(dict, name);
  for (const item of items.filter(entry => entry.eligible)) {
    const matchedVariations = item.variations.filter(variation => matchToken(dict, variation));
    for (const variation of item.variations) {
      const pair = bilingualParts(variation);
      if (pair) {
        const [a, b] = pair, known = [matchToken(dict, a), matchToken(dict, b)];
        const evidence: CandidateEvidence = { itemId: item.itemId, shop: item.shop, text: variation, source: 'variation' };
        if (known[0] && !known[1] && unknown(b)) note('alias', 'variation-bilingual', b, known[0], [], evidence);
        else if (known[1] && !known[0] && unknown(a)) note('alias', 'variation-bilingual', a, known[1], [], evidence);
        else if (!known[0] && !known[1] && unknown(a) && unknown(b)) {
          const [latin, other] = scriptOf(a) === 'latin' ? [a, b] : [b, a];
          note('new', 'variation-bilingual', latin, null, [other], evidence);
        }
        continue;
      }
      // An unknown variation beside variations that are known avatars is most likely another avatar.
      const name = stripNameDecoration(variation.normalize('NFKC').trim());
      if (matchedVariations.length && !matchedVariations.includes(variation) && unknown(name))
        note('new', 'variation-repeat', name, null, [], { itemId: item.itemId, shop: item.shop, text: variation, source: 'variation' });
    }
    for (const tag of item.tags) {
      const name = stripNameDecoration(tag.normalize('NFKC').trim());
      // Only 〜対応 / 〜用 tags claim a fit; a bare tag is as often a genre as a name.
      if (foldKey(name) !== foldKey(tag) && unknown(name))
        note('new', 'tag-repeat', name, null, [], { itemId: item.itemId, shop: item.shop, text: tag, source: 'tag' });
    }
    if (item.body && item.owned && !findInText(dict, item.name).length && !matchedVariations.length) {
      const names = bodyNames(dict, item.name);
      const name = names.canonical ?? names.guesses[0];
      if (name) note('new', 'owned-body', name, null, names.aliases, { itemId: item.itemId, shop: item.shop, text: item.name, source: 'title' }, true);
    }
  }
  const pairs = new Map<string, { a: AvatarEntry; b: AvatarEntry; items: Set<string>; shops: Set<string>; evidence: CandidateEvidence[] }>();
  for (const file of files) {
    const entries = [...new Set(file.avatars.map(name => matchToken(dict, name)).filter((entry): entry is AvatarEntry => Boolean(entry)))];
    if (entries.length < 2 || entries.length > 3) continue;
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const [a, b] = [entries[i]!, entries[j]!].sort((x, y) => x.key < y.key ? -1 : 1) as [AvatarEntry, AvatarEntry];
      if (a.sharesBodyWith.some(name => foldKey(name) === b.key) || b.sharesBodyWith.some(name => foldKey(name) === a.key)) continue;
      const key = `${a.key}\n${b.key}`, pair = pairs.get(key) ?? { a, b, items: new Set(), shops: new Set(), evidence: [] };
      pair.items.add(file.itemId); if (file.shop) pair.shops.add(foldKey(file.shop));
      if (pair.evidence.length < 8) pair.evidence.push({ itemId: file.itemId, shop: file.shop, text: file.filename, source: 'file' });
      pairs.set(key, pair);
    }
  }
  // One file for several avatars is weak evidence of a shared body: only a pattern across shops is worth a question.
  for (const pair of pairs.values()) if (pair.items.size >= 2 && pair.shops.size >= 2)
    for (const evidence of pair.evidence) note('shares_body', 'shared-file', pair.a.canonical, pair.b, [], evidence, true);
  return [...drafts.values()].map(({ itemSet, shopSet, ...draft }) => ({ ...draft, items: itemSet.size, shops: shopSet.size,
    strength: draft.strength === 'strong' || (itemSet.size >= 2 && shopSet.size >= 2) ? 'strong' : 'weak' }));
}

/** Keep the pending findings current. Decided findings are left alone, so an answered question is never asked again. */
export function storeCandidates(db: DatabaseSync, drafts: CandidateDraft[]): { pending: number; changed: boolean } {
  const existing = new Map((db.prepare(`SELECT id, status, name, aliases_json, evidence_json, items, shops, strength FROM avatar_dictionary_candidate`)
    .all() as Array<{ id: string; status: string; name: string; aliases_json: string; evidence_json: string; items: number; shops: number; strength: string }>)
    .map(row => [row.id, row]));
  let changed = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const keep = new Set<string>();
    for (const draft of drafts) {
      keep.add(draft.id);
      const row = existing.get(draft.id);
      if (row && row.status !== 'pending') continue;
      const aliases = JSON.stringify(draft.aliases), evidence = JSON.stringify(draft.evidence);
      if (row && row.name === draft.name && row.aliases_json === aliases && row.evidence_json === evidence && row.items === draft.items
        && row.shops === draft.shops && row.strength === draft.strength) continue;
      db.prepare(`INSERT INTO avatar_dictionary_candidate (id, kind, name, name_key, related, aliases_json, evidence_json, items, shops, strength, origin, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(id) DO UPDATE SET name = excluded.name, aliases_json = excluded.aliases_json,
        evidence_json = excluded.evidence_json, items = excluded.items, shops = excluded.shops, strength = excluded.strength, origin = excluded.origin,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(draft.id, draft.kind, draft.name, draft.nameKey, draft.related, aliases, evidence,
        draft.items, draft.shops, draft.strength, draft.origin);
      changed = true;
    }
    for (const [id, row] of existing) if (row.status === 'pending' && !keep.has(id)) {
      db.prepare('DELETE FROM avatar_dictionary_candidate WHERE id = ?').run(id); changed = true;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  const pending = (db.prepare(`SELECT count(*) AS n FROM avatar_dictionary_candidate WHERE status = 'pending'`).get() as { n: number }).n;
  return { pending, changed };
}
