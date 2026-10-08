#!/usr/bin/env node
// Specificity scan (order D-110). The two verification avatars — the reference-photo case A (Milfy body,
// SnowflakeRomance outfit, LUNALICE accessories, GoldenHour hair, Milfy_Eku stockings) and Kaguya B (nine-tailed
// Kaguya body, MMN/ANEMONE/Kitty/Re-Poppin outfits) — are a development set, not a proof of capability. Generic
// tools and criteria must not hard-code the asset names, directory habits, layer names, rig names, material names
// or GUIDs those two projects happen to carry: a rule keyed on one of them silently stops applying to the next
// asset of the same kind. The identity list lives in a committed configuration file (the names are product names,
// not customer data), and every current occurrence is either a real over-fit that gets a mechanism, or an
// occurrence that carries a reviewed reason here.
//
// Scanned (blocking): generic code — src/**, builtin/tools/**, and the process and criteria definitions
// builtin/knowledge/process/**. Body, case and context knowledge is supposed to name the bodies it is about, so it
// is only reported, together with whether the file declares the scope it applies to. Test directories are not
// scanned, and only listed text extensions are read, so Unity's own `.meta` identity files are not either: a
// shipped asset's GUID belongs in its `.meta` by design, which is why a literal guid in a script is the finding
// and a `.meta` is not.
//
// Usage: node tools/specificity-scan.mjs [--root <dir>] [--config <file>] [--json] [--quiet]
//   exit 0 clean · 1 unallowed finding · 2 configuration or read failure (no verdict is issued)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HARNESS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_CONFIG = join(HARNESS_ROOT, 'tools/specificity-scan.config.json');
// Never descended into: build output, dependency trees, caches and repository metadata.
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '__pycache__', 'dist', 'coverage', '.venv', 'venv']);
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ID = /^[a-z][a-z0-9-]*$/;
const ALLOW_ANY_PATTERN = '*';

/** Compile one glob into an anchored regular expression over repository-relative '/'-separated paths. */
export function globToRegExp(glob) {
  if (typeof glob !== 'string' || !glob.length) throw new Error('空路径模式');
  if (glob.startsWith('/') || /^[a-zA-Z]:/.test(glob) || glob.split('/').includes('..'))
    throw new Error(`路径模式必须是仓库内相对路径：${glob}`);
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const character = glob[i];
    if (character === '*') {
      if (glob[i + 1] === '*') {
        // `**/` spans any number of segments including none; a trailing `**` spans the rest.
        if (glob[i + 2] === '/') { source += '(?:[^/]+/)*'; i += 2; } else { source += '.*'; i += 1; }
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * Validate and compile the configuration. Fails closed: an unusable configuration produces no verdict at all,
 * because a scanner that silently scans nothing would report every repository as clean.
 */
export function compileConfig(config) {
  if (!config || config.version !== 1) throw new Error('配置 version 必须为 1');
  const requirePathList = (value, field) => {
    if (!Array.isArray(value) || !value.length) throw new Error(`${field} 必须是非空数组`);
    for (const entry of value) globToRegExp(entry);
    return value.map(entry => entry.replace(/\/+$/, ''));
  };
  const scopes = requirePathList(config.scopes, 'scopes');
  const reportOnlyScopes = requirePathList(config.reportOnlyScopes, 'reportOnlyScopes');
  const extensions = config.extensions;
  if (!Array.isArray(extensions) || !extensions.length || !extensions.every(entry => /^\.[A-Za-z0-9]+$/.test(entry)))
    throw new Error('extensions 必须是非空的扩展名数组');
  const markers = config.knowledgeApplicabilityMarkers;
  if (!Array.isArray(markers) || !markers.every(entry => typeof entry === 'string' && entry.length))
    throw new Error('knowledgeApplicabilityMarkers 必须是字符串数组');
  if (!Array.isArray(config.patterns) || !config.patterns.length) throw new Error('patterns 必须是非空数组');

  const ids = new Set();
  const patterns = config.patterns.map(entry => {
    if (!entry || !ID.test(entry.id ?? '')) throw new Error('pattern id 必须是 kebab-case');
    if (ids.has(entry.id)) throw new Error(`重复的 pattern id：${entry.id}`);
    ids.add(entry.id);
    if (typeof entry.description !== 'string' || !entry.description.trim())
      throw new Error(`pattern ${entry.id} 缺少 description：清单里的每一项都要说明它拦的是哪一类标识`);
    if (typeof entry.regex !== 'string' || !entry.regex.length) throw new Error(`pattern ${entry.id} 的 regex 为空`);
    let regex;
    try { regex = new RegExp(entry.regex, entry.flags ?? 'g'); } catch { throw new Error(`pattern ${entry.id} 的 regex 无法编译`); }
    if (!regex.global) throw new Error(`pattern ${entry.id} 必须带 g 标志`);
    if (regex.test('')) throw new Error(`pattern ${entry.id} 会匹配空串`);
    return { id: entry.id, description: entry.description.trim(), regex };
  });

  const allow = (config.allow ?? []).map(entry => {
    if (!entry || typeof entry.path !== 'string' || !entry.path.length) throw new Error('allow 条目缺少 path');
    if (typeof entry.pattern !== 'string' || !entry.pattern.length) throw new Error(`allow ${entry.path} 缺少 pattern`);
    if (entry.pattern !== ALLOW_ANY_PATTERN && !ids.has(entry.pattern))
      throw new Error(`allow ${entry.path} 引用了未知的 pattern：${entry.pattern}`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 8)
      throw new Error(`allow ${entry.path} 缺少理由：放行必须写明为什么这一处是合理的`);
    let text;
    if (entry.text !== undefined) {
      if (typeof entry.text !== 'string' || !entry.text.length) throw new Error(`allow ${entry.path} 的 text 无效`);
      try { text = new RegExp(entry.text); } catch { throw new Error(`allow ${entry.path} 的 text 无法编译`); }
    }
    return { path: entry.path, glob: globToRegExp(entry.path), pattern: entry.pattern, text, reason: entry.reason.trim(), hits: 0 };
  });
  return { scopes, reportOnlyScopes, extensions, markers, patterns, allow };
}

/** Every file under `root` inside one of `scopes`, as '/'-separated paths relative to `root`. */
export function listScannedFiles(root, scopes, extensions) {
  const files = [];
  const walk = directory => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path); continue; }
      if (!entry.isFile()) continue;
      const relativePath = relative(root, path).split(sep).join('/');
      if (!extensions.some(extension => relativePath.endsWith(extension))) continue;
      try { if (statSync(path).size > MAX_FILE_BYTES) continue; } catch { continue; }
      files.push(relativePath);
    }
  };
  for (const scope of scopes) walk(join(root, ...scope.split('/')));
  return [...new Set(files)].sort();
}

function scopeOf(path, scopes) {
  return scopes.find(scope => path === scope || path.startsWith(scope + '/'));
}

/**
 * Read one file that the scan already listed. Fails closed: a file this check cannot read is not evidence that it
 * is clean, so it ends the run with exit code 2 and no verdict rather than being dropped from the findings. The
 * same reason the empty-scope case is an error applies here — the expensive failure is a scanner that reports a
 * repository clean because it never looked.
 */
function readText(root, file) {
  try { return readFileSync(join(root, ...file.split('/')), 'utf8'); }
  catch (error) { throw new Error(`无法读取 ${file}：${error?.message ?? error}`); }
}

function findHits(root, file, patterns) {
  const text = readText(root, file);
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      const match = pattern.regex.exec(line);
      if (!match) continue;
      hits.push({ path: file, line: index + 1, pattern: pattern.id, text: match[0], context: line.trim().slice(0, 200) });
    }
  }
  return hits;
}

/**
 * Scan the generic areas and report the ones the knowledge body is allowed to name. `clean` is decided by the
 * blocking findings only; the reported knowledge findings never fail the run.
 */
export function scanSpecificity(root, config) {
  const compiled = compileConfig(config);
  const blockingFiles = listScannedFiles(root, compiled.scopes, compiled.extensions);
  const reportedFiles = listScannedFiles(root, compiled.reportOnlyScopes, compiled.extensions);
  // A declared scope that holds no scanned file is a silent no-op: the area was renamed or the extension list
  // stopped covering it, and the run would report clean for a directory it never opened. That is the failure this
  // whole check exists to prevent, so it is not a warning.
  const scopes = Object.fromEntries(compiled.scopes.map(scope =>
    [scope, blockingFiles.filter(file => scopeOf(file, [scope])).length]));
  const empty = compiled.scopes.filter(scope => !scopes[scope]);
  if (empty.length) throw new Error(`扫描区里没有可扫的文件，目录可能被改名或扩展名清单已过时：${empty.join('、')}`);
  const findings = [];
  for (const file of blockingFiles) {
    for (const hit of findHits(root, file, compiled.patterns)) {
      const allowance = compiled.allow.find(entry => entry.glob.test(hit.path)
        && (entry.pattern === ALLOW_ANY_PATTERN || entry.pattern === hit.pattern)
        && (!entry.text || entry.text.test(hit.context)));
      if (allowance) allowance.hits += 1;
      findings.push({ ...hit, scope: scopeOf(hit.path, compiled.scopes),
        disposition: allowance ? 'allowed' : 'blocking', reason: allowance?.reason });
    }
  }
  const knowledge = [];
  for (const file of reportedFiles) {
    const hits = findHits(root, file, compiled.patterns);
    if (!hits.length) continue;
    const text = readText(root, file);
    const appliesTo = compiled.markers.filter(marker => text.includes(marker));
    knowledge.push({ path: file, scope: scopeOf(file, compiled.reportOnlyScopes), patterns: [...new Set(hits.map(hit => hit.pattern))].sort(),
      occurrences: hits.length, appliesTo,
      markerCount: appliesTo.reduce((total, marker) => total + text.split(marker).length - 1, 0) });
  }
  const blocking = findings.filter(finding => finding.disposition === 'blocking');
  return {
    version: 1, root, clean: blocking.length === 0,
    coverage: { blockingFiles: blockingFiles.length, reportOnlyFiles: reportedFiles.length, scopes,
      patterns: compiled.patterns.length, allowances: compiled.allow.length },
    findings, knowledge,
    unusedAllowances: compiled.allow.filter(entry => !entry.hits).map(entry => `${entry.path} :: ${entry.pattern} :: ${entry.reason}`),
    summary: Object.fromEntries(compiled.patterns.map(pattern => [pattern.id, findings.filter(finding => finding.pattern === pattern.id).length])
      .filter(([, count]) => count)),
  };
}

export function readConfig(path = DEFAULT_CONFIG) { return JSON.parse(readFileSync(path, 'utf8')); }

function describe(report) {
  const lines = [];
  const allowed = report.findings.filter(finding => finding.disposition === 'allowed');
  lines.push(`特定性扫描：扫描通用代码 ${report.coverage.blockingFiles} 个文件`
    + `（${Object.entries(report.coverage.scopes).map(([scope, count]) => `${scope}=${count}`).join('、')}）、`
    + `知识正文 ${report.coverage.reportOnlyFiles} 个文件；命中 ${report.findings.length} 处（放行 ${allowed.length} 处，未放行 ${report.findings.length - allowed.length} 处）`);
  if (report.findings.length - allowed.length) {
    lines.push('未放行的命中：');
    for (const finding of report.findings.filter(item => item.disposition === 'blocking'))
      lines.push(`  ${finding.path}:${finding.line}  [${finding.pattern}]  ${finding.text}  — ${finding.context}`);
  }
  for (const scope of [...new Set(allowed.map(finding => finding.path))].sort())
    lines.push(`  放行 ${scope}：${allowed.filter(finding => finding.path === scope).length} 处`);
  if (report.knowledge.length) {
    const declared = report.knowledge.filter(entry => entry.appliesTo.length);
    const undeclared = report.knowledge.filter(entry => !entry.appliesTo.length);
    lines.push(`知识正文里的开发集标识（只报告，不阻断）：${report.knowledge.length} 个文件、`
      + `${report.knowledge.reduce((total, entry) => total + entry.occurrences, 0)} 处；其中 ${undeclared.length} 个文件未声明适用条件`);
    for (const entry of undeclared)
      lines.push(`  未声明适用条件：${entry.path}  ${entry.occurrences} 处 [${entry.patterns.join(', ')}]`);
    lines.push(`  已声明：${declared.length} 个文件（${declared.map(entry => `${entry.path} ${entry.appliesTo.join('/')}×${entry.markerCount}`).join('、')}）`);
  }
  if (report.unusedAllowances.length) lines.push(`未被命中的放行条目（${report.unusedAllowances.length} 条，可能是清单漂移）：`
    + report.unusedAllowances.map(entry => `\n  ${entry}`).join(''));
  return lines.join('\n');
}

export function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (['--json', '--quiet'].includes(name)) { args[name.slice(2)] = true; continue; }
    if (!['--root', '--config'].includes(name) || !argv[i + 1]) throw new Error('用法：specificity-scan [--root <目录>] [--config <文件>] [--json] [--quiet]');
    args[name.slice(2)] = argv[i + 1]; i += 1;
  }
  const root = resolve(args.root ?? HARNESS_ROOT);
  const report = scanSpecificity(root, readConfig(args.config ?? DEFAULT_CONFIG));
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (!args.quiet) process.stdout.write(describe(report) + '\n');
  return report.clean ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    console.error(`特定性扫描未能给出结论：${error?.message ?? error}`);
    process.exitCode = 2;
  }
}

export { HARNESS_ROOT, DEFAULT_CONFIG };
