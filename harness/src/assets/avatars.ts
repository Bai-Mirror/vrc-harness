import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AVATAR_SEED, type AvatarSeed } from './avatar-seed.ts';
import { compact, fold, foldKey, hasCjk, isCjkLetter, isLatinKey, isLatinWordChar, neighbours } from './text.ts';

/**
 * The avatar dictionary: which names are avatars, which spellings mean the same one, which avatars share a body.
 *
 * It is the shipped seed (avatar-seed.ts) plus what this computer added: learned from the person's own BOOTH purchases,
 * decided in the review queue, or imported from their own dictionary. Local additions live in the state database only
 * (avatar_dictionary_entry, avatar_dictionary_term); nothing personal is ever written back to the seed.
 *
 * The dictionary version is a hash of the vocabulary (names, aliases, shared bodies, not-avatar words). Every derived
 * avatar tag records the version it was derived with, so a changed dictionary re-derives every item, including items
 * that were complete before (the reference archive skipped those).
 */
export type AvatarOrigin = 'seed' | 'learned' | 'review' | 'import' | 'ai';
export interface AvatarEntry {
  canonical: string;
  /** The folded canonical name: the identity avatar tags and filters use. */
  key: string;
  aliases: string[];
  sharesBodyWith: string[];
  /** The person owns this avatar's body (learned from a 3Dキャラクター purchase, or imported). Not part of the version. */
  owned: boolean;
  bodyItemId: string | null;
  origin: AvatarOrigin;
}
export type PatternRule = 'latin' | 'short-cjk' | 'free';
interface TextPattern { key: string; entry: AvatarEntry; rule: PatternRule }
export interface AvatarDictionary {
  version: string;
  entries: AvatarEntry[];
  notAvatars: string[];
  /** Folded canonical names and aliases → entry. */
  lookup: Map<string, AvatarEntry>;
  notAvatarKeys: Set<string>;
  /** Longest first, for free text. */
  patterns: TextPattern[];
  /** Separator-free Latin keys → entry, for file-name tokens. */
  fileKeys: Map<string, AvatarEntry>;
  /** The longest file key, in tokens joined; bounds how many neighbouring tokens a file-name match tries. */
  conflicts: Array<{ alias: string; kept: string; dropped: string }>;
}

export interface LocalEntryRow {
  canonical_key: string; canonical: string; aliases_json: string; shares_body_with_json: string;
  owned: number; owned_by: string | null; body_item_id: string | null; origin: string;
}

const strings = (raw: string): string[] => { try { const value = JSON.parse(raw) as unknown; return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } };
const unique = (values: string[]): string[] => { const seen = new Set<string>(); return values.filter(value => { const key = foldKey(value); if (!key || seen.has(key)) return false; seen.add(key); return true; }); };

export function patternRule(key: string): PatternRule {
  if (isLatinKey(key)) return 'latin';
  return hasCjk(key) && [...key].length <= 2 ? 'short-cjk' : 'free';
}

/** Build the effective dictionary: the seed first, then local rows (a row with a seed name extends that entry). */
export function buildDictionary(seed: AvatarSeed, local: LocalEntryRow[] = [], localTerms: string[] = []): AvatarDictionary {
  const entries: AvatarEntry[] = [];
  const byCanonical = new Map<string, AvatarEntry>();
  for (const item of seed.avatars) {
    const entry: AvatarEntry = { canonical: item.canonical, key: foldKey(item.canonical), aliases: unique(item.aliases),
      sharesBodyWith: unique(item.sharesBodyWith ?? []), owned: false, bodyItemId: null, origin: 'seed' };
    entries.push(entry); byCanonical.set(entry.key, entry);
  }
  for (const row of [...local].sort((a, b) => a.canonical_key < b.canonical_key ? -1 : a.canonical_key > b.canonical_key ? 1 : 0)) {
    const key = foldKey(row.canonical_key || row.canonical);
    if (!key) continue;
    // A local name may also be a known alias: it then extends the entry that alias belongs to.
    const existing = byCanonical.get(key) ?? entries.find(entry => entry.aliases.some(alias => foldKey(alias) === key));
    if (existing) {
      existing.aliases = unique([...existing.aliases, ...strings(row.aliases_json)]).filter(alias => foldKey(alias) !== existing.key);
      existing.sharesBodyWith = unique([...existing.sharesBodyWith, ...strings(row.shares_body_with_json)]);
      existing.owned ||= row.owned === 1; existing.bodyItemId ??= row.body_item_id;
      continue;
    }
    const entry: AvatarEntry = { canonical: row.canonical, key, aliases: unique(strings(row.aliases_json)).filter(alias => foldKey(alias) !== key),
      sharesBodyWith: unique(strings(row.shares_body_with_json)), owned: row.owned === 1, bodyItemId: row.body_item_id,
      origin: (['learned', 'review', 'import', 'ai'].includes(row.origin) ? row.origin : 'review') as AvatarOrigin };
    entries.push(entry); byCanonical.set(key, entry);
  }
  const lookup = new Map<string, AvatarEntry>(), conflicts: AvatarDictionary['conflicts'] = [];
  const register = (name: string, entry: AvatarEntry): void => {
    const key = foldKey(name);
    if (!key) return;
    const current = lookup.get(key);
    if (current && current !== entry) { conflicts.push({ alias: name, kept: current.canonical, dropped: entry.canonical }); return; }
    lookup.set(key, entry);
  };
  // Canonical names first, so an alias can never take a name away from the avatar it belongs to.
  for (const entry of entries) register(entry.canonical, entry);
  for (const entry of entries) for (const alias of entry.aliases) register(alias, entry);
  const notAvatars = unique([...seed.notAvatars, ...localTerms]);
  const patterns = [...lookup.entries()].map(([key, entry]) => ({ key, entry, rule: patternRule(key) }))
    .sort((a, b) => b.key.length - a.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const fileKeys = new Map<string, AvatarEntry>();
  for (const pattern of patterns) if (pattern.rule === 'latin') { const key = compact(pattern.key); if (key && !fileKeys.has(key)) fileKeys.set(key, pattern.entry); }
  const version = createHash('sha256').update(JSON.stringify({ schema: 'harness-avatar-dictionary/1',
    avatars: entries.map(entry => [entry.canonical, entry.aliases, entry.sharesBodyWith]),
    notAvatars: notAvatars.map(foldKey).sort() })).digest('hex').slice(0, 16);
  return { version, entries, notAvatars, lookup, notAvatarKeys: new Set(notAvatars.map(foldKey)), patterns, fileKeys, conflicts };
}

export function localEntryRows(db: DatabaseSync): LocalEntryRow[] {
  return db.prepare(`SELECT canonical_key, canonical, aliases_json, shares_body_with_json, owned, owned_by, body_item_id, origin
    FROM avatar_dictionary_entry ORDER BY canonical_key`).all() as unknown as LocalEntryRow[];
}
/** The dictionary in effect on this computer: the shipped seed and the local additions in the state database. */
export function loadDictionary(db: DatabaseSync): AvatarDictionary {
  const terms = (db.prepare('SELECT term FROM avatar_dictionary_term ORDER BY term_key').all() as Array<{ term: string }>).map(row => row.term);
  return buildDictionary(AVATAR_SEED, localEntryRows(db), terms);
}

const SUFFIXES = ['対応版', '専用', '対応', '用'];
const HONORIFICS = ['ちゃん', 'さん'];
/** Remove the decoration a name carries in a tag or variation: brackets, then 対応版/専用/対応/用, then ちゃん/さん. */
export function stripNameDecoration(key: string): string {
  let value = key.replace(/^[\s[(【「『〈《<]+|[\s\])】」』〉》>]+$/gu, '');
  for (let changed = true; changed;) {
    changed = false;
    for (const suffix of [...SUFFIXES, ...HONORIFICS]) {
      if (value.length > suffix.length && value.endsWith(suffix)) {
        value = value.slice(0, -suffix.length).replace(/[\s・:：\-_/]+$/u, '');
        changed = true; break;
      }
    }
  }
  return value.trim();
}
/** A whole variation name or tag: an exact lookup first, then again without 対応/用 suffixes and honorifics. */
export function matchToken(dict: AvatarDictionary, token: string): AvatarEntry | undefined {
  const key = foldKey(token);
  if (!key) return undefined;
  const direct = dict.lookup.get(key);
  if (direct) return direct;
  const stripped = stripNameDecoration(key);
  return stripped && stripped !== key ? dict.lookup.get(stripped) : undefined;
}

export interface TextMatch { entry: AvatarEntry; alias: string; line: string }
function boundaryHolds(line: string, at: number, end: number, rule: PatternRule): boolean {
  if (rule === 'free') return true;
  const [before, after] = neighbours(line, at, end);
  // Latin names need word boundaries (Sio is not in Fusion); kana and kanji names of two letters or fewer must not sit
  // inside a longer word (しお is not in しおり).
  return rule === 'latin' ? !isLatinWordChar(before) && !isLatinWordChar(after) : !isCjkLetter(before) && !isCjkLetter(after);
}
/**
 * Avatars named in free text, line by line. Longer aliases claim their span first, so a short name cannot match inside
 * a longer one (ユギミヨ is Yugi, and the ミヨ in it is not Miyo).
 */
export function findInText(dict: AvatarDictionary, text: string): TextMatch[] {
  const matches: TextMatch[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = fold(raw);
    if (!line.trim()) continue;
    const taken: Array<[number, number]> = [];
    for (const pattern of dict.patterns) {
      for (let at = line.indexOf(pattern.key); at >= 0; at = line.indexOf(pattern.key, at + 1)) {
        const end = at + pattern.key.length;
        if (taken.some(([start, stop]) => at < stop && end > start) || !boundaryHolds(line, at, end, pattern.rule)) continue;
        taken.push([at, end]);
        matches.push({ entry: pattern.entry, alias: pattern.key, line: raw.trim().slice(0, 200) });
      }
    }
  }
  return matches;
}

const SECTION_MARKERS = ['対応アバター', '対応素体'].map(fold);
const SECTION_HEADER = /^[■□◆◇【▼▽◤◢＜<#＃━─═=]/u;
/**
 * The 対応アバター section of a product description, or undefined when it has none: the marker line, then the lines
 * below it up to the next heading, or the first blank line once the section has content.
 */
export function supportedAvatarSection(description: string): string | undefined {
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex(line => SECTION_MARKERS.some(marker => fold(line).includes(marker)));
  if (start < 0) return undefined;
  const first = lines[start]!, folded = fold(first);
  const marker = SECTION_MARKERS.find(item => folded.includes(item))!;
  const rest = folded.slice(folded.indexOf(marker) + marker.length).replace(/[\s:：】」』)\]・\-－]+/gu, '');
  const section = [first];
  let content = rest.length > 0;
  for (let i = start + 1; i < lines.length && section.length < 40; i++) {
    const line = lines[i]!, trimmed = line.trim();
    if (!trimmed) { if (content) break; continue; }
    if (SECTION_HEADER.test(trimmed)) break;
    section.push(line); content = true;
  }
  return section.join('\n');
}

export type TagSource = 'variation' | 'tag' | 'description' | 'title' | 'manual';
export type Confidence = 'high' | 'medium' | 'low';
export interface Evidence { source: TagSource; text: string }
export interface DerivedTag { entry: AvatarEntry; source: TagSource; confidence: Confidence; evidence: Evidence[] }
const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
/**
 * Avatar tags for one product from what its author wrote: variation names (high confidence), BOOTH tags (medium) and
 * the description (low), where only the 対応アバター section is read when there is one. These are the author's claims,
 * not proof of fit; the caller decides status (low confidence waits for review). A body product is also tagged with
 * the avatar it is (`body`: the dictionary entries whose body is this product), with its title as the evidence.
 */
export function deriveAvatarTags(dict: AvatarDictionary, input: { variations?: string[]; tags?: string[]; description?: string;
  body?: { entries: AvatarEntry[]; title: string } }): DerivedTag[] {
  const found = new Map<string, DerivedTag>();
  const add = (entry: AvatarEntry, source: TagSource, confidence: Confidence, text: string): void => {
    const current = found.get(entry.key);
    if (!current) { found.set(entry.key, { entry, source, confidence, evidence: [{ source, text }] }); return; }
    if (RANK[confidence] > RANK[current.confidence]) { current.source = source; current.confidence = confidence; }
    if (current.evidence.length < 6 && !current.evidence.some(item => item.source === source && item.text === text)) current.evidence.push({ source, text });
  };
  for (const entry of input.body?.entries ?? []) add(entry, 'title', 'high', input.body!.title);
  for (const variation of input.variations ?? []) { const entry = matchToken(dict, variation); if (entry) add(entry, 'variation', 'high', variation); }
  for (const tag of input.tags ?? []) { const entry = matchToken(dict, tag); if (entry) add(entry, 'tag', 'medium', tag); }
  const description = input.description ?? '';
  if (description.trim()) {
    const section = supportedAvatarSection(description) ?? description;
    for (const match of findInText(dict, section)) add(match.entry, 'description', 'low', match.line);
  }
  return [...found.values()];
}

/** Resolve a name the person or the AI chose (canonical or alias) to its entry. */
export function resolveAvatar(dict: AvatarDictionary, name: string): AvatarEntry | undefined {
  return dict.lookup.get(foldKey(name)) ?? matchToken(dict, name);
}

/** Add to or extend a local dictionary entry. Aliases and shared bodies are merged, never dropped. */
export function upsertLocalEntry(db: DatabaseSync, input: { canonical: string; aliases?: string[]; sharesBodyWith?: string[];
  owned?: { value: boolean; by: string; bodyItemId: string | null }; origin: Exclude<AvatarOrigin, 'seed'>; note?: string }): void {
  const key = foldKey(input.canonical);
  if (!key) throw Object.assign(new Error('角色名为空'), { code: 'BAD_REQUEST' });
  const row = db.prepare('SELECT aliases_json, shares_body_with_json FROM avatar_dictionary_entry WHERE canonical_key = ?').get(key) as
    { aliases_json: string; shares_body_with_json: string } | undefined;
  const aliases = unique([...(row ? strings(row.aliases_json) : []), ...(input.aliases ?? [])]).filter(alias => foldKey(alias) !== key);
  const shares = unique([...(row ? strings(row.shares_body_with_json) : []), ...(input.sharesBodyWith ?? [])]).filter(name => foldKey(name) !== key);
  if (!row) db.prepare(`INSERT INTO avatar_dictionary_entry (canonical_key, canonical, aliases_json, shares_body_with_json, owned, owned_by,
      body_item_id, origin, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key, input.canonical.trim(), JSON.stringify(aliases), JSON.stringify(shares),
    input.owned?.value ? 1 : 0, input.owned ? input.owned.by : null, input.owned?.bodyItemId ?? null, input.origin, input.note ?? '');
  else {
    db.prepare(`UPDATE avatar_dictionary_entry SET aliases_json = ?, shares_body_with_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE canonical_key = ?`).run(JSON.stringify(aliases), JSON.stringify(shares), key);
    if (input.owned) db.prepare(`UPDATE avatar_dictionary_entry SET owned = ?, owned_by = ?, body_item_id = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE canonical_key = ?`).run(input.owned.value ? 1 : 0, input.owned.by, input.owned.bodyItemId, key);
  }
}
export function addNotAvatar(db: DatabaseSync, term: string, origin: string): void {
  const key = foldKey(term);
  if (key) db.prepare('INSERT OR IGNORE INTO avatar_dictionary_term (term_key, term, origin) VALUES (?, ?, ?)').run(key, term.trim(), origin);
}

/** The dictionary as the API and the CLI show it. */
export function dictionaryView(dict: AvatarDictionary): { version: string; avatars: Array<{ canonical: string; aliases: string[];
  sharesBodyWith: string[]; owned: boolean; bodyItemId: string | null; origin: AvatarOrigin }>; notAvatars: string[];
  conflicts: AvatarDictionary['conflicts'] } {
  return { version: dict.version, avatars: dict.entries.map(entry => ({ canonical: entry.canonical, aliases: entry.aliases,
    sharesBodyWith: entry.sharesBodyWith, owned: entry.owned, bodyItemId: entry.bodyItemId, origin: entry.origin })),
  notAvatars: dict.notAvatars, conflicts: dict.conflicts };
}
