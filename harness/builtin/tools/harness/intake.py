#!/usr/bin/env python3
# 【项目沉淀】通用工具（Harness 能力：assets.inventory 的清点动作，intake 阶段）
# 适用素体：无关
# 工具链　：python3 标准库
# 可复用性：★★★ 换个单子直接能用
# 用途　　：按 Workflow 冻结的输入 Manifest（环境变量 AVH_MANIFEST）在素材库里定位每个商品，逐包挑选要装的 zip，
#           给出兼容结论与依据，写 _harness/intake/{inventory.json, 需求.md, 建档.md}。不解包、不改素材库。
# 用法　　：intake.py --library <素材库>（工程目录取 AVH_PROJECT_DIR；由 Harness 的 tool 阶段调用）
"""Resolve the input Manifest against the asset library and write the intake record the intake checks read."""
import argparse
import gzip
import hashlib
import json
import os
import re
import sys
import tarfile
import unicodedata
import urllib.parse
import zipfile
from pathlib import Path

COMMON_PACK = re.compile(r'material|shader|common|core|dlc', re.I)
SOURCE_ONLY = re.compile(r'\.(psd|pdf|txt|png|jpe?g|md)$|psd', re.I)
# Working files a vendor ships for secondary creators. They are not installed into the project, but
# their presence decides whether a colour change can be asked for as a named layer instead of being
# guessed from pixels, so intake records them per item.
LAYERED_SUFFIXES = ('.psd', '.psb', '.clip', '.kra', '.xcf', '.sai', '.sai2', '.procreate')
# What Unity imports as a model. A package carrying one of these holds geometry that has to be fitted and
# rigged to a body, so "compare the skeleton in the assembly stage" applies to it; a package carrying none
# has no skeleton to compare, and citing that comparison for it would describe something that cannot happen.
# This is Unity's model-file set. It is read from the package's own contents, never from its name.
GEOMETRY_SUFFIXES = ('.fbx', '.obj', '.blend', '.dae', '.3ds', '.dxf', '.max', '.c4d', '.lwo', '.lws',
                     '.jas', '.ma', '.mb', '.ply', '.stl', '.skp', '.abc')
TEXTURE_SUFFIXES = ('.png', '.jpg', '.jpeg', '.tga', '.tif', '.tiff', '.exr', '.bmp', '.gif', '.hdr')
GUID_REF = re.compile(rb'guid:\s*([0-9a-f]{32})')
PHYSBONE_RESERVE = 16      # SOP 10 建档：PhysBone ≤ 256 要留余量给面捕、尾巴、配饰
PARAM_BITS_RESERVE = 32    # 参数位 ≤ 256 同理；60 阶段用实测值对账
# A vendor that publishes on VPM can ship an installation entry instead of a .unitypackage. The entry is a
# link, never an asset: nothing in it can be unpacked, and the package it names belongs to the project's
# environment rather than to Assets/. The spellings below are the VPM ecosystem's own — an installer link
# and a repository listing URL — so the scan reads the format, never a vendor, product or directory name.
VPM_ENTRY_SUFFIXES = ('.url', '.txt', '.md', '.json')
VPM_LISTING_NAMES = ('index.json', 'vpm.json')
VPM_ENTRY_BYTES = 262144   # an installation entry is a link or a short note; a bigger file is documentation


def nfc(text):
    return unicodedata.normalize('NFC', text)


def file_digest(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('素材必须是普通文件')
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def texture_format(path):
    """The direct texture contract matches the broker and Unity's native PNG/JPEG import."""
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 10 * 1024 * 1024:
        raise ValueError('独立纹理须为不超过 10 MB 的普通 PNG 或 JPEG 文件')
    with path.open('rb') as source:
        header = source.read(12)
    suffix = path.suffix.lower()
    if suffix == '.png' and header.startswith(bytes([137, 80, 78, 71, 13, 10, 26, 10])):
        return 'png'
    if suffix in ('.jpg', '.jpeg') and header.startswith(bytes([255, 216, 255])):
        return 'jpg'
    raise ValueError('独立纹理扩展名与 PNG/JPEG 内容不一致')


def find_item(library, item):
    """Library folders end with -<商品号>; names are NFD on some copies, so compare normalized.

    Both sides are composed: the folder name comes from the filesystem and `item` from the Manifest, and
    one of them can be the NFD spelling of the other. Two folders that normalize alike are refused —
    a normalizing disk would have collapsed them, a sensitive one would not.
    """
    if not library.is_dir():
        return None
    matches = [p for p in library.iterdir() if p.is_dir() and nfc(p.name).endswith(nfc(f'-{item}'))]
    return matches[0] if len(matches) == 1 else None


def on_disk(path):
    """The filesystem's own spelling of a registered path, or None when that path is not there.

    A registered path can be spelled in NFC while the folder a macOS-made zip extracted is NFD (or the
    other way round), and NTFS and ext4 keep the two as different names. Every component that differs is
    replaced by the single entry its parent directory holds, so the file is opened under the bytes the
    filesystem actually has; nothing is renamed, and two entries that normalize alike are refused rather
    than guessed at.
    """
    recorded = Path(path)
    if not recorded.is_absolute():
        return None
    current = Path(recorded.anchor)
    for part in recorded.parts[1:]:
        try:
            entries = list(current.iterdir())
        except OSError:
            return None
        matches = [entry for entry in entries if nfc(entry.name) == nfc(part)]
        if len(matches) > 1:
            raise ValueError(f'路径在文件系统里有多个规范化等价的名字，不能确定素材：{recorded}')
        if not matches:
            return None
        current = matches[0]
    return current


def item_files(library, item):
    """
    Where a Manifest item's files are: a product folder of the library (<name>-<商品号>/files/), or, for projects made in
    Harness, the item is the path of one file (a registered local asset or a file fetched from BOOTH), absolute or
    relative to the library. Returns (folder or None, files), or None when neither exists.
    """
    folder = find_item(library, item)
    if folder:
        return folder, sorted((folder / 'files').iterdir()) if (folder / 'files').is_dir() else []
    path = Path(item)
    if not path.is_absolute():
        path = library / item
    actual = on_disk(path)
    path = actual if actual is not None else path
    return (None, [path]) if path.is_file() else None


def zip_member_name(info):
    """One recorded ZIP member identity; retain ZipInfo itself to open the original bytes."""
    name = info.filename
    if not info.flag_bits & 0x800:  # not flagged UTF-8: Booth zips are often CP932
        try:
            name = name.encode('cp437').decode('cp932')
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return name


def zip_members(path):
    """(name, size) for each entry of a zip, with Booth's CP932 names decoded."""
    names = []
    try:
        with zipfile.ZipFile(path) as z:
            for info in z.infolist():
                names.append((zip_member_name(info), info.file_size))
    except zipfile.BadZipFile:
        return None
    return names


def zip_entries(path):
    members = zip_members(path)
    return None if members is None else [name for name, _ in members]


def vpm_installer_link(text):
    """The VPM repository a VCC installer link targets, or None.

    VCC's own scheme carries the repository in the `url` query parameter, percent-encoded or not, so the
    target is read from the query rather than assumed. Only an HTTPS target is accepted: a repository the
    managed environment cannot fetch over HTTPS is not one this tool may declare as an installable
    dependency.
    """
    for match in re.finditer(r'vcc://vpm/addRepo\?[^\s"\'<>\\]+', text, re.I):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(match.group(0)).query)
        for target in query.get('url', []):
            if target.startswith('https://'):
                return target
    return None


def vpm_entry_text(text):
    """(repository, form) for one small candidate file, or None when it is not an installation entry.

    Two spellings of the same entry occur, and the container is the vendor's choice rather than a
    contract. VCC's installer link is unambiguous. A bare repository listing URL is only read as an entry
    when it is the whole meaningful content of the file and its path names one of the listing files the
    VPM format uses; a README that merely mentions a URL must not be mistaken for an installation
    instruction, because declaring a dependency the order never asked for is worse than missing one.
    """
    repository = vpm_installer_link(text)
    if repository:
        return repository, 'installer-link'
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) == 1:
        candidate = lines[0].strip('<>()[]"\'').rstrip('.,;')
        if candidate.startswith('https://') and urllib.parse.urlsplit(candidate).path.lower().endswith(VPM_LISTING_NAMES):
            return candidate, 'repository-url'
    return None


def vpm_entry_bytes(raw):
    """(repository, form) for one candidate file's bytes; Booth ships CP932 text as often as UTF-8."""
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = raw.decode('cp932', 'replace')
    return vpm_entry_text(text)


def vpm_entries(path):
    """Every VPM installation entry one candidate file carries, as {repository, form, member}.

    A bundle may hold the entry directly (a `.url` shortcut or a short text note) or one or more levels
    inside a zip, so the same scan reads both. `member` names the file the entry was read from, or the
    candidate itself when it is a direct file, so a record can be checked against the exact bytes.
    """
    found, suffix = [], path.suffix.lower()
    if suffix == '.zip':
        try:
            with zipfile.ZipFile(path) as archive:
                for info in archive.infolist():
                    if info.is_dir() or not info.filename.lower().endswith(VPM_ENTRY_SUFFIXES) \
                            or info.file_size > VPM_ENTRY_BYTES:
                        continue
                    with archive.open(info) as handle:
                        raw = handle.read(VPM_ENTRY_BYTES + 1)
                    if len(raw) > VPM_ENTRY_BYTES:
                        continue
                    entry = vpm_entry_bytes(raw)
                    if entry:
                        found.append({'repository': entry[0], 'form': entry[1],
                                      'member': info.filename.replace('\\', '/')})
        except (zipfile.BadZipFile, OSError, KeyError, RuntimeError):
            return []
        return found
    if suffix in VPM_ENTRY_SUFFIXES and path.is_file() and path.stat().st_size <= VPM_ENTRY_BYTES:
        entry = vpm_entry_bytes(path.read_bytes())
        if entry:
            found.append({'repository': entry[0], 'form': entry[1], 'member': path.name})
    return found


def stream_layered(raw):
    """Layered file names and sizes inside one .unitypackage stream (gzip over tar).

    A unitypackage stores each asset under a guid folder: `pathname` holds the real path and the
    sibling `asset` its bytes. Reading those two is enough, and keeps a large texture archive cheap.
    `raw` is the gzipped stream, the same shape `stream_prefabs` takes.
    """
    names, sizes = {}, {}
    with gzip.GzipFile(fileobj=raw) as unzipped, tarfile.open(fileobj=unzipped, mode='r|') as stream:
        for entry in stream:
            if not entry.isfile():
                continue
            guid, _, leaf = entry.name.replace('\\', '/').rpartition('/')
            if leaf not in ('pathname', 'asset'):
                continue
            if leaf == 'asset':
                sizes[guid] = entry.size
                continue
            path = stream.extractfile(entry).read().decode('utf-8', 'replace').splitlines()
            names[guid] = path[0].strip().replace('\\', '/') if path else ''
    return [(name, sizes.get(guid)) for guid, name in names.items() if name.lower().endswith(LAYERED_SUFFIXES)]


def layered_sources(files):
    """
    The vendor's layered working files, as (container, path, bytes).

    Secondary creators are expected to work from these rather than from the exported texture: a PSD
    names its layers, so 'change only this part' is a name instead of a guess about pixels. A package
    may hold them directly or hold a .unitypackage that holds them, and the second case is the common
    one for outfits, so the scan looks one level in. Their absence is a fact worth recording too: it
    decides whether the plan can ask for a texture-level edit at all.
    """
    found = []
    for path in files:
        suffix = path.suffix.lower()
        if suffix in LAYERED_SUFFIXES:
            found.append((path.name, path.name, path.stat().st_size))
            continue
        if suffix == '.zip':
            members = zip_members(path) or []
            for name, size in members:
                low = name.lower()
                if low.endswith(LAYERED_SUFFIXES):
                    found.append((path.name, name, size))
                elif low.endswith('.unitypackage'):
                    try:
                        with zipfile.ZipFile(path) as archive, archive.open(name) as raw:
                            found.extend((path.name, *row) for row in stream_layered(raw))
                    except (zipfile.BadZipFile, KeyError, OSError, tarfile.TarError):
                        continue
            continue
        if suffix == '.unitypackage':
            try:
                with open(path, 'rb') as raw:
                    found.extend((path.name, *row) for row in stream_layered(raw))
            except (OSError, tarfile.TarError):
                continue
    return [{'container': container, 'path': name, 'bytes': size} for container, name, size in found]


def stream_assets(raw):
    """Assets/ paths of every asset one .unitypackage stream installs (gzip over tar)."""
    paths = []
    with gzip.GzipFile(fileobj=raw) as unzipped, tarfile.open(fileobj=unzipped, mode='r|') as stream:
        for entry in stream:
            if entry.isfile() and entry.name.replace('\\', '/').endswith('/pathname'):
                path = stream.extractfile(entry).read().decode('utf-8', 'replace').splitlines()[0].strip().replace('\\', '/')
                paths.append(path if path.startswith('Assets/') else 'Assets/' + path.lstrip('/'))
    return paths


def stream_asset_records(raw):
    """Read GUIDs, install paths and serialized references without retaining asset payloads.

    Tar members may put the payload before the pathname. Scan payloads in bounded chunks and retain only
    GUID references, so large prefab payloads remain observable without holding textures in memory.
    """
    records = {}
    with gzip.GzipFile(fileobj=raw) as unzipped, tarfile.open(fileobj=unzipped, mode='r|') as stream:
        for entry in stream:
            if not entry.isfile():
                continue
            guid, _, leaf = entry.name.replace('\\', '/').rpartition('/')
            if not guid:
                continue
            row = records.setdefault(guid, {})
            if leaf == 'pathname':
                lines = stream.extractfile(entry).read().decode('utf-8', 'replace').splitlines()
                if lines:
                    path = lines[0].strip().replace('\\', '/')
                    row['path'] = path if path.startswith('Assets/') else 'Assets/' + path.lstrip('/')
            elif leaf == 'asset.meta':
                row['folder'] = bool(re.search(rb'^folderAsset:\s*yes\s*$', stream.extractfile(entry).read(), re.M))
            elif leaf == 'asset':
                handle, refs, tail = stream.extractfile(entry), set(), b''
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    data = tail + chunk
                    refs.update(match.decode('ascii') for match in GUID_REF.findall(data))
                    tail = data[-64:]
                row['refs'] = refs
    return [{'guid': guid, **row} for guid, row in records.items() if row.get('path')]


def package_asset_records(zip_path, member):
    """Read one direct .unitypackage or one nested package into dependency facts."""
    if member is None:
        with zip_path.open('rb') as raw:
            return stream_asset_records(raw)
    with zipfile.ZipFile(zip_path) as archive, archive.open(member) as raw:
        return stream_asset_records(raw)


def package_facts(files, decisions, include_unselected=True):
    """Facts needed to join a geometry package to the material GUIDs it references.

    Selection is intentionally optional here: a material package that was not named by a common-pack
    filename hint can be promoted after its GUID is observed in a selected outfit prefab. The package
    contents, rather than a vendor name, decide that promotion.
    """
    facts = []
    for decision in decisions:
        if not include_unselected and not decision.get('selected'):
            continue
        if decision.get('kind') in ('texture', 'vpm'):
            continue
        source = next((path for path in files if nfc(path.name) == decision['name']), None)
        if source is None:
            continue
        members = [None] if source.name.lower().endswith('.unitypackage') else []
        if not members:
            try:
                with zipfile.ZipFile(source) as archive:
                    members = [info for info in archive.infolist()
                               if info.filename.lower().endswith('.unitypackage')]
            except (zipfile.BadZipFile, OSError):
                members = []
        for member in members:
            try:
                records = package_asset_records(source, member)
            except (OSError, KeyError, RuntimeError, tarfile.TarError, gzip.BadGzipFile, zipfile.BadZipFile):
                continue
            paths = [row['path'] for row in records if not row.get('folder')]
            materials = {row['guid'] for row in records if row['path'].lower().endswith('.mat')}
            textures = {row['guid'] for row in records if row['path'].lower().endswith(TEXTURE_SUFFIXES)}
            prefabs = [row for row in records if row['path'].lower().endswith('.prefab')]
            provider_only = bool(paths) and all(path.lower().endswith(('.mat', *TEXTURE_SUFFIXES))
                                               for path in paths)
            member_name = zip_member_name(member) if member is not None else None
            facts.append({'decision': decision, 'member': member_name, 'paths': paths,
                          'assets': records, 'materials': materials, 'textures': textures,
                          'prefabs': prefabs,
                          'geometry': any(path.lower().endswith(GEOMETRY_SUFFIXES) for path in paths),
                          'provider_only': provider_only})
            decision.setdefault('package_shapes', []).append({
                'name': member_name or decision['name'],
                'kind': 'provider' if provider_only else 'install',
            })
    return facts


def stream_prefabs(raw):
    """Assets/ paths of the prefabs in a .unitypackage stream (gzip over tar)."""
    return [path for path in stream_assets(raw) if path.lower().endswith('.prefab')]


def package_prefabs(zip_path, member):
    """Assets/ paths of the prefabs inside one .unitypackage of a zip, read as a stream."""
    with zipfile.ZipFile(zip_path) as archive, archive.open(member) as raw:
        return stream_prefabs(raw)


def package_assets(zip_path, member):
    """Assets/ paths of every asset inside one .unitypackage of a zip, read as a stream."""
    with zipfile.ZipFile(zip_path) as archive, archive.open(member) as raw:
        return stream_assets(raw)


def archive_carries_geometry(files, decisions):
    """
    Whether a selected archive holds anything Unity imports as a model — the geometry a bone comparison fits.

    Judged from what the packages carry: a zip's own entries and the install paths inside its .unitypackage
    members. Direct textures are not archives and are skipped (`choose_files` gives them kind 'texture' and
    no package). The question is asked only when no prefab was listed, and its answer decides whether the
    assembly-stage bone comparison is a real step for this item or a citation that cannot apply to it.
    """
    for decision in decisions:
        if not decision['selected'] or decision.get('kind') in ('texture', 'vpm'):
            continue
        path_of = next((p for p in files if nfc(p.name) == decision['name']), None)
        if path_of is None:
            continue
        if path_of.name.lower().endswith('.unitypackage'):
            with open(path_of, 'rb') as raw:
                if any(path.lower().endswith(GEOMETRY_SUFFIXES) for path in stream_assets(raw)):
                    return True
            continue
        with zipfile.ZipFile(path_of) as archive:
            infos = archive.infolist()
            if any(info.filename.lower().endswith(GEOMETRY_SUFFIXES) for info in infos):
                return True
            members = [info.filename for info in infos if info.filename.lower().endswith('.unitypackage')]
        for member in members:
            if any(path.lower().endswith(GEOMETRY_SUFFIXES) for path in package_assets(path_of, member)):
                return True
    return False


def selected_models(files, decisions):
    """Model GameObject sources deployed by selected Unity packages; loose ZIP files are not imports."""
    models = []
    for decision in decisions:
        # A VPM entry is an installation link, not an archive; its packages come from the managed environment.
        if not decision['selected'] or decision.get('kind') in ('texture', 'vpm'):
            continue
        source = next((path for path in files if nfc(path.name) == decision['name']), None)
        if source is None:
            continue
        if source.name.lower().endswith('.unitypackage'):
            with source.open('rb') as stream:
                paths = stream_assets(stream)
        else:
            with zipfile.ZipFile(source) as archive:
                members = [row.filename for row in archive.infolist() if row.filename.lower().endswith('.unitypackage')]
            paths = [path for member in members for path in package_assets(source, member)]
        models.extend(path for path in paths if path.lower().endswith(GEOMETRY_SUFFIXES))
    return sorted(set(models))


def classified_prefabs(files, decisions, role, key):
    """
    Prefabs the selected packages install, split two ways: `candidates` is what the plan may pick from,
    and `named` is the subset whose install path names this body.

    `candidates` falls back to the whole listing so the plan still has something to choose from when the
    paths do not carry the body name. That fallback is a listing, not evidence, so it must not decide
    compatibility: the SOP's middle tier decides from the paths a package installs, and forbids deciding
    from the package filename, which is only a hint. `named` is that tier, and the only one used below.
    Listed here because the plan is written before setup unpacks anything. A single .unitypackage file
    (a local asset) with no body key to match lists all its prefabs — into `candidates` only, never
    `named`, because with no body name to match those paths carry no evidence about this body.
    """
    candidates, named = [], []
    for d in decisions:
        if not d['selected']:
            continue
        path_of = next((p for p in files if nfc(p.name) == d['name']), None)
        if path_of is None:
            continue
        if d.get('kind') in ('texture', 'vpm'):
            continue
        if path_of.name.lower().endswith('.unitypackage'):
            with open(path_of, 'rb') as raw:
                listed = stream_prefabs(raw)
        else:
            with zipfile.ZipFile(path_of) as archive:
                members = [i.filename for i in archive.infolist() if i.filename.lower().endswith('.unitypackage')]
            listed = [path for member in members for path in package_prefabs(path_of, member)]
        matched, exact_segment, unmatched_listing = [], [], []
        for path in listed:
            name = Path(path).stem.lower() if role == 'body' else path.lower()
            if key and key in name:
                matched.append(path)
                # A substring hit can land in a sibling branch that is not this body's. LUNALICE ships both
                # .../Milfy_Eku/Eku/LUNALICE_Black01_Mono.prefab and .../Milfy_Eku/Milfy/..., and the Eku one
                # sorts first, so the cited basis proved the Eku branch while claiming this body. Prefer a path
                # that names the body as a whole segment; the substring set stays as the fallback so packages
                # whose paths only ever carry the name inside a longer token (…/Milfy_Eku/SR_01.prefab) do not
                # lose their conclusion.
                if any(part.lower() == key for part in Path(path).parts):
                    exact_segment.append(path)
            elif not key and path_of.name.lower().endswith('.unitypackage'):
                # There is no body name to match, so this path proves nothing about the body; it goes to the
                # listing only. Keeping it out of `named` matters: `named` is the tier that decides 支持, and
                # a no-key .unitypackage lists all its prefabs unconditionally, which would restore exactly
                # the filename-tier conclusion this split exists to remove.
                unmatched_listing.append(path)
        named.extend(exact_segment or matched)
        # A filename hint is not a source-identity or compatibility proof.
        # Keep the actual selected package's candidates if its names differ.
        candidates.extend(matched or unmatched_listing or listed)

    def order(path):
        return (path.count('/'), path)

    return sorted(set(candidates), key=order), sorted(set(named), key=order)


def candidate_prefabs(files, decisions, role, key):
    """The plan's candidate list; see classified_prefabs for what its fallback does and does not prove."""
    return classified_prefabs(files, decisions, role, key)[0]


def body_key(meta, folder):
    """A short body name to match outfit variants against, e.g. 「輝夜」-kaguya- -> kaguya."""
    text = nfc(meta.get('name') or folder)
    text = re.sub(r'\.(?:zip|unitypackage|fbx|blend)$', '', text, flags=re.I)
    text = re.sub(r'(?<![A-Za-z])v\d+(?:[._-]\d+)*(?![A-Za-z])', '', text, flags=re.I)
    latin = re.findall(r'[A-Za-z][A-Za-z0-9]{2,}', text)
    return latin[-1].lower() if latin else text


def choose_files(files, role, variant, key):
    """Pick the zips (or a lone .unitypackage) to install and say why for every file, installed or not."""
    decisions = []
    importable = [f for f in files if f.name.lower().endswith('.unitypackage') or
                  (f.name.lower().endswith('.zip') and any(n.lower().endswith('.unitypackage') for n in (zip_entries(f) or [])))]
    for f in files:
        name = nfc(f.name)
        entry = {'name': name, 'size': f.stat().st_size}
        direct = name.lower().endswith('.unitypackage')
        packages = [name] if direct else \
            [n for n in (zip_entries(f) or []) if n.lower().endswith('.unitypackage')] if name.lower().endswith('.zip') else []
        entry['packages'] = packages
        # An installation entry is only consulted when the archive carries no importable package: a bundle
        # that ships both is installed from its .unitypackage, and the entry stays a note about where the
        # vendor publishes it rather than a second installation path.
        vpm = vpm_entries(f) if not packages else []
        lower = name.lower()
        if role == 'texture' and f.suffix.lower() in ('.png', '.jpg', '.jpeg'):
            extension = texture_format(f)
            entry.update(selected=True, kind='texture', projectPath=f'Assets/_HarnessTextures/{file_digest(f)}.{extension}',
                         reason='已选择的独立纹理；导入后仍须核对材质应用与实际效果')
        elif vpm:
            entry.update(selected=True, kind='vpm', vpm=vpm,
                         reason='VPM 安装入口：包由受管环境按固定身份、版本与哈希装入工程，不从这里解包')
        elif not packages:
            entry.update(selected=False, reason='不是可导入的包（源文件、说明或图片）')
        elif variant:
            chosen = nfc(variant).lower() in lower
            common = role != 'body' and bool(COMMON_PACK.search(name))
            entry.update(selected=chosen or common, reason=f'Manifest 指定分包 {variant}' if chosen else
                         '公共材质／着色器依赖' if common else '不匹配明确指定的分包')
        elif role == 'body':
            main = f.stat().st_size == max(x.stat().st_size for x in importable)
            entry.update(selected=main, reason='素体主包（体积最大的可导入包）' if main else '可选附加包，方案未要求')
        elif COMMON_PACK.search(name):
            entry.update(selected=True, reason='公共材质／着色器包：同商品的分包依赖它')
        elif not variant and key and key in lower:
            entry.update(selected=True, reason=f'分包名含素体名 {key}')
        elif len(files) == 1:
            entry.update(selected=True, reason='Manifest 指定的单个文件（用户登记或从 BOOTH 取回）')
        else:
            entry.update(selected=False, reason='其他素体的分包')
        decisions.append(entry)
    return decisions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--library', required=True)
    parser.add_argument('--project', default=os.environ.get('AVH_PROJECT_DIR'))
    parser.add_argument('--plan-tool', default=str(Path(__file__).with_name('plan.py')))
    args = parser.parse_args()
    if Path(args.plan_tool).resolve() != Path(__file__).with_name('plan.py').resolve():
        raise ValueError('Planning helper must be the adjacent frozen tool')
    manifest = json.loads(os.environ.get('AVH_MANIFEST') or '{}')
    if manifest.get('schema') != 'manifest/0.1':
        sys.exit('AVH_MANIFEST 缺失或不是 manifest/0.1')
    library, project = Path(args.library), Path(args.project)
    out = project / '_harness' / 'intake'
    out.mkdir(parents=True, exist_ok=True)

    items, key, requirements, seen_requirements = [], None, [], set()
    package_facts_by_item = {}
    for asset in sorted(manifest['assets'], key=lambda a: a.get('role') != 'body'):
        located = item_files(library, asset['item'])
        record = {'item': asset['item'], 'store': asset['store'], 'role': asset.get('role', 'other'),
                  'variant': asset.get('variant')}
        if not located:
            record.update(found=False, compat={'conclusion': '待骨骼比对', 'basis': '素材库里找不到该商品，无法开包核对'})
            items.append(record)
            continue
        folder, files = located
        approved = asset.get('sha256')
        if approved and (len(files) != 1 or file_digest(files[0]) != approved):
            raise ValueError('素材内容与批准版本不一致，请重新选择并批准')
        meta_path = folder / '.booth-meta.json' if folder else None
        meta = json.loads(meta_path.read_text(encoding='utf-8')) if meta_path and meta_path.exists() else \
            ({'name': asset['name']} if asset.get('name') else {})
        if record['role'] == 'body':
            key = body_key(meta, folder.name if folder else files[0].stem)
        decisions = choose_files(files, record['role'], asset.get('variant'), key)
        package_facts_by_item[record['item']] = package_facts(files, decisions)
        for decision in decisions:
            if decision['selected']:
                source = next(p for p in files if nfc(p.name) == decision['name'])
                decision['sha256'] = file_digest(source)
                if approved and decision['sha256'] != approved:
                    raise ValueError('清点期间素材发生变化，请重试')
        selected = [d for d in decisions if d['selected']]
        # The installation entries this item carries become project dependencies. The approved bundle's
        # digest travels with each request so the environment can tell an accepted dependency from one
        # discovered after the bundle changed.
        dependencies = [{'entry': d['name'], 'sourceSha256': d['sha256'], 'repository': row['repository'],
                         'form': row['form'], 'member': row['member']}
                        for d in selected if d.get('kind') == 'vpm' for row in d['vpm']]
        for row in dependencies:
            # Keep one request for each selected outer file. The environment deduplicates the package pin
            # separately, but source evidence must retain both the file name and its bytes when two bundles
            # carry the same inner entry from the same repository.
            source_key = (record['item'], row['repository'], row['member'], row['entry'], row['sourceSha256'])
            if source_key in seen_requirements:
                continue
            seen_requirements.add(source_key)
            requirements.append({'item': record['item'], 'role': record['role'], **row})
        prefabs, body_named = classified_prefabs(files, decisions, record['role'], key)
        layered = layered_sources([p for p in files if p.suffix.lower() in
                                   ('.zip', '.unitypackage', *LAYERED_SUFFIXES)])
        if not selected and files and all(p.suffix.lower() in LAYERED_SUFFIXES for p in files):
            compat = {'conclusion': '支持',
                      'basis': '顶层分层源文件：只作为按层改色的来源记录，不是可导入包，也不进入服装装配判定'}
        elif not selected:
            compat = {'conclusion': '待骨骼比对', 'basis': '未找到符合选择条件的可导入分包，需重新确认素材选择'}
        elif record['role'] == 'texture' and all(d.get('kind') == 'texture' for d in selected):
            compat = {'conclusion': '支持', 'basis': 'PNG/JPEG 格式可导入；不是材质已接线或效果已验证'}
        elif all(d.get('kind') == 'vpm' for d in selected):
            # The bundle installs nothing into Assets/; what it carries is where the vendor publishes the
            # package. Recording that as a body-compatibility conclusion would describe a question nobody
            # asked, so it gets its own honest conclusion: a project dependency, installed by the managed
            # environment with pinned identity, version and hash. Whether the plugin actually works on the
            # avatar is a later stage's reading, not this one's.
            repositories = sorted({row['repository'] for row in dependencies})
            compat = {'conclusion': '项目依赖',
                      'basis': '包内没有可导入资产，只有指向 VPM 仓库的安装入口（' + '、'.join(repositories) +
                               '）：作为项目依赖由受管环境按固定身份、版本与哈希装入工程；'
                               '插件实际组件、配置与效果仍待后续核对，不等于已装配或功能可用'}
        elif record['role'] == 'body':
            compat = {'conclusion': '支持', 'basis': '素体本身'}
        elif not prefabs and not archive_carries_geometry(files, decisions):
            # A selected archive that lists no prefab and carries no model file installs no geometry, so
            # there is no skeleton for the assembly stage to compare; recording that comparison as the
            # basis would describe a step that cannot happen. `prefabs` is the listing classified_prefabs
            # builds from install paths and the geometry scan reads the archive's own contents, so neither
            # tier decides from the package name.
            compat = {'conclusion': '支持',
                      'basis': '纯材质/贴图包：选中包内没有 prefab，也没有 fbx／obj／blend／dae 等几何载体，'
                               '不含可装配的模型，无骨骼需要比对；导入、引用与实际效果仍待后续验证'}
        elif body_named:
            # The install paths a package carries are the SOP's middle tier: a package that installs a prefab
            # named for this body was published for it. The package filename is only the first tier — it
            # picks which package to open, and deciding compatibility from it is forbidden — so a name that
            # never reaches an install path is recorded as undecided rather than promoted to 支持.
            compat = {'conclusion': '支持', 'basis': f'分包内含本素体专用预制体 {body_named[0]}（开包路径名档：路径命中素体名「{key}」；自动路径匹配，未经逐个人工复核）'}
        else:
            # The body name comes from the body's product name and can be wrong (a version suffix, a name with no
            # Latin word), so the basis names the key it matched with instead of asserting what the package lacks.
            compat = {'conclusion': '待骨骼比对', 'basis': (f'分包里没有含素体名「{key}」的预制体安装路径（素体名取自素体商品名，可能不准），需在装配阶段比对骨骼'
                      if key else '清单里没有可用于路径匹配的素体名，需在装配阶段比对骨骼')}
        record.update(found=True, folder=nfc(folder.name) if folder else None, name=nfc(meta.get('name', '')),
                      shop=(meta.get('shop') or {}).get('name') if isinstance(meta.get('shop'), dict) else meta.get('shop'),
                      url=meta.get('url'), files=decisions, compat=compat, vpm=dependencies,
                      layered=layered,
                      prefabs=prefabs, models=selected_models(files, decisions))
        items.append(record)

    # Preserve each prefab's reference closure separately: the plan chooses a prefab, not every prefab
    # in its archive. Traverse serialized assets as well as external material/texture providers so an
    # embedded material can lead to a texture published in a separate package.
    assets_by_guid = {}
    providers = {}
    for item, facts in package_facts_by_item.items():
        for fact in facts:
            for asset in fact['assets']:
                assets_by_guid.setdefault(asset['guid'], []).append(asset)
                path = asset['path'].lower()
                if not fact['geometry'] and not fact['prefabs'] and \
                        (path.endswith('.mat') or path.endswith(TEXTURE_SUFFIXES)):
                    providers.setdefault(asset['guid'], []).append((item, asset, fact))
    dependency_refs = {}
    dependency_decisions = {}
    for item, facts in package_facts_by_item.items():
        for fact in facts:
            if not fact['decision'].get('selected') or not fact['prefabs']:
                continue
            for prefab in fact['prefabs']:
                found, queue, seen = {}, list(prefab.get('refs', set())), set()
                while queue:
                    guid = queue.pop()
                    if guid in seen:
                        continue
                    seen.add(guid)
                    for asset in assets_by_guid.get(guid, []):
                        queue.extend(asset.get('refs', set()))
                    for provider_item, provider, provider_fact in providers.get(guid, []):
                        ref = {'carrier': item, 'prefab': prefab['path'], 'guids': [guid],
                               'member': provider_fact['member']}
                        decision_refs = provider_fact['decision'].setdefault('dependency_refs', [])
                        if ref not in decision_refs:
                            decision_refs.append(ref)
                        dependency_decisions.setdefault(provider_item, set()).add(provider_fact['decision']['name'])
                        if provider_item != item:
                            found.setdefault(provider_item, set()).add(guid)
                if not found:
                    continue
                for provider_item, guids in sorted(found.items()):
                    dependency_refs.setdefault(provider_item, []).append(
                        {'carrier': item, 'prefab': prefab['path'], 'provider': provider_item,
                         'guids': sorted(guids)})
    for provider_item, refs in dependency_refs.items():
        provider_record = next(row for row in items if row['item'] == provider_item)
        provider_record['dependency_refs'] = refs
        provider_record['dependency_of'] = sorted({ref['carrier'] for ref in refs})
        if provider_record['role'] == 'body' or any(f['geometry'] or f['prefabs']
                for f in package_facts_by_item[provider_item]):
            continue
        provider_record['role'] = 'texture'
        provider_record['compat'] = {
            'conclusion': '支持',
            'basis': '材质／贴图依赖包：包内 GUID 在候选预制体引用图中，承载者为 ' +
                     '、'.join(sorted({ref['carrier'] for ref in refs})) +
                     '；导入后仍须由工程 GUID 引用检查确认实际解析'}
    # Promote only package files that supplied a referenced GUID. The same-item form has no separate
    # dependency obligation; importing the promoted package is enough because the outfit input owns it.
    for provider_item, names in dependency_decisions.items():
        record = next(row for row in items if row['item'] == provider_item)
        for decision in record.get('files', []):
            if decision.get('selected') or decision['name'] not in names:
                continue
            source = next((path for path in item_files(library, provider_item)[1]
                           if nfc(path.name) == decision['name']), None)
            if source is not None:
                decision.update(selected=True, reason='候选预制体引用图中的材质／贴图依赖包', sha256=file_digest(source))

    inventory = {'schema': 'inventory/0.1', 'library': str(library), 'body_key': key, 'items': items,
                 'budget': {'physbone_reserve': PHYSBONE_RESERVE, 'param_bits_reserve': PARAM_BITS_RESERVE}}
    (out / 'inventory.json').write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    # The project dependencies the intake found, as the contract the environment prepares from. Written
    # even when empty: the environment compares it against the accepted lock, so an absent file and a file
    # that says "none" must be the same fact rather than two different ones.
    document = {'schema': 'vpm-requirements/0.1', 'requirements': requirements}
    (out / 'vpm-requirements.json').write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    from plan import build_catalog
    build_catalog(project, manifest)
    (out / '需求.md').write_text(f"# 需求（用户原话，来自输入 Manifest）\n\n{manifest['request'].strip()}\n", encoding='utf-8')

    lines = ['# 建档', '', '| 商品 | 角色 | 装哪些包 | 兼容结论 | 依据 |', '|---|---|---|---|---|']
    for item in items:
        chosen = '、'.join(d['name'] for d in item.get('files', []) if d['selected']) or '—'
        lines.append(f"| {item.get('name') or item['item']} | {item['role']} | {chosen} | {item['compat']['conclusion']} | {item['compat']['basis']} |")
    lines += ['', '## 不装的文件', '']
    for item in items:
        if item.get('layered') and not any(d.get('selected') or d.get('packages') for d in item.get('files', [])):
            continue
        for d in item.get('files', []):
            if not d['selected']:
                lines.append(f"- {item['item']} / {d['name']}：{d['reason']}")
    lines += ['', '## 可选预制体（方案从这里挑，路径是解包后的工程路径）', '']
    for item in items:
        if item.get('layered') and not any(d.get('selected') or d.get('packages') for d in item.get('files', [])):
            continue
        lines.append(f"- {item['item']}（{item['role']}）：" + ('；'.join(item.get('prefabs') or []) or '—'))
    lines += ['', '## 项目 VPM 依赖（由受管环境按固定身份、版本与哈希安装，不在 Assets/ 里解包）', '']
    for row in requirements:
        lines.append(f"- {row['item']} / {row['entry']}（{row['form']}，成员 {row['member']}）→ {row['repository']}")
    if not requirements:
        lines.append('- 无')
    lines += ['', '## 分层源文件（厂商给二次创作者的源文件；不进工程，但决定改色能不能按层做）', '']
    for item in items:
        layered = item.get('layered') or []
        lines.append(f"- {item['item']}（{item['role']}）：" + ('；'.join(row['path'] for row in layered) or '无'))
    lines += ['', '## 预算余量', '', f'- PhysBone 余量：{PHYSBONE_RESERVE}（总数 ≤ 256；60 阶段用实测值对账）',
              f'- 参数位余量：{PARAM_BITS_RESERVE}（同步参数 ≤ 256 位；60 阶段用实测值对账）', '']
    (out / '建档.md').write_text('\n'.join(lines), encoding='utf-8')
    print(f'清点 {len(items)} 件商品，写入 {out}')


if __name__ == '__main__':
    main()
