import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor } from './fixtures/unity-slot.ts';
import { loadCapabilities } from '../src/workflow/capabilities.ts';
import { loadProcess } from '../src/process/load.ts';
import { parse } from 'yaml';
import { compileContext } from '../src/workflow/context-compiler.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const sources = ['LocalOperations.cs', 'OutfitStage.cs', 'OutfitVisibility.cs', 'SetupStage.cs', 'AvhCommon.cs', 'FaceStage.cs', 'FaceGeometry.cs', 'FaceEyes.cs', 'FaceMapping.cs'];
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const python = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();
async function memoryBeforeUnity() {
  while (process.platform === 'win32' && freemem() < 12 * 1024 ** 3) {
    console.log(`[local-memory] ${(freemem() / 1024 ** 3).toFixed(2)} GiB free; waiting for 12 GiB`);
    await new Promise(resolve => setTimeout(resolve, 30_000));
  }
  return freemem() / 1024 ** 3;
}

test('local observation pages bind raw evidence and reject an altered installed operation tool', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-local-operations-')); t.after(() => removeTemp(root));
  const installed = join(root, 'Assets/_HarnessTools/Editor'); mkdirSync(installed, { recursive: true });
  for (const source of sources) copyFileSync(join(tools, 'unity/Editor', source), join(installed, source));
  const invoke = (...args: string[]) => execFileSync('python3', [join(tools, 'local_operations.py'), ...args, '--project', root], { encoding: 'utf8', stdio: 'pipe' });
  assert.equal(JSON.parse(invoke('contract', ...sources.map(s => join(tools, 'unity/Editor', s)))).verified_sources, 9);
  writeFileSync(join(installed, sources[0]!), '// altered validator');
  assert.throws(() => invoke('contract', ...sources.map(s => join(tools, 'unity/Editor', s))), /frozen source/);
  assert.throws(() => invoke('contract', join(tools, 'unity/Editor', sources[1]!)), /Incomplete frozen/);
  mkdirSync(join(root, '_harness/setup'), { recursive: true });
  const evidence = join(root, '_harness/setup/object-observation.json');
  writeFileSync(evidence, JSON.stringify({ schema: 'object-observation/0.1', objects: [{ path: 'arbitrary-part' }, { path: 'other' }],
    sources: [{asset: 'Assets/Authorized/raw.obj', form: 'Model', objects: [{path: '', components: ['UnityEngine.Transform']}]}],
    reviews: [{path:'_Outfit/Outfit_sample',shrinkkey:{shapes:['Host->Body:Foot=Set']}}], references: ['Assets/Authorized/texture.png'], asset_hashes: { 'Assets/Authorized/texture.png': 'hash' }, references_truncated: true }));
  const page = JSON.parse(invoke('inspect', '--offset', '1', '--limit', '1'));
  assert.equal(page.observation_sha256, sha(evidence)); assert.deepEqual(page.rows, [{ path: 'other' }]); assert.equal(page.next_offset, null);
  assert.equal(page.references_truncated, true);
  const references = JSON.parse(invoke('inspect', '--section', 'references'));
  assert.deepEqual(references.rows, [{ path: 'Assets/Authorized/texture.png', asset_hash: 'hash' }]);
  assert.equal(JSON.parse(invoke('inspect','--section','reviews')).rows[0].shrinkkey.shapes[0], 'Host->Body:Foot=Set');
  const sourcePage = JSON.parse(invoke('inspect', '--section', 'sources'));
  assert.equal(sourcePage.rows[0].asset, 'Assets/Authorized/raw.obj'); assert.equal(sourcePage.rows[0].form, 'Model');
  assert.equal(sourcePage.observation_sha256, sha(evidence));
  assert.throws(() => invoke('inspect', '--limit', '100'), /Invalid observation page/);
  const legacy = JSON.parse(readFileSync(evidence,'utf8')); delete legacy.reviews; writeFileSync(evidence,JSON.stringify(legacy));
  mkdirSync(join(root,'Assets/_Harness/Outfit'),{recursive:true});
  writeFileSync(join(root,'Assets/_Harness/Outfit/outfit.json'),JSON.stringify({outfits:[{id:'legacy',object:'_Outfit/Outfit_legacy',shrinkkey:{shapes:['Legacy->Body:Foot=Set']}}]}));
  const guidance = JSON.parse(invoke('inspect','--section','reviews'));
  assert.equal(guidance.observation_sha256,sha(evidence)); assert.equal(guidance.rows[0].outfit_id,'legacy');
  assert.equal(guidance.authority,'guidance_only_revalidated_in_unity','old mutable output must never acquire approval authority');
});

test('the outfit visibility section reports the assembly summary, pages the pairs, and treats a first round as ordinary', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-visibility-')); t.after(() => removeTemp(root));
  const invoke = (...args: string[]) => execFileSync('python3', [join(tools, 'local_operations.py'), 'inspect', ...args, '--project', root], { encoding: 'utf8', stdio: 'pipe' });
  // Before the first assembly there is no visibility record; that is a state a run passes through, not a broken observation.
  const absent = JSON.parse(invoke('--section', 'visibility'));
  assert.equal(absent.available, false);
  assert.equal(absent.message, '本轮还没有装配后的可见清单（第一次装配之后才有）');
  assert.deepEqual(absent.rows, []);
  mkdirSync(join(root, 'Assets/_Harness/Outfit'), { recursive: true });
  writeFileSync(join(root, 'Assets/_Harness/Outfit/visibility.json'), JSON.stringify({
    schema: 'outfit-visibility/0.1', epsilon_mm: 0.1, min_contact_cm2: 1.0,
    renderers: [{ path: '_Outfit/Outfit_a/Layer', source: 'outfit:a', part: 'Layer', body_part: '头', visible: true, vertices: 10, triangles: 8 },
      { path: 'Body/Hair', source: 'body', part: 'Hair', body_part: '头', visible: true, vertices: 5, triangles: 4 }],
    body_parts: [{ part: '头', count: 2, by_source: [{ source: 'body', paths: ['Body/Hair'] },
      { source: 'outfit:a', paths: ['_Outfit/Outfit_a/Layer'] }] }],
    body_sets: [{ members: ['Body/Hair'], evidence: 'prefab_difference', detail: 'differs from the other body prefab' }],
    pairs: [{ a: 'Body/Hair', b: '_Outfit/Outfit_a/Layer', contact_cm2: 12.5, min_mm: 0, same_source: false },
      { a: 'Body/Hair', b: '_Outfit/Outfit_a/Layer', contact_cm2: 3.0, min_mm: 0.1, same_source: false }],
    stacks: [{ members: ['Body/Hair', '_Outfit/Outfit_a/Layer'], max_contact_cm2: 12.5 }],
    visible_interpenetration: { schema: 'outfit-visible-interpenetration/0.1', valid: true, layer_reach_mm: 1, inner_ratio: 0.5,
      min_vertices: 8, guard_depth_mm: 2, guard_vertices: 128, candidate_pairs: 1, confirmed_pairs: 1, counted_pairs: 1,
      max_confirmed: 12, max_counting: 12, undecided_pairs: 1, out_of_bounds_accepted_pairs: 0, ask_user_pairs: 0,
      decisions: [{ layer: '_Outfit/Outfit_a/Layer', outer: '_Outfit/Outfit_b/Coat', confirmed: 12, visible_pixels: 9,
        depth_max_mm: 0.9, depth_median_mm: 0.6, body_part: '头', outer_part: '胸', layer_source: 'outfit:a', outer_source: 'outfit:b',
        layer_role: 'outfit', outer_role: 'hair', out_of_bounds: false, decision: 'none', decision_valid: false, counted: true }],
      pairs: [{ layer: '_Outfit/Outfit_a/Layer', outer: '_Outfit/Outfit_b/Coat', candidates: 30, confirmed: 12, views: ['front'],
        visible_pixels: 9, decision: 'none', decision_valid: false, counted: true, out_of_bounds: false,
        body_part: '头', outer_part: '胸', layer_role: 'outfit', outer_role: 'hair' }] },
    hidden_by_decision: [{ path: '_Outfit/Outfit_b/Old', operation: 'hide_old', rationale: 'order names the other layer' }],
  }));
  const page = JSON.parse(invoke('--section', 'visibility', '--limit', '1'));
  assert.equal(page.available, true);
  assert.equal(page.visible_renderers, 2);
  assert.equal(page.total, 2);
  assert.equal(page.next_offset, 1);
  assert.equal(page.rows.length, 1);
  assert.deepEqual(page.summary.stacks[0].sources, ['body', 'outfit:a']);
  assert.equal(page.summary.stacks[0].max_contact_cm2, 12.5);
  // D-143: the parts of one body part are grouped by source, so two parts of one place are readable at a glance.
  assert.equal(page.summary.body_parts[0].part, '头');
  assert.deepEqual(page.summary.body_parts[0].by_source.map((row: { source: string }) => row.source), ['body', 'outfit:a']);
  // D-143 ③: the evidence an executor decides on travels with the same summary, decisions included.
  assert.equal(page.summary.visible_interpenetration.counted_pairs, 1);
  assert.equal(page.summary.visible_interpenetration.pairs[0].confirmed, 12);
  assert.equal(page.summary.visible_interpenetration.pairs[0].visible_pixels, 9);
  assert.equal(page.summary.visible_interpenetration.decisions[0].decision, 'none');
  assert.equal(page.summary.visible_interpenetration.decisions[0].counted, true);
  assert.equal(page.summary.visible_interpenetration.decisions[0].outer_role, 'hair');
  assert.equal(page.summary.visible_interpenetration.guard_vertices, 128);
  assert.equal(page.summary.body_sets[0].evidence, 'prefab_difference');
  assert.equal(page.summary.hidden_by_decision[0].rationale, 'order names the other layer');
  const last = JSON.parse(invoke('--section', 'visibility', '--offset', '1', '--limit', '1'));
  assert.equal(last.next_offset, null);
  assert.deepEqual(last.rows.map((row: { contact_cm2: number }) => row.contact_cm2), [3.0]);
  // The pair table is paged, so the visibility record cannot return an unbounded page.
  assert.throws(() => invoke('--section', 'visibility', '--limit', '100'), /Invalid observation page/);
});

test('production local operation inputs have a frozen consumer and mandatory independent output check', () => {
  const path = fileURLToPath(new URL('../builtin/knowledge/process/', import.meta.url));
  const process = loadProcess(readFileSync(join(path, 'pc-recolor-outfit.process.yaml'), 'utf8'), parse(readFileSync(join(path, 'thresholds.yaml'), 'utf8')));
  const caps = loadCapabilities(readFileSync(join(path, 'pc-recolor-outfit.capabilities.yaml'), 'utf8'), process);
  assert.ok(caps.stages.outfit?.prepareCommand?.includes('{toolRoot}/harness/unity/Editor/LocalOperations.cs'));
  assert.equal(caps.stages.outfit?.unitySteps?.[0]?.method, 'AVH.Harness.OutfitStage.Run');
  assert.ok(process.stages.find(s => s.id === 'outfit')?.requires.includes('local_operations_verified'));
  assert.equal(process.checks.find(c => c.id === 'local_operations_verified')?.rule, 'local_operations_valid == true');
  assert.ok(caps.stages.outfit?.goal?.includes('local-operations/0.1'));
  const outfit = caps.stages.outfit!;
  const knowledge = fileURLToPath(new URL('../builtin/knowledge/', import.meta.url));
  const compiled = compileContext(outfit.context.map(spec => ({ spec, content: readFileSync(join(knowledge, spec.path), 'utf8'), sha256: sha(join(knowledge, spec.path)) })),
    { plan: { outfits: [] }, manifest: {}, memory: {} }, { budgetChars: outfit.contextBudgetChars, requiredCoverage: outfit.contextCoverage });
  assert.match(compiled.text, /local-operations\.json/);
  assert.match(compiled.text, /object_state/);
  assert.match(outfit.goal!, /object_state/);
  assert.match(outfit.goal!, /foot_writer/);
  assert.match(outfit.goal!, /shrinkkey_review/);
  assert.match(compiled.text, /局部方案复核/);
  assert.match(compiled.text, /先观察、后装配/);
  assert.ok(compiled.decisions.some(d => d.id === 'outfit.visibility.evidence-based' && d.selected && d.required),
    'the evidence-based default-visibility clause must be required, not an optional item that can fall out of budget');
  assert.match(compiled.text, /装配后的默认显隐/);
  // D-143 ③: the injected knowledge has to carry the decision channel, not only the blocking counter.
  assert.match(compiled.text, /interpenetration_decisions/);
  assert.match(compiled.text, /ask_user/);
  assert.match(compiled.text, /visible_interpenetration_pairs/);
  assert.match(compiled.text, /user_review/);
  assert.match(outfit.goal!, /--section visibility/);
  assert.match(outfit.goal!, /rationale/);
  assert.match(outfit.goal!, /outfit_visible_overlaps/);
  // D-143: the executor instruction names the second blocking counter and the by-body-part grouping.
  assert.match(outfit.goal!, /outfit_visible_interpenetration/);
  assert.match(outfit.goal!, /按身体部位/);
  assert.match(compiled.text, /看得见的互穿/);
  assert.match(outfit.goal!, /kind: assembly/);
  assert.match(outfit.goal!, /logical_objects/);
  assert.match(outfit.goal!, /有效预设并持久绑定/);
  assert.match(compiled.text, /供等价成员复用/);
  assert.match(compiled.text, /逻辑成员与共享对象/);
  assert.equal(process.checks.find(c => c.id === 'assembly_compatibility_verified')?.rule, 'assembly_compatibility_failures == 0');
  assert.ok(process.stages.find(s => s.id === 'outfit')?.requires.includes('assembly_compatibility_verified'));
  assert.match(outfit.goal!, /不代表三态实测/);
  assert.match(outfit.goal!, /已接受脸型不能排除/);
  assert.doesNotMatch(compiled.text, /outfit 阶段没有设计输入/);
  // The injected execution model says what the boundary actually is: a restricted write environment, not a
  // network-isolated one (决定记录/D-111; Windows Runs keep the host's network).
  assert.doesNotMatch(compiled.text, /断网的沙箱/, 'the model must not be told the Unity step is disconnected');
  assert.match(compiled.text, /受限写入的环境里启动 Unity（执行方不能直接写工作区以外的位置）/, 'and must be told the write boundary instead');
});

test('Runtime source deployment checks all exact targets before writing and never accepts source edits as upgrade authority', {skip:!python},t=>{
  const root=mkdtempSync(join(tmpdir(),'avh-operation-deployment-'));t.after(()=>removeTemp(root));
  const installed=join(root,'Assets/_HarnessTools/Editor');mkdirSync(installed,{recursive:true});
  for(const source of sources)copyFileSync(join(tools,'unity/Editor',source),join(installed,source));
  const old=join(installed,sources[0]!);writeFileSync(old,'prior frozen source');
  const rows=sources.map(name=>({path:'Assets/_HarnessTools/Editor/'+name,before:sha(join(installed,name)),after:sha(join(tools,'unity/Editor',name))}));
  const argv=[join(tools,'local_operations.py'),'contract',...sources.map(name=>join(tools,'unity/Editor',name)),'--project',root,'--install'];
  assert.throws(()=>execFileSync('python3',argv,{env:{...process.env,AVH_RUNTIME_TOOL_UPDATE_JSON:''},stdio:'pipe'}));
  const tampered=rows.map(value=>({...value}));tampered[7]!.before='0'.repeat(64);
  // Give the last target a different current version; the first must remain untouched on rejection.
  writeFileSync(join(installed,sources[7]!),'unreviewed edit');
  assert.throws(()=>execFileSync('python3',argv,{env:{...process.env,AVH_RUNTIME_TOOL_UPDATE_JSON:JSON.stringify(tampered)},stdio:'pipe'}),/exact source versions/);
  assert.equal(readFileSync(old,'utf8'),'prior frozen source');
  copyFileSync(join(tools,'unity/Editor',sources[7]!),join(installed,sources[7]!));
  const result=execFileSync('python3',argv,{env:{...process.env,AVH_RUNTIME_TOOL_UPDATE_JSON:JSON.stringify(rows)},encoding:'utf8',stdio:'pipe'});
  assert.equal(JSON.parse(result).verified_sources,9);assert.equal(sha(old),sha(join(tools,'unity/Editor',sources[0]!)));
  execFileSync('python3',argv,{env:{...process.env,AVH_RUNTIME_TOOL_UPDATE_JSON:JSON.stringify(rows)},stdio:'pipe'});
});

// Actual Unity API integration with synthetic assets. This does not prove paid material fitting, final delivery or an AI design loop.
test('Unity reload validates arbitrary material/texture/transform/attachment operations and rejects drift and unauthorized writes',
  { skip: !process.env.AVH_LOCAL_UNITY_EDITOR && 'Set AVH_LOCAL_UNITY_EDITOR to run actual Unity integration', timeout: 1800000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-local-unity-')); t.after(() => removeTemp(root));
    mkdirSync(join(root, 'Assets/Editor'), { recursive: true }); mkdirSync(join(root, 'Packages'), { recursive: true });
    mkdirSync(join(root, 'ProjectSettings'), { recursive: true });
    writeFileSync(join(root, 'Packages/manifest.json'), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
    copyFileSync(join(tools, 'unity/Editor/LocalOperations.cs'), join(root, 'Assets/Editor/LocalOperations.cs'));
    copyFileSync(join(tools, 'unity/Editor/AvhCommon.cs'), join(root, 'Assets/Editor/AvhCommon.cs'));
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/LocalOperationsIntegration.cs', import.meta.url)), join(root, 'Assets/Editor/LocalOperationsIntegration.cs'));
    if (process.env.AVH_LOCAL_UNITY_BASELINE) {
      cpSync(join(process.env.AVH_LOCAL_UNITY_BASELINE, 'Packages'), join(root, 'Packages'), { recursive: true });
      const manifest = JSON.parse(readFileSync(join(root, 'Packages/manifest.json'), 'utf8'));
      for (const [key, value] of Object.entries(manifest.dependencies ?? {})) assert.ok(!String(value).startsWith('file:'), `An isolated baseline cannot reference an external package: ${key}`);
      execFileSync('python3', ['-c', 'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from setup import install_tools; install_tools(Path(sys.argv[2]),{})', tools, root],
        { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
      rmSync(join(root, 'Assets/Editor/LocalOperations.cs')); rmSync(join(root, 'Assets/Editor/AvhCommon.cs'));
      writeFileSync(join(root, 'Assets/csc.rsp'), '-define:AVH_FULL_LOCAL_IT');
    }
    const compiled = process.env.AVH_LOCAL_UNITY_BASELINE
      ? Object.fromEntries(sources.map(source => [source, sha(join(root, 'Assets/_HarnessTools/Editor', source))]))
      : Object.fromEntries(['LocalOperations.cs', 'AvhCommon.cs', 'LocalOperationsIntegration.cs'].map(source => [source, sha(join(root, 'Assets/Editor', source))]));
    const report = join(root, 'result.json');
    let launchError: unknown;
    const freeBeforeLaunchGiB = await memoryBeforeUnity();
    try { execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-nographics', '-projectPath', root, '-executeMethod',
      'AVH.Harness.LocalOperationsIntegration.Run', '-logFile', join(root, 'unity.log')], { timeout: 900000,
      env: { ...process.env, AVH_PROJECT_DIR: root }, stdio: 'pipe' }); } catch (error) { launchError = error; }
    if (process.env.AVH_LOCAL_UNITY_EVIDENCE) {
      const evidence = join(process.env.AVH_LOCAL_UNITY_EVIDENCE, `attempt-${Date.now()}`);
      mkdirSync(evidence, { recursive: true });
      if (existsSync(report)) copyFileSync(report, join(evidence, 'result.json'));
      if (existsSync(join(root, 'unity.log'))) copyFileSync(join(root, 'unity.log'), join(evidence, 'unity.log'));
      writeFileSync(join(evidence, 'sources.json'), JSON.stringify({ editor: '2022.3.22f1', fullSdk: !!process.env.AVH_LOCAL_UNITY_BASELINE, freeBeforeLaunchGiB,
        files: compiled }, null, 2));
    }
    assert.ok(existsSync(report), `Unity produced no integration report: ${launchError ? String(launchError).slice(0,500) : 'missing'}; ${readFileSync(join(root, 'unity.log'), 'utf8').match(/.*(?:error CS|Error|Exception).*/g)?.slice(-6).join('\n') ?? ''}`);
    const result = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(result.ok, true, result.error); assert.equal(result.assertions, process.env.AVH_LOCAL_UNITY_BASELINE ? 56 : 31);
  });

test('a later Unity session accepts the baseline an earlier session saved',
  { skip: !process.env.AVH_LOCAL_UNITY_EDITOR && 'Set AVH_LOCAL_UNITY_EDITOR to run actual Unity integration', timeout: 1800000 }, async t => {
    // Production spans two editors: setup records the observation, its stage then persists the assembly's
    // pending writes and exits, and a later stage consumes the input. One process cannot show that boundary,
    // so this launches Unity twice against the same project and asks which hash component moved.
    const root = mkdtempSync(join(tmpdir(), 'avh-save-boundary-')); t.after(() => removeTemp(root));
    mkdirSync(join(root, 'Assets/Editor'), { recursive: true }); mkdirSync(join(root, 'Packages'), { recursive: true });
    mkdirSync(join(root, 'ProjectSettings'), { recursive: true });
    writeFileSync(join(root, 'Packages/manifest.json'), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
    for (const source of ['LocalOperations.cs', 'AvhCommon.cs'])
      copyFileSync(join(tools, 'unity/Editor', source), join(root, 'Assets/Editor', source));
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/SaveBoundaryIntegration.cs', import.meta.url)), join(root, 'Assets/Editor/SaveBoundaryIntegration.cs'));
    const plan = JSON.stringify({ body_prefab: 'Assets/Authorized/body.prefab', outfits: [] });
    const launch = async (phase: string) => {
      let launchError: unknown;
      await memoryBeforeUnity();
      try {
        execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-nographics', '-projectPath', root, '-executeMethod',
          'AVH.Harness.SaveBoundaryIntegration.Run', '-logFile', join(root, `unity-${phase}.log`)],
          { timeout: 330000, env: { ...process.env, AVH_PROJECT_DIR: root, AVH_SAVE_BOUNDARY_PHASE: phase, AVH_PLAN: plan }, stdio: 'pipe' });
      } catch (error) { launchError = error; }
      const report = join(root, `result-${phase}.json`);
      const log = join(root, `unity-${phase}.log`);
      assert.ok(existsSync(report), `session ${phase} produced no report: ${launchError ? String(launchError).slice(0, 500) : 'missing'}; ${existsSync(log) ? readFileSync(log, 'utf8').match(/.*(?:error CS|Error|Exception).*/g)?.slice(-6).join('\n') ?? '' : 'no log'}`);
      return JSON.parse(readFileSync(report, 'utf8'));
    };
    const first = await launch('a'); assert.equal(first.ok, true, first.error);
    const second = await launch('b');
    // The production symptom is the consuming stage rejecting the setup stage's own write, so this is the
    // assertion that carries it: it fails whenever a session cannot reproduce the baseline an earlier one saved.
    assert.equal(second.ok, true, `${second.error}; diag=${JSON.stringify(second.diag)}`);
    // Report the components, so a future failure names which one moved rather than only quoting the guard.
    assert.equal(second.diag.fileEqual, true, `the assembly-owned material's bytes moved between sessions: ${JSON.stringify(second.diag)}`);
    assert.equal(second.diag.metaEqual, true, `the assembly-owned material's .meta moved between sessions: ${JSON.stringify(second.diag)}`);
    // Pins the claim that chose this fix. If the file and its .meta are unchanged, the dependency hash must
    // not move either; a failure here means source identity cannot be compared across sessions at all, and the
    // comparison would have to drop that component and enumerate dependency files as identities instead.
    assert.equal(second.diag.dependencyEqual, true, `the dependency hash moved between sessions although neither file changed: ${JSON.stringify(second.diag)}`);
  });
