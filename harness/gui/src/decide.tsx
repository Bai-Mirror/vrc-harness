import React, { useEffect, useState } from "react";
import { call, type Gate } from "./api";
import { artifactLabel, FOUR_STATE_LABEL, gateHint, gateState, gateText, shortHash } from "./labels";
import { planDetails, planSummary, type NextView } from "./model";
import { Status, useAction } from "./ui";
import { FacePreviewView } from './face-preview';
import { RecolorPreviewView } from './stage-photos';

/** Resume the scheduler from wherever the person noticed it is not running. */
export function useResume(changed: () => void) {
  const { busy, run } = useAction();
  return { resuming: busy === "resume", resume: () => run("resume", async () => { await call("service.resume"); changed(); }, "后台已继续运行") };
}

/**
 * The top of a page: what to do now, in one sentence, with at most one primary button. The state line names which of the
 * four questions this page answers (做了什么／在做什么／准备做什么／需要我做什么, 决定记录 D-41); it is derived from the
 * same reading the terminal uses (src/shared/projection.ts), so both front ends describe one workflow the same way.
 */
export function NextBar({ view, onAction, onResume, busy }: {
  view: NextView; onAction?: (kind: "first" | "resume") => void; onResume?: () => void; busy?: boolean;
}) {
  return (
    <div className={`next ${view.tone}`}>
      <div className="next-copy">
        <span className={`next-state ${view.state}`}>{FOUR_STATE_LABEL[view.state]}</span>
        <h2>{view.title}</h2>
        {view.text ? <p>{view.text}</p> : null}
      </div>
      {view.action || view.resume ? (
        <div className="next-actions">
          {view.resume && onResume ? <button disabled={busy} onClick={onResume}>继续运行</button> : null}
          {view.action && onAction ? (
            <button className="primary" disabled={busy && view.action.kind === "resume"} onClick={() => onAction(view.action!.kind)}>
              {busy && view.action.kind === "resume" ? "正在启动…" : view.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One decision, where the person reads it: what is asked, what the approval covers, and three ways forward. The
 * approval carries the hash of the version shown, so a version that changed meanwhile is refused, not approved.
 */
export function GateCard({ gate, showProject, onRequestChange, onDismiss, changed, refresh=0 }: {
  gate: Gate; showProject?: boolean; onRequestChange: (gate: Gate) => void; onDismiss: (gate: Gate) => void; changed: () => void;refresh?:number;
}) {
  const text = gateText(gate);
  const [plan, setPlan] = useState<Array<[string, string]>>([]);
  const [details, setDetails] = useState<Array<[string, string]>>([]);
  const { busy, run } = useAction();
  useEffect(() => {
    let live = true;
    if (gate.formal === false) return;
    call<{ current: unknown }>("plan.show", { workflowId: gate.workflowId })
      .then((result) => { if (live) { setPlan(planSummary(result.current)); setDetails(planDetails(result.current)); } })
      .catch(() => { if (live) { setPlan([]); setDetails([]); } });
    return () => { live = false; };
  }, [gate.workflowId, gate.artifactHash, gate.formal]);
  const approve = () => run("approve", async () => {
    if (!gate.artifactHash) throw new Error(`${artifactLabel(gate.binds)}还不存在，暂时不能决定`);
    await call("gate.decide", { gate: gate.gate, approve: true, note: "经 GUI 批准当前版本", expectedHash: gate.artifactHash, expectedInputs: gate.inputHashes }, 300_000);
    changed();
  }, text.approve ? "已批准，后台会继续推进" : "已记录为完成");
  const approveLabel = !text.approve ? "我已完成" : gate.binds === "plan" ? "批准此方案" : "批准当前版本";
  const hint = gateHint(gate.binds);
  const faceChoice=gate.selection==='face-candidate';
  const faceReview=gate.review==='face-output';
  const recolorReview=gate.preview==='recolor-candidates';
  return (
    <article className="gate-card" id={`gate-${gate.gate}`} tabIndex={-1}>
      <div className="gate-head">
        <span className="eyebrow">需要你决定{showProject ? ` · ${gate.projectName}` : ""}</span>
        <Status state={gateState(gate.status)} />
      </div>
      <h3>{text.title}</h3>
      <p className="gate-question">{text.question}{hint !== gate.binds ? ` ${hint}` : ""}</p>
      {plan.length ? (
        gate.binds === "plan" ? <PlanRows rows={plan} /> : (
          <details className="gate-plan-more"><summary>依据的制作方案</summary><PlanRows rows={plan} /></details>
        )
      ) : null}
      {details.length ? <details className="gate-plan-more"><summary>方案文件与完整说明</summary><PlanRows rows={details} /></details> : null}
      <p className="reason">
        {gate.artifactHash
          ? `这个决定绑定当前的${artifactLabel(gate.binds)}（版本 ${shortHash(gate.artifactHash)}）；之后它再变化，决定会失效，需要重新看。`
          : `${artifactLabel(gate.binds)}还不存在，暂时不能决定。`}
      </p>
      {faceChoice ? gate.projectId ? <FacePreviewView key={`${gate.workflowId}:${gate.artifactHash}`} projectId={gate.projectId}
        workflowId={gate.workflowId} refresh={refresh} candidateMode choose={gate.artifactHash?{expectedHash:gate.artifactHash,expectedInputs:gate.inputHashes,changed}:undefined} />
        : <p className="banner warn">尚不能读取这个项目的实际候选，请让 Harness 重新核对制作记录。</p> : null}
      {faceReview ? gate.projectId ? <FacePreviewView key={`${gate.workflowId}:${gate.artifactHash}`} projectId={gate.projectId}
        workflowId={gate.workflowId} refresh={refresh} accept={gate.artifactHash?{expectedHash:gate.artifactHash,expectedInputs:gate.inputHashes,expectedRevision:gate.expectedFaceRevision,changed}:undefined} />
        : <p className="banner warn">尚不能读取这个项目的实际效果，请让 Harness 重新核对制作记录。</p> : null}
      {/* The decision carries the condensed evidence only (F27b): the chosen tier per outfit, its source and time, and a
          pointer at the full grid. The whole grid is drawn by the scene preview card beside this one, and repeating it
          here pushed the approval below the docked change-request box. */}
      {recolorReview ? gate.projectId && gate.artifactHash ? <RecolorPreviewView key={`${gate.workflowId}:${gate.artifactHash}`}
        projectId={gate.projectId} workflowId={gate.workflowId} refresh={refresh} expectedHash={gate.artifactHash} compact
        approve={{gate:gate.gate,label:approveLabel,success:text.approve?"已批准，后台会继续推进":"已记录为完成",
          expectedHash:gate.artifactHash,expectedInputs:gate.inputHashes,changed}} />
        : <p className="banner warn">这个配色版本还没有产物，暂时不能决定；先让 Harness 完成配色阶段。</p> : null}
      <div className="actions">
        {!faceChoice && !faceReview && !recolorReview ? <button className="primary" disabled={!gate.artifactHash || busy === "approve"} onClick={approve}>
          {busy === "approve" ? "正在提交…" : approveLabel}
        </button> : null}
        <button onClick={() => onRequestChange(gate)}>修改要求</button>
        <button className="link" onClick={() => onDismiss(gate)}>暂不执行</button>
      </div>
    </article>
  );
}
function PlanRows({ rows }: { rows: Array<[string, string]> }) {
  return <dl className="gate-plan">{rows.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>;
}
