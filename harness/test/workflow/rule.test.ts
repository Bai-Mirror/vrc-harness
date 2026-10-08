import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRule, parseRule, tryParseRule } from '../../src/process/rule.ts';

const run = (rule: string, metrics: Record<string, unknown>, thresholds: Record<string, number | boolean> = {}) =>
  evaluateRule(parseRule(rule), metrics, thresholds);

test('rules compare metrics and thresholds, with Python-style chained comparisons', () => {
  assert.equal(run('t.lo <= n <= t.hi', { n: 3 }, { lo: 1, hi: 5 }).result, 'pass');
  assert.equal(run('t.lo <= n <= t.hi', { n: 9 }, { lo: 1, hi: 5 }).result, 'violation');
  assert.equal(run('abs(delta) <= t.max and human == true', { delta: -0.4, human: true }, { max: 0.5 }).result, 'pass');
  assert.equal(run('a + b == c - 1', { a: 1, b: 2, c: 4 }).result, 'pass');
  assert.equal(run('2 * x / 4 > 1', { x: 3 }).result, 'pass');
  assert.equal(run('not flag', { flag: false }).result, 'pass');
  assert.equal(run('-x < 0', { x: 2 }).result, 'pass');
});

test('missing data never passes, but a branch that already decides the rule does not need it', () => {
  const missing = run('a == 0 and b == 0', { a: 0 });
  assert.equal(missing.result, 'no_data');
  assert.deepEqual(missing.missing, ['b']);
  assert.equal(run('a == 0 or b == 0', { a: 0 }).result, 'pass', 'true or unknown is true');
  assert.equal(run('a == 1 and b == 0', { a: 0 }).result, 'violation', 'false and unknown is false');
  assert.equal(run('a == 1 or b == 0', { a: 0 }).result, 'no_data', 'false or unknown stays unknown');
  assert.equal(run('x <= 1', { x: null }).result, 'no_data', 'null means not measured');
});

test('type errors and unknown thresholds are errors, not violations', () => {
  assert.equal(run('x == true', { x: 1 }).result, 'error');
  assert.equal(run('x < t.nope', { x: 1 }).result, 'error');
  assert.equal(run('x / 0 > 1', { x: 1 }).result, 'error');
  assert.equal(run('x', { x: 3 }).result, 'error', 'a number is not a verdict');
  assert.equal(run('x > 1', { x: 'three' }).result, 'error');
});

test('the parser reports what it could not read and lists referenced names', () => {
  assert.match(tryParseRule('a <<= 1').error!, /rule/);
  assert.match(tryParseRule('a ==').error!, /期望/);
  assert.match(tryParseRule('(a == 1').error!, /\)/);
  assert.match(tryParseRule('a.b == 1').error!, /不能含点/);
  const parsed = parseRule('t.min <= count and abs(skew) < t.max or ready == true');
  assert.deepEqual(parsed.metrics.sort(), ['count', 'ready', 'skew']);
  assert.deepEqual(parsed.thresholds.sort(), ['max', 'min']);
});
