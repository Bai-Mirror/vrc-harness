// 【项目沉淀】
// 适用素体：无关（读的是场景/运行时状态，不改网格、不改素材）。
// 用途：T1 状态驱动器。在 Play 模式下对真实构建结果施加 VRChat 参数，等动画稳定后把
//       「最终长什么样」量出来：每个 Renderer 的显隐与材质、SkinnedMeshRenderer 的非零形态键、
//       指定骨骼的世界坐标。输出 state_<id>.json（逐状态）与 states.json（汇总 + 与 default 的差异）。
//
// 为什么要在 Play 模式 + 让 GestureManager 接管：
//   VRC_AvatarParameterDriver / VRC_AnimatorLayerControl 这些是 VRChat 客户端在运行时执行的行为，
//   裸 Unity 里播放 AnimatorController 不会执行它们。GestureManager 3.9.9 会接管头像、用 PlayableGraph
//   复刻这套行为（ModuleVrc3.cs:1276 AvatarParameterDriverSettings、ModuleVrc3.cs:1262
//   AnimatorLayerControlSettings）。所以只有 GM 接管时，T1 的结果才代表「VRChat 里真实会看到的组合」。
//   接管失败就退回直接写 Animator，并在输出里标 driver=animator —— 这种结果的参数联动是缺的，必须降级看待。
//
// 为什么参数先复位再施加：
//   档位切换残留（旧状态没清干净）正是要抓的 P4 类问题之一。每个状态都从「用户可控参数 = 表达参数声明的
//   defaultValue」出发，状态之间的差异才只归因于这个状态自己的参数。
//
// 为什么复位值取 VRCExpressionParameters 的声明 defaultValue，而不是 T1 启动瞬间的实际值：
//   实测教训（工程A，2026-09-18）：同一个 Play 会话里连续跑多次 T1 时，如果拿启动实值当默认值，
//   上一次最后一个状态的参数值就会变成下一次的「默认值」，跨次运行漂移。实例：
//     · 一次运行停在 A2_Outfit=1.0（带兜帽整套，兜帽压制层关掉头饰）→ 之后所有运行里头饰都「不显示」，
//       被误当工程缺陷查了半小时；
//     · 一次运行停在 A2_Sok=0 → 之后请求 {"A2_Outfit":0.214286}（本意整套全开）实际成了「关袜」状态，
//       渲图与 agy 结论全部错位。
//   根因：把「上次跑完的残留」当成了「默认值」。声明 defaultValue 来自资产、跨运行恒定，才是真正的
//   「每个状态自己的起点」。
//
// 为什么这样不会重蹈「内置参数被写成 0」的覆辙：
//   可复位集合 = 头像 VRCExpressionParameters 里声明的参数 − VRChat 内置参数（Vrc3DefaultParams + 官方内置名）。
//   内置参数的声明默认值常是 0，运行时该有的值却是 1 / 1.052837 / 3 …（GM 在 InitForAvatar，
//   ModuleVrc3.cs:258-275 里设成运行时值），但内置参数根本不在可复位集合里，所以复位永远不会碰
//   ScaleFactorInverse / EyeHeightAsMeters / Grounded / TrackingType 等。只有显式声明在表达参数里、
//   又确实是用户可控的参数，才用它们自己的声明默认值复位。
//
// 为什么只复位「用户可控参数」：
//   内置参数（Grounded / Upright / TrackingType / IsLocal / …）由运行时或客户端驱动，审查不该碰；
//   Animator-only 参数也不碰。状态里显式写了的参数照设（即使它是内置参数）。
//   代价：请求里出现、但不在表达参数里的参数不会在状态间自动复位——要么把它写进表达参数，要么每个状态都显式写。
//
// 为什么还要跳过「参数驱动器维护的内部参数」（任务 AD，2026-09-18 实测）：
//   表达参数里还有一类不是给用户点的，而是 VRCAvatarParameterDriver 维护的内部状态。实例（工程B_Milfy）：
//   厂商参数 Slippers_OFF 由「鞋子」部位层 ON/OFF 状态与整套切换层的驱动器写入，声明默认值 0 = 显示拖鞋。
//   每状态前复位把它冲回 0，而同一套服装内切换时驱动器不会再触发 → 13 套里 12 套「只关袜子」都冒出小熊
//   拖鞋（与该套自己的鞋叠穿）。同一序列改用 reset:none 按真实操作顺序切则不复现 → 纯工具假象。
//   所以默认 reset:declared 的复位集合还会减去「被 VRCAvatarParameterDriver 写入、且用户不能直接点」的参数
//   （见 ScanDriverTargets / driver_targets）；若该参数同时直接出现在表达菜单控件里（用户也能点），
//   仍参与复位，但在 warnings 与 states.json.driver_targets_user_clickable 里列出。
//   请求字段 reset_driver_targets:true 可关掉这个排除（回到旧行为，用于复现历史批次）。
//
// 读不到声明 defaultValue 时：退回该参数的 T1 启动实值，并在 warnings 里逐个列出参数名
//   （该状态 reset_values_source=startup_value_fallback）。请求里可用 "reset":"startup" 主动全取启动值、
//   用 "reset":"none" 完全不复位（做切换残留测试时故意保留上一状态，序列必须在请求里显式列出）。
//
// 健全性检查：每个状态快照后校验头像根 lossyScale ∈ [0.5, 2] 且 Head 比 Hips 高 0.2 m 以上；
//   不满足就标 sanity_failed 并在整批结束时把 status 置 error——宁可整批报错，也不要拿塌掉的快照出结论。
//
// 易变形态键：第一个状态上连采两次快照（间隔 settle_frames），两次不同的形态键记为 volatile，
//   写进 states.json.volatile_blendshapes，并在状态间 diff（含确定性比对）里排除。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace AvatarAudit
{
    /// <summary>单个材质槽的快照。</summary>
    public sealed class AuditMatSnap
    {
        public int Slot;
        public bool IsNull;
        public string Name;
        public string Shader;
        public int Queue;
        /// <summary>T-13：V3 着色器规则表判定（lilToon 整块遮罩 / 非规则表 unknown），null=材质为空。</summary>
        public JsonObject V3;
    }

    /// <summary>单个 Renderer 的快照。</summary>
    public sealed class AuditRendererSnap
    {
        public string Path;
        public string Type;
        public bool ActiveInHierarchy;
        public bool Enabled;
        public List<AuditMatSnap> Materials = new List<AuditMatSnap>();

        /// <summary>审查口径：渲染器真正出画 = 所在物体在活跃层级里 且 自身 enabled。</summary>
        public bool Visible { get { return ActiveInHierarchy && Enabled; } }
    }

    /// <summary>一个状态的完整快照。</summary>
    public sealed class AuditStateSnapshot
    {
        public string Id;
        public string Driver;
        public Dictionary<string, float> ParamsApplied = new Dictionary<string, float>();
        public Dictionary<string, string> ParamSources = new Dictionary<string, string>();
        public List<string> MissingParams = new List<string>();
        public List<string> Warnings = new List<string>();
        /// <summary>本状态复位值来源：declared_default / startup_value_fallback / none。</summary>
        public string ResetValuesSource = "declared_default";
        /// <summary>本状态实际复位的参数个数（set 成功的；none 模式为 0）。</summary>
        public int ResetCount;

        public Dictionary<string, AuditRendererSnap> Renderers = new Dictionary<string, AuditRendererSnap>();
        /// <summary>SMR 路径 → {形态键名: 权重}，只记非零（|w| &gt; blendshape_epsilon）。</summary>
        public Dictionary<string, Dictionary<string, float>> Blendshapes = new Dictionary<string, Dictionary<string, float>>();
        public Dictionary<string, float[]> Bones = new Dictionary<string, float[]>();
        public List<string> BonesMissing = new List<string>();
        public float[] AvatarPosition;
        public float[] AvatarRotation;

        /// <summary>健全性检查：头像根缩放是否在 0.5–2、Head 是否比 Hips 高 0.2 m 以上。失败的状态整批 status=error。</summary>
        public bool SanityFailed;
        public readonly List<string> SanityReasons = new List<string>();

        /// <summary>任务 R：本状态的纯数据探针结果（仅请求里 probes 非空时存在）。键=探针名，值=该探针输出对象。</summary>
        public JsonObject Probes;
        /// <summary>
        /// 任务 CS（T-33）：shrink_cover 探针的精简行（仅请求 probes 含 shrink_cover 且该探针跑出结果时存在）。
        /// 完整结果写在同目录 shrink_cover_&lt;stateId&gt;.json，这里只放摘要 + 每键精简行，避免 states.json 膨胀。
        /// </summary>
        public JsonObject ShrinkCover;
        /// <summary>任务 R：每个探针本状态的命中数，供 states.json 汇总（第一遍）。</summary>
        public readonly Dictionary<string, int> ProbeHits = new Dictionary<string, int>(StringComparer.Ordinal);

        /// <summary>任务 U：探针前临时设置的形态键（请求 pre_probe_blendshapes 实际生效的项；没配到任何键时为空）。</summary>
        public readonly List<object> PreProbeBlendshapes = new List<object>();

        // ---- T-13 新增（T1 v4）----
        /// <summary>构建后每个 SMR 的全部形态键（含 0）：键=SMR 路径（与 Renderers 同 UniqueKey），值见 Capture。</summary>
        public JsonObject KeysAll;
        /// <summary>V1/V2/V3/V4 可见性四分量：键=渲染器/SMR 路径。</summary>
        public JsonObject Visibility;
        /// <summary>状态回读断言：请求参数 vs 实际参数 vs 期望可见部件集。</summary>
        public JsonObject Readback;
        /// <summary>本状态回读断言是否全过；false 时整批 aborted。</summary>
        public bool ReadbackFailed;
        /// <summary>任务 BJ：本状态里被显式 expect_override 或驱动器合法改写放行的参数名（回读不等于请求值但接受）。</summary>
        public readonly List<string> Overridden = new List<string>();
        /// <summary>状态 id 的规范元组（用实际值；轮盘按 i/n 算槽号）。</summary>
        public string IdCanonical;
        /// <summary>本状态在请求序列里的前序状态 id（sequence / reset:none 用）。</summary>
        public readonly List<string> History = new List<string>();

        private static List<object> Nums(float[] a)
        {
            var l = new List<object>();
            if (a == null) return l;
            for (int i = 0; i < a.Length; i++) l.Add((double)a[i]);
            return l;
        }

        public JsonObject ToJson(HashSet<string> excludeShapes = null)
        {
            var o = new JsonObject();
            o.Set("id", Id);
            o.Set("driver", Driver);

            var pa = new JsonObject();
            foreach (var k in ParamsApplied.Keys.OrderBy(x => x, StringComparer.Ordinal)) pa.Set(k, (double)ParamsApplied[k]);
            o.Set("params_applied", pa);

            var ps = new JsonObject();
            foreach (var k in ParamSources.Keys.OrderBy(x => x, StringComparer.Ordinal)) ps.Set(k, ParamSources[k]);
            o.Set("param_sources", ps);

            o.Set("missing_params", MissingParams.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList());
            o.Set("warnings", Warnings.Cast<object>().ToList());
            o.Set("reset_values_source", ResetValuesSource);
            o.Set("reset_count", ResetCount);

            var rl = new List<object>();
            foreach (var key in Renderers.Keys.OrderBy(x => x, StringComparer.Ordinal))
            {
                var r = Renderers[key];
                var ro = new JsonObject();
                ro.Set("path", r.Path);
                ro.Set("key", key);
                ro.Set("type", r.Type);
                ro.Set("active_in_hierarchy", r.ActiveInHierarchy);
                ro.Set("enabled", r.Enabled);
                ro.Set("visible", r.Visible);
                var ml = new List<object>();
                foreach (var m in r.Materials)
                {
                    var mo = new JsonObject();
                    mo.Set("slot", m.Slot);
                    mo.Set("null", m.IsNull);
                    mo.Set("name", m.Name);
                    mo.Set("shader", m.Shader);
                    mo.Set("render_queue", m.Queue);
                    if (m.V3 != null) mo.Set("v3", m.V3);
                    ml.Add(mo);
                }
                ro.Set("materials", ml);
                rl.Add(ro);
            }
            o.Set("renderers", rl);

            var bs = new JsonObject();
            foreach (var key in Blendshapes.Keys.OrderBy(x => x, StringComparer.Ordinal))
            {
                var shapes = Blendshapes[key];
                var so = new JsonObject();
                foreach (var sn in shapes.Keys.OrderBy(x => x, StringComparer.Ordinal))
                {
                    // volatile 形态键（随时间自动播放）在状态间 diff / 确定性比对里排除，避免噪声淹没真实差异。
                    if (excludeShapes != null && excludeShapes.Contains(key + "\u0000" + sn)) continue;
                    so.Set(sn, (double)shapes[sn]);
                }
                bs.Set(key, so);
            }
            o.Set("blendshapes", bs);

            // ---- T-13：键存在表 / 可见性四分量 / 回读断言 / 规范 id / 序列 history ----
            if (KeysAll != null) o.Set("keys_all", KeysAll);
            if (Visibility != null) o.Set("visibility", Visibility);
            if (Readback != null) o.Set("readback", Readback);
            o.Set("readback_failed", ReadbackFailed);
            // 任务 BJ：被放行的钳位/驱动器改写参数（没有时也写空数组，便于下游稳定读取）。
            o.Set("overridden", Overridden.Cast<object>().ToList());
            if (!string.IsNullOrEmpty(IdCanonical)) o.Set("id_canonical", IdCanonical);
            if (History.Count > 0) o.Set("history", History.Cast<object>().ToList());

            var bo = new JsonObject();
            foreach (var b in Bones.Keys.OrderBy(x => x, StringComparer.Ordinal)) bo.Set(b, Nums(Bones[b]));
            o.Set("bones_world", bo);
            o.Set("bones_missing", BonesMissing.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList());

            o.Set("avatar_position", Nums(AvatarPosition));
            o.Set("avatar_rotation_euler", Nums(AvatarRotation));
            o.Set("sanity_failed", SanityFailed);
            o.Set("sanity_reasons", SanityReasons.Cast<object>().ToList());
            // 任务 R：探针结果（仅请求里 probes 非空时才有这个字段）。
            if (Probes != null) o.Set("probes", Probes);
            // 任务 CS：shrink_cover 精简行（仅请求该探针且跑出结果时才有）。
            if (ShrinkCover != null) o.Set("shrink_cover", ShrinkCover);
            // 任务 U：探针前临时设置的形态键（没实际设到任何键时不写这个字段，保持旧输出）。
            if (PreProbeBlendshapes.Count > 0) o.Set("pre_probe_blendshapes_applied", PreProbeBlendshapes);
            return o;
        }
    }

    /// <summary>请求里的一个状态。</summary>
    public sealed class AuditStateSpec
    {
        public string Id;
        public string Pose;
        public readonly Dictionary<string, float> Params = new Dictionary<string, float>();
        /// <summary>T-13：本状态期望「可见」的渲染器（精确路径/名，其次子串）。</summary>
        public readonly List<string> ExpectVisible = new List<string>();
        /// <summary>T-13：本状态期望「不可见」的渲染器。</summary>
        public readonly List<string> ExpectHidden = new List<string>();
        /// <summary>T-13：本状态在请求序列里的前序状态 id（sequence / reset:none 用）。</summary>
        public readonly List<string> History = new List<string>();
        /// <summary>任务 BJ（B-补-19）：本状态级 expect_override，参数名 → 期望读回值或 any。请求级默认在 ParseExpectations 里合并。</summary>
        public readonly Dictionary<string, OverrideSpec> ExpectOverride = new Dictionary<string, OverrideSpec>(StringComparer.Ordinal);
    }

    /// <summary>
    /// 任务 BJ（B-补-19）：请求字段 expect_override 的一项。被钳位/被驱动器合法改写的参数，
    /// 回读值与请求值不一致时不判失败，改记 overridden。value "any"（或不写值）= 任何读回值都接受。
    /// </summary>
    public sealed class OverrideSpec
    {
        public bool Any;          // true = "any"，接受任意读回值
        public float Value;       // Any=false 时的期望读回值
        public string Raw;        // 回显（"any" 或格式化后的数值）
    }

    /// <summary>
    /// T-13 V3：着色器规则表。只覆盖 lilToon 的「整块不可见」判据，规则表外一律 <c>unknown</c>（判不了不硬判）。
    /// 输入用委托取值，纯逻辑、可离线单测（不 new Material，不依赖 Unity 运行时）。
    /// 判据出处：03b Q4「lilToon `_AlphaMaskMode`≠0 且 `_AlphaMask_ST` 偏移把遮罩推出 UV（bag 的做法）、
    /// `_Cutoff`≥1、`_Color.a`≈0 → 判整块不可见」。
    /// </summary>
    public static class AuditV3Rules
    {
        public const string Visible = "visible";
        public const string Hidden = "hidden";
        public const string Unknown = "unknown";
        private const double Eps = 1e-4;

        public static bool IsLilToon(string shaderName)
        {
            return !string.IsNullOrEmpty(shaderName) && shaderName.IndexOf("lilToon", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>
        /// get1(prop) 返回标量属性（无该属性返回 null）；get4(prop) 返回四元属性（无返回 null）。
        /// 优先级：_Cutoff≥1 → hidden；_Color.a≈0 → hidden；_AlphaMaskMode≠0 且 ST 把采样 UV 整段推出 [0,1] → hidden；
        /// mask 开但 ST 没推出 → unknown（取决于贴图内容，规则表判不了）；都不命中 → visible；非 lilToon → unknown。
        /// </summary>
        public static string Evaluate(string shaderName, Func<string, double?> get1, Func<string, double[]> get4, out string reason)
        {
            reason = null;
            if (!IsLilToon(shaderName))
            {
                reason = "着色器不在规则表内（非 lilToon）：" + (shaderName ?? "<null>");
                return Unknown;
            }

            double? cutoff = get1("_Cutoff");
            if (cutoff.HasValue && cutoff.Value >= 1.0 - Eps)
            {
                reason = "_Cutoff=" + AuditUtil.F(cutoff.Value) + " ≥ 1（整体剔除）";
                return Hidden;
            }

            double? colorA = get1("_Color.a");
            if (colorA.HasValue && Math.Abs(colorA.Value) <= Eps)
            {
                reason = "_Color.a≈0（整块透明）";
                return Hidden;
            }

            double? maskMode = get1("_AlphaMaskMode");
            if (maskMode.HasValue && Math.Abs(maskMode.Value) > Eps)
            {
                double[] st = get4("_AlphaMask_ST");
                if (st != null && st.Length >= 4)
                {
                    double sx = st[0], sy = st[1], ox = st[2], oy = st[3];
                    if (OutOfUnit(ox, sx) || OutOfUnit(oy, sy))
                    {
                        reason = "_AlphaMaskMode=" + AuditUtil.F(maskMode.Value) + " 且 _AlphaMask_ST=(scale "
                            + AuditUtil.F(sx) + "," + AuditUtil.F(sy) + ", offset " + AuditUtil.F(ox) + "," + AuditUtil.F(oy)
                            + ") 把遮罩采样推出 UV";
                        return Hidden;
                    }
                }
                reason = "_AlphaMaskMode=" + AuditUtil.F(maskMode.Value) + " 但 _AlphaMask_ST 未把采样推出 UV"
                    + (st == null ? "（读不到 ST）" : "") + "：是否整块不可见取决于遮罩贴图内容，规则表给 unknown";
                return Unknown;
            }

            reason = "lilToon 规则表内未命中任何不可见条件";
            return Visible;
        }

        /// <summary>UV∈[0,1] 经 uv*scale+offset 后是否整段落在 [0,1] 之外。</summary>
        public static bool OutOfUnit(double offset, double scale)
        {
            double lo = Math.Min(offset, offset + scale);
            double hi = Math.Max(offset, offset + scale);
            return hi < 0.0 || lo > 1.0;
        }

        /// <summary>把一条槽位的结论汇总成部件级 V3：都 hidden → hidden；有 visible → visible；否则 unknown。</summary>
        public static string Aggregate(IEnumerable<string> perSlot)
        {
            bool any = false, anyVisible = false, allHidden = true;
            foreach (var s in perSlot)
            {
                any = true;
                if (s == Visible) anyVisible = true;
                if (s != Hidden) allHidden = false;
            }
            if (!any) return Unknown;
            if (anyVisible) return Visible;
            return allHidden ? Hidden : Unknown;
        }
    }

    /// <summary>
    /// 任务 BZ/CF（R9）：候选排序键的纯函数比较器，CompareCandidateRows 与离线 selftest 共用。
    /// 顺序：斑块总面积↑ → 最大深度↑ → |si p50|↑ → si 陷入量(p05)↑ → tilt_deg↑
    ///       → |sd p50|↑ → 跟隙 p50↑ → |d_v p50|↑ → candidate id。
    /// ↑ 表示升序（值越小越靠前）。度量缺失（null，例如非脚部件）时排在同项有值之后。
    /// 依据：04 T-08「先硬约束，再按斑块总面积↓、最大深度↓」；BZ 在 |d_v p50| 之前插 sd/跟隙；
    /// CF（2026-09-19 工程A 实测 B-T08b 标定没过）把 v2 的 |si p50|/si 陷入量/tilt 放在 |sd p50| 之前：
    /// v1 的 sd 量到的是「外底」，半抬脚跟的前掌陷进鞋底实体、离外底反而近，会把 =50 排到 =100 前；
    /// v2 直接量到「鞋垫面」，平脚贴底者 |si| 小、tilt 小，才是应排前的那档。
    /// </summary>
    internal static class CandidateRankOrder
    {
        public static int Compare(
            double areaA, double depthA, double? siAbsA, double? siPenA, double? tiltA, double? sdA, double? heelA, double? dvA, string idA,
            double areaB, double depthB, double? siAbsB, double? siPenB, double? tiltB, double? sdB, double? heelB, double? dvB, string idB)
        {
            int c = areaA.CompareTo(areaB);
            if (c != 0) return c;
            c = depthA.CompareTo(depthB);
            if (c != 0) return c;
            c = Cmp(siAbsA, siAbsB);          // |si p50|：离鞋垫面越近越好
            if (c != 0) return c;
            c = Cmp(siPenA, siPenB);          // si 陷入量 max(0,-si p05)：陷入越浅越好
            if (c != 0) return c;
            c = Cmp(tiltA, tiltB);            // 脚底平面 vs 鞋垫面夹角：平贴者小
            if (c != 0) return c;
            c = CmpAbs(sdA, sdB);             // v1：到外底的距离（参考键，排在 v2 之后）
            if (c != 0) return c;
            c = Cmp(heelA, heelB);
            if (c != 0) return c;
            c = CmpAbs(dvA, dvB);
            if (c != 0) return c;
            return string.CompareOrdinal(idA ?? "", idB ?? "");
        }

        /// <summary>把 signed p05（负=陷入）折成陷入量：正值=陷入深度，无陷入=0。</summary>
        public static double? Penetration(double? p05)
        {
            if (!p05.HasValue) return null;
            return p05.Value < 0 ? -p05.Value : 0.0;
        }

        private static int Cmp(double? a, double? b)
        {
            if (!a.HasValue && !b.HasValue) return 0;
            if (!a.HasValue) return 1;   // 没算出的排后（不拿缺失度量冒充最优）
            if (!b.HasValue) return -1;
            return a.Value.CompareTo(b.Value);
        }

        private static int CmpAbs(double? a, double? b)
        {
            if (!a.HasValue && !b.HasValue) return 0;
            if (!a.HasValue) return 1;
            if (!b.HasValue) return -1;
            return Math.Abs(a.Value).CompareTo(Math.Abs(b.Value));
        }
    }

    public sealed class AuditStateDriver : IAuditTool
    {
        private enum Phase { Warmup, Reset, WaitSettle, Snapshot, VolatileWait, VolatileSnapshot, Done }

        public string ToolId { get { return "state"; } }
        public bool RequiresPlayMode { get { return true; } }
        public int DefaultTimeoutSeconds { get { return 1800; } }

        private AuditContext _ctx;
        private GameObject _avatar;
        private Animator _anim;
        private object _module;              // ModuleVrc3 实例（反射），未接管时为 null
        private bool _gmControlled;
        private string _gmNote;
        private bool _gmCullingWasOn;
        private bool _gmCreatedByAudit;   // 场景里原本没有 GM，本次在 Play 模式临时建了 __AvatarAudit_GM

        private readonly Dictionary<string, AnimatorControllerParameter> _animParams = new Dictionary<string, AnimatorControllerParameter>();
        private readonly List<string> _trackBones = new List<string>();
        private readonly List<string> _paramNames = new List<string>();
        private readonly Dictionary<string, float> _defaults = new Dictionary<string, float>();
        private readonly Dictionary<string, string> _defaultSource = new Dictionary<string, string>();
        private readonly Dictionary<string, float> _initialValues = new Dictionary<string, float>();
        private readonly HashSet<string> _declaredExpr = new HashSet<string>(StringComparer.Ordinal);
        // _resetNamesAll = 表达参数 − VRChat 内置（任务 Q 的旧「可复位集合」）。
        // _resetNames    = 本批实际复位的集合：declared/startup 时再减去「被驱动器维护且用户不能直接点」的参数（任务 AD）。
        private readonly HashSet<string> _resetNamesAll = new HashSet<string>(StringComparer.Ordinal);
        private readonly HashSet<string> _resetNames = new HashSet<string>(StringComparer.Ordinal);

        // 复位值来源（任务 Q）：
        //   _declaredDefaults = 头像 VRCExpressionParameters 每个参数声明的 defaultValue（反射读，字段名以 SDK 为准）
        //   _resetValues      = 本批实际用于复位的值，按 _resetMode 取声明默认或启动实值
        //   _resetFallbackParams = 声明默认读不到、退回启动实值的参数（逐个写进 warnings）
        private readonly Dictionary<string, float> _declaredDefaults = new Dictionary<string, float>(StringComparer.Ordinal);
        private readonly Dictionary<string, float> _resetValues = new Dictionary<string, float>(StringComparer.Ordinal);
        private readonly List<string> _resetFallbackParams = new List<string>();
        private string _resetMode = "declared";              // declared | startup | none
        private string _resetPrimarySource = "declared_default";
        private string _curResetSource = "declared_default";
        private int _curResetCount;

        // 任务 AD：VRCAvatarParameterDriver 维护的内部参数。
        //   _driverTargets       = 参数名 → 写它的位置列表（控制器/层/状态机/状态/ChangeType）
        //   _driverTargetOrder   = driver_targets 输出的稳定顺序
        //   _resetExcludedDriverTargets = 因「被驱动且用户不能直接点」而从复位集合里排除的参数
        //   _driverTargetsUserClickable = 同时直接出现在表达菜单控件里（用户也能点）、因此仍然复位的被驱动参数
        private readonly Dictionary<string, List<DriverWriter>> _driverTargets =
            new Dictionary<string, List<DriverWriter>>(StringComparer.Ordinal);
        private readonly List<string> _driverTargetOrder = new List<string>();
        private readonly List<string> _resetExcludedDriverTargets = new List<string>();
        private readonly List<string> _driverTargetsUserClickable = new List<string>();
        // 任务 BR（B-补-19 返工）：每个状态「进入条件」里读到的参数（含比较模式/阈值）。
        // 只有「写该参数的 Driver 所在状态的入转移条件读同一参数、且是钳位式不等式比较」才允许 driver_set 放行。
        private readonly Dictionary<string, List<ClampCondition>> _stateEntryConds =
            new Dictionary<string, List<ClampCondition>>(StringComparer.Ordinal);
        private readonly List<string> _driverScanWarnings = new List<string>();
        private readonly List<string> _driverControllersScanned = new List<string>();
        private int _driverStatesScanned;
        private bool _resetDriverTargets;                    // 请求字段 reset_driver_targets，默认 false

        // ---- T-13（T1 v4）----
        private bool _versionCheck = true;                   // 请求字段 version_check，默认 true
        private JsonObject _toolVersion;                     // 输出头 tool_version（源 hash / 编译时间）
        private bool _sequence;                              // 请求字段 sequence（缺省时 reset==none 即视为序列）
        private readonly Dictionary<string, int> _gearSlots = new Dictionary<string, int>(StringComparer.Ordinal);
        private readonly Dictionary<string, string> _gearSource = new Dictionary<string, string>(StringComparer.Ordinal);
        private float _readbackEps = 0.001f;
        private bool _readbackFailed;
        private readonly List<string> _readbackFailures = new List<string>();
        // 任务 BJ（B-补-19）：请求级 expect_override 默认 + 是否允许「驱动器 Set 值命中实际读回」自动放行。
        private readonly Dictionary<string, OverrideSpec> _expectOverrideDefault = new Dictionary<string, OverrideSpec>(StringComparer.Ordinal);
        private bool _readbackDriverOverride = true;      // 请求字段 readback_driver_override，默认 true
        private readonly List<JsonObject> _readbackOverrides = new List<JsonObject>();
        // 任务 BJ（B-T08a / R9）：候选循环。_candidates 是解析后的候选；_candidateRows 是已跑出的行。
        private readonly List<CandidateSpec> _candidates = new List<CandidateSpec>();
        private readonly List<CandidateRow> _candidateRows = new List<CandidateRow>();
        private bool _candidatesReference = true;             // 请求字段 candidates_reference，默认 true（内嵌 containment 参考列）
        // 任务 CS（B-T08a 修补）：请求级 candidates_zero——施加候选前先把这些键在该候选 mesh 上清零；
        // 空 = 旧行为（不清零，只写候选自己的键）。
        private readonly List<string> _candidatesZero = new List<string>();
        // 任务 CS：每个候选行两两「度量完全一致」的告警用；置 true 时该状态 recommended 置 null。
        private readonly List<string> _expectVisibleDefault = new List<string>();
        private readonly List<string> _expectHiddenDefault = new List<string>();
        private readonly List<SentinelSpec> _sentinelPositive = new List<SentinelSpec>();
        private readonly List<SentinelSpec> _sentinelNegative = new List<SentinelSpec>();
        private bool _sentinelsEligible;                     // 请求里有 sentinels 才跑
        private bool _sentinelsDone;
        private bool _sentinelFailed;
        private JsonObject _sentinelResults;
        private readonly List<string> _sentinelFailures = new List<string>();
        // V4 缓存：同一 mesh 的三桶比例与状态无关（绑定姿态 + 骨架结构），每次运行只算一次。
        private readonly Dictionary<int, JsonObject> _v4Cache = new Dictionary<int, JsonObject>();

        private readonly List<AuditStateSpec> _states = new List<AuditStateSpec>();
        private readonly List<Dictionary<string, AuditStateSnapshot>> _passSnaps = new List<Dictionary<string, AuditStateSnapshot>>();
        private readonly List<string> _stateFileNames = new List<string>();

        // 任务 R：请求里的纯数据探针（grab_chain / coincident / containment / range），每个状态快照后执行。
        private readonly List<string> _probeRequests = new List<string>();

        // 任务 U：探针前临时形态键覆盖（请求 pre_probe_blendshapes），快照后设、探针后恢复。
        private readonly List<PreProbeShape> _preProbeShapes = new List<PreProbeShape>();
        private readonly List<ShapeRestore> _preProbeRestores = new List<ShapeRestore>();

        // 当前状态施加过程中的临时记录
        private readonly Dictionary<string, string> _curSources = new Dictionary<string, string>();
        private readonly List<string> _curMissing = new List<string>();
        private readonly List<string> _curWarnings = new List<string>();

        private int _passCount = 1;
        private int _passIndex;
        private int _stateIndex;
        private Phase _phase = Phase.Warmup;
        private int _targetFrame;
        private int _settleFrames = 30;
        private float _blendEps = 0.0001f;

        // volatile 探测：第一个状态连采两次，两次不同的形态键（多为随时间自动播放的面部键）
        private bool _volatileProbe = true;
        private bool _volatileProbed;
        private AuditStateSnapshot _volatileFirst;
        private readonly Dictionary<string, VolatileShape> _volatileShapes = new Dictionary<string, VolatileShape>(StringComparer.Ordinal);
        private readonly List<string> _volatileOrder = new List<string>();

        // 健全性检查：任一状态塌掉就把整批 status 置 error
        private bool _sanityFailed;
        private readonly List<string> _sanityFailures = new List<string>();

        private sealed class VolatileShape
        {
            public string Path;
            public string Shape;
            public float First;
            public float Second;
        }

        /// <summary>任务 U：请求 pre_probe_blendshapes 的一项（原始请求，渲染器/形态键在应用时才解析）。</summary>
        private sealed class PreProbeShape
        {
            public string Renderer;
            public string Shape;
            public float Weight;
        }

        /// <summary>任务 U：探针结束要还原的一个形态键原值。</summary>
        private sealed class ShapeRestore
        {
            public SkinnedMeshRenderer Smr;
            public int Index;
            public float OldWeight;
        }

        /// <summary>任务 AD：一条「谁在写这个参数」记录（输出 states.json.driver_targets 用）。</summary>
        private sealed class DriverWriter
        {
            public string Controller;
            public string Layer;
            public string LayerType;
            public string StateMachine;
            public string State;
            public string ChangeType;
            public string Source;   // Copy 的源参数；其它类型为空
            /// <summary>B-补-19：Set 类型的常量写值（用于判断读回不一致是否由驱动器合法改写）。</summary>
            public float Value;
            public bool HasValue;
        }

        /// <summary>
        /// 任务 BR（B-补-19 返工）：一条「进入某状态的转移条件」里读到的参数。
        /// 用来判「驱动器所在状态是不是因为这个参数越界而进入的（钳位）」。
        /// </summary>
        private sealed class ClampCondition
        {
            public string Param;
            public string Mode;        // AnimatorConditionMode 的名字：If / IfNot / Greater / Less / Equals / NotEqual
            public float Threshold;

            public string ModeSymbol
            {
                get
                {
                    if (string.Equals(Mode, "Greater", StringComparison.OrdinalIgnoreCase)) return ">";
                    if (string.Equals(Mode, "Less", StringComparison.OrdinalIgnoreCase)) return "<";
                    return Mode;
                }
            }
        }

        /// <summary>
        /// T-13 哨兵一项：正样本 = 注入已知缺陷（perturb 形态键 / 材质队列），负样本 = 隐藏被测件。
        /// 解析在 Begin，执行在第一个状态上；任一不过 → 整批 aborted。
        /// </summary>
        private sealed class SentinelSpec
        {
            public string Kind;       // positive | negative
            public int Index;
            public string Renderer;   // 必填（名 / 层级路径 / 子串）
            public string Shape;      // positive：形态键名；可换成 material_queue
            public float Weight;      // positive：perturb 到该权重（缺省 0）
            public float Queue;       // positive：改材质 renderQueue 的备选注入
            public bool Hide;         // negative：隐藏
            public JsonObject Raw;    // 原始请求项（回显）
        }

        /// <summary>
        /// 任务 BJ（B-T08a / R9 脚鞋选型）：请求字段 candidates 的一项。
        /// 语义：对某件（鞋/袜）逐个候选形态键配置施加 → 跑一次 T-28a 静态穿出斑块（poke）→ 还原。
        /// part 分组出表（r9_&lt;part&gt;.json）；mesh 是形态键施加目标；garment 是 poke 配对的衣物
        /// （缺省与 mesh 相同，但更常见的是 mesh=身体、garment=鞋）。
        /// </summary>
        private sealed class CandidateSpec
        {
            public string Id;                                       // 候选标签（缺省由 keys 生成）
            public string Part;                                     // 分组 / 输出文件名 / 排序表名
            public string Mesh;                                     // 形态键施加目标（渲染器名或路径）
            public string Garment;                                  // poke 配对衣物；缺省 = Mesh
            public string Body;                                     // 可选身体网格
            public readonly List<string> Covers = new List<string>(); // poke covers；缺省沿用请求 poke_covers
            public readonly HashSet<string> States = new HashSet<string>(StringComparer.Ordinal); // 只在这些状态上跑；空=全部
            public readonly Dictionary<string, float> Keys = new Dictionary<string, float>(StringComparer.Ordinal);
            // 任务 CS：候选级清零域，覆盖请求级 candidates_zero；HasZeroKeys=true 时即使数组为空也覆盖成「不清零」。
            public readonly List<string> ZeroKeys = new List<string>();
            public bool HasZeroKeys;
            public int Index;
            public float? MaxTotalPatchCm2;                         // 硬约束（可选）
            public int? MinOpeningVerts;                            // 硬约束（可选）
        }

        /// <summary>任务 BJ/BZ：一个 (状态, 候选) 的度量行。排序用斑块面积/深度、|sd p50|、跟隙、|d_v p50|；穿越计数只作参考。</summary>
        private sealed class CandidateRow
        {
            public string State;
            public string CandidateId;
            public string Part;
            public readonly Dictionary<string, float> Keys = new Dictionary<string, float>(StringComparer.Ordinal);
            // 任务 CS：清零域里在该候选 mesh 上匹配到的键 → 清零前的旧值。
            public readonly Dictionary<string, float> ZeroApplied = new Dictionary<string, float>(StringComparer.Ordinal);
            // 任务 CS：本次写过的键 → 写完（清零 + 候选键都施加完）后 GetBlendShapeWeight 读回的值。
            public readonly Dictionary<string, float> AppliedReadback = new Dictionary<string, float>(StringComparer.Ordinal);
            // 任务 CS：清零域里在该 mesh 上没匹配到的键（不算 hard 失败，只记录）。
            public readonly List<string> ZeroMissing = new List<string>();
            // 任务 CS：同一状态内度量完全一致的其它候选 id（互相标记）。
            public readonly List<string> IndistinguishableWith = new List<string>();
            public bool HardOk = true;
            public readonly List<string> HardReasons = new List<string>();
            public bool Error;
            public string ErrorMessage;
            public string Garment;
            public string PairConfidence;
            public int PatchCount;
            public double TotalAreaCm2;
            public double MaxPatchAreaCm2;
            public double MaxDepthMm;
            public double? DepthP50Mm;
            // 任务 BZ（R9）：鞋底有向距离 sd（正=脚在鞋底上方、负=穿出鞋底）与跟隙（脚跟段到鞋底 p50）。
            public double? SdP05Mm;
            public double? SdP50Mm;
            public double? SdP95Mm;
            public int SdVertCount;
            public int SdFootVerts;
            public double? HeelGapP50Mm;
            public int HeelVertCount;
            // 任务 CF（R9 v2）：鞋垫面距离 si（正=悬空、负=陷入鞋垫）、脚底/鞋垫倾角、鞋垫面数。
            public double? SiP05Mm;
            public double? SiP50Mm;
            public double? SiP95Mm;
            public int SiVertCount;
            public int InsoleFaces;
            public double? TiltDeg;
            public double? FootPlaneTiltDeg;
            public double? InsolePlaneTiltDeg;
            public double? HeelGapSoleP50Mm;   // 旧口径（到外底），诊断列
            public int OpeningVerts;
            public int OpeningDeepVerts;
            public bool Truncated;
            // 任务 CW：该状态 low_confidence / top2_gap_ratio=0 / state_indistinguishable 时，
            // 四个 patch 列在输出里被抑制为 null（内部排序仍用原值），并在行上写 patch_verdict。
            public bool PatchColumnsSuppressed;
            // 任务 CW：面积门槛与「被丢掉的分量」诊断（来自本行最佳配对），抑制四列时仍照写，
            // 让读表的人能看到「0 斑块是因为门槛/断连而非无穿出」。
            public bool SuspectSubthreshold;
            public int DroppedComponents;
            public double DroppedMaxAreaCm2;
            public double DroppedTotalAreaCm2;
            public double DroppedMaxDepthMm;
            public double AreaPerVertCm2;
            // 任务 CX：area_per_vert_cm2 的位置口径（bind_pose=稳定参考 / baked=sharedMesh 读不到时的回落）。
            public string AreaPerVertPosSource;
            public double MinPatchAreaCm2;
            public string MinPatchAreaSource;
            public object BySubPart;
            public object Reference;
            public object BodyExcluded;
            public int Rank;                                        // 0 = 未排序（硬约束不过或出错）
        }

        /// <summary>
        /// VRChat 内置参数（判定「用户可控」时要排除）。
        /// 来源：GestureManager 3.9.9 Scripts/Editor/Modules/Vrc3/Vrc3DefaultParams.cs 的 Parameters
        /// （含 GM 自用的 VRCFaceBlendH/V、VRCEmote），再加 VRChat 官方内置名。
        /// </summary>
        private static readonly HashSet<string> BuiltinParams = new HashSet<string>(StringComparer.Ordinal)
        {
            // ---- Vrc3DefaultParams.Parameters ----
            "GestureRightWeight", "ScaleFactorInverse", "EyeHeightAsPercent", "EyeHeightAsMeters",
            "GestureLeftWeight", "VelocityMagnitude", "IsAnimatorEnabled", "IsOnFriendsList",
            "VRCFaceBlendH", "VRCFaceBlendV", "ScaleModified", "AvatarVersion", "TrackingType",
            "GestureRight", "ScaleFactor", "GestureLeft", "PreviewMode", "VelocityX", "VelocityY",
            "VelocityZ", "InStation", "AngularY", "Earmuffs", "Grounded", "MuteSelf", "VRCEmote",
            "Upright", "IsLocal", "Seated", "VRMode", "Voice", "Viseme", "AFK",
            // ---- VRChat 官方内置名（任务书列出的，补齐 GM 列表未单列的）----
            "GestureLeft", "GestureRight", "GestureLeftWeight", "GestureRightWeight", "AngularY",
            "VelocityX", "VelocityY", "VelocityZ", "VelocityMagnitude", "Upright", "Grounded",
            "Seated", "AFK", "TrackingType", "VRMode", "MuteSelf", "InStation", "Earmuffs",
            "IsOnFriendsList", "AvatarVersion", "IsAnimatorEnabled", "ScaleModified", "ScaleFactor",
            "ScaleFactorInverse", "EyeHeightAsMeters", "EyeHeightAsPercent", "PreviewMode",
            "IsLocal", "Viseme", "Voice"
        };

        // ------------------------------------------------------------------ Begin

        public void Begin(AuditContext ctx)
        {
            _ctx = ctx;
            // T-13：先过版本戳，再碰任何场景对象。部署树 hash 与 Assets/AvatarAudit/VERSION 里的 hash
            // 不一致 = 现在跑的 asmdef 不是那份源编出来的（远程断开时 Unity 不重编译，02:07 记录），
            // 直接拒跑；确要离线/调试可请求 version_check:false 并在结论里标「未过版本戳」。
            _versionCheck = ctx.B("version_check", true);
            _toolVersion = AuditToolVersion.Describe(AuditRunner.ProjectRoot, typeof(AuditStateDriver), _versionCheck);
            if (_versionCheck && !AuditJson.Bool(_toolVersion, "match", false))
            {
                throw new Exception("版本戳不一致，拒跑：tool_version.source_hash="
                    + (AuditJson.Str(_toolVersion, "source_hash", "<null>"))
                    + "，Assets/AvatarAudit/VERSION.hash="
                    + (AuditJson.Str(_toolVersion, "version_file_hash", "<null>"))
                    + (string.IsNullOrEmpty(AuditJson.Str(_toolVersion, "note", null)) ? "" : "；" + AuditJson.Str(_toolVersion, "note", null))
                    + "。若确要跑（离线/调试），在请求里加 \"version_check\": false，该批次必须标注未过版本戳。");
            }

            _settleFrames = Mathf.Max(0, ctx.I("settle_frames", 30));
            _blendEps = Mathf.Abs((float)ctx.N("blendshape_epsilon", 0.0001));
            _volatileProbe = ctx.B("volatile_probe", true);
            _resetMode = NormalizeResetMode(ctx.S("reset", "declared"));
            if (_resetMode == null)
            {
                ctx.Warn("请求里的 reset='" + ctx.S("reset", "") + "' 不是 declared / startup / none，已按默认 declared 处理。");
                _resetMode = "declared";
            }
            // 任务 AD：默认 false = 复位时跳过被参数驱动器维护、且用户不能直接点的参数。
            _resetDriverTargets = ctx.B("reset_driver_targets", false);

            var avatarName = ctx.S("avatar");
            _avatar = AuditAvatar.Resolve(avatarName);
            ctx.Avatar = _avatar;
            _anim = _avatar.GetComponent<Animator>();
            if (_anim == null) throw new Exception("头像 '" + _avatar.name + "' 上没有 Animator，无法施加参数");
            ctx.Animator = _anim;

            // GM 接管
            if (ctx.B("ensure_gm", true))
            {
                _module = GmgBridge.EnsureControlled(_avatar, out _gmNote);
            }
            else
            {
                GmgBridge.EnsureInit();
                _module = GmgBridge.GetControlledModule(_avatar);
                _gmNote = _module != null ? "already_controlled" : "请求里 ensure_gm=false，不主动接管";
            }
            _gmControlled = _module != null;
            _gmCreatedByAudit = GmgBridge.CreatedByAudit;

            if (_gmControlled)
            {
                bool on;
                if (GmgBridge.TryGetSimulateCulling(_module, out on) && on)
                {
                    if (GmgBridge.TrySetSimulateCulling(_module, false))
                    {
                        _gmCullingWasOn = true;
                        ctx.Warn("GM 的 simulateCulling 原本是开的，审查期间已临时关闭（结束恢复）。不关的话 GM 会按相机距离把整个头像 renderer.enabled 置 false，快照全是不可见。");
                    }
                }
            }
            else
            {
                ctx.Warn("GestureManager 没有接管这个头像（" + _gmNote + "）。参数只写到 Animator，VRC_AvatarParameterDriver / LayerControl 不会被模拟，本份结论必须降级使用。");
            }

            // Animator 参数表（GM 接管后 runtimeAnimatorController 常被 GM 置 null，这里会是空表）
            _animParams.Clear();
            var aps = _anim.parameters;
            for (int i = 0; i < aps.Length; i++) _animParams[aps[i].name] = aps[i];

            ParseTrackBones(ctx);
            ParseStates(ctx);
            // 任务 AD：先扫驱动器目标，BuildParamUniverse 才能把它们从复位集合里排除。
            ScanDriverTargets(ctx);
            BuildParamUniverse();
            ParseProbes(ctx);
            ParsePreProbeBlendshapes(ctx);
            ParseCandidates(ctx);
            ParseGearSlots(ctx);
            ParseSentinels(ctx);
            ParseExpectations(ctx);
            _sequence = ctx.B("sequence", string.Equals(_resetMode, "none", StringComparison.Ordinal));

            _passCount = ctx.B("repeat_check", false) ? 2 : 1;
            for (int i = 0; i < _passCount; i++) _passSnaps.Add(new Dictionary<string, AuditStateSnapshot>());

            _targetFrame = Time.frameCount + Mathf.Max(1, ctx.I("warmup_frames", 10));
            _phase = Phase.Warmup;

            ctx.Status.Log("T1 起始：头像=" + _avatar.name + "，GM 接管=" + _gmControlled + "（" + _gmNote + "），"
                + "参数总数=" + _paramNames.Count + "，可复位(用户可控)=" + _resetNames.Count + "，reset=" + _resetMode
                + "，驱动器目标=" + _driverTargets.Count + "（排除复位 " + _resetExcludedDriverTargets.Count
                + "，用户可点仍复位 " + _driverTargetsUserClickable.Count + "，reset_driver_targets=" + _resetDriverTargets + "）"
                + "，状态数=" + _states.Count
                + "，探针=" + (_probeRequests.Count == 0 ? "无" : string.Join("+", _probeRequests.ToArray()))
                + "，探针前临时形态键=" + (_preProbeShapes.Count == 0 ? "无" : _preProbeShapes.Count + " 项")
                + "，settle=" + _settleFrames + "，遍数=" + _passCount + "，volatile_probe=" + _volatileProbe);
            ctx.Status.Log("T-13 v4：version_check=" + _versionCheck
                + "，source_hash=" + AuditJson.Str(_toolVersion, "source_hash", "<null>")
                + "，match=" + AuditJson.Bool(_toolVersion, "match", false)
                + "，哨兵正/负=" + _sentinelPositive.Count + "/" + _sentinelNegative.Count
                + "，sequence=" + _sequence
                + "，gear_slots=" + (_gearSlots.Count == 0 ? "无" : string.Join(",", _gearSlots.Select(kv => kv.Key + ":" + kv.Value).ToArray())));
        }

        /// <summary>请求字段 "reset"：declared（默认，表达参数声明默认）/ startup（T1 启动实值）/ none（不复位）。非法值返回 null 由调用方 warning。</summary>
        private static string NormalizeResetMode(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return "declared";
            switch (raw.Trim().ToLowerInvariant())
            {
                case "declared": return "declared";
                case "startup": return "startup";
                case "none": return "none";
                default: return null;
            }
        }

        private void ParseTrackBones(AuditContext ctx)
        {
            var arr = ctx.A("track_bones");
            if (arr.Count == 0)
            {
                _trackBones.AddRange(new[] { "Hips", "LeftFoot", "RightFoot", "LeftToes", "RightToes", "Head" });
            }
            else
            {
                foreach (var v in arr) { var s = v as string; if (!string.IsNullOrEmpty(s)) _trackBones.Add(s); }
            }
        }

        private void ParseStates(AuditContext ctx)
        {
            var arr = ctx.A("states");
            if (arr.Count == 0) throw new Exception("请求里 states 为空，没有可跑的状态");

            var seen = new HashSet<string>();
            foreach (var item in arr)
            {
                var o = item as JsonObject;
                if (o == null) continue;
                var spec = new AuditStateSpec();
                spec.Id = AuditJson.Str(o, "id", null);
                if (string.IsNullOrEmpty(spec.Id)) spec.Id = "state" + _states.Count;
                if (!seen.Add(spec.Id)) throw new Exception("states 里有重复 id：" + spec.Id);
                spec.Pose = AuditJson.Str(o, "pose", null);

                var po = AuditJson.Obj(o, "params");
                if (po != null)
                {
                    foreach (var kv in po.Items) spec.Params[kv.Key] = AuditUtil.ToFloat(kv.Value);
                }
                // T-13：序列 history = 本状态之前出现过的状态 id（按请求顺序）。
                for (int i = 0; i < _states.Count; i++) spec.History.Add(_states[i].Id);
                spec.ExpectVisible.AddRange(ReadStringList(o, "expect_visible"));
                spec.ExpectHidden.AddRange(ReadStringList(o, "expect_hidden"));
                ReadOverrideMap(AuditJson.Obj(o, "expect_override"), spec.ExpectOverride, ctx, "states[" + spec.Id + "].expect_override");
                _states.Add(spec);
            }
            if (_states.Count == 0) throw new Exception("请求里 states 解析后为空");
        }

        /// <summary>
        /// 任务 R：解析请求里的可选字段 "probes"。已知名见 AuditProbes.Known；未知名记 warning 后跳过。
        /// 缺省（请求里没有 probes 或为空）不跑任何探针，输出与旧版完全一致。
        /// </summary>
        private void ParseProbes(AuditContext ctx)
        {
            _probeRequests.Clear();
            var arr = ctx.A("probes");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < arr.Count; i++)
            {
                var s = arr[i] as string;
                if (s == null) s = Convert.ToString(arr[i], System.Globalization.CultureInfo.InvariantCulture);
                if (string.IsNullOrEmpty(s)) continue;
                s = s.Trim();
                if (s.Length == 0 || !seen.Add(s)) continue;
                if (!AuditProbes.IsKnown(s))
                {
                    ctx.Warn("请求 probes 里的 '" + s + "' 不是已知探针（" + string.Join(" / ", AuditProbes.Known) + "），已跳过。");
                    continue;
                }
                _probeRequests.Add(s);
            }
            if (_probeRequests.Count == 0 && arr.Count > 0)
                ctx.Warn("请求里 probes 非空但没有一个是已知探针，本次不跑任何探针。");
        }

        /// <summary>
        /// 任务 U：解析请求里的可选字段 "pre_probe_blendshapes": [{renderer, shape, weight}]。
        /// 在每个状态快照之后、探针之前临时设置，探针结束立即还原；没有请求探针时不生效（记 warning）。
        /// 渲染器在应用时才按 GameObject 名 / 路径解析；形态键名支持 AAO 改名后的
        /// AAO_Merged_&lt;原名&gt;_&lt;n&gt; 模糊匹配。
        /// </summary>
        private void ParsePreProbeBlendshapes(AuditContext ctx)
        {
            _preProbeShapes.Clear();
            var arr = ctx.A("pre_probe_blendshapes");
            for (int i = 0; i < arr.Count; i++)
            {
                var o = arr[i] as JsonObject;
                if (o == null)
                {
                    ctx.Warn("pre_probe_blendshapes 第 " + i + " 项不是对象，已跳过。");
                    continue;
                }
                string renderer = AuditJson.Str(o, "renderer", null);
                string shape = AuditJson.Str(o, "shape", null);
                if (string.IsNullOrEmpty(renderer) || string.IsNullOrEmpty(shape))
                {
                    ctx.Warn("pre_probe_blendshapes 第 " + i + " 项缺 renderer 或 shape，已跳过。");
                    continue;
                }
                var s = new PreProbeShape();
                s.Renderer = renderer.Trim();
                s.Shape = shape.Trim();
                s.Weight = (float)AuditJson.Num(o, "weight", 0);
                _preProbeShapes.Add(s);
            }
            if (_preProbeShapes.Count > 0 && _probeRequests.Count == 0)
                ctx.Warn("请求里写了 pre_probe_blendshapes 但没有 probes：临时形态键只在探针前生效，本次不会设置任何键"
                    + "（它只影响探针读数，不改快照里记录的原始形态键）。");
            if (_preProbeShapes.Count > 0)
                ctx.Status.Log("pre_probe_blendshapes：" + _preProbeShapes.Count + " 项，将在每个状态快照后、探针前临时设置并还原。");
        }

        /// <summary>
        /// 任务 BJ（B-T08a / R9）：解析请求里的可选字段 "candidates"：
        /// [{id?, part, mesh, garment?, body?, covers?, states?, keys:{形态键:权重}, hard?:{...}}…]。
        /// 按 part 分组，每个状态对每个候选：施加 keys → 跑 T-28a poke → 还原；最后写 r9_&lt;part&gt;.json。
        /// 缺省（没有 candidates）不跑，输出与旧版完全一致。
        /// </summary>
        private void ParseCandidates(AuditContext ctx)
        {
            _candidates.Clear();
            _candidateRows.Clear();
            _candidatesReference = ctx.B("candidates_reference", true);
            // 任务 CS：请求级清零域（默认空 = 旧行为）。候选级 zero_keys 覆盖它。
            _candidatesZero.Clear();
            _candidatesZero.AddRange(ReadStringList(ctx.Request, "candidates_zero"));
            var arr = ctx.A("candidates");
            for (int i = 0; i < arr.Count; i++)
            {
                var o = arr[i] as JsonObject;
                if (o == null)
                {
                    ctx.Warn("candidates 第 " + i + " 项不是对象，已跳过。");
                    continue;
                }
                var c = new CandidateSpec();
                c.Index = i;
                c.Part = AuditJson.Str(o, "part", null);
                c.Mesh = AuditJson.Str(o, "mesh", null);
                c.Garment = AuditJson.Str(o, "garment", null);
                c.Body = AuditJson.Str(o, "body", null);
                if (string.IsNullOrEmpty(c.Part)) c.Part = "part" + i;
                if (string.IsNullOrEmpty(c.Mesh) && string.IsNullOrEmpty(c.Garment))
                {
                    ctx.Warn("candidates[" + i + "]（part=" + c.Part + "）缺 mesh 与 garment，已跳过。");
                    continue;
                }
                if (string.IsNullOrEmpty(c.Garment)) c.Garment = c.Mesh;
                var keys = AuditJson.Obj(o, "keys");
                if (keys != null)
                    foreach (var kv in keys.Items) c.Keys[kv.Key] = AuditUtil.ToFloat(kv.Value);
                // 任务 CS：候选级 zero_keys 覆盖请求级 candidates_zero；显式空数组 = 该候选不清零。
                c.HasZeroKeys = o.Has("zero_keys");
                if (c.HasZeroKeys) c.ZeroKeys.AddRange(ReadStringList(o, "zero_keys"));
                c.Covers.AddRange(ReadStringList(o, "covers"));
                var states = AuditJson.Arr(o, "states");
                for (int k = 0; k < states.Count; k++)
                {
                    string s = states[k] as string;
                    if (s == null) s = Convert.ToString(states[k], System.Globalization.CultureInfo.InvariantCulture);
                    if (!string.IsNullOrEmpty(s)) c.States.Add(s.Trim());
                }
                var hard = AuditJson.Obj(o, "hard");
                if (hard != null)
                {
                    if (hard.Has("max_total_patch_area_cm2"))
                    {
                        float mv = (float)AuditJson.Num(hard, "max_total_patch_area_cm2", double.NaN);
                        if (!float.IsNaN(mv) && !float.IsInfinity(mv)) c.MaxTotalPatchCm2 = mv;
                    }
                    if (hard.Has("min_opening_verts")) c.MinOpeningVerts = AuditJson.Int(hard, "min_opening_verts", 0);
                }
                c.Id = AuditJson.Str(o, "id", null);
                if (string.IsNullOrEmpty(c.Id)) c.Id = DefaultCandidateId(c.Keys);
                _candidates.Add(c);
            }
            if (_candidates.Count > 0)
                ctx.Status.Log("B-T08a/R9：candidates " + _candidates.Count + " 项，按 part 分组 "
                    + string.Join("/", _candidates.Select(x => x.Part).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToArray())
                    + "；每个状态逐候选施加→poke→还原，输出 r9_<part>.json（candidates_reference=" + _candidatesReference
                    + "，请求级 candidates_zero=" + (_candidatesZero.Count == 0 ? "无" : string.Join("+", _candidatesZero.ToArray())) + "）。");
        }

        /// <summary>候选缺省标签：把 keys 按名排序拼成 key=value（空 keys → "none"）。</summary>
        private static string DefaultCandidateId(Dictionary<string, float> keys)
        {
            if (keys == null || keys.Count == 0) return "none";
            var parts = new List<string>();
            foreach (var k in keys.Keys.OrderBy(x => x, StringComparer.Ordinal))
                parts.Add(k + "=" + AuditUtil.F(keys[k]));
            return string.Join("+", parts.ToArray());
        }

        // ------------------------------------------------------------------ T-13 解析

        private static List<string> ReadStringList(JsonObject o, string key)
        {
            var res = new List<string>();
            if (o == null) return res;
            var arr = AuditJson.Arr(o, key);
            for (int i = 0; i < arr.Count; i++)
            {
                var s = arr[i] as string;
                if (s == null) s = Convert.ToString(arr[i]);
                if (!string.IsNullOrEmpty(s)) res.Add(s.Trim());
            }
            return res;
        }

        /// <summary>请求字段 gear_slots: {"参数名": 档位数}，槽号按 i/n 最近格算（见 InferGearSlots）。</summary>
        private void ParseGearSlots(AuditContext ctx)
        {
            _gearSlots.Clear();
            _gearSource.Clear();
            var o = ctx.O("gear_slots");
            if (o != null)
            {
                foreach (var kv in o.Items)
                {
                    int n = (int)Math.Round(AuditUtil.ToFloat(kv.Value));
                    if (n < 1 || n > 4096)
                    {
                        ctx.Warn("gear_slots['" + kv.Key + "']=" + kv.Value + " 不是 1..4096 的档位数，已忽略。");
                        continue;
                    }
                    _gearSlots[kv.Key] = n;
                    _gearSource[kv.Key] = "request";
                }
            }
            InferGearSlots();
        }

        /// <summary>
        /// 未显式给档位数的参数，从本批出现过的取值推断：只认「都在 [0,1)、且都落在 i/n 格上（误差 ≤1e-3）」
        /// 的轮盘类参数；0/1 toggle 不做槽号（它没有中间档）。推断不出就不给槽号——宁缺勿猜。
        /// </summary>
        private void InferGearSlots()
        {
            if (_states.Count == 0) return;
            var vals = new Dictionary<string, List<float>>(StringComparer.Ordinal);
            foreach (var st in _states)
            {
                foreach (var kv in st.Params)
                {
                    List<float> l;
                    if (!vals.TryGetValue(kv.Key, out l)) { l = new List<float>(); vals[kv.Key] = l; }
                    bool seen = false;
                    for (int i = 0; i < l.Count; i++) if (Math.Abs(l[i] - kv.Value) <= 1e-6f) { seen = true; break; }
                    if (!seen) l.Add(kv.Value);
                }
            }

            foreach (var kv in vals)
            {
                if (_gearSlots.ContainsKey(kv.Key)) continue;
                var list = kv.Value;
                int best = InferGearSlotCount(list);
                if (best >= 2)
                {
                    _gearSlots[kv.Key] = best;
                    _gearSource[kv.Key] = "inferred_from_batch";
                    if (_ctx != null)
                        _ctx.Status.Log("T-13：从本批取值推断参数 '" + kv.Key + "' 为 " + best
                            + " 档轮盘（槽号按 i/n 最近格；显式档位表可用请求 gear_slots 覆盖）。");
                }
            }
        }

        /// <summary>
        /// 从一批取值推断轮盘档位数：只认「都在 [0,1)、且都落在 i/n 格上（误差 ≤1e-3）」的参数；
        /// 含 1 的多半是 toggle，不做槽号。推不出返回 0（宁缺勿猜）。纯逻辑，供离线自检直接调用。
        /// </summary>
        public static int InferGearSlotCount(List<float> list)
        {
            if (list == null || list.Count < 2) return 0;

            bool allUnit = true;
            float max = list[0];
            for (int i = 0; i < list.Count; i++)
            {
                if (list[i] < 0f || list[i] > 1f) allUnit = false;
                if (list[i] > max) max = list[i];
            }
            if (!allUnit || max >= 1f - 1e-4f) return 0;

            for (int n = 2; n <= 64; n++)
            {
                bool ok = true;
                for (int i = 0; i < list.Count; i++)
                {
                    double k = Math.Round(list[i] * (double)n);
                    if (k < 0 || k > n - 1) { ok = false; break; }
                    if (Math.Abs(list[i] * (double)n - k) > 1e-3) { ok = false; break; }
                }
                if (ok) return n;
            }
            return 0;
        }

        /// <summary>请求字段 sentinels: {positive:[{renderer,shape,weight}], negative:[{renderer,hide}]}。</summary>
        private void ParseSentinels(AuditContext ctx)
        {
            _sentinelPositive.Clear();
            _sentinelNegative.Clear();
            _sentinelsEligible = false;
            var o = ctx.O("sentinels");
            if (o == null) return;
            ParseSentinelList(o, "positive", true, ctx);
            ParseSentinelList(o, "negative", false, ctx);
            _sentinelsEligible = _sentinelPositive.Count > 0 || _sentinelNegative.Count > 0;
            if (_sentinelsEligible)
                ctx.Status.Log("T-13 哨兵：正样本 " + _sentinelPositive.Count + "、负样本 " + _sentinelNegative.Count
                    + "；任一不过整批 status=aborted。");
        }

        private void ParseSentinelList(JsonObject o, string key, bool positive, AuditContext ctx)
        {
            var arr = AuditJson.Arr(o, key);
            for (int i = 0; i < arr.Count; i++)
            {
                var e = arr[i] as JsonObject;
                var s = new SentinelSpec();
                s.Kind = positive ? "positive" : "negative";
                s.Index = i;
                s.Raw = e;
                if (e == null) { SentinelConfigError(ctx, s, "不是对象"); continue; }
                s.Renderer = AuditJson.Str(e, "renderer", null);
                s.Shape = AuditJson.Str(e, "shape", null);
                s.Weight = (float)AuditJson.Num(e, "weight", 0);
                s.Queue = (float)AuditJson.Num(e, "material_queue", double.NaN);
                s.Hide = AuditJson.Bool(e, "hide", !positive);
                if (string.IsNullOrEmpty(s.Renderer)) { SentinelConfigError(ctx, s, "缺 renderer"); continue; }
                if (positive && string.IsNullOrEmpty(s.Shape) && !e.Has("material_queue"))
                {
                    SentinelConfigError(ctx, s, "正样本需要 shape 或 material_queue");
                    continue;
                }
                if (positive) _sentinelPositive.Add(s); else _sentinelNegative.Add(s);
            }
        }

        private void SentinelConfigError(AuditContext ctx, SentinelSpec s, string why)
        {
            var msg = "sentinels." + s.Kind + "[" + s.Index + "] 配置错误（" + why + "）";
            ctx.Warn(msg);
            _sentinelFailures.Add(msg);
            _sentinelFailed = true;
        }

        /// <summary>请求级默认期望可见/不可见集合 + 回读容差 + expect_override 默认；状态里可各自覆盖/追加。</summary>
        private void ParseExpectations(AuditContext ctx)
        {
            _expectVisibleDefault.Clear();
            _expectHiddenDefault.Clear();
            _expectVisibleDefault.AddRange(ReadStringList(ctx.Request, "expect_visible"));
            _expectHiddenDefault.AddRange(ReadStringList(ctx.Request, "expect_hidden"));
            _readbackEps = Math.Abs((float)ctx.N("readback_epsilon", 0.001));
            _expectOverrideDefault.Clear();
            ReadOverrideMap(ctx.O("expect_override"), _expectOverrideDefault, ctx, "expect_override");
            _readbackDriverOverride = ctx.B("readback_driver_override", true);
            if (_expectOverrideDefault.Count > 0 || !_readbackDriverOverride)
                ctx.Status.Log("B-补-19：回读断言放行——请求级 expect_override " + _expectOverrideDefault.Count
                    + " 项，驱动器 Set 自动放行=" + _readbackDriverOverride + "。");
        }

        /// <summary>
        /// 任务 BJ（B-补-19）：解析 expect_override 对象：{参数名: 数值 或 "any"}。
        /// 值写成 "any"（大小写不敏感）或 null = 接受任意读回值；其余按数值。
        /// </summary>
        private static void ReadOverrideMap(JsonObject o, Dictionary<string, OverrideSpec> into, AuditContext ctx, string where)
        {
            if (o == null) return;
            foreach (var kv in o.Items)
            {
                if (string.IsNullOrEmpty(kv.Key)) continue;
                var ov = new OverrideSpec();
                string s = kv.Value as string;
                if (s != null && s.Trim().Equals("any", StringComparison.OrdinalIgnoreCase))
                {
                    ov.Any = true;
                    ov.Raw = "any";
                }
                else if (kv.Value == null)
                {
                    ov.Any = true;
                    ov.Raw = "any";
                }
                else
                {
                    ov.Any = false;
                    ov.Value = AuditUtil.ToFloat(kv.Value);
                    ov.Raw = AuditUtil.F(ov.Value);
                }
                into[kv.Key] = ov;
                if (ctx != null) ctx.Status.Log(where + "：'" + kv.Key + "' 放行值=" + ov.Raw);
            }
        }

        /// <summary>
        /// 任务 U：探针前临时设置请求里的形态键，把实际生效的项记进快照。
        /// 单项失败只记 warning（那一项不设），不拖垮快照。渲染器多个模糊命中时取路径序第一个，保证可复现。
        /// </summary>
        private void ApplyPreProbeShapes(AuditStateSnapshot snap)
        {
            RestorePreProbeShapes();   // 保险：上一状态若异常残留，先还原
            if (_preProbeShapes.Count == 0) return;

            var smrs = _avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
            Array.Sort(smrs, delegate (SkinnedMeshRenderer a, SkinnedMeshRenderer b)
            {
                string pa = a == null ? "" : AuditUtil.RelPath(_avatar.transform, a.transform);
                string pb = b == null ? "" : AuditUtil.RelPath(_avatar.transform, b.transform);
                return string.CompareOrdinal(pa, pb);
            });

            for (int i = 0; i < _preProbeShapes.Count; i++)
            {
                var spec = _preProbeShapes[i];
                SkinnedMeshRenderer smr = FindPreProbeSmr(smrs, spec.Renderer);
                if (smr == null || smr.sharedMesh == null)
                {
                    snap.Warnings.Add("pre_probe_blendshapes['" + spec.Renderer + " / " + spec.Shape
                        + "'] 找不到渲染器或网格，未设置。");
                    continue;
                }
                Mesh mesh = smr.sharedMesh;
                List<int> idxs = MatchShapeIndices(mesh, spec.Shape);
                if (idxs.Count == 0)
                {
                    snap.Warnings.Add("pre_probe_blendshapes['" + spec.Renderer + " / " + spec.Shape
                        + "'] 渲染器 '" + smr.gameObject.name + "' 上找不到该形态键（含 AAO_Merged_ 模糊匹配），未设置。");
                    continue;
                }
                string path = AuditUtil.RelPath(_avatar.transform, smr.transform);
                for (int k = 0; k < idxs.Count; k++)
                {
                    int idx = idxs[k];
                    float old = smr.GetBlendShapeWeight(idx);
                    smr.SetBlendShapeWeight(idx, spec.Weight);
                    _preProbeRestores.Add(new ShapeRestore { Smr = smr, Index = idx, OldWeight = old });

                    var rec = new JsonObject();
                    rec.Set("requested_renderer", spec.Renderer);
                    rec.Set("renderer", path);
                    rec.Set("renderer_name", smr.gameObject.name);
                    rec.Set("requested_shape", spec.Shape);
                    rec.Set("shape", mesh.GetBlendShapeName(idx));
                    rec.Set("weight", (double)spec.Weight);
                    rec.Set("old_weight", (double)old);
                    snap.PreProbeBlendshapes.Add(rec);
                }
            }
            if (snap.PreProbeBlendshapes.Count == 0)
                snap.Warnings.Add("pre_probe_blendshapes：请求了 " + _preProbeShapes.Count + " 项但一项都没设上（原因见上面的 warning）。");
        }

        /// <summary>任务 U：还原探针前临时改过的全部形态键（探针结束/异常都必须调用）。</summary>
        private void RestorePreProbeShapes()
        {
            for (int i = _preProbeRestores.Count - 1; i >= 0; i--)
            {
                var r = _preProbeRestores[i];
                if (r == null || r.Smr == null) continue;
                try { r.Smr.SetBlendShapeWeight(r.Index, r.OldWeight); }
                catch { }
            }
            _preProbeRestores.Clear();
        }

        /// <summary>渲染器匹配：精确路径 / 精确 GameObject 名 / 精确叶子名，其次路径或名字的子串（不区分大小写）。</summary>
        private SkinnedMeshRenderer FindPreProbeSmr(SkinnedMeshRenderer[] smrs, string spec)
        {
            SkinnedMeshRenderer fuzzy = null;
            int slash = spec.LastIndexOf('/');
            string leaf = slash >= 0 && slash + 1 < spec.Length ? spec.Substring(slash + 1) : spec;
            for (int i = 0; i < smrs.Length; i++)
            {
                var smr = smrs[i];
                if (smr == null) continue;
                string path = AuditUtil.RelPath(_avatar.transform, smr.transform);
                string name = smr.gameObject.name;
                if (string.Equals(path, spec, StringComparison.Ordinal)) return smr;
                if (string.Equals(name, spec, StringComparison.Ordinal)
                    || string.Equals(name, leaf, StringComparison.Ordinal)) return smr;
                if (fuzzy == null && (ContainsIgnoreCase(path, spec) || ContainsIgnoreCase(name, spec))) fuzzy = smr;
            }
            return fuzzy;
        }

        private static bool ContainsIgnoreCase(string s, string sub)
        {
            if (string.IsNullOrEmpty(s) || string.IsNullOrEmpty(sub)) return false;
            return s.IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private List<string> ZeroKeysFor(CandidateSpec cand)
        {
            // 任务 CS：候选级覆盖请求级；没有候选级时用请求级；都没有 = 不清零（旧行为）。
            if (cand != null && cand.HasZeroKeys) return cand.ZeroKeys;
            return _candidatesZero;
        }

        /// <summary>
        /// 形态键名匹配：先精确（含大小写不敏感）；否则把网格里的名字按 AAO 规则还原
        /// （去掉 AAO_Merged_ 前缀与末尾的 _&lt;数字&gt;）再和请求名比较，匹配到的全部返回
        /// （同一原名的 AAO 分片可能有多片，如 AAO_Merged_foot_heel_OFF_0/1/2）。
        /// 任务 CS：改成 internal，供 AuditProbes 的 shrink_cover 探针复用同一口径。
        /// </summary>
        internal static List<int> MatchShapeIndices(Mesh mesh, string requested)
        {
            var res = new List<int>();
            if (mesh == null || string.IsNullOrEmpty(requested)) return res;
            int exact = mesh.GetBlendShapeIndex(requested);
            if (exact >= 0) { res.Add(exact); return res; }
            int count = mesh.blendShapeCount;
            for (int i = 0; i < count; i++)
            {
                string n = mesh.GetBlendShapeName(i);
                if (string.Equals(n, requested, StringComparison.OrdinalIgnoreCase)) { res.Add(i); continue; }
                if (string.Equals(AaoBaseName(n), requested, StringComparison.OrdinalIgnoreCase)) res.Add(i);
            }
            return res;
        }

        /// <summary>把 AAO 合并后的名字还原成原名：去掉 "AAO_Merged_" 前缀与末尾 "_&lt;数字&gt;"。</summary>
        private static string AaoBaseName(string n)
        {
            if (string.IsNullOrEmpty(n)) return n;
            string s = n;
            const string prefix = "AAO_Merged_";
            if (s.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) s = s.Substring(prefix.Length);
            int us = s.LastIndexOf('_');
            if (us > 0 && us + 1 < s.Length)
            {
                bool digits = true;
                for (int i = us + 1; i < s.Length; i++)
                    if (s[i] < '0' || s[i] > '9') { digits = false; break; }
                if (digits) s = s.Substring(0, us);
            }
            return s;
        }

        // ------------------------------------------------------------------ T-13：V3 / V4 / keys_all 辅助

        /// <summary>V3 逐材质槽判定（委托取值，规则见 AuditV3Rules）。材质为空返回 null。</summary>
        private static JsonObject BuildV3(Material m)
        {
            if (m == null) return null;
            string shader = m.shader != null ? m.shader.name : null;
            string reason;
            string verdict = AuditV3Rules.Evaluate(
                shader,
                delegate (string prop)
                {
                    if (prop == "_Color.a")
                    {
                        if (!m.HasProperty("_Color")) return (double?)null;
                        return (double?)m.GetColor("_Color").a;
                    }
                    if (!m.HasProperty(prop)) return (double?)null;
                    return (double?)m.GetFloat(prop);
                },
                delegate (string prop)
                {
                    if (!m.HasProperty(prop)) return null;
                    var v = m.GetVector(prop);
                    return new double[] { v.x, v.y, v.z, v.w };
                },
                out reason);
            var o = new JsonObject();
            o.Set("value", verdict);
            o.Set("hidden", verdict == AuditV3Rules.Hidden ? (object)true : (verdict == AuditV3Rules.Visible ? (object)false : null));
            o.Set("reason", reason);
            return o;
        }

        /// <summary>
        /// V4 烘焙排除桶比例：绑定姿态顶点 + 蒙皮主骨骼判三桶（non_finite / nanimated / zero_weight），
        /// 优先 non_finite &gt; nanimated &gt; zero_weight（与 AuditProbes 的排除口径一致）。
        /// 为什么不逐状态 BakeMesh：三桶由构建期写入的骨架/网格结构决定，绑定姿态即可判；
        /// 逐状态烘焙 166 个 SMR × 83 状态会拖垮 T1，且姿势造成的删除差异本来要 T-14/T2 复核。
        /// </summary>
        private JsonObject ComputeV4(SkinnedMeshRenderer smr, Mesh mesh)
        {
            var o = new JsonObject();
            int total = mesh.vertexCount;
            o.Set("vertex_count", total);
            if (total <= 0)
            {
                o.Set("kept_ratio", null);
                o.Set("source", "empty_mesh");
                return o;
            }

            JsonObject cached;
            if (_v4Cache.TryGetValue(mesh.GetInstanceID(), out cached)) return cached;

            bool readable;
            try { readable = mesh.isReadable; }
            catch { readable = false; }
            if (!readable)
            {
                o.Set("kept_ratio", null);
                o.Set("source", "mesh_not_readable");
                o.Set("note", "网格未开 Read/Write，读不到顶点/骨骼权重，V4 判不了（不猜）");
                _v4Cache[mesh.GetInstanceID()] = o;
                return o;
            }

            Vector3[] verts = null;
            BoneWeight[] bw = null;
            try { verts = mesh.vertices; } catch { }
            try { bw = mesh.boneWeights; } catch { }

            var bones = smr.bones;
            int nb = bones != null ? bones.Length : 0;
            var boneNanimated = new bool[nb];
            for (int i = 0; i < nb; i++) boneNanimated[i] = BoneChainHasNaNimation(bones[i]);

            int nonFinite = 0, nanimated = 0, zeroWeight = 0;
            for (int i = 0; i < total; i++)
            {
                bool isNonFinite = false;
                if (verts != null && i < verts.Length)
                {
                    var v = verts[i];
                    isNonFinite = !IsFinite(v.x) || !IsFinite(v.y) || !IsFinite(v.z);
                }

                int dominant = -1;
                float bestW = 0f;
                double sumW = 0.0;
                if (bw != null && i < bw.Length)
                {
                    var w = bw[i];
                    AccumBone(ref dominant, ref bestW, ref sumW, w.boneIndex0, w.weight0);
                    AccumBone(ref dominant, ref bestW, ref sumW, w.boneIndex1, w.weight1);
                    AccumBone(ref dominant, ref bestW, ref sumW, w.boneIndex2, w.weight2);
                    AccumBone(ref dominant, ref bestW, ref sumW, w.boneIndex3, w.weight3);
                }
                bool isZero = bw != null && sumW <= 1e-6;
                bool isNani = dominant >= 0 && dominant < nb && boneNanimated[dominant];

                if (isNonFinite) nonFinite++;
                else if (isNani) nanimated++;
                else if (isZero) zeroWeight++;
            }

            int excluded = nonFinite + nanimated + zeroWeight;
            var buckets = new JsonObject();
            buckets.Set("non_finite", nonFinite);
            buckets.Set("nanimated", nanimated);
            buckets.Set("zero_weight", zeroWeight);
            o.Set("buckets", buckets);
            o.Set("excluded_total", excluded);
            o.Set("kept", total - excluded);
            o.Set("kept_ratio", (double)(total - excluded) / total);
            o.Set("source", bw != null ? "bind_pose_bone_weights" : "bind_pose_vertices_only");
            o.Set("note", "用绑定姿态顶点 + 蒙皮主骨骼判三桶；未逐状态 BakeMesh，姿势引起的删除差异需 T-14/T2 复核");
            _v4Cache[mesh.GetInstanceID()] = o;
            return o;
        }

        private static bool IsFinite(float f)
        {
            return !float.IsNaN(f) && !float.IsInfinity(f);
        }

        private static void AccumBone(ref int dominant, ref float bestW, ref double sumW, int boneIndex, float weight)
        {
            if (weight <= 0f) return;
            sumW += weight;
            if (weight > bestW) { bestW = weight; dominant = boneIndex; }
        }

        /// <summary>主骨骼（权重最大者）沿父链是否含 NaNimat（MA ShapeChanger 的 Delete 骨骼）。</summary>
        private static bool BoneChainHasNaNimation(Transform bone)
        {
            var cur = bone;
            int guard = 0;
            while (cur != null && guard++ < 256)
            {
                if (!string.IsNullOrEmpty(cur.name)
                    && cur.name.IndexOf("NaNimat", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                cur = cur.parent;
            }
            return false;
        }

        /// <summary>
        /// keys_all 的 source_name（构建前物体名/路径）尽力追溯。返回 null = 追不到（不猜）。
        /// 顺序：AAO_Merged_&lt;原名&gt;_&lt;n&gt; 网格名 → 普通网格名 → 路径里带 $ 的段的前缀 → 未改名物体名。
        /// </summary>
        public static string GuessSourceName(string builtPath, string objName, string meshName, out string origin)
        {
            origin = null;
            const string aaoPrefix = "AAO_Merged_";
            if (!string.IsNullOrEmpty(meshName) && meshName.StartsWith(aaoPrefix, StringComparison.OrdinalIgnoreCase))
            {
                origin = "mesh_name_aao_merged";
                return AaoBaseName(meshName);
            }
            if (!string.IsNullOrEmpty(meshName) && !meshName.StartsWith("$$AAO", StringComparison.Ordinal))
            {
                origin = "mesh_name_plain";
                return meshName;
            }
            if (!string.IsNullOrEmpty(builtPath))
            {
                var segs = builtPath.Split('/');
                for (int i = 0; i < segs.Length; i++)
                {
                    int d = segs[i].IndexOf('$');
                    if (d <= 0) continue;
                    string head = segs[i].Substring(0, d);
                    if (!string.IsNullOrEmpty(head) && !IsAllDigits(head))
                    {
                        origin = "path_dollar_prefix";
                        return head;
                    }
                }
            }
            if (!string.IsNullOrEmpty(objName)
                && objName.IndexOf("AAO", StringComparison.OrdinalIgnoreCase) < 0
                && objName.IndexOf("Merge", StringComparison.OrdinalIgnoreCase) < 0
                && objName.IndexOf('$') < 0)
            {
                origin = "object_name_assumed_unchanged";
                return objName;
            }
            origin = "unresolved";
            return null;
        }

        private static bool IsAllDigits(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            for (int i = 0; i < s.Length; i++) if (s[i] < '0' || s[i] > '9') return false;
            return true;
        }

        private static string FindVisKey(JsonObject vis, string basePath)
        {
            if (vis == null || string.IsNullOrEmpty(basePath)) return null;
            if (vis.Has(basePath)) return basePath;
            foreach (var k in vis.Keys)
                if (k.StartsWith(basePath + "#", StringComparison.Ordinal)) return k;
            return null;
        }

        /// <summary>
        /// 参数全集（仅用于报告与读取启动值）= VRCExpressionParameters ∪ Animator.parameters ∪ GM.Params ∪ 请求里出现的参数名。
        /// 可复位集合（_resetNames）只是它的子集：表达参数里声明、且不是 VRChat 内置参数的那些。
        /// </summary>
        private void BuildParamUniverse()
        {
            var names = new HashSet<string>();

            foreach (var n in ReadExpressionParameterNames())
            {
                names.Add(n);
                _declaredExpr.Add(n);
                if (!BuiltinParams.Contains(n)) _resetNamesAll.Add(n);
            }

            foreach (var kv in _animParams) names.Add(kv.Key);

            if (_module != null)
            {
                foreach (var n in GmgBridge.AllParamNames(_module)) names.Add(n);
            }

            foreach (var st in _states) foreach (var k in st.Params.Keys) names.Add(k);

            _paramNames.Clear();
            _paramNames.AddRange(names.OrderBy(x => x, StringComparer.Ordinal));

            // 任务 AD：在本批模式与驱动器目标之上，定出真正参与复位的集合。
            BuildResetSet();
        }

        /// <summary>
        /// 任务 AD：算本批真正参与复位的参数集合。
        ///   起点 = _resetNamesAll（表达参数 − VRChat 内置）；
        ///   默认再减去「被 VRCAvatarParameterDriver 写入、且用户不能直接点」的参数（否则会把驱动器维护的
        ///   内部状态冲回声明默认值，造成工具假象）；用户能直接点的被驱动参数仍复位，只记 warning；
        ///   请求 reset_driver_targets=true 时完全不减（旧行为）。
        /// </summary>
        private void BuildResetSet()
        {
            _resetNames.Clear();
            _resetExcludedDriverTargets.Clear();
            _driverTargetsUserClickable.Clear();

            // 「用户能点」= 参数名直接出现在表达菜单控件（含子菜单）的 parameter 里。
            var menuParams = ReadMenuControlParams();

            foreach (var n in _resetNamesAll.OrderBy(x => x, StringComparer.Ordinal))
            {
                if (!_driverTargets.ContainsKey(n) || _resetDriverTargets)
                {
                    _resetNames.Add(n);
                    continue;
                }
                if (menuParams.Contains(n))
                {
                    _resetNames.Add(n);
                    _driverTargetsUserClickable.Add(n);
                    if (_ctx != null)
                        _ctx.Warn("参数 '" + n + "' 既被表达菜单控件直接引用（用户可点）又被 VRCAvatarParameterDriver 写入；"
                            + "按任务 AD 规则仍参与复位。若它其实是驱动器维护的内部状态，本批复位仍可能是工具假象的来源。");
                    continue;
                }
                _resetExcludedDriverTargets.Add(n);
            }

            if (_ctx != null && _resetExcludedDriverTargets.Count > 0)
                _ctx.Status.Log("任务 AD：从复位集合里排除 " + _resetExcludedDriverTargets.Count
                    + " 个由参数驱动器维护、用户不能直接点的参数：" + string.Join(", ", _resetExcludedDriverTargets.ToArray()));
        }

        /// <summary>
        /// 头像 VRCExpressionParameters 里声明的参数名（这些才是「用户可控」的候选），
        /// 同时把每个参数声明的 defaultValue 存进 _declaredDefaults（字段名以 SDK 实际为准：
        /// VRCExpressionParameters+Parameter.defaultValue，float）。
        /// </summary>
        private List<string> ReadExpressionParameterNames()
        {
            var result = new List<string>();
            var desc = AuditAvatar.FindDescriptor(_avatar);
            if (desc == null) return result;

            var f = desc.GetType().GetField("expressionParameters", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (f == null) return result;
            var ep = f.GetValue(desc) as UnityEngine.Object;
            if (ep == null) return result;

            var pf = ep.GetType().GetField("parameters", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (pf == null) return result;
            var arr = pf.GetValue(ep) as Array;
            if (arr == null) return result;

            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in arr)
            {
                if (item == null) continue;
                var nf = item.GetType().GetField("name", BindingFlags.Instance | BindingFlags.Public);
                if (nf == null) continue;
                var n = nf.GetValue(item) as string;
                if (string.IsNullOrEmpty(n) || !seen.Add(n)) continue;
                result.Add(n);

                // 声明默认值：读不到就不进 _declaredDefaults，BuildResetValues 里会退回启动实值并 warning。
                var df = item.GetType().GetField("defaultValue", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (df == null) continue;
                try
                {
                    var dv = df.GetValue(item);
                    if (dv == null) continue;
                    _declaredDefaults[n] = Convert.ToSingle(dv, System.Globalization.CultureInfo.InvariantCulture);
                }
                catch (Exception e)
                {
                    if (_ctx != null) _ctx.Warn("参数 '" + n + "' 的 defaultValue 反射读取失败：" + e.Message);
                }
            }
            return result;
        }

        // ------------------------------------------------------------------ 任务 AD：参数驱动器扫描

        /// <summary>
        /// 任务 AD：扫描头像各可播放层控制器（Base/Additive/Gesture/Action/FX 等）所有状态与子状态机上的
        /// VRCAvatarParameterDriver，收集它写入的参数名（Set/Add/Random/Copy 的 name）。
        ///
        /// 用途：复位集合要减去这些「驱动器维护的内部参数」，否则会把它们冲回声明默认值——Milfy 的
        /// Slippers_OFF 声明默认 0 = 显示拖鞋，复位后同一套服装内切换时驱动器不再触发，于是「只关袜子」
        /// 的 12/13 套都冒出小熊拖鞋。用 reset:none 按真实顺序切则不复现，证明是工具假象。
        ///
        /// 控制器来源（都取构建后的资产）：
        ///   · descriptor.baseAnimationLayers / specialAnimationLayers 的 animatorController；
        ///   · isDefault 层（控制器字段为空）→ 反射调 GM 的 ModuleVrc3Styles.Data.ControllerOf(type)
        ///     拿 GM 实际在用的内置控制器（GM 接管时 AvatarAnimator.runtimeAnimatorController 被置 null，
        ///     只看 descriptor 会漏掉这些层）；
        ///   · Animator.runtimeAnimatorController（没被 GM 接管的退路）。
        /// AnimatorOverrideController 会拆到底层的 AnimatorController 再扫。任何一步失败只记 warning。
        /// </summary>
        private void ScanDriverTargets(AuditContext ctx)
        {
            _driverTargets.Clear();
            _driverTargetOrder.Clear();
            _stateEntryConds.Clear();
            _driverScanWarnings.Clear();
            _driverControllersScanned.Clear();
            _driverStatesScanned = 0;

            var ctrls = new List<RuntimeAnimatorController>();
            var labels = new List<string>();
            var seen = new HashSet<int>();

            try
            {
                var desc = AuditAvatar.FindDescriptor(_avatar);
                if (desc == null)
                {
                    _driverScanWarnings.Add("头像上找不到 VRCAvatarDescriptor，驱动器扫描只能退回 Animator.runtimeAnimatorController。");
                }
                else
                {
                    CollectLayerFieldControllers(desc, "baseAnimationLayers", ctrls, labels, seen);
                    CollectLayerFieldControllers(desc, "specialAnimationLayers", ctrls, labels, seen);
                    CollectDefaultLayerControllers(desc, ctrls, labels, seen);
                }
                if (_anim != null && _anim.runtimeAnimatorController != null)
                    AddDriverController(_anim.runtimeAnimatorController, "Animator.runtimeAnimatorController", ctrls, labels, seen);
            }
            catch (Exception e)
            {
                _driverScanWarnings.Add("收集层控制器失败（驱动器目标可能不完整，复位排除也随之不完整）："
                    + AuditUtil.Unwrap(e).Message);
            }

            for (int i = 0; i < ctrls.Count; i++)
            {
                var ac = AsAnimatorController(ctrls[i]);
                if (ac == null)
                {
                    _driverScanWarnings.Add("控制器 '" + SafeName(ctrls[i]) + "' 不是 AnimatorController（"
                        + ctrls[i].GetType().Name + "），跳过驱动器扫描。");
                    continue;
                }
                _driverControllersScanned.Add(SafeName(ac) + (string.IsNullOrEmpty(labels[i]) ? "" : " [" + labels[i] + "]"));
                try { ScanControllerStates(ac, labels[i]); }
                catch (Exception e)
                {
                    _driverScanWarnings.Add("扫描控制器 '" + SafeName(ac) + "' 失败：" + AuditUtil.Unwrap(e).Message);
                }
            }

            for (int i = 0; i < _driverScanWarnings.Count; i++)
                ctx.Warn("驱动器扫描：" + _driverScanWarnings[i]);
        }

        /// <summary>读 descriptor 某组动画层的 animatorController（构建后的层控制器）。</summary>
        private void CollectLayerFieldControllers(object desc, string field,
            List<RuntimeAnimatorController> into, List<string> labels, HashSet<int> seen)
        {
            var f = desc.GetType().GetField(field, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (f == null)
            {
                _driverScanWarnings.Add("descriptor 读不到字段 " + field + "（SDK 版本不符？），该组层控制器未扫描。");
                return;
            }
            var layers = f.GetValue(desc) as IEnumerable;
            if (layers == null) return;
            foreach (var layer in layers)
            {
                if (layer == null) continue;
                string typeName = EnumNameOrNull(GetMemberValue(layer, "type"));
                var rac = GetMemberValue(layer, "animatorController") as RuntimeAnimatorController;
                if (rac != null)
                    AddDriverController(rac, field + " " + typeName, into, labels, seen);
            }
        }

        /// <summary>
        /// isDefault 层在 descriptor 里 animatorController 常为空，GM 实际用的是它自己的内置控制器
        /// （ModuleVrc3Styles.Data.ControllerOf(type)）。反射取来一并扫描；反射不到只记 warning。
        /// </summary>
        private void CollectDefaultLayerControllers(object desc,
            List<RuntimeAnimatorController> into, List<string> labels, HashSet<int> seen)
        {
            var controllerOf = FindGmControllerOf();
            bool warned = false;
            CollectDefaultLayerField(desc, "baseAnimationLayers", controllerOf, ref warned, into, labels, seen);
            CollectDefaultLayerField(desc, "specialAnimationLayers", controllerOf, ref warned, into, labels, seen);
        }

        private void CollectDefaultLayerField(object desc, string field, MethodInfo controllerOf, ref bool warned,
            List<RuntimeAnimatorController> into, List<string> labels, HashSet<int> seen)
        {
            var f = desc.GetType().GetField(field, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (f == null) return;
            var layers = f.GetValue(desc) as IEnumerable;
            if (layers == null) return;
            foreach (var layer in layers)
            {
                if (layer == null) continue;
                var rac = GetMemberValue(layer, "animatorController") as RuntimeAnimatorController;
                if (rac != null) continue;                       // 已作为自定义层扫过
                if (!ToBool(GetMemberValue(layer, "isDefault"))) continue;
                if (controllerOf == null)
                {
                    if (!warned)
                    {
                        warned = true;
                        _driverScanWarnings.Add("isDefault 层要经 GM 的 ModuleVrc3Styles.Data.ControllerOf(type) 才能拿到控制器，"
                            + "但反射不到（GM 版本不符？）；这些默认层未扫描。");
                    }
                    continue;
                }
                object typeVal = GetMemberValue(layer, "type");
                if (typeVal == null) continue;
                try
                {
                    var ac = controllerOf.Invoke(null, new object[] { typeVal }) as RuntimeAnimatorController;
                    if (ac != null) AddDriverController(ac, field + " " + typeVal + " (GM 内置默认)", into, labels, seen);
                }
                catch (Exception e)
                {
                    if (!warned)
                    {
                        warned = true;
                        _driverScanWarnings.Add("反射调 GM ControllerOf 取默认层控制器失败：" + AuditUtil.Unwrap(e).Message);
                    }
                }
            }
        }

        private static MethodInfo FindGmControllerOf()
        {
            try
            {
                var t = GmgBridge.FindType("BlackStartX.GestureManager.Editor.Modules.Vrc3.ModuleVrc3Styles+Data");
                if (t == null) return null;
                return t.GetMethod("ControllerOf", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            }
            catch { return null; }
        }

        private static void AddDriverController(RuntimeAnimatorController rac, string label,
            List<RuntimeAnimatorController> into, List<string> labels, HashSet<int> seen)
        {
            if (rac == null) return;
            if (!seen.Add(rac.GetInstanceID())) return;
            into.Add(rac);
            labels.Add(label);
        }

        /// <summary>AnimatorOverrideController（GM 会用它包一层）拆到底层 AnimatorController；不是控制器返回 null。</summary>
        private static AnimatorController AsAnimatorController(RuntimeAnimatorController rac)
        {
            if (rac == null) return null;
            var ac = rac as AnimatorController;
            if (ac != null) return ac;
            var ov = rac as AnimatorOverrideController;
            if (ov != null) return ov.runtimeAnimatorController as AnimatorController;
            return null;
        }

        private void ScanControllerStates(AnimatorController ac, string layerTypeHint)
        {
            if (ac == null) return;
            var layers = ac.layers;
            for (int li = 0; li < layers.Length; li++)
            {
                var layer = layers[li];
                if (layer == null) continue;
                string layerName = string.IsNullOrEmpty(layer.name) ? ("layer" + li) : layer.name;
                ScanStateMachine(layer.stateMachine, ac.name, layerName, layerTypeHint, layerName);
            }
        }

        private void ScanStateMachine(AnimatorStateMachine sm, string ctrlName, string layerName,
            string layerTypeHint, string smPath)
        {
            if (sm == null) return;

            var states = sm.states;
            for (int i = 0; i < states.Length; i++)
            {
                var st = states[i].state;
                if (st == null) continue;
                _driverStatesScanned++;
                var behaviours = st.behaviours;
                if (behaviours == null) continue;
                for (int b = 0; b < behaviours.Length; b++)
                    CollectDriver(behaviours[b], ctrlName, layerName, layerTypeHint, smPath, st.name);
            }

            // 任务 BR：收集「进入条件」——同状态机内各状态的转移（含 AnyState / Entry）指向的目标状态。
            // 只覆盖同一 stateMachine 内的 sibling 转移；跨子状态机的 destinationStateMachine 记不到，
            // 这类状态上的 Driver 不会拿到自动放行（宁漏勿错）。
            for (int i = 0; i < states.Length; i++)
            {
                var st = states[i].state;
                if (st == null || st.transitions == null) continue;
                for (int t = 0; t < st.transitions.Length; t++)
                    RecordEntryConditions(st.transitions[t], ctrlName, layerName, smPath);
            }
            if (sm.anyStateTransitions != null)
                for (int t = 0; t < sm.anyStateTransitions.Length; t++)
                    RecordEntryConditions(sm.anyStateTransitions[t], ctrlName, layerName, smPath);
            if (sm.entryTransitions != null)
                for (int t = 0; t < sm.entryTransitions.Length; t++)
                    RecordEntryConditions(sm.entryTransitions[t], ctrlName, layerName, smPath);

            // 驱动器也可以直接挂在子状态机上（AnimatorStateMachine.behaviours），不止挂在状态上。
            var smBehaviours = sm.behaviours;
            if (smBehaviours != null)
                for (int b = 0; b < smBehaviours.Length; b++)
                    CollectDriver(smBehaviours[b], ctrlName, layerName, layerTypeHint, smPath, "(state machine)");

            var subs = sm.stateMachines;
            for (int i = 0; i < subs.Length; i++)
            {
                var child = subs[i].stateMachine;
                if (child == null) continue;
                string cname = string.IsNullOrEmpty(child.name) ? ("sub" + i) : child.name;
                ScanStateMachine(child, ctrlName, layerName, layerTypeHint, smPath + "/" + cname);
            }
        }

        /// <summary>任务 BR：把一条转移读到的参数记到它的目标状态上（用于判钳位放行）。</summary>
        private void RecordEntryConditions(AnimatorTransitionBase tr, string ctrlName, string layerName, string smPath)
        {
            if (tr == null || tr.destinationState == null) return;
            var conds = tr.conditions;
            if (conds == null || conds.Length == 0) return;
            string key = StateKey(ctrlName, layerName, smPath, tr.destinationState.name);
            List<ClampCondition> list;
            if (!_stateEntryConds.TryGetValue(key, out list))
            {
                list = new List<ClampCondition>();
                _stateEntryConds[key] = list;
            }
            for (int i = 0; i < conds.Length; i++)
            {
                var c = conds[i];
                if (string.IsNullOrEmpty(c.parameter)) continue;
                bool dup = false;
                for (int j = 0; j < list.Count; j++)
                {
                    var e = list[j];
                    if (e.Param == c.parameter && e.Mode == c.mode.ToString() && e.Threshold == c.threshold)
                    { dup = true; break; }
                }
                if (dup) continue;
                list.Add(new ClampCondition
                {
                    Param = c.parameter,
                    Mode = c.mode.ToString(),
                    Threshold = c.threshold,
                });
            }
        }

        private static string StateKey(string ctrl, string layer, string smPath, string state)
        {
            return ctrl + "|" + layer + "|" + smPath + "|" + state;
        }

        private void CollectDriver(StateMachineBehaviour b, string ctrlName, string layerName,
            string layerTypeHint, string smPath, string stateName)
        {
            if (b == null) return;
            string tn = b.GetType().Name;
            if (tn.IndexOf("AvatarParameterDriver", StringComparison.Ordinal) < 0) return;

            var pf = b.GetType().GetField("parameters", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            var list = pf == null ? null : pf.GetValue(b) as IEnumerable;
            if (list == null)
            {
                _driverScanWarnings.Add("状态 '" + smPath + "/" + stateName + "' 上的 " + tn
                    + " 读不到 parameters 字段，无法收集目标参数。");
                return;
            }
            foreach (var p in list)
            {
                if (p == null) continue;
                string name = GetMemberValue(p, "name") as string;
                if (string.IsNullOrEmpty(name)) continue;
                var w = new DriverWriter();
                w.Controller = ctrlName;
                w.Layer = layerName;
                w.LayerType = layerTypeHint;
                w.StateMachine = smPath;
                w.State = stateName;
                w.ChangeType = EnumNameOrNull(GetMemberValue(p, "type"));
                w.Source = GetMemberValue(p, "source") as string;
                object val = GetMemberValue(p, "value");
                if (val != null)
                {
                    try { w.Value = AuditUtil.ToFloat(val); w.HasValue = true; }
                    catch { w.HasValue = false; }
                }
                AddDriverTarget(name, w);
            }
        }

        private void AddDriverTarget(string name, DriverWriter w)
        {
            List<DriverWriter> list;
            if (!_driverTargets.TryGetValue(name, out list))
            {
                list = new List<DriverWriter>();
                _driverTargets[name] = list;
                _driverTargetOrder.Add(name);
            }
            for (int i = 0; i < list.Count; i++)
            {
                var e = list[i];
                if (e.Controller == w.Controller && e.Layer == w.Layer && e.StateMachine == w.StateMachine
                    && e.State == w.State && e.ChangeType == w.ChangeType && e.Source == w.Source
                    && e.HasValue == w.HasValue && (!w.HasValue || e.Value == w.Value)) return;
            }
            list.Add(w);
        }

        /// <summary>读字段或属性（反射），失败返回 null。</summary>
        private static object GetMemberValue(object o, string member)
        {
            if (o == null) return null;
            var t = o.GetType();
            var f = t.GetField(member, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (f != null)
            {
                try { return f.GetValue(o); } catch { return null; }
            }
            var p = t.GetProperty(member, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (p != null)
            {
                try { return p.GetValue(o, null); } catch { return null; }
            }
            return null;
        }

        private static bool ToBool(object o)
        {
            if (o == null) return false;
            if (o is bool) return (bool)o;
            try { return Convert.ToBoolean(o, System.Globalization.CultureInfo.InvariantCulture); }
            catch { return false; }
        }

        private static string EnumNameOrNull(object o) { return o == null ? null : o.ToString(); }

        private static string SafeName(UnityEngine.Object o) { return o == null ? "(null)" : o.name; }

        /// <summary>
        /// 「用户能直接点」的口径：参数名直接出现在表达菜单控件（含子菜单）的 parameter.name 或
        /// subParameters[].name（Puppet / TwoAxis / Radial）里。
        /// 只读不改；反射读不到菜单时返回空集合（等价于「都不能点」，被驱动参数会全部排除复位）。
        /// </summary>
        private HashSet<string> ReadMenuControlParams()
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            try
            {
                var desc = AuditAvatar.FindDescriptor(_avatar);
                if (desc == null) return result;
                var menu = GetMemberValue(desc, "expressionsMenu");
                if (menu == null) return result;
                WalkMenuParams(menu, result, new HashSet<int>(), 0);
            }
            catch (Exception e)
            {
                if (_ctx != null)
                    _ctx.Warn("读表达菜单控件失败，无法判断被驱动参数是否用户可点（本批按「不能点」处理）："
                        + AuditUtil.Unwrap(e).Message);
            }
            return result;
        }

        private void WalkMenuParams(object menu, HashSet<string> into, HashSet<int> visited, int depth)
        {
            if (menu == null || depth > 64) return;
            var uo = menu as UnityEngine.Object;
            if (uo != null && !visited.Add(uo.GetInstanceID())) return;

            var controls = GetMemberValue(menu, "controls") as IEnumerable;
            if (controls == null) return;
            foreach (var c in controls)
            {
                if (c == null) continue;
                var param = GetMemberValue(c, "parameter");
                string pname = param == null ? null : GetMemberValue(param, "name") as string;
                if (!string.IsNullOrEmpty(pname)) into.Add(pname);
                // Puppet / TwoAxis / Radial 控件的参数在 subParameters 里，同样是用户可点。
                var subs = GetMemberValue(c, "subParameters") as IEnumerable;
                if (subs != null)
                    foreach (var sp in subs)
                    {
                        if (sp == null) continue;
                        string sname = GetMemberValue(sp, "name") as string;
                        if (!string.IsNullOrEmpty(sname)) into.Add(sname);
                    }
                var sub = GetMemberValue(c, "subMenu");
                if (sub != null) WalkMenuParams(sub, into, visited, depth + 1);
            }
        }

        // ------------------------------------------------------------------ Tick

        public bool Tick()
        {
            switch (_phase)
            {
                case Phase.Warmup:
                    if (Time.frameCount >= _targetFrame)
                    {
                        FinishWarmup();
                        _stateIndex = 0;
                        _phase = Phase.Reset;
                    }
                    return false;

                case Phase.Reset:
                    SetupCurrentState();
                    return false;

                case Phase.WaitSettle:
                    if (Time.frameCount >= _targetFrame) _phase = Phase.Snapshot;
                    return false;

                case Phase.Snapshot:
                    DoSnapshot();
                    return false;

                case Phase.VolatileWait:
                    if (Time.frameCount >= _targetFrame) _phase = Phase.VolatileSnapshot;
                    return false;

                case Phase.VolatileSnapshot:
                    DoVolatileCompare();
                    AdvanceAfterSnapshot();
                    return false;

                case Phase.Done:
                    // 有状态塌掉就在整批结束时把 status 置 error，绝不静默继续（states.json 已经写完）。
                    if (_sanityFailed)
                        throw new Exception("健全性检查失败，整批判定 error（明细见 states.json 的 sanity_failed 与各 state_*.json 的 sanity_reasons）："
                            + string.Join("；", _sanityFailures.ToArray()));
                    return true;

                default:
                    return true;
            }
        }

        /// <summary>
        /// 读 T1 启动瞬间各参数的实际值（只作 startup 模式与「读不到声明默认」时的退路，不再直接当默认值）。
        /// </summary>
        private void FinishWarmup()
        {
            foreach (var n in _paramNames)
            {
                float v;
                bool ok = TryReadCurrent(n, out v);
                if (!ok) v = 0f;
                _initialValues[n] = v;
                // 非可复位参数的默认值就用启动实值（保留「读不到值→0」的痕迹）；可复位参数下面会被 BuildResetValues 覆盖。
                _defaults[n] = v;
                _defaultSource[n] = ok ? "initial_at_start" : "initial_at_start(读不到值→0)";
            }
            BuildResetValues();
        }

        /// <summary>
        /// 算本批复位值。只覆盖可复位集合（表达参数 − VRChat 内置参数），内置参数永远不进 _resetValues：
        ///   declared（默认）：取 VRCExpressionParameters 声明的 defaultValue；读不到就退回 T1 启动实值并逐个 warning；
        ///   startup：全部取 T1 启动实值（旧行为，仅 "reset":"startup" 时用）；
        ///   none：不复位（ResetAllParams 跳过）；这里仍算出声明默认写进 defaults_snapshot，供事后核对。
        /// 同时把结果写回 _defaults / _defaultSource，供 param_defaults 与 params_equal_default 参照。
        /// </summary>
        private void BuildResetValues()
        {
            _resetValues.Clear();
            _resetFallbackParams.Clear();

            foreach (var n in _resetNames)
            {
                float startup;
                if (!_initialValues.TryGetValue(n, out startup)) startup = 0f;

                float declared;
                bool haveDeclared = _declaredDefaults.TryGetValue(n, out declared);
                float v;
                string s;
                if (_resetMode == "startup")
                {
                    v = startup;
                    s = "startup_value_fallback";
                }
                else if (haveDeclared)
                {
                    v = declared;
                    s = "declared_default";
                }
                else
                {
                    v = startup;
                    s = "startup_value_fallback";
                    _resetFallbackParams.Add(n);
                }
                _resetValues[n] = v;
                _defaults[n] = v;
                _defaultSource[n] = s;
            }

            if (_resetMode == "none")
                _resetPrimarySource = "none";
            else if (_resetMode == "startup" || (_resetNames.Count > 0 && _resetFallbackParams.Count == _resetNames.Count))
                _resetPrimarySource = "startup_value_fallback";
            else
                _resetPrimarySource = "declared_default";

            // 声明默认读不到的，逐个写 warning（任务要求逐个列出；同时 reset_fallback_params 也在 states.json 顶层）。
            foreach (var n in _resetFallbackParams)
            {
                _ctx.Warn("参数 '" + n + "' 在 VRCExpressionParameters 里读不到 defaultValue（SDK 字段名变化？），"
                    + "本批复位退回 T1 启动实值 " + AuditUtil.F(_initialValues.ContainsKey(n) ? _initialValues[n] : 0f)
                    + "。该参数在 state_*.json 里记 reset_values_source=startup_value_fallback。");
            }
        }

        private void SetupCurrentState()
        {
            _curSources.Clear();
            _curMissing.Clear();
            _curWarnings.Clear();

            // 1) 复位用户可控参数（表达参数 − VRChat 内置参数），值按 _resetMode 取声明默认或启动实值
            ResetAllParams();
            if (_gmControlled)
            {
                GmgBridge.SetPose(_module, "PoseT", false);
                GmgBridge.SetPose(_module, "PoseIK", false);
            }

            // 2) 施加本状态
            var spec = _states[_stateIndex];
            foreach (var kv in spec.Params)
            {
                string src;
                if (SetOne(kv.Key, kv.Value, out src)) _curSources[kv.Key] = src;
                else { _curSources[kv.Key] = "missing"; _curMissing.Add(kv.Key); }
            }
            if (!string.IsNullOrEmpty(spec.Pose))
            {
                var poseErr = ApplyPose(spec.Pose);
                if (poseErr != null) _curWarnings.Add(poseErr);
            }

            _targetFrame = Time.frameCount + _settleFrames;
            _phase = Phase.WaitSettle;
        }

        private string ApplyPose(string pose)
        {
            if (!_gmControlled) return "请求了 pose=" + pose + "，但 GM 未接管头像：本轮只支持 GM 的 T Pose / IK Pose，已忽略";
            var p = pose.Trim().ToLowerInvariant();
            switch (p)
            {
                case "tpose":
                case "t_pose":
                case "t":
                    return GmgBridge.SetPose(_module, "PoseT", true) ? null : "设置 T Pose 失败（PoseT 反射拿不到）";
                case "ikpose":
                case "ik_pose":
                case "ik":
                    return GmgBridge.SetPose(_module, "PoseIK", true) ? null : "设置 IK Pose 失败（PoseIK 反射拿不到）";
                case "idle":
                case "none":
                    return null; // idle = 不叠加姿势层，等价于 GM 的 initialPose=None
                default:
                    return "pose='" + pose + "' 本轮未实现（只支持 tpose / ikpose / idle），已忽略";
            }
        }

        private void DoSnapshot()
        {
            var spec = _states[_stateIndex];
            var snap = Capture(spec);
            ApplyReadbackAssertion(spec, snap);
            if (_sentinelsEligible && !_sentinelsDone && _passIndex == 0 && _stateIndex == 0)
            {
                RunSentinels(spec, snap);
                _sentinelsDone = true;
            }
            RunProbes(spec, snap);
            RunCandidates(spec, snap);
            ApplySanityCheck(spec, snap);
            _passSnaps[_passIndex][spec.Id] = snap;

            var fileName = "state_" + AuditUtil.SafeFileName(spec.Id) + (_passIndex == 0 ? "" : ".repeat") + ".json";
            AuditJson.WriteFile(_ctx.OutPath(fileName), snap.ToJson());
            if (_passIndex == 0) _stateFileNames.Add(fileName);

            // keys_all / visibility 只为落盘（T-14 读），体积随状态数线性增长；写完就从内存快照里丢掉，
            // 避免 1000+ 状态时 _passSnaps 把整份键表全背在内存里。丢的是落盘后的副本，文件不受影响；
            // 副作用：repeat_check 的 determinism 不再逐字节比这两块（它们本身是确定性的）。
            snap.KeysAll = null;
            snap.Visibility = null;

            int done = _passIndex * _states.Count + _stateIndex + 1;
            int total = _states.Count * _passCount;
            _ctx.Status.Running(done + "/" + total, "状态 " + spec.Id + " 快照完成（第 " + (_passIndex + 1) + " 遍）");

            // volatile 探测：第 0 遍的第一个状态上，原地再等 settle_frames 帧采第二次快照。
            if (_volatileProbe && !_volatileProbed && _passIndex == 0 && _stateIndex == 0)
            {
                _volatileFirst = snap;
                _volatileProbed = true;
                _targetFrame = Time.frameCount + _settleFrames;
                _phase = Phase.VolatileWait;
                _ctx.Status.Running(done + "/" + total, "状态 " + spec.Id + " volatile 探测：等待第二次快照（" + _settleFrames + " 帧）");
                return;
            }
            AdvanceAfterSnapshot();
        }

        /// <summary>
        /// 任务 R：对刚拍完的状态跑请求里列出的探针，结果挂到快照的 probes 字段。
        /// 探针是附加信息——整体失败也只在 warning 与该状态的 probes.error 里留痕，不拖垮 T1。
        /// 只在真正要写盘的那次快照上跑（volatile 第二次 Capture 不经过这里），避免重复开销。
        /// </summary>
        private void RunProbes(AuditStateSpec spec, AuditStateSnapshot snap)
        {
            if (_probeRequests.Count == 0) return;
            // 任务 U：探针前临时设形态键（人为制造正样本）。快照在上一步已经拍完，
            // 所以只影响探针读数；实际设了什么记进 snap.PreProbeBlendshapes，探针一结束就还原。
            ApplyPreProbeShapes(snap);
            try
            {
                var report = AuditProbes.Run(_ctx, _avatar, _anim, _probeRequests);
                snap.Probes = report.Json;
                foreach (var kv in report.Hits) snap.ProbeHits[kv.Key] = kv.Value;
                // 任务 CS（T-33）：shrink_cover 完整结果另写 shrink_cover_<stateId>.json，
                // 快照只留精简行（探针自己组好放在 compact 里）。
                WriteShrinkCoverOutput(spec, report.Json, snap);
            }
            catch (Exception e)
            {
                var err = new JsonObject();
                err.Set("error", "探针批次执行失败：" + e.Message);
                snap.Probes = err;
                _ctx.Warn("状态 " + spec.Id + " 的探针执行失败（不影响快照主体）：" + e.Message);
            }
            finally
            {
                RestorePreProbeShapes();
            }
        }

        /// <summary>
        /// 任务 CS（T-33）：把 shrink_cover 探针的完整结果写 shrink_cover_&lt;stateId&gt;.json（repeat 遍加 .repeat），
        /// 并把探针组好的 compact 摘要挂到快照的 shrink_cover 字段。没请求该探针时 report 里没有这个键，直接返回。
        /// </summary>
        private void WriteShrinkCoverOutput(AuditStateSpec spec, JsonObject report, AuditStateSnapshot snap)
        {
            if (report == null || snap == null) return;
            var sc = AuditJson.Obj(report, "shrink_cover");
            if (sc == null) return;
            string fileName = "shrink_cover_" + AuditUtil.SafeFileName(spec.Id)
                + (_passIndex == 0 ? "" : ".repeat") + ".json";
            sc.Set("state", spec.Id);
            sc.Set("file", fileName);
            try { AuditJson.WriteFile(_ctx.OutPath(fileName), sc); }
            catch (Exception e) { _ctx.Warn("shrink_cover 写盘失败（" + fileName + "）：" + e.Message); }
            var compact = AuditJson.Obj(sc, "compact");
            if (compact != null)
            {
                compact.Set("state", spec.Id);
                compact.Set("file", fileName);
                snap.ShrinkCover = compact;
            }
            else
            {
                snap.ShrinkCover = sc;   // 兜底：compact 缺失时整份塞进去（不应发生）
            }
        }

        // ------------------------------------------------------------------ 任务 BJ：R9 候选循环

        /// <summary>
        /// 任务 BJ（B-T08a / R9）：本状态逐候选施加形态键 → 跑 T-28a poke → 还原。
        /// 结果累积到 _candidateRows，整批结束时按 part 写 r9_&lt;part&gt;.json。
        /// 与探针一样是附加信息：单项失败只记 warning / 行内 error，不拖垮 T1，也不改快照。
        /// </summary>
        private void RunCandidates(AuditStateSpec spec, AuditStateSnapshot snap)
        {
            if (_candidates.Count == 0) return;
            if (_passIndex != 0) return;   // repeat_check 第二遍不重复跑（行会重复、又费一遍 poke）

            var smrs = _avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
            Array.Sort(smrs, delegate (SkinnedMeshRenderer a, SkinnedMeshRenderer b)
            {
                string pa = a == null ? "" : AuditUtil.RelPath(_avatar.transform, a.transform);
                string pb = b == null ? "" : AuditUtil.RelPath(_avatar.transform, b.transform);
                return string.CompareOrdinal(pa, pb);
            });

            for (int ci = 0; ci < _candidates.Count; ci++)
            {
                var cand = _candidates[ci];
                if (cand.States.Count > 0 && !cand.States.Contains(spec.Id)) continue;

                var row = new CandidateRow();
                row.State = spec.Id;
                row.CandidateId = cand.Id;
                row.Part = cand.Part;
                foreach (var kv in cand.Keys) row.Keys[kv.Key] = kv.Value;

                var applied = new List<ShapeRestore>();
                var zeroKeys = ZeroKeysFor(cand);
                try
                {
                    SkinnedMeshRenderer meshSmr = null;
                    if (!string.IsNullOrEmpty(cand.Mesh))
                    {
                        meshSmr = FindPreProbeSmr(smrs, cand.Mesh);
                        if (meshSmr == null || meshSmr.sharedMesh == null)
                        {
                            row.HardOk = false;
                            row.HardReasons.Add("mesh_not_found:" + cand.Mesh);
                        }
                    }

                    // 任务 CS：清零域优先——在该候选 mesh 上匹配到的每个键先写 0（同名多片全写），
                    // 再写候选自己的键（候选键若与清零键同名，后写覆盖）。清零也进 applied 栈一起还原。
                    if (zeroKeys != null && zeroKeys.Count > 0)
                    {
                        if (meshSmr == null || meshSmr.sharedMesh == null)
                        {
                            for (int zi = 0; zi < zeroKeys.Count; zi++)
                            {
                                string zk = zeroKeys[zi];
                                if (!string.IsNullOrEmpty(zk) && !row.ZeroMissing.Contains(zk)) row.ZeroMissing.Add(zk);
                            }
                        }
                        else
                        {
                            var oldByIndex = new Dictionary<int, float>();
                            for (int zi = 0; zi < zeroKeys.Count; zi++)
                            {
                                string zk = zeroKeys[zi];
                                if (string.IsNullOrEmpty(zk)) continue;
                                var zidxs = MatchShapeIndices(meshSmr.sharedMesh, zk);
                                if (zidxs.Count == 0)
                                {
                                    if (!row.ZeroMissing.Contains(zk)) row.ZeroMissing.Add(zk);
                                    continue;
                                }
                                for (int k = 0; k < zidxs.Count; k++)
                                {
                                    int idx = zidxs[k];
                                    float old0;
                                    if (oldByIndex.TryGetValue(idx, out old0))
                                    {
                                        if (!row.ZeroApplied.ContainsKey(zk)) row.ZeroApplied[zk] = old0;
                                        continue;   // 该索引已被别的清零键写过，别重复入栈
                                    }
                                    old0 = meshSmr.GetBlendShapeWeight(idx);
                                    oldByIndex[idx] = old0;
                                    row.ZeroApplied[zk] = old0;
                                    meshSmr.SetBlendShapeWeight(idx, 0f);
                                    applied.Add(new ShapeRestore { Smr = meshSmr, Index = idx, OldWeight = old0 });
                                }
                            }
                        }
                    }

                    foreach (var kv in cand.Keys.OrderBy(x => x.Key, StringComparer.Ordinal))
                    {
                        if (meshSmr == null || meshSmr.sharedMesh == null)
                        {
                            row.HardOk = false;
                            row.HardReasons.Add("key_missing:" + kv.Key);
                            continue;
                        }
                        var idxs = MatchShapeIndices(meshSmr.sharedMesh, kv.Key);
                        if (idxs.Count == 0)
                        {
                            row.HardOk = false;
                            row.HardReasons.Add("key_missing:" + kv.Key);
                            continue;
                        }
                        for (int k = 0; k < idxs.Count; k++)
                        {
                            int idx = idxs[k];
                            float old = meshSmr.GetBlendShapeWeight(idx);
                            meshSmr.SetBlendShapeWeight(idx, kv.Value);
                            applied.Add(new ShapeRestore { Smr = meshSmr, Index = idx, OldWeight = old });
                        }
                    }

                    // 任务 CS：读回证明——清零与候选键全部写完后逐键读回（同名多片取第一个索引）。
                    AppendShapeReadback(row.AppliedReadback, meshSmr, zeroKeys);
                    if (cand.Keys.Count > 0)
                        AppendShapeReadback(row.AppliedReadback, meshSmr, cand.Keys.Keys.OrderBy(x => x, StringComparer.Ordinal).ToList());

                    var child = BuildCandidateContext(cand);
                    JsonObject pokeJson = null;
                    try
                    {
                        pokeJson = AuditProbes.RunPoke(child, _avatar, _anim);
                    }
                    finally
                    {
                        for (int w = 0; w < child.Warnings.Count; w++)
                            if (!_ctx.Warnings.Contains(child.Warnings[w])) _ctx.Warnings.Add(child.Warnings[w]);
                    }
                    ExtractCandidateMetrics(cand, row, pokeJson);
                }
                catch (Exception e)
                {
                    row.Error = true;
                    row.ErrorMessage = AuditUtil.Unwrap(e).Message;
                    _ctx.Warn("candidates['" + cand.Id + "'] 在状态 '" + spec.Id + "' 执行失败：" + row.ErrorMessage);
                }
                finally
                {
                    for (int i = applied.Count - 1; i >= 0; i--)
                    {
                        var r = applied[i];
                        try { r.Smr.SetBlendShapeWeight(r.Index, r.OldWeight); } catch { }
                    }
                }
                _candidateRows.Add(row);
            }
        }

        /// <summary>
        /// 任务 CS：把 names 里每个形态键在 smr 上的当前读回值写进 into（同名多片取第一个索引）。
        /// 用来在清零/施加候选之后读回，证明 SetBlendShapeWeight 真的生效（不是被动画/驱动器盖掉）。
        /// </summary>
        private static void AppendShapeReadback(Dictionary<string, float> into, SkinnedMeshRenderer smr, List<string> names)
        {
            if (into == null || smr == null || smr.sharedMesh == null || names == null) return;
            for (int i = 0; i < names.Count; i++)
            {
                string n = names[i];
                if (string.IsNullOrEmpty(n)) continue;
                var idxs = MatchShapeIndices(smr.sharedMesh, n);
                if (idxs.Count == 0) continue;
                into[n] = smr.GetBlendShapeWeight(idxs[0]);
            }
        }

        /// <summary>
        /// 为候选造一个浅拷贝上下文：保留请求里其余 poke 阈值，但把配对换成候选自己的 garment/covers，
        /// 去掉剂量/perturb/hide（候选自身就是被施加的对象），并强制 reference（除非请求关掉）。
        /// </summary>
        private AuditContext BuildCandidateContext(CandidateSpec cand)
        {
            var req = new JsonObject();
            foreach (var kv in _ctx.Request.Items)
            {
                if (kv.Key == "candidates" || kv.Key == "candidates_zero" || kv.Key == "perturb" || kv.Key == "poke") continue;
                if (kv.Key == "poke_doses" || kv.Key == "poke_perturb" || kv.Key == "poke_hide") continue;
                req.Set(kv.Key, kv.Value);
            }
            var covers = BuildCandidateCovers(cand);
            var srcPoke = _ctx.O("poke");
            if (srcPoke != null)
            {
                var pk = new JsonObject();
                foreach (var kv in srcPoke.Items)
                {
                    if (kv.Key == "doses" || kv.Key == "perturb" || kv.Key == "hide" || kv.Key == "covers") continue;
                    pk.Set(kv.Key, kv.Value);
                }
                if (covers != null) pk.Set("covers", covers);
                pk.Set("reference", _candidatesReference);
                req.Set("poke", pk);
            }
            else
            {
                if (covers != null) req.Set("poke_covers", covers);
                req.Set("poke_reference", _candidatesReference);
            }
            // PickBodyPath 读的是顶层 "body"（不是 poke_body）；候选显式给了就覆盖，保证施加键的身体
            // 与 poke 量的身体是同一个。
            if (!string.IsNullOrEmpty(cand.Body)) req.Set("body", cand.Body);
            var child = new AuditContext();
            child.Request = req;
            child.OutDir = _ctx.OutDir;
            child.Tool = _ctx.Tool;
            child.Status = _ctx.Status;
            child.Avatar = _avatar;
            child.Animator = _anim;
            child.DeadlineRealtime = _ctx.DeadlineRealtime;
            return child;
        }

        private static List<object> BuildCandidateCovers(CandidateSpec cand)
        {
            if (cand == null || cand.Covers.Count == 0 || string.IsNullOrEmpty(cand.Garment)) return null;
            var co = new JsonObject();
            co.Set("garment", cand.Garment);
            co.Set("covers", cand.Covers.Cast<object>().ToList());
            co.Set("confidence", "high");
            return new List<object> { co };
        }

        /// <summary>从一次 poke JSON 里抽出排序/验收需要的度量；硬约束（keys/阈值）也在这里判。</summary>
        private static void ExtractCandidateMetrics(CandidateSpec cand, CandidateRow row, JsonObject pokeJson)
        {
            if (pokeJson == null)
            {
                row.Error = true;
                row.ErrorMessage = "poke 未返回结果";
                return;
            }
            string err = AuditJson.Str(pokeJson, "error", null);
            if (!string.IsNullOrEmpty(err))
            {
                row.Error = true;
                row.ErrorMessage = err;
            }
            row.Truncated = AuditJson.Bool(pokeJson, "truncated", false);
            if (row.Truncated)
            {
                row.HardOk = false;
                row.HardReasons.Add("poke_truncated");
            }

            var pairs = AuditJson.Arr(pokeJson, "pairs");
            int patchCount = 0, opening = 0, openingDeep = 0;
            double totalArea = 0, maxArea = 0, maxDepth = 0;
            double bestArea = -1;
            JsonObject bestPair = null;
            for (int i = 0; i < pairs.Count; i++)
            {
                var pj = pairs[i] as JsonObject;
                if (pj == null) continue;
                patchCount += AuditJson.Int(pj, "patch_count", 0);
                double pa = AuditJson.Num(pj, "total_patch_area_cm2", 0);
                totalArea += pa;
                opening += AuditJson.Int(pj, "opening_verts", 0);
                openingDeep += AuditJson.Int(pj, "opening_deep_verts", 0);
                var patches = AuditJson.Arr(pj, "patches");
                for (int k = 0; k < patches.Count; k++)
                {
                    var pt = patches[k] as JsonObject;
                    if (pt == null) continue;
                    double a = AuditJson.Num(pt, "area_cm2", 0);
                    double dm = AuditJson.Num(pt, "max_depth_mm", 0);
                    if (a > maxArea) maxArea = a;
                    if (dm > maxDepth) maxDepth = dm;
                }
                if (pa > bestArea) { bestArea = pa; bestPair = pj; }
            }
            row.PatchCount = patchCount;
            row.TotalAreaCm2 = totalArea;
            row.MaxPatchAreaCm2 = maxArea;
            row.MaxDepthMm = maxDepth;
            row.OpeningVerts = opening;
            row.OpeningDeepVerts = openingDeep;
            row.BodyExcluded = pokeJson.Get("body_excluded");
            if (bestPair != null)
            {
                row.Garment = AuditJson.Str(bestPair, "garment", row.Garment);
                row.PairConfidence = AuditJson.Str(bestPair, "pair_confidence", null);
                row.BySubPart = bestPair.Get("by_sub_part");
                // 任务 CW：把「0 斑块是为什么」的诊断从原始 poke 配对提到 R9 行上，
                // 这样即使四个 patch 列被抑制成 null，读表的人也能看到 suspect/dropped 证据。
                row.SuspectSubthreshold = AuditJson.Bool(bestPair, "suspect_subthreshold", false);
                row.DroppedComponents = AuditJson.Int(bestPair, "dropped_components", 0);
                row.DroppedMaxAreaCm2 = AuditJson.Num(bestPair, "dropped_max_area_cm2", 0);
                row.DroppedTotalAreaCm2 = AuditJson.Num(bestPair, "dropped_total_area_cm2", 0);
                row.DroppedMaxDepthMm = AuditJson.Num(bestPair, "dropped_max_depth_mm", 0);
                row.AreaPerVertCm2 = AuditJson.Num(bestPair, "area_per_vert_cm2", 0);
                row.AreaPerVertPosSource = AuditJson.Str(bestPair, "area_per_vert_pos_source", null);
                row.MinPatchAreaCm2 = AuditJson.Num(bestPair, "min_patch_area_cm2", 0);
                row.MinPatchAreaSource = AuditJson.Str(bestPair, "min_patch_area_source", null);
                row.Reference = bestPair.Get("reference");
                var dv = AuditJson.Obj(bestPair, "d_v_mm");
                if (dv != null && dv.Has("p50")) row.DepthP50Mm = AuditJson.Num(dv, "p50", 0);
            }

            // 任务 BZ/CF：sd / si / 跟隙 / tilt 来自「脚部度量顶点最多的那个配对」
            // （每个候选只测一件鞋/袜时就是它）。取 max(si.count, sd.count)，保证 v1 与 v2 落到同一配对。
            // 非脚部件候选两者都 count=0，留 null，排序自然落到 |d_v p50| 兜底。
            JsonObject metricPair = null;
            int metricBest = -1;
            for (int i = 0; i < pairs.Count; i++)
            {
                var pj = pairs[i] as JsonObject;
                if (pj == null) continue;
                var sm0 = AuditJson.Obj(pj, "sd_mm");
                var im0 = AuditJson.Obj(pj, "si_mm");
                int cnt0 = Math.Max(sm0 != null ? AuditJson.Int(sm0, "count", 0) : 0,
                                    im0 != null ? AuditJson.Int(im0, "count", 0) : 0);
                if (cnt0 > metricBest) { metricBest = cnt0; metricPair = pj; }
            }
            if (metricPair != null && metricBest > 0)
            {
                var sm = AuditJson.Obj(metricPair, "sd_mm");
                if (sm != null && AuditJson.Int(sm, "count", 0) > 0)
                {
                    row.SdVertCount = AuditJson.Int(sm, "count", 0);
                    if (sm.Has("p05")) row.SdP05Mm = AuditJson.Num(sm, "p05", 0);
                    if (sm.Has("p50")) row.SdP50Mm = AuditJson.Num(sm, "p50", 0);
                    if (sm.Has("p95")) row.SdP95Mm = AuditJson.Num(sm, "p95", 0);
                }
                var sdMeta = AuditJson.Obj(metricPair, "sd_meta");
                if (sdMeta != null) row.SdFootVerts = AuditJson.Int(sdMeta, "foot_verts", 0);
                // 任务 CF（R9 v2）：鞋垫面距离 si、倾角与鞋垫面数。
                var im = AuditJson.Obj(metricPair, "si_mm");
                if (im != null && AuditJson.Int(im, "count", 0) > 0)
                {
                    row.SiVertCount = AuditJson.Int(im, "count", 0);
                    if (im.Has("p05")) row.SiP05Mm = AuditJson.Num(im, "p05", 0);
                    if (im.Has("p50")) row.SiP50Mm = AuditJson.Num(im, "p50", 0);
                    if (im.Has("p95")) row.SiP95Mm = AuditJson.Num(im, "p95", 0);
                }
                var siMeta = AuditJson.Obj(metricPair, "si_meta");
                if (siMeta != null) row.InsoleFaces = AuditJson.Int(siMeta, "insole_faces", 0);
                if (metricPair.Has("tilt_deg")) row.TiltDeg = AuditJson.Num(metricPair, "tilt_deg", 0);
                if (metricPair.Has("foot_plane_tilt_deg")) row.FootPlaneTiltDeg = AuditJson.Num(metricPair, "foot_plane_tilt_deg", 0);
                if (metricPair.Has("insole_plane_tilt_deg")) row.InsolePlaneTiltDeg = AuditJson.Num(metricPair, "insole_plane_tilt_deg", 0);
                // 跟隙：新口径读 heel_gap_mm（到鞋垫面），旧口径另存诊断列。
                var hg = AuditJson.Obj(metricPair, "heel_gap_mm");
                if (hg != null)
                {
                    row.HeelVertCount = AuditJson.Int(hg, "count", 0);
                    if (hg.Has("p50")) row.HeelGapP50Mm = AuditJson.Num(hg, "p50", 0);
                }
                var hgs = AuditJson.Obj(metricPair, "heel_gap_sole_mm");
                if (hgs != null && hgs.Has("p50")) row.HeelGapSoleP50Mm = AuditJson.Num(hgs, "p50", 0);
            }

            if (pairs.Count == 0)
            {
                row.HardOk = false;
                row.HardReasons.Add("no_poke_pair");
            }

            // 候选自带的硬约束（请求显式给阈值才判；没给不猜）。
            if (cand != null)
            {
                if (cand.MaxTotalPatchCm2.HasValue && totalArea > cand.MaxTotalPatchCm2.Value + 1e-9)
                {
                    row.HardOk = false;
                    row.HardReasons.Add("max_total_patch_area_cm2:" + AuditUtil.F(totalArea)
                        + ">" + AuditUtil.F(cand.MaxTotalPatchCm2.Value));
                }
                if (cand.MinOpeningVerts.HasValue && opening < cand.MinOpeningVerts.Value)
                {
                    row.HardOk = false;
                    row.HardReasons.Add("min_opening_verts:" + opening + "<" + cand.MinOpeningVerts.Value);
                }
            }
        }

        /// <summary>
        /// 任务 CS：同一状态内两两比较 patch_count / total_patch_area_cm2 / max_depth_mm / si_p50_mm /
        /// tilt_deg / heel_gap_p50_mm，六项全部相差 &lt;1e-6 的行互相写 indistinguishable_with。
        /// 出错的候选（poke 失败、度量无意义）不参与比较。返回该状态是否存在不可分辨对。
        /// </summary>
        private static bool MarkIndistinguishable(List<CandidateRow> srows)
        {
            if (srows == null) return false;
            for (int i = 0; i < srows.Count; i++) srows[i].IndistinguishableWith.Clear();
            bool any = false;
            for (int i = 0; i < srows.Count; i++)
            {
                var a = srows[i];
                if (a.Error) continue;
                for (int j = i + 1; j < srows.Count; j++)
                {
                    var b = srows[j];
                    if (b.Error) continue;
                    if (!MetricsIndistinguishable(a, b)) continue;
                    if (!a.IndistinguishableWith.Contains(b.CandidateId)) a.IndistinguishableWith.Add(b.CandidateId);
                    if (!b.IndistinguishableWith.Contains(a.CandidateId)) b.IndistinguishableWith.Add(a.CandidateId);
                    any = true;
                }
            }
            return any;
        }

        private static bool MetricsIndistinguishable(CandidateRow a, CandidateRow b)
        {
            return a.PatchCount == b.PatchCount
                && NearD(a.TotalAreaCm2, b.TotalAreaCm2)
                && NearD(a.MaxDepthMm, b.MaxDepthMm)
                && NearD(a.SiP50Mm, b.SiP50Mm)
                && NearD(a.TiltDeg, b.TiltDeg)
                && NearD(a.HeelGapP50Mm, b.HeelGapP50Mm);
        }

        private static bool NearD(double a, double b) { return Math.Abs(a - b) < 1e-6; }

        /// <summary>可空度量：都为 null 视为相同；一个 null 一个非 null 视为不同；否则比差值。</summary>
        private static bool NearD(double? a, double? b)
        {
            if (!a.HasValue && !b.HasValue) return true;
            if (a.HasValue != b.HasValue) return false;
            return Math.Abs(a.Value - b.Value) < 1e-6;
        }

        /// <summary>
        /// 任务 D2（B-T33d）：把不可分辨组转成纯函数输入（只有 IndistinguishableWith 非空的行入组）。
        /// HasZeroDomain 由 zero_applied/zero_missing 反推：清零域非空时，匹配到的进 zero_applied、
        /// 没匹配到的进 zero_missing，两者都空即该候选没声明清零域（如 current_no_zero 的 zero_keys:[]）。
        /// </summary>
        private static R9IndistResult ClassifyR9Indist(List<CandidateRow> ordered)
        {
            var inputs = new List<R9IndistInput>();
            for (int i = 0; i < ordered.Count; i++)
            {
                var r = ordered[i];
                if (r.IndistinguishableWith.Count == 0) continue;
                inputs.Add(new R9IndistInput
                {
                    CandidateId = r.CandidateId,
                    HasKeys = r.Keys.Count > 0,
                    HasZeroDomain = r.ZeroApplied.Count > 0 || r.ZeroMissing.Count > 0,
                    ReadbackCount = r.AppliedReadback.Count,
                    ReadbackSignature = ReadbackSignature(r.AppliedReadback),
                    ZeroMissingCount = r.ZeroMissing.Count
                });
            }
            return ClassifyR9Indistinguishable(inputs);
        }

        /// <summary>任务 D2：applied_readback 的稳定序列化（键排序 + AuditUtil.F 值），供「读回是否两两不同」比较。</summary>
        private static string ReadbackSignature(Dictionary<string, float> readback)
        {
            if (readback == null || readback.Count == 0) return "";
            var parts = new List<string>();
            foreach (var k in readback.Keys.OrderBy(x => x, StringComparer.Ordinal))
                parts.Add(k + "=" + AuditUtil.F(readback[k]));
            return string.Join(";", parts.ToArray());
        }

        // >>> R9_INDISTINGUISHABLE_RULES_BEGIN
        /// <summary>
        /// 任务 D2（B-T33d）：R9「不可分辨」分流纯函数。
        /// 度量全等只是表象：applied_readback 两两不同且都非空，说明候选各自的键确实写进去了，
        /// 全等是候选本身等价（可任选其一，recommended 不该置 null）；读回为空/相同，或清零域
        /// 有键没匹配到（zero_missing 非空），才是「没清零/键没写进去」，推荐才作废。
        /// `current_no_zero` 这类「按设计不写键」的候选（keys 与清零域都为空）不计入「该写」数，
        /// 免得把它的空读回误判成没写进去。
        /// 纯 System 层，不引用 UnityEngine；离线自检（perception/selftest_r9_indistinguishable.py）
        /// 抽取这一整段单独编译运行，测的就是生产同一份代码。
        /// </summary>
        internal enum R9IndistKind
        {
            NotZeroed,             // 没清零 / 键没写进去：recommended 作废
            CandidateEquivalent    // 候选确实等价：recommended 保留（任选其一）
        }

        internal sealed class R9IndistInput
        {
            public string CandidateId = "";
            public bool HasKeys;          // 候选自己列了要写的键
            public bool HasZeroDomain;    // 候选/请求声明了非空清零域
            public int ReadbackCount;     // applied_readback 的键数
            public string ReadbackSignature = "";  // applied_readback 稳定序列化（键排序 + 值），用于两两比较
            public int ZeroMissingCount;  // 清零域里没匹配到的键数
        }

        internal sealed class R9IndistResult
        {
            public R9IndistKind Kind = R9IndistKind.NotZeroed;
            public List<string> Group = new List<string>();     // 该不可分辨组的候选 id（排序）
            public int Writers;                                 // 该写东西（有候选键或清零域）的候选数
            public int WritersWithoutReadback;                  // 其中读回为空的
            public int DistinctReadbacks;                       // 非空读回的互异个数
            public bool AnyZeroMissing;
            public string Reason = "";
        }

        internal static R9IndistResult ClassifyR9Indistinguishable(List<R9IndistInput> rows)
        {
            var res = new R9IndistResult();
            if (rows == null || rows.Count == 0) { res.Reason = "空组"; return res; }
            var sigs = new List<string>();
            for (int i = 0; i < rows.Count; i++)
            {
                var r = rows[i];
                if (r == null) continue;
                res.Group.Add(string.IsNullOrEmpty(r.CandidateId) ? "?" : r.CandidateId);
                if (r.HasKeys || r.HasZeroDomain)
                {
                    res.Writers++;
                    if (r.ReadbackCount <= 0 || string.IsNullOrEmpty(r.ReadbackSignature)) res.WritersWithoutReadback++;
                }
                if (r.ReadbackCount > 0 && !string.IsNullOrEmpty(r.ReadbackSignature)
                    && !sigs.Contains(r.ReadbackSignature)) sigs.Add(r.ReadbackSignature);
                if (r.ZeroMissingCount > 0) res.AnyZeroMissing = true;
            }
            res.DistinctReadbacks = sigs.Count;
            res.Group.Sort(StringComparer.Ordinal);

            bool equivalent = !res.AnyZeroMissing
                && res.Writers >= 2
                && res.WritersWithoutReadback == 0
                && res.DistinctReadbacks == res.Writers;
            res.Kind = equivalent ? R9IndistKind.CandidateEquivalent : R9IndistKind.NotZeroed;

            if (equivalent)
            {
                res.Reason = "applied_readback 两两不同且都非空（" + res.Writers + " 个候选的键都确实写进去了），"
                    + "度量全等是候选本身等价，可任选其一。";
            }
            else
            {
                string why;
                if (res.AnyZeroMissing) why = "清零域里有键没匹配到（zero_missing 非空）";
                else if (res.WritersWithoutReadback > 0) why = "有候选本该写键却读回为空（键没写进去）";
                else if (res.Writers >= 2) why = "候选读回相同（只写了自己列的键、没清掉同族键）";
                else why = "同组里没有两个读回各异的写键候选（有候选根本没写键、也没清零）";
                res.Reason = why + "，多半是没清零或键没写进去，推荐不可信。";
            }
            return res;
        }
        // <<< R9_INDISTINGUISHABLE_RULES_END

        private static int CompareCandidateRows(CandidateRow a, CandidateRow b)
        {
            return CandidateRankOrder.Compare(
                a.TotalAreaCm2, a.MaxDepthMm, a.SiP50Mm == null ? (double?)null : Math.Abs(a.SiP50Mm.Value),
                CandidateRankOrder.Penetration(a.SiP05Mm), a.TiltDeg, a.SdP50Mm, a.HeelGapP50Mm, a.DepthP50Mm, a.CandidateId,
                b.TotalAreaCm2, b.MaxDepthMm, b.SiP50Mm == null ? (double?)null : Math.Abs(b.SiP50Mm.Value),
                CandidateRankOrder.Penetration(b.SiP05Mm), b.TiltDeg, b.SdP50Mm, b.HeelGapP50Mm, b.DepthP50Mm, b.CandidateId);
        }

        /// <summary>任务 CS：float 字典 → JsonObject（键排序，便于 repeat_check 逐字节比）。</summary>
        private static JsonObject FloatDictToJson(Dictionary<string, float> d)
        {
            var o = new JsonObject();
            if (d == null) return o;
            foreach (var k in d.Keys.OrderBy(x => x, StringComparer.Ordinal)) o.Set(k, (double)d[k]);
            return o;
        }

        /// <summary>任务 CW：该状态的 patch 四列是否不可判定、必须在输出里抑制成 null。
        /// 触发：state_indistinguishable / low_confidence / top2_gap_ratio=0（前两名斑块面积相同）。</summary>
        internal static bool PatchColumnsSuppressed(bool lowConfidence, double? top2GapRatio, bool stateIndistinguishable)
        {
            if (stateIndistinguishable) return true;
            if (lowConfidence) return true;
            if (top2GapRatio.HasValue && top2GapRatio.Value <= 0.0) return true;
            return false;
        }

        /// <summary>任务 CW：抑制原因（中文，给状态对象的 patch_columns_suppressed_reason）。</summary>
        internal static string PatchColumnsSuppressedReason(bool lowConfidence, double? top2GapRatio, bool stateIndistinguishable)
        {
            var why = new List<string>();
            if (stateIndistinguishable) why.Add("state_indistinguishable=true（同状态候选度量完全一致）");
            if (lowConfidence)
                why.Add("low_confidence=true（top2 斑块面积差比 "
                    + (top2GapRatio.HasValue ? AuditUtil.F((float)top2GapRatio.Value) : "null") + " < 0.10）");
            if (top2GapRatio.HasValue && top2GapRatio.Value <= 0.0)
                why.Add("top2_gap_ratio=" + AuditUtil.F((float)top2GapRatio.Value) + "（前两名斑块面积相同）");
            return "patch 四列（patch_count/total_patch_area_cm2/max_patch_area_cm2/max_depth_mm）已抑制为 null："
                + string.Join("；", why.ToArray())
                + "。这个状态下斑块度量区分不出候选，读到 0 会被误当成「无穿出」；"
                + "要判几何请查该行的 si/sd/tilt/d_v_p50 或原始 poke 产出（pairs[].dropped_components 等）。";
        }

        private static JsonObject CandidateRowToJson(CandidateRow r)
        {
            var o = new JsonObject();
            o.Set("candidate", r.CandidateId);
            o.Set("rank", r.Rank);
            o.Set("hard_ok", r.HardOk);
            o.Set("hard_reasons", r.HardReasons.Cast<object>().ToList());
            o.Set("error", r.Error);
            if (r.Error) o.Set("error_message", r.ErrorMessage);
            var keys = new JsonObject();
            foreach (var k in r.Keys.Keys.OrderBy(x => x, StringComparer.Ordinal)) keys.Set(k, (double)r.Keys[k]);
            o.Set("keys", keys);
            // 任务 CS：清零记录 + 写后读回 + 清零域里没匹配到的键（新增字段，缺省为空容器）。
            o.Set("zero_applied", FloatDictToJson(r.ZeroApplied));
            o.Set("applied_readback", FloatDictToJson(r.AppliedReadback));
            o.Set("zero_missing", r.ZeroMissing.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList());
            if (r.IndistinguishableWith.Count > 0)
                o.Set("indistinguishable_with", r.IndistinguishableWith.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList());
            o.Set("garment", r.Garment);
            o.Set("pair_confidence", r.PairConfidence);
            // 任务 CW：低置信状态不许输出看着像通过的 0。四列输出 null + patch_verdict=undecidable，
            // 理由写在该状态对象的 patch_columns_suppressed_reason 里（内部排序仍用原值，只是不给下游读）。
            if (r.PatchColumnsSuppressed)
            {
                o.Set("patch_count", null);
                o.Set("total_patch_area_cm2", null);
                o.Set("max_patch_area_cm2", null);
                o.Set("max_depth_mm", null);
                o.Set("patch_verdict", "undecidable");
            }
            else
            {
                o.Set("patch_count", r.PatchCount);
                o.Set("total_patch_area_cm2", r.TotalAreaCm2);
                o.Set("max_patch_area_cm2", r.MaxPatchAreaCm2);
                o.Set("max_depth_mm", r.MaxDepthMm);
            }
            // 任务 CW：斑块 0 的诊断（不被抑制；四列为 null 时这几列是判断几何的直接证据）。
            o.Set("suspect_subthreshold", r.SuspectSubthreshold);
            o.Set("dropped_components", r.DroppedComponents);
            o.Set("dropped_max_area_cm2", r.DroppedMaxAreaCm2);
            o.Set("dropped_total_area_cm2", r.DroppedTotalAreaCm2);
            o.Set("dropped_max_depth_mm", r.DroppedMaxDepthMm);
            o.Set("area_per_vert_cm2", r.AreaPerVertCm2);
            o.Set("area_per_vert_pos_source", r.AreaPerVertPosSource);
            o.Set("min_patch_area_cm2", r.MinPatchAreaCm2);
            o.Set("min_patch_area_source", r.MinPatchAreaSource);
            o.Set("d_v_p50_mm", r.DepthP50Mm.HasValue ? (object)r.DepthP50Mm.Value : null);
            o.Set("sd_p05_mm", r.SdP05Mm.HasValue ? (object)r.SdP05Mm.Value : null);
            o.Set("sd_p50_mm", r.SdP50Mm.HasValue ? (object)r.SdP50Mm.Value : null);
            o.Set("sd_p95_mm", r.SdP95Mm.HasValue ? (object)r.SdP95Mm.Value : null);
            o.Set("sd_vert_count", r.SdVertCount);
            o.Set("sd_foot_verts", r.SdFootVerts);
            o.Set("heel_gap_p50_mm", r.HeelGapP50Mm.HasValue ? (object)r.HeelGapP50Mm.Value : null);
            o.Set("heel_vert_count", r.HeelVertCount);
            // 任务 CF（R9 v2）
            o.Set("si_p05_mm", r.SiP05Mm.HasValue ? (object)r.SiP05Mm.Value : null);
            o.Set("si_p50_mm", r.SiP50Mm.HasValue ? (object)r.SiP50Mm.Value : null);
            o.Set("si_p95_mm", r.SiP95Mm.HasValue ? (object)r.SiP95Mm.Value : null);
            o.Set("si_vert_count", r.SiVertCount);
            o.Set("insole_faces", r.InsoleFaces);
            o.Set("tilt_deg", r.TiltDeg.HasValue ? (object)r.TiltDeg.Value : null);
            o.Set("foot_plane_tilt_deg", r.FootPlaneTiltDeg.HasValue ? (object)r.FootPlaneTiltDeg.Value : null);
            o.Set("insole_plane_tilt_deg", r.InsolePlaneTiltDeg.HasValue ? (object)r.InsolePlaneTiltDeg.Value : null);
            o.Set("heel_gap_sole_p50_mm", r.HeelGapSoleP50Mm.HasValue ? (object)r.HeelGapSoleP50Mm.Value : null);
            o.Set("opening_verts", r.OpeningVerts);
            o.Set("opening_deep_verts", r.OpeningDeepVerts);
            o.Set("truncated", r.Truncated);
            if (r.BySubPart != null) o.Set("by_sub_part", r.BySubPart);
            if (r.Reference != null) o.Set("reference", r.Reference);
            if (r.BodyExcluded != null) o.Set("body_excluded", r.BodyExcluded);
            return o;
        }

        /// <summary>
        /// 整批结束（在 states.json 之后）按 part 写 r9_&lt;part&gt;.json 排序表。
        /// 排序：硬约束通过且有结果的候选在前（按斑块总面积↑、最大深度↑、|si p50|↑、si 陷入量↑、tilt↑、
        /// |sd p50|↑、跟隙↑、|d_v p50|↑），硬约束不过/出错的排最后且 rank=0；
        /// 穿越计数与包含率只作参考列，不参与排序。
        /// </summary>
        private void WriteCandidateTables()
        {
            if (_candidates.Count == 0) return;
            var parts = _candidates.Select(c => c.Part).Distinct().OrderBy(x => x, StringComparer.Ordinal).ToList();
            for (int pi = 0; pi < parts.Count; pi++)
            {
                string part = parts[pi];
                var rows = _candidateRows.Where(r => string.Equals(r.Part, part, StringComparison.Ordinal)).ToList();
                var present = new HashSet<string>(rows.Select(r => r.State), StringComparer.Ordinal);
                var orderedStates = new List<string>();
                for (int i = 0; i < _states.Count; i++)
                    if (present.Contains(_states[i].Id)) orderedStates.Add(_states[i].Id);
                foreach (var extra in present.OrderBy(x => x, StringComparer.Ordinal))
                    if (!orderedStates.Contains(extra)) orderedStates.Add(extra);

                var stateArr = new List<object>();
                var recommended = new JsonObject();
                // 任务 CS：本 part 的顶层告警（不可分辨状态）。
                var r9Warnings = new List<object>();
                for (int si = 0; si < orderedStates.Count; si++)
                {
                    string sid = orderedStates[si];
                    var srows = rows.Where(r => string.Equals(r.State, sid, StringComparison.Ordinal)).ToList();
                    var pass = srows.Where(r => r.HardOk && !r.Error).ToList();
                    var fail = srows.Where(r => !(r.HardOk && !r.Error)).ToList();
                    pass.Sort(CompareCandidateRows);
                    for (int i = 0; i < pass.Count; i++) pass[i].Rank = i + 1;
                    for (int i = 0; i < fail.Count; i++) fail[i].Rank = 0;
                    var ordered = pass.Concat(fail).ToList();

                    // 任务 CS：同一状态内两两比较六项度量，全部 <1e-6 的行互相标记。
                    bool stateIndistinguishable = MarkIndistinguishable(ordered);
                    // 任务 D2（B-T33d）：度量全等只是表象，再按 applied_readback / zero_missing 分流——
                    // 读回两两不同 = 候选真等价（recommended 保留）；读回为空/相同或 zero_missing 非空 = 没清零。
                    R9IndistResult indist = stateIndistinguishable ? ClassifyR9Indist(ordered) : null;

                    double? gap = null;
                    bool low = false;
                    if (pass.Count >= 2)
                    {
                        double a1 = pass[0].TotalAreaCm2, a2 = pass[1].TotalAreaCm2;
                        double denom = Math.Max(Math.Max(a1, a2), 1e-9);
                        gap = Math.Abs(a2 - a1) / denom;
                        low = gap.Value < 0.10;
                    }
                    // 任务 CW：先把抑制标记打到行上，再序列化 rows（否则 null 写不进去）。
                    bool suppressPatch = PatchColumnsSuppressed(low, gap, stateIndistinguishable);
                    for (int i = 0; i < ordered.Count; i++) ordered[i].PatchColumnsSuppressed = suppressPatch;
                    var so = new JsonObject();
                    so.Set("state", sid);
                    so.Set("candidate_count", ordered.Count);
                    so.Set("rows", ordered.Select(CandidateRowToJson).Cast<object>().ToList());
                    so.Set("low_confidence", low);
                    so.Set("top2_gap_ratio", gap.HasValue ? (object)gap.Value : null);
                    so.Set("state_indistinguishable", stateIndistinguishable);
                    if (indist != null)
                    {
                        so.Set("indistinguishable_kind",
                            indist.Kind == R9IndistKind.CandidateEquivalent ? "candidate_equivalent" : "not_zeroed");
                        so.Set("indistinguishable_group", indist.Group.Cast<object>().ToList());
                        so.Set("indistinguishable_reason", indist.Reason);
                    }
                    so.Set("patch_columns_suppressed", suppressPatch);
                    if (suppressPatch)
                    {
                        string reason = PatchColumnsSuppressedReason(low, gap, stateIndistinguishable);
                        so.Set("patch_columns_suppressed_reason", reason);
                        r9Warnings.Add("状态 '" + sid + "'：" + reason);
                    }
                    if (indist != null && indist.Kind == R9IndistKind.CandidateEquivalent)
                    {
                        // 任务 D2：真等价。recommended 不置 null（排序第一；tie-break 末项是候选 id，结果确定）。
                        string pick = pass.Count > 0 ? pass[0].CandidateId : null;
                        so.Set("recommended", pick);
                        if (pick != null) recommended.Set(sid, pick);
                        so.Set("recommended_note", "候选等价，任选其一（applied_readback 两两不同、六项度量全等）");
                        r9Warnings.Add("状态 '" + sid + "'：候选 " + string.Join("、", indist.Group.ToArray())
                            + " 的六项度量完全一致，但 applied_readback 两两不同（" + indist.Writers
                            + " 个候选的键都确实写进去了），判为候选等价，可任选其一（recommended 保留）。");
                    }
                    else if (indist != null)
                    {
                        so.Set("recommended", null);
                        recommended.Set(sid, null);   // 顶层 map 保留状态键（值为 null），避免下游按 key 取值时 KeyError
                        so.Set("recommended_suppressed_reason",
                            "候选度量完全一致（indistinguishable_with）：" + indist.Reason);
                        r9Warnings.Add("状态 '" + sid + "'：候选 " + string.Join("、", indist.Group.ToArray())
                            + " 的度量完全一致（patch_count/total_patch_area_cm2/max_depth_mm/si_p50_mm/tilt_deg/heel_gap_p50_mm 全部相差 <1e-6），"
                            + indist.Reason);
                    }
                    else
                    {
                        so.Set("recommended", pass.Count > 0 ? pass[0].CandidateId : null);
                        if (pass.Count > 0) recommended.Set(sid, pass[0].CandidateId);
                    }
                    stateArr.Add(so);
                }

                var o = new JsonObject();
                o.Set("tool", "r9");
                o.Set("part", part);
                o.Set("file", "r9_" + AuditUtil.SafeFileName(part) + ".json");
                o.Set("sort_rule", "先硬约束（keys 全解析、poke 无 error/truncated、请求 hard 阈值），再按"
                    + "斑块总面积↑、最大深度↑、|si p50|↑、si 陷入量(-si p05)↑、tilt_deg↑、|sd p50|↑、跟隙(p50)↑、|d_v p50|↑；"
                    + "穿越计数/包含率只作参考列，不参与排序（B3/F26）。"
                    + "↑=升序（值越小越靠前）；si/tilt/sd/跟隙缺失时该项排在有值之后。"
                    + "si/tilt 为 R9 v2（鞋垫面口径），排在 v1 的 |sd p50| 之前（CF，2026-09-19）。");
                o.Set("crossing_counts_used_in_sort", false);
                o.Set("reference_enabled", _candidatesReference);
                o.Set("zero_rule", "任务 CS：施加候选前，先把清零域（请求级 candidates_zero，候选级 zero_keys 覆盖）里在该候选 mesh 上"
                    + "匹配到的每个键写 0（同名多片全写），再写候选自己的键；清零前的旧值写进每行 zero_applied，"
                    + "全部写完后读回写进每行 applied_readback（证明真的写进去了），清零域里没匹配到的键写进 zero_missing（不算 hard 失败）。"
                    + "不清零时，服装已把脚部键驱动成 100 的候选（none、只列部分键的候选）会量到同一个姿势，"
                    + "所以同状态内六项度量完全一致的行互相标 indistinguishable_with；再按 applied_readback 分流（任务 D2/B-T33d）："
                    + "读回两两不同且都非空 = 候选确实等价（indistinguishable_kind=candidate_equivalent，recommended 保留、任选其一），"
                    + "读回为空/相同或 zero_missing 非空 = 没清零/键没写进去（indistinguishable_kind=not_zeroed，recommended 置 null）。");
                o.Set("note", "R9 v2（任务 CF）：si 是脚部 covers 内「朝下」身体顶点到最近「鞋垫面」的有向距离"
                    + "（鞋垫面 = 法线朝上、在脚部包围盒内、高出朝下外底合理厚度的三角形，不要求是外壳）"
                    + "，正=悬空、负=陷入鞋垫；tilt_deg 是脚底朝下顶点拟合平面与鞋垫面拟合平面的夹角（平底应接近 0）。"
                    + "v1 的 sd（到最近朝下壳面=外底）与跟隙仍在表里：sd 是参考键，跟隙已改成「脚跟段朝下顶点到鞋垫面的 si p50」。"
                    + "为什么换口径：B-T08b 标定里 v1 的 sd 量到外底，半抬脚跟时前掌陷进鞋底实体、离外底反而近，"
                    + "把 Foot_heel_OFF=50 排到了平脚的 =100 前（工程A 09-19 实测）；鞋垫面口径才反映「脚贴不贴鞋垫」。"
                    + "取每个候选那次 poke 配对中 si/sd 顶点数最大的配对。"
                    + "实测状态若整体倾斜，si/tilt 会偏（假定站立、世界向上即脚底法线）。"
                    + "拉丝本版标 not_implemented（03b 定义：最长边比>3 或面积<1% 或法线翻转），不参与排序。详见 审查/docs/foot-shoe-candidates-metrics.md（原 README §3.4）。");
                var nimpl = new JsonObject();
                nimpl.Set("stringing", "not_implemented");
                nimpl.Set("stringing_definition", "03b Q2-Q7：烘焙三角形与基线比，最长边比>3 或面积<1% 或法线翻转；收缩键过量触发（MMN Foot=100 & Toe=100 尖锥拖丝）。");
                nimpl.Set("category_constraint", "not_implemented");
                o.Set("not_implemented", nimpl);
                if (r9Warnings.Count > 0) o.Set("warnings", r9Warnings);
                o.Set("states", stateArr);
                o.Set("recommended", recommended);
                string path = _ctx.OutPath("r9_" + AuditUtil.SafeFileName(part) + ".json");
                AuditJson.WriteFile(path, o);
                _ctx.Status.Log("R9 排序表已写 " + path + "（" + stateArr.Count + " 个状态）");
            }
        }

        private void AdvanceAfterSnapshot()
        {
            _stateIndex++;
            if (_stateIndex >= _states.Count)
            {
                _stateIndex = 0;
                _passIndex++;
                if (_passIndex >= _passCount)
                {
                    FinishAll();
                    _phase = Phase.Done;
                    return;
                }
            }
            _phase = Phase.Reset;
        }

        /// <summary>
        /// 健全性检查（每个状态设完、等完帧之后）：头像根 lossyScale 三分量都在 0.5–2，
        /// 且 Head 世界坐标 y 比 Hips 高 0.2 m 以上。不满足 → 该状态 sanity_failed=true，
        /// 明细写进 state_*.json，并在整批结束时把 status 置 error。
        /// </summary>
        private void ApplySanityCheck(AuditStateSpec spec, AuditStateSnapshot snap)
        {
            var s = _avatar.transform.lossyScale;
            bool scaleOk = s.x >= 0.5f && s.x <= 2f && s.y >= 0.5f && s.y <= 2f && s.z >= 0.5f && s.z <= 2f;
            if (!scaleOk)
                snap.SanityReasons.Add("头像根 lossyScale=(" + AuditUtil.F(s.x) + ", " + AuditUtil.F(s.y) + ", " + AuditUtil.F(s.z)
                    + ")，三分量须都在 0.5–2");

            var head = _anim.GetBoneTransform(HumanBodyBones.Head);
            var hips = _anim.GetBoneTransform(HumanBodyBones.Hips);
            if (head == null || hips == null)
            {
                snap.SanityReasons.Add("取不到 Head/Hips 骨骼（Head=" + (head != null) + "，Hips=" + (hips != null) + "），无法校验骨架高度");
            }
            else
            {
                float dy = head.position.y - hips.position.y;
                if (dy <= 0.2f)
                    snap.SanityReasons.Add("Head-Hips 高度差=" + AuditUtil.F(dy) + " m，须 > 0.2 m（Head="
                        + AuditUtil.F(head.position.y) + "，Hips=" + AuditUtil.F(hips.position.y) + "）");
            }

            snap.SanityFailed = snap.SanityReasons.Count > 0;
            if (snap.SanityFailed)
            {
                var reason = spec.Id + ": " + string.Join("；", snap.SanityReasons.ToArray());
                _sanityFailed = true;
                _sanityFailures.Add(reason);
                _ctx.Warn("状态 " + spec.Id + " 健全性检查失败：" + string.Join("；", snap.SanityReasons.ToArray()));
            }
        }

        private void DoVolatileCompare()
        {
            var spec = _states[0];
            var second = Capture(spec);
            CompareVolatileBlendshapes(_volatileFirst, second);

            var names = new List<string>();
            for (int i = 0; i < _volatileOrder.Count; i++)
            {
                var v = _volatileShapes[_volatileOrder[i]];
                names.Add(v.Path + "/" + v.Shape);
            }
            _ctx.Status.Log("volatile 探测：第一个状态 '" + spec.Id + "' 两次快照不同的形态键 " + _volatileShapes.Count + " 个"
                + (names.Count > 0 ? "（" + string.Join(", ", names.ToArray()) + "）" : ""));
        }

        private void CompareVolatileBlendshapes(AuditStateSnapshot a, AuditStateSnapshot b)
        {
            if (a == null || b == null) return;
            var keys = new HashSet<string>(a.Blendshapes.Keys);
            foreach (var k in b.Blendshapes.Keys) keys.Add(k);

            foreach (var key in keys.OrderBy(x => x, StringComparer.Ordinal))
            {
                Dictionary<string, float> sa, sb;
                a.Blendshapes.TryGetValue(key, out sa);
                b.Blendshapes.TryGetValue(key, out sb);
                if (sa == null) sa = new Dictionary<string, float>();
                if (sb == null) sb = new Dictionary<string, float>();

                var names = new HashSet<string>(sa.Keys);
                foreach (var n in sb.Keys) names.Add(n);
                foreach (var n in names)
                {
                    float va = sa.ContainsKey(n) ? sa[n] : 0f;
                    float vb = sb.ContainsKey(n) ? sb[n] : 0f;
                    if (Mathf.Abs(va - vb) <= _blendEps) continue;
                    var vk = VolKey(key, n);
                    if (_volatileShapes.ContainsKey(vk)) continue;
                    _volatileShapes[vk] = new VolatileShape { Path = key, Shape = n, First = va, Second = vb };
                    _volatileOrder.Add(vk);
                }
            }
        }

        private static string VolKey(string path, string shape) { return path + "\u0000" + shape; }

        private HashSet<string> VolatileKeySet()
        {
            return new HashSet<string>(_volatileShapes.Keys, StringComparer.Ordinal);
        }

        // ------------------------------------------------------------------ 参数读写

        private bool HasAnimatorParam(string name) { return _animParams.ContainsKey(name); }

        private float ReadAnimatorParam(string name)
        {
            var p = _animParams[name];
            switch (p.type)
            {
                case AnimatorControllerParameterType.Float: return _anim.GetFloat(name);
                case AnimatorControllerParameterType.Int: return _anim.GetInteger(name);
                case AnimatorControllerParameterType.Bool: return _anim.GetBool(name) ? 1f : 0f;
                default: return 0f;
            }
        }

        private void WriteAnimatorParam(string name, float value)
        {
            var p = _animParams[name];
            switch (p.type)
            {
                case AnimatorControllerParameterType.Float: _anim.SetFloat(name, value); break;
                case AnimatorControllerParameterType.Int: _anim.SetInteger(name, (int)Math.Round(value)); break;
                case AnimatorControllerParameterType.Bool: _anim.SetBool(name, value != 0f); break;
                case AnimatorControllerParameterType.Trigger:
                    if (value != 0f) _anim.SetTrigger(name);
                    break;
            }
        }

        private bool TryReadCurrent(string name, out float value)
        {
            value = 0f;
            if (_gmControlled)
            {
                var p = GmgBridge.GetParam(_module, name);
                if (p != null) { value = GmgBridge.GetParamValue(_module, p); return true; }
            }
            if (HasAnimatorParam(name)) { value = ReadAnimatorParam(name); return true; }
            return false;
        }

        /// <summary>优先 GM API；GM 没有这个参数或没接管时才写 Animator。</summary>
        private bool SetOne(string name, float value, out string source)
        {
            source = null;
            if (_gmControlled)
            {
                var p = GmgBridge.GetParam(_module, name);
                if (p != null)
                {
                    string err;
                    if (GmgBridge.SetParam(_module, p, value, out err)) { source = "gesture_manager"; return true; }
                    _curWarnings.Add("GM 设置参数 '" + name + "' 失败：" + err);
                }
            }
            if (HasAnimatorParam(name))
            {
                WriteAnimatorParam(name, value);
                source = "animator";
                return true;
            }
            return false;
        }

        /// <summary>
        /// 只复位「用户可控参数」= 表达参数里声明 − VRChat 内置参数。
        /// 值按 _resetMode：declared = 表达参数声明的 defaultValue（读不到退回启动实值，见 BuildResetValues）；
        /// startup = T1 启动实值；none = 直接跳过（切换残留测试用，状态会接着上一状态累积）。
        /// Animator-only 参数与内置参数一律不碰——内置参数被写成声明默认值正是把头像缩成 0 的原因。
        /// 每个状态记录 reset_values_source / reset_count 写进 state_*.json。
        /// </summary>
        private void ResetAllParams()
        {
            _curResetCount = 0;
            if (_resetMode == "none")
            {
                _curResetSource = "none";
                return;
            }
            _curResetSource = _resetPrimarySource;

            foreach (var n in _resetNames)
            {
                float def;
                if (!_resetValues.TryGetValue(n, out def)) continue;
                string src;
                if (SetOne(n, def, out src)) _curResetCount++;
            }
        }

        // ------------------------------------------------------------------ 快照

        private AuditStateSnapshot Capture(AuditStateSpec spec)
        {
            var snap = new AuditStateSnapshot();
            snap.Id = spec.Id;
            snap.Driver = ComputeDriver(spec);
            foreach (var kv in spec.Params) snap.ParamsApplied[kv.Key] = kv.Value;
            foreach (var kv in _curSources) snap.ParamSources[kv.Key] = kv.Value;
            snap.MissingParams.AddRange(_curMissing);
            snap.Warnings.AddRange(_curWarnings);
            snap.ResetValuesSource = _curResetSource;
            snap.ResetCount = _curResetCount;
            snap.History.AddRange(spec.History);

            // 渲染器
            var visJson = new JsonObject();   // T-13：V1/V2/V3/V4 四分量
            var renderers = _avatar.GetComponentsInChildren<Renderer>(true);
            foreach (var r in renderers)
            {
                if (r == null) continue;
                var rs = new AuditRendererSnap();
                rs.Path = AuditUtil.RelPath(_avatar.transform, r.transform);
                rs.Type = r.GetType().Name;
                rs.ActiveInHierarchy = r.gameObject.activeInHierarchy;
                rs.Enabled = r.enabled;
                try
                {
                    var mats = r.sharedMaterials;
                    for (int i = 0; i < mats.Length; i++)
                    {
                        var m = mats[i];
                        var ms = new AuditMatSnap();
                        ms.Slot = i;
                        ms.IsNull = m == null;
                        ms.Name = m == null ? null : m.name;
                        ms.Shader = (m != null && m.shader != null) ? m.shader.name : null;
                        ms.Queue = m == null ? 0 : m.renderQueue;
                        ms.V3 = BuildV3(m);
                        rs.Materials.Add(ms);
                    }
                }
                catch (Exception e)
                {
                    snap.Warnings.Add("读 " + rs.Path + " 的材质失败：" + e.Message);
                }

                var key = UniqueKey(snap.Renderers.Keys, rs.Path);
                snap.Renderers[key] = rs;

                var vo = new JsonObject();
                vo.Set("V1_active_in_hierarchy", rs.ActiveInHierarchy);
                vo.Set("V2_enabled", rs.Enabled);
                vo.Set("visible", rs.Visible);
                string agg = "unknown";
                var slotVerdicts = new List<string>();
                for (int i = 0; i < rs.Materials.Count; i++)
                    if (rs.Materials[i].V3 != null) slotVerdicts.Add(AuditJson.Str(rs.Materials[i].V3, "value", "unknown"));
                agg = AuditV3Rules.Aggregate(slotVerdicts);
                vo.Set("V3_alpha_mask", agg);
                vo.Set("V3_hidden", agg == AuditV3Rules.Hidden ? (object)true : (agg == AuditV3Rules.Visible ? (object)false : null));
                vo.Set("V4_kept_ratio", null);   // SMR 在下面的形态键循环里覆盖
                visJson.Set(key, vo);
            }

            // 形态键：blendshapes 只记非零（旧口径，T-14 沿用）；T-13 的 keys_all 记每个 SMR 全部键（含 0，带索引与来源名）。
            // V4 = 烘焙排除桶比例（顶点保留率），静态（绑定姿态 + 骨架）判定并缓存。
            var smrs = _avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
            Array.Sort(smrs, delegate (SkinnedMeshRenderer a, SkinnedMeshRenderer b)
            {
                string pa = a == null ? "" : AuditUtil.RelPath(_avatar.transform, a.transform);
                string pb = b == null ? "" : AuditUtil.RelPath(_avatar.transform, b.transform);
                return string.CompareOrdinal(pa, pb);
            });
            var keysAllJson = new JsonObject();
            for (int si = 0; si < smrs.Length; si++)
            {
                var smr = smrs[si];
                if (smr == null) continue;
                var mesh = smr.sharedMesh;
                if (mesh == null) continue;
                var dict = new Dictionary<string, float>();
                int count = mesh.blendShapeCount;
                var keyArr = new List<object>();
                for (int i = 0; i < count; i++)
                {
                    string shapeName = mesh.GetBlendShapeName(i);
                    float w = smr.GetBlendShapeWeight(i);
                    if (Mathf.Abs(w) > _blendEps) dict[shapeName] = w;
                    var ke = new JsonObject();
                    ke.Set("index", i);
                    ke.Set("name", shapeName);
                    ke.Set("weight", (double)w);
                    keyArr.Add(ke);
                }
                var basePath = AuditUtil.RelPath(_avatar.transform, smr.transform);
                var key = UniqueKey(snap.Blendshapes.Keys, basePath);
                snap.Blendshapes[key] = dict;

                string origin;
                string sourceName = GuessSourceName(basePath, smr.gameObject.name, mesh.name, out origin);
                var v4 = ComputeV4(smr, mesh);
                var ka = new JsonObject();
                ka.Set("built_name", smr.gameObject.name);
                ka.Set("built_path", basePath);
                ka.Set("mesh", mesh.name);
                ka.Set("source_name", sourceName);
                ka.Set("source_name_origin", origin);
                ka.Set("blendshape_count", count);
                ka.Set("keys", keyArr);
                ka.Set("v4", v4);
                keysAllJson.Set(key, ka);

                string vk = FindVisKey(visJson, basePath);
                if (vk != null)
                {
                    var vo = visJson.Get(vk) as JsonObject;
                    if (vo != null)
                    {
                        vo.Set("V4_kept_ratio", v4.Get("kept_ratio"));
                        vo.Set("V4_buckets", v4.Get("buckets"));
                    }
                }
            }
            snap.KeysAll = keysAllJson;
            snap.Visibility = visJson;

            // 骨骼世界坐标
            foreach (var boneName in _trackBones)
            {
                var t = ResolveBone(boneName);
                if (t == null) { snap.BonesMissing.Add(boneName); continue; }
                var p = t.position;
                snap.Bones[boneName] = new[] { p.x, p.y, p.z };
            }

            var ap = _avatar.transform.position;
            var ar = _avatar.transform.rotation.eulerAngles;
            snap.AvatarPosition = new[] { ap.x, ap.y, ap.z };
            snap.AvatarRotation = new[] { ar.x, ar.y, ar.z };
            return snap;
        }

        // ------------------------------------------------------------------ T-13：回读断言 / 哨兵 / 规范 id

        /// <summary>
        /// 状态回读断言：请求参数 vs 实际参数（GM/Animator 读回）vs 期望可见部件集。
        /// 不一致不抛异常（不把工具打崩），而是标 readback_failed，整批结束时 status=aborted，数据保留。
        /// 任务 BJ（B-补-19）：命中请求级/状态级 expect_override，或实际值等于某个驱动器 Set 写值时，
        /// 该参数不判失败，改记 overridden（明细进 state_*.json.overridden / readback.params[].overridden）。
        /// </summary>
        private void ApplyReadbackAssertion(AuditStateSpec spec, AuditStateSnapshot snap)
        {
            var rb = new JsonObject();
            var failures = new List<string>();

            // 1) 请求参数 vs 实际值；顺带按 gear_slots 算槽号。
            var paramsJson = new JsonObject();
            var actualVals = new Dictionary<string, float>(StringComparer.Ordinal);
            foreach (var kv in spec.Params.OrderBy(x => x.Key, StringComparer.Ordinal))
            {
                float actual;
                bool ok = TryReadCurrent(kv.Key, out actual);
                bool match = ok && ReadbackMatch(kv.Value, actual, _readbackEps);
                bool overridden = false;
                string overrideExpected = null;
                string overrideSource = null;
                if (!match)
                {
                    OverrideSpec ov;
                    if (!spec.ExpectOverride.TryGetValue(kv.Key, out ov))
                        _expectOverrideDefault.TryGetValue(kv.Key, out ov);
                    if (ov != null)
                    {
                        overrideExpected = ov.Raw;
                        if (ov.Any) { overridden = true; overrideSource = "expect_override_any"; }
                        else if (ok && ReadbackMatch(ov.Value, actual, _readbackEps))
                        { overridden = true; overrideSource = "expect_override_value"; }
                    }
                    string drvDetail;
                    if (!overridden && _readbackDriverOverride && ok && TryDriverOverride(kv.Key, actual, out drvDetail))
                    {
                        overridden = true;
                        overrideSource = "driver_set";
                        overrideExpected = drvDetail;
                    }
                }
                var e = new JsonObject();
                e.Set("requested", (double)kv.Value);
                e.Set("actual", ok ? (object)(double)actual : null);
                e.Set("delta", ok ? (object)(double)(actual - kv.Value) : null);
                e.Set("matched_requested", match);
                e.Set("overridden", overridden);
                if (overridden) { e.Set("override_expected", overrideExpected); e.Set("override_source", overrideSource); }
                e.Set("ok", match || overridden);
                e.Set("source", _curSources.ContainsKey(kv.Key) ? _curSources[kv.Key] : "missing");
                int n;
                if (_gearSlots.TryGetValue(kv.Key, out n) && n > 0)
                {
                    e.Set("gear_n", n);
                    e.Set("gear_slot", SlotOf(ok ? actual : kv.Value, n));
                }
                paramsJson.Set(kv.Key, e);
                actualVals[kv.Key] = ok ? actual : kv.Value;
                if (overridden)
                {
                    snap.Overridden.Add(kv.Key);
                    var rec = new JsonObject();
                    rec.Set("state", spec.Id);
                    rec.Set("param", kv.Key);
                    rec.Set("requested", (double)kv.Value);
                    rec.Set("actual", ok ? (object)(double)actual : null);
                    rec.Set("override_expected", overrideExpected);
                    rec.Set("override_source", overrideSource);
                    _readbackOverrides.Add(rec);
                    snap.Warnings.Add("参数 '" + kv.Key + "' 请求 " + AuditUtil.F(kv.Value) + "，实际 "
                        + (ok ? AuditUtil.F(actual) : "<读不到>") + " → 放行（" + overrideSource + "：" + overrideExpected + "）");
                }
                else if (!match)
                {
                    failures.Add("参数 '" + kv.Key + "' 请求 " + AuditUtil.F(kv.Value) + "，实际 " + (ok ? AuditUtil.F(actual) : "<读不到>"));
                }
            }
            rb.Set("params", paramsJson);
            rb.Set("id_canonical", BuildCanonicalId(spec, actualVals));

            // 2) 期望可见部件集（请求级默认 ∪ 本状态）
            var vis = new JsonObject();
            var expectVisible = new List<string>(_expectVisibleDefault);
            expectVisible.AddRange(spec.ExpectVisible);
            var expectHidden = new List<string>(_expectHiddenDefault);
            expectHidden.AddRange(spec.ExpectHidden);
            bool visOk = CheckExpectations(snap, expectVisible, true, vis, failures);
            visOk = CheckExpectations(snap, expectHidden, false, vis, failures) && visOk;
            rb.Set("visibility", vis);
            rb.Set("ok", failures.Count == 0 && visOk);

            snap.Readback = rb;
            snap.ReadbackFailed = failures.Count > 0 || !visOk;
            snap.IdCanonical = BuildCanonicalId(spec, actualVals);
            if (snap.ReadbackFailed)
            {
                _readbackFailed = true;
                var msg = "状态 '" + spec.Id + "' 回读断言不一致：" + string.Join("；", failures.ToArray());
                _readbackFailures.Add(msg);
                snap.Warnings.Add(msg);
                _ctx.Warn(msg);
            }
        }

        /// <summary>
        /// 任务 BJ（B-补-19）/ BR 返工：实际读回值是否等于某个 VRCAvatarParameterDriver 的 Set 常量写值，
        /// 且该 Driver **所在状态的入转移条件是针对同一参数的钳位式不等式比较**（如 `BreastSize > 0.5`
        /// 的状态里 Driver Set `BreastSize = 0.5`）。命中才说明「参数被驱动器按钳位合法改写」。
        ///
        /// 只认 Set 且有 value 的写者（Add/Random/Copy 的读数不等于写值，不能这样判）。
        /// BR 收窄动机：旧实现「等于全图任一 Set 常量」时，Bool 参数只要有两个 Driver 分别 Set 0/1，
        /// 任何读回值都能找到「解释」，断言形同虚设（工程A APS_FixBody 这类）。Bool 的入转移是
        /// If/IfNot 相等判断，不是钳位，因此不再放行。
        /// </summary>
        private bool TryDriverOverride(string param, float actual, out string detail)
        {
            detail = null;
            List<DriverWriter> list;
            if (!_driverTargets.TryGetValue(param, out list)) return false;
            for (int i = 0; i < list.Count; i++)
            {
                var w = list[i];
                if (w == null || !w.HasValue) continue;
                if (!string.Equals(w.ChangeType, "Set", StringComparison.OrdinalIgnoreCase)) continue;
                if (!ReadbackMatch(w.Value, actual, _readbackEps)) continue;
                List<ClampCondition> conds;
                if (string.IsNullOrEmpty(w.State)
                    || !_stateEntryConds.TryGetValue(StateKey(w.Controller, w.Layer, w.StateMachine, w.State), out conds))
                    continue;
                for (int c = 0; c < conds.Count; c++)
                {
                    var cc = conds[c];
                    if (!IsClampCondition(cc.Param, cc.Mode, cc.Threshold, param, w.Value)) continue;
                    detail = "钳位条件 " + cc.Param + " " + cc.ModeSymbol + " " + AuditUtil.F(cc.Threshold)
                        + "，驱动器 Set " + AuditUtil.F(w.Value)
                        + "（" + w.Controller + "/" + w.Layer + "/" + w.State + "）";
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// 任务 BR：一条入转移条件是不是针对目标参数的「钳位式不等式」。
        /// 语义：状态在参数越过阈值时进入（Greater/Less），进入后 Driver 把它写回阈值那一侧。
        /// 名字与签名刻意只用基元类型，便于离线自检（tmp/br 的 BRSelfCheck.cs 反射调用）。
        /// </summary>
        internal static bool IsClampCondition(string condParam, string condMode, float condThreshold,
                                              string driverParam, float driverSetValue)
        {
            if (string.IsNullOrEmpty(condParam) || string.IsNullOrEmpty(driverParam)) return false;
            if (!string.Equals(condParam, driverParam, StringComparison.Ordinal)) return false;
            bool greater = string.Equals(condMode, "Greater", StringComparison.OrdinalIgnoreCase);
            bool less = string.Equals(condMode, "Less", StringComparison.OrdinalIgnoreCase);
            if (!greater && !less) return false;   // If/IfNot/Equals/NotEqual 是相等判断，不是钳位（排除 Bool 0/1）
            const float eps = 0.001f;
            // 方向必须与钳位一致：p>T 时驱动器把它压到 ≤T；p<T 时抬到 ≥T。
            return greater ? driverSetValue <= condThreshold + eps
                           : driverSetValue >= condThreshold - eps;
        }

        private bool CheckExpectations(AuditStateSnapshot snap, List<string> wants, bool wantVisible, JsonObject outJson, List<string> failures)
        {
            bool ok = true;
            for (int i = 0; i < wants.Count; i++)
            {
                string want = wants[i];
                var r = FindRendererSnap(snap, want);
                bool actualVisible = r != null && r.Visible;
                bool pass = r != null && actualVisible == wantVisible;
                var e = new JsonObject();
                e.Set("renderer", want);
                e.Set("matched", r == null ? null : r.Path);
                e.Set("want_visible", wantVisible);
                e.Set("actual_visible", r == null ? null : (object)actualVisible);
                e.Set("ok", pass);
                outJson.Set((wantVisible ? "visible:" : "hidden:") + want, e);
                if (!pass)
                {
                    ok = false;
                    failures.Add("期望" + (wantVisible ? "可见" : "不可见") + "的 '" + want + "' 实际是"
                        + (r == null ? "找不到渲染器" : (actualVisible ? "可见" : "不可见")));
                }
            }
            return ok;
        }

        private static AuditRendererSnap FindRendererSnap(AuditStateSnapshot snap, string spec)
        {
            if (string.IsNullOrEmpty(spec)) return null;
            AuditRendererSnap fuzzy = null, leafExact = null;
            int slash = spec.LastIndexOf('/');
            string leaf = slash >= 0 && slash + 1 < spec.Length ? spec.Substring(slash + 1) : spec;
            foreach (var kv in snap.Renderers)
            {
                var r = kv.Value;
                if (r == null) continue;
                if (string.Equals(kv.Key, spec, StringComparison.Ordinal)) return r;
                if (string.Equals(r.Path, spec, StringComparison.Ordinal)) return r;
                if (string.Equals(r.Path, leaf, StringComparison.Ordinal)) return r;
                // 2026-09-20：路径以「/<spec>」结尾且大小写一致的优先于模糊包含
                //（工程A：`Shoes` 模糊命中了先出现的 ANEMONE 的小写 `shoes`，假报 MMN 鞋不可见）
                if (leafExact == null && r.Path != null && r.Path.EndsWith("/" + spec, StringComparison.Ordinal)) leafExact = r;
                if (fuzzy == null && ContainsIgnoreCase(r.Path, spec)) fuzzy = r;
            }
            if (leafExact != null) return leafExact;
            return fuzzy;
        }

        /// <summary>档位槽号：轮盘第 i 档的代表值是 i/n，用最近格算槽号（0.2857 距 2/7 比 1/7 近 → 第 2 档）。</summary>
        public static int SlotOf(float value, int n)
        {
            if (n <= 1) return 0;
            int slot = (int)Math.Round(value * (double)n);
            if (slot < 0) slot = 0;
            if (slot > n - 1) slot = n - 1;
            return slot;
        }

        /// <summary>状态 id 的规范元组：按参数名排序，用实际值；轮盘写成 参数@槽/档，其余写 参数=值。</summary>
        private string BuildCanonicalId(AuditStateSpec spec, Dictionary<string, float> values)
        {
            var sorted = new List<KeyValuePair<string, float>>();
            foreach (var kv in spec.Params)
            {
                float v;
                if (!values.TryGetValue(kv.Key, out v)) v = kv.Value;
                sorted.Add(new KeyValuePair<string, float>(kv.Key, v));
            }
            sorted.Sort(delegate (KeyValuePair<string, float> a, KeyValuePair<string, float> b)
            {
                return string.CompareOrdinal(a.Key, b.Key);
            });
            return CanonicalTuple(sorted, _gearSlots);
        }

        /// <summary>纯逻辑：把 (参数名, 实际值) 列表 + 档位表拼成规范元组。供离线自检直接调用。</summary>
        public static string CanonicalTuple(List<KeyValuePair<string, float>> sortedParams, Dictionary<string, int> gearSlots)
        {
            if (sortedParams == null || sortedParams.Count == 0) return "(empty)";
            var parts = new List<string>();
            for (int i = 0; i < sortedParams.Count; i++)
            {
                var kv = sortedParams[i];
                int n;
                if (gearSlots != null && gearSlots.TryGetValue(kv.Key, out n) && n > 0)
                    parts.Add(kv.Key + "@" + SlotOf(kv.Value, n) + "/" + n);
                else
                    parts.Add(kv.Key + "=" + AuditUtil.F(kv.Value));
            }
            return string.Join("|", parts.ToArray());
        }

        /// <summary>纯逻辑：请求值 vs 实际值的回读一致性判据（容差内）。</summary>
        public static bool ReadbackMatch(float requested, float actual, float eps)
        {
            return Math.Abs(requested - actual) <= Math.Abs(eps);
        }

        /// <summary>
        /// 第一个状态上跑一次哨兵：正样本注入已知缺陷（形态键 / 材质队列）并读回，负样本隐藏被测件并读 V1/V2。
        /// 任一不过（含配置错误）→ 整批 aborted。执行后立即还原，不留痕。
        /// </summary>
        private void RunSentinels(AuditStateSpec spec, AuditStateSnapshot snap)
        {
            var res = new JsonObject();
            res.Set("evaluated_on_state", spec.Id);
            bool anyFail = _sentinelFailed;   // 解析期的配置错误已记

            var posArr = new List<object>();
            for (int i = 0; i < _sentinelPositive.Count; i++)
            {
                var r = RunPositiveSentinel(_sentinelPositive[i], snap);
                posArr.Add(r);
                if (!AuditJson.Bool(r, "pass", false))
                {
                    anyFail = true;
                    _sentinelFailures.Add("positive[" + i + "]：" + AuditJson.Str(r, "reason", "未通过"));
                }
            }
            var negArr = new List<object>();
            for (int i = 0; i < _sentinelNegative.Count; i++)
            {
                var r = RunNegativeSentinel(_sentinelNegative[i], snap);
                negArr.Add(r);
                if (!AuditJson.Bool(r, "pass", false))
                {
                    anyFail = true;
                    _sentinelFailures.Add("negative[" + i + "]：" + AuditJson.Str(r, "reason", "未通过"));
                }
            }
            res.Set("positive", posArr);
            res.Set("negative", negArr);
            res.Set("config_errors", _sentinelFailures.Cast<object>().ToList());
            res.Set("any_failed", anyFail);
            _sentinelResults = res;
            _sentinelFailed = anyFail;
            if (anyFail) _ctx.Warn("T-13 哨兵未过：整批将标 aborted（明细见 states.json.sentinel_results）。");
            else _ctx.Status.Log("T-13 哨兵全过：正 " + _sentinelPositive.Count + " / 负 " + _sentinelNegative.Count);
        }

        private JsonObject RunPositiveSentinel(SentinelSpec s, AuditStateSnapshot snap)
        {
            var o = new JsonObject();
            o.Set("kind", "positive");
            o.Set("request", s.Raw);

            if (!string.IsNullOrEmpty(s.Shape))
            {
                var smrs = _avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
                Array.Sort(smrs, delegate (SkinnedMeshRenderer a, SkinnedMeshRenderer b)
                {
                    string pa = a == null ? "" : AuditUtil.RelPath(_avatar.transform, a.transform);
                    string pb = b == null ? "" : AuditUtil.RelPath(_avatar.transform, b.transform);
                    return string.CompareOrdinal(pa, pb);
                });
                var smr = FindPreProbeSmr(smrs, s.Renderer);
                if (smr == null || smr.sharedMesh == null)
                {
                    o.Set("pass", false);
                    o.Set("reason", "找不到渲染器 '" + s.Renderer + "' 或网格为空");
                    return o;
                }
                var idxs = MatchShapeIndices(smr.sharedMesh, s.Shape);
                if (idxs.Count == 0)
                {
                    o.Set("pass", false);
                    o.Set("reason", "渲染器 '" + smr.gameObject.name + "' 上找不到形态键 '" + s.Shape + "'（含 AAO 改名匹配）");
                    return o;
                }
                var restores = new List<ShapeRestore>();
                try
                {
                    for (int k = 0; k < idxs.Count; k++)
                    {
                        int idx = idxs[k];
                        float old = smr.GetBlendShapeWeight(idx);
                        restores.Add(new ShapeRestore { Smr = smr, Index = idx, OldWeight = old });
                        smr.SetBlendShapeWeight(idx, s.Weight);
                    }
                    float observed = smr.GetBlendShapeWeight(idxs[0]);
                    bool pass = Math.Abs(observed - s.Weight) <= _readbackEps;
                    o.Set("renderer", AuditUtil.RelPath(_avatar.transform, smr.transform));
                    o.Set("shape", smr.sharedMesh.GetBlendShapeName(idxs[0]));
                    o.Set("matched_indices", idxs.Cast<object>().ToList());
                    o.Set("expected_weight", (double)s.Weight);
                    o.Set("observed_weight", (double)observed);
                    o.Set("pass", pass);
                    if (!pass) o.Set("reason", "perturb 后读回权重 " + AuditUtil.F(observed) + " ≠ 请求 " + AuditUtil.F(s.Weight));
                    return o;
                }
                finally
                {
                    for (int i = restores.Count - 1; i >= 0; i--)
                        try { restores[i].Smr.SetBlendShapeWeight(restores[i].Index, restores[i].OldWeight); } catch { }
                }
            }

            // 备选：改材质 renderQueue（用实例副本，不改共享资产）
            var rend = FindRendererAny(s.Renderer);
            if (rend == null)
            {
                o.Set("pass", false);
                o.Set("reason", "找不到渲染器 '" + s.Renderer + "'");
                return o;
            }
            var saved = rend.sharedMaterials;
            Material[] inst = null;
            try
            {
                inst = rend.materials;
                var oldQ = new int[inst.Length];
                for (int i = 0; i < inst.Length; i++)
                {
                    if (inst[i] == null) continue;
                    oldQ[i] = inst[i].renderQueue;
                    inst[i].renderQueue = (int)Math.Round(s.Queue);
                }
                int observedQ = inst.Length > 0 && inst[0] != null ? inst[0].renderQueue : 0;
                bool pass = inst.Length > 0 && inst[0] != null && observedQ == (int)Math.Round(s.Queue);
                o.Set("renderer", AuditUtil.RelPath(_avatar.transform, rend.transform));
                o.Set("slot", 0);
                o.Set("expected_render_queue", (double)Math.Round(s.Queue));
                o.Set("observed_render_queue", observedQ);
                o.Set("pass", pass);
                if (!pass) o.Set("reason", "改 renderQueue 后读回 " + observedQ + " ≠ 请求 " + (int)Math.Round(s.Queue));
                for (int i = 0; i < inst.Length; i++) if (inst[i] != null) inst[i].renderQueue = oldQ[i];
                return o;
            }
            catch (Exception e)
            {
                o.Set("pass", false);
                o.Set("reason", "renderQueue 注入失败：" + e.Message);
                return o;
            }
            finally
            {
                if (inst != null)
                {
                    try { rend.sharedMaterials = saved; } catch { }
                    for (int i = 0; i < inst.Length; i++) if (inst[i] != null) UnityEngine.Object.DestroyImmediate(inst[i]);
                }
            }
        }

        private JsonObject RunNegativeSentinel(SentinelSpec s, AuditStateSnapshot snap)
        {
            var o = new JsonObject();
            o.Set("kind", "negative");
            o.Set("request", s.Raw);
            var rends = FindRenderersAny(s.Renderer);
            if (rends.Count == 0)
            {
                o.Set("pass", false);
                o.Set("reason", "找不到渲染器 '" + s.Renderer + "'");
                return o;
            }
            var savedActive = new bool[rends.Count];
            var savedEnabled = new bool[rends.Count];
            try
            {
                bool allHidden = true;
                var details = new List<object>();
                for (int i = 0; i < rends.Count; i++)
                {
                    var r = rends[i];
                    savedActive[i] = r.gameObject.activeSelf;
                    savedEnabled[i] = r.enabled;
                    r.enabled = false;
                    r.gameObject.SetActive(false);
                    bool visible = r.gameObject.activeInHierarchy && r.enabled;
                    if (visible) allHidden = false;
                    var d = new JsonObject();
                    d.Set("renderer", AuditUtil.RelPath(_avatar.transform, r.transform));
                    d.Set("visible_after_hide", visible);
                    details.Add(d);
                }
                o.Set("renderers", details);
                o.Set("pass", allHidden);
                if (!allHidden) o.Set("reason", "hide 后仍报 visible=true");
                return o;
            }
            finally
            {
                for (int i = rends.Count - 1; i >= 0; i--)
                {
                    try
                    {
                        rends[i].gameObject.SetActive(savedActive[i]);
                        rends[i].enabled = savedEnabled[i];
                    }
                    catch { }
                }
            }
        }

        private Renderer FindRendererAny(string spec)
        {
            var list = FindRenderersAny(spec);
            return list.Count > 0 ? list[0] : null;
        }

        /// <summary>渲染器匹配：精确路径 / 精确 GameObject 名 / 精确叶子名，其次路径子串（不区分大小写）。</summary>
        private List<Renderer> FindRenderersAny(string spec)
        {
            var res = new List<Renderer>();
            var fuzzy = new List<Renderer>();
            int slash = spec.LastIndexOf('/');
            string leaf = slash >= 0 && slash + 1 < spec.Length ? spec.Substring(slash + 1) : spec;
            var rends = _avatar.GetComponentsInChildren<Renderer>(true);
            Array.Sort(rends, delegate (Renderer a, Renderer b)
            {
                string pa = a == null ? "" : AuditUtil.RelPath(_avatar.transform, a.transform);
                string pb = b == null ? "" : AuditUtil.RelPath(_avatar.transform, b.transform);
                return string.CompareOrdinal(pa, pb);
            });
            for (int i = 0; i < rends.Length; i++)
            {
                var r = rends[i];
                if (r == null) continue;
                string path = AuditUtil.RelPath(_avatar.transform, r.transform);
                string name = r.gameObject.name;
                if (string.Equals(path, spec, StringComparison.Ordinal)
                    || string.Equals(name, spec, StringComparison.Ordinal)
                    || string.Equals(name, leaf, StringComparison.Ordinal)) res.Add(r);
                else if (ContainsIgnoreCase(path, spec)) fuzzy.Add(r);
            }
            if (res.Count == 0) res.AddRange(fuzzy);
            return res;
        }

        private Transform ResolveBone(string name)
        {
            HumanBodyBones hb;
            bool ok;
            try { ok = Enum.TryParse<HumanBodyBones>(name, true, out hb); }
            catch { ok = false; hb = HumanBodyBones.Hips; }
            if (!ok) return null;
            return _anim.GetBoneTransform(hb);
        }

        private static string UniqueKey(IEnumerable<string> existing, string baseKey)
        {
            var set = existing as HashSet<string>;
            if (set == null) set = new HashSet<string>(existing, StringComparer.Ordinal);
            if (!set.Contains(baseKey)) return baseKey;
            int i = 2;
            while (set.Contains(baseKey + "#" + i)) i++;
            return baseKey + "#" + i;
        }

        private string ComputeDriver(AuditStateSpec spec)
        {
            if (!_gmControlled) return "animator";
            if (spec.Params.Count == 0) return "gesture_manager";
            foreach (var k in spec.Params.Keys)
            {
                string s;
                if (_curSources.TryGetValue(k, out s) && s == "gesture_manager") return "gesture_manager";
            }
            return "animator"; // GM 接管了但没有一个参数走通 GM 通道，等价于退回 Animator
        }

        // ------------------------------------------------------------------ 汇总

        private void FinishAll()
        {
            string defaultId = _states[0].Id;
            foreach (var s in _states) if (s.Id == "default") { defaultId = s.Id; break; }

            var pass0 = _passSnaps[0];
            AuditStateSnapshot defaultSnap;
            pass0.TryGetValue(defaultId, out defaultSnap);

            var statesJson = new JsonObject();
            statesJson.Set("tool", "state");
            statesJson.Set("avatar", _avatar.name);
            statesJson.Set("out", _ctx.OutDir);
            statesJson.Set("gm_controlled", _gmControlled);
            statesJson.Set("gm_note", _gmNote);
            statesJson.Set("gm_created_by_audit", _gmCreatedByAudit);
            statesJson.Set("driver", _gmControlled ? "gesture_manager" : "animator");
            statesJson.Set("settle_frames", _settleFrames);
            statesJson.Set("blendshape_epsilon", (double)_blendEps);
            statesJson.Set("default_state", defaultId);
            statesJson.Set("param_count", _paramNames.Count);
            statesJson.Set("reset_param_count", _resetNames.Count);
            statesJson.Set("reset_mode", _resetMode);
            statesJson.Set("reset_values_source", _resetPrimarySource);
            statesJson.Set("reset_fallback_params", _resetFallbackParams.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList());

            // 任务 AD：驱动器目标与复位排除。driver_targets = 参数名 → 写它的位置列表；
            // reset_excluded_driver_targets = 因被驱动（且用户不能直接点）而从复位集合里排除的参数；
            // driver_targets_user_clickable = 用户也能直接点、因此仍复位但被标记的被驱动参数。
            statesJson.Set("reset_driver_targets", _resetDriverTargets);
            statesJson.Set("reset_excluded_driver_targets", _resetExcludedDriverTargets.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList());
            statesJson.Set("driver_targets_user_clickable", _driverTargetsUserClickable.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList());
            var driverJson = new JsonObject();
            foreach (var n in _driverTargetOrder.OrderBy(x => x, StringComparer.Ordinal))
            {
                var arr = new List<object>();
                foreach (var w in _driverTargets[n])
                {
                    var wo = new JsonObject();
                    wo.Set("controller", w.Controller);
                    wo.Set("layer", w.Layer);
                    wo.Set("layer_type", w.LayerType);
                    wo.Set("state_machine", w.StateMachine);
                    wo.Set("state", w.State);
                    wo.Set("change_type", w.ChangeType);
                    if (!string.IsNullOrEmpty(w.Source)) wo.Set("source", w.Source);
                    arr.Add(wo);
                }
                driverJson.Set(n, arr);
            }
            statesJson.Set("driver_targets", driverJson);
            var driverScanJson = new JsonObject();
            driverScanJson.Set("controllers", _driverControllersScanned.Cast<object>().ToList());
            driverScanJson.Set("states_scanned", _driverStatesScanned);
            driverScanJson.Set("warnings", _driverScanWarnings.Cast<object>().ToList());
            statesJson.Set("driver_targets_scan", driverScanJson);

            statesJson.Set("volatile_probe", _volatileProbe);
            statesJson.Set("state_files", _stateFileNames.Cast<object>().ToList());

            // 任务 R：探针汇总。probes_requested 是本批实际执行的探针；probe_hits 是「状态 → 命中数」；
            // probe_hit_totals 是本批合计（第一遍，与 diffs 同口径）。未请求探针时三项为空。
            statesJson.Set("probes_requested", _probeRequests.Cast<object>().ToList());
            var probeHitsJson = new JsonObject();
            var probeTotalsJson = new JsonObject();
            for (int pi = 0; pi < _probeRequests.Count; pi++)
            {
                string probeName = _probeRequests[pi];
                var perState = new JsonObject();
                int totalHits = 0;
                for (int si = 0; si < _states.Count; si++)
                {
                    AuditStateSnapshot s;
                    if (!pass0.TryGetValue(_states[si].Id, out s) || s == null) continue;
                    int h;
                    if (s.ProbeHits.TryGetValue(probeName, out h)) { perState.Set(_states[si].Id, h); totalHits += h; }
                }
                probeHitsJson.Set(probeName, perState);
                probeTotalsJson.Set(probeName, totalHits);
            }
            statesJson.Set("probe_hits", probeHitsJson);
            statesJson.Set("probe_hit_totals", probeTotalsJson);

            var ids = new List<object>();
            foreach (var s in _states) ids.Add(s.Id);
            statesJson.Set("states", ids);

            var stArr = new List<object>();
            foreach (var s in _states)
            {
                var so = new JsonObject();
                so.Set("id", s.Id);
                so.Set("pose", s.Pose);
                var po = new JsonObject();
                foreach (var kv in s.Params) po.Set(kv.Key, (double)kv.Value);
                so.Set("params", po);
                so.Set("history", s.History.Cast<object>().ToList());
                if (s.ExpectVisible.Count > 0) so.Set("expect_visible", s.ExpectVisible.Cast<object>().ToList());
                if (s.ExpectHidden.Count > 0) so.Set("expect_hidden", s.ExpectHidden.Cast<object>().ToList());
                stArr.Add(so);
            }
            statesJson.Set("state_specs", stArr);

            // T-13：状态 id → 实际值规范元组（轮盘按槽号）。
            var canonJson = new JsonObject();
            foreach (var spec in _states)
            {
                AuditStateSnapshot s0;
                if (pass0.TryGetValue(spec.Id, out s0) && s0 != null && !string.IsNullOrEmpty(s0.IdCanonical))
                    canonJson.Set(spec.Id, s0.IdCanonical);
            }
            statesJson.Set("state_canonicals", canonJson);

            var defaultsJson = new JsonObject();
            foreach (var n in _paramNames)
            {
                var o = new JsonObject();
                o.Set("value", (double)(_defaults.ContainsKey(n) ? _defaults[n] : 0f));
                o.Set("source", _defaultSource.ContainsKey(n) ? _defaultSource[n] : "unknown");
                o.Set("initial_at_start", (double)(_initialValues.ContainsKey(n) ? _initialValues[n] : 0f));
                o.Set("reset", _resetNames.Contains(n));                          // 用户可控 → 每状态复位
                o.Set("builtin", BuiltinParams.Contains(n));                      // VRChat 内置参数
                o.Set("declared_in_expression", _declaredExpr.Contains(n));       // 表达参数里声明过
                o.Set("driver_target", _driverTargets.ContainsKey(n));            // 被 VRCAvatarParameterDriver 写入（任务 AD）
                o.Set("reset_excluded_driver_target", _resetExcludedDriverTargets.Contains(n)); // 因被驱动而排除复位（任务 AD）
                defaultsJson.Set(n, o);
            }
            statesJson.Set("param_defaults", defaultsJson);

            // 任务 Q：顶层默认值快照 = 参数名 → 本批复位值（只含可复位集合），便于事后核对
            // 「这批到底是从声明默认还是启动实值复位的」，以及跨 Play 会话是否用了同一套默认。
            var defaultsSnapshot = new JsonObject();
            foreach (var n in _resetNames.OrderBy(x => x, StringComparer.Ordinal))
            {
                if (_resetValues.ContainsKey(n)) defaultsSnapshot.Set(n, (double)_resetValues[n]);
            }
            statesJson.Set("defaults_snapshot", defaultsSnapshot);

            // 易变形态键：第一个状态两次快照不同的键，diff / 确定性比对里已排除，这里留档。
            var volArr = new List<object>();
            for (int i = 0; i < _volatileOrder.Count; i++)
            {
                var v = _volatileShapes[_volatileOrder[i]];
                var o = new JsonObject();
                o.Set("path", v.Path);
                o.Set("shape", v.Shape);
                o.Set("first", (double)v.First);
                o.Set("second", (double)v.Second);
                volArr.Add(o);
            }
            statesJson.Set("volatile_blendshapes", volArr);

            var noEffect = new List<object>();
            var missing = new List<object>();
            var equalDefault = new List<object>();
            var diffsJson = new JsonObject();
            var sourcesJson = new JsonObject();

            foreach (var spec in _states)
            {
                AuditStateSnapshot snap = null;
                pass0.TryGetValue(spec.Id, out snap);
                if (snap == null) continue;

                var so = new JsonObject();
                foreach (var kv in snap.ParamSources) so.Set(kv.Key, kv.Value);
                sourcesJson.Set(spec.Id, so);

                if (defaultSnap != null && spec.Id != defaultId)
                {
                    var diff = Diff(defaultSnap, snap);
                    diffsJson.Set(spec.Id, diff.ToJson());

                    if (!diff.AnyChange)
                    {
                        // 整个状态对渲染结果零影响 → 这个状态设的参数都算「设了没反应」
                        foreach (var k in spec.Params.Keys)
                            noEffect.Add(Entry(spec.Id, k, "整个状态与 default 相比无渲染器显隐/材质/形态键变化"));
                    }
                }

                foreach (var k in spec.Params.Keys)
                {
                    float def;
                    if (_defaults.TryGetValue(k, out def) && Math.Abs(def - spec.Params[k]) < 1e-6f)
                        equalDefault.Add(Entry(spec.Id, k, "施加值等于默认值，天然不会产生变化"));
                }

                for (int i = 0; i < snap.MissingParams.Count; i++)
                {
                    var p = snap.MissingParams[i];
                    missing.Add(Entry(spec.Id, p, "GM.Params 与 Animator.parameters 里都没有这个参数"));
                    noEffect.Add(Entry(spec.Id, p, "参数不存在"));
                }
            }

            statesJson.Set("diffs", diffsJson);
            statesJson.Set("param_sources", sourcesJson);
            statesJson.Set("no_effect_params", noEffect);
            statesJson.Set("params_missing", missing);
            statesJson.Set("params_equal_default", equalDefault);

            if (_passCount > 1)
            {
                var det = new JsonObject();
                foreach (var spec in _states)
                {
                    AuditStateSnapshot a, b;
                    _passSnaps[0].TryGetValue(spec.Id, out a);
                    _passSnaps[1].TryGetValue(spec.Id, out b);
                    var o = new JsonObject();
                    if (a == null || b == null)
                    {
                        o.Set("identical", false);
                        o.Set("first_difference", "有一遍没有拿到快照");
                    }
                    else
                    {
                        var ex = _volatileProbe ? VolatileKeySet() : null;
                        var ja = AuditJson.Serialize(a.ToJson(ex));
                        var jb = AuditJson.Serialize(b.ToJson(ex));
                        o.Set("identical", ja == jb);
                        o.Set("first_difference", ja == jb ? null : FirstDiffLine(ja, jb));
                    }
                    det.Set(spec.Id, o);
                }
                statesJson.Set("determinism", det);
            }

            // ---- T-13：版本戳 / 哨兵 / 回读 / 序列 ----
            statesJson.Set("tool_version", _toolVersion);
            statesJson.Set("version_check", _versionCheck);
            statesJson.Set("sequence", _sequence);
            var gearJson = new JsonObject();
            foreach (var n in _gearSlots.Keys.OrderBy(x => x, StringComparer.Ordinal))
            {
                var g = new JsonObject();
                g.Set("n", _gearSlots[n]);
                g.Set("source", _gearSource.ContainsKey(n) ? _gearSource[n] : "unknown");
                gearJson.Set(n, g);
            }
            statesJson.Set("gear_slots", gearJson);
            statesJson.Set("readback_eps", (double)_readbackEps);
            statesJson.Set("readback_failed", _readbackFailed);
            statesJson.Set("readback_failures", _readbackFailures.Cast<object>().ToList());
            statesJson.Set("readback_overrides", _readbackOverrides.Cast<object>().ToList());
            statesJson.Set("readback_override_count", _readbackOverrides.Count);
            statesJson.Set("sentinel_results", _sentinelResults);
            statesJson.Set("sentinel_failed", _sentinelFailed);

            string abortReason = null;
            if (_sentinelFailed)
                abortReason = "哨兵未过（" + _sentinelFailures.Count + " 处；明细见 sentinel_results）";
            if (_readbackFailed)
                abortReason = (abortReason == null ? "" : abortReason + "；") + "状态回读断言不一致 " + _readbackFailures.Count + " 处";
            if (abortReason != null) _ctx.Abort(abortReason);
            statesJson.Set("aborted", abortReason != null);
            statesJson.Set("abort_reason", abortReason);

            statesJson.Set("sanity_failed", _sanityFailed);
            statesJson.Set("sanity_failures", _sanityFailures.Cast<object>().ToList());
            statesJson.Set("warnings", _ctx.Warnings.Cast<object>().ToList());
            AuditJson.WriteFile(_ctx.OutPath("states.json"), statesJson);
            _ctx.Status.Log("T1 完成，已写 states.json 与 " + _stateFileNames.Count + " 个 state_*.json");
            // 任务 BJ（B-T08a）：R9 候选排序表（每个 part 一份）。失败不拖垮 T1，只记 warning。
            try { WriteCandidateTables(); }
            catch (Exception e) { _ctx.Warn("R9 候选排序表写出失败（states.json 已保留）：" + AuditUtil.Unwrap(e).Message); }
        }

        private static JsonObject Entry(string state, string param, string reason)
        {
            var o = new JsonObject();
            o.Set("state", state);
            o.Set("param", param);
            o.Set("reason", reason);
            return o;
        }

        private static string FirstDiffLine(string a, string b)
        {
            var la = a.Split('\n');
            var lb = b.Split('\n');
            int n = Mathf.Min(la.Length, lb.Length);
            for (int i = 0; i < n; i++)
                if (!string.Equals(la[i], lb[i], StringComparison.Ordinal))
                    return "第 " + (i + 1) + " 行: 第一遍=" + la[i].Trim() + " / 第二遍=" + lb[i].Trim();
            return "行数不同：第一遍 " + la.Length + " 行 / 第二遍 " + lb.Length + " 行";
        }

        private sealed class DiffResult
        {
            public readonly List<JsonObject> Visibility = new List<JsonObject>();
            public readonly List<JsonObject> Enabled = new List<JsonObject>();
            public readonly List<JsonObject> Material = new List<JsonObject>();
            public readonly List<JsonObject> Blendshape = new List<JsonObject>();
            public readonly List<JsonObject> Bone = new List<JsonObject>();
            public bool AnyChange { get { return Visibility.Count > 0 || Enabled.Count > 0 || Material.Count > 0 || Blendshape.Count > 0; } }

            public JsonObject ToJson()
            {
                var o = new JsonObject();
                o.Set("renderer_visibility_changed", Visibility.Cast<object>().ToList());
                o.Set("renderer_enabled_changed", Enabled.Cast<object>().ToList());
                o.Set("material_changed", Material.Cast<object>().ToList());
                o.Set("blendshape_changed", Blendshape.Cast<object>().ToList());
                o.Set("bone_changed", Bone.Cast<object>().ToList());
                o.Set("any_change", AnyChange);
                return o;
            }
        }

        /// <summary>与 default 比差异。判据：显隐看 Visible，材质看 (名字, shader, renderQueue)，形态键看权重差 &gt; epsilon。</summary>
        private DiffResult Diff(AuditStateSnapshot def, AuditStateSnapshot cur)
        {
            var d = new DiffResult();

            var rkeys = new HashSet<string>(def.Renderers.Keys);
            foreach (var k in cur.Renderers.Keys) rkeys.Add(k);
            foreach (var k in rkeys.OrderBy(x => x, StringComparer.Ordinal))
            {
                AuditRendererSnap a, b;
                def.Renderers.TryGetValue(k, out a);
                cur.Renderers.TryGetValue(k, out b);
                if (a == null || b == null) continue;

                if (a.Visible != b.Visible)
                {
                    var o = new JsonObject();
                    o.Set("path", b.Path);
                    o.Set("from", a.Visible);
                    o.Set("to", b.Visible);
                    o.Set("detail", "activeInHierarchy " + a.ActiveInHierarchy + "→" + b.ActiveInHierarchy + "，enabled " + a.Enabled + "→" + b.Enabled);
                    d.Visibility.Add(o);
                }
                else if (a.Enabled != b.Enabled)
                {
                    var o = new JsonObject();
                    o.Set("path", b.Path);
                    o.Set("from", a.Enabled);
                    o.Set("to", b.Enabled);
                    d.Enabled.Add(o);
                }

                int mc = Mathf.Min(a.Materials.Count, b.Materials.Count);
                for (int i = 0; i < mc; i++)
                {
                    var ma = a.Materials[i];
                    var mb = b.Materials[i];
                    if (ma.Name == mb.Name && ma.Shader == mb.Shader && ma.Queue == mb.Queue) continue;
                    var o = new JsonObject();
                    o.Set("path", b.Path);
                    o.Set("slot", i);
                    o.Set("from_name", ma.Name);
                    o.Set("to_name", mb.Name);
                    o.Set("from_shader", ma.Shader);
                    o.Set("to_shader", mb.Shader);
                    o.Set("from_queue", ma.Queue);
                    o.Set("to_queue", mb.Queue);
                    d.Material.Add(o);
                }
            }

            var skeys = new HashSet<string>(def.Blendshapes.Keys);
            foreach (var k in cur.Blendshapes.Keys) skeys.Add(k);
            foreach (var key in skeys.OrderBy(x => x, StringComparer.Ordinal))
            {
                Dictionary<string, float> sa, sb;
                def.Blendshapes.TryGetValue(key, out sa);
                cur.Blendshapes.TryGetValue(key, out sb);
                if (sa == null) sa = new Dictionary<string, float>();
                if (sb == null) sb = new Dictionary<string, float>();

                var names = new HashSet<string>(sa.Keys);
                foreach (var n in sb.Keys) names.Add(n);
                foreach (var n in names.OrderBy(x => x, StringComparer.Ordinal))
                {
                    // 易变形态键（随时间自动播放）不参与状态间 diff。
                    if (_volatileProbe && _volatileShapes.ContainsKey(VolKey(key, n))) continue;
                    float va = sa.ContainsKey(n) ? sa[n] : 0f;
                    float vb = sb.ContainsKey(n) ? sb[n] : 0f;
                    if (Mathf.Abs(va - vb) <= _blendEps) continue;
                    var o = new JsonObject();
                    o.Set("path", key);
                    o.Set("shape", n);
                    o.Set("from", (double)va);
                    o.Set("to", (double)vb);
                    d.Blendshape.Add(o);
                }
            }

            const float boneTol = 1e-4f; // 0.1 mm：低于这个量级的位移在视觉审查里没有意义
            foreach (var bone in def.Bones.Keys)
            {
                if (!cur.Bones.ContainsKey(bone)) continue;
                var a = def.Bones[bone];
                var b = cur.Bones[bone];
                float dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
                float dist = Mathf.Sqrt(dx * dx + dy * dy + dz * dz);
                if (dist <= boneTol) continue;
                var o = new JsonObject();
                o.Set("bone", bone);
                o.Set("from", new List<object> { (double)a[0], (double)a[1], (double)a[2] });
                o.Set("to", new List<object> { (double)b[0], (double)b[1], (double)b[2] });
                o.Set("delta_m", (double)dist);
                d.Bone.Add(o);
            }

            return d;
        }

        // ------------------------------------------------------------------ Cleanup

        public void Cleanup()
        {
            // 任务 U：兜底还原探针前临时改过的形态键（正常路径 RunProbes 的 finally 已还原，这里防异常中断）。
            RestorePreProbeShapes();

            // 只恢复审查期间对 GM 设置的临时改动。参数保持在最后一个状态（T3 环绕渲图要在同一批状态下拍）。
            if (_gmControlled && _gmCullingWasOn)
            {
                if (GmgBridge.TrySetSimulateCulling(_module, true) && _ctx != null)
                    _ctx.Status.Log("已恢复 GM simulateCulling=true");
                _gmCullingWasOn = false;
            }

            // 场景里原本没有 GM 时，Begin 在 Play 模式临时建了 __AvatarAudit_GM 接管（AuditIO.GmgBridge.CreateAuditManager）。
            // 只销毁我们自己建的那个（DestroyAuditManager 内部按 _auditCreatedGo 判断，幂等）；场景里原有的组件不动。
            if (GmgBridge.DestroyAuditManager() && _ctx != null)
                _ctx.Status.Log("已销毁审查临时创建的 GestureManager（__AvatarAudit_GM）");
        }
    }
}
