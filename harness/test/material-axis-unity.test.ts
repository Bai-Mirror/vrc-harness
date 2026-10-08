import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {removeTemp} from './fixtures/platform.ts';
import {execUnityEditor, FIXTURE_RUN_DIRECTORY} from './fixtures/unity-slot.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));

/** A project copy that can compile Harness's editor tools: the frozen baseline packages plus the tools. */
function installTools(project: string) {
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, project],
    {env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
}

function prepare(project: string) {
  for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(project, dir), {recursive: true});
  cpSync(join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(project, 'Packages'), {recursive: true});
  mkdirSync(join(project, 'Packages/com.vrcfury.temp'), {recursive: true});
  writeFileSync(join(project, 'Packages/com.vrcfury.temp/package.json'), JSON.stringify({name: 'com.vrcfury.temp', version: '0.0.0'}));
  writeFileSync(join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  installTools(project);
  // Both fixtures: `MaterialAxesIntegration.Fixture` builds its humanoid through RecolorMaterialIntegration,
  // so a project with only one of them does not compile and every launch aborts before the method runs.
  for (const name of ['MaterialAxesIntegration.cs', 'RecolorMaterialIntegration.cs'])
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/' + name, import.meta.url)), join(project, 'Assets/Editor', name));
}

/** The recipe tool on its own, the way the Runtime calls it: it writes the stage's recipe. */
function recipeTool(plan: unknown, scratch: string) {
  mkdirSync(scratch, {recursive: true});
  execFileSync('python3', [join(tools, 'recolor.py')], {env: {...process.env, PYTHONDONTWRITEBYTECODE: '1',
    AVH_PROJECT_DIR: scratch, AVH_PLAN: JSON.stringify(plan)}, stdio: 'pipe'});
  return readFileSync(join(scratch, 'Assets/_Harness/Recolor/recipe.json'));
}

/** The pure material axis the C# fixture builds, as far as the recipe tool reads it: the recipe for a
 *  targetless plan depends on the axis being complete, not on the assets behind it. */
const axisPlan = {recolor: {targets: [], candidates: 1}, avatar_config: {schema: 'avatar-config/0.1',
  instances: [{id: 'short', kind: 'hair', item: 'fixture', prefab: 'Assets/Authorized/short.prefab'}],
  material_presets: [{id: 'steel', material: 'Assets/Authorized/original.mat'}],
  groups: [{id: 'shade', kind: 'material', activation: 'exclusive',
    bindings: [{id: 'short', instance: 'short', renderer: 'Surface', slot: 0, source_material: 'Assets/Authorized/original.mat'}],
    members: [{id: 'steel', label: 'steel', materials: {short: 'steel'}}]}]}};

test('independent material axes survive all hair/color states, boundaries, full SDK regression and cold import',
  {skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 3_600_000}, t => {
    const root = process.env.AVH_LOCAL_UNITY_AXIS_WORKSPACE ?? mkdtempSync(join(tmpdir(), 'avh-material-axis-'));
    if (!process.env.AVH_LOCAL_UNITY_AXIS_WORKSPACE) t.after(() => removeTemp(root));
    const project = join(root, 'project'), cold = join(root, 'cold');
    prepare(project);
    // The stage's recipe is the recipe tool's artifact. Stage the tool's own output for the fixture's plan
    // shape, and prove afterwards that it is byte-identical to what the tool writes for the plan the
    // fixture actually submitted — the fixture no longer invents a recipe (决定记录 D-116).
    const recipe = recipeTool(axisPlan, join(root, 'axis-recipe-scratch'));
    writeFileSync(join(project, 'axis-recipe.json'), recipe);
    function run(dir: string, method: string) {
      let error: unknown;
      try { execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', dir, '-executeMethod', 'AVH.Harness.MaterialAxesIntegration.' + method, '-logFile', join(dir, 'axis-' + method + '.log')],
        {env: {...process.env, AVH_PROJECT_DIR: dir}, timeout: 1_740_000, windowsHide: true, stdio: 'pipe'}); } catch (e) { error = e; }
      if (process.env.AVH_LOCAL_UNITY_EVIDENCE) {
        const out = join(process.env.AVH_LOCAL_UNITY_EVIDENCE, 'material-axis-' + Date.now() + '-' + method); mkdirSync(out, {recursive: true});
        for (const path of ['axis-' + method + '.log', 'axis-result.json', 'axis-build-report.json', 'axis-coverage-Float.json', 'axis-coverage-Int.json', FIXTURE_RUN_DIRECTORY + '/observations', FIXTURE_RUN_DIRECTORY + '/cold-group-coverage.json'])
          if (existsSync(join(dir, path))) cpSync(join(dir, path), join(out, path), {recursive: true});
      }
      assert.equal(error, undefined, String(error) + '\n' + (existsSync(join(dir, 'axis-result.json')) ? readFileSync(join(dir, 'axis-result.json'), 'utf8') : readFileSync(join(dir, 'axis-' + method + '.log'), 'utf8').match(/.*(?:error CS|Exception).*/g)?.slice(-8).join('\n')));
    }
    run(project, 'Run');
    const result = JSON.parse(readFileSync(join(project, 'axis-result.json'), 'utf8'));
    assert.equal(result.ok, true, result.error); assert.ok(result.assertions >= 20);
    assert.deepEqual(recipeTool(JSON.parse(readFileSync(join(project, 'axis-plan.json'), 'utf8')), join(root, 'axis-recipe-check')), recipe,
      'the fixture consumed exactly the recipe the tool writes for its own plan');
    for (const type of ['Float', 'Int']) {
      const coverage = JSON.parse(readFileSync(join(project, 'axis-coverage-' + type + '.json'), 'utf8'));
      assert.equal(coverage.static_states, 6); assert.equal(coverage.business_assertion_failures, 0); assert.equal(coverage.runtime_assertion_failures, 0);
    }
    installTools(project); // Cold import certifies the current auditor, even when code changed during the warm run.
    mkdirSync(cold, {recursive: true});
    for (const dir of ['Assets', 'Packages', 'ProjectSettings']) cpSync(join(project, dir), join(cold, dir), {recursive: true});
    copyFileSync(join(project, 'axis-plan.json'), join(cold, 'axis-plan.json'));
    assert.equal(existsSync(join(cold, 'Library')), false); run(cold, 'Cold');
    const coverage = JSON.parse(readFileSync(join(cold, FIXTURE_RUN_DIRECTORY, 'cold-group-coverage.json'), 'utf8'));
    assert.equal(coverage.static_states, 6); assert.equal(coverage.static_failures, 0); assert.equal(coverage.runtime_failures, 0);
    assert.ok(Object.values(coverage.metrics).filter(v => typeof v === 'boolean').every(v => v === true), JSON.stringify(coverage.metrics));
  });

test('the shared material adjustment is checked against independently computed numbers, and its mutation is killed',
  {skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 1_800_000}, t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-axis-numbers-')); t.after(() => removeTemp(root));
    const project = join(root, 'numbers');
    prepare(project);
    const reading = () => JSON.parse(readFileSync(join(project, 'axis-numbers-result.json'), 'utf8'));
    const run = () => {
      let error: unknown;
      try { execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', project, '-executeMethod', 'AVH.Harness.MaterialAxesIntegration.Numbers',
        '-logFile', join(project, 'axis-Numbers.log')], {env: {...process.env, AVH_PROJECT_DIR: project}, timeout: 1_740_000, windowsHide: true, stdio: 'pipe'}); } catch (e) { error = e; }
      if (process.env.AVH_LOCAL_UNITY_EVIDENCE) {
        const out = join(process.env.AVH_LOCAL_UNITY_EVIDENCE, 'material-axis-numbers-' + Date.now()); mkdirSync(out, {recursive: true});
        for (const path of ['axis-Numbers.log', 'axis-numbers-result.json']) if (existsSync(join(project, path))) cpSync(join(project, path), join(out, path));
      }
      return error;
    };
    assert.equal(run(), undefined, 'the unmutated adjustment must satisfy the independent expectations');
    assert.equal(reading().ok, true, JSON.stringify(reading()));
    // Generation and audit share `Adjust`, so only an expectation computed outside it can see a systematic
    // error. Patch the hue scaling in the installed tool and require the reading to turn false.
    const installed = join(project, 'Assets/_HarnessTools/Editor/MaterialAxes.cs');
    const original = readFileSync(installed, 'utf8');
    const mutated = original.replace('"hue_shift", 0) / 360', '"hue_shift", 0) / 180');
    assert.notEqual(mutated, original, 'the shared adjustment keeps the hue divisor this mutation patches');
    writeFileSync(installed, mutated);
    assert.notEqual(run(), undefined, 'the mutant must fail the run');
    assert.equal(reading().ok, false);
    assert.match(String(reading().error), /independent expectation failed for hue on _MainTexHSVG/);
    writeFileSync(installed, original);
    assert.equal(run(), undefined, 'restoring the tool must restore the reading');
    assert.equal(reading().ok, true, JSON.stringify(reading()));
  });
