// 【项目沉淀】通用工具（Harness optimize 阶段的 Unity 步骤）
// 适用素体：无关
// 工具链　：Unity 2022.3 批处理；AAO（Avatar Optimizer）Trace And Optimize，经反射挂（运行时程序集没开 Auto Referenced）
// 可复用性：★★★ 换个单子直接能用
// 用途　　：非破坏性优化。① 菜单层的变体 Assets/_Harness/Optimize/Avatar.prefab 上挂 AAO Trace And Optimize（构建时才删
//           没用的骨、形态键、网格，面数不变）；② 按 SOP 80 分档写贴图方案 Assets/_Harness/Optimize/texture_plan.json：
//           主图（白名单属性）上限 2048、辅助图 1024、Cubemap 512，只降不升，一律开 Mip Streaming、禁未压缩格式。
//           方案不改主工程里厂商贴图的 .meta：build_copy.py 在构建副本与交付副本里套用，交付包带的是套用后的导入设置。
//           随后测 performance.check（残留克隆、无效的待删条目）与 avatar.observe。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Dynamics.PhysBone.Components;

namespace AVH.Harness
{
    public static class OptimizeStage
    {
        public const string Dir = "Assets/_Harness/Optimize";
        public const string AvatarPath = Dir + "/Avatar.prefab";
        public const string DesignPath = Dir + "/design.json";
        public const string PlanPath = Dir + "/texture_plan.json";
        public const string RecordPath = Dir + "/optimize.json";
        public const string ScenePath = Dir + "/Avatar.unity";
        const string AaoType = "Anatawa12.AvatarOptimizer.TraceAndOptimize";
        // SOP 80：判主图用白名单（lilToon 的辅助属性几十个，黑名单必漏）；来自 tex_tier_plan.py
        static readonly Regex MainProperty = new Regex(@"^_Main\d*(st|nd|rd|th)?Tex$|^_BaseMap$|^_BaseColorMap$");
        // A shader property that carries machine-readable data rather than colour art. Compressing or resizing such a
        // texture corrupts the data it encodes, so it is not a texture the import plan may touch and not one the
        // texture audit may judge as art. The property the material binds it to is the only durable evidence on a
        // built avatar; the set is kept explicit instead of guessed from size or format, so an ordinary large
        // texture is still audited. VRCFury's SPS bake writes raw floats into a width-8192 RGBA32 texture with no mip
        // maps and binds it to `_SPS_Bake` (SpsBakedTexture.Save; SpsConfigurer `private const string SpsBake =
        // "_SPS_Bake"`, `m.SetTextureFast(SpsBake, spsBaked)`).
        static readonly Regex DataProperty = new Regex(@"^_SPS_Bake$", RegexOptions.IgnoreCase);
        /// <summary>The role of a texture that encodes plugin data instead of visible art.</summary>
        public const string DataRole = "data";
        public static bool DataBound(string property) => DataProperty.IsMatch(property);
        public const int Main = 2048, Aux = 1024, Cube = 512;
        // The per-avatar switches for the automatic MergeBone pass are the component's `debugOptions`
        // (`noConfigureLeafMergeBone` / `noConfigureMiddleMergeBone`). The same-named fields on
        // TraceAndOptimizePlatformSettings are a ScriptableObject shared by every avatar in the project, so pinning
        // those would change the whole project's optimization; the component's debug switches force the merge off for
        // this avatar only. MergeBoneProcessor reparents every merged child and renames it `<parent>$<child>$<n>`,
        // which is what removed the fixed outfits' object paths (`_Outfit/Outfit_snowflake`) from the built avatar
        // and broke the "still worn" judgement and the regression photos. Sweeping, activeness animation and the
        // other T&O passes still run; `mergeSkinnedMesh=false` alone only kept the meshes apart, not the hierarchy.
        static readonly (string, bool)[] AaoSettings =
        {
            ("mergeSkinnedMesh", false), ("allowShuffleMaterialSlots", false), ("optimizeTexture", false),
            ("debugOptions.noConfigureLeafMergeBone", true), ("debugOptions.noConfigureMiddleMergeBone", true),
        };

        public static void Run() => Avh.Stage("optimize", () =>
        {
            var basePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(MenuStage.AvatarPath) ?? throw new Exception("缺少菜单层 Avatar.prefab");
            var mode = Avh.Plan().Obj("optimization")?.Str("mode") ?? "optimize";
            if (mode == "preserve") { CreatePreservedOutput(basePrefab); Observe(); return; }
            if (mode != "optimize") throw new Exception("优化模式必须为 optimize 或 preserve");
            var design = Avh.ReadJsonFile(Avh.Abs(DesignPath)) ?? throw new Exception("缺少优化设计 design.json；必须先根据 build_pre/perf.json 做逐项决策");
            if (design.Str("schema") != "optimize-design/0.1") throw new Exception("优化设计 schema 必须为 optimize-design/0.1");
            OutfitStage.EnsureFolder(Dir);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(basePrefab);
            ApplyAaoSettings(avatar);
            var plan = TexturePlan(avatar, design, out var dataTextures, out var notAppliedTextures);
            var physBoneActions = ApplyPhysBoneActions(avatar, design);
            PrefabUtility.SaveAsPrefabAsset(avatar, AvatarPath, out var ok);
            if (!ok) throw new Exception("存优化层变体失败");
            UnityEngine.Object.DestroyImmediate(avatar);
            // 上传用的场景：只放这一个头像根（SOP 90「本次选定进构建的根恰好 1 个」），客户打开它就能在 SDK 面板里上传。
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(AvatarPath), scene);
            if (!EditorSceneManager.SaveScene(scene, ScenePath)) throw new Exception("存上传场景失败");
            Avh.WriteJson(Avh.Abs(PlanPath), new Dictionary<string, object>
            {
                ["schema"] = "texture-plan/0.1", ["tiers"] = new Dictionary<string, object> { ["main"] = Main, ["aux"] = Aux, ["cube"] = Cube },
                ["textures"] = plan,
            });
            Avh.WriteJson(Avh.Abs(RecordPath), new Dictionary<string, object>
            {
                ["schema"] = "optimize/0.2", ["texture_plan"] = PlanPath, ["design"] = DesignPath,
                ["mode"] = "optimize",
                ["physbone_actions"] = physBoneActions,
                // 插件数据纹理（角色 data）：不进贴图方案，压缩或缩放会破坏其数据；这里如实登记被排除的项
                ["data_textures"] = dataTextures,
                // 设计宇宙是 build_pre 的 perf.json（构建产物，105 张），本校验读的是菜单层预制体；只出现在构建期、
                // 菜单层不使用的贴图在这里套不上，登记为未套用（副本保留厂商导入设置），不是错误。
                ["design_textures_not_applied"] = notAppliedTextures,
                ["aao"] = new Dictionary<string, object>
                {
                    ["component"] = "TraceAndOptimize",
                    ["overrides"] = AaoSettings.ToDictionary(x => x.Item1, x => (object)x.Item2),
                    ["why"] = "SOP 80：allowShuffleMaterialSlots / optimizeTexture 默认开易致材质错位与接缝；自动 MergeBone（debugOptions.noConfigureLeafMergeBone / noConfigureMiddleMergeBone）会把被合并的子物体改名成 `<父>$<子>$<序号>`，"
                        + "钉住它以保留每套衣服的物体层级与原路径，供构建后的回归判定与交付菜单断言使用",
                },
                // 手工删物体的清单（SOP 80「剔除假阳性后删」）：本流程不手删，交给 AAO 在构建时按使用情况删。
                ["dead_objects"] = new List<object>(),
            });
            AssetDatabase.ImportAsset(PlanPath);
            AssetDatabase.ImportAsset(RecordPath);
            Observe();
        });

        /// <summary>
        /// Pin the AAO overrides on one avatar's Trace and Optimize component. One call the stage and the fixture both
        /// make, so what the fixture asserts through the component's serialized state is what the stage actually sets.
        /// </summary>
        public static void ApplyAaoSettings(GameObject avatar)
        {
            var type = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(AaoType)).FirstOrDefault(t => t != null)
                ?? throw new Exception("找不到 AAO 的 TraceAndOptimize（com.anatawa12.avatar-optimizer 没装？）");
            var aao = avatar.GetComponent(type) ?? avatar.AddComponent(type);
            // 不合并网格、不打乱材质槽、不合并贴图（SOP 80：后两项默认开，最易出材质错位与接缝），并钉住自动 MergeBone：
            // 只有三者一起关，每套衣服的物体层级与原路径才留到构建后，回归阶段按物体判「穿了哪套」、交付菜单断言才靠得住。
            // 骨、形态键、PhysBone、动画器优化照旧开。
            var so = new SerializedObject(aao);
            foreach (var (name, value) in AaoSettings)
            {
                var property = so.FindProperty(name) ?? throw new Exception($"AAO TraceAndOptimize 没有设置项 {name}（版本变了？）");
                property.boolValue = value;
            }
            so.ApplyModifiedPropertiesWithoutUndo();
        }

        public static void CreatePreservedOutput(GameObject source)
        {
            if (source == null) throw new Exception("没有可保留的制作产物");
            OutfitStage.EnsureFolder(Dir);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(source);
            try
            {
                PrefabUtility.SaveAsPrefabAsset(avatar, AvatarPath, out var saved);
                if (!saved) throw new Exception("保存不优化路线产物失败");
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(AvatarPath), scene);
            if (!EditorSceneManager.SaveScene(scene, ScenePath)) throw new Exception("保存交付场景失败");
            Avh.WriteJson(Avh.Abs(PlanPath), new Dictionary<string, object>
            { ["schema"] = "texture-plan/0.1", ["mode"] = "preserve", ["textures"] = new List<object>() });
            Avh.WriteJson(Avh.Abs(RecordPath), new Dictionary<string, object>
            {
                ["schema"] = "optimize/0.2", ["mode"] = "preserve", ["source_prefab"] = AssetDatabase.GetAssetPath(source),
                ["texture_plan"] = PlanPath, ["physbone_actions"] = new List<object>(), ["dead_objects"] = new List<object>(),
            });
            AssetDatabase.ImportAsset(PlanPath); AssetDatabase.ImportAsset(RecordPath);
        }

        /// <summary>
        /// One texture's uses on the shipped avatar. The write protection (a machine-data binding: the import plan may
        /// not compress or resize it) and the visual audit (an art binding: format, tier, mip streaming and size) are
        /// tracked apart, because they are independent facts about the same asset. Collapsing them into one role let a
        /// texture bound both to `_MainTex`/an auxiliary property and to `_SPS_Bake` become "data" and drop out of every
        /// art check — a silent pass for an 8192-wide RGBA32 texture nothing resizes. A mixed use is reported as a
        /// binding conflict and is still audited under its visual role.
        /// </summary>
        public sealed class TextureUse
        {
            /// <summary>Bound to a machine-data property: the import plan may not compress or resize it.</summary>
            public bool Data;
            /// <summary>The art role of its visual bindings ("main"/"aux"/"cube"), or null when it has none.</summary>
            public string Visual;
            public bool Mixed => Data && Visual != null;
            /// <summary>The role the import plan and the optimize record read (write protection wins).</summary>
            public string Role => Data ? DataRole : Visual;
        }

        /// <summary>
        /// Every texture the shipped renderers' materials use, with each of its independent uses. Objects tagged
        /// EditorOnly (the body's hidden clothes) are stripped at build and do not count.
        /// </summary>
        public static Dictionary<Texture, TextureUse> TextureUses(GameObject avatar)
        {
            var uses = new Dictionary<Texture, TextureUse>();
            var renderers = avatar.GetComponentsInChildren<Renderer>(true).Where(r => !EditorOnly(r.transform));
            foreach (var material in renderers.SelectMany(r => r.sharedMaterials).Where(m => m != null).Distinct())
                foreach (var property in material.GetTexturePropertyNames())
                {
                    var texture = material.GetTexture(property);
                    if (texture == null || string.IsNullOrEmpty(AssetDatabase.GetAssetPath(texture))) continue;
                    if (!uses.TryGetValue(texture, out var use)) uses[texture] = use = new TextureUse();
                    if (DataBound(property)) { use.Data = true; continue; }
                    var visual = texture is Cubemap || texture.dimension == UnityEngine.Rendering.TextureDimension.Cube ? "cube"
                        : MainProperty.IsMatch(property) ? "main" : "aux";
                    // 同一张图被当主图用过一次就按主图（红线只降到 2048）；cube 比 aux 严，取更严的那个
                    use.Visual = use.Visual == null || visual == "main" || (use.Visual == "aux" && visual == "cube") ? visual : use.Visual;
                }
            return uses;
        }

        /// <summary>The plan role of every texture: data write protection wins over the art role.</summary>
        public static Dictionary<Texture, string> TextureRoles(GameObject avatar) =>
            TextureUses(avatar).ToDictionary(kv => kv.Key, kv => kv.Value.Role);

        static List<object> ApplyPhysBoneActions(GameObject avatar, Dictionary<string, object> design)
        {
            var applied = new List<object>();
            var originals = avatar.GetComponentsInChildren<VRCPhysBone>(true).GroupBy(pb => Probe.HierarchyPath(avatar.transform, pb.transform))
                .ToDictionary(group => group.Key, group => group.ToList());
            var removals = new HashSet<VRCPhysBone>();
            var kept = new HashSet<VRCPhysBone>();
            foreach (var action in design.List("physbone_actions").Cast<Dictionary<string, object>>())
            {
                var kind = action.Str("action");
                if (kind != "remove_duplicate" && kind != "remove_noop")
                    throw new Exception("当前只允许可证明等价的 remove_duplicate 或无子骨且无 Endpoint 的 remove_noop；合并骨链需要另行审美/动态验证");
                var path = action.Str("object");
                if (!originals.TryGetValue(path, out var components)) throw new Exception($"PhysBone 动作目标不存在或没有 PhysBone：{path}");
                var removeIndex = Convert.ToInt32(action["remove_index"]);
                if (removeIndex < 0 || removeIndex >= components.Count) throw new Exception($"PhysBone 动作索引无效：{path} remove={removeIndex}");
                if (kept.Contains(components[removeIndex])) throw new Exception($"PhysBone 动作冲突：{path}#{removeIndex} 同时被声明为删除项和保留项");
                if (string.IsNullOrWhiteSpace(action.Str("rationale"))) throw new Exception($"PhysBone 动作 {path} 缺少 rationale");
                var keepIndex = -1;
                if (kind == "remove_duplicate")
                {
                    keepIndex = Convert.ToInt32(action["keep_index"]);
                    if (keepIndex < 0 || keepIndex >= components.Count || removeIndex == keepIndex)
                        throw new Exception($"PhysBone 动作索引无效：{path} remove={removeIndex} keep={keepIndex}");
                    if (!Perf.Redundant(components[removeIndex], components[keepIndex]))
                        throw new Exception($"拒绝删除 {path}#{removeIndex}：它并非 {keepIndex} 的逐字段等价、碰撞体子集副本");
                    if (removals.Contains(components[keepIndex])) throw new Exception($"PhysBone 动作冲突：{path}#{keepIndex} 同时被声明为保留项和删除项");
                    kept.Add(components[keepIndex]);
                }
                else if (!Perf.IsNoop(components[removeIndex]))
                    throw new Exception($"拒绝删除 {path}#{removeIndex}：有效根仍有子骨或 endpointPosition 非零");
                removals.Add(components[removeIndex]);
                var appliedAction = new Dictionary<string, object>
                {
                    ["action"] = kind, ["object"] = path, ["remove_index"] = removeIndex,
                    ["rationale"] = action.Str("rationale"), ["rollback"] = "从菜单层基准重新生成 Optimize/Avatar.prefab；源预制体未修改",
                };
                if (keepIndex >= 0) appliedAction["keep_index"] = keepIndex;
                applied.Add(appliedAction);
            }
            foreach (var component in removals) UnityEngine.Object.DestroyImmediate(component);
            var remaining = avatar.GetComponentsInChildren<VRCPhysBone>(true);
            var unresolved = remaining.GroupBy(pb => pb.gameObject).Sum(group =>
            {
                var list = group.ToList(); var count = 0;
                for (var i = 0; i < list.Count; i++) for (var j = 0; j < list.Count; j++) if (i != j && Perf.Redundant(list[i], list[j])) { count++; break; }
                return count;
            });
            if (unresolved > 0) throw new Exception($"仍有 {unresolved} 个可证明冗余的 PhysBone 未在 design.physbone_actions 中处理");
            return applied;
        }

        public static bool EditorOnly(Transform t)
        {
            for (var x = t; x != null; x = x.parent) if (x.gameObject.CompareTag("EditorOnly")) return true;
            return false;
        }

        public static List<object> TexturePlan(GameObject avatar, Dictionary<string, object> design, out List<object> dataTextures, out List<object> notApplied)
        {
            var uses = TextureUses(avatar);
            var decisions = design.List("textures").Cast<Dictionary<string, object>>().ToList();
            var duplicate = decisions.GroupBy(d => d.Str("guid")).FirstOrDefault(g => string.IsNullOrEmpty(g.Key) || g.Count() != 1);
            if (duplicate != null) throw new Exception($"优化设计里的纹理 GUID 为空或重复：{duplicate.Key}");
            var byGuid = decisions.ToDictionary(d => d.Str("guid"));
            var entries = new List<object>();
            var data = new List<object>();
            var dataGuids = new HashSet<string>();
            foreach (var (texture, use) in uses.OrderBy(kv => AssetDatabase.GetAssetPath(kv.Key)))
            {
                var path = AssetDatabase.GetAssetPath(texture);
                // 数据纹理既不需要设计覆盖，也不进方案；设计里若写了它也不会被执行（登记在 optimize.json.data_textures）
                if (use.Data)
                {
                    var dataGuid = AssetDatabase.AssetPathToGUID(path);
                    dataGuids.Add(dataGuid);
                    data.Add(new Dictionary<string, object> { ["path"] = path, ["guid"] = dataGuid,
                        ["visual_role"] = use.Visual, ["mixed_use"] = use.Mixed,
                        ["why"] = use.Mixed
                            ? $"插件数据纹理：压缩或缩放会破坏其数据，不进贴图方案；同一张图还按 {use.Visual} 绑定到视觉属性，这是绑定冲突，视觉审计仍按 {use.Visual} 校验"
                            : "插件数据纹理：压缩或缩放会破坏其数据，不进贴图方案" });
                    continue;
                }
                var role = use.Visual;
                if (!(AssetImporter.GetAtPath(path) is TextureImporter importer)) continue;
                var guid = AssetDatabase.AssetPathToGUID(path);
                if (!byGuid.TryGetValue(guid, out var decision)) throw new Exception($"优化设计没有覆盖纹理 {path}（{guid}，{role}）");
                var action = decision.Str("action");
                if (action != "keep" && action != "downscale") throw new Exception($"纹理 {path} 的 action 必须为 keep 或 downscale");
                if (string.IsNullOrWhiteSpace(decision.Str("rationale"))) throw new Exception($"纹理 {path} 缺少逐项取舍理由 rationale");
                var platform = importer.GetPlatformTextureSettings("Standalone");
                var effective = platform.overridden ? platform.maxTextureSize : importer.maxTextureSize;
                var requested = decision.TryGetValue("target_max_size", out var raw) ? Convert.ToInt32(raw) : effective;
                var target = action == "keep" ? effective : requested;
                if (target <= 0 || target > effective) throw new Exception($"纹理 {path} 的目标 {target} 必须大于 0 且不能高于基线 {effective}");
                var tier = role == "main" ? Main : role == "cube" ? Cube : Aux;
                // Main art above its tier may stay as it is: lowering it needs the person's approval, which keep does not have.
                if (target > tier && !(role == "main" && action == "keep"))
                    throw new Exception($"纹理 {path} 的目标 {target} 超过 {role} 档上限 {tier}");
                var floor = Math.Min(Main, effective);
                if (role == "main" && target < effective && decision.Obj("visual_review")?.Str("status") != "approved")
                    throw new Exception($"主视觉纹理 {path} 要从 {effective} 降到 {target}，但没有 visual_review.status=approved 的审美确认（红线 {floor}）");
                entries.Add(new Dictionary<string, object>
                {
                    ["path"] = path, ["guid"] = guid, ["role"] = role, ["action"] = action, ["rationale"] = decision.Str("rationale"),
                    ["width"] = texture.width, ["height"] = texture.height, ["max_size"] = effective,
                    ["target_max_size"] = target, ["visual_review"] = decision.Obj("visual_review"),
                    ["streaming_mipmaps"] = importer.streamingMipmaps,
                    ["compressed"] = importer.textureCompression != TextureImporterCompression.Uncompressed
                        && !(platform.overridden && Uncompressed(platform.format)),
                    ["rollback"] = new Dictionary<string, object>
                    {
                        ["max_texture_size"] = importer.maxTextureSize, ["standalone_overridden"] = platform.overridden,
                        ["standalone_max_texture_size"] = platform.maxTextureSize, ["texture_compression"] = importer.textureCompression.ToString(),
                        ["standalone_format"] = platform.format.ToString(), ["streaming_mipmaps"] = importer.streamingMipmaps,
                    },
                });
            }
            // The design's universe is the built avatar's inventory (build_pre/perf.json, per the goal); this
            // validator's universe is the menu-layer prefab being optimized. A design entry for a texture the build
            // binds but this prefab does not use cannot be applied here: the import plan only carries entries that
            // exist on this avatar, and build_copy.py applies exactly that plan. Such an entry is recorded as not
            // applied instead of rejected — the model cannot derive this set from the input the goal names, and the
            // import setting it left alone is the one the build then keeps. A design that omits a texture this avatar
            // *does* use is still an error (above), so the check stays as strict as its own universe.
            var applied = new HashSet<string>(entries.Cast<Dictionary<string, object>>().Select(e => e.Str("guid")));
            notApplied = decisions.Where(d => !applied.Contains(d.Str("guid")) && !dataGuids.Contains(d.Str("guid")))
                .Select(d => (object)new Dictionary<string, object>
                {
                    ["guid"] = d.Str("guid"), ["path"] = d.Str("path"), ["decision_action"] = d.Str("action"),
                    ["why"] = "该 GUID 不在本校验能套用的贴图上（菜单层头像不使用它，或那张图没有 TextureImporter）；设计宇宙来自 build_pre 的 perf.json，"
                        + "这里无法套用，构建副本按厂商原始导入设置走",
                }).ToList();
            dataTextures = data;
            return entries;
        }

        public static bool Uncompressed(TextureImporterFormat format) => format == TextureImporterFormat.RGBA32 || format == TextureImporterFormat.ARGB32
            || format == TextureImporterFormat.RGB24 || format == TextureImporterFormat.RGBA64 || format == TextureImporterFormat.RGBAHalf
            || format == TextureImporterFormat.RGBAFloat || format == TextureImporterFormat.ARGB16 || format == TextureImporterFormat.RGBA16;

        static void Observe()
        {
            var record = Avh.ReadJsonFile(Avh.Abs(RecordPath));
            var baseline = Avh.ReadJsonFile(Avh.Abs("_harness/setup/baseline.json"));
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(AvatarPath));
            try
            {
                var notes = new List<string>();
                var clones = avatar.GetComponentsInChildren<Transform>(true).Where(t => t.name.EndsWith("(Clone)")).Select(t => t.name).ToList();
                var generated = AssetDatabase.IsValidFolder("Assets/ZZZ_GeneratedAssets") ? 1 : 0;
                if (clones.Count > 0) notes.Add("残留克隆：" + string.Join(", ", clones.Take(5)));
                if (generated > 0) notes.Add("残留 NDMF 手动烘焙目录 Assets/ZZZ_GeneratedAssets");
                var dead = record.List("dead_objects").Select(x => x.ToString()).ToList();
                var invalid = dead.Count(path => avatar.transform.Find(path) == null);
                var notApplied = record.List("design_textures_not_applied").Cast<Dictionary<string, object>>().ToList();
                if (notApplied.Count > 0) notes.Add($"优化设计有 {notApplied.Count} 项未套用（不在菜单层头像使用的贴图上，构建副本按厂商原始导入设置走）："
                    + string.Join(", ", notApplied.Take(5).Select(x => x.Str("path") ?? x.Str("guid"))));
                var physboneSafety = Perf.PhysBoneSafety(avatar);
                var requestedMode = Avh.Plan().Obj("optimization")?.Str("mode") ?? "optimize";
                var texturePlan = Avh.ReadJsonFile(Avh.Abs(PlanPath));
                var preserved = OutfitStage.IsUnmodifiedVariant(AssetDatabase.LoadAssetAtPath<GameObject>(AvatarPath), MenuStage.AvatarPath)
                    && texturePlan != null && texturePlan.Str("mode") == "preserve" && texturePlan.List("textures").Count == 0
                    && record.List("physbone_actions").Count == 0 && record.List("dead_objects").Count == 0;
                Avh.Observation("performance.check", new Dictionary<string, object>
                {
                    ["optimization_mode_valid"] = record.Str("mode") == requestedMode
                        && (requestedMode == "optimize" || (requestedMode == "preserve" && preserved)),
                    ["leftover_baked_clones"] = clones.Count + generated,
                    ["invalid_dead_object_entries"] = invalid,
                    ["invalid_merge_physbones"] = physboneSafety["invalid_merge_physbones"],
                    ["physbone_core_humanoid_coverage"] = physboneSafety["physbone_core_humanoid_coverage"],
                    ["noop_physbones"] = physboneSafety["noop_physbones"],
                }, notes);
                var observeNotes = new List<string>();
                Avh.Observation("avatar.observe", Measure.Observe(avatar, baseline, observeNotes), observeNotes);
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }
    }
}
