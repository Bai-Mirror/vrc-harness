// Frozen, task-scoped domain operations. No arbitrary code, paths or host commands are accepted.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;

namespace AVH.Harness
{
    public static class LocalOperations
    {
        public const string ObservationPath = "_harness/setup/object-observation.json";
        public const string InputPath = "Assets/_Harness/Outfit/local-operations.json";
        public const string OutputPath = "Assets/_Harness/Outfit/local-operation-receipt.json";
        static readonly Regex Id = new Regex("^[a-z][a-z0-9_-]{0,31}$");
        static readonly Regex FootShape = new Regex("foot|toe|ankle|heel|足|脚|踝|爪", RegexOptions.IgnoreCase);
        static Dictionary<string, object> Map(object value) => value as Dictionary<string, object> ?? throw new Exception("局部操作对象格式错误");
        static string Text(Dictionary<string, object> value, string key) => value.Str(key) ?? throw new Exception($"局部操作缺少 {key}");
        public static string Digest(string text) { using var sha = SHA256.Create(); return string.Concat(sha.ComputeHash(Encoding.UTF8.GetBytes(text)).Select(b => b.ToString("x2"))); }
        static string AssetHash(string path)
        {
            using var sha = SHA256.Create();
            string FileHash(string relative)
            {
                var file = Avh.Abs(relative); if (!File.Exists(file)) return "absent";
                using var stream = File.OpenRead(file); return string.Concat(sha.ComputeHash(stream).Select(b => b.ToString("x2")));
            }
            return Digest(AssetDatabase.GetAssetDependencyHash(path) + ":" + FileHash(path) + ":" + FileHash(path + ".meta"));
        }
        static string PathOf(Transform root, Transform child) => AnimationUtility.CalculateTransformPath(child, root);
        static object Vec(Vector3 v) => new object[] { Math.Round(v.x, 6), Math.Round(v.y, 6), Math.Round(v.z, 6) };
        static double Number(object value) { if (value == null || value is bool || value is string) throw new Exception("局部操作数值必须为数字"); var n = Convert.ToDouble(value); if (double.IsNaN(n) || double.IsInfinity(n)) throw new Exception("局部操作数值必须有限"); return n; }
        static int Integer(object value) { var n = Number(value); if (n < 0 || n > int.MaxValue || Math.Truncate(n) != n) throw new Exception("局部操作索引必须为非负整数"); return (int)n; }
        static float Float(object value) { var n = Number(value); if (Math.Abs(n) > 1e6) throw new Exception("局部操作数值超出范围"); return (float)n; }
        static float[] Numbers(object value, int count)
        {
            var values = value as List<object> ?? throw new Exception("局部操作数值应为数组");
            if (values.Count != count) throw new Exception($"局部操作需要 {count} 个数值");
            return values.Select(Float).ToArray();
        }
        static Transform Target(GameObject avatar, string path, bool root = false)
        {
            if (path.Contains("\\") || path.Split('/').Any(p => p == "." || p == "..") || path.StartsWith("/") || (!root && path.Length == 0))
                throw new Exception("局部操作对象路径非法或指向头像根");
            return path.Length == 0 ? avatar.transform : avatar.transform.Find(path) ?? throw new Exception($"局部操作对象不存在：{path}");
        }
        static Renderer RendererAt(GameObject avatar, Dictionary<string, object> op)
        {
            var candidates = Target(avatar, Text(op, "path"), true).GetComponents<Renderer>();
            var index = Integer(op["renderer_index"]);
            if (index < 0 || index >= candidates.Length) throw new Exception("局部操作 renderer_index 不存在");
            return candidates[index];
        }
        static int Slot(Renderer renderer, Dictionary<string, object> op)
        {
            var slot = Integer(op["slot"]);
            if (slot < 0 || slot >= renderer.sharedMaterials.Length)
                throw new Exception("局部操作材质槽不存在");
            return slot;
        }
        static object Properties(Material material)
        {
            var properties = new Dictionary<string, object>();
            for (var i = 0; material.shader != null && i < ShaderUtil.GetPropertyCount(material.shader); i++)
            {
                var key = ShaderUtil.GetPropertyName(material.shader, i); var type = ShaderUtil.GetPropertyType(material.shader, i);
                object value = type == ShaderUtil.ShaderPropertyType.Color ? (object)new object[] { material.GetColor(key).r, material.GetColor(key).g, material.GetColor(key).b, material.GetColor(key).a }
                    : type == ShaderUtil.ShaderPropertyType.Vector ? (object)new object[] { material.GetVector(key).x, material.GetVector(key).y, material.GetVector(key).z, material.GetVector(key).w }
                    : type == ShaderUtil.ShaderPropertyType.TexEnv ? (object)new Dictionary<string, object>
                    { ["path"] = AssetDatabase.GetAssetPath(material.GetTexture(key)), ["scale"] = new object[] { material.GetTextureScale(key).x, material.GetTextureScale(key).y },
                        ["offset"] = new object[] { material.GetTextureOffset(key).x, material.GetTextureOffset(key).y } } : material.GetFloat(key);
                properties[key] = new Dictionary<string, object> { ["type"] = type.ToString(), ["value"] = value };
            }
            return properties;
        }
        static object ComponentState(Component component, Transform root)
        {
            if (component == null) return null;
            var values = new Dictionary<string, object>(); var property = new SerializedObject(component).GetIterator(); var count = 0; var enter = true;
            while (property.Next(enter))
            {
                enter = property.propertyType == SerializedPropertyType.Generic;
                if (++count > 32768) throw new Exception("局部操作组件观察超过 32768 字段");
                var path = property.propertyPath;
                if (path.StartsWith("m_CorrespondingSourceObject") || path.StartsWith("m_PrefabInstance") || path.StartsWith("m_PrefabAsset")
                    || path.StartsWith("m_LocalEulerAnglesHint") || path == "m_RootOrder" || path.StartsWith("m_Materials")) { enter = false; continue; }
                object value;
                switch (property.propertyType)
                {
                    case SerializedPropertyType.Boolean: value = property.boolValue; break;
                    case SerializedPropertyType.Integer: case SerializedPropertyType.ArraySize: case SerializedPropertyType.Enum: value = property.intValue; break;
                    case SerializedPropertyType.Float: value = Math.Round(property.doubleValue, 6); break;
                    case SerializedPropertyType.String: value = property.stringValue; break;
                    case SerializedPropertyType.Color: var c = property.colorValue; value = new object[] { c.r, c.g, c.b, c.a }; break;
                    case SerializedPropertyType.Vector2: var v2 = property.vector2Value; value = new object[] { v2.x, v2.y }; break;
                    case SerializedPropertyType.Vector3: value = Vec(property.vector3Value); break;
                    case SerializedPropertyType.Vector4: var v4 = property.vector4Value; value = new object[] { v4.x, v4.y, v4.z, v4.w }; break;
                    case SerializedPropertyType.Quaternion: var q = property.quaternionValue; value = new object[] { Math.Round(q.x, 6), Math.Round(q.y, 6), Math.Round(q.z, 6), Math.Round(q.w, 6) }; break;
                    case SerializedPropertyType.ObjectReference:
                        var reference = property.objectReferenceValue;
                        var transform = reference is GameObject go ? go.transform : (reference as Component)?.transform;
                        if (transform != null && (transform == root || transform.IsChildOf(root)))
                        {
                            var index = reference is Component owned ? Array.IndexOf(transform.GetComponents<Component>(), owned) : -1;
                            value = "object:" + PathOf(root, transform) + ":" + index;
                        }
                        else if (reference != null && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(reference, out string guid, out long localId)) value = "asset:" + guid + ":" + localId;
                        else value = reference == null ? null : "unsupported:" + reference.GetType().FullName;
                        break;
                    default: continue;
                }
                values[path] = value;
            }
            return values;
        }
        public static List<object> Describe(GameObject avatar, bool detailed = false)
        {
            return avatar.GetComponentsInChildren<Transform>(true).Select(t => (object)new Dictionary<string, object>
            {
                ["path"] = PathOf(avatar.transform, t), ["position"] = Vec(t.localPosition), ["rotation"] = Vec(t.localEulerAngles), ["scale"] = Vec(t.localScale),
                ["active"] = t.gameObject.activeSelf, ["tag"] = t.gameObject.tag,
                ["source_prefab"] = AssetDatabase.GetAssetPath(PrefabUtility.GetCorrespondingObjectFromOriginalSource(t.gameObject)),
                ["components"] = t.GetComponents<Component>().Select(c => c == null ? "missing" : c.GetType().FullName).ToList(),
                ["component_state"] = detailed ? t.GetComponents<Component>().Select(c => ComponentState(c, avatar.transform)).ToList() : null,
                ["renderers"] = t.GetComponents<Renderer>().Select((r, i) => (object)new Dictionary<string, object>
                {
                    ["renderer_index"] = i, ["type"] = r.GetType().FullName,
                    ["mesh"] = AssetDatabase.GetAssetPath(r is SkinnedMeshRenderer skin ? skin.sharedMesh : r.GetComponent<MeshFilter>()?.sharedMesh),
                    ["bones"] = r is SkinnedMeshRenderer skinned ? skinned.bones.Select(b => b == null ? null : PathOf(avatar.transform, b)).ToList() : null,
                    ["root_bone"] = r is SkinnedMeshRenderer mesh && mesh.rootBone != null ? PathOf(avatar.transform, mesh.rootBone) : null,
                    ["slots"] = r.sharedMaterials.Select((m, slot) => (object)new Dictionary<string, object>
                    { ["slot"] = slot, ["material"] = AssetDatabase.GetAssetPath(m), ["properties"] = m == null ? null : Properties(m),
                        ["shader"] = m == null ? null : AssetDatabase.GetAssetPath(m.shader), ["keywords"] = m == null ? null : m.shaderKeywords.OrderBy(k => k).ToArray(),
                        ["render_queue"] = m == null ? 0 : m.renderQueue, ["instancing"] = m != null && m.enableInstancing,
                        ["double_sided_gi"] = m != null && m.doubleSidedGI, ["gi_flags"] = m == null ? 0 : (int)m.globalIlluminationFlags }).ToList(),
                }).ToList(),
            }).ToList();
        }
        public static void Observe(GameObject body, Dictionary<string, object> plan)
        {
            var manifest = Map(Avh.ParseJson(Avh.Env("AVH_MANIFEST", "{}")));
            var approved = new HashSet<string>(manifest.List("assets").Select(a => Map(a).Str("item")));
            var import = Avh.ReadJsonFile(Avh.Abs("_harness/setup/import.json")) ?? throw new Exception("局部操作观察缺少导入报告");
            var roots = import.List("packages").Select(Map).Where(p => approved.Contains(p.Str("item")))
                .SelectMany(p => p.List("roots").Select(r => r.ToString())).Where(r => r.StartsWith("Assets/") && AssetDatabase.IsValidFolder(r)).Distinct().ToArray();
            var paths = roots.Length == 0 ? new string[0] : AssetDatabase.FindAssets("t:Prefab t:Model t:Texture", roots).Select(AssetDatabase.GUIDToAssetPath)
                .Where(p => AssetDatabase.LoadAssetAtPath<GameObject>(p) != null || AssetDatabase.LoadAssetAtPath<Texture>(p) != null).OrderBy(p => p, StringComparer.Ordinal).ToArray();
            var referenceCount = paths.Length;
            if (paths.Length > 2048) paths = paths.Take(2048).ToArray();
            var projected = AvatarConfig.Project(plan);
            var consumed = new[] { AssetDatabase.GetAssetPath(body) }.Concat(projected.List("outfits").Select(o => Map(o).Str("prefab"))).Where(p => !string.IsNullOrEmpty(p)).ToArray();
            var candidates = paths.Concat(consumed).Concat(AssetDatabase.GetDependencies(consumed, true)).Distinct().OrderBy(p => p, StringComparer.Ordinal).ToArray();
            // Preview authorized sources without configuring MA, resolving mounts, hiding body parts or
            // applying material presets. Unknown compatibility must not prevent its own observation.
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(body);
            try
            {
                var records = new List<object>();
                if (projected.List("outfits").Count > 0)
                {
                    var group = new GameObject("_Outfit"); group.transform.SetParent(avatar.transform, false);
                    foreach (var value in projected.List("outfits"))
                    {
                        var spec = Map(value);
                        var source = AssetDatabase.LoadAssetAtPath<GameObject>(Text(spec, "prefab")) ?? throw new Exception("观察源模型或预制体不可读");
                        var instance = (GameObject)PrefabUtility.InstantiatePrefab(source, group.transform);
                        instance.name = "Outfit_" + Text(spec, "id");
                        records.Add(new Dictionary<string, object> { ["path"] = PathOf(avatar.transform, instance.transform),
                            ["outfit_id"] = spec["id"], ["shrinkkey"] = OutfitStage.ShrinkKeyDecision(instance, spec) });
                    }
                }
                var objects = Describe(avatar, true);
                if (objects.Count > 8192) throw new Exception("局部观察对象超出 8192 个，未生成不完整操作输入");
                // Flush imported sources before recording their identity across editor sessions.
                AssetDatabase.SaveAssets();
                var hashes = candidates.ToDictionary(p => p, p => (object)AssetHash(p));
                var sources = paths.Where(p => AssetDatabase.LoadAssetAtPath<GameObject>(p) != null).Select(p => (object)new Dictionary<string, object>
                    { ["asset"] = p, ["form"] = PrefabUtility.GetPrefabAssetType(AssetDatabase.LoadAssetAtPath<GameObject>(p)).ToString(),
                        ["objects"] = Describe(AssetDatabase.LoadAssetAtPath<GameObject>(p), true) }).ToList();
                Avh.WriteJson(Avh.Abs(ObservationPath), new Dictionary<string, object>
                { ["schema"] = "object-observation/0.1", ["phase"] = "source_preview", ["sources"] = sources,
                    ["reviews"] = records, ["objects"] = objects, ["asset_hashes"] = hashes, ["asset_derived"] = new List<object>(), ["references"] = paths.ToList(), ["reference_limit"] = 2048,
                    ["reference_count"] = referenceCount, ["references_truncated"] = referenceCount > paths.Length,
                    ["body_prefab"] = AssetDatabase.GetAssetPath(body), ["plan_sha256"] = Digest(Avh.Json(plan)) });
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }
        static Dictionary<string, object> Input()
        {
            if (!File.Exists(Avh.Abs(InputPath))) return null;
            var text = File.ReadAllText(Avh.Abs(InputPath));
            if (text.Length > 131072) throw new Exception("局部操作输入超过 128KB");
            var input = Map(Avh.ParseJson(text));
            if (input.Str("schema") != "local-operations/0.1"
                || input.Keys.Except(new[] { "schema", "observation_sha256", "operations", "user_review", "interpenetration_decisions" }).Any())
                throw new Exception("局部操作 schema 或字段无效");
            var operations = input.List("operations");
            if (!input.TryGetValue("operations", out var rawOperations) || !(rawOperations is List<object>)) throw new Exception("局部 operations 必须为数组");
            if (operations.Count > 128) throw new Exception("局部操作最多 128 项");
            var ids = operations.Select(o => Text(Map(o), "id")).ToList();
            if (ids.Any(id => !Id.IsMatch(id)) || ids.Distinct().Count() != ids.Count) throw new Exception("局部操作 id 无效或重复");
            var observationText = File.ReadAllText(Avh.Abs(ObservationPath));
            if (input.Str("observation_sha256") != Digest(observationText)) throw new Exception("局部操作观察版本已变化");
            var observation = Map(Avh.ParseJson(observationText));
            if (observation.Str("plan_sha256") != Digest(Avh.Json(Avh.Plan()))) throw new Exception("局部操作方案已变化");
            TradeOffs(input, new HashSet<string>(observation.List("objects").Select(row => Map(row).Str("path"))));
            // Raw source previews check every observed input. Older observations retain their historical
            // assembly-owned split for existing local operations, but cannot authorize a new assembly recipe.
            var derived = observation.TryGetValue("asset_derived", out var listed) && listed is List<object> rows
                ? new HashSet<string>(rows.Select(row => row.ToString())) : new HashSet<string>();
            foreach (var pair in Map(observation["asset_hashes"]))
                if (!derived.Contains(pair.Key) && AssetHash(pair.Key) != pair.Value.ToString()) throw new Exception($"局部操作源资产已变化：{pair.Key}");
            return input;
        }
        /// <summary>
        /// `D-148` minimal: a trade-off the executor will not decide alone is one numbered item (`T1`, `T2`, …)
        /// with 2–4 executable options, exactly one recommendation, and the option the submitted recipe actually
        /// used. Each option carries the operations it stands for, in the shape the recipe itself uses, so
        /// "T2 选 A" is executed by copying that option's operations in — the user never describes an effect.
        /// The item is recorded verbatim in the receipt; which operation the recipe really applied is settled
        /// against the recipe in <see cref="TradeOffs"/>, together with the observation-bound references.
        /// </summary>
        static List<object> UserReview(Dictionary<string, object> input)
        {
            if (input == null || !input.ContainsKey("user_review")) return new List<object>();
            if (!(input["user_review"] is List<object> items)) throw new Exception("局部操作 user_review 必须为数组");
            if (items.Count > 64) throw new Exception("局部操作 user_review 最多 64 项");
            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (var value in items)
            {
                var row = value as Dictionary<string, object>;
                if (row == null || row.Keys.Except(new[] { "id", "question", "detail", "options", "recommended", "current" }).Any()
                    || !row.ContainsKey("id") || !row.ContainsKey("question") || !row.ContainsKey("detail")
                    || !row.ContainsKey("options") || !row.ContainsKey("recommended") || !row.ContainsKey("current"))
                    throw new Exception("局部操作 user_review 每项必须有 id/question/detail/options/recommended/current");
                var id = row.Str("id");
                if (id == null || !TradeOff.IsMatch(id)) throw new Exception("局部操作 user_review 的 id 必须是取舍编号（例如 T1）");
                if (!ids.Add(id)) throw new Exception($"局部操作 user_review 的编号重复：{id}");
                foreach (var key in new[] { "question", "detail" })
                    if (string.IsNullOrWhiteSpace(row.Str(key)) || row.Str(key).Length > 4096)
                        throw new Exception($"局部操作 user_review 的 {key} 必须为非空字符串");
                var options = row.List("options");
                if (options.Count < 2 || options.Count > 4)
                    throw new Exception($"局部操作 user_review 的 {id} 必须有 2–4 个方案，实际 {options.Count} 个");
                var optionIds = new HashSet<string>(StringComparer.Ordinal);
                foreach (var option in options) Option(id, option, optionIds);
                // Exactly one recommendation is a single option id, never a list: two recommended options is not
                // a recommendation, and a list would let one in by accident.
                var recommended = row.Str("recommended");
                if (recommended == null || !optionIds.Contains(recommended))
                    throw new Exception($"局部操作 user_review 的 {id} 必须恰好推荐一个方案（recommended 指向其中一个方案编号）");
                var current = row.Str("current");
                if (current == null || !optionIds.Contains(current))
                    throw new Exception($"局部操作 user_review 的 {id} 的 current 必须指向其中一个方案编号");
            }
            return items;
        }
        static readonly Regex TradeOff = new Regex("^T[1-9][0-9]{0,2}$");
        static readonly Regex TradeOffOption = new Regex("^[A-Z]$");
        /// <summary>
        /// One option of a numbered trade-off. Only a recoverable default-visibility change is executable here:
        /// `object_state` with an explicit boolean `active` and a rationale, and no `exclude_from_build`, because
        /// a permanent removal belongs to the approved plan rather than to a choice the user makes afterwards.
        /// "Keep what is there now" is the empty list, not a no-op write.
        /// </summary>
        static void Option(string id, object value, HashSet<string> optionIds)
        {
            var option = value as Dictionary<string, object>;
            if (option == null || option.Keys.Except(new[] { "id", "label", "operations" }).Any()
                || !option.ContainsKey("id") || !option.ContainsKey("label") || !option.ContainsKey("operations"))
                throw new Exception($"局部操作 user_review 的 {id} 每个方案必须有 id/label/operations");
            var optionId = option.Str("id");
            if (optionId == null || !TradeOffOption.IsMatch(optionId))
                throw new Exception($"局部操作 user_review 的 {id} 的方案编号必须是 A–Z 中的一个字母");
            if (!optionIds.Add(optionId)) throw new Exception($"局部操作 user_review 的 {id} 的方案编号重复：{optionId}");
            var label = option.Str("label");
            if (string.IsNullOrWhiteSpace(label) || label.Length > 1024)
                throw new Exception($"局部操作 user_review 的 {id}{optionId} 必须有说明这个方案的标签");
            if (!(option["operations"] is List<object> operations) || operations.Count > 32)
                throw new Exception($"局部操作 user_review 的 {id}{optionId} 的 operations 必须是最多 32 项的可恢复操作数组");
            foreach (var entry in operations)
            {
                var operation = entry as Dictionary<string, object>;
                if (operation == null || !Recoverable(operation))
                    throw new Exception($"局部操作 user_review 的 {id}{optionId} 只能用可恢复操作"
                        + "（object_state 的 active 开关；永久剔除要写进方案，不能做方案选项）");
                if (!operation.ContainsKey("active") || !(operation["active"] is bool))
                    throw new Exception($"局部操作 user_review 的 {id}{optionId} 的可恢复操作必须写 active 布尔值");
                var path = operation.Str("path");
                if (string.IsNullOrWhiteSpace(path) || path.Length > 1024)
                    throw new Exception($"局部操作 user_review 的 {id}{optionId} 的可恢复操作必须写对象路径");
                if (string.IsNullOrWhiteSpace(operation.Str("rationale")) || operation.Str("rationale").Length > 8192)
                    throw new Exception($"局部操作 user_review 的 {id}{optionId} 的可恢复操作必须写 rationale");
            }
        }
        /// <summary>
        /// The only operation an option may carry: a recoverable default-visibility change. `object_state` that
        /// states `active`, names no permanent build exclusion, and carries a rationale — the same shape the
        /// recipe itself accepts, so applying the user's letter is a copy and not an interpretation.
        /// </summary>
        static bool Recoverable(Dictionary<string, object> operation) =>
            operation.Str("kind") == "object_state"
            && !operation.Keys.Except(new[] { "kind", "path", "active", "rationale" }).Any()
            && !operation.ContainsKey("exclude_from_build");
        /// <summary>
        /// The parts of `user_review` that only hold against this run: every option must name objects the source
        /// observation really contains, the option the item calls current must be the one the recipe actually
        /// applied (same `active` on every object the trade-off names, and no permanent removal behind it), and
        /// every `ask_user` interpenetration must point at one numbered trade-off. That last rule is what keeps a
        /// choice in exactly one place: its options live in `user_review` and are referenced by number, never
        /// written twice, so the delivery note and the rework feedback read the same list.
        /// </summary>
        static void TradeOffs(Dictionary<string, object> input, HashSet<string> observed)
        {
            var items = UserReview(input).Cast<Dictionary<string, object>>().ToList();
            var asks = InterpenetrationDecisions(input);
            var applied = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            foreach (var operation in input.List("operations").Select(Map).Where(op => op.Str("kind") == "object_state"))
            {
                var path = operation.Str("path");
                if (path != null && !applied.ContainsKey(path)) applied[path] = operation;
            }
            foreach (var row in items)
            {
                var id = row.Str("id");
                var optionRows = row.List("options").Select(Map).ToList();
                var declared = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
                foreach (var option in optionRows)
                    foreach (var operation in option.List("operations").Select(Map))
                    {
                        var path = operation.Str("path");
                        if (!observed.Contains(path))
                            throw new Exception($"局部操作 user_review 的 {id}{option.Str("id")} 引用的对象不在观察内：{path}");
                        if (declared.ContainsKey(path))
                            throw new Exception($"局部操作 user_review 的 {id} 的方案重复写同一件：{path}");
                        declared[path] = operation;
                    }
                var current = optionRows.Single(option => option.Str("id") == row.Str("current"));
                var chosen = current.List("operations").Select(Map).ToDictionary(op => op.Str("path"), op => op, StringComparer.Ordinal);
                foreach (var pair in declared)
                {
                    applied.TryGetValue(pair.Key, out var operation);
                    if (!chosen.ContainsKey(pair.Key) && operation != null)
                        throw new Exception($"局部操作 user_review 的 {id} 当前方案与配方不符：{pair.Key} 在配方里被改了，"
                            + $"当前方案 {current.Str("id")} 却没有它");
                    if (chosen.ContainsKey(pair.Key) && operation == null)
                        throw new Exception($"局部操作 user_review 的 {id} 当前方案是 {current.Str("id")}，"
                            + $"但配方里没有 {pair.Key} 的 object_state");
                    if (operation == null) continue;
                    if (operation.ContainsKey("exclude_from_build") && Equals(operation["exclude_from_build"], true))
                        throw new Exception($"局部操作 user_review 的 {id} 当前方案与配方不符：{pair.Key} 在配方里被永久剔除了，"
                            + "那不能是方案选项");
                    if (!Equals(chosen[pair.Key]["active"], operation["active"]))
                        throw new Exception($"局部操作 user_review 的 {id} 当前方案与配方不符：{pair.Key} 的 active 是 "
                            + $"{operation["active"]}，当前方案写的是 {chosen[pair.Key]["active"]}");
                }
            }
            var known = new HashSet<string>(items.Select(row => row.Str("id")), StringComparer.Ordinal);
            foreach (var value in asks)
            {
                var row = Map(value);
                if (row.Str("decision") != "ask_user") continue;
                var review = row.Str("review");
                if (review == null || !known.Contains(review))
                    throw new Exception("局部操作 interpenetration_decisions 的 ask_user 必须用 review 引用一条 user_review 的编号"
                        + "（方案只写在 user_review 那一处）");
            }
        }
        /// <summary>
        /// `D-143` ③, the orderer's direction: the Runtime does not write the rule for what is acceptable, so the
        /// executor decides for every visible interpenetration — `close`, `accept` or `ask_user` — and records the
        /// decision in the recipe. Only the shape is checked here; whether the decision is coherent (a `close`
        /// that matches a recorded closure, an `accept` inside the guard bounds with the criterion named) is
        /// decided against the measured reading, so a bad decision leaves that pair blocking instead of failing
        /// the whole recipe.
        /// </summary>
        static List<object> InterpenetrationDecisions(Dictionary<string, object> input)
        {
            if (input == null || !input.ContainsKey("interpenetration_decisions")) return new List<object>();
            if (!(input["interpenetration_decisions"] is List<object> items))
                throw new Exception("局部操作 interpenetration_decisions 必须为数组");
            if (items.Count > 128) throw new Exception("局部操作 interpenetration_decisions 最多 128 项");
            foreach (var value in items)
            {
                var row = value as Dictionary<string, object>;
                if (row == null || row.Keys.Except(new[] { "objects", "decision", "criterion", "evidence", "rationale", "review" }).Any()
                    || !row.ContainsKey("objects") || !row.ContainsKey("decision"))
                    throw new Exception("局部操作 interpenetration_decisions 每项必须有 objects/decision"
                        + "（可加 criterion/evidence/rationale/review）");
                var objects = row.List("objects");
                if (objects.Count != 2 || objects.Any(path => !(path is string text) || string.IsNullOrWhiteSpace(text) || text.Length > 1024)
                    || string.Equals(objects[0].ToString(), objects[1].ToString(), StringComparison.Ordinal))
                    throw new Exception("局部操作 interpenetration_decisions 的 objects 必须是两件不同的部件路径");
                var decision = row.Str("decision");
                if (decision != "close" && decision != "accept" && decision != "ask_user")
                    throw new Exception("局部操作 interpenetration_decisions 的 decision 必须是 close/accept/ask_user");
                foreach (var key in new[] { "criterion", "evidence", "rationale" })
                    if (row.ContainsKey(key) && (!(row[key] is string) || ((string)row[key]).Length > (key == "criterion" ? 1024 : 4096)))
                        throw new Exception($"局部操作 interpenetration_decisions 的 {key} 必须为字符串");
                // `D-148`: a pair kept for the user points at the numbered trade-off that carries its options, so
                // the choice is stated once. Whether that number exists is settled in TradeOffs, against the list.
                if (row.ContainsKey("review") && (!(row["review"] is string) || ((string)row["review"]).Length > 8))
                    throw new Exception("局部操作 interpenetration_decisions 的 review 必须是 user_review 的编号");
            }
            return items;
        }
        /// <summary>
        /// The decisions of the recipe that was applied, read back from the receipt (the applied recipe) and
        /// falling back to the recipe itself before the stage has written one. The visibility reading matches them
        /// against the pairs it confirmed and reports every one it could not settle; the receipt is authoritative
        /// for the same reason `RecordedClosures` reads it: a rejected recipe never gets there.
        /// </summary>
        public static List<Dictionary<string, object>> RecordedDecisions()
        {
            var rows = new List<Dictionary<string, object>>();
            var document = Avh.ReadJsonFile(Avh.Abs(OutputPath)) ?? Avh.ReadJsonFile(Avh.Abs(InputPath));
            if (document == null) return rows;
            foreach (var value in document.List("interpenetration_decisions"))
            {
                if (!(value is Dictionary<string, object> row)) continue;
                rows.Add(new Dictionary<string, object>
                {
                    ["objects"] = row.List("objects"), ["decision"] = row.Str("decision"),
                    ["criterion"] = row.Str("criterion"), ["evidence"] = row.Str("evidence"),
                    ["rationale"] = row.Str("rationale"), ["review"] = row.Str("review"),
                });
            }
            return rows;
        }
        // This supplement changes installation mechanics only. Business identity, source and group
        // remain in the approved plan; the recipe is bound to the raw setup observation and source hashes.
        public static Dictionary<string, object> AssemblySpecification(Dictionary<string, object> specification)
        {
            var input = Input(); if (input == null) return specification;
            var path = "_Outfit/Outfit_" + Text(specification, "id");
            var recipes = input.List("operations").Select(Map).Where(op => op.Str("kind") == "assembly" && op.Str("path") == path).ToList();
            if (recipes.Count == 0) return specification;
            if (recipes.Count != 1 || specification.Obj("mount") != null || specification.List("mounts").Count > 0)
                throw new Exception("装配配方不能重复或覆盖方案挂点");
            var op = recipes[0];
            if (op.Keys.Except(new[] { "id", "kind", "path", "mode", "mounts" }).Any()) throw new Exception("装配配方字段无效");
            var observation = Map(Avh.ParseJson(File.ReadAllText(Avh.Abs(ObservationPath))));
            if (observation.Str("phase") != "source_preview") throw new Exception("装配配方需要先观察源层级");
            var observed = new HashSet<string>(observation.List("objects").Select(row => Text(Map(row), "path")));
            if (!observed.Contains(path)) throw new Exception("装配实例不在观察内");
            var copy = new Dictionary<string, object>(specification);
            if (op.Str("mode") == "merge")
            {
                if (op.ContainsKey("mounts")) throw new Exception("合骨配方不能含刚性挂点");
                copy["assembly_mode"] = "merge";
            }
            else if (op.Str("mode") == "mount")
            {
                var mounts = op.List("mounts").Select(Map).ToList();
                if (mounts.Count == 0 || mounts.Count > 32) throw new Exception("挂点配方需要 1–32 个挂点");
                var sources = new HashSet<string>();
                foreach (var mount in mounts)
                {
                    if (mount.Keys.Except(new[] { "source", "path", "pose", "position", "rotation" }).Any()) throw new Exception("挂点字段无效");
                    var source = mount.Str("source") ?? ""; var target = Text(mount, "path");
                    if (!observed.Contains(path + (source.Length == 0 ? "" : "/" + source)) || !observed.Contains(target)
                        || target == "" || target == "_Outfit" || target.StartsWith("_Outfit/")) throw new Exception("挂点必须绑定已观察源与素体对象");
                    if (!sources.Add(source) || sources.Any(s => s != source && (s == "" || source == "" || s.StartsWith(source + "/") || source.StartsWith(s + "/"))))
                        throw new Exception("挂点源重复或重叠");
                    if (mount.Str("pose") == "relative") { Numbers(mount["position"], 3); Numbers(mount["rotation"], 3); }
                    else if (mount.Str("pose") != "preserve" || mount.ContainsKey("position") || mount.ContainsKey("rotation")) throw new Exception("挂点需要明确姿态");
                }
                copy["mounts"] = mounts.Cast<object>().ToList();
            }
            else throw new Exception("装配模式应为 mount 或 merge");
            copy["assembly_observation_sha256"] = input["observation_sha256"];
            return copy;
        }
        // A technical plan supplement stays inside the authorized outfit artifact. It does not approve appearance,
        // alter the accepted plan/face, or turn scenario expectations into measurements.
        static object Canonical(object value) => value is Dictionary<string, object> map ? map.OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .ToDictionary(pair => pair.Key, pair => Canonical(pair.Value)) : value is List<object> list ? (object)list.Select(Canonical).ToList() : value;
        static string ReviewEvidence(Dictionary<string, object> review) => Avh.Json(Canonical(review.Where(pair => pair.Key != "id" && pair.Key != "path")
            .ToDictionary(pair => pair.Key, pair => pair.Value)));
        public static Dictionary<string, object> Review(GameObject outfit, List<object> writers, List<object> conflicts, string logicalPath = null, List<object> records = null)
        {
            var input = Avh.ReadJsonFile(Avh.Abs(InputPath)); if (input == null) return null;
            var path = logicalPath ?? "_Outfit/" + outfit.name;
            var objects = ObjectMap(records);
            var physical = PhysicalPath(path, objects);
            var reviews = input.List("operations").Select(Map).Where(op => op.Str("kind") == "shrinkkey_review" && PhysicalPath(op.Str("path"), objects) == physical).ToList();
            if (reviews.Count == 0) return null;
            Input(); // Validate source/plan bindings only when a supplement is actually present.
            if (reviews.Select(r => r.Str("path")).Distinct().Count() != reviews.Count) throw new Exception("同一逻辑成员不能重复提交写者复核");
            if (reviews.Select(ReviewEvidence).Distinct().Count() != 1) throw new Exception("共享对象的写者复核证据矛盾");
            var review = reviews[0];
            if (review.Keys.Except(new[] { "id", "kind", "path", "writers", "rationale", "scenarios" }).Any()
                || string.IsNullOrWhiteSpace(Text(review, "rationale")) || review.Str("rationale").Length > 8192
                || !review.List("writers").Select(x => x as string).SequenceEqual(writers.Select(x => x as string))
                || conflicts.Count != 0) throw new Exception("写者复核字段、顺序或真实宿主/键证据不匹配，不能批准");
            var plan = Avh.Plan();
            if (reviews.Any(r => !plan.List("outfits").Select(Map).Any(o => "_Outfit/Outfit_" + o.Str("id") == r.Str("path")))) throw new Exception("写者复核超出已授权服装方案");
            var expectations = Map(review["scenarios"]);
            var states = new[] { "shoe_on_sock_on", "shoe_off_sock_on", "barefoot" };
            if (expectations.Keys.Except(states).Any() || states.Any(key => !expectations.ContainsKey(key)
                || !(expectations[key] is string text) || string.IsNullOrWhiteSpace(text) || text.Length > 4096))
                throw new Exception("写者复核需要三个状态的预期，不能提交实测或批准标志");
            // Conflicting multiwriters need rework or an explicit user decision; a prose rationale cannot waive them.
            object Field(object value, string key) => value?.GetType().GetField(key)?.GetValue(value) ?? value?.GetType().GetProperty(key)?.GetValue(value);
            var changers = outfit.GetComponentsInChildren<Component>(true).Where(c => c != null && c.GetType().FullName == "nadena.dev.modular_avatar.core.ModularAvatarShapeChanger");
            var sets = changers.SelectMany(c => ((IEnumerable)c.GetType().GetProperty("Shapes").GetValue(c)).Cast<object>())
                .Where(shape => Field(shape, "ChangeType")?.ToString() == "Set")
                .GroupBy(shape => (Field(Field(shape, "Object"), "referencePath")?.ToString() ?? "") + "\n" + ShapeName(shape));
            if (sets.Any(group => group.Select(shape => Field(shape, "Value")).Distinct().Count() > 1))
                throw new Exception("多宿主设置值冲突，需要返工或用户选择，不能自动复核");
            return new Dictionary<string, object> { ["status"] = "runtime_verified", ["rationale"] = review["rationale"],
                ["writers"] = writers, ["scenarios"] = states.Cast<object>().ToList(), ["expectations"] = expectations,
                ["visual_scenarios"] = "pending_regression", ["observation_sha256"] = input["observation_sha256"],
                ["logical_member"] = path, ["physical_object"] = physical, ["submitted_members"] = reviews.Select(r => r.Str("path")).ToList(),
                ["revision_sha256"] = Digest(Avh.Json(review)), ["authority"] = "authorized_local_technical_plan_supplement" };
        }
        static string Reference(Dictionary<string, object> observation, string path, Type type)
        {
            if (!observation.List("references").Contains(path) || !path.StartsWith("Assets/") || path.StartsWith("Assets/_Harness/")
                || AssetDatabase.LoadAssetAtPath(path, type) == null) throw new Exception("局部操作引用不在本次已批准导入素材内");
            return path;
        }
        static Material ObservedMaterial(Dictionary<string, object> observation, string path)
        {
            var observed = observation.List("objects").Select(Map).SelectMany(row => row.List("renderers").Select(Map))
                .SelectMany(renderer => renderer.List("slots").Select(Map)).Any(slot => slot.Str("material") == path);
            if (!observed || !path.StartsWith("Assets/") || path.StartsWith("Assets/_Harness/") || !Map(observation["asset_hashes"]).ContainsKey(path))
                throw new Exception("局部材质来源不在本次已观察授权素材内");
            return AssetDatabase.LoadAssetAtPath<Material>(path) ?? throw new Exception("局部材质来源不可读");
        }
        static IList FootWriter(GameObject avatar, Dictionary<string, object> op)
        {
            var components = Target(avatar, Text(op, "path")).GetComponents<Component>();
            var index = Integer(op["component_index"]);
            if (index >= components.Length || components[index] == null || components[index].GetType().FullName != "nadena.dev.modular_avatar.core.ModularAvatarShapeChanger")
                throw new Exception("局部脚型写者不是已观察的 MA Shape Changer");
            return components[index].GetType().GetProperty("Shapes").GetValue(components[index]) as IList ?? throw new Exception("局部脚型写者不可读");
        }
        static string ShapeName(object shape) => shape.GetType().GetField("ShapeName").GetValue(shape) as string ?? "";
        static void TransformValue(Transform target, Dictionary<string, object> op)
        {
            Vector3 V(string key) { var a = Numbers(op[key], 3); return new Vector3(a[0], a[1], a[2]); }
            if (op.ContainsKey("position")) target.localPosition = V("position");
            if (op.ContainsKey("rotation")) target.localRotation = Quaternion.Euler(V("rotation"));
            if (op.ContainsKey("scale")) { var s = V("scale"); if (s.x <= 0 || s.y <= 0 || s.z <= 0) throw new Exception("局部缩放必须大于零"); target.localScale = s; }
        }
        static void ProtectAvatarCore(GameObject avatar, Transform target)
        {
            var animator = avatar.GetComponent<Animator>();
            if (animator != null && animator.isHuman)
                foreach (HumanBodyBones bone in Enum.GetValues(typeof(HumanBodyBones)))
                {
                    if (bone == HumanBodyBones.LastBone) continue;
                    var transform = animator.GetBoneTransform(bone);
                    if (transform != null && (transform == target || transform.IsChildOf(target))) throw new Exception("局部对象状态不能排除或关闭人形骨骼");
                }
            var design = Avh.ReadJsonFile(Avh.Abs("Assets/_Harness/Face/design.json"));
            var face = Avh.ReadJsonFile(Avh.Abs("_harness/face/observation.json"));
            if (design?.Str("targetId") == null || face == null) return;
            var row = face.List("targets").Select(Map).SingleOrDefault(value => value.Str("targetId") == design.Str("targetId"));
            if (row == null) throw new Exception("局部对象状态无法核对选定脸型目标");
            var renderer = Target(avatar, Text(row, "rendererPath"), true);
            if (renderer == target || renderer.IsChildOf(target)) throw new Exception("局部对象状态不能排除或关闭选定脸型");
        }
        static void SetProperty(Material material, string name, Dictionary<string, object> property, Dictionary<string, object> observation)
        {
            var index = Enumerable.Range(0, ShaderUtil.GetPropertyCount(material.shader)).Where(i => ShaderUtil.GetPropertyName(material.shader, i) == name).DefaultIfEmpty(-1).First();
            if (index < 0) throw new Exception($"局部操作 shader 属性不存在：{name}");
            var type = ShaderUtil.GetPropertyType(material.shader, index);
            var kind = Text(property, "type");
            if (property.Keys.Except(new[] { "type", "value" }).Any()) throw new Exception("局部材质属性字段无效");
            var value = property["value"];
            if (kind == "float" && (type == ShaderUtil.ShaderPropertyType.Float || type == ShaderUtil.ShaderPropertyType.Range)) material.SetFloat(name, Float(value));
            else if (kind == "color" && type == ShaderUtil.ShaderPropertyType.Color) { var a = Numbers(value, 4); material.SetColor(name, new Color(a[0], a[1], a[2], a[3])); }
            else if (kind == "vector" && type == ShaderUtil.ShaderPropertyType.Vector) { var a = Numbers(value, 4); material.SetVector(name, new Vector4(a[0], a[1], a[2], a[3])); }
            else if (kind == "texture" && type == ShaderUtil.ShaderPropertyType.TexEnv) material.SetTexture(name, AssetDatabase.LoadAssetAtPath<Texture>(Reference(observation, value.ToString(), typeof(Texture))));
            else throw new Exception($"局部材质属性类型不匹配：{name}");
        }
        // Source previews keep every logical member. Only assembly decides which members share an object.
        // Rebuild this map from assembly records, never from the local-operation receipt.
        static Dictionary<string, string> ObjectMap(List<object> records) => (records ?? new List<object>()).Select(Map)
            .ToDictionary(row => "_Outfit/Outfit_" + Text(row, "id"), row => Text(row, "object"));
        static string PhysicalPath(string path, Dictionary<string, string> objects)
        {
            foreach (var pair in objects.OrderByDescending(pair => pair.Key.Length))
                if (path == pair.Key || path.StartsWith(pair.Key + "/", StringComparison.Ordinal))
                    return pair.Value + path.Substring(pair.Key.Length);
            return path;
        }
        static Dictionary<string, object> PhysicalOperation(Dictionary<string, object> op, Dictionary<string, string> objects)
        {
            var resolved = new Dictionary<string, object>(op); resolved["path"] = PhysicalPath(Text(op, "path"), objects); return resolved;
        }
        static Dictionary<string, object> Member(List<object> records, string logicalPath) => (records ?? new List<object>()).Select(Map)
            .SingleOrDefault(row => logicalPath == "_Outfit/Outfit_" + row.Str("id") || logicalPath.StartsWith("_Outfit/Outfit_" + row.Str("id") + "/", StringComparison.Ordinal));
        static Dictionary<string, object> Preset(Dictionary<string, object> member, string physicalPath) => member.List("material_presets").Select(Map)
            .Single(preset => preset.Str("renderer") == physicalPath);
        static string MaterialKey(Dictionary<string, object> member, string path, int slot) => member.Str("id") + ":" + path + ":" + slot;
        static void SharedMaterialDefaults(GameObject avatar, List<object> records, Dictionary<string, Material> overrides)
        {
            var rows = (records ?? new List<object>()).Select(Map).ToList();
            foreach (var row in rows.Where(row => Equals(row["default"], true) && rows.Count(other => other.Str("object") == row.Str("object")) > 1))
                foreach (var preset in row.List("material_presets").Select(Map))
                    Target(avatar, Text(preset, "renderer")).GetComponent<Renderer>().sharedMaterials = preset.List("materials").Select((identity, slot) =>
                        overrides.TryGetValue(MaterialKey(row, Text(preset, "renderer"), slot), out var copy) ? copy : VariantResolver.Material(identity)).ToArray();
        }
        public static Dictionary<string, object> Apply(GameObject avatar, bool persist = true, List<object> records = null)
        {
            var input = Input();
            if (input == null) return null;
            var observation = Map(Avh.ParseJson(File.ReadAllText(Avh.Abs(ObservationPath))));
            var observed = new HashSet<string>(observation.List("objects").Select(o => Map(o).Str("path")));
            var claims = new HashSet<string>();
            var objects = ObjectMap(records);
            var materialOverrides = new Dictionary<string, Material>();
            var reviewsByObject = new Dictionary<string, string>();
            var recipeHash = Digest(Avh.Json(input)); var directory = "Assets/_Harness/Outfit/Local_" + recipeHash.Substring(0, 16);
            var receipt = new List<object>();
            foreach (var value in input.List("operations"))
            {
                var op = Map(value); var kind = Text(op, "kind"); var path = Text(op, "path"); var id = Text(op, "id");
                var fields = kind == "material" ? new[] { "id", "kind", "path", "renderer_index", "slot", "source_material", "properties" }
                    : kind == "transform" ? new[] { "id", "kind", "path", "position", "rotation", "scale" }
                    : kind == "attach" ? new[] { "id", "kind", "path", "prefab", "position", "rotation", "scale" }
                    : kind == "shrinkkey_review" ? new[] { "id", "kind", "path", "writers", "rationale", "scenarios" }
                    : kind == "foot_writer" ? new[] { "id", "kind", "path", "component_index", "remove_shapes", "rationale" }
                    : kind == "assembly" ? new[] { "id", "kind", "path", "mode", "mounts" }
                    : kind == "object_state" ? new[] { "id", "kind", "path", "active", "exclude_from_build", "rationale" } : throw new Exception("不支持的局部操作类型");
                if (op.Keys.Except(fields).Any() || !observed.Contains(path)) throw new Exception("局部操作字段或对象不在观察内");
                if (kind == "assembly")
                {
                    var spec = AvatarConfig.Project(Avh.Plan()).List("outfits").Select(Map).SingleOrDefault(o => "_Outfit/Outfit_" + o.Str("id") == path)
                        ?? throw new Exception("装配配方必须针对方案实例");
                    AssemblySpecification(spec);
                    receipt.Add(new Dictionary<string, object> { ["id"] = id, ["kind"] = kind, ["path"] = path, ["observation_sha256"] = input["observation_sha256"] });
                    continue;
                }
                var logicalPath = path;
                op = PhysicalOperation(op, objects); path = Text(op, "path");
                if (kind == "shrinkkey_review")
                {
                    if (!claims.Add("shrinkkey_review:" + logicalPath)) throw new Exception("同一逻辑成员不能重复提交写者复核");
                    var evidence = ReviewEvidence(op);
                    if (reviewsByObject.TryGetValue(path, out var prior) && prior != evidence) throw new Exception("共享对象的写者复核证据矛盾");
                    reviewsByObject[path] = evidence;
                    continue; // Validate after all physical operations, independent of recipe order.
                }
                if (kind == "material")
                {
                    var renderer = RendererAt(avatar, op); var slot = Slot(renderer, op); var source = ObservedMaterial(observation, Text(op, "source_material"));
                    if (!claims.Add($"material:{path}:{op["renderer_index"]}:{slot}"))
                        throw new Exception("局部材质来源变化或重复写槽位");
                    var properties = Map(op["properties"]); if (properties.Count == 0 || properties.Count > 32) throw new Exception("局部材质属性应为 1–32 项");
                    var copy = new Material(source) { name = "Local_" + id }; foreach (var pair in properties) SetProperty(copy, pair.Key, Map(pair.Value), observation);
                    var materialPath = directory + "/" + id + ".mat";
                    if (persist)
                    {
                        OutfitStage.EnsureFolder(directory); var existing = AssetDatabase.LoadAssetAtPath<Material>(materialPath);
                        if (existing == null) AssetDatabase.CreateAsset(copy, materialPath);
                        else { if (Avh.Json(Properties(existing)) != Avh.Json(Properties(copy)) || existing.shader != copy.shader) throw new Exception("已有局部材质版本发生漂移，保留原内容"); UnityEngine.Object.DestroyImmediate(copy); copy = existing; }
                    }
                    else
                    {
                        var existing = AssetDatabase.LoadAssetAtPath<Material>(materialPath);
                        if (existing == null || existing.shader != copy.shader || Avh.Json(Properties(existing)) != Avh.Json(Properties(copy)))
                            throw new Exception("局部材质持久版本与独立重建不符");
                    }
                    var materials = renderer.sharedMaterials; materials[slot] = copy; renderer.sharedMaterials = materials;
                    var member = Member(records, logicalPath);
                    if (member != null)
                    {
                        var identity = VariantResolver.Identity(AssetDatabase.LoadAssetAtPath<Material>(materialPath));
                        Preset(member, path).List("materials")[slot] = identity;
                        materialOverrides[MaterialKey(member, path, slot)] = copy;
                    }
                    receipt.Add(new Dictionary<string, object> { ["id"] = id, ["kind"] = kind, ["material"] = materialPath, ["source_material"] = AssetDatabase.GetAssetPath(source) });
                }
                else if (kind == "foot_writer")
                {
                    var shapes = FootWriter(avatar, op); var requested = op.List("remove_shapes").Select(value => value as string).ToList();
                    if (!claims.Add($"foot_writer:{path}:{op["component_index"]}") || string.IsNullOrWhiteSpace(Text(op, "rationale")) || requested.Count == 0 || requested.Count > 64
                        || requested.Any(value => value == null || !FootShape.IsMatch(value)) || requested.Distinct().Count() != requested.Count)
                        throw new Exception("局部脚型写者只能移除点名脚部键，须说明取舍且不能重复");
                    if (requested.Any(name => !shapes.Cast<object>().Any(shape => ShapeName(shape) == name))) throw new Exception("点名脚部键不在真实写者中");
                    for (var i = shapes.Count - 1; i >= 0; i--) if (requested.Contains(ShapeName(shapes[i]))) shapes.RemoveAt(i);
                    receipt.Add(new Dictionary<string, object> { ["id"] = id, ["kind"] = kind, ["path"] = path, ["removed_shapes"] = requested,
                        ["rationale"] = Text(op, "rationale"), ["default_geometry"] = "preserved", ["shoe_sock_visual_scenarios"] = "not_measured_here" });
                }
                else if (kind == "transform")
                {
                    if (!claims.Add("transform:" + path) || !op.Keys.Any(k => k == "position" || k == "rotation" || k == "scale")) throw new Exception("局部变换重复或为空");
                    TransformValue(Target(avatar, path), op); receipt.Add(new Dictionary<string, object> { ["id"] = id, ["kind"] = kind, ["path"] = path });
                }
                else if (kind == "object_state")
                {
                    var target = Target(avatar, path);
                    ProtectAvatarCore(avatar, target);
                    if (!claims.Add("object_state:" + path) || !op.Keys.Any(k => k == "active" || k == "exclude_from_build")) throw new Exception("局部对象状态重复或为空");
                    foreach (var key in new[] { "active", "exclude_from_build" })
                        if (op.ContainsKey(key) && !(op[key] is bool)) throw new Exception("局部对象状态必须为布尔值");
                    // D-138: deciding a part's default visibility is the executor's call, but it has to be a
                    // recorded decision. Every object_state names why it changed the delivered avatar's
                    // visibility, so a part that disappears can always be traced to a stated reason.
                    var rationale = op.Str("rationale");
                    if (string.IsNullOrWhiteSpace(rationale)) throw new Exception("局部对象状态必须写明 rationale");
                    if (rationale.Length > 8192) throw new Exception("局部对象状态 rationale 过长");
                    if (op.ContainsKey("active")) target.gameObject.SetActive((bool)op["active"]);
                    if (op.ContainsKey("exclude_from_build"))
                    {
                        if (!(bool)op["exclude_from_build"]) throw new Exception("构建排除只允许显式排除，不能撤回上游排除");
                        target.gameObject.tag = "EditorOnly";
                    }
                    receipt.Add(new Dictionary<string, object> { ["id"] = id, ["kind"] = kind, ["path"] = path,
                        ["active"] = op.ContainsKey("active") ? op["active"] : null,
                        ["exclude_from_build"] = op.ContainsKey("exclude_from_build") ? op["exclude_from_build"] : null,
                        ["rationale"] = rationale });
                }
                else
                {
                    var prefabPath = Reference(observation, Text(op, "prefab"), typeof(GameObject)); var parent = Target(avatar, path, true);
                    var name = "_Local_" + id; if (parent.Find(name) != null) throw new Exception("局部挂件目标名已存在");
                    var child = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath), parent);
                    child.name = name; TransformValue(child.transform, op);
                    receipt.Add(new Dictionary<string, object> { ["id"] = id, ["kind"] = kind, ["path"] = PathOf(avatar.transform, child.transform), ["prefab"] = prefabPath });
                }
            }
            SharedMaterialDefaults(avatar, records, materialOverrides);
            foreach (var value in input.List("operations").Select(Map).Where(op => op.Str("kind") == "shrinkkey_review"))
            {
                var root = Target(avatar, PhysicalPath(Text(value, "path"), objects));
                var specification = Avh.Plan().List("outfits").Select(Map).SingleOrDefault(o => "_Outfit/Outfit_" + o.Str("id") == value.Str("path"))
                    ?? throw new Exception("写者复核必须针对已授权服装根");
                var decision = OutfitStage.ShrinkKeyDecision(root.gameObject, specification, true, records);
                receipt.Add(new Dictionary<string, object> { ["id"] = value["id"], ["kind"] = "shrinkkey_review", ["path"] = value["path"], ["review"] = decision["review"] });
            }
            return new Dictionary<string, object> { ["schema"] = "local-operation-receipt/0.1", ["input_sha256"] = recipeHash,
                ["logical_objects"] = objects, ["operations"] = receipt, ["user_review"] = UserReview(input),
                ["interpenetration_decisions"] = InterpenetrationDecisions(input) };
        }
        /// <summary>
        /// D-138: the recorded, justified closures of the recipe that was just applied, by physical avatar
        /// path. Only an operation that hides something and carries a rationale is a decision; a part that
        /// disappears without one is still a missing part and must keep failing the fixed check. The receipt
        /// is the applied recipe, so a rejected or absent operation can never appear here.
        /// </summary>
        public static List<Dictionary<string, object>> RecordedClosures(Dictionary<string, object> receipt)
        {
            var closures = new List<Dictionary<string, object>>();
            if (receipt == null) return closures;
            foreach (var value in receipt.List("operations"))
            {
                var row = value as Dictionary<string, object>;
                if (row == null || row.Str("kind") != "object_state") continue;
                var hides = row.ContainsKey("active") && Equals(row["active"], false)
                    || row.ContainsKey("exclude_from_build") && Equals(row["exclude_from_build"], true);
                if (!hides || string.IsNullOrWhiteSpace(row.Str("rationale"))) continue;
                closures.Add(new Dictionary<string, object> { ["operation"] = row.Str("id"), ["path"] = row.Str("path"), ["rationale"] = row.Str("rationale") });
            }
            return closures;
        }
        // A reloaded output is compared with a fresh source assembly, not an AI-written receipt or pass flag.
        // Compare complete observed transforms/material shader properties/component inventories, including unspecified targets.
        static bool Postconditions(GameObject actual, Dictionary<string, object> input, Dictionary<string, string> objects, List<object> records)
        {
            bool Close(float a, float b) => Math.Abs(a - b) <= 0.00001f;
            foreach (var item in input.List("operations"))
            {
                var op = PhysicalOperation(Map(item), objects); var kind = Text(op, "kind");
                if (kind == "shrinkkey_review" || kind == "assembly") continue; // Reconstructed and independently measured by OutfitMeasure.
                if (kind == "material")
                {
                    var renderer = RendererAt(actual, op); var material = renderer.sharedMaterials[Slot(renderer, op)];
                    var member = Member(records, Text(Map(item), "path"));
                    if (member != null && records.Select(Map).Count(row => row.Str("object") == member.Str("object")) > 1)
                        material = VariantResolver.Material(Preset(member, Text(op, "path")).List("materials")[Slot(renderer, op)]);
                    foreach (var pair in Map(op["properties"]))
                    {
                        var property = Map(pair.Value); var type = Text(property, "type"); var value = property["value"];
                        if (type == "float" && !Close(material.GetFloat(pair.Key), Float(value))) return false;
                        if (type == "texture" && AssetDatabase.GetAssetPath(material.GetTexture(pair.Key)) != value.ToString()) return false;
                        if (type == "color") { var wanted = Numbers(value, 4); var color = material.GetColor(pair.Key); if (!Close(color.r, wanted[0]) || !Close(color.g, wanted[1]) || !Close(color.b, wanted[2]) || !Close(color.a, wanted[3])) return false; }
                        if (type == "vector") { var wanted = Numbers(value, 4); var vector = material.GetVector(pair.Key); for (var i = 0; i < 4; i++) if (!Close(vector[i], wanted[i])) return false; }
                    }
                }
                else if (kind == "object_state")
                {
                    var target = Target(actual, Text(op, "path"));
                    if (op.ContainsKey("active") && target.gameObject.activeSelf != (bool)op["active"]) return false;
                    if (op.ContainsKey("exclude_from_build") && target.gameObject.tag != "EditorOnly") return false;
                }
                else if (kind == "foot_writer")
                {
                    var remaining = FootWriter(actual, op).Cast<object>().Select(ShapeName).ToList();
                    if (op.List("remove_shapes").Any(value => remaining.Contains(value.ToString()))) return false;
                }
                else
                {
                    var path = Text(op, "path");
                    if (kind == "attach") path = (path.Length == 0 ? "" : path + "/") + "_Local_" + Text(op, "id");
                    var target = Target(actual, path);
                    foreach (var key in new[] { "position", "scale" })
                    {
                        if (!op.ContainsKey(key)) continue; var wanted = Numbers(op[key], 3); var vector = key == "position" ? target.localPosition : target.localScale;
                        for (var i = 0; i < 3; i++) if (!Close(vector[i], wanted[i])) return false;
                    }
                    if (op.ContainsKey("rotation")) { var wanted = Numbers(op["rotation"], 3); if (Quaternion.Angle(target.localRotation, Quaternion.Euler(wanted[0], wanted[1], wanted[2])) > 0.001f) return false; }
                }
            }
            return true;
        }
        public static bool Verify(GameObject actual, GameObject body, Dictionary<string, object> plan, List<string> notes)
        {
            if (!File.Exists(Avh.Abs(InputPath))) return false;
            GameObject expected = null;
            try
            {
                var observation = Map(Avh.ParseJson(File.ReadAllText(Avh.Abs(ObservationPath))));
                if (body == null || AssetDatabase.GetAssetPath(body) != FaceStage.ValidatedOutput(observation.Str("body_prefab")))
                    throw new Exception("局部操作素体输入与观察版本不一致");
                expected = OutfitStage.Assemble(body, plan, out _, out var records); Apply(expected, false, records);
                EffectiveReferences.TrimMissingTailMaterials(expected);
                OutfitStage.RefreshMaterialPresets(expected, records);
                // D-139 ②: production adds the missing body same-name shape-key follows at the end of assembly.
                // The independent rebuild has to reproduce that step as well, or this reload would reject the
                // assembly's own artifact for containing exactly what assembly added.
                OutfitStage.SyncBodyShapeKeys(expected, AssetDatabase.GetAssetPath(body));
                if (records.Count > 0)
                {
                    var persisted = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)) ?? throw new Exception("缺少局部成员预设记录");
                    foreach (var row in records.Select(Map))
                    {
                        var actualRow = persisted.List("outfits").Select(Map).Single(r => r.Str("id") == row.Str("id"));
                        if (actualRow.Str("object") != row.Str("object") || Avh.Json(actualRow.List("material_presets")) != Avh.Json(row.List("material_presets")))
                            throw new Exception("局部成员的有效材质预设与独立重建不符");
                    }
                }
                var input = Input(); var materialDirectory = "Assets/_Harness/Outfit/Local_" + Digest(Avh.Json(input)).Substring(0, 16);
                string Normalized(GameObject value)
                {
                    var objects = Describe(value, true);
                    foreach (var entry in objects)
                    {
                        var row = Map(entry);
                        // The assembly-owned group gains the output prefab as its origin only after persistence.
                        // Normalize this one generated container; imported/attached objects retain exact source identity.
                        if (row.Str("path") == "_Outfit" && row.Str("source_prefab") == "Assets/_Harness/Outfit/Avatar.prefab") row["source_prefab"] = "";
                        // A saved variant's generated root name is not a shape change. Paths are root-relative.
                        foreach (var renderer in row.List("renderers").Select(Map)) foreach (var slot in renderer.List("slots").Select(Map))
                        {
                            if (slot.Str("material") != "") continue;
                            var material = Target(value, row.Str("path"), true).GetComponents<Renderer>()[Convert.ToInt32(renderer["renderer_index"])].sharedMaterials[Convert.ToInt32(slot["slot"])];
                            if (material != null && material.name.StartsWith("Local_")) slot["material"] = materialDirectory + "/" + material.name.Substring(6) + ".mat";
                        }
                    }
                    return Avh.Json(objects);
                }
                var actualText = Normalized(actual); var expectedText = Normalized(expected);
                var matches = actualText == expectedText && Postconditions(actual, input, ObjectMap(records), records);
                if (actualText != expectedText)
                {
                    var first = Enumerable.Range(0, Math.Min(actualText.Length, expectedText.Length)).FirstOrDefault(i => actualText[i] != expectedText[i]);
                    notes.Add("局部重载首个差异字符位置：" + first + "；实际：" + actualText.Substring(Math.Max(0, first - 90), Math.Min(180, actualText.Length - Math.Max(0, first - 90)))
                        + "；预期：" + expectedText.Substring(Math.Max(0, first - 90), Math.Min(180, expectedText.Length - Math.Max(0, first - 90))));
                }
                if (!matches) notes.Add("局部操作独立重载不匹配：对象/组件/变换/材质属性或未授权目标发生变化");
                return matches;
            }
            catch (Exception error) { notes.Add("局部操作独立验证失败：" + error.Message); return false; }
            finally
            {
                if (expected != null) { foreach (var material in expected.GetComponentsInChildren<Renderer>(true).SelectMany(r => r.sharedMaterials).Where(m => m != null && string.IsNullOrEmpty(AssetDatabase.GetAssetPath(m))).Distinct()) UnityEngine.Object.DestroyImmediate(material); UnityEngine.Object.DestroyImmediate(expected); }
            }
        }
    }
}
