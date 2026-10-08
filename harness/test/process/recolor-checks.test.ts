import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { evaluateRule, parseRule } from '../../src/process/rule.ts';

const knowledge = fileURLToPath(new URL('../../builtin/knowledge/', import.meta.url));
const definition = parse(readFileSync(join(knowledge, 'process/pc-recolor-outfit.process.yaml'), 'utf8'));
const thresholds = parse(readFileSync(join(knowledge, 'process/thresholds.yaml'), 'utf8'));
const find = (id: string) => (definition.checks as { id: string; rule: string }[]).find(check => check.id === id)!;
// Thresholds are declared, not bare: the rule engine is handed the numbers, so the fixture takes the
// declared value rather than restating it and drifting from the process definition.
const floor = { recolor_tier_min: (thresholds.t as Record<string, { value: number }>).recolor_tier_min!.value };

// A fixed colour must not be scaled into candidate tiers, so an order made only of fixed colours has one
// candidate to choose between rather than three. The tier check therefore cannot hold every plan to the
// relative form's floor, but it must still hold the relative form to it and still refuse a recipe that
// declared more candidates than it rendered.
test('the tier check accepts a single candidate only when every target is fixed', () => {
  const check = find('recolor_candidate_tiers');
  const rule = parseRule(check.rule);
  const verdict = (metrics: Record<string, number>) => evaluateRule(rule, metrics, floor).result;

  assert.equal(verdict({ candidate_tier_shortfall: 0, relative_target_count: 0, candidate_tier_count: 1 }), 'pass');
  assert.equal(verdict({ candidate_tier_shortfall: 0, relative_target_count: 1, candidate_tier_count: 3 }), 'pass');
  // A relative target still needs the floor: one candidate would mean nothing to choose between.
  assert.equal(verdict({ candidate_tier_shortfall: 2, relative_target_count: 1, candidate_tier_count: 1 }), 'violation');
  // Declaring two tiers and rendering one is a shortfall whatever the targets are.
  assert.equal(verdict({ candidate_tier_shortfall: 1, relative_target_count: 0, candidate_tier_count: 1 }), 'violation');
  // An observer that did not report the count cannot be taken as agreement.
  assert.equal(verdict({ relative_target_count: 0, candidate_tier_count: 1 }), 'no_data');
});

// Every check a stage lists has to exist, or the stage silently runs with one fewer guard than it declares.
test('every check the recolour stage requires is declared', () => {
  const declared = new Set((definition.checks as { id: string }[]).map(check => check.id));
  const stage = (definition.stages as { id: string; requires?: string[] }[]).find(entry => entry.id === 'recolor')!;
  const missing = (stage.requires ?? []).filter(id => !declared.has(id));
  assert.deepEqual(missing, [], 'a required check that is not declared never runs');
  for (const id of ['recolor_layer_verified', 'recolor_layer_alpha_preserved', 'recolor_layer_bound', 'recolor_material_plan_executable', 'recolor_material_bound']) {
    assert.ok(stage.requires!.includes(id), `${id} must guard the layered route`);
  }
});

// The ledger records writers, not slots. One slot can have two writers — a relative iris target and a
// layered main texture may share a copy — so the row count exceeds the replaced-slot count even when
// nothing is missing. The check reads the deduplicated slot count; comparing rows made it unsatisfiable
// for every plan containing such a pair (L1 §74, F21).
test('the ledger check reads the deduplicated slot count, not the row count', () => {
  const rule = parseRule(find('recolor_ledger_matches').rule);
  assert.deepEqual([...rule.metrics].sort(), ['recolor_ledger_slots', 'replaced_material_slots']);
  // The run's shape: 25 rows covering 24 slots, all 24 replaced. It must pass.
  assert.equal(evaluateRule(rule, { recolor_ledger_rows: 25, recolor_ledger_slots: 24, replaced_material_slots: 24 }, floor).result, 'pass');
  // A replaced slot the ledger never mentions is still a failure, which is what the check is for.
  assert.equal(evaluateRule(rule, { recolor_ledger_rows: 24, recolor_ledger_slots: 23, replaced_material_slots: 24 }, floor).result, 'violation');
  // Without the slot measurement the check is unknown, not passing.
  assert.equal(evaluateRule(rule, { recolor_ledger_rows: 25, replaced_material_slots: 24 }, floor).result, 'no_data');
});

test('material executability and binding gates reject zero hits, conflicts, stale or false binding evidence', () => {
  const executable = parseRule(find('recolor_material_plan_executable').rule);
  assert.equal(evaluateRule(executable, { material_plan_unverified: 0, material_write_conflicts: 0 }, floor).result, 'pass');
  for (const metrics of [{ material_plan_unverified: 1, material_write_conflicts: 0 },
    { material_plan_unverified: 0, material_write_conflicts: 1 }])
    assert.equal(evaluateRule(executable, metrics, floor).result, 'violation');
  assert.equal(evaluateRule(executable, {}, floor).result, 'no_data');
  const bound = parseRule(find('recolor_material_bound').rule);
  assert.equal(evaluateRule(bound, { material_bindings_missing: 0 }, floor).result, 'pass');
  assert.equal(evaluateRule(bound, { material_bindings_missing: 1 }, floor).result, 'violation');
  assert.equal(evaluateRule(bound, {}, floor).result, 'no_data');
});

// The three layered checks are stated as counts of problems, so zero is the only passing value and a
// missing measurement is not agreement.
test('the layered checks pass only on a measured zero', () => {
  for (const id of ['recolor_layer_verified', 'recolor_layer_alpha_preserved', 'recolor_layer_bound']) {
    const rule = parseRule(find(id).rule);
    const metric = rule.metrics[0]!;
    assert.deepEqual(rule.metrics, [metric], `${id} should read one metric`);
    assert.equal(evaluateRule(rule, { [metric]: 0 }, floor).result, 'pass', id);
    assert.equal(evaluateRule(rule, { [metric]: 1 }, floor).result, 'violation', id);
    assert.equal(evaluateRule(rule, {}, floor).result, 'no_data', id);
  }
});
