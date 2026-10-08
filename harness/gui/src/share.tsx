import React, { useCallback, useEffect, useState } from "react";
import { call } from "./api";
import { restoreDecision, shareLevel, stageLabel } from "./labels";
import { blockerAction, bytesText, errorText, groupLayer, groupRegistration, jobShare, jobText } from "./model";
import { Drawer, Field, Status, useAction, useFeedback } from "./ui";

/**
 * Sharing a project that can be continued, and restoring one (docs/project-share.md). What a person must see is never
 * folded away: what blocks the package, what the receiver will have to supply, the sensitive items and what the
 * receiver can do with it. The complete lists (what stayed out and why) are one click deeper.
 */
type Progress = { phase: string; done?: number; total?: number };
/** Exported so another archive-family job (the diagnostics export) follows the same `avh … --json --progress` shape. */
export type { Progress as ArchiveProgress };
type Group = { path: string; count: number; bytes: number; layer?: "A" | "B" | "C" };
type Blocker = { code: string; text: string; paths?: string[]; count?: number; acknowledgeable?: boolean; groups?: Group[] };
type Item = { id: string; layer: "B" | "C"; text: string; files: number; bytes: number; included: boolean; problem?: string };
export type SharePlan = {
  projectId: string; name: string; purpose: 'self' | 'others'; revision: number | null; ready: boolean; level: string; levelText: string; levelReasons: string[];
  blockers: Blocker[]; warnings: string[]; items: Item[];
  included: { files: number; dirs: number; bytes: number; byLayer: Record<"A" | "B" | "C", { files: number; bytes: number }> };
  excluded: Array<{ path: string; count: number; bytes: number; reason: string; restore: string | null }>;
  missing: Array<{ path: string; count: number; bytes: number; text: string }>;
  findings: Array<{ path: string; detector: string; kind: string; line: number | null; text: string; acknowledged: boolean }>;
  receiver: string[];
};
type ShareResult = { status: "ready" | "blocked" | "exported"; plan: SharePlan;
  package?: { path: string; bytes: number; sha256: string; members: number; cold: { files: number } } };
type PackPlan = { workflowId: string; current: boolean; resolution: string; text: string; releaseId?: string };
export type RestoreCheck = {
  archive: string; bytes: number; ok: boolean; problems: string[]; warnings: string[];
  manifest?: { name: string; purpose: 'self' | 'others'; revision: number; level: string; levelText: string; levelReasons: string[]; createdAt: string; files: number; bytes: number;
    producer: { version: string }; optional: Array<{ id: string; layer: string; text: string; included: boolean }> };
  decision?: { kind: string; action: string; text: string; target?: string };
  packs: PackPlan[]; projectPacks: Array<{ id: string; ok: boolean; text: string }>; missing: string[];
};
export type Reconciliation = {
  restoreId: string; at: string; decision: { kind: string; action: string; text: string };
  source: { name: string; revision: number; harness: string; level: string; levelText: string };
  path: string; backup: string | null; restored: Record<string, number>; pathChanges: string[]; missing: string[];
  pending: Array<{ workflowId: string; text: string; bound: boolean }>; candidates: string[];
  recovery: Array<{ taskId: string; stage: string; text: string }>; stale: Array<{ id: string; text: string; because: string[] }>;
  continuable: string[]; next: string[]; level: string; levelText: string; warnings: string[];
};
type RestoreResult = { status: "restored" | "blocked" | "unchanged"; check: RestoreCheck; projectId?: string; path?: string; reconciliation?: Reconciliation };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/**
 * Run one background share, restore or diagnostics job and follow it until its report arrives. Exported because the
 * diagnostics export is the same protocol: start an `avh … --json --progress` command, then follow `project.archive.job`.
 */
export function useArchiveJob() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState("");
  const start = useCallback(async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
    setRunning(method); setProgress(null);
    try {
      const started = await call<{ id: string }>(method, params);
      for (;;) {
        await sleep(600);
        const state = await call<{ job: { id: string; progress?: Progress } | null; last: { id: string; ok: boolean; result?: unknown; error?: string } | null }>("project.archive.job");
        if (state.job?.id === started.id) { setProgress(state.job.progress ?? null); continue; }
        if (state.last?.id !== started.id) throw new Error("后台任务的结果没有找到，请重试");
        if (state.last.result === undefined) throw new Error(state.last.error ?? "后台任务失败");
        const result = state.last.result as { status?: string; error?: string };
        if (result.status === "failed") throw new Error(result.error ?? "后台任务失败");
        return state.last.result as T;
      }
    } finally { setRunning(""); }
  }, []);
  return { progress, running, start };
}
function JobProgress({ progress }: { progress: Progress | null }) {
  const share = jobShare(progress);
  return (
    <div className="stack" role="status" aria-live="polite">
      <span>{jobText(progress)}</span>
      {share === null ? null : <div className="progress"><i style={{ width: `${Math.round(share * 100)}%` }} /></div>}
    </div>
  );
}
const copy = (text: string) => navigator.clipboard.writeText(text);

/** The share action of the project archive: a preview of the explicit list, the choices it needs, and one button. */
export function ShareDrawer({ projectId, close, changed }: { projectId: string; close: () => void; changed: () => void }) {
  const feedback = useFeedback();
  const job = useArchiveJob();
  const { busy, run } = useAction();
  const [withB, setWithB] = useState(false);
  const [purpose, setPurpose] = useState<'self' | 'others' | null>(null);
  const [include, setInclude] = useState<string[]>([]);
  const [permittedOnly, setPermittedOnly] = useState(false);
  const [acknowledge, setAcknowledge] = useState<string[]>([]);
  const [recipient, setRecipient] = useState("");
  const [plan, setPlan] = useState<SharePlan | null>(null);
  const [done, setDone] = useState<ShareResult | null>(null);
  const [error, setError] = useState("");
  const [again, setAgain] = useState(0);
  const params = { purpose, layers: withB ? ["A", "B"] : ["A"], include, permittedOnly: purpose === 'others' && permittedOnly, acknowledge };
  const key = JSON.stringify(params);
  useEffect(() => {
    if (!purpose) { setPlan(null); return; }
    let live = true;
    setError("");
    job.start<ShareResult>("project.share.preview", { projectId, ...params })
      .then(result => { if (live) setPlan(result.plan); }).catch(reason => { if (live) setError(errorText(reason)); });
    return () => { live = false; };
  }, [projectId, key, again]);
  const recheck = () => setAgain(value => value + 1);
  const classify = (group: Group, rights: "transferable" | "not_transferable" | "exclude") => run(`classify:${group.path}`, async () => {
    await call("project.files.classify", { projectId, ...groupRegistration(group.path), shareLayer: rights === "exclude" ? "excluded" : group.layer ?? groupLayer(group.path),
      rights: rights === "exclude" ? "unknown" : rights, note: rights === "exclude" ? "分享时确认：不随分享包" : rights === "transferable" ? "分享时确认：可以转交" : "分享时确认：不能转交" });
    changed(); recheck();
  });
  const exportPackage = () => run("export", async () => {
    if (!purpose) throw new Error('先选择包的用途');
    const result = await job.start<ShareResult>("project.share.export", { projectId, ...params,
      ...(purpose === 'others' && recipient.trim() ? { recipient: recipient.trim() } : {}) });
    setPlan(result.plan);
    if (result.status !== "exported") throw new Error("分享包没有导出：还有需要处理的问题");
    setDone(result); changed();
  }, "分享包已导出并通过校验");
  const bItems = plan?.items.filter(item => item.layer === "B") ?? [], cItems = plan?.items.filter(item => item.layer === "C") ?? [];
  const blocked = Boolean(plan && !plan.ready);
  const exporting = job.running === "project.share.export";
  return (
    <Drawer title="分享可继续制作的工程" onClose={close} footer={<>
      <small className="reason">{job.running ? jobText(job.progress) : done ? "分享包已通过 7z 测试、逐项比对与冷解包校验" : blocked ? "先处理上面列出的问题" : plan ? `将附带 ${plan.included.files} 个文件，${bytesText(plan.included.bytes)}` : "正在检查…"}</small>
      <button onClick={close}>{done ? "完成" : "取消"}</button>
      {done ? null : <button className="primary" disabled={!plan?.ready || Boolean(job.running) || busy === "export"} onClick={exportPackage}>{exporting ? "正在导出…" : "导出分享包"}</button>}
    </>}>
      <p className="muted">包里是 Unity 工程和工程档案。先选择用途，再检查会附带什么。</p>
      <div className="share-block"><h4>这个包给谁用？</h4>
        <label className="check-row-label"><input type="radio" name="share-purpose" checked={purpose === 'self'} onChange={() => setPurpose('self')} />
          <span><b>本人迁移/备份</b><small>完整带走工程内已导入的素材；仅限本人使用，不得转交他人。</small></span></label>
        <label className="check-row-label"><input type="radio" name="share-purpose" checked={purpose === 'others'} onChange={() => setPurpose('others')} />
          <span><b>交给他人</b><small>只附带获准转交的素材；其余列为接收端待补齐。</small></span></label>
      </div>
      {error ? <div className="banner bad">{error}</div> : null}
      {job.running ? <JobProgress progress={job.progress} /> : null}
      {done?.package ? <div className="share-block">
        <div className="banner info">已导出：{bytesText(done.package.bytes)}，{done.package.members} 个成员；7z 完整性测试、成员与清单逐项比对、冷解包校验都已通过。</div>
        <Field label="分享包"><span className="share-path">{done.package.path}</span></Field>
        <div className="actions"><button onClick={() => copy(done.package!.path).then(() => feedback.ok("路径已复制"))}>复制路径</button></div>
        <h4>对方需要做的事</h4>
        <ul className="share-list">{done.plan.receiver.map(item => <li key={item}>{item}</li>)}</ul>
      </div> : null}
      {plan && !done ? <>
        <div className="share-head">
          <Status state={shareLevel(plan.level)} /><b>{plan.name}</b><small className="muted">修订 {plan.revision ?? "—"}</small>
        </div>
        {plan.levelReasons.length ? <ul className="share-list">{plan.levelReasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}
        {plan.blockers.map(blocker => <BlockerView key={blocker.code} blocker={blocker} busy={busy || job.running} classify={classify}
          acknowledge={path => setAcknowledge(list => [...new Set([...list, path])])} recheck={recheck} />)}
        {plan.missing.length ? <div className="share-block">
          <div className="banner warn">接收端待补齐：这些文件不随包，对方需要自己取得</div>
          <ul className="share-list">{plan.missing.map(item => <li key={item.path}>{item.text}</li>)}</ul>
        </div> : null}
        <div className="share-block">
          <h4>附带什么</h4>
          <Field label="接续必需（总是附带）" value={`${plan.included.byLayer.A.files} 个文件 · ${bytesText(plan.included.byLayer.A.bytes)}`} />
          {purpose === 'others' && (plan.blockers.some(item => item.code === "rights") || permittedOnly) ? <label className="check-row-label">
            <input type="checkbox" checked={permittedOnly} disabled={Boolean(job.running)} onChange={event => setPermittedOnly(event.target.checked)} />
            只分享获准转交的内容，其余列为接收端待补齐（对方拿到后需要自己补上这些文件才能完整续做）
          </label> : null}
          {bItems.length ? <label className="check-row-label">
            <input type="checkbox" checked={withB} disabled={Boolean(job.running)} onChange={event => setWithB(event.target.checked)} />
            附带过程资料（可选，不含敏感内容）：{bItems.map(item => item.text).join("、")}（{bytesText(bItems.reduce((sum, item) => sum + item.bytes, 0))}）
          </label> : null}
          {cItems.length ? <details className="dependency-group" open={include.length > 0}>
            <summary><b>敏感内容</b><span>默认不附带；勾选的每一项都会交给对方</span><span>{include.length ? `已选 ${include.length} 项` : "未选"}</span></summary>
            {cItems.map(item => <label className="check-row-label" key={item.id}>
              <input type="checkbox" checked={include.includes(item.id)} disabled={Boolean(job.running)}
                onChange={event => setInclude(list => event.target.checked ? [...list, item.id] : list.filter(id => id !== item.id))} />
              <span>{item.text}<small className="reason">　{item.files} 个文件 · {bytesText(item.bytes)}{item.problem ? ` · ${item.problem}` : ""}</small></span>
            </label>)}
          </details> : null}
          {purpose === 'others' ? <label className="stack">接收者（只记在本机，不进分享包）<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="例如：协作的朋友" /></label> : null}
        </div>
        <details className="technical-details">
          <summary>没有附带的内容（{plan.excluded.length} 组）与说明</summary>
          {plan.excluded.map(item => <div className="row" key={item.path}><div><b className="share-path">{item.path}</b><p>{item.count} 个文件 · {item.reason}</p></div></div>)}
          {plan.warnings.map(warning => <p className="muted" key={warning}>{warning}</p>)}
          <h4>对方需要做的事</h4>
          <ul className="share-list">{plan.receiver.map(item => <li key={item}>{item}</li>)}</ul>
        </details>
      </> : null}
    </Drawer>
  );
}

function BlockerView({ blocker, busy, classify, acknowledge, recheck }: { blocker: Blocker; busy: string; classify: (group: Group, rights: "transferable" | "not_transferable" | "exclude") => void;
  acknowledge: (path: string) => void; recheck: () => void }) {
  const action = blockerAction(blocker.code);
  const groups = blocker.groups ?? [];
  return (
    <div className="share-block">
      <div className="banner bad">{blocker.text}</div>
      {action === "classify" || action === "rights" ? <>
        {groups.slice(0, 8).map(group => <div className="row" key={group.path}>
          <div><b className="share-path">{group.path}</b><p>{group.count} 个文件 · {bytesText(group.bytes)}</p></div>
          <button disabled={Boolean(busy)} onClick={() => classify(group, "transferable")}>可以转交</button>
          <button disabled={Boolean(busy)} onClick={() => classify(group, "not_transferable")}>不能转交</button>
          {action === "classify" ? <button disabled={Boolean(busy)} onClick={() => classify(group, "exclude")}>不分享</button> : null}
        </div>)}
        {groups.length > 8 ? <small className="reason">另有 {groups.length - 8} 组，处理后会重新检查</small> : null}
      </> : null}
      {action === "acknowledge" ? (blocker.paths ?? []).map(path => <div className="row" key={path}>
        <div><b className="share-path">{path}</b><p>请打开看一下，确认里面的路径或账号信息可以交给对方</p></div>
        <button disabled={Boolean(busy)} onClick={() => acknowledge(path)}>已检查，可以分享</button>
      </div>) : null}
      {action === "recheck" ? <>
        {blocker.paths?.length ? <ul className="share-list">{blocker.paths.slice(0, 10).map(path => <li key={path} className="share-path">{path}</li>)}</ul> : null}
        <div className="actions"><button disabled={Boolean(busy)} onClick={recheck}>处理好了，重新检查</button></div>
      </> : null}
    </div>
  );
}

/** What a restore brought back and what is left to do, on the project page and after a restore. */
export function ReconciliationView({ report, projectId, changed }: { report: Reconciliation; projectId: string; changed: () => void }) {
  const { busy, run } = useAction();
  const waiting = report.pending.filter(item => !item.bound);
  const vpm = report.next.some(item => item.includes("VPM"));
  const complete = () => run("complete", async () => {
    const result = await call<{ results: Array<{ bound: boolean; text: string }> }>("project.restore.complete", { projectId });
    changed();
    const left = result.results.filter(item => !item.bound);
    if (left.length) throw new Error(left.map(item => item.text).join("；"));
  }, "恢复已完成：制作流程可以继续");
  const resolve = () => run("vpm", async () => { await call("project.vpm.apply", { projectId, action: "resolve" }, 600_000); changed(); }, "已解析 VPM 依赖");
  const quiet = !waiting.length && !report.recovery.length && !report.stale.length && !report.missing.length;
  const body = <>
    {report.next.length ? <ul className="share-list">{report.next.map(item => <li key={item}>{item}</li>)}</ul> : null}
    {waiting.map(item => <div className="row" key={item.workflowId}><div><b>制作流程在等能力包</b><p>{item.text}</p></div>
      <button disabled={Boolean(busy)} onClick={complete}>{busy === "complete" ? "正在检查…" : "安装好了，完成恢复"}</button></div>)}
    {report.recovery.map(item => <div className="row" key={item.taskId}><div><b>{stageLabel(item.stage)}</b><p>{item.text}</p></div></div>)}
    {report.stale.length ? <div className="row"><div><b>{report.stale.length} 项结论的依据已变化</b><p>{report.stale.slice(0, 3).map(item => item.text).join("；")}</p></div></div> : null}
    {report.missing.length ? <><h4>本机还缺</h4><ul className="share-list">{report.missing.map(item => <li key={item}>{item}</li>)}</ul></> : null}
    {vpm ? <div className="actions"><button disabled={Boolean(busy)} onClick={resolve}>{busy === "vpm" ? "正在解析…" : "解析 VPM 依赖"}</button></div> : null}
    <details className="technical-details">
      <summary>恢复了什么（事实 {report.restored.facts ?? 0} 条 · 制作流程 {report.restored.workflows ?? 0} 个 · 任务 {report.restored.tasks ?? 0} 个）</summary>
      <Field label="来源" value={`${report.source.name} · 修订 ${report.source.revision} · Harness ${report.source.harness}`} />
      <Field label="恢复方式" value={report.decision.text} />
      <Field label="检查结论 / 决定" value={`${report.restored.verdicts ?? 0} / ${report.restored.decisions ?? 0}`} />
      {report.continuable.length ? <Field label="可以继续的阶段" value={report.continuable.map(stageLabel).join("、")} /> : null}
      {[...report.pathChanges, ...report.candidates, ...report.warnings].map(item => <p className="muted" key={item}>{item}</p>)}
    </details>
  </>;
  return (
    <div className="share-block">
      <div className="share-head"><Status state={shareLevel(report.level)} /><b>从分享包恢复</b><small className="muted">{report.decision.text}</small></div>
      {quiet ? <details><summary className="muted">恢复对账：没有待处理的问题</summary>{body}</details> : body}
    </div>
  );
}

/** Restore a share package: check it (nothing written), then restore, then show what came back. */
export function RestoreDrawer({ close, restored }: { close: () => void; restored: (projectId: string) => void }) {
  const job = useArchiveJob();
  const [path, setPath] = useState("");
  const [network, setNetwork] = useState(false);
  const [asCopy, setAsCopy] = useState(false);
  const [check, setCheck] = useState<RestoreCheck | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [error, setError] = useState("");
  const inspect = async (allowNetwork = network, copy = asCopy) => {
    setError(""); setCheck(null);
    try { setCheck(await job.start<RestoreCheck>("project.restore.check", { path: path.trim(), allowNetwork, ...(copy ? { asCopy: true } : {}) })); }
    catch (reason) { setError(errorText(reason)); }
  };
  const restore = async () => {
    setError("");
    try {
      const done = await job.start<RestoreResult>("project.restore", { path: path.trim(), allowNetwork: network, ...(asCopy ? { asCopy: true } : {}),
        ...(check?.decision ? { expect: check.decision.kind } : {}) });
      setResult(done); setCheck(done.check);
      if (done.status !== "restored") setError(done.status === "unchanged" ? "本机已有这个版本，没有恢复" : "没有恢复：先处理上面列出的问题");
    } catch (reason) { setError(errorText(reason)); }
  };
  const missingPack = check?.packs.some(pack => pack.resolution === "missing") && !network;
  // The same package again: nothing to restore, unless the person wants a copy beside the project.
  const already = check?.decision?.action === "none" && !check.problems.length;
  return (
    <Drawer title="从分享包恢复" onClose={close} footer={<>
      <small className="reason">{job.running ? jobText(job.progress) : result?.status === "restored" ? "已恢复"
        : check ? (check.ok ? check.decision?.text ?? "" : already ? "本机已有这个版本：不需要恢复" : "检查没有通过") : "先检查分享包：检查不会写入任何东西"}</small>
      <button onClick={close}>{result?.status === "restored" ? "关闭" : "取消"}</button>
      {result?.status === "restored" ? <button className="primary" onClick={() => restored(result.projectId!)}>打开项目</button>
        : check?.ok ? <button className="primary" disabled={Boolean(job.running)} onClick={restore}>{job.running === "project.restore" ? "正在恢复…" : asCopy ? "恢复为并列副本" : "恢复"}</button>
          : already ? <button disabled={Boolean(job.running)} onClick={() => { setAsCopy(true); void inspect(network, true); }}>另存为并列副本…</button>
            : <button className="primary" disabled={!path.trim() || Boolean(job.running)} onClick={() => inspect()}>{job.running ? "正在检查…" : "检查"}</button>}
    </>}>
      <label className="stack">分享包<input autoFocus value={path} onChange={event => { setPath(event.target.value); setCheck(null); setResult(null); setAsCopy(false); }}
        placeholder="分享包 .7z 的绝对路径" disabled={Boolean(job.running) || result?.status === "restored"} /></label>
      {error ? <div className="banner bad">{error}</div> : null}
      {job.running ? <JobProgress progress={job.progress} /> : null}
      {check && !result?.reconciliation ? <>
        {check.manifest ? <div className="share-head"><Status state={shareLevel(check.manifest.level)} /><b>{check.manifest.name}</b>
          <small className="muted">{check.manifest.purpose === 'self' ? '本人迁移/备份 · 不得转交' : '交给他人'} · 修订 {check.manifest.revision} · {check.manifest.files} 个文件 · {bytesText(check.manifest.bytes)}</small></div> : null}
        {check.manifest?.levelReasons.length ? <ul className="share-list">{check.manifest.levelReasons.map(item => <li key={item}>{item}</li>)}</ul> : null}
        {check.decision ? <div className="share-block"><div className="share-head"><Status state={restoreDecision(check.decision.kind)} /></div>
          <p className="muted">{check.decision.text}</p>{check.decision.target ? <span className="share-path">{check.decision.target}</span> : null}</div> : null}
        {check.problems.length ? <div className="share-block"><div className="banner bad">这个分享包不能恢复</div>
          <ul className="share-list">{check.problems.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
        {check.warnings.filter(item => item !== check.decision?.text).map(item => <div className="banner warn" key={item}>{item}</div>)}
        {check.packs.length || check.projectPacks.length ? <div className="share-block"><h4>能力包</h4>
          {check.packs.filter(pack => pack.current || pack.resolution !== "history").map(pack => <p className="muted" key={pack.workflowId}>{pack.text}</p>)}
          {check.projectPacks.map(pack => <p className="muted" key={pack.id}>{pack.text}</p>)}
          {missingPack ? <div className="actions"><button disabled={Boolean(job.running)} onClick={() => { setNetwork(true); void inspect(true); }}>从 Harness 服务器查找能力包</button></div> : null}
        </div> : null}
        {check.missing.length && !already ? <div className="share-block"><div className="banner warn">恢复后本机还缺</div>
          <ul className="share-list">{check.missing.map(item => <li key={item}>{item}</li>)}</ul></div> : null}
        {check.manifest?.optional.length ? <details className="technical-details"><summary>分享包附带的可选内容</summary>
          {check.manifest.optional.map(item => <p className="muted" key={item.id}>{item.included ? "已附带" : "未附带"}：{item.text}</p>)}</details> : null}
      </> : null}
      {result?.reconciliation && result.projectId ? <ReconciliationView report={result.reconciliation} projectId={result.projectId} changed={() => undefined} /> : null}
    </Drawer>
  );
}
