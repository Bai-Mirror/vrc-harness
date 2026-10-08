import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTemp } from './fixtures/platform.ts';

const observerDir = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));

const model = (rootGuid: string) => `%YAML 1.1\n--- !u!1 &100\nGameObject:\n  m_Component:\n  - component: {fileID: 101}\n  - component: {fileID: 137}\n  m_Name: Avatar\n--- !u!4 &101\nTransform:\n  m_GameObject: {fileID: 100}\n  m_Father: {fileID: 0}\n  m_Children: []\n--- !u!137 &137\nSkinnedMeshRenderer:\n  m_GameObject: {fileID: 100}\n`;

const variant = (sourceGuid: string) => `%YAML 1.1\n--- !u!1001 &1001\nPrefabInstance:\n  m_Modification:\n    serializedVersion: 3\n    m_TransformParent: {fileID: 0}\n    m_SourcePrefab: {fileID: 100100000, guid: ${sourceGuid}, type: 3}\n`;

const probe = String.raw`
import json, sys
sys.path.insert(0, sys.argv[2])
from observe_recolor import Prefabs
p = Prefabs(sys.argv[1])
print(json.dumps({'variant_base': p.renderer_path(sys.argv[3], sys.argv[4], 137),
                  'fbx_model': p.renderer_path(sys.argv[5], sys.argv[6], 137)}))
`;

test('the YAML fallback resolves a successful variant base and a model prefab from FBX', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-prefab-fallback-')); t.after(() => removeTemp(root));
  mkdirSync(join(root, 'Assets'), { recursive: true });
  const variantGuid = 'a'.repeat(32), modelGuid = 'b'.repeat(32), baseGuid = 'c'.repeat(32);
  writeFileSync(join(root, 'Assets/Base.prefab'), model(baseGuid));
  writeFileSync(join(root, 'Assets/Base.prefab.meta'), `guid: ${baseGuid}\n`);
  writeFileSync(join(root, 'Assets/Variant.prefab'), variant(baseGuid));
  writeFileSync(join(root, 'Assets/Variant.prefab.meta'), `guid: ${variantGuid}\n`);
  writeFileSync(join(root, 'Assets/Model.fbx'), model(modelGuid));
  writeFileSync(join(root, 'Assets/Model.fbx.meta'), `guid: ${modelGuid}\n`);
  // The outer variant references the model asset. The same serialized shape also exercises the variant-base
  // fallback: its target fileID lives in the base asset, so chain() must deduplicate list results without
  // putting a list into a set.
  const result = JSON.parse(execFileSync('python3', ['-c', probe, root, observerDir,
    variant(variantGuid), variantGuid, variant(modelGuid), modelGuid], { encoding: 'utf8' }));
  assert.equal(result.fbx_model, '', 'a root renderer is a valid model-prefab binding');

  // A nested variant whose renderer is inherited from its base must resolve to the same root path rather than
  // raising TypeError from the old set-of-lists fallback.
  assert.equal(result.variant_base, '', 'successful variant-base resolution must be accepted');
});
