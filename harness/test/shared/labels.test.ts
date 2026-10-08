import assert from 'node:assert/strict';
import test from 'node:test';
import * as shared from '../../src/shared/labels.ts';
import * as tui from '../../src/tui/format.ts';

test('the terminal and the GUI read one vocabulary: the TUI re-exports the shared tables instead of keeping a copy', () => {
  for (const name of ['taskState', 'stageState', 'stageMark', 'workflowState', 'verdictState', 'gateState', 'schedulerState',
    'when', 'firstLine', 'stageLabel', 'shortHash', 'shortId'] as const)
    assert.equal(tui[name], shared[name], `${name} is not the shared function`);
  assert.deepEqual(shared.schedulerState('paused'), ['调度已暂停', 'warn']);
  assert.deepEqual(shared.workflowState('active'), ['进行中', 'info']);
});

// 信息包装规范 §6.1：未映射的状态值只被上报、屏幕上仍以枚举名出现，等于把机器词给用户看。状态类取值现在读作
// 「状态正在确认（短标识）」；名称类取值（角色、种类）保留原拼写，细节层要靠它。
test('a state value without words says it is still being confirmed, and is reported so a new enum value is noticed', t => {
  const missing: string[] = [];
  shared.onMissingLabel((vocabulary, key) => missing.push(`${vocabulary}:${key}`));
  t.after(() => shared.onMissingLabel(undefined));
  assert.deepEqual(shared.taskState('PARKED'), ['状态正在确认（PARKED）', 'muted']);
  // Keys that exist on every object are values too, not table entries.
  assert.deepEqual(shared.gateState('constructor'), ['状态正在确认（constructor）', 'muted']);
  assert.deepEqual(shared.stageState('toString'), ['状态正在确认（toString）', 'muted']);
  assert.deepEqual(shared.taskState('RUNNING'), ['执行中', 'info']);
  assert.deepEqual(missing, ['task:PARKED', 'gate:constructor', 'stage:toString']);
  // A value that names something rather than reporting a state is shown as it is, and still reported.
  assert.deepEqual(shared.lookup('root role', { baseline: ['共同基线', 'muted'] }, 'transplanted'), ['transplanted', 'muted']);
});

test('times read as the terminal shows them: today only the time, otherwise month-day and time', () => {
  const now = new Date(2026, 8, 28, 20, 0);
  assert.equal(shared.when(new Date(2026, 8, 28, 18, 31).toISOString(), now), '18:31');
  assert.equal(shared.when(new Date(2026, 8, 27, 9, 5).toISOString(), now), '09-27 09:05');
  assert.equal(shared.when(null, now), '—');
});
