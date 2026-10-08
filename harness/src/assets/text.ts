/**
 * Text folding shared by the asset catalog: BOOTH category mapping, the avatar dictionary, file names and search all
 * compare folded text, so ＭＡＮＵＫＡ, MANUKA and manuka are one key, and so are マヌカ, ﾏﾇｶ and まぬか.
 *
 * Folding is NFKC, then case folding, then katakana to hiragana. The long vowel mark ー is deliberately not folded:
 * クマリー and クマリ stay different keys, so a dictionary has to list both spellings when both mean one avatar.
 */
export function fold(value: string): string {
  const cased = value.normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
  let out = '';
  for (const char of cased) {
    const code = char.codePointAt(0)!;
    // ァ..ヶ and the katakana iteration marks ヽヾ have hiragana twins 0x60 below; ー (U+30FC) and ・ (U+30FB) do not move.
    out += (code >= 0x30a1 && code <= 0x30f6) || code === 0x30fd || code === 0x30fe ? String.fromCodePoint(code - 0x60) : char;
  }
  return out;
}

/** A folded key for exact lookups: surrounding space removed and inner runs of space collapsed to one. */
export function foldKey(value: string): string {
  return fold(value).trim().replace(/\s+/g, ' ');
}

const CJK_LETTER = /[ぁ-ゖゝ-ゟァ-ヺー-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿가-힣々-〇〻\u{20000}-\u{2ffff}]/u;
/** A kana, kanji or hangul letter. The middle dot ・ and brackets are punctuation, not letters. */
export function isCjkLetter(char: string | undefined): boolean {
  return char !== undefined && CJK_LETTER.test(char);
}
export function hasCjk(value: string): boolean {
  for (const char of value) if (isCjkLetter(char)) return true;
  return false;
}
const LATIN_WORD = /[\p{Script=Latin}\p{Nd}]/u;
/** A letter or digit that continues a Latin-script word: its neighbours decide whether "sio" is a word or part of "fusion". */
export function isLatinWordChar(char: string | undefined): boolean {
  return char !== undefined && LATIN_WORD.test(char);
}
/** Latin script only (letters, digits, spaces and punctuation, no kana or kanji): such a key needs word boundaries. */
export function isLatinKey(key: string): boolean {
  if (hasCjk(key) || !/[\p{Script=Latin}\p{Nd}]/u.test(key)) return false;
  for (const char of key) if (/\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char)) return false;
  return true;
}

/** The code point just before `index` and the one starting at `end` (surrogate pairs kept whole). */
export function neighbours(text: string, index: number, end: number): [string | undefined, string | undefined] {
  let before: string | undefined;
  if (index > 0) {
    const low = text.charCodeAt(index - 1);
    before = low >= 0xdc00 && low <= 0xdfff && index > 1 ? text.slice(index - 2, index) : text[index - 1];
  }
  const after = end < text.length ? String.fromCodePoint(text.codePointAt(end)!) : undefined;
  return [before, after];
}

/** Separator-free folded form, so a file-name token sequence and a dictionary key meet: LUMINA_EX and LuminaEx agree. */
export function compact(value: string): string {
  return fold(value).replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

const EXTENSION = /\.[a-z][a-z0-9]{0,11}$/i;
/** The extension of a file name, folded and without the dot, or '' when the name has none. */
export function extensionOf(filename: string): string {
  const match = EXTENSION.exec(filename.normalize('NFKC'));
  return match ? match[0].slice(1).toLowerCase() : '';
}

type CharClass = 'cjk' | 'digit' | 'letter';
function charClass(char: string): CharClass | 'mark' {
  if (isCjkLetter(char)) return 'cjk';
  if (/\p{N}/u.test(char)) return 'digit';
  if (/\p{L}/u.test(char)) return 'letter';
  return 'mark';
}
/**
 * Tokens of a file name, split on separators, camelCase, letter/digit and script boundaries:
 * "OSEISO_MANUKA.zip" → OSEISO, MANUKA; "ChiffonChocolatLime" → Chiffon, Chocolat, Lime; "RURUNE1.3" → RURUNE, 1, 3;
 * "マヌカver2" → マヌカ, ver, 2. An upper-case run ends before a capital that starts a lower-case word (RURUNEVer →
 * RURUNE, Ver). Case is kept; callers fold. Tokens are fine-grained on purpose: a matcher joins neighbours again, so
 * "SiuSiu" (Siu, Siu) can still be one name.
 */
export function filenameTokens(filename: string): string[] {
  const base = filename.normalize('NFKC').replace(EXTENSION, '');
  const tokens: string[] = [];
  for (const segment of base.split(/[^\p{L}\p{N}\p{M}]+/u)) {
    let run = '', kind: CharClass | undefined;
    const flush = (): void => {
      if (!run) return;
      if (kind === 'letter') tokens.push(...(run.match(/\p{Lu}+(?![\p{Ll}])|\p{Lu}?[\p{Ll}\p{M}]+|\p{Lu}+|[\p{L}\p{M}]+/gu) ?? [run]));
      else tokens.push(run);
      run = '';
    };
    for (const char of segment) {
      const cls = charClass(char);
      // A combining mark stays with the letter before it.
      if (cls !== 'mark' && cls !== kind) { flush(); kind = cls; }
      run += char;
    }
    flush();
  }
  return tokens;
}
