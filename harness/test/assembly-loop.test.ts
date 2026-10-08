import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {freemem, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {execUnityEditor} from './fixtures/unity-slot.ts';
import {removeTemp} from './fixtures/platform.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));

test('intake and formal planning retain an authorized model-only installation without inventing prefab candidates', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-model-plan-')); t.after(() => removeTemp(root));
  const body = join(root, 'Base.unitypackage'), model = join(root, 'Geometry.unitypackage');
  execFileSync('python3', ['-c', `import io,tarfile,sys
for archive,path in [(sys.argv[1],'Assets/Unseen/Base.prefab'),(sys.argv[2],'Assets/Geometry/object.obj')]:
 with tarfile.open(archive,'w:gz') as tar:
  data=path.encode();entry=tarfile.TarInfo('unique/pathname');entry.size=len(data);tar.addfile(entry,io.BytesIO(data))
`, body, model], {stdio: 'pipe'});
  const env = {...process.env, PYTHONDONTWRITEBYTECODE: '1', AVH_MANIFEST: JSON.stringify({schema: 'manifest/0.1', request: '通用模型装配夹具', assets: [
    {item: body, role: 'body', store: 'client'}, {item: model, role: 'other', store: 'client'}]})};
  const project = join(root, 'project');
  execFileSync('python3', [join(tools, 'intake.py'), '--library', root, '--project', project], {env, stdio: 'pipe'});
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8'));
  const raw = inventory.items.find((row: any) => row.item === model);
  assert.deepEqual(raw.prefabs, []); assert.deepEqual(raw.models, ['Assets/Geometry/object.obj']); assert.equal(raw.compat.conclusion, '待骨骼比对');
  const plan = {schema: 'plan/0.3', body, body_prefab: 'Assets/Unseen/Base.prefab', client_gallery: false,
    avatar_config: {schema: 'avatar-config/0.1', instances: [{id: 'raw', kind: 'accessory', item: model, prefab: raw.models[0], compatibility: 'pending_assembly'}],
      groups: [{id: 'fixed', label: '固定件', activation: 'fixed', members: [{id: 'model', instance: 'raw', label: '模型'}]}], shared_switches: []},
    obligations: [{input: body, role: 'body', action: 'use', target: 'Assets/Unseen/Base.prefab', due_stage: 'outfit'},
      {input: model, role: 'other', action: 'use', target: raw.models[0], due_stage: 'outfit'}],
    menu: {mode: 'assemble', vendor_policy: 'preserve_and_merge', tree: []}, face: {mode: 'preserve'}, optimization: {mode: 'preserve'},
    recolor: {targets: [{part: 'eye', hue_shift: 0, saturation: 1, value: 1}], candidates: 3}};
  mkdirSync(join(project, '_harness/plan'), {recursive: true}); writeFileSync(join(project, '_harness/plan/draft.json'), JSON.stringify(plan));
  execFileSync('python3', [join(tools, 'plan.py'), 'submit', '--project', project, '--draft', '_harness/plan/draft.json'], {env, stdio: 'pipe'});
  const observe = () => {
    const output = join(root, 'observed.json');
    execFileSync('python3', [join(tools, 'plan.py'), 'observe', '--project', project, '--out', output], {env: {...env, AVH_PLAN: JSON.stringify(plan)}, stdio: 'pipe'});
    return JSON.parse(readFileSync(output, 'utf8')).metrics.plan_source_contract_valid;
  };
  assert.equal(observe(), true, 'selected model source must reach trial assembly with its own obligation');
  const path = join(project, '_harness/intake/plan-catalog.json'); const catalog = JSON.parse(readFileSync(path, 'utf8'));
  catalog.items.find((row: any) => row.item === model).models.push('Assets/Injected.obj'); writeFileSync(path, JSON.stringify(catalog));
  assert.equal(observe(), false, 'model sources must stay bound to measured intake identity');
});

test('Unity observes pending sources before recipe assembly and independently rejects false installation evidence',
  {skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE ? 'Set Unity editor and isolated SDK baseline' : false, timeout: 3600000}, async t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-assembly-loop-')); t.after(() => removeTemp(root));
    for (const path of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, path), {recursive: true});
    cpSync(join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages'), {recursive: true});
    const manifest = JSON.parse(readFileSync(join(root, 'Packages/manifest.json'), 'utf8'));
    for (const value of Object.values(manifest.dependencies ?? {})) assert.ok(!String(value).startsWith('file:'), 'isolated baseline must not reference external paths');
    writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
    execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root], {stdio: 'pipe', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/AssemblyLoopIntegration.cs', import.meta.url)), join(root, 'Assets/Editor/AssemblyLoopIntegration.cs'));
    const launch = async (phase: string) => {
      // This lane must leave the resident model alone and wait for 12 GiB before each editor.
      while (process.platform === 'win32' && freemem() < 12 * 1024 ** 3) {
        console.log(`[assembly-memory] ${phase}: ${(freemem() / 1024 ** 3).toFixed(2)} GiB free; waiting for 12 GiB`);
        await new Promise(resolve => setTimeout(resolve, 30_000));
      }
      rmSync(join(root, 'result.json'), {force: true});
      let failure: unknown;
      try { execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-nographics', '-projectPath', root, '-executeMethod', 'AVH.Harness.AssemblyLoopIntegration.Run', '-logFile', join(root, phase + '.log')],
        {timeout: 900000, env: {...process.env, AVH_PROJECT_DIR: root}, stdio: 'pipe'}); } catch (error) { failure = error; }
      const report = join(root, 'result.json');
      if (process.env.AVH_LOCAL_UNITY_EVIDENCE) {
        const evidence = join(process.env.AVH_LOCAL_UNITY_EVIDENCE, 'assembly-' + phase); mkdirSync(evidence, {recursive: true});
        for (const file of ['result.json', phase + '.log']) if (existsSync(join(root, file))) copyFileSync(join(root, file), join(evidence, file));
        const names = ['LocalOperations.cs', 'OutfitStage.cs', 'AvhCommon.cs', 'SetupStage.cs'];
        writeFileSync(join(evidence, 'sources.json'), JSON.stringify({editor: '2022.3.22f1', fullSdk: true,
          files: Object.fromEntries(names.map(name => [name, createHash('sha256').update(readFileSync(join(root, 'Assets/_HarnessTools/Editor', name))).digest('hex')]))}, null, 2));
      }
      assert.ok(existsSync(report), `no Unity report: ${failure}; ${existsSync(join(root, phase + '.log')) ? readFileSync(join(root, phase + '.log'), 'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-8).join('\n') : ''}`);
      return JSON.parse(readFileSync(report, 'utf8'));
    };
    const normal = await launch('normal'); assert.equal(normal.ok, true, normal.error); assert.equal(normal.assertions, 45);
    // Mutate actual deployed consumers, then execute the same fixture, rather than comparing source text.
    const source = join(root, 'Assets/_HarnessTools/Editor/LocalOperations.cs'); const original = readFileSync(source, 'utf8');
    const cycle = original.replace('var avatar = (GameObject)PrefabUtility.InstantiatePrefab(body);', 'var avatar = OutfitStage.Assemble(body, plan, out _, out _);');
    assert.notEqual(cycle, original); writeFileSync(source, cycle);
    const observationMutant = await launch('observation-cycle'); assert.equal(observationMutant.ok, false); assert.match(observationMutant.error, /mount|挂点/);
    writeFileSync(source, original);
    const unresolved = original.replace('return pair.Value + path.Substring(pair.Key.Length);', 'return path;');
    assert.notEqual(unresolved, original); writeFileSync(source, unresolved);
    const identityMutant = await launch('skip-logical-map'); assert.equal(identityMutant.ok, false); assert.match(identityMutant.error, /对象不存在|second member|independent reload/);
    const collisions = original.replace('!claims.Add("transform:" + path)', 'false');
    assert.notEqual(collisions, original); writeFileSync(source, collisions);
    const conflictMutant = await launch('skip-shared-conflict'); assert.equal(conflictMutant.ok, false); assert.match(conflictMutant.error, /shared physical target accepted duplicate transform/);
    writeFileSync(source, original);
    const measure = join(root, 'Assets/_HarnessTools/Editor/OutfitStage.cs'); const measured = readFileSync(measure, 'utf8');
    const noBoneProxyRebase = measured.replace('RebaseAbsoluteBoneProxyPaths(avatar, instance, prefab);', '// mutation: omit MA-compatible subPath rebase');
    assert.notEqual(noBoneProxyRebase, measured); writeFileSync(measure, noBoneProxyRebase);
    const boneProxyMutant = await launch('skip-boneproxy-rebase'); assert.equal(boneProxyMutant.ok, false);
    assert.match(boneProxyMutant.error, /valid actual mapping|刚性挂点|subPath/);
    writeFileSync(measure, measured);
    const noMerge = measured.replace('SetupOutfit(instance); kind = Classify(instance);', 'if (outfit.Str("assembly_mode") != "merge") SetupOutfit(instance); kind = Classify(instance);');
    assert.notEqual(noMerge, measured); writeFileSync(measure, noMerge);
    const mergeMutant = await launch('skip-merge-recipe'); assert.equal(mergeMutant.ok, false); assert.match(mergeMutant.error, /valid actual mapping|Sequence contains no elements|merge recipe|no-MA layered skin/);
    writeFileSync(measure, measured);
    const skipped = measured.replace('assemblyFailures += AssemblyFailures(avatar, root.gameObject, entry, notes, proxyFailures);', 'assemblyFailures += 0;');
    assert.notEqual(skipped, measured); writeFileSync(measure, skipped);
    const measurementMutant = await launch('skip-mapping'); assert.equal(measurementMutant.ok, false); assert.match(measurementMutant.error, /production observer accepted failed installation/);
    writeFileSync(measure, measured);
    // Restore the defect the level rule replaced: a flat name set over the whole target subtree demands a
    // mapping for a garment bone that only shares its name with a body bone at another depth.
    const flat = measured.replace('LevelHoldsName(bone.parent, merge.transform, target, normalized, map)',
      'new HashSet<string>(target.GetComponentsInChildren<Transform>(true).Select(t => t.name)).Contains(normalized)');
    assert.notEqual(flat, measured); writeFileSync(measure, flat);
    const flatMutant = await launch('flat-body-names'); assert.equal(flatMutant.ok, false); assert.match(flatMutant.error, /another level/);
    writeFileSync(measure, measured);
  });
