#!/usr/bin/env node
// Rehearse only in a newly created, independent mirror; never mutate the source.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanRepository } from './privacy-scan.mjs';

export function assertInside(root, target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Target must be inside the lane root');
}
export function physicalTarget(path) {
  let existing = resolve(path); const tail = [];
  while (!existsSync(existing)) { tail.unshift(basename(existing)); const parent = dirname(existing); if (parent === existing) throw new Error('No existing ancestor'); existing = parent; }
  return resolve(realpathSync(existing), ...tail);
}
export function buildRules(config) {
  const rules = [...(config.rewriteRules ?? []), ...config.patterns.filter(p => p.replacement !== undefined)];
  for (const p of rules) {
    if (typeof p.replacement !== 'string' || /[\r\n]/.test(p.replacement) || /[\r\n]/.test(p.regex ?? p.literal ?? '')) throw new Error('Invalid replacement');
  }
  return rules;
}
export async function rehearse({ source, mirror, laneRoot, configPath, ruleDir, head = 'refs/heads/lane/privacy' }) {
  const root = realpathSync(laneRoot), sourcePath = realpathSync(source);
  const target = physicalTarget(mirror), privateDir = physicalTarget(ruleDir), configFile = realpathSync(configPath);
  assertInside(root, target); assertInside(root, privateDir);
  // Resolve parents too, so junctions cannot redirect a target into the source.
  if (existsSync(target)) throw new Error('Refusing to modify an existing repository');
  const targetRelativeToSource = relative(sourcePath, target);
  if (!targetRelativeToSource || (!targetRelativeToSource.startsWith('..') && !isAbsolute(targetRelativeToSource))) throw new Error('Mirror must stay outside the source repository');
  const ruleRelativeToSource = relative(sourcePath, privateDir);
  if (!ruleRelativeToSource || (!ruleRelativeToSource.startsWith('..') && !isAbsolute(ruleRelativeToSource))) throw new Error('Rules must stay outside the source repository');
  const ruleRelativeToMirror = relative(target, privateDir);
  if (!ruleRelativeToMirror || (!ruleRelativeToMirror.startsWith('..') && !isAbsolute(ruleRelativeToMirror))) throw new Error('Rules must stay outside the mirror repository');
  if (target === sourcePath || configFile.startsWith(target + '/') || configFile.startsWith(target + '\\')) throw new Error('Invalid isolation');
  mkdirSync(privateDir, { recursive: true }); assertInside(root, realpathSync(privateDir));
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const rules = buildRules(config);
  const run = (cmd, args, cwd) => {
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) {
      writeFileSync(resolve(privateDir, 'command-failure.log'), (result.stdout ?? '') + (result.stderr ?? ''));
      throw new Error('Rehearsal command failed: ' + cmd);
    }
    return result.stdout;
  };
  run('git', ['clone', '--mirror', '--no-local', sourcePath, target]);
  if (run('git', ['rev-parse', '--is-bare-repository'], target).trim() !== 'true') throw new Error('Expected a bare mirror');
  const before = await scanRepository(target, config, { head });
  writeFileSync(resolve(privateDir, 'before.json'), JSON.stringify(before, null, 2) + '\n');
  // fast-export does not export refs pointing directly at trees. Temporarily wrap
  // those snapshots in commits, then restore tree refs after filtering.
  const refTypes = run('git', ['for-each-ref', '--format=%(refname) %(objecttype) %(objectname)'], target).trim().split('\n');
  const treeRefs = [];
  for (const line of refTypes) {
    const [ref, type, oid] = line.split(' ');
    if (type === 'tree') {
      const wrapped = spawnSync('git', ['-C', target, '-c', 'user.name=Privacy rehearsal', '-c', 'user.email=privacy@example.invalid', 'commit-tree', oid, '-m', 'Temporary snapshot wrapper'], { encoding: 'utf8', windowsHide: true });
      if (wrapped.status !== 0) throw new Error('Cannot wrap a tree reference');
      run('git', ['update-ref', ref, wrapped.stdout.trim()], target); treeRefs.push(ref);
    } else if (!['commit', 'tag'].includes(type)) throw new Error('Unsupported non-commit reference');
  }
  const expressions = resolve(privateDir, 'replace-text.txt');
  writeFileSync(expressions, rules.map(p => `${p.literal === undefined ? 'regex:' + p.regex : 'literal:' + p.literal}==>${p.replacement}`).join('\n') + '\n');
  const rulesFile = resolve(privateDir, 'rewrite-rules.json');
  writeFileSync(rulesFile, JSON.stringify(rules) + '\n');
  // The callback handles filenames and UTF-16/binary copies of identifiers too.
  // The expressions file is still used for ordinary text and commit/tag messages.
  const helper = `import json, re\nrules = json.load(open(${JSON.stringify(rulesFile.replaceAll('\\', '/'))}, encoding="utf-8"))\ndef replace_bytes(data):\n    for rule in rules:\n        pattern = re.escape(rule["literal"]) if "literal" in rule else rule["regex"]\n        flags = re.I if "i" in rule.get("flags", "gi") else 0\n        data = re.sub(pattern.encode(), lambda m: rule["replacement"].encode(), data, flags=flags)\n        for encoding in ("utf-16le", "utf-16be"):\n            even = len(data) - len(data) % 2\n            decoded = data[:even].decode(encoding, errors="surrogatepass")\n            changed = re.sub(pattern, lambda m: rule["replacement"], decoded, flags=flags)\n            if changed != decoded:\n                data = changed.encode(encoding, errors="surrogatepass") + data[even:]\n    return data\n`;
  const callback = helper + 'blob.data = replace_bytes(blob.data)\n';
  // git-filter-repo calls this even when its path filter has excluded a file.
  const filename = 'if filename is None:\n    return None\n' + helper + 'return replace_bytes(filename)\n';
  // Wrapping tree refs deliberately changes the fresh-clone shape. --force is
  // safe here only because this function created the previously absent mirror.
  const args = ['-m', 'git_filter_repo', '--force', '--sensitive-data-removal', '--replace-text', expressions, '--replace-message', expressions, '--message-callback', helper + 'return replace_bytes(message)\n', '--blob-callback', callback, '--filename-callback', filename];
  for (const path of config.stripPaths ?? ['.claude/worktrees/']) { args.push('--path', path); }
  for (const glob of config.stripGlobs ?? []) args.push('--path-glob', glob);
  if ((config.stripPaths ?? ['.claude/worktrees/']).length || config.stripGlobs?.length) args.push('--invert-paths');
  if (config.blockedBlobIds?.length) {
    if (!config.blockedBlobIds.every(id => /^[0-9a-f]{40}$/.test(id))) throw new Error('Invalid blocked blob ID');
    const blocked = resolve(privateDir, 'strip-blobs.txt'); writeFileSync(blocked, config.blockedBlobIds.join('\n') + '\n');
    args.push('--strip-blobs-with-ids', blocked);
  }
  args.push('--replace-refs', 'delete-no-add', '--prune-empty', 'never', '--refs', ...refTypes.map(line => line.split(' ')[0]));
  // Keep a private operational log; filter-repo may print private source paths.
  writeFileSync(resolve(privateDir, 'filter-repo.log'), run('python', args, target));
  for (const ref of treeRefs) run('git', ['update-ref', ref, run('git', ['rev-parse', ref + '^{tree}'], target).trim()], target);
  // --refs implies --partial, so explicitly remove reflogs and unreachable old
  // objects in this disposable mirror, then remove its local source remote.
  // Removing a remote with `git remote remove` also deletes remote-tracking
  // refs; retain those histories and remove only the connection configuration.
  run('git', ['config', '--remove-section', 'remote.origin'], target);
  run('git', ['reflog', 'expire', '--expire=now', '--all'], target);
  run('git', ['gc', '--prune=now'], target);
  const restoredTypes = run('git', ['for-each-ref', '--format=%(refname) %(objecttype)'], target).trim().split('\n').sort();
  const expectedTypes = refTypes.map(line => line.split(' ').slice(0, 2).join(' ')).sort();
  if (JSON.stringify(restoredTypes) !== JSON.stringify(expectedTypes)) throw new Error('Reference names or types were not preserved');
  const after = await scanRepository(target, config, { head });
  writeFileSync(resolve(privateDir, 'after.json'), JSON.stringify(after, null, 2) + '\n');
  writeFileSync(resolve(privateDir, 'ref-manifest.json'), JSON.stringify({ before: before.refs, after: after.refs }, null, 2) + '\n');
  return { clean: after.clean, before: before.coverage, after: after.coverage, mirror: target };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
  rehearse({ source: args.source, mirror: args.mirror, laneRoot: args['lane-root'], configPath: args.config, ruleDir: args['rule-dir'], head: args.head }).then(result => { console.log(JSON.stringify(result)); process.exitCode = result.clean ? 0 : 1; }).catch(() => { console.error('Privacy rehearsal failed; source was not modified. Inspect private rehearsal artifacts.'); process.exitCode = 2; });
}
