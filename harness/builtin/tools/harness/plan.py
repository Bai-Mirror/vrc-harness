#!/usr/bin/env python3
"""Source-bound planning facts, AI-authored draft submission and independent validation.

The Runtime intake owns the catalog. This tool does not choose a design, scan a
user's library, inspect Run internals, import Unity, or claim downstream fit.
JSON is a YAML subset, so submission needs no extra Python YAML dependency.
"""
import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import avatar_config


def nfc(text):
    """The composed form registered-item identity is compared in, matching the intake tool's reader."""
    return unicodedata.normalize('NFC', text)

CATALOG = '_harness/intake/plan-catalog.json'
INVENTORY = '_harness/intake/inventory.json'
REQUIREMENTS = '_harness/intake/需求.md'
OUTPUT = '_harness/plan/plan.yaml'

# A target is one of four shapes and never a mixture of them (决定记录 D-73/D-75/D-81).
# The third exists because some requirements cannot be met by shifting a colour at all: the vendor ships the
# garment in numbered tiers, each a whole prefab referencing a set of materials, so meeting such a requirement
# means naming a material rather than adjusting one. The material's own asset path says which slot family it
# belongs to, so no separate slot field is needed; what it does not say is which outfit it belongs to, so that
# is the one field this form adds.
# The fourth exists because a vendor's layered source does not always carry a layer that means the region a
# requirement talks about — two irises sharing one texture and one material have no layer per eye. There the
# region has to come from the mesh: the author names bones, the submesh says which material the surface uses,
# and the triangles those bones hold say which pixels are in the region (决定记录 D-117).
RECOLOR_RELATIVE_FIELDS = {'part', 'hue_shift', 'saturation', 'value'}
RECOLOR_LAYER_FIELDS = {'requirement_id', 'layered', 'layer', 'color', 'semantics'}
RECOLOR_REGION_FIELDS = {'requirement_id', 'region', 'color', 'semantics'}
RECOLOR_MATERIAL_FIELDS = {'requirement_id', 'outfit', 'material'}
# A region is a place on a mesh, not a rectangle on a texture. `renderer` is the object the surface
# belongs to, `submesh` is which of its material slots, and `bones` are the names the vendor's own skin
# uses for the surface. None of those three is enough alone, which is why all three are required.
REGION_FIELDS = {'renderer', 'submesh', 'bones'}
LAYER_SEMANTICS = ('shade', 'flat')
DEVIATION_FIELDS = {'requirement', 'why', 'stands_in_for', 'needs_orderer_acceptance', 'evidence'}
HEX_COLOR = re.compile(r'#[0-9a-fA-F]{6}$')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def owned(project, relative):
    path = project / relative
    if not path.resolve().is_relative_to(project.resolve()):
        raise ValueError('Planning path escapes the managed project')
    for candidate in [path, *path.parents]:
        if candidate == project.parent:
            break
        if candidate.is_symlink():
            raise ValueError('Linked planning input refused')
    return path


def evidence_reference(project, path, quote):
    if not isinstance(path, str) or not path.startswith('_harness/') or not path.endswith('.json'):
        raise ValueError('deviation evidence must cite managed intake or probe text')
    source = owned(project, path)
    content = source.read_text(encoding='utf-8')
    reading = json.loads(content)
    allowed = ('inventory/0.1',) if path == INVENTORY else ('layered-source-probe/0.1', 'object-observation/0.1', 'observation/0.1')
    if not isinstance(reading, dict) or reading.get('schema') not in allowed:
        raise ValueError('deviation evidence must be an intake inventory or a structured probe, not planning prose')
    if not isinstance(quote, str) or not quote.strip() or quote not in content:
        raise ValueError('deviation evidence quoted reading is absent')
    return {'path': path, 'sha256': digest(source), 'quote': quote}


def build_catalog(project, manifest):
    inventory = json.loads(owned(project, INVENTORY).read_text(encoding='utf-8'))
    if inventory.get('schema') != 'inventory/0.1':
        raise ValueError('Planning needs a measured intake inventory')
    rows = []
    for item in inventory['items']:
        selected = [f for f in item.get('files', []) if f.get('selected')]
        rows.append({'item': item['item'], 'role': item['role'], 'name': item.get('name'),
                     'found': bool(item.get('found')), 'selected': bool(selected),
                     'availability': 'missing' if not item.get('found') else 'selected' if selected else
                                     'source_only' if item.get('layered') else 'unselected',
                     'compatibility': item.get('compat'), 'prefabs': item.get('prefabs', []), 'models': item.get('models', []),
                     'dependency_of': item.get('dependency_of', []),
                     'dependency_refs': item.get('dependency_refs', []),
                     'textures': [f['projectPath'] for f in selected if f.get('kind') == 'texture'],
                     # The vendor's layered working files. They are not installed, but they decide
                     # whether a colour change can name a layer instead of being guessed from pixels.
                     'layered': item.get('layered', []),
                     # The VPM dependencies this input installs. They are not prefabs and cannot be fitted
                     # to a body, so the plan must see them as a project dependency rather than as an
                     # unselected package: the environment stage installs exactly what the intake recorded.
                     'vpm': item.get('vpm', []),
                     'selectedFiles': [{'name': f['name'], 'sha256': f['sha256']} for f in selected]})
    data = {'schema': 'plan-catalog/0.1', 'inventorySha256': digest(owned(project, INVENTORY)),
            'manifestSha256': fingerprint(manifest), 'items': rows,
            'variants': manifest.get('variants', []), 'budget': inventory.get('budget', {}),
            'unmeasured': ['Prefab candidates are asset paths only, not inspected hierarchy or component contents; layered entries are file names, not layer tables',
                           'Unity hierarchy, bones and compatibility', 'shape-key writers and shrink decisions',
                           'face geometry and expression compensation', 'material slots and final appearance'],
            'productionAccepted': False}
    bodies = [i for i in rows if i['role'] == 'body']
    data['ready'] = len(bodies) == 1 and bodies[0]['selected'] and bool(bodies[0]['prefabs']) and \
        all(i['found'] for i in rows) and sorted(i['item'] for i in rows) == sorted(a['item'] for a in manifest['assets'])
    owned(project, CATALOG).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return data


def catalog(project, manifest=None):
    data = json.loads(owned(project, CATALOG).read_text(encoding='utf-8'))
    if data.get('schema') != 'plan-catalog/0.1' or data.get('inventorySha256') != digest(owned(project, INVENTORY)):
        raise ValueError('Planning catalog is stale; Runtime must repeat intake')
    if manifest is not None and data.get('manifestSha256') != fingerprint(manifest):
        raise ValueError('Planning catalog belongs to another frozen input')
    inventory = json.loads(owned(project, INVENTORY).read_text(encoding='utf-8'))
    # A claimed ready flag cannot erase a missing or source-only registered input.
    if sorted(i['item'] for i in data['items']) != sorted(i['item'] for i in inventory['items']) or \
            any(not i.get('found') for i in inventory['items']) or (manifest is not None and
            sorted(i['item'] for i in inventory['items']) != sorted(a['item'] for a in manifest['assets'])):
        raise ValueError('Planning catalog must retain every registered input; missing inputs require intake resolution')
    for row, measured in zip(sorted(data['items'], key=lambda i: i['item']), sorted(inventory['items'], key=lambda i: i['item'])):
        if row.get('layered', []) != measured.get('layered', []):
            raise ValueError('Planning catalog layered sources disagree with the measured inventory')
        if row.get('models', []) != measured.get('models', []):
            raise ValueError('Planning catalog model sources disagree with the measured inventory')
        if row.get('dependency_of', []) != measured.get('dependency_of', []):
            raise ValueError('Planning catalog material dependency carriers disagree with the measured inventory')
        if row.get('dependency_refs', []) != measured.get('dependency_refs', []):
            raise ValueError('Planning catalog material dependency evidence disagrees with the measured inventory')
    observed = [i for i in inventory['items'] if i.get('found') and i.get('role') == 'body' and
                any(f.get('selected') for f in i.get('files', []))]
    bodies = [i for i in data['items'] if i.get('role') == 'body']
    ready = len(observed) == len(bodies) == 1 and bool(observed[0]['prefabs']) and bodies[0]['prefabs'] == observed[0]['prefabs']
    if not ready:
        raise ValueError('Selected body has no readable prefab candidates; Runtime intake must resolve the material before planning')
    return data


def validate(plan, data, project=None):
    if not isinstance(plan, dict) or plan.get('schema') not in ('plan/0.2', 'plan/0.3'):
        raise ValueError('Expected an AI-authored plan/0.2 or plan/0.3 mapping')
    fields = {'schema', 'client_gallery', 'body', 'body_prefab', 'outfits', 'default_outfit', 'hide_body_parts',
              'unused', 'obligations', 'deviations', 'menu', 'recolor', 'optimization', 'face', 'notes', 'avatar_config'}
    if set(plan) - fields:
        # Name the accepted fields as well as the rejected ones. A plan put structured content one level
        # down, was told only that the name was unknown, and removed the content rather than moving it; a
        # refusal that does not show the right shape costs more than it prevents.
        raise ValueError('Unknown plan fields: ' + ', '.join(sorted(set(plan) - fields)) +
                         '；本 schema 只接受顶层 ' + ', '.join(sorted(fields)) +
                         '（做不到的要求登记在顶层 deviations，不要写进 notes）')
    items = {i['item']: i for i in data['items']}
    body = items.get(plan.get('body'))
    if not body or body['role'] != 'body' or plan.get('body_prefab') not in body['prefabs']:
        raise ValueError('body_prefab must come from the selected body catalog')
    grouped = plan['schema'] == 'plan/0.3'
    if grouped:
        if any(k in plan for k in ('outfits', 'default_outfit')) or 'selector' in plan.get('menu', {}):
            raise ValueError('plan/0.3 cannot mix avatar_config with legacy outfits/default_outfit/selector')
        avatar_config.validate(plan.get('avatar_config'), data)
        outfits = avatar_config.physical_rows(plan['avatar_config'])
        if project is not None:
            paths = [p['material'] for p in plan['avatar_config'].get('material_presets', [])]
            paths += [b['source_material'] for g in plan['avatar_config']['groups'] if g.get('kind') == 'material' for b in g['bindings']]
            if any(not owned(project, path) or not (project / path).is_file() for path in paths):
                raise ValueError('material axis sources must be readable assets in this project')
    else:
        if 'avatar_config' in plan:
            raise ValueError('avatar_config requires plan/0.3')
        outfits = plan.get('outfits')
    if not isinstance(outfits, list):
        raise ValueError('outfits must be a list')
    ids = set()
    exclusive_ids = set()
    for row in outfits:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not row['id'] or row['id'] in ids:
            raise ValueError('Every outfit needs a unique stable id')
        ids.add(row['id'])
        activation = row.get('activation', 'exclusive')
        if activation not in (('fixed', 'exclusive', 'independent') if grouped else ('fixed', 'exclusive')):
            raise ValueError('outfit activation must be fixed or exclusive')
        if activation == 'exclusive':
            exclusive_ids.add(row['id'])
        item = items.get(row.get('item'))
        if not item or item['role'] in ('body', 'texture') or row.get('prefab') not in item['prefabs'] + item.get('models', []):
            raise ValueError('outfit prefab must belong to its selected catalog item')
        if not isinstance(row.get('label'), str) or not 1 <= len(row['label']) <= 8:
            raise ValueError('Each outfit needs a short visible label')
    if not grouped and exclusive_ids and plan.get('default_outfit') not in exclusive_ids:
        raise ValueError('default_outfit must identify an exclusive outfit')
    if not grouped and not exclusive_ids and plan.get('default_outfit') is not None:
        raise ValueError('default_outfit requires an exclusive outfit')
    if not outfits and (plan.get('default_outfit') is not None or plan.get('hide_body_parts')):
        raise ValueError('A preservation plan cannot hide body parts or select a nonexistent outfit')
    for variant in data.get('variants', []):
        if variant.get('id') not in ids:
            raise ValueError('Every frozen variant must retain its id')
        expected = {a['item'] for a in variant.get('assets', [])}
        actual = {o['item'] for o in outfits if o['id'] == variant['id']}
        if expected and not actual.issubset(expected):
            raise ValueError('Outfit source belongs to another frozen variant')
    unused = plan.get('unused', [])
    if not isinstance(unused, list) or any(not isinstance(u, dict) or u.get('item') not in items or
                                          u.get('reason') not in ('unsupported', 'overlap', 'client_declined') or
                                          not u.get('note') for u in unused):
        raise ValueError('Unused sources need an explicit catalog item and reason')
    if any(u['item'] == plan['body'] or any(o['item'] == u['item'] for o in outfits) for u in unused):
        raise ValueError('A source cannot be both used and unused')
    for field, modes in [('optimization', ('optimize', 'preserve')), ('face', ('design', 'preserve'))]:
        value = plan.get(field)
        if not isinstance(value, dict) or value.get('mode') not in modes:
            raise ValueError(field + ' needs an explicit supported mode')
    if plan['face']['mode'] == 'design' and not plan['face'].get('intent'):
        raise ValueError('Face design needs its visible design intent, not vertex arrays')
    menu = plan.get('menu', {})
    if menu.get('mode') not in ('assemble', 'preserve'):
        raise ValueError('menu needs assemble or preserve')
    if menu['mode'] == 'preserve' and (exclusive_ids or grouped and any(g['activation'] != 'fixed' for g in plan['avatar_config']['groups'])):
        raise ValueError('menu preserve cannot select exclusive outfits; use assemble with a radial selector')
    if not grouped and menu['mode'] == 'assemble' and (menu.get('selector', {}).get('type') != 'radial' or
                                       menu.get('component_policy') != 'horizontal_across_outfits'):
        raise ValueError('Menu assembly needs the existing radial and horizontal contract')
    if grouped:
        validate_menu_tree(menu, plan['avatar_config'])
    if not isinstance(plan.get('recolor'), dict):
        raise ValueError('recolor needs an explicit existing stage recipe')
    recolor = plan['recolor']
    if not isinstance(recolor.get('targets'), list):
        raise ValueError('recolor targets must be a list of executable parts')
    # An empty target list is only executable when the plan carries its colours in a complete
    # independent material axis: each axis member binds an observed slot to a vendor preset, which is
    # what the recolor stage then has to reproduce. With neither, the plan's colours are prose and the
    # stage has nothing to do — that shape stays refused (决定记录 D-116).
    if not recolor['targets'] and not avatar_config.material_axis(plan.get('avatar_config')):
        raise ValueError('recolor targets must contain at least one executable part, '
                         'or the plan must carry its colours in a complete independent material axis')
    targets = recolor['targets']
    # Every candidate has to satisfy the hard constraints before anyone chooses between them, so when
    # every target is a fixed colour there is nothing left to vary and one candidate is the honest
    # number. Generating several identical ones to reach three would be a ritual, not a choice
    # (决定记录 D-78).
    fixed_only = all(isinstance(target, dict) and 'part' not in target for target in targets)
    low = 1 if fixed_only else 3
    if isinstance(recolor.get('candidates'), bool) or not isinstance(recolor.get('candidates'), int) \
            or not low <= recolor['candidates'] <= 5:
        raise ValueError('recolor candidates must be 3..5, or 1 when every target is a fixed colour')
    validate_recolor_targets(targets, {row['path'] for item in data['items']
                                       for row in (item.get('layered') or [])}, ids, project)
    if set(plan['face']) - {'mode', 'intent'}:
        raise ValueError('Face planning accepts intent only; actual shape construction belongs to the observed face stage')
    if plan.get('notes') is not None and not isinstance(plan['notes'], str):
        # Observed in a real run: the plan put its deviations inside notes as a structured mapping, was
        # refused, and then dropped them rather than moving them. A refusal that does not say where the
        # content belongs teaches nothing, and the cost of that was three colour requirements silently
        # disappearing from the plan.
        raise ValueError('notes 只放一两句取舍说明（字符串）；做不到的要求要登记在**顶层** deviations，'
                         '不要塞进 notes 里，也不要因为被拒就把它们删掉')
    validate_obligations(plan, {i['item']: i['role'] for i in data['items']},
                         {o['item'] for o in outfits}, {u['item'] for u in unused},
                         {i['item']: i.get('dependency_of', []) for i in data['items']},
                         {i['item']: i.get('dependency_refs', []) for i in data['items']})
    validate_deviations(plan, project)
    return True


OBLIGATION_ACTIONS = ('use', 'exclude', 'defer')
OBLIGATION_FIELDS = {'input', 'role', 'action', 'target', 'due_stage', 'reason'}
# The one stage that reads an obligation's postcondition from the assembled artifact.
OBLIGATION_STAGE = 'outfit'


def classify_recolor_targets(targets):
    """Split the four forms, refusing anything that is not an object before classifying.

    Selecting each list with `isinstance(target, dict)` dropped a non-object from every list rather
    than from the plan: `recolor.targets: [null]` passed the whole gate and the recipe builder then
    died on that same input with an AttributeError. A target with no form cannot be checked, so it is
    refused where the forms are told apart. The plan gate and the recipe entry point share this
    function so there is one classification rather than two that can drift.

    A layer target has none of the other three markers and a region target is told apart by its own
    `region` field, so the four lists are decided by the markers rather than by the order they are
    tested in: a target carrying two markers is a mixture and is refused by the field check of
    whichever form claims it, not silently resolved into one.
    """
    for target in targets:
        if not isinstance(target, dict):
            raise ValueError(f"每个配色目标都必须是对象，收到 {type(target).__name__}：{target!r}")
    parts = [t for t in targets if 'part' in t]
    materials = [t for t in targets if 'material' in t]
    regions = [t for t in targets if 'region' in t]
    layers = [t for t in targets if not ({'part', 'material', 'region'} & set(t))]
    return parts, materials, layers, regions


def claim_requirement_id(target, seen, form):
    """Take one target's requirement_id for this run, refusing a blank one or a repeat.

    Ids are claimed across every form on purpose: they are what the observer matches against the
    order's fixed colours, so two targets sharing one id would make that match ambiguous whichever
    forms they came from. One function serves the plan gate and the recipe entry point, which is
    called again by the observer and cannot lean on the gate having run (决定记录 D-75/D-81).
    """
    value = target.get('requirement_id')
    if not isinstance(value, str) or not value.strip():
        raise ValueError('A ' + form + ' target needs a stable requirement_id')
    if value in seen:
        raise ValueError('Duplicate requirement_id in recolor targets: ' + value)
    seen.add(value)
    return value


def validate_region_target(target):
    """A region target's own shape, so the recipe entry point refuses the same shapes without a copy.

    Every part of the region has to be named. The renderer and the submesh say which surface, the bones
    say which part of it, and a region that leaves one of them out would be resolved by a default that
    nobody agreed to. Whether the renderer exists, whether the submesh is in range and whether the bones
    are on that mesh are Unity's answers at execution: this stage has observed the avatar's hierarchy as
    a catalog of prefabs, not as an assembled mesh, and inventing an answer here would be a guess wearing
    a validation's clothes (决定记录 D-100).
    """
    if set(target) != RECOLOR_REGION_FIELDS:
        raise ValueError('Invalid recolor region target fields')
    region = target.get('region')
    if not isinstance(region, dict) or set(region) != REGION_FIELDS:
        raise ValueError('A region target needs a region of exactly renderer, submesh and bones')
    if not isinstance(region.get('renderer'), str) or not region['renderer'].strip():
        raise ValueError('A region needs the renderer its surface belongs to')
    submesh = region.get('submesh')
    if isinstance(submesh, bool) or not isinstance(submesh, int) or submesh < 0:
        raise ValueError('A region needs a non-negative integer submesh（子网格序号，从 0 起）')
    bones = region.get('bones')
    if not isinstance(bones, list) or not bones or \
            not all(isinstance(bone, str) and bone.strip() for bone in bones):
        raise ValueError('A region needs at least one bone name; an empty bone list names no surface')
    if len(set(bones)) != len(bones):
        raise ValueError('A region cannot name the same bone twice')
    if not isinstance(target.get('color'), str) or not HEX_COLOR.match(target['color']):
        raise ValueError('A region target needs a #RRGGBB colour')
    if target.get('semantics') not in LAYER_SEMANTICS:
        raise ValueError('A region target needs semantics: shade or flat')
    return True


def validate_material_target(target):
    """A material target's own shape: exact fields and a .mat under Assets/.

    Split out of `validate_recolor_targets` so the recipe entry point can refuse the same shapes
    without a second copy of the rules. What needs the catalog (the outfit id) and the project
    (containment) stays with the plan, which is the caller that has them.
    """
    if set(target) != RECOLOR_MATERIAL_FIELDS:
        raise ValueError('Invalid recolor material target fields')
    material = target.get('material')
    if not isinstance(material, str) or not material.strip():
        raise ValueError('A material target needs a material path')
    if not material.endswith('.mat'):
        raise ValueError(f"材质目标必须指向 .mat 资产：{material}")
    if not material.startswith('Assets/'):
        raise ValueError(f"材质目标必须使用 Assets/ 下的资产路径：{material}")
    return True


def validate_recolor_targets(targets, registered_layered, ids, project=None):
    """
    Four target forms, each checked independently rather than by field precedence.

    A **relative** target shifts hue, saturation and value across a whole part, which is all the stage
    could do before: it cannot say "make this surface this colour", and it cannot restrict a colour to
    some surfaces and not others.

    A **layer** target names a layered source the vendor shipped and one layer inside it, which makes
    the region a name instead of a guess about pixels. It also has to say what it promises: `shade`
    keeps the artist's own light and dark and promises the layer input is exact, while `flat` promises
    the region's opaque core is exactly the requested colour. Those are different claims, so neither
    may be read as the other (决定记录 D-75/D-81).

    A **region** target names a place on the mesh — the renderer, which of its material slots, and the
    bones that hold the surface — and the stage derives the exact UV footprint of that surface. This is
    the form that can tell two eyes apart on one texture, where no layer means "this eye", and it says
    what it promises with the same two semantics as the layer form.

    A **material** target selects the vendor asset for all matching directory slots in one outfit;
    the managed project bounds its path, while Unity establishes actual slot coverage.

    Mixing forms in one target is refused rather than resolved by precedence: a target whose
    meaning depends on which field a reader looks at first is not a contract. A target that is not
    an object is refused before any of this, because it has no form to check.
    """
    parts, materials, layers, regions = classify_recolor_targets(targets)
    # The 1..3 cap belongs to the relative form, which reaches a whole part at a time. A plan made
    # only of layer targets has no relative parts at all, and that is a normal plan.
    if len(parts) > 3:
        raise ValueError('recolor targets must not exceed 3 relative parts')
    if len(layers) > 8:
        raise ValueError('recolor layer targets must not exceed 8 operations')
    # Regions get their own cap rather than sharing the layer one: each repaints one place on one
    # texture, so the count is how many places a plan may name, not how many colours it may shift.
    if len(regions) > 8:
        raise ValueError('recolor region targets must not exceed 8 operations')
    # Materials get their own cap rather than sharing one: each replaces a whole slot, so the count is how
    # many slots a plan may redirect rather than how many colours it may shift.
    if len(materials) > 8:
        raise ValueError('recolor material targets must not exceed 8 operations')
    for target in parts:
        if set(target) != RECOLOR_RELATIVE_FIELDS:
            raise ValueError('Invalid recolor target fields')
        if target['part'] not in {'hair', 'eye', *('outfit:' + i for i in ids)}:
            raise ValueError('Unknown recolor part')
        for field, low, high in [('hue_shift', -180, 180), ('saturation', .5, 1.5), ('value', .7, 1.3)]:
            value = target.get(field)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
                raise ValueError('Invalid recolor ' + field)
    seen = set()
    for target in layers:
        if set(target) != RECOLOR_LAYER_FIELDS:
            raise ValueError('Invalid recolor layer target fields')
        claim_requirement_id(target, seen, 'layer')
        # The source is a layered file the intake actually recorded: naming one that is not registered
        # would promise a region nothing can read.
        if target['layered'] not in registered_layered:
            raise ValueError(f"未登记的分层源文件：{target['layered']}")
        # A layer path is an array of names. A joined string would be ambiguous when a name itself
        # contains a separator, and trimming would silently match a different layer (决定记录 D-73).
        path = target['layer']
        if not isinstance(path, list) or not path or not all(isinstance(part, str) and part.strip() for part in path):
            raise ValueError('A layer target needs an explicit layer path of names')
        if not isinstance(target['color'], str) or not HEX_COLOR.match(target['color']):
            raise ValueError('A layer target needs a #RRGGBB colour')
        if target['semantics'] not in LAYER_SEMANTICS:
            raise ValueError('A layer target needs semantics: shade or flat')
    for target in regions:
        validate_region_target(target)
        claim_requirement_id(target, seen, 'region')
    for target in materials:
        validate_material_target(target)
        claim_requirement_id(target, seen, 'material')
        # The outfit is what bounds the replacement. Without it the material's directory alone would match
        # slots in every garment that happens to use materials from that directory, which is not what the
        # requirement says (决定记录: the mapping rule is scoped to one garment).
        if not isinstance(target['outfit'], str) or target['outfit'] not in ids:
            raise ValueError(f"材质目标必须指向本次方案里的一件服装：{target.get('outfit')}")
        # Containment is what this stage can decide. Whether the file is there and whether it is a material
        # at all is answered by loading it at execution, the same division the layer form uses when it checks
        # registration rather than readability (the shape check above already keeps a plan from naming a
        # folder or a texture and only finding out much later).
        if project is None:
            raise ValueError('Material target validation requires the managed project')
        if not owned(project, target['material']):
            raise ValueError(f"材质目标必须在本工程内：{target['material']}")
    return True


def fixed_colors_addressed(plan, project):
    """Which fixed colours the order names are addressed by something executable, and which are only prose.

    A plan can pass every structural check while acknowledging a hard requirement in `notes` and never
    promising it anywhere a later stage can act on. That happened: an order naming three fixed colours with
    restricted surfaces produced a plan with relative adjustments only, the colour codes lived in prose, and
    nothing could tell the difference. `validate_obligations` already states the principle for inputs —
    silence is not a disposition — and this is the same rule one level up, applied to the order's colours.

    Tokens are only counted when they cannot be something else. The order writes colours bare, so requiring
    a `#` would miss all of them; instead anything that also appears in the intake inventory or the frozen
    manifest is dropped, because those are exactly where identifiers and hashes live. Missing a colour is
    the safe error here: a false positive would block an order that is fine.
    """
    text = owned(project, REQUIREMENTS).read_text(encoding='utf-8') if owned(project, REQUIREMENTS).is_file() else ''
    elsewhere = ' '.join(owned(project, path).read_text(encoding='utf-8', errors='replace')
                         for path in (INVENTORY, CATALOG) if owned(project, path).is_file())
    addressed = {str(t.get('color', '')).strip().lstrip('#').upper()
                 for t in ((plan.get('recolor') or {}).get('targets') or []) if isinstance(t, dict)}
    # A colour declared as an unmet deviation is accounted for — declared rather than quietly missing.
    # Without this the metric punished exactly the behaviour it was introduced to produce: a plan that
    # registered its shortfalls instead of inventing targets for them read as two colours unaddressed.
    for row in (plan.get('deviations') or []):
        if not isinstance(row, dict):
            continue
        for field in ('requirement', 'why', 'stands_in_for'):
            addressed.update(token.upper() for token in re.findall(r'[0-9A-Fa-f]{6}', str(row.get(field, ''))))
    unaddressed = []
    for token in dict.fromkeys(re.findall(r'\b[0-9A-Fa-f]{6}\b', text)):
        upper = token.upper()
        if upper in elsewhere or upper in addressed:
            continue
        unaddressed.append(upper)
    return unaddressed


def validate_deviations(plan, project=None):
    """Requirements the order asks for and these assets cannot deliver, stated where a reader will find them.

    A plan had no way to say this. It could only promise the requirement in prose, which nothing executes, or
    leave it out, which hides it. Two plans did both in turn, and a third registered the shortfalls in its
    notes where the gate read them as though they were handled. A deviation has to name what cannot be done,
    why, what stands in for it, and that the orderer must accept it — the last one especially, because a
    plan may not waive a requirement on the client's behalf.
    """
    rows = plan.get('deviations')
    if rows is None:
        return
    if not isinstance(rows, list):
        raise ValueError('deviations must be a list of requirements that cannot be met')
    for row in rows:
        if not isinstance(row, dict) or set(row) - DEVIATION_FIELDS:
            raise ValueError('a deviation declares only ' + ', '.join(sorted(DEVIATION_FIELDS)))
        for field in ('requirement', 'why', 'stands_in_for'):
            if not isinstance(row.get(field), str) or not row[field].strip():
                raise ValueError(f'a deviation needs a non-empty {field}')
        # Accepting a shortfall is the orderer's act, so a plan may only flag it rather than assert it.
        if row.get('needs_orderer_acceptance') is not True:
            raise ValueError('a deviation must be marked as needing the orderer to accept it')
        # Requiring evidence for every reason avoids an uncheckable prose classifier for absence claims.
        # This verifies the cited bytes, not the author's interpretation or the orderer's acceptance.
        evidence = row.get('evidence')
        if not isinstance(evidence, list) or not evidence or project is None:
            raise ValueError('a deviation needs readable evidence (inventory, package members or layer probe)')
        for ref in evidence:
            if not isinstance(ref, dict) or set(ref) != {'path', 'sha256', 'quote'}:
                raise ValueError('deviation evidence needs path, sha256 and an exact quote')
            if evidence_reference(project, ref['path'], ref['quote']) != ref:
                raise ValueError('deviation evidence is stale or its quoted reading is absent')


def layer_paths_unresolved(plan, project):
    """How many layered targets name a layer their source does not contain, or None when unverifiable.

    The plan stage may name a layer and leave its existence to the executor, and a plan did exactly that
    with five names that were all invented. Whether a path resolves is cheap to check and expensive to
    assume, so the count is reported when the tables can be read.

    None means the tables could not be read — no dependency, or an unreadable source. That is deliberately
    not zero: the caller omits the metric, the engine reads a missing metric as no data, and no data does
    not pass. A machine without the layer library can still draft a plan, but cannot present one as checked
    (决定记录 D-100).
    """
    targets = [t for t in ((plan.get('recolor') or {}).get('targets') or [])
               if isinstance(t, dict) and t.get('layered')]
    if not targets:
        return 0
    inventory = json.loads(owned(project, INVENTORY).read_text(encoding='utf-8'))
    containers = {entry['path']: item.get('item') for item in inventory['items']
                  for entry in (item.get('layered') or [])}
    tools = Path(__file__).resolve().parent
    if str(tools) not in sys.path:
        sys.path.insert(0, str(tools))
    try:
        import layer_source
        import zipfile
    except ImportError:
        return None
    tables, unresolved = {}, 0
    for target in targets:
        source = target['layered']
        container = containers.get(source)
        if not container:
            return None
        try:
            # Keyed by member as well as container: one archive usually holds several sources, and keying
            # by the archive alone checked the second source against the first one's table.
            if (container, source) not in tables:
                with zipfile.ZipFile(container) as archive:
                    with archive.open(source) as handle:
                        # A per-call name: one fixed path is shared by concurrent runs, and a reader then
                        # sees another call's half-written file and reports the source as unreadable.
                        temporary = Path(tempfile.mkdtemp(prefix='avh-plan-layer-')) / 'source.psd'
                        temporary.write_bytes(handle.read())
                try:
                    # Keyed by path and holding the layer itself, because whether a layer exists and whether
                    # it covers anything are different questions and a plan can satisfy the first while
                    # failing the second. The canvas comes along because a mask is built over it.
                    opened = layer_source.open_psd(temporary)
                    tables[(container, source)] = (opened, {tuple(row['path']): row['layer']
                                                            for row in layer_source.walk(
                                                                opened, with_layer=True)})
                finally:
                    shutil.rmtree(temporary.parent, ignore_errors=True)
            canvas, table = tables[(container, source)]
            wanted = tuple(str(part) for part in (target.get('layer') or []))
            layer = table.get(wanted)
            if layer is None:
                unresolved += 1
                continue
            # A target naming a layer that exists but covers no pixels is not carried through; it is an
            # operation that would change nothing. Measured on a real plan: a target aimed at an iris whose
            # mask is empty passed every reading, because the path resolved (证据/版本4目标与偏差矛盾).
            import numpy
            if not int((numpy.asarray(layer_source.layer_mask(canvas, layer)) > 0).sum()):
                unresolved += 1
        except (Exception, SystemExit):  # an unreadable source is not a resolved one
            # SystemExit as well as Exception: the shared layer reader refuses a bad source by raising
            # SystemExit so a command prints a sentence rather than a traceback, and catching only
            # Exception let it escape and crashed the observer instead of reporting the names unverified.
            return None
    return unresolved


def selected_prefab_carriers(plan):
    """Exact sources selected by either supported plan shape, including the body."""
    sources = {(str(plan.get('body')), str(plan.get('body_prefab')))}
    instances = avatar_config.physical_rows(avatar_config.normalize(plan)) if plan.get('schema') == 'plan/0.3' else plan.get('outfits') or []
    sources.update((str(row.get('item')), str(row.get('prefab')))
                   for row in instances if isinstance(row, dict))
    return sources


def validate_obligations(plan, registered, outfits, unused, dependency_of=None, dependency_refs=None):
    """One disposition per registered input, consistent with the plan's other declarations.

    Silence is not a disposition. A weak version of this schema lets a model name only the inputs it
    happened to mount, which is exactly the shape that let a plan promise four products while the
    artifact held one and every check still passed.

    `registered` maps each intake item to the role the intake record gave it. The obligation has to keep
    that role: a plan that restates an outfit as `other` would otherwise decide for itself which
    postcondition it owes, and the artifact check for outfits would never run on it.
    """
    dependency_of = dependency_of or {}
    dependency_refs = dependency_refs or {}
    selected_prefabs = selected_prefab_carriers(plan)
    required = {}
    for item, refs in dependency_refs.items():
        for ref in refs:
            if not isinstance(ref, dict):
                continue
            carrier = (str(ref.get('carrier')), str(ref.get('prefab')))
            if carrier not in selected_prefabs:
                continue
            required.setdefault(item, set()).add(str(ref.get('carrier')))
    rows = plan.get('obligations')
    if not registered:
        if rows not in (None, []):
            raise ValueError('A plan over an empty inventory declares no obligations')
        return
    if not isinstance(rows, list) or not rows:
        raise ValueError('Every registered input needs an obligation')
    declared = set()
    by_input = {}
    for row in rows:
        if not isinstance(row, dict) or set(row) - OBLIGATION_FIELDS:
            raise ValueError('An obligation declares only ' + ', '.join(sorted(OBLIGATION_FIELDS)))
        item = row.get('input')
        if not isinstance(item, str) or item not in registered:
            raise ValueError('An obligation names an input that was not registered: ' + str(item))
        if item in declared:
            raise ValueError('Every registered input needs exactly one obligation: ' + item)
        declared.add(item)
        by_input[item] = row
        role, action = row.get('role'), row.get('action')
        if role != registered[item]:
            raise ValueError('An obligation keeps the role the intake record gives its input: ' + item +
                             ' is ' + registered[item] + ', not ' + str(role))
        if action not in OBLIGATION_ACTIONS:
            raise ValueError('Unknown obligation action: ' + str(action))
        if action == 'use':
            if not isinstance(row.get('target'), str) or not row['target']:
                raise ValueError('A use obligation names where the input goes')
            # A stage id that exists is not enough: the stage also has to turn this obligation into a
            # postcondition, and only one stage currently does.
            if row.get('due_stage') != OBLIGATION_STAGE:
                raise ValueError('A use obligation is due at ' + OBLIGATION_STAGE +
                                 ', the stage that reads its postcondition from the artifact')
        elif not isinstance(row.get('reason'), str) or not row['reason']:
            raise ValueError(action + ' needs a reason')
        # The obligation is a projection of declarations the plan already makes, not a second ledger.
        if item in outfits and action != 'use':
            raise ValueError('An input the plan mounts cannot be excluded or deferred: ' + item)
        if item in unused and action != 'exclude':
            raise ValueError('An input the plan calls unused must be excluded: ' + item)
        if action != 'use':
            continue
        if role == 'outfit' and item not in outfits:
            raise ValueError('An outfit obligation names an outfit the plan mounts: ' + item)
        if role == 'body' and item != plan.get('body'):
            raise ValueError('The body obligation names the selected body')
        if role == 'other' and item not in outfits:
            raise ValueError('An installation obligation needs its own selected instance: ' + item)
        if role == 'texture':
            carrier = next((other for other in rows if other.get('input') == row['target']), None)
            if carrier is None or carrier.get('action') != 'use' or carrier.get('role') not in ('body', 'outfit', 'other'):
                # This stage can prove a package reached the avatar through what carries it, and it
                # cannot prove a texture was applied. Promising the second without the first would make
                # the postcondition unfalsifiable.
                raise ValueError('A ' + role + ' obligation must name a registered input that is itself '
                                 'used as body, outfit or installation instance: ' + item)
            allowed_carriers = sorted(required.get(item, set()))
            if dependency_refs.get(item) and not allowed_carriers:
                raise ValueError('A material dependency has no selected prefab carrier: ' + item)
            if not allowed_carriers:
                allowed_carriers = dependency_of.get(item) or []
            if allowed_carriers and row['target'] not in allowed_carriers:
                raise ValueError('A material dependency must name one of its observed prefab carriers: ' + item)
    missing = registered.keys() - declared
    if missing:
        raise ValueError('Registered inputs without an obligation: ' + ', '.join(sorted(missing)))
    # A material dependency cannot be excluded or deferred while one of the observed carriers is used:
    # that would make the carrier's prefab reference a guaranteed missing GUID while the plan still looks
    # fully disposed. The ordinary texture-carrier postcondition below remains the proof of a selected pack.
    for item, carriers in required.items():
        dependency = by_input.get(item)
        if not dependency or dependency.get('action') == 'use':
            continue
        if any(by_input.get(carrier, {}).get('action') == 'use' for carrier in carriers):
            raise ValueError('A used outfit cannot exclude or defer its observed material dependency: ' + item)
    return True


def excluded_items(plan):
    """Catalog items the plan consistently excludes from the delivery, item -> {'reason', 'note'}.

    Consistent means the three declarations agree: the item is listed `unused` with a reason and a note, its one
    obligation excludes it with a reason, and the plan does not mount it. `package_usage_refs_closed` exempts a
    use obligation on exactly this conjunction, so the packaging action reads the same function: the delivery
    can never strip a product the criterion would refuse to exempt, nor ship data for one it exempts.
    """
    obligations = {}
    for row in (plan.get('obligations') or []):
        if isinstance(row, dict):
            obligations.setdefault(nfc(str(row.get('input'))), []).append(row)
    exclusions = {item for item, rows in obligations.items()
                  if len(rows) == 1 and rows[0].get('action') == 'exclude' and rows[0].get('reason')}
    mounted = {nfc(str(row.get('item'))) for row in (plan.get('outfits') or [])
               + ((plan.get('avatar_config') or {}).get('instances') or []) if isinstance(row, dict)}
    if plan.get('body') is not None:
        mounted.add(nfc(str(plan['body'])))
    excluded = {}
    for entry in (plan.get('unused') or []):
        if not isinstance(entry, dict) or entry.get('item') is None or not entry.get('reason'):
            continue
        item = nfc(str(entry['item']))
        if item in exclusions and item not in mounted:
            excluded[item] = {'reason': str(entry['reason']), 'note': str(entry.get('note') or '')}
    return excluded


def effective_inventory(inventory, approved_plan_or_exclusions=None):
    """Project intake evidence into the files the approved plan may consume.

    Intake remains the raw measurement.  Every downstream stage that needs a selection
    receives this copied view, so a consistent exclusion cannot accidentally become an
    import, dependency anchor, observation obligation, or delivery source.  The second
    argument also accepts the already computed exclusion mapping for compatibility with
    older callers; new callers pass the approved plan itself.
    """
    if not isinstance(inventory, dict):
        raise ValueError('素材清点必须是对象')
    value = approved_plan_or_exclusions or {}
    if isinstance(value, dict) and value and all(isinstance(row, dict) and 'reason' in row for row in value.values()):
        excluded = {nfc(str(item)) for item in value}
    else:
        excluded = set(excluded_items(value if isinstance(value, dict) else {}))
    effective = copy.deepcopy(inventory)
    selected_sources = selected_prefab_carriers(value) if isinstance(value, dict) and value.get('body') and value.get('body_prefab') else None
    for item in effective.get('items', []):
        for entry in item.get('files', []):
            if not isinstance(entry, dict):
                continue
            if nfc(str(item.get('item'))) in excluded:
                entry['selected'] = False
            elif selected_sources is not None and (entry.get('package_shapes') or entry.get('dependency_refs')):
                # Dependency membership is measured per inner Unity package. A ZIP containing geometry
                # and several dependency members must retain geometry and only the necessary members.
                dependency_members = {ref.get('member') or entry['name'] for ref in entry.get('dependency_refs', [])}
                required_members = {ref.get('member') or entry['name'] for ref in entry.get('dependency_refs', [])
                                    if (str(ref.get('carrier')), str(ref.get('prefab'))) in selected_sources}
                shapes = {shape.get('name'): shape for shape in entry.get('package_shapes', [])
                          if isinstance(shape, dict) and shape.get('name')}
                entry['active_packages'] = [name for name in entry.get('packages', [])
                                            if (name not in dependency_members and
                                                shapes.get(name, {}).get('kind') != 'provider') or
                                               name in required_members]
                if not entry['active_packages']:
                    entry['selected'] = False
    return effective


def import_records(record):
    """Return setup receipts flattened for old and new history formats.

    Older setup receipts could preserve a predecessor which itself carried its full history.  Readers keep
    accepting that shape, while callers that write a new receipt receive one shallow record per run.
    """
    if not isinstance(record, dict):
        return []
    current = {key: value for key, value in record.items() if key != 'history'}
    rows = [current]
    for entry in record.get('history') or []:
        rows.extend(import_records(entry))
    return rows


def validate_menu_tree(menu, config):
    if menu.get('vendor_policy') != 'preserve_and_merge':
        raise ValueError('menu requires preserve_and_merge vendor policy')
    groups = {g['id'] for g in config['groups'] if g['activation'] != 'fixed'}
    switches = {s['id'] for s in config.get('shared_switches', [])}
    seen, switch_seen = set(), set()
    def walk(nodes):
        if not isinstance(nodes, list):
            raise ValueError('menu tree must be a list')
        for node in nodes:
            if not isinstance(node, dict):
                raise ValueError('menu nodes must be mappings')
            if set(node) == {'group'} and node['group'] in groups:
                if node['group'] in seen:
                    raise ValueError('group menu entry repeated')
                seen.add(node['group'])
            elif set(node) == {'shared_switch'} and node['shared_switch'] in switches:
                switch_seen.add(node['shared_switch'])
            elif set(node) == {'id', 'label', 'children'} and isinstance(node['label'], str) and node['label']:
                walk(node['children'])
            else:
                raise ValueError('menu tree contains an unknown business reference')
    walk(menu.get('tree'))
    if seen != groups or switch_seen != switches:
        raise ValueError('menu tree must reach every group and shared switch')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('inspect', 'evidence', 'submit', 'observe', 'observe-inputs'))
    parser.add_argument('--project', default=os.environ.get('AVH_PROJECT_DIR'), required=False)
    parser.add_argument('--offset', type=int, default=0)
    parser.add_argument('--limit', type=int, default=24)
    parser.add_argument('--item')
    parser.add_argument('--draft')
    parser.add_argument('--out')
    parser.add_argument('--path')
    parser.add_argument('--quote')
    parser.add_argument('--config-tool')
    args = parser.parse_args()
    project = Path(args.project)
    try:
        manifest = json.loads(os.environ['AVH_MANIFEST']) if os.environ.get('AVH_MANIFEST') else None
        data = catalog(project, manifest)
        if args.action == 'evidence':
            print(json.dumps(evidence_reference(project, args.path, args.quote), ensure_ascii=False))
        elif args.action == 'inspect':
            if args.offset < 0 or not 1 <= args.limit <= 64:
                raise ValueError('Invalid planning page; limit must be 1..64')
            rows = [{'item': item['item'], 'role': item['role'], 'prefab': path}
                    for item in data['items'] if args.item is None or item['item'] == args.item for path in item['prefabs']]
            page = rows[args.offset:args.offset + args.limit]
            print(json.dumps({'schema': data['schema'], 'catalogSha256': digest(owned(project, CATALOG)),
                              'inventorySha256': data['inventorySha256'],
                              'items': [{k: v for k, v in i.items() if k != 'prefabs'} for i in data['items']],
                              'variants': data['variants'], 'unmeasured': data['unmeasured'],
                              'offset': args.offset, 'total': len(rows), 'candidates': page,
                              'nextOffset': args.offset + len(page) if args.offset + len(page) < len(rows) else None}, ensure_ascii=False))
        elif args.action == 'submit':
            if not args.draft or not args.draft.startswith('_harness/plan/'):
                raise ValueError('The AI draft must be under _harness/plan/')
            plan = json.loads(owned(project, args.draft).read_text(encoding='utf-8'))
            validate(plan, data, project)
            output = owned(project, OUTPUT)
            output.parent.mkdir(parents=True, exist_ok=True)
            temporary = output.with_suffix('.yaml.new')
            temporary.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            temporary.replace(output)
            print(json.dumps({'schema': 'plan-submission/0.1', 'file': OUTPUT, 'sha256': digest(output),
                              'sourceContractValid': True, 'technicalFitVerified': False, 'productionAccepted': False}))
        else:
            plan = json.loads(os.environ.get('AVH_PLAN', '{}'))
            if args.action == 'observe':
                validate(plan, data, project)
            if not args.out:
                raise ValueError('Observer output missing')
            metric = 'plan_source_contract_valid' if args.action == 'observe' else 'plan_input_catalog_ready'
            metrics = {metric: True}
            if plan.get('schema') == 'plan/0.3':
                metrics['plan_group_contract_valid'] = True
            notes = ['Structure and selected sources only; downstream technical checks remain required']
            if args.action == 'observe':
                # Reported, not yet required: the count is useful the moment it exists, but a plan needs a
                # legal way to say "this colour cannot be done" before the count may block one.
                unaddressed = fixed_colors_addressed(plan, project)
                metrics['plan_unaddressed_fixed_colors'] = len(unaddressed)
                if unaddressed:
                    notes.append('订单点名但计划未以可执行目标交代的定点色：' + '、'.join(unaddressed))
                # Omitted rather than zeroed when the tables cannot be read, so the engine sees no data and
                # does not pass. That is the difference between "checked and fine" and "not checked".
                unresolved = layer_paths_unresolved(plan, project)
                if unresolved is None:
                    notes.append('分层源层表读不到（缺依赖或源不可读），层路径未核实——未核实不能当作可执行')
                else:
                    metrics['plan_layer_paths_unresolved'] = unresolved
                    if unresolved:
                        notes.append(f'{unresolved} 条分层目标落不了地：层路径不在源文件里，'
                                     '或该层不覆盖任何像素（后者不是「效果差」，是不产生改动）')
            Path(args.out).write_text(json.dumps({'schema': 'observation/0.1', 'metrics': metrics,
                                                  'notes': notes}), encoding='utf-8')
    except (ValueError, KeyError, TypeError, OSError) as error:
        if args.action.startswith('observe') and args.out:
            metric = 'plan_source_contract_valid' if args.action == 'observe' else 'plan_input_catalog_ready'
            Path(args.out).write_text(json.dumps({'schema': 'observation/0.1', 'metrics': {metric: False, 'plan_group_contract_valid': False},
                                                  'notes': [str(error)]}), encoding='utf-8')
        else:
            parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
