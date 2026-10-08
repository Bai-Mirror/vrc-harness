import React, { useState } from "react";
import { call } from "./api";
import { shareLevel, when, type State } from "./labels";
import { archiveFactIsDiagnostic, archiveNextView, bytesText } from "./model";
import { ReconciliationView, ShareDrawer, type Reconciliation } from "./share";
import { Field, Panel, Status, useAction, useLoad } from "./ui";

/**
 * The project archive (docs/project-archive.md) on the project page: what is known, what is only inferred and waits
 * for the person, what is missing or went stale, and the next steps; plus whether the archive in the project is
 * current and verified. Nothing here decides for the person: an inference is only confirmed, corrected or rejected.
 */
type Fact = { id: string; objectId?: string; presentation?: string; text: string; effectiveStatus: string; evidenceLevel: string; confidence: number | null;
  source: { type: string }; basis?: string; staleBecause?: string[] };
type Overview = {
  known: Fact[]; inferred: Fact[]; stale: Fact[]; unknown: Fact[];
  missing: Array<{ kind: string; id: string; text: string; pending?: boolean }>;
  next: Array<{ kind: string; text: string }>;
  archive: { write: { status: "verified" | "failed"; error: string | null } | null; verifiedRevision: number | null; pending: boolean;
    safePoint: string | null; shareable: { ok: boolean; blockers: Array<{ code: string; text: string }> } };
};

function archiveState(archive: Overview["archive"]): State {
  if (archive.write?.status === "failed") return ["写入失败", "bad"];
  if (archive.verifiedRevision === null) return [archive.safePoint ? "等安全点写入" : "尚未写入", "muted"];
  if (archive.pending) return [`修订 ${archive.verifiedRevision}，有待写入的变化`, "info"];
  return [`修订 ${archive.verifiedRevision} 已校验`, "ok"];
}
const EVIDENCE: Record<string, string> = { none: "无证据", inference: "推断", document: "记录声称", observation: "文件观测", attestation: "本人确认",
  verification: "独立检查" };

type Share = { id: string; revision: number; level: string; output: string; bytes: number; at: string };
export function ProjectArchive({ projectId, refresh, changed, productionActions }: { projectId: string; refresh: number; changed: () => void;
  productionActions?: React.ReactNode }) {
  const [data, error] = useLoad<Overview | null>("project.facts", refresh, null, { projectId });
  const [restore] = useLoad<Reconciliation | null>("project.restore.report", refresh, null, { projectId });
  const [shares] = useLoad<Share[]>("project.share.list", refresh, [], { projectId });
  const [sharing, setSharing] = useState(false);
  const { busy, run } = useAction();
  if (!data) return error ? <Panel title="工程档案"><div className="banner bad">{error}</div></Panel> : null;
  const refreshArchive = () => run("archive", async () => { await call("project.archive.refresh", { projectId }, 600_000); changed(); },
    "已扫描工程并写入、校验档案");
  const decide = (fact: Fact, decision: "confirm" | "reject") => run(`fact:${fact.id}`, async () => {
    await call("project.fact.confirm", { projectId, factId: fact.id, decision }); changed();
  }, decision === "confirm" ? "已确认，记为本人确认的事实" : "已否定，这一项记为未知");
  const last = shares[0];
  const inferences = data.inferred.filter(fact => !archiveFactIsDiagnostic(fact));
  const diagnosticInferences = data.inferred.filter(archiveFactIsDiagnostic);
  const stale = data.stale.filter(fact => !archiveFactIsDiagnostic(fact));
  const diagnosticStale = data.stale.filter(archiveFactIsDiagnostic);
  const missing = data.missing.filter(item => !item.pending);
  const inferenceRow = (fact: Fact) => <div className="row" key={fact.id}>
    <div><b>{fact.text}</b><p>{fact.basis ?? EVIDENCE[fact.evidenceLevel]}{fact.confidence !== null ? ` · 置信 ${Math.round(fact.confidence * 100)}%` : ""}</p></div>
    <button disabled={Boolean(busy)} onClick={() => decide(fact, "confirm")}>确认</button>
    <button disabled={Boolean(busy)} onClick={() => decide(fact, "reject")}>不对</button>
  </div>;
  return (
    <Panel title="工程档案" actions={<>
      <button onClick={() => setSharing(true)}>分享工程…</button>
      <button disabled={busy === "archive"} onClick={refreshArchive}>{busy === "archive" ? "正在扫描…" : "刷新档案"}</button>
    </>}>
      {error ? <div className="banner bad">{error}</div> : null}
      {restore ? <ReconciliationView report={restore} projectId={projectId} changed={changed} /> : null}
      <Field label="工程内档案"><Status state={archiveState(data.archive)} /></Field>
      <Field label="可分享工程" value={data.archive.shareable.ok ? "无阻断" : `${data.archive.shareable.blockers.length} 项需要处理（分享时逐项列出）`} />
      {last ? <Field label="最近一次分享"><span><Status state={shareLevel(last.level)} /> {when(last.at)} · 修订 {last.revision} · {bytesText(last.bytes)}</span></Field> : null}
      {sharing ? <ShareDrawer projectId={projectId} close={() => setSharing(false)} changed={changed} /> : null}
      {data.next.length ? <div className="stack">{data.next.map((step, i) => {
        const view = archiveNextView(step);
        return <div className="row" key={`${step.kind}:${i}`}><div><p>{view.text}</p>
          {view.action === 'production' ? productionActions : null}
          {view.action === 'archive' ? <button disabled={Boolean(busy)} onClick={refreshArchive}>重新扫描并刷新档案</button> : null}
          {view.action === 'share' ? <button onClick={() => setSharing(true)}>检查分享内容</button> : null}
        </div></div>;
      })}</div> : null}
      {inferences.length ? <>
        <p className="muted">待确认推断（{inferences.length}）</p>
        {inferences.slice(0, 8).map(inferenceRow)}
        {inferences.length > 8 ? <small className="muted">另有 {inferences.length - 8} 项</small> : null}
      </> : null}
      {missing.length ? <>
        <p className="muted">缺失依赖（{missing.length}）</p>
        {missing.map(item => <div className="row" key={`${item.kind}:${item.id}`}><div><p>{item.text}</p></div></div>)}
      </> : null}
      {stale.length ? <>
        <p className="muted">失效证据（{stale.length}）</p>
        {stale.slice(0, 8).map(fact => <div className="row" key={fact.id}>
          <div><b>{fact.text}</b><p>{(fact.staleBecause ?? []).join("；")}</p></div></div>)}
      </> : null}
      <details className="technical-details">
        <summary>已知事实 {data.known.length} 项 · 未知 {data.unknown.length} 项</summary>
        {data.known.map(fact => <div className="row" key={fact.id}><div><b>{fact.text}</b><p>{EVIDENCE[fact.evidenceLevel]}</p></div></div>)}
        {data.unknown.map(fact => <div className="row" key={fact.id}><div><b>{fact.text}</b><p>未知：文件无法证明</p></div></div>)}
      </details>
      {data.next.length || data.archive.write?.error || diagnosticInferences.length || diagnosticStale.length ? <details className="technical-details">
        <summary>档案诊断与原始记录</summary>
        {data.archive.write?.error ? <p>{data.archive.write.error}</p> : null}
        {data.next.map((step, i) => <p key={`${step.kind}:${i}`}>{step.text}</p>)}
        {diagnosticInferences.length ? <><p>内部意图记录（{diagnosticInferences.length}）</p>{diagnosticInferences.map(inferenceRow)}</> : null}
        {diagnosticStale.map(fact => <p key={fact.id}>{fact.text} · {(fact.staleBecause ?? []).join('；')}</p>)}
        {data.missing.filter(item => item.pending).map(item => <p key={`${item.kind}:${item.id}`}>{item.text}（{item.id}）</p>)}
      </details> : null}
    </Panel>
  );
}
