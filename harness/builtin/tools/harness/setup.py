#!/usr/bin/env python3
# 【项目沉淀】通用工具（Harness 能力：project.initialize ＋ assets.import 的动作，setup 阶段）
# 适用素体：无关
# 工具链　：python3；复用 ../unpack_unitypackage.py（保 GUID 解包）
# 可复用性：★★★ 换个单子直接能用
# 用途　　：从基准工程复制 ProjectSettings 与已解析的 VPM 包（离线、与工具链基准一致），装入 Harness 的 Unity 工具，
#           按 intake 清单把选中的 zip 里的 .unitypackage 逐个以原始 GUID 解进 Assets/，写 _harness/setup/ 下的
#           导入报告、厂商导入清单（产物 fbx 的成员）与素材应用表。随后 Unity 步骤首次导入、编译并记录骨架基线。
# 用法　　：setup.py --template <基准工程> --library <素材库>（工程取 AVH_PROJECT_DIR，临时文件放 AVH_RUN_DIR）
"""Set up a new Unity project from the baseline and unpack the chosen vendor packages with their original GUIDs."""
import argparse
import contextlib
import filecmp
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import unicodedata
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from intake import item_files, file_digest, texture_format, zip_member_name  # noqa: E402
from unpack_unitypackage import unpack  # noqa: E402
from plan import effective_inventory, excluded_items, import_records, nfc as plan_nfc  # noqa: E402

GUID_LINE = re.compile(rb'^guid:\s*([0-9a-f]{32})', re.M)

SKIP_PACKAGES = {'com.vrcfury.temp'}  # VRCFury writes it during builds; not part of the resolved baseline
UNITY_TOOLS = HERE / 'unity'
AUDIT_TOOLS = HERE.parent / '审查' / 'unity'


def nfc(text):
    return unicodedata.normalize('NFC', text)


def copy_tree(src, dst):
    """Copy a directory, leaving identical files alone so repeated setup does not churn timestamps."""
    for root, dirs, files in os.walk(src):
        rel = Path(root).relative_to(src)
        (dst / rel).mkdir(parents=True, exist_ok=True)
        for name in files:
            s, d = Path(root) / name, dst / rel / name
            if not d.exists() or not filecmp.cmp(s, d, shallow=False):
                shutil.copy2(s, d)


def baseline(template, project, record):
    # Never replace existing work with the baseline on a retry or when taking over an existing project.
    # Check the whole copy set before writing any of it; differing settings need an explicit migration.
    for top in ('ProjectSettings', 'Packages'):
        for source in (template / top).rglob('*'):
            target = project / top / source.relative_to(template / top)
            if source.is_file() and target.exists() and (not target.is_file() or not filecmp.cmp(source, target, shallow=False)):
                raise ValueError('现有工程配置与准备环境不同，已保留原内容；需要受管迁移后才能继续')
    # 只更新内容、不删目录：Runtime 把允许写的目录（ProjectSettings/ 等）预先建好当沙箱挂载点，挂载点本身删不掉。
    settings = project / 'ProjectSettings'
    settings.mkdir(exist_ok=True)
    copy_tree(template / 'ProjectSettings', settings)
    packages = project / 'Packages'
    packages.mkdir(exist_ok=True)
    for name in ('manifest.json', 'vpm-manifest.json', 'packages-lock.json'):
        if (template / 'Packages' / name).exists():
            shutil.copy2(template / 'Packages' / name, packages / name)
            if name == 'vpm-manifest.json':
                # Preserve the template's JSON bytes except for the BOM, which strict JSON readers reject.
                with (packages / name).open('rb+') as copied:
                    contents = copied.read()
                    if contents.startswith(b'\xef\xbb\xbf'):
                        copied.seek(0)
                        copied.write(contents[3:])
                        copied.truncate()
    locked = json.loads((template / 'Packages' / 'vpm-manifest.json').read_text(encoding='utf-8-sig')).get('locked', {})
    copied = []
    for name in sorted(locked):
        if name in SKIP_PACKAGES or not (template / 'Packages' / name).is_dir():
            continue
        copy_tree(template / 'Packages' / name, packages / name)
        copied.append(name)
    # Registry packages are embedded by EnvironmentRecipe as well. Copy their verified bytes so opening the
    # working project does not resolve a second, potentially different dependency graph over the network.
    embedded = {}
    for metadata_path in sorted((template / 'Packages').glob('*/package.json')):
        name = metadata_path.parent.name
        if name in SKIP_PACKAGES:
            continue
        metadata = json.loads(metadata_path.read_text(encoding='utf-8-sig'))
        if metadata.get('name') != name:
            raise ValueError('Embedded package identity differs from its directory')
        if name not in copied:
            copy_tree(metadata_path.parent, packages / name)
        embedded[name] = metadata['version']
    record['template'] = str(template)
    record['vpm_packages'] = {name: locked[name].get('version') for name in copied}
    record['embedded_packages'] = embedded
    record['removed_dependencies'] = drop_unreproducible(packages)


def unreproducible(value):
    """A dependency another machine cannot resolve offline from the registry: git/URL/file sources (dev tooling like MCP)."""
    value = str(value)
    return value.startswith(('file:', 'git', 'http:', 'https:', 'ssh:')) or '.git' in value


def drop_unreproducible(packages):
    """The baseline's dev tooling (e.g. an MCP bridge from a git URL) does not belong in a client project."""
    manifest_path = packages / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    removed = {name: value for name, value in manifest.get('dependencies', {}).items() if unreproducible(value)}
    if removed:
        for name in removed:
            del manifest['dependencies'][name]
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        lock_path = packages / 'packages-lock.json'
        if lock_path.exists():
            lock = json.loads(lock_path.read_text(encoding='utf-8'))
            for name in removed:
                lock.get('dependencies', {}).pop(name, None)
            lock_path.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return removed


def install_tools(project, record):
    """
    Harness's own editor tools, deployed the same way every time; the delivery stage removes them. The build chain
    (构建/BuildArtifact.cs) is deployed from its own home so there is one copy of it.
    """
    dst = project / 'Assets' / '_HarnessTools'
    copy_tree(UNITY_TOOLS, dst)
    # The formal regression stages use the same measured geometry probe as SOP 70.  Keeping a second,
    # simplified detector here was the reason the first RC could reach UPLOAD_READY without measuring fit.
    # Ship the reviewed probe implementation into the build copy and invoke it through HarnessFitStage.
    copy_tree(AUDIT_TOOLS, dst / 'AvatarAudit')
    for name in ('BuildArtifact.cs', 'BuildArtifact.cs.meta'):
        source = HERE.parent / '构建' / name
        if not (dst / 'Editor' / name).exists() or not filecmp.cmp(source, dst / 'Editor' / name, shallow=False):
            shutil.copy2(source, dst / 'Editor' / name)
    record['tools'] = 'Assets/_HarnessTools'


def guid_paths(project):
    """GUID -> project-relative path for every .meta under Assets/ and Packages/."""
    found = {}
    for top in ('Assets', 'Packages'):
        for dirpath, _, names in os.walk(project / top):
            for name in names:
                if not name.endswith('.meta'):
                    continue
                path = Path(dirpath) / name
                try:
                    with path.open('rb') as handle:
                        match = GUID_LINE.search(handle.read(300))
                except OSError:
                    continue
                if match:
                    found[match.group(1).decode()] = path.relative_to(project).as_posix()[:-len('.meta')]
    return found


def package_entries(tar_path):
    """GUID -> Assets/ path of every entry in a (decompressed) .unitypackage, normalized the way unpack() writes it."""
    entries = {}
    with tarfile.open(tar_path, 'r:') as archive:
        for member in archive:
            if member.isfile() and member.name.replace('\\', '/').endswith('/pathname'):
                guid = member.name.replace('\\', '/').split('/')[-2]
                rel = archive.extractfile(member).read().decode('utf-8', 'replace').splitlines()[0].strip()
                rel = rel.replace('\\', '/').lstrip('/')
                entries[guid] = rel if rel.startswith('Assets/') else 'Assets/' + rel
    return entries


def package_asset_origins(tar_path, project, installed):
    """Bind text assets actually retained by this import to their precise source content."""
    origins = []
    with tarfile.open(tar_path, 'r:') as archive:
        for member in archive:
            parts = member.name.replace('\\', '/').split('/')
            if not member.isfile() or len(parts) != 2 or parts[1] != 'asset':
                continue
            guid = parts[0]
            path = installed.get(guid)
            if not path or not (project / path).is_file():
                continue
            source = archive.extractfile(member)
            prefix = source.read(5)
            if prefix != b'%YAML':
                continue
            digest = hashlib.sha256(prefix)
            for chunk in iter(lambda: source.read(1 << 20), b''):
                digest.update(chunk)
            if file_digest(project / path) == digest.hexdigest():
                origins.append({'path': path, 'guid': guid, 'sha256': digest.hexdigest()})
    return origins


def snapshot_inputs(library, inventory, scratch, excluded=None):
    inventory = effective_inventory(inventory, excluded)
    order = sorted(inventory['items'], key=lambda item: {'body': 0}.get(item['role'], 1))
    # Validate and snapshot all selected inputs before importing any package. Import only the verified copy,
    # so a library update after this point cannot change the bytes being decompressed.
    snapshots = {}
    for number, item in enumerate(order):
        if not any(entry.get('selected') for entry in item.get('files', [])):
            continue
        located = item_files(library, item['item']) if item.get('found') else None
        files = located[1] if located else []
        for position, entry in enumerate(item.get('files', [])):
            if not entry.get('selected'):
                continue
            source = next((p for p in files if nfc(p.name) == entry['name']), None)
            if source is None or source.is_symlink() or not source.is_file():
                raise ValueError('待导入素材已缺失或不是普通文件，请重新清点')
            expected = entry.get('sha256')
            if not expected:
                raise ValueError('清点结果缺少内容摘要，请重新清点素材')
            snapshot = scratch / f'input-{number}-{position}{source.suffix}'
            shutil.copyfile(source, snapshot)
            if file_digest(snapshot) != expected:
                raise ValueError('待导入素材与清点版本不一致，请重新选择并批准')
            snapshots[(number, entry['name'])] = snapshot
    return snapshots


def project_dependencies(project):
    """Registered item -> pinned project VPM packages, from the accepted environment lock.

    The environment installed them into the baseline and `baseline()` copied their directories here, so
    setup does not unpack them. It does have to report them: a dependency that entered the project without
    a row of its own would read as an input nobody used, and the delivered avatar's references to it could
    not be traced back to the item that asked for it.
    """
    lock_path = project / '_harness' / 'environment' / 'environment-lock.json'
    if not lock_path.is_file():
        return {}
    try:
        recorded = json.loads(lock_path.read_text(encoding='utf-8')).get('vpmRequirements') or {}
    except (OSError, ValueError):
        return {}
    mapping = {}
    for pin in recorded.get('packages') or []:
        if isinstance(pin, dict) and pin.get('id') and pin.get('item') and pin.get('repository'):
            # Keep the approved source key so a product with several installation files does not report all
            # of its pins for every file.
            mapping.setdefault((pin['item'], pin['repository']), []).append(pin)
    return mapping


def unpack_selected(project, library, inventory, scratch, record, snapshots=None, excluded=None):
    """Import only verified snapshots, preserving GUIDs and reporting conflicts."""
    inventory = effective_inventory(inventory, excluded)
    order = sorted(inventory['items'], key=lambda item: {'body': 0}.get(item['role'], 1))
    if snapshots is None:
        snapshots = snapshot_inputs(library, inventory, scratch)
    dependencies = project_dependencies(project)
    reports, roots = [], set()
    for number, item in enumerate(order):
        if not any(entry.get('selected') for entry in item.get('files', [])):
            continue
        located = item_files(library, item['item']) if item.get('found') else None
        files = located[1] if located else []
        for entry in item.get('files', []):
            if not entry.get('selected'):
                continue
            zip_path = snapshots.get((number, entry['name']))
            if not zip_path:
                reports.append({'item': item['item'], 'zip': entry['name'], 'error': '素材库里找不到该文件'})
                continue
            if entry.get('kind') == 'texture':
                if item.get('role') != 'texture':
                    raise ValueError('纹理导入需要清点时已批准的纹理角色')
                extension = texture_format(zip_path)
                digest = file_digest(zip_path)
                relative_path = f'Assets/_HarnessTextures/{digest}.{extension}'
                if entry.get('projectPath') != relative_path:
                    raise ValueError('纹理导入路径与清点身份不一致')
                target = project / relative_path
                for ancestor in (project, project / 'Assets', target.parent, target):
                    if ancestor.is_symlink():
                        raise ValueError('不通过符号链接导入纹理')
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() and file_digest(target) != digest:
                    raise ValueError('纹理目标已有不同内容，保留现有工程')
                if not target.exists():
                    with target.open('xb') as output, zip_path.open('rb') as source:
                        shutil.copyfileobj(source, output)
                if file_digest(target) != digest:
                    raise ValueError('独立纹理导入后摘要不一致')
                roots.add('Assets/_HarnessTextures')
                reports.append({'item': item['item'], 'zip': entry['name'], 'kind': 'texture',
                                'projectPath': relative_path, 'sha256': digest, 'entries': 1, 'installed': 1,
                                'paths': [relative_path],
                                'roots': ['Assets/_HarnessTextures'], 'content_conflicts': 0, 'guid_conflicts': []})
                continue
            if entry.get('kind') == 'vpm':
                # A VPM installation entry is not unpacked from the bundle: the managed environment
                # installed the package into the baseline and `baseline()` copied it here. Reporting the
                # package root is what lets the delivered avatar's references to it count for this item.
                source_entries = [source for source in (entry.get('vpm') or []) if isinstance(source, dict)]
                if not source_entries:
                    source_entries = [source for source in (item.get('vpm') or [])
                                      if isinstance(source, dict) and source.get('member') == entry.get('name')]
                repositories = {source.get('repository') for source in source_entries
                                if isinstance(source.get('repository'), str)}
                if repositories:
                    pinned = [pin for repository in sorted(repositories)
                              for pin in dependencies.get((item['item'], repository), [])]
                else:
                    # Preserve older one-source inventory rows; never cross-wire an ambiguous multi-source item.
                    item_sources = {key[1] for key in dependencies if key[0] == item['item']}
                    pinned = [pin for key in sorted(dependencies) if key[0] == item['item']
                              for pin in dependencies[key]] if len(item_sources) == 1 else []
                if not pinned:
                    # An approved installation entry whose package the accepted environment does not hold
                    # means the environment was prepared before this dependency was recorded. Refusing is
                    # the honest answer: importing nothing and moving on would ship the order without it.
                    raise ValueError('清点登记的 VPM 依赖不在已接受环境里，需要先重新准备环境：' + item['item'])
                package_roots = sorted(f"Packages/{pin['id']}" for pin in pinned)
                roots.update(package_roots)
                reports.append({'item': item['item'], 'zip': entry['name'], 'kind': 'vpm',
                                'entries': 0, 'installed': 0, 'shared_elsewhere': 0, 'not_installed': [],
                                'wrote': [], 'content_conflicts': 0, 'guid_conflicts': [],
                                'paths': package_roots,
                                'roots': package_roots,
                                'dependencies': [{'id': pin['id'], 'version': pin['version']} for pin in pinned]})
                continue
            archive_digest = file_digest(zip_path)
            direct = zip_path.name.lower().endswith('.unitypackage')
            with (contextlib.nullcontext() if direct else zipfile.ZipFile(zip_path)) as archive:
                members = [None] if direct else [i for i in archive.infolist() if i.filename.lower().endswith('.unitypackage')]
                for index, member in enumerate(members):
                    package_name = entry['name'] if direct else zip_member_name(member)
                    if 'active_packages' in entry and package_name not in entry['active_packages']:
                        continue
                    # Items made in Harness are file paths: name the scratch file by position, not by the item.
                    temp = scratch / f"item{number}-{index}.tar"
                    # Decompress once: unpack() writes in path order, and random reads in a gzip stream restart it.
                    with (open(zip_path, 'rb') if direct else archive.open(member)) as source, gzip.GzipFile(fileobj=source) as unzipped, \
                            open(temp, 'wb') as target:
                        shutil.copyfileobj(unzipped, target, 1 << 20)
                    entries = package_entries(temp)
                    # Refresh after every package: vendors share assets across products.
                    present = guid_paths(project)
                    elsewhere = {guid for guid, path in present.items() if entries.get(guid) != path}
                    wrote, skipped, clash, clashes = unpack(str(temp), str(project), only_new_guids=True, have_guids=elsewhere)
                    after = guid_paths(project)
                    installed = [guid for guid, path in entries.items() if after.get(guid) == path]
                    shared = [guid for guid in entries if guid in present and present[guid] != entries[guid]]
                    missing = sorted(entries[g] for g in set(entries) - set(installed) - set(shared))
                    package_roots = sorted({root_of(path) for path in entries.values()} - {None})
                    roots.update(package_roots)
                    reports.append({'item': item['item'], 'zip': entry['name'],
                                    'package': package_name, 'archive_sha256': archive_digest,
                                    'asset_origins': package_asset_origins(temp, project,
                                        {guid: entries[guid] for guid in installed}),
                                    'entries': len(entries), 'installed': len(installed), 'shared_elsewhere': len(shared),
                                    'not_installed': missing[:50], 'wrote': wrote, 'content_conflicts': clash,
                                    'paths': sorted(entries.values()),
                                    'guid_conflicts': [{'path': p, 'kept': old, 'incoming': new} for p, old, new in clashes],
                                    'roots': package_roots})
                    temp.unlink()
    record['packages'] = reports
    record['roots'] = sorted(roots)
    return sorted(roots)


def root_of(path):
    """The top folder under Assets/ an entry lands in; entries directly in Assets/ have none."""
    parts = path.split('/')
    return '/'.join(parts[:2]) if len(parts) >= 3 else None


def assert_excluded_history_absent(project, previous, excluded):
    """Refuse a plan that excludes data still present from an earlier setup receipt.

    A shared root is intentionally conservative: if an excluded product previously owned that
    root, the remaining directory cannot prove that its bytes were separated from the retained
    product. Direct Assets members are checked individually through the recorded paths.
    """
    excluded = {plan_nfc(str(item)) for item in excluded}
    if not excluded:
        return
    for prior in import_records(previous):
        for package in prior.get('packages', []):
            if plan_nfc(str(package.get('item'))) not in excluded:
                continue
            candidates = list(package.get('roots') or []) + list(package.get('paths') or [])
            for relative in candidates:
                if not isinstance(relative, str) or not relative:
                    continue
                target = project / relative
                if target.exists() or (project / (relative + '.meta')).exists():
                    raise ValueError('方案排除的旧导入数据仍在工程中（来源 ' + str(package.get('item') or '身份未知') +
                                     '，路径 ' + relative + '）；该来源可能包含用户自己的文件，setup 不能安全自动处理。'
                                     '请为此订单新建工程，或在方案中保留该来源后再 setup')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--template', required=True)
    parser.add_argument('--library', required=True)
    parser.add_argument('--project', default=os.environ.get('AVH_PROJECT_DIR'))
    args = parser.parse_args()
    project, template, library = Path(args.project), Path(args.template), Path(args.library)
    scratch = Path(os.environ.get('AVH_RUN_DIR') or project / '_harness' / 'setup') / 'unpack-tmp'
    scratch.mkdir(parents=True, exist_ok=True)
    inventory = json.loads((project / '_harness' / 'intake' / 'inventory.json').read_text(encoding='utf-8'))
    plan = json.loads(os.environ.get('AVH_PLAN') or '{}')
    excluded = excluded_items(plan)
    effective = effective_inventory(inventory, plan)
    out = project / '_harness' / 'setup'
    out.mkdir(parents=True, exist_ok=True)
    import_path = out / 'import.json'
    previous = None
    if import_path.is_file():
        try:
            previous = json.loads(import_path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as error:
            raise ValueError('已有 import.json 无法读取，不能覆盖导入历史：' + str(error))
    assert_excluded_history_absent(project, previous, excluded)
    record = {'schema': 'setup/0.1'}
    snapshots = snapshot_inputs(library, effective, scratch)
    baseline(template, project, record)
    install_tools(project, record)
    roots = unpack_selected(project, library, effective, scratch, record, snapshots)
    record['excluded_items'] = sorted(excluded)
    if previous:
        record['history'] = import_records(previous)
    shutil.rmtree(scratch, ignore_errors=True)
    import_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    # Members of the fbx artifact: what setup brought in. ProjectSettings is left out on purpose: Unity may touch it
    # when later stages open the project, and that is not a change to the avatar's content.
    members = roots + ['Assets/_HarnessTools', 'Packages/manifest.json', 'Packages/vpm-manifest.json'] + \
        [f'Packages/{name}' for name in record['vpm_packages']]
    (out / 'imported.txt').write_text('# setup 导入的成员（产物 fbx）\n' + '\n'.join(members) + '\n', encoding='utf-8')
    rows = ['# 素材应用表', '', '| 商品 | 角色 | 导入的包 | 已装条目数 | 用途 |', '|---|---|---|---|---|']
    for item in effective['items']:
        packs = [r for r in record['packages'] if r['item'] == item['item'] and 'error' not in r]
        use = '素体' if item['role'] == 'body' else '服装（装配阶段接线）' if item['role'] == 'outfit' else '纹理（材质应用仍须实际核对）' if item['role'] == 'texture' else '附件'
        rows.append(f"| {item.get('name') or item['item']} | {item['role']} | {'、'.join(p['zip'] for p in packs) or '—'} | "
                    f"{sum(p['installed'] for p in packs)} | {use} |")
    (out / 'usage.md').write_text('\n'.join(rows) + '\n', encoding='utf-8')
    print(f"基线 {len(record['vpm_packages'])} 个 VPM 包；解包 {len(record['packages'])} 个；厂商根 {roots}")


if __name__ == '__main__':
    main()
