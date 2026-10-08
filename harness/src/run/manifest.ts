import { hostPlatform } from '../host-platform.ts';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { platform, release } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { LocalConfig } from '../config.ts';
import { harnessVersion, knowledgeVersion } from '../provenance.ts';
import type { ProviderSnapshot } from '../providers/types.ts';
import { withStateEvent } from '../state/tx.ts';
import type { Truncation } from './evidence.ts';

const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
// Identify the loaded Runtime, not later edits to its checkout. Avoid a blocking Git scan per dispatch.
const runtimeVersion = harnessVersion();
function json(path: string): Record<string, unknown> | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return undefined; }
}
function head(path: string): string {
  try { return execFileSync(hostPlatform.toolCommand('git'), ['-C', path, 'rev-parse', '--short=12', 'HEAD'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); }
  catch { return 'unknown:no-git-head'; }
}
export interface RunManifest {
  schema: 'avh-run-manifest/1'; harness_version: string; knowledge_version: string;
  provider_snapshot: { ref: string; provider_id: string; model: string; cli_version: string };
  prompt: { path: string; sha256: string }; tool_root_head?: string;
  truncated: Truncation[];
  observability: { settings_source: unknown; state_policy: unknown; automatic_memory: unknown; instruction_files: unknown };
  environment: { os: string; kernel: string; node: string; sandbox: string; unity_version?: string;
    writeBoundary: { kind: string; strength: string };
    sandbox_capabilities: { writable_roots: unknown; readonly_git_paths: unknown; network: unknown; state_isolation: unknown };
    project_head: string; project_dirty: boolean | 'unknown' };
}
export function buildRunManifest(db: DatabaseSync, config: LocalConfig | undefined, workflowId: string,
  providerId: string, runDirectory: string, project: string, truncated: Truncation[] = [], unity = false): RunManifest {
  const saved = db.prepare('SELECT snapshot_json FROM provider_snapshot WHERE workflow_id = ?')
    .get(workflowId) as { snapshot_json: string } | undefined;
  const snapshot = saved ? JSON.parse(saved.snapshot_json) as ProviderSnapshot : undefined;
  const selected = snapshot?.providers.find(item => item.config.id === providerId);
  const request = json(join(runDirectory, 'provider-request.json'));
  const command = json(join(runDirectory, 'command.json'));
  const scope = json(join(runDirectory, 'scope-before.json'));
  const prompt = join(runDirectory, 'task.txt');
  let unityVersion: string | undefined;
  if (unity) {
    try { unityVersion = /^m_EditorVersion:\s*(.+)$/m.exec(readFileSync(join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8'))?.[1]?.trim() ?? 'unknown'; }
    catch { unityVersion = 'unknown'; }
  }
  const toolRoot = selected?.config.toolRoot;
  const manifest: RunManifest = {
    schema: 'avh-run-manifest/1', harness_version: runtimeVersion,
    knowledge_version: config ? knowledgeVersion(config) : 'unknown:configuration-unavailable',
    provider_snapshot: { ref: `provider_snapshot:${workflowId}`, provider_id: providerId,
      model: selected?.config.model ?? 'unknown', cli_version: selected?.probe.version ?? 'unknown' },
    prompt: { path: prompt, sha256: existsSync(prompt) ? hash(readFileSync(prompt)) : 'unknown:missing-task' },
    ...(toolRoot ? { tool_root_head: head(toolRoot) } : {}), truncated: truncated.length ? truncated :
      existsSync(join(runDirectory, 'failure-evidence.txt')) ? [{ what: 'previous_run_failure',
        originalLength: readFileSync(join(runDirectory, 'failure-evidence.txt'), 'utf8').length,
        keptLength: 1500, fullRef: join(runDirectory, 'failure-evidence.txt') }] : [],
    observability: { settings_source: request?.settingsSource ?? 'unknown',
      state_policy: request?.statePolicy ?? 'unknown', automatic_memory: request?.automaticMemory ?? 'unknown',
      instruction_files: request?.instructionFiles ?? 'unknown' },
    environment: { os: platform(), kernel: release(), node: process.version,
      sandbox: typeof command?.sandbox === 'string' ? command.sandbox : 'unknown',
      writeBoundary: command?.writeBoundary && typeof command.writeBoundary === 'object'
        ? command.writeBoundary as { kind: string; strength: string }
        : { kind: typeof command?.sandbox === 'string' ? command.sandbox : 'unknown', strength: 'unknown' },
      sandbox_capabilities: { writable_roots: command?.writable ?? 'unknown',
        readonly_git_paths: command?.readonlyGitPaths ?? 'unknown',
        network: command?.network ?? 'unknown', state_isolation: command?.stateIsolation ?? 'unknown' },
      project_head: typeof scope?.head === 'string' ? scope.head :
        existsSync(join(runDirectory, 'head-before.txt')) ? readFileSync(join(runDirectory, 'head-before.txt'), 'utf8').trim() : 'unknown',
      project_dirty: scope?.status && typeof scope.status === 'object' ? Object.keys(scope.status).length > 0 : 'unknown',
      ...(unity ? { unity_version: unityVersion ?? 'unknown' } : {}) },
  };
  return manifest;
}
/** The committed event is authoritative; the file is a replaceable copy. */
export function materializeRunManifest(db: DatabaseSync, runId: string, runDirectory: string): RunManifest {
  const row = db.prepare("SELECT payload_json FROM event WHERE entity_type='run' AND entity_id=? AND action='provider_selected' ORDER BY seq LIMIT 1")
    .get(runId) as { payload_json: string } | undefined;
  if (!row) throw new Error(`Run ${runId}: provider_selected event missing`);
  const manifest = (JSON.parse(row.payload_json) as { manifest: RunManifest }).manifest;
  if (!manifest || manifest.schema !== 'avh-run-manifest/1') throw new Error(`Run ${runId}: manifest payload missing`);
  hostPlatform.writePrivate(join(runDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), {});
  return manifest;
}
export function selectProviderWithManifest(db: DatabaseSync, config: LocalConfig | undefined, workflowId: string,
  runId: string, providerId: string, reason: string, runDirectory: string, project: string,
  truncated: Truncation[] = [], unity = false): RunManifest {
  const prior = db.prepare("SELECT 1 FROM event WHERE entity_type='run' AND entity_id=? AND action='provider_selected' LIMIT 1")
    .get(runId);
  if (!prior) {
    const manifest = buildRunManifest(db, config, workflowId, providerId, runDirectory, project, truncated, unity);
    withStateEvent(db, { workflowId, actor: 'runtime', entityType: 'run', entityId: runId,
      action: 'provider_selected', reason, payload: { manifest } },
    () => db.prepare('UPDATE run SET provider = ? WHERE id = ?').run(providerId, runId));
  }
  return materializeRunManifest(db, runId, runDirectory);
}
