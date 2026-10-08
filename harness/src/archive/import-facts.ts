import type { ImportReport, Source } from '../import/types.ts';
import { isPortablePath, portableText, type Invalidation, type LocalRoot, type Locator } from './contract.ts';
import type { NewFact } from './facts.ts';
import { categorize, classifier, HARNESS_RULES, type NewEntry } from './registry.ts';

/**
 * What a read-only import observed, as fact records and file registrations. Only what the files show is recorded:
 * history the files cannot prove (progress, approvals, verification) is `unknown`, never reconstructed.
 */
export interface ImportInputs {
  /** The construction record and ledger the import read, relative to the project root. */
  recordFile?: string;
  ledgerFile?: string;
  /** Snapshot fingerprints by relative path: sha256 for ordinary files, a `sampled:`/`symlink:` form otherwise. */
  files: Record<string, string>;
}

const SHA256 = /^[0-9a-f]{64}$/;
/** A `file:line` source as a locator, when the file part is a project path. */
function locate(source: string | undefined): Locator {
  const match = source ? /^(.+?):(\d+)$/.exec(source) : null;
  if (match && isPortablePath(match[1]!)) return { path: match[1]!, line: Number(match[2]) };
  return source && isPortablePath(source) ? { path: source } : {};
}
/** Parse the import's base-avatar note: 「最可能：Kaguya（12 次）；其他候选：Milfy（7 次）」. */
function baseGuess(note: string | undefined): { name: string; confidence: number } | undefined {
  if (!note?.trim()) return undefined;
  const counts = [...note.matchAll(/([^：；、（）]+)（(\d+) 次）/g)].map(match => ({ name: match[1]!.trim(), count: Number(match[2]) }));
  const top = /^最可能：(.+?)（/.exec(note.trim())?.[1]?.trim() ?? note.trim();
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  const own = counts.find(item => item.name === top)?.count;
  return { name: top, confidence: own && total ? Math.round((own / total) * 100) / 100 : 0.5 };
}

export function importFindings(report: ImportReport, inputs: ImportInputs): { facts: NewFact[]; entries: NewEntry[] } {
  const roots: LocalRoot[] = [{ path: report.projectPath, label: '' }, { path: report.workspacePath, label: '<工作区>' }];
  const text = (value: string): string => portableText(value, roots);
  const ref = `import_report:${report.id}`;
  const observer = `harness-import/${report.generated_from?.harness_version ?? 'unknown'}`;
  const sha = (path: string): string | null => SHA256.test(inputs.files[path] ?? '') ? inputs.files[path]! : null;
  /** Bind a fact to a file the import read: its content now, or its absence. Large sampled files bind nothing. */
  const bind = (path: string | undefined): Invalidation[] => {
    if (!path) return [];
    if (!(path in inputs.files)) return [{ kind: 'file', path, sha256: null }];
    const hash = sha(path);
    return hash ? [{ kind: 'file', path, sha256: hash }] : [];
  };
  const facts: NewFact[] = [];
  const observed = (objectId: string, attribute: string, value: unknown, extra: Partial<NewFact> & { evidenceLevel?: 'observation' | 'document' }): void => {
    facts.push({ objectId, attribute, value, source: { type: 'import_scan', ref }, observer, status: 'observed',
      evidenceLevel: 'observation', scope: 'project', shareLayer: 'A', ...extra });
  };
  const unknown = (objectId: string, attribute: string, extra: Partial<NewFact> = {}): void => {
    facts.push({ objectId, attribute, value: null, source: { type: 'import_scan', ref }, observer, status: 'unknown',
      evidenceLevel: 'none', scope: 'project', shareLayer: 'A', ...extra });
  };

  const versionFile = 'ProjectSettings/ProjectVersion.txt';
  if (report.identity.unityVersion) observed('project', 'unity.version', report.identity.unityVersion,
    { locator: { path: versionFile, line: 1 }, inputFingerprint: sha(versionFile), invalidation: bind(versionFile) });
  else unknown('project', 'unity.version', { locator: { path: versionFile }, invalidation: bind(versionFile) });
  const vpmFile = 'Packages/vpm-manifest.json';
  if (vpmFile in inputs.files) observed('project', 'vpm.locked', report.identity.packages,
    { locator: { path: vpmFile }, inputFingerprint: sha(vpmFile), invalidation: bind(vpmFile) });
  else unknown('project', 'vpm.locked', { locator: { path: vpmFile }, invalidation: bind(vpmFile) });
  const base = baseGuess(report.identity.base);
  if (base) facts.push({ objectId: 'project', attribute: 'base.avatar', value: base.name, source: { type: 'import_scan', ref }, observer,
    status: 'inferred', evidenceLevel: 'inference', confidence: base.confidence, scope: 'project', shareLayer: 'A',
    locator: inputs.recordFile ? { path: inputs.recordFile } : {}, inputFingerprint: inputs.recordFile ? sha(inputs.recordFile) : null,
    invalidation: bind(inputs.recordFile) });
  else unknown('project', 'base.avatar');

  // History: only what a record in the project says, as what it says; nothing is filled in where no record exists.
  const dates = report.timeline.recent.map(item => item.date).sort();
  if (inputs.recordFile) observed('project', 'history.timeline', { entries: report.timeline.count, latest: dates.at(-1) ?? null,
    stateHeaderTime: report.stateHeader.time ?? null }, { evidenceLevel: 'document', locator: { path: inputs.recordFile },
    inputFingerprint: sha(inputs.recordFile), invalidation: bind(inputs.recordFile) });
  else unknown('project', 'history.timeline');
  // Approvals and independent verification leave no trace a file scan can prove.
  unknown('project', 'history.approvals');
  unknown('project', 'history.verification');
  const processScope = `process:${report.processId}@${report.processVersion}`;
  for (const stage of report.stages) {
    const sources = stage.evidence.map(item => item.source);
    const locator = locate(sources[0]);
    const binding = bind(locator.path && locator.path === inputs.recordFile ? inputs.recordFile : undefined);
    if (stage.status === 'unknown') unknown(`stage:${stage.id}`, 'history.progress', { scope: processScope });
    else if (stage.status === 'not_applicable') observed(`stage:${stage.id}`, 'history.progress', 'not_applicable',
      { scope: processScope, evidenceLevel: 'document', locator, invalidation: binding });
    else if (stage.status === 'verified') observed(`stage:${stage.id}`, 'history.progress', 'done',
      { scope: processScope, locator, invalidation: binding, inputFingerprint: report.snapshotHash });
    else if (stage.weakEvidence) facts.push({ objectId: `stage:${stage.id}`, attribute: 'history.progress', value: 'done',
      source: { type: 'import_scan', ref }, observer, status: 'inferred', evidenceLevel: 'inference', scope: processScope, shareLayer: 'A',
      locator, invalidation: [] });
    else observed(`stage:${stage.id}`, 'history.progress', 'done', { scope: processScope, evidenceLevel: 'document', locator, invalidation: binding });
  }
  for (const review of report.reviews) observed(`review:${review.id}`, 'result', { status: review.status, reason: text(review.reason) },
    { inputFingerprint: report.snapshotHash, source: { type: 'import_scan', ref: `${ref}#review:${review.id}` } });
  observed('project', 'git.state', report.git.reason ? { available: false } : { available: true, commits: report.git.commits.length,
    uncommitted: report.git.changes.length, latestCommitAt: report.git.latestCommitAt ?? null }, { inputFingerprint: report.snapshotHash });
  observed('project', 'import.snapshot', { hash: report.snapshotHash, files: Object.keys(inputs.files).length,
    sampledFiles: report.snapshotSampledFiles.length }, { inputFingerprint: report.snapshotHash });

  // The records' own words are the operator's and the customer's: layer C. A source outside the project (a ledger in
  // the workspace) is named relative to the workspace and never used as a project locator.
  const sensitive = { shareLayer: 'C' as const, evidenceLevel: 'document' as const };
  const inProject = (source: string, file: string | undefined): Locator => {
    const locator = locate(source);
    return file && locator.path === file ? locator : {};
  };
  const ledgerBinding = bind(inputs.ledgerFile);
  for (const item of report.ledger) {
    const locator = inProject(item.source, inputs.ledgerFile);
    observed(`ledger:${item.id}`, 'status', { status: item.status, archived: item.archived, text: text(item.text),
      ...(locator.path ? {} : { source: `workspace:${item.source}` }) },
    { ...sensitive, locator, invalidation: locator.path ? ledgerBinding : [], ...(locator.path ? {} : { scope: 'workspace' }) });
  }
  for (const item of report.externalLedger) observed(`ledger:${item.id}`, 'status', { status: item.status, archived: item.archived,
    text: text(item.text), source: `workspace:${item.source}` }, { ...sensitive, scope: 'workspace' });
  if (Object.keys(report.stateHeader.fields).length) observed('record', 'stateHeader', Object.fromEntries(Object.entries(report.stateHeader.fields)
    .map(([key, value]) => [key, Array.isArray(value) ? value.map(text) : text(value)])),
  { ...sensitive, locator: inProject(report.stateHeader.source ?? '', inputs.recordFile), invalidation: bind(inputs.recordFile) });
  const listed = (items: Source[] | undefined, file: string | undefined): Array<{ source: string; detail: string }> =>
    (items ?? []).map(item => ({ source: inProject(item.source, file).path ? item.source : `workspace:${item.source}`, detail: text(item.detail) }));
  if (report.ledgerDecisions.length) observed('record', 'decisions', listed(report.ledgerDecisions, inputs.recordFile ?? inputs.ledgerFile),
    { ...sensitive, invalidation: bind(inputs.recordFile) });
  if (report.pendingDecisions?.length) observed('record', 'pendingDecisions', listed(report.pendingDecisions, undefined), { ...sensitive, scope: 'workspace' });

  // Every file present at import is registered as found there, origin unknown; Harness's own partitions and the
  // project's VCS data are classified by the built-in rules instead.
  const owned = classifier(HARNESS_RULES);
  const entries: NewEntry[] = Object.entries(inputs.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([path, fingerprint]) => {
    if (fingerprint.startsWith('symlink:') || fingerprint.startsWith('special:') || !isPortablePath(path) || owned.classify(path)) return [];
    return [{ path, match: 'file' as const, ...categorize(path), source: { type: 'import_scan' as const, ref },
      sha256: SHA256.test(fingerprint) ? fingerprint : null }];
  });
  return { facts, entries };
}
