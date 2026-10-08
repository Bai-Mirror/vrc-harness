import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnoseContext, type ContextSample } from '../src/context-diagnostics.ts';

function samples(version: string, start: number, passes: number, selected: string[], count = 5): ContextSample[] {
  return Array.from({ length: count }, (_, index) => ({ seq: start + index, taskId: `${version}-${start}-${index}`,
    stageId: 'outfit', knowledgeVersion: version, modelFamily: 'codex', attempt: 1, passed: index < passes,
    status: 'exited', taskStatus: index < passes ? 'PASSED' : 'FAILED',
    selected: selected.map(id => ({ id, sha256: id })) }));
}

test('context diagnostics conservatively flag version degradation, pollution and pair conflict', () => {
  const input = [
    ...samples('v1', 1, 5, ['core']), ...samples('v2', 20, 5, []),
    ...samples('v2', 30, 1, ['shoe']), ...samples('v2', 40, 5, ['menu']),
    ...samples('v2', 50, 0, ['shoe', 'menu']),
  ];
  const result = diagnoseContext(input);
  assert.ok(result.some(item => item.kind === 'version-degradation' && item.knowledgeVersion === 'v2'));
  assert.ok(result.some(item => item.kind === 'suspected-pollution' && item.itemIds.includes('shoe')));
  assert.ok(result.some(item => item.kind === 'suspected-conflict' && item.itemIds.join('+') === 'menu+shoe'));
  assert.ok(result.every(item => item.causal === false && item.baselineSamples >= 5 && item.observedSamples >= 5));
});

test('context diagnostics do not alert on small samples or retries', () => {
  const small = samples('v1', 1, 3, [], 3).concat(samples('v2', 10, 0, ['x'], 3));
  small.push({ ...small[0]!, seq: 100, attempt: 2, passed: false });
  assert.deepEqual(diagnoseContext(small), []);
});

test('unfinished work, cancelled attempts and unknown recovery cannot create a degradation alert', () => {
  const baseline = samples('v1', 1, 5, ['core']);
  for (const [status, taskStatus] of [['running', 'RUNNING'], ['exited', 'VERIFYING'],
    ['exited', 'WAITING_HUMAN'], ['cancelled', 'CANCELLED'], ['abandoned', 'RECOVERY_REQUIRED'],
    ['exited', 'CANCELLED']]) {
    const pending = samples('v2', 20, 0, ['new']).map(sample => ({ ...sample, status: status!, taskStatus: taskStatus! }));
    assert.deepEqual(diagnoseContext([...baseline, ...pending]), [], `${status}/${taskStatus} is not failure`);
  }
  assert.ok(diagnoseContext([...baseline, ...samples('v2', 20, 0, ['new'])])
    .some(item => item.kind === 'version-degradation'), 'settled real failures still count');
});

test('quota and authorization waits do not become context failures after their task settles', () => {
  const baseline = samples('v1', 1, 5, ['core']);
  for (const errorClass of ['rate_limit', 'auth', 'permission_denied']) {
    const waiting = samples('v2', 20, 0, ['new']).map(sample => ({ ...sample, taskStatus: 'PASSED', errorClass }));
    assert.deepEqual(diagnoseContext([...baseline, ...waiting]), [], errorClass);
  }
});
