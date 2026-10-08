// 【项目沉淀】
// 适用素体：无关（Unity 编辑器构建期截获工具，不依赖任何素体 / 服装）。
// 用途：T-12 构建期截获的 NDMF 插件 `local.avatar-audit` 与 SDK 回调次序日志。
//
// 设计出处：`_长程任务_20260918/感知机制研究/04_第一期开工清单.md` T-12；
// 原理：`03_研究与方案.md` §3 / Q4 / Q6 / Q7。
//
// 闸（所有 pass / 回调共用，硬要求）：
//   `EditorApplication.isPlaying && File.Exists("<工程>/Library/AvatarAudit/request.json")`
//   不满足就立即 return —— 上传（VRCSDK 走同一段回调）永不执行本工具的写盘与改网格。
//
// 三段落点：
//   pass A（Resolving，BeforePlugin("nadena.dev.modular-avatar")）：
//     * 按 decl.json 路径解析构建克隆上的 GameObject/SMR，逐个 ObjectRegistry.GetReference 钉住；
//     * uv8 顶点标记：Instantiate(sharedMesh) → RegisterReplacedObject → 写 uv8=(源网格序号, 顶点序号)；
//     * synthetic_poke（T-31/T-28b 合成正样本）：在 AAO 合并之前把覆盖区 from_bone 权重改绑 to_bone；
//     * 把实例表塞进 AuditMappingProbe（Runtime，IEditorOnly）。
//   Harmony（AuditHarmonyMA）：钉 MA 自己的 ReactiveObjectAnalyzer.Analyze，序列化写者图。
//   pass B（Optimizing，AfterPlugin("com.anatawa12.avatar-optimizer")）：导出最终 FX（AuditFxExport）。
//
// 为什么 uv8 要先 Instantiate 再 RegisterReplacedObject：
//   sharedMesh 默认是工程资产（不可写、且改它会污染交付）；Instantiate 出可写副本、把「原→副本」
//   关系登记进 NDMF ObjectRegistry，AAO 合并时才认得这条替换（03 Q4 / 甲1）。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using nadena.dev.ndmf;
using UnityEditor;
using UnityEngine;
using VRC.SDKBase.Editor.BuildPipeline;
using Object = UnityEngine.Object;

// 【CB 根因 1】NDMF 只从「程序集特性」发现插件：PluginResolver.FindPluginTypes() 遍历 AppDomain
// 各程序集的 [ExportsPlugin(...)]，只继承 Plugin<T> 而不写这一行，Configure() 永不执行，pass A/B
// 就永远不跑。AT 漏了本行：SDK 四个回调照打（callbacks.log 次序对）、NDMF 也建了
// Packages/nadena.dev.ndmf/__Generated/<根名>(Clone)（说明 Config.ApplyOnPlay 为真、NDMF 真跑了），
// 但 pass 从未执行 → avatar_root=null、mapping/fx_final/ma_analysis 全静默缺席、notes/errors 为空。
[assembly: ExportsPlugin(typeof(AvatarAudit.AuditBuildPlugin))]

namespace AvatarAudit
{
    #region 闸与共享状态

    /// <summary>
    /// 闸 + 输出目录 + 跨文件共享状态。所有静态入口先 <see cref="GateOpen"/>，不满足直接返回。
    /// </summary>
    internal static class AuditBuildCapture
    {
        public const string BuildSubdir = "_感知/out/build";
        public const string ToolName = "build_capture";

        public static GameObject AvatarRoot;

        public static bool MappingWritten;
        public static bool FxWritten;
        public static bool MaWritten;
        public static bool CaptureWritten;
        public static bool PinPassRan;
        public static bool OptimizingPassRan;
        public static bool CallbacksLogInitialized;
        public static bool HarmonyInstalled;

        public static readonly List<string> Notes = new List<string>();
        public static readonly List<string> Errors = new List<string>();
        public static readonly List<object> Phases = new List<object>();

        /// <summary>缺席产物 → 原因码（WriteUnavailable 记录，WriteStatus 引用）。</summary>
        public static readonly Dictionary<string, string> AbsentReasons = new Dictionary<string, string>(StringComparer.Ordinal);

        private static JsonObject _request;
        private static bool _requestLoaded;

        public static string ProjectRoot
        {
            get
            {
                var parent = Directory.GetParent(Application.dataPath);
                return parent == null ? Application.dataPath : parent.FullName;
            }
        }

        public static string RequestPath
        {
            get { return Path.Combine(ProjectRoot, Path.Combine("Library", Path.Combine("AvatarAudit", "request.json"))); }
        }

        /// <summary>硬闸：只在 Play 且请求文件存在时才动。上传 / 编辑模式一律 false。</summary>
        public static bool GateOpen
        {
            get { return EditorApplication.isPlaying && File.Exists(RequestPath); }
        }

        public static string OutDir
        {
            get { return Path.Combine(ProjectRoot, BuildSubdir.Replace('/', Path.DirectorySeparatorChar)); }
        }

        public static string OutPath(string fileName)
        {
            return Path.Combine(OutDir, fileName);
        }

        public static JsonObject ReadRequest()
        {
            if (_requestLoaded) return _request;
            _requestLoaded = true;
            _request = new JsonObject();
            try
            {
                if (File.Exists(RequestPath))
                {
                    var parsed = AuditJson.Parse(File.ReadAllText(RequestPath, Encoding.UTF8)) as JsonObject;
                    if (parsed != null) _request = parsed;
                }
            }
            catch (Exception e)
            {
                Debug.LogWarning("[AvatarAudit/build] 读 request.json 失败：" + e.Message);
            }
            return _request;
        }

        public static string DeclPath
        {
            get
            {
                var req = ReadRequest();
                var d = AuditJson.Str(req, "decl", null);
                if (!string.IsNullOrEmpty(d))
                    return Path.IsPathRooted(d) ? d : Path.Combine(ProjectRoot, d.Replace('/', Path.DirectorySeparatorChar));
                return Path.Combine(ProjectRoot, Path.Combine("_感知", "decl.json"));
            }
        }

        public static void ResetRun()
        {
            _requestLoaded = false;
            _request = null;
            Notes.Clear();
            Errors.Clear();
            Phases.Clear();
            AbsentReasons.Clear();
            MappingWritten = false;
            FxWritten = false;
            MaWritten = false;
            CaptureWritten = false;
            PinPassRan = false;
            OptimizingPassRan = false;
            HarmonyInstalled = false;
            AvatarRoot = null;
        }

        public static JsonObject ToolVersion(Type t)
        {
            try { return AuditToolVersion.Describe(ProjectRoot, t, false); }
            catch { return new JsonObject(); }
        }

        public static void MarkPhase(string phase, string detail)
        {
            var o = new JsonObject();
            o.Set("phase", phase);
            o.Set("utc", DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture));
            if (!string.IsNullOrEmpty(detail)) o.Set("detail", detail);
            Phases.Add(o);
        }

        public static void Note(string s)
        {
            Notes.Add(s);
            Debug.Log("[AvatarAudit/build] " + s);
        }

        public static void Error(string s)
        {
            Errors.Add(s);
            Debug.LogError("[AvatarAudit/build] " + s);
        }

        public static void Write(string fileName, object value)
        {
            try
            {
                Directory.CreateDirectory(OutDir);
                AuditJson.WriteFile(OutPath(fileName), value);
            }
            catch (Exception e)
            {
                Debug.LogError("[AvatarAudit/build] 写 " + fileName + " 失败：" + e);
            }
        }

        public static void WriteStatus()
        {
            var o = new JsonObject();
            o.Set("tool", ToolName);
            o.Set("tool_version", ToolVersion(typeof(AuditBuildPlugin)));
            o.Set("request_path", RequestPath);
            o.Set("decl_path", DeclPath);
            o.Set("avatar_root", AvatarRoot == null ? null : AvatarRoot.name);
            o.Set("avatar_root_normalized", AvatarRootNormalized);
            o.Set("out_dir", OutDir);
            o.Set("mapping_written", MappingWritten);
            o.Set("fx_written", FxWritten);
            o.Set("ma_written", MaWritten);
            o.Set("capture_written", CaptureWritten);
            o.Set("pin_pass_ran", PinPassRan);
            o.Set("optimizing_pass_ran", OptimizingPassRan);
            o.Set("harmony_installed", HarmonyInstalled);
            o.Set("ndmf_apply_on_play", NdmfApplyOnPlayJson());
            o.Set("artifacts", BuildArtifacts());
            o.Set("phases", Phases);
            o.Set("notes", Notes.Cast<object>().ToList());
            o.Set("errors", Errors.Cast<object>().ToList());
            Write("build_status.json", o);
        }

        /// <summary>把构建期根名规整成声明口径：去掉 NDMF / VRCFury 在 Play 构建时临时加的 "(Clone)"。</summary>
        public static string NormalizeRootName(string name)
        {
            if (string.IsNullOrEmpty(name)) return name;
            var n = name.TrimEnd();
            const string suffix = "(Clone)";
            if (n.EndsWith(suffix, StringComparison.Ordinal))
                n = n.Substring(0, n.Length - suffix.Length).TrimEnd();
            return n;
        }

        public static string AvatarRootNormalized
        {
            get { return NormalizeRootName(AvatarRoot == null ? null : AvatarRoot.name); }
        }

        /// <summary>NDMF Apply on Play 开关（诊断用；为 false 时 Play 里 NDMF 不会调起本插件）。</summary>
        private static object NdmfApplyOnPlayJson()
        {
            try
            {
                var t = Type.GetType("nadena.dev.ndmf.config.Config, nadena.dev.ndmf");
                var p = t == null ? null : t.GetProperty("ApplyOnPlay", BindingFlags.Public | BindingFlags.Static);
                return p == null ? (object)"unknown" : p.GetValue(null, null);
            }
            catch (Exception e) { return "unknown: " + e.Message; }
        }

        public static string MappingReasonCode()
        {
            if (MappingWritten) return null;
            if (!PinPassRan) return "plugin_not_run";
            if (!OptimizingPassRan) return "pass_b_not_run";
            return "mapping_no_aao";
        }

        public static string FxReasonCode()
        {
            if (FxWritten) return null;
            if (!PinPassRan) return "plugin_not_run";
            if (!OptimizingPassRan) return "pass_b_not_run";
            return "fx_export_failed";
        }

        public static string MaReasonCode()
        {
            if (MaWritten) return null;
            if (!PinPassRan) return "plugin_not_run";
            if (!HarmonyInstalled) return "harmony_unavailable";
            return "ma_analyze_not_called";
        }

        public static string ReasonText(string code)
        {
            switch (code)
            {
                case "plugin_not_run":
                    return "NDMF 插件 local.avatar-audit 的 pass 未执行：ExportsPlugin 未注册 / 插件被禁用 / NDMF Apply on Play 关闭 / 本次构建没走 NDMF。";
                case "pass_b_not_run":
                    return "pass A 已执行，但 Optimizing 的 pass B 未执行（AnimatorServicesContext 未激活或 Optimizing 中途失败）。";
                case "mapping_no_aao":
                    return "AAO ApplySpecialMapping 未回调：头像无 AvatarTagComponent、AAO 未跑，或 ComponentInfoRegistry 未收录 AuditMappingProbeInfo（新部署后需要一次域重载；pass A 自注册结果见 notes）。";
                case "fx_export_failed":
                    return "pass B 已执行但 FX 导出失败（见 build_status.errors）。";
                case "harmony_unavailable":
                    return "Harmony 未装上：MA 程序集 / ReactiveObjectAnalyzer / Analyze 找不到，或 MA 版本宏 AUDIT_MA_1_18_1 不匹配。";
                case "ma_analyze_not_called":
                    return "Harmony 已装但 MA ReactiveObjectAnalyzer.Analyze 未以本头像根被调用（该头像可能没有 MA 反应式组件）。";
                case "capture_failed":
                    return "pass A 已执行但 capture.json 未写出（见 build_status.errors）。";
                case "stale_file":
                    return "文件是上一次运行留下的（本次 pass 未写），请以文件内 tool_version / 时间戳为准。";
                default:
                    return code == null ? null : code;
            }
        }

        /// <summary>
        /// 收尾保证（在 int.MaxValue 回调里调用）：任何没写的产物都落一个 available:false + reason_code
        /// 的占位文件，并进 build_status.artifacts，禁止静默缺席（T-12 规格）。
        /// </summary>
        public static void EnsureArtifactReasons()
        {
            if (!CaptureWritten && !File.Exists(OutPath("capture.json")))
                WriteUnavailable("capture.json", "pin", PinPassRan ? "capture_failed" : "plugin_not_run");
            if (!MappingWritten && !File.Exists(OutPath("mapping.json")))
                WriteUnavailable("mapping.json", "mapping", MappingReasonCode());
            if (!FxWritten && !File.Exists(OutPath("fx_final.json")))
                WriteUnavailable("fx_final.json", "fx_final", FxReasonCode());
            if (!MaWritten && !File.Exists(OutPath("ma_analysis.json")))
                WriteUnavailable("ma_analysis.json", "ma_analysis", MaReasonCode());
        }

        /// <summary>写「该产物为何缺席」的占位文件；原因码同时记进 AbsentReasons 供 build_status 引用。</summary>
        public static void WriteUnavailable(string fileName, string phase, string reasonCode)
        {
            try
            {
                AbsentReasons[fileName] = reasonCode;
                var o = new JsonObject();
                o.Set("tool", ToolName);
                o.Set("tool_version", ToolVersion(typeof(AuditBuildPlugin)));
                o.Set("phase", phase);
                o.Set("available", false);
                o.Set("reason_code", reasonCode);
                o.Set("reason", ReasonText(reasonCode));
                Write(fileName, o);
            }
            catch (Exception e)
            {
                Debug.LogError("[AvatarAudit/build] 写 " + fileName + " 缺席原因失败：" + e.Message);
            }
        }

        private static JsonObject BuildArtifacts()
        {
            var arts = new JsonObject();
            AddArtifact(arts, "capture", "capture.json", CaptureWritten, PinPassRan ? "capture_failed" : "plugin_not_run");
            AddArtifact(arts, "mapping", "mapping.json", MappingWritten, MappingReasonCode());
            AddArtifact(arts, "fx_final", "fx_final.json", FxWritten, FxReasonCode());
            AddArtifact(arts, "ma_analysis", "ma_analysis.json", MaWritten, MaReasonCode());
            return arts;
        }

        private static void AddArtifact(JsonObject parent, string key, string file, bool producerWritten, string defaultReasonCode)
        {
            var a = new JsonObject();
            var exists = producerWritten || File.Exists(OutPath(file));
            var available = exists ? ArtifactField(file, "available") : null;
            a.Set("file", file);
            a.Set("written", exists);
            a.Set("producer_written", producerWritten);
            a.Set("available", available ?? (exists ? (object)"unset" : false));

            string reason = null;
            if (!exists) reason = defaultReasonCode;
            else if (!producerWritten)
            {
                string rc;
                reason = AbsentReasons.TryGetValue(file, out rc) ? rc : "stale_file";
            }
            else if (available is bool && !(bool)available)
            {
                // 生产者写了文件但内容 available:false（如 Harmony 版本不符、FX 取不到）——
                // 把它自己写的原因码透传到 build_status，别让「文件在」掩盖「没真值」。
                reason = ArtifactField(file, "reason_code") as string;
            }
            if (!string.IsNullOrEmpty(reason))
            {
                a.Set("reason_code", reason);
                a.Set("reason", ArtifactField(file, "reason") ?? ReasonText(reason));
            }
            parent.Set(key, a);
        }

        private static object ArtifactField(string fileName, string field)
        {
            try
            {
                var p = OutPath(fileName);
                if (!File.Exists(p)) return null;
                var o = AuditJson.Parse(File.ReadAllText(p, Encoding.UTF8)) as JsonObject;
                return o == null ? null : o.Get(field);
            }
            catch { return null; }
        }

        /// <summary>
        /// SDK 回调次序日志：本工具在 -11000/-10000/-1025/int.MaxValue 各挂一个只记日志的回调。
        /// 每次 Play 的第一条回调（-11000）先把旧日志截断，保证文件里只有本次四条，便于核次序。
        /// </summary>
        public static void LogCallback(int order)
        {
            try
            {
                Directory.CreateDirectory(OutDir);
                if (!CallbacksLogInitialized || order == -11000)
                {
                    CallbacksLogInitialized = true;
                    File.WriteAllText(OutPath("callbacks.log"), "", new UTF8Encoding(false));
                }
                var line = string.Format(CultureInfo.InvariantCulture, "{0}\t{1}\t{2}",
                    order, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture),
                    EditorApplication.isPlaying ? "play" : "edit");
                File.AppendAllText(OutPath("callbacks.log"), line + "\n", new UTF8Encoding(false));
            }
            catch (Exception e)
            {
                Debug.LogError("[AvatarAudit/build] 写 callbacks.log 失败：" + e.Message);
            }
        }
    }

    #endregion

    #region 声明读取

    internal sealed class AuditDeclPart
    {
        public string Id;
        public readonly List<string> Paths = new List<string>();
    }

    /// <summary>只读 T-12 需要的声明字段：parts[].objects[].path 与 deps[].target(s).key(s)。</summary>
    internal sealed class AuditDecl
    {
        public string AvatarRootName;
        public readonly List<AuditDeclPart> Parts = new List<AuditDeclPart>();
        public readonly Dictionary<string, List<string>> KeysByPath = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        public string LoadNote;

        public static AuditDecl Load(string declPath)
        {
            var d = new AuditDecl();
            JsonObject root = null;
            try
            {
                if (!string.IsNullOrEmpty(declPath) && File.Exists(declPath))
                    root = AuditJson.Parse(File.ReadAllText(declPath, Encoding.UTF8)) as JsonObject;
            }
            catch (Exception e)
            {
                d.LoadNote = "读 decl.json 失败：" + e.Message;
                return d;
            }

            if (root == null)
            {
                d.LoadNote = "decl.json 不存在或解析失败（" + declPath + "）";
                return d;
            }

            var avatar = AuditJson.Obj(root, "avatar");
            if (avatar != null) d.AvatarRootName = AuditJson.Str(avatar, "root", null);

            var partsArr = AuditJson.Arr(root, "parts");
            var partById = new Dictionary<string, AuditDeclPart>(StringComparer.Ordinal);
            if (partsArr != null)
            {
                foreach (var p in partsArr)
                {
                    var po = p as JsonObject;
                    if (po == null) continue;
                    var part = new AuditDeclPart { Id = AuditJson.Str(po, "id", null) };
                    var objs = AuditJson.Arr(po, "objects");
                    if (objs != null)
                    {
                        foreach (var ob in objs)
                        {
                            var oo = ob as JsonObject;
                            if (oo == null)
                            {
                                // 任务 CI：兼容 objects[] 里直接写字符串（等价于 renderer=smr 的 path）。
                                var sp = ob as string;
                                if (string.IsNullOrEmpty(sp) && ob != null)
                                    sp = Convert.ToString(ob, System.Globalization.CultureInfo.InvariantCulture);
                                if (!string.IsNullOrEmpty(sp)) part.Paths.Add(sp.Trim());
                                continue;
                            }
                            if (AuditJson.Str(oo, "renderer", null) != "smr") continue;
                            var path = AuditJson.Str(oo, "path", null);
                            if (!string.IsNullOrEmpty(path)) part.Paths.Add(path);
                        }
                    }
                    d.Parts.Add(part);
                    if (!string.IsNullOrEmpty(part.Id)) partById[part.Id] = part;
                }
            }

            // deps[].target(s).key(s)：声明引用的源键。part 形式按该 part 的每个 SMR 路径登记；
            // mesh 形式按 mesh 路径登记。
            var deps = AuditJson.Arr(root, "deps");
            if (deps != null)
            {
                foreach (var dp in deps)
                {
                    var dep = dp as JsonObject;
                    if (dep == null) continue;
                    var targets = new List<object>();
                    var one = AuditJson.Obj(dep, "target");
                    if (one != null) targets.Add(one);
                    var many = AuditJson.Arr(dep, "targets");
                    if (many != null) targets.AddRange(many);

                    foreach (var t in targets)
                    {
                        var to = t as JsonObject;
                        if (to == null) continue;
                        var keyList = new List<string>();
                        var k = AuditJson.Str(to, "key", null);
                        if (!string.IsNullOrEmpty(k)) keyList.Add(k);
                        var ks = AuditJson.Arr(to, "keys");
                        if (ks != null)
                            foreach (var kk in ks)
                            {
                                var s = kk as string;
                                if (!string.IsNullOrEmpty(s) && !keyList.Contains(s)) keyList.Add(s);
                            }
                        if (keyList.Count == 0) continue;

                        var partId = AuditJson.Str(to, "part", null);
                        if (!string.IsNullOrEmpty(partId))
                        {
                            AuditDeclPart part;
                            if (partById.TryGetValue(partId, out part))
                                foreach (var path in part.Paths) AddKeys(d.KeysByPath, path, keyList);
                        }
                        var mesh = AuditJson.Str(to, "mesh", null);
                        if (!string.IsNullOrEmpty(mesh)) AddKeys(d.KeysByPath, mesh, keyList);
                    }
                }
            }

            return d;
        }

        private static void AddKeys(Dictionary<string, List<string>> map, string path, List<string> keys)
        {
            List<string> list;
            if (!map.TryGetValue(path, out list))
            {
                list = new List<string>();
                map[path] = list;
            }
            foreach (var k in keys) if (!list.Contains(k)) list.Add(k);
        }
    }

    #endregion

    #region pass A：钉住 + uv8 + synthetic_poke

    /// <summary>
    /// Resolving 阶段、MA 之前的审查 pass。只在闸开时执行；抛异常也不能中断别人的构建，
    /// 所以整段 try/catch，把失败记进 build_status.json。
    /// </summary>
    internal sealed class AuditPinPass : Pass<AuditPinPass>
    {
        public override string DisplayName
        {
            get { return "AvatarAudit: pin declared objects / uv8 / synthetic_poke"; }
        }

        protected override void Execute(BuildContext context)
        {
            if (!AuditBuildCapture.GateOpen) return;
            AuditBuildCapture.ResetRun();
            AuditBuildCapture.PinPassRan = true;
            AuditBuildCapture.AvatarRoot = context.AvatarRootObject;
            try
            {
                Run(context);
            }
            catch (Exception e)
            {
                AuditBuildCapture.Error("pass A 失败：" + e);
                Debug.LogException(e);
            }
            finally
            {
                AuditBuildCapture.WriteStatus();
            }
        }

        private void Run(BuildContext context)
        {
            var avatarRoot = context.AvatarRootObject;
            if (avatarRoot == null)
            {
                AuditBuildCapture.Error("pass A：BuildContext.AvatarRootObject 为空");
                return;
            }
            AuditBuildCapture.MarkPhase("pin", avatarRoot.name);

            var decl = AuditDecl.Load(AuditBuildCapture.DeclPath);
            if (!string.IsNullOrEmpty(decl.LoadNote)) AuditBuildCapture.Note(decl.LoadNote);

            var rootName = avatarRoot.name;
            var rootNorm = AuditBuildCapture.NormalizeRootName(rootName);
            if (!string.IsNullOrEmpty(decl.AvatarRootName) && decl.AvatarRootName != rootNorm)
                AuditBuildCapture.Note("声明 avatar.root=" + decl.AvatarRootName + "，构建根=" + rootName
                                       + "（normalize=" + rootNorm + "）；根按 VRCAvatarDescriptor 取、不按名，仅提示");
            else if (rootName != rootNorm)
                AuditBuildCapture.Note("构建根名含临时 (Clone)：" + rootName + " → normalize=" + rootNorm
                                       + "（NDMF/VRCFury Play 构建临时改名；路径口径按根相对，不影响解析）");
            else if (!string.IsNullOrEmpty(decl.AvatarRootName))
                AuditBuildCapture.Note("声明 avatar.root 与构建根一致：" + rootNorm);

            var allSmrs = avatarRoot.GetComponentsInChildren<SkinnedMeshRenderer>(true);

            // 1) uv8 标记：按源网格去重，clone 一次给所有引用它的 SMR 共用。
            var ordinalByMesh = new Dictionary<Mesh, int>();
            var cloneBySource = new Dictionary<Mesh, Mesh>();
            int nextOrdinal = 0, sourceMeshCount = 0;
            int okUv8 = 0, skippedUv8 = 0;
            foreach (var smr in allSmrs)
            {
                if (smr == null) continue;
                var src = smr.sharedMesh;
                if (src == null)
                {
                    skippedUv8++;
                    continue;
                }
                int ordinal;
                if (!ordinalByMesh.TryGetValue(src, out ordinal))
                {
                    ordinal = nextOrdinal++;
                    ordinalByMesh[src] = ordinal;
                    sourceMeshCount++;
                }
                Mesh clone;
                if (!cloneBySource.TryGetValue(src, out clone))
                {
                    clone = Object.Instantiate(src);
                    clone.name = src.name + "$$AvatarAuditUv8";
                    cloneBySource[src] = clone;
                    // 让 BuildProbe 也能用克隆网格（构建后 sharedMesh 已是它）查到同一个序号。
                    ordinalByMesh[clone] = ordinal;
                    RegisterReplaced(src, clone);
                    WriteUv8(clone, ordinal);
                }
                smr.sharedMesh = clone;
                okUv8++;
            }
            AuditBuildCapture.Note("uv8: " + okUv8 + " 个 SMR / " + sourceMeshCount + " 个源网格已标记，跳过 "
                                   + skippedUv8 + " 个无网格 SMR");

            // 2) synthetic_poke：在 AAO 合并之前改绑权重。
            int pokeCount = ApplySyntheticPokes(context, avatarRoot, decl, cloneBySource);

            // 3) 钉住声明路径上的实例。
            int pinnedObjects = 0, pinnedComponents = 0;
            foreach (var part in decl.Parts)
            {
                foreach (var path in part.Paths)
                {
                    var t = FindByPath(avatarRoot.transform, path);
                    if (t == null)
                    {
                        AuditBuildCapture.Note("声明路径解析不上（跳过）：" + path);
                        continue;
                    }
                    var reference = ObjectRegistry.GetReference(t.gameObject);
                    pinnedObjects++;
                    var comps = t.GetComponents<Component>();
                    foreach (var c in comps)
                    {
                        if (c == null) continue;
                        ObjectRegistry.GetReference(c);
                        pinnedComponents++;
                    }
                    if (reference == null) continue;
                }
            }
            AuditBuildCapture.Note("钉住：对象 " + pinnedObjects + " 个、组件 " + pinnedComponents + " 个");

            // 4) 实例表交给 AuditMappingProbe。
            BuildProbe(avatarRoot, allSmrs, decl, ordinalByMesh, okUv8);

            // 4b) 防御 AAO ComponentInfoRegistry 的域重载问题：确保它认识 AuditMappingProbeInfo，
            //     否则 AAO 的 ApplySpecialMapping 永不回调、mapping.json 静默缺席。
            AuditMappingProbeInfo.EnsureAaoRegistry();

            // 5) Harmony 钩 MA 分析结果。
            AuditHarmonyMA.Install();

            // 6) 摘要。
            var summary = new JsonObject();
            summary.Set("tool", AuditBuildCapture.ToolName);
            summary.Set("tool_version", AuditBuildCapture.ToolVersion(typeof(AuditBuildPlugin)));
            summary.Set("avatar_root", avatarRoot.name);
            summary.Set("avatar_root_normalized", AuditBuildCapture.NormalizeRootName(avatarRoot.name));
            summary.Set("decl_path", AuditBuildCapture.DeclPath);
            summary.Set("decl_avatar_root", decl.AvatarRootName);
            summary.Set("decl_parts", decl.Parts.Count);
            summary.Set("smr_total", allSmrs.Length);
            summary.Set("smr_uv8_marked", okUv8);
            summary.Set("source_meshes", sourceMeshCount);
            summary.Set("synthetic_poke", pokeCount);
            summary.Set("pinned_objects", pinnedObjects);
            summary.Set("pinned_components", pinnedComponents);
            summary.Set("harmony_installed", AuditBuildCapture.HarmonyInstalled);
            summary.Set("request", AuditBuildCapture.ReadRequest());
            AuditBuildCapture.Write("capture.json", summary);
            AuditBuildCapture.CaptureWritten = true;
            AuditBuildCapture.MarkPhase("pin_done", null);
        }

        private static void RegisterReplaced(Object src, Object clone)
        {
            try { ObjectRegistry.RegisterReplacedObject(src, clone); }
            catch (Exception e) { AuditBuildCapture.Note("RegisterReplacedObject 失败：" + e.Message); }
        }

        private static void WriteUv8(Mesh mesh, int ordinal)
        {
            try
            {
                var count = mesh.vertexCount;
                var uv8 = new Vector2[count];
                for (int i = 0; i < count; i++) uv8[i] = new Vector2(ordinal, i);
                mesh.uv8 = uv8;
            }
            catch (Exception e)
            {
                AuditBuildCapture.Error("写 uv8 失败（" + mesh.name + "）：" + e.Message);
            }
        }

        private static Transform FindByPath(Transform root, string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            var direct = root.Find(path);
            if (direct != null) return direct;
            // 退路：逐段比名字（忽略 "./"、多余空格）
            var segs = path.Replace('\\', '/').Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            var cur = root;
            foreach (var raw in segs)
            {
                var seg = raw.Trim();
                if (seg == "." || seg.Length == 0) continue;
                var next = cur.Find(seg);
                if (next == null) return null;
                cur = next;
            }
            return cur == root ? null : cur;
        }

        private static int ApplySyntheticPokes(BuildContext context, GameObject avatarRoot, AuditDecl decl,
            Dictionary<Mesh, Mesh> cloneBySource)
        {
            var arr = AuditJson.Arr(AuditBuildCapture.ReadRequest(), "synthetic_poke");
            if (arr == null || arr.Count == 0) return 0;

            var animator = avatarRoot.GetComponentInChildren<Animator>(true);
            if (animator == null)
            {
                AuditBuildCapture.Error("synthetic_poke：头像下没有 Animator，无法解析骨骼");
                return 0;
            }

            var report = new List<object>();
            int applied = 0;
            foreach (var item in arr)
            {
                var o = item as JsonObject;
                if (o == null) continue;
                var partId = AuditJson.Str(o, "part", null);
                var region = AuditJson.Str(o, "region", null);
                var fromBone = AuditJson.Str(o, "from_bone", null);
                var toBone = AuditJson.Str(o, "to_bone", null);

                var entry = new JsonObject();
                entry.Set("part", partId);
                entry.Set("region", region);
                entry.Set("from_bone", fromBone);
                entry.Set("to_bone", toBone);

                var fromT = ResolveBone(animator, fromBone);
                var toT = ResolveBone(animator, toBone);
                var regionT = ResolveBone(animator, region);
                if (fromT == null || toT == null)
                {
                    entry.Set("status", "skipped");
                    entry.Set("reason", fromT == null ? "from_bone 解析不上" : "to_bone 解析不上");
                    report.Add(entry);
                    continue;
                }

                var part = decl.Parts.FirstOrDefault(p => p.Id == partId);
                if (part == null)
                {
                    entry.Set("status", "skipped");
                    entry.Set("reason", "声明里没有 part=" + partId);
                    report.Add(entry);
                    continue;
                }

                int partApplied = 0;
                foreach (var path in part.Paths)
                {
                    var t = FindByPath(avatarRoot.transform, path);
                    var smr = t == null ? null : t.GetComponent<SkinnedMeshRenderer>();
                    if (smr == null) continue;
                    partApplied += ApplyPokeOnSmr(smr, fromT, toT, regionT);
                }
                entry.Set("status", partApplied > 0 ? "applied" : "no_vertex");
                entry.Set("vertices", partApplied);
                report.Add(entry);
                applied += partApplied;
            }
            AuditBuildCapture.Write("synthetic_poke.json", new JsonObject()
                .Set("tool", AuditBuildCapture.ToolName)
                .Set("tool_version", AuditBuildCapture.ToolVersion(typeof(AuditBuildPlugin)))
                .Set("entries", report)
                .Set("vertices_total", applied));
            AuditBuildCapture.Note("synthetic_poke: 改绑 " + applied + " 个顶点");
            return applied;
        }

        private static Transform ResolveBone(Animator animator, string boneName)
        {
            if (string.IsNullOrEmpty(boneName)) return null;
            HumanBodyBones bone;
            try
            {
                if (!Enum.TryParse(boneName, true, out bone)) return null;
            }
            catch { return null; }
            try { return animator.GetBoneTransform(bone); }
            catch { return null; }
        }

        /// <summary>把 smr 上「覆盖区内 from_bone 有影响」的顶点权重改绑 to_bone。返回改动顶点数。</summary>
        private static int ApplyPokeOnSmr(SkinnedMeshRenderer smr, Transform fromT, Transform toT, Transform regionT)
        {
            var mesh = smr.sharedMesh;
            if (mesh == null || smr.bones == null) return 0;
            int fromIdx = Array.IndexOf(smr.bones, fromT);
            int toIdx = Array.IndexOf(smr.bones, toT);
            if (fromIdx < 0 || toIdx < 0) return 0;

            // 私有副本：poke 只影响这一件，不能污染与它共用网格的其它 SMR。
            var privateMesh = Object.Instantiate(mesh);
            privateMesh.name = mesh.name + "$$AvatarAuditPoke";
            var bw = privateMesh.boneWeights;

            int changed = 0;
            for (int v = 0; v < bw.Length; v++)
            {
                if (!InRegion(smr, bw[v], regionT)) continue;
                var w = bw[v];
                bool hit = false;
                if (w.boneIndex0 == fromIdx && w.weight0 > 0f) { w.boneIndex0 = toIdx; hit = true; }
                if (w.boneIndex1 == fromIdx && w.weight1 > 0f) { w.boneIndex1 = toIdx; hit = true; }
                if (w.boneIndex2 == fromIdx && w.weight2 > 0f) { w.boneIndex2 = toIdx; hit = true; }
                if (w.boneIndex3 == fromIdx && w.weight3 > 0f) { w.boneIndex3 = toIdx; hit = true; }
                if (hit) { bw[v] = w; changed++; }
            }
            if (changed == 0)
            {
                Object.DestroyImmediate(privateMesh);
                return 0;
            }
            privateMesh.boneWeights = bw;
            // uv8 已在共享副本上写好，私有副本要补写（否则 ID 图会退化）。
            TryCopyUv8(mesh, privateMesh);
            smr.sharedMesh = privateMesh;
            RegisterReplaced(mesh, privateMesh);
            return changed;
        }

        private static bool InRegion(SkinnedMeshRenderer smr, BoneWeight w, Transform regionT)
        {
            if (regionT == null) return true;
            return IsDominantInRegion(smr, w.boneIndex0, w.weight0, regionT)
                   || IsDominantInRegion(smr, w.boneIndex1, w.weight1, regionT)
                   || IsDominantInRegion(smr, w.boneIndex2, w.weight2, regionT)
                   || IsDominantInRegion(smr, w.boneIndex3, w.weight3, regionT);
        }

        private static bool IsDominantInRegion(SkinnedMeshRenderer smr, int boneIndex, float weight, Transform regionT)
        {
            if (weight <= 0f) return false;
            if (boneIndex < 0 || smr.bones == null || boneIndex >= smr.bones.Length) return false;
            var bt = smr.bones[boneIndex];
            if (bt == null) return false;
            return bt == regionT || bt.IsChildOf(regionT);
        }

        private static void TryCopyUv8(Mesh from, Mesh to)
        {
            try
            {
                var src = from.uv8;
                if (src != null && src.Length == to.vertexCount) to.uv8 = src;
            }
            catch { /* uv8 不存在时忽略 */ }
        }

        /// <summary>构造并挂 AuditMappingProbe；只登记「有键」的 SMR。</summary>
        private static void BuildProbe(GameObject avatarRoot, SkinnedMeshRenderer[] allSmrs, AuditDecl decl,
            Dictionary<Mesh, int> ordinalByMesh, int uv8Count)
        {
            var probe = avatarRoot.GetComponent<AuditMappingProbe>();
            if (probe == null) probe = avatarRoot.AddComponent<AuditMappingProbe>();
            else AuditBuildCapture.Note("头像根上已有 AuditMappingProbe，复用");

            var renderers = new List<SkinnedMeshRenderer>();
            var paths = new List<string>();
            var ordinals = new List<int>();
            var keys = new List<string>();
            var counts = new List<int>();

            foreach (var smr in allSmrs)
            {
                if (smr == null) continue;
                var path = AuditUtil.RelPath(avatarRoot.transform, smr.transform);
                var keySet = new List<string>();
                var mesh = smr.sharedMesh;
                if (mesh != null)
                {
                    for (int i = 0; i < mesh.blendShapeCount; i++)
                    {
                        var name = mesh.GetBlendShapeName(i);
                        if (!string.IsNullOrEmpty(name) && !keySet.Contains(name)) keySet.Add(name);
                    }
                }
                List<string> declared;
                if (decl.KeysByPath.TryGetValue(path, out declared))
                    foreach (var k in declared) if (!keySet.Contains(k)) keySet.Add(k);
                if (keySet.Count == 0) continue;

                renderers.Add(smr);
                paths.Add(path);
                int ord;
                ordinals.Add(mesh != null && ordinalByMesh.TryGetValue(mesh, out ord) ? ord : -1);
                foreach (var k in keySet) keys.Add(k);
                counts.Add(keySet.Count);
            }

            probe.renderers = renderers.ToArray();
            probe.sourcePaths = paths.ToArray();
            probe.rendererMeshOrdinals = ordinals.ToArray();
            probe.keys = keys.ToArray();
            probe.rendererKeyCounts = counts.ToArray();

            AuditBuildCapture.Note("AuditMappingProbe: " + renderers.Count + " 个 SMR / " + keys.Count
                                   + " 个源键（uv8 已标记 " + uv8Count + " 个 SMR）");
        }
    }

    #endregion

    #region pass B：最终 FX 导出

    internal sealed class AuditOptimizingPass : Pass<AuditOptimizingPass>
    {
        public override string DisplayName
        {
            get { return "AvatarAudit: export final FX"; }
        }

        protected override void Execute(BuildContext context)
        {
            if (!AuditBuildCapture.GateOpen) return;
            AuditBuildCapture.OptimizingPassRan = true;
            try
            {
                AuditFxExport.Export(context);
                if (!AuditBuildCapture.MappingWritten && !File.Exists(AuditBuildCapture.OutPath("mapping.json")))
                {
                    // AAO 的 ApplySpecialMapping 没回调（头像下没有 AvatarTagComponent、AAO 未跑，
                    // 或 ComponentInfoRegistry 没收录 AuditMappingProbeInfo）——显式落 available:false
                    // + reason_code，让 T-14 知道是「截获没生效」而不是「文件丢了」。
                    var code = AuditBuildCapture.MappingReasonCode();
                    AuditBuildCapture.WriteUnavailable("mapping.json", "mapping", code);
                    AuditBuildCapture.Error("mapping.json 缺席：" + code);
                }
            }
            catch (Exception e)
            {
                AuditBuildCapture.Error("pass B 失败：" + e);
                Debug.LogException(e);
            }
            finally
            {
                AuditBuildCapture.MarkPhase("fx_done", null);
                AuditBuildCapture.WriteStatus();
            }
        }
    }

    #endregion

    #region NDMF 插件注册

    internal sealed class AuditBuildPlugin : Plugin<AuditBuildPlugin>
    {
        public override string QualifiedName { get { return "local.avatar-audit"; } }
        public override string DisplayName { get { return "Avatar Audit Build Capture (T-12)"; } }

        protected override void Configure()
        {
            InPhase(BuildPhase.Resolving)
                .Run(AuditPinPass.Instance)
                .BeforePlugin("nadena.dev.modular-avatar");

            var optimizing = InPhase(BuildPhase.Optimizing);
            optimizing.WithRequiredExtension(typeof(nadena.dev.ndmf.animator.AnimatorServicesContext), s =>
            {
                s.Run(AuditOptimizingPass.Instance);
            });
            optimizing.AfterPlugin("com.anatawa12.avatar-optimizer");
        }
    }

    #endregion

    #region SDK 回调次序日志

    /// <summary>
    /// 只记回调次序的 SDK 回调。四个优先级各一个，写进 callbacks.log；闸不开（上传/编辑模式）
    /// 直接 return true，不取消任何人的构建。`int.MaxValue` 那个顺带收尾（解 Harmony、写状态）。
    /// </summary>
    internal static class AuditSdkCallbackGate
    {
        public static bool Handle(int order)
        {
            if (!AuditBuildCapture.GateOpen) return true;
            AuditBuildCapture.LogCallback(order);
            return true;
        }
    }

    public sealed class AuditSdkCallback11000 : IVRCSDKPreprocessAvatarCallback
    {
        public int callbackOrder { get { return -11000; } }
        public bool OnPreprocessAvatar(GameObject avatarGameObject) { return AuditSdkCallbackGate.Handle(-11000); }
    }

    public sealed class AuditSdkCallback10000 : IVRCSDKPreprocessAvatarCallback
    {
        public int callbackOrder { get { return -10000; } }
        public bool OnPreprocessAvatar(GameObject avatarGameObject) { return AuditSdkCallbackGate.Handle(-10000); }
    }

    public sealed class AuditSdkCallback1025 : IVRCSDKPreprocessAvatarCallback
    {
        public int callbackOrder { get { return -1025; } }
        public bool OnPreprocessAvatar(GameObject avatarGameObject) { return AuditSdkCallbackGate.Handle(-1025); }
    }

    public sealed class AuditSdkCallbackMax : IVRCSDKPreprocessAvatarCallback
    {
        public int callbackOrder { get { return int.MaxValue; } }
        public bool OnPreprocessAvatar(GameObject avatarGameObject)
        {
            // 闸在这里必须自己判：AuditSdkCallbackGate.Handle 的返回值是「是否继续构建」，
            // 永远是 true，不能拿它当「闸开了」用；否则编辑模式 / 上传也会写 build_status.json。
            if (!AuditBuildCapture.GateOpen) return true;
            AuditSdkCallbackGate.Handle(int.MaxValue);
            try
            {
                AuditHarmonyMA.Uninstall();
                // 收尾保证：任何没写的产物都落 available:false + reason_code，禁止静默缺席。
                AuditBuildCapture.EnsureArtifactReasons();
                AuditBuildCapture.MarkPhase("sdk_max", null);
                AuditBuildCapture.WriteStatus();
            }
            catch (Exception e)
            {
                Debug.LogError("[AvatarAudit/build] 收尾失败：" + e);
            }
            return true;
        }
    }

    #endregion
}
