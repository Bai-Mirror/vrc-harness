"""Frozen, source-bound material dependency recovery into an unaccepted derived layer."""
import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
# Where a registered item is on disk is the intake tool's question, answered in one place for every
# stage that has to open a path the person registered (`setup.py` imports the same helpers).
from intake import on_disk  # noqa: E402
from plan import effective_inventory  # noqa: E402

LAYER = 'Assets/_Harness/Recolor'
REQUEST = LAYER + '/dependencies.json'
RECIPE = LAYER + '/recipe.json'
RECEIPT = LAYER + '/dependency-receipt.json'
DEPENDENCY_OUTPUT = LAYER + '/Dependencies'
COMMON = re.compile(r'material|shader|common|core|dlc', re.I)
DATA = {'.mat', '.png', '.jpg', '.jpeg', '.tga', '.psd', '.exr', '.tif', '.tiff', '.dds', '.cubemap', '.asset'}
GUID = re.compile(rb'^guid: ([0-9a-f]{32})\s*$', re.M)
SHA256 = re.compile(r'^[0-9a-f]{64}$')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def linked(path):
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def nfc(text):
    """The one form recorded names and on-disk names are compared in.

    A folder a macOS-made zip extracted is spelled in NFD (`か`+U+3099) while the very same folder can
    be registered in NFC (`が`), and NTFS and ext4 keep the two spellings as two different names. A path
    is identified by its normalized form; the bytes a file is opened with stay the ones the filesystem
    reports, so nothing is renamed and no record is rewritten to match a disk.
    """
    return unicodedata.normalize('NFC', str(text))


def same_path(left, right):
    """Path equality by normalized identity, keeping the platform's own path rules for the rest."""
    return Path(nfc(left)) == Path(nfc(right))


def within(path, root):
    """Whether `path` sits under `root`, compared by normalized identity."""
    return Path(nfc(path)).is_relative_to(Path(nfc(root)))


def regular(path):
    recorded = Path(path)
    actual = on_disk(recorded) if recorded.is_absolute() else None
    path = actual if actual is not None else recorded
    if not path.is_absolute() or linked(path) or not path.is_file():
        raise ValueError('依赖来源必须是普通文件')
    for parent in path.parents:
        if linked(parent):
            raise ValueError('依赖来源不能经过链接')
    return path.resolve()


def anchors(project):
    _, selected = registered_sources(project)
    return {key: value['sha256'] for key, value in selected.items()
            if value.get('item_path') and nfc(value['item_path'].name) == nfc(Path(key).name)}


def _path_keys(path):
    """Keys for a recorded path and the filesystem spelling intake may have resolved it to."""
    path = Path(path)
    keys = {nfc(str(path))}
    if path.is_absolute():
        keys.add(nfc(str(path.resolve())))
        actual = on_disk(path)
        if actual is not None:
            keys.add(nfc(str(actual.resolve())))
    return keys


def _file_candidates(item_path, name):
    """Possible paths for one inventory file, supporting direct assets and product folders."""
    item_path = Path(item_path)
    if not item_path.is_absolute():
        return []
    actual = on_disk(item_path) or item_path
    if actual.is_file():
        return [item_path] if nfc(actual.name) == nfc(name) else []
    if nfc(actual.name) == nfc(name):
        return [item_path]
    return [item_path / name, item_path / 'files' / name]


def registered_sources(project):
    """Return (all registered files, effectively selected files) keyed by normalized absolute path.

    The raw map deliberately includes unselected files.  A dependency source that is registered but not in the
    effective selection is refused; a source with no registered identity is unavailable as well.  Both maps are
    derived from the same effective_inventory projection used by setup and the observers.
    """
    raw = json.loads((project / '_harness/intake/inventory.json').read_text('utf-8'))
    try:
        approved_plan = json.loads(os.environ.get('AVH_PLAN') or '{}')
    except (TypeError, ValueError) as error:
        raise ValueError('批准方案不是有效 JSON，无法确认依赖锚点：' + str(error))
    effective = effective_inventory(raw, approved_plan)

    def collect(inventory, selected_only):
        result = {}
        for item in inventory.get('items', []):
            item_path = Path(str(item.get('item', '')))
            for row in item.get('files', []):
                if selected_only and not row.get('selected'):
                    continue
                for candidate in _file_candidates(item_path, str(row.get('name', ''))):
                    for key in _path_keys(candidate):
                        result[key] = {'sha256': row.get('sha256'), 'item_path': item_path,
                                       'item': str(item.get('item', '')), 'name': row.get('name'),
                                       'role': item.get('role')}
        return result

    return collect(raw, False), collect(effective, True)


def source_selection(project, path):
    """Classify a dependency path as effective or unavailable under the approved inventory projection."""
    raw, selected = registered_sources(project)
    keys = _path_keys(path)
    for key in keys:
        if key in selected:
            return 'effective', selected[key]
    for key in keys:
        if key in raw:
            return 'not-effective', raw[key]
    return 'not-effective', None


def package_tars(source, scratch):
    if source.suffix.lower() == '.unitypackage':
        packages = [(source.name, source.open('rb'))]
        archive = None
    else:
        archive = zipfile.ZipFile(source)
        packages = [(entry.filename, archive.open(entry)) for entry in archive.infolist()
                    if entry.filename.lower().endswith('.unitypackage')]
    try:
        for index, (name, stream) in enumerate(packages):
            target = scratch / f'package-{index}.tar'
            with stream, gzip.GzipFile(fileobj=stream) as raw, target.open('wb') as out:
                shutil.copyfileobj(raw, out)
            yield name, target
    finally:
        if archive:
            archive.close()


def members(tar):
    entries = {}
    for member in tar.getmembers():
        parts = member.name.replace('\\', '/').split('/')
        if member.isfile() and len(parts) == 2 and re.fullmatch('[0-9a-f]{32}', parts[0]):
            entries.setdefault(parts[0], {})[parts[1]] = member
        elif member.issym() or member.islnk():
            raise ValueError('依赖包不能包含链接')
    for guid, entry in entries.items():
        if 'pathname' not in entry:
            continue
        name = tar.extractfile(entry['pathname']).read().decode('utf-8-sig').strip().replace('\\', '/')
        rel = PurePosixPath(name)
        if not name.startswith('Assets/') or any(part in ('', '.', '..') for part in name.split('/')) or ':' in name:
            raise ValueError('依赖包路径不安全')
        if rel.suffix.lower() in DATA and 'asset' in entry and 'asset.meta' in entry:
            meta = tar.extractfile(entry['asset.meta']).read()
            if GUID.search(meta) is None or GUID.search(meta).group(1).decode() != guid:
                raise ValueError('依赖资产 GUID 与元数据不一致')
            yield guid, name, entry, meta


def inspect(project):
    result = []
    for anchor, expected in anchors(project).items():
        base = regular(Path(anchor))
        if digest(base) != expected:
            raise ValueError('已确认输入来源已变化')
        for source in sorted(base.parent.iterdir()):
            if same_path(source, base) or source.suffix.lower() not in ('.zip', '.unitypackage') or not COMMON.search(source.stem):
                continue
            source = regular(source)
            state, _ = source_selection(project, source)
            if state == 'not-effective':
                continue
            result.append({'anchor': str(base), 'archive': str(source), 'sha256': digest(source)})
    print(json.dumps({'schema': 'material-dependency-candidates/0.1', 'candidates': result}, ensure_ascii=False))


# ---------------------------------------------------------------------------------------------------
# What the recolor layer may inherit from before this stage
#
# The recolor layer is this stage's own output directory, so a file in it is either this stage's work or
# what an earlier workflow left behind when the project was reused. Two of those files are read as input
# by the Unity step, and neither is rebuilt by the Runtime: a `recipe.json` carrying an older recipe
# schema, and a `dependencies.json` whose `iris_layers` the current plan does not authorize (the Unity
# step throws on that one before it does anything). A copy that cannot have come from the current plan is
# therefore not this stage's input, and is moved into the Run's evidence directory — never deleted.
#
# It is deliberately *not* rebuilt here. `recolor_recipe_idempotent` compares the recipe on disk against a
# re-run of the frozen tool, and writing the recipe in this step would make that check vacuous: a stage
# that never generated one would pass it. Superseding instead keeps the check sharp and turns a wrong file
# into the accurate failure "this stage's recolor.py has not written the recipe yet".
# ---------------------------------------------------------------------------------------------------
SUPERSEDED = 'recolor-superseded'
REQUEST_FIELDS = {'schema', 'packages', 'missing_shader_replacement', 'iris_layers'}


def keep_original(path):
    """Move a superseded file under this Run and return where it was kept.

    Unity's `<name>.meta` sidecar moves with it, so the layer is not left describing a file that is gone.
    """
    run = os.environ.get('AVH_RUN_DIR')
    if not run:
        raise ValueError(f'本次 Run 目录未知，不能保留被替换的原件：{path}')
    keep = Path(run) / SUPERSEDED
    keep.mkdir(parents=True, exist_ok=True)
    target = keep / path.name
    if target.exists():
        duplicate = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
        target = keep / f'{path.stem}-{duplicate}{path.suffix}'
    shutil.move(str(path), str(target))
    sidecar = path.with_suffix(path.suffix + '.meta')
    if sidecar.is_file():
        shutil.move(str(sidecar), str(target.with_suffix(target.suffix + '.meta')))
    return target


def eye_authorized():
    """Whether the plan this stage runs under authorizes an eye colour target at all."""
    plan = json.loads(os.environ.get('AVH_PLAN') or '{}')
    targets = (plan.get('recolor') or {}).get('targets') or []
    return any(isinstance(row, dict) and row.get('part') == 'eye' for row in targets)


def drop_unauthorized_iris(project):
    """Take an `iris_layers` proposal the plan does not authorize out of the request without losing it.

    Only that one section goes: `packages` is validated on its own further down, and a plan with no eye
    target has no eye requirement this could silently skip. The plan is the authority on what may be
    changed, so the proposal is kept as Run evidence rather than acted on.
    """
    path = project / REQUEST
    if not path.is_file() or linked(path):
        return
    request = json.loads(path.read_text('utf-8'))
    if not isinstance(request, dict) or not request.get('iris_layers') or eye_authorized():
        return
    kept = keep_original(path)
    path.write_text(json.dumps({**request, 'iris_layers': []}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'当前方案没有眼色目标，本阶段不启用虹膜层；原请求已保留在 {kept}')


def recipe_is_current(project):
    """Whether `recipe.json` is byte-for-byte what the frozen tool makes of this plan.

    This is the comparison `observe_recolor.py` makes for `recolor_recipe_idempotent`, read as "is this
    file this stage's own output" rather than as a verdict.
    """
    path = project / RECIPE
    if not path.is_file() or linked(path):
        return True
    tool_root = os.environ.get('AVH_TOOL_ROOT')
    if not tool_root:
        raise ValueError('缺少工具根，无法核对配方是否属于本次方案')
    tools = Path(tool_root) / 'harness'
    if str(tools) not in sys.path:
        sys.path.insert(0, str(tools))
    import recolor  # noqa: E402  (the frozen generator is the only authority on the recipe format)
    plan = json.loads(os.environ.get('AVH_PLAN') or '{}')
    recipe = json.loads(path.read_text('utf-8'))
    try:
        again = recolor.serialize(recolor.build_recipe(plan, recipe.get('feedback', '')))
    except ValueError:
        return False
    return again.encode('utf-8') == path.read_bytes()


def supersede_stale_inputs(project):
    """Clear the recolor layer of what this stage cannot have produced. Called before anything reads it."""
    request_path = project / REQUEST
    if request_path.is_file() and not linked(request_path):
        if json.loads(request_path.read_text('utf-8')).get('schema') != 'material-dependencies/0.1':
            kept = keep_original(request_path)
            print(f'依赖请求不是本流程的格式，已保留在 {kept}，本阶段从零开始')
    if not recipe_is_current(project):
        kept = keep_original(project / RECIPE)
        print(f'工程里的配方不是本次冻结工具按当前方案产出的，已保留在 {kept}；'
              '本阶段的 generate-recolor-candidates 必须按当前方案重新产出配方')
    drop_unauthorized_iris(project)


def read_dependency_receipt(project):
    path = project / RECEIPT
    if not path.is_file() or linked(path):
        return None
    try:
        value = json.loads(path.read_text('utf-8'))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) and value.get('schema') == 'material-dependency-receipt/0.1' else None


def dependency_receipt_records(receipt):
    """Flatten current and historical dependency receipts, including the pre-F25 nested shape."""
    if not isinstance(receipt, dict):
        return []
    current = {key: value for key, value in receipt.items() if key not in ('history', 'retired')}
    rows = [current]
    for entry in receipt.get('history') or []:
        rows.extend(dependency_receipt_records(entry))
    return rows


def _path_identity(path):
    """A normalized key used only for detecting ambiguous directory entries."""
    return nfc(str(path).replace('\\', '/')).casefold()


def _check_actual_path(project, relative, *, allow_missing=True):
    """Check every component against the actual directory entry spelling.

    A receipt is evidence about one concrete path.  Case-folding and Unicode normalization are used only to
    detect ambiguity; they never select a different file.
    """
    parts = tuple(PurePosixPath(relative).parts)
    current = project
    for part in parts:
        try:
            entries = list(current.iterdir()) if current.is_dir() else []
        except OSError as error:
            raise ValueError(f'无法确认依赖回执路径的实际拼写：{relative}：{error}') from error
        groups = {}
        for entry in entries:
            groups.setdefault(_path_identity(entry.name), []).append(entry)
        ambiguous = groups.get(_path_identity(part), [])
        if len({entry.name for entry in ambiguous}) > 1:
            raise ValueError(f'依赖回执路径归一化后对应多个实际目录项：{relative}；请保留该来源的使用，或在新工程中重做配色')
        exact = next((entry for entry in entries if entry.name == part), None)
        if exact is None:
            if ambiguous:
                raise ValueError(f'依赖回执路径大小写或 Unicode 归一化不一致：{relative}；请保留该来源的使用，或在新工程中重做配色')
            if allow_missing:
                return project.joinpath(*parts), False
            raise ValueError(f'依赖回执路径不存在：{relative}')
        if linked(exact):
            raise ValueError(f'依赖回执路径经过链接或 junction，不能自动退役：{relative}；请保留该来源的使用，或在新工程中重做配色')
        current = exact
    return current, True


def _dependency_asset_path(project, relative):
    """Validate one receipt path before opening it.

    Receipts are project-relative POSIX paths.  The exact NFC/case spelling is part of the evidence: accepting
    a case-folded or NFD spelling here could make a receipt point at a different file on another host.
    """
    if not isinstance(relative, str) or not relative or '\\' in relative or nfc(relative) != relative:
        raise ValueError(f'依赖回执路径不安全（必须是 NFC、大小写精确的 POSIX 路径）：{relative!r}')
    parts = PurePosixPath(relative).parts
    expected = ('Assets', '_Harness', 'Recolor', 'Dependencies')
    if parts[:len(expected)] != expected or len(parts) <= len(expected) or any(part in ('', '.', '..') for part in parts):
        raise ValueError(f'依赖回执路径越界或不在 {DEPENDENCY_OUTPUT}/ 下：{relative}')
    if any(':' in part for part in parts) or parts[-1].endswith('.meta'):
        raise ValueError(f'依赖回执路径不是派生文件：{relative}')
    target = project.joinpath(*parts)
    meta = Path(str(target) + '.meta')
    try:
        project_root = project.resolve()
        if not target.absolute().is_relative_to(project_root) or not meta.absolute().is_relative_to(project_root):
            raise ValueError(f'依赖回执路径越界：{relative}')
    except OSError as error:
        raise ValueError(f'无法确认依赖回执路径：{relative}：{error}') from error
    relative_target = target.relative_to(project)
    for path in (project, *(project / parent for parent in relative_target.parents), target, meta):
        if linked(path):
            raise ValueError(f'依赖回执路径经过链接或 junction，不能自动退役：{relative}；请保留该来源的使用，或在新工程中重做配色')
    _check_actual_path(project, relative)
    return target


def _receipt_write(project, receipt):
    """Replace the receipt atomically so a failed deletion never leaves a half-written JSON document."""
    path = project / RECEIPT
    descriptor, temporary_name = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _run_identity():
    value = os.environ.get('AVH_RUN_ID')
    if value:
        return value
    directory = os.environ.get('AVH_RUN_DIR')
    return Path(directory).name if directory else 'unknown'


def _utc_now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _receipt_nodes(receipt):
    """Yield the current record and all historical records without flattening away mutation identity."""
    if not isinstance(receipt, dict):
        return
    yield receipt
    for entry in receipt.get('history') or []:
        yield from _receipt_nodes(entry)


def _remove_receipt_asset(receipt, path):
    for record in _receipt_nodes(receipt):
        for package in record.get('packages') or []:
            package['assets'] = [asset for asset in package.get('assets') or []
                                 if asset.get('path') != path]


def _pending_intents(receipt):
    """Return the deletion intents, migrating the pre-R26 pending shape in place."""
    pending = receipt.get('pending_retirements')
    if pending is None:
        pending = []
        receipt['pending_retirements'] = pending
    if not isinstance(pending, list):
        raise ValueError('依赖回执的 pending_retirements 不是列表，无法安全恢复')
    retired = receipt.get('retired') or []
    if not isinstance(retired, list):
        raise ValueError('依赖回执的 retired 历史不是列表，无法安全退役')
    migrated = []
    for row in list(retired):
        if isinstance(row, dict) and row.get('status') == 'pending':
            if row not in pending:
                pending.append(row)
            retired.remove(row)
            migrated.append(row)
    return pending, bool(migrated)


def _asset_hashes(asset, path, retired):
    sha = asset.get('sha256')
    meta_sha = asset.get('meta_sha256')
    if (not isinstance(sha, str) or not SHA256.fullmatch(sha) or
            not isinstance(meta_sha, str) or not SHA256.fullmatch(meta_sha)):
        raise ValueError(f'依赖派生文件 {path} 缺少 sha256/meta_sha256；不能自动处理。请保留该来源的使用，或在新工程中重做配色')
    if retired:
        # A pending journal is the only evidence that one side was already removed by a prior interrupted run.
        if retired.get('sha256') != sha or retired.get('meta_sha256') != meta_sha:
            raise ValueError(f'依赖派生文件 {path} 的退役日志与当前回执哈希不一致；请保留该来源的使用，或在新工程中重做配色')
    return sha, meta_sha


def _pending_candidate(project, row):
    """Validate a pending row's concrete paths and return its identity for source re-selection recovery."""
    relative = row.get('path') if isinstance(row, dict) else None
    if not isinstance(relative, str):
        raise ValueError('依赖回执的退役意图缺少有效路径')
    target = _dependency_asset_path(project, relative)
    meta = Path(str(target) + '.meta')
    _check_actual_path(project, relative + '.meta')
    sha, meta_sha = _asset_hashes(row, relative, row)
    for path, expected, label in ((target, sha, '文件'), (meta, meta_sha, '.meta')):
        if not path.exists():
            continue
        if linked(path) or not path.is_file():
            raise ValueError(f'依赖派生{label} {relative} 不是普通文件；请保留该来源的使用，或在新工程中重做配色')
        try:
            actual = digest(path)
        except OSError as error:
            raise ValueError(f'无法确认依赖派生{label} {relative}：{error}') from error
        if actual != expected:
            raise ValueError(f'依赖派生{label} {relative} 可能被改过（回执 {expected}，实际 {actual}）；请保留该来源或在新工程中重做配色')
    guid = row.get('guid')
    if meta.exists():
        try:
            meta_bytes = meta.read_bytes()
        except OSError as error:
            raise ValueError(f'无法读取依赖派生 .meta {relative}：{error}') from error
        match = GUID.search(meta_bytes)
        if not match:
            raise ValueError(f'依赖派生 .meta {relative} 没有可确认的 GUID；请保留该来源的使用，或在新工程中重做配色')
        guid = match.group(1).decode('ascii')
    if not isinstance(guid, str) or not re.fullmatch(r'[0-9a-f]{32}', guid):
        raise ValueError(f'依赖派生 .meta {relative} 的 GUID 无法确认；请保留该来源的使用，或在新工程中重做配色')
    return {'path': relative, 'target': target, 'meta': meta, 'sha256': sha,
            'meta_sha256': meta_sha, 'guid': guid}


def _restore_pending_from_source(project, row, candidate, source_record):
    """Restore a missing side of a pending output from its still-effective, hash-checked source package."""
    source_value = row.get('archive') or row.get('anchor')
    if not source_value:
        raise ValueError(f'依赖退役意图 {candidate["path"]} 缺少可恢复来源')
    source = regular(Path(source_value))
    expected_source = row.get('source_sha256') or (row.get('source') or {}).get('sha256') or (source_record or {}).get('sha256')
    if not isinstance(expected_source, str) or not SHA256.fullmatch(expected_source) or digest(source) != expected_source:
        raise ValueError(f'依赖退役意图 {candidate["path"]} 的有效来源已变化，无法安全恢复；请保留该来源的使用或重做配色')
    asset_bytes = meta_bytes = None
    with tempfile.TemporaryDirectory(dir=os.environ.get('AVH_RUN_DIR')) as temporary:
        for _, package in package_tars(source, Path(temporary)):
            with tarfile.open(package) as tar:
                for guid, name, entry, meta in members(tar):
                    if guid != candidate['guid']:
                        continue
                    with tar.extractfile(entry['asset']) as stream:
                        asset_bytes = stream.read()
                    meta_bytes = meta
                    break
            if asset_bytes is not None:
                break
    if asset_bytes is None or hashlib.sha256(asset_bytes).hexdigest() != candidate['sha256'] or hashlib.sha256(meta_bytes).hexdigest() != candidate['meta_sha256']:
        raise ValueError(f'有效来源无法重建依赖派生文件 {candidate["path"]} 的回执哈希；请保留该来源的使用或重做配色')
    if not candidate['target'].exists():
        candidate['target'].parent.mkdir(parents=True, exist_ok=True)
        candidate['target'].write_bytes(asset_bytes)
    if not candidate['meta'].exists():
        candidate['meta'].write_bytes(meta_bytes)
    if digest(candidate['target']) != candidate['sha256'] or digest(candidate['meta']) != candidate['meta_sha256']:
        raise ValueError(f'恢复后的依赖派生文件 {candidate["path"]} 回读哈希不一致；请保留该来源的使用或重做配色')


def _reconcile_reselected_pending(project, receipt, pending):
    """Revoke pending retirement when its source is effective again, preserving the revocation evidence."""
    retired = receipt.setdefault('retired', [])
    changed = False
    for row in list(pending):
        source_value = row.get('archive') or row.get('anchor')
        if not source_value:
            continue
        state, source_record = source_selection(project, source_value)
        if state != 'effective':
            continue
        candidate = _pending_candidate(project, row)
        if not candidate['target'].exists() or not candidate['meta'].exists():
            _restore_pending_from_source(project, row, candidate, source_record)
        history_row = dict(row)
        history_row['status'] = 'revoked'
        history_row['revoked_at'] = _utc_now()
        history_row['revoke_reason'] = 'source-reselected'
        history_row['guid'] = candidate['guid']
        retired.append(history_row)
        pending.remove(row)
        changed = True
    if changed:
        _receipt_write(project, receipt)
    return changed


def _scan_guid_references(project, guid, excluded):
    """Find active YAML references under Assets and local Packages, refusing unreadable files."""
    roots = [project / 'Assets', project / 'Packages']
    receipt = project / RECEIPT
    # Compare the spelling yielded by os.walk with the spelling already checked against the directory entries.
    # A normalized key would incorrectly exclude a distinct NFD/case variant.
    excluded_paths = {str(Path(path).absolute()) for path in excluded}
    excluded_paths.add(str(receipt.absolute()))
    pattern = re.compile(rb'\bguid:\s*' + guid.encode('ascii') + rb'\b')
    found = []
    for root in roots:
        if not root.exists():
            continue
        if linked(root):
            raise ValueError(f'无法确认 GUID {guid} 的引用：扫描根目录经过链接或 junction：{root}')
        for directory, dirs, files in os.walk(root, topdown=True, onerror=lambda error: (_ for _ in ()).throw(error)):
            directory_path = Path(directory)
            if linked(directory_path):
                raise ValueError(f'无法确认 GUID {guid} 的引用：目录经过链接或 junction：{directory_path}')
            dirs[:] = sorted(dirs)
            names = dirs + files
            normalized = {}
            for name in names:
                normalized.setdefault(_path_identity(name), []).append(name)
            if any(len(set(values)) > 1 for values in normalized.values()):
                raise ValueError(f'无法确认 GUID {guid} 的引用：目录项大小写或 Unicode 归一化后有多个实际文件：{directory_path}')
            for name in dirs:
                if linked(directory_path / name):
                    raise ValueError(f'无法确认 GUID {guid} 的引用：目录经过链接或 junction：{directory_path / name}')
            for name in sorted(files):
                path = directory_path / name
                if linked(path) or str(path.absolute()) in excluded_paths:
                    if linked(path):
                        raise ValueError(f'无法确认 GUID {guid} 的引用：文件经过链接或 junction：{path}')
                    continue
                try:
                    data = path.read_bytes()
                except OSError as error:
                    raise ValueError(f'无法确认 GUID {guid} 的引用：读取失败 {path}：{error}') from error
                if pattern.search(data):
                    found.append(path.relative_to(project).as_posix())
    return sorted(set(found))


def _dependency_retirement_candidates(project, receipt):
    """Collect and fully preflight excluded derived assets before any deletion occurs."""
    pending_rows, _ = _pending_intents(receipt)
    grouped = {}
    for record in _receipt_nodes(receipt):
        for package in record.get('packages') or []:
            states = [source_selection(project, package.get(field))[0]
                      for field in ('anchor', 'archive') if package.get(field)]
            if package.get('assets') and not states:
                raise ValueError('依赖回执缺少来源身份，无法确认哪些派生文件可退役')
            excluded_source = 'not-effective' in states
            for asset in package.get('assets') or []:
                if not isinstance(asset, dict):
                    raise ValueError('依赖回执的派生文件记录无效，无法安全退役')
                relative = asset.get('path')
                if not isinstance(relative, str):
                    raise ValueError(f'依赖回执中的派生文件路径无效：{relative!r}')
                if relative not in grouped:
                    grouped[relative] = {'asset': asset, 'package': package,
                                         'excluded': excluded_source, 'effective': not excluded_source}
                else:
                    grouped[relative]['excluded'] |= excluded_source
                    grouped[relative]['effective'] |= not excluded_source
    # A pending-only intent still has to prove the source is excluded and must take the same preflight path.
    for row in pending_rows:
        relative = row.get('path') if isinstance(row, dict) else None
        if not isinstance(relative, str):
            raise ValueError('依赖回执的退役意图缺少有效路径')
        if relative in grouped:
            if grouped[relative].get('effective'):
                raise ValueError(f'依赖回执的退役意图 {relative} 对应来源已重新选用，无法自动删除；请保留该来源的使用或重做配色')
            continue
        source_field = 'archive' if row.get('archive') else 'anchor'
        states = [source_selection(project, row.get(source_field))[0]] if row.get(source_field) else []
        if not states:
            raise ValueError(f'依赖回执的退役意图 {relative} 缺少来源身份，无法恢复')
        if 'effective' in states:
            raise ValueError(f'依赖回执的退役意图 {relative} 对应来源已重新选用，无法自动删除；请保留该来源的使用或重做配色')
        grouped[relative] = {'asset': row, 'package': row, 'excluded': True, 'effective': False}
    candidates = []
    for relative, value in grouped.items():
        if not value.get('excluded') or value.get('effective'):
            continue
        if not isinstance(relative, str):
            raise ValueError(f'依赖回执中的派生文件路径无效：{relative!r}')
        pending = next((row for row in pending_rows
                        if row.get('path') == relative and
                        row.get('sha256') == value['asset'].get('sha256') and
                        row.get('meta_sha256') == value['asset'].get('meta_sha256')), None)
        if any(row.get('path') == relative and row is not pending for row in pending_rows):
            raise ValueError(f'依赖回执对 {relative} 同时存在不同退役意图，无法确认哪一批文件可删除')
        target = _dependency_asset_path(project, relative)
        asset = value['asset']
        sha, meta_sha = _asset_hashes(asset, relative, pending)
        meta = Path(str(target) + '.meta')
        _check_actual_path(project, relative + '.meta')
        for path, expected, label in ((target, sha, '文件'), (meta, meta_sha, '.meta')):
            if path.exists():
                if linked(path) or not path.is_file():
                    raise ValueError(f'依赖派生{label} {relative} 不是普通文件；请保留该来源的使用，或在新工程中重做配色')
                try:
                    actual = digest(path)
                except OSError as error:
                    raise ValueError(f'无法确认依赖派生{label} {relative}：{error}') from error
                if actual != expected:
                    raise ValueError(f'依赖派生{label} {relative} 可能被改过（回执 {expected}，实际 {actual}）；请保留该来源或在新工程中重做配色')
            elif not pending:
                raise ValueError(f'依赖派生{label} {relative} 缺失，无法确认回执哈希；请保留该来源的使用，或在新工程中重做配色')
        guid = pending.get('guid') if pending else None
        if meta.exists():
            try:
                meta_bytes = meta.read_bytes()
            except OSError as error:
                raise ValueError(f'无法读取依赖派生 .meta {relative}：{error}') from error
            match = GUID.search(meta_bytes)
            if not match:
                raise ValueError(f'依赖派生 .meta {relative} 没有可确认的 GUID；请保留该来源的使用，或在新工程中重做配色')
            guid = match.group(1).decode('ascii')
        if not isinstance(guid, str) or not re.fullmatch(r'[0-9a-f]{32}', guid):
            raise ValueError(f'依赖派生 .meta {relative} 的 GUID 无法确认；请保留该来源的使用，或在新工程中重做配色')
        candidates.append({'path': relative, 'target': target, 'meta': meta, 'sha256': sha,
                           'meta_sha256': meta_sha, 'guid': guid, 'pending': pending,
                           'anchor': value['package'].get('anchor'), 'archive': value['package'].get('archive'),
                           'source_sha256': value['package'].get('sha256')})
    excluded = [path for candidate in candidates for path in (candidate['target'], candidate['meta'])]
    for candidate in candidates:
        if not candidate['target'].exists() and not candidate['meta'].exists():
            candidate['already_absent'] = True
            continue
        references = _scan_guid_references(project, candidate['guid'], excluded)
        if references:
            raise ValueError(f"依赖派生文件 {candidate['path']} 仍被工程引用（GUID {candidate['guid']}）：" + ', '.join(references))
        candidate['references'] = references
    return candidates


def retire_excluded_dependencies(project, receipt):
    """Safely retire excluded recolor outputs, journaling progress so an interrupted delete can resume."""
    if not isinstance(receipt, dict):
        return receipt
    pending, migrated = _pending_intents(receipt)
    if migrated:
        _receipt_write(project, receipt)
    _reconcile_reselected_pending(project, receipt, pending)
    candidates = _dependency_retirement_candidates(project, receipt)
    if not candidates:
        return receipt
    retired = receipt.setdefault('retired', [])
    now = _utc_now()
    run_id = _run_identity()
    for candidate in candidates:
        row = candidate['pending'] or {
            'path': candidate['path'], 'sha256': candidate['sha256'], 'meta_sha256': candidate['meta_sha256'],
            'anchor': candidate['anchor'], 'archive': candidate['archive'], 'source_sha256': candidate['source_sha256'],
            'source': {'anchor': candidate['anchor'], 'archive': candidate['archive'],
                       'sha256': candidate['source_sha256']},
            'run_id': run_id, 'retired_at': now, 'status': 'pending',
            'file_deleted': False, 'meta_deleted': False, 'guid': candidate['guid'],
            'batch_id': f'{run_id}:{now}',
        }
        if row not in pending:
            pending.append(row)
    _receipt_write(project, receipt)
    for candidate in candidates:
        row = next(item for item in pending if item.get('path') == candidate['path'] and
                   item.get('sha256') == candidate['sha256'] and item.get('meta_sha256') == candidate['meta_sha256'])
        try:
            if candidate['target'].exists():
                if digest(candidate['target']) != row['sha256']:
                    raise ValueError(f'依赖派生文件 {candidate["path"]} 可能被改过；请保留该来源或在新工程中重做配色')
                candidate['target'].unlink()
                row['file_deleted'] = True
                _receipt_write(project, receipt)
            elif not row.get('file_deleted'):
                row['file_deleted'] = True
                _receipt_write(project, receipt)
            if candidate['meta'].exists():
                if digest(candidate['meta']) != row['meta_sha256']:
                    raise ValueError(f'依赖派生 .meta {candidate["path"]} 可能被改过；请保留该来源或在新工程中重做配色')
                candidate['meta'].unlink()
                row['meta_deleted'] = True
                _receipt_write(project, receipt)
            elif not row.get('meta_deleted'):
                row['meta_deleted'] = True
                _receipt_write(project, receipt)
        except OSError as error:
            try:
                _receipt_write(project, receipt)
            except OSError:
                pass
            raise ValueError(f'删除依赖派生文件 {candidate["path"]} 中途失败；已记录进度，下次 prepare 会重新校验后继续：{error}') from error
        if candidate['target'].exists() or candidate['meta'].exists():
            raise ValueError(f'依赖派生文件 {candidate["path"]} 删除状态无法确认；请保留该来源的使用，或在新工程中重做配色')
        history_row = dict(row)
        history_row['status'] = 'deleted'
        history_row['retired_at'] = _utc_now()
        history_row['guid_reference'] = f'guid: {candidate["guid"]}'
        _remove_receipt_asset(receipt, candidate['path'])
        pending.remove(row)
        retired.append(history_row)
        _receipt_write(project, receipt)
    return receipt


def assert_dependency_history_absent(project, receipt):
    """Retire excluded recolor outputs after proving their bytes and references are safe."""
    return retire_excluded_dependencies(project, receipt)


def prepare(project, sources):
    # Nothing left in the layer by an earlier workflow is read as this stage's input.
    supersede_stale_inputs(project)
    # Compiler updates are a Runtime CAS operation, never inferred from edited source bytes.
    from local_operations import contract
    contract(project, sources, install=True, extended_recolor=True)
    request_path = project / REQUEST
    if linked(project / RECEIPT):
        raise ValueError('依赖回执不能是链接')
    previous_receipt = read_dependency_receipt(project)
    assert_dependency_history_absent(project, previous_receipt)
    if not request_path.exists():
        return
    if linked(request_path):
        raise ValueError('依赖请求不能是链接')
    request = json.loads(request_path.read_text('utf-8'))
    if request.get('schema') != 'material-dependencies/0.1' or set(request) - REQUEST_FIELDS:
        raise ValueError('依赖请求格式无效')
    roots = [(on_disk(Path(root)) or Path(root)).resolve() for root in json.loads(os.environ.get('AVH_ASSET_SEARCH_ROOTS_JSON', '[]'))]
    selected = anchors(project)
    existing = {}
    for top in ('Assets', 'Packages'):
        for meta in (project / top).rglob('*.meta'):
            if linked(meta):
                continue
            match = GUID.search(meta.read_bytes()[:300])
            if match:
                existing.setdefault(match.group(1).decode(), []).append(meta.with_suffix(''))
    proposed, receipts, seen = [], [], set()
    output = project / LAYER / 'Dependencies'
    for parent in (project, project / 'Assets', project / 'Assets/_Harness', project / LAYER, output):
        if linked(parent):
            raise ValueError('派生依赖目录不能经过链接')
    with tempfile.TemporaryDirectory(dir=os.environ.get('AVH_RUN_DIR')) as temp:
        scratch = Path(temp)
        for number, row in enumerate(request.get('packages', [])):
            if set(row) != {'anchor', 'archive', 'sha256'}:
                raise ValueError('依赖来源字段无效')
            anchor, source = regular(row['anchor']), regular(row['archive'])
            if nfc(anchor) not in selected or digest(anchor) != selected[nfc(anchor)]:
                raise ValueError('依赖锚点不是已确认的输入版本')
            if not roots or not any(within(source, root) and within(anchor, root) for root in roots):
                raise ValueError('依赖来源不在用户授权的素材目录')
            if not same_path(source.parent, anchor.parent) or not COMMON.search(source.stem) or nfc(source) in seen:
                raise ValueError('依赖必须是同商品目录下唯一的公共材质包')
            seen.add(nfc(source))
            if digest(source) != row['sha256']:
                raise ValueError('依赖包与观察版本不一致')
            source_state, source_record = source_selection(project, source)
            if source_state == 'not-effective':
                raise ValueError('依赖源包不是有效选择，不能恢复')
            if source_state == 'effective' and source_record.get('sha256') and digest(source) != source_record['sha256']:
                raise ValueError('依赖源包不是已确认的输入版本')
            snapshot = scratch / f'source-{number}{source.suffix}'
            shutil.copyfile(source, snapshot)
            if digest(snapshot) != row['sha256']:
                raise ValueError('依赖快照与观察版本不一致')
            package_assets = []
            for _, package in package_tars(snapshot, scratch):
                with tarfile.open(package) as tar:
                    for guid, name, entry, meta in members(tar):
                        staged = scratch / f'{guid}.asset'
                        with tar.extractfile(entry['asset']) as raw, staged.open('wb') as out:
                            shutil.copyfileobj(raw, out)
                        sha = digest(staged)
                        matches = existing.get(guid, [])
                        outside = [p for p in matches if not within(p, output)]
                        if outside:
                            if len(outside) != 1 or not outside[0].is_file() or digest(outside[0]) != sha:
                                raise ValueError('依赖 GUID 与现有源资产冲突，不能覆盖原件')
                            continue
                        target = output / guid / Path(name).name
                        if linked(target) or (target.parent.exists() and linked(target.parent)):
                            raise ValueError('依赖输出不能是链接')
                        if any(p != target for p in matches):
                            raise ValueError('派生依赖 GUID 有重复来源')
                        if any(value[0] == target and value[3] != sha for value in proposed):
                            raise ValueError('公共材质包的同 GUID 内容冲突')
                        copy = scratch / f'asset-{len(proposed)}'
                        shutil.copyfile(staged, copy)
                        proposed.append((target, copy, meta, sha))
                        package_assets.append({'path': target.relative_to(project).as_posix(), 'sha256': sha, 'meta_sha256': hashlib.sha256(meta).hexdigest()})
            receipts.append({**row, 'assets': package_assets})
        # Validate every source and collision before the first derived write. Accepted layers are never touched.
        for target, staged, meta, sha in proposed:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(staged, target)
            target.with_suffix(target.suffix + '.meta').write_bytes(meta)
            if digest(target) != sha:
                raise ValueError('依赖写入回读不一致')
    receipt = {'schema': 'material-dependency-receipt/0.1', 'request_sha256': digest(request_path), 'packages': receipts}
    if previous_receipt and previous_receipt.get('retired'):
        receipt['retired'] = previous_receipt['retired']
    if previous_receipt and previous_receipt.get('pending_retirements'):
        receipt['pending_retirements'] = previous_receipt['pending_retirements']
    history = dependency_receipt_records(previous_receipt)
    if history:
        receipt['history'] = history
    (project / RECEIPT).write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['inspect', 'prepare'])
    parser.add_argument('sources', nargs='*', type=Path)
    parser.add_argument('--project', type=Path, default=Path(os.environ.get('AVH_PROJECT_DIR', '.')))
    args = parser.parse_args()
    if args.action == 'inspect':
        inspect(args.project)
    else:
        prepare(args.project, args.sources)


if __name__ == '__main__':
    main()
