# -*- coding: utf-8 -*-
"""
【项目沉淀】通用工具
适用素体：无关          相关素材：无
可复用性：★★★ 换个单子直接能用
用途    ：比对「工程 locked 段的版本」与「VCC 缓存里可得的最新稳定版」，
          并把各包声明的依赖天花板打印出来。
          决定要不要动工具链基准时跑它，见 ../_工具链基准.md。

用法：
    python vpm_baseline_check.py <工程目录>
    python vpm_baseline_check.py              # 不给参数就用当前目录

要查哪些包**不写死清单**，以工程 locked 段实际有什么为准 —— 写死会漏掉本单新加的包。

坑：
  * 预发布版号写法不统一：除 -alpha/-beta/-rc/-pre 之外还有 `-pr6` 这种。
    判据一律用「版本号里有没有连字符」，**别去枚举后缀名** ——
    枚举漏一个就会把预发布当成最新版报上去。
    实测：枚举式正则把 gesture-manager 的 `3.9.9-pr6` 误报成「有更新」。
  * VCC 的 Repos 目录里同一个源有多份历史快照（文件名带哈希），
    要把所有快照的版本并集起来看，只读最新一份会漏版本。
"""
import os, sys, json, glob, re

REPOS = (os.path.expandvars(r"%LOCALAPPDATA%\VRChatCreatorCompanion\Repos") if os.name == "nt"
         else os.path.join(os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "VRChatCreatorCompanion", "Repos"))
PROJ = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.getcwd()
MANIFEST = os.path.join(PROJ, "Packages", "vpm-manifest.json")


def is_prerelease(v):
    """任何带连字符的版号都算预发布。别枚举后缀 —— `-pr6` 就漏在枚举之外。"""
    return "-" in v


def vkey(v):
    m = re.match(r"(\d+)\.(\d+)\.(\d+)", v)
    base = tuple(int(x) for x in m.groups()) if m else (0, 0, 0)
    return (base, 0 if is_prerelease(v) else 1, v)


def main():
    if not os.path.isfile(MANIFEST):
        sys.exit("找不到 %s\n第一个参数要给工程目录（含 Packages/vpm-manifest.json）" % MANIFEST)
    locked = json.load(open(MANIFEST, encoding="utf-8"))["locked"]
    want = list(locked.keys())
    print("工程：%s\n" % PROJ)

    found = {}
    for f in sorted(glob.glob(os.path.join(REPOS, "*.json")), key=os.path.getmtime, reverse=True):
        try:
            j = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(j, dict):
            continue
        pkgs = j.get("packages") or {}
        if not pkgs and isinstance(j.get("repo"), dict):
            pkgs = j["repo"].get("packages", {})
        for name, blk in pkgs.items():
            if name not in want:
                continue
            vers = list((blk.get("versions") or {}).keys())
            if vers:
                found.setdefault(name, set()).update(vers)

    print("%-45s%-14s%-16s%s" % ("包", "工程锁定", "缓存最新稳定", "差距"))
    print("-" * 95)
    upgradable = []
    for n in want:
        lock = locked.get(n, {}).get("version", "—")
        if n not in found:
            print("%-45s%-14s%-16s" % (n, lock, "(缓存无该源)"))
            continue
        stable = sorted([v for v in found[n] if not is_prerelease(v)], key=vkey)
        newest = stable[-1] if stable else "—"
        gap = ""
        if newest != "—" and newest != lock:
            if vkey(newest) > vkey(lock):
                gap = "↑ 有更新"
                upgradable.append((n, lock, newest))
            else:
                gap = "工程更新"
        print("%-45s%-14s%-16s%s" % (n, lock, newest, gap))

    print("\n=== 约束天花板（各包 locked 段声明的依赖）===")
    print("升级前先看这里 —— 三个包把 SDK 卡在 3.11 以下，SDK 一升会同时打断它们。")
    for n, blk in locked.items():
        for dep, rng in (blk.get("dependencies") or {}).items():
            if dep in ("com.vrchat.avatars", "nadena.dev.ndmf"):
                print("  %-45s 要求 %s %s" % (n, dep, rng))

    print("\n=== 小结 ===")
    if upgradable:
        print("可升级 %d 个：" % len(upgradable))
        for n, a, b in upgradable:
            print("  %s  %s → %s" % (n, a, b))
        print("\n⚠ **单子进行中不要升**（SOP 硬闸②：一次只落一个改动）。")
        print("   把这份清单留到交付后的空档，作为下一次基准的候选集。")
    else:
        print("没有可升级的包 —— 当前基准已是缓存里的最新稳定版。")


if __name__ == "__main__":
    main()
