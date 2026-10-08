#!/usr/bin/env python3
# 【项目沉淀】通用工具（Harness 观测：delivery.package）
# 适用素体：无关
# 工具链　：python3 标准库；7z（只读 7z t）
# 可复用性：★★★ 换个单子直接能用
# 用途　　：只读地拆开 _harness/delivery/ 里的总包量 SOP 90 的判据：交付文件夹无散件、总包 7z t 通过、总包大小≈成员之和、
#           工程 zip 顶层 5 项、工程根层没有 Library 等目录而插件内部**源工程已有的**同名目录一个不缺、没有 Harness 编辑器工具、
#           manifest 不含开发依赖、交付说明 UTF-8 无 BOM 且 LF、_追加素材 每项都在来源说明里。写 observation/0.1 到 --out。
# 用法　　：observe_package.py --out <文件>   （工程取 AVH_PROJECT_DIR）
"""Independent measurements of the delivery package."""
import argparse
import json
import os
import subprocess
import zipfile
from pathlib import Path

ADDED = '_追加素材（非客户自备）'
ROOT_EXCLUDED = {'Library', 'Temp', 'Logs', 'obj', 'Captures', 'UserSettings', '.git', '.vs'}
GENERATORS = ('Assets/_HarnessTools/', 'Assets/Editor/AvatarGen/', 'Assets/_HarnessColdProbe/')


def unreproducible(value):
    value = str(value)
    return value.startswith(('file:', 'git', 'http:', 'https:', 'ssh:')) or '.git' in value


def top_levels(names):
    return {name.split('/', 1)[0] for name in names if name.strip('/')}


def plugin_internal_dirs(project):
    """
    Directories named Library that a plugin ships inside Packages/ of the source project, as project-relative
    paths. The project's own root Library/ is its cache and is excluded at the top level, so only what is
    nested under Packages/ counts. An empty directory carries no data a zip could lose, so it is not required.
    """
    packages = project / 'Packages'
    found = set()
    if not packages.is_dir():
        return found
    for dirpath, dirs, _ in os.walk(packages):
        for name in dirs:
            if name != 'Library':
                continue
            path = Path(dirpath) / name
            if any(entry.is_file() for entry in path.rglob('*')):
                found.add(path.relative_to(project).as_posix())
    return found


def missing_plugin_dirs(source_dirs, inner_names):
    """Source plugin directories with no member of the project zip at the same relative path. A same-named
    directory somewhere else in the zip is not the one the source had, so it cannot stand in for it."""
    return sorted(rel for rel in source_dirs if not any(name.startswith(rel + '/') for name in inner_names))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    project = Path(os.environ['AVH_PROJECT_DIR'])
    delivery = project / '_harness' / 'delivery'
    notes, metrics = [], {}
    files = sorted(p for p in delivery.iterdir()) if delivery.is_dir() else []
    totals = [p for p in files if p.name.endswith('_交付.zip')]
    metrics['loose_files_in_delivery_dir'] = len(files) - len(totals) if totals else None
    if len(totals) != 1:
        notes.append(f'交付文件夹里总包个数 {len(totals)}（应为 1）：{[p.name for p in files]}')
        Path(args.out).write_text(json.dumps({'schema': 'observation/0.1', 'metrics': metrics, 'notes': notes}, ensure_ascii=False), encoding='utf-8')
        return
    total = totals[0]
    test = subprocess.run(['7z', 't', str(total)], capture_output=True, text=True)
    metrics['seven_zip_test_exit_code'] = test.returncode
    if test.returncode != 0:
        notes.append('7z t：' + (test.stdout + test.stderr)[-300:])
    with zipfile.ZipFile(total) as z:
        infos = z.infolist()
        metrics['total_size_bytes'] = total.stat().st_size
        metrics['sum_member_bytes'] = sum(i.compress_size for i in infos)
        names = [i.filename for i in infos]
        project_zip = next((n for n in names if n.endswith('_工程.zip')), None)
        note = next((n for n in names if n == '交付说明.txt'), None)
        metrics['delivery_diagnosis_present'] = '客户端验收与诊断.md' in names and bool(z.read('客户端验收与诊断.md').strip())
        if not metrics['delivery_diagnosis_present']:
            notes.append('总包里没有非空的 客户端验收与诊断.md')
        if note:
            raw = z.read(note)
            try:
                raw.decode('utf-8')
                metrics['delivery_note_encoding_ok'] = not raw.startswith(b'\xef\xbb\xbf') and b'\r' not in raw
            except UnicodeDecodeError:
                metrics['delivery_note_encoding_ok'] = False
        else:
            metrics['delivery_note_encoding_ok'] = False
            notes.append('总包里没有 交付说明.txt')
        added = {n.split('/')[1] for n in names if n.startswith(ADDED + '/') and n.count('/') >= 1 and n.split('/')[1]}
        documented = z.read(f'{ADDED}/来源说明.txt').decode('utf-8').splitlines() if f'{ADDED}/来源说明.txt' in names else []
        listed = {line.split('｜', 1)[0] for line in documented if line.strip()}
        undocumented = sorted(added - listed - {'来源说明.txt'})
        metrics['undocumented_added_assets'] = len(undocumented)
        if undocumented:
            notes.append(f'来源说明里没有的追加素材：{undocumented[:5]}')
        if project_zip is None:
            notes.append('总包里没有工程 zip')
        else:
            with z.open(project_zip) as stream, zipfile.ZipFile(stream) as inner:  # 总包是 store，成员可随机读，不整个读进内存
                inner_names = inner.namelist()
                tops = top_levels(inner_names)
                metrics['zip_top_level_entries'] = len(tops)
                metrics['root_excluded_dirs_in_zip'] = len(tops & ROOT_EXCLUDED)
                source_dirs = plugin_internal_dirs(project)
                missing_dirs = missing_plugin_dirs(source_dirs, inner_names)
                metrics['plugin_internal_dirs_in_source'] = len(source_dirs)
                metrics['missing_plugin_internal_dirs_in_zip'] = len(missing_dirs)
                if missing_dirs:
                    notes.append(f'工程 zip 里缺源工程已有的插件内部目录：{missing_dirs[:5]}')
                metrics['generator_dir_present'] = any(n.startswith(GENERATORS) for n in inner_names)
                manifest = json.loads(inner.read('Packages/manifest.json')) if 'Packages/manifest.json' in inner_names else None
                dev = [k for k, v in (manifest or {}).get('dependencies', {}).items() if unreproducible(v)]
                metrics['dev_dependencies_in_manifest'] = len(dev) if manifest is not None else None
                if dev:
                    notes.append(f'开发依赖：{dev}')
                notes.append(f'工程 zip 顶层：{sorted(tops)}；条目 {len(inner_names)}')
    Path(args.out).write_text(json.dumps({'schema': 'observation/0.1', 'metrics': metrics, 'notes': notes},
                                         ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
