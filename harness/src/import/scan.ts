import { listProcesses } from '../exec/windows-helper.ts';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, globSync, openSync, readSync, readlinkSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ImportConfig, LedgerItem, PendingDecision, ProjectKind, RelatedProgram, Source, TimelineItem } from './types.ts';
import { hostPlatform } from '../host-platform.ts';
import { HOST_GIT_SAFETY } from '../exec/git-scan.ts';
import { ordinal } from '../pack-hash.ts';

export function inside(root: string, path: string): boolean {
  return hostPlatform.within(root, path);
}
export function projectFile(root: string, rel: string): string {
  if (isAbsolute(rel) || !inside(root, resolve(root, rel))) throw new Error(`Unsafe project path: ${rel}`);
  const path = resolve(root, rel);
  if (existsSync(path) && !inside(root, realpathSync(path))) throw new Error(`Project path escapes via symlink: ${rel}`);
  return path;
}
export function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export const DEFAULT_SNAPSHOT_SAMPLE_THRESHOLD_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
export function fileFingerprint(path: string, sampleThresholdBytes = DEFAULT_SNAPSHOT_SAMPLE_THRESHOLD_BYTES): { value: string; sampled: boolean } {
  if (!Number.isSafeInteger(sampleThresholdBytes) || sampleThresholdBytes < 0)
    throw new Error('snapshotSampleThresholdBytes must be a non-negative safe integer');
  const info = statSync(path, { bigint: true });
  const sampled = info.size > BigInt(sampleThresholdBytes);
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  const hashRange = (start: bigint, length: bigint): string => {
    const hash = createHash('sha256');
    let offset = 0n;
    while (offset < length) {
      const count = Number(length - offset > BigInt(buffer.length) ? BigInt(buffer.length) : length - offset);
      const bytes = readSync(fd, buffer, 0, count, start + offset);
      if (bytes === 0) throw new Error(`File changed during fingerprint: ${path}`);
      hash.update(buffer.subarray(0, bytes));
      offset += BigInt(bytes);
    }
    return hash.digest('hex');
  };
  try {
    if (!sampled) return { value: hashRange(0n, info.size), sampled: false };
    const sampleSize = info.size < BigInt(CHUNK_BYTES) ? info.size : BigInt(CHUNK_BYTES);
    const head = hashRange(0n, sampleSize);
    const tail = hashRange(info.size - sampleSize, sampleSize);
    return { value: `sampled:size=${info.size};mtimeNs=${info.mtimeNs};ino=${info.ino};headSha256=${head};tailSha256=${tail}`, sampled: true };
  } finally { closeSync(fd); }
}
export function snapshot(root: string, ignored: string[], sampleThresholdBytes = DEFAULT_SNAPSHOT_SAMPLE_THRESHOLD_BYTES): { hash: string; files: Record<string, string>; sampledFiles: string[] } {
  const files: Record<string, string> = {};
  const sampledFiles: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => ordinal(a.name, b.name))) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) {
        if (!ignored.includes(entry.name)) walk(path);
      } else if (entry.isFile()) {
        const fingerprint = fileFingerprint(path, sampleThresholdBytes);
        files[rel] = fingerprint.value;
        if (fingerprint.sampled) sampledFiles.push(rel);
      }
      else if (entry.isSymbolicLink()) files[rel] = `symlink:${readlinkSync(path)}`;
      else files[rel] = `special:${entry.name}`;
    }
  }
  walk(root);
  return { hash: sha256(JSON.stringify(files)), files, sampledFiles };
}
export function locateProject(workspacePath: string, projectPath: string): { workspace: string; project: string } {
  const workspace = realpathSync(workspacePath);
  const project = realpathSync(projectPath);
  if (!inside(workspace, project) || workspace === project) throw new Error('Project must be a directory inside workspace');
  if (!existsSync(join(project, 'ProjectSettings', 'ProjectVersion.txt'))) throw new Error('Missing ProjectSettings/ProjectVersion.txt');
  return { workspace, project };
}
export function detectKind(project: string, workspace: string, config: ImportConfig, explicit?: ProjectKind): { kind: ProjectKind; orderNumber?: string } {
  const name = basename(project);
  const client = new RegExp(config.clientPattern).exec(name);
  const history = inside(join(workspace, config.historicalDir), project) && project !== join(workspace, config.historicalDir);
  const candidates: ProjectKind[] = [];
  if (history) candidates.push('history');
  if (config.sampleNames.includes(name)) candidates.push('sample');
  if (client) candidates.push('client');
  if (new RegExp(config.privatePattern).test(name)) candidates.push('private');
  if (explicit && !['client', 'private', 'history', 'sample'].includes(explicit)) throw new Error(`Invalid kind: ${explicit}`);
  if (!explicit && candidates.length !== 1) throw new Error(`Cannot unambiguously determine project kind for ${name}; provide kind`);
  return { kind: explicit ?? candidates[0]!, ...(client ? { orderNumber: `COMM-${client[1]}` } : {}) };
}
function lines(text: string): string[] { return text.split(/\r?\n/); }
export function parseRecord(text: string, file: string, recentCount: number): {
  header: { fields: Record<string, string | string[]>; source?: string; raw?: string };
  timeline: { count: number; recent: TimelineItem[] }; allTimeline: TimelineItem[]; gaps: Source[]; unparsedRecords: Source[];
} {
  const ls = lines(text);
  const start = ls.findIndex(line => line.includes('<!-- 状态头:BEGIN'));
  const end = start < 0 ? -1 : ls.findIndex((line, i) => i > start && line.includes('<!-- 状态头:END'));
  const fields: Record<string, string | string[]> = {};
  const gaps: Source[] = [];
  const unparsedRecords: Source[] = [];
  if (start >= 0 && end < 0) gaps.push({ source: `${file}:${start + 1}`, detail: '状态头缺少 END，保留原文，字段未知' });
  if (end >= 0) {
    let active = '';
    for (let i = start + 1; i < end; i++) {
      const match = /^- \*\*(.+?)\*\*：(.*)$/.exec(ls[i]!);
      if (match) { active = match[1]!; fields[active] = match[2]!.trim() || []; }
      else if (active && /^\s{2,}\S/.test(ls[i]!)) {
        const old = fields[active]!;
        fields[active] = [...(Array.isArray(old) ? old : [old]), ls[i]!.trim()];
      }
    }
  }
  const time = start >= 0 && end >= 0 ? /^## 当前状态（(\d{4}-\d{2}-\d{2} \d{2}:\d{2})）/.exec(ls.slice(start, end).find(line => line.startsWith('## 当前状态')) ?? '')?.[1] : undefined;
  const titleLine = start >= 0 && end >= 0 ? ls.findIndex((line, i) => i > start && i < end && line.startsWith('## 当前状态')) : -1;
  const header = { fields, ...(start >= 0 ? { source: `${file}:${(titleLine >= 0 ? titleLine : start) + 1}`, raw: ls.slice(start, end < 0 ? undefined : end + 1).join('\n') } : {}), ...(time ? { time } : {}) };
  const items: TimelineItem[] = [];
  const heads = ls.flatMap((line, i) => /^## \d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})? · /.test(line) ? [i] : []);
  for (let j = 0; j < heads.length; j++) {
    const from = heads[j]!; const to = heads[j + 1] ?? ls.length;
    const match = /^## (\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?) · (.+?)\s*$/.exec(ls[from]!);
    const raw = ls.slice(from, to).join('\n');
    if (!match) { unparsedRecords.push({ source: `${file}:${from + 1}`, detail: `时间线条目无法解析，原文：${raw}` }); continue; }
    const itemFields: Record<string, string> = {};
    for (let i = from + 1; i < to; i++) {
      const field = /^- (?:\*\*)?(执行|改了|做了什么|怎么验(?: \/ 结果)?|结果|未决|待蒸馏)(?:\*\*)?：(.*)$/.exec(ls[i]!);
      if (field) itemFields[field[1]!] = field[2]!.trim();
    }
    const actorMatch = /^(.*)（([^（）]*)）$/.exec(match[2]!.trim());
    items.push({ date: match[1]!, title: actorMatch?.[1] ?? match[2]!, actor: actorMatch?.[2] ?? itemFields['执行'] ?? '', source: `${file}:${from + 1}`, fields: itemFields, raw });
  }
  return { header, timeline: { count: heads.length, recent: items.slice(-recentCount) }, allTimeline: items, gaps, unparsedRecords };
}
export function parseLedger(text: string, file: string, archived = false, modifiedMs?: number): LedgerItem[] {
  const ls = lines(text); const items: LedgerItem[] = []; let section = '';
  for (let i = 0; i < ls.length; i++) {
    if (/^#{1,6} /.test(ls[i]!)) section = ls[i]!;
    const match = /^\s*- \[([ x~-])\]\s*(.*)$/.exec(ls[i]!);
    if (!match) continue;
    const next = ls.findIndex((line, n) => n > i && (/^\s*- \[[ x~-]\]/.test(line) || /^#{1,6} /.test(line)));
    const raw = ls.slice(i, next < 0 ? ls.length : next).join('\n');
    const body = match[2]!.trim(); const first = /^([^\s—]+)/.exec(body)?.[1];
    const structured = /\s+—\s+负责：/.test(body);
    const id = first && (structured || (/^[A-Za-z][A-Za-z0-9-]*$/.test(first) && /[-0-9]/.test(first))) ? first : `unknown-${i + 1}`;
    const notes = ls.slice(i + 1, next < 0 ? ls.length : next).map((line, offset) => ({ line, number: i + offset + 2 }))
      .filter(entry => /^\s{2,}(?:[-*]\s*)?\S/.test(entry.line));
    const last = notes.at(-1);
    items.push({ id, text: body || raw, status: match[1] === 'x' ? 'done' : match[1] === '-' ? 'dropped' : match[1] === '~' ? 'in_progress' : 'open',
      source: `${file}:${i + 1}`, sources: [`${file}:${i + 1}`], archived: archived || /归档|停滞/.test(section), raw, modifiedMs,
      ...(last ? { latestNote: { source: `${file}:${last.number}`, detail: last.line.trim().replace(/^[-*]\s*/, '') } } : {}) });
  }
  return items;
}
/** Keep the most recently modified source's status, while retaining every citation. */
export function mergeLedger(local: LedgerItem[], external: LedgerItem[]): { ledger: LedgerItem[]; externalLedger: LedgerItem[] } {
  const groups = new Map<string, LedgerItem[]>();
  for (const item of [...local, ...external]) {
    const key = item.id.startsWith('unknown-') ? `source:${item.source}` : `id:${item.id}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const ledger: LedgerItem[] = []; const externalLedger: LedgerItem[] = [];
  for (const items of groups.values()) {
    const latest = [...items].sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0) || Number(a.archived) - Number(b.archived))[0]!;
    const merged = { ...latest, archived: items.every(item => item.archived), sources: [...new Set(items.flatMap(item => item.sources))] };
    if (items.some(item => local.includes(item))) ledger.push(merged);
    else externalLedger.push(merged);
  }
  return { ledger, externalLedger };
}
export function parseLedgerDecisions(text: string, file: string): Source[] {
  const result: Source[] = []; let decided = false;
  for (const [index, line] of lines(text).entries()) {
    if (/^#{1,6} /.test(line)) { decided = /已拍板/.test(line); continue; }
    if (decided && /^\s*[-*] \S/.test(line) && !/^\s*- \[[ x~-]\]/.test(line))
      result.push({ source: `${file}:${index + 1}`, detail: line.replace(/^\s*[-*] /, '') });
  }
  return result;
}
export function readNamed(root: string, names: string[]): { text: string; file: string } | undefined {
  for (const name of names) {
    const path = projectFile(root, name);
    if (existsSync(path)) return { text: readFileSync(path, 'utf8'), file: name };
  }
  return undefined;
}
export function mentionCount(text: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^[\x00-\x7f]+$/.test(name)
    ? [...text.matchAll(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gi'))].length
    : text.split(name).length - 1;
}
function mentions(text: string, name: string): boolean { return mentionCount(text, name) > 0; }
function projectNames(project: string, config: ImportConfig, orderNumber?: string): string[] {
  return [basename(project), orderNumber, ...(config.projectAliases ?? [])].filter((v): v is string => !!v);
}
function externalDirs(workspace: string, config: ImportConfig): string[] {
  const result = new Set<string>();
  for (const pattern of config.externalLedgerDirs) {
    const wildcard = pattern.endsWith('*'); const prefix = wildcard ? pattern.slice(0, -1) : pattern;
    for (const entry of readdirSync(workspace, { withFileTypes: true }))
      if (entry.isDirectory() && (wildcard ? entry.name.startsWith(prefix) : entry.name === prefix)) result.add(join(workspace, entry.name));
  }
  return [...result];
}
export function externalLedger(workspace: string, project: string, config: ImportConfig, orderNumber?: string): LedgerItem[] {
  const own = basename(project);
  const known = { ...(config.knownProjects ?? {}), [own]: projectNames(project, config, orderNumber) };
  for (const members of Object.values(config.aliasGroups ?? {}))
    for (const member of members) known[member] ??= [member];
  const result: LedgerItem[] = [];
  function visit(dir: string): void {
    // Keep the historical 任务账本_* matches under the default 账本*.md pattern.
    const files = new Set(config.externalLedgerFiles.flatMap(pattern =>
      globSync(pattern === '账本*.md' ? '*账本*.md' : pattern, { cwd: dir })));
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && files.has(entry.name)) {
        const rel = relative(workspace, path).split(sep).join('/');
        for (const item of parseLedger(readFileSync(path, 'utf8'), rel, rel.includes('/_归档/'), statSync(path).mtimeMs)) {
          const namedProjects = Object.entries(known).filter(([, names]) => names.some(name => mentions(item.text, name))).map(([name]) => name);
          const groupMembers = namedProjects.length ? [] : Object.entries(config.aliasGroups ?? {}).filter(([name]) => mentions(item.text, name)).flatMap(([, members]) => members);
          const related = [...new Set([...namedProjects, ...groupMembers])];
          if (related.includes(own)) result.push({ ...item, relatedProjects: related.length > 1 ? related : undefined });
        }
      }
    }
  }
  for (const dir of externalDirs(workspace, config)) visit(dir);
  return result;
}
function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}
function globFiles(workspace: string, glob: string): string[] {
  if (isAbsolute(glob) || glob.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe decision table glob: ${glob}`);
  return globSync(glob, { cwd: workspace }).map(rel => join(workspace, rel))
    .filter(path => inside(workspace, realpathSync(path)) && statSync(path).isFile()).sort();
}
export function decisionTables(workspace: string, project: string, config: ImportConfig, orderNumber?: string): PendingDecision[] {
  const names = projectNames(project, config, orderNumber);
  const result: PendingDecision[] = [];
  for (const table of config.decisionTables ?? []) for (const path of globFiles(workspace, table.glob)) {
    const file = relative(workspace, path).split(sep).join('/'); const ls = lines(readFileSync(path, 'utf8'));
    for (let i = 0; i + 1 < ls.length; i++) {
      if (!/^\s*\|/.test(ls[i]!) || !/^\s*\|?\s*:?-{3,}/.test(ls[i + 1]!)) continue;
      const headers = tableCells(ls[i]!);
      const columns = table.columns;
      if (![columns.id, columns.project, columns.question, columns.choice, columns.answer].every(name => headers.includes(name))) continue;
      for (i += 2; i < ls.length && /^\s*\|/.test(ls[i]!); i++) {
        const cells = tableCells(ls[i]!); const cell = (name?: string) => name ? cells[headers.indexOf(name)]?.trim() ?? '' : '';
        if (cell(columns.answer) || !names.some(name => mentions(cell(columns.project), name))) continue;
        const rawId = cell(columns.id); const flag = cell(columns.flag);
        result.push({ id: /\d+/.exec(rawId)?.[0] ?? rawId, time: cell(columns.time) || undefined,
          question: cell(columns.question), choice: cell(columns.choice), starred: /☆/.test(flag || rawId),
          source: `${file}:${i + 1}`, detail: cell(columns.question) });
      }
    }
  }
  return result.sort((a, b) => Number(b.starred) - Number(a.starred));
}
export function relatedPrograms(workspace: string, project: string, config: ImportConfig, orderNumber?: string, kind?: ProjectKind): RelatedProgram[] {
  const names = projectNames(project, config, orderNumber);
  const result: RelatedProgram[] = [];
  for (const dir of externalDirs(workspace, config)) {
    if (config.metaPrograms?.includes(basename(dir)) && kind !== 'sample') continue;
    const mentionSources: { source: string; count: number }[] = [];
    let header: ReturnType<typeof parseRecord>['header'] = { fields: {} }; let source = '';
    for (const file of ['任务书.md', '任务账本.md', '_施工记录.md', '施工记录.md']) {
      const path = join(dir, file); if (!existsSync(path) || !statSync(path).isFile()) continue;
      const raw = readFileSync(path, 'utf8'); const text = /施工记录/.test(file) ? parseRecord(raw, file, 0).header.raw ?? '' : raw;
      const count = names.reduce((sum, name) => sum + mentionCount(text, name), 0);
      if (count) mentionSources.push({ source: `${basename(dir)}/${file}`, count });
      if (/施工记录/.test(file) && !source) { header = parseRecord(raw, file, 0).header; source = `${basename(dir)}/${file}`; }
    }
    if (!mentionSources.length) continue;
    const field = (key: string) => { const value = header.fields[key]; return Array.isArray(value) ? value.join(' ') : value; };
    result.push({ name: basename(dir), phase: field('阶段 / 交付状态'), recent: field('最近一步'), time: (header as typeof header & { time?: string }).time,
      mentions: mentionSources.reduce((sum, item) => sum + item.count, 0), mentionSources,
      source: source || mentionSources[0]!.source });
  }
  return result.sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''));
}
export function gitRead(project: string): { commits: string[]; changes: string[]; reason?: string; latestCommitAt?: string } {
  try {
    const run = (args: string[]) => execFileSync(hostPlatform.toolCommand('git'), [...HOST_GIT_SAFETY, '--no-optional-locks', '-C', project, ...args], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (run(['rev-parse', '--is-inside-work-tree']) !== 'true') return { commits: [], changes: [], reason: 'not a git worktree' };
    return { commits: run(['log', '-5', '--format=%h %s', '--', '.']).split('\n').filter(Boolean),
      latestCommitAt: run(['log', '-1', '--format=%cI', '--', '.']) || undefined,
      changes: run(['status', '--porcelain=v1', '--untracked-files=all', '--', '.']).split('\n').filter(Boolean) };
  } catch { return { commits: [], changes: [], reason: 'not a git worktree or git unavailable' }; }
}
export function originalPackages(project: string): Record<string, string> | undefined {
  try {
    const run = (args: string[]) => execFileSync(hostPlatform.toolCommand('git'), [...HOST_GIT_SAFETY, '--no-optional-locks', '-C', project, ...args],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const path = `${run(['rev-parse', '--show-prefix'])}Packages/vpm-manifest.json`;
    const first = run(['log', '--diff-filter=A', '--reverse', '--format=%H', '--', 'Packages/vpm-manifest.json']).split('\n')[0];
    if (!first) return undefined;
    const manifest = JSON.parse(run(['show', `${first}:${path}`])) as { locked?: Record<string, { version?: string }> };
    return Object.fromEntries(Object.entries(manifest.locked ?? {}).map(([name, entry]) => [name, entry.version ?? 'unknown']));
  } catch { return undefined; }
}
export function unityProcesses(project: string): string[] {
  if (process.platform === 'win32') {
    try {
      return listProcesses('Unity.exe').filter(item => item.commandLine?.toLowerCase().includes(project.toLowerCase()))
        .map(item => `${item.pid} ${item.commandLine}`);
    } catch { return []; }
  }
  try {
    return execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 10000 }).split('\n')
      .filter(line => /(?:^|[\/\s])Unity(?:\s|$)/.test(line) && line.includes(project))
      .map(line => line.trim());
  } catch { return []; }
}
export function newId(): string { return randomUUID(); }
