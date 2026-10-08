// ══════════════════════════════════════════════════════════════════
// 【项目沉淀】通用工具 · 审查/修复「给衣物补形态键帧」（乳贴补帧）
// 适用素体：任意 Humanoid 头像（Unity 2022.3.22f1；编辑模式，场景真实骨骼）
// 相关素材：工程D Esmera `Breast_Bandage`（厂商网格只有 `Breast_Big(mizuki)`，缺 `Breast_small`
//           / `Breast_big(limit)`）；示例见 `examples/nipple_patch_frames_request.json`
// 工具链　：Unity 2022.3.22f1（Editor 程序集 AvatarAudit.Editor）
// 可复用性：★★★ 随 `审查/unity/` 一起由 perception/sync_audit.py 同步进工程
//
// 用途：把「工程D乳贴补帧」那约 40 行手工 execute_code 落成可复跑菜单动作——编辑模式量出身体
//   某个形态键 0→100 的世界位移场，用最近 4 点反距离加权搬到件（乳贴）的每个顶点，再用件的
//   蒙皮矩阵逆换回网格空间，`Instantiate(原网格)` + `AddBlendShapeFrame(键名, 100, 位移, null, null)`
//   存成 `.asset`；可选只把渲染器 `sharedMesh` 换上新网格（骨骼/材质/Transform 不动）。
//
// ── 来源 ────────────────────────────────────────────────────────────
//   · `_长程任务_20260918/进度核查_20260919/testdocs.md:219`：「乳贴补帧用的是 Unity 里『约 40 行
//     execute_code』（SOP 给衣物补形态键.md）。施工记录和 SOP 都没给脚本路径，是否有脚本落盘无法确认」。
//   · `工程D/_施工记录.md:75-88`（2026-09-19 00:29 与 02:29 两条）：补
//     `Breast_small_____胸_小`（asset 第一帧）与 `Breast_big(limit)`（同法第三帧）；只换
//     `sharedMesh`、不 Apply 到厂商预制体；世界位移 max 17.19 / 23.4 mm。
//   · SOP `开发工具/SOP/50_服装发型装配/给衣物补形态键.md`：首选做法四步（BakeMesh 0/100 → 件顶点
//     最近 4 点反距离加权 → 蒙皮矩阵逆回网格空间 → AddBlendShapeFrame 存 asset）；验收量距；
//     末节「Play 里别换网格」。
//   · **原件未找到**：手工 `execute_code` 未落盘，本文件按 SOP 四步与施工记录重写；帧名 / 键名 /
//     对象路径抄原件，位移量级只写进 report 供与记录（17.19 / 23.4 mm）对照，不在源里硬编码数字。
//   待 Unity 验收：本文件尚未在 Unity 里实跑过（离线只做编译）。
//
// ── 请求 JSON 字段表（`<工程>/Library/AvatarAudit/nipple_patch_frames_request.json`）──
//   tool              可选，自描述 "nipple_patch_frames"
//   out               必填，输出目录（绝对路径）；report.json 写这里
//   avatar            必填，头像根名（面捕克隆两个同名根时脚本报错并列出）
//   body              必填，身体渲染器（头像根相对路径 / 叶名 / 子串），如 "Body_b"
//   target            必填，要补帧的件渲染器（同上），如 "Esmera_For_Rurune 7/Breast_Bandage"
//   frames            必填，[{name, source, low?, high?}]：
//                        name   = 写到件上的键名（如 "Breast_small_____胸_小"）
//                        source = 身体上取位移场的键名（同 name，或身体叫别的名）
//                        low/high = 烘焙两端，默认 0 / 100
//   neighbors         可选，默认 4；最近邻反距离加权的点数
//   asset_path        必填，新网格资产落盘路径（工程相对，如
//                       "Assets/_Work/Esmera_BreastSmall/Breast_Bandage_BreastSmall.asset"）
//   apply_to_renderer 可选，默认 false；true = 顺手把 target.sharedMesh 换成新网格（骨骼/材质不动）。
//                       手工版换了；审查默认只产资产，避免动场景。
//
// ── 和手工版的差异 ──────────────────────────────────────────────────
//   1. 手工版是 MCP `execute_code` 会话里跑、没落盘；脚本一个菜单动作完成并写 report.json。
//   2. 手工版换 `sharedMesh` + 加 MA BlendshapeSync 都在同一步做；本脚本默认只产 `.asset`
//      （apply_to_renderer=false），**MA BlendshapeSync 接线不在本脚本范围**（那是对场景的修复，
//      不是「补帧」；脚本在 report 里提示需另接）。要直接改件需显式 apply_to_renderer=true。
//   3. 手工版的位移场按 SOP 写成「蒙皮矩阵 Σw·(worldToLocal·bone·bindpose) 的逆」；本脚本先把
//      BakeMesh 顶点乘 `localToWorld` 得到**真世界**位移，所以用等价的 S=Σw·(bone.localToWorld·bindpose)
//      再求逆（M = worldToLocal·S，M⁻¹·局部位移 = S⁻¹·世界位移，同一结果）。口径差异写进 report。
//   4. 手工版没留中间量；脚本把每帧位移的 max/mean（网格空间 mm）与顶点数写进 report，便于与
//      施工记录（max 17.19 / 23.4 mm）对照复算。
// ══════════════════════════════════════════════════════════════════

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace AvatarAudit
{
    public static class NipplePatchFrames
    {
        public const string Tool = "nipple_patch_frames";
        public const string DefaultRequestRel = "Library/AvatarAudit/nipple_patch_frames_request.json";
        public const string ScriptRel = "开发工具/通用工具/审查/unity/Editor/NipplePatchFrames.cs";
        private const string LogTag = "[NipplePatchFrames]";

        [MenuItem("Tools/AvatarAudit/Nipple Patch Frames (Edit Mode)", false, 124)]
        public static void RunFromMenu()
        {
            string reqPath = UnderProject(DefaultRequestRel);
            if (!File.Exists(reqPath))
            {
                Debug.LogError(LogTag + " FAIL 找不到请求文件 " + reqPath + "（先按 examples/ 写一份）");
                return;
            }
            // 重活（两两顶点距离 + 建网格资产）放 delayCall，别卡住菜单事件。
            EditorApplication.delayCall += () => Run(reqPath);
        }

        // ─────────────────────────────────────────────────────────────
        // 主流程
        // ─────────────────────────────────────────────────────────────
        private static void Run(string reqPath)
        {
            var warnings = new List<string>();
            var frameReports = new List<object>();
            JsonObject req = null;
            string outDir = null;
            bool failed = false, applied = false;
            string failReason = null;
            string bodyPath = "", targetPath = "", assetPath = "";
            string meshSpaceConvention = null;
            int bodyCount = 0, targetCount = 0;
            GameObject avatar = null;

            try
            {
                req = AuditJson.Parse(File.ReadAllText(reqPath, Encoding.UTF8)) as JsonObject;
                if (req == null) throw new Exception("请求 JSON 顶层必须是对象");
                outDir = AuditJson.Str(req, "out", null);
                if (string.IsNullOrEmpty(outDir)) outDir = DefaultOutDir();
                Directory.CreateDirectory(outDir);

                avatar = AuditAvatar.Resolve(AuditJson.Str(req, "avatar", null));
                var body = Resolve(avatar, AuditJson.Str(req, "body", null), out bodyPath);
                var target = Resolve(avatar, AuditJson.Str(req, "target", null), out targetPath);
                if (body == null) throw new Exception("找不到身体渲染器 body='" + AuditJson.Str(req, "body", null) + "'");
                if (target == null) throw new Exception("找不到件渲染器 target='" + AuditJson.Str(req, "target", null) + "'");
                assetPath = AuditJson.Str(req, "asset_path", null);
                if (string.IsNullOrEmpty(assetPath)) throw new Exception("请求缺少 asset_path");

                var frames = AuditJson.Arr(req, "frames");
                if (frames.Count == 0) throw new Exception("请求缺少 frames（[{name, source, low, high}]）");
                int neighbors = Mathf.Clamp(AuditJson.Int(req, "neighbors", 4), 1, 8);
                bool apply = AuditJson.Bool(req, "apply_to_renderer", false);

                // 件顶点世界坐标（BakeMesh 一次；用烘焙网格，避免依赖 sharedMesh 可读）
                var targetBaked = Bake(target);
                if (targetBaked == null || targetBaked.vertexCount == 0) throw new Exception("件 BakeMesh 为空");
                targetCount = targetBaked.vertexCount;
                var targetWorld = ToWorld(target, targetBaked.vertices);
                UnityEngine.Object.DestroyImmediate(targetBaked);   // 顶点已拷出，别再占 HideAndDontSave

                int[] nnIdx; float[] nnW;
                Vector3[] bodyLow, bodyDelta;
                // 最近邻映射只跟几何有关，第一帧算一次即可（后续帧复用）
                BuildBodyField(body, frames[0] as JsonObject, out bodyLow, out bodyDelta, bodyCountCheck: out bodyCount);
                BuildNeighbors(targetWorld, bodyLow, neighbors, out nnIdx, out nnW);

                var outMesh = UnityEngine.Object.Instantiate(target.sharedMesh);
                outMesh.name = (target.sharedMesh != null ? target.sharedMesh.name : "mesh") + "_patched";
                meshSpaceConvention = "BakeMesh(_,true)×localToWorld 得真世界；网格位移=S⁻¹·世界位移，"
                    + "S=Σw·(bone.localToWorld·bindpose)（等价 SOP 的 M=worldToLocal·S，M⁻¹·局部位移）";
                for (int f = 0; f < frames.Count; f++)
                {
                    var fo = frames[f] as JsonObject;
                    if (fo == null) throw new Exception("frames[" + f + "] 不是对象");
                    string name = AuditJson.Str(fo, "name", null);
                    string source = AuditJson.Str(fo, "source", name);
                    float low = (float)AuditJson.Num(fo, "low", 0);
                    float high = (float)AuditJson.Num(fo, "high", 100);
                    if (string.IsNullOrEmpty(name)) throw new Exception("frames[" + f + "] 缺 name");
                    if (!HasKey(body, source)) { warnings.Add("身体没有键 '" + source + "'，帧 '" + name + "' 跳过"); continue; }

                    BakeBodyField(body, source, low, high, out bodyLow, out bodyDelta, warnings);
                    var deltaMesh = TransferToMesh(target, targetCount, nnIdx, nnW, bodyLow, bodyDelta, warnings);

                    // 键已存在就补一帧；不存在则新建形状（AddBlendShapeFrame 两者都支持）
                    outMesh.AddBlendShapeFrame(name, 100f, deltaMesh, null, null);

                    var fr = new JsonObject();
                    fr.Set("name", name);
                    fr.Set("source", source);
                    fr.Set("low", (double)low);
                    fr.Set("high", (double)high);
                    fr.Set("vertex_count", deltaMesh.Length);
                    fr.Set("delta_mesh_max_mm", (double)(MaxLen(deltaMesh) * 1000f));
                    fr.Set("delta_mesh_mean_mm", (double)(MeanLen(deltaMesh) * 1000f));
                    fr.Set("neighbors", neighbors);
                    frameReports.Add(fr);
                }

                if (frameReports.Count == 0) throw new Exception("没有任何帧被写上（source 键都不存在？）");

                EnsureAssetFolder(assetPath);
                if (AssetDatabase.LoadAssetAtPath<Mesh>(assetPath) != null) AssetDatabase.DeleteAsset(assetPath);
                AssetDatabase.CreateAsset(outMesh, assetPath);
                AssetDatabase.SaveAssets();
                applied = apply;
                if (apply) target.sharedMesh = outMesh;
                Debug.Log(LogTag + " 已写 " + frameReports.Count + " 帧 → " + assetPath
                          + (apply ? "（并换上件 sharedMesh）" : "（未改场景，仅产资产）"));
            }
            catch (Exception e)
            {
                failed = true; failReason = e.Message;
                Debug.LogError(LogTag + " 处理失败：" + e);
            }

            // ── report ──
            var rep = new JsonObject();
            rep.Set("tool", Tool);
            rep.Set("script", ScriptRel);
            rep.Set("result", failed ? "FAIL" : "DONE");
            if (failed) rep.Set("fail_reason", failReason);
            rep.Set("request", reqPath);
            rep.Set("out", outDir);
            rep.Set("avatar", avatar != null ? avatar.name : null);
            rep.Set("body", bodyPath);
            rep.Set("target", targetPath);
            rep.Set("body_vertex_count", bodyCount);
            rep.Set("target_vertex_count", targetCount);
            rep.Set("asset_path", assetPath);
            rep.Set("applied_to_renderer", applied);
            rep.Set("mesh_space_convention", meshSpaceConvention);
            rep.Set("frames", frameReports);
            var warns = new List<object>();
            for (int i = 0; i < warnings.Count; i++) warns.Add(warnings[i]);
            rep.Set("warnings", warns);
            rep.Set("manual_diff", ManualDiff());
            rep.Set("source", SourceRefs());
            rep.Set("unity_verified", false);
            rep.Set("note", "本轮只做离线编译；Unity 实跑、补帧后乳贴到身体距离（p50 1.28/1.66 mm）取证待验收。");
            try { AuditJson.WriteFile(Path.Combine(outDir, "report.json"), rep); }
            catch (Exception e) { Debug.LogError(LogTag + " 写 report.json 失败：" + e.Message); }

            if (failed) Debug.LogError(LogTag + " FAIL " + failReason);
            else Debug.Log(LogTag + " DONE 帧 " + frameReports.Count + " 个，report=" + Path.Combine(outDir, "report.json"));
        }

        // ─────────────────────────────────────────────────────────────
        // 位移场：身体键 low/high 各 BakeMesh → 世界顶点；deltaWorld=high−low
        // ─────────────────────────────────────────────────────────────
        private static void BuildBodyField(SkinnedMeshRenderer body, JsonObject frame,
            out Vector3[] lowWorld, out Vector3[] deltaWorld, out int bodyCountCheck)
        {
            string source = frame != null ? AuditJson.Str(frame, "source", AuditJson.Str(frame, "name", null)) : null;
            float low = frame != null ? (float)AuditJson.Num(frame, "low", 0) : 0f;
            float high = frame != null ? (float)AuditJson.Num(frame, "high", 100) : 100f;
            BakeBodyField(body, source, low, high, out lowWorld, out deltaWorld, new List<string>());
            bodyCountCheck = lowWorld != null ? lowWorld.Length : 0;
        }

        private static void BakeBodyField(SkinnedMeshRenderer body, string source, float low, float high,
            out Vector3[] lowWorld, out Vector3[] deltaWorld, List<string> warnings)
        {
            int idx = body.sharedMesh != null ? body.sharedMesh.GetBlendShapeIndex(source) : -1;
            if (idx < 0)
            {
                lowWorld = new Vector3[0]; deltaWorld = new Vector3[0];
                warnings.Add("身体没有键 '" + source + "'");
                return;
            }
            float before = body.GetBlendShapeWeight(idx);
            Mesh b0 = null, b1 = null;
            try
            {
                body.SetBlendShapeWeight(idx, low);
                b0 = Bake(body);
                body.SetBlendShapeWeight(idx, high);
                b1 = Bake(body);
                Vector3[] w0 = ToWorld(body, b0.vertices);
                Vector3[] w1 = ToWorld(body, b1.vertices);
                int n = Mathf.Min(w0.Length, w1.Length);
                lowWorld = new Vector3[n];
                deltaWorld = new Vector3[n];
                for (int i = 0; i < n; i++) { lowWorld[i] = w0[i]; deltaWorld[i] = w1[i] - w0[i]; }
            }
            finally
            {
                body.SetBlendShapeWeight(idx, before);
                if (b0 != null) UnityEngine.Object.DestroyImmediate(b0);
                if (b1 != null) UnityEngine.Object.DestroyImmediate(b1);
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 最近 k 点反距离加权 → 世界位移；再换回网格空间
        // ─────────────────────────────────────────────────────────────
        private static void BuildNeighbors(Vector3[] targetWorld, Vector3[] bodyLow, int k,
            out int[] idx, out float[] w)
        {
            int tn = targetWorld.Length, bn = bodyLow.Length;
            idx = new int[tn * k];
            w = new float[tn * k];
            var bd = new float[k];
            var bi = new int[k];
            for (int t = 0; t < tn; t++)
            {
                for (int j = 0; j < k; j++) { bd[j] = float.MaxValue; bi[j] = -1; }
                Vector3 p = targetWorld[t];
                for (int b = 0; b < bn; b++)
                {
                    float d = (bodyLow[b] - p).sqrMagnitude;
                    if (d >= bd[k - 1]) continue;
                    int pos = k - 1;
                    while (pos > 0 && bd[pos - 1] > d) { bd[pos] = bd[pos - 1]; bi[pos] = bi[pos - 1]; pos--; }
                    bd[pos] = d; bi[pos] = b;
                }
                float sum = 0f;
                for (int j = 0; j < k; j++)
                {
                    float ww = bi[j] >= 0 ? 1f / (bd[j] + 1e-12f) : 0f;
                    idx[t * k + j] = bi[j]; w[t * k + j] = ww; sum += ww;
                }
                if (sum > 0f) for (int j = 0; j < k; j++) w[t * k + j] /= sum;
            }
        }

        private static Vector3[] TransferToMesh(SkinnedMeshRenderer target, int vertexCount,
            int[] nnIdx, float[] nnW, Vector3[] bodyLow, Vector3[] bodyDelta, List<string> warnings)
        {
            int k = nnIdx.Length / Mathf.Max(1, vertexCount);
            var delta = new Vector3[vertexCount];
            Mesh mesh = target.sharedMesh;
            BoneWeight[] bw = mesh != null ? mesh.boneWeights : null;
            Matrix4x4[] bind = mesh != null ? mesh.bindposes : null;
            bool canSkin = bw != null && bw.Length == vertexCount && bind != null && target.bones != null
                           && target.bones.Length > 0;
            if (!canSkin)
                warnings.Add("件 '" + target.name + "' 缺骨骼/绑定信息，位移按世界空间原样写入（未做蒙皮矩阵逆变换）");
            for (int i = 0; i < vertexCount; i++)
            {
                Vector3 dWorld = Vector3.zero;
                for (int j = 0; j < k; j++)
                {
                    int b = nnIdx[i * k + j];
                    if (b < 0) continue;
                    dWorld += bodyDelta[b] * nnW[i * k + j];
                }
                if (!canSkin)
                {
                    delta[i] = dWorld;
                    continue;
                }
                Matrix4x4 S = Matrix4x4.zero;
                AddBone(ref S, bw[i].boneIndex0, bw[i].weight0, target, bind);
                AddBone(ref S, bw[i].boneIndex1, bw[i].weight1, target, bind);
                AddBone(ref S, bw[i].boneIndex2, bw[i].weight2, target, bind);
                AddBone(ref S, bw[i].boneIndex3, bw[i].weight3, target, bind);
                delta[i] = S.inverse.MultiplyVector(dWorld);
            }
            return delta;
        }

        private static void AddBone(ref Matrix4x4 S, int boneIndex, float weight, SkinnedMeshRenderer smr, Matrix4x4[] bind)
        {
            if (weight <= 0f || boneIndex < 0 || boneIndex >= bind.Length) return;
            Transform bone = smr.bones != null && boneIndex < smr.bones.Length ? smr.bones[boneIndex] : null;
            if (bone == null) return;
            Matrix4x4 m = bone.localToWorldMatrix * bind[boneIndex];
            AddScaled(ref S, m, weight);
        }

        private static void AddScaled(ref Matrix4x4 S, Matrix4x4 m, float s)
        {
            for (int r = 0; r < 4; r++)
                for (int c = 0; c < 4; c++)
                    S[r, c] += m[r, c] * s;
        }

        // ─────────────────────────────────────────────────────────────
        // 小工具
        // ─────────────────────────────────────────────────────────────
        private static Mesh Bake(SkinnedMeshRenderer smr)
        {
            var m = new Mesh();
            m.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32;
            m.hideFlags = HideFlags.HideAndDontSave;
            smr.BakeMesh(m, true);
            return m;
        }

        private static Vector3[] ToWorld(SkinnedMeshRenderer smr, Vector3[] local)
        {
            Matrix4x4 l2w = smr.transform.localToWorldMatrix;
            var outp = new Vector3[local.Length];
            for (int i = 0; i < local.Length; i++) outp[i] = l2w.MultiplyPoint3x4(local[i]);
            return outp;
        }

        private static float MaxLen(Vector3[] v)
        {
            float m = 0f;
            for (int i = 0; i < v.Length; i++) { float l = v[i].magnitude; if (l > m) m = l; }
            return m;
        }

        private static float MeanLen(Vector3[] v)
        {
            if (v.Length == 0) return 0f;
            float s = 0f;
            for (int i = 0; i < v.Length; i++) s += v[i].magnitude;
            return s / v.Length;
        }

        private static bool HasKey(SkinnedMeshRenderer smr, string key)
        {
            return smr != null && smr.sharedMesh != null && !string.IsNullOrEmpty(key)
                   && smr.sharedMesh.GetBlendShapeIndex(key) >= 0;
        }

        private static SkinnedMeshRenderer Resolve(GameObject avatar, string spec, out string relPath)
        {
            relPath = "";
            if (avatar == null || string.IsNullOrEmpty(spec)) return null;
            Transform aroot = avatar.transform;
            var all = avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
            for (int i = 0; i < all.Length; i++)
            {
                var smr = all[i];
                if (smr == null || smr.sharedMesh == null) continue;
                string p = AuditUtil.RelPath(aroot, smr.transform);
                if (string.Equals(p, spec, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(smr.gameObject.name, spec, StringComparison.OrdinalIgnoreCase)
                    || p.IndexOf(spec, StringComparison.OrdinalIgnoreCase) >= 0)
                { relPath = p; return smr; }
            }
            return null;
        }

        private static void EnsureAssetFolder(string assetPath)
        {
            string dir = Path.GetDirectoryName(assetPath);
            if (string.IsNullOrEmpty(dir)) return;
            dir = dir.Replace('\\', '/');
            if (AssetDatabase.IsValidFolder(dir)) return;
            string[] parts = dir.Split('/');
            string cur = parts[0];              // "Assets"
            for (int i = 1; i < parts.Length; i++)
            {
                string next = cur + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(cur, parts[i]);
                cur = next;
            }
        }

        private static List<object> ManualDiff()
        {
            var l = new List<object>();
            l.Add("手工版在 MCP execute_code 会话里跑、未落盘；脚本一次菜单动作完成并写 report.json。");
            l.Add("手工版换 sharedMesh + 加 MA BlendshapeSync 同步做；脚本默认只产 .asset（apply_to_renderer=false），MA Sync 接线不在本脚本范围。");
            l.Add("手工版按 SOP 的 Σw·(worldToLocal·bone·bindpose)⁻¹；脚本用真世界位移，等价写成 S⁻¹·世界位移（S=Σw·bone.localToWorld·bindpose）。");
            l.Add("手工版没留中间量；脚本写每帧位移 max/mean（网格空间 mm）供与施工记录 17.19/23.4 mm 对照。");
            return l;
        }

        private static List<object> SourceRefs()
        {
            var l = new List<object>();
            l.Add("_长程任务_20260918/进度核查_20260919/testdocs.md:219");
            l.Add("工程D/_施工记录.md:75-88");
            l.Add("开发工具/SOP/50_服装发型装配/给衣物补形态键.md");
            l.Add("开发工具/通用工具/审查/replay/b23_esmera_nipple/expect.json");
            return l;
        }

        private static string DefaultOutDir()
        {
            string project = Path.GetFileName(AuditRunner.ProjectRoot);
            string repo = Path.GetDirectoryName(AuditRunner.ProjectRoot) ?? AuditRunner.ProjectRoot;
            return Path.Combine(repo, "_长程任务_20260918", "审查产出", project, "nipple_patch_frames");
        }

        private static string UnderProject(string rel)
        {
            return Path.Combine(AuditRunner.ProjectRoot, rel.Replace('/', Path.DirectorySeparatorChar));
        }
    }
}
