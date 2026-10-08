import type { ErrorClass } from '../runtime/interfaces.ts';
import type { AdapterId, ProviderResult, ProviderRequest } from './types.ts';
import { parseRetryAfter } from './retry-after.ts';
import { parsePiEvents } from './pi.ts';

function events(raw: string): Record<string, unknown>[] {
  return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object');
      return value as Record<string, unknown>;
    } catch { throw new Error(`Malformed JSON event at line ${index + 1}`); }
  });
}
export function classifyError(message: string, exitStatus: number, timedOut = false): ErrorClass | undefined {
  if (timedOut) return 'timeout';
  if (exitStatus === 0) return undefined;
  if (/rate.?limit|quota|credit.*exhaust|too many requests|usage limit|session limit|hit your .{0,40} limit|\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s+code)?)['"]?\s*[:=-]?\s*['"]?429\b/i.test(message)) return 'rate_limit';
  if (/not logged in|unauthenticated|authentication required|login required|invalid api key|401/i.test(message)) return 'auth';
  if (/permission denied|access denied|sandbox deny|operation not permitted|403/i.test(message)) return 'permission_denied';
  return exitStatus ? 'tool_failure' : undefined;
}
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function structuredFailure(value: unknown): boolean {
  const record = object(value);
  return record?.ok === false || record?.is_error === true;
}
export function parseProviderOutput(adapter: AdapterId, raw: string, stderr: string, exitStatus: number,
  request: ProviderRequest, provider: string, startedAt: string, endedAt: string,
  structuredFile?: string, timedOut = false): ProviderResult {
  const result: ProviderResult = { taskId: request.taskId, runId: request.runId, provider, adapter,
    requestedModel: null, reportedModel: null, sessionId: null, startedAt, endedAt, exitStatus,
    outputs: {}, structuredResult: null, artifacts: [], usage: { inputTokens: null, outputTokens: null,
      costUsd: null, source: 'unknown' } };
  if (adapter === 'pi-cli') {
    const outcome = parsePiEvents(raw, stderr, exitStatus, timedOut);
    for (const [key, value] of Object.entries(outcome)) if (value !== undefined) Object.assign(result, { [key]: value });
    return result;
  }
  if (adapter === 'legacy-dsh-task' || adapter === 'agy-reviewer') {
    try { result.structuredResult = structuredFile ? JSON.parse(structuredFile) : null;
      if (result.structuredResult === null) throw new Error('missing result file'); }
    catch { result.errorClass = classifyError(stderr, exitStatus, timedOut) ?? 'protocol'; }
    if (!result.errorClass) result.errorClass = classifyError(`${stderr}\n${raw}\n${JSON.stringify(result.structuredResult)}`,
      structuredFailure(result.structuredResult) ? 1 : exitStatus, timedOut);
    if (result.errorClass === 'rate_limit') result.retryAfter = parseRetryAfter(`${stderr}\n${raw}\n${structuredFile ?? ''}`);
    return result;
  }
  let parsed: Record<string, unknown>[];
  try { parsed = events(raw); if (!parsed.length) throw new Error('empty event stream'); }
  catch { result.errorClass = classifyError(`${stderr}\n${raw}`, exitStatus, timedOut) ?? 'protocol';
    if (result.errorClass === 'rate_limit') result.retryAfter = parseRetryAfter(`${stderr}\n${raw}`);
    return result; }
  const last = parsed.at(-1)!;
  if (adapter === 'codex-cli') {
    const started = parsed.find(item => item.type === 'thread.started');
    const completed = [...parsed].reverse().find(item => item.type === 'turn.completed');
    const failed = parsed.find(item => item.type === 'turn.failed');
    result.sessionId = typeof started?.thread_id === 'string' ? started.thread_id : null;
    const usage = object(completed?.usage);
    if (usage) { result.usage = { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens),
      costUsd: null, source: 'measured' }; }
    const messages = parsed.filter(item => item.type === 'item.completed').map(item => object(item.item))
      .filter((item): item is Record<string, unknown> => !!item && item.type === 'agent_message');
    result.structuredResult = messages.at(-1)?.text ?? null;
    const errorText = parsed.filter(item => item.type === 'error' || item.type === 'turn.failed')
      .map(item => JSON.stringify(item)).join('\n');
    if (!started || (!completed && !failed && !errorText))
      result.errorClass = classifyError(stderr, exitStatus, timedOut) ?? 'protocol';
    else result.errorClass = classifyError(`${stderr}\n${errorText}`,
      failed || (!completed && errorText) ? 1 : exitStatus, timedOut);
    if (failed && !result.errorClass) result.errorClass = 'tool_failure';
  } else {
    const final = last.type === 'result' ? last : undefined;
    const system = parsed.find(item => item.type === 'system' && item.subtype === 'init');
    result.sessionId = typeof final?.session_id === 'string' ? final.session_id : null;
    result.reportedModel = typeof system?.model === 'string' ? system.model : null;
    result.structuredResult = final?.structured_output ?? final?.result ?? null;
    result.usage = { inputTokens: null, outputTokens: null, costUsd: number(final?.total_cost_usd),
      source: number(final?.total_cost_usd) === null ? 'unknown' : 'estimated' };
    if (!final) result.errorClass = classifyError(stderr, exitStatus, timedOut) ?? 'protocol';
    else result.errorClass = classifyError(`${stderr}\n${JSON.stringify(final)}`, final.is_error ? 1 : exitStatus, timedOut);
  }
  if (timedOut) result.errorClass = 'timeout';
  if (result.errorClass === 'rate_limit') result.retryAfter = parseRetryAfter(`${stderr}\n${raw}`);
  return result;
}
