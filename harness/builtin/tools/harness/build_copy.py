#!/usr/bin/env python3
# 【项目沉淀】通用工具（Harness build_pre / build 阶段的工具部分）
# 适用素体：无关
# 工具链　：python3 标准库
# 可复用性：★★★ 换个单子直接能用
# 用途　　：把工程镜像成 _harness_build/<槽位>/project 隔离副本（SDK 构建会顺手改贴图 .meta、lilToon 设置等，不能在主工程里跑）。
#           副本自己的 Library 保留（第二次构建不重导）；源里没有的文件从副本删掉（旧产物 Assets/_BuildArtifacts 随之清空）。
#           镜像跳过 _harness/delivery/：那是上一份交付包（可达数 GB），只归源工程，没有任何构建步骤从副本里读它。
#           final 与 regression 槽（都构建优化层）再把优化层的贴图方案（Assets/_Harness/Optimize/texture_plan.json）套到副本的贴图 .meta 上：
#           maxTextureSize 只降不升、开 streamingMipmaps、未压缩的改回压缩。套用明细写副本根的 .texture_plan_applied.json。
# 用法　　：build_copy.py --slot pre|regression_pre|final|regression   （工程取 AVH_PROJECT_DIR）
#           槽位互不重叠：build_pre/build 只写 pre/final，两个回归阶段各写自己的 regression_pre/regression。
"""Mirror the project into an isolated build copy; the optimize-layer slots also get the optimize stage's texture plan."""
import argparse
import hashlib
import json
import os
import re
import shutil
from pathlib import Path

SKIP_TOP = {'Library', 'Temp', 'Logs', 'UserSettings', 'obj', '.git', '_harness_build', 'Build', 'Builds', '.vs', '.idea'}
# 只跳过源工程这一棵子树：交付包属于源工程，镜像副本、交付副本与冷导入都不读它。副本里多出来的旧交付包仍按
# 「源里已经没有」删掉（删除那一侧不跳过），所以升级后旧副本的占用会自己收回来。
SKIP_SUBTREES = {'_harness/delivery'}
# 槽位 → 构建层：pre 层按菜单层原样构建，final 层套优化层的贴图方案。BuildStage.Run 另按 AVH_BUILD_SLOT 选层
# （BuildStage.cs:26-27，`pre` 以外一律按优化层），所以两个回归槽位沿用它们所测构建的层。
SLOT_LAYERS = {'pre': 'pre', 'regression_pre': 'pre', 'final': 'final', 'regression': 'final'}
# 副本自己的：VRCFury 的临时包要在 Unity 启动前就在（它自己要等编辑器空转 5 秒才建，批处理等不到）
COPY_OWNED = ('Packages/com.vrcfury.temp/',)
VRCFURY_TEMP = '{\n"name": "com.vrcfury.temp",\n"displayName": "VRCFury Temp Files",\n"version": "0.0.0",\n"hideInEditor": false,\n"author": { "name": "VRCFury" }\n}'
PLAN = 'Assets/_Harness/Optimize/texture_plan.json'
UNCOMPRESSED = {3, 4, 5, 13, 14, 17, 20, 26}  # RGB24 RGBA32 ARGB32 RGBA4444-ish RGBA64 RGBAHalf RGBAFloat …（TextureImporterFormat 值）


def files_of(root, skip_top, skip_subtrees=()):
    found = set()
    for dirpath, dirs, names in os.walk(root):
        rel = Path(dirpath).relative_to(root)
        if rel == Path('.'):
            dirs[:] = [d for d in dirs if d not in skip_top]
        if rel.as_posix() in skip_subtrees:
            dirs[:] = []
            continue
        for name in names:
            found.add((rel / name).as_posix())
    return found


def mirror(src, dst):
    """Copy what changed (size or mtime), delete what the source no longer has; the copy's caches stay."""
    wanted = files_of(src, SKIP_TOP, SKIP_SUBTREES)
    copied = 0
    for rel in sorted(wanted):
        s, d = src / rel, dst / rel
        st = s.stat()
        if d.exists():
            dt = d.stat()
            if dt.st_size == st.st_size and int(dt.st_mtime) == int(st.st_mtime):
                continue
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(s, d)
        copied += 1
    removed = 0
    for rel in sorted(files_of(dst, SKIP_TOP) - wanted):
        if rel.startswith(COPY_OWNED):
            continue
        (dst / rel).unlink()
        removed += 1
    for dirpath, dirs, names in sorted(os.walk(dst), key=lambda x: -len(x[0])):
        rel = Path(dirpath).relative_to(dst)
        if rel != Path('.') and rel.parts[0] not in SKIP_TOP and not any(Path(dirpath).iterdir()):
            Path(dirpath).rmdir()
    return copied, removed


def apply_plan(copy, plan):
    """Edit the copy's texture .meta files; returns one record per changed file."""
    changes = []
    for entry in plan.get('textures', []):
        meta = copy / (entry['path'] + '.meta')
        if not meta.is_file():
            changes.append({'path': entry['path'], 'error': '副本里没有这张图的 .meta'})
            continue
        text = original = meta.read_text(encoding='utf-8')
        target = int(entry['target_max_size'])
        text = re.sub(r'^(\s*maxTextureSize:\s*)(\d+)\s*$', lambda m: m.group(1) + str(min(int(m.group(2)), target)), text, flags=re.M)
        text = re.sub(r'^(\s*streamingMipmaps:\s*)0\s*$', r'\g<1>1', text, flags=re.M)
        if not entry.get('compressed', True):
            text = re.sub(r'^(\s*textureCompression:\s*)0\s*$', r'\g<1>1', text, flags=re.M)
            text = re.sub(r'^(\s*textureFormat:\s*)(\d+)\s*$',
                          lambda m: m.group(1) + ('-1' if int(m.group(2)) in UNCOMPRESSED else m.group(2)), text, flags=re.M)
        if text != original:
            meta.write_text(text, encoding='utf-8')
            changes.append({'path': entry['path'], 'guid': entry.get('guid'), 'role': entry.get('role'),
                            'action': entry.get('action'), 'rationale': entry.get('rationale'), 'target_max_size': target,
                            'before_sha256': hashlib.sha256(original.encode('utf-8')).hexdigest(),
                            'after_sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
                            'rollback': entry.get('rollback')})
        else:
            changes.append({'path': entry['path'], 'guid': entry.get('guid'), 'role': entry.get('role'),
                            'action': entry.get('action'), 'rationale': entry.get('rationale'), 'target_max_size': target,
                            'unchanged': True, 'rollback': entry.get('rollback')})
    return changes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--slot', required=True, choices=sorted(SLOT_LAYERS))
    parser.add_argument('--project', default=os.environ.get('AVH_PROJECT_DIR'))
    args = parser.parse_args()
    project = Path(args.project)
    layer = SLOT_LAYERS[args.slot]
    copy = project / '_harness_build' / args.slot / 'project'
    copy.mkdir(parents=True, exist_ok=True)
    copied, removed = mirror(project, copy)
    record = {'schema': 'build-copy/0.1', 'slot': args.slot, 'layer': layer, 'source': str(project),
              'copied': copied, 'removed': removed}
    temp = copy / 'Packages' / 'com.vrcfury.temp' / 'package.json'
    if (copy / 'Packages' / 'com.vrcfury.vrcfury').is_dir() and not temp.is_file():
        temp.parent.mkdir(parents=True, exist_ok=True)
        temp.write_text(VRCFURY_TEMP, encoding='utf-8')
        record['vrcfury_temp'] = 'created'
    if layer == 'final':
        plan_path = project / PLAN
        if not plan_path.is_file():
            raise SystemExit(f'{args.slot} 槽按优化层构建，需要优化层的贴图方案 {PLAN}')
        changes = apply_plan(copy, json.loads(plan_path.read_text(encoding='utf-8')))
        record['texture_plan'] = PLAN
        record['texture_changes'] = changes
        record['texture_changed_count'] = sum(1 for change in changes if not change.get('unchanged'))
        record['texture_unchanged_count'] = sum(1 for change in changes if change.get('unchanged'))
        errors = [c for c in changes if 'error' in c]
        if errors:
            raise SystemExit(f'贴图方案有 {len(errors)} 张图套不上：{errors[:3]}')
    (copy / '.texture_plan_applied.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"副本 {copy}（{args.slot} 槽，{layer} 层）：复制 {copied}，删除 {removed}" +
          (f"，贴图方案覆盖 {len(record['texture_changes'])} 张、实际改了 {record['texture_changed_count']} 张" if layer == 'final' else ''))


if __name__ == '__main__':
    main()
