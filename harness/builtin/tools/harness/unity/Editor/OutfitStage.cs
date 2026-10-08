// 【项目沉淀】通用工具（Harness outfit 阶段的 Unity 步骤）
// 适用素体：无关（素体与服装预制体都由方案指定）
// 工具链　：Unity 2022.3 批处理；VRChat SDK3 Avatars；Modular Avatar 1.18
// 可复用性：★★★ 换个单子直接能用
// 用途　　：按方案把每套服装挂到素体下的 _Outfit 组（组内命名 Outfit_<id>，默认那套开、其余关），隐藏素体自带的衣服，
//           存成素体预制体的变体 Assets/_Harness/Outfit/Avatar.prefab；装配记录写 Assets/_Harness/Outfit/outfit.json。
//           SOP 50 铁律：先探测预制体自带什么（MergeArmature / BoneProxy / 两者 / 都没有），只给「都没有」的补 MA Setup Outfit。
//           装完另起一段只读测量（重新加载存好的变体），写 clothing.install 观测。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
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
    /// <summary>
    /// Stage-level timing for the outfit Unity step. The stage always prints one summary line per
    /// phase, so a slow run can be located from the log alone. Per-call counters exist only to find
    /// a hotspot and cost a dictionary bump each; they are printed under the same single line.
    /// </summary>
    public static class OutfitPerf
    {
        static readonly System.Diagnostics.Stopwatch Clock = System.Diagnostics.Stopwatch.StartNew();
        static readonly object Gate = new object();
        static readonly Dictionary<string, double> Ms = new Dictionary<string, double>();
        static readonly Dictionary<string, long> Counts = new Dictionary<string, long>();
        public static double Now => Clock.Elapsed.TotalMilliseconds;
        public static void Bump(string key, long count = 1) { lock (Gate) Counts[key] = (Counts.TryGetValue(key, out var value) ? value : 0) + count; }
        public static void Add(string key, double milliseconds)
        {
            lock (Gate)
            {
                Counts[key] = (Counts.TryGetValue(key, out var count) ? count : 0) + 1;
                Ms[key] = (Ms.TryGetValue(key, out var value) ? value : 0) + milliseconds;
            }
        }
        public static T Time<T>(string key, Func<T> body)
        {
            var start = Now;
            try { return body(); } finally { Add(key, Now - start); }
        }
        public static long Count(string key) { lock (Gate) return Counts.TryGetValue(key, out var value) ? value : 0; }
        /// <summary>Starts a fresh counter generation, for a caller that measures one traversal on its own.</summary>
        public static void Reset() { lock (Gate) { Ms.Clear(); Counts.Clear(); } }
        public static void Time(string key, Action body)
        {
            var start = Now;
            try { body(); } finally { Add(key, Now - start); }
        }
        /// <summary>
        /// A phase boundary. The stage prints one summary line at the end, so a run that never reaches it
        /// still names the phase it was in — which is what a hang report needs to be actionable.
        /// </summary>
        public static void Mark(string label) => Avh.Log($"PERF-MARK {Now:F0}ms {label}");
        public static void Report(string scope)
        {
            lock (Gate)
            {
                var rows = Ms.OrderByDescending(row => row.Value)
                    .Select(row => $"{row.Key}={row.Value:F0}ms/{Counts[row.Key]}").ToList();
                Avh.Log($"PERF {scope} at={Now:F0}ms | {string.Join(", ", rows)}");
                Ms.Clear(); Counts.Clear();
            }
        }
    }

    /// <summary>Only material slots may differ in a thin variant; every other serialized leaf is compared.</summary>
    public static class VariantResolver
    {
        public class Inspection { public string Signature; public List<string> Unsupported; }
        static string StructuralPath(Transform t, Transform root) => t == root ? "" : StructuralPath(t.parent, root)
            + "/" + Avh.Json(t.name) + ":" + t.GetSiblingIndex();

        // A prefab instance has the same child ordering as its source. Unity paths cannot distinguish
        // same-named siblings, so source-to-instance correspondence must retain that ordering.
        static Transform StructuralTarget(Transform source, Transform sourceRoot, Transform instanceRoot)
        {
            var indices = new Stack<int>();
            for (var current = source; current != sourceRoot; current = current.parent)
            {
                if (current == null || !current.IsChildOf(sourceRoot)) return null;
                indices.Push(current.GetSiblingIndex());
            }
            var target = instanceRoot;
            while (indices.Count > 0)
            {
                var index = indices.Pop();
                if (index >= target.childCount) return null;
                target = target.GetChild(index);
            }
            return target;
        }

        static List<object> SiblingIndices(Transform target, Transform root)
        {
            var indices = new Stack<int>();
            for (var current = target; current != root; current = current.parent)
                indices.Push(current.GetSiblingIndex());
            return indices.Select(index => (object)index).ToList();
        }

        // Sibling indices disambiguate duplicate names only while both the renderer type and public
        // path still agree. If the hierarchy changes, preserve each caller's original name lookup.
        public static Transform MaterialTarget(Transform root, Dictionary<string, object> row, bool useFind = false)
        {
            if (row.TryGetValue("renderer_sibling_indices", out var value) && value is List<object> indices)
            {
                var candidate = root;
                foreach (var entry in indices)
                {
                    var index = Convert.ToInt32(entry);
                    if (index < 0 || index >= candidate.childCount) { candidate = null; break; }
                    candidate = candidate.GetChild(index);
                }
                if (candidate != null && candidate.GetComponents<Renderer>().Any(renderer => renderer.GetType().FullName == row.Str("type"))
                    && Probe.HierarchyPath(root, candidate) == row.Str("renderer")) return candidate;
            }
            return useFind ? root.Find(row.Str("renderer")) : AvatarAudit.Locate(root, row.Str("renderer"));
        }
        public static string Structure(GameObject prefab) => Inspect(prefab).Signature;
        public static Inspection Inspect(GameObject prefab)
        {
            var leaves = new List<string>();
            var unsupported = new List<string>();
            foreach (var t in prefab.GetComponentsInChildren<Transform>(true))
            {
                // Structural identity includes occurrence, even for duplicate unanimated collider names.
                // Animation bindings still require unique Unity paths when material/visual curves are compiled.
                var path = StructuralPath(t, prefab.transform);
                leaves.Add(path + "|name=" + (t == prefab.transform ? "root" : t.name) + "|active=" + t.gameObject.activeSelf + "|tag=" + t.tag + "|layer=" + t.gameObject.layer);
                var components = t.GetComponents<Component>();
                for (var componentIndex = 0; componentIndex < components.Length; componentIndex++)
                {
                    var component = components[componentIndex];
                    if (component == null) throw new Exception("变体含缺失脚本");
                    var iterator = new SerializedObject(component).GetIterator();
                    var enterChildren = true;
                    while (iterator.Next(enterChildren))
                    {
                        enterChildren = iterator.propertyType != SerializedPropertyType.ObjectReference;
                        var field = iterator.propertyPath;
                        if (component is Renderer && iterator.propertyType == SerializedPropertyType.ObjectReference && field.StartsWith("m_Materials.Array.data[") || field.StartsWith("m_CorrespondingSourceObject")
                            || field.StartsWith("m_PrefabInstance") || field.StartsWith("m_PrefabAsset")) continue;
                        string value;
                        switch (iterator.propertyType)
                        {
                            case SerializedPropertyType.Generic: continue;
                            case SerializedPropertyType.ObjectReference:
                                var obj = iterator.objectReferenceValue;
                                var transform = obj is Component c ? c.transform : (obj as GameObject)?.transform;
                                if (transform != null && transform.IsChildOf(prefab.transform))
                                    value = "local:" + StructuralPath(transform, prefab.transform) + ":" + obj.GetType().FullName
                                        + (obj is Component local ? ":" + Array.IndexOf(transform.GetComponents<Component>(), local) : "");
                                else
                                {
                                    if (obj == null) value = "null";
                                    else if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(obj, out string guid, out long fileId)) value = guid + ":" + fileId;
                                    else { unsupported.Add(path + ":" + field + ":unresolved-reference"); value = "unknown"; }
                                }
                                break;
                            case SerializedPropertyType.Integer: value = iterator.longValue.ToString(CultureInfo.InvariantCulture); break;
                            case SerializedPropertyType.ArraySize: value = iterator.intValue.ToString(CultureInfo.InvariantCulture); break;
                            case SerializedPropertyType.LayerMask: value = iterator.intValue.ToString(CultureInfo.InvariantCulture); break;
                            case SerializedPropertyType.Boolean: value = iterator.boolValue.ToString(); break;
                            case SerializedPropertyType.Float: value = iterator.doubleValue.ToString("R", CultureInfo.InvariantCulture); break;
                            case SerializedPropertyType.String: value = iterator.stringValue; break;
                            case SerializedPropertyType.Enum: value = iterator.intValue.ToString(CultureInfo.InvariantCulture); break;
                            case SerializedPropertyType.Vector2: value = iterator.vector2Value.ToString("R"); break;
                            case SerializedPropertyType.Vector3: value = iterator.vector3Value.ToString("R"); break;
                            case SerializedPropertyType.Vector4: value = iterator.vector4Value.ToString("R"); break;
                            case SerializedPropertyType.Quaternion: value = iterator.quaternionValue.ToString("R"); break;
                            case SerializedPropertyType.Color: value = iterator.colorValue.ToString("R"); break;
                            case SerializedPropertyType.Bounds: value = iterator.boundsValue.ToString("R"); break;
                            case SerializedPropertyType.Rect: value = iterator.rectValue.ToString("R"); break;
                            case SerializedPropertyType.Vector2Int: value = iterator.vector2IntValue.ToString(); break;
                            case SerializedPropertyType.Vector3Int: value = iterator.vector3IntValue.ToString(); break;
                            case SerializedPropertyType.BoundsInt: value = iterator.boundsIntValue.ToString(); break;
                            case SerializedPropertyType.RectInt: value = iterator.rectIntValue.ToString(); break;
                            case SerializedPropertyType.AnimationCurve:
                                var animation = iterator.animationCurveValue;
                                value = Avh.Json(new object[] { animation.preWrapMode.ToString(), animation.postWrapMode.ToString(),
                                    animation.keys.Select(k => (object)new object[] { k.time.ToString("R", CultureInfo.InvariantCulture), k.value.ToString("R", CultureInfo.InvariantCulture),
                                        k.inTangent.ToString("R", CultureInfo.InvariantCulture), k.outTangent.ToString("R", CultureInfo.InvariantCulture), k.inWeight.ToString("R", CultureInfo.InvariantCulture),
                                        k.outWeight.ToString("R", CultureInfo.InvariantCulture), k.weightedMode.ToString() }).ToList() });
                                break;
                            default:
                                // Unknown serialized leaves cannot certify equivalence. A source-specific token materializes safely.
                                unsupported.Add(path + ":" + field + ":" + iterator.propertyType); value = "unknown";
                                break;
                        }
                        leaves.Add(Avh.Json(new object[] { path, componentIndex, component.GetType().FullName, field, iterator.propertyType.ToString(), value }));
                    }
                }
            }
            // A null signature cannot prove equivalence, even when the same unsupported source is referenced twice.
            return new Inspection { Signature = unsupported.Count == 0 ? string.Join("\n", leaves) : null, Unsupported = unsupported };
        }
        public static Dictionary<string, object> Identity(UnityEngine.Object asset)
        {
            if (asset == null) return new Dictionary<string, object> { ["null"] = true };
            if (!AssetDatabase.TryGetGUIDAndLocalFileIdentifier(asset, out string guid, out long fileId)) throw new Exception("资产身份不可解析");
            return new Dictionary<string, object> { ["path"] = AssetDatabase.GetAssetPath(asset), ["guid"] = guid, ["file_id"] = fileId.ToString(CultureInfo.InvariantCulture), ["null"] = false };
        }
        public static Material Material(object reference)
        {
            if (reference is string legacyPath) return AssetDatabase.LoadAssetAtPath<Material>(legacyPath);
            var identity = reference as Dictionary<string, object> ?? throw new Exception("材质身份记录无效");
            if (AvatarConfig.On(identity, "null")) return null;
            var path = AssetDatabase.GUIDToAssetPath(identity.Str("guid"));
            if (path != identity.Str("path")) throw new Exception("材质 GUID 与资产路径不符");
            var matches = AssetDatabase.LoadAllAssetsAtPath(path).OfType<Material>().Where(m =>
                AssetDatabase.TryGetGUIDAndLocalFileIdentifier(m, out string guid, out long fileId) && guid == identity.Str("guid") && fileId.ToString(CultureInfo.InvariantCulture) == identity.Str("file_id")).ToList();
            if (matches.Count != 1) throw new Exception("材质子资产身份缺失或不唯一");
            return matches[0];
        }
        public static List<object> Materials(GameObject source, GameObject instance, Transform avatar)
        {
            var rows = new List<object>();
            foreach (var renderer in source.GetComponentsInChildren<Renderer>(true))
            {
                if (renderer.GetComponents<Renderer>().Length > 1) throw new Exception("一个对象含多个 Renderer，材质绑定路径不唯一");
                var relative = AnimationUtility.CalculateTransformPath(renderer.transform, source.transform);
                var target = StructuralTarget(renderer.transform, source.transform, instance.transform);
                if (target == null || target.GetComponent(renderer.GetType()) == null) throw new Exception("变体渲染器不能映射：" + relative);
                rows.Add(new Dictionary<string, object> { ["renderer"] = Probe.HierarchyPath(avatar, target),
                    ["renderer_sibling_indices"] = SiblingIndices(target, avatar),
                    ["type"] = renderer.GetType().FullName, ["materials"] = renderer.sharedMaterials.Select(m => (object)Identity(m)).ToList() });
            }
            return rows;
        }
        public static Inspection ExpectedInspection(GameObject source)
        {
            var comparison = (GameObject)PrefabUtility.InstantiatePrefab(source);
            try
            {
                EffectiveReferences.TrimMissingTailMaterials(comparison);
                return Inspect(comparison);
            }
            finally { UnityEngine.Object.DestroyImmediate(comparison); }
        }
        public static List<object> ExpectedMaterials(GameObject source, GameObject instance, Transform avatar)
        {
            var comparison = (GameObject)PrefabUtility.InstantiatePrefab(source);
            try
            {
                EffectiveReferences.TrimMissingTailMaterials(comparison);
                return Materials(comparison, instance, avatar);
            }
            finally { UnityEngine.Object.DestroyImmediate(comparison); }
        }
        public static void ApplyMaterials(GameObject avatar, List<object> materials)
        {
            foreach (Dictionary<string, object> row in materials)
            {
                var t = MaterialTarget(avatar.transform, row) ?? throw new Exception("预设渲染器不存在");
                var renderer = t.GetComponents<Renderer>().Single(r => r.GetType().FullName == row.Str("type"));
                renderer.sharedMaterials = row.List("materials").Select(Material).ToArray();
            }
        }

    }
    /// <summary>Inspect effective serialized instances, never a raw transitive prefab reference graph.</summary>
    public static class EffectiveReferences
    {
        /// <summary>Reminders produced by the same traversal as the blocking dependency count.</summary>
        public static List<object> LastAnimationReminders { get; private set; } = new List<object>();

        static readonly Dictionary<string, string> sourceText = new Dictionary<string, string>();
        static readonly Dictionary<string, Dictionary<string, object>> materialOrigins = new Dictionary<string, Dictionary<string, object>>();

        /// <summary>
        /// Everything one source file yields once it has been read: its whole-text document index and the
        /// parsed bodies already asked for. A traversal of a real avatar resolves the same file thousands of
        /// times, and rescanning the vendor YAML for each of those is what made Observe spin for half an hour.
        /// </summary>
        sealed class Source
        {
            public Dictionary<long, string> Documents;
            public readonly HashSet<long> Stripped = new HashSet<long>();
            public readonly Dictionary<long, YamlNode> Roots = new Dictionary<long, YamlNode>();
        }

        /// <summary>Reference identity, so equal-but-distinct text never shares a cache entry.</summary>
        sealed class SourceIdentity : IEqualityComparer<string>
        {
            public bool Equals(string left, string right) => ReferenceEquals(left, right);
            public int GetHashCode(string value) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(value);
        }

        static readonly Dictionary<string, Source> sources = new Dictionary<string, Source>(new SourceIdentity());
        static readonly Dictionary<string, string> instanceOverrides = new Dictionary<string, string>();
        static readonly Dictionary<int, Scope> scopes = new Dictionary<int, Scope>();

        /// <summary>Per-instance facts a traversal would otherwise recompute for every single property.</summary>
        sealed class Scope
        {
            public List<UnityEngine.Object> Lineage;
            public List<string> Paths;
            public List<(string guid, long id)> Identities;
        }

        /// <summary>One publication of caches; every entry point starts a fresh generation.</summary>
        static void Reset()
        {
            sourceText.Clear();
            sources.Clear();
            instanceOverrides.Clear();
            scopes.Clear();
        }

        static Source SourceOf(string text)
        {
            if (text == null) return null;
            if (sources.TryGetValue(text, out var cached)) return cached;
            var source = new Source();
            sources[text] = source;
            return source;
        }

        sealed class Reference
        {
            public string Guid;
            public long FileId;
            public string Source;
            public bool Uncertain;
            public bool Nonzero => FileId != 0 || (!string.IsNullOrEmpty(Guid) && Guid.Any(c => c != '0'));
        }

        static Reference Parse(string value, string source)
        {
            var file = Regex.Match(value, @"fileID:\s*(-?\d+)");
            var guid = Regex.Match(value, @"guid:\s*([0-9a-f]{32})");
            return file.Success ? new Reference { FileId = long.Parse(file.Groups[1].Value, CultureInfo.InvariantCulture),
                Guid = guid.Success ? guid.Groups[1].Value : null, Source = source } : null;
        }

        static IEnumerable<UnityEngine.Object> Sources(UnityEngine.Object value)
        {
            var seen = new HashSet<int>();
            while (value != null && seen.Add(value.GetInstanceID()))
            {
                yield return value;
                value = PrefabUtility.GetCorrespondingObjectFromSource(value);
            }
        }

        static string Text(string path)
        {
            if (sourceText.TryGetValue(path, out var cached)) return cached;
            // Package paths may be virtual. Unity's package resolver supplies their actual directories.
            var absolute = Avh.Abs(path);
            if (!File.Exists(absolute) && path.StartsWith("Packages/"))
            {
                var package = UnityEditor.PackageManager.PackageInfo.FindForAssetPath(path);
                if (package != null) absolute = Path.Combine(package.resolvedPath, path.Substring(package.assetPath.Length + 1));
            }
            if (!File.Exists(absolute)) { sourceText[path] = null; return null; }
            using (var reader = new StreamReader(absolute))
            {
                var first = reader.ReadLine();
                return sourceText[path] = first != null && first.StartsWith("%YAML") ? first + "\n" + reader.ReadToEnd() : null;
            }
        }

        /// <summary>
        /// The body of one document, from a whole-file index built once instead of one regex scan per call.
        /// The index keeps the first occurrence of an id and the exact decimal form Unity writes, so a lookup
        /// answers exactly what scanning for that id answered before.
        /// </summary>
        static string Document(string text, long id)
        {
            var start = OutfitPerf.Now;
            try
            {
                var source = SourceOf(text);
                if (source == null) return "";
                if (source.Documents == null)
                {
                    var index = new Dictionary<long, string>();
                    foreach (Match match in Regex.Matches(text, @"(?m)^--- !u!\d+ &(-?\d+)( stripped)?\r?\n(?<body>[\s\S]*?)(?=\r?\n--- !u!|\z)"))
                    {
                        var raw = match.Groups[1].Value;
                        var key = long.Parse(raw, CultureInfo.InvariantCulture);
                        // A leading zero or a plus sign is not an identity Unity writes; treating it as one
                        // would answer a lookup the previous scan answered with "no such document".
                        if (key.ToString(CultureInfo.InvariantCulture) != raw || index.ContainsKey(key)) continue;
                        index[key] = match.Groups["body"].Value;
                        if (match.Groups[2].Success) source.Stripped.Add(key);
                    }
                    source.Documents = index;
                    OutfitPerf.Bump("Document.indexBuilds");
                    OutfitPerf.Bump("Document.indexed", index.Count);
                }
                OutfitPerf.Bump("Document.lookups");
                return source.Documents.TryGetValue(id, out var body) ? body : "";
            }
            finally { OutfitPerf.Add("Document", OutfitPerf.Now - start); }
        }

        static bool Stripped(string text, long id)
        {
            var source = SourceOf(text);
            if (source == null) return false;
            Document(text, id);
            return source.Stripped.Contains(id);
        }

        static string InstanceOverrides(UnityEngine.Object value, string path, string text)
        {
            // A non-component never has instance overrides, and the answer for a component and one source
            // path does not depend on which property is being resolved.
            if (!(value is Component)) return "";
            var key = value.GetInstanceID().ToString(CultureInfo.InvariantCulture) + "|" + path;
            if (instanceOverrides.TryGetValue(key, out var cached)) return cached;
            var computed = OutfitPerf.Time("InstanceOverrides", () => InstanceOverridesBody(value, path, text));
            instanceOverrides[key] = computed;
            return computed;
        }

        static string InstanceOverridesBody(UnityEngine.Object value, string path, string text)
        {
            if (!(value is Component component)) return "";
            if (PrefabUtility.GetCorrespondingObjectFromSourceAtPath(component, path) == null
                && AssetDatabase.GetAssetPath(component) != path) return "";
            for (var transform = component.transform; transform != null; transform = transform.parent)
            {
                // Nested components can be virtual in an outer asset. Its nearest serialized Transform
                // identifies the exact PrefabInstance, even when another instance shares the same source GUID.
                var scoped = PrefabUtility.GetCorrespondingObjectFromSourceAtPath(transform, path);
                if (scoped == null && AssetDatabase.GetAssetPath(transform) == path) scoped = transform;
                if (scoped == null || !AssetDatabase.TryGetGUIDAndLocalFileIdentifier(scoped, out _, out long id)) continue;
                var instance = Regex.Match(Document(text, id), @"m_PrefabInstance:\s*\{fileID:\s*(-?\d+)");
                if (instance.Success && instance.Groups[1].Value != "0")
                    return Document(text, long.Parse(instance.Groups[1].Value, CultureInfo.InvariantCulture));
                var globalStart = OutfitPerf.Now;
                var global = GlobalObjectId.GetGlobalObjectIdSlow(scoped);
                OutfitPerf.Add("GlobalObjectIdSlow", OutfitPerf.Now - globalStart);
                var globalInstance = Document(text, unchecked((long)global.targetPrefabId));
                if (global.targetPrefabId != 0 && globalInstance.StartsWith("PrefabInstance:")) return globalInstance;
            }
            // A root variant can contain only its PrefabInstance document, with no stripped Transform.
            // With exactly one instance there is no sibling context to confuse; targets still match exact identities.
            var single = Regex.Matches(text, @"(?m)^--- !u!1001 &(-?\d+)(?: stripped)?\r?\n");
            if (single.Count == 1) return Document(text, long.Parse(single[0].Groups[1].Value, CultureInfo.InvariantCulture));
            return "";
        }

        sealed class YamlNode
        {
            public string Value;
            public bool Valid = true;
            public readonly Dictionary<string, YamlNode> Fields = new Dictionary<string, YamlNode>();
            public readonly List<YamlNode> Items = new List<YamlNode>();
        }

        static YamlNode ReadYaml(string[] lines, ref int position, int indent)
        {
            var node = new YamlNode();
            bool Sequence(string line) => line.TrimStart().StartsWith("- ") || line.Trim() == "-";
            int Indent(string line) => line.Length - line.TrimStart().Length;
            if (Sequence(lines[position]))
            {
                while (position < lines.Length && Indent(lines[position]) == indent && Sequence(lines[position]))
                {
                    var item = lines[position].TrimStart().Substring(1).TrimStart();
                    if (item.StartsWith("{") || item.StartsWith("[") || !item.Contains(":"))
                    {
                        position++;
                        if (item.Length == 0 && position < lines.Length && Indent(lines[position]) > indent)
                            node.Items.Add(ReadYaml(lines, ref position, Indent(lines[position])));
                        else node.Items.Add(new YamlNode { Value = item });
                    }
                    else
                    {
                        // The first map field is on the dash line; following fields use the same logical indent.
                        lines[position] = new string(' ', indent + 2) + item;
                        node.Items.Add(ReadYaml(lines, ref position, indent + 2));
                    }
                }
            }
            else
            {
                while (position < lines.Length && Indent(lines[position]) == indent && !Sequence(lines[position]))
                {
                    var line = lines[position++].TrimStart();
                    var colon = line.IndexOf(':');
                    if (colon < 0) { node.Valid = false; continue; }
                    var key = line.Substring(0, colon).Trim().Trim('"');
                    var value = line.Substring(colon + 1).Trim();
                    var child = new YamlNode { Value = value };
                    if (value.Length == 0 && position < lines.Length && (Indent(lines[position]) > indent
                        || Indent(lines[position]) == indent && Sequence(lines[position])))
                        child = ReadYaml(lines, ref position, Indent(lines[position]));
                    if (node.Fields.ContainsKey(key)) node.Valid = false;
                    node.Fields[key] = child;
                }
            }
            return node;
        }

        static Reference Direct(string text, long id, string property, string source)
        {
            var start = OutfitPerf.Now;
            try { return DirectBody(text, id, property, source); }
            finally { OutfitPerf.Add("Direct", OutfitPerf.Now - start); }
        }

        static Reference DirectBody(string text, long id, string property, string source)
        {
            var body = Document(text, id);
            var rootField = property.Split('.')[0];
            // Stripped components contain only provenance, so their real definition is read farther down the lineage.
            if (Stripped(text, id)) return null;
            var unknown = new Reference { Source = source, Uncertain = true };
            // Nested inherited components can have no local document at all; their definition is farther down the lineage.
            if (body.Length == 0) return null;
            if (!Regex.IsMatch(body, @"(?m)^  " + Regex.Escape(rootField) + @":")) return unknown;
            // One document is parsed once for the whole traversal; every later property comes off the same tree.
            var parsed = SourceOf(text);
            if (parsed == null || !parsed.Roots.TryGetValue(id, out var document))
            {
                var lines = body.Split('\n').Where(line => !string.IsNullOrWhiteSpace(line)).Select(line => line.TrimEnd('\r')).ToArray();
                var position = 0;
                var yamlStart = OutfitPerf.Now;
                document = ReadYaml(lines, ref position, 0);
                OutfitPerf.Add("ReadYaml", OutfitPerf.Now - yamlStart);
                OutfitPerf.Bump("Direct.roots");
                if (parsed != null) parsed.Roots[id] = document;
            }
            if (!document.Valid || document.Fields.Count != 1) return unknown;
            var node = document.Fields.Values.Single();
            var fields = property.Split('.');
            for (var part = 0; part < fields.Length; part++)
            {
                if (!node.Valid) return unknown;
                if (fields[part] == "Array")
                {
                    if (++part >= fields.Length) return unknown;
                    var index = Regex.Match(fields[part], @"^data\[(\d+)\]$");
                    if (!index.Success || !int.TryParse(index.Groups[1].Value, out var slot) || slot >= node.Items.Count) return unknown;
                    node = node.Items[slot];
                }
                else if (node.Fields.TryGetValue(fields[part], out var child)) node = child;
                else if (fields[part] == "second" && property.StartsWith("m_SavedProperties.m_TexEnvs.Array.data[")
                    && node.Fields.Count == 1)
                    // Unity writes texture key/value pairs as '- _Property: ...', serialized as first/second.
                    node = node.Fields.Values.Single();
                else return unknown;
            }
            return node.Valid && node.Value != null ? Parse(node.Value, source) ?? unknown : unknown;
        }

        static Reference SerializedReference(UnityEngine.Object value, SerializedProperty property)
        {
            var start = OutfitPerf.Now;
            try { return SerializedReferenceBody(value, property); }
            finally { OutfitPerf.Add("SerializedReference", OutfitPerf.Now - start); }
        }

        /// <summary>
        /// The lineage, candidate source paths and identities of one instance. A component exposes dozens of
        /// null references and each of them walked the whole ancestor chain again — with a
        /// GlobalObjectId.GetGlobalObjectIdSlow per ancestor — so a real avatar's Observe never finished.
        /// </summary>
        static Scope ScopeOf(UnityEngine.Object value)
        {
            var key = value.GetInstanceID();
            if (scopes.TryGetValue(key, out var cached)) return cached;
            var scope = new Scope();
            scope.Lineage = Sources(value).ToList();
            // An outer prefab can override a nested component. Read the nearest effective override first.
            var paths = new List<string>();
            if (value is Component component)
            {
                var ancestors = new Stack<Transform>();
                for (var t = component.transform; t != null; t = t.parent)
                    ancestors.Push(t);
                foreach (var t in ancestors)
                {
                    OutfitPerf.Bump("InstanceOverrides.ancestors");
                    var path = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(t.gameObject);
                    if (!string.IsNullOrEmpty(path)) paths.Add(path);
                    // Root variants can hide an intermediate base prefab from a nested component's own lineage.
                    paths.AddRange(Sources(t.gameObject).Select(AssetDatabase.GetAssetPath).Where(source => !string.IsNullOrEmpty(source)));
                }
            }
            paths.AddRange(scope.Lineage.Select(AssetDatabase.GetAssetPath).Where(path => !string.IsNullOrEmpty(path)));
            scope.Paths = paths.Distinct().ToList();
            var scopedSources = value is Component ? scope.Paths.Select(path =>
                PrefabUtility.GetCorrespondingObjectFromSourceAtPath(value, path)).Where(source => source != null) : Enumerable.Empty<UnityEngine.Object>();
            scope.Identities = scope.Lineage.Concat(scopedSources).Select(source =>
            {
                AssetDatabase.TryGetGUIDAndLocalFileIdentifier(source, out string guid, out long id);
                return (guid, id);
            }).Where(identity => !string.IsNullOrEmpty(identity.guid)).ToList();
            scopes[key] = scope;
            return scope;
        }

        static Reference SerializedReferenceBody(UnityEngine.Object value, SerializedProperty property)
        {
            var scope = ScopeOf(value);
            var lineage = scope.Lineage;
            var identities = scope.Identities;
            string inspectedSource = null;
            foreach (var path in scope.Paths)
            {
                var text = Text(path);
                if (text == null) continue;
                inspectedSource = path;
                // Bound each modification to its own target, avoiding a cross-renderer regex match.
                foreach (Match modification in Regex.Matches(InstanceOverrides(value, path, text), @"(?m)^\s*- target: (?<target>\{[^}]*\})\r?\n(?<body>[\s\S]*?)(?=\r?\n\s*- target:|\r?\n\s*m_Removed|\z)"))
                {
                    var target = Parse(modification.Groups["target"].Value, path);
                    if (target == null || !identities.Any(identity => identity.guid == target.Guid && identity.id == target.FileId)) continue;
                    var body = modification.Groups["body"].Value;
                    var name = Regex.Match(body, @"propertyPath:\s*([^\r\n]+)");
                    if (name.Groups[1].Value.Trim() != property.propertyPath) continue;
                    var reference = Regex.Match(body, @"objectReference:\s*(\{[^}]*\})");
                    if (reference.Success) return Parse(reference.Groups[1].Value, path);
                }
                foreach (var source in lineage.Where(source => AssetDatabase.GetAssetPath(source) == path))
                {
                    AssetDatabase.TryGetGUIDAndLocalFileIdentifier(source, out _, out long id);
                    var reference = Direct(text, id, property.propertyPath, path);
                    if (reference != null) return reference;
                }
            }
            // Absence in an outer inherited document is not an explicit null. Only a located pointer can prove null.
            return inspectedSource != null ? new Reference { Source = inspectedSource, Uncertain = true } : null;
        }

        static Reference Missing(UnityEngine.Object value, SerializedProperty property)
        {
            if (property.propertyType != SerializedPropertyType.ObjectReference || property.objectReferenceValue != null) return null;
            // Unity exposes this native GI cache in SerializedObject but never serializes it.
            // https://docs.unity3d.com/2022.3/Documentation/ScriptReference/MeshRenderer-enlightenVertexStream.html
            // A resolved cache is still traversed by Observe; an unresolved nonzero instance ID still blocks.
            if (value is MeshRenderer && property.propertyPath == "m_EnlightenVertexStream"
                && property.objectReferenceInstanceIDValue == 0) return null;
            var start = OutfitPerf.Now;
            try
            {
                var raw = SerializedReference(value, property);
                // Unity can resolve a dangling GUID to instanceID 0; that is why the serialized source identity
                // is retained. Explicit null (fileID 0 with no GUID) is never inferred to be a missing dependency.
                if (raw != null) return raw.Nonzero || raw.Uncertain ? raw : null;
                return property.objectReferenceInstanceIDValue != 0 ? new Reference { FileId = property.objectReferenceInstanceIDValue } : null;
            }
            finally { OutfitPerf.Add("Missing.resolved", OutfitPerf.Now - start); }
        }

        /// <summary>
        /// Whether an array's elements can hold an object reference at all.
        ///
        /// Unity serializes every element of a typed array with the same shape, so the first element
        /// answers for all of them — and on a real avatar the buffers this rejects hold tens of millions
        /// of elements against 66k object references. A leaf-typed element (a byte, a keyframe, a matrix)
        /// cannot carry a reference; a struct is walked, but only its first element's subtree. This can
        /// only ever be less thorough by never finding a reference in a shape it fully walked: an empty
        /// array holds nothing, and a property that is not an array of elements is not one to skip.
        /// </summary>
        static bool ArrayHoldsReferences(SerializedProperty array)
        {
            if (array.propertyType != SerializedPropertyType.Generic || array.arraySize == 0) return false;
            var element = array.GetArrayElementAtIndex(0).Copy();
            switch (element.propertyType)
            {
                case SerializedPropertyType.ObjectReference:
                case SerializedPropertyType.ExposedReference:
                case SerializedPropertyType.ManagedReference:
                    return true;
                case SerializedPropertyType.Generic:
                    var elementDepth = element.depth;
                    var probe = element;
                    while (probe.Next(true) && probe.depth > elementDepth)
                        if (probe.propertyType == SerializedPropertyType.ObjectReference) return true;
                    return false;
                default:
                    return false;
            }
        }

        static int Submeshes(Renderer renderer) => renderer is SkinnedMeshRenderer skin ? skin.sharedMesh?.subMeshCount ?? -1
            : renderer.TryGetComponent<MeshFilter>(out var filter) ? filter.sharedMesh?.subMeshCount ?? -1 : -1;

        public static List<object> TrimMissingTailMaterials(GameObject avatar)
        {
            var callStart = OutfitPerf.Now;
            try { return TrimMissingTailMaterialsBody(avatar); }
            finally { OutfitPerf.Add("TrimMissingTailMaterials", OutfitPerf.Now - callStart); }
        }

        static List<object> TrimMissingTailMaterialsBody(GameObject avatar)
        {
            Reset();
            var receipts = new List<object>();
            var renderers = avatar.GetComponentsInChildren<Renderer>(true);
            OutfitPerf.Bump("Trim.renderers", renderers.Length);
            foreach (var renderer in renderers)
            {
                using (var serialized = new SerializedObject(renderer))
                {
                    var materials = serialized.FindProperty("m_Materials");
                    var original = materials.arraySize;
                    var submeshes = Submeshes(renderer);
                    var removed = new List<(int slot, Reference reference)>();
                    while (submeshes >= 0 && materials.arraySize > submeshes)
                    {
                        var slot = materials.arraySize - 1;
                        OutfitPerf.Bump("Trim.slots.inspected");
                        var reference = Missing(renderer, materials.GetArrayElementAtIndex(slot));
                        if (reference == null || reference.Uncertain) break;
                        removed.Add((slot, reference));
                        materials.arraySize = slot;
                    }
                    for (var slot = 0; slot < materials.arraySize; slot++)
                    {
                        OutfitPerf.Bump("Trim.slots.inspected");
                        var reference = Missing(renderer, materials.GetArrayElementAtIndex(slot));
                        if (reference != null)
                            throw new Exception($"厂商缺件材质无法安全移除，需决定替换成哪个已有材质或接受缺失：{reference.Source} / {Probe.HierarchyPath(avatar.transform, renderer.transform)} / {renderer.GetType().Name} / 槽位 {slot} / 子网格 {(submeshes < 0 ? "无法确认" : submeshes.ToString())} / GUID {reference.Guid} / fileID {reference.FileId}");
                    }
                    if (removed.Count == 0) continue;
                    serialized.ApplyModifiedPropertiesWithoutUndo();
                    PrefabUtility.RecordPrefabInstancePropertyModifications(renderer);
                    receipts.Add(new Dictionary<string, object>
                    {
                        ["renderer_path"] = renderer.transform == avatar.transform ? "." : Probe.HierarchyPath(avatar.transform, renderer.transform),
                        ["renderer_type"] = renderer.GetType().FullName, ["source_file"] = removed[0].reference.Source,
                        ["original_slot_count"] = original, ["final_slot_count"] = materials.arraySize,
                        ["removed_slots"] = removed.OrderBy(row => row.slot).Select(row => (object)row.slot).ToList(),
                        ["removed_guids"] = removed.OrderBy(row => row.slot).Select(row => (object)row.reference.Guid).ToList(),
                        ["removed_file_ids"] = removed.OrderBy(row => row.slot).Select(row => (object)row.reference.FileId.ToString(CultureInfo.InvariantCulture)).ToList(),
                    });
                }
            }
            return receipts;
        }

        /// <summary>
        /// A dangling texture reference is the vendor's when the archive member this material's import
        /// actually selected carries the same GUID and no owned source can supply it. The proof is the
        /// reference's provenance, not the file's byte equality: a vendor shader package migrates its own
        /// materials at import time, which rewrites plenty of bytes without adding or removing a
        /// reference. Compared by GUID, never by array slot, because that migration moves slots around.
        /// </summary>
        static bool VendorMaterialReference(UnityEngine.Object value, SerializedProperty property, Reference reference)
        {
            if (!(value is Material) || string.IsNullOrEmpty(reference.Guid)) return false;
            if (!Regex.IsMatch(property.propertyPath, @"^m_SavedProperties\.m_TexEnvs\.Array\.data\[\d+\]\.second\.m_Texture$")) return false;
            var path = AssetDatabase.GetAssetPath(value);
            if (!path.StartsWith("Assets/") || path.StartsWith("Assets/_Harness")) return false;
            if (!materialOrigins.TryGetValue(path, out var origin))
            {
                var library = Avh.Env("AVH_ASSET_LIBRARY"); var tools = Avh.Env("AVH_TOOL_ROOT");
                if (string.IsNullOrEmpty(library) || string.IsNullOrEmpty(tools)) return false;
                string Quote(string arg) => "\"" + arg.Replace("\"", "\\\"") + "\"";
                var start = new System.Diagnostics.ProcessStartInfo
                {
                    FileName = Application.platform == RuntimePlatform.WindowsEditor ? "python" : "python3",
                    Arguments = string.Join(" ", new[] { Path.Combine(tools,"harness","observe_assets.py"), "--project", Avh.ProjectDir,
                        "--library", library, "--classify-material", path }.Select(Quote)),
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                };
                start.EnvironmentVariables["PYTHONDONTWRITEBYTECODE"] = "1";
                using (var process = System.Diagnostics.Process.Start(start))
                {
                    var output = process.StandardOutput.ReadToEnd(); var error = process.StandardError.ReadToEnd(); process.WaitForExit();
                    if (process.ExitCode != 0) throw new Exception("厂商材质来源独立核对失败：" + error);
                    origin = Avh.ParseJson(output) as Dictionary<string, object> ?? throw new Exception("材质来源核对结果无效");
                    materialOrigins[path] = origin;
                }
            }
            return origin.List("origin_references").Any(g => g.ToString() == reference.Guid)
                && origin.List("unavailable_guids").Any(g => g.ToString() == reference.Guid);
        }

        /// <summary>
        /// A missing motion is noise only when it is a genuinely absent asset from a vendor controller.
        /// Harness-generated assets live under the managed roots (including the injected tool and cold-probe
        /// roots), so their missing references must remain blocking. A GUID that resolves to an asset but has
        /// the wrong fileID is also blocking: this exemption is deliberately limited to GUIDToAssetPath == "".
        /// </summary>
        static bool VendorAnimationReference(UnityEngine.Object value, SerializedProperty property, Reference reference,
            out string controllerPath, out string motionName)
        {
            controllerPath = AssetDatabase.GetAssetPath(value);
            motionName = value == null ? "" : value.name;
            var stateMotion = value is AnimatorState && property.propertyPath == "m_Motion";
            var treeMotion = value is BlendTree && Regex.IsMatch(property.propertyPath, @"^m_(?:Children|Childs)\.Array\.data\[\d+\]\.m_Motion$");
            if (!stateMotion && !treeMotion) return false;
            if (string.IsNullOrEmpty(controllerPath) || !controllerPath.EndsWith(".controller", StringComparison.OrdinalIgnoreCase)) return false;
            // This is the ownership boundary: all generated/output/tool assets are managed roots; anything
            // else under Assets is an imported/vendor controller and may carry the vendor's own omission.
            if (controllerPath.StartsWith("Assets/_Harness/", StringComparison.Ordinal)
                || controllerPath.StartsWith("Assets/_HarnessTools/", StringComparison.Ordinal)
                || controllerPath.StartsWith("Assets/_HarnessColdProbe/", StringComparison.Ordinal)) return false;
            if (reference == null || string.IsNullOrEmpty(reference.Guid)
                || !string.IsNullOrEmpty(AssetDatabase.GUIDToAssetPath(reference.Guid))) return false;
            if (treeMotion) motionName = value.name + " / " + property.propertyPath;
            return true;
        }

        /// <summary>
        /// The resolution work one traversal actually did. A test reads this to bound it: a source file is
        /// indexed once and a document parsed once no matter how many references point into it, so these
        /// counts stay proportional to the sources and documents, not to the number of null references.
        /// </summary>
        public static Dictionary<string, object> PerformanceCounters() => new Dictionary<string, object>
        {
            ["source_texts"] = sources.Count,
            ["document_index_builds"] = OutfitPerf.Count("Document.indexBuilds"),
            ["document_lookups"] = OutfitPerf.Count("Document.lookups"),
            ["direct_calls"] = OutfitPerf.Count("Direct"),
            ["direct_root_parses"] = OutfitPerf.Count("Direct.roots"),
            ["serialized_reference_calls"] = OutfitPerf.Count("SerializedReference"),
            ["instance_override_calls"] = OutfitPerf.Count("InstanceOverrides"),
            ["traversed_leaves"] = OutfitPerf.Count("Observe.leaves"),
            ["skipped_array_elements"] = OutfitPerf.Count("Observe.skippedArrayElements"),
        };

        public static List<object> WriteObservation(GameObject avatar)
        {
            Reset();
            materialOrigins.Clear();
            var notes = new List<string>();
            var reminders = new List<object>();
            LastAnimationReminders = new List<object>();
            var broken = 0;
            var materialSlots = 0;
            var unlocated = 0;
            var unlocatedGroups = new Dictionary<string, int>();
            var queue = new Queue<UnityEngine.Object>(avatar.GetComponentsInChildren<Component>(true).Where(component => component != null)
                .Cast<UnityEngine.Object>().Concat(avatar.GetComponentsInChildren<Transform>(true).Select(t => (UnityEngine.Object)t.gameObject)));
            var seen = new HashSet<int>();
            foreach (var go in avatar.GetComponentsInChildren<Transform>(true).Select(t => t.gameObject))
            {
                var missingScripts = GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(go);
                broken += missingScripts;
                if (missingScripts > 0) notes.Add("装配产物脚本缺失：" + Probe.HierarchyPath(avatar.transform, go.transform));
            }
            // Follow resolved effective properties. CollectDependencies would also follow provenance
            // pointers into original prefabs and reintroduce dependencies removed by instance overrides.
            while (queue.Count > 0)
            {
                var value = queue.Dequeue();
                if (value == null || !seen.Add(value.GetInstanceID())) continue;
                var objectStart = OutfitPerf.Now;
                using (var serialized = new SerializedObject(value))
                {
                    var property = serialized.GetIterator();
                    var enterChildren = true;
                    while (property.Next(enterChildren))
                    {
                        enterChildren = true;
                        OutfitPerf.Bump("Observe.leaves");
                        // A mesh carries its index and vertex buffers as arrays of bytes — 53 million
                        // elements on a real avatar against 66k object references. Descending into every
                        // element spends almost the whole traversal there without ever finding a
                        // dependency, so an array whose elements cannot hold one is not entered at all.
                        if (property.isArray && !ArrayHoldsReferences(property))
                        {
                            OutfitPerf.Bump("Observe.skippedArrayElements", property.arraySize);
                            enterChildren = false;
                        }
                        if (property.propertyType != SerializedPropertyType.ObjectReference) continue;
                        if (property.propertyPath.StartsWith("m_CorrespondingSourceObject") || property.propertyPath == "m_PrefabInstance" || property.propertyPath == "m_PrefabAsset") continue;
                        if (value is Renderer && property.propertyPath.StartsWith("m_Materials.Array.data[")) materialSlots++;
                        if (property.objectReferenceValue != null) { queue.Enqueue(property.objectReferenceValue); continue; }
                        var reference = Missing(value, property);
                        if (reference == null) continue;
                        // A default-empty field is not a broken link: the source text never mentions the
                        // property, the value is null and Unity holds no instance identity, so nothing points
                        // at a missing object. On a real avatar these are almost all of the null references —
                        // fields Unity omits from YAML and objects that came from an FBX — and each one is an
                        // observation, not a defect. A pointer the text does locate, or one Unity itself still
                        // holds an identity for, keeps blocking below.
                        if (reference.Uncertain && !reference.Nonzero && property.objectReferenceInstanceIDValue == 0)
                        {
                            unlocated++;
                            var group = value.GetType().Name + " / " + Regex.Replace(property.propertyPath, @"\[\d+\]", "[N]");
                            unlocatedGroups.TryGetValue(group, out var grouped);
                            unlocatedGroups[group] = grouped + 1;
                            continue;
                        }
                        var vendorStart = OutfitPerf.Now;
                        var vendor = VendorMaterialReference(value, property, reference);
                        OutfitPerf.Add("VendorMaterialReference", OutfitPerf.Now - vendorStart);
                        if (vendor)
                        {
                            reminders.Add(new Dictionary<string, object> { ["material"] = AssetDatabase.GetAssetPath(value),
                                ["property"] = property.propertyPath, ["guid"] = reference.Guid });
                            notes.Add($"厂商材质贴图缺件提醒（使用着色器默认贴图，不阻断）：{AssetDatabase.GetAssetPath(value)} / {property.propertyPath} / GUID {reference.Guid}");
                            continue;
                        }
                        if (VendorAnimationReference(value, property, reference, out var controllerPath, out var motionName))
                        {
                            LastAnimationReminders.Add(new Dictionary<string, object> { ["controller"] = controllerPath,
                                ["state"] = motionName, ["guid"] = reference.Guid });
                            notes.Add($"厂商动画缺件提醒（该状态不播放，不阻断）：{controllerPath} / {motionName} / GUID {reference.Guid}");
                            continue;
                        }
                        broken++;
                        var path = value is Component component ? Probe.HierarchyPath(avatar.transform, component.transform) : AssetDatabase.GetAssetPath(value);
                        notes.Add($"装配产物{(reference.Uncertain ? "引用定位无法确认" : "有效依赖缺失")}：{path} / {value.GetType().Name} / {property.propertyPath} / GUID {reference.Guid} / fileID {reference.FileId}");
                    }
                }
                OutfitPerf.Add("Observe.objects", OutfitPerf.Now - objectStart);
            }
            // Grouped and capped: a real avatar reports thousands of these, and no per-reference line would
            // ever be read. The count in the observation is the measurement; these lines only name the shapes.
            foreach (var group in unlocatedGroups.OrderByDescending(row => row.Value).ThenBy(row => row.Key, StringComparer.Ordinal).Take(20))
                notes.Add($"定位不到的默认空引用（不计断链）：{group.Key} × {group.Value}");
            if (unlocatedGroups.Count > 20)
                notes.Add($"定位不到的默认空引用共 {unlocated} 条 / {unlocatedGroups.Count} 组，已列前 20 组");
            Avh.Observation("avatar.dependencies", new Dictionary<string, object> { ["broken_guid_refs"] = broken,
                ["unlocated_null_refs"] = unlocated,
                ["material_slots_checked"] = materialSlots, ["dependency_objects_checked"] = seen.Count,
                ["vendor_missing_material_references"] = reminders.Count,
                ["vendor_missing_animation_references"] = LastAnimationReminders.Count }, notes);
            return reminders;
        }
    }

    public static class OutfitStage
    {
        public const string Dir = "Assets/_Harness/Outfit";
        public const string AvatarPath = Dir + "/Avatar.prefab";
        public const string RecordPath = Dir + "/outfit.json";
        public const string Group = "_Outfit";

        public static void Run() => Avh.Stage("outfit", Produce);

        // A separate read-only step loads the persisted output; construction cannot supply its verdict.
        public static void Observe() => Avh.Stage("outfit-observe",
            () => OutfitMeasure.WriteAvatar(AvatarPath, RecordPath), save: false);

        public static void Produce()
        {
            OutfitPerf.Mark("Produce start");
            var plan = Avh.Plan();
            var baseline = Avh.ReadJsonFile(Avh.Abs("_harness/setup/baseline.json")) ?? throw new Exception("缺少 setup 基线");
            var bodyPath = FaceStage.ValidatedOutput(plan.Str("body_prefab") ?? baseline.Str("body_prefab"));
            var body = AssetDatabase.LoadAssetAtPath<GameObject>(bodyPath) ?? throw new Exception($"素体预制体加载不了：{bodyPath}");
            EnsureFolder(Dir);
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var removals = new List<object>();
            // Out parameters cannot be captured by a timing lambda, so each phase is bracketed by marks.
            OutfitPerf.Mark("Assemble start");
            var phaseStart = OutfitPerf.Now;
            var avatar = Assemble(body, plan, out var hidden, out var records, removals);
            OutfitPerf.Add("Assemble", OutfitPerf.Now - phaseStart);
            OutfitPerf.Mark("Assemble done");
            var operations = OutfitPerf.Time("LocalOperations.Apply", () => LocalOperations.Apply(avatar, records: records));
            OutfitPerf.Mark("LocalOperations.Apply done");
            // D-138: a part closed by a recorded, justified local operation is a visibility decision, not a
            // missing part. It leaves the outfit's expected visible set before the record is written, so the
            // fixed check stops reporting it; an unrecorded disappearance still fails, and the outfit root is
            // never deducted (a fixed outfit stays installed).
            var recordedHidden = OutfitPerf.Time("DeductRecordedClosures", () => OutfitMeasure.DeductRecordedClosures(records, LocalOperations.RecordedClosures(operations)));
            if (recordedHidden.Count > 0) Avh.Log($"局部操作记录在案的关闭：{recordedHidden.Count} 件");
            OutfitPerf.Mark("DeductRecordedClosures done");
            // Local attachment operations can add more nested sources after the main outfit assembly.
            removals.AddRange(EffectiveReferences.TrimMissingTailMaterials(avatar));
            OutfitPerf.Mark("TrimMissingTailMaterials(avatar) done");
            OutfitPerf.Time("RefreshMaterialPresets", () => RefreshMaterialPresets(avatar, records));
            OutfitPerf.Mark("RefreshMaterialPresets done");
            OutfitPerf.Time("ShrinkKeyDecision", () =>
            {
                foreach (Dictionary<string, object> record in records)
                {
                    var specification = plan.List("outfits").Cast<Dictionary<string, object>>().Single(value => value.Str("id") == record.Str("id"));
                    record["shrinkkey"] = ShrinkKeyDecision(avatar.transform.Find(record.Str("object")).gameObject, specification, true, records);
                }
            });
            OutfitPerf.Mark("ShrinkKeyDecision done");
            // D-139 ②: after every part is installed, garments that carry a body same-name shape key with no
            // driver of their own follow the body. Runs before the prefab is saved so the components are part
            // of the artifact, and after the local operations so added parts are scanned too.
            var shapeKeySync = OutfitPerf.Time("SyncBodyShapeKeys", () => SyncBodyShapeKeys(avatar, bodyPath));
            if (Convert.ToInt32(shapeKeySync["count"]) > 0)
                Avh.Log($"装配补上的形态键同步：{shapeKeySync["count"]} 条（件、键、跟随网格见 outfit.json 的 blendshape_sync）");
            foreach (Dictionary<string, object> record in records)
            {
                var root = record.Str("object");
                var prefix = root + "/";
                // A renderer can be the outfit root itself; matching only the prefix would drop those rows from
                // the receipt and leave the reload's declared-versus-measured cross-check with nothing to check.
                bool Owned(Dictionary<string, object> row) => row.Str("renderer") == root
                    || row.Str("renderer").StartsWith(prefix, StringComparison.Ordinal);
                record["blendshape_sync"] = new Dictionary<string, object>
                {
                    ["added"] = shapeKeySync.List("added").Cast<Dictionary<string, object>>().Where(Owned).Cast<object>().ToList(),
                    ["skipped"] = shapeKeySync.List("skipped").Cast<Dictionary<string, object>>().Where(Owned).Cast<object>().ToList(),
                };
            }
            OutfitPerf.Mark("SyncBodyShapeKeys done");
            OutfitPerf.Mark("SaveAsPrefabAsset start");
            phaseStart = OutfitPerf.Now;
            PrefabUtility.SaveAsPrefabAsset(avatar, AvatarPath, out var saved);
            OutfitPerf.Add("SaveAsPrefabAsset", OutfitPerf.Now - phaseStart);
            OutfitPerf.Mark("SaveAsPrefabAsset done");
            if (!saved) throw new Exception("存变体失败");
            OutfitPerf.Mark("WriteObservation start");
            var materialReminders = OutfitPerf.Time("WriteObservation", () => EffectiveReferences.WriteObservation(avatar));
            OutfitPerf.Mark("WriteObservation done");
            OutfitPerf.Time("WriteJson", () => Avh.WriteJson(Avh.Abs(RecordPath), new Dictionary<string, object>
            {
                ["schema"] = AvatarConfig.Grouped(plan) ? "outfit/0.4" : "outfit/0.3", ["body_prefab"] = bodyPath, ["avatar_prefab"] = AvatarPath, ["group"] = Group,
                ["avatar_config"] = plan.Obj("avatar_config"),
                ["hidden_body_parts"] = hidden, ["outfits"] = records,
                ["blendshape_sync_added"] = shapeKeySync.List("added"),
                ["blendshape_sync_skipped"] = shapeKeySync.List("skipped"),
                ["blendshape_sync_body_meshes"] = shapeKeySync.List("body_meshes"),
                ["blendshape_sync_notes"] = shapeKeySync.List("notes"),
                ["vendor_missing_material_slots"] = removals,
                ["vendor_missing_material_references"] = materialReminders,
                ["vendor_missing_animation_references"] = EffectiveReferences.LastAnimationReminders,
                ["mode"] = records.Count == 0 ? "preserve" : "assemble",
            }));
            if (operations != null)
            {
                // The delivery notes read the deducted closures out of the receipt, so the parts a recorded
                // decision hid are named there as well as in the assembly record and visibility.json.
                operations["hidden_by_decision"] = recordedHidden;
                // D-139 ②: the receipt also names the shape keys assembly made follow the body, so the
                // executor and the delivery notes can see what the stage decided without re-reading the
                // assembly record.
                operations["blendshape_sync_added"] = shapeKeySync.List("added");
                OutfitPerf.Time("WriteOperations", () => Avh.WriteJson(Avh.Abs(LocalOperations.OutputPath), operations));
                AssetDatabase.ImportAsset(LocalOperations.OutputPath, ImportAssetOptions.ForceSynchronousImport);
            }
            AssetDatabase.ImportAsset(RecordPath);
            UnityEngine.Object.DestroyImmediate(avatar);
            OutfitPerf.Time("Aftermath.OutfitMeasure.Write", () => OutfitMeasure.Write(AvatarPath, RecordPath));
            OutfitPerf.Report("Produce");
        }

        public static void RefreshMaterialPresets(GameObject avatar, List<object> records)
        {
            foreach (Dictionary<string, object> record in records)
                foreach (Dictionary<string, object> row in record.List("material_presets"))
                {
                    var target = VariantResolver.MaterialTarget(avatar.transform, row);
                    if (target == null) throw new Exception("预设渲染器不存在");
                    var renderer = target.GetComponents<Renderer>().Single(r => r.GetType().FullName == row.Str("type"));
                    var original = row.List("materials");
                    // Tail removal never changes preceding variant material assignments.
                    row["materials"] = original.Take(renderer.sharedMaterials.Length).ToList();
                }
        }

        // Source assembly is reconstructed for production and independent output comparisons.
        public static GameObject Assemble(GameObject body, Dictionary<string, object> plan, out List<object> hidden, out List<object> records, List<object> removals = null)
        {
            plan = AvatarConfig.Project(plan);
            var outfits = plan.List("outfits").Cast<Dictionary<string, object>>().ToList();
            SourceShapeAudit.CaptureSources(plan,new Dictionary<string,object> { ["outfits"]=outfits.Cast<object>().ToList() });
            var exclusive = outfits.Where(o => !Fixed(o)).ToList();
            var defaultId = plan.Str("default_outfit");
            if (!AvatarConfig.Grouped(plan) && (exclusive.Count > 0 && exclusive.All(o => o.Str("id") != defaultId)
                || exclusive.Count == 0 && defaultId != null)) throw new Exception("default_outfit 必须且只能指向 exclusive 衣装");
            if (outfits.Count == 0 && plan.List("hide_body_parts").Count > 0)
                throw new Exception("保留原装时不能隐式隐藏原服装；请明确提出独立的删改方案");

            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(body);
            hidden = HideBodyClothing(avatar, plan);
            GameObject group = null;
            if (outfits.Count > 0) { group = new GameObject(Group); group.transform.SetParent(avatar.transform, false); }

            records = new List<object>();
            var physical = new Dictionary<string, GameObject>();
            var physicalSpecifications = new Dictionary<string, Dictionary<string, object>>();
            var signatures = new Dictionary<string, string>();
            foreach (var original in outfits)
            {
                var outfit = LocalOperations.AssemblySpecification(original);
                var id = outfit.Str("id");
                var prefabPath = outfit.Str("prefab") ?? throw new Exception($"服装 {id} 没有指定 prefab");
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath) ?? throw new Exception($"服装预制体加载不了：{prefabPath}");
                var logicalInstance = outfit.Str("instance") ?? id;
                var inspection = AvatarConfig.Grouped(plan) ? VariantResolver.ExpectedInspection(prefab) : null;
                var signature = inspection != null ? inspection.Signature : id;
                var key = logicalInstance + "|" + (signature ?? "unproven-member:" + id);
                var reused = physical.TryGetValue(key, out var instance);
                string Mechanics(Dictionary<string, object> spec) => Avh.Json(new Dictionary<string, object>
                    { ["mount"] = spec.Obj("mount"), ["mounts"] = spec.List("mounts"), ["mode"] = spec.Str("assembly_mode") });
                if (reused)
                {
                    var first = physicalSpecifications[key];
                    if (outfit.ContainsKey("assembly_observation_sha256") && Mechanics(outfit) != Mechanics(first))
                        throw new Exception("共享物理实例的装配配方冲突：" + id);
                    if (!outfit.ContainsKey("assembly_observation_sha256") && first.ContainsKey("assembly_observation_sha256"))
                        foreach (var field in new[] { "mount", "mounts", "assembly_mode", "assembly_observation_sha256" })
                            if (first.ContainsKey(field)) outfit[field] = first[field];
                }
                if (!reused)
                {
                    instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab, group.transform);
                    var authorMenu=instance.GetComponent<ModularAvatarMenuItem>();
                    if(authorMenu!=null&&string.IsNullOrEmpty(authorMenu.label))authorMenu.label=instance.name;
                    instance.name = $"Outfit_{id}";
                    // Preserve the true missing identity before material preset projection turns nulls into identities.
                    foreach (Dictionary<string, object> removal in EffectiveReferences.TrimMissingTailMaterials(instance))
                    {
                        var relative = removal.Str("renderer_path");
                        removal["renderer_path"] = Probe.HierarchyPath(avatar.transform, instance.transform)
                            + (relative == "." ? "" : "/" + relative);
                        removals?.Add(removal);
                    }
                    RebaseAbsoluteBoneProxyPaths(avatar, instance, prefab);
                    physical[key] = instance;
                    physicalSpecifications[key] = outfit;
                }
                var kind = Classify(instance);
                if (!reused && outfit.ContainsKey("assembly_observation_sha256") && kind != "none") throw new Exception("局部装配不能覆盖厂商装配组件：" + id);
                if (!reused && kind == "none")
                {
                    if (outfit.Obj("mount") != null || outfit.List("mounts").Count > 0)
                    {
                        var mounts = outfit.Obj("mount") != null ? new[] { outfit.Obj("mount") } : outfit.List("mounts").Cast<Dictionary<string, object>>();
                        foreach (var mount in mounts)
                        {
                            var source = string.IsNullOrEmpty(mount.Str("source")) ? instance.transform : AvatarAudit.Locate(instance.transform, mount.Str("source"));
                            var target = AvatarAudit.Locate(avatar.transform, mount.Str("path"));
                            if (source == null || target == null) throw new Exception("挂点源或目标不存在/不唯一：" + id);
                            if (source.GetComponent<ModularAvatarBoneProxy>() != null) throw new Exception("挂点不能覆盖厂商 BoneProxy");
                            var proxy = source.gameObject.AddComponent<ModularAvatarBoneProxy>(); proxy.target = target;
                            proxy.attachmentMode = BoneProxyAttachmentMode.AsChildKeepWorldPose;
                            if (OutfitMeasure.ResolveProxy(avatar, proxy) != target) throw new Exception("挂点无法解析到已观察目标：" + id);
                            if (mount.Str("pose") != "preserve")
                            {
                                var pose = mount.List("position").Select(Convert.ToSingle).ToArray(); var rotation = mount.List("rotation").Select(Convert.ToSingle).ToArray();
                                source.position = target.TransformPoint(pose.Length == 3 ? new Vector3(pose[0], pose[1], pose[2]) : Vector3.zero);
                                source.rotation = target.rotation * (rotation.Length == 3 ? Quaternion.Euler(rotation[0], rotation[1], rotation[2]) : Quaternion.identity);
                            }
                        }
                        kind = "boneproxy";
                    }
                    else if (!AvatarConfig.Grouped(plan) || outfit.Str("kind") == "outfit" || outfit.Str("assembly_mode") == "merge")
                    {
                        if (outfit.Str("assembly_mode") == "merge" && !instance.GetComponentsInChildren<SkinnedMeshRenderer>(true).Any(r => r.bones.Length > 0))
                            throw new Exception("合骨配方需要实际蒙皮骨架：" + id);
                        SetupOutfit(instance); kind = Classify(instance);
                    }
                    else throw new Exception("发型/配饰没有厂商挂点；方案必须给出测量过的 mount：" + id);
                }
                var isDefault = AvatarConfig.Grouped(plan) ? AvatarConfig.On(outfit, "default") : Fixed(outfit) || id == defaultId;
                if (!reused) instance.SetActive(isDefault);
                else if (isDefault) instance.SetActive(true);
                var materials = VariantResolver.ExpectedMaterials(prefab, instance, avatar.transform);
                if (isDefault) VariantResolver.ApplyMaterials(avatar, materials);
                var reason = signature == null ? "unsupported serialized leaves; equivalence unproven, materialized independently" : signatures.TryGetValue(logicalInstance, out var firstSignature) && firstSignature != signature
                    ? "expanded serialized structure or behavior differs; independent physical instance" : "verified serialized equivalence except material slots";
                signatures[logicalInstance] = signature;
                records.Add(new Dictionary<string, object>
                {
                    ["id"] = id, ["item"] = outfit.Str("item"), ["label"] = outfit.Str("label"), ["prefab"] = prefabPath,
                    ["object"] = $"{Group}/{instance.name}", ["assembly"] = kind, ["default"] = isDefault,
                    ["activation"] = outfit.Str("activation") ?? "exclusive", ["group"] = outfit.Str("group"),
                    ["instance"] = logicalInstance, ["variant"] = outfit.Str("variant"), ["kind"] = outfit.Str("kind"),
                    ["mount"] = outfit.Obj("mount"), ["mounts"] = outfit.List("mounts"),
                    ["assembly_observation_sha256"] = outfit.Str("assembly_observation_sha256"),
                    ["source_guid"] = AssetDatabase.AssetPathToGUID(prefabPath), ["source_hash"] = AssetDatabase.GetAssetDependencyHash(prefabPath).ToString(),
                    ["source_identity"] = VariantResolver.Identity(prefab), ["variant_comparison_version"] = "serialized/0.2",
                    ["variant_unsupported"] = inspection?.Unsupported.Cast<object>().ToList() ?? new List<object>(),
                    ["material_presets"] = materials, ["materialization"] = reason,
                    ["built_paths"] = InstalledParts(instance).Append(instance.transform).Distinct()
                        .ToDictionary(t => Probe.HierarchyPath(avatar.transform, t), t => (object)BuiltPath(avatar.transform, t)),
                    ["fixed_visuals"] = Fixed(outfit) ? InstalledParts(instance).Where(t => t.gameObject.activeInHierarchy)
                        .Select(t => (object)Probe.HierarchyPath(avatar.transform, t)).ToList() : new List<object>(),
                    ["fixed_built_paths"] = Fixed(outfit) ? InstalledParts(instance).Append(instance.transform).Distinct()
                        .ToDictionary(t => Probe.HierarchyPath(avatar.transform, t), t => (object)BuiltPath(avatar.transform, t))
                        : new Dictionary<string, object>(),
                    ["installed_parts"] = InstalledParts(instance).Select(t => (object)Probe.HierarchyPath(avatar.transform, t)).ToList(),
                    ["baseline_visuals"] = InstalledParts(instance).ToDictionary(t => Probe.HierarchyPath(avatar.transform, t),
                        t => (object)(t.GetComponentsInParent<Transform>(true).TakeWhile(p => p != instance.transform)
                            .All(p => p.gameObject.activeSelf && !p.CompareTag("EditorOnly")))),
                    // NDMF reparents BoneProxy objects to their target bone. A selector that only disables the outfit root
                    // would then leave these visual parts behind, so the menu stage must own them explicitly as well.
                    ["bone_proxy_visuals"] = instance.GetComponentsInChildren<ModularAvatarBoneProxy>(true)
                        .Where(proxy => proxy.GetComponentsInChildren<Renderer>(true).Length > 0)
                        .Select(proxy => (object)Probe.HierarchyPath(avatar.transform, proxy.transform)).Distinct().ToList(),
                    ["bone_proxy_defaults"] = instance.GetComponentsInChildren<ModularAvatarBoneProxy>(true)
                        .ToDictionary(proxy => Probe.HierarchyPath(avatar.transform, proxy.transform), proxy => (object)proxy.gameObject.activeSelf),
                    ["shrinkkey"] = ShrinkKeyDecision(instance, outfit),
                });
            }

            if (AvatarConfig.Grouped(plan)) foreach (var toggle in AvatarConfig.Switches(plan))
                foreach (Dictionary<string, object> target in toggle.List("targets"))
                {
                    var spec = plan.Obj("avatar_config").List("instances").Cast<Dictionary<string, object>>().Single(i => i.Str("id") == target.Str("instance"));
                    var component = spec.List("components").Cast<Dictionary<string, object>>().Single(c => c.Str("id") == target.Str("component"));
                    foreach (Dictionary<string, object> row in records.Where(r => ((Dictionary<string, object>)r).Str("instance") == target.Str("instance")))
                        foreach (var relative in component.List("objects"))
                        {
                            var t = avatar.transform.Find(row.Str("object") + "/" + relative) ?? throw new Exception("共享部件对象缺失");
                            t.gameObject.SetActive(AvatarConfig.On(toggle, "default") && t.gameObject.activeSelf);
                        }
                }
            return avatar;
        }

        /// <summary>
        /// MA resolves a LastBone proxy's non-empty subPath from the avatar root at build time.
        /// A prefab authored at an avatar root can therefore serialize its own root name in that
        /// path; once the prefab is installed under _Outfit, the same target has a new avatar-root
        /// path. Re-encode only paths that resolve through the source prefab's own root, using MA's
        /// target setter so its boneReference/subPath representation stays authoritative. Paths that
        /// do not resolve in the source are left untouched and remain a real compatibility failure.
        static void RebaseAbsoluteBoneProxyPaths(GameObject avatar, GameObject instance, GameObject source)
        {
            if (avatar == null || instance == null || source == null) return;
            var sourcePrefix = source.name + "/";
            foreach (var proxy in instance.GetComponentsInChildren<ModularAvatarBoneProxy>(true))
            {
                if (proxy.boneReference != HumanBodyBones.LastBone || string.IsNullOrWhiteSpace(proxy.subPath)
                    || proxy.subPath == "$$AVATAR") continue;
                // An already valid avatar-root reference is authoritative. In particular, do not
                // reinterpret a body path merely because the outfit happens to contain a matching suffix.
                if (avatar.transform.Find(proxy.subPath) != null) continue;
                var isSourceRootPath = proxy.subPath.Equals(source.name, StringComparison.Ordinal)
                    || proxy.subPath.StartsWith(sourcePrefix, StringComparison.Ordinal);
                var relative = proxy.subPath.Equals(source.name, StringComparison.Ordinal) ? ""
                    : isSourceRootPath ? proxy.subPath.Substring(sourcePrefix.Length) : null;
                if (relative == null) continue;
                var target = relative.Length == 0 ? instance.transform : instance.transform.Find(relative);
                if (target != null) proxy.target = target;
            }
        }

        public static bool Fixed(Dictionary<string, object> entry)
        {
            var activation = entry.Str("activation") ?? "exclusive";
            if (activation != "fixed" && activation != "exclusive" && activation != "independent") throw new Exception("activation 必须为 fixed/exclusive/independent");
            return activation == "fixed";
        }

        static string BuiltPath(Transform avatar, Transform target)
        {
            for (var parent = target; parent != avatar && parent != null; parent = parent.parent)
            {
                var proxy = parent.GetComponent<ModularAvatarBoneProxy>();
                if (proxy?.target == null) continue;
                // MA renames colliding proxies and can move nested targets. Do not let an ambiguous
                // prediction certify another object's visibility; retain no alias and fail readback.
                if (proxy.target.Find(parent.name) != null || proxy.target.GetComponentInParent<ModularAvatarBoneProxy>() != null
                    || avatar.GetComponentsInChildren<ModularAvatarBoneProxy>(true).Any(other => other != proxy
                        && other.target == proxy.target && other.name == parent.name)) return null;
                var suffix = AnimationUtility.CalculateTransformPath(target, parent);
                return Probe.HierarchyPath(avatar, proxy.target) + "/" + parent.name + (suffix.Length > 0 ? "/" + suffix : "");
            }
            return Probe.HierarchyPath(avatar, target);
        }

        public static void EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            var parent = Path.GetDirectoryName(path)!.Replace('\\', '/');
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
        }

        public static bool IsUnmodifiedVariant(GameObject prefab, string sourcePath, Func<PropertyModification, bool> authorizedMaterialChange = null)
        {
            if (prefab == null) return false;
            var source = PrefabUtility.GetCorrespondingObjectFromSource(prefab);
            bool Equivalent(PropertyModification modification)
            {
                // SaveAsPrefabAsset names the root after its file and serializes default root transform overrides.
                // Accept only that generated name and numerically unchanged root transforms, never arbitrary overrides.
                if (modification.target == source && modification.propertyPath == "m_Name")
                    return modification.value == Path.GetFileNameWithoutExtension(AssetDatabase.GetAssetPath(prefab));
                if (source == null || modification.target != source.transform) return false;
                if (!new[] { "m_LocalPosition.", "m_LocalRotation.", "m_LocalEulerAnglesHint.", "m_LocalScale." }
                    .Any(prefix => modification.propertyPath.StartsWith(prefix, StringComparison.Ordinal))) return false;
                var property = new SerializedObject(source.transform).FindProperty(modification.propertyPath);
                return property != null && property.propertyType == SerializedPropertyType.Float
                    && float.TryParse(modification.value, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
                    && value == property.floatValue;
            }
            return source != null && AssetDatabase.GetAssetPath(source) == sourcePath
                && (PrefabUtility.GetPropertyModifications(prefab) ?? Array.Empty<PropertyModification>())
                    .All(modification => Equivalent(modification) || authorizedMaterialChange?.Invoke(modification) == true)
                && PrefabUtility.GetAddedComponents(prefab).Count == 0
                && PrefabUtility.GetRemovedComponents(prefab).Count == 0
                && PrefabUtility.GetAddedGameObjects(prefab).Count == 0
                && PrefabUtility.GetRemovedGameObjects(prefab).Count == 0;
        }

        public static bool IsAuthorizedMaterialRepair(GameObject actual, GameObject prefab, string sourcePath)
        {
            var source = AssetDatabase.LoadAssetAtPath<GameObject>(sourcePath);
            if (source == null || AssetDatabase.GetAssetPath(PrefabUtility.GetCorrespondingObjectFromSource(prefab)) != sourcePath) return false;
            var expected = (GameObject)PrefabUtility.InstantiatePrefab(source);
            try
            {
                // Reconstruct the narrowly authorized repair from source bytes, never from the writer's receipt.
                if (EffectiveReferences.TrimMissingTailMaterials(expected).Count == 0) return false;
                var targets = new HashSet<Renderer>();
                foreach (var renderer in expected.GetComponentsInChildren<Renderer>(true))
                {
                    var scoped = PrefabUtility.GetCorrespondingObjectFromSourceAtPath(renderer, sourcePath);
                    if (scoped != null) targets.Add(scoped);
                    for (var target = PrefabUtility.GetCorrespondingObjectFromSource(renderer); target != null && targets.Add(target);
                        target = PrefabUtility.GetCorrespondingObjectFromSource(target)) { }
                }
                // Unity's override metadata covers component types whose serialized leaves the thin-variant
                // inspector cannot represent. Allow only material overrides on the reconstructed renderers;
                // component/object additions/removals and every other property retain the original strict check.
                return IsUnmodifiedVariant(prefab, sourcePath, modification => modification.target is Renderer renderer
                        && targets.Contains(renderer) && (modification.propertyPath == "m_Materials.Array.size"
                            || Regex.IsMatch(modification.propertyPath, @"^m_Materials\.Array\.data\[\d+\]$")))
                    && RendererMaterialState(actual) == RendererMaterialState(expected);
            }
            finally { UnityEngine.Object.DestroyImmediate(expected); }
        }

        static string RendererMaterialState(GameObject root) => Avh.Json(root.GetComponentsInChildren<Renderer>(true)
            .Select(renderer => (object)new object[] { Probe.HierarchyPath(root.transform, renderer.transform),
                Array.IndexOf(renderer.GetComponents<Renderer>(), renderer), renderer.GetType().FullName,
                renderer.sharedMaterials.Select(material => (object)VariantResolver.Identity(material)).ToList() }).ToList());

        static List<object> HideBodyClothing(GameObject avatar, Dictionary<string, object> plan)
        {
            var named = plan.List("hide_body_parts").Select(x => x.ToString()).ToList();
            // Object names are not semantic evidence. Without an explicit plan, preserve the body exactly as supplied.
            var targets = named.Select(n => avatar.transform.Find(n) ?? throw new Exception($"hide_body_parts 里的 {n} 不是素体对象路径")).ToList();
            // 关掉并标 EditorOnly：VRChat 构建时整棵剔除，厂商动画层再怎么开它也开不回来（它们的曲线只是指向不存在的物体）。
            foreach (var t in targets) { t.gameObject.SetActive(false); t.gameObject.tag = "EditorOnly"; }
            Avh.Log($"隐藏素体自带衣服：{string.Join(", ", targets.Select(t => t.name))}");
            return targets.Select(t => (object)t.name).ToList();
        }

        /// <summary>SOP 50 步骤 1 的四类：mergearmature / boneproxy / both / none。</summary>
        public static string Classify(GameObject outfit)
        {
            var merge = outfit.GetComponentsInChildren<ModularAvatarMergeArmature>(true).Length > 0;
            var proxy = outfit.GetComponentsInChildren<ModularAvatarBoneProxy>(true).Length > 0;
            return merge && proxy ? "both" : merge ? "mergearmature" : proxy ? "boneproxy" : "none";
        }

        /// <summary>
        /// MA's own Setup Outfit, with its error window suppressed: batch mode has no one to click it. Called by reflection
        /// because MA's editor assembly is not auto-referenced (autoReferenced: false).
        /// </summary>
        static void SetupOutfit(GameObject outfit)
        {
            Type Find(string name) => AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(name)).FirstOrDefault(t => t != null);
            var window = Find("nadena.dev.modular_avatar.core.editor.ESOErrorWindow");
            window?.GetField("Suppress", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public)?.SetValue(null, true);
            var setup = Find("nadena.dev.modular_avatar.core.editor.SetupOutfit")?.GetMethod("SetupOutfitUI", BindingFlags.Static | BindingFlags.Public)
                ?? throw new Exception("找不到 MA 的 SetupOutfit.SetupOutfitUI");
            setup.Invoke(null, new object[] { outfit });
            if (outfit.GetComponentsInChildren<ModularAvatarMergeArmature>(true).Length == 0)
                throw new Exception($"{outfit.name}：MA Setup Outfit 没有加上 MergeArmature（骨架不像人形或找不到 Hips）");
        }

        /// <summary>Every installed visual part, including static MeshFilters and parts under BoneProxy-only prefabs.</summary>
        public static IEnumerable<Transform> InstalledParts(GameObject outfit) =>
            outfit.GetComponentsInChildren<Renderer>(true).Select(r => r.transform)
                .Concat(outfit.GetComponentsInChildren<MeshFilter>(true).Select(m => m.transform)).Distinct();

        /// <summary>
        /// 收缩键逐套判定（SOP 50 步骤 4）：厂商配了 MA Shape Changer 就沿用；没配的不自行加删除类收缩键
        /// （删除类要先量鞋袜包覆范围），穿模留给回归阶段的换装照片与人工审核。
        /// </summary>
        static readonly Regex FootShape = new Regex("foot|toe|ankle|heel|足|脚|踝|爪", RegexOptions.IgnoreCase);

        public static Dictionary<string, object> ShrinkKeyDecision(GameObject outfit, Dictionary<string, object> specification, bool localReview = false, List<object> records = null)
        {
            var changers = outfit.GetComponentsInChildren<ModularAvatarShapeChanger>(true);
            var entries = changers.SelectMany(c => c.Shapes.Select(s => new
            {
                host = Probe.HierarchyPath(outfit.transform, c.transform), target = s.Object?.referencePath ?? "",
                shape = s.ShapeName ?? "", change = s.ChangeType.ToString(),
            })).ToList();
            var shapes = entries.Select(s => (object)$"{s.host}->{s.target}:{s.shape}={s.change}").ToList();
            var setDelete = entries.GroupBy(s => $"{s.host}\n{s.target}\n{s.shape}")
                .Where(g => g.Select(s => s.change).Distinct().Count() > 1).Select(g => (object)g.Key.Replace('\n', ':')).ToList();
            var multiwriters = entries.GroupBy(s => $"{s.target}\n{s.shape}")
                .Where(g => g.Select(s => s.host).Distinct().Count() > 1).Select(g => (object)g.Key.Replace('\n', ':')).ToList();
            var footKeys = entries.Where(s => FootShape.IsMatch(s.shape)).Select(s => (object)$"{s.target}:{s.shape}").Distinct().ToList();
            var logicalPath = string.IsNullOrEmpty(specification.Str("id")) ? null : "_Outfit/Outfit_" + specification.Str("id");
            var local = localReview ? LocalOperations.Review(outfit, shapes, setDelete, logicalPath, records) : null;
            var review = local ?? specification.Obj("shrinkkey_review");
            var scenarios = new HashSet<string>((review?.List("scenarios") ?? new List<object>()).Select(x => x.ToString()));
            var reviewRequired = footKeys.Count > 0 || multiwriters.Count > 0;
            var reviewOk = !reviewRequired || (review?.Str("status") == "approved" || review?.Str("status") == "runtime_verified")
                && !string.IsNullOrWhiteSpace(review.Str("rationale"))
                && (footKeys.Count == 0 || new[] { "shoe_on_sock_on", "shoe_off_sock_on", "barefoot" }.All(scenarios.Contains));
            return new Dictionary<string, object>
            {
                ["decision"] = changers.Length > 0 ? (reviewOk ? "写者方案已复核，外观待回归" : "厂商配置待复核") : "不加",
                ["reason"] = changers.Length > 0 ? $"已清点厂商预制体的 {changers.Length} 个 MA Shape Changer；风险写者必须由方案复核"
                    : "厂商未配收缩键；不自行加删除类收缩键（SOP 50：要先量包覆范围），穿模由回归照片与人工审核兜底",
                ["shapes"] = shapes, ["set_delete_conflicts"] = setDelete, ["multiwriters"] = multiwriters,
                ["foot_keys"] = footKeys, ["review_required"] = reviewRequired, ["review_ok"] = reviewOk, ["review"] = review,
            };
        }

        /// <summary>
        /// D-139 ②: a garment that carries a body same-name shape key but no driver of its own keeps the
        /// vendor default while the body moves (SOP「衣物跟随身体形态键」第一类失效：连体袜带着身体的脚型键，
        /// 鞋子把它设成 100，袜子一直停在 0). Assembly scans every installed renderer structurally:
        /// same-name keys; body-side writers that can make the key nonzero (an installed MA Shape Changer
        /// `Set`, a vendor animation curve with a nonzero key, or a nonzero default weight on a body mesh);
        /// and no driver already present on the garment (a BlendshapeSync binding, a Shape Changer, or an
        /// animation curve). Each hit adds one binding to a single ModularAvatarBlendshapeSync per renderer,
        /// referencing the body mesh that carries the key. Asset, layer and bone names are never matched —
        /// the only name equality used is the blend shape key the vendor already shares with the body, and
        /// the body itself is identified through the plan's `body_prefab`
        /// (<see cref="global::AvatarAudit.AuditPartInventory.BodyIdentity"/>, the same identity the probes use).
        /// MA runs its BlendshapeSync pass after the reactive components that apply a Shape Changer, so the
        /// body value is already written when the sync reads it; the assembly artifact is still only a
        /// claim, and the regression's key-follow readback is what proves it took effect.
        /// </summary>
        public static Dictionary<string, object> SyncBodyShapeKeys(GameObject avatar, string bodyPath)
        {
            var added = new List<object>();
            var skipped = new List<object>();
            var bodyMeshes = new List<object>();
            var notes = new List<object>();
            var result = new Dictionary<string, object>
            {
                ["added"] = added, ["skipped"] = skipped, ["body_meshes"] = bodyMeshes, ["notes"] = notes, ["count"] = 0,
            };
            var group = avatar.transform.Find(Group);
            if (group == null) return result;
            var known = global::AvatarAudit.AuditPartInventory.BodyIdentity(bodyPath);
            result["body_identity"] = known.Cast<object>().ToList();
            var body = BodyMeshes(avatar, known);
            foreach (var mesh in body) bodyMeshes.Add(Probe.HierarchyPath(avatar.transform, mesh.transform));
            if (body.Count == 0) { notes.Add("没有按方案的 body_prefab 身份识别出素体网格；不补同步"); return result; }

            var writers = BodyKeyWriters(avatar, body);
            var clips = AnimationClips(avatar);
            var changed = ShapeChangerKeys(avatar);
            var animated = CurveKeys(avatar, clips);

            var renderers = group.GetComponentsInChildren<SkinnedMeshRenderer>(true)
                .Where(renderer => renderer != null && renderer.sharedMesh != null && !DroppedFromBuild(renderer))
                .OrderBy(renderer => Probe.HierarchyPath(avatar.transform, renderer.transform), StringComparer.Ordinal).ToList();
            foreach (var renderer in renderers)
            {
                var path = Probe.HierarchyPath(avatar.transform, renderer.transform);
                var mesh = renderer.sharedMesh;
                var sync = renderer.GetComponent<ModularAvatarBlendshapeSync>();
                var driven = new HashSet<string>(StringComparer.Ordinal);
                if (sync?.Bindings != null) foreach (var binding in sync.Bindings) driven.Add(LocalKey(binding));
                if (changed.TryGetValue(renderer, out var fromChangers)) driven.UnionWith(fromChangers);
                if (animated.TryGetValue(renderer, out var fromClips)) driven.UnionWith(fromClips);

                var pending = new List<BlendshapeBinding>();
                for (var index = 0; index < mesh.blendShapeCount; index++)
                {
                    var key = mesh.GetBlendShapeName(index);
                    if (!writers.TryGetValue(key, out var writer)) continue;
                    var reference = Probe.HierarchyPath(avatar.transform, writer.Mesh.transform);
                    if (driven.Contains(key))
                    {
                        skipped.Add(new Dictionary<string, object>
                        {
                            ["renderer"] = path, ["key"] = key, ["reference_mesh"] = reference,
                            ["reason"] = "件上已有驱动（BlendshapeSync／Shape Changer／动画曲线）；不重复补",
                        });
                        continue;
                    }
                    pending.Add(new BlendshapeBinding
                    {
                        ReferenceMesh = BodyReference(avatar, writer.Mesh), Blendshape = key, LocalBlendshape = "",
                        // MA's inspector initializes a fresh binding with an explicit identity remap curve, and
                        // its OnValidate fills one in whenever it finds none. Writing the same curve here keeps
                        // the serialized component at the state a hand-authored binding has, instead of leaving
                        // it dependent on whether OnValidate happened to run on the saved asset.
                        RemapCurve = IdentityRemap(), RemapCurveIsValid = true,
                    });
                    added.Add(new Dictionary<string, object>
                    {
                        ["renderer"] = path, ["key"] = key, ["reference_mesh"] = reference,
                        ["reason"] = writer.Reasons,
                    });
                }
                if (pending.Count == 0) continue;
                if (sync == null)
                {
                    sync = renderer.gameObject.AddComponent<ModularAvatarBlendshapeSync>();
                    sync.Bindings = new List<BlendshapeBinding>();
                }
                else if (sync.Bindings == null) sync.Bindings = new List<BlendshapeBinding>();
                sync.Bindings.AddRange(pending);
            }
            result["count"] = added.Count;
            return result;
        }

        sealed class BodyKeyWriter
        {
            public SkinnedMeshRenderer Mesh;
            public int Rank;
            /// <summary>Evidence per candidate mesh: only the reasons of the mesh the binding ends up pointing
            /// at may be quoted, or the record justifies a reference with another mesh's evidence.</summary>
            public readonly Dictionary<SkinnedMeshRenderer, List<string>> ByMesh = new Dictionary<SkinnedMeshRenderer, List<string>>();

            public string Reasons => ByMesh.TryGetValue(Mesh, out var reasons) ? string.Join("；", reasons) : "";
        }

        static string LocalKey(BlendshapeBinding binding) =>
            string.IsNullOrWhiteSpace(binding.LocalBlendshape) ? binding.Blendshape : binding.LocalBlendshape;

        static bool InAssemblyLayer(GameObject avatar, Transform target)
        {
            var group = avatar.transform.Find(Group);
            return group != null && target != null && target.IsChildOf(group);
        }

        /// <summary>Body renderers by the plan's identity (AuditPartInventory.BodyIdentity → AuditBodyPick);
        /// the name/weight fallback only runs when no identity name is present in the prefab.</summary>
        static List<SkinnedMeshRenderer> BodyMeshes(GameObject avatar, List<string> known)
        {
            // A body mesh deactivated by a recorded operation is still the body; one the build drops is not
            // part of the delivered avatar, so it can neither carry a followed key nor be a reference. A
            // disabled renderer contributes nothing either way.
            var candidates = avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true)
                .Where(smr => smr != null && smr.sharedMesh != null && smr.enabled && !DroppedFromBuild(smr)).ToList();
            var parts = new List<SkinnedMeshRenderer>();
            if (known != null && known.Count > 0)
            {
                var wanted = new HashSet<string>(known.Where(name => !string.IsNullOrEmpty(name)).Select(name => name.Trim()), StringComparer.OrdinalIgnoreCase);
                parts.AddRange(candidates.Where(smr => wanted.Contains(smr.gameObject.name) && !InAssemblyLayer(avatar, smr.transform)));
            }
            if (parts.Count == 0)
            {
                var fallback = global::AvatarAudit.AuditPartInventory.FindBodyForRegression(avatar, candidates, known);
                if (fallback != null) parts.Add(fallback);
            }
            return parts.OrderBy(smr => Probe.HierarchyPath(avatar.transform, smr.transform), StringComparer.Ordinal).ToList();
        }

        /// <summary>Body keys that can be nonzero in the delivered avatar, with the mesh that carries each one
        /// and the evidence for the reading. A key written only by `Delete` is forced to zero and is not a
        /// candidate.</summary>
        static Dictionary<string, BodyKeyWriter> BodyKeyWriters(GameObject avatar, List<SkinnedMeshRenderer> body)
        {
            var writers = new Dictionary<string, BodyKeyWriter>(StringComparer.Ordinal);
            void Offer(SkinnedMeshRenderer mesh, string key, int rank, string reason)
            {
                if (mesh?.sharedMesh == null || string.IsNullOrWhiteSpace(key)) return;
                if (mesh.sharedMesh.GetBlendShapeIndex(key) < 0) return;
                if (!writers.TryGetValue(key, out var writer)) writers[key] = writer = new BodyKeyWriter { Mesh = mesh, Rank = rank };
                else
                {
                    // The mesh a writer actually targets wins; between equally ranked writers the one already
                    // off zero is the one whose value the delivered avatar carries.
                    var better = rank > writer.Rank || rank == writer.Rank
                        && Mathf.Approximately(WeightOf(writer.Mesh, key), 0f) && !Mathf.Approximately(WeightOf(mesh, key), 0f);
                    if (better) { writer.Mesh = mesh; writer.Rank = rank; }
                }
                if (!writer.ByMesh.TryGetValue(mesh, out var reasons)) writer.ByMesh[mesh] = reasons = new List<string>();
                if (!reasons.Contains(reason)) reasons.Add(reason);
            }

            // A key already off zero on the body itself needs no writer to move it.
            foreach (var mesh in body)
                for (var index = 0; index < mesh.sharedMesh.blendShapeCount; index++)
                {
                    var weight = mesh.GetBlendShapeWeight(index);
                    if (Mathf.Approximately(weight, 0f)) continue;
                    Offer(mesh, mesh.sharedMesh.GetBlendShapeName(index), 1, $"素体默认权重 {weight.ToString("0.###", CultureInfo.InvariantCulture)}");
                }

            // An installed MA Shape Changer `Set` on a body mesh is baked into the delivered avatar.
            foreach (var changer in avatar.GetComponentsInChildren<ModularAvatarShapeChanger>(true))
                foreach (var shape in changer.Shapes ?? new List<ChangedShape>())
                {
                    if (shape == null || shape.ChangeType != ShapeChangeType.Set) continue;
                    if (DroppedFromBuild(changer)) continue;
                    var target = RendererOf(ReferenceTarget(avatar, changer, shape.Object));
                    if (target == null || !body.Contains(target)) continue;
                    Offer(target, shape.ShapeName, 3,
                        $"已装件 {Probe.HierarchyPath(avatar.transform, changer.transform)} 的 MA Shape Changer Set={shape.Value.ToString("0.###", CultureInfo.InvariantCulture)}");
                }

            // A vendor animation curve with a nonzero key moves the body at runtime.
            foreach (var (root, clip) in AnimationClips(avatar))
                foreach (var binding in AnimationUtility.GetCurveBindings(clip))
                {
                    if (binding.type != typeof(SkinnedMeshRenderer) || !binding.propertyName.StartsWith("blendShape.", StringComparison.Ordinal)) continue;
                    var target = root != null ? root.Find(binding.path) : null;
                    var mesh = target != null ? target.GetComponent<SkinnedMeshRenderer>() : null;
                    if (mesh == null || !body.Contains(mesh)) continue;
                    var curve = AnimationUtility.GetEditorCurve(clip, binding);
                    if (curve == null || curve.keys.Length == 0 || curve.keys.All(point => Mathf.Approximately(point.value, 0f))) continue;
                    Offer(mesh, binding.propertyName.Substring("blendShape.".Length), 2, $"厂商动画曲线 {clip.name} 写在素体上");
                }
            return writers;
        }

        /// <summary>Shape keys an installed MA Shape Changer writes on a garment renderer.</summary>
        static Dictionary<SkinnedMeshRenderer, HashSet<string>> ShapeChangerKeys(GameObject avatar)
        {
            var map = new Dictionary<SkinnedMeshRenderer, HashSet<string>>();
            foreach (var changer in avatar.GetComponentsInChildren<ModularAvatarShapeChanger>(true))
                foreach (var shape in changer.Shapes ?? new List<ChangedShape>())
                {
                    if (shape == null || string.IsNullOrWhiteSpace(shape.ShapeName)) continue;
                    if (DroppedFromBuild(changer)) continue;
                    var target = RendererOf(ReferenceTarget(avatar, changer, shape.Object));
                    if (target == null) continue;
                    if (!map.TryGetValue(target, out var keys)) map[target] = keys = new HashSet<string>(StringComparer.Ordinal);
                    keys.Add(shape.ShapeName);
                }
            return map;
        }

        /// <summary>Shape keys any animation curve writes on a renderer.</summary>
        static Dictionary<SkinnedMeshRenderer, HashSet<string>> CurveKeys(GameObject avatar, List<(Transform root, AnimationClip clip)> clips)
        {
            var map = new Dictionary<SkinnedMeshRenderer, HashSet<string>>();
            foreach (var (root, clip) in clips)
                foreach (var binding in AnimationUtility.GetCurveBindings(clip))
                {
                    if (binding.type != typeof(SkinnedMeshRenderer) || !binding.propertyName.StartsWith("blendShape.", StringComparison.Ordinal)) continue;
                    var target = root != null ? root.Find(binding.path) : null;
                    var renderer = target != null ? target.GetComponent<SkinnedMeshRenderer>() : null;
                    if (renderer == null) continue;
                    if (!map.TryGetValue(renderer, out var keys)) map[renderer] = keys = new HashSet<string>(StringComparer.Ordinal);
                    keys.Add(binding.propertyName.Substring("blendShape.".Length));
                }
            return map;
        }

        /// <summary>Every clip the assembled avatar carries, with the transform its binding paths resolve
        /// against: merged controllers follow MA's path mode, the avatar's own Animator resolves against
        /// itself.</summary>
        static List<(Transform root, AnimationClip clip)> AnimationClips(GameObject avatar)
        {
            var found = new List<(Transform, AnimationClip)>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            void Add(Transform root, RuntimeAnimatorController controller)
            {
                if (!(controller is AnimatorController animator)) return;
                foreach (var clip in animator.animationClips)
                {
                    if (clip == null) continue;
                    var token = (root != null ? Probe.HierarchyPath(avatar.transform, root) : "") + "|" + clip.GetInstanceID();
                    if (seen.Add(token)) found.Add((root, clip));
                }
            }
            foreach (var merge in avatar.GetComponentsInChildren<ModularAvatarMergeAnimator>(true))
            {
                if (DroppedFromBuild(merge)) continue;
                Add(MergeRoot(avatar, merge), merge.animator);
            }
            foreach (var animator in avatar.GetComponentsInChildren<Animator>(true))
            {
                if (DroppedFromBuild(animator)) continue;
                Add(animator.transform, animator.runtimeAnimatorController);
            }
            // A VRChat avatar's own layers live on the descriptor, not on the Animator component, and their
            // binding paths are avatar-root relative. Missing them would both hide a real body writer and
            // mistake a garment the vendor already animates for an undriven one.
            foreach (var descriptor in avatar.GetComponentsInChildren<VRCAvatarDescriptor>(true))
            {
                if (DroppedFromBuild(descriptor) || descriptor.baseAnimationLayers == null || descriptor.specialAnimationLayers == null) continue;
                foreach (var (_, controller) in AvatarAudit.Layers(descriptor)) Add(avatar.transform, controller);
            }
            return found;
        }

        /// <summary>The transform a merged controller's binding paths resolve against (MA's path mode).</summary>
        public static Transform MergeRoot(GameObject avatar, ModularAvatarMergeAnimator merge)
        {
            var relative = merge.relativePathRoot != null ? merge.relativePathRoot.Get(merge) : null;
            return merge.pathMode == MergeAnimatorPathMode.Absolute ? avatar.transform
                : relative != null ? relative.transform : merge.transform;
        }

        /// <summary>Resolve an MA object reference without assuming MA's avatar-root detection works on the
        /// assembled prefab: MA's own resolution first, then the recorded path from this avatar root.</summary>
        static GameObject ReferenceTarget(GameObject avatar, Component host, AvatarObjectReference reference)
        {
            if (reference == null) return null;
            GameObject target = null;
            try { target = reference.Get(host); } catch { /* a path-only reference is resolved below */ }
            if (target == null && !string.IsNullOrEmpty(reference.referencePath) && reference.referencePath != AvatarObjectReference.AVATAR_ROOT)
            {
                var found = avatar.transform.Find(reference.referencePath);
                if (found != null) target = found.gameObject;
            }
            return target;
        }

        static SkinnedMeshRenderer RendererOf(GameObject target)
        {
            // MA reads the renderer with a direct GetComponent (ReactiveObjectAnalyzer.LocateReactions), so a
            // reference to a container that merely *holds* a renderer drives nothing. Accepting it here would
            // mark a key as already driven that MA never writes, and the sync this pass exists to add would be
            // skipped instead.
            return target == null ? null : target.GetComponent<SkinnedMeshRenderer>();
        }

        /// <summary>Whether a part is dropped from the delivered avatar: a local `object_state` operation with
        /// `exclude_from_build` (and `hide_body_parts`) tags the named object EditorOnly, and the build removes
        /// the whole subtree. A writer or driver inside such a subtree never runs, so it is no evidence that a
        /// key moves. Unlike <see cref="ExcludedFromBuild"/> this looks up the parent chain, because the tag
        /// sits on the container the operation names, not on the component — and it does not treat a merely
        /// deactivated object as dropped, because an `active: false` operation alone leaves it in the build.</summary>
        static bool DroppedFromBuild(Component component) =>
            component == null || component.GetComponentsInParent<Transform>(true).Any(parent => parent.CompareTag("EditorOnly"));

        static float WeightOf(SkinnedMeshRenderer mesh, string key)
        {
            if (mesh?.sharedMesh == null) return 0f;
            var index = mesh.sharedMesh.GetBlendShapeIndex(key);
            return index >= 0 ? mesh.GetBlendShapeWeight(index) : 0f;
        }

        /// <summary>The identity remap curve MA's inspector writes for a fresh binding: (0,0)-(100,100)
        /// linear. Written explicitly so the component serializes the same with or without OnValidate.</summary>
        static AnimationCurve IdentityRemap()
        {
            var curve = new AnimationCurve();
            curve.AddKey(0f, 0f);
            curve.AddKey(100f, 100f);
            for (var index = 0; index < curve.length; index++)
            {
                AnimationUtility.SetKeyBroken(curve, index, true);
                AnimationUtility.SetKeyLeftTangentMode(curve, index, AnimationUtility.TangentMode.Linear);
                AnimationUtility.SetKeyRightTangentMode(curve, index, AnimationUtility.TangentMode.Linear);
            }
            return curve;
        }

        /// <summary>The reference MA needs to follow the body: the renderer that carries the key, encoded by
        /// MA's own avatar-root path when that resolves and by the prefab-root path otherwise.</summary>
        static AvatarObjectReference BodyReference(GameObject avatar, SkinnedMeshRenderer body)
        {
            var fallback = Probe.HierarchyPath(avatar.transform, body.transform);
            var reference = new AvatarObjectReference();
            try { reference.Set(body.gameObject); } catch { /* the prefab-root path below is the fallback */ }
            var encoded = reference.referencePath;
            // MA resolves the reference from the avatar root at build time. When its own encoding does not
            // round-trip to this renderer, use the prefab-root path. A body mesh reachable only through an
            // ambiguous sibling name stays ambiguous for both encodings, and the reload's
            // declared-versus-measured note is what reports that rather than silently accepting it.
            if (string.IsNullOrEmpty(encoded) || encoded == AvatarObjectReference.AVATAR_ROOT
                || avatar.transform.Find(encoded)?.gameObject != body.gameObject) reference.referencePath = fallback;
            return reference;
        }
    }

    /// <summary>Read-only measurements of a dressed avatar prefab; shared by the outfit stage and later stages.</summary>
    public static class OutfitMeasure
    {
        public static void WriteAvatar(string avatarPath, string recordPath)
        {
            var notes = new List<string>();
            var record = Avh.ReadJsonFile(Avh.Abs(recordPath));
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(avatarPath);
            if (prefab == null || record == null)
            {
                Avh.Observation("avatar.observe", new Dictionary<string, object> { ["group_defaults_match"] = null },
                    new List<string> { "装配结果或记录不存在" });
                return;
            }
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                OutfitPerf.Mark("Observe: instantiated avatar");
                var plan = Avh.Plan();
                var baseline = Avh.ReadJsonFile(Avh.Abs("_harness/setup/baseline.json"));
                var metrics = OutfitPerf.Time("Observe.Measure.Observe", () => Measure.Observe(avatar, baseline, notes));
                OutfitPerf.Mark("Observe: Measure.Observe done");
                // The dependency observation describes the assembled artifact, so it is written before any other
                // measurement touches the instance. The render-confirmed interpenetration reading installs its own
                // temporary id/depth materials on the renderers while it runs; a walk taken after it reported
                // broken GUID references the artifact never had (GI1 found this by comparing tool sets on one
                // artifact: 4 with the reading, 0 without).
                OutfitPerf.Time("Observe.WriteObservation", () => EffectiveReferences.WriteObservation(avatar));
                Visibility(avatar, record, metrics, notes);
                // Outfit defaults are assembly defaults. Recolor/menu assertions additionally expect
                // derived material presets and compiled controllers that do not exist at this stage.
                if (AvatarConfig.Grouped(plan))
                {
                    // A persisted outfit row is a construction record, not an authority for its own expected
                    // materials. Rebuild the approved plan against the observed source assets and
                    // validate any local operations before using the row's effective presets below.
                    // This keeps Observe independent from assembly output and rejects empty or
                    // tampered material mappings instead of treating them as an empty comparison.
                    var hasOperations = File.Exists(Avh.Abs(LocalOperations.InputPath));
                    var operationsValid = !hasOperations || LocalOperations.Verify(avatar,
                        AssetDatabase.LoadAssetAtPath<GameObject>(record.Str("body_prefab")), plan, notes);
                    if (!operationsValid) notes.Add("局部操作或材质预设未通过独立验证；默认状态观察失败");
                    metrics["group_defaults_match"] = operationsValid && GroupDefaults(avatar, record, plan, notes);
                }
                Avh.Observation("avatar.observe", metrics, notes);
                OutfitPerf.Report("Observe");
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }

        static readonly HumanBodyBones[] Trunk =
        {
            HumanBodyBones.Hips, HumanBodyBones.Spine, HumanBodyBones.Chest, HumanBodyBones.Neck, HumanBodyBones.Head,
            HumanBodyBones.LeftShoulder, HumanBodyBones.RightShoulder, HumanBodyBones.LeftUpperArm, HumanBodyBones.RightUpperArm,
            HumanBodyBones.LeftLowerArm, HumanBodyBones.RightLowerArm, HumanBodyBones.LeftHand, HumanBodyBones.RightHand,
            HumanBodyBones.LeftUpperLeg, HumanBodyBones.RightUpperLeg, HumanBodyBones.LeftLowerLeg, HumanBodyBones.RightLowerLeg,
            HumanBodyBones.LeftFoot, HumanBodyBones.RightFoot,
        };

        public static void Write(string avatarPath, string recordPath)
        {
            var notes = new List<string>();
            var metrics = new Dictionary<string, object>();
            var record = Avh.ReadJsonFile(Avh.Abs(recordPath));
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(avatarPath);
            if (prefab == null || record == null)
            {
                foreach (var key in new[] { "assembly_compatibility_failures", "fixed_outfit_state_failures", "unclassified_prefabs", "humanoid_missing_bones", "unmounted_bone_proxies", "registered_inputs_without_disposition", "unmet_obligations", "mergearmature_mapped_bones", "ungrouped_skeleton_parts",
                             "outfits_without_shrinkkey_decision", "shapechanger_set_delete_conflicts",
                             "unreviewed_shrinkkey_writers", "blendshape_sync_missing_keys", "blendshape_sync_followed_keys",
                             "nonzero_body_blendshape_curves" }) metrics[key] = null;
                Avh.Observation("clothing.install", metrics, new List<string> { "装配结果或记录不存在" });
                return;
            }
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            SourceShapeAudit.CaptureSources(Avh.Plan(),record);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                var animator = avatar.GetComponent<Animator>();
                var outfits = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
                var hasOperations = File.Exists(Avh.Abs(LocalOperations.InputPath));
                var operationsOk = !hasOperations || LocalOperations.Verify(avatar,
                    AssetDatabase.LoadAssetAtPath<GameObject>(record.Str("body_prefab")), Avh.Plan(), notes);
                metrics["local_operations_valid"] = operationsOk;
                metrics["authorized_local_variant_valid"] = outfits.Count == 0 && record.Str("mode") == "preserve"
                    && (hasOperations ? operationsOk : OutfitStage.IsAuthorizedMaterialRepair(avatar, prefab, record.Str("body_prefab")));
                metrics["preserved_outfit_unmodified"] = outfits.Count == 0 && record.Str("mode") == "preserve"
                    && OutfitStage.IsUnmodifiedVariant(prefab, record.Str("body_prefab"));
                var proxyFailures = ProxyFailures(avatar);
                int unclassified = 0, missingTrunk = 0, unmountedProxies = 0, ungrouped = 0, noDecision = 0, setDelete = 0, unreviewed = 0, syncMissing = 0, curves = 0, assemblyFailures = 0;
                var mappedMin = int.MaxValue;
                foreach (var entry in outfits)
                {
                    var root = avatar.transform.Find(entry.Str("object"));
                    if (root == null) { unclassified++; notes.Add($"{entry.Str("id")}：变体里找不到 {entry.Str("object")}"); continue; }
                    if (!new[] { "mergearmature", "boneproxy", "both", "none" }.Contains(OutfitStage.Classify(root.gameObject))) unclassified++;
                    assemblyFailures += AssemblyFailures(avatar, root.gameObject, entry, notes, proxyFailures);
                    var mapped = MappedBones(root.gameObject);
                    mappedMin = Math.Min(mappedMin, mapped.Count);
                    var missing = MissingHumanoidTrunkBones(root.gameObject, animator, mapped);
                    missingTrunk += missing.Count;
                    if (missing.Count > 0) notes.Add($"{entry.Str("id")}：人形主干没吸附到的 {string.Join(",", missing)}");
                    var unmounted = UnmountedBoneProxies(root.gameObject);
                    unmountedProxies += unmounted.Count;
                    if (unmounted.Count > 0) notes.Add($"{entry.Str("id")}：道具没指定挂点，NDMF 不会把它挂到骨骼上：{string.Join(",", unmounted)}");
                    var listedValues = entry.List("installed_parts");
                    // Old records remain measurable during an in-place upgrade; the next stage run rewrites them as outfit/0.3.
                    if (listedValues.Count == 0) listedValues = entry.List("skeleton_parts");
                    var listed = new HashSet<string>(listedValues.Select(x => x.ToString()));
                    var parts = OutfitStage.InstalledParts(root.gameObject).Select(t => Probe.HierarchyPath(avatar.transform, t)).ToList();
                    ungrouped += parts.Count(p => !listed.Contains(p));
                    var specification = Avh.Plan().List("outfits").Cast<Dictionary<string, object>>().Single(value => value.Str("id") == entry.Str("id"));
                    var decision = OutfitStage.ShrinkKeyDecision(root.gameObject, specification, true, record.List("outfits"));
                    if (decision == null || string.IsNullOrEmpty(decision.Str("decision")) || string.IsNullOrEmpty(decision.Str("reason"))) noDecision++;
                    setDelete += decision?.List("set_delete_conflicts").Count ?? 0;
                    if (decision != null && decision.TryGetValue("review_required", out var required) && Equals(required, true)
                        && (!decision.TryGetValue("review_ok", out var reviewed) || !Equals(reviewed, true)))
                    {
                        unreviewed++;
                        notes.Add($"{entry.Str("id")}：脚型/收缩键写者缺少证据绑定的方案复核；由 AI 提交局部 shrinkkey_review 修订，三态外观留给回归实测");
                    }
                    curves += BodyBlendShapeCurves(avatar, root.gameObject, notes);
                    syncMissing += BlendshapeSyncMissingKeys(root.gameObject, notes);
                    notes.Add($"{entry.Str("id")}：{entry.Str("assembly")}，吸附骨 {mapped.Count}，骨架内渲染器 {parts.Count}");
                }
                metrics["unclassified_prefabs"] = unclassified;
                metrics["assembly_compatibility_failures"] = assemblyFailures;
                metrics["humanoid_missing_bones"] = missingTrunk;
                    metrics["unmounted_bone_proxies"] = unmountedProxies;
                // Every registered product has to end up somewhere in the plan, or be declared unused with a
                // reason. The per-item checks all ask whether what the plan names was assembled correctly,
                // so a plan that quietly names less passes them all: on a real project four products were
                // registered and the plan mounted one, while its own notes promised the stage would attach
                // the rest. Coverage is the question those checks never ask, and it is the same rule the
                // manual workflow already states, that every asset row needs a use or a stated reason.
                var uncovered = UncoveredInputs(record, Avh.Plan());
                metrics["registered_inputs_without_disposition"] = uncovered.Count;
                foreach (var id in uncovered) notes.Add($"登记的素材没有被方案安排：{id}");
                // Obligations whose owning stage is this one are checked against the artifact rather than
                // against what the assembler says it did: a record can claim a mount that never happened,
                // and two independent reviews of the coverage question both raised exactly that. Each
                // promise gets its own metric so a verdict names the one that failed rather than a total.
                var unmet = UnmetObligations(avatar, record, Avh.Plan());
                metrics["fixed_outfit_state_failures"] = FixedFailures(avatar, record, Avh.Plan(), notes);
                if (AvatarConfig.Grouped(Avh.Plan()))
                {
                    var expected = Avh.Plan().List("outfits").Cast<Dictionary<string, object>>().ToList();
                    metrics["group_members_installed"] = expected.All(e => outfits.Any(o => o.Str("id") == e.Str("id")
                        && o.Str("prefab") == e.Str("prefab") && o.Str("instance") == e.Str("instance")
                        && o.List("installed_parts").Count > 0 && o.List("installed_parts").All(p => avatar.transform.Find(p.ToString()) != null)));
                    metrics["group_defaults_match"] = GroupDefaults(avatar, record, Avh.Plan(), notes);
                }
                metrics["unmet_obligations"] = unmet.Count;
                foreach (var obligation in ObligationsDueHere(Avh.Plan(), "outfit"))
                {
                    var name = ObligationMetric(obligation);
                    metrics[name] = unmet.Any(x => ObligationMetric(x) == name) ? 0 : 1;
                }
                foreach (var entry in unmet)
                    notes.Add($"{entry.Str("input")}：方案承诺要装，产物里没有可验证的结果");
                metrics["mergearmature_mapped_bones"] = mappedMin == int.MaxValue ? 0 : mappedMin;
                metrics["ungrouped_skeleton_parts"] = ungrouped;
                metrics["outfits_without_shrinkkey_decision"] = noDecision;
                metrics["shapechanger_set_delete_conflicts"] = setDelete;
                metrics["unreviewed_shrinkkey_writers"] = unreviewed;
                metrics["blendshape_sync_missing_keys"] = syncMissing;
                // D-139 ② readback: the same-name keys the assembled artifact actually follows, measured on
                // the instantiated prefab rather than trusted from the assembly record. A binding only
                // counts when the referenced body renderer carries the source key and the garment carries
                // the local key — exactly what MA needs for the sync to take effect. The record's own list
                // is compared against the measurement, so a claim that did not persist is reported.
                metrics["blendshape_sync_followed_keys"] = BlendshapeSyncFollow(avatar, record, notes);
                metrics["nonzero_body_blendshape_curves"] = curves;
                // D-138: the default-state visibility inventory and its counters, measured on the instantiated
                // artifact before the finally below destroys it.
                Visibility(avatar, record, metrics, notes);
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
            Avh.Observation("clothing.install", metrics, notes);
        }

        /// <summary>
        /// D-138: the default-state visibility inventory and its counters, measured on the persisted artifact
        /// rather than trusted from the assembly record. A measurement that cannot run leaves the counters
        /// absent (no_data), never zero. D-143 ③: the recipe's per-pair interpenetration decisions are read back
        /// from the receipt (the applied recipe) so the Runtime can require one for every confirmed pair while
        /// leaving the judgement to the executor; a decision that does not fit the measurement leaves its pair
        /// blocking instead of being silently accepted.
        /// </summary>
        static void Visibility(GameObject avatar, Dictionary<string, object> record, Dictionary<string, object> metrics, List<string> notes)
        {
            try
            {
                var report = OutfitVisibility.Measure(avatar, record?.Str("body_prefab"), HiddenByDecision(record), notes,
                    LocalOperations.RecordedDecisions());
                OutfitVisibility.Apply(metrics, report);
            }
            catch (Exception error)
            {
                notes.Add("可见性清单测量失败：" + error.Message);
                OutfitVisibility.Apply(metrics, null);
            }
        }

        public static bool GroupDefaults(GameObject avatar, Dictionary<string, object> record, Dictionary<string, object> plan, List<string> notes)
        {
            var failures = 0; var rows = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
            var expected = new Dictionary<string, bool>(); var defaults = AvatarConfig.Defaults(plan);
            try { foreach (var axis in MaterialAxes.Groups(plan)) MaterialAxes.Slots(axis, record); }
            catch (Exception e) { failures++; notes.Add("Material axis assembly unknown: " + e.Message); }
            foreach (var group in AvatarConfig.InstanceGroups(plan)) foreach (Dictionary<string, object> m in group.List("members"))
            {
                var row = rows.SingleOrDefault(r => r.Str("id") == m.Str("id"));
                if (row == null) { failures++; continue; }
                var on = AvatarConfig.Selected(group, m, defaults);
                var source = AssetDatabase.LoadAssetAtPath<GameObject>(row.Str("prefab"));
                if (source == null) { failures++; continue; }
                foreach (var part in OutfitStage.InstalledParts(source))
                {
                    var relative = AnimationUtility.CalculateTransformPath(part, source.transform);
                    var path = row.Str("object") + (relative.Length == 0 ? "" : "/" + relative);
                    var enabled = on && part.GetComponentsInParent<Transform>(true).TakeWhile(p => p != source.transform)
                        .All(p => p.gameObject.activeSelf && !p.CompareTag("EditorOnly")) && (part.GetComponent<Renderer>() == null || part.GetComponent<Renderer>().enabled);
                    foreach (var toggle in AvatarConfig.Switches(plan)) foreach (Dictionary<string, object> target in toggle.List("targets"))
                        if (target.Str("instance") == m.Str("instance"))
                        {
                            var spec = plan.Obj("avatar_config").List("instances").Cast<Dictionary<string, object>>().Single(i => i.Str("id") == m.Str("instance"));
                            var component = spec.List("components").Cast<Dictionary<string, object>>().Single(c => c.Str("id") == target.Str("component"));
                            if (component.List("objects").Any(p => relative == p.ToString() || relative.StartsWith(p + "/"))) enabled &= AvatarConfig.On(toggle, "default");
                        }
                    expected[path] = expected.TryGetValue(path, out var before) && before || enabled;
                }
                var effectivePresets = File.Exists(Avh.Abs(LocalOperations.InputPath)) ? row.List("material_presets")
                    : VariantResolver.ExpectedMaterials(source, avatar.transform.Find(row.Str("object")).gameObject, avatar.transform);
                var sourceRequiresMaterials = source.GetComponentsInChildren<Renderer>(true)
                    .Any(renderer => renderer.sharedMaterials != null && renderer.sharedMaterials.Length > 0);
                if (on && sourceRequiresMaterials && effectivePresets.Count == 0) failures++;
                if (on) foreach (Dictionary<string, object> preset in effectivePresets)
                {
                    var actual = VariantResolver.MaterialTarget(avatar.transform, preset, useFind: true)?.GetComponent<Renderer>()?.sharedMaterials;
                    if (actual == null || actual.Length != preset.List("materials").Count || actual.Where((v, i) => Avh.Json(VariantResolver.Identity(v)) != Avh.Json(preset.List("materials")[i])).Any()) failures++;
                }
            }
            foreach (var pair in expected)
            {
                var t = avatar.transform.Find(pair.Key); var actual = t != null && t.gameObject.activeInHierarchy && (t.GetComponent<Renderer>() == null || t.GetComponent<Renderer>().enabled);
                if (actual != pair.Value) failures++;
            }
            if (failures > 0) notes.Add("装配默认业务状态不符：" + failures);
            return failures == 0;
        }

        // Expected membership comes from the authorized plan, never just the executor's record.
        // Locate also follows NDMF's reparented BoneProxy visuals on baked outputs.
        public static bool Visible(Dictionary<string, object> entry, Func<string, bool> visible)
        {
            var path = entry.Str("object");
            var relocated = RelocatedParts(entry);
            return visible(path) || OutfitStage.Fixed(entry) && entry.Obj("fixed_built_paths")?.Str(path) is string built && visible(built)
                || relocated.Count > 0 && entry.List("fixed_visuals").All(p => visible(entry.Obj("fixed_built_paths").Str(p.ToString())));
        }

        // A build can prune an empty source container after its default visuals were moved by BoneProxy.
        // Only recorded, fully relocated membership can substitute for that container; an arbitrary
        // missing root or an unmoved part cannot be certified by a similarly named object elsewhere.
        static List<string> RelocatedParts(Dictionary<string, object> entry)
        {
            if (!OutfitStage.Fixed(entry) || entry.List("fixed_visuals").Count == 0) return new List<string>();
            var parts = entry.List("fixed_visuals").Select(p => p.ToString()).ToList();
            var paths = entry.Obj("fixed_built_paths");
            if (parts.Count == 0 || parts.Any(p => paths?.Str(p) is not string mapped || mapped == p
                || mapped.StartsWith(entry.Str("object") + "/", StringComparison.Ordinal))) return new List<string>();
            return parts.Select(p => paths.Str(p)).Distinct().ToList();
        }

        /// <summary>
        /// D-138: deduct from each outfit's expected visible set exactly the parts this run closed with a
        /// recorded rationale, and list them under hidden_by_decision. Only closures strictly below an
        /// outfit root apply: closing the root itself still fails, because a fixed outfit must stay
        /// installed. Anything that disappears without a record is untouched and keeps failing.
        /// </summary>
        public static List<object> DeductRecordedClosures(List<object> records, List<Dictionary<string, object>> closures)
        {
            var hidden = new List<object>();
            if (records == null || closures == null || closures.Count == 0) return hidden;
            foreach (var value in records)
            {
                if (!(value is Dictionary<string, object> row)) continue;
                var root = row.Str("object");
                if (string.IsNullOrEmpty(root)) continue;
                var visuals = row.List("fixed_visuals").Select(x => x.ToString()).ToList();
                if (visuals.Count == 0) continue;
                var deducted = new List<object>();
                foreach (var closure in closures)
                {
                    var path = closure.Str("path");
                    if (string.IsNullOrEmpty(path) || !path.StartsWith(root + "/", StringComparison.Ordinal)) continue;
                    // A closure hides every listed visual at or below it, so a closed container covers its parts.
                    foreach (var visual in visuals.Where(v => v == path || v.StartsWith(path + "/", StringComparison.Ordinal)))
                        if (!deducted.Any(x => ((Dictionary<string, object>)x).Str("path") == visual))
                            deducted.Add(new Dictionary<string, object> { ["path"] = visual, ["operation"] = closure.Str("operation"),
                                ["rationale"] = closure.Str("rationale") });
                }
                if (deducted.Count == 0) continue;
                var closed = new HashSet<string>(deducted.Select(x => ((Dictionary<string, object>)x).Str("path")), StringComparer.Ordinal);
                row["fixed_visuals"] = visuals.Where(visual => !closed.Contains(visual)).Select(x => (object)x).ToList();
                row["hidden_by_decision"] = deducted;
                hidden.AddRange(deducted);
            }
            return hidden;
        }

        /// <summary>D-138: the closures the executor recorded, flattened out of a persisted assembly record.</summary>
        public static List<object> HiddenByDecision(Dictionary<string, object> record)
        {
            var hidden = new List<object>();
            foreach (var value in record?.List("outfits") ?? new List<object>())
                if (value is Dictionary<string, object> row) hidden.AddRange(row.List("hidden_by_decision"));
            return hidden;
        }

        public static int FixedFailures(GameObject avatar, Dictionary<string, object> record, Dictionary<string, object> plan,
            List<string> notes, Func<string, bool> visible = null, bool includeVisuals = true)
        {
            var failures = 0;
            foreach (var expected in plan.List("outfits").Cast<Dictionary<string, object>>().Where(OutfitStage.Fixed))
            {
                var entry = record?.List("outfits").Cast<Dictionary<string, object>>().SingleOrDefault(o => o.Str("id") == expected.Str("id"));
                if (entry == null || !OutfitStage.Fixed(entry) || Normalize(entry.Str("item")) != Normalize(expected.Str("item")) || Normalize(entry.Str("prefab")) != Normalize(expected.Str("prefab"))
                    || entry.Str("object") != $"{OutfitStage.Group}/Outfit_{expected.Str("id")}")
                { failures++; notes.Add($"固定件 {expected.Str("id")} 缺少与方案一致的装配记录"); continue; }
                var relocated = AvatarAudit.Locate(avatar.transform, entry.Str("object")) == null ? RelocatedParts(entry) : new List<string>();
                var required = relocated.Count > 0 ? relocated : new List<string> { entry.Str("object") };
                foreach (var path in required.Concat(includeVisuals
                    ? entry.List("fixed_visuals").Select(x => x.ToString()) : Enumerable.Empty<string>()).Distinct())
                {
                    var actualPath = path;
                    var target = string.IsNullOrEmpty(path) ? null : AvatarAudit.Locate(avatar.transform, path);
                    if (target == null && entry.Obj("fixed_built_paths")?.Str(path) is string builtPath)
                    { actualPath = builtPath; target = AvatarAudit.Locate(avatar.transform, builtPath); }
                    var active = target != null && target.gameObject.activeInHierarchy;
                    for (var t = target; t != null; t = t.parent) if (t.CompareTag("EditorOnly")) active = false;
                    if (target != null && (relocated.Count > 0 && !includeVisuals || (visible != null ? visible(actualPath) : active))) continue;
                    failures++; notes.Add($"固定件 {expected.Str("id")} 的 {path} 不存在或未激活");
                }
            }
            return failures;
        }

        /// <summary>Vendor BlendshapeSync silently does nothing when either the referenced or local key is absent.</summary>
        static int BlendshapeSyncMissingKeys(GameObject outfit, List<string> notes)
        {
            var missing = 0;
            foreach (var component in outfit.GetComponentsInChildren<ModularAvatarBlendshapeSync>(true))
            {
                var localRenderer = component.GetComponent<SkinnedMeshRenderer>();
                if (component.Bindings == null) { missing++; notes.Add("BlendshapeSync bindings absent: " + component.name); continue; }
                foreach (var binding in component.Bindings)
                {
                    var sourceKey = binding.Blendshape;
                    var localKey = string.IsNullOrWhiteSpace(binding.LocalBlendshape) ? sourceKey : binding.LocalBlendshape;
                    var referenceRenderer = binding.ReferenceMesh?.Get(component)?.GetComponent<SkinnedMeshRenderer>();
                    var sourceOk = !string.IsNullOrWhiteSpace(sourceKey) && referenceRenderer?.sharedMesh?.GetBlendShapeIndex(sourceKey) >= 0;
                    var localOk = !string.IsNullOrWhiteSpace(localKey) && localRenderer?.sharedMesh?.GetBlendShapeIndex(localKey) >= 0;
                    if (sourceOk && localOk) continue;
                    missing++;
                    notes.Add($"{outfit.name}: BlendshapeSync {sourceKey}->{localKey} invalid (reference={sourceOk}, local={localOk})");
                }
            }
            return missing;
        }

        /// <summary>
        /// D-139 ② readback: every same-name key the assembled artifact binds to the body. Measured on the
        /// instantiated prefab — a binding only counts when the referenced body renderer carries the source
        /// key and the garment carries the local key, which is what MA needs for the sync to take effect —
        /// and compared against what the assembly record declared, so a claim that did not persist is
        /// reported instead of assumed.
        /// </summary>
        static int BlendshapeSyncFollow(GameObject avatar, Dictionary<string, object> record, List<string> notes)
        {
            var declared = new HashSet<string>(StringComparer.Ordinal);
            foreach (Dictionary<string, object> row in record.List("outfits"))
                foreach (Dictionary<string, object> added in (row.Obj("blendshape_sync")?.List("added") ?? new List<object>()).Cast<Dictionary<string, object>>())
                    declared.Add(added.Str("renderer") + "|" + added.Str("key") + "|" + added.Str("reference_mesh"));
            var measured = new HashSet<string>(StringComparer.Ordinal);
            foreach (var renderer in avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true))
            {
                if (renderer.sharedMesh == null) continue;
                var path = Probe.HierarchyPath(avatar.transform, renderer.transform);
                if (!path.StartsWith(OutfitStage.Group + "/", StringComparison.Ordinal)) continue;
                foreach (var component in renderer.GetComponents<ModularAvatarBlendshapeSync>())
                {
                    if (component.Bindings == null) continue;
                    foreach (var binding in component.Bindings)
                    {
                        var local = string.IsNullOrWhiteSpace(binding.LocalBlendshape) ? binding.Blendshape : binding.LocalBlendshape;
                        var reference = binding.ReferenceMesh?.Get(component)?.GetComponent<SkinnedMeshRenderer>();
                        if (reference?.sharedMesh == null || string.IsNullOrWhiteSpace(local)) continue;
                        if (reference.sharedMesh.GetBlendShapeIndex(binding.Blendshape) < 0) continue;
                        if (renderer.sharedMesh.GetBlendShapeIndex(local) < 0) continue;
                        var source = Probe.HierarchyPath(avatar.transform, reference.transform);
                        if (measured.Add(path + "|" + local + "|" + source)) notes.Add($"形态键跟随：{path} 的 {local} 跟随 {source}");
                    }
                }
            }
            foreach (var token in declared) if (!measured.Contains(token)) notes.Add($"装配记录声明补了形态键同步，产物里却没有：{token.Replace("|", " ")}");
            return measured.Count;
        }

        // Check every selectable instance, including default-off members. Activation is a menu state,
        // not permission to skip compatibility. Extra dynamic chains may follow a mapped ancestor;
        // bones that name an existing body bone must map at the actual hierarchy level.
        // MA resolves every BoneProxy before moving any of them, then reparents them in avatar
        // hierarchy order. Model that effective parent relation over the whole avatar so a cycle
        // spanning outfits cannot disappear when each outfit is measured in isolation.
        static Dictionary<Transform, string> ProxyFailures(GameObject avatar)
        {
            bool Included(Transform t) => t != null && !t.GetComponentsInParent<Transform>(true).Any(p => p.CompareTag("EditorOnly"));
            bool AvatarTarget(Transform t) => Included(t) && (t == avatar.transform || t.IsChildOf(avatar.transform));
            var proxies = avatar.GetComponentsInChildren<ModularAvatarBoneProxy>(true).Where(p => Included(p.transform)).ToList();
            var targets = proxies.ToDictionary(p => p.transform, p => ResolveProxy(avatar, p));
            var failures = new Dictionary<Transform, string>();
            foreach (var proxy in proxies)
            {
                var target = targets[proxy.transform];
                if (!AvatarTarget(target)) failures[proxy.transform] = "刚性挂点无法解析到头像(" + (proxy.subPath ?? "") + ")：";
                else if (target == proxy.transform || target.IsChildOf(proxy.transform)) failures[proxy.transform] = "刚性挂点重挂目标是自身或子孙：";
            }

            Transform EffectiveParent(Transform node) => targets.TryGetValue(node, out var target) && target != null ? target : node.parent;
            bool HasCycle(Transform start)
            {
                var seen = new HashSet<Transform>();
                for (var node = start; node != null && node != avatar.transform; node = EffectiveParent(node))
                    if (!seen.Add(node)) return true;
                return false;
            }
            foreach (var proxy in proxies)
                if (!failures.ContainsKey(proxy.transform) && HasCycle(proxy.transform))
                    failures[proxy.transform] = "刚性挂点重挂关系形成环：";
            return failures;
        }

        public static int AssemblyFailures(GameObject avatar, GameObject outfit, Dictionary<string, object> entry, List<string> notes,
            Dictionary<Transform, string> proxyFailures = null)
        {
            bool Included(Transform t) => t != null && !t.GetComponentsInParent<Transform>(true).Any(p => p.CompareTag("EditorOnly"));
            bool BodyTarget(Transform t) => Included(t) && (t == avatar.transform || t.IsChildOf(avatar.transform))
                && t != outfit.transform && !t.IsChildOf(outfit.transform);
            bool AvatarTarget(Transform t) => Included(t) && (t == avatar.transform || t.IsChildOf(avatar.transform));
            var failures = 0;
            void Fail(string text) { failures++; notes.Add(entry.Str("id") + "：" + text); }
            foreach (var merge in outfit.GetComponentsInChildren<ModularAvatarMergeArmature>(true).Where(m => Included(m.transform)))
            {
                var target = merge.mergeTarget?.Get(merge)?.transform;
                if (!BodyTarget(target)) { Fail("合骨目标无法解析到素体"); continue; }
                var map = new Dictionary<Transform, Transform>();
                Walk(merge.transform, target, merge.prefix ?? "", merge.suffix ?? "", map);
                var used = outfit.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(r => Included(r.transform))
                    .SelectMany(r => r.bones).Where(b => b == null || b.IsChildOf(merge.transform)).Distinct().ToList();
                if (used.Any(b => b != merge.transform) && map.Count == 0) Fail("蒙皮骨架没有实际映射");
                foreach (var bone in used)
                {
                    if (bone == null) { Fail("蒙皮骨槽为空"); continue; }
                    var name = bone.name; var prefix = merge.prefix ?? ""; var suffix = merge.suffix ?? "";
                    var normalized = name.StartsWith(prefix) && name.EndsWith(suffix) && name.Length >= prefix.Length + suffix.Length
                        ? name.Substring(prefix.Length, name.Length - prefix.Length - suffix.Length) : name;
                    // A mapping is only required where MergeArmature can put this bone: the walk descends solely
                    // through bones it already matched, so a bone under an unmatched level has no counterpart to
                    // merge onto and MA keeps it under its own parent. Reading every same-named bone in the whole
                    // target subtree demanded a mapping for garment bones that merely share a name with a body
                    // bone at another depth, which MA never merges (D-115).
                    if (bone != merge.transform && !map.ContainsKey(bone)
                        && LevelHoldsName(bone.parent, merge.transform, target, normalized, map))
                        Fail("蒙皮骨未按真实层级映射：" + name);
                }
            }
            // A vendor proxy may intentionally target another object in the same outfit (for example a
            // constraint target). MA accepts any resolved target inside the avatar, but the whole-avatar
            // effective parent check rejects self, descendant, and cross-outfit cycles.
            proxyFailures = proxyFailures ?? ProxyFailures(avatar);
            foreach (var proxy in outfit.GetComponentsInChildren<ModularAvatarBoneProxy>(true).Where(p => Included(p.transform)))
                if (proxyFailures.TryGetValue(proxy.transform, out var reason)) Fail(reason + proxy.name);
            var mounts = entry.Obj("mount") != null ? new[] { entry.Obj("mount") } : entry.List("mounts").Cast<Dictionary<string, object>>();
            foreach (var mount in mounts)
            {
                var source = string.IsNullOrEmpty(mount.Str("source")) ? outfit.transform : AvatarAudit.Locate(outfit.transform, mount.Str("source"));
                var target = AvatarAudit.Locate(avatar.transform, mount.Str("path"));
                var proxy = source == null ? null : source.GetComponent<ModularAvatarBoneProxy>();
                if (source == null || !BodyTarget(target) || ResolveProxy(avatar, proxy) != target || proxy.attachmentMode != BoneProxyAttachmentMode.AsChildKeepWorldPose) { Fail("挂点与配方不符"); continue; }
                if (mount.Str("pose") != "preserve")
                {
                    var p = mount.List("position").Select(Convert.ToSingle).ToArray(); var r = mount.List("rotation").Select(Convert.ToSingle).ToArray();
                    var position = new Vector3(p.Length == 3 ? p[0] : 0, p.Length == 3 ? p[1] : 0, p.Length == 3 ? p[2] : 0);
                    var rotation = Quaternion.Euler(r.Length == 3 ? r[0] : 0, r.Length == 3 ? r[1] : 0, r.Length == 3 ? r[2] : 0);
                    if (Vector3.Distance(source.position, target.TransformPoint(position)) > .00001f || Quaternion.Angle(source.rotation, target.rotation * rotation) > .001f) Fail("挂点姿态与配方不符");
                }
            }
            return failures;
        }

        // Resolve the serialized MA fields against this exact avatar rather than a transient editor cache.
        // MA 1.18.1 uses the same boneReference/subPath branches in UpdateDynamicMapping.
        public static Transform ResolveProxy(GameObject avatar, ModularAvatarBoneProxy proxy)
        {
            if (avatar == null || proxy == null) return null;
            if (proxy.subPath == "$$AVATAR") return avatar.transform;
            if (proxy.boneReference == HumanBodyBones.LastBone)
                return string.IsNullOrWhiteSpace(proxy.subPath) ? null : avatar.transform.Find(proxy.subPath);
            var animator = avatar.GetComponent<Animator>();
            if (animator == null || !animator.isHuman) return null;
            var bone = animator.GetBoneTransform(proxy.boneReference);
            return bone == null || string.IsNullOrWhiteSpace(proxy.subPath) ? bone : bone.Find(proxy.subPath);
        }

        /// <summary>Outfit bone -> body bone, the way MA MergeArmature maps them (name minus prefix/suffix, level by level).</summary>
        public static Dictionary<Transform, Transform> MappedBones(GameObject outfit)
        {
            var map = new Dictionary<Transform, Transform>();
            foreach (var merge in outfit.GetComponentsInChildren<ModularAvatarMergeArmature>(true))
            {
                if (ExcludedFromBuild(merge.transform)) continue;
                var target = merge.mergeTarget != null ? merge.mergeTarget.Get(merge) : null;
                if (target == null) continue;
                Walk(merge.transform, target.transform, merge.prefix ?? "", merge.suffix ?? "", map);
            }
            foreach (var proxy in outfit.GetComponentsInChildren<ModularAvatarBoneProxy>(true))
                if (!ExcludedFromBuild(proxy.transform) && proxy.target != null) map[proxy.transform] = proxy.target;
            return map;
        }

        /// <summary>
        /// An object the build drops. HideBodyClothing turns off every path named in the plan's
        /// hide_body_parts and tags it EditorOnly, so VRChat strips the whole branch at build time and no
        /// vendor layer can bring it back; the object is simply not part of the delivered avatar.
        /// Measuring such a branch would demand bone coverage for geometry that will never ship, which is
        /// the same mistake as requiring Head and Hands of a shoe. Inactive covers Unity's own disabled
        /// state; EditorOnly covers the branch we deliberately excluded.
        /// </summary>
        public static bool ExcludedFromBuild(Transform transform) =>
            transform == null || !transform.gameObject.activeInHierarchy || transform.gameObject.CompareTag("EditorOnly");


        /// <summary>
        /// Only bones actually declared by this outfit are required. A shoe is not missing Head/Hands merely because it never contained them.
        /// Prefix/suffix normalization follows the same MergeArmature rule used by MappedBones.
        /// </summary>
        public static List<string> MissingHumanoidTrunkBones(GameObject outfit, Animator animator, Dictionary<Transform, Transform> mapped)
        {
            if (animator == null || !animator.isHuman) return new List<string>();
            var bodyNames = new HashSet<string>(Trunk.Select(b => animator.GetBoneTransform(b)).Where(t => t != null).Select(t => t.name));
            var missing = new HashSet<string>();
            foreach (var merge in outfit.GetComponentsInChildren<ModularAvatarMergeArmature>(true))
                foreach (var bone in merge.GetComponentsInChildren<Transform>(true))
                {
                    var name = bone.name; var prefix = merge.prefix ?? ""; var suffix = merge.suffix ?? "";
                    if (!name.StartsWith(prefix) || !name.EndsWith(suffix) || name.Length <= prefix.Length + suffix.Length) continue;
                    var normalized = name.Substring(prefix.Length, name.Length - prefix.Length - suffix.Length);
                    if (bodyNames.Contains(normalized) && !mapped.ContainsKey(bone)) missing.Add(normalized);
                }
            return missing.OrderBy(name => name).ToList();
        }

        /// <summary>
        /// Props that carry a BoneProxy with no mount point at all. NDMF reparents a proxy to its target bone,
        /// so an unconfigured proxy leaves the prop where it is; it is not a bone that failed to map onto the
        /// body, and counting it as one both misnames the reading and lets a prop block the whole assembly
        /// stage. Reported separately so a missing mount point can be judged on its own terms.
        ///
        /// The reading is MA's own configured/unconfigured split, not a resolved transform: Modular Avatar
        /// 1.18.1 resolves a mount from `boneReference` and `subPath`, and only returns null up front when
        /// both are empty (package `nadena.dev.modular-avatar` 1.18.1, Runtime/ModularAvatarBoneProxy.cs:
        /// 182-208). `target` is a derived, non-serialized property of that resolution, so in batch mode it
        /// stays null for a proxy whose mount is configured but whose humanoid bones cannot be resolved here.
        /// Using it reported correctly configured props as unmounted (D-51). A proxy that names either
        /// serialized field is configured.
        /// </summary>
        public static List<string> UnmountedBoneProxies(GameObject outfit)
        {
            var unmounted = new HashSet<string>();
            foreach (var proxy in outfit.GetComponentsInChildren<ModularAvatarBoneProxy>(true))
                // An object tagged for build removal will not exist in the delivered avatar, so it cannot be a mount
                // point that is missing from it. Counting it here would let a prop that was deliberately excluded stop
                // the stage, which is the outcome this method was split out to avoid. The predicate matches the one the
                // audit already uses for the same tag.
                if (!HasMountPoint(proxy) && proxy.gameObject.tag != "EditorOnly") unmounted.Add($"BoneProxy:{proxy.name}");
            return unmounted.OrderBy(name => name).ToList();
        }

        /// <summary>
        /// Whether a BoneProxy names a mount point at all, independent of whether this session can resolve it.
        /// This mirrors the guard MA itself applies before resolving (`boneReference` empty and `subPath` blank
        /// is MA's only "nothing configured" case); MA exposes no public predicate for it.
        /// </summary>
        public static bool HasMountPoint(ModularAvatarBoneProxy proxy) =>
            proxy != null && (proxy.boneReference != HumanBodyBones.LastBone || !string.IsNullOrWhiteSpace(proxy.subPath));

        /// <summary>
        /// Registered products the plan neither mounts nor declares unused, as (item, role, reason).
        ///
        /// The intake inventory is the record of what the person handed over, and more than one outcome is
        /// legitimate for each entry: mounted as the body or as an outfit, kept as a component of another
        /// package rather than mounted on its own, or declared unused with a reason. Anything else means a
        /// product the person registered never reached a decision, which is what the per-item checks cannot
        /// see because they only ever ask about what the plan already names.
        /// </summary>
        public static List<(string item, string role, string reason)> UncoveredInputs(
            Dictionary<string, object> record, Dictionary<string, object> plan)
        {
            var inventory = Avh.ReadJsonFile(Avh.Abs("_harness/intake/inventory.json"));
            if (inventory == null) return new List<(string, string, string)>();
            // Identity, never name. Two vendors can both ship Hair.unitypackage and a version pair can both
            // unpack to Dress.unitypackage, so matching by file name would let one registration discharge
            // another's obligation. Only an exact resolved path counts.
            var covered = new HashSet<string>();
            foreach (var entry in record.List("outfits").Cast<Dictionary<string, object>>())
            {
                covered.Add(Normalize(entry.Str("item")));
                covered.Add(Normalize(entry.Str("prefab")));
                // An outfit may be installed from the same package under another member path.
                covered.Add(Normalize(entry.Str("package")));
            }
            foreach (var entry in plan.List("outfits").Cast<Dictionary<string, object>>())
            {
                covered.Add(Normalize(entry.Str("item")));
                covered.Add(Normalize(entry.Str("prefab")));
            }
            foreach (var entry in plan.List("unused").Cast<Dictionary<string, object>>())
                covered.Add(Normalize(entry.Str("item")));
            // A disposition the plan declared is a decision about the input, whether it mounts it here,
            // excludes it, or defers the work. Whether a `use` actually happened is a separate question,
            // and UnmetObligations answers that one against the artifact.
            foreach (var entry in Obligations(plan))
                covered.Add(Normalize(entry.Str("input")));
            // A package only listed as a dependency is not thereby used: nothing references it, so it was
            // not installed on the avatar. Both independent reviews of this check raised that case, and
            // counting it would hide exactly the omission the check exists to find.
            covered.RemoveWhere(x => string.IsNullOrEmpty(x));

            var missing = new List<(string, string, string)>();
            foreach (var item in inventory.List("items").Cast<Dictionary<string, object>>())
            {
                var path = item.Str("item");
                var role = item.Str("role");
                if (string.IsNullOrEmpty(path)) continue;
                if (covered.Contains(Normalize(path))) continue;
                // The body is the one input whose registered form is a package that production resolves into
                // a prefab elsewhere, so its paths legitimately differ and no identity link is recorded yet.
                // Its resolution is recorded as the body_prefab of the plan or the assembled record, and
                // either one existing is what disposes it.
                if (role == "body")
                {
                    if (!string.IsNullOrEmpty(record.Str("body_prefab"))) continue;
                    if (!string.IsNullOrEmpty(plan.Str("body_prefab"))) continue;
                }
                missing.Add((path, role, "方案里既没有装它、也没有写不用的原因"));
            }
            return missing;
        }

        /// <summary>
        /// Comparable form of a path: separators unified, Unicode composed and case folded.
        ///
        /// A registered path and the plan can spell the same input in different normalization forms — a
        /// Japanese folder extracted from a macOS-made zip is NFD (`か`+U+3099) where a typed or pasted
        /// path is NFC (`が`) — and NTFS and ext4 keep the two as different names. Identity is compared in
        /// one form so one input is not counted as two; the paths themselves are never rewritten.
        /// </summary>
        static string Normalize(string path) =>
            string.IsNullOrEmpty(path) ? "" : path.Replace('\\', '/').TrimEnd('/').Normalize(System.Text.NormalizationForm.FormC).ToLowerInvariant();

        /// <summary>One declaration per registered input, read from the plan's obligations list.</summary>
        public static List<Dictionary<string, object>> Obligations(Dictionary<string, object> plan) =>
            plan.List("obligations").Cast<Dictionary<string, object>>().ToList();

        /// <summary>Obligations whose due stage is the given one and which require the artifact to show a result.</summary>
        public static List<Dictionary<string, object>> ObligationsDueHere(Dictionary<string, object> plan, string stage) =>
            Obligations(plan).Where(o => o.Str("due_stage") == stage && o.Str("action") == "use").ToList();

        /// <summary>A metric name that identifies one obligation without colliding with another.</summary>
        public static string ObligationMetric(Dictionary<string, object> obligation) =>
            "obligation_" + SafeToken(obligation.Str("input"));

        static string SafeToken(string text)
        {
            var builder = new System.Text.StringBuilder();
            foreach (var c in text) builder.Append(char.IsLetterOrDigit(c) ? c : '_');
            var value = builder.ToString().Trim('_');
            return value.Length <= 40 ? value : value.Substring(value.Length - 40);
        }

        /// <summary>
        /// Obligations due at this stage whose postcondition the artifact does not satisfy.
        ///
        /// The postcondition is read from the assembled avatar, never from the record: the record is the
        /// assembler's own account, so trusting it would let an assembler that skipped a step also declare
        /// success. What counts as satisfied depends on the action, and only `use` is checked here, because
        /// `exclude` and `defer` are dispositions rather than work this stage owes.
        /// </summary>
        public static List<Dictionary<string, object>> UnmetObligations(
            GameObject avatar, Dictionary<string, object> record, Dictionary<string, object> plan)
        {
            // The only part that needs Unity is asking whether an object path exists in the assembled
            // prefab; the decision itself is pure so that it can be exercised directly.
            return UnmetObligations(record, plan,
                path => avatar != null && !string.IsNullOrEmpty(path) && avatar.transform.Find(path) is Transform target
                    && !target.GetComponentsInParent<Transform>(true).Any(t => t.CompareTag("EditorOnly")));
        }

        /// <summary>
        /// The decision, with artifact lookup supplied by the caller.
        ///
        /// Kept free of Unity types so the rule can be tested by execution rather than by reading its text,
        /// which is the only way to show that a satisfied promise is not reported and an unsatisfied one is.
        /// </summary>
        public static List<Dictionary<string, object>> UnmetObligations(
            Dictionary<string, object> record, Dictionary<string, object> plan, Func<string, bool> objectExists)
        {
            var obligations = Obligations(plan);
            var unmet = new List<Dictionary<string, object>>();
            foreach (var obligation in ObligationsDueHere(plan, "outfit"))
            {
                if (SatisfiedInArtifact(record, obligations, obligation, objectExists)) continue;
                unmet.Add(obligation);
            }
            return unmet;
        }

        /// <summary>The declaration for one registered input, looked up by identity rather than by name.</summary>
        static Dictionary<string, object> ObligationFor(List<Dictionary<string, object>> obligations, string input) =>
            obligations.FirstOrDefault(candidate => Normalize(candidate.Str("input")) == input);

        /// <summary>
        /// Whether the artifact contains the result the obligation promised.
        ///
        /// A product declared as an outfit must appear as an outfit root that the assembled avatar actually
        /// holds, chosen by the identity recorded for it rather than by any name: two vendors can ship the
        /// same file name, so a name match would let one registration discharge another's obligation. The
        /// record says what to look for and where; whether it is there comes from the artifact.
        ///
        /// A texture dependency retains an explicit carrier. Installation inputs (including other)
        /// must prove their own instance; merely naming the body does not prove installation.
        /// </summary>
        static bool SatisfiedInArtifact(
            Dictionary<string, object> record, List<Dictionary<string, object>> obligations,
            Dictionary<string, object> obligation, Func<string, bool> objectExists)
        {
            var input = Normalize(obligation.Str("input"));
            if (string.IsNullOrEmpty(input)) return false;
            var role = obligation.Str("role");
            // Mounted inputs prove their own artifact in every schema; only unmounted texture dependencies use a carrier.
            var mounted = record.List("outfits").Cast<Dictionary<string, object>>().Where(e => Normalize(e.Str("item")) == input).ToList();
            if (role == "body") return !string.IsNullOrEmpty(record.Str("body_prefab"));
            if (mounted.Count > 0) return mounted.All(e => objectExists(e.Str("object")));
            if (role == "texture")
            {
                var carrier = ObligationFor(obligations, Normalize(obligation.Str("target")));
                if (carrier == null || carrier.Str("action") != "use") return false;
                if (carrier.Str("role") != "body" && carrier.Str("role") != "outfit" && carrier.Str("role") != "other") return false;
                return SatisfiedInArtifact(record, obligations, carrier, objectExists);
            }
            // The record never names this product, so nothing about the artifact can discharge it.
            return false;
        }

        static void Walk(Transform outfitBone, Transform bodyBone, string prefix, string suffix, Dictionary<Transform, Transform> map)
        {
            foreach (Transform child in outfitBone)
            {
                var name = child.name;
                if (!name.StartsWith(prefix) || !name.EndsWith(suffix) || name.Length == prefix.Length + suffix.Length) continue;
                var match = bodyBone.Find(name.Substring(prefix.Length, name.Length - prefix.Length - suffix.Length));
                if (match == null) continue;
                map[child] = match;
                Walk(child, match, prefix, suffix, map);
            }
        }

        /// <summary>
        /// Whether <paramref name="normalized"/> exists as a direct child of the body bone that corresponds to
        /// <paramref name="parent"/> -- the merge root itself corresponding to the merge target. Neither
        /// MergeArmature's `MapBone` nor its merge walk leaves the level of an ancestor it could not match
        /// (Modular Avatar 1.18.1, `Runtime/ModularAvatarMergeArmature.cs:77-102` and
        /// `Editor/MergeArmatureHook.cs:469-527`), so a bone below such an ancestor has no corresponding level
        /// and cannot be required to map.
        /// </summary>
        static bool LevelHoldsName(Transform parent, Transform mergeRoot, Transform target, string normalized,
            Dictionary<Transform, Transform> map)
        {
            if (parent == null) return false;
            Transform level;
            if (parent == mergeRoot) level = target;
            else if (!map.TryGetValue(parent, out level)) return false;
            return level != null && level.Find(normalized) != null;
        }

        /// <summary>SOP 50 步骤 4：厂商动画里打在素体网格上、值不为 0 的 blendShape 曲线条数。</summary>
        static int BodyBlendShapeCurves(GameObject avatar, GameObject outfit, List<string> notes)
        {
            var count = 0;
            foreach (var merge in outfit.GetComponentsInChildren<ModularAvatarMergeAnimator>(true))
            {
                if (!(merge.animator is AnimatorController controller)) continue;
                var root = OutfitStage.MergeRoot(avatar, merge);
                foreach (var clip in controller.animationClips.Distinct())
                    foreach (var binding in AnimationUtility.GetCurveBindings(clip))
                    {
                        if (binding.type != typeof(SkinnedMeshRenderer) || !binding.propertyName.StartsWith("blendShape.")) continue;
                        var target = root.Find(binding.path);
                        if (target == null || target.IsChildOf(outfit.transform)) continue;
                        var curve = AnimationUtility.GetEditorCurve(clip, binding);
                        if (curve == null || curve.keys.All(k => Mathf.Approximately(k.value, 0))) continue;
                        count++;
                        if (count <= 5) notes.Add($"{clip.name}：{binding.path}.{binding.propertyName} 非零");
                    }
            }
            return count;
        }
    }
}
