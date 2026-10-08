import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { loadProcess } from '../../src/process/load.ts';
import { loadCapabilities, type StageCapability } from '../../src/workflow/capabilities.ts';

/**
 * The published pc-recolor-outfit manifests, read by the tests that guard PF1 D5: a regression stage that
 * rebuilds in `_harness_build/pre|final/project` re-derives the `build_pre`/`build` artifact another stage owns.
 * Reading the real files means a later edit that points a stage back at another stage's slot fails without a
 * second copy of the manifest to keep in sync.
 */
const root = new URL('../../builtin/knowledge/process/', import.meta.url);
export const definition = loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml', root), 'utf8'),
  parseYaml(readFileSync(new URL('thresholds.yaml', root), 'utf8')) as Record<string, unknown>);
export const manifest = loadCapabilities(readFileSync(new URL('pc-recolor-outfit.capabilities.yaml', root), 'utf8'), definition);

/** The artifact kinds whose producers must keep their build slot to themselves. */
export const upstream = ['build_pre', 'build'] as const;

/** The one `_harness_build/<slot>/` a kind's declared artifact paths live under. */
export function slotOf(kind: (typeof upstream)[number]): string {
  const slots = new Set<string>();
  for (const path of manifest.artifacts[kind]!.paths) {
    const match = /^_harness_build\/([^/]+)\//.exec(path);
    assert.ok(match, `${kind} must live under _harness_build/<slot>/: ${path}`);
    slots.add(match[1]!);
  }
  assert.equal(slots.size, 1, `${kind} is one slot, got ${[...slots].join(', ')}`);
  return [...slots][0]!;
}

/** The slot every build_copy.py invocation in this stage's command/prepareCommand names. */
export function buildCopySlots(stage: StageCapability): string[] {
  const slots: string[] = [];
  for (const argv of [stage.command, stage.prepareCommand]) {
    if (!argv?.some(arg => /build_copy\.py$/.test(arg))) continue;
    const at = argv.indexOf('--slot');
    assert.notEqual(at, -1, 'build_copy.py is always invoked with an explicit --slot');
    slots.push(argv[at + 1]!);
  }
  return slots;
}

/** Every write path a stage grants itself. */
export function writesOf(stage: StageCapability): string[] {
  return [...stage.allowedWrites, ...(stage.runtimeWrites ?? []), ...(stage.runtimeTemporaryWrites ?? [])];
}

export function producerOf(kind: string): string {
  const producers = definition.stages.filter(stage => stage.produces.includes(kind)).map(stage => stage.id);
  assert.equal(producers.length, 1, `${kind} has exactly one producing stage, got ${producers.join(', ') || '(none)'}`);
  return producers[0]!;
}

/**
 * Which upstream kinds each regression round's own Run replaces with a new version, read from the manifest: a round
 * that copies the slot an upstream artifact lives in re-derives that artifact; a round that copies its own slot does
 * not touch it. This is the whole of the D5 fix, expressed as the scheduler's fixture sees it.
 */
export function rederivedBy(stageId: string): string[] {
  const slots = buildCopySlots(manifest.stages[stageId]!);
  return upstream.filter(kind => slots.includes(slotOf(kind)));
}
