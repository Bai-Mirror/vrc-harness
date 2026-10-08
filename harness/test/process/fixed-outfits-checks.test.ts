import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { loadProcess } from '../../src/process/load.ts';
import { loadCapabilities } from '../../src/workflow/capabilities.ts';
import { evaluateRule, parseRule } from '../../src/process/rule.ts';
const base = new URL('../../builtin/knowledge/process/', import.meta.url);
test('fixed membership blocks outfit, recolor, both builds and both regression gates on failure or no data', () => {
  const process = loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml', base), 'utf8'), parse(readFileSync(new URL('thresholds.yaml', base), 'utf8')));
  const capabilities = loadCapabilities(readFileSync(new URL('pc-recolor-outfit.capabilities.yaml', base), 'utf8'), process);
  for (const [stage, suffix] of [['outfit', 'installed'], ['recolor', 'recolored'], ['build_pre', 'built_pre'], ['build', 'built'], ['regression_pre', 'regression_pre'], ['regression', 'regression']]) {
    const id = `fixed_outfits_${suffix}`;
    assert.ok(process.stages.find(s => s.id === stage)!.requires.includes(id));
    const check = process.checks.find(c => c.id === id)!;
    assert.equal(check.severity, 'blocking'); assert.ok(capabilities.observers[check.observe]);
    const rule = parseRule(check.rule);
    assert.equal(evaluateRule(rule, { fixed_outfit_state_failures: 0 }, {}).result, 'pass');
    assert.equal(evaluateRule(rule, { fixed_outfit_state_failures: 1 }, {}).result, 'violation');
    assert.equal(evaluateRule(rule, {}, {}).result, 'no_data');
  }
});
