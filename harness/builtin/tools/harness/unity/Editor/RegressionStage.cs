// 【项目沉淀】通用工具（Harness regression_pre / regression 阶段的 Unity 步骤）
// 适用素体：无关
// 工具链　：Unity 2022.3 批处理；读构建产物（NDMF/MA/AAO 处理后的控制器）
// 可复用性：★★☆ 口径是「构建后控制器的静态模拟」，不是 Play（见下）
// 用途　　：在构建副本的产物上回归（SOP 70）：
//           · T1：本单参数每个取值 × 厂商每个布尔开关单独翻转，逐态求显隐与形态键；
//           · 真序列：每个开关「关→开→关」、本单参数「切走→切回」，按「从当前状态沿转移走」模拟，比首尾是否一致（串档）；
//           · 同名键跟随：衣服可见时，衣服与身体同名形态键的值差；值差超过 5 的全部配对在原状态保留衣物权重，
//             仅把身体键取 0/100 端点烘焙，按件到身体 BVH 距离的最坏 p95 变化写入已有几何指标；
//           · 换装照：每个服装取值同机位出一张，断言「点名 N 件、开了 N 件」。
//           口径：模拟读的是构建后控制器里真实的层、转移与曲线（写默认值开启的层），但没进 Play——混合树按 Direct / 1D 加权，
//           其它类型取第一个子动作；层动画写的动画器参数（MA 的显隐代理）迭代到不动点；不跑 PhysBone/约束/参数驱动器。覆盖记录（_regression/coverage.json）逐项写明跑了什么、没跑什么（SOP 70「覆盖记录」）。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Dynamics.Constraint.Components;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;

namespace AVH.Harness
{
    public static class RegressionStage
    {
        public const string CoveragePath = "_regression/coverage.json";

        public static void Run() => Avh.Stage("regression", Produce, save: false);

        public static void Produce()
        {
            if (AvatarConfig.Grouped(Avh.Plan())) { MenuGroupAudit.Regression(); return; }
            var slot = Avh.Env("AVH_BUILD_SLOT", "final");
            var menu = Avh.ReadJsonFile(Avh.Abs(MenuStage.RecordPath)) ?? throw new Exception("缺少菜单层记录 menu.json");
            var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)) ?? throw new Exception("缺少服装层记录 outfit.json");
            var ours = menu.List("parameters").Select(x => x.ToString()).ToList();
            var controls = menu.List("controls").Cast<Dictionary<string, object>>().ToList();
            var outfits = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
            var exclusive = outfits.Where(o => !OutfitStage.Fixed(o)).ToList();
            var defaultOutfit = exclusive.FirstOrDefault(o => Equals(o["default"], true));
            if (exclusive.Count > 0 && defaultOutfit == null) throw new Exception("exclusive 服装没有默认选项");
            var sources = menu.List("conflicts").Cast<Dictionary<string, object>>().SelectMany(c => c.List("sources")).Select(x => x.ToString())
                .Concat(outfits.Select(o => o.Str("object"))).Distinct().ToList();
            var byPath = outfits.ToDictionary(o => o.Str("object"));
            bool Visible(string path, AnimatorSim.Snapshot snapshot) => byPath.TryGetValue(path, out var entry)
                ? OutfitMeasure.Visible(entry, snapshot.Visible) : snapshot.Visible(path);

            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(BuildStage.BuiltPrefab) ?? throw new Exception($"构建产物不存在：{BuildStage.BuiltPrefab}");
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                var sim = new AnimatorSim(avatar);
                var ourValues = ours.ToDictionary(p => p, p => new[] { 0f }.Concat(controls.Where(c => c.Str("parameter") == p).Select(c => Convert.ToSingle(c["value"]))).Distinct().ToArray());
                var toggles = sim.MenuToggles().Where(p => !ours.Contains(p)).ToList();
                var notes = new List<string>();
                var verifyNotes = new List<string>();

                // T1
                var states = new List<Dictionary<string, float>>();
                foreach (var cell in Cells(ourValues))
                {
                    states.Add(cell);
                    foreach (var toggle in toggles) states.Add(new Dictionary<string, float>(cell) { [toggle] = sim.Default(toggle) != 0 ? 0f : 1f });
                }
                var t1 = new List<object>();
                var missingStates = 0;
                var fixedFailures = OutfitMeasure.FixedFailures(avatar, record, Avh.Plan(), notes,
                    sim.Evaluate(new Dictionary<string, float>()).Visible);
                var keyDelta = 0f;
                string keyWorst = null;
                bool keyPairUnknown = false;
                double keyGeometryWorst = 0d;
                bool keyGeometryMeasured = false;
                bool keyGeometryUnknown = false;
                foreach (var state in states)
                {
                    try
                    {
                        var snapshot = sim.Evaluate(state);
                        // Vendor subcomponent toggles may change a fixed root's contents. Its root stays mounted;
                        // default visual presence (including reparented BoneProxy parts) is checked above.
                        fixedFailures += OutfitMeasure.FixedFailures(avatar, record, Avh.Plan(), notes, snapshot.Visible, includeVisuals: false);
                        t1.Add(new Dictionary<string, object>
                        {
                            ["params"] = state.ToDictionary(kv => kv.Key, kv => (object)kv.Value),
                            ["worn"] = sources.Where(s => Visible(s, snapshot)).Select(s => (object)s).ToList(),
                            ["visible_renderers"] = snapshot.VisibleRenderers,
                        });
                        foreach (var outfit in outfits.Where(o => OutfitMeasure.Visible(o, snapshot.Visible)))
                        {
                            var allOutfitPaths = outfits.Select(o => o.Str("object")).ToList();
                            if (!snapshot.BodySelectionKnown(allOutfitPaths)) keyPairUnknown = true;
                            foreach (var pair in snapshot.KeyFollowPairsFor(outfit.Str("object"), allOutfitPaths))
                                if (pair.Delta > keyDelta) keyDelta = pair.Delta;
                            var worst = snapshot.WorstKeyFollowPair(outfit.Str("object"), allOutfitPaths);
                            if (worst != null && worst.Delta >= keyDelta)
                                keyWorst = $"{worst.Where}（{string.Join(",", state.Select(kv => $"{kv.Key}={kv.Value}"))}）";
                        }
                        var overPairs = outfits.Where(o => OutfitMeasure.Visible(o, snapshot.Visible))
                            .SelectMany(o => snapshot.KeyFollowPairsFor(o.Str("object"), outfits.Select(x => x.Str("object"))))
                            .Where(pair => pair.Delta > 5f).ToList();
                        if (overPairs.Count > 0)
                        {
                            snapshot.Apply(avatar);
                            try
                            {
                                foreach (var pair in overPairs)
                                {
                                    var reading = global::AvatarAudit.AuditPartInventory.MeasureFollowGeometry(pair.Body, pair.Piece, pair.Key);
                                    if (!reading.Available)
                                    {
                                        keyGeometryUnknown = true;
                                        verifyNotes.Add($"同名键几何量距失败（{pair.Where}）：{reading.Note}（保持未测，不记 0）");
                                    }
                                    else
                                    {
                                        keyGeometryMeasured = true;
                                        keyGeometryWorst = Math.Max(keyGeometryWorst, reading.P95DeltaMm);
                                        verifyNotes.Add($"同名键几何量距 {pair.Where}：p95 变化 {reading.P95DeltaMm:0.###} mm（样本 {reading.Samples}）");
                                    }
                                }
                            }
                            finally
                            {
                                sim.Restore();
                                verifyNotes.Add($"同名键几何量距后现场恢复状态={sim.IsRestored()}（{overPairs.Count} 对）");
                            }
                        }
                    }
                    catch (Exception error) { missingStates++; notes.Add($"T1 态求不出：{string.Join(",", state.Select(kv => $"{kv.Key}={kv.Value}"))}：{error.Message}"); }
                }
                notes.Add($"T1：{states.Count} 态（本单参数 {Cells(ourValues).Count()} 档 × 厂商开关 {toggles.Count} 个单独翻转）");
                double? keyGeometry = keyGeometryMeasured && (!keyGeometryUnknown || keyGeometryWorst >= 1.0)
                    ? Math.Round(keyGeometryWorst, 3) : null;
                if (keyGeometryUnknown && (!keyGeometryMeasured || keyGeometryWorst < 1.0))
                    verifyNotes.Add("存在超阈值同名键配对无法量距，且尚不能确定违规：几何指标保持 null");

                // 真序列：从默认出发，翻过去再翻回来，首尾应一致；正常走完但首尾不一致（串档）同样是失败
                var drift = new List<string>();
                var (missingSequences, sequenceCount) = MissingRealSequences(sim, ourValues, toggles, drift, notes);

                // 换装照：本单参数每个取值一张，点名那套必须开着、别的服装与素体自带衣服必须关着
                var photos = new List<object>();
                var namedMinusWorn = 0;
                foreach (var cell in Cells(ourValues))
                {
                    var snapshot = sim.Evaluate(cell);
                    var named = NamedOutfit(cell, controls, outfits, defaultOutfit);
                    var worn = sources.Where(s => Visible(s, snapshot)).ToList();
                    namedMinusWorn += named.Except(worn).Count() + worn.Except(named).Count();
                    foreach (var extra in worn.Except(named))
                        notes.Add($"{string.Join(",", cell.Select(kv => $"{kv.Key}={kv.Value}"))} 时 {extra} 也开着：" + string.Join("；", sim.Writers(extra)));
                    snapshot.Apply(avatar);
                    var name = "outfit_" + string.Join("_", cell.Select(kv => $"{kv.Key}{kv.Value}"));
                    var spec = Portrait.Front(avatar, Path.Combine(Avh.RunDir, "photos", name + ".png"));
                    Avh.WriteJson(Path.Combine(Avh.RunDir, "photos", name + ".json"), spec);
                    sim.Restore();
                    photos.Add(new Dictionary<string, object> { ["photo"] = name + ".png", ["named"] = named.Cast<object>().ToList(), ["worn"] = worn.Cast<object>().ToList() });
                }
                notes.Add($"换装照 {photos.Count} 张（Run 目录 photos/），点名与实际开着的差 {namedMinusWorn}");

                var notRan = new List<object> { "Play 口径 T1/T4（AvatarAudit）", "T3 转台渲图", "感知机制声明对账（本单无声明）",
                    "2D 混合树（取第一个子动作）", "PhysBone/约束/参数驱动器" };
                if (keyGeometry == null || keyGeometryUnknown)
                    notRan.Insert(1, "几何量距（key_follow p95；存在未完成配对，原因见 avatar.verify 的 notes）");

                var coverage = new Dictionary<string, object>
                {
                    ["schema"] = "coverage/0.1", ["slot"] = slot, ["method"] = "构建后控制器静态模拟（未进 Play）",
                    ["ran"] = new List<object> { $"T1 {states.Count} 态", $"真序列 {sequenceCount} 条", keyGeometry == null ? "同名键跟随（值差）" : "同名键跟随（值差 + 几何 p95 mm）", $"换装照 {photos.Count} 张" },
                    ["not_ran"] = notRan,
                    ["t1"] = t1, ["sequence_drift"] = drift.Cast<object>().ToList(), ["photos"] = photos,
                };
                Avh.WriteJson(Avh.Abs(CoveragePath), coverage);
                Avh.WriteJson(Path.Combine(Avh.RunDir, "coverage.json"), coverage);

                Avh.Observation("avatar.observe", new Dictionary<string, object>
                {
                    ["t1_missing_required_states"] = missingStates, ["missing_real_sequences"] = missingSequences,
                    ["outfit_photo_named_minus_worn"] = namedMinusWorn,
                    ["fixed_outfit_state_failures"] = fixedFailures,
                }, notes);
                if (keyWorst != null) verifyNotes.Add($"同名键最大值差 {keyDelta:0.##}：{keyWorst}");
                object keyDeltaMetric = keyPairUnknown ? null : (object)Math.Round(keyDelta, 3);
                Avh.Observation("avatar.verify", new Dictionary<string, object>
                {
                    ["key_follow_value_delta_max"] = keyDeltaMetric, ["key_follow_geometry_p95_mm"] = keyGeometry,
                    ["coverage_record_present"] = File.Exists(Avh.Abs(CoveragePath)),
                    ["perception_declaration_unresolved"] = 0,
                }, verifyNotes);
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }

        static IEnumerable<Dictionary<string, float>> Cells(Dictionary<string, float[]> domains)
        {
            IEnumerable<Dictionary<string, float>> cells = new[] { new Dictionary<string, float>() };
            foreach (var (name, values) in domains)
                cells = cells.SelectMany(cell => values.Select(v => new Dictionary<string, float>(cell) { [name] = v })).ToList();
            return cells;
        }

        /// <summary>
        /// SOP 70 真序列: from the default state, flip each vendor toggle out and back, and each of this order's
        /// parameter values out and back. Returns the metric production reports plus how many sequences were walked.
        /// A sequence that cannot be walked and a sequence that walks but ends in a different state (串档) are both
        /// failures: the second is what a one-directional suppressor looks like, and counting only the first let a
        /// real sequence drift pass as <c>missing_real_sequences == 0</c>. Drift stays a separate reading for the
        /// coverage record; no new metric is introduced.
        /// </summary>
        public static (int missing, int total) MissingRealSequences(AnimatorSim sim, Dictionary<string, float[]> ourValues,
            List<string> toggles, List<string> drift, List<string> notes)
        {
            var sequences = toggles.Select(t => new[] { new Dictionary<string, float> { [t] = sim.Default(t) != 0 ? 0f : 1f }, new Dictionary<string, float> { [t] = sim.Default(t) } }).ToList();
            foreach (var (p, values) in ourValues)
                foreach (var v in values.Where(v => v != sim.Default(p)))
                    sequences.Add(new[] { new Dictionary<string, float> { [p] = v }, new Dictionary<string, float> { [p] = sim.Default(p) } });
            var missing = 0;
            foreach (var sequence in sequences)
            {
                try
                {
                    var first = sim.Evaluate(new Dictionary<string, float>());
                    var last = sim.Walk(sequence);
                    if (!first.SameAs(last)) drift.Add(string.Join(" → ", sequence.Select(s => s.Count == 0 ? "默认" : string.Join(",", s.Select(kv => $"{kv.Key}={kv.Value}")))));
                }
                catch (Exception error) { missing++; notes.Add($"真序列求不出：{error.Message}"); }
            }
            notes.Add($"真序列：{sequences.Count} 条，首尾不一致（串档）{drift.Count} 条" + (drift.Count > 0 ? "：" + string.Join("；", drift.Take(5)) : ""));
            return (missing + drift.Count, sequences.Count);
        }

        static List<string> NamedOutfit(Dictionary<string, float> cell, List<Dictionary<string, object>> controls, List<Dictionary<string, object>> outfits, Dictionary<string, object> defaultOutfit)
        {
            if (outfits.Count == 0) return new List<string>();
            // 整套衣装只有一个径向选择参数；部件组 Bool 不参与套间归属。
            var chosen = defaultOutfit;
            foreach (var control in controls.Where(c => c.Str("control") == "RadialChoice"))
                if (cell.TryGetValue(control.Str("parameter"), out var v) && Math.Abs(v - Convert.ToSingle(control["value"])) < 1e-3)
                    chosen = outfits.FirstOrDefault(o => !OutfitStage.Fixed(o) && o.Str("label") == control.Str("label")) ?? chosen;
            var named = outfits.Where(OutfitStage.Fixed).Select(o => o.Str("object")).ToList();
            if (chosen != null) named.Add(chosen.Str("object"));
            return named;
        }
    }

    /// <summary>
    /// Static simulation of an avatar's built animator layers: which state each layer rests in for given parameter values,
    /// and what the resting states write (m_IsActive, blendShape.*). Layers are write-defaults: anything no state writes keeps
    /// its scene value.
    /// </summary>
    public class AnimatorSim
    {
        readonly GameObject avatar;
        readonly List<(AnimatorController controller, AnimatorControllerLayer layer)> layers = new List<(AnimatorController, AnimatorControllerLayer)>();
        readonly Dictionary<string, float> defaults = new Dictionary<string, float>();
        readonly Dictionary<Transform, bool> sceneActive = new Dictionary<Transform, bool>();
        readonly Dictionary<Transform, Vector3> sceneScale = new Dictionary<Transform, Vector3>();
        readonly Dictionary<VRCScaleConstraint, bool> sceneConstraints = new Dictionary<VRCScaleConstraint, bool>();
        readonly Dictionary<(SkinnedMeshRenderer, int), float> sceneWeights = new Dictionary<(SkinnedMeshRenderer, int), float>();
        readonly Dictionary<(Renderer, int), Material> sceneMaterials = new Dictionary<(Renderer, int), Material>();
        readonly Dictionary<Renderer, bool> sceneEnabled = new Dictionary<Renderer, bool>();
        readonly Dictionary<AnimatorControllerLayer, AnimatorState> current = new Dictionary<AnimatorControllerLayer, AnimatorState>();
        readonly VRCAvatarDescriptor descriptor;

        public AnimatorSim(GameObject avatar)
        {
            this.avatar = avatar;
            descriptor = avatar.GetComponent<VRCAvatarDescriptor>();
            foreach (var (_, controller) in AvatarAudit.Layers(descriptor))
            {
                foreach (var p in controller.parameters)
                    defaults[p.name] = p.type == AnimatorControllerParameterType.Bool ? (p.defaultBool ? 1f : 0f) : p.type == AnimatorControllerParameterType.Int ? p.defaultInt : p.defaultFloat;
                for (var i = 0; i < controller.layers.Length; i++)
                    if (i == 0 || controller.layers[i].defaultWeight > 0) layers.Add((controller, controller.layers[i]));
            }
            if (descriptor.expressionParameters != null)
                foreach (var p in descriptor.expressionParameters.parameters) defaults[p.name] = p.defaultValue;
            foreach (var t in avatar.GetComponentsInChildren<Transform>(true)) { sceneActive[t] = t.gameObject.activeSelf; sceneScale[t] = t.localScale; }
            foreach (var c in avatar.GetComponentsInChildren<VRCScaleConstraint>(true)) sceneConstraints[c] = c.IsActive;
            foreach (var r in avatar.GetComponentsInChildren<Renderer>(true))
            {
                sceneEnabled[r] = r.enabled;
                for (var i = 0; i < r.sharedMaterials.Length; i++) sceneMaterials[(r, i)] = r.sharedMaterials[i];
            }
            foreach (var smr in avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true))
                if (smr.sharedMesh != null)
                    for (var i = 0; i < smr.sharedMesh.blendShapeCount; i++) sceneWeights[(smr, i)] = smr.GetBlendShapeWeight(i);
        }

        public float Default(string parameter) => defaults.TryGetValue(parameter, out var v) ? v : 0f;

        /// <summary>Boolean parameters that a Toggle control in the built menu tree drives.</summary>
        public List<string> MenuToggles()
        {
            var menus = new List<VRCExpressionsMenu>();
            void Collect(VRCExpressionsMenu m)
            {
                if (m == null || menus.Contains(m)) return;
                menus.Add(m);
                foreach (var c in m.controls) if (c.type == VRCExpressionsMenu.Control.ControlType.SubMenu) Collect(c.subMenu);
            }
            Collect(descriptor.expressionsMenu);
            var bools = new HashSet<string>((descriptor.expressionParameters?.parameters ?? new VRCExpressionParameters.Parameter[0])
                .Where(p => p.valueType == VRCExpressionParameters.ValueType.Bool).Select(p => p.name));
            return menus.SelectMany(m => m.controls).Where(c => c.type == VRCExpressionsMenu.Control.ControlType.Toggle && c.parameter != null && bools.Contains(c.parameter.name))
                .Select(c => c.parameter.name).Distinct().ToList();
        }

        Dictionary<string, float> Values(Dictionary<string, float> overrides)
        {
            var values = new Dictionary<string, float>(defaults);
            foreach (var (k, v) in overrides) values[k] = v;
            return values;
        }

        /// <summary>Every layer entered fresh with these values (the state a newly loaded avatar reaches).</summary>
        public Snapshot Evaluate(Dictionary<string, float> overrides)
        {
            var values = Values(overrides);
            current.Clear();
            foreach (var (_, layer) in layers) current[layer] = Follow(layer.stateMachine, Enter(layer.stateMachine, values), values);
            return Snap(values);
        }

        /// <summary>From the default state, apply each step's values in turn, moving each layer along its transitions from where it is.</summary>
        public Snapshot Walk(IEnumerable<Dictionary<string, float>> steps)
        {
            Evaluate(new Dictionary<string, float>());
            var values = lastValues;
            foreach (var step in steps)
            {
                // 菜单参数按这一步给的值；MA 的显隐代理参数沿用上一步动画写出的值（它们由层驱动，不由人点）
                values = new Dictionary<string, float>(lastValues);
                foreach (var (k, v) in step) if (!k.StartsWith("__MA/")) values[k] = v;
                foreach (var (_, layer) in layers) current[layer] = Follow(layer.stateMachine, current[layer], values);
                Snap(values);
            }
            return Snap(lastValues);
        }

        static bool Holds(AnimatorTransitionBase t, Dictionary<string, float> values) => t.conditions.All(c =>
        {
            var v = values.TryGetValue(c.parameter, out var x) ? x : 0f;
            switch (c.mode)
            {
                case AnimatorConditionMode.If: return v != 0;
                case AnimatorConditionMode.IfNot: return v == 0;
                case AnimatorConditionMode.Greater: return v > c.threshold;
                case AnimatorConditionMode.Less: return v < c.threshold;
                case AnimatorConditionMode.Equals: return Math.Abs(v - c.threshold) < 1e-4;
                case AnimatorConditionMode.NotEqual: return Math.Abs(v - c.threshold) >= 1e-4;
                default: return false;
            }
        });

        static AnimatorState Enter(AnimatorStateMachine machine, Dictionary<string, float> values) =>
            machine.entryTransitions.FirstOrDefault(t => Holds(t, values))?.destinationState ?? machine.defaultState;

        static AnimatorState Follow(AnimatorStateMachine machine, AnimatorState state, Dictionary<string, float> values)
        {
            for (var step = 0; step < 32 && state != null; step++)
            {
                var any = machine.anyStateTransitions.FirstOrDefault(t => t.destinationState != null && t.destinationState != state && t.conditions.Length > 0 && Holds(t, values));
                if (any != null) { state = any.destinationState; continue; }
                var next = state.transitions.FirstOrDefault(t => t.conditions.Length > 0 && Holds(t, values));
                if (next == null) break;
                var target = next.isExit ? Enter(machine, values) : next.destinationState;
                if (target == null || target == state) break;
                state = target;
            }
            return state;
        }

        Dictionary<string, float> lastValues = new Dictionary<string, float>();

        /// <summary>
        /// What the resting states write. Blend trees are weighted (Direct: the child's parameter; 1D: linear between the two
        /// neighbouring thresholds; other types fall back to the first child). Write-defaults blending: a property a child does
        /// not write keeps its default for that child's share. Animator parameters that layers animate (MA's active-state
        /// proxies) feed later evaluation, iterated to a fixpoint.
        /// </summary>
        Snapshot Snap(Dictionary<string, float> values)
        {
            values = new Dictionary<string, float>(values);
            Dictionary<Transform, bool> active = null;
            Dictionary<(SkinnedMeshRenderer, int), float> weights = null;
            Dictionary<(Renderer, int), Material> materials = null;
            Dictionary<Renderer, bool> enabled = null;
            Dictionary<Transform, Vector3> scales = null;
            Dictionary<VRCScaleConstraint, bool> constraints = null;
            for (var round = 0; round < 4; round++)
            {
                active = new Dictionary<Transform, bool>(sceneActive);
                weights = new Dictionary<(SkinnedMeshRenderer, int), float>(sceneWeights);
                materials = new Dictionary<(Renderer, int), Material>(sceneMaterials);
                enabled = new Dictionary<Renderer, bool>(sceneEnabled);
                scales = new Dictionary<Transform, Vector3>(sceneScale);
                constraints = new Dictionary<VRCScaleConstraint, bool>(sceneConstraints);
                var animatedParams = new Dictionary<string, float>();
                foreach (var (_, layer) in layers)
                {
                    if (!current.TryGetValue(layer, out var state) || state == null || state.motion == null) continue;
                    var parts = new List<(AnimationClip clip, float weight)>();
                    Contributions(state.motion, 1f, values, parts);
                    foreach (var (clip, w) in parts.Where(p => p.weight > .5f))
                        foreach (var binding in AnimationUtility.GetObjectReferenceCurveBindings(clip))
                        {
                            var target = AvatarAudit.Locate(avatar.transform, binding.path);
                            var r = target?.GetComponent(binding.type) as Renderer;
                            if (r == null || !binding.propertyName.StartsWith("m_Materials.Array.data[")) continue;
                            var slot = int.Parse(binding.propertyName.Split('[')[1].TrimEnd(']'));
                            var time = state.timeParameterActive ? Mathf.Clamp01(Get(values, state.timeParameter)) * clip.length : 0;
                            var keys = AnimationUtility.GetObjectReferenceCurve(clip, binding);
                            var key = keys.LastOrDefault(k => k.time <= time);
                            materials[(r, slot)] = key.value as Material;
                        }
                    var blended = new Dictionary<EditorCurveBinding, (float sum, float weight)>();
                    foreach (var (clip, w) in parts)
                        foreach (var binding in AnimationUtility.GetCurveBindings(clip))
                        {
                            var sampleTime = state.timeParameterActive && !string.IsNullOrEmpty(state.timeParameter)
                                ? Mathf.Clamp01(Get(values, state.timeParameter)) * clip.length : 0;
                            var v = AnimationUtility.GetEditorCurve(clip, binding).Evaluate(sampleTime);
                            blended.TryGetValue(binding, out var acc);
                            blended[binding] = (acc.sum + w * v, acc.weight + w);
                        }
                    foreach (var (binding, (sum, weight)) in blended)
                    {
                        if (binding.type == typeof(Animator)) { animatedParams[binding.propertyName] = sum + (1 - weight) * Get(values, binding.propertyName); continue; }
                        var target = binding.path.Length == 0 ? avatar.transform : avatar.transform.Find(binding.path);
                        if (target == null) continue;
                        if (binding.propertyName == "m_IsActive")
                        {
                            var before = active.TryGetValue(target, out var on) ? (on ? 1f : 0f) : 0f;
                            active[target] = sum + (1 - weight) * before > 0.5f;
                        }
                        else if (binding.propertyName == "m_Enabled" && target.GetComponent(binding.type) is Renderer renderer)
                            enabled[renderer] = sum + (1 - weight) * (enabled[renderer] ? 1 : 0) > .5f;
                        else if (binding.type == typeof(VRCScaleConstraint) && binding.propertyName == "IsActive" && target.TryGetComponent<VRCScaleConstraint>(out var constraint))
                            constraints[constraint] = sum + (1 - weight) * (constraints[constraint] ? 1 : 0) > .5f;
                        else if (binding.type == typeof(Transform) && binding.propertyName.StartsWith("m_LocalScale."))
                        {
                            var scale = scales[target]; var axis = binding.propertyName.EndsWith(".x") ? 0 : binding.propertyName.EndsWith(".y") ? 1 : 2;
                            scale[axis] = weight >= .99999f ? sum : sum + (1 - weight) * scale[axis]; scales[target] = scale;
                        }
                        else if (binding.type == typeof(SkinnedMeshRenderer) && binding.propertyName.StartsWith("blendShape.")
                                 && target.TryGetComponent<SkinnedMeshRenderer>(out var smr) && smr.sharedMesh != null)
                        {
                            var index = smr.sharedMesh.GetBlendShapeIndex(binding.propertyName.Substring("blendShape.".Length));
                            if (index < 0) continue;
                            var before = weights.TryGetValue((smr, index), out var b) ? b : 0f;
                            weights[(smr, index)] = sum + (1 - weight) * before;
                        }
                    }
                }
                var changed = animatedParams.Where(kv => Math.Abs(Get(values, kv.Key) - kv.Value) > 1e-4).ToList();
                if (changed.Count == 0) break;
                foreach (var (k, v) in changed) values[k] = v;
                foreach (var (_, layer) in layers) current[layer] = Follow(layer.stateMachine, current[layer], values);
            }
            lastValues = values;
            return new Snapshot(avatar, active, weights, materials, enabled, scales, constraints);
        }

        static float Get(Dictionary<string, float> values, string name) => values.TryGetValue(name, out var v) ? v : 0f;

        static void Contributions(Motion motion, float weight, Dictionary<string, float> values, List<(AnimationClip, float)> parts)
        {
            if (weight <= 1e-5 || motion == null) return;
            if (motion is AnimationClip clip) { parts.Add((clip, weight)); return; }
            if (!(motion is BlendTree tree) || tree.children.Length == 0) return;
            if (tree.blendType == BlendTreeType.Direct)
            {
                foreach (var child in tree.children) Contributions(child.motion, weight * Get(values, child.directBlendParameter), values, parts);
                return;
            }
            if (tree.blendType == BlendTreeType.Simple1D)
            {
                var children = tree.children.OrderBy(c => c.threshold).ToArray();
                var p = Get(values, tree.blendParameter);
                if (p <= children[0].threshold) { Contributions(children[0].motion, weight, values, parts); return; }
                if (p >= children[children.Length - 1].threshold) { Contributions(children[children.Length - 1].motion, weight, values, parts); return; }
                for (var i = 0; i < children.Length - 1; i++)
                {
                    var (a, b) = (children[i], children[i + 1]);
                    if (p < a.threshold || p > b.threshold) continue;
                    var t = b.threshold > a.threshold ? (p - a.threshold) / (b.threshold - a.threshold) : 0f;
                    Contributions(a.motion, weight * (1 - t), values, parts);
                    Contributions(b.motion, weight * t, values, parts);
                    return;
                }
            }
            Contributions(tree.children[0].motion, weight, values, parts);  // 2D 等：取第一个子动作（覆盖记录里写明）
        }

        /// <summary>Which resting states of the last evaluation write m_IsActive on the object or its ancestors (for notes).</summary>
        public List<string> Writers(string path)
        {
            var found = new List<string>();
            var target = AvatarAudit.Locate(avatar.transform, path);
            foreach (var (controller, layer) in layers)
            {
                if (!current.TryGetValue(layer, out var state) || state == null) continue;
                var parts = new List<(AnimationClip clip, float weight)>();
                Contributions(state.motion, 1f, lastValues, parts);
                foreach (var (clip, w) in parts)
                    foreach (var binding in AnimationUtility.GetCurveBindings(clip))
                    {
                        if (binding.propertyName != "m_IsActive") continue;
                        var t = binding.path.Length == 0 ? avatar.transform : avatar.transform.Find(binding.path);
                        if (t != null && target != null && target.IsChildOf(t))
                        {
                            var sampleTime = state.timeParameterActive && !string.IsNullOrEmpty(state.timeParameter)
                                ? Mathf.Clamp01(Get(lastValues, state.timeParameter)) * clip.length : 0;
                            found.Add($"{controller.name}/{layer.name}/{state.name}（权重 {w:0.##}）写 {binding.path}={AnimationUtility.GetEditorCurve(clip, binding).Evaluate(sampleTime)}");
                        }
                    }
            }
            if (found.Count == 0) found.Add("没有层写它（场景里就开着）");
            return found;
        }

        public void Restore()
        {
            foreach (var (t, on) in sceneActive) if (t != null) t.gameObject.SetActive(on);
            foreach (var (t, scale) in sceneScale) if (t != null) t.localScale = scale;
            foreach (var (c, value) in sceneConstraints) if (c != null) c.IsActive = value;
            foreach (var ((smr, i), w) in sceneWeights) if (smr != null) smr.SetBlendShapeWeight(i, w);
            foreach (var r in sceneMaterials.Keys.Select(k => k.Item1).Distinct())
                r.sharedMaterials = Enumerable.Range(0, r.sharedMaterials.Length).Select(i => sceneMaterials[(r, i)]).ToArray();
            foreach (var p in sceneEnabled) p.Key.enabled = p.Value;
        }

        public bool IsRestored()
        {
            return sceneActive.All(kv => kv.Key == null || kv.Key.gameObject.activeSelf == kv.Value)
                && sceneWeights.All(kv => kv.Key.Item1 == null || Math.Abs(kv.Key.Item1.GetBlendShapeWeight(kv.Key.Item2) - kv.Value) < 1e-3f)
                && sceneEnabled.All(kv => kv.Key == null || kv.Key.enabled == kv.Value);
        }

        public class Snapshot
        {
            readonly GameObject avatar;
            readonly Dictionary<Transform, bool> active;
            readonly Dictionary<(SkinnedMeshRenderer, int), float> weights;
            readonly Dictionary<(Renderer, int), Material> materials;
            readonly Dictionary<Renderer, bool> enabled;
            readonly Dictionary<Transform, Vector3> scales;
            readonly Dictionary<VRCScaleConstraint, bool> constraints;
            public Snapshot(GameObject avatar, Dictionary<Transform, bool> active, Dictionary<(SkinnedMeshRenderer, int), float> weights, Dictionary<(Renderer, int), Material> materials, Dictionary<Renderer, bool> enabled, Dictionary<Transform, Vector3> scales, Dictionary<VRCScaleConstraint,bool> constraints)
            { this.avatar = avatar; this.active = active; this.weights = weights; this.materials = materials; this.enabled = enabled; this.scales = scales; this.constraints = constraints; }
            public Vector3 Scale(Transform transform) => SourceShapeAudit.EffectiveScale(transform, scales.TryGetValue(transform, out var value) ? value : transform.localScale,
                c => constraints.TryGetValue(c,out var on) ? on : c.IsActive);
            public float? WeightAt(string path, string name)
            { var r = AvatarAudit.Locate(avatar.transform, path)?.GetComponent<SkinnedMeshRenderer>(); var i = r?.sharedMesh?.GetBlendShapeIndex(name) ?? -1; return i >= 0 ? (float?)Weight(r, i) : null; }
            public Material MaterialAt(string path, int slot)
            {
                var renderer = AvatarAudit.Locate(avatar.transform, path)?.GetComponent<Renderer>();
                return renderer != null && materials.TryGetValue((renderer, slot), out var m) ? m : null;
            }

            bool InHierarchy(Transform t)
            {
                for (var x = t; x != null; x = x.parent)
                    if (!(active.TryGetValue(x, out var on) ? on : x.gameObject.activeSelf) || x.gameObject.tag == "EditorOnly") return false;
                return true;
            }

            public bool Visible(string path)
            {
                var t = AvatarAudit.Locate(avatar.transform, path);
                return t != null && InHierarchy(t) && (t.GetComponent<Renderer>() == null || enabled[t.GetComponent<Renderer>()]);
            }

            public int VisibleRenderers => avatar.GetComponentsInChildren<Renderer>(true).Count(r => enabled[r] && InHierarchy(r.transform));

            public sealed class KeyFollowPair
            {
                public float Delta;
                public string Where;
                public SkinnedMeshRenderer Piece;
                public SkinnedMeshRenderer Body;
                public string Key;
            }

            public List<KeyFollowPair> KeyFollowPairsFor(string outfitPath, IEnumerable<string> allOutfitPaths = null)
            {
                var pairs = new List<KeyFollowPair>();
                var outfit = AvatarAudit.Locate(avatar.transform, outfitPath);
                var body = BodyFor(allOutfitPaths, outfitPath);
                if (outfit == null || body == null || body.sharedMesh == null) return pairs;
                foreach (var smr in outfit.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(s => s.sharedMesh != null && InHierarchy(s.transform)))
                    for (var i = 0; i < smr.sharedMesh.blendShapeCount; i++)
                    {
                        var name = smr.sharedMesh.GetBlendShapeName(i);
                        var j = body.sharedMesh.GetBlendShapeIndex(name);
                        if (j < 0) continue;
                        pairs.Add(new KeyFollowPair { Delta = Math.Abs(Weight(smr, i) - Weight(body, j)),
                            Where = $"{smr.name}.{name} 与 {body.name}", Piece = smr, Body = body, Key = name });
                    }
                return pairs;
            }

            public bool BodySelectionKnown(IEnumerable<string> allOutfitPaths) => BodyFor(allOutfitPaths, null) != null;

            SkinnedMeshRenderer BodyFor(IEnumerable<string> allOutfitPaths, string fallbackOutfitPath)
            {
                var paths = allOutfitPaths ?? (fallbackOutfitPath == null ? Enumerable.Empty<string>() : new[] { fallbackOutfitPath });
                var roots = paths.Select(path => AvatarAudit.Locate(avatar.transform, path)).Where(root => root != null).Distinct().ToList();
                var candidates = avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true)
                    .Where(s => s.sharedMesh != null && !roots.Any(root => s.transform.IsChildOf(root))).ToList();
                // The plan names the base body; hand that identity over so the pick survives both the
                // optimizer's name flattening and its absence, and so a base body split into several meshes
                // still resolves. Without the identity the callers keep the old name/weight criterion.
                return global::AvatarAudit.AuditPartInventory.FindBodyForRegression(avatar, candidates, BodyIdentity());
            }

            static List<string> bodyIdentity;

            /// <summary>The plan's body prefab (or the setup baseline) reduced to the base body's mesh names.</summary>
            static List<string> BodyIdentity()
            {
                if (bodyIdentity != null) return bodyIdentity;
                var planned = Avh.Plan().Str("body_prefab");
                if (string.IsNullOrEmpty(planned))
                {
                    var baseline = Avh.ReadJsonFile(Avh.Abs("_harness/setup/baseline.json"));
                    planned = baseline == null ? null : baseline.Str("body_prefab");
                }
                bodyIdentity = global::AvatarAudit.AuditPartInventory.BodyIdentity(planned) ?? new List<string>();
                return bodyIdentity;
            }

            public KeyFollowPair WorstKeyFollowPair(string outfitPath, IEnumerable<string> allOutfitPaths = null) =>
                KeyFollowPairsFor(outfitPath, allOutfitPaths).OrderByDescending(p => p.Delta).FirstOrDefault();

            /// <summary>Largest difference between an outfit mesh's blend shape and the body's shape of the same name.</summary>
            public (float delta, string where) KeyFollow(string outfitPath)
            {
                var best = WorstKeyFollowPair(outfitPath);
                return best == null ? (0, null) : (best.Delta, best.Where);
            }

            float Weight(SkinnedMeshRenderer smr, int i) => weights.TryGetValue((smr, i), out var w) ? w : smr.GetBlendShapeWeight(i);

            public bool SameAs(Snapshot other) =>
                active.All(kv => other.active.TryGetValue(kv.Key, out var v) && v == kv.Value)
                && scales.All(kv => other.scales.TryGetValue(kv.Key, out var v) && Enumerable.Range(0,3).All(i => kv.Value[i].Equals(v[i])))
                && constraints.All(kv => other.constraints.TryGetValue(kv.Key,out var v) && kv.Value == v)
                && weights.All(kv => other.weights.TryGetValue(kv.Key, out var w) && Math.Abs(w - kv.Value) < 1e-3)
                && materials.All(kv => other.materials.TryGetValue(kv.Key, out var m) && m == kv.Value)
                && enabled.All(kv => other.enabled.TryGetValue(kv.Key, out var e) && e == kv.Value);

            public void Apply(GameObject target)
            {
                foreach (var (t, on) in active) if (t != null) t.gameObject.SetActive(on);
                // NaN deletion must be posed by a native Animator (MenuGroupAudit.NativePose).
                foreach(var (t,scale) in scales) if(t!=null&&Enumerable.Range(0,3).All(i=>!float.IsNaN(scale[i])&&!float.IsInfinity(scale[i])))t.localScale=scale;
                foreach (var (c,value) in constraints) if(c!=null) c.IsActive=value;
                foreach (var ((smr, i), w) in weights) if (smr != null) smr.SetBlendShapeWeight(i, w);
                foreach (var r in materials.Keys.Select(k => k.Item1).Distinct())
                    r.sharedMaterials = Enumerable.Range(0, r.sharedMaterials.Length).Select(i => materials[(r, i)]).ToArray();
                foreach (var p in enabled) p.Key.enabled = p.Value;
            }
        }
    }
}
