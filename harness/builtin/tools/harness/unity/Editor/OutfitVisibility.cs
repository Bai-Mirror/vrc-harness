// 【项目沉淀】通用工具（Harness outfit 阶段的可见性清单与重叠量距）
// 适用素体：无关（素体预制体与服装预制体都由方案指定）
// 工具链　：Unity 2022.3 批处理；VRChat SDK3 Avatars；Modular Avatar 1.18
// 可复用性：★★★ 换个单子直接能用
// 用途　　：按 D-138，在装配完成（LocalOperations.Apply 之后）对装配产物的默认状态量两件事，写
//           Assets/_Harness/Outfit/visibility.json 给执行方，并把计数交给 outfit 的阻断判据：
//           ① 默认可见的部件清单：路径、来源（body / outfit:<id>）、来源内部件路径、顶点与三角面数；
//           ② 每对可见部件在同一位置的互接触面积 A_mutual(ε)（ε=0.1 mm，三角面三个顶点都在带内才计），
//              以及素体包里厂商自己成组开关的部件组（预制体差集 / 厂商 FX 动画的 m_IsActive 绑定）。
//           量法来源：OV1 车道在头像 A 上的 987 对扫描（报告 `OV1-stacked-meshes.md` §4）；阈值
//           t.overlap_contact_epsilon_mm / t.overlap_contact_min_cm2 见 knowledge/process/thresholds.yaml。
//           口径限制（OV1 实测，照抄不重犯）：不认资产名、目录习惯或层名；素体皮肤网格（身份来自
//           AuditBodyPick，由 AuditPartInventory.BodyIdentity 转出）不参与重叠计数，「身体穿出衣物」
//           交给回归阶段的贴合探针；有符号侧在开口薄壳上会翻转，故本工具只量距离与面积。
//           只读：只读网格与资产，除写出 visibility.json 外不改工程。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEngine;

namespace AVH.Harness
{
    /// <summary>
    /// D-138 default-state visibility inventory of the assembled avatar. Measured on the persisted
    /// artifact (after local operations were applied), never on what an assembly record claims.
    /// </summary>
    public static class OutfitVisibility
    {
        public const string Dir = OutfitStage.Dir;
        public const string Path = Dir + "/visibility.json";
        public const string Schema = "outfit-visibility/0.1";

        /// <summary>Band half-width used by A_mutual. Must equal thresholds.yaml t.overlap_contact_epsilon_mm.</summary>
        public const float EpsilonMm = 0.1f;
        /// <summary>Contact area above which a pair is a stacked overlap. Must equal t.overlap_contact_min_cm2.</summary>
        public const double MinContactCm2 = 1.0;
        /// <summary>Pairs below this are counted but not listed: the document carries the evidence, not the tail.</summary>
        public const double ListedContactCm2 = 0.01;

        /// <summary>
        /// GI1 (`D-143`): the near band that decides which of two garments is the inner one. A vertex of one
        /// garment takes part in the inside/outside census only when the other surface is within this distance of
        /// it; most of an inner layer's near vertices lie under the outer one, so the sign of the census gives the
        /// order. Kept at the calibrated width — the order rule was measured with it.
        /// </summary>
        public const float LayerReachMm = 1.0f;
        /// <summary>
        /// GI2 (`D-145`): the instrument's depth range. It is deliberately the same as the calibrated near band
        /// (<see cref="LayerReachMm"/>) rather than a wider sweep: a vertex's signed distance to the nearest outer
        /// triangle is a local surface separation, not proof that it crossed the outer garment's fabric. Widening
        /// the sweep was measured on A and read a stocking below a coat's hem and a stocking inside a boot shaft as
        /// 2.7-3.0 mm "pokes", turning 0 blocking pairs into 23. So the range stays at the calibrated band, and a
        /// pair whose deepest confirmed sample only reaches it is reported as a lower bound ("at least") with
        /// <see cref="PairReading.DepthAtLeast"/>; an `accept` needs a depth actually measured below the guard.
        /// Must equal thresholds.yaml t.visible_interpenetration_poke_reach_mm.
        /// </summary>
        public const float PokeReachMm = 1.0f;
        /// <summary>
        /// GI1: share of one garment's near-band vertices that must lie INSIDE the other before it is called the
        /// inner layer of the pair. Most vertices of an inner layer, where it runs close to the outer one, are
        /// inside it; a layer worn outside has almost none.
        /// </summary>
        public const double InnerMajorityRatio = 0.5;
        /// <summary>
        /// GI1: how far in front of a vertex another surface of the same garment still counts as covering it. A
        /// garment is not one surface — a coat's lining runs a few millimetres inside its shell — so an inner
        /// garment that lies between the two is under the coat, not outside it. A vertex on the outer side of the
        /// nearest face is therefore only a poke when no other face of that garment lies in front of it within
        /// this distance.
        /// </summary>
        public const float CoverReachMm = 3.0f;
        /// <summary>
        /// GI1: the calibrated minimum. A pair counts as a visible interpenetration only when at least this many
        /// of its candidate vertices are confirmed in the rendered picture. Must equal
        /// thresholds.yaml t.visible_interpenetration_min_vertices.
        /// </summary>
        public const int MinVisibleInterpenetrationVertices = 8;
        /// <summary>
        /// GI1 (`D-143` ③): the guard rails. The orderer's criterion is a judgement the executor makes pair by
        /// pair against the evidence; these two coarse bounds only stop the obvious overreach, so that a broad,
        /// deep interpenetration cannot be waved through as "fine". They are deliberately loose and are NOT tuned
        /// so that any particular avatar passes: a skirt flipping out of a coat crosses them, a thin film where
        /// two tight layers cross does not. Must equal thresholds.yaml t.visible_interpenetration_guard_depth_mm
        /// and t.visible_interpenetration_guard_vertices.
        /// </summary>
        public const float GuardVisibleInterpenetrationDepthMm = 2.0f;
        public const int GuardVisibleInterpenetrationVertices = 128;
        /// <summary>
        /// The depths every row reports its confirmed vertex counts at (mm). The largest probe is the instrument's
        /// range (<see cref="PokeReachMm"/>): beyond it the reading is not a measurement, and a pair whose deepest
        /// sample reaches it is marked as a lower bound instead of being shown at a bucket.
        /// </summary>
        static readonly double[] DepthProbesMm = { 0.1, 0.2, 0.3, 0.5, 1.0 };
        /// <summary>
        /// The product's own asset taxonomy (`harness/src/assets/taxonomy.ts` DEFAULT_CATEGORIES): the plan's item
        /// paths carry the client's material folders, which use this vocabulary, so the order role of a source
        /// ("发型", "服装", …) can be read off the plan instead of guessed from an asset name. Kept as the single
        /// statement of the vocabulary here, with a test comparing it to the TypeScript table.
        /// </summary>
        public const string HairCategoryPath = "发型";
        static readonly (string Path, string Role)[] OrderRolePaths =
        {
            ("素体", "body"), ("服装", "outfit"), ("发型", "hair"), ("配饰", "accessory"),
            ("贴图", "texture"), ("玩具", "toy"), ("功能插件", "plugin"),
        };

        /// <summary>How many pairs may be sent to the picture check in one measurement.</summary>
        const int MaxInterpenetrationPairs = 128;
        /// <summary>Most candidate vertices one pair contributes; a denser pair is sampled, never prefixed.</summary>
        const int MaxCandidatesPerPair = 3000;
        /// <summary>Ceiling on candidate vertices across all pairs; beyond it the reading is no_data, not a guess.</summary>
        const int MaxInterpenetrationCandidates = 120000;
        /// <summary>Confirmed pairs whose rows are written into the document.</summary>
        const int MaxInterpenetrationRows = 64;
        /// <summary>Same-view camera settings as the fit probe's render confirmation (`D-139` ① / `D-139`).</summary>
        const int RenderFrameHeight = 900;
        const float RenderDepthToleranceMm = 2.0f;

        /// <summary>
        /// The near band the inside/outside census is taken within: the layer-order rule (`D-143`) was calibrated
        /// with it, so widening the poke census must not move it.
        /// </summary>
        const float ReachMm = LayerReachMm;

        /// <summary>A triangle whose cell footprint exceeds this is queried directly, never lost to the grid.</summary>
        const int MaxCellsPerTriangle = 512;
        const int MaxPrefabs = 64;
        const int MaxClips = 256;
        const int MaxListedPairs = 2048;
        /// <summary>Wall-clock ceiling for the pair phase; a run that hits it reports no_data, never a short count.</summary>
        const double DefaultBudgetMs = 900000;

        /// <summary>How close to the instrument's range counts as "the ceiling": the pair's depth is then a lower
        /// bound. Tight on purpose: a sample strictly below the range is a real measurement, and calling it a
        /// lower bound would block pairs the instrument did measure.</summary>
        const float DepthCeilingToleranceMm = 0.01f;

        static readonly float ReachM = ReachMm / 1000f;
        static readonly float ReachSqr = ReachM * ReachM;
        static readonly float PokeReachM = PokeReachMm / 1000f;
        static readonly float PokeReachSqr = PokeReachM * PokeReachM;
        static readonly float CoverReachM = CoverReachMm / 1000f;
        static readonly float CoverReachSqr = CoverReachM * CoverReachM;
        static readonly string[] OverlapMetrics =
            { "visible_overlap_pairs", "visible_overlap_stacks", "visible_overlap_max_cm2" };
        static readonly string[] InterpenetrationMetrics =
            { "visible_interpenetration_pairs", "visible_interpenetration_max", "visible_interpenetration_undecided",
              "visible_interpenetration_out_of_bounds_accepted", "visible_interpenetration_ask_user" };

        public class Report
        {
            public Dictionary<string, object> Document;
            public readonly Dictionary<string, object> Metrics = new Dictionary<string, object>();
            public readonly List<string> Notes = new List<string>();
            /// <summary>False when the pair phase hit its budget: the counts are a lower bound and must not pass a rule.</summary>
            public bool Complete = true;
            public double ElapsedMs;
            public int VisibleRenderers;
            public int CandidatePairs;
            public int ListedPairs;
            public int OverlapPairs;
            public int Stacks;
            public double MaxContactCm2;
            /// <summary>GI1: render-confirmed visible garment-through-garment interpenetration.</summary>
            public bool InterpenetrationComplete = true;
            public int InterpenetrationCandidatePairs;
            /// <summary>Pairs still blocking: no valid decision, or an out-of-bounds pair accepted instead.</summary>
            public int InterpenetrationPairs;
            public int InterpenetrationUndecided;
            public int InterpenetrationOutOfBoundsAccepted;
            /// <summary>Pairs the executor kept and handed to the user (`ask_user`): decided, never blocking.</summary>
            public int InterpenetrationAskUser;
            public int InterpenetrationConfirmedPairs;
            public int InterpenetrationMax;
            public int InterpenetrationVertices;
            public double InterpenetrationElapsedMs;
            public int UnclassifiedParts;
        }

        /// <summary>Enumerates the visible renderers of the assembled default state and writes visibility.json.</summary>
        public static Report Measure(GameObject avatar, string bodyPrefabPath, List<object> hiddenByDecision = null,
            List<string> outerNotes = null, List<Dictionary<string, object>> decisions = null)
        {
            var report = new Report();
            var notes = report.Notes;
            var document = new Dictionary<string, object> { ["schema"] = Schema, ["epsilon_mm"] = (double)EpsilonMm,
                ["min_contact_cm2"] = MinContactCm2, ["renderers"] = new List<object>(), ["body_parts"] = new List<object>(),
                ["body_sets"] = new List<object>(), ["pairs"] = new List<object>(), ["stacks"] = new List<object>(),
                ["visible_interpenetration"] = new Dictionary<string, object>(),
                ["hidden_by_decision"] = hiddenByDecision ?? new List<object>() };
            report.Document = document;
            if (avatar == null)
            {
                report.Complete = false;
                notes.Add("可见性清单没有装配产物可量");
                Metrics(report); Write(document);
                if (outerNotes != null) outerNotes.AddRange(notes);
                return report;
            }

            var bodyNames = BodyIdentity(bodyPrefabPath, notes);
            var parts = HumanoidParts(avatar);
            var entries = new List<Entry>();
            foreach (var renderer in avatar.GetComponentsInChildren<Renderer>(true))
                if (renderer is SkinnedMeshRenderer || renderer is MeshRenderer)
                {
                    var entry = Build(avatar.transform, renderer, bodyNames);
                    entry.BodyPart = BodyPart(renderer, parts, (entry.Min + entry.Max) * 0.5f, entry.Min != entry.Max);
                    entries.Add(entry);
                }
            report.VisibleRenderers = entries.Count(entry => entry.Visible);
            entries = entries.Where(entry => entry.Visible).OrderBy(entry => entry.Path, StringComparer.Ordinal).ToList();
            report.UnclassifiedParts = entries.Count(entry => entry.BodyPart == UnknownPart);

            // Body skin is the body itself, not a garment: it is listed but never counted as an overlap.
            // Identity comes from the plan's body prefab (AuditBodyPick), never from a name pattern guessed here.
            var counted = entries.Where(entry => !entry.BodySkin && entry.Pos.Length > 0).ToList();
            var candidates = new List<long>();
            for (var i = 0; i < counted.Count; i++)
                for (var j = i + 1; j < counted.Count; j++)
                    if (AabbOverlap(counted[i], counted[j])) candidates.Add(((long)i << 32) | (uint)j);

            var watch = Stopwatch.StartNew();
            var options = new ParallelOptions { MaxDegreeOfParallelism = Math.Max(1, Math.Min(Environment.ProcessorCount, 8)) };
            var grids = new Grid[counted.Count];
            // Every grid is built before the parallel pair phase: the cells are read-only afterwards, which is
            // what makes the shared indices safe to query from several threads at once.
            Parallel.For(0, counted.Count, options, i => { grids[i] = BuildGrid(counted[i]); });
            for (var i = 0; i < counted.Count; i++) counted[i].Index = grids[i];
            var results = new PairResult[candidates.Count];
            var budgetMs = BudgetMs();
            var overBudget = 0;
            Parallel.For(0, candidates.Count, options, k =>
            {
                if (watch.Elapsed.TotalMilliseconds > budgetMs) { results[k] = null; System.Threading.Interlocked.Increment(ref overBudget); return; }
                results[k] = Measure(counted[(int)(candidates[k] >> 32)], counted[(int)(uint)candidates[k]]);
            });
            report.ElapsedMs = watch.Elapsed.TotalMilliseconds;
            report.CandidatePairs = candidates.Count;

            var pairs = new List<PairResult>();
            foreach (var result in results) if (result != null) pairs.Add(result);
            if (overBudget > 0)
            {
                report.Complete = false;
                notes.Add($"可见重叠量距超出预算，{overBudget} 对未量；计数只是下界，判据记 no_data");
            }
            report.OverlapPairs = pairs.Count(pair => pair.ContactCm2 >= MinContactCm2);
            report.MaxContactCm2 = pairs.Count == 0 ? 0 : pairs.Max(pair => pair.ContactCm2);
            var listed = pairs.Where(pair => pair.ContactCm2 >= ListedContactCm2).OrderByDescending(pair => pair.ContactCm2).ToList();
            report.ListedPairs = listed.Count;
            var heavy = listed.Where(pair => pair.ContactCm2 >= MinContactCm2).ToList();
            var stacks = Stacks(heavy, out var stackMembers);
            report.Stacks = stacks;

            // ── GI1 (`D-143`): garment-through-garment interpenetration ─────────────────────────────────
            // Candidate pairs ride on the pair measurement above: AABB-intersecting garments with vertices
            // inside the reach band, whose inner/outer order the census resolved, and whose inner layer has
            // vertices on the outside of the outer one. Only the picture check then decides which of them is
            // visible; the ray half only proposes.
            var layerCandidates = pairs.Where(pair => pair.Layer != null && pair.LayerVertices.Count > 0)
                .OrderBy(pair => pair.MinMm).ThenBy(pair => pair.Layer, StringComparer.Ordinal).ThenBy(pair => pair.Outer, StringComparer.Ordinal)
                .ToList();
            // An incomplete pair phase means the candidate list itself is a lower bound, so the picture check
            // cannot turn it into a count either: both readings go no_data together.
            if (!report.Complete) report.InterpenetrationComplete = false;
            report.InterpenetrationCandidatePairs = layerCandidates.Count;
            if (layerCandidates.Count > MaxInterpenetrationPairs)
            {
                report.InterpenetrationComplete = false;
                notes.Add($"衣物互穿候选对 {layerCandidates.Count} 对超过一次确认的上限 {MaxInterpenetrationPairs}，"
                    + $"只确认最近的前 {MaxInterpenetrationPairs} 对；读数只是下界，判据记 no_data");
                layerCandidates = layerCandidates.Take(MaxInterpenetrationPairs).ToList();
            }
            // `D-149`: the order role of every source is evidence the executor reads before deciding that an
            // accessory set yields to the main clothing, so it travels with the by-body-part list as well as with
            // the interpenetration pairs — resolved from the plan and the intake record, never from a name.
            var roles = OrderRoles(notes);
            var interpenetration = Interpenetrate(avatar, layerCandidates, report, notes,
                PartByPath(entries, notes), roles, hiddenByDecision ?? new List<object>(), decisions);

            document["renderers"] = entries.Select(entry => (object)new Dictionary<string, object>
            {
                ["path"] = entry.Path, ["source"] = entry.Source, ["part"] = entry.Part, ["body_part"] = entry.BodyPart,
                ["visible"] = true, ["vertices"] = entry.Pos.Length, ["triangles"] = entry.Triangles,
            }).ToList();
            document["body_parts"] = BodyPartSections(entries, roles);
            document["body_sets"] = BodySets(bodyPrefabPath, notes);
            document["pairs"] = listed.Take(MaxListedPairs).Select(pair => (object)new Dictionary<string, object>
            {
                ["a"] = pair.A, ["b"] = pair.B, ["contact_cm2"] = Round(pair.ContactCm2),
                ["min_mm"] = Round(pair.MinMm), ["same_source"] = pair.SameSource,
            }).ToList();
            document["stacks"] = stackMembers.Select(members => (object)new Dictionary<string, object>
            {
                ["members"] = members.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList(),
                ["max_contact_cm2"] = Round(heavy.Where(pair => members.Contains(pair.A) || members.Contains(pair.B)).Max(pair => pair.ContactCm2)),
            }).ToList();
            document["visible_interpenetration"] = interpenetration.Document;
            Metrics(report);
            foreach (var pair in heavy.Take(5))
                notes.Add($"可见重叠：{pair.A} ↔ {pair.B} 互接触 {pair.ContactCm2:0.###} cm²（min {pair.MinMm:0.####} mm）");
            if (listed.Count > MaxListedPairs) notes.Add($"互接触 ≥{ListedContactCm2} cm² 的对共 {listed.Count} 对，只列前 {MaxListedPairs} 对");
            foreach (var row in interpenetration.Pairs.Where(pair => pair.Counted).Take(5))
                notes.Add($"衣物互穿：{row.Layer} 从 {row.Outer} 里穿出，确认 {row.Confirmed} 个顶点"
                    + $"（可见像素 {row.PixelCount}，最深 {DepthText(row)}，中位 {row.DepthMedianMm:0.###} mm，"
                    + $"部位 {row.BodyPart}/{row.OuterPart}，来源 {row.LayerSource}({row.LayerRole}) × {row.OuterSource}({row.OuterRole})，"
                    + $"越界={row.OutOfBounds}，决定={row.Decision}）；判据按未解决计入阻断");
            if (report.UnclassifiedParts > 0)
                notes.Add($"可见渲染器里有 {report.UnclassifiedParts} 件没有归到身体部位（清单里记「{UnknownPart}」）");
            Write(document);
            Avh.Log($"PERF OutfitVisibility visible={report.VisibleRenderers} aabb_pairs={report.CandidatePairs} listed={report.ListedPairs}"
                + $" overlap={report.OverlapPairs} interpenetration_candidates={report.InterpenetrationCandidatePairs}"
                + $" interpenetration={report.InterpenetrationPairs} undecided={report.InterpenetrationUndecided}"
                + $" out_of_bounds_accepted={report.InterpenetrationOutOfBoundsAccepted} ask_user={report.InterpenetrationAskUser} max={report.InterpenetrationMax}"
                + $" elapsed={report.ElapsedMs:F0}ms interpenetration_elapsed={report.InterpenetrationElapsedMs:F0}ms");
            if (outerNotes != null) outerNotes.AddRange(notes);
            return report;
        }

        /// <summary>The blocking counters. Any of them missing is no_data for the rule, never a zero.</summary>
        public static void Metrics(Report report)
        {
            if (report == null) return;
            if (!report.Complete)
            {
                foreach (var name in OverlapMetrics) report.Metrics[name] = null;
                report.Metrics["visible_overlap_measured"] = false;
            }
            else
            {
                report.Metrics["visible_overlap_pairs"] = report.OverlapPairs;
                report.Metrics["visible_overlap_stacks"] = report.Stacks;
                report.Metrics["visible_overlap_max_cm2"] = Round(report.MaxContactCm2);
                report.Metrics["visible_overlap_measured"] = true;
                report.Metrics["visible_renderers"] = report.VisibleRenderers;
                report.Metrics["visible_overlap_candidate_pairs"] = report.CandidatePairs;
                report.Metrics["visible_overlap_listed_pairs"] = report.ListedPairs;
                report.Metrics["visible_overlap_elapsed_ms"] = (long)report.ElapsedMs;
                report.Metrics["visible_part_unclassified"] = report.UnclassifiedParts;
            }
            // GI1: a run that did not finish the picture check reports no_data, never a zero. Every counter of the
            // reading is written together, so a rule can never read one of them and miss the state of the whole.
            if (!report.Complete || !report.InterpenetrationComplete)
            {
                foreach (var name in InterpenetrationMetrics) report.Metrics[name] = null;
                report.Metrics["visible_interpenetration_measured"] = false;
                return;
            }
            report.Metrics["visible_interpenetration_pairs"] = report.InterpenetrationPairs;
            report.Metrics["visible_interpenetration_max"] = report.InterpenetrationMax;
            report.Metrics["visible_interpenetration_undecided"] = report.InterpenetrationUndecided;
            report.Metrics["visible_interpenetration_out_of_bounds_accepted"] = report.InterpenetrationOutOfBoundsAccepted;
            report.Metrics["visible_interpenetration_ask_user"] = report.InterpenetrationAskUser;
            report.Metrics["visible_interpenetration_measured"] = true;
            report.Metrics["visible_interpenetration_candidate_pairs"] = report.InterpenetrationCandidatePairs;
            report.Metrics["visible_interpenetration_confirmed_pairs"] = report.InterpenetrationConfirmedPairs;
            report.Metrics["visible_interpenetration_vertices"] = report.InterpenetrationVertices;
            report.Metrics["visible_interpenetration_elapsed_ms"] = (long)report.InterpenetrationElapsedMs;
        }

        /// <summary>Adds the report's counters to a stage observation; null on failure so the rule sees no_data.</summary>
        public static void Apply(Dictionary<string, object> metrics, Report report)
        {
            if (report == null)
            {
                foreach (var name in OverlapMetrics) metrics[name] = null;
                metrics["visible_overlap_measured"] = false;
                foreach (var name in InterpenetrationMetrics) metrics[name] = null;
                metrics["visible_interpenetration_measured"] = false;
                return;
            }
            foreach (var pair in report.Metrics) metrics[pair.Key] = pair.Value;
        }

        static double BudgetMs()
        {
            var configured = Avh.Env("AVH_OVERLAP_BUDGET_MS");
            return double.TryParse(configured, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) && value > 0
                ? value : DefaultBudgetMs;
        }

        static void Write(Dictionary<string, object> document)
        {
            OutfitStage.EnsureFolder(Dir);
            Avh.WriteJson(Avh.Abs(Path), document);
        }

        static double Round(double value) => Math.Round(value, 6);

        // ── body identity and source classification ──────────────────────────────────────────────────
        /// <summary>
        /// The plan's body prefab reduced to its base-body mesh names by the audit tool's shared criterion
        /// (RG1). Identity, not a heuristic: a Kipfel-style `Body` face mesh is named like the torso mesh,
        /// so only the tool that knows the whole family may decide which renderers are the body.
        /// </summary>
        static HashSet<string> BodyIdentity(string bodyPrefabPath, List<string> notes)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(bodyPrefabPath)) { notes.Add("方案没有 body_prefab：素体皮肤身份未知，重叠计数可能把素体算进来"); return names; }
            List<string> identity;
            try { identity = global::AvatarAudit.AuditPartInventory.BodyIdentity(bodyPrefabPath) ?? new List<string>(); }
            catch (Exception error) { notes.Add("素体身份读取失败：" + error.Message); return names; }
            foreach (var name in identity) if (!string.IsNullOrEmpty(name)) names.Add(name.Trim());
            if (names.Count == 0) notes.Add($"素体预制体里没有认出身体网格：{bodyPrefabPath}");
            return names;
        }

        static bool InAssemblyLayer(string path) => path == OutfitStage.Group
            || path.StartsWith(OutfitStage.Group + "/", StringComparison.Ordinal);

        static string SourceOf(string path)
        {
            if (!InAssemblyLayer(path)) return "body";
            var rest = path.Length == OutfitStage.Group.Length ? "" : path.Substring(OutfitStage.Group.Length + 1);
            var first = rest.Split('/')[0];
            return "outfit:" + (first.StartsWith("Outfit_", StringComparison.Ordinal) ? first.Substring("Outfit_".Length) : first);
        }

        static string PartOf(string path) => InAssemblyLayer(path) ? path.Substring(OutfitStage.Group.Length + 1) : path;

        // ── one visible renderer ─────────────────────────────────────────────────────────────────────
        class Entry
        {
            public string Path, Source, Part;
            /// <summary>`D-143`: the body part this renderer hangs on, one of ten names or <see cref="UnknownPart"/>.</summary>
            public string BodyPart = UnknownPart;
            public bool BodySkin, Visible;
            public Vector3[] Pos;
            public int[] Tris;
            public int Triangles;
            public Vector3 Min, Max;
            public Grid Index;
        }

        // ── body parts (`D-143`) ─────────────────────────────────────────────────────────────────────
        public const string UnknownPart = "其他";
        /// <summary>The ten parts the record may name, in the order the summary lists them.</summary>
        public static readonly string[] BodyPartOrder =
            { "头", "颈", "胸", "腰臀", "上臂", "前臂", "手", "大腿", "小腿", "脚", UnknownPart };

        /// <summary>
        /// The avatar's humanoid bones, as the skeleton the classification walks. Unity's own enum is the
        /// vocabulary — never a bone name read out of the asset — so the tool carries no vendor naming habit.
        /// </summary>
        static Dictionary<Transform, string> HumanoidParts(GameObject avatar)
        {
            var map = new Dictionary<Transform, string>();
            var animator = avatar.GetComponent<Animator>();
            if (animator == null || !animator.isHuman) return map;
            foreach (HumanBodyBones bone in Enum.GetValues(typeof(HumanBodyBones)))
            {
                if (bone == HumanBodyBones.LastBone) continue;
                Transform transform = null;
                try { transform = animator.GetBoneTransform(bone); } catch { }
                if (transform != null) map[transform] = PartName(bone.ToString());
            }
            return map;
        }

        /// <summary>Unity's humanoid bone name reduced to a body part; side prefixes carry no meaning here.</summary>
        static string PartName(string bone)
        {
            if (bone.StartsWith("Left", StringComparison.Ordinal)) bone = bone.Substring(4);
            else if (bone.StartsWith("Right", StringComparison.Ordinal)) bone = bone.Substring(5);
            switch (bone)
            {
                case "Head": case "Eye": case "Jaw": return "头";
                case "Neck": return "颈";
                case "Chest": case "UpperChest": case "Shoulder": return "胸";
                case "Spine": case "Hips": return "腰臀";
                case "UpperArm": return "上臂";
                case "LowerArm": return "前臂";
                case "Hand": return "手";
                case "UpperLeg": return "大腿";
                case "LowerLeg": return "小腿";
                case "Foot": case "Toes": return "脚";
            }
            // Fingers are separate bones in newer versions of the enum; they are all the hand.
            if (bone.StartsWith("Thumb", StringComparison.Ordinal) || bone.StartsWith("Index", StringComparison.Ordinal)
                || bone.StartsWith("Middle", StringComparison.Ordinal) || bone.StartsWith("Ring", StringComparison.Ordinal)
                || bone.StartsWith("Little", StringComparison.Ordinal)) return "手";
            return UnknownPart;
        }

        /// <summary>Parent chain up to the nearest humanoid bone (the criterion RG1's probe uses), or null.</summary>
        static string NearestPart(Transform start, Dictionary<Transform, string> parts, Transform root)
        {
            for (var current = start; current != null; current = current.parent)
            {
                if (parts.TryGetValue(current, out var part)) return part;
                if (current == root) break;
            }
            return null;
        }

        /// <summary>
        /// The bridges from a vendor bone to the animator's humanoid bones. The assembled prefab is measured
        /// BEFORE NDMF merges the armature, so a garment's own bones are still the vendor's copies: they reach the
        /// humanoid skeleton either directly (the body's own meshes), through a Modular Avatar bone proxy, or
        /// through the merge armature's own bone mapping. Both bridges are the vendor plugin's own structures, so
        /// no bone name, layer name or asset name is read here.
        /// </summary>
        sealed class BoneBridge
        {
            readonly Dictionary<Transform, string> parts;
            readonly Transform root;
            readonly Dictionary<ModularAvatarMergeArmature, Dictionary<Transform, Transform>> mappings =
                new Dictionary<ModularAvatarMergeArmature, Dictionary<Transform, Transform>>();

            public BoneBridge(Dictionary<Transform, string> parts, Transform root) { this.parts = parts; this.root = root; }

            /// <summary>Body part of the nearest humanoid bone at or above <paramref name="start"/>, or null.</summary>
            public string Part(Transform start, int depth = 0)
            {
                if (start == null || depth > 4) return null;
                var merge = start.GetComponentInParent<ModularAvatarMergeArmature>();
                var mapping = merge == null ? null : Mapping(merge);
                for (var current = start; current != null; current = current.parent)
                {
                    if (parts.TryGetValue(current, out var part)) return part;
                    var proxy = current.GetComponent<ModularAvatarBoneProxy>();
                    if (proxy != null && proxy.target != null && proxy.target != current)
                    {
                        var throughProxy = Part(proxy.target, depth + 1);
                        if (throughProxy != null) return throughProxy;
                    }
                    if (mapping != null && mapping.TryGetValue(current, out var baseBone))
                        for (var up = baseBone; up != null; up = up.parent)
                            if (parts.TryGetValue(up, out var mapped)) return mapped;
                    if (current == root) break;
                }
                return null;
            }

            /// <summary>An armature's own bone mapping, read once and keyed by the armature's bone (the vendor's
            /// copy) — `GetBonesMapping` returns (base bone, merged bone) pairs, and the merge target is the body.
            /// Null when the armature names no merge target.</summary>
            Dictionary<Transform, Transform> Mapping(ModularAvatarMergeArmature merge)
            {
                if (mappings.TryGetValue(merge, out var cached)) return cached;
                var map = new Dictionary<Transform, Transform>();
                try
                {
                    var pairs = merge.GetBonesMapping();
                    if (pairs != null) foreach (var pair in pairs) map[pair.Item2] = pair.Item1;
                }
                catch { }
                mappings[merge] = map;
                return map;
            }
        }

        /// <summary>
        /// `D-143`: one visible renderer's body part, read from the rig and never from a name. A skinned mesh is
        /// classified by skin weight — the part carrying the largest total weight wins — because a garment's own
        /// root says nothing about where it sits and its bones are the vendor's copies until the build merges
        /// them. An unskinned mesh, or one the weights cannot answer for, is classified by the nearest humanoid
        /// bone on its parent chain, and failing that by the humanoid bone nearest its own geometry. A renderer
        /// that reaches none of them is recorded as <see cref="UnknownPart"/> rather than guessed.
        /// </summary>
        static string BodyPart(Renderer renderer, Dictionary<Transform, string> parts, Vector3 centre, bool hasExtent)
        {
            if (parts.Count == 0) return UnknownPart;
            var bridge = new BoneBridge(parts, renderer.transform.root);
            var skin = renderer as SkinnedMeshRenderer;
            if (skin != null)
            {
                var byWeight = PartByWeight(skin, bridge);
                if (byWeight != null) return byWeight;
            }
            var byChain = bridge.Part(renderer.transform);
            if (byChain != null) return byChain;
            // Last resort: the humanoid bone nearest the mesh itself. Only a mesh with real extent can answer
            // this — a degenerate bounds would send every unreadable mesh to whichever bone is nearest the origin.
            return hasExtent ? NearestPart(centre, parts) : UnknownPart;
        }

        /// <summary>
        /// The body part carrying the most vertices, where each vertex is assigned to the humanoid bone holding its
        /// largest skin weight. Counting vertices rather than raw weight matters: a hand is driven by fifteen bones
        /// per side, so a sum over weights lets many small finger influences outvote the torso of a body mesh.
        /// Both the modern and the legacy weight APIs are tried — the probe uses the same pair — and null means the
        /// mesh carries no readable weights at all.
        /// </summary>
        static string PartByWeight(SkinnedMeshRenderer skin, BoneBridge bridge)
        {
            var votes = new Dictionary<string, int>(StringComparer.Ordinal);
            var bones = skin.bones;
            if (bones == null) return null;
            try
            {
                var counts = skin.sharedMesh.GetBonesPerVertex();
                var all = skin.sharedMesh.GetAllBoneWeights();
                if (counts.Length > 0 && all.Length > 0)
                {
                    var index = 0;
                    for (var vertex = 0; vertex < counts.Length; vertex++)
                    {
                        var bestBone = -1;
                        var bestWeight = 0f;
                        for (var influence = 0; influence < counts[vertex] && index < all.Length; influence++, index++)
                            if (all[index].weight > bestWeight) { bestWeight = all[index].weight; bestBone = all[index].boneIndex; }
                        Vote(votes, bridge, bones, bestBone);
                    }
                }
            }
            catch { }
            if (votes.Count == 0)
            {
                try
                {
                    var legacy = skin.sharedMesh.boneWeights;
                    if (legacy != null && legacy.Length > 0)
                        for (var vertex = 0; vertex < legacy.Length; vertex++)
                        {
                            var weight = legacy[vertex];
                            var bestBone = weight.boneIndex0;
                            var bestWeight = weight.weight0;
                            if (weight.weight1 > bestWeight) { bestWeight = weight.weight1; bestBone = weight.boneIndex1; }
                            if (weight.weight2 > bestWeight) { bestWeight = weight.weight2; bestBone = weight.boneIndex2; }
                            if (weight.weight3 > bestWeight) { bestWeight = weight.weight3; bestBone = weight.boneIndex3; }
                            Vote(votes, bridge, bones, bestBone);
                        }
                }
                catch { }
            }
            return votes.Count == 0 ? null : Best(votes);
        }

        static void Vote(Dictionary<string, int> votes, BoneBridge bridge, Transform[] bones, int boneIndex)
        {
            if (boneIndex < 0 || boneIndex >= bones.Length) return;
            var part = bridge.Part(bones[boneIndex]);
            if (part == null) return;
            votes.TryGetValue(part, out var count);
            votes[part] = count + 1;
        }

        /// <summary>The humanoid bone nearest a world point: the last resort when the rig gives no answer.</summary>
        static string NearestPart(Vector3 point, Dictionary<Transform, string> parts)
        {
            string best = null;
            var bestDistance = float.MaxValue;
            foreach (var pair in parts)
            {
                var distance = (pair.Key.position - point).sqrMagnitude;
                // Ties are broken by part name so the same avatar always answers the same way.
                if (distance < bestDistance - 1e-9f || (Math.Abs(distance - bestDistance) <= 1e-9f
                    && best != null && string.CompareOrdinal(pair.Value, best) < 0))
                { bestDistance = distance; best = pair.Value; }
            }
            return best;
        }

        static string Best(Dictionary<string, float> weights)
        {
            string best = null;
            var bestWeight = 0f;
            foreach (var pair in weights.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                if (pair.Value > bestWeight) { best = pair.Key; bestWeight = pair.Value; }
            return best;
        }

        static string Best(Dictionary<string, int> weights)
        {
            string best = null;
            var bestCount = 0;
            foreach (var pair in weights.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                if (pair.Value > bestCount) { best = pair.Key; bestCount = pair.Value; }
            return best;
        }

        /// <summary>
        /// `D-143`: the visible parts grouped by body part and then by source, so two parts of one body part from
        /// different sources (two pairs of ears, two pairs of shoes) are readable at a glance. `D-149` adds each
        /// source's role in the order, so "the accessory set yields to the main clothing" can be applied from the
        /// evidence instead of from an asset name.
        /// </summary>
        static List<object> BodyPartSections(List<Entry> entries, Dictionary<string, string> roles)
        {
            var sections = new List<object>();
            foreach (var part in BodyPartOrder)
            {
                var members = entries.Where(entry => entry.BodyPart == part).ToList();
                if (members.Count == 0) continue;
                var bySource = new List<object>();
                foreach (var group in members.GroupBy(entry => entry.Source, StringComparer.Ordinal).OrderBy(group => group.Key, StringComparer.Ordinal))
                    bySource.Add(new Dictionary<string, object>
                    {
                        ["source"] = group.Key,
                        ["role"] = RoleOf(roles, group.First().Path),
                        ["paths"] = group.Select(entry => entry.Path).OrderBy(path => path, StringComparer.Ordinal).Cast<object>().ToList(),
                    });
                sections.Add(new Dictionary<string, object>
                { ["part"] = part, ["count"] = members.Count, ["by_source"] = bySource });
            }
            return sections;
        }

        // A hierarchy path is intentionally the existing public reference format. Unity permits same-named
        // siblings, so the path is not a renderer identity. Keep every renderer in the measurement, and only
        // expose a body-part label when all renderers sharing a path agree; otherwise do not silently choose one.
        static Dictionary<string, string> PartByPath(List<Entry> entries, List<string> notes)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var group in entries.GroupBy(entry => entry.Path, StringComparer.Ordinal))
            {
                var parts = group.Select(entry => entry.BodyPart).Distinct(StringComparer.Ordinal).ToList();
                result[group.Key] = parts.Count == 1 ? parts[0] : UnknownPart;
                if (parts.Count > 1)
                    notes.Add($"同一路径的可见渲染器身体部位不一致，按 {UnknownPart} 记录：{group.Key}");
            }
            return result;
        }

        static bool Finite(Vector3 v) => !(float.IsNaN(v.x) || float.IsInfinity(v.x) || float.IsNaN(v.y) || float.IsInfinity(v.y)
            || float.IsNaN(v.z) || float.IsInfinity(v.z));

        static bool IsVisible(Renderer renderer)
        {
            if (!renderer.enabled || !renderer.gameObject.activeInHierarchy) return false;
            for (var t = renderer.transform; t != null; t = t.parent) if (t.CompareTag("EditorOnly")) return false;
            return true;
        }

        static Entry Build(Transform root, Renderer renderer, HashSet<string> bodyNames)
        {
            var entry = new Entry { Path = Probe.HierarchyPath(root, renderer.transform) };
            entry.Source = SourceOf(entry.Path);
            entry.Part = PartOf(entry.Path);
            entry.Visible = IsVisible(renderer);
            // The assembly layer can only hold garments, so a same-named renderer under `_Outfit/Outfit_x`
            // (a vendor stocking called Body_Stocking) is not the body even though the name matches.
            entry.BodySkin = bodyNames.Contains(renderer.gameObject.name) && !InAssemblyLayer(entry.Path);
            var skin = renderer as SkinnedMeshRenderer;
            var mesh = skin != null ? skin.sharedMesh
                : renderer.GetComponent<MeshFilter>() != null ? renderer.GetComponent<MeshFilter>().sharedMesh : null;
            if (mesh == null) { entry.Pos = new Vector3[0]; entry.Tris = new int[0]; return entry; }
            if (skin != null)
            {
                var baked = new Mesh { indexFormat = UnityEngine.Rendering.IndexFormat.UInt32, hideFlags = HideFlags.HideAndDontSave };
                // Bake convention shared with the fit probe (AuditFitProbe.cs:744-793): BakeMesh(baked, true)
                // leaves vertices in the renderer's local space with the transform scale compensated, so the
                // full localToWorldMatrix is what puts them in world space.
                skin.BakeMesh(baked, true);
                entry.Pos = World(baked.vertices, skin.transform.localToWorldMatrix);
                entry.Tris = SafeTriangles(baked);
                UnityEngine.Object.DestroyImmediate(baked);
            }
            else
            {
                entry.Pos = World(mesh.vertices, renderer.transform.localToWorldMatrix);
                entry.Tris = SafeTriangles(mesh);
            }
            entry.Triangles = entry.Tris.Length / 3;
            var min = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
            var max = new Vector3(float.MinValue, float.MinValue, float.MinValue);
            var finite = 0;
            foreach (var point in entry.Pos)
            {
                // Imported meshes really do carry non-finite vertices; a NaN bound would make every later
                // cell index meaningless, so the bounds come from finite vertices only.
                if (!Finite(point)) continue;
                min = Vector3.Min(min, point); max = Vector3.Max(max, point); finite++;
            }
            entry.Min = finite == 0 ? Vector3.zero : min;
            entry.Max = finite == 0 ? Vector3.zero : max;
            return entry;
        }

        static Vector3[] World(Vector3[] local, Matrix4x4 matrix)
        {
            var world = new Vector3[local.Length];
            for (var i = 0; i < local.Length; i++) world[i] = matrix.MultiplyPoint3x4(local[i]);
            return world;
        }

        static int[] SafeTriangles(Mesh mesh) { try { return mesh.triangles; } catch { return new int[0]; } }

        static bool AabbOverlap(Entry a, Entry b) => a.Min.x <= b.Max.x && a.Max.x >= b.Min.x
            && a.Min.y <= b.Max.y && a.Max.y >= b.Min.y && a.Min.z <= b.Max.z && a.Max.z >= b.Min.z;

        // ── uniform grid of one surface's triangles (built once, reused by every pair) ───────────────
        class Grid
        {
            public float Cell = 1f;
            public Vector3 Min;
            public readonly Dictionary<long, List<int>> Cells = new Dictionary<long, List<int>>();
            public readonly List<int> Oversized = new List<int>();
        }

        static long Key(int x, int y, int z) => ((long)x << 42) ^ ((long)y << 21) ^ (long)z;

        /// <summary>Clamp a cell index; a NaN or wild coordinate must never decide a loop bound.</summary>
        static int CellIndex(float value, float origin, float cell, int upper)
        {
            var raw = (value - origin) / cell;
            if (float.IsNaN(raw) || float.IsInfinity(raw)) return 0;
            if (raw < 0f) return 0;
            if (raw > upper) return upper;
            return (int)raw;
        }

        static Grid BuildGrid(Entry entry)
        {
            var size = entry.Max - entry.Min;
            var diagonal = size.magnitude;
            // The cell is never smaller than the cover reach, so the 3x3x3 query neighbourhood can always hold
            // every triangle within CoverReachMm of the query point — and therefore every triangle within the
            // poke reach, which is stated no wider than the cover reach for exactly this reason.
            var cell = Mathf.Max(CoverReachM, float.IsNaN(diagonal) || float.IsInfinity(diagonal) ? PokeReachM : diagonal / 32f);
            var grid = new Grid { Cell = cell, Min = entry.Min };
            var nx = Mathf.Max(1, (int)(size.x / cell) + 1);
            var ny = Mathf.Max(1, (int)(size.y / cell) + 1);
            var nz = Mathf.Max(1, (int)(size.z / cell) + 1);
            var tris = entry.Tris;
            for (var t = 0; t + 2 < tris.Length; t += 3)
            {
                int i0 = tris[t], i1 = tris[t + 1], i2 = tris[t + 2];
                if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= entry.Pos.Length || i1 >= entry.Pos.Length || i2 >= entry.Pos.Length) continue;
                Vector3 p0 = entry.Pos[i0], p1 = entry.Pos[i1], p2 = entry.Pos[i2];
                if (!Finite(p0) || !Finite(p1) || !Finite(p2)) continue;
                var low = Vector3.Min(p0, Vector3.Min(p1, p2));
                var high = Vector3.Max(p0, Vector3.Max(p1, p2));
                int x0 = CellIndex(low.x, entry.Min.x, cell, nx), x1 = CellIndex(high.x, entry.Min.x, cell, nx);
                int y0 = CellIndex(low.y, entry.Min.y, cell, ny), y1 = CellIndex(high.y, entry.Min.y, cell, ny);
                int z0 = CellIndex(low.z, entry.Min.z, cell, nz), z1 = CellIndex(high.z, entry.Min.z, cell, nz);
                long span = (long)(x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
                if (span > MaxCellsPerTriangle) { grid.Oversized.Add(t); continue; }
                for (var x = x0; x <= x1; x++)
                    for (var y = y0; y <= y1; y++)
                        for (var z = z0; z <= z1; z++)
                        {
                            var key = Key(x, y, z);
                            if (!grid.Cells.TryGetValue(key, out var list)) { list = new List<int>(); grid.Cells[key] = list; }
                            list.Add(t);
                        }
            }
            return grid;
        }

        static bool InsideReach(Vector3 point, Entry other) => point.x >= other.Min.x - PokeReachM && point.x <= other.Max.x + PokeReachM
            && point.y >= other.Min.y - PokeReachM && point.y <= other.Max.y + PokeReachM
            && point.z >= other.Min.z - PokeReachM && point.z <= other.Max.z + PokeReachM;

        /// <summary>
        /// Distance from a point to the other surface, and the closest point plus the normal of the triangle that
        /// produced it — the "which side of the surface" reading the layer census needs. The normal is left
        /// unnormalized here; the caller normalizes once for the winner.
        /// </summary>
        static float NearestSqr(Vector3 point, Entry other, Grid grid, out Vector3 closest, out Vector3 normal)
        {
            var best = PokeReachSqr;
            closest = point;
            normal = Vector3.zero;
            var nx = Mathf.Max(1, (int)((other.Max.x - other.Min.x) / grid.Cell) + 1);
            var ny = Mathf.Max(1, (int)((other.Max.y - other.Min.y) / grid.Cell) + 1);
            var nz = Mathf.Max(1, (int)((other.Max.z - other.Min.z) / grid.Cell) + 1);
            int cx = CellIndex(point.x, other.Min.x, grid.Cell, nx);
            int cy = CellIndex(point.y, other.Min.y, grid.Cell, ny);
            int cz = CellIndex(point.z, other.Min.z, grid.Cell, nz);
            for (var x = cx - 1; x <= cx + 1; x++)
            {
                if (x < 0 || x > nx) continue;
                for (var y = cy - 1; y <= cy + 1; y++)
                {
                    if (y < 0 || y > ny) continue;
                    for (var z = cz - 1; z <= cz + 1; z++)
                    {
                        if (z < 0 || z > nz) continue;
                        if (!grid.Cells.TryGetValue(Key(x, y, z), out var list)) continue;
                        for (var i = 0; i < list.Count; i++) best = Consider(point, other, list[i], best, ref closest, ref normal);
                    }
                }
            }
            for (var i = 0; i < grid.Oversized.Count; i++) best = Consider(point, other, grid.Oversized[i], best, ref closest, ref normal);
            return best;
        }

        static float Consider(Vector3 point, Entry other, int triangle, float best, ref Vector3 closest, ref Vector3 normal)
        {
            Vector3 a0 = other.Pos[other.Tris[triangle]], a1 = other.Pos[other.Tris[triangle + 1]], a2 = other.Pos[other.Tris[triangle + 2]];
            var onTriangle = ClosestOnTriangle(point, a0, a1, a2);
            var distance = (point - onTriangle).sqrMagnitude;
            if (distance >= best) return best;
            closest = onTriangle;
            normal = Vector3.Cross(a1 - a0, a2 - a0);
            return distance;
        }

        /// <summary>
        /// Whether another surface of the same garment lies in front of this point: some triangle within
        /// <see cref="CoverReachMm"/> whose own side the point is on the inner side of. This is what keeps an inner
        /// garment that runs between a coat's shell and its lining from being read as poking out of the coat.
        /// </summary>
        static bool InnerSide(Vector3 point, Entry other, Grid grid)
        {
            var nx = Mathf.Max(1, (int)((other.Max.x - other.Min.x) / grid.Cell) + 1);
            var ny = Mathf.Max(1, (int)((other.Max.y - other.Min.y) / grid.Cell) + 1);
            var nz = Mathf.Max(1, (int)((other.Max.z - other.Min.z) / grid.Cell) + 1);
            int cx = CellIndex(point.x, other.Min.x, grid.Cell, nx);
            int cy = CellIndex(point.y, other.Min.y, grid.Cell, ny);
            int cz = CellIndex(point.z, other.Min.z, grid.Cell, nz);
            for (var x = cx - 1; x <= cx + 1; x++)
            {
                if (x < 0 || x > nx) continue;
                for (var y = cy - 1; y <= cy + 1; y++)
                {
                    if (y < 0 || y > ny) continue;
                    for (var z = cz - 1; z <= cz + 1; z++)
                    {
                        if (z < 0 || z > nz) continue;
                        if (!grid.Cells.TryGetValue(Key(x, y, z), out var list)) continue;
                        for (var i = 0; i < list.Count; i++)
                            if (Covers(point, other, list[i])) return true;
                    }
                }
            }
            for (var i = 0; i < grid.Oversized.Count; i++) if (Covers(point, other, grid.Oversized[i])) return true;
            return false;
        }

        static bool Covers(Vector3 point, Entry other, int triangle)
        {
            Vector3 a0 = other.Pos[other.Tris[triangle]], a1 = other.Pos[other.Tris[triangle + 1]], a2 = other.Pos[other.Tris[triangle + 2]];
            var onTriangle = ClosestOnTriangle(point, a0, a1, a2);
            if ((point - onTriangle).sqrMagnitude > CoverReachSqr) return false;
            var normal = Vector3.Cross(a1 - a0, a2 - a0);
            var length = normal.magnitude;
            if (length <= 0f) return false;
            return Vector3.Dot(point - onTriangle, normal / length) * 1000f < -EpsilonMm;
        }

        /// <summary>Closest point on triangle abc to p (Ericson, Real-Time Collision Detection §5.1.5).</summary>
        static Vector3 ClosestOnTriangle(Vector3 p, Vector3 a, Vector3 b, Vector3 c)
        {
            Vector3 ab = b - a, ac = c - a, ap = p - a;
            float d1 = Vector3.Dot(ab, ap), d2 = Vector3.Dot(ac, ap);
            if (d1 <= 0f && d2 <= 0f) return a;
            Vector3 bp = p - b;
            float d3 = Vector3.Dot(ab, bp), d4 = Vector3.Dot(ac, bp);
            if (d3 >= 0f && d4 <= d3) return b;
            float vc = d1 * d4 - d3 * d2;
            if (vc <= 0f && d1 >= 0f && d3 <= 0f) { var v = d1 / (d1 - d3); return a + v * ab; }
            Vector3 cp = p - c;
            float d5 = Vector3.Dot(ab, cp), d6 = Vector3.Dot(ac, cp);
            if (d6 >= 0f && d5 <= d6) return c;
            float vb = d5 * d2 - d1 * d6;
            if (vb <= 0f && d2 >= 0f && d6 <= 0f) { var w = d2 / (d2 - d6); return a + w * ac; }
            float va = d3 * d6 - d5 * d4;
            if (va <= 0f && (d4 - d3) >= 0f && (d5 - d6) >= 0f) { var w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return b + w * (c - b); }
            var denom = 1f / (va + vb + vc);
            if (float.IsNaN(denom) || float.IsInfinity(denom)) return a;
            return a + ab * (vb * denom) + ac * (vc * denom);
        }

        // ── one pair ─────────────────────────────────────────────────────────────────────────────────
        class PairResult
        {
            public string A, B;
            public double ContactCm2;
            public double MinMm;
            public bool SameSource;
            /// <summary>GI1: the inner layer of the pair and the outer one it runs under, once the census has
            /// resolved them; both null when no inside/outside order holds.</summary>
            public string Layer, Outer;
            /// <summary>GI1: the inner layer's vertices that sit on the OUTSIDE of the outer surface (candidates).</summary>
            public List<int> LayerVertices = new List<int>();
            /// <summary>GI1: how far each of those vertices pokes out (mm, along the outer surface's normal).</summary>
            public List<float> LayerDepths = new List<float>();
            /// <summary>The two measured renderers, so a candidate vertex's world position can be recovered.</summary>
            public Entry AEntry, BEntry;
        }

        class Sweep
        {
            public float MinMm = PokeReachMm;
            public double AreaCm2;
            /// <summary>Vertices of `from` inside the other surface, and on its outside, within the near band
            /// (<see cref="LayerReachMm"/>). This census — and only this census — decides the pair's layer order.</summary>
            public int Inside, Outside;
            /// <summary>Vertices within the instrument's range (<see cref="PokeReachMm"/>) that sit on the OUTSIDE
            /// of the other surface: the visible-poke candidates.</summary>
            public readonly List<int> Candidates = new List<int>();
            /// <summary>Signed distance (mm) of each candidate along the other surface's normal: the poke depth.</summary>
            public readonly List<float> Depths = new List<float>();
        }

        static PairResult Measure(Entry a, Entry b)
        {
            var forward = Sheet(a, b, b.Index);
            var backward = Sheet(b, a, a.Index);
            // A_mutual(ε) = 0.5 x (A's surface within ε of B + B's surface within ε of A). A triangle counts
            // only when all three of its vertices are inside the band, so the area does not move with mesh density.
            var result = new PairResult
            {
                A = a.Path, B = b.Path, AEntry = a, BEntry = b,
                ContactCm2 = 0.5 * (forward.AreaCm2 + backward.AreaCm2),
                MinMm = Math.Min(forward.MinMm, backward.MinMm), SameSource = a.Source == b.Source,
            };
            // GI1: which of the two is the inner layer. Most of an inner layer's vertices that come near the
            // other one lie under it; a layer worn on the outside has almost none, so the sign of the census
            // decides the order and the design "something tied on over the coat" cannot be read as a piercing.
            var forwardBand = forward.Inside + forward.Outside;
            var backwardBand = backward.Inside + backward.Outside;
            var forwardScore = forward.Inside - forward.Outside;
            var backwardScore = backward.Inside - backward.Outside;
            var forwardInner = forwardBand > 0 && (double)forward.Inside / forwardBand >= InnerMajorityRatio
                && forwardScore > 0 && forwardScore >= backwardScore;
            var backwardInner = backwardBand > 0 && (double)backward.Inside / backwardBand >= InnerMajorityRatio
                && backwardScore > 0 && backwardScore > forwardScore;
            if (forwardInner) { result.Layer = a.Path; result.Outer = b.Path; result.LayerVertices = forward.Candidates; result.LayerDepths = forward.Depths; }
            else if (backwardInner) { result.Layer = b.Path; result.Outer = a.Path; result.LayerVertices = backward.Candidates; result.LayerDepths = backward.Depths; }
            return result;
        }

        static Sweep Sheet(Entry from, Entry to, Grid grid)
        {
            var sweep = new Sweep();
            var count = from.Pos.Length;
            var distance = new float[count];
            var minimum = PokeReachSqr;
            for (var i = 0; i < count; i++)
            {
                distance[i] = PokeReachMm;
                var point = from.Pos[i];
                if (!Finite(point) || !InsideReach(point, to)) continue;
                // The sweep runs to the instrument's range. A sample that only reaches it is a lower bound, not a
                // measurement (see PokeReachMm): the reported depth must never look like a measured cap.
                var squared = NearestSqr(point, to, grid, out var closest, out var normal);
                if (squared > PokeReachSqr) continue;
                distance[i] = Mathf.Sqrt(squared) * 1000f;
                if (squared < minimum) minimum = squared;
                // Which side of the other surface this vertex sits on: the sign of its offset along that
                // surface's normal at the closest triangle. Only a vertex clearly OUTSIDE counts as a
                // candidate — the threshold is the same 0.1 mm band the contact measurement uses, so two
                // surfaces the overlap reading calls "touching" are not also called a poke, and float noise
                // on coincident copies cannot seed a pair. Signed in metres, compared in millimetres.
                var length = normal.magnitude;
                if (length <= 0f) continue;
                var signed = Vector3.Dot(point - closest, normal / length) * 1000f;
                if (signed > EpsilonMm && InnerSide(point, to, grid)) signed = -EpsilonMm;
                // The order census is the calibrated near band, kept separate from the instrument's range so the
                // depth evidence can be stated without moving which of the two was called the inner layer.
                if (squared <= ReachSqr)
                {
                    if (signed > EpsilonMm) sweep.Outside++;
                    else if (signed < -EpsilonMm) sweep.Inside++;
                }
                if (signed > EpsilonMm) { sweep.Candidates.Add(i); sweep.Depths.Add(signed); }
            }
            sweep.MinMm = minimum <= PokeReachSqr ? Mathf.Sqrt(minimum) * 1000f : PokeReachMm;
            var tris = from.Tris;
            for (var t = 0; t + 2 < tris.Length; t += 3)
            {
                int i0 = tris[t], i1 = tris[t + 1], i2 = tris[t + 2];
                if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= count || i1 >= count || i2 >= count) continue;
                Vector3 p0 = from.Pos[i0], p1 = from.Pos[i1], p2 = from.Pos[i2];
                if (!Finite(p0) || !Finite(p1) || !Finite(p2)) continue;
                if (distance[i0] > EpsilonMm || distance[i1] > EpsilonMm || distance[i2] > EpsilonMm) continue;
                sweep.AreaCm2 += Vector3.Cross(p1 - p0, p2 - p0).magnitude * 0.5 * 10000.0;
            }
            return sweep;
        }

        // ── GI1 (`D-143`): which of the proposed pairs the rendered picture confirms ─────────────────
        class PairReading
        {
            public string Layer, Outer;
            public int Candidates, Confirmed, Capped;
            public double MinMm, ContactCm2;
            public bool SameSource;
            /// <summary>Evidence: the confirmed vertices' poke depths (mm), the pixels the pair occupies, the parts
            /// and sources, and the sources' role in the order.</summary>
            public readonly List<float> Depths = new List<float>();
            public readonly HashSet<int> Pixels = new HashSet<int>();
            public int PixelCount;
            public float DepthMaxMm;
            public double DepthMedianMm;
            /// <summary>True when the deepest confirmed vertex reached the poke reach's ceiling, so
            /// <see cref="DepthMaxMm"/> is a lower bound and must be read as "at least this deep".</summary>
            public bool DepthAtLeast;
            public string BodyPart, OuterPart, LayerSource, OuterSource, LayerRole, OuterRole;
            /// <summary>True when the pair crosses either guard bound: too many confirmed vertices, or too deep.</summary>
            public bool OutOfBounds;
            /// <summary>The executor's decision for this pair: none / close / accept / ask_user.</summary>
            public string Decision = "none", Criterion, Rationale, DecisionNote;
            public bool DecisionValid;
            /// <summary>True when no valid decision settles this pair, so the criterion counts it.</summary>
            public bool Counted;
            public readonly List<string> Views = new List<string>();
        }

        /// <summary>The middle confirmed depth of a pair; 0 for a pair with nothing confirmed.</summary>
        static double Median(List<float> values)
        {
            if (values == null || values.Count == 0) return 0;
            var sorted = values.OrderBy(value => value).ToList();
            var middle = sorted.Count / 2;
            return sorted.Count % 2 == 1 ? sorted[middle] : 0.5 * (sorted[middle - 1] + sorted[middle]);
        }

        /// <summary>
        /// `D-143` ③: what each outfit source is in the order, as evidence for the executor's decision — never a
        /// filter. The route is declared, never guessed from an asset name: a plan outfit's own role/target/category,
        /// or its intake inventory entry's, or the product's own category component in the planned item path
        /// (`taxonomy.ts`, e.g. 发型 -> hair). A source nothing resolves gets "unknown" and a note, which is itself
        /// evidence: an executor deciding about it knows the Runtime could not place it.
        /// </summary>
        static Dictionary<string, string> OrderRoles(List<string> notes)
        {
            var roles = new Dictionary<string, string>(StringComparer.Ordinal);
            var plan = Avh.Plan();
            var inventory = Avh.ReadJsonFile(Avh.Abs("_harness/intake/inventory.json"));
            var declared = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var value in inventory?.List("items") ?? new List<object>())
                if (value is Dictionary<string, object> item && !string.IsNullOrEmpty(item.Str("item")))
                    declared[item.Str("item")] = string.Join("|", new[] { item.Str("role"), item.Str("target"), item.Str("category") }
                        .Where(part => !string.IsNullOrEmpty(part)));
            var unresolved = new List<string>();
            foreach (var value in plan.List("outfits"))
            {
                if (!(value is Dictionary<string, object> outfit)) continue;
                var id = outfit.Str("id");
                if (string.IsNullOrEmpty(id)) continue;
                var item = outfit.Str("item") ?? "";
                var own = string.Join("|", new[] { outfit.Str("role"), outfit.Str("target"), outfit.Str("category") }
                    .Where(part => !string.IsNullOrEmpty(part)));
                var role = own.Length > 0 ? own : declared.TryGetValue(item, out var found) ? found : "";
                var known = RoleKnown(role);
                if (!known)
                {
                    var component = Array.Find(OrderRolePaths, pair => item.Split('\\', '/', ':').Contains(pair.Path));
                    if (component.Path != null) { role = component.Role; known = true; }
                }
                if (!known) { unresolved.Add(id); role = "unknown"; }
                roles[OutfitStage.Group + "/Outfit_" + id + "/"] = role;
            }
            if (unresolved.Count > 0)
                notes.Add($"衣物互穿：方案与清点里都认不出这些来源在订单里的角色（{string.Join("、", unresolved)}），"
                    + "它们的对按「unknown」列出，由执行方按证据判断");
            return roles;
        }

        /// <summary>True when the declared role string names one of the order roles the Runtime knows.</summary>
        static bool RoleKnown(string role) =>
            role.Split('|').Any(part => OrderRolePaths.Any(pair => pair.Role.Equals(part, StringComparison.OrdinalIgnoreCase)));

        /// <summary>The order role of a renderer path: an outfit's resolved role, or `body` for the base body.</summary>
        static string RoleOf(Dictionary<string, string> roles, string path)
        {
            if (string.IsNullOrEmpty(path)) return "unknown";
            foreach (var pair in roles)
                if (path.StartsWith(pair.Key, StringComparison.Ordinal)) return pair.Value;
            return path.StartsWith(OutfitStage.Group + "/", StringComparison.Ordinal) ? "unknown" : "body";
        }

        static string SourceOf(Dictionary<string, string> roles, string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            foreach (var pair in roles)
                if (path.StartsWith(pair.Key, StringComparison.Ordinal))
                    return "outfit:" + pair.Key.Substring((OutfitStage.Group + "/Outfit_").Length).TrimEnd('/');
            return "body";
        }

        class InterpenetrationResult
        {
            public Dictionary<string, object> Document;
            public readonly List<PairReading> Pairs = new List<PairReading>();
        }

        /// <summary>
        /// `D-143`: the geometry proposes, the picture decides. Every pair the census resolved sends the inner
        /// layer's outside vertices to the same render confirmation the fit probe uses (`D-139` ①): with
        /// everything visible the pixel's frontmost layer must be that inner layer AND at this vertex's own
        /// depth, and once the inner layer is switched off the outer one must show there. Only then is the
        /// interpenetration visible on screen. The ray half alone never reports a pair.
        /// The Runtime then hands each confirmed pair to the executor as evidence — confirmed vertices, poke
        /// depth distribution, visible pixels, body parts, sources and the sources' role in the order — and
        /// requires a decision for it: `close`, `accept` (within the two guard bounds) or `ask_user`. The reading
        /// counts the pairs with no valid decision and the out-of-bounds pairs that were accepted anyway.
        /// </summary>
        static InterpenetrationResult Interpenetrate(GameObject avatar, List<PairResult> pairs, Report report, List<string> notes,
            Dictionary<string, string> partByPath, Dictionary<string, string> roles, List<object> closures,
            List<Dictionary<string, object>> decisions)
        {
            var result = new InterpenetrationResult();
            var document = new Dictionary<string, object>
            {
                ["schema"] = "outfit-visible-interpenetration/0.1",
                ["layer_reach_mm"] = (double)LayerReachMm,
                ["poke_reach_mm"] = (double)PokeReachMm,
                ["inner_ratio"] = InnerMajorityRatio,
                ["cover_reach_mm"] = (double)CoverReachMm,
                ["min_vertices"] = MinVisibleInterpenetrationVertices,
                ["guard_depth_mm"] = (double)GuardVisibleInterpenetrationDepthMm,
                ["guard_vertices"] = GuardVisibleInterpenetrationVertices,
                ["depth_probes_mm"] = DepthProbesMm.Cast<object>().ToList(),
                ["depth_tolerance_mm"] = (double)RenderDepthToleranceMm,
                ["frame_height"] = RenderFrameHeight,
                ["views"] = global::AvatarAudit.FitRenderConfirm.Options.AllViews().Cast<object>().ToList(),
                ["candidate_pairs"] = pairs.Count,
                ["measured_pairs"] = 0,
                ["pair_phase_complete"] = report.Complete,
                ["valid"] = false,
                ["pairs"] = new List<object>(),
                ["decisions"] = new List<object>(),
                ["undecided_pairs"] = 0,
                ["out_of_bounds_accepted_pairs"] = 0,
                ["ask_user_pairs"] = 0,
            };
            result.Document = document;
            if (pairs.Count == 0) { document["valid"] = true; return result; }

            var watch = Stopwatch.StartNew();
            var candidates = new List<global::AvatarAudit.FitRenderConfirm.Candidate>();
            var owner = new List<PairReading>();
            var candidateDepths = new List<float>();
            var capped = false;
            foreach (var pair in pairs)
            {
                var layerEntry = pair.Layer == pair.A ? pair.AEntry : pair.BEntry;
                var reading = new PairReading
                {
                    Layer = pair.Layer, Outer = pair.Outer, MinMm = pair.MinMm,
                    ContactCm2 = pair.ContactCm2, SameSource = pair.SameSource,
                };
                // Evidence, not a filter: the executor decides, and the roles tell them what the order called these
                // two sources. `hair` is the role the orderer's "hair crossings are fine by default" speaks about.
                reading.LayerRole = RoleOf(roles, pair.Layer);
                reading.OuterRole = RoleOf(roles, pair.Outer);
                reading.LayerSource = SourceOf(roles, pair.Layer);
                reading.OuterSource = SourceOf(roles, pair.Outer);
                result.Pairs.Add(reading);
                var vertices = pair.LayerVertices;
                // A dense inner mesh can put tens of thousands of vertices outside the outer one. The picture
                // check takes an evenly spaced sample instead of a prefix — a prefix would be one patch of the
                // surface and could miss the visible one — and the pair then reads as a lower bound.
                var stride = vertices.Count <= MaxCandidatesPerPair ? 1
                    : (vertices.Count + MaxCandidatesPerPair - 1) / MaxCandidatesPerPair;
                var taken = 0;
                for (var index = 0; index < vertices.Count; index += stride)
                {
                    if (candidates.Count >= MaxInterpenetrationCandidates)
                    {
                        report.InterpenetrationComplete = false;
                        notes.Add($"衣物互穿的候选顶点超过 {MaxInterpenetrationCandidates} 个上限；确认不完整，判据记 no_data");
                        break;
                    }
                    var vertex = vertices[index];
                    if (vertex < 0 || vertex >= layerEntry.Pos.Length) continue;
                    taken++;
                    candidates.Add(new global::AvatarAudit.FitRenderConfirm.Candidate
                    {
                        Vertex = vertex, Region = layerEntry.BodyPart, Layer = pair.Layer, Garment = pair.Outer,
                        Position = layerEntry.Pos[vertex], DepthMm = (float)pair.MinMm,
                    });
                    owner.Add(reading);
                    // The census already measured this vertex's poke depth along the outer surface's normal; keep
                    // it so a confirmed vertex can be judged by how deep it is, not only by being visible.
                    candidateDepths.Add(index < pair.LayerDepths.Count ? pair.LayerDepths[index] : 0f);
                }
                reading.Candidates = taken;
                reading.Capped = vertices.Count - taken;
                if (reading.Capped > 0) capped = true;
                if (!report.InterpenetrationComplete) break;
            }
            var options = new global::AvatarAudit.FitRenderConfirm.Options
            {
                Enabled = true, Height = RenderFrameHeight, DepthToleranceMm = RenderDepthToleranceMm,
                Views = global::AvatarAudit.FitRenderConfirm.Options.AllViews(),
            };
            var run = global::AvatarAudit.FitRenderConfirm.Run(avatar, options, candidates, null,
                System.IO.Path.Combine(Avh.RunDir, "visibility"), "default");
            report.InterpenetrationElapsedMs = watch.Elapsed.TotalMilliseconds;
            document["measured_pairs"] = pairs.Count;
            if (run == null || !run.Valid)
            {
                report.InterpenetrationComplete = false;
                notes.Add("衣物互穿的渲图确认没有完成：" + (run == null ? "没有结果" : run.Reason));
                return result;
            }
            document["valid"] = true;
            document["render_views"] = run.ViewCount;
            document["render_depth_tolerance_mm"] = (double)run.DepthToleranceMm;
            document["images"] = run.Files.Cast<object>().ToList();
            var renderers = new List<object>();
            foreach (var row in run.RendererRows)
                renderers.Add(new Dictionary<string, object>
                {
                    ["index"] = global::AvatarAudit.AuditJson.Int(row, "index", 0),
                    ["path"] = global::AvatarAudit.AuditJson.Str(row, "path"),
                });
            document["renderers"] = renderers;
            for (var i = 0; i < candidates.Count && i < run.CandidateRows.Count; i++)
            {
                if (!global::AvatarAudit.AuditJson.Bool(run.CandidateRows[i], "confirmed", false)) continue;
                var reading = owner[i];
                reading.Confirmed++;
                reading.Depths.Add(i < candidateDepths.Count ? candidateDepths[i] : 0f);
                if (run.CandidateRows[i].Get("views") is List<object> views)
                    foreach (var view in views)
                    {
                        var name = view?.ToString();
                        if (!string.IsNullOrEmpty(name) && !reading.Views.Contains(name)) reading.Views.Add(name);
                    }
                // How much of the picture this pair occupies: distinct (view, pixel) hits, so a pair spread over
                // many pixels reads differently from one that only grazes a few.
                if (run.CandidateRows[i].Get("pixels") is List<object> pixels)
                    foreach (var value in pixels)
                        if (value != null && int.TryParse(value.ToString(), out var pixel)) reading.Pixels.Add(pixel);
            }
            report.InterpenetrationConfirmedPairs = result.Pairs.Count(pair => pair.Confirmed > 0);
            report.InterpenetrationVertices = result.Pairs.Sum(pair => pair.Confirmed);
            foreach (var pair in result.Pairs)
            {
                pair.BodyPart = PartOf(partByPath, pair.Layer);
                pair.OuterPart = PartOf(partByPath, pair.Outer);
                // Evidence for the decision, in place of the thresholds that used to decide for the executor.
                // The measured maximum is exact below the poke reach; a vertex that only reaches the ceiling
                // makes it a lower bound, and the reading says so instead of presenting the ceiling as a value.
                pair.DepthMaxMm = pair.Depths.Count == 0 ? 0 : pair.Depths.Max();
                pair.DepthMedianMm = Median(pair.Depths);
                pair.DepthAtLeast = pair.Depths.Count > 0 && pair.DepthMaxMm >= PokeReachMm - DepthCeilingToleranceMm;
                pair.PixelCount = pair.Pixels.Count;
                pair.OutOfBounds = pair.DepthMaxMm > GuardVisibleInterpenetrationDepthMm
                    || pair.DepthAtLeast
                    || pair.Confirmed > GuardVisibleInterpenetrationVertices;
            }
            // The executor's decisions (`D-143` ③). The Runtime decides nothing here: it reads the decision the
            // recipe recorded, checks it against the measurement, and counts the pairs that are not settled —
            // no valid decision, or an out-of-bounds pair that was accepted anyway.
            var settled = Settle(result.Pairs, decisions, closures, partByPath, notes);
            document["decisions"] = settled.Document;
            document["undecided_pairs"] = settled.Undecided;
            document["out_of_bounds_accepted_pairs"] = settled.OutOfBoundsAccepted;
            document["ask_user_pairs"] = settled.AskUser;
            report.InterpenetrationUndecided = settled.Undecided;
            report.InterpenetrationOutOfBoundsAccepted = settled.OutOfBoundsAccepted;
            report.InterpenetrationAskUser = settled.AskUser;
            report.InterpenetrationPairs = settled.Undecided + settled.OutOfBoundsAccepted;
            report.InterpenetrationMax = result.Pairs.Where(pair => pair.Counted).Select(pair => pair.Confirmed).DefaultIfEmpty(0).Max();
            if (capped && result.Pairs.Any(pair => pair.Capped > 0 && pair.Confirmed < MinVisibleInterpenetrationVertices))
            {
                report.InterpenetrationComplete = false;
                notes.Add($"有候选对超过每对 {MaxCandidatesPerPair} 个顶点的确认上限且未达最小量；确认不完整，判据记 no_data");
            }
            document["confirmed_pairs"] = report.InterpenetrationConfirmedPairs;
            document["counted_pairs"] = report.InterpenetrationPairs;
            document["max_confirmed"] = result.Pairs.Count == 0 ? 0 : result.Pairs.Max(pair => pair.Confirmed);
            document["max_counting"] = report.InterpenetrationMax;
            // Every pair that reached the picture is listed, confirmed or not: a pair the geometry proposed
            // and the picture rejected is evidence for the calibration, not something to hide.
            document["pairs"] = result.Pairs
                .OrderByDescending(pair => pair.Confirmed).ThenByDescending(pair => pair.Candidates)
                .ThenBy(pair => pair.Layer, StringComparer.Ordinal).Take(MaxInterpenetrationRows)
                .Select(pair => (object)new Dictionary<string, object>
                {
                    ["layer"] = pair.Layer, ["outer"] = pair.Outer, ["candidates"] = pair.Candidates,
                    ["confirmed"] = pair.Confirmed, ["capped"] = pair.Capped,
                    ["visible_pixels"] = pair.PixelCount,
                    ["body_part"] = pair.BodyPart, ["outer_part"] = pair.OuterPart,
                    ["layer_source"] = pair.LayerSource, ["outer_source"] = pair.OuterSource,
                    ["layer_role"] = pair.LayerRole, ["outer_role"] = pair.OuterRole,
                    ["out_of_bounds"] = pair.OutOfBounds,
                    ["decision"] = pair.Decision, ["decision_valid"] = pair.DecisionValid,
                    ["decision_note"] = pair.DecisionNote, ["criterion"] = pair.Criterion,
                    ["decision_rationale"] = pair.Rationale, ["counted"] = pair.Counted,
                    ["depth_max_mm"] = Round(pair.DepthMaxMm), ["depth_median_mm"] = Round(pair.DepthMedianMm),
                    ["depth_at_least"] = pair.DepthAtLeast,
                    ["depth_counts"] = DepthProbesMm.ToDictionary(probe => probe.ToString("0.###", CultureInfo.InvariantCulture),
                        probe => (object)pair.Depths.Count(depth => depth > probe)),
                    ["min_mm"] = Round(pair.MinMm), ["contact_cm2"] = Round(pair.ContactCm2),
                    ["same_source"] = pair.SameSource, ["views"] = pair.Views.Cast<object>().ToList(),
                }).ToList();
            return result;
        }

        class DecisionResult
        {
            /// <summary>One row per candidate pair: its evidence, the decision read for it, and whether it settled.</summary>
            public readonly List<object> Document = new List<object>();
            public int Undecided, OutOfBoundsAccepted, AskUser;
        }

        static string PartOf(Dictionary<string, string> partByPath, string path) =>
            path != null && partByPath != null && partByPath.TryGetValue(path, out var part) ? part : UnknownPart;

        /// <summary>True when a decision names exactly this pair — both parts, in either order.</summary>
        static bool Names(List<string> objects, string layer, string outer) =>
            objects.Count == 2 && objects.Contains(layer, StringComparer.Ordinal) && objects.Contains(outer, StringComparer.Ordinal);

        /// <summary>
        /// Why one `close` decision does not take effect, or null when it does: the layer it names has to be one of
        /// the closures the recipe actually recorded. A decision that claims a closure the assembly does not carry
        /// is a claim, and the pair stays unsettled.
        /// </summary>
        static string CloseReject(string layer, List<object> closures)
        {
            foreach (var value in closures ?? new List<object>())
                if (value is Dictionary<string, object> row)
                {
                    var closed = row.Str("path");
                    if (string.IsNullOrEmpty(closed)) continue;
                    if (closed == layer || layer.StartsWith(closed + "/", StringComparison.Ordinal)) return null;
                }
            return "决定写了 close，但配方里没有关掉这一件的记录";
        }

        /// <summary>
        /// Why one `accept` decision does not take effect, or null when it does: it has to name the criterion it
        /// followed, and the pair has to be inside both guard bounds. The bounds are what stops a broad, deep
        /// interpenetration from being waved through as a judgement call.
        /// </summary>
        static string AcceptReject(Dictionary<string, object> row, PairReading pair)
        {
            if (string.IsNullOrWhiteSpace(row.Str("criterion"))) return "决定写了 accept，但没写明依据哪条准则";
            if (pair.OutOfBounds)
                return $"决定写了 accept，但这一对超出护栏（确认 {pair.Confirmed} > {GuardVisibleInterpenetrationVertices} "
                    + $"或最深 {DepthText(pair)} > {GuardVisibleInterpenetrationDepthMm:0.###} mm）；越界只能 close 或 ask_user";
            return null;
        }

        /// <summary>The poke depth as the evidence must state it: a measurement below the ceiling, or the honest
        /// lower bound when the deepest confirmed vertex only reached the ceiling.</summary>
        static string DepthText(PairReading pair) =>
            (pair.DepthAtLeast ? "至少 " : "") + pair.DepthMaxMm.ToString("0.###", CultureInfo.InvariantCulture) + " mm";

        /// <summary>Why one `ask_user` decision does not take effect, or null when it does.</summary>
        static string AskReject(Dictionary<string, object> row) =>
            string.IsNullOrWhiteSpace(row.Str("rationale")) ? "决定写了 ask_user，但没写为什么留给用户" : null;

        /// <summary>
        /// `D-143` ③, the orderer's direction: the Runtime does not decide whether a visible interpenetration is
        /// acceptable — the executor does, per pair, and the Runtime only checks that a decision exists and is
        /// coherent with the measurement. `close` must match a recorded closure, `accept` must name the criterion
        /// it followed and stay inside both guard bounds, `ask_user` must say why the user has to look. Every pair
        /// that reached the noise gate and is not settled by one of those is counted, and so is an out-of-bounds
        /// pair that was accepted anyway. Decisions that name no candidate pair are reported without changing a
        /// count, so a typo in the recipe is visible instead of silently ignored.
        /// </summary>
        static DecisionResult Settle(List<PairReading> pairs, List<Dictionary<string, object>> decisions,
            List<object> closures, Dictionary<string, string> partByPath, List<string> notes)
        {
            var result = new DecisionResult();
            var pending = decisions ?? new List<Dictionary<string, object>>();
            var used = new bool[pending.Count];
            foreach (var pair in pairs)
            {
                // The noise gate: below the minimum the pair is seam contact, not a candidate for a decision.
                if (pair.Confirmed < MinVisibleInterpenetrationVertices) { pair.Counted = false; continue; }
                pair.Criterion = null; pair.Rationale = null; pair.DecisionNote = null; pair.DecisionValid = false;
                pair.Decision = "none";
                for (var index = 0; index < pending.Count; index++)
                {
                    var row = pending[index];
                    if (!Names(row.List("objects").Select(value => value.ToString()).ToList(), pair.Layer, pair.Outer)) continue;
                    used[index] = true;
                    pair.Decision = row.Str("decision") ?? "none";
                    pair.Criterion = row.Str("criterion");
                    pair.Rationale = row.Str("rationale");
                    pair.DecisionNote = pair.Decision switch
                    {
                        "close" => CloseReject(pair.Layer, closures),
                        "accept" => AcceptReject(row, pair),
                        "ask_user" => AskReject(row),
                        _ => "决定必须是 close / accept / ask_user",
                    };
                    pair.DecisionValid = pair.DecisionNote == null;
                    break;
                }
                if (!pair.DecisionValid)
                {
                    pair.Counted = true;
                    if (pair.Decision == "accept" && pair.OutOfBounds) result.OutOfBoundsAccepted++;
                    else result.Undecided++;
                    if (pair.Decision == "none")
                        notes.Add($"衣物互穿：{pair.Layer} ↔ {pair.Outer} 确认 {pair.Confirmed} 个顶点（可见像素 {pair.PixelCount}，"
                            + $"最深 {DepthText(pair)}，{pair.LayerRole} × {pair.OuterRole}）还没有决定；判据按未决定计入阻断");
                    else
                        notes.Add($"衣物互穿：{pair.Layer} ↔ {pair.Outer} 的 {pair.Decision} 决定没有生效（{pair.DecisionNote}）；计入阻断");
                }
                else
                {
                    pair.Counted = false;
                    if (pair.Decision == "ask_user") result.AskUser++;
                }
                result.Document.Add(Record(pair));
            }
            for (var index = 0; index < pending.Count; index++)
            {
                if (used[index]) continue;
                var named = string.Join(" ↔ ", pending[index].List("objects").Select(value => value.ToString()));
                notes.Add($"衣物互穿：决定 {pending[index].Str("decision")} 点名的 {named} 不是一条达到最小量 "
                    + $"{MinVisibleInterpenetrationVertices} 的确认对；不影响计数");
            }
            return result;
        }

        /// <summary>One evidence row for a candidate pair, with the decision that was read for it.</summary>
        static object Record(PairReading pair) =>
            new Dictionary<string, object>
            {
                ["layer"] = pair.Layer, ["outer"] = pair.Outer,
                ["confirmed"] = pair.Confirmed, ["visible_pixels"] = pair.PixelCount,
                ["depth_max_mm"] = Round(pair.DepthMaxMm), ["depth_median_mm"] = Round(pair.DepthMedianMm),
                ["depth_at_least"] = pair.DepthAtLeast,
                ["body_part"] = pair.BodyPart, ["outer_part"] = pair.OuterPart,
                ["layer_source"] = pair.LayerSource, ["outer_source"] = pair.OuterSource,
                ["layer_role"] = pair.LayerRole, ["outer_role"] = pair.OuterRole,
                ["out_of_bounds"] = pair.OutOfBounds,
                ["decision"] = pair.Decision, ["decision_valid"] = pair.DecisionValid,
                ["criterion"] = pair.Criterion, ["rationale"] = pair.Rationale,
                ["decision_note"] = pair.DecisionNote, ["counted"] = pair.Counted,
            };

        // ── stacks: one connected component is one pile the executor has to decide once ──────────────
        static int Stacks(List<PairResult> heavy, out List<HashSet<string>> members)
        {
            var parent = new Dictionary<string, string>(StringComparer.Ordinal);
            string Find(string value)
            {
                if (!parent.TryGetValue(value, out var current)) { parent[value] = value; return value; }
                while (current != value)
                {
                    value = current;
                    if (!parent.TryGetValue(value, out current)) { parent[value] = value; current = value; }
                }
                return value;
            }
            foreach (var pair in heavy)
            {
                var left = Find(pair.A); var right = Find(pair.B);
                if (left != right) parent[left] = right;
            }
            var groups = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
            foreach (var pair in heavy)
                foreach (var path in new[] { pair.A, pair.B })
                {
                    var root = Find(path);
                    if (!groups.TryGetValue(root, out var set)) { set = new HashSet<string>(StringComparer.Ordinal); groups[root] = set; }
                    set.Add(path);
                }
            members = groups.Values.ToList();
            return members.Count;
        }

        // ── vendor grouping evidence: prefab differences and vendor FX switches ──────────────────────
        static List<object> BodySets(string bodyPrefabPath, List<string> notes)
        {
            var sets = new List<object>();
            if (string.IsNullOrEmpty(bodyPrefabPath)) return sets;
            var root = PackageRoot(bodyPrefabPath, notes);
            if (root == null) return sets;
            var prefabs = Assets("t:Prefab", root);
            if (prefabs.Count > MaxPrefabs) { notes.Add($"素体包里预制体 {prefabs.Count} 个，只比对前 {MaxPrefabs} 个"); prefabs = prefabs.Take(MaxPrefabs).ToList(); }
            var bodies = new List<BodyPrefab>();
            foreach (var path in prefabs)
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (prefab == null || prefab.GetComponentsInChildren<Renderer>(true).Length == 0) continue;
                var identity = global::AvatarAudit.AuditPartInventory.BodyIdentity(path);
                if (identity == null || identity.Count == 0) continue; // not a body prefab: no body-family renderer
                var names = new HashSet<string>(identity, StringComparer.OrdinalIgnoreCase);
                bodies.Add(new BodyPrefab { Path = path, Parts = prefab.GetComponentsInChildren<Renderer>(true)
                    .Where(r => r is SkinnedMeshRenderer || r is MeshRenderer)
                    .Where(r => !names.Contains(r.gameObject.name))
                    .Select(r => Probe.HierarchyPath(prefab.transform, r.transform)).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList() });
            }
            // The difference between two body prefabs of one package is the vendor's own grouping of the
            // parts that only some of its body variants carry; the parts are read, never their names.
            var emitted = new HashSet<string>(StringComparer.Ordinal);
            foreach (var full in bodies)
                foreach (var reduced in bodies)
                {
                    if (full.Path == reduced.Path) continue;
                    var missing = full.Parts.Where(part => !reduced.Parts.Contains(part)).ToList();
                    if (missing.Count == 0 || missing.Count == full.Parts.Count) continue; // no strict difference
                    if (!emitted.Add(string.Join("\n", missing))) continue;
                    sets.Add(new Dictionary<string, object> { ["members"] = missing.Cast<object>().ToList(), ["evidence"] = "prefab_difference",
                        ["detail"] = $"{full.Path} 有而 {reduced.Path} 没有的渲染器" });
                }
            // Vendor clips are the vendor's own grouping of switches: one clip that writes m_IsActive on
            // several objects toggles them together, whatever the objects are called.
            var clips = Assets("t:AnimationClip", root);
            if (clips.Count > MaxClips) { notes.Add($"素体包里动画 {clips.Count} 个，只读前 {MaxClips} 个"); clips = clips.Take(MaxClips).ToList(); }
            var groups = new Dictionary<string, ClipGroup>(StringComparer.Ordinal);
            var single = 0;
            foreach (var path in clips)
            {
                var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(path);
                if (clip == null) continue;
                var bound = AnimationUtility.GetCurveBindings(clip)
                    .Where(binding => binding.propertyName == "m_IsActive" && binding.type == typeof(GameObject))
                    .Select(binding => binding.path).Where(path2 => !string.IsNullOrEmpty(path2)).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList();
                if (bound.Count == 0) continue;
                if (bound.Count == 1) { single++; continue; }
                var key = string.Join("\n", bound);
                if (!groups.TryGetValue(key, out var group)) group = new ClipGroup { Members = bound, Clips = new List<string>() };
                group.Clips.Add(path); groups[key] = group;
            }
            foreach (var group in groups.Values)
                sets.Add(new Dictionary<string, object> { ["members"] = group.Members.Cast<object>().ToList(), ["evidence"] = "vendor_clip",
                    ["detail"] = string.Join(", ", group.Clips.Take(3)) + (group.Clips.Count > 3 ? $" 等 {group.Clips.Count} 个 clip" : "") });
            if (single > 0) notes.Add($"厂商动画里只开关单个对象的 clip {single} 个（不计成组）");
            return sets;
        }

        class BodyPrefab { public string Path; public List<string> Parts; }
        class ClipGroup { public List<string> Members; public List<string> Clips; }

        /// <summary>An imported package's own root, from the setup report; the prefab's folder otherwise.</summary>
        static string PackageRoot(string assetPath, List<string> notes)
        {
            var import = Avh.ReadJsonFile(Avh.Abs("_harness/setup/import.json"));
            var roots = import == null ? new List<string>() : import.List("packages").Select(o => o as Dictionary<string, object>)
                .Where(package => package != null).SelectMany(package => package.List("roots").Select(r => r.ToString()))
                .Where(r => r.StartsWith("Assets/") && AssetDatabase.IsValidFolder(r)).Distinct().ToList();
            var owner = roots.Where(r => assetPath.StartsWith(r.TrimEnd('/') + "/", StringComparison.Ordinal))
                .OrderByDescending(r => r.Length).FirstOrDefault();
            if (owner != null) return owner;
            // `Path` is this class's own document constant, so the file-system helper is spelled out.
            var folder = System.IO.Path.GetDirectoryName(assetPath)?.Replace('\\', '/');
            if (!string.IsNullOrEmpty(folder) && AssetDatabase.IsValidFolder(folder)) { notes.Add($"素体预制体不在已导入包的根下，成组证据只在 {folder} 内找"); return folder; }
            notes.Add("找不到素体预制体所在的包，成组证据未收集");
            return null;
        }

        static List<string> Assets(string filter, string root)
        {
            try { return AssetDatabase.FindAssets(filter, new[] { root }).Select(AssetDatabase.GUIDToAssetPath).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList(); }
            catch { return new List<string>(); }
        }
    }
}
