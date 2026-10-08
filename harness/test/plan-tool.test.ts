import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { removeTemp } from './fixtures/platform.ts';
import { loadProcess } from '../src/process/load.ts';
import { loadCapabilities, manifestToolReferences } from '../src/workflow/capabilities.ts';
import { compileContext, contextPlanText } from '../src/workflow/context-compiler.ts';
import { createHash } from 'node:crypto';
import { allowedTaskPath } from '../src/task-cli.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };

test('registered zip names retain actual candidates and AI submission is independently source-bound', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-plan-tool-')); t.after(() => removeTemp(root));
  const source = join(root, 'Avatar_v1.5.0.zip'), project = join(root, 'project');
  execFileSync('python3', ['-c', `import io,zipfile,tarfile,sys
with io.BytesIO() as buf:
 with tarfile.open(fileobj=buf,mode='w:gz') as package:
  for i in range(70):
   b=('Assets/ActualRoot/ActualRoot'+str(i)+'.prefab').encode();e=tarfile.TarInfo(str(i)+'/pathname');e.size=len(b);package.addfile(e,io.BytesIO(b))
 with zipfile.ZipFile(sys.argv[1],'w') as archive:archive.writestr('Avatar.unitypackage',buf.getvalue())`, source], { env });
  const manifest = { schema: 'manifest/0.1', request: '根据图片设计角色', assets: [{ item: source, name: 'Avatar_v1.5.0.zip', role: 'body', store: 'client' }] };
  const runEnv = { ...env, AVH_MANIFEST: JSON.stringify(manifest) };
  execFileSync('python3', [join(tools, 'intake.py'), '--library', root, '--project', project], { env: runEnv });
  const inventory = JSON.parse(readFileSync(join(project, '_harness/intake/inventory.json'), 'utf8'));
  assert.equal(inventory.body_key, 'avatar');
  assert.equal(inventory.items[0].prefabs.length, 70, 'name hints may not erase the real package paths');
  const run = (args: string[], extra = {}) => spawnSync('python3', [join(tools, 'plan.py'), ...args, '--project', project], { env: { ...runEnv, ...extra }, encoding: 'utf8' });
  const first = run(['inspect', '--limit', '24']); assert.equal(first.status, 0, first.stderr);
  const page = JSON.parse(first.stdout); assert.equal(page.candidates.length, 24); assert.equal(page.total, 70); assert.equal(page.nextOffset, 24);
  assert.equal(run(['inspect', '--limit', '65']).status, 1);
  const plan = { schema: 'plan/0.2', client_gallery: false, body: source, body_prefab: inventory.items[0].prefabs[0], outfits: [],
    obligations: [{ input: source, role: 'body', action: 'use', target: inventory.items[0].prefabs[0], due_stage: 'outfit' }],
    menu: { mode: 'preserve' }, recolor: { targets: [{ part: 'hair', hue_shift: 12, saturation: 1, value: 1 }], candidates: 3 },
    optimization: { mode: 'preserve' }, face: { mode: 'design', intent: '根据原图探索不同脸型' }, notes: '骨架和表情需后续实际导入观察' };
  const dir = join(project, '_harness/plan'); mkdirSync(dir); const draft = join(dir, 'draft.json');
  writeFileSync(draft, JSON.stringify(plan)); const submitted = run(['submit', '--draft', '_harness/plan/draft.json']);
  assert.equal(submitted.status, 0, submitted.stderr); assert.equal(JSON.parse(submitted.stdout).technicalFitVerified, false);
  const output = readFileSync(join(dir, 'plan.yaml'), 'utf8'); assert.deepEqual(parse(output), plan);
  const observed = join(root, 'observed.json');
  const observe = (value: unknown) => { const result = run(['observe', '--out', observed], { AVH_PLAN: JSON.stringify(value) }); assert.equal(result.status, 0); return JSON.parse(readFileSync(observed, 'utf8')).metrics.plan_source_contract_valid; };
  assert.equal(observe(plan), true);
  const forged = { ...plan, body_prefab: 'Assets/Guessed/Avatar.prefab' };
  assert.equal(observe(forged), false);
  writeFileSync(draft, JSON.stringify(forged)); assert.equal(run(['submit', '--draft', '_harness/plan/draft.json']).status, 1);
  assert.equal(readFileSync(join(dir, 'plan.yaml'), 'utf8'), output, 'rejected input must not replace the previous draft');
  assert.equal(observe({ ...plan, face: { ...plan.face, vertices: [0, 0, 0] } }), false);
  assert.equal(observe({ ...plan, recolor: { ...plan.recolor, candidates: 2 } }), false);
  assert.equal(observe({ ...plan, unused: [{ item: source, reason: 'overlap', note: 'already used' }] }), false);
  assert.equal(run(['inspect'], { AVH_MANIFEST: JSON.stringify({ ...manifest, request: 'changed source' }) }).status, 1);
  const catalogPath = join(project, '_harness/intake/plan-catalog.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  assert.equal(run(['observe-inputs', '--out', observed]).status, 0);
  assert.equal(JSON.parse(readFileSync(observed, 'utf8')).metrics.plan_input_catalog_ready, true);
  catalog.ready = true; catalog.items[0].prefabs = [];
  writeFileSync(catalogPath, JSON.stringify(catalog));
  assert.equal(run(['observe-inputs', '--out', observed]).status, 0);
  assert.equal(JSON.parse(readFileSync(observed, 'utf8')).metrics.plan_input_catalog_ready, false, 'a claimed ready flag is not independent source evidence');
  writeFileSync(join(project, '_harness/intake/inventory.json'), '{}'); assert.equal(run(['inspect']).status, 1);
});

test('active planning freezes the real helper and independent check with a compact stage-specific context', () => {
  const processPath = fileURLToPath(new URL('../builtin/knowledge/process/pc-recolor-outfit.process.yaml', import.meta.url));
  const thresholds = parse(readFileSync(fileURLToPath(new URL('../builtin/knowledge/process/thresholds.yaml', import.meta.url)), 'utf8'));
  const definition = loadProcess(readFileSync(processPath, 'utf8'), thresholds);
  const capabilities = loadCapabilities(readFileSync(fileURLToPath(new URL('../builtin/knowledge/process/pc-recolor-outfit.capabilities.yaml', import.meta.url)), 'utf8'), definition);
  assert.ok(definition.stages.find(s => s.id === 'plan')!.requires.includes('plan_source_contract'));
  assert.ok(definition.stages.find(s => s.id === 'intake')!.requires.includes('plan_inputs_ready'));
  assert.equal(capabilities.observers['plan.source']!.kind, 'command');
  assert.ok(manifestToolReferences(capabilities).includes('harness/plan.py'));
  assert.deepEqual(capabilities.stages.plan!.agentTools!.plan_evidence,
    ['python3', '{toolRoot}/harness/plan.py', 'evidence', '--config-tool', '{toolRoot}/harness/avatar_config.py', '--project', '{project}']);
  const context = capabilities.stages.plan!.context.map(spec => {
    const content = readFileSync(fileURLToPath(new URL('../builtin/knowledge/' + spec.path, import.meta.url)), 'utf8');
    return { spec, content, sha256: createHash('sha256').update(content).digest('hex') };
  });
  const result = compileContext(context, { plan: {}, manifest: {}, memory: { history: { failedStageIds: ['plan'] } } },
    { budgetChars: capabilities.stages.plan!.contextBudgetChars, modelFamily: 'deepseek-flash' });
  // This bound moves with the stage budget: 决定记录 D-116 makes the independent material axis mandatory
  // plan knowledge, alongside VPM, GUID dependencies and layered-source obligations; with all items,
  // the measured budget (23446) fits the assembled body exactly. The plan text is 24369 characters,
  // so 24370 is the smallest bound that admits it. Raise it only with the budget it mirrors.
  assert.ok(contextPlanText(result).length < 24370);
  assert.deepEqual(result.decisions.filter(item => item.disposition === 'out-of-budget'), [],
    'the plan budget must retain every applicable knowledge item');
  assert.ok(result.decisions.filter(item => item.required).every(item => item.selected),
    'every required knowledge item must reach the plan stage');
  assert.doesNotMatch(result.text, /const .*OutfitStage|k8a\.case|客户与同类工程的惯例/);
  assert.match(result.text, /plan_submit/);
  // The plan stage sits close to its budget, and the compiler drops a whole item rather than trimming one.
  // The obligation contract is what keeps a plan from promising work no stage proves, so it has to survive
  // the fit; losing it would make the plan stage fail a requirement the model was never told about.
  assert.match(result.text, /每个登记素材都要有一条处置/, 'the obligation contract must reach the plan stage');
  assert.match(result.text, /遗漏与沉默都不算处置/);
  // Which packages ship a layered working file decides whether "change only this part" can name a
  // layer instead of guessing from pixels. A knowledge section the compiler does not select is a
  // section the planner never reads, so its arrival in the compiled text is asserted, not assumed.
  assert.match(result.text, /分层源文件/, 'the layered-source rule must reach the plan stage');
  assert.match(result.text, /按层改色/);
  assert.match(result.text, /activation/);
  assert.match(result.text, /fixed/);
  assert.match(result.text, /没有读 prefab 内部或 PSD 层表/);
  assert.match(result.text, /evidence/);
  assert.match(result.text, /plan_evidence/);
  // 决定记录 D-120 defers the generated root-to-tip gradient, and an example that still offered a
  // gradient tier is how the planner could promise one this version cannot generate. The rule half is
  // asserted on the assembled text; the example half is asserted on the frozen item itself, because a
  // YAML comment inside that block is parsed as a heading, so the shade example does not reach the
  // assembled text at all and a text assertion would pass for the wrong reason.
  assert.match(result.text, /由程序生成的发根到发梢渐变本版不提供/, 'the deferred-gradient rule must reach the plan stage');
  assert.doesNotMatch(context.find(entry => entry.spec.id === 'plan.avatar-config')!.content,
    /shade_mixed|label: 渐变/, 'the material-axis example must not offer a gradient tier');
  assert.ok(result.text.length <= capabilities.stages.plan!.contextBudgetChars,
    `the plan context must fit its own budget: ${result.text.length} of ${capabilities.stages.plan!.contextBudgetChars}`);
});

test('the actual setup contract owns Unity preparation and IDE output without granting their paths to the provider', () => {
  const dir = new URL('../builtin/knowledge/process/', import.meta.url);
  const definition = loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml', dir), 'utf8'), parse(readFileSync(new URL('thresholds.yaml', dir), 'utf8')));
  const capabilities = loadCapabilities(readFileSync(new URL('pc-recolor-outfit.capabilities.yaml', dir), 'utf8'), definition);
  const setup = capabilities.stages.setup!;
  const project = join(tmpdir(), 'avh-setup-scope');
  for (const path of ['_harness/face/preparation.json', '.vsconfig']) {
    assert.equal(allowedTaskPath(path, setup.allowedWrites, project), false, 'the AI cannot grant itself runtime output writes');
    assert.equal(allowedTaskPath(path, [...setup.allowedWrites, ...setup.runtimeWrites!], project), true, 'the actual managed Unity result has its exact frozen path');
    assert.equal(allowedTaskPath(path, [...setup.allowedWrites, ...setup.runtimeWrites!.filter(p => p !== path)], project), false, 'omitting this runtime contract recreates the observed out-of-bounds failure');
  }
  assert.equal(allowedTaskPath('_harness/face/unowned.json', [...setup.allowedWrites, ...setup.runtimeWrites!], project), false);
  assert.equal(allowedTaskPath('.other-ide-config', [...setup.allowedWrites, ...setup.runtimeWrites!], project), false);
  assert.ok(setup.unitySteps!.some(step => step.method === 'AVH.Harness.SetupStage.Run'));
  assert.match(readFileSync(new URL('../builtin/tools/harness/unity/Editor/FaceStage.cs', import.meta.url), 'utf8'), /Avh\.WriteJson\(Avh\.Abs\("_harness\/face\/preparation\.json"\)/);
});
