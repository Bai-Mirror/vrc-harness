// Harness bridge for AvatarAudit's Play-mode geometry probe. Every formal outfit cell is probed.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace AVH.Harness
{
    [InitializeOnLoad]
    public static class HarnessFitStage
    {
        const string ActiveKey = "AVH.HarnessFitStage.Active";
        const string IndexKey = "AVH.HarnessFitStage.Index";
        const string CountKey = "AVH.HarnessFitStage.Count";
        const string OutKey = "AVH.HarnessFitStage.Out";

        static HarnessFitStage()
        {
            EditorApplication.delayCall += Resume;
        }

        public static void Run()
        {
            try
            {
                var states = States();
                if (states.Count == 0) throw new Exception("没有可检测的正式换装状态");
                var outDir = Path.Combine(Avh.RunDir, "fit");
                Directory.CreateDirectory(outDir);
                foreach (var stale in Directory.GetFiles(outDir, "geo_state_*.json")) File.Delete(stale);
                var status = Path.Combine(outDir, "status.json");
                if (File.Exists(status)) File.Delete(status);
                SessionState.SetBool(ActiveKey, true);
                SessionState.SetInt(IndexKey, 0);
                SessionState.SetInt(CountKey, states.Count);
                SessionState.SetString(OutKey, outDir);
                WriteManifest(outDir, states);
                Prepare(0, states);
            }
            catch (Exception error) { Fail(error); }
        }

        static void Resume()
        {
            if (!SessionState.GetBool(ActiveKey, false)) return;
            global::AvatarAudit.HarnessFitCallbacks.Install();
        }

        static void Prepare(int index, List<Dictionary<string, float>> states)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(BuildStage.BuiltPrefab)
                ?? throw new Exception("构建产物不存在：" + BuildStage.BuiltPrefab);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            avatar.name = "AVH_FitTarget";
            new AnimatorSim(avatar).Evaluate(states[index]).Apply(avatar);
            var outDir = SessionState.GetString(OutKey, "");
            var status = Path.Combine(outDir, "status.json");
            if (File.Exists(status)) File.Delete(status);
            WriteRequest(outDir, avatar.name, StateId(index));
            SessionState.SetInt(IndexKey, index);
            global::AvatarAudit.HarnessFitCallbacks.Install();
            global::AvatarAudit.AuditRunner.RunRequestFromMenu();
        }

        public static void Advance()
        {
            if (!SessionState.GetBool(ActiveKey, false) || EditorApplication.isPlayingOrWillChangePlaymode) return;
            try
            {
                var next = SessionState.GetInt(IndexKey, 0) + 1;
                var states = States();
                if (states.Count != SessionState.GetInt(CountKey, -1)) throw new Exception("检测期间换装状态集发生变化");
                if (next < states.Count) Prepare(next, states);
                else { Publish(SessionState.GetString(OutKey, ""), states); Clear(); EditorApplication.Exit(0); }
            }
            catch (Exception error) { Fail(error); }
        }

        static List<Dictionary<string, float>> States()
        {
            var menu = Avh.ReadJsonFile(Avh.Abs(MenuStage.RecordPath)) ?? throw new Exception("缺少菜单层记录 menu.json");
            var ours = menu.List("parameters").Select(x => x.ToString()).ToList();
            var controls = menu.List("controls").Cast<Dictionary<string, object>>().ToList();
            var domains = ours.ToDictionary(p => p, p => new[] { 0f }.Concat(controls
                .Where(c => c.Str("parameter") == p).Select(c => Convert.ToSingle(c["value"]))).Distinct().ToArray());
            IEnumerable<Dictionary<string, float>> cells = new[] { new Dictionary<string, float>() };
            foreach (var pair in domains)
                cells = cells.SelectMany(cell => pair.Value.Select(value => new Dictionary<string, float>(cell) { [pair.Key] = value })).ToList();
            return cells.ToList();
        }

        static string StateId(int index) => $"state_{index:000}";

        static void WriteManifest(string outDir, List<Dictionary<string, float>> states) =>
            Avh.WriteJson(Path.Combine(outDir, "states.json"), new Dictionary<string, object>
            {
                ["schema"] = "harness-fit-states/0.1",
                ["states"] = states.Select((state, index) => (object)new Dictionary<string, object>
                {
                    ["state_id"] = StateId(index),
                    ["parameters"] = state.ToDictionary(kv => kv.Key, kv => (object)kv.Value),
                }).ToList(),
            });

        static void WriteRequest(string outDir, string avatar, string stateId) =>
            Avh.WriteJson(global::AvatarAudit.AuditRunner.RequestPath, new Dictionary<string, object>
            {
                ["tool"] = "fit", ["auto_play"] = true, ["avatar"] = avatar, ["out"] = outDir,
                ["state_id"] = stateId, ["timeout_seconds"] = 1800,
                // The probe must not guess the body from skin weights: on this order the base body ships as
                // several meshes and none of them covers foot + torso, so every heuristic picks a garment.
                // The plan already names the body prefab; hand it over as the identity source.
                ["body_prefab"] = BodyPrefab(),
                ["min_depth_mm"] = 1.0, ["markers_top"] = 200,
                // v7（FP2）：判据读的是「画面上成立的穿出」，所以请求必须带渲图确认；没跑完时探针写
                // render.valid=false，阶段把所有测量读数写 null（no_data），不回退到射线口径。
                ["render_confirm"] = new Dictionary<string, object>
                {
                    ["enabled"] = true,
                    ["views"] = RenderViews,
                    ["height"] = RenderHeight,
                    ["depth_tolerance_mm"] = RenderDepthToleranceMm,
                },
                ["foot"] = new Dictionary<string, object> { ["enabled"] = true, ["probe_mm"] = 40, ["sole_min_mm"] = 4 },
            });

        /// <summary>Fixed picture-check views (`D-139` ①, FP2): front, back, both sides and the two upper
        /// obliques. Framing is the OV1/FP1/Portrait spec (bone height, ortho = h*0.60).</summary>
        internal const string RenderViews = "front,back,left,right,front_up,back_up";
        internal const int RenderHeight = 900;
        /// <summary>How far (mm) the frontmost surface at a pixel may sit from the candidate vertex and still be
        /// read as that vertex. Recorded in the observation so a reading can be reproduced.</summary>
        internal const double RenderDepthToleranceMm = 2.0;

        /// <summary>The plan's body prefab, or the setup baseline when the plan does not carry it. Empty when
        /// neither is readable — the probe then falls back to its own name/weight criteria.</summary>
        static string BodyPrefab()
        {
            var planned = Avh.Plan().Str("body_prefab");
            if (!string.IsNullOrEmpty(planned)) return planned;
            var baseline = Avh.ReadJsonFile(Avh.Abs("_harness/setup/baseline.json"));
            return baseline == null ? null : baseline.Str("body_prefab");
        }

        public static void Watch()
        {
            var outDir = SessionState.GetString(OutKey, "");
            var statusPath = Path.Combine(outDir, "status.json");
            if (!File.Exists(statusPath)) return;
            var status = Avh.ReadJsonFile(statusPath);
            var state = status == null ? "" : status.Str("state");
            if (state == "running") return;
            if (state != "done") { Fail(new Exception("贴合探针未完成：" + state + " " + (status == null ? "" : status.Str("message")))); return; }
            var id = StateId(SessionState.GetInt(IndexKey, 0));
            if (!File.Exists(Path.Combine(outDir, "geo_" + id + ".json"))) { Fail(new Exception("缺少状态证据：" + id)); return; }
            global::AvatarAudit.HarnessFitCallbacks.RemoveUpdate();
            if (EditorApplication.isPlaying) EditorApplication.ExitPlaymode(); else Advance();
        }

        /// <summary>Publishes the run's observation. Public so the Unity fixtures can drive the real publishing
        /// path and have the Runtime's own `parseObservation` read the file the product writes.</summary>
        public static void Publish(string outDir, List<Dictionary<string, float>> states)
        {
            var geos = new List<Dictionary<string, object>>();
            for (var i = 0; i < states.Count; i++)
                geos.Add(Avh.ReadJsonFile(Path.Combine(outDir, "geo_" + StateId(i) + ".json")));
            var fit = AggregateStates(geos, states);
            fit.Notes.Insert(0, $"状态集：期望 {states.Count}，读到 {fit.StatesRead} 个状态的证据");
            // v9 (FX1): the metric map accepts only numbers, booleans and null (`observation/0.1`), so the three
            // list-valued readings live in the observation's own `details` field. FX1's counterexample test moves
            // one back here and requires the Runtime's parser to reject the file.
            var metrics = new Dictionary<string, object>
            {
                // v6（`D-139` ①）：探针没跑完或状态不全时，下面所有读数写 null，消费方判 no_data，不写 0。
                ["fit_probe_completed"] = fit.Complete,
                ["fit_states_expected"] = states.Count,
                ["fit_states_completed"] = fit.StatesRead,
                // v8（`D-146` ①）判据读这一条：每个状态里「在画面上成立的穿出」顶点，按「衣物 × 部位」分组后，
                // 组内确认顶点达到噪声界的那些之和——射线口径的候选，逐视角投影后必须满足「素体在最前面、
                // 深度就是这个顶点、关掉素体后露出的是它穿出的那件」，再按组过噪声界。
                ["fit_pierced_vertices"] = fit.Pierced,
                // v8：不足噪声界的组只作证据，不参与判据。
                ["fit_pierced_vertices_below_gate"] = fit.PiercedBelowGate,
                // v7：原来的 FP1 口径（射线 + 遮挡）保留为候选筛选与排查读数，不再参与判据。
                ["fit_pierced_vertices_ray"] = fit.PiercedRay,
                ["fit_pierced_render_views"] = fit.Views,               // 用了几个视角（渲图确认）
                ["fit_pierced_render_states"] = fit.Complete ? (object)fit.RenderStates : null,
                ["fit_pierced_depth_tolerance_mm"] = fit.DepthToleranceMm,
                ["fit_max_depth_mm"] = fit.MaxDepth,
                // 以下只作排查观测，不参与判据：
                ["fit_pierced_vertices_raw"] = fit.Raw,                 // 旧口径：逐件 pierced 相加（只含有范围口径的衣物）
                ["fit_depth_saturated_vertices"] = fit.Saturated,       // 深度顶到射线预算的可见穿出顶点数（FW1 建议的观测）
                ["fit_pierced_no_data_vertices"] = fit.NoDataVertices,  // 其中被算成看得见穿出的顶点数（保守口径的代价）
                ["fit_pierced_garments_no_data"] = fit.NoDataGarments,  // 范围映射失败的衣物件数
                ["fit_footwear_records"] = fit.Footwear, ["fit_sole_below_vertices"] = fit.BelowSole,
                ["fit_toe_pierced_vertices"] = fit.ToePierced, ["fit_sole_signed_samples"] = fit.SignedSamples,
                ["fit_warnings"] = fit.Warnings,
                ["fit_body_mesh_count"] = fit.BodyMeshCount,
            };
            var details = new Dictionary<string, object>
            {
                // v9 (FX1): list-valued evidence, kept out of `metrics` above.
                // v7：逐件确认数（每件同时给确认数与射线数）。
                ["fit_pierced_confirmed_garments"] = fit.Complete ? (object)fit.ConfirmedGarments : null,
                // v8：逐组明细（衣物、部位、确认数、机位、像素），供核对哪一组被噪声界挡住。
                ["fit_pierced_groups"] = fit.Complete ? (object)fit.PiercedGroups : null,
                // Evidence of the measured scope: which meshes the probe took as the body (so a wrong body pick
                // is visible without reading geo_*.json).
                ["fit_body_paths"] = fit.BodyPaths,
            };
            Avh.Observation("avatar.fit", metrics, fit.Notes, details);
        }

        /// <summary>One fit run's readings. Null members mean "not measured" and are written as JSON null so the
        /// verdict engine reports no_data instead of a silent zero.</summary>
        internal sealed class FitMetrics
        {
            public bool Complete;                    // every expected state produced a readable, valid visible-piercing block AND a valid render block
            public int StatesRead;
            public int? Pierced, PiercedRay, Views, Raw, Saturated, NoDataVertices;
            // v8 (`D-146` ①): confirmed vertices in (garment × body part) groups that did not reach the noise
            // gate. Evidence only, never part of the criterion; measurement-class (null when not measured).
            public int? PiercedBelowGate;
            public int RenderStates;                 // states whose picture check completed
            public double DepthToleranceMm;
            public List<object> ConfirmedGarments = new List<object>();
            // v8: one row per (garment × body part) group with its confirmed count, views and pixels.
            public List<object> PiercedGroups = new List<object>();
            public int? Footwear, BelowSole, ToePierced, SignedSamples;
            public double? MaxDepth;
            public int NoDataGarments, Warnings, BodyMeshCount;
            public List<object> BodyPaths = new List<object>();
            public readonly List<string> Notes = new List<string>();
        }

        /// <summary>
        /// One (garment × body part) group of render-confirmed body vertices (`D-146` ①). A group that does not
        /// reach the noise gate is kept as evidence; only groups at or above it count toward the criterion.
        /// </summary>
        sealed class PiercedGroup
        {
            public string Garment = "";
            public string Region = "";
            public int Vertices;
            public readonly List<string> Views = new List<string>();
            public readonly List<int> Pixels = new List<int>();
        }

        /// <summary>
        /// v8（`D-146` ①）：把逐状态证据汇总成一次 fit 的读数。
        /// 判据用的 <c>Pierced</c> 取的是「在画面上成立」的穿出顶点（<c>visible_piercing.render.confirmed</c> 里
        /// <c>confirmed=true</c> 的行），先按「衣物 × 部位」分组，再只把组内确认顶点达到噪声界的那些相加；
        /// 不足噪声界的组记在 <c>PiercedBelowGate</c> 与 <c>PiercedGroups</c> 里，只作证据。
        /// 噪声界取 <c>OutfitVisibility.MinVisibleInterpenetrationVertices</c>（同一个数的唯一陈述，
        /// 与 thresholds.yaml <c>t.visible_interpenetration_min_vertices</c> 由测试比对），本文件不另写一个数。
        /// <c>PiercedRay</c> 是 v6/FP1 的口径（射线 + 遮挡），只作候选筛选与排查；<c>Raw</c> 是更旧的逐件相加。
        /// 任一状态缺证据、<c>visible_piercing.valid=false</c>、或渲图确认没跑完（<c>render.valid=false</c>、
        /// 没有逐点明细）时，所有测量类读数记 null（no_data），不当 0——不能把没量到的当成没问题。
        /// </summary>
        internal static FitMetrics AggregateStates(List<Dictionary<string, object>> geos,
            List<Dictionary<string, float>> states = null)
        {
            var fit = new FitMetrics { Complete = true };
            var pierced = 0; var piercedRay = 0; var raw = 0; var saturated = 0; var noDataVertices = 0;
            var maxDepth = 0d;
            var views = 0;
            var tolerance = 0d;
            var perGarment = new Dictionary<string, int[]>(StringComparer.Ordinal);   // path -> [confirmed, ray]
            var groups = new Dictionary<string, PiercedGroup>(StringComparer.Ordinal); // "garment\u0001region" -> group
            var footwear = 0; var belowSole = 0; var toePierced = 0; var signedSamples = 0; var warnings = 0;
            for (var i = 0; i < (geos?.Count ?? 0); i++)
            {
                var id = $"state_{i:000}";
                var geo = geos[i];
                if (geo == null)
                {
                    fit.Complete = false;
                    fit.Notes.Add($"{id}：缺少状态证据 geo_{id}.json");
                    continue;
                }
                fit.StatesRead++;
                var garments = geo.List("garments").Cast<Dictionary<string, object>>().ToList();
                var feet = geo.List("feet").Cast<Dictionary<string, object>>().Where(f => f.Str("class") == "footwear").ToList();
                // The old per-garment sum is kept as a diagnostic; a garment whose scope was cancelled still has a
                // null total.pierced and shows up as no_data rather than as a silent zero.
                var legacy = AggregateGarments(garments);
                raw += legacy.pierced;
                fit.NoDataGarments += legacy.noData;
                footwear += feet.Count;
                belowSole += feet.Sum(f => Convert.ToInt32(f["below_sole"]));
                toePierced += feet.Sum(f => Convert.ToInt32(f["toe_pierced"]));
                signedSamples += feet.Sum(f => Convert.ToInt32(f["signed_count"]));
                warnings += geo.List("warnings").Count;
                fit.BodyPaths = geo.List("body_paths");
                object meshCount;
                fit.BodyMeshCount = geo.TryGetValue("body_mesh_count", out meshCount) && meshCount != null
                    ? Convert.ToInt32(meshCount) : 0;

                var block = geo.Obj("visible_piercing");
                var statePierced = VisibleCount(block, "vertices");       // ray criterion (candidates)
                var stateNoData = VisibleCount(block, "no_data_vertices");
                var stateSaturated = VisibleCount(block, "saturated_vertices");
                var render = VisibleBlock(block, "render");
                var stateConfirmed = VisibleCount(render, "vertices");     // picture check (criterion)
                var stateViews = VisibleCount(render, "views");
                var stateTolerance = VisibleNumber(render, "depth_tolerance_mm");
                if (statePierced == null || stateNoData == null || stateSaturated == null)
                {
                    fit.Complete = false;
                    fit.Notes.Add($"{id}：探针没有给出有效的「看得见的穿出」读数（visible_piercing 缺失或 valid=false）");
                    continue;
                }
                if (stateConfirmed == null)
                {
                    fit.Complete = false;
                    fit.Notes.Add($"{id}：渲图确认没完成（visible_piercing.render 缺失或 valid=false），"
                        + "判据读数记 null");
                    continue;
                }
                // v8 (`D-146` ①): the criterion groups the picture-confirmed vertices by garment × body part, so
                // it needs the per-vertex rows, not just the count. A render block without them cannot be gated:
                // read as "not measured" rather than as a clean zero.
                object confirmedRowsValue;
                if (render == null || !render.TryGetValue("confirmed", out confirmedRowsValue)
                    || !(confirmedRowsValue is List<object>))
                {
                    fit.Complete = false;
                    fit.Notes.Add($"{id}：渲图确认没有逐点明细（visible_piercing.render.confirmed），"
                        + "无法按「衣物 × 部位」分组，判据读数记 null");
                    continue;
                }
                foreach (var rowValue in (List<object>)confirmedRowsValue)
                {
                    var row = rowValue as Dictionary<string, object>;
                    if (!RowConfirmed(row)) continue;
                    var garment = row.Str("garment") ?? "";
                    var region = row.Str("region") ?? "";
                    var groupKey = garment + "\u0001" + region;
                    PiercedGroup group;
                    if (!groups.TryGetValue(groupKey, out group))
                    {
                        group = new PiercedGroup { Garment = garment, Region = region };
                        groups[groupKey] = group;
                    }
                    group.Vertices++;
                    foreach (var view in row.List("views"))
                    {
                        var name = Convert.ToString(view);
                        if (!group.Views.Contains(name)) group.Views.Add(name);
                    }
                    foreach (var pixel in row.List("pixels")) group.Pixels.Add(Convert.ToInt32(pixel));
                }
                piercedRay += statePierced.Value;
                noDataVertices += stateNoData.Value;
                saturated += stateSaturated.Value;
                if (stateViews != null && stateViews.Value > views) views = stateViews.Value;
                if (stateTolerance != null) tolerance = stateTolerance.Value;
                fit.RenderStates++;
                var stateDepth = VisibleNumber(block, "max_depth_mm");
                if (stateDepth != null) maxDepth = Math.Max(maxDepth, stateDepth.Value);
                var renderPer = render != null ? render.List("per_garment").Cast<Dictionary<string, object>>().ToList()
                    : new List<Dictionary<string, object>>();
                foreach (var entry in renderPer)
                {
                    var path = entry.Str("path") ?? "";
                    int[] counts;
                    if (!perGarment.TryGetValue(path, out counts)) { counts = new int[2]; perGarment[path] = counts; }
                    counts[0] += Convert.ToInt32(entry["vertices"]);
                }
                foreach (var entry in block.List("garments").Cast<Dictionary<string, object>>())
                {
                    var path = entry.Str("path") ?? "";
                    object rayValue;
                    if (!entry.TryGetValue("vertices", out rayValue) || rayValue == null) continue;
                    int[] counts;
                    if (!perGarment.TryGetValue(path, out counts)) { counts = new int[2]; perGarment[path] = counts; }
                    counts[1] += Convert.ToInt32(rayValue);
                }
                var parameters = states != null && i < states.Count
                    ? string.Join(",", states[i].Select(kv => $"{kv.Key}={kv.Value}")) : "";
                fit.Notes.Add($"{id} [{parameters}]：衣物 {garments.Count}，"
                    + $"画面上成立的穿出 {stateConfirmed.Value}（射线口径 {statePierced.Value}，旧口径逐件相加 {legacy.pierced}），"
                    + $"视角 {stateViews ?? 0}，深度容差 {stateTolerance ?? 0:0.###} mm，"
                    + $"最大深度 {stateDepth ?? 0:0.###} mm，顶到射线预算 {stateSaturated.Value}，鞋类记录 {feet.Count}，"
                    + $"无范围口径(no_data) 衣物 {legacy.noData}，其中被算成可见穿出 {stateNoData.Value}");
            }
            // ── noise gate (`D-146` ①) ────────────────────────────────────────────────────────
            // The picture check can confirm a handful of stray vertices where the body shows through a collar or a
            // seam. `D-145` already sets a calibrated noise floor for visible interpenetration; the body criterion
            // uses the same number, applied per (garment × body part) group: a group that does not reach it is
            // evidence, not a violation, and only groups at or above it count toward the criterion. The number is
            // read from its one statement in code (`OutfitVisibility.MinVisibleInterpenetrationVertices`, compared
            // against thresholds.yaml `t.visible_interpenetration_min_vertices` by
            // test/outfit-visible-overlaps.test.ts), so this file does not state a second copy of it.
            var gate = OutfitVisibility.MinVisibleInterpenetrationVertices;
            var totalConfirmed = 0;
            foreach (var groupValue in groups.Values) totalConfirmed += groupValue.Vertices;
            var groupRows = new List<object>();
            var belowGate = 0;
            var groupKeys = new List<string>(groups.Keys);
            groupKeys.Sort(StringComparer.Ordinal);
            foreach (var groupKey in groupKeys)
            {
                var group = groups[groupKey];
                // MUTATION HOOK (fixture "gate-dropped" / "gate-by-total"): the noise gate must be applied per
                // group — dropping it, or gating on the whole-state total instead, must make the fixture fail.
                if (group.Vertices >= gate) pierced += group.Vertices; else belowGate += group.Vertices;
                group.Views.Sort(StringComparer.Ordinal);
                group.Pixels.Sort();
                groupRows.Add(new Dictionary<string, object>
                {
                    ["garment"] = group.Garment,
                    ["region"] = group.Region,
                    ["vertices"] = group.Vertices,
                    ["views"] = group.Views.Cast<object>().ToList(),
                    ["pixels"] = group.Pixels.Cast<object>().ToList(),
                    ["counted"] = group.Vertices >= gate,
                });
            }
            if (fit.Complete)
            {
                fit.Pierced = pierced; fit.PiercedRay = piercedRay; fit.Raw = raw; fit.Saturated = saturated;
                fit.PiercedBelowGate = belowGate;
                fit.PiercedGroups = groupRows;
                fit.Notes.Add($"噪声界 {gate}（`D-146` ①，同 t.visible_interpenetration_min_vertices）："
                    + $"确认顶点合计 {totalConfirmed}，按「衣物 × 部位」分 {groupRows.Count} 组，"
                    + $"达到界计入判据 {pierced}，不足界只作证据 {belowGate}");
                fit.NoDataVertices = noDataVertices;
                fit.Views = views; fit.DepthToleranceMm = tolerance;
                fit.MaxDepth = Math.Round(maxDepth, 3);
                fit.Footwear = footwear; fit.BelowSole = belowSole; fit.ToePierced = toePierced;
                fit.SignedSamples = signedSamples;
                var paths = new List<string>(perGarment.Keys);
                paths.Sort(StringComparer.Ordinal);
                foreach (var path in paths)
                {
                    fit.ConfirmedGarments.Add(new Dictionary<string, object>
                    {
                        ["path"] = path,
                        ["vertices"] = perGarment[path][0],
                        ["ray_vertices"] = perGarment[path][1],
                    });
                }
            }
            fit.Warnings = warnings;
            return fit;
        }

        /// <summary>A nested block of the probe's visible-piercing block, or null when it is absent.</summary>
        static Dictionary<string, object> VisibleBlock(Dictionary<string, object> block, string key)
        {
            if (block == null) return null;
            object value;
            if (!block.TryGetValue(key, out value)) return null;
            return value as Dictionary<string, object>;
        }

        /// <summary>A metric inside the probe's visible-piercing block: null when the block is missing, invalid, or
        /// the metric itself is null. Never coerced to 0.</summary>
        static int? VisibleCount(Dictionary<string, object> block, string key)
        {
            if (block == null || block.Str("valid") != "True") return null;
            object value;
            if (!block.TryGetValue(key, out value) || value == null) return null;
            return Convert.ToInt32(value);
        }

        static double? VisibleNumber(Dictionary<string, object> block, string key)
        {
            if (block == null || block.Str("valid") != "True") return null;
            object value;
            if (!block.TryGetValue(key, out value) || value == null) return null;
            return Convert.ToDouble(value);
        }

        /// <summary>One row of <c>visible_piercing.render.confirmed</c>: whether the picture check confirmed that
        /// vertex. Missing or non-boolean reads as not confirmed.</summary>
        static bool RowConfirmed(Dictionary<string, object> row)
        {
            object value;
            return row != null && row.TryGetValue("confirmed", out value) && value != null && Convert.ToBoolean(value);
        }

        /// <summary>The OLD per-garment pierce sum, kept only as a diagnostic reading (<c>fit_pierced_vertices_raw</c>):
        /// summing a vertex once per garment counts multi-layer fabric and outer-covered vertices. Only garments with
        /// a numeric <c>total.pierced</c> count: the probe writes null there when it had to cancel the coverage scope,
        /// and summing that as 0 would report "no clipping" for a garment it never measured.</summary>
        internal static (int pierced, int noData, double maxDepth) AggregateGarments(IEnumerable<Dictionary<string, object>> garments)
        {
            var pierced = 0; var noData = 0; var maxDepth = 0d;
            foreach (var garment in garments)
            {
                object raw;
                var total = garment != null && garment.TryGetValue("total", out raw)
                    ? raw as Dictionary<string, object> : null;
                if (total == null) { noData++; continue; }
                object count;
                if (!total.TryGetValue("pierced", out count) || count == null) { noData++; continue; }
                pierced += Convert.ToInt32(count);
                object depth;
                if (total.TryGetValue("max_depth_mm", out depth) && depth != null)
                    maxDepth = Math.Max(maxDepth, Convert.ToDouble(depth));
            }
            return (pierced, noData, maxDepth);
        }

        static void Fail(Exception error) { Debug.LogError("[HarnessFitStage] " + error); Clear(); EditorApplication.Exit(1); }
        static void Clear()
        {
            SessionState.SetBool(ActiveKey, false);
            SessionState.EraseInt(IndexKey); SessionState.EraseInt(CountKey); SessionState.EraseString(OutKey);
            global::AvatarAudit.HarnessFitCallbacks.Uninstall();
        }
    }
}

// AuditCallbackIsolation intentionally preserves callbacks declared under AvatarAudit.  This adapter lets the
// orchestrator survive the probe's isolation without exempting arbitrary project-side callbacks.
namespace AvatarAudit
{
    public static class HarnessFitCallbacks
    {
        static bool playInstalled;

        public static void Install()
        {
            EditorApplication.update -= OnUpdate;
            EditorApplication.update += OnUpdate;
            if (playInstalled) return;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            playInstalled = true;
        }

        public static void RemoveUpdate() => EditorApplication.update -= OnUpdate;

        public static void Uninstall()
        {
            EditorApplication.update -= OnUpdate;
            if (!playInstalled) return;
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
            playInstalled = false;
        }

        static void OnUpdate() => global::AVH.Harness.HarnessFitStage.Watch();

        static void OnPlayModeChanged(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.EnteredEditMode)
                EditorApplication.delayCall += global::AVH.Harness.HarnessFitStage.Advance;
        }
    }
}
