import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { loadProcess } from '../../src/process/load.ts';
import { loadCapabilities } from '../../src/workflow/capabilities.ts';
import { artifactFiles } from '../../src/workflow/artifacts.ts';

const knowledge = new URL('../../builtin/knowledge/', import.meta.url);
const processText = readFileSync(new URL('process/pc-recolor-outfit.process.yaml', knowledge), 'utf8');
const capabilitiesText = readFileSync(new URL('process/pc-recolor-outfit.capabilities.yaml', knowledge), 'utf8');
const thresholds = parse(readFileSync(new URL('process/thresholds.yaml', knowledge), 'utf8'));

test('actual DAG face successor closure explicitly invalidates on face_input, including check-only stages', () => {
  const definition = loadProcess(processText, thresholds), closure = new Set(['face_design','face']);
  for (let previous = -1; previous !== closure.size;) {
    previous = closure.size;
    for (const stage of definition.stages) if (stage.needs.some(id => closure.has(id))) closure.add(stage.id);
  }
  assert.deepEqual([...closure], ['face_design','face','outfit','recolor','menu','build_pre','regression_pre','optimize','build','regression','performance','package']);
  assert.deepEqual(definition.stages.filter(stage => stage.invalidated_by.includes('face_input')).map(stage => stage.id), [...closure]);
  assert.ok(definition.stages.some(stage => closure.has(stage.id) && !stage.produces.length));
  const capabilities = loadCapabilities(capabilitiesText, definition);
  assert.deepEqual(capabilities.artifacts.face_input, { paths: [], source: { kind: 'runtime', input: 'face_input' } });
  assert.deepEqual(artifactFiles('/path/which/must/not/be/scanned', capabilities.artifacts.face_input!), []);
  assert.ok(definition.stages.find(stage => stage.id === 'face')!.requires.includes('face_input_integrity'));
});

test('Runtime input source rejects invented identities, file paths and Provider production', () => {
  const definition = loadProcess(processText, thresholds), raw = parse(capabilitiesText);
  for (const source of [{ kind: 'runtime', input: 'invented' }, { kind: 'file', input: 'face_input' }, { kind: 'runtime', input: 'face_input', extra: true }]) {
    const copy = structuredClone(raw); copy.artifacts.face_input.source = source;
    assert.throws(() => loadCapabilities(stringify(copy), definition), /Runtime|source/);
  }
  const file = structuredClone(raw); file.artifacts.face_input.paths = ['fake.json'];
  assert.throws(() => loadCapabilities(stringify(file), definition), /Runtime/);
  const provider = structuredClone(definition); provider.stages[0]!.produces.push('face_input');
  assert.throws(() => loadCapabilities(capabilitiesText, provider), /Runtime/);
});
