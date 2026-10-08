// 【项目沉淀】通用工具（Harness package 阶段的冷导入复核）
// 适用素体：无关
// 工具链　：Unity 2022.3 批处理；NDMF；VRChat SDK3 Avatars
// 可复用性：★★★ 换个单子直接能用
// 用途　　：在「交付的工程 zip 原样解开」的冷副本（_harness_build/cold/project，没有 Library）里跑：
//           · delivery.cold_import：交付工程自己的程序集是否都编出来了、编译日志里的 error CS 条数（SOP 90 步骤 3）；
//           · avatar.observe：上传场景里选定进构建的头像根数；
//           · avatar.verify：编译态菜单断言——NDMF 处理后的菜单里有没有本单的控件，每个取值下点名的服装开着、别的关着。
//           本类随整套工具以独立程序集（asmdef）注入冷副本的 Assets/_HarnessColdProbe/，不混进交付工程自己的程序集，
//           交付 zip 里没有它。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;

namespace AVH.Harness
{
    public static class ColdImportStage
    {
        public const string ProbeDir = "Assets/_HarnessColdProbe";

        public static void Run() => Avh.Stage("cold-import", () =>
        {
            var notes = new List<string>();
            var (assemblies, missing) = ExpectedAssemblies();
            var logs = Directory.GetFiles(Avh.RunDir, "unity-*.log");
            var errors = logs.SelectMany(ReadLiveLog).Where(line => System.Text.RegularExpressions.Regex.IsMatch(line, @"error CS\d{4}")).ToList();
            if (missing.Count > 0) notes.Add("没编出来的程序集：" + string.Join(", ", missing.Take(10)));
            if (errors.Count > 0) notes.Add("编译错误：" + string.Join(" | ", errors.Take(5)));
            notes.Add($"交付工程应有的程序集 {assemblies} 个，缺 {missing.Count} 个");
            Avh.Observation("delivery.cold_import", new Dictionary<string, object>
            {
                ["cold_import_editor_dll_present"] = missing.Count == 0 && assemblies > 0,
                ["cold_import_cs_errors"] = logs.Length == 0 ? (int?)null : errors.Count,
            }, notes);

            var scene = EditorSceneManager.OpenScene(OptimizeStage.ScenePath, OpenSceneMode.Single);
            var roots = scene.GetRootGameObjects().Where(g => g.activeSelf && g.GetComponent<VRCAvatarDescriptor>() != null).ToList();
            Avh.Observation("avatar.observe", new Dictionary<string, object> { ["selected_build_roots"] = roots.Count },
                new List<string> { $"上传场景 {OptimizeStage.ScenePath} 的头像根：{string.Join(", ", roots.Select(r => r.name))}" });

            var verifyNotes = new List<string>();
            var failures = AvatarConfig.Grouped(Avh.Plan()) ? FullChainAssertions(verifyNotes) : AvatarAudit.OnBaked(OptimizeStage.AvatarPath, baked => MenuAssertions(baked, verifyNotes));
            var verification = new Dictionary<string, object> { ["delivery_menu_assertion_failures"] = failures };
            if (AvatarConfig.Grouped(Avh.Plan()))
            { verification["group_state_assertions"] = failures == 0; verification["shared_state_preserved"] = failures == 0; verification["menu_coverage_complete"] = failures == 0; }
            Avh.Observation("avatar.verify", verification, verifyNotes);

            // 脚本丢失只能按 Unity 加载的结果数（文本里的 GUID 查不到 .meta 不等于丢：SDK 会在加载时认旧版的 GUID）。
            // 交给 assets.validate 的观测合进 missing_scripts_and_broken_refs。
            var missingNotes = new List<string>();
            Avh.WriteJson(Path.Combine(Avh.RunDir, "cold_missing_scripts.json"), new Dictionary<string, object>
            {
                ["schema"] = "missing-scripts/0.1", ["missing_scripts"] = MissingScripts(OptimizeStage.AvatarPath, missingNotes),
                ["notes"] = missingNotes.Cast<object>().ToList(),
            });
        }, save: false);

        public static string[] ReadLiveLog(string path)
        {
            // Unity still owns its log while executeMethod runs on Windows.
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream)) return reader.ReadToEnd().Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        }

        /// <summary>
        /// The delivered project's own assemblies: one per asmdef under Assets/ and Packages/ (except this probe), plus
        /// Assembly-CSharp(-Editor) when loose scripts exist. Returns the count expected and the names with no DLL.
        /// </summary>
        public static (int, List<string>) ExpectedAssemblies()
        {
            var expected = new List<string>();
            foreach (var path in Directory.GetFiles("Assets", "*.asmdef", SearchOption.AllDirectories).Concat(Directory.GetFiles("Packages", "*.asmdef", SearchOption.AllDirectories)))
            {
                if (UnityIgnored(path)) continue;
                if (path.Replace('\\', '/').StartsWith(ProbeDir)) continue;
                var definition = Avh.ParseJson(File.ReadAllText(path)) as Dictionary<string, object>;
                var platforms = definition.List("includePlatforms").Select(x => x.ToString()).ToList();
                var excluded = definition.List("excludePlatforms").Select(x => x.ToString()).ToList();
                if ((platforms.Count > 0 && !platforms.Contains("Editor")) || excluded.Contains("Editor")) continue;
                if (definition.List("defineConstraints").Count > 0) continue;  // 条件编译的程序集按环境可有可无，不硬要求
                expected.Add(definition.Str("name"));
            }
            bool Loose(bool editor) => Directory.GetFiles("Assets", "*.cs", SearchOption.AllDirectories)
                .Select(p => p.Replace('\\', '/')).Where(p => !UnityIgnored(p) && !p.StartsWith(ProbeDir))
                .Any(p => p.Contains("/Editor/") == editor && !HasAsmdef(Path.GetDirectoryName(p)));
            if (Loose(false)) expected.Add("Assembly-CSharp");
            if (Loose(true)) expected.Add("Assembly-CSharp-Editor");
            var missing = expected.Where(name => !File.Exists(Path.Combine("Library", "ScriptAssemblies", name + ".dll"))).ToList();
            return (expected.Count, missing);
        }

        /// <summary>
        /// Whether Unity imports the path at all. A folder or file whose name ends with `~`, or starts with `.`, is
        /// skipped by the asset database, so nothing inside it is ever compiled: a package's `Samples~` and `source~`
        /// trees are the common case. Counting a definition that lives in one asks for a DLL that cannot exist, which
        /// would fail the delivered-project check on any project whose packages ship samples.
        /// </summary>
        public static bool UnityIgnored(string path)
        {
            foreach (var part in path.Replace('\\', '/').Split('/'))
                if (part.StartsWith(".") || part.EndsWith("~")) return true;
            return false;
        }

        static bool HasAsmdef(string directory)
        {
            for (var d = directory; !string.IsNullOrEmpty(d) && d != "Assets"; d = Path.GetDirectoryName(d))
                if (Directory.GetFiles(d, "*.asmdef").Length > 0 || Directory.GetFiles(d, "*.asmref").Length > 0) return true;
            return false;
        }

        /// <summary>
        /// Missing scripts as Unity sees them in the delivered avatar: components on its objects, state machine behaviours in
        /// every controller it merges (descriptor layers and MA Merge Animator, all sub-state machines), and menu assets.
        /// </summary>
        static int MissingScripts(string prefabPath, List<string> notes)
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath));
            try
            {
                var count = 0;
                foreach (var t in avatar.GetComponentsInChildren<Transform>(true))
                {
                    var n = GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(t.gameObject);
                    if (n == 0) continue;
                    count += n;
                    notes.Add($"组件脚本丢失：{Probe.HierarchyPath(avatar.transform, t)}（{n} 个）");
                }
                foreach (var (controller, _) in MaterialCurves.Controllers(avatar).Distinct())
                {
                    var missing = AllMachines(controller.layers.Select(l => l.stateMachine))
                        .SelectMany(m => m.behaviours.Concat(m.states.SelectMany(st => st.state.behaviours))).Count(b => b == null);
                    if (missing == 0) continue;
                    count += missing;
                    notes.Add($"状态机行为脚本丢失：{AssetDatabase.GetAssetPath(controller)}（{missing} 个）");
                }
                var descriptor = avatar.GetComponent<VRCAvatarDescriptor>();
                if (descriptor.customExpressions && (descriptor.expressionsMenu == null) != (descriptor.expressionParameters == null))
                { count++; notes.Add("表达菜单与参数只挂了一个"); }
                notes.Add($"查了 {avatar.GetComponentsInChildren<Transform>(true).Length} 个物体、{MaterialCurves.Controllers(avatar).Count()} 个控制器");
                return count;
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }

        static IEnumerable<UnityEditor.Animations.AnimatorStateMachine> AllMachines(IEnumerable<UnityEditor.Animations.AnimatorStateMachine> roots)
        {
            foreach (var machine in roots.Where(m => m != null))
            {
                yield return machine;
                foreach (var child in AllMachines(machine.stateMachines.Select(c => c.stateMachine))) yield return child;
            }
        }

        /// <summary>编译态菜单断言：期望来自菜单层记录（交付说明写的就是它），实际来自 NDMF 处理后的描述符与控制器。</summary>
        public static int MenuAssertions(GameObject baked, List<string> notes)
        {
            if (AvatarConfig.Grouped(Avh.Plan())) return MenuGroupAudit.Assertions(baked, notes, true);
            var menu = Avh.ReadJsonFile(Avh.Abs(MenuStage.RecordPath)) ?? throw new Exception("交付工程里没有菜单层记录");
            var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)) ?? throw new Exception("交付工程里没有服装层记录");
            var outfits = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
            var exclusive = outfits.Where(o => !OutfitStage.Fixed(o)).ToList();
            var defaultOutfit = exclusive.FirstOrDefault(o => Equals(o["default"], true));
            if (exclusive.Count > 0 && defaultOutfit == null) throw new Exception("exclusive 服装没有默认选项");
            var controls = menu.List("controls").Cast<Dictionary<string, object>>().ToList();
            var descriptor = baked.GetComponent<VRCAvatarDescriptor>();
            var menus = new List<VRCExpressionsMenu>();
            void Collect(VRCExpressionsMenu m)
            {
                if (m == null || menus.Contains(m)) return;
                menus.Add(m);
                foreach (var c in m.controls) if (c.type == VRCExpressionsMenu.Control.ControlType.SubMenu) Collect(c.subMenu);
            }
            Collect(descriptor.expressionsMenu);
            var failures = 0;
            foreach (var expected in controls)
            {
                var radial = expected.Str("control") == "RadialChoice";
                var found = menus.SelectMany(m => m.controls).Any(c => radial
                    ? c.name == expected.Str("menu_label") && c.type == VRCExpressionsMenu.Control.ControlType.RadialPuppet
                        && (c.subParameters ?? new VRCExpressionsMenu.Control.Parameter[0]).Any(p => p?.name == expected.Str("parameter"))
                    : c.name == expected.Str("label") && c.parameter != null && c.parameter.name == expected.Str("parameter")
                        && Math.Abs(c.value - Convert.ToSingle(expected["value"])) < 1e-3
                        && c.type == VRCExpressionsMenu.Control.ControlType.Toggle);
                if (!found) { failures++; notes.Add($"菜单里找不到设计控件「{(radial ? expected.Str("menu_label") : expected.Str("label"))}」"); }
            }
            var sim = new AnimatorSim(baked);
            var cells = new List<(Dictionary<string, float> values, string named)>();
            cells.Add((new Dictionary<string, float>(), defaultOutfit?.Str("object")));
            foreach (var control in controls.Where(c => c.Str("control") == "RadialChoice"))
            {
                var outfit = exclusive.FirstOrDefault(o => o.Str("label") == control.Str("label")) ?? defaultOutfit;
                cells.Add((new Dictionary<string, float> { [control.Str("parameter")] = Convert.ToSingle(control["value"]) }, outfit.Str("object")));
            }
            foreach (var (values, named) in cells)
            {
                var snapshot = sim.Evaluate(values);
                failures += OutfitMeasure.FixedFailures(baked, record, Avh.Plan(), notes, snapshot.Visible);
                var worn = outfits.Where(o => OutfitMeasure.Visible(o, snapshot.Visible)).Select(o => o.Str("object")).ToList();
                var expectedWorn = outfits.Where(OutfitStage.Fixed).Select(o => o.Str("object")).ToList();
                if (named != null) expectedWorn.Add(named);
                if (!worn.Except(expectedWorn).Any() && !expectedWorn.Except(worn).Any()) continue;
                failures++;
                notes.Add($"{(values.Count == 0 ? "默认" : string.Join(",", values.Select(kv => $"{kv.Key}={kv.Value}")))}：应只穿 {named}，实际 {string.Join(", ", worn)}");
            }
            // A menu toggle represents a semantic region, not one mesh. Prove every recorded constituent and every displaced
            // object changes together on the baked avatar, in the outfit cell where that region exists.
            foreach (var expected in controls.Where(c => c.Str("control") == "Toggle"))
            {
                foreach (var target in expected.List("targets").Cast<Dictionary<string, object>>())
                {
                    var outfit = outfits.FirstOrDefault(o => o.Str("id") == target.Str("outfit"));
                    if (outfit == null) { failures++; notes.Add($"部件区 {expected.Str("label")} 引用了未知衣装 {target.Str("outfit")}"); continue; }
                    var choice = controls.FirstOrDefault(c => c.Str("control") == "RadialChoice" && c.Str("label") == outfit.Str("label"));
                    var onValues = new Dictionary<string, float> { [expected.Str("parameter")] = 1 };
                    var offValues = new Dictionary<string, float> { [expected.Str("parameter")] = 0 };
                    if (choice != null)
                    {
                        onValues[choice.Str("parameter")] = Convert.ToSingle(choice["value"]);
                        offValues[choice.Str("parameter")] = Convert.ToSingle(choice["value"]);
                    }
                    var on = sim.Evaluate(onValues); var off = sim.Evaluate(offValues);
                    foreach (var path in target.List("members").Select(x => x.ToString()))
                        if (!on.Visible(path) || off.Visible(path)) { failures++; notes.Add($"部件区 {expected.Str("label")} 未完整联动组成物 {path}"); }
                    foreach (var path in target.List("displaced").Select(x => x.ToString()))
                        if (on.Visible(path) || !off.Visible(path)) { failures++; notes.Add($"部件区 {expected.Str("label")} 未正确让位/恢复 {path}"); }
                }
            }
            notes.Add($"断言 {controls.Count} 个控件、{cells.Count} 个取值");
            return failures;
        }
        static int FullChainAssertions(List<string> notes)
        {
            var request = Path.Combine(Avh.RunDir, "cold-build-request.json");
            var report = Path.Combine(Avh.RunDir, "cold-build-report.json");
            Avh.WriteJson(request, new Dictionary<string, object> { ["input"] = OptimizeStage.AvatarPath, ["output"] = "Assets/_HarnessColdProbe/Built",
                ["name"] = "Avatar", ["report"] = report, ["allowErrors"] = false });
            int code;
            SourceShapeAudit.CaptureSources(Avh.Plan(),Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)));
            try { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = MenuGroups.FinalizeReadableProperties; code = AvatarBuild.BuildArtifact.BuildOnce(request); }
            finally { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = null; }
            if (code != 0) throw new Exception("冷导入完整预处理链失败；见 cold-build-report.json");
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/_HarnessColdProbe/Built/Avatar.prefab") ?? throw new Exception("冷构建产物缺失");
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                var failures = MenuGroupAudit.Assertions(avatar, notes, true);
                var runtime = MenuGroupAudit.RuntimeAssertions(avatar, notes, out var steps);
                var metrics = MenuGroupAudit.Metrics(avatar, notes);
                Avh.WriteJson(Path.Combine(Avh.RunDir, "cold-group-coverage.json"), new Dictionary<string, object> {
                    ["schema"] = "cold-group-coverage/0.1", ["static_states"] = MenuGroupAudit.Cells(Avh.Plan()).Count,
                    ["static_failures"] = failures, ["runtime_events"] = steps, ["runtime_failures"] = runtime, ["metrics"] = metrics,
                    ["material_axes"] = MaterialAxes.Groups(Avh.Plan()).Select(g => (object)g.Str("id")).ToList() });
                return failures + runtime;
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }
    }
}
