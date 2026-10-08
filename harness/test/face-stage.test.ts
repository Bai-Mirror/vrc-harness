import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor } from './fixtures/unity-slot.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const blender = process.env.AVH_TEST_BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
test('Unity face consumer independently recomputes compensated expressions in a real Blender FBX and rejects stale, changed or incompatible facts',
  { skip: !process.env.AVH_FACE_UNITY_EDITOR || !existsSync(blender), timeout: 420000 }, t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-face-unity-')); t.after(() => { if (!process.env.AVH_FACE_KEEP_PROJECT) removeTemp(root); });
    for (const dir of ['Assets/Editor', 'Assets/Source', 'Assets/_Harness/Face', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'Packages/manifest.json'), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
    for (const source of ['FaceStage.cs', 'FaceGeometry.cs', 'FaceEyes.cs', 'FaceMapping.cs', 'AvhCommon.cs']) copyFileSync(join(tools, 'unity/Editor', source), join(root, 'Assets/Editor', source));
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/FaceStageIntegration.cs', import.meta.url)), join(root, 'Assets/Editor/FaceStageIntegration.cs'));
    if (process.env.AVH_FACE_UNITY_BASELINE) {
      cpSync(join(process.env.AVH_FACE_UNITY_BASELINE, 'Packages'), join(root, 'Packages'), { recursive: true });
      const dependencies = JSON.parse(readFileSync(join(root, 'Packages/manifest.json'), 'utf8')).dependencies;
      for (const value of Object.values(dependencies)) assert.ok(!String(value).startsWith('file:'), 'Baseline must use isolated dependencies');
      execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root], { stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
      for (const source of ['FaceStage.cs', 'FaceGeometry.cs', 'FaceEyes.cs', 'FaceMapping.cs', 'AvhCommon.cs']) rmSync(join(root, 'Assets/Editor', source));
      writeFileSync(join(root, 'Assets/csc.rsp'), '-define:AVH_FULL_FACE_IT');
    }
    const fixture = join(root, 'fixture.py');
    writeFileSync(fixture, `import bpy,sys\nfrom pathlib import Path\nroot=Path(sys.argv[-1])\nbpy.ops.wm.read_factory_settings(use_empty=True)\nmesh=bpy.data.meshes.new('FaceMesh')\nmesh.from_pydata([(-.03,0,-.003),(-.03,0,.003),(0,0,.003),(0,0,-.003),(.03,0,.003),(.03,0,-.003)],[],[(0,1,2),(0,2,3),(3,2,4),(3,4,5)])\nmesh.update();obj=bpy.data.objects.new('Face',mesh);bpy.context.collection.objects.link(obj);bpy.context.view_layer.objects.active=obj;obj.select_set(True)\nuv=mesh.uv_layers.new(name='FaceUV')\nfor loop in mesh.loops:\n v=mesh.vertices[loop.vertex_index];uv.data[loop.index].uv=((v.co.x+.03)/.06,(v.co.z+.003)/.006)\nmesh.materials.append(bpy.data.materials.new('Skin'));mesh.materials.append(bpy.data.materials.new('Lips'))\nfor p in mesh.polygons:p.material_index=1 if p.index>=2 else 0\nbasis=obj.shape_key_add(name='Basis');design=obj.shape_key_add(name='ContourWidth');left=obj.shape_key_add(name='RuntimeA');right=obj.shape_key_add(name='RuntimeB')\nfor v in design.data:v.co.z+=.002 if v.co.z>0 else -.002\nfor i in [0,1]:left.data[i].co.z=0\nfor i in [0,1,4,5]:right.data[i].co.z=0\nrigdata=bpy.data.armatures.new('Skeleton');rig=bpy.data.objects.new('Rig',rigdata);bpy.context.collection.objects.link(rig)\nobj.select_set(False);rig.select_set(True);bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='EDIT');head=rigdata.edit_bones.new('Head');head.head=(0,0,0);head.tail=(0,0,.1);bpy.ops.object.mode_set(mode='OBJECT')\nobj.parent=rig;mod=obj.modifiers.new('Skinning','ARMATURE');mod.object=rig;group=obj.vertex_groups.new(name='Head');group.add(list(range(6)),1,'REPLACE');obj.select_set(True)\nbpy.ops.export_scene.fbx(filepath=str(root/'Assets/Source/source.fbx'),use_selection=True,object_types={'ARMATURE','MESH'},add_leaf_bones=False,bake_anim=False,use_mesh_modifiers=False,mesh_smooth_type='OFF',use_custom_props=False)\n`);
    const runBlender = (script: string, args: string[]) => execFileSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python', script, '--', ...args],
      { timeout: 90000, windowsHide: true, stdio: 'pipe' });
    runBlender(fixture, [root]);
    const catalogPath = join(root, 'Assets/_Harness/Face/catalog.json'), sourceEvidence = join(root, 'Assets/_Harness/Face/blender-source-evidence.json'); runBlender(join(tools, 'blender_face.py'), ['catalog', '--source', join(root, 'Assets/Source/source.fbx'), '--output', catalogPath,'--evidence-output',sourceEvidence]);
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')), mesh = catalog.meshes[0];
    const key = (name: string) => mesh.keys.find((k: { name: string }) => k.name === name).id;
    const designKey = key('ContourWidth'), runtime = [key('RuntimeA'), key('RuntimeB')];
    const designPath = join(root, 'Assets/_Harness/Face/blender-design.json');
    writeFileSync(designPath, JSON.stringify({ schema: 'face-design/0.1', revisionId: 'revision-1', source: { ...catalog.source, catalogSha256: catalog.catalogSha256, meshId: mesh.meshId },
      units: { weights: 'blender-relative', geometry: 'meters' }, values: { [designKey]: .5 }, bake: [designKey], preserve: runtime,
      recipe: { id: 'synthetic-api-test', version: '1', sourceSha256: catalog.source.sha256, designKeys: [designKey], runtimeKeys: runtime,
        compensation: { schema: 'face-compensation/0.1', method: 'idw-endpoint-transfer', version: '1', neighbors: 2, power: 1,
          pointToleranceMeters: 1e-8, halfErrorToleranceMeters: 1e-5, quality: { minimumTriangleAreaMetersSquared: 1e-12, minAreaRatio: .05, maxAreaRatio: 20,
            minEdgeRatio: .2, maxEdgeRatio: 5, minNormalDot: 0, maxDihedralIncreaseDegrees: 25 } },
        eyeChecks: { status: 'unsupported', reason: 'Fixture tests Unity binding; no approved eye-region mapping' } },
      acceptance: { positionToleranceMeters: .000001, deltaToleranceMeters: .000001, uvTolerance: .000001, weightTolerance: .000001 }, requiredChecks: ['geometry'] }));
    runBlender(join(tools, 'blender_face.py'), ['bake', '--design', designPath, '--output-dir', join(root, 'Assets/_Harness/Face/Candidates/revision-1')]);
    const cs = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? cs(join(dir, e.name)) : e.name.endsWith('.cs') ? [join(dir, e.name)] : []);
    const compiled = Object.fromEntries((process.env.AVH_FACE_UNITY_BASELINE ? [...cs(join(root, 'Assets/_HarnessTools')), join(root, 'Assets/Editor/FaceStageIntegration.cs')] : cs(join(root, 'Assets/Editor'))).map(path => [path.substring(root.length + 1).replaceAll('\\', '/'), hash(path)]));
    let launchError: unknown;
    const launch = (method: string, log: string, extra: Record<string,string> = {}) => execUnityEditor(process.env.AVH_FACE_UNITY_EDITOR!, ['-batchmode', '-nographics', '-projectPath', root, '-executeMethod', method, '-logFile', join(root, log)],
      { timeout: 330000, windowsHide: true, env: { ...process.env, AVH_PROJECT_DIR: root, AVH_PLAN: JSON.stringify({ body_prefab: 'Assets/Source/avatar.prefab',face:{mode:'design'},outfits:[] }), AVH_MANIFEST: '{"assets":[{"item":"Fixture"}]}', ...extra }, stdio: 'pipe' });
    try {
      launch('AVH.Harness.FaceStageIntegration.Run','seed.log',{AVH_FACE_SEED_SETUP:'1'});
      launch(process.env.AVH_FACE_UNITY_BASELINE ? 'AVH.Harness.SetupStage.Run':'AVH.Harness.FaceStage.PrepareSource','setup.log');
      launch('AVH.Harness.FaceStage.Observe','source-observation.log');
      const target = JSON.parse(readFileSync(join(root,'_harness/face/observation.json'),'utf8')).targets[0];
      const frameEvidence = JSON.parse(readFileSync(join(root, target.frameEvidence.file), 'utf8'));
      assert.equal(frameEvidence.importer.skinWeights, 'Standard');
      assert.equal(frameEvidence.importer.maxBonesPerVertex, 4);
      assert.ok(Math.abs(frameEvidence.importer.minBoneWeight - .001) < 1e-8);
      runBlender(join(tools,'blender_face.py'),['map-source','--observation',join(root,'_harness/face/observation.json'),'--target-id',target.targetId,'--catalog',catalogPath,'--blender-evidence',sourceEvidence,'--output',join(root,'Assets/_Harness/Face/source-mapping.json')]);
      launch('AVH.Harness.FaceStageIntegration.Run','unity.log',{AVH_FACE_REUSE_SETUP:'1'});
    } catch (error) { launchError = error; }
    const report = join(root, 'result.json');
    if (process.env.AVH_FACE_UNITY_EVIDENCE) {
      const evidence = join(process.env.AVH_FACE_UNITY_EVIDENCE, `attempt-${Date.now()}`); mkdirSync(evidence, { recursive: true });
      for (const name of ['result.json', 'seed.log', 'setup.log', 'setup-seed.json', 'unity.log']) if (existsSync(join(root, name))) copyFileSync(join(root, name), join(evidence, name));
      writeFileSync(join(evidence, 'sources.json'), JSON.stringify({ editor: '2022.3.22f1', fullSdk: !!process.env.AVH_FACE_UNITY_BASELINE, files: compiled }, null, 2));
    }
    assert.ok(existsSync(report), `Unity produced no result: ${String(launchError).slice(0, 400)}; ${readFileSync(join(root, 'unity.log'), 'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-8).join('\n') ?? ''}`);
    const result = JSON.parse(readFileSync(report, 'utf8')); assert.equal(result.ok, true, result.error); assert.equal(result.assertions, process.env.AVH_FACE_UNITY_BASELINE ? 78 : 57);
    const stage = join(root, process.env.AVH_FACE_UNITY_BASELINE ? 'Assets/_HarnessTools/Editor/FaceStage.cs' : 'Assets/Editor/FaceStage.cs');
    const fixed = readFileSync(stage, 'utf8');
    if (process.platform === 'win32') {
      const oldSource = fixed.replace('Avh.SameProjectFile(source.Str("path"), relative)',
        'Path.GetFullPath(source.Str("path")) == Path.GetFullPath(Avh.IdentityAbs(relative))');
      assert.notEqual(oldSource, fixed); writeFileSync(stage, oldSource);
      try {
        assert.throws(() => launch('AVH.Harness.FaceStageIntegration.Run', 'source-removal.log'));
        const oldResult = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
        assert.equal(oldResult.ok, false);
        assert.match(oldResult.error, /Blender source is not the observed Unity source model/);
      } finally { writeFileSync(stage, fixed); }
    }
    const removed = fixed.replace(/case SerializedPropertyType\.Gradient:[\s\S]*?\.ToList\(\)\); break;/,
      'case SerializedPropertyType.Gradient: throw new InvalidOperationException("Unmeasured serialized prefab property " + p.propertyPath + " (Gradient)");');
    assert.notEqual(removed, fixed, 'Removal proof must change the actual Unity consumer'); writeFileSync(stage, removed);
    launch('AVH.Harness.FaceStageIntegration.RemovedGradientRun', 'gradient-removal.log');
    assert.equal(JSON.parse(readFileSync(join(root, 'gradient-removal.json'), 'utf8')).oldConsumerRejectedUnchangedSource, true);
    const unbounded = fixed.replace('values[p.propertyPath] = SerializedFloat(p.doubleValue)', 'values[p.propertyPath] = p.doubleValue');
    assert.notEqual(unbounded, fixed, 'Removal proof must change the actual Unity scalar consumer'); writeFileSync(stage, unbounded);
    launch('AVH.Harness.FaceStageIntegration.RemovedInfinityRun', 'infinity-removal.log');
    assert.equal(JSON.parse(readFileSync(join(root, 'infinity-removal.json'), 'utf8')).oldConsumerRejectedUnchangedSource, true);
  });
