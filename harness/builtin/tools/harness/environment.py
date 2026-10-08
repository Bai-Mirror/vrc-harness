#!/usr/bin/env python3
"""Prepare an immutable, reproducible baseline from a frozen public recipe.

Run only as a Runtime-owned tool with a project lock. No VCC settings, user template
installation, package scripts, credentials or existing Unity project are modified.
The separate `verify` invocation re-reads the actual tree; a receipt alone is not proof.
"""
import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import stat
import tarfile
import urllib.request
import urllib.error
import uuid
import zipfile
from pathlib import Path, PurePosixPath

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from plan import effective_inventory, nfc  # noqa: E402


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def no_links(root):
    root = Path(root)
    if root.is_symlink() or getattr(root, 'is_junction', lambda: False)():
        raise ValueError('环境目录不能经过符号链接或目录联接')
    for entry in root.rglob('*'):
        if entry.is_symlink() or getattr(entry, 'is_junction', lambda: False)():
            raise ValueError('环境内容不能含符号链接或目录联接')


def tree(root):
    no_links(root)
    return {p.relative_to(root).as_posix(): digest(p) for p in sorted(Path(root).rglob('*'))
            if p.is_file() and p != Path(root) / '.environment-receipt.json'}


def checked_root(project):
    project = Path(project).resolve(strict=True)
    root = project / '_harness' / 'environment'
    for directory in (project / '_harness', root):
        if directory.is_symlink() or getattr(directory, 'is_junction', lambda: False)():
            raise ValueError('准备目录不能经过符号链接或目录联接')
    root.mkdir(parents=True, exist_ok=True)
    no_links(root)
    return root


def recipe_file(path):
    recipe = read(path)
    if recipe.get('schema') != 'environment-recipe/0.1' or not re.fullmatch(r'\d+\.\d+\.\d+f\d+', recipe.get('unity', '')):
        raise ValueError('环境配方格式无效')
    ids = [p['id'] for p in [*recipe['packages'], *recipe.get('registryPackages', [])]]
    if len(set(ids)) != len(ids) or any(not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]+', p) for p in ids):
        raise ValueError('环境配方包含重复或无效包名')
    for item in [recipe['template'], *recipe['packages'], *recipe.get('registryPackages', [])]:
        if not item['url'].startswith('https://') or not re.fullmatch(r'[0-9a-f]{64}', item['sha256']):
            raise ValueError('依赖必须固定 HTTPS 来源和 SHA-256')
    for key in ('maxDownloadBytes', 'maxExpandedBytes'):
        if not isinstance(recipe[key], int) or not 0 < recipe[key] <= 2**31:
            raise ValueError('环境配方必须包含有界下载与展开预算')
    return recipe


class HttpsRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith('https://'):
            raise ValueError('拒绝依赖下载降级到非 HTTPS')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(item, cache, limit):
    target = cache / (item['sha256'] + '.zip')
    if target.exists():
        if target.stat().st_size > limit:
            raise ValueError('依赖缓存超出配方预算')
        if digest(target) != item['sha256']:
            raise ValueError('依赖缓存摘要不一致；保留现场，不能复用或静默覆盖')
        return target
    cache.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix('.partial')
    # Partial bytes are only a resumable candidate; the pinned digest still decides acceptance.
    opener = urllib.request.build_opener(HttpsRedirect())
    if part.exists() and part.stat().st_size <= limit and digest(part) == item['sha256']:
        part.rename(target)
        return target
    for attempt in range(3):
        offset = part.stat().st_size if part.exists() else 0
        if offset > limit:
            raise ValueError('未完成下载超出配方预算')
        headers = {'User-Agent': 'Avatar-Harness/0.1'}
        if offset:
            headers['Range'] = 'bytes=' + str(offset) + '-'
        request = urllib.request.Request(item['url'], headers=headers)
        try:
            with opener.open(request, timeout=60) as response:
                append = response.status == 206
                if append and not response.headers.get('Content-Range', '').startswith('bytes ' + str(offset) + '-'):
                    raise ValueError('断点续传范围与本地临时文件不一致')
                size = offset if append else 0
                with part.open('ab' if append else 'wb') as output:
                    while data := response.read(1024 * 1024):
                        size += len(data)
                        if size > limit:
                            raise ValueError('依赖下载超出配方预算')
                        output.write(data)
            break
        except (OSError, urllib.error.URLError, http.client.IncompleteRead):
            if attempt == 2:
                raise
            print('依赖连接中断，保留已下载数据并有限重试', flush=True)
    if digest(part) != item['sha256']:
        raise ValueError('依赖下载摘要不一致；未发布为可用缓存')
    part.rename(target)
    return target


def extract(archive, destination, limit, archive_format='zip'):
    if archive_format == 'tgz':
        return extract_tar(archive, destination, limit)
    if archive_format != 'zip':
        raise ValueError('不支持的依赖归档格式')
    with zipfile.ZipFile(archive) as source:
        members = source.infolist()
        if sum(m.file_size for m in members) > limit or len(members) > 100000:
            raise ValueError('依赖展开超出配方预算')
        names = set()
        for member in members:
            name = member.filename.replace('\\', '/')
            path = PurePosixPath(name)
            parts = path.parts
            if path.is_absolute() or not parts or any(p in ('.', '..') or ':' in p or p.endswith((' ', '.')) for p in parts):
                raise ValueError('依赖包含不安全路径')
            if stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError('依赖包含符号链接')
            key = name.rstrip('/').casefold()
            if key in names:
                raise ValueError('依赖包含重复或大小写冲突的路径')
            names.add(key)
        destination.mkdir(parents=True, exist_ok=False)
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.filename.replace('\\', '/')).parts)
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(member) as data, target.open('xb') as output:
                    shutil.copyfileobj(data, output)


def extract_tar(archive, destination, limit):
    # Do not use extractall: links, devices and archive-supplied permissions are not part of a package receipt.
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        if sum(m.size for m in members) > limit or len(members) > 100000:
            raise ValueError('依赖展开超出配方预算')
        names = set()
        for member in members:
            path = PurePosixPath(member.name.replace('\\', '/'))
            if path.is_absolute() or not path.parts or any(p == '..' or ':' in p or p.endswith((' ', '.')) for p in path.parts):
                raise ValueError('依赖包含不安全路径')
            if not member.isfile() and not member.isdir():
                raise ValueError('依赖包含链接或特殊文件')
            key = str(path).casefold()
            if key in names:
                raise ValueError('依赖包含重复或大小写冲突的路径')
            names.add(key)
        destination.mkdir(parents=True, exist_ok=False)
        for member in members:
            target = destination.joinpath(*PurePosixPath(member.name.replace('\\', '/')).parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as data, target.open('xb') as output:
                    shutil.copyfileobj(data, output)
                target.chmod(0o644 | (member.mode & 0o111))


def upm_version(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(value)):
        raise ValueError('UPM 依赖需要可验证的固定版本：' + str(value))
    return tuple(int(n) for n in value.split('.'))


def project_source(root):
    candidates = [p.parent.parent for p in root.rglob('ProjectSettings/ProjectVersion.txt')]
    if len(candidates) != 1:
        raise ValueError('官方模板必须且只能包含一个工程')
    return candidates[0]


def package_source(root, item):
    candidates = []
    for path in root.rglob('package.json'):
        value = read(path)
        if value.get('name') == item['id'] and value.get('version') == item['version']:
            candidates.append(path.parent)
    if len(candidates) != 1:
        raise ValueError('依赖包身份或版本与冻结配方不一致：' + item['id'])
    return candidates[0]


# Where the intake records the VPM dependencies a vendor bundle installs instead of a .unitypackage. The
# recipe is the frozen mandatory base; this file is the per-order optional part, and it is read from the
# project rather than passed on the command line so a managed stage cannot install a different set than the
# intake recorded. Registry and project dependencies are pinned the same way: identity, version and digest.
VPM_REQUIREMENTS = Path('_harness') / 'intake' / 'vpm-requirements.json'
VERSION = re.compile(r'^(\d+)\.(\d+)\.(\d+)$')

# A package id is an identity that also becomes a directory name. It is validated as an identity before any
# path is built from it, and every write goes through `package_directory`, which proves the resolved target
# is strictly inside the directory it belongs to. A remote listing is untrusted input: validating the name
# only after the copy would let a traversal write first and be rejected afterwards, which is not a boundary.
PACKAGE_NAME = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]+')


def package_name(value):
    if not isinstance(value, str) or not PACKAGE_NAME.fullmatch(value):
        raise ValueError('包名不安全，不能用于依赖身份与文件路径：' + str(value))
    return value


def package_directory(directory, name):
    """The single directory one validated package name may occupy, strictly inside `directory`."""
    name = package_name(name)
    directory = Path(directory)
    target = directory / name
    root, resolved = directory.resolve(), target.resolve()
    if resolved.parent != root or resolved.name != name:
        raise ValueError('依赖目标越出安装目录，拒绝写入：' + name)
    return target


def vpm_requirements(project):
    """The VPM dependencies the intake recorded for this order, normalized for comparison.

    A missing file means the order declared none — that is the same fact as an empty list, and both are
    represented here as `[]` so `verify` cannot be satisfied by deleting the record. A file that is present
    but unreadable or malformed is an error, not an empty list: silently preparing an environment without a
    dependency the intake found is exactly the failure this contract exists to prevent.
    """
    path = Path(project) / VPM_REQUIREMENTS
    if not path.is_file():
        return []
    document = read(path)
    if not isinstance(document, dict) or document.get('schema') != 'vpm-requirements/0.1' \
            or not isinstance(document.get('requirements'), list):
        raise ValueError('项目 VPM 依赖登记文件格式无效，无法确认本单需要安装什么')
    try:
        approved_plan = json.loads(os.environ.get('AVH_PLAN') or '{}')
    except (TypeError, ValueError) as error:
        raise ValueError('批准方案不是有效 JSON，无法应用一致排除：' + str(error))
    inventory_path = Path(project) / '_harness' / 'intake' / 'inventory.json'
    if inventory_path.is_file():
        try:
            inventory = read(inventory_path)
        except (OSError, ValueError) as error:
            raise ValueError('素材清点无法读取，无法确认哪些 VPM 依赖仍是有效选择：' + str(error))
    else:
        # Older imported projects may have only the VPM registration. Treat each registered row as the
        # raw selected source, then apply the same approved-plan projection before installation.
        inventory = {'items': [{'item': row.get('item'), 'files': [{'selected': True, 'kind': 'vpm'}]}
                               for row in document['requirements'] if isinstance(row, dict)]}
    effective = effective_inventory(inventory, approved_plan)
    allowed = {nfc(str(item.get('item'))) for item in effective.get('items', [])
               if any(isinstance(file, dict) and file.get('selected') and file.get('kind') == 'vpm'
                      for file in item.get('files', []))}
    requests = []
    for row in document['requirements']:
        if not isinstance(row, dict):
            raise ValueError('项目 VPM 依赖登记项不是对象')
        item, repository = row.get('item'), row.get('repository')
        if isinstance(item, str) and nfc(item) not in allowed:
            continue
        if not isinstance(item, str) or not item.strip():
            raise ValueError('项目 VPM 依赖登记项缺少登记商品')
        if not isinstance(repository, str) or not repository.startswith('https://'):
            raise ValueError('项目 VPM 依赖必须固定在 HTTPS 仓库上：' + str(repository))
        requests.append({'item': item, 'role': row.get('role'), 'entry': row.get('entry'),
                         'sourceSha256': row.get('sourceSha256'), 'form': row.get('form'),
                         'member': row.get('member'), 'repository': repository})
    return requests


def repository_listing(url, limit):
    """Read one VPM repository listing over HTTPS, bounded by the recipe's download budget.

    Every failure is a hard error. A repository that cannot be reached leaves the order without a package
    it asked for, and treating that as "no dependency" would ship a project that silently lacks it.
    """
    if not url.startswith('https://'):
        raise ValueError('VPM 仓库索引必须使用 HTTPS：' + url)
    request = urllib.request.Request(url, headers={'User-Agent': 'Avatar-Harness/0.1'})
    opener = urllib.request.build_opener(HttpsRedirect())
    try:
        with opener.open(request, timeout=60) as response:
            body = response.read(limit + 1)
    except (OSError, urllib.error.URLError, http.client.HTTPException) as error:
        raise ValueError('VPM 仓库不可用，不能跳过本单的项目依赖：' + url + '（' + str(error) + '）')
    if len(body) > limit:
        raise ValueError('VPM 仓库索引超出配方预算：' + url)
    try:
        listing = json.loads(body.decode('utf-8-sig'))
    except ValueError:
        raise ValueError('VPM 仓库索引不是 JSON，无法固定依赖：' + url)
    if not isinstance(listing, dict) or not isinstance(listing.get('packages'), dict):
        raise ValueError('VPM 仓库索引没有 packages 列表：' + url)
    return listing


def release_order(value):
    """A comparable release tuple, or None for anything that is not x.y.z (prereleases included)."""
    match = VERSION.match(str(value))
    return tuple(int(part) for part in match.groups()) if match else None


# VPM dependencies declare npm-style ranges (`>=1.2.0`, `^1.14.0`, `3.2 - 3.10`, `>=3.10.4 <3.11.X`). A range
# this parser cannot read is a hard error, never a pass: "the requirement could not be read" and "the
# requirement is satisfied" must not be the same outcome, or an unreadable ceiling silently disappears.
SEMVER = re.compile(r'^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$')
PARTIAL = re.compile(r'^[vV]?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$')


def release_key(value):
    """A comparable version key, or None when the text is not an x.y.z version (prereleases included)."""
    match = SEMVER.match(str(value).strip())
    if not match:
        return None
    major, minor, patch, prerelease = match.groups()
    if prerelease is None:
        return (int(major), int(minor), int(patch), (1,))
    identifiers = tuple((0, int(part), '') if part.isdigit() else (1, 0, part)
                        for part in prerelease.split('.'))
    return (int(major), int(minor), int(patch), (0, identifiers))


def partial_parts(text, token):
    match = PARTIAL.fullmatch(text)
    if not match:
        raise ValueError('依赖版本范围不可解析：' + token)
    numbers, wildcard = [], False
    for group in match.groups()[:3]:
        if wildcard or group is None or group in ('x', 'X', '*'):
            wildcard = True
            numbers.append(None)
        else:
            numbers.append(int(group))
    return numbers[0], numbers[1], numbers[2], match.group(4)


def range_token(token):
    """The comparators one whitespace-separated range token stands for."""
    token = token.strip()
    if not token or token in ('*', 'x', 'X'):
        return []
    match = re.fullmatch(r'(>=|<=|>|<|=|\^|~)?(.+)', token)
    operator, rest = match.group(1) or '=', match.group(2).strip()
    if rest in ('*', 'x', 'X'):
        return []
    major, minor, patch, prerelease = partial_parts(rest, token)
    tail = ('-' + prerelease) if prerelease else ''

    def at(major, minor, patch):
        return f'{major}.{minor}.{patch}' + tail

    if operator == '^':
        lower = at(major, minor or 0, patch or 0)
        if major > 0 or minor is None:
            upper = f'{major + 1}.0.0'
        elif minor > 0 or patch is None:
            upper = f'0.{minor + 1}.0'
        else:
            upper = f'0.0.{patch + 1}'
        return [('>=', lower), ('<', upper)]
    if operator == '~':
        upper = f'{major + 1}.0.0' if minor is None else f'{major}.{minor + 1}.0'
        return [('>=', at(major, minor or 0, patch or 0)), ('<', upper)]
    if operator == '>=':
        return [('>=', at(major, minor or 0, patch or 0))]
    if operator == '>':
        if minor is None:
            return [('>=', f'{major + 1}.0.0')]
        if patch is None:
            return [('>=', f'{major}.{minor + 1}.0')]
        return [('>', at(major, minor, patch))]
    if operator == '<':
        return [('<', at(major, minor or 0, patch or 0))]
    if operator == '<=':
        if minor is None:
            return [('<', f'{major + 1}.0.0')]
        if patch is None:
            return [('<', f'{major}.{minor + 1}.0')]
        return [('<=', at(major, minor, patch))]
    if minor is None:
        return [('>=', f'{major}.0.0'), ('<', f'{major + 1}.0.0')]
    if patch is None:
        return [('>=', f'{major}.{minor}.0'), ('<', f'{major}.{minor + 1}.0')]
    return [('=', at(major, minor, patch))]


def hyphen_comparators(low, high, token):
    major, minor, patch, prerelease = partial_parts(low, token)
    lower = f'{major}.{minor or 0}.{patch or 0}' + (('-' + prerelease) if prerelease else '')
    major, minor, patch, prerelease = partial_parts(high, token)
    if minor is None:
        upper = [('<', f'{major + 1}.0.0')]
    elif patch is None:
        upper = [('<', f'{major}.{minor + 1}.0')]
    else:
        upper = [('<=', f'{major}.{minor}.{patch}' + (('-' + prerelease) if prerelease else ''))]
    return [('>=', lower)] + upper


def range_alternative(text):
    """The comparators one `||` alternative stands for; an empty list admits every version."""
    text = re.sub(r'(>=|<=|>|<|=|\^|~)\s+', r'\1', text.strip())
    if text in ('*', 'x', 'X'):
        return []
    hyphen = re.fullmatch(r'(\S+)\s+-\s+(\S+)', text)
    if hyphen:
        return hyphen_comparators(hyphen.group(1), hyphen.group(2), text)
    comparators = []
    for token in text.split():
        comparators.extend(range_token(token))
    if not comparators:
        raise ValueError('依赖版本范围不可解析：' + text)
    return comparators


def holds(installed, operator, target):
    wanted = release_key(target)
    if wanted is None:
        raise ValueError('依赖版本范围中的版本号不可解析：' + str(target))
    if operator == '>=':
        return installed >= wanted
    if operator == '>':
        return installed > wanted
    if operator == '<=':
        return installed <= wanted
    if operator == '<':
        return installed < wanted
    if operator == '=':
        return installed == wanted
    raise ValueError('依赖版本范围运算符不可解析：' + str(operator))


def satisfies_range(version, requirement):
    """Whether an installed version satisfies an npm-style VPM range. Unreadable input is an error."""
    installed = release_key(version)
    if installed is None:
        raise ValueError('实装版本号不可解析：' + str(version))
    text = str(requirement).strip()
    if not text:
        raise ValueError('依赖版本范围为空：' + str(requirement))
    alternatives = text.split('||')
    if any(not alternative.strip() for alternative in alternatives):
        raise ValueError('依赖版本范围不可解析：' + text)
    # Every alternative is parsed before any of them decides. Satisfying the first branch says nothing about
    # whether the rest of the range is readable, and returning there would accept text the vendor never
    # wrote: `>=1.0.0 || later` was read as `>=1.0.0`, so an unreadable ceiling silently disappeared.
    branches = [range_alternative(alternative) for alternative in alternatives]
    # range_alternative keeps targets as strings. Validate every comparator before any() can skip a
    # malformed alternative after a satisfied one (for example `>=1.0.0 || <x.1`).
    operators = {'>=', '>', '<=', '<', '='}
    for comparators in branches:
        for operator, target in comparators:
            if operator not in operators:
                raise ValueError('依赖版本范围运算符不可解析：' + str(operator))
            if release_key(target) is None:
                raise ValueError('依赖版本范围中的版本号不可解析：' + str(target))
    return any(all(holds(installed, operator, target) for operator, target in comparators)
               for comparators in branches)


def resolve_vpm_requirement(request, listing):
    """The pins one recorded requirement resolves to: identity, version, URL, digest and dependencies.

    The version is fixed here rather than in the request because the vendor's entry names only a repository.
    A repository that publishes several packages cannot be resolved without guessing which one the order
    meant, so it is refused; the acceptance criterion is the same as the intake's — never guess a source.
    Nothing is accepted without a declared zipSHA256: a package whose bytes the repository does not pin
    cannot be called a fixed dependency.
    """
    published = listing['packages']
    names = sorted(published)
    if len(names) != 1:
        raise ValueError('VPM 仓库包含多个包而安装入口没有点名包身份，不能猜测要装哪一个：' + request['repository'])
    chosen = []
    for name in names:
        # The listing is remote input and this name becomes an install directory, so it is validated as an
        # identity before anything else looks at it. Doing it here means no rejection can happen after a
        # write has already followed the hostile name out of its directory.
        name = package_name(name)
        entry = published[name]
        if not isinstance(entry, dict) or not isinstance(entry.get('versions'), dict):
            raise ValueError('VPM 仓库没有登记包：' + name)
        versions = entry['versions']
        releases = [version for version in versions if release_order(version)]
        if not releases:
            raise ValueError('VPM 包没有可固定的正式版本（只有预发布）：' + name)
        version = max(releases, key=release_order)
        metadata = versions[version]
        if not isinstance(metadata, dict) or metadata.get('name') != name or metadata.get('version') != version:
            raise ValueError('VPM 仓库条目的身份或版本与其索引不一致：' + name + ' ' + version)
        url, sha256 = metadata.get('url'), metadata.get('zipSHA256')
        if not isinstance(url, str) or not url.startswith('https://') or not re.fullmatch(r'[0-9a-f]{64}', str(sha256 or '')):
            raise ValueError('VPM 条目缺少 HTTPS 地址或 zipSHA256，无法固定来源与哈希：' + name + ' ' + version)
        dependencies = metadata.get('vpmDependencies') or {}
        if not isinstance(dependencies, dict) or any(not isinstance(k, str) or not isinstance(v, str)
                                                    for k, v in dependencies.items()):
            raise ValueError('VPM 条目的依赖关系无效：' + name + ' ' + version)
        for dependency in dependencies:
            package_name(dependency)
        chosen.append({'id': name, 'version': version, 'url': url, 'sha256': sha256,
                       'dependencies': dependencies, 'repository': request['repository'], 'item': request['item']})
    return chosen


def pinned_content(packages, pin, cache, candidate, recipe):
    """Re-read the archive a pin names and prove the reused directory is exactly that content.

    Reuse is only sound when the bytes are re-read: the version alone does not prove the archive, and a lock
    that records a digest nobody downloaded is a pin that was never honored. Re-reading also exposes the
    same-version-different-hash conflict, including when another input already supplied the identity. The
    index's dependency declaration is reconciled with the archive's here, so the two sources of truth about
    the same package can never disagree silently.
    """
    archive = download({'url': pin['url'], 'sha256': pin['sha256']}, cache, recipe['maxDownloadBytes'])
    expanded = candidate / ('reuse-' + uuid.uuid4().hex)
    extract(archive, expanded, recipe['maxExpandedBytes'])
    actual = package_source(expanded, pin)
    metadata = read(actual / 'package.json')
    if (metadata.get('vpmDependencies') or {}) != (pin['dependencies'] or {}):
        raise ValueError('VPM 索引与归档中的依赖声明不一致：' + pin['id'] + ' ' + pin['version'])
    target = package_directory(packages, pin['id'])
    if not target.is_dir() or tree(actual) != tree(target):
        raise ValueError('复用依赖的实际内容与 pin 的归档不一致，不能登记未兑现的 pin：' + pin['id'])


def install_vpm_requirements(packages, candidate, cache, recipe, requests):
    """Install the recorded project VPM dependencies into the baseline and return their pins.

    The packages land in `Packages/` with their original identity and are listed in `vpm-manifest.json`
    exactly as recipe packages are, so the existing independent checks — transitive dependency closure and
    byte comparison against the working project — cover them without a second mechanism.
    """
    if not requests:
        return []
    manifest = read(packages / 'vpm-manifest.json')
    declared = manifest.setdefault('dependencies', {})
    locked = manifest.setdefault('locked', {})
    installed = []
    mappings = set()
    for request in requests:
        listing = repository_listing(request['repository'], recipe['maxDownloadBytes'])
        for pin in resolve_vpm_requirement(request, listing):
            name = package_name(pin['id'])
            # One bundle can name the same entry twice — two files carrying the same installer link, or the
            # link and the repository URL — so the same (item, id) arrives twice for the same repository.
            # It installs once and is recorded once: appending the pin again would list a duplicate the
            # accepted-lock reconcile refuses after publication, with no way to retry.
            mapping = (pin['item'], name, pin['repository'])
            if mapping in mappings:
                continue
            mappings.add(mapping)
            # One package can be reached from two registered inputs: a repository shared by two bundles, or
            # a dependency both name. It installs once, and the second request only adds its own item
            # mapping; a different version for the same id is a real conflict and is refused.
            if name in declared:
                if declared[name].get('version') != pin['version']:
                    raise ValueError('项目依赖与已定版本冲突，不能静默替换：' + name)
                # Reuse has to honor the new pin rather than skip it: the digest the accepted content was
                # installed from must match, and the archive itself is re-read. Two inputs naming the same
                # version with different bytes is a hard failure, not a lock entry for a download nobody did.
                recorded = locked.get(name) or {}
                if recorded.get('sha256') not in (None, pin['sha256']):
                    raise ValueError('同一身份与版本的依赖出现不同归档哈希，不能复用：' + name)
                if recorded.get('version') not in (None, pin['version']):
                    raise ValueError('项目依赖在依赖锁里的版本与本次解析不一致，不能复用：' + name)
                pinned_content(packages, pin, cache, candidate, recipe)
                # Reuse is only complete once the source the verified bytes came from is recorded. An entry
                # left without a digest is a pin nobody can honor later: the lock would claim a package whose
                # archive was never fixed, and every verify() after publication would refuse the environment
                # that was just built.
                locked[name] = {'version': pin['version'], 'sha256': pin['sha256'],
                                'dependencies': pin['dependencies'] or {}}
                installed.append(pin)
                continue
            print('准备项目依赖 ' + name + ' ' + pin['version'], flush=True)
            archive = download({'url': pin['url'], 'sha256': pin['sha256']}, cache, recipe['maxDownloadBytes'])
            expanded = candidate / ('vpm-' + name)
            extract(archive, expanded, recipe['maxExpandedBytes'])
            actual = package_source(expanded, pin)
            metadata = read(actual / 'package.json')
            declared_dependencies = metadata.get('vpmDependencies') or {}
            if declared_dependencies != (pin['dependencies'] or {}):
                raise ValueError('VPM 索引与归档中的依赖声明不一致：' + name + ' ' + pin['version'])
            target = package_directory(packages, name)
            if target.exists():
                raise ValueError('项目依赖与已准备内容冲突：' + name)
            shutil.copytree(actual, target)
            declared[name] = {'version': pin['version']}
            locked[name] = {'version': pin['version'], 'sha256': pin['sha256'],
                            'dependencies': declared_dependencies}
            installed.append(pin)
    write(packages / 'vpm-manifest.json', manifest)
    return installed


def inspect_baseline(baseline, recipe, managed):
    no_links(baseline)
    version = (baseline / 'ProjectSettings' / 'ProjectVersion.txt').read_text(encoding='utf-8')
    if not re.search(r'^m_EditorVersion: ' + re.escape(recipe['unity']) + r'\s*$', version, re.M):
        raise ValueError('工程编辑器版本与兼容配方不一致')
    manifest = read(baseline / 'Packages' / 'manifest.json')
    if any(str(v).startswith(('file:', 'git', 'http:', 'https:', 'ssh:')) for v in manifest.get('dependencies', {}).values()):
        raise ValueError('模板含未冻结的外部依赖；需要独立的环境迁移')
    locked = read(baseline / 'Packages' / 'vpm-manifest.json')['locked']
    if managed:
        for item in recipe['packages']:
            if locked.get(item['id'], {}).get('version') != item['version']:
                raise ValueError('锁定版本与配方不一致：' + item['id'])
    for name, package in locked.items():
        # The lock is data on disk too: a name read from it is validated before it becomes a path, and the
        # resolved target has to stay inside Packages/.
        actual = read(package_directory(baseline / 'Packages', name) / 'package.json')
        if actual.get('name') != name or actual.get('version') != package['version']:
            raise ValueError('包锁与实际依赖不一致：' + name)
        # The declared range is what the vendor's ceiling actually says. Checking only that the id exists
        # accepts a version the package forbids, so an unreadable or unsatisfied range is a hard failure.
        for dependency, requirement in (actual.get('vpmDependencies') or {}).items():
            if dependency not in locked:
                raise ValueError('包锁缺少传递依赖：' + name)
            installed = locked[dependency].get('version')
            if not satisfies_range(installed, requirement):
                raise ValueError('包锁的传递依赖版本范围不满足：' + name + ' 要求 ' + dependency + ' '
                                 + str(requirement) + '，实装 ' + str(installed))
    embedded = {}
    for path in (baseline / 'Packages').glob('*/package.json'):
        metadata = read(path)
        if metadata.get('name') != path.parent.name:
            raise ValueError('嵌入包目录与身份不一致')
        embedded[path.parent.name] = metadata
    for item in recipe.get('registryPackages', []) if managed else []:
        if embedded.get(item['id'], {}).get('version') != item['version']:
            raise ValueError('UPM 嵌入包未按配方冻结：' + item['id'])
    versions = {name: metadata['version'] for name, metadata in embedded.items()}
    available = {**recipe.get('builtinPackages', {}), **versions}
    requirements = [manifest.get('dependencies', {}), *(m.get('dependencies', {}) for m in embedded.values())]
    for dependencies in requirements:
        for name, version in dependencies.items():
            if name not in available:
                raise ValueError('环境缺少冻结的 UPM 传递依赖：' + name)
            if upm_version(available[name]) < upm_version(version):
                raise ValueError('冻结的 UPM 版本不满足最低要求：' + name)
    return versions


def verify_vpm_requirements(project, baseline, recipe, lock):
    """Independently reconcile the accepted pins with the packages actually present in the baseline.

    The lock's `vpmRequirements` is a claim, and the file it lives in is written by the same code that made
    the claim. It is accepted only when the dependency lock, each installed package.json and the archive
    digest recorded for it agree with it. A missing entry, a wrong mapping or a hash no install produced is
    a failure, not a warning, and the project's own registration is re-read rather than trusted from here.
    """
    recorded = lock.get('vpmRequirements') or {'requests': [], 'packages': []}
    if not isinstance(recorded, dict):
        raise ValueError('环境锁的项目 VPM 依赖记录格式无效')
    requests = vpm_requirements(project)
    if recorded.get('requests') != requests:
        raise ValueError('项目 VPM 依赖与已接受环境不一致；需要重新准备环境并显式迁移')
    accepted = recorded.get('packages') or []
    if not isinstance(accepted, list):
        raise ValueError('环境锁的项目 VPM 依赖记录格式无效')
    # The request's own source keys — the registered item and the repository the intake approved — are what
    # ties an accepted pin back to something the order asked for. Comparing the pin list alone would accept a
    # pin installed from a repository this order never approved, and a custom template whose lock records the
    # requests but no pins at all, so both directions are closed here.
    wanted = {(request['item'], request['repository']) for request in requests}
    answered = set()
    manifest = read(baseline / 'Packages' / 'vpm-manifest.json')
    locked, declared = manifest.get('locked'), manifest.get('dependencies')
    if not isinstance(locked, dict) or not isinstance(declared, dict):
        raise ValueError('环境缺少依赖锁或依赖声明')
    seen = set()
    for pin in accepted:
        if not isinstance(pin, dict):
            raise ValueError('环境锁的项目 VPM 依赖条目格式无效')
        item = pin.get('item')
        if not isinstance(item, str) or not item.strip():
            raise ValueError('环境锁的项目 VPM 依赖条目缺少登记商品')
        name = package_name(pin.get('id'))
        # One package can serve two registered items; the mapping is what the lock records, so the same id
        # may appear once per item but never twice for the same item.
        if (item, name) in seen:
            raise ValueError('环境锁的项目 VPM 依赖重复登记：' + name)
        seen.add((item, name))
        if not re.fullmatch(r'[0-9a-f]{64}', str(pin.get('sha256') or '')) \
                or not str(pin.get('url') or '').startswith('https://'):
            raise ValueError('已接受的项目 VPM 依赖缺少来源证据：' + name)
        repository = pin.get('repository')
        if not isinstance(repository, str) or not repository.startswith('https://'):
            raise ValueError('已接受的项目 VPM 依赖的来源不是已批准的 HTTPS 仓库：' + name)
        if (item, repository) not in wanted:
            raise ValueError('已接受的项目 VPM 依赖的来源不在本单登记中：' + name + ' ' + repository)
        answered.add((item, repository))
        entry = locked.get(name)
        if not isinstance(entry, dict) or entry.get('version') != pin.get('version'):
            raise ValueError('已接受的项目 VPM 依赖没有兑现到依赖锁：' + name)
        if (declared.get(name) or {}).get('version') != pin.get('version'):
            raise ValueError('已接受的项目 VPM 依赖没有兑现到依赖声明：' + name)
        if entry.get('sha256') != pin['sha256']:
            raise ValueError('已接受的项目 VPM 依赖的归档哈希与实际安装来源不一致：' + name)
        actual = read(package_directory(baseline / 'Packages', name) / 'package.json')
        if actual.get('name') != name or actual.get('version') != pin.get('version'):
            raise ValueError('已接受的项目 VPM 依赖与实际包身份不一致：' + name)
        if (actual.get('vpmDependencies') or {}) != (pin.get('dependencies') or {}):
            raise ValueError('已接受的项目 VPM 依赖的依赖声明与实际包不一致：' + name)
    missing = sorted(key for key in wanted if key not in answered)
    if missing:
        raise ValueError('已接受的项目 VPM 依赖缺少请求对应的 pin：'
                         + '，'.join(item + ' ' + repository for item, repository in missing))
    if lock.get('source') == 'managed':
        expected = {item['id'] for item in recipe['packages']} | {name for _, name in seen}
        if set(locked) != expected:
            raise ValueError('已接受环境的依赖锁与配方加项目依赖不一致：'
                             + str(sorted(set(locked) ^ expected)))


def validate_environment(baseline, project, recipe, lock):
    """Every check the accepted lock's own claims have to survive, against a baseline directory.

    It takes the directory rather than the environment root so the same checks run on a candidate before it is
    published and on the published baseline afterwards. That ordering is the point: a rejection here leaves
    no baseline and no lock to reconcile, so the input can be fixed and prepared again, while the identical
    rejection after the rename would leave an environment nothing can accept and no way to retry.
    """
    if read(baseline / '.environment-receipt.json') != lock:
        raise ValueError('环境发布回执与环境锁不一致')
    files = tree(baseline)
    if not files or files != lock.get('files'):
        raise ValueError('环境内容已漂移；保留现有版本并请求环境修复')
    packages = inspect_baseline(baseline, recipe, lock.get('source') == 'managed')
    if packages != lock.get('packages'):
        raise ValueError('环境依赖与已接受环境锁不一致')
    # Project optional dependencies are part of the accepted environment. A lock that predates them counts
    # only while the order declares none: otherwise the environment must be prepared again rather than
    # silently keeping a baseline that lacks a dependency the intake recorded.
    verify_vpm_requirements(project, baseline, recipe, lock)
    return lock


def verify(root, recipe, recipe_hash):
    lock = read(root / 'environment-lock.json')
    if lock.get('schema') != 'environment-lock/0.1' or lock.get('recipeHash') != recipe_hash:
        raise ValueError('环境锁不是当前配方；不能静默迁移')
    return validate_environment(root / 'baseline', root.parent.parent, recipe, lock)


def apply_first_compile_remedies(target, recipe):
    """Break the three failure modes that make a fresh project's first compile fail.

    The setup knowledge records these as things a person fixes by hand, and each is deterministic: the
    SDK define is written by the SDK only after a first successful compile, and lilToon ships its editor
    assemblies unreferenced. Applying them here is what makes the prepared baseline usable at all, since
    setup-project copies ProjectSettings and Packages out of the baseline and would otherwise discard a
    repair made later on every run.
    """
    settings = target / 'ProjectSettings' / 'ProjectSettings.asset'
    if settings.exists():
        text = settings.read_text(encoding='utf-8')
        # The official template ships the key empty, as `scriptingDefineSymbols: {}`. Handle that shape as
        # well: an earlier version of this function only looked for platform entries beneath the key, so it
        # found nothing to patch and silently left the define absent, which is the failure it exists to fix.
        empty = re.search(r'^(?P<indent>[ \t]*)scriptingDefineSymbols:[ \t]*\{\}[ \t]*$', text, re.M)
        if empty:
            indent = empty.group('indent') + '  '
            # Desktop and Android are the two a PC avatar project is opened and built for. Writing these
            # empty is safe: Unity treats an absent platform as no defines, and the SDK adds its own later.
            entries = ''.join(indent + name + ': VRC_SDK_VRCSDK3\n'
                              for name in ('Standalone', 'Android', 'iPhone'))
            text = text[:empty.start()] + indent + 'scriptingDefineSymbols:\n' + entries + text[empty.end():]
            settings.write_text(text, encoding='utf-8')
            print('环境准备：scriptingDefineSymbols 原为空对象，已写入 VRC_SDK_VRCSDK3', flush=True)
        else:
            lines = text.splitlines(keepends=True)
            try:
                start = next(i for i, line in enumerate(lines) if line.strip() == 'scriptingDefineSymbols:')
            except StopIteration:
                start = -1
            if start >= 0:
                # The block is the run of platform entries right after the key. Stop at the first line that
                # is not one of them, so a following setting is never rewritten: an earlier version of this
                # loop kept going past the block and prefixed unrelated fields such as otherSetting.
                indent = len(lines[start + 1]) - len(lines[start + 1].lstrip()) if start + 1 < len(lines) else 4
                end = start + 1
                while end < len(lines):
                    line = lines[end]
                    if not line.strip() or len(line) - len(line.lstrip()) != indent or ':' not in line:
                        break
                    end += 1
                changed = False
                for index in range(start + 1, end):
                    name, _, value = lines[index].strip().partition(':')
                    value = value.strip()
                    if 'VRC_SDK_VRCSDK3' not in value.split(';'):
                        lines[index] = ' ' * indent + name + ': VRC_SDK_VRCSDK3;' + value + '\n'
                        changed = True
                if changed:
                    settings.write_text(''.join(lines), encoding='utf-8')
                    print('环境准备：已在 scriptingDefineSymbols 写入 VRC_SDK_VRCSDK3', flush=True)
    # lilToon 2.x marks its editor assembly autoReferenced false, so Assembly-CSharp-Editor cannot see
    # lilToonInspector and a third-party inspector fails with CS0246. Flip only the vendor assemblies that
    # exist to be referenced: other unreferenced editor assemblies are unreferenced on purpose, and
    # asserting on every one of them would be both wrong and unprovable.
    for assembly in sorted(target.glob('Packages/*/Editor/*.asmdef')):
        metadata = read(assembly)
        if metadata.get('autoReferenced') is False:
            metadata['autoReferenced'] = True
            write(assembly, metadata)
            print('环境准备：已把 ' + assembly.parent.parent.name + '/' + assembly.name
                  + ' 的 autoReferenced 置为 true', flush=True)


def prepare(project, recipe_path, source='-'):
    recipe, recipe_hash = recipe_file(recipe_path), digest(recipe_path)
    root = checked_root(project)
    if (root / 'environment-lock.json').exists():
        lock = verify(root, recipe, recipe_hash)
        if lock['source'] != ('managed' if source == '-' else 'custom'):
            raise ValueError('环境来源改变，需要显式迁移')
        return lock
    # Publish in two steps. A crash after the rename is reconciled against the receipt
    # already inside the candidate, not by running a second installation over it.
    baseline = root / 'baseline'
    if baseline.exists():
        receipt = read(baseline / '.environment-receipt.json')
        write(root / 'environment-lock.json', receipt)
        return verify(root, recipe, recipe_hash)
    candidate = root / 'candidates' / uuid.uuid4().hex
    candidate.mkdir(parents=True)
    target = candidate / 'baseline'
    cache = root / 'cache'
    if source != '-':
        original = Path(source).resolve(strict=True)
        if original == Path(project).resolve() or original.is_relative_to(root) or root.is_relative_to(original):
            raise ValueError('高级模板不能是目标工程或其父子目录')
        no_links(original)
        target.mkdir()
        for folder in ('ProjectSettings', 'Packages'):
            shutil.copytree(original / folder, target / folder)
    else:
        archive = download(recipe['template'], cache, recipe['maxDownloadBytes'])
        extract(archive, candidate / 'template', recipe['maxExpandedBytes'])
        template = project_source(candidate / 'template')
        target.mkdir()
        shutil.copytree(template / 'ProjectSettings', target / 'ProjectSettings')
        packages = target / 'Packages'
        packages.mkdir()
        manifest = read(template / 'Packages' / 'manifest.json')
        manifest['dependencies'].update(recipe.get('unityDependencies', {}))
        locked = {}
        for i, item in enumerate(recipe['packages']):
            print('准备依赖 ' + item['id'] + ' ' + item['version'], flush=True)
            archive = download(item, cache, recipe['maxDownloadBytes'])
            expanded = candidate / ('package-' + str(i))
            extract(archive, expanded, recipe['maxExpandedBytes'])
            actual = package_source(expanded, item)
            metadata = read(actual / 'package.json')
            shutil.copytree(actual, packages / item['id'])
            locked[item['id']] = {'version': item['version'], 'sha256': item['sha256'],
                                  'dependencies': metadata.get('vpmDependencies', {})}
        for i, item in enumerate(recipe.get('registryPackages', [])):
            print('准备编辑器依赖 ' + item['id'] + ' ' + item['version'], flush=True)
            archive = download(item, cache, recipe['maxDownloadBytes'])
            expanded = candidate / ('registry-' + str(i))
            extract(archive, expanded, recipe['maxExpandedBytes'], item.get('format', 'tgz'))
            actual = package_source(expanded, item)
            shutil.copytree(actual, packages / item['id'])
            manifest['dependencies'][item['id']] = item['version']
        write(packages / 'manifest.json', manifest)
        write(packages / 'vpm-manifest.json', {'dependencies': {p['id']: {'version': p['version']} for p in recipe['packages']}, 'locked': locked})
    # The per-order optional part of the environment. It is read from the project's intake record, so the
    # environment installs exactly the VPM dependencies the intake found and nothing else; both the managed
    # and the custom-template path get it, because a dependency a vendor bundle declares is a property of
    # the order rather than of whichever template was used.
    requirements = vpm_requirements(project)
    installed = install_vpm_requirements(target / 'Packages', candidate, cache, recipe, requirements)
    apply_first_compile_remedies(target, recipe)
    versions = inspect_baseline(target, recipe, source == '-')
    lock = {'schema': 'environment-lock/0.1', 'recipe': recipe['id'], 'recipeHash': recipe_hash,
            'source': 'managed' if source == '-' else 'custom', 'unity': recipe['unity'],
            'platform': recipe['platform'], 'packages': versions, 'files': tree(target),
            'vpmRequirements': {'requests': requirements, 'packages': installed}}
    # The receipt is excluded from its own digest, and verified explicitly by verify(). Every closure check
    # runs against the candidate first: publishing a baseline and a lock that verify() then refuses would
    # leave an environment no one can accept and no way to retry, which is exactly what a missing reused
    # digest or a duplicated item mapping produced.
    write(target / '.environment-receipt.json', lock)
    validate_environment(target, root.parent.parent, recipe, lock)
    target.rename(baseline)
    write(root / 'environment-lock.json', lock)
    verify(root, recipe, recipe_hash)
    return lock


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['prepare', 'verify'])
    parser.add_argument('--project', default=os.environ.get('AVH_PROJECT_DIR'))
    parser.add_argument('--recipe', required=True)
    parser.add_argument('--source', default='-')
    parser.add_argument('--out')
    args = parser.parse_args()
    if args.action == 'prepare':
        prepare(args.project, args.recipe, args.source)
    else:
        try:
            recipe = recipe_file(args.recipe)
            verify(Path(args.project) / '_harness' / 'environment', recipe, digest(args.recipe))
            result = {'schema': 'observation/0.1', 'metrics': {'environment_consistent': True}}
        except (OSError, ValueError, KeyError) as error:
            result = {'schema': 'observation/0.1', 'metrics': {'environment_consistent': False}, 'notes': [str(error)]}
        write(args.out, result)


if __name__ == '__main__':
    main()
