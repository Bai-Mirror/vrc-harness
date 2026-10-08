// 【项目沉淀】通用工具（Harness 的性能读数）
// 适用素体：无关
// 工具链　：Unity 2022.3；VRChat SDK 的 AvatarPerformance（与上传面板同一套统计）
// 可复用性：★★★ 换个单子直接能用
// 用途　　：在构建产物上取性能读数（面数、骨数、蒙皮网格、形态键、PhysBone、包围盒、贴图显存）与贴图审计
//           （未压缩、没开 Mip Streaming、分档是否越线），写成 perf.json 放在产物旁；performance 阶段拿 final 对 pre 比。
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using VRC.SDK3.Dynamics.PhysBone.Components;
using VRC.SDKBase.Validation.Performance;
using VRC.SDKBase.Validation.Performance.Stats;

namespace AVH.Harness
{
    public static class Perf
    {
        static readonly TextureFormat[] Uncompressed =
        {
            TextureFormat.RGBA32, TextureFormat.ARGB32, TextureFormat.RGB24, TextureFormat.RGBAHalf, TextureFormat.RGBAFloat,
            TextureFormat.RGBA4444, TextureFormat.ARGB4444, TextureFormat.RGB565, TextureFormat.BGRA32,
        };

        public static Dictionary<string, object> Measure(GameObject avatar)
        {
            // 分级表平时由 SDK 控制面板加载；批处理里没人开面板，不先加载就会在评级时空引用。
            AvatarPerformanceStats.Initialize();
            var stats = new AvatarPerformanceStats(false);
            AvatarPerformance.CalculatePerformanceStats(avatar.name, avatar, stats, false);
            var shipped = avatar.GetComponentsInChildren<Renderer>(true).Where(r => !OptimizeStage.EditorOnly(r.transform)).ToList();
            var physbones = avatar.GetComponentsInChildren<VRCPhysBone>(true);
            var physboneSafety = PhysBoneSafety(avatar, physbones);
            var bounds = new Bounds();
            var init = false;
            foreach (var r in shipped)
            {
                if (r.bounds.size == Vector3.zero) continue;
                if (init) bounds.Encapsulate(r.bounds); else { bounds = r.bounds; init = true; }
            }
            var textures = new List<object>();
            foreach (var (texture, use) in OptimizeStage.TextureUses(avatar).OrderBy(kv => AssetDatabase.GetAssetPath(kv.Key)))
            {
                var path = AssetDatabase.GetAssetPath(texture);
                var importer = AssetImporter.GetAtPath(path) as TextureImporter;
                var platform = importer?.GetPlatformTextureSettings("Standalone");
                // A texture with an asset path but no TextureImporter (a Texture2D a plugin saved as an .asset) has no
                // import settings to read: the size it ships at is its real pixel size. Reporting no size at all made
                // every such texture look infinitely larger than its tier.
                var realSize = Math.Max(texture.width, texture.height);
                var maxSize = importer == null ? realSize : platform.overridden ? platform.maxTextureSize : importer.maxTextureSize;
                var t2d = texture as Texture2D;
                textures.Add(new Dictionary<string, object>
                {
                    // "role" is the import plan's role (data means the plan must not touch it); "visual_role" is the art
                    // binding the audit judges, and is what tells a data-only texture apart from a mixed-use conflict.
                    ["path"] = path, ["guid"] = AssetDatabase.AssetPathToGUID(path), ["role"] = use.Role,
                    ["visual_role"] = use.Visual, ["mixed_use"] = use.Mixed,
                    ["width"] = texture.width, ["height"] = texture.height, ["max_size"] = maxSize,
                    ["source_size"] = importer != null ? SourceSize(importer) : realSize,
                    ["format"] = t2d != null ? t2d.format.ToString() : texture.GetType().Name,
                    ["uncompressed"] = t2d != null && Uncompressed.Contains(t2d.format),
                    ["streaming_mipmaps"] = importer == null || !importer.mipmapEnabled || importer.streamingMipmaps,
                });
            }
            return new Dictionary<string, object>
            {
                ["schema"] = "perf/0.1",
                ["triangles"] = stats.polyCount, ["bones"] = stats.boneCount, ["skinned_meshes"] = stats.skinnedMeshCount,
                ["meshes"] = stats.meshCount, ["materials"] = stats.materialCount,
                ["blendshapes"] = shipped.OfType<SkinnedMeshRenderer>().Where(s => s.sharedMesh != null).Sum(s => s.sharedMesh.blendShapeCount),
                ["physbone_count"] = stats.physBone.HasValue ? stats.physBone.Value.componentCount : physbones.Length,
                ["duplicate_physbones"] = DuplicatePhysBones(physbones, out var duplicateObjects),
                ["duplicate_physbone_objects"] = duplicateObjects.Select(t => (object)Probe.HierarchyPath(avatar.transform, t)).Distinct().Take(20).ToList(),
                ["invalid_merge_physbones"] = physboneSafety["invalid_merge_physbones"],
                ["invalid_merge_physbone_objects"] = physboneSafety["invalid_merge_physbone_objects"],
                ["physbone_core_humanoid_coverage"] = physboneSafety["physbone_core_humanoid_coverage"],
                ["physbone_core_humanoid_paths"] = physboneSafety["physbone_core_humanoid_paths"],
                ["noop_physbones"] = physboneSafety["noop_physbones"],
                ["noop_physbone_objects"] = physboneSafety["noop_physbone_objects"],
                ["physbones"] = PhysBoneInventory(avatar, physbones),
                ["aabb_contributors"] = shipped.Where(r => r.bounds.size != Vector3.zero)
                    .OrderByDescending(r => (double)r.bounds.size.x * r.bounds.size.y * r.bounds.size.z).Take(20)
                    .Select(r => (object)new Dictionary<string, object>
                    {
                        ["path"] = Probe.HierarchyPath(avatar.transform, r.transform), ["type"] = r.GetType().Name,
                        ["size"] = Vec(r.bounds.size), ["center"] = Vec(r.bounds.center),
                        ["volume"] = Math.Round((double)r.bounds.size.x * r.bounds.size.y * r.bounds.size.z, 3),
                    }).ToList(),
                ["never_visible_triangles"] = NeverVisible(avatar, shipped).Sum(Triangles),
                ["renderer_triangles"] = shipped.Select(r => (r, Triangles(r))).Where(x => x.Item2 > 0)
                    .ToDictionary(x => Probe.HierarchyPath(avatar.transform, x.r.transform) + "#" + x.r.GetType().Name, x => (object)x.Item2),
                ["aabb"] = new List<object> { Math.Round(bounds.size.x, 3), Math.Round(bounds.size.y, 3), Math.Round(bounds.size.z, 3) },
                ["texture_megabytes"] = stats.textureMegabytes.HasValue ? Math.Round(stats.textureMegabytes.Value, 2) : (double?)null,
                ["textures"] = textures,
            };
        }

        /// <summary>
        /// Historical SOP 80 safety checks. These deliberately report rather than mutate: an invalid AAO merge blocks the
        /// build, a core humanoid transform covered by a PhysBone is unsafe, while a no-child/no-endpoint component is only a
        /// removal candidate until an explicit optimize design accepts it.
        /// </summary>
        public static Dictionary<string, object> PhysBoneSafety(GameObject avatar, VRCPhysBone[] physbones = null)
        {
            physbones = physbones ?? avatar.GetComponentsInChildren<VRCPhysBone>(true);
            var invalidMerge = new List<string>();
            var mergeType = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType("Anatawa12.AvatarOptimizer.MergePhysBone"))
                .FirstOrDefault(t => t != null);
            if (mergeType != null)
                foreach (var component in avatar.GetComponentsInChildren(mergeType, true).Cast<Component>())
                {
                    var so = new SerializedObject(component);
                    var mainSet = so.FindProperty("componentsSet")?.FindPropertyRelative("mainSet");
                    var targets = new List<VRCPhysBone>();
                    if (mainSet != null && mainSet.arraySize > 0)
                        for (var i = 0; i < mainSet.arraySize; i++)
                            if (mainSet.GetArrayElementAtIndex(i).objectReferenceValue is VRCPhysBone pb) targets.Add(pb);
                    else
                        foreach (Transform child in component.transform) targets.AddRange(child.GetComponents<VRCPhysBone>());
                    var parents = targets.Select(pb => (pb.rootTransform != null ? pb.rootTransform : pb.transform).parent).Distinct().ToList();
                    if (targets.Count < 2 || parents.Count != 1 || parents[0] != component.transform)
                        invalidMerge.Add(Probe.HierarchyPath(avatar.transform, component.transform));
                }

            var animator = avatar.GetComponent<Animator>();
            var core = new HashSet<Transform>();
            if (animator != null && animator.isHuman && animator.avatar != null && animator.avatar.isValid)
                foreach (HumanBodyBones bone in Enum.GetValues(typeof(HumanBodyBones)))
                    if (bone != HumanBodyBones.LastBone)
                    {
                        var transform = animator.GetBoneTransform(bone);
                        if (transform != null) core.Add(transform);
                    }
            var unsafeCoverage = new HashSet<string>();
            var noop = new List<string>();
            foreach (var pb in physbones)
            {
                var root = pb.rootTransform != null ? pb.rootTransform : pb.transform;
                var ignored = new HashSet<Transform>((pb.ignoreTransforms ?? new List<Transform>()).Where(t => t != null));
                bool Ignored(Transform t) => ignored.Any(i => t == i || t.IsChildOf(i));
                foreach (var transform in root.GetComponentsInChildren<Transform>(true))
                    if (transform != root && !Ignored(transform) && core.Contains(transform))
                        unsafeCoverage.Add(Probe.HierarchyPath(avatar.transform, transform));
                if (IsNoop(pb))
                    noop.Add(Probe.HierarchyPath(avatar.transform, pb.transform));
            }
            return new Dictionary<string, object>
            {
                ["invalid_merge_physbones"] = invalidMerge.Count,
                ["invalid_merge_physbone_objects"] = invalidMerge.Distinct().Cast<object>().ToList(),
                ["physbone_core_humanoid_coverage"] = unsafeCoverage.Count,
                ["physbone_core_humanoid_paths"] = unsafeCoverage.Cast<object>().ToList(),
                ["noop_physbones"] = noop.Count,
                ["noop_physbone_objects"] = noop.Cast<object>().ToList(),
            };
        }

        /// <summary>No simulated child and no virtual endpoint: SOP 80's only mechanically safe empty PhysBone.</summary>
        public static bool IsNoop(VRCPhysBone pb)
        {
            var root = pb.rootTransform != null ? pb.rootTransform : pb.transform;
            return root.childCount == 0 && pb.endpointPosition == Vector3.zero;
        }

        static List<object> PhysBoneInventory(GameObject avatar, VRCPhysBone[] physbones)
        {
            var result = new List<object>();
            foreach (var group in physbones.GroupBy(pb => pb.gameObject))
            {
                var list = group.ToList();
                for (var index = 0; index < list.Count; index++)
                {
                    var pb = list[index]; var root = pb.rootTransform != null ? pb.rootTransform : pb.transform;
                    var ignored = new HashSet<Transform>((pb.ignoreTransforms ?? new List<Transform>()).Where(t => t != null));
                    var affected = root.GetComponentsInChildren<Transform>(true).Count(t => !ignored.Any(i => t == i || t.IsChildOf(i)));
                    result.Add(new Dictionary<string, object>
                    {
                        ["object"] = Probe.HierarchyPath(avatar.transform, pb.transform), ["component_index"] = index,
                        ["root"] = Probe.HierarchyPath(avatar.transform, root), ["affected_transforms"] = affected,
                        ["colliders"] = pb.colliders.Count(c => c != null), ["ignored_roots"] = ignored.Count,
                        ["redundant_with"] = Enumerable.Range(0, list.Count).Where(other => other != index && Redundant(list[index], list[other]))
                            .Select(other => (object)other).ToList(),
                    });
                }
            }
            return result;
        }

        static List<object> Vec(Vector3 value) => new List<object> { Math.Round(value.x, 3), Math.Round(value.y, 3), Math.Round(value.z, 3) };

        /// <summary>
        /// SOP 80（DedupePhysBones.cs 的判据）：同一物体上两个 PhysBone，除碰撞体列表外逐字段相同、且一方的碰撞体是另一方的子集，
        /// 才是冗余副本。同物体多个 PB 指向不同骨链不算。
        /// </summary>
        static int DuplicatePhysBones(VRCPhysBone[] physbones, out List<Transform> where)
        {
            var count = 0;
            where = new List<Transform>();
            foreach (var group in physbones.GroupBy(pb => pb.gameObject).Where(g => g.Count() > 1))
            {
                var list = group.ToList();
                for (var i = 0; i < list.Count; i++)
                    for (var j = i + 1; j < list.Count; j++)
                    {
                        var a = list[i]; var b = list[j];
                        var same = SameExceptColliders(a, b);
                        var ca = new HashSet<VRC.Dynamics.VRCPhysBoneColliderBase>(a.colliders.Where(c => c != null));
                        var cb = new HashSet<VRC.Dynamics.VRCPhysBoneColliderBase>(b.colliders.Where(c => c != null));
                        if (same && (ca.IsSubsetOf(cb) || cb.IsSubsetOf(ca))) { count++; where.Add(a.transform); }
                    }
            }
            return count;
        }

        /// <summary>
        /// Renderers no one can ever see: off in the scene (the renderer, or itself/an ancestor inactive) and no animation in
        /// the avatar's controllers turns them on. AAO removes these, which lowers the triangle count without decimating
        /// anything visible, so the triangle comparison leaves them out on both sides.
        /// </summary>
        static List<Renderer> NeverVisible(GameObject avatar, List<Renderer> shipped)
        {
            var activatable = new HashSet<Transform>();
            var enablable = new HashSet<Transform>();
            var descriptor = avatar.GetComponent<VRC.SDK3.Avatars.Components.VRCAvatarDescriptor>();
            foreach (var (_, controller) in AvatarAudit.Layers(descriptor))
                foreach (var clip in controller.animationClips.Distinct())
                    foreach (var binding in AnimationUtility.GetCurveBindings(clip))
                    {
                        if (binding.propertyName != "m_IsActive" && binding.propertyName != "m_Enabled") continue;
                        var target = binding.path.Length == 0 ? avatar.transform : avatar.transform.Find(binding.path);
                        if (target == null || !AnimationUtility.GetEditorCurve(clip, binding).keys.Any(k => k.value > 0.5f)) continue;
                        (binding.propertyName == "m_IsActive" ? activatable : enablable).Add(target);
                    }
            bool CanShow(Renderer r)
            {
                if (!r.enabled && !enablable.Contains(r.transform)) return false;
                for (var x = r.transform; x != null; x = x.parent)
                    if (!x.gameObject.activeSelf && !activatable.Contains(x)) return false;
                return true;
            }
            return shipped.Where(r => !CanShow(r)).ToList();
        }

        /// <summary>
        /// Field by field through SerializedObject (JSON serialization writes scene references as instanceID 0, which would make
        /// every PhysBone on one object look alike).
        /// </summary>
        public static bool SameExceptColliders(VRCPhysBone a, VRCPhysBone b)
        {
            var sa = new SerializedObject(a);
            var sb = new SerializedObject(b);
            var it = sa.GetIterator();
            if (!it.NextVisible(true)) return true;
            do
            {
                if (it.propertyPath == "m_Script" || it.propertyPath == "colliders") continue;
                var other = sb.FindProperty(it.propertyPath);
                if (other == null || !SerializedProperty.DataEquals(it, other)) return false;
            } while (it.NextVisible(false));
            return true;
        }

        /// <summary>a can be removed when every behavior field matches b and a contributes no collider b lacks.</summary>
        public static bool Redundant(VRCPhysBone a, VRCPhysBone b) => SameExceptColliders(a, b)
            && new HashSet<VRC.Dynamics.VRCPhysBoneColliderBase>(a.colliders.Where(c => c != null))
                .IsSubsetOf(new HashSet<VRC.Dynamics.VRCPhysBoneColliderBase>(b.colliders.Where(c => c != null)));

        static int Triangles(Renderer r)
        {
            // TryGetComponent：编辑器里 GetComponent 缺组件时返回假空对象，`is MeshFilter` 会匹配上再抛 MissingComponentException。
            var mesh = r is SkinnedMeshRenderer s ? s.sharedMesh : r is MeshRenderer && r.TryGetComponent<MeshFilter>(out var f) ? f.sharedMesh : null;
            if (mesh == null) return 0;
            var total = 0;
            for (var i = 0; i < mesh.subMeshCount; i++) total += (int)(mesh.GetIndexCount(i) / 3);
            return total;
        }

        /// <summary>The source image's larger side, as the importer read it (before any max-size limit).</summary>
        static int SourceSize(TextureImporter importer)
        {
            importer.GetSourceTextureWidthAndHeight(out var w, out var h);
            return Math.Max(w, h);
        }
    }
}
