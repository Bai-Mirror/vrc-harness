import { spawnSync } from 'node:child_process';
import type { ProviderConfig, ProviderProbe, ProviderRole, ProviderSnapshot } from './types.ts';

export interface RoutingPolicy {
  timezone: string;
  workdays: number[]; // ISO weekdays: Monday=1
  windows: Array<{ start: string; end: string }>;
  codexQuotaThresholdPercent: number;
}
export const DEFAULT_ROUTING: RoutingPolicy = {
  timezone: 'UTC', workdays: [],
  windows: [],
  codexQuotaThresholdPercent: 85,
};
export type BalanceResult = 'ready' | 'low' | 'unknown';
export function checkBalance(config: ProviderConfig): BalanceResult {
  if (!config.balanceCheck?.length) return 'unknown';
  const result = spawnSync(config.balanceCheck[0]!, config.balanceCheck.slice(1),
    { timeout: 5000, stdio: 'ignore' });
  if (result.error || result.signal || result.status === null) return 'unknown';
  return result.status === 0 ? 'ready' : 'low';
}
export function preferredFamily(policy: RoutingPolicy, now: Date): 'codex' | 'dsh' | undefined {
  if (!policy.windows.length || !policy.workdays.length) return undefined;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: policy.timezone,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (kind: string) => parts.find(part => part.type === kind)?.value ?? '';
  const day = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  const time = `${get('hour')}:${get('minute')}`;
  return policy.workdays.includes(day) && policy.windows.some(window => time >= window.start && time < window.end)
    ? 'codex' : 'dsh';
}
export function providerFamily(config: ProviderConfig): ProviderConfig['adapter'] | 'codex' | 'dsh' {
  return config.family ?? (config.adapter === 'legacy-dsh-task' ? 'dsh' : config.adapter === 'codex-cli' ? 'codex' : config.adapter);
}
export interface RouteDecision { selected?: ProviderConfig; reason: string; excluded: string[] }
export function routeProviders(snapshot: ProviderSnapshot, role: ProviderRole, policy: RoutingPolicy,
  options: { now?: Date; balance?: (config: ProviderConfig) => BalanceResult;
    requested?: string; capabilities?: string[]; writable?: (config: ProviderConfig) => boolean;
    busy?: (config: ProviderConfig) => number } = {}): RouteDecision {
  const preferred = preferredFamily(policy, options.now ?? new Date());
  const excluded: string[] = [];
  const eligible: Array<{ config: ProviderConfig; index: number; busy: number; max: number }> = [];
  snapshot.providers.forEach(({ config, probe }: { config: ProviderConfig; probe: ProviderProbe }, index) => {
    const reasons: string[] = [];
    if (options.requested && config.id !== options.requested) reasons.push('not requested');
    if (!config.roles.includes(role)) reasons.push('role');
    if (role === 'research' && !config.roles.includes('research')) reasons.push('research role');
    if (options.capabilities?.some(capability => !probe.capabilities[capability] || probe.capabilities[capability] === 'unknown'))
      reasons.push('capability');
    if (probe.health !== 'ready' || probe.auth === 'missing') reasons.push('health/auth');
    if (probe.quota.usedPercent !== null &&
      probe.quota.usedPercent >= policy.codexQuotaThresholdPercent) reasons.push(`quota ${probe.quota.usedPercent}%`);
    if (providerFamily(config) === 'dsh') {
      const balance = (options.balance ?? checkBalance)(config);
      if (balance !== 'ready') reasons.push(`balance ${balance}`);
    }
    if (options.writable && !options.writable(config)) reasons.push('write scope');
    const max = (config as ProviderConfig & { maxConcurrentRuns?: number }).maxConcurrentRuns ?? 1;
    const busy = options.busy?.(config) ?? 0;
    if (busy >= max) reasons.push(`concurrency ${busy}/${max}`);
    if (reasons.length) excluded.push(`${config.id}: ${reasons.join(',')}`);
    else eligible.push({ config, index, busy, max });
  });
  eligible.sort((a, b) => Number(providerFamily(b.config) === preferred) - Number(providerFamily(a.config) === preferred) || a.index - b.index);
  const winner = eligible[0];
  return { selected: winner?.config, excluded,
    reason: `preferred=${preferred ?? 'configured-order'}; role=${role}; selected=${winner?.config.id ?? 'none'}; ` +
      `concurrency=${winner ? `${winner.busy}/${winner.max}` : 'none'}; excluded=${excluded.join('; ') || 'none'}` };
}
