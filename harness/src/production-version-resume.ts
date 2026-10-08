import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LocalConfig } from './config.ts';
import { refreshAssetSearchRoots } from './config.ts';
import { resolveExplorationResource } from './asset-exploration.ts';
import { sha256File } from './file-hash.ts';
import { productionContext } from './production-proposals.ts';
import { createWorkflow, type WorkflowSnapshot } from './workflow/runtime.ts';
import { withStateEvent } from './state/tx.ts';
import { canonicalJson } from './pack-hash.ts';
import { projectRoot } from './archive/takeover.ts';

/** Approved technical continuation compares business meaning separately from a newly authorized tool selection. */
export function productionBusinessContext(context: string): string {
  const { localMaintenance: _technicalSelection, ...business } = JSON.parse(context);
  return canonicalJson(business);
}

const conflict = (message: string): never => { throw Object.assign(new Error(message), { code: 'CONFLICT' }); };

/** Detect a new installed contract without changing the old Workflow's frozen evidence. */
export function productionVersionChanged(config: LocalConfig, snapshot: WorkflowSnapshot): boolean {
  const current = config.capabilities[snapshot.profile];
  if (!current || JSON.stringify(current) !== JSON.stringify(snapshot.capabilities) ||
      JSON.stringify(config.definitions[snapshot.profile]) !== JSON.stringify(snapshot.definition)) return true;
  return Object.entries(snapshot.tools).some(([path, hash]) => {
    try { return sha256File(join(config.toolRoot, path)) !== hash; } catch { return true; }
  }) || Object.entries(snapshot.contexts).some(([path, item]) => {
    try { return sha256File(join(config.knowledgeRoot, path)) !== item.sha256; } catch { return true; }
  });
}

/** Only pre-construction failures can start again under a new contract, keeping the original request and inputs. */
export function resumeEarlyProductionVersion(db: DatabaseSync, config: LocalConfig, snapshot: WorkflowSnapshot,
  proposalId: string, projectId: string): { workflowId: string; preserved: string } {
  const proposal = db.prepare('SELECT inputs_json,context_json FROM production_proposal WHERE id=? AND project_id=?')
    .get(proposalId, projectId)!;
  const project = projectRoot(db, projectId);
  const inputManifest = snapshot.manifest;
  if (!inputManifest) return conflict('原制作输入无法完整核对');
  const tasks = db.prepare('SELECT stage_id,status FROM task WHERE workflow_id=?').all(snapshot.workflowId);
  if (tasks.some(t => !['intake', 'plan'].includes(String(t.stage_id))) ||
      db.prepare("SELECT 1 FROM stage_completion WHERE workflow_id=? AND stage_id<>'intake' LIMIT 1").get(snapshot.workflowId) ||
      db.prepare("SELECT 1 FROM artifact_version WHERE workflow_id=? AND kind<>'assets' LIMIT 1").get(snapshot.workflowId) ||
      db.prepare("SELECT 1 FROM gate_decision WHERE workflow_id=? AND gate_id<>'material_gap_confirm' LIMIT 1").get(snapshot.workflowId))
    conflict('制作版本已更新；已有制作成果需要先核对，不能从头重做。');
  if (productionBusinessContext(productionContext(db, projectId)) !== productionBusinessContext(String(proposal.context_json))) conflict('目标或素材已改变，请先查看更新后的制作方案');
  const assets = JSON.parse(String(proposal.inputs_json)) as Array<{path: string; sha256?: string; resourceId?: string}>;
  if (assets.length !== inputManifest.assets.length) conflict('原制作输入无法完整核对');
  for (const asset of assets) {
    const frozen = inputManifest.assets.find(a => a.item === asset.path);
    if (!frozen?.sha256 || frozen.sha256 !== asset.sha256 || lstatSync(asset.path).isSymbolicLink() ||
        !lstatSync(asset.path).isFile() || sha256File(asset.path) !== asset.sha256) conflict('素材已改变，需要先重新确认制作方案');
    if (asset.resourceId && resolveExplorationResource(db, refreshAssetSearchRoots(config), projectId, asset.resourceId).path !== asset.path)
      conflict('素材目录授权已改变，暂不能继续制作');
  }
  const preserved = join(config.home, 'production', 'versions', randomUUID());
  mkdirSync(preserved, { recursive: true });
  const files: Array<{path: string; sha256: string}> = [];
  const copy = (source: string): void => {
    if (!existsSync(source)) return;
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) conflict('旧制作记录含链接，Harness 需要先核对后再继续');
    if (stat.isDirectory()) { for (const entry of readdirSync(source)) copy(join(source, entry)); return; }
    if (!stat.isFile()) conflict('旧制作记录不是普通文件，暂不能继续');
    const path = relative(project, source), hash = sha256File(source), destination = join(preserved, 'files', path);
    mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
    if (sha256File(destination) !== hash || sha256File(source) !== hash) conflict('保存旧制作记录期间发生变化，请稍后继续');
    files.push({ path, sha256: hash });
  };
  for (const path of ['_harness/intake', '_harness/plan']) copy(join(project, path));
  const manifest = join(preserved, 'manifest.json');
  writeFileSync(manifest, JSON.stringify(snapshot.manifest, null, 2), { flag: 'wx' });
  writeFileSync(join(preserved, 'evidence.json'), JSON.stringify({ schema: 'production-version-continuation/0.1',
    previousWorkflow: snapshot.workflowId, snapshot, files }, null, 2), { flag: 'wx' });
  db.prepare("UPDATE workflow SET status='cancelled' WHERE id=? AND status='active'").run(snapshot.workflowId);
  const workflowId = createWorkflow(db, config, project, snapshot.profile, manifest);
  db.prepare("UPDATE production_proposal SET workflow_id=?,status='working' WHERE id=?").run(workflowId, proposalId);
  withStateEvent(db, { actor: 'runtime', workflowId, entityType: 'production_proposal', entityId: proposalId,
    action: 'version_continued', reason: '使用已更新的制作工具继续原目标；旧失败与记录保留',
    payload: { previousWorkflow: snapshot.workflowId, workflowId, preserved, files, manifestSha256: sha256File(manifest) } }, () => {});
  return { workflowId, preserved };
}
