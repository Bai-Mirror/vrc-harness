import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { loadDictionary } from '../../src/assets/avatars.ts';
import { facets, itemDetail, listItems } from '../../src/assets/catalog.ts';
import { assignCategory, decideAvatar, refreshAssetIndex } from '../../src/assets/derive.ts';
import { answerReview, reviewId, reviewList } from '../../src/assets/review.ts';
import { applyTaxonomy, proposeTaxonomy } from '../../src/assets/taxonomy.ts';
import { createSelectionPlan, upsertBoothFile, upsertBoothItem } from '../../src/booth/catalog.ts';
import { durableState } from '../../src/project-state.ts';
import { openDatabase } from '../../src/state/db.ts';
import { removeTemp } from '../fixtures/platform.ts';

interface Product { name: string; category: string; parent?: string; tags?: string[]; variations?: string[]; description?: string; owned?: boolean; shop?: string }
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-assets-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  t.after(() => { db.close(); removeTemp(root); });
  let clock = Date.parse('2026-09-01T00:00:00Z');
  /** Store a product as a BOOTH sync would (its whole JSON in metadata); each call is a later sync. */
  const item = (itemId: string, product: Product): void => {
    upsertBoothItem(db, { itemId, name: product.name, shopName: product.shop ?? 'Shop', owned: product.owned ?? true, status: 'available',
      category: product.category, tags: product.tags ?? [], metadata: { id: Number(itemId), name: product.name,
        category: { name: product.category, ...(product.parent ? { parent: { name: product.parent } } : {}) },
        variations: (product.variations ?? []).map(name => ({ name })), description: product.description ?? '' } });
    db.prepare('UPDATE booth_item SET updated_at = ? WHERE item_id = ?').run(new Date(clock += 1000).toISOString(), itemId);
  };
  const file = (downloadableId: string, itemId: string, filename: string, byteSize?: number): void =>
    upsertBoothFile(db, { downloadableId, itemId, filename, ...(byteSize === undefined ? {} : { byteSize }), status: 'available' });
  return { root, db, item, file };
}
const ids = (items: Array<{ id: string }>): string[] => items.map(item => item.id);

test('BOOTH products get categories from their stored JSON: a confident rule fills an empty category, the rest are questions', t => {
  const f = fixture(t);
  f.item('1', { name: '春のワンピース', category: '3D衣装', parent: '3Dモデル' });
  f.item('2', { name: '水着セット', category: '水着', parent: '3D衣装' });
  f.item('3', { name: 'ポーズ集', category: '3Dモデル（その他）', parent: '3Dモデル' });
  f.item('4', { name: 'オリジナル3Dモデル「マヌカ」', category: '3Dキャラクター', parent: '3Dモデル' });
  f.item('5', { name: 'ロングヘアー', category: '3D装飾品', parent: '3Dモデル' });
  f.item('6', { name: 'ショート', category: '3D髪型', parent: '3Dモデル' });
  f.item('7', { name: '表情ツール', category: 'ツール' });
  refreshAssetIndex(f.db);
  assert.deepEqual(Object.fromEntries(listItems(f.db).items.map(item => [item.id, [item.category?.path ?? null, item.categorySource, item.suggestion?.path ?? null]])), {
    'booth:1': ['服装', 'auto', null], 'booth:2': ['服装', 'auto', null], 'booth:3': [null, 'none', null], 'booth:4': ['素体', 'auto', null],
    'booth:5': [null, 'none', '发型'], 'booth:6': ['发型', 'auto', null], 'booth:7': ['功能插件', 'auto', null] });
  assert.deepEqual(ids(reviewList(f.db, { type: 'category' }).items), [reviewId('category', 'booth:5')]);
  answerReview(f.db, { id: reviewId('category', 'booth:5'), choice: 'accept' });
  const [hair] = listItems(f.db, { category: '发型', sort: 'listing', direction: 'asc' }).items;
  assert.deepEqual([hair!.id, hair!.categorySource], ['booth:5', 'manual'], 'an accepted suggestion is the person\'s choice');
});

test('an automatic category is only filled in once; a changed BOOTH category becomes a question, and a manual choice is final', t => {
  const f = fixture(t);
  f.item('1', { name: 'ワンピース', category: '3D衣装' });
  refreshAssetIndex(f.db);
  f.item('1', { name: 'ワンピース', category: '3D装飾品' });
  refreshAssetIndex(f.db);
  const one = () => listItems(f.db).items[0]!;
  assert.deepEqual([one().category?.id, one().categorySource, one().suggestion?.id], ['outfit', 'auto', 'accessory']);
  answerReview(f.db, { id: reviewId('category', 'booth:1'), choice: 'reject' });
  f.item('1', { name: 'ワンピース', category: '3D装飾品' });
  refreshAssetIndex(f.db);
  assert.deepEqual([one().category?.id, one().suggestion], ['outfit', null], 'a rejected suggestion does not come back on the next sync');
  assignCategory(f.db, 'booth:1', '素体');
  f.item('1', { name: 'ワンピース', category: '3Dキャラクター' });
  f.item('1', { name: 'ロングヘアー', category: '3D衣装' });
  refreshAssetIndex(f.db, { force: true });
  assert.deepEqual([one().category?.id, one().categorySource, one().suggestion], ['body', 'manual', null]);
  assert.equal(reviewList(f.db, { type: 'category' }).total, 0, 'a manual choice is never questioned again');
  assignCategory(f.db, 'booth:1', '未分类');
  assert.deepEqual([one().category, one().categorySource], [null, 'manual'], '未分类 can be chosen too, and is final');
});

test('3D products get avatar tags with their source, confidence and status; other products get none', t => {
  const f = fixture(t);
  f.item('1', { name: '春の服', category: '3D衣装', variations: ['MANUKA', 'セット'], tags: ['しなの対応'],
    description: '■対応アバター\n・ルルネ\n\n■注意\nKaguya の髪型を参考にしました' });
  f.item('2', { name: 'イラスト集', category: 'イラスト集', parent: 'イラスト', tags: ['マヌカ'] });
  refreshAssetIndex(f.db);
  const tags = (itemDetail(f.db, 'booth:1').avatarTags as Array<Record<string, string>>)
    .map(tag => [tag.name, tag.status, tag.source, tag.confidence, tag.evidence, tag.claim]);
  assert.deepEqual(tags, [['MANUKA', 'confirmed', 'variation', 'high', 'MANUKA', '作者声明'], ['Shinano', 'confirmed', 'tag', 'medium', 'しなの対応', '作者声明'],
    ['Rurune', 'pending', 'description', 'low', '・ルルネ', '作者声明']]);
  const illustration = listItems(f.db).items.find(item => item.id === 'booth:2')!;
  assert.deepEqual([illustration.avatars, illustration.adaptation], [[], 'none']);
  assert.deepEqual(ids(reviewList(f.db, { type: 'avatar' }).items), [reviewId('avatar', 'booth:1', 'rurune')]);
});

test('a person\'s avatar decisions survive every resync, and can be withdrawn', t => {
  const f = fixture(t);
  const product: Product = { name: '春の服', category: '3D衣装', variations: ['MANUKA'], description: '対応アバター：ルルネ' };
  f.item('1', product);
  refreshAssetIndex(f.db);
  decideAvatar(f.db, 'booth:1', 'MANUKA', 'reject');
  answerReview(f.db, { id: reviewId('avatar', 'booth:1', 'rurune'), choice: 'accept' });
  decideAvatar(f.db, 'booth:1', 'かぐや', 'add');
  assert.throws(() => decideAvatar(f.db, 'booth:1', 'Nobody', 'add'), /角色字典里没有/);
  const state = () => (itemDetail(f.db, 'booth:1').avatarTags as Array<Record<string, string>>).map(tag => [tag.name, tag.status, tag.source, tag.decidedBy]);
  const decided = [['Kaguya', 'confirmed', 'manual', 'human'], ['Rurune', 'confirmed', 'description', 'human'], ['MANUKA', 'rejected', 'variation', 'human']];
  assert.deepEqual(state(), decided);
  f.item('1', product);
  refreshAssetIndex(f.db);
  assert.deepEqual(state(), decided, 'a resync derives the tags again and puts the decisions back on top');
  refreshAssetIndex(f.db, { force: true });
  assert.deepEqual(state(), decided);
  assert.deepEqual(ids(listItems(f.db, { avatar: 'MANUKA' }).items), [], 'a rejected avatar does not match');
  decideAvatar(f.db, 'booth:1', 'MANUKA', 'clear');
  assert.deepEqual(state()[0], ['Kaguya', 'confirmed', 'manual', 'human']);
  assert.ok(state().some(tag => tag.join() === 'MANUKA,confirmed,variation,rule'), 'clearing a decision returns to what the author claimed');
});

test('a dictionary change derives every item again, including items that were already complete', t => {
  const f = fixture(t);
  f.item('1', { name: '春の服', category: '3D衣装', variations: ['MANUKA', 'Karuru'], shop: 'Alpha' });
  f.item('2', { name: '夏の服', category: '3D衣装', variations: ['Rurune', 'Karuru'], shop: 'Beta' });
  f.item('3', { name: '冬の服', category: '3D衣装', tags: ['カルル対応'], shop: 'Gamma' });
  f.item('4', { name: '秋の服', category: '3D衣装', variations: ['Shinano'], shop: 'Delta' });
  refreshAssetIndex(f.db);
  const version = (id: string) => (f.db.prepare('SELECT dictionary_version AS v FROM asset_derivation WHERE subject = ?').get(id) as { v: string }).v;
  const before = version('booth:4');
  const dictionary = reviewList(f.db, { type: 'dictionary' }).items;
  const karuru = dictionary.find(item => item.detail.name === 'Karuru')!;
  assert.deepEqual([karuru.group, karuru.detail.strength, karuru.detail.items, karuru.detail.shops], ['新角色', 'strong', 2, 2]);
  const kana = dictionary.find(item => item.detail.name === 'カルル')!;
  assert.deepEqual([kana.detail.origin, kana.detail.strength], ['tag-repeat', 'weak']);
  answerReview(f.db, { id: karuru.id, choice: 'accept' });
  assert.deepEqual(ids(listItems(f.db, { avatar: 'karuru', sort: 'listing', direction: 'asc' }).items), ['booth:1', 'booth:2']);
  assert.notEqual(version('booth:4'), before, 'an item whose own row did not change is derived with the new dictionary too');
  assert.equal(version('booth:4'), loadDictionary(f.db).version);
  answerReview(f.db, { id: kana.id, choice: 'same_as', target: 'Karuru' });
  assert.deepEqual(ids(listItems(f.db, { avatar: 'カルル', sort: 'listing', direction: 'asc' }).items), ['booth:1', 'booth:2', 'booth:3']);
  assert.deepEqual(reviewList(f.db, { type: 'dictionary' }).items.filter(item => /カルル|Karuru/.test(String(item.detail.name))), [],
    'answered questions are not asked again');
  assert.throws(() => answerReview(f.db, { id: karuru.id, choice: 'reject' }), /已处理/);
});

test('owned bodies teach the dictionary which avatars the person owns', t => {
  const f = fixture(t);
  f.item('10', { name: 'オリジナル3Dモデル「マヌカ」', category: '3Dキャラクター' });
  f.item('11', { name: 'オリジナル3Dモデル『カルル』-Karuru-', category: '3Dキャラクター' });
  f.item('12', { name: '「ミナ」と「ルカ」', category: '3Dキャラクター' });
  f.item('13', { name: 'オリジナル3Dモデル「ルルネ」', category: '3Dキャラクター', owned: false });
  f.item('20', { name: '春の服', category: '3D衣装', variations: ['カルル'] });
  refreshAssetIndex(f.db);
  const entry = (name: string) => loadDictionary(f.db).entries.find(item => item.canonical === name)!;
  assert.deepEqual([entry('MANUKA').owned, entry('MANUKA').bodyItemId], [true, '10']);
  assert.deepEqual([entry('Karuru').owned, entry('Karuru').bodyItemId, entry('Karuru').aliases, entry('Karuru').origin], [true, '11', ['カルル'], 'learned']);
  assert.equal(entry('Rurune').owned, false, 'a body no longer owned teaches nothing');
  assert.deepEqual(listItems(f.db, { avatar: 'Karuru', sort: 'listing', direction: 'asc' }).items.map(item => [item.id, item.avatars[0]!.source]),
    [['booth:11', 'title'], ['booth:20', 'variation']], 'the body carries its own avatar, and outfits find the learned name');
  const unclear = reviewList(f.db, { type: 'dictionary' }).items.find(item => item.detail.origin === 'owned-body')!;
  assert.deepEqual([unclear.detail.name, unclear.detail.strength], ['ミナ', 'strong'], 'an unclear body name is asked, not guessed');
  f.item('10', { name: 'オリジナル3Dモデル「マヌカ」', category: '3Dキャラクター', owned: false });
  refreshAssetIndex(f.db);
  assert.deepEqual([entry('MANUKA').owned, entry('MANUKA').bodyItemId], [false, null], 'ownership learned from a purchase goes when the purchase goes');
});

function library(t: TestContext) {
  const f = fixture(t);
  f.item('1', { name: '春のワンピース', category: '3D衣装', variations: ['MANUKA', 'Rurune'], shop: 'Alpha' });
  f.item('2', { name: '夏のワンピース', category: '3D衣装', variations: ['MANUKA'], description: '対応アバター：しなの', shop: 'Beta' });
  f.item('3', { name: 'ツインテール', category: '3D髪型', tags: ['ルルネ対応'], shop: 'Beta' });
  f.item('4', { name: 'ソックス', category: '3D衣装', tags: ['汎用'], shop: 'Gamma' });
  f.item('5', { name: 'トゥーン詰め合わせ', category: '3Dテクスチャ', shop: 'Gamma' });
  f.item('6', { name: '謎の服', category: '3D衣装', description: 'やわらかい生地です', shop: 'Delta' });
  f.item('7', { name: 'イラスト', category: 'イラスト集', parent: 'イラスト', shop: 'Delta' });
  f.file('51', '5', 'toon_shader.unitypackage', 100);
  f.file('52', '5', 'toon_textures.psd', 200);
  f.file('11', '1', 'Spring_MANUKA.zip', 10);
  f.file('12', '1', 'Spring_Rurune.zip', 20);
  f.file('13', '1', 'spring_texture.psd', 30);
  f.file('14', '1', 'readme.txt');
  f.db.prepare(`INSERT INTO asset (id, path, name, kind, status, tags_json) VALUES ('a', '/library/coat.zip', 'コート', 'outfit', 'ready', '["マヌカ"]')`).run();
  refreshAssetIndex(f.db);
  return f;
}

test('the item list filters by category with children, by avatar after folding, by bucket and by folded text', t => {
  const f = library(t);
  const plan = proposeTaxonomy(f.db, { operations: [{ op: 'add', path: '服装/上衣' }], reason: '测试子级', proposedBy: 'ai' });
  applyTaxonomy(f.db, plan.id);
  assignCategory(f.db, 'booth:6', '服装/上衣');
  const list = (query: Parameters<typeof listItems>[1]) => ids(listItems(f.db, { sort: 'listing', direction: 'asc', ...query }).items);
  assert.deepEqual(list({ category: '服装' }), ['booth:1', 'booth:2', 'booth:4', 'booth:6', 'local:a'], 'a category includes its children');
  assert.deepEqual(list({ category: '服装/上衣' }), ['booth:6']);
  assert.deepEqual(list({ category: '未分类' }), ['booth:7']);
  assert.deepEqual(list({ avatar: 'ﾏﾇｶ' }), ['booth:1', 'booth:2', 'local:a'], 'an avatar matches exactly after folding, aliases included');
  assert.deepEqual(list({ avatar: 'しなの' }), [], 'a pending tag is not a match');
  assert.deepEqual(list({ avatar: 'しなの', includePending: true }), ['booth:2']);
  assert.deepEqual(list({ avatar: 'MANUKA', category: '服装' }), ['booth:1', 'booth:2', 'local:a']);
  assert.deepEqual(list({ bucket: 'universal' }), ['booth:4', 'booth:5'], 'a universal word and material-only files are positive evidence');
  assert.deepEqual(list({ bucket: 'unknown' }), ['booth:6'], 'an outfit nobody recognised is not universal');
  assert.deepEqual(list({ query: 'わんぴーす' }), ['booth:1', 'booth:2'], 'katakana and hiragana fold together');
  assert.deepEqual(list({ query: 'alpha' }), ['booth:1']);
  assert.deepEqual(list({ query: 'るるね' }), ['booth:1', 'booth:3'], 'an avatar alias finds the items tagged with it');
  const described = listItems(f.db, { query: '生地' });
  assert.deepEqual(described.items.map(item => [item.id, item.match, item.snippet]), [['booth:6', 'description', 'やわらかい生地です']]);
  assert.throws(() => listItems(f.db, { category: '不存在' }), /分类不存在/);
});

test('sorting puts items without a value last in both directions, and pages through the list', t => {
  const f = library(t);
  const sorted = (sort: 'name' | 'listing' | 'adaptation', direction: 'asc' | 'desc') => ids(listItems(f.db, { sort, direction }).items);
  assert.deepEqual(sorted('listing', 'desc'), ['booth:7', 'booth:6', 'booth:5', 'booth:4', 'booth:3', 'booth:2', 'booth:1', 'local:a']);
  assert.deepEqual(sorted('listing', 'asc'), ['booth:1', 'booth:2', 'booth:3', 'booth:4', 'booth:5', 'booth:6', 'booth:7', 'local:a']);
  assert.deepEqual(sorted('adaptation', 'desc').slice(0, 1), ['booth:1']);
  assert.equal(sorted('adaptation', 'desc').at(-1), 'booth:7', 'a product avatars do not apply to has no adaptation count');
  assert.equal(sorted('adaptation', 'asc').at(-1), 'booth:7');
  assert.deepEqual(ids(listItems(f.db).items), sorted('listing', 'desc'), 'newest listing first by default');
  const page = listItems(f.db, { sort: 'listing', direction: 'asc', limit: 3, offset: 3 });
  assert.deepEqual([page.total, ids(page.items), page.stats.count], [8, ['booth:4', 'booth:5', 'booth:6'], 8]);
  assert.deepEqual(listItems(f.db).stats, { count: 8, bytes: 360, unknownSizes: 1, needsReview: 1 });
});

test('facets: categories count the whole library with children; avatars count the search and category', t => {
  const f = library(t);
  applyTaxonomy(f.db, proposeTaxonomy(f.db, { operations: [{ op: 'add', path: '服装/上衣' }], reason: '测试子级', proposedBy: 'ai' }).id);
  assignCategory(f.db, 'booth:6', '服装/上衣');
  const result = facets(f.db, { query: 'ワンピース' });
  const node = (path: string) => result.categories.nodes.find(item => item.path === path)!;
  assert.deepEqual([result.categories.all, result.categories.uncategorized], [8, 1], 'category counts ignore the search');
  assert.deepEqual([node('服装').count, node('服装').direct, node('服装/上衣').count, node('发型').count], [5, 4, 1, 1]);
  assert.deepEqual(result.avatars.items.map(item => [item.name, item.count, item.pending]), [['MANUKA', 2, 0], ['Rurune', 1, 0]]);
  assert.equal(result.avatars.pendingItems, 1, 'pending avatars are counted apart');
  const all = facets(f.db, {});
  assert.deepEqual(all.avatars.items.map(item => [item.name, item.count]), [['MANUKA', 3], ['Rurune', 2]]);
  assert.deepEqual([all.avatars.universal, all.avatars.unknown], [2, 1], 'universal and not-recognised are separate buckets');
  assert.deepEqual(facets(f.db, { category: '发型' }).avatars.items.map(item => item.name), ['Rurune']);
  const top = facets(f.db, { top: 1 });
  assert.deepEqual([top.avatars.items.map(item => item.name), top.avatars.more], [['MANUKA'], 1]);
  assert.deepEqual(facets(f.db, { top: 1, avatarFilter: 'るる' }).avatars.items.map(item => item.name), ['Rurune'], 'the avatar filter reaches past the top N by alias');
});

test('an item\'s files come in three groups with their avatars', t => {
  const f = library(t);
  const detail = itemDetail(f.db, 'booth:1') as { fileGroups: Array<{ kind: string; label: string; files: Array<{ filename: string; avatars: string[] }> }> };
  assert.deepEqual(detail.fileGroups.map(group => [group.label, group.files.map(file => [file.filename, file.avatars])]), [
    ['材质文件 · 各角色通用', [['spring_texture.psd', []]]],
    ['适配文件 · 按角色区分', [['Spring_MANUKA.zip', ['MANUKA']], ['Spring_Rurune.zip', ['Rurune']]]],
    ['其他文件 · 说明、预览等', [['readme.txt', []]]],
  ]);
  assert.deepEqual({ ...f.db.prepare(`SELECT kind, avatars_json AS avatars FROM booth_file_kind WHERE downloadable_id = '11'`).get() }, { kind: 'avatar', avatars: '["MANUKA"]' });
  assert.throws(() => itemDetail(f.db, 'booth:999'), /素材不存在/);
});

test('deriving again with nothing changed writes nothing', t => {
  const f = library(t);
  const snapshot = () => ['asset_classification', 'asset_derivation', 'asset_avatar_tag', 'booth_file_kind', 'avatar_dictionary_entry', 'avatar_dictionary_candidate']
    .map(table => JSON.stringify(f.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all()));
  const events = () => (f.db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n;
  const before = snapshot(), seen = events();
  assert.deepEqual(refreshAssetIndex(f.db), { items: 0, files: 0, learned: false, candidates: 0, dictionaryVersion: loadDictionary(f.db).version,
    taxonomyVersion: 1, changed: false });
  assert.deepEqual(snapshot(), before);
  assert.equal(events(), seen, 'a refresh with nothing to do records no event');
});

test('the catalog migration maps legacy asset kinds to categories and keeps the kind; opening again changes nothing', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-assets-migration-'));
  t.after(() => removeTemp(root));
  const path = join(root, 'state.sqlite');
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT)');
  const migrations = new URL('../../src/state/migrations/', import.meta.url);
  const files = ['0001_init', '0002_task_proofs', '0003_lock_epoch', '0004_import_report', '0005_provider_snapshot', '0006_outbox_closed',
    '0007_scheduler_lease', '0008_formal_workflow', '0009_product_catalog', '0010_project_assets', '0011_project_variants',
    '0012_workflow_context', '0013_workflow_pack', '0014_workflow_variables', '0015_booth_jit_assets', '0016_managed_pack_lifecycle',
    '0017_candidate_trials', '0018_candidate_authoring', '0019_contribution_queue', '0020_contribution_receipts', '0021_project_recovery',
    '0022_project_archive'];
  files.forEach((name, i) => { old.exec(readFileSync(new URL(`${name}.sql`, migrations), 'utf8')); old.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1); });
  for (const kind of ['avatar', 'outfit', 'texture', 'animation', 'package', 'other'])
    old.prepare(`INSERT INTO asset (id, path, name, kind) VALUES (?, ?, ?, ?)`).run(kind, `/library/${kind}.zip`, kind, kind);
  old.close();
  const read = (db: DatabaseSync) => ({
    classes: db.prepare('SELECT subject, category_id AS category, source, legacy_kind AS legacy FROM asset_classification ORDER BY subject').all().map(row => ({ ...row })),
    kinds: db.prepare('SELECT id, kind FROM asset ORDER BY id').all().map(row => ({ ...row })),
    versions: db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row => (row as { version: number }).version),
    taxonomy: db.prepare('SELECT version FROM asset_taxonomy_version').all().map(row => (row as { version: number }).version) });
  let db = openDatabase(path);
  const first = read(db);
  assert.deepEqual(first.classes, [
    { subject: 'local:animation', category: 'toy', source: 'legacy', legacy: 'animation' }, { subject: 'local:avatar', category: 'body', source: 'legacy', legacy: 'avatar' },
    { subject: 'local:other', category: null, source: 'legacy', legacy: 'other' }, { subject: 'local:outfit', category: 'outfit', source: 'legacy', legacy: 'outfit' },
    { subject: 'local:package', category: null, source: 'legacy', legacy: 'package' }, { subject: 'local:texture', category: 'texture', source: 'legacy', legacy: 'texture' }]);
  assert.deepEqual(first.kinds.map(row => (row as { kind: string }).kind), ['animation', 'avatar', 'other', 'outfit', 'package', 'texture'], 'asset.kind is kept');
  assert.deepEqual(first.taxonomy, [1]);
  assert.ok(first.versions.includes(24));
  db.close();
  db = openDatabase(path);
  t.after(() => db.close());
  assert.deepEqual(read(db), first, 'opening again applies nothing twice');
  // Rows written later follow the same mapping through the asset table's triggers, until a person decides.
  db.prepare(`INSERT INTO asset (id, path, name, kind) VALUES ('late', '/library/late.zip', 'late', 'outfit')`).run();
  const late = () => db.prepare(`SELECT category_id AS category, source FROM asset_classification WHERE subject = 'local:late'`).get();
  assert.deepEqual({ ...late() as object }, { category: 'outfit', source: 'legacy' });
  db.prepare(`UPDATE asset SET kind = 'avatar' WHERE id = 'late'`).run();
  assert.deepEqual({ ...late() as object }, { category: 'body', source: 'legacy' });
  refreshAssetIndex(db);
  assignCategory(db, 'local:late', '配饰');
  db.prepare(`UPDATE asset SET kind = 'texture' WHERE id = 'late'`).run();
  assert.deepEqual({ ...late() as object }, { category: 'accessory', source: 'manual' }, 'a manual choice outlives a kind change');
  db.prepare(`DELETE FROM asset WHERE id = 'late'`).run();
  assert.equal(late(), undefined);
});

test('a project finds its BOOTH body by the catalog category, not by words in the product\'s category name', t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO workspace (id, path) VALUES ('w', '/workspace')").run();
  f.db.prepare(`INSERT INTO project (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
    VALUES ('p', 'w', 'client', '/workspace/p', '{}', 'active', 'test', 'test')`).run();
  f.item('1', { name: 'キャラクター風の服', category: '3Dキャラクター' });
  f.item('2', { name: '改変素体', category: '3Dモデル（その他）' });
  f.item('3', { name: '新しい素体', category: '3Dキャラクター' });
  for (const id of ['1', '2', '3']) f.file(`${id}0`, id, `${id}.zip`, 1);
  refreshAssetIndex(f.db);
  assignCategory(f.db, 'booth:1', '服装');
  assignCategory(f.db, 'booth:2', '素体');
  f.item('4', { name: '未归类的素体', category: '3Dキャラクター' });
  f.file('40', '4', '4.zip', 1);
  createSelectionPlan(f.db, { projectId: 'p', files: ['10', '20', '30', '40'].map(downloadableId => ({ downloadableId, purpose: '制作' })) });
  assert.deepEqual(durableState(f.db, 'p').boothAvatars?.sort(), ['改変素体', '新しい素体', '未归类的素体'].sort(),
    'a product moved out of 素体 is not a body; one moved into it is; one not classified yet goes by BOOTH\'s category');
});
