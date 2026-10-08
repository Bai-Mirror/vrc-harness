import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';
import { runUnitySteps } from '../src/exec/unity-steps.ts';

// An opt-in real-editor check. The prepared baseline is copied; the accepted environment is never opened by Unity.
test('the managed environment and shipped editor tools compile in an isolated real Unity project', {
  skip: process.env.AVH_ENVIRONMENT_UNITY_IT !== '1', timeout: 1_300_000,
}, async () => {
  assert.ok(process.env.AVH_ENVIRONMENT_BASELINE, 'Set AVH_ENVIRONMENT_BASELINE to the prepared baseline');
  const config = loadConfig();
  assert.ok(config.unity, 'A configured Unity editor is required');
  const root = mkdtempSync(join(tmpdir(), 'avh-environment-unity-'));
  console.log(`Unity environment evidence: ${root}`);
  const project = join(root, 'project'), run = join(root, 'run');
  mkdirSync(run); mkdirSync(project);
  for (const name of ['ProjectSettings', 'Packages']) cpSync(join(process.env.AVH_ENVIRONMENT_BASELINE, name), join(project, name), { recursive: true });
  const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
  execFileSync('python3', ['-c', `import sys
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from setup import install_tools
install_tools(Path(sys.argv[2]),{})
`, tools, project], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const editor = join(project, 'Assets', 'EnvironmentValidation', 'Editor');
  mkdirSync(editor, { recursive: true });
  writeFileSync(join(editor, 'EnvironmentValidation.cs'), `using System;
using System.IO;
using UnityEditor;
using UnityEngine;
public static class EnvironmentValidation {
  public static void Run() {
    if (Application.unityVersion != "2022.3.22f1") throw new Exception("Unexpected editor version");
    var sourceObject = new GameObject("PreservationSource");
    sourceObject.transform.localPosition = new Vector3(0.1f, 0.2f, 0.3f);
    new GameObject("OriginalPart").transform.SetParent(sourceObject.transform, false);
    var source = PrefabUtility.SaveAsPrefabAsset(sourceObject, "Assets/PreservationSource.prefab");
    UnityEngine.Object.DestroyImmediate(sourceObject);
    var instance = (GameObject)PrefabUtility.InstantiatePrefab(source);
    var preserved = PrefabUtility.SaveAsPrefabAsset(instance, "Assets/Preserved.prefab");
    UnityEngine.Object.DestroyImmediate(instance);
    if (!AVH.Harness.OutfitStage.IsUnmodifiedVariant(preserved, "Assets/PreservationSource.prefab"))
      throw new Exception("An unchanged source variant must remain reachable");
    instance = (GameObject)PrefabUtility.InstantiatePrefab(source);
    new GameObject("UnexpectedPart").transform.SetParent(instance.transform, false);
    var changed = PrefabUtility.SaveAsPrefabAsset(instance, "Assets/Changed.prefab");
    UnityEngine.Object.DestroyImmediate(instance);
    if (AVH.Harness.OutfitStage.IsUnmodifiedVariant(changed, "Assets/PreservationSource.prefab"))
      throw new Exception("A changed hierarchy cannot claim preservation");
    instance = (GameObject)PrefabUtility.InstantiatePrefab(source);
    instance.transform.localScale = Vector3.one * 0.5f;
    changed = PrefabUtility.SaveAsPrefabAsset(instance, "Assets/Scaled.prefab");
    UnityEngine.Object.DestroyImmediate(instance);
    if (AVH.Harness.OutfitStage.IsUnmodifiedVariant(changed, "Assets/PreservationSource.prefab"))
      throw new Exception("A changed root transform cannot claim preservation");
    AVH.Harness.OptimizeStage.CreatePreservedOutput(source);
    var output = AssetDatabase.LoadAssetAtPath<GameObject>(AVH.Harness.OptimizeStage.AvatarPath);
    if (!AVH.Harness.OutfitStage.IsUnmodifiedVariant(output, "Assets/PreservationSource.prefab"))
      throw new Exception("The no-optimization output must preserve its source");
    var texturePlan = AVH.Harness.Avh.ReadJsonFile(AVH.Harness.Avh.Abs(AVH.Harness.OptimizeStage.PlanPath));
    if ((string)texturePlan["mode"] != "preserve" || ((System.Collections.IList)texturePlan["textures"]).Count != 0)
      throw new Exception("The no-optimization route cannot change texture settings");
    if (UnityEngine.SceneManagement.SceneManager.GetActiveScene().rootCount != 1 ||
        !File.Exists(AVH.Harness.Avh.Abs(AVH.Harness.OptimizeStage.ScenePath)))
      throw new Exception("The no-optimization route must produce a single-root delivery scene");
    File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("AVH_RUN_DIR"), "compiled.txt"), Application.unityVersion);
    EditorApplication.Exit(0);
  }
}
`);
  const evidence = await runUnitySteps(config.unity, [{ method: 'EnvironmentValidation.Run', quit: false,
    timeoutSec: 1200, env: {} }], project, run, () => {});
  writeFileSync(join(root, 'result.json'), JSON.stringify(evidence, null, 2));
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.exitCode, 0, `See evidence at ${root}`);
  assert.equal(readFileSync(join(run, 'compiled.txt'), 'utf8'), '2022.3.22f1');
  assert.doesNotMatch(readFileSync(evidence[0]!.log, 'utf8'), /error CS\d+/);
  const resolved = JSON.parse(readFileSync(join(project, 'Packages', 'packages-lock.json'), 'utf8')).dependencies;
  for (const [name, value] of Object.entries(resolved) as [string, { source: string }][]) {
    assert.ok(['embedded', 'builtin'].includes(value.source), `${name} escaped the frozen environment: ${value.source}`);
  }
});
