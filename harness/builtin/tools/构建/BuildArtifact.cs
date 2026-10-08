/**
 * 【项目沉淀】通用工具
 * 适用素体：无关（任意 VRChat SDK3 头像；根由参数或「唯一的 VRCAvatarDescriptor」定位）
 * 相关素材：无
 * 工具链　：Unity 2022.3.22f1 / VRChat SDK 3.10.x；NDMF、VRCFury 经反射接入（没装也能编译）
 * 可复用性：★★★ 换个单子直接能用（部署到 <工程>/Assets/Editor/AvatarBuild/，只在隔离副本里跑 Build）
 * 用途　　：批处理构建入口：照 SDK 构建同一顺序跑完整预处理回调链，把处理后的头像存成可重载的预制体＋场景及全部持久依赖；Verify 另起批处理只读复核产物。
 */
// 为什么这样做（源码核验）：
//   SDK 自己的导出（VRCSDK3A-Editor.dll 的 VRCAvatarBuilder.ExportCurrentAvatarResource，ikdasm 反汇编）是：
//   Object.Instantiate(头像) → VRCBuildPipelineCallbacks.OnPreprocessAvatar(克隆) → 内容处理回调（层遮罩、校验）
//   → PrefabUtility.SaveAsPrefabAsset(克隆, "Assets/prefab-id-v1_….prefab") → BuildAssetBundles → OnPostprocessAvatar → 删该预制体。
//   打进包里的就是那个预制体。本工具走同一条链、不打包，把克隆连同生成资产持久化：
//   · NDMF（MA、AAO 等都是 NDMF 插件）：公开 API nadena.dev.ndmf.OverrideTemporaryDirectoryScope 把生成目录改进产物目录，
//     不落 Packages/nadena.dev.ndmf/__Generated（那里在 OnPostprocessAvatar／退出 Play 时整目录删）。
//   · VRCFury 等写进 Packages/com.vrcfury.temp/Builds 之类临时目录的：预处理后按依赖找出「本次新生成」或「位于已知临时根下」的资产，
//     AssetDatabase.MoveAsset 挪进产物目录（GUID 不变，引用不断）；VRCFury 下次构建会清 Builds/。
//   · 仍在内存里没落盘的对象：收进 rescued_unsaved.asset（正常为 0，数目写进清单）。
//   不打 AssetBundle：避开贴图 .meta 改写等打包副作用。VRCFury 在「不是真上传」时会抑制 lilToon VRChatModule 等回调，照原样保留并记进清单。
// 用法（一律经 开发工具/通用工具/unity_run.sh --batch；它的 --extra 不支持带空格的值，带空格时改用 -abRequest <json>）：
//   构建：-executeMethod AvatarBuild.BuildArtifact.Build -abInput Assets/…/X.prefab|X.unity [-abRoot <根名或层级路径>]
//         [-abOut Assets/_BuildArtifacts/<名>] [-abName <构建后根名>] [-abReport /abs/build.json] [-abAllowErrors]
//   复核：-executeMethod AvatarBuild.BuildArtifact.Verify -abOut <产物目录> [-abReport /abs/verify.json]
//   请求文件：-abRequest /abs/req.json，内容 {"input":"…","root":"…","output":"…","name":"…","report":"…","allowErrors":false}
// 产物目录：<名>.prefab（处理后的头像）、<名>_built.unity（只含该预制体实例）、ndmf/（NDMF 生成资产）、relocated/（挪来的临时资产）、
//          build_manifest.json（回调执行记录、NDMF pass、依赖统计、描述器摘要）、baseline_dangling_guids.txt（源头像依赖里本来就断的 GUID）、
//          baseline_missing_ref_targets.txt（源头像依赖里本来就加载不到的引用目标 guid:fileID；NDMF/VRCFury 的容器是二进制序列化，文本扫不到，Verify 按对象扫后与它比）。
// 退出码：0 成功；1 失败（原因见日志 [BuildArtifact] 行与清单 JSON）。
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;
using VRC.SDKBase.Editor.BuildPipeline;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

namespace AvatarBuild
{
    public static class BuildArtifact
    {
        // Harness can normalize proven plugin-derived bindings after the complete callback chain.
        // Standalone callers retain the existing preprocessing contract when no finalizer is installed.
        public static Action<GameObject> DerivedAvatarFinalizer;
        // Valid only while the callback is running. This directory was freshly prepared by this build,
        // and is the exact OverrideTemporaryDirectoryScope supplied to NDMF, never a caller's source root.
        public static string CurrentDerivedAssetRoot { get; private set; }
        const string Tag = "[BuildArtifact]";
        const string ToolId = "AvatarBuild.BuildArtifact";
        const string ToolVersion = "1.1";
        const string ManifestName = "build_manifest.json";
        const string BaselineName = "baseline_dangling_guids.txt";
        const string MissingBaselineName = "baseline_missing_ref_targets.txt";
        const string DefaultOutRoot = "Assets/_BuildArtifacts";
        // 已知会被插件清掉的临时根（依赖落在这里一律挪走；判据「产物依赖不在临时根下」也按它查）
        static readonly string[] KnownTempRoots = { "Packages/nadena.dev.ndmf/__Generated", "Packages/com.vrcfury.temp" };
        static readonly Regex GuidRx = new Regex(@"guid: ([0-9a-f]{32})", RegexOptions.Compiled);

        [Serializable]
        class Request
        {
            public string input, root, output, name, report;
            public bool allowErrors;
        }

        // ── 日志捕获（按阶段计错误数；判据「无报错」读这里）──────────────────────
        static string s_phase = "init";
        static int s_errors, s_exceptions, s_warnings;
        static readonly List<string> s_errorSamples = new List<string>();
        static readonly Dictionary<string, int> s_errorsByPhase = new Dictionary<string, int>();

        // 各插件自己打的入口/结果日志行（插件级签名，与头像无关），作为回调包装之外的旁证
        static readonly string[] EvidencePrefixes =
        {
            "VRCFury invoked on ", "VRCFury components not found", "VRCFury Finished", "VRCFury inhibited ",
            "OnPreprocessAvatar called", "Build Framework: Saved assets", "Skipping VF.",
        };
        static readonly List<string> s_evidence = new List<string>();

        static void Capture(string msg, string stack, LogType type)
        {
            if (msg != null && msg.StartsWith(Tag)) return;
            if (type == LogType.Log)
            {
                if (msg != null && s_evidence.Count < 60 && EvidencePrefixes.Any(msg.StartsWith))
                    s_evidence.Add($"[{s_phase}] {Trunc(msg, 200)}");
                return;
            }
            if (type == LogType.Warning) { s_warnings++; return; }
            if (type != LogType.Error && type != LogType.Exception && type != LogType.Assert) return;
            if (type == LogType.Exception) s_exceptions++; else s_errors++;
            s_errorsByPhase.TryGetValue(s_phase, out var n);
            s_errorsByPhase[s_phase] = n + 1;
            if (s_errorSamples.Count < 30)
                s_errorSamples.Add($"[{s_phase}] {type}: {Trunc(msg, 400)}");
        }

        static void Log(string msg) =>
            Debug.LogFormat(LogType.Log, LogOption.NoStacktrace, null, "{0}", Tag + " " + msg);

        // ════════════════════════════════════════════════════════════════════
        // 构建
        // ════════════════════════════════════════════════════════════════════
        static string s_outDir;

        public static void Build() => EditorApplication.Exit(BuildOnce(null));

        /// <summary>
        /// 同一条构建链，但不退出编辑器、返回退出码（0 成功）：Harness 的 build 阶段要在同一个批处理里接着测产物。
        /// requestFile 为空时照旧读命令行（-abRequest / -abInput …）。
        /// </summary>
        public static int BuildOnce(string requestFile)
        {
            var m = new Dictionary<string, object>
            {
                ["tool"] = ToolId,
                ["toolVersion"] = ToolVersion,
                ["status"] = "running",
                ["startedAt"] = Now(),
                ["unityVersion"] = Application.unityVersion,
                ["projectPath"] = Path.GetDirectoryName(Application.dataPath),
                ["batchMode"] = Application.isBatchMode,
            };
            string reportPath = null;
            int code = 1;
            var total = Stopwatch.StartNew();
            Application.logMessageReceived += Capture;
            try
            {
                var req = ReadRequest(requestFile);
                reportPath = req.report;
                bool errorsFree = BuildImpl(req, m);
                m["status"] = errorsFree ? "ok" : "fail_errors";
                code = errorsFree ? 0 : 1;
            }
            catch (Exception e)
            {
                m["status"] = "fail";
                m["error"] = e.GetType().Name + ": " + e.Message;
                Log("FAIL " + e);
            }
            finally
            {
                Application.logMessageReceived -= Capture;
            }
            m["logs"] = LogSummary();
            m["finishedAt"] = Now();
            m["elapsedSec"] = Math.Round(total.Elapsed.TotalSeconds, 1);
            var json = ToJson(m);
            try
            {
                if (s_outDir != null && Directory.Exists(s_outDir))
                {
                    File.WriteAllText(Path.Combine(s_outDir, ManifestName), json, new UTF8Encoding(false));
                    AssetDatabase.ImportAsset(s_outDir + "/" + ManifestName);
                }
                if (!string.IsNullOrEmpty(reportPath)) WriteExternal(reportPath, json);
            }
            catch (Exception e) { Log("写清单失败 " + e.Message); code = 1; }
            Log($"RESULT status={m["status"]} exit={code} out={s_outDir} elapsed={m["elapsedSec"]}s errors={s_errors} exceptions={s_exceptions}");
            return code;
        }

        static bool BuildImpl(Request req, Dictionary<string, object> m)
        {
            // ① 参数与输入
            s_phase = "setup";
            if (string.IsNullOrEmpty(req.input)) throw new ArgumentException("需要 -abInput <Assets/…/X.prefab|X.unity>");
            string input = Norm(req.input);
            string ext = Path.GetExtension(input).ToLowerInvariant();
            if (ext != ".prefab" && ext != ".unity") throw new ArgumentException("-abInput 只收 .prefab 或 .unity：" + input);
            if (AssetDatabase.LoadMainAssetAtPath(input) == null) throw new FileNotFoundException("输入资产不存在：" + input);
            m["input"] = input;
            m["rootSelector"] = req.root;
            m["packages"] = ReadEmbeddedPackages();

            // ② 打开输入，定位唯一头像根
            var buildScene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            GameObject holder = null;
            Scene sourceScene = default;
            VRCAvatarDescriptor[] found;
            if (ext == ".prefab")
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(input);
                holder = (GameObject)PrefabUtility.InstantiatePrefab(prefab, buildScene);
                found = holder.GetComponentsInChildren<VRCAvatarDescriptor>(true);
            }
            else
            {
                sourceScene = EditorSceneManager.OpenScene(input, OpenSceneMode.Additive);
                found = sourceScene.GetRootGameObjects().SelectMany(g => g.GetComponentsInChildren<VRCAvatarDescriptor>(true)).ToArray();
            }
            var all = found.Select(d => HierPath(d.transform)).ToArray();
            if (!string.IsNullOrEmpty(req.root))
                found = found.Where(d => d.gameObject.name == req.root || HierPath(d.transform) == req.root).ToArray();
            if (found.Length != 1)
                throw new Exception($"头像根不唯一或不存在：匹配 {found.Length} 个（输入里共有 {all.Length} 个 VRCAvatarDescriptor：{string.Join(" | ", all)}）；用 -abRoot <根名或层级路径> 指定");
            var src = found[0].gameObject;
            string builtName = string.IsNullOrEmpty(req.name) ? src.name : req.name;
            m["sourceRoot"] = new Dictionary<string, object>
            {
                ["name"] = src.name, ["path"] = HierPath(src.transform), ["activeSelf"] = src.activeSelf,
                ["hasPipelineManager"] = src.GetComponent("PipelineManager") != null,
                ["descriptor"] = DescribeDescriptor(found[0]),
            };
            Log($"input={input} root={HierPath(src.transform)} descriptors_in_input={all.Length}");

            // ③ 产物目录（只删本工具自己的旧产物）
            string outDir = Norm(string.IsNullOrEmpty(req.output) ? $"{DefaultOutRoot}/{Sanitize(builtName)}" : req.output);
            if (!outDir.StartsWith("Assets/") || outDir.Contains("..") || outDir.TrimEnd('/') == "Assets")
                throw new ArgumentException("-abOut 必须是 Assets/ 下的子目录：" + outDir);
            PrepareOutDir(outDir);
            s_outDir = outDir;
            File.WriteAllText(Path.Combine(outDir, ManifestName), ToJson(m), new UTF8Encoding(false)); // 占位：标记为本工具目录
            m["outDir"] = outDir;
            string ndmfDir = outDir + "/ndmf";

            // ④ 源头像基线（断链 GUID 本来就有多少；复核时只追究新增的）
            s_phase = "baseline";
            var srcDeps = AssetDatabase.GetDependencies(input, true);
            var baseline = DanglingGuids(srcDeps);
            File.WriteAllLines(Path.Combine(outDir, BaselineName), baseline.Keys.OrderBy(x => x), new UTF8Encoding(false));
            var bsw = Stopwatch.StartNew();
            var srcAssets = ScanReachable(new Object[] { src });
            var srcScan = ScanHierarchy(src, srcAssets.targets);
            File.WriteAllLines(Path.Combine(outDir, MissingBaselineName),
                new[] { "#reachableNullObjects=" + srcAssets.nullObjects }.Concat(srcAssets.targets.Keys.OrderBy(x => x)), new UTF8Encoding(false));
            m["baseline"] = new Dictionary<string, object>
            {
                ["dependencyCount"] = srcDeps.Length,
                ["danglingGuidCount"] = baseline.Count,
                ["missingScripts"] = srcScan.missingScripts,
                ["missingRefs"] = srcScan.missingRefs,
                ["assetFilesScanned"] = srcAssets.files,
                ["assetObjectsScanned"] = srcAssets.objects,
                ["missingRefTargets"] = srcAssets.targets.Count,
                ["reachableNullObjects"] = srcAssets.nullObjects,
                ["scanSec"] = Math.Round(bsw.Elapsed.TotalSeconds, 1),
            };
            Log($"baseline deps={srcDeps.Length} dangling_guids={baseline.Count} missing_ref_targets={srcAssets.targets.Count} null_objects={srcAssets.nullObjects} (files={srcAssets.files} objects={srcAssets.objects} {bsw.Elapsed.TotalSeconds:0.0}s) " +
                $"missing_scripts={srcScan.missingScripts} missing_refs={srcScan.missingRefs}");

            var before = new HashSet<string>(AssetDatabase.GetAllAssetPaths());

            // ⑤ 与 SDK 同序：BuildRequested → 克隆 → 预处理回调链
            s_phase = "build_requested";
            bool requested = VRCBuildPipelineCallbacks.OnVRCSDKBuildRequested(VRCSDKRequestedBuildType.Avatar);
            m["buildRequested"] = requested;
            Log("OnVRCSDKBuildRequested(Avatar) => " + requested);
            if (!requested) throw new Exception("OnVRCSDKBuildRequested 被回调阻断（见日志）");

            var clone = Object.Instantiate(src);
            clone.name = builtName;
            if (clone.transform.parent != null) clone.transform.SetParent(null, true);
            if (clone.scene != buildScene) SceneManager.MoveGameObjectToScene(clone, buildScene);
            if (!clone.activeSelf) { clone.SetActive(true); m["activatedRoot"] = true; }

            m["vrcfury"] = PrepareVrcfury(clone);
            var ndmf = new Dictionary<string, object> { ["assetRoot"] = ndmfDir };
            m["ndmf"] = ndmf;
            object applyOnBuild = GetStaticProp("nadena.dev.ndmf.config.Config", "ApplyOnBuild");
            ndmf["applyOnBuild"] = applyOnBuild;
            if (applyOnBuild is bool aob && !aob)
                throw new Exception("NDMF Config.ApplyOnBuild=false：完整构建必须启用（不替用户翻开关）");

            var records = new List<CallbackRecord>();
            var list = typeof(VRCBuildPipelineCallbacks)
                .GetField("_preprocessAvatarCallbacks", BindingFlags.NonPublic | BindingFlags.Static)
                ?.GetValue(null) as List<IVRCSDKPreprocessAvatarCallback>;
            if (list != null && list.Count == 0)
                throw new Exception("SDK 预处理回调表是空的：VRCBuildPipelineCallbacks.Initialize 在域加载时失败了（查日志里 Initialize 的异常；" +
                                    "常见是某个实现 IVRCSDKPreprocessAvatarCallback 的类没有无参构造）。不带回调跑下去等于没预处理");
            var originals = list?.ToList();
            string logging = "unavailable: 读不到 _preprocessAvatarCallbacks";
            if (originals != null)
            {
                // 计划表按 SDK 的稳定 OrderBy(callbackOrder) 排；包装件按原列表顺序放回，执行顺序不变
                var sorted = originals.OrderBy(c => c.callbackOrder).ToList();
                foreach (var cb in sorted)
                    records.Add(new CallbackRecord { order = cb.callbackOrder, type = cb.GetType().FullName, asm = cb.GetType().Assembly.GetName().Name });
                foreach (var r in records) Log($"callback planned order={r.order} {r.type} ({r.asm})");
                try
                {
                    var wrapped = originals.Select(cb => PreprocessProxy.Wrap(cb, records[sorted.FindIndex(x => ReferenceEquals(x, cb))])).ToList();
                    list.Clear();
                    list.AddRange(wrapped);
                    logging = "wrapped";
                }
                catch (Exception e)
                {
                    list.Clear(); list.AddRange(originals);
                    logging = "unavailable: " + e.GetType().Name + ": " + e.Message;
                    Log("回调包装失败，改为不包装直接跑（证据只剩 NDMF 事件与日志行）：" + e.Message);
                }
            }
            m["callbackLogging"] = logging;

            IDisposable ndmfScope = null;
            var scopeType = FindType("nadena.dev.ndmf.OverrideTemporaryDirectoryScope");
            if (scopeType != null) ndmfScope = (IDisposable)Activator.CreateInstance(scopeType, new object[] { ndmfDir });
            ndmf["scopeApplied"] = ndmfScope != null;

            s_phase = "preprocess";
            bool ok;
            var sw = Stopwatch.StartNew();
            try
            {
                ok = VRCBuildPipelineCallbacks.OnPreprocessAvatar(clone);
            }
            finally
            {
                ndmfScope?.Dispose();
                if (originals != null) { list.Clear(); list.AddRange(originals); }
            }
            m["preprocessResult"] = ok;
            m["preprocessSec"] = Math.Round(sw.Elapsed.TotalSeconds, 1);
            m["callbacks"] = records.Select(r => (object)r.ToDict()).ToList();
            Log($"OnPreprocessAvatar => {ok} in {sw.Elapsed.TotalSeconds:0.0}s; ran {records.Count(r => r.ran)}/{records.Count} callbacks");
            ReadNdmfEvents(ndmf);
            m["logEvidence"] = s_evidence.Cast<object>().ToList();
            if (!ok || clone == null) throw new Exception("预处理回调链报告失败（见日志 callback end … result=False / exception）");
            string check = CheckPreprocessEvidence(records, logging == "wrapped", ndmf, builtName);
            m["preprocessCheck"] = check;
            Log("preprocess check: " + check);
            if (check != "ok") throw new Exception("预处理证据不全：" + check);

            // ⑥ SDK 的内容处理回调里会改描述器的：人形头像 FX/Gesture 基础层遮罩取控制器第 0 层（同 SDK RegenerateAnimatorStateHashes）
            s_phase = "content_processed";
            m["sdkContentProcessed"] = ApplySdkLayerMasks(clone);

            // ⑦ 源头像撤出，只留处理后的克隆
            if (holder != null) Object.DestroyImmediate(holder);
            if (sourceScene.IsValid()) EditorSceneManager.CloseScene(sourceScene, true);

            // ⑧ 依赖归位：临时根/本次新生成的资产挪进产物目录，没落盘的对象救进容器
            s_phase = "persist";
            if (DerivedAvatarFinalizer != null)
            {
                m["derivedAvatarFinalizer"] = DerivedAvatarFinalizer.Method.DeclaringType.FullName + "." + DerivedAvatarFinalizer.Method.Name;
                try { CurrentDerivedAssetRoot = ndmfDir; DerivedAvatarFinalizer(clone); }
                finally { CurrentDerivedAssetRoot = null; }
            }
            m["persist"] = PersistDependencies(clone, outDir, before);

            // ⑨ 存预制体与场景（场景里只有这一个预制体实例）
            string baseName = Sanitize(builtName);
            string prefabPath = $"{outDir}/{baseName}.prefab";
            var saved = PrefabUtility.SaveAsPrefabAssetAndConnect(clone, prefabPath, InteractionMode.AutomatedAction, out bool prefabOk);
            if (!prefabOk || saved == null) throw new Exception("SaveAsPrefabAssetAndConnect 失败：" + prefabPath);
            string scenePath = $"{outDir}/{baseName}_built.unity";
            if (!EditorSceneManager.SaveScene(buildScene, scenePath)) throw new Exception("SaveScene 失败：" + scenePath);
            AssetDatabase.SaveAssets();
            m["prefab"] = prefabPath;
            m["scene"] = scenePath;
            m["builtRootName"] = clone.name;
            Log($"saved prefab={prefabPath} scene={scenePath}");

            // ⑩ 同 SDK：打包后调 OnPostprocessAvatar（NDMF 在此清它的默认临时根；我们的产物不在那里）
            s_phase = "postprocess";
            var post = new Dictionary<string, object>();
            try { VRCBuildPipelineCallbacks.OnPostprocessAvatar(); post["ran"] = true; }
            catch (Exception e) { post["ran"] = false; post["exception"] = e.Message; }
            AssetDatabase.Refresh();
            post["prefabStillExists"] = File.Exists(prefabPath);
            post["sceneStillExists"] = File.Exists(scenePath);
            m["postprocess"] = post;
            if (!File.Exists(prefabPath) || !File.Exists(scenePath)) throw new Exception("OnPostprocessAvatar 之后产物文件不见了");

            // ⑪ 自检摘要（复核以另起的 Verify 为准）
            s_phase = "summary";
            var deps = AssetDatabase.GetDependencies(scenePath, true);
            m["dependencies"] = ClassifyDeps(deps, outDir);
            var built = clone.GetComponent<VRCAvatarDescriptor>();
            m["descriptor"] = DescribeDescriptor(built);
            var scan = ScanHierarchy(clone);
            m["builtScan"] = new Dictionary<string, object> { ["missingScripts"] = scan.missingScripts, ["missingRefs"] = scan.missingRefs, ["samples"] = scan.samples };
            m["files"] = Directory.GetFiles(outDir, "*", SearchOption.AllDirectories)
                .Where(f => !f.EndsWith(".meta")).Select(f => Norm(f)).OrderBy(f => f).Cast<object>().ToList();

            int preErrors = s_errorsByPhase.TryGetValue("preprocess", out var pe) ? pe : 0;
            // 诊断阶段（基线扫描、收尾摘要）报的错来自厂商数据本身，记账不判失败；构建各阶段有一条错就判失败
            var diagnostic = new HashSet<string> { "baseline", "summary" };
            int buildErrors = s_errorsByPhase.Where(kv => !diagnostic.Contains(kv.Key)).Sum(kv => kv.Value);
            m["errorsDuringPreprocess"] = preErrors;
            m["errorsDuringBuildPhases"] = buildErrors;
            if (buildErrors > 0 && !req.allowErrors)
            {
                Log($"构建阶段有 {buildErrors} 条错误/异常（其中预处理 {preErrors}），按失败处理；确认无害可加 -abAllowErrors");
                return false;
            }
            return true;
        }

        // ── 回调包装：逐个记「跑没跑、结果、耗时、期间报错数」────────────────────
        // ⚠ 不能写成「实现 IVRCSDKPreprocessAvatarCallback 的具体类」：SDK 的 VRCBuildPipelineCallbacks.Initialize
        //   在域加载时扫描全部程序集，对每个具体实现 Activator.CreateInstance；没有无参构造就抛 MissingMethodException，
        //   整个注册中断、回调表为空，工程里所有构建都「0 个回调、秒过」（H-001b-3 第 1 轮实测踩到）。
        //   所以用 DispatchProxy 在运行时生成包装类型：域加载时它不存在，SDK 扫不到。
        internal sealed class CallbackRecord
        {
            public int order; public string type, asm, exception;
            public bool ran, result; public double ms; public int errorsDuring;
            public Dictionary<string, object> ToDict() => new Dictionary<string, object>
            {
                ["order"] = order, ["type"] = type, ["assembly"] = asm, ["ran"] = ran, ["result"] = result,
                ["ms"] = Math.Round(ms, 1), ["errorsDuring"] = errorsDuring, ["exception"] = exception,
            };
        }

        public class PreprocessProxy : DispatchProxy
        {
            internal IVRCSDKPreprocessAvatarCallback inner;
            internal CallbackRecord rec;

            internal static IVRCSDKPreprocessAvatarCallback Wrap(IVRCSDKPreprocessAvatarCallback inner, CallbackRecord rec)
            {
                var p = Create<IVRCSDKPreprocessAvatarCallback, PreprocessProxy>();
                var self = (PreprocessProxy)(object)p;
                self.inner = inner;
                self.rec = rec;
                return p;
            }

            protected override object Invoke(MethodInfo targetMethod, object[] args)
            {
                if (targetMethod.Name == nameof(IVRCSDKPreprocessAvatarCallback.OnPreprocessAvatar)) return Run((GameObject)args[0]);
                if (targetMethod.Name == "get_callbackOrder") return inner.callbackOrder;
                throw new NotSupportedException(targetMethod.Name);
            }

            bool Run(GameObject avatarGameObject)
            {
                var sw = Stopwatch.StartNew();
                int before = s_errors + s_exceptions;
                rec.ran = true;
                Log($"callback begin order={rec.order} {rec.type}");
                try
                {
                    rec.result = inner.OnPreprocessAvatar(avatarGameObject);
                    return rec.result;
                }
                catch (Exception e)
                {
                    rec.exception = e.GetType().Name + ": " + e.Message;
                    throw;
                }
                finally
                {
                    rec.ms = sw.Elapsed.TotalMilliseconds;
                    rec.errorsDuring = s_errors + s_exceptions - before;
                    Log($"callback end order={rec.order} {rec.type} result={rec.result} ms={rec.ms:0} errors={rec.errorsDuring}" +
                        (rec.exception != null ? " exception=" + rec.exception : ""));
                }
            }
        }

        // 已装框架的入口回调必须真跑过且返回 true（按类型名认，没装就不查）
        static readonly string[] RequiredHooks =
        {
            "nadena.dev.ndmf.VRChat.BuildFrameworkPreprocessHook",
            "nadena.dev.ndmf.VRChat.BuildFrameworkOptimizeHook",
            "VF.Hooks.VrcPreuploadHook",
        };

        static string CheckPreprocessEvidence(List<CallbackRecord> records, bool wrapped, Dictionary<string, object> ndmf, string rootName)
        {
            var problems = new List<string>();
            if (wrapped)
            {
                var bad = records.Where(r => !r.ran || !r.result).Select(r => r.type).ToList();
                if (bad.Count > 0) problems.Add("未执行或返回 false：" + string.Join(",", bad.Take(5)));
                foreach (var hook in RequiredHooks)
                    if (FindType(hook) != null && !records.Any(r => r.type == hook && r.ran && r.result))
                        problems.Add("已安装但没跑：" + hook);
            }
            if (FindType(RequiredHooks[0]) != null)
            {
                if (!(ndmf.TryGetValue("buildStartedRoot", out var n) && n as string == rootName)) problems.Add("NDMF 没有本次克隆的 BuildStarted 事件");
                if (!(ndmf.TryGetValue("buildEndedSuccessful", out var ok) && ok is bool b && b)) problems.Add("NDMF 没有成功的 BuildEnded 事件");
                if (!(ndmf.TryGetValue("passCount", out var pc) && pc is int i && i > 0)) problems.Add("NDMF 一个 pass 都没执行");
            }
            if (FindType(RequiredHooks[2]) != null && !s_evidence.Any(e => e.Contains("VRCFury invoked on " + rootName)))
                problems.Add("缺 VRCFury 入口日志「VRCFury invoked on " + rootName + "」");
            return problems.Count == 0 ? "ok" : string.Join("; ", problems);
        }

        // ── NDMF：读实际执行的 pass（BuildEvent 是 internal，反射读 LastBuildEvents）────
        static void ReadNdmfEvents(Dictionary<string, object> ndmf)
        {
            var t = FindType("nadena.dev.ndmf.reporting.BuildEvent");
            var evs = t?.GetProperty("LastBuildEvents", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(null) as IEnumerable;
            if (evs == null) { ndmf["events"] = "unavailable"; return; }
            var passes = new List<object>();
            var plugins = new Dictionary<string, object>();
            foreach (var ev in evs)
            {
                var et = ev.GetType();
                switch (et.Name)
                {
                    case "BuildStarted":
                        ndmf["buildStartedRoot"] = et.GetProperty("AvatarRootName")?.GetValue(ev);
                        break;
                    case "BuildEnded":
                        ndmf["buildEndedSuccessful"] = et.GetProperty("Successful")?.GetValue(ev);
                        ndmf["buildEndedMs"] = et.GetProperty("ElapsedTimeMS")?.GetValue(ev);
                        break;
                    case "PassExecuted":
                        var qn = et.GetProperty("QualifiedName")?.GetValue(ev) as string ?? "?";
                        var ms = et.GetProperty("PassExecutionTime")?.GetValue(ev);
                        passes.Add(qn);
                        string plugin = PluginOf(qn);
                        plugins[plugin] = (plugins.TryGetValue(plugin, out var c) ? (int)c : 0) + 1;
                        Log($"ndmf pass {qn} ms={Convert.ToDouble(ms, CultureInfo.InvariantCulture):0.0}");
                        break;
                }
            }
            ndmf["passCount"] = passes.Count;
            ndmf["passesByPlugin"] = plugins;
            ndmf["passes"] = passes;
            foreach (var kv in plugins) Log($"ndmf plugin {kv.Key} passes={kv.Value}");
        }

        static string PluginOf(string qualifiedName)
        {
            // QualifiedName 形如 "<插件命名空间>.<Pass 类型名>"；按已知插件前缀归类，认不出的取倒数第二段之前
            string[] known = { "nadena.dev.modular_avatar", "nadena.dev.modular-avatar", "com.anatawa12.avatar_optimizer", "com.anatawa12.avatar-optimizer", "Anatawa12.AvatarOptimizer", "nadena.dev.ndmf", "VF.", "lilToon", "jp.lilxyzw" };
            foreach (var k in known)
                if (qualifiedName.StartsWith(k, StringComparison.OrdinalIgnoreCase)) return k.TrimEnd('.');
            int i = qualifiedName.LastIndexOf('.');
            return i > 0 ? qualifiedName.Substring(0, i) : qualifiedName;
        }

        // ── VRCFury：需要 Packages/com.vrcfury.temp 才能存生成资产；VRCFury 自己在编辑器 5 秒后才建，批处理等不到 ──
        static Dictionary<string, object> PrepareVrcfury(GameObject clone)
        {
            var r = new Dictionary<string, object>();
            var tmpType = FindType("VF.TmpFilePackage");
            var compType = FindType("VF.Component.VRCFuryComponent");
            r["installed"] = tmpType != null;
            if (tmpType == null) return r;
            int comps = compType == null ? -1 : clone.GetComponentsInChildren(compType, true).Length;
            r["components"] = comps;
            const string tmpDir = "Packages/com.vrcfury.temp";
            if (AssetDatabase.IsValidFolder(tmpDir)) { r["tempPackage"] = "present"; return r; }
            try
            {
                tmpType.GetMethod("InitIfMissing", BindingFlags.Static | BindingFlags.NonPublic)?.Invoke(null, null);
                UnityEditor.PackageManager.Client.Resolve();
                AssetDatabase.Refresh();
            }
            catch (Exception e) { r["initError"] = e.Message; }
            bool valid = AssetDatabase.IsValidFolder(tmpDir);
            r["tempPackage"] = valid ? "created" : (Directory.Exists(tmpDir) ? "created_not_registered" : "missing");
            Log($"vrcfury components={comps} tempPackage={r["tempPackage"]}");
            // 实测（H-001b-3 第 2 轮）：头像没有 VRCFury 组件时，VRCFury 的 ParameterCompressorHook 照样经 SaveAssetsSession 写临时包，
            // 包没注册就抛「VRCFury Temp Files package has not been created yet」、回调返回 false。所以只要装了 VRCFury 就必须先有包。
            if (!valid)
                throw new Exception("VRCFury 临时包 Packages/com.vrcfury.temp 还没被 Unity 注册（VRCFury 自己要等编辑器空转 5 秒才建，批处理等不到；" +
                                    "它的 ParameterCompressorHook 对任何头像都要写这里）。本次已建目录，同一命令再跑一次即可；build_artifact.sh 会在起 Unity 前预建");
            return r;
        }

        // ── SDK 内容处理：层遮罩（调 SDK 自己的 internal 方法，同 VRCSdkControlPanelAvatarBuilder 的做法）──
        static Dictionary<string, object> ApplySdkLayerMasks(GameObject clone)
        {
            var r = new Dictionary<string, object>();
            var desc = clone.GetComponent<VRCAvatarDescriptor>();
            var animator = clone.GetComponent<Animator>();
            if (desc == null || animator == null || !animator.isHuman) { r["layerMasks"] = "skipped: 非人形或无 Animator（SDK 同样跳过）"; return r; }
            var mi = FindType("AvatarDescriptorEditor3")?.GetMethod("SetLayerMaskFromController", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
            if (mi == null) { r["layerMasks"] = "skipped: SDK 方法 AvatarDescriptorEditor3.SetLayerMaskFromController 不存在"; return r; }
            var so = new SerializedObject(desc);
            var layers = so.FindProperty("baseAnimationLayers");
            int applied = 0;
            for (int i = 0; i < layers.arraySize; i++)
            {
                var layer = layers.GetArrayElementAtIndex(i);
                var type = (VRCAvatarDescriptor.AnimLayerType)layer.FindPropertyRelative("type").enumValueIndex;
                if (type != VRCAvatarDescriptor.AnimLayerType.FX && type != VRCAvatarDescriptor.AnimLayerType.Gesture) continue;
                mi.Invoke(null, new object[] { layer });
                applied++;
            }
            so.ApplyModifiedPropertiesWithoutUndo();
            r["layerMasks"] = $"applied to {applied} layer(s)";
            r["validation"] = "skipped: SDK 校验是异步且挂在控制面板上，只报告不改头像";
            return r;
        }

        // ── 依赖归位 ─────────────────────────────────────────────────────────
        static Dictionary<string, object> PersistDependencies(GameObject clone, string outDir, HashSet<string> before)
        {
            var own = new HashSet<Object>();
            foreach (var t in clone.GetComponentsInChildren<Transform>(true))
            {
                own.Add(t.gameObject);
                foreach (var c in t.gameObject.GetComponents<Component>()) if (c != null) own.Add(c);
            }
            var toMove = new SortedSet<string>(StringComparer.Ordinal);
            var unsaved = new List<Object>();
            var dontSave = new List<string>();
            var external = new List<string>();
            int inArtifact = 0, preexisting = 0;
            foreach (var o in EditorUtility.CollectDependencies(new Object[] { clone }))
            {
                if (o == null || own.Contains(o)) continue;
                if (AssetDatabase.Contains(o))
                {
                    string p = AssetDatabase.GetAssetPath(o);
                    if (p.StartsWith(outDir + "/")) { inArtifact++; continue; }
                    bool temp = KnownTempRoots.Any(r => p.StartsWith(r + "/"));
                    bool fresh = !before.Contains(p) && (p.StartsWith("Assets/") || p.StartsWith("Packages/"));
                    if (temp || fresh) toMove.Add(p); else preexisting++;
                    continue;
                }
                if (o is GameObject || o is Component) { external.Add(o.name + " (" + o.GetType().Name + ")"); continue; }
                if ((o.hideFlags & HideFlags.DontSave) != 0) { dontSave.Add(o.name + " (" + o.GetType().Name + ")"); continue; }
                unsaved.Add(o);
            }
            var moved = new List<object>();
            foreach (var p in toMove)
            {
                string rel = p.StartsWith("Packages/") ? "pkg/" + p.Substring("Packages/".Length) : "assets/" + p.Substring("Assets/".Length);
                string dst = $"{outDir}/relocated/{rel}";
                EnsureFolder(Path.GetDirectoryName(dst).Replace('\\', '/'));
                string err = AssetDatabase.MoveAsset(p, dst);
                if (!string.IsNullOrEmpty(err)) throw new Exception($"挪资产失败 {p} → {dst}：{err}");
                moved.Add(p + " -> " + dst);
                Log($"relocated {p} -> {dst}");
            }
            int rescued = 0;
            if (unsaved.Count > 0)
            {
                var main = unsaved[0];
                AssetDatabase.CreateAsset(main, $"{outDir}/rescued_unsaved.asset");
                foreach (var o in unsaved.Skip(1)) AssetDatabase.AddObjectToAsset(o, main);
                rescued = unsaved.Count;
                foreach (var o in unsaved) Log($"rescued unsaved {o.GetType().Name} '{o.name}'");
            }
            AssetDatabase.SaveAssets();
            if (external.Count > 0) Log("警告：头像引用了头像以外的场景对象（保存后会断）：" + string.Join(", ", external.Take(10)));
            if (dontSave.Count > 0) Log("警告：头像引用了 DontSave 对象（存不下来）：" + string.Join(", ", dontSave.Take(10)));
            return new Dictionary<string, object>
            {
                ["inArtifactBeforeMove"] = inArtifact, ["preexisting"] = preexisting,
                ["relocatedCount"] = moved.Count, ["relocated"] = moved,
                ["rescuedUnsaved"] = rescued, ["dontSaveRefs"] = dontSave.Cast<object>().ToList(),
                ["externalSceneRefs"] = external.Cast<object>().ToList(),
            };
        }

        static Dictionary<string, object> ClassifyDeps(string[] deps, string outDir)
        {
            int art = 0, assets = 0, pkgs = 0, other = 0, temp = 0, missing = 0;
            foreach (var p in deps)
            {
                if (p.StartsWith(outDir + "/")) art++;
                else if (p.StartsWith("Assets/")) assets++;
                else if (p.StartsWith("Packages/")) pkgs++;
                else other++;
                if (KnownTempRoots.Any(r => p.StartsWith(r + "/"))) temp++;
                if ((p.StartsWith("Assets/") || p.StartsWith("Packages/")) && string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(p))) missing++;
            }
            return new Dictionary<string, object>
            {
                ["total"] = deps.Length, ["inArtifact"] = art, ["otherAssets"] = assets, ["packages"] = pkgs,
                ["other"] = other, ["underTempRoots"] = temp, ["unresolvedPaths"] = missing,
            };
        }

        // ════════════════════════════════════════════════════════════════════
        // 复核（只读：打开产物场景，不保存任何东西）
        // ════════════════════════════════════════════════════════════════════
        public static void Verify()
        {
            var r = new Dictionary<string, object> { ["tool"] = ToolId + ".Verify", ["toolVersion"] = ToolVersion, ["startedAt"] = Now() };
            string reportPath = null;
            int code = 1;
            Application.logMessageReceived += Capture;
            s_phase = "verify";
            try
            {
                var req = ReadRequest();
                reportPath = req.report;
                code = VerifyImpl(req, r) ? 0 : 1;
            }
            catch (Exception e)
            {
                r["error"] = e.GetType().Name + ": " + e.Message;
                Log("VERIFY FAIL " + e);
            }
            finally
            {
                Application.logMessageReceived -= Capture;
            }
            r["logs"] = LogSummary();
            r["finishedAt"] = Now();
            r["pass"] = code == 0;
            var json = ToJson(r);
            if (!string.IsNullOrEmpty(reportPath)) { try { WriteExternal(reportPath, json); } catch (Exception e) { Log("写复核报告失败 " + e.Message); code = 1; } }
            Log($"VERIFY RESULT pass={code == 0} exit={code}");
            EditorApplication.Exit(code);
        }

        static bool VerifyImpl(Request req, Dictionary<string, object> r)
        {
            if (string.IsNullOrEmpty(req.output)) throw new ArgumentException("需要 -abOut <产物目录>");
            string outDir = Norm(req.output).TrimEnd('/');
            if (!Directory.Exists(outDir)) throw new DirectoryNotFoundException("产物目录不存在：" + outDir);
            var scenes = Directory.GetFiles(outDir, "*.unity", SearchOption.TopDirectoryOnly);
            if (scenes.Length != 1) throw new Exception($"产物目录顶层应恰有 1 个场景，实有 {scenes.Length}");
            string scenePath = outDir + "/" + Path.GetFileName(scenes[0]);
            string manifest = File.Exists(Path.Combine(outDir, ManifestName)) ? File.ReadAllText(Path.Combine(outDir, ManifestName)) : "";
            var st = Regex.Match(manifest, "\"status\": \"([^\"]*)\"");
            r["outDir"] = outDir;
            r["scene"] = scenePath;
            r["buildStatus"] = st.Success ? st.Groups[1].Value : null;

            var scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
            var roots = scene.GetRootGameObjects();
            var descs = roots.SelectMany(g => g.GetComponentsInChildren<VRCAvatarDescriptor>(true)).ToArray();
            r["rootObjects"] = roots.Select(g => (object)g.name).ToList();
            r["avatarDescriptorCount"] = descs.Length;
            int ms = 0, mr = 0;
            var samples = new List<object>();
            var sceneTargets = new Dictionary<string, List<string>>();
            foreach (var g in roots)
            {
                var s = ScanHierarchy(g, sceneTargets);
                ms += s.missingScripts; mr += s.missingRefs;
                samples.AddRange(s.samples);
            }
            r["missingScripts"] = ms;
            r["missingRefs"] = mr;
            r["missingRefSamples"] = samples.Take(20).ToList();
            Log($"verify scene={scenePath} roots={roots.Length} descriptors={descs.Length} missing_scripts={ms} missing_refs={mr}");

            var checks = new Dictionary<string, object>();
            checks["buildStatusOk"] = (string)r["buildStatus"] == "ok";
            checks["buildPreprocessChecked"] = manifest.Contains("\"preprocessCheck\": \"ok\"");
            checks["missingScriptsZero"] = ms == 0;
            checks["missingRefsZero"] = mr == 0;
            checks["avatarRootUnique"] = descs.Length == 1;
            if (descs.Length == 1)
            {
                var d = descs[0];
                var info = DescribeDescriptor(d);
                r["descriptor"] = info;
                checks["rootActive"] = d.gameObject.activeInHierarchy;
                checks["rootIsSceneRoot"] = d.transform.parent == null;
                checks["menuResolvable"] = d.expressionsMenu != null && AssetDatabase.Contains(d.expressionsMenu);
                checks["parametersResolvable"] = d.expressionParameters != null && AssetDatabase.Contains(d.expressionParameters);
                checks["submenusResolvable"] = info.TryGetValue("menuSubmenuNull", out var sn) && (int)sn == 0;
                checks["playableLayersResolvable"] = info.TryGetValue("playableLayersUnresolved", out var pu) && (int)pu == 0;
                Log($"verify root={d.gameObject.name} menu={info["expressionsMenu"]} params={info["expressionParameters"]} parameterCount={info.Get("parameterCount")} cost={info.Get("parameterCost")} menus={info["menuCount"]} controls={info["menuControlCount"]}");
            }

            var deps = AssetDatabase.GetDependencies(scenePath, true);
            var cls = ClassifyDeps(deps, outDir);
            r["dependencies"] = cls;
            checks["noDepsUnderTempRoots"] = (int)cls["underTempRoots"] == 0;
            checks["allDepPathsResolve"] = (int)cls["unresolvedPaths"] == 0;
            var dangling = DanglingGuids(deps);
            string basePath = Path.Combine(outDir, BaselineName);
            var baseline = File.Exists(basePath) ? new HashSet<string>(File.ReadAllLines(basePath).Where(l => l.Length == 32)) : null;
            var introduced = dangling.Keys.Where(g => baseline == null || !baseline.Contains(g)).OrderBy(g => g).ToList();
            r["danglingGuids"] = new Dictionary<string, object>
            {
                ["total"] = dangling.Count,
                ["inheritedFromSource"] = dangling.Count - introduced.Count,
                ["introduced"] = introduced.Count,
                ["introducedSamples"] = introduced.Take(20).Select(g => (object)(g + " <- " + string.Join(",", dangling[g].Take(3)))).ToList(),
                ["baselineAvailable"] = baseline != null,
            };
            checks["noIntroducedDanglingGuids"] = baseline != null && introduced.Count == 0;

            // 二进制容器（NDMF/VRCFury 生成的菜单、控制器、参数）文本扫不到，按「够得着的对象」扫加载不到的引用目标，与源头像基线比
            var asw = Stopwatch.StartNew();
            var art = ScanReachable(roots.Cast<Object>().ToArray());
            foreach (var kv in sceneTargets) if (!art.targets.ContainsKey(kv.Key)) art.targets[kv.Key] = kv.Value;
            string mbPath = Path.Combine(outDir, MissingBaselineName);
            var mlines = File.Exists(mbPath) ? File.ReadAllLines(mbPath) : null;
            var mbase = mlines != null ? new HashSet<string>(mlines.Where(l => !l.StartsWith("#") && l.Contains(":"))) : null;
            int baseNulls = mlines != null && mlines.Length > 0 && mlines[0].StartsWith("#reachableNullObjects=") ? int.Parse(mlines[0].Substring(22)) : 0;
            var newTargets = art.targets.Keys.Where(k => mbase == null || !mbase.Contains(k)).OrderBy(k => k).ToList();
            r["missingRefTargets"] = new Dictionary<string, object>
            {
                ["assetFilesScanned"] = art.files, ["assetObjectsScanned"] = art.objects,
                ["total"] = art.targets.Count, ["inheritedFromSource"] = art.targets.Count - newTargets.Count, ["introduced"] = newTargets.Count,
                ["introducedSamples"] = newTargets.Take(20).Select(k => (object)(k + " <- " + string.Join(" | ", art.targets[k]))).ToList(),
                ["inheritedSamples"] = art.targets.Keys.Where(k => !newTargets.Contains(k)).Take(10).Select(k => (object)(k + " <- " + string.Join(" | ", art.targets[k]))).ToList(),
                ["reachableNullObjects"] = art.nullObjects, ["baselineReachableNullObjects"] = baseNulls,
                ["baselineAvailable"] = mbase != null,
                ["scanSec"] = Math.Round(asw.Elapsed.TotalSeconds, 1),
            };
            checks["noIntroducedMissingRefTargets"] = mbase != null && newTargets.Count == 0;
            checks["noIntroducedNullObjects"] = art.nullObjects <= baseNulls;
            Log($"verify reachable scan files={art.files} objects={art.objects} missing_ref_targets={art.targets.Count} introduced={newTargets.Count} null_objects={art.nullObjects} (baseline {baseNulls}) {asw.Elapsed.TotalSeconds:0.0}s");
            Log($"verify deps={deps.Length} under_temp_roots={cls["underTempRoots"]} dangling_total={dangling.Count} introduced={introduced.Count}");
            r["checks"] = checks;
            foreach (var kv in checks) Log($"verify check {kv.Key}={kv.Value}");
            return checks.Values.All(v => v is bool b && b);
        }

        // ════════════════════════════════════════════════════════════════════
        // 共用
        // ════════════════════════════════════════════════════════════════════
        static Dictionary<string, object> DescribeDescriptor(VRCAvatarDescriptor d)
        {
            var r = new Dictionary<string, object>();
            r["root"] = d.gameObject.name;
            r["customExpressions"] = d.customExpressions;
            var menu = d.expressionsMenu;
            var prm = d.expressionParameters;
            r["expressionsMenu"] = menu != null ? AssetDatabase.GetAssetPath(menu) : null;
            r["expressionParameters"] = prm != null ? AssetDatabase.GetAssetPath(prm) : null;
            var names = new HashSet<string>();
            if (prm != null && prm.parameters != null)
            {
                var ps = prm.parameters.Where(p => p != null && !string.IsNullOrEmpty(p.name)).ToArray();
                foreach (var p in ps) names.Add(p.name);
                r["parameterCount"] = ps.Length;
                r["parameterSlots"] = prm.parameters.Length;
                r["syncedParameterCount"] = ps.Count(p => p.networkSynced);
                r["parameterCost"] = prm.CalcTotalCost();
                r["parameters"] = ps.Select(p => (object)$"{p.name}:{p.valueType}{(p.networkSynced ? "" : ":local")}{(p.saved ? ":saved" : "")}").ToList();
            }
            int menus = 0, controls = 0, subNull = 0, paramMissing = 0;
            var seen = new HashSet<VRCExpressionsMenu>();
            void Walk(VRCExpressionsMenu mnu)
            {
                if (mnu == null || !seen.Add(mnu)) return;
                menus++;
                foreach (var c in mnu.controls ?? new List<VRCExpressionsMenu.Control>())
                {
                    controls++;
                    if (c.parameter != null && !string.IsNullOrEmpty(c.parameter.name) && !names.Contains(c.parameter.name)) paramMissing++;
                    if (c.type == VRCExpressionsMenu.Control.ControlType.SubMenu)
                    {
                        if (c.subMenu == null) subNull++; else Walk(c.subMenu);
                    }
                }
            }
            Walk(menu);
            r["menuCount"] = menus;
            r["menuControlCount"] = controls;
            r["menuSubmenuNull"] = subNull;
            r["menuParamsNotInParameters"] = paramMissing;
            var layers = new List<object>();
            int unresolved = 0;
            void AddLayers(VRCAvatarDescriptor.CustomAnimLayer[] arr, string kind)
            {
                if (arr == null) return;
                foreach (var l in arr)
                {
                    var ctl = l.animatorController as AnimatorController;
                    if (!l.isDefault && l.animatorController == null) unresolved++;
                    layers.Add(new Dictionary<string, object>
                    {
                        ["kind"] = kind, ["type"] = l.type.ToString(), ["isDefault"] = l.isDefault, ["isEnabled"] = l.isEnabled,
                        ["controller"] = l.animatorController != null ? AssetDatabase.GetAssetPath(l.animatorController) : null,
                        ["controllerLayers"] = ctl != null ? ctl.layers.Length : (object)null,
                        ["controllerParameters"] = ctl != null ? ctl.parameters.Length : (object)null,
                        ["mask"] = l.mask != null ? l.mask.name : null,
                    });
                }
            }
            AddLayers(d.baseAnimationLayers, "base");
            AddLayers(d.specialAnimationLayers, "special");
            r["playableLayers"] = layers;
            r["playableLayersUnresolved"] = unresolved;
            return r;
        }

        static (int missingScripts, int missingRefs, List<object> samples) ScanHierarchy(GameObject root, Dictionary<string, List<string>> targets = null)
        {
            int ms = 0, mr = 0;
            var samples = new List<object>();
            targets = targets ?? new Dictionary<string, List<string>>();
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
            {
                ms += GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(t.gameObject);
                foreach (var c in t.gameObject.GetComponents<Component>())
                {
                    if (c == null) continue;
                    int n = ScanObject(c, HierPath(t), targets);
                    if (n > 0 && samples.Count < 20) samples.Add($"{HierPath(t)}:{c.GetType().Name} ×{n}");
                    mr += n;
                }
            }
            return (ms, mr, samples);
        }

        // 引用了、但加载不到的目标（Unity 检视器里显示 Missing 的那种）→ 记成 guid:fileID。与序列化格式无关（二进制容器也能查）。
        // 纯数值大数组（关键帧、顶点、采样）里不可能有对象引用，不进去，省时间。
        static readonly HashSet<string> PlainArrayTypes = new HashSet<string>
        {
            "float", "int", "unsigned int", "UInt8", "UInt16", "UInt32", "UInt64", "SInt8", "SInt16", "SInt32", "SInt64",
            "double", "bool", "char", "Vector2f", "Vector3f", "Vector4f", "Quaternionf", "ColorRGBA", "Keyframe", "Matrix4x4f",
            "BoneWeights4", "BlendShapeVertex", "MinMaxAABB", "AABB", "SubMesh", "ChannelInfo", "Hash128", "ValueDelta",
        };

        static int ScanObject(Object o, string where, Dictionary<string, List<string>> targets)
        {
            int n = 0;
            var it = new SerializedObject(o).GetIterator();
            bool enter = true;
            while (it.Next(enter))
            {
                enter = true;
                if (it.propertyType == SerializedPropertyType.String) { enter = false; continue; }
                if (it.isArray && PlainArrayTypes.Contains(it.arrayElementType)) { enter = false; continue; }
                if (it.propertyType != SerializedPropertyType.ObjectReference) continue;
                if (it.objectReferenceValue != null || it.objectReferenceInstanceIDValue == 0) continue;
                n++;
                string key = AssetDatabase.TryGetGUIDAndLocalFileIdentifier(it.objectReferenceInstanceIDValue, out string g, out long lid)
                    ? g + ":" + lid : "unresolved-instance:" + it.objectReferenceInstanceIDValue;
                if (!targets.TryGetValue(key, out var l)) targets[key] = l = new List<string>();
                if (l.Count < 3) l.Add($"{where}:{o.GetType().Name}.{it.propertyPath}");
            }
            return n;
        }

        // 只扫从头像根「够得着」的对象（EditorUtility.CollectDependencies，含子资产、状态机、BlendTree 等）：
        // 厂商文件里的孤儿对象不影响头像；且 LoadAllAssetsAtPath 会把孤儿里的坏 PPtr 报成 Error（H-001b-3 第 4 轮实测 30 条 Broken text PPtr）。
        static (Dictionary<string, List<string>> targets, int nullObjects, int objects, int files) ScanReachable(Object[] roots)
        {
            var targets = new Dictionary<string, List<string>>();
            int nulls = 0, objs = 0;
            var files = new HashSet<string>();
            foreach (var o in EditorUtility.CollectDependencies(roots))
            {
                if (o == null) { nulls++; continue; }
                if (o is GameObject) continue;
                objs++;
                string where;
                if (AssetDatabase.Contains(o)) { where = AssetDatabase.GetAssetPath(o); files.Add(where); }
                else where = o is Component c ? "scene:" + HierPath(c.transform) : "memory";
                ScanObject(o, where, targets);
            }
            return (targets, nulls, objs, files.Count);
        }

        // 文本序列化资产里引用到、但工程里解析不到的 GUID → 引用它的文件
        static Dictionary<string, List<string>> DanglingGuids(IEnumerable<string> paths)
        {
            var res = new Dictionary<string, List<string>>();
            var known = new Dictionary<string, bool>();
            foreach (var p in paths)
            {
                if (!(p.StartsWith("Assets/") || p.StartsWith("Packages/"))) continue;
                if (!File.Exists(p) || !IsYaml(p)) continue;
                foreach (Match mt in GuidRx.Matches(File.ReadAllText(p)))
                {
                    string g = mt.Groups[1].Value;
                    if (g.StartsWith("0000000000000000")) continue; // 内置资源
                    if (!known.TryGetValue(g, out bool ok)) known[g] = ok = !string.IsNullOrEmpty(AssetDatabase.GUIDToAssetPath(g));
                    if (ok) continue;
                    if (!res.TryGetValue(g, out var l)) res[g] = l = new List<string>();
                    if (!l.Contains(p)) l.Add(p);
                }
            }
            return res;
        }

        static bool IsYaml(string p)
        {
            using (var fs = File.OpenRead(p))
            {
                var b = new byte[5];
                return fs.Read(b, 0, 5) == 5 && Encoding.ASCII.GetString(b) == "%YAML";
            }
        }

        static void PrepareOutDir(string outDir)
        {
            if (Directory.Exists(outDir))
            {
                string mf = Path.Combine(outDir, ManifestName);
                if (!File.Exists(mf) || !File.ReadAllText(mf).Contains("\"tool\": \"" + ToolId + "\""))
                    throw new Exception("输出目录已存在且不是本工具的产物，不删：" + outDir);
                Log("删除本工具上次的产物目录 " + outDir);
                AssetDatabase.DeleteAsset(outDir);
                if (Directory.Exists(outDir)) Directory.Delete(outDir, true);
                if (File.Exists(outDir + ".meta")) File.Delete(outDir + ".meta");
                AssetDatabase.Refresh();
            }
            EnsureFolder(outDir);
        }

        static void EnsureFolder(string path)
        {
            path = Norm(path).TrimEnd('/');
            if (AssetDatabase.IsValidFolder(path)) return;
            var parts = path.Split('/');
            string cur = parts[0];
            for (int i = 1; i < parts.Length; i++)
            {
                string next = cur + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next))
                {
                    string guid = AssetDatabase.CreateFolder(cur, parts[i]);
                    if (string.IsNullOrEmpty(guid)) throw new Exception("建目录失败：" + next);
                }
                cur = next;
            }
        }

        static Request ReadRequest(string requestFile = null)
        {
            var req = new Request();
            string rf = requestFile ?? Arg("-abRequest");
            if (!string.IsNullOrEmpty(rf)) req = JsonUtility.FromJson<Request>(File.ReadAllText(rf)) ?? new Request();
            req.input = Arg("-abInput") ?? req.input;
            req.root = Arg("-abRoot") ?? req.root;
            req.output = Arg("-abOut") ?? req.output;
            req.name = Arg("-abName") ?? req.name;
            req.report = Arg("-abReport") ?? req.report;
            if (Environment.GetCommandLineArgs().Contains("-abAllowErrors")) req.allowErrors = true;
            return req;
        }

        static string Arg(string name)
        {
            var a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++)
                if (a[i] == name) return a[i + 1];
            return null;
        }

        static Dictionary<string, object> ReadEmbeddedPackages()
        {
            var r = new Dictionary<string, object>();
            if (!Directory.Exists("Packages")) return r;
            foreach (var dir in Directory.GetDirectories("Packages").OrderBy(x => x))
            {
                string pj = Path.Combine(dir, "package.json");
                if (!File.Exists(pj)) continue;
                string txt = File.ReadAllText(pj);
                var n = Regex.Match(txt, "\"name\"\\s*:\\s*\"([^\"]+)\"");
                var v = Regex.Match(txt, "\"version\"\\s*:\\s*\"([^\"]+)\"");
                if (n.Success) r[n.Groups[1].Value] = v.Success ? v.Groups[1].Value : "?";
            }
            return r;
        }

        static Dictionary<string, object> LogSummary() => new Dictionary<string, object>
        {
            ["errors"] = s_errors, ["exceptions"] = s_exceptions, ["warnings"] = s_warnings,
            ["errorsByPhase"] = s_errorsByPhase.ToDictionary(kv => kv.Key, kv => (object)kv.Value),
            ["errorSamples"] = s_errorSamples.Cast<object>().ToList(),
        };

        static Type FindType(string fullName)
        {
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                var t = asm.GetType(fullName, false);
                if (t != null) return t;
            }
            return null;
        }

        static object GetStaticProp(string typeName, string prop)
        {
            try { return FindType(typeName)?.GetProperty(prop, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(null); }
            catch (Exception e) { return "error: " + e.Message; }
        }

        static string HierPath(Transform t)
        {
            var parts = new List<string>();
            for (var x = t; x != null; x = x.parent) parts.Insert(0, x.name);
            return string.Join("/", parts);
        }

        static string Sanitize(string s)
        {
            var bad = Path.GetInvalidFileNameChars().Concat(new[] { '/', '\\', ':', '*', '?', '"', '<', '>', '|' }).ToArray();
            var o = new string((s ?? "").Select(ch => bad.Contains(ch) ? '_' : ch).ToArray()).Trim();
            return string.IsNullOrEmpty(o) ? "avatar" : o;
        }

        static string Norm(string p) => (p ?? "").Replace('\\', '/');
        static string Now() => DateTime.Now.ToString("yyyy-MM-ddTHH:mm:sszzz", CultureInfo.InvariantCulture);
        static string Trunc(string s, int n) => s == null ? "" : (s.Length <= n ? s : s.Substring(0, n) + "…");

        static object Get(this Dictionary<string, object> d, string k) => d.TryGetValue(k, out var v) ? v : null;

        static void WriteExternal(string path, string text)
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(path, text, new UTF8Encoding(false));
        }

        // ── 迷你 JSON（清单只需要字典/列表/标量）────────────────────────────
        static string ToJson(object v)
        {
            var sb = new StringBuilder();
            WriteJson(sb, v, 0);
            sb.Append('\n');
            return sb.ToString();
        }

        static void WriteJson(StringBuilder sb, object v, int ind)
        {
            switch (v)
            {
                case null: sb.Append("null"); return;
                case string s: sb.Append('"').Append(Esc(s)).Append('"'); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); return;
                case long l: sb.Append(l.ToString(CultureInfo.InvariantCulture)); return;
                case float f: sb.Append(f.ToString("0.###", CultureInfo.InvariantCulture)); return;
                case double d: sb.Append(d.ToString("0.###", CultureInfo.InvariantCulture)); return;
                case IDictionary dict:
                {
                    if (dict.Count == 0) { sb.Append("{}"); return; }
                    sb.Append("{\n");
                    int k = 0;
                    foreach (DictionaryEntry e in dict)
                    {
                        sb.Append(' ', ind + 2).Append('"').Append(Esc(e.Key.ToString())).Append("\": ");
                        WriteJson(sb, e.Value, ind + 2);
                        if (++k < dict.Count) sb.Append(',');
                        sb.Append('\n');
                    }
                    sb.Append(' ', ind).Append('}');
                    return;
                }
                case IEnumerable seq:
                {
                    var items = seq.Cast<object>().ToList();
                    if (items.Count == 0) { sb.Append("[]"); return; }
                    sb.Append("[\n");
                    for (int j = 0; j < items.Count; j++)
                    {
                        sb.Append(' ', ind + 2);
                        WriteJson(sb, items[j], ind + 2);
                        if (j < items.Count - 1) sb.Append(',');
                        sb.Append('\n');
                    }
                    sb.Append(' ', ind).Append(']');
                    return;
                }
                default: sb.Append('"').Append(Esc(Convert.ToString(v, CultureInfo.InvariantCulture))).Append('"'); return;
            }
        }

        static string Esc(string s)
        {
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
