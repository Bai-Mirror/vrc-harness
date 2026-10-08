import assert from 'node:assert/strict';
import test from 'node:test';
import { compileContext, type FrozenContextItem } from '../../src/workflow/context-compiler.ts';

const item = (id: string, content: string, patch: Partial<FrozenContextItem['spec']> = {}): FrozenContextItem => ({
  sha256: `${id}-hash`, content,
  spec: { id, path: `${id}.md`, priority: 0, required: false, when: [], unless: [], excludes: [], covers: [], models: [], ...patch },
});

test('context compiler selects Markdown sections by facts and explains every omission', () => {
  const result = compileContext([
    item('core', '# Menu\nintro\n## Route A\nreactive\n## Route B\nmanual states',
      { heading: 'Route B', required: true, covers: ['menu.route'] }),
    item('shoe', 'sole and toe checks', { priority: 20, when: [{ path: 'plan.footwear', equals: true }], covers: ['fit.sole'] }),
    item('quest', 'quest optimization', { priority: 10, when: [{ path: 'manifest.platforms', includes: 'quest' }] }),
  ], { plan: { footwear: false }, manifest: { platforms: ['pc'] } }, { budgetChars: 1000, requiredCoverage: ['menu.route'] });
  assert.match(result.text, /## Route B\nmanual states/);
  assert.doesNotMatch(result.text, /Route A/);
  assert.deepEqual(result.decisions.map(entry => [entry.id, entry.selected, entry.reason]), [
    ['shoe', false, '触发条件不成立：plan.footwear'],
    ['quest', false, '触发条件不成立：manifest.platforms'],
    ['core', true, '必选条目'],
  ]);
});

test('context compiler applies priority, exclusions, budget, coverage and model variants deterministically', () => {
  const result = compileContext([
    item('full', '12345678', { priority: 100, excludes: ['legacy'], covers: ['menu'], models: ['codex*'] }),
    item('legacy', 'old', { priority: 1, covers: ['menu'] }),
    item('extra', 'abcdefgh', { priority: 50 }),
    item('claude-small', 'compressed', { priority: 90, models: ['claude'] }),
  ], {}, { budgetChars: 10, requiredCoverage: ['menu'], modelFamily: 'codex-6' });
  assert.equal(result.text.includes('full'), true);
  assert.equal(result.decisions.find(entry => entry.id === 'legacy')!.reason, '被更高优先级条目互斥排除');
  assert.match(result.decisions.find(entry => entry.id === 'extra')!.reason, /超出上下文预算/);
  assert.match(result.decisions.find(entry => entry.id === 'claude-small')!.reason, /模型家族 codex-6 不匹配/);
  assert.throws(() => compileContext([item('x', 'x')], {}, { budgetChars: 10, requiredCoverage: ['missing'] }), /上下文覆盖不足/);
  assert.throws(() => compileContext([
    item('winner', 'a', { required: true, excludes: ['also-required'] }),
    item('also-required', 'b', { required: true }),
  ], {}, { budgetChars: 10 }), /必选上下文条目.*互斥/);
});

test('a section listed twice is injected once, by its highest-priority eligible entry', () => {
  const file = '# Fit\n## Sole\nfour causes\n## Other\nx';
  const entries = [
    item('sole-after-failure', file, { path: 'fit.md', heading: 'Sole', priority: 90, when: [{ path: 'memory.history.failedStageIds', includes: 'outfit' }] }),
    item('sole-default', file, { path: 'fit.md', heading: 'Sole', priority: 5 }),
    item('middle', 'between', { priority: 50 }),
  ];
  const failed = compileContext(entries, { memory: { history: { failedStageIds: ['outfit'] } } }, { budgetChars: 1000 });
  assert.equal(failed.text.match(/four causes/g)?.length, 1);
  assert.deepEqual(failed.decisions.map(entry => [entry.id, entry.selected, entry.reason]), [
    ['sole-after-failure', true, '触发条件成立；优先级 90'],
    ['middle', true, '阶段默认；优先级 50'],
    ['sole-default', false, '同一小节已由 sole-after-failure 注入'],
  ]);
  // Without the failure the default entry carries the section, after everything more important.
  const quiet = compileContext(entries, { memory: { history: { failedStageIds: [] } } }, { budgetChars: 1000 });
  assert.deepEqual(quiet.decisions.filter(entry => entry.selected).map(entry => entry.id), ['middle', 'sole-default']);
});
