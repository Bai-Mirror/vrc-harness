// 【项目沉淀】通用工具（Harness performance 阶段的 Unity 步骤）
// 适用素体：无关
// 工具链　：Unity 2022.3 批处理；VRChat SDK AvatarPerformance
// 可复用性：★★★ 换个单子直接能用
// 用途　　：在 final 构建副本的产物上量性能（SOP 80），基线是 pre 构建（优化前）产物旁的 perf.json：
//           骨、形态键、蒙皮网格不增，面数不变（AAO 只删不减面）；贴图不越档、不未压缩、都开 Mip Streaming、
//           主图不降到 2048 红线以下（源图本来就小的按源图算）、没有比基线更大的图、贴图显存下降；PhysBone 与包围盒不超限。
//           另从产物的构建清单读 NDMF 报错，写 avatar.build。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace AVH.Harness
{
    public static class PerformanceStage
    {
        public static void Run() => Avh.Stage("performance", () =>
        {
            var notes = new List<string>();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(BuildStage.BuiltPrefab) ?? throw new Exception($"构建产物不存在：{BuildStage.BuiltPrefab}");
            var built = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            Dictionary<string, object> now;
            try { now = Perf.Measure(built); }
            finally { UnityEngine.Object.DestroyImmediate(built); }
            var prePath = Path.GetFullPath(Path.Combine(Avh.ProjectIdentityDir, "..", "..", "pre", "project", BuildStage.OutDir, "perf.json"));
            // Cross-project reads use physical identity; this spelling also keeps Mono's long-path IO working.
            var readPath = Application.platform == RuntimePlatform.WindowsEditor
                ? (prePath.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + prePath.Substring(2) : @"\\?\" + prePath) : prePath;
            var pre = Avh.ReadJsonFile(readPath);
            if (pre == null) notes.Add($"没有 pre 构建的性能基线 {prePath}");

            var textures = now.List("textures").Cast<Dictionary<string, object>>().ToList();
            // What this run itself wrote: build_copy.py's record of the import plan it applied to this copy. Without
            // it the only honest reading is "no texture's import settings were written by this run".
            var applied = Avh.ReadJsonFile(Avh.Abs(".texture_plan_applied.json"));
            if (applied == null)
                notes.Add("构建副本里没有 .texture_plan_applied.json：本次没有可证明由 Harness 写过的导入设置，没有 pre 基线的主图按厂商原样读取");
            var audit = TextureAudit(now, pre, notes, applied);
            var aabb = now.List("aabb").Select(Convert.ToDouble).ToList();
            object Base(string key) => pre != null && pre.TryGetValue(key, out var v) ? v : null;
            var metrics = new Dictionary<string, object>
            {
                ["measured_target_is_clone"] = Avh.ProjectIdentityDir.Replace('\\', '/').Contains("/_harness_build/") && prefab != null,
                ["uncompressed_texture_count"] = audit["uncompressed_texture_count"],
                ["textures_without_mipstreaming"] = audit["textures_without_mipstreaming"],
                ["texture_tier_audit_failures"] = audit["texture_tier_audit_failures"],
                ["min_main_texture_max_size"] = audit["min_main_texture_max_size"],
                ["textures_above_baseline"] = audit["textures_above_baseline"],
                ["textures_carried_over_from_vendor"] = audit["textures_carried_over_from_vendor"],
                ["bones"] = now["bones"], ["baseline_bones"] = Base("bones"),
                ["blendshapes"] = now["blendshapes"], ["baseline_blendshapes"] = Base("blendshapes"),
                ["skinned_meshes"] = now["skinned_meshes"], ["baseline_skinned_meshes"] = Base("skinned_meshes"),
                // 面数只比「有可能被看见」的：从来不可见的网格 AAO 会删，不算减面（SOP 80「AAO 不减面」说的是可见几何）
                ["triangles"] = Visible(now), ["baseline_triangles"] = pre == null ? null : Visible(pre),
                ["physbone_count"] = now["physbone_count"], ["duplicate_physbones"] = now["duplicate_physbones"],
                ["invalid_merge_physbones"] = now["invalid_merge_physbones"],
                ["physbone_core_humanoid_coverage"] = now["physbone_core_humanoid_coverage"],
                ["noop_physbones"] = now["noop_physbones"],
                ["aabb_x"] = aabb[0], ["aabb_y"] = aabb[1], ["aabb_z"] = aabb[2],
                ["texture_memory_after"] = now["texture_megabytes"], ["baseline_texture_memory"] = Base("texture_megabytes"),
            };
            // AAO 把可去掉的中间物体压平成 `_Outfit$Outfit_a$9`，比较前把名字还原成原路径
            string Unflatten(string key) => System.Text.RegularExpressions.Regex.Replace(key, @"\$\d+(?=/|#)", "").Replace('$', '/');
            var trisBefore = (pre?.Obj("renderer_triangles") ?? new Dictionary<string, object>()).GroupBy(kv => Unflatten(kv.Key)).ToDictionary(g => g.Key, g => g.First().Value);
            var trisNow = (now.Obj("renderer_triangles") ?? new Dictionary<string, object>()).GroupBy(kv => Unflatten(kv.Key)).ToDictionary(g => g.Key, g => g.First().Value);
            var dupObjects = now.List("duplicate_physbone_objects");
            if (dupObjects.Count > 0) notes.Add("逐字段相同的重复 PhysBone 在：" + string.Join(", ", dupObjects.Take(8)));
            if (Convert.ToInt32(now["invalid_merge_physbones"]) > 0)
                notes.Add("无效 AAO MergePhysBone：" + string.Join(", ", now.List("invalid_merge_physbone_objects").Take(8)));
            if (Convert.ToInt32(now["physbone_core_humanoid_coverage"]) > 0)
                notes.Add("PhysBone 覆盖人形核心骨：" + string.Join(", ", now.List("physbone_core_humanoid_paths").Take(8)));
            if (Convert.ToInt32(now["noop_physbones"]) > 0)
                notes.Add("无子骨且无 Endpoint 的 PhysBone 候选（仅报告，未自动删除）：" + string.Join(", ", now.List("noop_physbone_objects").Take(8)));
            var lost = trisBefore.Where(kv => !trisNow.TryGetValue(kv.Key, out var n) || Convert.ToInt32(n) != Convert.ToInt32(kv.Value))
                .Select(kv => $"{kv.Key} {kv.Value}→{(trisNow.TryGetValue(kv.Key, out var n) ? n : "无")}").ToList();
            if (lost.Count > 0) notes.Add($"面数有变化的渲染器 {lost.Count} 个：" + string.Join("；", lost.Take(8)));
            notes.Add($"贴图 {textures.Count} 张；显存 {Base("texture_megabytes")} → {now["texture_megabytes"]} MB；骨 {Base("bones")} → {now["bones"]}；" +
                      $"形态键 {Base("blendshapes")} → {now["blendshapes"]}；面 {Base("triangles")} → {now["triangles"]}（其中从来不可见的 {Base("never_visible_triangles")} → {now["never_visible_triangles"]}）");
            Avh.WriteJson(Path.Combine(Avh.RunDir, "perf-final.json"), now);
            Avh.Observation("performance.check", metrics, notes);

            var manifest = Avh.ReadJsonFile(Avh.Abs(BuildStage.OutDir + "/build_manifest.json"));
            var buildNotes = new List<string>();
            Avh.Observation("avatar.build", new Dictionary<string, object>
            {
                ["build_ok"] = manifest?.Str("status") == "ok",
                ["ndmf_error_logs"] = BuildStage.NdmfErrors(manifest?.Obj("ndmf"), manifest?.Obj("logs"), buildNotes),
            }, buildNotes);
        }, save: false);

        /// <summary>
        /// The texture audit's metrics, from one Perf.Measure result plus the pre-build baseline. A texture is judged as
        /// art when it has a visual binding ("main"/"aux"/"cube"): a data binding never excuses an art binding on the same
        /// asset, so a texture bound both ways is a reported conflict and is still audited by its visual role. Only
        /// data-only textures are outside every format, tier, mip and size metric: the import plan neither compresses nor
        /// resizes them, and they stay in the evidence list and in the SDK's total texture memory (the now/baseline
        /// texture_megabytes reading, which the SDK computes).
        /// The baseline counts as a complete measurement only when perf.json really carries a texture array; a missing
        /// key, a wrong type or a visual entry with no usable size keeps textures_above_baseline unmeasured rather than
        /// reading as an empty or zero baseline.
        /// `appliedPlan` is build_copy.py's `.texture_plan_applied.json`, the only evidence of which import settings this
        /// run itself wrote. It decides one case: a main texture with no pre-build reading. The old fallback used the
        /// source image's pixel size, so a vendor texture whose own `.meta` already says `maxTextureSize: 128` read as
        /// "the harness lowered this main below the red line" even though the plan never named it.
        /// Every metric is judged over the textures this run is answerable for: the pre build's own inventory (the
        /// optimize design was given exactly that set, so the plan covers it) plus the import settings the applied plan
        /// wrote. A texture in neither was never named by the design and never written by this run, so what ships is its
        /// own import setting; it is reported by path and counted in `textures_carried_over_from_vendor` instead of
        /// failing a metric this run could not have governed.
        /// </summary>
        public static Dictionary<string, object> TextureAudit(Dictionary<string, object> now, Dictionary<string, object> pre, List<string> notes,
            Dictionary<string, object> appliedPlan = null)
        {
            var textures = now.List("textures").Cast<Dictionary<string, object>>().ToList();
            var audited = textures.Where(t => VisualRole(t) != null).ToList();
            var dataOnly = textures.Where(DataOnly).ToList();
            var mixed = textures.Where(t => t.Str("role") == OptimizeStage.DataRole && VisualRole(t) != null).ToList();
            if (dataOnly.Count > 0) notes.Add("插件数据纹理（不参与压缩／分档／尺寸审计）：" + string.Join(", ",
                dataOnly.Take(5).Select(t => $"{t.Str("path")}({t.Str("width")}x{t.Str("height")})")));
            if (mixed.Count > 0) notes.Add("绑定冲突：同一张图既绑插件数据属性又绑视觉属性，视觉审计仍按视觉角色校验（压缩或缩放会破坏其数据）："
                + string.Join(", ", mixed.Take(5).Select(t => $"{t.Str("path")}(数据 + {VisualRole(t)})")));
            int Effective(Dictionary<string, object> t) => Math.Min(Int(t, "max_size") ?? RecordedSize(t) ?? 0, Int(t, "source_size") ?? RecordedSize(t) ?? 0);
            int Tier(string role) => role == "main" ? OptimizeStage.Main : role == "cube" ? OptimizeStage.Cube : OptimizeStage.Aux;
            // Main art is bounded by the red line and the person's approval, not by its tier: kept above 2048 it is reported, not failed.
            var mainAbove = audited.Where(t => VisualRole(t) == "main" && Effective(t) > OptimizeStage.Main).ToList();
            if (mainAbove.Count > 0) notes.Add("主图超过 2048、按设计保留：" + string.Join(", ", mainAbove.Take(5).Select(t => $"{t.Str("path")}({Effective(t)})")));
            var baseline = BaselineTextures(pre, notes);
            var before = (baseline ?? new List<Dictionary<string, object>>())
                .Where(t => VisualRole(t) != null)
                .GroupBy(t => t.Str("guid")).ToDictionary(g => g.Key, g => Effective(g.First()));
            var edited = AppliedEdits(appliedPlan);
            // 这次运行该为哪些贴图负责，压缩／分档／尺寸三条都按这个集合判。`before` 是 pre 构建自己的盘点——优化设计
            // 拿到的就是这一份，方案必然覆盖它；`edited` 是套用明细里本次真的写过的导入设置。两者都不在的贴图，设计
            // 从没点过、本次也没写过，交付的就是它原本的导入设置：把它算到 Harness 头上，正是把厂商自己的
            // `maxTextureSize: 128` 主图和 6 张厂商 2048 辅助图（A 上只在 final 出现的 15 张）读成 Harness 违规的原因。
            // 这些贴图仍逐条记进 notes 与回执，不静默丢掉。pre 基线不完整时不豁免任何一张：没有可归属的盘点时，
            // 严格判才是诚实的方向。
            var carriedOver = new List<string>();
            bool Answerable(Dictionary<string, object> t)
            {
                if (baseline == null) return true;
                if (before.ContainsKey(t.Str("guid"))) return true;
                if (edited.ContainsKey(t.Str("guid") ?? "") || edited.ContainsKey(t.Str("path") ?? "")) return true;
                if (!carriedOver.Contains(t.Str("path"))) carriedOver.Add(t.Str("path"));
                return false;
            }
            var judged = audited.Where(Answerable).ToList();
            if (carriedOver.Count > 0) notes.Add("只出现在构建期、本次没有写过导入设置的贴图（按厂商原样交付，不计入压缩／分档／尺寸违规）："
                + string.Join(", ", carriedOver.Take(5)));
            var overTier = judged.Where(t => VisualRole(t) != "main" && Effective(t) > Tier(VisualRole(t))).ToList();
            // 主图红线（用户 2026-09-01）：我们不把主图降到 2048 以下。对照 pre 构建（优化前）的实际尺寸：
            // 不低于 min(2048, 优化前) 的记 2048，低于的记实际尺寸；厂商本来就压小的图不算我们降的。
            var mains = judged.Where(t => VisualRole(t) == "main").ToList();
            int Floor(Dictionary<string, object> t)
            {
                if (before.TryGetValue(t.Str("guid"), out var b)) return Math.Min(OptimizeStage.Main, b);
                // 能走到这里的只可能是本次自己写过的贴图（否则 Answerable 已经把它排除了）。套用明细带回的改动前导入
                // 上限（与 max_size 同一口径）就是「优化前」；明细里没有这个数字时仍退到 source_size，严格方向不放行。
                int? preEditLimit = null;
                edited.TryGetValue(t.Str("guid") ?? "", out preEditLimit);
                if (preEditLimit == null) edited.TryGetValue(t.Str("path") ?? "", out preEditLimit);
                return Math.Min(OptimizeStage.Main, Math.Min(preEditLimit ?? Int(t, "source_size") ?? OptimizeStage.Main,
                    Int(t, "source_size") ?? OptimizeStage.Main));
            }
            // 完整盘点后没有主图（合法纯材质颜色形态）是已证实的空适用集合，不是「没测到」：沿用主图的规范化记 2048。
            // 缺 pre 基线仍由 textures_above_baseline=null 判 no_data，不在这里放行。基线里没有、本次也没写过的贴图
            // 不在 mains 里，本来就不该判成「我们把它降了」。
            var mainFloor = mains.Count == 0 ? OptimizeStage.Main : mains.Min(t => Effective(t) >= Floor(t) ? OptimizeStage.Main : Effective(t));
            var belowFloor = mains.Where(t => Effective(t) < Floor(t)).Select(t => $"{t.Str("path")}({Effective(t)} < {Floor(t)})").ToList();
            if (belowFloor.Count > 0) notes.Add("主图降到红线以下：" + string.Join(", ", belowFloor.Take(5)));
            var above = audited.Count(t => before.TryGetValue(t.Str("guid"), out var b) && Effective(t) > b);
            var uncompressed = judged.Where(t => Equals(t["uncompressed"], true)).Select(t => t.Str("path")).ToList();
            var noStreaming = judged.Where(t => Equals(t["streaming_mipmaps"], false)).Select(t => t.Str("path")).ToList();
            if (overTier.Count > 0) notes.Add("越档：" + string.Join(", ", overTier.Take(5).Select(t => $"{t.Str("path")}({VisualRole(t)} {Effective(t)})")));
            if (uncompressed.Count > 0) notes.Add("未压缩：" + string.Join(", ", uncompressed.Take(5)));
            if (noStreaming.Count > 0) notes.Add("没开 Mip Streaming：" + string.Join(", ", noStreaming.Take(5)));
            return new Dictionary<string, object>
            {
                ["uncompressed_texture_count"] = uncompressed.Count,
                ["textures_without_mipstreaming"] = noStreaming.Count,
                ["texture_tier_audit_failures"] = overTier.Count,
                ["min_main_texture_max_size"] = mainFloor,
                ["textures_above_baseline"] = baseline == null ? (int?)null : above,
                ["textures_carried_over_from_vendor"] = carriedOver.Count,
            };
        }

        static object Visible(Dictionary<string, object> perf) =>
            Convert.ToInt32(perf["triangles"]) - (perf.TryGetValue("never_visible_triangles", out var n) && n != null ? Convert.ToInt32(n) : 0);

        static int? Int(Dictionary<string, object> d, string key) => d.TryGetValue(key, out var v) && v != null ? Convert.ToInt32(v) : (int?)null;

        /// <summary>
        /// The art role an inventory entry is audited under, or null when it only carries plugin data. Entries written
        /// before the two uses were separated carry no visual_role; their plan role is the only evidence, and a data role
        /// there meant "not audited as art" under the old tool as well.
        /// </summary>
        static string VisualRole(Dictionary<string, object> t)
        {
            var role = t.Str("role");
            if (role != null && role != OptimizeStage.DataRole && !KnownVisualRole(role)) return null;
            var visual = t.Str("visual_role");
            if (visual != null) return KnownVisualRole(visual) ? visual : null;
            return KnownVisualRole(role) ? role : null;
        }

        static bool KnownVisualRole(string role) => role == "main" || role == "aux" || role == "cube";

        /// <summary>
        /// True only for an entry that explicitly declares the data-only use: the import plan must not compress or resize
        /// it, so it carries no visual size to compare. A missing or unrecognized role is not an exemption — such an
        /// entry may be art whose writer simply recorded no size. Reading it as "nothing to check" both certified the
        /// baseline and dropped the entry out of the comparison, so `{"path":"old.png","guid":"g"}` certified a size
        /// dimension that was never measured.
        /// </summary>
        static bool DataOnly(Dictionary<string, object> t) => t.Str("role") == OptimizeStage.DataRole && t.Str("visual_role") == null;

        /// <summary>
        /// The pre-build texture inventory, or null when it is not a complete measurement. An explicit `[]` is a complete
        /// empty inventory (a colour-only avatar with no textures at all); a missing key, a wrong type, a non-object entry
        /// or a visual entry with no usable size is "not measured". Folding those into an empty list let a perf.json that
        /// reported every other metric but no textures read as "no texture grew" and, with no main art, as a passing 2048.
        /// </summary>
        static List<Dictionary<string, object>> BaselineTextures(Dictionary<string, object> pre, List<string> notes)
        {
            if (pre == null || !pre.TryGetValue("textures", out var raw))
            {
                notes.Add("pre 基线没有 textures 数组：纹理维度保持未测（no_data）");
                return null;
            }
            if (!(raw is List<object> list))
            {
                notes.Add("pre 基线的 textures 不是数组：纹理维度保持未测（no_data）");
                return null;
            }
            var entries = new List<Dictionary<string, object>>();
            foreach (var item in list)
            {
                if (!(item is Dictionary<string, object> entry))
                {
                    notes.Add("pre 基线的 textures 数组里有非对象条目：纹理维度保持未测（no_data）");
                    return null;
                }
                // 旧工具写的条目没有 max_size/source_size，回退到它记录的 width/height；两者都没有时不能当成 0，
                // 「比基线大」会因为 0 恒不成立而假通过。能让整条盘点成立的只有两种条目：明确的数据专用条目
                // （role=data 且没有视觉绑定，本来就没有视觉尺寸可比），以及能认出视觉角色、且有可用尺寸的条目。
                // 「认不出角色」和「没有尺寸」都必须判未测：认不出角色的条目既会被当成有效基线、又会被排除出
                // `before` 比较（它可能正是没量过尺寸的视觉图），等于把没量过的维度判成「没变大」。
                var usable = DataOnly(entry) || (VisualRole(entry) != null && EffectiveSize(entry) != null);
                if (!usable)
                {
                    notes.Add(VisualRole(entry) == null
                        ? $"pre 基线的纹理条目没有可识别的视觉角色（{entry.Str("path")}）：无法判断它是否参与视觉审计，纹理维度保持未测（no_data）"
                        : $"pre 基线的纹理条目没有可用的宽高（{entry.Str("path")}）：纹理维度保持未测（no_data）");
                    return null;
                }
                entries.Add(entry);
            }
            return entries;
        }

        /// <summary>
        /// The import settings this run itself wrote, from build_copy.py's `.texture_plan_applied.json` at the build
        /// copy root: guid (or path for an entry that recorded no guid) -> the max texture size the entry had before
        /// the plan was applied, in the same reading as `max_size` (the Standalone override when it was set, else the
        /// importer's own limit). Only an entry the plan actually rewrote counts; an entry the plan listed but left
        /// byte-identical is an entry we did not change. A null value means the record carried no number, and a
        /// missing record means this run wrote nothing — build_copy.py writes the record on the same step that
        /// creates the copy, so a final build without it did not apply any import setting either.
        /// </summary>
        static Dictionary<string, int?> AppliedEdits(Dictionary<string, object> appliedPlan)
        {
            var edits = new Dictionary<string, int?>();
            foreach (var change in appliedPlan.List("texture_changes").Cast<Dictionary<string, object>>())
            {
                if (change.TryGetValue("unchanged", out var unchanged) && Equals(unchanged, true)) continue;
                if (change.ContainsKey("error")) continue;
                var rollback = change.Obj("rollback");
                int? before = null;
                if (rollback != null)
                    before = rollback.TryGetValue("standalone_overridden", out var overridden) && Equals(overridden, true)
                        ? Int(rollback, "standalone_max_texture_size") : Int(rollback, "max_texture_size");
                foreach (var key in new[] { change.Str("guid"), change.Str("path") })
                    if (!string.IsNullOrEmpty(key)) edits[key] = before;
            }
            return edits;
        }

        /// <summary>The size a baseline entry can be compared at, or null when it records no usable one.</summary>
        static int? EffectiveSize(Dictionary<string, object> t)
        {
            var max = Int(t, "max_size") ?? RecordedSize(t);
            var source = Int(t, "source_size") ?? RecordedSize(t);
            if (max == null || source == null) return null;
            var size = Math.Min(max.Value, source.Value);
            return size > 0 ? size : (int?)null;
        }

        /// <summary>
        /// The size recorded beside an entry that has no import limit. Baselines written before the real-size fix
        /// carry no max_size/source_size for textures without a TextureImporter; their recorded pixel size is the
        /// honest effective size, so such a baseline reads the same as one written now instead of as infinite.
        /// Null when the entry records no pixel size either.
        /// </summary>
        static int? RecordedSize(Dictionary<string, object> t)
        {
            var width = Int(t, "width"); var height = Int(t, "height");
            return width == null && height == null ? (int?)null : Math.Max(width ?? 0, height ?? 0);
        }
    }
}
