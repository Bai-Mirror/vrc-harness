import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../pack-hash.ts';
import type { ProcessDefinition } from '../process/types.ts';
import {
  EVIDENCE_LEVELS, FACT_STATUSES, SHARE_LAYERS, isPortablePath, validAttribute, validObjectId,
  type EvidenceLevel, type FactRecord, type FactStatus, type FactView, type Invalidation, type Locator, type ShareLayer,
  type StoredFactSource,
} from './contract.ts';

/**
 * The fact store. Stored records (import findings, takeover candidates, scans, user confirmations) live in
 * project_fact; Workflow results and the project's own tables (brief, roots, variants, assets) are derived in the same
 * record shape from their append-only or current rows. The status a fact has now is derived too: a record is never
 * rewritten, a newer one replaces it, and a condition that holds makes it stale.
 */

export interface NewFact {
  objectId: string;
  attribute: string;
  value: unknown;
  source: { type: StoredFactSource; ref: string };
  locator?: Locator;
  inputFingerprint?: string | null;
  observer: string;
  observedAt?: string;
  status: FactStatus;
  evidenceLevel: EvidenceLevel;
  confidence?: number | null;
  scope: string;
  invalidation?: Invalidation[];
  shareLayer: ShareLayer;
  /** Defaults to the current record of the same object and attribute, if any. */
  supersedes?: string | null;
  /** Preassigned id, so facts of one batch can depend on each other. */
  id?: string;
}

const STORED_SOURCES: readonly StoredFactSource[] = ['import_scan', 'harness_scan', 'takeover_analysis', 'user'];
/** What each status requires of the evidence behind it; the contract's consistency rules. */
const STATUS_EVIDENCE: Record<FactStatus, readonly EvidenceLevel[]> = {
  observed: ['observation', 'document'], inferred: ['inference'], user_confirmed: ['attestation'], verified: ['verification'],
  unknown: ['none'], stale: EVIDENCE_LEVELS,
};

function fail(message: string): never { throw Object.assign(new Error(message), { code: 'BAD_REQUEST' }); }
/** Contract checks every stored record passes before it is written. */
export function validateFact(fact: NewFact): void {
  if (!validObjectId(fact.objectId)) fail(`事实对象 ID 无效：${fact.objectId}`);
  if (!validAttribute(fact.attribute)) fail(`事实属性名无效：${fact.attribute}`);
  if (!STORED_SOURCES.includes(fact.source.type)) fail(`事实来源类型无效：${fact.source.type}`);
  if (!fact.source.ref?.trim()) fail('事实缺少来源引用');
  if (!FACT_STATUSES.includes(fact.status)) fail(`事实状态无效：${fact.status}`);
  if (!EVIDENCE_LEVELS.includes(fact.evidenceLevel)) fail(`证据等级无效：${fact.evidenceLevel}`);
  if (!STATUS_EVIDENCE[fact.status].includes(fact.evidenceLevel))
    fail(`状态 ${fact.status} 不能配证据等级 ${fact.evidenceLevel}`);
  if (fact.status === 'unknown' && fact.value !== null) fail('未知的事实不能带值');
  if (fact.status === 'user_confirmed' && fact.source.type !== 'user') fail('只有用户确认才能是 user_confirmed');
  if (fact.source.type === 'takeover_analysis' && fact.status !== 'inferred') fail('AI 接手分析只能产生待确认的推断');
  if (fact.value === undefined) fail('事实的值不能缺省（未知用 null）');
  if (canonicalJson(fact.value).length > 16_384) fail('事实的值过大');
  if (fact.confidence !== undefined && fact.confidence !== null && (!(fact.confidence >= 0) || !(fact.confidence <= 1)))
    fail('置信度应在 0 与 1 之间');
  if (!fact.scope?.trim()) fail('事实缺少适用范围');
  if (!SHARE_LAYERS.includes(fact.shareLayer)) fail(`分享层级无效：${fact.shareLayer}`);
  if (!fact.observer?.trim()) fail('事实缺少观察工具或确认人');
  if (fact.locator?.path !== undefined && !isPortablePath(fact.locator.path)) fail(`定位路径不是工程内相对路径：${fact.locator.path}`);
  if (fact.locator?.line !== undefined && (!Number.isSafeInteger(fact.locator.line) || fact.locator.line < 1)) fail('定位行号无效');
  for (const condition of fact.invalidation ?? []) {
    if (condition.kind === 'file') {
      if (!isPortablePath(condition.path)) fail(`失效条件的文件路径不是工程内相对路径：${condition.path}`);
      if (condition.sha256 !== null && !/^[0-9a-f]{64}$/.test(condition.sha256)) fail('失效条件的 sha256 无效');
    } else if (condition.kind === 'artifact') {
      if (!condition.workflowId || !condition.artifact || typeof condition.hash !== 'string') fail('失效条件的产物绑定不完整');
    } else if (condition.kind === 'fact') {
      if (!condition.factId) fail('失效条件缺少所依据的事实');
    } else fail(`未知的失效条件：${(condition as { kind: string }).kind}`);
  }
}

/** Run `change` in a transaction unless the caller already opened one. */
export function inTransaction<T>(db: DatabaseSync, change: () => T): T {
  if (db.isTransaction) return change();
  db.exec('BEGIN IMMEDIATE');
  try { const result = change(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** The latest fingerprint recorded for an input; undefined when it was never observed. */
export function latestInput(db: DatabaseSync, projectId: string, input: string): { fingerprint: string | null } | undefined {
  return db.prepare(`SELECT fingerprint FROM project_input_observation WHERE project_id = ? AND input = ? ORDER BY seq DESC LIMIT 1`)
    .get(projectId, input) as { fingerprint: string | null } | undefined;
}
/** Record what an input is now; nothing is written when it is unchanged. Returns whether a row was appended. */
export function observeInput(db: DatabaseSync, projectId: string, input: string, fingerprint: string | null): boolean {
  const last = latestInput(db, projectId, input);
  if (last && last.fingerprint === fingerprint) return false;
  db.prepare('INSERT INTO project_input_observation (project_id, input, fingerprint) VALUES (?, ?, ?)').run(projectId, input, fingerprint);
  return true;
}

type Row = { seq: number; id: string; object_id: string; attribute: string; value_json: string; source_type: string; source_ref: string;
  locator_json: string; input_fingerprint: string | null; observer: string; observed_at: string; status: FactStatus;
  evidence_level: EvidenceLevel; confidence: number | null; scope: string; invalidation_json: string; share_layer: ShareLayer;
  supersedes: string | null; recorded_at: string };
function fromRow(row: Row): FactRecord {
  return { id: row.id, objectId: row.object_id, attribute: row.attribute, value: JSON.parse(row.value_json) as unknown,
    source: { type: row.source_type as StoredFactSource, ref: row.source_ref }, locator: JSON.parse(row.locator_json) as Locator,
    inputFingerprint: row.input_fingerprint, observer: row.observer, observedAt: row.observed_at, status: row.status,
    evidenceLevel: row.evidence_level, confidence: row.confidence, scope: row.scope,
    invalidation: JSON.parse(row.invalidation_json) as Invalidation[], shareLayer: row.share_layer, supersedes: row.supersedes,
    recordedAt: row.recorded_at };
}
export function storedFacts(db: DatabaseSync, projectId: string): FactRecord[] {
  return (db.prepare('SELECT * FROM project_fact WHERE project_id = ? ORDER BY seq').all(projectId) as Row[]).map(fromRow);
}
export function storedFact(db: DatabaseSync, id: string): (FactRecord & { projectId: string }) | undefined {
  const row = db.prepare('SELECT * FROM project_fact WHERE id = ?').get(id) as (Row & { project_id: string }) | undefined;
  return row ? { ...fromRow(row), projectId: row.project_id } : undefined;
}
function currentStored(db: DatabaseSync, projectId: string, objectId: string, attribute: string): FactRecord | undefined {
  const row = db.prepare(`SELECT * FROM project_fact WHERE project_id = ? AND object_id = ? AND attribute = ? ORDER BY seq DESC LIMIT 1`)
    .get(projectId, objectId, attribute) as Row | undefined;
  return row ? fromRow(row) : undefined;
}
/** The part of a record that makes it the same conclusion as another: equal ones are not written twice. */
function conclusion(fact: Pick<FactRecord, 'value' | 'status' | 'evidenceLevel' | 'shareLayer' | 'scope' | 'inputFingerprint' | 'invalidation' | 'confidence'>): string {
  return canonicalJson({ value: fact.value, status: fact.status, evidence: fact.evidenceLevel, layer: fact.shareLayer, scope: fact.scope,
    input: fact.inputFingerprint ?? null, invalidation: fact.invalidation, confidence: fact.confidence ?? null });
}

/**
 * Append fact records. Each is validated against the contract; one equal to the current record of its object and
 * attribute is skipped (a repeated scan adds nothing). The files its conditions bind were just read by the recorder, so
 * they are recorded as observed now (unless `observeBindings` is false: a person's confirmation reuses the latest
 * observation). Returns the id of each fact (the existing id for a skipped one).
 */
export function recordFacts(db: DatabaseSync, projectId: string, facts: NewFact[], options: { observeBindings?: boolean } = {}): string[] {
  const withIds = facts.map(fact => ({ ...fact, id: fact.id ?? randomUUID() }));
  for (const fact of withIds) validateFact(fact);
  const batch = new Set(withIds.map(fact => fact.id));
  // A fact of this batch that is not written (it repeats, or a person's statement stands) is stood in for by the record
  // that is current: a later fact of the batch that depends on it depends on that record.
  const standIn = new Map<string, string>();
  return inTransaction(db, () => withIds.map(original => {
    const fact = { ...original, invalidation: (original.invalidation ?? []).map(condition =>
      condition.kind === 'fact' && standIn.has(condition.factId) ? { ...condition, factId: standIn.get(condition.factId)! } : condition) };
    for (const condition of fact.invalidation) if (condition.kind === 'fact' && !batch.has(condition.factId) &&
      !db.prepare('SELECT 1 FROM project_fact WHERE id = ? AND project_id = ?').get(condition.factId, projectId))
      fail(`失效条件引用的事实不存在：${condition.factId}`);
    const skip = (id: string): string => { standIn.set(fact.id, id); return id; };
    const current = currentStored(db, projectId, fact.objectId, fact.attribute);
    const files = (fact.invalidation ?? []).filter((condition): condition is Extract<Invalidation, { kind: 'file' }> => condition.kind === 'file');
    // Seeing the same files again is no new evidence: did any input this recorder read change since last observed?
    const inputsChanged = files.some(condition => {
      const last = latestInput(db, projectId, `file:${condition.path}`);
      return last !== undefined && last.fingerprint !== condition.sha256;
    });
    // What the recorder just read is the input as it is now, whether or not the conclusion is new.
    if (options.observeBindings !== false) for (const condition of files) observeInput(db, projectId, `file:${condition.path}`, condition.sha256);
    // A person's statement stands against an observer while it holds. An import or a scan replaces it once an input
    // they read changed; an analysis's inference never replaces a statement that still holds.
    if (current?.source.type === 'user' && fact.source.type !== 'user' && fact.supersedes === undefined &&
      !recordIsStale(db, projectId, current) && (fact.source.type === 'takeover_analysis' || !inputsChanged)) return skip(current.id);
    const next = { value: fact.value, status: fact.status, evidenceLevel: fact.evidenceLevel, shareLayer: fact.shareLayer, scope: fact.scope,
      inputFingerprint: fact.inputFingerprint ?? null, invalidation: fact.invalidation, confidence: fact.confidence ?? null };
    if (current && fact.supersedes === undefined && conclusion(current) === conclusion(next)) return skip(current.id);
    db.prepare(`INSERT INTO project_fact (id, project_id, object_id, attribute, value_json, source_type, source_ref, locator_json,
      input_fingerprint, observer, observed_at, status, evidence_level, confidence, scope, invalidation_json, share_layer, supersedes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(fact.id, projectId, fact.objectId, fact.attribute,
      JSON.stringify(fact.value), fact.source.type, fact.source.ref, JSON.stringify(fact.locator ?? {}), fact.inputFingerprint ?? null,
      fact.observer, fact.observedAt ?? new Date().toISOString(), fact.status, fact.evidenceLevel, fact.confidence ?? null, fact.scope,
      JSON.stringify(fact.invalidation ?? []), fact.shareLayer, fact.supersedes === undefined ? current?.id ?? null : fact.supersedes);
    return fact.id;
  }));
}

/** Whether one stored record's own conditions hold now (a dependency counts as broken when its value changed). */
function recordIsStale(db: DatabaseSync, projectId: string, record: FactRecord): boolean {
  if (record.status === 'unknown') return false;
  return record.invalidation.some(condition => {
    if (condition.kind === 'file') {
      const last = latestInput(db, projectId, `file:${condition.path}`);
      return last !== undefined && last.fingerprint !== condition.sha256;
    }
    if (condition.kind === 'artifact') return (currentArtifactHash(db, projectId, condition.workflowId, condition.artifact) ?? '') !== condition.hash;
    const basis = storedFact(db, condition.factId);
    const now = basis ? currentStored(db, projectId, basis.objectId, basis.attribute) : undefined;
    return !basis || !now || canonicalJson(now.value) !== canonicalJson(basis.value) || now.status === 'unknown';
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Derived facts: Workflow results and the project's own tables, in the fact record shape.

type LatestWorkflow = { id: string; status: string; definition: ProcessDefinition };
export function latestFormalWorkflow(db: DatabaseSync, projectId: string): LatestWorkflow | undefined {
  const row = db.prepare(`SELECT w.id, w.status, d.definition_json FROM workflow w JOIN workflow_definition d ON d.workflow_id = w.id
    WHERE w.project_id = ? ORDER BY w.rowid DESC LIMIT 1`).get(projectId) as { id: string; status: string; definition_json: string } | undefined;
  return row ? { id: row.id, status: row.status, definition: JSON.parse(row.definition_json) as ProcessDefinition } : undefined;
}
/** A Workflow the scheduler still advances: its fingerprints are refreshed every round. */
export function workflowIsLive(status: string): boolean { return status === 'active' || status === 'upload_ready'; }

/**
 * Results of the project's latest formal Workflow: the current fingerprint of each artifact, the latest verdict of each
 * check, decision of each Gate and completion of each stage, each bound to the artifact hash it was about. Older
 * Workflows are history (records/decisions.json), never current facts.
 */
export function workflowFacts(db: DatabaseSync, projectId: string): FactRecord[] {
  const workflow = latestFormalWorkflow(db, projectId);
  if (!workflow) return [];
  const scope = `workflow:${workflow.id}`, facts: FactRecord[] = [];
  const base = (id: string, objectId: string, attribute: string, at: string): Pick<FactRecord, 'id' | 'objectId' | 'attribute' |
    'locator' | 'confidence' | 'scope' | 'shareLayer' | 'supersedes' | 'recordedAt' | 'observedAt'> =>
    ({ id: `${scope}:${id}`, objectId, attribute, locator: {}, confidence: null, scope, shareLayer: 'A', supersedes: null, recordedAt: at, observedAt: at });
  const artifacts = db.prepare(`SELECT seq, kind, hash, observed_at FROM artifact_version WHERE workflow_id = ? AND seq IN
    (SELECT MAX(seq) FROM artifact_version WHERE workflow_id = ? GROUP BY kind) ORDER BY kind`).all(workflow.id, workflow.id) as
    Array<{ seq: number; kind: string; hash: string; observed_at: string }>;
  for (const row of artifacts) facts.push({ ...base(`artifact_version:${row.seq}`, `artifact:${row.kind}`, 'fingerprint', row.observed_at),
    value: row.hash || null, source: { type: 'workflow', ref: `artifact_version:${row.seq}` }, inputFingerprint: row.hash || null,
    observer: 'harness-artifact-fingerprint', status: 'observed', evidenceLevel: 'observation',
    invalidation: [{ kind: 'artifact', workflowId: workflow.id, artifact: row.kind, hash: row.hash }] });
  const latestVerdict = db.prepare(`SELECT id, scope, artifact_hash, result, recorded_at FROM verdict WHERE workflow_id = ? AND check_id = ?
    ORDER BY seq DESC LIMIT 1`);
  for (const check of workflow.definition.checks) {
    const row = latestVerdict.get(workflow.id, check.id) as { id: string; scope: string; artifact_hash: string; result: string; recorded_at: string } | undefined;
    if (!row) continue;
    const artifact = row.result === 'not_applicable' ? 'plan' : check.on;
    facts.push({ ...base(`verdict:${row.id}`, `check:${check.id}`, 'verdict', row.recorded_at), value: { result: row.result, scope: row.scope },
      source: { type: 'workflow', ref: `verdict:${row.id}` }, inputFingerprint: row.artifact_hash || null, observer: `harness-verifier:${check.observe}`,
      status: 'verified', evidenceLevel: 'verification', invalidation: [{ kind: 'artifact', workflowId: workflow.id, artifact, hash: row.artifact_hash }] });
  }
  const latestDecision = db.prepare(`SELECT seq, artifact_hash, result, recorded_at FROM gate_decision WHERE workflow_id = ? AND gate_id = ?
    ORDER BY seq DESC LIMIT 1`);
  for (const gate of workflow.definition.gates) {
    const row = latestDecision.get(workflow.id, gate.id) as { seq: number; artifact_hash: string; result: string; recorded_at: string } | undefined;
    if (!row) continue;
    facts.push({ ...base(`gate_decision:${row.seq}`, `gate:${gate.id}`, 'decision', row.recorded_at), value: row.result,
      source: { type: 'workflow', ref: `gate_decision:${row.seq}` }, inputFingerprint: row.artifact_hash, observer: 'human',
      status: 'user_confirmed', evidenceLevel: 'attestation',
      invalidation: [{ kind: 'artifact', workflowId: workflow.id, artifact: gate.binds, hash: row.artifact_hash }] });
  }
  const latestCompletion = db.prepare(`SELECT seq, artifact_hashes_json, recorded_at FROM stage_completion WHERE workflow_id = ? AND stage_id = ?
    ORDER BY seq DESC LIMIT 1`);
  for (const stage of workflow.definition.stages) {
    const row = latestCompletion.get(workflow.id, stage.id) as { seq: number; artifact_hashes_json: string; recorded_at: string } | undefined;
    if (!row) continue;
    const hashes = JSON.parse(row.artifact_hashes_json) as Record<string, string | null>;
    facts.push({ ...base(`stage_completion:${row.seq}`, `stage:${stage.id}`, 'completion', row.recorded_at), value: { artifactHashes: hashes },
      source: { type: 'workflow', ref: `stage_completion:${row.seq}` }, inputFingerprint: null, observer: 'harness-runtime',
      status: 'verified', evidenceLevel: 'verification',
      invalidation: Object.entries(hashes).map(([artifact, hash]) => ({ kind: 'artifact' as const, workflowId: workflow.id, artifact, hash: hash ?? '' })) });
  }
  const acceptances = db.prepare(`SELECT a.seq, a.recorded_at, v.check_id, v.artifact_hash FROM warning_acceptance a
    JOIN verdict v ON v.workflow_id = a.workflow_id AND v.id = a.verdict_id WHERE a.workflow_id = ? ORDER BY a.seq`).all(workflow.id) as
    Array<{ seq: number; recorded_at: string; check_id: string; artifact_hash: string }>;
  for (const row of acceptances) {
    const check = workflow.definition.checks.find(item => item.id === row.check_id);
    if (!check) continue;
    facts.push({ ...base(`warning_acceptance:${row.seq}`, `check:${row.check_id}`, 'warningAccepted', row.recorded_at), value: true,
      source: { type: 'workflow', ref: `warning_acceptance:${row.seq}` }, inputFingerprint: row.artifact_hash, observer: 'human',
      status: 'user_confirmed', evidenceLevel: 'attestation',
      invalidation: [{ kind: 'artifact', workflowId: workflow.id, artifact: check.on, hash: row.artifact_hash }] });
  }
  return facts;
}

/** What the person entered about the project: the brief, accepted decisions, Avatar roots, variants and chosen assets. */
export function projectTableFacts(db: DatabaseSync, projectId: string): FactRecord[] {
  const facts: FactRecord[] = [];
  const person = (id: string, objectId: string, attribute: string, value: unknown, ref: string, at: string, layer: ShareLayer = 'A'): FactRecord =>
    ({ id: `project:${projectId}:${id}`, objectId, attribute, value, source: { type: 'project', ref }, locator: {}, inputFingerprint: null,
      observer: 'user', observedAt: at, status: 'user_confirmed', evidenceLevel: 'attestation', confidence: null, scope: 'project',
      invalidation: [], shareLayer: layer, supersedes: null, recordedAt: at });
  const brief = db.prepare(`SELECT intake_mode, customer_request, face_concept, status, updated_at FROM project_brief WHERE project_id = ?`)
    .get(projectId) as { intake_mode: string; customer_request: string; face_concept: string; status: string; updated_at: string } | undefined;
  if (brief) {
    facts.push(person('brief:intakeMode', 'brief', 'intakeMode', brief.intake_mode, 'project_brief', brief.updated_at));
    facts.push(person('brief:status', 'brief', 'status', brief.status, 'project_brief', brief.updated_at));
    if (brief.face_concept.trim()) facts.push(person('brief:faceConcept', 'brief', 'faceConcept', brief.face_concept, 'project_brief', brief.updated_at));
    // The customer's own words are raw customer material: layer C.
    if (brief.customer_request.trim()) facts.push(person('brief:goal', 'brief', 'goal', brief.customer_request, 'project_brief', brief.updated_at, 'C'));
  }
  for (const row of db.prepare(`SELECT id, content, created_at FROM project_message WHERE project_id = ? AND status = 'accepted'
    ORDER BY created_at, rowid`).all(projectId) as Array<{ id: string; content: string; created_at: string }>)
    facts.push(person(`message:${row.id}`, `decision:${row.id}`, 'accepted', row.content, `project_message:${row.id}`, row.created_at));
  for (const row of db.prepare(`SELECT id, variant_id, derived_from, scene_path, object_path, role, plugin_profile, active_state, blueprint_id,
    COALESCE(observed_at, '') AS observed_at FROM avatar_root WHERE project_id = ? ORDER BY rowid`).all(projectId) as Array<{ id: string;
      variant_id: string | null; derived_from: string | null; scene_path: string; object_path: string; role: string; plugin_profile: string;
      active_state: string; blueprint_id: string; observed_at: string }>) {
    const objectId = `avatar_root:${row.scene_path}#${row.object_path}`;
    facts.push(person(`root:${row.id}`, objectId, 'lineage', { rootId: row.id, role: row.role, activeState: row.active_state,
      variantId: row.variant_id, derivedFrom: row.derived_from, pluginProfile: row.plugin_profile }, `avatar_root:${row.id}`, row.observed_at));
    // A Blueprint ID ties the avatar to a VRChat account: layer C.
    if (row.blueprint_id.trim()) facts.push(person(`root:${row.id}:blueprint`, objectId, 'blueprintId', row.blueprint_id, `avatar_root:${row.id}`, row.observed_at, 'C'));
  }
  for (const row of db.prepare(`SELECT id, name, description, status, updated_at FROM project_variant WHERE project_id = ? ORDER BY created_at, id`)
    .all(projectId) as Array<{ id: string; name: string; description: string; status: string; updated_at: string }>)
    facts.push(person(`variant:${row.id}`, `variant:${row.id}`, 'plan', { name: row.name, description: row.description, status: row.status },
      `project_variant:${row.id}`, row.updated_at));
  for (const row of db.prepare(`SELECT a.id, a.name, a.kind, a.status, a.license, pa.role, pa.attached_at FROM project_asset pa
    JOIN asset a ON a.id = pa.asset_id WHERE pa.project_id = ? ORDER BY pa.attached_at, a.id`).all(projectId) as Array<{ id: string; name: string;
      kind: string; status: string; license: string; role: string; attached_at: string }>)
    facts.push(person(`asset:${row.id}`, `asset:${row.id}`, 'use', { role: row.role, kind: row.kind, name: row.name, status: row.status,
      license: row.license }, `project_asset:${row.id}`, row.attached_at));
  return facts;
}

// ---------------------------------------------------------------------------------------------------------------------
// Effective status.

/** What an artifact is now: the scheduler's latest fingerprint for a live Workflow, else what a scan last observed. */
export function currentArtifactHash(db: DatabaseSync, projectId: string, workflowId: string, artifact: string): string | null {
  const status = (db.prepare('SELECT status FROM workflow WHERE id = ?').get(workflowId) as { status: string } | undefined)?.status;
  const recorded = (db.prepare(`SELECT hash FROM artifact_version WHERE workflow_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1`)
    .get(workflowId, artifact) as { hash: string } | undefined)?.hash;
  if (status && !workflowIsLive(status)) {
    const observed = latestInput(db, projectId, `artifact:${workflowId}:${artifact}`);
    if (observed) return observed.fingerprint;
  }
  return recorded ? recorded : null;
}

/** Every fact of the project, stored and derived, with the status it has now. `history` includes replaced records. */
export function factViews(db: DatabaseSync, projectId: string, options: { history?: boolean } = {}): FactView[] {
  const stored = storedFacts(db, projectId);
  const derived = [...workflowFacts(db, projectId), ...projectTableFacts(db, projectId)];
  const all = [...stored, ...derived];
  const byId = new Map(all.map(fact => [fact.id, fact]));
  const current = new Map<string, FactRecord>();
  for (const fact of all) current.set(`${fact.objectId}\0${fact.attribute}`, fact);
  const inputs = new Map((db.prepare(`SELECT input, fingerprint FROM project_input_observation WHERE seq IN
    (SELECT MAX(seq) FROM project_input_observation WHERE project_id = ? GROUP BY input)`).all(projectId) as
    Array<{ input: string; fingerprint: string | null }>).map(row => [row.input, row.fingerprint]));
  const artifacts = new Map<string, string | null>();
  const artifactNow = (workflowId: string, artifact: string): string | null => {
    const key = `${workflowId}\0${artifact}`;
    if (!artifacts.has(key)) artifacts.set(key, currentArtifactHash(db, projectId, workflowId, artifact));
    return artifacts.get(key)!;
  };
  const memo = new Map<string, FactView['invalidatedBy']>();
  const invalidatedBy = (fact: FactRecord, visiting = new Set<string>()): FactView['invalidatedBy'] => {
    const known = memo.get(fact.id);
    if (known) return known;
    if (visiting.has(fact.id)) return [];
    visiting.add(fact.id);
    const hits: FactView['invalidatedBy'] = [];
    for (const condition of fact.invalidation) {
      if (condition.kind === 'file') {
        const input = `file:${condition.path}`;
        if (inputs.has(input) && inputs.get(input) !== condition.sha256) hits.push({ condition, now: inputs.get(input) ?? null });
      } else if (condition.kind === 'artifact') {
        const now = artifactNow(condition.workflowId, condition.artifact);
        if ((now ?? '') !== condition.hash) hits.push({ condition, now });
      } else {
        const basis = byId.get(condition.factId);
        const replacement = basis ? current.get(`${basis.objectId}\0${basis.attribute}`) : undefined;
        const holds = basis && replacement && canonicalJson(replacement.value) === canonicalJson(basis.value) &&
          replacement.status !== 'unknown' && replacement.status !== 'stale' && !invalidatedBy(replacement, visiting).length;
        if (!holds) hits.push({ condition, now: replacement?.id ?? null });
      }
    }
    memo.set(fact.id, hits);
    return hits;
  };
  const views = all.map(fact => {
    const isCurrent = current.get(`${fact.objectId}\0${fact.attribute}`) === fact;
    const hits = fact.status === 'unknown' ? [] : invalidatedBy(fact);
    return { ...fact, effectiveStatus: hits.length ? 'stale' as const : fact.status, current: isCurrent, invalidatedBy: hits };
  });
  return options.history ? views : views.filter(view => view.current);
}

// ---------------------------------------------------------------------------------------------------------------------
// User confirmations.

export type Confirmation = { decision: 'confirm' } | { decision: 'correct'; value: unknown } | { decision: 'reject' };
/**
 * A person's statement about a stored fact, appended as a new record that replaces it. Confirming keeps the value and
 * its bindings; correcting gives a new value; rejecting leaves it unknown. The old record and its evidence stay; facts
 * that depended on it go stale when its value changes (see factViews).
 */
export function confirmFact(db: DatabaseSync, projectId: string, factId: string, confirmation: Confirmation, note = ''): FactRecord {
  const fact = storedFact(db, factId);
  if (!fact || fact.projectId !== projectId) throw Object.assign(new Error(`事实不存在：${factId}`), { code: 'NOT_FOUND' });
  const current = currentStored(db, projectId, fact.objectId, fact.attribute);
  if (current?.id !== fact.id) throw Object.assign(new Error('这条事实已有更新的记录，请对最新记录作确认'), { code: 'STALE' });
  const { decision } = confirmation;
  if (decision === 'confirm' && fact.status === 'unknown') throw Object.assign(new Error('未知的事实不能直接确认，请给出值（更正）'), { code: 'BAD_REQUEST' });
  const at = new Date().toISOString();
  // The person speaks about the project as it is now: a file binding is taken at its latest observed content, and a
  // dependency at the current record of what it depended on. A corrected value keeps only the located file; a
  // rejected one is unknown and binds nothing. An analysis's own report is not the project: a statement taken over from
  // it does not depend on it.
  const report = fact.source.type === 'takeover_analysis' ? fact.source.ref.split('#')[0] : undefined;
  const rebound = fact.invalidation.flatMap((condition): Invalidation[] => {
    if (condition.kind === 'file' && condition.path === report) return [];
    if (condition.kind === 'file') {
      const now = latestInput(db, projectId, `file:${condition.path}`);
      return [{ ...condition, sha256: now ? now.fingerprint : condition.sha256 }];
    }
    if (decision !== 'confirm') return [];
    if (condition.kind === 'artifact') return [condition];
    const basis = storedFact(db, condition.factId);
    const replacement = basis ? currentStored(db, projectId, basis.objectId, basis.attribute) : undefined;
    return [{ kind: 'fact', factId: replacement?.id ?? condition.factId }];
  });
  const id = randomUUID();
  inTransaction(db, () => {
    recordFacts(db, projectId, [{ id, objectId: fact.objectId, attribute: fact.attribute,
      value: decision === 'reject' ? null : decision === 'correct' ? confirmation.value : fact.value,
      status: decision === 'reject' ? 'unknown' : 'user_confirmed', evidenceLevel: decision === 'reject' ? 'none' : 'attestation',
      source: { type: 'user', ref: `fact:${fact.id}` }, locator: fact.locator,
      inputFingerprint: decision === 'reject' ? null : fact.inputFingerprint, observer: 'user', observedAt: at,
      confidence: null, scope: fact.scope, invalidation: decision === 'reject' ? [] : rebound, shareLayer: fact.shareLayer,
      supersedes: fact.id }], { observeBindings: false });
    const action = { confirm: 'confirmed', correct: 'corrected', reject: 'rejected' }[decision];
    db.prepare(`INSERT INTO event (workflow_id, actor, entity_type, entity_id, action, reason, payload_json) VALUES (NULL, 'human', 'project_fact', ?, ?, ?, ?)`)
      .run(id, action, note.trim() || { confirm: '用户确认', correct: '用户更正', reject: '用户否定' }[decision],
        JSON.stringify({ projectId, supersedes: fact.id, objectId: fact.objectId, attribute: fact.attribute }));
  });
  return storedFact(db, id)!;
}
