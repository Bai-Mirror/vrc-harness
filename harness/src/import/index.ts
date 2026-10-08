import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withStateEvent } from '../state/tx.ts';
import { assessStages, handoffFacts } from './assess.ts';
import { collectArtifactClaims, runReviews } from './review.ts';
import { DEFAULT_IMPORT_CONFIG, type ImportConfig, type ImportOptions, type ImportReport } from './types.ts';
import { decisionTables, detectKind, externalLedger, gitRead, inside, locateProject, mentionCount, mergeLedger, newId, originalPackages, parseLedger, parseLedgerDecisions, parseRecord, readNamed, relatedPrograms, sha256, snapshot, unityProcesses } from './scan.ts';
import { localMinute } from './time.ts';
import { harnessVersion } from '../provenance.ts';
import { recordFacts } from '../archive/facts.ts';
import { importFindings } from '../archive/import-facts.ts';
import { registerEntries } from '../archive/registry.ts';
import { physicalWorkspace, physicalProject } from '../project-identity.ts';

function configFor(override?: Partial<ImportConfig>): ImportConfig { return { ...DEFAULT_IMPORT_CONFIG, ...override }; }
function readPackages(project: string): Record<string, string> {
  try {
    const manifest = JSON.parse(readFileSync(join(project, 'Packages/vpm-manifest.json'), 'utf8')) as { locked?: Record<string, { version?: string }> };
    return Object.fromEntries(Object.entries(manifest.locked ?? {}).map(([name, entry]) => [name, entry.version ?? 'unknown']));
  } catch { return {}; }
}
function unityVersion(project: string): string | undefined {
  try { return /^m_EditorVersion:\s*(.+)$/m.exec(readFileSync(join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8'))?.[1]?.trim(); }
  catch { return undefined; }
}
function bodiesFromRecords(project: string, record: string, config: ImportConfig): string | undefined {
  const privateBody = new RegExp(config.privatePattern).exec(basename(project))?.[2];
  if (privateBody && config.knownBodies?.includes(privateBody)) return privateBody;
  const assets = join(project, 'Assets'); const assetPaths: string[] = [];
  const visit = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.isFile()) assetPaths.push(relative(project, path));
  } };
  if (statExists(assets)) visit(assets);
  const hits = [...new Set((config.knownBodies ?? []).filter(Boolean))].map((name, order) => ({
    name, order, count: mentionCount(record, name) + assetPaths.reduce((n, path) => n + mentionCount(path, name), 0),
  })).filter(hit => hit.count > 0).sort((a, b) => b.count - a.count || a.order - b.order);
  if (!hits.length) return undefined;
  return `最可能：${hits[0]!.name}（${hits[0]!.count} 次）${hits.length > 1 ? `；其他候选：${hits.slice(1).filter(hit => hit.count * 2 >= hits[0]!.count).map(hit => `${hit.name}（${hit.count} 次）`).join('、')}` : ''}`.replace(/；其他候选：$/, '');
}
function statExists(path: string): boolean { try { return statSync(path).isDirectory(); } catch { return false; } }
/** Observe an existing Unity project without opening Unity or writing to the project. */
export function importProject(db: DatabaseSync, options: ImportOptions): ImportReport {
  const config = configFor(options.config);
  const { workspace, project } = locateProject(options.workspacePath, options.projectPath);
  const dbFiles = db.prepare('PRAGMA database_list').all() as { file: string }[];
  if (dbFiles.some(row => row.file && inside(project, row.file))) throw new Error('State database must be outside the imported project');
  const before = snapshot(project, config.ignoredSnapshotDirs, config.snapshotSampleThresholdBytes);
  const detected = detectKind(project, workspace, config, options.kind);
  const record = readNamed(project, config.recordNames);
  const parsed = record ? parseRecord(record.text, record.file, config.recentTimelineCount)
    : { header: { fields: {} }, timeline: { count: 0, recent: [] }, allTimeline: [], gaps: [{ source: 'record:missing', detail: '施工记录未找到' }], unparsedRecords: [] };
  const ledgerFile = readNamed(project, config.ledgerNames);
  const local = ledgerFile ? parseLedger(ledgerFile.text, ledgerFile.file, false, statSync(join(project, ledgerFile.file)).mtimeMs) : [];
  const ledgerDecisions = ledgerFile ? parseLedgerDecisions(ledgerFile.text, ledgerFile.file) : [];
  const decisionPatterns = config.decisionTitlePatterns.map(pattern => new RegExp(pattern, 'i'));
  const timelineDecisions = parsed.allTimeline.filter(item => decisionPatterns.some(pattern => pattern.test(item.title))).sort((a, b) => b.date.localeCompare(a.date));
  ledgerDecisions.push(...timelineDecisions.slice(0, 10).map(item => ({ source: item.source, detail: `${item.date} · ${item.title}` })));
  const merged = mergeLedger(local, externalLedger(workspace, project, config, detected.orderNumber));
  const relatedLedger = [...merged.ledger, ...merged.externalLedger].filter(item => (item.relatedProjects?.length ?? 0) > 1);
  const ledger = merged.ledger.filter(item => !relatedLedger.includes(item));
  const external = merged.externalLedger.filter(item => !relatedLedger.includes(item));
  const packages = readPackages(project);
  const identity = { ...detected, unityVersion: unityVersion(project), packages, base: bodiesFromRecords(project, record?.text ?? '', config) };
  const claims = collectArtifactClaims(project, record, config);
  const projectBaseline = config.packageBaselineByProject?.[basename(project)] ?? originalPackages(project);
  const reviews = runReviews(project, workspace, config, packages, projectBaseline, claims,
    [detected.orderNumber, basename(project), ...(config.projectAliases ?? [])].filter((x): x is string => !!x));
  const stages = assessStages(project, options.definition, config, parsed.header, parsed.allTimeline, reviews);
  const facts = handoffFacts(options.definition, parsed.header, ledger, external, reviews, stages);
  facts.gaps.push(...parsed.gaps);
  const newProjectId = `project:${sha256(project)}`;
  const report: ImportReport = {
    schema: 'import/0.1', id: newId(), projectId: newProjectId, processId: options.definition.id,
    generated_from: options.generatedFrom ?? { harness_version: harnessVersion(), knowledge_version: 'unknown:source-files-unavailable', interpretation_hash: 'unknown:source-files-unavailable' },
    processVersion: options.definition.version, processHash: sha256(JSON.stringify(options.definition)),
    workspacePath: workspace, projectPath: project, identity,
    stateHeader: parsed.header, timeline: parsed.timeline, unparsedRecords: parsed.unparsedRecords, ledger, ledgerDecisions, externalLedger: external, relatedLedger,
    pendingDecisions: decisionTables(workspace, project, config, detected.orderNumber), relatedPrograms: relatedPrograms(workspace, project, config, detected.orderNumber, detected.kind),
    timelineDecisionCount: timelineDecisions.length,
    git: gitRead(project), runningProcesses: unityProcesses(project), fingerprint: before.hash, snapshotSampledFiles: before.sampledFiles,
    reviews, stages, ...facts, snapshotHash: before.hash,
  };
  options.beforeCommit?.();
  if (snapshot(project, config.ignoredSnapshotDirs, config.snapshotSampleThresholdBytes).hash !== before.hash) throw new Error('Project changed during import; state write cancelled');
  const payload = { projectId: report.projectId, snapshotHash: before.hash };
  withStateEvent(db, { actor: 'import', entityType: 'import_report', entityId: report.id,
    action: 'observed', reason: 'read-only project import', payload }, () => {
    // Reuse GUI identities under the same transaction lock; ignored inserts must not manufacture FK targets.
    const existingWorkspace = physicalWorkspace(db, workspace);
    let workspaceId = existingWorkspace?.id;
    if (!workspaceId) {
      workspaceId = `workspace:${sha256(workspace)}`;
      db.prepare('INSERT INTO workspace (id, path) VALUES (?, ?)').run(workspaceId, workspace);
    }
    const found = physicalProject(db, workspaceId, existingWorkspace?.path ?? workspace, project);
    const occupied = db.prepare('SELECT id FROM project WHERE id = ?').get(newProjectId) as { id: string } | undefined;
    if (occupied && found?.id !== occupied.id) throw new Error('工程身份已被另一位置占用，不能重新绑定');
    const projectId = found?.id ?? newProjectId;
    report.projectId = projectId;
    payload.projectId = projectId;
    // Bind observations, the report and the committed event to this actual project, without rewriting linked state.
    const findings = importFindings(report, { files: before.files, ...(record ? { recordFile: record.file } : {}),
      ...(ledgerFile ? { ledgerFile: ledgerFile.file } : {}) });
    db.prepare(`INSERT INTO project
      (id, workspace_id, kind, path, identity_json, lifecycle, harness_version, knowledge_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, identity_json = excluded.identity_json`)
      .run(projectId, workspaceId, identity.kind, relative(workspace, project), JSON.stringify(identity), 'imported',
        report.generated_from!.harness_version, report.generated_from!.knowledge_version);
    db.prepare('INSERT INTO import_report (id, project_id, report_json, snapshot_hash) VALUES (?, ?, ?, ?)')
      .run(report.id, projectId, JSON.stringify(report), before.hash);
    recordFacts(db, projectId, findings.facts);
    registerEntries(db, projectId, findings.entries);
    if (snapshot(project, config.ignoredSnapshotDirs, config.snapshotSampleThresholdBytes).hash !== before.hash) throw new Error('Project changed during state write; transaction rolled back');
  });
  return report;
}
/** Read the persisted report; Markdown generation uses this, not a fresh project scan. */
export function getImportReport(db: DatabaseSync, reportId: string): ImportReport {
  const row = db.prepare('SELECT report_json FROM import_report WHERE id = ?').get(reportId) as { report_json: string } | undefined;
  if (!row) throw new Error(`Unknown import report ${reportId}`);
  return JSON.parse(row.report_json) as ImportReport;
}
export function handoffMarkdown(db: DatabaseSync, reportId: string): string {
  const r = getImportReport(db, reportId);
  const concise = (value: string, max = 300): string => value.replace(/\s+/g, ' ').slice(0, max);
  const truncated = (value: string, max: number): string => {
    const chars = Array.from(value.replace(/\s+/g, ' ').trim());
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
  };
  const withSource = (detail: string, source: string): string => /（来源：[^）]+）/.test(detail)
    ? detail : `${detail} （来源：${source}）`;
  const rows = (items: { source: string; detail: string }[]) => items.length
    ? items.map(item => `- ${withSource(concise(item.detail), item.source)}`).join('\n') : '- 无记录';
  const open = [...r.ledger, ...r.externalLedger].filter(item => item.status !== 'done' && item.status !== 'dropped');
  const closed = [...r.ledger, ...r.externalLedger, ...(r.relatedLedger ?? [])].filter(item => item.status === 'dropped');
  const itemRows = (items: typeof open) => items.length ? items.flatMap(item => [
    `- [${item.archived ? '归档回收' : item.status}] ${withSource(truncated(item.text, 240), (item.sources ?? [item.source]).join('；'))}`,
    ...(item.latestNote ? [`  - 最新注记：${withSource(truncated(item.latestNote.detail, 160), item.latestNote.source)}`] : []),
  ]) : ['- 无记录'];
  const headerTime = r.stateHeader.time ?? '未知';
  const timelineLatest = r.timeline.recent.at(-1)?.date;
  const commitMinute = r.git.latestCommitAt ? localMinute(new Date(r.git.latestCommitAt)) : undefined;
  const stale = !!r.stateHeader.time && (
    (!!timelineLatest && timelineLatest > r.stateHeader.time) ||
    (!!commitMinute && commitMinute > r.stateHeader.time));
  const reviewRows = r.reviews.map(review => {
    const label = review.id === 'delivery_cleanup' && ['pass', 'fail', 'unknown'].includes(review.status) && (review.status !== 'unknown' || !!review.needsVerification?.length)
      ? [review.evidence.length ? `待清理（${review.evidence.length} 项）` : '', review.needsVerification?.length ? `需核实（${review.needsVerification.length} 项）` : ''].filter(Boolean).join(' / ') || '无残留'
      : review.id === 'toolchain_baseline'
        ? review.evidence.length ? `有差异（${review.evidence.length} 项）` : '一致'
        : review.status;
    return `| ${review.id} | ${label} | ${concise(review.reason).replace(/\|/g, '\\|')} |`;
  });
  const cleanup = r.reviews.find(review => review.id === 'delivery_cleanup');
  const toolchain = r.reviews.find(review => review.id === 'toolchain_baseline');
  const archives = r.reviews.find(review => review.id === 'delivery_archives');
  const absent = r.reviews.find(review => review.id === 'artifacts')?.missingClaims ?? [];
  const knownStages = r.stages.filter(stage => stage.status !== 'unknown');
  const relatedOpen = (r.relatedLedger ?? []).filter(item => item.status !== 'done' && item.status !== 'dropped');
  const userRelated = relatedOpen.filter(item => /负责：\s*(?:用户|客户|委托人)(?:\s|—|$)/.test(item.text));
  const otherRelated = relatedOpen.filter(item => !userRelated.includes(item));
  const relatedClosed = (r.relatedLedger ?? []).length - relatedOpen.length;
  const userOpen = open.filter(item => /负责：\s*(?:用户|客户|委托人)(?:\s|—|$)/.test(item.text));
  const allOpen = [...open, ...relatedOpen];
  const userById = new Map(allOpen.filter(item => /负责：\s*(?:用户|客户|委托人)(?:\s|—|$)/.test(item.text)).map(item => [item.id, item]));
  const seenPending = new Set<string>();
  const uniquePending = (items: { source: string; detail: string }[]): { source: string; detail: string }[] => items.filter(item => {
    const key = item.detail.replace(/\s+/g, ' ').trim();
    if (seenPending.has(key)) return false;
    seenPending.add(key);
    return true;
  });
  const headerPending = uniquePending(r.gaps.filter(gap => !userOpen.some(item => item.source === gap.source && item.text === gap.detail)));
  const ledgerPending = uniquePending([...userOpen.map(item => ({ source: item.source, detail: item.text })),
    ...userRelated.map(item => ({ source: item.sources.join('；'),
      detail: `${truncated(item.text, 160)}；涉及工程：${item.relatedProjects?.join('、')}` }))]);
  const blockedPending = uniquePending(allOpen.flatMap(item => {
    const dependencies = /(?:^|—)\s*依赖：\s*([^—\n]+)/.exec(item.text)?.[1] ?? '';
    const ids = [...new Set([...dependencies.matchAll(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g)].map(match => match[0]!))];
    return ids.filter(id => id !== item.id && userById.has(id)).map(id => ({
      source: `${userById.get(id)!.source}；${item.source}`,
      detail: `${id} → ${truncated(item.text.split(/\s+—\s+/)[0]!, 160)}`,
    }));
  }));
  const decisionPending = uniquePending([...(r.pendingDecisions ?? [])].sort((a, b) => Number(b.starred) - Number(a.starred)).map(item => ({ source: item.source,
    detail: `${item.starred ? '☆ ' : ''}${item.id}${item.time ? `；${item.time}` : ''}；${concise(item.question, 120)}；已代选：${concise(item.choice, 120)}` })));
  const closedById = new Map([...r.ledger, ...r.externalLedger, ...(r.relatedLedger ?? [])].filter(item => item.status === 'done' || item.status === 'dropped').map(item => [item.id, item]));
  let staleHeaderLines = 0;
  const checkedHeaderLine = (key: string, line: string): string => {
    if (key !== '下一步' && key !== '未决 / 等用户') return line;
    const ids = [...line.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\b/g)].map(match => match[0]!).filter(id => /[-0-9]/.test(id));
    const closed = [...new Set(ids)].map(id => closedById.get(id)).filter((item): item is NonNullable<typeof item> => !!item);
    if (closed.length) staleHeaderLines++;
    return `${line}${closed.map(item => `（账本：${item.status === 'done' ? '已完成' : '不做'} @${item.source}）`).join('')}`;
  };
  const headerRows = Object.entries(r.stateHeader.fields).flatMap(([key, field]) => Array.isArray(field)
    ? [`- ${key}：`, ...field.map(line => `  ${checkedHeaderLine(key, line)}`)] : [`- ${key}：${checkedHeaderLine(key, field)}`]);
  const decisions = r.ledgerDecisions ?? [];
  return [
    `# 接手简报：${basename(r.projectPath)}`,
    `- 来源版本：Harness ${r.generated_from?.harness_version ?? 'unknown:legacy'}；知识层 ${r.generated_from?.knowledge_version ?? 'unknown:legacy'}；导入解释 ${r.generated_from?.interpretation_hash ?? 'unknown:legacy'}`,
    '', `- 项目：${r.projectPath}`, `- 类别：${r.identity.kind}`, `- 订单号：${r.identity.orderNumber ?? '未知'}`,
    `- Unity：${r.identity.unityVersion ?? '未知'}`, `- 素体：${r.identity.base ?? '未知'}`,
    `- 流程：${r.processId}@${r.processVersion} (${r.processHash})`, `- 指纹：${r.fingerprint}`,
    `- 抽样指纹文件：${r.snapshotSampledFiles?.join('；') || '无'}`,
    `- VPM 锁定版本：${Object.entries(r.identity.packages).map(([name, version]) => `${name}=${version}`).join('，') || '未知'}`,
    `- Unity 进程：${r.runningProcesses.join('；') || '未发现'}`,
    `- git 最近提交：${r.git.commits.join('；') || r.git.reason || '无'}`,
    `- git 未提交改动：${r.git.changes.join('；') || r.git.reason || '无'}`,
    '', '## 当前现状', '', `- 状态头时间：${headerTime} （来源：${r.stateHeader.source ?? '未知'}）`,
    ...headerRows,
    ...(Object.keys(r.stateHeader.fields).length ? [] : ['- 状态头：无记录']),
    `- 状态头有 ${staleHeaderLines} 处落后于账本`,
    '', '## 最近施工', '', ...(r.timeline.recent.length ? r.timeline.recent.map(item =>
      `- ${withSource(`${item.date} · ${concise(item.title, 100)}；执行者：${concise(item.actor || item.fields['执行'] || '未知', 60)}；结果：${concise(item.fields['结果'] ?? item.fields['怎么验 / 结果'] ?? '未知', 160)}`, item.source)}`) : ['- 无记录']),
    ...(stale ? ['- 状态头可能过时：最近施工或最新提交晚于状态头时间'] : []),
    '', '## 等你处理',
    '', '### 状态头：未决 / 等用户', '', rows(headerPending),
    '', '### 用户负责的未关闭条目', '', rows(ledgerPending),
    '', '### 等你先拍板', '', rows(blockedPending),
    '', '### 决定表待复核', '', rows(decisionPending),
    '', '## 下一步建议', '', rows(r.nextSteps),
    '', '## 未收结条目', '', ...itemRows(open),
    '', '## 交付包', '', ...(archives?.archiveDetails?.length ? archives.archiveDetails.map(a =>
      `- ${a.path}；大小：${a.size} B；修改时间：${a.modified}；7z t：${a.status}（${concise(a.reason, 200)}）`)
      : ['- 导出目标中未找到与本工程匹配的交付包']),
    '', '## 只读复核', '', '| 检查 | 状态 | 说明 |', '| --- | --- | --- |',
    ...reviewRows,
    '', '### 完整性问题', '', '- 只收完整性复核失败，不代表工作卡点', ...r.blockers.map(item => `- ${withSource(concise(item.detail), item.source)}`),
    '', '### 工作副本的交付前清理项', '', '- 对当前工作副本的只读检查；交付包状态见「交付包」一节。', `- 待清理 ${cleanup?.evidence.length ?? 0} 项`,
    ...(cleanup?.evidence.length ? cleanup.evidence.map(item => `  - ${withSource(item.detail, item.source)}`) : []),
    `- 需核实 ${cleanup?.needsVerification?.length ?? 0} 项（无法只读判定，需人工或 Unity 核实）`,
    ...(cleanup?.needsVerification?.length ? cleanup.needsVerification.map(item => `  - ${withSource(item.detail, item.source)}`) : []),
    ...(!cleanup || cleanup.status === 'not_run' || cleanup.status === 'unknown' && !cleanup.needsVerification?.length ? [`- ${cleanup?.reason ?? '无记录'}`] : []),
    '', '### 与工具链基准的差异', '', toolchain ? rows([{ source: 'config:import.packageBaseline', detail: toolchain.reason }]) : '- 未配置',
    '', '### 记录里提到、现在不存在（可能已清理）', '', ...(absent.length ? absent.slice(0, 5).map(item => `- ${withSource(concise(item.detail), item.source)}`) : ['- 无记录']),
    `- 总数：${absent.length}`,
    '', '## 阶段状态', '', '| Stage | 状态 | 证据 |', '| --- | --- | --- |',
    ...knownStages.map(stage => `| ${stage.id} | ${stage.weakEvidence ? '文档存在（弱证据）' : stage.status} | ${concise(stage.evidence.map(e => `${e.source}: ${e.detail}`).join('; ')).replace(/\|/g, '\\|')} |`),
    `| 其余 ${r.stages.length - knownStages.length} 个阶段 | unknown（无可核对证据） | |`,
    '', '## 已拍板', '', rows(decisions), ...((r.timelineDecisionCount ?? 0) > 10 ? [`- 时间线拍板总数：${r.timelineDecisionCount} 条（仅显示最近 10 条）`] : []),
    '', '## 关联长程任务', '', ...(r.relatedPrograms?.length ? r.relatedPrograms.flatMap(program => [
      `- ${withSource(`${program.name}；阶段 / 交付状态：${program.phase ?? '未知'}；最近一步：${program.recent ?? '未知'}；状态头时间：${program.time ?? '未知'}`, program.source)}`,
      ...(program.mentionSources?.length ? program.mentionSources.map(item => `  - ${withSource(`本工程提及 ${item.count} 次`, item.source)}`)
        : [`  - ${withSource(`本工程提及 ${program.mentions} 次`, program.source)}`]),
    ]) : ['- 无记录']),
    '', '## 关联的跨工程条目（涉及本工程，但不是本单独有的任务）', '', ...(otherRelated.length ? otherRelated.map(item =>
      `- [${item.status}] ${withSource(`${truncated(item.text, 160)}；涉及工程：${item.relatedProjects?.join('、')}`, item.sources.join('；'))}`)
      : ['- 无记录']), `- 另有 ${relatedClosed} 条已关闭`,
    '', `## 已关闭`, '', `- 用户决定不做：${closed.length} 条`,
    '', '## 未解析记录', '', rows(r.unparsedRecords ?? []),
    '',
  ].join('\n');
}
