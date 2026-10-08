import { commandFor, hostPlatform } from '../host-platform.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import type { ImportConfig, Review, Source } from './types.ts';
import { fileFingerprint, inside, projectFile, sha256, snapshot } from './scan.ts';
import { localMinute } from './time.ts';

function tool(root: string | undefined, rel: string): string | undefined {
  if (!root) return undefined;
  const path = join(root, rel);
  return existsSync(path) ? path : undefined;
}
function run(exe: string, args: string[]): { ok: boolean; missing: boolean; output: string; exitCode: number | string } {
  // On Windows a command found on PATH may be a .cmd shim, which Node starts only through a shell; start what it runs.
  const [program, ...prefix] = process.platform === 'win32' ? commandFor(exe) : [exe];
  try { return { ok: true, missing: false, output: execFileSync(program!, [...prefix, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    // Python on a Chinese Windows otherwise reads and writes text in the ANSI code page.
    ...(process.platform === 'win32' ? { env: { ...process.env, PYTHONUTF8: '1' } } : {}) }).trim(), exitCode: 0 }; }
  catch (e) {
    const err = e as { code?: string; status?: number; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return { ok: false, missing: err.code === 'ENOENT', output: `${String(err.stdout ?? '')}\n${String(err.stderr ?? '')}`.trim(), exitCode: err.status ?? err.code ?? 'unknown' };
  }
}
function review(id: string, status: Review['status'], reason: string, evidence: Source[] = []): Review { return { id, status, reason, evidence }; }
function cleanupAction(path: string, action?: string): string {
  if (action === 'delete') return `删除 ${path}`;
  if (action?.startsWith('edit_json_remove_')) return `编辑 ${path}，删除依赖 ${action.slice('edit_json_remove_'.length)}`;
  if (action === 'git_checkout_baseline') return `将 ${path} 恢复到 Git 基线`;
  if (action === 'manual') return `人工检查并清理 ${path}`;
  return action ? `${path}：按审计动作 ${action} 处理` : `${path}：核实清理动作`;
}
function expandSimpleBraces(line: string): string[] {
  let depth = 0;
  for (const char of line) {
    if (char === '{' && ++depth > 1) return [line];
    if (char === '}') depth--;
  }
  const match = /\{([^{}]*,[^{}]*)\}/.exec(line);
  if (!match) return [line];
  return match[1]!.split(',').flatMap(part => expandSimpleBraces(line.slice(0, match.index) + part + line.slice(match.index + match[0].length)));
}
export function collectArtifactClaims(project: string, record: { text: string; file: string } | undefined, config: ImportConfig): { path: string; source: string }[] {
  const result: { path: string; source: string }[] = [];
  const seen = new Set<string>();
  if (record) {
    for (const [index, original] of record.text.split(/\r?\n/).entries()) {
      for (const line of expandSimpleBraces(original)) {
        if (!/已生成|已输出|产物|交付包|已打包|已写入|存在/.test(line)) continue;
        const quoted: string[] = [];
        let unquoted = line.replace(/`([^`]+)`|"([^"]+)"|“([^”]+)”|'([^']+)'|\[[^\]]+\]\(([^)]+)\)/g, (...match: string[]) => {
          quoted.push((match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]!).split(/[（）：、；，。「」＋]/)[0]!);
          return ' '.repeat(match[0]!.length);
        });
        const prefixed: string[] = [];
        for (const prefix of [...config.artifactPathPrefixes].sort((a, b) => b.length - a.length)) {
          const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp(`${escaped}[^（）：、；，。「」＋,;()\\[\\]"'“”\x60]+?\\.(?:unitypackage|unity|prefab|asset|png|jpe?g|fbx|json|zip|7z|blend|psd|txt|md)`, 'gi');
          unquoted = unquoted.replace(pattern, match => { prefixed.push(match.trim()); return ' '.repeat(match.length); });
        }
        const bare = unquoted.split(/[\s（）：、；，。「」＋,;()\[\]`]+/).filter(word =>
          config.artifactPathPrefixes.some(prefix => word.startsWith(prefix)) || /\.(?:unitypackage|unity|prefab|asset|png|jpg|fbx|json|zip|7z|blend|psd|txt|md)$/i.test(word));
        const paths = [...quoted, ...prefixed, ...bare];
        for (const path of paths.map(p => p.trim())) {
          if (path.includes('://') || seen.has(path) || !pathLike(path, config)) continue;
          seen.add(path); result.push({ path, source: `${record.file}:${index + 1}` });
        }
      }
    }
  }
  for (const path of config.deliveryArchives ?? []) {
    if (!seen.has(path) && pathLike(path, config)) result.push({ path, source: 'config.deliveryArchives' });
  }
  return result;
}
function pathLike(path: string, config: ImportConfig): boolean {
  return /\.(?:unitypackage|unity|prefab|asset|png|jpe?g|fbx|json|zip|7z|blend|psd|txt|md)$/i.test(path)
    || config.artifactPathPrefixes.some(prefix => path.startsWith(prefix) &&
      (path.includes('/') || (process.platform === 'win32' && path.includes('\\'))));
}
function projectRootClaim(project: string, claim: string): boolean {
  if (claim.startsWith('/') || claim.includes('\\') || claim.split('/').some(part => !part || part === '.' || part === '..')) return false;
  const parts = claim.split('/');
  if (parts.length < 2) return false;
  const first = parts[0]!;
  return ['Assets', 'Packages', 'ProjectSettings'].includes(first) ||
    readdirSync(project, { withFileTypes: true }).some(entry => entry.name === first && entry.isDirectory());
}
function findPath(project: string, workspace: string, roots: string[], claim: string, archive = false): string | undefined {
  const searchRoots = [project, workspace, ...roots];
  for (const [index, root] of searchRoots.entries()) {
    if (!existsSync(root)) continue;
    const absoluteRoot = realpathSync(root);
    const candidates = [claim, ...(archive ? [basename(claim)] : [])];
    for (const candidate of candidates) {
      const path = resolve(absoluteRoot, candidate);
      if (inside(absoluteRoot, path) && existsSync(path) && inside(absoluteRoot, realpathSync(path))) return path;
    }
    if (archive && index >= 2) {
      const target = basename(claim);
      const visit = (dir: string): string | undefined => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isFile() && entry.name === target) return path;
          if (entry.isDirectory()) { const found = visit(path); if (found) return found; }
        }
      };
      const found = visit(absoluteRoot);
      if (found) return found;
    }
  }
}
function archiveMembers(path: string): Set<string> {
  const listing = run(hostPlatform.toolCommand('7z'), ['l', '-slt', path]);
  if (!listing.ok) return new Set();
  const entries = listing.output.split(/-{10,}\r?\n/).slice(1).join('\n');
  return new Set([...entries.matchAll(/^Path = (.+)$/gm)].map(match => match[1]!.replaceAll('\\', '/')));
}
function containsMember(members: Set<string>, claim: string): boolean {
  const name = claim.replaceAll('\\', '/');
  return members.has(name) || (name === basename(name) && [...members].some(member => basename(member) === name));
}
function archiveTestReason(result: { ok: boolean; output: string; exitCode: number | string }): string {
  if (result.ok) {
    const files = /\bFiles:\s*([\d,]+)/i.exec(result.output)?.[1];
    const size = /\bSize:\s*([\d,]+)/i.exec(result.output)?.[1];
    return `7z t 通过${files ? `；文件数：${files}` : ''}${size ? `；大小：${size} B` : ''}`;
  }
  const error = [...result.output.matchAll(/^.*ERROR:.*$/gim)].at(-1)?.[0]?.trim();
  return `7z t 失败（退出码 ${result.exitCode}）：${error ?? result.output.slice(0, 200)}`;
}
export function runReviews(project: string, workspace: string, config: ImportConfig, packages: Record<string, string>, projectBaseline: Record<string, string> | undefined, claims: { path: string; source: string }[], archiveNames: string[] = []): Review[] {
  const reviews: Review[] = [];
  const fingerprintScript = tool(config.toolRoot, 'project_fingerprint.py');
  if (!fingerprintScript) reviews.push(review('fingerprint', 'not_run', 'project_fingerprint.py unavailable in configured toolRoot'));
  else {
    const temp = mkdtempSync(join(tmpdir(), 'avh-import-'));
    try {
      const output = join(temp, 'fingerprint.json');
      const result = run(hostPlatform.toolCommand('python'), [fingerprintScript, project, '--out', output]);
      let valid = false;
      if (result.ok && existsSync(output)) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(output, 'utf8'));
          valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        } catch { /* invalid output is a failed check */ }
      }
      reviews.push(result.missing ? review('fingerprint', 'not_run', `python3 unavailable: ${result.output}`) : valid
        ? review('fingerprint', 'pass', 'external fingerprint produced JSON', [{ source: relative(config.toolRoot!, fingerprintScript), detail: `SHA256 ${sha256(readFileSync(output))}` }])
        : review('fingerprint', 'fail', `fingerprint failed (exit ${result.exitCode}): ${result.output.slice(0, 200)}`));
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  const vpmScript = tool(config.toolRoot, 'vpm_baseline_check.py');
  const globalDifference = config.packageBaseline &&
    Object.entries(packages).some(([name, version]) => config.packageBaseline![name] !== version)
    ? '; global baseline differs (information only)' : '';
  if (config.packageBaseline) {
    const differences = Object.keys(packages).sort().filter(name => packages[name] !== config.packageBaseline![name])
      .map(name => `${name}: locked=${packages[name] ?? 'missing'}, toolchain=${config.packageBaseline![name] ?? 'missing'}`);
    const unusedCount = Object.keys(config.packageBaseline).filter(name => !Object.hasOwn(packages, name)).length;
    reviews.push(review('toolchain_baseline', 'pass', `${differences.join('; ') || '与工具链基准一致'}；基准中本工程未用：${unusedCount} 项`,
      differences.map(detail => ({ source: 'config:import.packageBaseline', detail }))));
  }
  if (!vpmScript) reviews.push(review('vpm_baseline', 'not_run', 'vpm_baseline_check.py unavailable in configured toolRoot'));
  else if (!projectBaseline || Object.keys(projectBaseline).length === 0)
    reviews.push(review('vpm_baseline', 'not_run', `project baseline unavailable${globalDifference}`));
  else {
    const result = run(hostPlatform.toolCommand('python'), [vpmScript, project]);
    const differences = Object.entries(projectBaseline).filter(([name, version]) => packages[name] !== version)
      .map(([name, version]) => `${name}: locked=${packages[name] ?? 'missing'}, baseline=${version}`);
    for (const [name, version] of Object.entries(packages))
      if (!Object.hasOwn(projectBaseline, name)) differences.push(`${name}: locked=${version}, baseline=missing`);
    reviews.push(result.missing ? review('vpm_baseline', 'not_run', `python3 unavailable: ${result.output}`)
      : !result.ok ? review('vpm_baseline', 'fail', `vpm tool failed (exit ${result.exitCode}): ${result.output.slice(0, 200)}`)
      : differences.length ? review('vpm_baseline', 'fail', differences.join('; '), [{ source: 'Packages/vpm-manifest.json:1', detail: 'locked versions' }])
      : review('vpm_baseline', 'pass', `project baseline matches locked versions; tool ran${globalDifference}`, [
        { source: 'Packages/vpm-manifest.json:1', detail: 'locked versions' },
        { source: 'tool:vpm_baseline_check.py', detail: result.output.slice(0, 200) },
      ]));
  }
  const discovered: typeof claims = [];
  const terms = archiveNames.filter(Boolean).map(name => name.toLowerCase());
  for (const root of config.exportRoots ?? []) {
    if (!existsSync(root)) continue;
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && /\.(?:7z|zip)$/i.test(entry.name) && terms.some(name => entry.name.toLowerCase().includes(name)))
          discovered.push({ path, source: `exportRoot:${root}` });
      }
    };
    visit(realpathSync(root));
  }
  const concreteClaims = claims.filter(claim => !/\*|\?|…|\.\.\./.test(claim.path));
  const archives = [...concreteClaims.filter(c => /\.(?:7z|zip)$/i.test(c.path)), ...discovered];
  type ArchiveOutcome = { claim: { path: string; source: string }; status: Review['status']; reason: string; members: Set<string> };
  const outcomes: ArchiveOutcome[] = [];
  const tested = new Map<string, ArchiveOutcome>();
  const unresolved: typeof archives = [];
  for (const claim of archives) {
    const path = findPath(project, workspace, config.exportRoots ?? [], claim.path, true);
    if (!path) { unresolved.push(claim); continue; }
    const absolute = realpathSync(path);
    if (tested.has(absolute)) continue;
    const limit = config.maxDeliveryArchiveBytes;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('maxDeliveryArchiveBytes must be a non-negative safe integer');
    const stat = statSync(absolute);
    const size = stat.size;
    const members = archiveMembers(absolute);
    const result = limit !== undefined && size > limit ? undefined : run(hostPlatform.toolCommand('7z'), ['t', absolute]);
    const outcome: ArchiveOutcome = { claim, members,
      status: !result ? 'not_run' : result.missing ? 'not_run' : result.ok ? 'pass' : 'fail',
      reason: !result ? `archive size ${size} bytes exceeds configured limit ${limit} bytes; 7z t skipped`
        : result.missing ? '7z unavailable' : archiveTestReason(result) };
    tested.set(absolute, outcome); outcomes.push(outcome);
  }
  const memberOf = new Map<string, ArchiveOutcome>();
  for (const claim of unresolved) {
    const outer = outcomes.find(outcome => containsMember(outcome.members, claim.path));
    if (outer) memberOf.set(claim.path, outer);
    else outcomes.push({ claim, status: 'unknown', reason: '记录里提到、现在不存在（可能已清理）', members: new Set() });
  }
  const artifactEvidence: Source[] = []; const unknown: Source[] = []; const missing: string[] = []; const unverified: string[] = [];
  for (const claim of concreteClaims) {
    const path = findPath(project, workspace, config.exportRoots ?? [], claim.path, /\.(?:7z|zip)$/i.test(claim.path));
    if (!path) {
      const outer = memberOf.get(claim.path);
      if (!outer) {
        if (projectRootClaim(project, claim.path)) unknown.push({ source: claim.source, detail: claim.path });
      } else {
        artifactEvidence.push({ source: claim.source, detail: `${claim.path} 在 ${outer.claim.path} 内` });
        if (outer.status === 'fail') missing.push(`${claim.path} (outer archive failed)`);
        if (outer.status === 'not_run') unverified.push(`${claim.path} (outer archive not tested)`);
      }
      continue;
    }
    const kind = statSync(path);
    if (!kind.isFile() && !kind.isDirectory()) { missing.push(`${claim.path} (unsupported type)`); continue; }
    const fingerprint = kind.isFile() ? fileFingerprint(path, config.snapshotSampleThresholdBytes)
      : { value: snapshot(path, [], config.snapshotSampleThresholdBytes).hash, sampled: false };
    artifactEvidence.push({ source: claim.source, detail: `${claim.path} ${fingerprint.sampled ? 'sampled fingerprint' : 'SHA256'} ${fingerprint.value}` });
  }
  reviews.push(concreteClaims.length === 0 ? review('artifacts', 'not_run', 'no explicit artifact path claims found')
    : review('artifacts', missing.length ? 'fail' : unknown.length ? 'unknown' : unverified.length ? 'not_run' : 'pass',
      missing.length ? `unsupported or failed: ${missing.join('; ')}` : unknown.length ? `unresolved paths: ${unknown.map(x => `${x.detail} (${x.source})`).join('; ')}` : unverified.length ? `unverified: ${unverified.join('; ')}` : 'all claimed files exist or are listed within tested archives', artifactEvidence));
  reviews.at(-1)!.missingClaims = unknown;
  if (archives.length === 0) reviews.push(review('delivery_archives', 'not_run', '导出目标中未找到与本工程匹配的交付包'));
  else {
    reviews.push(review('delivery_archives', outcomes.some(x => x.status === 'fail') ? 'fail' : outcomes.some(x => x.status === 'not_run') ? 'not_run' : outcomes.some(x => x.status === 'pass') ? 'pass' : 'unknown',
      [...outcomes.map(x => `${x.claim.path}: ${x.status} ${x.reason}`),
        ...[...memberOf.entries()].map(([name, outer]) => `${name}: 在 ${outer.claim.path} 内; ${outer.status}`)].join('; '),
      [...outcomes.map(x => ({ source: x.claim.source, detail: x.claim.path })),
        ...unresolved.filter(x => memberOf.has(x.path)).map(x => ({ source: x.source, detail: `${x.path} 在 ${memberOf.get(x.path)!.claim.path} 内` }))]));
    reviews.at(-1)!.archiveDetails = [...tested.entries()].map(([path, outcome]) => ({ path, size: statSync(path).size,
      modified: localMinute(statSync(path).mtime), status: outcome.status, reason: outcome.reason }));
  }
  const leftovers = config.forbiddenDeliveryPaths.filter(path => existsSync(projectFile(project, path)));
  const manifest = projectFile(project, 'Packages/manifest.json');
  if (existsSync(manifest)) {
    try { if (Object.hasOwn((JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: object }).dependencies ?? {}, 'com.coplaydev.unity-mcp')) leftovers.push('Packages/manifest.json: com.coplaydev.unity-mcp'); }
    catch { leftovers.push('Packages/manifest.json: unparseable'); }
  }
  const strip = tool(config.toolRoot, '审查/perception/strip_audit.py');
  if (!strip) reviews.push(review('delivery_cleanup', 'not_run', `strip_audit.py unavailable in configured toolRoot; path scan found ${leftovers.join(', ') || 'none'}`));
  else {
    const result = run(hostPlatform.toolCommand('python'), [strip, '--project', project, '--check', '--json']);
    const jsonStart = [...result.output.matchAll(/\{\s*"project"\s*:/g)].at(-1)?.index ?? -1;
    let findings: { path?: string; strip?: boolean; status?: string; action?: string }[] | undefined;
    try { findings = (JSON.parse(result.output.slice(jsonStart)) as { findings?: typeof findings }).findings; } catch { /* malformed JSON */ }
    if (Array.isArray(findings)) {
      const present = findings.filter(f => f.strip === true && f.status === 'present' && f.path);
      const undecidable = findings.filter(f => f.strip === true && f.status === 'undecidable' && f.path);
      const cleanup = review('delivery_cleanup', present.length ? 'fail' : undecidable.length ? 'unknown' : 'pass',
        [present.length ? `待清理：${present.map(f => cleanupAction(f.path!, f.action)).join('；')}` : '', undecidable.length ? `无法只读判定（需人工或 Unity 核实）：${undecidable.map(f => cleanupAction(f.path!, f.action)).join('；')}` : ''].filter(Boolean).join('；') || '未发现需清理路径',
        present.map(f => ({ source: 'tool:strip_audit.py', detail: cleanupAction(f.path!, f.action) })));
      cleanup.needsVerification = undecidable.map(f => ({ source: 'tool:strip_audit.py', detail: cleanupAction(f.path!, f.action) }));
      reviews.push(cleanup);
    } else reviews.push(review('delivery_cleanup', result.missing ? 'not_run' : 'unknown',
      `strip audit JSON 无法解析（退出码 ${result.exitCode}）：${result.output.slice(0, 200)}`,
      leftovers.map(path => ({ source: 'project:path-scan', detail: path }))));
  }
  return reviews;
}
