// 【项目沉淀】
// 适用素体：无关（Unity 编辑器防卡死工具）。
// 用途：任务 BU —— 进 Play 时插件会弹「只有一个按钮」的模态框（2026-09-19 工程A 的
//   VRCFury 参数超限警告：ExceptionService.cs 只有 Ok），模态框挡住编辑器主线程，
//   UnityMCP 连续超时、审查请求跑不了，只能杀 Unity。本类把这类单按钮框改成
//   「写一行 Debug.LogWarning + 追加日志文件，然后当用户点了 OK 直接返回 true」。
// 生效条件：**只有**环境变量 AVATARAUDIT_SUPPRESS_DIALOGS=1 时才装补丁（Claude 启动 Unity 时带上）；
//   否则本类什么也不做，不影响正常弹框。
//
// 只拦三参数重载 EditorUtility.DisplayDialog(string title, string message, string ok)：
//   四参数（ok/cancel）、五六参数（DialogOptOut）**一律不拦**——它们要用户在「保存/不保存」这类
//   取舍里表态，机器替用户选会丢改动（例如退 Play / 退编辑器时的保存场景框）。
//
// Harmony 通过反射找 HarmonyLib.Harmony（0Harmony.dll 可能来自 VRCSDK，也可能来自 NDMF，
//   工程不一定有），找不到只 Debug.LogWarning、不影响编译；本文件不 `using HarmonyLib`，
//   也不在 asmdef 里新增任何引用。asmdef 里原有的 0Harmony.dll precompiledReference 与本文件无关
//   （那是 AuditHarmonyMA.cs 的编译期依赖）。
//
// 日志：<工程>/Library/AvatarAudit/suppressed_dialogs.log，每行一次屏蔽，带本地时间。
//   与 AuditRunner.ProjectRoot 同一算法（Application.dataPath 的父目录），这里内联以免依赖其它类。

using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEngine;

namespace AvatarAudit
{
    [UnityEditor.InitializeOnLoad]
    internal static class AuditDialogGuard
    {
        private const string EnvVarName = "AVATARAUDIT_SUPPRESS_DIALOGS";
        private const string HarmonyTypeName = "HarmonyLib.Harmony";
        private const string HarmonyMethodTypeName = "HarmonyLib.HarmonyMethod";
        private const string HarmonyId = "local.avatar-audit.dialog-guard";
        private const int MessageLimit = 500;

        private static readonly object _lock = new object();
        private static bool _installed;

        static AuditDialogGuard()
        {
            if (!IsEnabled()) return;
            try { Install(); }
            catch (Exception e)
            {
                Debug.LogWarning("[AvatarAudit] 屏蔽单按钮对话框安装失败（不影响编译与其它功能）：" + e);
            }
        }

        private static bool IsEnabled()
        {
            var v = Environment.GetEnvironmentVariable(EnvVarName);
            return string.Equals(v, "1", StringComparison.Ordinal);
        }

        private static void Install()
        {
            if (_installed) return;

            var harmonyType = FindType(HarmonyTypeName);
            if (harmonyType == null)
            {
                Debug.LogWarning("[AvatarAudit] 未找到 " + HarmonyTypeName
                    + "（VRCSDK / NDMF 的 0Harmony.dll 未加载？），本次不屏蔽单按钮对话框。");
                return;
            }

            var harmonyMethodType = FindType(HarmonyMethodTypeName);
            if (harmonyMethodType == null)
            {
                Debug.LogWarning("[AvatarAudit] 找到 Harmony 但没有 " + HarmonyMethodTypeName
                    + "，本次不屏蔽单按钮对话框。");
                return;
            }

            var displayDialog = FindSingleButtonDisplayDialog();
            if (displayDialog == null)
            {
                Debug.LogWarning("[AvatarAudit] 找不到 EditorUtility.DisplayDialog(string,string,string)，"
                    + "本次不屏蔽单按钮对话框。");
                return;
            }

            var prefix = typeof(AuditDialogGuard).GetMethod(nameof(Prefix),
                BindingFlags.Static | BindingFlags.NonPublic);
            if (prefix == null)
            {
                Debug.LogWarning("[AvatarAudit] 找不到前缀方法 " + nameof(Prefix) + "，本次不屏蔽单按钮对话框。");
                return;
            }

            var patch = ResolvePatchMethod(harmonyType, harmonyMethodType);
            if (patch == null)
            {
                Debug.LogWarning("[AvatarAudit] Harmony 版本不含可用的 Patch(MethodBase, HarmonyMethod...)，"
                    + "本次不屏蔽单按钮对话框。");
                return;
            }

            var harmony = Activator.CreateInstance(harmonyType, new object[] { HarmonyId });
            var harmonyPrefix = Activator.CreateInstance(harmonyMethodType, new object[] { prefix });

            var ps = patch.GetParameters();
            var args = new object[ps.Length];
            args[0] = displayDialog;
            args[1] = harmonyPrefix; // 其余（postfix / transpiler / finalizer / ilmanipulator）传 null
            patch.Invoke(harmony, args);

            _installed = true;
            Debug.Log("[AvatarAudit] 已启用单按钮对话框屏蔽（" + EnvVarName + "=1，id=" + HarmonyId + "）。");
        }

        /// <summary>
        /// 三参数 DisplayDialog 的前缀：记日志 → 跳过原方法 → 当用户点了 OK（返回 true）。
        /// 参数用 __0/__1 按位置绑定（不依赖 Unity 的参数名），__result 是原方法的 bool 返回值。
        /// </summary>
        private static bool Prefix(string __0, string __1, ref bool __result)
        {
            __result = true;
            var title = OneLine(__0);
            var message = Truncate(OneLine(__1), MessageLimit);
            // 两件事各自 try：任意一件失败都不影响「前缀返回 false」这个关键动作。
            try { Debug.LogWarning("[AvatarAudit] 已屏蔽对话框：" + title + " | " + message); }
            catch { }
            try { AppendLog(title, message); }
            catch { }
            return false; // 跳过原方法，不弹模态框
        }

        private static MethodInfo FindSingleButtonDisplayDialog()
        {
            return typeof(UnityEditor.EditorUtility).GetMethod(
                "DisplayDialog",
                BindingFlags.Public | BindingFlags.Static,
                null,
                new[] { typeof(string), typeof(string), typeof(string) },
                null);
        }

        /// <summary>在所有已加载程序集里找类型；再退回按常见程序集名显式加载（0Harmony / HarmonyLib）。</summary>
        private static Type FindType(string fullName)
        {
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    var t = asm.GetType(fullName, false);
                    if (t != null) return t;
                }
                catch { }
            }
            foreach (var asmName in new[] { "0Harmony", "HarmonyLib", "Harmony" })
            {
                try
                {
                    var t = Assembly.Load(asmName).GetType(fullName, false);
                    if (t != null) return t;
                }
                catch { }
            }
            return null;
        }

        /// <summary>
        /// 从 Harmony 的 Patch 重载里挑一个：第一个参数是 MethodBase、其余全是 HarmonyMethod，
        /// 参数最少者优先（兼容不同 Harmony 2.x 版本，不必知道 ilmanipulator 是否存在）。
        /// </summary>
        private static MethodInfo ResolvePatchMethod(Type harmonyType, Type harmonyMethodType)
        {
            MethodInfo best = null;
            foreach (var m in harmonyType.GetMethods(BindingFlags.Public | BindingFlags.Instance))
            {
                if (m.Name != "Patch") continue;
                var ps = m.GetParameters();
                if (ps.Length < 2) continue;
                if (!typeof(MethodBase).IsAssignableFrom(ps[0].ParameterType)) continue;

                var allHarmonyMethod = true;
                for (var i = 1; i < ps.Length; i++)
                {
                    if (!harmonyMethodType.IsAssignableFrom(ps[i].ParameterType)) { allHarmonyMethod = false; break; }
                }
                if (!allHarmonyMethod) continue;

                if (best == null || ps.Length < best.GetParameters().Length) best = m;
            }
            return best;
        }

        private static string ProjectRoot()
        {
            try
            {
                var parent = Directory.GetParent(Application.dataPath);
                return parent == null ? null : parent.FullName;
            }
            catch
            {
                return null;
            }
        }

        private static void AppendLog(string title, string message)
        {
            var root = ProjectRoot();
            if (string.IsNullOrEmpty(root)) return;

            var dir = Path.Combine(root, "Library", "AvatarAudit");
            Directory.CreateDirectory(dir);
            var line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                + "\t" + title + "\t" + message + Environment.NewLine;
            lock (_lock)
            {
                File.AppendAllText(Path.Combine(dir, "suppressed_dialogs.log"), line, new UTF8Encoding(false));
            }
        }

        private static string OneLine(string s)
        {
            if (string.IsNullOrEmpty(s)) return string.Empty;
            return s.Replace("\r\n", " ").Replace('\r', ' ').Replace('\n', ' ').Trim();
        }

        private static string Truncate(string s, int limit)
        {
            if (string.IsNullOrEmpty(s) || s.Length <= limit) return s;
            return s.Substring(0, limit) + "...";
        }
    }
}
