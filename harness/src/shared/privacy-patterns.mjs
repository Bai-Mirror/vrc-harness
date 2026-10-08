// The one statement of the privacy detectors, shared by the development-time Git scan (`tools/privacy-scan.mjs`,
// `tools/privacy-rewrite.mjs`) and by the product's own redaction (`src/diagnostics/redact.ts`). DATA/D5 and the
// repository rule that customer identities, private paths, secrets and login state never leave the machine apply at
// both ends; two copies of the rules would drift, and the copy nobody tests is the one that leaks.
//
// The regexes are plain source strings, not literals: the scanner compiles them with the entry's `flags`, and its
// configuration fingerprints them by source so a changed rule invalidates a cached verdict. `scopes` says where an
// entry is looked for -- a developer's Git object (`content`, `path`, `metadata`), the exported bundle (`content`).
//
// Nothing here is a verdict. A match is a reason to look, to redact or to refuse; it never proves a file is safe.

/** @typedef {{ id: string, regex: string, flags: string, scopes?: string[], reviewOnly?: boolean, literal?: string, replacement?: string }} PrivacyPattern */
/** @typedef {{ id: string, path: string, flags: string, replacement: string }} PrivacyWord */

/** The built-in detectors. `flags` carries `i` where the value's case is not significant. */
// The list is frozen as it was before it moved out of `tools/privacy-scan.mjs`: the extraction must not change what a
// historical scan reports, so a product that wants a narrower cut of an order id handles that on the product side
// (R28 P2-4). `test/privacy-scan.test.mjs` pins the exact sources so a silent widening or narrowing cannot ship.
export const PRIVACY_PATTERNS = [
  { id: 'order-id', regex: 'COMM-[0-9a-f]{8}(?:_[^\\s`"<>/\\\\]+)?', flags: 'gi' },
  { id: 'private-user-path', regex: '(?:[a-zA-Z]:[/\\\\]+[uU][sS][eE][rR][sS][/\\\\]+|/home/|/Users/)(?!<|\\$|%)([^/\\\\\\s"\'`<>]+)', flags: 'g' },
  { id: 'booth-session-value', regex: '_plaza_session_[a-z0-9_]*["\']?(?:\\s*[:=\\t]\\s*["\']?([a-z0-9%+/_=.-]{8,})|["\']?\\s*,\\s*["\']value["\']\\s*:\\s*["\']([a-z0-9%+/_=.-]{8,}))', flags: 'gi', scopes: ['content', 'metadata'] },
  { id: 'api-key-shape', regex: '\\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[a-z0-9_-]{35}|xox[abprs]-[a-z0-9-]{10,})', flags: 'gi' },
  { id: 'token-assignment', regex: '(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie)\\s*["\']?\\s*[:=]\\s*["\'](?:Bearer\\s+)?([a-z0-9%+/_=.-]{16,})', flags: 'gi' },
  { id: 'jwt-shape', regex: 'eyJ[a-z0-9_-]{8,}\\.[a-z0-9_-]{8,}\\.[a-z0-9_-]{8,}', flags: 'gi' },
  { id: 'private-key', regex: '-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY(?: BLOCK)?-----', flags: 'g' },
  { id: 'password-assignment', regex: '(?:password|passwd|client[_-]?secret|secret[_-]?key|auth[_-]?token)\\s*["\']?\\s*[:=]\\s*["\']?([a-z0-9_+/=.-]{20,})', flags: 'gi' },
  { id: 'vrchat-auth', regex: '\\bauthcookie_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', flags: 'gi' },
  { id: 'credential-file', regex: '(?:^|/)(?:\\.env(?:\\.local|\\.production)?|\\.git-credentials|\\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|booth-session|[^/]+\\.(?:p12|pfx|jks|keystore|ppk))$', flags: 'gi', scopes: ['path'] },
];

/** Pattern ids whose match is a credential or login state: never redactable into something worth keeping, only refused. */
export const SECRET_PATTERN_IDS = new Set(['booth-session-value', 'api-key-shape', 'token-assignment', 'jwt-shape',
  'private-key', 'password-assignment', 'vrchat-auth', 'credential-file']);

/**
 * The machine-local prefixes of an absolute user path, with the name that must not travel. Applied when nothing more
 * specific (the project root, the workspace, AVH_HOME) already matched.
 */
export const HOME_PATH_PATTERN = { id: 'user-home-path', regex: '[a-zA-Z]:[/\\\\]+[uU][sS][eE][rR][sS][/\\\\]+(?!<|\\$|%)([^/\\\\\\s"\'`<>]+)|/(?:home|Users)/(?!<|\\$|%)([^/\\s"\'`<>]+)(?=[/\\\\\\s"\'`<>]|$)', flags: 'g' };

/** Which placeholders these patterns produce, so a person reading a bundle knows what was taken out and why. */
export const REDACTION_NOTE = '命中此处列出的规则的文本已替换为占位符；替换的是本机路径、订单号与登录态，不是判断内容是否安全。';

/** True when `flags` asks for a global search. A caller that iterates matches needs one. */
export function globalFlags(flags) { return flags.includes('g') ? flags : `${flags}g`; }
