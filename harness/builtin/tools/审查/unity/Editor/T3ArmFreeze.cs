// ══════════════════════════════════════════════════════════════════
// 【项目沉淀】通用工具 · 审查 T3 前置「冻结 Animator + 手设身体收缩键」
// 适用素体：任意 Humanoid 头像（Unity 2022.3.22f1 / VRChat 3.x）
// 相关素材：无
// 工具链　：Unity 2022.3.22f1（Editor 程序集 AvatarAudit.Editor；本文件只用 UnityEditor/UnityEngine）
// 可复用性：★★★ 随 `审查/unity/` 一起由 perception/sync_audit.py 同步进工程
//
// 用途：把「工程F t3_arm」那批对照从手工 execute_code 变成可复跑的一次菜单动作——
//   冻结头像根 Animator → 按请求 JSON 手设身体收缩键（Shoulder_OFF / Upper_arm_OFF 等）→
//   立即读数 + 等若干帧再读数（证明冻结后没被动画写回）→ 用现有 T3 `AuditTurntable`
//   按请求里的机位渲一组图 → 还原键值与 Animator → 把全过程写 report.json。
//
// ── 来源 ────────────────────────────────────────────────────────────
//   · `_长程任务_20260918/进度核查_20260919/testdocs.md:301`：「T3 肩臂对照要先用 execute_code
//     冻结 Animator 并手设 SetBlendShapeWeight（SOP 收缩键可见后果_渲图对照.md 第 2 步），
//     请求文件表达不了这一步」；同页 `:436` 把工程F `t3_arm` 与 工程E `t3_rp_*` 并列为同类。
//   · `工程F/_施工记录.md:38-41`（2026-09-18 23:57 条）：`t3_arm_A3|B3`
//     （外套关、只穿衬衫，冻结 Animator 后身体 `Shoulder_OFF/Upper_arm_OFF` 取 0 与 100
//     各渲 24 张）；正对照 `t3_arm_Cbody100|Dbody0`（只渲身体）。
//   · SOP `开发工具/SOP/50_服装发型装配/收缩键可见后果_渲图对照.md`：做法第 2 步与判据；
//     末节「Play 里别做换网格对照」。
//   · 参数化的机位抄当时请求原件 `_长程任务_20260918/审查产出/工程F/t3_arm_A3.json`
//     （size=768、Left/RightUpperArm r0.3、6 方位 × [0,30]、fov=30、hide 头发 6 件 + Cat_Tail
//     + Item_Bag/FishToy/Item_NameTag），见 `examples/t3_arm_freeze_request.json`。
//   · **原件未找到**：当时的手工 `execute_code` 没有落盘（testdocs.md:219 同段结论），本文件
//     按 SOP 与施工记录描述重写；键名 / 0·100 两端 / 机位数值全部抄上面原件，未编造。
//   待 Unity 验收：本文件尚未在 Unity 里实跑过（离线只做编译），实跑步骤见 审查/README.md 与 docs/deliverables.md（§0.1 T3ArmFreeze 条）。
//
// ── 请求 JSON 字段表（`<工程>/Library/AvatarAudit/t3_arm_freeze_request.json`）─────
//   tool                可选，固定 "t3_arm_freeze"（只是自描述；本脚本不从 tool 分派）
//   avatar              必填，头像根名（面捕克隆出两个同名根时脚本报错并列出，需先关一个）
//   out                 必填，本次输出目录（绝对路径）；report.json 写到这里，T3 渲到 <out>/t3/
//   body                必填，带收缩键的渲染器对象：头像根相对路径（如 "Body_Base"）或叶名
//   keys                必填，{键名: 数值}，逐条 SetBlendShapeWeight；数值允许 0–1 之外（外推）
//   readback_frames     可选，默认 2；设键后等几个 EditorApplication.update 帧再读数（证明冻结）
//   render              可选，一个 T3 请求体（targets/azimuths/elevations/size/fov/bg/
//                       only_renderers/hide_renderers/transparency_check…）；省略则只设键+读数不渲图
//   timeout_seconds     可选，默认 3600；只约束 render 阶段
//
// ── 和手工版的差异 ──────────────────────────────────────────────────
//   1. 手工版：同一 Play 里先用 T1 `reset:none` 摆穿衣状态 → MCP `execute_code` 冻 Animator +
//      SetBlendShapeWeight → 换另一个值再渲一组。本脚本**不自带 T1**：穿衣状态仍要调用者先摆好
//      （脚本在 report 里回显当前是编辑模式还是 Play，并给 warning，不猜也不代跑 T1）；
//      同一请求只设一组键值，0 与 100 两端要发两次请求（与手工「一组一次」一致）。
//   2. 手工版靠 MCP 会话保活；本脚本一个菜单动作跑完并写盘，掉线后可从 report.json 知道走到哪。
//   3. 手工版只在 Play 里做过；脚本改成编辑模式也能跑（冻结+读数不依赖 Play），并且把
//      「读数 → 等帧 → 读数」做成显式证据，手工版没有这步。
//   4. 手工版渲完要人肉恢复键值与 Animator；脚本在 finally 语义里恢复，异常也恢复，
//      并把恢复后的读数一并写进 report（restore 那几项）。
// ══════════════════════════════════════════════════════════════════

using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace AvatarAudit
{
    public static class T3ArmFreeze
    {
        public const string Tool = "t3_arm_freeze";
        public const string DefaultRequestRel = "Library/AvatarAudit/t3_arm_freeze_request.json";
        public const string ScriptRel = "开发工具/通用工具/审查/unity/Editor/T3ArmFreeze.cs";
        private const string LogTag = "[T3ArmFreeze]";

        private static Run _current;

        [MenuItem("Tools/AvatarAudit/T3 Arm Freeze (Edit Mode)", false, 122)]
        public static void RunFromMenu()
        {
            if (_current != null)
            {
                Debug.LogWarning(LogTag + " 已有一个 T3ArmFreeze 在跑，忽略本次。");
                return;
            }
            string reqPath = UnderProject(DefaultRequestRel);
            if (!File.Exists(reqPath))
            {
                Debug.LogError(LogTag + " FAIL 找不到请求文件 " + reqPath + "（先按 examples/ 写一份）");
                return;
            }
            // 重活放 delayCall：菜单回调里读盘/渲图会拖住当前事件。
            EditorApplication.delayCall += () =>
            {
                if (_current != null) return;
                try { _current = new Run(reqPath); _current.Start(); }
                catch (Exception e) { Debug.LogError(LogTag + " FAIL 启动失败：" + e); _current = null; }
            };
        }

        // ─────────────────────────────────────────────────────────────
        // 一次运行的全部状态（避免用散落的静态字段）
        // ─────────────────────────────────────────────────────────────
        private sealed class Run
        {
            private enum Phase { WaitFrames, Render }

            private readonly string _reqPath;
            private JsonObject _req;
            private string _outDir;
            private readonly List<string> _warnings = new List<string>();
            private readonly List<JsonObject> _keyRecords = new List<JsonObject>();
            private readonly List<KeyValuePair<int, float>> _saved = new List<KeyValuePair<int, float>>();

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

                var keys = AuditJson.Obj(_req, "keys");
                if (keys == null || keys.Count == 0) { FailAndReport("请求缺少 keys（{键名: 数值}）"); return; }

                try
                {
                    string avatarName = AuditJson.Str(_req, "avatar", null);
                    _avatar = AuditAvatar.Resolve(avatarName);
                    _anim = _avatar.GetComponent<Animator>();
                    _body = ResolveBody(AuditJson.Str(_req, "body", null), keys, out _bodyPath);
                    if (_body == null)
                        throw new Exception("在头像 '" + _avatar.name + "' 下找不到带这些键的渲染器；请检查 body 与 keys");
                    if (!EditorApplication.isPlaying)
                        Warn("当前不在 Play 模式：本脚本只负责冻结/设键/读数/渲图，T1 的穿衣状态要调用者先在编辑模式或 Play 里摆好（脚本不代跑 T1）。");
                    if (_anim == null)
                        Warn("头像根上没有 Animator，冻结这步无对象可做（键值仍会设并读数）。");

                    ApplyKeys(keys);
                    if (AppliedKeyCount() == 0)
                        throw new Exception("keys 里没有任何一个形态键存在于 body '" + _bodyPath + "'，不构成对照");
                }
                catch (Exception e) { FailAndReport("准备阶段失败：" + e.Message); return; }

                _renderReq = AuditJson.Obj(_req, "render");
                _frameCountdown = Mathf.Max(0, AuditJson.Int(_req, "readback_frames", 2));
                _phase = Phase.WaitFrames;
                EditorApplication.update += Tick;
            }

            // ── 冻结 + 设键 ─────────────────────────────────────────
            private void ApplyKeys(JsonObject keys)
            {
                if (_anim != null)
                {
                    _animWasEnabled = _anim.enabled;
                    _anim.enabled = false;      // 冻住，否则下一帧被动画写回（SOP 第 2 步）
                }
                Mesh mesh = _body.sharedMesh;
                foreach (var kv in keys.Items)
                {
                    var rec = new JsonObject();
                    rec.Set("key", kv.Key);
                    rec.Set("requested", AuditUtil.ToFloat(kv.Value));
                    int idx = mesh != null ? mesh.GetBlendShapeIndex(kv.Key) : -1;
                    rec.Set("index", idx);
                    if (idx < 0)
                    {
                        rec.Set("applied", false);
                        rec.Set("note", "该渲染器网格上没有这个形态键");
                        _warnings.Add("body '" + _bodyPath + "' 没有形态键 '" + kv.Key + "'（未设值）");
                        _keyRecords.Add(rec);
                        continue;
                    }
                    float before = _body.GetBlendShapeWeight(idx);
                    rec.Set("weight_before", (double)before);
                    _saved.Add(new KeyValuePair<int, float>(idx, before));
                    _body.SetBlendShapeWeight(idx, AuditUtil.ToFloat(kv.Value));
                    rec.Set("applied", true);
                    rec.Set("readback_immediate", (double)_body.GetBlendShapeWeight(idx));
                    _keyRecords.Add(rec);
                }
                Debug.Log(LogTag + " 已冻结 Animator=" + (_anim != null) + "，设键 " + _keyRecords.Count
                          + " 条（body=" + _bodyPath + "），输出 " + _outDir);
            }

            private int AppliedKeyCount()
            {
                int n = 0;
                for (int i = 0; i < _keyRecords.Count; i++)
                    if (AuditJson.Bool(_keyRecords[i], "applied", false)) n++;
                return n;
            }

            private void RecordReadback(string field)
            {                for (int i = 0; i < _keyRecords.Count; i++)
                {
                    var rec = _keyRecords[i];
                    if (!AuditJson.Bool(rec, "applied", false)) continue;
                    int idx = AuditJson.Int(rec, "index", -1);
                    rec.Set(field, (double)_body.GetBlendShapeWeight(idx));
                }
            }

            // ── 帧循环 ──────────────────────────────────────────────
            private void Tick()
            {
                try
                {
                    if (_phase == Phase.WaitFrames)
                    {
                        if (_frameCountdown-- > 0) return;
                        RecordReadback("readback_after_frames");
                        if (_renderReq != null) { StartRender(); _phase = Phase.Render; return; }
                        Finish();
                        return;
                    }
                    // Phase.Render
                    if (_t3.Tick()) { Finish(); }
                }
                catch (Exception e)
                {
                    _renderError = e.Message;
                    Finish();
                }
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
                _t3ctx.Status = new AuditStatus(_renderOut, "t3_arm_freeze.render");
                _t3ctx.DeadlineRealtime = Time.realtimeSinceStartup
                    + AuditJson.Num(_req, "timeout_seconds", 3600);
                _t3 = new AuditTurntable();
                AuditCallbackIsolation.Install(_t3ctx);
                _t3.Begin(_t3ctx);
            }

            private void EndRender()
            {
                try { if (_t3 != null) _t3.Cleanup(); } catch (Exception e) { _warnings.Add("T3 Cleanup 失败：" + e.Message); }
                try { AuditCallbackIsolation.Cleanup(); } catch (Exception e) { _warnings.Add("回调隔离恢复失败：" + e.Message); }
                RecordReadback("readback_after_render");
            }

            // ── 收尾：恢复 → 写 report → DONE/FAIL ──────────────────
            private void Finish()
            {
                EditorApplication.update -= Tick;
                if (_t3 != null) { EndRender(); _t3 = null; }
                Restore();
                WriteReport();
                _current = null;
                if (_failed) Debug.LogError(LogTag + " FAIL " + _failReason);
                else Debug.Log(LogTag + " DONE 设键 " + _keyRecords.Count + " 条，report="
                               + Path.Combine(_outDir, "report.json")
                               + (_renderReq != null ? "，T3=" + _renderOut : "，未渲图"));
            }

            private void Restore()
            {
                if (_restored) return;
                _restored = true;
                for (int i = 0; i < _saved.Count; i++)
                {
                    try { _body.SetBlendShapeWeight(_saved[i].Key, _saved[i].Value); }
                    catch (Exception e) { _warnings.Add("恢复键 index=" + _saved[i].Key + " 失败：" + e.Message); }
                }
                if (_anim != null)
                {
                    try { _anim.enabled = _animWasEnabled; }
                    catch (Exception e) { _warnings.Add("恢复 Animator.enabled 失败：" + e.Message); }
                }
                for (int i = 0; i < _keyRecords.Count; i++)
                {
                    if (!AuditJson.Bool(_keyRecords[i], "applied", false)) continue;
                    int idx = AuditJson.Int(_keyRecords[i], "index", -1);
                    _keyRecords[i].Set("readback_restored", (double)_body.GetBlendShapeWeight(idx));
                }
            }

            private void FailAndReport(string reason)
            {
                _failed = true;
                _failReason = reason;
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
                rep.Set("body", _bodyPath);
                rep.Set("is_playing", EditorApplication.isPlaying);
                rep.Set("animator_found", _anim != null);
                rep.Set("animator_was_enabled", _animWasEnabled);
                rep.Set("animator_frozen", _anim != null);
                var recs = new List<object>();
                for (int i = 0; i < _keyRecords.Count; i++) recs.Add(_keyRecords[i]);
                rep.Set("keys", recs);
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
                rep.Set("note", "本轮只做离线编译；Unity 实跑与键值/像素判读取证待验收。");
                var path = Path.Combine(_outDir, "report.json");
                try { AuditJson.WriteFile(path, rep); }
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

            /// <summary>
            /// 找带这些键的渲染器。优先按 body 指定的相对路径 / 叶名 / 子串匹配；没给 body 时，
            /// 在头像全部 SkinnedMeshRenderer 里挑「命中键最多」的一个（命中 0 个返回 null）。
            /// 与 AuditAvatar.Resolve 同口径：只认场景对象，不认预制体资产。
            /// </summary>
            private SkinnedMeshRenderer ResolveBody(string spec, JsonObject keys, out string relPath)
            {
                relPath = "";
                Transform aroot = _avatar.transform;
                var all = _avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true);
                int want = 0;
                foreach (var kv in keys.Items) want++;

                SkinnedMeshRenderer best = null;
                int bestHits = -1;
                string bestPath = "";
                for (int i = 0; i < all.Length; i++)
                {
                    var smr = all[i];
                    if (smr == null || smr.sharedMesh == null) continue;
                    string path = AuditUtil.RelPath(aroot, smr.transform);
                    if (!MatchesSpec(spec, smr, path)) continue;
                    int hits = 0;
                    foreach (var kv in keys.Items)
                        if (smr.sharedMesh.GetBlendShapeIndex(kv.Key) >= 0) hits++;
                    if (hits == 0 && !string.IsNullOrEmpty(spec)) continue;
                    if (hits > bestHits)
                    {
                        best = smr; bestHits = hits; bestPath = path;
                    }
                }
                relPath = bestPath;
                return best;
            }

            private static bool MatchesSpec(string spec, SkinnedMeshRenderer smr, string path)
            {
                if (string.IsNullOrEmpty(spec)) return true;
                if (string.Equals(path, spec, StringComparison.OrdinalIgnoreCase)) return true;
                if (string.Equals(smr.gameObject.name, spec, StringComparison.OrdinalIgnoreCase)) return true;
                return path.IndexOf(spec, StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }

        private static List<object> ManualDiff()
        {
            var l = new List<object>();
            l.Add("手工版同一 Play 里先 T1 reset 摆状态；脚本不代跑 T1，只回显当前模式。");
            l.Add("手工版一组键值一渲，0/100 两端发两次；脚本同款，一次请求一组。");
            l.Add("手工版无「设键→等帧→再读数」，脚本把冻结证据写进 report.keys[].readback_after_frames。");
            l.Add("手工版靠会话保活、人肉恢复；脚本 finally 恢复并把 readback_restored 落盘。");
            return l;
        }

        private static List<object> SourceRefs()
        {
            var l = new List<object>();
            l.Add("_长程任务_20260918/进度核查_20260919/testdocs.md:301,:436");
            l.Add("工程F/_施工记录.md:38-41");
            l.Add("开发工具/SOP/50_服装发型装配/收缩键可见后果_渲图对照.md");
            l.Add("_长程任务_20260918/审查产出/工程F/t3_arm_A3.json");
            return l;
        }

        private static string DefaultOutDir()
        {
            string project = Path.GetFileName(AuditRunner.ProjectRoot);
            string repo = Path.GetDirectoryName(AuditRunner.ProjectRoot) ?? AuditRunner.ProjectRoot;
            return Path.Combine(repo, "_长程任务_20260918", "审查产出", project, "t3_arm_freeze");
        }

        private static string UnderProject(string rel)
        {
            return Path.Combine(AuditRunner.ProjectRoot, rel.Replace('/', Path.DirectorySeparatorChar));
        }
    }
}
