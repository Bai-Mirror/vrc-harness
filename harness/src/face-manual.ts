import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, copyFileSync, renameSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { setImmediate as yieldToCommands } from 'node:timers/promises';
import { join, relative } from 'node:path';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LocalConfig } from './config.ts';
import type { Check } from './process/types.ts';
import { projectRoot } from './archive/takeover.ts';
import { hostPlatform } from './host-platform.ts';
import { sha256File } from './file-hash.ts';
import { withStateEvent } from './state/tx.ts';
import { facePreference, type FaceMode } from './face-policy.ts';
import { artifactFingerprint } from './workflow/artifacts.ts';
import { buildAggregateInput } from './state/aggregate-input.ts';
import { createProject, createWorkflow, workflowSnapshot, workflowScheduler, cancelWorkflow, formalGates } from './workflow/runtime.ts';
import { createRunSupervisor } from './exec/run-supervisor.ts';
import { acceptedFaceOwner } from './workflow/inputs.ts';
import { activateFaceInput, continuationProgress, productionHead } from './production-face-continuation.ts';
import { projectFacePreview } from './face-preview.ts';

type Session = { id: string; project_id: string; parent_session_id: string | null; project_path: string; workflow_id: string | null;
  target_id: string; state: string; input_json: string | null; accepted_json: string | null; version: number | null; gui_ref: string | null; preparation_json: string | null };
const preparations = new Map<string, Promise<void>>();
const launches = new Map<string, Promise<{opened:boolean}>>();
const read = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const manualPath = (root: string, name: string): string => {
  const path = join(root, '_harness/manual-face', name);
  let current = root;
  for (const part of ['_harness', 'manual-face', name]) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('手动交接路径包含链接，未采纳。');
  }
  return path;
};
function session(db: DatabaseSync, projectId: string, id: string): Session {
  const row = db.prepare('SELECT * FROM face_manual_session WHERE id=? AND project_id=?').get(id, projectId) as Session | undefined;
  if (!row) throw new Error('找不到所属项目的手动脸型。');
  return row;
}
function assertRevision(db: DatabaseSync, projectId: string, revision: number): void {
  if ((facePreference(db, projectId)?.revision ?? 0) !== revision) throw Object.assign(new Error('脸型选择已变化，请刷新后再操作。'), { code: 'STALE' });
}
function handoffAuthority(db: DatabaseSync, row: Session, requireCompleted = true): { handoffSha256: string; baselineSha256: string } {
  if (!row.workflow_id) throw new Error('隔离副本还在准备，请稍后再试。');
  if (requireCompleted && !db.prepare("SELECT 1 FROM stage_completion WHERE workflow_id=? AND stage_id='manual_handoff'").get(row.workflow_id))
    throw new Error('交接独立检查还未完成，请稍后再试。');
  const runs = db.prepare(`SELECT r.result_json FROM run r JOIN task t ON t.id=r.task_id WHERE t.stage_id='manual_handoff'
    AND r.status='exited' AND t.workflow_id IN (SELECT workflow_id FROM event WHERE entity_type='face_manual' AND entity_id=?
    AND action IN ('opened','resumed')) ORDER BY r.rowid`).all(row.id);
  for (const run of runs) {
    if (!run.result_json) continue;
    const result = JSON.parse(String(run.result_json));
    if (result.exitStatus !== 0 || result.errorClass || result.outOfBoundsPaths?.length) continue;
    const handoffSha256 = result.outputs?.['_harness/manual-face/handoff.json'], baselineSha256 = result.outputs?.['_harness/manual-face/baseline.json'];
    if (handoffSha256 && baselineSha256) {
      if (sha256File(manualPath(row.project_path, 'handoff.json')) !== handoffSha256 || sha256File(manualPath(row.project_path, 'baseline.json')) !== baselineSha256)
        throw new Error('交接基线被改动，未采纳。请重新准备副本；旧证据保留。');
      return { handoffSha256, baselineSha256 };
    }
  }
  throw new Error('交接证据还未完成，请稍后再试。');
}
/** Derive a deterministic slice from the same face stage, checks, observers and Unity steps. */
export function manualFaceConfig(config: LocalConfig, targetId: string, handoffOnly = false): LocalConfig {
  const source = config.definitions[config.defaultProfile], caps = config.capabilities[config.defaultProfile];
  if (!source || !caps?.stages.face) throw new Error('当前制作流程没有可用的脸型工具。');
  const face = source.stages.find(stage => stage.id === 'face')!;
  const capability = caps.stages.face;
  const command = capability.command!.map(arg => arg === 'execute' ? 'manual-execute' : arg);
  const handoffCommand = capability.command!.map(arg => arg === 'execute' ? 'manual-open' : arg);
  const artifacts = { fbx: caps.artifacts.fbx!, face: { ...caps.artifacts.face!, paths: [...caps.artifacts.face!.paths, '_harness/manual-face/values.json'], includeIgnored: true },
    manual_handoff: { paths: ['_harness/manual-face/handoff.json', '_harness/manual-face/baseline.json'], includeIgnored: true },
    manual_input: { paths: ['_harness/manual-face/submitted.blend'], includeIgnored: true } };
  const definition = { ...source, id: 'manual-face', artifacts: Object.keys(artifacts),
    stages: [{ id: 'manual_handoff', needs: [], produces: ['manual_handoff'], requires: ['manual_handoff_integrity'], gates: [], invalidated_by: ['fbx'] },
      { ...face, needs: ['manual_handoff'], when: 'plan.manualReady == true', invalidated_by: ['fbx', 'manual_handoff', 'manual_input'] }],
    checks: [...source.checks.filter(check => face.requires.includes(check.id)), { id: 'manual_handoff_integrity', observe: 'manual.handoff', on: 'manual_handoff',
      scope: 'edit', rule: 'manual_handoff_valid == true', severity: 'blocking', maturity: 'tested', source: 'docs/zh/产品设计/06_交互捏脸与后台制作.md' } as Check],
    gates: source.gates.filter(gate => face.gates.includes(gate.id)),
    milestones: [{ id: 'UPLOAD_READY', requires_stages: 'all' as const, evidence_on: 'face', gates: [] }] };
  const expanded = ['_harness/manual-face/', '_harness/face/request.json', '_harness/face/request.json.writing',
    '_harness/face/selection.json', '_harness/face/selection.json.writing', '_harness/face/candidates.json', '_harness/face/candidates.json.writing',
    'Assets/_Harness/Face/Catalogs/', 'Assets/_Harness/Face/Catalogs.meta', 'Assets/_Harness/Face/CandidateSets/', 'Assets/_Harness/Face/CandidateSets.meta',
    'Assets/_Harness/Face/preview-input.json', 'Assets/_Harness/Face/preview-input.json.meta', 'Assets/_Harness/Face/preview-input.json.writing'];
  const manualCaps = { ...caps, process: 'manual-face', artifacts,
    stages: { manual_handoff: { ...capability, selectionGate: undefined, command: [...handoffCommand, '--target-id', targetId],
        allowedWrites: [...capability.allowedWrites, ...expanded], runtimeWrites: [], runtimeTemporaryWrites: [], unitySteps: [], maxRetries: 0 },
      face: { ...capability, selectionGate: undefined, command, allowedWrites: [...capability.allowedWrites, ...expanded],
        runtimeWrites: [...capability.runtimeWrites ?? [], '.vsconfig'] } },
    observers: { ...Object.fromEntries(definition.checks.filter(check => check.observe !== 'manual.handoff').map(check => [check.observe, caps.observers[check.observe]!])),
      'manual.handoff': { kind: 'command' as const, command: [...capability.command!.map(arg => arg === 'execute' ? 'manual-check' : arg), '--out', '{out}'], timeoutSec: 300 } } };
  if (handoffOnly) {
    definition.stages = definition.stages.slice(0, 1); definition.checks = definition.checks.filter(check => check.id === 'manual_handoff_integrity'); definition.gates = []; definition.milestones = [];
    manualCaps.stages = { manual_handoff: manualCaps.stages.manual_handoff } as typeof manualCaps.stages;
  }
  return { ...config, definitions: { ...config.definitions, 'manual-face': definition }, capabilities: { ...config.capabilities, 'manual-face': manualCaps } };
}

export async function setFaceMode(db: DatabaseSync, config: LocalConfig, projectId: string, mode: FaceMode, revision: number) {
  if (!['ai', 'manual', 'preserve'].includes(mode)) throw new Error('脸型选项无效。');
  projectRoot(db, projectId); assertRevision(db, projectId, revision);
  if (facePreference(db, projectId)?.mode === mode) return manualFaceState(db, projectId);
  const accepted = facePreference(db, projectId)?.acceptedSessionId;
  activateFaceInput(db, projectId, { activationId: `mode:${projectId}:${revision}:${mode}`, mode, expectedRevision: revision,
    ...(mode === 'manual' && accepted ? { manualSessionId: accepted } : {}) });
  if (mode !== 'manual') {
    const current = facePreference(db, projectId)?.currentSessionId;
    if (current) {
      const row = session(db, projectId, current);
      if (row.state !== 'accepted' && row.state !== 'cancelled') await cancelManualFace(db, config, projectId, current);
    }
  }
  return manualFaceState(db, projectId);
}

export async function openManualFace(db: DatabaseSync, config: LocalConfig, projectId: string, revision: number, targetId?: string) {
  assertRevision(db, projectId, revision);
  const currentId = facePreference(db, projectId)?.currentSessionId;
  if (currentId) {
    const current = session(db, projectId, currentId);
    const task = db.prepare('SELECT status FROM task WHERE workflow_id=? ORDER BY rowid DESC LIMIT 1').get(current.workflow_id);
    const failed = task && ['FAILED','BLOCKED','RECOVERY_REQUIRED'].includes(String(task.status));
    if (current.state === 'editing' && !failed && (!targetId || targetId === current.target_id)) return manualFaceState(db, projectId);
    if (current.state !== 'accepted' && current.state !== 'cancelled') {
      const stopped = await cancelManualFace(db, config, projectId, current.id);
      if (!stopped.confirmed) throw new Error('仍在确认旧副本停止，请稍后重新打开。');
    }
    let reusable = false;
    try {
      handoffAuthority(db, current, false);
      const descriptor = read(manualPath(current.project_path, 'handoff.json'));
      reusable = sha256File(join(projectRoot(db, projectId), '_harness/face/observation.json')) === descriptor.observationSha256
        && existsSync(descriptor.binary.path) && sha256File(descriptor.binary.path) === descriptor.binary.sha256
        && Object.entries(descriptor.tools).every(([name, hash]) => !name.includes('/') && !name.includes('\\')
          && sha256File(join(config.toolRoot, 'harness', name.endsWith('.cs') ? 'unity/Editor/' + name : name)) === hash);
    } catch { /* Changed baselines, sources or tools require a new copy. */ }
    if (reusable && current.state !== 'accepted' && current.workflow_id && existsSync(manualPath(current.project_path, 'edit.blend'))
      && (!targetId || targetId === current.target_id)) {
      assertRevision(db, projectId, revision);
      const workflowId = createWorkflow(db, manualFaceConfig(config, current.target_id, true), current.project_path, 'manual-face');
      const plan = readPlan(db, current.workflow_id); plan.manualReady = false;
      withStateEvent(db, { workflowId, actor: 'human', entityType: 'face_manual', entityId: current.id, action: 'resumed',
        reason: '重新打开已保存的手动草稿，保留旧提交与检查证据', payload: { priorInput: current.input_json ? JSON.parse(current.input_json) : null } }, () => {
        assertRevision(db, projectId, revision);
        db.prepare('UPDATE workflow SET plan_json=? WHERE id=?').run(JSON.stringify(plan), workflowId);
        db.prepare("UPDATE face_manual_session SET workflow_id=?,state='editing',input_json=NULL,gui_ref=NULL WHERE id=?").run(workflowId, current.id);
        db.prepare('UPDATE face_preference SET revision=revision+1 WHERE project_id=?').run(projectId);
      });
      return manualFaceState(db, projectId);
    }
  }
  const head = productionHead(db,projectId);
  const sourceProject = head ? String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(head)!.project_id) : projectId;
  const root = projectRoot(db, sourceProject), observationFile = join(root, '_harness/face/observation.json');
  if (!existsSync(observationFile)) throw new Error('头像工程还未准备好；Harness 完成工程准备后可在这里打开 Blender。');
  const observation = read(observationFile), targets = observation.targets as any[];
  const eyeTargets = targets.filter(target => target.eyeObservation?.status === 'source_controls_verified');
  const selected = targetId ? targets.find(target => target.targetId === targetId) : eyeTargets.length === 1 ? eyeTargets[0] : targets.length === 1 ? targets[0] : undefined;
  if (!selected) throw new Error('请选择要调整的脸部，然后在 Blender 中打开。');
  const id = randomUUID(), name = `manual-face-${id}`, destination = createProject(config, name);
  const preference = facePreference(db, projectId), parent = preference?.acceptedSessionId;
  let seed: string | undefined;
  if (parent) {
    const accepted = session(db, projectId, parent);
    if (accepted.state === 'accepted') seed = accepted.accepted_json!;
  } else {
    const previous = head ? {id:head} : undefined;
    if (previous) {
      try {
        const preview = projectFacePreview(db, sourceProject, String(previous.id));
        if (preview.status === 'ready' && preview.visuallyAccepted && preview.mode === 'design') {
          const input = read(join(root, 'Assets/_Harness/Face/design.json'));
          const design = read(join(root, input.blenderDesign.file)), keyNames = Object.fromEntries(Object.entries(input.keyMap).map(([name, id]) => [String(id), name]));
          seed = JSON.stringify({ sourceSha256: selected.mesh.sha256,
            values: Object.fromEntries(Object.entries(input.weightsUnityPercent).map(([name, value]) => [name, Number(value) / 100])),
            rangeOverrides: Object.fromEntries(Object.entries(design.rangeOverrides ?? {}).map(([key, range]) => [keyNames[key], range])) });
        }
      } catch { /* An unaccepted or stale image cannot seed authoring values. */ }
    }
  }
  const oldWorkflow = db.prepare('SELECT plan_json FROM workflow WHERE project_id=? ORDER BY rowid DESC LIMIT 1').get(projectId);
  const initialMode = preference?.mode ?? (oldWorkflow && JSON.parse(String(oldWorkflow.plan_json)).face?.mode === 'preserve' ? 'preserve' : 'ai');
  const plan = { ...(oldWorkflow ? JSON.parse(String(oldWorkflow.plan_json)) : {}), body_prefab: observation.sourcePrefab.path, face: { mode: 'design' }, manualReady: false };
  const preparation = { root, observationSha256: sha256File(observationFile), sourcePath: selected.mesh.path, sourceSha256: selected.mesh.sha256, plan, seed };
  withStateEvent(db, { actor: 'human', entityType: 'face_manual', entityId: id, action: 'preparing', reason: '记录隔离副本准备；复制期间也可停止和续作' }, () => {
    assertRevision(db, projectId, revision);
    db.prepare("INSERT INTO face_manual_session(id,project_id,parent_session_id,project_path,target_id,state,preparation_json) VALUES(?,?,?,?,?,'editing',?)")
      .run(id, projectId, parent ?? null, destination, selected.targetId, JSON.stringify(preparation));
    db.prepare(`INSERT INTO face_preference(project_id,mode,revision,current_session_id) VALUES(?,?,1,?)
      ON CONFLICT(project_id) DO UPDATE SET current_session_id=excluded.current_session_id,revision=revision+1`).run(projectId, initialMode, id);
  });
  await prepareManualClone(db, config, projectId, id);
  return manualFaceState(db, projectId);
}

async function prepareManualClone(db: DatabaseSync, config: LocalConfig, projectId: string, id: string): Promise<void> {
  const row = session(db, projectId, id), input = JSON.parse(row.preparation_json!);
  const active = () => {
    if (session(db, projectId, id).state !== 'editing' || facePreference(db, projectId)?.currentSessionId !== id)
      throw new Error('副本准备已停止，部分文件保留；可从正式入口续作。');
  };
  const work = (async () => {
    try {
      const sourceObservation = join(input.root, '_harness/face/observation.json');
      if (sha256File(sourceObservation) !== input.observationSha256) throw new Error('准备期间脸型源已变化，请重新打开副本。');
      // Yield at each source entry; cancellation waits for the in-flight file copy to finish.
      for (const directory of ['Assets', 'Packages', 'ProjectSettings', '_harness']) if (existsSync(join(input.root, directory)))
        await cp(join(input.root, directory), join(row.project_path, directory), { recursive: true, filter: async path => {
          await yieldToCommands(); active();
          if (lstatSync(path).isSymbolicLink()) throw new Error('工程包含链接，不能建立独立交接副本。');
          const local = relative(input.root, path).replaceAll('\\', '/');
          return !(local === 'Assets/_Harness/Face' || local.startsWith('Assets/_Harness/Face/')
            || local === '_harness/manual-face' || local.startsWith('_harness/manual-face/') || local.startsWith('_harness/face/blender-private')
            || /^_harness\/face\/(?:candidates|request|selection|output|quality|eyes|native-import-pending)\.json$/.test(local)
            || /^_harness\/face\/(?:preview|candidate-preview|native-import)(?:\/|$)/.test(local));
        } });
      active();
      if (sha256File(sourceObservation) !== input.observationSha256 || sha256File(join(row.project_path, '_harness/face/observation.json')) !== input.observationSha256
        || sha256File(join(row.project_path, input.sourcePath)) !== input.sourceSha256) throw new Error('复制的脸型源已变化，未采纳；请重新打开副本。');
      const editorTools = join(config.toolRoot, 'harness/unity/Editor');
      mkdirSync(join(row.project_path, 'Assets/_HarnessTools/Editor'), { recursive: true });
      for (const file of readdirSync(editorTools).filter(file => file.endsWith('.cs'))) copyFileSync(join(editorTools, file), join(row.project_path, 'Assets/_HarnessTools/Editor', file));
      mkdirSync(join(row.project_path, '_harness/manual-face'), { recursive: true });
      if (input.seed) hostPlatform.writePrivate(manualPath(row.project_path, 'seed.json'), input.seed);
      const workflowId = createWorkflow(db, manualFaceConfig(config, row.target_id, true), row.project_path, 'manual-face');
      withStateEvent(db, { workflowId, actor: 'human', entityType: 'face_manual', entityId: id, action: 'opened', reason: '隔离副本完成，进入确定性 Blender 交接' }, () => {
        active();
        db.prepare('UPDATE workflow SET plan_json=? WHERE id=?').run(JSON.stringify(input.plan), workflowId);
        db.prepare('UPDATE face_manual_session SET workflow_id=?,preparation_json=NULL WHERE id=?').run(workflowId, id);
      });
    } catch (error) {
      if (session(db, projectId, id).state === 'editing') {
        withStateEvent(db, { actor: 'runtime', entityType: 'face_manual', entityId: id, action: 'preparation_failed', reason: error instanceof Error ? error.message : String(error) }, () => {
          db.prepare("UPDATE face_manual_session SET state='cancelled' WHERE id=?").run(id);
        });
        throw error;
      }
    }
  })();
  preparations.set(id, work);
  try { await work; } finally { preparations.delete(id); }
}

export async function launchManualBlender(db: DatabaseSync, config: LocalConfig, projectId: string, id: string) {
  const pending=launches.get(id);if(pending)return pending;
  const work=launchManualBlenderOwned(db,config,projectId,id);launches.set(id,work);
  try{return await work;}finally{launches.delete(id);}
}

async function launchManualBlenderOwned(db: DatabaseSync, config: LocalConfig, projectId: string, id: string) {
  const row = session(db, projectId, id);
  if (row.state !== 'editing') throw new Error('这个版本不在等待编辑状态，请准备新的交接副本。');
  handoffAuthority(db, row);
  const descriptor = read(manualPath(row.project_path, 'handoff.json'));
  if (!existsSync(descriptor.binary.path)) throw new Error('未找到 Blender。请安装 Blender 4.2 或更新版本，然后重新检测：https://www.blender.org/download/');
  if (sha256File(descriptor.binary.path) !== descriptor.binary.sha256) throw new Error('Blender 安装已变化，请重新检测。');
  const supervisor = createRunSupervisor(join(config.home, 'runs'));
  if (row.gui_ref && supervisor.state(row.gui_ref) === 'running') return { opened: true };
  const runId = randomUUID(), runDir = join(config.home, 'runs', runId); hostPlatform.mkdirPrivate(runDir);
  const guiRef = await supervisor.launch(runId, [descriptor.binary.path, '--disable-autoexec', descriptor.blend],
    { BLENDER_USER_CONFIG: join(runDir, 'blender-config'), BLENDER_USER_SCRIPTS: join(runDir, 'blender-scripts'), BLENDER_USER_DATAFILES: join(runDir, 'blender-data') }, runDir, {});
  try {
    if(session(db,projectId,id).state!=='editing'||facePreference(db,projectId)?.currentSessionId!==id)
      throw new Error('这个编辑版本已停止或被替代，正在关闭刚打开的 Blender。');
    handoffAuthority(db,session(db,projectId,id));
  }catch(error){
    if(await supervisor.stop(guiRef)!=='confirmed')withStateEvent(db,{actor:'runtime',entityType:'face_manual',entityId:id,action:'stopping',reason:'编辑版本已失效，仍在确认刚启动的 Blender 停止'},()=>{
      db.prepare("UPDATE face_manual_session SET gui_ref=?,state='stopping' WHERE id=?").run(guiRef,id);
    });
    throw error;
  }
  withStateEvent(db, { actor: 'human', entityType: 'face_manual', entityId: id, action: 'blender_opened', reason: '已打开 Blender，等待捏好了' }, () => {
    db.prepare('UPDATE face_manual_session SET gui_ref=? WHERE id=?').run(guiRef, id);
  });
  return { opened: true };
}

export async function submitManualFace(db: DatabaseSync, config: LocalConfig, projectId: string, id: string, revision: number) {
  await launches.get(id);
  assertRevision(db, projectId, revision);
  const row = session(db, projectId, id);
  if (row.state !== 'editing') throw new Error('当前脸型已提交或停止，请从正式入口继续。');
  if (!row.workflow_id) throw new Error('隔离副本还在准备，请保存交接文件后再点捏好了。');
  const snapshot = workflowSnapshot(db, row.workflow_id), expected = buildAggregateInput(db, row.workflow_id).artifactHashes.manual_handoff;
  if (!expected || artifactFingerprint(row.project_path, snapshot.capabilities.artifacts.manual_handoff!) !== expected) throw new Error('交接证据未完成或已经变化，请重新准备。');
  const authority = handoffAuthority(db, row);
  const nextConfig = manualFaceConfig(config, row.target_id);
  const edit = manualPath(row.project_path, 'edit.blend'), submitted = manualPath(row.project_path, 'submitted.blend');
  if (existsSync(submitted)) renameSync(submitted, manualPath(row.project_path, 'submitted-prior-' + sha256File(submitted) + '.blend'));
  const temporary = manualPath(row.project_path, 'snapshot-' + randomUUID() + '.blend');
  const before = sha256File(edit); copyFileSync(edit, temporary);
  if (sha256File(edit) !== before || sha256File(temporary) !== before) throw new Error('Blender 正在保存，请保存完成后重试。');
  renameSync(temporary, submitted);
  const input = { ...authority, submittedSha256: before };
  if (row.gui_ref && await createRunSupervisor(join(config.home, 'runs')).stop(row.gui_ref) !== 'confirmed')
    throw new Error('保存副本已保留，仍在确认 Blender 停止；请稍后再点捏好了。');
  const stopped = await cancelWorkflow(db, config, row.workflow_id, '交接完成，冻结保存文件并进入确定性脸型处理');
  if (!stopped.confirmed) throw new Error('仍在确认交接作业停止，请稍后从正式入口继续。');
  assertRevision(db, projectId, revision);
  if (session(db, projectId, id).state !== 'editing' || facePreference(db, projectId)?.currentSessionId !== id)
    throw new Error('手动脸型已停止或被新的选择替代，保存文件保留；请从正式入口继续。');
  const workflowId = createWorkflow(db, nextConfig, row.project_path, 'manual-face');
  withStateEvent(db, { workflowId, actor: 'human', entityType: 'face_manual', entityId: id, action: 'submitted', reason: '捏好了，冻结键值输入并交给确定性工具' }, () => {
    assertRevision(db, projectId, revision);
    db.prepare("UPDATE face_manual_session SET workflow_id=?,state='processing',input_json=?,gui_ref=NULL WHERE id=?").run(workflowId, JSON.stringify(input), id);
    const plan = readPlan(db, row.workflow_id!); plan.manualReady = true;
    db.prepare('UPDATE workflow SET plan_json=? WHERE id=?').run(JSON.stringify(plan), workflowId);
    db.prepare("UPDATE face_preference SET mode='manual',revision=revision+1 WHERE project_id=?").run(projectId);
  });
  return manualFaceState(db, projectId);
}
function readPlan(db: DatabaseSync, id: string): any { return JSON.parse(String(db.prepare('SELECT plan_json FROM workflow WHERE id=?').get(id)!.plan_json)); }

export function manualFaceInputForDispatch(db: DatabaseSync, workflowId: string): Record<string, string> | undefined {
  const row = db.prepare("SELECT input_json FROM face_manual_session WHERE workflow_id=? AND state='processing'").get(workflowId);
  if (!row?.input_json) return undefined;
  const input = JSON.parse(String(row.input_json));
  return { AVH_MANUAL_FACE_HANDOFF_SHA256: input.handoffSha256, AVH_MANUAL_FACE_BASELINE_SHA256: input.baselineSha256, AVH_MANUAL_FACE_SUBMITTED_SHA256: input.submittedSha256 };
}

export function acceptedManualFaceForDispatch(db: DatabaseSync, projectId: string, id: string,
  frozen?: { manualValues?: string; manualValuesSha256?: string }): string {
  const row = session(db, acceptedFaceOwner(db, projectId, id), id);
  if (row.state !== 'accepted' || !row.accepted_json || (frozen && (frozen.manualValues !== row.accepted_json ||
    createHash('sha256').update(frozen.manualValues ?? '').digest('hex') !== frozen.manualValuesSha256)))
    throw new Error('冻结输入与所属项目的已接受手动脸型不一致。');
  return row.accepted_json;
}

export async function cancelManualFace(db: DatabaseSync, config: LocalConfig, projectId: string, id: string) {
  let row = session(db, projectId, id);
  if (row.state === 'accepted') return { confirmed: true };
  db.prepare("UPDATE face_manual_session SET state='stopping' WHERE id=?").run(id);
  await launches.get(id)?.catch(()=>{});
  await preparations.get(id)?.catch(() => {});
  row=session(db,projectId,id);
  const stopped = row.workflow_id ? await cancelWorkflow(db, config, row.workflow_id, '用户停止手动脸型，保留交接文件和证据') : { confirmed: true };
  const gui = row.gui_ref ? await createRunSupervisor(join(config.home, 'runs')).stop(row.gui_ref) : 'confirmed';
  const confirmed = stopped.confirmed && gui === 'confirmed';
  withStateEvent(db, { actor: 'human', entityType: 'face_manual', entityId: id, action: confirmed ? 'cancelled' : 'stopping', reason: confirmed ? '已停止，保存文件保留，可从正式入口续作' : '仍在确认进程停止' }, () => {
    db.prepare('UPDATE face_manual_session SET state=? WHERE id=?').run(confirmed ? 'cancelled' : 'stopping', id);
  });
  return { confirmed };
}

export async function resumeManualFace(db: DatabaseSync, config: LocalConfig, projectId: string, id: string) {
  const row = session(db, projectId, id);
  if (row.state !== 'cancelled') throw new Error('请先确认旧作业停止，再继续。');
  if (!row.workflow_id && row.preparation_json) {
    withStateEvent(db, { actor: 'human', entityType: 'face_manual', entityId: id, action: 'preparation_resumed', reason: '从正式入口续作保存的隔离副本准备' }, () => {
      db.prepare("UPDATE face_manual_session SET state='editing' WHERE id=?").run(id);
      db.prepare("UPDATE face_preference SET mode='manual',current_session_id=?,revision=revision+1 WHERE project_id=?").run(id, projectId);
    });
    await prepareManualClone(db, config, projectId, id);
    return manualFaceState(db, projectId);
  }
  if (!row.workflow_id) throw new Error('准备记录不完整，请在 Blender 中重新打开。');
  const workflowId = createWorkflow(db, manualFaceConfig(config, row.target_id, !row.input_json), row.project_path, 'manual-face');
  const plan = readPlan(db, row.workflow_id); plan.manualReady = Boolean(row.input_json);
  withStateEvent(db, { workflowId, actor: 'human', entityType: 'face_manual', entityId: id, action: 'resumed', reason: '从正式入口继续已保存的手动脸型' }, () => {
    db.prepare('UPDATE workflow SET plan_json=? WHERE id=?').run(JSON.stringify(plan), workflowId);
    db.prepare('UPDATE face_manual_session SET workflow_id=?,state=?,gui_ref=NULL WHERE id=?').run(workflowId, row.input_json ? 'processing' : 'editing', id);
    db.prepare("UPDATE face_preference SET mode='manual',current_session_id=?,revision=revision+1 WHERE project_id=?").run(id, projectId);
  });
  return manualFaceState(db, projectId);
}

/** Called only after the shared appearance Gate validated the current supervised preview. */
export function recordManualFaceAcceptance(db: DatabaseSync, workflowId: string, expectedRevision?: number) {
  const row = db.prepare('SELECT * FROM face_manual_session WHERE workflow_id=?').get(workflowId) as Session | undefined;
  if (!row || row.state === 'accepted') return;
  const preference = facePreference(db, row.project_id);
  if (!Number.isSafeInteger(expectedRevision)) throw new Error('请刷新脸型选择后再接受此版本。');
  assertRevision(db, row.project_id, expectedRevision!);
  if (row.state !== 'processing' || preference?.mode !== 'manual' || preference.currentSessionId !== row.id) throw new Error('这个手动版本已被新的选择替代，不能采纳。');
  const gate = formalGates(db, workflowId).find(gate => gate.review === 'face-output');
  if (gate?.status !== 'approved') throw new Error('尚未接受当前实际脸型效果。');
  const preview = projectFacePreview(db, String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(workflowId)!.project_id), workflowId);
  if (preview.status !== 'ready' || !preview.visuallyAccepted) throw new Error('当前外观证据尚未接受。');
  const values = read(manualPath(row.project_path, 'values.json'));
  handoffAuthority(db,row);
  const handoff = read(manualPath(row.project_path,'handoff.json'));
  if (values.sourceSha256 !== handoff.sourceSha256 || values.rendererPath !== handoff.rendererPath || values.meshName !== handoff.meshName)
    throw new Error('接受内容与独立交接的源身份不同，未采纳。');
  withStateEvent(db, { workflowId, actor: 'human', entityType: 'face_manual', entityId: row.id, action: 'accepted', reason: '接受新的手动脸型版本，旧版本保留' }, () => {
    const version = Number(db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM face_manual_session WHERE project_id=?').get(row.project_id)!.version);
    db.prepare("UPDATE face_manual_session SET state='accepted',version=?,accepted_json=? WHERE id=? AND state='processing'").run(version, JSON.stringify(values), row.id);
    activateFaceInput(db, row.project_id, { activationId: `accepted:${row.id}`, mode: 'manual', manualSessionId: row.id, expectedRevision: preference.revision });
  });
}

export function rollbackManualFace(db: DatabaseSync, projectId: string, id: string, revision: number) {
  const repeated = db.prepare('SELECT 1 FROM production_continuation WHERE activation_id=? AND logical_project_id=?').get(`rollback:${projectId}:${revision}:${id}`, projectId);
  if (repeated) return manualFaceState(db, projectId);
  assertRevision(db, projectId, revision); const row = session(db, projectId, id);
  if (row.state !== 'accepted') throw new Error('只能回退到已接受的脸型版本。');
  withStateEvent(db, { actor: 'human', entityType: 'face_preference', entityId: projectId, action: 'rolled_back', reason: '回退到旧的已接受脸型版本', payload: { sessionId: id, version: row.version } }, () => {
    assertRevision(db, projectId, revision);
    db.prepare('UPDATE face_preference SET current_session_id=? WHERE project_id=?').run(id, projectId);
    activateFaceInput(db, projectId, { activationId: `rollback:${projectId}:${revision}:${id}`, mode: 'manual', manualSessionId: id, expectedRevision: revision });
  });
  return manualFaceState(db, projectId);
}

export function manualFaceState(db: DatabaseSync, projectId: string) {
  const head=productionHead(db,projectId);
  const sourceProject = head ? String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(head)!.project_id) : projectId;
  const preference = facePreference(db, projectId), root = projectRoot(db, sourceProject);
  const rows = db.prepare('SELECT * FROM face_manual_session WHERE project_id=? ORDER BY rowid DESC').all(projectId) as Session[];
  const current = rows.find(row => row.id === preference?.currentSessionId);
  let status = '', reason = '', viewProjectId = '', expectedHash = '';
  let headAttachments: { checkedMeshes: number; newNearContacts: number; limitations: string[] } | undefined;
  if (current) {
    const task = db.prepare('SELECT id,stage_id,status FROM task WHERE workflow_id=? ORDER BY rowid DESC LIMIT 1').get(current.workflow_id);
    status = current.state === 'accepted' ? 'accepted' : current.state === 'cancelled' ? 'cancelled' : current.state === 'stopping' ? 'stopping'
      : current.state === 'editing' ? existsSync(manualPath(current.project_path, 'handoff.json')) && db.prepare("SELECT 1 FROM stage_completion WHERE workflow_id=? AND stage_id='manual_handoff'").get(current.workflow_id)
        ? current.gui_ref ? 'opened' : 'editing' : 'preparing' : 'processing';
    if (task && ['FAILED','BLOCKED','RECOVERY_REQUIRED'].includes(String(task.status)) && !['accepted','cancelled','stopping'].includes(status)) {
      status = 'warning';
      const run = db.prepare('SELECT id,result_json FROM run WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(task.id!);
      if (run?.result_json) { const result = JSON.parse(String(run.result_json)); reason = result.errorMessage ?? result.message ?? result.stderr ?? result.error ?? ''; }
      const location = String(db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file ?? '');
      if (location && run) {
        const log = join(dirname(dirname(location)), 'runs', String(run.id), 'stderr.log');
        if (existsSync(log)) {
          const lines = readFileSync(log, 'utf8').split(/\r?\n/).filter(line => line.includes('FACE_RUNTIME_ERROR:'));
          if (lines.length) reason = lines.at(-1)!.replace(/^.*?FACE_RUNTIME_ERROR:\s*/, '');
        }
      }
      reason ||= '处理未采纳，请查看检查证据；停止后可从正式入口续作。';
      if (reason.includes('有警告未采纳')) reason = reason.slice(reason.indexOf('有警告未采纳'));
    }
    if (current.state === 'processing' && current.workflow_id && status === 'processing') {
      const gate = formalGates(db, current.workflow_id).find(gate => gate.review === 'face-output');
      if (gate?.status === 'pending' && task?.stage_id === 'face' && ['WAITING_HUMAN','PASSED'].includes(String(task.status))) {
        const id = String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(current.workflow_id)?.project_id ?? '');
        try {
          const preview = projectFacePreview(db, id, current.workflow_id);
          if (preview.status === 'ready') { status = 'awaiting'; expectedHash = gate.artifactHash ?? ''; }
          else { status = 'warning'; reason = preview.reason; }
        } catch (error) { status = 'warning'; reason = error instanceof Error ? error.message : String(error); }
      }
    }
    viewProjectId = current.workflow_id ? String(db.prepare('SELECT project_id FROM workflow WHERE id=?').get(current.workflow_id)?.project_id ?? '') : '';
    if (['awaiting','accepted'].includes(status)) {
      try {
        const path = join(current.project_path, '_harness/face/head-attachments.json'), result = task && db.prepare('SELECT result_json FROM run WHERE task_id=? ORDER BY attempt DESC LIMIT 1').get(task.id!);
        const receipt = result?.result_json && JSON.parse(String(result.result_json));
        if (receipt?.outputs?.['_harness/face/head-attachments.json'] === sha256File(path)) {
          const report = read(path);
          headAttachments = { checkedMeshes: report.renderers.length, newNearContacts: report.renderers.reduce((sum: number, row: any) => sum + row.newNearContacts, 0), limitations: report.limitations };
        }
      } catch { /* A missing or changed report cannot claim a completed attachment recheck. */ }
    }
  }
  let targets: Array<{ id: string; name: string }> = [];
  try {
    const all = read(join(root, '_harness/face/observation.json')).targets;
    const verified = all.filter((target: any) => target.eyeObservation?.status === 'source_controls_verified');
    const eligible = verified.length ? verified : all.filter((target: any) => target.meshSnapshot.keys?.length);
    targets = eligible.map((target: any) => ({ id: target.targetId, name: target.rendererPath.split('/').at(-1) || target.meshSnapshot.name }));
  } catch { /* Source preparation may still be pending. */ }
  const history=head?[]:db.prepare("SELECT plan_json FROM workflow WHERE project_id=? AND process_id<>'manual-face' AND process_hash<>'avh-task/0.1'").all(projectId);
  const prior = head ? db.prepare('SELECT plan_json FROM workflow WHERE id=?').get(head) : history.length===1?history[0]:undefined;
  const plannedMode = prior ? JSON.parse(String(prior.plan_json)).face?.mode : undefined;
  return { production: continuationProgress(db, projectId), mode: preference?.mode ?? (plannedMode === 'preserve' ? 'preserve' : 'ai'), revision: preference?.revision ?? 0, acceptedSessionId: preference?.acceptedSessionId ?? null,
    current: current ? { id: current.id, workflowId: current.workflow_id ?? '', status, reason, expectedHash, viewProjectId,
      blendPath: manualPath(current.project_path, 'edit.blend'), projectPath: current.project_path, ...(headAttachments ? { headAttachments } : {}) } : null,
    versions: rows.filter(row => row.state === 'accepted').map(row => ({ id: row.id, version: row.version, workflowId: row.workflow_id, projectPath: row.project_path })),
    targets, blender: { minimumVersion: '4.2', downloadUrl: 'https://www.blender.org/download/' } };
}
