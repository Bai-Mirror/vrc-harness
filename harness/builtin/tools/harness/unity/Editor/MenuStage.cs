// 【项目沉淀】通用工具（Harness menu 阶段的 Unity 步骤）
// 适用素体：无关
// 工具链　：Unity 2022.3 批处理；Modular Avatar 1.18（Menu Item + Object Toggle）；NDMF
// 可复用性：★★★ 换个单子直接能用
// 用途　　：整套衣装只由一个 Float 径向轮盘选择；外套、衬衣、包等按语义部件组横向管理所有衣装，
//           一个开关单元可包含多个对象及需要让位的对象，不把工程网格树直接暴露给用户。存成改色层的变体 Assets/_Harness/Menu/Avatar.prefab，
//           记录 Assets/_Harness/Menu/menu.json（路线、交集、控件、冲突表）。随后测 menu.configure、menu.dump
//           （在 NDMF 处理过的克隆上数）与 avatar.observe。
using System;
using System.Collections.Generic;
using System.Linq;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;

namespace AVH.Harness
{
    /// <summary>Compile business groups into disjoint final property owners, then observe the built result.</summary>
    public static class MenuGroups
    {
        class Binding
        {
            public EditorCurveBinding curve;
            public float[] values;
            public UnityEngine.Object[] objects;
            public List<string> conditions = new List<string>();
        }
        static readonly string Controller = MenuStage.Dir + "/Groups.controller";
        public static void Produce(Dictionary<string, object> plan)
        {
            var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)) ?? throw new Exception("缺少装配记录");
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath) ?? throw new Exception("缺少改色产物");
            OutfitStage.EnsureFolder(MenuStage.Dir);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                Compile(avatar, plan, record);
                PrefabUtility.SaveAsPrefabAsset(avatar, MenuStage.AvatarPath, out var ok);
                if (!ok) throw new Exception("菜单保存失败");
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
            var menu = Avh.ReadJsonFile(Avh.Abs(MenuStage.RecordPath));
            MenuStage.Observe(menu.List("parameters").Select(x => x.ToString()).ToList(), new List<string>());
        }

        public static AnimatorController Compile(GameObject avatar, Dictionary<string, object> plan, Dictionary<string, object> record)
        {
            var prior = avatar.transform.Find(MenuStage.MenuObject);
            if (prior != null) UnityEngine.Object.DestroyImmediate(prior.gameObject);
            AssetDatabase.DeleteAsset(Controller);
            AssetDatabase.DeleteAsset(MenuStage.ClipDir);
            OutfitStage.EnsureFolder(MenuStage.ClipDir);
            var controller = AnimatorController.CreateAnimatorControllerAtPath(Controller);
            controller.RemoveLayer(0);
            var root = new GameObject(MenuStage.MenuObject); root.transform.SetParent(avatar.transform, false);
            root.AddComponent<ModularAvatarMenuInstaller>();
            Folder(root, "造型");
            var merge = root.AddComponent<ModularAvatarMergeAnimator>(); merge.animator = controller;
            merge.layerType = VRCAvatarDescriptor.AnimLayerType.FX; merge.pathMode = MergeAnimatorPathMode.Absolute;
            merge.matchAvatarWriteDefaults = false; merge.mergeAnimatorMode = MergeAnimatorMode.Append;
            var maParameters = root.AddComponent<ModularAvatarParameters>(); maParameters.parameters = new List<ParameterConfig>();
            var defaults = AvatarConfig.Defaults(plan);
            var specs = Parameters(plan);
            foreach (var p in specs)
            {
                var name = p.Str("name"); var type = p.Str("type");
                if (AvatarConfig.On(p, "adopt"))
                {
                    VerifyAdoptedParameter(avatar, p, defaults[name]);
                    continue;
                }
                // Collision is never implicit adoption. The configuration owns all generated parameters.
                MenuStage.ResolveParameter(avatar, name, type);
                controller.AddParameter(new AnimatorControllerParameter { name = name,
                    type = type == "Float" ? AnimatorControllerParameterType.Float : type == "Int" ? AnimatorControllerParameterType.Int : AnimatorControllerParameterType.Bool,
                    defaultFloat = defaults[name], defaultInt = (int)defaults[name], defaultBool = defaults[name] > .5f });
                maParameters.parameters.Add(new ParameterConfig { nameOrPrefix = name, syncType = type == "Float" ? ParameterSyncType.Float : type == "Int" ? ParameterSyncType.Int : ParameterSyncType.Bool,
                    saved = AvatarConfig.On(p, "saved"), localOnly = !AvatarConfig.On(p, "synced"), defaultValue = defaults[name], hasExplicitDefaultValue = true });
            }
            var rows = record.List("outfits").Cast<Dictionary<string, object>>().ToDictionary(o => o.Str("id"));
            var owners = new Dictionary<string, string>();
            var controls = new List<object>();
            var resolved = new List<object>();
            foreach (var group in AvatarConfig.Groups(plan))
            {
                var members = group.List("members").Cast<Dictionary<string, object>>().ToList();
                foreach (var member in members)
                {
                    if (!AvatarConfig.MaterialGroup(group) && (!rows.TryGetValue(member.Str("id"), out var row) || row.Str("instance") != member.Str("instance")
                        || row.Str("variant") != member.Str("variant"))) throw new Exception("成员缺少身份匹配的装配证据：" + member.Str("id"));
                    if (group.Str("activation") != "fixed") controls.Add(new Dictionary<string, object> {
                        ["group"] = group.Str("id"), ["member"] = member.Str("id"), ["semantic_id"] = member.Str("id"), ["label"] = member.Str("label"),
                        ["menu_label"] = group.Str("label"), ["parameter"] = (group.Str("activation") == "exclusive" ? group : member).Obj("parameter").Str("name"),
                        ["control"] = group.Str("activation") == "exclusive" && group.Obj("parameter").Str("type") == "Float" ? "RadialChoice" : "Toggle",
                        ["type"] = (group.Str("activation") == "exclusive" ? group : member).Obj("parameter").Str("type"), ["value"] = AvatarConfig.Value(group, member) });
                }
                if (group.Str("activation") == "independent")
                    foreach (var member in members) CompileOwner(avatar, controller, plan, group, new List<Dictionary<string, object>> { member }, rows, owners, resolved);
                else CompileOwner(avatar, controller, plan, group, members, rows, owners, resolved);
            }
            foreach (var s in AvatarConfig.Switches(plan)) controls.Add(new Dictionary<string, object> {
                ["semantic_id"] = s.Str("id"), ["label"] = s.Str("label"), ["parameter"] = s.Obj("parameter").Str("name"), ["type"] = "Bool", ["control"] = "Toggle", ["value"] = 1 });
            Tree(root, plan.Obj("menu").List("tree"), plan);
            var menuRecord = new Dictionary<string, object> { ["schema"] = "menu/0.5", ["route"] = "groups", ["avatar_config"] = plan.Obj("avatar_config"),
                ["parameters"] = specs.Select(p => (object)p.Str("name")).ToList(), ["controls"] = controls, ["bindings"] = resolved,
                ["conflicts"] = new List<object>(), ["overlap"] = new List<object>(), ["selector_owned_paths"] = new List<object>(),
                ["configuration_hash"] = ConfigHash(plan), ["source_prefab"] = RecolorStage.AvatarPath };
            ApplyDefaults(avatar, plan, record);
            Avh.WriteJson(Avh.Abs(MenuStage.RecordPath), menuRecord);
            AssetDatabase.SaveAssets();
            return controller;
        }

        public static string ConfigHash(Dictionary<string, object> plan) => Hash128.Compute(Avh.Json(plan.Obj("avatar_config"))).ToString();
        static string CurveIdentity(AnimationCurve curve) => curve == null ? null : Avh.Json(new object[] {
            curve.preWrapMode.ToString(), curve.postWrapMode.ToString(), curve.keys.Select(k => (object)new object[] {
                k.time.ToString("R"), k.value.ToString("R"), k.inTangent.ToString("R"), k.outTangent.ToString("R"),
                k.inWeight.ToString("R"), k.outWeight.ToString("R"), k.weightedMode.ToString() }).ToList() });

        /// <summary>Collapse only a structurally proven MA readable-property delay adapter to one final writer.</summary>
        public static void FinalizeReadableProperties(GameObject avatar)
        {
            if (!AvatarConfig.Grouped(Avh.Plan())) return;
            var evidence = new List<object>();
            var changes = new Dictionary<BlendTree, HashSet<Motion>>();
            foreach (var controller in AvatarAudit.Layers(avatar.GetComponent<VRCAvatarDescriptor>()).Select(x => x.controller).Distinct())
            {
                foreach (var layer in controller.layers)
                {
                    var states = AvatarAudit.States(layer.stateMachine).ToList();
                    if (states.Count != 1 || !states[0].writeDefaultValues || states[0].transitions.Length != 0 || layer.stateMachine.anyStateTransitions.Length != 0
                        || !(states[0].motion is BlendTree direct) || direct.blendType != BlendTreeType.Direct || layer.defaultWeight != 1) continue;
                    foreach (var child in direct.children)
                    {
                        var constant = controller.parameters.SingleOrDefault(p => p.name == child.directBlendParameter && p.type == AnimatorControllerParameterType.Float && p.defaultFloat == 1);
                        if (constant == null || !(constant.name.StartsWith("__MA/") || constant.name == "__ModularAvatarInternal/One") || !(child.motion is BlendTree buffer) || buffer.blendType != BlendTreeType.Simple1D
                            || !buffer.blendParameter.StartsWith("__MA/ActiveSelfProxy/") || buffer.children.Length != 3) continue;
                        var parts = buffer.children;
                        if (parts[0].threshold != 0 || Math.Abs(parts[1].threshold - .01f) > .000001f || parts[2].threshold != 1
                            || !(parts[0].motion is AnimationClip empty) || parts[1].motion != empty
                            || AnimationUtility.GetCurveBindings(empty).Length != 0 || AnimationUtility.GetObjectReferenceCurveBindings(empty).Length != 0
                            || !(parts[2].motion is AnimationClip enabled) || AnimationUtility.GetObjectReferenceCurveBindings(enabled).Length != 0) continue;
                        var bindings = AnimationUtility.GetCurveBindings(enabled);
                        // MergeArmature expands the same on curve to cloned activation holders.
                        if (bindings.Length == 0 || bindings.Any(b => b.type != typeof(GameObject) || b.propertyName != "m_IsActive")) continue;
                        if (bindings.Any(b => { var curve = AnimationUtility.GetEditorCurve(enabled, b); return curve.keys.Length != 1 || curve.keys[0].time != 0 || curve.keys[0].value != 1; })) continue;
                        var owners = controller.layers.Where(l => l.name.Contains("AVH Group ") && AvatarAudit.States(l.stateMachine)
                            .SelectMany(s => AvatarAudit.Clips(s.motion)).Any(c => AnimationUtility.GetCurveBindings(c).Any(b => Key(b) == Key(bindings[0])))).ToList();
                        if (owners.Count == 0) continue; // An unrelated vendor adapter is preserved.
                        if (owners.Count != 1) throw new Exception("可读代理没有单一完整业务所有者");
                        var clips = AvatarAudit.States(owners[0].stateMachine).SelectMany(s => AvatarAudit.Clips(s.motion)).Distinct().ToList();
                        foreach (var b in bindings)
                        {
                            var values = new List<float>();
                            foreach (var clip in clips)
                            {
                                var curve = AnimationUtility.GetEditorCurve(clip, b);
                                var proxy = AnimationUtility.GetEditorCurve(clip, EditorCurveBinding.FloatCurve("", typeof(Animator), buffer.blendParameter));
                                if (curve == null || CurveIdentity(curve) != CurveIdentity(proxy)) throw new Exception("可读代理与完整业务曲线不同：" + Key(b));
                                values.AddRange(curve.keys.Select(k => k.value));
                            }
                            // A shared root can be ON in every member state. Completeness means every business
                            // clip supplies the matching proxy curve, not that the property must change value.
                            if (values.Count == 0 || values.Any(v => v != 0 && v != 1)) throw new Exception("业务所有者缺少完整二值曲线：" + Key(b));
                            var writers = controller.layers.Where(l => AvatarAudit.States(l.stateMachine).SelectMany(s => AvatarAudit.Clips(s.motion))
                                .Any(c => AnimationUtility.GetCurveBindings(c).Any(binding => Key(binding) == Key(b)))).ToList();
                            if (writers.Count != 2 || writers.Count(w => w.name == owners[0].name) != 1 || writers.Count(w => w.name == layer.name) != 1)
                                throw new Exception("可读属性还有未解决写者：" + Key(b));
                            evidence.Add(new Dictionary<string, object> { ["binding"] = Key(b), ["proxy"] = buffer.blendParameter,
                                ["source_owner"] = owners[0].name, ["adapter"] = "Removed redundant ON-only delay output; retained complete binary business curves and proxy consumers" });
                        }
                        var path = AssetDatabase.GetAssetPath(direct).Replace('\\', '/');
                        var currentRoot = AvatarBuild.BuildArtifact.CurrentDerivedAssetRoot;
                        if (path != "" && !path.StartsWith("Packages/nadena.dev.ndmf/__Generated/", StringComparison.Ordinal)
                            && (string.IsNullOrEmpty(currentRoot) || !path.StartsWith(currentRoot.TrimEnd('/') + "/", StringComparison.Ordinal)))
                            throw new Exception("只能修改本次派生适配器：" + path);
                        if (!changes.TryGetValue(direct, out var removed)) changes[direct] = removed = new HashSet<Motion>();
                        removed.Add(buffer);
                    }
                }
            }
            // Apply only after the whole candidate set has passed. Source clips and shared null motions stay intact.
            foreach (var change in changes) { change.Key.children = change.Key.children.Where(c => !change.Value.Contains(c.motion)).ToArray(); EditorUtility.SetDirty(change.Key); }
            Avh.WriteJson(System.IO.Path.Combine(Avh.RunDir, "observations", "property-adapters.json"), new Dictionary<string, object> {
                ["schema"] = "property-adapters/0.1", ["configuration_hash"] = ConfigHash(Avh.Plan()), ["bindings"] = evidence });
        }
        public static List<Dictionary<string, object>> Parameters(Dictionary<string, object> plan)
        {
            var result = new List<Dictionary<string, object>>();
            foreach (var g in AvatarConfig.Groups(plan))
                if (g.Str("activation") == "exclusive") result.Add(g.Obj("parameter"));
                else if (g.Str("activation") == "independent") result.AddRange(g.List("members").Cast<Dictionary<string, object>>().Select(m => m.Obj("parameter")));
            result.AddRange(AvatarConfig.Switches(plan).Select(s => s.Obj("parameter")));
            return result;
        }
        public static string PropertyType(Type type) => typeof(Renderer).IsAssignableFrom(type) ? typeof(Renderer).FullName : type.FullName;
        public static string PropertyType(string type) => new[] {typeof(Renderer).FullName, typeof(MeshRenderer).FullName, typeof(SkinnedMeshRenderer).FullName}.Contains(type) ? typeof(Renderer).FullName : type;
        static string Key(EditorCurveBinding b) => b.path + "|" + PropertyType(b.type) + "|" + b.propertyName;
        static void VerifyAdoptedParameter(GameObject avatar, Dictionary<string, object> spec, float fallback)
        {
            var name = spec.Str("name"); var parameters = avatar.GetComponent<VRCAvatarDescriptor>().expressionParameters?.parameters ?? new VRCExpressionParameters.Parameter[0];
            var declarations = parameters.Where(p => p.name == name).ToList();
            if (declarations.Count != 1 || declarations[0].valueType.ToString() != spec.Str("type") || declarations[0].saved != AvatarConfig.On(spec, "saved")
                || declarations[0].networkSynced != AvatarConfig.On(spec, "synced") || Math.Abs(declarations[0].defaultValue - fallback) > .00001f)
                throw new Exception("显式采用参数的源类型/默认/保存/同步合同不符：" + name);
            var controllers = MaterialCurves.Controllers(avatar).Select(c => c.controller).Distinct().ToList();
            var consumers = controllers.SelectMany(c => c.layers).Any(l => l.stateMachine.anyStateTransitions.SelectMany(t => t.conditions).Any(c => c.parameter == name)
                || AvatarAudit.States(l.stateMachine).Any(s => s.timeParameterActive && s.timeParameter == name || s.transitions.SelectMany(t => t.conditions).Any(c => c.parameter == name)));
            var declared = controllers.SelectMany(c => c.parameters).Where(p => p.name == name).ToList();
            if (!consumers || declared.Count == 0 || declared.Any(p => p.type.ToString() != spec.Str("type")
                || Math.Abs((p.type == AnimatorControllerParameterType.Float ? p.defaultFloat : p.type == AnimatorControllerParameterType.Int ? p.defaultInt : p.defaultBool ? 1 : 0) - fallback) > .00001f))
                throw new Exception("显式采用参数缺少一致的真实消费者：" + name);
            // Existing source declaration remains authoritative; compiled business readback verifies polarity and every member.
        }
        static void CompileOwner(GameObject avatar, AnimatorController controller, Dictionary<string, object> plan, Dictionary<string, object> group,
            List<Dictionary<string, object>> members, Dictionary<string, Dictionary<string, object>> rows, Dictionary<string, string> owners, List<object> resolved)
        {
            var activation = group.Str("activation"); var owner = group.Str("id") + (activation == "independent" ? "_" + members[0].Str("id") : "");
            var adopted = (activation == "independent" ? members[0] : group).Obj("parameter");
            if (AvatarConfig.MaterialGroup(group) && AvatarConfig.On(adopted, "adopt")) throw new Exception("Material selector adoption is not proven");
            if (AvatarConfig.On(adopted, "adopt"))
            {
                foreach (var member in members)
                    foreach (var path in rows[member.Str("id")].List("bone_proxy_visuals").Select(p => p.ToString()).Append(rows[member.Str("id")].Str("object")).Distinct())
                    {
                        var key = Key(EditorCurveBinding.FloatCurve(path, typeof(GameObject), "m_IsActive"));
                        if (owners.ContainsKey(key)) throw new Exception("采用参数与另一业务所有者争写：" + key);
                        owners.Add(key, owner);
                        resolved.Add(new Dictionary<string, object> { ["owner"] = owner, ["path"] = path, ["type"] = typeof(GameObject).FullName,
                            ["property"] = "m_IsActive", ["adopted_parameter"] = adopted.Str("name") });
                    }
                return;
            }
            var bindings = new Dictionary<string, Binding>();
            void Active(string path, int slot, bool on)
            {
                var curve = EditorCurveBinding.FloatCurve(path, typeof(GameObject), "m_IsActive");
                var key = Key(curve);
                if (!bindings.TryGetValue(key, out var b)) bindings[key] = b = new Binding { curve = curve, values = new float[members.Count] };
                b.values[slot] = on ? 1 : 0;
            }
            if (AvatarConfig.MaterialGroup(group))
            {
                var record = new Dictionary<string, object> { ["outfits"] = rows.Values.Cast<object>().ToList() };
                foreach (var slot in MaterialAxes.Slots(group, record))
                {
                    var target = avatar.transform.Find(slot.Path)?.GetComponent<Renderer>();
                    if (target == null || target.GetType() != slot.Type || target.sharedMaterials.Length <= slot.Index) throw new Exception("Material axis target missing: " + slot.Path);
                    var curve = EditorCurveBinding.PPtrCurve(slot.Path, slot.Type, $"m_Materials.Array.data[{slot.Index}]");
                    bindings.Add(Key(curve), new Binding { curve = curve, objects = members.Select(m => (UnityEngine.Object)MaterialAxes.Expected(plan, m, slot.Binding.Str("id"))).ToArray() });
                }
            }
            else
            {
            for (var i = 0; i < members.Count; i++)
            {
                var row = rows[members[i].Str("id")];
                var paths = row.List("bone_proxy_visuals").Select(p => p.ToString()).Append(row.Str("object")).Distinct();
                foreach (var path in activation == "fixed" ? Enumerable.Empty<string>() : paths)
                {
                    var target = avatar.transform.Find(path) ?? throw new Exception("成员可视件缺失：" + path);
                    if (target.GetComponentsInParent<Transform>(true).Any(t => t.CompareTag("EditorOnly"))) throw new Exception("成员可视件被构建排除：" + path);
                    Active(path, i, path == row.Str("object") || row.Obj("bone_proxy_defaults") == null || AvatarConfig.On(row.Obj("bone_proxy_defaults"), path));
                }
                // Only shared physical instances need runtime material presets. Unshared copies retain recolor ownership.
                if (members.Count(m => rows[m.Str("id")].Str("object") == row.Str("object")) > 1)
                    foreach (Dictionary<string, object> material in row.List("material_presets"))
                        for (var slot = 0; slot < material.List("materials").Count; slot++)
                        {
                            if (MaterialAxes.Owns(plan, row, material.Str("renderer"), slot)) continue;
                            var type = material.Str("type") == typeof(SkinnedMeshRenderer).FullName ? typeof(SkinnedMeshRenderer) : typeof(MeshRenderer);
                            var curve = EditorCurveBinding.PPtrCurve(material.Str("renderer"), type, $"m_Materials.Array.data[{slot}]");
                            var key = Key(curve);
                            if (!bindings.TryGetValue(key, out var b)) bindings[key] = b = new Binding { curve = curve, objects = new UnityEngine.Object[members.Count] };
                            b.objects[i] = PresetMaterialObject(row, material, slot);
                        }
            }
            // Shared switches are conditions of the owning group, including BoneProxy roots. They never become competing layers.
            foreach (var s in AvatarConfig.Switches(plan)) foreach (Dictionary<string, object> target in s.List("targets"))
            {
                if (AvatarConfig.On(s.Obj("parameter"), "adopt")) throw new Exception("共享参数采用需要完整的组合适配观察，不能只跳过对象绑定");
                foreach (var member in members.Where(m => m.Str("instance") == target.Str("instance")))
                {
                    var spec = plan.Obj("avatar_config").List("instances").Cast<Dictionary<string, object>>().Single(i => i.Str("id") == target.Str("instance"));
                    var component = spec.List("components").Cast<Dictionary<string, object>>().Single(c => c.Str("id") == target.Str("component"));
                    foreach (var relative in component.List("objects").Select(x => x.ToString()))
                    {
                        var path = rows[member.Str("id")].Str("object") + "/" + relative;
                        if (avatar.transform.Find(path) == null) throw new Exception("共享部件绑定不存在：" + path);
                        var index = members.FindIndex(m => m.Str("id") == member.Str("id"));
                        Active(path, index, true);
                        var binding = bindings[Key(EditorCurveBinding.FloatCurve(path, typeof(GameObject), "m_IsActive"))];
                        if (activation == "fixed") binding.values = Enumerable.Repeat(1f, members.Count).ToArray();
                        if (!binding.conditions.Contains(s.Obj("parameter").Str("name"))) binding.conditions.Add(s.Obj("parameter").Str("name"));
                    }
                }
            }
            }
            if (bindings.Count == 0) return;
            foreach (var b in bindings.Values)
            {
                var key = Key(b.curve);
                if (owners.TryGetValue(key, out var previous) && previous != owner) throw new Exception("属性多重所有者：" + key);
                owners[key] = owner;
                foreach (var (vendor, vendorRoot) in MaterialCurves.Controllers(avatar).Where(c => c.controller != controller))
                    foreach (var clip in vendor.animationClips.Distinct())
                        if (AnimationUtility.GetCurveBindings(clip).Concat(AnimationUtility.GetObjectReferenceCurveBindings(clip)).Any(v =>
                            PropertyType(v.type) == PropertyType(b.curve.type) && v.propertyName == b.curve.propertyName &&
                            (v.path.Length == 0 ? vendorRoot : vendorRoot.Find(v.path)) == avatar.transform.Find(b.curve.path)))
                            throw new Exception("厂商属性写者未解决：" + vendor.name + "/" + key);
                resolved.Add(new Dictionary<string, object> { ["owner"] = owner, ["path"] = b.curve.path, ["type"] = b.curve.type.FullName, ["property"] = b.curve.propertyName });
            }
            var conditions = bindings.Values.SelectMany(b => b.conditions).Distinct().ToList();
            if (activation == "independent") conditions.Insert(0, members[0].Obj("parameter").Str("name"));
            if (conditions.Count > 12) throw new Exception("关联条件组合过多，需要局部绑定解析");
            controller.AddLayer("AVH Group " + owner);
            var layers = controller.layers; var layer = layers[layers.Length - 1]; layer.defaultWeight = 1;
            var states = new List<AnimatorState>();
            var defaults = AvatarConfig.Defaults(plan);
            var defaultMask = 0; for (var c = 0; c < conditions.Count; c++) if (defaults[conditions[c]] > .5f) defaultMask |= 1 << c;
            var discrete = activation == "exclusive" && group.Obj("parameter").Str("type") == "Int";
            var radial = activation == "exclusive" && group.Obj("parameter").Str("type") == "Float";
            var choices = discrete ? members.Count : 1;
            for (var choice = 0; choice < choices; choice++) for (var mask = 0; mask < (1 << conditions.Count); mask++)
            {
                var clip = new AnimationClip { name = owner + "_" + choice + "_" + mask, frameRate = members.Count * 60 };
                var settings = AnimationUtility.GetAnimationClipSettings(clip); settings.loopTime = false; AnimationUtility.SetAnimationClipSettings(clip, settings);
                foreach (var b in bindings.Values)
                {
                    var enabled = b.conditions.All(p => (mask & (1 << conditions.IndexOf(p))) != 0)
                        && (activation != "independent" || (mask & 1) != 0);
                    if (b.objects != null)
                    {
                        var keys = new List<ObjectReferenceKeyframe>();
                        var fallback = b.objects.FirstOrDefault(o => o != null);
                        for (var i = 0; i < members.Count; i++) keys.Add(new ObjectReferenceKeyframe { time = AvatarConfig.Boundary(i,members.Count),
                            value = b.objects[i] ?? fallback });
                        keys.Add(new ObjectReferenceKeyframe { time = 1 - 1 / clip.frameRate, value = b.objects.LastOrDefault(o => o != null) ?? fallback });
                        if (discrete) { var index = members.FindIndex(m => AvatarConfig.Value(group, m) == choice); keys = new List<ObjectReferenceKeyframe> {
                            new ObjectReferenceKeyframe { time = 0, value = b.objects[index] ?? fallback }, new ObjectReferenceKeyframe { time = 1 - 1 / clip.frameRate, value = b.objects[index] ?? fallback } }; }
                        AnimationUtility.SetObjectReferenceCurve(clip, b.curve, keys.ToArray());
                    }
                    else
                    {
                        var curve = new AnimationCurve();
                        for (var i = 0; i < members.Count; i++) curve.AddKey(new Keyframe(AvatarConfig.Boundary(i,members.Count), enabled ? b.values[i] : 0, float.PositiveInfinity, float.PositiveInfinity));
                        curve.AddKey(new Keyframe(1, enabled ? b.values[members.Count - 1] : 0, float.PositiveInfinity, float.PositiveInfinity));
                        if (discrete) { var index = members.FindIndex(m => AvatarConfig.Value(group, m) == choice); curve = AnimationCurve.Constant(0, 1, enabled ? b.values[index] : 0); }
                        AnimationUtility.SetEditorCurve(clip, b.curve, curve);
                    }
                }
                // Object-reference curves include a final frame in their inferred duration.
                // MotionTime must use the same one-second interval as the float selector keys.
                settings = AnimationUtility.GetAnimationClipSettings(clip); settings.startTime = 0; settings.stopTime = 1;
                settings.loopTime = false; AnimationUtility.SetAnimationClipSettings(clip, settings);
                AssetDatabase.CreateAsset(clip, MenuStage.ClipDir + "/" + clip.name + ".anim");
                var state = layer.stateMachine.AddState(clip.name); state.motion = clip; state.writeDefaultValues = false;
                if (radial) { state.timeParameterActive = true; state.timeParameter = group.Obj("parameter").Str("name"); state.speed = 0; }
                if (mask == defaultMask && (choices == 1 || choice == 0)) layer.stateMachine.defaultState = state;
                states.Add(state);
                if (conditions.Count > 0 || discrete)
                {
                    var transition = layer.stateMachine.AddAnyStateTransition(state); transition.hasExitTime = false; transition.duration = 0; transition.canTransitionToSelf = false;
                    for (var c = 0; c < conditions.Count; c++) transition.AddCondition((mask & (1 << c)) != 0 ? AnimatorConditionMode.If : AnimatorConditionMode.IfNot, 0, conditions[c]);
                    if (discrete) transition.AddCondition(AnimatorConditionMode.Equals, choice, group.Obj("parameter").Str("name"));
                }
            }
            layers[layers.Length - 1] = layer; controller.layers = layers;
        }
        static ModularAvatarMenuItem Folder(GameObject go, string label)
        {
            var item = go.AddComponent<ModularAvatarMenuItem>();
            item.Control = new VRCExpressionsMenu.Control { name = label, type = VRCExpressionsMenu.Control.ControlType.SubMenu };
            item.label = label; item.MenuSource = SubmenuSource.Children; return item;
        }
        static GameObject Child(GameObject parent, string name) { var go = new GameObject(name); go.transform.SetParent(parent.transform, false); return go; }
        static void Control(GameObject parent, string label, Dictionary<string, object> parameter, float value, bool radial)
        {
            var item = Child(parent, parameter.Str("name").Replace('/', '_') + "_" + value).AddComponent<ModularAvatarMenuItem>();
            item.Control = new VRCExpressionsMenu.Control { name = label, type = radial ? VRCExpressionsMenu.Control.ControlType.RadialPuppet : VRCExpressionsMenu.Control.ControlType.Toggle,
                value = value, parameter = radial ? null : new VRCExpressionsMenu.Control.Parameter { name = parameter.Str("name") },
                subParameters = radial ? new[] { new VRCExpressionsMenu.Control.Parameter { name = parameter.Str("name") } } : null };
            item.isSaved = AvatarConfig.On(parameter, "saved"); item.isSynced = AvatarConfig.On(parameter, "synced"); item.label = label;
        }
        static void Tree(GameObject parent, List<object> nodes, Dictionary<string, object> plan)
        {
            var page = parent; var count = 0;
            foreach (Dictionary<string, object> node in nodes)
            {
                if (count == 7 && nodes.Count > 8) { page = Child(page, "Next"); Folder(page, "更多"); count = 0; }
                count++;
                if (node.Str("group") != null)
                {
                    var group = AvatarConfig.Groups(plan).Single(g => g.Str("id") == node.Str("group"));
                    if (group.Str("activation") == "exclusive" && group.Obj("parameter").Str("type") == "Float") Control(page, group.Str("label"), group.Obj("parameter"), 0, true);
                    else
                    {
                        var folder = Child(page, group.Str("id")); Folder(folder, group.Str("label"));
                        var members = group.List("members").Cast<Dictionary<string, object>>().ToList();
                        for (var i = 0; i < members.Count; i++)
                        {
                            if (i > 0 && i % 7 == 0 && members.Count > 8) { folder = Child(folder, "Next"); Folder(folder, "更多"); }
                            Control(folder, members[i].Str("label"), (group.Str("activation") == "exclusive" ? group : members[i]).Obj("parameter"), AvatarConfig.Value(group, members[i]), false);
                        }
                    }
                }
                else if (node.Str("shared_switch") != null)
                {
                    var s = AvatarConfig.Switches(plan).Single(x => x.Str("id") == node.Str("shared_switch"));
                    Control(page, s.Str("label"), s.Obj("parameter"), 1, false);
                }
                else { var folder = Child(page, node.Str("id")); Folder(folder, node.Str("label")); Tree(folder, node.List("children"), plan); }
            }
        }
        public static void ApplyDefaults(GameObject avatar, Dictionary<string, object> plan, Dictionary<string, object> record)
        {
            RecolorStage.SetGroupState(avatar, record.List("outfits").Cast<Dictionary<string, object>>().ToList(), AvatarConfig.Defaults(plan));
        }
        public static Material PresetMaterialObject(Dictionary<string, object> row, Dictionary<string, object> preset, int slot, bool actualBinding = true)
        {
            var original = VariantResolver.Material(preset.List("materials")[slot]);
            var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(RecolorStage.PresetPath(row.Str("id")));
            if (actualBinding && clip != null)
            {
                var binding = AnimationUtility.GetObjectReferenceCurveBindings(clip).Single(b => b.path == preset.Str("renderer")
                    && b.propertyName == "m_Materials.Array.data[" + slot + "]");
                var keys = AnimationUtility.GetObjectReferenceCurve(clip, binding);
                if (keys.Length != 1 || keys[0].time != 0) throw new Exception("成员改色绑定不是单一预设");
                return keys[0].value as Material;
            }
            var originalIdentity = VariantResolver.Identity(original);
            var ledger = Avh.ReadJsonFile(Avh.Abs(RecolorStage.LedgerPath));
            var replacement = ledger.List("rows").Cast<Dictionary<string, object>>().LastOrDefault(r => r.Str("renderer") == preset.Str("renderer")
                && Convert.ToInt32(r["slot"]) == slot && (r.Obj("original_identity") != null ? Avh.Json(r.Obj("original_identity")) == Avh.Json(originalIdentity)
                    : r.Str("original") == AssetDatabase.GetAssetPath(original)) && (r.Str("member") == null || r.Str("member") == row.Str("id")));
            if (replacement == null) return original;
            if (!actualBinding) return VariantResolver.Material(replacement.Obj("material_identity"));
            throw new Exception("成员改色缺少持久材质绑定，台账不能代替实际绑定");
        }
    }
    public static class MenuStage
    {
        public const string Dir = "Assets/_Harness/Menu";
        public const string AvatarPath = Dir + "/Avatar.prefab";
        public const string RecordPath = Dir + "/menu.json";
        public const string DesignPath = Dir + "/design.json";
        public const string MenuObject = "_HarnessMenu";
        public const string ControllerPath = Dir + "/OutfitRouteB.controller";
        public const string ClipDir = Dir + "/RouteBClips";

        public static void Run() => Avh.Stage("menu", Produce);

        public static void Produce()
        {
            var plan = Avh.Plan();
            if (AvatarConfig.Grouped(plan)) { MenuGroups.Produce(plan); return; }
            var menuPlan = plan.Obj("menu") ?? new Dictionary<string, object>();
            var selectorPlan = menuPlan.Obj("selector") ?? new Dictionary<string, object>();
            var requestedParameter = selectorPlan.Str("parameter");
            var saved = menuPlan.Str("saved") != "False";
            var exclusivePlan = plan.List("outfits").Cast<Dictionary<string, object>>().Where(o => !OutfitStage.Fixed(o)).ToList();
            if (menuPlan.Str("mode") == "preserve" || exclusivePlan.Count == 0)
            {
                if (exclusivePlan.Count > 0) throw new Exception("exclusive 衣装需要明确菜单方案，不能使用原菜单保留路线");
                Preserve();
                return;
            }
            var design = Avh.ReadJsonFile(Avh.Abs(DesignPath)) ?? throw new Exception("缺少菜单设计 design.json；menu 阶段必须先完成部件语义调查");
            if (design.Str("schema") != "menu-design/0.1") throw new Exception("design.json schema 必须为 menu-design/0.1");
            var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)) ?? throw new Exception("缺少服装层记录 outfit.json");
            var basePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath) ?? throw new Exception("缺少改色层 Avatar.prefab");
            OutfitStage.EnsureFolder(Dir);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(basePrefab);

            var outfits = record.List("outfits").Cast<Dictionary<string, object>>().Where(o => !OutfitStage.Fixed(o)).ToList();
            if (design.Obj("selector")?.Str("type") != "radial") throw new Exception("design.selector.type 必须为 radial；整套衣装不得用多个 Toggle 切换");
            var parameter = ResolveParameter(avatar, requestedParameter, "Float");
            var controlled = outfits.Select(o => avatar.transform.Find(o.Str("object")) ?? throw new Exception($"找不到 {o.Str("object")}")).ToList();
            var overlap = VendorOverlap(avatar, controlled);
            var route = overlap.Count == 0 ? "A" : "B";

            var existing = avatar.transform.Find(MenuObject);
            if (existing != null) UnityEngine.Object.DestroyImmediate(existing.gameObject);
            AssetDatabase.DeleteAsset(ControllerPath);
            AssetDatabase.DeleteAsset(ClipDir);
            var root = new GameObject(MenuObject);
            root.transform.SetParent(avatar.transform, false);
            root.AddComponent<ModularAvatarMenuInstaller>();
            var folder = root.AddComponent<ModularAvatarMenuItem>();
            folder.Control = new VRCExpressionsMenu.Control { name = "造型", type = VRCExpressionsMenu.Control.ControlType.SubMenu };
            folder.MenuSource = SubmenuSource.Children;

            var defaultEntry = outfits.First(o => Equals(o["default"], true));
            var controls = new List<object>();
            var selectorLabel = design.Obj("selector")?.Str("label") ?? selectorPlan.Str("label") ?? "衣装";
            var selector = Radial(root, selectorLabel, parameter, saved);
            for (var i = 0; i < outfits.Count; i++)
            {
                var value = outfits.Count == 1 ? 0f : (i + 0.5f) / outfits.Count;
                controls.Add(new Dictionary<string, object> { ["label"] = outfits[i].Str("label"), ["control"] = "RadialChoice",
                    ["menu_label"] = selectorLabel, ["parameter"] = parameter, ["type"] = "Float", ["value"] = value,
                    ["note"] = outfits[i] == defaultEntry ? "默认衣装档位" : "衣装轮盘档位" });
            }
            var selectorOwnedPaths = SelectorTargets(avatar, outfits, controlled)
                .Select(entry => (object)AnimationUtility.CalculateTransformPath(entry.target, avatar.transform)).Distinct().ToList();
            var controller = InstallSelectorController(avatar, root, outfits, defaultEntry, controlled, parameter, saved);
            var componentParameters = InstallComponentMatrix(avatar, root, controller, design, outfits, saved, controls);

            PrefabUtility.SaveAsPrefabAsset(avatar, AvatarPath, out var ok);
            if (!ok) throw new Exception("存菜单层变体失败");
            UnityEngine.Object.DestroyImmediate(avatar);
            var sources = outfits.Select(o => (object)o.Str("object")).Concat(record.List("hidden_body_parts")).ToList();
            Avh.WriteJson(Avh.Abs(RecordPath), new Dictionary<string, object>
            {
                ["schema"] = "menu/0.4", ["route"] = route, ["overlap"] = overlap.Select(x => (object)x).ToList(),
                ["requested_parameter"] = requestedParameter, ["resolved_parameter"] = parameter,
                ["selector_owned_paths"] = selectorOwnedPaths,
                ["information_architecture"] = design,
                ["route_b_controller"] = ControllerPath,
                ["parameters"] = new List<object> { parameter }.Concat(componentParameters.Cast<object>()).ToList(), ["controls"] = controls,
                // 冲突表（SOP 60 步骤 3）：本单只有「全身服装」一个位置；来源互斥由同一参数保证，优先级链按菜单顺序。
                ["conflicts"] = new List<object> { new Dictionary<string, object>
                {
                    ["position"] = "全身服装", ["sources"] = sources, ["mechanism"] = $"同一参数 {parameter} 互斥；素体自带的衣服构建时剔除",
                    ["priority"] = sources,
                } },
            });
            AssetDatabase.ImportAsset(RecordPath);
            Observe(new[] { parameter }.Concat(componentParameters).ToList(), sources.Select(s => s.ToString()).ToList());
        }

        static void Preserve()
        {
            var source = AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath) ?? throw new Exception("缺少改色层 Avatar.prefab");
            OutfitStage.EnsureFolder(Dir);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(source);
            try
            {
                PrefabUtility.SaveAsPrefabAsset(avatar, AvatarPath, out var saved);
                if (!saved) throw new Exception("保存原菜单保留产物失败");
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
            Avh.WriteJson(Avh.Abs(RecordPath), new Dictionary<string, object>
            {
                ["schema"] = "menu/0.4", ["route"] = "preserve", ["source_prefab"] = RecolorStage.AvatarPath,
                ["parameters"] = new List<object>(), ["controls"] = new List<object>(),
                ["conflicts"] = new List<object>(), ["selector_owned_paths"] = new List<object>(), ["overlap"] = new List<object>(),
            });
            AssetDatabase.ImportAsset(RecordPath);
            Observe(new List<string>(), new List<string>());
        }

        /// <summary>
        /// A supplied name is a contract: silently sharing it with a vendor controller changes both systems, so fail with evidence.
        /// For the default name, choose the first free deterministic suffix. The baked parameter-budget gate remains authoritative.
        /// </summary>
        public static string ResolveParameter(GameObject avatar, string requested, string expectedType)
        {
            var occupied = new Dictionary<string, HashSet<string>>();
            void Add(string name, string owner)
            {
                if (string.IsNullOrEmpty(name)) return;
                if (!occupied.TryGetValue(name, out var owners)) occupied[name] = owners = new HashSet<string>();
                owners.Add(owner);
            }
            var descriptor = avatar.GetComponent<VRCAvatarDescriptor>();
            foreach (var p in descriptor?.expressionParameters?.parameters ?? new VRCExpressionParameters.Parameter[0])
                Add(p.name, $"Expression Parameters ({p.valueType})");
            foreach (var (controller, _) in MaterialCurves.Controllers(avatar))
                foreach (var p in controller.parameters) Add(p.name, $"{controller.name} ({p.type})");
            foreach (var component in avatar.GetComponentsInChildren<ModularAvatarParameters>(true))
                foreach (var p in component.parameters) Add(p.nameOrPrefix, $"Modular Avatar Parameters ({p.syncType})");

            if (!string.IsNullOrEmpty(requested))
            {
                if (occupied.TryGetValue(requested, out var owners))
                    throw new Exception($"菜单参数 {requested} 已被厂商资产占用：{string.Join(", ", owners)}。请在方案 menu.parameter 中换一个业务专用名称");
                return requested;
            }
            const string basis = "AVH/Outfit";
            for (var suffix = 1; suffix <= 999; suffix++)
            {
                var candidate = suffix == 1 ? basis : basis + suffix;
                if (!occupied.ContainsKey(candidate)) return candidate;
            }
            throw new Exception($"找不到可用菜单参数名（{basis}…{basis}999 均被占用，所需类型 {expectedType}）");
        }

        /// <summary>SOP 60 步骤 1：厂商层（描述符与 MA Merge Animator）动到的、落在本单开关物体上的 m_IsActive 曲线。</summary>
        public static List<string> VendorOverlap(GameObject avatar, List<Transform> controlled)
        {
            var hits = new List<string>();
            var targets = new HashSet<Transform>(controlled);
            foreach (var (controller, root) in MaterialCurves.Controllers(avatar))
                foreach (var clip in controller.animationClips.Distinct())
                    foreach (var binding in AnimationUtility.GetCurveBindings(clip))
                    {
                        if (binding.propertyName != "m_IsActive") continue;
                        var target = binding.path.Length == 0 ? root : root.Find(binding.path);
                        if (target != null && targets.Contains(target)) hits.Add($"{controller.name}/{clip.name} → {target.name}");
                    }
            return hits.Distinct().ToList();
        }

        static ModularAvatarMenuItem Toggle(GameObject parent, string label, string parameter, int value, bool saved, bool isDefault)
        {
            var go = new GameObject(label);
            go.transform.SetParent(parent.transform, false);
            var item = go.AddComponent<ModularAvatarMenuItem>();
            item.Control = new VRCExpressionsMenu.Control
            {
                name = label, type = VRCExpressionsMenu.Control.ControlType.Toggle, value = value,
                parameter = new VRCExpressionsMenu.Control.Parameter { name = parameter },
            };
            item.isSaved = saved;
            item.isSynced = true;
            item.isDefault = isDefault;
            item.label = label;
            return item;
        }

        static ModularAvatarMenuItem Radial(GameObject parent, string label, string parameter, bool saved)
        {
            var go = new GameObject(label);
            go.transform.SetParent(parent.transform, false);
            var item = go.AddComponent<ModularAvatarMenuItem>();
            item.Control = new VRCExpressionsMenu.Control
            {
                name = label, type = VRCExpressionsMenu.Control.ControlType.RadialPuppet,
                subParameters = new[] { new VRCExpressionsMenu.Control.Parameter { name = parameter } },
            };
            item.isSaved = saved; item.isSynced = true; item.label = label;
            return item;
        }

        static void Objects(ModularAvatarMenuItem item, params (string path, bool active)[] objects)
        {
            var toggle = item.gameObject.AddComponent<ModularAvatarObjectToggle>();
            toggle.Objects = objects.Select(o => new ToggledObject { Object = new AvatarObjectReference { referencePath = o.path }, Active = o.active }).ToList();
        }

        /// <summary>
        /// One radial float selects the whole outfit. Every state writes every outfit root plus every visual BoneProxy child.
        /// BoneProxy reparents during NDMF, so root-only curves would leave headwear/props from the previous outfit visible.
        /// </summary>
        public static List<(Transform target, int slot)> SelectorTargets(GameObject avatar,
            List<Dictionary<string, object>> outfits, List<Transform> controlled)
        {
            bool Excluded(Transform target)
            {
                for (var parent = target; parent != null; parent = parent.parent)
                    if (parent.CompareTag("EditorOnly")) return true;
                return false;
            }
            var owned = new List<(Transform target, int slot)>();
            for (var slot = 0; slot < outfits.Count; slot++)
            {
                if (OutfitStage.Fixed(outfits[slot])) throw new Exception("固定件不能归衣装轮盘控制");
                if (Excluded(controlled[slot])) throw new Exception("衣装轮盘不能提供已排除的整套衣装");
                owned.Add((controlled[slot], slot));
                foreach (var path in outfits[slot].List("bone_proxy_visuals").Select(x => x.ToString()))
                {
                    var target = avatar.transform.Find(path) ?? throw new Exception($"BoneProxy 可视件路径不存在：{path}");
                    // Inactive objects still belong to the selector. Only actual build exclusion removes ownership.
                    if (!Excluded(target)) owned.Add((target, slot));
                }
            }
            return owned.GroupBy(value => value.target).Select(group => group.First()).ToList();
        }

        static AnimatorController InstallSelectorController(GameObject avatar, GameObject root, List<Dictionary<string, object>> outfits,
            Dictionary<string, object> defaultEntry, List<Transform> controlled, string parameter, bool saved)
        {
            OutfitStage.EnsureFolder(ClipDir);
            var controller = AnimatorController.CreateAnimatorControllerAtPath(ControllerPath);
            controller.AddParameter(parameter, AnimatorControllerParameterType.Float);
            var layer = controller.layers[0];
            layer.name = "AVH Outfit Override";
            layer.defaultWeight = 1;
            var machine = layer.stateMachine;
            var clip = new AnimationClip { name = "Outfit_Radial" };
            foreach (var entry in SelectorTargets(avatar, outfits, controlled))
            {
                var curve = new AnimationCurve();
                for (var slot = 0; slot < outfits.Count; slot++)
                    curve.AddKey(new Keyframe((float)slot / outfits.Count, slot == entry.slot ? 1 : 0,
                        float.PositiveInfinity, float.PositiveInfinity));
                curve.AddKey(new Keyframe(1f, entry.slot == outfits.Count - 1 ? 1 : 0,
                    float.PositiveInfinity, float.PositiveInfinity));
                var path = AnimationUtility.CalculateTransformPath(entry.target, avatar.transform);
                AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve(path, typeof(GameObject), "m_IsActive"), curve);
            }
            AssetDatabase.CreateAsset(clip, $"{ClipDir}/Outfit_Radial.anim");
            var state = machine.AddState("衣装轮盘");
            state.motion = clip; state.writeDefaultValues = false; state.timeParameterActive = true; state.timeParameter = parameter; state.speed = 0;
            machine.defaultState = state;
            controller.layers = new[] { layer };

            var merge = root.AddComponent<ModularAvatarMergeAnimator>();
            merge.animator = controller;
            merge.layerType = VRC.SDK3.Avatars.Components.VRCAvatarDescriptor.AnimLayerType.FX;
            merge.pathMode = MergeAnimatorPathMode.Absolute;
            merge.matchAvatarWriteDefaults = false;
            merge.layerPriority = 1000;
            merge.mergeAnimatorMode = MergeAnimatorMode.Append;
            var parameters = root.AddComponent<ModularAvatarParameters>();
            parameters.parameters = new List<ParameterConfig> { new ParameterConfig
            {
                nameOrPrefix = parameter,
                syncType = ParameterSyncType.Float,
                saved = saved,
                defaultValue = (float)outfits.IndexOf(defaultEntry) / outfits.Count,
                hasExplicitDefaultValue = true,
            } };
            return controller;
        }

        /// <summary>
        /// A control is a semantic component set, not a mesh: each outfit cell may contain many objects and objects displaced
        /// while the set is on. One toggle owns that same semantic channel across every outfit that declares a cell.
        /// </summary>
        static List<string> InstallComponentMatrix(GameObject avatar, GameObject root, AnimatorController controller, Dictionary<string, object> design,
            List<Dictionary<string, object>> outfits, bool saved, List<object> records)
        {
            var groups = design.List("component_groups").Cast<Dictionary<string, object>>().ToList();
            if (groups.Count > 7) throw new Exception("部件区超过 7 个；顶层还需保留衣装轮盘，请重新按用户任务聚类");
            var outfitRoots = outfits.ToDictionary(o => o.Str("id"), o => o.Str("object"));
            var parameters = new List<string>();
            var owners = new Dictionary<string, string>();
            var propertyOwners = new Dictionary<string, string>();
            var parameterComponent = root.GetComponent<ModularAvatarParameters>();
            foreach (var group in groups)
            {
                var label = group.Str("label");
                var controls = group.List("controls").Cast<Dictionary<string, object>>().ToList();
                if (string.IsNullOrWhiteSpace(label) || controls.Count == 0 || controls.Count > 8)
                    throw new Exception("每个部件区必须有用户可理解的名称，并包含 1～8 个语义部件组");
                var groupObject = new GameObject(label); groupObject.transform.SetParent(root.transform, false);
                var groupMenu = groupObject.AddComponent<ModularAvatarMenuItem>();
                groupMenu.Control = new VRCExpressionsMenu.Control { name = label, type = VRCExpressionsMenu.Control.ControlType.SubMenu };
                groupMenu.MenuSource = SubmenuSource.Children;
                foreach (var control in controls)
                {
                    var id = control.Str("id"); var controlLabel = control.Str("label");
                    if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(controlLabel)) throw new Exception($"部件区「{label}」有无 id/名称的控件");
                    var requested = control.Str("parameter") ?? $"AVH/Part/{id}";
                    var resolved = ResolveParameter(avatar, requested, "Bool");
                    if (parameters.Contains(resolved)) throw new Exception($"部件参数 {resolved} 被多个语义控件复用");
                    parameters.Add(resolved);
                    var objects = new List<(string path, bool active)>();
                    var vendorPairs = new List<Dictionary<string, object>>();
                    var targetRecords = new List<object>();
                    foreach (var cell in control.List("targets").Cast<Dictionary<string, object>>())
                    {
                        var outfit = cell.Str("outfit");
                        if (!outfitRoots.TryGetValue(outfit, out var outfitRoot)) throw new Exception($"部件组 {id} 引用了不存在的衣装 {outfit}");
                        var members = cell.List("objects").Select(x => ValidateOwnedPath(avatar, x.ToString(), outfitRoot, owners, id)).Distinct().ToList();
                        var displaced = cell.List("disable_when_on").Select(x => ValidateOwnedPath(avatar, x.ToString(), outfitRoot, owners, id)).Distinct().ToList();
                        foreach (var path in members) objects.Add((path, true));
                        foreach (var path in displaced) objects.Add((path, false));
                        vendorPairs.AddRange(cell.List("vendor_clips").Cast<Dictionary<string, object>>());
                        targetRecords.Add(new Dictionary<string, object>
                        {
                            ["outfit"] = outfit,
                            ["members"] = members.Cast<object>().ToList(),
                            ["displaced"] = displaced.Cast<object>().ToList(),
                        });
                    }
                    if (objects.Count == 0 && vendorPairs.Count == 0) throw new Exception($"部件组 {id} 没有对象集合或厂商 ON/OFF clip；整个通道不能是空的");
                    var contradictory = objects.GroupBy(o => o.path).FirstOrDefault(entries => entries.Select(o => o.active).Distinct().Count() > 1);
                    if (contradictory != null) throw new Exception($"部件组 {id} 同时要求 {contradictory.Key} 开和关；请在设计矩阵里明确唯一状态");
                    objects = objects.GroupBy(o => (o.path, o.active)).Select(entries => entries.First()).ToList();
                    var item = Toggle(groupObject, controlLabel, resolved, 1, saved, control.Str("default") != "False");
                    InstallComponentLayer(controller, avatar, id, controlLabel, resolved, control.Str("default") != "False",
                        objects, vendorPairs, propertyOwners);
                    parameterComponent.parameters.Add(new ParameterConfig { nameOrPrefix = resolved, syncType = ParameterSyncType.Bool,
                        saved = saved, defaultValue = control.Str("default") != "False" ? 1 : 0, hasExplicitDefaultValue = true });
                    var controlRecord = Control(item, resolved, "Bool", 1,
                        $"横向部件区开关 {id}：{objects.Count} 个组成物/让位物，{vendorPairs.Count} 对厂商 ON/OFF clip");
                    controlRecord["semantic_id"] = id;
                    controlRecord["targets"] = targetRecords;
                    records.Add(controlRecord);
                }
            }
            return parameters;
        }

        static void InstallComponentLayer(AnimatorController controller, GameObject avatar, string id, string label, string parameter,
            bool defaultOn, List<(string path, bool active)> objects, List<Dictionary<string, object>> vendorPairs,
            Dictionary<string, string> propertyOwners)
        {
            if (!id.All(c => char.IsLetterOrDigit(c) || c == '_' || c == '-')) throw new Exception($"部件组 id 只能用字母、数字、_、-：{id}");
            controller.AddParameter(parameter, AnimatorControllerParameterType.Bool);
            var on = new AnimationClip { name = $"Part_{id}_ON" };
            var off = new AnimationClip { name = $"Part_{id}_OFF" };
            foreach (var (path, active) in objects)
            {
                Own(propertyOwners, id, path, typeof(GameObject), "m_IsActive");
                AnimationUtility.SetEditorCurve(on, EditorCurveBinding.FloatCurve(path, typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1f / 60f, active ? 1 : 0));
                AnimationUtility.SetEditorCurve(off, EditorCurveBinding.FloatCurve(path, typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1f / 60f, active ? 0 : 1));
            }
            foreach (var pair in vendorPairs)
            {
                var prefix = pair.Str("root") ?? "";
                var allowedDefaultOff = new HashSet<string>(pair.List("allow_default_off").Select(x => x.ToString()));
                CopyVendorClip(pair.Str("on_clip"), on, prefix, avatar, id, propertyOwners, true, allowedDefaultOff);
                CopyVendorClip(pair.Str("off_clip"), off, prefix, avatar, id, propertyOwners, false, allowedDefaultOff);
            }
            AssetDatabase.CreateAsset(on, $"{ClipDir}/Part_{id}_ON.anim");
            AssetDatabase.CreateAsset(off, $"{ClipDir}/Part_{id}_OFF.anim");
            controller.AddLayer($"AVH Part {label}");
            var layers = controller.layers; var layer = layers[layers.Length - 1]; layer.defaultWeight = 1;
            var offState = layer.stateMachine.AddState("OFF"); offState.motion = off; offState.writeDefaultValues = false;
            var onState = layer.stateMachine.AddState("ON"); onState.motion = on; onState.writeDefaultValues = false;
            layer.stateMachine.defaultState = defaultOn ? onState : offState;
            var toOn = offState.AddTransition(onState); toOn.hasExitTime = false; toOn.duration = 0; toOn.AddCondition(AnimatorConditionMode.If, 0, parameter);
            var toOff = onState.AddTransition(offState); toOff.hasExitTime = false; toOff.duration = 0; toOff.AddCondition(AnimatorConditionMode.IfNot, 0, parameter);
            layers[layers.Length - 1] = layer; controller.layers = layers;
        }

        static void CopyVendorClip(string assetPath, AnimationClip destination, string prefix, GameObject avatar, string owner,
            Dictionary<string, string> propertyOwners, bool isOnClip, HashSet<string> allowedDefaultOff)
        {
            if (string.IsNullOrEmpty(assetPath)) throw new Exception($"部件组 {owner} 的 vendor_clips 缺少 on_clip/off_clip");
            var source = AssetDatabase.LoadAssetAtPath<AnimationClip>(assetPath) ?? throw new Exception($"厂商动画不存在：{assetPath}");
            foreach (var binding in AnimationUtility.GetCurveBindings(source))
            {
                var mapped = binding; mapped.path = JoinPath(prefix, binding.path);
                if (mapped.path.Length > 0 && mapped.type != typeof(Animator) && avatar.transform.Find(mapped.path) == null)
                    throw new Exception($"厂商动画 {assetPath} 的目标路径无法映射到头像：{mapped.path}");
                var curve = AnimationUtility.GetEditorCurve(source, binding);
                var target = mapped.path.Length == 0 ? avatar.transform : avatar.transform.Find(mapped.path);
                if (isOnClip && mapped.type == typeof(GameObject) && mapped.propertyName == "m_IsActive" && target != null
                    && !target.gameObject.activeSelf && curve.keys.Any(key => key.value > 0.5f) && !allowedDefaultOff.Contains(mapped.path))
                    throw new Exception($"厂商 ON 动画 {assetPath} 会开启默认关闭的备选件 {mapped.path}；不要自动收进部件区。确认确实需要时在 allow_default_off 显式列出");
                Own(propertyOwners, owner, mapped.path, mapped.type, mapped.propertyName);
                AnimationUtility.SetEditorCurve(destination, mapped, curve);
            }
            foreach (var binding in AnimationUtility.GetObjectReferenceCurveBindings(source))
            {
                var mapped = binding; mapped.path = JoinPath(prefix, binding.path);
                if (mapped.path.Length > 0 && avatar.transform.Find(mapped.path) == null)
                    throw new Exception($"厂商动画 {assetPath} 的对象引用目标无法映射到头像：{mapped.path}");
                Own(propertyOwners, owner, mapped.path, mapped.type, mapped.propertyName);
                AnimationUtility.SetObjectReferenceCurve(destination, mapped, AnimationUtility.GetObjectReferenceCurve(source, binding));
            }
        }

        static string JoinPath(string prefix, string path) => string.IsNullOrEmpty(prefix) ? path : string.IsNullOrEmpty(path) ? prefix : prefix.TrimEnd('/') + "/" + path;

        static void Own(Dictionary<string, string> owners, string owner, string path, Type type, string property)
        {
            var key = $"{path}|{type.FullName}|{property}";
            if (owners.TryGetValue(key, out var previous) && previous != owner)
                throw new Exception($"动画属性 {path}:{property} 同时由部件组 {previous} 与 {owner} 写；必须收归一个最终所有者");
            owners[key] = owner;
        }

        static string ValidateOwnedPath(GameObject avatar, string path, string outfitRoot, Dictionary<string, string> owners, string owner)
        {
            if (string.IsNullOrEmpty(path) || !(path == outfitRoot || path.StartsWith(outfitRoot + "/")))
                throw new Exception($"部件组 {owner} 的对象 {path} 不在声明的衣装根 {outfitRoot} 下");
            if (avatar.transform.Find(path) == null) throw new Exception($"部件组 {owner} 的对象路径不存在：{path}");
            if (owners.TryGetValue(path, out var previous) && previous != owner)
                throw new Exception($"对象 {path} 同时由部件组 {previous} 与 {owner} 写显隐；一条属性只能有一个所有者");
            owners[path] = owner;
            return path;
        }

        static Dictionary<string, object> Control(ModularAvatarMenuItem item, string parameter, string type, int value, string note) =>
            new Dictionary<string, object> { ["label"] = item.label, ["control"] = "Toggle", ["parameter"] = parameter, ["type"] = type, ["value"] = value, ["note"] = note };

        internal static void Observe(List<string> parameters, List<string> sources)
        {
            var record = Avh.ReadJsonFile(Avh.Abs(RecordPath));
            var conflicts = record.List("conflicts").Cast<Dictionary<string, object>>().ToList();
            var order = new HashSet<(string, string)>();
            foreach (var entry in conflicts)
            {
                var chain = entry.List("priority").Select(x => x.ToString()).ToList();
                for (var i = 0; i < chain.Count; i++) for (var j = i + 1; j < chain.Count; j++) order.Add((chain[i], chain[j]));
            }
            var mutual = order.Count(pair => string.CompareOrdinal(pair.Item1, pair.Item2) < 0 && order.Contains((pair.Item2, pair.Item1)));
            var empty = conflicts.Count(entry => entry.List("sources").Select(x => x.ToString()).Except(entry.List("priority").Select(x => x.ToString())).Any());
            Avh.Observation("menu.configure", new Dictionary<string, object>
            {
                ["menu_route_valid"] = record.Str("route") == "groups" || record.Str("route") == "A" || record.Str("route") == "B"
                    || (record.Str("route") == "preserve" && OutfitStage.IsUnmodifiedVariant(
                        AssetDatabase.LoadAssetAtPath<GameObject>(AvatarPath), RecolorStage.AvatarPath)),
                ["mutual_priority_pairs"] = mutual, ["empty_priority_chain_entries"] = empty,
            }, new List<string> { $"路线 {record.Str("route")}，交集 {record.List("overlap").Count}" });

            var notes = new List<string>();
            var dump = AvatarAudit.OnBaked(AvatarPath, baked => AvatarAudit.MenuDump(baked, parameters, sources, notes));
            var ledger = Avh.ReadJsonFile(Avh.Abs(RecolorStage.LedgerPath));
            var replaced = new HashSet<(string, int, string)>((ledger?.List("rows") ?? new List<object>()).Cast<Dictionary<string, object>>()
                .Select(r => (r.Str("renderer"), Convert.ToInt32(r["slot"]), r.Str("original_guid"))));
            var baseline = Avh.ReadJsonFile(Avh.Abs("_harness/setup/baseline.json"));
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(AvatarPath));
            try
            {
                dump["stale_material_curves"] = MaterialCurves.Stale(avatar, replaced, notes);
                Avh.Observation("menu.dump", dump, notes);
                var observeNotes = new List<string>();
                Avh.Observation("avatar.observe", Measure.Observe(avatar, baseline, observeNotes), observeNotes);
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }
    }
}
