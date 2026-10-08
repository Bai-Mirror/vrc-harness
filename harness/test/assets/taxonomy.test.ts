import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { assetsApi } from '../../src/assets/api.ts';
import { listItems } from '../../src/assets/catalog.ts';
import { assignCategory, bodyItemIds, refreshAssetIndex } from '../../src/assets/derive.ts';
import { applyTaxonomy, currentTaxonomy, getProposal, proposeTaxonomy, rejectTaxonomy } from '../../src/assets/taxonomy.ts';
import { upsertBoothItem } from '../../src/booth/catalog.ts';
import { openDatabase } from '../../src/state/db.ts';
import { removeTemp } from '../fixtures/platform.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-taxonomy-'));
  const db = openDatabase(join(root, 'state.sqlite'));
  t.after(() => { db.close(); removeTemp(root); });
  const item = (itemId: string, category: string): void => upsertBoothItem(db, { itemId, name: `商品 ${itemId}`, owned: true, status: 'available',
    category, metadata: { category: { name: category } } });
  return { db, item };
}
const propose = (db: Parameters<typeof proposeTaxonomy>[0], operations: unknown[]) => proposeTaxonomy(db, { operations, reason: '测试', proposedBy: 'ai' });

test('the default vocabulary is the reference archive\'s seven categories, and 未分类 is no category', t => {
  const f = fixture(t);
  assert.deepEqual(currentTaxonomy(f.db), { version: 1, categories: [
    { id: 'body', path: '素体', hidden: false }, { id: 'outfit', path: '服装', hidden: false }, { id: 'hair', path: '发型', hidden: false },
    { id: 'accessory', path: '配饰', hidden: false }, { id: 'texture', path: '贴图', hidden: false }, { id: 'toy', path: '玩具', hidden: false },
    { id: 'plugin', path: '功能插件', hidden: false }] });
});

test('reserved names, slashes in names and a seventh level are refused', t => {
  const f = fixture(t);
  for (const path of ['未分类', '服装/未分類', 'Uncategorized', '服装/ＵＮＣＡＴＥＧＯＲＩＳＥＤ'])
    assert.throws(() => propose(f.db, [{ op: 'add', path }]), /保留名/, path);
  assert.throws(() => propose(f.db, [{ op: 'rename', category: 'outfit', name: '上/下' }]), /不能含 \//);
  assert.throws(() => propose(f.db, [{ op: 'add', path: 'a/b/c/d/e/f/g' }]), /最多 6 层/);
  assert.equal(propose(f.db, [{ op: 'add', path: 'a/b/c/d/e/f' }]).diff.added.length, 6, 'six levels, with the missing parents made on the way');
  assert.throws(() => propose(f.db, [{ op: 'add', path: '服装' }]), /已存在/);
  assert.throws(() => propose(f.db, [{ op: 'rename', category: 'hair', name: '服装' }]), /同一层已有/);
  assert.throws(() => propose(f.db, [{ op: 'hide', category: 'nothing' }]), /分类不存在/);
  assert.throws(() => propose(f.db, [{ op: 'jump', category: 'body' }]), /op 无效/);
});

test('a proposal shows its diff and the items it touches; only applying it makes a new version', t => {
  const f = fixture(t);
  f.item('1', '3D衣装'); f.item('2', '3D衣装'); f.item('3', '3Dモーション・アニメーション');
  refreshAssetIndex(f.db);
  const proposal = propose(f.db, [{ op: 'add', path: '服装/上衣' }, { op: 'rename', category: '服装', name: '衣服' },
    { op: 'merge', category: '玩具', into: '功能插件' }, { op: 'reorder', parent: null, order: ['功能插件', 'body'] }]);
  assert.deepEqual(proposal.diff.added.map(item => item.path), ['衣服/上衣']);
  assert.deepEqual(proposal.diff.renamed, [{ id: 'outfit', from: '服装', to: '衣服' }]);
  assert.deepEqual(proposal.diff.removed, [{ id: 'toy', path: '玩具', reassignTo: { id: 'plugin', path: '功能插件' } }]);
  assert.equal(proposal.diff.reordered, true);
  assert.deepEqual(proposal.impact, { items: 3, reassigned: [{ from: '玩具', to: '功能插件', items: 1 }], renamed: [{ from: '服装', to: '衣服', items: 2 }], suggestions: 0 });
  assert.equal(currentTaxonomy(f.db).version, 1, 'proposing changes nothing');
  assert.deepEqual(applyTaxonomy(f.db, proposal.id), { version: 2, reassigned: 1 });
  assert.deepEqual(currentTaxonomy(f.db).categories.map(item => item.path), ['功能插件', '素体', '衣服', '衣服/上衣', '发型', '配饰', '贴图']);
  refreshAssetIndex(f.db);
  assert.deepEqual(listItems(f.db, { sort: 'listing', direction: 'asc' }).items.map(item => item.category?.path), ['衣服', '衣服', '功能插件']);
  assert.equal(getProposal(f.db, proposal.id).status, 'applied');
  assert.throws(() => applyTaxonomy(f.db, proposal.id), /已应用/);
});

test('a proposal made against an older version is stale; removing a category with items needs a destination', t => {
  const f = fixture(t);
  f.item('1', '3D衣装');
  refreshAssetIndex(f.db);
  assert.throws(() => propose(f.db, [{ op: 'remove', category: '服装' }]), /还有 1 个素材/);
  const first = propose(f.db, [{ op: 'remove', category: '服装', reassignTo: null }]);
  const second = propose(f.db, [{ op: 'hide', category: '玩具' }]);
  applyTaxonomy(f.db, first.id);
  assert.equal(getProposal(f.db, second.id).status, 'stale');
  assert.throws(() => applyTaxonomy(f.db, second.id), (error: Error & { code?: string }) => error.code === 'STALE');
  rejectTaxonomy(f.db, second.id);
  assert.equal(getProposal(f.db, second.id).status, 'rejected');
  refreshAssetIndex(f.db);
  assert.equal(listItems(f.db).items[0]!.category, null, 'the removed category\'s items went to 未分类 as proposed');
  const hide = propose(f.db, [{ op: 'hide', category: '玩具' }]);
  applyTaxonomy(f.db, hide.id);
  assert.throws(() => assignCategory(f.db, 'booth:1', '玩具'), /已停用/);
});

test('renaming 素体 keeps the body category: rules that look for bodies still find them', t => {
  const f = fixture(t);
  f.item('1', '3Dキャラクター');
  refreshAssetIndex(f.db);
  applyTaxonomy(f.db, propose(f.db, [{ op: 'rename', category: '素体', name: '本体' }, { op: 'add', path: '本体/改变' }]).id);
  assignCategory(f.db, 'booth:1', '本体/改变');
  assert.deepEqual([...bodyItemIds(f.db)], ['1'], 'a child of the body category is a body too');
});

test('the GUI view and the AI context read one vocabulary version', t => {
  const f = fixture(t);
  const view = () => assetsApi(f.db, 'assets.taxonomy.get', {}) as { version: number; dictionaryVersion: string; context: string; categories: Array<{ path: string }> };
  assert.match(view().context, /^素材分类词表 版本 1/);
  const proposal = assetsApi(f.db, 'assets.taxonomy.propose', { operations: [{ op: 'add', path: '服装/上衣' }], reason: '上衣单独一类' }) as { id: string };
  assert.equal(view().version, 1);
  assetsApi(f.db, 'assets.taxonomy.apply', { proposalId: proposal.id });
  const after = view();
  assert.equal(after.version, 2);
  assert.match(after.context, /^素材分类词表 版本 2/);
  assert.match(after.context, /服装\/上衣/);
  assert.ok(after.context.includes(`角色字典 版本 ${after.dictionaryVersion}`));
  const items = assetsApi(f.db, 'assets.items', {}) as { taxonomyVersion: number; dictionaryVersion: string };
  assert.deepEqual([items.taxonomyVersion, items.dictionaryVersion], [2, after.dictionaryVersion], 'the item list says which versions it was derived with');
  assert.throws(() => assetsApi(f.db, 'assets.taxonomy.propose', { operations: [], reason: 'x' }), (error: Error & { code?: string }) => error.code === 'BAD_REQUEST');
});
