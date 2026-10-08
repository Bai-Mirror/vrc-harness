#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""strip_audit.py —— 交付前剥离审查残留 + 零残留自检（T-23 / 作业清单 B-T23）。
【项目沉淀】通用工具
适用素体：无关
相关素材：工程 Assets/AvatarAudit 与 manifest
工具链　：Python 3（离线）
可复用性：★★ 审查工具链的一环
用途　　：交付前剥离审查残留 + 零残留自检（T-23）：--check 列出、--apply 实删/改。


规格：`_长程任务_20260918/感知机制研究/04_第一期开工清单.md` §T-23；作业清单 B-T23。
离线脚本：只读写给定工程目录与 git，不启动 Unity、不动别的工程。

剥离清单（`--check` 列出，`--apply` 实删/改）：

* `Assets/AvatarAudit/` 与 `Assets/AvatarAudit.meta`（新审查代码副本）
* `Assets/Editor/AvatarAudit/` 与 `Assets/Editor/AvatarAudit.meta`（旧位置，迁移前用过）
* `Assets/ZZZ_GeneratedAssets/`（烘焙克隆体）
* `Packages/nadena.dev.ndmf/__Generated/`（NDMF 生成资产）
* `Library/AvatarAudit/`（T1 request/out 中间态；至少列出 `request.json`）
* `Packages/manifest.json` / `Packages/packages-lock.json` 里的 `com.coplaydev.unity-mcp`
* `ProjectSettings/` 相对基线提交的漂移（`--apply` 用 `git checkout <baseline> --` 还原）

只报不改（信息项）：

* `_感知/` 是否随交付——SOP 90 的工程 zip 只装 5 项（`.gitignore`/`.gitattributes`、
  `.vsconfig`、`Assets`、`Packages`、`ProjectSettings`），`_感知/` 在工程根、不在其中，
  因此**不随 zip 交付**（随 git 留档，03a §入口）。
* 场景/prefab 里的审查组件（`AuditMappingProbe` 等，构建期组件，正常不该落盘；
  发现则列路径，交人处理）。Unity YAML 里 MonoBehaviour 只写
  `m_Script: {fileID: 11500000, guid: <脚本 guid>}`、**不写类名**，所以判残留要先把
  `Assets/AvatarAudit/**/*.cs.meta` 的 guid 收齐，再按 guid 搜场景/prefab；
  且必须**先搜完再删脚本目录**——否则 `--apply` 删掉 `.meta` 后，第二次 scan 认不出
  场景里遗留的组件（脚本目录删了，但场景里的组件还在）。**「删完再另起一次 --check」
  时工作树 `.cs.meta` 已不在**，故 guid 还从 git 基线读（`git ls-tree` 列路径 +
  `git -c core.quotepath=false show HEAD:<路径>` 读内容）；两处都取不到就报
  `undecidable` 并非零退出，**不许报 ok**（否则会显示假的「零残留」）。
* `Captures/`、`Assets/Editor/AvatarGen/`（SOP 90 步骤 1 的清理项，不属审查残留，脚本只提示）。

`--check` 只查不删；`--apply` 实删并对白名单外的 tracked 改动作判定（白名单 =
本脚本删除/修改的路径）。退出码：0 = 零残留；1 = 有残留、残留未清干净，或场景判不了
（`undecidable`）。

用法::

    python3 perception/strip_audit.py --project <工程根> --check
    python3 perception/strip_audit.py --project <工程根> --apply [--baseline HEAD] [--json]
    python3 perception/strip_audit.py --selftest          # 在临时 fixture 上跑全流程，不碰真工程
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

# SOP 90：工程 zip 只装这 5 项（顶层）
DELIVERED_TOP = [".gitignore", ".gitattributes", ".vsconfig", "Assets", "Packages", "ProjectSettings"]
MCP_PKG = "com.coplaydev.unity-mcp"

# (kind, 相对工程根的路径, 类型, 是否剥离项)
STRIP_PATHS = [
    ("assets_audit", "Assets/AvatarAudit", "dir", True),
    ("assets_audit_meta", "Assets/AvatarAudit.meta", "file", True),
    ("assets_editor_audit_legacy", "Assets/Editor/AvatarAudit", "dir", True),
    ("assets_editor_audit_legacy_meta", "Assets/Editor/AvatarAudit.meta", "file", True),
    ("generated_assets", "Assets/ZZZ_GeneratedAssets", "dir", True),
    ("ndmf_generated", "Packages/nadena.dev.ndmf/__Generated", "dir", True),
    ("library_audit", "Library/AvatarAudit", "dir", True),
]
INFO_PATHS = [
    ("captures", "Captures", "dir", "SOP 90 步骤 1 清理项（渲染/性能输出），不属审查残留"),
    ("avatargen", "Assets/Editor/AvatarGen", "dir", "订单专用生成器脚本，SOP 90 步骤 1 清理项"),
]
MANIFEST_FILES = ["Packages/manifest.json", "Packages/packages-lock.json"]


# ---------------------------------------------------------------- 基础设施
def die(msg):
    raise SystemExit("strip_audit.py: %s" % msg)


def check_project(proj):
    if not os.path.isdir(os.path.join(proj, "Assets")) or \
       not os.path.isdir(os.path.join(proj, "ProjectSettings")):
        die("--project 需指向含 Assets/ 与 ProjectSettings/ 的工程根：%s" % proj)


def run_git(proj, args):
    return subprocess.run(["git", "-C", proj, *args], capture_output=True, text=True)


def repo_root(proj):
    r = run_git(proj, ["rev-parse", "--show-toplevel"])
    if r.returncode != 0:
        return None
    return r.stdout.strip()


def rel_repo(proj, path):
    rr = repo_root(proj)
    if not rr:
        return None
    # Git always reports repository paths with forward slashes, including on
    # Windows. Keep this boundary canonical for status and revision lookups.
    return os.path.relpath(os.path.abspath(path), rr).replace(os.sep, "/")


def pj(proj, rel):
    return os.path.join(proj, rel.replace("/", os.sep))


# ---------------------------------------------------------------- 扫描
def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def find_pkg_in_manifest(proj, rel):
    p = pj(proj, rel)
    if not os.path.isfile(p):
        return False
    try:
        obj = read_json(p)
    except Exception:
        return False
    return MCP_PKG in (obj.get("dependencies") or {})


def strip_pkg_from_manifest(proj, rel):
    p = pj(proj, rel)
    obj = read_json(p)
    deps = obj.get("dependencies") or {}
    if MCP_PKG not in deps:
        return False
    del deps[MCP_PKG]
    obj["dependencies"] = deps
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    return True


def audit_script_roots(proj):
    """审查脚本落过的两个位置（新位置 + 迁移前的旧位置）。"""
    return ["Assets/AvatarAudit", "Assets/Editor/AvatarAudit"]


def _guid_from_meta(text):
    """从 `.cs.meta` 文本里取第一个 32 位 hex guid；没有返回 None。"""
    for line in (text or "").splitlines():
        m = re.match(r"\s*guid:\s*([0-9a-fA-F]{32})\s*$", line)
        if m:
            return m.group(1)
    return None


def audit_script_guids(proj):
    """收工作树里审查脚本 `*.cs.meta` 的 guid。

    返回 `{guid: 相对工程根的脚本路径}`。Unity 场景里的 MonoBehaviour 只以
    `m_Script: {fileID: 11500000, guid: <脚本 guid>}` 引用脚本，不写类名，因此
    查「场景里有没有审查组件」只能按 guid。脚本目录一旦被删，`.meta` 也没了，
    guid 就无从得知——所以调用方要在删除前先收好（见 `scan(proj, probe_guids=…)`），
    或改从 git 基线读（`audit_script_guids_git`，供「删后另起一次 --check」）。
    """
    guids = {}
    for rel_root in audit_script_roots(proj):
        root = pj(proj, rel_root)
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for fn in files:
                if not fn.endswith(".cs.meta"):
                    continue
                fp = os.path.join(dirpath, fn)
                try:
                    with open(fp, encoding="utf-8", errors="ignore") as f:
                        guid = _guid_from_meta(f.read())
                except OSError:
                    continue
                if guid:
                    script = os.path.relpath(fp[:-len(".meta")], proj).replace(os.sep, "/")
                    guids[guid] = script
    return guids


def audit_script_guids_git(proj, ref="HEAD"):
    """从 git 基线读审查脚本 `*.cs.meta` 的 guid（工作树 `.meta` 已随目录删掉时用）。

    路径从 `git ls-tree --full-name` 取（工作树没了也能列），内容用
    `git -c core.quotepath=false show <ref>:<路径>.meta` 读。
    返回 `{guid: 相对工程根的脚本路径}`；不在 git 仓库 / 基线里没有脚本则返回 `{}`。
    """
    rr = repo_root(proj)
    if not rr:
        return {}
    proj_abs = os.path.abspath(proj)
    guids = {}
    for rel_root in audit_script_roots(proj):
        r = run_git(proj, ["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only",
                           "--full-name", ref, "--", rel_root])
        if r.returncode != 0:
            continue
        for repo_path in r.stdout.splitlines():
            repo_path = repo_path.strip()
            if not repo_path.endswith(".cs.meta"):
                continue
            g = run_git(proj, ["-c", "core.quotepath=false", "show",
                               "%s:%s" % (ref, repo_path)])
            if g.returncode != 0:
                continue
            guid = _guid_from_meta(g.stdout)
            if not guid:
                continue
            script_abs = os.path.join(rr, repo_path[:-len(".meta")])
            script = os.path.relpath(script_abs, proj_abs).replace(os.sep, "/")
            guids[guid] = script
    return guids


def collect_probe_guids(proj):
    """收审查脚本 guid：工作树 `.cs.meta` 与 git 基线 `.cs.meta` 合并。

    返回 `(guids, source)`；`source` ∈ `live` / `git` / `live+git` / `none`。
    `--apply` 前调用一次拿快照；「删后另起一次 --check」时工作树为空，靠 `git`
    分支从基线取回 guid。两个来源都空即 `none`，调用方必须报 `undecidable`，
    不能当「无残留」。
    """
    live = audit_script_guids(proj)
    git = audit_script_guids_git(proj)
    merged = dict(git)
    merged.update(live)  # 工作树路径更新更准，优先
    if live and git:
        source = "live+git"
    elif live:
        source = "live"
    elif git:
        source = "git"
    else:
        source = "none"
    return merged, source


def _mscript_re(guid):
    # Unity 序列化的 m_Script 行：fileID 固定 11500000（脚本资产），后跟 guid/type。
    return re.compile(r"m_Script:\s*\{\s*fileID:\s*11500000\s*,\s*guid:\s*%s\b"
                      % re.escape(guid))


def find_scene_probe(proj, guids=None):
    """在 `.unity`/`.prefab` 文本里按审查脚本 guid 找组件引用。

    返回 `[(相对工程根的 YAML 路径, 命中的脚本相对路径), …]`，按 YAML 路径排序。
    `guids` 由调用方传入时以传入的为准（`--apply` 用完删脚本目录后仍能认残留）。
    """
    if guids is None:
        guids = audit_script_guids(proj)
    hits = []
    if not guids:
        return hits
    base = os.path.join(proj, "Assets")
    pats = {guid: _mscript_re(guid) for guid in guids}
    for root, _dirs, files in os.walk(base):
        for fn in files:
            if not (fn.endswith(".unity") or fn.endswith(".prefab")):
                continue
            fp = os.path.join(root, fn)
            try:
                with open(fp, encoding="utf-8", errors="ignore") as f:
                    text = f.read()
            except OSError:
                continue
            for guid in sorted(pats):
                if pats[guid].search(text):
                    hits.append((os.path.relpath(fp, proj).replace(os.sep, "/"), guids[guid]))
                    break
    return sorted(hits)


def projectsettings_drift(proj):
    r = run_git(proj, ["-c", "core.quotepath=false", "status", "--porcelain", "--",
                       "ProjectSettings"])
    return [ln for ln in r.stdout.splitlines() if ln.strip()]


def scan(proj, probe_guids=None, guid_source=None):
    findings = []
    for kind, rel, typ, strip in STRIP_PATHS:
        p = pj(proj, rel)
        exists = os.path.isdir(p) if typ == "dir" else os.path.isfile(p)
        findings.append({
            "kind": kind, "path": rel, "status": "present" if exists else "absent",
            "strip": strip, "action": "delete",
            "detail": "审查残留" if strip else "",
        })
    for rel in MANIFEST_FILES:
        has = find_pkg_in_manifest(proj, rel)
        findings.append({
            "kind": "manifest_mcp", "path": rel,
            "status": "present" if has else "absent", "strip": True,
            "action": "edit_json_remove_" + MCP_PKG,
            "detail": "开发用依赖（Unity MCP），交付包不应含；命中数需为 0" if has else "",
        })
    drift = projectsettings_drift(proj)
    findings.append({
        "kind": "projectsettings_drift", "path": "ProjectSettings/",
        "status": "drift" if drift else "ok", "strip": True, "action": "git_checkout_baseline",
        "detail": "；".join(drift) if drift else "",
    })
    # _感知：只报不改
    perc = pj(proj, "_感知")
    if os.path.isdir(perc):
        findings.append({
            "kind": "perception_dir", "path": "_感知/", "status": "present",
            "strip": False, "action": "info",
            "detail": "在工程根、不在 SOP 90 交付 5 项内 → 不随工程 zip 交付（随 git 留档）",
        })
    else:
        findings.append({
            "kind": "perception_dir", "path": "_感知/", "status": "absent",
            "strip": False, "action": "info",
            "detail": "本工程还没有 _感知/（感知一期未落地的工程正常）",
        })
    if probe_guids is None:
        probe_guids, guid_source = collect_probe_guids(proj)
    if probe_guids:
        probe = find_scene_probe(proj, probe_guids)
        src_note = {"live": "工作树 .cs.meta", "git": "git 基线 HEAD 的 .cs.meta",
                    "live+git": "工作树 + git 基线 HEAD 的 .cs.meta",
                    "none": "（无来源）"}.get(guid_source)
        if not src_note:
            src_note = "调用方传入的快照 guid"
        findings.append({
            "kind": "scene_probe", "path": "Assets/**/*.unity|*.prefab",
            "status": "present" if probe else "ok", "strip": True, "action": "manual",
            "guid_source": guid_source,
            "detail": ("场景/prefab 按脚本 guid 命中审查组件（guid 来自 %s）：%s"
                       % (src_note, "、".join("%s（%s）" % (p, s) for p, s in probe))) if probe
                      else "场景与 prefab 无审查组件（guid 来自 %s）" % src_note,
        })
    else:
        findings.append({
            "kind": "scene_probe", "path": "Assets/**/*.unity|*.prefab",
            "status": "undecidable", "strip": True, "action": "manual",
            "guid_source": "none",
            "detail": "取不到审查脚本 guid（工作树 .cs.meta 已删、git 基线 HEAD 也没有）→ "
                      "无法判定场景/prefab 是否残留审查组件，不能报 ok；"
                      "先提交一次含 Assets/AvatarAudit/**/*.cs.meta 的基线再复查。",
        })
    for kind, rel, typ, note in INFO_PATHS:
        p = pj(proj, rel)
        exists = os.path.isdir(p) if typ == "dir" else os.path.isfile(p)
        findings.append({
            "kind": kind, "path": rel, "status": "present" if exists else "absent",
            "strip": False, "action": "info", "detail": note if exists else "",
        })
    return findings


# ---------------------------------------------------------------- 应用
def apply_strip(proj, findings, baseline):
    changed = []
    for f in findings:
        if not f.get("strip") or f["status"] in ("absent", "ok"):
            continue
        kind = f["kind"]
        p = pj(proj, f["path"])
        if kind == "manifest_mcp":
            if strip_pkg_from_manifest(proj, f["path"]):
                changed.append(("edited", f["path"]))
        elif kind == "projectsettings_drift":
            r = run_git(proj, ["checkout", baseline, "--", "ProjectSettings"])
            if r.returncode == 0:
                changed.append(("reverted", "ProjectSettings/ (%s)" % baseline))
            else:
                changed.append(("FAILED", "ProjectSettings/: " + r.stderr.strip()))
        elif kind == "scene_probe":
            if f["status"] == "undecidable":
                changed.append(("manual", "取不到脚本 guid，场景/prefab 是否残留判不了，"
                                          "脚本不自动改场景；先补基线再查"))
            else:
                changed.append(("manual", "场景/prefab 含审查组件，脚本不自动改场景，请人工清"))
        else:
            if os.path.isdir(p):
                shutil.rmtree(p)
                changed.append(("deleted", f["path"]))
            elif os.path.isfile(p):
                os.remove(p)
                changed.append(("deleted", f["path"]))
    return changed


# ---------------------------------------------------------------- git status
def git_status(proj):
    # `-C proj` 让 `.` 这个 pathspec 相对工程根，把状态限定在本工程内；
    # 输出路径仍是 repo 相对路径。
    r = run_git(proj, ["-c", "core.quotepath=false", "status", "--porcelain", "--", "."])
    out = []
    for ln in r.stdout.splitlines():
        if len(ln) < 4:
            continue
        xy, path = ln[:2], ln[3:]
        if " -> " in path:  # rename
            path = path.split(" -> ", 1)[1]
        out.append((xy, path.strip().strip('"')))
    return out


def whitelist_prefixes(proj):
    """本脚本会删除/修改的、可进白名单的 repo 相对路径前缀。"""
    rr = repo_root(proj)
    if not rr:
        return []
    pre = []
    for kind, rel, _typ, strip in STRIP_PATHS:
        if strip:
            pre.append(rel_repo(proj, pj(proj, rel)))
    for rel in MANIFEST_FILES:
        pre.append(rel_repo(proj, pj(proj, rel)))
    pre.append(rel_repo(proj, pj(proj, "ProjectSettings")))
    return [p for p in pre if p]


def classify_status(proj):
    prefixes = whitelist_prefixes(proj)
    inside, outside = [], []
    for xy, path in git_status(proj):
        match = any(path == p or path.startswith(p.rstrip("/") + "/") or path.startswith(p + ".")
                    for p in prefixes)
        (inside if match else outside).append((xy, path))
    return inside, outside


# ---------------------------------------------------------------- 打印
MARK = {"present": "PRESENT", "absent": "absent", "drift": "DRIFT", "ok": "ok",
        "undecidable": "UNDECIDABLE"}
EXIT_MARK = "✗" if not sys.stdout.isatty() else "×"


def print_report(proj, findings, mode):
    rr = repo_root(proj)
    print("strip_audit %s：%s%s" % (mode, proj, ("（repo %s）" % rr) if rr else "（不在 git 仓库）"))
    residue = [f for f in findings
               if f.get("strip") and f["status"] in ("present", "drift", "undecidable")]
    for f in findings:
        mark = MARK.get(f["status"], f["status"])
        if f.get("strip") and f["status"] in ("present", "drift"):
            mark = "RESIDUE"
        print("  [%-11s] %-32s %s%s"
              % (mark, f["path"], f["detail"][:60],
                 (" → " + f["action"]) if f.get("strip") else ""))
    inside, outside = classify_status(proj)
    print("")
    print("白名单内改动（本脚本会删/改）：%d" % len(inside))
    for xy, path in inside:
        print("  %s %s" % (xy, path))
    tracked_outside = [(xy, p) for xy, p in outside if not xy.strip().startswith("??")]
    untracked_outside = [(xy, p) for xy, p in outside if xy.strip().startswith("??")]
    print("白名单外 tracked 改动：%d%s"
          % (len(tracked_outside), "" if not tracked_outside else " ← 需人核对"))
    for xy, path in tracked_outside:
        print("  %s %s" % (xy, path))
    print("白名单外未跟踪文件：%d（不判失败）" % len(untracked_outside))
    print("")
    print("剥离残留：%d 项" % len(residue))
    return residue


# ---------------------------------------------------------------- selftest
def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def _git(proj, *args):
    r = subprocess.run(["git", "-C", proj, *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("git %s: %s%s" % (" ".join(args), r.stdout, r.stderr))
    return r


# 真实 Unity YAML 片段。MonoBehaviour 的 `m_Script` 行只写脚本 guid、不写类名；
# The block format follows a Unity scene MonoBehaviour fixture.
# The fixture's guids are derived from the fixture's own tags instead of being written down. The shape being
# tested — a scene whose `m_Script` references a script guid that only the `.meta` carries — is the same for
# any project, so the tool must not carry one project's guid: a literal here would pin this generic check to
# whichever project it was first calibrated on (order D-110), and two distinct stable values are all the
# fixture needs.
def _fixture_guid(tag):
    return hashlib.sha1(("avatar-audit-fixture:" + tag).encode("utf-8")).hexdigest()[:32]


PROBE_GUID = _fixture_guid("mapping-probe")
PROBE_GUID2 = _fixture_guid("audit-script")
PROBE_SCENE_YAML = (
    "%%YAML 1.1\n"
    "%%TAG !u! tag:unity3d.com,2011:\n"
    "--- !u!114 &51651963\n"
    "MonoBehaviour:\n"
    "  m_ObjectHideFlags: 0\n"
    "  m_CorrespondingSourceObject: {fileID: 0}\n"
    "  m_PrefabInstance: {fileID: 0}\n"
    "  m_PrefabAsset: {fileID: 0}\n"
    "  m_GameObject: {fileID: 51651961}\n"
    "  m_Enabled: 1\n"
    "  m_EditorHideFlags: 0\n"
    "  m_Script: {fileID: 11500000, guid: %s, type: 3}\n"
    "  m_Name: \n"
    "  m_EditorClassIdentifier: \n" % PROBE_GUID
)
PROBE_META = (
    "fileFormatVersion: 2\n"
    "guid: %s\n"
    "MonoImporter:\n"
    "  externalObjects: {}\n"
    "  serializedVersion: 2\n"
    "  defaultReferences: []\n"
    "  executionOrder: 0\n"
    "  icon: {instanceID: 0}\n"
    "  userData: \n"
    "  assetBundleName: \n"
    "  assetBundleVariant: \n" % PROBE_GUID
)


def build_fixture(base):
    proj = os.path.join(base, "Fake_COMM_20260919")
    _write(os.path.join(proj, ".gitignore"), "Library/\nCaptures/\nZZZ_GeneratedAssets/\n")
    _write(os.path.join(proj, "Assets/AvatarAudit/Editor/AuditX.cs"), "// audit tool\n")
    _write(os.path.join(proj, "Assets/AvatarAudit/Editor/AuditX.cs.meta"),
           "fileFormatVersion: 2\nguid: %s\n" % PROBE_GUID2)
    _write(os.path.join(proj, "Assets/AvatarAudit/Runtime/AuditMappingProbe.cs"), "// probe\n")
    _write(os.path.join(proj, "Assets/AvatarAudit/Runtime/AuditMappingProbe.cs.meta"), PROBE_META)
    _write(os.path.join(proj, "Assets/AvatarAudit.meta"), "guid: ddd\n")
    _write(os.path.join(proj, "Assets/Editor/AvatarAudit/Old.cs"), "// old\n")
    _write(os.path.join(proj, "Assets/ZZZ_GeneratedAssets/a.txt"), "clone\n")
    _write(os.path.join(proj, "Packages/nadena.dev.ndmf/__Generated/g.txt"), "gen\n")
    _write(os.path.join(proj, "Packages/manifest.json"),
           json.dumps({"dependencies": {MCP_PKG: "git+https://x", "com.vrchat.avatars": "3.7.0"}},
                      indent=2) + "\n")
    _write(os.path.join(proj, "Packages/packages-lock.json"),
           json.dumps({"dependencies": {MCP_PKG: {"version": "1"}, "com.vrchat.avatars": {"version": "3.7.0"}}},
                      indent=2) + "\n")
    _write(os.path.join(proj, "Library/AvatarAudit/request.json"), "{}\n")
    _write(os.path.join(proj, "Captures/perf_report.txt"), "perf\n")
    _write(os.path.join(proj, "_感知/声明.yaml"), "avatar: {}\n")
    _write(os.path.join(proj, "ProjectSettings/ProjectSettings.asset"), "baseline: 1\n")
    _write(os.path.join(proj, "Assets/Scene.unity"), "%YAML 1.1\n")
    _git(proj, "init", "-q")
    _git(proj, "config", "user.email", "t@t")
    _git(proj, "config", "user.name", "t")
    _git(proj, "add", "-A")
    _git(proj, "-c", "core.quotepath=false", "commit", "-q", "-m", "baseline")
    # Play 副作用：ProjectSettings 漂移
    _write(os.path.join(proj, "ProjectSettings/ProjectSettings.asset"), "baseline: 2  # play drift\n")
    return proj


def _scratch_root():
    """测试副本目录：优先 `<repo>/_长程任务_20260918/派工/_scratch/`（已 gitignore），
    找不到（脚本被拷进别的工程时）就返回 None，由调用方退回系统临时目录。
    副本必须能被 finally 删掉，不能留在工作树里（否则会被 `git add -A` 收进库）。
    """
    d = os.path.dirname(os.path.abspath(__file__))
    while True:
        pai = os.path.join(d, "_长程任务_20260918", "派工")
        if os.path.isdir(pai):
            scratch = os.path.join(pai, "_scratch")
            os.makedirs(scratch, exist_ok=True)
            return scratch
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def cmd_selftest():
    scratch = _scratch_root()
    base = tempfile.mkdtemp(prefix="strip_audit_selftest_", dir=scratch)
    ok = True
    try:
        proj = build_fixture(base)
        print("== selftest fixture: %s" % proj)
        # guid 必须在删脚本目录之前收好
        guids = audit_script_guids(proj)
        print("  selftest：从 .cs.meta 收到 %d 个审查脚本 guid：%s"
              % (len(guids), "、".join(sorted(guids.values()))))
        ok &= len(guids) >= 2 and PROBE_GUID in guids
        f1 = scan(proj, guids)
        res1 = print_report(proj, f1, "--check")
        # 期望：7 条剥离路径存在 + 2 个 manifest 含包 + PS drift = 10
        expect_present = ["Assets/AvatarAudit", "Assets/AvatarAudit.meta",
                          "Assets/Editor/AvatarAudit", "Assets/ZZZ_GeneratedAssets",
                          "Packages/nadena.dev.ndmf/__Generated", "Library/AvatarAudit",
                          "Packages/manifest.json", "Packages/packages-lock.json",
                          "ProjectSettings/"]
        have = {f["path"] for f in res1}
        missing = [p for p in expect_present if p not in have]
        print("  selftest：check 命中 %d/%d%s" % (len(expect_present) - len(missing),
                                                  len(expect_present),
                                                  "" if not missing else " 缺 " + "、".join(missing)))
        ok &= not missing
        changed = apply_strip(proj, f1, "HEAD")
        print("  selftest：apply %d 条：%s" % (len(changed), changed))
        f2 = scan(proj, guids)
        res2 = print_report(proj, f2, "--apply 后 --check")
        ok &= not res2
        # manifest 断言
        m = read_json(os.path.join(proj, "Packages/manifest.json"))
        ok &= MCP_PKG not in m["dependencies"] and "com.vrchat.avatars" in m["dependencies"]
        lk = read_json(os.path.join(proj, "Packages/packages-lock.json"))
        ok &= MCP_PKG not in lk["dependencies"]
        # PS 已还原
        ok &= open(os.path.join(proj, "ProjectSettings/ProjectSettings.asset"),
                   encoding="utf-8").read().strip() == "baseline: 1"
        # ---- 场景探针正样本（真实 Unity YAML：只写 guid、不写类名）----
        # apply 已删 Assets/AvatarAudit/，这里补回 .meta 以便按 guid 搜
        _write(os.path.join(proj, "Assets/AvatarAudit/Runtime/AuditMappingProbe.cs.meta"), PROBE_META)
        guids_before = audit_script_guids(proj)
        _write(os.path.join(proj, "Assets/Probe.unity"), PROBE_SCENE_YAML)
        text = open(os.path.join(proj, "Assets/Probe.unity"), encoding="utf-8").read()
        no_class_name = "AuditMappingProbe" not in text
        print("  selftest：正样本场景只写 guid、不写类名：%s" % no_class_name)
        ok &= no_class_name and PROBE_GUID in guids_before
        f3 = scan(proj, guids_before)
        probe = [f for f in f3 if f["kind"] == "scene_probe"][0]
        print("  selftest：场景探针正样本 status=%s（按 guid 命中）" % probe["status"])
        ok &= probe["status"] == "present"
        # 搜完再删：删掉脚本目录后，用删前快照的 guid 仍能认出场景残留；
        # 不传快照（现场重收 guid）则认不出——正说明必须先搜后删。
        shutil.rmtree(os.path.join(proj, "Assets/AvatarAudit"))
        cached = find_scene_probe(proj, guids_before)
        live = find_scene_probe(proj)
        print("  selftest：删脚本目录后 快照 guid 命中 %d、现场重收 guid 命中 %d"
              % (len(cached), len(live)))
        ok &= len(cached) == 1 and not live
        # ---- 删后另起一次 --check（验收 B-T23 点名的失败场景）----
        # 此时工作树 Assets/AvatarAudit/ 已随 .cs.meta 一起删掉；新起一个进程跑 --check，
        # guid 必须从 git 基线 HEAD 的 .cs.meta 取回，场景探针仍要报 RESIDUE（rc!=0）。
        guids_git, src_git = collect_probe_guids(proj)
        print("  selftest：删后重收 guid 来源=%s，取回 %d 个" % (src_git, len(guids_git)))
        ok &= src_git == "git" and PROBE_GUID in guids_git
        r = subprocess.run([sys.executable, os.path.abspath(__file__),
                            "--project", proj, "--check"],
                           capture_output=True, text=True)
        residue_line = [ln for ln in r.stdout.splitlines() if "RESIDUE" in ln]
        print("  selftest：另起进程删后 --check rc=%d %s"
              % (r.returncode, ("| " + "；".join(residue_line))[:120] if residue_line else ""))
        ok &= r.returncode != 0 and any("scene" in ln or "Assets/**" in ln for ln in residue_line)
        # ---- 负样本：工作树与 git 基线都没有 .cs.meta → 必须 undecidable 且 rc!=0 ----
        proj_none = os.path.join(base, "Fake_NoAudit_20260919")
        _write(os.path.join(proj_none, "Assets/Scene.unity"), "%YAML 1.1\n")
        _write(os.path.join(proj_none, "ProjectSettings/ProjectSettings.asset"), "baseline: 1\n")
        _git(proj_none, "init", "-q")
        _git(proj_none, "config", "user.email", "t@t")
        _git(proj_none, "config", "user.name", "t")
        _git(proj_none, "add", "-A")
        _git(proj_none, "-c", "core.quotepath=false", "commit", "-q", "-m", "baseline")
        sp = [f for f in scan(proj_none) if f["kind"] == "scene_probe"][0]
        print("  selftest：无 guid 来源时 scene_probe status=%s" % sp["status"])
        ok &= sp["status"] == "undecidable"
        rn = subprocess.run([sys.executable, os.path.abspath(__file__),
                             "--project", proj_none, "--check"],
                            capture_output=True, text=True)
        print("  selftest：无 guid 来源时另起进程 --check rc=%d（应非零，含 UNDECIDABLE）"
              % rn.returncode)
        ok &= rn.returncode != 0 and "UNDECIDABLE" in rn.stdout
        # git status 白名单外 tracked 改动
        inside, outside = classify_status(proj)
        tracked_outside = [(x, p) for x, p in outside if not x.strip().startswith("??")]
        print("  selftest：白名单内 %d、白名单外 tracked %d" % (len(inside), len(tracked_outside)))
        for xy, p in tracked_outside:
            print("    %s %s" % (xy, p))
        ok &= not tracked_outside
        print("selftest: %s" % ("PASS" if ok else "FAIL"))
    finally:
        shutil.rmtree(base, ignore_errors=True)
    return 0 if ok else 1


# ---------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description="90 剥离审查残留 + 零残留自检（T-23）")
    ap.add_argument("--project", help="工程根（含 Assets/ 与 ProjectSettings/）")
    ap.add_argument("--check", action="store_true", help="只查不删（默认）")
    ap.add_argument("--apply", action="store_true", help="实删/改残留，并还原 ProjectSettings")
    ap.add_argument("--baseline", default="HEAD", help="ProjectSettings 还原到的基线修订（默认 HEAD）")
    ap.add_argument("--json", action="store_true", help="同时输出机器可读 JSON")
    ap.add_argument("--selftest", action="store_true", help="临时 fixture 全流程自检，不碰真工程")
    a = ap.parse_args(argv)
    if a.selftest:
        return cmd_selftest()
    if not a.project:
        ap.error("需要 --project（或 --selftest）")
    proj = os.path.abspath(a.project)
    check_project(proj)
    # 先收 guid 再 scan：apply 会删脚本目录，之后第二次 scan 靠这份快照认场景残留。
    # 工作树 .cs.meta 若已删（删后另起一次 --check），collect 会从 git 基线 HEAD 取回；
    # 两处都没有则 scan 报 undecidable 并非零退出，不许报 ok。
    probe_guids, guid_source = collect_probe_guids(proj)
    findings = scan(proj, probe_guids, guid_source)
    mode = "--apply" if a.apply else "--check"
    residue = print_report(proj, findings, mode)
    if a.apply:
        changed = apply_strip(proj, findings, a.baseline)
        print("apply：%d 条" % len(changed))
        for act, path in changed:
            print("  %-8s %s" % (act, path))
        f2 = scan(proj, probe_guids, guid_source)
        residue = print_report(proj, f2, "apply 后")
        findings = f2
    if a.json:
        print(json.dumps({"project": proj, "mode": mode, "findings": findings},
                         ensure_ascii=False, indent=2))
    return 0 if not residue else 1


if __name__ == "__main__":
    sys.exit(main())
