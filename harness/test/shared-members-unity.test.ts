import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {freemem, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {execUnityEditor} from './fixtures/unity-slot.ts';
import {outfitGroupDefaultsObserver, outfitVerdicts} from './fixtures/outfit-verdicts.ts';
import {removeTemp} from './fixtures/platform.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));

test('shared logical revisions survive recolor, native menu roundtrips and a fresh editor reload',
  {skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE ? 'Set isolated Unity SDK baseline' : false, timeout: 3600000}, async t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-shared-revisions-')); t.after(() => removeTemp(root));
    for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), {recursive: true});
    cpSync(join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages'), {recursive: true});
    // Match the production build wrapper: the batch editor cannot wait for VRCFury's delayed package creation.
    mkdirSync(join(root, 'Packages/com.vrcfury.temp'), {recursive: true});
    writeFileSync(join(root, 'Packages/com.vrcfury.temp/package.json'), JSON.stringify({name: 'com.vrcfury.temp', version: '0.0.0'}));
    const manifest = JSON.parse(readFileSync(join(root, 'Packages/manifest.json'), 'utf8'));
    assert.ok(Object.values(manifest.dependencies ?? {}).every(value => !String(value).startsWith('file:')));
    writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
    execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root], {stdio: 'pipe', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
    for (const file of ['SharedMembersIntegration.cs', 'RecolorMaterialIntegration.cs'])
      copyFileSync(fileURLToPath(new URL('./fixtures/unity/' + file, import.meta.url)), join(root, 'Assets/Editor', file));
    const launch = async (phase: string, method = 'Run') => {
      while (process.platform === 'win32' && freemem() < 12 * 1024 ** 3) {
        console.log(`[shared-memory] ${phase}: ${(freemem() / 1024 ** 3).toFixed(2)} GiB free; waiting for 12 GiB`);
        await new Promise(resolve => setTimeout(resolve, 30_000));
      }
      const freeBeforeLaunchGiB = freemem() / 1024 ** 3;
      rmSync(join(root, 'result.json'), {force: true}); let failure: unknown;
      try { execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root, '-executeMethod', 'AVH.Harness.SharedMembersIntegration.' + method, '-logFile', join(root, phase + '.log')],
        {timeout: 900000, env: {...process.env, AVH_PROJECT_DIR: root}, stdio: 'pipe', windowsHide: true}); } catch (error) { failure = error; }
      const files = ['LocalOperations.cs', 'OutfitStage.cs', 'RecolorStage.cs', 'MenuStage.cs', 'AvatarAudit.cs', 'AvhCommon.cs'];
      if (process.env.AVH_LOCAL_UNITY_EVIDENCE) {
        const evidence = join(process.env.AVH_LOCAL_UNITY_EVIDENCE, 'shared-' + phase); mkdirSync(evidence, {recursive: true});
        for (const file of ['result.json', phase + '.log', 'shared-build-report.json']) if (existsSync(join(root, file))) copyFileSync(join(root, file), join(evidence, file));
        for (const file of ['Assets/_Harness/Outfit/outfit.json', 'Assets/_Harness/Recolor/ledger.json', 'Assets/_Harness/Menu/menu.json', 'shared-expected.json'])
          if (existsSync(join(root, file))) copyFileSync(join(root, file), join(evidence, file.split('/').at(-1)!));
        writeFileSync(join(evidence, 'sources.json'), JSON.stringify({freeBeforeLaunchGiB, files: Object.fromEntries(files.map(name => [name,
          createHash('sha256').update(readFileSync(join(root, 'Assets/_HarnessTools/Editor', name))).digest('hex')])),
          fixture_sha256: createHash('sha256').update(readFileSync(join(root, 'Assets/Editor/SharedMembersIntegration.cs'))).digest('hex')}, null, 2));
      }
      assert.ok(existsSync(join(root, 'result.json')), `no Unity result: ${failure}; ${existsSync(join(root, phase + '.log')) ? readFileSync(join(root, phase + '.log'), 'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-8).join('\n') : 'no log'}`);
      return JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
    };
    const normal = await launch('normal'); assert.equal(normal.ok, true, normal.error); assert.ok(normal.assertions >= 20);
    const plan = JSON.parse(readFileSync(join(root, 'shared-expected.json'), 'utf8')).plan as Record<string, unknown>;
    assert.equal(outfitGroupDefaultsObserver, 'avatar.observe');
    const verifyObservedSnapshot = async (snapshot: string, expected: string) => {
      const formalRoot = mkdtempSync(join(tmpdir(), 'avh-outfit-formal-')), run = join(formalRoot, 'run');
      try {
        mkdirSync(join(run, 'observations'), {recursive: true});
        copyFileSync(join(root, 'shared-observations', 'avatar.observe.' + snapshot + '.json'), join(run, 'observations/avatar.observe.json'));
        writeFileSync(join(run, 'observations/assets.validate.json'), JSON.stringify({schema: 'observation/0.1', metrics: {outfits_without_external_refs: 0}}));
        const verdicts = await outfitVerdicts(root, run, plan);
        const group = verdicts.find(verdict => verdict.checkId === 'outfit_group_defaults_match');
        assert.equal(group?.result, expected, `${snapshot}: ${group?.basis}`);
        assert.match(group?.basis ?? '', /^avatar\.observe:/, `${snapshot}: formal check used the wrong observation source`);
      } finally { removeTemp(formalRoot); }
    };
    await verifyObservedSnapshot('positive', 'pass');
    for (const snapshot of ['wrong-visibility', 'wrong-source-material', 'wrong-local-material', 'empty-presets', 'tampered-presets'])
      await verifyObservedSnapshot(snapshot, 'violation');
    const misplacedRoot = mkdtempSync(join(tmpdir(), 'avh-outfit-source-mutation-')), misplacedRun = join(misplacedRoot, 'run');
    try {
      mkdirSync(join(misplacedRun, 'observations'), {recursive: true});
      copyFileSync(join(root, 'shared-observations/avatar.observe.positive.json'), join(misplacedRun, 'observations/clothing.install.json'));
      writeFileSync(join(misplacedRun, 'observations/assets.validate.json'), JSON.stringify({schema: 'observation/0.1', metrics: {outfits_without_external_refs: 0}}));
      const misplaced = await outfitVerdicts(root, misplacedRun, plan);
      const group = misplaced.find(verdict => verdict.checkId === 'outfit_group_defaults_match');
      assert.equal(group?.result, 'no_data', `source mutation unexpectedly passed: ${group?.basis}`);
      assert.match(group?.basis ?? '', /^avatar\.observe:/, 'source mutation did not exercise the avatar.observe check');
    } finally { removeTemp(misplacedRoot); }
    const reload = await launch('reload', 'Reload'); assert.equal(reload.ok, true, reload.error); assert.equal(reload.assertions, 11);
    const local = join(root, 'Assets/_HarnessTools/Editor/LocalOperations.cs'), localSource = readFileSync(local, 'utf8');
    const logicalOnly = localSource.replace('PhysicalPath(op.Str("path"), objects) == physical', 'op.Str("path") == path');
    assert.notEqual(logicalOnly, localSource); writeFileSync(local, logicalOnly);
    const writerMutant = await launch('logical-review-only'); assert.equal(writerMutant.ok, false); assert.match(writerMutant.error, /single shared writer review did not cover/);
    writeFileSync(local, localSource);
    const lostEffective = localSource.replace('Preset(member, path).List("materials")[slot] = identity;', '/* disconnected effective member preset */');
    assert.notEqual(lostEffective, localSource); writeFileSync(local, lostEffective);
    const effectiveMutant = await launch('lost-effective-member'); assert.equal(effectiveMutant.ok, false); assert.match(effectiveMutant.error, /independent reconstruction rejected shared revisions/);
    writeFileSync(local, localSource);
    // Disconnect each downstream consumer from effective member presets, reinstating vendor slots instead.
    const rawMaterial = `var rawSource = AssetDatabase.LoadAssetAtPath<GameObject>(row.Str("prefab"));
                        var relative = PRESET.Str("renderer").Substring(row.Str("object").Length).TrimStart('/');
                        var sourceRenderer = (relative.Length == 0 ? rawSource.transform : rawSource.transform.Find(relative)).GetComponent<Renderer>();`;
    const recolor = join(root, 'Assets/_HarnessTools/Editor/RecolorStage.cs'), recolorSource = readFileSync(recolor, 'utf8');
    const lostRecolor = recolorSource.replace('var original = VariantResolver.Material(preset.List("materials")[slot]);',
      rawMaterial.replace('PRESET', 'preset') + '\n                        var original = sourceRenderer.sharedMaterials[slot];');
    assert.notEqual(lostRecolor, recolorSource); writeFileSync(recolor, lostRecolor);
    const recolorMutant = await launch('raw-recolor-presets'); assert.equal(recolorMutant.ok, false); assert.match(recolorMutant.error, /local revision lost after recolor switch and return/);
    writeFileSync(recolor, recolorSource);
    const menu = join(root, 'Assets/_HarnessTools/Editor/MenuStage.cs'), menuSource = readFileSync(menu, 'utf8');
    const lostMenu = menuSource.replace('b.objects[i] = PresetMaterialObject(row, material, slot);',
      rawMaterial.replace('PRESET', 'material') + '\n                        b.objects[i] = sourceRenderer.sharedMaterials[slot];');
    assert.notEqual(lostMenu, menuSource); writeFileSync(menu, lostMenu);
    const menuMutant = await launch('raw-menu-presets'); assert.equal(menuMutant.ok, false); assert.match(menuMutant.error, /local revision lost during native menu switch/);
    writeFileSync(menu, menuSource);
    const varyingOnly = menuSource.replace('values.Count == 0 || values.Any(v => v != 0 && v != 1)', '!values.Contains(0) || !values.Contains(1) || values.Any(v => v != 0 && v != 1)');
    assert.notEqual(varyingOnly, menuSource); writeFileSync(menu, varyingOnly);
    const constantMutant = await launch('varying-proxy-only'); assert.equal(constantMutant.ok, false); assert.match(constantMutant.error, /业务所有者缺少完整二值曲线/);
    const outfit = join(root, 'Assets/_HarnessTools/Editor/OutfitStage.cs'), outfitSource = readFileSync(outfit, 'utf8');
    const alwaysTrue = outfitSource.replace('return failures == 0;', 'return true;');
    assert.notEqual(alwaysTrue, outfitSource); writeFileSync(outfit, alwaysTrue);
    const defaultsMutant = await launch('group-defaults-always-true'); assert.equal(defaultsMutant.ok, false); assert.match(defaultsMutant.error, /persisted default visibility error/);
    writeFileSync(outfit, outfitSource);
    const skipMaterial = outfitSource.replace('if (actual == null || actual.Length != preset.List("materials").Count || actual.Where((v, i) => Avh.Json(VariantResolver.Identity(v)) != Avh.Json(preset.List("materials")[i])).Any()) failures++;', 'if (false) failures++;');
    assert.notEqual(skipMaterial, outfitSource); writeFileSync(outfit, skipMaterial);
    const materialMutant = await launch('group-defaults-skip-material'); assert.equal(materialMutant.ok, false); assert.match(materialMutant.error, /wrong source material/);
  });
