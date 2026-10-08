import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { loadProcess } from '../src/process/load.ts';
import { loadCapabilities } from '../src/workflow/capabilities.ts';
import { compileContext } from '../src/workflow/context-compiler.ts';

const knowledge = fileURLToPath(new URL('../builtin/knowledge/', import.meta.url));
const read = (path: string) => readFileSync(join(knowledge, path), 'utf8');

// `extra` carries the facts beyond the plan (memory, manifest) that a test needs to reproduce a real run.
function compile(stage: string, plan: Record<string, unknown> = { outfits: [] }, extra: Record<string, unknown> = {}) {
  const process = loadProcess(read('process/pc-recolor-outfit.process.yaml'), parse(read('process/thresholds.yaml')));
  const capabilities = loadCapabilities(read('process/pc-recolor-outfit.capabilities.yaml'), process);
  const spec = capabilities.stages[stage]!;
  const items = spec.context.map(item => ({ spec: item, content: read(item.path),
    sha256: createHash('sha256').update(read(item.path)).digest('hex') }));
  const compiled = compileContext(items, { plan, manifest: {}, memory: {}, ...extra },
    { budgetChars: spec.contextBudgetChars, requiredCoverage: spec.contextCoverage });
  return { spec, compiled, capabilities };
}

test('assembled menu context selects the versioned executable contract instead of legacy limits', () => {
  const current = compile('menu', { schema: 'plan/0.3', avatar_config: { groups: [] } });
  assert.ok(current.compiled.decisions.some(d => d.id === 'menu.avatar-config' && d.selected && d.required));
  assert.ok(current.compiled.decisions.some(d => d.id === 'menu.flow.design-schema' && !d.selected));
  assert.match(current.compiled.text, /Float 配 radial，Int 配 discrete/);
  assert.match(current.compiled.text, /menu.*preserve_and_merge/);
  assert.doesNotMatch(current.compiled.text, /第二个轮盘|第二轮盘|换材质切换表达不了|固定生成一个 Float 衣装轮盘/);
  assert.match(current.spec.goal!, /生成合同只用于 plan\/0\.2/);
  const legacy = compile('menu', { schema: 'plan/0.2', outfits: [] });
  assert.ok(legacy.compiled.decisions.some(d => d.id === 'menu.flow.design-schema' && d.selected));
  assert.ok(legacy.compiled.decisions.some(d => d.id === 'menu.avatar-config' && !d.selected));
  assert.match(legacy.compiled.text, /固定生成一个 Float 衣装轮盘/);
});

test('every material-axis consumer receives the executable slot and preset contract', () => {
  for (const stage of ['plan', 'outfit', 'recolor', 'menu', 'regression_pre', 'regression', 'package']) {
    const {compiled} = compile(stage, {schema: 'plan/0.3', avatar_config: {groups: [{kind: 'material'}]}});
    assert.ok(/groups\[\]\.bindings/.test(compiled.text), stage + " lacks slot contract");
    assert.ok(/avatar_config\.material_presets/.test(compiled.text), stage + " lacks preset contract");
    assert.ok(/换发型不写发色参数/.test(compiled.text), stage + " lacks memory contract");
    // The deferred generated gradient (决定记录 D-120) is a contract every material-axis consumer needs:
    // a stage that never reads that the gradient tier is not provided is free to stand a pure colour in
    // for it. Asserted on the assembled text, so a section the compiler does not select fails here.
    assert.ok(/由程序生成的发根到发梢渐变本版不提供/.test(compiled.text), stage + " lacks the deferred-gradient contract");
    assert.doesNotMatch(compiled.text, /第二个轮盘|第二轮盘|换材质切换表达不了/, stage);
  }
});

test('the planning stage receives the executable vendor material form and its evidence boundary', () => {
  const { compiled, spec, capabilities } = compile('plan');
  assert.ok(compiled.decisions.some(d => d.id === 'plan.material-target' && d.selected));
  for (const text of ['requirement_id', 'outfit', 'material', '完整父目录相同', '零命中失败', '结构提交通过不等于计划可执行'])
    assert.ok(compiled.text.includes(text), text);
  assert.match(spec.goal!, /形态三：选厂商材质/);
  assert.match(spec.goal!, /四种目标形态/);
  // The region form is what a plan names when two surfaces on one texture have to be different colours and no
  // layer means "this eye". If the plan stage is not told it exists, the requirement cannot be declared at all.
  assert.match(spec.goal!, /形态四：按网格区域改色/);
  assert.match(spec.goal!, /骨名取自观察或该素体的知识条目/);
  assert.match(spec.goal!, /两个区域的足迹完全重叠时/);
  assert.ok(capabilities.stages.recolor!.unitySteps!.some(s => s.method === 'AVH.Harness.RecolorStage.MeasureMaterialTargets'));
});

// A knowledge section nobody selects is a section the stage never reads, and the compiler drops
// optional items once the budget is spent. Both failures are silent, so the rule that decides whether
// a colour change can name a region is asserted to arrive rather than assumed to have arrived.
test('the recolour stage is told that a region can come from the vendor layer or from the mesh', () => {
  const { compiled, capabilities } = compile('recolor');
  const selected = new Set(compiled.decisions.filter(d => d.selected).map(d => d.id));
  assert.ok(selected.has('recolor.layered-source'), 'the layered-source item must be selected');
  assert.match(compiled.text, /区域来自作者的层/, 'the region rule must reach the stage');
  assert.match(compiled.text, /区域来自网格 UV 足迹/, 'the mesh-UV region rule must reach the stage');
  assert.match(compiled.text, /不得去掉首尾空白后匹配/, 'the layer-path rule must reach the stage');
  assert.match(compiled.text, /shade/, 'both colour semantics must reach the stage');
  assert.match(compiled.text, /flat/);
  // Two regions that cannot be told apart must block rather than both be painted: that is the shape the
  // mirrored parts of this batch actually have (left and right UV coverage identical).
  assert.match(compiled.text, /两个区域共有的像素/);
  assert.match(compiled.text, /排他像素/);
  assert.match(compiled.text, /整条阻断/);
  assert.deepEqual(capabilities.stages.recolor!.agentTools!['inspect-layer-source'],
    ['python3', '{toolRoot}/harness/layer_source.py'], 'the stage must be able to reach the tool');
  // The capability is conditional on a dependency the product does not otherwise need, so each
  // stage that wants it must be able to ask whether it is available.
  assert.deepEqual(capabilities.stages.recolor!.agentTools!['check-layer-source-deps'],
    ['python3', '{toolRoot}/harness/layer_source.py', 'doctor'], 'the stage must be able to probe the dependency');
});

// A 391-character reference that explains how a PSD's layers are read was skipped for budget in a real
// run, and the stage then went looking for the PSD on disk instead. The conditions below fill the
// optional budget the way that run's facts did, so being selected there is a real requirement and not
// an accident of an empty fixture. The tool contract also forbids the unbounded search that followed.
test('the recolour stage always receives the PSD layer reading, even when the budget is full', () => {
  const facts = { memory: { project: {
    packageIds: ['jp.lilxyzw.liltoon', 'nadena.dev.ndmf'], identity: { base: 'Kipfel' } },
    history: { failedStageIds: ['recolor'] } } };
  const { compiled, capabilities } = compile('recolor', { outfits: [] }, facts);
  const decision = compiled.decisions.find(entry => entry.id === 'recolor.reports.psd-layers')!;
  assert.equal(decision.required, true, 'the PSD layer reading must not compete for the optional budget');
  assert.ok(decision.selected, `it must arrive even with a full budget: ${decision.reason}`);
  assert.match(compiled.text, /PSD 图层树：可见性、类型与包围框/);
  // Layered sources live inside the registered archive and are addressed by container + path, so the
  // stage must not walk the user's directories to find one.
  assert.match(capabilities.stages.recolor!.goal!, /不要对用户目录做无界递归查找/);
});

// The budget only drops optional items, so a stage whose optional items no longer fit still compiles
// and silently loses whatever fell off the end. Staying inside it is therefore a real requirement.
test('every stage context fits the budget it declares', () => {
  const process = loadProcess(read('process/pc-recolor-outfit.process.yaml'), parse(read('process/thresholds.yaml')));
  const capabilities = loadCapabilities(read('process/pc-recolor-outfit.capabilities.yaml'), process);
  const over: string[] = [];
  for (const [name, spec] of Object.entries(capabilities.stages)) {
    if (!spec) continue;
    const items = spec.context.map(item => ({ spec: item, content: read(item.path),
      sha256: createHash('sha256').update(read(item.path)).digest('hex') }));
    const compiled = compileContext(items, { plan: { outfits: [] }, manifest: {}, memory: {} },
      { budgetChars: spec.contextBudgetChars, requiredCoverage: spec.contextCoverage });
    if (compiled.usedChars > spec.contextBudgetChars) {
      over.push(`${name}: ${compiled.usedChars} > ${spec.contextBudgetChars}`);
    }
  }
  assert.deepEqual(over, [], 'a stage context must fit the budget it declares');
});
