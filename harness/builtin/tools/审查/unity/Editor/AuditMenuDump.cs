// ══════════════════════════════════════════════════════════════════
// 【项目沉淀】通用工具 · 客户单审查 T4「构建后最终菜单树与参数导出」
// 适用素体：任意装了 VRChat SDK3 的头像（Unity 2022.3 / VRChat 3.x）
// 相关素材：无
// 工具链　：Unity 2022.3.22f1 Editor 程序集 + UnityEngine；VRChat SDK 类型**全部走反射**，
// 　　　　　不直接 using / 不引用 VRCSDK3A.dll（理由见下）。
// 可复用性：★★★ 换单子直接复制到 <工程>/Assets/Editor/AvatarAudit/
//
// 用途：Play 模式下 NDMF「Apply on Play」构建完成之后，头像的
//   VRCAvatarDescriptor.expressionsMenu / expressionParameters 才是**最终**的
//   （Modular Avatar 的 MenuItem / MenuInstaller 在构建期注入，编辑期根本看不到）。
//   本工具把「最终菜单树 + 每个控件的参数与取值 + 每个参数的菜单取值集合 + 哪些参数没声明」
//   导出成机器可读的 menu_tree.json / params.json 和人读的 menu_tree.md，
//   供 T1 状态驱动器按菜单组合设参数（设计文档 T4 的第一条）。
//
// ── 与 AuditIO.cs 的接口（本文件实现 IAuditTool，由 AuditIO 分派）────────────
// 静态入口：public static IAuditTool AuditMenuDump.Create()
// AuditIO.StartFromJson 分派链里加的一行（**由 Claude 加，本任务不改 AuditIO.cs**）：
//     else if (toolId == "menu") tool = AuditMenuDump.Create();
// 本类实现：
//     public sealed class AuditMenuDump : IAuditTool
//     string ToolId                { get { return "menu"; } }
//     bool   RequiresPlayMode      { get { return true; } }   // 构建后的菜单只在 Play 里存在
//     int    DefaultTimeoutSeconds { get { return 300; } }
//     void   Begin(AuditContext ctx)          // 解析请求 + 软解析头像（失败不抛，记 warning）
//     bool   Tick()                           // 等 warmup_frames 帧 → 一次性读盘并写 3 个输出 → 完成
//     void   Cleanup()                        // 只读工具，无临时改动，幂等空操作
//   请求：{"tool":"menu","avatar":"<头像根名>","out":"/abs/path"}
//   输出：<ctx.OutDir>/menu_tree.json、params.json、menu_tree.md；进度写 status.json
//
// 为什么用 warmup_frames 而不是 Begin 里立刻读：
//   NDMF 的 Apply on Play 在 AvatarActivator.Awake（DefaultExecutionOrder -9995）里跑
//   （nadena.dev.ndmf/Runtime/ApplyOnPlayGlobalActivator.cs:186-191），
//   AuditIO 又可能在 EnteredPlayMode 回调里就 Begin。等默认 10 帧再读，是最省事、最稳的
//   「构建已完成」保证；请求字段 warmup_frames 可调。
//
// 为什么所有 SDK 类型走反射：
//   这工具要复制进多个工程，SDK 版本/是否装了 MA/VRCFury 都可能不同。直接引用会让某个工程
//   编译失败，连不相关的工程都跑不了；反射失败只是降级——把「读不到 / 字段缺失」写进
//   status 与输出 warnings，文件照写，而不是整个工具不可用。
//
// 反射符号出处（VRChat SDK3，本机 `Packages/com.vrchat.avatars/`，2026-09-18 核对）：
//   · VRC.SDK3.Avatars.Components.VRCAvatarDescriptor
//       expressionsMenu / expressionParameters / baseAnimationLayers
//   · VRC.SDK3.Avatars.Components.VRCAvatarDescriptor+CustomAnimLayer
//       type（AnimLayerType）/ isDefault / animatorController（RuntimeAnimatorController）
//   · VRC.SDK3.Avatars.ScriptableObjects.VRCExpressionsMenu
//       controls（List<Control>）
//   · VRCExpressionsMenu+Control：name / type（ControlType）/ parameter（Parameter）/ value /
//       subParameters（Parameter[]）/ labels（Label[]）/ subMenu（VRCExpressionsMenu）
//   · VRCExpressionsMenu+Control+Parameter：name（只有 name，取值在 Control.value）
//   · VRCExpressionParameters：parameters（Parameter[]）
//   · VRCExpressionParameters+Parameter：name / valueType（ValueType）/ defaultValue / saved / networkSynced
//   · ControlType：Button=101 / Toggle=102 / SubMenu=103 / TwoAxisPuppet=201 /
//       FourAxisPuppet=202 / RadialPuppet=203（本文件不硬编码：用 FieldType 反射枚举再 ToString）
//   · ValueType：Int=0 / Float=1 / Bool=2
//   · AnimatorController.parameters（UnityEditor.Animations）→ AnimatorControllerParameter[]
// 编辑器里核对过的语义（ExpressionsControlOptions.cs:200-370）：
//   - Button/Toggle：取 Control.value（该控件的 parameter 被设成这个值）；Bool 参数取值恒为 1。
//   - RadialPuppet：subParameters[0].name 是要驱动的参数，运行时 0..1 连续。
//   - TwoAxisPuppet：subParameters[0]=水平、[1]=垂直；FourAxisPuppet：[0]=上 [1]=右 [2]=下 [3]=左。
//   - SubMenu：subMenu 指向子菜单；不驱动参数。
//
// 设计取舍：
//   · 只读，不改场景：不改参数、不改 Animator、不建临时物，所以 Cleanup 是空操作。
//   · 「菜单取值集合」既给 menu_values（菜单里真实出现过的离散值、去重排序），
//     也给 suggested_values（给 T1 选组合的建议值：Bool 补 0、Radial 补 0/0.25/0.5/0.75/1
//     与按 labels 数量推算的档位、TwoAxis/FourAxis 补 -1/-0.5/0/0.5/1）。两者都写出来，
//     免得 Claude 把「建议值」当成「菜单里真的这么写」。
//   · 防环：按 UnityEngine.Object 的实例 ID 去重（子菜单被两个控件共享时第二次跳过并记 warning）。
//   · 拿不到 SDK 类型/字段 → 不抛，写 warnings + status，照写文件（空树 / 空参数表）。
// ══════════════════════════════════════════════════════════════════

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace AvatarAudit
{
    public sealed class AuditMenuDump : IAuditTool
    {
        // ---------------------------------------------------------------- 接口

        public string ToolId { get { return "menu"; } }
        public bool RequiresPlayMode { get { return true; } }
        public int DefaultTimeoutSeconds { get { return 300; } }

        /// <summary>静态入口（文件头注释里写的签名）：AuditIO 分派链用它建实例。</summary>
        public static IAuditTool Create() { return new AuditMenuDump(); }

        // ---------------------------------------------------------------- 反射工具

        private const BindingFlags AnyInstance =
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        /// <summary>找字段（沿基类链）；找不到返回 null。</summary>
        private static FieldInfo FindField(Type t, string name)
        {
            while (t != null)
            {
                var f = t.GetField(name, AnyInstance);
                if (f != null) return f;
                t = t.BaseType;
            }
            return null;
        }

        /// <summary>找属性（沿基类链）；找不到返回 null。</summary>
        private static PropertyInfo FindProperty(Type t, string name)
        {
            while (t != null)
            {
                var p = t.GetProperty(name, AnyInstance);
                if (p != null) return p;
                t = t.BaseType;
            }
            return null;
        }

        /// <summary>读字段或属性。返回 false = 成员不存在（区别于「成员存在但值为 null」）。</summary>
        private static bool TryMember(object obj, string name, out object value)
        {
            value = null;
            if (obj == null) return false;
            var t = obj.GetType();

            var f = FindField(t, name);
            if (f != null) { value = f.GetValue(obj); return true; }

            var p = FindProperty(t, name);
            if (p != null && p.GetIndexParameters().Length == 0)
            {
                value = p.GetValue(obj, null);
                return true;
            }
            return false;
        }

        private static object Member(object obj, string name)
        {
            object v;
            return TryMember(obj, name, out v) ? v : null;
        }

        private static string GetString(object obj, string name)
        {
            object v;
            if (!TryMember(obj, name, out v) || v == null) return null;
            return v as string;
        }

        private static double GetDouble(object obj, string name, double def)
        {
            object v;
            if (!TryMember(obj, name, out v) || v == null) return def;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); }
            catch { return def; }
        }

        private static bool GetBool(object obj, string name, bool def)
        {
            object v;
            if (!TryMember(obj, name, out v) || v == null) return def;
            if (v is bool) return (bool)v;
            try { return Convert.ToBoolean(v, CultureInfo.InvariantCulture); }
            catch { return def; }
        }

        /// <summary>枚举 → 成员名（如 "Toggle" / "Bool" / "FX"）；非枚举返回 null。</summary>
        private static string EnumName(object enumValue)
        {
            return enumValue == null ? null : enumValue.ToString();
        }

        /// <summary>枚举 → 整数值；失败返回 -1。</summary>
        private static int EnumInt(object enumValue)
        {
            if (enumValue == null) return -1;
            try { return Convert.ToInt32(enumValue, CultureInfo.InvariantCulture); }
            catch { return -1; }
        }

        /// <summary>数组 / List / IEnumerable → List&lt;object&gt;（string 不当集合拆）。</summary>
        private static List<object> AsList(object v)
        {
            var list = new List<object>();
            if (v == null) return list;

            var arr = v as Array;
            if (arr != null) { foreach (var o in arr) list.Add(o); return list; }

            var il = v as IList;
            if (il != null) { foreach (var o in il) list.Add(o); return list; }

            var en = v as IEnumerable;
            if (en != null && !(v is string))
                foreach (var o in en) list.Add(o);
            return list;
        }

        /// <summary>UnityEngine.Object 的实例 ID；非 Unity 对象返回 0。</summary>
        private static int InstanceId(object o)
        {
            var uo = o as UnityEngine.Object;
            return uo == null ? 0 : uo.GetInstanceID();
        }

        /// <summary>数字展示：去掉浮点噪声尾巴，Int 类型显示为整数。</summary>
        private static string NumStr(double d)
        {
            return d.ToString("0.######", CultureInfo.InvariantCulture);
        }

        /// <summary>把 -0 归成 0，并抹掉 float 噪声（用于去重）。</summary>
        private static double Clean(double d)
        {
            var r = Math.Round(d, 6);
            if (r == 0.0) return 0.0;
            return r;
        }

        /// <summary>VRChat / GestureManager 内置参数名（判定 params_not_in_menu 时给个 likely_builtin 标记）。</summary>
        private static readonly HashSet<string> BuiltinParams = new HashSet<string>(StringComparer.Ordinal)
        {
            "GestureRightWeight", "ScaleFactorInverse", "EyeHeightAsPercent", "EyeHeightAsMeters",
            "GestureLeftWeight", "VelocityMagnitude", "IsAnimatorEnabled", "IsOnFriendsList",
            "VRCFaceBlendH", "VRCFaceBlendV", "ScaleModified", "AvatarVersion", "TrackingType",
            "GestureRight", "ScaleFactor", "GestureLeft", "PreviewMode", "VelocityX", "VelocityY",
            "VelocityZ", "InStation", "AngularY", "Earmuffs", "Grounded", "MuteSelf", "VRCEmote",
            "Upright", "IsLocal", "Seated", "VRMode", "Voice", "Viseme", "AFK"
        };

        // ---------------------------------------------------------------- 中间数据结构

        private enum Phase { Warmup, Done }

        private sealed class ControlRec
        {
            public string Name;
            public string Path;
            public string TypeName;
            public int TypeInt = -1;
            public string ParameterName;
            public double Value;
            public readonly List<string> SubParameterNames = new List<string>();
            public readonly List<string> Labels = new List<string>();
            public readonly List<ControlRec> Children = new List<ControlRec>();
        }

        private sealed class ParamDecl
        {
            public string Name;
            public string TypeName;
            public int TypeInt = -1;
            public double DefaultValue;
            public bool Saved;
            public bool NetworkSynced;
        }

        private sealed class ParamAgg
        {
            public string Name;
            public bool Declared;
            public string DeclaredTypeName;
            public int DeclaredTypeInt = -1;
            public double DefaultValue;
            public bool Saved;
            public bool NetworkSynced;

            public readonly List<double> MenuValues = new List<double>();
            public readonly List<string> ValueKinds = new List<string>();
            public readonly List<string> ReferencedBy = new List<string>();
            public bool RadialSeen;
            public bool AxisSeen;
            public readonly List<string> RadialLabels = new List<string>();
            public readonly List<double> RadialLabelDerived = new List<double>();
        }

        private sealed class CtrlParamInfo
        {
            public string Name;
            public string TypeName;
            public int TypeInt = -1;
        }

        private sealed class LayerRec
        {
            public int Index;
            public string TypeName;
            public int TypeInt = -1;
            public bool IsDefault;
            public string ControllerName;
            public string ControllerType;
            public readonly List<CtrlParamInfo> Parameters = new List<CtrlParamInfo>();
        }

        // ---------------------------------------------------------------- 实例字段

        private AuditContext _ctx;
        private GameObject _avatar;
        private string _resolveError;

        private Phase _phase = Phase.Warmup;
        private int _targetFrame;
        private int _warmupFrames = 10;
        private int _maxDepth = 20;
        private int _maxControls = 5000;
        private string _rootLabel = "顶层";

        private int _controlCount;
        private bool _truncatedWarned;

        private readonly List<ControlRec> _rootControls = new List<ControlRec>();
        private readonly List<ControlRec> _flatControls = new List<ControlRec>();
        private readonly List<ParamDecl> _declared = new List<ParamDecl>();
        private readonly List<LayerRec> _layers = new List<LayerRec>();
        private readonly Dictionary<string, ParamAgg> _aggs = new Dictionary<string, ParamAgg>(StringComparer.Ordinal);
        private readonly List<string> _aggOrder = new List<string>();

        private JsonObject _descriptorJson;
        private string _menuTypeName;
        private string _paramsTypeName;
        private bool _menuRead;
        private bool _paramsRead;
        private bool _layersRead;

        // ================================================================ Begin

        public void Begin(AuditContext ctx)
        {
            _ctx = ctx;
            _warmupFrames = Mathf.Max(0, ctx.I("warmup_frames", 10));
            _maxDepth = Mathf.Max(1, ctx.I("max_depth", 20));
            _maxControls = Mathf.Max(1, ctx.I("max_controls", 5000));
            var rl = ctx.S("root_label");
            if (!string.IsNullOrEmpty(rl)) _rootLabel = rl;

            // 软解析：这里失败不抛（真正的错误在 DoDump 里变成 warnings + 空输出的文件）。
            try
            {
                _avatar = AuditAvatar.Resolve(ctx.S("avatar"));
                ctx.Avatar = _avatar;
            }
            catch (Exception e)
            {
                _resolveError = AuditUtil.Unwrap(e).Message;
                ctx.Warn("Begin 阶段解析头像失败（warmup 后会再试一次）：" + _resolveError);
            }

            _targetFrame = Time.frameCount + _warmupFrames;
            _phase = Phase.Warmup;

            ctx.Status.Log("T4 起始：请求头像=" + (ctx.S("avatar") ?? "<空>")
                + "，已解析=" + (_avatar != null ? _avatar.name : "<尚未>")
                + "，warmup=" + _warmupFrames + " 帧，play=" + EditorApplication.isPlaying);
        }

        // ================================================================ Tick

        public bool Tick()
        {
            switch (_phase)
            {
                case Phase.Warmup:
                    if (Time.frameCount >= _targetFrame)
                    {
                        DoDump();
                        _phase = Phase.Done;
                    }
                    return false;

                case Phase.Done:
                    return true;

                default:
                    return true;
            }
        }

        /// <summary>只读工具：没有临时改动要恢复（幂等）。</summary>
        public void Cleanup() { }

        // ================================================================ 主流程

        private void DoDump()
        {
            _ctx.Status.Running("20%", "读构建后的 descriptor / 菜单 / 参数 / 动画层");

            // warmup 后再解析一次：NDMF 可能在进 Play 的瞬间克隆/改名，等构建稳定再取。
            if (_avatar == null)
            {
                try
                {
                    _avatar = AuditAvatar.Resolve(_ctx.S("avatar"));
                    _ctx.Avatar = _avatar;
                }
                catch (Exception e)
                {
                    _ctx.Warn("解析头像失败：" + AuditUtil.Unwrap(e).Message);
                }
            }

            _descriptorJson = new JsonObject();
            _descriptorJson.Set("found", false);
            if (_avatar != null)
            {
                var desc = AuditAvatar.FindDescriptor(_avatar);
                if (desc == null)
                {
                    _ctx.Warn("头像 '" + _avatar.name + "' 上找不到 VRCAvatarDescriptor（VRC.SDK3 或 VRC.SDKBase），菜单/参数/动画层都读不到。");
                }
                else
                {
                    ReadDescriptor(desc);
                }
            }

            Aggregate();
            _ctx.Status.Running("80%", "写 menu_tree.json / params.json / menu_tree.md");
            WriteOutputs();
        }

        // ---------------------------------------------------------------- descriptor

        private void ReadDescriptor(Component desc)
        {
            _descriptorJson.Set("type", desc.GetType().FullName);
            _descriptorJson.Set("found", true);

            // ---- expressionsMenu ----
            object menuObj;
            if (!TryMember(desc, "expressionsMenu", out menuObj))
            {
                _ctx.Warn("descriptor 上读不到字段 expressionsMenu（SDK 版本不符？）");
            }
            else if (menuObj == null)
            {
                _ctx.Warn("descriptor.expressionsMenu 为空：这个头像没有表情菜单（或构建没有产出菜单）。");
            }
            else
            {
                _menuTypeName = menuObj.GetType().FullName;
                var visited = new HashSet<int>();
                try
                {
                    WalkMenu(menuObj, _rootLabel, 0, visited, _rootControls);
                    _menuRead = true;
                }
                catch (Exception e)
                {
                    _ctx.Warn("遍历菜单时出错（已保留读到的部分）：" + AuditUtil.Unwrap(e).Message);
                }
            }

            // ---- expressionParameters ----
            object epObj;
            if (!TryMember(desc, "expressionParameters", out epObj))
            {
                _ctx.Warn("descriptor 上读不到字段 expressionParameters（SDK 版本不符？）");
            }
            else if (epObj == null)
            {
                _ctx.Warn("descriptor.expressionParameters 为空：参数表读不到，菜单参数无法判定是否声明。");
            }
            else
            {
                _paramsTypeName = epObj.GetType().FullName;
                try
                {
                    ReadDeclaredParams(epObj);
                    _paramsRead = true;
                }
                catch (Exception e)
                {
                    _ctx.Warn("读 expressionParameters 时出错（已保留读到的部分）：" + AuditUtil.Unwrap(e).Message);
                }
            }

            // ---- baseAnimationLayers（控制器参数） ----
            object layersObj;
            if (!TryMember(desc, "baseAnimationLayers", out layersObj))
            {
                _ctx.Warn("descriptor 上读不到字段 baseAnimationLayers（SDK 版本不符？）；params_not_in_menu 无法计算。");
            }
            else
            {
                try
                {
                    ReadAnimLayers(layersObj);
                    _layersRead = true;
                }
                catch (Exception e)
                {
                    _ctx.Warn("读 baseAnimationLayers 时出错（已保留读到的部分）：" + AuditUtil.Unwrap(e).Message);
                }
            }
        }

        // ---------------------------------------------------------------- 菜单递归

        private void WalkMenu(object menu, string menuPath, int depth, HashSet<int> visited, List<ControlRec> into)
        {
            if (menu == null) return;

            if (depth > _maxDepth)
            {
                _ctx.Warn("菜单递归超过 max_depth=" + _maxDepth + "，在 " + menuPath + " 停止。");
                return;
            }

            int id = InstanceId(menu);
            if (id != 0 && !visited.Add(id))
            {
                _ctx.Warn("菜单里检测到环或共享子菜单，在 " + menuPath + " 处停止递归（实例 ID " + id + "）。"
                    + "同一子菜单资产被多个控件引用时也会走到这里，第二次的路径不会出现在输出里。");
                return;
            }

            object controlsObj;
            if (!TryMember(menu, "controls", out controlsObj))
            {
                _ctx.Warn("菜单 " + menuPath + " 上读不到字段 controls（SDK 版本不符？）。");
                return;
            }

            foreach (var c in AsList(controlsObj))
            {
                if (c == null) continue;
                if (_controlCount >= _maxControls)
                {
                    if (!_truncatedWarned)
                    {
                        _truncatedWarned = true;
                        _ctx.Warn("控件总数超过 max_controls=" + _maxControls + "，后续控件不再写入。");
                    }
                    return;
                }

                var rec = ReadControl(c, menuPath);
                if (rec == null) continue;
                _controlCount++;
                into.Add(rec);
                _flatControls.Add(rec);

                if (string.Equals(rec.TypeName, "SubMenu", StringComparison.Ordinal))
                {
                    object sub;
                    if (TryMember(c, "subMenu", out sub) && sub != null)
                    {
                        WalkMenu(sub, rec.Path, depth + 1, visited, rec.Children);
                    }
                    else
                    {
                        _ctx.Warn("SubMenu 控件 '" + rec.Path + "' 的 subMenu 为空或字段缺失。");
                    }
                }
            }
        }

        private ControlRec ReadControl(object c, string menuPath)
        {
            var rec = new ControlRec();
            rec.Name = GetString(c, "name");
            if (string.IsNullOrEmpty(rec.Name)) rec.Name = "(未命名)";
            rec.Path = menuPath + "/" + rec.Name;

            object tv;
            if (TryMember(c, "type", out tv) && tv != null)
            {
                rec.TypeName = EnumName(tv);
                rec.TypeInt = EnumInt(tv);
            }
            else
            {
                _ctx.Warn("控件 '" + rec.Path + "' 读不到 type，按未知类型处理。");
            }

            object pv;
            if (TryMember(c, "parameter", out pv) && pv != null)
                rec.ParameterName = GetString(pv, "name");

            rec.Value = Clean(GetDouble(c, "value", 0.0));

            object subs;
            if (TryMember(c, "subParameters", out subs))
            {
                foreach (var s in AsList(subs))
                {
                    if (s == null) continue;
                    var n = GetString(s, "name");
                    if (!string.IsNullOrEmpty(n)) rec.SubParameterNames.Add(n);
                }
            }

            object labels;
            if (TryMember(c, "labels", out labels))
            {
                foreach (var l in AsList(labels))
                {
                    if (l == null) { rec.Labels.Add(""); continue; }
                    var n = GetString(l, "name");
                    rec.Labels.Add(n ?? "");
                }
            }

            return rec;
        }

        // ---------------------------------------------------------------- 参数表

        private void ReadDeclaredParams(object ep)
        {
            object arr;
            if (!TryMember(ep, "parameters", out arr))
            {
                _ctx.Warn("VRCExpressionParameters 上读不到字段 parameters（SDK 版本不符？）。");
                return;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in AsList(arr))
            {
                if (item == null) continue;
                var d = new ParamDecl();
                d.Name = GetString(item, "name");

                object vt;
                if (TryMember(item, "valueType", out vt) && vt != null)
                {
                    d.TypeName = EnumName(vt);
                    d.TypeInt = EnumInt(vt);
                }
                else
                {
                    _ctx.Warn("expressionParameters 里参数 '" + (d.Name ?? "?") + "' 读不到 valueType。");
                }

                d.DefaultValue = Clean(GetDouble(item, "defaultValue", 0.0));
                d.Saved = GetBool(item, "saved", false);
                d.NetworkSynced = GetBool(item, "networkSynced", false);

                if (string.IsNullOrEmpty(d.Name)) continue;
                if (!seen.Add(d.Name))
                {
                    _ctx.Warn("expressionParameters 里有重名参数 '" + d.Name + "'，只保留第一条。");
                    continue;
                }
                _declared.Add(d);
            }
        }

        // ---------------------------------------------------------------- 动画层

        private void ReadAnimLayers(object layersObj)
        {
            var list = AsList(layersObj);
            for (int i = 0; i < list.Count; i++)
            {
                var item = list[i];
                if (item == null) continue;

                var lr = new LayerRec();
                lr.Index = i;

                object tv;
                if (TryMember(item, "type", out tv) && tv != null)
                {
                    lr.TypeName = EnumName(tv);
                    lr.TypeInt = EnumInt(tv);
                }

                lr.IsDefault = GetBool(item, "isDefault", false);

                object cv;
                if (!TryMember(item, "animatorController", out cv))
                {
                    _ctx.Warn("baseAnimationLayers[" + i + "] 读不到 animatorController 字段。");
                }
                else if (cv == null)
                {
                    // 空控制器是合法的（层没用上），不算 warning。
                }
                else
                {
                    var uo = cv as UnityEngine.Object;
                    if (uo == null)
                    {
                        _ctx.Warn("baseAnimationLayers[" + i + "].animatorController 不是 UnityEngine.Object。");
                    }
                    else
                    {
                        lr.ControllerName = uo.name;
                        lr.ControllerType = uo.GetType().Name;
                        try { ReadControllerParams(uo, lr); }
                        catch (Exception e) { _ctx.Warn("读控制器 '" + uo.name + "' 参数时出错：" + AuditUtil.Unwrap(e).Message); }
                    }
                }

                _layers.Add(lr);
            }
        }

        private void ReadControllerParams(UnityEngine.Object ctrl, LayerRec lr)
        {
            object target = ctrl;

            // AnimatorOverrideController：parameters 在它包的 runtimeAnimatorController 上。
            string tn = ctrl.GetType().Name;
            if (tn.IndexOf("Override", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                object inner = Member(ctrl, "runtimeAnimatorController");
                if (inner != null) target = inner;
            }

            object paramsObj;
            if (!TryMember(target, "parameters", out paramsObj))
            {
                _ctx.Warn("控制器 '" + ctrl.name + "'（" + target.GetType().Name
                    + "）上读不到 parameters —— 不是 UnityEditor.Animations.AnimatorController？该层控制器参数为空。");
                return;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var p in AsList(paramsObj))
            {
                if (p == null) continue;
                var pi = new CtrlParamInfo();
                pi.Name = GetString(p, "name");
                object pt;
                if (TryMember(p, "type", out pt) && pt != null)
                {
                    pi.TypeName = EnumName(pt);
                    pi.TypeInt = EnumInt(pt);
                }
                if (string.IsNullOrEmpty(pi.Name) || !seen.Add(pi.Name)) continue;
                lr.Parameters.Add(pi);
            }
        }

        // ---------------------------------------------------------------- 聚合

        private ParamAgg GetAgg(string name)
        {
            ParamAgg a;
            if (_aggs.TryGetValue(name, out a)) return a;
            a = new ParamAgg();
            a.Name = name;
            _aggs[name] = a;
            _aggOrder.Add(name);
            return a;
        }

        private void Aggregate()
        {
            // 1) 先登记声明的参数（带类型/默认值/同步位）
            foreach (var d in _declared)
            {
                var a = GetAgg(d.Name);
                a.Declared = true;
                a.DeclaredTypeName = d.TypeName;
                a.DeclaredTypeInt = d.TypeInt;
                a.DefaultValue = d.DefaultValue;
                a.Saved = d.Saved;
                a.NetworkSynced = d.NetworkSynced;
            }

            // 2) 再把菜单引用登记进去
            foreach (var rec in _flatControls) RegisterControl(rec);
        }

        private void RegisterControl(ControlRec rec)
        {
            string type = rec.TypeName ?? "";
            if (string.Equals(type, "Button", StringComparison.Ordinal)
                || string.Equals(type, "Toggle", StringComparison.Ordinal))
            {
                if (string.IsNullOrEmpty(rec.ParameterName)) return;
                var a = GetAgg(rec.ParameterName);
                double v = CoerceMenuValue(a, rec.Value);
                AddMenuValue(a, v);
                AddKind(a, type.ToLowerInvariant());
                AddRef(a, rec.Path);
            }
            else if (string.Equals(type, "RadialPuppet", StringComparison.Ordinal))
            {
                for (int i = 0; i < rec.SubParameterNames.Count; i++)
                {
                    var a = GetAgg(rec.SubParameterNames[i]);
                    a.RadialSeen = true;
                    AddKind(a, "radial");
                    AddRef(a, rec.Path);
                    if (rec.Labels.Count > a.RadialLabels.Count)
                    {
                        a.RadialLabels.Clear();
                        a.RadialLabels.AddRange(rec.Labels);
                    }
                }
            }
            else if (string.Equals(type, "TwoAxisPuppet", StringComparison.Ordinal)
                || string.Equals(type, "FourAxisPuppet", StringComparison.Ordinal))
            {
                string kind = type == "TwoAxisPuppet" ? "axis2" : "axis4";
                for (int i = 0; i < rec.SubParameterNames.Count; i++)
                {
                    var a = GetAgg(rec.SubParameterNames[i]);
                    a.AxisSeen = true;
                    AddKind(a, kind);
                    AddRef(a, rec.Path);
                }
            }
            else if (string.Equals(type, "SubMenu", StringComparison.Ordinal))
            {
                // 不驱动参数
            }
            else
            {
                _ctx.Warn("控件 '" + rec.Path + "' 的类型无法识别（type=" + (rec.TypeName ?? "<null>")
                    + "），其参数没有计入取值集合。");
            }
        }

        private static double CoerceMenuValue(ParamAgg a, double raw)
        {
            if (string.Equals(a.DeclaredTypeName, "Bool", StringComparison.Ordinal)) return 1.0;
            if (string.Equals(a.DeclaredTypeName, "Int", StringComparison.Ordinal)) return Math.Floor(raw);
            return Clean(raw);
        }

        private static void AddMenuValue(ParamAgg a, double v)
        {
            v = Clean(v);
            for (int i = 0; i < a.MenuValues.Count; i++) if (a.MenuValues[i] == v) return;
            a.MenuValues.Add(v);
        }

        private static void AddKind(ParamAgg a, string kind)
        {
            if (string.IsNullOrEmpty(kind)) return;
            if (!a.ValueKinds.Contains(kind)) a.ValueKinds.Add(kind);
        }

        private static void AddRef(ParamAgg a, string path)
        {
            if (string.IsNullOrEmpty(path)) return;
            if (!a.ReferencedBy.Contains(path)) a.ReferencedBy.Add(path);
        }

        private static void AddUnique(List<double> list, double v)
        {
            v = Clean(v);
            for (int i = 0; i < list.Count; i++) if (list[i] == v) return;
            list.Add(v);
        }

        /// <summary>
        /// 建议取值（给 T1 选组合；与 menu_values 明确分开）：
        ///   - 菜单里真实出现过的取值；
        ///   - Bool：补 0（关）；
        ///   - Radial：0 / 0.25 / 0.5 / 0.75 / 1，以及按 labels 数量推算的档位；
        ///   - TwoAxis/FourAxis：-1 / -0.5 / 0 / 0.5 / 1；
        ///   - 其它数值参数：补 0（VRChat 的默认/关档）。
        /// </summary>
        private static List<double> SuggestValues(ParamAgg a)
        {
            var outList = new List<double>();
            foreach (var v in a.MenuValues) AddUnique(outList, v);

            if (string.Equals(a.DeclaredTypeName, "Bool", StringComparison.Ordinal))
            {
                AddUnique(outList, 0);
                AddUnique(outList, 1);
            }

            if (a.RadialSeen)
            {
                AddUnique(outList, 0);
                AddUnique(outList, 0.25);
                AddUnique(outList, 0.5);
                AddUnique(outList, 0.75);
                AddUnique(outList, 1);
                foreach (var v in RadialLabelDerived(a)) AddUnique(outList, v);
            }

            if (a.AxisSeen)
            {
                AddUnique(outList, -1);
                AddUnique(outList, -0.5);
                AddUnique(outList, 0);
                AddUnique(outList, 0.5);
                AddUnique(outList, 1);
            }

            if (outList.Count == 0 ||
                string.Equals(a.DeclaredTypeName, "Int", StringComparison.Ordinal) ||
                string.Equals(a.DeclaredTypeName, "Float", StringComparison.Ordinal))
            {
                AddUnique(outList, 0);
            }

            outList.Sort();
            return outList;
        }

        /// <summary>按 Radial 的 labels 数量推算档位：N 个标签 → N 个区间中点 (i+0.5)/N；N&gt;1 再加端点 i/(N-1)。</summary>
        private static List<double> RadialLabelDerived(ParamAgg a)
        {
            var list = new List<double>();
            int n = a.RadialLabels.Count;
            if (n <= 0) return list;

            for (int i = 0; i < n; i++) AddUnique(list, (i + 0.5) / n);
            if (n > 1)
            {
                for (int i = 0; i < n; i++) AddUnique(list, (double)i / (n - 1));
            }
            list.Sort();
            return list;
        }

        // ---------------------------------------------------------------- 输出

        private void WriteOutputs()
        {
            var now = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            var warnings = _ctx.Warnings.Cast<object>().ToList();

            var menuRefSet = new HashSet<string>(StringComparer.Ordinal);
            foreach (var k in _aggOrder)
            {
                var a = _aggs[k];
                if (a.ReferencedBy.Count > 0) menuRefSet.Add(k);
            }

            var declaredSet = new HashSet<string>(StringComparer.Ordinal);
            foreach (var d in _declared) declaredSet.Add(d.Name);

            // ---------- 菜单中引用、但 expressionParameters 未声明 ----------
            var undeclared = _aggOrder
                .Where(n => menuRefSet.Contains(n) && !declaredSet.Contains(n))
                .OrderBy(n => n, StringComparer.Ordinal)
                .ToList();

            // ---------- 控制器里有、菜单里没有 ----------
            var notInMenuMap = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            var notInMenuOrder = new List<string>();
            foreach (var lr in _layers)
            {
                foreach (var p in lr.Parameters)
                {
                    if (menuRefSet.Contains(p.Name)) continue;
                    List<string> where;
                    if (!notInMenuMap.TryGetValue(p.Name, out where))
                    {
                        where = new List<string>();
                        notInMenuMap[p.Name] = where;
                        notInMenuOrder.Add(p.Name);
                    }
                    string tag = (lr.TypeName ?? ("layer" + lr.Index)) + "[" + lr.Index + "]";
                    if (!where.Contains(tag)) where.Add(tag);
                }
            }
            notInMenuOrder.Sort(StringComparer.Ordinal);

            // ================= menu_tree.json =================
            var tree = new JsonObject();
            tree.Set("tool", "menu");
            tree.Set("avatar", _avatar != null ? _avatar.name : null);
            tree.Set("avatar_path", _avatar != null ? AuditUtil.ScenePath(_avatar.transform) : null);
            tree.Set("play_mode", EditorApplication.isPlaying);
            tree.Set("generated_at", now);
            tree.Set("root_label", _rootLabel);
            tree.Set("request", _ctx.Request);
            tree.Set("descriptor", _descriptorJson);

            var menuJson = new JsonObject();
            menuJson.Set("found", _menuRead);
            menuJson.Set("type", _menuTypeName);
            menuJson.Set("control_count", _controlCount);
            menuJson.Set("controls", _rootControls.Select(ControlToJson).Cast<object>().ToList());
            tree.Set("menu", menuJson);

            tree.Set("expression_parameters", DeclaredTableJson());
            tree.Set("warnings", warnings);
            AuditJson.WriteFile(_ctx.OutPath("menu_tree.json"), tree);

            // ================= params.json =================
            var paramsJson = new JsonObject();
            paramsJson.Set("tool", "menu");
            paramsJson.Set("avatar", _avatar != null ? _avatar.name : null);
            paramsJson.Set("avatar_path", _avatar != null ? AuditUtil.ScenePath(_avatar.transform) : null);
            paramsJson.Set("play_mode", EditorApplication.isPlaying);
            paramsJson.Set("generated_at", now);
            paramsJson.Set("request", _ctx.Request);

            paramsJson.Set("descriptor", _descriptorJson);
            paramsJson.Set("menu_read", _menuRead);
            paramsJson.Set("params_read", _paramsRead);
            paramsJson.Set("layers_read", _layersRead);
            paramsJson.Set("control_count", _controlCount);

            paramsJson.Set("declared_param_names", _declared.Select(d => d.Name).OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList());
            paramsJson.Set("menu_param_names", _aggOrder
                .Where(n => menuRefSet.Contains(n))
                .OrderBy(n => n, StringComparer.Ordinal)
                .Cast<object>().ToList());

            paramsJson.Set("parameters", AggTableJson());
            paramsJson.Set("expression_parameters", DeclaredTableJson());

            paramsJson.Set("menu_params_undeclared", undeclared.Cast<object>().ToList());

            var nim = new List<object>();
            foreach (var name in notInMenuOrder)
            {
                var o = new JsonObject();
                o.Set("name", name);
                o.Set("layers", notInMenuMap[name].Cast<object>().ToList());
                o.Set("declared_in_expression", declaredSet.Contains(name));
                o.Set("likely_builtin", BuiltinParams.Contains(name));
                nim.Add(o);
            }
            paramsJson.Set("params_not_in_menu", nim);
            paramsJson.Set("controller_parameters", LayersToJson());
            paramsJson.Set("warnings", warnings);
            AuditJson.WriteFile(_ctx.OutPath("params.json"), paramsJson);

            // ================= menu_tree.md =================
            WriteMarkdown(now, declaredSet, undeclared, notInMenuOrder, notInMenuMap);

            _ctx.Status.Log("T4 完成：控件=" + _controlCount
                + "，声明参数=" + _declared.Count
                + "，菜单引用参数=" + menuRefSet.Count
                + "，菜单未声明=" + undeclared.Count
                + "，控制器多出=" + notInMenuOrder.Count
                + "，warnings=" + warnings.Count);
        }

        private JsonObject DeclaredTableJson()
        {
            var o = new JsonObject();
            o.Set("found", _paramsRead);
            o.Set("type", _paramsTypeName);
            o.Set("count", _declared.Count);
            var list = new List<object>();
            foreach (var d in _declared.OrderBy(x => x.Name, StringComparer.Ordinal))
            {
                var p = new JsonObject();
                p.Set("name", d.Name);
                p.Set("valueType", d.TypeInt);
                p.Set("valueType_name", d.TypeName);
                p.Set("defaultValue", d.DefaultValue);
                p.Set("saved", d.Saved);
                p.Set("networkSynced", d.NetworkSynced);
                list.Add(p);
            }
            o.Set("parameters", list);
            return o;
        }

        private List<object> AggTableJson()
        {
            var list = new List<object>();
            foreach (var name in _aggOrder.OrderBy(x => x, StringComparer.Ordinal))
            {
                var a = _aggs[name];
                var o = new JsonObject();
                o.Set("name", a.Name);
                o.Set("declared_in_expression", a.Declared);
                o.Set("value_type", a.DeclaredTypeInt);
                o.Set("value_type_name", a.DeclaredTypeName);
                o.Set("default_value", a.Declared ? (object)a.DefaultValue : null);
                o.Set("saved", a.Declared ? (object)a.Saved : null);
                o.Set("network_synced", a.Declared ? (object)a.NetworkSynced : null);

                var mv = a.MenuValues.OrderBy(x => x).Cast<object>().ToList();
                o.Set("menu_values", mv);
                o.Set("menu_value_kinds", a.ValueKinds.Cast<object>().ToList());
                o.Set("suggested_values", SuggestValues(a).Cast<object>().ToList());
                o.Set("radial_labels", a.RadialLabels.Cast<object>().ToList());
                o.Set("radial_label_derived", RadialLabelDerived(a).Cast<object>().ToList());
                o.Set("referenced_by", a.ReferencedBy.Cast<object>().ToList());
                list.Add(o);
            }
            return list;
        }

        private JsonObject ControlToJson(ControlRec rec)
        {
            var o = new JsonObject();
            o.Set("name", rec.Name);
            o.Set("path", rec.Path);
            o.Set("type", rec.TypeInt);
            o.Set("type_name", rec.TypeName);
            o.Set("parameter_name", rec.ParameterName);
            o.Set("value", rec.Value);
            o.Set("sub_parameters", rec.SubParameterNames.Cast<object>().ToList());
            o.Set("labels", rec.Labels.Cast<object>().ToList());
            if (rec.Children.Count > 0)
                o.Set("controls", rec.Children.Select(ControlToJson).Cast<object>().ToList());
            return o;
        }

        private List<object> LayersToJson()
        {
            var list = new List<object>();
            foreach (var lr in _layers)
            {
                var o = new JsonObject();
                o.Set("index", lr.Index);
                o.Set("layer_type", lr.TypeName);
                o.Set("layer_type_int", lr.TypeInt);
                o.Set("is_default", lr.IsDefault);
                o.Set("controller", lr.ControllerName);
                o.Set("controller_type", lr.ControllerType);
                var ps = new List<object>();
                foreach (var p in lr.Parameters)
                {
                    var po = new JsonObject();
                    po.Set("name", p.Name);
                    po.Set("type", p.TypeInt);
                    po.Set("type_name", p.TypeName);
                    ps.Add(po);
                }
                o.Set("parameters", ps);
                list.Add(o);
            }
            return list;
        }

        // ---------------------------------------------------------------- Markdown

        private void WriteMarkdown(string now, HashSet<string> declaredSet,
            List<string> undeclared, List<string> notInMenuOrder, Dictionary<string, List<string>> notInMenuMap)
        {
            var sb = new StringBuilder(16384);
            sb.Append("# 菜单树（Play 构建后 · NDMF/MA 注入已生效）\n\n");
            sb.Append("- 头像：").Append(_avatar != null ? _avatar.name : "(未解析)").Append("\n");
            sb.Append("- 头像路径：").Append(_avatar != null ? AuditUtil.ScenePath(_avatar.transform) : "-").Append("\n");
            sb.Append("- 生成时间：").Append(now).Append("\n");
            sb.Append("- 控件数：").Append(_controlCount)
              .Append("；声明参数：").Append(_declared.Count)
              .Append("；warnings：").Append(_ctx.Warnings.Count).Append("\n");
            if (_ctx.Warnings.Count > 0)
                sb.Append("\n> 有 warning（读数降级），明细见 menu_tree.json 的 warnings。\n");
            sb.Append("\n");

            sb.Append("## 缩进树（路径 · 类型 · 参数=值）\n\n");
            if (_rootControls.Count == 0)
            {
                sb.Append("_（没有读到菜单控件）_\n\n");
            }
            else
            {
                foreach (var rec in _rootControls) AppendTree(sb, rec, 0);
                sb.Append("\n");
            }

            sb.Append("## 参数速查（供 T1 选组合）\n\n");
            sb.Append("| 参数 | 声明类型 | 菜单取值 menu_values | 建议取值 suggested_values | 引用控件数 |\n");
            sb.Append("|---|---|---|---|---|\n");
            foreach (var name in _aggOrder.OrderBy(x => x, StringComparer.Ordinal))
            {
                var a = _aggs[name];
                string vt = a.Declared ? (a.DeclaredTypeName ?? "?") : "(未声明)";
                string mv = a.MenuValues.Count == 0 ? "-" : string.Join(", ", a.MenuValues.OrderBy(x => x).Select(NumStr).ToArray());
                string sv = string.Join(", ", SuggestValues(a).Select(NumStr).ToArray());
                sb.Append("| ").Append(Esc(name)).Append(" | ").Append(Esc(vt)).Append(" | ")
                  .Append(Esc(mv)).Append(" | ").Append(Esc(sv)).Append(" | ")
                  .Append(a.ReferencedBy.Count).Append(" |\n");
            }
            sb.Append("\n");

            sb.Append("## params_not_in_menu（控制器里有、菜单里没有）\n\n");
            if (notInMenuOrder.Count == 0)
            {
                sb.Append("_（无，或 baseAnimationLayers 没读到）_\n\n");
            }
            else
            {
                foreach (var n in notInMenuOrder)
                {
                    sb.Append("- ").Append(n)
                      .Append("（").Append(string.Join(", ", notInMenuMap[n].ToArray())).Append("）");
                    if (!declaredSet.Contains(n)) sb.Append(" [expressionParameters 未声明]");
                    if (BuiltinParams.Contains(n)) sb.Append(" [likely_builtin]");
                    sb.Append("\n");
                }
                sb.Append("\n");
            }

            sb.Append("## menu_params_undeclared（菜单引用、expressionParameters 未声明）\n\n");
            if (undeclared.Count == 0)
            {
                sb.Append("_（无）_\n\n");
            }
            else
            {
                sb.Append("> 这类参数在 VRChat 里不同步：菜单操作无效或仅本地可见，审查时要单独标注。\n\n");
                foreach (var n in undeclared)
                {
                    var a = _aggs[n];
                    sb.Append("- ").Append(n)
                      .Append("（").Append(string.Join(", ", a.ValueKinds.ToArray())).Append("，引用 ")
                      .Append(a.ReferencedBy.Count).Append(" 个控件）\n");
                }
                sb.Append("\n");
            }

            var path = _ctx.OutPath("menu_tree.md");
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false));
        }

        private static void AppendTree(StringBuilder sb, ControlRec rec, int indent)
        {
            sb.Append(new string(' ', indent * 2)).Append("- ").Append(rec.Path)
              .Append(" · ").Append(rec.TypeName ?? "?");
            if (rec.TypeInt >= 0) sb.Append("(").Append(rec.TypeInt).Append(")");
            sb.Append(" · ").Append(ControlParamText(rec));
            sb.Append("\n");
            foreach (var c in rec.Children) AppendTree(sb, c, indent + 1);
        }

        private static string ControlParamText(ControlRec rec)
        {
            string type = rec.TypeName ?? "";
            if (type == "Button" || type == "Toggle")
                return (rec.ParameterName ?? "(无参数)") + "=" + NumStr(rec.Value)
                    + (rec.Labels.Count > 0 ? " labels=[" + string.Join("/", rec.Labels.ToArray()) + "]" : "");

            if (type == "SubMenu") return "(子菜单)";

            if (rec.SubParameterNames.Count > 0)
            {
                var parts = new List<string>();
                for (int i = 0; i < rec.SubParameterNames.Count; i++)
                    parts.Add(rec.SubParameterNames[i] + "=" + (type == "RadialPuppet" ? "radial(0..1)" : "axis(-1..1)"));
                return string.Join(", ", parts.ToArray());
            }
            return "(无参数)";
        }

        private static string Esc(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("|", "\\|").Replace("\n", " ").Replace("\r", " ");
        }
    }
}
