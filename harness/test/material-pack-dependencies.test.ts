import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor } from './fixtures/unity-slot.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const intake = join(tools, 'intake.py');
const plan = join(tools, 'plan.py');
const assetObserver = join(tools, 'observe_assets.py');
const python = spawnSync('python3', ['--version']).status === 0;

function packageFixture(path: string, entries: Array<{ guid: string; path: string; asset?: string; folder?: boolean }>) {
  const script = `import io,sys,tarfile,zipfile,json
entries = json.loads(sys.argv[2])
with tarfile.open(sys.argv[1], 'w:gz') as archive:
  for row in entries:
    for leaf, value in [('pathname', row['path']), ('asset', row.get('asset', ''))]:
      if leaf == 'asset' and row.get('folder'): continue
      data = value.encode(); info = tarfile.TarInfo(row['guid'] + '/' + leaf); info.size = len(data)
      archive.addfile(info, io.BytesIO(data))
    meta = ('fileFormatVersion: 2\\nguid: ' + row['guid'] + '\\n' + ('folderAsset: yes\\n' if row.get('folder') else '')).encode()
    info = tarfile.TarInfo(row['guid'] + '/asset.meta'); info.size = len(meta); archive.addfile(info, io.BytesIO(meta))
`;
  execFileSync('python3', ['-c', script, path, JSON.stringify(entries)]);
}

function zipPackages(path: string, packages: string[]) {
  const script = `import sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
  for source in sys.argv[2:]:
    archive.write(source, source.replace('\\\\', '/').rsplit('/', 1)[-1])
`;
  execFileSync('python3', ['-c', script, path, ...packages]);
}

function zipCp932Packages(path: string, packages: Record<string, string>) {
  const script = `import json,sys,zipfile
from pathlib import Path
class Cp932Info(zipfile.ZipInfo):
  def _encodeFilenameFlags(self):
    return self.filename.encode('cp932'), self.flag_bits & ~0x800
with zipfile.ZipFile(sys.argv[1], 'w') as archive:
  for name,source in json.loads(sys.argv[2]).items():
    archive.writestr(Cp932Info(name), Path(source).read_bytes())
with zipfile.ZipFile(sys.argv[1]) as archive:
  assert all(not info.flag_bits & 0x800 for info in archive.infolist())
`;
  execFileSync('python3', ['-c', script, path, JSON.stringify(packages)]);
}

function prefabAsset(materialGuid: string, name = 'Coat') {
  return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100100
GameObject:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  serializedVersion: 6
  m_Component:
  - component: {fileID: 400100}
  - component: {fileID: 230100}
  m_Layer: 0
  m_Name: ${name}
  m_TagString: Untagged
  m_Icon: {fileID: 0}
  m_NavMeshLayer: 0
  m_StaticEditorFlags: 0
  m_IsActive: 1
--- !u!4 &400100
Transform:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 100100}
  serializedVersion: 2
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children: []
  m_Father: {fileID: 0}
--- !u!23 &230100
MeshRenderer:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 100100}
  m_Enabled: 1
  m_CastShadows: 1
  m_ReceiveShadows: 1
  m_DynamicOccludee: 1
  m_MotionVectors: 1
  m_LightProbeUsage: 1
  m_ReflectionProbeUsage: 1
  m_RayTracingMode: 2
  m_RayTraceProcedural: 0
  m_RenderingLayerMask: 1
  m_RendererPriority: 0
  m_Materials:
  - {fileID: 2100000, guid: ${materialGuid}, type: 2}
  m_StaticBatchInfo: {firstSubMesh: 0, subMeshCount: 0}
  m_StaticBatchRoot: {fileID: 0}
  m_ProbeAnchor: {fileID: 0}
  m_LightProbeVolumeOverride: {fileID: 0}
  m_ScaleInLightmap: 1
  m_ReceiveGI: 1
  m_PreserveUVs: 0
  m_IgnoreNormalsForChartDetection: 0
  m_ImportantGI: 0
  m_StitchLightmapSeams: 1
  m_SelectedEditorRenderState: 3
  m_MinimumChartSize: 4
  m_AutoUVMaxDistance: 0.5
  m_AutoUVMaxAngle: 89
  m_LightmapParameters: {fileID: 0}
  m_SortingLayerID: 0
  m_SortingLayer: 0
  m_SortingOrder: 0
  m_MaskInteraction: 0
`;
}

function materialAsset(textureGuid?: string) {
  const textures = textureGuid ? `
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: ${textureGuid}, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}` : '';
  return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 8
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_Name: Coat
  m_Shader: {fileID: 46}
  m_Parent: {fileID: 0}
  m_ModifiedSerializedProperties: 0
  m_ValidKeywords: []
  m_InvalidKeywords: []
  m_LightmapFlags: 0
  m_EnableInstancingVariants: 0
  m_DoubleSidedGI: 0
  m_CustomRenderQueue: -1
  stringTagMap: {}
  disabledShaderPasses: []
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:${textures || ' []'}
    m_Floats: []
    m_Colors: []
`;
}

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-packs-'));
  t.after(() => removeTemp(root));
  const project = join(root, 'project'); mkdirSync(project, { recursive: true });
  const guidA = 'a'.repeat(32), guidB = 'b'.repeat(32), guidMissing = 'c'.repeat(32);
  const body = join(root, 'Body.unitypackage');
  packageFixture(body, [{ guid: '1'.repeat(32), path: 'Assets/Body/Avatar.prefab', asset: 'body' }]);
  const outfitA = join(root, 'Coat.unitypackage');
  packageFixture(outfitA, [{ guid: '2'.repeat(32), path: 'Assets/Vendor/Coat/Coat.prefab',
    asset: prefabAsset(guidA) }]);
  const materialsA = join(root, 'CoatLinks.unitypackage');
  packageFixture(materialsA, [{ guid: guidA, path: 'Assets/Vendor/Coat/Materials/Coat.mat', asset: materialAsset() }]);
  const outfitB = join(root, 'Dress.unitypackage');
  packageFixture(outfitB, [{ guid: '3'.repeat(32), path: 'Assets/Vendor/Dress/Dress.prefab',
    asset: prefabAsset(guidB, 'Dress') }]);
  const materialsB = join(root, 'DressLinks.unitypackage');
  packageFixture(materialsB, [{ guid: guidB, path: 'Assets/Vendor/Dress/Materials/Dress.mat', asset: materialAsset() }]);
  const missingOutfit = join(root, 'Missing.unitypackage');
  packageFixture(missingOutfit, [{ guid: '4'.repeat(32), path: 'Assets/Vendor/Missing/Missing.prefab',
    asset: prefabAsset(guidMissing, 'Missing') }]);
  const layered = join(root, 'TopLevel.psd'); writeFileSync(layered, 'layered source');
  const manifest = { schema: 'manifest/0.1', request: 'material pack fixture', assets: [
    { item: body, store: 'client', role: 'body' },
    { item: outfitA, store: 'client', role: 'outfit' },
    { item: materialsA, store: 'client', role: 'outfit' },
    { item: outfitB, store: 'client', role: 'outfit' },
    { item: materialsB, store: 'client', role: 'outfit' },
    { item: missingOutfit, store: 'client', role: 'outfit' },
    { item: layered, store: 'client', role: 'outfit' },
  ] };
  const env = { ...process.env, AVH_MANIFEST: JSON.stringify(manifest), PYTHONDONTWRITEBYTECODE: '1' };
  return { root, project, env, body, outfitA, materialsA, outfitB, materialsB, missingOutfit, layered, manifest };
}

test('intake identifies referenced material packs, keeps unrelated references separate, and treats PSD as layered source',
  { skip: !python }, t => {
    const f = fixture(t);
    execFileSync('python3', [intake, '--library', f.root, '--project', f.project], { env: f.env });
    const inventory = JSON.parse(readFileSync(join(f.project, '_harness/intake/inventory.json'), 'utf8'));
    const row = (item: string) => inventory.items.find((entry: any) => entry.item === item)!;
    assert.equal(row(f.materialsA).role, 'texture');
    assert.deepEqual(row(f.materialsA).dependency_of, [f.outfitA]);
    assert.ok(row(f.materialsA).files.some((entry: any) => entry.selected));
    assert.equal(row(f.materialsB).role, 'texture');
    assert.deepEqual(row(f.materialsB).dependency_of, [f.outfitB]);
    assert.equal(row(f.missingOutfit).dependency_of, undefined, 'a missing package is never invented as a dependency');
    assert.equal(row(f.layered).compat.conclusion, '支持');
    assert.match(row(f.layered).compat.basis, /顶层分层源文件/);
    assert.doesNotMatch(row(f.layered).compat.basis, /骨骼/);
    const intakeDocument = readFileSync(join(f.project, '_harness/intake/建档.md'), 'utf8');
    const layeredSection = intakeDocument.slice(intakeDocument.indexOf('## 分层源文件'));
    const installSections = intakeDocument.slice(intakeDocument.indexOf('## 不装的文件'), intakeDocument.indexOf('## 分层源文件'));
    assert.doesNotMatch(installSections, new RegExp(f.layered.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')),
      'a top-level layered source is not repeated as an install candidate or uninstalled package');
    assert.match(layeredSection, /TopLevel\.psd/);

    const accepted = {
      schema: 'plan/0.2', client_gallery: false, body: f.body,
      body_prefab: row(f.body).prefabs[0],
      outfits: [
        { id: 'coat', item: f.outfitA, prefab: row(f.outfitA).prefabs[0], label: '外套' },
        { id: 'dress', item: f.outfitB, prefab: row(f.outfitB).prefabs[0], label: '连衣' },
      ], default_outfit: 'coat',
      unused: [
        { item: f.missingOutfit, reason: 'unsupported', note: 'reference has no registered provider' },
        { item: f.layered, reason: 'client_declined', note: 'source only' },
      ],
      obligations: [
        { input: f.body, role: 'body', action: 'use', target: row(f.body).prefabs[0], due_stage: 'outfit' },
        { input: f.outfitA, role: 'outfit', action: 'use', target: row(f.outfitA).prefabs[0], due_stage: 'outfit' },
        { input: f.materialsA, role: 'texture', action: 'use', target: f.outfitA, due_stage: 'outfit' },
        { input: f.outfitB, role: 'outfit', action: 'use', target: row(f.outfitB).prefabs[0], due_stage: 'outfit' },
        { input: f.materialsB, role: 'texture', action: 'use', target: f.outfitB, due_stage: 'outfit' },
        { input: f.missingOutfit, role: 'outfit', action: 'exclude', reason: 'no provider' },
        { input: f.layered, role: 'outfit', action: 'exclude', reason: 'source only' },
      ],
      menu: { mode: 'assemble', selector: { type: 'radial' }, component_policy: 'horizontal_across_outfits' },
      recolor: { targets: [{ part: 'outfit:coat', hue_shift: 1, saturation: 1, value: 1 }], candidates: 3 },
      optimization: { mode: 'preserve' }, face: { mode: 'preserve' }, notes: 'fixture',
    };
    const observed = join(f.root, 'plan-observed.json');
    const result = spawnSync('python3', [plan, 'observe', '--out', observed, '--project', f.project],
      { env: { ...f.env, AVH_PLAN: JSON.stringify(accepted) }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(observed, 'utf8')).metrics.plan_source_contract_valid, true);

    const wrongCarrier = JSON.parse(JSON.stringify(accepted));
    wrongCarrier.obligations.find((entry: any) => entry.input === f.materialsA).target = f.outfitB;
    const wrong = spawnSync('python3', [plan, 'observe', '--out', observed, '--project', f.project],
      { env: { ...f.env, AVH_PLAN: JSON.stringify(wrongCarrier) }, encoding: 'utf8' });
    assert.equal(wrong.status, 0, 'the observer reports invalid plans as a negative metric');
    assert.equal(JSON.parse(readFileSync(observed, 'utf8')).metrics.plan_source_contract_valid, false,
      'a dependency cannot be assigned to another outfit');
    const excludedDependency = JSON.parse(JSON.stringify(accepted));
    const dependencyObligation = excludedDependency.obligations.find((entry: any) => entry.input === f.materialsA);
    dependencyObligation.action = 'exclude'; dependencyObligation.target = undefined; dependencyObligation.reason = 'omit';
    excludedDependency.unused.push({ item: f.materialsA, reason: 'unsupported', note: 'omit' });
    const excluded = spawnSync('python3', [plan, 'observe', '--out', observed, '--project', f.project],
      { env: { ...f.env, AVH_PLAN: JSON.stringify(excludedDependency) }, encoding: 'utf8' });
    assert.equal(excluded.status, 0);
    assert.equal(JSON.parse(readFileSync(observed, 'utf8')).metrics.plan_source_contract_valid, false,
      'a used outfit cannot hide its registered material dependency');

    // The setup observer consumes the same dependency marker and still derives GUID presence from the
    // imported project. A missing material meta is therefore a real setup failure, not an ignored reference.
    mkdirSync(join(f.project, 'Assets/Vendor/Coat/Materials'), { recursive: true });
    mkdirSync(join(f.project, 'Assets/Body'), { recursive: true });
    const setupInventory = JSON.parse(readFileSync(join(f.project, '_harness/intake/inventory.json'), 'utf8'));
    for (const item of setupInventory.items.filter((entry: any) => [f.outfitB, f.materialsB, f.missingOutfit].includes(entry.item)))
      for (const file of item.files) file.selected = false;
    assert.ok(setupInventory.items.find((entry: any) => entry.item === f.materialsA).files.some((file: any) => file.selected));
    writeFileSync(join(f.project, '_harness/intake/inventory.json'), JSON.stringify(setupInventory));
    writeFileSync(join(f.project, 'Assets/Vendor/Coat/Coat.prefab'),
      `%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Component: []\n  m_Name: Coat\n  m_Materials:\n  - {fileID: 2100000, guid: ${'a'.repeat(32)}, type: 2}\n`);
    writeFileSync(join(f.project, 'Assets/Vendor/Coat/Coat.prefab.meta'), `guid: ${'2'.repeat(32)}\n`);
    writeFileSync(join(f.project, 'Assets/Vendor/Coat/Materials/Coat.mat'), 'mat');
    writeFileSync(join(f.project, 'Assets/Vendor/Coat/Materials/Coat.mat.meta'), `guid: ${'a'.repeat(32)}\n`);
    writeFileSync(join(f.project, 'Assets/Body/Avatar.prefab'), '%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Avatar\n');
    writeFileSync(join(f.project, 'Assets/Body/Avatar.prefab.meta'), `guid: ${'1'.repeat(32)}\n`);
    const setupObserved = join(f.root, 'setup-observed.json');
    const observeSetup = () => spawnSync('python3', [assetObserver, '--project', f.project, '--library', f.root, '--out', setupObserved], {
      env: { ...f.env, AVH_STAGE: 'setup', AVH_PROJECT_DIR: f.project, AVH_PLAN: JSON.stringify({
        body_prefab: 'Assets/Body/Avatar.prefab', outfits: [{ prefab: 'Assets/Vendor/Coat/Coat.prefab' }],
      }) }, encoding: 'utf8',
    });
    const firstSetup = observeSetup();
    assert.equal(firstSetup.status, 0, firstSetup.stderr);
    let setupMetrics = JSON.parse(readFileSync(setupObserved, 'utf8')).metrics;
    assert.equal(setupMetrics.missing_common_material_packs, 0, readFileSync(setupObserved, 'utf8'));
    assert.equal(setupMetrics.broken_guid_refs, 0);
    writeFileSync(join(f.project, 'Assets/Vendor/Coat/Materials/Coat.mat.meta'), 'guid: wrong\n');
    assert.equal(observeSetup().status, 0);
    setupMetrics = JSON.parse(readFileSync(setupObserved, 'utf8')).metrics;
    assert.equal(setupMetrics.missing_common_material_packs, 1, readFileSync(setupObserved, 'utf8'));
    assert.equal(setupMetrics.broken_guid_refs, 1, 'the selected prefab reference must remain unresolved');
    // Same geometry, but the material package was never registered. It still fails: a required material
    // slot cannot use the old vendor-dangling-reference exemption.
    setupInventory.items = setupInventory.items.filter((entry: any) => entry.item !== f.materialsA);
    writeFileSync(join(f.project, '_harness/intake/inventory.json'), JSON.stringify(setupInventory));
    assert.equal(observeSetup().status, 0);
    assert.equal(JSON.parse(readFileSync(setupObserved, 'utf8')).metrics.broken_guid_refs, 1);
    writeFileSync(join(f.project, 'Assets/Vendor/Coat/Coat.prefab'),
      `%YAML 1.1\n--- !u!1001 &1\nPrefabInstance:\n  m_Modification:\n    m_Modifications:\n    - target: {fileID: 23}\n      propertyPath: m_Materials.Array.data[0]\n      value: \n      objectReference: {fileID: 2100000, guid: ${'a'.repeat(32)}, type: 2}\n`);
    assert.equal(observeSetup().status, 0);
    assert.equal(JSON.parse(readFileSync(setupObserved, 'utf8')).metrics.broken_guid_refs, 1,
      'a variant override with an absent unregistered material is also a required reference');
    const fallback = spawnSync('python3', [assetObserver, '--project', f.project, '--library', f.root, '--out', setupObserved], {
      env: { ...f.env, AVH_STAGE: 'setup', AVH_PROJECT_DIR: f.project, AVH_PLAN: JSON.stringify({}) }, encoding: 'utf8',
    });
    assert.equal(fallback.status, 0, fallback.stderr);
  });

test('dependency evidence follows the selected prefab and reaches pure texture providers', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-graph-'));
  t.after(() => removeTemp(root));
  const project = join(root, 'project'); mkdirSync(project, { recursive: true });
  const body = join(root, 'Body.unitypackage');
  const geometry = join(root, 'Geometry.unitypackage');
  const materialA = join(root, 'ChosenMaterials.unitypackage');
  const materialB = join(root, 'UnusedMaterials.unitypackage');
  const texture = join(root, 'ChosenTexture.unitypackage');
  const guidA = 'd'.repeat(32), guidB = 'e'.repeat(32), guidTexture = 'f'.repeat(32);
  packageFixture(body, [{ guid: '1'.repeat(32), path: 'Assets/Body/Avatar.prefab', asset: 'body' }]);
  packageFixture(geometry, [
    { guid: '2'.repeat(32), path: 'Assets/Graph/Chosen.prefab', asset: prefabAsset(guidA, 'Chosen') },
    { guid: '3'.repeat(32), path: 'Assets/Graph/Unused.prefab', asset: prefabAsset(guidB, 'Unused') },
  ]);
  packageFixture(materialA, [{ guid: guidA, path: 'Assets/Graph/Materials/Chosen.mat', asset: materialAsset(guidTexture) }]);
  packageFixture(materialB, [{ guid: guidB, path: 'Assets/Graph/Materials/Unused.mat', asset: materialAsset() }]);
  packageFixture(texture, [{ guid: guidTexture, path: 'Assets/Graph/Textures/Chosen.png', asset: 'png-bytes' }]);
  const manifest = { schema: 'manifest/0.1', request: 'dependency graph fixture', assets: [
    { item: body, store: 'client', role: 'body' },
    { item: geometry, store: 'client', role: 'outfit' },
    { item: materialA, store: 'client', role: 'outfit' },
    { item: materialB, store: 'client', role: 'outfit' },
    { item: texture, store: 'client', role: 'outfit' },
  ] };
  const env = { ...process.env, AVH_MANIFEST: JSON.stringify(manifest), PYTHONDONTWRITEBYTECODE: '1' };
  execFileSync('python3', [intake, '--library', root, '--project', project], { env });
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8'));
  const row = (item: string) => inventory.items.find((entry: any) => entry.item === item)!;
  assert.equal(row(materialA).role, 'texture');
  assert.equal(row(materialB).role, 'texture');
  assert.equal(row(texture).role, 'texture');
  assert.deepEqual(row(materialA).dependency_refs.map((ref: any) => ref.prefab), ['Assets/Graph/Chosen.prefab']);
  assert.deepEqual(row(materialB).dependency_refs.map((ref: any) => ref.prefab), ['Assets/Graph/Unused.prefab']);
  assert.deepEqual(row(texture).dependency_refs.map((ref: any) => ref.prefab), ['Assets/Graph/Chosen.prefab']);

  const planObserved = join(root, 'plan-observed.json');
  const accepted = {
    schema: 'plan/0.2', client_gallery: false, body, body_prefab: 'Assets/Body/Avatar.prefab',
    outfits: [{ id: 'chosen', item: geometry, prefab: 'Assets/Graph/Chosen.prefab', label: 'Chosen' }],
    default_outfit: 'chosen', unused: [
      { item: materialB, reason: 'unsupported', note: 'only the other prefab uses it' },
    ], obligations: [
      { input: body, role: 'body', action: 'use', target: 'Assets/Body/Avatar.prefab', due_stage: 'outfit' },
      { input: geometry, role: 'outfit', action: 'use', target: 'Assets/Graph/Chosen.prefab', due_stage: 'outfit' },
      { input: materialA, role: 'texture', action: 'use', target: geometry, due_stage: 'outfit' },
      { input: materialB, role: 'texture', action: 'exclude', reason: 'unsupported' },
      { input: texture, role: 'texture', action: 'use', target: geometry, due_stage: 'outfit' },
    ],
    menu: { mode: 'assemble', selector: { type: 'radial' }, component_policy: 'horizontal_across_outfits' },
    recolor: { targets: [{ part: 'outfit:chosen', hue_shift: 1, saturation: 1, value: 1 }], candidates: 3 },
    optimization: { mode: 'preserve' }, face: { mode: 'preserve' }, notes: 'fixture',
  };
  let result = spawnSync('python3', [plan, 'observe', '--out', planObserved, '--project', project],
    { env: { ...env, AVH_PLAN: JSON.stringify(accepted) }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const acceptedObservation = JSON.parse(readFileSync(planObserved, 'utf8'));
  assert.equal(acceptedObservation.metrics.plan_source_contract_valid, true, JSON.stringify(acceptedObservation));
  const unusedChoice = JSON.parse(JSON.stringify(accepted));
  unusedChoice.outfits[0].prefab = 'Assets/Graph/Unused.prefab';
  unusedChoice.obligations.find((entry: any) => entry.input === materialA).action = 'exclude';
  delete unusedChoice.obligations.find((entry: any) => entry.input === materialA).target;
  unusedChoice.obligations.find((entry: any) => entry.input === materialA).reason = 'unsupported';
  unusedChoice.obligations.find((entry: any) => entry.input === materialB).action = 'use';
  unusedChoice.obligations.find((entry: any) => entry.input === materialB).target = geometry;
  unusedChoice.obligations.find((entry: any) => entry.input === materialB).due_stage = 'outfit';
  unusedChoice.obligations.find((entry: any) => entry.input === texture).action = 'exclude';
  delete unusedChoice.obligations.find((entry: any) => entry.input === texture).target;
  unusedChoice.obligations.find((entry: any) => entry.input === texture).reason = 'unsupported';
  delete unusedChoice.unused[0];
  unusedChoice.unused = [
    { item: materialA, reason: 'unsupported', note: 'only the other prefab uses it' },
    { item: texture, reason: 'unsupported', note: 'only the other prefab uses it' },
  ];
  result = spawnSync('python3', [plan, 'observe', '--out', planObserved, '--project', project],
    { env: { ...env, AVH_PLAN: JSON.stringify(unusedChoice) }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const unusedObservation = JSON.parse(readFileSync(planObserved, 'utf8'));
  assert.equal(unusedObservation.metrics.plan_source_contract_valid, true,
    JSON.stringify(unusedObservation));
});

test('effective inventory drops unreferenced pure provider members from a selected bundle', { skip: !python }, t => {
  for (const embedded of [false, true]) {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-inner-'));
  t.after(() => removeTemp(root));
  const project = join(root, 'project'); mkdirSync(project, { recursive: true });
  const body = join(root, 'Body.unitypackage');
  const geometry = join(root, 'Geometry.unitypackage');
  const links = join(root, 'Links.unitypackage');
  const unrelated = join(root, 'Unrelated.unitypackage');
  const bundle = join(root, 'Neutral.zip');
  const guid = '1'.repeat(32);
  packageFixture(body, [{ guid: '2'.repeat(32), path: 'Assets/Body/Avatar.prefab', asset: 'body' }]);
  packageFixture(geometry, [
    { guid: '3'.repeat(32), path: 'Assets/Neutral/Neutral.prefab', asset: prefabAsset(guid, 'Neutral') },
    ...(embedded ? [{ guid, path: 'Assets/Neutral/Materials/Neutral.mat', asset: materialAsset() }] : []),
  ]);
  packageFixture(links, [{ guid, path: 'Assets/Neutral/Materials/Neutral.mat', asset: materialAsset() }]);
  packageFixture(unrelated, [
    { guid: '9'.repeat(32), path: 'Assets/Neutral/Materials', folder: true },
    { guid: '4'.repeat(32), path: 'Assets/Neutral/Materials/Unused.mat', asset: materialAsset() },
  ]);
  zipPackages(bundle, [geometry, ...(embedded ? [] : [links]), unrelated]);
  const manifest = { schema: 'manifest/0.1', request: 'inner package fixture', assets: [
    { item: body, store: 'client', role: 'body' }, { item: bundle, store: 'client', role: 'outfit' },
  ] };
  const env = { ...process.env, AVH_MANIFEST: JSON.stringify(manifest), PYTHONDONTWRITEBYTECODE: '1' };
  execFileSync('python3', [intake, '--library', root, '--project', project], { env });
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8'));
  const planData = { body, body_prefab: 'Assets/Body/Avatar.prefab', outfits: [
    { item: bundle, prefab: 'Assets/Neutral/Neutral.prefab' },
  ] };
  const script = `import json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import plan,setup,intake
inventory=json.loads(sys.argv[2])
mode=sys.argv[5]
if mode == 'no-shapes':
 source=Path(plan.__file__).read_text().replace("(entry.get('package_shapes') or entry.get('dependency_refs'))", "entry.get('dependency_refs')")
 exec(compile(source, plan.__file__, 'exec'), plan.__dict__)
elif mode == 'no-folder':
 source=Path(intake.__file__).read_text().replace("if not row.get('folder')", "if True")
 exec(compile(source, intake.__file__, 'exec'), intake.__dict__)
 for item in inventory['items']:
  for entry in item['files']:
   entry.pop('package_shapes', None)
  intake.package_facts(intake.item_files(Path(inventory['library']), item['item'])[1], item['files'])
selected=plan.effective_inventory(inventory, json.loads(sys.argv[3]))
project=Path(sys.argv[4]);project.mkdir()
scratch=project/'scratch';scratch.mkdir()
receipt={}
setup.unpack_selected(project, Path(inventory['library']), selected, scratch, receipt)
print(json.dumps(receipt))
`;
  const unpack = (mode: string) => {
    const result = spawnSync('python3', ['-c', script, tools, JSON.stringify(inventory), JSON.stringify(planData),
      join(root, 'unpacked-' + mode), mode], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).packages.filter((p: any) => p.item === bundle).map((p: any) => p.package).sort();
  };
  const expected = ['Geometry.unitypackage', ...(embedded ? [] : ['Links.unitypackage'])];
  assert.deepEqual(unpack('production'), expected, 'actual unpack receipts exclude the unrelated folder-bearing provider');
  assert.throws(() => assert.deepEqual(unpack(embedded ? 'no-shapes' : 'no-folder'), expected),
    'removing either provider fix must fail the same unpack receipt assertion');
  }
});

test('direct and neutral ZIP material registrations use the same complete GUID coverage check', { skip: !python }, t => {
  const run = (wrapped: boolean) => {
    const root = mkdtempSync(join(tmpdir(), wrapped ? 'avh-material-zip-' : 'avh-material-direct-'));
    t.after(() => removeTemp(root));
    const project = join(root, 'project'); mkdirSync(join(project, 'Assets/Vendor/Neutral/Materials'), { recursive: true });
    const body = join(root, 'Body.unitypackage');
    const geometry = join(root, 'Geometry.unitypackage');
    const links = join(root, 'Links.unitypackage');
    const provider = wrapped ? join(root, 'Neutral.zip') : links;
    const guid = '5'.repeat(32), missing = '6'.repeat(32);
    packageFixture(body, [{ guid: '7'.repeat(32), path: 'Assets/Body/Avatar.prefab', asset: 'body' }]);
    packageFixture(geometry, [{ guid: '8'.repeat(32), path: 'Assets/Vendor/Neutral/Neutral.prefab', asset: prefabAsset(guid, 'Neutral') }]);
    packageFixture(links, [
      { guid, path: 'Assets/Vendor/Neutral/Materials/Neutral.mat', asset: materialAsset() },
      { guid: missing, path: 'Assets/Vendor/Neutral/Materials/Uninstalled.mat', asset: materialAsset() },
    ]);
    if (wrapped) zipPackages(provider, [links]);
    const manifest = { schema: 'manifest/0.1', request: 'coverage parity fixture', assets: [
      { item: body, store: 'client', role: 'body' }, { item: geometry, store: 'client', role: 'outfit' },
      { item: provider, store: 'client', role: 'outfit' },
    ] };
    const env = { ...process.env, AVH_MANIFEST: JSON.stringify(manifest), AVH_STAGE: 'setup',
      AVH_PLAN: JSON.stringify({ body_prefab: 'Assets/Body/Avatar.prefab', outfits: [{ item: geometry, prefab: 'Assets/Vendor/Neutral/Neutral.prefab' }] }),
      PYTHONDONTWRITEBYTECODE: '1' };
    execFileSync('python3', [intake, '--library', root, '--project', project], { env });
    mkdirSync(join(project, 'Assets/Body'), { recursive: true });
    writeFileSync(join(project, 'Assets/Body/Avatar.prefab'), '%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Component: []\n');
    writeFileSync(join(project, 'Assets/Vendor/Neutral/Neutral.prefab'), prefabAsset(guid, 'Neutral'));
    writeFileSync(join(project, 'Assets/Vendor/Neutral/Materials/Neutral.mat'), materialAsset());
    writeFileSync(join(project, 'Assets/Vendor/Neutral/Materials/Neutral.mat.meta'), `fileFormatVersion: 2\nguid: ${guid}\n`);
    const observed = join(root, 'setup-observed.json');
    const observedResult = spawnSync('python3', [assetObserver, '--project', project, '--library', root, '--out', observed], { env, encoding: 'utf8' });
    assert.equal(observedResult.status, 0, observedResult.stderr);
    return JSON.parse(readFileSync(observed, 'utf8')).metrics;
  };
  const direct = run(false);
  const zip = run(true);
  assert.equal(direct.missing_common_material_packs, 1, JSON.stringify(direct));
  assert.equal(zip.missing_common_material_packs, direct.missing_common_material_packs, JSON.stringify(zip));
  assert.equal(direct.broken_guid_refs, 0);
  assert.equal(zip.broken_guid_refs, 0);
});

test('CP932 member identities preserve referenced packages and exclude unrelated providers in actual imports', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-cp932-'));
  t.after(() => removeTemp(root));
  const body = join(root, 'Body.unitypackage'), geometry = join(root, 'Geometry.unitypackage');
  const links = join(root, 'Links.unitypackage'), unused = join(root, 'Unused.unitypackage'), bundle = join(root, 'Neutral.zip');
  const guid = 'a'.repeat(32), extra = 'b'.repeat(32);
  packageFixture(body, [{ guid: '1'.repeat(32), path: 'Assets/Body/Avatar.prefab', asset: '%YAML 1.1\n' }]);
  packageFixture(geometry, [{ guid: '2'.repeat(32), path: 'Assets/Archive/Selected.prefab', asset: prefabAsset(guid, 'Selected') }]);
  packageFixture(links, [
    { guid, path: 'Assets/Archive/Selected.mat', asset: materialAsset() },
    { guid: extra, path: 'Assets/Archive/Extra.mat', asset: materialAsset() },
  ]);
  packageFixture(unused, [
    { guid: '3'.repeat(32), path: 'Assets/Unused', folder: true },
    { guid: '4'.repeat(32), path: 'Assets/Unused/Unused.mat', asset: materialAsset() },
  ]);
  zipCp932Packages(bundle, { '形状.unitypackage': geometry, '材質.unitypackage': links, '余材.unitypackage': unused });
  const manifest = { schema: 'manifest/0.1', request: 'encoded member fixture', assets: [
    { item: body, store: 'client', role: 'body' }, { item: bundle, store: 'client', role: 'outfit' },
  ] };
  const selected = { schema: 'plan/0.2', body, body_prefab: 'Assets/Body/Avatar.prefab',
    outfits: [{ id: 'selected', item: bundle, prefab: 'Assets/Archive/Selected.prefab', label: 'Selected' }],
    default_outfit: 'selected', unused: [], obligations: [
      { input: body, role: 'body', action: 'use', target: 'Assets/Body/Avatar.prefab', due_stage: 'outfit' },
      { input: bundle, role: 'outfit', action: 'use', target: 'Assets/Archive/Selected.prefab', due_stage: 'outfit' },
    ], menu: { mode: 'assemble', selector: { type: 'radial' }, component_policy: 'horizontal_across_outfits' },
    recolor: { targets: [{ part: 'outfit:selected', hue_shift: 1, saturation: 1, value: 1 }], candidates: 3 },
    optimization: { mode: 'preserve' }, face: { mode: 'preserve' }, notes: 'fixture',
  };
  const run = (mutation: string) => {
    const project = join(root, mutation); mkdirSync(project);
    const script = `import contextlib,io,json,sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import intake,plan,setup,observe_assets
mode=sys.argv[5]
def mutate(module,before,after):
 source=Path(module.__file__).read_text()
 assert before in source, before
 exec(compile(source.replace(before,after),module.__file__,'exec'),module.__dict__)
if mode=='raw-list':
 mutate(intake,'names.append((zip_member_name(info), info.file_size))','names.append((info.filename, info.file_size))')
elif mode=='raw-evidence':
 mutate(intake,'member_name = zip_member_name(member) if member is not None else None','member_name = member.filename if member is not None else None')
elif mode=='raw-unpack':
 mutate(setup,"package_name = entry['name'] if direct else zip_member_name(member)","package_name = entry['name'] if direct else member.filename")
elif mode=='raw-observer-selection':
 mutate(observe_assets,"zip_member_name(member) in entry['active_packages']","member.filename in entry['active_packages']")
elif mode=='raw-observer-evidence':
 mutate(observe_assets,'member_name = zip_member_name(member) if member is not None else None','member_name = member.filename if member is not None else None')
project=Path(sys.argv[2]);library=Path(sys.argv[3]);selected=json.loads(sys.argv[4])
sys.argv=['intake','--library',str(library),'--project',str(project)]
with contextlib.redirect_stdout(io.StringIO()): intake.main()
plan.validate(selected,plan.catalog(project),project)
inventory=json.loads((project/'_harness/intake/inventory.json').read_text())
effective=plan.effective_inventory(inventory,selected)
scratch=project/'scratch';scratch.mkdir()
receipt={};setup.unpack_selected(project,library,effective,scratch,receipt)
members=[intake.zip_member_name(member) if member is not None else source.name
 for _,source,member in observe_assets.selected_library_packs(library,effective['items'])]
# Removing an unreferenced but approved material tests complete dependency-package coverage too.
(project/'Assets/Archive/Extra.mat.meta').unlink(missing_ok=True)
metrics=observe_assets.setup_metrics(project,library,{},[])
print(json.dumps(dict(packages=sorted(p['package'] for p in receipt['packages']),observed=sorted(members),
 missing=metrics['missing_common_material_packs'],broken=metrics['broken_guid_refs'],
 unused=(project/'Assets/Unused/Unused.mat').exists())))
`;
    const result = spawnSync('python3', ['-c', script, tools, project, root, JSON.stringify(selected), mutation], {
      env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', AVH_MANIFEST: JSON.stringify(manifest), AVH_PLAN: JSON.stringify(selected) },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const packages = ['Body.unitypackage', '形状.unitypackage', '材質.unitypackage'].sort();
  const expected = { packages, observed: packages, missing: 1, broken: 0, unused: false };
  assert.deepEqual(run('production'), expected);
  for (const mutation of ['raw-list', 'raw-evidence', 'raw-unpack', 'raw-observer-selection', 'raw-observer-evidence']) {
    const result = run(mutation);
    assert.throws(() => assert.deepEqual(result, expected), `${mutation} must fail the same CP932 import/observation assertions`);
  }
});

test('selected grouped variants bind dependencies and expose missing material slots through setup', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-material-variant-'));
  t.after(() => removeTemp(root));
  const project = join(root, 'project'); mkdirSync(project);
  const body = join(root, 'Body.unitypackage'), geometry = join(root, 'Geometry.unitypackage'), links = join(root, 'Links.unitypackage');
  const base = 'Assets/Variant/Base.prefab', alternate = 'Assets/Variant/Alternate.prefab', material = 'Assets/Variant/Alternate.mat';
  const guid = 'a'.repeat(32);
  packageFixture(body, [{ guid: '1'.repeat(32), path: 'Assets/Body/Avatar.prefab', asset: '%YAML 1.1\n' }]);
  packageFixture(geometry, [
    { guid: '2'.repeat(32), path: base, asset: '%YAML 1.1\n' },
    { guid: '3'.repeat(32), path: alternate, asset: prefabAsset(guid, 'Alternate') },
  ]);
  packageFixture(links, [{ guid, path: material, asset: materialAsset() }]);
  const manifest = { schema: 'manifest/0.1', request: 'selected variant fixture', assets: [
    { item: body, store: 'client', role: 'body' }, { item: geometry, store: 'client', role: 'outfit' },
    { item: links, store: 'client', role: 'outfit' },
  ] };
  const env = { ...process.env, AVH_MANIFEST: JSON.stringify(manifest), PYTHONDONTWRITEBYTECODE: '1' };
  execFileSync('python3', [intake, '--library', root, '--project', project], { env });
  const selected = { schema: 'plan/0.3', body, body_prefab: 'Assets/Body/Avatar.prefab',
    avatar_config: { schema: 'avatar-config/0.1', instances: [
      { id: 'source', kind: 'outfit', item: geometry, prefab: base, variants: [{ id: 'alt', prefab: alternate }] },
    ], groups: [{ id: 'constant', label: 'Constant', activation: 'fixed', members: [
      { id: 'chosen', instance: 'source', variant: 'alt', label: 'Alt' },
    ] }], shared_switches: [] }, unused: [], obligations: [
      { input: body, role: 'body', action: 'use', target: 'Assets/Body/Avatar.prefab', due_stage: 'outfit' },
      { input: geometry, role: 'outfit', action: 'use', target: alternate, due_stage: 'outfit' },
      { input: links, role: 'texture', action: 'use', target: geometry, due_stage: 'outfit' },
    ], menu: { mode: 'preserve', vendor_policy: 'preserve_and_merge', tree: [] },
    recolor: { targets: [{ part: 'outfit:chosen', hue_shift: 1, saturation: 1, value: 1 }], candidates: 3 },
    optimization: { mode: 'preserve' }, face: { mode: 'preserve' }, notes: 'fixture',
  };
  const probe = (action: string, mutant: boolean) => {
    const script = `import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import plan,setup
project=Path(sys.argv[2]); selected=json.loads(sys.argv[3]); action=sys.argv[4]
if sys.argv[5]=='mutant':
 source=Path(plan.__file__).read_text().replace('avatar_config.physical_rows(avatar_config.normalize(plan))', "((plan.get('avatar_config') or {}).get('instances') or [])")
 exec(compile(source, plan.__file__, 'exec'), plan.__dict__)
if action!='use':
 row=selected['obligations'][-1];row.clear();row.update(input=sys.argv[6],role='texture',action=action,reason='unsupported')
 if action=='exclude': selected['unused']=[dict(item=sys.argv[6],reason='unsupported',note='omit')]
try:
 plan.validate(selected, plan.catalog(project), project)
 valid=True
except ValueError:
 valid=False
inventory=json.loads((project/'_harness/intake/inventory.json').read_text())
effective=plan.effective_inventory(inventory,selected)
output=project/('unpacked-'+action+'-'+sys.argv[5]);output.mkdir();scratch=output/'scratch';scratch.mkdir()
receipt={};setup.unpack_selected(output,Path(inventory['library']),effective,scratch,receipt)
print(json.dumps(dict(valid=valid, imported=any(p['item']==sys.argv[6] for p in receipt['packages']))))
`;
    const result = spawnSync('python3', ['-c', script, tools, project, JSON.stringify(selected), action, mutant ? 'mutant' : 'production', links],
      { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.deepEqual(probe('use', false), { valid: true, imported: true });
  for (const action of ['exclude', 'defer']) assert.equal(probe(action, false).valid, false);
  assert.throws(() => assert.deepEqual(probe('use', true), { valid: true, imported: true }),
    'default-instance mutation must fail the same plan/import assertion');

  // This project has no registered material source; the actual alternate Renderer still owes resolution.
  mkdirSync(join(project, 'Assets/Body'), { recursive: true }); mkdirSync(join(project, 'Assets/Variant'), { recursive: true });
  writeFileSync(join(project, 'Assets/Body/Avatar.prefab'), '%YAML 1.1\n');
  writeFileSync(join(project, base), '%YAML 1.1\n'); writeFileSync(join(project, alternate), prefabAsset(guid));
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8'));
  inventory.items = inventory.items.filter((item: any) => item.item !== links);
  writeFileSync(join(project, '_harness/intake/inventory.json'), JSON.stringify(inventory));
  const source = readFileSync(assetObserver, 'utf8');
  const roots = "outfits = [project / o['prefab'] for o in planned_outfits(plan) if o.get('prefab')]";
  assert.ok(source.includes(roots));
  const mutantObserver = join(root, 'missing-roots.py');
  writeFileSync(mutantObserver, source.replace(roots, "outfits = [project / o['prefab'] for o in plan.get('outfits', []) if o.get('prefab')]"));
  const observe = (script: string) => {
    const out = join(root, 'observed.json');
    const result = spawnSync('python3', [script, '--project', project, '--library', root, '--out', out], {
      env: { ...env, PYTHONPATH: tools, AVH_STAGE: 'setup', AVH_PLAN: JSON.stringify(selected) }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(out, 'utf8')).metrics.broken_guid_refs;
  };
  assert.equal(observe(assetObserver), 1, 'unregistered material in the actual variant must fail');
  assert.throws(() => assert.equal(observe(mutantObserver), 1), 'dropping plan/0.3 roots must fail the same missing-material assertion');
});

test('removing GUID dependency identification makes the positive fixture fail', { skip: !python }, t => {
  const f = fixture(t);
  const intendedPlan = { body: f.body, body_prefab: 'Assets/Body/Avatar.prefab',
    outfits: [{ item: f.outfitA, prefab: 'Assets/Vendor/Coat/Coat.prefab' }], obligations: [
      { input: f.body, role: 'body', action: 'use', target: 'Assets/Body/Avatar.prefab', due_stage: 'outfit' },
      { input: f.outfitA, role: 'outfit', action: 'use', target: 'Assets/Vendor/Coat/Coat.prefab', due_stage: 'outfit' },
      { input: f.materialsA, role: 'texture', action: 'use', target: f.outfitA, due_stage: 'outfit' },
    ] };
  const accepted = () => {
    const script = `import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import plan
selected=json.loads(sys.argv[3]);names={row['input'] for row in selected['obligations']}
items=[i for i in json.loads(Path(sys.argv[2]).read_text())['items'] if i['item'] in names]
try:
 plan.validate_obligations(selected,{i['item']:i['role'] for i in items},{selected['outfits'][0]['item']},set(),
  {i['item']:i.get('dependency_of',[]) for i in items},{i['item']:i.get('dependency_refs',[]) for i in items})
 print('true')
except ValueError: print('false')
`;
    return JSON.parse(execFileSync('python3', ['-c', script, tools, join(f.project, '_harness/intake/inventory.json'), JSON.stringify(intendedPlan)],
      { env: f.env, encoding: 'utf8' }));
  };
  execFileSync('python3', [intake, '--library', f.root, '--project', f.project], { env: f.env });
  assert.equal(accepted(), true);
  const mutantDir = join(f.root, 'mutant'); mkdirSync(mutantDir);
  const mutant = readFileSync(intake, 'utf8').replace(
    "if not found:\n                    continue",
    "if True:\n                    continue");
  assert.notEqual(mutant, readFileSync(intake, 'utf8'));
  const mutantIntake = join(mutantDir, 'intake.py'); writeFileSync(mutantIntake, mutant);
  copyFileSync(plan, join(mutantDir, 'plan.py')); copyFileSync(join(tools, 'avatar_config.py'), join(mutantDir, 'avatar_config.py'));
  execFileSync('python3', [mutantIntake, '--library', f.root, '--project', f.project, '--plan-tool', join(mutantDir, 'plan.py')], { env: f.env });
  const inventory = JSON.parse(readFileSync(join(f.project, '_harness/intake/inventory.json'), 'utf8'));
  const material = inventory.items.find((entry: any) => entry.item === f.materialsA);
  assert.notEqual(material.role, 'texture');
  assert.equal(material.dependency_of, undefined);
  assert.throws(() => assert.equal(accepted(), true), 'the same dependency use contract must fail after removing identification');
});

test('real Unity resolves the imported material GUID through the Low integrity fixture path', {
  skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE,
  timeout: 1_800_000,
}, t => {
  const f = fixture(t);
  const unityProject = join(f.root, 'unity-project'); mkdirSync(unityProject);
  for (const name of ['Packages', 'ProjectSettings'])
    cpSync(join(process.env.AVH_LOCAL_UNITY_BASELINE!, name), join(unityProject, name), { recursive: true });
  const inventoryDir = join(unityProject, '_harness', 'intake'); mkdirSync(inventoryDir, { recursive: true });
  const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const inventory = { items: [
    { item: f.outfitA, role: 'outfit', found: true, files: [{ name: f.outfitA.split(/[\\/]/).pop(), selected: true, sha256: digest(f.outfitA), packages: [f.outfitA] }] },
    { item: f.materialsA, role: 'texture', found: true, files: [{ name: f.materialsA.split(/[\\/]/).pop(), selected: true, sha256: digest(f.materialsA), packages: [f.materialsA] }] },
  ] };
  writeFileSync(join(inventoryDir, 'inventory.json'), JSON.stringify(inventory));
  const scratch = join(f.root, 'scratch'); mkdirSync(scratch);
  execFileSync('python3', ['-c', `import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import setup
project,library,scratch=map(Path,sys.argv[2:5])
inventory=json.loads((project/'_harness/intake/inventory.json').read_text())
receipt={}
setup.unpack_selected(project,library,inventory,scratch,receipt)
assert len(receipt['packages']) == 2, receipt
assert all(row.get('installed') == 1 and not row.get('error') for row in receipt['packages']), receipt
print(json.dumps(receipt))
`, tools, unityProject, f.root, scratch], { env: { ...f.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.ok(existsSync(join(unityProject, 'Assets/Vendor/Coat/Coat.prefab')), 'setup must unpack the geometry prefab');
  assert.ok(existsSync(join(unityProject, 'Assets/Vendor/Coat/Coat.prefab.meta')), 'setup must preserve prefab meta');
  const editor = join(unityProject, 'Assets', 'Editor'); mkdirSync(editor, { recursive: true });
  writeFileSync(join(editor, 'MaterialDependencyIntegration.cs'), `using System;
using System.IO;
using UnityEditor;
using UnityEngine;
public static class MaterialDependencyIntegration {
  public static void Run() {
    var prefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Vendor/Coat/Coat.prefab");
    if (prefab == null) throw new Exception("geometry prefab was not imported");
    var renderer = prefab.GetComponentInChildren<Renderer>(true);
    if (renderer == null || renderer.sharedMaterials.Length != 1 || renderer.sharedMaterials[0] == null)
      throw new Exception("material GUID did not resolve in Unity");
    if (AssetDatabase.GetAssetPath(renderer.sharedMaterials[0]) != "Assets/Vendor/Coat/Materials/Coat.mat")
      throw new Exception("material resolved to an unexpected asset");
    File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("AVH_PROJECT_DIR"), "guid-result.txt"), "resolved");
    EditorApplication.Exit(0);
  }
}`);
  let error: unknown;
  try {
    execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-nographics', '-projectPath', unityProject,
      '-executeMethod', 'MaterialDependencyIntegration.Run', '-logFile', join(unityProject, 'unity.log')],
      { env: { ...process.env, AVH_PROJECT_DIR: unityProject }, timeout: 1_200_000, windowsHide: true, stdio: 'pipe' });
  } catch (cause) { error = cause; }
  const log = existsSync(join(unityProject, 'unity.log')) ? readFileSync(join(unityProject, 'unity.log'), 'utf8') : 'Unity did not write its log';
  assert.equal(error, undefined, String(error) + '\n' + log.slice(-12000));
  assert.ok(existsSync(join(unityProject, 'guid-result.txt')), log.slice(-12000));
});
