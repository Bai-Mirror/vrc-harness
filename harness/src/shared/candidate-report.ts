/** The client and receiver use the same content projection, independent of local database or pack paths. */
type Summary = { attempts: number; passes: number; failures: number; cases: number; modelFamilies: number;
  firstPassRate: number | null; secondPassRate: number | null };
export interface CandidateReport { schema: 'harness-candidate-observation/0.1'; category: 'candidate-evaluation';
  purpose: 'product-improvement'; sourceKind: 'ai' | 'distill' | 'human' | 'import' | 'unknown';
  evaluation: { status: 'passed' | 'failed'; baseline: Summary; candidate: Summary } }

export function validateCandidateReport(value: unknown): CandidateReport {
  const keys = (item: unknown, allowed: string): void => {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== allowed.split(',').sort().join(','))
      throw new Error('Technical report contains fields outside its authorized projection');
  };
  keys(value, 'schema,category,purpose,sourceKind,evaluation');
  const report = value as CandidateReport;
  keys(report.evaluation, 'status,baseline,candidate');
  if (report.schema !== 'harness-candidate-observation/0.1' || report.category !== 'candidate-evaluation' ||
    report.purpose !== 'product-improvement' || !['ai', 'distill', 'human', 'import', 'unknown'].includes(report.sourceKind) ||
    !['passed', 'failed'].includes(report.evaluation.status)) throw new Error('Technical report purpose or category is invalid');
  for (const item of [report.evaluation.baseline, report.evaluation.candidate]) {
    keys(item, 'attempts,passes,failures,cases,modelFamilies,firstPassRate,secondPassRate');
    for (const key of ['attempts', 'passes', 'failures', 'cases', 'modelFamilies'] as const)
      if (!Number.isSafeInteger(item[key]) || item[key] < 0 || item[key] > 1_000_000) throw new Error('Technical report count is invalid');
    if (item.passes + item.failures !== item.attempts || item.cases > item.attempts || item.modelFamilies > item.attempts ||
      (item.attempts === 0 && (item.firstPassRate !== null || item.secondPassRate !== null)) ||
      (item.attempts > 0 && (item.cases === 0 || item.modelFamilies === 0))) throw new Error('Technical report denominators are inconsistent');
    for (const rate of [item.firstPassRate, item.secondPassRate])
      if (rate !== null && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1))
        throw new Error('Technical report rate is invalid');
    if (item.firstPassRate !== null && item.secondPassRate !== null && item.firstPassRate > item.secondPassRate)
      throw new Error('Technical report retry rate cannot decrease');
  }
  return report;
}
