import { hostPlatform } from '../host-platform.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Truncation { what: string; originalLength: number; keptLength: number; fullRef: string }
export function promptEvidence(source: string, runDirectory: string, what = 'previous_run_failure', limit = 1500):
  { text: string; truncated: Truncation[] } {
  if (source.length <= limit) return { text: source, truncated: [] };
  hostPlatform.mkdirPrivate(runDirectory);
  const fullRef = join(runDirectory, 'failure-evidence.txt');
  if (existsSync(fullRef)) {
    if (readFileSync(fullRef, 'utf8') !== source) throw new Error('Run failure evidence changed between launch attempts');
  } else hostPlatform.writePrivate(fullRef, source, { flag: 'wx' });
  return { text: `${source.slice(0, limit)}……[已截断，原文 ${source.length} 字，全文见 ${fullRef}]`,
    truncated: [{ what, originalLength: source.length, keptLength: limit, fullRef }] };
}
