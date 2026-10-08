import { productionInputDocument } from './production.ts';
import { evidenceFresh, evidenceInputHashes } from '../process/evidence.ts';
import { buildAggregateInput } from '../state/aggregate-input.ts';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { stringify } from 'yaml';
import { hostPlatform } from '../host-platform.ts';
import type { ImportReport } from '../import/types.ts';
import { canonicalJson } from '../pack-hash.ts';
import { durableState, type DurableProjectState } from '../project-state.ts';
import { packageVersion } from '../provenance.ts';
import { SCHEMA_VERSION } from '../state/db.ts';
import { isSetupReviewRunning, type SetupReviewOwner } from '../setup-review.ts';
import { describeWorkflow } from '../workflow/view.ts';
import {
  ARCHIVE_MANIFEST, ARCHIVE_SCHEMA, SCHEMAS, localPathLeaks, localRoots, portableText, type FactView, type LocalRoot, type ShareLayer,
} from './contract.ts';
import { currentArtifactHash, factViews, latestFormalWorkflow } from './facts.ts';
import { BUILTIN_RULES, SOURCE_PRIORITY, storedEntries, type RegistryEntry } from './registry.ts';
import { scanProject, relativeInside, treeScanDue } from './scan.ts';
import { projectRoot, reconcileRecoveries } from './takeover.ts';

/**
 * The in-project archive (docs/project-archive.md): a versioned, open-format projection of the state database written
 * under `_harness/` at safe points. The database stays authoritative; each write fixes a revision (the digest of what
 * is projected) in the database first, writes every file atomically, reads the whole projection back and verifies it,
 * and records the outcome. A failed write blocks a shareable export until a later write verifies.
 */

export type Partition = 'state' | 'records' | 'evidence' | 'recovery' | 'packs' | 'optional' | 'sensitive';
export interface ProjectionFile { path: string; schema: string; partition: Partition; layer: ShareLayer; content: string; sha256: string; bytes: number }
export interface Projection { archiveId: string; files: ProjectionFile[]; digest: string; roots: LocalRoot[] }
export interface ArchiveManifest {
  schema: typeof ARCHIVE_SCHEMA; archiveId: string; revision: number; digest: string; createdAt: string;
  producer: { name: 'harness'; version: string; stateSchema: number };
  files: Array<Omit<ProjectionFile, 'content'>>;
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const byOrdinal = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
/** The digest a revision stands for: every projected file's path and content hash. The manifest itself is not in it. */
export function projectionDigest(files: Array<Pick<ProjectionFile, 'path' | 'sha256'>>): string {
  return sha256(canonicalJson([...files].sort((a, b) => byOrdinal(a.path, b.path)).map(file => [file.path, file.sha256])));
}

// ---------------------------------------------------------------------------------------------------------------------
// Building the projection: a pure function of the state database.

/** The local directories whose absolute paths must never appear in the archive, with the word that replaces them. */
function rootsOf(db: DatabaseSync, projectId: string, root: string): LocalRoot[] {
  const workspace = (db.prepare('SELECT w.path FROM project p JOIN workspace w ON w.id = p.workspace_id WHERE p.id = ?').get(projectId) as
    { path: string } | undefined)?.path;
  const dbFile = (db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>).find(row => row.name === 'main')?.file;
  const others: LocalRoot[] = [...(workspace ? [{ path: workspace, label: '<工作区>' }] : [])];
  if (dbFile) {
    const stateDir = dirname(dbFile);
    others.push({ path: basename(stateDir) === 'state' ? dirname(stateDir) : stateDir, label: '<AVH_HOME>' });
  }
  return localRoots(root, others);
}

type Sanitize = (value: string) => string;
function deep(value: unknown, text: Sanitize): unknown {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map(item => deep(item, text));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), deep(item, text)]));
  return value;
}
const parse = <T>(text: string | null | undefined, fallback: T): T => { try { return text ? JSON.parse(text) as T : fallback; } catch { return fallback; } };

/** A fact as the archive carries it: values and references in portable form. */
function portableFact(fact: FactView, text: Sanitize): Record<string, unknown> {
  return { id: fact.id, objectId: text(fact.objectId), attribute: fact.attribute, value: deep(fact.value, text),
    source: { type: fact.source.type, ref: text(fact.source.ref) }, locator: deep(fact.locator, text), inputFingerprint: fact.inputFingerprint,
    observer: text(fact.observer), observedAt: fact.observedAt, status: fact.status, effectiveStatus: fact.effectiveStatus,
    evidenceLevel: fact.evidenceLevel, confidence: fact.confidence, scope: text(fact.scope), invalidation: fact.invalidation,
    invalidatedBy: fact.invalidatedBy, shareLayer: fact.shareLayer, supersedes: fact.supersedes, current: fact.current, recordedAt: fact.recordedAt };
}

function registryDocument(db: DatabaseSync, projectId: string): Record<string, unknown> {
  const groups = new Map<string, { head: Record<string, unknown>; paths: Array<Record<string, unknown>> }>();
  for (const entry of storedEntries(db, projectId)) {
    const head = { source: entry.source, category: entry.category, layer: entry.shareLayer, rights: entry.rights, sensitivity: entry.sensitivity,
      restore: entry.restore ?? null, reason: entry.reason };
    const key = canonicalJson(head);
    if (!groups.has(key)) groups.set(key, { head, paths: [] });
    groups.get(key)!.paths.push({ path: entry.path, match: entry.match, sha256: entry.sha256 ?? null, order: entry.seq });
  }
  const scan = db.prepare(`SELECT scanned_at, files, unclassified, unclassified_json, symlinks_json, summary_json FROM project_scan
    WHERE project_id = ? ORDER BY seq DESC LIMIT 1`).get(projectId) as { scanned_at: string; files: number; unclassified: number;
      unclassified_json: string; symlinks_json: string; summary_json: string } | undefined;
  // A walk that finds what the previous one found changes nothing: the archive says since when the result holds, so a
  // refresh or a share that only walks the project again writes no new revision.
  if (scan) scan.scanned_at = (db.prepare(`SELECT MIN(scanned_at) AS since FROM project_scan WHERE project_id = ? AND seq > COALESCE((SELECT MAX(seq)
    FROM project_scan WHERE project_id = ? AND NOT (files = ? AND unclassified = ? AND unclassified_json = ? AND symlinks_json = ? AND summary_json = ?)), 0)`)
    .get(projectId, projectId, scan.files, scan.unclassified, scan.unclassified_json, scan.symlinks_json, scan.summary_json) as { since: string }).since;
  const rule = (entry: RegistryEntry) => ({ path: entry.path, match: entry.match, category: entry.category, layer: entry.shareLayer,
    rights: entry.rights, sensitivity: entry.sensitivity, restore: entry.restore ?? null, reason: entry.reason, source: entry.source,
    ...(entry.walk === false ? { walk: false } : {}) });
  return { schema: SCHEMAS.registry, precedence: SOURCE_PRIORITY, rules: BUILTIN_RULES.map(rule),
    entries: [...groups.values()].map(group => ({ ...group.head, paths: group.paths })),
    scan: scan ? { scannedAt: scan.scanned_at, files: scan.files, unclassified: scan.unclassified,
      unclassifiedSample: parse<string[]>(scan.unclassified_json, []), symlinks: parse<string[]>(scan.symlinks_json, []),
      ...parse<Record<string, unknown>>(scan.summary_json, {}) } : null };
}

/**
 * The Unity project's identity without order numbers: the editor and package facts in force (observed, or stated by a
 * person), else as imported.
 */
function portableIdentity(identity: unknown, facts: FactView[]): Record<string, unknown> {
  const stored = identity && typeof identity === 'object' && !Array.isArray(identity) ? identity as Record<string, unknown> : {};
  const fact = (attribute: string) => facts.find(item => item.objectId === 'project' && item.attribute === attribute &&
    (item.effectiveStatus === 'observed' || item.effectiveStatus === 'user_confirmed') && item.current);
  const version = fact('unity.version')?.value ?? stored.unityVersion ?? null;
  const packages = fact('vpm.locked')?.value ?? stored.packages ?? null;
  return { ...(typeof stored.kind === 'string' ? { kind: stored.kind } : {}), unityVersion: version, packages,
    ...(typeof stored.base === 'string' ? { base: stored.base } : {}) };
}

function portableAssets(state: DurableProjectState, root: string, text: Sanitize): Array<Record<string, unknown>> {
  return state.assets.map(asset => {
    const inside = relativeInside(root, asset.path);
    return { id: asset.id, name: text(asset.name), kind: asset.kind, status: asset.status, role: asset.role,
      location: inside ? { in: 'project', path: inside } : { in: 'library', file: text(basename(asset.path)) } };
  });
}

/** The legacy durable state (0.1) in portable form: no absolute path, no clock, no customer wording. */
function legacyState(state: DurableProjectState, identity: Record<string, unknown>, assets: Array<Record<string, unknown>>, text: Sanitize): string {
  const portable = { schema: SCHEMAS.legacyState, archive: ARCHIVE_MANIFEST,
    project: { id: state.project.id, lifecycle: state.project.lifecycle, identity },
    brief: state.brief ? { intakeMode: state.brief.intakeMode, faceConcept: text(state.brief.faceConcept), status: state.brief.status } : null,
    assets, ...(state.boothAvatars?.length ? { boothAvatars: state.boothAvatars } : {}),
    variants: deep(state.variants, text), roots: state.roots.map(({ blueprintId: _blueprint, ...root }) => deep(root, text)),
    workflow: deep(state.workflow, text), tasks: state.tasks.map(task => ({ id: task.id, stage: task.stage, status: task.status, updatedAt: task.updatedAt })),
    cases: deep(state.cases, text), gates: state.gates, evidence: state.evidence, acceptedDecisions: deep(state.acceptedDecisions, text) };
  return `# Harness 生成。不要用对话记录替代此项目事实。权威投影见 ${ARCHIVE_MANIFEST}。\n${stringify(portable)}`;
}

/** Everything the archive holds, from the database alone. Deterministic: the same database yields the same bytes. */
export function buildProjection(db: DatabaseSync, projectId: string, archiveId: string): Projection {
  const root = projectRoot(db, projectId);
  const roots = rootsOf(db, projectId, root);
  const text: Sanitize = value => portableText(value, roots);
  const facts = factViews(db, projectId, { history: true });
  const current = facts.filter(fact => fact.current);
  const state = durableState(db, projectId);
  const identity = portableIdentity(state.project.identity, current);
  const assets = portableAssets(state, root, text);
  const project = db.prepare('SELECT kind, lifecycle, identity_json FROM project WHERE id = ?').get(projectId) as
    { kind: string; lifecycle: string; identity_json: string };
  const rawIdentity = parse<Record<string, unknown>>(project.identity_json, {});
  const workflows = db.prepare(`SELECT w.id, w.status, w.process_id, w.process_hash, w.knowledge_version, d.profile, d.definition_json,
    d.capabilities_json, d.thresholds_json, d.manifest_json, d.tools_json, d.contexts_json, d.variables_json, d.frozen_at
    FROM workflow w JOIN workflow_definition d ON d.workflow_id = w.id WHERE w.project_id = ? ORDER BY w.rowid`).all(projectId) as Array<{
      id: string; status: string; process_id: string; process_hash: string; knowledge_version: string; profile: string; definition_json: string;
      capabilities_json: string; thresholds_json: string; manifest_json: string | null; tools_json: string; contexts_json: string;
      variables_json: string; frozen_at: string }>;
  const latest = latestFormalWorkflow(db, projectId);
  const allWorkflowIds = (db.prepare('SELECT id FROM workflow WHERE project_id = ? ORDER BY rowid').all(projectId) as Array<{ id: string }>).map(row => row.id);
  const view = latest ? describeWorkflow(db, latest.id) : undefined;

  // --- state/project.json
  const tasks = db.prepare(`SELECT t.id, t.workflow_id, t.stage_id, t.status, w.process_hash, (SELECT COUNT(*) FROM run r WHERE r.task_id = t.id) AS attempts,
    COALESCE((SELECT MAX(occurred_at) FROM event e WHERE e.entity_type = 'task' AND e.entity_id = t.id), '') AS updated_at,
    (SELECT reason FROM event e WHERE e.entity_type = 'task' AND e.entity_id = t.id AND e.action LIKE '%->%' ORDER BY e.seq DESC LIMIT 1) AS reason
    FROM task t JOIN workflow w ON w.id = t.workflow_id WHERE w.project_id = ? ORDER BY t.rowid`).all(projectId) as Array<{ id: string;
      workflow_id: string; stage_id: string; status: string; process_hash: string; attempts: number; updated_at: string; reason: string | null }>;
  const attention = tasks.filter(task => ['WAITING_HUMAN', 'BLOCKED', 'FAILED', 'RECOVERY_REQUIRED'].includes(task.status) &&
    (task.process_hash === 'avh-task/0.1' || task.workflow_id === latest?.id));
  const stateDocument = {
    schema: SCHEMAS.state, archiveId,
    project: { kind: project.kind, lifecycle: project.lifecycle, identity },
    brief: state.brief ? { intakeMode: state.brief.intakeMode, status: state.brief.status, faceConcept: text(state.brief.faceConcept) } : null,
    variants: deep(state.variants, text), roots: state.roots.map(({ blueprintId: _blueprint, ...root }) => deep(root, text)), assets,
    workflow: view ? { id: view.id, profile: view.profile, status: view.status, createdAt: view.createdAt, frozenAt: view.frozenAt,
      processHash: view.processHash, knowledgeVersion: view.knowledgeVersion,
      plan: { ...view.plan, ...(view.plan.error ? { error: text(view.plan.error) } : {}) },
      stages: view.stages.map(stage => ({ id: stage.id, status: stage.status, display: stage.display ?? stage.status, reasons: stage.reasons.map(text),
        codes: stage.codes, task: stage.task ?? null, gates: stage.gates, produces: stage.produces,
        checks: stage.checks.map(check => ({ id: check.id, severity: check.severity, on: check.on, verdict: check.verdict
          ? { result: check.verdict.result, recordedAt: check.verdict.recordedAt, current: check.verdict.current } : null })) })),
      milestones: view.milestones.map(item => ({ ...item, reasons: item.reasons.map(text) })),
      gates: view.gates.map(gate => ({ gate: gate.gate, kind: gate.kind, binds: gate.binds, owner: gate.owner, status: gate.status,
        artifactHash: gate.artifactHash ?? null })), next: text(view.next) } : null,
    tasks: tasks.map(task => ({ id: task.id, workflowId: task.workflow_id, formal: task.process_hash !== 'avh-task/0.1', stage: task.stage_id,
      status: task.status, attempts: task.attempts, updatedAt: task.updated_at })),
    // What a person or a recovery has to settle before work continues: the unknown outcome of a Run is never guessed.
    attention: attention.map(task => ({ taskId: task.id, workflowId: task.workflow_id, stage: task.stage_id, status: task.status,
      reason: text(task.reason ?? '') })),
    cases: deep(state.cases, text),
  };

  // --- state/workflows.json: the frozen process of every formal Workflow; knowledge content travels as hashes.
  const workflowsDocument = { schema: SCHEMAS.workflows, workflows: workflows.map(row => {
    const manifest = parse<Record<string, unknown> | null>(row.manifest_json, null);
    return { id: row.id, profile: row.profile, status: row.status, processId: row.process_id, processHash: row.process_hash,
      knowledgeVersion: row.knowledge_version, frozenAt: row.frozen_at, current: row.id === latest?.id,
      definition: parse(row.definition_json, {}), capabilities: deep(parse(row.capabilities_json, {}), text), thresholds: parse(row.thresholds_json, {}),
      tools: parse(row.tools_json, {}),
      contexts: Object.fromEntries(Object.entries(parse<Record<string, { sha256: string }>>(row.contexts_json, {})).map(([path, item]) => [path, item.sha256])),
      variables: Object.keys(parse<Record<string, string>>(row.variables_json, {})).sort(),
      manifest: manifest ? { schema: manifest.schema, profile: manifest.profile,
        assets: deep(((manifest.assets ?? []) as Array<Record<string, unknown>>).map(asset => {
          const item = typeof asset.item === 'string' ? asset.item : '';
          const inside = /[\\/]/.test(item) ? relativeInside(root, item) : undefined;
          return { store: asset.store, role: asset.role ?? null, variant: asset.variant ?? null, name: asset.name ?? null,
            item: inside ?? (/[\\/]/.test(item) ? basename(item) : item),sha256:asset.sha256??null,location:inside!==undefined?'project':'external' };
        }), text), variants: deep(manifest.variants ?? [], text) } : null };
  }) };

  // --- records/decisions.json
  const decisionsDocument = { schema: SCHEMAS.decisions, workflows: workflows.map(row => {
    const definition = parse<{ gates?: Array<{ id: string; binds: string }> }>(row.definition_json, {});
    const plans = db.prepare(`SELECT seq, hash, observed_at, error FROM plan_revision WHERE workflow_id = ? ORDER BY seq`).all(row.id) as
      Array<{ seq: number; hash: string; observed_at: string; error: string | null }>;
    const decided = new Set((db.prepare('SELECT artifact_hash FROM gate_decision WHERE workflow_id = ?').all(row.id) as Array<{ artifact_hash: string }>)
      .map(item => item.artifact_hash));
    const currentPlan = row.id === latest?.id ? (db.prepare(`SELECT content_json FROM plan_revision WHERE workflow_id = ? AND content_json IS NOT NULL
      ORDER BY seq DESC LIMIT 1`).get(row.id) as { content_json: string } | undefined)?.content_json : undefined;
    const gates = db.prepare('SELECT seq, gate_id, result, artifact_hash, input_hashes_json, selection_json, recorded_at FROM gate_decision WHERE workflow_id = ? ORDER BY seq')
      .all(row.id) as Array<{ seq: number; gate_id: string; result: string; artifact_hash: string; input_hashes_json: string | null; selection_json: string | null; recorded_at: string }>;
    const rejections = db.prepare(`SELECT seq, entity_id, occurred_at, json_extract(payload_json, '$.hash') AS hash FROM event
      WHERE workflow_id = ? AND entity_type = 'gate' AND action = 'rejected' ORDER BY seq`).all(row.id) as
      Array<{ seq: number; entity_id: string; occurred_at: string; hash: string | null }>;
    return { workflowId: row.id, current: row.id === latest?.id,
      plans: plans.map(plan => ({ order: plan.seq, hash: plan.hash, observedAt: plan.observed_at, ...(plan.error ? { error: text(plan.error) } : {}),
        decided: decided.has(plan.hash) })),
      currentPlan: currentPlan ? deep(parse(currentPlan, {}), text) : null,
      gates: gates.map(gate => {
        const binds = definition.gates?.find(item => item.id === gate.gate_id)?.binds;
        // Only the current Workflow's decisions can still be valid, and only while their artifact is unchanged.
        const valid = row.id === latest?.id && binds ? evidenceFresh(gate.artifact_hash,
          currentArtifactHash(db, projectId, row.id, binds) ?? undefined,parse(gate.input_hashes_json,undefined),
          evidenceInputHashes(latest!.definition,{gateId:gate.gate_id},buildAggregateInput(db,row.id).artifactHashes)) : null;
        return { order: gate.seq, gateId: gate.gate_id, result: gate.result, artifactHash: gate.artifact_hash, inputHashes: parse(gate.input_hashes_json, undefined), selection: parse(gate.selection_json, undefined), recordedAt: gate.recorded_at,
          binds: binds ?? null, valid };
      }),
      rejections: rejections.map(item => ({ order: item.seq, gate: item.entity_id.slice(item.entity_id.lastIndexOf(':') + 1),
        artifactHash: item.hash, at: item.occurred_at })) };
  }), accepted: state.acceptedDecisions.map(item => ({ content: text(item.content), at: item.at })) };

  // --- records/events.json and the people's own words for sensitive/
  const recoveries = db.prepare(`SELECT id, source_kind, source_path, source_hash, mode, distill, status, analysis_task_id, apply_task_id,
    candidate_roots_json, warnings_json, created_at, updated_at FROM project_recovery WHERE project_id = ? ORDER BY created_at, id`).all(projectId) as
    Array<{ id: string; source_kind: string; source_path: string; source_hash: string; mode: string; distill: number; status: string;
      analysis_task_id: string | null; apply_task_id: string | null; candidate_roots_json: string; warnings_json: string; created_at: string; updated_at: string }>;
  const reports = db.prepare('SELECT id, created_at, report_json FROM import_report WHERE project_id = ? ORDER BY created_at, rowid').all(projectId) as
    Array<{ id: string; created_at: string; report_json: string }>;
  const messages = db.prepare(`SELECT id, role, content, status, created_at FROM project_message WHERE project_id = ? ORDER BY created_at, rowid`)
    .all(projectId) as Array<{ id: string; role: string; content: string; status: string; created_at: string }>;
  const placeholders = (items: string[]) => items.map(() => '?').join(',') || "''";
  const entityIds = [projectId, ...recoveries.map(item => item.id), ...reports.map(item => item.id), ...messages.map(item => item.id)];
  const events = db.prepare(`SELECT seq, workflow_id, actor, entity_type, entity_id, action, reason, payload_json, occurred_at FROM event
    WHERE workflow_id IN (${placeholders(allWorkflowIds)}) OR entity_id IN (${placeholders(entityIds)})
      OR (entity_type = 'project_fact' AND json_extract(payload_json, '$.projectId') = ?)
      OR (entity_type = 'project_asset' AND entity_id LIKE ? ESCAPE '\\') ORDER BY seq`)
    .all(...allWorkflowIds, ...entityIds, projectId, `${projectId.replace(/[\\%_]/g, '\\$&')}:%`) as Array<{ seq: number;
      workflow_id: string | null; actor: string; entity_type: string; entity_id: string; action: string; reason: string; payload_json: string; occurred_at: string }>;
  const event = (row: typeof events[number]) => ({ order: row.seq, at: row.occurred_at, workflowId: row.workflow_id, actor: row.actor,
    entityType: row.entity_type, entityId: text(row.entity_id), action: row.action, reason: text(row.reason), payload: deep(parse(row.payload_json, {}), text) });
  const runs = db.prepare(`SELECT r.id, r.task_id, r.attempt, r.status, r.provider, r.result_json FROM run r JOIN task t ON t.id = r.task_id
    JOIN workflow w ON w.id = t.workflow_id WHERE w.project_id = ? ORDER BY r.rowid`).all(projectId) as Array<{ id: string; task_id: string;
      attempt: number; status: string; provider: string | null; result_json: string | null }>;
  const eventsDocument = { schema: SCHEMAS.events, events: events.filter(row => row.actor !== 'human').map(event),
    runs: runs.map(run => {
      const result = parse<{ exitStatus?: number | null; errorClass?: string; noSideEffects?: boolean }>(run.result_json, {});
      return { id: run.id, taskId: run.task_id, attempt: run.attempt, status: run.status, provider: run.provider,
        exitStatus: result.exitStatus ?? null, errorClass: result.errorClass ?? null };
    }) };

  // --- records/sources.json
  const boothPlans = db.prepare(`SELECT id, variant_id, workflow_id, status, rationale, created_by, created_at FROM asset_selection_plan
    WHERE project_id = ? ORDER BY created_at, id`).all(projectId) as Array<{ id: string; variant_id: string | null; workflow_id: string | null;
      status: string; rationale: string; created_by: string; created_at: string }>;
  const sourcesDocument = { schema: SCHEMAS.sources,
    imports: reports.map(row => {
      const report = parse<Partial<ImportReport>>(row.report_json, {});
      const ledger = [...(report.ledger ?? []), ...(report.externalLedger ?? [])];
      return { id: row.id, createdAt: row.created_at, processId: report.processId ?? null, processVersion: report.processVersion ?? null,
        processHash: report.processHash ?? null, generatedFrom: report.generated_from ?? null, snapshotHash: report.snapshotHash ?? null,
        sampledFiles: report.snapshotSampledFiles?.length ?? 0,
        identity: report.identity ? { kind: report.identity.kind, unityVersion: report.identity.unityVersion ?? null,
          packages: report.identity.packages ?? {}, ...(report.identity.base ? { base: text(report.identity.base) } : {}) } : null,
        stages: (report.stages ?? []).map(stage => ({ id: stage.id, status: stage.status, weakEvidence: Boolean(stage.weakEvidence) })),
        reviews: (report.reviews ?? []).map(review => ({ id: review.id, status: review.status })),
        counts: { ledgerOpen: ledger.filter(item => item.status !== 'done' && item.status !== 'dropped').length,
          ledgerClosed: ledger.filter(item => item.status === 'done' || item.status === 'dropped').length, timeline: report.timeline?.count ?? 0,
          gaps: report.gaps?.length ?? 0, blockers: report.blockers?.length ?? 0 } };
    }),
    assets: (db.prepare(`SELECT a.id, a.name, a.kind, a.status, a.license, a.tags_json, a.path, pa.role FROM project_asset pa
      JOIN asset a ON a.id = pa.asset_id WHERE pa.project_id = ? ORDER BY pa.attached_at, a.id`).all(projectId) as Array<{ id: string; name: string;
        kind: string; status: string; license: string; tags_json: string; path: string; role: string }>).map(asset => {
      const inside = relativeInside(root, asset.path);
      return { id: asset.id, name: text(asset.name), kind: asset.kind, status: asset.status, role: asset.role, license: text(asset.license),
        tags: parse<string[]>(asset.tags_json, []).map(text), location: inside ? { in: 'project', path: inside } : { in: 'library', file: text(basename(asset.path)) },
        // Transfer needs a recorded basis; a library asset has none unless its license says so.
        rights: 'unknown' };
    }),
    booth: boothPlans.map(plan => ({ id: plan.id, variantId: plan.variant_id, workflowId: plan.workflow_id, status: plan.status,
      rationale: text(plan.rationale), createdBy: plan.created_by, createdAt: plan.created_at,
      // The version the plan pinned (sha256 in the BOOTH version pool), and whether its bytes were fetched for the plan and are here.
      files: (db.prepare(`SELECT s.downloadable_id, s.purpose, s.selected, f.filename, COALESCE(v.remote_version, f.remote_version) AS remote_version,
        COALESCE(v.byte_size, f.byte_size) AS byte_size, i.item_id, i.name, i.shop_name, i.item_url, i.category, n.sha256,
        CASE WHEN n.materialized_at IS NULL THEN NULL WHEN b.status = 'removed' THEN 'missing' ELSE b.status END AS materialized
        FROM asset_selection_file s JOIN booth_file f ON f.downloadable_id = s.downloadable_id JOIN booth_item i ON i.item_id = f.item_id
        LEFT JOIN asset_selection_pin n ON n.plan_id = s.plan_id AND n.downloadable_id = s.downloadable_id
        LEFT JOIN booth_file_version v ON v.downloadable_id = n.downloadable_id AND v.sha256 = n.sha256 LEFT JOIN pool_blob b ON b.sha256 = n.sha256
        WHERE s.plan_id = ? ORDER BY s.downloadable_id`).all(plan.id) as Array<{ downloadable_id: string; purpose: string; selected: number;
          filename: string; remote_version: string; byte_size: number | null; item_id: string; name: string; shop_name: string; item_url: string;
          category: string; sha256: string | null; materialized: string | null }>).map(file => ({ downloadableId: file.downloadable_id,
        purpose: text(file.purpose), selected: Boolean(file.selected), filename: file.filename, remoteVersion: file.remote_version,
        byteSize: file.byte_size, sha256: file.sha256, materialized: file.materialized,
        item: { id: file.item_id, name: file.name, shop: file.shop_name, url: file.item_url, category: file.category },
        // A paid BOOTH purchase is licensed to the buyer: not transferable unless a license record says otherwise.
        rights: 'not_transferable' })) })),
    vpmActions: (db.prepare(`SELECT action, package_id, requested_version, result, created_at FROM project_package_action WHERE project_id = ?
      ORDER BY created_at, id`).all(projectId) as Array<{ action: string; package_id: string | null; requested_version: string | null; result: string;
        created_at: string }>).map(row => ({ action: row.action, packageId: row.package_id, requestedVersion: row.requested_version,
      result: row.result, at: row.created_at })) };

  // --- evidence/index.json
  const verdictRows = latest ? db.prepare(`SELECT id, check_id, scope, artifact_hash, result, basis, input_hashes_json, recorded_at FROM verdict WHERE workflow_id = ?
    ORDER BY seq`).all(latest.id) as Array<{ id: string; check_id: string; scope: string; artifact_hash: string; result: string; basis: string | null; input_hashes_json: string | null;
      recorded_at: string }> : [];
  const artifactRows = latest ? db.prepare('SELECT seq, kind, hash, observed_at FROM artifact_version WHERE workflow_id = ? ORDER BY seq')
    .all(latest.id) as Array<{ seq: number; kind: string; hash: string; observed_at: string }> : [];
  const lastReport = reports.at(-1);
  const inputs = db.prepare(`SELECT input, fingerprint, observed_at FROM project_input_observation WHERE seq IN
    (SELECT MAX(seq) FROM project_input_observation WHERE project_id = ? GROUP BY input) ORDER BY input`).all(projectId) as
    Array<{ input: string; fingerprint: string | null; observed_at: string }>;
  const evidenceDocument = { schema: SCHEMAS.evidence, workflowId: latest?.id ?? null,
    verdicts: verdictRows.map(row => {
      const check = latest!.definition.checks.find(item => item.id === row.check_id);
      const on = row.result === 'not_applicable' ? 'plan' : check?.on;
      return { id: row.id, checkId: row.check_id, scope: row.scope, result: row.result, basis: row.basis === null ? null : text(row.basis),
        inputHashes: parse(row.input_hashes_json, undefined), artifact: on ?? null, artifactHash: row.artifact_hash, recordedAt: row.recorded_at,
        current: Boolean(on) && evidenceFresh(row.artifact_hash, currentArtifactHash(db, projectId, latest!.id, on!) ?? undefined, parse(row.input_hashes_json, undefined), evidenceInputHashes(latest!.definition, { checkId: row.check_id }, buildAggregateInput(db, latest!.id).artifactHashes)) };
    }),
    artifacts: artifactRows.map(row => ({ order: row.seq, kind: row.kind, hash: row.hash || null, observedAt: row.observed_at,
      latest: artifactRows.filter(item => item.kind === row.kind).at(-1) === row })),
    completions: latest ? (db.prepare(`SELECT seq, stage_id, artifact_hashes_json, run_id, recorded_at FROM stage_completion WHERE workflow_id = ?
      ORDER BY seq`).all(latest.id) as Array<{ seq: number; stage_id: string; artifact_hashes_json: string; run_id: string | null; recorded_at: string }>)
      .map(row => ({ order: row.seq, stage: row.stage_id, artifactHashes: parse(row.artifact_hashes_json, {}), runId: row.run_id, recordedAt: row.recorded_at })) : [],
    importReviews: lastReport ? (parse<Partial<ImportReport>>(lastReport.report_json, {}).reviews ?? []).map(review => ({ id: review.id,
      status: review.status, reason: text(review.reason), evidence: review.evidence.map(item => ({ source: text(item.source), detail: text(item.detail) })) })) : [],
    inputs: inputs.map(row => ({ input: text(row.input), fingerprint: row.fingerprint, observedAt: row.observed_at })),
    // Writes a stage made outside its artifacts: an unaccepted one holds the stage for a person, on any machine.
    outOfBounds: latest ? (db.prepare(`SELECT seq, stage_id, artifact, accepted, recorded_at FROM out_of_bounds_change WHERE workflow_id = ?
      ORDER BY seq`).all(latest.id) as Array<{ seq: number; stage_id: string; artifact: string; accepted: number; recorded_at: string }>)
      .map(row => ({ order: row.seq, stage: row.stage_id, artifact: text(row.artifact), accepted: Boolean(row.accepted), recordedAt: row.recorded_at })) : [] };

  // --- recovery/takeover.json
  const takeoverDocument = { schema: SCHEMAS.takeover,
    recoveries: recoveries.map(row => {
      const scoped = current.filter(fact => fact.scope === `recovery:${row.id}`);
      return { id: row.id, sourceKind: row.source_kind, sourceHash: row.source_hash, mode: row.mode, distill: Boolean(row.distill), status: row.status,
        analysisTaskId: row.analysis_task_id, applyTaskId: row.apply_task_id,
        candidateRoots: parse<string[]>(row.candidate_roots_json, []).map(path => relativeInside(root, path) ?? text(path)),
        warnings: parse<string[]>(row.warnings_json, []).map(text), createdAt: row.created_at, updatedAt: row.updated_at,
        candidates: scoped.filter(fact => !fact.objectId.startsWith('question:')).map(fact => fact.id),
        questions: scoped.filter(fact => fact.objectId.startsWith('question:')).map(fact => fact.id) };
    }),
    // What no file could prove: the receiver starts from a baseline instead of trusting a reconstructed history.
    unknown: current.filter(fact => fact.effectiveStatus === 'unknown').map(fact => ({ objectId: fact.objectId, attribute: fact.attribute, factId: fact.id })) };

  // --- packs/index.json
  const authorings = db.prepare(`SELECT id, base_pack_id, candidate_id, source_root, task_id, status, created_at FROM managed_pack_authoring
    WHERE project_id = ? ORDER BY created_at, id`).all(projectId) as Array<{ id: string; base_pack_id: string; candidate_id: string;
      source_root: string; task_id: string | null; status: string; created_at: string }>;
  const trials = db.prepare(`SELECT id, candidate_id, workflow_id, content_hash, mode, status, restrictions_json, created_at, activated_at, disabled_at
    FROM managed_pack_trial WHERE project_id = ? ORDER BY created_at, id`).all(projectId) as Array<{ id: string; candidate_id: string;
      workflow_id: string | null; content_hash: string; mode: string; status: string; restrictions_json: string; created_at: string;
      activated_at: string | null; disabled_at: string | null }>;
  const candidateIds = [...new Set([...authorings.map(item => item.candidate_id), ...trials.map(item => item.candidate_id)])].sort(byOrdinal);
  const inputMap = new Map(inputs.map(row => [row.input, row.fingerprint]));
  const packsDocument = { schema: SCHEMAS.packs,
    candidates: candidateIds.flatMap(id => {
      const row = db.prepare(`SELECT id, base_pack_id, version, content_hash, source_kind, status, permissions_json, impact_json, created_at
        FROM managed_pack_candidate WHERE id = ?`).get(id) as { id: string; base_pack_id: string; version: string; content_hash: string;
          source_kind: string; status: string; permissions_json: string; impact_json: string; created_at: string } | undefined;
      const authoring = authorings.find(item => item.candidate_id === id);
      const draftPath = authoring ? relativeInside(root, authoring.source_root) : undefined;
      const draftHash = inputMap.get(`pack-draft:${id}`);
      const evaluation = db.prepare(`SELECT status, suite_id, suite_version, isolation, finished_at FROM managed_pack_evaluation
        WHERE candidate_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`).get(id) as { status: string; suite_id: string; suite_version: string;
          isolation: string; finished_at: string | null } | undefined;
      const registered = Boolean(row);
      const matches = registered && draftHash !== undefined ? draftHash === row!.content_hash : null;
      return [{ id, registered, basePackId: row?.base_pack_id ?? authoring?.base_pack_id ?? null, version: row?.version ?? null,
        contentHash: row?.content_hash ?? null, sourceKind: row?.source_kind ?? null, status: row?.status ?? null,
        permissions: row ? parse(row.permissions_json, {}) : null,
        authorityAudit: row ? (parse<{ authorityAudit?: unknown }>(row.impact_json, {}).authorityAudit ?? null) : null,
        evaluation: evaluation ? { status: evaluation.status, suiteId: evaluation.suite_id, suiteVersion: evaluation.suite_version,
          isolation: evaluation.isolation, finishedAt: evaluation.finished_at } : null,
        draft: draftPath ? { path: draftPath.endsWith('/') ? draftPath : `${draftPath}/`, treeHash: draftHash ?? null, matchesContent: matches } : null,
        // Where a receiver of the same Harness version gets the exact registered content back.
        restoreFrom: matches ? 'project-draft' : registered ? 'local-store' : 'unregistered' }];
    }),
    authorings: authorings.map(item => ({ id: item.id, candidateId: item.candidate_id, basePackId: item.base_pack_id, status: item.status,
      taskId: item.task_id, draft: relativeInside(root, item.source_root) ?? null, createdAt: item.created_at })),
    trials: trials.map(item => ({ id: item.id, candidateId: item.candidate_id, contentHash: item.content_hash, mode: item.mode, status: item.status,
      workflowId: item.workflow_id, restrictions: parse(item.restrictions_json, {}), createdAt: item.created_at, activatedAt: item.activated_at,
      disabledAt: item.disabled_at })) };

  // --- sensitive/project.json: customer wording, order numbers, people's notes, source names.
  const sensitiveDocument = { schema: SCHEMAS.sensitive,
    identity: { ...(typeof rawIdentity.orderNumber === 'string' ? { orderNumber: rawIdentity.orderNumber } : {}) },
    brief: state.brief?.goal ? { goal: text(state.brief.goal) } : null,
    humanEvents: events.filter(row => row.actor === 'human').map(event),
    manifests: workflows.flatMap(row => {
      const manifest = parse<{ request?: string; faceConcept?: string } | null>(row.manifest_json, null);
      return manifest?.request ? [{ workflowId: row.id, request: text(manifest.request) }] : [];
    }),
    blueprints: state.roots.filter(item => item.blueprintId.trim()).map(item => ({ rootId: item.id, blueprintId: item.blueprintId })),
    recoverySources: recoveries.map(item => ({ id: item.id, name: text(basename(item.source_path)) })) };
  // --- sensitive/conversation.json: the project's whole conversation, a document of its own so a share can carry it
  // (or leave it out) apart from the customer's other material.
  const conversationDocument = { schema: SCHEMAS.conversation,
    messages: messages.map(item => ({ id: item.id, role: item.role, status: item.status, content: text(item.content), at: item.created_at })) };

  const factFile = (layer: ShareLayer) => ({ schema: SCHEMAS.facts, layer,
    facts: facts.filter(fact => fact.shareLayer === layer).sort((a, b) => byOrdinal(a.objectId, b.objectId) || byOrdinal(a.attribute, b.attribute) ||
      byOrdinal(a.recordedAt, b.recordedAt) || byOrdinal(a.id, b.id)).map(fact => portableFact(fact, text)) });
  const documents: Array<{ path: string; schema: string; partition: Partition; layer: ShareLayer; content: string }> = [
    { path: '_harness/state/project.json', schema: SCHEMAS.state, partition: 'state', layer: 'A', content: json(stateDocument) },
    { path: '_harness/state/project.yaml', schema: SCHEMAS.legacyState, partition: 'state', layer: 'A', content: legacyState(state, identity, assets, text) },
    { path: '_harness/state/facts.json', schema: SCHEMAS.facts, partition: 'state', layer: 'A', content: json(factFile('A')) },
    { path: '_harness/state/registry.json', schema: SCHEMAS.registry, partition: 'state', layer: 'A', content: json(registryDocument(db, projectId)) },
    { path: '_harness/state/production.json', schema: SCHEMAS.production, partition: 'state', layer: 'A', content: json(productionInputDocument(db, projectId, text)) },
    { path: '_harness/state/workflows.json', schema: SCHEMAS.workflows, partition: 'state', layer: 'A', content: json(workflowsDocument) },
    { path: '_harness/records/decisions.json', schema: SCHEMAS.decisions, partition: 'records', layer: 'A', content: json(decisionsDocument) },
    { path: '_harness/records/sources.json', schema: SCHEMAS.sources, partition: 'records', layer: 'A', content: json(sourcesDocument) },
    { path: '_harness/records/events.json', schema: SCHEMAS.events, partition: 'records', layer: 'B', content: json(eventsDocument) },
    { path: '_harness/evidence/index.json', schema: SCHEMAS.evidence, partition: 'evidence', layer: 'A', content: json(evidenceDocument) },
    { path: '_harness/recovery/takeover.json', schema: SCHEMAS.takeover, partition: 'recovery', layer: 'A', content: json(takeoverDocument) },
    { path: '_harness/packs/index.json', schema: SCHEMAS.packs, partition: 'packs', layer: 'A', content: json(packsDocument) },
    { path: '_harness/optional/facts.json', schema: SCHEMAS.facts, partition: 'optional', layer: 'B', content: json(factFile('B')) },
    { path: '_harness/sensitive/facts.json', schema: SCHEMAS.facts, partition: 'sensitive', layer: 'C', content: json(factFile('C')) },
    { path: '_harness/sensitive/project.json', schema: SCHEMAS.sensitive, partition: 'sensitive', layer: 'C', content: json(sensitiveDocument) },
    { path: '_harness/sensitive/conversation.json', schema: SCHEMAS.conversation, partition: 'sensitive', layer: 'C', content: json(conversationDocument) },
  ];
  const files = documents.map(document => ({ ...document, sha256: sha256(document.content), bytes: Buffer.byteLength(document.content) }));
  return { archiveId, files, digest: projectionDigest(files), roots };
}

// ---------------------------------------------------------------------------------------------------------------------
// Writing, reading back and checking.

function executionSafePointProblem(db: DatabaseSync, projectId: string): string | undefined {
  const active = db.prepare(`SELECT t.id, t.status FROM task t JOIN workflow w ON w.id = t.workflow_id WHERE w.project_id = ?
    AND t.status IN ('RUNNING', 'VERIFYING') LIMIT 1`).get(projectId) as { id: string; status: string } | undefined;
  if (active) return `任务 ${active.id.slice(0, 8)} 正在${active.status === 'RUNNING' ? '执行' : '检查'}`;
  const lock = db.prepare('SELECT run_id FROM lock WHERE resource = ?').get(`project:${projectId}`) as { run_id: string } | undefined;
  if (lock) return `工程仍被 Run ${lock.run_id.slice(0, 8)} 占用`;
  return undefined;
}

/** Projection writers never run while execution or a live recovery review protects the project. */
export function safePointProblem(db: DatabaseSync, projectId: string): string | undefined {
  return executionSafePointProblem(db, projectId) ?? (isSetupReviewRunning(db, projectId)
    ? '正在保留并核对原工程，档案将在核对结束后更新' : undefined);
}

function readManifest(root: string): { manifest?: ArchiveManifest; text?: string; problem?: string } {
  const path = join(root, ...ARCHIVE_MANIFEST.split('/'));
  if (!existsSync(path)) return { problem: 'missing' };
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) { return { problem: `无法读取档案清单：${(error as Error).message}` }; }
  try {
    const manifest = JSON.parse(text) as ArchiveManifest;
    if (manifest?.schema !== ARCHIVE_SCHEMA) return { problem: `档案清单的 schema 不是 ${ARCHIVE_SCHEMA}`, text };
    if (!Array.isArray(manifest.files) || typeof manifest.digest !== 'string' || !Number.isSafeInteger(manifest.revision))
      return { problem: '档案清单结构不完整', text };
    return { manifest, text };
  } catch (error) { return { problem: `档案清单不是合法 JSON：${(error as Error).message}`, text }; }
}

/** The portable identity of the project, created at its first projection or adopted from an archive already in it. */
function archiveIdentity(db: DatabaseSync, projectId: string, root: string): string {
  const known = db.prepare('SELECT archive_id FROM project_archive_identity WHERE project_id = ?').get(projectId) as { archive_id: string } | undefined;
  if (known) return known.archive_id;
  const found = readManifest(root).manifest?.archiveId;
  const adoptable = typeof found === 'string' && /^[0-9a-f-]{36}$/.test(found) &&
    !db.prepare('SELECT 1 FROM project_archive_identity WHERE archive_id = ?').get(found);
  const archiveId = adoptable ? found : randomUUID();
  db.prepare('INSERT INTO project_archive_identity (project_id, archive_id, origin) VALUES (?, ?, ?)').run(projectId, archiveId, adoptable ? 'adopted' : 'created');
  return archiveId;
}

/** Every problem of the projection on disk against a manifest: missing or changed files, wrong schema, local paths. */
export function verifyOnDisk(root: string, manifest: ArchiveManifest, roots: LocalRoot[]): string[] {
  const problems: string[] = [];
  if (projectionDigest(manifest.files) !== manifest.digest) problems.push('档案清单的摘要与文件列表不符');
  for (const file of manifest.files) {
    const path = join(root, ...file.path.split('/'));
    let content: string;
    try { content = readFileSync(path, 'utf8'); } catch { problems.push(`缺少 ${file.path}`); continue; }
    if (sha256(content) !== file.sha256) { problems.push(`${file.path} 与档案清单记录的内容不同`); continue; }
    if (file.path.endsWith('.json')) {
      let value: unknown;
      try { value = JSON.parse(content); } catch { problems.push(`${file.path} 不是合法 JSON`); continue; }
      if ((value as { schema?: unknown })?.schema !== file.schema) problems.push(`${file.path} 的 schema 不是 ${file.schema}`);
    }
    const leaks = localPathLeaks(file.path.endsWith('.json') ? JSON.parse(content) as unknown : content, roots);
    if (leaks.length) problems.push(`${file.path} 含本机绝对路径（${leaks[0]!.pointer || '/'}：${leaks[0]!.sample}）`);
  }
  return problems;
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Replace a file atomically; Windows may briefly refuse a rename while another process reads the target. */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.next-${process.pid}-${randomUUID().slice(0, 8)}`;
  hostPlatform.writePrivate(temporary, content);
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, path); return; }
    catch (error) {
      if (attempt >= 5 || !RETRYABLE.has((error as { code?: string }).code ?? '')) { rmSync(temporary, { force: true }); throw error; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1));
    }
  }
}

export interface ArchiveWriteResult {
  status: 'verified' | 'unchanged' | 'failed' | 'deferred';
  revision?: number; digest?: string; error?: string; reason?: string; manifest: string;
}
export interface WriteHooks {
  /** Retry a revision whose write failed less than a minute ago (an explicit refresh; safe points wait). */
  force?: boolean;
  /** Test hook: called after the files are written and before they are read back. */
  beforeVerify?: (root: string) => void;
  /**
   * Renew the scheduler lease and check ownership at the write boundary. The project scan before this write is long,
   * and the archive belongs to the state store: a cycle that lost the lease must stop instead of writing here.
   */
  heartbeat?: () => void;
}
const RETRY_AFTER_MS = 60_000;
/** A failed write is recorded once per distinct reason, so a failure that persists does not grow the event log. */
function recordFailure(db: DatabaseSync, projectId: string, reason: string, revision?: number): void {
  const text = `工程档案写入失败：${reason}`.slice(0, 2000);
  const last = db.prepare(`SELECT action, reason FROM event WHERE entity_type = 'project_state' AND entity_id = ? ORDER BY seq DESC LIMIT 1`)
    .get(projectId) as { action: string; reason: string } | undefined;
  if (last?.action === 'projection_failed' && last.reason === text) return;
  db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json)
    VALUES (NULL, 'runtime', 'project_state', ?, 'projection_failed', ?, ?)`).run(projectId, text, JSON.stringify(revision ? { revision } : {}));
}

/**
 * Write the project's archive at a safe point. One IMMEDIATE transaction covers the whole write: it excludes another
 * writer and a Run dispatch (the scheduler would otherwise start a Run while its project is being written).
 */
export function writeProjectArchive(db: DatabaseSync, projectId: string, hooks: WriteHooks = {}): ArchiveWriteResult {
  if (db.isTransaction) throw new Error('工程档案不能在未提交的事务中写入');
  const root = projectRoot(db, projectId);
  const manifestPath = join(root, ...ARCHIVE_MANIFEST.split('/'));
  if (!existsSync(root)) return { status: 'deferred', reason: '工程目录不存在', manifest: manifestPath };
  // Most safe points find nothing new: decide that from a read snapshot, without taking the database's write lock.
  if (!hooks.beforeVerify) {
    db.exec('BEGIN');
    let quick: ArchiveWriteResult | undefined;
    try { quick = unchangedArchive(db, projectId, root, manifestPath); } finally { db.exec('COMMIT'); }
    if (quick) return quick;
  }
  // The scan that fed this write is long; renew and check ownership before the write transaction is taken.
  hooks.heartbeat?.();
  db.exec('BEGIN IMMEDIATE');
  let revision: number | undefined, digest: string | undefined;
  try {
    const problem = safePointProblem(db, projectId);
    if (problem) { db.exec('COMMIT'); return { status: 'deferred', reason: problem, manifest: manifestPath }; }
    const archiveId = archiveIdentity(db, projectId, root);
    const projection = buildProjection(db, projectId, archiveId);
    digest = projection.digest;
    const latest = db.prepare('SELECT number, digest, created_at FROM project_revision WHERE project_id = ? ORDER BY number DESC LIMIT 1')
      .get(projectId) as { number: number; digest: string; created_at: string } | undefined;
    let fixed = latest;
    if (latest?.digest !== projection.digest) {
      const number = (latest?.number ?? 0) + 1;
      db.prepare('INSERT INTO project_revision (project_id, number, digest) VALUES (?, ?, ?)').run(projectId, number, projection.digest);
      fixed = db.prepare('SELECT number, digest, created_at FROM project_revision WHERE project_id = ? AND number = ?').get(projectId, number) as typeof latest;
    }
    revision = fixed!.number;
    const manifest: ArchiveManifest = { schema: ARCHIVE_SCHEMA, archiveId, revision, digest: projection.digest, createdAt: fixed!.created_at,
      producer: { name: 'harness', version: producerVersion(), stateSchema: SCHEMA_VERSION },
      files: projection.files.map(({ content: _content, ...file }) => file) };
    const manifestText = json(manifest);
    const lastWrite = db.prepare(`SELECT status, manifest_sha256, recorded_at FROM project_archive_write WHERE project_id = ? AND revision = ?
      ORDER BY seq DESC LIMIT 1`).get(projectId, revision) as { status: string; manifest_sha256: string | null; recorded_at: string } | undefined;
    // Nothing new, and the verified files are still there as written: nothing to do.
    if (fixed === latest && lastWrite?.status === 'verified' && intact(root, manifest, lastWrite.manifest_sha256)) {
      db.exec('COMMIT');
      return { status: 'unchanged', revision, digest: projection.digest, manifest: manifestPath };
    }
    // The same revision failed a moment ago: a safe point every scheduler round would only fail again.
    if (fixed === latest && lastWrite?.status === 'failed' && !hooks.force && Date.now() - Date.parse(lastWrite.recorded_at) < RETRY_AFTER_MS) {
      db.exec('COMMIT');
      return { status: 'deferred', reason: '上次写入失败，稍后重试', revision, digest: projection.digest, manifest: manifestPath };
    }
    let problems: string[];
    try {
      for (const file of projection.files) {
        const path = join(root, ...file.path.split('/'));
        let onDisk: string | undefined;
        try { onDisk = readFileSync(path, 'utf8'); } catch { onDisk = undefined; }
        if (onDisk !== file.content) writeAtomic(path, file.content);
      }
      // The manifest last: a reader trusts files only through it.
      writeAtomic(manifestPath, manifestText);
      hooks.beforeVerify?.(root);
      const back = readManifest(root);
      problems = back.manifest ? verifyOnDisk(root, back.manifest, projection.roots) : [back.problem ?? '档案清单无法读回'];
      if (back.text !== undefined && back.text !== manifestText) problems.unshift('读回的档案清单与写入的不同');
    } catch (error) { problems = [`写入失败：${(error as Error).message}`]; }
    const error = problems.length ? problems.slice(0, 5).join('；') : null;
    db.prepare('INSERT INTO project_archive_write (project_id, revision, status, manifest_sha256, error) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, revision, error ? 'failed' : 'verified', error ? null : sha256(manifestText), error);
    if (error) recordFailure(db, projectId, error, revision);
    db.exec('COMMIT');
    return error ? { status: 'failed', revision, digest: projection.digest, error, manifest: manifestPath }
      : { status: 'verified', revision, digest: projection.digest, manifest: manifestPath };
  } catch (error) {
    // The projection could not be built or its revision not fixed: nothing of this attempt stays but the reason.
    if (db.isTransaction) db.exec('ROLLBACK');
    const message = (error as Error).message;
    try { recordFailure(db, projectId, message); } catch { /* the database itself refused; the caller sees the error */ }
    return { status: 'failed', ...(digest ? { digest } : {}), error: message, manifest: manifestPath };
  }
}
/** The verified archive on disk is still exactly what the database projects, so there is nothing to write. */
function unchangedArchive(db: DatabaseSync, projectId: string, root: string, manifestPath: string): ArchiveWriteResult | undefined {
  if (safePointProblem(db, projectId)) return undefined;
  const identity = db.prepare('SELECT archive_id FROM project_archive_identity WHERE project_id = ?').get(projectId) as { archive_id: string } | undefined;
  const latest = db.prepare('SELECT number, digest, created_at FROM project_revision WHERE project_id = ? ORDER BY number DESC LIMIT 1')
    .get(projectId) as { number: number; digest: string; created_at: string } | undefined;
  if (!identity || !latest) return undefined;
  const lastWrite = db.prepare(`SELECT status, manifest_sha256 FROM project_archive_write WHERE project_id = ? AND revision = ? ORDER BY seq DESC LIMIT 1`)
    .get(projectId, latest.number) as { status: string; manifest_sha256: string | null } | undefined;
  if (lastWrite?.status !== 'verified') return undefined;
  const projection = buildProjection(db, projectId, identity.archive_id);
  if (projection.digest !== latest.digest) return undefined;
  const manifest: ArchiveManifest = { schema: ARCHIVE_SCHEMA, archiveId: identity.archive_id, revision: latest.number, digest: latest.digest,
    createdAt: latest.created_at, producer: { name: 'harness', version: producerVersion(), stateSchema: SCHEMA_VERSION },
    files: projection.files.map(({ content: _content, ...file }) => file) };
  return intact(root, manifest, lastWrite.manifest_sha256)
    ? { status: 'unchanged', revision: latest.number, digest: latest.digest, manifest: manifestPath } : undefined;
}
let version: string | undefined;
const producerVersion = (): string => version ??= packageVersion();
/** The files of a verified write are still on disk unchanged in size, under the same manifest. */
function intact(root: string, manifest: ArchiveManifest, manifestSha: string | null): boolean {
  const back = readManifest(root);
  if (!back.text || !manifestSha || sha256(back.text) !== manifestSha || back.text !== json(manifest)) return false;
  return manifest.files.every(file => { try { return statSync(join(root, ...file.path.split('/'))).size === file.bytes; } catch { return false; } });
}

export interface ArchiveCheck {
  state: 'consistent' | 'outdated' | 'diverged' | 'missing';
  revision: number | null;
  problems: string[];
  /** Files whose projection from the current database differs from the one on disk. */
  changed: string[];
}
/**
 * Compare the archive on disk with the state database: the files must match their manifest, the manifest must be a
 * revision the database fixed, and the database now must still project to it (else the archive is outdated until the
 * next safe point).
 */
export function checkProjectArchive(db: DatabaseSync, projectId: string): ArchiveCheck {
  const root = projectRoot(db, projectId);
  const back = readManifest(root);
  if (back.problem === 'missing') return { state: 'missing', revision: null, problems: ['工程内还没有档案'], changed: [] };
  if (!back.manifest) return { state: 'diverged', revision: null, problems: [back.problem!], changed: [] };
  const manifest = back.manifest;
  const problems: string[] = [];
  const identity = db.prepare('SELECT archive_id FROM project_archive_identity WHERE project_id = ?').get(projectId) as { archive_id: string } | undefined;
  if (identity && identity.archive_id !== manifest.archiveId) problems.push('档案属于另一个项目身份');
  const fixed = db.prepare('SELECT digest FROM project_revision WHERE project_id = ? AND number = ?').get(projectId, manifest.revision) as { digest: string } | undefined;
  if (!fixed) problems.push(`状态库没有修订 ${manifest.revision}`);
  else if (fixed.digest !== manifest.digest) problems.push(`修订 ${manifest.revision} 的摘要与状态库记录不同`);
  const roots = rootsOf(db, projectId, root);
  problems.push(...verifyOnDisk(root, manifest, roots));
  const projection = buildProjection(db, projectId, identity?.archive_id ?? manifest.archiveId);
  const listed = new Map(manifest.files.map(file => [file.path, file.sha256]));
  const changed = projection.files.filter(file => listed.get(file.path) !== file.sha256).map(file => file.path);
  if (problems.length) return { state: 'diverged', revision: manifest.revision, problems, changed };
  if (projection.digest !== manifest.digest) return { state: 'outdated', revision: manifest.revision,
    problems: [`状态库已有 ${changed.length} 个档案文件的新内容，等下一个安全点写入`], changed };
  return { state: 'consistent', revision: manifest.revision, problems: [], changed: [] };
}

/** Prove later Runtime projection writes without accepting arbitrary changes under _harness/. Starts and writes nothing. */
export function verifiedProjectionChanges(db:DatabaseSync,projectId:string,after:string,paths:string[],reviewOwner?:SetupReviewOwner):
  {revision:number;manifestSha256:string;after:string;writtenAt:string;paths:string[]}|undefined {
  if (!paths.length || !Number.isFinite(Date.parse(after)) || executionSafePointProblem(db,projectId) ||
      isSetupReviewRunning(db,projectId,reviewOwner)) return undefined;
  try {
    const root=projectRoot(db,projectId);
    if(lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())return undefined;
    const ordinary=(path:string)=>{
      const parts=path.split('/');let cursor=root;
      for(const [index,part] of parts.entries()) {
        if (!part || part==='.' || part==='..') return false;
        cursor=join(cursor,part);const stat=lstatSync(cursor);
        if(stat.isSymbolicLink() || (index===parts.length-1?!stat.isFile():!stat.isDirectory()))return false;
      }
      return true;
    };
    if (!ordinary(ARCHIVE_MANIFEST)) return undefined;
    const back=readManifest(root);if(!back.manifest || !back.text)return undefined;
    const manifest=back.manifest;
    const write=db.prepare(`SELECT revision,status,manifest_sha256,recorded_at FROM project_archive_write
      WHERE project_id=? ORDER BY seq DESC LIMIT 1`).get(projectId);
    const identity=db.prepare('SELECT archive_id FROM project_archive_identity WHERE project_id=?').get(projectId);
    const fixed=db.prepare('SELECT digest FROM project_revision WHERE project_id=? AND number=?').get(projectId,manifest.revision);
    if(write?.status!=='verified' || write.revision!==manifest.revision ||
      !Number.isFinite(Date.parse(String(write.recorded_at))) || Date.parse(String(write.recorded_at))<Date.parse(after) ||
      sha256(back.text)!==write.manifest_sha256 || identity?.archive_id!==manifest.archiveId || fixed?.digest!==manifest.digest) return undefined;
    const known=new Set(buildProjection(db,projectId,manifest.archiveId).files.map(file=>file.path));
    const listed=new Set(manifest.files.map(file=>file.path));
    if(manifest.files.length!==listed.size || manifest.files.some(file=>!known.has(file.path) || !ordinary(file.path)) ||
      verifyOnDisk(root,manifest,rootsOf(db,projectId,root)).length) return undefined;
    if(paths.some(path=>path!==ARCHIVE_MANIFEST && !listed.has(path))) return undefined;
    return {revision:manifest.revision,manifestSha256:String(write.manifest_sha256),after,writtenAt:String(write.recorded_at),paths:[...new Set(paths)].sort()};
  } catch { return undefined; }
}

export interface ArchiveStatus {
  archiveId: string | null;
  revision: number | null;
  write: { revision: number; status: 'verified' | 'failed'; at: string; error: string | null } | null;
  /** The latest revision whose write read back and verified. */
  verifiedRevision: number | null;
  /** The database has changed since the verified revision: the next safe point writes a new one. */
  pending: boolean;
  safePoint: string | null;
  scan: { at: string; files: number; unclassified: number; symlinks: number; rightsUnresolvedA: number } | null;
  shareable: { ok: boolean; blockers: Array<{ code: string; text: string }> };
}
/** Where the archive stands, and what blocks a shareable export of the project (the export itself is not built yet). */
export function archiveStatus(db: DatabaseSync, projectId: string): ArchiveStatus {
  const identity = db.prepare('SELECT archive_id FROM project_archive_identity WHERE project_id = ?').get(projectId) as { archive_id: string } | undefined;
  const latest = db.prepare('SELECT number, digest FROM project_revision WHERE project_id = ? ORDER BY number DESC LIMIT 1').get(projectId) as
    { number: number; digest: string } | undefined;
  const write = db.prepare('SELECT revision, status, recorded_at, error FROM project_archive_write WHERE project_id = ? ORDER BY seq DESC LIMIT 1')
    .get(projectId) as { revision: number; status: 'verified' | 'failed'; recorded_at: string; error: string | null } | undefined;
  const verified = db.prepare(`SELECT w.revision, r.digest FROM project_archive_write w JOIN project_revision r ON r.project_id = w.project_id
    AND r.number = w.revision WHERE w.project_id = ? AND w.status = 'verified' ORDER BY w.seq DESC LIMIT 1`).get(projectId) as
    { revision: number; digest: string } | undefined;
  let pending = true;
  try { pending = !verified || buildProjection(db, projectId, identity?.archive_id ?? '').digest !== verified.digest; } catch { pending = true; }
  const scanRow = db.prepare('SELECT scanned_at, files, unclassified, summary_json FROM project_scan WHERE project_id = ? ORDER BY seq DESC LIMIT 1')
    .get(projectId) as { scanned_at: string; files: number; unclassified: number; summary_json: string } | undefined;
  const summary = parse<{ symlinks?: number; rightsUnresolvedA?: number }>(scanRow?.summary_json, {});
  const scan = scanRow ? { at: scanRow.scanned_at, files: scanRow.files, unclassified: scanRow.unclassified, symlinks: summary.symlinks ?? 0,
    rightsUnresolvedA: summary.rightsUnresolvedA ?? 0 } : null;
  const safePoint = safePointProblem(db, projectId) ?? null;
  const blockers: Array<{ code: string; text: string }> = [];
  if (write?.status === 'failed') blockers.push({ code: 'projection_failed', text: `工程档案最近一次写入失败：${write.error ?? '原因未知'}` });
  if (!verified) blockers.push({ code: 'projection_missing', text: '工程档案还没有经过读回校验的版本' });
  else if (pending && write?.status !== 'failed') blockers.push({ code: 'projection_outdated', text: '状态库有尚未写入工程档案的变化' });
  if (safePoint) blockers.push({ code: 'active_run', text: `${safePoint}，运行中的工程不能分享` });
  if (!scan) blockers.push({ code: 'scan_missing', text: '还没有对工程文件做过归类扫描' });
  else {
    if (scan.unclassified) blockers.push({ code: 'unclassified', text: `${scan.unclassified} 个文件未登记（待分类）` });
    if (scan.symlinks) blockers.push({ code: 'symlinks', text: `${scan.symlinks} 个符号链接需要人工处理` });
    if (scan.rightsUnresolvedA) blockers.push({ code: 'rights_unresolved', text: `${scan.rightsUnresolvedA} 个接续必需文件的转交权未确认` });
  }
  return { archiveId: identity?.archive_id ?? null, revision: latest?.number ?? null,
    write: write ? { revision: write.revision, status: write.status, at: write.recorded_at, error: write.error } : null,
    verifiedRevision: verified?.revision ?? null, pending, safePoint, scan, shareable: { ok: blockers.length === 0, blockers } };
}

export interface SafePointOptions extends WriteHooks {
  /** Walk the project tree too: true, false, or 'auto' (after Tasks changed the project since the last walk). */
  tree?: boolean | 'auto';
}
/**
 * A safe point of one project: settle ended takeover analyses, observe the project's inputs, then write and verify
 * the archive. Nothing happens while a Run works in the project.
 */
export function projectSafePoint(db: DatabaseSync, projectId: string, options: SafePointOptions = {}): ArchiveWriteResult {
  const root = projectRoot(db, projectId);
  const manifest = join(root, ...ARCHIVE_MANIFEST.split('/'));
  const problem = safePointProblem(db, projectId);
  if (problem) return { status: 'deferred', reason: problem, manifest };
  if (!existsSync(root)) return { status: 'deferred', reason: '工程目录不存在', manifest };
  reconcileRecoveries(db, projectId);
  scanProject(db, projectId, { tree: options.tree === 'auto' ? treeScanDue(db, projectId) : Boolean(options.tree) });
  return writeProjectArchive(db, projectId, options);
}
