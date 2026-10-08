import type { ProcessDefinition } from './types.ts';

/** Logical inputs are version identities, independent of the bytes an execution happens to produce. */
export function evidenceInputHashes(definition: ProcessDefinition, target: { checkId?: string; gateId?: string },
  hashes: Record<string, string>, runtimeInputs: string[] = ['face_input']): Record<string, string> {
  const artifact = target.checkId ? definition.checks.find(item => item.id === target.checkId)?.on
    : definition.gates.find(item => item.id === target.gateId)?.binds;
  const stages = definition.stages.filter(stage => stage.produces.includes(artifact ?? '') ||
    (target.checkId ? stage.requires.includes(target.checkId) : stage.gates.includes(target.gateId ?? '')));
  // Milestone gates inherit the input contract of their bound artifact's producers too.
  const required = runtimeInputs.filter(kind => stages.some(stage => stage.invalidated_by.includes(kind)));
  return Object.fromEntries(required.map(kind => [kind, hashes[kind] ?? '']));
}

/** Shared by aggregation, gate presentation and decision submission. Missing historical bindings remain unknown. */
export function evidenceFresh(artifactHash: string, expectedArtifactHash: string | undefined,
  recordedInputs: Record<string, string> | undefined, expectedInputs: Record<string, string>): boolean {
  return Boolean(expectedArtifactHash) && artifactHash === expectedArtifactHash &&
    Object.entries(expectedInputs).every(([kind, hash]) => Boolean(hash) && recordedInputs?.[kind] === hash);
}
