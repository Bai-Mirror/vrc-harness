// 【项目沉淀】通用工具（Harness 的只读探测步骤）
// 适用素体：无关
// 工具链　：Unity 2022.3 批处理
// 可复用性：★★★ 换个单子直接能用
// 用途　　：把若干预制体逐个实例化到空场景，列出渲染器（路径、网格、是否激活、材质槽）和装配相关组件
//           （MA / VRCFury / Avatar 描述符），写到 Run 目录的 probe.json。只读，不改工程；开发与排查用，
//           也是 SOP 50 步骤 1「先探清每件预制体自带什么」的批处理版本。
// 用法　　：AVH_PROBE_PREFABS='["Assets/…/a.prefab", …]' -executeMethod AVH.Harness.Probe.Run
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace AVH.Harness
{
    public static class Probe
    {
        public static void Run() => Avh.Stage("probe", () =>
        {
            var paths = (Avh.ParseJson(Avh.Env("AVH_PROBE_PREFABS", "[]")) as List<object> ?? new List<object>()).Select(p => p.ToString());
            var result = new Dictionary<string, object>();
            foreach (var path in paths) result[path] = Describe(path);
            Avh.WriteJson(Path.Combine(Avh.RunDir, "probe.json"), result);
        }, save: false);

        /// <summary>Dump the baked FX layers a parameter drives: states, motions, transitions (AVH_PROBE_PREFAB, AVH_PROBE_PARAM).</summary>
        public static void Layers() => Avh.Stage("probe-layers", () =>
        {
            var param = Avh.Env("AVH_PROBE_PARAM", "Outfit");
            var dump = AvatarAudit.OnBaked(Avh.Env("AVH_PROBE_PREFAB"), baked =>
            {
                var result = new List<object>();
                var descriptor = baked.GetComponent<VRC.SDK3.Avatars.Components.VRCAvatarDescriptor>();
                foreach (var (type, controller) in AvatarAudit.Layers(descriptor))
                    foreach (var layer in controller.layers)
                    {
                        var states = AvatarAudit.States(layer.stateMachine).ToList();
                        var text = UnityEditor.EditorJsonUtility.ToJson(layer.stateMachine);
                        bool Uses(UnityEditor.Animations.AnimatorTransitionBase t) => t.conditions.Any(c => c.parameter == param);
                        var driven = layer.stateMachine.anyStateTransitions.Any(Uses) || states.SelectMany(s => s.transitions).Any(Uses)
                            || states.Any(s => s.motion is UnityEditor.Animations.BlendTree);
                        if (!driven) continue;
                        result.Add(new Dictionary<string, object>
                        {
                            ["controller"] = $"{type}:{controller.name}", ["layer"] = layer.name, ["weight"] = layer.defaultWeight,
                            ["default"] = layer.stateMachine.defaultState ? layer.stateMachine.defaultState.name : null,
                            ["states"] = states.Select(s => (object)new Dictionary<string, object>
                            {
                                ["name"] = s.name, ["motion"] = s.motion ? $"{s.motion.GetType().Name}:{s.motion.name}" : null,
                                ["tree"] = s.motion is UnityEditor.Animations.BlendTree tree ? $"{tree.blendType} {tree.blendParameter} children={tree.children.Length} " +
                                    string.Join(",", tree.children.Select(c => $"{c.directBlendParameter}|{c.threshold}|{(c.motion ? c.motion.name : "null")}")) : null,
                                ["writeDefaults"] = s.writeDefaultValues,
                                ["transitions"] = s.transitions.Select(t => (object)$"→{(t.destinationState ? t.destinationState.name : "exit")} " +
                                    string.Join(" & ", t.conditions.Select(c => $"{c.parameter} {c.mode} {c.threshold}"))).ToList(),
                                ["bindings"] = (s.motion is AnimationClip clip ? AnimationUtility.GetCurveBindings(clip).Select(b => (object)$"{b.path}.{b.propertyName}={AnimationUtility.GetEditorCurve(clip, b).keys[0].value}").Take(12).ToList() : new List<object>()),
                            }).ToList(),
                            ["any"] = layer.stateMachine.anyStateTransitions.Select(t => (object)$"→{(t.destinationState ? t.destinationState.name : "?")} " +
                                string.Join(" & ", t.conditions.Select(c => $"{c.parameter} {c.mode} {c.threshold}"))).ToList(),
                        });
                    }
                return result;
            });
            Avh.WriteJson(Path.Combine(Avh.RunDir, "layers.json"), dump);
        }, save: false);

        /// <summary>Scene states of named objects and the entry/default wiring of layers whose name contains a filter (AVH_PROBE_PREFAB, AVH_PROBE_PATHS, AVH_PROBE_LAYER).</summary>
        public static void Wiring() => Avh.Stage("probe-wiring", () =>
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(Avh.Env("AVH_PROBE_PREFAB")));
            var result = new Dictionary<string, object>();
            foreach (var path in (Avh.ParseJson(Avh.Env("AVH_PROBE_PATHS", "[]")) as List<object>).Select(x => x.ToString()))
            {
                var t = avatar.transform.Find(path);
                result[path] = t == null ? "missing" : $"activeSelf={t.gameObject.activeSelf} activeInHierarchy={t.gameObject.activeInHierarchy} tag={t.gameObject.tag}";
            }
            var filter = Avh.Env("AVH_PROBE_LAYER", "MA Responsive");
            var descriptor = avatar.GetComponent<VRC.SDK3.Avatars.Components.VRCAvatarDescriptor>();
            foreach (var (type, controller) in AvatarAudit.Layers(descriptor))
                foreach (var layer in controller.layers.Where(l => l.name.Contains(filter)))
                    result[$"{type}/{layer.name}"] = new Dictionary<string, object>
                    {
                        ["weight"] = layer.defaultWeight,
                        ["default"] = layer.stateMachine.defaultState ? layer.stateMachine.defaultState.name : null,
                        ["entry"] = layer.stateMachine.entryTransitions.Select(t => (object)$"→{(t.destinationState ? t.destinationState.name : "?")} " +
                            string.Join(" & ", t.conditions.Select(c => $"{c.parameter} {c.mode} {c.threshold}"))).ToList(),
                        ["param_default"] = controller.parameters.Where(p => p.name == "Outfit").Select(p => (object)$"{p.type} f={p.defaultFloat} b={p.defaultBool} i={p.defaultInt}").ToList(),
                    };
            result["expression_default"] = descriptor.expressionParameters.parameters.Where(p => p.name == "Outfit").Select(p => (object)$"{p.valueType} {p.defaultValue} saved={p.saved}").ToList();
            Avh.WriteJson(Path.Combine(Avh.RunDir, "wiring.json"), result);
            UnityEngine.Object.DestroyImmediate(avatar);
        }, save: false);

        /// <summary>Static members of a type (AVH_PROBE_TYPE), for finding SDK entry points without source.</summary>
        public static void Members() => Avh.Stage("probe-members", () =>
        {
            var name = Avh.Env("AVH_PROBE_TYPE");
            var type = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null) ?? throw new Exception("找不到类型 " + name);
            var flags = System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;
            var lines = type.GetMethods(flags).Select(m => (object)$"method {m.ReturnType.Name} {m.Name}({string.Join(", ", m.GetParameters().Select(x => x.ParameterType.Name + " " + x.Name))})")
                .Concat(type.GetFields(flags).Select(f => (object)$"field {f.FieldType.Name} {f.Name} = {f.GetValue(null)}"))
                .Concat(type.GetProperties(flags).Select(pr => (object)$"property {pr.PropertyType.Name} {pr.Name}")).ToList();
            Avh.WriteJson(Path.Combine(Avh.RunDir, "members.json"), lines);
        }, save: false);

        /// <summary>Serialized form of every PhysBone on objects that carry more than one (AVH_PROBE_PREFAB).</summary>
        public static void PhysBones() => Avh.Stage("probe-physbones", () =>
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(Avh.Env("AVH_PROBE_PREFAB")));
            var result = new Dictionary<string, object>();
            foreach (var group in avatar.GetComponentsInChildren<VRC.SDK3.Dynamics.PhysBone.Components.VRCPhysBone>(true).GroupBy(pb => pb.gameObject).Where(g => g.Count() > 1).Take(3))
                result[HierarchyPath(avatar.transform, group.Key.transform)] = group.Select(pb => (object)EditorJsonUtility.ToJson(pb)).ToList();
            Avh.WriteJson(Path.Combine(Avh.RunDir, "physbones.json"), result);
            UnityEngine.Object.DestroyImmediate(avatar);
        }, save: false);

        /// <summary>State machine behaviours of controllers as Unity loads them: type name, or null when the script is missing (AVH_PROBE_CONTROLLERS).</summary>
        public static void Behaviours() => Avh.Stage("probe-behaviours", () =>
        {
            var result = new Dictionary<string, object>();
            foreach (var path in (Avh.ParseJson(Avh.Env("AVH_PROBE_CONTROLLERS", "[]")) as List<object>).Select(x => x.ToString()))
            {
                var controller = AssetDatabase.LoadAssetAtPath<UnityEditor.Animations.AnimatorController>(path);
                if (controller == null) { result[path] = "无法加载"; continue; }
                var counts = new Dictionary<string, object>();
                foreach (var behaviour in controller.layers.SelectMany(l => AvatarAudit.States(l.stateMachine)).SelectMany(st => st.behaviours)
                             .Concat(controller.layers.SelectMany(l => l.stateMachine.behaviours)))
                {
                    var key = behaviour == null ? "null（脚本丢失）" : behaviour.GetType().FullName;
                    counts[key] = counts.TryGetValue(key, out var n) ? Convert.ToInt32(n) + 1 : 1;
                }
                result[path] = counts;
            }
            Avh.WriteJson(Path.Combine(Avh.RunDir, "behaviours.json"), result);
        }, save: false);

        public static Dictionary<string, object> Describe(string path)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null) return new Dictionary<string, object> { ["error"] = "无法加载" };
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var root = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                var renderers = root.GetComponentsInChildren<Renderer>(true).Select(r => (object)new Dictionary<string, object>
                {
                    ["path"] = HierarchyPath(root.transform, r.transform),
                    ["type"] = r.GetType().Name,
                    ["active"] = r.gameObject.activeInHierarchy && r.enabled,
                    ["mesh"] = MeshName(r),
                    ["materials"] = r.sharedMaterials.Select(m => m ? (object)m.name : null).ToList(),
                    ["blendshapes"] = r is SkinnedMeshRenderer sm && sm.sharedMesh ? sm.sharedMesh.blendShapeCount : 0,
                }).ToList();
                var components = root.GetComponentsInChildren<Component>(true).Where(c => c != null)
                    .Select(c => c.GetType().Name)
                    .Where(n => n.StartsWith("ModularAvatar") || n.StartsWith("VRCFury") || n.Contains("AvatarDescriptor") || n.Contains("PhysBone"))
                    .GroupBy(n => n).ToDictionary(g => g.Key, g => (object)g.Count());
                var missingScripts = root.GetComponentsInChildren<Transform>(true)
                    .Sum(t => GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(t.gameObject));
                var animator = root.GetComponent<Animator>();
                return new Dictionary<string, object>
                {
                    ["renderers"] = renderers,
                    ["components"] = components,
                    ["missing_scripts"] = missingScripts,
                    ["humanoid"] = animator != null && animator.isHuman,
                    ["children"] = root.transform.Cast<Transform>().Select(t => (object)$"{t.name}{(t.gameObject.activeSelf ? "" : " (off)")}").ToList(),
                };
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        // Unity objects compare to null through their own operator; ?. would skip it and touch a destroyed or fake-null object.
        public static string MeshName(Renderer r)
        {
            if (r is SkinnedMeshRenderer skinned) return skinned.sharedMesh ? skinned.sharedMesh.name : null;
            var filter = r.GetComponent<MeshFilter>();
            return filter && filter.sharedMesh ? filter.sharedMesh.name : null;
        }

        public static string HierarchyPath(Transform root, Transform t)
        {
            var parts = new List<string>();
            for (var x = t; x != null && x != root; x = x.parent) parts.Add(x.name);
            parts.Reverse();
            return string.Join("/", parts);
        }
    }
}
