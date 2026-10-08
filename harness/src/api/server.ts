import { controlContinuation, continuationProgress, productionDelivery, productionHead, productionDispatchBlocked } from '../production-face-continuation.ts';
import {continuationContracts,continuationContractView,adoptContinuationContract,resolveRebuildChanges} from '../production-face-rebuild.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { loadConfig, type LocalConfig } from '../config.ts';
import { hostPlatform } from '../host-platform.ts';
import { handoffMarkdown } from '../import/index.ts';
import { harnessRoot, harnessVersion, knowledgeVersion } from '../provenance.ts';
import { openDatabase, SCHEMA_VERSION } from '../state/db.ts';
import { projectTaskBrief, taskAcceptChanges } from '../task-cli.ts';
import { interactionMessages, retryInteraction, sessionRevision, submitInteraction } from '../interactions.ts';
import { currentIntent } from '../project-intent.ts';
import { approveProduction, productionProposals, rejectProduction } from '../production-proposals.ts';
import { cancelProduction, resumeProduction } from '../production-recovery.ts';
import { piRunConnectionProgress } from '../providers/pi.ts';
import { PreviewReader } from './preview-reader.ts';
import { manualFaceState, openManualFace, launchManualBlender, submitManualFace, cancelManualFace, resumeManualFace, rollbackManualFace, setFaceMode } from '../face-manual.ts';
import type { FaceMode } from '../face-policy.ts';
import { describeWorkflow, listWorkflows } from '../workflow/view.ts';
import { versionText } from '../cli.ts';
import { parse, parseDocument, stringify, type Document } from 'yaml';
import { API_VERSION, ApiError, apiEndpoint, LineBuffer, probeEndpoint, responseFrames, type EventMessage, type Hello, type Request, type Response } from './protocol.ts';
export { probeEndpoint } from './protocol.ts';
import { eventsAfter, gateRows, gateStageTask, latestEventSeq, projectRows, recentEvents, taskDetail, taskReviewToken, taskRows } from './read-model.ts';
import { findProfiles, installBundledPack, managedPacks } from '../managed-pack.ts';
import { candidateReportDecision, projectCandidateReport } from '../sharing/candidate-report.ts';
import { approveCandidateTrial, candidateTrials, disableCandidateTrial, packCandidates, packContributionDecision } from '../managed-pack-candidate.ts';
import { adoptLocalCandidate, localMaintenanceView, maintenanceProblem } from '../local-maintenance.ts';
import { isVerifiedRelease } from '../managed-pack-update.ts';
import { projectState, writeProjectState } from '../project-state.ts';
import { boothCatalog, boothCounts, createSelectionPlan, materializeSelection, pinnedPlanFiles, releaseSelectionPlan, selectionPlans } from '../booth/catalog.ts';
import { syncBoothLibrary, syncMessage, type SyncProgress } from '../booth/sync.ts';
import { poolEntries, removePoolBlobs, setPoolPin } from '../booth/pool.ts';
import { unityEditorProblem } from '../unity-editors.ts';
import { packageVersion } from '../provenance.ts';
import { officialEndpoints } from '../official.ts';
import { defaultEvaluationSuiteRoot, evaluatePackCandidate } from '../managed-pack-evaluator.ts';
import { acceptWarning, decideFormalGate, stageTaskSpec, workflowSnapshot } from '../workflow/runtime.ts';
import { warningRows } from '../workflow/view.ts';
import { parseInputHashes } from '../workflow/inputs.ts';
import { stageContractView, selectStageContract } from '../workflow/stage-contract.ts';
import { compileContext, contextItemContent } from '../workflow/context-compiler.ts';
import { diagnoseContext, isSettledContextSample, readContextSamples } from '../context-diagnostics.ts';
import { enforceCandidateTrialSafety } from '../candidate-safety.ts';
import { attachAuthoringTask, authoringTaskSpec, candidateAuthoringRows, prepareCandidateAuthoring,
  reconcileCandidateAuthoring } from '../candidate-authoring.ts';
import { authorizeContribution, contributionRows, markContributionExported, pruneContributionQueue, submitContribution, verifyContributionReady } from '../contribution-queue.ts';
import { materializeImportSource } from '../import/materialize.ts';
import { recoveryAnalysisSpec, recoveryApplySpec, type RecoveryMode } from '../import/recovery.ts';
import { runVpm, vpmStatus, type VpmAction } from '../vpm-manager.ts';
import { prepareOfficialUpload } from '../upload-handoff.ts';
import { preflightWindowsDirectories } from '../exec/windows-boundary.ts';
import { releaseStaleLedgers } from '../exec/windows-helper.ts';
import { clearSecret, hasSecret, writeSecret } from '../providers/secrets.ts';
import { PI_UPSTREAMS, piChoices, withPiChoices, type PiChoice } from '../shared/pi.ts';
import { confirmFact } from '../archive/facts.ts';
import { projectOverview } from '../archive/overview.ts';
import { projectSafePoint } from '../archive/projection.ts';
import { registerEntries } from '../archive/registry.ts';
import { reconcileRecoveries, projectRoot } from '../archive/takeover.ts';
import { assetsApi } from '../assets/api.ts';
import { refreshAssetIndex } from '../assets/derive.ts';
import { sharingNotice } from '../shared/sharing.ts';
import { chooseSharing, sharingRecords, sharingState } from '../sharing/state.ts';
import { flushSharing, remoteSharingStatus, revokeSharing, sharingToken } from '../sharing/client.ts';
import { SharingSender } from '../sharing/sender.ts';
import { refreshContributionAcceptance, traceContribution } from '../contribution-trace.ts';

import { isSubscriptionAdapter, withoutExecutor } from '../shared/subscription.ts';

export interface ServiceOptions {
  home: string;
  /** Scheduler round interval passed to the `avh serve` child. */
  intervalMs?: number;
  /** false runs only the API (tests, or a scheduler managed elsewhere). */
  scheduler?: boolean;
  pollMs?: number;
  /** Test hook: the CLI entry point run for scheduler rounds and commands. */
  cliPath?: string;
  /** Test hook: where BOOTH requests go and how far apart. */
  boothRequests?: { fetcher?: typeof fetch; intervalMs?: number };
}
export type SchedulerState = 'running' | 'pausing' | 'paused' | 'backoff' | 'stopped';
interface CliResult { status: number | null; stdout: string; stderr: string }
/** A share or restore running as an `avh` command, followed through project.archive.job. */
interface ArchiveJob { id: string; kind: 'preview' | 'export' | 'check' | 'restore' | 'diagnose'; startedAt: string; projectId?: string; file?: string;
  progress?: { phase: string; done?: number; total?: number } }

/** Commands run as `avh` child processes: the CLI stays the one implementation, and slow work never blocks reads. */
function cliError(result: CliResult): ApiError {
  const message = (result.stderr || result.stdout).trim().replace(/^avh: /, '').split('\n').slice(0, 6).join('\n');
  return new ApiError(/已变化/.test(message) ? 'STALE' : /找不到|不存在|Unknown/.test(message) ? 'NOT_FOUND' : 'FAILED',
    message || `命令退出码 ${result.status}`);
}
/** The archive's contract errors carry a code the API passes on (a bad request is not a failure of the service). */
function archiveCall<T>(run: () => T): T {
  try { return run(); }
  catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'BAD_REQUEST' || code === 'NOT_FOUND' || code === 'STALE') throw new ApiError(code, (error as Error).message);
    throw error;
  }
}
function text(value: unknown, name: string, required = true): string {
  if ((value === undefined || value === '') && !required) return '';
  if (typeof value !== 'string' || !value.trim()) throw new ApiError('BAD_REQUEST', `参数 ${name} 应为非空字符串`);
  return value;
}
function tsvRows(output: string): Record<string, string>[] {
  const [header, ...lines] = output.trim().split('\n');
  const keys = (header ?? '').split('\t');
  return lines.filter(Boolean).map(line => Object.fromEntries(line.split('\t').map((value, i) => [keys[i] ?? `c${i}`, value])));
}

/**
 * Edit harness.yaml in place so the person's comments and ordering survive, keep the previous file under
 * config/backups/ (newest 20), and put it back if the edited configuration does not load.
 */
function rewriteConfig(home: string, edit: (document: Document) => void): { backup: string } {
  const configPath = join(home, 'config/harness.yaml'), source = readFileSync(configPath, 'utf8');
  const document = parseDocument(source);
  if (document.errors.length) throw new ApiError('FAILED', `配置文件无法解析：${document.errors[0]!.message}`);
  edit(document);
  const backups = join(home, 'config', 'backups'); hostPlatform.mkdirPrivate(backups);
  const backup = join(backups, `harness.yaml.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  hostPlatform.writePrivate(backup, source, { flag: 'wx' });
  for (const old of readdirSync(backups).filter(name => name.startsWith('harness.yaml.')).sort().slice(0, -20))
    rmSync(join(backups, old), { force: true });
  const next = `${configPath}.next-${process.pid}`, previous = `${configPath}.previous-${process.pid}`;
  hostPlatform.writePrivate(next, String(document)); renameSync(configPath, previous);
  try { renameSync(next, configPath); loadConfig(home); rmSync(previous, { force: true }); return { backup }; }
  catch (error) {
    rmSync(configPath, { force: true }); renameSync(previous, configPath); rmSync(next, { force: true });
    throw new ApiError('BAD_REQUEST', `配置没有保存：${error instanceof Error ? error.message : String(error)}`);
  }
}
function assetSources(document: Document): { roots: string[]; revision: string; scope: 'installation' } {
  const raw = (document.toJS() as Record<string, unknown>).assetSearchRoots ?? [];
  if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string' || !isAbsolute(value)))
    throw new ApiError('FAILED', '素材目录授权无法读取，请检查本地配置');
  const roots = [...new Set(raw as string[])];
  return { roots, revision: createHash('sha256').update(JSON.stringify(roots)).digest('hex'), scope: 'installation' };
}

export class RuntimeService {
  readonly options: Required<Omit<ServiceOptions, 'cliPath' | 'boothRequests'>> & { cliPath: string;
    boothRequests?: ServiceOptions['boothRequests'] };
  readonly endpoint: string;
  readonly startedAt = new Date().toISOString();
  private server?: Server;
  private db?: DatabaseSync;
  private config?: LocalConfig;
  private readonly previewReader=new PreviewReader();
  private readonly subscribers = new Set<Socket>();
  private readonly sockets = new Set<Socket>();
  private poller?: NodeJS.Timeout;
  private lastSeq = 0;
  private connectionProgress = '[]';
  private child?: ChildProcess;
  private schedulerState: SchedulerState = 'stopped';
  private restarts = 0;
  private lastExit?: { code: number | null; signal: string | null; at: string; stderr: string };
  private backoff?: NodeJS.Timeout;
  private stopped?: () => void;
  /** One BOOTH operation at a time. A polite sync takes minutes, far past a client's call timeout, so it runs here in
   * the background and clients follow it through booth.status. */
  private booth?: { kind: 'sync' | 'materialize'; startedAt: string; planId?: string; progress?: SyncProgress };
  private boothLast?: { kind: 'sync' | 'materialize'; finishedAt: string; ok: boolean; message: string; result?: unknown };
  /** One share or restore at a time: previews, exports and restores read whole projects and run as `avh` commands. */
  private archiveJob?: ArchiveJob;
  private archiveLast?: ArchiveJob & { finishedAt: string; ok: boolean; result?: unknown; error?: string };
  /** DATA/D3 automatic sending: the consumer that uploads queued records on its own while the person is joined. */
  private sharingSender?: SharingSender;
  /** Report the code this service started with; do not run Git scans on the API event loop for each read. */
  private readonly runtimeVersion = versionText().split('\n')[0]!;

  constructor(options: ServiceOptions) {
    this.options = { intervalMs: 1000, scheduler: true, pollMs: 500, cliPath: join(harnessRoot, 'bin', 'avh.js'), ...options };
    this.endpoint = apiEndpoint(options.home);
  }

  /** Refuses to start when another service answers on the endpoint; a dead one's socket file is removed. */
  async start(): Promise<void> {
    if (await probeEndpoint(this.endpoint)) throw new Error(`已有 Runtime 服务在运行（${this.endpoint}）`);
    this.config = loadConfig(this.options.home);
    hostPlatform.mkdirPrivate(dirname(this.config.stateDbPath));
    if (process.platform === 'win32') {
      // What bwrap masks on Linux: the Runtime's control files, configuration and state become unreadable to the
      // Low integrity processes Runs execute as.
      preflightWindowsDirectories(this.options.home, this.config.workspaceRoot);
      // Labels a Run left when the Runtime or the computer went down would keep its project open to Low processes.
      try { for (const owner of releaseStaleLedgers(this.options.home)) console.error(`已撤销中断任务遗留的写入标签：${owner}`); }
      catch (error) { console.error(`无法清理遗留的写入标签：${(error as Error).message}`); }
    }
    this.db = openDatabase(this.config.stateDbPath);
    enforceCandidateTrialSafety(this.db);
    this.lastSeq = latestEventSeq(this.db);
    if (process.platform !== 'win32') {
      // Only this user may reach the socket, whatever mode an existing directory had.
      hostPlatform.mkdirPrivate(dirname(this.endpoint)); chmodSync(dirname(this.endpoint), 0o700);
      rmSync(this.endpoint, { force: true });
    }
    this.server = createServer(socket => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.endpoint, () => { this.server!.off('error', reject); resolve(); });
    });
    if (process.platform !== 'win32') chmodSync(this.endpoint, 0o600);
    this.poller = setInterval(() => this.poll(), this.options.pollMs);
    if (this.options.scheduler) this.startScheduler();
    this.sharingSender = new SharingSender({ db: this.db, home: this.options.home, server: this.contributionServer() });
    this.sharingSender.start();
  }

  async stop(): Promise<void> {
    this.sharingSender?.stop();
    this.sharingSender = undefined;
    this.previewReader.close();
    clearInterval(this.poller);
    await this.stopScheduler('stopped');
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
    if (process.platform !== 'win32') rmSync(this.endpoint, { force: true });
    this.db?.close();
    this.stopped?.();
  }
  /** Resolves when stop() completes, whoever called it (signal or the service.stop method). */
  closed(): Promise<void> { return new Promise(resolve => { this.stopped = resolve; }); }

  private startBooth(db: DatabaseSync, job: { kind: 'sync' | 'materialize'; planId?: string },
    run: (job: NonNullable<RuntimeService['booth']>) => Promise<{ result: unknown; message: string }>): { started: true; startedAt: string } {
    if (this.booth) throw new ApiError('CONFLICT', this.booth.kind === 'sync' ? 'BOOTH 同步正在进行，请等它结束' : 'BOOTH 文件正在获取，请等它结束');
    const current: NonNullable<RuntimeService['booth']> = { ...job, startedAt: new Date().toISOString() };
    this.booth = current;
    const finish = (ok: boolean, message: string, result?: unknown): void => {
      this.boothLast = { kind: job.kind, finishedAt: new Date().toISOString(), ok, message, ...(result === undefined ? {} : { result }) };
      try {
        db.prepare(`INSERT INTO event (actor,entity_type,entity_id,action,reason,payload_json) VALUES ('runtime','booth',?,?,?,?)`)
          .run(job.planId ?? 'library', `${job.kind}_${ok ? 'finished' : 'stopped'}`, message, JSON.stringify({ progress: current.progress ?? null }));
      } catch { /* The service may be shutting down; booth.status still reports the outcome. */ }
    };
    void run(current).then(({ result, message }) => finish(true, message, result), (error: Error) => finish(false, error.message))
      .finally(() => { this.booth = undefined; this.poll(); });
    return { started: true, startedAt: current.startedAt };
  }
  /** The contribution server origin: the configured upstream, or the project's own server. */
  private contributionServer(): string {
    const endpoint = this.config!.contributionUpstream?.endpoint ?? officialEndpoints().contributions;
    return new URL(endpoint).origin;
  }
  private poll(): void {
    if (!this.db) return;
    // Retry telemetry changes without a database event. Notify subscribed views without inventing audit facts.
    if (this.subscribers.size) {
      const retrying = this.db.prepare("SELECT id FROM run WHERE status='running' ORDER BY id").all().flatMap(run => {
        const progress = piRunConnectionProgress(join(this.options.home, 'runs', String(run.id)));
        return progress.retrying ? [{ id: run.id, attempt: progress.attempt, delayMs: progress.delayMs }] : [];
      });
      const current = JSON.stringify(retrying);
      if (current !== this.connectionProgress) {
        this.connectionProgress = current;
        this.broadcast({ event: 'progress', detail: 'provider-connection' });
      }
    }
    let seq = latestEventSeq(this.db);
    if (seq <= this.lastSeq) return;
    enforceCandidateTrialSafety(this.db);seq=latestEventSeq(this.db);
    this.lastSeq = seq;
    this.broadcast({ event: 'changed', seq });
  }
  private broadcast(message: EventMessage): void {
    const line = `${JSON.stringify(message)}\n`;
    for (const socket of this.subscribers) if (!socket.destroyed) socket.write(line);
  }

  private startScheduler(drainOnly = false): void {
    if (this.child) return;
    this.schedulerState = drainOnly ? 'pausing' : 'running';
    // Windows has no SIGTERM to deliver: the scheduler stops at its next safe point when its stdin closes instead.
    const windows = process.platform === 'win32';
    const child = spawn(process.execPath, [this.options.cliPath, 'serve', '--interval', String(this.options.intervalMs), ...(drainOnly ? ['--drain'] : [])],
      { env: { ...process.env, AVH_HOME: this.options.home, ...(windows ? { AVH_STOP_ON_STDIN_END: '1' } : {}) },
        stdio: [windows ? 'pipe' : 'ignore', 'ignore', 'pipe'], windowsHide: true });
    this.child = child;
    let stderr = '';
    child.stderr!.setEncoding('utf8').on('data', (data: string) => { stderr = (stderr + data).slice(-4000); });
    child.on('exit', (code, signal) => {
      this.child = undefined;
      this.lastExit = { code, signal, at: new Date().toISOString(), stderr: stderr.trim() };
      if (this.schedulerState === 'pausing' && code === 0) this.schedulerState = 'paused';
      else if (this.schedulerState === 'pausing') {
        this.restarts++;
        this.backoff = setTimeout(() => { if (this.schedulerState === 'pausing') this.startScheduler(true); },
          Math.min(30_000, 1000 * 2 ** Math.min(this.restarts - 1, 5)));
      }
      else if (this.schedulerState === 'running') {
        // Unexpected exit: the database and the Run units are crash-safe, so restart with backoff.
        this.restarts++;
        this.schedulerState = 'backoff';
        this.backoff = setTimeout(() => { if (this.schedulerState === 'backoff') this.startScheduler(); },
          Math.min(30_000, 1000 * 2 ** Math.min(this.restarts - 1, 5)));
      }
      this.broadcast({ event: 'service', detail: this.schedulerState });
    });
    this.broadcast({ event: 'service', detail: this.schedulerState });
  }
  /** Pause drains existing work without a kill deadline; service stop retains its explicit shutdown bound. */
  private async stopScheduler(target: 'paused' | 'stopped', waitMs = 120_000): Promise<void> {
    clearTimeout(this.backoff);
    if (!this.child && target === 'paused') this.startScheduler(true);
    const child = this.child;
    if (!child) { this.schedulerState = target; return; }
    if (this.schedulerState === 'pausing' && target === 'paused') {
      await new Promise<void>(resolve => child.once('exit', () => resolve()));
      return;
    }
    this.schedulerState = target === 'paused' ? 'pausing' : 'stopped';
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    if (process.platform === 'win32') child.stdin?.end(); else child.kill('SIGTERM');
    const timer = target === 'stopped' ? setTimeout(() => child.kill('SIGKILL'), waitMs) : undefined;
    await exited;
    clearTimeout(timer);
    if (target === 'stopped') this.schedulerState = target;
  }

  private cli(args: string[], timeoutMs = 600_000): Promise<CliResult> {
    return new Promise(resolve => {
      const child = spawn(process.execPath, [this.options.cliPath, ...args], { env: { ...process.env, AVH_HOME: this.options.home },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; });
      child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data; });
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
      child.on('error', error => { clearTimeout(timer); resolve({ status: null, stdout, stderr: String(error) }); });
    });
  }
  private async command(args: string[], timeoutMs?: number): Promise<string> {
    const result = await this.cli(args, timeoutMs);
    if (result.status !== 0) throw cliError(result);
    this.poll();
    return result.stdout.trim();
  }
  /**
   * Run a share or restore as an `avh … --json --progress` command in the background. Its progress lines update the
   * job; its JSON report (complete also when blocked, with exit 1) becomes the result project.archive.job returns.
   */
  private startArchiveJob(kind: ArchiveJob['kind'], args: string[], meta: { projectId?: string; file?: string }): { id: string; started: true; startedAt: string } {
    if (this.archiveJob) throw new ApiError('CONFLICT', '另一个分享或恢复正在进行，请等它结束');
    const job: ArchiveJob = { id: randomUUID(), kind, startedAt: new Date().toISOString(), ...meta };
    this.archiveJob = job;
    const child = spawn(process.execPath, [this.options.cliPath, ...args, '--json', '--progress'], { env: { ...process.env, AVH_HOME: this.options.home },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', pending = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      pending += data;
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('progress ')) { stderr = (stderr + line + '\n').slice(-4000); continue; }
        try { job.progress = JSON.parse(line.slice('progress '.length)) as ArchiveJob['progress']; } catch { /* a torn line is skipped */ }
      }
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 6 * 3600_000);
    const finish = (status: number | null, failure?: string): void => {
      clearTimeout(timer);
      let result: unknown, error = failure;
      try { result = JSON.parse(stdout) as unknown; } catch { error ??= (stderr.trim() || stdout.trim() || `命令退出码 ${status}`).split('\n').slice(-4).join('\n'); }
      const failed = result && typeof result === 'object' && (result as { status?: string }).status === 'failed';
      this.archiveLast = { ...job, finishedAt: new Date().toISOString(), ok: status === 0 && !failed, ...(result === undefined ? {} : { result }),
        ...(error || failed ? { error: error ?? String((result as { error?: string }).error ?? '失败') } : {}) };
      this.archiveJob = undefined;
      this.poll();
      this.broadcast({ event: 'changed', seq: latestEventSeq(this.db!) });
    };
    child.on('close', status => finish(status));
    child.on('error', error => finish(null, String(error)));
    return { id: job.id, started: true, startedAt: job.startedAt };
  }
  /** Share options from a caller, as `avh project share` arguments. */
  private shareArgs(params: Record<string, unknown>): string[] {
    if (params.purpose !== 'self' && params.purpose !== 'others') throw new ApiError('BAD_REQUEST', '导出前请选择本人迁移/备份或交给他人');
    if (params.purpose === 'self' && params.recipient) throw new ApiError('BAD_REQUEST', '本人迁移包不能填写接收者');
    const list = (value: unknown, name: string): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim() || item.startsWith('--')))
        throw new ApiError('BAD_REQUEST', `参数 ${name} 应为字符串列表`);
      return value as string[];
    };
    const layers = list(params.layers, 'layers');
    if (layers.some(layer => !['A', 'B', 'C'].includes(layer))) throw new ApiError('BAD_REQUEST', '参数 layers 只能含 A、B、C');
    const args = ['--purpose', params.purpose, ...(layers.length ? ['--layers', layers.join(',')] : []), ...list(params.include, 'include').flatMap(item => ['--include', item]),
      ...list(params.exclude, 'exclude').flatMap(item => ['--exclude', item]), ...list(params.acknowledge, 'acknowledge').flatMap(item => ['--acknowledge', item]),
      ...(params.permittedOnly === true ? ['--permitted-only'] : [])];
    for (const name of ['name', 'recipient'] as const) if (params[name] !== undefined && text(params[name], name, false)) args.push(`--${name}`, text(params[name], name));
    if (params.out !== undefined) {
      const out = text(params.out, 'out');
      if (!/^([A-Za-z]:[\\/]|\/)/.test(out)) throw new ApiError('BAD_REQUEST', '参数 out 应为绝对路径');
      args.push('--out', out);
    }
    return args;
  }
  /**
   * The `--since` filter a diagnostics preview and export share. An unparseable instant is refused here rather than
   * silently compiling a bundle over every record, which would be a different report than the caller asked for.
   */
  private diagnoseWindow(params: Record<string, unknown>): { since?: string } {
    if (params.since === undefined || params.since === '') return {};
    const since = text(params.since, 'since');
    if (!Number.isFinite(Date.parse(since))) throw new ApiError('BAD_REQUEST', '参数 since 应为可解析的时间');
    return { since };
  }
  /** `avh project diagnose` arguments from a caller: where the bundle goes, what window it covers, and the manifest. */
  private diagnoseArgs(params: Record<string, unknown>): string[] {
    const args = Object.entries(this.diagnoseWindow(params)).flatMap(([name, value]) => [`--${name}`, value as string]);
    if (params.out !== undefined) {
      const out = text(params.out, 'out');
      if (!/^([A-Za-z]:[\\/]|\/)/.test(out)) throw new ApiError('BAD_REQUEST', '参数 out 应为绝对路径');
      args.push('--out', out);
    }
    // The confirmed preview's manifest digest and compile instant (R28 P1-3): the export recompiles, so it has to
    // reproduce the very members the caller showed before writing anything.
    if (params.expectDigest !== undefined) {
      const digest = text(params.expectDigest, 'expectDigest');
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new ApiError('BAD_REQUEST', '参数 expectDigest 应为 sha256 摘要');
      args.push('--expect-digest', digest);
    }
    if (params.generatedAt !== undefined) {
      const generatedAt = text(params.generatedAt, 'generatedAt');
      if (!Number.isFinite(Date.parse(generatedAt))) throw new ApiError('BAD_REQUEST', '参数 generatedAt 应为可解析的时间');
      args.push('--generated-at', generatedAt);
    }
    // `startArchiveJob` appends `--json --progress` itself; a second `--json` here is rejected as an unknown argument.
    return args;
  }
  /**
   * Record `avh doctor`'s output where a diagnostics preview and export read it. The previewing caller owns this, so
   * the preview's member list already contains `doctor.txt` and the export that follows packs exactly that list
   * (R28 P1-3). A doctor run must not happen inside the Runtime's event loop, so it is an `avh doctor` child process.
   */
  private async recordDoctorReading(): Promise<void> {
    const home = this.options.home;
    const doctor = await this.cli(['doctor'], 180_000);
    const reading = `${doctor.stdout}${doctor.stderr}`.trim();
    if (!reading) return;
    const path = join(home, 'state', 'doctor.txt');
    hostPlatform.mkdirPrivate(dirname(path));
    hostPlatform.writePrivate(path, `${reading}\n`);
  }
  private restoreArgs(params: Record<string, unknown>): { args: string[]; file: string } {
    const file = text(params.path, 'path');
    if (!/^([A-Za-z]:[\\/]|\/)/.test(file)) throw new ApiError('BAD_REQUEST', '参数 path 应为分享包的绝对路径');
    if (!existsSync(file)) throw new ApiError('NOT_FOUND', `找不到分享包：${file}`);
    const args = [file, ...(params.asCopy === true ? ['--as-copy'] : []), ...(params.allowNetwork === true ? ['--allow-network'] : [])];
    if (params.name !== undefined && text(params.name, 'name', false)) args.push('--name', text(params.name, 'name'));
    if (params.expect !== undefined) {
      const expect = text(params.expect, 'expect');
      if (!['new', 'update', 'same', 'conflict'].includes(expect)) throw new ApiError('BAD_REQUEST', '参数 expect 无效');
      args.push('--expect', expect);
    }
    return { args, file };
  }

  /** `avh project archive <id> --json`: its report is the answer even when the write failed (the command then exits 1). */
  private async archiveCommand(projectId: string): Promise<unknown> {
    const result = await this.cli(['project', 'archive', projectId, '--json']);
    try { return JSON.parse(result.stdout) as unknown; }
    catch { throw cliError(result); }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const buffer = new LineBuffer();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      let lines: string[];
      try { lines = buffer.push(chunk); }
      catch { socket.end(`${JSON.stringify({ id: 0, error: { code: 'BAD_REQUEST', message: '消息过大' } })}\n`); return; }
      for (const line of lines) void this.respond(socket, line);
    });
    socket.on('close', () => { this.sockets.delete(socket); this.subscribers.delete(socket); });
    socket.on('error', () => socket.destroy());
  }
  private async respond(socket: Socket, line: string): Promise<void> {
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
      if (!request || (typeof request.id !== 'number' && typeof request.id !== 'string') || typeof request.method !== 'string')
        throw new Error('bad');
    } catch {
      socket.write(`${JSON.stringify({ id: 0, error: { code: 'BAD_REQUEST', message: '请求不是合法的 JSON 调用' } })}\n`);
      return;
    }
    let response: Response;
    try { response = { id: request.id, result: await this.handle(request.method, request.params ?? {}, socket) }; }
    catch (error) {
      const code = error instanceof ApiError ? error.code : (error as { code?: string }).code === 'NOT_FOUND' ? 'NOT_FOUND' : 'FAILED';
      response = { id: request.id, error: { code: code as ApiError['code'], message: (error as Error).message } };
    }
    try {
      for (const frame of responseFrames(response,request.responseChunks==='sha256-v1')) {
        if (socket.destroyed) return;
        if (!socket.write(frame)) await once(socket,'drain',{signal:AbortSignal.timeout(60_000)});
      }
    } catch { socket.destroy(); }
  }

  private hello(): Hello {
    return { api: API_VERSION, runtime: this.runtimeVersion, schema: SCHEMA_VERSION, pid: process.pid,
      home: this.options.home, startedAt: this.startedAt };
  }
  status(): Record<string, unknown> {
    const lease = this.db!.prepare('SELECT holder, expires_at, cycle FROM scheduler_lease WHERE id = 1').get() as
      { holder: string | null; expires_at: string | null; cycle: number };
    return { ...this.hello(), endpoint: this.endpoint, eventSeq: latestEventSeq(this.db!),
      scheduler: { state: this.schedulerState, pid: this.child?.pid ?? null, intervalMs: this.options.intervalMs,
        restarts: this.restarts, ...(this.lastExit ? { lastExit: this.lastExit } : {}) },
      lease: { holder: lease.holder, expiresAt: lease.expires_at, cycle: lease.cycle } };
  }

  /** Every method; reads run in-process, state changes go through the CLI. */
  private async handle(method: string, params: Record<string, unknown>, socket: Socket): Promise<unknown> {
    const db = this.db!; const home = this.options.home;
    switch (method) {
      case 'hello': return this.hello();
      case 'subscribe': this.subscribers.add(socket); return { seq: latestEventSeq(db) };
      case 'service.status': return this.status();
      case 'service.pause': void this.stopScheduler('paused'); return { state: 'pausing' };
      case 'service.resume': if (this.schedulerState === 'paused' || this.schedulerState === 'backoff' || this.schedulerState === 'stopped') {
        clearTimeout(this.backoff); this.startScheduler(); } return { state: this.schedulerState };
      case 'service.stop': setTimeout(() => void this.stop(), 10); return { state: 'stopping' };
      case 'config.reload': this.config = loadConfig(home); return { ok: true };
      case 'managed.list': return managedPacks(home,this.config!.knowledgeRoot);
      case 'managed.candidate.list': reconcileCandidateAuthoring(db,home);return packCandidates(db).map(candidate=>({ ...candidate,
        reportDecision:candidateReportDecision(db,candidate.id),decision: packContributionDecision(db,candidate.id,{minimumModelFamilies:2,minimumFirstPassRate:.8,minimumSecondPassRate:.95,allowFamilyRegression:false}) }));
      case 'managed.candidate.authoring.list': reconcileCandidateAuthoring(db,home);return candidateAuthoringRows(db,
        params.projectId===undefined?undefined:text(params.projectId,'projectId'));
      case 'managed.candidate.authoring.create': {
        const projectId=text(params.projectId,'projectId'),basePackId=text(params.basePackId,'basePackId'),reason=text(params.reason,'reason');
        const project=db.prepare('SELECT path FROM project WHERE id=?').get(projectId) as {path:string}|undefined;
        if(!project)throw new ApiError('NOT_FOUND','项目不存在');
        const pack=managedPacks(home,this.config!.knowledgeRoot).find(item=>item.id===basePackId);
        if(!pack)throw new ApiError('NOT_FOUND','基础能力包不存在或不是正式安装版本');
        const memory=projectState(db,projectId),authoring=prepareCandidateAuthoring(db,projectId,pack.root,basePackId,reason),
          specPath=join(home,'run',`candidate-authoring-${authoring.id}.yaml`);
        hostPlatform.writePrivate(specPath,authoringTaskSpec(authoring,project.path,memory.cases));
        try{
          const output=await this.command(['task','add',project.path,'--spec',specPath]),match=/Task:\s*([0-9a-f-]{36})/.exec(output);
          if(!match)throw new Error(`候选生成任务返回无法识别：${output}`);attachAuthoringTask(db,authoring.id,match[1]!);
          return candidateAuthoringRows(db,projectId).find(item=>item.id===authoring.id)!;
        }catch(error){db.prepare(`UPDATE managed_pack_authoring SET status='failed',error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .run(String((error as Error).message).slice(0,2000),authoring.id);throw error;
        }finally{rmSync(specPath,{force:true});}
      }
      case 'managed.candidate.evaluate': return evaluatePackCandidate(db,home,text(params.candidateId,'candidateId'),defaultEvaluationSuiteRoot());
      case 'managed.candidate.trial.list': return candidateTrials(db,params.projectId?text(params.projectId,'projectId'):undefined);
      case 'managed.candidate.trial.approve': {
        const projectId=text(params.projectId,'projectId');
        if(!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId))throw new ApiError('NOT_FOUND','项目不存在');
        return approveCandidateTrial(db,projectId,text(params.candidateId,'candidateId'),text(params.approvedBy??'local-user','approvedBy'),
          params.mode==='shadow'?'shadow':'project');
      }
      case 'managed.candidate.trial.disable': disableCandidateTrial(db,text(params.id,'id'));return{ok:true};
      case 'project.maintenance.show': return localMaintenanceView(db,this.config!,text(params.projectId,'projectId'));
      case 'project.maintenance.adopt': {
        if(params.scope!=='project'&&params.scope!=='local')throw new ApiError('BAD_REQUEST','需要明确选择本项目或本机后继制作');
        try{return adoptLocalCandidate(db,this.config!,text(params.projectId,'projectId'),{
          scope:params.scope,candidateId:params.candidateId===null?null:text(params.candidateId,'candidateId'),
          expectedHash:params.candidateId===null?undefined:text(params.expectedHash,'expectedHash'),
          expectedToken:text(params.expectedToken,'expectedToken'),commandId:text(params.commandId,'commandId')},'local-user');
        }catch(error){throw new ApiError('CONFLICT',maintenanceProblem(error));}
      }
      case 'managed.contribution.list': pruneContributionQueue(db,home); return contributionRows(db);
      case 'managed.contribution.preview': {
        const id = text(params.candidateId, 'candidateId'), candidate = packCandidates(db).find(item => item.id === id);
        if (!candidate) throw new ApiError('NOT_FOUND', '找不到候选');
        const decision = candidateReportDecision(db, id);
        if (!decision.eligible || !decision.evaluationId) throw new ApiError('FAILED', decision.reasons.join('；'));
        const report = projectCandidateReport(db, id, decision.evaluationId);
        const evaluation = db.prepare('SELECT suite_id AS suiteId,suite_version AS suiteVersion,isolation,started_at AS startedAt FROM managed_pack_evaluation WHERE id=?').get(decision.evaluationId);
        const rows = db.prepare('SELECT subject,case_id,model_family FROM managed_pack_case_result WHERE evaluation_id=?').all(decision.evaluationId);
        const denominator = (subject: string) => new Set(rows.filter(row => row.subject === subject).map(row => JSON.stringify([row.case_id, row.model_family]))).size;
        return { candidateId: id, version: candidate.version, reason: candidate.reason, basePackId: candidate.basePackId,
          contentHash: candidate.contentHash, evaluationId: decision.evaluationId, evaluation,
          rateDenominators: { baseline: denominator('baseline'), candidate: denominator('candidate') }, report,
          reportHash: createHash('sha256').update(JSON.stringify(report)).digest('hex') };
      }
      case 'managed.contribution.authorize': {
        const id = text(params.candidateId, 'candidateId');
        if (params.expectedEvaluationId !== undefined || params.expectedContentHash !== undefined || params.expectedReportHash !== undefined) {
          const candidate = packCandidates(db).find(item => item.id === id), decision = candidateReportDecision(db, id);
          if (!candidate || !decision.eligible || !decision.evaluationId || candidate.contentHash !== params.expectedContentHash || decision.evaluationId !== params.expectedEvaluationId ||
            createHash('sha256').update(JSON.stringify(projectCandidateReport(db, id, decision.evaluationId))).digest('hex') !== params.expectedReportHash)
            throw new ApiError('STALE', '报告或候选版本已变化，请重新查看后授权');
        }
        return authorizeContribution(db,home,id,text(params.authorizedBy??'local-user','authorizedBy'),text(params.consentText,'consentText'));
      }
      case 'managed.contribution.export': return markContributionExported(db,text(params.id,'id'),home);
      case 'managed.contribution.submit': {
        const contribution=contributionRows(db).find(item=>item.id===params.id);
        if(!contribution||!['authorized','exported','failed','submitted'].includes(contribution.status))throw new ApiError('FAILED','该报告未授权或已取消，请重新明确授权');
        if(contribution.status==='submitted')return contribution;
        verifyContributionReady(db,contribution.id,home);
        const endpoint=this.config!.contributionUpstream?.endpoint ?? officialEndpoints().contributions;
        const server = new URL(endpoint).origin;
        const token = await sharingToken(db, home, server);
        return submitContribution(db,text(params.id,'id'),{endpoint,
          token,home});
      }
      case 'managed.contribution.trace': {
        // DATA/D8: receipt → candidate → evaluation → release → installed version, refreshed from the server's own
        // status read first. A failed refresh only leaves the chain where it was; it never invents an acceptance.
        const receiptId = typeof params.receiptId === 'string' && params.receiptId ? params.receiptId : undefined;
        const candidateId = typeof params.candidateId === 'string' && params.candidateId ? params.candidateId : undefined;
        if (!receiptId && !candidateId) throw new ApiError('BAD_REQUEST', '需要 receiptId 或 candidateId');
        // The status read is bounded: a trace query must not hang on an unreachable server.
        const refresh = await refreshContributionAcceptance(db, home,
          (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }));
        const trace = traceContribution(db, receiptId ? { receiptId } : { candidateId });
        if (!trace) throw new ApiError('NOT_FOUND', '没有这条贡献记录');
        return { ...trace, refresh };
      }
      case 'sharing.state': return { ...sharingState(db), sender: this.sharingSender?.status() ?? null };
      case 'sharing.notice': return sharingNotice({ server: this.contributionServer() });
      case 'sharing.records': return sharingRecords(db);
      case 'sharing.choose': return chooseSharing(db, { surface: params.surface === 'tui' ? 'tui' : 'gui', noticeShown: params.noticeShown === true,
        ...(typeof params.enabled === 'boolean' ? { enabled: params.enabled } : {}) },home);
      case 'sharing.flush': return flushSharing(db, home, this.contributionServer());
      case 'sharing.remoteStatus': return remoteSharingStatus(db, home);
      case 'sharing.revoke': return revokeSharing(db, home);
      case 'managed.installBuiltin': {
        const installed=installBundledPack(home);return{...installed.info,root:installed.root,active:this.config!.knowledgeRoot===installed.knowledgeRoot};
      }
      case 'managed.activate': {
        // `+` joins a bundled pack's id and content hash when a changed bundle is installed beside the old one.
        const id=text(params.id,'id');if(!/^[a-zA-Z0-9._-]+(\+[0-9a-f]{12})?$/.test(id))throw new ApiError('BAD_REQUEST','规则包 ID 无效');
        const available=managedPacks(home,this.config!.knowledgeRoot),target=available.find(pack=>pack.id===id);if(!target)throw new ApiError('NOT_FOUND',`受管规则包不存在: ${id}`);
        if(target.channel!=='builtin'&&!isVerifiedRelease(db,target.id,target.root))
          throw new ApiError('FAILED','此能力包不是已验证的服务端签名版本，不能正式启用');
        const current=available.find(pack=>pack.active);
        // The pack's own formal profiles replace the old list; profiles it does not ship (a private full-custom,
        // say) cannot load from its knowledge root. The previous file stays in config/backups/.
        const shipped=findProfiles(join(target.root,'knowledge'));
        if(!shipped.profiles.some(profile=>profile.capabilities))throw new ApiError('FAILED','此能力包没有可作为正式 Workflow 运行的流程');
        const previousProfiles=Object.keys(this.config!.definitions);
        let removedProfiles:string[]=[];
        const {backup}=rewriteConfig(home,document=>{
          document.set('knowledgeRoot',join(target.root,'knowledge'));document.set('toolRoot',join(target.root,'tools'));
          document.set('processDefinitions',document.createNode(Object.fromEntries(shipped.profiles.map(profile=>
            [profile.id,profile.capabilities?{definition:profile.definition,capabilities:profile.capabilities}:profile.definition]))));
          if(shipped.thresholds)document.set('thresholdsFile',shipped.thresholds);
          const ids=shipped.profiles.map(profile=>profile.id);
          if(!ids.includes(String(document.get('defaultProfile'))))
            document.set('defaultProfile',(shipped.profiles.find(profile=>profile.capabilities)??shipped.profiles[0])!.id);
          removedProfiles=previousProfiles.filter(id=>!ids.includes(id));
        });
        this.config=loadConfig(home);
        if(target.channel!=='builtin'){
          db.prepare("UPDATE managed_pack_release SET status='rolled_back' WHERE status='active' AND pack_id<>?").run(target.id);
          db.prepare("UPDATE managed_pack_release SET status='active',activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),previous_pack_id=COALESCE(previous_pack_id,?) WHERE pack_id=?")
            .run(current?.id??null,target.id);
        }
        db.prepare(`INSERT INTO event(actor,entity_type,entity_id,action,reason,payload_json) VALUES('human','managed_pack',?,'activated',?,json_object('version',?,'removedProfiles',json(?),'configBackup',?))`)
          .run(id,text(params.reason,'reason',false)||'managed pack activated',target.version,JSON.stringify(removedProfiles),backup);
        this.poll();return{ok:true,id,version:target.version,removedProfiles,configBackup:backup};
      }
      case 'asset.sources.list': {
        const doc = parseDocument(readFileSync(join(home, 'config/harness.yaml'), 'utf8'));
        if (doc.errors.length) throw new ApiError('FAILED', '素材目录授权无法读取，请检查本地配置');
        return assetSources(doc);
      }
      case 'asset.sources.grant':
      case 'asset.sources.revoke': {
        const granting = method === 'asset.sources.grant';
        if (granting && params.consent !== true) throw new ApiError('BAD_REQUEST', '请明确允许 AI 搜索、读取和登记此目录中的素材候选');
        const input = text(params.path, 'path'), expected = text(params.expectedRevision, 'expectedRevision');
        if (!isAbsolute(input)) throw new ApiError('BAD_REQUEST', '请选择本机素材文件夹');
        let path = input;
        if (granting) {
          try { path = realpathSync(input); if (!statSync(path).isDirectory()) throw new Error('不是文件夹'); }
          catch { throw new ApiError('BAD_REQUEST', '素材文件夹不存在或无法读取'); }
        }
        let next!: ReturnType<typeof assetSources>;
        rewriteConfig(home, doc => {
          const current = assetSources(doc);
          if (current.revision !== expected) throw new ApiError('STALE', '素材目录授权已更新，请重新查看后操作');
          const roots = granting ? [...new Set([...current.roots, path])] : current.roots.filter(root => root !== path);
          doc.set('assetSearchRoots', doc.createNode(roots)); next = assetSources(doc);
        });
        this.config = { ...this.config!, assetSearchRoots: next.roots };
        db.prepare(`INSERT INTO event(actor,entity_type,entity_id,action,reason,payload_json)
          VALUES('human','asset_sources','installation',?,'user changed local exploration consent',?)`)
          .run(granting ? 'granted' : 'revoked', JSON.stringify({ revision: next.revision, count: next.roots.length }));
        this.poll();
        return next;
      }
      case 'config.view': return { workspaceRoot: this.config!.workspaceRoot, knowledgeRoot: this.config!.knowledgeRoot,
        toolRoot: this.config!.toolRoot, exportRoots: this.config!.exportRoots, defaultProfile: this.config!.defaultProfile,
        workflowVariables: this.config!.workflowVariables, coordination:this.config!.coordination,
        profiles: Object.keys(this.config!.definitions), providers: this.config!.providers.map(provider => ({ id: provider.id, type: provider.adapter,
          // pi: the service and what differs from its defaults (empty means the default, which piDefaults names).
          ...(provider.adapter === 'pi-cli' && provider.upstream ? { upstream: provider.upstream, secret: provider.secret,
            model: provider.model === PI_UPSTREAMS[provider.upstream].model ? '' : provider.model ?? '',
            baseUrl: provider.baseUrl === PI_UPSTREAMS[provider.upstream].baseUrl ? '' : provider.baseUrl ?? '' } : {}) })),
        piDefaults: Object.fromEntries(Object.entries(PI_UPSTREAMS).map(([upstream, info]) => [upstream, { model: info.model, secret: info.secret }])),
        unity: this.config!.unity ?? null, contributions: Boolean(this.config!.contributionUpstream),
        contributorName: this.config!.contributorName ?? '' };
      case 'config.update': {
        let invalid: string | undefined;
        const { backup } = rewriteConfig(home, document => {
          for (const field of ['workspaceRoot', 'defaultProfile'] as const)
            if (params[field] !== undefined) document.set(field, text(params[field], field));
          if (params.workflowVariables !== undefined) {
            if (!params.workflowVariables || typeof params.workflowVariables !== 'object' || Array.isArray(params.workflowVariables)) {
              invalid = '运行目录配置无效'; return;
            }
            // A field the person fills in is set; one they clear is removed. Removing matters: a value left
            // behind from an earlier version keeps steering the flow. `templateProject` is the live example —
            // the current process prepares the environment itself and no longer references it, but a stale
            // path here sends the environment stage down the custom-template branch instead, where it cannot
            // complete. Ignoring the cleared field made that path impossible to leave from the API.
            const values = params.workflowVariables as Record<string, unknown>;
            for (const [key, label] of [['assetLibrary', '素材库目录'], ['templateProject', 'Unity 基准工程']] as const) {
              if (!(key in values)) continue;
              if (typeof values[key] === 'string' && values[key].trim()) document.setIn(['workflowVariables', key], text(values[key], label));
              else document.deleteIn(['workflowVariables', key]);
            }
          }
          if(params.coordination!==undefined)document.set('coordination',document.createNode(params.coordination));
          // Legacy endpoint setting. The versioned sharing consent is stored separately in SQLite.
          if (typeof params.contributions === 'boolean') {
            if (params.contributions) document.set('contributionUpstream', document.createNode({ endpoint: officialEndpoints().contributions }));
            else document.delete('contributionUpstream');
          }
          if (typeof params.contributorName === 'string') {
            const name = params.contributorName.trim();
            if (name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) { invalid = '贡献者用户名最多 64 个字符，不能含控制字符'; return; }
            if (name) document.set('contributorName', name); else document.delete('contributorName');
          }
          // The Unity executable; empty keeps the current setting. A missing lockPath defaults under AVH_HOME.
          if (typeof params.unityEditor === 'string' && params.unityEditor.trim()) {
            const editor = params.unityEditor.trim(), problem = unityEditorProblem(editor);
            if (problem) { invalid = `Unity 编辑器不可用：${problem}`; return; }
            document.setIn(['unity', 'editor'], editor);
          }
          if (params.exportRoots !== undefined) {
            if (!Array.isArray(params.exportRoots) || !params.exportRoots.length) { invalid = '交付目录至少需要一项'; return; }
            document.set('exportRoots', document.createNode(params.exportRoots.map((value, index) => text(value, `exportRoots[${index}]`))));
          }
          if (params.providerTypes !== undefined) {
            if (!Array.isArray(params.providerTypes) || params.providerTypes.some(value => value !== 'codex-cli' && value !== 'claude-cli')) {
              invalid = 'AI Provider 选择无效'; return;
            }
            const enabled = new Set(params.providerTypes as string[]);
            const current = (document.toJS() as Record<string, unknown>).providers;
            const list = Array.isArray(current) ? current.filter(value => value && typeof value === 'object') as Record<string, unknown>[] : [];
            const typeOf = (provider: Record<string, unknown>): unknown => provider.type ?? provider.adapter;
            const retained = list.filter(provider => !isSubscriptionAdapter(typeOf(provider)) || enabled.has(String(typeOf(provider))));
            // A subscription CLI is kept only for its non-executing roles, so setup cannot arm it as the
            // executor by accident, and it can never write into the project.
            for (const provider of retained) {
              if (!isSubscriptionAdapter(typeOf(provider))) continue;
              provider.roles = withoutExecutor(Array.isArray(provider.roles) ? provider.roles.map(String) : []);
              provider.writable = [];
            }
            document.set('providers', document.createNode(retained));
          }
          // pi services (DeepSeek, GLM in one region), each with the person's own key, which secret.set stores apart.
          if (params.pi !== undefined) {
            let choices: PiChoice[];
            try { choices = piChoices(params.pi); } catch (error) { invalid = (error as Error).message; return; }
            const current = (document.toJS() as Record<string, unknown>).providers;
            const list = Array.isArray(current) ? current.filter(value => value && typeof value === 'object') as Record<string, unknown>[] : [];
            document.set('providers', document.createNode(withPiChoices(list, choices)));
          }
        });
        if (invalid) throw new ApiError('BAD_REQUEST', invalid);
        this.config = loadConfig(home);
        return { ok: true, defaultProfile: this.config.defaultProfile, configBackup: backup };
      }
      // Only on request: checking for updates contacts the Harness server, which sees this computer's address.
      case 'update.check': {
        const { checkForAppUpdate } = await import('../app-release.ts');
        try { return await checkForAppUpdate(packageVersion(), { channel: text(params.channel, 'channel', false) || 'dev' }); }
        catch (error) { throw new ApiError('FAILED', `检查更新失败：${(error as Error).message}`); }
      }
      // Also only on request. Installing does not activate: the new pack joins the list the user switches between.
      case 'knowledge.check': {
        const { checkKnowledgeReleases } = await import('../knowledge-release.ts');
        try { return await checkKnowledgeReleases(db, home, this.config!.knowledgeRoot,
          { channel: text(params.channel, 'channel', false) || 'dev', supportedSchema: SCHEMA_VERSION }); }
        catch (error) { throw new ApiError('FAILED', `检查能力包更新失败：${(error as Error).message}`); }
      }
      case 'knowledge.install': {
        const { installKnowledgeRelease, listKnowledgeReleases } = await import('../knowledge-release.ts');
        const releaseId = text(params.releaseId, 'releaseId');
        let offers;
        try { ({ offers } = await listKnowledgeReleases({ channel: text(params.channel, 'channel', false) || 'dev', supportedSchema: SCHEMA_VERSION })); }
        catch (error) { throw new ApiError('FAILED', `检查能力包更新失败：${(error as Error).message}`); }
        const offer = offers.find(item => item.manifest.releaseId === releaseId);
        if (!offer) throw new ApiError('NOT_FOUND', `更新服务上没有这个已签名的能力包发行：${releaseId}`);
        try {
          const installed = await installKnowledgeRelease(db, home, offer, { supportedSchema: SCHEMA_VERSION });
          db.prepare(`INSERT INTO event(actor,entity_type,entity_id,action,reason,payload_json) VALUES('human','managed_pack',?,'installed',?,json_object('version',?,'releaseId',?))`)
            .run(installed.id, 'signed knowledge release installed', installed.version, releaseId);
          return installed;
        } catch (error) { throw new ApiError('FAILED', `安装能力包失败：${(error as Error).message}`); }
      }
      case 'doctor.run': {
        const result = await this.cli(['doctor'], 180_000);
        return { ok: result.status === 0, checks: result.stdout.trim().split('\n').filter(Boolean).map(line => {
          const [status, name, ...detail] = line.split('\t'); return { status, name, detail: detail.join('\t') };
        }), ...(result.stderr.trim() ? { error: result.stderr.trim().replace(/^avh: /, '') } : {}) };
      }
      case 'provider.list': return tsvRows(await this.command(['provider', 'list', ...(params.probe ? ['--probe'] : [])], 180_000));
      case 'project.list': return projectRows(db);
      case 'project.create': {
        const name = text(params.name, 'name');
        const mode = text(params.mode, 'mode', false) || 'conversation';
        if (!['conversation', 'selection'].includes(mode)) throw new ApiError('BAD_REQUEST', '新建项目入口无效');
        const request = text(params.request, 'request', false);
        const faceConcept = text(params.faceConcept, 'faceConcept', false);
        const assetIds = Array.isArray(params.assetIds) ? params.assetIds.map((id, i) => text(id, `assetIds[${i}]`)) : [];
        const message = await this.command(['project', 'new', name]);
        const path = join(this.config!.workspaceRoot, name);
        const id = randomUUID();
        db.exec('BEGIN IMMEDIATE');
        try {
          let workspace = db.prepare('SELECT id FROM workspace WHERE path=?').get(this.config!.workspaceRoot) as { id: string } | undefined;
          if (!workspace) {
            workspace = { id: randomUUID() };
            db.prepare('INSERT INTO workspace(id,path) VALUES(?,?)').run(workspace.id, this.config!.workspaceRoot);
            db.prepare(`INSERT INTO event(actor,entity_type,entity_id,action,reason,payload_json)
              VALUES('human','workspace',?,'registered','GUI project create','{}')`).run(workspace.id);
          }
          db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
            VALUES(?,?,'client',?,'{}','active',?,?)`).run(id, workspace.id, path, harnessVersion(), knowledgeVersion(this.config!));
          db.prepare(`INSERT INTO project_brief(project_id,intake_mode,customer_request,face_concept,status)
            VALUES(?,?,?,?,?)`).run(id, mode, request, faceConcept, request ? 'direction_pending' : 'draft');
          if (request) submitInteraction(db, id, { content: request, commandId: randomUUID(), expectedRevision: 0 });
          for (const assetId of assetIds) db.prepare(`INSERT INTO project_asset(project_id,asset_id,role) VALUES(?,?,'candidate')`).run(id, assetId);
          db.prepare(`INSERT INTO event(actor,entity_type,entity_id,action,reason,payload_json)
            VALUES('human','project',?,'created','commission created',json_object('mode',?,'assets',?))`).run(id, mode, assetIds.length);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        writeProjectState(db,id);
        this.poll();
        return { id, path, message };
      }
      case 'project.brief.get': {
        const projectId = text(params.projectId, 'projectId');
        return db.prepare(`SELECT project_id AS projectId,intake_mode AS intakeMode,customer_request AS customerRequest,
          face_concept AS faceConcept,status,updated_at AS updatedAt FROM project_brief WHERE project_id=?`).get(projectId)
          ?? { projectId, intakeMode: 'import', customerRequest: '', faceConcept: '', status: 'draft' };
      }
      case 'project.brief.update': {
        const projectId=text(params.projectId,'projectId'), intakeMode=text(params.intakeMode,'intakeMode');
        if(!['conversation','selection','import'].includes(intakeMode))throw new ApiError('BAD_REQUEST','项目来源无效');
        const status=text(params.status,'status');if(!['draft','direction_pending','direction_approved','archived'].includes(status))throw new ApiError('BAD_REQUEST','项目方向状态无效');
        db.prepare(`INSERT INTO project_brief(project_id,intake_mode,customer_request,face_concept,status) VALUES(?,?,?,?,?)
          ON CONFLICT(project_id) DO UPDATE SET intake_mode=excluded.intake_mode,customer_request=excluded.customer_request,
          face_concept=excluded.face_concept,status=excluded.status,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
          .run(projectId,intakeMode,text(params.customerRequest,'customerRequest',false),text(params.faceConcept,'faceConcept',false),status);
        writeProjectState(db,projectId);this.poll();return{ok:true};
      }
      case 'project.variant.list': return db.prepare(`SELECT id,project_id AS projectId,name,description,status,
        created_at AS createdAt,updated_at AS updatedAt FROM project_variant WHERE project_id=? ORDER BY status='archived',created_at`)
        .all(text(params.projectId,'projectId'));
      case 'project.variant.save': {
        const projectId=text(params.projectId,'projectId'),id=text(params.id,'id',false)||randomUUID(),status=text(params.status,'status');
        if(!['planned','working','delivery','archived'].includes(status))throw new ApiError('BAD_REQUEST','造型状态无效');
        db.prepare(`INSERT INTO project_variant(id,project_id,name,description,status) VALUES(?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,status=excluded.status,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run(id,projectId,text(params.name,'name'),text(params.description,'description',false),status);
        writeProjectState(db,projectId);this.poll();return{id};
      }
      case 'project.variant.remove': {
        const id=text(params.id,'id'), projectId=text(params.projectId,'projectId');
        const roots=(db.prepare('SELECT count(*) AS count FROM avatar_root WHERE variant_id=?').get(id) as {count:number}).count;
        if(roots)throw new ApiError('BAD_REQUEST',`这个衣装方案仍关联 ${roots} 个头像根，请先重新归属或归档方案`);
        const result=db.prepare('DELETE FROM project_variant WHERE id=? AND project_id=?').run(id,projectId);
        if(!result.changes)throw new ApiError('NOT_FOUND','造型方案不存在');writeProjectState(db,projectId);this.poll();return{ok:true};
      }
      case 'project.variant.asset.list': {
        const variantId=text(params.variantId,'variantId');
        return db.prepare(`SELECT a.id,a.path,a.name,a.kind,a.status,a.license,a.tags_json AS tagsJson,
          pva.role,CASE WHEN pva.variant_id IS NULL THEN 0 ELSE 1 END AS attached
          FROM asset a LEFT JOIN project_variant_asset pva ON pva.asset_id=a.id AND pva.variant_id=?
          ORDER BY attached DESC,a.updated_at DESC,a.name`).all(variantId).map(row=>{
            const item=row as Record<string,unknown>;return{...item,attached:Boolean(item.attached),tags:JSON.parse(String(item.tagsJson)),tagsJson:undefined};
          });
      }
      case 'project.variant.asset.attach': {
        const variantId=text(params.variantId,'variantId'),assetId=text(params.assetId,'assetId'),role=text(params.role,'role');
        if(!['candidate','source','used','rejected'].includes(role))throw new ApiError('BAD_REQUEST','素材关系无效');
        db.prepare(`INSERT INTO project_variant_asset(variant_id,asset_id,role) VALUES(?,?,?)
          ON CONFLICT(variant_id,asset_id) DO UPDATE SET role=excluded.role`).run(variantId,assetId,role);
        const projectId=(db.prepare('SELECT project_id AS id FROM project_variant WHERE id=?').get(variantId) as{id:string}).id;
        writeProjectState(db,projectId);this.poll();return{ok:true};
      }
      case 'project.variant.asset.detach': {
        const variantId=text(params.variantId,'variantId');
        const projectId=(db.prepare('SELECT project_id AS id FROM project_variant WHERE id=?').get(variantId) as{id:string}|undefined)?.id;
        db.prepare('DELETE FROM project_variant_asset WHERE variant_id=? AND asset_id=?')
          .run(variantId,text(params.assetId,'assetId'));
        if(projectId)writeProjectState(db,projectId);this.poll();return{ok:true};
      }
      case 'project.root.list': return db.prepare(`SELECT id,project_id AS projectId,variant_id AS variantId,derived_from AS derivedFrom,
        scene_path AS scenePath,object_path AS objectPath,role,plugin_profile AS pluginProfile,active_state AS activeState,
        blueprint_id AS blueprintId,observed_at AS observedAt FROM avatar_root WHERE project_id=? ORDER BY variant_id IS NULL,variant_id,role,object_path`)
        .all(text(params.projectId,'projectId'));
      case 'project.root.save': {
        const projectId=text(params.projectId,'projectId'),id=text(params.id,'id',false)||randomUUID(),role=text(params.role,'role');
        if(!['baseline','working','plugin_derivative','delivery'].includes(role))throw new ApiError('BAD_REQUEST','头像根角色无效');
        const active=text(params.activeState,'activeState');if(!['active','inactive','unknown'].includes(active))throw new ApiError('BAD_REQUEST','头像根激活状态无效');
        db.prepare(`INSERT INTO avatar_root(id,project_id,variant_id,derived_from,scene_path,object_path,role,plugin_profile,active_state,blueprint_id,observed_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET variant_id=excluded.variant_id,derived_from=excluded.derived_from,
          scene_path=excluded.scene_path,object_path=excluded.object_path,role=excluded.role,plugin_profile=excluded.plugin_profile,
          active_state=excluded.active_state,blueprint_id=excluded.blueprint_id,observed_at=excluded.observed_at`)
          .run(id,projectId,text(params.variantId,'variantId',false)||null,text(params.derivedFrom,'derivedFrom',false)||null,text(params.scenePath,'scenePath',false),text(params.objectPath,'objectPath'),role,
            text(params.pluginProfile,'pluginProfile',false),active,text(params.blueprintId,'blueprintId',false),new Date().toISOString());
        writeProjectState(db,projectId);this.poll();return{id};
      }
      case 'asset.list': return db.prepare(`SELECT id, path, name, kind, status, license, tags_json AS tagsJson,
        created_at AS createdAt, updated_at AS updatedAt FROM asset ORDER BY updated_at DESC, name`).all().map(row => {
          const item = row as Record<string, unknown>; return { ...item, tags: JSON.parse(String(item.tagsJson)), tagsJson: undefined };
        });
      case 'asset.save': {
        const id = typeof params.id === 'string' && params.id ? params.id : randomUUID();
        const path = text(params.path, 'path'), name = text(params.name, 'name');
        const kind = text(params.kind, 'kind'), status = text(params.status, 'status');
        if (!['avatar','outfit','texture','animation','package','other'].includes(kind)) throw new ApiError('BAD_REQUEST', '素材类型无效');
        if (!['candidate','ready','blocked','archived'].includes(status)) throw new ApiError('BAD_REQUEST', '素材状态无效');
        const tags = Array.isArray(params.tags) ? params.tags.map((tag, i) => text(tag, `tags[${i}]`)) : [];
        db.prepare(`INSERT INTO asset (id,path,name,kind,status,license,tags_json) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET path=excluded.path,name=excluded.name,kind=excluded.kind,status=excluded.status,
          license=excluded.license,tags_json=excluded.tags_json,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
          .run(id, path, name, kind, status, text(params.license, 'license', false) || 'unknown', JSON.stringify(tags));
        db.prepare(`INSERT INTO event (actor,entity_type,entity_id,action,reason,payload_json) VALUES ('human','asset',?,'saved','asset catalog updated','{}')`).run(id);
        this.poll(); return { id };
      }
      case 'asset.remove': {
        const id = text(params.id, 'id'); const result = db.prepare('DELETE FROM asset WHERE id=?').run(id);
        if (!result.changes) throw new ApiError('NOT_FOUND', `素材不存在: ${id}`);
        db.prepare(`INSERT INTO event (actor,entity_type,entity_id,action,reason,payload_json) VALUES ('human','asset',?,'removed','asset removed from catalog','{}')`).run(id);
        this.poll(); return { ok: true };
      }
      case 'booth.status': {
        const sessionPath=join(this.options.home,'config','booth-session');
        return{connected:existsSync(sessionPath),...boothCounts(db),job:this.booth?{...this.booth}:null,last:this.boothLast??null};
      }
      case 'booth.session.set': {
        const session=text(params.session,'session');
        if(!/^[\x21-\x3A\x3C-\x7E]{16,}$/.test(session))throw new ApiError('BAD_REQUEST','BOOTH 会话值格式无效');
        const path=join(this.options.home,'config','booth-session'),next=`${path}.next`;
        hostPlatform.writePrivate(next,session);renameSync(next,path);return{ok:true};
      }
      case 'booth.session.clear': {
        rmSync(join(this.options.home,'config','booth-session'),{force:true});
        return{ok:true};
      }
      // Provider credentials (providers/secrets.ts): callers may store, clear and ask which exist, never read one back.
      case 'secret.status': {
        const ids=Array.isArray(params.ids)?params.ids.map(id=>text(id,'ids[]')):[];
        try{return Object.fromEntries(ids.map(id=>[id,hasSecret(this.options.home,id)]));}
        catch(error){throw new ApiError('BAD_REQUEST',(error as Error).message);}
      }
      case 'secret.set': {
        try{writeSecret(this.options.home,text(params.id,'id'),text(params.value,'value'));}
        catch(error){throw error instanceof ApiError?error:new ApiError('BAD_REQUEST',(error as Error).message);}
        return{ok:true};
      }
      case 'secret.clear': {
        try{return{cleared:clearSecret(this.options.home,text(params.id,'id'))};}
        catch(error){throw error instanceof ApiError?error:new ApiError('BAD_REQUEST',(error as Error).message);}
      }
      case 'booth.catalog': return boothCatalog(db);
      case 'booth.sync': {
        const sessionPath=join(this.options.home,'config','booth-session');
        if(!existsSync(sessionPath))throw new ApiError('FAILED','尚未连接 BOOTH，不能同步');
        const mode=params.mode===undefined?'quick':params.mode;
        if(mode!=='quick'&&mode!=='deep')throw new ApiError('BAD_REQUEST','参数 mode 应为 quick 或 deep');
        const session=readFileSync(sessionPath,'utf8').trim();
        return this.startBooth(db,{kind:'sync'},async job=>{
          const result=await syncBoothLibrary(db,session,{...this.options.boothRequests,mode,onProgress:progress=>{job.progress=progress;}});
          // Categories, avatar tags and file kinds come from the stored index alone; a failure there does not undo the sync.
          let catalog:unknown,catalogError='';
          try{catalog=refreshAssetIndex(db);}catch(error){catalogError=`；素材归类没有完成：${(error as Error).message}`;}
          return{result:{...result,catalog},message:syncMessage(result)+catalogError};
        });
      }
      case 'booth.plan.create': {
        const raw=Array.isArray(params.files)?params.files:[];
        const files=raw.map((value,index)=>{if(!value||typeof value!=='object')throw new ApiError('BAD_REQUEST',`files[${index}] 无效`);
          const file=value as Record<string,unknown>;return{downloadableId:text(file.downloadableId,`files[${index}].downloadableId`),purpose:text(file.purpose,`files[${index}].purpose`),
            ...(file.sha256===undefined?{}:{sha256:text(file.sha256,`files[${index}].sha256`)})};});
        try{return{id:createSelectionPlan(db,{projectId:text(params.projectId,'projectId'),variantId:text(params.variantId,'variantId',false)||undefined,
          workflowId:text(params.workflowId,'workflowId',false)||undefined,rationale:text(params.rationale,'rationale',false),createdBy:params.createdBy==='human'?'human':'provider',files})};}
        catch(error){throw new ApiError('BAD_REQUEST',(error as Error).message);}
      }
      case 'booth.plan.list': return selectionPlans(db,text(params.projectId,'projectId',false));
      case 'booth.plan.materialize': {
        const sessionPath=join(this.options.home,'config','booth-session');
        if(!existsSync(sessionPath))throw new ApiError('FAILED','尚未连接 BOOTH，不能下载');
        const planId=text(params.planId,'planId'),session=readFileSync(sessionPath,'utf8').trim();
        return this.startBooth(db,{kind:'materialize',planId},async()=>{
          const files=await materializeSelection(db,planId,join(this.options.home,'materialized'),session,this.options.boothRequests);
          const fetched=files.filter(file=>file.fetched).length;
          return{result:{files},message:`已就绪 ${files.length} 个文件（下载 ${fetched} 个，复用素材池 ${files.length-fetched} 个），计划已锁定所用版本`};
        });
      }
      case 'booth.plan.release': {
        const planId=text(params.planId,'planId');
        try{releaseSelectionPlan(db,planId);}
        catch(error){throw (error as {code?:string}).code==='NOT_FOUND'?error:new ApiError('BAD_REQUEST',(error as Error).message);}
        return{ok:true};
      }
      // The version pool: what is kept and why; bytes are removed only here, on an explicit request (booth/pool.ts).
      case 'booth.pool.list': return{root:join(this.options.home,'materialized','pool'),entries:poolEntries(db)};
      case 'booth.pool.pin': {
        const sha256=text(params.sha256,'sha256');
        if(typeof params.pinned!=='boolean')throw new ApiError('BAD_REQUEST','参数 pinned 应为布尔值');
        if(!setPoolPin(db,sha256,params.pinned))throw new ApiError('NOT_FOUND',`素材池里没有这个版本: ${sha256}`);
        return{ok:true};
      }
      case 'booth.pool.remove': {
        if(this.booth)throw new ApiError('CONFLICT','BOOTH 任务进行中，结束后再清理素材池');
        const requested=Array.isArray(params.sha256)?params.sha256.map((value,index)=>text(value,`sha256[${index}]`)):[text(params.sha256,'sha256')];
        const result=removePoolBlobs(db,join(this.options.home,'materialized'),requested,{dryRun:params.dryRun===true});
        if(result.removed.length&&!result.dryRun){
          db.prepare(`INSERT INTO event (actor,entity_type,entity_id,action,reason,payload_json) VALUES ('human','booth_pool','pool','removed',?,?)`)
            .run(`removed ${result.removed.length} pool version(s) on request`,JSON.stringify({removed:result.removed,freedBytes:result.freedBytes}));
          this.poll();
        }
        return result;
      }
      case 'project.message.list': return interactionMessages(db, text(params.projectId, 'projectId'));
      case 'project.intent.list': return currentIntent(db,text(params.projectId,'projectId'));
      case 'project.message.retry': {
        const projectId = text(params.projectId, 'projectId');
        if (!Number.isSafeInteger(params.expectedRevision)) throw new ApiError('BAD_REQUEST', '会话修订号无效');
        const receipt = retryInteraction(db, projectId, { id: text(params.id, 'id'), commandId: text(params.commandId, 'commandId'),
          expectedRevision: Number(params.expectedRevision), expectedTaskId: text(params.expectedTaskId, 'expectedTaskId') });
        writeProjectState(db, projectId); this.poll(); return receipt;
      }
      case 'project.production.list': return productionProposals(db, text(params.projectId, 'projectId'), this.options.home);
      case 'project.production.versions': return continuationProgress(db, text(params.projectId,'projectId'));
      case 'project.production.delivery': return productionDelivery(db,text(params.projectId,'projectId'),text(params.workflowId,'workflowId'));
      case 'project.production.continuation.contracts': return continuationContracts(this.config!);
      case 'project.production.continuation.contract.view': return continuationContractView(db,this.config!,text(params.projectId,'projectId'),text(params.continuationId,'continuationId'),text(params.packId,'packId'));
      case 'project.production.continuation.contract.adopt': {
        const result=adoptContinuationContract(db,this.config!,text(params.projectId,'projectId'),text(params.continuationId,'continuationId'),Number(params.expectedRevision),text(params.packId,'packId'),text(params.token,'token'),text(params.note,'note'));
        this.poll();return result;
      }
      case 'project.production.continuation.changes.resolve': {
        if(!Array.isArray(params.retainOnly)||params.retainOnly.some(p=>typeof p!=='string'))throw new ApiError('BAD_REQUEST','工程修改对账无效。');
        const result=resolveRebuildChanges(db,text(params.projectId,'projectId'),text(params.continuationId,'continuationId'),Number(params.expectedRevision),text(params.reportHash,'reportHash'),params.retainOnly,text(params.note,'note'));
        this.poll();return result;
      }
      case 'project.production.continuation.resume':
      case 'project.production.continuation.cancel': {
        const result = controlContinuation(db,text(params.projectId,'projectId'),text(params.continuationId,'continuationId'),Number(params.expectedRevision),method.endsWith('.resume'));
        this.poll(); return result;
      }
      case 'project.face.manual.state': return manualFaceState(db, text(params.projectId, 'projectId'));
      case 'project.face.mode': {
        const result = await setFaceMode(db, this.config!, text(params.projectId, 'projectId'), text(params.mode, 'mode') as FaceMode, Number(params.expectedRevision));
        this.poll(); return result;
      }
      case 'project.face.manual.open': {
        const result = await openManualFace(db, this.config!, text(params.projectId, 'projectId'), Number(params.expectedRevision), text(params.targetId, 'targetId', false) || undefined);
        this.poll(); return result;
      }
      case 'project.face.manual.launch': return launchManualBlender(db, this.config!, text(params.projectId, 'projectId'), text(params.sessionId, 'sessionId'));
      case 'project.face.manual.done': {
        const result = await submitManualFace(db, this.config!, text(params.projectId, 'projectId'), text(params.sessionId, 'sessionId'), Number(params.expectedRevision));
        this.poll(); return result;
      }
      case 'project.face.manual.cancel': {
        const result = await cancelManualFace(db, this.config!, text(params.projectId, 'projectId'), text(params.sessionId, 'sessionId'));
        this.poll(); return result;
      }
      case 'project.face.manual.resume': {
        const result = await resumeManualFace(db, this.config!, text(params.projectId, 'projectId'), text(params.sessionId, 'sessionId'));
        this.poll(); return result;
      }
      case 'project.face.manual.rollback': {
        const result = rollbackManualFace(db, text(params.projectId, 'projectId'), text(params.sessionId, 'sessionId'), Number(params.expectedRevision));
        this.poll(); return result;
      }
      case 'project.face.accept': {
        const projectId = text(params.projectId, 'projectId'), workflowId = text(params.workflowId, 'workflowId');
        if (!db.prepare('SELECT 1 FROM workflow WHERE id=? AND project_id=?').get(workflowId, projectId)) throw new ApiError('NOT_FOUND', '找不到所属制作流程');
        const gate = workflowSnapshot(db, workflowId).definition.gates.find(item => item.review === 'face-output');
        if (!gate) throw new ApiError('BAD_REQUEST', '这个制作流程没有脸型效果确认');
        const result = await decideFormalGate(db, loadConfig(home), workflowId, gate.id, true, '经 GUI 接受当前工程的脸型效果',
          text(params.expectedHash, 'expectedHash'), undefined, { previewSha256: text(params.previewSha256, 'previewSha256') }, parseInputHashes(params.expectedInputs), params.expectedRevision === undefined ? undefined : Number(params.expectedRevision));
        this.poll(); return result;
      }
      case 'project.face.choose': {
        const projectId = text(params.projectId, 'projectId'), workflowId = text(params.workflowId, 'workflowId');
        if (!db.prepare('SELECT 1 FROM workflow WHERE id=? AND project_id=?').get(workflowId, projectId)) throw new ApiError('NOT_FOUND', '找不到所属制作流程');
        const gate = workflowSnapshot(db, workflowId).definition.gates.find(item => item.selection === 'face-candidate');
        if (!gate) throw new ApiError('BAD_REQUEST', '当前流程没有脸型候选选择');
        const result = await decideFormalGate(db, this.config!, workflowId, gate.id, true, '选择当前预览中的脸型候选', text(params.expectedHash, 'expectedHash'),
          { candidateId: text(params.candidateId, 'candidateId'), candidateSetSha256: text(params.candidateSetSha256, 'candidateSetSha256'), previewSha256: text(params.previewSha256, 'previewSha256') }, undefined, parseInputHashes(params.expectedInputs));
        this.poll(); return result;
      }
      case 'project.face.preview':
      case 'project.face.candidates.preview':
      case 'project.face.candidates.preview.image':
      case 'project.face.preview.image':
      case 'project.face.preview.images':
      case 'project.recolor.preview':
      case 'project.recolor.preview.images':
      case 'project.delivery.photos':
      case 'project.delivery.photos.images': {
        const input:Record<string,unknown>={projectId:text(params.projectId,'projectId'),workflowId:text(params.workflowId,'workflowId')};
        if(method.startsWith('project.recolor.'))input.expectedHash=text(params.expectedHash,'expectedHash');
        if(method.endsWith('.image')){input.previewSha256=text(params.previewSha256,'previewSha256');input.id=text(params.id,'id');}
        if(method.endsWith('.images')){
          input.previewSha256=text(params.previewSha256,'previewSha256');
          if(!Array.isArray(params.ids)||!params.ids.length||params.ids.length>24||params.ids.some(id=>typeof id!=='string'||!id))throw new ApiError('BAD_REQUEST','图片读取批次无效');
          input.ids=params.ids;
        }
        return this.previewReader.read(this.config!.stateDbPath,method,input);
      }
      case 'project.production.resume':
      case 'project.production.cancel': {
        const input={projectId:text(params.projectId,'projectId'),id:text(params.id,'id'),
          commandId:text(params.commandId,'commandId'),expectedToken:text(params.expectedToken,'expectedToken')};
        const result=await (method==='project.production.resume' ? resumeProduction : cancelProduction)(db,this.config!,input);
        writeProjectState(db,input.projectId); this.poll(); return result;
      }
      case 'project.production.approve': {
        if (!Number.isSafeInteger(params.revision)) throw new ApiError('BAD_REQUEST', '提案修订号无效');
        const workflowId = approveProduction(db, this.config!, text(params.id, 'id'), text(params.commandId, 'commandId'), Number(params.revision));
        this.poll(); return { workflowId };
      }
      case 'project.production.reject': {
        if (!Number.isSafeInteger(params.revision)) throw new ApiError('BAD_REQUEST', '提案修订号无效');
        rejectProduction(db, text(params.id, 'id'), Number(params.revision)); this.poll(); return { ok: true };
      }
      case 'project.message.session': return { revision: sessionRevision(db, text(params.projectId, 'projectId')) };
      case 'project.message.add': {
        const projectId = text(params.projectId, 'projectId'), content = text(params.content, 'content');
        if (params.expectedRevision !== undefined && (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0))
          throw new ApiError('BAD_REQUEST', '会话修订号无效');
        const receipt = submitInteraction(db, projectId, { content,
          commandId: params.commandId === undefined ? randomUUID() : text(params.commandId, 'commandId'),
          ...(params.expectedRevision === undefined ? {} : { expectedRevision: Number(params.expectedRevision) }),
          ...(params.replyTo === undefined ? {} : { replyTo: text(params.replyTo, 'replyTo') }) });
        writeProjectState(db,projectId);this.poll(); return { id: receipt.id, status: receipt.status, revision: receipt.revision };
      }
      case 'project.asset.list': return db.prepare(`SELECT a.id,a.path,a.name,a.kind,a.status,a.license,a.tags_json AS tagsJson,
        pa.role,pa.attached_at AS attachedAt FROM asset a LEFT JOIN project_asset pa ON pa.asset_id=a.id AND pa.project_id=?
        ORDER BY pa.attached_at IS NULL,pa.attached_at DESC,a.name`).all(text(params.projectId, 'projectId')).map(row=>{
          const item=row as Record<string,unknown>;return{...item,tags:JSON.parse(String(item.tagsJson)),tagsJson:undefined,attached:item.role!==null};
        });
      case 'project.asset.attach': {
        const projectId=text(params.projectId,'projectId'),assetId=text(params.assetId,'assetId');const role=text(params.role,'role');
        if(!['candidate','source','used','rejected'].includes(role))throw new ApiError('BAD_REQUEST','项目素材角色无效');
        try{db.prepare(`INSERT INTO project_asset(project_id,asset_id,role) VALUES(?,?,?) ON CONFLICT(project_id,asset_id) DO UPDATE SET role=excluded.role`).run(projectId,assetId,role);}
        catch(error){throw new ApiError('NOT_FOUND',`项目或素材不存在: ${(error as Error).message}`);}
        db.prepare(`INSERT INTO event (workflow_id,actor,entity_type,entity_id,action,reason,payload_json) VALUES
          ((SELECT id FROM workflow WHERE project_id=? ORDER BY rowid DESC LIMIT 1),'human','project_asset',?,'attached','asset linked to project',json_object('asset_id',?,'role',?))`).run(projectId,`${projectId}:${assetId}`,assetId,role);
        writeProjectState(db,projectId);this.poll();return{ok:true};
      }
      case 'project.asset.detach': {
        const projectId=text(params.projectId,'projectId'),assetId=text(params.assetId,'assetId');const result=db.prepare('DELETE FROM project_asset WHERE project_id=? AND asset_id=?').run(projectId,assetId);
        if(!result.changes)throw new ApiError('NOT_FOUND','项目没有关联这个素材');writeProjectState(db,projectId);this.poll();return{ok:true};
      }
      case 'project.import': {
        const mode=(params.mode??'observe') as RecoveryMode;if(!['observe','shallow','deep'].includes(mode))throw new ApiError('BAD_REQUEST','接手模式无效');
        const source=text(params.path,'path'),distill=params.distill===true;
        const requestedName=text(params.name,'name',false),base=basename(source).replace(/\.(?:unitypackage|zip|7z|rar|tar|gz)$/i,'');
        const material=materializeImportSource(source,this.config!.workspaceRoot,requestedName||(mode==='deep'?`${base}-Harness`:`${base}-Imported`));
        const out=await this.command(['project','import',material.projectPath,'--json',
          ...(params.profile?['--profile',text(params.profile,'profile')]:[]),'--kind',params.kind?text(params.kind,'kind'):'private']);
        const parsed=JSON.parse(out) as {report:{id:string;projectId:string;projectPath:string};briefPath:string};
        const recoveryId=randomUUID(),specPath=join(home,'run',`recovery-analysis-${recoveryId}.yaml`);
        db.prepare(`INSERT INTO project_recovery(id,project_id,source_kind,source_path,source_hash,mode,distill,status,candidate_roots_json,warnings_json)
          VALUES(?,?,?,?,?,?,?,'analysis_pending',?,?)`).run(recoveryId,parsed.report.projectId,material.sourceKind,material.source,material.sourceHash,mode,distill?1:0,JSON.stringify(material.candidateRoots),JSON.stringify(material.warnings));
        hostPlatform.writePrivate(specPath,recoveryAnalysisSpec(material.projectPath,material.sourceKind,material.candidateRoots,material.warnings));
        try{const taskOut=await this.command(['task','add',material.projectPath,'--spec',specPath]),match=/Task:\s*([0-9a-f-]{36})/.exec(taskOut);
          if(!match)throw new Error(`恢复分析任务返回无法识别：${taskOut}`);db.prepare('UPDATE project_recovery SET analysis_task_id=? WHERE id=?').run(match[1]!,recoveryId);
          // The project's archive starts from what the import observed; a busy project gets it at the next safe point.
          let archive:unknown;try{archive=await this.archiveCommand(parsed.report.projectId);}
          catch(error){archive={error:(error as Error).message};}
          return{reportId:parsed.report.id,projectId:parsed.report.projectId,project:parsed.report.projectPath,briefPath:parsed.briefPath,recoveryId,analysisTaskId:match[1],sourceKind:material.sourceKind,warnings:material.warnings,archive};
        }catch(error){db.prepare(`UPDATE project_recovery SET status='failed',warnings_json=json_insert(warnings_json,'$[#]',?) WHERE id=?`).run((error as Error).message,recoveryId);throw error;}
        finally{rmSync(specPath,{force:true});}
      }
      case 'project.recovery.list': {
        const projectId=text(params.projectId,'projectId');reconcileRecoveries(db,projectId);return db.prepare(`SELECT id,project_id AS projectId,source_kind AS sourceKind,source_path AS sourcePath,
          mode,distill,status,analysis_task_id AS analysisTaskId,apply_task_id AS applyTaskId,candidate_roots_json AS candidateRoots,warnings_json AS warnings,created_at AS createdAt
          FROM project_recovery WHERE project_id=? ORDER BY created_at DESC`).all(projectId).map(raw=>{const row=raw as Record<string,unknown>;return{...row,distill:!!row.distill,candidateRoots:JSON.parse(String(row.candidateRoots)),warnings:JSON.parse(String(row.warnings))};});
      }
      case 'project.recovery.apply': {
        const id=text(params.id,'id');const found=db.prepare('SELECT project_id FROM project_recovery WHERE id=?').get(id) as {project_id:string}|undefined;
        if(found)reconcileRecoveries(db,found.project_id);
        const row=db.prepare(`SELECT r.*,p.path FROM project_recovery r JOIN project p ON p.id=r.project_id WHERE r.id=?`).get(id) as {mode:RecoveryMode;distill:number;path:string;status:string}|undefined;
        if(!row)throw new ApiError('NOT_FOUND','恢复记录不存在');if(row.mode==='observe')throw new ApiError('BAD_REQUEST','只读观察模式没有应用阶段');
        const analysis=db.prepare(`SELECT t.status FROM project_recovery r JOIN task t ON t.id=r.analysis_task_id WHERE r.id=?`).get(id) as {status:string}|undefined;
        if(analysis?.status!=='PASSED')throw new ApiError('FAILED','AI 分析尚未通过独立检查，不能应用改造');
        // Ready means the analysis's outputs are structurally complete and its candidates are recorded; nothing more.
        if(row.status!=='ready')throw new ApiError('FAILED','AI 分析的结构化结果不完整（见恢复记录的警告），不能应用改造');
        const specPath=join(home,'run',`recovery-apply-${id}.yaml`);hostPlatform.writePrivate(specPath,recoveryApplySpec(row.mode,row.distill===1));
        try{const out=await this.command(['task','add',projectRoot(db,found!.project_id),'--spec',specPath]),match=/Task:\s*([0-9a-f-]{36})/.exec(out);if(!match)throw new Error(`恢复任务返回无法识别：${out}`);
          db.prepare(`UPDATE project_recovery SET apply_task_id=?,status='apply_pending',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(match[1]!,id);return{taskId:match[1]};
        }finally{rmSync(specPath,{force:true});}
      }
      case 'project.recovery.adoptAssets': {
        const id=text(params.id,'id');const owner=db.prepare('SELECT project_id FROM project_recovery WHERE id=?').get(id) as {project_id:string}|undefined;
        if(owner)reconcileRecoveries(db,owner.project_id);
        const row=db.prepare(`SELECT r.project_id AS projectId,p.path,t.status,r.status AS recoveryStatus FROM project_recovery r JOIN project p ON p.id=r.project_id JOIN task t ON t.id=r.analysis_task_id WHERE r.id=?`).get(id) as {projectId:string;path:string;status:string;recoveryStatus:string}|undefined;
        if(!row)throw new ApiError('NOT_FOUND','恢复记录不存在');if(row.status!=='PASSED')throw new ApiError('FAILED','AI 分类尚未通过检查');
        if(row.recoveryStatus!=='ready')throw new ApiError('FAILED','AI 分类的结构化结果不完整，不能采用素材候选');
        const project=realpathSync(projectRoot(db,row.projectId));
        const analysisPath=join(project,'_Harness','Recovery','analysis.json'),analysis=JSON.parse(readFileSync(analysisPath,'utf8')) as {classification?:string;assetCandidates?:unknown[]};
        if(!['asset_bundle','mixed'].includes(analysis.classification??''))throw new ApiError('BAD_REQUEST','AI 没有把该输入判定为素材包或混合输入');
        const acceptedKinds=new Set(['avatar','outfit','texture','animation','package','other']),created:string[]=[];
        db.exec('BEGIN IMMEDIATE');try{for(const raw of analysis.assetCandidates??[]){if(!raw||typeof raw!=='object')continue;const item=raw as Record<string,unknown>;
            if(typeof item.path!=='string'||!item.path)continue;const path=resolve(project,item.path);if(!hostPlatform.within(project,path)||!existsSync(path)||!hostPlatform.within(project,realpathSync(path)))throw new Error(`素材候选越界或不存在: ${item.path}`);
            const assetId=randomUUID(),kind=typeof item.kind==='string'&&acceptedKinds.has(item.kind)?item.kind:'other',name=typeof item.name==='string'&&item.name.trim()?item.name:basename(path);
            db.prepare(`INSERT INTO asset(id,path,name,kind,status,license,tags_json) VALUES(?,?,?,?, 'candidate',?,?)`).run(assetId,path,name,kind,typeof item.license==='string'?item.license:'unknown',JSON.stringify(['ai-classified','imported']));
            db.prepare(`INSERT INTO project_asset(project_id,asset_id,role) VALUES(?,?,'candidate')`).run(row.projectId,assetId);created.push(assetId);}
          db.exec('COMMIT');return{created,classification:analysis.classification};}catch(error){db.exec('ROLLBACK');throw error;}
      }
      case 'project.vpm.status': {
        const row=db.prepare('SELECT path FROM project WHERE id=?').get(text(params.projectId,'projectId')) as {path:string}|undefined;if(!row)throw new ApiError('NOT_FOUND','项目不存在');return vpmStatus(row.path);
      }
      case 'project.vpm.apply': {
        const projectId=text(params.projectId,'projectId'),action=text(params.action,'action') as VpmAction;if(!['check','resolve','add','remove','migrate','migrate-unity2022'].includes(action))throw new ApiError('BAD_REQUEST','VPM 操作无效');
        const row=db.prepare('SELECT path FROM project WHERE id=?').get(projectId) as {path:string}|undefined;if(!row)throw new ApiError('NOT_FOUND','项目不存在');const id=randomUUID();
        try{const output=runVpm(row.path,action,params.packageId?text(params.packageId,'packageId'):undefined,params.version?text(params.version,'version'):undefined);
          db.prepare(`INSERT INTO project_package_action(id,project_id,action,package_id,requested_version,result,detail) VALUES(?,?,?,?,?,'passed',?)`).run(id,projectId,action,typeof params.packageId==='string'?params.packageId:null,typeof params.version==='string'?params.version:null,output.slice(0,8000));return{ok:true,output,status:vpmStatus(row.path)};
        }catch(error){db.prepare(`INSERT INTO project_package_action(id,project_id,action,package_id,requested_version,result,detail) VALUES(?,?,?,?,?,'failed',?)`).run(id,projectId,action,typeof params.packageId==='string'?params.packageId:null,typeof params.version==='string'?params.version:null,(error as Error).message.slice(0,8000));throw error;}
      }
      case 'project.upload.open': {
        const projectId=text(params.projectId,'projectId');
        const row=db.prepare('SELECT path FROM project WHERE id=?').get(projectId) as {path:string}|undefined;if(!row)throw new ApiError('NOT_FOUND','项目不存在');
        // The hand-over leads to the official uploader, so it exists only once this project's Workflow has reached
        // UPLOAD_READY or finished client verification (workflow statuses, workflow/runtime.ts). The API is reachable
        // outside the GUI, so this is checked here rather than only by hiding the button (审查 X1-02).
        const workflowId=productionHead(db,projectId);
        const workflow=workflowId?db.prepare(`SELECT w.status,w.project_id FROM workflow w JOIN workflow_definition d ON d.workflow_id=w.id
          WHERE w.id=?`).get(workflowId) as {status:string;project_id:string}|undefined:undefined;
        if(!workflow || productionDispatchBlocked(db,workflowId!) || !['upload_ready','client_verified'].includes(workflow.status))
          throw new ApiError('FAILED','交付还没通过验证，暂时不能打开上传；请先把制作流程推进到 UPLOAD_READY');
        if(!this.config!.unity)throw new ApiError('FAILED','尚未配置 Unity 编辑器路径');
        const result=prepareOfficialUpload(projectRoot(db,workflow.project_id),this.config!.unity);return{...result,message:'Unity 已打开；请在官方 VRChat SDK Panel 中登录、选择账号并手动上传。Harness 不保存登录态，也不代为上传。'};
      }
      case 'project.brief': {
        const query = text(params.project, 'project');
        const row = db.prepare(`SELECT r.id, p.id AS project_id FROM import_report r JOIN project p ON p.id = r.project_id
          WHERE p.id = ? OR p.path = ? OR p.path LIKE ? ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1`)
          .get(query, query, `%/${query}`) as { id: string; project_id: string } | undefined;
        if (!row) throw new ApiError('NOT_FOUND', `项目还没有导入报告: ${query}`);
        return { markdown: handoffMarkdown(db, row.id) + projectTaskBrief(db, row.project_id, home) };
      }
      case 'project.context': {
        const result = writeProjectState(db, text(params.projectId, 'projectId'));
        return { path: result.path, compact: result.compact, state: result.state };
      }
      // The project archive (docs/project-archive.md): what is known, what is only inferred, what is missing or stale,
      // and what to do next. A read, apart from settling ended takeover analyses.
      case 'project.facts': {
        const projectId = text(params.projectId, 'projectId');
        if (!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId)) throw new ApiError('NOT_FOUND', `项目不存在: ${projectId}`);
        return archiveCall(() => { reconcileRecoveries(db, projectId); return projectOverview(db, projectId); });
      }
      case 'project.fact.confirm': {
        const projectId = text(params.projectId, 'projectId'), factId = text(params.factId, 'factId'), decision = text(params.decision, 'decision');
        if (!['confirm', 'correct', 'reject'].includes(decision)) throw new ApiError('BAD_REQUEST', '参数 decision 应为 confirm、correct 或 reject');
        if (decision === 'correct' && params.value === undefined) throw new ApiError('BAD_REQUEST', '更正需要给出 value');
        const fact = archiveCall(() => confirmFact(db, projectId, factId,
          decision === 'correct' ? { decision: 'correct', value: params.value } : { decision: decision as 'confirm' | 'reject' }, text(params.note, 'note', false)));
        const archive = projectSafePoint(db, projectId);
        this.poll();
        return { id: fact.id, status: fact.status, value: fact.value, archive: { status: archive.status, revision: archive.revision ?? null } };
      }
      case 'project.files.classify': {
        const projectId = text(params.projectId, 'projectId'), path = text(params.path, 'path'), note = text(params.note, 'note');
        const match = params.match === 'tree' ? 'tree' : 'file';
        if (!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId)) throw new ApiError('NOT_FOUND', `项目不存在: ${projectId}`);
        const written = archiveCall(() => registerEntries(db, projectId, [{ path, match, category: text(params.category, 'category', false) || 'user-classified',
          shareLayer: text(params.shareLayer, 'shareLayer') as 'A', rights: text(params.rights, 'rights') as 'unknown',
          sensitivity: (text(params.sensitivity, 'sensitivity', false) || 'normal') as 'normal', source: { type: 'user', ref: 'api:project.files.classify' },
          reason: note }]));
        db.prepare(`INSERT INTO event (actor,entity_type,entity_id,action,reason,payload_json) VALUES ('human','project_file_entry',?,'classified',?,?)`)
          .run(`${projectId}:${path}`, note, JSON.stringify({ projectId, path, match }));
        this.poll();
        return { ok: true, registered: written };
      }
      // Sharing a project that can be continued, and restoring one (docs/project-share.md). Previews, exports and
      // restores read whole projects: each runs as an `avh` command in the background, followed by project.archive.job.
      case 'project.share.preview':
      case 'project.share.export': {
        const projectId = text(params.projectId, 'projectId');
        if (!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId)) throw new ApiError('NOT_FOUND', `项目不存在: ${projectId}`);
        const preview = method === 'project.share.preview';
        return this.startArchiveJob(preview ? 'preview' : 'export', ['project', 'share', projectId, ...this.shareArgs(preview ? { ...params, out: undefined,
          recipient: undefined } : params), ...(preview ? ['--dry-run'] : [])], { projectId });
      }
      case 'project.restore.check':
      case 'project.restore': {
        const { args, file } = this.restoreArgs(params);
        return this.startArchiveJob(method === 'project.restore' ? 'restore' : 'check', ['project', 'restore', ...args,
          ...(method === 'project.restore.check' ? ['--check'] : [])], { file });
      }
      // The project diagnostics bundle (D-133). A preview compiles the whole plan in-process, so the GUI can show it
      // while a person decides; the export runs as an `avh` command because it reads and packs files. The doctor
      // reading is recorded first: the preview must list `doctor.txt` for the export's manifest to match (R28 P1-3).
      case 'project.diagnostics.preview': {
        const projectId = text(params.projectId, 'projectId');
        if (!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId)) throw new ApiError('NOT_FOUND', `项目不存在: ${projectId}`);
        await this.recordDoctorReading();
        const { previewDiagnostics } = await import('../diagnostics/diagnose.ts');
        // The CLI compiles the export with the same environment (`env.commit`), because the manifest the GUI confirms
        // must be the manifest the exporting process reproduces (R28 P1-3).
        return { plan: previewDiagnostics(db, this.config!, projectId,
          { ...this.diagnoseWindow(params), env: { home, commit: harnessVersion() } }) };
      }
      case 'project.diagnostics.export': {
        const projectId = text(params.projectId, 'projectId');
        if (!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId)) throw new ApiError('NOT_FOUND', `项目不存在: ${projectId}`);
        // A caller that previewed first hands over the manifest it confirmed; the CLI then reuses the recorded doctor
        // reading instead of running doctor again, so both compiles describe the same members. A caller that did not
        // preview leaves it out, and the CLI records the reading itself before its own preview.
        return this.startArchiveJob('diagnose', ['project', 'diagnose', projectId, ...this.diagnoseArgs(params)], { projectId });
      }
      case 'project.archive.job': return { job: this.archiveJob ? { ...this.archiveJob } : null, last: this.archiveLast ?? null };
      case 'project.share.list': {
        const { projectShares } = await import('../archive/share.ts');
        return projectShares(db, text(params.projectId, 'projectId'));
      }
      case 'project.restore.report': {
        const projectId = text(params.projectId, 'projectId');
        if (!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId)) throw new ApiError('NOT_FOUND', `项目不存在: ${projectId}`);
        const { restoreReconciliation } = await import('../archive/restore.ts');
        return archiveCall(() => restoreReconciliation(db, projectId));
      }
      case 'project.restore.complete': {
        const projectId = text(params.projectId, 'projectId');
        if (!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId)) throw new ApiError('NOT_FOUND', `项目不存在: ${projectId}`);
        const { completeRestore, restoreReconciliation } = await import('../archive/restore.ts');
        const results = completeRestore(db, { home, workspaceRoot: this.config!.workspaceRoot, workflowVariables: this.config!.workflowVariables }, projectId);
        if (results.some(item => item.bound)) projectSafePoint(db, projectId);
        this.poll();
        return { results, reconciliation: restoreReconciliation(db, projectId) };
      }
      case 'project.conversation.search': {
        const { searchConversation } = await import('../archive/restore.ts');
        return searchConversation(db, text(params.projectId, 'projectId'), text(params.query, 'query'));
      }
      // Observe, walk and write the archive now, then check it; the walk reads the whole project, so it runs as a command.
      case 'project.archive.refresh': {
        const projectId = text(params.projectId, 'projectId');
        if (!db.prepare('SELECT 1 FROM project WHERE id=?').get(projectId)) throw new ApiError('NOT_FOUND', `项目不存在: ${projectId}`);
        const result = await this.archiveCommand(projectId);
        this.poll();
        return result;
      }
      case 'workflow.context.preview': {
        const id=text(params.id,'id'),family=params.modelFamily===undefined?undefined:text(params.modelFamily,'modelFamily');
        const row=db.prepare(`SELECT w.project_id AS projectId,w.plan_json AS plan,p.path FROM workflow w
          JOIN project p ON p.id=w.project_id WHERE w.id=?`).get(id) as {projectId:string;plan:string;path:string}|undefined;
        if(!row)throw new ApiError('NOT_FOUND',`Workflow 不存在: ${id}`);
        const snapshot=workflowSnapshot(db,id),memory=projectState(db,row.projectId),plan=JSON.parse(row.plan) as Record<string,unknown>;
        const requested=params.stageId===undefined?undefined:text(params.stageId,'stageId');
        const stages=snapshot.definition.stages.filter(stage=>(!requested||stage.id===requested)&&snapshot.capabilities.stages[stage.id]!.context.length);
        if(requested&&!stages.length)throw new ApiError('NOT_FOUND',`阶段没有上下文或不存在: ${requested}`);
        return stages.map(stage=>{
          const spec=stageTaskSpec(snapshot,stage,plan,snapshot.toolRoot||this.config!.toolRoot,row.path,memory);
          const context=spec.contextPlan!;
          const compiled=compileContext(context.items,context.facts,{budgetChars:context.budgetChars,
            requiredCoverage:context.requiredCoverage,modelFamily:family});
          return{stageId:stage.id,modelFamily:family??null,usedChars:compiled.usedChars,budgetChars:compiled.budgetChars,
            coverage:compiled.coverage,decisions:compiled.decisions,text:compiled.text};
        });
      }
      case 'workflow.context.diff': {
        const id=text(params.id,'id'),family=params.modelFamily===undefined?undefined:text(params.modelFamily,'modelFamily');
        const targetRow=db.prepare(`SELECT w.rowid,w.project_id AS projectId,w.plan_json AS plan,p.path,w.knowledge_version AS version
          FROM workflow w JOIN project p ON p.id=w.project_id WHERE w.id=?`).get(id) as
          {rowid:number;projectId:string;plan:string;path:string;version:string}|undefined;
        if(!targetRow)throw new ApiError('NOT_FOUND',`Workflow 不存在: ${id}`);
        const target=workflowSnapshot(db,id),explicit=params.baseId===undefined?undefined:text(params.baseId,'baseId');
        const baseRow=(explicit?db.prepare(`SELECT w.id,w.project_id AS projectId,w.knowledge_version AS version FROM workflow w
            JOIN workflow_definition d ON d.workflow_id=w.id WHERE w.id=?`).get(explicit):
          db.prepare(`SELECT w.id,w.project_id AS projectId,w.knowledge_version AS version FROM workflow w
            JOIN workflow_definition d ON d.workflow_id=w.id WHERE w.project_id=? AND w.rowid<? ORDER BY w.rowid DESC LIMIT 1`)
            .get(targetRow.projectId,targetRow.rowid)) as {id:string;projectId:string;version:string}|undefined;
        if(explicit&&!baseRow)throw new ApiError('NOT_FOUND',`对比 Workflow 不存在: ${explicit}`);
        if(baseRow&&baseRow.projectId!==targetRow.projectId)throw new ApiError('BAD_REQUEST','只能对比同一项目的 Workflow 上下文');
        if(!baseRow)return{base:null,target:{id,knowledgeVersion:targetRow.version},modelFamily:family??null,stages:[]};
        const base=workflowSnapshot(db,baseRow.id),memory=projectState(db,targetRow.projectId),plan=JSON.parse(targetRow.plan) as Record<string,unknown>;
        const stageIds=[...new Set([...base.definition.stages.map(stage=>stage.id),...target.definition.stages.map(stage=>stage.id)])].sort();
        const stages=stageIds.map(stageId=>{
          const baseStage=base.definition.stages.find(stage=>stage.id===stageId),targetStage=target.definition.stages.find(stage=>stage.id===stageId);
          const compile=(snapshot:typeof target,stage:NonNullable<typeof targetStage>)=>{
            const spec=stageTaskSpec(snapshot,stage,plan,snapshot.toolRoot||this.config!.toolRoot,targetRow.path,memory),context=spec.contextPlan;
            if(!context)return undefined;
            const compiled=compileContext(context.items,context.facts,{budgetChars:context.budgetChars,
              requiredCoverage:context.requiredCoverage,modelFamily:family});
            const sources=new Map(context.items.map(item=>[item.spec.id,item]));
            return{compiled,sources};
          };
          const before=baseStage?compile(base,baseStage):undefined,after=targetStage?compile(target,targetStage):undefined;
          const ids=[...new Set([...(before?.compiled.decisions.map(item=>item.id)??[]),...(after?.compiled.decisions.map(item=>item.id)??[])])].sort();
          const items=ids.map(itemId=>{
            const oldDecision=before?.compiled.decisions.find(item=>item.id===itemId),newDecision=after?.compiled.decisions.find(item=>item.id===itemId);
            const oldSource=before?.sources.get(itemId),newSource=after?.sources.get(itemId);
            const oldContent=oldSource?contextItemContent(oldSource.content,oldSource.spec.heading):'',
              newContent=newSource?contextItemContent(newSource.content,newSource.spec.heading):'';
            const preciseStatus=!oldDecision?'added':!newDecision?'removed':oldDecision.selected!==newDecision.selected?'selection-changed':
              oldContent!==newContent?'content-changed':oldDecision.reason!==newDecision.reason?'reason-changed':'unchanged';
            // Unchanged items carry no text: with a full pack the texts of every item would outgrow the 8 MiB message limit.
            const shown=preciseStatus!=='unchanged';
            return{id:itemId,status:preciseStatus,before:oldDecision?{...oldDecision,sha256:oldSource?.sha256??null,content:shown?oldContent:''}:null,
              after:newDecision?{...newDecision,sha256:newSource?.sha256??null,content:shown?newContent:''}:null};
          });
          return{stageId,status:!baseStage?'added':!targetStage?'removed':items.some(item=>item.status!=='unchanged')?'changed':'unchanged',items};
        });
        return{base:{id:baseRow.id,knowledgeVersion:baseRow.version},target:{id,knowledgeVersion:targetRow.version},
          modelFamily:family??null,stages,summary:{added:stages.flatMap(stage=>stage.items).filter(item=>item.status==='added').length,
            removed:stages.flatMap(stage=>stage.items).filter(item=>item.status==='removed').length,
            changed:stages.flatMap(stage=>stage.items).filter(item=>!['added','removed','unchanged'].includes(item.status)).length}};
      }
      case 'context.telemetry': {
        const workflowId=params.workflowId===undefined?undefined:text(params.workflowId,'workflowId');
        const samples=readContextSamples(db,workflowId);
        const groups=new Map<string,{knowledgeVersion:string;modelFamily:string;stageId:string;itemId:string;runs:number;passes:number;
          firstAttempts:number;firstPasses:number;tasks:Map<string,{first:boolean;secondPass:boolean}>}>();
        for(const sample of samples.filter(isSettledContextSample))for(const item of sample.selected??[]){
          const modelFamily=sample.modelFamily??'unknown',key=[sample.knowledgeVersion,modelFamily,sample.stageId,item.id].join('\0');
          const group=groups.get(key)??{knowledgeVersion:sample.knowledgeVersion,modelFamily,stageId:sample.stageId,itemId:item.id,
            runs:0,passes:0,firstAttempts:0,firstPasses:0,tasks:new Map()};
          group.runs++;if(sample.passed)group.passes++;if(sample.attempt===1){group.firstAttempts++;if(sample.passed)group.firstPasses++;}
          const task=group.tasks.get(sample.taskId)??{first:false,secondPass:false};
          if(sample.attempt===1)task.first=true;if(sample.attempt<=2&&sample.passed)task.secondPass=true;group.tasks.set(sample.taskId,task);groups.set(key,group);
        }
        return{samples,
          groups:[...groups.values()].map(({tasks,...group})=>{const eligible=[...tasks.values()].filter(task=>task.first);return{...group,
            firstPassRate:group.firstAttempts?group.firstPasses/group.firstAttempts:null,
            secondPassRate:eligible.length?eligible.filter(task=>task.secondPass).length/eligible.length:null};}),
          diagnostics:diagnoseContext(samples)};
      }
      case 'workflow.list': return listWorkflows(db);
      case 'workflow.show': return describeWorkflow(db, text(params.id, 'id'));
      case 'workflow.stageContract.show': return stageContractView(db,this.config!,workflowSnapshot(db,text(params.id,'id')),text(params.stageId,'stageId'),text(params.packId,'packId'));
      case 'workflow.stageContract.select': {
        const result=selectStageContract(db,this.config!,workflowSnapshot(db,text(params.id,'id')),text(params.stageId,'stageId'),text(params.packId,'packId'),text(params.expectedToken,'expectedToken'),text(params.note,'note'));
        this.poll();return result;
      }
      case 'workflow.create': {
        const project = text(params.project, 'project'), profile = text(params.profile, 'profile');
        let manifest = params.manifest ? text(params.manifest, 'manifest') : '';
        let generated = false;
        if (!manifest && params.projectId) {
          const projectId = text(params.projectId, 'projectId');
          const brief = db.prepare(`SELECT customer_request AS request,face_concept AS faceConcept FROM project_brief WHERE project_id=?`).get(projectId) as {request:string;faceConcept:string}|undefined;
          if (!brief?.request.trim()) throw new ApiError('BAD_REQUEST','先在“设计目标”填写头像需求，再启动制作');
          const projectAssets = db.prepare(`SELECT a.path,a.kind,a.name FROM project_asset pa JOIN asset a ON a.id=pa.asset_id
            WHERE pa.project_id=? AND pa.role IN ('candidate','source','used') ORDER BY pa.attached_at`).all(projectId) as {path:string;kind:string;name:string}[];
          const variants = (db.prepare(`SELECT id,name,description FROM project_variant WHERE project_id=? AND status<>'archived'
            ORDER BY created_at`).all(projectId) as Array<{id:string;name:string;description:string}>).map(variant=>({ ...variant,
              assets:(db.prepare(`SELECT a.path AS item,pva.role FROM project_variant_asset pva JOIN asset a ON a.id=pva.asset_id
                WHERE pva.variant_id=? AND pva.role<>'rejected' ORDER BY pva.attached_at`).all(variant.id) as
                Array<{item:string;role:'candidate'|'source'|'used'}>) }));
          const allPaths = new Set([...projectAssets.map(asset=>asset.path),...variants.flatMap(variant=>variant.assets.map(asset=>asset.item))]);
          // Files fetched from BOOTH: the version each plan pinned, from the pool. They take their role from the product's
          // category: the base avatar, an outfit, or other.
          const {files:boothFiles,missing}=pinnedPlanFiles(db,projectId);
          if(missing.length)throw new ApiError('BAD_REQUEST',`计划锁定的 BOOTH 文件不在本机：${missing.join('、')}；先在素材页重新获取，再启动制作`);
          for(const file of boothFiles)allPaths.add(file.path);
          const boothKind=(category:string|null)=>/キャラクター|アバター|avatar|character/i.test(category??'')?'avatar':/衣装|clothing|outfit/i.test(category??'')?'outfit':'package';
          const assets = [...allPaths].map(path=>projectAssets.find(asset=>asset.path===path) ??
            (db.prepare('SELECT path,kind,name FROM asset WHERE path=?').get(path) as {path:string;kind:string;name:string}|undefined)??
            (file=>({path,kind:boothKind(file?.category??null),name:file?.name??''}))(boothFiles.find(file=>file.path===path)));
          if (!assets.length) throw new ApiError('BAD_REQUEST','至少先在“素材选择”关联一个素体或制作素材');
          manifest = join(this.options.home,'run',`gui-manifest-${randomUUID()}.yaml`);
          hostPlatform.writePrivate(manifest,stringify({schema:'manifest/0.1',profile,request:brief.request,faceConcept:brief.faceConcept,
            assets:assets.map(asset=>({store:'library',item:asset.path,role:asset.kind==='avatar'?'body':asset.kind==='outfit'?'outfit':asset.kind==='texture'?'texture':'other',
              ...(asset.name?{name:asset.name}:{})})),
            variants}),{flag:'wx'});
          generated = true;
        }
        try {
          const out = await this.command(['workflow', 'create', project, '--profile', profile,
            ...(manifest ? ['--manifest', manifest] : []),...(params.candidateId?['--candidate-pack',text(params.candidateId,'candidateId')]:[])]);
          if (params.projectId) writeProjectState(db, text(params.projectId, 'projectId'));
          return { id: /Workflow: (\S+)/.exec(out)?.[1] };
        } finally { if(generated)rmSync(manifest,{force:true}); }
      }
      case 'workflow.cancel':
        return { message: await this.command(['workflow', 'cancel', text(params.id, 'id'), '--note', text(params.note, 'note')]) };
      case 'plan.show': {
        const id = text(params.workflowId, 'workflowId');
        const revisions = db.prepare(`SELECT r.seq, r.hash, r.observed_at, r.error, r.content_json,
          EXISTS (SELECT 1 FROM gate_decision g WHERE g.workflow_id = r.workflow_id AND g.artifact_hash = r.hash) AS decided
          FROM plan_revision r WHERE r.workflow_id = ? ORDER BY r.seq`).all(id) as { seq: number; hash: string; observed_at: string;
            error: string | null; content_json: string | null; decided: number }[];
        const latest = revisions.at(-1);
        return { current: latest?.content_json ? JSON.parse(latest.content_json) as unknown : null,
          revisions: revisions.map(item => ({ seq: item.seq, hash: item.hash, observedAt: item.observed_at,
            ...(item.error ? { error: item.error } : {}), approved: Boolean(item.decided) })) };
      }
      case 'task.list': return taskRows(db, { ...(params.project ? { project: text(params.project, 'project') } : {}),
        openOnly: params.openOnly === true });
      case 'task.show': return taskDetail(db, text(params.id, 'id'), this.options.home);
      case 'task.add': return { message: await this.command(['task', 'add', text(params.project, 'project'), '--spec', text(params.spec, 'spec')]) };
      case 'task.redo': return { message: await this.command(['task', 'redo', text(params.id, 'id'),
        ...(params.note === undefined ? [] : ['--note', text(params.note, 'note')])]) };
      case 'task.cancel': return { message: await this.command(['cancel', text(params.id, 'id')]) };
      case 'task.acceptChanges': {
        const paths = Array.isArray(params.paths) ? params.paths.map((path, i) => text(path, `paths[${i}]`)) : [];
        if(params.expectedReviewToken!==undefined){
          const id=text(params.id,'id');
          if(!paths.length)throw new ApiError('BAD_REQUEST','请选择要保留的技术改动');
          if(taskReviewToken(db,id)!==text(params.expectedReviewToken,'expectedReviewToken'))throw new ApiError('STALE','技术审阅记录或文件已变化，请重新查看后确认');
          return taskAcceptChanges(db,id,text(params.note,'note'),paths);
        }
        return { message: await this.command(['task', 'accept-changes', text(params.id, 'id'), '--note', text(params.note, 'note'),
          ...paths.flatMap(path => ['--path', path])]) };
      }
      case 'task.recover': {
        const mode = params.mode === 'reconciled' ? '--reconciled' : params.mode === 'no_side_effects' ? '--no-side-effects' : undefined;
        if (!mode) throw new ApiError('BAD_REQUEST', '参数 mode 应为 no_side_effects 或 reconciled');
        return { message: await this.command(['task', 'recover', text(params.id, 'id'), mode, '--note', text(params.note, 'note'),
          ...(params.force === true ? ['--force'] : [])]) };
      }
      case 'gate.list': return gateRows(db, home);
      // Warnings are readings, not Gates: the person accepts the exact reading they were shown.
      case 'warning.list': return warningRows(db);
      case 'warning.accept': {
        const workflowId = text(params.workflowId, 'workflowId');
        const checkId = text(params.checkId, 'checkId');
        const note = text(params.note, 'note');
        const accepted = archiveCall(() => acceptWarning(db, workflowId, checkId, note,
          params.expectedVerdictId === undefined ? undefined : text(params.expectedVerdictId, 'expectedVerdictId')));
        this.poll();
        return accepted;
      }
      case 'gate.decide': {
        if (typeof params.approve !== 'boolean') throw new ApiError('BAD_REQUEST', '参数 approve 应为布尔值');
        // The person decides about what they saw: the hash they were shown must still be current.
        text(params.expectedHash, 'expectedHash');
        const gate = text(params.gate, 'gate');
        const note = text(params.note, 'note', false);
        // Reject and redo: the reason goes, as the redo note, to the stage that made the rejected version.
        const redo = !params.approve && params.redo === true ? gateStageTask(db, gate) : undefined;
        if (!params.approve && params.redo === true) {
          if (!redo) throw new ApiError('BAD_REQUEST', '这个 Gate 不属于某个阶段，不能驳回并重做');
          if (!note) throw new ApiError('BAD_REQUEST', '驳回并重做需要写明原因（会交给执行方）');
        }
        const message = await this.command(['gate', params.approve ? 'approve' : 'reject', gate,
          '--note', note || (params.approve ? '经 TUI 批准当前版本' : '经 TUI 驳回'),
          ...(params.expectedInputs === undefined ? [] : ['--expect-inputs', JSON.stringify(parseInputHashes(params.expectedInputs))]),
          ...(params.expectedFaceRevision===undefined ? [] : ['--expect-face-revision',String(Number(params.expectedFaceRevision))]),
          ...(params.expectedPreviewSha256===undefined ? [] : ['--expect-preview-hash', text(params.expectedPreviewSha256, 'expectedPreviewSha256')]),
          ...(params.expectedHash ? ['--expect-hash', text(params.expectedHash, 'expectedHash')] : [])]);
        return { message: redo ? `${message}\n${await this.command(['task', 'redo', redo, '--note', note])}` : message };
      }
      // The catalog BOOTH products and local assets share (src/assets/api.ts).
      case 'assets.items': case 'assets.facets': case 'assets.item': case 'assets.category.assign': case 'assets.avatar.decide':
      case 'assets.review.list': case 'assets.review.answer': case 'assets.taxonomy.get': case 'assets.taxonomy.propose':
      case 'assets.taxonomy.apply': case 'assets.taxonomy.reject': case 'assets.dictionary.get': case 'assets.refresh': {
        const result = assetsApi(db, method, params); this.poll(); return result;
      }
      case 'events.after': return eventsAfter(db, Number(params.seq ?? 0), Number(params.limit ?? 200));
      case 'events.recent': return recentEvents(db, Number(params.limit ?? 50));
      default: throw new ApiError('UNKNOWN_METHOD', `未知方法 ${method}`);
    }
  }
}

/** Foreground service for `avh service run` (what the systemd user unit starts). */
export async function runService(options: ServiceOptions): Promise<void> {
  const service = new RuntimeService(options);
  await service.start();
  const done = service.closed();
  const stop = (): void => { void service.stop(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  console.log(`Runtime 服务已启动：${service.endpoint}`);
  await done;
}
