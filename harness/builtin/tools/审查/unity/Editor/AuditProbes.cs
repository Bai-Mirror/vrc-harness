// ══════════════════════════════════════════════════════════════════
// 【项目沉淀】通用工具 · 客户单审查 T1「纯数据探针」
// 适用素体：任意 Humanoid 头像（VRChat 3.x / Unity 2022.3）
// 相关素材：无
// 工具链　：Unity 2022.3.22f1（Editor 程序集；只用 UnityEngine / Unity.Collections，
// 　　　　　不依赖 UnityEditor / VRChat / MA / 任何第三方程序集）
// 　　　　　例外（任务 BQ）：`delete_coverage` 转调 AuditDeleteCoverage.cs，那一支用 UnityEditor
// 　　　　　（编辑模式快照 + 菜单）；本文件自身仍不直接 using UnityEditor。
// 可复用性：★★★ 换单子直接复制到 <工程>/Assets/Editor/AvatarAudit/
// 用途　　：T1 的补充量具。T1 快照记的是「谁可见、材质是谁、形态键多少」；本文件在此之上
// 　　　　　对**同一个已施加参数的状态**再跑四个纯几何/材质探针，把过去只能靠渲图或手写
// 　　　　　execute_code 才能看见的缺陷变成结构化数字。设计动机见
// 　　　　　`_长程任务_20260918/感知机制研究/00_当日补充_1830.md`：
// 　　　　　· grab_chain  ：抓屏（GrabPass）材质的最小 renderQueue = 抓取点；队列 ≥ 它、非抓屏、
// 　　　　　                <4000 的可见材质，透过抓屏窗口看不见（工程A 头饰 2450 顶掉发型 2460）。
// 　　　　　· coincident  ：两件几乎重合的网格同时可见（外套与其备选件 70% 顶点 ≤0.5 mm）。
// 　　　　　· containment ：封闭件（鞋/靴/手套）有没有把对应身体部位包住（MMN 鞋脚趾 2%→100%）。
// 　　　　　· range       ：非零形态键里权重 <0 或 >100（VRChat 客户端会钳到 0–100）。
//
// 调用契约（只给 T1 用，T2/T3 等不调）：
//   var report = AuditProbes.Run(ctx, avatar, anim, requestedProbeNames);
//   report.Json  -> 写进 state_<id>.json 的 "probes" 字段（键=探针名，值=该探针输出）
//   report.Hits  -> 键=探针名，值=该探针本状态命中数（states.json 汇总用）
// 全部同步执行；内部临时物体/Mesh/Physics 开关在 finally 里恢复与销毁，不 MarkSceneDirty。
//
// 探针是「附加信息」，单个探针抛异常只记 warning + 在输出里写 error，不拖垮 T1。
// ══════════════════════════════════════════════════════════════════

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;

namespace AvatarAudit
{
    /// <summary>一次 Run 的返回值。Json 是给 state_*.json 的 probes 字段；Hits 是汇总命中数。</summary>
    public sealed class AuditProbeReport
    {
        public JsonObject Json;
        public Dictionary<string, int> Hits;
    }

    public static class AuditProbes
    {
        /// <summary>默认抓屏材质着色器名正则（任务书给定）。请求可用 grab_shader_regex 覆盖。</summary>
        public const string DefaultGrabShaderRegex =
            "lilToonGem|lilToonRefraction|lilToonMultiGem|lilToonMultiRefraction|LilBugShader/Refraction";

        // 任务 CS（T-33，shrink_cover）：默认排除的表情/面部键正则（auto_nonzero 用）。可被请求 shrink_cover.keys_exclude_regex 覆盖。
        public const string DefaultShrinkKeysExcludeRegex = "(?i)^(vrc\\.|eye|mouth|brow|blink|tongue|face|extra_)";
        // 任务 CS/CT：默认不当作「遮挡服装」的可见 SMR 词表（美甲/毛发/面部件等）。可被 shrink_cover.garments_exclude 覆盖。
        // ⚠ 任务 CT 修：口径改成「只拿叶子 GameObject 名，整名或分隔符断开的词完整匹配」（ShrinkCoverRules.ExcludeHit）。
        //   旧串 `(?i)(...|ear|head|...)` + 路径/子串匹配会把 `_Outfit/LopEarMine/...` 整套衣服排除（第一次实跑 100% 误报）。
        //   默认串本身也加了 `^...$` 锚点；请求传无锚点旧串时由 FullMatch 兜住，同样不会子串命中 `LopEarMine`。
        public const string DefaultShrinkGarmentsExcludeRegex = ShrinkCoverRules.DefaultExcludeRegex;

        public const int DefaultTempLayer = 30;   // 与 T2 同层约定；只放临时 MeshCollider
        public const int InsideVotesThreshold = 4; // 六方向里 ≥4 票奇数 = 在内（任务书给定）
        public const int MaxRayIterations = 30;    // 迭代射线最多 30 次（越过共面/多层壳）
        public const float RayAdvanceM = 1e-4f;    // 命中后沿方向前进量，避免原地重命中

        public static readonly string[] Known = { "grab_chain", "coincident", "containment", "range", "poke", "shrink_cover", "delete_coverage" };

        /// <summary>六方向：±X ±Y ±Z。</summary>
        private static readonly Vector3[] Directions =
        {
            Vector3.right, Vector3.left, Vector3.up, Vector3.down, Vector3.forward, Vector3.back
        };

        // containment 自动配对用的关键词。规则（对齐 t5_shapekey_matrix.py 的 match_any）：
        //   · CJK 关键词按子串匹配（中日文无词边界）；
        //   · ASCII 关键词按完整 token 匹配，长度 ≥4 时允许 token 以其为前缀（shoe→Shoes、boot→Boots）；
        //   · 只拿「渲染器所在 GameObject 的名字」做 token，不拿整条层级路径——
        //     否则路径里祖先名（如发饰 PixelBoot）会把子物体 windowA 误配成靴子。
        private static readonly string[] FootKeywords = { "shoe", "boot", "loafer", "heel", "sandal", "sneaker", "靴", "鞋" };
        private static readonly string[] HandKeywords = { "glove", "手袋" };

        private struct ProbeOut
        {
            public JsonObject Json;
            public int Hits;
        }

        // ────────────────────────────────────────────────────────────────
        // 入口
        // ────────────────────────────────────────────────────────────────

        public static bool IsKnown(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            for (int i = 0; i < Known.Length; i++) if (Known[i] == name) return true;
            return false;
        }

        /// <summary>
        /// 按 requested（已去重、已过滤为已知名）依次执行探针。单个探针失败只记 warning。
        /// </summary>
        public static AuditProbeReport Run(AuditContext ctx, GameObject avatar, Animator anim, List<string> requested)
        {
            var report = new AuditProbeReport();
            report.Json = new JsonObject();
            report.Hits = new Dictionary<string, int>(StringComparer.Ordinal);
            if (ctx == null || avatar == null || requested == null || requested.Count == 0) return report;

            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < requested.Count; i++)
            {
                string name = requested[i] == null ? null : requested[i].Trim();
                if (string.IsNullOrEmpty(name) || !seen.Add(name)) continue;

                ProbeOut r;
                try
                {
                    switch (name)
                    {
                        case "grab_chain": r = GrabChain(ctx, avatar); break;
                        case "coincident": r = Coincident(ctx, avatar, anim); break;
                        case "containment": r = Containment(ctx, avatar, anim); break;
                        case "range": r = Range(ctx, avatar); break;
                        case "poke": r = Poke(ctx, avatar, anim); break;
                        // 任务 CS（T-33）：收缩键遮挡一致性——身体收缩键开着时，它的影响顶点有没有被可见服装盖住。
                        case "shrink_cover": r = ShrinkCover(ctx, avatar, anim); break;
                        // 任务 BQ/BV：删除区覆盖检查。实现放在 AuditDeleteCoverage.cs；**只在编辑模式量**
                        // （菜单 Tools/AvatarAudit/Delete Coverage (Edit Mode)），Play 里 MA 已处理网格，
                        // 本支返回 undecidable。
                        case "delete_coverage":
                            {
                                int dcHits;
                                JsonObject dcJson = AuditDeleteCoverage.Run(ctx, avatar, anim, out dcHits);
                                r = new ProbeOut();
                                r.Json = dcJson;
                                r.Hits = dcHits;
                                break;
                            }
                        default: continue;
                    }
                }
                catch (Exception e)
                {
                    ctx.Warn("探针 " + name + " 执行失败：" + e.Message);
                    r = new ProbeOut();
                    r.Json = new JsonObject();
                    r.Json.Set("error", e.Message);
                    r.Hits = 0;
                }
                report.Json.Set(name, r.Json);
                report.Hits[name] = r.Hits;
            }
            return report;
        }

        // ────────────────────────────────────────────────────────────────
        // 探针 1：grab_chain（抓屏点 / 透过抓屏窗口看不见的可见材质）
        // ────────────────────────────────────────────────────────────────

        private static ProbeOut GrabChain(AuditContext ctx, GameObject avatar)
        {
            string pattern = ctx.S("grab_shader_regex", DefaultGrabShaderRegex);
            if (string.IsNullOrEmpty(pattern)) pattern = DefaultGrabShaderRegex;
            Regex re;
            try { re = new Regex(pattern, RegexOptions.CultureInvariant); }
            catch (Exception e)
            {
                ctx.Warn("grab_shader_regex 非法（" + e.Message + "），退回默认正则。");
                pattern = DefaultGrabShaderRegex;
                re = new Regex(pattern, RegexOptions.CultureInvariant);
            }

            var slots = VisibleSlots(avatar);
            var grab = new List<SlotInfo>();
            var hidden = new List<SlotInfo>();
            int minQueue = int.MaxValue;

            for (int i = 0; i < slots.Count; i++)
            {
                var s = slots[i];
                if (s.Shader == null || !re.IsMatch(s.Shader)) continue;
                grab.Add(s);
                if (s.Queue < minQueue) minQueue = s.Queue;
            }

            if (minQueue != int.MaxValue)
            {
                // 抓取点已知才谈得上「队列 ≥ 抓取点」；抓取点之后、4000 之前的非抓屏可见物会被顶掉。
                for (int i = 0; i < slots.Count; i++)
                {
                    var s = slots[i];
                    if (s.Shader != null && re.IsMatch(s.Shader)) continue;
                    if (s.Queue >= minQueue && s.Queue < 4000) hidden.Add(s);
                }
            }

            var o = new JsonObject();
            o.Set("grab_shader_regex", pattern);
            o.Set("grab_materials", SlotList(grab));
            o.Set("hidden_materials", SlotList(hidden));

            if (minQueue == int.MaxValue)
            {
                o.Set("grab_point_queue", null);
                o.Set("grab_point_materials", new List<object>());
                o.Set("grab_point_lt_3000", false);
                o.Set("hits", 0);
                o.Set("note", "本状态可见材质里没有匹配抓屏着色器的槽：要么没有抓屏窗口，要么着色器名不在默认正则里（可用 grab_shader_regex 覆盖）。");
            }
            else
            {
                var point = new List<SlotInfo>();
                for (int i = 0; i < grab.Count; i++) if (grab[i].Queue == minQueue) point.Add(grab[i]);
                o.Set("grab_point_queue", minQueue);
                o.Set("grab_point_materials", SlotList(point));
                o.Set("grab_point_lt_3000", minQueue < 3000);
                o.Set("hits", hidden.Count);
                o.Set("note", minQueue < 3000
                    ? "抓取点队列 " + minQueue + " < 3000：常见危险信号——任何 renderQueue ≥ 它且 <4000 的可见物，透过抓屏窗口都看不见（见 hidden_materials）。"
                    : "hidden_materials = 队列 ≥ 抓取点(" + minQueue + ")、非抓屏、<4000 的可见槽（透过抓屏窗口看不见的那批）。");
            }

            ProbeOut r;
            r.Json = o;
            r.Hits = hidden.Count;
            return r;
        }

        private sealed class SlotInfo
        {
            public Renderer R;
            public string Path;
            public int Slot;
            public Material Mat;
            public string Shader;
            public int Queue;
        }

        private static List<SlotInfo> VisibleSlots(GameObject avatar)
        {
            var list = new List<SlotInfo>();
            Renderer[] rs = avatar.GetComponentsInChildren<Renderer>(true);
            for (int i = 0; i < rs.Length; i++)
            {
                Renderer r = rs[i];
                if (r == null || !r.gameObject.activeInHierarchy || !r.enabled) continue;
                Material[] mats;
                try { mats = r.sharedMaterials; }
                catch { continue; }
                if (mats == null) continue;
                for (int s = 0; s < mats.Length; s++)
                {
                    Material m = mats[s];
                    var si = new SlotInfo();
                    si.R = r;
                    si.Path = AuditUtil.RelPath(avatar.transform, r.transform);
                    si.Slot = s;
                    si.Mat = m;
                    si.Shader = (m != null && m.shader != null) ? m.shader.name : null;
                    si.Queue = m == null ? 0 : m.renderQueue;
                    list.Add(si);
                }
            }
            list.Sort((a, b) =>
            {
                int c = string.CompareOrdinal(a.Path, b.Path);
                if (c != 0) return c;
                return a.Slot.CompareTo(b.Slot);
            });
            return list;
        }

        private static List<object> SlotList(List<SlotInfo> src)
        {
            var l = new List<object>(src.Count);
            for (int i = 0; i < src.Count; i++)
            {
                var s = src[i];
                var e = new JsonObject();
                e.Set("renderer", s.Path);
                e.Set("slot", s.Slot);
                e.Set("material", s.Mat == null ? null : s.Mat.name);
                e.Set("shader", s.Shader);
                e.Set("render_queue", s.Queue);
                l.Add(e);
            }
            return l;
        }

        // ────────────────────────────────────────────────────────────────
        // 探针 2：coincident（两件几乎重合的可见网格）
        // ────────────────────────────────────────────────────────────────

        private static ProbeOut Coincident(AuditContext ctx, GameObject avatar, Animator anim)
        {
            float ratioThresh = (float)ctx.N("coincident_ratio", 0.5);
            float gridMm = (float)ctx.N("coincident_grid_mm", 2.0);
            float nearMm = (float)ctx.N("coincident_near_mm", 0.5);
            int maxPairs = ctx.I("coincident_max_pairs", 400);
            if (ratioThresh <= 0f || ratioThresh > 1f) ratioThresh = 0.5f;
            if (gridMm <= 0f) gridMm = 2f;
            if (nearMm <= 0f) nearMm = 0.5f;
            if (maxPairs <= 0) maxPairs = 400;

            var all = AllSmrs(avatar);
            var visible = new List<SkinnedMeshRenderer>();
            for (int i = 0; i < all.Count; i++)
                if (all[i].gameObject.activeInHierarchy && all[i].enabled) visible.Add(all[i]);
            visible.Sort((a, b) => string.CompareOrdinal(Rel(avatar, a), Rel(avatar, b)));

            string bodySource;
            string bodyPath = PickBodyPath(ctx, anim, avatar.transform, all, visible, out bodySource);

            string exReStr = ctx.S("coincident_exclude_regex", null);
            Regex exRe = null;
            if (!string.IsNullOrEmpty(exReStr))
            {
                try { exRe = new Regex(exReStr, RegexOptions.CultureInvariant); }
                catch (Exception e) { ctx.Warn("coincident_exclude_regex 非法（" + e.Message + "），忽略该过滤。"); }
            }

            var cand = new List<SkinnedMeshRenderer>();
            for (int i = 0; i < visible.Count; i++)
            {
                var smr = visible[i];
                if (smr.sharedMesh == null || smr.sharedMesh.vertexCount <= 0) continue;
                string p = Rel(avatar, smr);
                if (bodyPath != null && p == bodyPath) continue;                       // 身体与贴身衣物天然接近 → 不比
                if (exRe != null && (exRe.IsMatch(smr.gameObject.name) || exRe.IsMatch(p))) continue;
                cand.Add(smr);
            }

            var hits = new List<JsonObject>();
            int considered = 0, evaluated = 0;
            bool truncated = false;
            float[] thresholds = { nearMm / 1000f, 0.001f, 0.002f };
            float cell = gridMm / 1000f;

            for (int i = 0; i < cand.Count; i++)
            {
                for (int j = i + 1; j < cand.Count; j++)
                {
                    var A = cand[i];
                    var B = cand[j];
                    int va = A.sharedMesh.vertexCount;
                    int vb = B.sharedMesh.vertexCount;
                    if (va <= 0 || vb <= 0) continue;

                    float vr = va >= vb ? (float)va / vb : (float)vb / va;
                    if (vr > 2f) continue;                       // 顶点数比须在 0.5–2
                    if (!A.bounds.Intersects(B.bounds)) continue; // 包围盒不相交不可能重合
                    considered++;

                    if (evaluated >= maxPairs) { truncated = true; continue; }
                    evaluated++;

                    Mesh ma = null, mb = null;
                    try
                    {
                        ma = BakeWorldMesh(A);
                        mb = BakeWorldMesh(B);
                        Vector3[] pa = ma.vertices;
                        Vector3[] pb = mb.vertices;

                        int[] cab = NearestCounts(pa, pb, cell, thresholds);
                        int[] cba = NearestCounts(pb, pa, cell, thresholds);
                        float r05 = Mathf.Max(Ratio(cab[0], pa.Length), Ratio(cba[0], pb.Length));
                        float r1 = Mathf.Max(Ratio(cab[1], pa.Length), Ratio(cba[1], pb.Length));
                        float r2 = Mathf.Max(Ratio(cab[2], pa.Length), Ratio(cba[2], pb.Length));

                        if (r05 >= ratioThresh)
                        {
                            var e = new JsonObject();
                            e.Set("a", Rel(avatar, A));
                            e.Set("b", Rel(avatar, B));
                            e.Set("vertices_a", va);
                            e.Set("vertices_b", vb);
                            e.Set("a_to_b_0.5mm", (double)Ratio(cab[0], pa.Length));
                            e.Set("b_to_a_0.5mm", (double)Ratio(cba[0], pb.Length));
                            e.Set("ratio_0.5mm", (double)r05);
                            e.Set("ratio_1mm", (double)r1);
                            e.Set("ratio_2mm", (double)r2);
                            hits.Add(e);
                        }
                    }
                    catch (Exception ex)
                    {
                        ctx.Warn("coincident 比较 " + Rel(avatar, A) + " × " + Rel(avatar, B) + " 失败：" + ex.Message);
                    }
                    finally
                    {
                        if (ma != null) Object.DestroyImmediate(ma);
                        if (mb != null) Object.DestroyImmediate(mb);
                    }
                }
            }

            hits.Sort((x, y) =>
            {
                double rx = Convert.ToDouble(x.Get("ratio_0.5mm"));
                double ry = Convert.ToDouble(y.Get("ratio_0.5mm"));
                int c = ry.CompareTo(rx);
                if (c != 0) return c;
                return string.CompareOrdinal(Convert.ToString(x.Get("a")), Convert.ToString(y.Get("a")));
            });

            var o = new JsonObject();
            o.Set("coincident_ratio_threshold", (double)ratioThresh);
            o.Set("grid_mm", (double)gridMm);
            o.Set("near_mm", (double)nearMm);
            o.Set("body", bodyPath);
            o.Set("body_source", bodySource);
            o.Set("candidate_meshes", cand.Count);
            o.Set("pairs_considered", considered);
            o.Set("pairs_evaluated", evaluated);
            o.Set("truncated", truncated);
            o.Set("hits", hits.Count);
            o.Set("coincident_pairs", hits);
            o.Set("note", "两两比较可见 SMR，先过「包围盒相交 + 顶点数比 ≤2」；BakeMesh 后对 A 顶点用 "
                + gridMm + " mm 网格哈希找 B 最近顶点，最近距离 ≤ " + nearMm + " mm 的比例（A→B 与 B→A 取大）≥ "
                + ratioThresh + " 记命中。身体网格（" + (bodyPath != null ? bodyPath : "未识别") + "）已排除，身体与贴身衣物的天然接近不计。");
            if (truncated) ctx.Warn("coincident 比较对数超过 coincident_max_pairs=" + maxPairs + "，部分候选未评估。");

            ProbeOut r;
            r.Json = o;
            r.Hits = hits.Count;
            return r;
        }

        // ────────────────────────────────────────────────────────────────
        // 探针 3：containment（封闭件包没包住身体部位）
        // ────────────────────────────────────────────────────────────────

        private sealed class PairSpec
        {
            public string Garment;
            public string Body;
            public string Region;
            public string PairSource;      // request | name_token
            public string RegionSource;    // request | name_token
            public string MatchToken;      // name_token 时命中的 token（request 为 null）
        }

        private sealed class BodyMeshInfo
        {
            public SkinnedMeshRenderer Smr;
            public Vector3[] Pos;      // 世界坐标（烘焙后）
            // 任务 CX：稳定参考位置（bind pose 的 sharedMesh 顶点 × localToWorld）。面积/密度口径用它，
            // 避免「每顶点面积」随形态键形变漂移；sharedMesh 未开 Read/Write 或顶点数对不齐时为 null。
            public Vector3[] RestPos;
            public Vector3[] Nrm;      // 世界坐标法线（烘焙后按逆转置变换；读不到为 null）
            public int[] Tris;         // 烘焙网格三角形索引（顶点序号与 Pos 对齐，供穿越计数取边）
            public string[] Region;    // 每个顶点的主骨骼归到的人形部位
            public string[] BoneName;  // 每个顶点主骨骼的 Transform 名（region_bones 用）
            public bool[] Usable;      // 坐标有限、未被删除、没被拉远才参与
            public int[] Exclude;      // 0=参与 1=非有限 2=NaNimation删除 3=权重为0 4=超出3m
            public Dictionary<string, List<string>> RegionBones;  // 部位 -> 用到的骨骼名（去重升序）
            public int BakedCount;
            public int SharedCount;
            public string RegionSource; // bone_weights | bone_weights_legacy | nearest_bone
            public bool HasWeights;
        }

        // 顶点排除原因编号（写进 excluded 的分项）。
        private const int ExOk = 0;
        private const int ExNonFinite = 1;
        private const int ExNanimated = 2;
        private const int ExZeroWeight = 3;
        private const int ExBeyond3m = 4;
        private const float BodyFarM = 3.0f;    // 顶点离 Hips 超过 3 m 视为被形态键拉远/已删除
        private const float WeightZeroEps = 1e-6f;

        private static ProbeOut Containment(AuditContext ctx, GameObject avatar, Animator anim)
        {
            float minRatio = (float)ctx.N("containment_min_ratio", 0.5);
            int minRegionVerts = ctx.I("containment_min_region_verts", 10);
            int minCrossings = ctx.I("containment_min_crossings", 20);
            float minCrossingRatio = (float)ctx.N("containment_min_crossing_ratio", 0.01);
            int maxIter = ctx.I("containment_max_iter", MaxRayIterations);
            int layer = ctx.I("containment_layer", DefaultTempLayer);
            long rayBudget = (long)ctx.N("containment_ray_budget", 3000000);
            if (minRatio <= 0f || minRatio > 1f) minRatio = 0.5f;
            if (minRegionVerts < 0) minRegionVerts = 10;
            if (minCrossings < 0) minCrossings = 20;
            if (minCrossingRatio <= 0f || minCrossingRatio > 1f) minCrossingRatio = 0.01f;
            if (maxIter <= 0) maxIter = MaxRayIterations;
            if (layer < 0 || layer > 31) layer = DefaultTempLayer;
            if (rayBudget <= 0) rayBudget = 3000000;

            var o = new JsonObject();
            o.Set("method", "对每个身体顶点向 ±X±Y±Z 六方向做迭代射线计交点（仅作参考）：命中后从命中点沿方向前进 "
                + RayAdvanceM.ToString("0.#####") + " m 再射，单方向最多 " + maxIter
                + " 次；单方向交点数为奇数记 1 票，≥" + InsideVotesThreshold
                + " 票判为在内。衣物烘焙网格建临时 MeshCollider（临时层，queriesHitBackfaces=true，结束恢复并销毁）。"
                + "穿模判据改用穿越计数：取该区域的三角形边，对每条边 A→B 与 B→A 各做一次线段射线，命中该衣物即记穿越边。");
            o.Set("inside_votes_threshold", InsideVotesThreshold);
            o.Set("ray_iter_max", maxIter);
            o.Set("ray_advance_m", (double)RayAdvanceM);
            o.Set("min_region_verts", minRegionVerts);
            o.Set("min_ratio", (double)minRatio);
            o.Set("min_crossings", minCrossings);
            o.Set("min_crossing_ratio", (double)minCrossingRatio);
            o.Set("ray_budget", rayBudget);
            o.Set("flag_rule", "区域 flagged = crossing_edges ≥ min_crossings 且 crossing_ratio ≥ min_crossing_ratio；"
                + "inside_ratio（包含率）保留为参考字段，不再参与 flagged。"
                + "为什么用穿越：MA ShapeChanger 用 NaNimation Delete 删掉鞋内脚部顶点后，剩下的身体顶点都在鞋外，"
                + "包含率天然低但与穿模无关；开口/不水密件同理。而真穿模（脚趾穿破鞋头）是身体表面与鞋面相交，"
                + "一定会让区域里的三角形边命中鞋面。");
            o.Set("crossing_rule", "每条穿越边：A→B 与 B→A 各一次线段射线（queriesHitBackfaces=true），任一命中即算；"
                + "crossing_midpoint_local / crossing_extent 是穿越边中点转到区域锚骨局部系的均值与包围盒尺寸（米）；"
                + "max_crossing_depth_mm 是「穿出深度」：穿越边里判在外的端点→命中面料点的距离，两端都判在外取较小值"
                + "（贴身擦边），两端都判在内记 0；超过 ray_budget 时该区域计数不完整（truncated=true）。");
            o.Set("pair_rule", "自动配对只看渲染器所在 GameObject 的名字（不拿层级路径）：ASCII 关键词按 token 匹配"
                + "（驼峰/下划线/空格/括号切分，长度≥4 允许 token 以其为前缀），CJK 关键词按子串；"
                + "命中写进 pair_source/pair_matched_token。");
            o.Set("region_rule", "部位 = 每个顶点的主蒙皮权重骨骼沿父链上溯到的最近 HumanBodyBones；"
                + "脚分 Foot（Foot 骨）与 Toes（Toe 骨及其子骨），手按 Hand 与各指节。权重从 sharedMesh 读，与姿势无关；"
                + "body_region_verts_total 是该区域原始顶点数，excluded 是其中被剔除的部分（NaN/删除/超 3 m）。");

            var all = AllSmrs(avatar);
            var visibleSmrs = new List<SkinnedMeshRenderer>();
            for (int i = 0; i < all.Count; i++)
                if (all[i].gameObject.activeInHierarchy && all[i].enabled) visibleSmrs.Add(all[i]);

            string bodySource;
            string bodyPath = PickBodyPath(ctx, anim, avatar.transform, all, visibleSmrs, out bodySource);
            o.Set("body", bodyPath);
            o.Set("body_source", bodySource);

            if (bodyPath == null)
            {
                o.Set("hits", 0);
                o.Set("pairs", new List<object>());
                o.Set("error", "找不到身体网格，containment 跳过。");
                ProbeOut rr;
                rr.Json = o;
                rr.Hits = 0;
                return rr;
            }

            var bodySmr = FindSmr(all, avatar.transform, bodyPath);
            if (bodySmr == null)
            {
                o.Set("hits", 0);
                o.Set("pairs", new List<object>());
                o.Set("error", "身体网格 '" + bodyPath + "' 无法按路径取到，containment 跳过。");
                ProbeOut rr2;
                rr2.Json = o;
                rr2.Hits = 0;
                return rr2;
            }

            var boneMap = BuildBoneRegionMap(anim);
            BodyMeshInfo bodyInfo;
            try { bodyInfo = BuildBodyInfo(bodySmr, avatar.transform, anim, boneMap, ctx); }
            catch (Exception e)
            {
                o.Set("hits", 0);
                o.Set("pairs", new List<object>());
                o.Set("error", "烘焙身体网格失败：" + e.Message);
                ctx.Warn("containment 烘焙身体网格失败：" + e.Message);
                ProbeOut rr3;
                rr3.Json = o;
                rr3.Hits = 0;
                return rr3;
            }

            // 身体层面的统计：总量与排除量（与区域过滤、衣物无关，一次算清）。
            {
                int exNan = 0, exNani = 0, exZero = 0, exFar = 0;
                for (int i = 0; i < bodyInfo.Pos.Length; i++)
                {
                    switch (bodyInfo.Exclude[i])
                    {
                        case ExNonFinite: exNan++; break;
                        case ExNanimated: exNani++; break;
                        case ExZeroWeight: exZero++; break;
                        case ExBeyond3m: exFar++; break;
                    }
                }
                var be = new JsonObject();
                be.Set("nan", exNan);
                be.Set("deleted", exNani + exZero);
                be.Set("deleted_nanimated", exNani);
                be.Set("deleted_zero_weight", exZero);
                be.Set("beyond_3m", exFar);
                be.Set("total", exNan + exNani + exZero + exFar);
                o.Set("body_excluded", be);
                o.Set("body_shared_vertices", bodyInfo.SharedCount);
                o.Set("body_baked_vertices", bodyInfo.BakedCount);
                o.Set("body_region_source", bodyInfo.RegionSource);
                o.Set("body_max_distance_m", (double)BodyFarM);
            }

            // 穿越计数用的区域三角形边：只由身体网格 + 区域归属决定，与衣物无关，预计算一次。
            var regionEdges = BuildRegionEdges(bodyInfo);

            // 配对：请求显式 > 自动（只看渲染器所在 GameObject 的名字，按 token 匹配关键词；
            // 不拿整条层级路径——路径里祖先名会把子物体误配，如 Acc_发饰_PixelBoot/windowA）。
            var pairs = new List<PairSpec>();
            var explicitArr = ctx.A("containment_pairs");
            if (explicitArr.Count > 0)
            {
                for (int i = 0; i < explicitArr.Count; i++)
                {
                    var e = explicitArr[i] as JsonObject;
                    if (e == null) continue;
                    var spec = new PairSpec();
                    spec.Garment = AuditJson.Str(e, "garment", null);
                    spec.Body = AuditJson.Str(e, "body", null);
                    spec.Region = AuditJson.Str(e, "region", null);
                    spec.PairSource = "request";
                    spec.RegionSource = string.IsNullOrEmpty(spec.Region) ? null : "request";
                    if (string.IsNullOrEmpty(spec.Garment))
                    {
                        ctx.Warn("containment_pairs 第 " + i + " 项缺 garment，已跳过。");
                        continue;
                    }
                    if (!string.IsNullOrEmpty(spec.Body) && spec.Body != bodyPath)
                        ctx.Warn("containment_pairs 第 " + i + " 项 body='" + spec.Body + "' 与全局身体 '" + bodyPath + "' 不同，本工具按全局身体处理。");
                    // 不写 region 时留到拿到渲染器后、用它的 GameObject 名推断，避免拿路径误配。
                    pairs.Add(spec);
                }
            }
            else
            {
                Renderer[] rs = avatar.GetComponentsInChildren<Renderer>(true);
                for (int i = 0; i < rs.Length; i++)
                {
                    Renderer rend = rs[i];
                    if (rend == null) continue;
                    if (!(rend is SkinnedMeshRenderer) && !(rend is MeshRenderer)) continue;
                    if (!rend.gameObject.activeInHierarchy || !rend.enabled) continue;
                    string p = AuditUtil.RelPath(avatar.transform, rend.transform);
                    if (p == bodyPath) continue;   // 身体网格本身不当作封闭件
                    string gn = rend.gameObject.name;
                    string tok;
                    string region;
                    if (MatchKeyword(gn, HandKeywords, out tok)) region = "hand";
                    else if (MatchKeyword(gn, FootKeywords, out tok)) region = "foot";
                    else continue;
                    var spec = new PairSpec();
                    spec.Garment = p;
                    spec.Region = region;
                    spec.PairSource = "name_token";
                    spec.RegionSource = "name_token";
                    spec.MatchToken = tok;
                    pairs.Add(spec);
                }
            }
            pairs.Sort((a, b) => string.CompareOrdinal(a.Garment, b.Garment));

            bool savedBackfaces = Physics.queriesHitBackfaces;
            long raysUsed = 0;
            bool budgetHit = false;
            int totalHits = 0;
            var pairOut = new List<object>();

            try
            {
                Physics.queriesHitBackfaces = true;
                WarnIfLayerOccupied(ctx, avatar, layer);
                int mask = 1 << layer;

                for (int pi = 0; pi < pairs.Count; pi++)
                {
                    var spec = pairs[pi];
                    Renderer gr = FindRenderer(avatar, spec.Garment);
                    if (gr == null) { ctx.Warn("containment 找不到衣物渲染器 '" + spec.Garment + "'，跳过。"); continue; }
                    if (!gr.gameObject.activeInHierarchy || !gr.enabled)
                    {
                        ctx.Warn("containment 衣物 '" + spec.Garment + "' 当前不可见，跳过。");
                        continue;
                    }

                    // region 未写：用渲染器 GameObject 名推断（不拿路径），与自动配对同口径。
                    if (string.IsNullOrEmpty(spec.Region))
                    {
                        string tok;
                        if (MatchKeyword(gr.gameObject.name, HandKeywords, out tok)) { spec.Region = "hand"; spec.MatchToken = tok; }
                        else if (MatchKeyword(gr.gameObject.name, FootKeywords, out tok)) { spec.Region = "foot"; spec.MatchToken = tok; }
                        else
                        {
                            ctx.Warn("containment '" + spec.Garment + "' 没写 region，且其 GameObject 名 '"
                                + gr.gameObject.name + "' 不含鞋/手套关键词，无法推断部位，已跳过。");
                            continue;
                        }
                        spec.RegionSource = "name_token";
                    }

                    Mesh gm = null;
                    GameObject go = null;
                    try
                    {
                        gm = MeshWorldOf(gr, ctx);
                        if (gm == null) { ctx.Warn("containment 衣物 '" + spec.Garment + "' 网格取不到，跳过。"); continue; }

                        go = new GameObject("__AuditProbe_containment");
                        go.hideFlags = HideFlags.HideAndDontSave;
                        go.layer = layer;
                        var mc = go.AddComponent<MeshCollider>();
                        mc.sharedMesh = gm;
                        mc.convex = false;
                        Physics.SyncTransforms();

                        // 区域总量与排除量：只跟 bodyInfo + region_filter 有关，与衣物无关。
                        // body_region_verts_total 用 sharedMesh 权重算（与姿势无关），所以同区域各状态一致；
                        // excluded 是其中被剔掉的部分，verts = total - excluded。
                        var regionTotal = new Dictionary<string, int>(StringComparer.Ordinal);
                        var regionExNan = new Dictionary<string, int>(StringComparer.Ordinal);
                        var regionExDel = new Dictionary<string, int>(StringComparer.Ordinal);
                        var regionExDelNani = new Dictionary<string, int>(StringComparer.Ordinal);
                        var regionExDelZero = new Dictionary<string, int>(StringComparer.Ordinal);
                        var regionExFar = new Dictionary<string, int>(StringComparer.Ordinal);
                        for (int vi = 0; vi < bodyInfo.Pos.Length; vi++)
                        {
                            string rg = bodyInfo.Region[vi];
                            if (!RegionMatches(rg, spec.Region)) continue;
                            Inc(regionTotal, rg);
                            switch (bodyInfo.Exclude[vi])
                            {
                                case ExNonFinite: Inc(regionExNan, rg); break;
                                case ExNanimated: Inc(regionExDel, rg); Inc(regionExDelNani, rg); break;
                                case ExZeroWeight: Inc(regionExDel, rg); Inc(regionExDelZero, rg); break;
                                case ExBeyond3m: Inc(regionExFar, rg); break;
                            }
                        }

                        var regionVerts = new Dictionary<string, int>(StringComparer.Ordinal);
                        var regionInside = new Dictionary<string, int>(StringComparer.Ordinal);
                        var outsideSum = new Dictionary<string, Vector3>(StringComparer.Ordinal);
                        var outsideMin = new Dictionary<string, Vector3>(StringComparer.Ordinal);
                        var outsideMax = new Dictionary<string, Vector3>(StringComparer.Ordinal);
                        var outsideN = new Dictionary<string, int>(StringComparer.Ordinal);
                        var anchorCache = new Dictionary<string, Transform>(StringComparer.Ordinal);
                        var insideV = new bool[bodyInfo.Pos.Length];   // 顶点在内判定，供穿越深度区分内外端点
                        int totalV = 0, totalIn = 0;

                        for (int vi = 0; vi < bodyInfo.Pos.Length; vi++)
                        {
                            if (!bodyInfo.Usable[vi]) continue;
                            string region = bodyInfo.Region[vi];
                            if (!RegionMatches(region, spec.Region)) continue;
                            if (raysUsed >= rayBudget) { budgetHit = true; break; }

                            int votes = InsideVotes(bodyInfo.Pos[vi], mask, maxIter, ref raysUsed, rayBudget);
                            insideV[vi] = votes >= InsideVotesThreshold;
                            int cv;
                            regionVerts.TryGetValue(region, out cv);
                            regionVerts[region] = cv + 1;
                            totalV++;
                            if (votes >= InsideVotesThreshold)
                            {
                                int ci;
                                regionInside.TryGetValue(region, out ci);
                                regionInside[region] = ci + 1;
                                totalIn++;
                            }
                            else
                            {
                                // 在外顶点：转到「该区域骨骼」的局部坐标，便于分辨是脚尖/脚跟/脚背露在外面。
                                Transform anchor = RegionAnchor(region, boneMap, bodySmr.transform, anchorCache);
                                Vector3 loc = anchor.InverseTransformPoint(bodyInfo.Pos[vi]);
                                Vector3 s;
                                outsideSum.TryGetValue(region, out s);
                                outsideSum[region] = s + loc;
                                Vector3 mn, mx;
                                if (!outsideMin.TryGetValue(region, out mn)) { mn = loc; mx = loc; }
                                else
                                {
                                    outsideMax.TryGetValue(region, out mx);
                                    mn = new Vector3(Mathf.Min(mn.x, loc.x), Mathf.Min(mn.y, loc.y), Mathf.Min(mn.z, loc.z));
                                    mx = new Vector3(Mathf.Max(mx.x, loc.x), Mathf.Max(mx.y, loc.y), Mathf.Max(mx.z, loc.z));
                                }
                                outsideMin[region] = mn;
                                outsideMax[region] = mx;
                                int on;
                                outsideN.TryGetValue(region, out on);
                                outsideN[region] = on + 1;
                            }
                        }

                        // ── 穿越计数（任务 U）：区域三角形边 A→B / B→A 各一次线段射线，命中衣物即穿越 ──
                        var regionCross = new Dictionary<string, int>(StringComparer.Ordinal);
                        var crossMidSum = new Dictionary<string, Vector3>(StringComparer.Ordinal);
                        var crossMidMin = new Dictionary<string, Vector3>(StringComparer.Ordinal);
                        var crossMidMax = new Dictionary<string, Vector3>(StringComparer.Ordinal);
                        var regionMaxDepth = new Dictionary<string, float>(StringComparer.Ordinal);
                        int totalEdges = 0, totalCross = 0;
                        // 区域名排序后再遍历：ray_budget 可能在中间用尽，顺序必须确定，否则 repeat_check 会假阳。
                        var edgeRegions = new List<string>(regionEdges.Keys);
                        edgeRegions.Sort(StringComparer.Ordinal);
                        for (int eri = 0; eri < edgeRegions.Count; eri++)
                        {
                            string rn = edgeRegions[eri];
                            if (!RegionMatches(rn, spec.Region)) continue;
                            List<int> el = regionEdges[rn];
                            totalEdges += el.Count / 2;
                            for (int ei = 0; ei + 1 < el.Count; ei += 2)
                            {
                                if (raysUsed >= rayBudget) { budgetHit = true; break; }
                                int a = el[ei], b = el[ei + 1];
                                Vector3 pa = bodyInfo.Pos[a];
                                Vector3 pb = bodyInfo.Pos[b];
                                Vector3 hp; float dFromA;
                                bool hitAB = SegmentHit(pa, pb, mask, ref raysUsed, rayBudget, out hp, out dFromA);
                                Vector3 back = Vector3.zero; float backDist = 0f;
                                bool hitBA = false;
                                if (raysUsed < rayBudget)
                                    hitBA = SegmentHit(pb, pa, mask, ref raysUsed, rayBudget, out back, out backDist);
                                if (!hitAB && !hitBA) continue;

                                float len = (pb - pa).magnitude;
                                if (!hitAB)
                                {
                                    hp = back;
                                    dFromA = len - backDist;   // backDist 是 B→命中点；换算成从 A 端起算
                                }
                                float dFromB = len - dFromA;
                                bool inA = insideV[a], inB = insideV[b];
                                float depth;
                                if (inA && inB) depth = 0f;                                // 两端都在内：没有穿出
                                else if (!inA && !inB) depth = Mathf.Min(dFromA, dFromB);   // 两端都在外：贴身擦边，取较小
                                else depth = inA ? dFromB : dFromA;                         // 在外端点 → 命中面料
                                float prevD;
                                regionMaxDepth.TryGetValue(rn, out prevD);
                                if (depth > prevD) regionMaxDepth[rn] = depth;

                                Inc(regionCross, rn);
                                totalCross++;

                                Transform anchor = RegionAnchor(rn, boneMap, bodySmr.transform, anchorCache);
                                Vector3 mid = anchor.InverseTransformPoint((pa + pb) * 0.5f);
                                Vector3 s;
                                crossMidSum.TryGetValue(rn, out s);
                                crossMidSum[rn] = s + mid;
                                Vector3 cmn, cmx;
                                if (!crossMidMin.TryGetValue(rn, out cmn)) { cmn = mid; cmx = mid; }
                                else
                                {
                                    crossMidMax.TryGetValue(rn, out cmx);
                                    cmn = new Vector3(Mathf.Min(cmn.x, mid.x), Mathf.Min(cmn.y, mid.y), Mathf.Min(cmn.z, mid.z));
                                    cmx = new Vector3(Mathf.Max(cmx.x, mid.x), Mathf.Max(cmx.y, mid.y), Mathf.Max(cmx.z, mid.z));
                                }
                                crossMidMin[rn] = cmn;
                                crossMidMax[rn] = cmx;
                            }
                            if (raysUsed >= rayBudget) { budgetHit = true; break; }
                        }

                        var po = new JsonObject();
                        po.Set("garment", AuditUtil.RelPath(avatar.transform, gr.transform));
                        po.Set("garment_name", gr.gameObject.name);
                        po.Set("body", bodyPath);
                        po.Set("region_filter", spec.Region);
                        po.Set("pair_source", spec.PairSource);
                        po.Set("pair_matched_token", spec.MatchToken);
                        po.Set("pair_region_source", spec.RegionSource);
                        po.Set("mesh_vertices", gm.vertexCount);
                        po.Set("mesh_triangles", gm.triangles.Length / 3);

                        float boundaryRatio, nonManifoldRatio;
                        BoundaryStats(gm, out boundaryRatio, out nonManifoldRatio);
                        po.Set("open_mesh_suspect", (double)boundaryRatio);          // 边界边占比，给人判断
                        po.Set("nonmanifold_edge_ratio", (double)nonManifoldRatio);

                        po.Set("verts", totalV);
                        po.Set("inside", totalIn);
                        po.Set("inside_ratio", (double)Ratio(totalIn, totalV));      // 参考字段，不再参与 flagged
                        po.Set("edges", totalEdges);
                        po.Set("crossing_edges", totalCross);
                        po.Set("crossing_ratio", (double)Ratio(totalCross, totalEdges));

                        var regArr = new List<object>();
                        var regNames = new List<string>(regionTotal.Keys);
                        regNames.Sort(StringComparer.Ordinal);
                        int pairHits = 0;
                        for (int ri = 0; ri < regNames.Count; ri++)
                        {
                            string rn = regNames[ri];
                            int totalRegion = Get(regionTotal, rn);
                            int v = Get(regionVerts, rn);
                            int ins = Get(regionInside, rn);
                            float ratio = Ratio(ins, v);
                            int edgesInRegion = EdgesInRegion(regionEdges, rn);
                            int cross = Get(regionCross, rn);
                            float crossRatio = Ratio(cross, edgesInRegion);
                            bool flagged = cross >= minCrossings && crossRatio >= minCrossingRatio;
                            if (flagged) pairHits++;
                            var ro = new JsonObject();
                            ro.Set("region", rn);
                            ro.Set("region_bones", RegionBones(bodyInfo, rn));
                            ro.Set("body_region_verts_total", totalRegion);
                            var ex = new JsonObject();
                            ex.Set("nan", Get(regionExNan, rn));
                            ex.Set("deleted", Get(regionExDel, rn));
                            ex.Set("deleted_nanimated", Get(regionExDelNani, rn));
                            ex.Set("deleted_zero_weight", Get(regionExDelZero, rn));
                            ex.Set("beyond_3m", Get(regionExFar, rn));
                            ex.Set("total", Get(regionExNan, rn) + Get(regionExDel, rn) + Get(regionExFar, rn));
                            ro.Set("excluded", ex);
                            ro.Set("verts", v);
                            ro.Set("inside", ins);
                            ro.Set("inside_ratio", (double)ratio);                    // 参考字段，不再参与 flagged
                            ro.Set("edges", edgesInRegion);
                            ro.Set("crossing_edges", cross);
                            ro.Set("crossing_ratio", (double)crossRatio);
                            float dm;
                            regionMaxDepth.TryGetValue(rn, out dm);
                            ro.Set("max_crossing_depth_mm", (double)(dm * 1000f));
                            ro.Set("flagged", flagged);
                            ro.Set("flag_basis", flagged ? "crossing"
                                : (cross > 0 ? "crossing_below_threshold" : "no_crossing"));
                            int on = Get(outsideN, rn);
                            if (on > 0)
                            {
                                Vector3 sum;
                                outsideSum.TryGetValue(rn, out sum);
                                ro.Set("outside_centroid_local", Vec(sum / on));
                                Vector3 mn, mx;
                                outsideMin.TryGetValue(rn, out mn);
                                outsideMax.TryGetValue(rn, out mx);
                                ro.Set("outside_extent", Vec(mx - mn));
                            }
                            else
                            {
                                ro.Set("outside_centroid_local", null);
                                ro.Set("outside_extent", null);
                            }
                            if (cross > 0)
                            {
                                Vector3 csum;
                                crossMidSum.TryGetValue(rn, out csum);
                                ro.Set("crossing_midpoint_local", Vec(csum / cross));
                                Vector3 cmn, cmx;
                                crossMidMin.TryGetValue(rn, out cmn);
                                crossMidMax.TryGetValue(rn, out cmx);
                                ro.Set("crossing_extent", Vec(cmx - cmn));
                            }
                            else
                            {
                                ro.Set("crossing_midpoint_local", null);
                                ro.Set("crossing_extent", null);
                            }
                            regArr.Add(ro);
                        }
                        po.Set("by_region", regArr);
                        po.Set("hits", pairHits);
                        if (boundaryRatio > 0.05f)
                            po.Set("note", "open_mesh_suspect=" + boundaryRatio.ToString("0.###")
                                + " 偏高：衣物网格可能是开口件（凉鞋/露趾鞋/无指手套）。开口件的身体从开口穿过、"
                                + "不与面料相交，crossing_edges 通常为 0 或个位数；而真穿模是身体表面与面料相交，"
                                + "会同时抬高 crossing_edges 与 crossing_ratio。inside_ratio 只是参考，不据此下结论。");

                        totalHits += pairHits;
                        pairOut.Add(po);
                    }
                    catch (Exception e)
                    {
                        ctx.Warn("containment 处理 '" + spec.Garment + "' 失败：" + e.Message);
                    }
                    finally
                    {
                        if (go != null) Object.DestroyImmediate(go);
                        if (gm != null) Object.DestroyImmediate(gm);
                    }
                }
            }
            finally
            {
                Physics.queriesHitBackfaces = savedBackfaces;
            }

            if (budgetHit) ctx.Warn("containment 射线预算 " + rayBudget + " 用尽，部分身体顶点未测试，结果不完整。");

            o.Set("rays_used", raysUsed);
            o.Set("truncated", budgetHit);
            o.Set("pairs", pairOut);
            o.Set("hits", totalHits);

            ProbeOut r;
            r.Json = o;
            r.Hits = totalHits;
            return r;
        }

        /// <summary>迭代射线：单方向数交点；命中后前进 RayAdvanceM 再射，最多 maxIter 次。</summary>
        private static int InsideVotes(Vector3 p, int mask, int maxIter, ref long raysUsed, long rayBudget)
        {
            int votes = 0;
            for (int d = 0; d < Directions.Length; d++)
            {
                Vector3 dir = Directions[d];
                Vector3 origin = p;
                int crossings = 0;
                for (int it = 0; it < maxIter; it++)
                {
                    if (raysUsed >= rayBudget) break;
                    RaycastHit h;
                    bool hit = Physics.Raycast(origin, dir, out h, 1000f, mask, QueryTriggerInteraction.Ignore);
                    raysUsed++;
                    if (!hit) break;
                    crossings++;
                    origin = h.point + dir * RayAdvanceM;
                }
                if ((crossings & 1) == 1) votes++;
            }
            return votes;
        }

        /// <summary>
        /// 穿越计数用：区域里的三角形边（两端都 ExOk 且归同一区域），去重。
        /// 返回 region -> 扁平 [a,b,a,b,...]（顶点序号，与 bodyInfo.Pos 对齐）。
        /// 边只由身体网格 + 区域归属决定，与衣物无关，所以在配对前算一次、各衣物复用。
        /// </summary>
        private static Dictionary<string, List<int>> BuildRegionEdges(BodyMeshInfo info)
        {
            var map = new Dictionary<string, List<int>>(StringComparer.Ordinal);
            int[] tris = info.Tris;
            if (tris == null || tris.Length < 3) return map;
            var seen = new HashSet<long>(tris.Length);
            for (int k = 0; k + 2 < tris.Length; k += 3)
            {
                AddRegionEdge(map, seen, info, tris[k], tris[k + 1]);
                AddRegionEdge(map, seen, info, tris[k + 1], tris[k + 2]);
                AddRegionEdge(map, seen, info, tris[k + 2], tris[k]);
            }
            return map;
        }

        private static void AddRegionEdge(Dictionary<string, List<int>> map, HashSet<long> seen,
            BodyMeshInfo info, int a, int b)
        {
            if (a == b) return;
            int n = info.Usable.Length;
            if (a < 0 || b < 0 || a >= n || b >= n) return;
            if (!info.Usable[a] || !info.Usable[b]) return;                 // 删除 / NaN / 超 3 m 的顶点不参与
            string ra = info.Region[a];
            if (!string.Equals(ra, info.Region[b], StringComparison.Ordinal)) return;
            int lo = a < b ? a : b;
            int hi = a < b ? b : a;
            long key = ((long)lo << 32) | (uint)hi;
            if (!seen.Add(key)) return;                                     // 共享边只算一次
            List<int> l;
            if (!map.TryGetValue(ra, out l)) { l = new List<int>(); map[ra] = l; }
            l.Add(a);
            l.Add(b);
        }

        private static int EdgesInRegion(Dictionary<string, List<int>> edges, string region)
        {
            List<int> l;
            if (edges != null && edges.TryGetValue(region, out l)) return l.Count / 2;
            return 0;
        }

        /// <summary>
        /// 线段射线 from→to：命中 mask 层返回 true，并给出命中点与命中点到 from 的距离。
        /// queriesHitBackfaces 由调用方在更外层设置（与包含测试同一开关）。
        /// 预算用尽时不做射线、返回 false；调用方在每条边开头用 raysUsed/rayBudget 判断是否 truncated。
        /// </summary>
        private static bool SegmentHit(Vector3 from, Vector3 to, int mask, ref long raysUsed, long rayBudget,
            out Vector3 hitPoint, out float distFromFrom)
        {
            hitPoint = Vector3.zero;
            distFromFrom = 0f;
            Vector3 d = to - from;
            float len = d.magnitude;
            if (len <= 1e-9f) return false;
            if (raysUsed >= rayBudget) return false;
            RaycastHit h;
            bool hit = Physics.Raycast(from, d / len, out h, len, mask, QueryTriggerInteraction.Ignore);
            raysUsed++;
            if (!hit) return false;
            hitPoint = h.point;
            distFromFrom = h.distance;
            return true;
        }

        private static void WarnIfLayerOccupied(AuditContext ctx, GameObject avatar, int layer)
        {
            Collider[] cols = avatar.GetComponentsInChildren<Collider>(true);
            for (int i = 0; i < cols.Length; i++)
            {
                if (cols[i] == null) continue;
                if (cols[i].gameObject.layer == layer)
                {
                    ctx.Warn("头像里已有层 " + layer + " 的碰撞体（" + AuditUtil.RelPath(avatar.transform, cols[i].transform)
                        + "），containment 射线可能误命中。");
                    return;
                }
            }
        }

        // ────────────────────────────────────────────────────────────────
        // 探针 4：range（非零形态键里权重越界）
        // ────────────────────────────────────────────────────────────────

        private static ProbeOut Range(AuditContext ctx, GameObject avatar)
        {
            float eps = Mathf.Abs((float)ctx.N("blendshape_epsilon", 0.0001));
            var bad = new List<object>();

            SkinnedMeshRenderer[] smrs = avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
            for (int i = 0; i < smrs.Length; i++)
            {
                var smr = smrs[i];
                if (smr == null || smr.sharedMesh == null) continue;
                if (!smr.gameObject.activeInHierarchy || !smr.enabled) continue;
                int count = smr.sharedMesh.blendShapeCount;
                for (int b = 0; b < count; b++)
                {
                    float w = smr.GetBlendShapeWeight(b);
                    if (Mathf.Abs(w) <= eps) continue;              // 非零才看
                    if (w < 0f || w > 100f)
                    {
                        var e = new JsonObject();
                        e.Set("renderer", AuditUtil.RelPath(avatar.transform, smr.transform));
                        e.Set("shape", smr.sharedMesh.GetBlendShapeName(b));
                        e.Set("weight", (double)w);
                        bad.Add(e);
                    }
                }
            }

            var o = new JsonObject();
            o.Set("blendshape_epsilon", (double)eps);
            o.Set("out_of_range", bad);
            o.Set("hits", bad.Count);
            o.Set("note", "VRChat 客户端把形态键权重钳到 0–100，编辑器预览不钳；这里列出所有可见 SMR 非零形态键里 <0 或 >100 的项。");
            ProbeOut r;
            r.Json = o;
            r.Hits = bad.Count;
            return r;
        }

        // ────────────────────────────────────────────────────────────────
        // 通用：SMR / 身体识别 / 部位映射 / 网格工具
        // ────────────────────────────────────────────────────────────────

        private static List<SkinnedMeshRenderer> AllSmrs(GameObject avatar)
        {
            var l = new List<SkinnedMeshRenderer>();
            SkinnedMeshRenderer[] arr = avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
            for (int i = 0; i < arr.Length; i++)
                if (arr[i] != null && arr[i].sharedMesh != null) l.Add(arr[i]);
            return l;
        }

        private static string Rel(GameObject avatar, Component c)
        {
            return AuditUtil.RelPath(avatar.transform, c.transform);
        }

        private static float Ratio(int count, int total)
        {
            return total > 0 ? (float)count / total : 0f;
        }

        /// <summary>身体网格：请求 body 优先（路径/叶子名），否则自动（同时含脚与躯干人形部位的可见 SMR，顶点最多者）。</summary>
        private static string PickBodyPath(AuditContext ctx, Animator anim, Transform root,
            List<SkinnedMeshRenderer> all, List<SkinnedMeshRenderer> visible, out string source)
        {
            source = "none";
            var map = BuildBoneRegionMap(anim);

            string requested = ctx.S("body", null);
            if (!string.IsNullOrEmpty(requested))
            {
                var hit = FindSmr(all, root, requested);
                if (hit != null) { source = "request"; return AuditUtil.RelPath(root, hit.transform); }
                ctx.Warn("请求 body='" + requested + "' 找不到对应 SkinnedMeshRenderer，改走自动识别。");
            }

            var cache = new Dictionary<Transform, string>();
            Func<Transform, string> regionOf = bt => RegionOf(bt, map, root, cache);
            // 共享判据（任务 AY，K19/K20）：名字候选（Body_b/Body_base/Body）优先且要过「蒙皮权重
            // 同时覆盖脚与躯干」关，再退几何启发。只按骨骼部位集合会把 Kipfel 脸网格 `Body` 当身体。
            SkinnedMeshRenderer best = AuditBodyPick.FindBodySmr(visible, regionOf);
            if (best != null) { source = "auto"; return AuditUtil.RelPath(root, best.transform); }

            int bestVerts = -1;
            for (int i = 0; i < visible.Count; i++)
                if (visible[i].sharedMesh.vertexCount > bestVerts)
                {
                    bestVerts = visible[i].sharedMesh.vertexCount;
                    best = visible[i];
                }
            if (best != null)
            {
                source = "fallback_largest";
                ctx.Warn("自动识别身体网格失败（没有同时含脚与躯干人形部位的可见 SMR），退回顶点数最多的可见 SMR："
                    + AuditUtil.RelPath(root, best.transform) + "。身体排除可能不准。");
                return AuditUtil.RelPath(root, best.transform);
            }
            ctx.Warn("场景里没有可见的 SkinnedMeshRenderer，无法识别身体网格。");
            return null;
        }

        private static SkinnedMeshRenderer FindSmr(List<SkinnedMeshRenderer> all, Transform root, string spec)
        {
            if (string.IsNullOrEmpty(spec)) return null;
            for (int i = 0; i < all.Count; i++)
                if (AuditUtil.RelPath(root, all[i].transform) == spec) return all[i];
            int slash = spec.LastIndexOf('/');
            string leaf = slash >= 0 && slash + 1 < spec.Length ? spec.Substring(slash + 1) : spec;
            for (int i = 0; i < all.Count; i++)
                if (all[i].gameObject.name == spec || all[i].gameObject.name == leaf) return all[i];
            return null;
        }

        private static Renderer FindRenderer(GameObject avatar, string spec)
        {
            if (string.IsNullOrEmpty(spec)) return null;
            Transform root = avatar.transform;
            Renderer[] rs = avatar.GetComponentsInChildren<Renderer>(true);
            for (int i = 0; i < rs.Length; i++)
                if (rs[i] != null && AuditUtil.RelPath(root, rs[i].transform) == spec) return rs[i];
            int slash = spec.LastIndexOf('/');
            string leaf = slash >= 0 && slash + 1 < spec.Length ? spec.Substring(slash + 1) : spec;
            for (int i = 0; i < rs.Length; i++)
                if (rs[i] != null && (rs[i].gameObject.name == spec || rs[i].gameObject.name == leaf)) return rs[i];
            return null;
        }

        private static Dictionary<Transform, string> BuildBoneRegionMap(Animator anim)
        {
            var map = new Dictionary<Transform, string>();
            if (anim == null) return map;
            Array values = Enum.GetValues(typeof(HumanBodyBones));
            for (int i = 0; i < values.Length; i++)
            {
                var b = (HumanBodyBones)values.GetValue(i);
                if (b == HumanBodyBones.LastBone) continue;
                Transform t = null;
                try { t = anim.GetBoneTransform(b); }
                catch { }
                if (t != null && !map.ContainsKey(t)) map[t] = b.ToString();
            }
            return map;
        }

        // 注：原「按骨骼部位集合认身体」的 BoneRegions() 已删（任务 AY）。身体识别统一走
        // AuditBodyPick.FindBodySmr（名字候选过脚+躯干蒙皮权重关，再退几何启发），见 PickBodyPath。

        /// <summary>沿父链向上遇到的第一个人形骨骼即该 Transform 的部位。ma/AAO 会插 Const bone，不能只精确匹配。</summary>
        private static string RegionOf(Transform t, Dictionary<Transform, string> map, Transform root,
            Dictionary<Transform, string> cache)
        {
            if (t == null) return "Other";
            string cached;
            if (cache.TryGetValue(t, out cached)) return cached;

            Transform cur = t;
            string found = null;
            int guard = 0;
            while (cur != null && guard++ < 512)
            {
                if (map.TryGetValue(cur, out found)) break;
                if (cur == root) break;
                cur = cur.parent;
            }
            if (found == null) found = map.Count == 0 ? t.name : "Other";
            cache[t] = found;
            return found;
        }

        private static bool IsFootRegion(string r)
        {
            if (string.IsNullOrEmpty(r)) return false;
            // "Toe" 同时覆盖 Toes（HumanBodyBones）与 ToeBase 这类非标准骨名，脚趾不再并进 Foot。
            return r.IndexOf("Foot", StringComparison.OrdinalIgnoreCase) >= 0
                || r.IndexOf("Toe", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static bool IsHandRegion(string r)
        {
            if (string.IsNullOrEmpty(r)) return false;
            if (r.IndexOf("Hand", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            string[] fingers = { "Thumb", "Index", "Middle", "Ring", "Little" };
            for (int i = 0; i < fingers.Length; i++)
                if (r.IndexOf(fingers[i], StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        /// <summary>region_filter：foot / hand 用部位集合匹配；其它按子串匹配具体 HumanBodyBones 名。</summary>
        private static bool RegionMatches(string region, string filter)
        {
            if (string.IsNullOrEmpty(filter)) return true;
            string f = filter.Trim();
            if (f.Length == 0) return true;
            if (f.Equals("foot", StringComparison.OrdinalIgnoreCase)) return IsFootRegion(region);
            if (f.Equals("hand", StringComparison.OrdinalIgnoreCase)) return IsHandRegion(region);
            return region != null && region.IndexOf(f, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        // ── GameObject 名 token 匹配（对齐 t5_shapekey_matrix.py 的 tokens / match_any）──
        // 拆分：先按「非字母数字且非 CJK」切段；ASCII 段再按驼峰/数字边界切开；CJK 连续段整段保留。
        // 全部转小写比较。只对「渲染器所在 GameObject 的名字」调用，不拿层级路径。

        private static bool IsAsciiWordChar(char c)
        {
            return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        }

        private static bool IsCjkChar(char c)
        {
            return (c >= '\u3040' && c <= '\u30ff')     // 平假名 / 片假名
                || (c >= '\u3400' && c <= '\u4dbf')     // CJK 扩展 A
                || (c >= '\u4e00' && c <= '\u9fff')     // CJK 基本区
                || (c >= '\uff66' && c <= '\uff9f');    // 半角片假名
        }

        private static List<string> NameTokens(string s)
        {
            var toks = new List<string>();
            if (string.IsNullOrEmpty(s)) return toks;

            var runs = new List<string>();
            var sb = new StringBuilder();
            int cls = 0;   // 0=空 1=ASCII 词 2=CJK
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                int nc = IsAsciiWordChar(c) ? 1 : (IsCjkChar(c) ? 2 : 0);
                if (nc == 0)
                {
                    if (sb.Length > 0) { runs.Add(sb.ToString()); sb.Length = 0; }
                    cls = 0;
                    continue;
                }
                if (cls != 0 && cls != nc && sb.Length > 0) { runs.Add(sb.ToString()); sb.Length = 0; }
                sb.Append(c);
                cls = nc;
            }
            if (sb.Length > 0) runs.Add(sb.ToString());

            for (int r = 0; r < runs.Count; r++)
            {
                string run = runs[r];
                if (!IsAsciiWordChar(run[0])) { AddToken(toks, run); continue; }
                int start = 0;
                for (int i = 1; i < run.Length; i++)
                {
                    char prev = run[i - 1], cur = run[i];
                    bool boundary = false;
                    if (char.IsLower(prev) && char.IsUpper(cur)) boundary = true;                 // PixelBoot -> Pixel|Boot
                    else if (char.IsDigit(prev) && char.IsLetter(cur)) boundary = true;           // window2A -> window2|A
                    else if (char.IsLetter(prev) && char.IsDigit(cur)) boundary = true;           // A2 -> A|2
                    else if (i + 1 < run.Length && char.IsUpper(prev) && char.IsUpper(cur) && char.IsLower(run[i + 1]))
                        boundary = true;                                                          // ABCThing -> ABC|Thing
                    if (boundary) { AddToken(toks, run.Substring(start, i - start)); start = i; }
                }
                AddToken(toks, run.Substring(start));
            }
            return toks;
        }

        private static void AddToken(List<string> toks, string t)
        {
            if (string.IsNullOrEmpty(t)) return;
            string tl = t.ToLowerInvariant();
            if (!toks.Contains(tl)) toks.Add(tl);
        }

        /// <summary>关键词命中：CJK 按子串；ASCII 完整 token，长度 ≥4 允许 token 以其为前缀。token 输出命中的词。</summary>
        private static bool MatchKeyword(string name, string[] keywords, out string token)
        {
            token = null;
            if (string.IsNullOrEmpty(name)) return false;
            string lower = name.ToLowerInvariant();
            List<string> toks = null;
            for (int i = 0; i < keywords.Length; i++)
            {
                string w = keywords[i];
                if (string.IsNullOrEmpty(w)) continue;
                string wl = w.ToLowerInvariant();
                bool cjk = false;
                for (int c = 0; c < wl.Length; c++) if (IsCjkChar(wl[c])) { cjk = true; break; }
                if (cjk)
                {
                    if (lower.IndexOf(wl, StringComparison.Ordinal) >= 0) { token = wl; return true; }
                    continue;
                }
                if (toks == null) toks = NameTokens(name);
                for (int t = 0; t < toks.Count; t++)
                    if (toks[t] == wl) { token = toks[t]; return true; }
                if (wl.Length >= 4)
                {
                    for (int t = 0; t < toks.Count; t++)
                        if (toks[t].Length > wl.Length && toks[t].StartsWith(wl, StringComparison.Ordinal))
                        { token = toks[t]; return true; }
                }
            }
            return false;
        }

        private static void Inc(Dictionary<string, int> d, string k)
        {
            int v;
            d.TryGetValue(k, out v);
            d[k] = v + 1;
        }

        private static int Get(Dictionary<string, int> d, string k)
        {
            int v;
            d.TryGetValue(k, out v);
            return v;
        }

        private static JsonObject Vec(Vector3 v)
        {
            var o = new JsonObject();
            o.Set("x", (double)v.x);
            o.Set("y", (double)v.y);
            o.Set("z", (double)v.z);
            return o;
        }

        private static List<string> RegionBones(BodyMeshInfo info, string region)
        {
            List<string> l;
            if (info.RegionBones != null && info.RegionBones.TryGetValue(region, out l)) return l;
            return new List<string>();
        }

        /// <summary>区域锚骨：优先该区域对应的 HumanBodyBones，找不到退回头像 / 身体根。</summary>
        private static Transform RegionAnchor(string region, Dictionary<Transform, string> map,
            Transform fallback, Dictionary<string, Transform> cache)
        {
            if (!string.IsNullOrEmpty(region))
            {
                Transform t;
                if (cache.TryGetValue(region, out t)) return t;
                foreach (var kv in map)
                    if (kv.Value == region) { cache[region] = kv.Key; return kv.Key; }
                cache[region] = fallback;
                return fallback;
            }
            return fallback;
        }

        private static BodyMeshInfo BuildBodyInfo(SkinnedMeshRenderer smr, Transform root, Animator anim,
            Dictionary<Transform, string> map, AuditContext ctx)
        {
            Mesh m = BakeWorldMesh(smr);
            try
            {
                Vector3[] pos = m.vertices;
                int[] tris;
                try { tris = m.triangles; }
                catch { tris = null; }
                int n = pos.Length;
                Mesh shared = smr.sharedMesh;

                // 关键：主骨骼从 sharedMesh 的蒙皮权重读，不从烘焙网格读。
                // BakeMesh 产物不带可用 bone weight，对它读会静默返回 null 落到 NearestBoneIndices——
                // 那是按世界坐标找最近骨骼，部位随姿势漂移（ANEMONE 脚 2033/3222 就是这么来的）。
                int[] dom;
                float[] total;
                string wsrc;
                try { dom = DominantBones(shared, n, out total, out wsrc); }
                catch (Exception e)
                {
                    ctx.Warn("读身体蒙皮权重失败（改用最近骨骼近似）：" + e.Message);
                    dom = null;
                    total = null;
                    wsrc = "error";
                }
                bool hasWeights = dom != null;
                if (dom == null)
                {
                    dom = NearestBoneIndices(smr.bones, pos, n);
                    total = null;
                    wsrc = "nearest_bone";
                    ctx.Warn("身体网格 '" + smr.gameObject.name + "' 读不到蒙皮权重（网格未开 Read/Write 或没有骨骼），"
                        + "部位改用最近骨骼近似：部位顶点数会随姿势变化，body_region_verts_total 仅供参考。");
                }

                // 3 m 判定以 Hips 为原点（读不到退回头像根）。
                Vector3 origin = root != null ? root.position : Vector3.zero;
                if (anim != null)
                {
                    Transform hips = null;
                    try { hips = anim.GetBoneTransform(HumanBodyBones.Hips); }
                    catch { }
                    if (hips != null) origin = hips.position;
                }
                float farSqr = BodyFarM * BodyFarM;

                var info = new BodyMeshInfo();
                info.Smr = smr;
                info.Pos = pos;
                // 任务 BZ：R9 sd/跟隙要按「脚底朝下的身体顶点」筛选，必须拿到世界法线。
                // BakeMesh 的法线在渲染器局部系，用逆转置转到世界（非均匀缩放也正确）。
                Vector3[] nrm = null;
                try
                {
                    Vector3[] rawN = m.normals;
                    if (rawN != null && rawN.Length == n)
                    {
                        Matrix4x4 nim = smr.transform.localToWorldMatrix.inverse.transpose;
                        nrm = new Vector3[n];
                        for (int i = 0; i < n; i++)
                        {
                            Vector3 v = nim.MultiplyVector(rawN[i]);
                            nrm[i] = v.sqrMagnitude > 1e-12f ? v.normalized : Vector3.zero;
                        }
                    }
                }
                catch { }
                info.Nrm = nrm;
                info.Tris = tris;
                // 任务 CX：面积口径的稳定参考位置 = bind pose 的 sharedMesh 顶点 × localToWorld。
                // 失败（未开 Read/Write / 顶点数对不齐）时留 null，调用方回落到烘焙位置。
                try
                {
                    if (shared != null && shared.vertexCount == n)
                    {
                        Vector3[] sv = shared.vertices;
                        if (sv != null && sv.Length == n)
                        {
                            Matrix4x4 wm = smr.transform.localToWorldMatrix;
                            var rp = new Vector3[n];
                            for (int i = 0; i < n; i++) rp[i] = wm.MultiplyPoint3x4(sv[i]);
                            info.RestPos = rp;
                        }
                    }
                }
                catch { }
                info.BakedCount = n;
                info.SharedCount = shared != null ? shared.vertexCount : 0;
                info.RegionSource = wsrc;
                info.HasWeights = hasWeights;
                info.Region = new string[n];
                info.BoneName = new string[n];
                info.Usable = new bool[n];
                info.Exclude = new int[n];
                info.RegionBones = new Dictionary<string, List<string>>(StringComparer.Ordinal);

                Transform[] bones = smr.bones;
                var cache = new Dictionary<Transform, string>();
                for (int i = 0; i < n; i++)
                {
                    Vector3 p = pos[i];
                    bool finite = IsFinite(p);
                    Transform bt = null;
                    if (bones != null && dom[i] >= 0 && dom[i] < bones.Length) bt = bones[dom[i]];
                    info.BoneName[i] = bt != null ? bt.name : "unknown";
                    info.Region[i] = RegionOf(bt, map, root, cache);

                    int reason;
                    // 先认「删除」机制（NaNimation 删除 / 权重为 0），再认非有限坐标；
                    // 否则被 NaNimation 移成 NaN 的顶点会一律落进 nan，看不出是「删掉了」。
                    if (IsNanimatedBone(bt, root)) reason = ExNanimated;
                    else if (total != null && total[i] <= WeightZeroEps) reason = ExZeroWeight;
                    else if (!finite) reason = ExNonFinite;
                    else if ((p - origin).sqrMagnitude > farSqr) reason = ExBeyond3m;
                    else reason = ExOk;
                    info.Exclude[i] = reason;
                    info.Usable[i] = reason == ExOk;

                    List<string> bl;
                    if (!info.RegionBones.TryGetValue(info.Region[i], out bl))
                    {
                        bl = new List<string>();
                        info.RegionBones[info.Region[i]] = bl;
                    }
                    if (!bl.Contains(info.BoneName[i])) bl.Add(info.BoneName[i]);
                }
                foreach (var kv in info.RegionBones) kv.Value.Sort(StringComparer.Ordinal);
                return info;
            }
            finally
            {
                Object.DestroyImmediate(m);
            }
        }

        /// <summary>主骨骼名或父链上含 "NaNimat"：MA ShapeChanger 的 Delete 用它把顶点移走，运行时不显示。</summary>
        private static bool IsNanimatedBone(Transform t, Transform root)
        {
            Transform cur = t;
            int guard = 0;
            while (cur != null && guard++ < 512)
            {
                if (cur.name != null && cur.name.IndexOf("NaNimat", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                if (cur == root) break;
                cur = cur.parent;
            }
            return false;
        }

        private static bool IsFinite(Vector3 v)
        {
            return !float.IsNaN(v.x) && !float.IsInfinity(v.x)
                && !float.IsNaN(v.y) && !float.IsInfinity(v.y)
                && !float.IsNaN(v.z) && !float.IsInfinity(v.z);
        }

        /// <summary>每个顶点的最大权重骨骼索引；读不到返回 null。优先新 API，退回 legacy。</summary>
        private static int[] DominantBones(Mesh mesh, int vertexCount, out float[] totalWeight, out string source)
        {
            totalWeight = null;
            source = "none";
            if (mesh == null) return null;
            try
            {
                NativeArray<byte> bpv = mesh.GetBonesPerVertex();
                if (bpv.Length == vertexCount && vertexCount > 0)
                {
                    NativeArray<BoneWeight1> bw = mesh.GetAllBoneWeights();
                    if (bw.Length > 0)
                    {
                        int[] res = new int[vertexCount];
                        float[] tot = new float[vertexCount];
                        int k = 0;
                        for (int i = 0; i < vertexCount; i++)
                        {
                            int c = bpv[i];
                            int bestBone = -1;
                            float bestW = -1f, sum = 0f;
                            for (int j = 0; j < c; j++)
                            {
                                if (k >= bw.Length) break;
                                BoneWeight1 w = bw[k++];
                                sum += w.weight;
                                if (w.weight > bestW) { bestW = w.weight; bestBone = w.boneIndex; }
                            }
                            res[i] = bestBone;
                            tot[i] = sum;
                        }
                        totalWeight = tot;
                        source = "bone_weights";
                        return res;
                    }
                }
            }
            catch { }

            try
            {
                BoneWeight[] bw = mesh.boneWeights;
                if (bw != null && bw.Length == vertexCount && vertexCount > 0)
                {
                    int[] res = new int[vertexCount];
                    float[] tot = new float[vertexCount];
                    for (int i = 0; i < vertexCount; i++)
                    {
                        BoneWeight w = bw[i];
                        int b = w.boneIndex0;
                        float mx = w.weight0;
                        if (w.weight1 > mx) { mx = w.weight1; b = w.boneIndex1; }
                        if (w.weight2 > mx) { mx = w.weight2; b = w.boneIndex2; }
                        if (w.weight3 > mx) { mx = w.weight3; b = w.boneIndex3; }
                        res[i] = b;
                        tot[i] = w.weight0 + w.weight1 + w.weight2 + w.weight3;
                    }
                    totalWeight = tot;
                    source = "bone_weights_legacy";
                    return res;
                }
            }
            catch { }
            return null;
        }

        private static int[] NearestBoneIndices(Transform[] bones, Vector3[] pos, int n)
        {
            var res = new int[n];
            if (bones == null || bones.Length == 0)
            {
                for (int i = 0; i < n; i++) res[i] = -1;
                return res;
            }
            var bp = new Vector3[bones.Length];
            var ok = new bool[bones.Length];
            for (int b = 0; b < bones.Length; b++)
            {
                ok[b] = bones[b] != null;
                if (ok[b]) bp[b] = bones[b].position;
            }
            for (int i = 0; i < n; i++)
            {
                int best = -1;
                float bd = float.MaxValue;
                Vector3 p = pos[i];
                for (int b = 0; b < bones.Length; b++)
                {
                    if (!ok[b]) continue;
                    float d = (bp[b] - p).sqrMagnitude;
                    if (d < bd) { bd = d; best = b; }
                }
                res[i] = best;
            }
            return res;
        }

        /// <summary>烘焙蒙皮网格并转成世界坐标（顶点与三角面都可用，供 MeshCollider / 哈希）。</summary>
        private static Mesh BakeWorldMesh(SkinnedMeshRenderer smr)
        {
            var m = new Mesh();
            m.indexFormat = IndexFormat.UInt32;
            m.hideFlags = HideFlags.HideAndDontSave;
            smr.BakeMesh(m, true);
            Vector3[] v = m.vertices;
            Matrix4x4 mat = smr.transform.localToWorldMatrix;
            for (int i = 0; i < v.Length; i++) v[i] = mat.MultiplyPoint3x4(v[i]);
            m.vertices = v;
            m.RecalculateBounds();
            return m;
        }

        /// <summary>任意带网格 Renderer 的世界坐标网格（SMR 走 BakeMesh，MeshRenderer 走 sharedMesh+localToWorld）。</summary>
        private static Mesh MeshWorldOf(Renderer r, AuditContext ctx)
        {
            var smr = r as SkinnedMeshRenderer;
            if (smr != null)
            {
                if (smr.sharedMesh == null) return null;
                return BakeWorldMesh(smr);
            }

            var mf = r.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) return null;
            Mesh src = mf.sharedMesh;
            var m = new Mesh();
            m.indexFormat = IndexFormat.UInt32;
            m.hideFlags = HideFlags.HideAndDontSave;
            try
            {
                Vector3[] v = src.vertices;
                int[] tris = src.triangles;
                Matrix4x4 mat = r.transform.localToWorldMatrix;
                for (int i = 0; i < v.Length; i++) v[i] = mat.MultiplyPoint3x4(v[i]);
                m.vertices = v;
                m.triangles = tris;
                m.RecalculateBounds();
                return m;
            }
            catch (Exception e)
            {
                Object.DestroyImmediate(m);
                ctx.Warn("读网格失败（可能未开 Read/Write）：" + r.gameObject.name + "：" + e.Message);
                return null;
            }
        }

        /// <summary>边界边占比（开口件信号）与非流形边占比。边界边 = 只被 1 个三角面引用的边。</summary>
        private static void BoundaryStats(Mesh m, out float boundaryRatio, out float nonManifoldRatio)
        {
            boundaryRatio = 0f;
            nonManifoldRatio = 0f;
            int[] tris;
            try { tris = m.triangles; }
            catch { return; }
            if (tris == null || tris.Length < 3) return;

            var edges = new Dictionary<long, int>(tris.Length);
            for (int k = 0; k + 2 < tris.Length; k += 3)
            {
                AddEdge(edges, tris[k], tris[k + 1]);
                AddEdge(edges, tris[k + 1], tris[k + 2]);
                AddEdge(edges, tris[k + 2], tris[k]);
            }
            if (edges.Count == 0) return;

            int boundary = 0, nonManifold = 0;
            foreach (var kv in edges)
            {
                if (kv.Value == 1) boundary++;
                else if (kv.Value > 2) nonManifold++;
            }
            boundaryRatio = (float)boundary / edges.Count;
            nonManifoldRatio = (float)nonManifold / edges.Count;
        }

        private static void AddEdge(Dictionary<long, int> edges, int a, int b)
        {
            if (a == b) return;
            int lo = a < b ? a : b;
            int hi = a < b ? b : a;
            long key = ((long)lo << 32) | (uint)hi;
            int c;
            edges.TryGetValue(key, out c);
            edges[key] = c + 1;
        }

        // ── 最近点哈希（2 mm 网格，查 27 邻格）──

        private static int[] NearestCounts(Vector3[] from, Vector3[] to, float cellM, float[] thresholds)
        {
            var counts = new int[thresholds.Length];
            if (from == null || to == null || from.Length == 0 || to.Length == 0) return counts;
            if (cellM <= 0f) cellM = 0.002f;

            var grid = new Dictionary<long, List<int>>(to.Length);
            for (int i = 0; i < to.Length; i++)
            {
                long k = CellKey(to[i], cellM);
                List<int> l;
                if (!grid.TryGetValue(k, out l)) { l = new List<int>(); grid[k] = l; }
                l.Add(i);
            }

            float[] thrSqr = new float[thresholds.Length];
            for (int t = 0; t < thresholds.Length; t++) thrSqr[t] = thresholds[t] * thresholds[t];

            for (int f = 0; f < from.Length; f++)
            {
                Vector3 p = from[f];
                int ix = Mathf.FloorToInt(p.x / cellM);
                int iy = Mathf.FloorToInt(p.y / cellM);
                int iz = Mathf.FloorToInt(p.z / cellM);
                float best = float.MaxValue;
                for (int dx = -1; dx <= 1; dx++)
                {
                    for (int dy = -1; dy <= 1; dy++)
                    {
                        for (int dz = -1; dz <= 1; dz++)
                        {
                            List<int> l;
                            if (!grid.TryGetValue(Combine(ix + dx, iy + dy, iz + dz), out l)) continue;
                            for (int t = 0; t < l.Count; t++)
                            {
                                Vector3 q = to[l[t]];
                                float d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y) + (q.z - p.z) * (q.z - p.z);
                                if (d < best) best = d;
                            }
                        }
                    }
                }
                for (int t = 0; t < thresholds.Length; t++)
                    if (best <= thrSqr[t]) counts[t]++;
            }
            return counts;
        }

        private static long CellKey(Vector3 p, float cellM)
        {
            return Combine(Mathf.FloorToInt(p.x / cellM), Mathf.FloorToInt(p.y / cellM), Mathf.FloorToInt(p.z / cellM));
        }

        private static long Combine(int x, int y, int z)
        {
            long lx = (long)(x & 0x1FFFFF);
            long ly = (long)(y & 0x1FFFFF);
            long lz = (long)(z & 0x1FFFFF);
            return (lx << 42) | (ly << 21) | lz;
        }

        // ════════════════════════════════════════════════════════════════
        // 探针 5：poke —— T-28a 静态穿出斑块（几何 v4 主判据）
        //
        // 设计依据 03 §8.2 ①②③⑦（04 T-10）：
        //   ① 外壳三角形：只对本根衣物发射线（身体与其它根不建碰撞体）。外向以「远离该覆盖区
        //      锚骨线段」为准，网格绕序法线与之相反者计 normals_flipped。质心 +1 mm 起沿外向
        //      （与 ±cone 锥共 5 条）在 shell_ray_m 内不打到本根其它衣物三角形即外壳。
        //   ② 有向深度 d_v：被覆盖身体顶点到最近外壳特征（面/边/顶点分类）的距离，符号用
        //      角度加权伪法线；最近特征为边界边（靴口/裙摆/袖口）记 opening，不做穿出；d>3τ
        //      再记 opening_deep（advisory）。
        //   ③ 斑块：身体网格邻接图上 d_v > τ 的连通分量；报面积 cm²、最大/平均深度、子部位、
        //      锚骨局部质心、2 机位。
        //   ⑦ Delete/NaN 顶点按原因单独计数。
        // 穿越计数与包含率只作参考列（containment 探针，poke_reference=true 时内嵌一份）。
        //
        // 与 containment 的关系：复用它的身体烘焙、部位映射、剔除码、锚骨局部系；本探针不改变
        // containment 的既有字段与判定，只新增 "poke"。所有口径写进 审查/docs/probe-poke.md（原 README §3.2.5；旧注释写作 §3.2.6）。
        // ════════════════════════════════════════════════════════════════

        /// <summary>一次 poke 计算的返回。Json 进 state_*.json 的 probes.poke；Hits = 斑块数合计。</summary>
        private sealed class PokeResult
        {
            public JsonObject Json;
            public int Hits;
        }

        // 任务 CI：改成 internal 供离线 selftest（CIPokeSelfCheck）直接断言 decl 解析结果。
        internal sealed class PokeCoverSpec
        {
            public string Garment;
            public List<string> Regions = new List<string>();
            public string Confidence;      // high | low | null（未声明）
        }

        private sealed class PokeParams
        {
            // 任务 CW（poke 假阴性两处硬卡）：
            //   MinAreaCm2 只在「请求显式覆盖」或「min_patch_rule=legacy」时有意义；
            //   adaptive（默认）时每个配对按身体网格密度推导 min_patch_area_cm2 =
            //   max(absolute_floor, min_verts_for_patch × area_per_vert_cm2)。
            public float MinAreaCm2 = 0.5f;
            public bool MinAreaExplicit = false;
            public string MinPatchRule = "adaptive";   // adaptive | legacy
            public float AbsoluteFloorCm2 = 0.05f;      // adaptive 的硬下界
            public int MinVertsForPatch = 8;            // 「至少 N 个连通顶点才算一片」——顶点数判据、跨身体可比
            public float TauTorsoMm = 2f;
            public float TauLimbMm = 3f;
            public float ShellRayM = 0.5f;
            public float ConeDeg = 20f;
            public float OriginM = 0.001f;
            public float OpeningDeepFactor = 3f;
            public bool Reference = false;
            public int MaxPatches = 500;
            public string Hide;
            public string BodySpec = "auto";
            public int Layer = DefaultTempLayer;
            public float RegionMinShare = 0.02f;
            public string IncludeRegex;
            public string ExcludeRegex =
                "(?i)(hair|face|eye|lash|tooth|tongue|head|halo|particle|nail|avatarhight|tail|ear)";
            public List<float> Doses = new List<float>();
            public string PerturbRenderer;
            public string PerturbShape;
            public List<PokeCoverSpec> Covers = new List<PokeCoverSpec>();
            public string DeclPath;
            public long RayBudget = 3000000L;
            public bool HideSelfCheck = true;
            // 任务 BZ（R9 sd/跟隙）：脚部 covers 内「脚底朝下」的判定阈值；鞋底壳面需同样朝下。
            public bool SdEnabled = true;
            public float SdDownCos = 0.5f;   // 顶点法线 · 世界向下 ≥ 该值算「朝下」（0.5 ≈ 60°）
            // 任务 CF（R9 v2）：鞋垫面（内壳朝上）距离 si 与脚底/鞋垫平面夹角 tilt。
            // 动机：sd 量的是外壳里朝下的面（外底），半抬脚跟时前掌陷进鞋底实体、离外底反而近，
            // 会把 =50 排到 =100 前；R9 v2 直接量到「鞋垫面」，并看脚底平面倾角。
            public bool InsoleEnabled = true;
            public float InsoleUpCos = 0.5f;        // 面法线 · 世界向上 ≥ 该值算「朝上」（0.5 ≈ 60°）
            public float InsoleBboxMarginMm = 5f;   // 脚部 covers 包围盒外扩
            public float InsoleSoleMinMm = 0.5f;    // 鞋垫面至少要高出外底这么多
            public float InsoleSoleMaxMm = 80f;     // 高出外底超过这个的不算鞋垫（多半是鞋帮/鞋口）
            // 任务 CI（poke 上衣假阳性诊断）：
            //   Diag=true 时每个斑块输出 ≤20 个样本顶点的最近外壳/射线证据（请求 poke.diag）。
            //   ShellRule 控制「什么算外壳」：any=任一条射线逃逸（旧行为，默认）；outward=只有外向
            //   射线逃逸才算；majority=至少 ShellMajorityMin 条逃逸才算。用于在不重编译的前提下
            //   对照验证「任一条逃逸太宽」假设（见 审查/docs/probe-poke-diag.md，原 README §3.2.5.1）。
            //   NormalSign 控制伪法线符号来源：anchor=按锚骨外向翻正绕序法线（旧行为，默认）；
            //   winding=直接用网格绕序法线；parity=绕序法线 + 每顶点「身体在不在衣服里」射线奇偶投票定号。
            public bool Diag = false;
            public string ShellRule = "any";
            public int ShellMajorityMin = 3;
            public string NormalSign = "anchor";
        }

        private sealed class PokeGarment
        {
            public Renderer R;
            public string Path;
            public string Name;
            public Vector3[] Pos;            // 世界坐标（顶点）
            public int[] Tris;               // 三角面（顶点序号）
            public int VertexCount;
            public int TriCount;
            public Vector3[] FaceNrm;        // 绕序几何法线（未定向）
            public Vector3[] OrientedNrm;    // 按锚骨外向翻正后的法线
            public bool[] Flipped;           // 与锚骨外向相反（normals_flipped）
            public bool[] IsShell;           // 外壳三角形
            public int ShellCount;
            public GameObject Go;
            public Mesh ColMesh;
            public MeshCollider Collider;
            public PokeBvh Bvh;
            public Dictionary<long, int> EdgeCount;
            public Dictionary<long, Vector3> EdgeNormal;
            public Vector3[] VertexPseudo;   // 角度加权顶点伪法线（已定向）
            // 任务 CF（R9 v2）：鞋垫面（朝上内壳）BVH 与几何。InsoleBvh 只含「朝上、在脚部
            // covers 包围盒内、且在外底之上（厚度合理）」的三角形；不要求是外壳。
            public PokeBvh InsoleBvh;
            public List<Vector3> InsoleCentroids;   // 鞋垫面质心（拟合鞋垫平面用）
            public int InsoleFaces;
            // 任务 CI：外壳分类的逐面证据（p.Diag 时才分配；否则为 null，省内存）。
            public int[] ShellRay;          // 判该面为外壳的逃逸射线序号：0=外向，1..4=锥向第 k 条；-1=非外壳
            public Vector3[] ShellRayEnd;   // 该逃逸射线的终点（发射点 + dir*shell_ray_m）
            public float[] OutwardDot;      // dot(绕序法线, 计算外向)：<0 即 normals_flipped
            public int ShellOutwardEscaped; // 外壳面里「外向射线自己就逃逸」的面数
            public int ShellConeRescued;    // 外壳面里「外向被挡、靠锥向射线救回来」的面数
        }

        private sealed class PokeRun
        {
            public string DoseLabel;                 // null = 未施加剂量
            public float TotalAreaCm2;
            public int PatchCount;
            public int OpeningVerts;
            public int OpeningDeepVerts;
            public int ShellFaces;
            public int FlippedFaces;
            public bool Truncated;
            public long RaysUsed;
            public List<PokePairResult> Pairs = new List<PokePairResult>();
            public JsonObject BodyExcluded;
            public int BodyBakedVertices;
            public int BodySharedVertices;
            public string BodyRegionSource;
            // 任务 CW：被面积门槛丢掉的分量（run 级汇总）与本次用到的阈值/密度。
            public int DroppedComponents;
            public float DroppedMaxAreaCm2;
            public float DroppedTotalAreaCm2;
            public float DroppedMaxDepthMm;
            public float MinAreaPerVertCm2;
            public string MinAreaPerVertPosSource;   // 任务 CX：最小值那对的位置口径
            public float MinPatchAreaCm2;
            public bool SuspectSubthreshold;
        }

        private sealed class PokePairResult
        {
            public PokeCoverSpec Spec;
            public PokeGarment G;
            public string PairSource = "decl_covers";
            public string PairConfidence = "high";
            public string PairReason;
            public bool BboxOverlap = true;
            public List<string> Regions = new List<string>();
            public Dictionary<string, int> RegionTotal = new Dictionary<string, int>(StringComparer.Ordinal);
            public Dictionary<string, int> RegionExNan = new Dictionary<string, int>(StringComparer.Ordinal);
            public Dictionary<string, int> RegionExDel = new Dictionary<string, int>(StringComparer.Ordinal);
            public Dictionary<string, int> RegionExDelNani = new Dictionary<string, int>(StringComparer.Ordinal);
            public Dictionary<string, int> RegionExDelZero = new Dictionary<string, int>(StringComparer.Ordinal);
            public Dictionary<string, int> RegionExFar = new Dictionary<string, int>(StringComparer.Ordinal);
            public Dictionary<string, List<float>> RegionDepthMm = new Dictionary<string, List<float>>(StringComparer.Ordinal);
            public Dictionary<string, int> RegionOpening = new Dictionary<string, int>(StringComparer.Ordinal);
            public Dictionary<string, int> RegionOpeningDeep = new Dictionary<string, int>(StringComparer.Ordinal);
            public Dictionary<string, int> SubPartOpening = new Dictionary<string, int>(StringComparer.Ordinal);
            public Dictionary<string, List<float>> SubPartDepthMm = new Dictionary<string, List<float>>(StringComparer.Ordinal);
            // 任务 BZ（R9）：脚底到鞋底内表面的有向距离（正=脚在鞋底上方、负=穿出鞋底）。
            // SdMm 覆盖脚部 covers 内所有「朝下」顶点；HeelGapSoleMm 只收脚跟段。
            public List<float> SdMm = new List<float>();
            public List<float> HeelGapSoleMm = new List<float>();   // 旧口径：到最近朝下壳面（外底）
            public int SdFootVerts;        // 脚部 covers 内的身体顶点数（诊断）
            public int SdSoleFacingVerts;  // 其中「身体朝下 + 最近壳面朝下」的顶点数
            // 任务 CF（R9 v2）：脚底朝下顶点到「鞋垫面」的有向距离 si（正=悬空、负=陷入鞋垫）。
            // SiMm 覆盖脚部 covers 内全部「朝下」身体顶点；HeelSiMm 只收脚跟段（PokeSubPart=ankle）。
            public List<float> SiMm = new List<float>();
            public List<float> HeelSiMm = new List<float>();
            public int SiFootVerts;        // 身体朝下、且鞋垫 BVH 存在的顶点数（诊断）
            public int InsoleFaces;        // 本次实际认到的鞋垫面数（0=没有朝上内壳，si 缺）
            // 脚底平面 vs 鞋垫平面夹角（度）；两者各自 vs 水平也输出，便于排障。
            public float? TiltDeg;
            public float? FootPlaneTiltDeg;
            public float? InsolePlaneTiltDeg;
            public int TiltFootVerts;
            public int TiltInsoleFaces;
            public List<PokePatch> Patches = new List<PokePatch>();
            public int OpeningVerts;
            public int OpeningDeepVerts;
            public int ShellFaces;
            public int FlippedFaces;
            // 任务 CI：本对外壳面里「外向射线即逃逸」与「靠锥向射线救回」的面数。
            public int ShellOutwardEscaped;
            public int ShellConeRescued;
            public int MeshVertices;
            public int MeshTriangles;
            public int RefVerts, RefInside, RefEdges, RefCrossing;
            public float RefMaxCrossingMm;
            public bool HasRef;
            // 任务 CW：面积阈值推导 + 被丢掉的连通分量（永远输出，别让 0 吃掉证据）。
            public float AreaPerVertCm2;         // 本次配对被测区每顶点面积份额（三角形面积按顶点均分）
            public string AreaPerVertPosSource;  // bind_pose（稳定参考，任务 CX 默认）| baked（sharedMesh 读不到时的回落）
            public int RegionVerts;              // 被测区里「可用」的身体顶点数
            public float RegionAreaCm2;          // 被测区里三顶点全可用的身体三角形面积和（cm²）
            public float MinPatchAreaCm2;        // 本次实际生效的斑块面积门槛
            public string MinPatchAreaSource;    // request | adaptive | legacy
            public int DroppedComponents;        // 被面积门槛过滤掉的连通分量数
            public float DroppedMaxAreaCm2;
            public float DroppedTotalAreaCm2;
            public float DroppedMaxDepthMm;
            public bool SuspectSubthreshold;     // 有 sub_part 超阈值却没凑成斑块

            /// <summary>输出用总面积 = 达到面积阈值的斑块面积和（cm²）。</summary>
            public float TotalAreaCm2ForOutput()
            {
                float a = 0f;
                for (int i = 0; i < Patches.Count; i++) a += Patches[i].AreaCm2;
                return a;
            }
        }

        private sealed class PokePatch
        {
            public float AreaCm2;
            public float MaxDepthMm;
            public float AvgDepthMm;
            public float MinDepthMm;
            public int Verts;
            public string Region;
            public string SubPart;
            public Vector3 AnchorLocal;
            public Vector3 WorldCentroid;
            public Vector3 WorldNormal;
            // 任务 CI：p.Diag 时该斑块的 ≤20 个样本顶点证据（确定性等距抽样）；否则 null。
            public List<PokeDiagVert> Diag;
        }

        /// <summary>
        /// 任务 CI：一个斑块样本顶点的「最近外壳特征 + 该特征被判为外壳的射线证据」。
        /// 用来把假阳性的来源拆开：外壳是不是被锥向射线救回来的、绕序法线与计算外向是否相反、
        /// 最近特征落在哪个 triangle（garment/面序号/特征类型）。
        /// </summary>
        internal sealed class PokeDiagVert
        {
            public Vector3 World;
            public float Dmm;
            public int Feature;             // 0 面 / 1..3 边 / 4..6 顶点（ClosestOnTriangle 特征码）
            public int Face;                // 最近外壳三角形序号（=三角形下标）
            public string Garment;
            public int ShellRay = -1;       // -1=该面不是外壳（理论不会出现在样本里）
            public Vector3 ShellRayEnd;
            public float OutwardDot;        // dot(绕序法线, 计算外向)
            public bool Flipped;
            public Vector3 PseudoNormal;
            public bool Opening;
            public bool ConeRescued;        // 最近外壳面是「外向被挡、靠锥向救回」
            public bool InsideByParity;     // 绕序法线 + 奇偶投票：身体顶点在不在该件内
            public int ParityHits;          // 3 轴投票里判「在内部」的轴数（0..3）
            public bool ParityKnown;
        }

        // ── BVH（外壳三角形的最近点查询）───────────────────────────────
        // Physics.ClosestPoint 不支持非凸 MeshCollider，所以自建一棵按质心中位数二分的
        // 包围盒树。叶子存面序号，查询用 AABB 距离剪枝；返回最近三角形上的最近点与特征码。
        internal sealed class PokeBvh
        {
            private readonly Vector3[] _pos;
            private readonly int[] _tris;
            private readonly int[] _face;      // 外壳面序号
            private readonly Vector3[] _cent;
            private readonly int[] _order;     // [0..n) 的置换，指向 _face 的槽位
            private readonly int[] _l, _r, _start, _cnt;
            private readonly Vector3[] _bmin, _bmax;
            private readonly int _cap;
            private int _nodes;
            private readonly int _root;
            private readonly int[] _stack = new int[128];

            public int FaceCount { get { return _face.Length; } }

            public PokeBvh(Vector3[] pos, int[] tris, List<int> faces)
            {
                _pos = pos; _tris = tris;
                int n = faces.Count;
                _face = new int[n];
                _cent = new Vector3[n];
                _order = new int[n];
                for (int i = 0; i < n; i++)
                {
                    int f = faces[i];
                    _face[i] = f;
                    Vector3 a = pos[tris[3 * f]], b = pos[tris[3 * f + 1]], c = pos[tris[3 * f + 2]];
                    _cent[i] = (a + b + c) / 3f;
                    _order[i] = i;
                }
                _cap = Mathf.Max(1, n * 2 + 1);
                _l = new int[_cap]; _r = new int[_cap]; _start = new int[_cap]; _cnt = new int[_cap];
                _bmin = new Vector3[_cap]; _bmax = new Vector3[_cap];
                _nodes = 0;
                if (n > 0) _root = Build(0, n);
                else _root = -1;
            }

            private int Build(int lo, int hi)
            {
                int node = _nodes++;
                Vector3 mn = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
                Vector3 mx = new Vector3(float.MinValue, float.MinValue, float.MinValue);
                Vector3 cmn = mn, cmx = mx;
                for (int i = lo; i < hi; i++)
                {
                    int f = _face[_order[i]];
                    for (int k = 0; k < 3; k++)
                    {
                        Vector3 v = _pos[_tris[3 * f + k]];
                        if (v.x < mn.x) mn.x = v.x; if (v.y < mn.y) mn.y = v.y; if (v.z < mn.z) mn.z = v.z;
                        if (v.x > mx.x) mx.x = v.x; if (v.y > mx.y) mx.y = v.y; if (v.z > mx.z) mx.z = v.z;
                    }
                    Vector3 c = _cent[_order[i]];
                    if (c.x < cmn.x) cmn.x = c.x; if (c.y < cmn.y) cmn.y = c.y; if (c.z < cmn.z) cmn.z = c.z;
                    if (c.x > cmx.x) cmx.x = c.x; if (c.y > cmx.y) cmx.y = c.y; if (c.z > cmx.z) cmx.z = c.z;
                }
                _bmin[node] = mn; _bmax[node] = mx;
                if (hi - lo <= 3)
                {
                    _cnt[node] = hi - lo; _start[node] = lo; _l[node] = _r[node] = -1;
                    return node;
                }
                Vector3 ext = cmx - cmn;
                int axis = 0;
                if (ext.y > ext.x) axis = 1;
                if (ext.z > (axis == 0 ? ext.x : ext.y)) axis = 2;
                var cmp = new PokeCentComparer(_cent, _order, axis);
                Array.Sort(_order, lo, hi - lo, cmp);
                int mid = (lo + hi) / 2;
                _cnt[node] = 0; _start[node] = 0;
                _l[node] = Build(lo, mid);
                _r[node] = Build(mid, hi);
                return node;
            }

            private sealed class PokeCentComparer : IComparer<int>
            {
                private readonly Vector3[] _c;
                private readonly int[] _order;
                private readonly int _axis;
                public PokeCentComparer(Vector3[] c, int[] order, int axis) { _c = c; _order = order; _axis = axis; }
                public int Compare(int x, int y)
                {
                    Vector3 a = _c[x], b = _c[y];
                    float d = (_axis == 0 ? a.x - b.x : (_axis == 1 ? a.y - b.y : a.z - b.z));
                    if (d < 0f) return -1;
                    if (d > 0f) return 1;
                    return x.CompareTo(y);
                }
            }

            private static float BoundsDistSqr(Vector3 bmin, Vector3 bmax, Vector3 q)
            {
                float dx = 0f, dy = 0f, dz = 0f;
                if (q.x < bmin.x) dx = bmin.x - q.x; else if (q.x > bmax.x) dx = q.x - bmax.x;
                if (q.y < bmin.y) dy = bmin.y - q.y; else if (q.y > bmax.y) dy = q.y - bmax.y;
                if (q.z < bmin.z) dz = bmin.z - q.z; else if (q.z > bmax.z) dz = q.z - bmax.z;
                return dx * dx + dy * dy + dz * dz;
            }

            /// <summary>
            /// 最近外壳三角形。feature：0 面 / 1 边 AB / 2 边 BC / 3 边 CA / 4 顶点 A / 5 顶点 B / 6 顶点 C。
            /// 返回外壳面序号，找不到返回 -1。
            /// </summary>
            public int Nearest(Vector3 q, out Vector3 closest, out float distSqr, out int feature)
            {
                closest = Vector3.zero; distSqr = float.MaxValue; feature = 0;
                if (_root < 0) return -1;
                int bestFace = -1;
                int sp = 0;
                _stack[sp++] = _root;
                while (sp > 0)
                {
                    int node = _stack[--sp];
                    if (BoundsDistSqr(_bmin[node], _bmax[node], q) > distSqr) continue;
                    if (_cnt[node] > 0)
                    {
                        int end = _start[node] + _cnt[node];
                        for (int i = _start[node]; i < end; i++)
                        {
                            int slot = _order[i];
                            int f = _face[slot];
                            Vector3 a = _pos[_tris[3 * f]], b = _pos[_tris[3 * f + 1]], c = _pos[_tris[3 * f + 2]];
                            float u, v, w; int reg;
                            Vector3 cp = ClosestOnTriangle(q, a, b, c, out u, out v, out w, out reg);
                            float d = (cp - q).sqrMagnitude;
                            if (d < distSqr) { distSqr = d; closest = cp; feature = reg; bestFace = f; }
                        }
                    }
                    else
                    {
                        int l = _l[node], r = _r[node];
                        if (l >= 0 && r >= 0)
                        {
                            float dl = BoundsDistSqr(_bmin[l], _bmax[l], q);
                            float dr = BoundsDistSqr(_bmin[r], _bmax[r], q);
                            if (dl < dr) { if (dr < distSqr) _stack[sp++] = r; if (dl < distSqr) _stack[sp++] = l; }
                            else { if (dl < distSqr) _stack[sp++] = l; if (dr < distSqr) _stack[sp++] = r; }
                        }
                    }
                }
                return bestFace;
            }

            /// <summary>
            /// 任务 CU：射线与外壳三角形的最近命中（BVH 加速）。返回面序号，未命中 -1；dist 为沿 dir 的距离（米）。
            /// 求交调 ShrinkCoverRayRules.RayHitsTriangle（双面），与离线自检共用同一段几何。
            /// </summary>
            public int Raycast(Vector3 origin, Vector3 dir, float maxDist, out float dist)
            {
                dist = float.MaxValue;
                if (_root < 0 || maxDist <= 0f) return -1;
                var o = new ScVec(origin.x, origin.y, origin.z);
                var d = new ScVec(dir.x, dir.y, dir.z);
                if (d.Length() < 1e-12f) return -1;
                int bestFace = -1;
                float bestT = maxDist;
                int sp = 0;
                _stack[sp++] = _root;
                while (sp > 0)
                {
                    int node = _stack[--sp];
                    float boxT;
                    if (!RayHitsAabb(_bmin[node], _bmax[node], origin, dir, bestT, out boxT)) continue;
                    if (_cnt[node] > 0)
                    {
                        int end = _start[node] + _cnt[node];
                        for (int i = _start[node]; i < end; i++)
                        {
                            int f = _face[_order[i]];
                            Vector3 a3 = _pos[_tris[3 * f]], b3 = _pos[_tris[3 * f + 1]], c3 = _pos[_tris[3 * f + 2]];
                            var a = new ScVec(a3.x, a3.y, a3.z);
                            var b = new ScVec(b3.x, b3.y, b3.z);
                            var c = new ScVec(c3.x, c3.y, c3.z);
                            float t;
                            if (ShrinkCoverRayRules.RayHitsTriangle(o, d, bestT, a, b, c, out t) && t < bestT)
                            { bestT = t; bestFace = f; }
                        }
                    }
                    else
                    {
                        int l = _l[node], r = _r[node];
                        if (l >= 0) _stack[sp++] = l;
                        if (r >= 0) _stack[sp++] = r;
                    }
                }
                if (bestFace >= 0) dist = bestT;
                return bestFace;
            }

            /// <summary>射线与 AABB 的 slab 相交；命中区间在 [0, maxDist] 内返回 true。</summary>
            private static bool RayHitsAabb(Vector3 bmin, Vector3 bmax, Vector3 o, Vector3 d, float maxDist, out float tmin)
            {
                tmin = 0f;
                float tmax = maxDist;
                if (!Slab(o.x, d.x, bmin.x, bmax.x, ref tmin, ref tmax)) return false;
                if (!Slab(o.y, d.y, bmin.y, bmax.y, ref tmin, ref tmax)) return false;
                if (!Slab(o.z, d.z, bmin.z, bmax.z, ref tmin, ref tmax)) return false;
                return tmax >= 0f && tmin <= maxDist;
            }

            private static bool Slab(float o, float d, float bmin, float bmax, ref float tmin, ref float tmax)
            {
                if (Mathf.Abs(d) < 1e-12f)
                {
                    if (o < bmin || o > bmax) return false;
                    return true;
                }
                float inv = 1f / d;
                float t1 = (bmin - o) * inv, t2 = (bmax - o) * inv;
                if (t1 > t2) { float tmp = t1; t1 = t2; t2 = tmp; }
                if (t1 > tmin) tmin = t1;
                if (t2 < tmax) tmax = t2;
                return tmin <= tmax;
            }
        }

        /// <summary>点到三角形最近点（Ericson），同时给出重心坐标与特征码。internal 供 T-05 的
        /// key_follow 几何加权复用（任务 AY）。</summary>
        internal static Vector3 ClosestOnTriangle(Vector3 p, Vector3 a, Vector3 b, Vector3 c,
            out float u, out float v, out float w, out int region)
        {
            Vector3 ab = b - a, ac = c - a, ap = p - a;
            float d1 = Vector3.Dot(ab, ap), d2 = Vector3.Dot(ac, ap);
            if (d1 <= 0f && d2 <= 0f) { u = 1f; v = 0f; w = 0f; region = 4; return a; }

            Vector3 bp = p - b;
            float d3 = Vector3.Dot(ab, bp), d4 = Vector3.Dot(ac, bp);
            if (d3 >= 0f && d4 <= d3) { u = 0f; v = 1f; w = 0f; region = 5; return b; }

            float vc = d1 * d4 - d3 * d2;
            if (vc <= 0f && d1 >= 0f && d3 <= 0f)
            {
                float t = d1 / (d1 - d3);
                u = 1f - t; v = t; w = 0f; region = 1;
                return a + ab * t;
            }

            Vector3 cp = p - c;
            float d5 = Vector3.Dot(ab, cp), d6 = Vector3.Dot(ac, cp);
            if (d6 >= 0f && d5 <= d6) { u = 0f; v = 0f; w = 1f; region = 6; return c; }

            float vb = d5 * d2 - d1 * d6;
            if (vb <= 0f && d2 >= 0f && d6 <= 0f)
            {
                float t = d2 / (d2 - d6);
                u = 1f - t; v = 0f; w = t; region = 3;
                return a + ac * t;
            }

            float va = d3 * d6 - d5 * d4;
            if (va <= 0f && (d4 - d3) >= 0f && (d5 - d6) >= 0f)
            {
                float t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                u = 0f; v = 1f - t; w = t; region = 2;
                return b + (c - b) * t;
            }

            float denom = 1f / (va + vb + vc);
            float vv = vb * denom, ww = vc * denom;
            u = 1f - vv - ww; v = vv; w = ww; region = 0;
            return a + ab * vv + ac * ww;
        }

        // ── poke 入口 ──────────────────────────────────────────────────

        /// <summary>给 T2（AuditFitProbe）等调用方用的公开入口；返回 poke 的 JsonObject。</summary>
        public static JsonObject RunPoke(AuditContext ctx, GameObject avatar, Animator anim)
        {
            PokeResult r = PokeCompute(ctx, avatar, anim);
            return r != null && r.Json != null ? r.Json : new JsonObject();
        }

        private static ProbeOut Poke(AuditContext ctx, GameObject avatar, Animator anim)
        {
            PokeResult r = PokeCompute(ctx, avatar, anim);
            ProbeOut po;
            po.Json = r != null && r.Json != null ? r.Json : new JsonObject();
            po.Hits = r != null ? r.Hits : 0;
            return po;
        }

        private static string PokeStr(AuditContext ctx, JsonObject po, string key, string def)
        {
            if (po != null) { string v = AuditJson.Str(po, key, null); if (v != null) return v; }
            return ctx.S("poke_" + key, def);
        }

        private static double PokeNum(AuditContext ctx, JsonObject po, string key, double def)
        {
            if (po != null && po.Has(key)) return AuditJson.Num(po, key, def);
            return ctx.N("poke_" + key, def);
        }

        private static int PokeInt(AuditContext ctx, JsonObject po, string key, int def)
        {
            if (po != null && po.Has(key)) return AuditJson.Int(po, key, def);
            return ctx.I("poke_" + key, def);
        }

        private static bool PokeBool(AuditContext ctx, JsonObject po, string key, bool def)
        {
            if (po != null && po.Has(key)) return AuditJson.Bool(po, key, def);
            return AuditJson.Bool(ctx.Request, "poke_" + key, def);
        }

        private static List<object> PokeArr(AuditContext ctx, JsonObject po, string key)
        {
            if (po != null) { List<object> a = AuditJson.Arr(po, key); if (a != null && a.Count > 0) return a; }
            return ctx.A("poke_" + key);
        }

        private static PokeParams PokeReadParams(AuditContext ctx)
        {
            var p = new PokeParams();
            JsonObject po = ctx.O("poke");
            // 任务 CW：面积阈值可推导。显式覆盖优先（新键 min_patch_area_cm2 或旧键 min_patch_cm2），
            // 其次 min_patch_rule=legacy 用固定 0.5，默认 adaptive 按每配对身体网格密度推导。
            string mpr = PokeStr(ctx, po, "min_patch_rule", "adaptive");
            mpr = string.IsNullOrEmpty(mpr) ? "adaptive" : mpr.Trim().ToLowerInvariant();
            if (mpr != "adaptive" && mpr != "legacy") mpr = "adaptive";
            p.MinPatchRule = mpr;
            p.MinVertsForPatch = PokeInt(ctx, po, "min_verts_for_patch", 8);
            if (p.MinVertsForPatch < 1) p.MinVertsForPatch = 8;
            double absFloor = PokeNum(ctx, po, "absolute_floor_cm2", double.NaN);
            if (double.IsNaN(absFloor)) absFloor = PokeNum(ctx, po, "absolute_floor", 0.05);
            p.AbsoluteFloorCm2 = (float)absFloor;
            if (p.AbsoluteFloorCm2 < 0f) p.AbsoluteFloorCm2 = 0.05f;
            double minAreaReq = PokeNum(ctx, po, "min_patch_area_cm2", double.NaN);
            if (double.IsNaN(minAreaReq)) minAreaReq = PokeNum(ctx, po, "min_patch_cm2", double.NaN);
            if (!double.IsNaN(minAreaReq))
            {
                p.MinAreaExplicit = true;
                p.MinAreaCm2 = (float)minAreaReq;
            }
            else
            {
                p.MinAreaExplicit = false;
                p.MinAreaCm2 = mpr == "legacy" ? 0.5f : float.NaN;   // adaptive 时每配对现算
            }
            if (p.MinAreaExplicit && p.MinAreaCm2 < 0f) p.MinAreaCm2 = 0f;
            p.TauTorsoMm = (float)PokeNum(ctx, po, "tau_torso_mm", 2.0);
            p.TauLimbMm = (float)PokeNum(ctx, po, "tau_limb_mm", 3.0);
            if (p.TauTorsoMm <= 0f) p.TauTorsoMm = 2f;
            if (p.TauLimbMm <= 0f) p.TauLimbMm = 3f;
            p.ShellRayM = (float)PokeNum(ctx, po, "shell_ray_m", 0.5);
            p.ConeDeg = (float)PokeNum(ctx, po, "cone_deg", 20.0);
            p.OriginM = (float)PokeNum(ctx, po, "origin_mm", 1.0) / 1000f;
            if (p.ShellRayM <= 0f) p.ShellRayM = 0.5f;
            if (p.ConeDeg < 0f || p.ConeDeg > 80f) p.ConeDeg = 20f;
            if (p.OriginM < 0f) p.OriginM = 0.001f;
            p.OpeningDeepFactor = (float)PokeNum(ctx, po, "opening_deep_factor", 3.0);
            if (p.OpeningDeepFactor <= 1f) p.OpeningDeepFactor = 3f;
            p.Reference = PokeBool(ctx, po, "reference", false);
            p.HideSelfCheck = PokeBool(ctx, po, "hide_selfcheck", true);
            p.SdEnabled = PokeBool(ctx, po, "sd_enabled", true);
            p.SdDownCos = (float)PokeNum(ctx, po, "sd_down_cos", 0.5);
            if (p.SdDownCos < -1f) p.SdDownCos = -1f;
            if (p.SdDownCos > 1f) p.SdDownCos = 1f;
            // 任务 CF（R9 v2）：鞋垫面距离 si / 脚底倾角 tilt。
            p.InsoleEnabled = PokeBool(ctx, po, "insole_enabled", true);
            p.InsoleUpCos = (float)PokeNum(ctx, po, "insole_up_cos", 0.5);
            if (p.InsoleUpCos < -1f) p.InsoleUpCos = -1f;
            if (p.InsoleUpCos > 1f) p.InsoleUpCos = 1f;
            p.InsoleBboxMarginMm = (float)PokeNum(ctx, po, "insole_bbox_margin_mm", 5.0);
            p.InsoleSoleMinMm = (float)PokeNum(ctx, po, "insole_sole_min_mm", 0.5);
            p.InsoleSoleMaxMm = (float)PokeNum(ctx, po, "insole_sole_max_mm", 80.0);
            if (p.InsoleSoleMaxMm < p.InsoleSoleMinMm) p.InsoleSoleMaxMm = p.InsoleSoleMinMm;
            p.MaxPatches = PokeInt(ctx, po, "max_patches", 500);
            if (p.MaxPatches <= 0) p.MaxPatches = 500;
            p.Hide = PokeStr(ctx, po, "hide", null);
            p.BodySpec = PokeStr(ctx, po, "body", "auto");
            p.Layer = PokeInt(ctx, po, "layer", DefaultTempLayer);
            if (p.Layer < 0 || p.Layer > 31) p.Layer = DefaultTempLayer;
            p.RegionMinShare = (float)PokeNum(ctx, po, "region_min_share", 0.02);
            if (p.RegionMinShare > 1f) p.RegionMinShare *= 0.01f;
            if (p.RegionMinShare <= 0f || p.RegionMinShare > 1f) p.RegionMinShare = 0.02f;
            p.IncludeRegex = PokeStr(ctx, po, "include", null);
            string ex = PokeStr(ctx, po, "exclude", null);
            if (!string.IsNullOrEmpty(ex)) p.ExcludeRegex = ex;
            p.DeclPath = PokeStr(ctx, po, "decl", null);
            // 任务 CI：诊断与两处可切换修法（默认关/旧行为）。
            p.Diag = PokeBool(ctx, po, "diag", false);
            string sr = PokeStr(ctx, po, "shell_rule", "any");
            sr = string.IsNullOrEmpty(sr) ? "any" : sr.Trim().ToLowerInvariant();
            if (sr != "any" && sr != "outward" && sr != "majority") sr = "any";
            p.ShellRule = sr;
            p.ShellMajorityMin = PokeInt(ctx, po, "shell_majority_min", 3);
            if (p.ShellMajorityMin < 1) p.ShellMajorityMin = 3;
            if (p.ShellMajorityMin > 5) p.ShellMajorityMin = 5;
            string ns = PokeStr(ctx, po, "normal_sign", "parity");  // 09-20 Claude：默认改 parity（anchor 在 Winter/MMN 标定失败、parity 通过）
            ns = string.IsNullOrEmpty(ns) ? "anchor" : ns.Trim().ToLowerInvariant();
            if (ns != "anchor" && ns != "winding" && ns != "parity") ns = "anchor";
            p.NormalSign = ns;
            p.RayBudget = (long)PokeNum(ctx, po, "ray_budget", 3000000.0);
            if (p.RayBudget <= 0L) p.RayBudget = 3000000L;

            // 剂量分档：poke.perturb / poke_perturb / 顶层 perturb{doses}
            JsonObject pert = po != null ? AuditJson.Obj(po, "perturb") : null;
            if (pert == null) pert = ctx.O("poke_perturb");
            if (pert == null) pert = ctx.O("perturb");
            if (pert != null)
            {
                p.PerturbRenderer = AuditJson.Str(pert, "renderer", null);
                p.PerturbShape = AuditJson.Str(pert, "blendshape", null);
                List<object> ds = AuditJson.Arr(pert, "doses");
                if (ds != null && ds.Count > 0) PokeAddDoses(p.Doses, ds);
            }
            if (p.Doses.Count == 0)
            {
                List<object> ds2 = PokeArr(ctx, po, "doses");
                if (ds2 != null && ds2.Count > 0) PokeAddDoses(p.Doses, ds2);
            }

            // 配对：声明 covers（poke_covers / poke.decl 指向 decl.json）
            List<object> coversArr = PokeArr(ctx, po, "covers");
            if (coversArr != null) PokeAddCovers(p.Covers, coversArr);
            if (!string.IsNullOrEmpty(p.DeclPath) && p.Covers.Count == 0)
                PokeReadDeclCovers(ctx, p);
            return p;
        }

        private static void PokeAddDoses(List<float> to, List<object> arr)
        {
            for (int i = 0; i < arr.Count; i++)
            {
                float d = AuditUtil.ToFloat(arr[i]);
                if (!to.Contains(d)) to.Add(d);
            }
        }

        private static void PokeAddCovers(List<PokeCoverSpec> to, List<object> arr)
        {
            for (int i = 0; i < arr.Count; i++)
            {
                var e = arr[i] as JsonObject;
                if (e == null)
                {
                    // 允许只写件名（"poke_covers":["Shoes"]）：部位由件名关键词推断。
                    string s = arr[i] as string;
                    if (s == null) s = Convert.ToString(arr[i], System.Globalization.CultureInfo.InvariantCulture);
                    if (!string.IsNullOrEmpty(s) && s.Trim().Length > 0)
                    {
                        var only = new PokeCoverSpec();
                        only.Garment = s.Trim();
                        only.Confidence = "low";
                        to.Add(only);
                    }
                    continue;
                }
                string g = AuditJson.Str(e, "garment", null);
                if (string.IsNullOrEmpty(g)) g = AuditJson.Str(e, "mesh", null);
                if (string.IsNullOrEmpty(g)) g = AuditJson.Str(e, "object", null);
                if (string.IsNullOrEmpty(g)) continue;
                var spec = new PokeCoverSpec();
                spec.Garment = g.Trim();
                spec.Confidence = AuditJson.Str(e, "confidence", null);
                List<object> rs = AuditJson.Arr(e, "covers");
                if (rs == null || rs.Count == 0) rs = AuditJson.Arr(e, "regions");
                if (rs == null || rs.Count == 0)
                {
                    string one = AuditJson.Str(e, "region", null);
                    if (!string.IsNullOrEmpty(one)) { spec.Regions.Add(one.Trim()); }
                }
                else
                {
                    for (int k = 0; k < rs.Count; k++)
                    {
                        string s = rs[k] as string;
                        if (s == null) s = Convert.ToString(rs[k], System.Globalization.CultureInfo.InvariantCulture);
                        if (!string.IsNullOrEmpty(s)) spec.Regions.Add(s.Trim());
                    }
                }
                to.Add(spec);
            }
        }

        /// <summary>
        /// 从 decl.json 读 parts[] 的 covers。schema 尚未定稿（T-01/T-02 未完），所以容错解析：
        /// 每个 part 找 garment/mesh 或 objects[]（字符串或 {path,renderer} 对象，**每个 object 各生成一条配对**）
        /// 与 covers/regions（字符串或数组）。
        /// 任务 CI 修复：旧代码只取 objects[0] as string，而现行 decl 的 objects 是对象 → 恒为 null →
        /// 带 poke.decl 的请求全部退回关键词配对（F13 只配上 loafer 的 bug）。
        /// </summary>
        private static void PokeReadDeclCovers(AuditContext ctx, PokeParams p)
        {
            if (!System.IO.File.Exists(p.DeclPath))
            {
                ctx.Warn("poke: decl 文件不存在（" + p.DeclPath + "），配对退回关键词。");
                return;
            }
            string note;
            List<PokeCoverSpec> specs;
            try { specs = PokeParseDeclCovers(System.IO.File.ReadAllText(p.DeclPath), out note); }
            catch (Exception e) { ctx.Warn("poke: 解析 decl 失败（" + e.Message + "），配对退回关键词。"); return; }
            if (note != null) { ctx.Warn("poke: " + note + "，配对退回关键词。"); return; }
            if (specs.Count == 0)
            {
                ctx.Warn("poke: decl 里没有任何带 covers 的 parts[].objects，配对退回关键词。");
                return;
            }
            p.Covers.AddRange(specs);
        }

        /// <summary>
        /// 任务 CI：纯解析（不碰 Unity），供 PokeReadDeclCovers 与离线 selftest 共用。
        /// 返回每个带 covers/regions 的 part 的**每个 object** 一条 PokeCoverSpec；note 非空表示整体失败
        /// （顶层不是对象 / 没有 parts[]），调用方退回关键词配对。
        /// </summary>
        internal static List<PokeCoverSpec> PokeParseDeclCovers(string json, out string note)
        {
            note = null;
            var specs = new List<PokeCoverSpec>();
            object parsed;
            try { parsed = AuditJson.Parse(json); }
            catch (Exception e) { note = "解析 decl 失败（" + e.Message + "）"; return specs; }
            var root = parsed as JsonObject;
            if (root == null) { note = "decl 顶层不是对象"; return specs; }
            List<object> parts = AuditJson.Arr(root, "parts");
            if (parts.Count == 0) { note = "decl 没有 parts[]"; return specs; }
            for (int i = 0; i < parts.Count; i++)
            {
                var part = parts[i] as JsonObject;
                if (part == null) continue;
                List<object> rs = AuditJson.Arr(part, "covers");
                if (rs == null || rs.Count == 0) rs = AuditJson.Arr(part, "regions");
                var regions = new List<string>();
                if (rs != null)
                {
                    for (int k = 0; k < rs.Count; k++)
                    {
                        string s = rs[k] as string;
                        if (s == null && rs[k] != null)
                            s = Convert.ToString(rs[k], System.Globalization.CultureInfo.InvariantCulture);
                        if (!string.IsNullOrEmpty(s)) regions.Add(s.Trim());
                    }
                }
                if (regions.Count == 0)
                {
                    string one = AuditJson.Str(part, "region", null);
                    if (!string.IsNullOrEmpty(one)) regions.Add(one.Trim());
                }
                if (regions.Count == 0) continue;   // 没声明部位的 part 不生成 poke 配对

                // 件名：part 级 garment/mesh 优先；否则 objects[] 里每个 object 各生成一条。
                string partGarment = AuditJson.Str(part, "garment", null);
                if (string.IsNullOrEmpty(partGarment)) partGarment = AuditJson.Str(part, "mesh", null);
                if (string.IsNullOrEmpty(partGarment)) partGarment = AuditJson.Str(part, "object", null);
                var names = new List<string>();
                if (!string.IsNullOrEmpty(partGarment)) names.Add(partGarment.Trim());
                else
                {
                    List<object> objs = AuditJson.Arr(part, "objects");
                    if (objs != null)
                    {
                        for (int k = 0; k < objs.Count; k++)
                        {
                            string nm = PokeDeclObjectName(objs[k]);
                            if (!string.IsNullOrEmpty(nm) && !names.Contains(nm)) names.Add(nm);
                        }
                    }
                }
                for (int k = 0; k < names.Count; k++)
                {
                    var spec = new PokeCoverSpec();
                    spec.Garment = names[k];
                    spec.Confidence = AuditJson.Str(part, "confidence", null);
                    spec.Regions.AddRange(regions);
                    specs.Add(spec);
                }
            }
            return specs;
        }

        /// <summary>decl.json parts[].objects[] 一条：字符串直接当件名；{path,renderer} 对象取 path
        /// （兼容 garment/mesh/object/name 字段）。</summary>
        internal static string PokeDeclObjectName(object ob)
        {
            if (ob == null) return null;
            string s = ob as string;
            if (!string.IsNullOrEmpty(s)) return s.Trim();
            var oo = ob as JsonObject;
            if (oo == null)
            {
                string c = Convert.ToString(ob, System.Globalization.CultureInfo.InvariantCulture);
                return string.IsNullOrEmpty(c) ? null : c.Trim();
            }
            string p = AuditJson.Str(oo, "path", null);
            if (string.IsNullOrEmpty(p)) p = AuditJson.Str(oo, "garment", null);
            if (string.IsNullOrEmpty(p)) p = AuditJson.Str(oo, "mesh", null);
            if (string.IsNullOrEmpty(p)) p = AuditJson.Str(oo, "object", null);
            if (string.IsNullOrEmpty(p)) p = AuditJson.Str(oo, "name", null);
            return string.IsNullOrEmpty(p) ? null : p.Trim();
        }

        private sealed class PokePairSpec
        {
            public PokeCoverSpec Cover;
            public PokeGarment G;
            public List<string> Regions = new List<string>();
            public string PairSource = "decl_covers";
            public string PairConfidence = "high";
            public string PairReason;
            public bool BboxOverlap = true;
        }

        // ── 主计算 ─────────────────────────────────────────────────────

        private static PokeResult PokeCompute(AuditContext ctx, GameObject avatar, Animator anim)
        {
            var outRes = new PokeResult();
            var o = new JsonObject();
            outRes.Json = o;
            outRes.Hits = 0;

            var p = PokeReadParams(ctx);
            o.Set("method", "T-28a 静态穿出斑块：只对本根衣物发射线定外壳三角形（外向以远离覆盖区锚骨线段为准，"
                + "网格法线相反者计 normals_flipped）；被覆盖身体顶点到最近外壳特征（面/边/顶点）取有向深度 d_v，"
                + "符号用角度加权伪法线；边界边记 opening、d>" + AuditUtil.F(p.OpeningDeepFactor)
                + "τ 记 opening_deep；d_v>τ 的连通分量成斑块。穿越计数/包含率只作参考列（containment 探针）。");
            var th = new JsonObject();
            th.Set("tau_torso_mm", (double)p.TauTorsoMm);
            th.Set("tau_limb_mm", (double)p.TauLimbMm);
            th.Set("min_patch_area_cm2", p.MinAreaExplicit ? (object)(double)p.MinAreaCm2
                : (p.MinPatchRule == "legacy" ? (object)0.5 : (object)null));
            th.Set("min_patch_area_source", p.MinAreaExplicit ? "request" : (p.MinPatchRule == "legacy" ? "legacy" : "adaptive"));
            th.Set("min_patch_rule", p.MinPatchRule);
            th.Set("min_verts_for_patch", p.MinVertsForPatch);
            th.Set("absolute_floor_cm2", (double)p.AbsoluteFloorCm2);
            th.Set("shell_ray_m", (double)p.ShellRayM);
            th.Set("cone_deg", (double)p.ConeDeg);
            th.Set("origin_mm", (double)(p.OriginM * 1000f));
            th.Set("opening_deep_factor", (double)p.OpeningDeepFactor);
            o.Set("thresholds", th);
            o.Set("pair_rule", "只来自声明 covers（请求 poke_covers 或 poke.decl 指向的 decl.json parts[].covers）；"
                + "无声明时退回渲染器 GameObject 名关键词（鞋/靴/手套）并标 pair_confidence=low。"
                + "被测件与部位包围盒在任一轴上不重叠即拒绝配对（PixelBoot 83×6 假命中的教训）。");
            o.Set("shell_rule", "只对活跃头像根下的衣物建临时 MeshCollider（身体与其它根不建），层 "
                + p.Layer + "；三角形质心沿锚骨外向 +" + AuditUtil.F(p.OriginM * 1000f)
                + " mm 起发 5 条射线（外向与 ±" + AuditUtil.F(p.ConeDeg) + "° 锥），外壳判定规则="
                + p.ShellRule + "（any=任一条逃逸；outward=只有外向射线逃逸；majority=≥" + p.ShellMajorityMin
                + " 条逃逸），射线长度 " + AuditUtil.F(p.ShellRayM)
                + " m；伪法线符号=" + p.NormalSign + "（anchor=锚骨外向翻正 / winding=网格绕序 / parity=奇偶投票）。"
                + "诊断 shell_rescued_by_cone 统计「外向被挡、靠锥向救回」的外壳面数（poke.diag 或默认都记）。");
            o.Set("depth_rule", "最近外壳特征分类为面/边/顶点；符号 = dot(v-p, n_pseudo)，n_pseudo 为角度加权伪法线；"
                + "最近特征是边界边（只被 1 个三角面引用）记 opening，不算穿出。");
            o.Set("patch_rule", "身体网格邻接图上 d_v>τ 的连通分量；面积 = 该分量内身体三角形的面积和（cm²）；"
                + "τ 按部位：躯干 " + AuditUtil.F(p.TauTorsoMm) + " mm / 其它 " + AuditUtil.F(p.TauLimbMm) + " mm。"
                + "面积门槛（任务 CW）：默认 adaptive = max(absolute_floor " + AuditUtil.F(p.AbsoluteFloorCm2)
                + " cm², min_verts_for_patch " + p.MinVertsForPatch + " × 该配对被测区每顶点面积份额 area_per_vert_cm2)，"
                + "口径与 shrink_cover 的「三角形面积按顶点均分」一致；min_patch_rule=legacy 仍用固定 0.5，"
                + "请求 min_patch_area_cm2/min_patch_cm2 显式覆盖（min_patch_area_source 标明）。"
                + "被门槛丢掉的分量永远输出 dropped_components/dropped_max_area_cm2/dropped_total_area_cm2/dropped_max_depth_mm；"
                + "某 sub_part 有顶点超阈值却没凑成斑块时该行标 suspect_subthreshold=true 并给中文原因。");
            o.Set("reference_rule", "穿越计数与包含率不参与判定；poke.reference=true 时内嵌同一配对上的 containment 参考数。");
            o.Set("dose_rule", p.Doses.Count > 0
                ? "perturb 剂量分档 " + PokeDoseList(p.Doses) + "：逐档施加形态键后重算斑块总面积，输出单调性。"
                : "未请求剂量分档（poke_doses / perturb.doses）。");
            o.Set("diag_rule", p.Diag
                ? "poke.diag=true：每个斑块输出 ≤20 个样本顶点（等距抽样）的世界坐标、d_v、最近外壳特征"
                  + "（面/边/顶点）、garment、三角形序号、判该三角形为外壳的射线（外向/锥向第 k 条）与终点、"
                  + "绕序法线·计算外向、以及该面是否靠锥向救回；每对另报 shell_outward_escaped / shell_rescued_by_cone。"
                : "未请求诊断（请求加 poke.diag:true / poke_diag:true 打开）。");

            if (ctx == null || avatar == null)
            {
                o.Set("hits", 0);
                o.Set("error", "poke: ctx/avatar 为空。");
                return outRes;
            }

            var all = AllSmrs(avatar);
            var visible = new List<SkinnedMeshRenderer>();
            for (int i = 0; i < all.Count; i++)
                if (all[i].gameObject.activeInHierarchy && all[i].enabled) visible.Add(all[i]);

            string bodySource;
            string bodyPath = PickBodyPath(ctx, anim, avatar.transform, all, visible, out bodySource);
            o.Set("body", bodyPath);
            o.Set("body_source", bodySource);
            if (bodyPath == null)
            {
                o.Set("pairs", new List<object>());
                o.Set("hits", 0);
                o.Set("error", "poke: 找不到身体网格。");
                return outRes;
            }
            var bodySmr = FindSmr(all, avatar.transform, bodyPath);
            if (bodySmr == null)
            {
                o.Set("pairs", new List<object>());
                o.Set("hits", 0);
                o.Set("error", "poke: 身体网格 '" + bodyPath + "' 取不到。");
                return outRes;
            }
            var boneMap = BuildBoneRegionMap(anim);

            Regex includeRe = null, excludeRe = null;
            try
            {
                if (!string.IsNullOrEmpty(p.IncludeRegex)) includeRe = new Regex(p.IncludeRegex, RegexOptions.CultureInvariant);
                if (!string.IsNullOrEmpty(p.ExcludeRegex)) excludeRe = new Regex(p.ExcludeRegex, RegexOptions.CultureInvariant);
            }
            catch (Exception e) { ctx.Warn("poke: include/exclude 正则非法（" + e.Message + "），已忽略。"); }

            // hide 自检：先隐藏目标渲染器，再收集衣物。
            Renderer hiddenR = null;
            bool hiddenOld = true;
            JsonObject hideJson = null;
            if (!string.IsNullOrEmpty(p.Hide))
            {
                var t = PokeFindTransform(avatar.transform, p.Hide);
                hiddenR = t != null ? t.GetComponent<Renderer>() : null;
                if (hiddenR != null)
                {
                    hiddenOld = hiddenR.enabled;
                    hiddenR.enabled = false;
                }
                else ctx.Warn("poke: hide 目标 '" + p.Hide + "' 找不到 Renderer，hide 自检未生效。");
            }

            var garm = PokeCollectGarments(ctx, avatar, p, bodySmr, includeRe, excludeRe);
            o.Set("garment_candidates", PokeGarmentList(garm));

            // 参考列：同一配对上的 containment（可选，跑一次基准）。
            JsonObject refPairs = null;
            if (p.Reference)
            {
                try
                {
                    ProbeOut cref = Containment(ctx, avatar, anim);
                    refPairs = cref.Json;
                }
                catch (Exception e) { ctx.Warn("poke: 参考 containment 失败：" + e.Message); }
            }

            bool savedBackfaces = Physics.queriesHitBackfaces;
            long raysUsed = 0;
            bool budgetHit = false;
            int layer = p.Layer;
            List<PokePairSpec> pairSpecs = null;
            PokeRun baseRun = null;
            var doseRuns = new List<PokeRun>();

            try
            {
                Physics.queriesHitBackfaces = true;
                WarnIfLayerOccupied(ctx, avatar, layer);
                int mask = 1 << layer;

                if (p.Doses.Count > 0 && (string.IsNullOrEmpty(p.PerturbRenderer) || string.IsNullOrEmpty(p.PerturbShape)))
                    ctx.Warn("poke: 请求了剂量分档但没有可施加的 perturb（renderer/blendshape），各档结果会相同。");

                for (int di = 0; di < (p.Doses.Count > 0 ? p.Doses.Count : 1); di++)
                {
                    string label = p.Doses.Count > 0 ? "dose=" + AuditUtil.F(p.Doses[di]) : null;
                    // 施加剂量
                    float oldW = 0f; bool havePerturb = false;
                    if (p.Doses.Count > 0 && !string.IsNullOrEmpty(p.PerturbRenderer) && !string.IsNullOrEmpty(p.PerturbShape))
                    {
                        SkinnedMeshRenderer ps = PokeFindSmr(avatar, p.PerturbRenderer);
                        if (ps == null || ps.sharedMesh == null)
                            throw new Exception("poke: perturb 渲染器 '" + p.PerturbRenderer + "' 取不到或没有网格");
                        int idx = ps.sharedMesh.GetBlendShapeIndex(p.PerturbShape);
                        if (idx < 0) throw new Exception("poke: perturb 形态键 '" + p.PerturbShape + "' 不存在");
                        oldW = ps.GetBlendShapeWeight(idx);
                        ps.SetBlendShapeWeight(idx, p.Doses[di]);
                        havePerturb = true;
                    }

                    PokeRun run;
                    try
                    {
                        run = PokeRunOnce(ctx, p, avatar, anim, bodySmr, boneMap, garm,
                            pairSpecs, label, mask, ref raysUsed, ref budgetHit, ref pairSpecs, refPairs);
                    }
                    finally
                    {
                        if (havePerturb)
                        {
                            SkinnedMeshRenderer ps2 = PokeFindSmr(avatar, p.PerturbRenderer);
                            if (ps2 != null && ps2.sharedMesh != null)
                            {
                                int idx2 = ps2.sharedMesh.GetBlendShapeIndex(p.PerturbShape);
                                if (idx2 >= 0) ps2.SetBlendShapeWeight(idx2, oldW);
                            }
                        }
                    }
                    if (baseRun == null) baseRun = run;
                    doseRuns.Add(run);
                    if (ctx.Status != null)
                        ctx.Status.Running("poke", (di + 1) + "/" + (p.Doses.Count > 0 ? p.Doses.Count : 1)
                            + (label != null ? " " + label : ""));
                }
            }
            finally
            {
                Physics.queriesHitBackfaces = savedBackfaces;
                if (hiddenR != null) hiddenR.enabled = hiddenOld;
            }

            if (budgetHit) ctx.Warn("poke 射线预算 " + p.RayBudget + " 用尽，部分判定不完整（truncated=true）。");
            o.Set("rays_used", raysUsed);
            o.Set("truncated", budgetHit);

            // 输出基准 run
            if (baseRun != null)
            {
                o.Set("body_excluded", baseRun.BodyExcluded);
                o.Set("body_baked_vertices", baseRun.BodyBakedVertices);
                o.Set("body_shared_vertices", baseRun.BodySharedVertices);
                o.Set("body_region_source", baseRun.BodyRegionSource);
                var pairOut = new List<object>();
                int hits = 0;
                for (int i = 0; i < baseRun.Pairs.Count; i++)
                {
                    pairOut.Add(PokePairJson(baseRun.Pairs[i], p));
                    hits += baseRun.Pairs[i].Patches.Count;
                }
                o.Set("pairs", pairOut);
                o.Set("hits", hits);
                outRes.Hits = hits;
                o.Set("patch_count", baseRun.PatchCount);
                o.Set("total_patch_area_cm2", (double)baseRun.TotalAreaCm2);
                // 任务 CW：无论阈值怎么定，被丢掉的分量都要暴露，别让 0 斑块看起来像「没穿出」。
                o.Set("dropped_components", baseRun.DroppedComponents);
                o.Set("dropped_max_area_cm2", (double)baseRun.DroppedMaxAreaCm2);
                o.Set("dropped_total_area_cm2", (double)baseRun.DroppedTotalAreaCm2);
                o.Set("dropped_max_depth_mm", (double)baseRun.DroppedMaxDepthMm);
                o.Set("area_per_vert_cm2", baseRun.MinAreaPerVertCm2 > 0f ? (object)(double)baseRun.MinAreaPerVertCm2 : null);
                o.Set("area_per_vert_pos_source", baseRun.MinAreaPerVertPosSource);
                o.Set("min_patch_area_cm2", baseRun.MinPatchAreaCm2 > 0f ? (object)(double)baseRun.MinPatchAreaCm2 : null);
                o.Set("suspect_subthreshold", baseRun.SuspectSubthreshold);
                o.Set("opening_verts", baseRun.OpeningVerts);
                o.Set("opening_deep_verts", baseRun.OpeningDeepVerts);
                o.Set("shell_faces_total", baseRun.ShellFaces);
                o.Set("normals_flipped_total", baseRun.FlippedFaces);
            }
            else
            {
                o.Set("pairs", new List<object>());
                o.Set("hits", 0);
            }

            // 剂量-响应与单调性
            if (p.Doses.Count > 0 && doseRuns.Count > 0)
            {
                var dr = new List<object>();
                for (int i = 0; i < doseRuns.Count; i++)
                {
                    var e = new JsonObject();
                    e.Set("dose", (double)p.Doses[i]);
                    e.Set("total_patch_area_cm2", (double)doseRuns[i].TotalAreaCm2);
                    e.Set("patch_count", doseRuns[i].PatchCount);
                    e.Set("opening_verts", doseRuns[i].OpeningVerts);
                    e.Set("opening_deep_verts", doseRuns[i].OpeningDeepVerts);
                    dr.Add(e);
                }
                o.Set("dose_response", dr);
                bool mono = PokeMonotone(p.Doses, doseRuns);
                o.Set("monotone_nondecreasing", mono);
                o.Set("monotonicity", mono ? "nondecreasing" : "not_monotone");
            }

            // hide 自检
            if (p.HideSelfCheck && !string.IsNullOrEmpty(p.Hide))
            {
                hideJson = new JsonObject();
                hideJson.Set("path", p.Hide);
                hideJson.Set("found", hiddenR != null);
                bool paired = false;
                if (baseRun != null)
                    for (int i = 0; i < baseRun.Pairs.Count; i++)
                    {
                        PokePairResult pr2 = baseRun.Pairs[i];
                        if (pr2.G != null && (pr2.G.Path == p.Hide || pr2.G.Name == p.Hide)) paired = true;
                    }
                hideJson.Set("garment_paired_after_hide", paired);
                float hiddenArea = 0f;
                if (baseRun != null)
                    for (int i = 0; i < baseRun.Pairs.Count; i++)
                        hiddenArea += baseRun.Pairs[i].Patches.Count > 0 ? PokePairHiddenArea(baseRun.Pairs[i], p.Hide) : 0f;
                hideJson.Set("hidden_garment_patch_area_cm2", (double)hiddenArea);
                hideJson.Set("total_patch_area_cm2", baseRun != null ? (double)baseRun.TotalAreaCm2 : 0.0);
                hideJson.Set("ok", hiddenR != null && !paired && hiddenArea <= 0f);
                hideJson.Set("note", "hide 生效后该件不应再进入配对；ok=true 表示隐藏件无斑块。若 hide 的是唯一覆盖件，"
                    + "总斑块面积也应为 0（total_patch_area_cm2 由调用方判）。");
                o.Set("hide_selfcheck", hideJson);
            }

            return outRes;
        }

        private static float PokePairHiddenArea(PokePairResult pr, string hide)
        {
            if (pr.G == null) return 0f;
            if (pr.G.Path != hide && pr.G.Name != hide) return 0f;
            return pr.TotalAreaCm2ForOutput();
        }

        private static bool PokeMonotone(List<float> doses, List<PokeRun> runs)
        {
            // 按剂量升序检查总面积不下降
            var idx = new List<int>();
            for (int i = 0; i < doses.Count; i++) idx.Add(i);
            idx.Sort((a, b) => doses[a].CompareTo(doses[b]));
            float prev = float.NegativeInfinity;
            for (int k = 0; k < idx.Count; k++)
            {
                float a = runs[idx[k]].TotalAreaCm2;
                if (a + 1e-6f < prev) return false;
                prev = a;
            }
            return true;
        }

        private static string PokeDoseList(List<float> doses)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < doses.Count; i++)
            {
                if (i > 0) sb.Append('/');
                sb.Append(AuditUtil.F(doses[i]));
            }
            return sb.ToString();
        }

        private static Transform PokeFindTransform(Transform root, string spec)
        {
            if (string.IsNullOrEmpty(spec)) return null;
            string leaf = spec;
            int slash = spec.LastIndexOf('/');
            if (slash >= 0 && slash + 1 < spec.Length) leaf = spec.Substring(slash + 1);
            var all = root.GetComponentsInChildren<Transform>(true);
            for (int i = 0; i < all.Length; i++)
                if (AuditUtil.RelPath(root, all[i]) == spec) return all[i];
            for (int i = 0; i < all.Length; i++)
                if (all[i].name == spec || all[i].name == leaf) return all[i];
            return null;
        }

        private static SkinnedMeshRenderer PokeFindSmr(GameObject avatar, string spec)
        {
            var t = PokeFindTransform(avatar.transform, spec);
            return t != null ? t.GetComponent<SkinnedMeshRenderer>() : null;
        }

        // ── 衣物收集 ────────────────────────────────────────────────────

        private static List<PokeGarment> PokeCollectGarments(AuditContext ctx, GameObject avatar, PokeParams p,
            SkinnedMeshRenderer bodySmr, Regex includeRe, Regex excludeRe)
        {
            var list = new List<PokeGarment>();
            Renderer[] rs = avatar.GetComponentsInChildren<Renderer>(true);
            for (int i = 0; i < rs.Length; i++)
            {
                Renderer r = rs[i];
                if (r == null || r == bodySmr) continue;
                if (!(r is SkinnedMeshRenderer) && !(r is MeshRenderer)) continue;
                if (!r.gameObject.activeInHierarchy || !r.enabled) continue;
                if (excludeRe != null && excludeRe.IsMatch(r.gameObject.name)) continue;
                if (includeRe != null && !includeRe.IsMatch(r.gameObject.name)) continue;
                Mesh gm = MeshWorldOf(r, ctx);
                if (gm == null || gm.vertexCount == 0) { if (gm != null) Object.DestroyImmediate(gm); continue; }
                var g = new PokeGarment();
                g.R = r;
                g.Path = AuditUtil.RelPath(avatar.transform, r.transform);
                g.Name = r.gameObject.name;
                g.Pos = gm.vertices;
                g.Tris = gm.triangles;
                Object.DestroyImmediate(gm);
                g.VertexCount = g.Pos.Length;
                g.TriCount = g.Tris.Length / 3;
                g.EdgeCount = new Dictionary<long, int>(g.TriCount * 3);
                g.EdgeNormal = new Dictionary<long, Vector3>(g.TriCount * 3);
                list.Add(g);
            }
            list.Sort((a, b) => string.CompareOrdinal(a.Path, b.Path));
            return list;
        }

        private static List<object> PokeGarmentList(List<PokeGarment> garm)
        {
            var l = new List<object>();
            for (int i = 0; i < garm.Count; i++)
            {
                var e = new JsonObject();
                e.Set("garment", garm[i].Path);
                e.Set("name", garm[i].Name);
                e.Set("vertices", garm[i].VertexCount);
                e.Set("triangles", garm[i].TriCount);
                l.Add(e);
            }
            return l;
        }

        /// <summary>每个剂量/每帧重烘衣物世界网格（形态键会改形状）；失败则把该件置为空网格。</summary>
        private static void PokeRefreshGarments(AuditContext ctx, List<PokeGarment> garm)
        {
            for (int i = 0; i < garm.Count; i++)
            {
                PokeGarment g = garm[i];
                if (g.R == null || !g.R.gameObject.activeInHierarchy || !g.R.enabled)
                {
                    g.Pos = new Vector3[0]; g.Tris = new int[0]; g.VertexCount = 0; g.TriCount = 0;
                    continue;
                }
                Mesh gm = MeshWorldOf(g.R, ctx);
                if (gm == null || gm.vertexCount == 0)
                {
                    if (gm != null) Object.DestroyImmediate(gm);
                    g.Pos = new Vector3[0]; g.Tris = new int[0]; g.VertexCount = 0; g.TriCount = 0;
                    continue;
                }
                g.Pos = gm.vertices;
                g.Tris = gm.triangles;
                Object.DestroyImmediate(gm);
                g.VertexCount = g.Pos.Length;
                g.TriCount = g.Tris.Length / 3;
            }
        }

        /// <summary>建临时 MeshCollider（全部候选衣物一次性建好，外壳测试用统一 mask）。</summary>
        private static void PokeBuildColliders(List<PokeGarment> garm, int layer)
        {
            for (int i = 0; i < garm.Count; i++)
            {
                PokeGarment g = garm[i];
                if (g.TriCount <= 0) continue;
                var go = new GameObject("__AuditProbe_poke_" + AuditUtil.SafeFileName(g.Path));
                if (go.name.Length > 120) go.name = go.name.Substring(go.name.Length - 120);
                go.hideFlags = HideFlags.HideAndDontSave;
                go.layer = layer;
                go.transform.position = Vector3.zero;
                go.transform.rotation = Quaternion.identity;
                go.transform.localScale = Vector3.one;
                Mesh cm = new Mesh();
                cm.indexFormat = IndexFormat.UInt32;
                cm.hideFlags = HideFlags.HideAndDontSave;
                cm.vertices = g.Pos;
                cm.triangles = g.Tris;
                cm.RecalculateBounds();
                var mc = go.AddComponent<MeshCollider>();
                mc.sharedMesh = cm;
                mc.convex = false;
                mc.enabled = true;
                g.Go = go;
                g.Collider = mc;
                g.ColMesh = cm;
            }
            Physics.SyncTransforms();
        }

        private static void PokeDestroyColliders(List<PokeGarment> garm)
        {
            for (int i = 0; i < garm.Count; i++)
            {
                PokeGarment g = garm[i];
                if (g.Go != null) { Object.DestroyImmediate(g.Go); g.Go = null; g.Collider = null; }
                if (g.ColMesh != null) { Object.DestroyImmediate(g.ColMesh); g.ColMesh = null; }
            }
        }

        // ── 单次 run（一个剂量）─────────────────────────────────────────

        private static PokeRun PokeRunOnce(AuditContext ctx, PokeParams p, GameObject avatar, Animator anim,
            SkinnedMeshRenderer bodySmr, Dictionary<Transform, string> boneMap, List<PokeGarment> garm,
            List<PokePairSpec> existingSpecs, string doseLabel, int mask,
            ref long raysUsed, ref bool budgetHit, ref List<PokePairSpec> pairSpecs, JsonObject refPairs)
        {
            var run = new PokeRun();
            run.DoseLabel = doseLabel;

            BodyMeshInfo bi;
            try { bi = BuildBodyInfo(bodySmr, avatar.transform, anim, boneMap, ctx); }
            catch (Exception e)
            {
                ctx.Warn("poke: 烘焙身体网格失败：" + e.Message);
                return run;
            }
            run.BodyBakedVertices = bi.BakedCount;
            run.BodySharedVertices = bi.SharedCount;
            run.BodyRegionSource = bi.RegionSource;
            run.BodyExcluded = PokeBodyExcluded(bi);

            // 配对（首帧解析一次，后续剂量复用；部位集合与身体网格权重无关，只与 sharedMesh 有关）
            if (existingSpecs == null)
            {
                pairSpecs = PokeBuildPairs(ctx, p, avatar, garm, bi, boneMap, anim);
            }
            else pairSpecs = existingSpecs;

            // 建碰撞体并分类外壳（每帧重建：形态键会改形状）
            try
            {
                PokeRefreshGarments(ctx, garm);
                PokeBuildColliders(garm, p.Layer);
                for (int i = 0; i < pairSpecs.Count; i++)
                {
                    PokePairSpec ps = pairSpecs[i];
                    if (ps.G == null || !ps.BboxOverlap) continue;
                    PokeClassifyShell(ctx, p, ps, anim, mask, ref raysUsed, ref budgetHit);
                }
                // 逐配对算深度/斑块
                for (int i = 0; i < pairSpecs.Count; i++)
                {
                    PokePairSpec ps = pairSpecs[i];
                    var pr = new PokePairResult();
                    pr.Spec = ps.Cover;
                    pr.G = ps.G;
                    pr.PairSource = ps.PairSource;
                    pr.PairConfidence = ps.PairConfidence;
                    pr.PairReason = ps.PairReason;
                    pr.BboxOverlap = ps.BboxOverlap;
                    pr.Regions = ps.Regions;
                    if (ps.G != null)
                    {
                        pr.MeshVertices = ps.G.VertexCount;
                        pr.MeshTriangles = ps.G.TriCount;
                        pr.ShellFaces = ps.G.ShellCount;
                        pr.FlippedFaces = CountFlipped(ps.G);
                        pr.ShellOutwardEscaped = ps.G.ShellOutwardEscaped;
                        pr.ShellConeRescued = ps.G.ShellConeRescued;
                        run.ShellFaces += ps.G.ShellCount;
                        run.FlippedFaces += pr.FlippedFaces;
                    }
                    if (ps.G != null && ps.BboxOverlap && ps.G.Bvh != null && ps.G.Bvh.FaceCount > 0)
                    {
                        // 任务 CF（R9 v2）：先按脚部 covers 包围盒 + 外底参考选出鞋垫面，再算 si/tilt。
                        if (p.InsoleEnabled) PokeBuildInsole(p, ps, bi);
                        PokeDepthsAndPatches(ctx, p, ps, pr, bi, boneMap, anim, mask, ref raysUsed, ref budgetHit);
                    }
                    PokeFillReference(pr, refPairs);
                    run.Pairs.Add(pr);
                    run.TotalAreaCm2 += pr.TotalAreaCm2ForOutput();
                    run.PatchCount += pr.Patches.Count;
                    run.OpeningVerts += pr.OpeningVerts;
                    // 任务 CW：run 级汇总被门槛丢掉的分量与本次用到的阈值/密度。
                    run.DroppedComponents += pr.DroppedComponents;
                    run.DroppedTotalAreaCm2 += pr.DroppedTotalAreaCm2;
                    if (pr.DroppedMaxAreaCm2 > run.DroppedMaxAreaCm2) run.DroppedMaxAreaCm2 = pr.DroppedMaxAreaCm2;
                    if (pr.DroppedMaxDepthMm > run.DroppedMaxDepthMm) run.DroppedMaxDepthMm = pr.DroppedMaxDepthMm;
                    if (pr.AreaPerVertCm2 > 0f && (run.MinAreaPerVertCm2 <= 0f || pr.AreaPerVertCm2 < run.MinAreaPerVertCm2))
                    {
                        run.MinAreaPerVertCm2 = pr.AreaPerVertCm2;
                        run.MinAreaPerVertPosSource = pr.AreaPerVertPosSource;
                    }
                    if (pr.MinPatchAreaCm2 > 0f && (run.MinPatchAreaCm2 <= 0f || pr.MinPatchAreaCm2 < run.MinPatchAreaCm2))
                        run.MinPatchAreaCm2 = pr.MinPatchAreaCm2;
                    if (pr.SuspectSubthreshold) run.SuspectSubthreshold = true;
                    run.OpeningDeepVerts += pr.OpeningDeepVerts;
                }
            }
            finally
            {
                PokeDestroyColliders(garm);
                for (int i = 0; i < garm.Count; i++)
                {
                    garm[i].IsShell = null;
                    garm[i].Flipped = null;
                    garm[i].OrientedNrm = null;
                    garm[i].FaceNrm = null;
                    garm[i].EdgeCount = new Dictionary<long, int>();
                    garm[i].EdgeNormal = new Dictionary<long, Vector3>();
                    garm[i].VertexPseudo = null;
                    garm[i].Bvh = null;
                    garm[i].InsoleBvh = null;
                    garm[i].InsoleCentroids = null;
                    garm[i].InsoleFaces = 0;
                    // 任务 CI：诊断数组只在本次 run 内有意义，用完清掉。
                    garm[i].ShellRay = null;
                    garm[i].ShellRayEnd = null;
                    garm[i].OutwardDot = null;
                    garm[i].ShellOutwardEscaped = 0;
                    garm[i].ShellConeRescued = 0;
                }
            }
            run.Truncated = budgetHit;
            run.RaysUsed = raysUsed;
            return run;
        }

        private static int CountFlipped(PokeGarment g)
        {
            if (g.Flipped == null) return 0;
            int c = 0;
            for (int i = 0; i < g.Flipped.Length; i++) if (g.Flipped[i]) c++;
            return c;
        }

        private static JsonObject PokeBodyExcluded(BodyMeshInfo bi)
        {
            int exNan = 0, exNani = 0, exZero = 0, exFar = 0;
            for (int i = 0; i < bi.Pos.Length; i++)
            {
                switch (bi.Exclude[i])
                {
                    case ExNonFinite: exNan++; break;
                    case ExNanimated: exNani++; break;
                    case ExZeroWeight: exZero++; break;
                    case ExBeyond3m: exFar++; break;
                }
            }
            var be = new JsonObject();
            be.Set("nan", exNan);
            be.Set("deleted", exNani + exZero);
            be.Set("deleted_nanimated", exNani);
            be.Set("deleted_zero_weight", exZero);
            be.Set("beyond_3m", exFar);
            be.Set("total", exNan + exNani + exZero + exFar);
            return be;
        }

        // ── 配对 ────────────────────────────────────────────────────────

        private static List<PokePairSpec> PokeBuildPairs(AuditContext ctx, PokeParams p, GameObject avatar,
            List<PokeGarment> garm, BodyMeshInfo bi, Dictionary<Transform, string> boneMap, Animator anim)
        {
            var specs = new List<PokePairSpec>();
            var bodyRegions = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < bi.Region.Length; i++) if (bi.Region[i] != null) bodyRegions.Add(bi.Region[i]);

            // 1) 声明 covers
            for (int i = 0; i < p.Covers.Count; i++)
            {
                PokeCoverSpec cov = p.Covers[i];
                PokeGarment g = PokeMatchGarment(garm, cov.Garment);
                if (g == null)
                {
                    ctx.Warn("poke: 声明 covers 的件 '" + cov.Garment + "' 在可见衣物里找不到，已跳过。");
                    continue;
                }
                var ps = new PokePairSpec();
                ps.Cover = cov;
                ps.G = g;
                ps.PairSource = "decl_covers";
                ps.PairConfidence = string.IsNullOrEmpty(cov.Confidence) ? "high" : cov.Confidence;
                for (int k = 0; k < cov.Regions.Count; k++)
                {
                    string r = cov.Regions[k];
                    if (r == "foot" || r == "hand")
                    {
                        foreach (string br in bodyRegions)
                            if (RegionMatches(br, r) && !ps.Regions.Contains(br)) ps.Regions.Add(br);
                    }
                    else if (bodyRegions.Contains(r))
                    {
                        if (!ps.Regions.Contains(r)) ps.Regions.Add(r);
                    }
                    else ctx.Warn("poke: 声明里 '" + cov.Garment + "' 的 covers 部位 '" + r + "' 不在身体部位里（可用例："
                        + PokeRegionSample(bodyRegions) + "）。");
                }
                if (ps.Regions.Count == 0)
                {
                    // 声明只写了件、没写部位（或部位名都不认识）：按件名关键词推断部位并标 low。
                    string tok2;
                    string filter2 = null;
                    if (MatchKeyword(g.Name, HandKeywords, out tok2)) filter2 = "hand";
                    else if (MatchKeyword(g.Name, FootKeywords, out tok2)) filter2 = "foot";
                    if (filter2 != null)
                    {
                        foreach (string br in bodyRegions)
                            if (RegionMatches(br, filter2) && !ps.Regions.Contains(br)) ps.Regions.Add(br);
                        ps.PairConfidence = "low";
                        ps.PairReason = "声明未写 covers 部位，按 GameObject 名关键词 '" + tok2 + "' 推断（low）";
                    }
                }
                ps.Regions.Sort(StringComparer.Ordinal);
                PokeCheckBbox(ps, bi);
                specs.Add(ps);
            }

            // 2) 无声明：关键词兜底并标 low（声明存在但一件都没配上时不兜底，声明是权威）
            if (specs.Count == 0 && p.Covers.Count == 0)
            {
                for (int i = 0; i < garm.Count; i++)
                {
                    PokeGarment g = garm[i];
                    string tok;
                    string filter = null;
                    if (MatchKeyword(g.Name, HandKeywords, out tok)) filter = "hand";
                    else if (MatchKeyword(g.Name, FootKeywords, out tok)) filter = "foot";
                    if (filter == null) continue;
                    var ps = new PokePairSpec();
                    ps.Cover = new PokeCoverSpec { Garment = g.Path, Confidence = "low" };
                    ps.G = g;
                    ps.PairSource = "name_token";
                    ps.PairConfidence = "low";
                    ps.PairReason = "无声明 covers，按 GameObject 名关键词 '" + tok + "' 配对（low）";
                    foreach (string br in bodyRegions)
                        if (RegionMatches(br, filter) && !ps.Regions.Contains(br)) ps.Regions.Add(br);
                    ps.Regions.Sort(StringComparer.Ordinal);
                    PokeCheckBbox(ps, bi);
                    specs.Add(ps);
                }
                if (specs.Count > 0)
                    ctx.Warn("poke: 请求没有声明 covers，退回关键词配对 " + specs.Count + " 件（pair_confidence=low）。");
            }

            specs.Sort((a, b) =>
            {
                int c = string.CompareOrdinal(a.G != null ? a.G.Path : "", b.G != null ? b.G.Path : "");
                return c;
            });
            return specs;
        }

        private static string PokeRegionSample(HashSet<string> regions)
        {
            var l = new List<string>(regions);
            l.Sort(StringComparer.Ordinal);
            var sb = new StringBuilder();
            for (int i = 0; i < l.Count && i < 8; i++)
            {
                if (i > 0) sb.Append('/');
                sb.Append(l[i]);
            }
            return sb.ToString();
        }

        private static PokeGarment PokeMatchGarment(List<PokeGarment> garm, string spec)
        {
            if (string.IsNullOrEmpty(spec)) return null;
            string leaf = spec;
            int slash = spec.LastIndexOf('/');
            if (slash >= 0 && slash + 1 < spec.Length) leaf = spec.Substring(slash + 1);
            for (int i = 0; i < garm.Count; i++)
                if (garm[i].Path == spec || garm[i].Name == spec) return garm[i];
            for (int i = 0; i < garm.Count; i++)
                if (garm[i].Name == leaf || garm[i].Path.EndsWith("/" + leaf, StringComparison.Ordinal)) return garm[i];
            return null;
        }

        private static void PokeCheckBbox(PokePairSpec ps, BodyMeshInfo bi)
        {
            if (ps.G == null) { ps.BboxOverlap = false; ps.PairReason = "衣物为空"; return; }
            Vector3 gmn = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
            Vector3 gmx = new Vector3(float.MinValue, float.MinValue, float.MinValue);
            for (int i = 0; i < ps.G.Pos.Length; i++)
            {
                Vector3 v = ps.G.Pos[i];
                if (v.x < gmn.x) gmn.x = v.x; if (v.y < gmn.y) gmn.y = v.y; if (v.z < gmn.z) gmn.z = v.z;
                if (v.x > gmx.x) gmx.x = v.x; if (v.y > gmx.y) gmx.y = v.y; if (v.z > gmx.z) gmx.z = v.z;
            }
            Vector3 bmn = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
            Vector3 bmx = new Vector3(float.MinValue, float.MinValue, float.MinValue);
            bool any = false;
            for (int i = 0; i < bi.Pos.Length; i++)
            {
                if (!bi.Usable[i]) continue;
                if (!ps.Regions.Contains(bi.Region[i])) continue;
                Vector3 v = bi.Pos[i];
                any = true;
                if (v.x < bmn.x) bmn.x = v.x; if (v.y < bmn.y) bmn.y = v.y; if (v.z < bmn.z) bmn.z = v.z;
                if (v.x > bmx.x) bmx.x = v.x; if (v.y > bmx.y) bmx.y = v.y; if (v.z > bmx.z) bmx.z = v.z;
            }
            if (!any)
            {
                ps.BboxOverlap = false;
                ps.PairReason = "该部位在身体网格里没有可用顶点";
                return;
            }
            bool ox = bmn.x <= gmx.x && bmx.x >= gmn.x;
            bool oy = bmn.y <= gmx.y && bmx.y >= gmn.y;
            bool oz = bmn.z <= gmx.z && bmx.z >= gmn.z;
            ps.BboxOverlap = ox && oy && oz;
            if (!ps.BboxOverlap)
                ps.PairReason = "身体部位包围盒与衣物包围盒不重叠（" + (ox ? "" : "X") + (oy ? "" : "Y") + (oz ? "" : "Z")
                    + "），拒绝配对";
        }

        // ── 外壳分类 ────────────────────────────────────────────────────

        private static void PokeClassifyShell(AuditContext ctx, PokeParams p, PokePairSpec ps, Animator anim, int mask,
            ref long raysUsed, ref bool budgetHit)
        {
            PokeGarment g = ps.G;
            int n = g.TriCount;
            g.FaceNrm = new Vector3[n];
            g.OrientedNrm = new Vector3[n];
            g.Flipped = new bool[n];
            g.IsShell = new bool[n];
            g.ShellRay = p.Diag ? new int[n] : null;
            g.ShellRayEnd = p.Diag ? new Vector3[n] : null;
            g.OutwardDot = p.Diag ? new float[n] : null;
            if (g.ShellRay != null) for (int f = 0; f < n; f++) g.ShellRay[f] = -1;
            g.ShellOutwardEscaped = 0;
            g.ShellConeRescued = 0;
            bool useWinding = p.NormalSign == "winding" || p.NormalSign == "parity";
            var segs = PokeRegionSegments(ps.Regions, anim);
            Vector3 fallback = PokeHipsPoint(anim);

            for (int f = 0; f < n; f++)
            {
                Vector3 a = g.Pos[g.Tris[3 * f]], b = g.Pos[g.Tris[3 * f + 1]], c = g.Pos[g.Tris[3 * f + 2]];
                Vector3 gn = Vector3.Cross(b - a, c - a);
                if (gn.sqrMagnitude < 1e-18f) { g.FaceNrm[f] = Vector3.up; g.OrientedNrm[f] = Vector3.up; continue; }
                gn.Normalize();
                g.FaceNrm[f] = gn;
                Vector3 cent = (a + b + c) / 3f;
                Vector3 outward = PokeOutward(cent, segs, fallback);
                if (outward.sqrMagnitude < 1e-12f) outward = gn;
                outward.Normalize();
                bool flipped = Vector3.Dot(gn, outward) < 0f;
                g.Flipped[f] = flipped;
                // 任务 CI：NormalSign=winding/parity 时不再按锚骨外向翻正绕序法线；
                // parity 的符号由 PokeDepthsAndPatches 按每顶点奇偶投票再定。
                g.OrientedNrm[f] = useWinding ? gn : (flipped ? -gn : gn);
            }

            // 外壳测试（判定规则见 p.ShellRule）
            bool needAll = p.ShellRule == "majority";
            Vector3 t1, t2;
            for (int f = 0; f < n; f++)
            {
                if (raysUsed >= p.RayBudget) { budgetHit = true; break; }
                Vector3 a = g.Pos[g.Tris[3 * f]], b = g.Pos[g.Tris[3 * f + 1]], c = g.Pos[g.Tris[3 * f + 2]];
                Vector3 cent = (a + b + c) / 3f;
                Vector3 outward = PokeOutward(cent, segs, fallback);
                if (outward.sqrMagnitude < 1e-12f) outward = g.OrientedNrm[f];
                outward.Normalize();
                if (g.OutwardDot != null) g.OutwardDot[f] = Vector3.Dot(g.FaceNrm[f], outward);
                PokeBasis(outward, out t1, out t2);
                int escapes = 0;
                bool outwardEscaped = false;
                int firstK = -1;
                Vector3 firstEnd = Vector3.zero;
                for (int k = 0; k < 5; k++)
                {
                    Vector3 dir;
                    if (k == 0) dir = outward;
                    else
                    {
                        Vector3 axis = (k == 1 || k == 3) ? t1 : t2;
                        float ang = (k == 1 || k == 2) ? p.ConeDeg : -p.ConeDeg;
                        dir = Quaternion.AngleAxis(ang, axis) * outward;
                    }
                    if (raysUsed >= p.RayBudget) { budgetHit = true; break; }
                    RaycastHit h;
                    Vector3 origin = cent + dir * p.OriginM;
                    raysUsed++;
                    bool hit = Physics.Raycast(origin, dir, out h, p.ShellRayM, mask, QueryTriggerInteraction.Ignore);
                    if (!hit)
                    {
                        escapes++;
                        if (k == 0) outwardEscaped = true;
                        if (firstK < 0) { firstK = k; firstEnd = origin + dir * p.ShellRayM; }
                        if (!needAll) break;      // any/outward：第一处逃逸即可判定外壳
                    }
                    else if (p.ShellRule == "outward")
                    {
                        break;                    // outward：外向射线被挡即非外壳
                    }
                }
                if (PokeIsShell(escapes, outwardEscaped, p.ShellRule, p.ShellMajorityMin))
                {
                    g.IsShell[f] = true;
                    if (firstK == 0) g.ShellOutwardEscaped++;
                    else g.ShellConeRescued++;
                    if (g.ShellRay != null) { g.ShellRay[f] = firstK; g.ShellRayEnd[f] = firstEnd; }
                }
            }
            g.ShellCount = 0;
            for (int f = 0; f < n; f++) if (g.IsShell[f]) g.ShellCount++;

            PokeTopology(g);
            var shell = new List<int>(g.ShellCount);
            for (int f = 0; f < n; f++) if (g.IsShell[f]) shell.Add(f);
            g.Bvh = new PokeBvh(g.Pos, g.Tris, shell);
        }

        /// <summary>
        /// 任务 CI：外壳判定纯函数（离线 selftest 直接断言）。
        /// any=任一条逃逸（旧行为）；outward=只有外向射线逃逸；majority=至少 majorityMin 条逃逸。
        /// </summary>
        internal static bool PokeIsShell(int escapedCount, bool outwardEscaped, string rule, int majorityMin)
        {
            if (rule == "outward") return outwardEscaped;
            if (rule == "majority") return escapedCount >= majorityMin;
            return escapedCount > 0;
        }

        internal static void PokeBasis(Vector3 n, out Vector3 t1, out Vector3 t2)
        {
            Vector3 up = Mathf.Abs(Vector3.Dot(n, Vector3.up)) < 0.9f ? Vector3.up : Vector3.right;
            t1 = Vector3.Cross(n, up);
            if (t1.sqrMagnitude < 1e-12f) t1 = Vector3.right;
            t1.Normalize();
            t2 = Vector3.Cross(n, t1).normalized;
        }

        private static Vector3 PokeOutward(Vector3 cent, List<Vector3[]> segs, Vector3 fallback)
        {
            if (segs == null || segs.Count == 0) return cent - fallback;
            float best = float.MaxValue;
            Vector3 bestDir = cent - fallback;
            for (int i = 0; i < segs.Count; i++)
            {
                Vector3 a = segs[i][0], b = segs[i][1];
                Vector3 ab = b - a;
                float len2 = ab.sqrMagnitude;
                float t = len2 > 1e-12f ? Mathf.Clamp01(Vector3.Dot(cent - a, ab) / len2) : 0f;
                Vector3 cp = a + ab * t;
                float d = (cent - cp).sqrMagnitude;
                if (d < best) { best = d; bestDir = cent - cp; }
            }
            return bestDir;
        }

        private static Vector3 PokeHipsPoint(Animator anim)
        {
            if (anim != null)
            {
                try
                {
                    Transform hips = anim.GetBoneTransform(HumanBodyBones.Hips);
                    if (hips != null) return hips.position;
                }
                catch { }
            }
            return Vector3.zero;
        }

        /// <summary>部位 → 锚骨线段（World）。脚用 Foot→Toes（沿脚轴），手用 Hand→MiddleProximal，其余父→本骨。</summary>
        private static List<Vector3[]> PokeRegionSegments(List<string> regions, Animator anim)
        {
            var segs = new List<Vector3[]>();
            if (anim == null) return segs;
            for (int i = 0; i < regions.Count; i++)
            {
                string r = regions[i];
                if (string.IsNullOrEmpty(r)) continue;
                bool left = r.IndexOf("Left", StringComparison.OrdinalIgnoreCase) >= 0;
                bool right = r.IndexOf("Right", StringComparison.OrdinalIgnoreCase) >= 0;
                Transform foot = null, toes = null, hand = null, mid = null;
                try
                {
                    if (left)
                    {
                        foot = anim.GetBoneTransform(HumanBodyBones.LeftFoot);
                        toes = anim.GetBoneTransform(HumanBodyBones.LeftToes);
                        hand = anim.GetBoneTransform(HumanBodyBones.LeftHand);
                        mid = anim.GetBoneTransform(HumanBodyBones.LeftMiddleProximal);
                    }
                    else if (right)
                    {
                        foot = anim.GetBoneTransform(HumanBodyBones.RightFoot);
                        toes = anim.GetBoneTransform(HumanBodyBones.RightToes);
                        hand = anim.GetBoneTransform(HumanBodyBones.RightHand);
                        mid = anim.GetBoneTransform(HumanBodyBones.RightMiddleProximal);
                    }
                }
                catch { }
                if (IsFootRegion(r) && foot != null)
                {
                    Vector3 b = toes != null ? toes.position : foot.position + foot.forward * 0.1f;
                    segs.Add(new Vector3[] { foot.position, b });
                }
                else if (IsHandRegion(r) && hand != null)
                {
                    Vector3 b = mid != null ? mid.position : hand.position + hand.forward * 0.05f;
                    segs.Add(new Vector3[] { hand.position, b });
                }
                else
                {
                    Transform t = PokeBoneByName(anim, r);
                    if (t != null)
                    {
                        Vector3 a = t.parent != null ? t.parent.position : t.position;
                        segs.Add(new Vector3[] { a, t.position });
                    }
                }
            }
            return segs;
        }

        private static Transform PokeBoneByName(Animator anim, string region)
        {
            if (anim == null) return null;
            try
            {
                Array values = Enum.GetValues(typeof(HumanBodyBones));
                for (int i = 0; i < values.Length; i++)
                {
                    var b = (HumanBodyBones)values.GetValue(i);
                    if (b == HumanBodyBones.LastBone) continue;
                    if (b.ToString() == region) return anim.GetBoneTransform(b);
                }
            }
            catch { }
            return null;
        }

        private static void PokeTopology(PokeGarment g)
        {
            int n = g.TriCount;
            // 边 → 相邻面数、定向法线和
            for (int f = 0; f < n; f++)
            {
                int i0 = g.Tris[3 * f], i1 = g.Tris[3 * f + 1], i2 = g.Tris[3 * f + 2];
                PokeAddEdgeFace(g, i0, i1, g.OrientedNrm[f]);
                PokeAddEdgeFace(g, i1, i2, g.OrientedNrm[f]);
                PokeAddEdgeFace(g, i2, i0, g.OrientedNrm[f]);
            }
            // 顶点角度加权伪法线（任务 CU 抽成 PokeAngleWeightedPseudo，poke 外壳与 shrink_cover 身体法线共用）
            g.VertexPseudo = PokeAngleWeightedPseudo(g.Pos, g.Tris, g.OrientedNrm, g.VertexCount);
        }

        /// <summary>
        /// 角度加权顶点伪法线（任务 CU 从 PokeTopology 抽出，别处不要另写一份）：
        /// 每个顶点的伪法线 = 其相邻三角形定向法线按该顶点处夹角加权求和后归一化；
        /// faceNrm 为空/长度不足的三角形跳过。返回数组长度 = vertexCount，孤立顶点为 (0,0,0)。
        /// </summary>
        private static Vector3[] PokeAngleWeightedPseudo(Vector3[] pos, int[] tris, Vector3[] faceNrm, int vertexCount)
        {
            var pseudo = new Vector3[vertexCount];
            if (pos == null || tris == null || faceNrm == null || vertexCount <= 0) return pseudo;
            int fn = tris.Length / 3;
            for (int f = 0; f < fn && f < faceNrm.Length; f++)
            {
                int i0 = tris[3 * f], i1 = tris[3 * f + 1], i2 = tris[3 * f + 2];
                if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) continue;
                Vector3 p0 = pos[i0], p1 = pos[i1], p2 = pos[i2];
                Vector3 nrm = faceNrm[f];
                pseudo[i0] += nrm * PokeAngleAt(p0, p1, p2);
                pseudo[i1] += nrm * PokeAngleAt(p1, p2, p0);
                pseudo[i2] += nrm * PokeAngleAt(p2, p0, p1);
            }
            for (int i = 0; i < vertexCount; i++)
            {
                if (pseudo[i].sqrMagnitude > 1e-12f) pseudo[i].Normalize();
            }
            return pseudo;
        }

        /// <summary>绕序几何面法线（未定向），与 PokeClassifyShell 里 gn 同口径；退化面记 up。</summary>
        private static Vector3[] PokeWindingFaceNormals(Vector3[] pos, int[] tris)
        {
            int fn = tris != null ? tris.Length / 3 : 0;
            var nrm = new Vector3[fn];
            if (pos == null) return nrm;
            for (int f = 0; f < fn; f++)
            {
                int i0 = tris[3 * f], i1 = tris[3 * f + 1], i2 = tris[3 * f + 2];
                Vector3 gn = Vector3.Cross(pos[i1] - pos[i0], pos[i2] - pos[i0]);
                nrm[f] = gn.sqrMagnitude > 1e-18f ? gn.normalized : Vector3.up;
            }
            return nrm;
        }

        /// <summary>
        /// 任务 CU：身体每顶点的**外向**伪法线。用 PokeAngleWeightedPseudo（角度加权）在身体绕序面上算，
        /// 再用 BakeMesh 世界法线把符号翻正（网格绕序可靠时两者一致；读不到法线就保持绕序伪法线）。
        /// 全零（孤立顶点 / 退化面）时回落到 BakeMesh 法线；仍为零则保持零，由调用方跳过射线。
        /// </summary>
        private static Vector3[] ScBodyOutwardNormals(BodyMeshInfo bi)
        {
            if (bi == null || bi.Pos == null) return null;
            Vector3[] faceNrm = PokeWindingFaceNormals(bi.Pos, bi.Tris);
            Vector3[] pseudo = PokeAngleWeightedPseudo(bi.Pos, bi.Tris, faceNrm, bi.Pos.Length);
            for (int i = 0; i < pseudo.Length; i++)
            {
                Vector3 pn = pseudo[i];
                Vector3 bn = (bi.Nrm != null && i < bi.Nrm.Length) ? bi.Nrm[i] : Vector3.zero;
                if (pn.sqrMagnitude > 1e-12f && bn.sqrMagnitude > 1e-12f && Vector3.Dot(pn, bn) < 0f) pn = -pn;
                if (pn.sqrMagnitude <= 1e-12f) pn = bn;
                pseudo[i] = pn.sqrMagnitude > 1e-12f ? pn.normalized : Vector3.zero;
            }
            return pseudo;
        }

        private static float PokeAngleAt(Vector3 at, Vector3 b, Vector3 c)
        {
            Vector3 u = b - at, v = c - at;
            float lu = u.magnitude, lv = v.magnitude;
            if (lu < 1e-9f || lv < 1e-9f) return 0f;
            float d = Mathf.Clamp(Vector3.Dot(u, v) / (lu * lv), -1f, 1f);
            return Mathf.Acos(d);
        }

        private static void PokeAddEdgeFace(PokeGarment g, int a, int b, Vector3 nrm)
        {
            if (a == b) return;
            int lo = a < b ? a : b, hi = a < b ? b : a;
            long key = ((long)lo << 32) | (uint)hi;
            int c;
            g.EdgeCount.TryGetValue(key, out c);
            g.EdgeCount[key] = c + 1;
            Vector3 s;
            g.EdgeNormal.TryGetValue(key, out s);
            g.EdgeNormal[key] = s + nrm;
        }

        // ── 鞋垫面（R9 v2）──────────────────────────────────────────────

        /// <summary>
        /// 任务 CF（R9 v2）：在鞋件三角形里选「鞋垫面」——法线朝上、质心落在脚部 covers 包围盒内、
        /// 且位于外底（朝下外壳面）之上且厚度合理。不要求是外壳（内壳/内衬也算，这正是 v1 sd 的盲点）。
        /// 结果写 g.InsoleBvh / g.InsoleCentroids / g.InsoleFaces，供 PokeDepthsAndPatches 量 si 与倾角。
        /// 找不到朝上内壳（例如实心鞋）时留空：si/tilt 缺失，排序自然落回 sd/d_v。
        /// 见 审查/docs/foot-shoe-candidates.md（原 README §3.4）。<paramref name="bi"/> 提供脚部覆盖区的世界包围盒。
        /// </summary>
        private static void PokeBuildInsole(PokeParams p, PokePairSpec ps, BodyMeshInfo bi)
        {
            PokeGarment g = ps.G;
            if (g == null) return;
            g.InsoleBvh = null;
            g.InsoleCentroids = null;
            g.InsoleFaces = 0;
            if (g.TriCount <= 0 || g.OrientedNrm == null || g.IsShell == null) return;

            // 1) 脚部 covers 身体顶点包围盒（外扩 margin）
            Vector3 mn = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
            Vector3 mx = new Vector3(float.MinValue, float.MinValue, float.MinValue);
            bool any = false;
            for (int i = 0; i < bi.Pos.Length; i++)
            {
                if (!bi.Usable[i]) continue;
                if (!ps.Regions.Contains(bi.Region[i])) continue;
                Vector3 v = bi.Pos[i];
                if (v.x < mn.x) mn.x = v.x; if (v.y < mn.y) mn.y = v.y; if (v.z < mn.z) mn.z = v.z;
                if (v.x > mx.x) mx.x = v.x; if (v.y > mx.y) mx.y = v.y; if (v.z > mx.z) mx.z = v.z;
                any = true;
            }
            if (!any) return;
            float margin = p.InsoleBboxMarginMm / 1000f;
            mn -= new Vector3(margin, margin, margin);
            mx += new Vector3(margin, margin, margin);

            // 2) 朝下外壳面当「外底」参考；一个都没有就不认鞋垫（宁缺勿猜）
            var down = new List<int>();
            for (int f = 0; f < g.TriCount; f++)
                if (g.IsShell[f] && Vector3.Dot(g.OrientedNrm[f], Vector3.down) >= p.InsoleUpCos) down.Add(f);
            if (down.Count == 0) return;
            var soleBvh = new PokeBvh(g.Pos, g.Tris, down);
            float soleMin = p.InsoleSoleMinMm / 1000f, soleMax = p.InsoleSoleMaxMm / 1000f;

            // 3) 鞋垫候选：几何法线朝上（= 从鞋内朝脚的那一面；注意 g.OrientedNrm 是「远离脚骨」定向，
            //    对空腔里的鞋垫会朝下，不能拿来判「朝上」）+ 在脚部包围盒内 + 高出外底且厚度合理。
            var insole = new List<int>();
            var cents = new List<Vector3>();
            for (int f = 0; f < g.TriCount; f++)
            {
                if (g.FaceNrm == null) break;
                if (Vector3.Dot(g.FaceNrm[f], Vector3.up) < p.InsoleUpCos) continue;
                Vector3 a = g.Pos[g.Tris[3 * f]], b = g.Pos[g.Tris[3 * f + 1]], c = g.Pos[g.Tris[3 * f + 2]];
                Vector3 cent = (a + b + c) / 3f;
                if (cent.x < mn.x || cent.x > mx.x || cent.y < mn.y || cent.y > mx.y
                    || cent.z < mn.z || cent.z > mx.z) continue;
                Vector3 closest; float d2; int feat;
                int sf = soleBvh.Nearest(cent, out closest, out d2, out feat);
                if (sf < 0) continue;
                // 假定被测状态站立、世界向上即脚底法线（审查/docs/foot-shoe-candidates-metrics.md，原 README §3.4 已写明该假设）。
                float above = cent.y - closest.y;
                if (above < soleMin || above > soleMax) continue;
                insole.Add(f);
                cents.Add(cent);
            }
            if (insole.Count == 0) return;
            g.InsoleFaces = insole.Count;
            g.InsoleCentroids = cents;
            g.InsoleBvh = new PokeBvh(g.Pos, g.Tris, insole);
        }

        /// <summary>任务 CF：脚底朝下顶点拟合平面 vs 鞋垫面质心拟合平面的夹角（度）。</summary>
        private static void PokeComputeTilt(PokePairResult pr, PokeGarment g, BodyMeshInfo bi, List<int> footDown)
        {
            if (footDown == null || footDown.Count < 3) return;
            var pts = new List<Vector3>(footDown.Count);
            for (int i = 0; i < footDown.Count; i++) pts.Add(bi.Pos[footDown[i]]);
            Vector3 nf;
            if (!PokeFitPlaneYUp(pts, out nf)) return;
            pr.FootPlaneTiltDeg = PokeDegBetween(nf, Vector3.up);
            pr.TiltFootVerts = footDown.Count;
            if (g == null || g.InsoleCentroids == null || g.InsoleCentroids.Count < 3) return;
            Vector3 ni;
            if (!PokeFitPlaneYUp(g.InsoleCentroids, out ni)) return;
            pr.InsolePlaneTiltDeg = PokeDegBetween(ni, Vector3.up);
            pr.TiltDeg = PokeDegBetween(nf, ni);
            pr.TiltInsoleFaces = g.InsoleFaces;
        }

        /// <summary>最小二乘拟合近水平平面 y = a·x + b·z + c，返回朝上法线；退化返回 false。</summary>
        private static bool PokeFitPlaneYUp(List<Vector3> pts, out Vector3 normal)
        {
            normal = Vector3.up;
            int n = pts != null ? pts.Count : 0;
            if (n < 3) return false;
            // 先减质心，避免脚离世界原点远时法方程病态。
            double cx = 0, cy = 0, cz = 0;
            for (int i = 0; i < n; i++) { cx += pts[i].x; cy += pts[i].y; cz += pts[i].z; }
            cx /= n; cy /= n; cz /= n;
            double sx = 0, sz = 0, sy = 0, sxx = 0, szz = 0, sxz = 0, sxy = 0, szy = 0;
            for (int i = 0; i < n; i++)
            {
                double x = pts[i].x - cx, y = pts[i].y - cy, z = pts[i].z - cz;
                sx += x; sz += z; sy += y;
                sxx += x * x; szz += z * z; sxz += x * z;
                sxy += x * y; szy += z * y;
            }
            var m = new double[3, 3] { { sxx, sxz, sx }, { sxz, szz, sz }, { sx, sz, (double)n } };
            double det = PokeDet3(m);
            if (Math.Abs(det) < 1e-12) return false;
            double a = PokeDet3(PokeCol(m, 0, sxy, szy, sy)) / det;
            double b = PokeDet3(PokeCol(m, 1, sxy, szy, sy)) / det;
            normal = new Vector3((float)(-a), 1f, (float)(-b));
            if (normal.sqrMagnitude < 1e-12f) { normal = Vector3.up; return false; }
            normal.Normalize();
            if (normal.y < 0f) normal = -normal;   // 朝上
            return true;
        }

        private static double[,] PokeCol(double[,] m, int col, double r0, double r1, double r2)
        {
            var o = (double[,])m.Clone();
            o[0, col] = r0; o[1, col] = r1; o[2, col] = r2;
            return o;
        }

        private static double PokeDet3(double[,] m)
        {
            return m[0, 0] * (m[1, 1] * m[2, 2] - m[1, 2] * m[2, 1])
                 - m[0, 1] * (m[1, 0] * m[2, 2] - m[1, 2] * m[2, 0])
                 + m[0, 2] * (m[1, 0] * m[2, 1] - m[1, 1] * m[2, 0]);
        }

        private static float PokeDegBetween(Vector3 a, Vector3 b)
        {
            return Mathf.Acos(Mathf.Clamp(Vector3.Dot(a, b), -1f, 1f)) * Mathf.Rad2Deg;
        }

        // ── 有向深度 + 斑块 ─────────────────────────────────────────────

        private static void PokeDepthsAndPatches(AuditContext ctx, PokeParams p, PokePairSpec ps, PokePairResult pr,
            BodyMeshInfo bi, Dictionary<Transform, string> boneMap, Animator anim, int mask,
            ref long raysUsed, ref bool budgetHit)
        {
            PokeGarment g = ps.G;
            int n = bi.Pos.Length;
            pr.InsoleFaces = g != null ? g.InsoleFaces : 0;
            bool[] inPair = new bool[n];
            float[] dmm = new float[n];
            Vector3[] pnArr = p.Diag ? new Vector3[n] : null;   // 任务 CI：诊断用（parity 修正后的伪法线）
            bool[] opening = new bool[n];
            bool[] poke = new bool[n];
            var footDownVerts = new List<int>();   // 任务 CF：脚部「朝下」顶点，供 si/tilt
            var anchorCache = new Dictionary<string, Transform>(StringComparer.Ordinal);

            for (int vi = 0; vi < n; vi++)
            {
                string rg = bi.Region[vi];
                bool inR = false;
                for (int k = 0; k < ps.Regions.Count; k++) if (ps.Regions[k] == rg) { inR = true; break; }
                if (!inR) continue;
                inPair[vi] = true;
                PokeInc(pr.RegionTotal, rg);
                switch (bi.Exclude[vi])
                {
                    case ExNonFinite: PokeInc(pr.RegionExNan, rg); break;
                    case ExNanimated: PokeInc(pr.RegionExDel, rg); PokeInc(pr.RegionExDelNani, rg); break;
                    case ExZeroWeight: PokeInc(pr.RegionExDel, rg); PokeInc(pr.RegionExDelZero, rg); break;
                    case ExBeyond3m: PokeInc(pr.RegionExFar, rg); break;
                }
                if (!bi.Usable[vi]) continue;

                Vector3 closest; float d2; int feature;
                int f = g.Bvh.Nearest(bi.Pos[vi], out closest, out d2, out feature);
                if (f < 0) continue;
                Vector3 pn = PokeFeatureNormal(g, f, feature);
                float d = Vector3.Dot(bi.Pos[vi] - closest, pn);
                // 任务 CI：NormalSign=parity —— 绕序法线定朝向、每顶点用「在不在衣服里」的 3 轴奇偶投票定号：
                //   投票判在内部 → 有向距离取负；判在外部 → 取正；三轴平票（0）时不动。
                if (p.NormalSign == "parity")
                {
                    int pv = PokeParityVote(bi.Pos[vi], mask, p.ShellRayM, p.RayBudget, g.Collider, ref raysUsed, ref budgetHit);
                    if (pv > 0 && d > 0f) { d = -d; pn = -pn; }
                    else if (pv < 0 && d < 0f) { d = -d; pn = -pn; }
                }
                if (pnArr != null) pnArr[vi] = pn;
                float mm = d * 1000f;
                dmm[vi] = mm;
                bool isOpening = false;
                if (feature == 1 || feature == 2 || feature == 3)
                {
                    int a = g.Tris[3 * f], b = g.Tris[3 * f + 1], c = g.Tris[3 * f + 2];
                    int e0, e1;
                    if (feature == 1) { e0 = a; e1 = b; }
                    else if (feature == 2) { e0 = b; e1 = c; }
                    else { e0 = c; e1 = a; }
                    int lo = e0 < e1 ? e0 : e1, hi = e0 < e1 ? e1 : e0;
                    long key = ((long)lo << 32) | (uint)hi;
                    int ec;
                    g.EdgeCount.TryGetValue(key, out ec);
                    if (ec == 1) isOpening = true;
                }

                List<float> dl;
                if (!pr.RegionDepthMm.TryGetValue(rg, out dl)) { dl = new List<float>(); pr.RegionDepthMm[rg] = dl; }
                dl.Add(mm);
                string sub = PokeSubPart(rg, bi.Pos[vi], anim);
                List<float> sdl;
                if (!pr.SubPartDepthMm.TryGetValue(sub, out sdl)) { sdl = new List<float>(); pr.SubPartDepthMm[sub] = sdl; }
                sdl.Add(mm);

                // 任务 BZ（R9 sd/跟隙）+ 任务 CF（R9 v2 si/tilt）：脚部 covers 内「脚底朝下」的身体顶点。
                // sd（旧）= 到最近朝下外底壳面的有向距离；si（新）= 到鞋垫面（朝上内壳）的有向距离。
                if ((p.SdEnabled || p.InsoleEnabled) && IsFootRegion(rg))
                {
                    if (p.SdEnabled) pr.SdFootVerts++;
                    Vector3 bodyN = (bi.Nrm != null && vi < bi.Nrm.Length) ? bi.Nrm[vi] : Vector3.zero;
                    // 读不到身体法线时不按法线过滤（见 审查/docs/foot-shoe-candidates-metrics.md，原 README §3.4 口径）。
                    bool bodyDown = bodyN.sqrMagnitude <= 1e-12f
                        || Vector3.Dot(bodyN, Vector3.down) >= p.SdDownCos;
                    if (bodyDown)
                    {
                        footDownVerts.Add(vi);
                        if (p.SdEnabled)
                        {
                            bool soleDown = Vector3.Dot(pn, Vector3.down) > 0f;
                            if (soleDown)
                            {
                                float sd = -mm;
                                pr.SdMm.Add(sd);
                                pr.SdSoleFacingVerts++;
                                if (sub == "ankle") pr.HeelGapSoleMm.Add(sd);
                            }
                        }
                        if (p.InsoleEnabled && g.InsoleBvh != null && g.InsoleBvh.FaceCount > 0)
                        {
                            pr.SiFootVerts++;
                            Vector3 ic; float id2; int ifeat;
                            int iface = g.InsoleBvh.Nearest(bi.Pos[vi], out ic, out id2, out ifeat);
                            if (iface >= 0)
                            {
                                // 鞋垫面是「朝上」的面：把特征法线翻到朝上再量有向距离，
                                // si>0=脚在鞋垫上方（悬空）、si<0=陷进鞋垫。PokeFeatureNormal 返回的是
                                // 「远离脚骨」定向的法线（空腔鞋垫朝下），故这里按 y 翻正。
                                Vector3 inrm = PokeFeatureNormal(g, iface, ifeat);
                                if (inrm.y < 0f) inrm = -inrm;
                                float si = Vector3.Dot(bi.Pos[vi] - ic, inrm) * 1000f;
                                pr.SiMm.Add(si);
                                if (sub == "ankle") pr.HeelSiMm.Add(si);
                            }
                        }
                    }
                }

                float tau = PokeTau(rg, p);
                if (isOpening)
                {
                    opening[vi] = true;
                    PokeInc(pr.RegionOpening, rg);
                    PokeInc(pr.SubPartOpening, sub);
                    pr.OpeningVerts++;
                    if (mm > p.OpeningDeepFactor * tau)
                    {
                        PokeInc(pr.RegionOpeningDeep, rg);
                        pr.OpeningDeepVerts++;
                    }
                    continue;
                }
                if (mm > tau) poke[vi] = true;
            }

            // 任务 CF（R9 v2）：脚底平面 vs 鞋垫平面夹角（在顶点循环之后、斑块计算之前）。
            PokeComputeTilt(pr, g, bi, footDownVerts);

            // 任务 CW：按本次配对被测区的身体网格密度推导面积门槛。
            // 任务 CX 口径：被测区 = covers_regions 覆盖到、且「可用」的身体顶点（inPair ∧ Usable）；
            // 位置取 bind pose 稳定参考（RestPos），避免密度随形态键形变漂移；与斑块面积口径一致。
            int regionVerts; float regionAreaCm2;
            Vector3[] densityPos = bi.RestPos != null ? bi.RestPos : bi.Pos;
            pr.AreaPerVertPosSource = bi.RestPos != null ? "bind_pose" : "baked";
            pr.AreaPerVertCm2 = PokeAreaPerVertCm2(densityPos, bi.Tris, inPair, bi.Usable, out regionVerts, out regionAreaCm2);
            pr.RegionVerts = regionVerts;
            pr.RegionAreaCm2 = regionAreaCm2;
            string minAreaSource;
            float minArea = PokeResolveMinPatchArea(p.MinAreaExplicit, p.MinAreaCm2, p.MinPatchRule,
                p.AbsoluteFloorCm2, p.MinVertsForPatch, pr.AreaPerVertCm2, out minAreaSource);
            pr.MinPatchAreaCm2 = minArea;
            pr.MinPatchAreaSource = minAreaSource;

            // union-find：只在同配对的 poke 顶点间连边
            int[] uf = new int[n];
            for (int i = 0; i < n; i++) uf[i] = i;
            for (int t = 0; t + 2 < bi.Tris.Length; t += 3)
            {
                int a = bi.Tris[t], b = bi.Tris[t + 1], c = bi.Tris[t + 2];
                if (a < 0 || b < 0 || c < 0 || a >= n || b >= n || c >= n) continue;
                if (!inPair[a] || !inPair[b] || !inPair[c]) continue;
                if (!bi.Usable[a] || !bi.Usable[b] || !bi.Usable[c]) continue;
                if (poke[a] && poke[b]) PokeUnion(uf, a, b);
                if (poke[b] && poke[c]) PokeUnion(uf, b, c);
                if (poke[c] && poke[a]) PokeUnion(uf, c, a);
            }

            var compVerts = new Dictionary<int, List<int>>();
            for (int i = 0; i < n; i++)
            {
                if (!poke[i]) continue;
                int r = PokeFind(uf, i);
                List<int> l;
                if (!compVerts.TryGetValue(r, out l)) { l = new List<int>(); compVerts[r] = l; }
                l.Add(i);
            }

            var patchArea = new Dictionary<int, float>();
            for (int t = 0; t + 2 < bi.Tris.Length; t += 3)
            {
                int a = bi.Tris[t], b = bi.Tris[t + 1], c = bi.Tris[t + 2];
                if (a < 0 || b < 0 || c < 0 || a >= n || b >= n || c >= n) continue;
                if (!inPair[a] || !inPair[b] || !inPair[c]) continue;
                if (!bi.Usable[a] || !bi.Usable[b] || !bi.Usable[c]) continue;
                int firstPoke = -1;
                if (poke[a]) firstPoke = a; else if (poke[b]) firstPoke = b; else if (poke[c]) firstPoke = c;
                if (firstPoke < 0) continue;
                int r = PokeFind(uf, firstPoke);
                float area = Vector3.Cross(bi.Pos[b] - bi.Pos[a], bi.Pos[c] - bi.Pos[a]).magnitude * 0.5f;
                float cur;
                patchArea.TryGetValue(r, out cur);
                patchArea[r] = cur + area;
            }

            var compRoots = new List<int>(compVerts.Keys);
            compRoots.Sort();
            for (int ci = 0; ci < compRoots.Count; ci++)
            {
                int root = compRoots[ci];
                List<int> verts = compVerts[root];
                float areaM2;
                patchArea.TryGetValue(root, out areaM2);
                float areaCm2 = areaM2 * 10000f;
                if (areaCm2 < minArea)
                {
                    // 任务 CW：面积门槛丢掉的分量也要暴露（否则 0 斑块看起来像「没穿出」）。
                    pr.DroppedComponents++;
                    pr.DroppedTotalAreaCm2 += areaCm2;
                    if (areaCm2 > pr.DroppedMaxAreaCm2) pr.DroppedMaxAreaCm2 = areaCm2;
                    float dmx = float.MinValue;
                    for (int i = 0; i < verts.Count; i++) { float mm = dmm[verts[i]]; if (mm > dmx) dmx = mm; }
                    if (dmx != float.MinValue && dmx > pr.DroppedMaxDepthMm) pr.DroppedMaxDepthMm = dmx;
                    continue;
                }
                var patch = new PokePatch();
                patch.AreaCm2 = areaCm2;
                patch.Verts = verts.Count;
                float mn = float.MaxValue, mx = float.MinValue, sum = 0f;
                Vector3 wc = Vector3.zero, wn = Vector3.zero;
                var regionCount = new Dictionary<string, int>(StringComparer.Ordinal);
                for (int i = 0; i < verts.Count; i++)
                {
                    int vi = verts[i];
                    float mm = dmm[vi];
                    if (mm < mn) mn = mm;
                    if (mm > mx) mx = mm;
                    sum += mm;
                    wc += bi.Pos[vi];
                    Vector3 closest; float d2; int feature;
                    int f = g.Bvh.Nearest(bi.Pos[vi], out closest, out d2, out feature);
                    if (f >= 0) wn += PokeFeatureNormal(g, f, feature);
                    PokeInc(regionCount, bi.Region[vi]);
                }
                wc /= verts.Count;
                patch.MinDepthMm = mn;
                patch.MaxDepthMm = mx;
                patch.AvgDepthMm = sum / verts.Count;
                patch.WorldCentroid = wc;
                patch.WorldNormal = wn.sqrMagnitude > 1e-12f ? wn.normalized : Vector3.up;
                string majRegion = null; int majCount = -1;
                foreach (var rc in regionCount) if (rc.Value > majCount) { majCount = rc.Value; majRegion = rc.Key; }
                patch.Region = majRegion;
                patch.SubPart = PokeSubPart(majRegion, wc, anim);
                Transform anchor = RegionAnchor(majRegion, boneMap, bi.Smr.transform, anchorCache);
                patch.AnchorLocal = anchor != null ? anchor.InverseTransformPoint(wc) : wc;
                // 任务 CI：≤20 个样本顶点的外壳/射线证据（确定性等距抽样，两遍逐位相同）。
                if (p.Diag)
                {
                    patch.Diag = new List<PokeDiagVert>();
                    int take = Math.Min(20, verts.Count);
                    for (int s = 0; s < take; s++)
                    {
                        int idx = take <= 1 ? 0 : (int)((long)s * (verts.Count - 1) / (take - 1));
                        int vi = verts[idx];
                        var rec = new PokeDiagVert();
                        rec.World = bi.Pos[vi];
                        rec.Dmm = dmm[vi];
                        rec.Garment = g.Path;
                        rec.PseudoNormal = pnArr != null ? pnArr[vi] : Vector3.up;
                        rec.Opening = opening[vi];
                        Vector3 closest; float d2; int feature;
                        int f = g.Bvh.Nearest(bi.Pos[vi], out closest, out d2, out feature);
                        rec.Feature = feature;
                        rec.Face = f;
                        if (f >= 0)
                        {
                            if (g.ShellRay != null) rec.ShellRay = g.ShellRay[f];
                            if (g.ShellRayEnd != null) rec.ShellRayEnd = g.ShellRayEnd[f];
                            if (g.OutwardDot != null) rec.OutwardDot = g.OutwardDot[f];
                            if (g.Flipped != null) rec.Flipped = g.Flipped[f];
                            rec.ConeRescued = rec.ShellRay >= 1;
                        }
                        if (p.NormalSign == "parity")
                        {
                            int pv = PokeParityVote(bi.Pos[vi], mask, p.ShellRayM, p.RayBudget, g.Collider, ref raysUsed, ref budgetHit);
                            rec.ParityKnown = true;
                            rec.InsideByParity = pv > 0;
                            rec.ParityHits = pv > 0 ? pv : -pv;
                        }
                        patch.Diag.Add(rec);
                    }
                }
                pr.Patches.Add(patch);
            }
            pr.Patches.Sort((a, b) =>
            {
                int c = b.AreaCm2.CompareTo(a.AreaCm2);
                if (c != 0) return c;
                c = string.CompareOrdinal(a.Region, b.Region);
                if (c != 0) return c;
                c = a.AnchorLocal.x.CompareTo(b.AnchorLocal.x);
                if (c != 0) return c;
                return a.AnchorLocal.y.CompareTo(b.AnchorLocal.y);
            });
            if (pr.Patches.Count > p.MaxPatches) pr.Patches.RemoveRange(p.MaxPatches, pr.Patches.Count - p.MaxPatches);

            // 任务 CW：逐 sub_part 自检「有顶点超阈值却没凑成斑块」，结果同时供 run 级汇总。
            pr.SuspectSubthreshold = false;
            foreach (var kv in pr.SubPartDepthMm)
            {
                int spc = 0;
                string sp = kv.Key == null ? "other" : kv.Key;
                for (int i = 0; i < pr.Patches.Count; i++)
                    if ((pr.Patches[i].SubPart ?? "other") == sp) spc++;
                int outside = 0; float mx = float.MinValue;
                for (int i = 0; i < kv.Value.Count; i++)
                {
                    float mm = kv.Value[i];
                    if (mm > 0f) outside++;
                    if (mm > mx) mx = mm;
                }
                if (mx == float.MinValue) mx = 0f;
                if (PokeSuspectSubthreshold(outside, mx, PokeSubPartTauMm(sp, p), spc))
                {
                    pr.SuspectSubthreshold = true;
                    break;
                }
            }
        }

        private static Vector3 PokeFeatureNormal(PokeGarment g, int f, int feature)
        {
            if (feature == 0) return g.OrientedNrm[f];
            int a = g.Tris[3 * f], b = g.Tris[3 * f + 1], c = g.Tris[3 * f + 2];
            if (feature == 4) return PokeV(g, a);
            if (feature == 5) return PokeV(g, b);
            if (feature == 6) return PokeV(g, c);
            int e0, e1;
            if (feature == 1) { e0 = a; e1 = b; }
            else if (feature == 2) { e0 = b; e1 = c; }
            else { e0 = c; e1 = a; }
            int lo = e0 < e1 ? e0 : e1, hi = e0 < e1 ? e1 : e0;
            long key = ((long)lo << 32) | (uint)hi;
            Vector3 s;
            if (g.EdgeNormal.TryGetValue(key, out s) && s.sqrMagnitude > 1e-12f) return s.normalized;
            return g.OrientedNrm[f];
        }

        private static Vector3 PokeV(PokeGarment g, int vi)
        {
            if (g.VertexPseudo != null && vi >= 0 && vi < g.VertexPseudo.Length && g.VertexPseudo[vi].sqrMagnitude > 1e-12f)
                return g.VertexPseudo[vi];
            return Vector3.up;
        }

        // ── 任务 CI：诊断辅助 + 奇偶投票定号 ───────────────────────────

        internal static string PokeFeatureKind(int feature)
        {
            if (feature == 0) return "face";
            if (feature >= 4) return "vertex";
            return "edge";
        }

        internal static string PokeShellRayKind(int k)
        {
            if (k < 0) return "none";
            return k == 0 ? "outward" : "cone" + k;
        }

        /// <summary>
        /// 任务 CI：3 轴射线奇偶投票聚合（纯函数，离线 selftest 断言）。每轴命中数为奇数表示该轴
        /// 的射线在闭合件内「进—出—…—出」净跨越数为奇 → 视为在件内。返回 +n=多数轴判在内部（n=2,3），
        /// -(3-n)=多数轴判在外部（n=0,1），符号即内外、绝对值即一致轴数。
        /// </summary>
        internal static int PokeParityFromHitCounts(int hx, int hy, int hz)
        {
            int inside = 0;
            if ((hx & 1) == 1) inside++;
            if ((hy & 1) == 1) inside++;
            if ((hz & 1) == 1) inside++;
            if (inside >= 2) return inside;
            return -(3 - inside);
        }

        /// <summary>任务 CI：对世界点做 3 轴（+X/+Y/+Z）射线奇偶投票，返回同 PokeParityFromHitCounts。
        /// 每条轴 1 次 RaycastAll，共 3 条（只在 normal_sign=parity 或 diag 时调用，代价见 审查/docs/probe-poke-diag.md，原 README §3.2.5.1）。
        /// <paramref name="only"/> 非空时只数该 collider 的命中——奇偶必须相对**本件**闭合面，不能把
        /// 同层的其它衣物算进来（多个衣物叠穿时否则内外无定义）。</summary>
        internal static int PokeParityVote(Vector3 pos, int mask, float maxDist, long rayBudget, Collider only,
            ref long raysUsed, ref bool budgetHit)
        {
            float dist = Mathf.Max(maxDist, 3f);
            int hx = PokeRayHitCount(pos, Vector3.right, dist, mask, only, rayBudget, ref raysUsed, ref budgetHit);
            int hy = PokeRayHitCount(pos, Vector3.up, dist, mask, only, rayBudget, ref raysUsed, ref budgetHit);
            int hz = PokeRayHitCount(pos, Vector3.forward, dist, mask, only, rayBudget, ref raysUsed, ref budgetHit);
            return PokeParityFromHitCounts(hx, hy, hz);
        }

        private static int PokeRayHitCount(Vector3 origin, Vector3 dir, float maxDist, int mask, Collider only,
            long rayBudget, ref long raysUsed, ref bool budgetHit)
        {
            if (raysUsed >= rayBudget) { budgetHit = true; return 0; }
            raysUsed++;
            RaycastHit[] hs = Physics.RaycastAll(origin, dir, maxDist, mask, QueryTriggerInteraction.Ignore);
            if (hs == null || hs.Length == 0) return 0;
            if (only == null) return hs.Length;
            int c = 0;
            for (int i = 0; i < hs.Length; i++) if (hs[i].collider == only) c++;
            return c;
        }

        private static float PokeTau(string region, PokeParams p)
        {
            if (region == "Hips" || region == "Spine" || region == "Chest" || region == "UpperChest") return p.TauTorsoMm;
            return p.TauLimbMm;
        }

        /// <summary>任务 CW：sub_part 对应的 tau（脚/手是四肢，躯干四区是躯干；其余按四肢）。
        /// 用于「有顶点超阈值却没凑成斑块」的自检，口径与 PokeTau 同源。</summary>
        private static double PokeSubPartTauMm(string subPart, PokeParams p)
        {
            if (subPart == null) return p.TauLimbMm;
            switch (subPart.ToLowerInvariant())
            {
                case "hips": case "spine": case "chest": case "upperchest":
                    return p.TauTorsoMm;
                default:
                    return p.TauLimbMm;
            }
        }

        /// <summary>任务 CW / 口径修正任务 CX：被测区每顶点面积份额（cm²/顶点）。
        /// 分子 = 三顶点「都在被测区且都可用」的身体三角形面积和（cm²）；
        /// 分母 = 被测区里「可用」的身体顶点数（等价于把每个三角形的面积按 3 个顶点均分后，
        /// 再对区内顶点求平均）。**与被测斑块的面积累加口径完全一致**（斑块也只累加三顶点全可用的三角形），
        /// 否则门槛与它要过滤的量不可比。
        /// 任务 CX 修：① 传入 `usable`，把 NaNimation 删除 / 权重 0 / 非有限 / 拉远 3 m 的顶点排除——
        /// 这些顶点在烘焙网格里位置不可信（被移走），旧口径把它们算进分子会虚高几个数量级，且随形态键摆动；
        /// ② 生产调用传 bind pose 的稳定参考位置（RestPos），不再用当前形变后的位置——否则「每顶点面积」
        /// 会跟着 Foot/Toe 这类收缩键一起塌，候选之间能差 11 倍。`usable == null` 表示不过滤，仅供纯自检。</summary>
        internal static float PokeAreaPerVertCm2(Vector3[] pos, int[] tris, bool[] inRegion, bool[] usable,
            out int regionVerts, out float regionAreaCm2)
        {
            regionVerts = 0;
            regionAreaCm2 = 0f;
            int n = pos != null ? pos.Length : 0;
            if (n == 0 || inRegion == null) return 0f;
            for (int i = 0; i < n; i++)
                if (inRegion[i] && (usable == null || usable[i])) regionVerts++;
            if (tris != null)
            {
                for (int t = 0; t + 2 < tris.Length; t += 3)
                {
                    int a = tris[t], b = tris[t + 1], c = tris[t + 2];
                    if (a < 0 || b < 0 || c < 0 || a >= n || b >= n || c >= n) continue;
                    if (!inRegion[a] || !inRegion[b] || !inRegion[c]) continue;
                    if (usable != null && (!usable[a] || !usable[b] || !usable[c])) continue;
                    regionAreaCm2 += Vector3.Cross(pos[b] - pos[a], pos[c] - pos[a]).magnitude * 0.5f * 10000f;
                }
            }
            return regionVerts > 0 ? regionAreaCm2 / regionVerts : 0f;
        }

        /// <summary>任务 CW：把「面积门槛」解析成一个数。
        /// 优先级：请求显式覆盖（source=request）&gt; min_patch_rule=legacy（固定 0.5）&gt;
        /// adaptive = max(absolute_floor, min_verts_for_patch × area_per_vert_cm2)。</summary>
        internal static float PokeResolveMinPatchArea(bool minAreaExplicit, float requestedMinAreaCm2,
            string rule, float absoluteFloorCm2, int minVertsForPatch, float areaPerVertCm2, out string source)
        {
            if (minAreaExplicit)
            {
                source = "request";
                return requestedMinAreaCm2 < 0f ? 0f : requestedMinAreaCm2;
            }
            if (string.Equals(rule, "legacy", StringComparison.OrdinalIgnoreCase))
            {
                source = "legacy";
                return 0.5f;
            }
            source = "adaptive";
            float adaptive = minVertsForPatch * areaPerVertCm2;
            return adaptive > absoluteFloorCm2 ? adaptive : absoluteFloorCm2;
        }

        /// <summary>任务 CW：自检——某个 sub_part 明明有顶点超阈值，却一个斑块都没凑出来。
        /// 多半是面积门槛太高，或 opening / NaNimation 删点把连通性切断了。</summary>
        internal static bool PokeSuspectSubthreshold(int outside, double maxMm, double tauMm, int patchCount)
        {
            return outside > 0 && maxMm > tauMm && patchCount == 0;
        }

        private static string PokeSubPart(string region, Vector3 worldPos, Animator anim)
        {
            if (string.IsNullOrEmpty(region)) return "other";
            if (region.IndexOf("Toe", StringComparison.OrdinalIgnoreCase) >= 0) return "toe";
            if (region.IndexOf("Foot", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                Transform foot = null, toes = null;
                bool left = region.IndexOf("Left", StringComparison.OrdinalIgnoreCase) >= 0;
                try
                {
                    foot = anim != null ? anim.GetBoneTransform(left ? HumanBodyBones.LeftFoot : HumanBodyBones.RightFoot) : null;
                    toes = anim != null ? anim.GetBoneTransform(left ? HumanBodyBones.LeftToes : HumanBodyBones.RightToes) : null;
                }
                catch { }
                if (foot != null && toes != null)
                {
                    Vector3 fwd = toes.position - foot.position;
                    float len2 = fwd.sqrMagnitude;
                    if (len2 > 1e-9f)
                    {
                        float t = Vector3.Dot(worldPos - foot.position, fwd) / len2;
                        if (t > 0.55f) return "ball";
                        if (t < 0.15f) return "ankle";
                        return "arch";
                    }
                }
                return "foot";
            }
            if (IsHandRegion(region)) return "hand";
            return region.ToLowerInvariant();
        }

        private static string PokeCoarsePart(string region)
        {
            if (string.IsNullOrEmpty(region)) return "other";
            if (IsFootRegion(region)) return "foot";
            if (IsHandRegion(region)) return "hand";
            return region;
        }

        private static int PokeFind(int[] uf, int x)
        {
            while (uf[x] != x) { uf[x] = uf[uf[x]]; x = uf[x]; }
            return x;
        }

        private static void PokeUnion(int[] uf, int a, int b)
        {
            int ra = PokeFind(uf, a), rb = PokeFind(uf, b);
            if (ra == rb) return;
            if (ra < rb) uf[rb] = ra; else uf[ra] = rb;   // 取小根保证确定性
        }

        private static void PokeInc(Dictionary<string, int> d, string k)
        {
            if (k == null) k = "Other";
            int v;
            d.TryGetValue(k, out v);
            d[k] = v + 1;
        }

        // ── 参考列（containment）────────────────────────────────────────

        private static void PokeFillReference(PokePairResult pr, JsonObject containment)
        {
            if (containment == null || pr.G == null) return;
            List<object> pairs = AuditJson.Arr(containment, "pairs");
            if (pairs == null) return;
            for (int i = 0; i < pairs.Count; i++)
            {
                var po = pairs[i] as JsonObject;
                if (po == null) continue;
                string garment = AuditJson.Str(po, "garment", null);
                if (garment == null) continue;
                if (garment != pr.G.Path && garment != pr.G.Name) continue;
                pr.HasRef = true;
                pr.RefVerts = AuditJson.Int(po, "verts", 0);
                pr.RefInside = AuditJson.Int(po, "inside", 0);
                pr.RefEdges = AuditJson.Int(po, "edges", 0);
                pr.RefCrossing = AuditJson.Int(po, "crossing_edges", 0);
                List<object> br = AuditJson.Arr(po, "by_region");
                float mx = 0f;
                if (br != null)
                    for (int k = 0; k < br.Count; k++)
                    {
                        var ro = br[k] as JsonObject;
                        if (ro == null) continue;
                        float m = (float)AuditJson.Num(ro, "max_crossing_depth_mm", 0);
                        if (m > mx) mx = m;
                    }
                pr.RefMaxCrossingMm = mx;
                return;
            }
        }

        // ── 输出 ────────────────────────────────────────────────────────

        private static JsonObject PokePairJson(PokePairResult pr, PokeParams p)
        {
            var o = new JsonObject();
            o.Set("garment", pr.G != null ? pr.G.Path : (pr.Spec != null ? pr.Spec.Garment : null));
            o.Set("garment_name", pr.G != null ? pr.G.Name : null);
            o.Set("pair_source", pr.PairSource);
            o.Set("pair_confidence", pr.PairConfidence);
            o.Set("pair_reason", pr.PairReason);
            o.Set("bbox_overlap", pr.BboxOverlap);
            o.Set("covers_regions", new List<object>(pr.Regions.ToArray()));
            o.Set("mesh_vertices", pr.MeshVertices);
            o.Set("mesh_triangles", pr.MeshTriangles);
            o.Set("shell_faces", pr.ShellFaces);
            o.Set("normals_flipped", pr.FlippedFaces);
            o.Set("normals_flipped_ratio", pr.MeshTriangles > 0 ? (double)((float)pr.FlippedFaces / pr.MeshTriangles) : 0.0);
            // 任务 CI：外壳判定规则与「靠锥向射线救回」统计——判断上衣假阳性的核心证据。
            o.Set("shell_rule", p != null ? p.ShellRule : "any");
            o.Set("shell_majority_min", p != null ? p.ShellMajorityMin : 3);
            o.Set("normal_sign", p != null ? p.NormalSign : "parity");
            o.Set("shell_outward_escaped", pr.ShellOutwardEscaped);
            o.Set("shell_rescued_by_cone", pr.ShellConeRescued);
            o.Set("shell_rescued_ratio", pr.ShellFaces > 0
                ? (double)((float)pr.ShellConeRescued / pr.ShellFaces) : 0.0);
            o.Set("opening_verts", pr.OpeningVerts);
            o.Set("opening_deep_verts", pr.OpeningDeepVerts);
            // 任务 CW：面积门槛的推导依据 + 被门槛丢掉的分量（永远输出，缺失=本次配对没算）。
            o.Set("area_per_vert_cm2", (double)pr.AreaPerVertCm2);
            // 任务 CX：这份每顶点面积用的是 bind pose 稳定参考还是烘焙位置（回落）。
            o.Set("area_per_vert_pos_source", pr.AreaPerVertPosSource);
            o.Set("region_verts", pr.RegionVerts);
            o.Set("region_area_cm2", (double)pr.RegionAreaCm2);
            o.Set("min_patch_area_cm2", (double)pr.MinPatchAreaCm2);
            o.Set("min_patch_area_source", pr.MinPatchAreaSource);
            o.Set("dropped_components", pr.DroppedComponents);
            o.Set("dropped_max_area_cm2", (double)pr.DroppedMaxAreaCm2);
            o.Set("dropped_total_area_cm2", (double)pr.DroppedTotalAreaCm2);
            o.Set("dropped_max_depth_mm", (double)pr.DroppedMaxDepthMm);

            var allD = new List<float>();
            foreach (var kv in pr.RegionDepthMm) allD.AddRange(kv.Value);
            o.Set("d_v_mm", PokeDist(allD));

            // 任务 BZ（R9）：鞋底有向距离 sd 与跟隙。正=脚在鞋底上方，负=穿出鞋底。
            o.Set("sd_mm", PokeSignedDist(pr.SdMm));
            o.Set("heel_gap_sole_mm", PokeSignedDist(pr.HeelGapSoleMm));   // 旧口径，诊断用
            var sdMeta = new JsonObject();
            sdMeta.Set("method", "脚部 covers 内「朝下」的身体顶点（烘焙世界法线 · 世界向下 ≥ sd_down_cos，"
                + "读不到法线则不限）到最近「朝下壳面（外底）」的有向距离，正=脚在外底上方、负=穿出外底。"
                + "注意：这是到「外底」的距离，半抬脚跟时前掌陷进鞋底实体、离外底反而近（v1 的盲点），"
                + "排序已改用下面的 si/tilt（见 审查/docs/foot-shoe-candidates-metrics.md，原 README §3.4）。");
            sdMeta.Set("foot_verts", pr.SdFootVerts);
            sdMeta.Set("sole_facing_verts", pr.SdSoleFacingVerts);
            o.Set("sd_meta", sdMeta);

            // 任务 CF（R9 v2）：鞋垫面有向距离 si、跟隙（到鞋垫面）与脚底/鞋垫倾角。
            o.Set("si_mm", PokeSignedDist(pr.SiMm));
            o.Set("heel_gap_mm", PokeSignedDist(pr.HeelSiMm));
            var siMeta = new JsonObject();
            siMeta.Set("method", "脚部 covers 内「朝下」的身体顶点到最近「鞋垫面」（朝上、在脚部包围盒内、"
                + "高出朝下外底 " + AuditUtil.F(p.InsoleSoleMinMm) + "–" + AuditUtil.F(p.InsoleSoleMaxMm)
                + " mm 的三角形，不要求是外壳）的有向距离 si，正=悬空、负=陷入鞋垫；"
                + "跟隙 = 同一批里 sub_part=ankle（Foot→Toes t<0.15，脚跟段）的 si p50。");
            siMeta.Set("insole_faces", pr.InsoleFaces);
            siMeta.Set("foot_down_verts", pr.SiFootVerts);
            siMeta.Set("insole_up_cos", (double)p.InsoleUpCos);
            siMeta.Set("bbox_margin_mm", (double)p.InsoleBboxMarginMm);
            siMeta.Set("tilt_method", "脚底朝下顶点最小二乘拟合平面与鞋垫面质心拟合平面的夹角；"
                + "拟合用世界 y = a·x + b·z + c（假定站立），平底鞋应接近 0。");
            siMeta.Set("tilt_foot_verts", pr.TiltFootVerts);
            siMeta.Set("tilt_insole_faces", pr.TiltInsoleFaces);
            o.Set("si_meta", siMeta);
            o.Set("tilt_deg", pr.TiltDeg.HasValue ? (object)(double)pr.TiltDeg.Value : null);
            o.Set("foot_plane_tilt_deg", pr.FootPlaneTiltDeg.HasValue ? (object)(double)pr.FootPlaneTiltDeg.Value : null);
            o.Set("insole_plane_tilt_deg", pr.InsolePlaneTiltDeg.HasValue ? (object)(double)pr.InsolePlaneTiltDeg.Value : null);

            var regArr = new List<object>();
            var regNames = new List<string>(pr.RegionTotal.Keys);
            regNames.Sort(StringComparer.Ordinal);
            for (int i = 0; i < regNames.Count; i++)
            {
                string rn = regNames[i];
                var ro = new JsonObject();
                ro.Set("region", rn);
                ro.Set("coarse_part", PokeCoarsePart(rn));
                ro.Set("body_region_verts_total", PokeGet(pr.RegionTotal, rn));
                var ex = new JsonObject();
                ex.Set("nan", PokeGet(pr.RegionExNan, rn));
                ex.Set("deleted", PokeGet(pr.RegionExDel, rn));
                ex.Set("deleted_nanimated", PokeGet(pr.RegionExDelNani, rn));
                ex.Set("deleted_zero_weight", PokeGet(pr.RegionExDelZero, rn));
                ex.Set("beyond_3m", PokeGet(pr.RegionExFar, rn));
                ex.Set("total", PokeGet(pr.RegionExNan, rn) + PokeGet(pr.RegionExDel, rn) + PokeGet(pr.RegionExFar, rn));
                ro.Set("excluded", ex);
                List<float> dl;
                pr.RegionDepthMm.TryGetValue(rn, out dl);
                ro.Set("d_v_mm", PokeDist(dl));
                ro.Set("opening", PokeGet(pr.RegionOpening, rn));
                ro.Set("opening_deep", PokeGet(pr.RegionOpeningDeep, rn));
                int pc = 0; float pa = 0f;
                for (int k = 0; k < pr.Patches.Count; k++)
                    if (pr.Patches[k].Region == rn) { pc++; pa += pr.Patches[k].AreaCm2; }
                ro.Set("patch_count", pc);
                ro.Set("total_patch_area_cm2", (double)pa);
                regArr.Add(ro);
            }
            o.Set("by_region", regArr);

            var subArr = new List<object>();
            var subNames = new List<string>(pr.SubPartDepthMm.Keys);
            subNames.Sort(StringComparer.Ordinal);
            // 任务 CW：每个 sub_part 的斑块数（按斑块归属的 sub_part 计），供「超阈值却没斑块」自检。
            var subPatchCount = new Dictionary<string, int>(StringComparer.Ordinal);
            var subPatchArea = new Dictionary<string, double>(StringComparer.Ordinal);
            for (int i = 0; i < pr.Patches.Count; i++)
            {
                string sk = pr.Patches[i].SubPart;
                if (sk == null) sk = "other";
                int c; subPatchCount.TryGetValue(sk, out c); subPatchCount[sk] = c + 1;
                double a; subPatchArea.TryGetValue(sk, out a); subPatchArea[sk] = a + pr.Patches[i].AreaCm2;
            }
            bool anySuspect = false;
            for (int i = 0; i < subNames.Count; i++)
            {
                var so = new JsonObject();
                string sp = subNames[i];
                so.Set("sub_part", sp);
                JsonObject dv = PokeDist(pr.SubPartDepthMm[sp]);
                so.Set("d_v_mm", dv);
                so.Set("opening", PokeGet(pr.SubPartOpening, sp));
                int spc; subPatchCount.TryGetValue(sp, out spc);
                double spa; subPatchArea.TryGetValue(sp, out spa);
                so.Set("patch_count", spc);
                so.Set("total_patch_area_cm2", spa);
                double tauSub = PokeSubPartTauMm(sp, p);
                bool suspect = PokeSuspectSubthreshold(AuditJson.Int(dv, "outside", 0),
                    AuditJson.Num(dv, "max", 0), tauSub, spc);
                so.Set("suspect_subthreshold", suspect);
                if (suspect)
                {
                    anySuspect = true;
                    so.Set("suspect_reason", "有顶点超阈值（outside=" + AuditJson.Int(dv, "outside", 0)
                        + "、max=" + AuditUtil.F((float)AuditJson.Num(dv, "max", 0)) + " mm > tau="
                        + AuditUtil.F((float)tauSub) + " mm）但 patch_count=0，没能凑成斑块；"
                        + "多半是面积门槛（min_patch_area_cm2=" + AuditUtil.F(pr.MinPatchAreaCm2)
                        + "，来源 " + pr.MinPatchAreaSource + "）太高，或被 opening/NaNimation 删点切断了连通"
                        + "（本次 dropped_components=" + pr.DroppedComponents + "，dropped_max_depth_mm="
                        + AuditUtil.F(pr.DroppedMaxDepthMm) + "）。");
                }
                subArr.Add(so);
            }
            o.Set("by_sub_part", subArr);
            o.Set("suspect_subthreshold", anySuspect);
            pr.SuspectSubthreshold = anySuspect;

            var patchArr = new List<object>();
            for (int i = 0; i < pr.Patches.Count; i++) patchArr.Add(PokePatchJson(pr.Patches[i]));
            o.Set("patches", patchArr);
            o.Set("patch_count", pr.Patches.Count);
            o.Set("total_patch_area_cm2", (double)pr.TotalAreaCm2ForOutput());

            var refo = new JsonObject();
            refo.Set("source", pr.HasRef ? "containment" : null);
            refo.Set("verts", pr.HasRef ? (object)pr.RefVerts : null);
            refo.Set("inside", pr.HasRef ? (object)pr.RefInside : null);
            refo.Set("inside_ratio", pr.HasRef && pr.RefVerts > 0 ? (object)((double)pr.RefInside / pr.RefVerts) : null);
            refo.Set("edges", pr.HasRef ? (object)pr.RefEdges : null);
            refo.Set("crossing_edges", pr.HasRef ? (object)pr.RefCrossing : null);
            refo.Set("crossing_ratio", pr.HasRef && pr.RefEdges > 0 ? (object)((double)pr.RefCrossing / pr.RefEdges) : null);
            refo.Set("max_crossing_depth_mm", pr.HasRef ? (object)(double)pr.RefMaxCrossingMm : null);
            refo.Set("note", "参考列，不参与判定；本次 " + (pr.HasRef ? "已内嵌" : "未内嵌")
                + "（poke_reference=true 才内嵌既有 containment 探针的同配对读数）。");
            o.Set("reference", refo);
            return o;
        }

        private static JsonObject PokePatchJson(PokePatch patch)
        {
            var o = new JsonObject();
            o.Set("area_cm2", (double)patch.AreaCm2);
            o.Set("max_depth_mm", (double)patch.MaxDepthMm);
            o.Set("avg_depth_mm", (double)patch.AvgDepthMm);
            o.Set("min_depth_mm", (double)patch.MinDepthMm);
            o.Set("verts", patch.Verts);
            o.Set("region", patch.Region);
            o.Set("sub_part", patch.SubPart);
            var loc = new JsonObject();
            loc.Set("x", (double)patch.AnchorLocal.x);
            loc.Set("y", (double)patch.AnchorLocal.y);
            loc.Set("z", (double)patch.AnchorLocal.z);
            o.Set("anchor_local_centroid", loc);
            o.Set("cams", PokeCams(patch));
            if (patch.Diag != null)
            {
                var das = new List<object>();
                for (int i = 0; i < patch.Diag.Count; i++) das.Add(PokeDiagJson(patch.Diag[i]));
                o.Set("diag", das);
            }
            return o;
        }

        /// <summary>任务 CI：单个样本顶点的诊断记录序列化。</summary>
        private static JsonObject PokeDiagJson(PokeDiagVert r)
        {
            var o = new JsonObject();
            o.Set("world", Vec(r.World));
            o.Set("d_v_mm", (double)r.Dmm);
            o.Set("nearest_feature", PokeFeatureKind(r.Feature));
            o.Set("nearest_feature_code", r.Feature);
            o.Set("nearest_face", r.Face);
            o.Set("garment", r.Garment);
            o.Set("tri_index", r.Face);
            o.Set("shell_ray", r.ShellRay);
            o.Set("shell_ray_kind", PokeShellRayKind(r.ShellRay));
            o.Set("shell_ray_end", Vec(r.ShellRayEnd));
            o.Set("winding_dot_outward", (double)r.OutwardDot);
            o.Set("normals_flipped", r.Flipped);
            o.Set("nearest_face_cone_rescued", r.ConeRescued);
            o.Set("opening", r.Opening);
            o.Set("pseudo_normal", Vec(r.PseudoNormal));
            if (r.ParityKnown)
            {
                o.Set("inside_by_parity", r.InsideByParity);
                o.Set("parity_agree_axes", r.ParityHits);
            }
            return o;
        }

        private static List<object> PokeCams(PokePatch patch)
        {
            var l = new List<object>();
            Vector3 n = patch.WorldNormal;
            if (n.sqrMagnitude < 1e-12f) n = Vector3.up;
            n.Normalize();
            Vector3 t1, t2;
            PokeBasis(n, out t1, out t2);
            float dist = 0.35f;

            var c1 = new JsonObject();
            Vector3 p1 = patch.WorldCentroid + n * dist;
            c1.Set("id", "normal_back");
            c1.Set("pos", Vec(p1));
            c1.Set("look_at", Vec(patch.WorldCentroid));
            c1.Set("dist_m", (double)dist);
            c1.Set("fov", 30.0);
            l.Add(c1);

            var c2 = new JsonObject();
            Vector3 d2 = (n + t1 * 0.7f + t2 * 0.3f).normalized;
            Vector3 p2 = patch.WorldCentroid + d2 * dist;
            c2.Set("id", "three_quarter");
            c2.Set("pos", Vec(p2));
            c2.Set("look_at", Vec(patch.WorldCentroid));
            c2.Set("dist_m", (double)dist);
            c2.Set("fov", 30.0);
            l.Add(c2);
            return l;
        }

        private static JsonObject PokeDist(List<float> vals)
        {
            var o = new JsonObject();
            int n = vals != null ? vals.Count : 0;
            o.Set("count", n);
            if (n == 0)
            {
                o.Set("p50", null); o.Set("p95", null); o.Set("p99", null);
                o.Set("max", null); o.Set("min", null); o.Set("mean", null);
                o.Set("outside", 0);
                return o;
            }
            var c = new List<float>(vals);
            c.Sort();
            float sum = 0f; int outside = 0;
            for (int i = 0; i < c.Count; i++) { sum += c[i]; if (c[i] > 0f) outside++; }
            o.Set("p50", (double)PokePctlSorted(c, 50f));
            o.Set("p95", (double)PokePctlSorted(c, 95f));
            o.Set("p99", (double)PokePctlSorted(c, 99f));
            o.Set("max", (double)c[c.Count - 1]);
            o.Set("min", (double)c[0]);
            o.Set("mean", (double)(sum / c.Count));
            o.Set("outside", outside);
            return o;
        }

        /// <summary>
        /// 任务 BZ：有向距离分布（sd / 跟隙用）。比 PokeDist 多 p05 与 negative_count（sd&lt;0 = 穿出鞋底）。
        /// </summary>
        private static JsonObject PokeSignedDist(List<float> vals)
        {
            var o = new JsonObject();
            int n = vals != null ? vals.Count : 0;
            o.Set("count", n);
            if (n == 0)
            {
                o.Set("p05", null); o.Set("p50", null); o.Set("p95", null);
                o.Set("min", null); o.Set("max", null); o.Set("mean", null);
                o.Set("negative_count", 0);
                return o;
            }
            var c = new List<float>(vals);
            c.Sort();
            float sum = 0f; int neg = 0;
            for (int i = 0; i < c.Count; i++) { sum += c[i]; if (c[i] < 0f) neg++; }
            o.Set("p05", (double)PokePctlSorted(c, 5f));
            o.Set("p50", (double)PokePctlSorted(c, 50f));
            o.Set("p95", (double)PokePctlSorted(c, 95f));
            o.Set("min", (double)c[0]);
            o.Set("max", (double)c[c.Count - 1]);
            o.Set("mean", (double)(sum / c.Count));
            o.Set("negative_count", neg);
            return o;
        }

        private static float PokePctlSorted(List<float> c, float pct)
        {
            if (c.Count == 0) return 0f;
            if (c.Count == 1) return c[0];
            float idx = (pct / 100f) * (c.Count - 1);
            int lo = Mathf.FloorToInt(idx), hi = Mathf.CeilToInt(idx);
            if (lo < 0) lo = 0;
            if (hi >= c.Count) hi = c.Count - 1;
            float t = idx - lo;
            return c[lo] * (1f - t) + c[hi] * t;
        }

        private static int PokeGet(Dictionary<string, int> d, string k)
        {
            int v;
            return d.TryGetValue(k, out v) ? v : 0;
        }

        // ════════════════════════════════════════════════════════════════
        // 探针 6：shrink_cover —— 收缩键遮挡一致性（T-33，任务 CS；名单口径任务 CT 修；诊断任务 CV 加）
        //
        // poke 只回答「身体有没有穿出衣服」；本探针回答「衣服不在时，身体上这些收缩形态键还开着没有」。
        // 作者 2026-09-20 报的「工程B Milfy 关袜子/关鞋袜/关鞋子时脚的收起形态键仍=100、塌脚踝」，
        // 正是「收缩键的影响顶点没有被任何可见服装盖住」。
        //
        // 判据（阈值都可被请求 shrink_cover 对象覆盖）：
        //   · keys：字符串数组；特殊值 "auto_nonzero" = 当前权重 > min_weight(默认 1) 的全部键，
        //     再按 keys_exclude_regex（默认 "(?i)^(vrc\.|eye|mouth|brow|blink|tongue|face|extra_)"）剔表情键。
        //   · 每个键 K 的影响顶点 A(K)：该 blendshape 在 100% 时的 |delta|（取 frame 最后一帧、乘
        //     lossyScale 换世界尺度，再按该帧权重归一化）× 1000 ≥ eps_delta_mm（默认 0.5）。
        //   · 顶点当前世界位置取当前姿势的 BakeMesh（键已施加），直接复用 BuildBodyInfo（与 containment/poke 同一烘焙）。
        //   · 遮挡集合 = 可见 SMR − 身体家族（body 自己 + 同素体其它身体片）− garments_exclude。
        //     任务 CT：garments_exclude **只拿叶子 GameObject 名**、按「整名或分隔符切词完整匹配」
        //     （`(?i)^(...|ear)$`），不再拿路径/子串匹配（旧行为 `ear` 命中 `LopEarMine` 会排掉整套衣服）；
        //     身体家族用 ShrinkCoverRules.IsBodyLike 按归一词根/同父前缀排除（`Body_base` 之外还有 `Body`）。
        //   · 判定口径 cover_rule（任务 CU 改）：
        //       - "outward_ray"（默认）：每影响顶点取**身体外向伪法线** n（PokeAngleWeightedPseudo 角度加权，
        //         用 BakeMesh 世界法线翻正符号），从 v + n*origin_mm 沿 n 发 1 条、再绕两个切轴 ±cone_deg(默认 20°)
        //         发 4 条锥向射线，长度 cover_ray_mm(默认 50)。任一条打到遮挡集合里任一可见服装三角形 → 该顶点被遮住。
        //         归票 ray_vote：any（默认，≥1 条）/ majority（≥3 条）。旧的距离判据**不参与** verdict。
        //       - "distance"：旧口径 = 落在服装壳内（六方向奇偶，inside_check）或到其表面最近距离 ≤ cover_dist_mm(默认 3.0)。
        //       - "either"：射线或旧口径任一成立即算遮住。
        //     兼容别名：cover_rule 传 "any"/"majority" 等价于 outward_ray + 对应 ray_vote（任务书两处说法不一致，
        //     这里用 ray_vote 承载归票、cover_rule 承载口径，两个名字都认）。
        //   · 旧的距离结果保留成参考列：nearest_cover_dist_mm（到最近件距离）、covered_near_ratio（受影响顶点里
        //     最近距离 ≤ cover_dist_mm 的占比，不含壳内判定）；两者都不参与默认 verdict。
        //   · covered_by_ray_top = 外向射线命中的前 3 件（按被该件命中的顶点数降序）；covered_by_top = 旧距离口径的前 3 件。
        //   · verdict（任务 CX / B-T33b 改形状）= "uncovered" 当 verdict_rule 生效（默认 "or"：
        //     uncovered_ratio ≥ ratio_thr(默认 0.60) 或 uncovered_area_cm2 ≥ area_thr(默认 1.0) 任一达标；
        //     "and" = 旧行为，两者都要；"ratio_only" / "area_only" 各自单独判）。否则 "ok"；
        //     A(K) 少于 min_verts(默认 20) 记 "too_few_verts"（不判定）。
        //     每行另给 verdict_by：ratio / area / both / none，如实报告是哪一边达标。
        //     area_thr=1.0 的推导与「待 B-T33b 标定」状态见下方 calibration 文本。
        //   · 自检（任务 CT）： garments_used==0 / keys 为空 / 所有键都 uncovered / garments_used:considered<0.2
        //     → self_check.suspicious=true，所有行 verdict 改 "undecidable"（不给 uncovered），避免「判据被
        //     排除规则吃掉」被读成工程 100% 违规。
        //   · 诊断（任务 CV）：`diag`(默认 false) + `diag_keys`(默认 = keys_resolved，受 diag_max_keys 上限)
        //     时，顶层多出 `diagnostics`：对每个键输出 A(K) 的包围盒、按主骨/人形部位分组（含各组未遮挡数）、
        //     ≤ diag_samples 个等距抽样顶点（世界坐标 mm / |delta| mm / 身体外向法线 / 中轴+4 条锥向逐条
        //     hit-path-dist）、抽样命中按叶子件计数、以及 diag_eps_mm 扫描的计数。**只读证据**：不参与
        //     verdict、不改任何默认阈值；diag=false 时输出与旧版逐字节一致。
        //
        // ⚠ 标定状态（任务 CU）：旧的「最近距离 ≤ cover_dist_mm」判据已由 seq_t33_calib 证伪（3 mm 抓到正样本
        //   但 Shoulder 误报，10/25/40 mm 漏掉裸脚踝）——距离回答「附近有没有布」而非「我外面有没有布」。
        //   默认改用外向射线；cover_ray_mm 取 30–80 mm 结论应一致（待实跑复核）。ratio_thr / area_thr /
        //   eps_delta_mm / min_verts 仍沿用旧默认，尚未重标。
        // ⚠ 诊断状态（任务 CV）：seq_t33_calib2 实跑显示正样本（关袜 + 强开 Ankle）在 30/50/80 mm 三档
        //   都 verdict=ok，但 200/221 个 A(Ankle) 顶点被外向射线判「外面有布」、命中件几乎全是 Shoes
        //   （见 covered_by_ray_top）。是「数据与眼睛对不上」的候选：要么 A(Ankle) 大部分落在鞋帮以内
        //   （鞋确实在那些点外侧，判据没错），要么裸露的尖锥在鞋帮以上、外向射线够不到。先跑 diag 定性，
        //   再决定是否改判据——本轮不动 verdict。详见 审查/docs/probe-shrink-cover-output.md（原 README §3.2.8 诊断小节）。
        // ════════════════════════════════════════════════════════════════

        /// <summary>一次 shrink_cover 的共享运行态（衣物集合 + BVH + 身体烘焙 + 射线预算）。</summary>
        private sealed class ShrinkCoverCtx
        {
            public readonly List<PokeGarment> Garments = new List<PokeGarment>();
            public readonly List<Vector3> GMin = new List<Vector3>();
            public readonly List<Vector3> GMax = new List<Vector3>();
            public BodyMeshInfo Body;
            public float CoverDistM = 0.003f;
            public bool InsideCheck = true;
            public int Mask;
            public int MaxIter = MaxRayIterations;
            public int VotesThr = InsideVotesThreshold;
            public long RayBudget = 2000000L;
            public long RaysUsed;
            public bool Truncated;
            // ── 任务 CU：外向射线判据 ──
            public Vector3[] BodyPseudo;                  // 每顶点身体外向伪法线（角度加权；BakeMesh 法定向）
            public string CoverRule = "outward_ray";      // outward_ray（默认）/ distance（旧口径）/ either
            public string RayVote = "any";                // any（默认）/ majority（≥3 条）
            public float CoverRayM = 0.05f;               // cover_ray_mm
            public float ConeDeg = 20f;                   // cone_deg
            public float OriginM = 0f;                    // origin_mm
            public bool NeedShell;                        // 仅 distance/either 才做壳内奇偶（省时）
        }

        private static string ScStr(AuditContext ctx, string key, string def)
        {
            var o = ctx.O("shrink_cover");
            if (o != null && o.Has(key))
            {
                string v = AuditJson.Str(o, key, null);
                if (v != null) return v;
            }
            return ctx.S("shrink_cover_" + key, def);
        }

        private static double ScNum(AuditContext ctx, string key, double def)
        {
            var o = ctx.O("shrink_cover");
            if (o != null && o.Has(key)) return AuditJson.Num(o, key, def);
            return ctx.N("shrink_cover_" + key, def);
        }

        private static int ScInt(AuditContext ctx, string key, int def)
        {
            var o = ctx.O("shrink_cover");
            if (o != null && o.Has(key)) return AuditJson.Int(o, key, def);
            return ctx.I("shrink_cover_" + key, def);
        }

        private static bool ScBool(AuditContext ctx, string key, bool def)
        {
            var o = ctx.O("shrink_cover");
            if (o != null && o.Has(key)) return AuditJson.Bool(o, key, def);
            return ctx.B("shrink_cover_" + key, def);
        }

        private static List<string> ScList(AuditContext ctx, string key)
        {
            var res = new List<string>();
            var o = ctx.O("shrink_cover");
            List<object> arr = (o != null && o.Has(key)) ? AuditJson.Arr(o, key) : ctx.A("shrink_cover_" + key);
            for (int i = 0; arr != null && i < arr.Count; i++)
            {
                string s = arr[i] as string;
                if (s == null) s = Convert.ToString(arr[i], System.Globalization.CultureInfo.InvariantCulture);
                if (!string.IsNullOrEmpty(s)) res.Add(s.Trim());
            }
            return res;
        }

        /// <summary>任务 CV：读顶层数组参数（数字数组），空/非法回落 def。用于 diag_eps_mm。</summary>
        private static List<double> ScNumList(AuditContext ctx, string key, double[] def)
        {
            var res = new List<double>();
            var o = ctx.O("shrink_cover");
            List<object> arr = (o != null && o.Has(key)) ? AuditJson.Arr(o, key) : ctx.A("shrink_cover_" + key);
            for (int i = 0; arr != null && i < arr.Count; i++)
            {
                if (arr[i] == null) continue;
                double d;
                if (arr[i] is double) d = (double)arr[i];
                else if (!double.TryParse(Convert.ToString(arr[i], System.Globalization.CultureInfo.InvariantCulture),
                    System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d)) continue;
                if (d < 0) continue;
                res.Add(d);
            }
            if (res.Count == 0 && def != null)
                for (int i = 0; i < def.Length; i++) res.Add(def[i]);
            return res;
        }

        private static ProbeOut ShrinkCover(AuditContext ctx, GameObject avatar, Animator anim)
        {
            var o = new JsonObject();
            var r = new ProbeOut();
            r.Json = o;
            r.Hits = 0;
            if (ctx == null || avatar == null)
            {
                o.Set("error", "shrink_cover: ctx/avatar 为空。");
                return r;
            }

            // ── 参数（默认值取舍见文件头注释与 审查/docs/probe-shrink-cover.md（原 README §3.2.8）；任务 CU 默认改外向射线，标定见 calibration）──
            double minWeight = ScNum(ctx, "min_weight", 1.0);
            double epsDeltaMm = ScNum(ctx, "eps_delta_mm", 0.5);
            double coverDistMm = ScNum(ctx, "cover_dist_mm", 3.0);
            double coverRayMm = ScNum(ctx, "cover_ray_mm", 50.0);
            double coneDeg = ScNum(ctx, "cone_deg", 20.0);
            double originMm = ScNum(ctx, "origin_mm", 0.0);
            double ratioThr = ScNum(ctx, "ratio_thr", 0.60);
            // 任务 CX（B-T33b）：area_thr 旧值 2.0 是拍的。初值改为 1.0 cm²（推导与「待标定」状态见 calibration）。
            double areaThr = ScNum(ctx, "area_thr", ShrinkCoverRules.DefaultAreaThrCm2);
            int minVerts = ScInt(ctx, "min_verts", 20);
            int maxKeys = ScInt(ctx, "max_keys", 512);
            int maxIter = ScInt(ctx, "max_iter", MaxRayIterations);
            int votesThr = ScInt(ctx, "inside_votes_threshold", InsideVotesThreshold);
            int layer = ScInt(ctx, "layer", DefaultTempLayer);
            long rayBudget = (long)ScNum(ctx, "ray_budget", 2000000.0);
            bool insideCheck = ScBool(ctx, "inside_check", true);
            string shellRule = ScStr(ctx, "shell_rule", "any");
            string coverRule = ScStr(ctx, "cover_rule", "outward_ray");
            string rayVote = ScStr(ctx, "ray_vote", "any");
            // 任务 CX：verdict 判据形状（or 默认 / and 旧行为 / ratio_only / area_only）。
            string verdictRule = ShrinkCoverRules.NormalizeVerdictRule(ScStr(ctx, "verdict_rule", ShrinkCoverRules.VerdictRuleOr));
            string keysExcludeStr = ScStr(ctx, "keys_exclude_regex", DefaultShrinkKeysExcludeRegex);
            string garmentsExcludeStr = ScStr(ctx, "garments_exclude", DefaultShrinkGarmentsExcludeRegex);
            if (epsDeltaMm < 0) epsDeltaMm = 0.5;
            if (coverDistMm < 0) coverDistMm = 3.0;
            if (coverRayMm < 0) coverRayMm = 50.0;
            if (coverRayMm > 2000) coverRayMm = 2000.0;
            if (coneDeg < 0 || coneDeg > 80) coneDeg = 20.0;
            if (originMm < -50 || originMm > 50) originMm = 0.0;
            if (ratioThr < 0 || ratioThr > 1) ratioThr = 0.60;
            if (areaThr < 0) areaThr = ShrinkCoverRules.DefaultAreaThrCm2;
            if (minVerts < 0) minVerts = 20;
            if (maxKeys <= 0) maxKeys = 512;
            if (maxIter <= 0) maxIter = MaxRayIterations;
            if (votesThr <= 0 || votesThr > Directions.Length) votesThr = InsideVotesThreshold;
            if (layer < 0 || layer > 31) layer = DefaultTempLayer;
            if (rayBudget <= 0) rayBudget = 2000000L;
            shellRule = string.IsNullOrEmpty(shellRule) ? "any" : shellRule.Trim().ToLowerInvariant();
            if (shellRule != "any" && shellRule != "outward" && shellRule != "majority") shellRule = "any";
            coverRule = string.IsNullOrEmpty(coverRule) ? "outward_ray" : coverRule.Trim().ToLowerInvariant();
            rayVote = string.IsNullOrEmpty(rayVote) ? "any" : rayVote.Trim().ToLowerInvariant();
            // 任务书对 cover_rule 有两处说法：既当「口径选择」（outward_ray/distance/either）、又当「归票」
            // （any/majority）。这里 cover_rule 主收口径，ray_vote 收归票；cover_rule 传 any/majority 时
            // 当作别名（outward_ray + 对应 ray_vote），两个名字都能用。
            if (coverRule == "any") { coverRule = "outward_ray"; rayVote = "any"; }
            else if (coverRule == "majority") { coverRule = "outward_ray"; rayVote = "majority"; }
            if (coverRule != "outward_ray" && coverRule != "distance" && coverRule != "either") coverRule = "outward_ray";
            if (rayVote != "any" && rayVote != "majority") rayVote = "any";

            // ── 任务 CV：诊断开关（默认 false，输出与旧版逐字节一致；只读证据，不改 verdict / 默认阈值）──
            bool diag = ScBool(ctx, "diag", false);
            var diagKeysReq = ScList(ctx, "diag_keys");
            int diagSamples = ScInt(ctx, "diag_samples", 50);
            int diagMaxKeys = ScInt(ctx, "diag_max_keys", 4);
            var diagEpsList = ScNumList(ctx, "diag_eps_mm", new double[] { 0.5, 0.2, 0.1, 0.05 });
            long diagRayBudget = (long)ScNum(ctx, "diag_ray_budget", 500000.0);
            if (diagSamples < 1) diagSamples = 50;
            if (diagSamples > 500) diagSamples = 500;
            if (diagMaxKeys < 1) diagMaxKeys = 4;
            if (diagRayBudget <= 0) diagRayBudget = 500000L;

            o.Set("method", "收缩键遮挡一致性（T-33，任务 CU 外向射线）：对每个收缩形态键 K 取「100% 时 |delta| ≥ eps_delta_mm」"
                + "的影响顶点 A(K)，用当前姿势的 BakeMesh 世界坐标与身体外向伪法线 n（角度加权），从 v + n*origin_mm 沿 n 及"
                + "±cone_deg 的 4 条锥向射线共 5 条（长 cover_ray_mm），打到任一可见服装三角形算该顶点被遮住；按 ray_vote 归票。"
                + "覆盖不足的键 = 关掉衣服后这个收缩键会裸露（塌脚踝/缩手）。");
            var th = new JsonObject();
            th.Set("min_weight", minWeight);
            th.Set("eps_delta_mm", epsDeltaMm);
            th.Set("cover_rule", coverRule);
            th.Set("ray_vote", rayVote);
            th.Set("cover_ray_mm", coverRayMm);
            th.Set("cone_deg", coneDeg);
            th.Set("origin_mm", originMm);
            th.Set("cover_dist_mm", coverDistMm);
            th.Set("ratio_thr", ratioThr);
            th.Set("area_thr", areaThr);
            th.Set("verdict_rule", verdictRule);
            th.Set("min_verts", minVerts);
            th.Set("inside_votes_threshold", votesThr);
            th.Set("max_keys", maxKeys);
            o.Set("thresholds", th);
            o.Set("cover_rule", coverRule);
            o.Set("ray_vote", rayVote);
            o.Set("cover_ray_mm", coverRayMm);
            o.Set("cone_deg", coneDeg);
            o.Set("origin_mm", originMm);
            o.Set("verdict_rule", verdictRule);
            o.Set("cover_criterion", "本次 verdict 用 cover_rule=" + coverRule
                + (coverRule == "outward_ray" ? "（ray_vote=" + rayVote + "）" : "")
                + "；verdict_rule=" + verdictRule + "（阈值 ratio_thr=" + AuditUtil.F(ratioThr)
                + "、area_thr=" + AuditUtil.F(areaThr) + " cm²）；cover_ray_mm=" + AuditUtil.F(coverRayMm) + " mm，cone_deg=" + AuditUtil.F(coneDeg)
                + "°，origin_mm=" + AuditUtil.F(originMm) + " mm。distance/either 才附带旧口径（壳内奇偶 ≥ " + votesThr
                + " 票 或 最近距离 ≤ " + AuditUtil.F(coverDistMm) + " mm）；旧的距离读数保留为参考列 "
                + "nearest_cover_dist_mm / covered_near_ratio，默认不参与 verdict。");
            o.Set("shell_rule", shellRule + "（默认 any：不区分壳/开口，所有可见服装三角形都算遮挡候选；"
                + "outward/majority 是 poke 的外壳分类口径，本探针暂只接受 any）");
            o.Set("keys_exclude_regex", keysExcludeStr);
            o.Set("garments_exclude", garmentsExcludeStr);
            o.Set("calibration", "任务 CU 标定结论：旧的「到衣服表面最近距离 ≤ cover_dist_mm」判据不成立"
                + "（seq_t33_calib：3 mm 抓到正样本但 Shoulder 误报，10/25/40 mm 漏掉裸脚踝——裸脚踝旁边就是鞋帮，"
                + "10 mm 内有布；宽松外套离皮肤 1–3 cm 也会被判没遮住）。根因是距离回答「附近有没有布」而不是「我外面有没有布」。"
                + "默认改用外向射线：cover_rule=outward_ray、cover_ray_mm=50、cone_deg=20、ray_vote=any。"
                + "实跑验收：正样本（关袜子 + 强开 Ankle）Ankle 必须 uncovered，负样本（全穿）全 ok，且 cover_ray_mm 在 30–80 mm"
                + " 之间结论不翻转。"
                // ── 任务 CX（B-T33b）：判据形状与 area_thr 初值，明确标注未标定 ──
                + "【任务 CX 判据形状】旧「ratio 且 area」证伪：seq_t33_calib2 正样本 A(Ankle) 的 21/221 个裸露点只占 9.5%"
                + "（过不了 ratio_thr=0.6），但绝对裸露面积 6.86 cm²（远超面积门）；比例被「本来就在鞋腔里、被鞋面合法遮住」的"
                + "那部分稀释，人眼看见的是绝对面积。故 verdict_rule 默认改成 \"or\"。"
                + "【area_thr 初值 1.0 cm²，⚠ 待 B-T33b 用正负样本标定，不是已验证值】推导：10 mm × 10 mm 连续裸露皮肤"
                + "（约一个指甲盖）是 0.5–1 m 观察距离下不看标签也一眼能认出的最小斑块；低于 ~0.2 cm²（5 mm 圆斑）时"
                + "容易被单顶点/网格接缝/射线噪点混同，故取 ~5 倍余量 = 1.0 cm²。取舍：比旧 2.0 松一半，正样本 6.86 cm² 有 6.8× 余量，"
                + "代价是会把 1–2 cm² 的边界暴露也报出来（偏保守）。**用 seq_t33_calib2 的 N（全穿）对照看：30 mm 档 Chest_2=71 cm²、"
                + "Spine_2=95.9 cm²，\"or\"+1.0 会把它们也判 uncovered（该档 8 个键会全 uncovered → self_check suspicious）；"
                + "50/80 mm 档负数明显收敛但仍非全 ok。所以 B-T33b 必须把 cover_ray_mm 与 area_thr 一起扫（正样本 Ankle 要 uncovered、"
                + "负样本全 ok），不能只调 area_thr。ratio_thr/eps_delta_mm/min_verts 仍沿用旧默认，尚未重标。");
            o.Set("note", "被遮挡（cover_rule=outward_ray）= 从身体外向伪法线 n 发 1 条 + ±cone_deg 的 4 条锥向射线，任一条（ray_vote=any）"
                + "在 cover_ray_mm 内打到遮挡集合里任一可见服装三角形。"
                + "uncovered_area_cm2 = 未遮挡影响顶点的三角形面积份额之和（每个身体三角形按顶点均分面积，只计受影响且未遮挡的顶点）。"
                + "verdict_rule=" + verdictRule + " 决定 uncovered 的判据形状；每行 verdict_by=ratio/area/both/none "
                + "如实报告 ratio 与 area 两个条件各自是否达标（便于复核是哪一边触发）。");

            // ── 身体 SMR：请求 shrink_cover.body，否则顶层 body（PickBodyPath 自动）──
            var all = AllSmrs(avatar);
            var smrsAll = avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
            Array.Sort(smrsAll, delegate (SkinnedMeshRenderer a, SkinnedMeshRenderer b)
            {
                string pa = a == null ? "" : AuditUtil.RelPath(avatar.transform, a.transform);
                string pb = b == null ? "" : AuditUtil.RelPath(avatar.transform, b.transform);
                return string.CompareOrdinal(pa, pb);
            });

            string bodySpec = ScStr(ctx, "body", null);
            if (string.IsNullOrEmpty(bodySpec)) bodySpec = ctx.S("body", null);
            SkinnedMeshRenderer bodySmr = null;
            string bodySource = "auto";
            if (!string.IsNullOrEmpty(bodySpec))
            {
                bodySmr = ScFindSmr(avatar.transform, smrsAll, bodySpec);
                bodySource = "request";
                if (bodySmr == null)
                    ctx.Warn("shrink_cover: 请求 body='" + bodySpec + "' 找不到 SkinnedMeshRenderer，改走自动识别。");
            }
            if (bodySmr == null)
            {
                var visiblePick = new List<SkinnedMeshRenderer>();
                for (int i = 0; i < all.Count; i++)
                    if (all[i].gameObject.activeInHierarchy && all[i].enabled) visiblePick.Add(all[i]);
                string bodyPath = PickBodyPath(ctx, anim, avatar.transform, all, visiblePick, out bodySource);
                bodySmr = FindSmr(all, avatar.transform, bodyPath);
            }
            o.Set("body", bodySmr != null ? Rel(avatar, bodySmr) : null);
            o.Set("body_source", bodySource);
            if (bodySmr == null || bodySmr.sharedMesh == null)
            {
                o.Set("keys", new List<object>());
                o.Set("hits", 0);
                o.Set("error", "shrink_cover: 找不到身体网格。");
                return r;
            }
            Mesh bodyMesh = bodySmr.sharedMesh;

            // ── 键集合 ──
            Regex keysExRe = null;
            if (!string.IsNullOrEmpty(keysExcludeStr))
            {
                try { keysExRe = new Regex(keysExcludeStr, RegexOptions.CultureInvariant); }
                catch (Exception e) { ctx.Warn("shrink_cover: keys_exclude_regex 非法（" + e.Message + "），忽略该过滤。"); }
            }
            var requestedKeys = ScList(ctx, "keys");
            if (requestedKeys.Count == 0) requestedKeys.Add("auto_nonzero");
            bool autoNonzero = false;
            var keyNames = new List<string>();
            for (int i = 0; i < requestedKeys.Count; i++)
            {
                string k = requestedKeys[i];
                if (string.Equals(k, "auto_nonzero", StringComparison.OrdinalIgnoreCase)) { autoNonzero = true; continue; }
                if (!keyNames.Contains(k)) keyNames.Add(k);
            }
            if (autoNonzero)
            {
                for (int i = 0; i < bodyMesh.blendShapeCount; i++)
                {
                    float w = bodySmr.GetBlendShapeWeight(i);
                    if (w <= (float)minWeight) continue;
                    string n = bodyMesh.GetBlendShapeName(i);
                    if (keysExRe != null && keysExRe.IsMatch(n)) continue;
                    if (!keyNames.Contains(n)) keyNames.Add(n);
                }
            }
            bool keysTruncated = false;
            if (keyNames.Count > maxKeys)
            {
                keysTruncated = true;
                keyNames.RemoveRange(maxKeys, keyNames.Count - maxKeys);
            }
            o.Set("keys_requested", requestedKeys.Cast<object>().ToList());
            o.Set("keys_resolved", keyNames.Cast<object>().ToList());
            o.Set("keys_truncated", keysTruncated);

            // ── 可见服装集合：头像下全部可见 SMR − 身体家族（body 自己 + 同素体其它片）− garments_exclude ──
            // 任务 CT 修：排除口径只拿**叶子 GameObject 名**，且按「整名/分隔符切词完整匹配」；
            // 不再拿整条路径或子串匹配（旧行为把 `_Outfit/LopEarMine/...` 整套衣服因 `ear` 子串排掉）。
            Regex garmentsExRe = null;
            if (!string.IsNullOrEmpty(garmentsExcludeStr))
            {
                try { garmentsExRe = new Regex(garmentsExcludeStr, RegexOptions.CultureInvariant); }
                catch (Exception e) { ctx.Warn("shrink_cover: garments_exclude 非法（" + e.Message + "），忽略该过滤。"); }
            }
            var sc = new ShrinkCoverCtx();
            sc.CoverDistM = (float)coverDistMm / 1000f;
            sc.InsideCheck = insideCheck;
            sc.MaxIter = maxIter;
            sc.VotesThr = votesThr;
            sc.RayBudget = rayBudget;
            sc.Mask = 1 << layer;
            // 任务 CU：外向射线参数。NeedShell 只在 distance/either 时打开（壳内奇偶是旧口径，跑它很贵）。
            sc.CoverRule = coverRule;
            sc.RayVote = rayVote;
            sc.CoverRayM = (float)coverRayMm / 1000f;
            sc.ConeDeg = (float)coneDeg;
            sc.OriginM = (float)originMm / 1000f;
            sc.NeedShell = insideCheck && (coverRule == "distance" || coverRule == "either");

            string bodyLeaf = bodySmr.gameObject.name;
            string bodyRoot = ShrinkCoverRules.BodyFamilyRoot(bodyLeaf);
            o.Set("body_leaf", bodyLeaf);
            o.Set("body_family_root", bodyRoot);
            o.Set("body_family_rule", "身体网格 = body 指定的 SMR（body_self）+ 同素体其它身体片（body_family："
                + "叶子名归一词根与 '" + bodyRoot + "' 相同，或同父物体且名字以该词根开头）。这些一律不进遮挡集合。");

            var garmentPaths = new List<object>();
            var garmentsExcluded = new List<object>();
            int garmentsConsidered = 0;
            for (int i = 0; i < smrsAll.Length; i++)
            {
                var smr = smrsAll[i];
                if (smr == null || smr.sharedMesh == null) continue;
                if (!ScRendererVisible(smr)) continue;
                garmentsConsidered++;
                string p = AuditUtil.RelPath(avatar.transform, smr.transform);
                string leaf = smr.gameObject.name;

                bool isSelf = smr == bodySmr;
                if (isSelf || ShrinkCoverRules.IsBodyLike(leaf, isSelf, smr.transform.parent == bodySmr.transform.parent, bodyLeaf))
                {
                    var exb = new JsonObject();
                    exb.Set("path", p);
                    exb.Set("leaf", leaf);
                    exb.Set("rule", isSelf ? "body_self" : "body_family");
                    garmentsExcluded.Add(exb);
                    continue;
                }

                string exHit;
                if (ShrinkCoverRules.ExcludeHit(garmentsExRe, leaf, out exHit))
                {
                    var exr = new JsonObject();
                    exr.Set("path", p);
                    exr.Set("leaf", leaf);
                    exr.Set("rule", "exclude_regex");
                    exr.Set("hit", exHit);
                    garmentsExcluded.Add(exr);
                    continue;
                }

                Mesh gm;
                try { gm = MeshWorldOf(smr, ctx); }
                catch (Exception e) { ctx.Warn("shrink_cover: 读服装网格失败（" + p + "）：" + e.Message); continue; }
                if (gm == null || gm.vertexCount == 0) { if (gm != null) Object.DestroyImmediate(gm); continue; }
                var g = new PokeGarment();
                g.R = smr;
                g.Path = p;
                g.Name = leaf;
                g.Pos = gm.vertices;
                g.Tris = gm.triangles;
                Vector3 mn = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
                Vector3 mx = new Vector3(float.MinValue, float.MinValue, float.MinValue);
                for (int v = 0; v < g.Pos.Length; v++)
                {
                    Vector3 q = g.Pos[v];
                    if (q.x < mn.x) mn.x = q.x; if (q.y < mn.y) mn.y = q.y; if (q.z < mn.z) mn.z = q.z;
                    if (q.x > mx.x) mx.x = q.x; if (q.y > mx.y) mx.y = q.y; if (q.z > mx.z) mx.z = q.z;
                }
                Object.DestroyImmediate(gm);
                g.VertexCount = g.Pos.Length;
                g.TriCount = g.Tris.Length / 3;
                if (g.TriCount > 0)
                {
                    var faces = new List<int>(g.TriCount);
                    for (int f = 0; f < g.TriCount; f++) faces.Add(f);
                    g.Bvh = new PokeBvh(g.Pos, g.Tris, faces);
                }
                sc.Garments.Add(g);
                sc.GMin.Add(mn);
                sc.GMax.Add(mx);
                garmentPaths.Add(p);
            }
            o.Set("garments", garmentPaths);
            o.Set("garment_count", sc.Garments.Count);
            o.Set("garments_considered", garmentsConsidered);
            o.Set("garments_used", sc.Garments.Count);
            o.Set("garments_excluded", garmentsExcluded);

            // ── 身体烘焙（当前姿势、键已施加）──
            var boneMap = BuildBoneRegionMap(anim);
            try { sc.Body = BuildBodyInfo(bodySmr, avatar.transform, anim, boneMap, ctx); }
            catch (Exception e)
            {
                o.Set("keys", new List<object>());
                o.Set("hits", 0);
                o.Set("error", "shrink_cover: 烘焙身体网格失败：" + e.Message);
                return r;
            }
            o.Set("body_baked_vertices", sc.Body.BakedCount);
            o.Set("body_shared_vertices", sc.Body.SharedCount);
            o.Set("body_region_source", sc.Body.RegionSource);
            // 任务 CU：身体外向伪法线（角度加权，BakeMesh 法线定向）。缺则射线判据对该顶点记未遮住。
            sc.BodyPseudo = ScBodyOutwardNormals(sc.Body);
            int pseudoMissing = 0;
            if (sc.BodyPseudo != null)
                for (int i = 0; i < sc.BodyPseudo.Length; i++)
                    if (sc.BodyPseudo[i].sqrMagnitude <= 1e-12f) pseudoMissing++;
            o.Set("body_outward_normals_missing", pseudoMissing);
            o.Set("body_outward_normal_rule", "PokeAngleWeightedPseudo 角度加权（复用 poke 外壳同一份），再用 BakeMesh 世界法线翻正符号；"
                + "全零顶点（孤立/退化面）在射线判据里记未遮住。");

            // ── 逐键 ──
            var keyOut = new List<object>();
            var compactKeys = new List<object>();
            int hits = 0;
            bool savedBackfaces = Physics.queriesHitBackfaces;
            try
            {
                if (sc.NeedShell && sc.Garments.Count > 0)
                {
                    Physics.queriesHitBackfaces = true;
                    WarnIfLayerOccupied(ctx, avatar, layer);
                    PokeBuildColliders(sc.Garments, layer);
                }
                for (int i = 0; i < keyNames.Count; i++)
                {
                    var ko = ShrinkCoverKey(keyNames[i], sc, (float)epsDeltaMm, minVerts, ratioThr, areaThr, verdictRule);
                    keyOut.Add(ko);
                    compactKeys.Add(ShrinkCoverCompactKey(ko));
                    if (string.Equals(AuditJson.Str(ko, "verdict", null), "uncovered", StringComparison.Ordinal)) hits++;
                }
            }
            finally
            {
                if (sc.NeedShell && sc.Garments.Count > 0)
                {
                    PokeDestroyColliders(sc.Garments);
                    Physics.queriesHitBackfaces = savedBackfaces;
                }
            }
            if (sc.Truncated) ctx.Warn("shrink_cover 射线预算 " + rayBudget + " 用尽，部分顶点的判定不完整（uncovered 偏保守）。");

            // ── 任务 CV：诊断输出（diag=true 才写；只读证据，不改任何 verdict / 默认阈值）──
            if (diag)
            {
                var diagKeyList = new List<string>();
                if (diagKeysReq.Count > 0)
                {
                    for (int i = 0; i < diagKeysReq.Count; i++)
                        if (!diagKeyList.Contains(diagKeysReq[i])) diagKeyList.Add(diagKeysReq[i]);
                }
                else
                {
                    for (int i = 0; i < keyNames.Count; i++) diagKeyList.Add(keyNames[i]);
                }
                bool diagTruncated = false;
                if (diagKeyList.Count > diagMaxKeys)
                {
                    diagTruncated = true;
                    diagKeyList.RemoveRange(diagMaxKeys, diagKeyList.Count - diagMaxKeys);
                }
                long diagRays = 0;
                var diagKeyOut = new List<object>();
                for (int i = 0; i < diagKeyList.Count; i++)
                    diagKeyOut.Add(ShrinkCoverDiag(diagKeyList[i], sc, (float)epsDeltaMm, diagSamples,
                        diagEpsList, diagRayBudget, ref diagRays));

                var diagObj = new JsonObject();
                diagObj.Set("enabled", true);
                diagObj.Set("note", "任务 CV 诊断证据（只读，不参与 verdict、不改默认阈值）。"
                    + "samples = A(K) 可用顶点的确定性等距抽样（≤ diag_samples），每条记世界坐标(mm)/|delta|(mm)/身体外向法线；"
                    + "rays = 中轴 dir=0 + 4 条锥向 dir=1..4，每条记 hit / path / dist_mm，"
                    + "这里 5 条都发（与生产 any 的「命中即停」不同），命中件取「到全部可见服装的最近命中」；"
                    + "bone_groups 按主蒙皮骨骼 Transform 名分组（LeftFoot/LeftToes/LeftLowerLeg…），region_groups 按人形部位；"
                    + "eps_sweep 只给各 eps 的影响顶点计数（不改 eps_delta_mm 默认值）。");
                diagObj.Set("keys_requested", diagKeysReq.Cast<object>().ToList());
                diagObj.Set("keys_diagnosed", diagKeyList.Cast<object>().ToList());
                diagObj.Set("keys_truncated", diagTruncated);
                diagObj.Set("diag_max_keys", diagMaxKeys);
                diagObj.Set("samples_per_key", diagSamples);
                diagObj.Set("eps_sweep_mm", diagEpsList.Cast<object>().ToList());
                diagObj.Set("ray_budget", diagRayBudget);
                diagObj.Set("rays_used", diagRays);
                diagObj.Set("keys", diagKeyOut);
                o.Set("diagnostics", diagObj);
            }

            // ── 任务 CT：探针自检（CS 教训 4 的同类）——先让探针能自己否定自己，再给 verdict ──
            // garments_used==0 / keys_resolved 为空 / 所有键都 uncovered / garments_used:garments_considered<0.2
            // 任一成立即 suspicious；此时所有行 verdict 改 undecidable，不给 uncovered（否则「判据被排除规则吃掉」
            // 会被读成「工程 100% 违规」——就是第一次实跑四状态全 uncovered 的误报形态）。
            int keysTotal = keyOut.Count;
            int keysUncovered = hits;
            string selfReason;
            bool suspicious = ShrinkCoverRules.SelfCheckSuspicious(
                garmentsConsidered, sc.Garments.Count, keysTotal, keysUncovered, out selfReason);
            if (suspicious)
            {
                ctx.Warn("shrink_cover 自检可疑：" + selfReason + " 所有键 verdict 改写为 undecidable。");
                for (int i = 0; i < keyOut.Count; i++)
                {
                    var ko = keyOut[i] as JsonObject;
                    if (ko != null) ko.Set("verdict", ShrinkCoverRules.VerdictAfterSelfCheck(true, AuditJson.Str(ko, "verdict", null)));
                }
                for (int i = 0; i < compactKeys.Count; i++)
                {
                    var ck = compactKeys[i] as JsonObject;
                    if (ck != null) ck.Set("verdict", ShrinkCoverRules.VerdictAfterSelfCheck(true, AuditJson.Str(ck, "verdict", null)));
                }
                hits = 0;
            }
            var selfObj = new JsonObject();
            selfObj.Set("suspicious", suspicious);
            selfObj.Set("reason", selfReason);
            selfObj.Set("garments_considered", garmentsConsidered);
            selfObj.Set("garments_used", sc.Garments.Count);
            selfObj.Set("keys_total", keysTotal);
            selfObj.Set("keys_uncovered", keysUncovered);
            selfObj.Set("used_ratio", garmentsConsidered > 0 ? (object)((double)sc.Garments.Count / garmentsConsidered) : null);
            selfObj.Set("verdict_override", suspicious ? "undecidable" : null);
            selfObj.Set("rule", "suspicious 条件：garments_used==0 / keys_resolved 为空 / 所有键都 uncovered / "
                + "garments_used:garments_considered < 0.2；命中时所有行 verdict 改 undecidable，不给 uncovered。");

            o.Set("keys", keyOut);
            o.Set("hits", hits);
            o.Set("self_check", selfObj);
            o.Set("truncated", sc.Truncated);
            o.Set("rays_used", sc.RaysUsed);

            // 精简行：写进 state 快照的 shrink_cover 字段（完整结果由 driver 写 shrink_cover_<stateId>.json）。
            var compact = new JsonObject();
            compact.Set("body", o.Get("body"));
            compact.Set("garment_count", sc.Garments.Count);
            compact.Set("garments_considered", garmentsConsidered);
            compact.Set("garments_used", sc.Garments.Count);
            compact.Set("keys_total", keysTotal);
            compact.Set("hits", hits);
            compact.Set("self_check", selfObj);
            compact.Set("truncated", sc.Truncated);
            compact.Set("thresholds", th);
            compact.Set("cover_rule", coverRule);
            compact.Set("verdict_rule", verdictRule);
            compact.Set("ray_vote", rayVote);
            compact.Set("cover_ray_mm", coverRayMm);
            compact.Set("cone_deg", coneDeg);
            compact.Set("origin_mm", originMm);
            var uncoveredNames = new List<object>();
            var compactList = new List<object>();
            for (int i = 0; i < keyOut.Count; i++)
            {
                var ko = keyOut[i] as JsonObject;
                var ck = compactKeys[i] as JsonObject;
                if (ko != null && string.Equals(AuditJson.Str(ko, "verdict", null), "uncovered", StringComparison.Ordinal))
                    uncoveredNames.Add(AuditJson.Str(ko, "key", null));
                compactList.Add(ck);
            }
            compact.Set("uncovered_keys", uncoveredNames);
            compact.Set("keys", compactList);
            o.Set("compact", compact);

            r.Hits = hits;
            return r;
        }

        /// <summary>一个收缩键的判定（影响顶点、覆盖率、面积、verdict）。纯几何，异常往上抛。</summary>
        private static JsonObject ShrinkCoverKey(string key, ShrinkCoverCtx sc, float epsDeltaMm, int minVerts,
            double ratioThr, double areaThr, string verdictRule)
        {
            var o = new JsonObject();
            o.Set("key", key);
            var bodySmr = sc.Body != null ? sc.Body.Smr : null;
            Mesh mesh = bodySmr != null ? bodySmr.sharedMesh : null;
            if (mesh == null)
            {
                o.Set("verdict", "key_missing");
                o.Set("verdict_by", "none");
                o.Set("verdict_rule", ShrinkCoverRules.NormalizeVerdictRule(verdictRule));
                o.Set("error", "身体网格缺失");
                o.Set("covered_by_top", new List<object>());
                o.Set("covered_by_ray_top", new List<object>());
                return o;
            }
            var idxs = AuditStateDriver.MatchShapeIndices(mesh, key);
            if (idxs.Count == 0)
            {
                o.Set("verdict", "key_missing");
                o.Set("verdict_by", "none");
                o.Set("verdict_rule", ShrinkCoverRules.NormalizeVerdictRule(verdictRule));
                o.Set("error", "key_missing:" + key);
                o.Set("affected_verts", 0);
                o.Set("affected_verts_raw", 0);
                o.Set("covered_verts", 0);
                o.Set("uncovered_ratio", 0.0);
                o.Set("uncovered_area_cm2", 0.0);
                o.Set("nearest_cover_path", null);
                o.Set("covered_near_ratio", 0.0);
                o.Set("ray_covered_verts", 0);
                o.Set("covered_by_top", new List<object>());
                o.Set("covered_by_ray_top", new List<object>());
                o.Set("weight", 0.0);
                return o;
            }
            o.Set("shape_indices", idxs.Cast<object>().ToList());
            o.Set("shape_index", idxs[0]);

            float weight = 0f;
            for (int i = 0; i < idxs.Count; i++)
            {
                float w = bodySmr.GetBlendShapeWeight(idxs[i]);
                if (w > weight) weight = w;
            }
            o.Set("weight", (double)weight);

            int n = sc.Body.Pos.Length;
            var aff = new bool[n];
            int raw = 0;
            for (int i = 0; i < idxs.Count; i++)
            {
                int shape = idxs[i];
                int fc = mesh.GetBlendShapeFrameCount(shape);
                if (fc <= 0) continue;
                float fw = mesh.GetBlendShapeFrameWeight(shape, fc - 1);
                float norm = fw > 1e-6f ? 100f / fw : 1f;   // 归一化到 100%（帧权重通常就是 100，norm=1）
                int vc = mesh.vertexCount;
                var dv = new Vector3[vc];
                var dn = new Vector3[vc];
                var dt = new Vector3[vc];
                try { mesh.GetBlendShapeFrameVertices(shape, fc - 1, dv, dn, dt); }
                catch (Exception e) { o.Set("error", "读 blendshape frame 失败：" + e.Message); continue; }
                Vector3 ls = bodySmr.transform != null ? bodySmr.transform.lossyScale : Vector3.one;
                float thr = epsDeltaMm / 1000f;
                for (int v = 0; v < vc && v < n; v++)
                {
                    Vector3 d = new Vector3(dv[v].x * ls.x, dv[v].y * ls.y, dv[v].z * ls.z) * norm;
                    if (d.magnitude >= thr && !aff[v]) { aff[v] = true; raw++; }
                }
                if (i == 0)
                {
                    o.Set("shape_frame_count", fc);
                    o.Set("shape_frame_weight", (double)fw);
                }
            }

            int affected = 0;
            for (int v = 0; v < n; v++) if (aff[v] && sc.Body.Usable[v]) affected++;
            o.Set("affected_verts", affected);
            o.Set("affected_verts_raw", raw);

            var cov = new bool[n];
            int covered = 0;
            int nearCovered = 0;      // 参考列：最近距离 ≤ cover_dist_mm 的影响顶点数
            int rayCovered = 0;       // 新口径：外向射线票数满足 ray_vote 的影响顶点数
            var gBest = new float[sc.Garments.Count];
            var gCover = new int[sc.Garments.Count];     // 旧口径（距离/壳内）首件命中计数 → covered_by_top
            var gRayHits = new int[sc.Garments.Count];   // 新口径：作为最近命中件的顶点数 → covered_by_ray_top
            for (int gi = 0; gi < gBest.Length; gi++) gBest[gi] = float.MaxValue;

            for (int v = 0; v < n; v++)
            {
                if (!aff[v] || !sc.Body.Usable[v]) continue;
                Vector3 p = sc.Body.Pos[v];

                // ── 旧口径：到服装表面最近距离（参考列，恒算）+ 壳内奇偶（仅 distance/either 参与）──
                bool isNear = false;
                bool isCov = false;
                for (int gi = 0; gi < sc.Garments.Count; gi++)
                {
                    var g = sc.Garments[gi];
                    if (g.Bvh == null) continue;
                    Vector3 cp; float d2; int feat;
                    g.Bvh.Nearest(p, out cp, out d2, out feat);
                    float d = Mathf.Sqrt(Mathf.Max(0f, d2));
                    if (d < gBest[gi]) gBest[gi] = d;
                    if (d <= sc.CoverDistM)
                    {
                        isNear = true;
                        if (!isCov) { isCov = true; gCover[gi]++; }
                    }
                }
                if (isNear) nearCovered++;
                if (!isCov && sc.NeedShell)
                {
                    for (int gi = 0; gi < sc.Garments.Count; gi++)
                    {
                        if (sc.RaysUsed >= sc.RayBudget) { sc.Truncated = true; break; }
                        Vector3 mn = sc.GMin[gi], mx = sc.GMax[gi];
                        if (p.x < mn.x - 0.001f || p.x > mx.x + 0.001f) continue;
                        if (p.y < mn.y - 0.001f || p.y > mx.y + 0.001f) continue;
                        if (p.z < mn.z - 0.001f || p.z > mx.z + 0.001f) continue;
                        var g = sc.Garments[gi];
                        if (g.Collider == null) continue;
                        int votes = ShrinkCoverInsideVotes(p, sc.Mask, sc.MaxIter, g.Collider, sc);
                        if (votes >= sc.VotesThr) { isCov = true; gCover[gi]++; break; }
                    }
                }

                // ── 任务 CU 新口径：身体外向伪法线 n 的 1 条中轴 + 4 条锥向射线，任一命中即该票成立 ──
                int rayVotesHit = 0;
                int rayNearestGi = -1;
                if (sc.Garments.Count > 0 && sc.BodyPseudo != null)
                {
                    Vector3 nrm = sc.BodyPseudo[v];
                    if (nrm.sqrMagnitude > 1e-12f)
                    {
                        ScVec[] dirs = ShrinkCoverRayRules.ConeDirections(new ScVec(nrm.x, nrm.y, nrm.z), sc.ConeDeg);
                        Vector3 origin = p + nrm * sc.OriginM;
                        float nearestT = float.MaxValue;
                        for (int d = 0; d < dirs.Length; d++)
                        {
                            var dir = new Vector3(dirs[d].x, dirs[d].y, dirs[d].z);
                            bool rayHit = false;
                            for (int gi = 0; gi < sc.Garments.Count; gi++)
                            {
                                var g = sc.Garments[gi];
                                if (g.Bvh == null) continue;
                                if (sc.RaysUsed >= sc.RayBudget) { sc.Truncated = true; break; }
                                sc.RaysUsed++;
                                float ht;
                                int hitFace = g.Bvh.Raycast(origin, dir, sc.CoverRayM, out ht);
                                if (hitFace >= 0)
                                {
                                    rayHit = true;
                                    // 中轴射线找最近件（covered_by_ray_top 用）；锥向只问有没有，命中即停（省射线预算）
                                    if (ht < nearestT) { nearestT = ht; rayNearestGi = gi; }
                                    if (d != 0) break;
                                }
                            }
                            if (rayHit) rayVotesHit++;
                            // any 归票下，任一条命中即可收工（中轴先跑，最近命中件已记下）
                            if (rayVotesHit > 0 && sc.RayVote != ShrinkCoverRayRules.RayVoteMajority) break;
                            if (sc.Truncated) break;
                        }
                    }
                }
                bool covRay = ShrinkCoverRayRules.RuleSatisfied(sc.RayVote, rayVotesHit, ShrinkCoverRayRules.TotalRayCount);
                if (covRay)
                {
                    rayCovered++;
                    if (rayNearestGi >= 0) gRayHits[rayNearestGi]++;
                }

                bool active = sc.CoverRule == "distance" ? isCov : (sc.CoverRule == "either" ? (isCov || covRay) : covRay);
                if (active) { cov[v] = true; covered++; }
            }
            o.Set("covered_verts", covered);
            o.Set("ray_covered_verts", rayCovered);
            o.Set("cover_criterion", sc.CoverRule + (sc.CoverRule == "outward_ray" ? "(" + sc.RayVote + ")" : ""));
            double uncovRatio = affected > 0 ? (double)(affected - covered) / affected : 0.0;
            o.Set("uncovered_ratio", uncovRatio);
            o.Set("covered_near_ratio", affected > 0 ? (object)((double)nearCovered / affected) : (object)null);

            // 未遮挡面积份额：每个身体三角形按顶点均分面积，只累加「受影响且未遮挡」的份额。
            double uncovArea = 0.0;
            int[] tris = sc.Body.Tris;
            if (tris != null)
            {
                for (int t = 0; t + 2 < tris.Length; t += 3)
                {
                    int a = tris[t], b = tris[t + 1], c = tris[t + 2];
                    if (a < 0 || b < 0 || c < 0 || a >= n || b >= n || c >= n) continue;
                    Vector3 pa = sc.Body.Pos[a], pb = sc.Body.Pos[b], pc = sc.Body.Pos[c];
                    float areaCm2 = Vector3.Cross(pb - pa, pc - pa).magnitude * 0.5f * 10000f;
                    float share = areaCm2 / 3f;
                    if (sc.Body.Usable[a] && aff[a] && !cov[a]) uncovArea += share;
                    if (sc.Body.Usable[b] && aff[b] && !cov[b]) uncovArea += share;
                    if (sc.Body.Usable[c] && aff[c] && !cov[c]) uncovArea += share;
                }
            }
            o.Set("uncovered_area_cm2", uncovArea);

            // nearest_cover_path：到影响顶点整体最近的可见服装（人看「本该盖住它的是谁」）。
            int bestGi = -1;
            float bestD = float.MaxValue;
            for (int gi = 0; gi < gBest.Length; gi++)
                if (gBest[gi] < bestD) { bestD = gBest[gi]; bestGi = gi; }
            o.Set("nearest_cover_path", bestGi >= 0 ? (object)sc.Garments[bestGi].Path : null);
            o.Set("nearest_cover_dist_mm", bestGi >= 0 ? (object)(double)(bestD * 1000f) : null);
            var coverBy = new JsonObject();
            for (int gi = 0; gi < gCover.Length; gi++)
                if (gCover[gi] > 0) coverBy.Set(sc.Garments[gi].Path, gCover[gi]);
            o.Set("cover_by", coverBy);

            // 任务 CT：covered_by_top = 盖住 A(K) 的前 3 件（按覆盖顶点数降序，同数按路径定序），
            // 空即没有一件盖住。人一眼看出「本该是谁盖住它」；每项 {path, leaf, covered_verts}。
            var gOrder = new List<int>();
            for (int gi = 0; gi < gCover.Length; gi++) if (gCover[gi] > 0) gOrder.Add(gi);
            gOrder.Sort(delegate (int x, int y)
            {
                int cmp = gCover[y].CompareTo(gCover[x]);
                if (cmp != 0) return cmp;
                return string.CompareOrdinal(sc.Garments[x].Path, sc.Garments[y].Path);
            });
            var coveredByTop = new List<object>();
            for (int i = 0; i < gOrder.Count && i < 3; i++)
            {
                int gi = gOrder[i];
                var e = new JsonObject();
                e.Set("path", sc.Garments[gi].Path);
                e.Set("leaf", sc.Garments[gi].Name);
                e.Set("covered_verts", gCover[gi]);
                coveredByTop.Add(e);
            }
            o.Set("covered_by_top", coveredByTop);

            // 任务 CU：covered_by_ray_top = 外向射线命中的前 3 件（按被该件作为最近命中件的顶点数降序，
            // 同数按路径定序），空即没有一件被射线打到。每项 {path, leaf, hit_verts}。
            var gOrderRay = new List<int>();
            for (int gi = 0; gi < gRayHits.Length; gi++) if (gRayHits[gi] > 0) gOrderRay.Add(gi);
            gOrderRay.Sort(delegate (int x, int y)
            {
                int cmp = gRayHits[y].CompareTo(gRayHits[x]);
                if (cmp != 0) return cmp;
                return string.CompareOrdinal(sc.Garments[x].Path, sc.Garments[y].Path);
            });
            var coveredByRayTop = new List<object>();
            for (int i = 0; i < gOrderRay.Count && i < 3; i++)
            {
                int gi = gOrderRay[i];
                var e = new JsonObject();
                e.Set("path", sc.Garments[gi].Path);
                e.Set("leaf", sc.Garments[gi].Name);
                e.Set("hit_verts", gRayHits[gi]);
                coveredByRayTop.Add(e);
            }
            o.Set("covered_by_ray_top", coveredByRayTop);

            // 任务 CX（B-T33b）：ratio/area 各自是否达标，再由 verdict_rule 决定 uncovered 的形状。
            bool ratioOk = uncovRatio >= ratioThr;
            bool areaOk = uncovArea >= areaThr;
            string verdictBy = ShrinkCoverRules.VerdictBy(ratioOk, areaOk);
            string verdict;
            if (affected < minVerts) verdict = "too_few_verts";
            else if (ShrinkCoverRules.UncoveredByRule(verdictRule, ratioOk, areaOk)) verdict = "uncovered";
            else verdict = "ok";
            o.Set("verdict", verdict);
            o.Set("verdict_by", verdictBy);
            o.Set("verdict_rule", ShrinkCoverRules.NormalizeVerdictRule(verdictRule));
            o.Set("ratio_ok", ratioOk);
            o.Set("area_ok", areaOk);
            return o;
        }

        private static JsonObject ShrinkCoverCompactKey(JsonObject ko)
        {
            var c = new JsonObject();
            if (ko == null) return c;
            c.Set("key", ko.Get("key"));
            c.Set("weight", ko.Get("weight"));
            c.Set("affected_verts", ko.Get("affected_verts"));
            c.Set("covered_verts", ko.Get("covered_verts"));
            c.Set("uncovered_ratio", ko.Get("uncovered_ratio"));
            c.Set("uncovered_area_cm2", ko.Get("uncovered_area_cm2"));
            c.Set("nearest_cover_path", ko.Get("nearest_cover_path"));
            c.Set("covered_near_ratio", ko.Get("covered_near_ratio"));
            c.Set("ray_covered_verts", ko.Get("ray_covered_verts"));
            c.Set("cover_criterion", ko.Get("cover_criterion"));
            c.Set("covered_by_top", ko.Get("covered_by_top"));
            c.Set("covered_by_ray_top", ko.Get("covered_by_ray_top"));
            c.Set("verdict", ko.Get("verdict"));
            // 任务 CX：别只给结论，把「哪一边达标」也带出去。
            c.Set("verdict_by", ko.Get("verdict_by"));
            c.Set("ratio_ok", ko.Get("ratio_ok"));
            c.Set("area_ok", ko.Get("area_ok"));
            if (ko.Has("error")) c.Set("error", ko.Get("error"));
            return c;
        }

        // ════════════════════════════════════════════════════════════════
        // 任务 CV：shrink_cover 诊断（diag=true 时对指定键输出只读证据）
        // 回答三个问题：A(K) 在哪儿（包围盒 + 按骨/部位分组）；92.8%「外面有布」命中的是哪个件；
        // eps_delta_mm 从 0.5 降到 0.05 时 A(K) 变多少。不改 verdict、不改默认阈值。
        // ════════════════════════════════════════════════════════════════

        /// <summary>诊断聚合：一组顶点的计数 + 未遮挡计数 + 世界包围盒（米，输出时转 mm）。</summary>
        private sealed class ScDiagAgg
        {
            public int Verts;
            public int Uncovered;
            public Vector3 Min = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
            public Vector3 Max = new Vector3(float.MinValue, float.MinValue, float.MinValue);

            public void Add(Vector3 p, bool uncovered)
            {
                Verts++;
                if (uncovered) Uncovered++;
                if (p.x < Min.x) Min.x = p.x;
                if (p.y < Min.y) Min.y = p.y;
                if (p.z < Min.z) Min.z = p.z;
                if (p.x > Max.x) Max.x = p.x;
                if (p.y > Max.y) Max.y = p.y;
                if (p.z > Max.z) Max.z = p.z;
            }

            public JsonObject BboxMm()
            {
                var o = new JsonObject();
                if (Verts == 0) return o;
                o.Set("min_mm", ScDiagVecMm(Min));
                o.Set("max_mm", ScDiagVecMm(Max));
                o.Set("size_mm", ScDiagVecMm(Max - Min));
                o.Set("center_mm", ScDiagVecMm((Min + Max) * 0.5f));
                return o;
            }

            public JsonObject Json(string name)
            {
                var o = new JsonObject();
                o.Set("name", name);
                o.Set("verts", Verts);
                o.Set("ray_uncovered", Uncovered);
                o.Set("bbox_mm", BboxMm());
                return o;
            }
        }

        /// <summary>世界坐标（米）转 mm 的 {x,y,z}。</summary>
        private static JsonObject ScDiagVecMm(Vector3 v)
        {
            var o = new JsonObject();
            o.Set("x", (double)(v.x * 1000f));
            o.Set("y", (double)(v.y * 1000f));
            o.Set("z", (double)(v.z * 1000f));
            return o;
        }

        /// <summary>任务 CV：一个键在 100% 时每个顶点的世界位移大小（米）。口径与 ShrinkCoverKey 完全一致
        /// （frame 最后一帧、按帧权重归一化到 100%、乘 lossyScale），只是这里不早退、逐顶点留数。</summary>
        private static float[] ScShapeDeltaMagnitudesM(SkinnedMeshRenderer smr, Mesh mesh, List<int> shapeIdxs, int n)
        {
            var mag = new float[n];
            if (mesh == null || shapeIdxs == null || shapeIdxs.Count == 0) return mag;
            Vector3 ls = smr != null && smr.transform != null ? smr.transform.lossyScale : Vector3.one;
            for (int i = 0; i < shapeIdxs.Count; i++)
            {
                int shape = shapeIdxs[i];
                int fc = mesh.GetBlendShapeFrameCount(shape);
                if (fc <= 0) continue;
                float fw = mesh.GetBlendShapeFrameWeight(shape, fc - 1);
                float norm = fw > 1e-6f ? 100f / fw : 1f;
                int vc = mesh.vertexCount;
                var dv = new Vector3[vc];
                var dn = new Vector3[vc];
                var dt = new Vector3[vc];
                try { mesh.GetBlendShapeFrameVertices(shape, fc - 1, dv, dn, dt); }
                catch { continue; }
                for (int v = 0; v < vc && v < n; v++)
                {
                    Vector3 d = new Vector3(dv[v].x * ls.x, dv[v].y * ls.y, dv[v].z * ls.z) * norm;
                    float m = d.magnitude;
                    if (m > mag[v]) mag[v] = m;
                }
            }
            return mag;
        }

        /// <summary>任务 CV：一条射线到「全部可见服装」的最近命中（返回件序号；未命中 -1）。</summary>
        private static bool ScDiagRay(ShrinkCoverCtx sc, Vector3 origin, Vector3 dir, float maxM,
            out int gi, out float distM)
        {
            gi = -1;
            distM = float.MaxValue;
            for (int i = 0; i < sc.Garments.Count; i++)
            {
                var g = sc.Garments[i];
                if (g.Bvh == null) continue;
                float ht;
                int f = g.Bvh.Raycast(origin, dir, maxM, out ht);
                if (f >= 0 && ht < distM) { distM = ht; gi = i; }
            }
            return gi >= 0;
        }

        /// <summary>任务 CV：某顶点的外向射线票数。detail=false 复刻生产早退（any 命中即停）；
        /// detail=true 时 5 条全发并把逐条 {dir,kind,hit,path,leaf,dist_mm} 写进 detailOut。</summary>
        private static int ScDiagRayVotes(ShrinkCoverCtx sc, Vector3 p, Vector3 nrm, long budget, ref long used,
            bool detail, List<object> detailOut, out bool truncated)
        {
            truncated = false;
            int votes = 0;
            if (sc == null || sc.Garments == null || sc.Garments.Count == 0) return 0;
            if (nrm.sqrMagnitude <= 1e-12f) return 0;
            ScVec[] dirs = ShrinkCoverRayRules.ConeDirections(new ScVec(nrm.x, nrm.y, nrm.z), sc.ConeDeg);
            Vector3 origin = p + nrm * sc.OriginM;
            for (int d = 0; d < dirs.Length; d++)
            {
                if (used >= budget) { truncated = true; break; }
                var dir = new Vector3(dirs[d].x, dirs[d].y, dirs[d].z);
                int gi;
                float t;
                used++;
                bool hit = ScDiagRay(sc, origin, dir, sc.CoverRayM, out gi, out t);
                if (hit) votes++;
                if (detail)
                {
                    var e = new JsonObject();
                    e.Set("dir", d);
                    e.Set("kind", d == 0 ? "axis" : "cone");
                    e.Set("hit", hit);
                    if (hit)
                    {
                        e.Set("path", sc.Garments[gi].Path);
                        e.Set("leaf", sc.Garments[gi].Name);
                        e.Set("dist_mm", (double)(t * 1000f));
                    }
                    detailOut.Add(e);
                }
                else if (votes > 0 && sc.RayVote != ShrinkCoverRayRules.RayVoteMajority) break;
            }
            return votes;
        }

        private static void ScDiagBump(Dictionary<string, int> d, string key)
        {
            int c;
            d[key] = d.TryGetValue(key, out c) ? c + 1 : 1;
        }

        private static List<object> ScDiagLeafCounts(Dictionary<string, int> d)
        {
            var keys = new List<string>(d.Keys);
            keys.Sort(delegate (string a, string b)
            {
                int cmp = d[b].CompareTo(d[a]);
                if (cmp != 0) return cmp;
                return string.CompareOrdinal(a, b);
            });
            var l = new List<object>();
            for (int i = 0; i < keys.Count; i++)
            {
                var e = new JsonObject();
                e.Set("leaf", keys[i]);
                e.Set("verts", d[keys[i]]);
                l.Add(e);
            }
            return l;
        }

        /// <summary>
        /// 任务 CV：单个键的诊断记录。输出（1）A(K) 等距抽样 ≤sampleCount 个顶点的世界坐标/|delta|/外向法线；
        /// （2）每个抽样点中轴 + 4 条锥向的逐条 hit/path/dist；（3）A(K) 包围盒 + 按主骨/部位分组；
        /// （4）eps_delta_mm 扫描只给计数。纯只读，异常不往上抛（诊断失败不该影响 verdict）。
        /// </summary>
        private static JsonObject ShrinkCoverDiag(string key, ShrinkCoverCtx sc, float baseEpsMm,
            int sampleCount, List<double> epsSweepMm, long rayBudget, ref long raysUsed)
        {
            var o = new JsonObject();
            o.Set("key", key);
            var bodySmr = sc.Body != null ? sc.Body.Smr : null;
            Mesh mesh = bodySmr != null ? bodySmr.sharedMesh : null;
            if (mesh == null) { o.Set("error", "身体网格缺失"); return o; }
            var idxs = AuditStateDriver.MatchShapeIndices(mesh, key);
            o.Set("shape_indices", idxs.Cast<object>().ToList());
            if (idxs.Count == 0) { o.Set("error", "key_missing:" + key); return o; }

            float weight = 0f;
            for (int i = 0; i < idxs.Count; i++)
            {
                float w = bodySmr.GetBlendShapeWeight(idxs[i]);
                if (w > weight) weight = w;
            }
            o.Set("weight", (double)weight);

            int n = sc.Body.Pos.Length;
            float[] magM = ScShapeDeltaMagnitudesM(bodySmr, mesh, idxs, n);
            float baseThrM = baseEpsMm / 1000f;

            // A(K)：与生产同口径（可用 + |delta| ≥ eps）
            var affected = new List<int>();
            for (int v = 0; v < n; v++)
                if (sc.Body.Usable[v] && magM[v] >= baseThrM) affected.Add(v);
            o.Set("affected_verts", affected.Count);
            o.Set("diag_cover_rule", "outward_ray(" + sc.RayVote + ")，cover_ray_mm=" + AuditUtil.F(sc.CoverRayM * 1000f)
                + "，cone_deg=" + AuditUtil.F(sc.ConeDeg));

            // ── (3) 包围盒 + 按主骨/部位分组（顺带统计各组未遮挡）──
            var bbox = new ScDiagAgg();
            var boneAgg = new Dictionary<string, ScDiagAgg>(StringComparer.Ordinal);
            var regionAgg = new Dictionary<string, ScDiagAgg>(StringComparer.Ordinal);
            int covCount = 0;
            for (int a = 0; a < affected.Count; a++)
            {
                int v = affected[a];
                Vector3 p = sc.Body.Pos[v];
                Vector3 nrm = sc.BodyPseudo != null && v < sc.BodyPseudo.Length ? sc.BodyPseudo[v] : Vector3.zero;
                bool trunc;
                int votes = ScDiagRayVotes(sc, p, nrm, rayBudget, ref raysUsed, false, null, out trunc);
                bool covered = ShrinkCoverRayRules.RuleSatisfied(sc.RayVote, votes, ShrinkCoverRayRules.TotalRayCount);
                if (covered) covCount++;
                bbox.Add(p, !covered);
                string bone = sc.Body.BoneName != null && v < sc.Body.BoneName.Length ? sc.Body.BoneName[v] : "unknown";
                string region = sc.Body.Region != null && v < sc.Body.Region.Length ? sc.Body.Region[v] : "unknown";
                ScDiagAgg ba;
                if (!boneAgg.TryGetValue(bone, out ba)) { ba = new ScDiagAgg(); boneAgg[bone] = ba; }
                ba.Add(p, !covered);
                ScDiagAgg ra;
                if (!regionAgg.TryGetValue(region, out ra)) { ra = new ScDiagAgg(); regionAgg[region] = ra; }
                ra.Add(p, !covered);
            }
            o.Set("ray_covered_verts", covCount);
            o.Set("ray_uncovered_ratio", affected.Count > 0 ? (object)((double)(affected.Count - covCount) / affected.Count) : (object)null);
            o.Set("bbox_mm", bbox.BboxMm());

            var boneOut = new List<object>();
            foreach (var kv in boneAgg) boneOut.Add(kv.Value.Json(kv.Key));
            boneOut.Sort(delegate (object x, object y)
            {
                var a = x as JsonObject;
                var b = y as JsonObject;
                int cmp = AuditJson.Int(b, "verts", 0).CompareTo(AuditJson.Int(a, "verts", 0));
                if (cmp != 0) return cmp;
                return string.CompareOrdinal(AuditJson.Str(a, "name", ""), AuditJson.Str(b, "name", ""));
            });
            o.Set("bone_groups", boneOut);

            var regionOut = new List<object>();
            foreach (var kv in regionAgg) regionOut.Add(kv.Value.Json(kv.Key));
            regionOut.Sort(delegate (object x, object y)
            {
                var a = x as JsonObject;
                var b = y as JsonObject;
                int cmp = AuditJson.Int(b, "verts", 0).CompareTo(AuditJson.Int(a, "verts", 0));
                if (cmp != 0) return cmp;
                return string.CompareOrdinal(AuditJson.Str(a, "name", ""), AuditJson.Str(b, "name", ""));
            });
            o.Set("region_groups", regionOut);

            // ── (1)(2) 抽样：世界坐标 + |delta| + 外向法线 + 5 条射线逐条结果 ──
            int want = affected.Count < sampleCount ? affected.Count : sampleCount;
            var samples = new List<object>();
            var axisLeaf = new Dictionary<string, int>(StringComparer.Ordinal);
            var anyLeaf = new Dictionary<string, int>(StringComparer.Ordinal);
            for (int s = 0; s < want; s++)
            {
                int pos = want <= 1 ? 0 : (int)Math.Round((double)s * (affected.Count - 1) / (want - 1));
                int v = affected[pos];
                Vector3 p = sc.Body.Pos[v];
                Vector3 nrm = sc.BodyPseudo != null && v < sc.BodyPseudo.Length ? sc.BodyPseudo[v] : Vector3.zero;
                var e = new JsonObject();
                e.Set("vert", v);
                e.Set("world_mm", ScDiagVecMm(p));
                e.Set("delta_mm", (double)(magM[v] * 1000f));
                e.Set("outward_normal", Vec(nrm));
                e.Set("bone", sc.Body.BoneName != null && v < sc.Body.BoneName.Length ? sc.Body.BoneName[v] : "unknown");
                e.Set("region", sc.Body.Region != null && v < sc.Body.Region.Length ? sc.Body.Region[v] : "unknown");
                var rays = new List<object>();
                bool trunc;
                int votes = ScDiagRayVotes(sc, p, nrm, rayBudget, ref raysUsed, true, rays, out trunc);
                e.Set("rays", rays);
                e.Set("ray_votes", votes);
                e.Set("ray_covered", ShrinkCoverRayRules.RuleSatisfied(sc.RayVote, votes, ShrinkCoverRayRules.TotalRayCount));
                e.Set("rays_truncated", trunc);
                for (int ri = 0; ri < rays.Count; ri++)
                {
                    var ro = rays[ri] as JsonObject;
                    if (ro == null || !AuditJson.Bool(ro, "hit", false)) continue;
                    string leaf = AuditJson.Str(ro, "leaf", "?");
                    if (ri == 0) ScDiagBump(axisLeaf, leaf);
                    ScDiagBump(anyLeaf, leaf);
                }
                samples.Add(e);
            }
            o.Set("sample_count", samples.Count);
            o.Set("samples", samples);
            o.Set("sample_hit_by_leaf_axis", ScDiagLeafCounts(axisLeaf));
            o.Set("sample_hit_by_leaf_any", ScDiagLeafCounts(anyLeaf));

            // ── (4) eps 扫描：只给计数 ──
            var sweep = new List<object>();
            for (int i = 0; i < epsSweepMm.Count; i++)
            {
                double eps = epsSweepMm[i];
                float thrM = (float)(eps / 1000.0);
                int raw = 0, usable = 0;
                for (int v = 0; v < n; v++)
                {
                    if (magM[v] >= thrM)
                    {
                        raw++;
                        if (sc.Body.Usable[v]) usable++;
                    }
                }
                var se = new JsonObject();
                se.Set("eps_mm", eps);
                se.Set("affected_verts", usable);
                se.Set("affected_verts_raw", raw);
                sweep.Add(se);
            }
            o.Set("eps_sweep", sweep);
            return o;
        }

        /// <summary>
        /// 单方向奇偶计交点，但只数 target 这件衣物的命中：射线打到别的衣物时继续前进（不计数）。
        /// 六方向里 ≥ votesThr 票奇数 = 在内。口径沿用 containment 的 InsideVotes，多一个 target 过滤
        /// （嵌套袜+鞋时若把两件一起数，同一条射线会命中 2 次 → 偶数，反把「在里面」判成外）。
        /// </summary>
        private static int ShrinkCoverInsideVotes(Vector3 p, int mask, int maxIter, Collider target, ShrinkCoverCtx sc)
        {
            int votes = 0;
            for (int d = 0; d < Directions.Length; d++)
            {
                Vector3 dir = Directions[d];
                Vector3 origin = p;
                int crossings = 0;
                for (int it = 0; it < maxIter; it++)
                {
                    if (sc.RaysUsed >= sc.RayBudget) break;
                    RaycastHit h;
                    bool hit = Physics.Raycast(origin, dir, out h, 1000f, mask, QueryTriggerInteraction.Ignore);
                    sc.RaysUsed++;
                    if (!hit) break;
                    if (h.collider == target) crossings++;
                    origin = h.point + dir * RayAdvanceM;
                }
                if ((crossings & 1) == 1) votes++;
            }
            return votes;
        }

        /// <summary>渲染器匹配：精确路径 / 精确 GameObject 名 / 精确叶子名，其次路径或名字子串（不区分大小写）。
        /// 任务 CS：与 AuditStateDriver.FindPreProbeSmr 同口径（身体 SMR 定位沿用 pre_probe 的匹配规则）。</summary>
        private static SkinnedMeshRenderer ScFindSmr(Transform root, SkinnedMeshRenderer[] smrs, string spec)
        {
            if (smrs == null || string.IsNullOrEmpty(spec)) return null;
            SkinnedMeshRenderer fuzzy = null;
            int slash = spec.LastIndexOf('/');
            string leaf = slash >= 0 && slash + 1 < spec.Length ? spec.Substring(slash + 1) : spec;
            for (int i = 0; i < smrs.Length; i++)
            {
                var smr = smrs[i];
                if (smr == null) continue;
                string path = AuditUtil.RelPath(root, smr.transform);
                string name = smr.gameObject.name;
                if (string.Equals(path, spec, StringComparison.Ordinal)) return smr;
                if (string.Equals(name, spec, StringComparison.Ordinal)
                    || string.Equals(name, leaf, StringComparison.Ordinal)) return smr;
                if (fuzzy == null && (ContainsIgnoreCase(path, spec) || ContainsIgnoreCase(name, spec))) fuzzy = smr;
            }
            return fuzzy;
        }

        /// <summary>不区分大小写的包含（与 AuditStateDriver.FindPreProbeSmr 的子串兜底同口径）。</summary>
        private static bool ContainsIgnoreCase(string s, string sub)
        {
            if (string.IsNullOrEmpty(s) || string.IsNullOrEmpty(sub)) return false;
            return s.IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>可见口径沿用 state 快照的 visible：activeInHierarchy && enabled && V3 未判隐（unknown/visible 都算未判隐）。</summary>
        private static bool ScRendererVisible(Renderer r)
        {
            if (r == null || !r.gameObject.activeInHierarchy || !r.enabled) return false;
            Material[] mats;
            try { mats = r.sharedMaterials; }
            catch { return true; }
            if (mats == null || mats.Length == 0) return true;
            var verdicts = new List<string>();
            bool any = false;
            for (int i = 0; i < mats.Length; i++)
            {
                if (mats[i] == null) continue;
                any = true;
                verdicts.Add(ScV3Verdict(mats[i]));
            }
            if (!any) return true;
            return AuditV3Rules.Aggregate(verdicts) != AuditV3Rules.Hidden;
        }

        /// <summary>V3 逐材质槽判定（与 AuditStateDriver.BuildV3 同一规则表与同一取值委托）。</summary>
        private static string ScV3Verdict(Material m)
        {
            if (m == null) return AuditV3Rules.Unknown;
            string shader = m.shader != null ? m.shader.name : null;
            string reason;
            return AuditV3Rules.Evaluate(
                shader,
                delegate (string prop)
                {
                    if (prop == "_Color.a")
                    {
                        if (!m.HasProperty("_Color")) return (double?)null;
                        return (double?)m.GetColor("_Color").a;
                    }
                    if (!m.HasProperty(prop)) return (double?)null;
                    return (double?)m.GetFloat(prop);
                },
                delegate (string prop)
                {
                    if (!m.HasProperty(prop)) return null;
                    var v = m.GetVector(prop);
                    return new double[] { v.x, v.y, v.z, v.w };
                },
                out reason);
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // 任务 CT：shrink_cover 的纯规则层。
    //
    // 为什么单独一层：任务 CS 第一次实跑（工程B 43% LopEar，2026-09-20）四个状态全部 100% uncovered，
    // 根因不在几何，而在「谁算遮挡服装」的名单生成：
    //   ① garments_exclude 拿整条路径匹配，默认串里的无界词 `ear` 命中 `_Outfit/LopEarMine/...`，
    //      把整套在穿的 LopEar 外套/袜子/鞋全排除；`head`/`face` 命中祖先节点名同理。
    //   ② 身体自己（`Body`）留在集合里，而被测键就长在身体上（`Body_base`），「身体盖自己」会反转成假阴性。
    // 这一层只做字符串/正则判定，不引用任何 UnityEngine 类型，好让离线 selftest 能把它整段抽出来
    // 单独编译运行（`perception/selftest_shrink_cover.py`），保证测的就是生产同一份代码。
    // 约束：本段（BEGIN/END 标记之间）不得出现 UnityEngine / AuditProbes 的引用。
    // ══════════════════════════════════════════════════════════════════
    // >>> SHRINK_COVER_RULES_BEGIN
    public static class ShrinkCoverRules
    {
        /// <summary>任务 CT 默认「不当作遮挡服装」词表：**整名或分隔符断开的词**与之完全相等才算命中。
        /// `(?i)` + `^...$` 是必需的：去掉锚点后 `ear` 会子串命中 `LopEarMine`，就是第一次实跑 100% 误报的根因。</summary>
        public const string DefaultExcludeRegex =
            "(?i)^(hair|nail|lash|eye|face|tooth|tongue|head|halo|particle|avatarhight|tail|ear)$";

        /// <summary>身体片后缀：`Body_base` / `Body_b2` / `Body.B` → `Body`；`Body` 原样。</summary>
        private static readonly Regex BodySuffixRe =
            new Regex("[._\\- ](?:base|b\\d*|\\d+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        private static readonly char[] WordSeps = new char[] { '_', '.', '-', ' ', '\\', '/', '\t' };

        /// <summary>身体片的归一词根。例：`Body_base`→`Body`、`Body_b12`→`Body`、`Body`→`Body`。</summary>
        public static string BodyFamilyRoot(string leaf)
        {
            if (string.IsNullOrEmpty(leaf)) return "";
            string s = leaf.Trim();
            if (s.Length == 0) return "";
            // 只剥一层后缀；`Body_base_2` 这类先剥 `_2` 再看 `_base`。
            for (int guard = 0; guard < 4; guard++)
            {
                string next = BodySuffixRe.Replace(s, "");
                if (next == s || next.Length == 0) break;
                s = next;
            }
            return s;
        }

        /// <summary>按分隔符切词（整名本身也算一个词，由调用方处理）。空片段丢弃。</summary>
        public static string[] SplitWords(string leaf)
        {
            if (string.IsNullOrEmpty(leaf)) return new string[0];
            string[] raw = leaf.Split(WordSeps, StringSplitOptions.RemoveEmptyEntries);
            var res = new List<string>(raw.Length);
            for (int i = 0; i < raw.Length; i++)
            {
                string w = raw[i].Trim();
                if (w.Length > 0) res.Add(w);
            }
            return res.ToArray();
        }

        /// <summary>整串完整匹配（等价于给正则两侧加 ^…$，但不要求调用方写锚点）。
        /// 这样即使请求里传了旧的、无锚点的 `(?i)(...|ear)`，也不会子串命中 `LopEarMine`。</summary>
        private static bool FullMatch(Regex re, string s)
        {
            if (re == null || string.IsNullOrEmpty(s)) return false;
            Match m = re.Match(s);
            return m.Success && m.Index == 0 && m.Length == s.Length;
        }

        /// <summary>
        /// 任务 CT 的排除口径：**只看叶子 GameObject 名**（不再拿整条路径），
        /// 且命中条件 = 整名完整匹配 **或** 分隔符切出的某个词完整匹配。
        /// `Ear` / `Hair_Front` / `Jacket_Ear` 命中；`LopEarMine`（`ear` 只是子串）、`Shoes` 不命中。
        /// </summary>
        public static bool ExcludeHit(Regex re, string leaf, out string hit)
        {
            hit = null;
            if (re == null || string.IsNullOrEmpty(leaf)) return false;
            if (FullMatch(re, leaf)) { hit = leaf; return true; }
            string[] words = SplitWords(leaf);
            for (int i = 0; i < words.Length; i++)
            {
                if (FullMatch(re, words[i])) { hit = words[i]; return true; }
            }
            return false;
        }

        /// <summary>
        /// 是不是「身体网格」：body 指定的那个自己，或同素体的其它身体片。
        /// 判据（要么词根相同，要么同父物体且名字以词根开头）：
        ///   · `Body_base`（body）→ 排除 `Body`、`Body_b2`（词根都是 `Body`）；
        ///   · 排除 body 自己（candIsSelf）；
        ///   · 同父物体 + 名字以词根开头（兜住 `BodyFoo` 这类同父片）。
        /// `Body_Stocking_breasts_big`（身体贴图袜，不同父、词根不同）不会误伤。
        /// </summary>
        public static bool IsBodyLike(string candLeaf, bool candIsSelf, bool sameParent, string bodyLeaf)
        {
            if (candIsSelf) return true;
            string bodyRoot = BodyFamilyRoot(bodyLeaf);
            if (string.IsNullOrEmpty(bodyRoot)) return false;
            string candRoot = BodyFamilyRoot(candLeaf);
            if (string.Equals(candRoot, bodyRoot, StringComparison.OrdinalIgnoreCase)) return true;
            if (sameParent && !string.IsNullOrEmpty(candLeaf)
                && candLeaf.StartsWith(bodyRoot, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        /// <summary>可疑时把任何 verdict 改写成 `undecidable`，不给 `uncovered`。</summary>
        public static string VerdictAfterSelfCheck(bool suspicious, string verdict)
        {
            return suspicious ? "undecidable" : verdict;
        }

        // ── 任务 CX（B-T33b）：verdict 判据形状 ────────────────────────────
        // 旧行为（"and"）= ratio ≥ ratio_thr 且 area ≥ area_thr。实测证伪：一个收缩键的影响区
        // 天然横跨遮挡区与裸露区，比例被「合法被遮住的那部分」稀释；人眼看见的是绝对裸露面积。
        // 故默认改成 "or"：ratio 或 area 任一达标即判 uncovered。四种取值都保留，便于对照标定。
        public const string VerdictRuleOr = "or";
        public const string VerdictRuleAnd = "and";
        public const string VerdictRuleRatioOnly = "ratio_only";
        public const string VerdictRuleAreaOnly = "area_only";
        /// <summary>任务 CX：area_thr 初值（cm²）。旧值 2.0 无推导；1.0 ≈ 10 mm × 10 mm 连续裸露皮肤，
        /// 约一个指甲盖、0.5–1 m 观察距离下不看标签也一眼能认出的最小斑块；低于 ~0.2 cm²（5 mm 圆斑）
        /// 时容易被单顶点/网格接缝/射线噪点混同。**待 B-T33b 用正负样本标定，不是已验证值。**</summary>
        public const double DefaultAreaThrCm2 = 1.0;

        /// <summary>归一化 verdict_rule：空/未知一律落回 "or"（默认）。</summary>
        public static string NormalizeVerdictRule(string rule)
        {
            if (string.IsNullOrEmpty(rule)) return VerdictRuleOr;
            string r = rule.Trim().ToLowerInvariant();
            if (r == VerdictRuleAnd) return VerdictRuleAnd;
            if (r == VerdictRuleRatioOnly) return VerdictRuleRatioOnly;
            if (r == VerdictRuleAreaOnly) return VerdictRuleAreaOnly;
            return VerdictRuleOr;
        }

        /// <summary>按生效的 verdict_rule 判「是否算 uncovered」。ratioOk / areaOk 是各自阈值是否达标。</summary>
        public static bool UncoveredByRule(string rule, bool ratioOk, bool areaOk)
        {
            switch (NormalizeVerdictRule(rule))
            {
                case VerdictRuleAnd: return ratioOk && areaOk;
                case VerdictRuleRatioOnly: return ratioOk;
                case VerdictRuleAreaOnly: return areaOk;
                default: return ratioOk || areaOk;   // or
            }
        }

        /// <summary>本行是哪个条件触发的：`both` / `ratio` / `area` / `none`。与 verdict_rule 无关，
        /// 只如实报告 ratio/area 两个条件的取值，便于复核是哪一边把结论拉过去的。</summary>
        public static string VerdictBy(bool ratioOk, bool areaOk)
        {
            if (ratioOk && areaOk) return "both";
            if (ratioOk) return "ratio";
            if (areaOk) return "area";
            return "none";
        }

        /// <summary>
        /// 探针自检（CS 教训 4 的同类：探针要能自己否定自己）。
        /// 任一成立即 suspicious：`garments_used == 0` / `keys_resolved` 为空 /
        /// 所有键都 `uncovered` / `garments_used / garments_considered < 0.2`。
        /// reason 为中文，便于直接进产出；不可疑时 reason=null。
        /// </summary>
        public static bool SelfCheckSuspicious(int considered, int used, int keysTotal, int keysUncovered, out string reason)
        {
            var reasons = new List<string>();
            if (used <= 0) reasons.Add("garments_used == 0（一件可见服装都没进遮挡集合）");
            if (keysTotal <= 0) reasons.Add("keys_resolved 为空（没有可判定的收缩键）");
            else if (keysUncovered >= keysTotal) reasons.Add("所有键都判 uncovered（" + keysUncovered + "/" + keysTotal + "）");
            if (considered > 0 && (double)used / considered < 0.2)
                reasons.Add("garments_used/garments_considered = " + used + "/" + considered + " < 0.2");
            if (reasons.Count == 0) { reason = null; return false; }
            reason = "遮挡集合可能被排除规则吃掉了，结论不可信：" + string.Join("；", reasons.ToArray()) + "。";
            return true;
        }
    }
    // ══════════════════════════════════════════════════════════════════
    // 任务 CU：shrink_cover「外向射线」判据的纯几何层。
    //
    // 为什么：旧的「到衣服表面最近距离 ≤ cover_dist_mm」回答的是「附近有没有布」，不是
    // 「我外面有没有布」——宽松外套离皮肤 1–3 cm，穿着也会被判没遮住；光脚踝旁边就是鞋帮，
    // 10 mm 内有布，裸脚踝反被判「有遮挡」（见 seq_t33_calib 标定表）。改为从身体外向伪法线
    // 方向发射线，50 mm 内打到任一可见服装三角形才算遮住，再加 ±cone_deg 的 4 条锥向射线归票。
    //
    // 本层只引用 System（不碰任何 Unity 类型），好让 perception/selftest_shrink_cover.py 把
    // BEGIN/END 之间整段抽出、与生产共用同一份「射线求交 / 锥向 / 归票」源码；生产中
    // PokeBvh.Raycast 也调用这里的 RayHitsTriangle，自检测到的就是生产跑的那段几何。
    // ══════════════════════════════════════════════════════════════════

    /// <summary>纯几何三维向量（无 Unity 依赖）。字段名 x/y/z 与外部一致，方便转换。</summary>
    public struct ScVec
    {
        public float x, y, z;
        public ScVec(float x, float y, float z) { this.x = x; this.y = y; this.z = z; }
        public static ScVec Add(ScVec a, ScVec b) { return new ScVec(a.x + b.x, a.y + b.y, a.z + b.z); }
        public static ScVec Sub(ScVec a, ScVec b) { return new ScVec(a.x - b.x, a.y - b.y, a.z - b.z); }
        public static ScVec Mul(ScVec a, float s) { return new ScVec(a.x * s, a.y * s, a.z * s); }
        public static float Dot(ScVec a, ScVec b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
        public static ScVec Cross(ScVec a, ScVec b)
        {
            return new ScVec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
        }
        public float Length() { return (float)Math.Sqrt(x * x + y * y + z * z); }
        public ScVec Normalized()
        {
            float l = Length();
            if (l < 1e-12f) return new ScVec(0f, 0f, 0f);
            return new ScVec(x / l, y / l, z / l);
        }
    }

    /// <summary>任务 CU：外向射线的求交、锥向方向与归票（无 Unity 依赖，生产与离线自检共用）。</summary>
    public static class ShrinkCoverRayRules
    {
        public const string RayVoteAny = "any";
        public const string RayVoteMajority = "majority";
        /// <summary>锥向射线数量（不含中轴外向射线）。</summary>
        public const int ConeRayCount = 4;
        /// <summary>一次判定总射线数 = 中轴 1 条 + 锥向 4 条。</summary>
        public const int TotalRayCount = 1 + ConeRayCount;
        /// <summary>majority 的命中门槛（任务 CU 定：≥3 条）。</summary>
        public const int MajorityMin = 3;

        /// <summary>
        /// 射线与三角形求交（Möller–Trumbore，**双面**：服装多为单面网格，从身体往外看打到的是内表面，
        /// 按双面算才判得出「外面有布」）。命中返回 true，t = 沿 dir 的距离（米）；maxDist 外不算命中。
        /// </summary>
        public static bool RayHitsTriangle(ScVec o, ScVec d, float maxDist, ScVec a, ScVec b, ScVec c, out float t)
        {
            t = 0f;
            ScVec e1 = ScVec.Sub(b, a);
            ScVec e2 = ScVec.Sub(c, a);
            ScVec p = ScVec.Cross(d, e2);
            float det = ScVec.Dot(e1, p);
            if (det > -1e-12f && det < 1e-12f) return false;   // 射线与三角形共面/平行
            float inv = 1f / det;
            ScVec tv = ScVec.Sub(o, a);
            float u = ScVec.Dot(tv, p) * inv;
            if (u < -1e-6f || u > 1f + 1e-6f) return false;
            ScVec q = ScVec.Cross(tv, e1);
            float v = ScVec.Dot(d, q) * inv;
            if (v < -1e-6f || u + v > 1f + 1e-6f) return false;
            float tt = ScVec.Dot(e2, q) * inv;
            if (tt < 0f || tt > maxDist) return false;
            t = tt;
            return true;
        }

        /// <summary>绕单位轴 axis 旋转 rad 弧度（Rodrigues）。axis 需已单位化。</summary>
        private static ScVec RotateAbout(ScVec v, ScVec axis, float rad)
        {
            float c = (float)Math.Cos(rad), s = (float)Math.Sin(rad);
            ScVec k = axis.Normalized();
            ScVec rot = ScVec.Add(ScVec.Mul(v, c), ScVec.Mul(ScVec.Cross(k, v), s));
            return ScVec.Add(rot, ScVec.Mul(k, ScVec.Dot(k, v) * (1f - c)));
        }

        /// <summary>
        /// n（外向单位法线）的 5 条射线方向：index 0 = n 本身，1..4 = 绕两个正交切轴 ±coneDeg 的锥向。
        /// 切轴取法与 poke 外壳的 PokeBasis 同口径（|n·up| &gt; 0.9 时换 right 作参考），保证同一套锥。
        /// </summary>
        public static ScVec[] ConeDirections(ScVec n, float coneDeg)
        {
            ScVec nn = n.Normalized();
            ScVec up = Math.Abs(nn.y) < 0.9f ? new ScVec(0f, 1f, 0f) : new ScVec(1f, 0f, 0f);
            ScVec t1 = ScVec.Cross(nn, up);
            if (t1.Length() < 1e-12f) t1 = new ScVec(1f, 0f, 0f);
            t1 = t1.Normalized();
            ScVec t2 = ScVec.Cross(nn, t1).Normalized();
            float rad = coneDeg * (float)Math.PI / 180f;
            var dirs = new ScVec[TotalRayCount];
            dirs[0] = nn;
            dirs[1] = RotateAbout(nn, t1, rad);
            dirs[2] = RotateAbout(nn, t1, -rad);
            dirs[3] = RotateAbout(nn, t2, rad);
            dirs[4] = RotateAbout(nn, t2, -rad);
            return dirs;
        }

        /// <summary>归票：any = 任一条命中即遮住；majority = 命中 ≥ 3 条。rule 为空按 any。</summary>
        public static bool RuleSatisfied(string rule, int hits, int totalRays)
        {
            if (totalRays <= 0) return false;
            string r = string.IsNullOrEmpty(rule) ? RayVoteAny : rule.Trim().ToLowerInvariant();
            if (r == RayVoteMajority) return hits >= MajorityMin;
            return hits >= 1;
        }

        /// <summary>
        /// 单条射线在一组三角形里找最近命中（平面顶点数组 xyz 连续 + 三角索引），返回面序号，未命中 -1。
        /// 生产走 PokeBvh.Raycast（BVH 加速）；这里只给离线自检与无 BVH 场合用。
        /// </summary>
        public static int NearestHit(float[] flat, int[] tris, ScVec o, ScVec d, float maxDist, out float t)
        {
            t = float.MaxValue;
            int best = -1;
            if (flat == null || tris == null) return -1;
            int fn = tris.Length / 3;
            float bestT = maxDist;
            for (int f = 0; f < fn; f++)
            {
                int i0 = tris[3 * f] * 3, i1 = tris[3 * f + 1] * 3, i2 = tris[3 * f + 2] * 3;
                if (i0 < 0 || i1 < 0 || i2 < 0) continue;
                if (i0 + 2 >= flat.Length || i1 + 2 >= flat.Length || i2 + 2 >= flat.Length) continue;
                var a = new ScVec(flat[i0], flat[i0 + 1], flat[i0 + 2]);
                var b = new ScVec(flat[i1], flat[i1 + 1], flat[i1 + 2]);
                var c = new ScVec(flat[i2], flat[i2 + 1], flat[i2 + 2]);
                float tt;
                if (RayHitsTriangle(o, d, bestT, a, b, c, out tt) && tt < bestT) { bestT = tt; best = f; }
            }
            if (best >= 0) t = bestT;
            return best;
        }

        /// <summary>
        /// 单个顶点对一组三角形（平面数组）的外向射线命中票数（0..5）：从 pos + n*originM 沿 n 及 4 条锥向
        /// 各发一条、长度 rayM，某条命中任一三角形即计 1 票。供离线自检；生产同一几何走 BVH。
        /// </summary>
        public static int RayVotesOnTriangles(ScVec pos, ScVec n, float[] flat, int[] tris,
            float originM, float rayM, float coneDeg)
        {
            if (flat == null || tris == null) return 0;
            ScVec nn = n.Normalized();
            if (nn.Length() < 1e-12f) return 0;
            ScVec[] dirs = ConeDirections(nn, coneDeg);
            ScVec origin = ScVec.Add(pos, ScVec.Mul(nn, originM));
            int votes = 0;
            for (int i = 0; i < dirs.Length; i++)
            {
                float t;
                if (NearestHit(flat, tris, origin, dirs[i], rayM, out t) >= 0) votes++;
            }
            return votes;
        }
    }
    // <<< SHRINK_COVER_RULES_END
}
