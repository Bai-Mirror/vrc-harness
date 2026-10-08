// Stamp `<!-- doc-tier: X -->` on the first line of every managed document and keep the few
// `path.md:NNN` line references correct, since inserting a line shifts every number below it.
//   node harness/tools/doc-tier-stamp.mjs --check   verify only, non-zero exit on a missing marker
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const root = join(repo, 'docs', 'zh');
const dry = process.argv.includes('--dry');
const check = process.argv.includes('--check');

const tierOf = (rel) => {
  if (rel === 'README.md') return null; // the document system's own entry point
  // The decision register is the one workspace file whose body is design decisions (D-nn): README §2 rule 1
  // ("mixed content takes the highest tier") makes it 甲, and README §4 already lists it as 甲条目. Without
  // this exception the checker forced 丙 on it, which let an execution session edit the register directly.
  if (rel === '工作区/决定记录.md') return '甲';
  if (rel.startsWith('工作区/')) return '丙';
  if (rel.startsWith('设计/3-实践设计/')) return '乙';
  if (rel.startsWith('设计/')) return '甲';
  throw new Error('unclassified document: ' + rel);
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.md')) out.push(full);
  }
  return out;
}

const MARK = /^<!--\s*doc-tier:\s*[甲乙丙]\s*-->\s*\n/;
if (check && !existsSync(root)) {
  // A packaging bootstrap worktree carries only the harness sources; there is no document system
  // here to verify, and reporting that is more honest than failing on an absent directory.
  console.log('doc-tier: no docs/zh in this checkout, nothing to check');
  process.exit(0);
}
const stamped = [];
const wrong = [];
for (const file of walk(root)) {
  const rel = relative(root, file).split('\\').join('/');
  const tier = tierOf(rel);
  if (!tier) continue;
  const text = readFileSync(file, 'utf8');
  // Use the file's own line ending: some documents are committed with CRLF, and comparing against a
  // bare "\n" would report a marker that is in fact already correct.
  const marker = `<!-- doc-tier: ${tier} -->${text.includes('\r\n') ? '\r\n' : '\n'}`;
  if (check) {
    if (!MARK.test(text)) wrong.push(`${rel}: no tier marker`);
    else if (!text.startsWith(marker)) wrong.push(`${rel}: marker says ${MARK.exec(text)[0].trim()}, directory implies ${tier}`);
    continue;
  }
  if (MARK.test(text)) {
    const fixed = text.replace(MARK, marker);
    if (fixed !== text && !dry) writeFileSync(file, fixed);
    continue;
  }
  stamped.push({ rel, file, added: true });
  if (!dry) writeFileSync(file, marker + text);
}

if (check) {
  if (wrong.length) {
    console.error(`doc-tier: ${wrong.length} document(s) with a missing or inconsistent tier marker`);
    for (const w of wrong) console.error('  ' + w);
    process.exit(1);
  }
  console.log('doc-tier: every managed document carries a tier marker consistent with its directory');
  process.exit(0);
}

// A `path.md:NNN` reference counts lines from the top; every newly inserted marker line shifts it by one.
const gainedLine = new Set(stamped.map(s => s.rel));
let adjusted = 0;
for (const file of walk(root)) {
  const rel = relative(root, file).split('\\').join('/');
  const text = readFileSync(file, 'utf8');
  const next = text.replace(/\]\(([^)\s]+?\.md):(\d+)\)/g, (whole, target, line) => {
    const decoded = decodeURIComponent(target);
    const targetRel = decoded.startsWith(root)
      ? relative(root, decoded).split('\\').join('/')
      : relative(root, resolve(dirname(file), decoded)).split('\\').join('/');
    if (!gainedLine.has(targetRel)) return whole;
    return `](${target}:${Number(line) + 1})`;
  });
  if (next !== text) {
    if (!dry) writeFileSync(file, next);
    adjusted++;
  }
}

console.log(`stamped ${stamped.length} documents, adjusted line references in ${adjusted} files`);
if (dry) for (const s of stamped.slice(0, 5)) console.log('  would stamp ' + s.rel);
