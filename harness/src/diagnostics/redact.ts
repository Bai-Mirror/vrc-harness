import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { HOME_PATH_PATTERN, PRIVACY_PATTERNS, SECRET_PATTERN_IDS, globalFlags, type PrivacyPattern } from '../shared/privacy-patterns.mjs';

/**
 * Redaction for anything the product hands to someone else (`DATA/D5`): a path that names this machine becomes a
 * placeholder, an order number or a login state is replaced, and a local vocabulary can name what only this person
 * knows. The rule list is the same one the repository scanner uses (`shared/privacy-patterns.mjs`), so a rule added
 * for the development-time scan protects an exported diagnostics bundle too, and the reverse.
 *
 * What this is not: a verdict. Replacing a match does not make the rest of a file safe, and a file with no match is
 * not thereby anonymous (合同 §4.6). The caller still previews the list, and refuses on a credential.
 */

/** A path this machine knows, and the placeholder a reader gets instead. */
export interface LocalRoot { path: string; label: string }
/** One entry of a person's own vocabulary (`<AVH_HOME>/config/privacy-words.json`). */
export interface PrivacyWord { id: string; source: string; flags: string; replacement: string }

export interface RedactOptions {
  /** Paths to replace. `roots` is built by `diagnosticRoots`; order in the list does not matter. */
  roots?: LocalRoot[];
  /** Literal strings from a local vocabulary. */
  words?: PrivacyWord[];
  /** Label for a bare `C:\Users\<name>\` or `/home/<name>/` that no root covers. */
  homeLabel?: string;
}

export interface RedactionHit { id: string; replacement: string; count: number }
export interface RedactionResult { text: string; hits: RedactionHit[] }
export interface PrivacyWordsRead { words: PrivacyWord[]; problems: string[]; path: string }

const WINDOWS = process.platform === 'win32';
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Case-insensitive comparison where the file system is; a path in a log may be spelled either way. */
const fold = (value: string): string => WINDOWS ? value.toLowerCase() : value;
/** Every text is compared with `/` separators, so one rule covers `C:\a\b` and `C:/a/b`. */
const slashes = (value: string): string => value.replace(/\\/g, '/');
/** Trailing separators are not part of a root's identity, but a bare drive or `/` is too short to replace. */
const trimRoot = (value: string): string => value.replace(/[\\/]+$/, '');

const IGNORED_WORD_KEYS = new Set(['id', 'regex', 'literal', 'flags', 'replacement', 'note', 'scopes']);

/**
 * Read a person's local privacy vocabulary. Absent, unreadable or shape-wrong all mean "no extra words and a stated
 * reason", never a failed export: a diagnostic bundle that refuses to be produced because a convenience file is
 * malformed is worse than one that carries an extra line saying the file was skipped.
 */
export function readPrivacyWords(home: string, path = join(home, 'config', 'privacy-words.json')): PrivacyWordsRead {
  if (!existsSync(path)) return { words: [], problems: [], path };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) { return { words: [], problems: [`本地隐私词表无法解析（${(error as Error).message}）`], path }; }
  const source = raw as { patterns?: unknown } | null;
  if (!source || typeof source !== 'object' || !Array.isArray(source.patterns)) return { words: [], problems: ['本地隐私词表缺少 patterns 列表'], path };
  const words: PrivacyWord[] = [], problems: string[] = [], ids = new Set<string>();
  for (const entry of source.patterns as Array<Record<string, unknown>>) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id)) { problems.push('本地隐私词表有一条缺少合法 id，或 id 重复'); continue; }
    const extra = Object.keys(entry).filter(key => !IGNORED_WORD_KEYS.has(key));
    if (extra.length) { problems.push(`本地隐私词表条目 ${id} 含不支持的字段 ${extra.join('、')}`); continue; }
    const literal = typeof entry.literal === 'string' ? entry.literal : undefined;
    const regex = typeof entry.regex === 'string' ? entry.regex : undefined;
    if (literal === undefined && regex === undefined) { problems.push(`本地隐私词表条目 ${id} 既没有 literal 也没有 regex`); continue; }
    if (literal !== undefined && regex !== undefined) { problems.push(`本地隐私词表条目 ${id} 同时给出 literal 与 regex`); continue; }
    const flags = typeof entry.flags === 'string' && /^[gimsuy]*$/.test(entry.flags) ? entry.flags : 'g';
    const body = literal === undefined ? regex! : escapeRegExp(literal);
    try { new RegExp(body, globalFlags(flags)); }
    catch (error) { problems.push(`本地隐私词表条目 ${id} 的表达式无效（${(error as Error).message}）`); continue; }
    ids.add(id);
    words.push({ id, source: body, flags, replacement: typeof entry.replacement === 'string' && !/[\r\n]/.test(entry.replacement)
      ? entry.replacement : '<PRIVATE>' });
  }
  return { words, problems, path };
}

/** Replace every occurrence of `needle` in `text`, comparing with `/` separators and this host's case rules. */
function replaceAll(text: string, needle: string, replacement: string, onHit: () => void): string {
  const haystack = fold(slashes(text)), target = fold(slashes(needle));
  let out = '', from = 0;
  for (;;) {
    const at = haystack.indexOf(target, from);
    if (at < 0) return out + text.slice(from);
    out += `${text.slice(from, at)}${replacement}`;
    onHit();
    from = at + target.length;
  }
}
/** A bare user home (`C:\Users\someone\`, `/home/someone/`) that no more specific root claimed. */
function applyHomePath(text: string, label: string, onHit: () => void): string {
  const regex = new RegExp(HOME_PATH_PATTERN.regex, globalFlags(HOME_PATH_PATTERN.flags));
  return text.replace(regex, (match: string, name: string | undefined) => {
    onHit();
    return name ? `${match.slice(0, match.length - name.length)}${label}` : label;
  });
}
function builtinRules(scope: 'content' | 'path'): Array<{ id: string; regex: RegExp; replacement: string }> {
  const rules: Array<{ id: string; regex: RegExp; replacement: string }> = [];
  for (const pattern of PRIVACY_PATTERNS as PrivacyPattern[]) {
    if (!(pattern.scopes ?? ['content', 'path', 'metadata']).includes(scope)) continue;
    rules.push({ id: pattern.id, regex: new RegExp(pattern.regex, globalFlags(pattern.flags)),
      replacement: pattern.id === 'private-user-path' ? '<HOME>' : `<${pattern.id.toUpperCase()}>` });
  }
  return rules;
}
/** A `path` rule never runs over log content, and a content rule never runs over a member's name. */
const CONTENT_RULES = builtinRules('content');
const PATH_RULES = builtinRules('path');

/**
 * Detectors the product adds on top of the shared repository rules (R28 P2-1). They stay here rather than in
 * `shared/privacy-patterns.mjs`: that list's historical scan behaviour is frozen (R28 P2-4), while these shapes
 * matter for what a bundle hands to someone else. All of them are credentials the shared list either misses (an
 * unquoted `Authorization: Bearer` header) or only half-recognises (the private key's opening marker, leaving the
 * body).
 *
 * The private key has two rules, and the order matters (R28 2nd round): the complete block is removed first, then a
 * `BEGIN` with no `END` removes everything from that marker to the end of the text. Matching only the complete block
 * left an unterminated key's body behind -- and because the shared marker rule then replaced just the `BEGIN` line,
 * the post-export scan had nothing left to refuse.
 */
const PRODUCT_CONTENT_RULES: Array<{ id: string; regex: RegExp; replacement: string }> = [
  { id: 'private-key-block',
    regex: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY(?: BLOCK)?-----/g,
    replacement: '<PRIVATE-KEY>' },
  { id: 'private-key-unterminated',
    regex: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY(?: BLOCK)?-----[\s\S]*/g,
    replacement: '<PRIVATE-KEY>' },
  { id: 'authorization-header', regex: /\bauthorization\s*:\s*bearer\s+[a-z0-9%+/_.=-]{8,}/gi, replacement: '<AUTHORIZATION-HEADER>' },
];
/** Non-credential patterns the post-export scan must ask about as well, so a private path or order id is refused too. */
const SENSITIVE_PATTERN_IDS = new Set(['private-user-path', 'order-id']);

function tally(hits: Map<string, RedactionHit>): RedactionHit[] {
  return [...hits.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function hit(hits: Map<string, RedactionHit>, id: string, replacement: string): void {
  const prior = hits.get(id);
  if (prior) prior.count++;
  else hits.set(id, { id, replacement, count: 1 });
}
/**
 * Redact one piece of text. Roots are tried longest first, so `C:\Users\alice\work\Project` becomes `<PROJECT>`
 * rather than `<HOME>Project`.
 */
export function redactText(text: string, options: RedactOptions = {}): RedactionResult {
  const hits = new Map<string, RedactionHit>();
  let out = text;
  for (const root of [...(options.roots ?? [])].filter(root => trimRoot(root.path).length >= 4)
    .sort((a, b) => b.path.length - a.path.length))
    out = replaceAll(out, trimRoot(root.path), root.label, () => hit(hits, `root:${root.label}`, root.label));
  out = applyHomePath(out, options.homeLabel ?? '<HOME>', () => hit(hits, HOME_PATH_PATTERN.id, options.homeLabel ?? '<HOME>'));
  // The private-key rules run before the shared marker rule, and the complete-block rule before the unterminated
  // one, so neither a whole key nor a `BEGIN` whose `END` never arrived can leave its body behind.
  for (const rule of PRODUCT_CONTENT_RULES) {
    rule.regex.lastIndex = 0;
    out = out.replace(rule.regex, () => { hit(hits, rule.id, rule.replacement); return rule.replacement; });
  }
  for (const rule of [...CONTENT_RULES, ...(options.words ?? []).map(word => ({
    id: `word:${word.id}`, regex: new RegExp(word.source, globalFlags(word.flags)), replacement: word.replacement }))]) {
    rule.regex.lastIndex = 0;
    out = out.replace(rule.regex, () => { hit(hits, rule.id, rule.replacement); return rule.replacement; });
  }
  return { text: out, hits: tally(hits) };
}

/** Redact a path or a file name; the `path` rules run here, the `content` rules do not. */
export function redactPath(path: string, options: RedactOptions = {}): string {
  const hits = new Map<string, RedactionHit>();
  let out = path;
  for (const root of [...(options.roots ?? [])].filter(root => trimRoot(root.path).length >= 4)
    .sort((a, b) => b.path.length - a.path.length))
    out = replaceAll(out, trimRoot(root.path), root.label, () => hit(hits, `root:${root.label}`, root.label));
  out = applyHomePath(out, options.homeLabel ?? '<HOME>', () => hit(hits, HOME_PATH_PATTERN.id, options.homeLabel ?? '<HOME>'));
  for (const rule of [...PATH_RULES, ...(options.words ?? []).map(word => ({
    id: `word:${word.id}`, regex: new RegExp(word.source, globalFlags(word.flags)), replacement: word.replacement }))]) {
    rule.regex.lastIndex = 0;
    out = out.replace(rule.regex, () => { hit(hits, rule.id, rule.replacement); return rule.replacement; });
  }
  return out;
}

/**
 * Whether text still carries a credential or login state. The built-in patterns are replaced in place by
 * `redactText`, so this asks again rather than assuming, and it is the check that lets an export refuse instead of
 * shipping. A `path`-scoped credential rule (a file name such as `.env`) is only asked about when `path` is true.
 */
export function credentialHits(text: string, scope: 'content' | 'path' = 'content'): string[] {
  const found: string[] = [];
  for (const pattern of PRIVACY_PATTERNS as PrivacyPattern[]) {
    if (!SECRET_PATTERN_IDS.has(pattern.id)) continue;
    if (!(pattern.scopes ?? ['content', 'path', 'metadata']).includes(scope)) continue;
    if (new RegExp(pattern.regex, globalFlags(pattern.flags)).test(text)) found.push(pattern.id);
  }
  if (scope === 'content') for (const rule of PRODUCT_CONTENT_RULES) {
    rule.regex.lastIndex = 0;
    if (new RegExp(rule.regex.source, globalFlags(rule.regex.flags)).test(text)) found.push(rule.id);
  }
  return found;
}

/**
 * Everything an exported member must not still carry (R28 P1-2): a credential, a private user path, an order id, or a
 * word from this machine's own vocabulary. Redaction already replaced these, so asking again is a second chance to
 * refuse rather than a filter: a hit here means the bundle is not written at all.
 */
export function sensitiveHits(text: string, scope: 'content' | 'path' = 'content', options: RedactOptions = {}): string[] {
  const found = credentialHits(text, scope);
  for (const pattern of PRIVACY_PATTERNS as PrivacyPattern[]) {
    if (!SENSITIVE_PATTERN_IDS.has(pattern.id)) continue;
    if (!(pattern.scopes ?? ['content', 'path', 'metadata']).includes(scope)) continue;
    if (new RegExp(pattern.regex, globalFlags(pattern.flags)).test(text)) found.push(pattern.id);
  }
  const home = new RegExp(HOME_PATH_PATTERN.regex, globalFlags(HOME_PATH_PATTERN.flags));
  if (home.test(text)) found.push(HOME_PATH_PATTERN.id);
  for (const word of options.words ?? []) {
    const regex = new RegExp(word.source, globalFlags(word.flags));
    if (regex.test(text)) found.push(`word:${word.id}`);
  }
  return [...new Set(found)];
}

/** The roots a bundle may name, longest-first so the most specific placeholder wins. */
export function diagnosticRoots(input: { project: string; home: string; workspaceRoot?: string; pool?: string;
  toolRoot?: string; knowledgeRoot?: string; assetSearchRoots?: string[] }): LocalRoot[] {
  const roots: LocalRoot[] = [{ path: input.project, label: '<PROJECT>' }, { path: input.home, label: '<AVH_HOME>' }];
  if (input.workspaceRoot) roots.push({ path: input.workspaceRoot, label: '<WORKSPACE>' });
  if (input.pool) roots.push({ path: input.pool, label: '<POOL>' });
  if (input.toolRoot) roots.push({ path: input.toolRoot, label: '<TOOL_ROOT>' });
  if (input.knowledgeRoot) roots.push({ path: input.knowledgeRoot, label: '<KNOWLEDGE_ROOT>' });
  for (const root of input.assetSearchRoots ?? []) roots.push({ path: root, label: '<MATERIAL_ROOT>' });
  return roots.sort((a, b) => b.path.length - a.path.length);
}

/** Absolute, comparable spelling of a root. */
export const rootKey = (path: string): string => fold(resolve(path)).replace(/[\\/]+$/, '');
/** Whether `path` is inside a root: the boundary an exported bundle may not read past. */
export function withinRoot(path: string, root: string): boolean {
  const key = rootKey(path), base = rootKey(root);
  return key === base || key.startsWith(`${base}${sep}`) || key.startsWith(`${base}/`);
}
