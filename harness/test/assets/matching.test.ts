import assert from 'node:assert/strict';
import test from 'node:test';
import { AVATAR_SEED } from '../../src/assets/avatar-seed.ts';
import { buildDictionary, deriveAvatarTags, findInText, matchToken, supportedAvatarSection } from '../../src/assets/avatars.ts';
import { boothCategoryRule, isThreeD } from '../../src/assets/classify.ts';
import { bilingualParts, bodyNames } from '../../src/assets/discovery.ts';
import { avatarsInFilename, classifyFile } from '../../src/assets/file-kinds.ts';
import { filenameTokens, fold } from '../../src/assets/text.ts';

const dict = buildDictionary(AVATAR_SEED);
const names = (text: string): string[] => [...new Set(findInText(dict, text).map(match => match.entry.canonical))];

test('folding is NFKC, case folding and katakana to hiragana, and leaves the long vowel mark alone', () => {
  assert.equal(fold('ＭＡＮＵＫＡ'), 'manuka');
  assert.equal(fold('マヌカ'), 'まぬか');
  assert.equal(fold('ﾏﾇｶ'), 'まぬか', 'half-width katakana folds too');
  assert.equal(fold('ヴ'), 'ゔ');
  assert.notEqual(fold('クマリー'), fold('クマリ'));
  assert.equal(fold('クマリー'), 'くまりー');
});

test('the shipped seed is the reference dictionary, without anyone\'s ownership', () => {
  assert.equal(AVATAR_SEED.avatars.length, 91);
  assert.equal(AVATAR_SEED.avatars.reduce((sum, entry) => sum + entry.aliases.length, 0), 129);
  assert.equal(AVATAR_SEED.notAvatars.length, 45);
  assert.deepEqual(dict.conflicts, [], 'no alias belongs to two avatars');
  assert.ok(dict.entries.every(entry => !entry.owned && entry.bodyItemId === null && entry.origin === 'seed'));
  assert.deepEqual(dict.entries.find(entry => entry.canonical === 'Leefa')?.sharesBodyWith, ['Lunalitt']);
  assert.match(dict.version, /^[0-9a-f]{16}$/);
  assert.equal(buildDictionary(AVATAR_SEED).version, dict.version, 'the version is a pure function of the vocabulary');
});

test('a variation name or tag matches whole, then without 対応/用 suffixes and honorifics', () => {
  const match = (token: string) => matchToken(dict, token)?.canonical;
  assert.equal(match('マヌカ'), 'MANUKA');
  assert.equal(match('ＭＡＮＵＫＡ'), 'MANUKA');
  assert.equal(match('ﾏﾇｶ'), 'MANUKA');
  assert.equal(match('しなの用'), 'Shinano');
  assert.equal(match('マヌカ対応'), 'MANUKA');
  assert.equal(match('Kaguya対応版'), 'Kaguya');
  assert.equal(match('ルルネ専用'), 'Rurune');
  assert.equal(match('瑞希ちゃん'), 'Mizuki');
  assert.equal(match('セレスティアさん'), 'Selestia');
  assert.equal(match('【しなの対応】'), 'Shinano');
  // The long vowel mark is not folded: both spellings of Kumaly are listed, and サフィ is somebody else than サフィー.
  assert.equal(match('クマリー'), 'Kumaly');
  assert.equal(match('クマリ対応'), 'Kumaly');
  assert.equal(match('サフィー'), 'Sapphy');
  assert.equal(match('サフィ'), undefined);
  assert.equal(match('衣装'), undefined);
  assert.equal(match('MA対応'), undefined, 'ModularAvatar is not an avatar called MA');
});

test('free text: longest alias first, word boundaries for Latin names, non-CJK neighbours for short kana and kanji', () => {
  assert.deepEqual(names('Fusion Shader'), [], 'Sio is not in Fusion');
  assert.deepEqual(names('Sio対応です'), ['Sio']);
  assert.deepEqual(names('sion'), ['Sion'], 'the longer Sion wins and Sio does not match inside it');
  assert.deepEqual(names('しおり'), [], 'しお inside a longer word is not Sio');
  assert.deepEqual(names('しお・まや'), ['Sio', 'Maya']);
  assert.deepEqual(names('まやかし'), [], 'a two-letter name followed by kana is part of another word');
  assert.deepEqual(names('萌え袖'), []);
  assert.deepEqual(names('萌 対応'), ['Moe']);
  assert.deepEqual(names('ユギミヨ対応'), ['Yugi'], 'ミヨ inside ユギミヨ is taken by the longer alias');
  assert.deepEqual(names('しなの用衣装'), ['Shinano'], 'three kana need no boundary');
  assert.deepEqual(names('MANUKA・Rurune対応'), ['MANUKA', 'Rurune']);
});

test('only the 対応アバター section of a description is read when there is one', () => {
  const described = '■対応アバター\n・マヌカ\n・しなの\n\n■注意\nKaguya の髪型を参考にしました';
  assert.equal(supportedAvatarSection(described), '■対応アバター\n・マヌカ\n・しなの');
  assert.deepEqual(names(supportedAvatarSection(described)!), ['MANUKA', 'Shinano']);
  assert.equal(supportedAvatarSection('対応アバター：マヌカ、ルルネ\n\nしなの向けの商品もあります'), '対応アバター：マヌカ、ルルネ');
  assert.equal(supportedAvatarSection('【対応アバター】\n\n・ルルネ\n※Quest非対応\n\n本文'), '【対応アバター】\n・ルルネ\n※Quest非対応');
  assert.equal(supportedAvatarSection('Kaguya 向け'), undefined);
});

test('avatar tags keep their source and confidence: variation high, tag medium, description low', () => {
  const tags = deriveAvatarTags(dict, { variations: ['MANUKA', 'セット'], tags: ['しなの対応', 'マヌカ'],
    description: '■対応アバター\n・ルルネ\n■その他\nKaguya' });
  assert.deepEqual(tags.map(tag => [tag.entry.canonical, tag.source, tag.confidence]),
    [['MANUKA', 'variation', 'high'], ['Shinano', 'tag', 'medium'], ['Rurune', 'description', 'low']]);
  assert.deepEqual(tags[0]!.evidence, [{ source: 'variation', text: 'MANUKA' }, { source: 'tag', text: 'マヌカ' }], 'every source is kept as evidence');
  assert.deepEqual(deriveAvatarTags(dict, { description: 'しなの と マヌカ' }).map(tag => tag.entry.canonical), ['Shinano', 'MANUKA'],
    'without a section the whole description is read');
});

test('file kinds and avatars per file follow the reference cases', () => {
  const avatars = (name: string) => avatarsInFilename(dict, name).map(entry => entry.canonical);
  assert.deepEqual(avatars('OSEISO_MANUKA.zip'), ['MANUKA']);
  assert.deepEqual(avatars('ChiffonChocolatLime.unitypackage'), ['Chiffon', 'Chocolat', 'Lime']);
  assert.deepEqual(avatars('RURUNE1.3.zip'), ['Rurune']);
  assert.deepEqual(avatars('SiuSiu.zip'), ['SiuSiu'], 'SiuSiu is one avatar, not two');
  assert.deepEqual(avatars('Fusion_Shader.unitypackage'), [], 'Fusion_Shader does not name Sio');
  assert.deepEqual(avatars('マヌカ用衣装.zip'), ['MANUKA']);
  assert.deepEqual(avatars('LUMINA_EX_outfit.zip'), ['LUMINA']);
  assert.deepEqual(filenameTokens('RURUNEVer1.2_Quest.zip'), ['RURUNE', 'Ver', '1', '2', 'Quest']);
  const kind = (name: string) => { const result = classifyFile(dict, name); return [result.kind, result.avatars]; };
  assert.deepEqual(kind('Fusion_Shader.unitypackage'), ['material', []]);
  assert.deepEqual(kind('skin.psd'), ['material', []]);
  assert.deepEqual(kind('Body.PSB'), ['material', []]);
  assert.deepEqual(kind('lilToon_preset.zip'), ['material', []]);
  assert.deepEqual(kind('テクスチャ一式.zip'), ['material', []]);
  assert.deepEqual(kind('MANUKA_UV.zip'), ['material', ['MANUKA']], 'a standalone uv makes a material, which still names its avatar');
  assert.deepEqual(kind('uvmap_guide.pdf'), ['other', []], 'uv only counts as a word of its own');
  assert.deepEqual(kind('OSEISO_MANUKA.zip'), ['avatar', ['MANUKA']]);
  assert.deepEqual(kind('readme.txt'), ['other', []]);
});

test('BOOTH categories map by name, then by parent, compared folded; hair words only suggest', () => {
  const rule = (category: string, parent = '', name = '', tags: string[] = []) => {
    const result = boothCategoryRule({ category, parent, name, tags }); return [result.target, result.confident];
  };
  assert.deepEqual(rule('3D衣装'), ['outfit', true]);
  assert.deepEqual(rule('水着', '3D衣装'), ['outfit', true], 'the parent decides when the name has no mapping');
  assert.deepEqual(rule('ＵＮＩＴＹ'), ['plugin', true], 'compared after folding');
  assert.deepEqual(rule('3Dモデル（その他）', '3Dモデル'), [null, false]);
  assert.deepEqual(rule('3Dモデル(その他)'), [null, false], 'full-width and half-width brackets are one name');
  assert.deepEqual(rule('3Dモーション・アニメーション'), ['toy', true]);
  assert.deepEqual(rule('3Dキャラクター', '', 'ヘアー付きの素体'), ['body', true], '3Dキャラクター decides on its own');
  assert.deepEqual(rule('3D髪型'), ['hair', true]);
  assert.deepEqual(rule('3D衣装', '', 'ロングヘアー'), ['hair', false], 'a hair word elsewhere is only a suggestion');
  assert.deepEqual(rule('3D小物', '', 'Clip', ['hair']), ['hair', false]);
  assert.deepEqual(rule('3D小道具', '', 'Gaming Chair'), ['accessory', true], 'hair is a whole word: chair is not hair');
  assert.ok(isThreeD('3Dテクスチャ', '') && isThreeD('水着', '3Dモデル') && !isThreeD('イラスト集', 'イラスト'));
});

test('discovery reads bilingual variation names and body titles', () => {
  assert.deepEqual(bilingualParts('マヌカ / MANUKA'), ['マヌカ', 'MANUKA']);
  assert.deepEqual(bilingualParts('Karuru（カルル）'), ['Karuru', 'カルル']);
  assert.equal(bilingualParts('しなの・マヌカ'), undefined, 'two names in one script are two avatars, not two spellings');
  assert.deepEqual(bodyNames(dict, 'オリジナル3Dモデル『カルル』-Karuru-'), { canonical: 'Karuru', aliases: ['カルル'], guesses: ['カルル', 'Karuru'] });
  assert.equal(bodyNames(dict, '【オリジナル3Dモデル】VRChat向け').canonical, undefined, 'generic words are not names');
});
