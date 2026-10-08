import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sha256File } from '../file-hash.ts';
import { describeWorkflow } from '../workflow/view.ts';
import type { FactView } from './contract.ts';
import { factViews, latestFormalWorkflow } from './facts.ts';
import { archiveStatus, type ArchiveStatus } from './projection.ts';
import { projectRoot, TAKEOVER_FACTS_FILE } from './takeover.ts';

/**
 * What the project archive tells a person now, in five parts: known facts, inferences to confirm, missing
 * dependencies, evidence that went stale, and the next steps. A read: nothing is written.
 */
export interface OverviewFact {
  id: string; objectId: string; attribute: string; value: unknown; text: string;
  status: FactView['status']; effectiveStatus: FactView['effectiveStatus']; evidenceLevel: FactView['evidenceLevel'];
  confidence: number | null; source: FactView['source']; locator: FactView['locator']; observedAt: string; scope: string;
  shareLayer: FactView['shareLayer'];
  /** Why the fact no longer holds (stale ones). */
  staleBecause?: string[];
  /** The analysis's own reasoning for a takeover candidate, while its file still holds what was recorded. */
  basis?: string;
  presentation?: 'diagnostic';
}
export interface MissingDependency { kind: 'vpm' | 'unity' | 'dependency' | 'asset'; id: string; text: string; factId?: string; pending?: boolean }
export interface NextStep { kind: string; text: string; ref?: string }
export interface ProjectOverview {
  projectId: string;
  known: OverviewFact[]; inferred: OverviewFact[]; missing: MissingDependency[]; stale: OverviewFact[]; unknown: OverviewFact[];
  next: NextStep[];
  archive: ArchiveStatus;
  recoveries: Array<{ id: string; status: string; warnings: string[] }>;
}

const short = (value: unknown, max = 80): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const key = (objectId: string): string => objectId.slice(objectId.indexOf(':') + 1);
/** One line a person reads for a fact. */
export function factText(fact: Pick<FactView, 'objectId' | 'attribute' | 'value' | 'effectiveStatus'>): string {
  const value = fact.value as Record<string, unknown> | string | null;
  const unknown = fact.effectiveStatus === 'unknown';
  const type = fact.objectId.split(':')[0];
  switch (`${fact.objectId.includes(':') ? `${type}:*` : fact.objectId}/${fact.attribute}`) {
    case 'project/unity.version': return unknown ? 'Unity 版本：未知（没有 ProjectVersion.txt）' : `Unity 版本：${short(value)}`;
    case 'project/vpm.locked': return unknown ? 'VPM 依赖：未知（没有 vpm-manifest.json）' : `VPM 锁定依赖：${Object.keys(value ?? {}).length} 个`;
    case 'project/vpm.unresolved': return Array.isArray(value) && value.length ? `未解析的 VPM 依赖：${value.join('、')}` : 'VPM 锁定依赖均已解析到工程';
    case 'project/base.avatar': return unknown ? '素体：未知' : `素体（推断）：${short(value)}`;
    case 'project/history.timeline': return unknown ? '施工历史：未知（工程里没有施工记录）'
      : `施工记录：${(value as { entries?: number })?.entries ?? 0} 条，最近 ${(value as { latest?: string })?.latest ?? '未知'}`;
    case 'project/history.approvals': return unknown ? '历史批准：未知（文件无法证明）' : `历史批准：${short(value)}`;
    case 'project/history.verification': return unknown ? '历史验证：未知（文件无法证明）' : `历史验证：${short(value)}`;
    case 'project/git.state': return (value as { available?: boolean })?.available === false ? 'Git：不是版本库'
      : `Git：${(value as { commits?: number })?.commits ?? 0} 个最近提交，${(value as { uncommitted?: number })?.uncommitted ?? 0} 处未提交改动`;
    case 'project/import.snapshot': return `导入快照：${(value as { files?: number })?.files ?? 0} 个文件`;
    case 'project/takeover.classification': return `AI 判定输入类型：${short(value)}`;
    case 'stage:*/history.progress': return `阶段 ${key(fact.objectId)} 的历史进度：${unknown ? '未知' : value === 'not_applicable' ? '记录称不适用' : '记录称已完成'}`;
    case 'stage:*/completion': return `阶段 ${key(fact.objectId)} 已完成`;
    case 'review:*/result': return `导入复核 ${key(fact.objectId)}：${short((value as { status?: string })?.status)}`;
    case 'question:*/open': return `待确认问题：${short((value as { question?: string })?.question, 120)}`;
    case 'artifact:*/fingerprint': return `产物 ${key(fact.objectId)}：${value ? `指纹 ${String(value).slice(0, 12)}` : '不存在'}`;
    case 'check:*/verdict': return `检查 ${key(fact.objectId)}：${short((value as { result?: string })?.result)}`;
    case 'check:*/warningAccepted': return `检查 ${key(fact.objectId)} 的提醒已接受`;
    case 'gate:*/decision': return `决定 ${key(fact.objectId)}：${short(value)}`;
    case 'brief/intakeMode': return `项目来源：${short(value)}`;
    case 'brief/status': return `项目方向：${short(value)}`;
    case 'brief/faceConcept': return `共同脸部构想：${short(value)}`;
    case 'brief/goal': return `原始需求：${short(value)}`;
    case 'decision:*/accepted': return `已确认决定：${short(value)}`;
    case 'avatar_root:*/lineage': return `头像根 ${key(fact.objectId)}：${short((value as { role?: string })?.role)}`;
    case 'avatar_root:*/blueprintId': return `头像根 ${key(fact.objectId)} 的 Blueprint ID`;
    case 'variant:*/plan': return `造型：${short((value as { name?: string })?.name)}`;
    case 'asset:*/use': return `素材：${short((value as { name?: string })?.name)}（${short((value as { role?: string })?.role)}）`;
    case 'ledger:*/status': return `账本 ${key(fact.objectId)}：${short((value as { status?: string })?.status)}`;
    case 'record/stateHeader': return '施工记录的状态头';
    case 'record/decisions': return `记录里已拍板的决定：${Array.isArray(value) ? value.length : 0} 条`;
    case 'record/pendingDecisions': return `决定表里待复核：${Array.isArray(value) ? value.length : 0} 条`;
    default: return unknown ? `${fact.objectId} ${fact.attribute}：未知` : `${fact.objectId} ${fact.attribute}：${short(value)}`;
  }
}
function staleText(fact: FactView): string[] {
  return fact.invalidatedBy.map(({ condition, now }) => condition.kind === 'file' ? `${condition.path} ${now === null ? '已删除' : '已变化'}`
    : condition.kind === 'artifact' ? `产物 ${condition.artifact} 已变化` : '所依据的结论已更正或失效');
}

export function projectOverview(db: DatabaseSync, projectId: string): ProjectOverview {
  const root = projectRoot(db, projectId);
  const facts = factViews(db, projectId);
  // The analysis's reasons stay in its own file (layer C); they are shown here only while that file is unchanged.
  let basisCache: { sha: string | null; facts: Array<{ basis?: unknown }> } | undefined;
  const basisOf = (fact: FactView): string | undefined => {
    const pointer = /#\/facts\/(\d+)$/.exec(fact.source.ref);
    if (fact.source.type !== 'takeover_analysis' || !pointer) return undefined;
    if (!basisCache) {
      const path = join(root, ...TAKEOVER_FACTS_FILE.split('/'));
      try { basisCache = { sha: sha256File(path), facts: (JSON.parse(readFileSync(path, 'utf8')) as { facts?: Array<{ basis?: unknown }> }).facts ?? [] }; }
      catch { basisCache = { sha: null, facts: [] }; }
    }
    if (basisCache.sha !== fact.inputFingerprint) return undefined;
    const basis = basisCache.facts[Number(pointer[1])]?.basis;
    return typeof basis === 'string' ? basis : undefined;
  };
  const item = (fact: FactView): OverviewFact => ({ id: fact.id, objectId: fact.objectId, attribute: fact.attribute, value: fact.value,
    text: factText(fact), status: fact.status, effectiveStatus: fact.effectiveStatus, evidenceLevel: fact.evidenceLevel, confidence: fact.confidence,
    source: fact.source, locator: fact.locator, observedAt: fact.observedAt, scope: fact.scope, shareLayer: fact.shareLayer,
    ...(fact.objectId.startsWith('intent:') ? { presentation: 'diagnostic' as const } : {}),
    ...(fact.effectiveStatus === 'stale' ? { staleBecause: staleText(fact) } : {}),
    ...(basisOf(fact) ? { basis: basisOf(fact) } : {}) });
  const known = facts.filter(fact => ['observed', 'verified', 'user_confirmed'].includes(fact.effectiveStatus)).map(item);
  const inferred = facts.filter(fact => fact.effectiveStatus === 'inferred').map(item);
  const stale = facts.filter(fact => fact.effectiveStatus === 'stale').map(item);
  const unknown = facts.filter(fact => fact.effectiveStatus === 'unknown').map(item);

  const missing: MissingDependency[] = [];
  const workflow = latestFormalWorkflow(db, projectId);
  // Missing editor metadata is expected before/during the first managed setup. Imported, failed or previously
  // completed projects still need an explicit dependency check; a new running task cannot erase that history.
  const setupTasks = workflow ? db.prepare(`SELECT status FROM task WHERE workflow_id=? AND stage_id='setup'`).all(workflow.id) as Array<{ status: string }> : [];
  const engineeringCreating = setupTasks.some(task => ['RUNNING', 'VERIFYING'].includes(task.status));
  const engineeringPending = Boolean(workflow?.definition.stages.some(stage => stage.id === 'setup') &&
    db.prepare(`SELECT 1 FROM production_proposal p JOIN project_brief b ON b.project_id=p.project_id
      WHERE p.workflow_id=? AND b.intake_mode='conversation'`).get(workflow.id) &&
    !db.prepare(`SELECT 1 FROM import_report WHERE project_id=?`).get(projectId) &&
    (!setupTasks.length || (engineeringCreating && setupTasks.every(task => ['DRAFT', 'RUNNING', 'VERIFYING'].includes(task.status)))) &&
    !db.prepare(`SELECT 1 FROM task t JOIN workflow w ON w.id=t.workflow_id WHERE w.project_id=? AND t.stage_id='setup'
      AND t.status NOT IN ('DRAFT','RUNNING','VERIFYING')`).get(projectId) &&
    !db.prepare(`SELECT 1 FROM run r JOIN task t ON t.id=r.task_id JOIN workflow w ON w.id=t.workflow_id
      WHERE w.project_id=? AND t.stage_id='setup' AND (json_extract(r.result_json,'$.errorClass') IS NOT NULL
        OR json_extract(r.result_json,'$.exitStatus') <> 0 OR (r.status='exited' AND json_extract(r.result_json,'$.exitStatus') IS NULL))`).get(projectId) &&
    !db.prepare(`SELECT 1 FROM stage_completion c JOIN workflow w ON w.id=c.workflow_id WHERE w.project_id=? AND c.stage_id='setup'`).get(projectId));
  const project = (attribute: string) => facts.find(fact => fact.objectId === 'project' && fact.attribute === attribute);
  const unresolved = project('vpm.unresolved'), locked = project('vpm.locked');
  if (unresolved && unresolved.effectiveStatus === 'observed' && Array.isArray(unresolved.value))
    for (const id of unresolved.value.map(String)) missing.push({ kind: 'vpm', id, factId: unresolved.id,
      text: `VPM 包 ${id}${locked?.value && typeof locked.value === 'object' ? `@${(locked.value as Record<string, string>)[id] ?? '?'}` : ''} 未解析到工程（用 VPM 解析取回）` });
  if (project('unity.version')?.effectiveStatus === 'unknown')
    missing.push({ kind: 'unity', id: 'ProjectSettings/ProjectVersion.txt', ...(engineeringPending
      ? { pending: true, text: engineeringCreating ? 'Harness 正在建立工程并配置制作环境。' : '工程尚未建立；Harness 会在准备工程阶段配置制作环境。' }
      : { text: '工程的制作环境信息不完整，需要在继续制作前核对。' }) });
  for (const fact of facts) if (/^(dependency|package):/.test(fact.objectId) && fact.attribute === 'present' && fact.value === false &&
    ['inferred', 'user_confirmed', 'observed'].includes(fact.effectiveStatus))
    missing.push({ kind: 'dependency', id: key(fact.objectId), factId: fact.id,
      text: `${fact.effectiveStatus === 'inferred' ? 'AI 推断缺少' : '缺少'}依赖：${key(fact.objectId)}${fact.effectiveStatus === 'inferred' ? '（待确认）' : ''}` });
  // A plan file is here when the version its plan pinned was fetched for it and its bytes are still in the pool.
  for (const row of db.prepare(`SELECT DISTINCT f.downloadable_id, f.filename, CASE WHEN n.materialized_at IS NULL THEN 'missing'
      WHEN b.status IN ('ready', 'corrupt') THEN b.status ELSE 'missing' END AS status FROM asset_selection_plan p
    JOIN asset_selection_file s ON s.plan_id = p.id AND s.selected = 1 JOIN booth_file f ON f.downloadable_id = s.downloadable_id
    LEFT JOIN asset_selection_pin n ON n.plan_id = s.plan_id AND n.downloadable_id = s.downloadable_id LEFT JOIN pool_blob b ON b.sha256 = n.sha256
    WHERE p.project_id = ? AND p.status IN ('ready', 'materializing', 'validated')
      AND (n.materialized_at IS NULL OR COALESCE(b.status, 'missing') <> 'ready') ORDER BY f.filename`).all(projectId) as Array<{ downloadable_id: string; filename: string; status: string }>)
    missing.push({ kind: 'asset', id: row.downloadable_id, text: `BOOTH 文件 ${row.filename} ${row.status === 'corrupt' ? '校验失败' : '还没有取回'}` });

  const archive = archiveStatus(db, projectId);
  const recoveries = (db.prepare(`SELECT id, status, warnings_json FROM project_recovery WHERE project_id = ? ORDER BY created_at DESC, id`).all(projectId) as
    Array<{ id: string; status: string; warnings_json: string }>).map(row => ({ id: row.id, status: row.status, warnings: JSON.parse(row.warnings_json) as string[] }));
  const next: NextStep[] = [];
  if (archive.write?.status === 'failed') next.push({ kind: 'archive', text: `工程档案写入失败：${archive.write.error ?? '原因未知'}；处理后刷新档案` });
  if (workflow && !['cancelled', 'client_verified'].includes(workflow.status)) next.push({ kind: 'workflow', text: describeWorkflow(db, workflow.id).next, ref: workflow.id });
  for (const recovery of recoveries) {
    if (recovery.status === 'analysis_pending') next.push({ kind: 'recovery', text: '等待 AI 接手分析完成', ref: recovery.id });
    if (recovery.status === 'failed') next.push({ kind: 'recovery', text: `AI 接手分析没有得到完整的结构化结果：${recovery.warnings.at(-1) ?? '原因未知'}`, ref: recovery.id });
  }
  const questions = inferred.filter(fact => fact.objectId.startsWith('question:'));
  const candidates = inferred.filter(fact => !fact.objectId.startsWith('question:') && fact.presentation !== 'diagnostic');
  if (candidates.length) next.push({ kind: 'confirm', text: `确认或更正 ${candidates.length} 项推断（确认前不当作项目事实）` });
  if (questions.length) next.push({ kind: 'question', text: `回答 ${questions.length} 个待确认问题` });
  const actionableStale = stale.filter(fact => fact.presentation !== 'diagnostic');
  if (actionableStale.length) next.push({ kind: 'recheck', text: `${actionableStale.length} 项结论的依据已变化，需要重新核对：${actionableStale.slice(0, 3).map(fact => fact.text).join('；')}` });
  if (unknown.some(fact => fact.attribute.startsWith('history.')))
    next.push({ kind: 'baseline', text: '历史进度、批准或验证无法从文件证明：先建立基线并补证，只重做继续工作必需的检查' });
  const actionableMissing = missing.filter(item => !item.pending);
  if (actionableMissing.length) next.push({ kind: 'dependency', text: `补齐 ${actionableMissing.length} 项缺失依赖` });
  if (missing.some(item => item.pending)) next.push({ kind: 'engineering', text: engineeringCreating
    ? 'Harness 正在建立工程；当前无需你配置制作环境。' : '工程将在准备工程阶段由 Harness 建立；当前无需你配置制作环境。' });
  if (archive.scan?.unclassified) next.push({ kind: 'classify', text: `${archive.scan.unclassified} 个文件还没有登记（待分类），分享前需要归类` });
  if (archive.scan?.rightsUnresolvedA) next.push({ kind: 'rights', text: `${archive.scan.rightsUnresolvedA} 个接续必需文件的转交权未确认（分享前必须确认）` });
  return { projectId, known, inferred, missing, stale, unknown, next, archive, recoveries };
}
