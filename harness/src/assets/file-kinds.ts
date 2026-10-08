import type { AvatarDictionary, AvatarEntry } from './avatars.ts';
import { findInText } from './avatars.ts';
import { compact, extensionOf, filenameTokens, fold, hasCjk } from './text.ts';

/**
 * What one remote BOOTH file is, from its name alone:
 * - `material`: textures, shaders and their sources, which every avatar can use;
 * - `avatar`: a file for particular avatars, named in the file name (MANUKA, Rurune…);
 * - `other`: anything else (manuals, previews, bundles that name no avatar).
 *
 * A file plan fetches the materials plus the files for the target avatar, and nothing else; when an author put several
 * avatars into one archive, that archive is still one download (see the upgrade plan, §5).
 */
export type FileKind = 'material' | 'avatar' | 'other';
export interface FileKindResult { kind: FileKind; avatars: string[]; reason: string }

const MATERIAL_EXTENSIONS = new Set(['psd', 'psb', 'clip', 'sbsar', 'spp']);
const MATERIAL_WORDS = ['material', 'マテリアル', 'texture', 'テクスチャ', 'shader', 'シェーダー', '素材', 'substance', 'liltoon', 'poiyomi'].map(fold);
const MATERIAL_TOKENS = new Set(['psd', 'psb', 'tex', 'texs', 'mat', 'mats', 'uv']);
/** How many neighbouring tokens one avatar name may span (SiuSiu is Siu + Siu). */
const MAX_WINDOW = 4;

/**
 * Avatars named in a file name. Tokens are joined back into windows, longest first, and compared whole with the
 * dictionary's separator-free keys, so a name is never found inside a longer word (Fusion_Shader is not Sio) and a
 * name split by camelCase is found whole (SiuSiu). Kana and kanji runs are searched like free text.
 */
export function avatarsInFilename(dict: AvatarDictionary, filename: string): AvatarEntry[] {
  const tokens = filenameTokens(filename);
  const found: AvatarEntry[] = [];
  const add = (entry: AvatarEntry): void => { if (!found.includes(entry)) found.push(entry); };
  const taken = new Array<boolean>(tokens.length).fill(false);
  for (let size = Math.min(MAX_WINDOW, tokens.length); size >= 1; size--) {
    for (let start = 0; start + size <= tokens.length; start++) {
      if (taken.slice(start, start + size).some(Boolean)) continue;
      const window = tokens.slice(start, start + size);
      if (window.some(token => hasCjk(token))) continue;
      const entry = dict.fileKeys.get(compact(window.join('')));
      if (!entry) continue;
      for (let i = start; i < start + size; i++) taken[i] = true;
      add(entry);
    }
  }
  tokens.forEach((token, i) => { if (!taken[i] && hasCjk(token)) for (const match of findInText(dict, token)) add(match.entry); });
  // Keep the order in which the name mentions them.
  const position = (entry: AvatarEntry): number => {
    const folded = fold(filename), keys = [entry.key, ...entry.aliases.map(fold)];
    const hits = keys.map(key => folded.indexOf(key)).filter(at => at >= 0);
    return hits.length ? Math.min(...hits) : Number.MAX_SAFE_INTEGER;
  };
  return found.sort((a, b) => position(a) - position(b));
}

export function classifyFile(dict: AvatarDictionary, filename: string): FileKindResult {
  const avatars = avatarsInFilename(dict, filename).map(entry => entry.canonical);
  const extension = extensionOf(filename);
  const folded = fold(filename);
  const tokens = filenameTokens(filename).map(token => fold(token));
  // Materials come first: a texture source stays a material even when it names the avatar it was painted for.
  if (MATERIAL_EXTENSIONS.has(extension)) return { kind: 'material', avatars, reason: `扩展名 .${extension}` };
  const word = MATERIAL_WORDS.find(item => folded.includes(item));
  if (word) return { kind: 'material', avatars, reason: `文件名含「${word}」` };
  const token = tokens.find(item => MATERIAL_TOKENS.has(item));
  if (token) return { kind: 'material', avatars, reason: `文件名含独立词「${token}」` };
  if (avatars.length) return { kind: 'avatar', avatars, reason: `文件名含角色名：${avatars.join('、')}` };
  return { kind: 'other', avatars: [], reason: '文件名没有材质词，也没有认出角色' };
}

export const FILE_GROUPS: Array<{ kind: FileKind; label: string }> = [
  { kind: 'material', label: '材质文件 · 各角色通用' },
  { kind: 'avatar', label: '适配文件 · 按角色区分' },
  { kind: 'other', label: '其他文件 · 说明、预览等' },
];
