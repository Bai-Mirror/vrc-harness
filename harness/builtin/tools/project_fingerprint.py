#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
【项目沉淀】通用工具
适用素体：无关          相关素材：无
可复用性：★★★ 换个单子直接能用
用途　　：**不开 Unity、不装第三方包**，纯文件解析 Unity 工程（Assets + Packages 的 YAML 与 .meta），
          把工程结构抽成同一格式的指纹 JSON，另可输出一页人读摘要 MD。
          14 个历史工程 + 7 个客户工程的横向比较都基于它。

为什么不用 Unity：逐个开工程要几十分钟，而这些资产（.unity/.prefab/.asset/.anim/.controller/.mat）
都是 Unity YAML 文本；GUID 引用靠文件旁的 .meta 反查即可完整还原。开 Unity 反而会写盘。
为什么自己写解析器：Python 标准库没有 YAML，且 Unity YAML 有 `--- !u!<classID> &<fileID>` 标签、
`{fileID: .., guid: .., type: 3}` 行内映射、以及**长值折行**（续行常常不含冒号，例如 shader 关键
字表、被折的 `path:`），`grep "path:"` 这类逐行抓法必漏。这里实现了缩进解析 + 折行拼接 + 行内集合。

用法：
    python3 project_fingerprint.py <工程目录> --out <输出.json> [--md <摘要.md>]

口径与已知边界（写进 JSON 的 meta 里，读的人先看这段）：
  * 只读 Assets/ 与 Packages/，跳过 Library/Temp/obj 等；任何文件 > 30 MB 一律跳过并记入 skipped。
  * components 计数含 Assets + Packages（同时给 Assets 单独一份）；Packages 里的 SDK 样例、
    NDMF `__Generated/` 烘焙产物会让绝对值偏大，横向比较请看 assets_only 或有意识地排除。
  * dll 组件（VRChat SDK / 约束 / 接触）按**序列化字段特征**判型，规则见 JSON 顶层 dll_script_rules；
    判不出的记 `dll:<dll文件名>:<fileID>`。
  * 形态键、显隐等曲线按 .anim 的 attribute 前缀分类；位数按 VRCExpressionParameters 的
    valueType 计（Int/Float 8、Bool 1，networkSynced=0 不计）。

禁止：本工具纯只读，不写工程内任何文件。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict

TOOL_VERSION = "1.0"
MAX_FILE_BYTES = 30 * 1024 * 1024
SCAN_ROOTS = ("Assets", "Packages")
YAML_EXTS = (".unity", ".prefab", ".anim", ".controller", ".mat", ".asset")
SKIP_DIR_NAMES = {
    "Library", "Temp", "obj", "obj~", "Logs", "UserSettings", "MemoryCaptures",
    "Recordings", "Build", "Builds", ".git", "node_modules",
}
# .asset 里只有这两类 VRC 资产需要整体解析，先读头部做廉价预筛，避免读 800 MB 生成网格。
ASSET_PREFILTER = (b"fileID: -340790334", b"fileID: -1506855854", b"controls:", b"isEmpty:")

MENU_CONTROL_TYPES = {101: "Button", 102: "Toggle", 103: "SubMenu",
                      201: "TwoAxis", 202: "FourAxis", 203: "RadialPuppet"}
PARAM_VALUE_TYPES = {0: "Int", 1: "Float", 2: "Bool"}
ANIM_PARAM_TYPES = {1: "Float", 3: "Int", 4: "Bool", 9: "Trigger"}
BLEND_MODE_NAMES = {0: "Override", 1: "Additive", 2: "Multiply"}
AAO_CLASS_NAMES = {"MergePhysBone", "TraceAndOptimize", "AutomaticConfiguration",
                   "UnusedBonesByReferencesTool", "AvatarOptimizer"}

# guid -> shader 文件名；内置 shader 没有可解析 guid 时退回 builtin:<fileID>。
BUILTIN_SHADER_NAMES = {
    46: "Standard", 103: "InternalErrorShader", 10770: "Sprites/Default",
}

# dll（fileID != 11500000）组件的字段特征判型规则。
# 结构：(类型名, 必须存在的顶层键[], 必须出现的子串[], 禁止的顶层键[], 禁止的子串[])
DLL_FIELD_RULES = [
    ("VRCAvatarDescriptor", ["baseAnimationLayers", "expressionsMenu"], [], [], []),
    ("VRCPhysBone", ["rootTransform", "integrationType"], [], [], []),
    ("VRCPhysBoneCollider", ["rootTransform", "shapeType", "insideBounds"], [], [], []),
    ("VRCContactReceiver", ["collisionTags", "receiverType"], [], [], []),
    ("VRCContactSender", ["collisionTags"], [], ["receiverType"], []),
    ("VRCConstraint", ["GlobalWeight", "TargetTransform"], [], [], []),
    ("VRCExpressionsMenu", ["controls"], [], [], []),
    ("VRCExpressionParameters", ["parameters", "isEmpty"], [], [], []),
    ("ModularAvatarShapeChanger", [], ["m_shapes", "ShapeName"], [], []),
    ("ModularAvatarParameters", ["parameters"], ["nameOrPrefix"], [], []),
]

SCRIPT_RE = re.compile(r'm_Script: \{fileID: (-?\d+), guid: ([0-9a-fA-F]+)(?:, type: \d+)?\}')
OBJ_HEADER_RE = re.compile(r'^--- !u!(\d+) &(-?\d+)(?: stripped)?[ \t]*$', re.M)
TOPKEY_RE = re.compile(r'^  ([A-Za-z_]\w*):', re.M)
GUID_LINE_RE = re.compile(r'^guid: ([0-9a-fA-F]+)', re.M)
SHADER_REF_RE = re.compile(
    r'm_Shader: \{fileID: (-?\d+)(?:, guid: ([0-9a-fA-F]+))?(?:, type: \d+)?\}')
PREFAB_SRC_RE = re.compile(r'm_SourcePrefab: \{fileID: \d+, guid: ([0-9a-fA-F]+)')
PSOURCE_GO_RE = re.compile(
    r'm_CorrespondingSourceObject: \{fileID: (-?\d+), guid: ([0-9a-fA-F]+)')
PINSTANCE_RE = re.compile(r'm_PrefabInstance: \{fileID: (-?\d+)\}')


# --------------------------------------------------------------------------- #
# 轻量 Unity-YAML 解析
# --------------------------------------------------------------------------- #
def _quote_opens(prev_ns):
    return prev_ns is None or prev_ns in ':,([{-'


def _balanced(s):
    """行内集合 {} / [] 与引号是否闭合；引号只在 token 起始处才算开引号，
    避免把 `Bob's Hat` 里的撇号当成开引号。"""
    depth = 0
    q = None
    esc = False
    prev_ns = None
    for c in s:
        if q:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == q:
                q = None
        else:
            if c in '"\'':  # 注意这行里的转义
                if _quote_opens(prev_ns):
                    q = c
            elif c in '{[':
                depth += 1
            elif c in '}]':
                depth -= 1
        if not c.isspace():
            prev_ns = c
    return depth <= 0 and q is None


def _is_mapping_line(s):
    return re.match(r'^[A-Za-z_][\w\.\[\]]*:(\s|$)', s) is not None


def _has_value(s):
    m = re.match(r'^[^:]+:\s*(\S.*)$', s)
    return bool(m)


def logical_lines(text):
    """把物理行整理成 (indent, content)：拼回行内集合/引号的跨行，以及 Unity 的长值折行。"""
    out = []
    pending = None  # [indent, content] 行内集合未闭合
    prev_had_value = False
    prev_is_seq = False
    for raw in text.split('\n'):
        st = raw.strip()
        if not st or st.startswith('%') or st.startswith('---'):
            continue
        indent = len(raw) - len(raw.lstrip(' '))
        content = st
        if pending is not None:
            pending[1] = pending[1] + ' ' + content
            if _balanced(pending[1]):
                out.append([pending[0], pending[1]])
                prev_had_value = _has_value(pending[1])
                prev_is_seq = pending[1].startswith('-')
                pending = None
            continue
        if not _balanced(content):
            pending = [indent, content]
            continue
        if (out and prev_had_value and not prev_is_seq and indent > out[-1][0]
                and not content.startswith('-') and not _is_mapping_line(content)):
            # 折行的纯量续行：续行不含映射冒号（任务书明确提醒）
            out[-1][1] = out[-1][1] + ' ' + content
            prev_had_value = _has_value(out[-1][1])
            prev_is_seq = False
            continue
        out.append([indent, content])
        prev_had_value = _has_value(content)
        prev_is_seq = content.startswith('-')
    if pending is not None:
        out.append([pending[0], pending[1]])
    return [(i, c) for i, c in out]


def _split_top(s, sep=','):
    parts = []
    depth = 0
    q = None
    esc = False
    prev_ns = None
    cur = ''
    for c in s:
        if q:
            cur += c
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == q:
                q = None
        else:
            if c in '"\'':  # 引号
                if _quote_opens(prev_ns):
                    q = c
                cur += c
            elif c in '{[':
                depth += 1
                cur += c
            elif c in '}]':
                depth -= 1
                cur += c
            elif c == sep and depth == 0:
                parts.append(cur)
                cur = ''
            else:
                cur += c
        if not c.isspace():
            prev_ns = c
    if cur.strip():
        parts.append(cur)
    return parts


def _split_kv(s):
    depth = 0
    q = None
    esc = False
    prev_ns = None
    for idx, c in enumerate(s):
        if q:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == q:
                q = None
        else:
            if c in '"\'':  # 引号
                if _quote_opens(prev_ns):
                    q = c
            elif c in '{[':
                depth += 1
            elif c in '}]':
                depth -= 1
            elif c == ':' and depth == 0:
                return s[:idx].strip(), s[idx + 1:].strip()
        if not c.isspace():
            prev_ns = c
    return s.strip(), None


def _num(s):
    if re.match(r'^-?\d+$', s):
        try:
            return int(s)
        except ValueError:
            return s
    if re.match(r'^-?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$', s) or re.match(
            r'^-?\d+[eE][-+]?\d+$', s):
        try:
            return float(s)
        except ValueError:
            return s
    return s


def parse_scalar(s):
    s = s.strip()
    if s == '':
        return None
    if s[0] == '{':
        inner = s[1:-1] if s.endswith('}') else s[1:]
        d = {}
        for part in _split_top(inner):
            k, v = _split_kv(part)
            if k:
                d[k] = parse_scalar(v) if v is not None else None
        return d
    if s[0] == '[':
        inner = s[1:-1] if s.endswith(']') else s[1:]
        return [parse_scalar(x) for x in _split_top(inner)]
    if s[0] == '"':
        try:
            return json.loads(s)
        except Exception:
            return s.strip('"')
    if s[0] == "'":
        body = s[1:-1] if s.endswith("'") else s[1:]
        return body.replace("''", "'")
    if s in ('~', 'null', 'Null', 'NULL'):
        return None
    return _num(s)


def _assign(lines, i, indent, val):
    if val != '':
        return parse_scalar(val), i
    if i < len(lines):
        ni = lines[i][0]
        if ni > indent:
            return parse_block(lines, i, ni)
        if ni == indent and (lines[i][1] == '-' or lines[i][1].startswith('- ')):
            return parse_seq(lines, i, indent)
    return None, i


def parse_map(lines, i, indent, seed=None):
    out = {}
    if seed is not None:
        k, v = _split_kv(seed)
        out[k] = None
        out[k], i = _assign(lines, i, indent, v if v is not None else '')
    while i < len(lines) and lines[i][0] == indent:
        content = lines[i][1]
        if content == '-' or content.startswith('- '):
            break
        if not _is_mapping_line(content) and ':' not in content:
            break
        k, v = _split_kv(content)
        if v is None:
            v = ''
        i += 1
        out[k], i = _assign(lines, i, indent, v)
    return out, i


def parse_seq(lines, i, indent):
    out = []
    while i < len(lines) and lines[i][0] == indent and (
            lines[i][1] == '-' or lines[i][1].startswith('- ')):
        rest = lines[i][1][1:].strip()
        i += 1
        if rest == '':
            if i < len(lines) and lines[i][0] > indent:
                v, i = parse_block(lines, i, lines[i][0])
            else:
                v = None
            out.append(v)
        elif _is_mapping_line(rest):
            v, i = parse_map(lines, i, indent + 2, seed=rest)
            out.append(v)
        else:
            out.append(parse_scalar(rest))
    return out, i


def parse_block(lines, i, indent):
    if i >= len(lines) or lines[i][0] != indent:
        return None, i
    if lines[i][1] == '-' or lines[i][1].startswith('- '):
        return parse_seq(lines, i, indent)
    return parse_map(lines, i, indent)


def parse_body(text):
    """解析一个 Unity 对象体（去掉 --- 头之后）。返回 {TypeName: {...}} 或 {...}。"""
    lines = logical_lines(text)
    if not lines:
        return None
    val, _ = parse_block(lines, 0, lines[0][0])
    return val


def body_root(body):
    d = parse_body(body)
    if isinstance(d, dict) and len(d) == 1:
        return next(iter(d.values()))
    return d


def split_objects(text):
    ms = list(OBJ_HEADER_RE.finditer(text))
    objs = []
    for k, m in enumerate(ms):
        end = ms[k + 1].start() if k + 1 < len(ms) else len(text)
        objs.append((m.group(1), m.group(2), 'stripped' in m.group(0), text[m.end():end]))
    return objs


# --------------------------------------------------------------------------- #
# 工程扫描基础设施
# --------------------------------------------------------------------------- #
def uopen(path):
    return open(path, 'r', encoding='utf-8', errors='replace')


def read_text(path):
    with uopen(path) as f:
        return f.read()


def proj_rel(proj, path):
    try:
        return os.path.relpath(path, proj)
    except ValueError:
        return path


def scan_roots(proj):
    for base in SCAN_ROOTS:
        root = os.path.join(proj, base)
        if os.path.isdir(root):
            yield base, root


def iter_files(proj, exts=None):
    for base, root in scan_roots(proj):
        for dp, dn, fn in os.walk(root):
            dn[:] = [d for d in dn if d not in SKIP_DIR_NAMES]
            for f in fn:
                if exts is None or f.lower().endswith(exts):
                    yield os.path.join(dp, f)


def build_guid_index(proj, skipped):
    idx = {}
    collisions = defaultdict(list)
    for base, root in scan_roots(proj):
        for dp, dn, fn in os.walk(root):
            dn[:] = [d for d in dn if d not in SKIP_DIR_NAMES]
            for f in fn:
                if not f.endswith('.meta'):
                    continue
                p = os.path.join(dp, f)
                try:
                    with uopen(p) as fh:
                        head = fh.read(512)
                except OSError:
                    continue
                m = GUID_LINE_RE.search(head)
                if not m:
                    continue
                g = m.group(1).lower()
                asset = p[:-5]
                if g in idx and idx[g] != asset:
                    collisions[g].append(asset)
                else:
                    idx[g] = asset
    return idx, collisions


def top_keys(body):
    return set(TOPKEY_RE.findall(body))


def classify_mob(script_fid, script_guid, body, guid_idx):
    """返回 (类型名, dll文件名或None)。"""
    src = guid_idx.get((script_guid or '').lower())
    if src and src.endswith('.cs'):
        return os.path.splitext(os.path.basename(src))[0], None
    keys = top_keys(body)
    for name, req, req_sub, forb, forb_sub in DLL_FIELD_RULES:
        if any(k not in keys for k in req):
            continue
        if any(x not in body for x in req_sub):
            continue
        if any(k in keys for k in forb):
            continue
        if any(x in body for x in forb_sub):
            continue
        return name, None
    if src and src.endswith('.dll'):
        return 'dll:%s:%s' % (os.path.basename(src), script_fid), os.path.basename(src)
    if script_guid:
        return 'dll:%s:%s' % (script_guid, script_fid), None
    return 'MissingScript:%s' % script_fid, None


EMPTY_STATS = lambda: {'files': 0, 'bytes': 0, 'mtime_min': None, 'mtime_max': None}


def bump_stats(st, path):
    st['files'] += 1
    try:
        sz = os.path.getsize(path)
        mt = os.path.getmtime(path)
    except OSError:
        return
    st['bytes'] += sz
    if st['mtime_min'] is None or mt < st['mtime_min']:
        st['mtime_min'] = mt
    if st['mtime_max'] is None or mt > st['mtime_max']:
        st['mtime_max'] = mt


def assets_top(proj):
    root = os.path.join(proj, 'Assets')
    if not os.path.isdir(root):
        return []
    out = []
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if not os.path.isdir(p):
            continue
        st = EMPTY_STATS()
        direct = 0
        for dp, dn, fn in os.walk(p):
            dn[:] = [d for d in dn if d not in SKIP_DIR_NAMES]
            for f in fn:
                bump_stats(st, os.path.join(dp, f))
                if dp == p:
                    direct += 1
        entry = {'name': name, 'level': 1, 'files': st['files'], 'bytes': st['bytes'],
                 'mtime_min': st['mtime_min'], 'mtime_max': st['mtime_max']}
        # 顶层只是分组目录（自身不含文件）时，给二级目录明细
        if direct == 0:
            subs = []
            for sub in sorted(os.listdir(p)):
                sp = os.path.join(p, sub)
                if not os.path.isdir(sp):
                    continue
                s2 = EMPTY_STATS()
                for dp, dn, fn in os.walk(sp):
                    dn[:] = [d for d in dn if d not in SKIP_DIR_NAMES]
                    for f in fn:
                        bump_stats(s2, os.path.join(dp, f))
                subs.append({'name': '%s/%s' % (name, sub), 'level': 2, 'files': s2['files'],
                             'bytes': s2['bytes'], 'mtime_min': s2['mtime_min'],
                             'mtime_max': s2['mtime_max']})
            entry['subdirs'] = subs
        out.append(entry)
    return out


# --------------------------------------------------------------------------- #
# 场景
# --------------------------------------------------------------------------- #
def all_name_overrides(body):
    out = []
    for m in re.finditer(r'propertyPath: m_Name\s*\n\s+value: (.*?)\s*\n', body):
        out.append(m.group(1).strip())
    return out


def prefab_closure_has_descriptor(path, prefab_info, guid_idx, memo):
    if path in memo:
        return memo[path]
    memo[path] = False
    if not path.lower().endswith(('.prefab', '.unity')):
        return False  # .fbx 等二进制模型没有可读的 YAML 描述器
    info = prefab_info.get(path)
    if info is None:
        try:
            if os.path.getsize(path) > MAX_FILE_BYTES:
                return False
            text = read_text(path)
        except OSError:
            return False
        info = {'desc': bool(re.search(r'^  baseAnimationLayers:', text, re.M)),
                'sources': [guid_idx.get(g.lower()) for g in PREFAB_SRC_RE.findall(text)]}
        prefab_info[path] = info
    if info.get('desc'):
        memo[path] = True
        return True
    for sp in info.get('sources', []):
        if sp and prefab_closure_has_descriptor(sp, prefab_info, guid_idx, memo):
            memo[path] = True
            return True
    return False


def parse_scene(proj, path, guid_idx, prefab_info, desc_memo, skipped):
    text = read_text(path)
    objs = split_objects(text)
    by_id = {fid: (cid, stripped, body) for cid, fid, stripped, body in objs}
    pi = {}       # fileID -> body (classID 1001)
    go = {}       # fileID -> body (classID 1)
    tr = {}       # fileID -> body (classID 4)
    for cid, fid, stripped, body in objs:
        if cid == '1001':
            pi[fid] = body
        elif cid == '1':
            go[fid] = body
        elif cid == '4':
            tr[fid] = body

    # m_Roots
    roots_raw = []
    mr = re.search(r'm_Roots:\n((?:  - \{fileID: -?\d+\}\n?)*)', text)
    if mr:
        roots_raw = re.findall(r'fileID: (-?\d+)', mr.group(1))

    # PI -> source prefab path / name overrides
    pi_src = {}
    pi_names = {}
    for fid, body in pi.items():
        m = PREFAB_SRC_RE.search(body)
        if m:
            pi_src[fid] = guid_idx.get(m.group(1).lower())
        pi_names[fid] = all_name_overrides(body)

    def go_name_from_body(gbody):
        m = re.search(r'\n  m_Name: (.*)', gbody)
        if m is not None:
            return m.group(1).strip()
        return None

    def name_of_root_fileid(rid):
        if rid in go:
            b = go[rid]
            nm = go_name_from_body(b)
            cs = PSOURCE_GO_RE.search(b)
            piid = None
            mm = PINSTANCE_RE.search(b)
            if mm:
                piid = mm.group(1)
            if nm is None and piid and pi_names.get(piid):
                return pi_names[piid][0]
            if nm is None and cs:
                return '%s#%s' % (os.path.basename(pi_src.get(piid) or 'prefab'), cs.group(1))
            return nm
        if rid in tr:
            m = re.search(r'm_GameObject: \{fileID: (-?\d+)\}', tr[rid])
            if m and m.group(1) in go:
                return name_of_root_fileid(m.group(1))
        if rid in pi:
            names = pi_names.get(rid) or []
            if names:
                return names[0]
            src = pi_src.get(rid)
            return os.path.basename(src) if src else '(prefab instance %s)' % rid
        return '(unknown %s)' % rid

    root_names = [name_of_root_fileid(r) for r in roots_raw]

    # descriptor instances
    desc_objs = []
    for cid, fid, stripped, body in objs:
        if cid == '114' and re.search(r'^  baseAnimationLayers:', body, re.M) \
                and re.search(r'^  expressionsMenu:', body, re.M):
            mg = re.search(r'm_GameObject: \{fileID: (-?\d+)\}', body)
            nm = name_of_root_fileid(mg.group(1)) if mg else None
            if nm is None and mg:
                gb = go.get(mg.group(1)) or ''
                cs = PSOURCE_GO_RE.search(gb)
                if cs:
                    src = guid_idx.get(cs.group(2).lower())
                    if src:
                        nm = os.path.splitext(os.path.basename(src))[0]
            desc_objs.append(nm or '(unnamed)')
    for fid, body in pi.items():
        src = pi_src.get(fid)
        if not src:
            continue
        if prefab_closure_has_descriptor(src, prefab_info, guid_idx, desc_memo):
            names = pi_names.get(fid) or []
            label = names[0] if names else os.path.basename(src)
            desc_objs.append(label)

    prefab_sources = sorted({os.path.relpath(s, proj) for s in pi_src.values() if s})
    return {
        'path': os.path.relpath(path, proj),
        'scope': os.path.relpath(path, proj).split(os.sep)[0],
        'bytes': os.path.getsize(path),
        'mtime': os.path.getmtime(path),
        'roots': root_names,
        'descriptor_objects': desc_objs,
        'prefab_sources': prefab_sources,
        'prefab_instance_count': len(pi),
    }


# --------------------------------------------------------------------------- #
# 控制器 / 菜单 / 参数 / 动画 / 材质
# --------------------------------------------------------------------------- #
def parse_controller(proj, path):
    text = read_text(path)
    objs = split_objects(text)
    sm_states = {}
    sm_child_sm = {}
    for cid, fid, stripped, body in objs:
        if cid == '1107':
            sm_states[fid] = re.findall(r'm_State: \{fileID: (-?\d+)\}', body)
            sm_child_sm[fid] = re.findall(r'm_ChildStateMachines:\s*\n((?:\s+-.*\n)*)', body)
    # flatten child state machine refs
    child_list = {}
    for cid, fid, stripped, body in objs:
        if cid == '1107':
            blk = re.search(r'm_ChildStateMachines:\n((?:  -.*\n(?:    .*\n)*)*)', body)
            refs = re.findall(r'm_StateMachine: \{fileID: (-?\d+)\}', blk.group(1)) if blk else []
            child_list[fid] = refs

    def count_states(smid, seen):
        if not smid or smid in seen:
            return 0
        seen.add(smid)
        n = len(sm_states.get(smid, []))
        for ch in child_list.get(smid, []):
            n += count_states(ch, seen)
        return n

    layers = []
    params = []
    for cid, fid, stripped, body in objs:
        if cid != '91':
            continue
        root = body_root(body) or {}
        for p in (root.get('m_AnimatorParameters') or []):
            if not isinstance(p, dict):
                continue
            t = p.get('m_Type')
            params.append({'name': p.get('m_Name'),
                           'type': ANIM_PARAM_TYPES.get(t, 'Unknown(%s)' % t),
                           'type_id': t})
        for L in (root.get('m_AnimatorLayers') or []):
            if not isinstance(L, dict):
                continue
            smref = L.get('m_StateMachine') or {}
            smid = str(smref.get('fileID')) if isinstance(smref, dict) else None
            bm = L.get('m_BlendingMode')
            layers.append({
                'name': L.get('m_Name'),
                'default_weight': L.get('m_DefaultWeight'),
                'states': count_states(smid, set()) if smid else 0,
                'blending_mode': bm,
                'blending_mode_name': BLEND_MODE_NAMES.get(bm, 'Unknown(%s)' % bm),
                'additive': bm == 1,
                'synced_layer_index': L.get('m_SyncedLayerIndex'),
                'ik_pass': L.get('m_IKPass'),
            })
    return {'path': os.path.relpath(path, proj), 'bytes': os.path.getsize(path),
            'mtime': os.path.getmtime(path), 'layer_count': len(layers),
            'param_count': len(params), 'layers': layers, 'parameters': params}


def parse_menu_asset(proj, path):
    text = read_text(path)
    objs = split_objects(text)
    menus = []
    params = []
    for cid, fid, stripped, body in objs:
        if cid != '114':
            continue
        keys = top_keys(body)
        if 'controls' in keys:
            root = body_root(body) or {}
            ctrls = []
            for c in (root.get('controls') or []):
                if not isinstance(c, dict):
                    continue
                p = c.get('parameter') or {}
                sm = c.get('subMenu') or {}
                ctrls.append({
                    'name': c.get('name'),
                    'type': MENU_CONTROL_TYPES.get(c.get('type'), 'Unknown(%s)' % c.get('type')),
                    'type_id': c.get('type'),
                    'parameter': p.get('name') if isinstance(p, dict) else None,
                    'submenu_guid': sm.get('guid') if isinstance(sm, dict) else None,
                })
            menus.append({'path': os.path.relpath(path, proj), 'name': root.get('m_Name'),
                          'control_count': len(ctrls), 'controls': ctrls})
        elif 'parameters' in keys and 'isEmpty' in keys:
            root = body_root(body) or {}
            plist = []
            bits = 0
            for p in (root.get('parameters') or []):
                if not isinstance(p, dict):
                    continue
                vt = p.get('valueType')
                sync = p.get('networkSynced')
                b = 0
                if sync:
                    b = 8 if vt in (0, 1) else 1
                bits += b
                plist.append({'name': p.get('name'), 'value_type': PARAM_VALUE_TYPES.get(vt, 'Unknown(%s)' % vt),
                              'value_type_id': vt, 'saved': p.get('saved'),
                              'default': p.get('defaultValue'), 'network_synced': sync,
                              'sync_bits': b})
            params.append({'path': os.path.relpath(path, proj), 'name': root.get('m_Name'),
                           'param_count': len(plist), 'sync_bits': bits, 'parameters': plist})
    return menus, params


def scan_anim(proj, path):
    """用逻辑行 + 缩进追踪，避免为每帧采样建对象。"""
    text = read_text(path)
    lines = logical_lines(text)
    groups = {'m_FloatCurves': 'float', 'm_PositionCurves': 'position', 'm_ScaleCurves': 'scale',
              'm_EulerCurves': 'euler', 'm_RotationCurves': 'rotation',
              'm_CompressedRotationCurves': 'compressed_rotation'}
    name = None
    cur = None
    child_indent = None
    counts = Counter()
    shapes = []  # (shape_name, path)
    pending_attr = None
    for indent, content in lines:
        if indent == 2:
            m = re.match(r'^m_Name: (.*)$', content)
            if m:
                name = parse_scalar(m.group(1))
            mk = re.match(r'^(m_\w+):\s*$', content)
            if mk and mk.group(1) in groups:
                cur = groups[mk.group(1)]
                child_indent = None
                pending_attr = None
                continue
            if content and not content.startswith('-') and re.match(r'^m_\w+:', content):
                cur = None
        if cur is None:
            continue
        if child_indent is None and (content == '-' or content.startswith('- ')):
            child_indent = indent
        if cur == 'float':
            ma = re.match(r'^attribute: (.*)$', content)
            if ma:
                pending_attr = parse_scalar(ma.group(1))
                continue
            mp = re.match(r'^path: (.*)$', content)
            if mp and pending_attr is not None:
                p = parse_scalar(mp.group(1))
                if pending_attr.startswith('blendShape.'):
                    counts['shapekey'] += 1
                    shapes.append((pending_attr[len('blendShape.'):], p))
                elif pending_attr == 'm_IsActive':
                    counts['visibility'] += 1
                elif pending_attr == 'm_Enabled':
                    counts['enabled'] += 1
                elif 'm_Materials' in pending_attr:
                    counts['material'] += 1
                elif pending_attr.startswith(('m_LocalPosition', 'm_LocalRotation', 'm_LocalScale',
                                              'm_LocalEulerAngles', 'localEulerAnglesRaw')):
                    counts['transform'] += 1
                else:
                    counts['other'] += 1
                pending_attr = None
        else:
            if content == '-' or (content.startswith('- ') and indent == child_indent):
                counts['transform'] += 1
    total_entries = sum(counts.values())
    return {'path': os.path.relpath(path, proj), 'name': name, 'bytes': os.path.getsize(path),
            'counts': dict(counts), 'total_curves': total_entries, 'shape_curves': shapes}


def scan_material(proj, path, guid_idx):
    try:
        text = read_text(path)
    except OSError:
        return None
    obj = None
    for cid, fid, stripped, body in split_objects(text):
        if cid == '21':
            obj = body_root(body) or {}
            break
    if obj is None:
        obj = body_root(text) or {}
    sh = obj.get('m_Shader') if isinstance(obj, dict) else None
    if isinstance(sh, dict):
        fid = sh.get('fileID')
        g = (sh.get('guid') or '').lower()
    else:
        fid, g = None, ''
    src = guid_idx.get(g) if g else None
    if src:
        shader = os.path.splitext(os.path.basename(src))[0]
    elif fid in BUILTIN_SHADER_NAMES:
        shader = BUILTIN_SHADER_NAMES[fid]
    elif g and set(g) == {'0'}:
        shader = 'builtin:%s' % fid
    elif fid is not None:
        shader = 'builtin:%s' % fid
    else:
        shader = 'unknown'
    return {'name': obj.get('m_Name') if isinstance(obj, dict) else None, 'shader': shader}


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def fingerprint(proj, log=print):
    t0 = time.time()
    proj = os.path.abspath(proj)
    skipped = []
    guid_idx, collisions = build_guid_index(proj, skipped)
    log('  guids: %d (collisions %d)' % (len(guid_idx), len(collisions)))

    # --- 逐文件：组件、形态键改、预制体信息 ---
    comp_all = Counter()
    comp_assets = Counter()
    comp_special = defaultdict(Counter)
    shape_changers = []
    other_shape_comps = Counter()
    other_shape_examples = []
    prefab_info = {}
    desc_memo = {}
    anim_files = []
    mat_shader = Counter()
    mat_count = 0
    assets_mob_total = 0
    packages_mob_total = 0

    desc_refs = []
    stripped_skipped = 0
    for f in iter_files(proj):
        ext = os.path.splitext(f)[1].lower()
        if ext not in YAML_EXTS:
            continue
        try:
            sz = os.path.getsize(f)
        except OSError:
            continue
        if sz > MAX_FILE_BYTES:
            skipped.append({'path': proj_rel(proj, f), 'reason': 'size>30MB', 'bytes': sz})
            continue
        scope = proj_rel(proj, f).split(os.sep)[0]
        try:
            if ext == '.anim':
                anim_files.append(f)
                continue
            if ext == '.controller':
                continue
            if ext == '.mat':
                continue
            if ext == '.asset':
                with open(f, 'rb') as fh:
                    head = fh.read(65536)
                if not any(m in head for m in ASSET_PREFILTER):
                    continue
            text = read_text(f)
        except (OSError, UnicodeError) as e:
            skipped.append({'path': proj_rel(proj, f), 'reason': 'read-error: %s' % e})
            continue
        if ext == '.asset':
            try:
                menus, params = parse_menu_asset(proj, f)
            except Exception as e:
                skipped.append({'path': proj_rel(proj, f), 'reason': 'parse-error: %s' % e})
                continue
            # menus/params 收集在下面 expression 阶段用，这里仅记入 prefab_info 无关
            for m in menus:
                _MENUS.append((scope, m))
            for p in params:
                _PARAMS.append((scope, p))
            continue
        try:
            objs = split_objects(text)
        except Exception as e:
            skipped.append({'path': proj_rel(proj, f), 'reason': 'parse-error: %s' % e})
            continue
        file_has_desc = False
        file_sources = []
        for cid, fid, stripped, body in objs:
            if stripped:
                # `--- !u!NNN &id stripped` 是预制体引用占位（组件本体在源预制体里），
                # 不是场景里的新实例；计入会与源预制体重复。
                stripped_skipped += 1
                continue
            if cid == '114':
                if re.search(r'^  baseAnimationLayers:', body, re.M) and \
                        re.search(r'^  expressionsMenu:', body, re.M):
                    file_has_desc = True
                sm = SCRIPT_RE.search(body)
                if sm:
                    sfid, sg = sm.group(1), sm.group(2).lower()
                    tname, dllname = classify_mob(sfid, sg, body, guid_idx)
                else:
                    tname, dllname = 'MissingScript:?', None
                comp_all[tname] += 1
                if scope == 'Assets':
                    comp_assets[tname] += 1
                    assets_mob_total += 1
                else:
                    packages_mob_total += 1
                low = tname.lower()
                if tname.startswith('ModularAvatar'):
                    comp_special['modular_avatar'][tname] += 1
                if tname.startswith('VRCFury') or tname.startswith('VF'):
                    comp_special['vrcfury'][tname] += 1
                if tname in ('VRCPhysBone', 'VRCPhysBoneCollider'):
                    comp_special['physbone'][tname] += 1
                if any(k in tname for k in ('BlendShape', 'Blendshape', 'ShapeChanger', 'Shrink')):
                    other_shape_comps[tname] += 1
                    if len(other_shape_examples) < 60:
                        other_shape_examples.append({'type': tname, 'file': proj_rel(proj, f)})
                # AAO 靠源码包路径识别
                src = guid_idx.get(sg) if sm else None
                if src and ('anatawa12.avatar-optimizer' in src.replace('\\', '/')
                            or 'avataroptimizer' in src.replace('\\', '/').lower()):
                    comp_special['aao'][tname] += 1
                elif tname in AAO_CLASS_NAMES:
                    comp_special['aao'][tname] += 1
                # 形态键改组件
                if tname == 'ModularAvatarShapeChanger' or ('m_shapes' in body and 'ShapeName' in body):
                    sc = parse_shape_changer(proj, f, fid, body, objs, guid_idx, scope)
                    if sc:
                        shape_changers.append(sc)
                # 头像描述器引用的菜单/参数资产（口径用：描述器实际引用的 params 与全量不同）
                if re.search(r'^  baseAnimationLayers:', body, re.M) and \
                        re.search(r'^  expressionsMenu:', body, re.M):
                    def _ref(key):
                        m = re.search(r'^  %s: \{fileID: -?\d+, guid: ([0-9a-fA-F]+)' % key,
                                      body, re.M)
                        if not m:
                            return None, None
                        pth = guid_idx.get(m.group(1).lower())
                        return m.group(1).lower(), proj_rel(proj, pth) if pth else None
                    mguid, mpath = _ref('expressionsMenu')
                    pguid, ppath = _ref('expressionParameters')
                    desc_refs.append({'file': proj_rel(proj, f), 'menu_guid': mguid,
                                      'menu_path': mpath, 'params_guid': pguid,
                                      'params_path': ppath})
            elif cid == '1':
                pass
            elif cid == '1001':
                for g in PREFAB_SRC_RE.findall(body):
                    sp = guid_idx.get(g.lower())
                    if sp:
                        file_sources.append(sp)
        if ext == '.prefab':
            prefab_info[f] = {'desc': file_has_desc, 'sources': file_sources}

    # --- 控制器 ---
    log('  controllers...')
    controllers = []
    for f in iter_files(proj, ('.controller',)):
        if os.path.getsize(f) > MAX_FILE_BYTES:
            skipped.append({'path': proj_rel(proj, f), 'reason': 'size>30MB',
                            'bytes': os.path.getsize(f)})
            continue
        try:
            controllers.append(parse_controller(proj, f))
        except Exception as e:
            skipped.append({'path': proj_rel(proj, f), 'reason': 'parse-error: %s' % e})

    # --- 菜单与参数（含 .prefab/.unity 内的 VRC 资产） ---
    log('  expression assets...')
    for f in iter_files(proj, ('.prefab', '.unity')):
        if os.path.getsize(f) > MAX_FILE_BYTES:
            continue
        try:
            text = read_text(f)
        except OSError:
            continue
        if 'controls:' not in text and 'isEmpty:' not in text and 'fileID: -1506855854' not in text:
            continue
        try:
            menus, params = parse_menu_asset(proj, f)
        except Exception:
            continue
        scope = proj_rel(proj, f).split(os.sep)[0]
        for m in menus:
            _MENUS.append((scope, m))
        for p in params:
            _PARAMS.append((scope, p))

    # --- 动画 ---
    log('  animations (%d files)...' % len(anim_files))
    anim_total = len(anim_files)
    curve_cat = Counter()
    shape_clip = defaultdict(lambda: {'clips': [], 'count': 0})
    anim_errors = 0
    for f in anim_files:
        try:
            if os.path.getsize(f) > MAX_FILE_BYTES:
                skipped.append({'path': proj_rel(proj, f), 'reason': 'size>30MB',
                                'bytes': os.path.getsize(f)})
                continue
            a = scan_anim(proj, f)
        except Exception as e:
            anim_errors += 1
            skipped.append({'path': proj_rel(proj, f), 'reason': 'parse-error: %s' % e})
            continue
        for k, v in a['counts'].items():
            curve_cat[k] += v
        for sname, spath in a['shape_curves']:
            rec = shape_clip[sname]
            rec['count'] += 1
            if a['path'] not in rec['clips']:
                if len(rec['clips']) < 200:
                    rec['clips'].append(a['path'])
                else:
                    rec['truncated'] = True
    top_shapes = sorted(shape_clip.items(), key=lambda kv: (-kv[1]['count'], kv[0]))[:200]

    # --- 材质 ---
    log('  materials...')
    for f in iter_files(proj, ('.mat',)):
        if os.path.getsize(f) > MAX_FILE_BYTES:
            skipped.append({'path': proj_rel(proj, f), 'reason': 'size>30MB',
                            'bytes': os.path.getsize(f)})
            continue
        try:
            m = scan_material(proj, f, guid_idx)
        except Exception as e:
            skipped.append({'path': proj_rel(proj, f), 'reason': 'parse-error: %s' % e})
            continue
        mat_count += 1
        if m:
            mat_shader[m['shader']] += 1

    # --- 自定义脚本 ---
    log('  scripts...')
    custom = scan_scripts(proj)

    # --- 场景 ---
    log('  scenes...')
    scenes = []
    for f in iter_files(proj, ('.unity',)):
        if os.path.getsize(f) > MAX_FILE_BYTES:
            skipped.append({'path': proj_rel(proj, f), 'reason': 'size>30MB',
                            'bytes': os.path.getsize(f)})
            continue
        try:
            scenes.append(parse_scene(proj, f, guid_idx, prefab_info, desc_memo, skipped))
        except Exception as e:
            skipped.append({'path': proj_rel(proj, f), 'reason': 'parse-error: %s' % e})

    # --- 工程元信息 ---
    project = read_project_meta(proj)

    # --- 汇总 ---
    sc_counts = Counter()
    sc_scene_counts = Counter()
    for sc in shape_changers:
        if sc['scope'] == 'Assets':
            sc_counts['Assets'] += 1
        else:
            sc_counts['Packages'] += 1
        if sc['file'].endswith('.unity'):
            sc_scene_counts[sc['file']] += 1
    result = {
        'meta': {
            'tool': 'project_fingerprint.py',
            'tool_version': TOOL_VERSION,
            'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'project_path': proj,
            'runtime_seconds': round(time.time() - t0, 3),
            'scope': 'Assets+Packages',
            'max_file_bytes': MAX_FILE_BYTES,
            'guid_count': len(guid_idx),
            'guid_collisions': {g: v for g, v in list(collisions.items())[:50]},
            'stripped_objects_skipped': stripped_skipped,
        },
        'dll_script_rules': {
            'note': 'MonoBehaviour 的 m_Script.fileID != 11500000 时按下列序列化字段特征判型；'
                    '未命中的记 dll:<dll文件名>:<fileID>。',
            'rules': [
                {'type': n, 'require_top_keys': r, 'require_substrings': rs,
                 'forbid_top_keys': fb, 'forbid_substrings': fbs}
                for (n, r, rs, fb, fbs) in DLL_FIELD_RULES
            ],
        },
        'project': project,
        'assets_top': assets_top(proj),
        'scenes': scenes,
        'components': {
            'mob_total_all': sum(comp_all.values()),
            'mob_total_assets': assets_mob_total,
            'mob_total_packages': packages_mob_total,
            'counts': dict(sorted(comp_all.items(), key=lambda kv: kv[0])),
            'counts_assets_only': dict(sorted(comp_assets.items(), key=lambda kv: kv[0])),
            'special': {k: dict(sorted(v.items(), key=lambda kv: (-kv[1], kv[0])))
                        for k, v in comp_special.items()},
        },
        'controllers': sorted(controllers, key=lambda c: c['path']),
        'expression': {
            'menus': [m for _, m in sorted(_MENUS, key=lambda x: x[1]['path'])],
            'parameters': [p for _, p in sorted(_PARAMS, key=lambda x: x[1]['path'])],
            'vrc_sync_bits_total': sum(p['sync_bits'] for _, p in _PARAMS),
            'vrc_param_count_total': sum(p['param_count'] for _, p in _PARAMS),
            'descriptor_refs': desc_refs,
        },
        'animations': {
            'total': anim_total,
            'parse_errors': anim_errors,
            'curve_categories': dict(curve_cat),
            'shapekeys': [{'name': k, 'count': v['count'], 'clips': v['clips'],
                           'clips_truncated': bool(v.get('truncated'))}
                          for k, v in top_shapes],
            'shapekey_name_total': len(shape_clip),
        },
        'shape_changers': {
            'component_count_total': len(shape_changers),
            'by_scope': dict(sc_counts),
            'by_scene': dict(sc_scene_counts),
            'entries': shape_changers,
            'other_shape_related_counts': dict(sorted(other_shape_comps.items(),
                                                      key=lambda kv: (-kv[1], kv[0]))),
            'other_shape_related_examples': other_shape_examples,
        },
        'materials': {'total': mat_count, 'by_shader': dict(sorted(mat_shader.items(),
                                                                   key=lambda kv: (-kv[1], kv[0])))},
        'custom_scripts': custom,
        'root_docs': scan_root_docs(proj),
        'skipped': skipped,
    }
    result['meta']['runtime_seconds'] = round(time.time() - t0, 3)
    return result


_MENUS = []
_PARAMS = []


def parse_shape_changer(proj, path, fid, body, objs, guid_idx, scope):
    root = body_root(body) or {}
    if not isinstance(root, dict):
        return None
    mg = re.search(r'm_GameObject: \{fileID: (-?\d+)\}', body)
    go_name = None
    go_src = None
    if mg:
        gid = mg.group(1)
        for cid, ofid, stripped, ob in objs:
            if cid == '1' and ofid == gid:
                mm = re.search(r'\n  m_Name: (.*)', ob)
                if mm is not None:
                    go_name = mm.group(1).strip()
                else:
                    cs = PSOURCE_GO_RE.search(ob)
                    if cs:
                        src = guid_idx.get(cs.group(2).lower())
                        go_src = proj_rel(proj, src) if src else None
                        go_name = resolve_prefab_go_name(src, cs.group(1), guid_idx, set())
                        if go_name is None and src:
                            go_name = os.path.splitext(os.path.basename(src))[0]
                break
    shapes = []
    for s in (root.get('m_shapes') or []):
        if not isinstance(s, dict):
            continue
        obj = s.get('Object') or {}
        tgt = obj.get('targetObject') if isinstance(obj, dict) else None
        shapes.append({
            'reference_path': obj.get('referencePath') if isinstance(obj, dict) else None,
            'target_object_fileid': tgt.get('fileID') if isinstance(tgt, dict) else None,
            'target_object_guid': tgt.get('guid') if isinstance(tgt, dict) else None,
            'shape_name': s.get('ShapeName'),
            'change_type': s.get('ChangeType'),
            'value': s.get('Value'),
        })
    return {'file': proj_rel(proj, path), 'scope': scope, 'component_fileid': fid,
            'gameobject': go_name, 'gameobject_source_prefab': go_src,
            'shape_count': len(shapes), 'shapes': shapes}


def resolve_prefab_go_name(path, fileid, guid_idx, seen):
    if not path or path in seen:
        return None
    if not path.lower().endswith(('.prefab', '.unity')):
        return None
    seen.add(path)
    try:
        if os.path.getsize(path) > MAX_FILE_BYTES:
            return None
        text = read_text(path)
    except OSError:
        return None
    for cid, fid, stripped, body in split_objects(text):
        if cid == '1' and fid == fileid:
            m = re.search(r'\n  m_Name: (.*)', body)
            if m is not None:
                return m.group(1).strip()
            cs = PSOURCE_GO_RE.search(body)
            if cs:
                return resolve_prefab_go_name(guid_idx.get(cs.group(2).lower()), cs.group(1),
                                              guid_idx, seen)
            return None
    # variant: 到 base prefab 里找
    for cid, fid, stripped, body in split_objects(text):
        if cid == '1001':
            m = PREFAB_SRC_RE.search(body)
            if m:
                return resolve_prefab_go_name(guid_idx.get(m.group(1).lower()), fileid,
                                              guid_idx, seen)
    return None


def scan_scripts(proj):
    root = os.path.join(proj, 'Assets')
    scripts = []
    editor_count = 0
    custom_count = 0
    if not os.path.isdir(root):
        return {'total': 0, 'custom': 0, 'editor_custom': 0, 'scripts': []}
    for dp, dn, fn in os.walk(root):
        dn[:] = [d for d in dn if d not in SKIP_DIR_NAMES]
        for f in fn:
            if not f.lower().endswith('.cs'):
                continue
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, proj)
            segs = rel.split(os.sep)[1:]
            cls = None
            try:
                with uopen(p) as fh:
                    for i, line in enumerate(fh):
                        if i > 400:
                            break
                        m = re.search(r'\b(class|struct|interface|enum)\s+([A-Za-z_]\w*)', line)
                        if m:
                            cls = m.group(2)
                            break
            except OSError:
                pass
            in_editor = any(s == 'Editor' for s in segs[:-1]) or '/Editor/' in rel
            vendor = is_vendor_script(proj, rel)
            if in_editor:
                editor_count += 1
            if not vendor:
                custom_count += 1
            scripts.append({'path': rel, 'class': cls, 'in_editor': in_editor, 'vendor': vendor})
    return {'total': len(scripts), 'custom': custom_count, 'editor_all': editor_count,
            'scripts': sorted(scripts, key=lambda s: s['path'])}


VENDOR_MARKERS = (
    'nadena', 'modular-avatar', 'modularavatar', 'vrcfury', 'anatawa12', 'avatar-optimizer',
    'avataroptimizer', 'lilxyzw', 'liltoon', 'thryrallo', 'an-labo', 'triturbo', 'yueby',
    'mekoko', 'blackstartx', 'lightlimit', 'light-limit', 'gogoloco', 'mdnail',
    'avatarperformancetools', 'avatar-performance-tools', 'gesture-manager', 'gesturemanager',
    'poiyomi', 'dismay', 'logilabo', 'zerofactory', 'rimoshop', 'meltylily', 'arca-works',
    'ikusia', 'cumulus', 'forelise', 'fumitikishop', 'hino shop', 'kuhaku', 'obscura',
    'pirouette', 'plumarium', 'mana-apparel', 'oseiso', 'sangoustudio', 'shinano',
    'knives design', 'rosi atelier', "wako's atelier", 'cresveil', 'killya', 'knya',
    'adameve', 'luceunare', 'mito kumo', 'mariyuri', 'plusone', 'calicotte', 'eden oasis',
    'lovace', '00capettiya', '4o4o', 'chocolate rice', 'noem', 'atelier rsche', 'alice',
)


def _has_package_json_ancestor(proj, path):
    d = os.path.dirname(path)
    assets = os.path.join(proj, 'Assets')
    while d.startswith(assets) and len(d) >= len(assets):
        if os.path.isfile(os.path.join(d, 'package.json')):
            return True
        nd = os.path.dirname(d)
        if nd == d:
            break
        d = nd
    return False


def is_vendor_script(proj, rel):
    low = rel.replace('\\', '/').lower()
    if any(m in low for m in VENDOR_MARKERS):
        return True
    return _has_package_json_ancestor(proj, os.path.join(proj, rel))


def read_project_meta(proj):
    info = {'dir_name': os.path.basename(proj.rstrip(os.sep)), 'path': proj}
    pv = os.path.join(proj, 'ProjectSettings', 'ProjectVersion.txt')
    if os.path.isfile(pv):
        try:
            txt = read_text(pv)
            m = re.search(r'm_EditorVersion:\s*(.+)', txt)
            mr = re.search(r'm_EditorVersionWithRevision:\s*(.+)', txt)
            info['unity_version'] = m.group(1).strip() if m else None
            info['unity_version_with_revision'] = mr.group(1).strip() if mr else None
        except OSError:
            pass
    for key, fn in (('vpm_manifest', 'Packages/vpm-manifest.json'),
                    ('manifest', 'Packages/manifest.json')):
        p = os.path.join(proj, fn)
        if os.path.isfile(p):
            try:
                d = json.loads(read_text(p))
            except Exception:
                d = None
            if isinstance(d, dict):
                if key == 'vpm_manifest':
                    locked = d.get('locked') or {}
                    info['vpm_locked'] = {k: (v.get('version') if isinstance(v, dict) else v)
                                          for k, v in sorted(locked.items())}
                    info['vpm_dependencies'] = d.get('dependencies') or {}
                else:
                    info['manifest_dependencies'] = d.get('dependencies') or {}
    return info


def scan_root_docs(proj):
    out = []
    try:
        names = sorted(os.listdir(proj))
    except OSError:
        return out
    for n in names:
        if not n.lower().endswith(('.md', '.txt')):
            continue
        p = os.path.join(proj, n)
        if not os.path.isfile(p):
            continue
        try:
            out.append({'name': n, 'bytes': os.path.getsize(p), 'mtime': os.path.getmtime(p)})
        except OSError:
            pass
    return out


# --------------------------------------------------------------------------- #
# MD 摘要
# --------------------------------------------------------------------------- #
def _top(counter, n=12):
    return sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:n]


def write_md(res, path):
    L = []
    a = L.append
    p = res['project']
    a('# 指纹摘要 · %s' % p.get('dir_name'))
    a('')
    a('> 工具 project_fingerprint.py v%s ｜ 生成 %s ｜ 运行 %.2fs ｜ 只读解析，未开 Unity'
      % (res['meta']['tool_version'], res['meta']['generated_at'], res['meta']['runtime_seconds']))
    a('')
    a('## 工程')
    a('- Unity：`%s`' % (p.get('unity_version') or '?'))
    a('- vpm locked：%d 个；manifest 依赖：%d 个'
      % (len(p.get('vpm_locked') or {}), len(p.get('manifest_dependencies') or {})))
    for k, v in list((p.get('vpm_locked') or {}).items())[:10]:
        a('  - `%s` %s' % (k, v))
    a('- GUID 索引：%d（撞车 %d）' % (res['meta']['guid_count'], len(res['meta']['guid_collisions'])))
    a('')
    a('## Assets 顶层（前 12，按字节）')
    for e in sorted(res['assets_top'], key=lambda x: -x['bytes'])[:12]:
        a('- `%s`：%d 文件 / %.1f MB' % (e['name'], e['files'], e['bytes'] / 1048576.0))
    a('')
    a('## 场景')
    for s in res['scenes']:
        a('- `%s`（%d 个 PrefabInstance）' % (s['path'], s['prefab_instance_count']))
        a('  - 根：%s' % ('、'.join(str(x) for x in s['roots'][:8]) or '（无）'))
        a('  - 含 VRCAvatarDescriptor：%s'
          % ('、'.join(str(x) for x in s['descriptor_objects']) or '（无）'))
    a('')
    c = res['components']
    a('## 组件（MonoBehaviour）')
    a('- 合计 %d（Assets %d / Packages %d）'
      % (c['mob_total_all'], c['mob_total_assets'], c['mob_total_packages']))
    sp = c['special']
    a('- Modular Avatar：%d 个组件 / %d 种'
      % (sum(sp.get('modular_avatar', {}).values()), len(sp.get('modular_avatar', {}))))
    a('- VRCFury：%d 个组件 / %d 种' % (sum(sp.get('vrcfury', {}).values()),
                                          len(sp.get('vrcfury', {}))))
    a('- AAO：%d 个组件 / %d 种' % (sum(sp.get('aao', {}).values()), len(sp.get('aao', {}))))
    a('- PhysBone：VRCPhysBone %d、Collider %d'
      % (sp.get('physbone', {}).get('VRCPhysBone', 0),
         sp.get('physbone', {}).get('VRCPhysBoneCollider', 0)))
    a('')
    a('| 类型 | 全量 | Assets |')
    a('|---|---:|---:|')
    for t, n in _top(Counter(c['counts']), 16):
        a('| `%s` | %d | %d |' % (t, n, c['counts_assets_only'].get(t, 0)))
    a('')
    a('## 控制器')
    a('- 共 %d 个' % len(res['controllers']))
    for ct in sorted(res['controllers'], key=lambda x: -x['layer_count'])[:8]:
        add = [l['name'] for l in ct['layers'] if l.get('additive')]
        a('- `%s`：层 %d、参数 %d%s'
          % (ct['path'], ct['layer_count'], ct['param_count'],
             ('；Additive 层：%s' % '、'.join(str(x) for x in add[:6])) if add else ''))
    a('')
    ex = res['expression']
    a('## 菜单与参数')
    a('- VRCExpressionsMenu %d 个；VRCExpressionParameters %d 个，参数合计 %d，同步位合计 %d'
      % (len(ex['menus']), len(ex['parameters']), ex['vrc_param_count_total'],
         ex['vrc_sync_bits_total']))
    for m in sorted(ex['menus'], key=lambda x: -x['control_count'])[:12]:
        a('- 菜单 `%s`（%s）：控件 %d' % (m.get('name'), m['path'], m['control_count']))
    for pp in ex['parameters'][:6]:
        a('- 参数 `%s`：%d 条 / %d bit' % (pp.get('name'), pp['param_count'], pp['sync_bits']))
    a('')
    an = res['animations']
    a('## 动画')
    a('- `.anim` %d 个；曲线分类 %s' % (an['total'], an['curve_categories']))
    a('- 被驱动形态键 %d 种，前 10：' % an['shapekey_name_total'])
    for s in an['shapekeys'][:10]:
        a('  - `%s` ×%d（%s）' % (s['name'], s['count'],
                                  '、'.join(os.path.basename(x) for x in s['clips'][:3])))
    a('')
    sc = res['shape_changers']
    a('## 形态键改（ShapeChanger）')
    a('- ModularAvatarShapeChanger 共 %d 个（%s）' % (sc['component_count_total'], sc['by_scope']))
    if sc['by_scene']:
        a('- 场景内：%s' % '、'.join('%s=%d' % (os.path.basename(k), v)
                                     for k, v in sc['by_scene'].items()))
    for e in sc['entries'][:10]:
        a('  - `%s`（%s）：%d 条' % (e['gameobject'], e['file'], e['shape_count']))
    if sc['other_shape_related_counts']:
        a('- 其他改形态键相关组件：%s' % ', '.join('%s×%d' % (k, v) for k, v in
                                                   list(sc['other_shape_related_counts'].items())[:8]))
    a('')
    a('## 材质')
    a('- `.mat` %d 个；着色器分布前 10：' % res['materials']['total'])
    for k, v in _top(Counter(res['materials']['by_shader']), 10):
        a('  - `%s` ×%d' % (k, v))
    a('')
    cs = res['custom_scripts']
    a('## 自写脚本')
    a('- Assets 下 .cs 合计 %d；判为自写 %d（Editor 下 .cs %d）'
      % (cs['total'], cs['custom'], cs['editor_all']))
    for s in cs['scripts'][:12]:
        a('  - %s `%s`%s' % ('[Editor]' if s['in_editor'] else '        ', s['path'],
                              '' if not s['vendor'] else '  (vendor)'))
    a('')
    a('## 根目录文档')
    for d in res['root_docs'][:15]:
        a('- `%s`（%.1f KB）' % (d['name'], d['bytes'] / 1024.0))
    a('')
    a('## 跳过')
    if res['skipped']:
        for s in res['skipped'][:20]:
            a('- `%s`：%s' % (s['path'], s['reason']))
    else:
        a('- 无')
    a('')
    L = L[:200]
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(L) + '\n')


def main():
    global _MENUS, _PARAMS
    ap = argparse.ArgumentParser(description='Unity 工程指纹提取器（只读，纯标准库）')
    ap.add_argument('project', help='工程目录')
    ap.add_argument('--out', required=True, help='输出 JSON 路径')
    ap.add_argument('--md', default=None, help='输出人读摘要 MD 路径')
    ap.add_argument('--quiet', action='store_true')
    args = ap.parse_args()
    proj = args.project
    if not os.path.isdir(proj):
        print('不是目录：%s' % proj, file=sys.stderr)
        return 2
    _MENUS = []
    _PARAMS = []
    t0 = time.time()
    res = fingerprint(proj, log=(lambda *a: None) if args.quiet else
                      (lambda *a: print(*a, file=sys.stderr)))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    if args.md:
        os.makedirs(os.path.dirname(os.path.abspath(args.md)) or '.', exist_ok=True)
        write_md(res, args.md)
    print('OK %s  runtime=%.2fs  -> %s' % (os.path.basename(proj.rstrip('/')),
                                           time.time() - t0, args.out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
