import type { ErrorClass, Observation, RunHandle, RunResult, RunSpec } from '../runtime/interfaces.ts';
import type { PiUpstream } from '../shared/pi.ts';
import type { RoutingPolicy } from './routing.ts';

export type { PiUpstream };
export type AdapterId = 'codex-cli' | 'claude-cli' | 'legacy-dsh-task' | 'agy-reviewer' | 'pi-cli';
export type EvidenceStatus = 'declared' | 'probed' | 'unknown';
export type UsageSource = 'measured' | 'estimated' | 'unknown';
export type ProviderRole = 'executor' | 'diagnostician' | 'reviewer' | 'research';
export type SandboxOwner = 'outer' | 'self';
export function sandboxOwner(config: ProviderConfig): SandboxOwner {
  return config.sandbox ?? (config.adapter === 'codex-cli' || config.adapter === 'legacy-dsh-task' ? 'self' : 'outer');
}
export interface ProviderConfig {
  id: string;
  adapter: AdapterId;
  executable: string;
  model?: string;
  /** Optional image-capable model on this same upstream, used only for image-bearing requests. */
  imageModel?: string;
  roles: ProviderRole[];
  sandbox?: SandboxOwner;
  family?: 'codex' | 'dsh';
  balanceCheck?: string[];
  effort?: string;
  toolRoot?: string;
  sessionRoot?: string;
  settingsSources?: string[];
  reasoningEffort?: string;
  allowedTools?: string[];
  permissionMode?: string;
  engine?: 'dsh' | 'codex';
  reviewMode?: 'fast' | 'wide';
  writable?: string[];
  stateDirs?: string[];
  network?: boolean;
  capabilities?: Record<string, EvidenceStatus>;
  timeoutMs?: number;
  /** pi-cli: the service pi reaches with the person's own API key. */
  upstream?: PiUpstream;
  /** pi-cli: replaces the service's API address (a proxy, or GLM's pay-as-you-go endpoint). */
  baseUrl?: string;
  /** pi-cli: the stored credential (providers/secrets.ts) the Run receives as its API key variable. */
  secret?: string;
}
export interface ProviderProbe {
  id: string;
  adapter: AdapterId;
  health: 'ready' | 'unavailable' | 'unknown';
  version: string | null;
  auth: 'ready' | 'missing' | 'unknown';
  evidence: { version: EvidenceStatus; auth: EvidenceStatus };
  quota: { usedPercent: number | null; observedAt: string | null; status: EvidenceStatus };
  capabilities: Record<string, EvidenceStatus>;
  observedAt: string;
  expiresAt: string;
}
export interface ProviderSnapshot { workflowId: string; policyVersion: string; frozenAt: string;
  routing?: RoutingPolicy;
  providers: Array<{ config: ProviderConfig; probe: ProviderProbe }> }
export interface ProviderRequest extends RunSpec { prompt: string; role: ProviderRole; inputImages?: import('../image-inputs.ts').ImageInput[];
  toolProfile?: 'coordination' }
export interface ProviderResult extends RunResult {
  taskId: string; runId: string; provider: string; adapter: AdapterId;
  requestedModel: string | null; reportedModel: string | null; sessionId: string | null;
  startedAt: string; endedAt: string; structuredResult: unknown;
  artifacts: string[]; usage: { inputTokens: number | null; outputTokens: number | null;
    costUsd: number | null; source: UsageSource; /** Dropped streams may have incurred additional upstream charges. */ incomplete?: boolean };
  connection?: { interruptions: number; retries: number };
  errorClass?: ErrorClass;
}
export interface ProviderAdapter {
  readonly config: ProviderConfig;
  readonly supportsResume: false;
  discover(): ProviderConfig;
  probe(): Promise<ProviderProbe>;
  start(request: ProviderRequest): Promise<RunHandle>;
  observe(handle: RunHandle): Promise<Observation> | Observation;
  cancel(handle: RunHandle): Promise<'confirmed' | 'not_confirmed'>;
  collect(handle: RunHandle): Promise<ProviderResult> | ProviderResult;
}
