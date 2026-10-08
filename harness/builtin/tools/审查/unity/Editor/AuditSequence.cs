// 【项目沉淀】
// 适用素体：无关（Unity 编辑器通用工具，不依赖任何素体 / 服装 / 插件版本）。
// 用途：审查「请求序列」——一次菜单触发按顺序跑完多个 T1/T3/T4/fit 子请求。
//   为什么需要：Claude 每跑一个 T1/T3/T4 请求都要经 MCP 触发一次菜单，批量场景
//   （逐套服装「设状态 → 渲图」×13、T-16/T-19 批跑）要触发几十次，慢且容易漏。
//   串成 `{"tool":"sequence", ...}` 后一次触发，由本工具在编辑器状态机里逐个驱动子工具。
//
// 工作原理（完全对齐 AuditRunner 的多帧泵，不新开线程、不阻塞主线程）：
//   - AuditSequence 自己就是一个 IAuditTool，被 AuditRunner 正常 Begin / Tick / Cleanup；
//   - 每个 Tick 只推进一步：当前子工具的 Tick() 返回 true（子 status 写 done）后才开下一步；
//   - 每个子请求有独立的 AuditContext（独立 OutDir / Status / DeadlineRealtime），
//     所以 status.json、audit.log、各工具产物都落在该子请求自己的 out 目录，与单独触发完全一致；
//   - 汇总目录写 sequence_status.json（每步 index / id / tool / out / state / seconds / error），
//     AuditRunner 顶层仍在汇总目录写一份粗粒度的 status.json（running → done / error / aborted）。
//
// 子请求之间状态延续（为什么样例是「T1 全穿 → T3 躯干四面」配对）：
//   T1（AuditStateDriver）的 Cleanup 故意保留最后一个状态的参数值（见该类注释：
//   「参数保持在最后一个状态（T3 环绕渲图要在同一批状态下拍）」），所以 T1 步骤 done 之后
//   紧接着跑 T3，拍到的就是 T1 设出来的那套状态；T3 自己不设任何参数。
//   序列里若要多步累积状态，T1 步骤用 `"reset": "none"`——本工具不做任何额外的状态搬运，
//   延续完全靠子工具自己的语义，避免「工具发明一套 VRChat 里不存在的状态机」。
//
// 为什么不支持嵌套 sequence：
//   没有「状态机里的状态机」用例；嵌套会让超时、汇总、清理都难以审计，Begin 直接报错。
//
// 临时改动 / 恢复：本工具自己不碰场景；每个子工具对场景的临时改动由它自己的 Cleanup 恢复，
//   序列在该步结束时立刻调一次（与 AuditRunner 对单请求的收尾时机一致）。

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace AvatarAudit
{
    public sealed class AuditSequence : IAuditTool
    {
        public string ToolId { get { return "sequence"; } }

        /// <summary>
        /// 只要有一个子步骤需要 Play，整条序列就要求 Play。
        /// AuditRunner 在 Begin 之前读这个属性决定要不要挡 / 自动进 Play，所以构造时就把 steps 解析出来。
        /// 未知 tool / 嵌套 sequence 一律保守地算「需要 Play」（宁可在编辑模式被挡，也不要漏跑 T1）。
        /// </summary>
        public bool RequiresPlayMode { get { return _requiresPlay; } }

        /// <summary>默认总超时 = 各步超时之和 + 每步 10s 余量；顶层 timeout_seconds 可覆盖。</summary>
        public int DefaultTimeoutSeconds { get { return _defaultTimeout; } }

        private sealed class Step
        {
            public int Index;
            public string Id;
            public string ToolId;
            public JsonObject Request;
            public string Out;
            public double TimeoutSeconds;
            public string State = "pending";   // pending / running / done / error / aborted / skipped
            public string Error;
            public double Seconds;
            public string StartedAt;
            public string FinishedAt;
            public IAuditTool Tool;
            public AuditContext Ctx;
            public double StartedRealtime;
            public double DeadlineRealtime;
        }

        private readonly JsonObject _request;
        private readonly List<Step> _steps = new List<Step>();
        private readonly bool _stopOnError;
        private readonly bool _requiresPlay;
        private readonly int _defaultTimeout;

        private AuditContext _ctx;
        private string _summaryOut;
        private string _startedAt;
        private int _current = -1;
        private bool _finished;
        private bool _hadError;
        private bool _hadAbort;
        private string _firstFailure;
        private string _overallState = "running";

        public AuditSequence(JsonObject request)
        {
            _request = request;
            _stopOnError = AuditJson.Bool(request, "stop_on_error", true);

            // 只做「算总超时 + 判断要不要 Play」所需的轻量解析；真正校验放 Begin（错误能写进 status.json）。
            int total = 0;
            bool needsPlay = false;
            var steps = AuditJson.Arr(request, "steps");
            for (int i = 0; i < steps.Count; i++)
            {
                var o = steps[i] as JsonObject;
                var toolId = AuditJson.Str(o, "tool", "state");
                total += (int)Math.Ceiling(AuditJson.Num(o, "timeout_seconds", StepDefaultTimeout(toolId))) + 10;
                if (RequiresPlay(toolId)) needsPlay = true;
            }
            _requiresPlay = needsPlay;
            _defaultTimeout = total > 0 ? total : 1800;
        }

        // ------------------------------------------------------------------ Begin

        public void Begin(AuditContext ctx)
        {
            _ctx = ctx;
            _summaryOut = ctx.OutDir;
            _startedAt = Now();
            _overallState = "running";

            var steps = AuditJson.Arr(ctx.Request, "steps");
            if (steps.Count == 0) throw new Exception("sequence 请求缺少非空的 steps 数组");

            for (int i = 0; i < steps.Count; i++)
            {
                var o = steps[i] as JsonObject;
                if (o == null) throw new Exception("steps[" + i + "] 不是 JSON 对象");

                var toolId = AuditJson.Str(o, "tool", "state");
                if (toolId == "sequence")
                    throw new Exception("steps[" + i + "] 又是 sequence：不支持嵌套 sequence（会超时/汇总/清理都说不清）");

                var id = AuditJson.Str(o, "id", null);
                if (string.IsNullOrEmpty(id))
                    id = (i + 1).ToString("00", CultureInfo.InvariantCulture) + "_" + toolId;

                // 便利：steps 里省略 avatar 时继承顶层 avatar（顶层写了才继承；不覆盖步骤自己的值）。
                if (!o.Has("avatar"))
                {
                    var av = AuditJson.Str(_request, "avatar", null);
                    if (!string.IsNullOrEmpty(av)) o.Set("avatar", av);
                }

                var outDir = AuditJson.Str(o, "out", null);
                if (string.IsNullOrEmpty(outDir))
                    outDir = Path.Combine(_summaryOut, (i + 1).ToString("00", CultureInfo.InvariantCulture) + "_" + AuditUtil.SafeFileName(id));
                else if (!Path.IsPathRooted(outDir))
                    throw new Exception("steps[" + i + "].out 必须是绝对路径，或省略以自动生成：'" + outDir + "'");

                _steps.Add(new Step
                {
                    Index = i,
                    Id = id,
                    ToolId = toolId,
                    Request = o,
                    Out = outDir,
                    TimeoutSeconds = AuditJson.Num(o, "timeout_seconds", StepDefaultTimeout(toolId)),
                });
            }

            WriteSummary();
            ctx.Status.Log("sequence：共 " + _steps.Count + " 步，stop_on_error=" + _stopOnError
                + "，requires_play_mode=" + _requiresPlay + "，默认总超时 " + _defaultTimeout + "s");
            StartStep(0);
        }

        // ------------------------------------------------------------------ Tick

        public bool Tick()
        {
            if (_finished) return FinishAndReturn();

            if (_current < 0 || _current >= _steps.Count) return FinishAndReturn();
            var s = _steps[_current];

            // 该步在 Begin 阶段（建目录/建工具/工具 Begin）就失败了：按 stop_on_error 决定继续还是收尾。
            if (s.Tool == null)
            {
                if (AdvanceAfterStep()) return FinishAndReturn();
                return false;
            }

            bool stepSettled = false;
            try
            {
                if (RequiresPlay(s.ToolId) && !EditorApplication.isPlaying)
                    throw new Exception("Play 模式已退出，序列中断");
                if (Time.realtimeSinceStartup > s.DeadlineRealtime)
                    throw new TimeoutException("步骤超时（" + AuditUtil.F(s.TimeoutSeconds) + "s，可用 steps[].timeout_seconds 放宽）");

                if (s.Tool.Tick())
                {
                    if (!string.IsNullOrEmpty(s.Ctx.AbortReason)) FinalizeStep(s, "aborted", s.Ctx.AbortReason);
                    else FinalizeStep(s, "done", null);
                    stepSettled = true;
                }
            }
            catch (Exception e)
            {
                var real = AuditUtil.Unwrap(e);
                FinalizeStep(s, "error", "运行失败：" + real.Message + "\n" + real);
                stepSettled = true;
            }

            if (!stepSettled) return false;
            // 注意：FinishAndReturn 可能抛「整条序列失败」，必须放在上面的 try/catch 之外，
            // 否则会被同一个 catch 当成当前步的运行失败、把已判定的最后一步改写成 error。
            if (AdvanceAfterStep()) return FinishAndReturn();
            return false;
        }

        private void StartStep(int index)
        {
            _current = index;
            var s = _steps[index];

            var stepCtx = new AuditContext();
            stepCtx.Request = s.Request;
            stepCtx.OutDir = s.Out;
            stepCtx.Tool = s.ToolId;
            stepCtx.Status = new AuditStatus(s.Out, s.ToolId);
            stepCtx.DeadlineRealtime = Time.realtimeSinceStartup + s.TimeoutSeconds;
            s.Ctx = stepCtx;
            s.StartedRealtime = Time.realtimeSinceStartup;
            s.DeadlineRealtime = stepCtx.DeadlineRealtime;
            s.StartedAt = Now();
            s.State = "running";

            try { Directory.CreateDirectory(s.Out); }
            catch (Exception e) { FinalizeStep(s, "error", "建输出目录失败 " + s.Out + "：" + e.Message); return; }

            try { s.Tool = CreateTool(s.ToolId); }
            catch (Exception e) { FinalizeStep(s, "error", AuditUtil.Unwrap(e).Message); return; }

            s.Ctx.Status.Running("0/?", "sequence 第 " + (index + 1) + "/" + _steps.Count + " 步开始：" + s.ToolId + " → " + s.Out);
            WriteSummary();
            _ctx.Status.Running(Progress(), "第 " + (index + 1) + "/" + _steps.Count + " 步：" + s.Id + "（" + s.ToolId + "）");

            try { s.Tool.Begin(s.Ctx); }
            catch (Exception e)
            {
                var real = AuditUtil.Unwrap(e);
                FinalizeStep(s, "error", "初始化失败：" + real.Message + "\n" + real);
            }
        }

        // ------------------------------------------------------------------ 步收尾 / 推进

        private void FinalizeStep(Step s, string state, string error)
        {
            s.State = state;
            s.Error = error;
            s.FinishedAt = Now();
            s.Seconds = Time.realtimeSinceStartup - s.StartedRealtime;

            if (s.Tool != null)
            {
                try { s.Tool.Cleanup(); }
                catch (Exception e)
                {
                    var real = AuditUtil.Unwrap(e);
                    if (s.Ctx != null && s.Ctx.Status != null)
                        s.Ctx.Status.Log("Cleanup 失败（可能有 layer/enabled 没恢复）：" + real.Message);
                }
                s.Tool = null;
            }

            if (s.Ctx != null && s.Ctx.Status != null)
            {
                if (state == "done") s.Ctx.Status.Done("100%", "完成（sequence 第 " + (s.Index + 1) + " 步）");
                else if (state == "aborted") s.Ctx.Status.Aborted(error);
                else s.Ctx.Status.Error(error);
            }

            if (state == "error")
            {
                _hadError = true;
                if (_firstFailure == null) _firstFailure = "第 " + (s.Index + 1) + " 步 " + s.Id + "（" + s.ToolId + "）：" + error;
            }
            else if (state == "aborted")
            {
                _hadAbort = true;
                if (_firstFailure == null) _firstFailure = "第 " + (s.Index + 1) + " 步 " + s.Id + "（" + s.ToolId + "）：" + error;
            }
            WriteSummary();
        }

        /// <summary>当前步已收尾：返回 true 表示整条序列可以收尾了；false 表示已开始下一步（或无事可做）。</summary>
        private bool AdvanceAfterStep()
        {
            bool failed = _steps[_current].State != "done";
            if (failed && _stopOnError) return Finish();

            int next = _current + 1;
            while (next < _steps.Count)
            {
                if (StartStepOk(next)) return false;
                if (_stopOnError) return Finish();
                next++;
            }
            return Finish();
        }

        private bool StartStepOk(int index)
        {
            StartStep(index);
            return _steps[index].Tool != null && _steps[index].State == "running";
        }

        private bool Finish()
        {
            if (!_finished)
            {
                _finished = true;
                _overallState = _hadError ? "error" : (_hadAbort ? "aborted" : "done");
                if (_hadAbort && !_hadError)
                    _ctx.Abort("序列里有步骤 aborted：" + (_firstFailure ?? ""));
                WriteSummary();
                _ctx.Status.Log("sequence 结束：state=" + _overallState + "，失败/中止：" + (_firstFailure ?? "无"));
            }
            return true;
        }

        /// <summary>AuditRunner 只会把「Tick 抛异常」写成顶层 status=error，所以序列失败必须抛。</summary>
        private bool FinishAndReturn()
        {
            Finish();
            if (_hadError)
                throw new Exception("序列失败（详见 " + Path.Combine(_summaryOut, "sequence_status.json") + "）：" + _firstFailure);
            return true;
        }

        // ------------------------------------------------------------------ Cleanup

        public void Cleanup()
        {
            if (_current >= 0 && _current < _steps.Count)
            {
                var s = _steps[_current];
                if (s.Tool != null)
                {
                    try { s.Tool.Cleanup(); }
                    catch (Exception e)
                    {
                        var real = AuditUtil.Unwrap(e);
                        if (s.Ctx != null && s.Ctx.Status != null)
                            s.Ctx.Status.Log("Cleanup 失败（可能有 layer/enabled 没恢复）：" + real.Message);
                    }
                    s.Tool = null;
                }
                if (s.State == "running")
                {
                    s.State = "error";
                    if (string.IsNullOrEmpty(s.Error)) s.Error = "被中止（Cleanup 时该步仍在运行）";
                    s.FinishedAt = Now();
                    s.Seconds = Time.realtimeSinceStartup - s.StartedRealtime;
                    if (s.Ctx != null && s.Ctx.Status != null) s.Ctx.Status.Error(s.Error);
                }
            }
            for (int i = _current + 1; i < _steps.Count; i++)
                if (_steps[i].State == "pending") _steps[i].State = "skipped";

            if (!_finished)
            {
                // 走到这里说明是外部中止（手动 Abort / 顶层超时 / Play 退出）：没有正常 Finish 过。
                _finished = true;
                _hadError = true;
                _overallState = "error";
                if (_firstFailure == null && _current >= 0 && _current < _steps.Count)
                    _firstFailure = "第 " + (_current + 1) + " 步 " + _steps[_current].Id + " 被中止";
                _ctx.Status.Log("sequence 被中止：state=error，当前步 " + (_current + 1) + "/" + _steps.Count);
            }
            WriteSummary();
        }

        // ------------------------------------------------------------------ 输出

        private void WriteSummary()
        {
            if (string.IsNullOrEmpty(_summaryOut)) return;
            try
            {
                var o = new JsonObject();
                o.Set("tool", "sequence");
                o.Set("out", _summaryOut);
                o.Set("state", _overallState);
                o.Set("stop_on_error", _stopOnError);
                o.Set("requires_play_mode", _requiresPlay);
                o.Set("step_count", _steps.Count);
                o.Set("started_at", _startedAt);
                o.Set("finished_at", _finished ? Now() : null);
                o.Set("current_index", _current >= 0 && _current < _steps.Count && !_finished ? (object)(_current + 1) : null);
                o.Set("failure", _firstFailure);
                o.Set("note", "每步的完整输出（status.json / audit.log / 各工具产物）仍写在该步自己的 out 目录；本文件只汇总。");

                var arr = new List<object>();
                foreach (var s in _steps)
                {
                    var e = new JsonObject();
                    e.Set("index", s.Index + 1);
                    e.Set("id", s.Id);
                    e.Set("tool", s.ToolId);
                    e.Set("out", s.Out);
                    e.Set("state", s.State);
                    bool hasTime = s.State != "pending" && s.State != "skipped";
                    e.Set("seconds", hasTime ? (object)Math.Round(s.Seconds, 3) : null);
                    e.Set("started_at", s.StartedAt);
                    e.Set("finished_at", s.FinishedAt);
                    e.Set("error", s.Error);
                    arr.Add(e);
                }
                o.Set("steps", arr);
                AuditJson.WriteFile(Path.Combine(_summaryOut, "sequence_status.json"), o);
            }
            catch (Exception e)
            {
                Debug.LogError("[AvatarAudit] 写 sequence_status.json 失败：" + e.Message);
            }
        }

        private string Progress()
        {
            int settled = 0;
            foreach (var s in _steps)
                if (s.State == "done" || s.State == "error" || s.State == "aborted") settled++;
            return settled + "/" + _steps.Count;
        }

        // ------------------------------------------------------------------ 工具表（与 AuditIO 分派表同一套语义）

        private static IAuditTool CreateTool(string toolId)
        {
            if (toolId == "state") return new AuditStateDriver();
            if (toolId == "turntable") return new AuditTurntable();
            if (toolId == "fit") return new AuditFitProbe();
            if (toolId == "menu") return AuditMenuDump.Create();
            throw new Exception("未知 tool: " + toolId + "（sequence 支持 state / turntable / fit / menu）");
        }

        private static int StepDefaultTimeout(string toolId)
        {
            if (toolId == "turntable") return 3600;
            if (toolId == "menu") return 300;
            return 1800;   // state / fit / 未知
        }

        private static bool RequiresPlay(string toolId)
        {
            if (toolId == "turntable") return false;
            return true;   // state / fit / menu / 未知 / sequence 保守算需要
        }

        private static string Now()
        {
            return DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
        }
    }
}
