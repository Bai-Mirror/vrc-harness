// 【项目沉淀】通用工具（Harness build_pre / build 阶段的 Unity 步骤）
// 适用素体：无关
// 工具链　：Unity 2022.3 批处理；复用 构建/BuildArtifact.cs 的完整预处理链（与 SDK 构建同序，不打 AssetBundle）
// 可复用性：★★★ 换个单子直接能用
// 用途　　：只在 _harness_build/<槽位>/project 这份隔离副本里跑（SDK 构建会顺手改贴图 .meta、lilToon 设置等）。
//           pre 槽构建菜单层（优化前），final 槽构建优化层；产物落在副本的 Assets/_BuildArtifacts/Avatar/。
//           构建后在产物预制体上测：avatar.build（构建是否成功、NDMF/构建期报错数）、menu.dump、avatar.observe、
//           avatar.verify（本单参数全组合的死锁格）。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace AVH.Harness
{
    public static class BuildStage
    {
        public const string OutDir = "Assets/_BuildArtifacts/Avatar";
        public const string BuiltPrefab = OutDir + "/Avatar.prefab";

        public static void Run() => Avh.Stage("build", () =>
        {
            var slot = Avh.Env("AVH_BUILD_SLOT", "final");
            var input = slot == "pre" ? MenuStage.AvatarPath : OptimizeStage.AvatarPath;
            var request = Path.Combine(Avh.RunDir, $"build-{slot}-request.json");
            var report = Path.Combine(Avh.RunDir, $"build-{slot}.json");
            Avh.WriteJson(request, new Dictionary<string, object>
            {
                ["input"] = input, ["output"] = OutDir, ["name"] = "Avatar", ["report"] = report, ["allowErrors"] = false,
            });
            int code;
            SourceShapeAudit.CaptureSources(Avh.Plan(),Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)));
            try
            {
                if (AvatarConfig.Grouped(Avh.Plan())) AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = MenuGroups.FinalizeReadableProperties;
                code = AvatarBuild.BuildArtifact.BuildOnce(request);
            }
            finally { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = null; }
            var manifest = Avh.ReadJsonFile(report) ?? new Dictionary<string, object>();
            var logs = manifest.Obj("logs");
            var ndmf = manifest.Obj("ndmf");
            var buildNotes = new List<string> { $"构建 {slot}：{manifest.Str("status")}，输入 {input}，报告 {report}" };
            var errors = logs != null && logs.TryGetValue("errors", out var e) ? Convert.ToInt32(e) : (int?)null;
            Avh.Observation("avatar.build", new Dictionary<string, object>
            {
                ["build_ok"] = code == 0,
                ["build_error_logs"] = errors,
                ["ndmf_error_logs"] = NdmfErrors(ndmf, logs, buildNotes),
            }, buildNotes);
            if (code != 0) throw new Exception($"构建失败（{manifest.Str("status")}：{manifest.Str("error")}），见 {report}");
            Verify(BuiltPrefab);
        });

        /// <summary>
        /// Errors logged while NDMF ran (the build chain's preprocess phase, where every NDMF plugin reports), plus one when
        /// NDMF itself said the build did not end successfully. Null when the manifest has neither.
        /// </summary>
        public static int? NdmfErrors(Dictionary<string, object> ndmf, Dictionary<string, object> logs, List<string> notes)
        {
            if (ndmf == null || logs == null) { notes.Add("构建清单里没有 NDMF 事件或日志统计"); return null; }
            var byPhase = logs.Obj("errorsByPhase") ?? new Dictionary<string, object>();
            var errors = byPhase.TryGetValue("preprocess", out var n) ? Convert.ToInt32(n) : 0;
            if (ndmf.TryGetValue("buildEndedSuccessful", out var ok) && Equals(ok, false)) errors++;
            notes.Add($"NDMF：{ndmf.Str("passCount")} 个 pass，结束状态 {ndmf.Str("buildEndedSuccessful")}，预处理阶段报错 {errors}");
            return errors;
        }

        public static void Verify(string builtPrefab)
        {
            var menu = Avh.ReadJsonFile(Avh.Abs(MenuStage.RecordPath)) ?? throw new Exception("缺少菜单层记录 menu.json");
            var outfitRecord = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
            SourceShapeAudit.CaptureSources(Avh.Plan(),outfitRecord);
            var inputs = DeadlockInputs(menu);
            var parameters = inputs.parameters;
            var domains = inputs.domains;
            var sources = inputs.sources;
            var baseline = Avh.ReadJsonFile(Avh.Abs("_harness/setup/baseline.json"));
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var built = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(builtPrefab)
                ?? throw new Exception($"构建产物不存在：{builtPrefab}"));
            try
            {
                var dumpNotes = new List<string>();
                Avh.Observation("menu.dump", AvatarAudit.MenuDump(built, parameters, sources, dumpNotes), dumpNotes);
                var observeNotes = new List<string>();
                var metrics = Measure.Observe(built, baseline, observeNotes);
                metrics["fixed_outfit_state_failures"] = OutfitMeasure.FixedFailures(built, outfitRecord, Avh.Plan(), observeNotes,
                    new AnimatorSim(built).Evaluate(new Dictionary<string, float>()).Visible);
                Avh.Observation("avatar.observe", metrics, observeNotes);
                var verifyNotes = new List<string>();
                Avh.Observation("avatar.verify", new Dictionary<string, object>
                {
                    ["deadlock_combinations"] = AvatarConfig.Grouped(Avh.Plan()) ? MenuGroupAudit.Assertions(built, verifyNotes, true) : AvatarAudit.Deadlocks(built, domains, sources, verifyNotes),
                }, verifyNotes);
                // 性能读数放在产物旁：performance 阶段拿 final 对 pre 比（pre 是优化前的基线）
                Avh.WriteJson(Avh.Abs(OutDir + "/perf.json"), Perf.Measure(built));
                AssetDatabase.ImportAsset(OutDir + "/perf.json");
            }
            finally { UnityEngine.Object.DestroyImmediate(built); }
        }

        /// <summary>
        /// The inputs the deadlock question is asked over, read straight from the menu record: this order's parameters
        /// with their value domains, and the source objects that occupy a position. Kept here so the audit is exercised
        /// with exactly what the stage passes, instead of a fixture re-deriving it.
        /// </summary>
        public static (List<string> parameters, Dictionary<string, float[]> domains, List<string> sources) DeadlockInputs(Dictionary<string, object> menu)
        {
            var parameters = menu.List("parameters").Select(x => x.ToString()).ToList();
            var controls = menu.List("controls").Cast<Dictionary<string, object>>().ToList();
            var domains = parameters.ToDictionary(p => p, p =>
            {
                var values = controls.Where(c => c.Str("parameter") == p).Select(c => Convert.ToSingle(c["value"])).ToList();
                return new[] { 0f }.Concat(values).Distinct().ToArray();
            });
            var sources = menu.List("conflicts").Cast<Dictionary<string, object>>().SelectMany(c => c.List("sources")).Select(x => x.ToString()).Distinct().ToList();
            return (parameters, domains, sources);
        }
    }
}
