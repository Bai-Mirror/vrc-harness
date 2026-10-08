import assert from 'node:assert/strict';
import test from 'node:test';
import { renderProgressL1 } from '../fixtures/progress-l1-component.ts';

const base = { id: 'done', status: 'passed', display: 'passed', reasons: [], task: undefined };

test('the ProgressL1 consumer calls a pass plus not-applicable Runtime projection complete', () => {
  const shown = renderProgressL1({ stages: [{ ...base, checks: [
    { id: 'pass', severity: 'blocking', observe: 'avatar.fit', verdict: { result: 'pass', current: true } },
    { id: 'na', severity: 'warning', observe: 'avatar.fit', verdict: { result: 'not_applicable', current: true } },
  ] }] });
  assert.match(shown, /当前有效检查正常：通过 1 · 不适用 1 · 已接受提醒 0/);
  assert.doesNotMatch(shown, /证据未完整/);
});

test('the ProgressL1 consumer calls a pass plus accepted warning Runtime projection complete', () => {
  const shown = renderProgressL1({ stages: [{ ...base, checks: [
    { id: 'pass', severity: 'blocking', observe: 'avatar.fit', verdict: { result: 'pass', current: true } },
    { id: 'warning', severity: 'warning', observe: 'avatar.fit', verdict: { result: 'violation', current: true, accepted: true } },
  ] }] });
  assert.match(shown, /当前有效检查正常：通过 1 · 不适用 0 · 已接受提醒 1/);
  assert.doesNotMatch(shown, /证据未完整/);
});

test('an entire not-applicable stage has no missing evidence row', () => {
  const shown = renderProgressL1({ stages: [
    { ...base, checks: [{ id: 'pass', severity: 'blocking', observe: 'avatar.fit', verdict: { result: 'pass', current: true } }] },
    { id: 'face_design', status: 'not_applicable', display: 'not_applicable', reasons: [], checks: [{ id: 'face', severity: 'blocking', observe: 'face.design' }] },
  ] });
  assert.doesNotMatch(shown, /待取证 1|证据未完整/);
});
