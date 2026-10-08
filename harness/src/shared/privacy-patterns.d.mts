// Types for `privacy-patterns.mjs`, which is a runtime module on purpose: `tools/privacy-scan.mjs` and
// `tools/privacy-rewrite.mjs` are plain Node scripts and must import the very same rule list the product uses.

export interface PrivacyPattern {
  id: string;
  /** Regular-expression source; a caller compiles it with `flags`. */
  regex: string;
  flags: string;
  /** Where the entry is looked for. Defaults to every scope the caller searches. */
  scopes?: string[];
  /** A finding that is reviewed rather than blocking (only the repository scanner uses this). */
  reviewOnly?: boolean;
  /** A literal string instead of `regex`, used by local pattern configuration. */
  literal?: string;
  /** What the repository rewriter replaces the match with, when it rewrites rather than reports. */
  replacement?: string;
}

export declare const PRIVACY_PATTERNS: PrivacyPattern[];
export declare const SECRET_PATTERN_IDS: Set<string>;
export declare const HOME_PATH_PATTERN: { id: string; regex: string; flags: string };
export declare const REDACTION_NOTE: string;
export declare function globalFlags(flags: string): string;
