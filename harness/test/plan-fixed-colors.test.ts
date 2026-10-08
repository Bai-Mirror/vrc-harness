import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const tool = fileURLToPath(new URL('../builtin/tools/harness/plan.py', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;

// A plan can pass every structural check while acknowledging a hard requirement in prose and never
// promising it anywhere a later stage can act on. That is what happened to a real plan: the order named
// three fixed colours with restricted surfaces, the plan carried relative adjustments only, the codes
// lived in `notes`, and no check could tell the difference. These four cases pin the check that can.
test('a fixed colour named by the order is only addressed by something executable', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-plan-colors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '_harness/intake'), { recursive: true });
  // The order writes its colours bare, and also carries an identifier that must not be mistaken for one.
  writeFileSync(join(root, '_harness/intake/需求.md'),
    '# 需求\n奶白 FAF3EE 主色、樱粉 F2AFC6 辅色、深灰 5B5B66 仅用于睫毛。商品号 7751175，订单 1A2B3C4D。\n');
  writeFileSync(join(root, '_harness/intake/inventory.json'),
    JSON.stringify({ schema: 'inventory/0.1', items: [{ item: '1A2B3C4D', role: 'body' }] }));

  const unaddressed = (plan: unknown) => execFileSync('python3', ['-c', `import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import plan as p
plan = json.loads(sys.argv[2])
print(json.dumps(p.fixed_colors_addressed(plan, Path(sys.argv[3]))))
`, join(tool, '..'), JSON.stringify(plan), root], { encoding: 'utf8' }).trim();

  const layer = (color: string) => ({ requirement_id: 'lash', layered: 'Body/PSD/Face.psd', layer: ['eyelash '], color, semantics: 'flat' });

  // 1. Nothing addressed: all three are prose, and the identifier is not counted as a colour.
  assert.deepEqual(JSON.parse(unaddressed({ recolor: { targets: [] } })), ['FAF3EE', 'F2AFC6', '5B5B66']);

  // 2. One addressed by a layered target: the other two are still owed.
  assert.deepEqual(JSON.parse(unaddressed({ recolor: { targets: [layer('#5B5B66')] } })), ['FAF3EE', 'F2AFC6']);

  // 3. All three addressed: nothing owed. The '#RRGGBB' spelling counts the same as the bare one.
  assert.deepEqual(JSON.parse(unaddressed({ recolor: { targets: [layer('#5B5B66'), layer('#FAF3EE'), layer('#F2AFC6')] } })), []);

  // 4. An order with no colours owes nothing, so the check cannot block it for the wrong reason.
  writeFileSync(join(root, '_harness/intake/需求.md'), '# 需求\n把这件衣服做成客户想要的样子。\n');
  assert.deepEqual(JSON.parse(unaddressed({ recolor: { targets: [] } })), []);

  // 5. A colour declared as an unmet deviation is accounted for, so the check does not punish a plan for
  //    registering its shortfalls instead of inventing targets for them — the behaviour it exists to elicit.
  writeFileSync(join(root, '_harness/intake/需求.md'), '# 需求\n奶白 FAF3EE 主色、樱粉 F2AFC6 辅色。\n');
  assert.deepEqual(JSON.parse(unaddressed({ recolor: { targets: [] } })), ['FAF3EE', 'F2AFC6']);
  const declared = { recolor: { targets: [] }, deviations: [
    { requirement: '奶白 FAF3EE 主色、樱粉 F2AFC6 辅色', why: '该外套无分层源', stands_in_for: '整体相对偏移，不承诺精确',
      needs_orderer_acceptance: true }] };
  assert.deepEqual(JSON.parse(unaddressed(declared)), [], 'a declared shortfall is not a silent omission');
});
