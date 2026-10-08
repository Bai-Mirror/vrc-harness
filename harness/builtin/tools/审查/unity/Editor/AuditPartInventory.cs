// ══════════════════════════════════════════════════════════════════
// 【项目沉淀】通用工具 · 客户单审查 T-05「部件盘点导出」
// 适用素体：任意装了 VRChat SDK3 的头像（Unity 2022.3 / VRChat 3.x）
// 相关素材：无
// 工具链　：Unity 2022.3.22f1 Editor 程序集；只用 UnityEngine / UnityEditor /
// 　　　　　Unity.Collections；VRChat SDK 与 Modular Avatar 类型**全部走反射**，
// 　　　　　不直接 using / 不引用 VRCSDK3A.dll、MA 程序集（理由见下）。
// 可复用性：★★★ 换单子直接复制到 <工程>/Assets/AvatarAudit/Editor/
//
// 用途：编辑模式一次性把「这个头像由哪些部件组成、每件长什么样、怎么被切换」
//   盘成机器可读的 `_感知/out/inventory.json`，给 T-04 草案生成器当输入：
//     · 路径 / 渲染器类型 / 材质槽 / 顶点数 / activeSelf+enabled
//     · 按 HumanBodyBones 部位的蒙皮权重占比 + 顶点占比（→ covers，T2 §4.6）
//     · 网格边界边占比（闭合度，closed 布尔）
//     · 鞋底厚度启发（身体脚底到该件最低点的高差，≥4 mm → shoe_like）
//     · 切换方式：扫头像各动画层 + MA MergeAnimator 的 clip，判断该渲染器路径
//       被 `m_Enabled` 还是 `m_IsActive` 驱动；另报 MA ObjectToggle / MenuItem 控制
//     · 同名键跟随（key_follow）：身体被写的形态键 × 件的同名键 ∩ 件上有没有写者，
//       只列候选不判对错（胸型跟随缺陷：件带着身体同名键却没人驱动）
//     · 身体全量形态键 `body_keys`：身体网格 `blendShapeCount` 个键名，顺序同网格
//       （给 `perception/profile_keys.py` 写进素体档案 `all_keys:` 用）
//
// 任务 AQ 补收（2026-09-19）：除 SkinnedMeshRenderer 外**另收 MeshRenderer**（PixelBoot
//   抓屏窗口、目元饰品这类没有蒙皮权重的件），ParticleSystemRenderer 只计数不展开。
//     · 渲染器条目按 `type` 区分；MR 的字段与 SMR 尽量一致（path/material_slots/switch/
//       covers…）。MR 没有骨骼权重，`covers` 用 MeshFilter 网格顶点对**最近骨骼**近似，
//       `region_source` 标 `nearest_bone`（有顶点）或 `nearest_bone_object`（网格不可读、
//       只能拿物体位置近似）；两者都不是蒙皮权重。
//     · `part_like` 布尔：名字或任一祖先名含 `PartLikeExcludeTokens`（工具/预览/调试物，
//       列表可配置、见 审查/docs/part-inventory.md T-05 §11.1）→ false；否则 true。SMR 与 MR 都有这个字段。
//     · 计数拆成 `smr_count` / `mr_count` / `psr_count`（根与每个头像各一份），旧的
//       `renderer_count` 保留，值 = `smr_count + mr_count`（= `renderers` 数组长度，
//       与旧口径「renderer_count == len(renderers)」一致；PSR 只计数不展开）。
//
// ── 与 AuditIO.cs 的接口 ─────────────────────────────────────────────
// 本文件**不实现** IAuditTool：它是一个独立的编辑模式菜单动作（同步跑完即写盘），
// 因为盘点不需要 Play、不需要 T1 状态机泵。可复用的公共层：
//   · AuditJson.WriteFile / JsonObject           —— JSON 序列化（键序稳定）
//   · AuditStatus(outDir, toolId) Running/Done/Error —— status.json 状态写法
//   · AuditRunner.ProjectRoot                    —— <工程>/ 绝对路径
//   · AuditUtil.RelPath / ScenePath / Unwrap     —— 路径与异常
//   · GmgBridge.FindType                         —— 反射找 VRCAvatarDescriptor 类型
// 菜单入口：Tools/AvatarAudit/Export Part Inventory（priority 110，排在 T1 的 100/101 后）
// 输出：<AuditRunner.ProjectRoot>/_感知/out/inventory.json（目录不存在自动建）；
//       进度写同目录 status.json（沿用其它工具的写法）。
//
// 为什么只用反射拿 SDK/MA 类型：
//   这工具要复制进 7 个不同工程做审查，工程之间 SDK / MA 版本可能不同。直接引用会让
//   「某个工程没装 MA」变成编译失败；反射失败只是降级（少一列），文件照写、警告照记。
//   而且离线验收用 `_长程任务_20260918/派工/tmp/compile_audit_V.sh` 的 Mono csc 编译，
//   它只引用 UnityEngine + UnityEditor，**引用 MA/AAO/NDMF 的文件离线编不了**（04 §0）。
//
// 判据与取舍（阈值怎么来的、达不到怎么办）：
//   · 部位映射：与 `AuditFitProbe.cs` v2 完全同法——不看骨骼名是否精确等于
//     HumanBodyBones，而是沿父链向上遇到的第一个人形骨骼。Play/构建后 MA 会插入
//     Const bone、把多骨合并成 "Foot_L$Toe_L$85"，精确匹配会整片落空；这里在编辑模式
//     对 prefab 层级同样成立，所以照抄。取不到人形 Animator 时退化为骨骼原名。
//   · 权重口径：优先 `Mesh.GetBonesPerVertex/GetAllBoneWeights`，退 legacy
//     `Mesh.boneWeights`；都读不到（网格未开 Read/Write）时用「最近骨骼」近似并标
//     `region_source="nearest_bone"`——宁可粗也不要空。`region_weights` 是**蒙皮权重占比**
//     （每顶点 4 个权重归并到部位后再归一）；`region_vertex_share` 是**主骨骼顶点占比**
//     （T2 §4.6 的 covers 口径，≥2% 才算覆盖），两个都输出，T-04 各取所需。
//   · 闭合度：把三角形顶点按位置焊接（容差 1e-5 m，杀掉 UV/法线缝的重复顶点）后统计
//     只被 1 个三角形使用的边。`boundary_edge_ratio = 边界边 / 唯一边`；
//     `closed = ratio <= 0.10`。0.10 的来源：Blender 对 工程A 网格的离线标定——
//     MMN `Shoes` 焊接后边界边占比 5.5%（三角化后更低），平整布片（`Bandage` 类）
//     40%+，两者分得很开；取 10% 既容得下鞋口/袖口这类小开口循环，又能把纯平面挡在外。
//     网格为空/不可读时 `closed=null`，不猜。
//   · 鞋底厚度启发：编辑模式不建任何临时碰撞体（不脏场景、不改资产），改用**身体脚底**
//     参照：找到身体 SMR（同时含脚与躯干部位、顶点最多、可见），取身体上主骨骼属
//     LeftFoot/LeftToes/RightFoot/RightToes 的顶点最低世界 Y，减去该件同部位顶点最低
//     世界 Y，即「裸脚底到该件外底的高差」。袜子贴身 ≈0–2 mm，厚底鞋 ≥4 mm，与
//     `03a` S6「脚底厚度 ≥4 mm → 鞋」一致；`shoe_like = sole_thickness_mm >= 4`。
//     身体找不到 / 该件没有脚部顶点 → `sole_thickness_mm=null`、`shoe_like=null`。
//     注意这只是**启发**，不是 T2 那种射线量到内外底的高精度值。
//   · 切换方式（clip）：收集 descriptor 的 `baseAnimationLayers` + `specialAnimationLayers`
//     以及头像下所有 MA MergeAnimator 的控制器，对每个控制器的 `animationClips`
//     用 `AnimationUtility.GetCurveBindings/GetObjectReferenceCurveBindings` 抽
//     `m_Enabled` / `m_IsActive`。一个路径同时有两种时 **预置 `m_Enabled`**
//     （渲染器级开关比层级 activeSelf 更贴近「这件本身怎么切」；工程A 的
//     `kaguya_cloth/outer` 既被整套 radial 写 activeSelf、又被厂商 ON/OFF clip
//     写 m_Enabled，验收期望 m_Enabled）。`by_enabled`/`by_active_*` 两个标志都保留。
//   · MA ObjectToggle / MenuItem：同样是编辑模式反射扫组件；把 toggle 目标路径解析到
//     avatar 根相对路径，命中「就是该渲染器或它的祖先」才算控制（祖先被切也会连带隐藏
//     该件）。MenuItem 记在同一件或祖先上的实例。MA 的显隐在构建期才落到 activeSelf，
//     编辑期看不到对应曲线，所以这一列是 `switch` 之外的独立信息。
//
// 只读保证：不 Undo、不 MarkSceneDirty、不 SaveScene、不写任何资产、不建临时物体；
//   只读 Mesh/SMR/AnimationClip/组件，BakeMesh 用一块临时 Mesh（用完 DestroyImmediate）。
// ══════════════════════════════════════════════════════════════════

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using Unity.Collections;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;

namespace AvatarAudit
{
    public static class AuditPartInventory
    {
        // ─────────────────────────────────────────────────────────────
        // 常量
        // ─────────────────────────────────────────────────────────────

        public const string MenuPath = "Tools/AvatarAudit/Export Part Inventory";
        public const string ToolId = "part_inventory";
        public const string OutRelPath = "_感知/out/inventory.json";

        /// <summary>边界边占比 ≤ 它 → closed=true。标定见文件头。</summary>
        public const float ClosedBoundaryRatioMax = 0.10f;
        /// <summary>鞋底高差 ≥ 它（mm）→ shoe_like=true（03a S6）。</summary>
        public const float SoleClosedMinMm = 4.0f;
        /// <summary>主骨骼顶点占比 ≥ 它才算 cover（T2 §4.6）。</summary>
        public const float RegionMinShare = 0.02f;
        /// <summary>身体名候选按蒙皮权重判定时脚/躯干各自的最低权重份额；判据与常量已抽到
        /// <see cref="AuditBodyPick"/>（T-05 / T-10 poke / T2 body=auto 共用，任务 AY）。
        /// 这里保留同名常量只为兼容旧引用。</summary>
        public const float BodyWeightMinShare = AuditBodyPick.MinWeightShare;
        /// <summary>焊接容差（米）：1e-5 = 0.01 mm，足以合并 UV/法线缝的重复顶点。</summary>
        public const float WeldEpsilonM = 1e-5f;
        const int MaxSourcesPerRenderer = 24;

        static readonly string[] FootRegionNames = { "LeftFoot", "LeftToes", "RightFoot", "RightToes" };
        // 脚底最低点只用 FootRegionNames（免得把踝/小腿顶点算进鞋底）；身体识别用的
        // BodyFootDetectNames/TorsoRegionNames 见 AuditBodyPick。
        /// <summary>`part_like=false` 的排除子串（大小写不敏感；名字或任一祖先名含其一）。
        /// 这些是工具/预览/调试/占位物，不是可交付部件。规则可配置：改这张表即改判据；判决
        /// 只看名字（不看材质/尺寸），宁可漏排也别误排真件——真件被误排只影响 MR 清单可读性，
        /// 排错会让人工漏看。默认表来自 工程A T1 实测里 58 个 MR 的分类（2026-09-19）：
        ///   AvatarHight=SPS 身高调节、APS_=Av3 抓取接触代理、AreaShow=CatchableERP 区域显示、
        ///   Timer=AvatarPoseSystem 定时器、功能_/玩具_ 插件宿主、SpsScreenMarker=SPS 屏幕标记、
        ///   PCS Preview Icon=预览图标。最终裁定仍以 part_like 字段给人看，不替代人工核。</summary>
        public static readonly string[] PartLikeExcludeTokens = {
            "PCS Preview Icon", "AreaShow", "AvatarHight", "APS_", "Timer", "功能_",
            "SpsScreenMarker",
        };
        static readonly BindingFlags AnyInstance =
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        // ─────────────────────────────────────────────────────────────
        // 菜单入口
        // ─────────────────────────────────────────────────────────────

        [MenuItem(MenuPath, false, 110)]
        public static void ExportFromMenu()
        {
            try
            {
                string path = Export(null);
                Debug.Log("[AvatarAudit] 部件盘点已写出：" + path);
            }
            catch (Exception e)
            {
                Debug.LogError("[AvatarAudit] 部件盘点失败：" + AuditUtil.Unwrap(e));
            }
        }

        /// <summary>同步跑完并写盘；返回写出的绝对路径。outPathOverride=null 用默认 _感知/out/inventory.json。
        /// 供菜单与 execute_code 复用；抛异常时已把错误写进 status.json。</summary>
        public static string Export(string outPathOverride)
        {
            string projectRoot = AuditRunner.ProjectRoot;
            string outPath = string.IsNullOrEmpty(outPathOverride)
                ? Path.Combine(projectRoot, OutRelPath.Replace('/', Path.DirectorySeparatorChar))
                : outPathOverride;
            string outDir = Path.GetDirectoryName(outPath);
            var status = new AuditStatus(outDir, ToolId);
            status.Running("0/?", "开始部件盘点（编辑模式，只读）");

            try
            {
                var warnings = new List<string>();
                JsonObject root = Build(projectRoot, warnings);
                AuditJson.WriteFile(outPath, root);
                int smr = (int)AuditJson.Num(root, "smr_count", 0);
                int mr = (int)AuditJson.Num(root, "mr_count", 0);
                int psr = (int)AuditJson.Num(root, "psr_count", 0);
                status.Done("done", "写出 " + outPath + "（SMR " + smr + " / MR " + mr
                    + " / PSR " + psr + "，警告 " + warnings.Count + " 条）");
                return outPath;
            }
            catch (Exception e)
            {
                var real = AuditUtil.Unwrap(e);
                status.Error("部件盘点失败：" + real.Message);
                throw real;
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 主流程
        // ─────────────────────────────────────────────────────────────

        public static JsonObject Build(string projectRoot, List<string> warnings)
        {
            var root = new JsonObject();
            root.Set("tool", ToolId);
            root.Set("generated_at", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
            root.Set("project_root", projectRoot);
            root.Set("unity_version", Application.unityVersion);

            var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            root.Set("scene", scene.IsValid() ? scene.path : null);

            root.Set("closed_rule", "boundary_edge_ratio <= " + F(ClosedBoundaryRatioMax) + " → closed=true");
            root.Set("sole_rule_mm", SoleClosedMinMm);
            root.Set("region_share_min", RegionMinShare);
            root.Set("switch_priority", "m_Enabled > m_IsActive");
            root.Set("part_like_rule", "名字或任一祖先名含（大小写不敏感）："
                + string.Join(" | ", PartLikeExcludeTokens) + " → part_like=false");

            List<GameObject> avatars = FindActiveAvatarRoots();
            if (avatars.Count == 0)
                warnings.Add("场景里没有 activeInHierarchy 的 VRCAvatarDescriptor 根。");

            var avatarArr = new List<object>();
            int smrTotal = 0, mrTotal = 0, psrTotal = 0;
            for (int i = 0; i < avatars.Count; i++)
            {
                try
                {
                    int s, m, p;
                    JsonObject a = BuildAvatar(avatars[i], warnings, out s, out m, out p);
                    avatarArr.Add(a);
                    smrTotal += s; mrTotal += m; psrTotal += p;
                }
                catch (Exception e)
                {
                    var real = AuditUtil.Unwrap(e);
                    warnings.Add("盘点头像 '" + avatars[i].name + "' 失败：" + real.Message);
                }
            }

            root.Set("avatar_count", avatars.Count);
            root.Set("smr_count", smrTotal);
            root.Set("mr_count", mrTotal);
            root.Set("psr_count", psrTotal);
            // 旧字段兼容：renderer_count == renderers 数组长度（PSR 只计数不展开）
            root.Set("renderer_count", smrTotal + mrTotal);
            root.Set("avatars", avatarArr);
            root.Set("warnings", ToObjList(warnings));
            return root;
        }

        /// <summary>场景里所有 activeInHierarchy 的 VRCAvatarDescriptor 根（去重、去掉祖先已命中的子孙、
        /// 按 ScenePath 排序保证确定性）。</summary>
        static List<GameObject> FindActiveAvatarRoots()
        {
            Type descType = GmgBridge.FindType("VRC.SDK3.Avatars.Components.VRCAvatarDescriptor");
            if (descType == null)
                throw new Exception("找不到 VRC.SDK3.Avatars.Components.VRCAvatarDescriptor（VRChat SDK3 未加载？）");

            var all = Resources.FindObjectsOfTypeAll(descType);
            var seen = new HashSet<int>();
            var cand = new List<GameObject>();
            for (int i = 0; i < all.Length; i++)
            {
                var c = all[i] as Component;
                if (c == null) continue;
                GameObject go = c.gameObject;
                if (go == null) continue;
                if (EditorUtility.IsPersistent(go)) continue;   // 预制体资产
                if (!go.scene.IsValid()) continue;              // 不在场景里
                if (!go.activeInHierarchy) continue;            // 只看活跃根
                if (!seen.Add(go.GetInstanceID())) continue;
                cand.Add(go);
            }

            var roots = new List<GameObject>();
            for (int i = 0; i < cand.Count; i++)
            {
                bool descendant = false;
                for (int j = 0; j < cand.Count; j++)
                {
                    if (i == j) continue;
                    if (cand[i].transform.IsChildOf(cand[j].transform)) { descendant = true; break; }
                }
                if (!descendant) roots.Add(cand[i]);
            }
            roots.Sort((a, b) => string.CompareOrdinal(
                AuditUtil.ScenePath(a.transform), AuditUtil.ScenePath(b.transform)));
            return roots;
        }

        static JsonObject BuildAvatar(GameObject avatar, List<string> warnings,
            out int smrCount, out int mrCount, out int psrCount)
        {
            var o = new JsonObject();
            o.Set("name", avatar.name);
            o.Set("scene_path", AuditUtil.ScenePath(avatar.transform));

            Animator anim = avatar.GetComponent<Animator>();
            if (anim == null) anim = avatar.GetComponentInChildren<Animator>(true);
            var mapper = new RegionMapper(avatar.transform, anim);

            o.Set("animator_path", anim != null ? AuditUtil.RelPath(avatar.transform, anim.transform) : null);
            o.Set("humanoid", anim != null && anim.isHuman);

            // 收集切换写者（controlers → clips → bindings）与 MA 控制
            List<Driver> drivers = CollectDrivers(avatar, warnings);
            MaControls ma = CollectMaControls(avatar, warnings);

            // 渲染器：活跃根下全部 SMR / MR（含 inactive，盘点要盘全，T-04 要起草隐藏件）；
            // ParticleSystemRenderer 只计数不展开。
            SkinnedMeshRenderer[] smrs = avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
            var smrList = new List<SkinnedMeshRenderer>(smrs);
            smrList.Sort((a, b) => string.CompareOrdinal(
                AuditUtil.RelPath(avatar.transform, a.transform),
                AuditUtil.RelPath(avatar.transform, b.transform)));

            MeshRenderer[] mrs = avatar.GetComponentsInChildren<MeshRenderer>(true);
            var mrList = new List<MeshRenderer>(mrs);
            mrList.Sort((a, b) => string.CompareOrdinal(
                AuditUtil.RelPath(avatar.transform, a.transform),
                AuditUtil.RelPath(avatar.transform, b.transform)));

            psrCount = avatar.GetComponentsInChildren<ParticleSystemRenderer>(true).Length;

            // 身体（脚底参照 + body_keys 来源）；先算一次脚底世界 Y
            SkinnedMeshRenderer body = FindBodySmr(smrList, mapper);
            o.Set("body_path", body != null ? AuditUtil.RelPath(avatar.transform, body.transform) : null);
            float bodySoleY;
            bool haveBodySole = TryFootMinWorldY(body, mapper, out bodySoleY);
            o.Set("body_sole_y", haveBodySole ? (object)(double)bodySoleY : null);

            // 身体全量形态键（顺序同网格；给 profile_keys.py 写素体档案 all_keys:）
            List<object> bodyKeys = BodyKeyList(body);
            o.Set("body_key_count", bodyKeys.Count);
            o.Set("body_keys", bodyKeys);

            float? sole = haveBodySole ? (float?)bodySoleY : null;
            var arr = new List<object>();
            for (int i = 0; i < smrList.Count; i++)
            {
                try
                {
                    arr.Add(BuildRenderer(avatar, smrList[i], mapper, drivers, ma, sole, warnings));
                }
                catch (Exception e)
                {
                    var real = AuditUtil.Unwrap(e);
                    warnings.Add("渲染器 '" + AuditUtil.RelPath(avatar.transform, smrList[i].transform)
                        + "' 盘点失败：" + real.Message);
                }
            }

            // MR 用最近骨骼近似部位（无蒙皮权重）；骨骼候选优先人形骨骼全集
            Transform[] boneCloud = BuildBoneCloud(body, smrList, mapper);
            if (boneCloud.Length == 0 && mrList.Count > 0)
                warnings.Add("头像 '" + avatar.name + "' 的 MR 找不到任何骨骼候选，covers 留空。");
            for (int i = 0; i < mrList.Count; i++)
            {
                try
                {
                    arr.Add(BuildMeshRenderer(avatar, mrList[i], mapper, drivers, ma, sole, boneCloud, warnings));
                }
                catch (Exception e)
                {
                    var real = AuditUtil.Unwrap(e);
                    warnings.Add("MeshRenderer '" + AuditUtil.RelPath(avatar.transform, mrList[i].transform)
                        + "' 盘点失败：" + real.Message);
                }
            }

            smrCount = smrList.Count;
            mrCount = mrList.Count;
            o.Set("smr_count", smrCount);
            o.Set("mr_count", mrCount);
            o.Set("psr_count", psrCount);
            // 旧字段兼容：renderer_count == renderers 数组长度（PSR 只计数不展开）
            o.Set("renderer_count", smrCount + mrCount);
            o.Set("switch_clip_count", drivers.Count);
            o.Set("key_follow", BuildKeyFollow(avatar, smrList, body, anim, mapper, warnings));
            o.Set("renderers", arr);
            return o;
        }

        // ─────────────────────────────────────────────────────────────
        // 单个渲染器
        // ─────────────────────────────────────────────────────────────

        static JsonObject BuildRenderer(GameObject avatar, SkinnedMeshRenderer smr, RegionMapper mapper,
            List<Driver> drivers, MaControls ma, float? bodySoleY, List<string> warnings)
        {
            var o = new JsonObject();
            Transform aroot = avatar.transform;
            string path = AuditUtil.RelPath(aroot, smr.transform);
            Mesh mesh = smr.sharedMesh;

            o.Set("path", path);
            o.Set("name", smr.name);
            o.Set("type", smr.GetType().Name);
            o.Set("part_like", IsPartLike(aroot, smr.transform));
            o.Set("active_self", smr.gameObject.activeSelf);
            o.Set("enabled", smr.enabled);
            o.Set("active_in_hierarchy", smr.gameObject.activeInHierarchy);
            o.Set("mesh", mesh != null ? mesh.name : null);
            o.Set("mesh_asset", mesh != null ? AssetDatabase.GetAssetPath(mesh) : null);
            o.Set("vertex_count", mesh != null ? mesh.vertexCount : 0);
            o.Set("submesh_count", mesh != null ? mesh.subMeshCount : 0);
            o.Set("readable", mesh != null && mesh.isReadable);

            // 材质槽（按 slot 顺序，保持可核对）
            var mats = new List<object>();
            Material[] shared = smr.sharedMaterials;
            for (int i = 0; i < shared.Length; i++)
                mats.Add(shared[i] != null ? shared[i].name : null);
            o.Set("material_slots", mats);

            // 网格快照（BakeMesh 优先：不受 Read/Write 限制，且是当前姿势；用完即毁）
            Vector3[] verts; int[] tris; string posSource;
            bool haveGeo = TrySnapshot(smr, out verts, out tris, out posSource);
            o.Set("geometry_source", haveGeo ? posSource : "unavailable");

            // 部位权重 / 顶点占比 / covers
            string[] domRegion = null;
            JsonObject rw, rvs;
            List<string> covers;
            string regionSource;
            ComputeRegions(smr, mapper, verts, out rw, out rvs, out covers, out domRegion, out regionSource);
            o.Set("region_source", regionSource);
            o.Set("region_weights", rw);
            o.Set("region_vertex_share", rvs);
            o.Set("covers", ToObjList(covers));
            o.Set("dominant_region", PickDominant(rvs));

            // 闭合度
            if (haveGeo && tris != null && tris.Length > 0 && verts != null && verts.Length > 0)
            {
                int boundary, edges;
                ComputeBoundary(verts, tris, out boundary, out edges);
                double ratio = edges > 0 ? (double)boundary / edges : 0.0;
                o.Set("edge_count", edges);
                o.Set("boundary_edges", boundary);
                o.Set("boundary_edge_ratio", ratio);
                o.Set("closed_ratio", 1.0 - ratio);
                o.Set("closed", edges > 0 && ratio <= ClosedBoundaryRatioMax);
            }
            else
            {
                o.Set("edge_count", 0);
                o.Set("boundary_edges", 0);
                o.Set("boundary_edge_ratio", null);
                o.Set("closed_ratio", null);
                o.Set("closed", null);
            }

            // 鞋底厚度启发：身体裸脚底 − 该件脚部顶点最低点
            float garmentFootMinY;
            if (bodySoleY.HasValue && verts != null && domRegion != null &&
                TryFootMinWorldY(smr, verts, domRegion, out garmentFootMinY))
            {
                double soleMmValue = ((double)bodySoleY.Value - garmentFootMinY) * 1000.0;
                o.Set("sole_thickness_mm", soleMmValue);
                o.Set("shoe_like", soleMmValue >= SoleClosedMinMm);
            }
            else
            {
                o.Set("sole_thickness_mm", null);
                o.Set("shoe_like", null);
            }

            // 切换方式
            o.Set("switch", BuildSwitch(avatar, smr.transform, path, drivers));
            o.Set("switch_method", SwitchMethod(avatar, smr.transform, path, drivers));

            // MA 控制
            o.Set("ma", BuildMa(path, ma));

            return o;
        }

        /// <summary>MeshRenderer 条目（任务 AQ）。字段与 SMR 尽量一致；无骨骼权重，
        /// `covers` 走最近骨骼近似（`region_source=nearest_bone` / `nearest_bone_object`），
        /// 鞋底启发仍用同一条「身体裸脚底 − 该件脚部顶点最低点」。</summary>
        static JsonObject BuildMeshRenderer(GameObject avatar, MeshRenderer mr, RegionMapper mapper,
            List<Driver> drivers, MaControls ma, float? bodySoleY, Transform[] boneCloud, List<string> warnings)
        {
            var o = new JsonObject();
            Transform aroot = avatar.transform;
            string path = AuditUtil.RelPath(aroot, mr.transform);
            MeshFilter mf = mr.GetComponent<MeshFilter>();
            Mesh mesh = mf != null ? mf.sharedMesh : null;

            o.Set("path", path);
            o.Set("name", mr.name);
            o.Set("type", "MeshRenderer");
            o.Set("part_like", IsPartLike(aroot, mr.transform));
            o.Set("active_self", mr.gameObject.activeSelf);
            o.Set("enabled", mr.enabled);
            o.Set("active_in_hierarchy", mr.gameObject.activeInHierarchy);
            o.Set("mesh_filter", mf != null);
            o.Set("mesh", mesh != null ? mesh.name : null);
            o.Set("mesh_asset", mesh != null ? AssetDatabase.GetAssetPath(mesh) : null);
            o.Set("vertex_count", mesh != null ? mesh.vertexCount : 0);
            o.Set("submesh_count", mesh != null ? mesh.subMeshCount : 0);
            o.Set("readable", mesh != null && mesh.isReadable);

            // 材质槽（按 slot 顺序，保持可核对）
            var mats = new List<object>();
            Material[] shared = mr.sharedMaterials;
            for (int i = 0; i < shared.Length; i++)
                mats.Add(shared[i] != null ? shared[i].name : null);
            o.Set("material_slots", mats);

            // 几何：MeshRenderer 不能 BakeMesh，网格未开 Read/Write 就只能拿物体位置近似
            Vector3[] verts; int[] tris; string posSource;
            bool haveGeo = TrySnapshotMesh(mesh, out verts, out tris, out posSource);
            o.Set("geometry_source", haveGeo ? posSource : "unavailable");

            // 部位近似 / covers
            string[] domRegion = null;
            JsonObject rw, rvs;
            List<string> covers;
            string regionSource;
            ComputeRegionsNearest(mr.transform, verts, boneCloud, mapper,
                out rw, out rvs, out covers, out domRegion, out regionSource);
            o.Set("region_source", regionSource);
            o.Set("region_weights", rw);
            o.Set("region_vertex_share", rvs);
            o.Set("covers", ToObjList(covers));
            o.Set("dominant_region", PickDominant(rvs));

            // 闭合度
            if (haveGeo && tris != null && tris.Length > 0 && verts != null && verts.Length > 0)
            {
                int boundary, edges;
                ComputeBoundary(verts, tris, out boundary, out edges);
                double ratio = edges > 0 ? (double)boundary / edges : 0.0;
                o.Set("edge_count", edges);
                o.Set("boundary_edges", boundary);
                o.Set("boundary_edge_ratio", ratio);
                o.Set("closed_ratio", 1.0 - ratio);
                o.Set("closed", edges > 0 && ratio <= ClosedBoundaryRatioMax);
            }
            else
            {
                o.Set("edge_count", 0);
                o.Set("boundary_edges", 0);
                o.Set("boundary_edge_ratio", null);
                o.Set("closed_ratio", null);
                o.Set("closed", null);
            }

            // 鞋底厚度启发：身体裸脚底 − 该件脚部顶点最低点
            float garmentFootMinY;
            if (bodySoleY.HasValue && verts != null && domRegion != null &&
                TryFootMinWorldY(mr.transform, verts, domRegion, out garmentFootMinY))
            {
                double soleMmValue = ((double)bodySoleY.Value - garmentFootMinY) * 1000.0;
                o.Set("sole_thickness_mm", soleMmValue);
                o.Set("shoe_like", soleMmValue >= SoleClosedMinMm);
            }
            else
            {
                o.Set("sole_thickness_mm", null);
                o.Set("shoe_like", null);
            }

            // 切换方式
            o.Set("switch", BuildSwitch(avatar, mr.transform, path, drivers));
            o.Set("switch_method", SwitchMethod(avatar, mr.transform, path, drivers));

            // MA 控制
            o.Set("ma", BuildMa(path, ma));

            return o;
        }

        // ─────────────────────────────────────────────────────────────
        // 切换写者
        // ─────────────────────────────────────────────────────────────

        static JsonObject BuildSwitch(GameObject avatar, Transform target, string path, List<Driver> drivers)
        {
            string animPath = path;
            if (avatar.GetComponent<Animator>() != null || avatar.GetComponentInChildren<Animator>(true) != null)
            {
                Animator anim = avatar.GetComponent<Animator>();
                if (anim == null) anim = avatar.GetComponentInChildren<Animator>(true);
                animPath = AuditUtil.RelPath(anim.transform, target);
            }

            bool byEnabled = false, byActiveSelf = false, byActiveAncestor = false;
            var sources = new List<Driver>();
            for (int i = 0; i < drivers.Count; i++)
            {
                Driver d = drivers[i];
                bool self = PathEquals(d.Path, path) || PathEquals(d.Path, animPath);
                if (d.Property == "m_Enabled")
                {
                    if (!self) continue;
                    byEnabled = true;
                    AddSource(sources, d);
                }
                else if (d.Property == "m_IsActive")
                {
                    if (self) { byActiveSelf = true; AddSource(sources, d); }
                    else if (IsAncestorPath(d.Path, path) || IsAncestorPath(d.Path, animPath))
                    { byActiveAncestor = true; AddSource(sources, d); }
                }
            }
            sources.Sort(CompareDriver);
            if (sources.Count > MaxSourcesPerRenderer) sources.RemoveRange(MaxSourcesPerRenderer, sources.Count - MaxSourcesPerRenderer);

            var sw = new JsonObject();
            string mode = byEnabled ? "m_Enabled" : ((byActiveSelf || byActiveAncestor) ? "m_IsActive" : "none");
            sw.Set("method", mode);
            sw.Set("by_enabled", byEnabled);
            sw.Set("by_active_self", byActiveSelf);
            sw.Set("by_active_ancestor", byActiveAncestor);
            sw.Set("sources", DriversToObj(sources));
            return sw;
        }

        static string SwitchMethod(GameObject avatar, Transform target, string path, List<Driver> drivers)
        {
            JsonObject sw = BuildSwitch(avatar, target, path, drivers);
            return AuditJson.Str(sw, "method", "none");
        }

        static JsonObject BuildMa(string path, MaControls ma)
        {
            var targets = new List<string>();
            for (int i = 0; i < ma.ToggleTargets.Count; i++)
            {
                string t = ma.ToggleTargets[i];
                if (PathEquals(t, path) || IsAncestorPath(t, path)) AddUnique(targets, t);
            }
            var menus = new List<string>();
            for (int i = 0; i < ma.MenuItemPaths.Count; i++)
            {
                string t = ma.MenuItemPaths[i];
                if (PathEquals(t, path) || IsAncestorPath(t, path)) AddUnique(menus, t);
            }
            targets.Sort(StringComparer.Ordinal);
            menus.Sort(StringComparer.Ordinal);

            var o = new JsonObject();
            o.Set("object_toggle", targets.Count > 0);
            o.Set("menu_item", menus.Count > 0);
            o.Set("toggle_targets", ToObjList(targets));
            o.Set("menu_item_paths", ToObjList(menus));
            return o;
        }

        /// <summary>收集所有切换写者：descriptor 各动画层 + MA MergeAnimator 的控制器 → animationClips → 曲线。
        /// MA MergeAnimator 用 `pathMode: Relative` 时其 clip 路径相对宿主/relativePathRoot，需加前缀；
        /// `Absolute`（工程A 两个 A2_FX 合并器都是）则已是 avatar 根相对路径，不加。</summary>
        static List<Driver> CollectDrivers(GameObject avatar, List<string> warnings)
        {
            var ctrlRefs = CollectControllerRefs(avatar);
            var map = new Dictionary<string, Driver>(StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < ctrlRefs.Count; i++)
            {
                CtrlRef cr = ctrlRefs[i];
                RuntimeAnimatorController c = cr.Ctrl;
                if (c == null) continue;
                string prefix = cr.Prefix ?? "";
                if (!seen.Add(c.GetInstanceID() + "|" + prefix)) continue;
                string ctrlName = c.name;
                string ctrlPath = AssetDatabase.GetAssetPath(c);
                AnimationClip[] clips = null;
                try { clips = c.animationClips; }
                catch (Exception e) { warnings.Add("读控制器 '" + ctrlName + "' 的 animationClips 失败：" + AuditUtil.Unwrap(e).Message); }
                if (clips == null) continue;
                for (int j = 0; j < clips.Length; j++)
                {
                    AnimationClip clip = clips[j];
                    if (clip == null) continue;
                    ScanClip(clip, ctrlName, ctrlPath, prefix, map);
                }
            }

            var list = new List<Driver>(map.Values);
            list.Sort(CompareDriver);
            return list;
        }

        /// <summary>头像各动画层 + 头像下所有 MA MergeAnimator 的控制器（带 avatar 根相对路径前缀）。
        /// 供 CollectDrivers（开关键）与 key_follow（形态键）共用；只收集引用，不读 clip。</summary>
        static List<CtrlRef> CollectControllerRefs(GameObject avatar)
        {
            Transform aroot = avatar.transform;
            var ctrlRefs = new List<CtrlRef>();

            Component desc = AuditAvatar.FindDescriptor(avatar);
            if (desc != null)
            {
                ReadLayerControllers(desc, "baseAnimationLayers", "", ctrlRefs);
                ReadLayerControllers(desc, "specialAnimationLayers", "", ctrlRefs);
            }

            // MA MergeAnimator（字段 animator；类型名含 MergeAnimator 即可，避免引 MA）
            MonoBehaviour[] mbs = avatar.GetComponentsInChildren<MonoBehaviour>(true);
            for (int i = 0; i < mbs.Length; i++)
            {
                MonoBehaviour mb = mbs[i];
                if (mb == null) continue;
                string tn = mb.GetType().Name;
                if (tn.IndexOf("MergeAnimator", StringComparison.OrdinalIgnoreCase) < 0) continue;
                object v = GetMember(mb, "animator");
                var rac = v as RuntimeAnimatorController;
                if (rac != null) ctrlRefs.Add(new CtrlRef { Ctrl = rac, Prefix = MergeAnimatorPrefix(aroot, mb) });
            }
            return ctrlRefs;
        }

        /// <summary>MergeAnimator 的路径前缀：Absolute 或根 = ""，Relative = 宿主/relativePathRoot 的 avatar 根相对路径。</summary>
        static string MergeAnimatorPrefix(Transform aroot, MonoBehaviour mb)
        {
            object pm = GetMember(mb, "pathMode");
            int mode = pm != null ? Convert.ToInt32(pm, CultureInfo.InvariantCulture) : 0;
            if (mode != 0) return "";   // MergeAnimatorPathMode.Absolute

            Transform rt = mb.transform;
            object rootRef = GetMember(mb, "relativePathRoot");
            if (rootRef != null)
            {
                string rp = GetMember(rootRef, "referencePath") as string;
                var target = GetMember(rootRef, "targetObject") as GameObject;
                if (target != null) rt = target.transform;
                else if (rp == "$$$AVATAR_ROOT$$$") rt = aroot;
                else if (!string.IsNullOrEmpty(rp))
                {
                    Transform t = aroot.Find(rp);
                    if (t != null) rt = t;
                }
            }
            if (rt == aroot) return "";
            string p = AuditUtil.RelPath(aroot, rt);
            if (string.IsNullOrEmpty(p) || p == "." || p.StartsWith("<", StringComparison.Ordinal)) return "";
            return p;
        }

        static void ReadLayerControllers(object desc, string field, string prefix, List<CtrlRef> into)
        {
            object layers = GetMember(desc, field);
            var en = layers as IEnumerable;
            if (en == null) return;
            foreach (object layer in en)
            {
                if (layer == null) continue;
                object c = GetMember(layer, "animatorController");
                var rac = c as RuntimeAnimatorController;
                if (rac != null) into.Add(new CtrlRef { Ctrl = rac, Prefix = prefix });
            }
        }

        static void ScanClip(AnimationClip clip, string ctrlName, string ctrlPath, string prefix,
            Dictionary<string, Driver> map)
        {
            string clipPath = AssetDatabase.GetAssetPath(clip);
            if (string.IsNullOrEmpty(clipPath)) clipPath = "(runtime)" + clip.name;

            EditorCurveBinding[] fc = null, oc = null;
            try { fc = AnimationUtility.GetCurveBindings(clip); } catch { }
            try { oc = AnimationUtility.GetObjectReferenceCurveBindings(clip); } catch { }
            AddBindings(fc, clip.name, clipPath, ctrlName, ctrlPath, prefix, map);
            AddBindings(oc, clip.name, clipPath, ctrlName, ctrlPath, prefix, map);
        }

        static void AddBindings(EditorCurveBinding[] bindings, string clipName, string clipPath,
            string ctrlName, string ctrlPath, string prefix, Dictionary<string, Driver> map)
        {
            if (bindings == null) return;
            for (int i = 0; i < bindings.Length; i++)
            {
                EditorCurveBinding b = bindings[i];
                string prop = b.propertyName;
                if (prop != "m_Enabled" && prop != "m_IsActive") continue;
                var d = new Driver();
                d.Property = prop;
                d.Path = CombinePath(prefix, b.path);
                d.Clip = clipName;
                d.ClipPath = clipPath;
                d.Controller = ctrlName;
                d.ControllerPath = ctrlPath;
                string key = prop + "|" + d.Path + "|" + clipPath + "|" + ctrlName;
                if (!map.ContainsKey(key)) map.Add(key, d);
            }
        }

        /// <summary>把 MergeAnimator 前缀与 clip 内相对路径拼成 avatar 根相对路径。</summary>
        static string CombinePath(string prefix, string path)
        {
            string p = path ?? "";
            if (string.IsNullOrEmpty(prefix)) return p;
            if (string.IsNullOrEmpty(p)) return prefix;
            return prefix + "/" + p;
        }

        // ─────────────────────────────────────────────────────────────
        // MA ObjectToggle / MenuItem（反射扫组件）
        // ─────────────────────────────────────────────────────────────

        static MaControls CollectMaControls(GameObject avatar, List<string> warnings)
        {
            var ma = new MaControls();
            Transform aroot = avatar.transform;
            MonoBehaviour[] mbs = avatar.GetComponentsInChildren<MonoBehaviour>(true);
            for (int i = 0; i < mbs.Length; i++)
            {
                MonoBehaviour mb = mbs[i];
                if (mb == null) continue;
                string tn = mb.GetType().Name;
                if (tn == "ModularAvatarObjectToggle")
                {
                    object objs = GetMember(mb, "m_objects");
                    var en = objs as IEnumerable;
                    if (en == null) continue;
                    foreach (object toggled in en)
                    {
                        if (toggled == null) continue;
                        object aor = GetMember(toggled, "Object");
                        if (aor == null) continue;
                        string p = ResolveAvatarObjectRef(aroot, aor);
                        if (!string.IsNullOrEmpty(p)) AddUnique(ma.ToggleTargets, p);
                        else warnings.Add("MA ObjectToggle '" + AuditUtil.RelPath(aroot, mb.transform)
                            + "' 的目标无法解析到头像下。");
                    }
                }
                else if (tn == "ModularAvatarMenuItem")
                {
                    AddUnique(ma.MenuItemPaths, AuditUtil.RelPath(aroot, mb.transform));
                }
            }
            return ma;
        }

        static string ResolveAvatarObjectRef(Transform aroot, object aor)
        {
            var target = GetMember(aor, "targetObject") as GameObject;
            if (target != null && target.transform != null)
            {
                if (target.transform == aroot) return ".";
                if (target.transform.IsChildOf(aroot)) return AuditUtil.RelPath(aroot, target.transform);
            }
            string refPath = GetMember(aor, "referencePath") as string;
            if (string.IsNullOrEmpty(refPath)) return null;
            if (refPath == "$$$AVATAR_ROOT$$$") return ".";
            Transform t = aroot.Find(refPath);
            return t != null ? refPath : null;
        }

        // ─────────────────────────────────────────────────────────────
        // 同名键跟随（key_follow）：身体被写的形态键 × 件上同名键 ∩ 件上无写者
        // ─────────────────────────────────────────────────────────────

        /// <summary>收所有「写形态键」的来源：各动画层 + MA MergeAnimator 的 clip（含 BlendTree
        /// 子 motion）里 `blendShape.<键>` 的浮点曲线，加上 MA ShapeChanger 的 m_shapes。
        /// 路径一律折成 avatar 根相对（MergeAnimator 前缀按 Relative/Absolute 处理）。</summary>
        static ShapeIndex CollectShapeWriters(GameObject avatar, List<string> warnings)
        {
            var index = new ShapeIndex();
            List<CtrlRef> ctrlRefs = CollectControllerRefs(avatar);
            for (int i = 0; i < ctrlRefs.Count; i++)
            {
                CtrlRef cr = ctrlRefs[i];
                RuntimeAnimatorController c = cr.Ctrl;
                if (c == null) continue;
                string prefix = cr.Prefix ?? "";
                string ctrlName = c.name;
                string ctrlPath = AssetDatabase.GetAssetPath(c);
                List<AnimationClip> clips = CollectControllerClips(c, warnings, ctrlName, ctrlPath);
                for (int j = 0; j < clips.Count; j++)
                    ScanShapeClip(clips[j], ctrlName, ctrlPath, prefix, index);
            }
            CollectShapeChangers(avatar, warnings, index);
            return index;
        }

        /// <summary>控制器的全部 clip：`animationClips` 为主，再对 AnimatorController 显式展开
        /// 状态机/BlendTree 子 motion 兜底（部分 Unity 版本/嵌套结构下 animationClips 会漏），按实例去重。
        /// AnimatorOverrideController 只信 animationClips，不拆底层控制器（避免把被覆盖掉的原始 clip 当成写者）。</summary>
        static List<AnimationClip> CollectControllerClips(RuntimeAnimatorController c, List<string> warnings,
            string ctrlName, string ctrlPath)
        {
            var clips = new List<AnimationClip>();
            var seen = new HashSet<int>();
            AnimationClip[] direct = null;
            try { direct = c.animationClips; }
            catch (Exception e)
            {
                warnings.Add("key_follow 读控制器 '" + ctrlName + "' 的 animationClips 失败：" + AuditUtil.Unwrap(e).Message);
            }
            if (direct != null)
                for (int i = 0; i < direct.Length; i++) AddClip(clips, seen, direct[i]);

            var ac = c as AnimatorController;
            if (ac != null)
            {
                AnimatorControllerLayer[] layers = ac.layers;
                for (int li = 0; li < layers.Length; li++)
                {
                    if (layers[li] == null) continue;
                    ExpandStateMachine(layers[li].stateMachine, clips, seen);
                }
            }
            return clips;
        }

        static void AddClip(List<AnimationClip> clips, HashSet<int> seen, Motion m)
        {
            var clip = m as AnimationClip;
            if (clip == null) return;
            if (seen.Add(clip.GetInstanceID())) clips.Add(clip);
        }

        static void ExpandStateMachine(AnimatorStateMachine sm, List<AnimationClip> clips, HashSet<int> seen)
        {
            if (sm == null) return;
            ChildAnimatorState[] states = sm.states;
            for (int i = 0; i < states.Length; i++)
            {
                if (states[i].state == null) continue;
                AddMotionTree(states[i].state.motion, clips, seen);
            }
            ChildAnimatorStateMachine[] subs = sm.stateMachines;
            for (int i = 0; i < subs.Length; i++) ExpandStateMachine(subs[i].stateMachine, clips, seen);
        }

        static void AddMotionTree(Motion m, List<AnimationClip> clips, HashSet<int> seen)
        {
            if (m == null) return;
            var bt = m as BlendTree;
            if (bt != null)
            {
                ChildMotion[] children = bt.children;
                for (int i = 0; i < children.Length; i++) AddMotionTree(children[i].motion, clips, seen);
                return;
            }
            AddClip(clips, seen, m);
        }

        static void ScanShapeClip(AnimationClip clip, string ctrlName, string ctrlPath, string prefix, ShapeIndex index)
        {
            if (clip == null) return;
            EditorCurveBinding[] fc = null;
            try { fc = AnimationUtility.GetCurveBindings(clip); } catch { }
            if (fc == null) return;

            string clipPath = AssetDatabase.GetAssetPath(clip);
            if (string.IsNullOrEmpty(clipPath)) clipPath = "(runtime)" + clip.name;
            const string ShapePrefix = "blendShape.";
            for (int i = 0; i < fc.Length; i++)
            {
                EditorCurveBinding b = fc[i];
                if (b.propertyName == null || !b.propertyName.StartsWith(ShapePrefix, StringComparison.Ordinal)) continue;
                string key = b.propertyName.Substring(ShapePrefix.Length);
                if (key.Length == 0) continue;
                var w = new ShapeWriter();
                w.Source = "clip";
                w.Clip = clip.name;
                w.ClipPath = clipPath;
                w.Controller = ctrlName;
                w.ControllerPath = ctrlPath;
                index.Add(CombinePath(prefix, b.path), key, w);
            }
        }

        static void CollectShapeChangers(GameObject avatar, List<string> warnings, ShapeIndex index)
        {
            Transform aroot = avatar.transform;
            MonoBehaviour[] mbs = avatar.GetComponentsInChildren<MonoBehaviour>(true);
            for (int i = 0; i < mbs.Length; i++)
            {
                MonoBehaviour mb = mbs[i];
                if (mb == null) continue;
                if (mb.GetType().Name != "ModularAvatarShapeChanger") continue;

                object shapesObj = GetMember(mb, "m_shapes");
                if (shapesObj == null) shapesObj = GetMember(mb, "Shapes");
                var en = shapesObj as IEnumerable;
                if (en == null) continue;
                string compPath = AuditUtil.RelPath(aroot, mb.transform);

                foreach (object shape in en)
                {
                    if (shape == null) continue;
                    string shapeName = GetMember(shape, "ShapeName") as string;
                    if (string.IsNullOrEmpty(shapeName)) continue;
                    object objRef = GetMember(shape, "Object");
                    string target = ResolveAvatarObjectRef(aroot, objRef);
                    if (string.IsNullOrEmpty(target))
                    {
                        warnings.Add("key_follow: MA ShapeChanger '" + compPath + "' 的 ShapeName='"
                            + shapeName + "' 未设 Object，无法归位。");
                        continue;
                    }
                    var w = new ShapeWriter();
                    w.Source = "shape_changer";
                    w.ComponentPath = compPath;
                    object ct = GetMember(shape, "ChangeType");
                    w.ChangeType = ct != null ? ct.ToString() : null;
                    object val = GetMember(shape, "Value");
                    try { w.Value = val != null ? Convert.ToDouble(val, CultureInfo.InvariantCulture) : 0.0; }
                    catch { w.Value = 0.0; }
                    index.Add(target, shapeName, w);
                }
            }
        }

        /// <summary>同名键跟随检查主体。只读、只列；固定件（有意恒值）也在 candidates 里，不判对错。
        /// 身体识别沿用 FindBodySmr（与鞋底厚度同一套）。</summary>
        static JsonObject BuildKeyFollow(GameObject avatar, List<SkinnedMeshRenderer> smrs,
            SkinnedMeshRenderer body, Animator anim, RegionMapper mapper, List<string> warnings)
        {
            Transform aroot = avatar.transform;
            var o = new JsonObject();
            string bodyPath = body != null ? AuditUtil.RelPath(aroot, body.transform) : null;
            o.Set("body", bodyPath);
            o.Set("rule", "件键名 ∩ 身体被写键，且件上无写者 → candidate；只列，不判对错。");
            o.Set("class_rule", "bust=breast|chest|胸|bust；foot=foot|heel|toe|足|ヒール；其余 other");

            if (body == null)
            {
                warnings.Add("key_follow: 找不到身体 SMR，跳过同名键跟随检查。");
                o.Set("body_written_keys", new List<object>());
                o.Set("candidates", new List<object>());
                o.Set("synced", new List<object>());
                o.Set("candidates_by_class", EmptyKeyClasses());
                return o;
            }

            ShapeIndex index = CollectShapeWriters(avatar, warnings);

            // 身体路径（avatar 根相对 + Animator 根相对，两个都认，兼容嵌套 Animator）
            var bodyPaths = new HashSet<string>(StringComparer.Ordinal);
            bodyPaths.Add(Norm(bodyPath));
            if (anim != null) bodyPaths.Add(Norm(AuditUtil.RelPath(anim.transform, body.transform)));

            // 件用 MA BlendshapeSync 声明过的「身体源键」也算身体被写键（见方法注释）
            AddSyncSourceKeys(avatar, index, bodyPaths, body, warnings);

            // 身体被写的键 → 写者
            var bodyKeySet = new HashSet<string>(StringComparer.Ordinal);
            var bodyKeyWriters = new Dictionary<string, List<ShapeWriter>>(StringComparer.Ordinal);
            foreach (var byPath in index.Map)
            {
                if (!bodyPaths.Contains(Norm(byPath.Key))) continue;
                foreach (var byKey in byPath.Value)
                {
                    bodyKeySet.Add(byKey.Key);
                    List<ShapeWriter> list;
                    if (!bodyKeyWriters.TryGetValue(byKey.Key, out list))
                    {
                        list = new List<ShapeWriter>();
                        bodyKeyWriters[byKey.Key] = list;
                    }
                    for (int w = 0; w < byKey.Value.Count; w++) AddWriter(list, byKey.Value[w]);
                }
            }

            var bodyKeyList = new List<string>(bodyKeyWriters.Keys);
            bodyKeyList.Sort(StringComparer.Ordinal);
            var bodyWritten = new List<object>(bodyKeyList.Count);
            for (int i = 0; i < bodyKeyList.Count; i++)
            {
                var bo = new JsonObject();
                bo.Set("key", bodyKeyList[i]);
                bo.Set("writers", WritersToObj(bodyKeyWriters[bodyKeyList[i]]));
                bodyWritten.Add(bo);
            }

            // 逐件求交集：件键名 ∩ 身体被写键
            var candidates = new List<ShapeFollow>();
            var synced = new List<ShapeFollow>();
            for (int i = 0; i < smrs.Count; i++)
            {
                SkinnedMeshRenderer smr = smrs[i];
                if (smr == null || smr == body) continue;
                Mesh mesh = smr.sharedMesh;
                if (mesh == null || mesh.blendShapeCount == 0) continue;
                string piecePath = AuditUtil.RelPath(aroot, smr.transform);
                string pieceAnimPath = anim != null ? AuditUtil.RelPath(anim.transform, smr.transform) : null;

                var keys = new List<string>();
                for (int k = 0; k < mesh.blendShapeCount; k++)
                {
                    string key = mesh.GetBlendShapeName(k);
                    if (!string.IsNullOrEmpty(key) && bodyKeySet.Contains(key)) keys.Add(key);
                }
                if (keys.Count == 0) continue;
                keys.Sort(StringComparer.Ordinal);

                for (int k = 0; k < keys.Count; k++)
                {
                    string key = keys[k];
                    int idx = mesh.GetBlendShapeIndex(key);
                    var f = new ShapeFollow();
                    f.Renderer = piecePath;
                    f.Key = key;
                    f.Weight = idx >= 0 ? smr.GetBlendShapeWeight(idx) : 0.0;
                    f.Smr = smr;
                    f.BodyWriters = bodyKeyWriters[key];
                    f.PieceWriters = new List<ShapeWriter>();
                    AddPieceWriters(aroot, index, smr, piecePath, pieceAnimPath, key, f.PieceWriters);
                    if (f.PieceWriters.Count == 0) candidates.Add(f);
                    else synced.Add(f);
                }
            }

            candidates.Sort(CompareFollow);
            synced.Sort(CompareFollow);

            // 几何加权（任务 AY，B-补-07）：只给 candidates 补字段，供 verdict 把「数值失配但几何不变」
            // 的候选降为 benign/advisory。原字段一律不动。
            AttachFollowGeometry(body, mapper, candidates, warnings);

            o.Set("geom_rule",
                "candidates[].geom：身体与件都对该键**真的 SetBlendShapeWeight 到 0、100 各 BakeMesh 一次"
                + "（useScale=true，读完 finally 还原原权重）**；body_key_disp_mm/piece_key_disp_mm=该键 0→100"
                + " 时（件覆盖区内）身体/件顶点位移 mm 分布；body_piece_dist_mm={at0,at100,delta} 为该件每个"
                + "顶点到身体表面的最近距离（p50/max；at0 为身体与件该键都在 0 时，at100 为都在 100 时，"
                + "delta=p50(at100)-p50(at0)）。几何不变（dist 差小）而数值失配 → 可判 benign/advisory。");
            o.Set("body_written_keys", bodyWritten);
            o.Set("candidates", FollowsToObj(candidates));
            o.Set("synced", FollowsToObj(synced));
            o.Set("candidates_by_class", ClassifyCandidates(candidates));
            return o;
        }

        // ─────────────────────────────────────────────────────────────
        // 几何加权（任务 AY，B-补-07）
        // ─────────────────────────────────────────────────────────────

        /// <summary>给每个候选补几何数据（只加字段，不改原字段）。身体快照失败时把候选的
        /// geom.available 置 false 并写一条 warning，不抛。</summary>
        static void AttachFollowGeometry(SkinnedMeshRenderer body, RegionMapper mapper,
            List<ShapeFollow> candidates, List<string> warnings)
        {
            if (candidates == null || candidates.Count == 0) return;

            Vector3[] bodyVerts = null; int[] bodyTris = null; string bodySrc = null;
            Mesh bodyMesh = body != null ? body.sharedMesh : null;
            bool haveBody = body != null && bodyMesh != null
                && TrySnapshot(body, out bodyVerts, out bodyTris, out bodySrc)
                && bodyVerts != null && bodyVerts.Length > 0
                && bodyTris != null && bodyTris.Length >= 3;
            if (!haveBody)
            {
                for (int i = 0; i < candidates.Count; i++)
                {
                    var g = new JsonObject();
                    g.Set("available", false);
                    g.Set("note", "身体网格快照不可用");
                    candidates[i].Geom = g;
                }
                warnings.Add("key_follow 几何加权：身体网格快照不可用，candidates[].geom.available=false。");
                return;
            }

            // 身体逐顶点主部位（用于「件覆盖区内身体顶点」筛选）
            string[] bodyDom = null;
            {
                JsonObject brw, brvs; List<string> bcov; string brs;
                try { ComputeRegions(body, mapper, bodyVerts, out brw, out brvs, out bcov, out bodyDom, out brs); }
                catch { bodyDom = null; }
            }

            Matrix4x4 bodyL2W = body.transform.localToWorldMatrix;

            bool deltaAligned = bodyVerts.Length == bodyMesh.vertexCount;
            var keyCache = new Dictionary<string, BodyKeyGeom>(StringComparer.Ordinal);

            for (int ci = 0; ci < candidates.Count; ci++)
            {
                ShapeFollow f = candidates[ci];
                var g = new JsonObject();
                f.Geom = g;
                try
                {
                g.Set("available", true);
                g.Set("body_delta_available", deltaAligned);
                g.Set("body_key", f.Key);

                SkinnedMeshRenderer piece = f.Smr;
                // B-补-07/AY 返工：件的「键两端」——有同名键时同步设 0 与 100 各烘一次（读完各自还原），
                // 没有该键时两端都取当前快照（键不存在=两端天然等价）。
                Vector3[] pv0 = null, pv100 = null;
                bool havePiece = TrySnapshotPieceEnds(piece, f.Key, out pv0, out pv100)
                    && pv0 != null && pv0.Length > 0 && pv100 != null && pv100.Length == pv0.Length;
                // 身体与件统一 BakeMesh(useScale=true)，来源写清（供 verdict 判断空间是否一致）
                g.Set("geometry_source", "body=" + (bodySrc ?? "none")
                    + ";piece=" + (havePiece ? "bake" : "none"));

                // 件覆盖部位（用于筛身体顶点）—— 用件 0 端顶点
                HashSet<string> pieceCovers = null;
                if (havePiece && mapper != null)
                {
                    try
                    {
                        JsonObject prw, prvs; List<string> pcov; string[] pdom; string prs;
                        ComputeRegions(piece, mapper, pv0, out prw, out prvs, out pcov, out pdom, out prs);
                        if (pcov != null && pcov.Count > 0) pieceCovers = new HashSet<string>(pcov, StringComparer.Ordinal);
                    }
                    catch { pieceCovers = null; }
                }

                // 身体该键 0/100 两端：真的设权重各烘一次（读完还原），按 key 缓存复用
                BodyKeyGeom bg;
                if (!keyCache.TryGetValue(f.Key, out bg))
                {
                    bg = BuildBodyKeyGeom(body, bodyMesh, f.Key, bodyL2W);
                    keyCache[f.Key] = bg;
                }

                // 身体该键 0→100：覆盖区内身体顶点实际位移（由两端烘焙之差得到）
                if (bg != null && bg.HasKey && bg.Delta != null && bodyDom != null && pieceCovers != null)
                {
                    var mags = new List<float>();
                    int n = Mathf.Min(bodyDom.Length, bg.Delta.Length);
                    for (int i = 0; i < n; i++)
                    {
                        if (!pieceCovers.Contains(bodyDom[i])) continue;
                        mags.Add(bodyL2W.MultiplyVector(bg.Delta[i]).magnitude * 1000f);
                    }
                    if (mags.Count > 0)
                    {
                        g.Set("body_covered_verts", mags.Count);
                        g.Set("body_key_disp_mm", DistMm(mags));
                    }
                }

                // 件自身该键 0→100：件全部顶点实际位移（两端烘焙之差）
                Matrix4x4 pieceL2W = piece != null ? piece.transform.localToWorldMatrix : Matrix4x4.identity;
                if (havePiece)
                {
                    var mags = new List<float>(pv0.Length);
                    for (int i = 0; i < pv0.Length; i++)
                        mags.Add(pieceL2W.MultiplyVector(pv100[i] - pv0[i]).magnitude * 1000f);
                    g.Set("piece_key_disp_mm", DistMm(mags));
                }

                // 件 → 身体表面最近距离 p50（身体键 0 / 100 各一次，件同键同步取 0 / 100 端）。
                // 身体没有该键时 bg.Bvh100 回退 bg.Bvh0，仍给 verdict 一组可比数据（键不存在=几何不变）。
                if (havePiece && bg != null && bg.Bvh0 != null && bg.Bvh100 != null)
                {
                    var d0 = new List<float>();
                    var d100 = new List<float>();
                    int stride = Mathf.Max(1, pv0.Length / 20000);
                    for (int i = 0; i < pv0.Length; i += stride)
                    {
                        Vector3 q0 = pieceL2W.MultiplyPoint3x4(pv0[i]);
                        Vector3 q1 = pieceL2W.MultiplyPoint3x4(pv100[i]);
                        Vector3 cp; float d2; int feat;
                        if (bg.Bvh0.Nearest(q0, out cp, out d2, out feat) >= 0 && d2 < float.MaxValue)
                            d0.Add(Mathf.Sqrt(d2) * 1000f);
                        if (bg.Bvh100.Nearest(q1, out cp, out d2, out feat) >= 0 && d2 < float.MaxValue)
                            d100.Add(Mathf.Sqrt(d2) * 1000f);
                    }
                    if (d0.Count > 0 && d100.Count > 0)
                    {
                        var dist = new JsonObject();
                        dist.Set("at0", DistMm(d0));
                        dist.Set("at100", DistMm(d100));
                        double p0 = Pctl(d0, 50f), p1 = Pctl(d100, 50f);
                        dist.Set("p50_delta_mm", p1 - p0);
                        g.Set("body_piece_dist_mm", dist);
                    }
                }
                }
                catch (Exception e)
                {
                    var real = AuditUtil.Unwrap(e);
                    g.Set("available", false);
                    g.Set("note", "几何加权失败：" + real.Message);
                    warnings.Add("key_follow 几何加权：'" + f.Renderer + "' × '" + f.Key + "' 失败："
                        + real.Message);
                }
            }
        }

        sealed class BodyKeyGeom
        {
            public bool HasKey;
            public Vector3[] Delta;              // Verts100 - Verts0（身体局部空间，米）
            public AuditProbes.PokeBvh Bvh0;     // 身体键 0% 时的世界位置 BVH
            public AuditProbes.PokeBvh Bvh100;   // 身体键 100% 时的世界位置 BVH（无该键时 = Bvh0）
        }

        /// <summary>身体该键的「两端」几何（任务 AY 返工，B-补-07）：真的把该键 SetBlendShapeWeight 到
        /// 0 与 100 各 BakeMesh 一次（useScale=true，读完 finally 还原原权重），不是「当前权重 + 帧位移」。
        /// 身体没有该键或任一端失败时返回不可用；两端各自建立真实 BVH，不用当前快照冒充端点。
        /// 世界坐标 = 局部顶点 × bodyL2W。</summary>
        static BodyKeyGeom BuildBodyKeyGeom(SkinnedMeshRenderer body, Mesh bodyMesh, string key,
            Matrix4x4 bodyL2W)
        {
            var bg = new BodyKeyGeom();
            if (body == null || bodyMesh == null) return bg;

            int si = bodyMesh.GetBlendShapeIndex(key);
            if (si < 0) return bg;
            Vector3[] v0, v100; int[] t0, t100;
            if (!TrySnapshotAtWeight(body, key, 0f, out v0, out t0)
                || !TrySnapshotAtWeight(body, key, 100f, out v100, out t100)
                || v0 == null || v100 == null || v0.Length == 0 || v0.Length != v100.Length
                || t0 == null || t0.Length < 3 || t100 == null || t100.Length < 3)
                return bg;
            bg.HasKey = true;

            bg.Delta = new Vector3[v0.Length];
            for (int i = 0; i < v0.Length; i++) bg.Delta[i] = v100[i] - v0[i];

            var faces0 = new List<int>(t0.Length / 3);
            var faces100 = new List<int>(t100.Length / 3);
            for (int f = 0; f < t0.Length / 3; f++) faces0.Add(f);
            for (int f = 0; f < t100.Length / 3; f++) faces100.Add(f);

            var w0 = new Vector3[v0.Length];
            for (int i = 0; i < v0.Length; i++) w0[i] = bodyL2W.MultiplyPoint3x4(v0[i]);
            try { bg.Bvh0 = new AuditProbes.PokeBvh(w0, t0, faces0); }
            catch { bg.Bvh0 = null; }

            var w100 = new Vector3[v100.Length];
            for (int i = 0; i < v100.Length; i++) w100[i] = bodyL2W.MultiplyPoint3x4(v100[i]);
            try { bg.Bvh100 = new AuditProbes.PokeBvh(w100, t100, faces100); }
            catch { bg.Bvh100 = null; }
            return bg;
        }

        /// <summary>One regression-stage geometry reading. The garment remains at its actual current state;
        /// only the body's named key is baked at 0 and 100. Any endpoint or BVH failure is unavailable.</summary>
        public sealed class FollowGeometryReading
        {
            public bool Available;
            public string Note;
            public double P95DeltaMm;
            public int Samples;
        }

        /// <summary>Measure the current state of one same-name pair without synchronising the garment key.
        /// The body's original weight and all other state are restored by the endpoint snapshot helper.</summary>
        public static FollowGeometryReading MeasureFollowGeometry(SkinnedMeshRenderer body,
            SkinnedMeshRenderer piece, string key)
        {
            try
            {
                var result = new FollowGeometryReading();
                if (body == null || piece == null || string.IsNullOrEmpty(key)) { result.Note = "缺少身体、件或键"; return result; }
                if (body.sharedMesh == null || body.sharedMesh.GetBlendShapeIndex(key) < 0) { result.Note = "身体网格没有该键"; return result; }
                if (piece.sharedMesh == null || piece.sharedMesh.GetBlendShapeIndex(key) < 0) { result.Note = "件网格没有该键"; return result; }

                var bodyGeometry = BuildBodyKeyGeom(body, body.sharedMesh, key, body.transform.localToWorldMatrix);
                if (bodyGeometry == null || !bodyGeometry.HasKey || bodyGeometry.Bvh0 == null || bodyGeometry.Bvh100 == null)
                { result.Note = "身体键两端烘焙或 BVH 失败"; return result; }
                Vector3[] pv; int[] pt; string pieceSource;
                if (!TrySnapshot(piece, out pv, out pt, out pieceSource) || pv == null || pv.Length == 0)
                { result.Note = "件当前状态烘焙失败"; return result; }
                var d0 = new List<float>(); var d100 = new List<float>();
                var pieceL2W = piece.transform.localToWorldMatrix;
                int stride = Mathf.Max(1, pv.Length / 20000);
                for (int i = 0; i < pv.Length; i += stride)
                {
                    var q = pieceL2W.MultiplyPoint3x4(pv[i]); Vector3 cp; float d2; int feature;
                    if (bodyGeometry.Bvh0.Nearest(q, out cp, out d2, out feature) < 0 || d2 == float.MaxValue) continue;
                    float d0mm = Mathf.Sqrt(d2) * 1000f;
                    if (bodyGeometry.Bvh100.Nearest(q, out cp, out d2, out feature) < 0 || d2 == float.MaxValue) continue;
                    d0.Add(d0mm); d100.Add(Mathf.Sqrt(d2) * 1000f);
                }
                if (d0.Count == 0 || d100.Count == 0) { result.Note = "件顶点到身体的距离无有效样本"; return result; }
                result.Available = true; result.Samples = Mathf.Min(d0.Count, d100.Count);
                result.P95DeltaMm = Math.Abs((double)Pctl(d100, 95f) - Pctl(d0, 95f));
                return result;
            }
            catch (Exception e) { return new FollowGeometryReading { Note = "几何量距异常：" + AuditUtil.Unwrap(e).Message }; }
        }

        /// <summary>把一组已算成 mm 的数值写成 {p50,p95,max,count}。空列表返回 null。</summary>
        static JsonObject DistMm(List<float> vals)
        {
            if (vals == null || vals.Count == 0) return null;
            vals.Sort();
            var o = new JsonObject();
            o.Set("p50", (double)Pctl(vals, 50f));
            o.Set("p95", (double)Pctl(vals, 95f));
            o.Set("max", (double)vals[vals.Count - 1]);
            o.Set("count", vals.Count);
            return o;
        }

        /// <summary>线性插值分位（内部复制并升序，调用方不必预排序）。</summary>
        static float Pctl(List<float> vals, float p)
        {
            if (vals == null || vals.Count == 0) return float.NaN;
            if (vals.Count == 1) return vals[0];
            var sorted = new List<float>(vals);
            sorted.Sort();
            float rank = (sorted.Count - 1) * (p / 100f);
            int lo = (int)Math.Floor(rank);
            int hi = (int)Math.Ceiling(rank);
            if (lo < 0) lo = 0;
            if (hi >= sorted.Count) hi = sorted.Count - 1;
            if (lo == hi) return sorted[lo];
            float frac = rank - lo;
            return sorted[lo] * (1f - frac) + sorted[hi] * frac;
        }

        /// <summary>件上某键的写者：clip 曲线 path=件、键=它；MA BlendshapeSync 同物体绑定了它；
        /// MA ShapeChanger 目标是该件且写它。</summary>
        static void AddPieceWriters(Transform aroot, ShapeIndex index, SkinnedMeshRenderer smr,
            string piecePath, string pieceAnimPath, string key, List<ShapeWriter> into)
        {
            AddWritersFromIndex(index, piecePath, key, into);
            if (!PathEquals(pieceAnimPath, piecePath)) AddWritersFromIndex(index, pieceAnimPath, key, into);

            // 同物体上的 MA BlendshapeSync（Bindings[].LocalBlendshape，空则等于 Blendshape）
            MonoBehaviour[] mbs = smr.GetComponents<MonoBehaviour>();
            for (int i = 0; i < mbs.Length; i++)
            {
                MonoBehaviour mb = mbs[i];
                if (mb == null || mb.GetType().Name != "ModularAvatarBlendshapeSync") continue;
                var en = GetMember(mb, "Bindings") as IEnumerable;
                if (en == null) continue;
                foreach (object binding in en)
                {
                    if (binding == null) continue;
                    string local = GetMember(binding, "LocalBlendshape") as string;
                    string src = GetMember(binding, "Blendshape") as string;
                    string localShape = string.IsNullOrEmpty(local) ? src : local;
                    if (localShape != key) continue;
                    var w = new ShapeWriter();
                    w.Source = "blendshape_sync";
                    w.ComponentPath = piecePath;
                    w.SourceShape = src;
                    w.LocalShape = localShape;
                    w.ReferenceMesh = ResolveAvatarObjectRef(aroot, GetMember(binding, "ReferenceMesh"));
                    AddWriter(into, w);
                }
            }
        }

        /// <summary>把「件用 MA BlendshapeSync 声明过的身体源键」并进身体被写键。件从身体读这个键 =
        /// 这个键对跟随有意义；Rurune 身体的 `Breast_Big_____胸_大(mizuki)` 没有任何 clip 驱动，
        /// 修后场景里只有 5 件的 BlendshapeSync 把它声明为 Body_b 源，验收要求 (B)Cat 的固定值键仍
        /// 进候选，就靠这一条。只认 ReferenceMesh 指到身体、且身体网格确有此键的绑定。</summary>
        static void AddSyncSourceKeys(GameObject avatar, ShapeIndex index, HashSet<string> bodyPaths,
            SkinnedMeshRenderer body, List<string> warnings)
        {
            Mesh bodyMesh = body != null ? body.sharedMesh : null;
            if (bodyMesh == null) return;
            Transform aroot = avatar.transform;
            MonoBehaviour[] mbs = avatar.GetComponentsInChildren<MonoBehaviour>(true);
            for (int i = 0; i < mbs.Length; i++)
            {
                MonoBehaviour mb = mbs[i];
                if (mb == null || mb.GetType().Name != "ModularAvatarBlendshapeSync") continue;
                var en = GetMember(mb, "Bindings") as IEnumerable;
                if (en == null) continue;
                string piecePath = AuditUtil.RelPath(aroot, mb.transform);
                foreach (object binding in en)
                {
                    if (binding == null) continue;
                    string src = GetMember(binding, "Blendshape") as string;
                    if (string.IsNullOrEmpty(src)) continue;
                    if (bodyMesh.GetBlendShapeIndex(src) < 0) continue;
                    string refPath = ResolveAvatarObjectRef(aroot, GetMember(binding, "ReferenceMesh"));
                    if (string.IsNullOrEmpty(refPath) || !bodyPaths.Contains(Norm(refPath))) continue;
                    string local = GetMember(binding, "LocalBlendshape") as string;
                    var w = new ShapeWriter();
                    w.Source = "blendshape_sync";
                    w.ComponentPath = piecePath;
                    w.SourceShape = src;
                    w.LocalShape = string.IsNullOrEmpty(local) ? src : local;
                    w.ReferenceMesh = refPath;
                    index.Add(refPath, src, w);
                }
            }
        }

        static void AddWritersFromIndex(ShapeIndex index, string path, string key, List<ShapeWriter> into)
        {
            List<ShapeWriter> writers;
            if (!index.TryGet(path, key, out writers)) return;
            for (int i = 0; i < writers.Count; i++) AddWriter(into, writers[i]);
        }

        static void AddWriter(List<ShapeWriter> list, ShapeWriter w)
        {
            for (int i = 0; i < list.Count; i++) if (WriterEquals(list[i], w)) return;
            list.Add(w);
        }

        static bool WriterEquals(ShapeWriter a, ShapeWriter b)
        {
            return a.Source == b.Source
                && a.Path == b.Path && a.Key == b.Key
                && a.Clip == b.Clip && a.ClipPath == b.ClipPath
                && a.Controller == b.Controller && a.ControllerPath == b.ControllerPath
                && a.ComponentPath == b.ComponentPath && a.ChangeType == b.ChangeType && a.Value == b.Value
                && a.ReferenceMesh == b.ReferenceMesh && a.SourceShape == b.SourceShape && a.LocalShape == b.LocalShape;
        }

        static JsonObject WriterToObj(ShapeWriter w)
        {
            var o = new JsonObject();
            o.Set("source", w.Source);
            if (w.Source == "clip")
            {
                o.Set("path", w.Path);
                o.Set("key", w.Key);
                o.Set("clip", w.Clip);
                o.Set("clip_path", w.ClipPath);
                o.Set("controller", w.Controller);
                o.Set("controller_path", w.ControllerPath);
            }
            else if (w.Source == "shape_changer")
            {
                o.Set("component_path", w.ComponentPath);
                o.Set("change_type", w.ChangeType);
                o.Set("value", w.Value);
            }
            else if (w.Source == "blendshape_sync")
            {
                o.Set("component_path", w.ComponentPath);
                o.Set("reference_mesh", w.ReferenceMesh);
                o.Set("source_shape", w.SourceShape);
                o.Set("local_shape", w.LocalShape);
            }
            return o;
        }

        static List<object> WritersToObj(List<ShapeWriter> list)
        {
            var arr = new List<object>(list != null ? list.Count : 0);
            if (list == null) return arr;
            for (int i = 0; i < list.Count; i++) arr.Add(WriterToObj(list[i]));
            return arr;
        }

        static JsonObject FollowToObj(ShapeFollow f)
        {
            var o = new JsonObject();
            o.Set("renderer", f.Renderer);
            o.Set("key", f.Key);
            o.Set("piece_current_weight", f.Weight);
            o.Set("body_writers", WritersToObj(f.BodyWriters));
            o.Set("piece_writers", WritersToObj(f.PieceWriters));
            if (f.Geom != null) o.Set("geom", f.Geom);
            return o;
        }

        static List<object> FollowsToObj(List<ShapeFollow> list)
        {
            var arr = new List<object>(list.Count);
            for (int i = 0; i < list.Count; i++) arr.Add(FollowToObj(list[i]));
            return arr;
        }

        static int CompareFollow(ShapeFollow a, ShapeFollow b)
        {
            int c = string.CompareOrdinal(a.Renderer, b.Renderer);
            if (c != 0) return c;
            return string.CompareOrdinal(a.Key, b.Key);
        }

        static readonly string[] BustKeyTokens = { "breast", "chest", "胸", "bust" };
        static readonly string[] FootKeyTokens = { "foot", "heel", "toe", "足", "ヒール" };

        static bool ContainsKeyToken(string[] tokens, string key)
        {
            if (string.IsNullOrEmpty(key)) return false;
            for (int i = 0; i < tokens.Length; i++)
                if (key.IndexOf(tokens[i], StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        static string ClassifyKey(string key)
        {
            if (ContainsKeyToken(BustKeyTokens, key)) return "bust";
            if (ContainsKeyToken(FootKeyTokens, key)) return "foot";
            return "other";
        }

        static JsonObject ClassifyCandidates(List<ShapeFollow> candidates)
        {
            var bust = new List<object>();
            var foot = new List<object>();
            var other = new List<object>();
            for (int i = 0; i < candidates.Count; i++)
            {
                ShapeFollow f = candidates[i];
                if (ClassifyKey(f.Key) == "bust") bust.Add(FollowToObj(f));
                else if (ClassifyKey(f.Key) == "foot") foot.Add(FollowToObj(f));
                else other.Add(FollowToObj(f));
            }
            var res = new JsonObject();
            res.Set("bust", bust);
            res.Set("foot", foot);
            res.Set("other", other);
            return res;
        }

        static JsonObject EmptyKeyClasses()
        {
            var res = new JsonObject();
            res.Set("bust", new List<object>());
            res.Set("foot", new List<object>());
            res.Set("other", new List<object>());
            return res;
        }

        /// <summary>某条「写形态键」记录的来源（clip / MA ShapeChanger / MA BlendshapeSync）。</summary>
        sealed class ShapeWriter
        {
            public string Source;
            public string Path;
            public string Key;
            public string Clip;
            public string ClipPath;
            public string Controller;
            public string ControllerPath;
            public string ComponentPath;
            public string ChangeType;
            public double Value;
            public string ReferenceMesh;
            public string SourceShape;
            public string LocalShape;
        }

        /// <summary>avatar 根相对路径 → 键名 → 写者列表。路径只在 Add 时补，不覆盖。</summary>
        sealed class ShapeIndex
        {
            public readonly Dictionary<string, Dictionary<string, List<ShapeWriter>>> Map =
                new Dictionary<string, Dictionary<string, List<ShapeWriter>>>(StringComparer.Ordinal);

            public void Add(string path, string key, ShapeWriter w)
            {
                if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(key)) return;
                if (w.Path == null) w.Path = path;
                if (w.Key == null) w.Key = key;
                Dictionary<string, List<ShapeWriter>> byKey;
                if (!Map.TryGetValue(path, out byKey))
                {
                    byKey = new Dictionary<string, List<ShapeWriter>>(StringComparer.Ordinal);
                    Map[path] = byKey;
                }
                List<ShapeWriter> list;
                if (!byKey.TryGetValue(key, out list))
                {
                    list = new List<ShapeWriter>();
                    byKey[key] = list;
                }
                for (int i = 0; i < list.Count; i++) if (WriterEquals(list[i], w)) return;
                list.Add(w);
            }

            public bool TryGet(string path, string key, out List<ShapeWriter> writers)
            {
                writers = null;
                if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(key)) return false;
                Dictionary<string, List<ShapeWriter>> byKey;
                if (!Map.TryGetValue(path, out byKey)) return false;
                if (!byKey.TryGetValue(key, out writers)) return false;
                return writers != null && writers.Count > 0;
            }
        }

        /// <summary>一条「件键 ∩ 身体被写键」记录。</summary>
        sealed class ShapeFollow
        {
            public string Renderer;
            public string Key;
            public double Weight;
            public List<ShapeWriter> BodyWriters;
            public List<ShapeWriter> PieceWriters;
            /// <summary>几何加权用；指向该件的 SMR（任务 AY）。</summary>
            public SkinnedMeshRenderer Smr;
            /// <summary>几何加权数据（只有 candidates 会填；任务 AY）。</summary>
            public JsonObject Geom;
        }

        // ─────────────────────────────────────────────────────────────
        // 部位权重
        // ─────────────────────────────────────────────────────────────

        static void ComputeRegions(SkinnedMeshRenderer smr, RegionMapper mapper, Vector3[] snapshot,
            out JsonObject regionWeights, out JsonObject regionVertexShare, out List<string> covers,
            out string[] domRegion, out string source)
        {
            regionWeights = new JsonObject();
            regionVertexShare = new JsonObject();
            covers = new List<string>();
            source = "none";
            domRegion = null;

            Mesh mesh = smr.sharedMesh;
            if (mesh == null) { source = "no_mesh"; return; }
            int vc = mesh.vertexCount;
            if (vc <= 0) { source = "no_vertices"; return; }

            Transform[] bones = smr.bones;
            string[] boneRegion = new string[bones != null ? bones.Length : 0];
            for (int b = 0; b < boneRegion.Length; b++)
                boneRegion[b] = mapper.RegionOf(bones[b]);

            var wSum = new Dictionary<string, double>(StringComparer.Ordinal);
            var vCnt = new Dictionary<string, int>(StringComparer.Ordinal);
            domRegion = new string[vc];
            bool got = false;

            // 1) 新 API：每顶点骨骼数 + 扁平权重（顶点内已按权重降序）
            try
            {
                NativeArray<byte> bpv = mesh.GetBonesPerVertex();
                if (bpv.Length == vc)
                {
                    NativeArray<BoneWeight1> bw = mesh.GetAllBoneWeights();
                    if (bw.Length > 0)
                    {
                        int k = 0;
                        for (int i = 0; i < vc; i++)
                        {
                            int c = bpv[i];
                            string best = null; float bestW = -1f;
                            for (int j = 0; j < c; j++)
                            {
                                if (k >= bw.Length) break;
                                BoneWeight1 w = bw[k++];
                                if (w.weight <= 0f) continue;
                                string reg = (w.boneIndex >= 0 && w.boneIndex < boneRegion.Length)
                                    ? boneRegion[w.boneIndex] : "unknown";
                                AddW(wSum, reg, w.weight);
                                if (w.weight > bestW) { bestW = w.weight; best = reg; }
                            }
                            domRegion[i] = best;
                            if (best != null) AddI(vCnt, best);
                        }
                        source = "bone_weights";
                        got = true;
                    }
                }
            }
            catch { /* 网格未开 Read/Write 时会抛，走下一档 */ }

            // 2) legacy Mesh.boneWeights
            if (!got)
            {
                try
                {
                    BoneWeight[] bw = mesh.boneWeights;
                    if (bw != null && bw.Length == vc)
                    {
                        for (int i = 0; i < vc; i++)
                        {
                            BoneWeight w = bw[i];
                            string best = null; float bestW = -1f;
                            Acc(w.boneIndex0, w.weight0, boneRegion, wSum, ref best, ref bestW);
                            Acc(w.boneIndex1, w.weight1, boneRegion, wSum, ref best, ref bestW);
                            Acc(w.boneIndex2, w.weight2, boneRegion, wSum, ref best, ref bestW);
                            Acc(w.boneIndex3, w.weight3, boneRegion, wSum, ref best, ref bestW);
                            if (best != null) AddI(vCnt, best);
                        }
                        source = "bone_weights_legacy";
                        got = true;
                    }
                }
                catch { }
            }

            // 3) 最近骨骼近似（网格不可读时的兜底；宁可粗也不要空）
            if (!got && snapshot != null && snapshot.Length == vc)
            {
                int[] nearest = NearestBones(smr, bones, snapshot, vc);
                for (int i = 0; i < vc; i++)
                {
                    int bi = nearest[i];
                    string reg = (bi >= 0 && bi < boneRegion.Length) ? boneRegion[bi] : "unknown";
                    domRegion[i] = reg;
                    AddW(wSum, reg, 1.0);
                    AddI(vCnt, reg);
                }
                source = "nearest_bone";
                got = true;
            }

            if (!got)
            {
                source = "unreadable_weights";
                return;
            }

            NormalizeRegions(wSum, vCnt, regionWeights, regionVertexShare, covers);
        }

        /// <summary>把部位权重和 / 逐顶点主部位计数归一化写进输出；covers = 顶点占比 ≥ RegionMinShare。
        /// `ComputeRegions`（SMR 蒙皮权重）与 `ComputeRegionsNearest`（MR 最近骨骼）共用，保证口径一致。</summary>
        static void NormalizeRegions(Dictionary<string, double> wSum, Dictionary<string, int> vCnt,
            JsonObject regionWeights, JsonObject regionVertexShare, List<string> covers)
        {
            double totalW = 0; foreach (var kv in wSum) totalW += kv.Value;
            int totalV = 0; foreach (var kv in vCnt) totalV += kv.Value;
            var wr = new List<KeyValuePair<string, double>>(wSum);
            wr.Sort((a, b) => b.Value.CompareTo(a.Value));
            for (int i = 0; i < wr.Count; i++)
                regionWeights.Set(wr[i].Key, totalW > 0 ? wr[i].Value / totalW : 0.0);

            var vr = new List<KeyValuePair<string, int>>(vCnt);
            vr.Sort((a, b) => b.Value.CompareTo(a.Value));
            for (int i = 0; i < vr.Count; i++)
            {
                double share = totalV > 0 ? (double)vr[i].Value / totalV : 0.0;
                regionVertexShare.Set(vr[i].Key, share);
                if (share >= RegionMinShare) covers.Add(vr[i].Key);
            }
        }

        /// <summary>MR 部位近似（任务 AQ）：无蒙皮权重，把 MeshFilter 网格顶点变换到世界后
        /// 找最近骨骼、取其部位。有顶点 → `nearest_bone`（每个顶点投一票，口径是顶点占比）；
        /// 网格不可读 → 退到物体位置单点 → `nearest_bone_object`（单部位满占比，粗但非空）。
        /// 两条都不是蒙皮权重，调用方看 `region_source` 区分。</summary>
        static void ComputeRegionsNearest(Transform self, Vector3[] snapshot, Transform[] bones,
            RegionMapper mapper, out JsonObject regionWeights, out JsonObject regionVertexShare,
            out List<string> covers, out string[] domRegion, out string source)
        {
            regionWeights = new JsonObject();
            regionVertexShare = new JsonObject();
            covers = new List<string>();
            domRegion = null;
            source = "none";
            if (self == null) { source = "no_transform"; return; }
            if (bones == null || bones.Length == 0) { source = "no_bones"; return; }

            var wSum = new Dictionary<string, double>(StringComparer.Ordinal);
            var vCnt = new Dictionary<string, int>(StringComparer.Ordinal);
            int vc = snapshot != null ? snapshot.Length : 0;

            if (vc > 0)
            {
                Matrix4x4 l2w = self.localToWorldMatrix;
                domRegion = new string[vc];
                for (int i = 0; i < vc; i++)
                {
                    Vector3 wp = l2w.MultiplyPoint3x4(snapshot[i]);
                    string reg = mapper.RegionOf(NearestBone(bones, wp));
                    domRegion[i] = reg;
                    AddW(wSum, reg, 1.0);
                    AddI(vCnt, reg);
                }
                source = "nearest_bone";
            }
            else
            {
                string reg = mapper.RegionOf(NearestBone(bones, self.position));
                domRegion = new string[] { reg };
                AddW(wSum, reg, 1.0);
                AddI(vCnt, reg);
                source = "nearest_bone_object";
            }

            NormalizeRegions(wSum, vCnt, regionWeights, regionVertexShare, covers);
        }

        /// <summary>世界坐标点到骨骼集里最近的一根；全空返回 null（RegionOf(null)="unknown"）。</summary>
        static Transform NearestBone(Transform[] bones, Vector3 worldPos)
        {
            if (bones == null || bones.Length == 0) return null;
            Transform best = null; float bestD = float.MaxValue;
            for (int b = 0; b < bones.Length; b++)
            {
                Transform t = bones[b];
                if (t == null) continue;
                float d = (t.position - worldPos).sqrMagnitude;
                if (d < bestD) { bestD = d; best = t; }
            }
            return best;
        }

        /// <summary>MR 最近骨骼的候选集：优先人形骨骼全集（RegionMapper 收录的 HumanBodyBones，
        /// 语义上就是身体部位），退化到身体 SMR 的骨骼，再退化到全部 SMR 的骨骼。按实例去重。</summary>
        static Transform[] BuildBoneCloud(SkinnedMeshRenderer body, List<SkinnedMeshRenderer> smrs, RegionMapper mapper)
        {
            var list = new List<Transform>();
            var seen = new HashSet<int>();
            List<Transform> human = mapper.HumanoidBones;
            for (int i = 0; i < human.Count; i++) AddBone(list, seen, human[i]);
            if (list.Count > 0) return list.ToArray();

            if (body != null && body.bones != null)
                for (int i = 0; i < body.bones.Length; i++) AddBone(list, seen, body.bones[i]);
            if (list.Count > 0) return list.ToArray();

            for (int i = 0; i < smrs.Count; i++)
            {
                Transform[] bs = smrs[i] != null ? smrs[i].bones : null;
                if (bs == null) continue;
                for (int b = 0; b < bs.Length; b++) AddBone(list, seen, bs[b]);
            }
            return list.ToArray();
        }

        static void AddBone(List<Transform> list, HashSet<int> seen, Transform t)
        {
            if (t == null) return;
            if (seen.Add(t.GetInstanceID())) list.Add(t);
        }

        /// <summary>身体网格全部形态键名，顺序同网格（不做排序/去重；blendShapeIndex 即下标）。
        /// body 为 null 或网格为空返回空列表，不猜。</summary>
        static List<object> BodyKeyList(SkinnedMeshRenderer body)
        {
            var list = new List<object>();
            Mesh mesh = body != null ? body.sharedMesh : null;
            if (mesh == null) return list;
            for (int k = 0; k < mesh.blendShapeCount; k++)
                list.Add(mesh.GetBlendShapeName(k));
            return list;
        }

        /// <summary>名字或任一祖先名（含到 avatar 根为止）含排除子串 → 不像可交付部件。
        /// 只查名字、大小写不敏感；`PartLikeExcludeTokens` 可配置。</summary>
        static bool IsPartLike(Transform aroot, Transform t)
        {
            for (Transform cur = t; cur != null; cur = cur.parent)
            {
                string n = cur.name;
                if (!string.IsNullOrEmpty(n))
                {
                    for (int i = 0; i < PartLikeExcludeTokens.Length; i++)
                        if (n.IndexOf(PartLikeExcludeTokens[i], StringComparison.OrdinalIgnoreCase) >= 0)
                            return false;
                }
                if (cur == aroot) break;
            }
            return true;
        }

        /// <summary>MeshRenderer 几何快照：只能读 sharedMesh（无蒙皮可 Bake）；未开 Read/Write
        /// 返回 false，由调用方标 `unavailable` 并退 `nearest_bone_object`。</summary>
        static bool TrySnapshotMesh(Mesh mesh, out Vector3[] verts, out int[] tris, out string source)
        {
            verts = null; tris = null; source = "none";
            if (mesh == null) return false;
            if (mesh.isReadable)
            {
                try
                {
                    Vector3[] v = mesh.vertices;
                    int[] t = mesh.triangles;
                    if (v != null && v.Length > 0 && t != null && t.Length > 0)
                    {
                        verts = v; tris = t; source = "shared_mesh";
                        return true;
                    }
                }
                catch { }
            }
            return false;
        }

        static void Acc(int bi, float weight, string[] boneRegion,
            Dictionary<string, double> wSum, ref string best, ref float bestW)
        {
            if (weight <= 0f) return;
            string reg = (bi >= 0 && bi < boneRegion.Length) ? boneRegion[bi] : "unknown";
            AddW(wSum, reg, weight);
            if (weight > bestW) { bestW = weight; best = reg; }
        }

        /// <summary>最近骨骼：顶点是 SMR 局部坐标（sharedMesh/BakeMesh），骨骼 position 是世界坐标，
        /// 先用 worldToLocalMatrix 换到同一空间再比，否则头像不在原点时全错。</summary>
        static int[] NearestBones(SkinnedMeshRenderer smr, Transform[] bones, Vector3[] pos, int n)
        {
            var res = new int[n];
            if (bones == null || bones.Length == 0) { for (int i = 0; i < n; i++) res[i] = -1; return res; }
            Matrix4x4 w2l = smr.transform.worldToLocalMatrix;
            var bp = new Vector3[bones.Length];
            var ok = new bool[bones.Length];
            for (int b = 0; b < bones.Length; b++)
            {
                ok[b] = bones[b] != null;
                if (ok[b]) bp[b] = w2l.MultiplyPoint3x4(bones[b].position);
            }
            for (int i = 0; i < n; i++)
            {
                int best = -1; float bestD = float.MaxValue;
                for (int b = 0; b < bones.Length; b++)
                {
                    if (!ok[b]) continue;
                    float d = (bp[b] - pos[i]).sqrMagnitude;
                    if (d < bestD) { bestD = d; best = b; }
                }
                res[i] = best;
            }
            return res;
        }

        static void AddW(Dictionary<string, double> d, string k, double v)
        {
            double cur; d.TryGetValue(k, out cur); d[k] = cur + v;
        }

        static void AddI(Dictionary<string, int> d, string k)
        {
            int cur; d.TryGetValue(k, out cur); d[k] = cur + 1;
        }

        static string PickDominant(JsonObject shareByRegionVerts)
        {
            string best = null; double bestV = -1;
            foreach (var kv in shareByRegionVerts.Items)
            {
                double v = AuditJson.Num(shareByRegionVerts, kv.Key, 0);
                if (v > bestV) { bestV = v; best = kv.Key; }
            }
            return best;
        }

        // ─────────────────────────────────────────────────────────────
        // 几何：快照 / 边界边 / 鞋底
        // ─────────────────────────────────────────────────────────────

        /// <summary>取网格快照（顶点局部坐标 + 三角形）。**身体与件统一用 `BakeMesh(m, true)`**（B-补-07/AY 返工）：
        /// 之前网格可读时直接读 `sharedMesh`（bind pose、不带当前形态键权重），不可读才 BakeMesh，
        /// 于是身体和件可能各走一条、空间/蒙皮口径不一致，几何加权与实测比不了。现在一律 BakeMesh：
        /// 带当前形态键权重与当前姿势，身体/件同口径；读完立刻 `DestroyImmediate` 临时网格（还原），
        /// 不动渲染器上的权重。`useScale=true` 让 Unity 补偿 SMR 自身缩放（烘焙网格=原始尺寸），
        /// 所以再乘完整 `localToWorldMatrix` 正好得到世界坐标、不会二次缩放（同 AuditFitProbe.cs:685、
        /// AuditProbes.cs:1642）。`source` 固定写 `bake`（写进 inventory 的 `geometry_source`）。
        /// **待 Unity 首跑核对**：Unity 2022.3 脚本文档对 `useScale` 的措辞是「是否使用 Transform 的
        /// scale」，与上句「补偿掉」字面相反；已按验收要求统一为 `(m, true)` + 完整矩阵，世界坐标是否
        /// 二次缩放由验收「需要在 Unity 里验收的步骤」1 用 `lossyScale != 1` 的件实测裁定。</summary>
        static bool TrySnapshot(SkinnedMeshRenderer smr, out Vector3[] verts, out int[] tris, out string source)
        {
            verts = null; tris = null; source = "none";
            if (smr == null || smr.sharedMesh == null) return false;

            var scratch = new Mesh();
            scratch.indexFormat = IndexFormat.UInt32;   // 身体常 >65535 顶点
            scratch.hideFlags = HideFlags.HideAndDontSave;
            try
            {
                smr.BakeMesh(scratch, true);
                Vector3[] v = scratch.vertices;
                int[] t = scratch.triangles;
                if (v != null && v.Length > 0 && t != null && t.Length > 0)
                {
                    verts = v; tris = t; source = "bake";
                    return true;
                }
            }
            catch { /* 某些 SMR（无骨骼/未激活）BakeMesh 会抛，放弃几何 */ }
            finally
            {
                Object.DestroyImmediate(scratch);
            }
            return false;
        }

        /// <summary>把某 SMR 的某个形态键临时设为 `weight` 后 `BakeMesh(m, true)`，返回局部空间顶点/三角面；
        /// **无论成败都在 finally 里把权重还原成原值**（B-补-07/AY 返工：键两端要真的各烘一次）。
        /// 该 SMR 没有这个键时返回 false，由调用方决定退路。</summary>
        static bool TrySnapshotAtWeight(SkinnedMeshRenderer smr, string key, float weight,
            out Vector3[] verts, out int[] tris)
        {
            verts = null; tris = null;
            if (smr == null || smr.sharedMesh == null) return false;
            Mesh m = smr.sharedMesh;
            int idx = string.IsNullOrEmpty(key) ? -1 : m.GetBlendShapeIndex(key);
            if (idx < 0) return false;

            float orig = smr.GetBlendShapeWeight(idx);
            var scratch = new Mesh();
            scratch.indexFormat = IndexFormat.UInt32;
            scratch.hideFlags = HideFlags.HideAndDontSave;
            try
            {
                smr.SetBlendShapeWeight(idx, weight);
                smr.BakeMesh(scratch, true);
                Vector3[] v = scratch.vertices;
                int[] t = scratch.triangles;
                if (v != null && v.Length > 0 && t != null && t.Length > 0)
                {
                    verts = v; tris = t;
                    return true;
                }
            }
            catch { /* 无骨骼/未激活等：放弃这一端 */ }
            finally
            {
                try { smr.SetBlendShapeWeight(idx, orig); } catch { }
                Object.DestroyImmediate(scratch);
            }
            return false;
        }

        /// <summary>件的「键两端」快照：件有同名键时设 0 与 100 各烘一次（各自读完还原），没有该键时
        /// 两端都取当前快照（键不存在=两端天然等价）。供 key_follow 几何加权按同一口径读件。</summary>
        static bool TrySnapshotPieceEnds(SkinnedMeshRenderer piece, string key,
            out Vector3[] v0, out Vector3[] v100)
        {
            v0 = null; v100 = null;
            if (piece == null || piece.sharedMesh == null) return false;
            if (piece.sharedMesh.GetBlendShapeIndex(key) >= 0)
            {
                Vector3[] a, b; int[] ta, tb;
                if (!TrySnapshotAtWeight(piece, key, 0f, out a, out ta)) return false;
                if (!TrySnapshotAtWeight(piece, key, 100f, out b, out tb)) return false;
                if (a == null || b == null || a.Length != b.Length) return false;
                v0 = a; v100 = b;
                return true;
            }
            Vector3[] c; int[] tc; string src;
            if (!TrySnapshot(piece, out c, out tc, out src)) return false;
            if (c == null || c.Length == 0) return false;
            v0 = c; v100 = c;
            return true;
        }

        static void ComputeBoundary(Vector3[] verts, int[] tris, out int boundaryEdges, out int edgeCount)
        {
            boundaryEdges = 0; edgeCount = 0;
            if (verts == null || tris == null || tris.Length < 3) return;

            // 位置焊接：按 eps 网格分桶，再查本格 + 26 邻格，距离 ≤ eps 才合并。
            // 只按「四舍五入到格子」合并会在接缝顶点恰好跨格线时漏焊（浮点误差），
            // 邻格搜索把这种边界情况补上，避免整条 UV 缝被当成边界边。
            int n = verts.Length;
            var canon = new int[n];
            var cells = new Dictionary<Vector3Int, List<int>>(n);
            var rep = new List<Vector3>(n);
            float eps2 = WeldEpsilonM * WeldEpsilonM;
            for (int i = 0; i < n; i++)
            {
                Vector3 v = verts[i];
                Vector3Int cell = CellOf(v);
                int found = -1;
                for (int dx = -1; dx <= 1 && found < 0; dx++)
                    for (int dy = -1; dy <= 1 && found < 0; dy++)
                        for (int dz = -1; dz <= 1 && found < 0; dz++)
                        {
                            List<int> lst;
                            if (!cells.TryGetValue(new Vector3Int(cell.x + dx, cell.y + dy, cell.z + dz), out lst)) continue;
                            for (int k = 0; k < lst.Count; k++)
                            {
                                int id = lst[k];
                                if ((rep[id] - v).sqrMagnitude <= eps2) { found = id; break; }
                            }
                        }
                if (found < 0)
                {
                    found = rep.Count;
                    rep.Add(v);
                    List<int> lst;
                    if (!cells.TryGetValue(cell, out lst)) { lst = new List<int>(); cells[cell] = lst; }
                    lst.Add(found);
                }
                canon[i] = found;
            }

            var edges = new Dictionary<long, int>(tris.Length);
            for (int t = 0; t + 2 < tris.Length; t += 3)
            {
                AddEdge(edges, canon[tris[t]], canon[tris[t + 1]]);
                AddEdge(edges, canon[tris[t + 1]], canon[tris[t + 2]]);
                AddEdge(edges, canon[tris[t + 2]], canon[tris[t]]);
            }
            edgeCount = edges.Count;
            foreach (var kv in edges) if (kv.Value == 1) boundaryEdges++;
        }

        static Vector3Int CellOf(Vector3 v)
        {
            return new Vector3Int(
                Mathf.FloorToInt(v.x / WeldEpsilonM),
                Mathf.FloorToInt(v.y / WeldEpsilonM),
                Mathf.FloorToInt(v.z / WeldEpsilonM));
        }

        static void AddEdge(Dictionary<long, int> edges, int a, int b)
        {
            if (a == b) return;
            int lo = a < b ? a : b, hi = a < b ? b : a;
            long key = ((long)lo << 32) | (uint)hi;
            int cur; edges.TryGetValue(key, out cur); edges[key] = cur + 1;
        }

        /// <summary>找身体 SMR。判据已抽到 <see cref="AuditBodyPick.FindBodySmr"/>，T-05 / T-10 poke /
        /// T2 body=auto 三处共用（任务 AY）。名字候选过蒙皮权重关（脚+躯干覆盖）再取顶点最多；
        /// 都不满足退几何启发。只按名字+顶点数会把 Kipfel 脸网格 `Body` 当身体（AM 教训 1）。</summary>
        static SkinnedMeshRenderer FindBodySmr(List<SkinnedMeshRenderer> smrs, RegionMapper mapper)
        {
            return AuditBodyPick.FindBodySmr(smrs, mapper.RegionOf);
        }

        /// <summary>Shared body selection for regression probes. Callers pass all candidate SMRs after
        /// excluding every clothing root; an empty/ambiguous result stays null instead of guessing.
        /// <paramref name="knownBodyNames"/> is the harness's identity for the base body (the plan's
        /// `body_prefab` renderers, see <see cref="BodyIdentity"/>): with it the pick no longer depends on
        /// whether the optimizer happened to flatten the outfit layer, and a base body split into several
        /// meshes resolves to the part that carries the torso. Without it the old name/weight criterion
        /// applies, which some base bodies (no mesh whose weights cover foot and torso) cannot satisfy.</summary>
        public static SkinnedMeshRenderer FindBodyForRegression(GameObject avatar,
            IList<SkinnedMeshRenderer> candidates, IList<string> knownBodyNames = null)
        {
            if (avatar == null || candidates == null) return null;
            var anim = avatar.GetComponent<Animator>() ?? avatar.GetComponentInChildren<Animator>(true);
            var mapper = new RegionMapper(avatar.transform, anim);
            if (knownBodyNames != null && knownBodyNames.Count > 0)
            {
                var parts = AuditBodyPick.SelectBodyParts(candidates, knownBodyNames);
                if (parts.Count > 0) return AuditBodyPick.PrimaryBodyPart(parts, mapper.RegionOf) ?? parts[0];
            }
            return AuditBodyPick.FindBodySmr(candidates, mapper.RegionOf);
        }

        /// <summary>The harness's identity for the base body, read from the plan's body prefab: the renderers
        /// whose name normalises to the body family root (`Body`, `Body_base`, …). Public because the harness
        /// stages live in another assembly and must hand the same identity to
        /// <see cref="FindBodyForRegression"/>. Empty when the path, the asset or such a renderer is absent —
        /// the caller then falls back to the name/weight criterion instead of guessing.</summary>
        public static List<string> BodyIdentity(string bodyPrefabAssetPath)
        {
            if (string.IsNullOrEmpty(bodyPrefabAssetPath)) return new List<string>();
            GameObject prefab = null;
            try { prefab = AssetDatabase.LoadAssetAtPath<GameObject>(bodyPrefabAssetPath); }
            catch { /* the path is not an asset in this project; the callers fall back */ }
            return AuditBodyPick.BodyMeshNames(prefab);
        }

        /// <summary>身体脚底最低世界 Y（主骨骼属于脚部部位的顶点；局部坐标 × localToWorldMatrix）。</summary>
        static bool TryFootMinWorldY(SkinnedMeshRenderer smr, RegionMapper mapper, out float minY)
        {
            minY = 0f;
            if (smr == null) return false;
            Vector3[] verts; int[] tris; string src;
            if (!TrySnapshot(smr, out verts, out tris, out src)) return false;
            string[] dom; JsonObject rw, rvs; List<string> covers; string regionSrc;
            ComputeRegions(smr, mapper, verts, out rw, out rvs, out covers, out dom, out regionSrc);
            return TryFootMinWorldY(smr, verts, dom, out minY);
        }

        /// <summary>给定网格快照与逐顶点主部位，取脚部顶点最低世界 Y；没有脚部顶点返回 false。</summary>
        static bool TryFootMinWorldY(SkinnedMeshRenderer smr, Vector3[] verts, string[] domRegion, out float minY)
        {
            return TryFootMinWorldY(smr != null ? smr.transform : null, verts, domRegion, out minY);
        }

        /// <summary>同上，但对任意 Transform（MR 的 sole 启发用；局部顶点 × localToWorldMatrix）。</summary>
        static bool TryFootMinWorldY(Transform t, Vector3[] verts, string[] domRegion, out float minY)
        {
            minY = 0f;
            if (t == null || verts == null || domRegion == null || verts.Length == 0) return false;
            Matrix4x4 l2w = t.localToWorldMatrix;
            bool any = false; float best = float.MaxValue;
            int n = Mathf.Min(verts.Length, domRegion.Length);
            for (int i = 0; i < n; i++)
            {
                if (!Contains(FootRegionNames, domRegion[i])) continue;
                float y = l2w.MultiplyPoint3x4(verts[i]).y;
                if (y < best) best = y;
                any = true;
            }
            if (!any) return false;
            minY = best;
            return true;
        }

        // ─────────────────────────────────────────────────────────────
        // 路径 / 排序 / 小工具
        // ─────────────────────────────────────────────────────────────

        static bool PathEquals(string a, string b)
        {
            return Norm(a) == Norm(b);
        }

        static string Norm(string p)
        {
            return string.IsNullOrEmpty(p) ? "." : p;
        }

        static bool IsAncestorPath(string ancestor, string path)
        {
            string a = Norm(ancestor);
            string p = Norm(path);
            if (a == ".") return p != ".";
            return p.Length > a.Length && p.StartsWith(a + "/", StringComparison.Ordinal);
        }

        static void AddSource(List<Driver> list, Driver d)
        {
            for (int i = 0; i < list.Count; i++)
            {
                Driver x = list[i];
                if (x.Property == d.Property && x.Path == d.Path && x.ClipPath == d.ClipPath && x.Controller == d.Controller) return;
            }
            list.Add(d);
        }

        static int CompareDriver(Driver a, Driver b)
        {
            int c = string.CompareOrdinal(a.ClipPath, b.ClipPath); if (c != 0) return c;
            c = string.CompareOrdinal(a.Clip, b.Clip); if (c != 0) return c;
            c = string.CompareOrdinal(a.Property, b.Property); if (c != 0) return c;
            c = string.CompareOrdinal(a.Path, b.Path); if (c != 0) return c;
            return string.CompareOrdinal(a.Controller, b.Controller);
        }

        static List<object> DriversToObj(List<Driver> list)
        {
            var arr = new List<object>(list.Count);
            for (int i = 0; i < list.Count; i++)
            {
                Driver d = list[i];
                var o = new JsonObject();
                o.Set("property", d.Property);
                o.Set("path", d.Path);
                o.Set("clip", d.Clip);
                o.Set("clip_path", d.ClipPath);
                o.Set("controller", d.Controller);
                o.Set("controller_path", d.ControllerPath);
                arr.Add(o);
            }
            return arr;
        }

        static List<object> ToObjList(List<string> list)
        {
            var arr = new List<object>(list.Count);
            for (int i = 0; i < list.Count; i++) arr.Add(list[i]);
            return arr;
        }

        static bool Contains(string[] arr, string v)
        {
            if (string.IsNullOrEmpty(v)) return false;
            for (int i = 0; i < arr.Length; i++) if (arr[i] == v) return true;
            return false;
        }

        static void AddUnique(List<string> list, string v)
        {
            if (string.IsNullOrEmpty(v)) return;
            if (!list.Contains(v)) list.Add(v);
        }

        static string F(double d) { return d.ToString("0.####", CultureInfo.InvariantCulture); }

        // ─────────────────────────────────────────────────────────────
        // 反射小工具（与 AuditMenuDump 同风格）
        // ─────────────────────────────────────────────────────────────

        static FieldInfo FindField(Type t, string name)
        {
            while (t != null)
            {
                FieldInfo f = t.GetField(name, AnyInstance);
                if (f != null) return f;
                t = t.BaseType;
            }
            return null;
        }

        static PropertyInfo FindProperty(Type t, string name)
        {
            while (t != null)
            {
                PropertyInfo p = t.GetProperty(name, AnyInstance);
                if (p != null) return p;
                t = t.BaseType;
            }
            return null;
        }

        static object GetMember(object obj, string name)
        {
            if (obj == null) return null;
            Type t = obj.GetType();
            FieldInfo f = FindField(t, name);
            if (f != null) return f.GetValue(obj);
            PropertyInfo p = FindProperty(t, name);
            if (p != null && p.GetIndexParameters().Length == 0) return p.GetValue(obj, null);
            return null;
        }

        // ─────────────────────────────────────────────────────────────
        // 内部数据
        // ─────────────────────────────────────────────────────────────

        sealed class CtrlRef
        {
            public RuntimeAnimatorController Ctrl;
            public string Prefix;
        }

        sealed class Driver
        {
            public string Property;
            public string Path;
            public string Clip;
            public string ClipPath;
            public string Controller;
            public string ControllerPath;
        }

        sealed class MaControls
        {
            public readonly List<string> ToggleTargets = new List<string>();
            public readonly List<string> MenuItemPaths = new List<string>();
        }

        /// <summary>父链部位映射：沿父链向上遇到的第一个 HumanBodyBones 即该骨骼的部位。
        /// 与 AuditFitProbe v2 一致；取不到人形 Animator 时退化为骨骼原名。
        ///
        /// B-补-18：MA MergeArmature 服装件自带独立骨架，服装骨不是头像的人形 Transform，
        /// 身份匹配/骨名兜底都可能整片落 Other。这里按 MergeArmature 的 `mergeTarget` 与骨名
        /// 对应（直接调其 `GetBonesMapping()`，反射以免不同工程 MA 版本编不过），把服装骨
        /// 映射到它要并进去的**头像人形骨**上，再取人形部位。装饰骨（鞋链、蝴蝶结）沿父链
        /// 找最近的已映射骨，就能跟着归位。</summary>
        sealed class RegionMapper
        {
            readonly Transform _root;
            readonly Dictionary<Transform, string> _boneNames = new Dictionary<Transform, string>();
            readonly Dictionary<Transform, string> _cache = new Dictionary<Transform, string>();
            readonly Dictionary<Transform, Transform> _mergeBoneMap;
            readonly int _humanoidCount;

            public RegionMapper(Transform root, Animator anim)
            {
                _root = root;
                if (anim != null && anim.isHuman)
                {
                    Array values = Enum.GetValues(typeof(HumanBodyBones));
                    for (int i = 0; i < values.Length; i++)
                    {
                        HumanBodyBones b = (HumanBodyBones)values.GetValue(i);
                        if (b == HumanBodyBones.LastBone) continue;
                        Transform t = null;
                        try { t = anim.GetBoneTransform(b); } catch { }
                        if (t != null && !_boneNames.ContainsKey(t)) _boneNames[t] = b.ToString();
                    }
                }
                _humanoidCount = _boneNames.Count;
                _mergeBoneMap = BuildMergeBoneMap(root);
            }

            /// <summary>收录到的人形骨骼（HumanBodyBones → Transform）快照；MR 最近骨骼近似用。</summary>
            public List<Transform> HumanoidBones
            {
                get { return new List<Transform>(_boneNames.Keys); }
            }

            /// <summary>MA MergeArmature 的 (mergeBone → baseBone/mergeTarget 链上的骨) 映射。
            /// 全部反射：`GetBonesMapping()` 返回 `List&lt;(Transform baseBone, Transform mergeBone)&gt;`。</summary>
            static Dictionary<Transform, Transform> BuildMergeBoneMap(Transform root)
            {
                var map = new Dictionary<Transform, Transform>();
                if (root == null) return map;
                Component[] comps;
                try { comps = root.GetComponentsInChildren<Component>(true); }
                catch { return map; }
                for (int ci = 0; ci < comps.Length; ci++)
                {
                    Component c = comps[ci];
                    if (c == null) continue;
                    Type ty = c.GetType();
                    if (ty.Name != "ModularAvatarMergeArmature") continue;
                    MethodInfo mi = ty.GetMethod("GetBonesMapping",
                        BindingFlags.Public | BindingFlags.Instance);
                    if (mi == null) continue;
                    object res;
                    try { res = mi.Invoke(c, null); }
                    catch { continue; }
                    IEnumerable en = res as IEnumerable;
                    if (en == null) continue;
                    foreach (object item in en)
                    {
                        if (item == null) continue;
                        Type it = item.GetType();
                        FieldInfo f1 = it.GetField("Item1");
                        FieldInfo f2 = it.GetField("Item2");
                        if (f1 == null || f2 == null) continue;
                        Transform baseBone = f1.GetValue(item) as Transform;
                        Transform mergeBone = f2.GetValue(item) as Transform;
                        if (baseBone != null && mergeBone != null && !map.ContainsKey(mergeBone))
                            map[mergeBone] = baseBone;
                    }
                }
                return map;
            }

            public string RegionOf(Transform t)
            {
                if (t == null) return "unknown";
                string cached;
                if (_cache.TryGetValue(t, out cached)) return cached;

                // B-补-18：MA MergeArmature 服装骨 → mergeTarget 链上的人形骨（含装饰骨沿父链找）
                Transform mb = t;
                int mergeGuard = 0;
                while (mb != null && mergeGuard++ < AuditBodyPick.BoneWalkGuard)
                {
                    Transform baseBone;
                    if (_mergeBoneMap.TryGetValue(mb, out baseBone))
                    {
                        string mr = RegionOf(baseBone);
                        _cache[t] = mr;
                        return mr;
                    }
                    if (mb == _root) break;
                    mb = mb.parent;
                }

                Transform cur = t;
                string region = null;
                int guard = 0;
                while (cur != null && guard++ < AuditBodyPick.BoneWalkGuard)
                {
                    string name;
                    if (_boneNames.TryGetValue(cur, out name)) { region = name; break; }
                    if (cur == _root) break;
                    cur = cur.parent;
                }
                // 身份匹配落空时按骨骼名兜底：导入服装/配饰自带独立骨架（如 Milfy 服装 FBX 的
                // Foot.L / Toe.L，bones 不是头像的人形 Transform）以前整片落 Other，鞋底厚度因此为
                // null（B-补-03）。名字兜底不改身份匹配优先级，只在身份匹配失败后启用。
                if (region == null)
                    region = AuditBodyPick.RegionByNameChain(t, _root);
                if (region == null)
                    region = _humanoidCount == 0 ? t.name : "Other";

                _cache[t] = region;
                return region;
            }
        }
    }
}
