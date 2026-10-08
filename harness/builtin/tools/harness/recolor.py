#!/usr/bin/env python3
# 【项目沉淀】通用工具（Harness 能力：material.recolor 的配方，recolor 阶段）
# 适用素体：无关
# 工具链　：python3 标准库
# 可复用性：★★★ 换个单子直接能用
# 用途　　：从已批准方案的 recolor 段算出候选档（SOP 40 步骤 4：3～5 档，每条从原件起算），按用户的修改意见选定一档，
#           写 Assets/_Harness/Recolor/recipe.json。只算参数、不碰材质；同一方案与意见重跑，输出逐字节相同。
#           随后 Unity 步骤按配方复制材质、出同机位候选图、落定选中档。
# 用法　　：recolor.py   （工程取 AVH_PROJECT_DIR，方案取 AVH_PLAN，重做意见取 AVH_FEEDBACK）
"""Recolor recipe: candidate tiers derived from the approved plan, and the tier the user chose."""
import json
import os
import re
import sys
from pathlib import Path

# The three-form classification, the shared requirement_id rule and the material target's shape live
# in plan.py, which is the gate these targets normally come through. They are imported rather than
# copied because this entry point cannot lean on that gate having run: recolor.py is a command of its
# own, and the observer (observe_recolor.py) re-runs build_recipe over the stored plan.
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
from plan import (  # noqa: E402  (the path has to be set up before the sibling tool is importable)
    HEX_COLOR, LAYER_SEMANTICS, RECOLOR_LAYER_FIELDS, RECOLOR_REGION_FIELDS, claim_requirement_id,
    classify_recolor_targets, validate_material_target, validate_region_target)
from avatar_config import material_axis  # noqa: E402

RECIPE = 'Assets/_Harness/Recolor/recipe.json'
LETTERS = 'ABCDE'
# 档位：A 是方案原值，其余围绕它变化；参数集中在这里，改一个数能重跑。
TIERS = [
    ('A', '方案原值', 1.0, 1.0, 1.0),
    ('B', '收敛（变化减半）', 0.5, 0.5, 1.0),
    ('C', '加强（变化 1.5 倍）', 1.5, 1.5, 1.0),
    ('D', '低饱和', 1.0, 1.0, 0.85),
    ('E', '高饱和', 1.0, 1.0, 1.15),
]
CHOICE = re.compile(r'(?:候选|档|选|candidate|tier)\s*([A-Ea-e1-5])|^\s*([A-Ea-e1-5])\s*(?:档)?\s*$')
# 按层目标的字段与语义来自 plan.py（同一条契约，不再抄一份）；这里只保留记录方式（决定记录 D-73/D-75/D-81）。
# The form predicates that used to live here are gone with the copy: `classify_recolor_targets` in
# plan.py decides all three forms, so there is one answer to "which form is this target".


def layer_ops(targets, seen):
    """The layer targets, validated and passed through unchanged.

    They are **not** scaled by any tier. A fixed colour is the requirement itself, so a candidate that
    shifted it would be a candidate that violates the order, and choosing between candidates cannot
    grant permission to change a frozen requirement (决定记录 D-78).

    `seen` is shared with the material ops so a requirement_id claimed by one form is refused when
    another form claims it again.
    """
    ops = []
    for target in targets:
        if set(target) != RECOLOR_LAYER_FIELDS:
            raise ValueError(f'按层目标字段不对：{sorted(target)}')
        claim_requirement_id(target, seen, 'layer')
        path = target['layer']
        if not isinstance(path, list) or not path or not all(isinstance(name, str) and name.strip() for name in path):
            raise ValueError(f"按层目标的层路径无效：{target['requirement_id']}")
        if not HEX_COLOR.match(str(target['color'])):
            raise ValueError(f"按层目标的颜色要写成 #RRGGBB：{target['color']}")
        if target['semantics'] not in LAYER_SEMANTICS:
            raise ValueError(f"按层目标的语义只能是 shade 或 flat：{target['semantics']}")
        ops.append({'requirement_id': target['requirement_id'], 'layered': target['layered'],
                    'layer': list(path), 'color': str(target['color']).upper(), 'semantics': target['semantics']})
    return ops


def region_ops(targets, seen):
    """The region targets, validated and passed through unchanged.

    A region names a place on the mesh — a renderer, one of its submeshes and the bones that hold the
    surface — and the Unity step derives that surface's exact UV footprint. The recipe cannot carry the
    mask itself: the mesh only exists inside the editor, and planning happens before it is observed. So
    the recipe carries the declaration and the stage that has the mesh resolves it, which is the same
    division the layer form uses when it records a layer path rather than pixels.

    Like the layer operations, these are **not** scaled by any tier: the colour is the requirement, and a
    candidate that shifted it would be a candidate that violates the order (决定记录 D-78).
    """
    ops = []
    for target in targets:
        if set(target) != RECOLOR_REGION_FIELDS:
            raise ValueError(f'区域目标字段不对：{sorted(target)}')
        validate_region_target(target)
        claim_requirement_id(target, seen, 'region')
        region = target['region']
        ops.append({'requirement_id': target['requirement_id'],
                    'region': {'renderer': region['renderer'], 'submesh': int(region['submesh']),
                               'bones': [str(bone) for bone in region['bones']]},
                    'color': str(target['color']).upper(), 'semantics': target['semantics']})
    return ops


def clamp(value, low, high):
    return max(low, min(high, value))


def scaled(target, hue_factor, change_factor, saturation_factor):
    """One tier's adjustment for one part: the plan's change scaled around 'no change', then clamped."""
    hue = clamp(float(target.get('hue_shift', 0)) * hue_factor, -180, 180)
    saturation = clamp((1 + (float(target.get('saturation', 1)) - 1) * change_factor) * saturation_factor, 0.3, 2.0)
    value = clamp(1 + (float(target.get('value', 1)) - 1) * change_factor, 0.5, 1.5)
    return {'part': target['part'], 'hue_shift': round(hue, 3), 'saturation': round(saturation, 3), 'value': round(value, 3)}


def build_recipe(plan, feedback):
    recolor = plan.get('recolor') or {}
    targets = recolor.get('targets') or []
    if not isinstance(targets, list):
        raise ValueError('recolor.targets 必须是列表')
    # This entry point is reachable on its own, so it repeats the plan gate's rule rather than leaning
    # on it: an empty target list is executable only with a complete independent material axis, whose
    # presets the Unity step reproduces. "No targets and no usable axis" is refused here too, so a plan
    # that slipped past the gate still cannot produce a recipe with nothing behind it (决定记录 D-116).
    if not targets and not material_axis(plan.get('avatar_config')):
        raise ValueError('方案既没有 recolor.targets，也没有可执行的独立材质轴')
    # The split is the plan gate's own, so this entry refuses the same shapes for the same reason.
    # It runs here rather than leaning on the gate because this entry is reachable on its own — and
    # because a non-object target used to be dropped from every form here and then crash on `.get`.
    parts, materials, layers, regions = classify_recolor_targets(targets)
    # A target carrying a material is a material target and nothing else; a mixed one is refused by
    # the field check below rather than silently resolved into one form.
    relative = [target for target in parts if 'material' not in target]
    seen = set()
    ops = layer_ops(layers, seen)
    regions_ops = region_ops(regions, seen)
    # Passed through as they came, like the layer operations and for the same reason: naming a material is
    # the requirement itself, so no tier may shift it. The stage that consumes the recipe decides what to do
    # with them; this one only records them faithfully — after checking the shape the plan gate checks, so
    # an unvalidated plan cannot smuggle a spare field or a repeated id into materialOps.
    for target in materials:
        validate_material_target(target)
        claim_requirement_id(target, seen, 'material')
    for target in relative:
        if not re.fullmatch(r'hair|eye|outfit:[A-Za-z0-9_-]+', str(target.get('part', ''))):
            raise ValueError(f"不认识的改色部位 {target.get('part')}（只认 hair / eye / outfit:<id>）")
    # YAML and Runtime JSON can represent the same number as 1.0 and 1. Keep recipe bytes identical.
    relative = [{**target, **{key: float(target[key]) for key in ('hue_shift', 'saturation', 'value') if key in target}}
                for target in relative]
    # Only the relative targets have anything to vary. When every target is a fixed colour there is one
    # honest candidate, and generating identical ones to reach three would be a ritual, not a choice.
    # The same holds when there are no targets at all and the colours live in the material axis: the
    # stage still needs a recipe to confirm, so it gets exactly one tier (决定记录 D-116).
    count = 1 if not relative else int(clamp(int(recolor.get('candidates') or 3), 3, 5))
    tiers = [{'id': tier_id, 'label': label, 'adjustments': [scaled(t, h, c, s) for t in relative]}
             for tier_id, label, h, c, s in TIERS[:count]]
    chosen = 'A'
    if count == 1 and not targets:
        reason = '颜色由独立材质轴的多份预设承担，制作配方只有一档；待用户在 recolor_approval 确认区域与绑定，或驳回并提出修改'
    elif count == 1:
        reason = ('全部目标是固定色，只有一档；待用户在 recolor_approval 确认区域与绑定，或驳回并提出修改')
    else:
        reason = '方案原值（A 档）；待用户在 recolor_approval 确认，要换档就驳回并在修改意见里写「选 B」之类'
    if feedback:
        if count == 1:
            # With nothing to choose between, feedback is a revision request rather than a tier pick.
            # Reading it as a choice would invent a decision the person did not make.
            reason = f'用户修改意见：{feedback.strip()}'
        else:
            match = CHOICE.search(feedback.strip())
            if not match:
                raise ValueError(f'修改意见里没看出选哪一档（写「选 B」或「候选 2」）：{feedback}')
            pick = (match.group(1) or match.group(2)).upper()
            chosen = LETTERS[int(pick) - 1] if pick.isdigit() else pick
            if chosen not in [t['id'] for t in tiers]:
                raise ValueError(f'选的档 {chosen} 不在本次的 {count} 档里')
            reason = f'用户修改意见：{feedback.strip()}'
    return {'schema': 'recolor-recipe/0.3', 'targets': relative, 'layerOps': ops, 'regionOps': regions_ops,
            'materialOps': materials, 'tiers': tiers, 'candidates': count, 'chosen': chosen, 'reason': reason,
            'feedback': feedback or ''}


def serialize(recipe):
    return json.dumps(recipe, ensure_ascii=False, indent=2, sort_keys=True) + '\n'


def main():
    project = Path(os.environ['AVH_PROJECT_DIR'])
    plan = json.loads(os.environ.get('AVH_PLAN') or '{}')
    try:
        recipe = build_recipe(plan, os.environ.get('AVH_FEEDBACK', ''))
    except ValueError as error:
        sys.exit(str(error))
    path = project / RECIPE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialize(recipe), encoding='utf-8', newline='\n')
    print(f"配方 {len(recipe['tiers'])} 档，选定 {recipe['chosen']}；写入 {RECIPE}")


if __name__ == '__main__':
    main()
