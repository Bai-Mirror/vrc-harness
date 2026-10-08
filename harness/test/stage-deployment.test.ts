// The deployment a stage declares must cover every compiler source that stage's own tool verifies.
//
// This is the test the two real failures should have had. The recolour preparation verified nine sources
// while the deployment record listed eight, and the face contract demands all nine of its compiled targets
// match, so each stage refused to start. Asserting the pack's declarations against the source lists the
// tools themselves carry is what keeps the two from drifting again.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { loadCapabilities, stageDeployment, toolReferences } from '../src/workflow/capabilities.ts';
import { loadProcess } from '../src/process/load.ts';

const builtin = fileURLToPath(new URL('../builtin/', import.meta.url));
const processDir = join(builtin, 'knowledge/process');
const tools = join(builtin, 'tools/harness');

const definition = loadProcess(readFileSync(join(processDir, 'pc-recolor-outfit.process.yaml'), 'utf8'),
  parse(readFileSync(join(processDir, 'thresholds.yaml'), 'utf8')));
const capabilities = loadCapabilities(readFileSync(join(processDir, 'pc-recolor-outfit.capabilities.yaml'), 'utf8'), definition);

/** The compiler sources a Python tool's own contract insists on, read from its source text. */
function declaredSources(text: string): string[] {
  const names = (value: string | undefined) => value?.replace(/^[^=]*=\s*/, '').trim()
    .replace(/^\{|\}$/g, '').split(',').map(part => part.trim().replace(/^"|"$/g, '')).filter(Boolean) ?? [];
  return [...names(/^CS\s*=.*$/m.exec(text)?.[0]), ...names(/^OPTIONAL_CS\s*=.*$/m.exec(text)?.[0])];
}

const compilerSources = (stage: string) => stageDeployment(capabilities.stages[stage]!)
  .filter(entry => entry.source.endsWith('.cs')).map(entry => entry.source.split('/').at(-1)!).sort();

/** What the deployment would be if it were still read out of the commands alone. */
const fromCommand = (stage: string) => {
  const capability = capabilities.stages[stage]!;
  const declared = new Set(stageDeployment(capability).map(entry => entry.target));
  return [...new Set(toolReferences([...(capability.command ?? []), ...(capability.prepareCommand ?? [])]))]
    .map(source => 'Assets/_HarnessTools/Editor/' + source.split('/').at(-1)!)
    .filter(target => declared.has(target))
    .map(target => target.split('/').at(-1)!).sort();
};

test('every compiler source the recolour preparation verifies is in the deployment the stage declares', () => {
  // The preparation passes its compiler sources on to local_operations.contract, which refuses any source
  // without a matching deployment entry, so the command and the declaration are two statements of one set.
  const passed = (capabilities.stages.recolor!.prepareCommand ?? [])
    .filter(value => value.endsWith('.cs')).map(value => value.split('/').at(-1)!).sort();
  assert.ok(passed.includes('RecolorStage.cs'), 'the recolour compiler must be among the verified sources');
  assert.deepEqual(compilerSources('recolor'), passed,
    'the recolour deployment must cover every compiler source its preparation verifies');
});

test('the face deployment covers every compiler target its contract requires', () => {
  const face = readFileSync(join(tools, 'face.py'), 'utf8');
  const required = declaredSources(face);
  assert.ok(required.includes('FaceStage.cs'), 'the face contract must declare its compiler set');
  const deployed = compilerSources('face');
  for (const name of required) if (name !== 'FacePreviewStage.cs')
    assert.ok(deployed.includes(name), `the face deployment is missing ${name}`);
  // The preview compiler is required for this pack version, which is why it is declared rather than left
  // to the tool to infer from whichever sources it happens to receive.
  assert.ok(deployed.includes('FacePreviewStage.cs'),
    'the preview compiler must be a declared deployment, not a choice the tool makes at run time');
});

test('a stage that names a helper still deploys what the helper verifies', () => {
  // The recolour prepare command names material_dependencies.py and lists the compiler sources after it;
  // the runtime tool that actually runs is face.py, whose execute command names none of them. Reading the
  // deployment out of the command therefore covered less than the preparation verifies.
  const face = capabilities.stages.face!;
  const declared = compilerSources('face');
  assert.deepEqual(declared, ['AvhCommon.cs', 'FaceEyes.cs', 'FaceGeometry.cs', 'FaceMapping.cs', 'FacePreviewStage.cs',
    'FaceStage.cs', 'LocalOperations.cs', 'OutfitStage.cs', 'SetupStage.cs'],
    'the face deployment is the compiler set the pack ships, stated once');
  assert.deepEqual(fromCommand('face'), declared, 'today the commands and the declaration agree');
});

test('the outfit deployment covers exactly the compiler sources its stage declares', () => {
  assert.deepEqual(compilerSources('outfit'), ['AvhCommon.cs', 'FaceEyes.cs', 'FaceGeometry.cs', 'FaceMapping.cs',
    'FaceStage.cs', 'LocalOperations.cs', 'OutfitStage.cs', 'OutfitVisibility.cs', 'SetupStage.cs']);
});
