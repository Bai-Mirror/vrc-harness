import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { sha256File } from '../file-hash.ts';
import { hostPlatform } from '../host-platform.ts';
import { isPortablePath, TAKEOVER_FACTS_SCHEMA, type Invalidation } from './contract.ts';
import { inTransaction, recordFacts, type NewFact } from './facts.ts';

/**
 * The takeover analysis Task (import/recovery.ts) writes a free report and, since archive v1, a structured list of
 * candidate facts. Harness checks the list against this contract and records every entry as an `inferred` candidate:
 * nothing an AI wrote becomes a confirmed project fact without a person or an independent check. A recovery is
 * `ready` only when all three outputs are structurally complete; that says nothing about the project being deliverable.
 */
export const RECOVERY_DIR = '_Harness/Recovery';
export const ANALYSIS_FILE = `${RECOVERY_DIR}/analysis.json`;
export const BRIEF_FILE = `${RECOVERY_DIR}/recovery.md`;
export const TAKEOVER_FACTS_FILE = `${RECOVERY_DIR}/facts.json`;
/** Business objects a candidate may be about: `<type>` or `<type>:<key>`. */
export const TAKEOVER_OBJECT_TYPES = ['project', 'unity_root', 'scene', 'prefab', 'avatar_root', 'dependency', 'package', 'asset', 'menu',
  'parameter', 'plugin', 'practice', 'risk'] as const;
export const CLASSIFICATIONS = ['project', 'asset_bundle', 'mixed', 'unknown'] as const;
const MAX_FACTS = 2000, MAX_QUESTIONS = 200;

export interface TakeoverFact {
  object: string; attribute: string; value: unknown;
  locator: { path: string; object?: string };
  basis: string; confidence?: number; dependsOn?: number[];
}
export interface TakeoverQuestion { id: string; question: string; about?: string }
export interface TakeoverFacts { schema: typeof TAKEOVER_FACTS_SCHEMA; facts: TakeoverFact[]; questions: TakeoverQuestion[]; ready: true }

/** Is `path` an existing file or directory inside the project (symbolic links may not lead out)? */
function existsInside(project: string, path: string): boolean {
  if (path === '.') return true;
  const target = resolve(project, path);
  if (!hostPlatform.within(project, target) || !existsSync(target)) return false;
  try { return hostPlatform.within(realpathSync(project), realpathSync(target)); } catch { return false; }
}

/** Structural check of the candidate facts file; every problem is listed, in the words a person reads. */
export function validateTakeoverFacts(project: string, raw: unknown): { ok: true; value: TakeoverFacts } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(raw)) return { ok: false, problems: ['facts.json 顶层应为对象'] };
  if (raw.schema !== TAKEOVER_FACTS_SCHEMA) problems.push(`facts.json 的 schema 应为 ${TAKEOVER_FACTS_SCHEMA}`);
  if (raw.ready !== true) problems.push('facts.json 的 ready 应为 true（仅表示输出结构齐全）');
  const facts = Array.isArray(raw.facts) ? raw.facts : (problems.push('facts.json 缺少 facts 列表'), []);
  if (facts.length > MAX_FACTS) problems.push(`facts 最多 ${MAX_FACTS} 条`);
  const types = new Set<string>(TAKEOVER_OBJECT_TYPES);
  facts.slice(0, MAX_FACTS).forEach((entry: unknown, i: number) => {
    const at = `facts[${i}]`;
    if (!object(entry)) { problems.push(`${at} 应为对象`); return; }
    const id = typeof entry.object === 'string' ? entry.object : '';
    const type = id.split(':')[0]!;
    if (!types.has(type) || (id !== type && !/^[a-z_]+:\S.{0,299}$/s.test(id)) || /[\r\n]/.test(id))
      problems.push(`${at}.object 应为 ${TAKEOVER_OBJECT_TYPES.join('、')} 之一，形如 类型 或 类型:键`);
    if (typeof entry.attribute !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(entry.attribute)) problems.push(`${at}.attribute 无效`);
    // History a file cannot prove is unknown, and an AI does not get to reconstruct it.
    else if (/^history(\.|$)/i.test(entry.attribute)) problems.push(`${at}.attribute：历史进度、批准和验证不能作为推断写入，请写进 questions`);
    if (entry.value === undefined) problems.push(`${at}.value 缺失（未知请不要列出，写进 questions）`);
    else if (JSON.stringify(entry.value).length > 4096) problems.push(`${at}.value 过大`);
    if (!object(entry.locator) || typeof entry.locator.path !== 'string') problems.push(`${at}.locator.path 缺失：每条候选都要指明依据的文件`);
    else if (!isPortablePath(entry.locator.path)) problems.push(`${at}.locator.path 应为工程内的相对路径（/ 分隔）`);
    else if (!existsInside(project, entry.locator.path)) problems.push(`${at}.locator.path 在工程内不存在：${entry.locator.path}`);
    if (object(entry.locator) && entry.locator.object !== undefined && (typeof entry.locator.object !== 'string' || entry.locator.object.length > 300))
      problems.push(`${at}.locator.object 应为字符串`);
    if (typeof entry.basis !== 'string' || !entry.basis.trim() || entry.basis.length > 1000) problems.push(`${at}.basis 应为 1 至 1000 字的依据说明`);
    if (entry.confidence !== undefined && (typeof entry.confidence !== 'number' || !(entry.confidence >= 0 && entry.confidence <= 1)))
      problems.push(`${at}.confidence 应在 0 与 1 之间`);
    if (entry.dependsOn !== undefined && (!Array.isArray(entry.dependsOn) ||
      entry.dependsOn.some(n => !Number.isSafeInteger(n) || (n as number) < 0 || (n as number) >= i)))
      problems.push(`${at}.dependsOn 只能引用排在它前面的候选序号`);
  });
  const questions = raw.questions === undefined ? [] : Array.isArray(raw.questions) ? raw.questions : (problems.push('questions 应为列表'), []);
  if (questions.length > MAX_QUESTIONS) problems.push(`questions 最多 ${MAX_QUESTIONS} 条`);
  const seen = new Set<string>();
  questions.slice(0, MAX_QUESTIONS).forEach((entry: unknown, i: number) => {
    const at = `questions[${i}]`;
    if (!object(entry)) { problems.push(`${at} 应为对象`); return; }
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(entry.id)) problems.push(`${at}.id 无效`);
    else if (seen.has(entry.id)) problems.push(`${at}.id 重复`); else seen.add(entry.id);
    if (typeof entry.question !== 'string' || !entry.question.trim() || entry.question.length > 1000) problems.push(`${at}.question 应为 1 至 1000 字`);
    if (entry.about !== undefined && (typeof entry.about !== 'string' || entry.about.length > 300)) problems.push(`${at}.about 应为字符串`);
  });
  return problems.length ? { ok: false, problems } : { ok: true, value: raw as unknown as TakeoverFacts };
}

function readJson(path: string): { value?: unknown; problem?: string } {
  if (!existsSync(path)) return { problem: 'missing' };
  try { return { value: JSON.parse(readFileSync(path, 'utf8')) as unknown }; } catch (error) { return { problem: `invalid JSON: ${(error as Error).message}` }; }
}
function fileSha(project: string, path: string): string | null {
  const target = join(project, ...path.split('/'));
  try { return lstatSync(target).isFile() ? sha256File(target) : null; } catch { return null; }
}

/** Complete read-only output check shared by the independent Task check and final ingestion. */
export function validateTakeoverOutputs(project: string): { ok: true; facts: TakeoverFacts; analysis: Record<string, unknown> } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const analysis = readJson(join(project, ...ANALYSIS_FILE.split('/')));
  const analysisValue = analysis.value as Record<string, unknown> | undefined;
  if (analysis.problem) problems.push(`${ANALYSIS_FILE}：${analysis.problem === 'missing' ? '不存在' : analysis.problem}`);
  else if (!analysisValue || typeof analysisValue !== 'object' || Array.isArray(analysisValue)) problems.push(`${ANALYSIS_FILE} 顶层应为对象`);
  else {
    if (analysisValue.ready !== true) problems.push(`${ANALYSIS_FILE} 的 ready 应为 true`);
    if (!CLASSIFICATIONS.includes(analysisValue.classification as typeof CLASSIFICATIONS[number]))
      problems.push(`${ANALYSIS_FILE} 的 classification 应为 ${CLASSIFICATIONS.join('、')} 之一`);
  }
  const brief = join(project, ...BRIEF_FILE.split('/'));
  if (!existsSync(brief) || !readFileSync(brief, 'utf8').trim()) problems.push(`${BRIEF_FILE} 不存在或为空`);
  const facts = readJson(join(project, ...TAKEOVER_FACTS_FILE.split('/')));
  let checked: ReturnType<typeof validateTakeoverFacts> | undefined;
  if (facts.problem) problems.push(`${TAKEOVER_FACTS_FILE}：${facts.problem === 'missing' ? '不存在' : facts.problem}`);
  else { checked = validateTakeoverFacts(project, facts.value); if (!checked.ok) problems.push(...checked.problems); }
  if (problems.length || !checked?.ok) return { ok: false, problems };
  return { ok: true, facts: checked.value, analysis: analysisValue! };

}

/**
 * Check the three outputs of a passed analysis Task and, when they are complete, record its candidates. Returns the
 * problems when they are not; nothing is recorded then.
 */
export function ingestTakeover(db: DatabaseSync, projectId: string, project: string, recoveryId: string, taskId: string): string[] {
  const output = validateTakeoverOutputs(project);
  if (!output.ok) return output.problems;
  const checked = { value: output.facts }, analysisValue = output.analysis;

  const run = db.prepare('SELECT provider FROM run WHERE task_id = ? ORDER BY attempt DESC LIMIT 1').get(taskId) as { provider: string | null } | undefined;
  const passedAt = (db.prepare(`SELECT occurred_at FROM event WHERE entity_type = 'task' AND entity_id = ? AND action LIKE '%->PASSED'
    ORDER BY seq DESC LIMIT 1`).get(taskId) as { occurred_at: string } | undefined)?.occurred_at ?? new Date().toISOString();
  const observer = `takeover-analysis/1 via ${run?.provider ?? 'unknown'}`;
  const factsSha = fileSha(project, TAKEOVER_FACTS_FILE)!, analysisSha = fileSha(project, ANALYSIS_FILE)!;
  const source = (pointer: string): NewFact['source'] => ({ type: 'takeover_analysis', ref: `${TAKEOVER_FACTS_FILE}#${pointer}` });
  const ids = checked.value.facts.map(() => randomUUID());
  const binding: Invalidation = { kind: 'file', path: TAKEOVER_FACTS_FILE, sha256: factsSha };
  const candidates: NewFact[] = checked.value.facts.map((fact, i) => {
    const located = fact.locator.path !== '.' ? fileSha(project, fact.locator.path) : null;
    return { id: ids[i], objectId: fact.object, attribute: fact.attribute, value: fact.value, source: source(`/facts/${i}`),
      locator: { path: fact.locator.path, ...(fact.locator.object ? { object: fact.locator.object } : {}) }, inputFingerprint: factsSha,
      observer, observedAt: passedAt, status: 'inferred', evidenceLevel: 'inference', confidence: fact.confidence ?? null,
      scope: `recovery:${recoveryId}`, shareLayer: 'A',
      invalidation: [binding, ...(located ? [{ kind: 'file' as const, path: fact.locator.path, sha256: located }] : []),
        ...(fact.dependsOn ?? []).map(n => ({ kind: 'fact' as const, factId: ids[n]! }))] };
  });
  const questions: NewFact[] = checked.value.questions.map((question, i) => ({ objectId: `question:${question.id}`, attribute: 'open',
    value: { question: question.question, ...(question.about ? { about: question.about } : {}) }, source: source(`/questions/${i}`),
    locator: { path: TAKEOVER_FACTS_FILE }, inputFingerprint: factsSha, observer, observedAt: passedAt, status: 'inferred',
    evidenceLevel: 'inference', scope: `recovery:${recoveryId}`, shareLayer: 'A', invalidation: [binding] }));
  const classification: NewFact = { objectId: 'project', attribute: 'takeover.classification', value: analysisValue!.classification,
    source: { type: 'takeover_analysis', ref: `${ANALYSIS_FILE}#/classification` }, locator: { path: ANALYSIS_FILE }, inputFingerprint: analysisSha,
    observer, observedAt: passedAt, status: 'inferred', evidenceLevel: 'inference', scope: `recovery:${recoveryId}`, shareLayer: 'A',
    confidence: typeof analysisValue!.classificationConfidence === 'number' && analysisValue!.classificationConfidence >= 0 &&
      analysisValue!.classificationConfidence <= 1 ? analysisValue!.classificationConfidence : null,
    invalidation: [{ kind: 'file', path: ANALYSIS_FILE, sha256: analysisSha }] };
  recordFacts(db, projectId, [classification, ...candidates, ...questions]);
  return [];
}

/** The absolute directory of a project row (an import stores it relative to its workspace). */
export function projectRoot(db: DatabaseSync, projectId: string): string {
  const row = db.prepare(`SELECT p.path, w.path AS workspace FROM project p LEFT JOIN workspace w ON w.id = p.workspace_id WHERE p.id = ?`)
    .get(projectId) as { path: string; workspace: string | null } | undefined;
  if (!row) throw Object.assign(new Error(`项目不存在: ${projectId}`), { code: 'NOT_FOUND' });
  if (isAbsolute(row.path)) return row.path;
  if (row.workspace && isAbsolute(row.workspace)) return join(row.workspace, row.path);
  throw new Error(`项目路径无法解析为绝对路径：${row.path}`);
}

/**
 * Settle recoveries whose analysis Task has ended: a passed one with complete outputs becomes `ready` and its
 * candidates are recorded; anything else becomes `failed` with the reasons. Idempotent.
 */
export function reconcileRecoveries(db: DatabaseSync, projectId?: string): Array<{ id: string; projectId: string; status: string; problems: string[] }> {
  const rows = db.prepare(`SELECT r.id, r.project_id, r.analysis_task_id, t.status AS task_status FROM project_recovery r
    JOIN task t ON t.id = r.analysis_task_id WHERE r.status = 'analysis_pending' AND (? IS NULL OR r.project_id = ?)
      AND (t.status IN ('PASSED', 'FAILED', 'CANCELLED') OR (t.status = 'BLOCKED'
        AND json_extract(t.retry_policy_json, '$.maxCheckRetries') IS NOT NULL
        AND (SELECT MAX(attempt) FROM run WHERE task_id = t.id) > json_extract(t.retry_policy_json, '$.maxCheckRetries'))) ORDER BY r.created_at, r.id`).all(projectId ?? null, projectId ?? null) as
    Array<{ id: string; project_id: string; analysis_task_id: string; task_status: string }>;
  const settled: Array<{ id: string; projectId: string; status: string; problems: string[] }> = [];
  for (const row of rows) {
    let problems: string[];
    try {
      problems = row.task_status === 'PASSED'
        ? inTransaction(db, () => {
          const found = ingestTakeover(db, row.project_id, projectRoot(db, row.project_id), row.id, row.analysis_task_id);
          settle(db, row.id, row.project_id, found);
          return found;
        })
        : [`AI 接手分析任务未通过（${row.task_status}）`, ...(row.task_status === 'BLOCKED' ? (() => {
          const result = validateTakeoverOutputs(projectRoot(db, row.project_id));
          return result.ok ? [] : result.problems;
        })() : [])];
      if (row.task_status !== 'PASSED') inTransaction(db, () => settle(db, row.id, row.project_id, problems));
    } catch (error) {
      problems = [`接手分析结果无法入库：${(error as Error).message}`];
      inTransaction(db, () => settle(db, row.id, row.project_id, problems));
    }
    settled.push({ id: row.id, projectId: row.project_id, status: problems.length ? 'failed' : 'ready', problems });
  }
  return settled;
}
function settle(db: DatabaseSync, id: string, projectId: string, problems: string[]): void {
  const changed = db.prepare(`UPDATE project_recovery SET status = ?, warnings_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND status = 'analysis_pending'`).run(problems.length ? 'failed' : 'ready',
    JSON.stringify([...JSON.parse((db.prepare('SELECT warnings_json FROM project_recovery WHERE id = ?').get(id) as { warnings_json: string }).warnings_json) as string[],
      ...problems.slice(0, 20)]), id);
  if (!changed.changes) return;
  db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json) VALUES (NULL, 'runtime', 'project_recovery', ?, ?, ?, ?)`)
    .run(id, problems.length ? 'analysis_invalid' : 'analysis_ingested',
      problems.length ? `接手分析输出不完整：${problems.slice(0, 3).join('；')}` : '接手分析的候选事实已作为待确认推断入库',
      JSON.stringify({ projectId, problems: problems.length }));
}
