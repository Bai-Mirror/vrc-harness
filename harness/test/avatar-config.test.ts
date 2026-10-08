import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {parse} from 'yaml';
import {planSummary} from '../src/shared/plan-view.ts';
import {removeTemp} from './fixtures/platform.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const context = readFileSync(fileURLToPath(new URL('../builtin/knowledge/context/plan/avatar-config.md', import.meta.url)), 'utf8');
const example = parse(context.split('```yaml')[1]!.split('```')[0]!) as any;
test('selector domains use network quantization only for synchronized Float parameters', () => {
  const validate = (count: number, type: 'Float' | 'Int', synced: boolean) => {
    const instances = Array.from({length: count}, (_, n) => ({id: 'part_' + n, item: 'fixture', kind: 'accessory', prefab: 'Assets/Fixture.prefab'}));
    const config = {schema: 'avatar-config/0.1', instances, shared_switches: [], groups: [{id: 'selection', label: 'Selection', activation: 'exclusive',
      default: 'member_0', selector: type === 'Float' ? 'radial' : 'discrete', parameter: {name: 'Choice', type, saved: true, synced},
      members: instances.map(i => ({id: 'member_' + i.id.slice(5), instance: i.id, label: i.id}))}]};
    const result = spawnSync('python3', ['-c', 'import sys,json;sys.path.insert(0,sys.argv[1]);from avatar_config import validate;data=json.load(sys.stdin);validate(data,{"items":[{"item":"fixture","role":"other","prefabs":["Assets/Fixture.prefab"]}]})', tools],
      {input: JSON.stringify(config), encoding: 'utf8', env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}});
    return result;
  };
  for (const [count, type, synced, accepted] of [[128, 'Float', true, true], [129, 'Float', true, false], [129, 'Float', false, true],
    [256, 'Int', true, true], [257, 'Int', false, false]] as const) {
    const result = validate(count, type, synced); assert.equal(result.status === 0, accepted, result.stderr);
  }
});
function complete() {
  const p = structuredClone(example);
  return Object.assign(p, {body: 'body', body_prefab: 'Assets/Body.prefab', recolor: {targets: [{part: 'eye', hue_shift: 0, saturation: 1, value: 1}], candidates: 3},
    face: {mode: 'preserve'}, optimization: {mode: 'preserve'}});
}
test('accepted plan source contract covers all independent groups and retains same-product variants', t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-avatar-config-')); t.after(() => removeTemp(root));
  for (const path of ['_harness/intake', '_harness/plan']) mkdirSync(join(root, path), {recursive: true});
  const plan = complete();
  const items = new Map<string, any>(); items.set('body', {item: 'body', role: 'body', prefabs: ['Assets/Body.prefab']});
  for (const i of plan.avatar_config.instances) {
    const row = items.get(i.item) ?? {item: i.item, role: i.kind === 'outfit' ? 'outfit' : 'other', prefabs: []};
    row.prefabs.push(...new Set([i.prefab, ...(i.variants ?? []).map((v: any) => v.prefab)])); items.set(i.item, row);
  }
  const inventory = {schema: 'inventory/0.1', items: [...items.values()].map(i => ({...i, compatibility: '待骨骼比对', found: true, files: [{selected: true, name: i.item, sha256: 'fixture'}]}))};
  const bytes = JSON.stringify(inventory); writeFileSync(join(root, '_harness/intake/inventory.json'), bytes);
  writeFileSync(join(root, '_harness/intake/plan-catalog.json'), JSON.stringify({schema: 'plan-catalog/0.1', inventorySha256: createHash('sha256').update(bytes).digest('hex'), items: inventory.items, variants: []}));
  plan.obligations = inventory.items.map(i => ({input: i.item, role: i.role, action: 'use', target: i.item, due_stage: 'outfit'}));
  const output = join(root, 'observed.json');
  const observe = (p: any, script = join(tools, 'plan.py')) => {
    const r = spawnSync('python3', [script, 'observe', '--project', root, '--out', output], {encoding: 'utf8', env: {...process.env, AVH_PLAN: JSON.stringify(p), PYTHONDONTWRITEBYTECODE: '1'}});
    assert.equal(r.status, 0, r.stderr); return JSON.parse(readFileSync(output, 'utf8')).metrics.plan_source_contract_valid;
  };
  assert.equal(observe(plan), true);
  const pending = structuredClone(plan);
  for (const instance of pending.avatar_config.instances) instance.compatibility = 'pending_assembly';
  assert.equal(observe(pending), true, 'unknown compatibility authorizes trial assembly and retains every group and use obligation');
  const forged = structuredClone(pending); forged.avatar_config.instances[0].compatibility = 'verified';
  assert.equal(observe(forged), false, 'a plan cannot mint measured compatibility');
  const missingInstall = structuredClone(plan);
  const orphan = {item: 'independent-installer', role: 'other', prefabs: ['Assets/Installer.prefab'], found: true,
    compatibility: '待骨骼比对', files: [{selected: true, name: 'installer', sha256: 'fixture'}]};
  const expanded = JSON.stringify({...inventory, items: [...inventory.items, orphan]});
  writeFileSync(join(root, '_harness/intake/inventory.json'), expanded);
  writeFileSync(join(root, '_harness/intake/plan-catalog.json'), JSON.stringify({schema: 'plan-catalog/0.1', inventorySha256: createHash('sha256').update(expanded).digest('hex'), items: [...inventory.items, orphan], variants: []}));
  missingInstall.obligations.push({input: orphan.item, role: 'other', action: 'use', target: 'body', due_stage: 'outfit'});
  assert.equal(observe(missingInstall), false, 'an other input cannot be discharged by naming its carrier body');
  const carrierMutant = join(root, 'carrier-mutant.py'); copyFileSync(join(tools, 'avatar_config.py'), join(root, 'avatar_config.py'));
  writeFileSync(carrierMutant, readFileSync(join(tools, 'plan.py'), 'utf8').replace("if role == 'other' and item not in outfits:", 'if False:'));
  assert.equal(observe(missingInstall, carrierMutant), true, 'removing the own-instance guard reproduces the carrier false pass');
  writeFileSync(join(root, '_harness/intake/inventory.json'), bytes);
  writeFileSync(join(root, '_harness/intake/plan-catalog.json'), JSON.stringify({schema: 'plan-catalog/0.1', inventorySha256: createHash('sha256').update(bytes).digest('hex'), items: inventory.items, variants: []}));
  writeFileSync(join(root, '_harness/plan/draft.json'), JSON.stringify(plan));
  execFileSync('python3', [join(tools, 'plan.py'), 'submit', '--project', root, '--draft', '_harness/plan/draft.json']);
  assert.deepEqual(parse(readFileSync(join(root, '_harness/plan/plan.yaml'), 'utf8')), plan, 'approval bytes retain the new config, not a legacy rewrite');
  const mutations: Array<(p: any) => void> = [
    p => p.outfits = [], p => p.default_outfit = 'a_black', p => p.menu.selector = {type: 'radial'},
    p => p.avatar_config.groups[0].default = 'unknown', p => p.avatar_config.groups[1].members[0].instance = 'unknown',
    p => p.avatar_config.groups[1].members[0].id = 'a_black', p => p.avatar_config.groups[1].members[0].instance = 'dress_a',
    p => p.avatar_config.instances[0].prefab = 'Assets/Forged.prefab', p => p.avatar_config.instances[0].variants[1].prefab = 'Assets/Forged.prefab',
    p => p.avatar_config.groups[0].parameter.type = 'Bool', p => p.avatar_config.groups[1].parameter.name = p.avatar_config.groups[0].parameter.name,
    p => delete p.avatar_config.groups[2].members[0].default, p => p.avatar_config.groups[2].members[0].parameter.saved = 'true',
    p => p.menu.tree[0].children.pop(), p => p.menu.mode = 'preserve',
  ];
  for (const mutate of mutations) {const p = structuredClone(plan); mutate(p); assert.equal(observe(p), false);}
  const independent = structuredClone(plan); independent.avatar_config.instances = independent.avatar_config.instances.filter((i: any) => i.kind === 'accessory');
  independent.avatar_config.groups = [independent.avatar_config.groups[2]]; independent.menu.tree = [{group: 'accessories'}];
  independent.obligations = independent.obligations.map((o: any) => o.role === 'outfit' || o.role === 'other' && !independent.avatar_config.instances.some((i: any) => i.item === o.input)
    ? {input: o.input, role: o.role, action: 'defer', reason: 'independent-only fixture'} : o);
  assert.equal(observe(independent), true, 'independent-only config must not fall into preservation');
  const summary = planSummary(plan); assert.ok(summary.some(([k, v]) => k === '发型' && v.includes('连续轮盘'))); assert.ok(summary.some(([k, v]) => k === '配饰' && v.includes('默认关闭')));
  // Remove the actual group validator: the same false positive returns through the formal observer.
  copyFileSync(join(tools, 'avatar_config.py'), join(root, 'avatar_config.py'));
  const mutant = join(root, 'mutant.py'); writeFileSync(mutant, readFileSync(join(tools, 'plan.py'), 'utf8').replace("        avatar_config.validate(plan.get('avatar_config'), data)", '        pass'));
  const wrong = structuredClone(plan); wrong.avatar_config.groups[0].default = 'unknown'; assert.equal(observe(wrong, mutant), true);
});
