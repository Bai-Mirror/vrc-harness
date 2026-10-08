import { globSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ProcessDefinition } from '../process/types.ts';
import type { ImportConfig, LedgerItem, Review, Source, StageAssessment, TimelineItem } from './types.ts';
import { inside } from './scan.ts';
import { localMinute } from './time.ts';

function matches(pattern: string, text: string): boolean { return new RegExp(pattern, 'i').test(text); }
function value(fields: Record<string, string | string[]>, key: string): string { const v = fields[key]; return Array.isArray(v) ? v.join(' ') : v ?? ''; }
function entry(text: string): string { return text.replace(/^(?:[-*]|\d+[.)])\s+/, ''); }
export function assessStages(project: string, definition: ProcessDefinition, config: ImportConfig,
  header: { fields: Record<string, string | string[]>; source?: string }, timeline: TimelineItem[], reviews: Review[]): StageAssessment[] {
  return definition.stages.map(stage => {
    const rule = config.stageRules?.[stage.id];
    if (!rule) return { id: stage.id, status: 'unknown', evidence: [] };
    const claimPatterns = rule.claimPatterns ?? [`\\b${stage.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`];
    const lines: Source[] = [];
    const notApplicable: Source[] = [];
    const head = value(header.fields, '阶段 / 交付状态');
    if (header.source && claimPatterns.some(p => matches(p, head)) && /已完成|完成|通过|passed|done/i.test(head))
      lines.push({ source: header.source, detail: head });
    for (const item of timeline) {
      const outcome = item.fields['结果'] ?? item.fields['怎么验 / 结果'] ?? '';
      const text = `${item.title} ${outcome} ${item.fields['做了什么'] ?? item.fields['改了'] ?? ''}`;
      if (rule?.notApplicablePatterns?.some(p => matches(p, text))) notApplicable.push({ source: item.source, detail: text });
      if (claimPatterns.some(p => matches(p, text)) && /✓|完成|通过|pass|done/i.test(outcome))
        lines.push({ source: item.source, detail: text });
    }
    if (header.source && rule?.notApplicablePatterns?.some(p => matches(p, head))) notApplicable.push({ source: header.source, detail: head });
    if (notApplicable.length && !lines.length) return { id: stage.id, status: 'not_applicable', evidence: notApplicable };
    if (!lines.length) {
      const documents = [...new Set((rule.documentPatterns ?? []).flatMap(pattern => globSync(pattern, { cwd: project })
        .map(path => path.replace(/\/$/, ''))))].sort().flatMap(path => {
        const absolute = join(project, path);
        if (!inside(project, realpathSync(absolute))) return [];
        const info = statSync(absolute);
        if (!info.isFile() && !info.isDirectory()) return [];
        const name = relative(project, absolute).replaceAll('\\', '/');
        return [{ source: name, detail: `文档存在：${name}（${localMinute(info.mtime)}）` }];
      }).slice(0, 3);
      return documents.length ? { id: stage.id, status: 'claimed', weakEvidence: true, evidence: documents } : { id: stage.id, status: 'unknown', evidence: [] };
    }
    const proofs = (rule?.verificationIds ?? []).map(id => reviews.find(r => r.id === id));
    if (proofs.length && proofs.every(p => p?.status === 'pass'))
      return { id: stage.id, status: 'verified', evidence: [...lines, ...proofs.flatMap(p => [
        { source: `review:${p!.id}`, detail: p!.reason }, ...p!.evidence,
      ])] };
    return { id: stage.id, status: 'claimed', evidence: lines };
  });
}
export function handoffFacts(_definition: ProcessDefinition, header: { fields: Record<string, string | string[]>; source?: string },
  ledger: LedgerItem[], external: LedgerItem[], reviews: Review[], _stages: StageAssessment[]): {
    gaps: Source[]; blockers: Source[]; nextSteps: Source[];
  } {
  const gaps: Source[] = []; const blockers: Source[] = []; const nextSteps: Source[] = [];
  const pending = header.fields['未决 / 等用户'];
  for (const text of (Array.isArray(pending) ? pending : [pending]).filter((x): x is string => !!x && x !== '无')) {
    gaps.push({ source: header.source ?? 'record:unknown', detail: entry(text) });
  }
  const open = [...ledger, ...external].filter(item => item.status !== 'done' && item.status !== 'dropped');
  for (const item of open) {
    if (/负责：\s*(?:用户|客户|委托人)(?:\s|—|$)/.test(item.text)) gaps.push({ source: item.source, detail: item.text });
  }
  const next = header.fields['下一步'];
  const nextLines = (Array.isArray(next) ? next : [next]).filter((x): x is string => !!x && x !== '无');
  nextSteps.push(...(nextLines.length ? nextLines.map(detail => ({ source: header.source ?? 'record:unknown', detail: entry(detail) }))
    : open.slice(0, 5).map(item => ({ source: item.source, detail: item.text }))));
  for (const review of reviews) {
    if (review.status === 'fail' && ['fingerprint', 'vpm_baseline', 'delivery_archives', 'artifacts'].includes(review.id))
      blockers.push({ source: review.evidence[0]?.source ?? `review:${review.id}`, detail: `${review.id}: ${review.reason.slice(0, 300)}` });
  }
  return { gaps, blockers, nextSteps };
}
