import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateProcess } from '../../src/process/aggregate.ts';
import type { AggregateInput, ProcessDefinition } from '../../src/process/types.ts';

const definition: ProcessDefinition = {
  schema: 'process/0.1', id: 'input-evidence', version: '1', applies_to: {},
  artifacts: ['plan', 'face_input', 'face', 'menu'],
  stages: [{ id: 'menu', needs: [], produces: ['menu'], requires: ['quality'], gates: ['accept'], invalidated_by: ['face_input'] }],
  checks: [{ id: 'quality', observe: 'measure', on: 'menu', scope: 'edit', rule: 'ok == true', severity: 'blocking', maturity: 'accepted' }],
  gates: [{ id: 'accept', kind: 'approve', binds: 'menu' }], milestones: [],
};
const input = (): AggregateInput => ({
  plan: {}, artifactHashes: { plan: 'p', face_input: 's2', menu: 'identical-bytes' },
  verdicts: [{ id: 'v1', checkId: 'quality', scope: 'edit', artifactHash: 'identical-bytes', result: 'pass', inputHashes: { face_input: 's1' } }],
  gateDecisions: [{ gateId: 'accept', artifactHash: 'identical-bytes', result: 'approved', inputHashes: { face_input: 's1' } }],
  completions: [], warningAcceptances: [], outOfBoundsChanges: [],
} as AggregateInput);

test('s2 output equal to s1 bytes cannot reuse either s1 evidence or s1 approval', () => {
  const state = aggregateProcess(definition, input()).stages.menu!;
  assert.equal(state.status, 'blocked');
  assert.ok(state.reasons.some(reason => reason.includes('stale verdict')));
  assert.ok(state.reasons.some(reason => reason.includes('stale decision')));
});

test('unknown historical input binding is stale only for input-dependent evidence', () => {
  const facts = input();
  delete (facts.verdicts[0] as any).inputHashes;
  delete (facts.gateDecisions[0] as any).inputHashes;
  assert.equal(aggregateProcess(definition, facts).stages.menu!.status, 'blocked');
  const legacy = structuredClone(definition); legacy.stages[0]!.invalidated_by = [];
  assert.equal(aggregateProcess(legacy, facts).stages.menu!.status, 'open');
});

test('not_applicable binds effective input even when the base plan bytes do not change', () => {
  const process = structuredClone(definition); process.checks[0]!.when = 'plan.design';
  const facts = input(); facts.verdicts[0]!.artifactHash = 'p'; facts.verdicts[0]!.result = 'not_applicable';
  facts.verdicts[0]!.basis = 'plan.design';
  assert.ok(aggregateProcess(process, facts).stages.menu!.reasons.some(reason => reason.includes('stale verdict')));
});
