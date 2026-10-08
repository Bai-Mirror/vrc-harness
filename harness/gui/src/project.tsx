import React, { useEffect, useState } from "react";
import {
  call,
  type Asset,
  type AvatarRoot,
  type Gate,
  type Project,
  type ProjectBrief,
  type ProjectMessage,
  type ProjectVariant,
  type Task,
  type Workflow,
} from "./api";
import { ProjectArchive } from "./archive";
import { DiagnosticsPanel } from "./diagnostics";
import { useArchiveJob } from "./share";
import { PreviewStrip, ScenePreview } from "./stage-photos";
import { ManualFaceView } from "./face-manual";
import { TechnicalReview } from './technical-review';
import { MaterialSources } from "./material-sources";
import { LocalMaintenance } from "./local-maintenance";
import { GateCard, NextBar, useResume } from "./decide";
import {
  artifactLabel, assetKind, assetRole, assetState, authoringState, briefState, checkLabel, checkResultWord, contextChange, messageState, observerLabel, profileTitle,
  recoveryState, rootRole, severityLabel, shortHash, sourceKind, stageLabel, stageState, takeoverMode, trialState, variantState,
  verdictNext, verdictState, when, workflowState, reasonsText,
} from "./labels";
import {
  attentionChecks, cardMeta, cardProgress, errorText, focusConversationNeed, focusTaskConversation, isOpenGate, placeholder, placeholderColors, productionLabel, productionState, progressCheckCounts, progressEvidenceText, progressStageSummary, progressSummaryLines, projectNext,
  projectState, projectTaskRows, stageView, startReadiness, startWarnings, taskNeedAction, variantSummary, verdictCounts, verdictTally, workbenchNeeds,
  type ProductionLike,
} from "./model";
import {
  Drawer, Empty, Field, MenuButton, Modal, Panel, Shell, Status, TopBar, useAction, useFeedback, useLoad, useSessionState,
  type Pane,
} from "./ui";

export type ProjectTab = "scene" | "design" | "materials" | "requests" | "monitor";
/** Decisions the person put off this session, and the way from a decision to a change request. */
export type Decisions = { dismissed: string[]; dismiss: (gate: Gate) => void; restore: () => void; requestChange: (gate: Gate) => void };
type WorkTab = Exclude<ProjectTab, "requests">;
const WORK_TABS: Array<[WorkTab, string]> = [["scene", "场景"], ["design", "设计目标"], ["materials", "素材"], ["monitor", "制作进度"]];

/**
 * A project in the Codex-like frame (design 26 §4.1): the conversation and the decisions in the main column, the work
 * surface (design goal, materials, production progress) in the panel beside it. A narrow window switches between them.
 * `initialTab` "requests" lands on the conversation; any other tab opens that part of the work surface.
 */
export function ProjectWorkspace({ project, initialTab, draft, gates, scheduler, decisions, nav, onBack, refresh, changed, connectionError }: {
  project: Project; initialTab?: ProjectTab; draft?: string; gates: Gate[]; scheduler?: string; decisions: Decisions;
  /** The window's navigation, which stays beside every project. */
  nav: React.ReactNode; onBack: () => void; refresh: number; changed: () => void;
  connectionError?: string;
}) {
  const asked = initialTab && initialTab !== "requests" ? initialTab : undefined;
  const [remembered, setWork] = useSessionState<WorkTab>(`work:${project.id}`, "scene");
  const [chosen, setChosen] = useState<WorkTab | undefined>(asked);
  const work = chosen ?? remembered;
  const showWork = (tab: WorkTab) => { setChosen(tab); setWork(tab); };
  // A tab's content stays mounted once opened, so an unsaved form survives switching tabs.
  const [opened, setOpened] = useState<WorkTab[]>([work]);
  useEffect(() => { if (!opened.includes(work)) setOpened([...opened, work]); }, [work]);
  const [pane, setPane] = useState<Pane>(asked ? "panel" : "main");
  const [starting, setStarting] = useState(false);
  const [candidates] = useLoad<Array<{ id: string; version: string; status: string; reason: string }>>("managed.candidate.list", refresh, []);
  const [trials] = useLoad<Array<{ id: string; candidateId: string; status: string; contentHash: string }>>(
    "managed.candidate.trial.list", refresh, [], { projectId: project.id });
  const [view, error] = useLoad<Workflow | null>(project.workflow ? "workflow.show" : "", refresh, null,
    project.workflow ? { id: project.workflow.id } : {});
  const workflow = project.workflow ? view : null;
  const [productions] = useLoad<ProductionProposal[]>("project.production.list",refresh,[],{projectId:project.id});
  const production=productions.find(p=>p.workflowId===project.workflow?.id);
  const [taskRows] = useLoad<Task[]>("task.list", refresh, []);
  // Continuation keeps the logical project path but moves work to its current successor workflow.
  const tasks = projectTaskRows(taskRows, project.path, project.workflow?.id);
  const feedback = useFeedback();
  const { run } = useAction();
  const copyContext = () => run("context", async () => {
    const result = await call<{ path: string; compact: string }>("project.context", { projectId: project.id });
    await navigator.clipboard.writeText(result.compact);
    feedback.ok(`已刷新项目状态文件并复制任务摘要\n${result.path}`);
  });
  const copyPath = () => run("path", () => navigator.clipboard.writeText(project.path), "工程路径已复制");
  /**
   * Cancelling the whole production flow, which the Runtime offers as `workflow.cancel` and which had no entry here:
   * the person could start a Workflow from this page but only the terminal could cancel one. Its words are the
   * Runtime's own terms — unfinished Tasks are cancelled and confirmed stopped first, finished evidence is kept, and
   * it cannot be resumed (src/cli.ts `workflow cancel`).
   */
  const cancelWorkflow = () => run("workflow-cancel", async () => {
    if (!project.workflow) return;
    const confirmed = await feedback.confirm({ title: "取消整个制作流程？",
      body: "所有未完成的任务会先被取消并确认停止；已完成的证据保留。取消后不能恢复，只能重新开始一个制作流程。",
      confirm: "取消制作流程", danger: true });
    if (!confirmed) return;
    const note = await feedback.ask({ title: "取消原因", label: "原因（会记入事件，便于之后回顾）", confirm: "取消制作流程", required: true });
    if (note === undefined) return;
    await call("workflow.cancel", { id: project.workflow.id, note }, 600_000);
    feedback.ok("已取消制作流程；已完成的成果与证据保留");
    changed();
  });
  const openGates = gates.filter(isOpenGate).length;
  const panel = (
    <>
      <div className="work-head">
        <div className="segmented" role="tablist" aria-label="工作面">
          {WORK_TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={work === id} className={work === id ? "active" : ""} onClick={() => showWork(id)}>
              {label}{id === "monitor" && openGates ? <em aria-label={`${openGates} 项待决定`}>{openGates}</em> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="work-body">
        {error ? <div className="banner bad">{error}</div> : null}
        {work !== "scene" ? <PreviewStrip project={project} workflow={workflow} gates={gates} refresh={refresh} onOpen={() => {
            showWork("scene"); window.requestAnimationFrame(() => document.getElementById("scene-preview")?.scrollIntoView({ behavior: "smooth", block: "start" }));
          }} /> : null}
        {work === "scene" ? <div className="work-page"><ScenePreview project={project} workflow={workflow} gates={gates} refresh={refresh} /></div> : null}
        {opened.includes("design") ? <div className="work-page" hidden={work !== "design"}>
          <ManualFaceView projectId={project.id} refresh={refresh} changed={changed} />
          <ProjectDesign projectId={project.id} refresh={refresh} changed={changed} />
          <LocalMaintenance projectId={project.id} refresh={refresh} changed={changed} /></div> : null}
        {opened.includes("materials") ? <div className="work-page" hidden={work !== "materials"}>
          <ProjectMaterials projectId={project.id} refresh={refresh} changed={changed} /></div> : null}
        {opened.includes("monitor") ? <div className="work-page" hidden={work !== "monitor"}>
          <Monitor project={project} workflow={workflow} gates={gates} candidates={candidates} trials={trials} tasks={tasks} scheduler={scheduler} refresh={refresh} changed={changed}
            onTaskConversation={(task) => {
              focusTaskConversation(task.id, setPane, (id) => window.requestAnimationFrame(() => {
                const target = document.getElementById(id);
                target?.scrollIntoView({ behavior: "smooth", block: "center" });
                (target as HTMLElement | null)?.focus({ preventScroll: true });
              }));
            }}
            onConversation={(need) => {
              focusConversationNeed(need, decisions.restore, (id) => {
                setPane("main");
                window.requestAnimationFrame(() => {
                const target = document.getElementById(id);
                if (!target) return;
                target.scrollIntoView({ behavior: "smooth", block: "center" });
                (target as HTMLElement).focus({ preventScroll: true });
                });
              });
            }} /></div> : null}
      </div>
    </>
  );
  return (
    <Shell nav={nav} panel={panel} pane={pane} onPane={setPane}>
      <TopBar actions={<>
        <Status state={production?.progress ? productionState(production) : project.workflow ? workflowState(project.workflow.status) : ["尚未制作", "muted"]} />
        <MenuButton label={`${project.name} 的更多操作`} items={[
          { label: "复制工程路径", onSelect: () => void copyPath() },
          { label: "刷新状态并复制任务摘要", onSelect: () => void copyContext() },
          { label: "打开 Unity", hint: "由制作任务按隔离规则启动，避免误改正在制作的工程" },
          ...(project.workflow && !["cancelled", "client_verified"].includes(project.workflow.status)
            ? [{ label: "取消整个制作流程…", onSelect: () => void cancelWorkflow() }] : []),
        ]} />
      </>}>
        <nav className="crumbs" aria-label="位置">
          <button className="link" onClick={onBack}>项目</button><span className="sep" aria-hidden="true">/</span><b title={project.name}>{project.name}</b>
        </nav>
      </TopBar>
      <Chat projectId={project.id} draft={draft} refresh={refresh} changed={changed}>
        {connectionError ? <div className="banner warn" role="status">后台暂时未连接，下面是上次读取的进度。连接恢复后请刷新页面核对当前结果。<details><summary>连接诊断</summary>{connectionError}</details></div> : null}
        <Conversation project={project} production={production} gates={gates} scheduler={scheduler} decisions={decisions} refresh={refresh} changed={changed}
          onStart={() => setStarting(true)} showWork={(tab) => { showWork(tab); setPane("panel"); }} />
      </Chat>
      {starting ? <StartDialog project={project} candidates={candidates} trials={trials} close={() => setStarting(false)}
        started={() => { setStarting(false); changed(); showWork("monitor"); }} /> : null}
    </Shell>
  );
}

/**
 * The top of the conversation (L0, design 26 §5): what the avatar is, where it stands, what to do next (starting it, or the
 * Runtime's next step), and every decision waiting for the person. None of it folds away.
 */
function Conversation({ project, production, gates, scheduler, decisions, refresh, changed, onStart, showWork }: {
  project: Project; production?:ProductionProposal; gates: Gate[]; scheduler?: string; decisions: Decisions; refresh: number; changed: () => void;
  onStart: () => void; showWork: (tab: WorkTab) => void;
}) {
  const [brief] = useLoad<ProjectBrief | null>("project.brief.get", refresh, null, { projectId: project.id });
  const open = gates.filter(isOpenGate);
  const shown = open.filter((gate) => !decisions.dismissed.includes(gate.gate));
  const { resuming, resume } = useResume(changed);
  const next = projectNext({ next: project.workflow?.next, hasWorkflow: Boolean(project.workflow), status: project.workflow?.status,
    openGates: open.length, scheduler });
  const cover = placeholder(project.name);
  const progress = cardProgress(project);
  const request = brief?.customerRequest.trim();
  return (
    <>
      <div className="project-head">
        <span className="cover project-mark" style={placeholderColors(cover.hue) as React.CSSProperties} aria-hidden="true">{cover.text}</span>
        <div>
          <span className="eyebrow">头像项目{project.lastImport?.base ? ` · ${project.lastImport.base}` : ""}</span>
          <h1>{project.name}</h1>
          {request ? <p title={request}>{request}</p>
            : <p>还没有写下头像需求。<button className="link" onClick={() => showWork("design")}>在「设计目标」里补充</button></p>}
          <div className="project-facts">
            <Status state={projectState(project, gates)} />
            {progress === null ? null : <>
              <span className="progress" role="img" aria-label={`已通过 ${Math.round(progress * 100)}% 的阶段`}><i style={{ width: `${progress * 100}%` }} /></span>
              <span>已通过 {Math.round(progress * 100)}% 的阶段</span>
            </>}
            <span>{cardMeta(project)}</span>
          </div>
        </div>
      </div>
      {production?.progress && (production.progress.connectionRetrying || ['interrupted','recovery_required','stopping','resuming'].includes(production.progress.state)) ?
        <div className="next"><div className="next-copy"><h2>{productionLabel(production)}</h2><p>{production.progress.reason}</p>
          {production.progress.canResume?<p>在下方制作提案中核对并继续，或取消这次制作。无需重新输入原要求。</p>:null}
          {production.progress.state==='resuming' && scheduler!=='running'?<p>后台当前未运行，继续请求已保存；恢复后台后才会接续制作。</p>:null}
        </div></div> : project.workflow ? <NextBar view={next} busy={resuming} onResume={resume} onAction={() => resume()} />
        : <>
          <div className="next accent"><div className="next-copy">
            <h2>先与 AI 确认制作方案</h2>
            <p>在下方说明目标、查看处理进展或回答问题。方案准备好后会显示制作提案，由你确认后继续。</p>
          </div></div>
          <details><summary>高级：手动配置制作流程</summary>
            <p className="muted">此入口使用你已整理的目标和素材；普通制作请先通过项目对话形成方案。</p>
            <StartCheck projectId={project.id} request={brief?.customerRequest ?? ""} refresh={refresh} onStart={onStart} showWork={showWork} />
          </details>
        </>}
      {shown.length || open.length > shown.length ? (
        <section className="stack-list" aria-label="需要你决定的事">
          {shown.map((gate) => (
            <GateCard key={gate.gate} gate={gate} changed={changed} refresh={refresh} onRequestChange={decisions.requestChange} onDismiss={decisions.dismiss} />
          ))}
          {open.length > shown.length ? <button className="link" onClick={decisions.restore}>显示已暂缓的 {open.length - shown.length} 项决定</button> : null}
        </section>
      ) : null}
    </>
  );
}

/** Before production starts: what it needs, as a checklist whose items open the part of the work surface they concern. */
function StartCheck({ projectId, request, refresh, onStart, showWork }: {
  projectId: string; request: string; refresh: number; onStart: () => void; showWork: (tab: WorkTab) => void;
}) {
  const [projectAssets] = useLoad<Asset[]>("project.asset.list", refresh, [], { projectId });
  const [variants] = useLoad<ProjectVariant[]>("project.variant.list", refresh, [], { projectId });
  const readiness = startReadiness({ request, assets: projectAssets.filter(asset => asset.attached).length, variants: variants.length });
  return (
    <div className="next accent start-check">
      <div className="next-copy">
        <h2>下一步：开始制作流程</h2>
        <ul className="checklist">
          {readiness.items.map(item => <li key={item.label} className={item.done ? "done" : item.required ? "todo" : "optional"}>
            <span aria-hidden="true">{item.done ? "✓" : item.required ? "!" : "·"}</span>
            <button className="link" onClick={() => showWork(item.tab)}>{item.label}</button><small>{item.hint}</small></li>)}
        </ul>
      </div>
      <div className="next-actions">
        {readiness.blocker ? <small className="reason">{readiness.blocker}</small> : null}
        <button className="primary" disabled={Boolean(readiness.blocker)} onClick={onStart}>开始制作流程</button>
      </div>
    </div>
  );
}

type Dependency = { id: string; name: string; required: boolean; ok: boolean; detail: string };
/** Starting production, confirmed: which flow, what it will use, what is missing; the capability version is advanced. */
function StartDialog({ project, candidates, trials, close, started }: {
  project: Project; candidates: Array<{ id: string; version: string }>; trials: Array<{ id: string; candidateId: string; status: string }>;
  close: () => void; started: () => void;
}) {
  const [config] = useLoad<{ defaultProfile: string }>("config.view", 0, { defaultProfile: "" });
  const [assets] = useLoad<Asset[]>("project.asset.list", 0, [], { projectId: project.id });
  const [variants] = useLoad<ProjectVariant[]>("project.variant.list", 0, [], { projectId: project.id });
  const [environment, environmentError] = useLoad<{ dependencies: Dependency[] } | null>("setup.environment", 0, null);
  const [candidateId, setCandidateId] = useState("");
  const { busy, run } = useAction();
  const approved = trials.filter(trial => trial.status === "approved");
  const warnings = environment ? startWarnings(environment.dependencies) : [];
  const start = () => run("start", async () => {
    if (!config.defaultProfile) throw new Error("还没有读到默认制作流程，请稍后再试");
    await call("workflow.create", { project: project.path, projectId: project.id, profile: config.defaultProfile,
      ...(candidateId ? { candidateId } : {}) }, 120_000);
    started();
  }, "制作流程已开始");
  const attached = assets.filter(asset => asset.attached).length;
  return (
    <Modal title="开始制作流程？" onClose={close} actions={<>
      <button onClick={close}>取消</button>
      <button className="primary" disabled={busy === "start" || !config.defaultProfile} onClick={start}>{busy === "start" ? "正在建立…" : "开始制作"}</button>
    </>}>
      <div className="dialog-body">
        <p>后台会按下面的流程准备方案、施工和检查；需要审美判断时会停下来请你决定。</p>
        <dl>
          <dt>制作流程</dt><dd>{config.defaultProfile ? profileTitle(config.defaultProfile) : "正在读取…"}</dd>
          <dt>素材</dt><dd>{attached ? `${attached} 项已关联到项目` : "还没有关联素材；从 BOOTH 按需获取的文件也会带上"}</dd>
          <dt>衣装方案</dt><dd>{variants.length ? variants.map(variant => variant.name).join("、") : "未单独建立（按一套造型制作）"}</dd>
          <dt>本机环境</dt><dd>{environmentError ? `没能检查：${environmentError}` : !environment ? "正在检查…" : warnings.length ? "有缺项，见下方" : "齐全"}</dd>
        </dl>
        {warnings.map(warning => <div className="banner warn" key={warning}>{warning}</div>)}
        <details className="dialog-advanced">
          <summary>高级</summary>
          <label className="stack">本次能力版本<select value={candidateId} onChange={e => setCandidateId(e.target.value)}>
            <option value="">当前正式版本</option>
            {approved.map(trial => <option key={trial.id} value={trial.candidateId}>
              本地试用 · {candidates.find(candidate => candidate.id === trial.candidateId)?.version ?? trial.candidateId}
            </option>)}
          </select></label>
          <small className="reason">{approved.length ? "只有在「运行监视 → 高级」里批准过的本项目试用才会出现在这里。" : "没有批准过的本项目试用，会使用当前正式版本。"}</small>
        </details>
      </div>
    </Modal>
  );
}

/**
 * Progress in the work panel, in the order a person needs it: where production stands, the evidence; imports and hand-over
 * only when they apply; the production model's internals folded away. What to do now and the decisions are in the
 * conversation beside it.
 */
function Monitor({ project, workflow, gates, candidates, trials, tasks, scheduler, refresh, changed, onConversation, onTaskConversation }: {
  project: Project; workflow: Workflow | null; gates: Gate[];
  candidates: Array<{ id: string; version: string; status: string; reason: string }>;
  trials: Array<{ id: string; candidateId: string; status: string }>; tasks: Task[]; scheduler?: string; refresh: number; changed: () => void;
  onConversation: (need: ReturnType<typeof workbenchNeeds>[number]) => void;
  onTaskConversation: (task: Task) => void;
}) {
  const [assets] = useLoad<Asset[]>("project.asset.list", refresh, [], { projectId: project.id });
  const [proposals] = useLoad<ProductionProposal[]>("project.production.list",refresh,[],{projectId:project.id});
  const diagnosticsJob = useArchiveJob();
  const production=proposals.find(p=>p.workflowId===workflow?.id);
  const interruption = production?.progress && ['interrupted','recovery_required'].includes(production.progress.state)
    ? [{ id: production.id, workflowId: production.workflowId, taskId: production.progress.taskId, state: production.progress.state, reason: production.progress.reason, canResume: production.progress.canResume }] : [];
  const warningRows = (workflow?.stages ?? []).flatMap(stage => stage.checks.filter(check => check.severity === 'warning' && check.acceptanceRequired
    && Boolean(check.verdict) && check.verdict?.current !== false && check.verdict?.accepted !== true)
    .map(check => ({ workflowId: workflow!.id, stageId: stage.id, checkId: check.id, text: `${checkLabel({ ...check, stageId: stage.id })}需要确认` })));
  const needs = workbenchNeeds({ proposals, gates, warnings: warningRows,
    tasks: tasks.map(task => ({ id: task.id, workflowId: task.workflowId, stage: task.stage, goal: task.goal, needsYou: task.needsYou, status: task.status,
      stageCodes: workflow?.stages.find(stage => stage.id === task.stage)?.codes })),
    interruptions: interruption });
  return (
    <>
      <ProgressL0 project={project} workflow={workflow} production={production} tasks={tasks} scheduler={scheduler} needs={needs} onConversation={onConversation} onTaskConversation={onTaskConversation} changed={changed} />
      <ProgressL1 workflow={workflow} changed={changed} />
      <details className="technical-details progress-l2" id="progress-l2">
        <summary>技术详情</summary>
        <div className="two monitor-main">
          <Panel title="项目状态">
            <Field label="制作流程">{production?.progress ? productionLabel(production) : project.workflow ? <Status state={workflowState(project.workflow.status)} /> : "尚未开始"}</Field>
            {production?.progress ? <ProductionRecovery projectId={project.id} proposal={production} changed={changed} /> : null}
            <Field label="制作方案" value={workflow?.plan.hash ? (workflow.plan.approved ? "已批准" : "等你批准") : "尚未生成"} />
            <Field label="素材" value={`${assets.filter((asset) => asset.attached).length} 项已关联`} />
            <Field label="检查" value={verdictTally(verdictCounts(workflow?.stages.flatMap((stage) => stage.checks) ?? []))} />
            {project.lastImport ? <Field label="导入核对" value={`${project.lastImport.unresolved} 项未收结 · ${project.lastImport.failedReviews} 项复核未通过`} /> : null}
          </Panel>
          {workflow ? <TechnicalReview project={project.path} workflowId={workflow.id} refresh={refresh} changed={changed}/> : null}
        </div>
        <details className="technical-details" id="progress-stage-details"><summary>阶段与完整检查记录</summary><StageList stages={workflow?.stages ?? []} /><Verify workflow={workflow} changed={changed} /></details>
        <RecoveryPanel projectId={project.id} refresh={refresh} changed={changed} />
        <DiagnosticsPanel projectId={project.id} job={diagnosticsJob} changed={changed} />
        <ProjectArchive projectId={project.id} refresh={refresh} changed={changed}
          productionActions={production?.progress ? <ProductionRecovery projectId={project.id} proposal={production} changed={changed} /> : null} />
        {project.workflow?.status === "upload_ready" ? <UploadPanel projectId={project.id} refresh={refresh} changed={changed} /> : null}
        <AvatarWorkspace workflow={workflow} />
        {workflow ? <ContextInspector workflowId={workflow.id} /> : null}
        <SelfImprovement projectId={project.id} refresh={refresh} />
        <CandidateTrials project={project} candidates={candidates} trials={trials} changed={changed} />
        <details className="technical-details"><summary>开发与诊断详情</summary><pre>{JSON.stringify({ project, workflow }, null, 2)}</pre></details>
      </details>
    </>
  );
}

function ProgressL0({ project, workflow, production, tasks, scheduler, needs, onConversation, onTaskConversation, changed }: {
  project: Project; workflow: Workflow | null; production?: ProductionProposal; tasks: Task[]; scheduler?: string; needs: ReturnType<typeof workbenchNeeds>;
  onConversation: (need: ReturnType<typeof workbenchNeeds>[number]) => void; onTaskConversation: (task: Task) => void; changed: () => void;
}) {
  const rows = needs;
  return <section className="progress-l0" aria-label="制作进度摘要">
    <Panel title="需要你处理">
      {rows.length ? rows.map(row => <div className="row progress-need" key={row.key}>
        <div><b>{row.title}</b><p>{row.detail}</p><small className="muted">来源：{row.source}</small></div>
        {row.action === 'conversation' ? <button onClick={() => onConversation(row)}>去对话处理</button>
          : row.action === 'recovery' && row.source === '制作中断待核对' && production ? <ProductionRecovery projectId={project.id} proposal={production} changed={changed} />
          : row.action === 'task' || row.action === 'recovery' ? <TaskAction task={tasks.find(task => task.id === row.target)} changed={changed} onConversation={onTaskConversation} />
          : <button onClick={() => document.getElementById(row.target ?? '')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>查看检查</button>}
      </div>) : <p className="muted">当前没有需要你处理的事项。</p>}
    </Panel>
    <Panel title="进度摘要">
      <div className="progress-lines">
        {progressSummaryLines({ stages: workflow?.stages ?? [], next: workflow?.next, scheduler, productionState: production?.progress?.state,
          tasks: tasks.map(task => ({ stage: task.stage, status: task.status, needsYou: task.needsYou })) }).map((line, index) => (
          <p key={index}><b>{['做了什么', '在做什么', '准备做什么'][index]}</b><span>{line}</span></p>
        ))}
      </div>
    </Panel>
  </section>;
}

function TaskAction({ task, changed, onConversation }: { task?: Task; changed: () => void; onConversation: (task: Task) => void }) {
  const feedback = useFeedback(); const { busy, run } = useAction();
  if (!task) return null;
  if (taskNeedAction(task) === 'recovery') return <button disabled={Boolean(busy)} onClick={async () => {
    const answer = await feedback.dialog({ title: '核对上次执行', body: <p>请先检查运行目录和工程，再选择如何恢复这项任务。</p>,
      actions: [{ key: 'reconciled', label: '已核对，进入检查', tone: 'primary' }, { key: 'no_side_effects', label: '无副作用，重新执行' }],
      input: { label: '核对说明', required: true, multiline: true } });
    if (answer) await run(`task:${task.id}`, async () => { await call('task.recover', { id: task.id, mode: answer.key, note: answer.value.trim() }); changed(); }, '已恢复');
  }}>恢复任务</button>;
  if (taskNeedAction(task) === 'conversation') return <button onClick={() => onConversation(task)}>去对话处理</button>;
  if (taskNeedAction(task) === 'redo') return <button disabled={Boolean(busy)} onClick={async () => {
    const note = await feedback.ask({ title: `重做「${stageLabel(task.stage)}」`, label: '修改意见（可空）', confirm: '重做', multiline: true });
    if (note !== undefined) await run(`task:${task.id}`, async () => { await call('task.redo', { id: task.id, ...(note ? { note } : {}) }); changed(); }, '已请求重做');
  }}>重做任务</button>;
  return <button onClick={() => {
    const l2 = document.getElementById('progress-l2') as HTMLDetailsElement | null;
    const details = document.getElementById('progress-stage-details') as HTMLDetailsElement | null;
    if (l2) l2.open = true;
    if (details) details.open = true;
    const target = document.getElementById(`technical-stage-${task.stage}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    (target as HTMLElement | null)?.focus({ preventScroll: true });
  }}>查看阶段</button>;
}

function ProgressL1({ workflow, changed }: { workflow: Workflow | null; changed: () => void }) {
  const summary = progressStageSummary(workflow?.stages ?? []);
  const attention = attentionChecks(workflow?.stages ?? []);
  const counts = progressCheckCounts(workflow?.stages ?? []);
  return <section className="progress-l1" aria-label="制作阶段与关注检查">
    <details open={Boolean(summary.current?.task?.status === 'WAITING_HUMAN' || summary.current?.display === 'deciding')}>
      <summary>制作阶段</summary>
      {summary.completed.length ? <p className="stage-summary">已完成：{summary.completed.map(stage => stageLabel(stage.id)).join('、')}</p> : <p className="muted">暂无已完成阶段</p>}
      {summary.current ? <div className="stage-row" id={`progress-stage-${summary.current.id}`}><b>当前 · {stageLabel(summary.current.id)}</b><Status state={stageView(summary.current).state} /></div> : null}
      {summary.next ? <div className="stage-row"><b>下一步 · {stageLabel(summary.next.id)}</b><Status state={stageView(summary.next).state} /></div> : null}
      {summary.remaining ? <p className="muted">其余阶段：{summary.remaining} 项</p> : null}
    </details>
    <details open={attention.length > 0}>
      <summary>需要关注的检查</summary>
      <p className="stage-summary">待取证 {counts.pending} · 不适用 {counts.notApplicable} · 已接受提醒 {counts.accepted}
        {counts.futurePending || counts.futureNotApplicable || counts.futureAccepted ? ` · 未来阶段：待取证 ${counts.futurePending}、不适用 ${counts.futureNotApplicable}、已接受提醒 ${counts.futureAccepted}` : ''}</p>
      {attention.length ? <ProgressAttention rows={attention} workflow={workflow} changed={changed} />
        : <p className="muted">{progressEvidenceText(counts)}</p>}
    </details>
  </section>;
}

function ProgressAttention({ rows, workflow, changed }: { rows: Array<{ stage: any; check: any }>; workflow: Workflow | null; changed: () => void }) {
  const { busy, run } = useAction(); const feedback = useFeedback();
  return <div className="progress-checks">{rows.map(({ stage, check }) => <div className="progress-check" id={check.id} key={`${stage.id}:${check.id}`}>
    <div><b>{checkLabel({ ...check, stageId: stage.id })}</b><p className="muted">{checkResultWord(check)}</p></div>
    {check.severity === 'warning' && check.acceptanceRequired && check.verdict && check.verdict.current !== false && workflow ? <button disabled={Boolean(busy)} onClick={async () => {
      const note = await feedback.ask({ title: '接受这条提醒', label: '为什么可以接受（会写入记录）', confirm: '接受并记录', required: true, multiline: true });
      if (note !== undefined) await run(`warning:${check.id}`, async () => { await call('warning.accept', { workflowId: workflow.id, checkId: check.id, note, expectedVerdictId: check.verdict?.id }); changed(); }, '已接受当前读数');
    }}>接受这条提醒</button> : null}
    <details className="technical-details"><summary>技术详情</summary><p>{check.id} · {check.severity} · {check.scope} · {check.observe}</p><p>{check.rule}</p><p>{check.source ?? '来源未记录'}{check.verdict?.artifactHash ? ` · ${shortHash(check.verdict.artifactHash)}` : ''}</p></details>
  </div>)}</div>;
}

function StageList({ stages }: { stages: Workflow["stages"] }) {
  return (
    <div className="stages">
      {stages.map((stage) => {
        const row = stageView(stage);
        return (
          <div className="stage" id={`technical-stage-${stage.id}`} tabIndex={-1} key={stage.id} title={row.note}>
            <span className={`mark ${row.state[1]}`} aria-hidden="true">{row.mark}</span>
            <b>{row.label}</b>
            <Status state={row.state} />
            <small>{row.note}</small>
          </div>
        );
      })}
    </div>
  );
}

function SelfImprovement({ projectId, refresh }: { projectId: string; refresh: number }) {
  const feedback = useFeedback();
  const { busy, run } = useAction();
  const [tick, setTick] = useState(0);
  const [packs] = useLoad<Array<{ id: string; version: string; active: boolean }>>("managed.list", refresh + tick, []);
  const [authorings] = useLoad<Array<{ id: string; candidateId: string; taskId: string | null; status: string; reason: string; error: string | null }>>(
    "managed.candidate.authoring.list", refresh + tick, [], { projectId });
  async function authorCandidate() {
    const base = packs.find(pack => pack.active) ?? packs[0];
    if (!base) { feedback.error("请先在核心管理安装正式能力包"); return; }
    const reason = await feedback.ask({ title: "从项目案例生成候选能力包", label: "这次希望 Harness 从项目案例中改进什么？",
      initial: "根据最近失败案例改进上下文和工具", confirm: "生成候选", required: true, multiline: true,
      body: <p>AI 只在本项目的候选副本中整理结构化案例；通过独立检查后才登记为候选，不会直接替换正式版本。</p> });
    if (!reason) return;
    await run("authoring", async () => {
      await call("managed.candidate.authoring.create", { projectId, basePackId: base.id, reason });
      setTick(value => value + 1);
    }, "已建立受限的候选生成任务");
  }
  return (
    <Panel title="Harness 自优化候选">
      <p className="muted">AI 只在本项目的候选副本中蒸馏结构化案例；通过独立任务检查后才登记为候选，仍须隔离评测，不能直接替换正式版本。</p>
      <button disabled={busy === "authoring"} onClick={authorCandidate}>{busy === "authoring" ? "正在建立受限任务…" : "从项目案例生成候选能力包"}</button>
      {authorings.map(item => <div className="row" key={item.id}>
        <div><b>{item.candidateId}</b><p>{item.reason}{item.error ? ` · ${item.error}` : ""}</p></div><Status state={authoringState(item.status)} /></div>)}
    </Panel>
  );
}

function CandidateTrials({ project, candidates, trials, changed }: {
  project: Project; candidates: Array<{ id: string; version: string; status: string; reason: string }>;
  trials: Array<{ id: string; candidateId: string; status: string }>; changed: () => void;
}) {
  const { busy, run } = useAction();
  const approveTrial = (id: string) => run(`trial:${id}`, async () => {
    await call("managed.candidate.trial.approve", { projectId: project.id, candidateId: id, approvedBy: "gui-user" });
    changed();
  }, "已批准本项目试用；开始制作时可在「高级」里选用");
  const offered = project.workflow ? [] : candidates.filter(candidate => candidate.status === "evaluated"
    && !trials.some(trial => trial.candidateId === candidate.id && ["approved", "disabled"].includes(trial.status)));
  const stopped = trials.filter(trial => trial.status === "disabled");
  return (
    <>
      {offered.length ? <Panel title="本项目候选能力试用">
        <p className="muted">只对这个项目新建的制作流程生效；固定哈希，不改变正式版本。也可在「设计目标 → 记忆与 SOP」选择后继制作的本地采用与回退；官方跨用户发行仍需签名验证。</p>
        {offered.map(candidate => <div className="row" key={candidate.id}>
          <div><b>{candidate.version}</b><p>{candidate.reason}</p></div>
          <button disabled={busy === `trial:${candidate.id}`} onClick={() => approveTrial(candidate.id)}>批准本项目试用</button>
        </div>)}
      </Panel> : null}
      {stopped.length ? <Panel title="已自动停止的候选试用">
        <p className="muted">Harness 检测到严重可靠性劣化后已停止这些本地试用；相同不可变候选不能直接重试，需要生成并重新评测新候选。</p>
        {stopped.map(trial => <div className="row" key={trial.id}>
          <div><b>{candidates.find(candidate => candidate.id === trial.candidateId)?.version ?? trial.candidateId}</b><p>仅停止本项目候选；正式版本未改变。</p></div>
          <Status state={trialState(trial.status)} /></div>)}
      </Panel> : null}
    </>
  );
}

type Recovery = { id: string; sourceKind: string; sourcePath: string; mode: "observe" | "shallow" | "deep"; distill: boolean; status: string;
  analysisTaskId: string | null; applyTaskId: string | null; warnings: string[] };
/** Imports and AI recovery of this project; nothing is shown for a project that was not imported. */
function RecoveryPanel({ projectId, refresh, changed }: { projectId: string; refresh: number; changed: () => void }) {
  const [rows, recoveryError] = useLoad<Recovery[]>("project.recovery.list", refresh, [], { projectId });
  const { busy, run } = useAction();
  if (!rows.length && !recoveryError) return null;
  const applyRecovery = (id: string) => run("recovery", async () => {
    await call<{ taskId: string }>("project.recovery.apply", { id }); changed();
  }, "已建立改造任务");
  const adoptAssets = (id: string) => run("assets", async () => {
    const result = await call<{ created: string[] }>("project.recovery.adoptAssets", { id }); changed();
    return result;
  }, "已把 AI 识别的素材登记为候选并关联本项目");
  return (
    <Panel title="工程导入与 AI 恢复">
      <p className="muted">输入可以是工程、素材包或混合内容。安全层展开文件，AI 判断类型与真实工程根；浅接手保留原做法，深度改造只在隔离副本进行。</p>
      {recoveryError ? <div className="banner bad">{recoveryError}</div> : null}
      {rows.map(row => <div className="row" key={row.id}>
        <div><b>{sourceKind(row.sourceKind)} · {takeoverMode(row.mode)}{row.distill ? " · 提取可复用做法" : ""}</b>
          <p>{row.status === "failed" ? "接手分析没有通过核对，暂不能继续改造；原工程未修改。"
            : row.status === "ready" ? "接手分析已通过核对，可以继续；分析结论仍需按实际文件验证。" : "Harness 正在核对现有工程，原工程保持不变。"}</p>
          <details><summary>导入来源与诊断</summary><p>{row.sourcePath}</p>
            {row.warnings.length ? <ul>{row.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}</details></div>
        <Status state={recoveryState(row.status)} />
        <button disabled={Boolean(busy) || row.status !== "ready"} onClick={() => adoptAssets(row.id)}>若判定为素材则登记</button>
        {row.mode !== "observe" && !row.applyTaskId ? <button disabled={Boolean(busy) || row.status !== "ready"} onClick={() => applyRecovery(row.id)}>分析通过后执行</button> : null}
      </div>)}
    </Panel>
  );
}

/** Hand-over to the official uploader, and VPM package changes through the official CLI. */
function UploadPanel({ projectId, refresh, changed }: { projectId: string; refresh: number; changed: () => void }) {
  type Vpm = { available: boolean; packages: Record<string, string>; legacyManifest: boolean };
  const [vpm, vpmError] = useLoad<Vpm>("project.vpm.status", refresh, { available: false, packages: {}, legacyManifest: true }, { projectId });
  const { busy, run } = useAction();
  const [message, setMessage] = useState("");
  const [packageId, setPackageId] = useState("");
  const vpmAction = (action: string) => run(action, async () => {
    const result = await call<{ output: string }>("project.vpm.apply", { projectId, action, ...(packageId ? { packageId } : {}) }, 600000);
    setMessage(result.output || "VPM 操作完成"); changed();
  });
  const upload = () => run("upload", async () => setMessage((await call<{ message: string }>("project.upload.open", { projectId })).message));
  return (
    <Panel title="上传交接与 VPM 包">
      <p className="muted">上传只会打开对应的 Unity 工程和官方 VRChat SDK 面板；登录、选择账号和上传都由你在官方面板完成。包变更通过官方 VPM CLI，失败时恢复原来的包清单。</p>
      {vpmError ? <div className="banner bad">{vpmError}</div> : null}
      <Field label="VPM CLI" value={vpm.available ? "可用" : "未安装或不在 PATH"} />
      <Field label="已声明的包" value={Object.entries(vpm.packages).map(([id, version]) => `${id}@${version}`).join("、") || "无"} />
      <div className="toolbar">
        <input value={packageId} onChange={e => setPackageId(e.target.value)} placeholder="包 ID（添加或移除时填写）" />
        <button disabled={Boolean(busy)} onClick={() => vpmAction("check")}>检查</button>
        <button disabled={Boolean(busy)} onClick={() => vpmAction("resolve")}>解析依赖</button>
        <button disabled={Boolean(busy) || !packageId} onClick={() => vpmAction("add")}>添加</button>
        <button disabled={Boolean(busy) || !packageId} onClick={() => vpmAction("remove")}>移除</button>
        <button disabled={Boolean(busy)} onClick={upload}>打开 Unity 与官方上传面板</button>
      </div>
      {message ? <pre>{message}</pre> : null}
    </Panel>
  );
}

function AvatarWorkspace({ workflow }: { workflow: Workflow | null }) {
  const relevant = workflow?.stages.filter(stage =>
    ["face", "outfit", "recolor", "menu", "accessory", "tracking"].some(name => stage.id.includes(name))) ?? [];
  return (
    <div className="two">
      <Panel title="角色制作">
        <p className="muted">这里按制作阶段汇总角色、服装、配色和面捕状态；检测结论来自 Runtime 产物，不根据文件名猜测。</p>
        {relevant.map(stage => <div className="stage" key={stage.id}>
          <span className={stage.display ?? stage.status} /><b>{stageLabel(stage.id)}</b>
          <small title={stage.reasons.join("\n")}>{stageState(stage.display ?? stage.status)[0]}{reasonsText(stage.reasons) ? ` · ${reasonsText(stage.reasons)}` : ""}</small>
        </div>)}
        {!relevant.length ? <Empty text="这个制作流程没有角色制作阶段。" /> : null}
      </Panel>
      <Panel title="菜单与参数">
        <p className="muted">菜单结构必须以 Unity 构建后的真实参数和可达性证据为准。完成菜单阶段后，状态与阻断原因会在这里出现。</p>
        {(workflow?.stages.filter(stage => stage.id.includes("menu")) ?? []).map(stage =>
          <div className="stage" key={stage.id}><span className={stage.display ?? stage.status} /><b>{stageLabel(stage.id)}</b><small title={stage.reasons.join("\n")}>{stageState(stage.display ?? stage.status)[0]}{reasonsText(stage.reasons) ? ` · ${reasonsText(stage.reasons)}` : ""}</small></div>)}
        {!workflow?.stages.some(stage => stage.id.includes("menu")) ? <Empty text="这个制作流程没有菜单阶段。" /> : null}
      </Panel>
    </div>
  );
}
function ProjectDesign({ projectId, refresh, changed }: { projectId: string; refresh: number; changed: () => void }) {
  const [brief] = useLoad<ProjectBrief | null>("project.brief.get", refresh, null, { projectId });
  const [variants, variantError] = useLoad<ProjectVariant[]>("project.variant.list", refresh, [], { projectId });
  const [roots, rootError] = useLoad<AvatarRoot[]>("project.root.list", refresh, [], { projectId });
  const [request, setRequest] = useState(""); const [face, setFace] = useState("");
  const [variantName, setVariantName] = useState(""); const [variantDescription, setVariantDescription] = useState("");
  const [rootName, setRootName] = useState(""); const [scenePath, setScenePath] = useState("");
  const [variantId, setVariantId] = useState(""); const [derivedFrom, setDerivedFrom] = useState("");
  const [newRootRole, setNewRootRole] = useState<AvatarRoot["role"]>("working"); const [plugin, setPlugin] = useState("");
  useEffect(() => { if (brief) { setRequest(brief.customerRequest); setFace(brief.faceConcept); } }, [brief?.updatedAt, brief?.projectId]);
  const outfits = variantSummary(variants.length);
  const feedback = useFeedback();
  const { busy, run } = useAction();
  const saveBrief = () => run("brief", async () => {
    if (!brief) throw new Error("需求摘要还没有加载完成");
    await call("project.brief.update", { projectId, intakeMode: brief.intakeMode, customerRequest: request, faceConcept: face,
      status: brief.status === "direction_approved" ? "direction_approved" : request ? "direction_pending" : "draft" });
    changed();
  }, "需求摘要已保存");
  async function addVariant() {
    if (!variantName.trim()) { feedback.error("先填写方案名称"); return; }
    await run("variant", async () => {
      await call("project.variant.save", { projectId, name: variantName.trim(), description: variantDescription.trim(), status: "planned" });
      setVariantName(""); setVariantDescription(""); changed();
    }, "已加入衣装方案");
  }
  /**
   * Removing an outfit plan the person no longer wants. `project.variant.remove` existed in the Runtime with no entry
   * here, so a plan added by mistake could never be taken back. The Runtime refuses while any avatar root still points
   * at the plan, and says how many: that reason is shown rather than replaced, because the fix (reassign or archive the
   * root) is the person's (src/api/server.ts `project.variant.remove`).
   */
  async function removeVariant(variant: ProjectVariant) {
    const linkedRoots = roots.filter(root => root.variantId === variant.id).length;
    const confirmed = await feedback.confirm({ title: `删除衣装方案「${variant.name}」？`,
      body: linkedRoots
        ? `还有 ${linkedRoots} 个头像根关联这个方案，Harness 会拒绝删除；请先在下方「Unity 中的头像根」里把它们重新归属或归档。`
        : "删除后这个方案不再出现在列表里；已完成的制作证据与工程文件不受影响。",
      confirm: "删除方案", danger: true });
    if (!confirmed) return;
    await run(`variant-remove:${variant.id}`, async () => {
      await call("project.variant.remove", { id: variant.id, projectId });
      changed();
    }, `已删除衣装方案「${variant.name}」`);
  }
  async function addRoot() {
    if (!rootName.trim()) { feedback.error("先填写头像根的对象路径"); return; }
    await run("root", async () => {
      await call("project.root.save", { projectId, objectPath: rootName.trim(), scenePath: scenePath.trim(), variantId, derivedFrom,
        role: newRootRole, pluginProfile: plugin.trim(), activeState: "unknown", blueprintId: "" });
      setRootName(""); setDerivedFrom(""); setPlugin(""); changed();
    }, "已登记头像根");
  }
  return <>
    {variantError || rootError ? <div className="banner bad">{variantError || rootError}</div> : null}
    <div className="design-map aesthetic-map"><div><span>头像目标</span><b>共同脸部设定</b><small>所有衣装方案共享</small></div><i className={outfits.flows ? "" : "off"}>→</i><div><span>造型选择</span><b>{outfits.title}</b><small>{outfits.hint}</small></div></div>
    <div className="two">
      <Panel title="头像需求与共同脸部方向">
        <p className="muted">保存只更新需求摘要；审美方向仍要在制作方案里由你确认。</p>
        <label className="stack">头像需求<textarea value={request} onChange={e => setRequest(e.target.value)} /></label>
        <label className="stack">共同脸部设定<textarea value={face} onChange={e => setFace(e.target.value)} /></label>
        <div className="actions"><Status state={briefState(brief?.status ?? "draft")} /><button className="primary" disabled={busy === "brief"} onClick={saveBrief}>{busy === "brief" ? "正在保存…" : "保存需求摘要"}</button></div>
      </Panel>
      <Panel title="新增衣装方案">
        <p className="muted">衣装方案是你最终会选择、使用或导出的造型；面捕、插件或备份不需要单独建方案。</p>
        <label className="stack">方案名称<input value={variantName} onChange={e => setVariantName(e.target.value)} placeholder="例如：衣装 A / 冬季私服" /></label>
        <label className="stack">方案说明<textarea value={variantDescription} onChange={e => setVariantDescription(e.target.value)} placeholder="服装、配色、用途与取舍" /></label>
        <div className="actions"><button disabled={busy === "variant"} onClick={addVariant}>{busy === "variant" ? "正在保存…" : "加入衣装方案"}</button></div>
      </Panel>
    </div>
    <div className="variant-board">{variants.map(v => <div className="variant-card" key={v.id}><div className="card-head"><h3>{v.name}</h3><Status state={variantState(v.status)} /><button className="link" disabled={busy === `variant-remove:${v.id}`}
      onClick={() => void removeVariant(v)}>{busy === `variant-remove:${v.id}` ? "正在删除…" : "删除"}</button></div><p>{v.description || "尚未补充方案说明"}</p>{roots.some(r => r.variantId === v.id) ? <details><summary className="muted">Unity 中的头像根 · {roots.filter(r => r.variantId === v.id).length}</summary><div className="root-chain">{roots.filter(r => r.variantId === v.id).map(r => <div key={r.id}><b>{r.objectPath}</b><span>{rootRole(r.role)}{r.pluginProfile ? ` · ${r.pluginProfile}` : ""}</span><small>{r.derivedFrom ? `派生自 ${roots.find(x => x.id === r.derivedFrom)?.objectPath ?? "已登记根"}` : "方案起始根"}</small></div>)}</div></details> : null}</div>)}</div>
    {!variants.length ? <Empty text="还没有衣装方案。衣装方案是你最终能切换和使用的造型。" /> : null}
    <details className="technical-details"><summary>高级：Unity 中的头像根（通常由 AI 维护）</summary><Panel title="头像根">
      <p className="muted">真实工程中，一个衣装方案可以有工作根、FT/插件派生根和最终交付根；派生关系用于避免 AI 在错误根上施工。</p>
      <div className="root-form"><input value={rootName} onChange={e => setRootName(e.target.value)} placeholder="Hierarchy 对象路径 / 根名称"/><input value={scenePath} onChange={e => setScenePath(e.target.value)} placeholder="Scene 路径"/><select value={variantId} onChange={e => setVariantId(e.target.value)}><option value="">共享基线（不属于某衣装）</option>{variants.map(v => <option value={v.id} key={v.id}>{v.name}</option>)}</select><select value={derivedFrom} onChange={e => setDerivedFrom(e.target.value)}><option value="">无派生来源</option>{roots.map(r => <option value={r.id} key={r.id}>{r.objectPath}</option>)}</select><select value={newRootRole} onChange={e => setNewRootRole(e.target.value as AvatarRoot["role"])}><option value="baseline">共同基线</option><option value="working">施工根</option><option value="plugin_derivative">插件派生根</option><option value="delivery">交付根</option></select><input value={plugin} onChange={e => setPlugin(e.target.value)} placeholder="插件配置，例如 FaceTracking"/><button disabled={busy === "root"} onClick={addRoot}>登记根</button></div>
    </Panel></details>
  </>;
}
type VariantRoles = Record<string, Record<string, string>>;
/** Materials of the project in one table: its role in the project, and its use in each outfit, side by side. */
function ProjectMaterials({ projectId, refresh, changed }: { projectId: string; refresh: number; changed: () => void }) {
  const [assets, error] = useLoad<Asset[]>("project.asset.list", refresh, [], { projectId });
  const [variants] = useLoad<ProjectVariant[]>("project.variant.list", refresh, [], { projectId });
  const [roles, setRoles] = useState<VariantRoles>({});
  const [rolesError, setRolesError] = useState("");
  const [adding, setAdding] = useState(false);
  const { busy, run } = useAction();
  const variantKey = variants.map(variant => variant.id).join(",");
  useEffect(() => {
    let live = true;
    Promise.all(variants.map(variant => call<Asset[]>("project.variant.asset.list", { variantId: variant.id })
      .then(list => [variant.id, Object.fromEntries(list.filter(asset => asset.attached).map(asset => [asset.id, asset.role ?? "candidate"]))] as const)))
      .then(entries => { if (live) { setRoles(Object.fromEntries(entries)); setRolesError(""); } })
      .catch(reason => { if (live) setRolesError(errorText(reason)); });
    return () => { live = false; };
  }, [refresh, variantKey]);
  const linked = assets.filter(asset => asset.attached);
  const available = assets.filter(asset => !asset.attached);
  const attach = (asset: Asset, role = "candidate") => run(`asset:${asset.id}`, async () => {
    await call("project.asset.attach", { projectId, assetId: asset.id, role }); changed();
  });
  const detach = (asset: Asset) => run(`asset:${asset.id}`, async () => {
    await call("project.asset.detach", { projectId, assetId: asset.id }); changed();
  }, `已从项目移除「${asset.name}」`);
  const assign = (variantId: string, asset: Asset, role: string) => run(`asset:${asset.id}`, async () => {
    if (role) await call("project.variant.asset.attach", { variantId, assetId: asset.id, role });
    else await call("project.variant.asset.detach", { variantId, assetId: asset.id });
    changed();
  });
  return (
    <>
      <MaterialSources refresh={refresh} changed={changed} />
      <Panel title="项目素材" actions={<button onClick={() => setAdding(true)}>从素材库添加</button>}>
        <p className="muted">每项素材在项目里的用途，以及它用在哪个衣装方案。开始制作时这些归属会被固定下来，AI 按方案分别规划和施工。关联不会复制或修改磁盘文件。</p>
        {error || rolesError ? <div className="banner bad">{error || rolesError}</div> : null}
        {linked.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>素材</th><th>在项目中</th>{variants.map(variant => <th key={variant.id}>{variant.name}</th>)}<th><span className="sr-only">操作</span></th></tr></thead>
              <tbody>
                {linked.map(asset => (
                  <tr key={asset.id}>
                    <td><b>{asset.name}</b><small>{assetKind(asset.kind)}{asset.license && asset.license !== "unknown" ? ` · ${asset.license}` : ""}</small></td>
                    <td><select aria-label={`${asset.name} 在项目中的用途`} value={asset.role ?? "candidate"} disabled={busy === `asset:${asset.id}`}
                      onChange={e => void attach(asset, e.target.value)}>
                      <option value="candidate">候选</option><option value="source">来源</option><option value="used">已使用</option><option value="rejected">不使用</option>
                    </select></td>
                    {variants.map(variant => (
                      <td key={variant.id}><select aria-label={`${asset.name} 在「${variant.name}」中的用途`} value={roles[variant.id]?.[asset.id] ?? ""}
                        disabled={busy === `asset:${asset.id}`} onChange={e => void assign(variant.id, asset, e.target.value)}>
                        <option value="">未分配</option><option value="candidate">候选</option><option value="source">来源</option>
                        <option value="used">确定使用</option><option value="rejected">不用于本方案</option>
                      </select></td>
                    ))}
                    <td className="cell-action"><button className="link" disabled={busy === `asset:${asset.id}`} onClick={() => detach(asset)}>移出项目</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty text="还没有关联素材。" action={<button className="link" onClick={() => setAdding(true)}>从素材库添加</button>} />}
        {!variants.length && linked.length ? <p className="reason">在「设计目标」建立衣装方案后，这里会多出每个方案的一列。</p> : null}
      </Panel>
      {adding ? (
        <Drawer title="从素材库添加" onClose={() => setAdding(false)} footer={<button onClick={() => setAdding(false)}>完成</button>}>
          <p className="muted">加入后作为项目的候选素材；可以再改成来源、已使用或不使用。</p>
          {available.map(asset => (
            <div className="row" key={asset.id}>
              <div><b>{asset.name}</b><p>{assetKind(asset.kind)} · {assetState(asset.status)[0]}</p></div>
              <button disabled={busy === `asset:${asset.id}`} onClick={() => attach(asset)}>加入项目</button>
            </div>
          ))}
          {!available.length ? <Empty text={assets.length ? "素材库里的素材都已加入这个项目。" : "素材库是空的；先在「素材」页登记本地素材或连接 BOOTH。"} /> : null}
        </Drawer>
      ) : null}
    </>
  );
}
/**
 * The conversation column: `children` (the project, its next step and decisions), then the change requests and the box to
 * make one. Coordinated answers and questions come from supervised tasks. Production changes remain a separate
 * approval path. Both unsent text and the pending command receipt survive a browser reload.
 */
/** The proposal and its run, projected by model.ts productionState: the two lifecycles are never read through one slot. */
type ProductionProposal = ProductionLike;
/** Only user intentions are exposed. Runtime chooses the interrupted stage and verifies that it is safe to resume. */
const productionRecoveryInFlight=new Map<string,'resume'|'cancel'>();
function ProductionRecovery({projectId,proposal:p,changed}:{projectId:string;proposal:ProductionProposal;changed:()=>void}) {
  const {busy,run}=useAction();
  const feedback=useFeedback();
  const inFlight=React.useRef(false);
  const [pending,setPending]=useSessionState(`production-recovery:${p.id}`,"");
  if(!p.progress)return null;
  let stored:{action?:string;phase?:string;command?:{projectId:string;id:string;commandId:string;expectedToken:string}}|undefined;
  try {stored=pending?JSON.parse(pending):undefined;} catch { /* A malformed local receipt is not evidence that an operation finished. */ }
  const recovery=p.progress.recovery;
  const currentReceipt=stored?.action==='resume' && stored.command?.projectId===projectId && stored.command.id===p.id &&
    stored.command.expectedToken===p.progress.token;
  const terminalReceipt=currentReceipt && recovery?.commandId===stored!.command!.commandId &&
    ['failed','succeeded','unknown'].includes(recovery.status);
  const checking=busy==='resume'||productionRecoveryInFlight.get(p.id)==='resume'||recovery?.status==='running';
  const legacyUnknown=currentReceipt && !recovery && p.progress.canResume && !checking;
  const unconfirmed=currentReceipt && !terminalReceipt && !checking && !legacyUnknown;
  const blocked=Boolean(busy)||productionRecoveryInFlight.has(p.id)||recovery?.status==='running'||unconfirmed;
  const act=async(action:"resume"|"cancel")=>{
    if(inFlight.current||productionRecoveryInFlight.has(p.id)||blocked)return;
    const confirmed = await feedback.confirm(action === 'cancel' ? {
      title: '取消整个制作流程？',
      body: <p>这会停止整个制作流程，未完成的任务会被取消；已完成的成果和证据保留，之后不能恢复，只能重新开始制作。</p>,
      confirm: '取消整个制作流程', danger: true,
    } : {
      title: '继续制作流程？',
      body: <p>Harness 会先核对上次执行结果，再继续未完成阶段；可能调用已配置的 AI 并产生费用，不会跳过工程核对。</p>,
      confirm: '核对并继续制作',
    });
    if (!confirmed) return;
    if(inFlight.current||productionRecoveryInFlight.has(p.id)||blocked)return;
    inFlight.current=true;
    productionRecoveryInFlight.set(p.id,action);
    return run(action,async()=>{
    const reusable=stored?.action===action && stored.command?.projectId===projectId && stored.command.id===p.id &&
      stored.command.expectedToken===p.progress!.token && !(recovery?.status==='failed' && recovery.commandId===stored.command.commandId);
    const command=reusable ? stored!.command!
      : {projectId,id:p.id,commandId:crypto.randomUUID(),expectedToken:p.progress!.token};
    setPending(JSON.stringify({action,command,phase:'waiting'}));
    try {
      const result=await call<{requested?:boolean;confirmed?:boolean;pending?:boolean}>(`project.production.${action}`,command,
        action==='resume'?15*60_000:undefined);
      if(action==='resume' && (result.pending===true||result.requested!==true)) {
        setPending(JSON.stringify({action,command,phase:'waiting'}));changed();return;
      }
      if(action==='cancel' && result.confirmed===false)changed();
      else {setPending("");changed();}
      feedback.ok(action==='resume'?"已核对并请求继续制作":result.confirmed===false?"已请求停止，结果仍待核对":"已停止制作；已有成果保留");
    } catch(error) {
      if(action==='resume')setPending(JSON.stringify({action,command,phase:'uncertain'}));
      changed();throw error;
    } finally {inFlight.current=false;productionRecoveryInFlight.delete(p.id);}
    });
  };
  return <div>
    <p className="muted">{p.progress.reason}</p>
    {checking?<p role="status">正在核对并保留工程，可能需要几分钟。核对完成前不会重复启动制作。</p>:null}
    {unconfirmed?<p role="status">尚未收到核对结果，Harness 可能仍在处理。请查看最新进展；结果确认前不会重复提交。</p>:null}
    {recovery?.status==='failed'?<p role="alert">{recovery.error||"这次核对未完成，已有成果保留。"}</p>:null}
    {recovery?.status==='unknown'?<p role="status">上次核对的结果尚未确认。重新核对会先检查并保留已有工程，不会直接重做。</p>:null}
    {legacyUnknown?<p role="status">未找到上次核对的回执，原工程仍保留。Harness 已确认可以重新核对；请主动重新核对后再继续。</p>:null}
    {checking||unconfirmed||legacyUnknown?<button onClick={changed}>查看最新进展</button>:null}
    {p.progress.canResume?<><p className="muted">继续时 Harness 会核对旧执行并使用已配置的 AI，可能产生模型调用费用。</p>
      <button className="primary" disabled={blocked} onClick={()=>act("resume")}>{checking?"正在核对工程…":recovery?.status==='unknown'||legacyUnknown?"重新核对并继续制作":"核对并继续制作"}</button></>:null}
    {p.progress.canCancel?<button disabled={blocked} onClick={()=>act("cancel")}>{p.progress.state==='stopping'?"再次检查停止结果":"取消这次制作"}</button>:null}
  </div>;
}
function Chat({ projectId, draft, refresh, changed, children }: {
  projectId: string; draft?: string; refresh: number; changed: () => void; children?: React.ReactNode;
}) {
  const [text, setText] = useSessionState(`request:${projectId}`, draft ?? "");
  const [pending, setPending] = useSessionState(`request-command:${projectId}`, "");
  /**
   * The conversation scrolls under the docked change-request box (style.css `.composer-dock` is sticky at the bottom),
   * so without reserved space the box covers whatever sits at the bottom of the column — a decision card's own approval
   * and change-request buttons among it (F27b). The column reserves the box's measured height as `--composer-h` and
   * follows it when the textarea grows; the box itself stays where it was.
   */
  const column = React.useRef<HTMLDivElement>(null), dock = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = column.current, box = dock.current;
    if (!target || !box) return;
    const reserve = () => target.style.setProperty("--composer-h", `${Math.ceil(box.getBoundingClientRect().height)}px`);
    reserve();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reserve);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (draft) setText(draft); }, [draft]);
  const [messages, error] = useLoad<ProjectMessage[]>("project.message.list", refresh, [], { projectId });
  const [intent,intentError] = useLoad<Array<{id:string;content:string|null;quote:string}>>("project.intent.list",refresh,[],{projectId});
  const [proposals, proposalError] = useLoad<ProductionProposal[]>(
    "project.production.list", refresh, [], { projectId });
  const [approvalCommand, setApprovalCommand] = useSessionState(`production-command:${projectId}`, "");
  const { busy, run } = useAction();
  const decideProduction = (id: string, revision: number, approve: boolean) => run(`production:${id}`, async () => {
    const previous = approvalCommand ? JSON.parse(approvalCommand) : undefined;
    const command = previous?.id === id && previous?.revision === revision ? previous
      : { id, revision, commandId: crypto.randomUUID() };
    if (approve) setApprovalCommand(JSON.stringify(command));
    await call(approve ? "project.production.approve" : "project.production.reject", command);
    setApprovalCommand(""); changed();
  }, approve ? "已批准，制作流程已建立" : "已放弃这个提案");
  const send = () => run("send", async () => {
    if (!text.trim()) throw new Error("先写下要修改的内容");
    const content = text.trim();
    const revision = Math.max(0, ...messages.map(m => m.revision ?? 0));
    const question = messages.find(m => m.revision === revision && m.interactionStatus === "awaiting_user");
    const previous = pending ? JSON.parse(pending) : undefined;
    const command = previous?.content === content ? previous : { projectId, content, commandId: crypto.randomUUID(),
      expectedRevision: revision, ...(question ? { replyTo: question.id } : {}) };
    setPending(JSON.stringify(command));
    try { await call("project.message.add", command); }
    catch (failure) {
      if (String(failure).includes("会话已更新") || String(failure).includes("问题已失效")) { setPending(""); changed(); }
      throw failure;
    }
    setPending("");
    setText("");
    changed();
  }, "已收到，等待 AI 处理");
  return (
    <>
      <div className="conversation" ref={column}>
        {children}
        <section className="thread" aria-labelledby={`requests-${projectId}`}>
          <div className="thread-head">
            <h2 id={`requests-${projectId}`}>项目对话</h2>
            <p>AI 会理解要求、确认细节并提出制作提案。批准后才开始制作，回复本身不代表修改完成。</p>
          </div>
          {error ? <div className="banner bad">{error}</div> : null}
          {intentError ? <div className="banner bad">{intentError}</div> : null}
          {intent.length ? <details><summary>当前要求的理解</summary>
            <p className="muted">这是 AI 根据你的原话整理的要求，不代表已经完成修改。理解有误时可直接在对话中纠正。</p>
            <ul>{intent.map(item=><li key={item.id}>{item.content??"这项要求已撤回"}<small> · 原话：{item.quote}</small></li>)}</ul>
          </details> : null}
          {proposalError ? <div className="banner bad">{proposalError}</div> : null}
          {proposals.map(p => <article className="message" id={`production-proposal-${p.id}`} tabIndex={-1} key={p.id}>
            <h3>制作提案 · {productionLabel(p)}</h3>
            <p>{p.request}</p><p>使用素材：{p.inputs.map(a => a.name).join("、")}</p>
            {p.status === "proposed" ? <>
              <p className="muted">批准后由已配置的 AI 准备制作方案并推进受管流程，可能产生模型调用费用，目前没有可靠的费用估算。素材适配仍需检查；成果以项目中的验证结果为准。</p>
              <button className="primary" disabled={Boolean(busy) || p.revision !== Math.max(0, ...messages.map(m => m.revision ?? 0))}
                onClick={() => decideProduction(p.id, p.revision, true)}>批准并开始</button>
              <button disabled={Boolean(busy)} onClick={() => decideProduction(p.id, p.revision, false)}>放弃提案</button>
              {p.revision !== Math.max(0, ...messages.map(m => m.revision ?? 0)) ? <p>要求已更新，请等待或请求新的制作提案。</p> : null}
            </> : <ProductionRecovery projectId={projectId} proposal={p} changed={changed} />}
          </article>)}
          {messages.map((m) => (
            <article className="message" id={m.taskId ? `interaction-task-${m.taskId}` : undefined} tabIndex={m.taskId ? -1 : undefined} key={m.id}>
              <div className="message-meta"><b>{m.role === "user" ? "你" : "Harness"}</b><time>{when(m.createdAt)}</time>
                {m.taskStatus && ["RECOVERY_REQUIRED", "BLOCKED", "WAITING_HUMAN"].includes(m.taskStatus) ? <span>任务需要处理，请查看项目待办</span>
                  : m.interactionStatus ? <span>{({ queued: "等待 AI", running: "AI 处理中", awaiting_user: "等待你的回答",
                  answered: "已回答", completed: "已回复", failed: "处理失败", superseded: "已被新消息替代", cancelled: "已取消" } as Record<string, string>)[m.interactionStatus]}</span>
                  : <Status state={messageState(m.status)} />}</div>
              <p>{m.content}</p>
              {m.interactionStatus === "failed" && m.taskId && m.revision === Math.max(0, ...messages.map(item => item.revision ?? 0)) ? <>
                <p className="muted">这次处理未完成，原要求与已有发现仍保留。续接会继续使用已配置的 AI，可能产生调用费用。</p>
                <button disabled={Boolean(busy)} onClick={() => run(`retry:${m.id}`, async () => {
                  await call("project.message.retry", { projectId, id: m.id, expectedRevision: m.revision,
                    expectedTaskId: m.taskId, commandId: `retry:${m.id}:${m.taskId}` });
                  changed();
                }, "已请求从中断处继续")}>从中断处继续</button>
              </> : null}
              {m.error ? <details><summary>查看暂未处理的原因</summary><p>{m.error}</p></details> : null}
            </article>
          ))}
          {!messages.length ? <Empty text="还没有提出过修改。" /> : null}
        </section>
      </div>
      <div className="composer-dock" ref={dock}>
        <div className="composer">
          <label htmlFor={`request-${projectId}`}>提出修改要求</label>
          <textarea id={`request-${projectId}`} autoFocus={Boolean(draft)} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="描述新的要求或问题，例如：外出装更轻盈一些，耳饰只在第二套衣装显示…" />
          <div className="composer-foot">
            <span>交给 AI 理解；制作提案需要你的批准</span>
            <button className="primary" disabled={busy === "send" || !text.trim()} onClick={send}>{busy === "send" ? "正在提交…" : "提交要求"}</button>
          </div>
        </div>
      </div>
    </>
  );
}
/**
 * Checks on the build, performance and delivery: one line per stage, the checks themselves only on demand. A stage
 * whose warning reading nobody has accepted yet is shown here too, because accepting it is the person's own decision
 * and this is the stage detail where its current reading is readable.
 */
function Verify({ workflow, changed }: { workflow: Workflow | null; changed: () => void }) {
  const { busy, run } = useAction();
  const feedback = useFeedback();
  const stages = workflow?.stages.filter((s) => s.id.includes("regression") || s.id === "performance" || s.id === "package"
    || s.checks.some((check) => check.severity === "warning")) ?? [];
  const waiting = (workflow?.stages ?? []).flatMap(stage => stage.checks
    .filter(check => warningState(check) === "waiting"));
  const accept = async (check: Workflow["stages"][number]["checks"][number]) => {
    if (!workflow) return;
    // The reason is the person's own words, not a channel label: it is what the record answers "why was this accepted"
    // with later, so it is asked for (required) and stored verbatim; cancelling asks nothing of the Runtime.
    const reason = await feedback.ask({
      title: "接受这条提醒",
      body: <>接受的是你看到的这条读数，它不会变成检查通过；产物再变化时需要重新确认。依据：{artifactLabel(check.on)} {shortHash(check.verdict?.artifactHash ?? "")}</>,
      label: "为什么可以接受（会写入记录，之后再回顾时读到的就是这句话）",
      confirm: "接受并记录", required: true, multiline: true,
    });
    if (reason === undefined) return;
    await run(`warning:${check.id}`, async () => {
      // The acceptance binds the reading shown here; a reading that changed meanwhile is refused by the Runtime, not overwritten.
      await call("warning.accept", { workflowId: workflow.id, checkId: check.id, note: reason,
        expectedVerdictId: check.verdict?.id }, 60_000);
      changed();
    }, "已记录你接受这条提醒：它绑定你看到的当前读数，产物再变化时需要重新确认");
  };
  // The method versions belong to every conclusion below, so they are stated once for the panel rather than repeated.
  const method = [workflow?.knowledgeVersion ? `知识包 ${shortHash(workflow.knowledgeVersion)}` : "",
    workflow?.processHash ? `流程定义 ${shortHash(workflow.processHash)}` : ""].filter(Boolean).join(" · ");
  return (
    <Panel title="验证与交付">
      <p className="muted">只把绑定当前产物版本的检查视为有效；证据过期会明确标出，不能冒充通过。</p>
      {waiting.length ? <p className="banner warn" role="status">有 {waiting.length} 条提醒等你确认：它们记录的是当前读数，
        接受只对这条读数有效，不会把提醒改成检查通过；产物再变化时需要重新确认。</p> : null}
      {method ? <p className="muted">这批结论的方法版本：{method}。每条检查记录它判断的产物版本与当前绑定的版本。</p> : null}
      {stages.map((s) => {
        const counts = verdictCounts(s.checks);
        return (
          <details className="verify-stage" key={s.id} open={counts.fail > 0 || counts.stale > 0 || counts.noData > 0
            || s.checks.some(check => warningState(check) === "waiting")}>
            <summary>
              <b>{stageLabel(s.id)}</b>
              {/* Every level the check could not reach is counted where it can be read: a stage whose measurement is
                  missing opens, because its next step (measure again) is different from repairing the avatar. */}
              <span>{verdictTally(counts)}</span>
              <Status state={stageView(s).state} />
            </summary>
            {s.checks.map(check => (
              <div className="check-row" key={check.id} title={check.rule}>
                <span className={`dot ${!check.verdict ? "" : !check.verdict.current ? "warn" : verdictState(check.verdict.result)[1]}`} />
                <div><b>{checkLabel({ ...check, stageId: s.id })}</b><p><code>{check.id}</code></p>
                  {/* The evidence's identity, read from the Runtime's own row: what was judged, over what scope, when,
                      and — when it no longer binds — which version it was left behind by. A verdict that still binds
                      says so, so the reader does not have to know that an absent "当前版本" means "unchanged". */}
                  {check.verdict ? <p className="muted">
                    依据：{artifactLabel(check.on)}{check.verdict.artifactHash ? ` ${shortHash(check.verdict.artifactHash)}` : ""}
                    {check.verdict.current ? "（仍是当前版本）" : ` · 当前版本 ${shortHash(check.verdict.boundHash ?? "")}`}
                    {` · 范围 ${check.scope} · ${when(check.verdict.recordedAt)}`}
                    {check.source ? ` · 来源 ${check.source}` : ""}
                  </p> : null}
                </div>
                {/* The verdict and the next action it implies: a missing measurement points at measuring again. A
                    warning the person has not accepted carries its own action in the same column, so the row keeps
                    the three columns the check list is laid out in. */}
                <span className="check-action">
                  <small>{check.verdict
                    ? `${verdictState(check.verdict.result)[0]}${check.verdict.current ? "" : " · 证据已过期"}${verdictNext(check.verdict.result) ? ` · ${verdictNext(check.verdict.result)}` : ""}`
                    : "待取证"} · {severityLabel(check.severity)}</small>
                  {check.severity === "warning" ? <WarningAction check={check} acceptedText={check.verdict?.acceptedAt ? `已接受 · ${when(check.verdict.acceptedAt)}` : ""}
                    busy={busy === `warning:${check.id}`} onAccept={() => void accept(check)} /> : null}
                </span>
              </div>
            ))}
          </details>
        );
      })}
      {!stages.length ? <Empty text="开始制作后，效果、性能和交付包的检查会出现在这里。" /> : null}
    </Panel>
  );
}
type CheckView = Workflow["stages"][number]["checks"][number];
/**
 * What a warning reading asks of the person right now: accept it, re-measure it, or nothing. Only a warning the Runtime
 * would accept (`acceptanceRequired`, judged by the same aggregate the Runtime uses) is offered: a blocking or advisory
 * failure, and a warning that applies but reads `not_applicable` or has passed, have nothing here for the person to
 * accept, and offering one produced a button the Runtime refused.
 */
function warningState(check: CheckView): "waiting" | "accepted" | "stale" | "done" {
  if (check.severity !== "warning" || !check.verdict) return "done";
  if (!check.verdict.current) return "stale";
  if (check.verdict.accepted) return "accepted";
  return check.acceptanceRequired ? "waiting" : "done";
}
function WarningAction({ check, acceptedText, busy, onAccept }: { check: CheckView; acceptedText: string; busy: boolean; onAccept: () => void }) {
  const state = warningState(check);
  if (state === "done") return null;
  if (state === "stale") return <small>证据已过期，重新取证后再接受</small>;
  if (state === "accepted") return <small>{acceptedText}</small>;
  return <button className="link" disabled={busy} onClick={onAccept}>{busy ? "正在提交…" : "接受这条提醒"}</button>;
}
type ContextPreview = { stageId: string; modelFamily: string | null; usedChars: number; budgetChars: number;
  coverage: string[]; decisions: Array<{ id: string; path: string; selected: boolean; reason: string; chars: number; covers: string[] }>;
  text: string };
type ContextDiff = {base:{id:string;knowledgeVersion:string}|null;target:{id:string;knowledgeVersion:string};modelFamily:string|null;
  summary?:{added:number;removed:number;changed:number};stages:Array<{stageId:string;status:string;items:Array<{id:string;status:string;
    before:{selected:boolean;reason:string;sha256:string|null;content:string}|null;
    after:{selected:boolean;reason:string;sha256:string|null;content:string}|null}>}>};
function ContextInspector({ workflowId }: { workflowId: string }) {
  const [family, setFamily] = useState("codex");
  const [previews, error] = useLoad<ContextPreview[]>("workflow.context.preview", 0, [], { id: workflowId, modelFamily: family });
  const [telemetry] = useLoad<{groups:Array<{knowledgeVersion:string;modelFamily:string;stageId:string;itemId:string;
    runs:number;firstPassRate:number|null;secondPassRate:number|null}>;diagnostics:Array<{kind:string;severity:"warning"|"critical";
    stageId:string;modelFamily:string;knowledgeVersion:string;itemIds:string[];baselineSamples:number;observedSamples:number;
    baselineRate:number;observedRate:number;delta:number;reason:string;causal:false}>}>("context.telemetry",0,{groups:[],diagnostics:[]},{workflowId});
  const [diff,diffError]=useLoad<ContextDiff>("workflow.context.diff",0,{base:null,target:{id:workflowId,knowledgeVersion:""},modelFamily:family,stages:[]},
    {id:workflowId,modelFamily:family});
  const rate=(value:number|null)=>value===null?"暂无":`${Math.round(value*100)}%`;
  return <Panel title="上下文计划">
    <div className="row"><div><b>Harness 实际注入预览</b><p className="muted">按持久项目事实、优先级、互斥、覆盖和预算编译；代理不能自行浏览知识目录。</p></div>
      <label>模型家族<select value={family} onChange={event => setFamily(event.target.value)}>
        <option value="codex">Codex</option><option value="claude">Claude</option><option value="dsh">DSH</option>
      </select></label></div>
    {error ? <div className="banner bad">{error}</div> : null}
    {previews.map(preview => <details className="technical-details" key={preview.stageId}>
      <summary>{stageLabel(preview.stageId)} · {preview.usedChars}/{preview.budgetChars} 字符 · 覆盖 {preview.coverage.join("、") || "未声明"}</summary>
      {preview.decisions.map(item => <div className="check-row" key={item.id}>
        <span className={`dot ${item.selected ? "ok" : "warn"}`} />
        <div><b>{item.selected ? "注入" : "跳过"} · {item.id}</b><p>{item.reason} · {item.chars} 字符{item.covers.length ? ` · ${item.covers.join("、")}` : ""}</p></div>
      </div>)}
      <details><summary>查看编译后的规范正文</summary><pre>{preview.text}</pre></details>
    </details>)}
    {diffError ? <div className="banner bad">上下文版本对比失败：{diffError}</div> : null}
    {diff.base ? <details className="technical-details"><summary>能力版本差异 · {diff.base.knowledgeVersion} → {diff.target.knowledgeVersion}</summary>
      <p className="muted">使用目标制作流程当前的同一份项目事实与模型家族进行隔离对比。新增 {diff.summary?.added??0}，删除 {diff.summary?.removed??0}，变化 {diff.summary?.changed??0}。</p>
      {diff.stages.filter(stage=>stage.status!=="unchanged").map(stage=><div key={stage.stageId}>
        <b>{stageLabel(stage.stageId)}</b>
        {stage.items.filter(item=>item.status!=="unchanged").map(item=><details key={item.id}>
          <summary>{item.id} · {contextChange(item.status)}</summary>
          <p className="muted">之前：{item.before ? `${item.before.selected?"注入":"跳过"}，${item.before.reason}`:"不存在"}<br/>
            现在：{item.after ? `${item.after.selected?"注入":"跳过"}，${item.after.reason}`:"不存在"}</p>
          {item.status==="content-changed"?<div className="two"><pre>{item.before?.content}</pre><pre>{item.after?.content}</pre></div>:null}
        </details>)}
      </div>)}
    </details>:<p className="muted">这是该项目第一个可对比的制作流程，还没有上一版上下文。</p>}
    {telemetry.groups.length ? <details className="technical-details"><summary>上下文效果遥测</summary>
      <p className="muted">仅供版本更新诊断；不会在客户端自动晋升能力包。</p>
      {telemetry.groups.map(group=><div className="check-row" key={`${group.knowledgeVersion}:${group.modelFamily}:${group.stageId}:${group.itemId}`}>
        <span className="dot ok"/><div><b>{group.itemId} · {group.modelFamily}</b><p>{stageLabel(group.stageId)} · 一次通过 {rate(group.firstPassRate)} · 二次内 {rate(group.secondPassRate)} · {group.runs} 次运行</p></div>
        <small>{group.knowledgeVersion}</small></div>)}
    </details>:null}
    {telemetry.diagnostics.length ? <details className="technical-details" open><summary>上下文可靠性告警 · {telemetry.diagnostics.length}</summary>
      <p className="muted">同阶段、同模型家族、至少五个一次尝试样本的相关性检测。告警不能证明因果，也不会触发客户端正式回退；应进入隔离复测和服务端版本更新流程。</p>
      {telemetry.diagnostics.map((item,index)=><div className="check-row" key={`${item.kind}:${item.knowledgeVersion}:${item.itemIds.join(":")}:${index}`}>
        <span className={`dot ${item.severity === "critical" ? "bad" : "warn"}`}/>
        <div><b>{item.kind === "version-degradation" ? "能力版本劣化" : item.kind === "suspected-conflict" ? "疑似上下文冲突" : "疑似上下文污染"} · {item.modelFamily}</b>
          <p>{item.reason} · {Math.round(item.baselineRate*100)}% → {Math.round(item.observedRate*100)}% · 基线 {item.baselineSamples} / 观察 {item.observedSamples}</p></div>
        <small>{stageLabel(item.stageId)}</small></div>)}
    </details>:null}
    {!previews.length && !error ? <Empty text="当前制作流程没有声明阶段上下文" /> : null}
  </Panel>;
}
