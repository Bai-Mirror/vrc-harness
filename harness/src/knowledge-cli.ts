import { hostPlatform } from './host-platform.ts';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isMap, parseDocument, type YAMLMap } from 'yaml';
import { knowledgeMeta, MATURITIES, type KnowledgeMeta } from './process/knowledge-meta.ts';
import { loadProcess, validateThresholds } from './process/load.ts';

type Obj = Record<string, unknown>;
function mapping(value: unknown, at: string): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: expected mapping`);
  return value as Obj;
}
function parsed(text: string, path: string) {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`${path}: ${doc.errors.map(x => x.message).join('; ')}`);
  return doc;
}
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() && /\.ya?ml$/i.test(entry.name) ? [path] : [];
  }).sort();
}
function entries(root: Obj, path: string): { id: string; raw: Obj; at: string }[] {
  if (root.schema === 'thresholds/0.1') {
    return Object.entries(mapping(root.t, `${path}.t`)).map(([id, value]) => ({ id: `t.${id}`, raw: mapping(value, `${path}.t.${id}`), at: `${path}.t.${id}` }));
  }
  if (root.schema === 'process/0.1') {
    if (!Array.isArray(root.checks)) throw new Error(`${path}.checks: expected list`);
    return root.checks.map((value, i) => {
      const raw = mapping(value, `${path}.checks[${i}]`);
      return { id: String(raw.id), raw, at: `${path}.checks[${i}]` };
    });
  }
  return [];
}
function add(map: Map<string, number>, value: string): void { map.set(value, (map.get(value) ?? 0) + 1); }
function grouped(name: string, values: Map<string, number>): string {
  return `${name}: ${[...values].sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => `${key}=${n}`).join(' ')}`;
}
export function knowledgeCheck(rootPath: string): string {
  const root = resolve(rootPath);
  const documents = files(root).map(path => ({ path, text: readFileSync(path, 'utf8') }))
    .map(file => ({ ...file, data: mapping(parsed(file.text, file.path).toJS(), file.path) }))
    .filter(file => file.data.schema === 'thresholds/0.1' || file.data.schema === 'process/0.1');
  const tables = documents.filter(file => file.data.schema === 'thresholds/0.1');
  if (tables.length !== 1) throw new Error(`${root}: expected exactly one thresholds/0.1 file (found ${tables.length})`);
  validateThresholds(tables[0]!.data);
  for (const file of documents.filter(file => file.data.schema === 'process/0.1')) loadProcess(file.text, tables[0]!.data);
  const kinds = new Map<string, number>(); const verifications = new Map<string, number>(); const visibilities = new Map<string, number>();
  const violations: string[] = [];
  for (const file of documents) for (const item of entries(file.data, file.path)) {
    const meta: KnowledgeMeta = knowledgeMeta(item.raw, item.at);
    const maturity = item.raw.maturity;
    if (!MATURITIES.includes(maturity as typeof MATURITIES[number])) throw new Error(`${item.at}.maturity: unsupported ${String(maturity)}`);
    add(kinds, meta.kind); add(visibilities, meta.visibility);
    for (const verification of meta.verification) add(verifications, verification.kind);
    if ((maturity === 'tested' || maturity === 'accepted') && meta.verification.length === 0)
      violations.push(`${file.path}: ${item.id} (${maturity}): verification 为空`);
  }
  return [grouped('kind', kinds), grouped('verification.kind', verifications), grouped('visibility', visibilities),
    `违规 ${violations.length} 条`, ...violations].join('\n');
}
export function sourceIdBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}
export function sourceIdFile(path: string): string { return sourceIdBytes(readFileSync(path)); }
export function sourceIdTextLine(line: string): string {
  return sourceIdBytes(Buffer.from(line.replace(/\r?\n$/, '').replace(/[\t \r]+$/, ''), 'utf8'));
}
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(hostPlatform.toolCommand('git'), ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}
function yamlEntries(doc: ReturnType<typeof parseDocument>): { id: string; map: YAMLMap }[] {
  if (!isMap(doc.contents)) throw new Error('expected YAML mapping');
  const schema = doc.contents.get('schema');
  const container = schema === 'thresholds/0.1' ? doc.contents.get('t', true) : schema === 'process/0.1' ? doc.contents.get('checks', true) : undefined;
  if (schema !== 'thresholds/0.1' && schema !== 'process/0.1') throw new Error('expected thresholds/0.1 or process/0.1 file');
  if (schema === 'thresholds/0.1' && isMap(container)) return container.items.map(pair => {
    if (!isMap(pair.value)) throw new Error(`t.${String(pair.key)}: expected mapping`);
    return { id: `t.${String(pair.key)}`, map: pair.value };
  });
  if (schema === 'process/0.1' && container && 'items' in container && Array.isArray(container.items)) return container.items.map((item: unknown) => {
    if (!isMap(item)) throw new Error('checks item: expected mapping');
    return { id: String(item.get('id')), map: item };
  });
  throw new Error('expected knowledge entries');
}
/** Whether block sequences under a key are indented (`key:\n  - x`) rather than flush (`key:\n- x`). */
export function sequencesIndented(text: string): boolean {
  const match = /^( *)[^\s#-][^\n]*:[ \t]*\n( *)- /m.exec(text);
  return match ? match[2]!.length > match[1]!.length : true;
}
export function knowledgeAnnotate(path: string, write = false): string {
  const absolute = resolve(path);
  const original = readFileSync(absolute, 'utf8');
  const doc = parsed(original, absolute);
  const cache = new Map<string, string[]>();
  let repo: string | undefined;
  const changed: string[] = []; const unavailable: string[] = [];
  for (const { id, map } of yamlEntries(doc)) {
    const maturity = map.get('maturity');
    if (maturity !== 'tested' && maturity !== 'accepted') continue;
    const verification = map.get('verification');
    if (verification !== undefined && (!Array.isArray(verification) || verification.length > 0)) continue;
    const source = map.get('source');
    if (typeof source !== 'string') { unavailable.push(`${id}: 无 source`); continue; }
    const match = /^(.+):([1-9]\d*)@([0-9a-fA-F]{7,40})$/.exec(source);
    if (!match) { unavailable.push(`${id}: ${source} (source 不是「路径:行@提交」格式)`); continue; }
    try {
      repo ??= git(dirname(absolute), 'rev-parse', '--show-toplevel').trim();
      const key = `${match[3]}:${match[1]}`;
      let lines = cache.get(key);
      if (!lines) { lines = git(repo, 'show', key).split(/\r?\n/); cache.set(key, lines); }
      const line = lines[Number(match[2]) - 1];
      if (line === undefined || (Number(match[2]) === lines.length && line === '')) throw new Error('line out of range');
      const sourceId = sourceIdTextLine(line);
      map.set('source_id', sourceId);
      map.set('verification', [{ kind: 'sop-editorial', ref: sourceId }]);
      if (!map.has('kind')) map.set('kind', 'spec');
      if (!map.has('asserted_by')) map.set('asserted_by', 'compile:legacy');
      changed.push(`${id}: source_id=${sourceId}; verification=sop-editorial; kind=${String(map.get('kind'))}; asserted_by=${String(map.get('asserted_by'))}`);
    } catch (error) { unavailable.push(`${id}: ${source} (${error instanceof Error ? error.message : String(error)})`); }
  }
  // Keep the file's own layout (sequence indent, flow padding, no folding) so the diff shows only the added keys.
  if (write && changed.length) writeFileSync(absolute, doc.toString({ indentSeq: sequencesIndented(original),
    flowCollectionPadding: /[[{] [^\s\]}]/.test(original), lineWidth: 0 }));
  return [`${write ? '已写入' : 'dry-run'}: 可补标 ${changed.length} 条`, ...changed,
    `无法补标 ${unavailable.length} 条`, ...unavailable].join('\n');
}
export function knowledgeCommand(command: string | undefined, args: string[]): void {
  if (command === 'check') {
    const root = args.shift(); if (!root || args.length) throw new Error('用法: avh knowledge check <知识根>');
    const report = knowledgeCheck(root); console.log(report);
    if (!/^违规 0 条$/m.test(report)) process.exitCode = 1;
  } else if (command === 'annotate') {
    const path = args.shift();
    const editorial = args.indexOf('--sop-editorial'); if (editorial >= 0) args.splice(editorial, 1);
    const write = args.indexOf('--write'); if (write >= 0) args.splice(write, 1);
    if (!path || editorial < 0 || args.length) throw new Error('用法: avh knowledge annotate <文件> --sop-editorial [--write]');
    console.log(knowledgeAnnotate(path, write >= 0));
  } else throw new Error('用法: avh knowledge check <知识根> | annotate <文件> --sop-editorial [--write]');
}
