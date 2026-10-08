// 【项目沉淀】通用工具（Harness setup 阶段的 Unity 步骤）
// 适用素体：无关（从导入报告里找带 Avatar 描述符的素体预制体）
// 工具链　：Unity 2022.3 批处理；VRChat SDK3 Avatars
// 可复用性：★★★ 换个单子直接能用
// 用途　　：首次导入与编译完成后，找到素体预制体，实例化到空场景量骨架基线（头、脚、左眼的世界高度，Avatar 描述符数，
//           空材质槽），写 _harness/setup/baseline.json。后续阶段的「骨架高度不变 / 空材质槽 = 0」都对这份基线。
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Avatars.Components;

namespace AVH.Harness
{
    public static class SetupStage
    {
        public static void Run() => Avh.Stage("setup", () =>
        {
            var inventory = Avh.ReadJsonFile(Avh.Abs("_harness/intake/inventory.json")) ?? throw new Exception("缺少 inventory.json");
            var import = Avh.ReadJsonFile(Avh.Abs("_harness/setup/import.json")) ?? throw new Exception("缺少 import.json");
            var bodyItem = inventory.List("items").Cast<Dictionary<string, object>>().First(i => i.Str("role") == "body").Str("item");
            var key = (inventory.Str("body_key") ?? "").ToLowerInvariant();
            var roots = import.List("packages").Cast<Dictionary<string, object>>().Where(p => p.Str("item") == bodyItem)
                .SelectMany(p => p.List("roots").Select(r => r.ToString())).Distinct().Where(AssetDatabase.IsValidFolder).ToArray();
            if (roots.Length == 0) throw new Exception("导入报告里没有素体包的目录");
            // 方案指定了素体预制体就用方案的（它决定后面每一层变体的底），否则按命名规则找。
            var planned = Avh.Plan().Str("body_prefab");
            var body = string.IsNullOrEmpty(planned) ? FindBodyPrefab(roots, key) : AssetDatabase.LoadAssetAtPath<GameObject>(planned);
            if (body == null || body.GetComponent<VRCAvatarDescriptor>() == null)
                throw new Exception($"方案指定的素体预制体 {planned} 加载不了或没有 Avatar 描述符");
            var baseline = Measure.Avatar(body);
            baseline["body_prefab"] = AssetDatabase.GetAssetPath(body);
            baseline["body_roots"] = roots.ToList();
            Avh.WriteJson(Avh.Abs("_harness/setup/baseline.json"), baseline);
            FaceStage.PrepareReadableSource(Avh.Plan());
            LocalOperations.Observe(body, Avh.Plan());
        });

        /// <summary>Prefabs with an avatar descriptor at their root; the one named after the body, PC over Quest, shallowest path.</summary>
        public static GameObject FindBodyPrefab(string[] roots, string key)
        {
            var candidates = AssetDatabase.FindAssets("t:Prefab", roots).Select(AssetDatabase.GUIDToAssetPath)
                .Select(path => (path, go: AssetDatabase.LoadAssetAtPath<GameObject>(path)))
                .Where(x => x.go != null && x.go.GetComponent<VRCAvatarDescriptor>() != null).ToList();
            if (candidates.Count == 0) throw new Exception($"素体目录 {string.Join(", ", roots)} 里没有带 Avatar 描述符的预制体");
            var best = candidates.OrderByDescending(x => !string.IsNullOrEmpty(key) && Path.GetFileNameWithoutExtension(x.path).ToLowerInvariant().Contains(key))
                .ThenBy(x => x.path.ToLowerInvariant().Contains("quest") || x.path.ToLowerInvariant().Contains("android"))
                .ThenBy(x => x.path.Count(c => c == '/')).ThenBy(x => x.path.Length).First();
            Avh.Log($"body prefab: {best.path}（候选 {candidates.Count} 个：{string.Join(", ", candidates.Select(c => c.path))}）");
            return best.go;
        }
    }

    /// <summary>Measurements shared by every stage that checks the skeleton and materials; kept apart from any stage's actions.</summary>
    public static class Measure
    {
        public static Dictionary<string, object> Avatar(GameObject prefab)
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try { return Instance(instance); }
            finally { UnityEngine.Object.DestroyImmediate(instance); }
        }

        public static Dictionary<string, object> Instance(GameObject root)
        {
            var result = new Dictionary<string, object>();
            var animator = root.GetComponent<Animator>();
            result["animator_is_human"] = animator != null && animator.isHuman;
            float? Y(HumanBodyBones bone)
            {
                var t = animator != null && animator.isHuman ? animator.GetBoneTransform(bone) : null;
                return t != null ? t.position.y : (float?)null;
            }
            var head = Y(HumanBodyBones.Head);
            var footL = Y(HumanBodyBones.LeftFoot);
            var footR = Y(HumanBodyBones.RightFoot);
            result["head_y"] = head;
            result["foot_y"] = footL.HasValue && footR.HasValue ? (footL + footR) / 2 : null;
            result["head_foot_y_mm"] = head.HasValue && footL.HasValue && footR.HasValue ? (head.Value - (footL.Value + footR.Value) / 2) * 1000 : (float?)null;
            result["eye_l_y"] = Y(HumanBodyBones.LeftEye);
            result["avatar_descriptor_count"] = root.GetComponentsInChildren<VRCAvatarDescriptor>(true).Length;
            var renderers = root.GetComponentsInChildren<Renderer>(true);
            result["renderers"] = renderers.Length;
            var empty = EmptySlots(root).ToList();
            result["empty_material_slots"] = empty.Count;
            result["empty_material_slot_paths"] = empty.Select(e => (object)e).ToList();
            return result;
        }

        /// <summary>
        /// Null material slots that would render (magenta). Not counted, in the spirit of SOP 80's false positives:
        /// placeholders scaled to zero, particle systems whose emission module is off (containers that never emit), and a
        /// particle renderer's trail slot while its trails module is off.
        /// </summary>
        public static IEnumerable<string> EmptySlots(GameObject root)
        {
            foreach (var r in root.GetComponentsInChildren<Renderer>(true))
            {
                var scale = r.transform.lossyScale;
                if (Mathf.Approximately(scale.x, 0) || Mathf.Approximately(scale.y, 0) || Mathf.Approximately(scale.z, 0)) continue;
                var materials = r.sharedMaterials;
                for (var i = 0; i < materials.Length; i++)
                {
                    if (materials[i] != null) continue;
                    if (r is ParticleSystemRenderer)
                    {
                        if (!r.enabled && !ParticleEnableWriter(root, r)) continue;
                        var ps = r.GetComponent<ParticleSystem>();
                        if (ps != null && !ps.emission.enabled) continue;
                        if (i == 1 && !(ps != null && ps.trails.enabled)) continue;
                    }
                    yield return $"{Probe.HierarchyPath(root.transform, r.transform)}[{i}]";
                }
            }
        }

        // Disabled particle renderers can serve trigger logic without drawing. Keep potentially animated ones in scope.
        static bool ParticleEnableWriter(GameObject root, Renderer renderer)
        {
            var controllers = root.GetComponentsInChildren<Animator>(true).Select(a => a.runtimeAnimatorController)
                .Concat(root.GetComponentsInChildren<ModularAvatarMergeAnimator>(true).Select(a => a.animator))
                .Concat(root.GetComponentsInChildren<VRCAvatarDescriptor>(true).SelectMany(d =>
                    (d.baseAnimationLayers ?? Array.Empty<VRCAvatarDescriptor.CustomAnimLayer>())
                    .Concat(d.specialAnimationLayers ?? Array.Empty<VRCAvatarDescriptor.CustomAnimLayer>()).Select(l => l.animatorController)))
                .Where(c => c != null).Distinct();
            foreach (var controller in controllers)
                foreach (var clip in controller.animationClips.Where(c => c != null))
                    if (AnimationUtility.GetCurveBindings(clip).Any(b => b.propertyName == "m_Enabled"
                        && typeof(Renderer).IsAssignableFrom(b.type)
                        && (b.path == renderer.name || b.path.EndsWith("/" + renderer.name, StringComparison.Ordinal)))) return true;
            return false;
        }

        /// <summary>avatar.observe for a stage: the measurements plus deltas against the setup baseline.</summary>
        public static Dictionary<string, object> Observe(GameObject root, Dictionary<string, object> baseline, List<string> notes)
        {
            var result = Instance(root);
            result["fixed_outfit_state_failures"] = OutfitMeasure.FixedFailures(root,
                Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)), Avh.Plan(), notes);
            double? Delta(string key, double scale)
            {
                if (baseline == null || !baseline.TryGetValue(key, out var before) || before == null || !result.TryGetValue(key, out var now) || now == null) return null;
                return Math.Round((Convert.ToDouble(now) - Convert.ToDouble(before)) * scale, 4);
            }
            result["head_foot_y_delta_mm"] = Delta("head_foot_y_mm", 1);
            // 眼高：基线与当前都明确是 Humanoid 且没有左眼人形骨 ⇒ 已证实的空适用集合，没有可测位移，记 0。
            // 缺基线、非 Humanoid（测量不成立）、或只有一侧缺骨，仍是 null（no_data），不当作零。
            bool NoEyeBone(Dictionary<string, object> reading)
            {
                if (reading == null || !reading.TryGetValue("animator_is_human", out var human) || !Equals(human, true)) return false;
                return reading.TryGetValue("eye_l_y", out var eye) && eye == null;
            }
            result["eye_l_y_delta"] = NoEyeBone(baseline) && NoEyeBone(result) ? (double?)0 : Delta("eye_l_y", 1);
            var paths = (List<object>)result["empty_material_slot_paths"];
            if (paths.Count > 0) notes.Add("空材质槽：" + string.Join(", ", paths.Take(10)));
            result.Remove("empty_material_slot_paths");
            return result;
        }
    }
}
