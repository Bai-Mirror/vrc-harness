// 【项目沉淀】
// 适用素体：无关（Unity 编辑器构建期截获工具）。
// 用途：T-12 —— 借 AAO 公开 API `ComponentInformation<T>.ApplySpecialMapping` 拿「构建前名字 → 构建后名字」
//   的键映射，写 mapping.json（mapped / merged(1:n) / removed_frozen）。
//
// 为什么能拿到最终映射：AAO Optimizing 的 `ObjectMappingContext.OnDeactivate` 会遍历头像上每个组件，
//   对有 `ComponentInformation` 的组件回调 `ApplySpecialMappingInternal`，此时 `MappingSource` 已经
//   包含 MergeSkinnedMesh / AutoMergeBlendShape / FreezeBlendShape 的全部改名与删除记录。
//   本组件在 pass A 被挂到构建克隆根上、且实现 `IEditorOnly`：AAO 跑在 -1025，SDK 在 -1024 才删它。
//
// 为什么只 MarkEntrypoint、**不** ModifyProperties（规格硬要求）：
//   `ModifyProperties` 会被 AAO 当成「组件在运行时改这些形态键」，从而让
//   `InternalAutoFreezeNonAnimatedBlendShapesProcessor.IsUnchangedBlendShape` 的 `ApplyState=Always`
//   分支拿不到常量 → 不冻结。那会把要观测的构建结果改掉（观测者效应）。
//   冻结/合并本身由 AAO 自己的处理器 `RecordRemoveProperty` / `RecordMoveProperty` 播进映射，
//   所以 `TryMapProperty` 仍能区分 mapped / removed。

using System;
using System.Collections.Generic;
using System.Reflection;
using Anatawa12.AvatarOptimizer.API;
using UnityEngine;

namespace AvatarAudit
{
    /// <summary>
    /// `AuditMappingProbe` 的 AAO 组件信息。只读映射、只写盘，不改任何组件属性。
    /// </summary>
    [ComponentInformation(typeof(AuditMappingProbe))]
    internal sealed class AuditMappingProbeInfo : ComponentInformation<AuditMappingProbe>
    {
        public AuditMappingProbeInfo()
        {
        }

        /// <summary>
        /// 防御 AAO ComponentInfoRegistry 的域重载问题：它是 <c>[InitializeOnLoadMethod]</c> 扫全 AppDomain
        /// 建类型表；若部署新类型后没发生域重载（Enter Play Mode Options 关了域重载），
        /// <c>ApplySpecialMapping</c> 永不回调、mapping.json 静默缺席。这里在 pass A 里反射查一次表；
        /// 缺了就现场调它的私有 <c>LoadType</c> 注册本类型，结果记进 build_status.notes。
        /// 只读 / 只补本类型，不改 AAO 其它行为。
        /// </summary>
        public static void EnsureAaoRegistry()
        {
            try
            {
                Type regType = null;
                foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
                {
                    try { regType = asm.GetType("Anatawa12.AvatarOptimizer.APIInternal.ComponentInfoRegistry", false); }
                    catch { regType = null; }
                    if (regType != null) break;
                }
                if (regType == null)
                {
                    AuditBuildCapture.Note("AAO registry 自检：找不到 ComponentInfoRegistry（AAO 未装？mapping 将缺席）");
                    return;
                }

                var dictField = regType.GetField("InformationByType", BindingFlags.NonPublic | BindingFlags.Static);
                var dict = dictField == null ? null : dictField.GetValue(null) as System.Collections.IDictionary;
                if (dict == null)
                {
                    AuditBuildCapture.Note("AAO registry 自检：InformationByType 不可读（AAO 版本变了？）");
                    return;
                }
                if (dict.Contains(typeof(AuditMappingProbe)))
                {
                    AuditBuildCapture.Note("AAO registry 自检：AuditMappingProbeInfo 已注册");
                    return;
                }

                Attribute attr = null;
                foreach (var a in typeof(AuditMappingProbeInfo).GetCustomAttributes(false))
                {
                    if (a.GetType().Name == "ComponentInformationAttribute") { attr = a as Attribute; break; }
                }
                if (attr == null)
                {
                    AuditBuildCapture.Note("AAO registry 自检：本类型缺 ComponentInformation 特性，无法自注册（需要域重载）");
                    return;
                }

                var loadType = regType.GetMethod("LoadType", BindingFlags.NonPublic | BindingFlags.Static);
                if (loadType == null)
                {
                    AuditBuildCapture.Note("AAO registry 自检：找不到 LoadType，未自注册（mapping 需要一次域重载）");
                    return;
                }

                loadType.Invoke(null, new object[] { typeof(AuditMappingProbeInfo), attr });
                AuditBuildCapture.Note(dict.Contains(typeof(AuditMappingProbe))
                    ? "AAO registry 自检：本类型原先未注册，已现场补注册（省掉一次域重载）"
                    : "AAO registry 自检：补注册后仍不在表里（AAO 版本不兼容？mapping 将缺席）");
            }
            catch (Exception e)
            {
                AuditBuildCapture.Note("AAO registry 自检失败（不影响其它产物）：" + e.Message);
            }
        }

        protected override void CollectDependency(AuditMappingProbe component, ComponentDependencyCollector collector)
        {
            // 本组件是「有外部副作用」的审查探针：active+enabled 时 AAO 不要把它 GC 掉，
            // 但 -1024 时 VRCSDK 仍会按 IEditorOnly 删除它。
            collector.MarkEntrypoint();
        }

        protected override void ApplySpecialMapping(AuditMappingProbe component, MappingSource mappingSource)
        {
            if (!AuditBuildCapture.GateOpen) return;
            if (component == null) return;

            var meshes = new List<object>();
            var results = new List<KeyResult>();

            var renderers = component.renderers;
            var counts = component.rendererKeyCounts;
            var paths = component.sourcePaths;
            var keys = component.keys;

            int offset = 0;
            for (int i = 0; renderers != null && i < renderers.Length; i++)
            {
                var smr = renderers[i];
                int count = counts != null && i < counts.Length ? counts[i] : 0;
                var sourcePath = paths != null && i < paths.Length ? paths[i] : null;
                var sourceKeys = new List<string>();
                for (int k = 0; k < count; k++)
                {
                    if (keys != null && offset < keys.Length && !string.IsNullOrEmpty(keys[offset])) sourceKeys.Add(keys[offset]);
                    offset++;
                }

                var meshNode = new JsonObject();
                meshNode.Set("mesh", sourcePath);
                meshNode.Set("renderer_path", sourcePath);
                if (smr != null) meshNode.Set("renderer_name", SafeName(smr));

                MappedComponentInfo<SkinnedMeshRenderer> info;
                try { info = mappingSource.GetMappedComponent(smr); }
                catch (Exception e) { info = null; meshNode.Set("mapped_component_error", e.Message); }

                var mappedPath = null as string;
                if (info != null && info.MappedComponent != null)
                {
                    mappedPath = SafeScenePath(info.MappedComponent);
                    meshNode.Set("mapped_renderer", mappedPath);
                    meshNode.Set("mapped_renderer_name", SafeName(info.MappedComponent));
                }
                meshNode.Set("source_keys", sourceKeys.Count);

                var keyMap = new JsonObject();
                foreach (var key in sourceKeys)
                {
                    var entry = new JsonObject();
                    entry.Set("source_key", key);
                    if (info == null)
                    {
                        entry.Set("status", "unavailable");
                    }
                    else
                    {
                        MappedPropertyInfo found;
                        bool ok;
                        try { ok = info.TryMapProperty("blendShape." + key, out found); }
                        catch (Exception e) { ok = false; found = default(MappedPropertyInfo); entry.Set("error", e.Message); }

                        if (!ok)
                        {
                            entry.Set("status", "removed_frozen");
                            entry.Set("reason", "AAO 冻结/移除（TryMapProperty=false）");
                        }
                        else
                        {
                            entry.Set("status", "mapped");
                            entry.Set("target", found.Property);
                            entry.Set("target_full", found.Property);
                            var targetMesh = found.Component == null ? mappedPath : SafeScenePath(found.Component);
                            entry.Set("target_mesh", targetMesh);
                            entry.Set("target_object_name", found.Component == null ? null : SafeName(found.Component));
                        }
                    }
                    keyMap.Set(key, entry);
                    results.Add(new KeyResult
                    {
                        Node = entry,
                        SourceMesh = sourcePath,
                        SourceKey = key,
                    });
                }
                meshNode.Set("keys", keyMap);
                meshes.Add(meshNode);
            }

            MarkMerged(results);

            var doc = new JsonObject();
            doc.Set("tool", AuditBuildCapture.ToolName);
            doc.Set("tool_version", AuditBuildCapture.ToolVersion(typeof(AuditBuildPlugin)));
            doc.Set("phase", "mapping");
            doc.Set("available", true);
            doc.Set("aao_mapping", true);
            doc.Set("avatar_root", AuditBuildCapture.AvatarRoot == null ? null : AuditBuildCapture.AvatarRoot.name);
            doc.Set("meshes", meshes);
            doc.Set("mapped_keys", CountStatus(results, "mapped") + CountStatus(results, "merged"));
            doc.Set("removed_keys", CountStatus(results, "removed_frozen"));
            AuditBuildCapture.Write("mapping.json", doc);
            AuditBuildCapture.MappingWritten = true;
            AuditBuildCapture.Note("mapping.json: " + meshes.Count + " 个 SMR / " + results.Count + " 个源键");
        }

        /// <summary>1:n 合并：多个源键落到同一个 (目标 SMR, 目标属性) 就标 merged。</summary>
        private static void MarkMerged(List<KeyResult> results)
        {
            var groups = new Dictionary<string, List<KeyResult>>(StringComparer.Ordinal);
            foreach (var r in results)
            {
                var status = r.Node.Get("status") as string;
                if (status != "mapped") continue;
                var targetMesh = r.Node.Get("target_mesh") as string ?? "";
                var target = r.Node.Get("target") as string;
                if (string.IsNullOrEmpty(target)) continue;
                var key = targetMesh + "\u0001" + target;
                List<KeyResult> list;
                if (!groups.TryGetValue(key, out list)) { list = new List<KeyResult>(); groups[key] = list; }
                list.Add(r);
            }

            foreach (var kv in groups)
            {
                if (kv.Value.Count <= 1) continue;
                var from = new List<object>();
                foreach (var r in kv.Value)
                    from.Add((r.SourceMesh ?? "?") + "#" + r.SourceKey);
                foreach (var r in kv.Value)
                {
                    r.Node.Set("status", "merged");
                    r.Node.Set("merged_from", from);
                }
            }
        }

        private static int CountStatus(List<KeyResult> results, string status)
        {
            int n = 0;
            foreach (var r in results) if (string.Equals(r.Node.Get("status") as string, status, StringComparison.Ordinal)) n++;
            return n;
        }

        private static string SafeName(UnityEngine.Object o)
        {
            try { return o == null ? null : o.name; }
            catch { return null; }
        }

        private static string SafeScenePath(UnityEngine.Object o)
        {
            try
            {
                if (o == null) return null;
                var c = o as Component;
                if (c != null) return AuditUtil.ScenePath(c.transform);
                var go = o as GameObject;
                if (go != null) return AuditUtil.ScenePath(go.transform);
                return o.name;
            }
            catch { return null; }
        }

        private sealed class KeyResult
        {
            public JsonObject Node;
            public string SourceMesh;
            public string SourceKey;
        }
    }
}
