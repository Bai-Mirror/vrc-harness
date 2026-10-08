import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { canonicalJson } from '../pack-hash.ts';
import { LOCAL_PATH_PATTERNS, rootSpellings, type LocalRoot } from './contract.ts';

/**
 * What a share package may never carry, found in the files themselves rather than inferred from where they are:
 * credentials, access tokens, private keys and login state (never shareable), and what needs a person's eye
 * (this machine's absolute paths, Blueprint IDs, the order number). One pass per file computes its size, SHA-256 and
 * CRC32 and runs every detector, so the share compiler reads each file once.
 */

export type FindingKind = 'secret' | 'sensitive';
export interface ScanFinding {
  /** Which detector matched (a stable id, see DETECTORS). */
  detector: string;
  kind: FindingKind;
  /** 1-based line of the match in a text file; null for a binary file or a finding about the whole file. */
  line: number | null;
  /** What a person reads; a credential's value is never in it. */
  text: string;
}
export interface FileDigest { size: number; sha256: string; crc32: string; text: boolean; findings: ScanFinding[] }

interface Detector { id: string; kind: FindingKind; text: string; pattern: RegExp; textOnly?: boolean; accept?: (match: string) => boolean }
const letterAndDigit = (value: string): boolean => /[A-Za-z]/.test(value) && /\d/.test(value);
/** Credential and login-state patterns. A match blocks the share and names the path; the value is never echoed. */
export const DETECTORS: readonly Detector[] = [
  { id: 'private_key', kind: 'secret', text: '私钥', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'ai_api_key', kind: 'secret', text: 'AI 服务的 API Key 或令牌', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'github_token', kind: 'secret', text: 'GitHub 访问令牌', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { id: 'aws_access_key', kind: 'secret', text: 'AWS 访问密钥', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'google_api_key', kind: 'secret', text: 'Google API Key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'slack_token', kind: 'secret', text: 'Slack 令牌', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}/g },
  { id: 'jwt', kind: 'secret', text: '登录令牌（JWT）', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'booth_session', kind: 'secret', text: 'BOOTH 登录会话', pattern: /_plaza_session_nktz7u\s*[=:]\s*["']?[A-Za-z0-9%+/=._-]{16,}/g },
  { id: 'vrchat_auth', kind: 'secret', text: 'VRChat 登录凭据', pattern: /\bauthcookie_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g },
  { id: 'zhipu_api_key', kind: 'secret', text: '智谱 API Key', pattern: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g },
  { id: 'secret_assignment', kind: 'secret', text: '写在文件里的密码或密钥', textOnly: true,
    pattern: /(?:api[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|passwd|password)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/=.]{20,})/gi,
    accept: match => letterAndDigit(/[:=]\s*["']?([A-Za-z0-9_\-+/=.]{20,})/.exec(match)?.[1] ?? '') },
  { id: 'blueprint_id', kind: 'sensitive', text: 'VRChat Blueprint ID（关联上传账号）', textOnly: true,
    pattern: /\bavtr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g },
];

/** File names that are credentials or login state whatever they contain. */
const SECRET_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/^\.env(?:\..+)?$/i, '环境变量文件（常含密钥）'], [/^id_(?:rsa|dsa|ecdsa|ed25519)$/, 'SSH 私钥'],
  [/\.(?:pem|p12|pfx|jks|keystore|ppk)$/i, '证书、签名密钥或私钥文件'], [/^\.git-credentials$/, 'Git 凭据'], [/^[._]netrc$/, '网络登录凭据'],
  [/^\.pgpass$/, '数据库密码文件'], [/^booth-session$/, 'BOOTH 登录会话'],
];
export function nameFinding(path: string): ScanFinding | undefined {
  const name = basename(path);
  const hit = SECRET_NAMES.find(([pattern]) => pattern.test(name));
  return hit ? { detector: 'credential_file', kind: 'secret', line: null, text: `${hit[1]}：按文件名判定为凭据` } : undefined;
}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** Why a portable path cannot be created on Windows (the receiver may run Harness there); undefined when it can. */
export function windowsNameProblem(path: string): string | undefined {
  for (const segment of path.split('/').filter(Boolean)) {
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) return `“${segment}”含 Windows 不允许的字符`;
    if (/[. ]$/.test(segment)) return `“${segment}”以点或空格结尾，Windows 无法保存`;
    if (RESERVED.test(segment)) return `“${segment}”是 Windows 保留的设备名`;
  }
  return undefined;
}

/** What the detectors compare against on this machine. */
export interface ScanContext {
  /** Values of the credentials Harness itself holds (AVH_HOME/config/secrets, the BOOTH session), in scanner encoding. */
  secrets: string[];
  /** SHA-256 of every file under AVH_HOME/config: a copy of one is never shareable. */
  configHashes: Set<string>;
  /** Local roots whose absolute paths must not travel, in scanner encoding (lower-cased where paths ignore case). */
  roots: string[];
  /** The project's order number, when it has one (it names the customer's order). */
  orderNumber?: string;
  caseInsensitive: boolean;
  /** Stable over the same inputs: a cached scan is reused only while this matches. */
  fingerprint: string;
}
const latin1 = (text: string): string => Buffer.from(text, 'utf8').toString('latin1');
export function scanContext(home: string, roots: LocalRoot[], orderNumber?: string, caseInsensitive = process.platform === 'win32'): ScanContext {
  const config = join(home, 'config');
  const secrets: string[] = [], configHashes = new Set<string>();
  const visit = (directory: string): void => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { visit(path); continue; }
      if (!entry.isFile()) continue;
      let bytes: Buffer;
      try { bytes = readFileSync(path); } catch { continue; }
      if (bytes.length >= 16) configHashes.add(createHash('sha256').update(bytes).digest('hex'));
      if (basename(directory) === 'secrets' || entry.name === 'booth-session') {
        const value = bytes.toString('utf8').trim();
        if (value.length >= 8) secrets.push(latin1(value));
      }
    }
  };
  if (existsSync(config)) visit(config);
  const spelled = rootSpellings(roots).filter(root => root.length > 3).map(latin1).map(root => caseInsensitive ? root.toLowerCase() : root);
  const order = orderNumber && orderNumber.trim().length >= 6 ? orderNumber.trim() : undefined;
  const fingerprint = createHash('sha256').update(canonicalJson({ v: 2, detectors: DETECTORS.map(item => [item.id, item.pattern.source]),
    secrets: secrets.map(value => createHash('sha256').update(value).digest('hex')).sort(), config: [...configHashes].sort(),
    roots: spelled, order: order ?? null, caseInsensitive })).digest('hex');
  return { secrets, configHashes, roots: spelled, ...(order ? { orderNumber: latin1(order) } : {}), caseInsensitive, fingerprint };
}

const CHUNK = 1024 * 1024, OVERLAP = 512, MAX_FINDINGS = 20;
/**
 * Read a file once: size, SHA-256, CRC32 (as 7-Zip prints it), whether it is text, and every finding. Text is the
 * absence of NUL in the first 8 KiB; only text is searched for local paths, Blueprint IDs and the order number, while
 * credential patterns are searched in every byte.
 */
export function digestFile(path: string, context: ScanContext): FileDigest {
  const hash = createHash('sha256');
  let crc = 0, size = 0, text = true, carry = '', carryLines = 0, linesBefore = 0;
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  const add = (finding: ScanFinding): void => {
    const key = `${finding.detector}:${finding.line ?? ''}`;
    if (findings.length >= MAX_FINDINGS || seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };
  const buffer = Buffer.allocUnsafe(CHUNK);
  const fd = openSync(path, 'r');
  try {
    for (let read = readSync(fd, buffer, 0, CHUNK, null); read > 0; read = readSync(fd, buffer, 0, CHUNK, null)) {
      const chunk = buffer.subarray(0, read);
      if (size === 0 && chunk.subarray(0, 8192).includes(0)) text = false;
      hash.update(chunk);
      crc = crc32(chunk, crc);
      size += read;
      const window = carry + chunk.toString('latin1');
      const lineAt = (offset: number): number | null => {
        if (!text) return null;
        let lines = linesBefore - carryLines;
        for (let i = 0; i < offset; i++) if (window.charCodeAt(i) === 10) lines++;
        return lines + 1;
      };
      for (const detector of DETECTORS) {
        if (detector.textOnly && !text) continue;
        detector.pattern.lastIndex = 0;
        for (let match = detector.pattern.exec(window); match; match = detector.pattern.exec(window)) {
          // A match wholly inside the carried-over tail was reported with the previous chunk.
          if (match.index + match[0].length <= carry.length) continue;
          if (detector.accept && !detector.accept(match[0])) continue;
          add({ detector: detector.id, kind: detector.kind, line: lineAt(match.index), text: detector.text });
        }
      }
      const haystack = context.caseInsensitive ? window.toLowerCase() : window;
      for (const secret of context.secrets) {
        const at = haystack.indexOf(context.caseInsensitive ? secret.toLowerCase() : secret);
        if (at >= 0 && at + secret.length > carry.length)
          add({ detector: 'harness_secret', kind: 'secret', line: lineAt(at), text: 'Harness 保存的凭据' });
      }
      if (text) {
        for (const root of context.roots) {
          const at = haystack.indexOf(root);
          if (at >= 0 && at + root.length > carry.length) add({ detector: 'local_path', kind: 'sensitive', line: lineAt(at), text: '本机绝对路径（工程、工作区或用户目录）' });
        }
        for (const pattern of LOCAL_PATH_PATTERNS) {
          const local = new RegExp(pattern.source, 'g');
          for (let match = local.exec(window); match; match = local.exec(window)) {
            if (match.index + match[0].length <= carry.length) continue;
            add({ detector: 'local_path', kind: 'sensitive', line: lineAt(match.index + match[1]!.length), text: '本机绝对路径' });
          }
        }
        if (context.orderNumber) {
          const at = window.indexOf(context.orderNumber);
          if (at >= 0 && at + context.orderNumber.length > carry.length) add({ detector: 'order_number', kind: 'sensitive', line: lineAt(at), text: '订单号' });
        }
      }
      // Keep the tail for patterns that straddle two chunks, and how many lines it holds.
      const tail = window.slice(-OVERLAP);
      let tailLines = 0;
      for (let i = 0; i < tail.length; i++) if (tail.charCodeAt(i) === 10) tailLines++;
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) linesBefore++;
      carry = tail; carryLines = tailLines;
    }
  } finally { closeSync(fd); }
  const sha256 = hash.digest('hex');
  if (context.configHashes.has(sha256)) add({ detector: 'harness_config', kind: 'secret', line: null, text: 'Harness 本机配置目录里的文件副本' });
  return { size, sha256, crc32: (crc >>> 0).toString(16).toUpperCase().padStart(8, '0'), text, findings };
}

/**
 * Digests of the project's files, kept in AVH_HOME/cache between previews and exports. `digest` skips reading a file
 * whose size, modification time and file id are unchanged -- but that key is a guess, not an identity, so it is only
 * good enough to make an interactive preview cheaper. DATA/D6 forbids reusing old evidence for a same-size content
 * change, therefore anything that becomes a package, a manifest or a record goes through `verified`, which reads the
 * content and keeps the cache only as a comparison. A cache only; deleting it is harmless.
 */
export class DigestCache {
  private readonly path: string;
  private readonly entries: Record<string, { key: string; digest: FileDigest }>;
  private dirty = false;
  readonly context: ScanContext;
  constructor(home: string, projectKey: string, context: ScanContext) {
    this.context = context;
    this.path = join(home, 'cache', 'share-scan', `${createHash('sha256').update(projectKey).digest('hex').slice(0, 24)}.json`);
    let loaded: { fingerprint?: string; entries?: DigestCache['entries'] } = {};
    try { loaded = JSON.parse(readFileSync(this.path, 'utf8')) as typeof loaded; } catch { loaded = {}; }
    this.entries = loaded.fingerprint === context.fingerprint && loaded.entries ? loaded.entries : {};
  }
  digest(relative: string, absolute: string): FileDigest {
    const stat = lstatSync(absolute, { bigint: true });
    const key = `${stat.size}:${stat.mtimeNs}:${stat.ino}`;
    const cached = this.entries[relative];
    if (cached?.key === key) return cached.digest;
    const digest = digestFile(absolute, this.context);
    this.entries[relative] = { key, digest };
    this.dirty = true;
    return digest;
  }
  /**
   * The digest of a file that is about to become evidence (a member list, a manifest, a record, a package): the
   * content is read again, and the cached value is a comparison rather than the answer. A file can change without
   * changing its size, modification time or file id, so that key may not decide what is shipped. `stale` says the
   * cached digest disagreed with the content, which means the entry -- and every finding derived from it, including
   * the ones that would have blocked a credential -- was out of date and has now been replaced.
   */
  verified(relative: string, absolute: string): { digest: FileDigest; stale: boolean } {
    const stat = lstatSync(absolute, { bigint: true });
    const key = `${stat.size}:${stat.mtimeNs}:${stat.ino}`;
    const cached = this.entries[relative];
    const digest = digestFile(absolute, this.context);
    const stale = cached !== undefined && cached.digest.sha256 !== digest.sha256;
    if (!cached || cached.key !== key || stale) {
      this.entries[relative] = { key, digest };
      this.dirty = true;
    }
    return { digest, stale };
  }
  save(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const next = `${this.path}.${process.pid}.next`;
      writeFileSync(next, JSON.stringify({ fingerprint: this.context.fingerprint, entries: this.entries }));
      renameSync(next, this.path);
      this.dirty = false;
    } catch { /* a cache that cannot be written only costs time next run */ }
  }
}
