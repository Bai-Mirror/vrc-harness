// D-138: the blocking check follows the measured visible overlap, so it must be wired to the outfit stage,
// be blocking, and treat a missing measurement as no_data rather than as zero overlaps.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { loadProcess } from '../src/process/load.ts';
import { loadCapabilities } from '../src/workflow/capabilities.ts';
import { evaluateRule, parseRule } from '../src/process/rule.ts';

const base = new URL('../builtin/knowledge/process/', import.meta.url);
const tool = fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/OutfitVisibility.cs', import.meta.url));
const process = loadProcess(readFileSync(new URL('pc-recolor-outfit.process.yaml', base), 'utf8'),
  parse(readFileSync(new URL('thresholds.yaml', base), 'utf8')));
const capabilities = loadCapabilities(readFileSync(new URL('pc-recolor-outfit.capabilities.yaml', base), 'utf8'), process);
const thresholds = parse(readFileSync(new URL('thresholds.yaml', base), 'utf8')) as { t: Record<string, { value: number; maturity: string }> };

test('the visible-overlap check is blocking on the outfit stage and a missing measurement is no data', () => {
  assert.ok(process.stages.find(stage => stage.id === 'outfit')!.requires.includes('outfit_visible_overlaps'));
  const check = process.checks.find(candidate => candidate.id === 'outfit_visible_overlaps')!;
  assert.equal(check.severity, 'blocking');
  assert.equal(check.observe, 'clothing.install');
  assert.equal(check.rule, 'visible_overlap_pairs == 0');
  assert.ok(capabilities.observers[check.observe], 'the observer must exist for this pack');
  const rule = parseRule(check.rule);
  assert.equal(evaluateRule(rule, { visible_overlap_pairs: 0 }, {}).result, 'pass');
  assert.equal(evaluateRule(rule, { visible_overlap_pairs: 2 }, {}).result, 'violation');
  assert.equal(evaluateRule(rule, {}, {}).result, 'no_data');
  assert.equal(evaluateRule(rule, { visible_overlap_pairs: null }, {}).result, 'no_data');
});

test('the calibrated overlap thresholds and the measuring tool state the same numbers', () => {
  const epsilon = thresholds.t.overlap_contact_epsilon_mm!;
  const minimum = thresholds.t.overlap_contact_min_cm2!;
  assert.equal(epsilon.value, 0.1);
  assert.equal(minimum.value, 1.0);
  assert.equal(epsilon.maturity, 'tested');
  assert.equal(minimum.maturity, 'tested');
  // The Unity tool cannot read the knowledge table, so the two statements of one number are compared here.
  const source = readFileSync(tool, 'utf8');
  const literal = (value: number) => Number.isInteger(value) ? `${value}.0` : `${value}`;
  assert.match(source, new RegExp(`EpsilonMm = ${literal(epsilon.value)}f;`));
  assert.match(source, new RegExp(`MinContactCm2 = ${literal(minimum.value)};`));
});

test('D-143: visible garment-through-garment interpenetration is blocking on the outfit stage, and a missing measurement is no data', () => {
  assert.ok(process.stages.find(stage => stage.id === 'outfit')!.requires.includes('outfit_visible_interpenetration'));
  const check = process.checks.find(candidate => candidate.id === 'outfit_visible_interpenetration')!;
  assert.equal(check.severity, 'blocking');
  assert.equal(check.observe, 'clothing.install');
  assert.equal(check.rule, 'visible_interpenetration_pairs == 0');
  assert.ok(capabilities.observers[check.observe], 'the observer must exist for this pack');
  const rule = parseRule(check.rule);
  assert.equal(evaluateRule(rule, { visible_interpenetration_pairs: 0 }, {}).result, 'pass');
  assert.equal(evaluateRule(rule, { visible_interpenetration_pairs: 1 }, {}).result, 'violation');
  assert.equal(evaluateRule(rule, {}, {}).result, 'no_data');
  assert.equal(evaluateRule(rule, { visible_interpenetration_pairs: null }, {}).result, 'no_data');
  // The minimum is the calibrated one, and the Unity tool states the same number.
  const minVertices = thresholds.t.visible_interpenetration_min_vertices!;
  assert.equal(minVertices.maturity, 'tested');
  const source = readFileSync(tool, 'utf8');
  assert.match(source, new RegExp(`MinVisibleInterpenetrationVertices = ${minVertices.value};`));
  // The layer test is stated with its reach and its majority ratio, in code and in the record.
  assert.match(source, /LayerReachMm = 1\.0f;/);
  assert.match(source, /InnerMajorityRatio = 0\.5;/);
  // The new reading must not be manufactured by relaxing D-139's body criterion.
  assert.equal(process.checks.find(candidate => candidate.id === 'regression_body_piercing')!.rule, 'fit_pierced_vertices == 0');
  // D-146 ①: the body criterion applies the same noise gate, taken from that one statement of the number
  // rather than restated as a second literal in the fit stage.
  const fitStage = readFileSync(fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/HarnessFitStage.cs', import.meta.url)), 'utf8');
  assert.match(fitStage, /OutfitVisibility\.MinVisibleInterpenetrationVertices/,
    'the fit stage must read the noise gate from the one statement of the number');
  assert.doesNotMatch(fitStage, /[Gg]ate\s*=\s*8\s*;/,
    'the fit stage must not restate the noise gate as a literal');
});

test('the orderer\'s direction: the Runtime presents evidence and requires a decision; only overreach is blocked', () => {
  // The guard rails are coarse numbers, stated once in the knowledge table and once in the Unity tool.
  const guardDepth = thresholds.t.visible_interpenetration_guard_depth_mm!;
  const guardVertices = thresholds.t.visible_interpenetration_guard_vertices!;
  assert.equal(guardDepth.maturity, 'tested');
  assert.equal(guardVertices.maturity, 'tested');
  const source = readFileSync(tool, 'utf8');
  const literal = (value: number) => Number.isInteger(value) ? `${value}.0` : `${value}`;
  assert.match(source, new RegExp(`GuardVisibleInterpenetrationDepthMm = ${literal(guardDepth.value)}f;`));
  assert.match(source, new RegExp(`GuardVisibleInterpenetrationVertices = ${guardVertices.value};`));
  // The reading requires a decision per candidate pair and counts the two ways that can go wrong; the depth
  // distribution and the hair role are evidence now, never a filter that decides for the executor.
  assert.match(source, /pair\.Counted = true;/, 'an unsettled pair must stay counted');
  assert.match(source, /result\.OutOfBoundsAccepted\+\+/, 'an out-of-bounds accept must be counted apart');
  assert.match(source, /pair\.OutOfBounds = pair\.DepthMaxMm > GuardVisibleInterpenetrationDepthMm/);
  assert.match(source, /\|\| pair\.DepthAtLeast/, 'a depth that only reached the measurement ceiling is out of bounds');
  assert.match(source, /"close" => CloseReject\(pair\.Layer, closures\)/);
  assert.match(source, /"accept" => AcceptReject\(row, pair\)/);
  assert.match(source, /"ask_user" => AskReject\(row\)/);
  assert.doesNotMatch(source, /MinVisibleInterpenetrationDepthMm/, 'the depth threshold is evidence, not a gate');
  // The role of a source is the product's own taxonomy, not a name pattern in the tool.
  const taxonomy = readFileSync(fileURLToPath(new URL('../src/assets/taxonomy.ts', import.meta.url)), 'utf8');
  const hairPath = taxonomy.match(/\{ id: 'hair', path: '([^']+)' \}/)![1];
  assert.ok(source.includes(`("${hairPath}", "hair")`), 'the order-role table must carry the taxonomy\'s hair path');
  assert.match(source, /认不出这些来源在订单里的角色|都认不出/, 'an unresolved role must be said out loud');
  // The criterion itself is unchanged: the two classes are summed into it and it must be zero.
  assert.equal(process.checks.find(candidate => candidate.id === 'outfit_visible_interpenetration')!.rule, 'visible_interpenetration_pairs == 0');
  // The pairs handed to the user are an observation, never a gate: an advisory whose rule is `>= 0` can never
  // fail, so it was removed and the count stays in the reading (`visible_interpenetration_ask_user`).
  assert.ok(!process.checks.some(candidate => candidate.id === 'outfit_interpenetration_handed_to_user'));
  assert.ok(!process.stages.find(stage => stage.id === 'outfit')!.requires.includes('outfit_interpenetration_handed_to_user'));
  assert.match(source, /visible_interpenetration_ask_user/);
  // GI2: the depth statement's range is stated in the knowledge table too. It is NOT widened past the calibrated
  // census band: a wider nearest-triangle sweep read a hem and a boot interior as deep pokes on A (0 -> 23
  // blocking pairs), so a pair whose deepest sample only reaches the range is a lower bound, not a measurement.
  const pokeReach = thresholds.t.visible_interpenetration_poke_reach_mm!;
  assert.equal(pokeReach.maturity, 'tested');
  assert.match(source, new RegExp(`public const float PokeReachMm = ${literal(pokeReach.value)}f;`));
  assert.ok(pokeReach.value <= thresholds.t.visible_interpenetration_guard_depth_mm!.value,
    'the depth range must not be widened past the guard it cannot justify');
  assert.match(source, /if \(squared <= ReachSqr\)/, 'the layer-order census must stay on the calibrated near band');
  assert.match(source, /pair\.DepthAtLeast = /, 'a ceiling reading must be marked as a lower bound');
  assert.match(source, /pair\.DepthAtLeast\b[\s\S]*?\|\| pair\.Confirmed > GuardVisibleInterpenetrationVertices/,
    'a depth that only reached the range must still stop an accept');
  // The knowledge states the criteria and the orderer's three examples, not a checklist.
  const context = readFileSync(fileURLToPath(new URL('../builtin/knowledge/context/outfit/默认显隐与重叠取舍.md', import.meta.url)), 'utf8');
  for (const phrase of ['interpenetration_decisions', 'ask_user', '护栏', '准则', '薄薄一层', '同一部位重复', '发型'])
    assert.ok(context.includes(phrase), `the knowledge must state ${phrase}`);
  assert.match(capabilities.stages.outfit!.goal!, /interpenetration_decisions/);
  assert.match(capabilities.stages.outfit!.goal!, /ask_user/);
});

test('D-143 ③: the three decisions are recorded, checked against the measurement, and reach the receipt', () => {
  // The decision lives in the recipe as `interpenetration_decisions`; its schema is in the operation tool, its
  // reader in the visibility tool, and the pair it names must be exactly the pair the reading confirmed.
  const operations = readFileSync(fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/LocalOperations.cs', import.meta.url)), 'utf8');
  assert.match(operations, /"interpenetration_decisions"\)/);
  assert.match(operations, /decision != "close" && decision != "accept" && decision != "ask_user"/);
  assert.match(operations, /objects\.Count != 2/, 'a decision names exactly two parts');
  assert.match(operations, /public static List<Dictionary<string, object>> RecordedDecisions\(\)/);
  const visibility = readFileSync(tool, 'utf8');
  assert.match(visibility, /Names\(row\.List\("objects"\)\.Select/, 'a decision only settles the pair it names');
  assert.match(visibility, /if \(!pair\.DecisionValid\)/, 'a decision that does not fit the measurement settles nothing');
  // The blocking rule stays exactly as it was: a decision moves a pair OUT of it, it never relaxes the rule.
  assert.equal(process.checks.find(candidate => candidate.id === 'outfit_visible_interpenetration')!.rule, 'visible_interpenetration_pairs == 0');
});

test('GI2: the dependency observation is written before the visibility measurement, and moving it back fails', () => {
  // A proved this the hard way, and it is an order invariant, not a property of the artifact: the render
  // confirmation installs its own id/depth materials on the renderers while it runs, so a walk taken after it
  // reported broken GUID references the artifact never had (4 with the reading, 0 with the order right, one
  // artifact, two tool sets). The synthetic fixture restores every material and therefore cannot reproduce that
  // stale handle, so the order is pinned here: a source-level check plus the mutation that moves the walk back.
  const stage = readFileSync(fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/OutfitStage.cs', import.meta.url)), 'utf8');
  const from = stage.indexOf('public static void WriteAvatar(');
  const to = stage.indexOf('static readonly HumanBodyBones[] Trunk');
  assert.ok(from >= 0 && to > from, 'the Observe path must be locatable');
  const body = stage.slice(from, to);
  const walkFirst = (source: string) => {
    const walk = source.indexOf('EffectiveReferences.WriteObservation(avatar)');
    const measure = source.indexOf('Visibility(avatar, record, metrics, notes)');
    return walk >= 0 && measure >= 0 && walk < measure;
  };
  assert.ok(walkFirst(body), 'the dependency observation must be written before the visibility measurement');
  const walk = 'OutfitPerf.Time("Observe.WriteObservation", () => EffectiveReferences.WriteObservation(avatar));';
  const measurement = 'Visibility(avatar, record, metrics, notes);';
  const swapped = body.replace(walk + '\n                ' + measurement, measurement + '\n                ' + walk);
  assert.notEqual(swapped, body, 'the mutation must actually swap the two calls');
  assert.equal(walkFirst(swapped), false, 'moving the observation after the measurement must fail this check');
});

// KF1: the outfit knowledge and the stage goal may name only the decision channels and fields some tool
// really has. The removed acknowledgement channel is the case in point: the old knowledge sentence wrote the
// pair into a `user_review` item as `acknowledge`, but LocalOperations.cs refuses any item key beyond
// question/detail/options, so a recipe written that way is rejected outright, not merely judged red.
const outfitKnowledge = fileURLToPath(new URL('../builtin/knowledge/context/outfit/默认显隐与重叠取舍.md', import.meta.url));
function toolSource() {
  const root = fileURLToPath(new URL('../builtin/tools/', import.meta.url));
  const read = (dir: string): string => readdirSync(dir, { withFileTypes: true })
    .map(entry => entry.isDirectory() ? read(join(dir, entry.name)) : readFileSync(join(dir, entry.name), 'utf8'))
    .join('\n');
  return read(root);
}

test('KF1: the outfit knowledge and goal name only channels and fields the tool really has', () => {
  const source = toolSource();
  const context = readFileSync(outfitKnowledge, 'utf8');
  const goal = capabilities.stages.outfit!.goal!;
  // A check id is named by the process definition; every other lower_snake token in the two documents must be
  // a field some tool really writes or reads. `acknowledge` carries no underscore, so it is checked by name.
  const checkIds = new Set(process.checks.map(candidate => candidate.id));
  const vocabulary = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;
  const invented = (text: string) => [...new Set(text.match(vocabulary) ?? [])]
    .filter(token => !source.includes(token) && !checkIds.has(token)).sort();
  const acknowledgement = (text: string) => /acknowledg/i.test(text);
  assert.deepEqual(invented(context), [], 'the knowledge names a channel or field no tool has');
  assert.deepEqual(invented(goal), [], 'the outfit goal names a channel or field no tool has');
  assert.ok(!acknowledgement(context) && !acknowledgement(goal),
    'the removed acknowledgement channel must not be named anywhere');
  // The fields that replaced it must be stated where the executor reads them, not merely absent from a stale
  // sentence: a deleted clause would otherwise leave both documents silent and still pass.
  const fields = ['counted_pairs', 'undecided_pairs', 'out_of_bounds_accepted_pairs', 'ask_user_pairs',
    'decision', 'decision_valid', 'decision_note', 'interpenetration_decisions', 'user_review',
    // D-148/D-149: the numbered trade-off's own channels and the order role the accessory criterion reads.
    'recommended', 'current', 'label', 'review', 'role'];
  for (const field of fields) {
    assert.ok(source.includes(field), `no tool states ${field}`);
    assert.ok(context.includes(field), `the knowledge must state ${field}`);
    assert.ok(goal.includes(field), `the outfit goal must state ${field}`);
  }
  // Mutation: the sentence KF1 replaced. Putting the old acknowledgement instruction back must fail.
  const replaced = context.match(/^- \*\*里层那件是订单点名要露出的\*\*：.*$/m)?.[0] ?? '';
  assert.ok(replaced.includes('interpenetration_decisions'), 'the replacement sentence must be locatable');
  const legacy = '- **里层那件是订单点名要露出的**：衣物之间的互穿要关掉里层那件时，先看订单是不是点名要它露出；是就不要自己关——保留它，并把两件、部位与保留理由写进 `user_review` 那一条的 `acknowledge` 记录（下面「衣物之间看得见的互穿」一节给了字段），这一对就记为已交代、不再阻断。';
  const mutatedContext = context.replace(replaced, legacy);
  assert.notEqual(mutatedContext, context, 'the mutation must replace the sentence');
  assert.ok(acknowledgement(mutatedContext), 'the old acknowledgement sentence must fail this check');
  // Mutation: the goal's old acknowledged_pairs and the advisory GI2 removed.
  const clause = '；一节顶部还给出 `counted_pairs`（仍在阻断的对数）、`undecided_pairs`、`out_of_bounds_accepted_pairs`、`ask_user_pairs`，逐对有 `decision`／`decision_valid`／`decision_note`';
  assert.ok(goal.includes(clause), 'the goal replacement must be locatable');
  const legacyClause = '；同一节还给出 acknowledged_pairs 与逐对的 acknowledged/body_part，另有一条非阻断读数 `outfit_interpenetration_acknowledged` 记你交代给用户的那些对';
  const mutatedGoal = goal.replace(clause, legacyClause);
  assert.notEqual(mutatedGoal, goal, 'the mutation must replace the clause');
  assert.deepEqual(invented(mutatedGoal), ['acknowledged_pairs', 'outfit_interpenetration_acknowledged'],
    'the old goal clause must fail this check');
});

test('KF1: the outfit stage gets four check retries for a loop that needs three, and states the closing criterion', () => {
  // D-138/D-145 on A: (1) too many stacking and interpenetration candidates read as no_data, (2) closing the
  // stacking leaves the interpenetration pairs to decide, (3) passes. Two retries allowed exactly those three
  // attempts and left no margin; GI1 measured one missed pair on a run that reached the end of them.
  const fourRetries = (value: number | undefined) => value === 4;
  assert.ok(fourRetries(capabilities.stages.outfit!.maxCheckRetries));
  assert.equal(fourRetries(2), false, 'the old value of two retries must fail this check');
  const raw = readFileSync(new URL('pc-recolor-outfit.capabilities.yaml', base), 'utf8');
  const comment = raw.slice(raw.indexOf('本接口没有网格捏脸'), raw.indexOf('maxCheckRetries: 4'));
  assert.match(comment, /no_data/, 'the retry comment must say which pass reads no_data');
  assert.match(comment, /GI1/, 'the retry comment must name the measurement that showed the margin was gone');
  // KF1 ④: before closing an inner layer, look whether the body is directly under the outer one; if so prefer
  // accept or ask_user, because closing can expose body piercing in the regression stage (PF4/GI2 measured two
  // vertices under the collar on A after the chest layer was closed).
  const context = readFileSync(outfitKnowledge, 'utf8');
  const criterion = '⑤ 关掉贴身里层之前，先看它外面那层下面是不是直接就是身体';
  assert.ok(context.includes(criterion), 'the knowledge must state the new criterion');
  assert.ok(capabilities.stages.outfit!.goal!.includes('关掉贴身里层之前'), 'the goal must carry the criterion');
  const mutated = context.replace(criterion, '⑤ 按正常观看距离看不出来');
  assert.notEqual(mutated, context, 'the mutation must drop the criterion');
  assert.ok(!mutated.includes(criterion), 'without the criterion this check fails');
});

// D-148: a trade-off handed to the user is one numbered item with 2–4 executable options, exactly one
// recommendation and the option the recipe really used. The Runtime refuses a recipe it could not execute or
// render (exercised on the real call path in the Unity fixture); this test pins the contract in the tool, the
// knowledge and the stage goal together, and mutating each of the three must fail it.
test('D-148: a trade-off handed to the user carries a number, options, one recommendation and the current one', () => {
  const operations = readFileSync(fileURLToPath(new URL('../builtin/tools/harness/unity/Editor/LocalOperations.cs', import.meta.url)), 'utf8');
  // Every field the delivery note renders and the rework feedback reads has to exist in the tool that refuses
  // the recipe, not only in the prose.
  for (const field of ['"id"', '"label"', '"operations"', '"recommended"', '"current"', '"review"'])
    assert.ok(operations.includes(field), `no tool states ${field}`);
  // The five refusals the orderer asked for, one rule each: option count, an unobserved object, a
  // non-recoverable operation, more than one recommendation, and a current option that is not what the recipe did.
  const rules: [string, string][] = [
    ['options.Count < 2 || options.Count > 4', '必须有 2–4 个方案'],
    ['!observed.Contains(path)', '引用的对象不在观察内'],
    ['!Recoverable(operation)', '只能用可恢复操作'],
    ['recommended == null || !optionIds.Contains(recommended)', '必须恰好推荐一个方案'],
    ['当前方案与配方不符', '当前方案与配方不符'],
  ];
  for (const [code, message] of rules) {
    assert.ok(operations.includes(code), `the Runtime must refuse with: ${code}`);
    assert.ok(operations.includes(message), `the refusal must say: ${message}`);
  }
  // The options live in exactly one place: a pair kept for the user points at the number instead of restating them.
  assert.match(operations, /row\.Str\("decision"\) != "ask_user"[\s\S]*?review == null \|\| !known\.Contains\(review\)/,
    'an ask_user must name an existing numbered trade-off');
  const knowledge = readFileSync(outfitKnowledge, 'utf8');
  const goal = capabilities.stages.outfit!.goal!;
  for (const field of ['recommended', 'current', 'label', 'review', 'object_state'])
    for (const [name, text] of [['knowledge', knowledge], ['goal', goal]] as const)
      assert.ok(text.includes(field), `the ${name} must state ${field}`);
  // The executor is told to answer by number on rework, and to leave the untouched trade-offs alone.
  for (const [name, text] of [['knowledge', knowledge], ['goal', goal]] as const) {
    assert.match(text, /选 [A-Z]|Tn 选 X|选 B/, `the ${name} must tell the user to answer by number`);
    assert.match(text, /其余取舍保持不变|其他取舍保持不变/, `the ${name} must keep the untouched trade-offs`);
  }
  // Mutation: putting the old unnumbered sentences back must fail, because a choice with no number has no
  // options a rework feedback could name and no current option to compare against the recipe.
  const numbered = knowledge.match(/^- \*\*每个要用户看的取舍都编号、带可执行方案\*\*：.*$/m)?.[0] ?? '';
  const rework = knowledge.match(/^- \*\*重做意见里写了编号就照那条方案执行\*\*：.*$/m)?.[0] ?? '';
  assert.ok(numbered.includes('recommended') && rework.includes('current'), 'the numbered sentences must be locatable');
  const mutation = knowledge.replace(numbered,
    '- **每个要用户看的取舍都写清**：一段一件，用 `{question, detail, options}` 三个字段；三段都用简体中文，用户看得懂。')
    .replace(rework, '- **重做意见照办**：按用户写的意思重新判断。');
  assert.notEqual(mutation, knowledge, 'the mutation must replace the numbered sentences');
  assert.ok(!mutation.includes('recommended') && !mutation.includes('current'),
    'without the numbered sentences this check fails');
  // Mutation: the Runtime's option-count rule removed leaves the refusal unproven.
  const loose = operations.replace('if (options.Count < 2 || options.Count > 4)', 'if (false)');
  assert.notEqual(loose, operations, 'the mutation must drop the option-count rule');
  assert.equal(loose.includes('options.Count < 2 || options.Count > 4'), false, 'the rule must be the thing under test');
});

// D-149: the orderer's direction is that an accessory set yields to the main clothing, and that the role of a
// source is read from the plan and the intake record rather than guessed from a name. Knowledge, goal and the
// evidence the visibility record carries have to say the same thing.
test('D-149: an accessory set yields to the main clothing, and the role comes from the declared evidence', () => {
  const knowledge = readFileSync(outfitKnowledge, 'utf8');
  const goal = capabilities.stages.outfit!.goal!;
  const criterion = '配饰套装里的服装件让位';
  for (const [name, text] of [['knowledge', knowledge], ['goal', goal]] as const) {
    assert.ok(text.includes(criterion), `the ${name} must state the accessory-yields criterion`);
    assert.match(text, /配饰/, `the ${name} must name the accessory role`);
    assert.match(text, /头饰|链饰|刀具/, `the ${name} must keep the pure accessory parts`);
    assert.match(text, /role/, `the ${name} must say the role is read, not guessed`);
  }
  // The orderer's own example uses outfit roles and set relationships, not product names.
  assert.match(knowledge, /订单把一整套列为服装、另一整套列为配饰[\s\S]{0,200}配饰套装里的裙子与高跟鞋/,
    'the knowledge must carry the orderer\'s generic example');
  // The role travels as evidence in the visibility record, next to the parts it decides about.
  const visibility = readFileSync(tool, 'utf8');
  assert.match(visibility, /\["source"\] = group\.Key,\n\s+\["role"\] = RoleOf\(roles, group\.First\(\)\.Path\)/,
    'the by-body-part evidence must carry each source\'s role');
  assert.match(visibility, /static List<object> BodyPartSections\(List<Entry> entries, Dictionary<string, string> roles\)/,
    'the part summary must be handed the resolved roles');
  // Mutation: dropping the role from the evidence leaves the accessory criterion with nothing to read.
  const mutated = visibility.replace('["role"] = RoleOf(roles, group.First().Path),', '');
  assert.notEqual(mutated, visibility, 'the mutation must drop the role from the evidence');
  assert.ok(!/\["role"\] = RoleOf/.test(mutated), 'without the role this check fails');
});
