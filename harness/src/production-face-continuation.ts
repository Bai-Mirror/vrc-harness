import {missingStageContractReason} from './archive/stage-contract.ts';
import {relocateProductionAssets} from './production-face-assets.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, linkSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { LocalConfig } from './config.ts';
import { projectRoot } from './archive/takeover.ts';
import { inTransaction } from './archive/facts.ts';
import { facePreference, type FaceMode } from './face-policy.ts';
import { activateFaceInput as adoptInput, acceptedFaceIdentity, resolveWorkflowInput, readRunInputSnapshot, inputSha256 } from './workflow/inputs.ts';
import { workflowSnapshot, workflowScheduler, forkFrozenWorkflow } from './workflow/runtime.ts';
import { buildAggregateInput, aggregateWorkflow } from './state/aggregate-input.ts';
import { artifactFingerprint } from './workflow/artifacts.ts';
import { sha256File } from './file-hash.ts';
import { canonicalJson } from './pack-hash.ts';
import { withStateEvent } from './state/tx.ts';
import { SchedulerLeaseLostError } from './state/scheduler-lease.ts';
import { hostPlatform } from './host-platform.ts';
import { selectedStageContract } from './workflow/stage-contract.ts';
import {preparationEvidenceContract} from './workflow/preparation-evidence.ts';
import {advanceFrozenRebuild,resumeRebuildPreparation,verifiedGeneratedFiles,type RebuildPreparation} from './production-face-rebuild.ts';

export type ProductionFile = { path: string; sha256: string; deleted?: boolean };
type File = ProductionFile;
type ReconciliationHistory = {sourceFiles?: File[];report:RebuildPreparation['report'];resolutions?:RebuildPreparation['resolutions']};
type Preparation = { refreshRequested?: boolean; reconciliationHistory?: ReconciliationHistory[]; source: string; destination: string; files: File[]; snapshot: ReturnType<typeof workflowSnapshot>; sourceKind?: 'baseline_copy'; checkpoint?: 'reconcile' | 'publish'; predecessorSource?: string; sourceFiles?: File[]; report?: RebuildPreparation['report']; resolutions?: RebuildPreparation['resolutions'] };
export type Continuation = { id: string; activation_id: string; logical_project_id: string; predecessor_workflow_id: string;
  predecessor_project_id: string; target_revision_id: string | null; input_json: string; successor_project_id: string | null;
  successor_workflow_id: string | null; preparation_json: string | null; state: string; error: string | null };
function conflict(message: string): never { throw Object.assign(new Error(message), { code: 'CONFLICT' }); }
const safeStages = ['intake', 'plan', 'environment', 'setup'];
const caches = new Set(['.git', 'Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'UserSettings', '_harness_build']);

/** The logical order owns one persistent production pointer. Ambiguity is a recovery problem, not a latest-row rule. */
export function productionHead(db: DatabaseSync, logicalProjectId: string): string | undefined {
  const head = db.prepare('SELECT workflow_id FROM production_head WHERE logical_project_id=?').get(logicalProjectId);
  if (head) return String(head.workflow_id);
  const proposals = db.prepare(`SELECT DISTINCT workflow_id FROM production_proposal WHERE project_id=?
    AND workflow_id IS NOT NULL AND status<>'cancelled'`).all(logicalProjectId);
  const candidates = proposals.length ? proposals : db.prepare(`SELECT id AS workflow_id FROM workflow WHERE project_id=?
    AND process_id<>'manual-face' AND process_hash<>'avh-task/0.1' AND status IN ('active','upload_ready','client_verified')`).all(logicalProjectId);
  if (candidates.length > 1) return conflict('存在多个制作目标，需要先核对生产谱系。');
  if (!candidates[0]) return undefined;
  const id = String(candidates[0].workflow_id);
  db.prepare('INSERT INTO production_head(logical_project_id,workflow_id) VALUES(?,?)').run(logicalProjectId, id);
  return id;
}

/** Preference CAS, formal input invalidation and continuation outbox are one transaction, including Gate callers. */
export function activateFaceInput(db: DatabaseSync, projectId: string,
  request: { activationId: string; mode: FaceMode; manualSessionId?: string; expectedRevision: number }) {
  return inTransaction(db, () => {
    const prior = db.prepare('SELECT * FROM production_continuation WHERE activation_id=?').get(request.activationId);
    const payload = canonicalJson({ mode: request.mode, manualSessionId: request.manualSessionId ?? null });
    if (prior) {
      if (prior.logical_project_id !== projectId || prior.input_json !== payload) conflict('采用请求已经记录了不同的内容。');
      return String(prior.id);
    }
    const preference = facePreference(db, projectId);
    if ((preference?.revision ?? 0) !== request.expectedRevision) throw Object.assign(new Error('脸型选择已变化，请刷新后再操作。'), { code: 'STALE' });
    if (request.mode === 'manual' && request.manualSessionId) acceptedFaceIdentity(db, projectId, request.manualSessionId);
    const workflowId = productionHead(db, projectId);
    withStateEvent(db, { actor: 'human', entityType: 'face_preference', entityId: projectId, action: 'activated',
      reason: '采用脸型要求并安排受管制作', payload: { ...request } }, () => {
      db.prepare(`INSERT INTO face_preference(project_id,mode,revision,accepted_session_id) VALUES(?,?,1,?)
        ON CONFLICT(project_id) DO UPDATE SET mode=excluded.mode,revision=revision+1,
        accepted_session_id=excluded.accepted_session_id`).run(projectId, request.mode, request.mode === 'manual' ? request.manualSessionId ?? preference?.acceptedSessionId ?? null : null);
    });
    if (!workflowId) return undefined;
    const workflow = db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflowId)!;
    if (request.manualSessionId) bindManualInput(db, String(workflow.project_id), projectId, request.manualSessionId);
    const snapshot = workflowSnapshot(db, workflowId);
    const compatible = snapshot.capabilities.artifacts.face_input?.source?.kind === 'runtime';
    const target = compatible ? adoptInput(db, workflowId, { activationId: request.activationId,
      mode: request.mode === 'ai' ? 'design' : request.mode === 'manual' && request.manualSessionId ? 'manual' : 'preserve',
      manualSessionId: request.manualSessionId }) : undefined;
    const id = randomUUID();
    db.prepare(`INSERT INTO production_continuation(id,activation_id,logical_project_id,predecessor_workflow_id,
      predecessor_project_id,target_revision_id,input_json,state) VALUES(?,?,?,?,?,?,?,'requested')`)
      .run(id, request.activationId, projectId, workflowId, workflow.project_id!, target?.revisionId ?? null, payload);
    // Earlier work retains evidence but cannot start a redundant successor for an obsolete target.
    db.prepare(`UPDATE production_continuation SET state='superseded' WHERE logical_project_id=? AND id<>?
      AND state IN ('requested','waiting','preparing','failed')`).run(projectId, id);
    return id;
  });
}

function bindManualInput(db: DatabaseSync, projectId: string, logicalProjectId: string, sessionId: string): void {
  if (projectId === logicalProjectId) return;
  const lineage = db.prepare(`SELECT id FROM production_continuation WHERE logical_project_id=? AND successor_project_id=?
    AND state='applied'`).get(logicalProjectId, projectId);
  if (!lineage) return conflict('手动输入缺少可验证的生产谱系。');
  db.prepare('INSERT OR IGNORE INTO face_manual_binding(project_id,session_id,continuation_id) VALUES(?,?,?)')
    .run(projectId, sessionId, lineage.id!);
}

/** Pending adoption prevents all further dispatch in a predecessor; reconciliation still confirms existing writers. */
export function productionDispatchBlocked(db: DatabaseSync, workflowId: string): boolean {
  if (db.prepare(`SELECT 1 FROM production_archive_reference a JOIN workflow w ON w.project_id=a.project_id
    WHERE w.id=? AND json_array_length(json_extract(a.document_json,'$.missingInputs'))>0`).get(workflowId)) return true;
  return Boolean(db.prepare(`SELECT 1 FROM production_continuation WHERE predecessor_workflow_id=?
    AND (state IN ('requested','waiting','preparing','failed','cancelled') OR state='applied' AND successor_workflow_id IS NOT NULL) LIMIT 1`).get(workflowId));
}
export function productionProjectIdle(db: DatabaseSync, projectId: string): boolean {
  return !db.prepare(`SELECT 1 FROM run r JOIN task t ON t.id=r.task_id JOIN workflow w ON w.id=t.workflow_id
    WHERE w.project_id=? AND r.status NOT IN ('exited','abandoned','cancelled') LIMIT 1`).get(projectId)
    && !db.prepare(`SELECT 1 FROM lock l JOIN run r ON r.id=l.run_id JOIN task t ON t.id=r.task_id
      JOIN workflow w ON w.id=t.workflow_id WHERE w.project_id=? LIMIT 1`).get(projectId)
    && !db.prepare(`SELECT 1 FROM task t JOIN workflow w ON w.id=t.workflow_id WHERE w.project_id=?
      AND t.status IN ('RUNNING','VERIFYING','RECOVERY_REQUIRED') LIMIT 1`).get(projectId);
}

/** Only regular, relative project members enter a manifest; unknown manual edits are retained byte for byte. */
export function productionFilesAt(root: string, retainOutputs=false): File[] {
  const files: File[] = [];
  const walk = (path: string) => {
    const source = join(root, path), stat = lstatSync(source);
    if (stat.isSymbolicLink()) conflict('工程包含链接，需要先核对后再准备后继。');
    if (stat.isDirectory()) {
      for (const name of readdirSync(source).sort()) {
        const child = path ? `${path}/${name}` : name;
        if (!path && caches.has(name) && (!retainOutputs || !['Build','Builds','_harness_build'].includes(name)) || !retainOutputs && (child === '_harness/state' || child === '_harness/records' || child === '_harness/evidence'
          || child === '_harness/environment/cache' || child === '_harness/environment/candidates'
          || child === '_harness/archive.json' || child === 'Packages/nadena.dev.ndmf/__Generated' || child === 'Assets/ZZZ_GeneratedAssets')) continue;
        walk(child);
      }
    } else if (stat.isFile()) files.push({ path, sha256: sha256File(source) });
    else conflict('工程含非普通文件，准备已停止。');
  };
  walk(''); return files;
}
/**
 * How long a "the project is still idle" verdict is reused before the query is asked again. `productionProjectIdle`
 * is three queries and one of them scans the Task table, whose rows carry whole prompts, so a check reads megabytes of
 * database pages: measured at 10.7 ms per check against 0.14 ms once those pages are cached. A baseline copy asked it
 * once per file, and a 25,237-file baseline therefore read on the order of a hundred gigabytes of pages and held one
 * scheduler round for fifteen minutes (SCH2 profile: a frozen lease cycle while the renewal timer kept firing,
 * ~450 MB/s of 4 KB page reads and no new events — the copy runs inside `beforeDispatch`, before the RUNNING fact is
 * written). Only a "still idle" verdict is reused, and only inside its window: a "not idle" verdict is never reused,
 * so the copy stops on the next file the guard is asked about. The window is a bounded blind spot the caller accepts
 * in exchange for not reading megabytes per file; the copied bytes and the final project listing are still verified.
 */
export const BASELINE_IDLE_RECHECK_MS = 250;
export function idleOnCadence(check: () => boolean, windowMs = BASELINE_IDLE_RECHECK_MS): () => boolean {
  let checkedAt = 0;
  let idle = false;
  return () => {
    if (idle && Date.now() - checkedAt < windowMs) return true;
    checkedAt = Date.now();
    idle = check();
    return idle;
  };
}
export async function copyProductionManifest(source: string, destination: string, files: File[], stillValid: () => boolean) {
  for (const file of files) {
    if (!stillValid()) conflict('准备已停止，旧工程和已复制内容保留。');
    if (!file.path || file.path.split('/').some(part => !part || part === '.' || part === '..') || file.path.includes('\\') || file.path.includes(':')) conflict('准备清单路径无效。');
    const from = join(source, file.path), to = join(destination, file.path);
    if (lstatSync(from).isSymbolicLink() || sha256File(from) !== file.sha256) conflict('准备基线内容已变化。');
    for (const root of [source, destination]) {
      let parent = root;
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) conflict('准备目录不能是链接。');
      for (const part of file.path.split('/').slice(0,-1)) {
        parent = join(parent,part);
        if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) conflict('准备文件路径不能穿过链接。');
      }
    }
    mkdirSync(dirname(to), { recursive: true });
    if (existsSync(to)) {
      if (lstatSync(to).isSymbolicLink() || sha256File(to) !== file.sha256) conflict('后继准备内容与保存的清单不同。');
    } else {
      const pending = `${to}.avh-copying`;
      if (existsSync(pending)) {
        if (!lstatSync(pending).isFile() || lstatSync(pending).isSymbolicLink()) conflict('未完成复制的路径身份无法核对。');
        unlinkSync(pending);
      }
      await copyFile(from, pending, constants.COPYFILE_EXCL);
      if (sha256File(pending) !== file.sha256 || sha256File(from) !== file.sha256) conflict('复制期间源内容发生变化。');
      if(!stillValid())conflict('准备已停止，旧工程和已复制内容保留。');
      // A hard-link publication is atomic and fails if another writer created the target during the await.
      linkSync(pending,to);unlinkSync(pending);
    }
    await setImmediate();
  }
}

const idle=productionProjectIdle,filesAt=productionFilesAt,copyManifest=copyProductionManifest;

/** Called before the first face Run, after setup verification, outside the dispatch transaction. */
export async function ensureProductionBaseline(db: DatabaseSync, config: LocalConfig, workflowId: string): Promise<void> {
  const snapshot = workflowSnapshot(db, workflowId);
  if (snapshot.profile === 'manual-face' || !snapshot.definition.stages.some(stage => stage.id === 'setup')) return;
  const projectId = String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflowId)!.project_id);
  const current = db.prepare('SELECT * FROM production_baseline WHERE workflow_id=?').get(workflowId);
  if (current?.state === 'ready') return;
  if (!idle(db, projectId)) conflict('制作仍有未确认的写入，暂不能保存脸型制作基线。');
  if (db.prepare(`SELECT 1 FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=? AND t.stage_id IN ('face','face_design') LIMIT 1`).get(workflowId))
    conflict('旧制作没有脸型前基线，需要按冻结输入重建准备阶段。');
  if (aggregateWorkflow(db, workflowId, snapshot.definition).stages.setup?.status !== 'passed') conflict('工程准备尚未通过，不能保存基线。');
  const root = projectRoot(db, projectId);
  const manifest = current ? JSON.parse(String(current.manifest_json)) : { files: filesAt(root), input: buildAggregateInput(db, workflowId).artifactHashes,
    contract: canonicalJson({ definition: snapshot.definition, capabilities: snapshot.capabilities, tools: snapshot.tools }) };
  const destination = current ? String(current.path) : join(config.home, 'production', 'baselines', workflowId);
  db.prepare(`INSERT INTO production_baseline(workflow_id,source_workflow_id,path,manifest_json,state) VALUES(?,?,?,?,'copying')
    ON CONFLICT(workflow_id) DO UPDATE SET state='copying',error=NULL`).run(workflowId, workflowId, destination, JSON.stringify(manifest));
  try {
    // The idle verdict is the expensive part of this loop's guard, so it is asked on a cadence; the copy still
    // consults the guard for every file, so a caller that stops the copy is answered as promptly as before.
    await copyManifest(root, destination, manifest.files, idleOnCadence(() => idle(db, projectId)));
    if (canonicalJson(filesAt(root)) !== canonicalJson(manifest.files)) conflict('保存基线期间工程发生变化。');
    db.prepare("UPDATE production_baseline SET state='ready' WHERE workflow_id=?").run(workflowId);
  } catch (error) {
    db.prepare("UPDATE production_baseline SET state='failed',error=? WHERE workflow_id=?").run((error as Error).message, workflowId); throw error;
  }
}

/** Revalidate restored content instead of making an archive's missing-baseline flag a permanent stop. */
export function revalidateProductionArchive(db:DatabaseSync,projectId:string):void {
  const retained=db.prepare('SELECT document_json FROM production_archive_reference WHERE project_id=?').get(projectId);
  if(!retained)return;
  const document=JSON.parse(String(retained.document_json)),missing:string[]=document.missingInputs??[];
  const verified=(workflowId:string)=>{
    const baseline=db.prepare("SELECT path,manifest_json FROM production_baseline WHERE workflow_id=? AND state='ready'").get(workflowId);
    if(!baseline)return false;
    try {const manifest=JSON.parse(String(baseline.manifest_json)),snapshot=workflowSnapshot(db,workflowId);
      return manifest.contract===canonicalJson({definition:snapshot.definition,capabilities:snapshot.capabilities,tools:snapshot.tools})
        &&canonicalJson(filesAt(manifest.referencePath??String(baseline.path)))===canonicalJson(manifest.files);
    }catch{return false;}
  };
  const head=db.prepare('SELECT workflow_id FROM production_head WHERE logical_project_id=?').get(projectId)?.workflow_id;
  const descends=(workflowId:string,ancestor:string):boolean=>{
    const visited=new Set<string>();let current=workflowId;
    while(!visited.has(current)){if(current===ancestor)return true;visited.add(current);
      const previous=db.prepare("SELECT predecessor_workflow_id FROM production_continuation WHERE logical_project_id=? AND successor_workflow_id=? AND state='applied'").get(projectId,current);
      if(!previous)return false;current=String(previous.predecessor_workflow_id);
    }return false;
  };
  const remaining=missing.filter(item=>{
    if(!item.startsWith('baseline-content:'))return true;
    const source=item.slice('baseline-content:'.length);
    return !verified(source)&&!(head&&head!==source&&descends(String(head),source)&&verified(String(head)));
  });
  if(remaining.length!==missing.length)db.prepare('UPDATE production_archive_reference SET document_json=? WHERE project_id=?')
    .run(JSON.stringify({...document,missingInputs:remaining,recoveredMissingInputs:[...new Set([...(document.recoveredMissingInputs??[]),...missing.filter(item=>!remaining.includes(item))])]}),projectId);
}

/** Consume in the existing service loop. Copies are restartable and no workflow is visible before preparation commits. */
export async function advanceProductionContinuations(db: DatabaseSync, config: LocalConfig, mayContinue: () => boolean = () => true,
  guard: () => void = () => {}): Promise<void> {
  // Every branch below writes the state store. The serving cycle passes its lease check so a cycle that lost the
  // lease stops instead of publishing a continuation under the new owner; a lost lease is rethrown, never recorded
  // as this continuation's failure.
  guard();
  for(const archive of db.prepare('SELECT project_id FROM production_archive_reference').all())revalidateProductionArchive(db,String(archive.project_id));
  // Reuse the existing cancellation protocol; revoking publication alone cannot claim an active writer stopped.
  for(const stopped of db.prepare("SELECT successor_workflow_id FROM production_continuation WHERE state IN ('cancelled','superseded') AND successor_workflow_id IS NOT NULL").all()) {
    if(!mayContinue())return;
    guard();
    const workflowId=String(stopped.successor_workflow_id);
    const tasks=db.prepare("SELECT id FROM task WHERE workflow_id=? AND status IN ('PENDING','READY','RUNNING','VERIFYING','RECOVERY_REQUIRED','WAITING_HUMAN')").all(workflowId);
    if(!tasks.length)continue;
    const scheduler=workflowScheduler(db,config,workflowId);
    for(const task of tasks) {if(!mayContinue())return;await scheduler.cancelTask(String(task.id),'Continuation cancelled or superseded; preserve unpublished engineering and evidence');}
  }
  const rows = db.prepare("SELECT * FROM production_continuation WHERE state IN ('requested','waiting','preparing','failed') ORDER BY rowid").all() as Continuation[];
  for (const candidate of rows) {
    if (!mayContinue()) return;
    guard();
    const row=db.prepare("SELECT * FROM production_continuation WHERE id=? AND state IN ('requested','waiting','preparing','failed')").get(candidate.id) as Continuation|undefined;
    if(!row)continue;
    const stillCurrent=()=>db.prepare('SELECT workflow_id FROM production_head WHERE logical_project_id=?').get(row.logical_project_id)?.workflow_id===row.predecessor_workflow_id
      && !missingStageContractReason(db,row.predecessor_project_id)
      && db.prepare('SELECT state FROM production_continuation INDEXED BY production_continuation_state WHERE id=?').get(row.id)?.state==='preparing'
      && (!row.target_revision_id || db.prepare('SELECT id FROM workflow_input_revision WHERE workflow_id=? ORDER BY revision DESC LIMIT 1').get(row.predecessor_workflow_id)?.id===row.target_revision_id);
    const missingContract=missingStageContractReason(db,row.predecessor_project_id);
    if(missingContract) {db.prepare("UPDATE production_continuation SET state='waiting',error=? WHERE id=?").run(missingContract,row.id);continue;}
    if (!idle(db, row.predecessor_project_id)) {
      db.prepare("UPDATE production_continuation SET state='waiting' WHERE id=?").run(row.id); continue;
    }
    try {
      const input = JSON.parse(row.input_json);
      let snapshot = workflowSnapshot(db, row.predecessor_workflow_id);
      const executed = db.prepare(`SELECT 1 FROM task t JOIN run r ON r.task_id=t.id WHERE t.workflow_id=?
        AND t.stage_id NOT IN ('intake','plan','environment','setup') LIMIT 1`).get(row.predecessor_workflow_id);
      if (!executed && row.target_revision_id) {
        db.prepare("UPDATE production_continuation SET state='applied' WHERE id=?").run(row.id); continue;
      }
      let baseline = db.prepare("SELECT * FROM production_baseline WHERE workflow_id=? AND state='ready'").get(row.predecessor_workflow_id);
      if(baseline) {
        const input=JSON.parse(String(baseline.manifest_json)).input as Record<string,string>;
        const root=projectRoot(db,row.predecessor_project_id);
        // A pre-face baseline cannot substitute an older approved plan for the current one.
        const approved=snapshot.definition.stages.filter(stage=>['intake','plan'].includes(stage.id)).flatMap(stage=>stage.produces);
        if(approved.some(kind=>input[kind]!==artifactFingerprint(root,snapshot.capabilities.artifacts[kind]!)))baseline=undefined;
      }
      let rebuilt:RebuildPreparation|undefined;
      if(!baseline || !row.target_revision_id || row.preparation_json && JSON.parse(row.preparation_json).sourceKind==='frozen_rebuild') {
        rebuilt=await advanceFrozenRebuild(db,config,row,snapshot,mayContinue);
        if(!rebuilt)continue;
        snapshot=workflowSnapshot(db,rebuilt.candidateWorkflowId!);
        await ensureProductionBaseline(db,config,snapshot.workflowId);
        baseline=db.prepare("SELECT * FROM production_baseline WHERE workflow_id=? AND state='ready'").get(snapshot.workflowId);
        row.successor_project_id=rebuilt.candidateProjectId!;row.successor_workflow_id=rebuilt.candidateWorkflowId!;
      }
      if(!baseline)conflict('准备基线尚未完成，原工程和交付保留。');
      const baselineManifest = JSON.parse(String(baseline.manifest_json));
      const contract = canonicalJson({ definition: snapshot.definition, capabilities: snapshot.capabilities, tools: snapshot.tools });
      if (baselineManifest.contract !== contract) conflict('基线合同与当前冻结制作不一致，需要重新准备。');
      const preparation: Preparation = rebuilt ? {source:String(baseline!.path),destination:rebuilt.destination,files:baselineManifest.files,snapshot}
        : row.preparation_json ? JSON.parse(row.preparation_json) : {
        source: baselineManifest.referencePath ?? String(baseline.path), destination: join(config.workspaceRoot, `continuation-${row.id}`),
        files: baselineManifest.files, snapshot, sourceKind: 'baseline_copy', predecessorSource: projectRoot(db,row.predecessor_project_id), sourceFiles: filesAt(projectRoot(db,row.predecessor_project_id),true) };
      if(!rebuilt) {
        // Older persisted copy checklists acquire a current predecessor inventory at the same confirmed safe point.
        preparation.sourceKind='baseline_copy';
        preparation.predecessorSource??=projectRoot(db,row.predecessor_project_id);
        preparation.sourceFiles??=filesAt(preparation.predecessorSource,true);
        db.prepare("UPDATE production_continuation SET state='preparing',preparation_json=?,error=NULL WHERE id=?")
          .run(JSON.stringify(preparation), row.id);
        if(preparation.refreshRequested) {
          // A formal resume requests inventory refresh; only the consumer at a confirmed safe point performs it.
          if(!mayContinue() || !stillCurrent() || !idle(db,row.predecessor_project_id))continue;
          inTransaction(db,()=>{
            if(!stillCurrent() || !idle(db,row.predecessor_project_id))conflict('前驱仍有未确认写入，暂不刷新对账。');
            const sourceFiles=filesAt(preparation.predecessorSource!,true);
            const historical={sourceFiles:preparation.sourceFiles,report:preparation.report,resolutions:preparation.resolutions};
            withStateEvent(db,{workflowId:row.predecessor_workflow_id,actor:'runtime',entityType:'production_continuation',entityId:row.id,
              action:'reconciliation_invalidated',reason:'已确认安全点，旧报告与决定保留为历史，正在重新对账',payload:{previous:historical,sourceFiles}},()=>{
              if(preparation.report)preparation.reconciliationHistory=[...(preparation.reconciliationHistory??[]),historical];
              preparation.sourceFiles=sourceFiles;
              delete preparation.report;delete preparation.resolutions;delete preparation.checkpoint;delete preparation.refreshRequested;
              db.prepare('UPDATE production_continuation SET preparation_json=?,revision=revision+1 WHERE id=?').run(JSON.stringify(preparation),row.id);
            });
          });
        }
        // Same guard, same cadence for its database part: `mayContinue` and `stillCurrent` stay per file.
        const projectIdle = idleOnCadence(() => idle(db, row.predecessor_project_id));
        await copyManifest(preparation.source, preparation.destination, preparation.files,
          () => mayContinue() && stillCurrent() && projectIdle());
      }
      if(!rebuilt) {
        if(!preparation.sourceFiles || !preparation.predecessorSource)conflict('旧复制清单缺少前驱对账，需要重新核对后再发布。');
        if(canonicalJson(filesAt(preparation.predecessorSource,true))!==canonicalJson(preparation.sourceFiles))conflict('对账期间前驱工程已变化，不能发布旧报告。');
        if(!preparation.report) {
          const candidateFiles=filesAt(preparation.destination),candidate=new Map(candidateFiles.map(f=>[f.path,f.sha256]));
          const current=new Map(preparation.sourceFiles.map(f=>[f.path,f.sha256]));
          const generated=verifiedGeneratedFiles(db,row.predecessor_project_id,snapshot,preparation.predecessorSource),known=new Map(generated.map(f=>[f.path,f.sha256]));
          const unknown=preparation.sourceFiles.filter(f=>candidate.get(f.path)!==f.sha256 && known.get(f.path)!==f.sha256);
          unknown.push(...preparation.files.filter(f=>!current.has(f.path)).map(f=>({...f,deleted:true})));
          const report={unknown,candidateFiles,generated};
          preparation.report={...report,hash:inputSha256(canonicalJson(report))};preparation.checkpoint='reconcile';
          db.prepare('UPDATE production_continuation SET preparation_json=?,revision=revision+1 WHERE id=?').run(JSON.stringify(preparation),row.id);
        }
        if(preparation.report.unknown.length && preparation.resolutions?.reportHash!==preparation.report.hash)continue;
        preparation.checkpoint='publish';
        db.prepare('UPDATE production_continuation SET preparation_json=? WHERE id=?').run(JSON.stringify(preparation),row.id);
      }
      if (!mayContinue() || !stillCurrent()) continue;
      if (canonicalJson(filesAt(preparation.destination)) !== canonicalJson(preparation.files)) conflict('后继工程内容与基线清单不同。');
      if (!existsSync(join(preparation.destination, '.git'))) execFileSync(hostPlatform.toolCommand('git'), ['init', '-q', preparation.destination]);
      // The copy and reconcile above are long. Publishing the successor is a state-store write: check ownership here.
      guard();
      inTransaction(db, () => {
        if(!stillCurrent())conflict('采用目标已变化，旧准备内容保留。');
        if(!rebuilt && canonicalJson(filesAt(preparation.predecessorSource!,true))!==canonicalJson(preparation.sourceFiles))conflict('发布前前驱工程已变化，必须重新核对。');
        if(rebuilt&&(canonicalJson(filesAt(rebuilt.destination))!==canonicalJson(rebuilt.report!.candidateFiles)||canonicalJson(filesAt(rebuilt.source,true))!==canonicalJson(rebuilt.sourceFiles)))conflict('发布前工程内容已变化，必须重新核对报告。');
        if (!idle(db, row.predecessor_project_id)) conflict('旧制作出现未确认写入，暂不启用后继。');
        const projectId = rebuilt ? row.successor_project_id! : randomUUID(), workflowId = rebuilt ? row.successor_workflow_id! : randomUUID();
        const oldProject = db.prepare('SELECT * FROM project WHERE id=?').get(row.predecessor_project_id)!;
        if(!rebuilt){db.prepare(`INSERT INTO project(id,workspace_id,kind,path,identity_json,lifecycle,harness_version,knowledge_version)
          VALUES(?,?,?,?,?,'active',?,?)`).run(projectId, oldProject.workspace_id!, oldProject.kind!, preparation.destination, oldProject.identity_json!, oldProject.harness_version!, oldProject.knowledge_version!);
        forkFrozenWorkflow(db,row.predecessor_workflow_id,projectId,workflowId,relocateProductionAssets(snapshot,projectRoot(db,row.predecessor_project_id),preparation.destination,preparation.files));}
        db.prepare('UPDATE production_continuation SET successor_project_id=?,successor_workflow_id=? WHERE id=?').run(projectId, workflowId, row.id);
        if (input.manualSessionId) db.prepare('INSERT OR IGNORE INTO face_manual_binding(project_id,session_id,continuation_id) VALUES(?,?,?)').run(projectId, input.manualSessionId, row.id);
        adoptInput(db, workflowId, { activationId: row.activation_id, mode: input.mode === 'ai' ? 'design' : input.mode === 'manual' && input.manualSessionId ? 'manual' : 'preserve', manualSessionId: input.manualSessionId });
        // Carry stage selections as explicit provenance, never select the currently installed pack.
        for (const selected of rebuilt ? [] : db.prepare("SELECT entity_id,payload_json FROM event WHERE workflow_id=? AND entity_type='stage_contract' AND action='selected' ORDER BY seq").all(row.predecessor_workflow_id)) {
          const payload = JSON.parse(String(selected.payload_json));
          payload.selection.snapshot = {...relocateProductionAssets(payload.selection.snapshot,projectRoot(db,row.predecessor_project_id),preparation.destination,preparation.files),workflowId};
          withStateEvent(db, { workflowId, actor: 'human', entityType: 'stage_contract', entityId: String(selected.entity_id), action: 'selected', reason: '继承前驱已批准工具选择', payload }, () => {});
        }
        for (const [kind, spec] of Object.entries(snapshot.capabilities.artifacts)) {
          if (spec.source?.kind === 'runtime') continue;
          const hash = artifactFingerprint(preparation.destination, spec);
          if (hash) db.prepare('INSERT INTO artifact_version(workflow_id,kind,hash) VALUES(?,?,?)').run(workflowId, kind, hash);
        }
        const hashes = buildAggregateInput(db, workflowId).artifactHashes;
        const sourceId = String(baseline.source_workflow_id), source = workflowSnapshot(db, sourceId);
        const sourceState = aggregateWorkflow(db, sourceId, source.definition);
        for (const stageId of safeStages) {
          if(sourceId===workflowId)continue;
          const stage = snapshot.definition.stages.find(stage => stage.id === stageId);
          const completion = db.prepare('SELECT seq,artifact_hashes_json,run_id FROM stage_completion WHERE workflow_id=? AND stage_id=? ORDER BY seq DESC LIMIT 1').get(sourceId, stageId);
          if (!stage || !completion || sourceState.stages[stageId]?.status !== 'passed') continue;
          const recorded = JSON.parse(String(completion.artifact_hashes_json));
          if (stage.invalidated_by.some(kind => recorded[kind] !== hashes[kind]) || stage.produces.some(kind => baselineManifest.input[kind] !== hashes[kind])) continue;
          if (canonicalJson(source.definition.stages.find(stage => stage.id === stageId)) !== canonicalJson(stage)) continue;
          const before = selectedStageContract(db, source, stageId, String(completion.run_id)).snapshot;
          const after = selectedStageContract(db, {...snapshot, workflowId}, stageId).snapshot;
          if (canonicalJson(preparationEvidenceContract(before,stageId)) !== canonicalJson(preparationEvidenceContract(after,stageId))) continue;
          db.prepare('INSERT INTO production_evidence_reuse VALUES(?,?,?,?)').run(workflowId, stageId, sourceId, completion.seq!);
        }
        if(!rebuilt)db.prepare(`INSERT INTO production_baseline(workflow_id,source_workflow_id,path,manifest_json,state) VALUES(?,?,?,?, 'ready')`)
          .run(workflowId, sourceId, join(config.home, 'production', 'baseline-ref', workflowId), JSON.stringify({ ...baselineManifest, referencePath: baselineManifest.referencePath ?? baseline.path }));
        // The retained original baseline is shared by reference, not copied from an assembled predecessor.

        db.prepare("UPDATE workflow SET status='cancelled' WHERE id=? AND status IN ('active','upload_ready')").run(row.predecessor_workflow_id);
        db.prepare('UPDATE production_head SET workflow_id=? WHERE logical_project_id=?').run(workflowId, row.logical_project_id);
        db.prepare('UPDATE production_proposal SET workflow_id=? WHERE project_id=? AND workflow_id=?').run(workflowId, row.logical_project_id, row.predecessor_workflow_id);
        withStateEvent(db, { workflowId, actor: 'runtime', entityType: 'production_continuation', entityId: row.id, action: 'applied',
          reason: '后继工程已准备，正在按采用输入重新制作', payload: { predecessorWorkflowId: row.predecessor_workflow_id, workflowId, projectId } }, () => {
          db.prepare("UPDATE production_continuation SET state='applied',error=NULL WHERE id=?").run(row.id);
        });
      });
    } catch (error) {
      // A lost lease is not this continuation's failure: the round stops and the state store keeps its record.
      if (error instanceof SchedulerLeaseLostError) throw error;
      db.prepare("UPDATE production_continuation SET state='failed',error=? WHERE id=? AND state NOT IN ('cancelled','superseded')")
        .run((error as Error).message, row.id);
    }
  }
}

export function controlContinuation(db: DatabaseSync, projectId: string, continuationId: string, expectedRevision: number, resume: boolean) {
  return inTransaction(db, () => {
    if ((facePreference(db, projectId)?.revision ?? 0) !== expectedRevision) conflict('脸型要求已变化，请刷新后再操作。');
    const row = db.prepare('SELECT * FROM production_continuation WHERE id=? AND logical_project_id=?').get(continuationId,projectId) as Continuation|undefined;
    if (!row || ['applied','superseded'].includes(String(row.state))) conflict('这次续接已完成或被新的要求替代。');
    if(resume)resumeRebuildPreparation(db,row!);
    withStateEvent(db,{actor:'human',entityType:'production_continuation',entityId:continuationId,action:resume?'resume_requested':'cancel_requested',
      reason:resume?'继续准备当前要求的制作版本':'停止续接，保留当前要求与已有工程'},()=>{
      if(resume && row!.preparation_json) {
        const preparation=JSON.parse(row!.preparation_json!);
        if(preparation.sourceKind!=='frozen_rebuild') {
          preparation.refreshRequested=true;
          db.prepare('UPDATE production_continuation SET preparation_json=? WHERE id=?').run(JSON.stringify(preparation),continuationId);
        }
      }
      db.prepare('UPDATE production_continuation SET state=?,error=NULL WHERE id=?').run(resume?'requested':'cancelled',continuationId);
    });
    return continuationProgress(db,projectId);
  });
}

export function continuationProgress(db: DatabaseSync, projectId: string) {
  revalidateProductionArchive(db,projectId);
  const head = db.prepare('SELECT workflow_id FROM production_head WHERE logical_project_id=?').get(projectId);
  const current = db.prepare('SELECT id,state,error,successor_workflow_id,target_revision_id,preparation_json FROM production_continuation WHERE logical_project_id=? ORDER BY rowid DESC LIMIT 1').get(projectId);
  const preparation=current?.preparation_json?JSON.parse(String(current.preparation_json)):undefined;
  const deliveries = db.prepare(`SELECT d.* FROM production_delivery d WHERE d.project_id=? OR d.project_id IN
    (SELECT successor_project_id FROM production_continuation WHERE logical_project_id=?) ORDER BY accepted_at DESC`).all(projectId,projectId);
  const retained = db.prepare('SELECT document_json FROM production_archive_reference WHERE project_id=?').get(projectId);
  const archived = retained ? JSON.parse(String(retained.document_json)) : undefined;
  const workflowId = head ? String(head.workflow_id) : null;
  const input = workflowId ? resolveWorkflowInput(db, workflowId) : undefined;
  const preference=facePreference(db,projectId);
  let requirement: unknown;
  const missingInputs=[...archived?.missingInputs ?? []];
  try {requirement=preference?.mode==='manual' && preference.acceptedSessionId ? acceptedFaceIdentity(db,projectId,preference.acceptedSessionId) : preference ? {schema:'face-input/0.1',mode:preference.mode==='ai'?'design':preference.mode==='manual'?'manual':'preserve'} : input?.faceIdentity;}
  catch {missingInputs.push(`accepted-session:${preference?.acceptedSessionId}`);}
  const completed=workflowId && db.prepare('SELECT status FROM workflow WHERE id=?').get(workflowId)?.status==='client_verified';
  let making:{workflowId:string;runId?:string;mode:string;manualVersion?:number;inputHash?:string;preparing:boolean}|null=null;
  const makerId=preparation?.candidateWorkflowId && current?.state==='preparing'?String(preparation.candidateWorkflowId):workflowId;
  if(makerId) {
    const active=db.prepare(`SELECT r.id FROM run r JOIN task t ON t.id=r.task_id WHERE t.workflow_id=?
      AND r.attempt=(SELECT MAX(attempt) FROM run WHERE task_id=t.id)
      AND (r.status IN ('intended','running') OR t.status='VERIFYING') ORDER BY r.rowid DESC LIMIT 1`).get(makerId);
    if(active || makerId!==workflowId || !completed && (!current||current.state==='applied')) {
      try {
      const frozen=active?readRunInputSnapshot(db,String(active.id)):undefined;
      if(active&&!frozen)throw new Error('Missing producing Run input');
      const effective=active?undefined:resolveWorkflowInput(db,makerId);
      const face=active?frozen?.plan.face:effective?.faceIdentity;
      const identity=face?.mode==='manual'?acceptedFaceIdentity(db,projectId,String(face.manualSessionId)):face;
      making={workflowId:makerId,...(active?{runId:String(active.id)}:{}),mode:identity?.mode??'unknown',
        ...(identity?.manualVersion?{manualVersion:identity.manualVersion}:{}),
        inputHash:frozen?.baseline.face_input??effective?.faceInputHash,preparing:makerId!==workflowId};
      }catch {
        missingInputs.push(`producing-input:${active?.id??makerId}`);
        making={workflowId:makerId,...(active?{runId:String(active.id)}:{}),mode:'unknown',preparing:makerId!==workflowId};
      }
    }
  }
  return { workflowId, requirement: requirement ?? null, making, deliveries: deliveries.map(d=>({workflowId:d.workflow_id,projectId:d.project_id,
    packageHash:d.package_hash,faceInputHash:d.face_input_hash,acceptedAt:d.accepted_at})), lastDelivery: deliveries[0]?.workflow_id ?? null,
    ...(missingInputs.length ? {missingInputs} : {}),
    application: current ? { id: current.id, state: current.state,
    needsContract:!current.target_revision_id&&!current.successor_workflow_id,
    ...(preparation?.report || preparation?.sourceKind==='frozen_rebuild'?{rebuild:{checkpoint:preparation.checkpoint,report:preparation.report??null}}:{}),
    reason: missingStageContractReason(db,projectId) ?? (current.state === 'applied' ? completed ? '当前要求的交付物已完成并接受。' : '已采用脸型要求，正在制作对应版本。' : current.state === 'failed' ? `准备未完成，已有工程和交付保留：${current.error}`
      : current.state === 'cancelled' ? '续接已停止，当前要求和已有交付保留。' : preparation?.checkpoint==='reconcile' && !preparation.resolutions ? '已准备后继工程；需要核对无法解释的前驱工程修改，才会制作新交付。' : preparation?.sourceKind==='frozen_rebuild' ? '正在按原素材和批准方案重建工程准备，已有交付保留。' : '已记录脸型要求，将在确认旧制作安全停止后准备对应版本。') } : null };
}
/** An unpublished rebuild may execute preparation but cannot create or execute a new face/delivery. */
export function productionStageDispatchAllowed(db: DatabaseSync,workflowId:string,stageId:string):boolean {
  const candidate=db.prepare('SELECT state,preparation_json,predecessor_project_id FROM production_continuation WHERE successor_workflow_id=?').get(workflowId);
  if(candidate && missingStageContractReason(db,String(candidate.predecessor_project_id)))return false;
  if(!candidate || candidate.state==='applied')return true;
  const preparation=candidate.preparation_json?JSON.parse(String(candidate.preparation_json)):undefined;
  return candidate.state==='preparing' && preparation?.sourceKind==='frozen_rebuild' && ['environment','setup'].includes(stageId);
}

/** Read an accepted delivery through the logical order's durable ownership, including retained predecessors. */
export function productionDelivery(db: DatabaseSync,projectId:string,workflowId:string) {
  const delivery=db.prepare(`SELECT d.* FROM production_delivery d WHERE d.workflow_id=? AND (d.project_id=? OR
    d.project_id IN (SELECT successor_project_id FROM production_continuation WHERE logical_project_id=?))`).get(workflowId,projectId,projectId);
  if(!delivery)conflict('这份交付物不属于当前项目的已接受版本。');
  const root=projectRoot(db,String(delivery!.project_id)),snapshot=workflowSnapshot(db,workflowId);
  const spec=snapshot.capabilities.artifacts.delivery_package ?? snapshot.capabilities.artifacts.package;
  const currentHash=spec ? artifactFingerprint(root,spec) : undefined;
  const paths=(spec?.paths??[]).map(path=>({path:join(root,path),exists:existsSync(join(root,path))}));
  return {workflowId,acceptedAt:delivery!.accepted_at,packageHash:delivery!.package_hash,faceInputHash:delivery!.face_input_hash,
    verified:currentHash===delivery!.package_hash,paths};
}
