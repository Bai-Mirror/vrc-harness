import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  call,
  events,
  type Asset,
  type AvatarRoot,
  type EventRow,
  type Gate,
  type Project,
  type ProjectBrief,
  type ProjectMessage,
  type ProjectVariant,
  type Task,
  type Workflow,
} from "./api";
import {
  actionText, artifactLabel, gateText, taskState, assetKind, assetRole, assetState, authoringState, briefState, candidateSource, candidateState,
  contextChange, contributionState, doctorState, messageState, nextText, observerLabel, onMissingLabel, packChannel,
  profileTitle, providerLoginName, providerStates, providerType, readableReason, reasonsText, recoveryState, rootRole, schedulerState,
  severityLabel, sourceKind, stageLabel, stageState, takeoverMode, trialState, variantState, verdictState, when,
  workflowState,
} from "./labels";
import { GateCard, NextBar, useResume } from "./decide";
import { ProjectWorkspace, type Decisions, type ProjectTab } from "./project";
import { RestoreDrawer } from "./share";
import {
  boothLine, cardMeta, cardNext, cardProgress, dependencyState, errorText, filterProjects, groupEvents, homeNext, inProgress, isOpenGate,
  firstRunBlockers, materializeBlocker, placeholder, placeholderColors, PROJECT_FILTERS, projectForGate, projectState, projectWorkspaceGates, readinessRows, schedulerControl, taskLine,
  type ProjectFilter,
} from "./model";
import { chosenItems, DEFAULT_SETUP_CHOICES, dependencyGroups, setupButton, setupStepState, sizeText, type SetupChoices } from "./model";
import { importSourceLabel, IMPORT_FILTERS, recentProjects, unityEditorFilters, unityEditorNote } from "./model";
import { Drawer, Empty, FeedbackProvider, Field, MenuButton, Panel, reveal, Shell, Stat, Status, TopBar, useAction, useFeedback, useLoad } from "./ui";
import { PathField, PathList } from "./paths";
import { onWindows } from "./picker";
// The Claude credential component was removed with the rest of the subscription entry: this version's interface
// configures DeepSeek through pi only, and a key field for another vendor would describe a path the build lacks
// (决定记录 D-34, 版本与发布范围 D-7/D-8). The Runtime still runs a claude-cli provider an existing configuration names.
import { NO_PI, piChoicesFrom, piSecretFor, piStateFrom, type PiProviderView, type PiState, type PiUpstream } from "./model";
import { PiChoices } from "./pi";
import "./style.css";
import "./setup.css";

// Development builds name every value that reaches the screen without words, instead of showing it raw silently.
if (import.meta.env.DEV) onMissingLabel((vocabulary, key) => console.warn(`[labels] ${vocabulary} 缺少文案：${key}`));

type Page = "home" | "projects" | "assets" | "activity" | "core" | "settings";
type BoothFile = { downloadableId:string; filename:string; byteSize:number|null; status:string; materialized:boolean; path?:string };
type BoothItem = { itemId:string; name:string; shopName:string; itemUrl:string; category:string; owned:boolean; status:string;
  tags:string[]; images:string[]; fileCount:number; materializedCount:number; files:BoothFile[] };
type BoothJob = { kind:"sync"|"materialize";startedAt:string;progress?:{phase:"library"|"items";pages:number;items:number;itemsTotal:number;requests:number} };
type BoothOutcome = { kind:"sync"|"materialize";ok:boolean;message:string;finishedAt:string };
type BoothStatus = { connected:boolean;items:number;owned:number;files:number;materialized:number;job?:BoothJob|null;last?:BoothOutcome|null };
/** BOOTH jobs run in the Runtime for minutes; follow one through booth.status until it ends. */
async function followBooth(show:(text:string)=>void):Promise<BoothOutcome>{
  for(;;){
    await new Promise(resolve=>setTimeout(resolve,2000));
    const status=await call<BoothStatus>("booth.status");
    if(!status.job)return status.last??{kind:"sync",ok:false,message:"BOOTH 操作已结束，但 Runtime 没有给出结果（可能重启过）",finishedAt:""};
    const p=status.job.progress;
    show(status.job.kind==="materialize"?"正在按需获取所选文件…":!p?"正在同步商品与文件元数据…":p.phase==="library"
      ?`正在读取 BOOTH 素材库：第 ${p.pages} 页`:`正在同步：${p.items}/${p.itemsTotal} 个商品，已发 ${p.requests} 次请求（每秒最多 1 次）`);
  }
}
async function desktopInvoke<T>(command:string):Promise<T>{
  const internal=(window as unknown as {__TAURI_INTERNALS__?:{invoke:<R>(command:string)=>Promise<R>}}).__TAURI_INTERNALS__;
  if(!internal)throw new Error("内建 BOOTH 登录只在桌面版可用");return internal.invoke<T>(command);
}
/** Navigation icons: one line family drawn for Harness, 18px, stroke 1.75, in the text colour. */
const ICONS: Record<Page, React.ReactNode> = {
  home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h5v-6h4v6h5V9.5" /></>,
  projects: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />,
  assets: <><path d="M12 3 20.5 7.5v9L12 21l-8.5-4.5v-9z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>,
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  core: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
};
const Icon = ({ page }: { page: Page }) => (
  <svg className="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.75"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[page]}</svg>
);
/** The daily pages (design 26 §4.1); 核心管理 has its own clearly named entry under 管理. */
const NAV: Array<[Page, string]> = [["home", "首页"], ["projects", "项目"], ["assets", "素材"], ["activity", "活动"], ["settings", "设置"]];

type SetupState = {
  configured: boolean;
  home: string;
  /** Why the existing configuration does not load; the GUI then offers a backup or a fresh first run. */
  broken?: string;
  backups?: string[];
  defaults: { workspaceRoot: string; exportRoot: string; assetLibraryRoot: string; templateProject: string; unityEditor?: string;
    /** Every Unity editor found on this computer, offered as choices; the first is preselected. */
    unityEditors?: string[];
    managedPack: { id: string; version: string; description: string } | null };
  environment: Array<{
    name: string;
    ok: boolean;
    detail: string;
    required: boolean;
  }>;
};
function Root() {
  const [setup, setSetup] = useState<SetupState>();
  const [entry, setEntry] = useState<{ page: Page; anchor?: string }>();
  const [error, setError] = useState("");
  const load = () => {
    call<SetupState>("setup.status")
      .then(setSetup)
      .catch((e) => setError(e.message));
  };
  useEffect(load, []);
  if (error)
    return (
      <div className="setup">
        <div className="banner bad">{error}</div>
      </div>
    );
  if (!setup)
    return (
      <div className="setup">
        <h1>Harness</h1>
        <p>正在检查本机环境…</p>
      </div>
    );
  if (setup.broken) return <Recovery state={setup} done={load} />;
  return setup.configured ? (
    <App initial={entry} />
  ) : (
    <Setup state={setup} done={(page, anchor) => { setEntry({ page, anchor }); setSetup({ ...setup, configured: true }); }} />
  );
}
/** The configuration no longer loads: say why, and offer the newest backup that loads or a fresh first run. */
function Recovery({ state, done }: { state: SetupState; done: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(method: string) {
    setBusy(true); setError("");
    try { await call(method); done(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="setup">
      <div className="setup-card">
        <img className="setup-logo" src="/harness-logo.png" alt="Harness" />
        <span className="eyebrow">配置无法加载</span>
        <h1>Harness 没能读取当前配置</h1>
        <div className="banner bad">{state.broken}</div>
        <p>配置文件在 <code>{state.home}/config/harness.yaml</code>。可以恢复最近一份能正常加载的备份，也可以把当前配置移到一边、重新做一次首次配置；原文件都会保留，不会删除。</p>
        {error ? <div className="banner bad">{error}</div> : null}
        <div className="actions">
          <button className="primary" disabled={busy || !state.backups?.length} onClick={() => run("setup.config.restore")}>
            {state.backups?.length ? `恢复最近的可用备份（共 ${state.backups.length} 份）` : "没有可用的备份"}
          </button>
          <button disabled={busy} onClick={() => run("setup.config.reset")}>移开当前配置，重新首次配置</button>
        </div>
      </div>
    </div>
  );
}
const SETUP_STEPS = ["欢迎与环境检查", "AI 来源", "目录", "就绪"];
/**
 * First run as four short steps with a way back: the environment (installing what is missing), the AI executors,
 * where projects and deliveries live, and a ready page that leads to the first real task.
 */
function Setup({ state, done }: { state: SetupState; done: (page: Page, anchor?: string) => void }) {
  const [step, setStep] = useState(0);
  const [workspaceRoot, setWorkspace] = useState(state.defaults.workspaceRoot);
  const [exportRoot, setExport] = useState(state.defaults.exportRoot);
  const [templateProject, setTemplateProject] = useState(state.defaults.templateProject);
  const [contributorName, setContributorName] = useState("");
  const [unityEditor, setUnityEditor] = useState(state.defaults.unityEditor ?? "");
  // Editors found on this computer, offered first; one that step 0 installs or finds joins them.
  const [unityEditors, setUnityEditors] = useState<string[]>(state.defaults.unityEditors ?? (state.defaults.unityEditor ? [state.defaults.unityEditor] : []));
  const [dependencies, setDependencies] = useState<DependencyItem[] | null>(null);
  const [pi, setPi] = useState<PiState>(NO_PI);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The newest check wins: installing a dependency here clears its block without reloading the page.
  const missing = dependencies ? firstRunBlockers(dependencies) : state.environment.filter((x) => x.required && !x.ok).map((x) => x.name);
  const blocker = !state.defaults.managedPack ? "安装包缺少托管规则包，请重新安装 Harness"
    : missing.length ? `缺少必需依赖：${missing.join("、")}` : "";
  async function submit() {
    setBusy(true);
    setError("");
    try {
      // Only the pi services are written here. Codex and Claude Code are not offered by this wizard, and detecting
      // their CLIs must not quietly arm a provider the interface never showed or credentialed (决定记录 D-34).
      await call("setup.initialize", { workspaceRoot, exportRoot, templateProject, contributorName, unityEditor,
        pi: piChoicesFrom(pi) });
      setStep(3);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="setup">
      <div className="setup-card">
        <img className="setup-logo" src="/harness-logo.png" alt="Harness" />
        <ol className="steps" aria-label="首次设置步骤">
          {SETUP_STEPS.map((label, index) => (
            <li key={label} className={index === step ? "current" : index < step ? "done" : ""} aria-current={index === step ? "step" : undefined}>
              <span>{index < step ? "✓" : index + 1}</span>{label}
            </li>
          ))}
        </ol>
        {step === 0 ? <>
          <h1>欢迎使用 Harness</h1>
          <p>先检查这台电脑是否具备制作头像需要的工具；Harness 能自动安装的会一起装好。配置只保存在 <code>{state.home}</code>，不会上传。</p>
          {state.defaults.managedPack
            ? <div className="detected">✓ 已携带制作规则与执行工具 · {state.defaults.managedPack.version}</div>
            : <div className="banner bad">安装包缺少托管规则包，请重新安装。</div>}
          <DependencyPanel onReport={(report) => {
            setDependencies(report.dependencies);
            // An editor installed or found here is the one setup saves, unless the person chose another.
            const found = report.unityEditor;
            if (found) {
              setUnityEditor((current) => current || found);
              setUnityEditors((list) => list.includes(found) ? list : [...list, found]);
            }
          }} />
          <div className="actions setup-nav">
            {blocker ? <small className="reason">{blocker}</small> : null}
            <button className="primary" disabled={Boolean(blocker)} onClick={() => setStep(1)}>下一步</button>
          </div>
        </> : null}
        {step === 1 ? <>
          <h1>选择 AI 执行方</h1>
          <p>Harness 用你自己的 DeepSeek API 密钥制作头像：按实际用量计费，额度来自你自己的账号。可以留空，但在配好密钥之前制作流程不能开始。</p>
          {/* The read/network boundary as it actually is (决定记录 D-111): the sandbox stops writes, not reads or
              network. Saying it here, before the key is entered, keeps the promise from outrunning the mechanism. */}
          <div className="banner warn">执行方（AI）运行时能读取你电脑上的文件，也能联网；Harness 只阻止它写工作区以外的位置。请不要把与制作无关的敏感文件放进会被处理的素材里。</div>
          <div className="choice-list">
            <PiChoices state={pi} onChange={setPi} layout="setup"
              piMissing={dependencies?.some((item) => item.id === "pi" && !item.ok)} />
          </div>
          {/* What this version reaches and when the rest arrives. The sentence deliberately does not mention entering
              another vendor's key at all: naming a field that does not exist is what made the previous copy read as an
              invitation (版本与发布范围 D-7/D-8; subscription sign-in is not an execution route, 决定记录 D-34). */}
          <div className="banner">
            这个版本只接入 DeepSeek API。Codex 与 Claude Code 的订阅登录<b>即将支持</b>（dev.1.1），
            届时才会出现对应的接入方式。
          </div>
          {/* The billing terms as they actually are: the person's own key, their own quota, and no cap Harness imposes
              (决定记录 D-50). A cap field would be a control that changes nothing. */}
          <div className="detected">
            <b>费用怎么算</b>
            <small>用你自己的密钥、按实际用量计费；Harness 不设消费上限，也不代管额度（决定记录/D-50）。返工、改脸后的整链重跑会再次计费。</small>
          </div>
          {!pi.deepseek ? <div className="banner warn">不选也可以完成设置，但在配好 DeepSeek API 密钥之前，制作流程不能开始。</div> : null}
          <div className="actions setup-nav">
            <button onClick={() => setStep(0)}>上一步</button>
            <button className="primary" onClick={() => setStep(2)}>下一步</button>
          </div>
        </> : null}
        {step === 2 ? <>
          <h1>工程与成品放在哪里</h1>
          <p>新建和接管的 Unity 工程放在项目工作区，做好的头像交付到交付目录。已经填好了默认位置；想换就用选择窗口挑一个文件夹，窗口里也可以直接粘贴路径。目录不存在时会自动创建。</p>
          <div className="setup-grid">
            <PathField label="项目工作区" hint="新建和接管的 Unity 工程所在目录" value={workspaceRoot} onChange={setWorkspace}
              defaultValue={state.defaults.workspaceRoot} pick={{ kind: "directory", title: "选择项目工作区" }} />
            <PathField label="交付目录" hint="整理好的交付包放在这里；不能放在项目工作区里面" value={exportRoot} onChange={setExport}
              defaultValue={state.defaults.exportRoot} pick={{ kind: "directory", title: "选择交付目录" }} />
          </div>
          <div className="detected">
            <b>BOOTH 素材：用到时再获取</b>
            <small>不需要先建本地素材库；Harness 只为当前项目获取选中的文件。本地零散素材之后可以单独登记。</small>
          </div>
          <details className="setup-advanced">
            <summary>高级（都可以暂不设置，之后在设置里改）{unityEditor ? "" : " · 还没有选 Unity 编辑器"}</summary>
            <div className="setup-grid">
              <PathField label="Unity 编辑器" hint="VRChat 头像用 Unity 2022.3.22f1。暂不设置时，含 Unity 步骤的流程会在开始时说明缺什么。"
                value={unityEditor} onChange={setUnityEditor} detected={unityEditors} note={unityEditorNote} optional="暂不设置"
                empty="没有在这台电脑上找到 Unity 编辑器" pick={{ kind: "file", title: "选择 Unity 编辑器", filters: unityEditorFilters(onWindows()) }} />
              <PathField label="自定义工程模板（高级）" hint="默认由 Harness 获取固定版本的官方环境，无需提供模板。选择自定义模板时会先检查版本与依赖。"
                value={templateProject} onChange={setTemplateProject} optional="使用自动准备" empty="由 Harness 自动准备"
                pick={{ kind: "directory", title: "选择 Unity 基准工程" }} />
              <label>贡献者用户名<input value={contributorName} maxLength={64} onChange={(e) => setContributorName(e.target.value)} />
                <small>本地保存；默认技术报告不附带署名</small></label>
            </div>
          </details>
          {error ? <div className="banner bad">{error}</div> : null}
          <div className="actions setup-nav">
            <button disabled={busy} onClick={() => setStep(1)}>上一步</button>
            <button className="primary" disabled={busy || Boolean(blocker)} onClick={submit}>{busy ? "正在验证并启动…" : "完成设置"}</button>
          </div>
        </> : null}
        {step === 3 ? <>
          <h1>Harness 已就绪</h1>
          <p>从下面任选一项开始。之后随时可以在「设置」里修改目录、AI 和工具。</p>
          {/* The three capabilities are reported apart, each with its own reason: management needs neither AI nor
              Unity; production needs a configured AI route; previews are rendered by Unity (01 §首次启动四步; D-19). */}
          <ul className="checklist">
            {readinessRows({ blockers: missing, ai: pi.deepseek || pi.glm, unity: Boolean(unityEditor) }).map((row) =>
              <li key={row.label} className={row.available ? "done" : "optional"}>
                <span aria-hidden="true">{row.available ? "✓" : "·"}</span><b>{row.line}</b>
              </li>)}
          </ul>
          <div className="quick">
            <button className="primary" onClick={() => done("projects", "new")}>新建项目<small>描述想要的头像，或从素材库挑选</small></button>
            <button onClick={() => done("projects", "import")}>接管已有工程<small>先做只读的健康检查</small></button>
            <button onClick={() => done("assets")}>导入素材<small>连接 BOOTH 或登记本地文件</small></button>
          </div>
        </> : null}
      </div>
    </div>
  );
}

type Nav = {
  go: (page: Page, anchor?: string) => void;
  /** Open a project, optionally on a tab and with a change request already started. */
  open: (id: string, tab?: ProjectTab, draft?: string) => void;
};

function App({ initial }: { initial?: { page: Page; anchor?: string } }) {
  const feedback = useFeedback();
  const [page, setPage] = useState<Page>(initial?.page ?? "home");
  // Where to land on the page; seq changes on every navigation, so going to the same place twice acts twice.
  const [target, setTarget] = useState<{ anchor?: string; seq: number }>({ anchor: initial?.anchor, seq: 0 });
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<{ id: string; tab?: ProjectTab; draft?: string }>();
  // Decisions put off with "暂不执行" stay counted on the home page, but their cards stay closed for this session.
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [projects, projectError] = useLoad<Project[]>("project.list", refresh, []);
  const [gates] = useLoad<Gate[]>("gate.list", refresh, []);
  const [tasks] = useLoad<Task[]>("task.list", refresh, []);
  const [activity] = useLoad<EventRow[]>("events.recent", refresh, []);
  const [status, statusError] = useLoad<Record<string, any>>("service.status", refresh, {});
  const [sharing] = useLoad<{ needsNotice: boolean } | null>("sharing.state", refresh, null);
  const noticeOpened = useRef(false);
  useEffect(() => {
    if (!sharing?.needsNotice || noticeOpened.current) return;
    noticeOpened.current = true;
    void (async () => {
      try {
        const notice = await call<{ title: string; summary: string; shared: string[]; never: string[]; retention: string; stop: string }>("sharing.notice");
        const decision = await feedback.dialog({ title: notice.title, body: <div className="dialog-body">
          <p>{notice.summary}</p>
          <p><b>发送</b>：工具可靠性、公开素材的兼容与修复、公开素材分类。</p>
          <details><summary>查看各类记录包含什么</summary><ul>{notice.shared.map(item => <li key={item}>{item}</li>)}</ul></details>
          <p><b>不会发送</b>：{notice.never.join("、")}。</p><p>{notice.retention}</p><p>{notice.stop}</p>
        </div>, actions: [{ key: "on", label: "加入技术协作", tone: "primary" }, { key: "off", label: "关闭回传" }] });
        if (decision) { await call("sharing.choose", { noticeShown: true, enabled: decision.key === "on" }); changed(); }
      } catch (error) { feedback.error(error); }
    })();
  }, [sharing?.needsNotice]);
  useEffect(() => events(() => setRefresh((x) => x + 1)), []);
  const changed = () => setRefresh((x) => x + 1);
  const nav: Nav = {
    go: (next, anchor) => { setSelected(undefined); setPage(next); setTarget((current) => ({ anchor, seq: current.seq + 1 })); },
    open: (id, tab, draft) => setSelected({ id, tab, draft }),
  };
  const decisions: Decisions = {
    dismissed,
    dismiss: (gate) => setDismissed((items) => [...new Set([...items, gate.gate])]),
    restore: () => setDismissed([]),
    requestChange: (gate) => {
      const project = projectForGate(projects, gate);
      if (project) nav.open(project.id, "requests", `关于「${gateText(gate).title}」：`);
    },
  };
  const scheduler: string | undefined = status.scheduler?.state;
  const running = scheduler === "running";
  const needs = gates.filter(isOpenGate).length + tasks.filter((x) => x.needsYou).length;
  const project = projects.find((x) => x.id === selected?.id);
  // By latest activity, for the navigation and the home page (events.recent is the only source of recency).
  const recent = recentProjects(projects, activity, tasks);
  const navigation = <NavShell page={page} projectId={project?.id} projects={recent} gates={gates} needs={needs} scheduler={scheduler}
    go={nav.go} open={(id) => nav.open(id)} />;
  if (project)
    return (
      <ProjectWorkspace
        key={`${project.id}:${selected?.tab ?? ""}:${selected?.draft ?? ""}`}
        project={project}
        initialTab={selected?.tab}
        draft={selected?.draft}
        gates={projectWorkspaceGates(gates, project)}
        scheduler={scheduler}
        decisions={decisions}
        nav={navigation}
        onBack={() => nav.go("projects")}
        refresh={refresh}
        changed={changed}
        connectionError={statusError}
      />
    );
  return (
    <Shell nav={navigation}>
      <PageTop page={page} onNew={() => nav.go("projects", "new")} />
      {projectError ? <div className="banner bad">{projectError}</div> : null}
      {page === "home" ? (
        <Home projects={recent} gates={gates} tasks={tasks} scheduler={scheduler} nav={nav} decisions={decisions} changed={changed} refresh={refresh} />
      ) : null}
      {page === "projects" ? (
        <Projects projects={projects} gates={gates} running={running} anchor={target.anchor} anchorSeq={target.seq} open={(id, tab) => nav.open(id, tab)} changed={changed} />
      ) : null}
      {page === "assets" ? <Assets projects={projects} refresh={refresh} changed={changed} /> : null}
      {page === "activity" ? <Activity events={activity} tasks={tasks} gates={gates} projects={projects} nav={nav} changed={changed} /> : null}
      {page === "core" ? <Core status={status} /> : null}
      {page === "settings" ? <Settings status={status} refresh={refresh} anchor={target.anchor} anchorSeq={target.seq} changed={changed} /> : null}
    </Shell>
  );
}

/**
 * The frosted navigation beside every page and project: the daily pages, the projects by latest activity (the open one
 * marked), and under 管理 the 核心管理 entry and the background service's state.
 */
function NavShell({ page, projectId, projects, gates, needs, scheduler, go, open }: {
  page: Page; projectId?: string; projects: Project[]; gates: Gate[]; needs: number; scheduler?: string;
  go: (page: Page, anchor?: string) => void; open: (id: string) => void;
}) {
  const running = scheduler === "running";
  const shown = projects.slice(0, 6);
  // Inside a project, 项目 is where the person is.
  const here = projectId ? "projects" : page;
  return (
    <nav className="nav-shell" aria-label="主导航">
      <div className="brand">
        <img className="mark" src="/harness-logo.png" alt="" />
        <div><b>Harness</b><small>头像工作台</small></div>
      </div>
      <div className="nav-list">
        {NAV.map(([id, label]) => (
          <button key={id} data-nav={id} className={here === id ? "active" : ""} aria-current={here === id && !projectId ? "page" : undefined}
            onClick={() => go(id)}>
            <Icon page={id} />{label}
            {id === "home" && needs > 0 ? <em aria-label={`${needs} 项需要你处理`}>{needs}</em> : null}
          </button>
        ))}
      </div>
      {shown.length ? (
        <div className="nav-projects">
          <div className="nav-heading"><span>最近的项目</span>
            {projects.length > shown.length ? <button className="link" onClick={() => go("projects")}>全部 {projects.length} 个</button> : null}</div>
          {shown.map((item) => {
            const cover = placeholder(item.name);
            return (
              <button key={item.id} className={`nav-project${item.id === projectId ? " active" : ""}`} aria-current={item.id === projectId ? "page" : undefined}
                onClick={() => open(item.id)} title={item.name}>
                <span className="cover cover-dot" style={placeholderColors(cover.hue) as React.CSSProperties} aria-hidden="true">{Array.from(cover.text)[0]}</span>
                <span><b>{item.name}</b><small>{projectState(item, gates)[0]}</small></span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="nav-foot">
        <span className="nav-heading">管理</span>
        <button data-nav="core" className={page === "core" && !projectId ? "active" : ""} aria-current={page === "core" && !projectId ? "page" : undefined}
          onClick={() => go("core")}><Icon page="core" />核心管理</button>
        <button className="runtime" onClick={() => go("settings", "service")} title="查看后台服务">
          <i className={running ? "online" : scheduler ? "paused" : ""} />
          <span>
            <b>{!scheduler ? "正在连接后台" : running ? "后台正在工作" : "后台已暂停"}</b>
            <small>{running || !scheduler ? "查看" : "查看并继续运行"}</small>
          </span>
        </button>
      </div>
    </nav>
  );
}

const PAGE_TITLES: Record<Page, [string, string]> = {
  home: ["今天", "需要你决定的事和最近的项目"], projects: ["项目", "每个头像目标一个项目"],
  assets: ["素材", "BOOTH 已购素材与本地素材"], activity: ["活动", "后台在做什么、在等什么"],
  core: ["核心管理", "AI 执行方、制作规则版本与候选能力包"], settings: ["设置", "连接、目录与运行状态"],
};
function PageTop({ page, onNew }: { page: Page; onNew: () => void }) {
  const [title, subtitle] = PAGE_TITLES[page];
  // Creating a project belongs where projects and materials are; it is the primary action only on the projects page.
  const creates = page === "home" || page === "projects" || page === "assets";
  return (
    <TopBar actions={creates ? <button className={page === "projects" ? "primary" : ""} onClick={onNew}>＋ 新建项目</button> : undefined}>
      <div><h1>{title}</h1><p>{subtitle}</p></div>
    </TopBar>
  );
}

function Home({ projects, gates, tasks, scheduler, nav, decisions, changed, refresh }: {
  projects: Project[]; gates: Gate[]; tasks: Task[]; scheduler?: string; nav: Nav; decisions: Decisions; changed: () => void;refresh:number;
}) {
  const open = gates.filter(isOpenGate);
  const shown = open.filter((gate) => !decisions.dismissed.includes(gate.gate));
  const waiting = tasks.filter((x) => x.needsYou);
  const { resuming, resume } = useResume(changed);
  const next = homeNext({ gates, tasks, projects, scheduler });
  const recent = inProgress(projects)[0];
  const first = () => {
    const target = document.querySelector<HTMLElement>("#needs .gate-card, #needs .row");
    reveal(target);
    target?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  };
  return (
    <section className="content">
      <NextBar view={next} busy={resuming} onResume={resume} onAction={(kind) => (kind === "resume" ? resume() : first())} />
      {open.length || waiting.length ? (
        <section className="section" id="needs">
          <div className="section-title"><h2>需要你处理</h2>
            {open.length > shown.length ? <button className="link" onClick={decisions.restore}>显示已暂缓的 {open.length - shown.length} 项</button> : null}
          </div>
          <div className="stack-list">
            {shown.map((gate) => (
              <GateCard key={gate.gate} gate={gate} showProject changed={changed} refresh={refresh}
                onRequestChange={decisions.requestChange} onDismiss={decisions.dismiss} />
            ))}
            {waiting.length ? (
              <div className="panel">
                {waiting.map((t) => (
                  <div className="row" key={t.id}>
                    <div><b>{t.projectName}</b><p>{taskLine(t)}</p></div>
                    <Status state={taskState(t.status)} />
                    <button onClick={() => { const p = projects.find((p) => p.name === t.projectName); if (p) nav.open(p.id, "monitor"); }}>查看项目</button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      <section className="section">
        <div className="section-title">
          <h2>最近的项目<small>按最近的活动排列</small></h2>
          <button className="link" onClick={() => nav.go("projects")}>查看全部</button>
        </div>
        {projects.length ? (
          <div className="cards">
            {projects.slice(0, 6).map((p) => (
              <ProjectCard key={p.id} project={p} gates={gates} running={scheduler === "running"} open={() => nav.open(p.id)} />
            ))}
          </div>
        ) : (
          <div className="panel"><Empty text="还没有项目。" action={<button className="link" onClick={() => nav.go("projects", "new")}>新建项目</button>} /></div>
        )}
      </section>
      <section className="section">
        <div className="section-title"><h2>快速开始</h2></div>
        <div className="quick">
          <button onClick={() => nav.go("projects", "new")}>新建项目<small>描述想要的头像，或从素材库挑选</small></button>
          <button onClick={() => nav.go("projects", "import")}>接管已有工程<small>先做只读的健康检查</small></button>
          <button onClick={() => nav.go("assets")}>导入素材<small>BOOTH 已购素材或本地文件</small></button>
          <button onClick={() => nav.go("settings", "ai")}>配置 AI<small>填写 API 密钥并选择模型</small></button>
          {recent ? <button onClick={() => nav.open(recent.id, "monitor")}>查看「{recent.name}」<small>最近在做的项目：进度与检查</small></button> : null}
        </div>
      </section>
    </section>
  );
}
function ProjectCard({ project, gates, running, open }: { project: Project; gates: Gate[]; running: boolean; open: () => void }) {
  const feedback = useFeedback();
  const state = projectState(project, gates);
  const cover = placeholder(project.name);
  const progress = cardProgress(project);
  const unavailable = "Runtime 尚未提供这项操作";
  return (
    <article className="project-card" role="link" tabIndex={0} aria-label={`打开项目 ${project.name}`} onClick={open}
      onKeyDown={(event) => { if (event.key === "Enter") open(); }}>
      <div className="preview cover" style={placeholderColors(cover.hue) as React.CSSProperties}>
        <span>{cover.text}</span>
        <small>暂无预览 · 首次构建后生成</small>
      </div>
      <div className="card-body">
        <div className="card-head">
          <h3 title={project.name}>{project.name}</h3>
          <Status state={state} />
          <MenuButton label={`${project.name} 的更多操作`} items={[
            { label: "打开项目", onSelect: open },
            { label: "复制工程路径", onSelect: () => void navigator.clipboard.writeText(project.path)
              .then(() => feedback.ok("工程路径已复制"), feedback.error) },
            { label: "打开 Unity", hint: "由制作任务按隔离规则启动，避免误改正在制作的工程" },
            { label: "重命名", hint: unavailable },
            { label: "归档", hint: unavailable },
            { label: "移除登记", hint: unavailable },
          ]} />
        </div>
        <p>{cardNext(project, running)}</p>
        {progress === null ? null : <div className="progress" title={`已通过 ${Math.round(progress * 100)}% 的阶段`}><i style={{ width: `${progress * 100}%` }} /></div>}
        <small>{cardMeta(project)}</small>
      </div>
    </article>
  );
}

function Projects({ projects, gates, running, anchor, anchorSeq, open, changed }: {
  projects: Project[]; gates: Gate[]; running: boolean; anchor?: string; anchorSeq?: number;
  open: (id: string, tab?: ProjectTab) => void; changed: () => void;
}) {
  const [drawer, setDrawer] = useState<"" | "new" | "import" | "restore">(anchor === "new" || anchor === "import" ? anchor : "");
  useEffect(() => { if (anchor === "new" || anchor === "import") setDrawer(anchor); }, [anchor, anchorSeq]);
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [query, setQuery] = useState("");
  const shown = filterProjects(projects, gates, filter, query);
  return (
    <section className="content">
      <div className="toolbar">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索项目名称、素体或路径" aria-label="搜索项目" />
        <div className="segmented" role="tablist" aria-label="筛选项目">
          {PROJECT_FILTERS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <button onClick={() => setDrawer("restore")}>从分享包恢复</button>
        <button onClick={() => setDrawer("import")}>接管已有工程</button>
      </div>
      {shown.length ? (
        <div className="cards large">
          {shown.map((p) => <ProjectCard key={p.id} project={p} gates={gates} running={running} open={() => open(p.id)} />)}
        </div>
      ) : (
        <div className="panel">
          <Empty text={projects.length ? "没有符合条件的项目。" : "还没有项目。新建一个头像项目，或接管已有的 Unity 工程。"}
            action={projects.length ? <button className="link" onClick={() => { setFilter("all"); setQuery(""); }}>显示全部项目</button>
              : <button className="link" onClick={() => setDrawer("new")}>新建项目</button>} />
        </div>
      )}
      {drawer === "new" ? <NewProject close={() => setDrawer("")} created={(id) => { changed(); open(id, "design"); }} /> : null}
      {drawer === "import" ? <TakeOver close={() => setDrawer("")} imported={(id) => { changed(); open(id, "monitor"); }} /> : null}
      {drawer === "restore" ? <RestoreDrawer close={() => { setDrawer(""); changed(); }} restored={(id) => { setDrawer(""); changed(); open(id, "monitor"); }} /> : null}
    </section>
  );
}

/** A new avatar project: its goal, then straight into the project (creating it does not approve or start anything). */
function NewProject({ close, created }: { close: () => void; created: (id: string) => void }) {
  const [mode, setMode] = useState<"conversation" | "selection">("conversation");
  const [name, setName] = useState("");
  const [request, setRequest] = useState("");
  const [faceConcept, setFaceConcept] = useState("");
  const [assetQuery, setAssetQuery] = useState("");
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [assets] = useLoad<Asset[]>("asset.list", 0, []);
  const { busy, run } = useAction();
  const create = () => run("create", async () => {
    const project = await call<{ id: string }>("project.create", { name: name.trim(), mode, request: request.trim(),
      faceConcept: faceConcept.trim(), assetIds: selectedAssets });
    close();
    created(project.id);
  }, "项目已创建");
  const picks = assets.filter((a) => `${a.name} ${a.kind} ${a.tags.join(" ")} ${a.path}`.toLowerCase().includes(assetQuery.toLowerCase()));
  return (
    <Drawer title="新建头像项目" onClose={close} footer={<>
      <small className="reason">{name.trim() ? "创建只保存制作目标，不等于批准审美方向或开始制作。" : "先填写项目名称"}</small>
      <button onClick={close}>取消</button>
      <button className="primary" disabled={!name.trim() || busy === "create"} onClick={create}>{busy === "create" ? "正在创建…" : "创建并进入项目"}</button>
    </>}>
      <p className="muted">一个头像目标一个项目。共同脸部设定和衣装方案会在项目里继续细化。</p>
      <div className="segmented" role="tablist" aria-label="建立方式">
        <button role="tab" aria-selected={mode === "conversation"} className={mode === "conversation" ? "active" : ""} onClick={() => setMode("conversation")}>描述需求</button>
        <button role="tab" aria-selected={mode === "selection"} className={mode === "selection" ? "active" : ""} onClick={() => setMode("selection")}>从素材库挑选</button>
      </div>
      <label className="stack">项目名称<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="角色名 / 捏脸想法 / 制作目标" /></label>
      <label className="stack">共同脸部设定<input value={faceConcept} onChange={(e) => setFaceConcept(e.target.value)} placeholder="这个头像所有衣装共享的脸部设定" /></label>
      <label className="stack">头像需求<textarea value={request} onChange={(e) => setRequest(e.target.value)}
        placeholder={mode === "conversation" ? "描述想要的风格、用途、衣装数量、插件与禁忌；也可以粘贴已有讨论…" : "补充素材选单没有覆盖的要求…"} /></label>
      {mode === "selection" ? (
        <div className="catalog-picker">
          <div className="toolbar"><input value={assetQuery} onChange={(e) => setAssetQuery(e.target.value)} placeholder="搜索名称、类型、标签或路径" /><small>已选 {selectedAssets.length} 项</small></div>
          <div className="asset-picks">
            {picks.map((a) => (
              <button key={a.id} className={selectedAssets.includes(a.id) ? "selected" : ""} aria-pressed={selectedAssets.includes(a.id)}
                onClick={() => setSelectedAssets((xs) => (xs.includes(a.id) ? xs.filter((id) => id !== a.id) : [...xs, a.id]))}>
                <b>{a.name}</b><small>{assetKind(a.kind)} · {assetState(a.status)[0]}</small><em>{a.tags.join(" / ") || "无标签"}</em>
              </button>
            ))}
          </div>
          {!assets.length ? <Empty text="素材库是空的；可以先建项目，之后再补充素材。" /> : null}
        </div>
      ) : null}
    </Drawer>
  );
}

/**
 * Take over an existing project: a safe import, then an AI analysis the person reviews before anything changes. The source is
 * chosen with the system picker (a folder, or an archive or .unitypackage), never typed.
 */
function TakeOver({ close, imported }: { close: () => void; imported: (id: string) => void }) {
  const [source, setSource] = useState<{ path: string; kind: "directory" | "file" } | null>(null);
  const [mode, setMode] = useState<"observe" | "shallow" | "deep">("shallow");
  const [distill, setDistill] = useState(false);
  const { busy, run } = useAction();
  const start = () => run("import", async () => {
    if (!source) throw new Error("先选择要接管的工程");
    const result = await call<{ projectId: string }>("project.import", { path: source.path, mode, distill }, 600_000);
    close();
    imported(result.projectId);
  }, "已安全导入，AI 分析任务已建立");
  return (
    <Drawer title="接管已有工程" onClose={close} footer={<>
      <small className="reason">{source ? "导入先做只读的健康检查；改动要等分析通过后由你决定。" : "先选择工程文件夹、压缩包或 .unitypackage"}</small>
      <button onClick={close}>取消</button>
      <button className="primary" disabled={!source || busy === "import"} onClick={start}>{busy === "import" ? "正在导入…" : "安全导入并由 AI 分析"}</button>
    </>}>
      <PathField label="工程位置" hint="Unity 工程文件夹、工程压缩包（zip、7z、rar、tar、gz）或 .unitypackage。选择窗口里也可以直接粘贴路径。"
        value={source?.path ?? ""} onChange={(path, kind) => setSource(path ? { path, kind } : null)} empty="还没有选择工程"
        badge={source ? importSourceLabel(source.path, source.kind) : undefined}
        pick={{ kind: "directory", title: "选择要接管的 Unity 工程文件夹" }} pickText="选择工程文件夹…"
        also={{ label: "选择压缩包或 .unitypackage…", pick: { kind: "file", title: "选择要接管的工程压缩包或 Unity 包", filters: IMPORT_FILTERS } }} />
      <label className="stack">接手方式<select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
        <option value="observe">仅分析（不改动）</option><option value="shallow">浅接手（保留原做法）</option><option value="deep">深度改造（在隔离副本里进行）</option>
      </select></label>
      <label className="check-row-label"><input type="checkbox" checked={distill} onChange={(e) => setDistill(e.target.checked)} /> 提取可复用的做法（只生成本地候选，不会替换正式版本）</label>
    </Drawer>
  );
}
function Assets({
  projects,
  refresh,
  changed,
}: {
  projects: Project[];
  refresh: number;
  changed: () => void;
}) {
  const [assets, error] = useLoad<Asset[]>("asset.list", refresh, []);
  const [source,setSource]=useState<"booth"|"local">("booth");
  const [boothStatus,boothStatusError]=useLoad<BoothStatus>("booth.status",refresh,{connected:false,items:0,owned:0,files:0,materialized:0});
  const [boothItems,boothError]=useLoad<BoothItem[]>("booth.catalog",refresh,[]);
  const [boothBusy,setBoothBusy]=useState("");
  const [boothMessage,setBoothMessage]=useState("");
  const [pickedFiles,setPickedFiles]=useState<string[]>([]);
  const [targetProject,setTargetProject]=useState(projects[0]?.id??"");
  const fetchBlocker=materializeBlocker({project:targetProject,files:pickedFiles.length,busy:Boolean(boothBusy)||Boolean(boothStatus.job)});
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("package");
  const [status, setStatus] = useState("candidate");
  const [license, setLicense] = useState("unknown");
  const [tags, setTags] = useState("");
  const [editing, setEditing] = useState<string>();
  const shown = assets.filter((a) =>
    `${a.name} ${a.path} ${a.kind} ${a.tags.join(" ")}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const feedback = useFeedback();
  const { busy, run } = useAction();
  async function save() {
    if (!path.trim() || !name.trim()) { feedback.error("先选择素材位置并填写名称"); return; }
    await run("save", () => doSave(), editing ? "已保存修改" : "已加入素材库");
  }
  async function doSave() {
    await call("asset.save", {
      ...(editing ? { id: editing } : {}),
      path: path.trim(),
      name: name.trim(),
      kind,
      status,
      license: license.trim() || "unknown",
      tags: tags
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    });
    setPath("");
    setName("");
    setTags("");
    setEditing(undefined);
    changed();
  }
  function edit(asset: Asset) {
    setEditing(asset.id);
    setName(asset.name);
    setPath(asset.path);
    setKind(asset.kind);
    setStatus(asset.status);
    setLicense(asset.license);
    setTags(asset.tags.join(", "));
  }
  async function remove(asset: Asset) {
    if (!await feedback.confirm({ title: `从素材库移除「${asset.name}」？`, body: <p>只移除索引记录，不会删除磁盘上的文件。</p>,
      confirm: "移除", danger: true })) return;
    await run(`remove:${asset.id}`, async () => { await call("asset.remove", { id: asset.id }); changed(); }, "已从素材库移除");
  }
  const [loginOpen,setLoginOpen]=useState(false);
  async function login(){setBoothMessage("");try{await desktopInvoke("open_booth_login");setLoginOpen(true);setBoothMessage("请在新窗口完成 BOOTH 登录，然后点击「我已完成登录」。");}catch(e){setBoothMessage(errorText(e));}}
  async function capture(){setBoothBusy("正在读取登录态…");setBoothMessage("");try{await desktopInvoke<void>("capture_booth_session");setLoginOpen(false);setBoothMessage("已安全保存 BOOTH 登录态；会话未进入页面。现在可以同步索引。");changed();}catch(e){setBoothMessage(errorText(e));}finally{setBoothBusy("");}}
  async function disconnectBooth(){setBoothBusy("正在断开…");setBoothMessage("");try{await call("booth.session.clear");setBoothMessage("已删除 Harness 保存的 BOOTH 会话。");changed();}catch(e){setBoothMessage(errorText(e));}finally{setBoothBusy("");}}
  async function syncBooth(){setBoothBusy("正在同步商品与文件元数据（每秒最多 1 次请求，商品多时需要几分钟）…");setBoothMessage("");try{await call("booth.sync");
    const outcome=await followBooth(setBoothBusy);setBoothMessage(outcome.ok?`${outcome.message}；没有下载素材包。`:outcome.message);changed();}
    catch(e){setBoothMessage(String((e as Error).message??e));}finally{setBoothBusy("");}}
  async function materialize(){if(!targetProject||!pickedFiles.length)return;setBoothBusy("正在按需获取所选文件…");setBoothMessage("");try{
    const plan=await call<{id:string}>("booth.plan.create",{projectId:targetProject,createdBy:"human",rationale:"用户在素材页手动选择（AI 文件计划的兜底入口）",
      files:pickedFiles.map(downloadableId=>({downloadableId,purpose:"项目候选素材"}))});
    await call("booth.plan.materialize",{planId:plan.id});const outcome=await followBooth(setBoothBusy);
    setBoothMessage(outcome.ok?`${outcome.message}。`:outcome.message);if(outcome.ok)setPickedFiles([]);changed();
  }catch(e){setBoothMessage(String((e as Error).message??e));}finally{setBoothBusy("");}}
  return (
    <section className="content">
      {(error||boothStatusError||boothError) ? <div className="banner bad">{error||boothStatusError||boothError}</div> : null}
      <div className="source-tabs"><button className={source==="booth"?"selected":""} onClick={()=>setSource("booth")}><b>BOOTH 云端素材</b><small>只同步索引，使用时下载</small></button>
        <button className={source==="local"?"selected":""} onClick={()=>setSource("local")}><b>本地零散素材</b><small>只记录原文件位置</small></button></div>
      {source==="booth"?<>
        <Panel title="BOOTH 连接与索引">
          <div className="status-line"><Status state={boothStatus.connected ? ["已连接", "ok"] : ["未连接", "muted"]} /><span>{boothLine(boothStatus)}</span></div>
          <div className="actions">
            {boothStatus.connected ? <>
              <button className="primary" disabled={Boolean(boothBusy)||Boolean(boothStatus.job)} onClick={syncBooth}>同步索引</button>
              <button disabled={Boolean(boothBusy)||Boolean(boothStatus.job)} onClick={disconnectBooth}>断开连接</button>
            </> : loginOpen
              ? <button className="primary" disabled={Boolean(boothBusy)} onClick={capture}>我已完成登录</button>
              : <button className="primary" disabled={Boolean(boothBusy)} onClick={login}>登录 BOOTH</button>}
            <small>{boothBusy||boothMessage||"Harness 不读取、不保存 BOOTH 密码，登录会话不进入界面，也不会全量下载素材。"}</small>
          </div>
        </Panel>
        <div className="toolbar"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索商品、店铺、分类或标签"/>
          <select value={targetProject} onChange={e=>setTargetProject(e.target.value)} aria-label="使用项目"><option value="">选择使用项目</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select>
          <button disabled={Boolean(fetchBlocker)} onClick={materialize}>按需获取 {pickedFiles.length} 个文件</button>
          {fetchBlocker ? <small className="reason">{fetchBlocker}</small> : null}</div>
        <Panel title="我的 BOOTH 素材">
          {boothItems.filter(item=>`${item.name} ${item.shopName} ${item.category} ${item.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())).map(item=><div className="booth-item" key={item.itemId}>
            {item.images[0]?<img src={item.images[0]} alt=""/>:<div className="asset-placeholder">BOOTH</div>}<div className="booth-copy"><b>{item.name}</b><p>{item.shopName||"未知店铺"} · {item.category||"未分类"} · {item.fileCount} 个文件<br/>{item.tags.join(" / ")}</p>
            <div className="file-picks">{item.files.map(file=><label key={file.downloadableId} className={pickedFiles.includes(file.downloadableId)?"selected":""}><input type="checkbox" checked={pickedFiles.includes(file.downloadableId)} disabled={file.status!=="available"} onChange={()=>setPickedFiles(values=>values.includes(file.downloadableId)?values.filter(id=>id!==file.downloadableId):[...values,file.downloadableId])}/><span><b>{file.filename}</b><small>{file.materialized?"已缓存":file.byteSize===null?"大小未知":`${(file.byteSize/1024/1024).toFixed(1)} MB`}</small></span></label>)}</div></div><a href={item.itemUrl} target="_blank" rel="noreferrer">商品页</a></div>)}
          {!boothItems.length?<Empty text={boothStatus.connected?"索引为空；点击同步元数据索引。":"先通过内建窗口连接 BOOTH。"}/>:null}
        </Panel>
      </>:<>
      <div className="toolbar">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称、路径、类型或标签"
        />
      </div>
      <div className="asset-form">
        <PathField label="素材位置" hint="只记录原文件的位置，不复制、不移动。选择窗口里也可以直接粘贴路径。" value={path} onChange={setPath}
          empty="还没有选择素材" pick={{ kind: "file", title: "选择本地素材文件" }} pickText={path ? "换一个文件…" : "选择文件…"}
          also={{ label: path ? "换一个文件夹…" : "选择文件夹…", pick: { kind: "directory", title: "选择本地素材文件夹" } }} />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="素材名称"
          aria-label="素材名称"
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="素材类型">
          <option value="avatar">角色</option>
          <option value="outfit">服装</option>
          <option value="texture">贴图</option>
          <option value="animation">动画</option>
          <option value="package">素材包</option>
          <option value="other">其他</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="素材状态">
          <option value="candidate">待确认</option>
          <option value="ready">可使用</option>
          <option value="blocked">有问题</option>
          <option value="archived">归档</option>
        </select>
        <input
          value={license}
          onChange={(e) => setLicense(e.target.value)}
          placeholder="许可/权益"
          aria-label="许可/权益"
        />
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="标签，用逗号分隔"
          aria-label="标签"
        />
        <div className="asset-form-actions">
          <button className="primary" disabled={busy === "save"} onClick={save}>
            {busy === "save" ? "正在保存…" : editing ? "保存修改" : "加入素材库"}
          </button>
          {editing ? (
            <button onClick={() => { setEditing(undefined); setName(""); setPath(""); setTags(""); }}>
              取消编辑
            </button>
          ) : null}
        </div>
      </div>
      <div className="stats">
        <Stat
          n={String(assets.filter((a) => a.status === "candidate").length)}
          label="待识别"
        />
        <Stat
          n={String(assets.filter((a) => a.status === "blocked").length)}
          label="存在问题"
        />
        <Stat n={String(projects.length)} label="已有项目" />
        <Stat n={String(assets.length)} label="素材总数" />
      </div>
      <Panel title="素材库">
        {shown.map((a) => (
          <div className="row" key={a.id}>
            <span
              className={`dot ${a.status === "blocked" ? "bad" : a.status === "ready" ? "ok" : "warn"}`}
            />
            <div>
              <b>{a.name}</b>
              <p>
                {assetKind(a.kind)} · {assetState(a.status)[0]} · {a.license === "unknown" || !a.license ? "许可未填写" : a.license}
                {a.tags.length ? ` · ${a.tags.join(" / ")}` : ""}
                <br />
                {a.path}
              </p>
            </div>
            <button onClick={() => edit(a)}>编辑</button>
            <button disabled={busy === `remove:${a.id}`} onClick={() => remove(a)}>移除索引</button>
          </div>
        ))}
        {!shown.length ? (
          <Empty text="尚无匹配素材。加入索引只记录元数据，不移动或删除原文件。" />
        ) : null}
      </Panel>
      </>}
    </section>
  );
}
const ACTIVE_TASK = new Set(["PENDING", "READY", "RUNNING", "VERIFYING"]);
/** Background work across projects: what needs the person, what is running, and what happened, grouped by project. */
function Activity({ events, tasks, gates, projects, nav, changed }: {
  events: EventRow[]; tasks: Task[]; gates: Gate[]; projects: Project[]; nav: Nav; changed: () => void;
}) {
  const feedback = useFeedback();
  const { busy, run } = useAction();
  const projectOf = (name: string) => projects.find((project) => project.name === name);
  const openGates = gates.filter(isOpenGate);
  const needs = tasks.filter((task) => task.needsYou);
  const active = tasks.filter((task) => ACTIVE_TASK.has(task.status));
  async function redo(task: Task) {
    const note = await feedback.ask({ title: `重做「${stageLabel(task.stage)}」`, label: "修改意见（会交给执行方，可空）", confirm: "重做", multiline: true });
    if (note === undefined) return;
    await run(`task:${task.id}`, async () => { await call("task.redo", { id: task.id, ...(note ? { note } : {}) }); changed(); }, "已请求重做");
  }
  async function cancel(task: Task) {
    if (!await feedback.confirm({ title: `取消「${stageLabel(task.stage)}」？`, danger: true, confirm: "取消任务",
      body: <p>正在执行的单元会被停止并确认退出；已经写入的改动会保留，并按越界规则记录。</p> })) return;
    await run(`task:${task.id}`, async () => { await call("task.cancel", { id: task.id }, 300_000); changed(); }, "已取消");
  }
  async function recover(task: Task) {
    const answer = await feedback.dialog({ title: "核对上次执行", body: <>
      <p>上次执行的结果无法自动确认。请先检查运行目录和工程，再选择：</p>
      <dl><dt>无副作用</dt><dd>确认执行单元不存在、也没有产生任何改动，重新排队执行。</dd>
        <dt>已核对</dt><dd>已核对执行结果，交给独立检查判定。</dd></dl>
    </>, actions: [{ key: "reconciled", label: "已核对，进入检查", tone: "primary" }, { key: "no_side_effects", label: "无副作用，重新执行" }],
    input: { label: "核对说明", required: true, multiline: true } });
    if (!answer) return;
    await run(`task:${task.id}`, async () => {
      await call("task.recover", { id: task.id, mode: answer.key, note: answer.value.trim() }); changed();
    }, "已恢复");
  }
  const taskAction = (task: Task) => {
    const off = busy === `task:${task.id}`;
    if (task.status === "RECOVERY_REQUIRED") return <button disabled={off} onClick={() => recover(task)}>核对上次执行</button>;
    if (task.status === "FAILED" || task.status === "BLOCKED") return <button disabled={off} onClick={() => redo(task)}>重做</button>;
    const project = projectOf(task.projectName);
    return project ? <button onClick={() => nav.open(project.id, "monitor")}>查看项目</button> : null;
  };
  const groups = groupEvents(events, tasks, projects);
  return (
    <section className="content">
      <Panel title="需要你处理">
        {openGates.map((gate) => {
          const project = projectOf(gate.projectName);
          return (
            <div className="row" key={gate.gate}>
              <div><b>{gate.projectName}</b><p>{gateText(gate).question}</p></div>
              <Status state={["待你决定", "warn"]} />
              {project ? <button onClick={() => nav.open(project.id)}>去决定</button> : null}
            </div>
          );
        })}
        {needs.map((task) => (
          <div className="row" key={task.id}>
            <div><b>{task.projectName} · {stageLabel(task.stage)}</b><p>{taskLine(task)}</p></div>
            <Status state={taskState(task.status)} />
            {taskAction(task)}
          </div>
        ))}
        {!openGates.length && !needs.length ? <Empty text="现在没有需要你处理的事。" /> : null}
      </Panel>
      <Panel title="进行中的任务">
        {active.map((task) => (
          <div className="row" key={task.id}>
            <div><b>{task.projectName} · {stageLabel(task.stage)}</b><p>{task.waitReason ?? `更新于 ${when(task.updatedAt)}`}</p></div>
            <Status state={taskState(task.status)} />
            <button className="link" disabled={busy === `task:${task.id}`} onClick={() => cancel(task)}>取消</button>
          </div>
        ))}
        {!active.length ? <Empty text="没有进行中的任务。" /> : null}
      </Panel>
      <Panel title="最近活动">
        {groups.map(([name, rows]) => (
          <div className="event-group" key={name}>
            <h4>{name}</h4>
            {rows.map((e) => {
              const action = actionText(e);
              return (
                <div className="timeline" key={e.seq} title={`${e.action} · ${e.reason}`}>
                  <time>{when(e.at)}</time>
                  <div>
                    <b>{action.text}</b>
                    {action.known ? null : <code>{e.action}</code>}
                    {readableReason(e.reason) ? <p>{readableReason(e.reason)}</p> : null}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {!events.length ? <Empty text="还没有活动记录。" /> : null}
      </Panel>
    </section>
  );
}
function Core({ status }: { status: Record<string, any> }) {
  const [tick, setTick] = useState(0);
  const [providers, error] = useLoad<Record<string, string>[]>(
    "provider.list",
    tick,
    [],
    { probe: tick > 0 },
  );
  const [packs, packsError] = useLoad<Array<{ id: string; version: string; channel: string; description: string; active: boolean }>>(
    "managed.list", tick, [],
  );
  const [candidates, candidatesError] = useLoad<Array<{ id:string;version:string;basePackId:string;sourceKind:string;reason:string;status:string;
    impact?:{authorityAudit?:{profiles:string[];commands:number;tools:string[];executables:string[];network:false;writeScope:string}};
    reportDecision:{eligible:boolean;reasons:string[]};decision:{eligible:boolean;reasons:string[];summary?:{candidate?:{firstPassRate:number;secondPassRate:number;modelFamilies:number};baseline?:{firstPassRate:number;secondPassRate:number}}} }>>(
    "managed.candidate.list", tick, [],
  );
  const [contributions]=useLoad<Array<{id:string;candidateId:string;status:string;payloadHash:string;bundlePath:string;error:string|null;receipt:{receiptId?:string}|null}>>(
    "managed.contribution.list",tick,[]);
  const feedback = useFeedback();
  const { busy, run } = useAction();
  const [doctor, setDoctor] = useState<DoctorCheck[]>([]);
  const reload = () => setTick(value => value + 1);
  const activatePack = (id: string) => run(`pack:${id}`, async () => {
    await call("managed.activate", { id, reason: "用户在核心管理中恢复此稳定版本" }); reload();
  }, "已切换到此版本");
  const installBundled = () => run("install", async () => { await call("managed.installBuiltin"); reload(); }, "已检查随应用提供的版本");
  // Only on request: checking and installing contact the Harness server. Installing never switches the version in use.
  const [releases, setReleases] = useState<KnowledgeCheck | null>(null);
  const checkKnowledge = () => run("knowledge", async () => { setReleases(await call<KnowledgeCheck>("knowledge.check", {}, 60_000)); });
  const installRelease = (releaseId: string) => run(`release:${releaseId}`, async () => {
    await call("knowledge.install", { releaseId }, 30 * 60_000); reload();
    setReleases(await call<KnowledgeCheck>("knowledge.check", {}, 60_000));
  }, "已安装。要使用它，在上面的列表里切换到这个版本");
  const evaluateCandidate = (id: string) => run(`evaluate:${id}`, async () => {
    await call("managed.candidate.evaluate", { candidateId: id }); reload();
  }, "隔离评测已完成");
  async function authorizeCandidateContribution(id: string) {
    type Summary = { cases: number; modelFamilies: number; attempts: number; passes: number; failures: number; firstPassRate: number | null; secondPassRate: number | null };
    type Preview = { version: string; reason: string; basePackId: string; contentHash: string; evaluationId: string; reportHash: string;
      evaluation: { suiteId: string; suiteVersion: string; isolation: string }; rateDenominators: { baseline: number; candidate: number };
      report: { sourceKind: string; evaluation: { status: string; baseline: Summary; candidate: Summary } } };
    let preview: Preview | undefined;
    if (!await run(`preview:${id}`, async () => { preview = await call<Preview>("managed.contribution.preview", { candidateId: id }); })) return;
    if (!preview) return;
    const shown = preview, percent = (value: number | null) => value === null ? "未测" : `${(100 * value).toFixed(1)}%`;
    if (!await feedback.confirm({ title: `查看技术报告 · ${shown.version}`, confirm: "明确授权这份报告",
      body: <div><p>{shown.reason}<br/>基准 {shown.basePackId} · 评测 {shown.evaluation.suiteId} {shown.evaluation.suiteVersion}（{shown.evaluation.isolation}）</p>
        <p>评测{shown.report.evaluation.status === "passed" ? "通过" : "未通过"}；失败和低分也可报告，不代表真实业务完成或被维护者采用。</p>
        <table><thead><tr><th>实际报告统计</th><th>基准</th><th>候选</th></tr></thead><tbody>
          {([['案例数', 'cases'], ['模型家族数', 'modelFamilies'], ['尝试次数', 'attempts'], ['通过尝试', 'passes'], ['未通过尝试', 'failures']] as const).map(([label, field]) =>
            <tr key={field}><th>{label}</th><td>{shown.report.evaluation.baseline[field]}</td><td>{shown.report.evaluation.candidate[field]}</td></tr>)}
          <tr><th>首次通过率</th><td>{percent(shown.report.evaluation.baseline.firstPassRate)}</td><td>{percent(shown.report.evaluation.candidate.firstPassRate)}</td></tr>
          <tr><th>两次内累计通过率</th><td>{percent(shown.report.evaluation.baseline.secondPassRate)}</td><td>{percent(shown.report.evaluation.candidate.secondPassRate)}</td></tr>
          <tr><th>比率分母：案例×模型组合</th><td>{shown.rateDenominators.baseline}</td><td>{shown.rateDenominators.candidate}</td></tr>
        </tbody></table>
        <p>实际上传：用于改进产品的候选评测报告，来源分类为{candidateSource(shown.report.sourceKind)}；仅包含上述状态、来源分类、基准/候选统计与比率，附随机报告身份、内容摘要和这次明确授权凭据。</p>
        <p>本页候选名称、原因、基准和评测标识、案例原名、模型原名与路径不上传；不发送工程、素材、客户要求、提示词、知识和工具原文。授权绑定所见版本；接收不等于采用或发布。</p></div> })) return;
    await run(`authorize:${id}`, async () => {
      await call("managed.contribution.authorize", { candidateId: id, authorizedBy: "gui-user",
        expectedEvaluationId: shown.evaluationId, expectedContentHash: shown.contentHash, expectedReportHash: shown.reportHash,
        consentText: "用户明确授权将结构化候选评测结果与分母加入本地技术报告队列" });
      reload();
    }, "已加入贡献队列");
  }
  async function submitCandidateContribution(id: string) {
    if (!await feedback.confirm({ title: "回传到贡献服务器？", confirm: "回传",
      body: <p>发送已授权的结构化技术报告。接收不等于本地采用或正式发布。</p> })) return;
    // A failed upload changes the queue entry too, so the list reloads either way.
    await run(`submit:${id}`, () => call("managed.contribution.submit", { id }), "已回传");
    reload();
  }
  // DATA/D8: receiving is not adoption, so the person has to be able to see which signed release their own accepted
  // report went into and which version this computer then runs. The chain comes from the Runtime; an unreachable
  // server leaves it where it was and the dialog says which part could not be refreshed.
  async function showContributionTrace(receiptId: string) {
    type Trace = { receiptId: string | null; candidateId: string; evaluationId: string; contributionStatus: string; submittedAt: string | null;
      release: { releaseId: string; packId: string; version: string; status: string; installedAt: string; activatedAt: string | null } | null;
      installed: { packId: string; version: string; active: boolean } | null; complete: boolean; refresh?: { recorded: number; error?: string } };
    let trace: Trace | undefined;
    if (!await run(`trace:${receiptId}`, async () => { trace = await call<Trace>("managed.contribution.trace", { receiptId }, 30_000); })) return;
    if (!trace) return;
    const shown = trace, time = (value: string | null) => value ? value.replace("T", " ").replace(/\.\d+Z$/, "Z") : "—";
    await feedback.confirm({ title: "这份报告的采纳与溯源", confirm: "关闭",
      body: <div>
        <p>{shown.complete
          ? "这份报告已被纳入一个签名发行，本机当前使用该版本。"
          : "服务端还没有报告这份报告被纳入某个签名发行：接受回执不等于被采纳。"}</p>
        <p>维护者采纳：{shown.release ? `${shown.release.releaseId}（${shown.release.version}）` : "尚无"}</p>
        <p>本机版本：{shown.installed
          ? `${shown.installed.packId} ${shown.installed.version}${shown.installed.active ? "（当前启用）" : "（已安装，未启用）"}`
          : "没有安装这个能力包"}</p>
        <p>时间：提交 {time(shown.submittedAt)} · 安装 {time(shown.release?.installedAt ?? null)} · 启用 {time(shown.release?.activatedAt ?? null)}</p>
        {shown.refresh?.error ? <p>本次没能向服务端核对（{shown.refresh.error}）；以上来自本机已经记录的事实。</p> : null}
        <p className="muted">回执 {shown.receiptId ?? "—"} · 候选 {shown.candidateId} · 评测 {shown.evaluationId}</p>
      </div> });
  }
  const runDoctor = () => run("doctor", async () => setDoctor((await call<{ checks: DoctorCheck[] }>("doctor.run")).checks));
  return (
    <section className="content">
      <div className="stats">
        <Stat n={status.schema ?? "—"} label="状态库版本" />
        <Stat n={String(status.eventSeq ?? 0)} label="证据事件" />
        <Stat n={String(status.scheduler?.restarts ?? 0)} label="服务重启" />
      </div>
      <div className="status-line"><Status state={schedulerControl(status.scheduler?.state).state} /><span>{schedulerControl(status.scheduler?.state).hint}</span></div>
      <div className="two">
        <Panel title="AI 与执行">
          {providers.map((p, i) => {
            const states = providerStates(p);
            return (
              <div className="row" key={p.id ?? i}>
                <div>
                  <b>{providerType(p.type)}{p.type === "pi-cli" ? ` · ${p.id}` : ""}</b>
                  <p>{providerLoginName(p.type)}：{states.login[0]} · 可用性：{states.health[0]}{p.version && p.version !== "unknown" ? ` · ${p.version}` : ""}</p>
                </div>
                <Status state={states.health} />
              </div>
            );
          })}
          {!providers.length ? (
            <Empty text={error || "没有配置 AI Provider"} />
          ) : null}
          <button onClick={() => setTick((x) => x + 1)}>实际探测 Provider</button>
        </Panel>
        <Panel title="知识与核心">
          <p className="muted">
            制作规则、阶段上下文和执行工具作为一个版本由 Harness 管理。新的制作流程会固定当前版本，
            已在运行的项目不会被更新悄悄改变。
          </p>
          {packs.map(pack => <div className="row" key={pack.id}>
            <span className={`dot ${pack.active ? "ok" : ""}`} />
            <div>
              <b>{pack.version}{pack.active ? " · 当前使用" : ""}</b>
              <p>{pack.description} · {packChannel(pack.channel)}</p>
            </div>
            {!pack.active ? <button disabled={Boolean(busy)} onClick={() => activatePack(pack.id)}>
              {busy === `pack:${pack.id}` ? "正在验证…" : "切换到此版本"}
            </button> : null}
          </div>)}
          {!packs.length ? <Empty text={packsError || "尚未安装受管能力版本"} /> : null}
          <div className="actions">
            <button disabled={Boolean(busy)} onClick={installBundled}>
              {busy === "install" ? "正在校验安装包…" : "检查随应用提供的版本"}
            </button>
            <button disabled={Boolean(busy)} onClick={checkKnowledge}>{busy === "knowledge" ? "正在检查…" : "检查能力包更新"}</button>
            <button disabled={busy === "doctor"} onClick={runDoctor}>{busy === "doctor" ? "正在检查…" : "运行环境检查"}</button>
          </div>
          {releases ? <div className="update-result">
            {releases.releases.length ? releases.releases.map(release => <div className="row" key={release.releaseId}>
              <div><b>{release.version}</b><p className="muted">{release.issuedAt.slice(0, 10)} · {(release.size / 1048576).toFixed(1)} MB</p></div>
              {release.installed ? <small>已安装</small> : release.newer
                ? <button disabled={Boolean(busy)} onClick={() => installRelease(release.releaseId)}>
                  {busy === `release:${release.releaseId}` ? "正在下载并校验…" : "安装"}</button>
                : <small>不比当前新</small>}
            </div>) : <p className="muted">服务端还没有可用的能力包发行（{releases.channel} 渠道）。</p>}
            {releases.rejected ? <p className="muted">已忽略 {releases.rejected} 个未通过签名校验的发行清单。</p> : null}
          </div> : null}
        </Panel>
      </div>
      <DoctorResults checks={doctor} />
      <div className="section-title"><h2>候选能力包</h2><span className="muted">可按项目验证和试用；失败、低分及单模型评测也可报告；官方发布独立验证</span></div>
      <Panel title="候选知识包 / 工具包评测">
        {candidates.map(candidate=>{
          const current=candidate.decision.summary?.candidate,baseline=candidate.decision.summary?.baseline;
          const percent=(value:number|undefined)=>value===undefined?"—":`${(value*100).toFixed(1)}%`;
          return <div className="row" key={candidate.id}>
            <span className={`dot ${candidate.decision.eligible?"ok":candidate.status==="evaluated"?"warn":""}`}/>
            <div><b>{candidate.version} · {candidateSource(candidate.sourceKind)}</b><p>{candidate.reason}<br/>
              基线 {candidate.basePackId} · 一次 {percent(current?.firstPassRate)}（基线 {percent(baseline?.firstPassRate)}） · 二次内 {percent(current?.secondPassRate)}（基线 {percent(baseline?.secondPassRate)}） · {current?.modelFamilies??0} 个模型家族<br/>
              权限审计：网络关闭 · 写入 {candidate.impact?.authorityAudit?.writeScope??"待审计"} · {candidate.impact?.authorityAudit?.tools.length??0} 个冻结工具 · 执行入口 {(candidate.impact?.authorityAudit?.executables??[]).join("、")||"无"}</p></div>
            <button disabled={busy.startsWith("evaluate:")} onClick={()=>evaluateCandidate(candidate.id)}>
              {busy===`evaluate:${candidate.id}`?"隔离评测中…":"运行隔离评测"}
            </button>
            {candidate.reportDecision.eligible&&!contributions.some(item=>item.candidateId===candidate.id&&item.status!=="cancelled")?<button disabled={busy.startsWith("preview:") || busy.startsWith("authorize:")} onClick={()=>authorizeCandidateContribution(candidate.id)}>
              查看并授权技术报告
            </button>:null}
            {candidate.reportDecision.eligible ? <Status state={["可报告当前评测结果", "ok"]}/> : candidate.decision.reasons.length
              ? <small>采用及发布验证：{candidate.decision.reasons.join("；")}</small> : <Status state={candidateState(candidate.status)}/>}
          </div>;
        })}
        {!candidates.length?<Empty text={candidatesError||"尚无候选包。当前版本不会被未经评测的内容替换。"}/>:null}
        {contributions.map(item=><div className="row" key={item.id}><span className={`dot ${item.status==="submitted"?"ok":item.status==="failed"?"bad":"warn"}`}/><div><b>技术报告 · {item.candidateId}</b>
          <p>脱敏哈希 {item.payloadHash.slice(0,12)}… · {item.receipt?.receiptId?`服务器回执 ${item.receipt.receiptId}`:item.status==="cancelled"?(item.error?"未发送载荷待清理":"旧授权已撤销，未发送载荷已清理"):`本地路径 ${item.bundlePath}`}{item.error?<><br/>{item.error}</>:null}</p></div>
          {["authorized","exported","failed"].includes(item.status)?<button onClick={()=>submitCandidateContribution(item.id)}>发送技术报告</button>:null}{item.receipt?.receiptId?<button disabled={busy.startsWith("trace:")} onClick={()=>showContributionTrace(item.receipt!.receiptId!)}>
            查看溯源
          </button>:null}<Status state={contributionState(item.status)}/></div>)}
      </Panel>
    </section>
  );
}
type DoctorCheck = { status: string; name: string; detail: string };
/** Results of `avh doctor`, one row per check; shown where the check was started instead of in an alert. */
function DoctorResults({ checks }: { checks: DoctorCheck[] }) {
  if (!checks.length) return null;
  return (
    <Panel title="环境检查结果">
      {checks.map((item) => (
        <div className="row" key={item.name}>
          <div><b>{item.name}</b><p>{item.detail}</p></div>
          <Status state={doctorState(item.status)} />
        </div>
      ))}
    </Panel>
  );
}
type DependencyItem = { id: string; name: string; purpose: string; required: boolean; ok: boolean; version?: string; detail: string };
/** Windows machine setup as the Runtime plans it (windows-setup.ts): items to do, what cannot be done, what stays with the person. */
type SetupItem = { id: string; phase: "machine" | "user"; title: string; detail: string; dep?: string; toggles?: string[]; requires?: string[];
  onlyFor?: string[]; downloadMB?: number; restart?: boolean };
type PersonAction = { id: string; title: string; detail: string; buttons: Array<{ label: string; target: string }>; when?: string[] };
type WindowsPlan = { winget: "ok" | "missing" | "unsupported"; items: SetupItem[]; blocked: Array<{ id: string; title: string; reason: string }>;
  person: PersonAction[]; restartPending: boolean };
type SetupJobItem = { id: string; phase: "machine" | "user"; title: string; status: string; reason?: string; message: string; done?: number; total?: number };
type SetupJob = { id: string; dryRun: boolean; state: "running" | "done" | "failed" | "refused"; phase: string; restartRequired: boolean;
  items: SetupJobItem[]; note?: string };
type DependencyReport = {
  dependencies: DependencyItem[];
  plan: { system: string[]; user: Array<{ id: string; argv: string[] }>; manual: Array<{ id: string; name: string; hint: string }> };
  results?: Array<{ step: string; ok: boolean; output: string }>;
  windows?: { plan: WindowsPlan; job: SetupJob | null };
  /** A Unity editor found on this computer, which first run saves unless the person names another. */
  unityEditor?: string;
};
/**
 * What Harness needs on this computer, in clusters that open only when something in them needs attention. On Windows,
 * Harness does the rest itself: one button, one administrator prompt, progress per item, then a new check. Elsewhere,
 * one button installs what the package manager can.
 */
function DependencyPanel({ onReport }: { onReport?: (report: DependencyReport) => void } = {}) {
  const [report, setReport] = useState<DependencyReport | null>(null);
  const [job, setJob] = useState<SetupJob | null>(null);
  const [choices, setChoices] = useState<SetupChoices>(DEFAULT_SETUP_CHOICES);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const show = (next: DependencyReport) => { setReport(next); setJob(next.windows?.job ?? null); onReport?.(next); };
  async function load(method = "setup.environment", params: Record<string, unknown> = {}) {
    setError("");
    try { show(await call<DependencyReport>(method, params)); } catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { void load(); }, []);
  // Follow a running setup; when it ends, check the computer again.
  useEffect(() => {
    if (job?.state !== "running") return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const { job: next } = await call<{ job: SetupJob | null }>("setup.environment.progress");
        if (stopped || !next) return;
        setJob(next);
        if (next.state !== "running") { stopped = true; clearInterval(timer); await load(); }
      } catch (e) { setError(errorText(e)); }
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [job?.id, job?.state]);
  const windows = report?.windows;
  const chosen = windows ? chosenItems(windows.plan.items, choices) : [];
  const planned = chosen.flatMap((item) => item.dep ? [item.dep] : []);
  const installable = report && !windows ? [...report.plan.system, ...report.plan.user.map((step) => step.id)] : [];
  return (
    <div className="dependencies">
      {report ? dependencyGroups(report.dependencies, planned).map((group) => (
        <details key={`${group.id}:${group.attention}`} className="dependency-group" open={group.attention}>
          <summary><b>{group.title}</b><span>{group.summary}</span><Status state={group.attention ? ["需要处理", "warn"] : ["就绪", "muted"]} /></summary>
          <div className="dependency-list">
            {group.items.map((item) => {
              const state = dependencyState(item);
              return (
                <div key={item.id} className={`dependency ${state[1]}`}>
                  <div><b>{item.name}</b><small title={item.detail}>{item.version ?? item.detail}</small><p>{item.purpose}</p></div>
                  <Status state={planned.includes(item.id) ? ["将自动安装", "info"] : state} />
                </div>
              );
            })}
          </div>
        </details>
      )) : <p className="muted">正在检查本机环境…</p>}
      {windows ? (
        <WindowsSetup plan={windows.plan} job={job} choices={choices} onChoices={setChoices} busy={Boolean(busy)}
          onRecheck={() => void load()} onStart={async () => {
            setBusy("start");
            await load("setup.environment.install", { choices });
            setBusy("");
          }} />
      ) : <>
        {report?.plan.manual.length ? (
          <div className="dependency-manual">{report.plan.manual.map((step) => <p key={`${step.id}:${step.hint}`}><b>{step.name}</b>：{step.hint}</p>)}</div>
        ) : null}
        {report?.results ? (
          <div className="dependency-results">{report.results.map((result) => (
            <p key={result.step} className={result.ok ? "good" : "failed"}>{result.ok ? "✓" : "✗"} {result.step}{result.ok ? "" : `：${result.output.slice(-300)}`}</p>
          ))}</div>
        ) : null}
        <div className="actions">
          <button disabled={Boolean(busy)} onClick={() => void load()}>重新检查</button>
          <button className="primary" disabled={!installable.length || Boolean(busy)} onClick={async () => {
            setBusy("正在安装：系统包会请求一次管理员授权，下载可能需要几分钟…");
            await load("setup.environment.install");
            setBusy("");
          }}>{installable.length ? `安装缺失项：${installable.join("、")}` : "没有可以自动安装的缺失项"}</button>
          {busy ? <small>{busy}</small> : null}
        </div>
      </>}
      {error ? <div className="banner bad">{error}</div> : null}
    </div>
  );
}
/** What only the person can do, each with a button that opens the right place. */
function PersonActions({ actions }: { actions: PersonAction[] }) {
  const feedback = useFeedback();
  async function open(target: string) {
    if (target === "restart" && !await feedback.confirm({ title: "现在重启电脑？", body: "没有保存的工作会丢失。电脑会在 10 秒后重启。",
      confirm: "立即重启", danger: true })) return;
    try {
      const result = await call<{ ok: boolean; message: string }>("setup.environment.open", { target });
      if (result.ok) feedback.ok(result.message); else feedback.error(new Error(result.message));
    } catch (e) { feedback.error(e); }
  }
  return <>{actions.map((action) => (
    <div key={action.id} className="setup-person">
      <div><b>{action.title}</b><p>{action.detail}</p></div>
      {action.buttons.map((button) => <button key={button.target} onClick={() => void open(button.target)}>{button.label}</button>)}
    </div>
  ))}</>;
}
/** Windows: the plan in words with its switches, one button, then the progress of each item. */
function WindowsSetup({ plan, job, choices, onChoices, busy, onStart, onRecheck }: {
  plan: WindowsPlan; job: SetupJob | null; choices: SetupChoices; onChoices: (choices: SetupChoices) => void; busy: boolean;
  onStart: () => void; onRecheck: () => void;
}) {
  const running = job?.state === "running";
  const chosen = chosenItems(plan.items, choices);
  const included = new Set(chosen.map((item) => item.id));
  // Optional items stay listed, switched off; a prerequisite nothing chosen needs is not shown.
  const shown = plan.items.filter((item) => included.has(item.id) || item.toggles?.length);
  const button = setupButton(chosen);
  const download = chosen.reduce((sum, item) => sum + (item.downloadMB ?? 0), 0);
  const restart = chosen.some((item) => item.restart);
  // What only the person can do, for the items chosen now: what must come first above the plan, the rest after it.
  const person = plan.person.filter((action) => !action.when?.length || action.when.some((id) => included.has(id)));
  const first = person.filter((action) => action.id === "winget" || action.id === "hub-running");
  const later = person.filter((action) => !first.includes(action));
  const toggle = (item: SetupItem, on: boolean) =>
    onChoices({ ...choices, ...Object.fromEntries((item.toggles ?? []).map((name) => [name, on])) });
  return (
    <div className="setup-plan">
      <PersonActions actions={first} />
      {job ? <SetupProgress job={job} /> : null}
      {!running ? <>
        {shown.length ? <>
          <h4>Harness 会替你完成这些事</h4>
          {(["machine", "user"] as const).map((phase) => {
            const items = shown.filter((item) => item.phase === phase);
            return items.length ? (
              <div key={phase} className="setup-items">
                <small>{phase === "machine" ? "需要一次管理员授权：Windows 只弹出一次确认，显示为「Windows PowerShell」" : "不需要管理员授权"}</small>
                {items.map((item) => (
                  <label key={item.id} className={`choice${included.has(item.id) ? "" : " off"}`}>
                    <input type="checkbox" disabled={!item.toggles?.length || busy} checked={item.toggles?.length ? item.toggles.some((name) => choices[name as keyof SetupChoices]) : true}
                      onChange={(event) => toggle(item, event.target.checked)} />
                    <span><b>{item.title}{item.downloadMB ? ` · 下载${sizeText(item.downloadMB)}` : ""}{item.restart ? " · 重启后生效" : ""}</b><small>{item.detail}</small></span>
                  </label>
                ))}
              </div>
            ) : null;
          })}
          <p className="muted">{chosen.length ? `共 ${chosen.length} 项${download ? `，下载${sizeText(download)}` : ""}。` : "没有选中的项目。"}
            {restart ? "系统级 UTF-8 要重启电脑后生效，可以先完成设置，之后再重启。" : ""}</p>
        </> : <p className="muted">这台电脑已经准备好了，Harness 不需要再安装或更改什么。</p>}
        {plan.blocked.map((item) => <div key={item.id} className="banner warn">{item.title}：{item.reason}</div>)}
      </> : null}
      <PersonActions actions={later} />
      <div className="actions">
        <button disabled={running || busy} onClick={onRecheck}>重新检查</button>
        <button className="primary" disabled={button.disabled || running || busy} onClick={onStart}>{running || busy ? "正在配置…" : button.label}</button>
      </div>
    </div>
  );
}
/** Each item of a setup run as the elevated script and the user-level steps report it; Unity's download as a bar. */
function SetupProgress({ job }: { job: SetupJob }) {
  const headline = job.state === "running" ? (job.phase === "machine" ? "正在完成需要管理员授权的部分…" : "正在安装不需要管理员授权的部分…")
    : job.state === "refused" ? "已取消" : job.state === "failed" ? "配置结束，有项目没有完成"
    : job.dryRun ? "演练结束：没有做任何改动" : "配置完成";
  return (
    <div className="setup-progress">
      <p><b>{headline}</b>{job.note ? ` ${job.note}` : ""}</p>
      {job.items.map((item) => (
        <div key={item.id} className="setup-step">
          <Status state={setupStepState(item.status)} />
          <div>
            <b>{item.title}</b><small>{item.message}</small>
            {item.status === "running" && item.total ? (
              <div className="progress"><i style={{ width: `${Math.min(100, Math.round(((item.done ?? 0) / item.total) * 100))}%` }} /></div>
            ) : null}
          </div>
        </div>
      ))}
      {job.restartRequired && job.state !== "running" && !job.dryRun ? <div className="banner info">UTF-8 设置要重启电脑后生效；可以先继续使用，方便时再重启。</div> : null}
    </div>
  );
}

type KnowledgeCheck = { channel: string; rejected: number; current: { id: string; version: string } | null;
  releases: Array<{ releaseId: string; packId: string; version: string; issuedAt: string; size: number; installed: boolean; newer: boolean }> };
type UpdateCheck = { current: string; channel: string; rejected: number;
  latest?: { version: string; notes: string; issuedAt: string; files: Array<{ kind: string; name: string; size: number; sha256: string; urls: string[] }> } };
type SharingView = { enabled: boolean; active: boolean; needsNotice: boolean;noticeShownAt:string|null;
  installation: { installId: string } | null; revokePending: { installId: string } | null;
  counts: { queued: number; sent: number; rejected: number };pendingReports:number };
/** Data sharing is a per-installation choice; software updates remain independent. */
function SharingAndUpdates({ contributorName, changed }: { contributorName: string; changed: () => void }) {
  const [name, setName] = useState(contributorName);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [revision, setRevision] = useState(0);
  const [sharing] = useLoad<SharingView | null>("sharing.state", revision, null);
  const [notice] = useLoad<{ summary: string; shared: string[]; never: string[]; retention: string } | null>("sharing.notice", 0, null);
  const [remote, setRemote] = useState<{ records?: unknown[]; contributions?: unknown[] } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const feedback = useFeedback();
  useEffect(() => setName(contributorName), [contributorName]);
  const reload = () => { setRevision(value => value + 1); changed(); };
  async function save(params: Record<string, unknown>) {
    setError(""); try { await call("config.update", params); changed(); } catch (e) { setError((e as Error).message); }
  }
  async function choose(enabled: boolean) {
    setBusy("sharing"); setError("");
    try { await call("sharing.choose", { noticeShown: true, enabled }); reload(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }
  async function sharingAction(method: string) {
    setBusy(method); setError("");
    try {
      const result = await call<{ sent?: number; records?: unknown[]; contributions?: unknown[] } | null>(method);
      if (method === "sharing.remoteStatus") setRemote(result);
      else { reload(); if (method === "sharing.revoke") { setRemote(null); feedback.ok("已撤回这台安装的待处理数据"); } }
    } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }
  async function revoke() {
    if (!await feedback.confirm({ title: "撤回这台安装的回传数据？", confirm: "停止并撤回", danger: true,
      body: <p>本机立即停止回传并清空待发记录和未发送报告载荷。服务器确认后，删除这台安装尚未纳入签名发行的记录和贡献包；已发布的内容会在结果中单列。</p> })) return;
    await sharingAction("sharing.revoke");
  }
  async function check() {
    setBusy("正在检查更新…"); setError("");
    try { setUpdate(await call<UpdateCheck>("update.check")); } catch (e) { setError((e as Error).message); } finally { setBusy(""); }
  }
  return (
    <div className="sharing">
      {sharing && !sharing.noticeShownAt && notice ? <div className="banner info"><b>先了解回传内容</b><p>{notice.summary}</p>
        <ul>{notice.shared.map(item => <li key={item}>{item}</li>)}</ul>
        <p>不发送：{notice.never.join("、")}。{notice.retention}</p>
        <div className="actions"><button className="primary" disabled={Boolean(busy)} onClick={() => void choose(true)}>加入技术协作</button>
          <button disabled={Boolean(busy)} onClick={() => void choose(false)}>关闭回传</button></div></div> : null}
      {sharing && sharing.noticeShownAt ? <><label className="toggle-row">
        <input type="checkbox" checked={sharing.enabled} disabled={Boolean(busy) || Boolean(sharing.revokePending)}
          onChange={(e) => void choose(e.target.checked)} />
        <span><b>分享去标识的技术记录</b><small>关闭后停止回传并清空待发记录和未发送报告载荷；本地制作和软件更新照常使用。</small></span>
      </label>
      <p className="muted">本机记录：待发 {sharing.counts.queued} 条，已发 {sharing.counts.sent} 条，未通过 {sharing.counts.rejected} 条；待发技术报告 {sharing.pendingReports??0} 份。
        {sharing.revokePending ? "本机已停止，远端撤回待送达。" : ""}</p>
      <div className="actions">
        <button disabled={Boolean(busy) || !sharing.active || !sharing.counts.queued} onClick={() => void sharingAction("sharing.flush")}>发送待发记录</button>
        <button disabled={Boolean(busy) || !sharing.installation} onClick={() => void sharingAction("sharing.remoteStatus")}>查看服务器记录</button>
        <button disabled={Boolean(busy)} onClick={() => void revoke()}>停止并撤回</button>
      </div>
      {remote ? <p className="muted">服务器仍保存 {remote.records?.length ?? 0} 批技术记录、{remote.contributions?.length ?? 0} 个贡献包。</p> : null}
      </> : null}
      <label className="name-row">本地署名（技术报告不会发送）
        <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} onBlur={() => name !== contributorName && void save({ contributorName: name })} />
      </label>
      <div className="actions">
        <button disabled={Boolean(busy)} onClick={() => void check()}>检查软件更新</button>
        {busy ? <small>{busy}</small> : null}
      </div>
      {update ? (update.latest ? (
        <div className="update-result">
          <p><b>有新版本 {update.latest.version}</b>（当前 {update.current}，{packChannel(update.channel)}渠道）</p>
          <p className="muted">{update.latest.notes}</p>
          {update.latest.files.map((file) => (
            <p key={file.name}>{file.kind} · {file.name} · {(file.size / 1048576).toFixed(1)} MB{" "}
              {file.urls.map((url) => <a key={url} href={url} target="_blank" rel="noreferrer">下载</a>)}</p>
          ))}
        </div>
      ) : <p className="muted">已是最新：{update.current}（{packChannel(update.channel)}渠道）</p>) : null}
      {update?.rejected ? <p className="muted">已忽略 {update.rejected} 个未通过签名校验的发行清单。</p> : null}
      {error ? <div className="banner bad">{error}</div> : null}
    </div>
  );
}

function Settings({
  status,
  refresh,
  anchor,
  anchorSeq,
  changed,
}: {
  status: Record<string, any>;
  refresh: number;
  /** A section to scroll to on arrival: "service" (from the sidebar status) or "ai" (from the home page). */
  anchor?: string;
  anchorSeq?: number;
  changed: () => void;
}) {
  useEffect(() => { if (anchor) reveal(document.getElementById(anchor), "start"); }, [anchor, anchorSeq]);
  const control = schedulerControl(status.scheduler?.state);
  const [config, configError] = useLoad<{
    workspaceRoot: string;
    knowledgeRoot: string;
    toolRoot: string;
    exportRoots: string[];
    defaultProfile: string;
    profiles: string[];
    providers: Array<{ id: string; type: string } & PiProviderView>;
    /** The default model and credential of each service reached through pi. */
    piDefaults?: Record<PiUpstream, { model: string; secret: string }>;
    workflowVariables: { assetLibrary?: string; templateProject?: string };
    coordination?:{maxExplorationOperations:number};
    unity?: { editor?: string; runner?: string } | null;
    contributions?: boolean;
    contributorName?: string;
  }>("config.view", refresh, {
    workspaceRoot: "",
    knowledgeRoot: "",
    toolRoot: "",
    exportRoots: [],
    defaultProfile: "",
    profiles: [],
    providers: [],
    workflowVariables: {},
  });
  // What the GUI host found on this computer (every Unity editor), offered before the picker.
  const [found] = useLoad<SetupState | null>("setup.status", refresh, null);
  const [doctor, setDoctor] = useState<DoctorCheck[]>([]);
  const { busy, run } = useAction();
  const [draft, setDraft] = useState({ workspaceRoot: "", exportRoots: [] as string[], defaultProfile: "", assetLibrary: "", templateProject: "",
    unityEditor: "", codex: false, claude: false,explorationMaxOperations:72 });
  const [pi, setPi] = useState<PiState>(NO_PI);
  useEffect(() => setPi(piStateFrom(config.providers)), [JSON.stringify(config.providers)]);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft({ workspaceRoot: config.workspaceRoot,
      exportRoots: config.exportRoots, defaultProfile: config.defaultProfile,
      assetLibrary: config.workflowVariables.assetLibrary ?? "", templateProject: config.workflowVariables.templateProject ?? "",
      unityEditor: config.unity?.editor ?? "",explorationMaxOperations:config.coordination?.maxExplorationOperations??72,
      codex: config.providers.some(provider => provider.type === "codex-cli"),
      claude: config.providers.some(provider => provider.type === "claude-cli") });
  }, [config.workspaceRoot, config.knowledgeRoot, config.toolRoot, config.defaultProfile, config.exportRoots.join("\n"), JSON.stringify(config.providers), JSON.stringify(config.workflowVariables), JSON.stringify(config.unity),JSON.stringify(config.coordination)]);
  const ACTION_DONE: Record<string, string> = { "service.pause": "已请求在安全点暂停", "service.resume": "后台已继续运行",
    "config.reload": "已重新读取配置" };
  const action = (method: string) => run(method, async () => {
    const result = await call<{ checks?: DoctorCheck[] }>(method);
    if (result.checks) setDoctor(result.checks);
    setTimeout(changed, 300);
  }, ACTION_DONE[method]);
  async function saveConfig() {
    setSaving(true); setSaveError("");
    try {
      await call("config.update", { ...draft, workflowVariables: { assetLibrary: draft.assetLibrary, templateProject: draft.templateProject },
        exportRoots: draft.exportRoots,coordination:{maxExplorationOperations:draft.explorationMaxOperations},
        providerTypes: [draft.codex ? "codex-cli" : "", draft.claude ? "claude-cli" : ""].filter(Boolean),
        // Sent only when changed: a hand-written pi entry the form cannot show stays as it is.
        ...(JSON.stringify(piChoicesFrom(pi)) !== JSON.stringify(piChoicesFrom(piStateFrom(config.providers))) ? { pi: piChoicesFrom(pi) } : {}) });
      changed();
    } catch (error) { setSaveError((error as Error).message); }
    finally { setSaving(false); }
  }
  return (
    <section className="content">
      <div className="settings">
        <Panel title="后台服务" id="service">
          <div className="status-line"><Status state={control.state} /><span>{control.hint}</span></div>
          <div className="actions">
            <button className={control.primary ? "primary" : ""} disabled={!control.method || Boolean(busy)}
              onClick={() => control.method && action(control.method)}>{busy.startsWith("service.") ? "正在处理…" : control.label}</button>
          </div>
          <details className="config-advanced">
            <summary>诊断信息</summary>
            <Field label="Runtime" value={status.runtime ?? "—"} />
            <Field label="数据目录" value={status.home ?? "—"} />
          </details>
        </Panel>
        <Panel title="配置管理">
          <div className="config-form">
            <PathField label="项目工作区" hint="新建和接管的 Unity 工程所在目录。换了位置，已有的项目和交付物不会被移动。"
              value={draft.workspaceRoot} onChange={(path) => setDraft({ ...draft, workspaceRoot: path })}
              pick={{ kind: "directory", title: "选择项目工作区" }} />
            <PathList label="交付目录" hint="整理好的交付包放在这里，不能放在项目工作区里面；至少保留一个。" values={draft.exportRoots}
              onChange={(exportRoots) => setDraft({ ...draft, exportRoots })} add="添加交付目录…"
              pick={{ kind: "directory", title: "选择交付目录" }} />
            <PathField label="Unity 编辑器" hint="VRChat 头像用 Unity 2022.3.22f1。" value={draft.unityEditor}
              onChange={(path) => setDraft({ ...draft, unityEditor: path })} detected={found?.defaults.unityEditors ?? []} note={unityEditorNote}
              empty={config.unity?.runner && !config.unity?.editor ? `沿用旧写法：${config.unity.runner}` : "还没有设置"}
              pick={{ kind: "file", title: "选择 Unity 编辑器", filters: unityEditorFilters(onWindows()) }} />
            <PathField label="自定义工程模板（高级）" hint="默认自动准备官方环境；仅在需要覆盖配方时选择经过验证的空白模板。" value={draft.templateProject}
              onChange={(path) => setDraft({ ...draft, templateProject: path })} empty="由 Harness 自动准备" optional="使用自动准备"
              pick={{ kind: "directory", title: "选择 Unity 基准工程" }} />
            {/* No subscription switches here, and no other vendor's key field: Codex and Claude Code are not an
                execution route (决定记录 D-34), and this version reaches the DeepSeek API only (D-7/D-8). The section
                keeps its anchor so the "配置 AI" entry still lands on the API key settings. */}
            <div className="provider-picks" id="ai" />
            <PiChoices state={pi} onChange={setPi} layout="settings"
              models={config.piDefaults && { deepseek: config.piDefaults.deepseek.model, zai: config.piDefaults.zai.model, zhipu: config.piDefaults.zhipu.model }}
              secrets={{ deepseek: piSecretFor("deepseek", config.providers), zai: piSecretFor("zai", config.providers),
                zhipu: piSecretFor("zhipu", config.providers) }} />
            <div className="banner">
              制作使用你自己的 DeepSeek API 密钥，按实际用量计费，额度来自你的账号；Harness 不设消费上限，也不代管额度
              （决定记录/D-50）。返工、改脸后的整链重跑会再次计费。Codex 与 Claude Code 的订阅登录<b>即将支持</b>（dev.1.1）。
            </div>
            <details className="config-advanced">
              <summary>高级</summary>
              <label>默认流程<select value={draft.defaultProfile} onChange={e => setDraft({ ...draft, defaultProfile: e.target.value })}>
                {config.profiles.map(profile => <option key={profile} value={profile}>{profileTitle(profile)}</option>)}
              </select></label>
              <label>素材探索深入程度<select value={draft.explorationMaxOperations} onChange={e=>setDraft({...draft,explorationMaxOperations:Number(e.target.value)})}>
                <option value={72}>标准</option><option value={240}>更深入</option>
                {![72,240].includes(draft.explorationMaxOperations)?<option value={draft.explorationMaxOperations}>自定义</option>:null}
              </select><small>Harness按实际发现自动继续；更深入可能增加AI调用费用和等待时间，不会扩展素材访问授权。</small></label>
              <Field label="BOOTH 按需缓存" value={draft.assetLibrary || "由 Harness 管理"} />
              <Field label="制作规则" value="由 Harness 托管并进行版本管理" />
              <Field label="执行工具" value="随规则包更新，可回退" />
            </details>
          </div>
          {configError ? <div className="banner bad">{configError}</div> : null}
          {saveError ? <div className="banner bad">{saveError}</div> : null}
          <div className="actions">
            <button className="primary" disabled={saving} onClick={saveConfig}>{saving ? "正在校验…" : "校验并保存"}</button>
            <button disabled={Boolean(busy)} onClick={() => action("config.reload")}>
              重新读取配置
            </button>
            <button disabled={busy === "doctor.run"} onClick={() => action("doctor.run")}>{busy === "doctor.run" ? "正在检查…" : "运行环境检查"}</button>
          </div>
        </Panel>
        <Panel title="数据与协作">
          <SharingAndUpdates contributorName={config.contributorName ?? ""} changed={changed} />
        </Panel>
        <Panel title="环境依赖" id="dependencies">
          <DependencyPanel />
        </Panel>
      </div>
      <DoctorResults checks={doctor} />
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FeedbackProvider>
      <Root />
    </FeedbackProvider>
  </React.StrictMode>,
);
