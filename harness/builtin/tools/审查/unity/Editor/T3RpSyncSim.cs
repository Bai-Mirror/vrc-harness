// ══════════════════════════════════════════════════════════════════
// 【项目沉淀】通用工具 · 审查 T3 前置「手动模拟 MA BlendshapeSync 同步」
// 适用素体：任意 Humanoid 头像（Unity 2022.3.22f1 / VRChat 3.x）
// 相关素材：无
// 工具链　：Unity 2022.3.22f1（Editor 程序集 AvatarAudit.Editor；MA 用反射访问，不写 using）
// 可复用性：★★★ 随 `审查/unity/` 一起由 perception/sync_audit.py 同步进工程
//
// 用途：把「工程E t3_rp_*」那批 nosync / sync 对照从手工 execute_code 变成可复跑的一次菜单动作——
//   冻结头像根 Animator → 读件上的 `ModularAvatarBlendshapeSync.Bindings`（ReferenceMesh 路径 +
//   参照键 + 本地键）→ 按 mode 把**参照（身体）键值抄到衣服本地键**（sync），或把本地键留 0
//   （nosync，复现修前缺陷）→ 读数 → 用现有 T3 `AuditTurntable` 按请求机位渲一组 → 还原 → report.json。
//
// ── 来源 ────────────────────────────────────────────────────────────
//   · `_长程任务_20260918/进度核查_20260919/testdocs.md:345`：「T3 的 nosync / sync 对照是
//     『冻结 Animator 手动模拟同步』，请求文件复跑不了」；同页 `:436` 与工程F t3_arm 并列。
//   · `工程E/_施工记录.md:38-41`（2026-09-19 00:15 条）：`t3_rp_{def,b1}_{nosync,sync}/`
//     （冻结 Animator 手动模拟同步，16 视角）；测量口径「修前胸型拉满时正面肤色像素 6,822 →
//     同步后 837」。
//   · 件上与身体的键名 / 档位抄修后场景与 replay 用例
//     `开发工具/通用工具/审查/replay/e1_bust_sync/`（`Breast_small_____胸_小`、`Breast_big(limit)`、
//     `Breast_Big_____胸_大(mizuki)`）；机位抄当时请求原件
//     `_长程任务_20260918/审查产出/工程E/t3_rp_b1_sync.json`
//     （Chest r0.5、8 方位 × [0,25]、size=768、only_renderers=Body_b/(A)Shirt/(A)Parker/(A)Necltie/(B)Cat）。
//   · **原件未找到**：当时的手工 `execute_code` 没有落盘，本文件按施工记录描述与 MA 组件字段重写；
//     键名 / 档位 / 机位数值抄原件，未编造。
//   待 Unity 验收：本文件尚未在 Unity 里实跑过（离线只做编译）。
//
// ── 请求 JSON 字段表（`<工程>/Library/AvatarAudit/t3_rp_sync_sim_request.json`）────
//   tool               可选，自描述 "t3_rp_sync_sim"
//   avatar             必填，头像根名（面捕克隆两个同名根时脚本报错并列出）
//   out                必填，输出目录（绝对路径）；report.json 写这里，T3 渲到 <out>/t3/
//   mode               必填，"sync" = 把参照键值抄到本地键；"nosync" = 本地键留 0（复现修前）
//   body               可选，参照渲染器（头像根相对路径 / 叶名 / 子串）；省略时从 Bindings 的
//                      ReferenceMesh.referencePath 解析，或挑带该键的渲染器
//   parts              可选，字符串数组：只处理匹配这些串的件（相对路径 / 叶名 / 子串）；
//                      省略 = 扫头像下所有挂 ModularAvatarBlendshapeSync 的件
//   reference_overrides 可选，{参照键: 数值}：先把身体参照键设成这些值再同步（复现某个胸型档，
//                      不必再跑 T1）；脚本会还原
//   local_zero         可选，字符串数组：nosync 模式下额外把这些本地键归零（没有 Bindings 时用）
//   pairs              可选，[{part, key, ref, value?}]：显式指定「件-本地键-参照键」；用于
//                      修前场景（件上根本没有 MA BlendshapeSync 组件）也能量 nosync/sync 对照
//   t1_state           可选，对象：只回显当时 T1 的档位（Clothes/Hair/BreastSize…），脚本不套用
//   readback_frames    可选，默认 2
//   render             可选，T3 请求体（targets/azimuths/elevations/size/fov/only_renderers…）
//   timeout_seconds    可选，默认 3600
//
// ── 和手工版的差异 ──────────────────────────────────────────────────
//   1. 手工版先 T1 `reset:none` 摆 Re-Poppin 档再 execute_code；脚本不代跑 T1，改用它自带的
//      `reference_overrides` 直接把参照键设成目标档（并还原），`t1_state` 只做回显。
//   2. 手工版人肉按件设键；脚本从 `Bindings` 读出「参照键 → 本地键」逐条抄，且把每条前后值落盘。
//   3. 手工版 nosync = 件上键就是 0（修前无写者）；脚本在修后场景上把绑定覆盖的本地键显式归零，
//      这样同一场景能同时量 nosync 与 sync（与 replay 后重跑的口径一致）。
//   4. 手工版靠会话保活、人肉还原；脚本 finally 还原（含 reference_overrides）并写 report。
//   5. 像素差（6,822 → 837）是渲图后离线算的，脚本只负责产出两组 16 张图与键值表，不代替像素比对。
// ══════════════════════════════════════════════════════════════════

using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace AvatarAudit
{
    public static class T3RpSyncSim
    {
        public const string Tool = "t3_rp_sync_sim";
        public const string DefaultRequestRel = "Library/AvatarAudit/t3_rp_sync_sim_request.json";
        public const string ScriptRel = "开发工具/通用工具/审查/unity/Editor/T3RpSyncSim.cs";
        private const string LogTag = "[T3RpSyncSim]";
        private const BindingFlags AnyInstance =
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        private static Run _current;

        [MenuItem("Tools/AvatarAudit/T3 RP Sync Sim (Edit Mode)", false, 123)]
        public static void RunFromMenu()
        {
            if (_current != null) { Debug.LogWarning(LogTag + " 已有一个在跑，忽略本次。"); return; }
            string reqPath = UnderProject(DefaultRequestRel);
            if (!File.Exists(reqPath))
            {
                Debug.LogError(LogTag + " FAIL 找不到请求文件 " + reqPath + "（先按 examples/ 写一份）");
                return;
            }
            EditorApplication.delayCall += () =>
            {
                if (_current != null) return;
                try { _current = new Run(reqPath); _current.Start(); }
                catch (Exception e) { Debug.LogError(LogTag + " FAIL 启动失败：" + e); _current = null; }
            };
        }

        /// <summary>一条「参照键 → 本地键」操作。</summary>
        private sealed class Op
        {
            public string PartPath;
            public SkinnedMeshRenderer Local;
            public string LocalKey;
            public string RefKey;
            public string RefPath;
            public SkinnedMeshRenderer Ref;
            public bool ExplicitValue;
            public float Value;
            public int LocalIndex = -1;
            public int RefIndex = -1;
            public bool Applied;
            public float Before;
            public float RefValue;
            public float AfterFrames;
            public float AfterRender;
        }

        /// <summary>还原用的一条记录（不能用 (index) 当令牌：不同渲染器同索引会串）。</summary>
        private sealed class Saved
        {
            public SkinnedMeshRenderer Smr;
            public int Index;
            public float Value;
        }

        private sealed class Run
        {
            private enum Phase { WaitFrames, Render }

            private readonly string _reqPath;
            private JsonObject _req;
            private string _outDir;
            private string _mode = "sync";
            private readonly List<string> _warnings = new List<string>();
            private readonly List<Op> _ops = new List<Op>();
            private readonly List<Saved> _restore = new List<Saved>();
            private readonly HashSet<SkinnedMeshRenderer> _touched = new HashSet<SkinnedMeshRenderer>();

            private GameObject _avatar;
            private Animator _anim;
            private bool _animWasEnabled;
            private SkinnedMeshRenderer _body;
            private string _bodyPath = "";

            private JsonObject _renderReq;
            private Phase _phase;
            private int _frameCountdown;
            private AuditTurntable _t3;
            private AuditContext _t3ctx;
            private string _renderOut;
            private string _renderError;
            private bool _restored;
            private bool _failed;
            private string _failReason;

            public Run(string reqPath) { _reqPath = reqPath; }

            public void Start()
            {
                try
                {
                    _req = AuditJson.Parse(File.ReadAllText(_reqPath, Encoding.UTF8)) as JsonObject;
                    if (_req == null) throw new Exception("请求 JSON 顶层必须是对象");
                }
                catch (Exception e) { FailAndReport("请求 JSON 解析失败：" + e.Message); return; }

                _outDir = AuditJson.Str(_req, "out", null);
                if (string.IsNullOrEmpty(_outDir)) _outDir = DefaultOutDir();
                try { Directory.CreateDirectory(_outDir); }
                catch (Exception e) { FailAndReport("建输出目录失败 " + _outDir + " ：" + e.Message); return; }

                _mode = (AuditJson.Str(_req, "mode", "sync") ?? "sync").ToLowerInvariant();
                if (_mode != "sync" && _mode != "nosync")
                { FailAndReport("mode 只能是 sync 或 nosync，收到 '" + _mode + "'"); return; }

                try
                {
                    _avatar = AuditAvatar.Resolve(AuditJson.Str(_req, "avatar", null));
                    _anim = _avatar.GetComponent<Animator>();
                    if (!EditorApplication.isPlaying)
                        Warn("当前不在 Play 模式：脚本只做冻结/同步/读数/渲图，T1 的档位用 reference_overrides 或 t1_state 表达。");
                    if (_anim != null) { _animWasEnabled = _anim.enabled; _anim.enabled = false; }

                    var bodySpec = AuditJson.Str(_req, "body", null);
                    _body = ResolveRenderer(bodySpec, null, out _bodyPath, allowAny: false);

                    ApplyReferenceOverrides();
                    BuildOps();
                    if (_ops.Count == 0)
                        throw new Exception("没有可处理的键：件上没有 ModularAvatarBlendshapeSync.Bindings，也没给 pairs/local_zero");
                    ApplyOps();
                }
                catch (Exception e) { FailAndReport("准备阶段失败：" + e.Message); return; }

                _renderReq = AuditJson.Obj(_req, "render");
                _frameCountdown = Mathf.Max(0, AuditJson.Int(_req, "readback_frames", 2));
                _phase = Phase.WaitFrames;
                EditorApplication.update += Tick;
            }

            // ── 参照键覆盖 ─────────────────────────────────────────
            private void ApplyReferenceOverrides()
            {
                var ov = AuditJson.Obj(_req, "reference_overrides");
                if (ov == null) return;
                foreach (var kv in ov.Items)
                {
                    SkinnedMeshRenderer refSmr = _body;
                    string refPath = _bodyPath;
                    if (!HasKey(refSmr, kv.Key))
                        refSmr = ResolveRenderer(null, kv.Key, out refPath, allowAny: true);
                    if (refSmr == null)
                    { Warn("reference_overrides 的键 '" + kv.Key + "' 在场景里找不到参照渲染器，跳过"); continue; }
                    int idx = refSmr.sharedMesh.GetBlendShapeIndex(kv.Key);
                    _restore.Add(new Saved
                    {
                        Smr = refSmr,
                        Index = idx,
                        Value = refSmr.GetBlendShapeWeight(idx)
                    });
                    refSmr.SetBlendShapeWeight(idx, AuditUtil.ToFloat(kv.Value));
                    Debug.Log(LogTag + " 参照覆盖 " + refPath + " :: " + kv.Key + " = " + AuditUtil.F(AuditUtil.ToFloat(kv.Value)));
                }
            }

            // ── 收集「参照 → 本地」绑定 ─────────────────────────────
            private void BuildOps()
            {
                var parts = AuditJson.Arr(_req, "parts");
                // 1) 显式 pairs（修前场景用）
                var pairs = AuditJson.Arr(_req, "pairs");
                for (int i = 0; i < pairs.Count; i++)
                {
                    var o = pairs[i] as JsonObject;
                    if (o == null) continue;
                    string partSpec = AuditJson.Str(o, "part", null);
                    string key = AuditJson.Str(o, "key", null);
                    string refKey = AuditJson.Str(o, "ref", key);
                    if (string.IsNullOrEmpty(partSpec) || string.IsNullOrEmpty(key)) continue;
                    string partPath;
                    var local = ResolveRenderer(partSpec, key, out partPath, allowAny: false);
                    if (local == null) { Warn("pairs 的件 '" + partSpec + "' 找不到带键 '" + key + "' 的渲染器"); continue; }
                    AddOp(partPath, local, key, refKey, null, o.Has("value"), (float)AuditJson.Num(o, "value", 0));
                }
                // 2) 扫 MA BlendshapeSync.Bindings
                Transform aroot = _avatar.transform;
                var mbs = _avatar.GetComponentsInChildren<MonoBehaviour>(true);
                for (int i = 0; i < mbs.Length; i++)
                {
                    var mb = mbs[i];
                    if (mb == null || mb.GetType().Name != "ModularAvatarBlendshapeSync") continue;
                    var en = GetMember(mb, "Bindings") as System.Collections.IEnumerable;
                    if (en == null) continue;
                    foreach (object binding in en)
                    {
                        if (binding == null) continue;
                        string src = GetMember(binding, "Blendshape") as string;
                        string loc = GetMember(binding, "LocalBlendshape") as string;
                        string localKey = string.IsNullOrEmpty(loc) ? src : loc;
                        if (string.IsNullOrEmpty(localKey)) continue;
                        var local = FindLocalRenderer(mb, localKey);
                        if (local == null)
                        { Warn("MA BlendshapeSync 的本地键 '" + localKey + "' 在宿主子树里找不到网格，跳过"); continue; }
                        string partPath = AuditUtil.RelPath(aroot, local.transform);
                        if (!PartWanted(parts, local, partPath)) continue;
                        string refPath = ResolveRefPath(aroot, GetMember(binding, "ReferenceMesh"));
                        AddOp(partPath, local, localKey, src, refPath, false, 0f);
                    }
                }
                // 3) 没有 Bindings 时按 local_zero 兜底
                var zero = AuditJson.Arr(_req, "local_zero");
                if (_ops.Count == 0 && zero.Count > 0)
                {
                    foreach (var r in _avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true))
                    {
                        string partPath = AuditUtil.RelPath(aroot, r.transform);
                        if (!PartWanted(parts, r, partPath)) continue;
                        for (int k = 0; k < zero.Count; k++)
                        {
                            string key = Convert.ToString(zero[k]);
                            if (!HasKey(r, key)) continue;
                            AddOp(partPath, r, key, key, null, true, 0f);
                        }
                    }
                }
            }

            private void AddOp(string partPath, SkinnedMeshRenderer local, string localKey, string refKey,
                string refPath, bool explicitValue, float value)
            {
                string refResolved = refPath;
                SkinnedMeshRenderer refSmr = null;
                if (!string.IsNullOrEmpty(refPath))
                    refSmr = ResolveRenderer(refPath, refKey, out refResolved, allowAny: true);
                if (refSmr == null && _body != null && HasKey(_body, refKey))
                { refSmr = _body; refResolved = _bodyPath; }
                if (refSmr == null)
                    refSmr = ResolveRenderer(null, refKey, out refResolved, allowAny: true);
                var op = new Op();
                op.PartPath = partPath;
                op.Local = local;
                op.LocalKey = localKey;
                op.RefKey = refKey;
                op.RefPath = refSmr != null ? refResolved : refPath;
                op.Ref = refSmr;
                op.ExplicitValue = explicitValue;
                op.Value = value;
                op.LocalIndex = local.sharedMesh != null ? local.sharedMesh.GetBlendShapeIndex(localKey) : -1;
                op.RefIndex = refSmr != null && refSmr.sharedMesh != null ? refSmr.sharedMesh.GetBlendShapeIndex(refKey) : -1;
                if (op.LocalIndex < 0)
                { Warn("件 '" + partPath + "' 网格上没有本地键 '" + localKey + "'，跳过这条"); return; }
                _ops.Add(op);
            }

            private void ApplyOps()
            {
                foreach (var op in _ops)
                {
                    if (op.LocalIndex < 0) continue;
                    op.Before = op.Local.GetBlendShapeWeight(op.LocalIndex);
                    _restore.Add(new Saved { Smr = op.Local, Index = op.LocalIndex, Value = op.Before });
                    _touched.Add(op.Local);
                    if (_mode == "nosync")
                    {
                        if (op.ExplicitValue) op.RefValue = op.Value;
                        op.Local.SetBlendShapeWeight(op.LocalIndex, op.ExplicitValue ? op.Value : 0f);
                        op.Applied = true;
                    }
                    else
                    {
                        if (op.Ref == null || op.RefIndex < 0)
                        {
                            Warn("sync：件 '" + op.PartPath + "' 的参照键 '" + op.RefKey + "' 在参照件上不存在，保留原值");
                            continue;
                        }
                        op.RefValue = op.Ref.GetBlendShapeWeight(op.RefIndex);
                        op.Local.SetBlendShapeWeight(op.LocalIndex, op.RefValue);
                        op.Applied = true;
                    }
                }
                Debug.Log(LogTag + " mode=" + _mode + "，处理 " + _ops.Count + " 条（件 " + _touched.Count
                          + " 个，body=" + _bodyPath + "），输出 " + _outDir);
            }

            private void RecordReadback(string which)
            {
                foreach (var op in _ops)
                {
                    if (!op.Applied || op.LocalIndex < 0) continue;
                    float v = op.Local.GetBlendShapeWeight(op.LocalIndex);
                    if (which == "after_frames") op.AfterFrames = v;
                    else if (which == "after_render") op.AfterRender = v;
                }
            }

            // ── 帧循环 / 渲染（与 T3ArmFreeze 同款）──────────────────
            private void Tick()
            {
                try
                {
                    if (_phase == Phase.WaitFrames)
                    {
                        if (_frameCountdown-- > 0) return;
                        RecordReadback("after_frames");
                        if (_renderReq != null) { StartRender(); _phase = Phase.Render; return; }
                        Finish(); return;
                    }
                    if (_t3.Tick()) { Finish(); }
                }
                catch (Exception e) { _renderError = e.Message; Finish(); }
            }

            private void StartRender()
            {
                _renderOut = Path.Combine(_outDir, "t3");
                Directory.CreateDirectory(_renderOut);
                var sub = new JsonObject();
                foreach (var kv in _renderReq.Items) sub.Set(kv.Key, kv.Value);
                sub.Set("tool", "turntable");
                sub.Set("avatar", AuditJson.Str(_req, "avatar", _avatar.name));
                sub.Set("out", _renderOut);

                _t3ctx = new AuditContext();
                _t3ctx.Request = sub;
                _t3ctx.OutDir = _renderOut;
                _t3ctx.Tool = "turntable";
                _t3ctx.Status = new AuditStatus(_renderOut, "t3_rp_sync_sim.render");
                _t3ctx.DeadlineRealtime = Time.realtimeSinceStartup + AuditJson.Num(_req, "timeout_seconds", 3600);
                _t3 = new AuditTurntable();
                AuditCallbackIsolation.Install(_t3ctx);
                _t3.Begin(_t3ctx);
            }

            private void EndRender()
            {
                try { if (_t3 != null) _t3.Cleanup(); } catch (Exception e) { _warnings.Add("T3 Cleanup 失败：" + e.Message); }
                try { AuditCallbackIsolation.Cleanup(); } catch (Exception e) { _warnings.Add("回调隔离恢复失败：" + e.Message); }
                RecordReadback("after_render");
            }

            private void Finish()
            {
                EditorApplication.update -= Tick;
                if (_t3 != null) { EndRender(); _t3 = null; }
                Restore();
                WriteReport();
                _current = null;
                if (_failed) Debug.LogError(LogTag + " FAIL " + _failReason);
                else Debug.Log(LogTag + " DONE mode=" + _mode + "，" + _ops.Count + " 条，report="
                               + Path.Combine(_outDir, "report.json")
                               + (_renderReq != null ? "，T3=" + _renderOut : "，未渲图"));
            }

            private void Restore()
            {
                if (_restored) return;
                _restored = true;
                for (int i = _restore.Count - 1; i >= 0; i--)
                {
                    var s = _restore[i];
                    try { s.Smr.SetBlendShapeWeight(s.Index, s.Value); }
                    catch (Exception e) { _warnings.Add("恢复 " + s.Smr.name + "[" + s.Index + "] 失败：" + e.Message); }
                }
                if (_anim != null)
                {
                    try { _anim.enabled = _animWasEnabled; }
                    catch (Exception e) { _warnings.Add("恢复 Animator.enabled 失败：" + e.Message); }
                }
            }

            private void FailAndReport(string reason)
            {
                _failed = true; _failReason = reason;
                if (!string.IsNullOrEmpty(_outDir)) { try { Restore(); WriteReport(); } catch { } }
                _current = null;
                Debug.LogError(LogTag + " FAIL " + reason);
            }

            private void WriteReport()
            {
                var rep = new JsonObject();
                rep.Set("tool", Tool);
                rep.Set("script", ScriptRel);
                rep.Set("result", _failed ? "FAIL" : "DONE");
                if (_failed) rep.Set("fail_reason", _failReason);
                rep.Set("request", _reqPath);
                rep.Set("out", _outDir);
                rep.Set("avatar", _avatar != null ? _avatar.name : null);
                rep.Set("mode", _mode);
                rep.Set("body", _bodyPath);
                rep.Set("is_playing", EditorApplication.isPlaying);
                rep.Set("animator_found", _anim != null);
                rep.Set("animator_frozen", _anim != null);
                rep.Set("t1_state", AuditJson.Obj(_req, "t1_state"));
                var arr = new List<object>();
                foreach (var op in _ops)
                {
                    var r = new JsonObject();
                    r.Set("part", op.PartPath);
                    r.Set("key", op.LocalKey);
                    r.Set("index", op.LocalIndex);
                    r.Set("ref_key", op.RefKey);
                    r.Set("ref_path", op.RefPath);
                    r.Set("ref_value", (double)op.RefValue);
                    r.Set("weight_before", (double)op.Before);
                    r.Set("weight_after", op.LocalIndex >= 0 ? (double)op.Local.GetBlendShapeWeight(op.LocalIndex) : 0.0);
                    r.Set("readback_after_frames", (double)op.AfterFrames);
                    r.Set("readback_after_render", (double)op.AfterRender);
                    r.Set("applied", op.Applied);
                    arr.Add(r);
                }
                rep.Set("keys", arr);
                if (_renderReq != null)
                {
                    var r = new JsonObject();
                    r.Set("out", _renderOut);
                    r.Set("shot_count", ReadShotCount());
                    r.Set("error", _renderError);
                    rep.Set("render", r);
                }
                rep.Set("restored", _restored);
                var warns = new List<object>();
                for (int i = 0; i < _warnings.Count; i++) warns.Add(_warnings[i]);
                rep.Set("warnings", warns);
                rep.Set("manual_diff", ManualDiff());
                rep.Set("source", SourceRefs());
                rep.Set("unity_verified", false);
                rep.Set("note", "本轮只做离线编译；Unity 实跑与像素差（6,822→837）判读取证待验收。");
                try { AuditJson.WriteFile(Path.Combine(_outDir, "report.json"), rep); }
                catch (Exception e) { Debug.LogError(LogTag + " 写 report.json 失败：" + e.Message); }
            }

            private int ReadShotCount()
            {
                try
                {
                    var p = Path.Combine(_renderOut, "shots.json");
                    if (!File.Exists(p)) return -1;
                    var shots = AuditJson.Parse(File.ReadAllText(p, Encoding.UTF8)) as JsonObject;
                    return shots != null ? AuditJson.Int(shots, "shot_count", -1) : -1;
                }
                catch { return -1; }
            }

            private void Warn(string msg) { _warnings.Add(msg); }

            // ── 解析工具 ────────────────────────────────────────────
            private bool PartWanted(List<object> parts, SkinnedMeshRenderer smr, string path)
            {
                if (parts == null || parts.Count == 0) return true;
                for (int i = 0; i < parts.Count; i++)
                {
                    string spec = Convert.ToString(parts[i]);
                    if (string.IsNullOrEmpty(spec)) continue;
                    if (string.Equals(path, spec, StringComparison.OrdinalIgnoreCase)) return true;
                    if (string.Equals(smr.gameObject.name, spec, StringComparison.OrdinalIgnoreCase)) return true;
                    if (path.IndexOf(spec, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                }
                return false;
            }

            private static bool HasKey(SkinnedMeshRenderer smr, string key)
            {
                return smr != null && smr.sharedMesh != null && !string.IsNullOrEmpty(key)
                       && smr.sharedMesh.GetBlendShapeIndex(key) >= 0;
            }

            /// <summary>按件对象 / 相对路径 / 叶名 / 子串 / 键名反查渲染器。</summary>
            private SkinnedMeshRenderer ResolveRenderer(string spec, string keyHint, out string relPath, bool allowAny)
            {
                relPath = "";
                if (_avatar == null) return null;
                Transform aroot = _avatar.transform;
                SkinnedMeshRenderer best = null;
                string bestPath = "";
                var all = _avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
                for (int i = 0; i < all.Length; i++)
                {
                    var smr = all[i];
                    if (smr == null || smr.sharedMesh == null) continue;
                    if (!string.IsNullOrEmpty(keyHint) && smr.sharedMesh.GetBlendShapeIndex(keyHint) < 0) continue;
                    if (!string.IsNullOrEmpty(spec))
                    {
                        string p = AuditUtil.RelPath(aroot, smr.transform);
                        bool hit = string.Equals(p, spec, StringComparison.OrdinalIgnoreCase)
                                   || string.Equals(smr.gameObject.name, spec, StringComparison.OrdinalIgnoreCase)
                                   || p.IndexOf(spec, StringComparison.OrdinalIgnoreCase) >= 0;
                        if (!hit) continue;
                    }
                    else if (!allowAny && string.IsNullOrEmpty(keyHint))
                    {
                        continue;
                    }
                    best = smr;
                    bestPath = AuditUtil.RelPath(aroot, smr.transform);
                    break;
                }
                relPath = bestPath;
                return best;
            }

            private SkinnedMeshRenderer FindLocalRenderer(MonoBehaviour mb, string keyHint)
            {
                var list = mb.GetComponentsInChildren<SkinnedMeshRenderer>(true);
                SkinnedMeshRenderer firstReadable = null;
                for (int i = 0; i < list.Length; i++)
                {
                    if (list[i] == null || list[i].sharedMesh == null) continue;
                    if (firstReadable == null) firstReadable = list[i];
                    if (!string.IsNullOrEmpty(keyHint) && list[i].sharedMesh.GetBlendShapeIndex(keyHint) >= 0)
                        return list[i];
                }
                return string.IsNullOrEmpty(keyHint) ? firstReadable : null;
            }

            private static string ResolveRefPath(Transform aroot, object aor)
            {
                if (aor == null) return null;
                var target = GetMember(aor, "targetObject") as GameObject;
                if (target != null && target.transform != null)
                    return target.transform == aroot ? "." : AuditUtil.RelPath(aroot, target.transform);
                string refPath = GetMember(aor, "referencePath") as string;
                if (string.IsNullOrEmpty(refPath)) return null;
                if (refPath == "$$$AVATAR_ROOT$$$") return ".";
                return aroot.Find(refPath) != null ? refPath : null;
            }
        }

        // ─────────────────────────────────────────────────────────────
        // 反射（MA 是可选包，不写 using）
        // ─────────────────────────────────────────────────────────────
        private static object GetMember(object o, string name)
        {
            if (o == null) return null;
            Type t = o.GetType();
            while (t != null)
            {
                FieldInfo f = t.GetField(name, AnyInstance);
                if (f != null) return f.GetValue(o);
                PropertyInfo p = t.GetProperty(name, AnyInstance);
                if (p != null && p.CanRead) return p.GetValue(o, null);
                t = t.BaseType;
            }
            return null;
        }

        private static List<object> ManualDiff()
        {
            var l = new List<object>();
            l.Add("手工版先 T1 reset 摆 Re-Poppin 档；脚本用 reference_overrides 直接设参照键，t1_state 仅回显。");
            l.Add("手工版人肉按件设键；脚本读 Bindings 的参照键→本地键逐条抄，并落盘每条前后值。");
            l.Add("手工版 nosync 是修前场景件上无写者（键恒 0）；脚本在修后场景把绑定本地键显式归零来复现。");
            l.Add("手工版靠会话保活、人肉还原；脚本 finally 还原（含参照覆盖）并写 report。");
            return l;
        }

        private static List<object> SourceRefs()
        {
            var l = new List<object>();
            l.Add("_长程任务_20260918/进度核查_20260919/testdocs.md:345,:436");
            l.Add("工程E/_施工记录.md:38-41");
            l.Add("开发工具/通用工具/审查/replay/e1_bust_sync/expect.json");
            l.Add("_长程任务_20260918/审查产出/工程E/t3_rp_b1_sync.json");
            return l;
        }

        private static string DefaultOutDir()
        {
            string project = Path.GetFileName(AuditRunner.ProjectRoot);
            string repo = Path.GetDirectoryName(AuditRunner.ProjectRoot) ?? AuditRunner.ProjectRoot;
            return Path.Combine(repo, "_长程任务_20260918", "审查产出", project, "t3_rp_sync_sim");
        }

        private static string UnderProject(string rel)
        {
            return Path.Combine(AuditRunner.ProjectRoot, rel.Replace('/', Path.DirectorySeparatorChar));
        }
    }
}
