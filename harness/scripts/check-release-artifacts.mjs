#!/usr/bin/env node
// Reads a built release back and reports the builder's private paths inside it.
//
//   node scripts/check-release-artifacts.mjs [--json] [--no-extract] [--quiet] <file|dir>...
//
// scripts/rust-build-env.mjs remaps the builder's home and the checkout root to /builder and /harness, and
// test/package/desktop-build.test.ts proves the remap works and that `tauri:build` runs through it. Neither reads a
// finished artifact, and that is the reading a release gate needs: the remap once applied to a release whose shipped
// installer still carried the builder's home path hundreds of times, because the entry point called the Tauri CLI
// directly. A build that compiles is not a build whose bytes are safe to publish.
//
// An NSIS installer keeps its payload compressed, so scanning the .exe alone says nothing about the files inside it.
// When the input is an NSIS installer and 7-Zip is available, the payload is extracted to a temporary directory and
// scanned as well; otherwise the report says only that the compressed bytes were scanned, never that they are clean.

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { hostPlatform } from '../src/host-platform.ts';

/** Profile directories Windows itself creates; a path under one of them names no person. */
const SYSTEM_PROFILES = new Set(['public', 'default', 'defaultuser', 'default user', 'all users', 'wdagutilityaccount']);
/**
 * Placeholder names third-party sources use in documentation and comments (`file:///home/user/file.js`). They name no
 * person, and the alternative is a check that always fails on a shipped dependency. Accounts a real build machine
 * runs as — `runner`, `builder`, `ubuntu`, `root` — are deliberately absent: a Linux release built by CI would leak
 * exactly those, and that is the reading this check exists to produce.
 */
const PLACEHOLDER_HOMES = new Set(['user', 'username', 'youruser', 'example', 'me', 'you', 'foo', 'bar']);
/** Files above this size are read whole when it is cheap, and windowed when it is not (a 100 MB runtime binary). */
const WINDOW = 64 * 1024 * 1024;
const OVERLAP = 256;

/** The rules a release must satisfy. Kept separate from reading bytes so a test can apply them to its own text. */
export function releasePrivacyRules(home = homedir()) {
  const literal = [home, home.replaceAll('\\', '/')]
    .filter((value, index, all) => value && all.indexOf(value) === index)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // A home shaped like /home/x or C:\Users\x is already covered by the profile rules; a literal rule for it would
  // only report the same bytes twice. An unusual home (/root, /srv/build) needs the literal rule to be seen at all.
  const generic = /(?:\/home\/[^/]+|[\\/]Users[\\/][^\\/]+)$/.test(home.replace(/\/$/, ''));
  return { home, generic,
    patterns: [
      { rule: 'user-profile', pattern: /(?:[A-Za-z]:)?[\\/]Users[\\/]([^\\/\s"';:]+)/g },
      { rule: 'posix-home', pattern: /[\\/]home[\\/]([^\\/\s"';:]+)/g },
      { rule: 'cargo-registry', pattern: /\.cargo[\\/]registry/gi },
      ...(generic ? [] : literal.map(value => ({ rule: 'builder-home', pattern: new RegExp(value, 'gi') }))),
    ] };
}

function printable(value) {
  return value.replace(/[^\x20-\x7e]/g, character =>
    character === '\n' ? '\\n' : character === '\r' ? '\\r' : character === '\t' ? '\\t' : '.');
}
function context(text, index, length) {
  const from = Math.max(0, index - 32), to = Math.min(text.length, index + length + 32);
  return printable(text.slice(from, to));
}

/**
 * Whether the bytes before a `builder` or `harness` root name a real profile directory instead of the sentinel. The
 * remap replaces the builder's home prefix, so a remapped path is `/builder\.cargo\...` on Windows and the text
 * before it is whatever preceded the path in the message — including a letter, because Rust concatenates a file path
 * onto a panic message. Only `\Users\<name>\` and `/home/<name>/` make it a person rather than the sentinel.
 */
function afterProfile(text, index) {
  return /(?:[\\/]Users|[\\/]home)$/i.test(text.slice(Math.max(0, index - 24), index));
}
/** True when the path starting at index was produced by the remap. */
function atBuilderRoot(text, index) {
  if (!/[\\/]builder[\\/]$/i.test(text.slice(Math.max(0, index - 9), index))) return false;
  return !afterProfile(text, Math.max(0, index - 9));
}
/** How many times a remapped root appears: a `builder` or `harness` component that no profile directory precedes. */
function countSentinels(text, name) {
  let count = 0;
  for (const match of text.matchAll(new RegExp(`[\\\\/]${name}[\\\\/]`, 'g')))
    if (!afterProfile(text, match.index ?? 0)) count++;
  return count;
}

/** Every private-path rule hit in one text, with the remap sentinels counted beside them. */
export function scanText(text, rules = releasePrivacyRules()) {
  const hits = [], sentinels = { builder: 0, harness: 0 };
  for (const { rule, pattern } of rules.patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (rule === 'user-profile' || rule === 'posix-home') {
        const name = match[1].toLowerCase();
        if (SYSTEM_PROFILES.has(name) || (rule === 'posix-home' && PLACEHOLDER_HOMES.has(name))) continue;
        // The drive-letter form matches once from the drive and once from the separator inside it; skip the inner one.
        if (rule === 'user-profile' && text[index - 1] === ':') continue;
      }
      // A Cargo registry path is the expected result *after* remapping: /builder\.cargo\registry. The ones that are
      // still the private path are reported by the profile rules above; this rule catches a registry path the remap
      // never reached, which is the reading that was missing while 460 of them shipped.
      if (rule === 'cargo-registry' && atBuilderRoot(text, index)) continue;
      hits.push({ rule, index, context: context(text, index, match[0].length) });
    }
  }
  sentinels.builder = countSentinels(text, 'builder');
  sentinels.harness = countSentinels(text, 'harness');
  return { hits, sentinels };
}

/**
 * One file's reading. A binary is scanned as latin1 so every byte survives the trip through a string; a file too
 * large to hold comfortably is read in overlapping windows, because a path straddling a window edge would otherwise
 * be invisible to every rule.
 */
export function scanFile(path, rules = releasePrivacyRules()) {
  const size = statSync(path).size, hits = [], sentinels = { builder: 0, harness: 0 };
  let nsis = false;
  if (size <= WINDOW) {
    const text = readFileSync(path).toString('latin1');
    const read = scanText(text, rules);
    nsis = text.includes('Nullsoft');
    hits.push(...read.hits); sentinels.builder += read.sentinels.builder; sentinels.harness += read.sentinels.harness;
  } else {
    const handle = readFileSync(path, { encoding: null });
    for (let offset = 0; offset < size; offset += WINDOW - OVERLAP) {
      const text = handle.subarray(offset, Math.min(size, offset + WINDOW)).toString('latin1');
      const read = scanText(text, rules);
      nsis ||= text.includes('Nullsoft');
      // A hit in the overlap was already reported by the previous window.
      hits.push(...read.hits.filter(hit => offset === 0 || hit.index >= OVERLAP)
        .map(hit => ({ ...hit, index: hit.index + offset })));
      sentinels.builder += read.sentinels.builder; sentinels.harness += read.sentinels.harness;
    }
  }
  return { file: path, bytes: size, nsis, hits, sentinels };
}

/** Every file under a directory, so an extracted installer payload is scanned as the tree it is. */
export function listFiles(path, into = []) {
  if (statSync(path).isDirectory()) for (const entry of readdirSync(path)) listFiles(join(path, entry), into);
  else into.push(path);
  return into;
}

/** True when the file is an NSIS installer: the signature read out of the bytes decides, never the file name. */
function isNsisInstaller(reading) {
  return reading.nsis;
}

function extract(path, directory) {
  const sevenZip = hostPlatform.toolCommand('7z');
  const result = spawnSync(sevenZip, ['x', '-y', '-bd', `-o${directory}`, path],
    { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  if (result.error) return { extracted: false, reason: `7z 不可用：${result.error.message}` };
  if (result.status !== 0) return { extracted: false, reason: `7z 退出码 ${result.status}：${printable((result.stderr ?? '').slice(-300))}` };
  return { extracted: true };
}

export function checkArtifacts(inputs, options = {}) {
  const rules = options.rules ?? releasePrivacyRules();
  const results = [], extracted = [];
  const work = options.extract === false ? undefined : mkdtempSync(join(tmpdir(), 'avh-release-scan-'));
  let volume;
  try {
    for (const input of inputs) {
      // An installed tree is a directory, and the reading a release needs is of every file in it.
      for (const path of listFiles(resolve(input))) {
        const reading = scanFile(path, rules);
        results.push(reading);
        if (!isNsisInstaller(reading)) continue;
        const directory = join(work, `installer-${extracted.length}`);
        const unpacked = extract(path, directory);
        if (!unpacked.extracted) { volume = unpacked.reason; continue; }
        const files = listFiles(directory);
        extracted.push({ installer: path, files: files.length });
        for (const file of files) results.push(scanFile(file, rules));
      }
    }
  } finally { if (work) rmSync(work, { recursive: true, force: true }); }
  return { results, extracted, ...(volume ? { extractionSkipped: volume } : {}) };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invoked) {
  const args = process.argv.slice(2);
  const inputs = args.filter(value => !value.startsWith('--'));
  if (!inputs.length) {
    console.error('用法: node scripts/check-release-artifacts.mjs [--json] [--no-extract] <文件或目录>...');
    process.exit(2);
  }
  const reading = checkArtifacts(inputs, { extract: !args.includes('--no-extract') });
  const leaks = reading.results.filter(result => result.hits.length);
  if (args.includes('--json')) console.log(JSON.stringify({ ...reading, leaks: leaks.length }, null, 2));
  else if (!args.includes('--quiet')) {
    for (const result of reading.results)
      console.log(`${result.hits.length ? 'LEAK' : 'ok  '} ${result.file} (${result.bytes} 字节, 命中 ${result.hits.length}, ` +
        `哨兵 /builder=${result.sentinels.builder} /harness=${result.sentinels.harness})`);
    for (const item of reading.extracted) console.log(`解包 ${item.installer} → ${item.files} 个文件`);
    if (reading.extractionSkipped) console.log(`未解包：${reading.extractionSkipped}`);
  }
  for (const leak of leaks) for (const hit of leak.hits)
    console.error(`${leak.file}: ${hit.rule} @${hit.index}: ${hit.context}`);
  const sentinels = reading.results.reduce((total, result) => total + result.sentinels.builder, 0);
  console.log(`${leaks.length ? '失败' : '通过'}：扫描 ${reading.results.length} 个文件，${leaks.length} 个含私有路径，` +
    `重映射哨兵 /builder 共 ${sentinels} 处${reading.extractionSkipped ? '（安装包未解包，压缩载荷未逐字节核对）' : ''}`);
  process.exit(leaks.length ? 1 : 0);
}
