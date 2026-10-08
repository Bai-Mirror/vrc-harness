#!/usr/bin/env python3
# 【项目沉淀】通用工具（Harness 能力：delivery.package 的动作，package 阶段）
# 适用素体：无关
# 工具链　：python3 标准库；7z（只在观测里用来 7z t）
# 可复用性：★★★ 换个单子直接能用
# 用途　　：按 SOP 90 打交付包，写到 _harness/delivery/（文件夹里只留总包）：
#           ① 交付副本 _harness_build/delivery/project：镜像工程、套优化层的贴图方案、删 Harness 自己的编辑器工具、补 .vsconfig；
#              一致排除商品应在 setup 前就没有导入，交付阶段只核对其数据没有残留，发现残留即阻断返工；
#           ② 工程 zip 只装 5 项（.gitignore .vsconfig Assets Packages ProjectSettings），排除只锚定工程根（插件内部的同名目录照留）；
#           ③ 素材 zip：<名>_素材/（客户自备的原始包）＋ _追加素材（非客户自备）/（素材库里取的原始包）＋ 来源说明.txt；
#              被一致排除的商品不进这一份，也不进总包；
#           ④ 交付说明.txt（UTF-8 无 BOM、LF），里面单列一节写清被排除商品由客户自行安装；
#           ⑤ 总包用 store，_追加素材 在总包层再放一份（刻意重复）；
#           ⑥ 把工程 zip 原样解到 _harness_build/cold/project（没有 Library，冷导入），注入冷导入复核用的独立程序集。
# 用法　　：package.py --library <素材库>（工程取 AVH_PROJECT_DIR；Manifest、方案取 AVH_MANIFEST、AVH_PLAN）
"""Build the SOP 90 delivery package and an extracted cold-import copy of the project zip."""
import argparse
import errno
import json
import os
import shutil
import sys
import unicodedata
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_copy import PLAN, apply_plan, mirror  # noqa: E402
from intake import item_files  # noqa: E402
from plan import effective_inventory, excluded_items, import_records  # noqa: E402
from material_dependencies import dependency_receipt_records, read_dependency_receipt, source_selection  # noqa: E402

PROJECT_ENTRIES = ('.gitignore', '.vsconfig', 'Assets', 'Packages', 'ProjectSettings')
ADDED = '_追加素材（非客户自备）'
TOOLS = 'Assets/_HarnessTools'
PROBE = 'Assets/_HarnessColdProbe'
# setup.py deploys the review package to `Assets/_HarnessTools/AvatarAudit` in the working project; the cold probe
# carries the same sources under the same name so the probe assembly sees the types its stage classes call.
AUDIT = 'AvatarAudit'
# Unity 的 Visual Studio 集成在工程根写的就是这份；交付工程约定带它（SOP 90「工程 zip 只装 5 项」）
VSCONFIG = '{\n  "version": "1.0",\n  "components": [\n    "Microsoft.VisualStudio.Workload.ManagedGame"\n  ]\n}\n'
PROBE_ASMDEF = {
    'name': 'AVH.Harness.ColdProbe',
    # The probe's stage classes call the review package (`global::AvatarAudit.AuditRunner`,
    # `global::AvatarAudit.AuditPartInventory`). In the working project they resolve through
    # Assembly-CSharp-Editor's automatic reference to the review assembly's `autoReferenced` asmdef; an explicit
    # probe assembly must name the assemblies instead, or the types it calls have no definition.
    'references': ['nadena.dev.modular-avatar.core', 'nadena.dev.ndmf', 'nadena.dev.ndmf.runtime',
                   'AvatarAudit.Editor', 'AvatarAudit.Runtime'],
    'includePlatforms': ['Editor'], 'autoReferenced': False,
}


def nfc(text):
    return unicodedata.normalize('NFC', text)


def remove(path):
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def zip_tree(target, root, names, method):
    """Zip the named top-level entries of root; directories recursively, paths relative to root."""
    with zipfile.ZipFile(target, 'w', compression=method, compresslevel=1 if method == zipfile.ZIP_DEFLATED else None) as z:
        for name in names:
            path = root / name
            if path.is_file():
                z.write(path, name)
                continue
            for dirpath, dirs, files in os.walk(path):
                dirs.sort()
                rel = Path(dirpath).relative_to(root)
                z.write(dirpath, rel.as_posix() + '/')
                for file in sorted(files):
                    z.write(Path(dirpath) / file, (rel / file).as_posix())


def delivery_copy(project, build, excluded, import_record):
    copy = build / 'delivery' / 'project'
    copy.mkdir(parents=True, exist_ok=True)
    mirror(project, copy)
    changes = apply_plan(copy, json.loads((project / PLAN).read_text(encoding='utf-8')))
    for leftover in (copy / TOOLS, copy / (TOOLS + '.meta'), copy / 'Assets' / '_BuildArtifacts', copy / 'Assets' / '_BuildArtifacts.meta'):
        remove(leftover)
    (copy / '.vsconfig').write_text(VSCONFIG, encoding='utf-8')
    assert_excluded_data_absent(project, copy, import_record, excluded)
    return copy, changes


def assert_excluded_data_absent(project, copy, import_record, excluded=None, inventory=None, plan=None):
    """
    Verify that setup did not import a product the approved plan consistently excluded.

    Packaging no longer edits a delivery copy to hide an import defect. Roots and optional VPM package identities
    come from setup/environment receipts, while the intake remains the raw evidence. A shared root is therefore a
    failure too: setup must filter the excluded item before import, where ownership is still unambiguous.
    """
    if plan is None:
        plan = json.loads(os.environ.get('AVH_PLAN') or '{}')
    if inventory is None:
        inventory = json.loads((project / '_harness' / 'intake' / 'inventory.json').read_text(encoding='utf-8'))
    effective = effective_inventory(inventory, plan if plan else (excluded or {}))
    excluded = excluded_items(plan) if plan else (excluded or {})
    effective_ids = {nfc(str(item.get('item'))) for item in effective.get('items', [])
                     if any(isinstance(file, dict) and file.get('selected') for file in item.get('files', []))}
    declined = {nfc(str(item)) for item in excluded if nfc(str(item)) not in effective_ids}
    owners = {}
    for prior in import_records(import_record):
      for package in prior.get('packages', []):
        item = nfc(str(package.get('item')))
        for root in package.get('roots') or []:
            owners.setdefault(str(root), set()).add(item)
        if item in declined:
            for path in package.get('paths') or []:
                owners.setdefault(str(path), set()).add(item)
    roots = set()
    for root, items in sorted(owners.items()):
        if items & declined:
            roots.add(str(root))
    package_ids = {Path(root).name for root in roots if Path(root).parts[:1] == ('Packages',)}
    environment_lock = project / '_harness' / 'environment' / 'environment-lock.json'
    try:
        lock = json.loads(environment_lock.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        lock = {}
    for pin in ((lock.get('vpmRequirements') or {}).get('packages') or []):
        if isinstance(pin, dict) and nfc(str(pin.get('item'))) in declined and pin.get('id'):
            package_ids.add(str(pin['id']))
            roots.add(f'Packages/{pin["id"]}')
    for root in sorted(roots):
        if (copy / root).exists() or (copy / (root + '.meta')).exists():
            raise SystemExit('一致排除商品的数据仍在交付工程中，需技术返工后再打包：' + root)
    for name in ('Packages/manifest.json', 'Packages/vpm-manifest.json', 'Packages/packages-lock.json'):
        path = copy / name
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        for section in ('dependencies', 'locked'):
            block = data.get(section)
            if isinstance(block, dict):
                found = sorted(set(block) & package_ids)
                if found:
                    raise SystemExit('一致排除商品的包仍在交付清单中，需技术返工后再打包：' + ', '.join(found))
    assert_dependency_receipt_absent(project, copy)


def assert_dependency_receipt_absent(project, copy):
    """A dependency receipt is evidence, not permission to ship assets from a now-excluded source."""
    receipt = read_dependency_receipt(project)
    for record in dependency_receipt_records(receipt):
        for package in record.get('packages') or []:
            states = [source_selection(project, package.get(field))[0]
                      for field in ('anchor', 'archive') if package.get(field)]
            if 'not-effective' not in states:
                continue
            for asset in package.get('assets') or []:
                relative = asset.get('path')
                if not isinstance(relative, str) or not relative:
                    continue
                target = copy / relative
                if target.exists() or Path(str(target) + '.meta').exists():
                    raise SystemExit('一致排除的依赖来源仍有派生数据（路径 ' + relative + '）；配色 prepare 会在下一次运行时自动核对并清理。'
                                     '若 prepare 仍失败，请按其提示保留该来源或改用新工程后再打包')


def added_assets(library, inventory, import_record, target, excluded, plan=None):
    """
    The library packages this order used, copied as they are, and one line per package for 来源说明.txt.

    An item the plan consistently excludes is not copied and gets no line: the delivery keeps no data for it and
    the source note must not read as a list of what the customer still has to import from this package.
    """
    inventory = effective_inventory(inventory, plan if plan is not None else excluded)
    target.mkdir(parents=True, exist_ok=True)
    lines = []
    roots = {}
    for prior in import_records(import_record):
        for package in prior.get('packages', []):
            roots.setdefault((package['item'], package['zip']), set()).update(package.get('roots', []))
    for item in inventory.get('items', []):
        if item.get('store', 'library') != 'library':
            continue
        # A Manifest item is either a library product folder (`<名>-<商品号>/files/`) or, for a project made in
        # Harness, the path of one file. `intake.item_files` is the resolver the intake and setup already use, so
        # the delivery reads the same Manifest the same way instead of keeping a third interpretation of it.
        located = item_files(library, item['item'])
        files = located[1] if located else []
        for entry in item.get('files', []):
            if not entry.get('selected'):
                continue
            source = next((p for p in files if nfc(p.name) == nfc(entry['name'])), None)
            if source is None:
                raise SystemExit(f"素材库里找不到 {item['item']} 的 {entry['name']}")
            shutil.copy2(source, target / entry['name'])
            use = {'body': '素体', 'outfit': '服装'}.get(item.get('role'), '附件')
            paths = '、'.join(sorted(roots.get((item['item'], entry['name']), []))) or '—'
            size = source.stat().st_size / 1024 / 1024
            lines.append(f"{entry['name']}｜{item.get('name') or item['item']}（商品 {item['item']}）｜用途：{use}｜工程路径：{paths}｜{size:.1f} MiB")
    (target / '来源说明.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return lines


def excluded_section(inventory, excluded):
    """
    The note lines for products the plan consistently excludes: the delivery carries no data for them, so the
    note says so and hands the installation to the customer's own copy of the vendor package. Reason codes and
    prose come from the approved plan; no product, vendor or tool name is written here.
    """
    if not excluded:
        return []
    names = {nfc(str(item['item'])): (item.get('name') or item['item']) for item in inventory.get('items', [])}
    labels = {'unsupported': '不支持本素体', 'overlap': '与已装件功能重叠', 'client_declined': '客户明确不装'}
    lines = ['', '## 客户自行安装（本包不含其数据）', '',
             '- 以下商品已由方案批准排除，交付工程与素材包里都没有它的数据，也没有随包安装。',
             '- 需要使用时请自备该商品的厂商原件，按厂商随附的安装工具与说明自行安装；安装后请在客户端自测。', '']
    for item in sorted(excluded):
        reason, note = excluded[item]['reason'], excluded[item]['note']
        lines.append(f"- {names.get(item, item)}（商品 {item}）：{labels.get(reason, reason)}" + (f"；{note}" if note else ''))
    return lines


def assembly_record(path):
    """One outfit-stage record, or an empty mapping for a round that has not written it yet."""
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def hidden_parts(project):
    """
    Parts the assembly hid in its default state, each with the reason recorded when it was hidden.

    The reason comes from the operation itself; a receipt that predates the required rationale falls
    back to the assembly records' `hidden_by_decision` for the same path. A part that only carries a
    build exclusion was never hidden, so it is not listed here.
    """
    receipt = assembly_record(project / 'Assets/_Harness/Outfit/local-operation-receipt.json')
    reasons = {}
    for source in ('visibility.json', 'outfit.json'):
        record = assembly_record(project / 'Assets/_Harness/Outfit' / source)
        for row in record.get('hidden_by_decision') or []:
            if isinstance(row, str):
                reasons.setdefault(row, '')
            elif isinstance(row, dict) and row.get('path'):
                reasons.setdefault(row['path'], row.get('rationale') or '')
    rows, seen = [], set()
    for op in receipt.get('operations') or []:
        if not isinstance(op, dict) or op.get('kind') != 'object_state' or op.get('active') is not False:
            continue
        path = op.get('path')
        if not path or path in seen:
            continue
        seen.add(path)
        rows.append({'path': path, 'rationale': op.get('rationale') or reasons.get(path) or '',
                     'exclude_from_build': op.get('exclude_from_build') is True})
    for path, rationale in reasons.items():
        if path not in seen:
            rows.append({'path': path, 'rationale': rationale, 'exclude_from_build': False})
    return rows


def without_final_stop(text):
    """
    A reason the executor writes usually ends in its own full stop. The note templates add one when they
    place it in a sentence, so the text is trimmed of its trailing sentence punctuation first — otherwise a
    reason ending in '。' renders as '。。'.
    """
    trimmed = str(text).rstrip()
    while trimmed and trimmed[-1] in '。.':
        trimmed = trimmed[:-1].rstrip()
    return trimmed


def hidden_parts_section(project):
    """
    The note lines for the executor's default-visibility decisions. A recoverable hide stays in the
    delivery model and can be turned back on; an excluded part is gone from the build.
    """
    rows = hidden_parts(project)
    if not rows:
        return []
    lines = ['', '## 默认关闭的部件', '',
             '- 以下部件装配后默认不显示。它是可恢复的关闭，需要时可在 Unity 里重新打开；标了「构建排除」的已从构建中剔除，不在交付模型里。', '']
    for row in rows:
        reason = without_final_stop(row['rationale']) or '本轮没有记录理由'
        lines.append(f"- 我已隐藏 {row['path']}：{reason}" + ('；并从构建中排除。' if row['exclude_from_build'] else '。'))
    return lines


def review_line(item):
    """One user-facing line for a trade-off the executor left to the user, in whatever shape it came."""
    if isinstance(item, str):
        return item
    if not isinstance(item, dict):
        return str(item)
    line = str(item.get('question') or item.get('summary') or item.get('path') or '有一处取舍需要你确认')
    detail = item.get('detail') or item.get('reason')
    if detail:
        line += f"（{detail}）"
    options = item.get('options') or []
    rendered = [str(option.get('label')) if isinstance(option, dict) and option.get('label') else str(option)
                for option in options]
    if rendered:
        line += '；选项：' + '／'.join(rendered)
    return line


def trade_off_option(option):
    """One option of a numbered trade-off, with the change it stands for written out (`D-148`)."""
    if not isinstance(option, dict):
        return str(option)
    changes = []
    for operation in option.get('operations') or []:
        if not isinstance(operation, dict) or not operation.get('path'):
            continue
        changes.append(('关掉 ' if operation.get('active') is False else '打开 ') + str(operation['path']))
    rendered = f"{option.get('id')} {option.get('label') or ''}".strip()
    return rendered + ('（' + '；'.join(changes) + '）' if changes else '（保持现状，什么也不改）')


def trade_off_lines(item, asks):
    """
    `D-148`: one shipped trade-off, listed by its stable number. Every option says what it does to the delivered
    avatar, this round's recommendation is marked, and the option the artifact already uses is marked as current —
    so the user answers with a number instead of describing an effect. The interpenetration pairs the executor
    kept are folded in here: they name the trade-off by number, so one choice is stated in one place.
    """
    identifier = str(item.get('id') or '')
    question = str(item.get('question') or '有一处取舍需要你确认')
    lines = [f"- {identifier} {question}" if identifier else f"- {question}"]
    if item.get('detail'):
        lines.append(f"  - 依据：{without_final_stop(item['detail'])}。")
    for option in item.get('options') or []:
        marks = []
        if isinstance(option, dict):
            if option.get('id') == item.get('recommended'):
                marks.append('推荐')
            if option.get('id') == item.get('current'):
                marks.append('当前')
        lines.append(f"  - {trade_off_option(option)}" + (f"（{'、'.join(marks)}）" if marks else ''))
    for row in asks:
        parts = [str(part) for part in (row.get('objects') or []) if str(part)]
        reason = without_final_stop(row.get('rationale') or '') or '这两件我都没有关，等你决定'
        lines.append(f"  - 涉及：{' ↔ '.join(parts)}；{reason}。" if parts else f"  - 涉及：{reason}。")
    return lines


def decision_line(item):
    """One user-facing line for a pair the executor kept and handed to the user (`D-143` ③ `ask_user`)."""
    parts = [str(part) for part in (item.get('objects') or []) if str(part)]
    line = '保留 ' + ' ↔ '.join(parts) if parts else '有一处保留需要你确认'
    if item.get('rationale'):
        line += '：' + without_final_stop(item['rationale'])
    if item.get('criterion'):
        line += f"（依据准则：{without_final_stop(item['criterion'])}）"
    if item.get('evidence'):
        line += f"（依据证据：{without_final_stop(item['evidence'])}）"
    return line


def user_review_section(project):
    """
    The trade-offs the executor refused to decide alone because they change the look the user asked
    for: the numbered items it raised, plus every visible interpenetration it kept and marked `ask_user`.
    A kept pair points at the number that carries its options, so the choice itself is listed once (`D-148`).
    The receipt carries both; the submitted recipe is the fallback for a receipt that predates the
    fields, so the user still sees the choice rather than an executor's silent pick.
    """
    receipt = assembly_record(project / 'Assets/_Harness/Outfit/local-operation-receipt.json')
    items = receipt.get('user_review')
    decisions = receipt.get('interpenetration_decisions')
    if not items or not decisions:
        recipe = assembly_record(project / 'Assets/_Harness/Outfit/local-operations.json')
        if not items:
            items = recipe.get('user_review')
        if not decisions:
            decisions = recipe.get('interpenetration_decisions')
    if not isinstance(items, list):
        items = [items] if items else []
    if not isinstance(decisions, list):
        decisions = [decisions] if decisions else []
    numbered, legacy = [], []
    for item in [item for item in items if item]:
        (numbered if isinstance(item, dict) and item.get('id') and item.get('options') else legacy).append(item)
    asks = [item for item in decisions if isinstance(item, dict) and item.get('decision') == 'ask_user']
    by_number = {str(item['id']): item for item in numbered}
    folded, loose = {}, []
    for row in asks:
        key = row.get('review')
        if key is not None and str(key) in by_number:
            folded.setdefault(str(key), []).append(row)
        else:
            loose.append(row)
    if not numbered and not legacy and not asks:
        return []
    lines = ['', '## 需要你确认的取舍', '',
             '- 下列取舍会改变你要的外观，我没有替你定；每条都给了几个方案（A、B…），选一个编号就行。', '']
    for item in numbered:
        lines += trade_off_lines(item, folded.get(str(item['id']), []))
    lines += ['- ' + review_line(item) for item in legacy]
    lines += ['- ' + decision_line(item) for item in loose]
    if numbered:
        first = numbered[0]
        example = str((first.get('options') or [{}])[0].get('id') or 'A')
        lines += ['', f"- 要改的话，在重做意见里写编号，例如「{first['id']} 选 {example}」；"
                      '同一编号以外的其他取舍保持不变。']
    return lines


def delivery_note(project, name, manifest, excluded):
    def read(path):
        try:
            return json.loads((project / path).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return {}
    inventory = read('_harness/intake/inventory.json')
    outfit = read('Assets/_Harness/Outfit/outfit.json')
    menu = read('Assets/_Harness/Menu/menu.json')
    ledger = read('Assets/_Harness/Recolor/ledger.json')
    optimize = read('Assets/_Harness/Optimize/optimize.json')
    preserved_optimization = optimize.get('mode') == 'preserve'
    lines = [f'# {name} 交付说明', '', '## 需求（原话）', '', (manifest.get('request') or '').strip(), '',
             '## 交付内容', '',
             f'- {name}_工程.zip：Unity 工程（Assets / Packages / ProjectSettings 等 5 项），打开 Assets/_Harness/Optimize/Avatar.unity 即可上传',
             f'- {name}_素材.zip：原始素材包（{ADDED}/ 里是素材库取的包，附 来源说明.txt）', '', '## 装配', '']
    lines += [f"- 素体：{outfit.get('body_prefab', '—')}；隐藏素体自带的衣服：{'、'.join(outfit.get('hidden_body_parts', [])) or '无'}（构建时剔除）"]
    for o in outfit.get('outfits', []):
        lines.append(f"- 服装 {o.get('label')}（{o.get('id')}）：{o.get('prefab')}；装配方式 {o.get('assembly')}；收缩键：{(o.get('shrinkkey') or {}).get('decision')}"
                     + ('；共同穿戴（fixed）' if o.get('activation', 'exclusive') == 'fixed' else
                        '；默认穿着' if o.get('default') else ''))
    for trim in outfit.get('vendor_missing_material_slots', []):
        lines.append(f"- 厂商缺件尾部材质槽已从头像实例移除：{trim.get('renderer_path')}；槽位数 {trim.get('original_slot_count')} → {trim.get('final_slot_count')}；去掉槽位 {','.join(str(x) for x in trim.get('removed_slots', []))}；GUID {','.join(str(x) for x in trim.get('removed_guids', []))}")
    for reminder in outfit.get('vendor_missing_material_references', []):
        lines.append(f"- 厂商材质贴图缺件提醒：{reminder.get('material')}；属性 {reminder.get('property')}；GUID {reminder.get('guid')}；使用着色器默认贴图，不阻断")
    for reminder in outfit.get('vendor_missing_animation_references', []):
        lines.append(f"- 厂商动画缺件提醒（该状态不播放，不阻断）：{reminder.get('controller')}；状态 {reminder.get('state')}；GUID {reminder.get('guid')}")
    lines += hidden_parts_section(project)
    lines += user_review_section(project)
    lines += excluded_section(inventory, excluded)
    preserved_menu = menu.get('route') == 'preserve'
    lines += ['', '## 菜单', '', '- 保留原菜单与交互，没有新增衣装轮盘或部件开关' if preserved_menu else
              f"- 单一衣装轮盘＋横向语义部件组；参数 {'、'.join(menu.get('parameters', []))}"]
    for c in menu.get('controls', []):
        lines.append(f"- 服装/{c.get('label')}：{c.get('control')}（{c.get('parameter')}={c.get('value')}），{c.get('note')}")
    lines += ['', '## 改色', '', f"- 选定档 {ledger.get('chosen', '—')}，替换材质槽 {len(ledger.get('rows', []))} 个；取舍见 Assets/_Harness/Recolor/配色决策.md",
              '', '## 优化', '', '- 按批准要求保留制作结果，没有新增优化器或修改贴图导入设置' if preserved_optimization else
              f"- AAO Trace And Optimize，覆盖设置：{json.dumps((optimize.get('aao') or {}).get('overrides', {}), ensure_ascii=False)}",
              '- 保留素材原有的构建插件；独立检查和性能限制仍然适用' if preserved_optimization else
              '- 贴图导入设置按逐 GUID 审核的 Assets/_Harness/Optimize/texture_plan.json 套用；每项带理由、审美状态与回滚基线',
              '', '## 上传前后请自测', '',
              '- 在 VRChat SDK 面板里确认只有一个头像根；上传后检查改色效果，并逐项测试原有菜单与交互' if preserved_menu else
              '- 在 VRChat SDK 面板里确认只有一个头像根；上传后逐档测试衣装轮盘，并逐一开关横向部件组',
              '- 本包未在 VRChat 客户端实机验证（上传与实机检查由你完成）', '']
    return '\n'.join(lines)


CLIENT_CHECKS = {'upload', 'network_sync', 'saved_reload', 'vr_gestures', 'platform_rendering'}


def diagnosis_document(project):
    """Validate the machine-readable diagnosis and render the user-facing copy. Client-only facts can never be pre-passed."""
    path = project / '_harness' / 'delivery' / 'diagnosis.json'
    if not path.is_file():
        raise SystemExit('缺少 _harness/delivery/diagnosis.json：诊断代理没有提交结构化验收结论')
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as error:
        raise SystemExit(f'diagnosis.json 无法读取：{error}')
    if data.get('schema') != 'delivery-diagnosis/0.1' or data.get('verdict') not in {'ready', 'blocked'}:
        raise SystemExit('diagnosis.json 须为 delivery-diagnosis/0.1，verdict 只能是 ready 或 blocked')
    blockers = data.get('blockers') or []
    if bool(blockers) != (data['verdict'] == 'blocked'):
        raise SystemExit('diagnosis verdict 与 blockers 不一致：有阻断必须 blocked，无阻断才能 ready')
    if blockers:
        summary = '；'.join(str(item.get('reason') or item.get('id') or '未说明') for item in blockers[:5])
        raise SystemExit(f'交付诊断仍有 {len(blockers)} 个阻断项，不打包：{summary}')
    verified = data.get('verified') or []
    for item in verified:
        if not item.get('id') or not item.get('summary') or not item.get('evidence'):
            raise SystemExit('diagnosis.verified 每项必须有 id、summary 和非空 evidence')
    client = data.get('client_checks') or []
    ids = {item.get('id') for item in client}
    if ids != CLIENT_CHECKS:
        raise SystemExit(f'diagnosis.client_checks 必须恰好覆盖 {sorted(CLIENT_CHECKS)}，当前 {sorted(str(x) for x in ids)}')
    for item in client:
        if item.get('status') != 'pending' or not item.get('steps') or not item.get('expected'):
            raise SystemExit(f"客户端检查 {item.get('id')} 必须保持 pending，并给出 steps 与 expected")
    lines = ['# 客户端验收与诊断', '', '## 结论', '', '自动化证据范围内可交付；以下客户端专属项目仍待执行。', '', '## 已验证', '']
    for item in verified:
        evidence = '、'.join(str(x) for x in item['evidence'])
        lines.append(f"- {item['summary']}（证据：{evidence}）")
    lines += ['', '## 性能取舍', '']
    lines += [f"- {item}" for item in (data.get('performance_tradeoffs') or ['无额外取舍记录'])]
    lines += ['', '## 素材核销摘要', '', str(data.get('material_summary') or '见交付素材来源说明。'), '', '## 待客户端/真机', '']
    for item in client:
        lines += [f"### {item.get('title') or item['id']}", '', *[f"{i + 1}. {step}" for i, step in enumerate(item['steps'])],
                  '', f"期望：{item['expected']}", f"状态：待执行（{item.get('evidence_limit') or '自动化环境无法证明'}）", '']
    return ('\n'.join(lines).rstrip() + '\n').encode('utf-8')


def copy_tree(source, target):
    """Copy a directory recursively, keeping the asmdefs it carries so each part stays its own assembly."""
    for dirpath, _, names in os.walk(source):
        relative = Path(dirpath).relative_to(source)
        (target / relative).mkdir(parents=True, exist_ok=True)
        for name in names:
            shutil.copy2(Path(dirpath) / name, target / relative / name)


def cold_copy(build, project_zip, tool_root):
    cold = build / 'cold' / 'project'
    remove(cold)
    cold.mkdir(parents=True)
    with zipfile.ZipFile(project_zip) as z:
        z.extractall(cold)
    probe = cold / PROBE / 'Editor'
    probe.mkdir(parents=True)
    for source in sorted((tool_root / 'harness' / 'unity' / 'Editor').glob('*.cs')) + [tool_root / '构建' / 'BuildArtifact.cs']:
        shutil.copy2(source, probe / source.name)
    # The review package the probe's stage classes call, injected the way setup.py deploys it into the working
    # project, with its own asmdefs so it compiles under the same references and version defines. It is not
    # delivery content: the zips are already written when this runs, and everything here lands in
    # _harness_build/cold/ only. A pack without it cannot complete the delivered-project check, so say so here
    # rather than let it surface as missing-type errors and a no_data observation.
    audit = tool_root / '审查' / 'unity'
    if not audit.is_dir():
        raise SystemExit(f'工具包缺少冷导入探针依赖的审核包源码：{audit}')
    copy_tree(audit, cold / PROBE / AUDIT)
    (probe / 'AVH.Harness.ColdProbe.asmdef').write_text(json.dumps(PROBE_ASMDEF, indent=2) + '\n', encoding='utf-8')
    return cold


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--library', required=True)
    parser.add_argument('--project', default=os.environ.get('AVH_PROJECT_DIR'))
    args = parser.parse_args()
    project, library = Path(args.project), Path(args.library)
    tool_root = Path(os.environ.get('AVH_TOOL_ROOT') or HERE.parent)
    manifest = json.loads(os.environ.get('AVH_MANIFEST') or '{}')
    plan = json.loads(os.environ.get('AVH_PLAN') or '{}')
    name = project.name
    build = project / '_harness_build'
    diagnosis = diagnosis_document(project)
    staging = build / 'delivery' / 'staging'
    remove(staging)
    staging.mkdir(parents=True)

    inventory = json.loads((project / '_harness' / 'intake' / 'inventory.json').read_text(encoding='utf-8'))
    import_record = json.loads((project / '_harness' / 'setup' / 'import.json').read_text(encoding='utf-8'))
    excluded = excluded_items(plan)
    copy, changes = delivery_copy(project, build, excluded, import_record)
    project_zip = staging / f'{name}_工程.zip'
    zip_tree(project_zip, copy, [e for e in PROJECT_ENTRIES if (copy / e).exists()], zipfile.ZIP_DEFLATED)

    material_root = staging / 'material'
    (material_root / f'{name}_素材').mkdir(parents=True)
    lines = added_assets(library, inventory, import_record, material_root / ADDED, excluded, plan)
    material_zip = staging / f'{name}_素材.zip'
    zip_tree(material_zip, material_root, [f'{name}_素材', ADDED], zipfile.ZIP_DEFLATED)

    total_root = staging / 'total'
    total_root.mkdir()
    shutil.move(str(project_zip), total_root / project_zip.name)
    shutil.move(str(material_zip), total_root / material_zip.name)
    shutil.copytree(material_root / ADDED, total_root / ADDED)
    (total_root / '交付说明.txt').write_bytes(delivery_note(project, name, manifest, excluded).encode('utf-8'))
    (total_root / '客户端验收与诊断.md').write_bytes(diagnosis)

    delivery = project / '_harness' / 'delivery'
    delivery.mkdir(parents=True, exist_ok=True)
    for old in delivery.iterdir():  # 清内容、不删目录：它是 Runtime 预建的沙箱挂载点
        # 执行沙箱可能在允许写的目录里挂保护点（codex 沙箱的只读 .codex），它不是交付内容，删不掉也不必删
        if os.path.ismount(old):
            continue
        try:
            remove(old)
        except OSError as error:
            if error.errno != errno.EBUSY:
                raise
    total = delivery / f'{name}_交付.zip'
    zip_tree(total, total_root, [project_zip.name, material_zip.name, ADDED, '交付说明.txt', '客户端验收与诊断.md'], zipfile.ZIP_STORED)

    cold = cold_copy(build, total_root / project_zip.name, tool_root)
    remove(staging)
    changed = sum(1 for change in changes if not change.get('unchanged'))
    print(f'总包 {total}（{total.stat().st_size / 1024 / 1024:.1f} MiB）；追加素材 {len(lines)} 个；'
          f'方案排除的商品 {len(excluded)} 个（交付前残留核对通过）；'
          f'贴图方案覆盖 {len(changes)} 张、实际改了 {changed} 张；冷导入副本 {cold}')


if __name__ == '__main__':
    main()
