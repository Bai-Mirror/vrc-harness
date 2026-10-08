import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withStateEvent } from '../state/tx.ts';
import type { ProviderConfig, ProviderProbe, ProviderSnapshot } from './types.ts';
import { DEFAULT_ROUTING, type RoutingPolicy } from './routing.ts';
import { commandFor } from '../host-platform.ts';
import { avhHome } from '../config.ts';
import { claudeCredentialSaved, claudeUsesSavedCredential, withoutClaudeVariables } from './claude.ts';
import { isPiUpstream, PI_UPSTREAMS, piSecret, piVersion, piShellSupported } from './pi.ts';
import { hasSecret, isSecretId } from './secrets.ts';

export interface RegistryConfig { policyVersion: string; probeTtlMs: number; codexQuotaThresholdPercent?: number;
  routing?: RoutingPolicy;
  /** The Runtime's home (AVH_HOME), where Provider credentials are saved; defaults to AVH_HOME. */
  home?: string;
  providers: ProviderConfig[] }
export function loadRegistryConfig(path: string): RegistryConfig {
  const data = JSON.parse(readFileSync(path, 'utf8')) as RegistryConfig;
  if (!data.policyVersion || !Number.isFinite(data.probeTtlMs) || data.probeTtlMs < 0 ||
    !Array.isArray(data.providers)) throw new Error('Invalid Provider registry config');
  if (data.codexQuotaThresholdPercent !== undefined &&
    (!Number.isFinite(data.codexQuotaThresholdPercent) || data.codexQuotaThresholdPercent < 0 ||
      data.codexQuotaThresholdPercent > 100)) throw new Error('Invalid Codex quota threshold');
  const ids = new Set<string>();
  for (const item of data.providers) {
    if (!item.id || ids.has(item.id) || !item.executable || !Array.isArray(item.roles))
      throw new Error(`Invalid or duplicate Provider ${item.id}`);
    if (!['codex-cli', 'claude-cli', 'legacy-dsh-task', 'agy-reviewer', 'pi-cli'].includes(item.adapter) ||
      !item.roles.every(role => ['executor', 'diagnostician', 'reviewer', 'research'].includes(role)) ||
      (item.adapter === 'agy-reviewer' && item.roles.some(role => role !== 'reviewer')) ||
      (item.adapter === 'pi-cli' && (!isPiUpstream(item.upstream) || !isSecretId(item.secret ?? PI_UPSTREAMS[item.upstream].secret))) ||
      (item.writable ?? []).some(path => !isAbsolute(path)))
      throw new Error(`Invalid Provider policy ${item.id}`);
    ids.add(item.id);
  }
  return data;
}
function command(executable: string, args: string[], scrubClaude = false): { ok: boolean; output: string } {
  const env = scrubClaude ? withoutClaudeVariables(process.env) : { ...process.env }; delete env.CLAUDECODE;
  const windows = process.platform === 'win32';
  // An npm-installed CLI is a .cmd shim on Windows, which Node cannot start without a shell; start what it runs.
  const [program, ...prefix] = windows ? commandFor(executable) : [executable];
  // stderr is piped, not inherited: `codex login status` reports on stderr, and a probe must not print into
  // whatever the caller is showing (CLI output, the TUI screen, service logs). Windows gets the dependency check's
  // 15 seconds: a first start of a large CLI (Claude Code's is over 200 MB) can wait for the virus scanner.
  try { return { ok: true, output: execFileSync(program!, [...prefix, ...args], { encoding: 'utf8', timeout: windows ? 15_000 : 5000,
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim() }; }
  catch { return { ok: false, output: '' }; }
}
/**
 * Adapters this platform does not run: on Windows the legacy DSH and agy adapters, which are Linux only (D5). Claude
 * runs on both; on Windows with a configuration directory of its own per Run and a saved credential (D4, claude.ts).
 */
export function unsupportedAdapter(adapter: ProviderConfig['adapter'], platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return undefined;
  if (adapter === 'legacy-dsh-task' || adapter === 'agy-reviewer') return `${adapter} 只在 Linux 上可用`;
  return undefined;
}
function latestQuota(root?: string): { usedPercent: number | null; observedAt: string | null } {
  if (!root) return { usedPercent: null, observedAt: null };
  const files: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    try { for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl'))
        files.push({ path, mtime: statSync(path).mtimeMs });
    } } catch { /* unavailable history is unknown quota */ }
  };
  walk(root, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  for (const file of files.slice(0, 3)) {
    try { for (const line of readFileSync(file.path, 'utf8').trim().split('\n').reverse()) {
      const value = JSON.parse(line) as { payload?: { rate_limits?: { primary?: { used_percent?: unknown } } } };
      const used = value.payload?.rate_limits?.primary?.used_percent;
      if (typeof used === 'number' && Number.isFinite(used))
        return { usedPercent: used, observedAt: new Date(file.mtime).toISOString() };
    } } catch { /* try older history */ }
  }
  return { usedPercent: null, observedAt: null };
}
export function probeProvider(config: ProviderConfig, ttlMs: number, prior?: ProviderProbe, home: string = avhHome()): ProviderProbe {
  const now = Date.now();
  // A Claude that signs in with a saved credential is probed as a Run starts it: no inherited ANTHROPIC_*/CLAUDE*.
  const savedCredential = config.adapter === 'claude-cli' && claudeUsesSavedCredential();
  const version = config.adapter === 'pi-cli' ? piVersion(config.executable) : command(config.executable, ['--version'], savedCredential);
  let auth: ProviderProbe['auth'] = 'unknown';
  if (config.adapter === 'codex-cli' && version.ok) {
    const status = command(config.executable, ['login', 'status']);
    auth = status.ok ? 'ready' : 'missing';
  } else if (savedCredential) {
    // Its login is what the person saved for Harness; ~/.claude is not read.
    auth = claudeCredentialSaved(home) ? 'ready' : 'missing';
  } else if (config.adapter === 'claude-cli' && version.ok) {
    const status = command(config.executable, ['auth', 'status']);
    try { auth = (JSON.parse(status.output) as { loggedIn?: boolean }).loggedIn ? 'ready' : 'missing'; }
    catch { auth = 'unknown'; }
  } else if (config.adapter === 'pi-cli') {
    // pi logs in with the person's API key, which Harness stores: "logged in" means the key is there, whether or not
    // pi itself can start right now.
    try { auth = hasSecret(home, piSecret(config)) ? 'ready' : 'missing'; } catch { auth = 'missing'; }
  }
  const legacy = config.adapter === 'legacy-dsh-task' || config.adapter === 'agy-reviewer';
  const script = config.toolRoot && legacy
    ? join(config.toolRoot, '通用工具', config.adapter === 'legacy-dsh-task' ? 'dsh_task.js' : 'agy_panel.py') : null;
  const reuseQuota = prior && Date.parse(prior.expiresAt) > now &&
    prior.version === (version.ok ? version.output : null) && prior.auth === auth;
  const quota = reuseQuota ? prior.quota : config.adapter === 'codex-cli' ? latestQuota(config.sessionRoot) :
    { usedPercent: null, observedAt: null };
  return { id: config.id, adapter: config.adapter,
    health: version.ok && auth !== 'missing' && (!legacy || (!!script && existsSync(script))) && !unsupportedAdapter(config.adapter) &&
      (config.adapter !== 'pi-cli' || piShellSupported(config, version.output))
      ? 'ready' : 'unavailable',
    version: version.ok ? version.output : null, auth,
    evidence: { version: version.ok ? 'probed' : 'unknown', auth: auth === 'unknown' ? 'unknown' : 'probed' },
    quota: { usedPercent: quota.usedPercent, observedAt: quota.observedAt,
      status: quota.usedPercent === null ? 'unknown' : 'probed' },
    capabilities: { ...config.capabilities }, observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString() };
}
export class ProviderRegistry {
  private readonly cache = new Map<string, ProviderProbe>();
  readonly config: RegistryConfig;
  constructor(config: RegistryConfig) { this.config = config; }
  discover(): ProviderConfig[] { return this.config.providers.map(item => ({ ...item })); }
  probe(config: ProviderConfig): ProviderProbe {
    const cached = this.cache.get(config.id);
    const result = probeProvider(config, this.config.probeTtlMs, cached, this.config.home);
    this.cache.set(config.id, result);
    return result;
  }
  invalidate(id: string): void { this.cache.delete(id); }
  snapshot(workflowId: string): ProviderSnapshot {
    return { workflowId, policyVersion: this.config.policyVersion, frozenAt: new Date().toISOString(),
      routing: this.config.routing ?? DEFAULT_ROUTING,
      providers: this.discover().map(config => ({ config, probe: this.probe(config) })) };
  }
  freeze(db: DatabaseSync, workflowId: string): ProviderSnapshot {
    const existing = db.prepare('SELECT snapshot_json FROM provider_snapshot WHERE workflow_id = ?')
      .get(workflowId) as { snapshot_json: string } | undefined;
    if (existing) return JSON.parse(existing.snapshot_json) as ProviderSnapshot;
    const snapshot = this.snapshot(workflowId);
    withStateEvent(db, { workflowId, actor: 'runtime', entityType: 'provider_snapshot',
      entityId: workflowId, action: 'frozen', reason: 'Workflow Provider registry initialized' }, () => {
      db.prepare('INSERT INTO provider_snapshot (workflow_id, snapshot_json) VALUES (?, ?)')
        .run(workflowId, JSON.stringify(snapshot));
    });
    return snapshot;
  }
  eligible(snapshot: ProviderSnapshot, role: ProviderConfig['roles'][number]): ProviderConfig[] {
    const threshold = this.config.routing?.codexQuotaThresholdPercent ?? this.config.codexQuotaThresholdPercent ?? DEFAULT_ROUTING.codexQuotaThresholdPercent;
    return snapshot.providers.filter(({ config, probe }) => config.roles.includes(role) &&
      probe.health === 'ready' && probe.auth !== 'missing' &&
      !(config.adapter === 'codex-cli' && probe.quota.usedPercent !== null &&
        probe.quota.usedPercent >= threshold)).map(item => item.config);
  }
}
