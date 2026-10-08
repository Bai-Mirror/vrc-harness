export const MATURITIES = ['candidate', 'tested', 'accepted', 'deprecated'] as const;
export const KINDS = ['decision', 'observation', 'spec', 'hypothesis', 'case', 'candidate'] as const;
export const VERIFICATION_KINDS = ['sop-editorial', 'harness-regression', 'human-approval', 'field-report'] as const;
export const VISIBILITIES = ['local', 'shareable'] as const;
export const VALIDITIES = ['unknown', 'valid', 'questioned', 'invalid', 'disputed'] as const;
export type KnowledgeKind = typeof KINDS[number];
export type Visibility = typeof VISIBILITIES[number];
export type Validity = typeof VALIDITIES[number];
export type VerificationKind = typeof VERIFICATION_KINDS[number];
export interface Verification { at?: string; kind: VerificationKind; ref: string }
export interface KnowledgeMeta {
  kind: KnowledgeKind;
  asserted_by?: string;
  source_id?: string;
  applies_to?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  recorded_at?: string;
  verification: Verification[];
  visibility: Visibility;
  validity: Validity;
  supersedes?: string;
}
type Obj = Record<string, unknown>;
function mapping(value: unknown, at: string): Obj {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: expected mapping`);
  return value as Obj;
}
function nonempty(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`${at}: expected nonempty string`);
  return value;
}
function choice<T extends string>(value: unknown, values: readonly T[], at: string): T {
  const selected = nonempty(value, at);
  if (!values.includes(selected as T)) throw new Error(`${at}: unsupported ${selected}`);
  return selected as T;
}
function utc(value: unknown, at: string): string {
  const selected = nonempty(value, at);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(selected) || Number.isNaN(Date.parse(selected)))
    throw new Error(`${at}: expected UTC ISO time`);
  return selected;
}
export function knowledgeMeta(raw: Obj, at: string): KnowledgeMeta {
  const kind = raw.kind === undefined ? 'spec' : choice(raw.kind, KINDS, `${at}.kind`);
  const asserted_by = raw.asserted_by === undefined ? undefined : nonempty(raw.asserted_by, `${at}.asserted_by`);
  if (asserted_by !== undefined && !/^(?:human:.+|compile:.+|distill:.+|import)$/.test(asserted_by))
    throw new Error(`${at}.asserted_by: expected human:<who>, compile:<run id>, distill:<run id>, or import`);
  const source_id = raw.source_id === undefined ? undefined : nonempty(raw.source_id, `${at}.source_id`);
  if (source_id !== undefined && !/^[0-9a-f]{12}$/.test(source_id)) throw new Error(`${at}.source_id: expected 12 lowercase sha256 hex characters`);
  const applies_to = raw.applies_to === undefined ? undefined : mapping(raw.applies_to, `${at}.applies_to`);
  const environment = raw.environment === undefined ? undefined : mapping(raw.environment, `${at}.environment`);
  if (kind === 'observation' && (!environment || !Object.keys(environment).length))
    throw new Error(`${at}.environment: required for observation`);
  const recorded_at = raw.recorded_at === undefined ? undefined : utc(raw.recorded_at, `${at}.recorded_at`);
  const verification = raw.verification === undefined ? [] : (() => {
    if (!Array.isArray(raw.verification)) throw new Error(`${at}.verification: expected list`);
    return raw.verification.map((item, i): Verification => {
      const entry = mapping(item, `${at}.verification[${i}]`);
      return {
        at: entry.at === undefined ? undefined : utc(entry.at, `${at}.verification[${i}].at`),
        kind: choice(entry.kind, VERIFICATION_KINDS, `${at}.verification[${i}].kind`),
        ref: nonempty(entry.ref, `${at}.verification[${i}].ref`),
      };
    });
  })();
  const visibility = raw.visibility === undefined ? 'local' : choice(raw.visibility, VISIBILITIES, `${at}.visibility`);
  const validity = raw.validity === undefined ? 'unknown' : choice(raw.validity, VALIDITIES, `${at}.validity`);
  const supersedes = raw.supersedes === undefined ? undefined : nonempty(raw.supersedes, `${at}.supersedes`);
  return { kind, asserted_by, source_id, applies_to, environment, recorded_at, verification, visibility, validity, supersedes };
}
/** Only the metadata keys present in the raw entry, so an entry without metadata parses exactly as under v0.1. */
export function explicitMeta(raw: Obj, meta: KnowledgeMeta): Partial<KnowledgeMeta> {
  return Object.fromEntries(Object.entries(meta).filter(([key]) => Object.hasOwn(raw, key))) as Partial<KnowledgeMeta>;
}
