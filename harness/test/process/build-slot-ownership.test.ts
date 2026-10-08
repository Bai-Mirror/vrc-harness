import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCopySlots, definition, manifest, producerOf, slotOf, upstream, writesOf } from '../fixtures/build-slots.ts';

/**
 * PF1 D5: a regression stage that rebuilds in `_harness_build/pre|final/project` re-derives the `build_pre`/`build`
 * artifact another stage owns. Builds are not byte-reproducible (26 members, 8 change on a same-source rebuild), so
 * the owner's checks go stale, the owner re-runs, the regression is invalidated again, and one paid Provider Run is
 * spent per lap. The fix is ownership: each producer writes only its own slot, and every other stage rebuilds and
 * measures a copy of its own.
 *
 * These read the published manifests, so a later edit that points a stage back at another stage's slot fails here
 * without any test fixture to keep in sync.
 */

/**
 * Nothing is exempt: both producers keep their slot to themselves, and `performance` (which only reads the final
 * slot) grants itself no project write. An entry here would have to name the stage, the kind and why the stage must
 * write a slot it does not produce.
 */
const EXCEPTIONS: Record<string, string[]> = {};

/** True when a granted write path is the path itself or a directory containing it. */
function covers(grant: string, path: string): boolean {
  const a = grant.replace(/\/+$/, ''), b = path.replace(/\/+$/, '');
  return a === '.' || a === b || b.startsWith(`${a}/`);
}

test('the two upstream build slots belong to their producing stage alone', () => {
  for (const kind of upstream) {
    const slot = slotOf(kind), producer = producerOf(kind);
    const slotDir = `_harness_build/${slot}`;
    for (const [id, stage] of Object.entries(manifest.stages)) {
      if (id === producer || EXCEPTIONS[id]?.includes(kind)) continue;
      assert.ok(!buildCopySlots(stage).includes(slot),
        `${id} runs build_copy.py on ${kind}'s slot ${slot}; it must copy a slot of its own`);
      // Measuring the built avatar in the producer's slot is fine; rebuilding it there is not.
      for (const step of stage.unitySteps ?? [])
        assert.ok(!(step.method === 'AVH.Harness.BuildStage.Run' && covers(slotDir, String(step.project ?? ''))),
          `${id} rebuilds ${kind} in its owner's slot (${step.project})`);
      for (const grant of writesOf(stage))
        assert.ok(!covers(grant, slotDir) && !covers(slotDir, grant),
          `${id} claims a write over ${kind}'s slot through allowedWrites ${grant}`);
    }
  }
});

test('a stage copies only a build slot it produces or owns by name', () => {
  for (const [id, stage] of Object.entries(manifest.stages)) {
    const produced = definition.stages.find(item => item.id === id)!.produces;
    const owned = upstream.filter(kind => produced.includes(kind)).map(slotOf);
    for (const slot of buildCopySlots(stage))
      assert.ok(slot === id || owned.includes(slot),
        `${id} copies build slot ${slot}, which it neither produces nor owns by name`);
  }
});

test('each regression stage rebuilds and measures a slot named for itself', () => {
  for (const stage of ['regression_pre', 'regression']) {
    const capability = manifest.stages[stage]!;
    assert.deepEqual(buildCopySlots(capability), [stage], `${stage} must rebuild its own slot`);
    const steps = capability.unitySteps ?? [];
    assert.ok(steps.length > 0 && steps.every(step => step.project === `_harness_build/${stage}/project`),
      `${stage} measures only its own copy`);
    assert.ok(steps.some(step => step.method === 'AVH.Harness.BuildStage.Run'), `${stage} rebuilds before measuring`);
    for (const kind of upstream) {
      const slotDir = `_harness_build/${slotOf(kind)}`;
      for (const grant of writesOf(capability))
        assert.ok(!covers(grant, slotDir), `${stage} must not claim a write over ${kind}'s slot through ${grant}`);
    }
  }
});
