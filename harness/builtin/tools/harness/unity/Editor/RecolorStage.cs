// 【项目沉淀】通用工具（Harness recolor 阶段的 Unity 步骤）
// 适用素体：无关
// 工具链　：Unity 2022.3 批处理（出图不能带 -nographics）；lilToon（用 _MainTexHSVG 改色，不烘贴图）
// 可复用性：★★★ 换个单子直接能用
// 用途　　：按 recolor.py 写好的配方（Assets/_Harness/Recolor/recipe.json）改色。非破坏性（SOP 40 步骤 4）：
//           每个「渲染器 × 原材质」复制一份到 Assets/_Harness/Recolor/Materials/，只改副本，台账记原材质 GUID；
//           每一档 × 每套衣服同机位出一张候选图（写到 Run 目录 candidates/，附机位规格），最后把选定档落到副本上，
//           存成服装层的变体 Assets/_Harness/Recolor/Avatar.prefab，写台账与配色决策。随后只读测量 avatar.observe
//           与 menu.dump（材质切换曲线是否还指着被替换的原材质）。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Avatars.Components;

namespace AVH.Harness
{
    public static class RecolorStage
    {
        public const string Dir = "Assets/_Harness/Recolor";
        public const string MaterialDir = Dir + "/Materials";
        public const string AvatarPath = Dir + "/Avatar.prefab";
        public const string RecipePath = Dir + "/recipe.json";
        public const string LayerApplyPath = Dir + "/layer-apply.json";
        public const string RegionApplyPath = Dir + "/region-apply.json";
        /// <summary>0.2 declares the renderer, submesh and conflicts on every operation, so a reader can check each one.</summary>
        public const string RegionSchema = "mesh-region-apply/0.2";
        public const string RegionDir = Dir + "/Regions";
        public const string LedgerPath = Dir + "/ledger.json";
        public const string PresetDir = Dir + "/MemberPresets";
        public static string PresetPath(string member) => PresetDir + "/" + Sanitize(member) + ".anim";
        static void SaveMemberPresets(List<Dictionary<string, object>> outfits, List<object> rows)
        {
            OutfitStage.EnsureFolder(PresetDir);
            foreach (var row in outfits)
            {
                var clip = new AnimationClip { name = "RecolorPreset_" + row.Str("id") };
                foreach (Dictionary<string, object> preset in row.List("material_presets"))
                    for (var slot = 0; slot < preset.List("materials").Count; slot++)
                    {
                        var original = VariantResolver.Material(preset.List("materials")[slot]);
                        var replacement = rows.Cast<Dictionary<string, object>>().LastOrDefault(r => r.Str("renderer") == preset.Str("renderer")
                            && Convert.ToInt32(r["slot"]) == slot && (r.Str("member") == null || r.Str("member") == row.Str("id"))
                            && Avh.Json(r.Obj("original_identity")) == Avh.Json(VariantResolver.Identity(original)));
                        var material = replacement == null ? original : VariantResolver.Material(replacement.Obj("material_identity"));
                        var binding = EditorCurveBinding.PPtrCurve(preset.Str("renderer"), typeof(Renderer), "m_Materials.Array.data[" + slot + "]");
                        AnimationUtility.SetObjectReferenceCurve(clip, binding, new[] { new ObjectReferenceKeyframe { time = 0, value = material } });
                    }
                var path = PresetPath(row.Str("id")); AssetDatabase.DeleteAsset(path); AssetDatabase.CreateAsset(clip, path);
            }
        }
        public const string DecisionPath = Dir + "/配色决策.md";
        static readonly Regex HairName = new Regex("hair|髪", RegexOptions.IgnoreCase);
        static readonly Regex EyeName = new Regex("eye|瞳", RegexOptions.IgnoreCase);

        class Copy { public Material Source; public Material Baseline; public Material Material; public string Part; }
        class MaterialSelection
        {
            public Dictionary<string, object> Target;
            public Material Material;
            public List<(Renderer renderer, int slot, Material source)> Slots;
        }

        public static void Run() => Avh.Stage("recolor", Produce);

        public static void Produce()
        {
            AssetDatabase.Refresh();
            var fallback = DependencyAuthority();
            var irisRequests = IrisRequests();
            var usedIris = new HashSet<string>();
            var recipe = Avh.ReadJsonFile(Avh.Abs(RecipePath)) ?? throw new Exception("缺少配方 recipe.json（本阶段的 recolor.py 应先写好）");
            var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)) ?? throw new Exception("缺少服装层记录 outfit.json");
            var basePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath) ?? throw new Exception("缺少服装层 Avatar.prefab");
            OutfitStage.EnsureFolder(MaterialDir);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(basePrefab);
            var copies = new Dictionary<(Renderer, Material, string), Copy>();
            try
            {
            var group = avatar.transform.Find(record.Str("group") ?? OutfitStage.Group);
            if (AvatarConfig.Grouped(Avh.Plan())) MaterialAxes.Produce(Avh.Plan(), record);

            var rows = new List<object>();
            var unmapped = new List<object>();
            // Resolve every writer against the unchanged outfit layer before making any copies.
            var claimed = new Dictionary<(Renderer, int, string), string>();
            var relative = recipe.List("targets").Cast<Dictionary<string, object>>()
                .Select(t => (target: t, slots: Resolve(avatar, group, t.Str("part"), fallback, irisRequests))).ToList();
            foreach (var entry in relative) Claim(avatar, claimed, entry.slots, entry.target.Str("part"), Scope(entry.target.Str("part")));
            var selections = recipe.List("materialOps").Cast<Dictionary<string, object>>()
                .Select(t => ResolveMaterial(group, t)).ToList();
            foreach (var selection in selections)
                Claim(avatar, claimed, selection.Slots, "material:" + selection.Target.Str("requirement_id"), selection.Target.Str("outfit"));
            var layerApply = Avh.ReadJsonFile(Avh.Abs(LayerApplyPath));
            CheckMaterialLayerConflicts(avatar, selections, layerApply);
            foreach (var entry in relative)
            {
                var target = entry.target;
                var part = target.Str("part");
                var slots = entry.slots;
                if (slots.Count == 0) { unmapped.Add(part); Avh.Log($"改色部位 {part} 找不到材质槽"); continue; }
                foreach (var (renderer, slot, source) in slots)
                {
                    var scope = Scope(part);
                    if (!copies.TryGetValue((renderer, source, scope), out var copy))
                    {
                        var baselineMaterial = new Material(source);
                        var enableIris = part == "eye" && irisRequests.Contains(Guid(source));
                        if (enableIris) { baselineMaterial.SetFloat("_UseMain2ndTex", 1); usedIris.Add(Guid(source)); }
                        if (MissingShader(source) && fallback != null) baselineMaterial.shader = fallback;
                        var material = MakeCopy(avatar, renderer, source, scope);
                        if (enableIris) material.SetFloat("_UseMain2ndTex", 1);
                        if (MissingShader(source) && fallback != null) material.shader = fallback;
                        copies[(renderer, source, scope)] = copy = new Copy { Source = source, Baseline = baselineMaterial, Material = material, Part = part };
                    }
                    var materials = renderer.sharedMaterials;
                    materials[slot] = copy.Material;
                    renderer.sharedMaterials = materials;
                    rows.Add(new Dictionary<string, object>
                    {
                        ["renderer"] = Probe.HierarchyPath(avatar.transform, renderer.transform), ["slot"] = slot, ["part"] = part,
                        ["original"] = AssetDatabase.GetAssetPath(source), ["original_guid"] = Guid(source), ["original_identity"] = VariantResolver.Identity(source),
                        ["material"] = AssetDatabase.GetAssetPath(copy.Material), ["material_guid"] = Guid(copy.Material), ["material_identity"] = VariantResolver.Identity(copy.Material),
                        ["member"] = part.StartsWith("outfit:") ? part.Substring(7) : null,
                    });
                }
            }

            foreach (var selection in selections)
                foreach (var (renderer, slot, source) in selection.Slots)
                {
                    var materials = renderer.sharedMaterials;
                    materials[slot] = selection.Material;
                    renderer.sharedMaterials = materials;
                    rows.Add(new Dictionary<string, object>
                    {
                        ["renderer"] = Probe.HierarchyPath(avatar.transform, renderer.transform), ["slot"] = slot,
                        ["requirement_id"] = selection.Target.Str("requirement_id"), ["outfit"] = selection.Target.Str("outfit"),
                        ["original"] = AssetDatabase.GetAssetPath(source), ["original_guid"] = Guid(source), ["original_identity"] = VariantResolver.Identity(source),
                        ["material"] = AssetDatabase.GetAssetPath(selection.Material), ["material_guid"] = Guid(selection.Material), ["material_identity"] = VariantResolver.Identity(selection.Material),
                        ["member"] = selection.Target.Str("outfit"),
                    });
                }

            if (AvatarConfig.Grouped(Avh.Plan())) foreach (Dictionary<string, object> row in record.List("outfits"))
                if (rows.Cast<Dictionary<string, object>>().Any(r => MaterialAxes.Owns(Avh.Plan(), row, r.Str("renderer"), Convert.ToInt32(r["slot"]))))
                    throw new Exception("Authoring recolor and material axis overlap an observed slot");
            if (!usedIris.SetEquals(irisRequests)) throw new Exception("虹膜启用提案没有落到实际素体眼色槽，不能扩大施工范围");

            // 按层改色：区域在贴图内部，所以绑定对象是「所有用到这张贴图的槽位」。像素那一侧已经改完并自证过，
            // 这里只做绑定，并把实际绑到的槽位记全，让独立观察器可以核对同一个集合。
            if (layerApply != null)
                foreach (var operation in layerApply.List("operations").Cast<Dictionary<string, object>>())
                {
                    var requirement = operation.Str("requirement_id");
                    var originalPath = operation.Str("textureAsset");
                    var outputPath = operation.Str("outputAsset");
                    var original = AssetDatabase.LoadAssetAtPath<Texture2D>(originalPath)
                        ?? throw new Exception($"按层改色的源贴图不在工程里：{originalPath}");
                    var replacement = AssetDatabase.LoadAssetAtPath<Texture2D>(outputPath)
                        ?? throw new Exception($"按层改色的产物不在工程里：{outputPath}");
                    // 新贴图必须按原件的方式被读取，否则同一批像素代表另一种颜色，区域那边验过的结果就不再是结果。
                    MatchImporter(originalPath, outputPath);
                    var bound = 0;
                    foreach (var renderer in avatar.GetComponentsInChildren<Renderer>(true))
                    {
                        var materials = renderer.sharedMaterials;
                        var touched = false;
                        for (var slot = 0; slot < materials.Length; slot++)
                        {
                            var source = materials[slot];
                            if (source == null) continue;
                            var properties = TextureProperties(source, original);
                            if (properties.Count == 0) continue;
                            if (AvatarConfig.Grouped(Avh.Plan()) && record.List("outfits").Cast<Dictionary<string, object>>().Any(r => MaterialAxes.Owns(Avh.Plan(), r, Probe.HierarchyPath(avatar.transform, renderer.transform), slot)))
                                throw new Exception("Layer recolor and material axis overlap an observed slot");
                            // The slot may already hold the relative writer's final copy. Reuse it so Apply
                            // keeps writing the material the renderer actually uses, and retain source identity.
                            var layerCopy = copies.Values.FirstOrDefault(c => c.Material == source);
                            if (layerCopy == null && !copies.TryGetValue((renderer, source, ""), out layerCopy))
                                copies[(renderer, source, "")] = layerCopy = new Copy { Source = source, Baseline = new Material(source),
                                    Material = MakeCopy(avatar, renderer, source), Part = "layer:" + requirement };
                            foreach (var property in properties) layerCopy.Material.SetTexture(property, replacement);
                            materials[slot] = layerCopy.Material;
                            touched = true; bound++;
                            rows.Add(new Dictionary<string, object>
                            {
                                ["renderer"] = Probe.HierarchyPath(avatar.transform, renderer.transform), ["slot"] = slot,
                                ["part"] = "layer:" + requirement, ["original"] = AssetDatabase.GetAssetPath(layerCopy.Source),
                                ["original_guid"] = Guid(layerCopy.Source), ["material"] = AssetDatabase.GetAssetPath(layerCopy.Material),
                                ["material_guid"] = Guid(layerCopy.Material), ["texture_property"] = string.Join(",", properties),
                                ["texture"] = outputPath, ["texture_guid"] = Guid(replacement),
                                ["replaced_texture"] = originalPath,
                                // 读回 Unity 实际生效的导入设置，而不是我们以为自己设了什么。
                                ["import"] = ImportReadback(outputPath),
                            });
                        }
                        if (touched) renderer.sharedMaterials = materials;
                    }
                    if (bound == 0) throw new Exception($"按层改色的目标贴图没有任何槽位在用：{originalPath}");
                }

            // 按区域改色：区域由网格 UV 足迹导出（渲染器 + 子网格 + 骨骼），不是贴图上的矩形。
            // 两个区域共有的像素两边都不上色——那个像素没有唯一归属，给它上任何一种颜色都会把一只眼染到另一只。
            if (recipe.List("regionOps").Count > 0)
                BindRegions(avatar, recipe.List("regionOps").Cast<Dictionary<string, object>>().ToList(), selections, copies, rows);

            // Repair only actually missing shaders, in this new layer, after resolving requested color slots.
            if (fallback != null)
                foreach (var renderer in avatar.GetComponentsInChildren<Renderer>(true))
                {
                    var materials = renderer.sharedMaterials;
                    for (var slot = 0; slot < materials.Length; slot++)
                    {
                        var source = materials[slot];
                        if (source == null || !MissingShader(source)) continue;
                        var material = MakeCopy(avatar, renderer, source); material.shader = fallback;
                        materials[slot] = material;
                        copies[(renderer, source, "")] = new Copy { Source = source, Baseline = new Material(material), Material = material, Part = "shader_repair" };
                        rows.Add(new Dictionary<string, object> { ["renderer"] = Probe.HierarchyPath(avatar.transform, renderer.transform),
                            ["slot"] = slot, ["part"] = "shader_repair", ["original"] = AssetDatabase.GetAssetPath(source),
                            ["original_guid"] = Guid(source), ["material"] = AssetDatabase.GetAssetPath(material), ["material_guid"] = Guid(material), ["material_identity"] = VariantResolver.Identity(material) });
                    }
                    renderer.sharedMaterials = materials;
                }

            // 候选：每档 × 每套衣服一张，同一台相机。
            var tiers = recipe.List("tiers").Cast<Dictionary<string, object>>().ToList();
            var outfits = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
            var exclusive = outfits.Where(o => !OutfitStage.Fixed(o)).ToList();
            if (AvatarConfig.Grouped(Avh.Plan()))
            {
                Avh.WriteJson(Avh.Abs(LedgerPath), new Dictionary<string, object> { ["schema"] = "recolor-ledger/0.2", ["rows"] = rows });
                SaveMemberPresets(outfits, rows);
            }
            var candidates = Path.Combine(Avh.RunDir, "candidates");
            var shots = new List<string>();
            foreach (var tier in tiers)
            {
                Apply(copies.Values, tier);
                SetOutfitState(avatar, outfits, exclusive.FirstOrDefault(o => Equals(o["default"], true))?.Str("id"));
                if (exclusive.Count == 0)
                {
                    var name = $"{tier.Str("id")}_original";
                    var spec = Portrait.Front(avatar, Path.Combine(candidates, name + ".png"));
                    StateMetadata(spec, null, tier.Str("id"));
                    Avh.WriteJson(Path.Combine(candidates, name + ".json"), spec);
                    shots.Add(name + ".png");
                }
                foreach (var outfit in exclusive)
                {
                    SetOutfitState(avatar, outfits, outfit.Str("id"));
                    var name = $"{tier.Str("id")}_{outfit.Str("id")}";
                    var spec = Portrait.Front(avatar, Path.Combine(candidates, name + ".png"));
                    StateMetadata(spec, outfit.Str("id"), tier.Str("id"));
                    Avh.WriteJson(Path.Combine(candidates, name + ".json"), spec);
                    shots.Add(name + ".png");
                }
            }
            SetOutfitState(avatar, outfits, exclusive.FirstOrDefault(o => Equals(o["default"], true))?.Str("id"));

            var chosenId = recipe.Str("chosen");
            var chosen = tiers.FirstOrDefault(t => t.Str("id") == chosenId) ?? throw new Exception($"配方选定档 {chosenId} 不在档位列表里");
            Apply(copies.Values, chosen);
            foreach (var copy in copies.Values) EditorUtility.SetDirty(copy.Material);
            AssetDatabase.SaveAssets();
            PrefabUtility.SaveAsPrefabAsset(avatar, AvatarPath, out var saved);
            if (!saved) throw new Exception("存改色层变体失败");
            UnityEngine.Object.DestroyImmediate(avatar);
            RemoveStaleCopies(copies.Values.Select(c => AssetDatabase.GetAssetPath(c.Material)));

            Avh.WriteJson(Avh.Abs(LedgerPath), new Dictionary<string, object>
            {
                ["schema"] = "recolor-ledger/0.1", ["chosen"] = chosenId, ["rows"] = rows, ["unmapped"] = unmapped,
            });
            WriteDecision(recipe, tiers, chosenId, shots);
            AssetDatabase.ImportAsset(LedgerPath);
            AssetDatabase.ImportAsset(DecisionPath);

            Observe(AvatarPath, rows.Cast<Dictionary<string, object>>().ToList());

                    }
            finally
            {
                if (avatar != null) UnityEngine.Object.DestroyImmediate(avatar);
                foreach (var copy in copies.Values) if (copy.Baseline != null) UnityEngine.Object.DestroyImmediate(copy.Baseline);
            }
        }

        static bool MissingShader(Material material) => material.shader == null || material.shader.name == "Hidden/InternalErrorShader";

        public static void SetOutfitState(GameObject avatar, List<Dictionary<string, object>> outfits, string exclusiveId)
        {
            if (AvatarConfig.Grouped(Avh.Plan()))
            {
                var values = AvatarConfig.Defaults(Avh.Plan());
                if (exclusiveId != null) foreach (var g in AvatarConfig.Groups(Avh.Plan()))
                {
                    var selected = g.List("members").Cast<Dictionary<string, object>>().FirstOrDefault(m => m.Str("id") == exclusiveId);
                    if (selected != null && g.Str("activation") != "fixed") values[(g.Str("activation") == "exclusive" ? g : selected).Obj("parameter").Str("name")] = AvatarConfig.Value(g, selected);
                }
                SetGroupState(avatar, outfits, values);
                return;
            }
            foreach (var outfit in outfits)
            {
                var root = avatar.transform.Find(outfit.Str("object")) ?? throw new Exception($"候选状态缺少衣装 {outfit.Str("id")}");
                root.gameObject.SetActive(OutfitStage.Fixed(outfit) || outfit.Str("id") == exclusiveId);
            }
        }
        public static void SetGroupState(GameObject avatar, List<Dictionary<string, object>> outfits, Dictionary<string, float> state)
        {
            var plan = Avh.Plan(); var rows = outfits.ToDictionary(o => o.Str("id"));
            var values = AvatarConfig.Defaults(plan); foreach (var p in state) values[p.Key] = p.Value;
            var active = new Dictionary<string, bool>();
            foreach (var g in AvatarConfig.InstanceGroups(plan)) foreach (Dictionary<string, object> m in g.List("members"))
            {
                var row = rows[m.Str("id")]; var on = AvatarConfig.Selected(g, m, values);
                var paths = g.Str("activation") == "fixed" ? new[] { row.Str("object") } : row.List("bone_proxy_visuals").Select(p => p.ToString()).Append(row.Str("object"));
                foreach (var path in paths)
                    active[path] = (active.TryGetValue(path, out var prior) && prior) || on && (path == row.Str("object") || row.Obj("bone_proxy_defaults") == null || AvatarConfig.On(row.Obj("bone_proxy_defaults"), path));
                if (on && outfits.Count(r => r.Str("object") == row.Str("object")) > 1)
                    foreach (Dictionary<string, object> preset in row.List("material_presets"))
                        avatar.transform.Find(preset.Str("renderer")).GetComponent<Renderer>().sharedMaterials = Enumerable.Range(0, preset.List("materials").Count)
                            .Select(s => MenuGroups.PresetMaterialObject(row, preset, s)).ToArray();
            }
            foreach (var p in active) avatar.transform.Find(p.Key).gameObject.SetActive(p.Value);
            foreach (var s in AvatarConfig.Switches(plan)) foreach (Dictionary<string, object> target in s.List("targets"))
            {
                var inst = plan.Obj("avatar_config").List("instances").Cast<Dictionary<string, object>>().Single(i => i.Str("id") == target.Str("instance"));
                var comp = inst.List("components").Cast<Dictionary<string, object>>().Single(c => c.Str("id") == target.Str("component"));
                foreach (var row in outfits.Where(o => o.Str("instance") == target.Str("instance"))) foreach (var relative in comp.List("objects"))
                {
                    var path = row.Str("object") + "/" + relative;
                    var t = avatar.transform.Find(path) ?? throw new Exception("共享部件对象缺失：" + path);
                    active[path] = values[s.Obj("parameter").Str("name")] > .5f && (!active.TryGetValue(path, out var on) || on);
                    t.gameObject.SetActive(active[path]);
                }
            }
            MaterialAxes.Apply(avatar, plan, new Dictionary<string, object> { ["outfits"] = outfits.Cast<object>().ToList() }, values);
        }
        static void StateMetadata(Dictionary<string, object> photo, string member, string candidate)
        {
            var plan = Avh.Plan(); if (!AvatarConfig.Grouped(plan)) return;
            var state = AvatarConfig.Defaults(plan);
            foreach (var g in AvatarConfig.Groups(plan))
            {
                var m = g.List("members").Cast<Dictionary<string, object>>().FirstOrDefault(v => v.Str("id") == member);
                if (m != null && g.Str("activation") != "fixed") state[(g.Str("activation") == "exclusive" ? g : m).Obj("parameter").Str("name")] = AvatarConfig.Value(g, m);
            }
            photo["avatar_state"] = state.ToDictionary(p => p.Key, p => (object)p.Value);
            photo["configuration_hash"] = MenuGroups.ConfigHash(plan); photo["candidate"] = candidate;
        }

        /// 材质上指向某张贴图的属性名。lilToon 一类的材质会把同一张贴图挂在几个别名上（_MainTex 与 _BaseMap、
        /// _BaseColorMap），只改其中一个会让它们指向不同的图；所以返回全部别名，一个不漏地一起改。
        static List<string> TextureProperties(Material material, Texture texture)
        {
            var names = new List<string>();
            var guid = Guid(texture);
            foreach (var property in new[] { "_MainTex", "_BaseMap", "_BaseColorMap" })
            {
                if (!material.HasProperty(property)) continue;
                var current = material.GetTexture(property);
                if (current != null && (current == texture || (!string.IsNullOrEmpty(guid) && Guid(current) == guid))) names.Add(property);
            }
            return names;
        }

        /// 让新贴图按原件的方式被读取。改的是导入器，读回的是 Unity 实际生效的值。
        static void MatchImporter(string from, string to)
        {
            var source = AssetImporter.GetAtPath(from) as TextureImporter;
            var target = AssetImporter.GetAtPath(to) as TextureImporter;
            if (source == null || target == null) throw new Exception($"贴图导入器缺失，无法对齐读取方式：{from} / {to}");
            EditorUtility.CopySerialized(source, target);
            target.SaveAndReimport();
        }

        /// 读回导入设置，供独立核对。写进去的值不算证据，Unity 实际生效的才算。
        static Dictionary<string, object> ImportReadback(string path)
        {
            var importer = AssetImporter.GetAtPath(path) as TextureImporter;
            if (importer == null) throw new Exception($"贴图导入器缺失，无法读回：{path}");
            return new Dictionary<string, object>
            {
                ["sRGBTexture"] = importer.sRGBTexture, ["alphaSource"] = importer.alphaSource.ToString(),
                ["alphaIsTransparency"] = importer.alphaIsTransparency, ["wrapMode"] = importer.wrapMode.ToString(),
                ["filterMode"] = importer.filterMode.ToString(), ["maxTextureSize"] = importer.maxTextureSize,
                ["textureType"] = importer.textureType.ToString(), ["mipmapEnabled"] = importer.mipmapEnabled,
            };
        }

        static bool IrisLayer(Material material) => HasIrisMask(material) && material.GetFloat("_UseMain2ndTex") > 0.5f;

        static bool HasIrisMask(Material material) => material.HasProperty("_UseMain2ndTex") && material.HasProperty("_Main2ndTex") && material.GetTexture("_Main2ndTex") != null
            && EyeName.IsMatch(material.GetTexture("_Main2ndTex").name) && material.HasProperty("_Color2nd");

        static HashSet<string> IrisRequests()
        {
            var result = new HashSet<string>();
            var requestPath = Avh.Abs(Dir+"/dependencies.json");
            if (!File.Exists(requestPath)) return result;
            var request = Avh.ReadJsonFile(requestPath);
            var proposals = request.List("iris_layers");
            if (proposals.Count == 0) return result;
            var plan = Avh.ParseJson(Environment.GetEnvironmentVariable("AVH_PLAN") ?? "{}") as Dictionary<string, object>;
            if (!(plan?.Obj("recolor")?.List("targets").Cast<Dictionary<string, object>>().Any(t => t.Str("part") == "eye") ?? false))
                throw new Exception("当前已授权方案没有眼色目标，不能启用虹膜层");
            foreach (Dictionary<string, object> proposal in proposals)
            {
                var allowed = new HashSet<string> { "material_guid", "texture_guid", "source_sha256", "expected_enabled", "enable" };
                if (!allowed.SetEquals(proposal.Keys) || !(proposal["enable"] is bool enable) || !enable)
                    throw new Exception("虹膜启用提案字段无效");
                var guid = proposal.Str("material_guid");
                var path = AssetDatabase.GUIDToAssetPath(guid);
                var material = AssetDatabase.LoadAssetAtPath<Material>(path);
                if (material == null || !HasIrisMask(material) || Guid(material.GetTexture("_Main2ndTex")) != proposal.Str("texture_guid")
                    || FileDigest(Avh.Abs(path)) != proposal.Str("source_sha256")
                    || !Equals(Convert.ToSingle(proposal["expected_enabled"]), material.GetFloat("_UseMain2ndTex")) || !result.Add(guid))
                    throw new Exception("虹膜提案与实际源材质、遮罩或开关观察不一致");
            }
            return result;
        }

        static Shader DependencyAuthority()
        {
            var requestPath = Avh.Abs("Assets/_Harness/Recolor/dependencies.json");
            if (!File.Exists(requestPath)) return null;
            var request = Avh.ReadJsonFile(requestPath);
            var receipt = Avh.ReadJsonFile(Avh.Abs("Assets/_Harness/Recolor/dependency-receipt.json"));
            if (request.Str("schema") != "material-dependencies/0.1" || receipt?.Str("schema") != "material-dependency-receipt/0.1"
                || receipt.Str("request_sha256") != FileDigest(requestPath)) throw new Exception("缺少当前请求的 Runtime 依赖恢复证据");
            var roots = (Avh.ParseJson(Environment.GetEnvironmentVariable("AVH_ASSET_SEARCH_ROOTS_JSON") ?? "[]") as List<object>) ?? new List<object>();
            // The authorized root is what the person gave the Runtime and the receipt's path is what the
            // filesystem actually holds, so the two can spell the same folder in different Unicode
            // normalizations (a macOS-made zip extracts NFD) and on NTFS and ext4 those are two different
            // names. Containment is tested composed; the paths themselves are never rewritten.
            bool Within(string path, string root) => Composed(Path.GetFullPath(path)).StartsWith(
                Composed(Path.GetFullPath(root)).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar,
                Path.DirectorySeparatorChar == '\\' ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
            var expected = request.List("packages").Cast<Dictionary<string, object>>().ToList();
            var packages = receipt.List("packages").Cast<Dictionary<string, object>>().ToList();
            if (expected.Count != packages.Count) throw new Exception("依赖恢复包数量不一致");
            for (var i = 0; i < packages.Count; i++)
            {
                var package = packages[i];
                if (package.Str("archive") != expected[i].Str("archive") || package.Str("anchor") != expected[i].Str("anchor")
                    || package.Str("sha256") != expected[i].Str("sha256")
                    || !roots.Any(root => Within(package.Str("archive"), root.ToString()) && Within(package.Str("anchor"), root.ToString()))
                    || FileDigest(package.Str("archive")) != package.Str("sha256")) throw new Exception("依赖来源授权或版本已变化");
                foreach (Dictionary<string, object> asset in package.List("assets"))
                    if (!asset.Str("path").StartsWith("Assets/_Harness/Recolor/Dependencies/") || asset.Str("path").Contains("..")
                        || FileDigest(Avh.Abs(asset.Str("path"))) != asset.Str("sha256")
                        || FileDigest(Avh.Abs(asset.Str("path")+".meta")) != asset.Str("meta_sha256")) throw new Exception("派生依赖与 Runtime 来源证据不一致");
            }
            var name = request.Str("missing_shader_replacement");
            if (name == null) return null;
            return Shader.Find(name) ?? throw new Exception("请求的替代 shader 未安装，不能假定可用");
        }

        /// <summary>One comparison form for a path, so one folder is not read as two.</summary>
        static string Composed(string path) => string.IsNullOrEmpty(path) ? "" : path.Normalize(System.Text.NormalizationForm.FormC);

        static string FileDigest(string path)
        {
            using (var stream = File.OpenRead(path))
            using (var sha = System.Security.Cryptography.SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        /// <summary>Slots a plan part names: hair / eye on the body, outfit:&lt;id&gt; for every renderer of that outfit.</summary>
        static List<(Renderer renderer, int slot, Material source)> Resolve(GameObject avatar, Transform group, string part, Shader fallback, HashSet<string> irisRequests)
        {
            var found = new List<(Renderer, int, Material)>();
            IEnumerable<Renderer> bodyRenderers = avatar.GetComponentsInChildren<Renderer>(true).Where(r => group == null || !r.transform.IsChildOf(group));
            IEnumerable<Renderer> renderers;
            Func<Material, bool> wanted = m => true;
            if (part == "hair")
            {
                var installedHair = AvatarConfig.Grouped(Avh.Plan()) ? Avh.Plan().List("outfits").Cast<Dictionary<string, object>>()
                    .Where(o => o.Str("kind") == "hair").Select(o => MemberRoot(group, o.Str("id"))).Where(t => t != null)
                    .SelectMany(t => t.GetComponentsInChildren<Renderer>(true)) : Enumerable.Empty<Renderer>();
                renderers = bodyRenderers.Where(r => HairName.IsMatch(r.name)).Concat(installedHair).Distinct();
            }
            else if (part == "eye") { renderers = bodyRenderers; wanted = m => EyeName.IsMatch(m.name) || IrisLayer(m) || irisRequests.Contains(Guid(m)); }
            else if (part.StartsWith("outfit:"))
            {
                var root = MemberRoot(group, part.Substring("outfit:".Length));
                renderers = root != null ? root.GetComponentsInChildren<Renderer>(true) : Enumerable.Empty<Renderer>();
            }
            else throw new Exception($"不认识的改色部位 {part}（只认 hair / eye / outfit:<id>）");
            foreach (var renderer in renderers.Where(r => !(r is ParticleSystemRenderer)))
            {
                var materials = renderer.sharedMaterials;
                for (var i = 0; i < materials.Length; i++)
                {
                    var source = part.StartsWith("outfit:") ? MemberMaterial(renderer, i, part.Substring(7)) ?? materials[i] : materials[i];
                    if (source != null && wanted(source) && (Adjustable(source) || (fallback != null && MissingShader(source)))) found.Add((renderer, i, source));
                }
            }
            return found;
        }

        static bool Adjustable(Material m) => m.HasProperty("_MainTexHSVG") || m.HasProperty("_Color");

        static MaterialSelection ResolveMaterial(Transform group, Dictionary<string, object> target)
        {
            var outfit = target.Str("outfit");
            var root = MemberRoot(group, outfit);
            if (root == null) throw new Exception($"材质目标 {target.Str("requirement_id")} 找不到服装 {outfit}");
            var path = target.Str("material");
            if (string.IsNullOrEmpty(path) || !path.StartsWith("Assets/", StringComparison.Ordinal))
                throw new Exception($"材质目标路径不受管：{path}");
            Avh.AssertManagedPath(Avh.Abs(path));
            var material = AssetDatabase.LoadAssetAtPath<Material>(path)
                ?? throw new Exception($"材质目标无法解析：{path}");
            var directory = MaterialDirectory(material);
            var slots = new List<(Renderer renderer, int slot, Material source)>();
            foreach (var renderer in root.GetComponentsInChildren<Renderer>(true).Where(r => !(r is ParticleSystemRenderer)))
            {
                var materials = renderer.sharedMaterials;
                for (var slot = 0; slot < materials.Length; slot++)
                {
                    var source = MemberMaterial(renderer, slot, outfit) ?? materials[slot];
                    if (source != null && string.Equals(MaterialDirectory(source), directory, StringComparison.Ordinal)) slots.Add((renderer, slot, source));
                }
            }
            if (slots.Count == 0) throw new Exception($"材质目标 {target.Str("requirement_id")} 在服装 {outfit} 的目录 {directory} 命中 0 槽");
            return new MaterialSelection { Target = target, Material = material, Slots = slots };
        }

        static string MaterialDirectory(Material material)
        {
            var path = AssetDatabase.GetAssetPath(material);
            return string.IsNullOrEmpty(path) ? null : Path.GetDirectoryName(path).Replace('\\', '/');
        }
        static Transform MemberRoot(Transform group, string member)
        {
            if (!AvatarConfig.Grouped(Avh.Plan())) return group?.Find("Outfit_" + member);
            var row = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)).List("outfits").Cast<Dictionary<string, object>>().SingleOrDefault(o => o.Str("id") == member);
            return row == null || group == null ? null : group.parent.Find(row.Str("object"));
        }
        static Material MemberMaterial(Renderer renderer, int slot, string member)
        {
            if (!AvatarConfig.Grouped(Avh.Plan())) return null;
            var row = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)).List("outfits").Cast<Dictionary<string, object>>().SingleOrDefault(o => o.Str("id") == member);
            var path = Probe.HierarchyPath(renderer.transform.root, renderer.transform);
            var preset = row?.List("material_presets").Cast<Dictionary<string, object>>().SingleOrDefault(p => p.Str("renderer") == path);
            return preset == null ? null : VariantResolver.Material(preset.List("materials")[slot]);
        }

        static string Scope(string part) => AvatarConfig.Grouped(Avh.Plan()) && part.StartsWith("outfit:") ? part.Substring(7) : "";
        static void Claim(GameObject avatar, Dictionary<(Renderer, int, string), string> claimed,
            IEnumerable<(Renderer renderer, int slot, Material source)> slots, string writer, string scope = "")
        {
            foreach (var (renderer, slot, source) in slots)
            {
                var collision = claimed.FirstOrDefault(p => p.Key.Item1 == renderer && p.Key.Item2 == slot
                    && (p.Key.Item3 == scope || p.Key.Item3 == "" || scope == ""));
                if (collision.Value != null)
                    throw new Exception($"材质槽写入冲突：{Probe.HierarchyPath(avatar.transform, renderer.transform)} 槽 {slot}，{collision.Value} / {writer}");
                claimed.Add((renderer, slot, scope), writer);
            }
        }

        static void CheckMaterialLayerConflicts(GameObject avatar, List<MaterialSelection> selections, Dictionary<string, object> layerApply)
        {
            if (layerApply == null || selections.Count == 0) return;
            foreach (Dictionary<string, object> operation in layerApply.List("operations"))
            {
                var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(operation.Str("textureAsset"));
                if (texture == null) throw new Exception($"按层改色的源贴图不在工程里：{operation.Str("textureAsset")}");
                foreach (var selection in selections)
                    foreach (var (renderer, slot, source) in selection.Slots)
                        if (TextureProperties(source, texture).Count > 0)
                            throw new Exception($"材质槽写入冲突：{Probe.HierarchyPath(avatar.transform, renderer.transform)} 槽 {slot}，material:{selection.Target.Str("requirement_id")} / layer:{operation.Str("requirement_id")}");
            }
        }

        /// <summary>One region's footprint on the texture, and the pixels it alone is allowed to paint.</summary>
        class RegionMask
        {
            public Dictionary<string, object> Op;
            public string Requirement;
            public bool[] Footprint;
            public bool[] Paint;
            /// <summary>Footprint pixels a triangle that qualifies for two regions also covers.</summary>
            public int Conflicted;
        }

        /// <summary>
        /// One region group — a renderer and one of its submeshes — resolved and derived, before anything is written.
        ///
        /// Resolving every group first is what makes the cross-group question answerable: the slots a group would
        /// bind are read while no group has written yet, so two groups that would write the same slot are caught
        /// as a combination rather than ordered by accident (R6 第 5 项).
        /// </summary>
        class RegionGroup
        {
            public string Path; public int Submesh; public Renderer Renderer; public Mesh Mesh;
            public List<string> Names;
            public Texture2D Source; public string SourcePath;
            public int Width, Height;
            public Color32[] Before;
            public List<RegionMask> Masks; public bool[] Painted;
            public int Ambiguous, Conflicting, ConflictPixels;
            public List<(Renderer renderer, int slot, Material current)> Bound;
        }

        static Mesh MeshOf(Renderer renderer) => renderer is SkinnedMeshRenderer skin ? skin.sharedMesh
            : renderer.TryGetComponent<MeshFilter>(out var filter) ? filter.sharedMesh : null;

        /// <summary>The texture a region's surface is drawn with: the material's own main texture alias.</summary>
        static Texture2D MainTexture(Material material)
        {
            foreach (var property in new[] { "_MainTex", "_BaseMap", "_BaseColorMap" })
                if (material.HasProperty(property) && material.GetTexture(property) is Texture2D texture) return texture;
            return null;
        }

        /// <summary>Which vertices one region's bones influence at all, in this mesh's own bone order.</summary>
        static bool[] Members(Mesh mesh, Renderer renderer, List<string> names)
        {
            if (!(renderer is SkinnedMeshRenderer skin) || skin.bones == null || skin.bones.Length == 0)
                throw new Exception($"区域目标的渲染器不是蒙皮网格，骨骼归属无从谈起：{renderer.name}");
            var missing = names.Where(name => !skin.bones.Any(bone => bone != null && bone.name == name)).ToList();
            // A guessed bone name must fail loudly. Matching nothing would produce an empty region, which
            // reads as "this surface has no pixels" instead of "this bone does not exist on this mesh".
            if (missing.Count > 0)
                throw new Exception($"区域的骨骼不在这个网格的骨骼里：{string.Join("、", missing)}（该网格 {skin.bones.Length} 根骨骼）");
            var wanted = new HashSet<int>();
            for (var bone = 0; bone < skin.bones.Length; bone++)
                if (skin.bones[bone] != null && names.Contains(skin.bones[bone].name)) wanted.Add(bone);
            var weights = mesh.boneWeights;
            if (weights.Length != mesh.vertexCount) throw new Exception($"网格缺少逐顶点骨骼权重：{mesh.name}");
            var member = new bool[mesh.vertexCount];
            for (var vertex = 0; vertex < weights.Length; vertex++)
            {
                var weight = weights[vertex];
                member[vertex] = (weight.weight0 > 0f && wanted.Contains(weight.boneIndex0))
                    || (weight.weight1 > 0f && wanted.Contains(weight.boneIndex1))
                    || (weight.weight2 > 0f && wanted.Contains(weight.boneIndex2))
                    || (weight.weight3 > 0f && wanted.Contains(weight.boneIndex3));
            }
            return member;
        }

        /// <summary>
        /// The pixels whose centre falls inside one of these UV triangles.
        ///
        /// Centre-inside rather than area coverage: a coverage-weighted mask would put a half value on every
        /// shared edge, and two implementations of the same region would then have to agree on antialiasing
        /// before they could agree on the region. A pixel is in or out, and the rule is one sentence. The
        /// independent observer recomputes this from the exported mesh, so the rule has to be exactly this —
        /// including the three things the arithmetic would otherwise decide by itself (R6 第 7 项):
        ///
        /// * every difference, product and quotient is computed in float64 (the UVs come from the mesh as
        ///   float32 and are widened exactly), because a float32 edge function was measured to put a pixel
        ///   centre ~3.7e-9 from an edge on the wrong side — a false violation, not a rounding nuisance;
        /// * a triangle with zero area covers no pixel, or all three edge functions are zero across its
        ///   bounding box and the whole box is filled in;
        /// * a pixel exactly on an edge counts as inside on both ends: `>= 0` on one winding or `<= 0` on the
        ///   other, never `>`.
        /// </summary>
        static bool[] Rasterize(Vector2[] uv, int[] indices, int width, int height)
        {
            var mask = new bool[width * height];
            for (var triangle = 0; triangle + 2 < indices.Length; triangle += 3)
            {
                var a = uv[indices[triangle]]; var b = uv[indices[triangle + 1]]; var c = uv[indices[triangle + 2]];
                // Widened before the arithmetic, not after: a float32 product would round the bound and move it
                // by a pixel on a texture whose size is not a power of two.
                double ax = a.x, ay = a.y, bx = b.x, by = b.y, cx = c.x, cy = c.y;
                var area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
                if (area == 0.0) continue;
                var x0 = Math.Max(0, (int)Math.Floor(Math.Min(ax, Math.Min(bx, cx)) * width - 0.5));
                var x1 = Math.Min(width - 1, (int)Math.Ceiling(Math.Max(ax, Math.Max(bx, cx)) * width - 0.5));
                var y0 = Math.Max(0, (int)Math.Floor(Math.Min(ay, Math.Min(by, cy)) * height - 0.5));
                var y1 = Math.Min(height - 1, (int)Math.Ceiling(Math.Max(ay, Math.Max(by, cy)) * height - 0.5));
                if (x1 < x0 || y1 < y0) continue;
                for (var y = y0; y <= y1; y++)
                    for (var x = x0; x <= x1; x++)
                    {
                        double u = (x + 0.5) / width, v = (y + 0.5) / height;
                        var s0 = (bx - ax) * (v - ay) - (by - ay) * (u - ax);
                        var s1 = (cx - bx) * (v - by) - (cy - by) * (u - bx);
                        var s2 = (ax - cx) * (v - cy) - (ay - cy) * (u - cx);
                        if ((s0 >= 0 && s1 >= 0 && s2 >= 0) || (s0 <= 0 && s1 <= 0 && s2 <= 0)) mask[y * width + x] = true;
                    }
            }
            return mask;
        }

        static int[] OwnedIndices(int[] indices, int[] owner, int position)
        {
            var kept = new List<int>();
            for (var triangle = 0; triangle < owner.Length; triangle++)
                if (owner[triangle] == position)
                {
                    kept.Add(indices[triangle * 3]); kept.Add(indices[triangle * 3 + 1]); kept.Add(indices[triangle * 3 + 2]);
                }
            return kept.ToArray();
        }

        /// <summary>The triangles that qualify for more than one region, as index triples.</summary>
        static int[] ConflictIndices(int[] indices, int[] qualifying)
        {
            var kept = new List<int>();
            for (var triangle = 0; triangle < qualifying.Length; triangle++)
                if (qualifying[triangle] > 1)
                {
                    kept.Add(indices[triangle * 3]); kept.Add(indices[triangle * 3 + 1]); kept.Add(indices[triangle * 3 + 2]);
                }
            return kept.ToArray();
        }

        static Color32 TargetColour(string hex)
        {
            var value = (hex ?? "").TrimStart('#');
            if (value.Length != 6) throw new Exception($"区域目标的颜色要写成 #RRGGBB：{hex}");
            return new Color32(Convert.ToByte(value.Substring(0, 2), 16), Convert.ToByte(value.Substring(2, 2), 16),
                Convert.ToByte(value.Substring(4, 2), 16), 255);
        }

        static Dictionary<string, object> Tone(Color32[] pixels, bool[] mask)
        {
            var list = new List<object>(); long r = 0, g = 0, b = 0, n = 0;
            for (var index = 0; index < pixels.Length; index++)
                // A fully transparent pixel carries no colour, so it is not part of a mean that claims to be the
                // colour of a surface.
                if (mask[index] && pixels[index].a != 0) { r += pixels[index].r; g += pixels[index].g; b += pixels[index].b; n++; }
            if (n == 0) return new Dictionary<string, object> { ["pixels"] = 0, ["mean"] = null };
            list.Add(Math.Round((double)r / n, 2)); list.Add(Math.Round((double)g / n, 2)); list.Add(Math.Round((double)b / n, 2));
            return new Dictionary<string, object> { ["pixels"] = n, ["mean"] = list };
        }

        /// <summary>
        /// Turn the recipe's regions into recoloured textures, and record where each one was allowed to paint.
        ///
        /// The region comes from the mesh, not from the texture: the author names bones, the mesh says which
        /// triangles those bones hold, and the triangles' UVs say which pixels belong to the region. That is
        /// what lets two irises on one texture be told apart when no layer means "this eye" — and it is also
        /// why a pixel two regions both claim is painted by neither: it has no single owner, so giving it
        /// either colour would paint one eye onto the other. A pixel a *triangle* with two owners covers is the
        /// same finding and is subtracted from every paint set, not merely dropped from the assignment.
        ///
        /// Every group is resolved and derived before anything is written, so a combination that cannot be
        /// proven safe — two groups on one source texture, or two groups writing one slot — is refused as a
        /// combination instead of being settled by whichever ran last (R6 第 5 项).
        /// </summary>
        static void BindRegions(GameObject avatar, List<Dictionary<string, object>> ops, List<MaterialSelection> selections,
            Dictionary<(Renderer, Material, string), Copy> copies, List<object> rows)
        {
            OutfitStage.EnsureFolder(RegionDir);
            var planned = new List<RegionGroup>();
            foreach (var group in ops.GroupBy(op => (path: op.Obj("region").Str("renderer"), submesh: Convert.ToInt32(op.Obj("region")["submesh"]))))
            {
                var wanted = group.ToList();
                var renderer = FindRenderer(avatar, group.Key.path) ?? throw new Exception($"区域目标找不到渲染器：{group.Key.path}");
                // A material selection replaces the whole slot the region paints on. Both write the same slot, and
                // whichever ran last would silently win, so the pair is refused rather than ordered by accident.
                foreach (var selection in selections)
                    foreach (var (claimedRenderer, claimedSlot, _source) in selection.Slots)
                        if (claimedRenderer == renderer && claimedSlot == group.Key.submesh)
                            throw new Exception($"材质槽写入冲突：{Probe.HierarchyPath(avatar.transform, renderer.transform)} 槽 {claimedSlot}，"
                                + $"material:{selection.Target.Str("requirement_id")} / region:{wanted[0].Str("requirement_id")}");
                var mesh = MeshOf(renderer) ?? throw new Exception($"区域目标的渲染器没有网格：{group.Key.path}");
                if (!mesh.isReadable) throw new Exception($"网格不可读（Read/Write 关闭），无法从 UV 足迹导出区域：{mesh.name}");
                if (group.Key.submesh < 0 || group.Key.submesh >= mesh.subMeshCount)
                    throw new Exception($"区域目标的子网格超范围：{group.Key.path} 子网格 {group.Key.submesh}（共 {mesh.subMeshCount} 个）");
                var indices = mesh.GetIndices(group.Key.submesh);
                var triangles = indices.Length / 3;
                var owner = Enumerable.Repeat(-1, triangles).ToArray();
                var qualifying = new int[triangles];
                for (var position = 0; position < wanted.Count; position++)
                {
                    // A triangle belongs to a region only when **all three** vertices are influenced by one of
                    // that region's bones. A triangle straddling two regions would otherwise claim pixels on
                    // both sides, and the region's whole point is that the vendor's own skinning decides.
                    var member = Members(mesh, renderer, wanted[position].Obj("region").List("bones").Select(bone => bone.ToString()).ToList());
                    for (var triangle = 0; triangle < triangles; triangle++)
                    {
                        if (!(member[indices[triangle * 3]] && member[indices[triangle * 3 + 1]] && member[indices[triangle * 3 + 2]])) continue;
                        if (owner[triangle] < 0) owner[triangle] = position;
                        qualifying[triangle]++;
                    }
                }
                var conflicting = 0;
                for (var triangle = 0; triangle < triangles; triangle++)
                    if (qualifying[triangle] > 1) { owner[triangle] = -1; conflicting++; }
                var material = renderer.sharedMaterials[group.Key.submesh] ?? throw new Exception($"区域目标的材质槽是空的：{group.Key.path} 槽 {group.Key.submesh}");
                var source = MainTexture(material) ?? throw new Exception($"区域目标的材质没有主贴图：{AssetDatabase.GetAssetPath(material)}");
                var sourcePath = AssetDatabase.GetAssetPath(source);
                if (string.IsNullOrEmpty(sourcePath) || !File.Exists(Avh.Abs(sourcePath)))
                    throw new Exception($"区域目标的贴图不是工程里的文件：{sourcePath}");
                // The input has to be a file the project shipped, not something this layer wrote: a region derived
                // from another writer's product would be checking its own arithmetic against itself.
                if (Composed(sourcePath).StartsWith(Dir + "/", StringComparison.Ordinal))
                    throw new Exception($"区域目标的贴图是本层自己写出来的产物，不是工程原有的文件：{sourcePath}");
                // The pixels come from the file the project shipped, not from the imported texture's GPU copy:
                // re-encoding a sampled texture would move colour values everywhere, and "nothing outside the
                // region moved" would then be untrue for reasons that have nothing to do with the region. The
                // mask is derived at that file's own size — `maxTextureSize` is the importer's runtime budget,
                // so a 4096 sheet imported at 2048 would otherwise rasterise a 2048 mask and then refuse its own
                // 4096 decode as a size mismatch, blocking the order's own eye texture (R6 第 1 项).
                var decoded = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                if (!ImageConversion.LoadImage(decoded, File.ReadAllBytes(Avh.Abs(sourcePath))))
                    throw new Exception($"贴图无法解码：{sourcePath}");
                var width = decoded.width; var height = decoded.height;
                var before = decoded.GetPixels32();
                UnityEngine.Object.DestroyImmediate(decoded);
                // The footprint of triangles that qualify for two regions: their surface is shared, so the pixels
                // they cover have no owner either, exactly like a pixel two regions' footprints both cover.
                var contested = Rasterize(mesh.uv, ConflictIndices(indices, qualifying), width, height);
                var masks = new List<RegionMask>();
                for (var position = 0; position < wanted.Count; position++)
                    masks.Add(new RegionMask
                    {
                        Op = wanted[position], Requirement = wanted[position].Str("requirement_id"),
                        Footprint = Rasterize(mesh.uv, OwnedIndices(indices, owner, position), width, height),
                    });
                var conflictPixels = contested.Count(bit => bit);
                foreach (var entry in masks)
                {
                    var alone = (bool[])entry.Footprint.Clone();
                    foreach (var other in masks) if (!ReferenceEquals(other, entry))
                        for (var index = 0; index < alone.Length; index++) if (other.Footprint[index]) alone[index] = false;
                    var conflicted = 0;
                    for (var index = 0; index < alone.Length; index++)
                        if (entry.Footprint[index] && contested[index]) { alone[index] = false; conflicted++; }
                    entry.Conflicted = conflicted;
                    entry.Paint = alone;
                }
                foreach (var entry in masks)
                {
                    if (!entry.Footprint.Any(bit => bit))
                        throw new Exception($"区域 {entry.Requirement} 在这张贴图上没有覆盖任何像素：{group.Key.path} 子网格 {group.Key.submesh}");
                    // Every pixel of a region being claimed by another region too — or covered only by triangles
                    // that belong to two regions — means the two are the same surface, and no colour can be
                    // applied to one of them alone. Refusing is the only honest answer.
                    if (!entry.Paint.Any(bit => bit))
                        throw new Exception($"区域 {entry.Requirement} 的排他像素为 0：它和另一个区域在 UV 上完全重叠，"
                            + $"或它的像素全被同时属于两个区域的三角形盖住，无法单独上色");
                    // A pixel that is fully transparent carries no colour, so a region made only of those has no
                    // colour to set and nothing to measure: the stage refuses rather than writing a change that
                    // is invisible on the model and unverifiable in the file (R6 第 6 项).
                    var visible = false;
                    for (var index = 0; index < entry.Paint.Length && !visible; index++)
                        visible = entry.Paint[index] && before[index].a != 0;
                    if (!visible)
                        throw new Exception($"区域 {entry.Requirement} 在这张贴图上没有一个可见像素（区域内的像素全是透明的），无法按声明的语义上色");
                }
                var painted = new bool[width * height];
                var ambiguous = 0;
                for (var index = 0; index < painted.Length; index++)
                {
                    var claiming = 0; var paintable = false;
                    foreach (var entry in masks)
                    {
                        if (entry.Footprint[index]) claiming++;
                        if (entry.Paint[index]) paintable = true;
                    }
                    if (claiming > 1) ambiguous++;
                    painted[index] = paintable;
                }
                // Which slots this group would bind, read now, while no group has written anything.
                var bound = new List<(Renderer renderer, int slot, Material current)>();
                foreach (var target in avatar.GetComponentsInChildren<Renderer>(true))
                {
                    var materials = target.sharedMaterials;
                    for (var slot = 0; slot < materials.Length; slot++)
                        if (materials[slot] != null && TextureProperties(materials[slot], source).Count > 0)
                            bound.Add((target, slot, materials[slot]));
                }
                if (bound.Count == 0) throw new Exception($"区域改色的目标贴图没有任何槽位在用：{sourcePath}");
                // The region was derived from one surface's triangles, so the product may only be bound where that
                // surface is. Another slot that happens to read the same texture is a surface whose UVs were never
                // part of the derivation, and binding there would dye pixels nobody computed — the same failure as
                // painting a pixel with no owner, one surface further out (R6 第 5 项).
                foreach (var (holder, holderSlot, _material) in bound)
                    if (holder != renderer || holderSlot != group.Key.submesh)
                        throw new Exception($"区域改色的源贴图还被别的表面用着："
                            + $"{Probe.HierarchyPath(avatar.transform, holder.transform)} 槽 {holderSlot}"
                            + $"（区域只从 {group.Key.path} 子网格 {group.Key.submesh} 的三角形导出，"
                            + $"没有算过那块表面的 UV）——这一组合不能证明安全");
                planned.Add(new RegionGroup
                {
                    Path = group.Key.path, Submesh = group.Key.submesh, Renderer = renderer, Mesh = mesh,
                    Names = wanted.Select(op => op.Str("requirement_id")).ToList(), Source = source, SourcePath = sourcePath,
                    Width = width, Height = height, Before = before, Masks = masks, Painted = painted,
                    Ambiguous = ambiguous, Conflicting = conflicting, ConflictPixels = conflictPixels, Bound = bound,
                });
            }
            // No second pass over the groups is needed for the cross-group case: a group's binding set is every
            // slot that reads its source texture, so two groups on one texture — or two groups on one slot —
            // always put another surface into one of the two sets and are refused by the check above. That check
            // is the stricter one, because it refuses the single-group form of the same hazard too.

            var groups = new List<object>();
            foreach (var entry in planned)
            {
                var after = (Color32[])entry.Before.Clone();
                foreach (var mask in entry.Masks)
                {
                    var target = TargetColour(mask.Op.Str("color"));
                    var semantics = mask.Op.Str("semantics");
                    if (semantics != "flat" && semantics != "shade")
                        throw new Exception($"区域 {mask.Requirement} 的语义只能是 flat 或 shade：{semantics}");
                    for (var index = 0; index < after.Length; index++)
                    {
                        if (!mask.Paint[index]) continue;
                        var pixel = entry.Before[index];
                        // A fully transparent pixel carries no colour, so it has none to change: the file has to
                        // come back byte for byte where nothing is drawn, and the observer checks exactly that.
                        if (pixel.a == 0) continue;
                        if (semantics == "flat") after[index] = new Color32(target.r, target.g, target.b, pixel.a);
                        else
                        {
                            // The author's light and shade are kept by scaling every channel by the pixel's
                            // brightest channel over the target's. Double precision and one stated rounding rule
                            // — floor(x + 0.5) — because the observer recomputes these very pixels and compares
                            // them, so a halfway rule that differs between the two ends would be a false
                            // violation rather than a stricter check (R6 第 6/7 项).
                            double top = Math.Max(pixel.r, Math.Max(pixel.g, pixel.b));
                            double reference = Math.Max(Math.Max(target.r, Math.Max(target.g, target.b)), 1.0);
                            double ratio = top / reference;
                            after[index] = new Color32(
                                (byte)Mathf.Clamp((int)Math.Floor(target.r * ratio + 0.5), 0, 255),
                                (byte)Mathf.Clamp((int)Math.Floor(target.g * ratio + 0.5), 0, 255),
                                (byte)Mathf.Clamp((int)Math.Floor(target.b * ratio + 0.5), 0, 255), pixel.a);
                        }
                    }
                }
                var changed = 0; var alphaMoved = 0; var outside = false;
                for (var index = 0; index < after.Length; index++)
                {
                    if (entry.Before[index].a != after[index].a) alphaMoved++;
                    if (entry.Before[index].r == after[index].r && entry.Before[index].g == after[index].g && entry.Before[index].b == after[index].b) continue;
                    changed++;
                    if (!entry.Painted[index]) outside = true;
                }
                if (alphaMoved != 0) throw new Exception($"区域改色动了 alpha：{entry.Path} 子网格 {entry.Submesh}");
                if (outside) throw new Exception($"区域改色改到了所有区域之外：{entry.Path} 子网格 {entry.Submesh}");
                var stem = Sanitize(entry.Path) + "_sm" + entry.Submesh;
                var outputPath = $"{RegionDir}/{stem}.regions.png";
                var meshPath = $"{RegionDir}/{stem}.mesh.json";
                Directory.CreateDirectory(Avh.Abs(RegionDir));
                var sheet = new Texture2D(entry.Width, entry.Height, TextureFormat.RGBA32, false);
                sheet.SetPixels32(after); sheet.Apply();
                File.WriteAllBytes(Avh.Abs(outputPath), ImageConversion.EncodeToPNG(sheet));
                UnityEngine.Object.DestroyImmediate(sheet);
                AssetDatabase.ImportAsset(outputPath);
                // The new texture must be read the way the original was, or the same pixels mean another colour.
                // This runs after the pixels are decided, never before: the importer's size budget is a runtime
                // setting and must not decide how many pixels the region has.
                MatchImporter(entry.SourcePath, outputPath);
                Avh.WriteJson(Avh.Abs(meshPath), MeshDatum(entry.Path, entry.Submesh, entry.Mesh, entry.Renderer, entry.Width, entry.Height, entry.SourcePath));
                AssetDatabase.ImportAsset(meshPath);

                var operations = new List<object>();
                foreach (var mask in entry.Masks)
                {
                    var maskPath = $"{RegionDir}/{stem}__{Sanitize(mask.Requirement)}.mask.png";
                    var maskTexture = new Texture2D(entry.Width, entry.Height, TextureFormat.RGBA32, false);
                    var bits = new Color32[entry.Width * entry.Height];
                    for (var index = 0; index < bits.Length; index++)
                        bits[index] = mask.Paint[index] ? new Color32(255, 255, 255, 255) : new Color32(0, 0, 0, 255);
                    maskTexture.SetPixels32(bits); maskTexture.Apply();
                    File.WriteAllBytes(Avh.Abs(maskPath), ImageConversion.EncodeToPNG(maskTexture));
                    UnityEngine.Object.DestroyImmediate(maskTexture);
                    AssetDatabase.ImportAsset(maskPath);
                    operations.Add(new Dictionary<string, object>
                    {
                        ["requirement_id"] = mask.Requirement, ["bones"] = mask.Op.Obj("region").List("bones"),
                        // The surface is declared on the operation as well as on the group: the observer checks
                        // each operation against the approved plan item by item, which a group level alone
                        // could not do (R6 第 4 项).
                        ["renderer"] = entry.Path, ["submesh"] = entry.Submesh,
                        ["color"] = mask.Op.Str("color"), ["semantics"] = mask.Op.Str("semantics"),
                        ["maskAsset"] = maskPath, ["maskSha256"] = FileDigest(Avh.Abs(maskPath)),
                        ["maskPixels"] = mask.Paint.Count(bit => bit),
                        ["footprintPixels"] = mask.Footprint.Count(bit => bit),
                        ["conflictedPixels"] = mask.Conflicted,
                        ["meanBefore"] = Tone(entry.Before, mask.Paint), ["meanAfter"] = Tone(after, mask.Paint),
                    });
                }
                var replacement = AssetDatabase.LoadAssetAtPath<Texture2D>(outputPath)
                    ?? throw new Exception($"区域改色的产物不在工程里：{outputPath}");
                var bound = 0;
                foreach (var (target, slot, current) in entry.Bound)
                {
                    var materials = target.sharedMaterials;
                    var properties = TextureProperties(current, entry.Source);
                    if (properties.Count == 0) continue;
                    // The slot may already hold the relative writer's final copy. Reuse it so the binding lands
                    // on the material the renderer actually uses, and keep the source identity.
                    var copy = copies.Values.FirstOrDefault(item => item.Material == current);
                    if (copy == null && !copies.TryGetValue((target, current, ""), out copy))
                        copies[(target, current, "")] = copy = new Copy { Source = current, Baseline = new Material(current),
                            Material = MakeCopy(avatar, target, current),
                            Part = "region:" + string.Join(",", entry.Names) };
                    foreach (var property in properties) copy.Material.SetTexture(property, replacement);
                    materials[slot] = copy.Material;
                    target.sharedMaterials = materials;
                    bound++;
                    // One row per requirement, not one row for the first: the slot this texture is on has to be
                    // recorded for every requirement that paints it, or the independent reader sees the others as
                    // unbound. F21 counts deduplicated slots, so several rows on one slot do not inflate the
                    // ledger (R6 第 2 项).
                    foreach (var requirement in entry.Names)
                        rows.Add(new Dictionary<string, object>
                        {
                            ["renderer"] = Probe.HierarchyPath(avatar.transform, target.transform), ["slot"] = slot,
                            ["part"] = "region:" + requirement,
                            ["original"] = AssetDatabase.GetAssetPath(copy.Source), ["original_guid"] = Guid(copy.Source),
                            ["material"] = AssetDatabase.GetAssetPath(copy.Material), ["material_guid"] = Guid(copy.Material),
                            ["texture_property"] = string.Join(",", properties), ["texture"] = outputPath,
                            ["texture_guid"] = Guid(replacement), ["replaced_texture"] = entry.SourcePath,
                            ["import"] = ImportReadback(outputPath),
                        });
                }
                if (bound == 0) throw new Exception($"区域改色的目标贴图没有任何槽位在用：{entry.SourcePath}");
                groups.Add(new Dictionary<string, object>
                {
                    ["renderer"] = entry.Path, ["submesh"] = entry.Submesh,
                    ["mesh"] = entry.Mesh.name, ["bones"] = entry.Mesh.boneWeights.Length,
                    ["textureAsset"] = entry.SourcePath, ["textureSha256"] = FileDigest(Avh.Abs(entry.SourcePath)),
                    ["outputAsset"] = outputPath, ["outputSha256"] = FileDigest(Avh.Abs(outputPath)),
                    ["meshAsset"] = meshPath, ["meshSha256"] = FileDigest(Avh.Abs(meshPath)),
                    ["width"] = entry.Width, ["height"] = entry.Height, ["ambiguousPixels"] = entry.Ambiguous,
                    ["conflictingTriangles"] = entry.Conflicting, ["conflictPixels"] = entry.ConflictPixels,
                    ["changedPixels"] = changed,
                    ["requirements"] = entry.Names.Cast<object>().ToList(),
                    ["operations"] = operations,
                });
            }
            Avh.WriteJson(Avh.Abs(RegionApplyPath), new Dictionary<string, object> { ["schema"] = RegionSchema, ["groups"] = groups });
            AssetDatabase.ImportAsset(RegionApplyPath);
        }

        /// <summary>
        /// The mesh a region was derived from, so an independent reader can derive it again.
        ///
        /// `bones` is the renderer's own bone list, because a vertex's weight names an index into it: without
        /// the names the indices mean nothing, and a region named by bone could not be re-derived by anyone.
        /// </summary>
        static Dictionary<string, object> MeshDatum(string renderer, int submesh, Mesh mesh, Renderer source, int width, int height, string texture)
        {
            if (!(source is SkinnedMeshRenderer skin)) throw new Exception("区域数据只能从蒙皮网格导出");
            var bones = skin.bones.Select(bone => bone == null ? "" : bone.name).Cast<object>().ToList();
            var uv = new List<object>();
            foreach (var corner in mesh.uv) uv.Add(new List<object> { (double)corner.x, (double)corner.y });
            var weights = mesh.boneWeights;
            var entries = new List<object>[mesh.vertexCount];
            for (var vertex = 0; vertex < mesh.vertexCount; vertex++)
            {
                var weight = weights[vertex];
                var list = new List<object>();
                if (weight.weight0 > 0f) list.Add(weight.boneIndex0);
                if (weight.weight1 > 0f) list.Add(weight.boneIndex1);
                if (weight.weight2 > 0f) list.Add(weight.boneIndex2);
                if (weight.weight3 > 0f) list.Add(weight.boneIndex3);
                entries[vertex] = list;
            }
            return new Dictionary<string, object>
            {
                ["schema"] = "mesh-region-datum/0.1", ["renderer"] = renderer, ["submesh"] = submesh,
                ["mesh"] = mesh.name, ["bones"] = bones, ["boneSlots"] = bones.Count,
                ["uv"] = uv, ["triangles"] = mesh.GetIndices(submesh).ToList(), ["vertexBones"] = entries,
                ["texture"] = new Dictionary<string, object> { ["width"] = width, ["height"] = height, ["asset"] = texture },
            };
        }

        public static void MeasureMaterialTargets() => Avh.Stage("recolor-material-readback", MaterialTargetReadback, save: false);

        /// <summary>Reload both layers and resolve the authorized plan, independently of the executor's ledger.</summary>
        public static void MaterialTargetReadback()
        {
            var planText = Avh.Env("AVH_PLAN", "{}");
            var plan = Avh.ParseJson(planText) as Dictionary<string, object>;
            var wanted = plan?.Obj("recolor")?.List("targets").Cast<Dictionary<string, object>>().ToList()
                ?? new List<Dictionary<string, object>>();
            var materialTargets = wanted.Where(t => t.ContainsKey("material")).ToList();
            var regionRecord = Avh.ReadJsonFile(Avh.Abs(RegionApplyPath));
            var hasRegions = (regionRecord?.List("groups").Count ?? 0) > 0;
            if (materialTargets.Count == 0 && !AvatarConfig.Grouped(Avh.Plan()) && !hasRegions) return;
            AssetDatabase.Refresh();
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var before = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath));
            var after = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(AvatarPath));
            try
            {
                var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
                var group = before.transform.Find(record.Str("group") ?? OutfitStage.Group);
                var selections = materialTargets.Select(t => ResolveMaterial(group, t)).ToList();
                var claims = new Dictionary<(Renderer, int, string), string>();
                foreach (var target in wanted.Where(t => t.ContainsKey("part")))
                    Claim(before, claims, Resolve(before, group, target.Str("part"), DependencyAuthority(), IrisRequests()), target.Str("part"), Scope(target.Str("part")));
                foreach (var selection in selections) Claim(before, claims, selection.Slots, "material:" + selection.Target.Str("requirement_id"), selection.Target.Str("outfit"));
                CheckMaterialLayerConflicts(before, selections, Avh.ReadJsonFile(Avh.Abs(LayerApplyPath)));
                var bindings = new List<object>();
                var relativeBindings = new List<object>();
                var slots = new List<object>();
                foreach (var selection in selections)
                {
                    if (AvatarConfig.Grouped(Avh.Plan()))
                    {
                        var preset = AssetDatabase.LoadAssetAtPath<AnimationClip>(PresetPath(selection.Target.Str("outfit")))
                            ?? throw new Exception("改色成员缺少持久材质绑定");
                        preset.SampleAnimation(after, 0);
                    }
                    foreach (var (renderer, slot, source) in selection.Slots)
                    {
                        var path = Probe.HierarchyPath(before.transform, renderer.transform);
                        var actual = FindRenderer(after, path)?.sharedMaterials;
                        bindings.Add(new Dictionary<string, object> {
                            ["renderer"] = path, ["slot"] = slot, ["outfit"] = selection.Target.Str("outfit"),
                            ["requirement_id"] = selection.Target.Str("requirement_id"), ["expected_guid"] = Guid(selection.Material),
                            ["actual_guid"] = actual != null && slot < actual.Length && actual[slot] != null ? Guid(actual[slot]) : null,
                        });
                    }
                foreach (var renderer in after.GetComponentsInChildren<Renderer>(true).Where(r => !(r is ParticleSystemRenderer)))
                {
                    var path = Probe.HierarchyPath(after.transform, renderer.transform);
                    var original = FindRenderer(before, path)?.sharedMaterials;
                    for (var slot = 0; slot < renderer.sharedMaterials.Length; slot++)
                        slots.Add(new Dictionary<string, object> { ["renderer"] = path, ["slot"] = slot,
                            ["member"] = AvatarConfig.Grouped(Avh.Plan()) ? selection.Target.Str("outfit") : null,
                            ["material_guid"] = renderer.sharedMaterials[slot] != null ? Guid(renderer.sharedMaterials[slot]) : null,
                            ["original_guid"] = original != null && slot < original.Length && original[slot] != null ? Guid(original[slot]) : null });
                }
                }
                foreach (var target in wanted.Where(t => t.ContainsKey("part")))
                {
                    var member = Scope(target.Str("part"));
                    if (member != "")
                    {
                        var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(PresetPath(member)) ?? throw new Exception("改色成员缺少实际绑定");
                        clip.SampleAnimation(after, 0);
                    }
                    foreach (var (renderer, slot, source) in Resolve(before, group, target.Str("part"), DependencyAuthority(), IrisRequests()))
                    {
                        var path = Probe.HierarchyPath(before.transform, renderer.transform);
                        var materials = FindRenderer(after, path)?.sharedMaterials;
                        relativeBindings.Add(new Dictionary<string, object> { ["part"] = target.Str("part"), ["member"] = member,
                            ["renderer"] = path, ["slot"] = slot, ["original_guid"] = Guid(source),
                            ["actual_guid"] = materials != null && slot < materials.Length && materials[slot] != null ? Guid(materials[slot]) : null });
                    }
                }
                var paths = AssetDatabase.GetDependencies(new[] { OutfitStage.AvatarPath, AvatarPath }.Concat(materialTargets.Select(t => t.Str("material"))).ToArray(), true)
                    .Concat(new[] { OutfitStage.RecordPath, RecipePath }).Where(p => File.Exists(Avh.Abs(p))).Distinct().ToList();
                if (File.Exists(Avh.Abs(LayerApplyPath))) paths.Add(LayerApplyPath);
                if (AvatarConfig.Grouped(Avh.Plan())) paths.AddRange(AssetDatabase.GetDependencies(
                    record.List("outfits").Cast<Dictionary<string, object>>().Select(row => PresetPath(row.Str("id"))).ToArray(), true));
                var axisBindings = new List<object>();
                var defaultSlots = new List<object>();
                if (AvatarConfig.Grouped(Avh.Plan()))
                {
                    // Reload the saved recolor prefab before any member replay can hide a bad default.
                    var saved = AssetDatabase.LoadAssetAtPath<GameObject>(AvatarPath);
                    foreach (var renderer in saved.GetComponentsInChildren<Renderer>(true).Where(r => !(r is ParticleSystemRenderer)))
                    {
                        var path = Probe.HierarchyPath(saved.transform, renderer.transform);
                        var original = FindRenderer(before, path)?.sharedMaterials;
                        for (var slot = 0; slot < renderer.sharedMaterials.Length; slot++) defaultSlots.Add(new Dictionary<string, object> {
                            ["renderer"] = path, ["slot"] = slot, ["actual_guid"] = Guid(renderer.sharedMaterials[slot]),
                            ["original_guid"] = original != null && slot < original.Length ? Guid(original[slot]) : null });
                    }
                    var defaults = AvatarConfig.Defaults(Avh.Plan());
                    foreach (var axis in MaterialAxes.Groups(Avh.Plan()))
                    {
                        foreach (Dictionary<string, object> member in axis.List("members")) foreach (var slot in MaterialAxes.Slots(axis, record))
                        {
                            var expected = MaterialAxes.Expected(Avh.Plan(), member, slot.Binding.Str("id"));
                            var actual = saved.transform.Find(slot.Path)?.GetComponent<Renderer>()?.sharedMaterials.ElementAtOrDefault(slot.Index);
                            axisBindings.Add(new Dictionary<string, object> { ["group"] = axis.Str("id"), ["member"] = member.Str("id"),
                                ["binding"] = slot.Binding.Str("id"), ["renderer"] = slot.Path, ["slot"] = slot.Index,
                                ["default"] = AvatarConfig.Selected(axis, member, defaults), ["expected_guid"] = Guid(expected), ["actual_guid"] = Guid(actual) });
                        }
                    }
                    if (MaterialAxes.Groups(Avh.Plan()).Any()) paths.Add(MaterialAxes.RecordPath);
                    paths.AddRange(AssetDatabase.GetDependencies(MaterialAxes.Presets(Avh.Plan()).Select(p => p.Str("material")).ToArray(), true));
                    if (AssetDatabase.IsValidFolder(MaterialAxes.Dir)) paths.AddRange(AssetDatabase.FindAssets("t:Material", new[] { MaterialAxes.Dir }).Select(AssetDatabase.GUIDToAssetPath));
                }
                var files = new Dictionary<string, object>();
                foreach (var path in paths.Distinct())
                {
                    files[path] = FileDigest(Avh.Abs(path));
                    if (File.Exists(Avh.Abs(path + ".meta"))) files[path + ".meta"] = FileDigest(Avh.Abs(path + ".meta"));
                }
                Dictionary<string, object> regionBindings = null;
                if (hasRegions)
                {
                    regionBindings = RegionBindingReadback(after, regionRecord, planText);
                    foreach (var path in ((Dictionary<string, object>)regionBindings["files"]).Keys)
                        files[path] = FileDigest(Avh.Abs(path));
                }
                Avh.WriteJson(Path.Combine(Avh.RunDir, "observations", "material-selection-readback.json"), new Dictionary<string, object> {
                    ["schema"] = "material-selection-readback/0.1", ["plan_sha256"] = LocalOperations.Digest(planText),
                    ["files"] = files, ["bindings"] = bindings, ["slots"] = slots, ["relative_bindings"] = relativeBindings,
                    ["region_bindings"] = regionBindings, ["material_axis_bindings"] = axisBindings, ["material_default_slots"] = defaultSlots,
                });
            }
            finally { UnityEngine.Object.DestroyImmediate(before); UnityEngine.Object.DestroyImmediate(after); }
        }

        /// <summary>
        /// Read the saved recolour variant back through Unity's asset/database and prefab instantiation path.
        /// This is the authoritative region binding evidence: model prefabs (including FBX-backed renderers),
        /// stripped components and nested instances are resolved by Unity itself rather than by YAML guesses.
        /// </summary>
        static Dictionary<string, object> RegionBindingReadback(GameObject avatar, Dictionary<string, object> record,
            string planText)
        {
            var declared = new List<object>();
            var outputs = new Dictionary<string, string>();
            foreach (var group in record.List("groups").Cast<Dictionary<string, object>>())
            {
                var output = group.Str("outputAsset");
                var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(output);
                var outputGuid = texture == null ? null : Guid(texture);
                if (string.IsNullOrEmpty(outputGuid)) throw new Exception($"区域绑定读回缺少产物 GUID：{output}");
                outputs[outputGuid] = output;
                declared.Add(new Dictionary<string, object> {
                    ["renderer"] = group.Str("renderer"), ["slot"] = Convert.ToInt32(group["submesh"]),
                    ["outputAsset"] = output, ["output_guid"] = outputGuid,
                    ["requirements"] = group.List("requirements"),
                });
            }
            var all = new List<object>();
            var actual = new List<object>();
            foreach (var renderer in avatar.GetComponentsInChildren<Renderer>(true))
            {
                var path = Probe.HierarchyPath(avatar.transform, renderer.transform);
                var materials = renderer.sharedMaterials;
                for (var slot = 0; slot < materials.Length; slot++)
                {
                    var material = materials[slot];
                    if (material == null) continue;
                    var textures = new List<object>();
                    foreach (var property in new[] { "_MainTex", "_BaseMap", "_BaseColorMap" })
                    {
                        if (!material.HasProperty(property) || !(material.GetTexture(property) is Texture texture)) continue;
                        var textureGuid = Guid(texture);
                        if (string.IsNullOrEmpty(textureGuid)) continue;
                        var entry = new Dictionary<string, object> {
                            ["property"] = property, ["asset"] = AssetDatabase.GetAssetPath(texture), ["guid"] = textureGuid,
                        };
                        var same = textures.Cast<Dictionary<string, object>>().FirstOrDefault(t => t.Str("guid") == textureGuid);
                        if (same == null) textures.Add(entry);
                        else same["property"] = same.Str("property") + "," + property;
                    }
                    var row = new Dictionary<string, object> {
                        ["renderer"] = path, ["slot"] = slot, ["material_guid"] = Guid(material), ["textures"] = textures,
                    };
                    all.Add(row);
                    foreach (var texture in textures.Cast<Dictionary<string, object>>())
                        if (outputs.ContainsKey(texture.Str("guid")))
                            actual.Add(new Dictionary<string, object> {
                                ["renderer"] = path, ["slot"] = slot, ["material_guid"] = Guid(material),
                                ["texture_guid"] = texture.Str("guid"), ["texture_asset"] = texture.Str("asset"),
                                ["properties"] = texture.Str("property"),
                            });
                }
            }
            var dependencyRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
                OutfitStage.AvatarPath, AvatarPath, RegionApplyPath, LedgerPath,
            };
            foreach (var group in record.List("groups").Cast<Dictionary<string, object>>())
            {
                foreach (var field in new[] { "textureAsset", "outputAsset", "meshAsset" })
                    if (!string.IsNullOrEmpty(group.Str(field))) dependencyRoots.Add(group.Str(field));
                foreach (var operation in group.List("operations").Cast<Dictionary<string, object>>())
                    if (!string.IsNullOrEmpty(operation.Str("maskAsset"))) dependencyRoots.Add(operation.Str("maskAsset"));
            }
            var dependencyFiles = new HashSet<string>(dependencyRoots, StringComparer.OrdinalIgnoreCase);
            foreach (var path in AssetDatabase.GetDependencies(dependencyRoots.Where(path => File.Exists(Avh.Abs(path))).ToArray(), true))
                dependencyFiles.Add(path);
            var fileHashes = new Dictionary<string, object>();
            foreach (var path in dependencyFiles)
            {
                if (!File.Exists(Avh.Abs(path))) throw new Exception($"区域绑定读回依赖文件缺失：{path}");
                fileHashes[path] = FileDigest(Avh.Abs(path));
                if (File.Exists(Avh.Abs(path + ".meta"))) fileHashes[path + ".meta"] = FileDigest(Avh.Abs(path + ".meta"));
            }
            return new Dictionary<string, object> {
                ["schema"] = "region-binding-readback/0.1", ["plan_sha256"] = LocalOperations.Digest(planText),
                ["declared"] = declared, ["actual"] = actual, ["all"] = all,
                ["files"] = fileHashes,
            };
        }

        static Renderer FindRenderer(GameObject avatar, string path) => string.IsNullOrEmpty(path)
            ? avatar.GetComponent<Renderer>() : avatar.transform.Find(path)?.GetComponent<Renderer>();

        /// <summary>One copy per renderer and source material, so a recolored material is never shared by two meshes.</summary>
        static Material MakeCopy(GameObject avatar, Renderer renderer, Material source, string scope = "")
        {
            var name = Sanitize(Probe.HierarchyPath(avatar.transform, renderer.transform)) + "__" + Sanitize(source.name);
            if (AvatarConfig.Grouped(Avh.Plan())) name += "__" + Sanitize(scope) + "__" + Hash128.Compute(Avh.Json(VariantResolver.Identity(source)));
            var path = $"{MaterialDir}/{name}.mat";
            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing != null)
            {
                // 重跑时保留副本的 GUID（上一层变体与台账都按 GUID 认），内容每次从原件重新抄。
                EditorUtility.CopySerialized(source, existing);
                existing.name = Path.GetFileNameWithoutExtension(path);
                return existing;
            }
            var copy = new Material(source) { name = Path.GetFileNameWithoutExtension(path) };
            AssetDatabase.CreateAsset(copy, path);
            return copy;
        }

        /// <summary>Every adjustment starts from the source material (SOP 40：每条从原件起算), never from the last tier.</summary>
        static void Apply(IEnumerable<Copy> copies, Dictionary<string, object> tier)
        {
            var adjustments = tier.List("adjustments").Cast<Dictionary<string, object>>().ToDictionary(a => a.Str("part"));
            foreach (var copy in copies)
            {
                if (!adjustments.TryGetValue(copy.Part, out var a)) continue;
                var hue = Convert.ToSingle(a["hue_shift"]) / 360f;
                var saturation = Convert.ToSingle(a["saturation"]);
                var value = Convert.ToSingle(a["value"]);
                var source = copy.Baseline;
                if (copy.Part == "eye" && IrisLayer(source))
                {
                    var original = source.GetColor("_Color2nd");
                    Color.RGBToHSV(original, out var ch, out var cs, out var cv);
                    var shifted = Color.HSVToRGB(Mathf.Repeat(ch + hue, 1f), Mathf.Clamp01(cs * saturation), Mathf.Clamp01(cv * value));
                    shifted.a = original.a; copy.Material.SetColor("_Color2nd", shifted);
                }
                else if (source.HasProperty("_MainTexHSVG"))
                {
                    var v = source.GetVector("_MainTexHSVG");
                    var h = v.x + hue;
                    h -= Mathf.Floor(h + 0.5f);  // lilToon 的色相偏移取 [-0.5, 0.5)
                    copy.Material.SetVector("_MainTexHSVG", new Vector4(h, v.y * saturation, v.z * value, v.w));
                }
                else
                {
                    Color.RGBToHSV(source.GetColor("_Color"), out var ch, out var cs, out var cv);
                    var shifted = Color.HSVToRGB(Mathf.Repeat(ch + hue, 1f), Mathf.Clamp01(cs * saturation), Mathf.Clamp01(cv * value));
                    shifted.a = source.GetColor("_Color").a;
                    copy.Material.SetColor("_Color", shifted);
                }
            }
        }

        static void RemoveStaleCopies(IEnumerable<string> keep)
        {
            var wanted = new HashSet<string>(keep);
            foreach (var guid in AssetDatabase.FindAssets("t:Material", new[] { MaterialDir }))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (!wanted.Contains(path)) AssetDatabase.DeleteAsset(path);
            }
        }

        static void WriteDecision(Dictionary<string, object> recipe, List<Dictionary<string, object>> tiers, string chosen, List<string> shots)
        {
            string Describe(Dictionary<string, object> tier) => string.Join("；", tier.List("adjustments").Cast<Dictionary<string, object>>()
                .Select(a => $"{a.Str("part")} 色相 {a.Str("hue_shift")}° 饱和 ×{a.Str("saturation")} 明度 ×{a.Str("value")}"));
            var sb = new StringBuilder();
            sb.AppendLine("# 配色决策").AppendLine();
            sb.AppendLine("## 选定档").AppendLine();
            sb.AppendLine($"- {chosen}：{Describe(tiers.First(t => t.Str("id") == chosen))}").AppendLine();
            sb.AppendLine("## 理由").AppendLine();
            sb.AppendLine($"- {recipe.Str("reason")}").AppendLine();
            sb.AppendLine("## 未选的档").AppendLine();
            foreach (var tier in tiers.Where(t => t.Str("id") != chosen)) sb.AppendLine($"- {tier.Str("id")}（{tier.Str("label")}）：{Describe(tier)}");
            sb.AppendLine().AppendLine("## 候选图").AppendLine();
            sb.AppendLine("本阶段 Run 目录 candidates/ 下（同机位，规格 JSON 与图同名）：");
            foreach (var shot in shots) sb.AppendLine($"- {shot}");
            File.WriteAllText(Avh.Abs(DecisionPath), sb.ToString(), new UTF8Encoding(false));
        }

        static void Observe(string avatarPath, List<Dictionary<string, object>> rows)
        {
            var baseline = Avh.ReadJsonFile(Avh.Abs("_harness/setup/baseline.json"));
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(avatarPath);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                var notes = new List<string>();
                var metrics = Measure.Observe(avatar, baseline, notes);
                if (AvatarConfig.Grouped(Avh.Plan())) metrics["group_defaults_match"] = MenuGroupAudit.SceneAssertions(avatar, Avh.Plan(), Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)), notes) == 0;
                Avh.Observation("avatar.observe", metrics, notes);
                var menuNotes = new List<string>();
                var replaced = new HashSet<(string, int, string)>(rows.Where(r => r.Str("original_guid") != r.Str("material_guid"))
                    .Select(r => (r.Str("renderer"), Convert.ToInt32(r["slot"]), r.Str("original_guid"))));
                Avh.Observation("menu.dump", new Dictionary<string, object> { ["stale_material_curves"] = MaterialCurves.Stale(avatar, replaced, menuNotes) }, menuNotes);
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }

        public static string Guid(UnityEngine.Object asset) => AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(asset));
        static string Sanitize(string s) => Regex.Replace(s, @"[\\/:*?""<>|\s]+", "_");
    }

    /// <summary>Material-swap curves in the avatar's animators (SOP 40 步骤 6：配色后材质曲线要重新指向新材质).</summary>
    public static class MaterialCurves
    {
        /// <summary>Curves that still set a replaced slot to its original material.</summary>
        public static int Stale(GameObject avatar, HashSet<(string renderer, int slot, string originalGuid)> replaced, List<string> notes)
        {
            var count = 0;
            foreach (var (controller, root) in Controllers(avatar))
                foreach (var clip in controller.animationClips.Distinct())
                    foreach (var binding in AnimationUtility.GetObjectReferenceCurveBindings(clip))
                    {
                        var match = Regex.Match(binding.propertyName, @"^m_Materials\.Array\.data\[(\d+)\]$");
                        if (!match.Success) continue;
                        var target = root.Find(binding.path);
                        if (target == null) continue;
                        var path = Probe.HierarchyPath(avatar.transform, target);
                        var slot = int.Parse(match.Groups[1].Value);
                        foreach (var key in AnimationUtility.GetObjectReferenceCurve(clip, binding))
                        {
                            if (key.value == null) continue;
                            if (!replaced.Contains((path, slot, RecolorStage.Guid(key.value)))) continue;
                            count++;
                            if (count <= 5) notes.Add($"{clip.name}：{path} 槽 {slot} 仍切到原材质 {key.value.name}");
                        }
                    }
            return count;
        }

        /// <summary>Every animator controller the avatar merges: descriptor layers and MA Merge Animator, with the root its paths start from.</summary>
        public static IEnumerable<(AnimatorController controller, Transform root)> Controllers(GameObject avatar)
        {
            var descriptor = avatar.GetComponent<VRCAvatarDescriptor>();
            if (descriptor != null)
                foreach (var layer in descriptor.baseAnimationLayers.Concat(descriptor.specialAnimationLayers))
                    if (!layer.isDefault && layer.animatorController is AnimatorController c) yield return (c, avatar.transform);
            foreach (var merge in avatar.GetComponentsInChildren<ModularAvatarMergeAnimator>(true))
            {
                if (!(merge.animator is AnimatorController c)) continue;
                var relative = merge.relativePathRoot != null ? merge.relativePathRoot.Get(merge) : null;
                yield return (c, merge.pathMode == MergeAnimatorPathMode.Absolute ? avatar.transform : relative != null ? relative.transform : merge.transform);
            }
        }
    }
}
