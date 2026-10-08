// ══════════════════════════════════════════════════════════════════
// 【项目沉淀】通用工具 · 审查探针「删除区是否被宿主件盖住」delete_coverage
// 适用素体：任意 Humanoid 头像（VRChat 3.x / Unity 2022.3）
// 相关素材：无
// 工具链　：Unity 2022.3.22f1（Editor 程序集 AvatarAudit.Editor；本文件用 UnityEditor）
// 可复用性：★★★ 换单子随 `审查/unity/` 一起同步（sync_audit.py）
// 用途　　：MA ShapeChanger 的 `ChangeType=Delete` 把身体某形态键钉死后，该形态键影响到的
// 　　　　　图元（=「删除区」）在新状态下若没有被**写者所在的那件**盖住，就会露缺口。
// 　　　　　2026-09-19 工程B档 6 雪花罗曼史：无脚长袜 `Socks` 删身体 `Ankle_L/R`，脚踝其实
// 　　　　　靠靴子盖；用户「鞋关袜开」时脚踝被删却无人盖（`seq_snowflake_delete/09_*`），
// 　　　　　修法是把 Delete 挪到 `Boots`。过去靠看图才发现，本探针把它变成结构化数字。
//
// ── 量测口径（任务 BV 返工，验收_20260919_BN至BQ.md BQ-探针设计）──────────────────────
// **只在编辑模式量**（菜单 `Tools/AvatarAudit/Delete Coverage (Edit Mode)`）。原因：
//   · Play/构建后 MA 的 Delete 已经把网格改掉——常驻 Delete 走 `RemoveVertices` 删顶点，
//     可开关 Delete 走 NaNimation（骨骼 scale=NaN，BakeMesh 出来是 NaN）；「宿主可见、删除
//     生效」的原始网格在 Play 里已经不存在，顶点下标也对不上。编辑模式里原网格与 MA 组件都还在。
//   · 编辑模式不需要进 Play：用写者宿主的 `activeSelf` 组合模拟「件开/件关」。
// T1 探针名 `delete_coverage` 保留，但在 Play 里被调用时返回 `undecidable: MA 已处理网格`。
//
// 请求文件（可选）`<工程>/Library/AvatarAudit/delete_coverage_request.json`：
//   {"tool":"delete_coverage", "delete_coverage_threshold_mm":15,
//    "delete_coverage_min_ratio":0.2,
//    "states":[{"id":"s6_sok_on_sho_off","params":{"Socks":true,"Boots":false}}]}
//   · `states[].params`（别名 `hosts`）：把「写者宿主」按相对路径 / 叶名 / 子串匹配到 开/关，
//     值可为 bool 或 0/1；没点到的宿主保持编辑场景现值。缺 `states` 时只跑一个当前态。
//   · 输出写 `<工程>/Library/AvatarAudit/delete_coverage_edit.json`，同时打 Console。
//
// 删除区判据（对齐 MA 1.18 的 Delete 语义，不是自己拍脑袋）：
//   · MA `ModularAvatarShapeChanger.m_threshold`（默认 0.01，**网格局部单位**）经
//     `ReactiveObjectAnalyzer.LocateReactions.cs:249` → `new VertexFilterByShape(ShapeName, threshold)`；
//     `VertexFilterByShape.cs:78-90` 判 `deltaPositions[v].sqrMagnitude > threshold²`（形态键原始
//     delta），再用 `MarkPrimitivesFromVertexIndices` 做**图元级**选择（默认 AnyVertex：图元任一
//     顶点命中即整块删除）。所以删除区 = 命中顶点所在三角形的全部顶点，不是「世界位移 > 0.1 mm」。
//   · delta 优先读 `Mesh.GetBlendShapeFrameVertices`（原始网格局部单位）；网格不可读时退回
//     `BakeMesh(m,true)` 0/100 的局部差值（含 SMR scale，记 `region_source` 后缀 `_fallback`）。
//
// 覆盖判据：删除区每个顶点（取该形态键权重 0 的世界坐标 = 缺口位置）到**宿主件表面**（写者
// GameObject 及其子树的全部 Renderer，顶点到三角形最近距离）的最近距离；`uncovered_ratio` =
// 距离 > `delete_coverage_threshold_mm`（默认 15）的占比。只认写者自己那件——靴子不算袜子宿主。
// 写者挂在无网格容器上时照样出行，标 `host_has_no_mesh:true`，不跳过。
// ══════════════════════════════════════════════════════════════════

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace AvatarAudit
{
    public static class AuditDeleteCoverage
    {
        public const string Tool = "delete_coverage";
        public const string DefaultRequestRel = "Library/AvatarAudit/delete_coverage_request.json";
        public const string DefaultOutputRel = "Library/AvatarAudit/delete_coverage_edit.json";
        public const double DefaultThresholdMm = 15.0;   // 覆盖阈值（mm）
        public const double DefaultMinRatio = 0.2;       // 算一行命中的 uncovered_ratio 下限
        public const float DefaultMaThreshold = 0.01f;   // MA ShapeChanger.m_threshold 默认（局部单位）
        private const float GridCellM = 0.03f;           // 宿主三角形空间哈希边长（30 mm）
        private const int GridCellsPerTriCap = 512;      // 单三角形跨格太多就不建哈希，直接暴力
        private const BindingFlags AnyInstance =
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        // ─────────────────────────────────────────────────────────────
        // 0. 菜单 / 路径
        // ─────────────────────────────────────────────────────────────

        [MenuItem("Tools/AvatarAudit/Delete Coverage (Edit Mode)", false, 120)]
        public static void RunFromMenu()
        {
            GameObject avatar = FindAvatar();
            if (avatar == null)
            {
                Debug.LogError("[AvatarAudit] delete_coverage：场景里找不到带 VRCAvatarDescriptor 的头像");
                return;
            }
            JsonObject request = null;
            string reqPath = DefaultRequestPath();
            if (File.Exists(reqPath))
            {
                try { request = AuditJson.Parse(File.ReadAllText(reqPath, Encoding.UTF8)) as JsonObject; }
                catch (Exception e) { Debug.LogWarning("[AvatarAudit] delete_coverage 请求文件解析失败：" + e.Message); }
            }

            var warnings = new List<string>();
            JsonObject outObj = RunEdit(avatar, request, warnings);
            string outPath = DefaultOutputPath();
            AuditJson.WriteFile(outPath, outObj);

            int hits = AuditJson.Int(outObj, "hits", 0);
            int states = AuditJson.Int(outObj, "state_count", 0);
            int writers = AuditJson.Int(outObj, "writer_count", 0);
            var sb = new StringBuilder();
            sb.AppendLine("[AvatarAudit] delete_coverage（编辑模式）：头像=" + avatar.name
                          + "，写者=" + writers + "，状态=" + states + "，命中=" + hits);
            sb.AppendLine("请求：" + (request != null ? reqPath : "(无，跑当前编辑态)"));
            sb.AppendLine("输出：" + outPath);
            for (int i = 0; i < warnings.Count; i++) sb.AppendLine("  警告：" + warnings[i]);
            Debug.Log(sb.ToString());
        }

        public static string DefaultRequestPath() { return UnderProject(DefaultRequestRel); }
        public static string DefaultOutputPath() { return UnderProject(DefaultOutputRel); }

        static string UnderProject(string rel)
        {
            string root = ProjectRoot();
            return Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar));
        }

        static string ProjectRoot()
        {
            var parent = Directory.GetParent(Application.dataPath);
            return parent == null ? Application.dataPath : parent.FullName;
        }

        static GameObject FindAvatar()
        {
            var sel = Selection.activeGameObject;
            if (sel != null)
            {
                var d0 = sel.GetComponentInParent<VRC.SDK3.Avatars.Components.VRCAvatarDescriptor>();
                if (d0 != null) return d0.gameObject;
            }
            var all = Object.FindObjectsOfType<VRC.SDK3.Avatars.Components.VRCAvatarDescriptor>();
            for (int i = 0; i < all.Length; i++)
                if (all[i] != null && all[i].gameObject.activeInHierarchy) return all[i].gameObject;
            return all.Length > 0 && all[0] != null ? all[0].gameObject : null;
        }

        // ─────────────────────────────────────────────────────────────
        // 1. T1 探针入口（保留探针名；Play 里判不了）
        // ─────────────────────────────────────────────────────────────

        /// <summary>
        /// T1 在 Play 里调用。Play/构建后 MA 已处理网格，返回 `undecidable`，不做几何量测。
        /// 若在编辑模式被调用（非常规），退化为按当前编辑态量一次。
        /// </summary>
        public static JsonObject Run(AuditContext ctx, GameObject avatar, Animator anim, out int hits)
        {
            hits = 0;
            if (Application.isPlaying)
            {
                var o = new JsonObject();
                o.Set("tool", Tool);
                o.Set("mode", "play");
                o.Set("undecidable", "MA 已处理网格");
                o.Set("reason",
                    "Play/构建后 MA 的 Delete 已生效：常驻 Delete 走 RemoveVertices 删顶点，可开关 Delete 走"
                    + " NaNimation（骨骼 scale=NaN）；原始网格已不存在，顶点下标也对不上。"
                    + "本探针只在编辑模式量（菜单 Tools/AvatarAudit/Delete Coverage (Edit Mode)）。");
                o.Set("writers", new List<object>());
                o.Set("writer_count", 0);
                o.Set("hits", 0);
                if (ctx != null)
                    ctx.Warn("delete_coverage：Play 模式下 MA 已处理网格，判不了；请用编辑模式菜单量。");
                return o;
            }

            if (avatar == null)
            {
                var o = new JsonObject();
                o.Set("tool", Tool);
                o.Set("error", "没有头像");
                o.Set("writers", new List<object>());
                o.Set("hits", 0);
                return o;
            }
            var res = RunEdit(avatar, null, null);
            if (ctx != null)
            {
                List<object> ws = AuditJson.Arr(res, "warnings");
                for (int i = 0; i < ws.Count; i++)
                {
                    string m = Convert.ToString(ws[i], CultureInfo.InvariantCulture);
                    if (!string.IsNullOrEmpty(m)) ctx.Warn("delete_coverage：" + m);
                }
            }
            hits = AuditJson.Int(res, "hits", 0);
            return res;
        }

        // ─────────────────────────────────────────────────────────────
        // 2. 编辑模式量测主流程
        // ─────────────────────────────────────────────────────────────

        sealed class Writer
        {
            public MonoBehaviour component;
            public GameObject go;
            public string writerPath;
            public string hostPath;
            public string target;
            public string key;
            public float thresholdLocal;
        }

        sealed class Region
        {
            public List<int> indices = new List<int>();
            public List<Vector3> world = new List<Vector3>();   // 与 indices 一一对应
            public string source;
            public int primitiveCount;
        }

        static JsonObject RunEdit(GameObject avatar, JsonObject request, List<string> warnings)
        {
            if (warnings == null) warnings = new List<string>();
            double thrMm = request != null ? AuditJson.Num(request, "delete_coverage_threshold_mm", DefaultThresholdMm)
                                           : DefaultThresholdMm;
            if (thrMm <= 0) thrMm = DefaultThresholdMm;
            double minRatio = request != null ? AuditJson.Num(request, "delete_coverage_min_ratio", DefaultMinRatio)
                                              : DefaultMinRatio;

            string onlyAvatar = request != null ? AuditJson.Str(request, "avatar", null) : null;
            if (!string.IsNullOrEmpty(onlyAvatar) && avatar.name != onlyAvatar)
            {
                var fail = new JsonObject();
                fail.Set("tool", Tool);
                fail.Set("mode", "edit");
                fail.Set("error", "场景头像 '" + avatar.name + "' 与请求 avatar='" + onlyAvatar + "' 不符");
                fail.Set("writers", new List<object>());
                fail.Set("hits", 0);
                return fail;
            }

            List<Writer> writers = CollectWriters(avatar, warnings);

            // 状态：缺省一个「当前编辑态」；有 states 就逐个模拟件开/件关。
            List<JsonObject> states = ParseStates(request);
            var regionCache = new Dictionary<string, Region>();

            var stateOut = new List<object>();
            int totalHits = 0, totalNoMesh = 0;
            for (int si = 0; si < states.Count; si++)
            {
                JsonObject st = states[si];
                var toggles = ParseToggles(st);
                var restore = new List<KeyValuePair<GameObject, bool>>();
                ApplyToggles(writers, toggles, restore);

                var rows = new List<object>();
                int stateHits = 0, stateNoMesh = 0;
                try
                {
                    for (int wi = 0; wi < writers.Count; wi++)
                    {
                        JsonObject row = MeasureWriter(avatar, writers[wi], thrMm, minRatio, regionCache);
                        rows.Add(row);
                        if (AuditJson.Bool(row, "host_has_no_mesh", false)) stateNoMesh++;
                        if (AuditJson.Bool(row, "host_visible", false)
                            && AuditJson.Int(row, "deleted_vertices", 0) > 0
                            && AuditJson.Num(row, "uncovered_ratio", 0) >= minRatio) stateHits++;
                    }
                }
                finally
                {
                    RestoreToggles(restore);
                }

                var so = new JsonObject();
                so.Set("id", AuditJson.Str(st, "id", "state" + si));
                var toggleOut = new JsonObject();
                foreach (var kv in toggles) toggleOut.Set(kv.Key, kv.Value);
                so.Set("hosts", toggleOut);
                so.Set("writer_count", rows.Count);
                so.Set("host_has_no_mesh", stateNoMesh);
                so.Set("hits", stateHits);
                so.Set("writers", rows);
                stateOut.Add(so);
                totalHits += stateHits;
                totalNoMesh += stateNoMesh;
            }

            var o = new JsonObject();
            o.Set("tool", Tool);
            o.Set("mode", "edit");
            o.Set("avatar", avatar.name);
            o.Set("scene", AuditUtil.ScenePath(avatar.transform));
            o.Set("threshold_mm", thrMm);
            o.Set("min_ratio", minRatio);
            o.Set("region_rule",
                "删除区 = MA ShapeChanger.Delete 的目标形态键：原始 delta 长度² > m_threshold² 的顶点"
                + "所在三角形整块（AnyVertex），取三角形全部顶点；位置取该键权重 0 的世界坐标（缺口位置）。"
                + "宿主 = 写者 GameObject 及其子树全部 Renderer；uncovered_ratio = 删除区顶点到宿主表面"
                + "最近距离 > threshold_mm 的占比；hits = host_visible 且 deleted_vertices>0 且"
                + " uncovered_ratio ≥ min_ratio 的行数。");
            o.Set("request", request);
            o.Set("writer_count", writers.Count);
            o.Set("state_count", states.Count);
            o.Set("host_has_no_mesh", totalNoMesh);
            o.Set("hits", totalHits);
            o.Set("states", stateOut);
            if (warnings.Count > 0)
            {
                var wl = new List<object>();
                for (int i = 0; i < warnings.Count; i++) wl.Add(warnings[i]);
                o.Set("warnings", wl);
            }
            return o;
        }

        static List<JsonObject> ParseStates(JsonObject request)
        {
            var res = new List<JsonObject>();
            if (request != null)
            {
                List<object> arr = AuditJson.Arr(request, "states");
                for (int i = 0; i < arr.Count; i++)
                {
                    var o = arr[i] as JsonObject;
                    if (o != null) res.Add(o);
                }
            }
            if (res.Count == 0)
            {
                var o = new JsonObject();
                o.Set("id", "edit_current");
                res.Add(o);
            }
            return res;
        }

        static Dictionary<string, bool> ParseToggles(JsonObject state)
        {
            var map = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
            JsonObject src = AuditJson.Obj(state, "params");
            if (src == null) src = AuditJson.Obj(state, "hosts");
            if (src == null) return map;
            foreach (var kv in src.Items)
            {
                object v = kv.Value;
                bool b;
                if (v is bool) b = (bool)v;
                else if (v is double) b = Math.Abs((double)v) > 1e-9;
                else b = AuditJson.Num(src, kv.Key, 0) > 1e-9;
                map[kv.Key] = b;
            }
            return map;
        }

        static void ApplyToggles(List<Writer> writers, Dictionary<string, bool> toggles,
            List<KeyValuePair<GameObject, bool>> restore)
        {
            var done = new HashSet<GameObject>();
            for (int i = 0; i < writers.Count; i++)
            {
                GameObject go = writers[i].go;
                if (go == null || !done.Add(go)) continue;
                bool orig = go.activeSelf;
                bool target = orig;
                foreach (var kv in toggles)
                    if (HostMatches(writers[i].hostPath, go.name, kv.Key)) { target = kv.Value; break; }
                if (target != orig)
                {
                    go.SetActive(target);
                    restore.Add(new KeyValuePair<GameObject, bool>(go, orig));
                }
            }
        }

        static void RestoreToggles(List<KeyValuePair<GameObject, bool>> restore)
        {
            for (int i = restore.Count - 1; i >= 0; i--)
            {
                if (restore[i].Key != null) restore[i].Key.SetActive(restore[i].Value);
            }
        }

        static bool HostMatches(string hostPath, string leaf, string selector)
        {
            if (string.IsNullOrEmpty(selector)) return false;
            if (string.Equals(selector, hostPath, StringComparison.OrdinalIgnoreCase)) return true;
            if (string.Equals(selector, leaf, StringComparison.OrdinalIgnoreCase)) return true;
            if (!string.IsNullOrEmpty(hostPath)
                && hostPath.IndexOf(selector, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (!string.IsNullOrEmpty(leaf)
                && leaf.IndexOf(selector, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        // ─────────────────────────────────────────────────────────────
        // 3. 扫描编辑场景里的 Delete 写者
        // ─────────────────────────────────────────────────────────────

        static List<Writer> CollectWriters(GameObject avatar, List<string> warnings)
        {
            var res = new List<Writer>();
            if (avatar == null) return res;
            Transform aroot = avatar.transform;

            MonoBehaviour[] all = Resources.FindObjectsOfTypeAll<MonoBehaviour>();
            for (int i = 0; i < all.Length; i++)
            {
                MonoBehaviour mb = all[i];
                if (mb == null) continue;
                if (mb.GetType().Name != "ModularAvatarShapeChanger") continue;
                GameObject go = mb.gameObject;
                if (go == null) continue;
                if (EditorUtility.IsPersistent(go)) continue;   // 预制体资产，不是场景对象
                if (!go.scene.IsValid()) continue;
                if (FindAvatarRoot(mb.transform) != aroot) continue;

                object shapesObj = GetMember(mb, "m_shapes");
                if (shapesObj == null) shapesObj = GetMember(mb, "Shapes");
                var en = shapesObj as IEnumerable;
                if (en == null)
                {
                    if (warnings != null)
                        warnings.Add("ShapeChanger 读不到 m_shapes/Shapes，跳过：" + AuditUtil.ScenePath(mb.transform));
                    continue;
                }

                float maThr = ReadMaThreshold(mb);
                string writerPath = AuditUtil.RelPath(aroot, mb.transform);
                foreach (object shape in en)
                {
                    if (shape == null) continue;
                    object ct = GetMember(shape, "ChangeType");
                    string ctName = ct != null ? ct.ToString() : null;
                    if (!string.Equals(ctName, "Delete", StringComparison.OrdinalIgnoreCase)) continue;

                    string key = GetMember(shape, "ShapeName") as string;
                    if (string.IsNullOrEmpty(key))
                    {
                        if (warnings != null) warnings.Add("Delete 写者缺 ShapeName，跳过：" + writerPath);
                        continue;
                    }
                    object objRef = GetMember(shape, "Object");
                    string target = ResolveAvatarObjectRef(aroot, objRef);

                    res.Add(new Writer
                    {
                        component = mb,
                        go = go,
                        writerPath = writerPath,
                        hostPath = writerPath,     // 宿主 = 写者自己那件（只认谁删谁盖）
                        target = target,
                        key = key,
                        thresholdLocal = maThr,
                    });
                }
            }
            // 稳定排序，输出可 diff
            res.Sort((a, b) =>
            {
                int c = string.CompareOrdinal(a.writerPath, b.writerPath);
                return c != 0 ? c : string.CompareOrdinal(a.key, b.key);
            });
            return res;
        }

        static float ReadMaThreshold(MonoBehaviour mb)
        {
            object v = GetMember(mb, "m_threshold");
            if (v == null) v = GetMember(mb, "Threshold");
            if (v == null) return DefaultMaThreshold;
            try
            {
                float f = Convert.ToSingle(v, CultureInfo.InvariantCulture);
                if (f <= 0f) return DefaultMaThreshold;
                return f;
            }
            catch { return DefaultMaThreshold; }
        }

        // ─────────────────────────────────────────────────────────────
        // 4. 单写者量测
        // ─────────────────────────────────────────────────────────────

        static JsonObject MeasureWriter(GameObject avatar, Writer w, double thrMm, double minRatio,
            Dictionary<string, Region> cache)
        {
            Transform aroot = avatar != null ? avatar.transform : null;
            var row = new JsonObject();
            row.Set("writer_path", w.writerPath);
            row.Set("host_path", w.hostPath);
            row.Set("target", w.target);
            row.Set("key", w.key);
            row.Set("threshold_local", w.thresholdLocal);
            row.Set("threshold_mm", thrMm);

            if (aroot == null)
            {
                row.Set("error", "没有头像根");
                row.Set("deleted_vertices", 0);
                row.Set("uncovered_ratio", 0.0);
                return row;
            }

            Transform hostT = ResolvePath(aroot, w.hostPath);
            List<Renderer> hostRends = HostRenderers(hostT);
            bool hostVisible = false;
            for (int i = 0; i < hostRends.Count; i++)
            {
                Renderer r = hostRends[i];
                if (r != null && r.gameObject.activeInHierarchy && r.enabled) { hostVisible = true; break; }
            }
            row.Set("host_visible", hostVisible);
            row.Set("host_renderers", hostRends.Count);

            Transform targetT = ResolvePath(aroot, w.target);
            SkinnedMeshRenderer tsmr = FindTargetSmr(targetT);
            if (tsmr == null || tsmr.sharedMesh == null)
            {
                row.Set("error", "目标网格解析不到（target='" + w.target + "'）");
                row.Set("deleted_vertices", 0);
                row.Set("uncovered_ratio", 0.0);
                row.Set("p50_mm", 0.0);
                row.Set("p95_mm", 0.0);
                row.Set("max_mm", 0.0);
                row.Set("sample_uncovered", new List<object>());
                row.Set("host_has_no_mesh", false);
                return row;
            }

            int sidx = tsmr.sharedMesh.GetBlendShapeIndex(w.key);
            if (sidx < 0)
            {
                row.Set("error", "目标网格里没有形态键 '" + w.key + "'");
                row.Set("deleted_vertices", 0);
                row.Set("uncovered_ratio", 0.0);
                row.Set("p50_mm", 0.0);
                row.Set("p95_mm", 0.0);
                row.Set("max_mm", 0.0);
                row.Set("sample_uncovered", new List<object>());
                row.Set("host_has_no_mesh", false);
                return row;
            }

            string ck = w.writerPath + "|" + w.key + "|" + w.thresholdLocal.ToString("R", CultureInfo.InvariantCulture)
                        + "|" + w.target;
            Region region;
            if (!cache.TryGetValue(ck, out region))
            {
                region = ComputeRegion(tsmr, sidx, w.thresholdLocal);
                cache[ck] = region;
            }
            row.Set("region_source", region.source);
            row.Set("primitive_count", region.primitiveCount);
            row.Set("deleted_vertices", region.indices.Count);

            TriSoup host = BuildHostSoup(hostRends);
            if (host == null || host.TriCount == 0)
            {
                // 写者挂在无网格容器上：照样出行，不跳过。
                row.Set("host_has_no_mesh", true);
                row.Set("error", "host_has_no_mesh：宿主件及其子树没有可用网格三角形（host='"
                    + w.hostPath + "'）");
                row.Set("uncovered_ratio", 1.0);
                row.Set("uncovered_vertices", region.indices.Count);
                row.Set("p50_mm", 0.0);
                row.Set("p95_mm", 0.0);
                row.Set("max_mm", 0.0);
                row.Set("sample_uncovered", new List<object>());
                if (host != null) host.Dispose();
                return row;
            }
            row.Set("host_has_no_mesh", false);

            try
            {
                double thrM = thrMm / 1000.0;
                var dist = new List<float>(region.world.Count);
                var un = new List<object>(5);
                for (int i = 0; i < region.world.Count; i++)
                {
                    Vector3 p = region.world[i];
                    if (float.IsNaN(p.x) || float.IsNaN(p.y) || float.IsNaN(p.z)) continue;
                    float d = host.NearestDistance(p);
                    dist.Add(d);
                    if (d > thrM && un.Count < 5) un.Add(new float[] { p.x, p.y, p.z });
                }
                int uncovered = 0;
                for (int i = 0; i < dist.Count; i++) if (dist[i] > thrM) uncovered++;
                double ratio = dist.Count == 0 ? 0.0 : (double)uncovered / dist.Count;

                row.Set("uncovered_vertices", uncovered);
                row.Set("uncovered_ratio", ratio);
                row.Set("p50_mm", dist.Count == 0 ? 0.0 : Pctl(dist, 50.0) * 1000.0);
                row.Set("p95_mm", dist.Count == 0 ? 0.0 : Pctl(dist, 95.0) * 1000.0);
                row.Set("max_mm", dist.Count == 0 ? 0.0 : Max(dist) * 1000.0);
                row.Set("sample_uncovered", un);
                return row;
            }
            finally
            {
                host.Dispose();
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 5. 几何：删除区 / 宿主网格 / 点到三角形
        // ─────────────────────────────────────────────────────────────

        /// <summary>
        /// 删除区：按 MA VertexFilterByShape 语义（delta² &gt; threshold² + 图元级 AnyVertex）取
        /// 命中图元的全部顶点，并给出这些顶点在**该键权重 0** 的世界坐标（缺口位置）。
        /// </summary>
        static Region ComputeRegion(SkinnedMeshRenderer smr, int sidx, float thresholdLocal)
        {
            var reg = new Region();
            Mesh baseM = NewScratchMesh();      // 权重 0 的世界网格（缺口位置 + triangles 来源）
            Mesh zeroL = NewScratchMesh();      // 权重 0 的局部网格（退路 delta 用）
            Mesh hundredL = NewScratchMesh();   // 权重 100 的局部网格（退路 delta 用）
            float old = 0f;
            try
            {
                old = smr.GetBlendShapeWeight(sidx);
                smr.SetBlendShapeWeight(sidx, 0f);
                BakeWorld(smr, baseM);

                int vc = baseM.vertexCount;
                bool[] mask = new bool[vc];
                float thr2 = thresholdLocal * thresholdLocal;
                bool assetDelta = false;

                // 优先用原始网格的形态键 delta（MA 就是读这个，单位=网格局部）
                try
                {
                    Mesh am = smr.sharedMesh;
                    if (am != null)
                    {
                        int frames = am.GetBlendShapeFrameCount(sidx);
                        if (frames > 0)
                        {
                            var delta = new Vector3[am.vertexCount];
                            for (int f = 0; f < frames; f++)
                            {
                                am.GetBlendShapeFrameVertices(sidx, f, delta, null, null);
                                int n = Mathf.Min(vc, delta.Length);
                                for (int v = 0; v < n; v++)
                                    if (delta[v].sqrMagnitude > thr2) mask[v] = true;
                            }
                            assetDelta = true;
                        }
                    }
                }
                catch (Exception)
                {
                    assetDelta = false;
                }

                if (!assetDelta)
                {
                    // 退路：BakeMesh(m,true) 0/100 的局部差值（含 SMR scale）。
                    // baseM 保持世界网格不动（位置与三角形都用它）。
                    BakeLocal(smr, zeroL);
                    smr.SetBlendShapeWeight(sidx, 100f);
                    BakeLocal(smr, hundredL);
                    var a = zeroL.vertices;
                    var b = hundredL.vertices;
                    int n = Mathf.Min(Mathf.Min(vc, a.Length), b.Length);
                    for (int v = 0; v < n; v++)
                        if ((b[v] - a[v]).sqrMagnitude > thr2) mask[v] = true;
                }

                // 图元级 AnyVertex
                int[] tris;
                try { tris = baseM.triangles; }
                catch (Exception) { tris = new int[0]; }
                if (tris.Length == 0)
                {
                    // 拿不到三角形就退化为顶点级（记进 source）
                    for (int v = 0; v < vc; v++) if (mask[v]) reg.indices.Add(v);
                    reg.source = (assetDelta ? "asset_delta" : "bakemesh_delta_fallback") + "_vertexonly";
                }
                else
                {
                    var keep = new HashSet<int>();
                    int prims = 0;
                    for (int t = 0; t + 2 < tris.Length; t += 3)
                    {
                        int a = tris[t], b = tris[t + 1], c = tris[t + 2];
                        if (a < 0 || b < 0 || c < 0 || a >= vc || b >= vc || c >= vc) continue;
                        if (mask[a] || mask[b] || mask[c])
                        {
                            keep.Add(a); keep.Add(b); keep.Add(c);
                            prims++;
                        }
                    }
                    reg.indices.AddRange(keep);
                    reg.indices.Sort();
                    reg.primitiveCount = prims;
                    reg.source = assetDelta ? "asset_delta_primitive" : "bakemesh_delta_fallback_primitive";
                }

                Vector3[] vv = baseM.vertices;
                for (int i = 0; i < reg.indices.Count; i++)
                {
                    int idx = reg.indices[i];
                    reg.world.Add(idx >= 0 && idx < vv.Length ? vv[idx] : new Vector3(float.NaN, float.NaN, float.NaN));
                }
                reg.indices.Capacity = reg.indices.Count;
                return reg;
            }
            finally
            {
                try { smr.SetBlendShapeWeight(sidx, old); } catch { }
                Object.DestroyImmediate(baseM);
                Object.DestroyImmediate(zeroL);
                Object.DestroyImmediate(hundredL);
            }
        }

        static Mesh NewScratchMesh()
        {
            var m = new Mesh();
            m.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32;
            m.hideFlags = HideFlags.HideAndDontSave;
            return m;
        }

        /// <summary>BakeMesh(m, true) 后按 SMR 的 localToWorldMatrix 转世界坐标。</summary>
        static void BakeWorld(SkinnedMeshRenderer smr, Mesh into)
        {
            smr.BakeMesh(into, true);
            Vector3[] v = into.vertices;
            Matrix4x4 mat = smr.transform.localToWorldMatrix;
            for (int i = 0; i < v.Length; i++) v[i] = mat.MultiplyPoint3x4(v[i]);
            into.vertices = v;
            into.RecalculateBounds();
        }

        /// <summary>BakeMesh(m, true) 原样（SMR 局部空间）。</summary>
        static void BakeLocal(SkinnedMeshRenderer smr, Mesh into)
        {
            smr.BakeMesh(into, true);
        }

        /// <summary>任意 Renderer 的世界坐标网格（SMR 走 BakeMesh；MeshRenderer 走 sharedMesh+localToWorld）。</summary>
        static Mesh MeshWorldOf(Renderer r)
        {
            if (r == null) return null;
            var smr = r as SkinnedMeshRenderer;
            if (smr != null)
            {
                if (smr.sharedMesh == null) return null;
                var m = NewScratchMesh();
                try { BakeWorld(smr, m); return m; }
                catch (Exception) { Object.DestroyImmediate(m); return null; }
            }

            var mf = r.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) return null;
            Mesh src = mf.sharedMesh;
            var m2 = NewScratchMesh();
            try
            {
                Vector3[] v = src.vertices;
                int[] t = src.triangles;
                Matrix4x4 mat = r.transform.localToWorldMatrix;
                for (int i = 0; i < v.Length; i++) v[i] = mat.MultiplyPoint3x4(v[i]);
                m2.vertices = v;
                m2.triangles = t;
                m2.RecalculateBounds();
                return m2;
            }
            catch (Exception) { Object.DestroyImmediate(m2); return null; }
        }

        static TriSoup BuildHostSoup(List<Renderer> rends)
        {
            var verts = new List<Vector3>();
            var tris = new List<int>();
            for (int i = 0; i < rends.Count; i++)
            {
                Mesh m = MeshWorldOf(rends[i]);
                if (m == null) continue;
                int baseIdx = verts.Count;
                Vector3[] v = m.vertices;
                int[] t = m.triangles;
                for (int k = 0; k < v.Length; k++) verts.Add(v[k]);
                for (int k = 0; k + 2 < t.Length; k += 3)
                {
                    tris.Add(baseIdx + t[k]);
                    tris.Add(baseIdx + t[k + 1]);
                    tris.Add(baseIdx + t[k + 2]);
                }
                Object.DestroyImmediate(m);
            }
            if (tris.Count == 0) return null;
            return new TriSoup(verts.ToArray(), tris.ToArray());
        }

        /// <summary>扁平三角形汤 + 均匀网格加速。最近距离：查询 27 个邻格；格内没找到或最近距离
        /// 超过格边长时退回暴力全扫，保证数值精确（格边长 30 mm ≥ 阈值 15 mm）。</summary>
        sealed class TriSoup : IDisposable
        {
            readonly Vector3[] _v;
            readonly int[] _t;
            readonly Dictionary<(int, int, int), List<int>> _grid;
            readonly bool _brute;

            public int TriCount { get { return _t.Length / 3; } }

            public TriSoup(Vector3[] v, int[] t)
            {
                _v = v;
                _t = t;
                _grid = new Dictionary<(int, int, int), List<int>>();
                for (int i = 0; i < TriCount; i++)
                {
                    Vector3 a = _v[_t[3 * i]], b = _v[_t[3 * i + 1]], c = _v[_t[3 * i + 2]];
                    Vector3 mn = Vector3.Min(a, Vector3.Min(b, c));
                    Vector3 mx = Vector3.Max(a, Vector3.Max(b, c));
                    int x0 = Cell(mn.x), x1 = Cell(mx.x);
                    int y0 = Cell(mn.y), y1 = Cell(mx.y);
                    int z0 = Cell(mn.z), z1 = Cell(mx.z);
                    long cells = (long)(x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
                    if (cells > GridCellsPerTriCap) { _brute = true; return; }
                    for (int x = x0; x <= x1; x++)
                        for (int y = y0; y <= y1; y++)
                            for (int z = z0; z <= z1; z++)
                            {
                                var key = (x, y, z);
                                List<int> l;
                                if (!_grid.TryGetValue(key, out l)) { l = new List<int>(); _grid[key] = l; }
                                l.Add(i);
                            }
                }
            }

            static int Cell(float v) { return Mathf.FloorToInt(v / GridCellM); }

            public float NearestDistance(Vector3 p)
            {
                float best = float.MaxValue;
                bool found = false;
                if (!_brute)
                {
                    int cx = Cell(p.x), cy = Cell(p.y), cz = Cell(p.z);
                    for (int dx = -1; dx <= 1; dx++)
                        for (int dy = -1; dy <= 1; dy++)
                            for (int dz = -1; dz <= 1; dz++)
                            {
                                List<int> l;
                                if (!_grid.TryGetValue((cx + dx, cy + dy, cz + dz), out l)) continue;
                                for (int k = 0; k < l.Count; k++)
                                {
                                    float d = TriDistance(l[k], p);
                                    if (d < best) best = d;
                                    found = true;
                                }
                            }
                }
                if (_brute || !found || best > GridCellM)
                {
                    best = float.MaxValue;
                    for (int i = 0; i < TriCount; i++)
                    {
                        float d = TriDistance(i, p);
                        if (d < best) best = d;
                    }
                }
                return best;
            }

            float TriDistance(int tri, Vector3 p)
            {
                int i = 3 * tri;
                return DistPointTriangle(p, _v[_t[i]], _v[_t[i + 1]], _v[_t[i + 2]]);
            }

            public void Dispose() { }
        }

        /// <summary>点到三角形最近距离（Ericson, Real-Time Collision Detection）。</summary>
        static float DistPointTriangle(Vector3 p, Vector3 a, Vector3 b, Vector3 c)
        {
            Vector3 ab = b - a, ac = c - a, ap = p - a;
            float d1 = Vector3.Dot(ab, ap), d2 = Vector3.Dot(ac, ap);
            if (d1 <= 0f && d2 <= 0f) return (p - a).magnitude;

            Vector3 bp = p - b;
            float d3 = Vector3.Dot(ab, bp), d4 = Vector3.Dot(ac, bp);
            if (d3 >= 0f && d4 <= d3) return (p - b).magnitude;

            float vc = d1 * d4 - d3 * d2;
            if (vc <= 0f && d1 >= 0f && d3 <= 0f)
            {
                float v = d1 / (d1 - d3);
                return (p - (a + v * ab)).magnitude;
            }

            Vector3 cp = p - c;
            float d5 = Vector3.Dot(ab, cp), d6 = Vector3.Dot(ac, cp);
            if (d6 >= 0f && d5 <= d6) return (p - c).magnitude;

            float vb = d5 * d2 - d1 * d6;
            if (vb <= 0f && d2 >= 0f && d6 <= 0f)
            {
                float w = d2 / (d2 - d6);
                return (p - (a + w * ac)).magnitude;
            }

            float va = d3 * d6 - d5 * d4;
            if (va <= 0f && (d4 - d3) >= 0f && (d5 - d6) >= 0f)
            {
                float w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                return (p - (b + w * (c - b))).magnitude;
            }

            float denom = 1f / (va + vb + vc);
            float vv = vb * denom, ww = vc * denom;
            return (p - (a + ab * vv + ac * ww)).magnitude;
        }

        // ─────────────────────────────────────────────────────────────
        // 6. 小工具：反射 / 路径 / 统计
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

        static Transform FindAvatarRoot(Transform t)
        {
            while (t != null)
            {
                if (AuditAvatar.FindDescriptor(t.gameObject) != null) return t;
                t = t.parent;
            }
            return null;
        }

        /// <summary>MA AvatarObjectReference → 头像根相对路径（与 AuditPartInventory 同判据）。</summary>
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
            return aroot.Find(refPath) != null ? refPath : null;
        }

        static Transform ResolvePath(Transform root, string path)
        {
            if (root == null) return null;
            if (string.IsNullOrEmpty(path) || path == ".") return root;
            Transform direct = root.Find(path);
            if (direct != null) return direct;
            string[] segs = path.Replace('\\', '/').Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            Transform cur = root;
            for (int i = 0; i < segs.Length; i++)
            {
                string seg = segs[i].Trim();
                if (seg == "." || seg.Length == 0) continue;
                Transform next = cur.Find(seg);
                if (next == null) { cur = null; break; }
                cur = next;
            }
            if (cur != null && cur != root) return cur;
            Transform[] all = root.GetComponentsInChildren<Transform>(true);
            for (int i = 0; i < all.Length; i++)
                if (AuditUtil.RelPath(root, all[i]) == path) return all[i];
            return null;
        }

        static SkinnedMeshRenderer FindTargetSmr(Transform t)
        {
            if (t == null) return null;
            var smr = t.GetComponent<SkinnedMeshRenderer>();
            if (smr != null) return smr;
            return t.GetComponentInChildren<SkinnedMeshRenderer>(true);
        }

        static List<Renderer> HostRenderers(Transform host)
        {
            var list = new List<Renderer>();
            if (host == null) return list;
            Renderer[] all = host.GetComponentsInChildren<Renderer>(true);
            for (int i = 0; i < all.Length; i++)
            {
                Renderer r = all[i];
                if (r == null) continue;
                if (r is SkinnedMeshRenderer || r.GetComponent<MeshFilter>() != null) list.Add(r);
            }
            return list;
        }

        static double Pctl(List<float> vals, double p)
        {
            if (vals == null || vals.Count == 0) return 0.0;
            float[] a = vals.ToArray();
            Array.Sort(a);
            int n = a.Length;
            if (n == 1) return a[0];
            double idx = p / 100.0 * (n - 1);
            int lo = (int)Math.Floor(idx), hi = (int)Math.Ceiling(idx);
            if (lo == hi) return a[lo];
            double f = idx - lo;
            return a[lo] * (1.0 - f) + a[hi] * f;
        }

        static float Max(List<float> vals)
        {
            float m = 0f;
            for (int i = 0; i < vals.Count; i++) if (vals[i] > m) m = vals[i];
            return m;
        }
    }
}
