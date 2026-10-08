import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml, stringify } from 'yaml';
import test from 'node:test';
import { aggregateProcess } from '../../src/process/aggregate.ts';
import { evidenceInputHashes } from '../../src/process/evidence.ts';
import { loadProcess, sameProcessDefinition } from '../../src/process/load.ts';
import { knowledgeMeta } from '../../src/process/knowledge-meta.ts';
import { evaluateRule, parseRule } from '../../src/process/rule.ts';
import type { AggregateInput, ProcessDefinition } from '../../src/process/types.ts';
import { serializeWorkflowDefinition } from '../../src/workflow/runtime.ts';

const yaml = readFileSync(new URL('../fixtures/process.yaml', import.meta.url), 'utf8');
const thresholds = {
  schema: 'thresholds/0.1',
  version: 'fixture-1',
  t: { max_count: { value: 10, unit: 'items', maturity: 'accepted', source: 'fixture' } },
};
const definition = loadProcess(yaml, thresholds);

function snapshot(): AggregateInput {
  return {
    artifactHashes: { plan: 'p1', scene: 's1', build: 'b1', fbx: 'f1', delivery_package: 'd1' },
    plan: { features: true },
    verdicts: [
      { id: 'v-scene', checkId: 'scene_check', scope: 'edit', artifactHash: 's1', result: 'pass' },
      { id: 'v-warning', checkId: 'warning_check', scope: 'build', artifactHash: 'b1', result: 'pass' },
      { id: 'v-conditional', checkId: 'conditional_check', scope: 'build', artifactHash: 'b1', result: 'pass' },
      { id: 'v-package', checkId: 'package_check', scope: 'client', artifactHash: 'd1', result: 'pass' },
    ],
    gateDecisions: [
      { gateId: 'plan_approval', artifactHash: 'p1', result: 'approved' },
      { gateId: 'client_test', artifactHash: 'd1', result: 'done' },
    ],
    warningAcceptances: [],
    completions: [
      { stageId: 'setup', artifactHashes: { fbx: 'f1' } },
      { stageId: 'optional', artifactHashes: { plan: 'p1' } },
      { stageId: 'package', artifactHashes: { plan: 'p1' } },
    ],
    outOfBoundsChanges: [],
  };
}

function result(input = snapshot(), process = definition) { return aggregateProcess(process, input); }
function check(input: AggregateInput, id: string) { return input.verdicts.find(v => v.checkId === id)!; }
function stage(input: AggregateInput, id: string) { return result(input).stages[id]!; }

test('R1 valid scope and current artifact hash keep a Verdict valid', () => {
  assert.equal(result().stages.setup?.status, 'passed');
});

test('process checks accept optional presentation labels without changing semantic stage contracts', () => {
  const labelled = loadProcess(yaml.replace('  - id: scene_check', '  - id: scene_check\n    label: 场景检查'), thresholds);
  assert.equal(labelled.checks.find(check => check.id === 'scene_check')?.label, '场景检查');
  const plain = loadProcess(yaml, thresholds);
  assert.equal(sameProcessDefinition(labelled, plain), true, 'labels do not change stage tool adoption semantics');
});
test('the built-in recolour process names only the four approved warning checks', () => {
  const builtIn = parseYaml(readFileSync(new URL('../../builtin/knowledge/process/pc-recolor-outfit.process.yaml', import.meta.url), 'utf8')) as {
    checks: Array<{ id: string; severity: string; label?: string }>;
  };
  const warnings = builtIn.checks.filter(check => check.severity === 'warning');
  assert.deepEqual(warnings.map(check => check.id), [
    'regression_footwear_coverage_pre', 'regression_coverage_recorded_pre',
    'regression_footwear_coverage', 'regression_coverage_recorded',
  ]);
  assert.deepEqual(warnings.map(check => check.label), ['鞋履覆盖', '覆盖记录', '鞋履覆盖', '覆盖记录']);
});
test('R1 different scope cannot replace evidence; stale artifact hash is rejected', () => {
  const input = snapshot();
  check(input, 'scene_check').scope = 'build';
  assert.match(stage(input, 'setup').reasons.join(), /scope/);
  check(input, 'scene_check').scope = 'edit';
  input.artifactHashes.scene = 's2';
  assert.match(stage(input, 'setup').reasons.join(), /stale verdict/);
});
test('R1 false check when binds plan hash and rejects old or missing basis', () => {
  const input = snapshot();
  input.plan.features = false;
  const verdict = check(input, 'conditional_check');
  verdict.result = 'not_applicable'; verdict.basis = 'plan.features'; verdict.artifactHash = 'p1';
  assert.equal(stage(input, 'setup').status, 'passed');
  verdict.artifactHash = 'b1';
  assert.match(stage(input, 'setup').reasons.join(), /stale verdict/);
  verdict.artifactHash = 'p1'; verdict.basis = undefined;
  assert.match(stage(input, 'setup').reasons.join(), /basis/);
});

test('R2 all checks, gate, and completion pass a stage', () => assert.equal(result().stages.setup?.status, 'passed'));
test('R2 undecided Gate blocks stage passage', () => {
  const input = snapshot(); input.gateDecisions.shift();
  assert.equal(stage(input, 'setup').status, 'blocked');
  assert.match(stage(input, 'setup').reasons.join(), /gate plan_approval: undecided/);
});
test('R2 complete evidence without completion remains open', () => {
  const input = snapshot(); input.completions.shift();
  assert.equal(stage(input, 'setup').status, 'open');
});

test('R3 blocking pass permits passage; missing and all nonpass results block', () => {
  const input = snapshot();
  assert.equal(stage(input, 'setup').status, 'passed');
  input.verdicts.shift();
  assert.match(stage(input, 'setup').reasons.join(), /missing verdict/);
  for (const outcome of ['no_data', 'undecidable', 'error', 'violation'] as const) {
    const changed = snapshot(); check(changed, 'scene_check').result = outcome;
    assert.match(stage(changed, 'setup').reasons.join(), new RegExp(outcome));
  }
});

test('R4 accepted warning passes without rewriting its Verdict', () => {
  const input = snapshot(); check(input, 'warning_check').result = 'violation';
  input.warningAcceptances.push({ verdictId: 'v-warning' });
  assert.equal(stage(input, 'setup').status, 'passed');
  assert.equal(check(input, 'warning_check').result, 'violation');
});
test('R4 unaccepted warning blocks; acceptance expires with Verdict', () => {
  const input = snapshot(); check(input, 'warning_check').result = 'violation';
  assert.match(stage(input, 'setup').reasons.join(), /warning not accepted/);
  input.warningAcceptances.push({ verdictId: 'v-warning' });
  input.artifactHashes.build = 'b2';
  assert.match(stage(input, 'setup').reasons.join(), /stale verdict/);
});

test('R5 advisory failure or absence does not block', () => {
  const input = snapshot();
  input.verdicts.push({ id: 'v-advisory', checkId: 'advisory_check', scope: 'edit', artifactHash: 's1', result: 'error' });
  assert.equal(stage(input, 'setup').status, 'passed');
  input.verdicts.pop();
  assert.equal(stage(input, 'setup').status, 'passed');
});
test('R5 blocking failure still blocks while advisory is ignored', () => {
  const input = snapshot(); check(input, 'scene_check').result = 'error';
  assert.equal(stage(input, 'setup').status, 'blocked');
});

test('R6 accepted blocking loads; candidate blocking and tested warning are rejected', () => {
  assert.equal(definition.checks[0]?.maturity, 'accepted');
  assert.throws(() => loadProcess(yaml.replace('maturity: accepted', 'maturity: candidate'), thresholds), /only accepted/);
  assert.throws(() => loadProcess(yaml.replace('severity: warning\n    maturity: accepted', 'severity: warning\n    maturity: tested'), thresholds), /only accepted/);
});
test('a check whose rule the evaluator cannot parse is rejected when the definition loads', () => {
  assert.throws(() => loadProcess(yaml.replace('rule: count <= t.max_count', 'rule: count <= t.max_count && count >= 0'), thresholds),
    /: rule "count <= t\.max_count && count >= 0": 无法识别的字符/);
});
test('every rule in the built-in process definitions parses', () => {
  const root = new URL('../../builtin/knowledge/process/', import.meta.url);
  const table = parseYaml(readFileSync(new URL('thresholds.yaml', root), 'utf8')) as Record<string, unknown>;
  const definition = loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml', root), 'utf8'), table);
  assert.ok(definition.checks.length > 100);
});

test('a built-in definition survives the workflow_definition freeze serialization semantically', () => {
  const root = new URL('../../builtin/knowledge/process/', import.meta.url);
  const table = parseYaml(readFileSync(new URL('thresholds.yaml', root), 'utf8')) as Record<string, unknown>;
  const loaded = loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml', root), 'utf8'), table);
  const frozen = JSON.parse(serializeWorkflowDefinition(loaded));
  assert.equal(sameProcessDefinition(loaded, frozen), true);
});

test('semantic comparison preserves null values in loader-accepted open mappings', () => {
  const load = (process: any): ProcessDefinition => loadProcess(stringify(process), thresholds);
  const source = parseYaml(yaml);
  const top = structuredClone(source); top.applies_to = { platform: null };
  const topEmpty = structuredClone(source); topEmpty.applies_to = {};
  assert.equal(sameProcessDefinition(load(top), load(topEmpty)), false);
  for (const field of ['applies_to', 'environment']) {
    const left = structuredClone(source), right = structuredClone(source);
    left.checks[0][field] = { unity: { version: null } };
    right.checks[0][field] = { unity: {} };
    assert.equal(sameProcessDefinition(load(left), load(right)), false, field);
  }
  const left = structuredClone(source), right = structuredClone(source);
  for (const process of [left, right]) {
    process.checks[0].kind = 'observation';
    process.checks[0].severity = 'advisory';
  }
  left.checks[0].environment = { unity: null };
  right.checks[0].environment = { other: null };
  assert.equal(sameProcessDefinition(load(left), load(right)), false);
});

test('verification optional at null is equivalent to omission without dropping array entries', () => {
  const left = structuredClone(definition), right = structuredClone(definition);
  left.checks[0]!.verification = [{ kind: 'harness-regression', ref: 'fixture', at: null } as any];
  right.checks[0]!.verification = [{ kind: 'harness-regression', ref: 'fixture' }];
  assert.equal(sameProcessDefinition(left, right), true);
  left.checks[0]!.verification = [null as any];
  assert.equal(sameProcessDefinition(left, right), false);
});

test('an empty outfit plan still requires a measured producer before recolor can run', () => {
  const root = new URL('../../builtin/knowledge/process/', import.meta.url);
  const process = loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml', root), 'utf8'),
    parseYaml(readFileSync(new URL('thresholds.yaml', root), 'utf8')));
  const hashes = Object.fromEntries(process.artifacts.map(a => [a, `hash-${a}`]));
  const input: AggregateInput = { artifactHashes: hashes, plan: { outfits: [], client_gallery: true },
    verdicts: process.checks.filter(c => c.on !== 'outfits').map(c => ({ id: c.id, checkId: c.id, scope: c.scope,
      artifactHash: hashes[c.when === 'plan.avatar_config' ? 'plan' : c.on]!, result: c.when === 'plan.avatar_config' ? 'not_applicable' : 'pass', ...(c.when === 'plan.avatar_config' ? {basis: c.when} : {}) })),
    gateDecisions: process.gates.map(g => ({ gateId: g.id, artifactHash: hashes[g.binds]!, result: g.kind === 'do' ? 'done' : 'approved' })),
    completions: process.stages.slice(0, 4).map(s => ({ stageId: s.id, artifactHashes: hashes })),
    warningAcceptances: [], outOfBoundsChanges: [] };
  const state = aggregateProcess(process, input);
  assert.equal(state.stages.setup!.status, 'passed', JSON.stringify(state.stages));
  assert.notEqual(state.stages.outfit!.status, 'not_applicable');
  assert.notEqual(state.stages.outfit!.status, 'passed');
  assert.ok(state.stages.recolor!.reasonCodes!.includes('needs_unmet'));
});
test('a face candidate cannot reach outfit or delivery merely by passing geometry', () => {
  const root = new URL('../../builtin/knowledge/process/', import.meta.url);
  const process = loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml', root), 'utf8'),
    parseYaml(readFileSync(new URL('thresholds.yaml', root), 'utf8')));
  const hashes = Object.fromEntries(process.artifacts.map(a => [a, `hash-${a}`]));
  const input: AggregateInput = { artifactHashes: hashes, plan: { client_gallery: true, face: { mode: 'design' } },
    verdicts: process.checks.map(c => ({ id: c.id, checkId: c.id, scope: c.scope, artifactHash: hashes[c.when === 'plan.avatar_config' ? 'plan' : c.on]!,
      inputHashes: evidenceInputHashes(process, { checkId: c.id }, hashes),
      result: c.when === 'plan.avatar_config' ? 'not_applicable' : c.id === 'face_production_qualification' ? 'violation' : 'pass', ...(c.when === 'plan.avatar_config' ? {basis: c.when} : {}) })),
    gateDecisions: process.gates.map(g => ({ gateId: g.id, artifactHash: hashes[g.binds]!, result: g.kind === 'do' ? 'done' : g.kind === 'choose' ? 'chosen' : 'approved',
      inputHashes: evidenceInputHashes(process, { gateId: g.id }, hashes),
      ...(g.selection ? { selection: { schema: 'face-gate-choice/0.1', artifactHash: hashes[g.binds]!, selection: { candidateId: 'synthetic-proposed-option' } } } : {}) })),
    completions: process.stages.map(s => ({ stageId: s.id, artifactHashes: hashes })), warningAcceptances: [], outOfBoundsChanges: [] };
  const state = aggregateProcess(process, input);
  assert.equal(state.stages.setup!.status, 'passed');
  assert.equal(state.stages.face!.status, 'blocked');
  assert.ok(state.stages.outfit!.reasonCodes!.includes('needs_unmet'));
  assert.equal(state.milestones.UPLOAD_READY!.status, 'not_reached');
  const checks = process.stages.find(s => s.id === 'face')!.requires.map(id => process.checks.find(c => c.id === id)!);
  for (const check of checks) {
    assert.equal(evaluateRule(parseRule(check.rule), { face_input_bound: true, face_source_preserved_valid: true, face_geometry_valid: null,
      face_runtime_bindings_valid: null, face_fully_qualified: false }, {}).result, 'pass');
  }
  const qualification = checks.find(c => c.id === 'face_production_qualification')!;
  assert.equal(evaluateRule(parseRule(qualification.rule), { face_source_preserved_valid: false, face_geometry_valid: true,
    face_runtime_bindings_valid: true, face_expression_compensation_valid: false, face_damage_smoothness_valid: true, face_damage_smoothness_measured: true,
    face_eye_region_valid: true, face_eye_exposure_measured: true, face_fully_qualified: false }, {}).result, 'violation');
  const technical = { face_source_preserved_valid: false, face_expression_compensation_valid: true, face_damage_smoothness_valid: true, face_damage_smoothness_measured: true,
    face_eye_region_valid: true, face_eye_exposure_measured: true, face_fully_qualified: false };
  assert.equal(evaluateRule(parseRule(qualification.rule), technical, {}).result, 'pass', 'full qualification does not deadlock the real human review');
  assert.equal(evaluateRule(parseRule(qualification.rule), { ...technical, face_eye_exposure_measured: null }, {}).result, 'no_data', 'an unmeasured eye check is not passed');
  assert.equal(evaluateRule(parseRule(qualification.rule), { ...technical, face_eye_region_valid: false }, {}).result, 'pass', 'a historical exposure reference is advisory while the human appearance gate remains pending');
  assert.equal(evaluateRule(parseRule(qualification.rule), { ...technical, face_damage_smoothness_valid: false }, {}).result, 'pass', 'quality findings proceed to real user review');
  assert.equal(evaluateRule(parseRule(qualification.rule), { ...technical, face_damage_smoothness_measured: null }, {}).result, 'no_data', 'missing quality evidence still blocks');
  input.verdicts.find(verdict => verdict.checkId === qualification.id)!.result = 'pass';
  assert.equal(aggregateProcess(process, input).stages.face!.status, 'blocked', 'technical success and a generic bool do not imply actual output review');
  assert.deepEqual(aggregateProcess(process, input).stages.face!.reasonCodes, ['gate_pending']);
  const review = input.gateDecisions.find(decision => decision.gateId === 'face_appearance')!;
  review.selection = { schema: 'face-output-acceptance/0.1', artifactHash: hashes.face!, previewSha256: 'a'.repeat(64) };
  assert.equal(aggregateProcess(process, input).stages.face!.status, 'passed');
  assert.equal(aggregateProcess(process, input).stages.outfit!.status, 'passed');
  input.artifactHashes.face = 'changed-preview-or-output';
  assert.equal(aggregateProcess(process, input).stages.face!.status, 'blocked', 'a changed output or picture invalidates acceptance');
});

test('optional design requires its concrete choice, while preservation skips candidates and candidate changes reopen application', () => {
  const process: ProcessDefinition = { schema: 'process/0.1', id: 'optional-choice', version: '1', applies_to: {}, artifacts: ['plan', 'candidates', 'output'],
    stages: [
      { id: 'plan', needs: [], produces: ['plan'], requires: [], gates: [], invalidated_by: [] },
      { id: 'design', needs: ['plan'], when: 'plan.face.mode == "design"', produces: ['candidates'], requires: [], gates: ['choice'], invalidated_by: ['plan'] },
      { id: 'apply', needs: ['design'], produces: ['output'], requires: [], gates: [], invalidated_by: ['plan', 'candidates'] },
    ], checks: [], gates: [{ id: 'choice', kind: 'choose', selection: 'face-candidate', binds: 'candidates' }], milestones: [] };
  const input: AggregateInput = { artifactHashes: { plan: 'p', output: 'o' }, plan: { face: { mode: 'preserve' } }, verdicts: [], gateDecisions: [],
    completions: [{ stageId: 'plan', artifactHashes: {} }, { stageId: 'apply', artifactHashes: { plan: 'p' } }], warningAcceptances: [], outOfBoundsChanges: [] };
  assert.equal(aggregateProcess(process, input).stages.design!.status, 'not_applicable');
  assert.equal(aggregateProcess(process, input).stages.apply!.status, 'passed', 'preservation never needs a fictional candidate or choice');
  input.plan = { face: { mode: 'design' } }; input.artifactHashes.candidates = 'c1';
  input.completions.push({ stageId: 'design', artifactHashes: { plan: 'p' } });
  input.gateDecisions.push({ gateId: 'choice', artifactHash: 'c1', result: 'chosen' });
  assert.equal(aggregateProcess(process, input).stages.design!.status, 'blocked', 'chosen boolean without an option cannot authorize design');
  input.gateDecisions[0]!.selection = { schema: 'face-gate-choice/0.1', artifactHash: 'c1', selection: { candidateId: 'a' } };
  assert.equal(aggregateProcess(process, input).stages.apply!.status, 'open', 'prior preservation completion cannot apply a newly selected design');
  input.completions[1]!.artifactHashes.candidates = 'c1';
  assert.equal(aggregateProcess(process, input).stages.apply!.status, 'passed');
  input.artifactHashes.candidates = 'c2';
  input.gateDecisions.push({ gateId: 'choice', artifactHash: 'c2', result: 'chosen', selection: { schema: 'face-gate-choice/0.1', artifactHash: 'c2', selection: { candidateId: 'b' } } });
  assert.equal(aggregateProcess(process, input).stages.apply!.status, 'open', 'a new chosen version needs a new actual application');
});

test('R6 deprecated advisory is not executed', () => {
  const process: ProcessDefinition = structuredClone(definition);
  process.checks.find(c => c.id === 'advisory_check')!.maturity = 'deprecated';
  assert.equal(result(snapshot(), process).stages.setup?.status, 'passed');
});

test('R7 current hashes preserve stage and downstream passage', () => {
  assert.equal(result().stages.package?.status, 'passed');
});
test('R7 invalidated_by change revokes stage and downstream; Gate hash change stales decision', () => {
  const input = snapshot(); input.artifactHashes.fbx = 'f2';
  assert.equal(stage(input, 'setup').status, 'open');
  assert.equal(stage(input, 'package').status, 'waiting');
  const second = snapshot(); second.artifactHashes.plan = 'p2';
  assert.match(stage(second, 'setup').reasons.join(), /stale decision/);
});

test('R8 declared produces change is permitted', () => {
  const input = snapshot(); input.outOfBoundsChanges.push({ stageId: 'setup', artifact: 'scene' });
  assert.equal(stage(input, 'setup').status, 'passed');
});
test('R8 undeclared Run change blocks until accepted', () => {
  const input = snapshot(); input.outOfBoundsChanges.push({ stageId: 'setup', artifact: 'fbx' });
  assert.match(stage(input, 'setup').reasons.join(), /out-of-bounds/);
  input.outOfBoundsChanges[0]!.accepted = true;
  assert.equal(stage(input, 'setup').status, 'passed');
});

test('R9 all declared conditions reach milestone; undeclared conditions are satisfied', () => {
  assert.equal(result().milestones.UPLOAD_READY?.status, 'reached');
  assert.equal(result().milestones.EMPTY_CONDITIONS?.status, 'reached');
});
test('R9 evidence and after invalidation revoke dependent milestone', () => {
  const input = snapshot(); input.artifactHashes.delivery_package = 'd2';
  assert.equal(result(input).milestones.UPLOAD_READY?.status, 'not_reached');
  assert.match(result(input).milestones.CLIENT_VERIFIED?.reasons.join(), /after UPLOAD_READY/);
});
test('R9 milestone Gate must be decided on its current bound hash', () => {
  const input = snapshot(); input.gateDecisions.pop();
  assert.equal(result(input).milestones.CLIENT_VERIFIED?.status, 'not_reached');
  assert.match(result(input).milestones.CLIENT_VERIFIED?.reasons.join(), /gate client_test: undecided/);
  input.gateDecisions.push({ gateId: 'client_test', artifactHash: 'old', result: 'done' });
  assert.match(result(input).milestones.CLIENT_VERIFIED?.reasons.join(), /stale decision/);
});

test('R10 false stage becomes not_applicable after ancestors and permits downstream', () => {
  const input = snapshot(); input.plan.features = false;
  const verdict = check(input, 'conditional_check');
  verdict.result = 'not_applicable'; verdict.basis = 'plan.features'; verdict.artifactHash = 'p1';
  assert.equal(stage(input, 'optional').status, 'not_applicable');
  assert.equal(stage(input, 'package').status, 'passed');
});
test('R10 false stage cannot skip unmet ancestor; true condition reopens it', () => {
  const input = snapshot(); input.plan.features = false; input.completions.shift();
  assert.equal(stage(input, 'optional').status, 'waiting');
  const second = snapshot(); second.completions.splice(1, 1);
  assert.equal(stage(second, 'optional').status, 'open');
  assert.equal(stage(second, 'package').status, 'waiting');
});
test('R10 empty plan collections are false for when truth tests', () => {
  const input = snapshot(); input.plan.features = [];
  const verdict = check(input, 'conditional_check');
  verdict.result = 'not_applicable'; verdict.basis = 'plan.features'; verdict.artifactHash = 'p1';
  assert.equal(stage(input, 'optional').status, 'not_applicable');
});

test('loader closes references, artifacts, thresholds, when, and needs cycles', () => {
  assert.throws(() => loadProcess(yaml.replace('needs: [setup]', 'needs: [missing]'), thresholds), /undefined reference missing/);
  assert.throws(() => loadProcess(yaml.replace('requires: [package_check]', 'requires: [missing]'), thresholds), /undefined reference missing/);
  assert.throws(() => loadProcess(yaml.replace('gates: [plan_approval]', 'gates: [missing]'), thresholds), /undefined reference missing/);
  assert.throws(() => loadProcess(yaml.replace('after: UPLOAD_READY', 'after: MISSING'), thresholds), /undefined reference MISSING/);
  assert.throws(() => loadProcess(yaml.replace('on: scene', 'on: unknown'), thresholds), /undefined reference unknown/);
  assert.throws(() => loadProcess(yaml.replace('produces: [scene, build]', 'produces: [unknown, build]'), thresholds), /undefined reference unknown/);
  assert.throws(() => loadProcess(yaml.replace('invalidated_by: [fbx]', 'invalidated_by: [unknown]'), thresholds), /undefined reference unknown/);
  assert.throws(() => loadProcess(yaml, { ...thresholds, t: {} }), /undefined threshold/);
  assert.throws(() => loadProcess(yaml.replace('when: plan.features', 'when: plan.features == true'), thresholds), /only plan/);
  assert.throws(() => loadProcess(yaml.replace('needs: []', 'needs: [package]'), thresholds), /cycle/);
});

test('loader accepts negated plan truth test and rejects duplicate YAML keys', () => {
  assert.equal(loadProcess(yaml.replace('when: plan.features', 'when: "!plan.features"'), thresholds).stages[1]?.when, '!plan.features');
  assert.throws(() => loadProcess(yaml.replace('schema: process/0.1', 'schema: process/0.1\nschema: process/0.1'), thresholds), /YAML/);
});

test('loader accepts the complete thresholds/0.1 document and rejects legacy lookup forms', () => {
  assert.equal(loadProcess(yaml, thresholds).checks[0]?.id, 'scene_check');
  assert.throws(() => loadProcess(yaml, { max_count: 10 }), /thresholds.schema/);
  assert.throws(() => loadProcess(yaml, { 't.max_count': thresholds.t.max_count }), /thresholds.schema/);
  assert.throws(() => loadProcess(yaml, { ...thresholds, t: { 't.max_count': thresholds.t.max_count } }), /undefined threshold t.max_count/);
});

test('loader currently ignores unknown optional keys on thresholds and checks', () => {
  const table = { ...thresholds, t: { max_count: { ...thresholds.t.max_count, future_key: 'ignored' } } };
  const changed = yaml.replace('    maturity: accepted\n  - id: warning_check', '    maturity: accepted\n    future_key: ignored\n  - id: warning_check');
  assert.equal(loadProcess(changed, table).checks[0]?.id, 'scene_check');
});

test('v0.1.2 metadata loads with defaults and all optional keys', () => {
  // Absent keys mean the defaults (spec, local, unknown) but are not materialized into the parsed definition.
  assert.equal(definition.checks[0]?.kind, undefined);
  assert.equal(definition.checks[0]?.visibility, undefined);
  assert.equal(definition.checks[0]?.validity, undefined);
  assert.deepEqual(knowledgeMeta({}, 'x'), { kind: 'spec', asserted_by: undefined, source_id: undefined, applies_to: undefined,
    environment: undefined, recorded_at: undefined, verification: [], visibility: 'local', validity: 'unknown', supersedes: undefined });
  const metadata = { kind: 'observation', asserted_by: 'human:reviewer', source_id: '0123456789ab',
    applies_to: { platform: 'PC', plugin_version: '1.2.3' }, environment: { host: 'sandbox', plugin_version: '1.2.3' },
    recorded_at: '2026-09-27T01:02:03Z', verification: [{ at: '2026-09-27T02:00:00Z', kind: 'field-report', ref: 'event-1' }],
    visibility: 'shareable', validity: 'valid', supersedes: 'old-id' };
  const table = { ...thresholds, t: { max_count: { ...thresholds.t.max_count, ...metadata } } };
  const changed = yaml.replace('    maturity: accepted\n  - id: warning_check',
    `    maturity: accepted\n${Object.entries(metadata).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join('\n')}\n  - id: warning_check`);
  const loaded = loadProcess(changed, table);
  assert.equal(loaded.checks[0]?.kind, 'observation');
  assert.equal(loaded.checks[0]?.verification?.[0]?.kind, 'field-report');
});

test('v0.1.2 metadata reports invalid enum locations and observation environment', () => {
  for (const field of ['kind', 'visibility', 'validity']) {
    const table = { ...thresholds, t: { max_count: { ...thresholds.t.max_count, [field]: 'bad' } } };
    assert.throws(() => loadProcess(yaml, table), new RegExp(`thresholds.t.max_count.${field}: unsupported bad`));
  }
  assert.throws(() => loadProcess(yaml, { ...thresholds, t: { max_count: { ...thresholds.t.max_count, kind: 'observation' } } }),
    /thresholds.t.max_count.environment: required/);
  assert.throws(() => loadProcess(yaml.replace('    maturity: accepted\n  - id: warning_check',
    '    maturity: accepted\n    kind: observation\n  - id: warning_check'), thresholds), /checks\[0\].environment: required/);
  assert.throws(() => loadProcess(yaml.replace('    maturity: accepted\n  - id: warning_check',
    '    maturity: accepted\n    verification: [{kind: false-kind, ref: example}]\n  - id: warning_check'), thresholds),
    /checks\[0\].verification\[0\].kind: unsupported false-kind/);
});

test('K-01 hypothesis and case cannot drive blocking or warning checks', () => {
  for (const kind of ['hypothesis', 'case']) {
    const table = { ...thresholds, t: { max_count: { ...thresholds.t.max_count, kind } } };
    assert.throws(() => loadProcess(yaml, table), new RegExp(`scene_check: blocking check cannot reference ${kind} threshold t.max_count`));
    assert.throws(() => loadProcess(yaml.replace('    maturity: accepted\n  - id: warning_check',
      `    maturity: accepted\n    kind: ${kind}\n  - id: warning_check`), thresholds),
    new RegExp(`scene_check: ${kind} check cannot be blocking or warning`));
    const advisoryOnly = yaml.replaceAll('t.max_count', 't.other_count');
    const advisoryTable = { ...thresholds, t: { other_count: thresholds.t.max_count, max_count: { ...thresholds.t.max_count, kind } } };
    assert.equal(loadProcess(advisoryOnly.replace('rule: count <= t.other_count\n    severity: advisory',
      'rule: count <= t.max_count\n    severity: advisory'), advisoryTable).checks.length, 5);
  }
});

test('loader requires threshold schema, version, t mapping, and each entry field', () => {
  assert.throws(() => loadProcess(yaml, { ...thresholds, schema: 'other' }), /thresholds.schema/);
  assert.throws(() => loadProcess(yaml, { ...thresholds, version: '' }), /thresholds.version/);
  assert.throws(() => loadProcess(yaml, { ...thresholds, t: undefined }), /thresholds.t: expected mapping/);
  for (const field of ['value', 'unit', 'maturity', 'source']) {
    const entry = { ...thresholds.t.max_count } as Record<string, unknown>;
    delete entry[field];
    assert.throws(() => loadProcess(yaml, { ...thresholds, t: { max_count: entry } }), new RegExp(`thresholds.t.max_count.${field}`));
  }
  assert.throws(() => loadProcess(yaml, { ...thresholds, t: { max_count: { ...thresholds.t.max_count, maturity: 'unknown' } } }), /maturity: unsupported/);
});

test('loader accepts requires_stages all and a defined stage list', () => {
  assert.equal(definition.milestones[0]?.requires_stages, 'all');
  const selected = loadProcess(yaml.replace('requires_stages: all', 'requires_stages: [setup]'), thresholds);
  assert.deepEqual(selected.milestones[0]?.requires_stages, ['setup']);
  const input = snapshot();
  input.completions.pop();
  assert.equal(result(input).milestones.UPLOAD_READY?.status, 'not_reached');
  assert.equal(result(input, selected).milestones.UPLOAD_READY?.status, 'reached');
});

test('loader rejects undefined requires_stages list members', () => {
  assert.throws(() => loadProcess(yaml.replace('requires_stages: all', 'requires_stages: [missing]'), thresholds), /UPLOAD_READY.requires_stages: undefined reference missing/);
});

test('loader accepts an invalidation graph with no producer feedback', () => {
  assert.equal(loadProcess(yaml, thresholds).stages[0]?.invalidated_by[0], 'fbx');
});

test('loader rejects invalidation by a stage own product', () => {
  assert.throws(() => loadProcess(yaml.replace('invalidated_by: [fbx]', 'invalidated_by: [scene]'), thresholds), /setup.invalidated_by: scene/);
});

test('loader rejects invalidation by a transitive downstream product', () => {
  assert.throws(() => loadProcess(yaml.replace('invalidated_by: [fbx]', 'invalidated_by: [delivery_package]'), thresholds), /setup.invalidated_by: delivery_package/);
});

test('loader allows a check bound to its own stage product', () => {
  assert.equal(loadProcess(yaml, thresholds).stages[0]?.requires.includes('scene_check'), true);
});

test('loader rejects a check bound to a downstream stage product', () => {
  const changed = yaml.replace('    requires: []', '    requires: [package_check]');
  assert.throws(() => loadProcess(changed, thresholds), /optional\.requires: check package_check on delivery_package is produced by a downstream stage/);
});

test('loader checks each stage when two stages require the same check', () => {
  const changed = yaml.replace('scene_check, warning_check', 'scene_check, package_check, warning_check');
  assert.throws(() => loadProcess(changed, thresholds), /setup\.requires: check package_check on delivery_package is produced by a downstream stage/);
});

test('loader permits accepted thresholds in blocking and warning checks', () => {
  assert.equal(loadProcess(yaml, thresholds).checks.length, 5);
});

test('loader rejects candidate threshold in a blocking rule', () => {
  const table = { ...thresholds, t: { ...thresholds.t, experimental: { value: 20, unit: 'items', maturity: 'candidate', source: 'fixture' } } };
  const changed = yaml.replace('rule: count <= t.max_count', 'rule: count <= t.max_count and count <= t.experimental');
  assert.throws(() => loadProcess(changed, table), /scene_check: blocking check requires accepted threshold t.experimental/);
});

test('loader rejects tested threshold in a warning rule', () => {
  const table = { ...thresholds, t: { ...thresholds.t, experimental: { value: 20, unit: 'items', maturity: 'tested', source: 'fixture' } } };
  const changed = yaml.replace('rule: count <= t.max_count\n    severity: warning', 'rule: count <= t.experimental\n    severity: warning');
  assert.throws(() => loadProcess(changed, table), /warning_check: warning check requires accepted threshold t.experimental/);
});

test('loader permits a candidate threshold in an advisory rule', () => {
  const table = { ...thresholds, t: { ...thresholds.t, experimental: { value: 20, unit: 'items', maturity: 'candidate', source: 'fixture' } } };
  const changed = yaml.replace('rule: count <= t.max_count\n    severity: advisory', 'rule: count <= t.experimental\n    severity: advisory');
  assert.equal(loadProcess(changed, table).checks.find(check => check.id === 'advisory_check')?.rule, 'count <= t.experimental');
});

test('definitions without v0.1.2 metadata parse unchanged, so the hashed definition JSON is stable', () => {
  const metaKeys = ['kind', 'asserted_by', 'source_id', 'applies_to', 'environment', 'recorded_at', 'verification',
    'visibility', 'validity', 'supersedes'];
  for (const check of definition.checks)
    for (const key of metaKeys) assert.equal(Object.hasOwn(check, key), false, `${check.id} gained ${key}`);
  const tagged = loadProcess(yaml.replace(/(\n\s+maturity: accepted)/, '$1\n    kind: spec'), thresholds);
  assert.equal(tagged.checks.filter(check => check.kind === 'spec').length, 1);
});
