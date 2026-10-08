import { homedir } from 'node:os';

/**
 * The project archive contract (harness/docs/project-archive.md): the record every business conclusion about a project
 * takes, the share layers, and what a portable path is. Shared by the fact store, the file registry and the projection.
 */

export const ARCHIVE_DIR = '_harness';
export const ARCHIVE_MANIFEST = '_harness/archive.json';
export const ARCHIVE_SCHEMA = 'harness-project-archive/1';
/** Schema id of each projection file; a reader rejects a file whose schema it does not know. */
export const SCHEMAS = {
  state: 'harness-project-state/1',
  legacyState: 'harness-project-state/0.2',
  facts: 'harness-project-facts/1',
  registry: 'harness-file-registry/1',
  workflows: 'harness-project-workflows/1',
  production: 'harness-production-inputs/1',
  decisions: 'harness-project-decisions/1',
  events: 'harness-project-events/1',
  sources: 'harness-project-sources/1',
  evidence: 'harness-project-evidence/1',
  takeover: 'harness-project-takeover/1',
  packs: 'harness-project-packs/1',
  /** v2: the project's messages moved to their own file (conversation), so a share can carry one without the other. */
  sensitive: 'harness-project-sensitive/2',
  conversation: 'harness-project-conversation/1',
} as const;
/** Earlier schemas a reader still accepts: sensitive/1 held the messages itself. */
export const LEGACY_SCHEMAS = { sensitive: 'harness-project-sensitive/1' } as const;
/** The structured candidate facts the takeover analysis Task writes (`_Harness/Recovery/facts.json`). */
export const TAKEOVER_FACTS_SCHEMA = 'harness-takeover-facts/1';

export type FactStatus = 'observed' | 'inferred' | 'user_confirmed' | 'verified' | 'unknown' | 'stale';
export const FACT_STATUSES: readonly FactStatus[] = ['observed', 'inferred', 'user_confirmed', 'verified', 'unknown', 'stale'];
/**
 * How strong the support for a value is, weakest first. Separate from confidence: an AI may be confident about an
 * inference, and it is still an inference. `attestation` is a person's statement, the authority on intent and rights.
 */
export type EvidenceLevel = 'none' | 'inference' | 'document' | 'observation' | 'attestation' | 'verification';
export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = ['none', 'inference', 'document', 'observation', 'attestation', 'verification'];
export function evidenceRank(level: EvidenceLevel): number { return EVIDENCE_LEVELS.indexOf(level); }
export function evidenceAtLeast(level: EvidenceLevel, minimum: EvidenceLevel): boolean { return evidenceRank(level) >= evidenceRank(minimum); }

export type ShareLayer = 'A' | 'B' | 'C' | 'excluded';
export const SHARE_LAYERS: readonly ShareLayer[] = ['A', 'B', 'C', 'excluded'];
export type Rights = 'transferable' | 'not_transferable' | 'unknown';
export type Sensitivity = 'normal' | 'sensitive' | 'secret';

/** Sources that write fact records; `workflow` and `project` facts are derived from their own append-only tables. */
export type StoredFactSource = 'import_scan' | 'harness_scan' | 'takeover_analysis' | 'user';
export type FactSourceType = StoredFactSource | 'workflow' | 'project';

/** When a fact stops holding. Any condition that holds makes the fact stale; none is ever rewritten into the record. */
export type Invalidation =
  /** The file at `path` (relative to the project root) no longer has this sha256; null: the file was absent. */
  | { kind: 'file'; path: string; sha256: string | null }
  /** The Workflow's artifact no longer has this fingerprint. */
  | { kind: 'artifact'; workflowId: string; artifact: string; hash: string }
  /** The fact this one was derived from was corrected, withdrawn or went stale. */
  | { kind: 'fact'; factId: string };

/** Where a conclusion was read: a project file (relative path), a line in it, an object inside it (a scene path). */
export interface Locator { path?: string; line?: number; object?: string }

export interface FactRecord {
  id: string;
  objectId: string;
  attribute: string;
  /** JSON; null for an unknown value. */
  value: unknown;
  source: { type: FactSourceType; ref: string };
  locator: Locator;
  inputFingerprint: string | null;
  /** The tool (and its version) or the person that observed, inferred or confirmed the value. */
  observer: string;
  /** When the value was observed or confirmed. */
  observedAt: string;
  /** The status when recorded; the status now is FactView.effectiveStatus. */
  status: FactStatus;
  evidenceLevel: EvidenceLevel;
  confidence: number | null;
  scope: string;
  invalidation: Invalidation[];
  shareLayer: ShareLayer;
  supersedes: string | null;
  recordedAt: string;
}
export interface FactView extends FactRecord {
  /** `stale` while an invalidation condition holds; otherwise the recorded status. */
  effectiveStatus: FactStatus;
  /** False for a record a newer record of the same object and attribute replaced (history). */
  current: boolean;
  /** The conditions that hold, with what the input is now (null: absent or unknown). */
  invalidatedBy: Array<{ condition: Invalidation; now: string | null }>;
}

const OBJECT_ID = /^[a-z][a-z0-9_]*(?::\S.{0,299})?$/s;
const ATTRIBUTE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
export function validObjectId(value: string): boolean { return OBJECT_ID.test(value) && !/[\r\n]/.test(value); }
export function validAttribute(value: string): boolean { return ATTRIBUTE.test(value); }

/**
 * A path the archive may carry: relative to the project root, `/` separators, no `.`/`..` segments, not absolute on
 * any platform. `.` alone is the project root; a tree (a registered directory) ends with `/`.
 */
export function isPortablePath(path: string, options: { tree?: boolean } = {}): boolean {
  if (path === '.') return !options.tree;
  if (!path || path.includes('\\') || path.includes('\0') || /[\r\n]/.test(path)) return false;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split('/');
  if (options.tree) { if (parts.at(-1) !== '') return false; parts.pop(); }
  return parts.length > 0 && parts.every(part => part !== '' && part !== '.' && part !== '..');
}
export function assertPortablePath(path: string, what: string, options: { tree?: boolean } = {}): string {
  if (!isPortablePath(path, options)) throw new Error(`${what} 不是工程内的可移植相对路径：${path}`);
  return path;
}

/** Absolute directories of this machine that must never reach the portable layer, with the word that replaces them. */
export interface LocalRoot { path: string; label: string }
export function localRoots(project: string, others: LocalRoot[] = []): LocalRoot[] {
  const home = homedir();
  return [{ path: project, label: '' }, ...others, ...(home && home.length > 3 ? [{ path: home, label: LOCAL_PATH_WORD }] : [])]
    .filter(root => root.path && root.path.length > 1);
}
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Both separator spellings of a root, for text written on either platform. */
function spellings(root: string): string[] {
  const trimmed = root.replace(/[\\/]+$/, '');
  return [...new Set([trimmed, trimmed.replaceAll('\\', '/'), trimmed.replaceAll('/', '\\')])].sort((a, b) => b.length - a.length);
}
/** Common POSIX system roots; a path under one of them in free text is a local path, not a Unity hierarchy path. */
const POSIX_LOCAL = /(^|[^A-Za-z0-9_.~/\\-])(\/(?:home|Users|tmp|var|opt|mnt|media|srv|root|usr|etc|private|Volumes|data|run|nix|snap)\/[^\s"'<>|)\]}]*)/g;
const WINDOWS_ABSOLUTE = /(^|[^A-Za-z0-9_])((?:[A-Za-z]:[\\/]|\\\\[^\\\s"']+\\)[^\s"'<>|)\]}]*)/g;
/** The patterns of a local absolute path in text (group 2 is the path), for scanners that read files in chunks. */
export const LOCAL_PATH_PATTERNS: readonly RegExp[] = [WINDOWS_ABSOLUTE, POSIX_LOCAL];
/** Both separator spellings of each local root, longest first (what a scanner looks for literally). */
export function rootSpellings(roots: LocalRoot[]): string[] { return roots.flatMap(root => spellings(root.path)); }
/** The rest of a path after a root, up to the end of the token. */
const REMAINDER = '(?:[\\\\/][^\\s"\'<>|)\\]}]*)?';
export const LOCAL_PATH_WORD = '<本机路径>';

/**
 * Free text made portable: a path in the project becomes relative to it (the root itself `.`); a path under another
 * local root becomes that root's label as a whole (a folder name there can name a customer); any remaining absolute
 * path of either platform becomes `<本机路径>`.
 */
export function portableText(text: string, roots: LocalRoot[], caseInsensitive = process.platform === 'win32'): string {
  let result = text;
  const flags = caseInsensitive ? 'gi' : 'g';
  for (const root of roots) for (const spelling of spellings(root.path)) {
    if (root.label) { result = result.replace(new RegExp(`${escape(spelling)}(?![\\w.-])${REMAINDER}`, flags), root.label); continue; }
    // The project root followed by a separator: what follows is already relative to it.
    result = result.replace(new RegExp(`${escape(spelling)}[\\\\/]`, flags), '');
    result = result.replace(new RegExp(`${escape(spelling)}(?![\\w.-])`, flags), '.');
  }
  return result.replace(WINDOWS_ABSOLUTE, (_, lead: string) => `${lead}${LOCAL_PATH_WORD}`)
    .replace(POSIX_LOCAL, (_, lead: string) => `${lead}${LOCAL_PATH_WORD}`);
}

/**
 * Every string in a JSON value that still carries a local absolute path: a local root, a Windows drive or UNC path,
 * or a path under a POSIX system root. Returns JSON pointers; empty means the value is portable.
 */
export function localPathLeaks(value: unknown, roots: LocalRoot[], caseInsensitive = process.platform === 'win32'):
  Array<{ pointer: string; sample: string }> {
  const needles = roots.flatMap(root => spellings(root.path)).map(spelling => caseInsensitive ? spelling.toLowerCase() : spelling);
  const leaks: Array<{ pointer: string; sample: string }> = [];
  const check = (text: string, pointer: string): void => {
    const haystack = caseInsensitive ? text.toLowerCase() : text;
    const hit = needles.some(needle => haystack.includes(needle)) || new RegExp(WINDOWS_ABSOLUTE.source).test(text) ||
      new RegExp(POSIX_LOCAL.source).test(text);
    if (hit) leaks.push({ pointer, sample: text.slice(0, 120) });
  };
  const visit = (item: unknown, pointer: string): void => {
    if (typeof item === 'string') check(item, pointer);
    else if (Array.isArray(item)) item.forEach((entry, i) => visit(entry, `${pointer}/${i}`));
    else if (item && typeof item === 'object') for (const [key, entry] of Object.entries(item)) {
      check(key, `${pointer}/${key}`);
      visit(entry, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    }
  };
  visit(value, '');
  return leaks;
}
