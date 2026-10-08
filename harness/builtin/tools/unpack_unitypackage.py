# -*- coding: utf-8 -*-
"""
【项目沉淀】通用工具
适用素体：无关          相关素材：任意 BOOTH 素材包
可复用性：★★★ 换个单子直接能用
用途　　：把素材包（zip → .unitypackage）解进 Unity 工程的 Assets/，不经 Unity、不改 GUID

为什么不拖文件夹：拖文件夹时若 .meta 没跟着，Unity 会给文件夹重新生成 GUID，
硬编码 GUIDToAssetPath 的插件（PoLKA 就是）会解析失败并弹模态框中断构建。
.unitypackage 里带着原始 GUID，逐条还原最安全。

.unitypackage 就是个 gzip tar，每个资源三件套：
    <guid>/pathname     资源在 Assets 下的相对路径（首行）
    <guid>/asset        文件内容（文件夹条目没有这个）
    <guid>/asset.meta   .meta 内容（含原始 GUID）
两遍读：先收 pathname 建映射，再落盘。

用法：
    python unpack_unitypackage.py <工程目录> <包1.unitypackage> [包2 ...]
    python unpack_unitypackage.py <工程目录> --list <清单文件>
    加 --only-new-guids 只解**工程里还没有的 GUID**

什么时候必须加 --only-new-guids：
同一个商品的几个分包**共用一批公共资产、且 GUID 相同**（Hug me Bear 的
ArmHug / GIFT / Kumachama 三个分包共用 white/choco/love/ocean 等材质就是这样）。
照常解会在第二个路径下再写一份**同 GUID** 的文件 —— Unity 不允许一个 GUID 两个路径，
会给其中一个重新发号，引用它的预制体随即断链、渲染成洋红。
只解新 GUID 就没这个问题：公共资产工程里已经有了，预制体按 GUID 照样找得到。

⚠⚠ 教训：**共用资产的边界是「厂商」，不是「商品」。**
上面说的 `--only-new-guids` 那次是按「同一商品的公共包 + 变体包」配对用的，
结果 GoldenHour 与 SweetyHair 这**两个不同商品**因为同属厂商 `!Yueby&Mekoko`
而共用 `!Common/` 目录，跨商品的共用完全没防到。

而且这次是**反向**的撞法：**同一个 GUID 出现在两个不同路径**（本工具原来只查同路径不同 GUID）。
成因是厂商升版挪了文件位置却保留 GUID ——
`SweetyHair_Materials v1.3` 的 `!Common/Materials/Gem_1.mat`
到 v1.4 变成 `!Common/Materials/**Gem/**Gem_1.mat`，GUID 仍是 `b1b6405...`。
装了 GoldenHour v1.1（旧路径）+ SweetyHair v1.4（新路径）→ 磁盘两份同 GUID →
**Unity 打开工程时静默给两边都重新发号**，两个发型预制体当场断链。

**所以**：
  · `--only-new-guids` 应当**全程默认开**，且 `have_guids` **每装完一个包就刷新**，
    不能用开工时的快照 —— 快照防不住「本轮先装的包刚写进去的 GUID」。
  · 导入后必须另做一次 **同 GUID 不同路径** 审计，本工具的 clash 计数查不出这种。
  · 修法是**原地改 .meta 的 guid 回厂商原值 + 删掉重复那份**，不要删了重建。
    厂商原始 GUID 去源 unitypackage 里取（tar.gz，条目为 `<guid>/pathname`），那是唯一权威来源。

⚠ 走 Unity 自己的 ImportPackage 也躲不掉：实测它把先导入那个包的整个
`Material` 文件夹**搬到了后一个包的路径下**（两个包的文件夹 GUID 也相同），
顺带让后一个包里同路径的 `ash.mat` 从头到尾没落盘。
"""
import os, re, sys, io, tarfile, hashlib

def unpack(pkg, project, dry=False, only_new_guids=False, have_guids=None, exclude_ext=(".exe", ".bat", ".cmd", ".ps1", ".dll.config")):
    """把一个 .unitypackage 解到 project/Assets 下。返回 (写入数, 跳过数, 冲突数)."""
    paths, metas, assets = {}, {}, {}
    clashes = []
    # "r:*"：也接受先解压成的普通 tar。按路径排序落盘会在 gzip 流里反复回跳（每次回跳从头解压），大包要十几分钟；
    # 普通 tar 可以随机读。
    with tarfile.open(pkg, "r:*") as tf:
        for m in tf.getmembers():
            if not m.isfile():
                continue
            parts = m.name.replace("\\", "/").split("/")
            if len(parts) < 2:
                continue
            guid, kind = parts[-2], parts[-1]
            if kind == "pathname":
                paths[guid] = tf.extractfile(m).read().decode("utf-8", "replace").splitlines()[0].strip()
            elif kind == "asset":
                assets[guid] = m
            elif kind == "asset.meta":
                metas[guid] = m
        wrote = skipped = clash = 0
        del clashes[:]
        for guid, rel in sorted(paths.items(), key=lambda kv: kv[1]):
            # 只解新 GUID：公共资产工程里已经有了，再写一份就是同 GUID 两个路径
            if only_new_guids and have_guids is not None and guid in have_guids:
                skipped += 1
                continue
            rel = rel.replace("\\", "/").lstrip("/")
            if not rel.startswith("Assets/"):
                rel = "Assets/" + rel
            if os.path.splitext(rel)[1].lower() in exclude_ext:
                skipped += 1
                print(f"    [skip-ext] {rel}")
                continue
            dst = os.path.join(project, *rel.split("/"))
            if guid in assets:
                data = tf.extractfile(assets[guid]).read()
                if os.path.exists(dst):
                    old = open(dst, "rb").read()
                    if hashlib.md5(old).digest() != hashlib.md5(data).digest():
                        clash += 1
                        print(f"    [conflict] {rel}  （已存在且内容不同，保留旧的）")
                        continue
                    # 同内容已在：不重写，但仍走下面的 .meta 检查——同名同内容、不同 GUID 正是 Gem_1.mat 那种撞车，
                    # 原先在这里直接跳过就查不到；上次解到一半中断、缺 .meta 的也在下面补上。
                    skipped += 1
                else:
                    if not dry:
                        os.makedirs(os.path.dirname(dst), exist_ok=True)
                        open(dst, "wb").write(data)
                    wrote += 1
            else:
                if not dry:
                    os.makedirs(dst, exist_ok=True)     # 文件夹条目
            if guid in metas:
                mp = dst + ".meta"
                incoming = tf.extractfile(metas[guid]).read()
                if os.path.exists(mp):
                    # ⚠ 同路径、不同 GUID = GUID 撞车。
                    # 两个包发同名同内容的公共材质却各自带不同 GUID 时，
                    # 「.meta 已存在就不写」会**悄悄丢掉后来者的 GUID**，
                    # 引用它的预制体就断链、渲染成洋红，而 shader 清单里查不出来。
                    # 实测：GoldenHour 与 SweetyHair 共用的 Gem_1.mat 就是这么断的。
                    old_g = _guid_of(open(mp, "rb").read())
                    new_g = _guid_of(incoming)
                    if old_g and new_g and old_g != new_g:
                        clashes.append((rel, old_g, new_g))
                elif not dry:
                    os.makedirs(os.path.dirname(mp), exist_ok=True)
                    open(mp, "wb").write(incoming)
    return wrote, skipped, clash, clashes


def _guid_of(b):
    m = re.search(rb"^guid:\s*([0-9a-f]{32})", b, re.M)
    return m.group(1).decode() if m else None


def project_guids(project):
    """工程里已有的全部 GUID（Assets + Packages 的 .meta）。"""
    have = set()
    for root in ("Assets", "Packages"):
        base = os.path.join(project, root)
        if not os.path.isdir(base):
            continue
        for dp, dn, fn in os.walk(base):
            if os.sep + "Library" in dp or os.sep + "Temp" in dp:
                continue
            for f in fn:
                if not f.endswith(".meta"):
                    continue
                try:
                    g = _guid_of(open(os.path.join(dp, f), "rb").read(300))
                except OSError:
                    continue
                if g:
                    have.add(g)
    return have


def scan_broken_refs(project):
    """全工程扫断链 GUID：被引用但工程里不存在的。导入完必跑。"""
    have = set()
    for root in ("Assets", "Packages"):
        base = os.path.join(project, root)
        if not os.path.isdir(base):
            continue
        for dp, dn, fn in os.walk(base):
            if os.sep + "Library" in dp or os.sep + "Temp" in dp:
                continue
            for f in fn:
                if not f.endswith(".meta"):
                    continue
                try:
                    head = open(os.path.join(dp, f), "rb").read(300)
                except OSError:
                    continue
                g = _guid_of(head)
                if g:
                    have.add(g)
    broken = {}
    exts = (".prefab", ".unity", ".mat", ".asset", ".controller", ".anim")
    for dp, dn, fn in os.walk(os.path.join(project, "Assets")):
        for f in fn:
            if not f.endswith(exts):
                continue
            p = os.path.join(dp, f)
            try:
                t = open(p, "r", encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            for g in set(re.findall(r"guid:\s*([0-9a-f]{32})", t)):
                # Unity 内置资源的 GUID 形如 0000000000000000?000000000000000，
                # 工程里没有对应 .meta 是正常的，不是断链。
                if re.fullmatch(r"0{16}[0-9a-f]0{15}", g):
                    continue
                if g not in have:
                    broken.setdefault(g, []).append(os.path.relpath(p, project))
    return broken

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    proj = sys.argv[1]
    argv = [a for a in sys.argv if a != "--only-new-guids"]
    only_new = len(argv) != len(sys.argv)
    sys.argv = argv
    have = project_guids(proj) if only_new else None
    if only_new:
        print(f"只解新 GUID 模式：工程里已有 {len(have)} 个 GUID")
    if sys.argv[2] == "--list":
        pkgs = [l.strip() for l in io.open(sys.argv[3], encoding="utf-8") if l.strip() and not l.startswith("#")]
    else:
        pkgs = sys.argv[2:]
    tw = ts = tc = 0
    for p in pkgs:
        if not os.path.exists(p):
            print(f"!! 缺失 {p}")
            continue
        w, s, c, cl = unpack(p, proj, only_new_guids=only_new, have_guids=have)
        for rel, og, ng in cl:
            print(f"    [GUID撞车] {rel}  已有={og[:8]} 新包={ng[:8]}  → 新包的引用会断链")
        tw += w; ts += s; tc += c
        print(f"  {os.path.basename(p):60s} 写入 {w:5d}  跳过 {s:4d}  冲突 {c:3d}")
    print(f"\n合计 写入 {tw} / 跳过 {ts} / 冲突 {tc}")
    print("\n=== 断链扫描（被引用但工程里不存在的 GUID）===")
    broken = scan_broken_refs(proj)
    if not broken:
        print("  无断链")
    for g, users in sorted(broken.items(), key=lambda kv: -len(kv[1]))[:30]:
        print(f"  {g}  被 {len(users)} 个资产引用，例：{users[0]}")
    print("  （已滤掉 Unity 内置资源；lilToon 可选槽等惰性引用仍可能是假阳性，"
          "判定前先查对应的 _UseXxx 开关）")
