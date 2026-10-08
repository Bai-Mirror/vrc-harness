import React from "react";
import { call } from "./api";
import { bytesText, errorText, jobText } from "./model";
import { Drawer, Field, Panel, useAction, useFeedback } from "./ui";

/**
 * The preview a diagnostics export shows before anything is written (D-133, 实施合同 §4.5 的单次故障支持). The plan
 * comes from the Runtime with no side effect at all, and the export writes a zip locally: it is never uploaded, and
 * the only thing a person has to decide is whether the listed members may leave the machine.
 */
export type DiagnosticItem = {
  path: string; category: string; reason: string; bytes: number; keptBytes: number; included: boolean;
  excludedBecause?: string; redactions: Array<{ id: string; count: number }>;
};
export type DiagnosticIssue = {
  kind: "failure" | "blocked" | "warning";
  category: string;
  text: string;
  stageId: string | null;
  checkId: string | null;
  checkLabel: string | null;
  runId: string | null;
  reading: Record<string, unknown>;
  basis: string;
  at: string | null;
  attachments: string[];
};
export type DiagnosticsPlan = {
  schema: string; generatedAt: string;
  project: { id: string; name: string; path: string; hasOrderNumber: boolean };
  since: string | null;
  workflow: { id: string; status: string; furthestStage: string | null; blockedAt: string | null; blockedWhy: string | null } | null;
  workflowCount: number;
  issues: DiagnosticIssue[];
  timeline: Array<{ at: string; actor: string; action: string; entityType: string; entityId: string; reason?: string }>;
  items: DiagnosticItem[];
  excluded: DiagnosticItem[];
  policy: Array<{ category: string; what: string; why: string }>;
  totals: { included: number; keptBytes: number; sourcesBytes: number; excluded: number; dropped: number; redactions: number; truncated: string[] };
  budget: { limitBytes: number; reservedBytes: number; attachmentBudgetBytes: number; estimatedPackageBytes: number };
  /** The member names, sizes and content hashes the export is bound to; `manifestDigest` is what the export carries. */
  manifest: Array<{ path: string; bytes: number; sha256: string }>;
  manifestDigest: string;
  warnings: string[];
  privacyWords: { path: string; applied: number; problems: string[] };
};
export type DiagnosticsResult = {
  status: "exported" | "refused";
  plan: DiagnosticsPlan;
  package?: { path: string; bytes: number; sha256: string; members: number };
  refusal?: { code: "credential" | "content_changed" | "over_budget"; reason: string; members: Array<{ path: string; detectors: string[] }> };
};

export type DiagnosticsJob = {
  progress: { phase: string; done?: number; total?: number } | null;
  running: string;
  start: <T,>(method: string, params: Record<string, unknown>) => Promise<T>;
};

/** The category words, mirroring the Runtime's own table; an unknown value is shown as it came rather than guessed. */
export const DIAGNOSTIC_CATEGORY: Record<string, string> = {
  product_defect: "产品缺陷", environment: "环境", material: "素材", requirement_decision: "需求决定",
  known_limitation: "已知限制命中",
};
export const categoryText = (category: string): string => DIAGNOSTIC_CATEGORY[category] ?? category;
export const issueKindText = (kind: DiagnosticIssue["kind"]): string =>
  kind === "failure" ? "失败" : kind === "blocked" ? "阻断" : "提醒";

/** Ask the Runtime for the preview: a read with no side effect. */
export async function previewDiagnostics(projectId: string, since?: string): Promise<DiagnosticsPlan> {
  const result = await call<{ plan: DiagnosticsPlan }>("project.diagnostics.preview", { projectId, ...(since ? { since } : {}) }, 600_000);
  return result.plan;
}

/** Refusals name the members that still matched after packing; the caller shows them, never the values. */
export function refusalText(result: DiagnosticsResult): string {
  if (result.refusal?.code === "content_changed")
    return `${result.refusal.reason}（预览显示 ${result.plan.manifest.length} 个成员；重新预览后再导出）`;
  const lines = [result.refusal?.reason ?? "诊断包没有导出"];
  for (const member of result.refusal?.members ?? []) lines.push(`${member.path}：${member.detectors.join("、")}`);
  return lines.join("\n");
}

/**
 * 「导出诊断包…」 on the project page's technical-details level: a person exports a diagnostic bundle on purpose, and
 * the button only opens the preview. `job` is the project page's own archive-job follower, so a running share, restore
 * or diagnostics export still excludes the others.
 */
export function DiagnosticsPanel({ projectId, job, changed }: { projectId: string; job: DiagnosticsJob; changed: () => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Panel title="诊断包" actions={<button disabled={Boolean(job.running)} onClick={() => setOpen(true)}>导出诊断包…</button>}>
      <p className="muted">把版本与环境、各阶段状态、问题清单、事件时间线与失败处的日志窗口打成一个 zip，交给你指定的人定位产品问题或产品局限。先预览，再导出；只写在本机，不自动上传。</p>
      {open ? <DiagnosticsDrawer projectId={projectId} job={job} changed={changed} close={() => setOpen(false)} /> : null}
    </Panel>
  );
}

/**
 * 「导出诊断包…」: the preview a person checks, then one button that writes the zip. The classification is shown with
 * its reasoning so nobody reads it as a verdict, and the whole-content refusals are listed before the included members
 * rather than folded away -- what is *not* in the package is the part a person cannot verify afterwards.
 */
export function DiagnosticsDrawer({ projectId, close, job, changed }: {
  projectId: string; close: () => void; job: DiagnosticsJob; changed: () => void;
}) {
  const feedback = useFeedback();
  const { busy, run } = useAction();
  const [plan, setPlan] = React.useState<DiagnosticsPlan | null>(null);
  const [done, setDone] = React.useState<DiagnosticsResult | null>(null);
  const [error, setError] = React.useState("");
  const [again, setAgain] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    setError("");
    previewDiagnostics(projectId).then(next => { if (live) setPlan(next); })
      .catch(reason => { if (live) setError(errorText(reason)); });
    return () => { live = false; };
  }, [projectId, again]);
  const exportBundle = () => run("diagnose", async () => {
    // The export is bound to the manifest this drawer showed (R28 P1-3): the Runtime recompiles in a separate process,
    // so the digest and compile instant travel with the request and a mismatch is refused, never silently written.
    const result = await job.start<DiagnosticsResult>("project.diagnostics.export", {
      projectId, expectDigest: plan?.manifestDigest, generatedAt: plan?.generatedAt,
    });
    setPlan(result.plan);
    if (result.status === "refused") {
      if (result.refusal?.code === "content_changed") { setAgain(value => value + 1); setDone(null); }
      throw new Error(refusalText(result));
    }
    setDone(result);
    changed();
  }, "诊断包已导出，并通过逐成员复扫");
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => feedback.ok("路径已复制"));
  const kept = plan?.items.filter(item => item.included) ?? [];
  const exporting = job.running === "project.diagnostics.export";
  return (
    <Drawer title="导出诊断包" onClose={close} footer={<>
      <small className="reason">{job.running ? jobText(job.progress) : done ? "诊断包已通过逐成员复扫" : plan ? `将收录 ${plan.totals.included} 个附件，${bytesText(plan.totals.keptBytes)}` : "正在汇总…"}</small>
      <button onClick={close}>{done ? "完成" : "取消"}</button>
      {done ? null : <button className="primary" disabled={!plan || Boolean(job.running) || busy === "diagnose"} onClick={exportBundle}>
        {exporting ? "正在导出…" : "导出诊断包"}</button>}
    </>}>
      <p className="muted">诊断包给帮你定位产品问题或产品局限的人看：版本与环境、各阶段状态、问题清单、事件时间线与失败处的日志窗口。它只写在本机，不会自动上传；素材原件、工程文件、密钥与登录态、提示词与对话、图片都不收录。</p>
      {error ? <div className="banner bad">{error}</div> : null}
      {job.running ? <div className="stack" role="status" aria-live="polite"><span>{jobText(job.progress)}</span></div> : null}
      {done?.package ? <div className="share-block">
        <div className="banner info">已导出：{bytesText(done.package.bytes)}，{done.package.members} 个成员；导出后已逐成员复扫，没有命中密钥、私人路径、订单号或本地词表。</div>
        <Field label="诊断包"><span className="share-path">{done.package.path}</span></Field>
        <Field label="SHA-256" value={done.package.sha256} />
        <div className="actions"><button onClick={() => copy(done.package!.path)}>复制路径</button></div>
      </div> : null}
      {plan && !done ? <>
        <div className="share-block">
          <h4>会收录什么</h4>
          <p className="muted">清单摘要：{plan.manifest.length} 个成员，内容摘要 <span className="share-path">{plan.manifestDigest.slice(0, 16)}</span>。导出按钮把这份清单交给导出步骤；重新编译后清单不同就拒绝并请你重新预览。</p>
          {plan.issues.length ? <>
            <p className="muted">问题清单 {plan.issues.length} 条；归类是初步建议，不是结论。</p>
            {plan.issues.slice(0, 12).map((issue, index) => <div className="row" key={`${issue.kind}:${issue.at}:${index}`}>
              <div><b>{issueKindText(issue.kind)} · {categoryText(issue.category)}</b>
                <p>{issue.text}</p>
                <small className="reason">{issue.checkId ? `判据 ${issue.checkLabel ?? ""}（${issue.checkId}）· ` : ""}{issue.basis}</small></div>
            </div>)}
            {plan.issues.length > 12 ? <small className="reason">另有 {plan.issues.length - 12} 条，见包内的 report.md</small> : null}
          </> : <p className="muted">没有记录到失败、阻断或提醒。</p>}
        </div>
        <div className="share-block">
          <h4>附件（{kept.length}）</h4>
          {kept.map(item => <div className="row" key={item.path}><div><b className="share-path">{item.path}</b>
            <p>{bytesText(item.keptBytes)} · {item.reason}</p>
            {item.redactions.length ? <small className="reason">已替换：{item.redactions.map(hit => `${hit.id}×${hit.count}`).join("、")}</small> : null}</div></div>)}
        </div>
        <details className="technical-details">
          <summary>整类排除与不收录的内容（{plan.policy.length} 类）</summary>
          {plan.policy.map(item => <p key={item.category}><b>{item.what}</b>：{item.why}</p>)}
          {plan.excluded.map(item => <p key={item.path} className="share-path">{item.path}：{item.excludedBecause ?? item.reason}</p>)}
        </details>
        {plan.totals.truncated.length ? <details className="technical-details" open>
          <summary>截断了什么</summary>
          {plan.totals.truncated.map(note => <p key={note}>{note}</p>)}
        </details> : null}
        {plan.warnings.length ? <details className="technical-details">
          <summary>编译时的不确定项</summary>
          {plan.warnings.map(warning => <p key={warning}>{warning}</p>)}
        </details> : null}
        <p className="muted">脱敏：{plan.privacyWords.path}（生效 {plan.privacyWords.applied} 条{plan.privacyWords.problems.length ? `，${plan.privacyWords.problems.length} 条问题已跳过` : ""}）；报告、机读文档、成员名与包名都经过同一套脱敏，命中规则的本机路径、订单号与登录态已替换为占位符。导出后对压缩包每个成员再扫描一次，命中密钥、私人路径、订单号或本地词表就拒绝导出。</p>
      </> : null}
    </Drawer>
  );
}

