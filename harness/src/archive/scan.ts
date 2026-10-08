import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { packTreeHash } from '../pack-hash.ts';
import { harnessVersion } from '../provenance.ts';
import { artifactFiles, artifactFingerprint, fileHash } from '../workflow/artifacts.ts';
import type { CapabilityManifest } from '../workflow/capabilities.ts';
import { hostPlatform } from '../host-platform.ts';
import { isPortablePath, type Invalidation } from './contract.ts';
import { factViews, inTransaction, latestFormalWorkflow, observeInput, recordFacts, storedFacts, workflowIsLive, type NewFact } from './facts.ts';
import { BUILTIN_RULES, classifier, classifyTree, HARNESS_RULES, registerEntries, storedEntries, type NewEntry } from './registry.ts';
import { projectRoot } from './takeover.ts';

/**
 * The diff scan: what the project's files are now, recorded in the state database so the archive stays a function of
 * the database. The light part runs at every safe point (identity inputs and every file a fact is bound to, stat
 * cached); the tree part walks the project for the classification registry and runs after Tasks change the project.
 */

const VERSION_FILE = 'ProjectSettings/ProjectVersion.txt', VPM_FILE = 'Packages/vpm-manifest.json';
const UNCLASSIFIED_SAMPLE = 500, SYMLINK_SAMPLE = 100;
// Bind provenance to the loaded scanner, before a latency-sensitive scheduler round begins.
const observerName = `harness-scan/${harnessVersion()}`;
const observer = (): string => observerName;

/**
 * A file's sha256 now (a symbolic link hashes as its target text, so it never equals a file's content); null when it
 * is absent or a directory. Files whose size, mtime and inode are unchanged are not reread.
 */
function contentHash(root: string, path: string): string | null {
  const target = join(root, ...path.split('/'));
  try { const info = lstatSync(target); if (!info.isFile() && !info.isSymbolicLink()) return null; } catch { return null; }
  try { return fileHash(target) ?? null; } catch { return null; }
}

function readJson(root: string, path: string): unknown {
  try { return JSON.parse(readFileSync(join(root, ...path.split('/')), 'utf8')) as unknown; } catch { return undefined; }
}

/** What the Unity project says about itself now: editor version, locked VPM packages, which of them are not resolved. */
function identityFacts(root: string): NewFact[] {
  const facts: NewFact[] = [];
  const base = { source: { type: 'harness_scan' as const, ref: '' }, observer: observer(), scope: 'project', shareLayer: 'A' as const };
  const versionHash = contentHash(root, VERSION_FILE);
  const versionBinding: Invalidation[] = [{ kind: 'file', path: VERSION_FILE, sha256: versionHash }];
  const version = versionHash ? /^m_EditorVersion:\s*(.+)$/m.exec(readFileSync(join(root, ...VERSION_FILE.split('/')), 'utf8'))?.[1]?.trim() : undefined;
  facts.push(version
    ? { ...base, source: { type: 'harness_scan', ref: VERSION_FILE }, objectId: 'project', attribute: 'unity.version', value: version,
      status: 'observed', evidenceLevel: 'observation', locator: { path: VERSION_FILE, line: 1 }, inputFingerprint: versionHash, invalidation: versionBinding }
    // Unknown, bound to what the file was (usually absent): its appearance is a change a person's statement yields to.
    : { ...base, source: { type: 'harness_scan', ref: VERSION_FILE }, objectId: 'project', attribute: 'unity.version', value: null,
      status: 'unknown', evidenceLevel: 'none', locator: { path: VERSION_FILE }, invalidation: versionBinding });
  const vpmHash = contentHash(root, VPM_FILE);
  const manifest = vpmHash ? readJson(root, VPM_FILE) as { locked?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> } | undefined : undefined;
  const listed = manifest && typeof manifest === 'object' ? manifest.locked ?? manifest.dependencies : undefined;
  if (listed && typeof listed === 'object') {
    const locked = Object.fromEntries(Object.entries(listed).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([id, entry]) => [id, typeof entry?.version === 'string' ? entry.version : 'unknown']));
    facts.push({ ...base, source: { type: 'harness_scan', ref: VPM_FILE }, objectId: 'project', attribute: 'vpm.locked', value: locked,
      status: 'observed', evidenceLevel: 'observation', locator: { path: VPM_FILE }, inputFingerprint: vpmHash,
      invalidation: [{ kind: 'file', path: VPM_FILE, sha256: vpmHash }] });
    // VPM resolves each locked package into Packages/<id>/; one without its package.json is missing here.
    const unresolved = Object.keys(locked).filter(id => !existsSync(join(root, 'Packages', id, 'package.json')));
    facts.push({ ...base, source: { type: 'harness_scan', ref: `${VPM_FILE}#locked` }, objectId: 'project', attribute: 'vpm.unresolved',
      value: unresolved, status: 'observed', evidenceLevel: 'observation', locator: { path: VPM_FILE }, inputFingerprint: vpmHash });
  } else facts.push({ ...base, source: { type: 'harness_scan', ref: VPM_FILE }, objectId: 'project', attribute: 'vpm.locked', value: null,
    status: 'unknown', evidenceLevel: 'none', locator: { path: VPM_FILE }, invalidation: [{ kind: 'file', path: VPM_FILE, sha256: vpmHash }] });
  return facts;
}

/** The frozen artifact specification of a formal Workflow. */
function frozenArtifacts(db: DatabaseSync, workflowId: string): CapabilityManifest['artifacts'] {
  const row = db.prepare('SELECT capabilities_json FROM workflow_definition WHERE workflow_id = ?').get(workflowId) as { capabilities_json: string } | undefined;
  return row ? (JSON.parse(row.capabilities_json) as CapabilityManifest).artifacts : {};
}

export interface ScanResult { tree: boolean; observations: number; facts: number; registered: number; unclassified?: number; files?: number }

/**
 * Observe the project now. `tree` also walks it: VPM and Workflow registrations, pack draft hashes, and the
 * unclassified files. The walk reads the file system only; everything it concludes is written to the database.
 */
export function scanProject(db: DatabaseSync, projectId: string, options: { tree?: boolean } = {}): ScanResult {
  const root = projectRoot(db, projectId);
  const result: ScanResult = { tree: Boolean(options.tree), observations: 0, facts: 0, registered: 0 };
  if (!existsSync(root)) return result;
  const before = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM project_fact WHERE project_id = ?').get(projectId) as { n: number }).n;
  recordFacts(db, projectId, identityFacts(root));
  result.facts = (db.prepare('SELECT COUNT(*) AS n FROM project_fact WHERE project_id = ? AND seq > ?').get(projectId, before) as { n: number }).n;
  // Every file a stored fact is bound to, as it is now: a changed or deleted input makes the fact stale.
  const bound = new Set<string>();
  for (const fact of storedFacts(db, projectId)) for (const condition of fact.invalidation)
    if (condition.kind === 'file' && isPortablePath(condition.path)) bound.add(condition.path);
  inTransaction(db, () => { for (const path of [...bound].sort()) if (observeInput(db, projectId, `file:${path}`, contentHash(root, path))) result.observations++; });
  // A Workflow the scheduler no longer advances keeps its last fingerprints; what its artifacts are now is observed here,
  // so an approval of a version that no longer exists does not stay valid.
  const workflow = latestFormalWorkflow(db, projectId);
  if (workflow && !workflowIsLive(workflow.status)) {
    const artifacts = frozenArtifacts(db, workflow.id);
    const kinds = new Set(factViews(db, projectId).flatMap(fact => fact.invalidation)
      .flatMap(condition => condition.kind === 'artifact' && condition.workflowId === workflow.id ? [condition.artifact] : []));
    inTransaction(db, () => {
      for (const kind of [...kinds].sort()) {
        const spec = artifacts[kind];
        if (!spec) continue;
        let hash: string | null;
        try { hash = artifactFingerprint(root, spec) ?? null; } catch { continue; }
        if (observeInput(db, projectId, `artifact:${workflow.id}:${kind}`, hash)) result.observations++;
      }
    });
  }
  if (!options.tree) return result;

  const entries: NewEntry[] = [];
  const vpmHash = contentHash(root, VPM_FILE);
  const manifest = vpmHash ? readJson(root, VPM_FILE) as { locked?: Record<string, unknown>; dependencies?: Record<string, unknown> } | undefined : undefined;
  for (const id of Object.keys((manifest && (manifest.locked ?? manifest.dependencies)) ?? {}).sort())
    if (isPortablePath(`Packages/${id}/`, { tree: true })) entries.push({ path: `Packages/${id}/`, match: 'tree', category: 'vpm-package',
      shareLayer: 'excluded', rights: 'unknown', sensitivity: 'normal', restore: 'vpm', source: { type: 'vpm', ref: `${VPM_FILE}@${vpmHash}` },
      reason: 'VPM 锁定的依赖，接收端按 vpm-manifest 解析取回' });
  // The members of the latest Workflow's artifacts are what its stages produced under their contracts. Members in trees
  // the built-in rules own (build copies under _harness_build/, say) are classified there already.
  const owned = classifier(HARNESS_RULES);
  if (workflow) for (const [kind, spec] of Object.entries(frozenArtifacts(db, workflow.id)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    let members: string[];
    try { members = artifactFiles(root, spec); } catch { continue; }
    for (const path of members) if (isPortablePath(path) && !owned.classify(path)) entries.push({ path, match: 'file',
      category: spec.includeIgnored ? 'build-output' : 'workflow-artifact', shareLayer: spec.includeIgnored ? 'excluded' : 'A', rights: 'unknown',
      sensitivity: 'normal', restore: spec.includeIgnored ? 'regenerate' : null, source: { type: 'workflow', ref: `workflow:${workflow.id}:artifact:${kind}` },
      reason: spec.includeIgnored ? `Workflow 产物 ${kind}（构建输出，接收端重新生成）` : `Workflow 产物 ${kind} 的成员，来源与转交权待确认` });
  }
  result.registered = registerEntries(db, projectId, entries);
  // Candidate pack drafts in the project: whether one still holds the registered content decides where it restores from.
  const drafts = db.prepare(`SELECT candidate_id, source_root FROM managed_pack_authoring WHERE project_id = ? ORDER BY created_at, id`)
    .all(projectId) as Array<{ candidate_id: string; source_root: string }>;
  inTransaction(db, () => {
    for (const draft of drafts) {
      if (!hostPlatform.within(root, draft.source_root)) continue;
      let hash: string | null = null;
      try { if (existsSync(draft.source_root)) hash = packTreeHash(draft.source_root).hash; } catch { hash = null; }
      if (observeInput(db, projectId, `pack-draft:${draft.candidate_id}`, hash)) result.observations++;
    }
  });
  const tree = classifyTree(root, [...BUILTIN_RULES, ...storedEntries(db, projectId)]);
  const eventSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM event').get() as { n: number }).n;
  db.prepare(`INSERT INTO project_scan (project_id, event_seq, files, unclassified, unclassified_json, symlinks_json, summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(projectId, eventSeq, tree.files, tree.unclassified.length,
    JSON.stringify(tree.unclassified.slice(0, UNCLASSIFIED_SAMPLE)), JSON.stringify(tree.symlinks.slice(0, SYMLINK_SAMPLE)),
    JSON.stringify({ layers: tree.layers, rightsUnresolvedA: tree.rightsUnknownA, symlinks: tree.symlinks.length, truncated: tree.truncated }));
  return { ...result, unclassified: tree.unclassified.length, files: tree.files };
}

/** Whether Tasks of the project changed something since the last walk (or it was never walked). */
export function treeScanDue(db: DatabaseSync, projectId: string): boolean {
  const last = db.prepare('SELECT event_seq FROM project_scan WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(projectId) as { event_seq: number } | undefined;
  if (!last) return true;
  const latest = (db.prepare(`SELECT COALESCE(MAX(e.seq), 0) AS n FROM event e JOIN workflow w ON w.id = e.workflow_id
    WHERE w.project_id = ? AND e.entity_type = 'task'`).get(projectId) as { n: number }).n;
  return latest > last.event_seq;
}

/** A project-relative POSIX path for an absolute one inside the project; undefined outside it. */
export function relativeInside(root: string, path: string): string | undefined {
  if (!hostPlatform.within(root, path)) return undefined;
  const rel = relative(root, path).split(sep).join('/');
  return rel === '' ? '.' : rel;
}
