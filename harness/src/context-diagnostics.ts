import type { DatabaseSync } from 'node:sqlite';

export interface ContextSample {
  seq: number;
  runId?: string;
  status: string;
  taskStatus: string;
  errorClass?: string | null;
  taskId: string;
  stageId: string;
  knowledgeVersion: string;
  modelFamily: string | null;
  attempt: number;
  passed: boolean;
  selected: Array<{ id: string; sha256: string | null }>;
}

export function readContextSamples(db:DatabaseSync,workflowId?:string):ContextSample[]{
  const rows=db.prepare(`SELECT e.seq,e.entity_id AS runId,e.payload_json AS payload,r.attempt,r.status,t.id AS taskId,
    t.stage_id AS stageId,t.status AS taskStatus,json_extract(r.result_json,'$.errorClass') AS errorClass,w.knowledge_version AS knowledgeVersion,
    EXISTS(SELECT 1 FROM stage_completion c WHERE c.run_id=r.id) AS passed
    FROM event e JOIN run r ON r.id=e.entity_id JOIN task t ON t.id=r.task_id JOIN workflow w ON w.id=t.workflow_id
    WHERE e.entity_type='run' AND e.action='context_compiled' AND (? IS NULL OR t.workflow_id=?) ORDER BY e.seq`)
    .all(workflowId??null,workflowId??null) as Array<{seq:number;runId:string;payload:string;attempt:number;status:string;taskStatus:string;errorClass:string|null;taskId:string;
      stageId:string;knowledgeVersion:string;passed:number}>;
  return rows.map(row=>{const context=JSON.parse(row.payload) as {modelFamily:string|null;selected:Array<{id:string;sha256:string|null}>};
    return{...row,passed:Boolean(row.passed),modelFamily:context.modelFamily,selected:context.selected??[]};});
}

export interface ContextDiagnostic {
  kind: 'version-degradation' | 'suspected-pollution' | 'suspected-conflict';
  severity: 'warning' | 'critical';
  stageId: string;
  modelFamily: string;
  knowledgeVersion: string;
  itemIds: string[];
  baselineSamples: number;
  observedSamples: number;
  baselineRate: number;
  observedRate: number;
  delta: number;
  reason: string;
  causal: false;
}

const MIN_SAMPLES = 5;
const WARNING_DROP = .15;
const CRITICAL_DROP = .30;

export function isSettledContextSample(sample: ContextSample): boolean {
  return sample.status === 'exited' && ['PASSED', 'FAILED'].includes(sample.taskStatus) &&
    !['rate_limit', 'auth', 'permission_denied'].includes(sample.errorClass ?? '');
}

function rate(samples: ContextSample[]): number {
  return samples.filter(sample => sample.passed).length / samples.length;
}

function diagnostic(kind: ContextDiagnostic['kind'], base: ContextSample[], observed: ContextSample[], itemIds: string[],
  reason: string): ContextDiagnostic | undefined {
  if (base.length < MIN_SAMPLES || observed.length < MIN_SAMPLES) return undefined;
  const baselineRate = rate(base), observedRate = rate(observed), delta = observedRate - baselineRate;
  if (delta > -WARNING_DROP) return undefined;
  const sample = observed[0]!;
  return { kind, severity: delta <= -CRITICAL_DROP ? 'critical' : 'warning', stageId: sample.stageId,
    modelFamily: sample.modelFamily ?? 'unknown', knowledgeVersion: sample.knowledgeVersion, itemIds,
    baselineSamples: base.length, observedSamples: observed.length, baselineRate, observedRate, delta, reason, causal: false };
}

/**
 * Detects suspicious context correlations without claiming causality. Only first attempts are compared inside the
 * same stage and model family. These alerts are update telemetry; they never promote or roll back a client pack.
 */
export function diagnoseContext(samples: ContextSample[]): ContextDiagnostic[] {
  // An unfinished observation, cancellation or unknown recovery outcome is not a failed design attempt.
  const first = samples.filter(sample => sample.attempt === 1 && isSettledContextSample(sample));
  const cells = new Map<string, ContextSample[]>();
  for (const sample of first) {
    const key = `${sample.stageId}\0${sample.modelFamily ?? 'unknown'}`;
    cells.set(key, [...(cells.get(key) ?? []), sample]);
  }
  const out: ContextDiagnostic[] = [];
  for (const values of cells.values()) {
    const versions = new Map<string, ContextSample[]>();
    for (const sample of values) versions.set(sample.knowledgeVersion, [...(versions.get(sample.knowledgeVersion) ?? []), sample]);
    const ordered = [...versions.entries()].sort((a, b) => Math.min(...a[1].map(item => item.seq)) - Math.min(...b[1].map(item => item.seq)));
    for (let i = 1; i < ordered.length; i++) {
      const found = diagnostic('version-degradation', ordered[i - 1]![1], ordered[i]![1], [],
        `能力版本 ${ordered[i]![0]} 的同模型同阶段一次通过率低于 ${ordered[i - 1]![0]}`);
      if (found) out.push(found);
    }
    for (const versionSamples of versions.values()) {
      const ids = [...new Set(versionSamples.flatMap(sample => sample.selected.map(item => item.id)))].sort();
      for (const id of ids) {
        const withItem = versionSamples.filter(sample => sample.selected.some(item => item.id === id));
        const withoutItem = versionSamples.filter(sample => !sample.selected.some(item => item.id === id));
        const found = diagnostic('suspected-pollution', withoutItem, withItem, [id],
          `条目 ${id} 被注入时的一次通过率显著低于同版本未注入样本；仅为相关性，需隔离评测`);
        if (found) out.push(found);
      }
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
        const pair = [ids[a]!, ids[b]!];
        const together = versionSamples.filter(sample => pair.every(id => sample.selected.some(item => item.id === id)));
        const alone = versionSamples.filter(sample => pair.some(id => sample.selected.some(item => item.id === id)) &&
          !pair.every(id => sample.selected.some(item => item.id === id)));
        const found = diagnostic('suspected-conflict', alone, together, pair,
          `条目 ${pair.join(' + ')} 同时注入时的一次通过率显著低于仅注入其中一项；需隔离评测`);
        if (found) out.push(found);
      }
    }
  }
  return out.sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || a.reason.localeCompare(b.reason));
}
