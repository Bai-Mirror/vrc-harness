#!/usr/bin/env python3
# 【项目沉淀】通用工具（Harness 观测：assets.inventory / assets.validate）
# 适用素体：无关
# 工具链　：python3 标准库
# 可复用性：★★★ 换个单子直接能用
# 用途　　：只读地测量素材清点与导入的指标，写 observation/0.1 到 --out。在 Harness 的检查沙箱里运行
#           （全盘只读、无网络）；按 AVH_STAGE 只算本阶段检查要用的指标，算不出的写 null（判定为缺数据）。
# 用法　　：observe_assets.py --project <工程> --library <素材库> --out <文件>
"""Independent measurements for the asset checks: the observer re-derives what it can instead of trusting the stage's record."""
import argparse
import gzip
import hashlib
import json
import os
import re
import sys
import tarfile
import zipfile
from collections import Counter, defaultdict
from contextlib import ExitStack
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
# The registered-name comparison and where a registered item is on disk are the intake tool's answers,
# imported so the measurement and the清点 that wrote the record cannot disagree.
from intake import file_digest, item_files, nfc, on_disk, zip_member_name  # noqa: E402
from plan import effective_inventory, excluded_items, import_records  # noqa: E402
import avatar_config  # noqa: E402

# 项目依赖 is not a body-compatibility answer: the bundle carries an installation entry instead of a
# .unitypackage, so nothing in it can be fitted to this body. It is a valid conclusion because the fact it
# records — this item is installed as a pinned project VPM dependency — is checkable and complete for what
# the intake stage can know.
CONCLUSIONS = {'支持', '不支持', '待骨骼比对', '项目依赖'}
COMMON_PACK = re.compile(r'material|shader|common|core|dlc', re.I)   # SOP 20 步骤 3：漏公共/材质包看文件名
EXCLUDED_EXT = ('.exe', '.bat', '.cmd', '.ps1', '.dll.config')         # 解包工具从不写这些
SCAN_ROOTS = ('Assets', 'Packages', 'Library/PackageCache')           # 引用解析的索引必须含这三处（SOP 20 步骤 3）
TEXT_ASSETS = {'.prefab', '.mat', '.asset', '.controller', '.anim', '.overridecontroller', '.mask', '.playable'}
META_GUID = re.compile(rb'^guid:\s*([0-9a-f]{32})', re.M)
GUID_REF = re.compile(r'guid:\s*([0-9a-f]{32})')
BUILTIN = re.compile(r'^0{16}[0-9a-f]0{15}$')                          # Unity 内置资源，没有 .meta


def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def intake_metrics(project, library, manifest, notes):
    intake = project / '_harness' / 'intake'
    required = [intake / '需求.md']
    missing = sum(1 for path in required if not path.is_file() or not path.read_text(encoding='utf-8').strip())
    inventory = read_json(intake / 'inventory.json')
    # The number of products is what the Manifest names and the library holds, not what the stage chose to list:
    # a product folder of the library, or for projects made in Harness the one file the item names.
    folders = 0
    listing = [p for p in library.iterdir() if p.is_dir()] if library.is_dir() else []
    for asset in manifest.get('assets', []):
        item = asset['item']
        path = Path(item) if Path(item).is_absolute() else library / item
        actual = on_disk(path)
        if any(nfc(p.name).endswith(nfc(f'-{item}')) for p in listing) or (actual or path).is_file():
            folders += 1
    if inventory is None:
        notes.append('inventory.json 缺失或无法解析')
        return {'missing_requirement_files': missing, 'inventory_entries': None, 'product_directory_count': folders,
                'items_without_valid_compat_conclusion': None, 'budget_reserve_fields_recorded': None,
                'items_with_layered_sources': None, 'items_with_vpm_dependencies': None,
                'layered_sources_total': None}
    items = inventory.get('items', [])
    invalid = [i.get('item') for i in items if (i.get('compat') or {}).get('conclusion') not in CONCLUSIONS
               or not str((i.get('compat') or {}).get('basis', '')).strip()]
    if invalid:
        notes.append(f'兼容结论无效或缺依据：{invalid}')
    doc = intake / '建档.md'
    text = doc.read_text(encoding='utf-8') if doc.is_file() else ''
    budget = bool(re.search(r'PhysBone 余量：\s*\d+', text)) and bool(re.search(r'参数位余量：\s*\d+', text))
    # A layered source is what makes "change only this part" a name rather than a guess about pixels,
    # so which items have one is a fact the planning stage needs. Its absence is legitimate for many
    # packages, so it is reported rather than required.
    with_layered = [i.get('item') for i in items if i.get('layered')]
    if items and not with_layered:
        notes.append('没有任何登记素材带分层源文件；按层改色在本单不可用')
    # The environment prepares from this record, so it is reported here as the same fact the stage wrote,
    # not re-derived: a dependency the observer cannot see is one nobody can tell was ever declared.
    with_vpm = [i.get('item') for i in items if i.get('vpm')]
    return {'missing_requirement_files': missing, 'inventory_entries': len(items), 'product_directory_count': folders,
            'items_without_valid_compat_conclusion': len(invalid), 'budget_reserve_fields_recorded': budget,
            'items_with_layered_sources': len(with_layered),
            'items_with_vpm_dependencies': len(with_vpm),
            'layered_sources_total': sum(len(i.get('layered') or []) for i in items)}


def guid_index(project):
    """GUID -> project-relative paths, over Assets/, Packages/ and Library/PackageCache/."""
    index = defaultdict(list)
    for top in SCAN_ROOTS:
        for dirpath, _, names in os.walk(project / top):
            for name in names:
                if not name.endswith('.meta'):
                    continue
                path = Path(dirpath) / name
                try:
                    with path.open('rb') as handle:
                        match = META_GUID.search(handle.read(300))
                except OSError:
                    continue
                if match:
                    index[match.group(1).decode()].append(path.relative_to(project).as_posix()[:-len('.meta')])
    return index


def read_text(path):
    """Unity text serialization only; binary assets and unreadable files are leaves."""
    try:
        with path.open('rb') as handle:
            if handle.read(5) != b'%YAML':
                return None
        return path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None


def planned_outfits(plan):
    """Return the physical outfit rows using the same projection as plan validation and Unity.

    plan/0.3 stores members under avatar_config groups, while plan/0.2 stores rows at the top level.
    Keeping the projection here in avatar_config.py prevents asset observers from silently growing a
    second interpretation of grouped plans.
    """
    if plan.get('schema') == 'plan/0.3':
        return avatar_config.physical_rows(avatar_config.normalize(plan))
    return plan.get('outfits', []) or []


def is_liltoon(shader_path):
    return bool(shader_path) and ('jp.lilxyzw.liltoon/' in shader_path or 'liltoon' in shader_path.lower())


def inert_refs(text, shader_path):
    """
    Per GUID, how many of its references sit in a lilToon texture slot whose feature switch is off. SOP 20 假阳性甄别：
    lilToon 的功能开关是 _UseXxx（不是 _XxxBlend），关着时该功能的贴图槽是惰性的。槽归哪个开关按名字前缀取最长的
    （_Emission2ndMap 归 _UseEmission2nd，_EmissionMap 归 _UseEmission）；找不到开关的槽一律当作在用。
    """
    if not is_liltoon(shader_path):
        return Counter()
    switches = {name: float(value) for name, value in re.findall(r'^\s*- _Use(\w+): (-?[\d.]+)\s*$', text, re.M)}
    outline_shader = bool(re.search(r'_oo?\.shader$|outline', shader_path, re.I))
    inert = Counter()
    for prop, guid in re.findall(r'^\s*- _(\w+):\s*\n\s*m_Texture: \{fileID: -?\d+, guid: ([0-9a-f]{32})', text, re.M):
        owner = max((name for name in switches if prop.startswith(name)), key=len, default=None)
        if owner is None or switches[owner] != 0:
            continue
        if owner == 'Outline' and outline_shader:
            continue  # 描边变体的描边一直开着，_UseOutline 只管 lilToonMulti
        inert[guid] += 1
    return inert


def prefab_files(project):
    for dirpath, dirs, names in os.walk(project / 'Assets'):
        rel = Path(dirpath).relative_to(project).as_posix()
        if rel.startswith('Assets/_Harness'):
            dirs[:] = []
            continue
        for name in names:
            if name.endswith('.prefab'):
                yield Path(dirpath) / name


def usage_roots(project, index, key, notes):
    """
    What this order will use, found without the stage's own records: the body prefab (an avatar descriptor, or a
    variant of one, named after the body; PC over Quest; shallowest) and every prefab in the other vendors' folders
    whose path names the body. Vendor demos and other bodies' variants are not roots.
    """
    prefabs = list(prefab_files(project))
    texts = {path: (read_text(path) or '') for path in prefabs}
    descriptors = {path for path, text in texts.items() if 'baseAnimationLayers:' in text}
    by_guid = {guid: paths[0] for guid, paths in index.items() if paths}
    for path, text in texts.items():
        source = re.search(r'm_SourcePrefab: \{fileID: \d+, guid: ([0-9a-f]{32})', text)
        if source and by_guid.get(source.group(1)) and project / by_guid[source.group(1)] in descriptors:
            descriptors.add(path)
    def rank(path):
        rel = path.relative_to(project).as_posix().lower()
        return (key not in path.stem.lower(), 'quest' in rel or 'android' in rel, rel.count('/'), len(rel))
    if not descriptors:
        notes.append('没有找到带 Avatar 描述符的预制体')
        return None, []
    body = min(descriptors, key=rank)
    body_top = body.relative_to(project).parts[:2]
    outfits = sorted(p for p in prefabs if p.relative_to(project).parts[:2] != body_top
                     and key and key in p.relative_to(project).as_posix().lower())
    return body, outfits


def reachable(project, index, roots):
    """
    Walk GUID references from the roots; returns (visited files, dangling refs, lilToon line counts).

    Every reference the index resolves is a file the avatar reaches, whatever its type: a PNG, shader or script is
    a reference endpoint, and "used" is decided by whether any reached file sits in the product's own directory.
    Only text assets are queued for their own references — a leaf has none to follow.
    """
    seen, queue, dangling, liltoon_lines = set(), list(roots), defaultdict(set), {}
    while queue:
        path = queue.pop()
        if path in seen:
            continue
        seen.add(path)
        text = read_text(path)
        if text is None:
            continue
        rel = path.relative_to(project).as_posix()
        refs = Counter(GUID_REF.findall(text))
        inert = Counter()
        if path.suffix == '.mat':
            shader = re.search(r'm_Shader: \{fileID: -?\d+, guid: ([0-9a-f]{32})', text)
            shader_path = (index.get(shader.group(1)) or [None])[0] if shader else None
            inert = inert_refs(text, shader_path)
            if is_liltoon(shader_path):
                liltoon_lines[rel] = text.count('\n')
        for guid, count in refs.items():
            if BUILTIN.match(guid) or count - inert[guid] <= 0:
                continue
            targets = index.get(guid)
            if not targets:
                dangling[guid].add(rel)
                continue
            target = project / targets[0]
            if target.suffix.lower() in TEXT_ASSETS:
                if target not in seen:
                    queue.append(target)
            else:
                seen.add(target)
    return seen, dangling, liltoon_lines


def vendor_missing_animation_references(project, index, dangling):
    """Return absent GUID references from vendor AnimatorController motion fields only.

    This intentionally mirrors the Unity observer's ownership boundary: generated/tool roots are not vendor
    inputs, and a GUID is exempt only when it cannot resolve to any project asset. A controller that mentions
    the same GUID in any other field, or a GUID that resolves while its fileID is wrong, remains blocking.
    """
    found = defaultdict(list)
    for guid, paths in dangling.items():
        for rel in paths:
            if not rel.lower().endswith('.controller') or not rel.startswith('Assets/'):
                continue
            if rel.startswith(('Assets/_Harness/', 'Assets/_HarnessTools/', 'Assets/_HarnessColdProbe/')):
                continue
            text = read_text(project / rel) or ''
            # Unity text serialization stores AnimatorState and BlendTree as separate YAML documents. Their
            # action fields are both named m_Motion; no other asset kind is admitted here.
            rows = []
            for block in re.split(r'(?m)^--- !u!\d+ &-?\d+\s*\n', text)[1:]:
                kind = re.match(r'([A-Za-z0-9_]+):\s*\n', block)
                if not kind or kind.group(1) not in {'AnimatorState', 'BlendTree'}:
                    continue
                name = re.search(r'(?m)^\s*m_Name:\s*(.*)$', block)
                owner = name.group(1).strip() if name else kind.group(1)
                for motion in re.finditer(r'(?m)^\s*m_Motion:\s*\{[^}]*guid:\s*([0-9a-f]{32})', block):
                    if motion.group(1) == guid:
                        rows.append({'controller': rel, 'state': owner, 'guid': guid})
            all_refs = GUID_REF.findall(text)
            motion_refs = re.findall(r'(?m)^\s*m_Motion:\s*\{[^}]*guid:\s*([0-9a-f]{32})', text)
            if rows and all_refs.count(guid) == motion_refs.count(guid) and not index.get(guid):
                found[guid].extend(rows)
    # A GUID shared by a controller motion and any other reachable path/field is not noise.
    return {guid: rows for guid, rows in found.items()
            if set(row['controller'] for row in rows) == set(dangling.get(guid, set()))}


def material_slot_guids(text):
    """GUIDs explicitly assigned to renderer slots, including prefab variant overrides.

    Other vendor references retain the existing inert-reference policy. Material assignments are needed
    for rendering and must resolve even when no approved archive can supply their missing GUID.
    """
    refs = set()
    for block in re.findall(r'^\s*m_Materials:\s*\n((?:\s*- \{[^\n]+\}\s*\n)+)', text, re.M):
        refs.update(GUID_REF.findall(block))
    for block in re.findall(r'propertyPath: m_Materials\.Array\.data\[\d+\]\s*\n'
                            r'\s*value:[^\n]*\n\s*objectReference: \{([^}]+)\}', text):
        refs.update(GUID_REF.findall(block))
    return refs


def library_packs(library, items):
    """Approved product folders and direct ZIP/unitypackage inputs, as (item, source, member)."""
    for item in items:
        folder = next((p for p in library.iterdir() if p.is_dir() and nfc(p.name).endswith(nfc(f'-{item}'))), None) if library.is_dir() else None
        files = folder / 'files' if folder else None
        direct = Path(item)
        if not direct.is_absolute():
            direct = library / direct
        direct = on_disk(direct) or direct
        paths = sorted(files.iterdir()) if files and files.is_dir() else [direct] if not folder and direct.is_file() else []
        for path in paths:
            if path.suffix.lower() == '.unitypackage':
                yield item, path, None
                continue
            if path.suffix.lower() != '.zip':
                continue
            try:
                with zipfile.ZipFile(path) as archive:
                    for member in archive.infolist():
                        if member.filename.lower().endswith('.unitypackage'):
                            yield item, path, member
            except zipfile.BadZipFile:
                continue


def selected_library_packs(library, inventory_items):
    """Yield exactly the package files selected by intake for every registration form."""
    for record in inventory_items:
        item = record.get('item') if isinstance(record, dict) else record
        located = item_files(library, item) if item else None
        if not located:
            continue
        files = located[1]
        entries = record.get('files') if isinstance(record, dict) else None
        named_entries = {nfc(entry['name']): entry for entry in (entries or [])
                         if isinstance(entry, dict) and entry.get('name')}
        for path in files:
            entry = named_entries.get(nfc(path.name))
            # Legacy manifest-only observations have no named intake file entries. They still inspect
            # the registered source, never unapproved siblings beside a directly registered source.
            if named_entries and (entry is None or not entry.get('selected')):
                continue
            if not named_entries and entries is not None and not any(e.get('selected') for e in entries if isinstance(e, dict)):
                continue
            if path.suffix.lower() == '.unitypackage':
                yield item, path, None
            elif path.suffix.lower() == '.zip':
                try:
                    with zipfile.ZipFile(path) as archive:
                        for member in archive.infolist():
                            if member.filename.lower().endswith('.unitypackage') and \
                                    (entry is None or 'active_packages' not in entry or zip_member_name(member) in entry['active_packages']):
                                yield item, path, member
                except zipfile.BadZipFile:
                    continue


def selected_dependency_packs(library, item):
    """File-level dependency evidence covers same-item and separately registered packages equally."""
    item_refs = item.get('dependency_refs', [])
    files = {nfc(entry.get('name')): entry for entry in item.get('files', [])
             if isinstance(entry, dict) and entry.get('name')}
    for _, source, member in selected_library_packs(library, [item]):
        entry = files.get(nfc(source.name), {})
        refs = list(item_refs) + list(entry.get('dependency_refs', []))
        member_name = zip_member_name(member) if member is not None else None
        if any(ref.get('member') == member_name for ref in refs if isinstance(ref, dict)):
            yield source, member


def pack_guids(zip_path, member):
    """GUID -> pathname for one .unitypackage read as a stream (no random access into the gzip)."""
    guids = {}
    with ExitStack() as stack:
        if member is None:
            raw = stack.enter_context(zip_path.open('rb'))
        else:
            archive = stack.enter_context(zipfile.ZipFile(zip_path))
            raw = stack.enter_context(archive.open(member))
        unzipped = stack.enter_context(gzip.GzipFile(fileobj=raw))
        stream = stack.enter_context(tarfile.open(fileobj=unzipped, mode='r|'))
        for entry in stream:
            if entry.isfile() and entry.name.replace('\\', '/').endswith('/pathname'):
                guid = entry.name.replace('\\', '/').split('/')[-2]
                guids[guid] = stream.extractfile(entry).read().decode('utf-8', 'replace').splitlines()[0].strip()
    return guids


def pack_assets(zip_path, member):
    """Return the original asset bytes and pathname from one unitypackage stream.

    Unity's importer is allowed to rewrite imported text, so the setup distinction between a vendor
    file and a Harness-edited file must compare the source bytes, not a Unity dependency hash.
    """
    assets = {}
    with ExitStack() as stack:
        if member is None:
            raw = stack.enter_context(zip_path.open('rb'))
        else:
            archive = stack.enter_context(zipfile.ZipFile(zip_path))
            raw = stack.enter_context(archive.open(member))
        unzipped = stack.enter_context(gzip.GzipFile(fileobj=raw))
        stream = stack.enter_context(tarfile.open(fileobj=unzipped, mode='r|'))
        for entry in stream:
            parts = entry.name.replace('\\', '/').split('/')
            if len(parts) != 2 or not entry.isfile() or parts[1] not in {'pathname', 'asset'}:
                continue
            guid = parts[0]
            handle = stream.extractfile(entry)
            row = assets.setdefault(guid, {})
            if parts[1] == 'pathname':
                value = handle.read()
                row['path'] = value.decode('utf-8', 'replace').splitlines()[0].strip()
            else:
                prefix = handle.read(5)
                if prefix == b'%YAML':
                    row['bytes'] = prefix + handle.read()
    return assets


def owned_package_assets(library, inventory_items):
    """Search registered inputs AND every owned archive; registration is not an availability filter."""
    registered = list(library_packs(library, [row.get('item') for row in inventory_items
                                             if isinstance(row, dict) and row.get('item')]))
    pool = []
    if library.is_dir():
        for path in sorted(library.rglob('*')):
            if path.is_file() and path.suffix.lower() in {'.zip', '.unitypackage'}:
                pool.extend(library_packs(library, [str(path.resolve())]))
    result = defaultdict(list)
    seen = set()
    for position, (item, zip_path, member) in enumerate(registered + pool):
        key = (str(zip_path.resolve()), zip_member_name(member) if member is not None else None)
        if key in seen:
            continue
        seen.add(key)
        for guid, row in pack_assets(zip_path, member).items():
            if row.get('path'):
                result[guid].append({**row, 'registered': position < len(registered), 'item': item,
                                     'source': f'{zip_path}:{zip_member_name(member) if member else ""}:{row["path"]}'})
    # Loose Unity assets in a ZIP also count as owned providers. No import/registration is implied.
    registered_files = set()
    for item in inventory_items:
        located = item_files(library, item.get('item')) if isinstance(item, dict) and item.get('item') else None
        if located:
            registered_files.update(path.resolve() for path in located[1])
    archives = registered_files | {path.resolve() for path in library.rglob('*') if path.is_file() and path.suffix.lower() == '.zip'} if library.is_dir() else registered_files
    for archive_path in sorted(archives):
        if archive_path.suffix.lower() != '.zip':
            continue
        with zipfile.ZipFile(archive_path) as archive:
            for entry in archive.infolist():
                if not entry.filename.endswith('.meta'):
                    continue
                with archive.open(entry) as handle:
                    match = META_GUID.search(handle.read(300))
                if not match:
                    continue
                filename = entry.filename[:-5].replace('\\', '/')
                asset_path = filename[filename.index('Assets/'):] if 'Assets/' in filename else filename
                row = {'path': asset_path, 'registered': archive_path in registered_files,
                       'source': f'{archive_path}:{filename}', 'item': str(archive_path)}
                if filename in archive.namelist():
                    with archive.open(filename) as handle:
                        prefix = handle.read(5)
                        if prefix == b'%YAML':
                            row['bytes'] = prefix + handle.read()
                result[match.group(1).decode()].append(row)
    return result


def imported_asset_origins(project):
    """Latest successful import proof, bound to its archive version and selected member."""
    origins = {}
    receipt = read_json(project / '_harness' / 'setup' / 'import.json')
    for record in reversed(import_records(receipt)):
        for package in record.get('packages', []):
            if not all(package.get(key) for key in ('item', 'zip', 'package', 'archive_sha256')):
                continue
            if not re.fullmatch('[0-9a-f]{64}', package['archive_sha256']):
                continue
            for asset in package.get('asset_origins', []):
                if all(asset.get(key) for key in ('path', 'guid', 'sha256')):
                    origins[asset['path']] = asset
    return origins


def unchanged_imported_asset(project, path, origins):
    rel = path.relative_to(project).as_posix()
    if rel.startswith('Assets/_Harness'):
        return False
    bound = origins.get(rel)
    try:
        meta = META_GUID.search(Path(str(path) + '.meta').read_bytes())
        return bool(bound and meta and bound['guid'] == meta.group(1).decode()
                    and bound['sha256'] == hashlib.sha256(path.read_bytes()).hexdigest())
    except OSError:
        return False


def imported_asset_members(project):
    """Asset path -> the package record that selected it, newest import record first.

    `asset_origins` only covers assets whose bytes survived the import unchanged.  A vendor shader
    package is allowed to rewrite a material while importing it, so the reference provenance of the
    file it rewrote still has to be answerable: the receipt already names the archive and the member
    the import selected for that path.  The first package listing a path is the one that wrote it —
    `unpack` skips a GUID already installed elsewhere, so a later package listing the same path did not.
    """
    members = {}
    receipt = read_json(project / '_harness' / 'setup' / 'import.json')
    for record in import_records(receipt):
        for package in record.get('packages', []):
            if not all(package.get(key) for key in ('item', 'zip', 'package', 'archive_sha256')):
                continue
            if not re.fullmatch('[0-9a-f]{64}', package['archive_sha256']):
                continue
            for path in package.get('paths', []):
                if path not in members:
                    members[path] = package
    return members


def imported_member_assets(library, package):
    """GUID -> original bytes from the exact member one receipt bound, or None when it cannot be read.

    A member that no longer matches the digest the receipt recorded is not the content that was
    imported, so it proves nothing about the vendor's references and is refused rather than trusted.
    """
    located = item_files(library, package.get('item'))
    if not located:
        return None
    source = next((path for path in located[1] if nfc(path.name) == nfc(str(package.get('zip', '')))), None)
    if source is None or source.is_symlink() or not source.is_file():
        return None
    try:
        if file_digest(source) != package.get('archive_sha256'):
            return None
    except (OSError, ValueError):
        return None
    if source.suffix.lower() == '.unitypackage':
        return pack_assets(source, None)
    if source.suffix.lower() != '.zip':
        return None
    try:
        with zipfile.ZipFile(source) as archive:
            member = next((entry for entry in archive.infolist()
                           if entry.filename.lower().endswith('.unitypackage')
                           and zip_member_name(entry) == str(package.get('package'))), None)
    except zipfile.BadZipFile:
        return None
    return pack_assets(source, member) if member is not None else None


def registered_origin_references(project, library, path, members=None):
    """GUIDs the vendor original of `path` carries, or None when the original cannot be proven.

    `unchanged_imported_asset` answers "did anything rewrite these bytes", which a shader package's own
    import-time migration makes false without touching a single reference.  What a dangling reference
    actually needs answered is narrower: did the content this import selected ship that reference at
    all.  Provenance of the reference, not immutability of the file, is what makes it the vendor's.
    """
    path = Path(path)
    try:
        rel = path.relative_to(project).as_posix()
    except ValueError:
        rel = path.as_posix()
    if not rel.startswith('Assets/') or rel.startswith('Assets/_Harness'):
        return None
    package = (members if members is not None else imported_asset_members(project)).get(rel)
    if package is None:
        return None
    assets = imported_member_assets(library, package)
    if assets is None:
        return None
    try:
        meta = META_GUID.search((project / (rel + '.meta')).read_bytes())
    except OSError:
        return None
    row = assets.get(meta.group(1).decode()) if meta else None
    if not row or row.get('path') != rel or not row.get('bytes'):
        return None
    return set(GUID_REF.findall(row['bytes'].decode('utf-8', 'replace')))


def vendor_texture_reference(path, guid):
    if path.suffix.lower() != '.mat':
        return True
    text = read_text(path) or ''
    textures = re.search(r'^    m_TexEnvs:\s*\n(.*?)(?=^    [A-Za-z_]+:|\Z)', text, re.M | re.S)
    refs = re.findall(r'm_Texture:\s*\{[^}]*guid:\s*' + guid + r'[^}]*\}', textures.group(1) if textures else '')
    return bool(refs) and len(refs) == GUID_REF.findall(text).count(guid)


def material_slot_refs(path, text, project=None, index=None):
    """Material GUID references with the renderer identity and slot number from Unity YAML."""
    result = []
    rel = path.as_posix()
    blocks = {match.group(1): (match.group(2), match.group(3)) for match in re.finditer(
        r'--- !u!\d+ &(-?\d+)(?: stripped)?\s+([A-Za-z0-9_]+):\n(.*?)(?=\n--- !u!|\Z)', text, re.S)}
    names, transforms = {}, {}
    for fid, (kind, body) in blocks.items():
        if kind == 'GameObject':
            name = re.search(r'^  m_Name: (.*)$', body, re.M)
            if name:
                names[fid] = name.group(1)
        if kind in {'Transform', 'RectTransform'}:
            go = re.search(r'm_GameObject: \{fileID: (-?\d+)', body)
            parent = re.search(r'm_Father: \{fileID: (-?\d+)', body)
            if go:
                transforms[fid] = (go.group(1), parent.group(1) if parent else '0')
    def object_path(go):
        parts, visited = [], set()
        while go in names and go not in visited:
            visited.add(go)
            parts.insert(0, names[go])
            transform = next((v for v in transforms.values() if v[0] == go), None)
            go = transforms.get(transform[1], (None, None))[0] if transform else None
        return '/'.join(parts) or f'GameObject@{go}'
    for block in re.finditer(r'--- !u!\d+ &(-?\d+)\s+([A-Za-z0-9_]+):\n(.*?)(?=\n--- !u!|\Z)', text, re.S):
        file_id, kind, body = block.groups()
        if kind not in {'MeshRenderer', 'SkinnedMeshRenderer', 'ParticleSystemRenderer', 'LineRenderer', 'TrailRenderer'}:
            continue
        game_object = re.search(r'\bm_GameObject:\s*\{fileID:\s*(-?\d+)', body)
        label = f'{kind}@{file_id}'
        if game_object and game_object.group(1) in names:
            label += f' ({names[game_object.group(1)]})'
        array = re.search(r'^\s*m_Materials:\s*\n((?:\s*-\s*\{[^\n]+\}\s*\n)+)', body, re.M)
        if array:
            for slot, line in enumerate(array.group(1).splitlines()):
                match = re.search(r'guid:\s*([0-9a-f]{32})', line)
                if match:
                    result.append({'file': rel, 'object_path': object_path(game_object.group(1)) if game_object else f'component@{file_id}',
                                   'renderer': label, 'slot': slot, 'guid': match.group(1)})
    # PrefabInstance overrides do not carry a renderer component block; the target file ID is the renderer.
    for override in re.finditer(
            r'target:\s*\{fileID:\s*(-?\d+),\s*guid:\s*([0-9a-f]{32}),[^}]*\}(.*?)'
            r'(?=\n\s*- target:|\n\s*m_Removed|\Z)', text, re.S):
        slot = re.search(r'propertyPath:\s*m_Materials\.Array\.data\[(\d+)\]', override.group(3))
        reference = re.search(r'objectReference:\s*\{[^}]*guid:\s*([0-9a-f]{32})', override.group(3))
        if not slot or not reference:
            continue
        detail = {'file': rel, 'object_path': f'source:{override.group(2)}@{override.group(1)}',
                  'renderer': f'PrefabInstance@fileID:{override.group(1)}', 'slot': int(slot.group(1)), 'guid': reference.group(1)}
        if project is not None and index and override.group(2) in index:
            source_path = project / index[override.group(2)][0]
            detail['object_path'] = f'{index[override.group(2)][0]}#renderer:{override.group(1)}'
            source_rows = material_slot_refs(source_path, read_text(source_path) or '')
            source = next((row for row in source_rows if row['renderer'].split(' ')[0].endswith('@' + override.group(1))), None)
            if source:
                detail['object_path'] = source['object_path']
        result.append(detail)
    return result


def setup_metrics(project, library, manifest, notes):
    metrics = {}
    raw_inventory = read_json(project / '_harness' / 'intake' / 'inventory.json')
    if raw_inventory is None:
        raw_inventory = {'items': [{'item': asset.get('item'), 'files': [{'selected': True}]}
                                   for asset in manifest.get('assets', [])]}
    plan = json.loads(os.environ.get('AVH_PLAN') or '{}')
    inventory = effective_inventory(raw_inventory, plan)
    key = (inventory.get('body_key') or '').lower()
    inventory_items = inventory.get('items', [])
    items = [item['item'] for item in inventory_items
             if any(file.get('selected') for file in item.get('files', []) if isinstance(file, dict))]
    index = guid_index(project)
    # Keep the raw inventory for provenance classification.  The effective inventory controls what is
    # installed; it must not erase the fact that a registered archive could have supplied a GUID.
    owned_assets = owned_package_assets(library, raw_inventory.get('items', []))
    origins = imported_asset_origins(project)
    vendor_missing_slots = []
    if not (project / 'Library' / 'PackageCache').is_dir():
        notes.append('没有 Library/PackageCache（Unity 还没打开过工程），引用解析会把 Unity 包的 GUID 当成断链')

    # 一 GUID 多路径：只算 Assets 与 Packages，PackageCache 是只读镜像
    owned = {guid: [p for p in paths if not p.startswith('Library/')] for guid, paths in index.items()}
    duplicates = {guid: paths for guid, paths in owned.items() if len(paths) > 1}
    metrics['duplicate_guid_paths'] = len(duplicates)
    for guid, paths in list(duplicates.items())[:5]:
        notes.append(f'GUID {guid} 有 {len(paths)} 个路径：{paths}')

    # 公共/材质包：商品目录里文件名像公共包的，它的 GUID 必须都在工程里
    missing_packs = 0
    checked = set()
    for item, zip_path, member in selected_library_packs(library, inventory_items):
        if not COMMON_PACK.search(nfc(zip_path.name)):
            continue
        pack_key = (str(zip_path), zip_member_name(member) if member is not None else None)
        if pack_key in checked:
            continue
        checked.add(pack_key)
        guids = {g: p for g, p in pack_guids(zip_path, member).items() if not p.lower().endswith(EXCLUDED_EXT)}
        absent = [p for g, p in guids.items() if g not in index]
        if absent:
            missing_packs += 1
            notes.append(f'公共包 {nfc(zip_path.name)} 有 {len(absent)}/{len(guids)} 个条目不在工程里，例如 {absent[:3]}')
    for item in inventory_items:
        for zip_path, member in selected_dependency_packs(library, item):
            pack_key = (str(zip_path), zip_member_name(member) if member is not None else None)
            if pack_key in checked:
                continue
            checked.add(pack_key)
            guids = {g: p for g, p in pack_guids(zip_path, member).items() if not p.lower().endswith(EXCLUDED_EXT)}
            absent = [p for g, p in guids.items() if g not in index]
            if absent:
                missing_packs += 1
                notes.append(f'材质／贴图依赖包 {nfc(zip_path.name)} 有 {len(absent)}/{len(guids)} 个条目不在工程里，例如 {absent[:3]}')
    metrics['missing_common_material_packs'] = missing_packs

    # Classify reached GUIDs against every owned source and unchanged registered vendor bytes.
    if plan.get('body_prefab'):
        # 已批准的方案点名了素体与每套服装：只从这些出发（方案是输入，不是本阶段的自述）
        body = project / plan['body_prefab']
        outfits = [project / o['prefab'] for o in planned_outfits(plan) if o.get('prefab')]
        missing = [str(p.relative_to(project)) for p in [body] + outfits if not p.is_file()]
        if missing:
            notes.append(f'方案点名的预制体不在工程里：{missing}')
            body = None
    else:
        body, outfits = usage_roots(project, index, key, notes)
    if body is None:
        metrics.update(broken_guid_refs=None, min_liltoon_material_lines=None)
    else:
        notes.append(f'引用起点：素体 {body.relative_to(project).as_posix()}，服装候选 {len(outfits)} 个')
        reached, dangling, lines = reachable(project, index, [body] + outfits)
        animation_own = vendor_missing_animation_references(project, index, dangling)
        material_refs = set()
        for path in reached:
            if path.suffix.lower() == '.prefab':
                material_refs.update(material_slot_guids(read_text(path) or ''))
            elif path.suffix.lower() == '.mat':
                # reachable() already removes the disabled lilToon feature slots. Active texture slots
                # cannot use the exemption for inert vendor references when their package is unregistered.
                material_refs.update(re.findall(r'm_Texture:\s*\{[^}]*guid:\s*([0-9a-f]{32})', read_text(path) or ''))
        provided = {}
        for guid, rows in owned_assets.items():
            if guid in dangling:
                provided[guid] = rows[0]['source']
        if dangling:
            for item, zip_path, member in selected_library_packs(library, inventory_items):
                for guid, pathname in pack_guids(zip_path, member).items():
                    if guid in dangling:
                        provided.setdefault(guid, f'{nfc(zip_path.name)}:{pathname}')
        # The old observer exempted every unprovided dangling GUID, then required byte-identical vendor
        # bytes.  For a material that is the wrong proof: the vendor's own shader package rewrites the
        # material while importing it, which changes plenty of bytes without changing a single reference,
        # so the proof is that the registered original carries the same GUID.  A dangling reference the
        # original does not carry appeared after the import.  A renderer slot points out of a prefab, and
        # nothing rewrites a prefab at import time, so byte equality stays the proof there.  Harness
        # output is never exempt.
        origin_members = imported_asset_members(project)
        origin_references = {}

        def vendor_origin(path, guid):
            rel = path.relative_to(project).as_posix()
            if rel not in origin_references:
                origin_references[rel] = registered_origin_references(project, library, path, origin_members)
            return guid in (origin_references[rel] or ())

        def vendor_source(path, guid):
            return vendor_origin(path, guid) if path.suffix.lower() == '.mat' else unchanged_imported_asset(project, path, origins)

        if dangling and not (origin_members and origins):
            notes.append('缺少实际导入成员或内容摘要的来源证明；旧回执不作厂商豁免，请重跑 setup 实际导入生成证明')
        missed = {}
        vendor_own = []
        for guid, ref_paths in dangling.items():
            if guid in provided:
                missed[guid] = provided[guid]
                continue
            if guid in animation_own:
                continue
            if ref_paths and all(vendor_source(project / rel, guid) and vendor_texture_reference(project / rel, guid) for rel in ref_paths):
                vendor_own.append(guid)
            else:
                missed[guid] = '非贴图对象引用缺失，或登记原件未引用该 GUID／源文件已被改动或来源无法证明'
        for guid in dangling.keys() & material_refs:
            # A material slot with no owned provider remains a vendor finding only when its source prefab
            # survived byte-for-byte. Details stay in this observer's own output notes.
            for rel in dangling.get(guid, set()):
                path = project / rel
                for detail in material_slot_refs(path, read_text(path) or '', project, index):
                    if detail['guid'] != guid:
                        continue
                    detail['file'] = path.relative_to(project).as_posix()
                    detail['source'] = 'not found in any owned source'
                    if guid in vendor_own:
                        vendor_missing_slots.append(detail)
                    else:
                        missed.setdefault(guid, provided.get(guid, '材质槽引用缺失，登记包未提供该 GUID'))
        metrics['broken_guid_refs'] = len(missed)
        for guid, source in list(missed.items())[:5]:
            notes.append(f'漏装／需登记来源包：{sorted(dangling[guid])[0]} 引用的 {guid} 在 {source}')
        if vendor_own:
            notes.append(f'厂商缺件（材质按登记原件是否引用该 GUID、其余按字节与实际导入成员一致判定，所有已拥有来源均无该 GUID）{len(vendor_own)} 种，不阻断：'
                         + '；'.join(f'{sorted(dangling[g])[0]} → {g}' for g in vendor_own))
        animation_rows = [row for rows in animation_own.values() for row in rows]
        if animation_rows:
            notes.append('厂商动画缺件提醒（该状态不播放，不阻断）：' + '；'.join(
                f"{row['controller']} / {row['state']} / GUID {row['guid']}" for row in animation_rows))
        if vendor_missing_slots:
            notes.append('厂商缺件材质槽：' + '；'.join(
                f"{row['file']} / 对象 {row['object_path']} / {row['renderer']} / 槽位 {row['slot']} / {row['guid']}"
                for row in vendor_missing_slots))
        for guid in vendor_own:
            for rel in dangling[guid]:
                if rel.lower().endswith('.mat'):
                    text = read_text(project / rel) or ''
                    properties = re.findall(r'- ([^:\n]+):\s*\n\s*m_Texture:\s*\{[^}]*guid:\s*' + guid, text)
                    notes.append(f'厂商材质贴图缺件提醒：{rel} / 属性 {",".join(properties) or "对象引用"} / {guid}；使用着色器默认贴图，不阻断')
        metrics['vendor_missing_material_slots'] = len(vendor_missing_slots)
        metrics['vendor_missing_animation_references'] = len(animation_rows)
        metrics['min_liltoon_material_lines'] = min(lines.values()) if lines else None
        if lines:
            worst = min(lines, key=lines.get)
            notes.append(f'可达 lilToon 材质 {len(lines)} 个，最短 {worst}（{lines[worst]} 行）')

    # 素材应用表：数据行数对 Manifest 的商品数
    usage = project / '_harness' / 'setup' / 'usage.md'
    rows = [line for line in usage.read_text(encoding='utf-8').splitlines() if line.startswith('|')] if usage.is_file() else None
    metrics['usage_table_rows'] = max(len(rows) - 2, 0) if rows is not None else None
    metrics['product_count'] = len(items)
    metrics.setdefault('vendor_missing_material_slots', 0)
    metrics.setdefault('vendor_missing_animation_references', 0)
    return metrics


def outfit_metrics(project, plan, notes):
    """SOP 50 步骤 5：每件服装都有包外引用——它的 GUID 出现在我们自己的层（Assets/_Harness/）里。"""
    ours = [path for path in (project / 'Assets' / '_Harness').rglob('*') if path.suffix in ('.prefab', '.asset', '.unity')]
    texts = [read_text(path) or '' for path in ours]
    outfits = planned_outfits(plan)
    missing = 0
    for outfit in outfits:
        meta = project / (outfit.get('prefab', '') + '.meta')
        match = META_GUID.search(meta.read_bytes()) if meta.is_file() else None
        if not match:
            missing += 1
            notes.append(f"{outfit.get('id')}：预制体 {outfit.get('prefab')} 不存在")
            continue
        guid = match.group(1).decode()
        hits = sum(text.count(guid) for text in texts)
        if hits == 0:
            missing += 1
            notes.append(f"{outfit.get('id')}：没有任何我们的资产引用 {outfit.get('prefab')}")
    return {'outfits_without_external_refs': missing if outfits else None}


def package_metrics(project, library, manifest, plan, notes):
    """
    SOP 90 步骤 6 与缺失项：在交付工程 zip 原样解开的冷副本上量（没有冷副本就量主工程并说明）。
    · 应用表无空白格；· 每个商品都有包外引用（交付头像可达的文件落在该商品导入的目录里）；
    · 交付头像可达范围内：脚本丢失（m_Script 解析不了）＋ 素材库里有、交付里却缺的文件（漏打包）。厂商自带的悬空引用不计。
    """
    metrics = {}
    usage = project / '_harness' / 'setup' / 'usage.md'
    rows = [line for line in usage.read_text(encoding='utf-8').splitlines() if line.startswith('|')][2:] if usage.is_file() else None
    metrics['usage_table_blank_cells'] = sum(1 for row in rows for cell in row.strip().strip('|').split('|') if not cell.strip()) if rows is not None else None
    cold = project / '_harness_build' / 'cold' / 'project'
    target = cold if (cold / 'Assets').is_dir() else project
    if target is project:
        notes.append('没有冷导入副本，缺失项在主工程上量')
    index = guid_index(target)
    avatar = target / 'Assets' / '_Harness' / 'Optimize' / 'Avatar.prefab'
    scene = target / 'Assets' / '_Harness' / 'Optimize' / 'Avatar.unity'
    if not avatar.is_file():
        notes.append('交付工程里没有 Assets/_Harness/Optimize/Avatar.prefab')
        metrics.update(assets_without_external_refs=None, missing_scripts_and_broken_refs=None)
        return metrics
    seen, dangling, _ = reachable(target, index, [p for p in (avatar, scene) if p.is_file()])
    record = read_json(project / '_harness' / 'setup' / 'import.json') or {}
    raw_inventory = read_json(project / '_harness' / 'intake' / 'inventory.json')
    if raw_inventory is None:
        raw_inventory = {'items': [{'item': asset.get('item'), 'files': [{'selected': True}]}
                                   for asset in manifest.get('assets', [])]}
    inventory = effective_inventory(raw_inventory, plan)
    roots = {}
    for prior in import_records(record):
        for package in prior.get('packages', []):
            # Produced under the same registered item in two different records, and a registered path can be
            # spelled in either Unicode normalization form; identity is compared composed, never re-spelled.
            roots.setdefault(nfc(str(package['item'])), set()).update(package.get('roots', []))
    reached = {path.relative_to(target).as_posix() for path in seen}
    effective_items = [item['item'] for item in inventory.get('items', [])
                       if any(file.get('selected') for file in item.get('files', []) if isinstance(file, dict))]
    # Keep the approved three-condition exemption visible in this observer while the effective projection
    # supplies the actual input set. The two agree for a valid plan; a mutation that reads `unused` alone
    # must still revive the false pass covered by the direct-input regression.
    declined = set(excluded_items(plan))
    unused = [item for item in effective_items if nfc(str(item)) not in declined
              if not any(nfc(r).startswith(nfc(root) + '/') for root in roots.get(nfc(str(item)), ()) for r in reached)]
    metrics['assets_without_external_refs'] = len(unused)
    if unused:
        notes.append(f'交付头像用不到的商品：{unused}')
    if declined:
        notes.append(f'方案批准不用、不计入的商品：{sorted(declined)}')
    # 脚本丢失按 Unity 加载的结果：本阶段冷导入步骤写的 cold_missing_scripts.json（文本 GUID 查不到 .meta 不等于丢，
    # VRChat SDK 会在加载时认旧版 SDK 的 GUID）。没有这份就是没测到。
    cold_scripts = read_json(Path(os.environ.get('AVH_RUN_DIR', '')) / 'cold_missing_scripts.json')
    scripts = cold_scripts.get('missing_scripts') if cold_scripts else None
    if cold_scripts is None:
        notes.append('没有冷导入步骤的脚本丢失读数（cold_missing_scripts.json）')
    else:
        notes += [f'冷导入：{n}' for n in cold_scripts.get('notes', [])[:5]]
    provided = {}
    if dangling:
        for item, zip_path, member in library_packs(library, [a['item'] for a in manifest.get('assets', [])]):
            for guid in pack_guids(zip_path, member):
                if guid in dangling:
                    provided.setdefault(guid, nfc(zip_path.name))
    missed = [g for g in dangling if g in provided]
    metrics['missing_scripts_and_broken_refs'] = None if scripts is None else int(scripts) + len(missed)
    for guid in missed[:5]:
        notes.append(f'漏打包：{sorted(dangling[guid])[0]} 引用的 {guid} 在 {provided[guid]}')
    notes.append(f'交付头像可达文件 {len(seen)} 个；厂商自带的悬空引用 {len([g for g in dangling if g not in provided])} 种（不计）')
    return metrics


def classify_material(project, library, path):
    """Read-only provenance query for Unity's independently discovered material references."""
    raw = read_json(project / '_harness' / 'intake' / 'inventory.json') or {}
    owned = owned_package_assets(library, raw.get('items', []))
    asset = project / path
    data = asset.read_bytes()
    unchanged = unchanged_imported_asset(project, asset, imported_asset_origins(project))
    references = set(GUID_REF.findall(data.decode('utf-8', 'replace')))
    index = guid_index(project)
    origin = registered_origin_references(project, library, asset)
    return {'unchanged': unchanged,
            'unavailable_guids': sorted(
                guid for guid in references if guid not in owned and guid not in index and not BUILTIN.match(guid)),
            # What the import actually selected carries these GUIDs.  A missing texture the original also
            # carries came from the vendor; one only the imported file carries appeared after the import.
            'origin_references': sorted(origin) if origin is not None else None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', default=os.environ.get('AVH_PROJECT_DIR'))
    parser.add_argument('--library', required=True)
    parser.add_argument('--out')
    parser.add_argument('--classify-material')
    args = parser.parse_args()
    project, library = Path(args.project), Path(args.library)
    if args.classify_material:
        print(json.dumps(classify_material(project, library, args.classify_material)))
        return
    if not args.out:
        parser.error('--out is required for observations')
    manifest = json.loads(os.environ.get('AVH_MANIFEST') or '{}')
    stage = os.environ.get('AVH_STAGE', '')
    notes, metrics = [], {}
    if stage == 'intake':
        metrics.update(intake_metrics(project, library, manifest, notes))
    elif stage == 'setup':
        metrics.update(setup_metrics(project, library, manifest, notes))
    elif stage == 'outfit':
        metrics.update(outfit_metrics(project, json.loads(os.environ.get('AVH_PLAN') or '{}'), notes))
    elif stage == 'package':
        metrics.update(package_metrics(project, library, manifest, json.loads(os.environ.get('AVH_PLAN') or '{}'), notes))
    else:
        notes.append(f'阶段 {stage} 的素材指标尚未实现')
    Path(args.out).write_text(json.dumps({'schema': 'observation/0.1', 'metrics': metrics, 'notes': notes},
                                         ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
