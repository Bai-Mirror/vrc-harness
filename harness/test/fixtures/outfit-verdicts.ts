import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {loadProcess} from '../../src/process/load.ts';
import {loadCapabilities} from '../../src/workflow/capabilities.ts';
import {ObservationVerifier} from '../../src/workflow/observe.ts';

const tools = new URL('../../builtin/tools/harness/', import.meta.url);
const knowledge = new URL('../../builtin/knowledge/process/', import.meta.url);
const definition = loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml', knowledge), 'utf8'),
  parse(readFileSync(new URL('thresholds.yaml', knowledge), 'utf8')));
const capabilities = loadCapabilities(readFileSync(new URL('pc-recolor-outfit.capabilities.yaml', knowledge), 'utf8'), definition);

export const outfitGroupDefaultsObserver = definition.checks.find(check => check.id === 'outfit_group_defaults_match')!.observe;
export const outfitGroupDefaultsRule = definition.checks.find(check => check.id === 'outfit_group_defaults_match')!.rule;
export const outfitUnitySteps = capabilities.stages.outfit!.unitySteps!.map(step => step.method);

/** Run the production outfit checks against the supplied run files. */
export async function outfitVerdicts(project: string, runDirectory: string, plan: Record<string, unknown>) {
  const ids = ['outfit_external_refs', 'outfit_group_defaults_match'];
  const scoped = {...definition, stages: [{...definition.stages.find(stage => stage.id === 'outfit')!, requires: ids}],
    checks: definition.checks.filter(check => ids.includes(check.id))};
  const verifier = new ObservationVerifier({definition: scoped, observers: {
    'assets.validate': {kind: 'run-file', runFile: 'observations/assets.validate.json'},
    'avatar.observe': capabilities.observers['avatar.observe']!,
  }, thresholds: {}, project, toolRoot: join(fileURLToPath(tools), '..'), runRoot: join(runDirectory, '..'), plan: () => plan});
  const runId = runDirectory.split(/[\\/]/).at(-1)!;
  return verifier.verify({runId, taskId: 'fixture', workflowId: 'fixture', projectId: 'fixture', stageId: 'outfit',
    attempt: 1, idempotencyKey: runId, expectedOutputs: []}, {exitStatus: 0, outputs: {}}, {outfits: 'f'.repeat(64), plan: 'e'.repeat(64)});
}
