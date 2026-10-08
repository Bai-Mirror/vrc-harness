import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { evaluateRule, parseRule } from '../../src/process/rule.ts';

const knowledge = fileURLToPath(new URL('../../builtin/knowledge/', import.meta.url));
const source = readFileSync(join(knowledge, 'process/pc-recolor-outfit.process.yaml'), 'utf8');
const definition = parse(source);
const find = (document: any, id: string) => (document.checks as { id: string; rule: string }[]).find(check => check.id === id)!;

// The optimize stage supports `mode=preserve` and may legally keep every import setting, so a run that lowers
// nothing is not a regression. Growth is still refused, and an unmeasured comparison is not agreement.
test('the texture-memory criterion refuses growth but not a legal no-change result', () => {
  const rule = parseRule(find(definition, 'perf_texture_memory_down').rule);
  const verdict = (metrics: Record<string, number | null>) => evaluateRule(rule, metrics, {}).result;

  assert.equal(verdict({ texture_memory_after: 90, baseline_texture_memory: 100 }), 'pass', 'a decrease passes');
  assert.equal(verdict({ texture_memory_after: 100, baseline_texture_memory: 100 }), 'pass',
    'preserve, or an already-compliant plan that keeps every texture, is a legal outcome');
  assert.equal(verdict({ texture_memory_after: 101, baseline_texture_memory: 100 }), 'violation', 'growth is refused');
  assert.equal(verdict({ texture_memory_after: 90 }), 'no_data', 'a missing baseline is not a comparison');
  assert.equal(verdict({ baseline_texture_memory: 100 }), 'no_data', 'a missing after-reading is not a comparison');

  // Mutation: the strict rule this fix replaced rejects the same legal no-change run, so the assertion above
  // is what the fix buys rather than a tautology.
  const mutant = parse(source.replace('rule: "texture_memory_after <= baseline_texture_memory"',
    'rule: "texture_memory_after < baseline_texture_memory"'));
  assert.equal(evaluateRule(parseRule(find(mutant, 'perf_texture_memory_down').rule),
    { texture_memory_after: 100, baseline_texture_memory: 100 }, {}).result, 'violation',
  'mutation: the old strict rule fails a legal no-change result');
});

// A plugin need not ship an internal Library directory at all, so the criterion cannot ask for one to exist.
// It asks that the directories the source project did have are all still in the project zip, at the same path.
test('the plugin-directory criterion counts source directories the zip lost, not directories that exist', () => {
  const rule = parseRule(find(definition, 'delivery_zip_keeps_plugin_dirs').rule);
  assert.deepEqual([...rule.metrics], ['missing_plugin_internal_dirs_in_zip']);

  assert.equal(evaluateRule(rule, { missing_plugin_internal_dirs_in_zip: 0 }, {}).result, 'pass',
    'a source project whose plugins ship no internal directory passes');
  assert.equal(evaluateRule(rule, { missing_plugin_internal_dirs_in_zip: 1 }, {}).result, 'violation',
    'one dropped source directory fails');
  assert.equal(evaluateRule(rule, {}, {}).result, 'no_data');

  const mutant = parse(source.replace('rule: "missing_plugin_internal_dirs_in_zip == 0"',
    'rule: "plugin_internal_library_dirs_in_zip > 0"'));
  const old = parseRule(find(mutant, 'delivery_zip_keeps_plugin_dirs').rule);
  assert.equal(evaluateRule(old, { plugin_internal_library_dirs_in_zip: 0 }, {}).result, 'violation',
    'mutation: the old rule fails a source project whose plugins have no internal Library directory');
  assert.equal(evaluateRule(old, { plugin_internal_library_dirs_in_zip: 1, missing_plugin_internal_dirs_in_zip: 0 }, {}).result,
    'pass', 'mutation: the old rule passed while a source directory the zip lost went unnoticed');
});
