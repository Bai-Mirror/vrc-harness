import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { refreshAssetSearchRoots, type LocalConfig } from './config.ts';
import { projectRoot } from './archive/takeover.ts';
import { withStateEvent } from './state/tx.ts';
import { createWorkflow } from './workflow/runtime.ts';
import { currentIntent } from './project-intent.ts';
import { imageBytes, snapshotReferenceImages } from './image-inputs.ts';
import { performExploration, resolveExplorationResource, type Exploration } from './asset-exploration.ts';
import { productionProgress } from './production-recovery.ts';
import { localMaintenanceIdentity } from './local-maintenance.ts';
import { facePreference } from './face-policy.ts';

export type ProductionSelection = Omit<Extract<Exploration,{op:'select'}>,'op'>;
export type ProductionInput = { request: string; assetIds: string[]; selections?: ProductionSelection[] };
export class ProductionSelectionError extends Error {
  readonly recovery: {category:'production-selection'; invalidSelections:Array<{target:string;kind:string;
    observedKind:'directory';nextOperation:{op:'list';target:string;offset:0}}>};
  constructor(invalidSelections:ProductionSelectionError['recovery']['invalidSelections']) {
    super('制作提案选中了素材目录，需要先查看目录内实际文件再确定输入');
    this.recovery={category:'production-selection',invalidSelections};
  }
}
type AssetInput = { id: string; path: string; kind: string; name: string; role: string; sha256?: string; resourceId?: string };
type Proposal = { id: string; project_id: string; revision: number; profile: string; request: string;
  inputs_json: string; context_json: string; status: string; workflow_id: string | null; approval_command: string | null };
function conflict(message: string): never { throw Object.assign(new Error(message), { code: 'CONFLICT' }); }

/** The full editable selection, not just the subset an AI chose. Approval must notice additions and removed constraints. */
export function productionContext(db: DatabaseSync, projectId: string): string {
  const intent=currentIntent(db,projectId);
  const assets=db.prepare(`SELECT a.id,a.path,a.kind,a.name,a.status,a.license,pa.role FROM project_asset pa JOIN asset a ON a.id=pa.asset_id
      WHERE pa.project_id=? ORDER BY a.id`).all(projectId) as AssetInput[];
  const referenceImages=assets.filter(a=>a.role!=='rejected' && a.kind!=='texture' && /\.(png|jpe?g|webp)$/i.test(a.path))
    .map(a=>({assetId:a.id,sha256:imageBytes(a.path).sha256}));
  return JSON.stringify({
    ...(localMaintenanceIdentity(db,projectId)?{localMaintenance:localMaintenanceIdentity(db,projectId)}:{}),
    ...(facePreference(db, projectId) ? { faceChoice: facePreference(db, projectId) } : {}),
    ...(intent.length ? {intent} : {}),
    ...(referenceImages.length ? {referenceImages} : {}),
    brief: db.prepare('SELECT customer_request,face_concept,status FROM project_brief WHERE project_id=?').get(projectId) ?? null,
    assets,
    variants: db.prepare('SELECT id,name,description,status FROM project_variant WHERE project_id=? ORDER BY id').all(projectId),
    variantAssets: db.prepare(`SELECT va.variant_id,va.asset_id,va.role FROM project_variant_asset va JOIN project_variant v ON v.id=va.variant_id
      WHERE v.project_id=? ORDER BY va.variant_id,va.asset_id`).all(projectId),
  });
}
function digestInput(path: string): string {
  if (lstatSync(path).isSymbolicLink()) throw new Error('素材不能通过符号链接提供');
  const file = openSync(path, 'r');
  try {
    const before = fstatSync(file);
    if (!before.isFile()) throw new Error('先将素材登记为可读取的素材文件');
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let bytes: number;
    while ((bytes = readSync(file, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
    const after = fstatSync(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) conflict('素材正在改变，请稍后重新准备提案');
    return hash.digest('hex');
  } finally { closeSync(file); }
}

export function prepareProductionProposal(db: DatabaseSync, config: LocalConfig, interaction: {
  id: string; project_id: string; revision: number; input_context_json: string | null;
}, input: ProductionInput) {
  if (!db.isTransaction) throw new Error('制作候选与提案必须在同一事务内登记');
  const context = productionContext(db, interaction.project_id);
  if (context !== interaction.input_context_json) conflict('制作输入已改变，需要重新理解当前目标和素材');
  // Report all directory selections together, before registering any candidate. Never choose their contents for the AI.
  const invalidSelections=(input.selections??[]).flatMap(selection=>{
    const resource=resolveExplorationResource(db,config,interaction.project_id,selection.target);
    return lstatSync(resource.path).isDirectory()?[{target:selection.target,kind:selection.kind,
      observedKind:'directory' as const,nextOperation:{op:'list' as const,target:selection.target,offset:0 as const}}]:[];
  });
  if(invalidSelections.length)throw new ProductionSelectionError(invalidSelections);
  const selections=(input.selections??[]).map(selection=>{
    const resource=resolveExplorationResource(db,config,interaction.project_id,selection.target);
    const selected=performExploration(db,config,interaction.project_id,{op:'select',...selection}) as {assetId:string};
    return {id:selected.assetId,resourceId:resource.id};
  });
  const ids=[...input.assetIds,...selections.map(s=>s.id)];
  if (new Set(ids).size!==ids.length) throw new Error('制作提案重复选择了同一素材');
  const selectedContext=productionContext(db,interaction.project_id);
  const available = JSON.parse(selectedContext).assets as AssetInput[];
  const assets = ids.map(id => {
    const asset = available.find(a => a.id === id && a.role !== 'rejected');
    if (!asset) throw new Error('提案选择了未关联或已拒绝的素材');
    if (['blocked','archived'].includes(String(db.prepare('SELECT status FROM asset WHERE id=?').get(id)?.status)))
      throw new Error('素材已被停用，不能制作');
    const resourceId=selections.find(s=>s.id===id)?.resourceId;
    return { ...asset, sha256: digestInput(asset.path),...(resourceId?{resourceId}:{}) };
  });
  if (assets.filter(a => a.kind === 'avatar').length !== 1) throw new Error('制作提案需要明确选择一个素体');
  if (!config.capabilities[config.defaultProfile]) throw new Error('当前默认制作流程没有可用的执行能力');
  return { assets, context:selectedContext, profile: config.defaultProfile };
}
export function productionProposals(db: DatabaseSync, projectId: string, home?: string) {
  return db.prepare(`SELECT id,project_id,revision,request,status,workflow_id AS workflowId,inputs_json AS inputsJson
    FROM production_proposal WHERE project_id=? ORDER BY rowid`).all(projectId).map(row => ({ ...row,
      progress: productionProgress(db, {id:String(row.id),project_id:String(row.project_id),revision:Number(row.revision),status:String(row.status),workflow_id:row.workflowId as string|null}, home),
      project_id: undefined,
      inputs: (JSON.parse(String(row.inputsJson)) as AssetInput[]).map(a => ({ id: a.id, name: a.name, kind: a.kind })), inputsJson: undefined }));
}

export function approveProduction(db: DatabaseSync, config: LocalConfig, id: string, commandId: string, revision: number): string {
  config=refreshAssetSearchRoots(config);
  if (!commandId || commandId.length > 200 || !Number.isSafeInteger(revision)) throw new Error('批准命令或修订无效');
  const row = db.prepare('SELECT * FROM production_proposal WHERE id=?').get(id) as Proposal | undefined;
  if (!row) throw new Error('制作提案不存在');
  if (row.approval_command === commandId && row.revision === revision && row.workflow_id) return row.workflow_id;
  if (row.status !== 'proposed') conflict('提案已处理，不能重复开始制作');
  const assets = JSON.parse(row.inputs_json) as AssetInput[];
  for (const asset of assets) if (asset.resourceId && resolveExplorationResource(db,config,row.project_id,asset.resourceId).path!==asset.path)
    conflict('制作素材的来源已改变，请重新生成提案');
  if (productionContext(db,row.project_id)!==row.context_json) conflict('目标、素材或参考图已更新，请重新生成制作提案');
  const frozenInputs=JSON.parse(row.context_json);
  const referenceImages=snapshotReferenceImages(projectRoot(db,row.project_id),frozenInputs.assets);
  const expectedReferences=frozenInputs.referenceImages??[];
  if (referenceImages.length!==expectedReferences.length || referenceImages.some((image,i)=>image.sha256!==expectedReferences[i].sha256))
    conflict('参考图在准备制作输入时已改变，请重新生成提案');
  for (const asset of assets) if (digestInput(asset.path) !== asset.sha256) conflict('素材文件已改变，请重新生成提案');
  const dir = join(config.home, 'production', row.id); mkdirSync(dir, { recursive: true });
  const manifest = join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ schema: 'manifest/0.1', profile: row.profile, request: row.request,
    ...(frozenInputs.intent ? {requirements:frozenInputs.intent} : {}),
    ...(frozenInputs.brief?.status!=='archived' && typeof frozenInputs.brief?.face_concept==='string' && frozenInputs.brief.face_concept.trim()
      ? {faceConcept:frozenInputs.brief.face_concept} : {}),
    ...(referenceImages.length ? {referenceImages} : {}),
    assets: assets.map(a => ({ store: 'library', item: a.path, name: a.name, sha256: a.sha256,
      role: a.kind === 'avatar' ? 'body' : a.kind === 'outfit' ? 'outfit' : a.kind==='texture'?'texture':'other' })) }));
  return withStateEvent(db, { actor: 'human', entityType: 'production_proposal', entityId: id, action: 'approved', reason: '批准制作目标与素材',
    payload: { commandId, revision } }, () => {
    const current = db.prepare('SELECT revision FROM project_session WHERE project_id=?').get(row.project_id) as { revision: number } | undefined;
    if (current?.revision !== revision || row.revision !== revision || productionContext(db, row.project_id) !== row.context_json)
      conflict('目标或素材选择已更新，旧提案不能批准');
    const workflow = createWorkflow(db, config, projectRoot(db, row.project_id), row.profile, manifest);
    db.prepare('INSERT INTO production_head(logical_project_id,workflow_id) VALUES(?,?) ON CONFLICT(logical_project_id) DO UPDATE SET workflow_id=excluded.workflow_id').run(row.project_id, workflow);
    const updated = db.prepare("UPDATE production_proposal SET status='working',workflow_id=?,approval_command=? WHERE id=? AND status='proposed'")
      .run(workflow, commandId, id);
    if (updated.changes !== 1) conflict('提案已由另一个操作处理');
    return workflow;
  });
}
export function rejectProduction(db: DatabaseSync, id: string, revision: number): void {
  withStateEvent(db, { actor: 'human', entityType: 'production_proposal', entityId: id, action: 'rejected', reason: '不采用制作提案' }, () => {
    const updated = db.prepare("UPDATE production_proposal SET status='cancelled' WHERE id=? AND revision=? AND status='proposed'").run(id, revision);
    if (updated.changes !== 1) conflict('提案已改变或已经开始制作');
  });
}
export function reconcileProduction(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT p.id,p.project_id,p.revision,p.status,p.workflow_id,w.status AS workflow_status FROM production_proposal p JOIN workflow w ON w.id=p.workflow_id
    WHERE p.status IN ('working','ready')`).all();
  for (const row of rows) {
    const progress=productionProgress(db,{id:String(row.id),project_id:String(row.project_id),revision:Number(row.revision),
      status:String(row.status),workflow_id:String(row.workflow_id)})!;
    const previous=db.prepare(`SELECT json_extract(payload_json,'$.state') AS state FROM event WHERE entity_type='production_proposal'
      AND entity_id=? AND action='progress_changed' ORDER BY seq DESC LIMIT 1`).get(row.id)?.state;
    if(progress.state!==previous && (previous || ['interrupted','recovery_required','stopping'].includes(progress.state)))
      withStateEvent(db,{actor:'runtime',entityType:'production_proposal',entityId:String(row.id),action:'progress_changed',
        reason:progress.reason,payload:{state:progress.state}},()=>{
        db.prepare("INSERT INTO project_message(id,project_id,role,content,status) VALUES(?,?,'harness',?,'note')")
          .run(randomUUID(),row.project_id,progress.reason);
      });
    const status = row.workflow_status === 'client_verified' ? 'completed' : row.workflow_status === 'upload_ready' ? 'ready'
      : row.workflow_status === 'cancelled' ? 'cancelled' : 'working';
    if (status === row.status) continue;
    const text = status === 'ready' ? '制作流程已达到待交付状态，仍需客户端实测确认。' : status === 'completed'
      ? '这次制作已通过客户端确认。' : status === 'cancelled' ? '这次制作已取消，已有证据保留。' : '制作需要继续处理，请查看项目待办。';
    withStateEvent(db, { actor: 'runtime', entityType: 'production_proposal', entityId: String(row.id), action: status, reason: text }, () => {
      db.prepare('UPDATE production_proposal SET status=? WHERE id=?').run(status, row.id);
      db.prepare("INSERT INTO project_message(id,project_id,role,content,status) VALUES(?,?,'harness',?,'note')").run(randomUUID(), row.project_id, text);
    });
  }
}
