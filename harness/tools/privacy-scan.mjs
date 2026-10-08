#!/usr/bin/env node
// Scan reachable Git objects without checking out history or printing matched values.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
// The rule list itself lives in the product (`src/shared/privacy-patterns.mjs`), because the same detectors also
// redact what a project diagnostics bundle carries. Two copies would drift and the untested copy would be the leak.
// Node >= 24 loads the `.ts` module that imports it, so a source checkout needs no build step.
import { PRIVACY_PATTERNS } from '../src/shared/privacy-patterns.mjs';

const builtins = PRIVACY_PATTERNS;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compileConfig(config) {
  if (!config || config.version !== 1 || !Array.isArray(config.patterns)) throw new Error('Invalid configuration');
  if (config.largeBinaryBytes !== undefined && (!Number.isSafeInteger(config.largeBinaryBytes) || config.largeBinaryBytes < 1)) throw new Error('Invalid binary threshold');
  if (config.blockedBlobIds !== undefined && (!Array.isArray(config.blockedBlobIds) || !config.blockedBlobIds.every(id => /^[0-9a-f]{40}$/.test(id)))) throw new Error('Invalid blocked blob ID');
  const entries = [...builtins, ...config.patterns];
  const ids = new Set(['large-binary', 'private-raster']);
  return entries.map(entry => {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.id) || ids.has(entry.id)) throw new Error('Invalid or duplicate pattern ID');
    ids.add(entry.id);
    if (entry.reviewOnly && (entry.id !== 'commercial-reference' || !entry.scopes?.length || entry.scopes.includes('path'))) throw new Error('Only commercial text references may be review-only');
    const source = entry.literal === undefined ? entry.regex : escape(entry.literal);
    if (typeof source !== 'string' || !source.length) throw new Error('Empty pattern');
    const flags = entry.flags ?? 'gi';
    const regex = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
    if (regex.test('')) throw new Error('Patterns must not match empty strings');
    return { ...entry, regex, scopes: entry.scopes ?? ['content', 'path', 'metadata'] };
  });
}

export function matchPatterns(text, scope, patterns, config) {
  const found = [];
  for (const pattern of patterns) {
    if (!pattern.scopes.includes(scope)) continue;
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(new RegExp(pattern.regex.source, pattern.regex.flags.includes('g') ? pattern.regex.flags : pattern.regex.flags + 'g'))) {
      if (pattern.id === 'order-id' && (config.syntheticOrderIds ?? []).some(id => id.toLowerCase() === match[0].slice(0, 13).toLowerCase())) continue;
      if (pattern.id === 'private-user-path' && (config.syntheticUsers ?? []).some(u => u.toLowerCase() === match[1].toLowerCase())) continue;
      if ((config.allowedMatches ?? []).some(a => a.id === pattern.id && a.value === match[0])) continue;
      found.push(pattern.id);
      break;
    }
  }
  return found;
}

export async function scanRepository(repo, config, { head = 'HEAD' } = {}) {
  const patterns = compileConfig(config);
  const git = args => {
    const result = spawnSync('git', ['--no-replace-objects', '-C', repo, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error('Git operation failed: ' + args[0]);
    return result.stdout;
  };
  const refs = git(['for-each-ref', '--format=%(refname) %(objectname)']).trim().split('\n').filter(Boolean);
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new Error('Shallow history cannot be audited');
  if (git(['rev-parse', '--show-object-format']).trim() !== 'sha1') throw new Error('Unsupported Git object format');
  const headOid = git(['rev-parse', head + '^{commit}']).trim();
  const oids = [...new Set(git(['rev-list', '--objects', '--all', headOid, '--no-object-names']).trim().split('\n').filter(Boolean))];
  const objects = new Map();
  const rows = new Map(patterns.map(p => [p.id, { id: p.id, headFiles: new Set(), historyCommits: new Set(), blobs: new Set(), metadataObjects: new Set(), pathFiles: new Set(), treeRefFiles: new Set(), treeRefSnapshots: new Set() }]));
  rows.set('large-binary', { id: 'large-binary', headFiles: new Set(), historyCommits: new Set(), blobs: new Set(), metadataObjects: new Set(), pathFiles: new Set() });
  rows.set('private-raster', { id: 'private-raster', headFiles: new Set(), historyCommits: new Set(), blobs: new Set(), metadataObjects: new Set(), pathFiles: new Set() });
  const threshold = config.largeBinaryBytes ?? 10 * 1024 * 1024;
  const decode = bytes => {
    const texts = [bytes.toString('utf8')];
    // UTF-16 is common in Windows exports. Also inspect binary bytes as UTF-8.
    if (bytes.includes(0) || bytes.length % 2 === 0) { texts.push(bytes.toString('utf16le')); const swapped = Buffer.from(bytes.subarray(0, bytes.length - bytes.length % 2)); swapped.swap16(); texts.push(swapped.toString('utf16le')); }
    return texts;
  };
  await new Promise((done, reject) => {
    const child = spawn('git', ['--no-replace-objects', '-C', repo, 'cat-file', '--batch'], { windowsHide: true });
    let pending = Buffer.alloc(0), header;
    child.on('error', reject);
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (!header) {
          const end = pending.indexOf(10); if (end < 0) break;
          const [oid, type, size] = pending.subarray(0, end).toString().split(' ');
          header = { oid, type, size: Number(size) };
          if (!Number.isSafeInteger(header.size)) { reject(new Error('Missing Git object')); child.kill(); return; }
          pending = pending.subarray(end + 1);
        }
        if (pending.length < header.size + 1) break;
        const bytes = pending.subarray(0, header.size);
        const item = { type: header.type, size: header.size };
        item.binary = header.type === 'blob' && bytes.includes(0);
        if (header.type === 'tree') {
          item.entries = []; let offset = 0;
          while (offset < bytes.length) {
            const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space);
            const mode = bytes.subarray(offset, space).toString();
            item.entries.push({ mode, name: bytes.subarray(space + 1, nul).toString('utf8'), oid: bytes.subarray(nul + 1, nul + 21).toString('hex') });
            offset = nul + 21;
          }
        } else {
          const scope = header.type === 'blob' ? 'content' : 'metadata';
          item.matches = [...new Set(decode(bytes).flatMap(t => matchPatterns(t, scope, patterns, config)))];
          if (header.type === 'blob' && (config.blockedBlobIds ?? []).includes(header.oid)) item.matches.push('private-raster');
          item.lfs = header.type === 'blob' && bytes.toString('utf8', 0, 150).startsWith('version https://git-lfs.github.com/spec/v1');
          if (header.type === 'blob' && bytes.includes(0) && header.size >= threshold) item.matches.push('large-binary');
          for (const id of item.matches) rows.get(id)[header.type === 'blob' ? 'blobs' : 'metadataObjects'].add(header.oid);
          if (header.type === 'commit') item.tree = bytes.toString('utf8').match(/^tree ([0-9a-f]+)/)?.[1];
        }
        objects.set(header.oid, item);
        pending = pending.subarray(header.size + 1); header = undefined;
      }
    });
    child.on('close', code => code === 0 && !header && pending.length === 0 ? done() : reject(new Error('Incomplete Git object scan')));
    // Respect pipe backpressure; never enqueue all object contents in memory.
    (async () => { for (const oid of oids) if (!child.stdin.write(oid + '\n')) await new Promise(r => child.stdin.once('drain', r)); child.stdin.end(); })().catch(reject);
  });
  const sanitize = value => {
    let safe = value;
    for (const p of patterns) { p.regex.lastIndex = 0; safe = safe.replace(p.regex, '[redacted-' + p.id + ']'); }
    return safe;
  };
  const locations = new Map(), submodules = new Set(), lfsPointers = new Set(), binaryFiles = new Map();
  const walk = (tree, prefix, visit) => {
    const item = objects.get(tree); if (!item || item.type !== 'tree') throw new Error('Missing reachable tree');
    for (const entry of item.entries) {
      const path = prefix + entry.name;
      if (entry.mode === '40000') walk(entry.oid, path + '/', visit);
      else if (entry.mode === '160000') { submodules.add(sanitize(path)); visit(path, [], entry.oid); }
      else {
        const blob = objects.get(entry.oid); if (!blob || blob.type !== 'blob') throw new Error('Missing reachable blob');
        if (blob.lfs) lfsPointers.add(sanitize(path));
        if (blob.binary) binaryFiles.set(entry.oid, { path: sanitize(path), bytes: blob.size, oid: entry.oid });
        visit(path, [...new Set([...blob.matches, ...matchPatterns(path, 'path', patterns, config)])], entry.oid);
      }
    }
  };
  const commits = [...objects.entries()].filter(([, obj]) => obj.type === 'commit');
  for (const [oid, obj] of commits) {
    const matched = new Set(obj.matches);
    walk(obj.tree, '', (path, ids, blob) => {
      for (const id of ids) {
        matched.add(id); const row = rows.get(id); row.pathFiles.add(sanitize(path));
        if (oid === headOid) row.headFiles.add(sanitize(path));
        const key = id + '\0' + sanitize(path);
        if (!locations.has(key)) locations.set(key, { id, path: sanitize(path), head: false, commits: new Set(), blobs: new Set() });
        const location = locations.get(key); location.head ||= oid === headOid; location.commits.add(oid); location.blobs.add(blob);
      }
    });
    for (const id of matched) rows.get(id).historyCommits.add(oid);
  }
  // Inspect orphan tree refs as well as trees in commit snapshots.
  const referencedTrees = refs.map(r => r.split(' ')[1]).filter(oid => objects.get(oid)?.type === 'tree');
  for (const oid of referencedTrees) walk(oid, '', (path, ids) => { for (const id of ids) { const row = rows.get(id); row.pathFiles.add(sanitize(path)); (row.treeRefFiles ??= new Set()).add(sanitize(path)); (row.treeRefSnapshots ??= new Set()).add(oid); } });
  const serialRows = [...rows.values()].map(r => ({ id: r.id, disposition: patterns.find(p => p.id === r.id)?.reviewOnly ? 'review' : 'blocking', headFiles: r.headFiles.size, historyCommits: r.historyCommits.size, blobs: r.blobs.size, metadataObjects: r.metadataObjects.size, treeRefFiles: r.treeRefFiles?.size ?? 0, treeRefSnapshots: r.treeRefSnapshots?.size ?? 0, paths: [...r.pathFiles].sort() }));
  return {
    version: 1, configDigest: createHash('sha256').update(JSON.stringify(config)).digest('hex'), head: headOid, refs: refs.map(sanitize), coverage: { objects: objects.size, commits: commits.length, blobs: [...objects.values()].filter(o => o.type === 'blob').length, trees: [...objects.values()].filter(o => o.type === 'tree').length, tags: [...objects.values()].filter(o => o.type === 'tag').length, submodules: [...submodules], lfsPointers: [...lfsPointers], lfsObjectsScanned: false, binaryBlobs: binaryFiles.size, largestBlobBytes: [...objects.values()].filter(o => o.type === 'blob').reduce((n, o) => Math.max(n, o.size), 0) },
    clean: !submodules.size && !lfsPointers.size && serialRows.every(r => patterns.find(p => p.id === r.id)?.reviewOnly || (!r.headFiles && !r.historyCommits && !r.blobs && !r.metadataObjects && !r.paths.length)),
    rows: serialRows,
    binaryFiles: [...binaryFiles.values()].sort((a,b) => b.bytes - a.bytes),
    locations: [...locations.values()].map(l => ({ ...l, commits: l.commits.size, blobs: l.blobs.size })).sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path)),
  };
}

export async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--repo', '--config', '--out', '--head'].includes(argv[i]) || !argv[i + 1]) throw new Error('Usage: privacy-scan --repo REPO --config LOCAL_JSON --out REPORT_JSON [--head REF]');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.config || !args.out) throw new Error('Local configuration and output are required');
  const config = JSON.parse(readFileSync(args.config, 'utf8'));
  const report = await scanRepository(resolve(args.repo ?? '.'), config, { head: args.head });
  writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ clean: report.clean, coverage: report.coverage, counts: report.rows.map(({ paths, ...r }) => r) }) + '\n');
  return report.clean ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { console.error('Privacy scan failed; no clean verdict was issued. Check configuration and Git object availability.'); process.exitCode = 2; });
}
