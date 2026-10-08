// 【项目沉淀】
// 适用素体：无关（Unity 编辑器构建期截获工具）。
// 用途：T-12 —— 用 Harmony Postfix 钩 MA 自己的 `ReactiveObjectAnalyzer.Analyze`，
//   只在它真的带 BuildContext 跑时（`_context != null`）序列化写者图 → ma_analysis.json。
//
// 为什么不 fork MA：03 Q7 定「不 fork」——`Analyze` 是 internal，Harmony `AccessTools` 能直接钩，
//   结果用反射序列化；asmdef versionDefines 按 MA 精确版本 `[1.18.1]`（方括号=精确匹配；
//   裸版本号 `1.18.1` 在 Unity 里是 ≥1.18.1，见 2022.3 手册）定义 AUDIT_MA_1_18_1，版本不符就编成
//   退路（只写 {"available": false}）。同版本下 `ReactiveObjectAnalyzer/AnalysisResult/ReactionRule/
//   ControlCondition/AnimatedProperty` 五个类型名与字段以 MA 1.18.1 源码为准：
//   `Editor/ReactiveObjects/AnimationGeneration/{ReactiveObjectAnalyzer,ReactionRule,ControlCondition,
//   AnimatedProperty,TargetProp}.cs`。
//
// 为什么不重跑一次 Analyze 来取结果：F14 —— Analyze 会经 GetActiveSelfProxy 往所有控制器加
//   `__MA/ActiveSelfProxy/...` 参数，审查代码调第二次就会污染构建。只能接住 MA 那一次调用的返回值。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEngine;
using Object = UnityEngine.Object;

#if AUDIT_MA_1_18_1
using HarmonyLib;
#endif

namespace AvatarAudit
{
#if AUDIT_MA_1_18_1

    internal static class AuditHarmonyMA
    {
        private const string HarmonyId = "local.avatar-audit.ma";
        private const string AnalyzerTypeName = "nadena.dev.modular_avatar.core.editor.ReactiveObjectAnalyzer";

        private static Harmony _harmony;
        private static int _callIndex;
        private static bool _playModeHandlerInstalled;

        public static void Install()
        {
            if (_harmony != null)
            {
                // 上一次 Play 的补丁还没解（例如 pass B / Max 回调没跑到）：本类型仍算「已装」，
                // 否则 build_status 会把 harmony_installed 误报成 false（CB 排查要求原因可信）。
                AuditBuildCapture.HarmonyInstalled = true;
                AuditBuildCapture.Note("Harmony 已有活动补丁（沿用 id=" + HarmonyId + "），本次不重复 Patch");
                return;
            }
            AuditBuildCapture.HarmonyInstalled = false;

            var type = AccessTools.TypeByName(AnalyzerTypeName);
            if (type == null)
            {
                WriteUnavailable("找不到类型 " + AnalyzerTypeName + "（MA 程序集未加载？）");
                return;
            }

            var method = AccessTools.Method(type, "Analyze", new[] { typeof(GameObject) });
            if (method == null)
            {
                WriteUnavailable("找不到 " + AnalyzerTypeName + ".Analyze(GameObject)");
                return;
            }

            try
            {
                _harmony = new Harmony(HarmonyId);
                var postfix = new HarmonyMethod(AccessTools.Method(typeof(AuditHarmonyMA), nameof(Postfix)));
                _harmony.Patch(method, postfix: postfix);
                AuditBuildCapture.HarmonyInstalled = true;
                AuditBuildCapture.Note("Harmony 已钩 " + method.DeclaringType.FullName + ".Analyze（id=" + HarmonyId + "）");

                // 兜底：构建中途失败（pass B / int.MaxValue 回调没跑到）时，退 Play 也要解钩，
                // 否则关闭了域重载的会话会把补丁带到下一次 Play。
                if (!_playModeHandlerInstalled)
                {
                    _playModeHandlerInstalled = true;
                    UnityEditor.EditorApplication.playModeStateChanged += OnPlayModeChanged;
                }
            }
            catch (Exception e)
            {
                _harmony = null;
                WriteUnavailable("Harmony Patch 失败：" + e.Message);
            }
        }

        private static void OnPlayModeChanged(UnityEditor.PlayModeStateChange change)
        {
            if (change == UnityEditor.PlayModeStateChange.ExitingPlayMode) Uninstall();
        }

        public static void Uninstall()
        {
            if (_harmony == null) return;
            try { _harmony.UnpatchAll(HarmonyId); }
            catch (Exception e) { Debug.LogWarning("[AvatarAudit/build] Harmony UnpatchAll 失败：" + e.Message); }
            _harmony = null;
        }

        // Harmony 支持把值类型返回值装箱进 object __result（本轮已用真实 0Harmony.dll 离线验证）。
        private static void Postfix(object __instance, GameObject root, object __result)
        {
            if (!AuditBuildCapture.GateOpen) return;
            if (__result == null) return;
            try { Capture(__instance, root, __result); }
            catch (Exception e) { Debug.LogError("[AvatarAudit/build] 截获 MA 分析结果失败：" + e); }
        }

        private static void Capture(object instance, GameObject root, object result)
        {
            // 只认构建那一次调用（`_context != null`）；ComputeContext 路径（预览/内省）不要。
            var instanceType = instance.GetType();
            var contextField = AccessTools.Field(instanceType, "_context");
            if (contextField == null || contextField.GetValue(instance) == null) return;

            // 只认本工程正在审的头像根。
            if (AuditBuildCapture.AvatarRoot == null) return;
            if (root == null || root != AuditBuildCapture.AvatarRoot) return;

            var resultType = result.GetType();
            var shapesField = resultType.GetField("Shapes", BindingFlags.Public | BindingFlags.Instance);
            var initialField = resultType.GetField("InitialStates", BindingFlags.Public | BindingFlags.Instance);
            var shapes = shapesField == null ? null : shapesField.GetValue(result) as IDictionary;
            var initialStates = initialField == null ? null : initialField.GetValue(result) as IDictionary;

            _callIndex++;

            var shapeList = new List<object>();
            var ruleList = new List<object>();
            if (shapes != null)
            {
                foreach (DictionaryEntry kv in shapes)
                {
                    var shapeNode = SerializeShape(kv.Key, kv.Value, ruleList);
                    if (shapeNode != null) shapeList.Add(shapeNode);
                }
            }

            var initList = new List<object>();
            if (initialStates != null)
            {
                foreach (DictionaryEntry kv in initialStates)
                {
                    var node = new JsonObject();
                    FillTarget(node, kv.Key);
                    node.Set("initial_value", ValueToJson(kv.Value));
                    initList.Add(node);
                }
            }

            var doc = new JsonObject();
            doc.Set("tool", AuditBuildCapture.ToolName);
            doc.Set("tool_version", AuditBuildCapture.ToolVersion(typeof(AuditBuildPlugin)));
            doc.Set("phase", "ma_analysis");
            doc.Set("available", true);
            doc.Set("analyzer", AnalyzerTypeName);
            doc.Set("harmony_id", HarmonyId);
            doc.Set("call_index", _callIndex);
            doc.Set("avatar_root", root == null ? null : root.name);
            doc.Set("shapes_count", shapeList.Count);
            doc.Set("rules_total", ruleList.Count);
            doc.Set("shapes", shapeList);
            doc.Set("rules", ruleList);
            doc.Set("initial_states", initList);
            AuditBuildCapture.Write("ma_analysis.json", doc);
            AuditBuildCapture.MaWritten = true;
            AuditBuildCapture.Note("ma_analysis.json: " + shapeList.Count + " 个属性 / " + ruleList.Count + " 条 rule");
        }

        private static JsonObject SerializeShape(object key, object value, List<object> ruleList)
        {
            if (key == null || value == null) return null;
            var node = new JsonObject();
            FillTarget(node, key);
            node.Set("current_state", ValueToJson(GetMember(value, "currentState")));
            node.Set("override_static_state", ValueToJson(GetMember(value, "overrideStaticState")));

            var groups = GetMember(value, "actionGroups") as IEnumerable;
            var rules = new List<object>();
            if (groups != null)
            {
                foreach (var g in groups)
                {
                    if (g == null) continue;
                    var rule = SerializeRule(g);
                    rules.Add(rule);
                    ruleList.Add(rule);
                }
            }
            node.Set("rules_count", rules.Count);
            node.Set("rules", rules);
            return node;
        }

        private static JsonObject SerializeRule(object rule)
        {
            var node = new JsonObject();
            node.Set("value", ValueToJson(GetMember(rule, "Value")));
            node.Set("inverted", BoolMember(rule, "Inverted"));
            node.Set("initially_active", BoolMember(rule, "InitiallyActive"));
            node.Set("is_constant", BoolMember(rule, "IsConstant"));
            node.Set("controlling_object", ObjectToPath(GetMember(rule, "ControllingObject")));

            var conds = new List<object>();
            var list = GetMember(rule, "ControllingConditions") as IEnumerable;
            if (list != null)
            {
                foreach (var c in list)
                {
                    if (c == null) continue;
                    var cn = new JsonObject();
                    cn.Set("parameter", AsString(GetMember(c, "Parameter")));
                    cn.Set("lo", ToDouble(GetMember(c, "ParameterValueLo")));
                    cn.Set("hi", ToDouble(GetMember(c, "ParameterValueHi")));
                    cn.Set("initial_value", ToDouble(GetMember(c, "InitialValue")));
                    cn.Set("initially_active", BoolMember(c, "InitiallyActive"));
                    cn.Set("is_constant", BoolMember(c, "IsConstant"));
                    cn.Set("reference_object", ObjectToPath(GetMember(c, "ReferenceObject")));
                    cn.Set("debug_name", AsString(GetMember(c, "DebugName")));
                    conds.Add(cn);
                }
            }
            node.Set("conditions", conds);
            return node;
        }

        // ---- 反射小工具 ----

        private static object GetMember(object obj, string name)
        {
            if (obj == null) return null;
            var t = obj.GetType();
            var f = t.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (f != null) return f.GetValue(obj);
            var p = t.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (p != null && p.CanRead) return p.GetValue(obj, null);
            return null;
        }

        private static bool BoolMember(object obj, string name)
        {
            var v = GetMember(obj, name);
            if (v is bool) return (bool)v;
            return false;
        }

        private static void FillTarget(JsonObject node, object targetProp)
        {
            if (targetProp == null) return;
            var obj = GetMember(targetProp, "TargetObject");
            var prop = AsString(GetMember(targetProp, "PropertyName"));
            node.Set("target_object", ObjectToPath(obj));
            node.Set("target_object_name", obj is Object ? ((Object)obj).name : null);
            node.Set("target_kind", obj == null ? null : obj.GetType().Name);
            node.Set("property", prop);
            node.Set("target_property", prop);
        }

        private static string ObjectToPath(object obj)
        {
            if (obj == null) return null;
            var uo = obj as Object;
            if (uo == null) return obj.ToString();
            try
            {
                if (uo is GameObject)
                {
                    var go = (GameObject)uo;
                    return AuditUtil.ScenePath(go.transform);
                }
                var c = uo as Component;
                if (c != null) return AuditUtil.ScenePath(c.transform);
            }
            catch { }
            try
            {
                var assetPath = UnityEditor.AssetDatabase.GetAssetPath(uo);
                if (!string.IsNullOrEmpty(assetPath)) return assetPath;
            }
            catch { }
            return uo.name;
        }

        private static string AsString(object v)
        {
            return v == null ? null : Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        private static object ValueToJson(object v)
        {
            if (v == null) return null;
            if (v is float) return (double)(float)v;
            if (v is double) return v;
            if (v is int) return (double)(int)v;
            if (v is bool) return v;
            if (v is string) return v;
            if (v is Object) return ObjectToPath(v);
            return v.ToString();
        }

        private static double ToDouble(object v)
        {
            if (v == null) return 0d;
            if (v is float) return (float)v;
            if (v is double) return (double)v;
            if (v is int) return (int)v;
            double d;
            if (double.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), NumberStyles.Float,
                    CultureInfo.InvariantCulture, out d)) return d;
            return 0d;
        }

        private static void WriteUnavailable(string reason)
        {
            var doc = new JsonObject();
            doc.Set("tool", AuditBuildCapture.ToolName);
            doc.Set("tool_version", AuditBuildCapture.ToolVersion(typeof(AuditBuildPlugin)));
            doc.Set("phase", "ma_analysis");
            doc.Set("available", false);
            doc.Set("reason_code", "harmony_unavailable");
            doc.Set("reason", reason);
            doc.Set("analyzer", AnalyzerTypeName);
            AuditBuildCapture.Write("ma_analysis.json", doc);
            AuditBuildCapture.MaWritten = true;
            AuditBuildCapture.Note("ma_analysis.json：截获不可用（" + reason + "）");
        }
    }

#else

    /// <summary>MA 版本宏不匹配（非 1.18.1 系）时的退路：只写 available=false。</summary>
    internal static class AuditHarmonyMA
    {
        public static void Install()
        {
            AuditBuildCapture.HarmonyInstalled = false;
            var doc = new JsonObject();
            doc.Set("tool", AuditBuildCapture.ToolName);
            doc.Set("tool_version", AuditBuildCapture.ToolVersion(typeof(AuditBuildPlugin)));
            doc.Set("phase", "ma_analysis");
            doc.Set("available", false);
            doc.Set("reason_code", "harmony_unavailable");
            doc.Set("reason", "本工程未定义 AUDIT_MA_1_18_1（MA 版本不是 1.18.1 系）");
            AuditBuildCapture.Write("ma_analysis.json", doc);
            AuditBuildCapture.MaWritten = true;
        }

        public static void Uninstall() { }
    }

#endif
}
