#!/usr/bin/env python3
# 【项目沉淀】通用工具（Harness 观测：material.recolor）
# 适用素体：无关
# 工具链　：python3 标准库；git（只读 ls-files）
# 可复用性：★★★ 换个单子直接能用
# 用途　　：只读测量改色层。替换了哪些槽、材质是否被多个网格共用、材质是否都在本层目录，一律从改色层变体
#           Assets/_Harness/Recolor/Avatar.prefab 的覆盖项重新数，不信台账；台账只拿来对账。配方重跑取哈希比对；
#           候选档数与机位规格读本阶段 Run 目录 candidates/。写 observation/0.1 到 --out。
# 用法　　：observe_recolor.py --out <文件>   （工程取 AVH_PROJECT_DIR，Run 目录取 AVH_RUN_DIR，工具根取 AVH_TOOL_ROOT）
"""Independent measurements for the recolor checks."""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

LAYER = Path('Assets/_Harness/Recolor')
SECTIONS = ('## 选定档', '## 理由', '## 未选的档')
# 一档时「未选的档」不存在，该节不应被要求。
SECTIONS_SINGLE = ('## 选定档', '## 理由')
OVERRIDE = re.compile(
    r'- target: \{fileID: (-?\d+), guid: ([0-9a-f]{32}),\s*type: \d+\}\s*\n\s*propertyPath: m_Materials\.Array\.data\[(\d+)\]\s*\n'
    r'\s*value:[^\n]*\n\s*objectReference: \{fileID: -?\d+(?:, guid: ([0-9a-f]{32}),\s*type: \d+)?\}')
META_GUID = re.compile(rb'^guid:\s*([0-9a-f]{32})', re.M)


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def decode(path):
    """A texture as samples. Comparing decoded pixels rather than file bytes is the point: PNG is
    lossless, so re-encoding changes the bytes without changing the picture."""
    import numpy
    from PIL import Image
    with Image.open(path) as image:
        return numpy.asarray(image.convert('RGBA'))


def guid_of(path):
    """The GUID the project gave a file, read from the .meta beside it rather than assumed."""
    meta = Path(str(path) + '.meta')
    if not meta.is_file():
        return None
    found = re.search(r'^guid:\s*([0-9a-f]{32})', meta.read_text(encoding='utf-8', errors='replace'), re.M)
    return found.group(1) if found else None


# A prefab says which object it is by a fileID and the GUID of the asset that declares it, never by a path.
# Resolving that identity to the path the plan and the ledger use needs the same four links Unity wrote:
# the object's Transform chain, the instance a stripped proxy belongs to, that instance's parent here, and
# the nested asset the proxy stands for.
PREFAB_BLOCK = re.compile(r'^--- !u!(\d+) &(-?\d+)( stripped)?\s*$', re.M)
SOURCE_PREFAB = re.compile(r'm_SourcePrefab: \{fileID: -?\d+, guid: ([0-9a-f]{32})')
TRANSFORM_PARENT = re.compile(r'm_TransformParent: \{fileID: (-?\d+)\}')
CORRESPONDING = re.compile(r'm_CorrespondingSourceObject: \{fileID: (-?\d+)(?:, guid: ([0-9a-f]{32}))?')
INSTANCE_REF = re.compile(r'm_PrefabInstance: \{fileID: (-?\d+)\}')
GAMEOBJECT_REF = re.compile(r'm_GameObject: \{fileID: (-?\d+)\}')
FATHER_REF = re.compile(r'm_Father: \{fileID: (-?\d+)\}')
COMPONENT_REF = re.compile(r'- component: \{fileID: (-?\d+)\}')
NAME_VALUE = re.compile(r'^  m_Name: (.*)$', re.M)
# Inside a nested instance's modification list, a rename of an object of the prefab it nests. Which object is
# renamed is only known from the target identity, so the target is captured with the value.
INSTANCE_RENAME = re.compile(r'target: \{fileID: (-?\d+), guid: ([0-9a-f]{32})[^}]*\}'
                             r'\s*\n\s*propertyPath: m_Name\s*\n\s*value: (.*)')


def parse_hex(text):
    value = text.strip().lstrip('#')
    if len(value) != 6:
        return (0, 0, 0)
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def prefab_blocks(text):
    """Every serialized object in a prefab, keyed by the fileID Unity wrote for it."""
    marks = list(PREFAB_BLOCK.finditer(text))
    blocks = {}
    for index, mark in enumerate(marks):
        end = marks[index + 1].start() if index + 1 < len(marks) else len(text)
        blocks[int(mark.group(2))] = (int(mark.group(1)), mark.group(3) is not None, text[mark.end():end])
    return blocks


def prefab_instances(blocks):
    """(instance fileID, source prefab GUID, parent transform fileID) for every nested instance in a prefab."""
    found = []
    for file_id, (type_id, _stripped, body) in blocks.items():
        if type_id != 1001:
            continue
        source = SOURCE_PREFAB.search(body)
        parent = TRANSFORM_PARENT.search(body)
        found.append((file_id, source.group(1) if source else None,
                      int(parent.group(1)) if parent else 0, None))
    return found


class Prefabs:
    """The prefab assets of a project, addressed by the GUID a prefab override names them with.

    A saved variant writes a material override against the component's identity — the GUID of the asset that
    declares it and its fileID there — while the plan and the ledger name a hierarchy path. Keeping only the
    slot number is what let an override on one renderer read as the surface the plan declared, so the identity
    has to be resolved back to the renderer's own path, through every nested prefab instance it sits under.
    """

    def __init__(self, project):
        self.paths, self.texts, self.blocks, self._instances = {}, {}, {}, {}
        # Registry packages are not materialised under Packages/: Unity keeps them in Library/PackageCache, and
        # an outfit or a body that comes from a package is reached through one of those.
        for root in ('Assets', 'Packages', 'Library/PackageCache'):
            base = Path(project) / root
            if not base.is_dir():
                continue
            # Model prefabs imported from FBX keep their source identity on the .fbx asset rather than a
            # hand-authored .prefab. Unity readback is primary, but the fallback must be able to resolve a
            # textual model-prefab fixture when one is available.
            for meta in list(base.rglob('*.prefab.meta')) + list(base.rglob('*.fbx.meta')):
                match = META_GUID.search(meta.read_bytes()[:300])
                if match:
                    self.paths.setdefault(match.group(1).decode(), Path(str(meta)[:-len('.meta')]))

    def blocks_of(self, guid):
        if guid not in self.blocks:
            path = self.paths.get(guid)
            try:
                text = path.read_text(encoding='utf-8', errors='replace') if path else ''
            except OSError:
                text = ''
            self.texts[guid] = text
            self.blocks[guid] = prefab_blocks(text)
        return self.blocks[guid]

    def instances_of(self, guid):
        """The nested instances of this prefab, each with what it calls the root of what it nests.

        An instance's modification list may rename any object of the prefab it nests, so the rename that is
        this instance's own name is the one whose target is that prefab's root GameObject: taking the first
        m_Name entry would put a child's name at the root and move the whole path.
        """
        if guid not in self._instances:
            found = []
            for file_id, (type_id, _stripped, body) in self.blocks_of(guid).items():
                if type_id != 1001:
                    continue
                source = SOURCE_PREFAB.search(body)
                parent = TRANSFORM_PARENT.search(body)
                found.append((file_id, source.group(1) if source else None,
                              int(parent.group(1)) if parent else 0,
                              self.instance_rename(body, source.group(1) if source else None)))
            self._instances[guid] = found
        return self._instances[guid]

    def root_gameobject(self, guid):
        """The GameObject this prefab is rooted at, or None when it cannot be determined."""
        for file_id, (type_id, stripped, body) in self.blocks_of(guid).items():
            if stripped or type_id != 1:
                continue
            for match in COMPONENT_REF.finditer(body):
                candidate = self.blocks_of(guid).get(int(match.group(1)))
                if candidate is None or candidate[0] != 4:
                    continue
                father = FATHER_REF.search(candidate[2])
                if father is None or int(father.group(1)) == 0:
                    return file_id
        return None

    def instance_rename(self, body, source_guid):
        if source_guid is None:
            return None
        candidates = [(int(file_id), value.strip()) for file_id, guid, value in INSTANCE_RENAME.findall(body)
                      if guid == source_guid]
        root = self.root_gameobject(source_guid)
        if root is not None:
            return next((value or None for file_id, value in candidates if file_id == root), None)
        # The nested asset is not readable, so which entry is the root is unknown: one candidate is the root by
        # elimination, and more than one means the name cannot be established rather than guessed.
        return candidates[0][1] or None if len(candidates) == 1 else None

    def object_name(self, guid, file_id):
        entry = self.blocks_of(guid).get(file_id)
        if entry is None or entry[1] or entry[0] != 1:
            return None
        found = NAME_VALUE.search(entry[2])
        return found.group(1).strip() if found else None

    def chain(self, guid, file_id, prefix, rename=None, seen=frozenset()):
        """The GameObject names from this prefab's root down to the object, or None when it cannot be resolved.

        `prefix` is the chain above this prefab's own root, and `rename` is what the instance that pulled this
        prefab in calls its root — a nested instance may rename what it nests, and the plan names that name.
        """
        entry = self.blocks_of(guid).get(file_id)
        if entry is None:
            # A prefab variant declares only what it changed; every other object of it is the prefab it is a
            # variant of, and an outside reference still addresses that object with the variant's own GUID.
            roots = [row for row in self.instances_of(guid) if row[2] == 0 and row[1] and row[1] != guid]
            if guid in seen or not roots:
                return None
            found = []
            for _file_id, source, _parent, own in roots:
                result = self.chain(source, file_id, prefix, rename if rename is not None else own,
                                    seen | {guid})
                if result is not None and result not in found:
                    found.append(result)
            return found[0] if len(found) == 1 else None
        type_id, stripped, body = entry
        if stripped:
            source, instance = CORRESPONDING.search(body), INSTANCE_REF.search(body)
            if source is None or source.group(2) is None or instance is None:
                return None
            nested = next((row for row in self.instances_of(guid) if row[0] == int(instance.group(1))), None)
            if nested is None or nested[1] != source.group(2):
                return None
            head = prefix if nested[2] == 0 else self.chain(guid, nested[2], prefix, None, seen)
            if head is None:
                return None
            if nested[1] not in self.paths:
                # An instance at the root of this prefab is the avatar itself, and its own name is the one the
                # plan and the ledger drop; when the nested asset is not on disk the instance's rename is still
                # that name. Anywhere deeper the name lives in the missing asset, so the path is unknown.
                return head + [nested[3]] if nested[2] == 0 and nested[3] else None
            return self.chain(nested[1], int(source.group(1)), head, nested[3], seen | {guid})
        if type_id == 1:
            for match in COMPONENT_REF.finditer(body):
                candidate = self.blocks_of(guid).get(int(match.group(1)))
                if candidate is not None and candidate[0] == 4:
                    return self.chain(guid, int(match.group(1)), prefix, rename, seen)
            return None
        if type_id == 4:
            father = FATHER_REF.search(body)
            root = father is None or int(father.group(1)) == 0
            head = prefix if root else self.chain(guid, int(father.group(1)), prefix, rename, seen)
            if head is None:
                return None
            game_object = GAMEOBJECT_REF.search(body)
            name = self.object_name(guid, int(game_object.group(1))) if game_object else None
            if name is None:
                return None
            return head + [rename or name] if root else head + [name]
        game_object = GAMEOBJECT_REF.search(body)
        return None if game_object is None else self.chain(guid, int(game_object.group(1)), prefix, rename, seen)

    def instance_prefixes(self, guid, target, prefix, seen):
        """Every chain of names above an instance of `target` inside this prefab tree."""
        out = []
        for _file_id, source, parent, rename in self.instances_of(guid):
            if source is None or source in seen:
                continue
            head = prefix if parent == 0 else self.chain(guid, parent, prefix)
            if head is None:
                continue
            if source == target:
                out.append((head, rename))
            out.extend(self.instance_prefixes(source, target, head, seen | {source}))
        return out

    def renderer_path(self, variant_text, guid, file_id):
        """The path a prefab override names, as the plan and the ledger write paths, or None.

        None means the identity could not be resolved — an unreadable asset, a proxy whose instance is not
        there, or the same identity reached by more than one route, which is what two instances of one prefab
        look like. None is not "the declared surface": an override nobody can place is refused, not accepted.
        """
        roots = [row for row in prefab_instances(prefab_blocks(variant_text)) if row[2] == 0 and row[1]]
        found = set()
        for _file_id, source, _parent, rename in roots:
            starts = [([], rename)] if source == guid else self.instance_prefixes(source, guid, [], {source})
            for head, nested_rename in starts:
                chain = self.chain(guid, file_id, head, nested_rename if source != guid else rename)
                if chain is not None:
                    found.add('/'.join(chain))
        if len(found) != 1:
            return None
        # The variant's own root is the avatar, and the plan and the ledger both measure from below it.
        chain = found.pop()
        return chain.split('/', 1)[1] if '/' in chain else ''


TEXTURE_PROPERTIES = ('_MainTex', '_BaseMap', '_BaseColorMap')
TEXENV = re.compile(r'^\s+-\s+(_[A-Za-z0-9_]+):\s*\n\s+m_Texture:\s*\{fileID:\s*(-?\d+)(?:,\s*guid:\s*([0-9a-f]{32}))?', re.M)


def material_texture_guids(project, material_guid):
    """The texture GUIDs a material asset's texture properties point at, or None if the asset is missing."""
    if not material_guid:
        return None
    material = next((path for path in project.rglob('*.mat')
                     if path.name == f'{material_guid}.mat' or guid_of(path) == material_guid), None)
    if material is None:
        return None
    text = material.read_text(encoding='utf-8', errors='replace')
    return {guid for name, _file_id, guid in TEXENV.findall(text) if name in TEXTURE_PROPERTIES and guid}


def material_points_at(project, rows, output):
    """True when every material the rows name really reads the produced texture.

    A ledger row saying a slot was bound is the executor's own account of what it did, and the whole point
    of an observer is not to take that account. So the material asset itself is read: a texture property
    that resolves to the product's GUID is evidence, and a row that claims one without it is not. Every
    row has to carry that evidence rather than one row among them: with one row checked, a ledger whose
    remaining rows name materials that never saw the product still reads as bound (R6 第 4 项).
    """
    wanted = guid_of(output)
    if not wanted:
        return False
    found = False
    for row in rows:
        guids = material_texture_guids(project, row.get('material_guid'))
        if not guids or wanted not in guids:
            return False
        found = True
    return found


def layer_guids(project):
    guids = set()
    for meta in (project / LAYER).rglob('*.meta'):
        match = META_GUID.search(meta.read_bytes()[:300])
        if match:
            guids.add(match.group(1).decode())
    return guids


def script_versioned(tool_root, rel):
    """(是否可复现, 来源)：配方脚本受 git 跟踪，或位于带清单的受管能力包里（包不可变、按内容哈希冻结），都算受管。"""
    if not (tool_root / rel).is_file():
        return False, 'missing'
    tracked = subprocess.run(['git', '-C', str(tool_root), 'ls-files', '--error-unmatch', rel],
                             capture_output=True, text=True)
    if tracked.returncode == 0:
        return True, 'git'
    for parent in (tool_root, *tool_root.parents):
        manifest = parent / 'pack.json'
        if manifest.is_file():
            info = read_json(manifest) or {}
            if info.get('schema') == 'harness-managed-pack/0.1' and info.get('id') and info.get('version'):
                return True, f"managed-pack:{info['id']}@{info['version']}"
            break
    return False, 'untracked'


def current_readback(project, run, plan, regions=False):
    report = read_json(run / 'observations/material-selection-readback.json') or {}
    if not isinstance(report, dict):
        report = {}
    files = report.get('files') if isinstance(report.get('files'), dict) else {}
    required = set()
    targets = (plan.get('recolor') or {}).get('targets', [])
    if any('material' in t for t in targets):
        required.update({str(LAYER / 'Avatar.prefab').replace('\\', '/'), 'Assets/_Harness/Outfit/Avatar.prefab',
                         'Assets/_Harness/Outfit/outfit.json', str(LAYER / 'recipe.json').replace('\\', '/')})
        required.update(t['material'] for t in targets if 'material' in t)
        required.update('Assets/_Harness/Recolor/MemberPresets/' + m['id'] + '.anim'
                        for g in (plan.get('avatar_config') or {}).get('groups', []) for m in g.get('members', []))
    presets = (plan.get('avatar_config') or {}).get('material_presets', [])
    required.update(b['source_material'] for g in (plan.get('avatar_config') or {}).get('groups', []) if g.get('kind') == 'material' for b in g.get('bindings', []))
    if presets:
        required.add('Assets/_Harness/Recolor/AxisPresets/presets.json')
    for preset in presets:
        required.add(preset['material'])
        if 'adjustment' in preset:
            required.add('Assets/_Harness/Recolor/AxisPresets/' + preset['id'] + '.mat')
    region_files = {}
    if regions:
        required.update({str(LAYER / 'Avatar.prefab').replace('\\', '/'), str(LAYER / 'region-apply.json').replace('\\', '/'),
                         str(LAYER / 'ledger.json').replace('\\', '/')})
        region_record = read_json(project / LAYER / 'region-apply.json') or {}
        for group in region_record.get('groups') or []:
            for field in ('textureAsset', 'outputAsset', 'meshAsset'):
                if group.get(field): required.add(str(group[field]).replace('\\', '/'))
            required.update(str(operation['maskAsset']).replace('\\', '/')
                            for operation in group.get('operations') or [] if operation.get('maskAsset'))
        nested = report.get('region_bindings')
        if isinstance(nested, dict):
            region_files = nested.get('files') if isinstance(nested.get('files'), dict) else {}
            required.update(path + '.meta' for path in list(required) if (project / (path + '.meta')).is_file())
    required.update(path + '.meta' for path in list(required) if (project / (path + '.meta')).is_file())
    outer_schema_ok = report.get('schema') == 'material-selection-readback/0.1'
    outer_required_ok = required <= files.keys()
    outer_plan_ok = report.get('plan_sha256') == hashlib.sha256(os.environ.get('AVH_PLAN', '{}').encode()).hexdigest()
    current = outer_schema_ok and outer_required_ok
    current = current and outer_plan_ok
    if regions:
        nested_present = isinstance(report.get('region_bindings'), dict)
        current = current and nested_present
        nested = report.get('region_bindings') or {}
        nested_schema_ok = nested.get('schema') == 'region-binding-readback/0.1'
        nested_plan_ok = nested.get('plan_sha256') == hashlib.sha256(os.environ.get('AVH_PLAN', '{}').encode()).hexdigest()
        nested_subset_ok = set(region_files) <= set(files)
        nested_required_ok = set(required) <= set(region_files)
        current = current and nested_schema_ok
        current = current and nested_plan_ok
        current = current and nested_subset_ok
        current = current and nested_required_ok
    else:
        nested_present = nested_schema_ok = nested_plan_ok = nested_subset_ok = nested_required_ok = True
    for path, sha in files.items():
        asset = project / path
        if not asset.is_file() or asset.is_symlink() or not asset.resolve().is_relative_to(project.resolve()) or digest(asset) != sha:
            current = False
    for path, sha in region_files.items():
        asset = project / path
        if not asset.is_file() or asset.is_symlink() or not asset.resolve().is_relative_to(project.resolve()) or digest(asset) != sha:
            current = False
    return report, bool(current)


def material_axis_selection(project, run, plan):
    """Exact configured coverage plus saved default readback; stale or missing proof blocks."""
    groups = [g for g in (plan.get('avatar_config') or {}).get('groups', []) if g.get('kind') == 'material']
    if not groups:
        return True, set(), set()
    report, current = current_readback(project, run, plan)
    record = read_json(project / 'Assets/_Harness/Outfit/outfit.json') or {}
    expected = set()
    preset_map = {p['id']: p for p in (plan.get('avatar_config') or {}).get('material_presets', [])}
    expected_guids = {}
    for group in groups:
        for member in group['members']:
            for binding in group['bindings']:
                rows = [r for r in record.get('outfits', []) if r.get('instance') == binding['instance']]
                if not rows:
                    return False, set(), set()
                for row in rows:
                    path = row['object'] + ('/' + binding['renderer'] if binding['renderer'] else '')
                    expected.add((group['id'], member['id'], binding['id'], path, binding['slot'], member['id'] == group['default']))
                    preset = preset_map[member['materials'][binding['id']]]
                    material = 'Assets/_Harness/Recolor/AxisPresets/' + preset['id'] + '.mat' if 'adjustment' in preset else preset['material']
                    expected_guids[(group['id'], member['id'], binding['id'], path, binding['slot'])] = guid_of(project / material)
    entries = report.get('material_axis_bindings', [])
    actual = [(r.get('group'), r.get('member'), r.get('binding'), r.get('renderer'), r.get('slot'), r.get('default')) for r in entries]
    valid = current and len(actual) == len(expected) and set(actual) == expected
    valid = valid and all(expected_guids.get((r.get('group'), r.get('member'), r.get('binding'), r.get('renderer'), r.get('slot'))) == r.get('expected_guid')
                         and r.get('expected_guid') and (not r.get('default') or r.get('expected_guid') == r.get('actual_guid')) for r in entries)
    defaults = [r for r in entries if r.get('default')]
    return bool(valid), {r['expected_guid'] for r in defaults} if valid else set(), {(r['renderer'], r['slot']) for r in defaults} if valid else set()


def material_selection(project, run, plan, materials, ledger, metrics, proof):
    """Use the Runtime's separate Unity reload, bound to the current plan and asset bytes.

    The execution ledger never grants an exemption. Missing or stale readback fails closed;
    a GUID used outside the resolved slot set also retains the isolation checks.
    """
    wanted = materials
    metrics.update(material_plan_unverified=len(wanted), material_bindings_missing=0, material_write_conflicts=0)
    if not wanted:
        return set(), set(), None
    report, current = current_readback(project, run, plan)
    proof['material_selection_current'] = bool(current)
    if not current:
        metrics['material_bindings_missing'] = len(wanted)
        return set(), set(), None
    bindings, slots = report.get('bindings', []), report.get('slots', [])
    grouped = bool(plan.get('avatar_config'))
    def slot_key(row, member=None):
        return (row.get('renderer'), row.get('slot'), row.get('member', member) if grouped else None)
    slot_map = {slot_key(s): s.get('material_guid') for s in slots}
    rows = (ledger or {}).get('rows', [])
    verified, exempt_slots = set(), set()
    for target in wanted:
        guid = guid_of(project / target['material'])
        selected = [b for b in bindings if b.get('requirement_id') == target.get('requirement_id') and b.get('outfit') == target.get('outfit')]
        recorded = [r for r in rows if r.get('requirement_id') == target.get('requirement_id') and r.get('outfit') == target.get('outfit')]
        expected = {slot_key(b, target.get('outfit')) for b in selected}
        actual = {slot_key(r, target.get('outfit')) for r in recorded}
        valid = guid and expected and expected == actual and len(recorded) == len(expected)
        valid = valid and all(b.get('expected_guid') == guid and b.get('actual_guid') == guid
                              and slot_map.get(slot_key(b, target.get('outfit'))) == guid for b in selected)
        valid = valid and all(r.get('material_guid') == guid for r in recorded)
        if valid:
            verified.add('material:' + str(target.get('requirement_id')))
            exempt_slots.update(expected)
        else:
            metrics['material_bindings_missing'] += 1
    metrics['material_plan_unverified'] = sum(not any(b.get('requirement_id') == t.get('requirement_id')
        and b.get('outfit') == t.get('outfit') for b in bindings) for t in wanted)
    writers = defaultdict(set)
    for row in rows:
        part = row.get('part') or 'material:' + str(row.get('requirement_id'))
        scope = row.get('outfit') or (part[7:] if part.startswith('outfit:') else '') if grouped else ''
        writers[(row.get('renderer'), row.get('slot'), scope)].add(part)
    if grouped:
        for key, values in list(writers.items()):
            if key[2]: values.update(writers.get((key[0], key[1], ''), set()))
    # Relative iris colour and a layered main texture can share one copy. A material
    # selection replaces that entire slot, so only its overlap with another writer conflicts.
    metrics['material_write_conflicts'] = sum(len(w) > 1 and any(writer.startswith('material:') for writer in w)
                                              for w in writers.values())
    safe = {s.get('material_guid') for s in slots if slot_key(s) in exempt_slots}
    safe = {guid for guid in safe if all(slot_key(s) in exempt_slots
                                       for s in slots if s.get('material_guid') == guid
                                       and s.get('material_guid') != s.get('original_guid'))}
    changed = {slot_key(s) for s in slots if s.get('material_guid')
               and s.get('material_guid') != s.get('original_guid')} | exempt_slots
    proof['material_selection_bindings'] = bindings
    return verified, safe, len(changed)


def load_module(path, name):
    """Load a sibling tool by path, the way the classifier and the recipe are loaded.

    Not `import name`: the observer is copied to project-relative paths and the tool root may be a fixture
    that ships only the script under test, so whichever `layer_source` happened to be importable would be
    the wrong file. One helper rather than three copies of the same four lines.
    """
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        sys.exit(f'无法加载 {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REGION_SCHEMA = 'mesh-region-apply/0.2'
REGION_FIELDS = ('renderer', 'submesh', 'bones', 'color', 'semantics')


def layer_expected_pixels(before, mask, color, semantics):
    """What the layer route's declared algorithm must leave, computed from the original and the mask.

    The layer route blends a soft mask, so its product is not "the target inside the mask" but the mask's own
    weighted mix; computing that mix here is the difference between checking the promise and checking that
    something happened. The one thing this cannot supply is the mask itself, which comes from the author's
    file and is read back as evidence with its own hash.
    """
    import numpy
    if semantics not in ('flat', 'shade'):
        raise ValueError(f'不支持的改色语义：{semantics}')
    target = numpy.array(parse_hex(str(color)), dtype=numpy.float64)
    region = before[:, :, :3].astype(numpy.float64)
    if semantics == 'flat':
        blended = numpy.broadcast_to(target, region.shape)
    else:
        ratio = region.max(axis=2, keepdims=True) / max(float(target.max()), 1.0)
        blended = numpy.clip(target * ratio, 0, 255)
    weight = (mask.astype(numpy.float64) / 255.0)[:, :, None]
    return numpy.clip(region * (1 - weight) + blended * weight, 0, 255).round().astype(numpy.uint8)


def region_plan(region_targets):
    """The approved plan's region requirements, grouped by the surface each one names.

    The plan is the only place a region is defined. If the executor's record were allowed to define it too,
    then a record and a product made from the same wrong region would agree with each other and every other
    check would pass: keep the recipe right, write the wrong bones into the record together with a product
    painted on those wrong bones, and nothing here would notice (R6 第 4 项). So the expected operations are
    built from the plan, and the record is asked to match them item by item.
    """
    groups, problems, seen = {}, [], set()
    for target in region_targets:
        requirement = str(target.get('requirement_id'))
        region = target.get('region') or {}
        surface = (str(region.get('renderer')), int(region.get('submesh')))
        if requirement in seen:
            problems.append(f'批准方案里有两条区域需求同名：{requirement}')
        seen.add(requirement)
        groups.setdefault(surface, []).append({
            'requirement_id': requirement, 'bones': [str(bone) for bone in (region.get('bones') or [])],
            'color': str(target.get('color')), 'semantics': str(target.get('semantics'))})
    return groups, problems


def operation_mismatches(where, operation, entry, surface):
    """Every field a record claims about an operation, against the plan's own words for it."""
    declared = {'renderer': str(operation.get('renderer')), 'submesh': operation.get('submesh'),
                'bones': [str(bone) for bone in (operation.get('bones') or [])],
                'color': str(operation.get('color')), 'semantics': str(operation.get('semantics'))}
    expected = {'renderer': surface[0], 'submesh': surface[1], 'bones': entry['bones'],
                'color': entry['color'], 'semantics': entry['semantics']}
    return [f'{where}: 需求 {entry["requirement_id"]} 的 {field} 与批准方案不符：'
            f'{declared[field]!r} ≠ {expected[field]!r}'
            for field in REGION_FIELDS if declared[field] != expected[field]]


def expected_pixels(before, core, semantics, target):
    """What the declared algorithm must leave on these pixels, computed from the original.

    `flat` and `shade` make two different promises, so they get two different computations rather than one
    predicate loose enough to be satisfied without doing the work. `shade` keeps the author's own light and
    shade by scaling **the target colour's** channels with the pixel's own brightness — its brightest channel
    over the target's brightest channel — which is the expression the stage evaluates. Scaling the *original*
    pixel's channels instead is a different promise, and one an untouched region already satisfies: whenever a
    pixel's brightest channel equals the target's, that formula demands exactly the pixel that is already
    there, so a region nobody recoloured reads as a correct shade. Counting how many distinct channel values
    survive is not a check of that promise either — an untouched gradient has as many values as a correctly
    shaded one, and a correctly shaded region of one flat colour has exactly one (R6 第 6 项、R6b 第 1 项).

    The rounding is stated rather than inherited: `floor(x + 0.5)` is one expression with one meaning, where
    C#'s `Math.Round` and Python's `round` are two different halfway rules that would disagree on the boundary.
    """
    import numpy
    if semantics == 'flat':
        return numpy.broadcast_to(numpy.array(target, dtype=numpy.int16), (int(core.sum()), 3))
    light = before[core][:, :3].astype(numpy.float64).max(axis=1)
    aim = numpy.array(target, dtype=numpy.float64)
    ratio = light / float(max(max(target), 1))
    return numpy.clip(numpy.floor(aim[None, :] * ratio[:, None] + 0.5), 0, 255).astype(numpy.int16)


def override_bindings(project, overrides, variant_text):
    """(renderer, slot, material) for every slot the saved variant writes, and the identities it cannot place.

    Two overrides on the same slot number with the same material are the same entry to a reader that keeps only
    those two fields, which is how an override on another renderer passed as the declared surface. The
    renderer's path is what separates them, so it is resolved from the identity each override carries.
    """
    prefabs = Prefabs(project) if overrides else None
    resolved, unresolved, names = set(), [], {}
    for file_id, guid, slot, material in overrides:
        if not material:
            continue
        if (guid, file_id) not in names:
            names[(guid, file_id)] = prefabs.renderer_path(variant_text, guid, file_id)
        name = names[(guid, file_id)]
        if name is None:
            unresolved.append(f'{guid[:8]}… fileID {file_id}')
        else:
            resolved.add((name, slot, material))
    return resolved, unresolved


def region_binding_problem(project, rows, output, written, surface):
    """Why the binding is not proven, or None when it is.

    Four things have to hold, none of them taken from the row's word: the row names a material that really
    reads the product; that material really sits in the slot the row names **on the renderer the row names** in
    the saved variant; the surface the plan named is one of the slots bound; and the surface is the one the plan
    declared. Finding *some* material that mentions the product is not the check — a ledger whose remaining rows
    name materials that never saw it would pass that (R6 第 4 项) — and reading the variant's slot list without
    the renderer's identity in it is not the check either: an override on a different renderer has the same slot
    number and the same material, and accepted a binding nobody wrote (R6b 第 2 项).
    """
    if not rows:
        return '没有任何台账行'
    wanted = guid_of(output)
    for row in rows:
        guids = material_texture_guids(project, row.get('material_guid'))
        if not guids or wanted not in guids:
            return f"台账行的材质 {row.get('material_guid')} 的贴图属性没有指向产物"
        if (row.get('renderer'), row.get('slot'), row.get('material_guid')) not in written:
            return (f"台账行声明的槽在变体里不是这个渲染器上的这个材质：{row.get('renderer')} 槽 {row.get('slot')} "
                    f"（台账不能自证槽位，覆盖项的身份要能解析到同一个渲染器）")
    places = {(row.get('renderer'), row.get('slot')) for row in rows}
    if surface not in places:
        return f'台账里没有 {surface[0]} 槽 {surface[1]} 这一行，绑定的不是这块表面'
    # This requirement declared one surface, so a row that really does bind the product somewhere else is a
    # second binding nobody asked for — the recipe put this texture on one slot and the region was derived from
    # that slot's triangles only. Every row above is provable, which is exactly why this has to be said here.
    if places - {surface}:
        return f'台账把这块表面的产物也绑到了别的表面上：{sorted(places - {surface})}'
    return None


def verify_regions(project, ledger, region_targets, module, metrics, proof, notes, overrides=(), variant_text=None,
                   unity_readback=None, unity_readback_current=False):
    """Read the products back and recompute the regions from the mesh and the approved plan.

    The checks are the same promises the layer route makes, plus the one only this route can break: a pixel
    that belongs to two regions must not be painted by either. Locality alone would not catch that, because
    such a pixel is inside both regions; so the observer separates "outside every region" from "inside a
    region's footprint but owned by none". A pixel a *triangle* with two owners covers is the same finding and
    is subtracted from every region's paint set by the shared derivation, not only dropped from the assignment.
    """
    wanted = ['region:' + str(target.get('requirement_id')) for target in region_targets]
    metrics.update(region_operations_verified=0, region_mask_mismatches=0, region_alpha_moved=0,
                   region_outside_mask_changed=0, region_cross_painted_pixels=0, region_semantics_violations=0,
                   region_bindings_missing=0, region_ambiguous_pixels=0, region_record_mismatches=0,
                   region_transparent_rgb_changed=0, region_write_conflicts=0)
    metrics['region_unverified_operations'] = len(wanted)
    # Every reading is set before anything is imported. A plan with no region target on a machine without NumPy
    # or Pillow is the ordinary case for every recolour that does not use this route, and it must not be blocked
    # by a module only this route needs (R6 第 3 项).
    if not wanted:
        if read_json(project / LAYER / 'region-apply.json') is not None:
            notes.append('存在 region-apply.json，但方案里没有按区域目标')
        return
    record = read_json(project / LAYER / 'region-apply.json')
    if record is None:
        metrics['region_operations_verified'] = None
        notes.append('方案有按区域目标，但没有 region-apply.json：按区域改色的产物缺失')
        return
    import numpy
    from PIL import Image
    expected, problems = region_plan(region_targets)
    if record.get('schema') != REGION_SCHEMA:
        problems.append(f"区域产物记录的 schema 不是 {REGION_SCHEMA}：{record.get('schema')}")
        metrics['region_record_mismatches'] += 1
    rows_by_part = defaultdict(list)
    for row in (ledger or {}).get('rows', []):
        rows_by_part[row.get('part')].append(row)
    # Prefer the Unity reload readback. It is the authority for model prefabs, FBX-backed renderers and stripped
    # instance identities; YAML identity parsing remains a refusal-oriented fallback for older runs without that
    # evidence, never a second source of truth when Unity has already produced a readback.
    readback_surface_ok = {}
    readback_error = None
    written = set()
    try:
        _diagnostic_written, unresolved = override_bindings(project, overrides, variant_text or '')
        if unresolved:
            notes.append('YAML 绑定诊断仍无法解析到渲染器：' + '、'.join(unresolved[:5]))
    except Exception as error:
        notes.append('YAML 绑定诊断失败：' + str(error))
    if not isinstance(unity_readback, dict):
        readback_error = '缺少独立 Unity 区域绑定读回报告，YAML 解析只作诊断不能放行'
    elif not unity_readback_current:
        readback_error = '独立 Unity 区域绑定读回报告缺失、损坏或已过期，YAML 解析不能放行'
    else:
        expected_plan = hashlib.sha256(os.environ.get('AVH_PLAN', '{}').encode()).hexdigest()
        if unity_readback.get('schema') != 'region-binding-readback/0.1':
            readback_error = f"Unity 区域绑定读回 schema 不符：{unity_readback.get('schema')}"
        elif unity_readback.get('plan_sha256') != expected_plan:
            readback_error = 'Unity 区域绑定读回不是当前批准方案的证据'
        else:
            file_hashes = unity_readback.get('files') or {}
            for path, expected_hash in file_hashes.items():
                candidate = project / str(path)
                if not candidate.is_file() or expected_hash != digest(candidate):
                    readback_error = f'Unity 区域绑定读回依赖文件已变化：{path}'
                    break
            declared = defaultdict(set)
            for row in unity_readback.get('declared') or []:
                output_guid = str(row.get('output_guid') or '')
                surface = (str(row.get('renderer')), int(row.get('slot')))
                if not output_guid:
                    readback_error = 'Unity 区域绑定读回缺少区域产物 GUID'
                    break
                declared[output_guid].add(surface)
            actual = defaultdict(set)
            actual_written = set()
            for row in unity_readback.get('actual') or []:
                output_guid = str(row.get('texture_guid') or '')
                surface = (str(row.get('renderer')), int(row.get('slot')))
                material_guid = str(row.get('material_guid') or '')
                if not output_guid or not material_guid:
                    readback_error = 'Unity 区域绑定读回有不完整的 Renderer/槽/材质/贴图项'
                    break
                actual[output_guid].add(surface)
                actual_written.add((surface[0], surface[1], material_guid))
            if readback_error is None:
                for output_guid, surfaces_for_output in declared.items():
                    readback_surface_ok[output_guid] = actual.get(output_guid, set()) == surfaces_for_output
                    if not readback_surface_ok[output_guid]:
                        readback_error = (f'区域产物 {output_guid[:8]}… 的实际绑定集合与声明不符：'
                                          f'{sorted(actual.get(output_guid, set()))} ≠ {sorted(surfaces_for_output)}')
                        break
                if readback_error is None:
                    extras = set(actual) - set(declared)
                    if extras:
                        readback_error = '最终变体绑定了方案未声明的区域产物：' + '、'.join(g[:8] for g in sorted(extras))
                    else:
                        for output_guid, surfaces_for_output in actual.items():
                            if output_guid in declared and surfaces_for_output != declared[output_guid]:
                                readback_error = '最终变体在声明表面之外绑定了区域产物'
                                break
            written = actual_written if readback_error is None else set()
    if readback_error:
        notes.append('独立 Unity 区域绑定读回未通过：' + readback_error)
    surfaces, textures = [], defaultdict(int)
    verified = alpha_ok = local_ok = owned_ok = semantics_ok = bound_ok = recomputed = 0
    ambiguous = 0
    readback = []
    for group in record.get('groups') or []:
        submesh = group.get('submesh')
        where = f"{group.get('renderer')} 子网格 {submesh}"
        surface = (str(group.get('renderer')), submesh)
        if surface in surfaces:
            problems.append(f'{where}: 记录里同一块表面出现了两组')
            metrics['region_record_mismatches'] += 1
            continue
        surfaces.append(surface)
        textures[str(group.get('textureAsset'))] += 1
        if surface not in expected:
            problems.append(f'{where}: 记录里的这块表面不在批准方案里')
            metrics['region_record_mismatches'] += 1
            continue
        plan_ops = expected[surface]
        by_id = {}
        for operation in group.get('operations') or []:
            requirement = str(operation.get('requirement_id'))
            if requirement in by_id:
                problems.append(f'{where}: 需求 {requirement} 在记录里出现了不止一次')
                metrics['region_record_mismatches'] += 1
                continue
            by_id[requirement] = operation
        plan_ids = [entry['requirement_id'] for entry in plan_ops]
        for requirement in plan_ids:
            if requirement not in by_id:
                problems.append(f'{where}: 批准方案里的需求 {requirement} 在记录里没有对应操作')
                metrics['region_record_mismatches'] += 1
        for requirement in by_id:
            if requirement not in plan_ids:
                problems.append(f'{where}: 记录里的需求 {requirement} 不在批准方案里')
                metrics['region_record_mismatches'] += 1
        for entry in plan_ops:
            operation = by_id.get(entry['requirement_id'])
            if operation is not None:
                found = operation_mismatches(where, operation, entry, surface)
                problems.extend(found)
                metrics['region_record_mismatches'] += len(found)
        original, output = project / str(group.get('textureAsset')), project / str(group.get('outputAsset'))
        mesh_path = project / str(group.get('meshAsset')) if group.get('meshAsset') else None
        if not output.is_file() or not original.is_file() or mesh_path is None or not mesh_path.is_file():
            problems.append(f'{where}: 原图、产物或网格数据不在工程里')
            continue
        if digest(output) != group.get('outputSha256') or digest(mesh_path) != group.get('meshSha256'):
            problems.append(f'{where}: 产物或网格数据与执行器记录的哈希不符')
            continue
        # The mesh datum is the geometry both sides derive from, so it has to be the surface and the texture the
        # plan and the record name: otherwise everything recomputed below is about a different thing.
        try:
            datum = module.load_mesh_datum(mesh_path)
        except SystemExit as error:
            problems.append(f'{where}: 网格数据无法读取（{error}）')
            continue
        if (str(datum.get('renderer')), datum.get('submesh')) != surface:
            problems.append(f"{where}: 网格数据是另一块表面的（{datum.get('renderer')} 子网格 {datum.get('submesh')}）")
            metrics['region_record_mismatches'] += 1
            continue
        if str((datum.get('texture') or {}).get('asset')) != str(group.get('textureAsset')):
            problems.append(f"{where}: 网格数据来自另一张贴图（{(datum.get('texture') or {}).get('asset')}）")
            metrics['region_record_mismatches'] += 1
            continue
        if int(group.get('width') or 0) != datum['width'] or int(group.get('height') or 0) != datum['height']:
            problems.append(f'{where}: 记录里的贴图尺寸与网格数据不符')
            metrics['region_record_mismatches'] += 1
        before, after = decode(original), decode(output)
        if before.shape != after.shape:
            problems.append(f'{where}: 产物尺寸与原图不同')
            continue
        # The mask is derived at the size of the file the project shipped, so the file and the datum have to
        # agree on that size or the two are not describing the same pixels (R6 第 1 项).
        if before.shape[:2] != (datum['height'], datum['width']):
            problems.append(f"{where}: 原图尺寸与网格数据的贴图尺寸不同（{before.shape[1]}×{before.shape[0]}"
                            f" / {datum['width']}×{datum['height']}）")
            continue
        # The regions are derived from the plan's bones and the exported mesh, and from nothing else.
        try:
            footprints, paints, _report = module.region_paint_masks(
                datum, [(entry['requirement_id'], entry['bones']) for entry in plan_ops])
        except SystemExit as error:
            problems.append(f'{where}: 网格数据无法重算区域（{error}）')
            continue
        recomputed += 1
        union = numpy.zeros(footprints[0].shape, dtype=bool)
        footprint = numpy.zeros(union.shape, dtype=bool)
        for index in range(len(footprints)):
            union |= paints[index]
            footprint |= footprints[index]
        for index in range(len(footprints)):
            for other in range(index + 1, len(footprints)):
                ambiguous += int((footprints[index] & footprints[other]).sum())
        changed = numpy.abs(after.astype(numpy.int16) - before.astype(numpy.int16)).max(axis=2) > 0
        # "Outside every region" is measured against the union of the regions themselves, not against the set
        # they are allowed to paint: a pixel two regions both claim is *inside* both of them, and calling it
        # outside would report one finding twice and make the locality reading mean something else.
        outside = int((changed & ~footprint).sum())
        owned = int((changed & footprint & ~union).sum())
        if outside:
            metrics['region_outside_mask_changed'] += 1
            problems.append(f'{where}: 在所有区域之外改了 {outside} 个像素')
        # A pixel inside a region's footprint but owned by no region is one two regions both claim, or one a
        # triangle with two owners covers. Painting it anyway is exactly the failure this route exists to
        # prevent: one eye's colour lands on the other.
        if owned:
            metrics['region_cross_painted_pixels'] += owned
            problems.append(f'{where}: 把颜色上到了没有唯一归属的像素上：{owned} 个')
        for index, entry in enumerate(plan_ops):
            key = 'region:' + entry['requirement_id']
            operation = by_id.get(entry['requirement_id'])
            if operation is None:
                continue
            mask_path = project / str(operation.get('maskAsset')) if operation.get('maskAsset') else None
            if mask_path is None or not mask_path.is_file():
                problems.append(f'{key} 没有蒙版产物，无法独立核对区域')
                continue
            stored = numpy.asarray(Image.open(mask_path).convert('L')) > 0
            if stored.shape != paints[index].shape:
                problems.append(f'{key} 的蒙版尺寸与产物不同')
                continue
            if not numpy.array_equal(stored, paints[index]):
                metrics['region_mask_mismatches'] += 1
                problems.append(f'{key} 的蒙版与按批准方案重算的 UV 足迹不一致：'
                                f'差 {int((stored ^ paints[index]).sum())} 个像素（执行器的蒙版不是这个区域）')
                continue
            verified += 1
            if not (before[:, :, 3] == after[:, :, 3]).all():
                problems.append(f'{key} 的 alpha 被改动')
            else:
                alpha_ok += 1
            if not outside:
                local_ok += 1
            if not owned:
                owned_ok += 1
            core = paints[index]
            # A fully transparent pixel carries no colour, so it has none to change: the stage must leave those
            # bytes alone, and so must the check that reads them (R6 第 6 项).
            hidden = core & (before[:, :, 3] == 0)
            visible = core & (before[:, :, 3] != 0)
            if hidden.any():
                moved = int((numpy.abs(after[hidden][:, :3].astype(numpy.int16)
                                       - before[hidden][:, :3].astype(numpy.int16)).max(axis=1) > 0).sum())
                if moved:
                    metrics['region_transparent_rgb_changed'] += 1
                    problems.append(f'{key} 改了 {moved} 个全透明像素的 RGB（那里没有颜色可改）')
            # The promise is checked on the pixels that carry colour: the declared algorithm's own output is
            # computed here from the original, and the product has to be that, not merely varied or merely flat.
            if not visible.any():
                problems.append(f'{key} 的区域在贴图上没有一个可见像素，声明的 {entry["semantics"]} 无从核对')
            else:
                want_rgb = expected_pixels(before, visible, entry['semantics'], parse_hex(entry['color']))
                got_rgb = after[visible][:, :3].astype(numpy.int16)
                if numpy.array_equal(got_rgb, want_rgb):
                    semantics_ok += 1
                else:
                    worst = int(numpy.abs(got_rgb - want_rgb).max())
                    problems.append(f'{key} 声明 {entry["semantics"]} 但区域像素与按该语义算出的颜色不同，'
                                    f'最大差 {worst}')
            # The sampling mask is the region itself, never the composite's alpha: reading the whole sheet's
            # coverage is how two different eyes once read back as one skin colour (案例：异色瞳回读两边同色).
            readback.append({'requirement_id': entry['requirement_id'], 'color': entry['color'],
                             'semantics': entry['semantics'], 'regionPixels': int(core.sum()),
                             'opaquePixels': int(visible.sum()),
                             'meanBefore': [round(float(v), 2) for v in before[visible][:, :3].mean(axis=0)] if visible.any() else None,
                             'meanAfter': [round(float(v), 2) for v in after[visible][:, :3].mean(axis=0)] if visible.any() else None})
            reason = region_binding_problem(project, rows_by_part.get(key, []), output, written, surface)
            if readback_error or not readback_surface_ok.get(guid_of(output), False):
                reason = '独立 Unity 回读没有证明该区域产物只绑定到声明的完整表面集合'
            if reason:
                problems.append(f'{key} 的绑定没有被证明：{reason}')
            else:
                bound_ok += 1
    # Ambiguity is counted from the mesh and the region definitions, not read from the stage's record: a record
    # that under-reports it is caught by the number the observer derives for itself.
    metrics['region_ambiguous_pixels'] = int(ambiguous)
    metrics['region_operations_verified'] = verified
    metrics['region_alpha_moved'] = max(0, verified - alpha_ok)
    metrics['region_outside_mask_changed'] = max(0, verified - local_ok)
    metrics['region_semantics_violations'] = max(0, verified - semantics_ok)
    metrics['region_bindings_missing'] = max(0, verified - bound_ok)
    metrics['region_unverified_operations'] = max(0, len(wanted) - verified)
    metrics['region_cross_painted_pixels'] = max(metrics['region_cross_painted_pixels'], max(0, verified - owned_ok))
    # One source texture written by two groups: ownership is derived inside one surface, so the union of two
    # groups' regions is not something either derivation can prove. Refusing is the honest reading (R6 第 5 项).
    metrics['region_write_conflicts'] = sum(1 for count in textures.values() if count > 1)
    if metrics['region_write_conflicts']:
        problems.append('同一张源贴图被两组区域分别写入：归属是逐块表面算的，这一组合不能证明安全')
    proof['region_readback'] = readback
    if isinstance(unity_readback, dict):
        proof['region_binding_readback'] = unity_readback
    proof['region_binding_readback_current'] = bool(unity_readback_current and isinstance(unity_readback, dict))
    proof['region_masks_recomputed'] = recomputed
    notes.extend(problems)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    project, run = Path(os.environ['AVH_PROJECT_DIR']), Path(os.environ.get('AVH_RUN_DIR', '.'))
    tool_root = Path(os.environ.get('AVH_TOOL_ROOT', Path(__file__).resolve().parent.parent))
    plan = json.loads(os.environ.get('AVH_PLAN') or '{}')
    # A target that is not an object has no form and cannot be measured, so it is refused here with the same message
    # the plan gate gives, before anything is read from the project or written to --out. The classifier is loaded
    # the way the recipe module below is loaded rather than by importing `plan` off this file's own directory:
    # the observer is copied to project-relative paths (the recipe replay and the test suite both do it), and the
    # tool root may be a fixture that ships only the script under test. So the run's tool root is tried first and
    # this file's own directory is the fallback; neither is `from plan import ...`, which would depend on whichever
    # `plan` happened to be on sys.path. Reading `'material' in target` here used to raise TypeError on
    # `targets: [null]` — a traceback in place of that refusal (决定记录 D-73/D-75/D-81).
    here = Path(__file__).resolve().parent
    classifier_candidates = (tool_root / 'harness' / 'plan.py', here / 'plan.py')
    classifier_path = next((path for path in classifier_candidates if path.is_file()), None)
    if classifier_path is None:
        sys.exit('找不到配色目标分类器 plan.py：' + '、'.join(str(path) for path in classifier_candidates))
    planner = load_module(classifier_path, 'avh_recolor_plan')
    try:
        relative_targets, material_targets, layer_targets, region_targets = planner.classify_recolor_targets((plan.get('recolor') or {}).get('targets') or [])
    except ValueError as error:
        sys.exit(str(error))
    # The region masks are recomputed with the same shipped geometry code the stage's declaration is checked
    # against. Loaded by path for the same reason as the classifier: the observer may be running from a copy.
    region_candidates = (tool_root / 'harness' / 'layer_source.py', here / 'layer_source.py')
    region_path = next((path for path in region_candidates if path.is_file()), None)
    if region_targets and region_path is None:
        sys.exit('找不到区域推导器 layer_source.py：' + '、'.join(str(path) for path in region_candidates))
    region_module = load_module(region_path, 'avh_recolor_regions') if region_path else None
    notes, metrics, proof = [], {}, {}

    prefab = project / LAYER / 'Avatar.prefab'
    text = prefab.read_text(encoding='utf-8', errors='replace') if prefab.is_file() else None
    overrides = [(int(f), g, int(slot), mat) for f, g, slot, mat in OVERRIDE.findall(text)] if text else []
    if text is None:
        notes.append('改色层 Avatar.prefab 不存在')
    ours = layer_guids(project)
    ledger = read_json(project / LAYER / 'ledger.json')
    material_applied, selected_guids, selected_count = material_selection(project, run, plan, material_targets, ledger, metrics, proof)
    axis_valid, axis_guids, axis_slots = material_axis_selection(project, run, plan)
    if plan.get('avatar_config'):
        metrics['material_axis_presets_verified'] = axis_valid
    selected_guids |= axis_guids
    axis_default_slots = []
    if any(g.get('kind') == 'material' for g in (plan.get('avatar_config') or {}).get('groups', [])):
        report, current = current_readback(project, run, plan)
        default_slots = report.get('material_default_slots', [])
        axis_default_slots = default_slots if current else []
        approved_slots = axis_slots | {(r.get('renderer'), r.get('slot')) for r in report.get('bindings', [])
                                      if 'material:' + str(r.get('requirement_id')) in material_applied}
        selected_guids = {guid for guid in selected_guids if all((r.get('renderer'), r.get('slot')) in approved_slots
                          for r in axis_default_slots if r.get('actual_guid') == guid and r.get('actual_guid') != r.get('original_guid'))}
        selected_count = len({(r.get('renderer'), r.get('slot')) for r in default_slots
                              if r.get('actual_guid') and r.get('actual_guid') != r.get('original_guid')} | axis_slots) if current and axis_valid and default_slots else None
    replaced = [o for o in overrides if o[3]]
    metrics['replaced_material_slots'] = selected_count if selected_count is not None else len(replaced) if text is not None else None
    targets = defaultdict(set)
    for file_id, _, _, material in replaced:
        targets[material].add(file_id)
    for slot in axis_default_slots:
        if slot.get('actual_guid') and slot.get('actual_guid') != slot.get('original_guid'):
            targets[slot['actual_guid']].add(slot.get('renderer'))
    grouped_applied = set()
    if plan.get('avatar_config'):
        report, current = current_readback(project, run, plan)
        proof['grouped_recolor_readback_current'] = current
        if current:
            for target in (plan.get('recolor') or {}).get('targets', []):
                if 'part' not in target: continue
                selected = [b for b in report.get('relative_bindings', []) if b.get('part') == target['part']]
                recorded = [r for r in (ledger or {}).get('rows', []) if r.get('part') == target['part']]
                actual = {(b.get('renderer'), b.get('slot'), b.get('original_guid'), b.get('actual_guid')) for b in selected}
                expected = {(r.get('renderer'), r.get('slot'), r.get('original_guid'), r.get('material_guid')) for r in recorded}
                if actual and actual == expected and all(b.get('actual_guid') for b in selected):
                    grouped_applied.add(target['part'])
                    for binding in selected:
                        targets[binding['actual_guid']].add(binding['renderer'])
    shared = [m for m, ids in targets.items() if len(ids) > 1 and m not in selected_guids]
    metrics['recolor_materials_shared_by_multiple_meshes'] = len(shared) if text is not None else None
    outside = [m for m in targets if m not in ours and m not in selected_guids]
    metrics['recolor_materials_outside_own_dir'] = len(outside) if text is not None else None
    if shared:
        notes.append(f'被多个网格共用的改色材质 GUID：{shared[:5]}')
    if outside:
        notes.append(f'不在 {LAYER} 下的材质 GUID：{outside[:5]}')

    ledger_rows = (ledger or {}).get('rows', [])
    metrics['recolor_ledger_rows'] = len(ledger_rows) if ledger else None
    # A row count and a replaced-slot count are different quantities: one slot can have two writers, because a
    # relative iris target and a layered main texture may share one copy (see material_selection). Then a
    # ledger that covers every replaced slot still has more rows than slots, and comparing rows to slots makes
    # the check unsatisfiable for any plan containing such a pair. A replacement replaces a slot, so the check
    # reads the deduplicated slot count; the row count stays reported as a reading rather than the criterion.
    metrics['recolor_ledger_slots'] = len({(row.get('renderer'), row.get('slot')) for row in ledger_rows} | axis_slots) if ledger else None
    # 每条颜色需求都要落到至少一个真被替换的槽上：台账说某需求换成了哪个材质，变体里要真有这个覆盖。
    # 三种目标各按自己的形状认：相对目标按部位，按层目标按 requirement_id，材质目标也按 requirement_id
    # 但单独一类——材质目标没有 part，按层目标也没有，若不分开，材质目标会被当成一条按层操作，于是既被
    # 报成「没落上」，又把 layer_unverified_operations 撑高一条，而两条判据都要求它为 0。
    applied = {row.get('part') for row in (ledger or {}).get('rows', []) if row.get('material_guid') in targets}
    if plan.get('avatar_config'):
        # A grouped plan resolves the slot through the member's preset, so only the writers the readback proved
        # are counted; outside it the ledger row is already matched through the material GUID in the variant.
        applied = grouped_applied | {part for part in applied if part and (part.startswith('layer:') or part.startswith('region:'))}
    applied |= material_applied
    # A plan may carry its colours in an independent material axis instead of recolor targets.
    axis_targets = [g for g in (plan.get('avatar_config') or {}).get('groups', []) if g.get('kind') == 'material']
    axis_wanted = ['axis:' + str(g['id']) + '/' + str(m['id']) for g in axis_targets for m in g.get('members', [])]
    if axis_valid:
        applied |= set(axis_wanted)
    # The four forms come from the one classifier, so each list keeps its predicate.
    relative_wanted = [t.get('part') for t in relative_targets]
    material_wanted = ['material:' + str(t.get('requirement_id')) for t in material_targets]
    layer_wanted = ['layer:' + str(t.get('requirement_id')) for t in layer_targets]
    region_wanted = ['region:' + str(t.get('requirement_id')) for t in region_targets]
    wanted = relative_wanted + layer_wanted + region_wanted + material_wanted + axis_wanted
    unmapped = [part for part in wanted if part not in applied]
    metrics['unmapped_color_requirements'] = len(unmapped) if wanted else None
    if unmapped:
        notes.append(f'没有落到材质槽上的颜色需求：{unmapped}')

    # 按层改色：观察器独立回读产物与绑定，不信执行器自己的结论。
    apply_path = project / LAYER / 'layer-apply.json'
    applied_ops = read_json(apply_path)
    # 三项按层判据对**每一个**改色任务都必须有读数，否则规则拿到的是「缺数据」，而引擎把缺数据当作
    # 不通过——那会把所有不含按层目标的改色任务整体阻断。没有这类目标时它们是 0：没有这类需求，就没有
    # 未兑现的这类需求；有目标却缺产物时「未核对」等于目标条数，由下面第一支覆盖（决定记录 D-95）。
    metrics['layer_unverified_operations'] = len(layer_wanted)
    metrics['layer_alpha_moved'] = 0
    metrics['layer_bindings_missing'] = 0
    metrics['layer_outside_mask_changed'] = 0
    metrics['layer_semantics_violations'] = 0
    if layer_wanted and applied_ops is None:
        metrics['layer_operations_verified'] = None
        notes.append('方案有按层目标，但没有 layer-apply.json：按层改色的产物缺失')
    elif not layer_wanted:
        # Nothing this route needs and nothing to read: a stray layer-apply.json left by an earlier run is not a
        # reason to import NumPy on a machine that need not have it (R6 第 3 项).
        metrics['layer_operations_verified'] = None
        if applied_ops is not None:
            notes.append('存在 layer-apply.json，但方案里没有按层目标')
    else:
        # Imported here rather than at module level: a plan with no layered targets must still be
        # observable on a machine without these, and the observer runs for every recolour task.
        import numpy
        from PIL import Image
        verified, alpha_ok, bound_ok, local_ok, semantics_ok = 0, 0, 0, 0, 0
        problems = []
        rows_by_part = defaultdict(list)
        for row in (ledger or {}).get('rows', []):
            rows_by_part[row.get('part')].append(row)
        for operation in applied_ops.get('operations', []):
            key = 'layer:' + str(operation.get('requirement_id'))
            original, output = project / operation['textureAsset'], project / operation['outputAsset']
            if not output.is_file() or not original.is_file():
                problems.append(f"{key} 的原图或产物不在工程里")
                continue
            # 产物必须是执行器报的那一份，否则后面比的是别的东西。
            if digest(output) != operation.get('outputSha256'):
                problems.append(f'{key} 的产物与执行器记录的哈希不符')
                continue
            verified += 1
            before, after = decode(original), decode(output)
            if before.shape != after.shape:
                problems.append(f'{key} 的产物尺寸与原图不同')
                continue
            if not (before[:, :, 3] == after[:, :, 3]).all():
                problems.append(f'{key} 的 alpha 被改动')
            else:
                alpha_ok += 1
            # 局部性：只有蒙版内的像素允许变。蒙版由执行器写出并核对哈希，所以「外面没动」这条
            # 观察器能自己算，而不是相信执行器的 outsideChangedPixels。
            mask_path = project / operation['maskAsset'] if operation.get('maskAsset') else None
            if mask_path is None or not mask_path.is_file():
                problems.append(f'{key} 没有蒙版产物，无法独立核对局部性')
            elif digest(mask_path) != operation.get('maskSha256'):
                problems.append(f'{key} 的蒙版与执行器记录的哈希不符')
            else:
                mask = numpy.asarray(Image.open(mask_path).convert('L'))
                if mask.shape != before.shape[:2]:
                    problems.append(f'{key} 的蒙版尺寸与产物不同')
                else:
                    changed = numpy.abs(after.astype(numpy.int16) - before.astype(numpy.int16)).max(axis=2) > 0
                    outside_changed = int((changed & (mask == 0)).sum())
                    if outside_changed:
                        problems.append(f'{key} 在蒙版外改了 {outside_changed} 个像素')
                    else:
                        local_ok += 1
                    # 颜色语义：两种语义各自承诺一件事，所以各按自己的算法算出预期像素再与产物比。只数
                    # 「通道值有几种」既放过没改过色的渐变，也误拒一个正确的均匀区域（R6 第 6 项）。
                    covered = mask > 0
                    semantics = str(operation.get('semantics'))
                    if not covered.any():
                        problems.append(f'{key} 的蒙版没有覆盖任何像素，无法按声明的语义核对')
                    elif semantics not in ('flat', 'shade'):
                        problems.append(f'{key} 声明的语义不是 flat／shade：{semantics}')
                    else:
                        want = layer_expected_pixels(before, mask, operation.get('color'), semantics)
                        got = after[covered][:, :3].astype(numpy.int16)
                        if numpy.array_equal(got, want[covered].astype(numpy.int16)):
                            semantics_ok += 1
                        else:
                            worst = int(numpy.abs(got - want[covered].astype(numpy.int16)).max())
                            problems.append(f'{key} 声明 {semantics} 但蒙版内像素与按该语义算出的颜色不同，最大差 {worst}')
            # 绑定：台账声称换了材质的那些槽，**材质资产里的贴图属性**必须真指向产物——读台账不算证据。
            rows_here = rows_by_part.get(key, [])
            if not rows_here:
                problems.append(f'{key} 没有任何台账行')
            elif not material_points_at(project, rows_here, output):
                problems.append(f'{key} 的材质贴图属性没有指向产物（台账不能自证）')
            else:
                bound_ok += 1
        metrics['layer_operations_verified'] = verified
        metrics['layer_alpha_preserved'] = alpha_ok
        metrics['layer_bindings_recorded'] = bound_ok
        # 需求数减实测数：0 才算落上。方案里有几条按层目标，就要有几条被独立核对过。
        metrics['layer_unverified_operations'] = max(0, len(layer_wanted) - verified)
        metrics['layer_alpha_moved'] = max(0, verified - alpha_ok)
        metrics['layer_bindings_missing'] = max(0, verified - bound_ok)
        metrics['layer_outside_mask_changed'] = max(0, verified - local_ok)
        metrics['layer_semantics_violations'] = max(0, verified - semantics_ok)
        notes.extend(problems)

    # 按区域改色：区域由网格 UV 足迹导出，观察器从同一份网格数据把掩膜重算一遍，不信执行器写的蒙版。
    # `overrides` 是变体自己写的覆盖项：核对台账声明的槽时，要先把覆盖项的身份解析到它落在哪个渲染器上。
    material_readback, region_readback_current = current_readback(project, run, plan, regions=bool(region_targets))
    unity_region_readback = material_readback.get('region_bindings') if isinstance(material_readback, dict) else None
    verify_regions(project, ledger, region_targets, region_module, metrics, proof, notes, overrides, text,
                   unity_region_readback, region_readback_current)

    recipe_path = project / LAYER / 'recipe.json'
    recipe = read_json(recipe_path)
    spec = importlib.util.spec_from_file_location('avh_recolor', tool_root / 'harness' / 'recolor.py')
    if recipe is not None and spec and spec.loader:
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        try:
            again = module.serialize(module.build_recipe(plan, recipe.get('feedback', '')))
            metrics['rerun_recipe_hash_equal'] = hashlib.sha256(again.encode()).hexdigest() == hashlib.sha256(recipe_path.read_bytes()).hexdigest()
        except ValueError as error:
            metrics['rerun_recipe_hash_equal'] = False
            notes.append(f'配方重跑失败：{error}')
    else:
        metrics['rerun_recipe_hash_equal'] = None
        notes.append('缺少 recipe.json 或配方脚本')
    tracked, source = script_versioned(tool_root, 'harness/recolor.py')
    metrics['recipe_script_tracked'] = tracked
    proof['recipe_script_source'] = source

    candidates = run / 'candidates'
    tiers = {t['id'] for t in (recipe or {}).get('tiers', [])}
    shot_tiers = {p.stem.split('_', 1)[0] for p in candidates.glob('*.png')} if candidates.is_dir() else set()
    metrics['candidate_tier_count'] = len(tiers & shot_tiers)
    # 相对目标才需要挑档；全部是固定色时只有一档可挑，方案侧校验已经把下限定成 1。
    metrics['relative_target_count'] = len(relative_targets)
    # 配方声明了几档就要出几档——档数下限由方案侧校验把关，这里只核对声明的都渲染出来了。
    metrics['candidate_tier_shortfall'] = max(0, len(tiers) - metrics['candidate_tier_count']) if tiers else None
    specs = {json.dumps(read_json(p), sort_keys=True) for p in candidates.glob('*.json')} if candidates.is_dir() else set()
    metrics['distinct_camera_specs'] = len(specs) if specs else None
    if not specs:
        notes.append('本阶段 Run 目录里没有候选图的机位规格')

    decision = project / LAYER / '配色决策.md'
    content = decision.read_text(encoding='utf-8') if decision.is_file() else ''
    # 只有一档时没有「未选的档」可写：固定色不参与档位偏移，关口问的是区域与绑定对不对、是否接受，
    # 而不是在几档里挑一个。要求它写一节不存在的内容，只会逼出一节空话。
    sections = SECTIONS if len(tiers) > 1 else SECTIONS_SINGLE
    metrics['color_decision_missing_sections'] = sum(1 for s in sections if s not in content)
    Path(args.out).write_text(json.dumps({'schema': 'observation/0.1', 'metrics': metrics, 'notes': notes, 'proof': proof},
                                         ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
