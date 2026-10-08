import type { FileKind } from './file-kinds.ts';
import { fold, foldKey, isLatinKey, isLatinWordChar, neighbours } from './text.ts';

/**
 * First-round category rules for BOOTH products (reference-site checklist §6.1). They read only what a sync stored:
 * the category name and its parent from the product JSON, the title and the tags. Descriptions and file names never
 * decide a category.
 */
const BOOTH_CATEGORY_MAP: ReadonlyArray<[string, string | null]> = [
  ['3Dキャラクター', 'body'], ['3D衣装', 'outfit'], ['3D髪型', 'hair'],
  ['3D装飾品', 'accessory'], ['3Dアクセサリー', 'accessory'], ['3D小道具', 'accessory'], ['3D小物', 'accessory'],
  ['3Dテクスチャ', 'texture'], ['3Dモーション・アニメーション', 'toy'],
  ['3Dツール・システム', 'plugin'], ['ソフトウェア', 'plugin'], ['スクリプト', 'plugin'], ['ツール', 'plugin'], ['unity', 'plugin'],
  // Deliberately mapped to nothing: "other 3D models" says nothing about what the product is.
  ['3Dモデル（その他）', null],
];
const MAPPING = new Map(BOOTH_CATEGORY_MAP.map(([name, id]) => [foldKey(name), id]));
/** These two categories decide on their own; a hair word in the title does not override them. */
const AUTHORITATIVE = new Set(['3Dキャラクター', '3D髪型'].map(foldKey));
export const HAIR_WORDS = ['ヘアー', 'ヘアスタイル', '髪型', '髪', 'hair', '发型', '髮型'];
/** Positive evidence that a product does not depend on an avatar; without it an untagged product is only "not recognised". */
export const UNIVERSAL_WORDS = ['汎用', '全アバター', '全素体', 'universal', '通用'];

export interface CategoryRule {
  /** The category id the rule points at, or null for none. */
  target: string | null;
  /** Confident rules may be applied to an item that has no category yet; the others are only suggestions. */
  confident: boolean;
  rule: 'authoritative' | 'category' | 'parent' | 'hair-word' | 'unmapped' | 'unknown';
  reason: string;
  basis: { category: string; parent: string; hairWord?: string };
}

/** The first of `words` found in one of the texts, as a whole word (Latin) or anywhere (kana, kanji); compared folded. */
export function findWord(texts: string[], words: string[]): string | undefined {
  for (const text of texts) {
    const folded = fold(text);
    for (const word of words) {
      const key = fold(word);
      for (let at = folded.indexOf(key); at >= 0; at = folded.indexOf(key, at + 1)) {
        if (!isLatinKey(key)) return word;
        const [before, after] = neighbours(folded, at, at + key.length);
        if (!isLatinWordChar(before) && !isLatinWordChar(after)) return word;
      }
    }
  }
  return undefined;
}

/** The category a BOOTH product's own category (then its parent) and title say, and whether that is safe to apply. */
export function boothCategoryRule(input: { category: string; parent: string; name: string; tags: string[] }): CategoryRule {
  const basis = { category: input.category, parent: input.parent };
  const own = foldKey(input.category), parent = foldKey(input.parent);
  const key = MAPPING.has(own) ? own : MAPPING.has(parent) ? parent : undefined;
  const target = key === undefined ? null : MAPPING.get(key)!;
  const via = key === own ? 'category' : 'parent';
  if (key !== undefined && AUTHORITATIVE.has(key))
    return { target, confident: true, rule: 'authoritative', reason: `BOOTH 分类「${key === own ? input.category : input.parent}」直接决定`, basis };
  const hairWord = findWord([input.name, ...input.tags], HAIR_WORDS);
  if (hairWord) return { target: 'hair', confident: false, rule: 'hair-word', reason: `标题或标签含发型词「${hairWord}」，只作建议`, basis: { ...basis, hairWord } };
  if (target) return { target, confident: true, rule: via, reason: `BOOTH ${via === 'category' ? '分类' : '父分类'}「${via === 'category' ? input.category : input.parent}」`, basis };
  return { target: null, confident: false, rule: key === undefined ? 'unknown' : 'unmapped',
    reason: key === undefined ? (input.category ? `BOOTH 分类「${input.category}」没有对应` : '没有 BOOTH 分类信息') : `BOOTH 分类「${input.category || input.parent}」不对应任何分类`, basis };
}

/** Only products in BOOTH's 3D categories get avatar tags: an illustration that mentions an avatar does not fit one. */
export function isThreeD(category: string, parent: string): boolean {
  return foldKey(category).startsWith('3d') || foldKey(parent).startsWith('3d');
}

/**
 * Why an item without confirmed avatar tags is universal, or '' when nothing says so: a tool or plugin, files that
 * are all materials, or an explicit universal word in the title or tags.
 */
export function universalBasis(input: { categoryId: string | null; name: string; tags: string[]; fileKinds: FileKind[] }): string {
  if (input.categoryId === 'plugin') return 'category:plugin';
  if (input.fileKinds.length && input.fileKinds.every(kind => kind === 'material')) return 'files:material';
  const word = findWord([input.name, ...input.tags], UNIVERSAL_WORDS);
  return word ? `word:${word}` : '';
}
