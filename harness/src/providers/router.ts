import type { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import type { Executor, Observation, RunHandle, RunResult, RunSpec } from '../runtime/interfaces.ts';
import type { UnitExecutorConfig } from '../exec/executor.ts';
import { ManagedProvider } from './adapter.ts';
import { ProviderRegistry } from './registry.ts';
import type { ProviderRequest } from './types.ts';
import { routeProviders, DEFAULT_ROUTING } from './routing.ts';
import { promptEvidence } from '../run/evidence.ts';
import { selectProviderWithManifest } from '../run/manifest.ts';

/** Routing uses the persisted Workflow snapshot; a later config edit cannot change an active Run. */
export class ProviderRouter implements Executor {
  private readonly adapters = new Map<string, ManagedProvider>();
  readonly db: DatabaseSync;
  readonly registry: ProviderRegistry;
  readonly unit: Omit<UnitExecutorConfig, 'commandFor' | 'writableByRunner'>;
  readonly requestFor: (spec: RunSpec) => ProviderRequest;
  constructor(db: DatabaseSync, registry: ProviderRegistry,
    unit: Omit<UnitExecutorConfig, 'commandFor' | 'writableByRunner'>,
    requestFor?: (spec: RunSpec) => ProviderRequest) {
    this.db = db; this.registry = registry; this.unit = unit;
    this.requestFor = requestFor ?? (spec => {
      const task = this.db.prepare(`SELECT t.goal, w.plan_json, p.path AS project_path FROM task t
        JOIN workflow w ON w.id=t.workflow_id JOIN project p ON p.id=w.project_id WHERE t.id = ?`)
        .get(spec.taskId) as { goal: string; plan_json: string; project_path: string } | undefined;
      if (!task) throw new Error(`Unknown Task ${spec.taskId}`);
      const plan = JSON.parse(task.plan_json) as { task?: { allowedWrites?: string[] } };
      const allowedWrites = plan.task?.allowedWrites?.map(path => resolve(task.project_path, path)) ?? [task.project_path];
      const directory = join(this.unit.runRoot, spec.runId);
      const prior = this.db.prepare('SELECT id, result_json FROM run WHERE task_id=? AND attempt<? ORDER BY attempt DESC LIMIT 1')
        .get(spec.taskId, spec.attempt) as { id: string; result_json: string | null } | undefined;
      const verdicts = prior ? this.db.prepare('SELECT check_id, result, basis FROM verdict WHERE id LIKE ? ORDER BY check_id')
        .all(`${prior.id}:%`) as { check_id: string; result: string; basis: string | null }[] : [];
      const reason = prior ? this.db.prepare(`SELECT reason FROM event WHERE entity_type='task' AND entity_id=?
        AND (reason LIKE 'Run failed:%' OR action LIKE '%->BLOCKED') ORDER BY seq DESC LIMIT 1`)
        .get(spec.taskId) as { reason: string } | undefined : undefined;
      const failure = promptEvidence(prior ? [reason?.reason ?? `Run ${prior.id} failed`, prior.result_json ?? '',
        ...verdicts.map(item => `${item.check_id}: ${item.result}; ${item.basis ?? ''}`)].join('\n') : '', directory);
      const prompt = [`Project: ${task.project_path}`, `Run directory: ${directory}`,
        allowedWrites.length ? `Allowed writes: ${allowedWrites.join(', ')}` : '只读：不得改动项目内任何文件',
        'Run 目录始终可写，它不在上面的限制内：上面的限制只针对项目文件。',
        `Expected outputs: ${spec.expectedOutputs.map(path => path.startsWith('run:')
          ? resolve(directory, path.slice(4)) : resolve(task.project_path, path)).join(', ')}`,
        ...(spec.expectedOutputs.length ? ['Expected outputs 必须由你实际写出到上述路径；只在回复里给出内容不算完成。'] : []),
        '不要 git commit、不要改允许范围外的文件、不要启动 Unity（需要 Unity 的步骤由 Runtime 执行）。',
        `Goal:\n${task.goal}`,
        ...(failure.text ? [`Previous Run failure and check evidence:\n${failure.text}`] : [])].join('\n');
      return { ...spec, allowedWrites, role: 'executor', prompt };
    });
  }
  private fromSnapshot(provider: string, workflowId: string): ManagedProvider {
    const row = this.db.prepare('SELECT snapshot_json FROM provider_snapshot WHERE workflow_id = ?')
      .get(workflowId) as { snapshot_json: string } | undefined;
    if (!row) throw new Error('Provider snapshot missing');
    const snapshot = JSON.parse(row.snapshot_json) as ReturnType<ProviderRegistry['snapshot']>;
    const selected = snapshot.providers.find(item => item.config.id === provider)?.config;
    if (!selected) throw new Error(`Provider absent from frozen snapshot: ${provider}`);
    let adapter = this.adapters.get(provider);
    if (!adapter) { adapter = new ManagedProvider(selected, this.unit); this.adapters.set(provider, adapter); }
    return adapter;
  }
  private adapter(handle: RunHandle): { adapter: ManagedProvider; inner: RunHandle } {
    const split = handle.ref.indexOf('|');
    if (split < 1) throw new Error('Invalid Provider handle');
    const provider = handle.ref.slice(0, split);
    const row = this.db.prepare('SELECT r.id, t.workflow_id FROM run r JOIN task t ON t.id = r.task_id WHERE r.process_ref = ?')
      .get(handle.ref) as { id: string; workflow_id: string } | undefined;
    if (!row) throw new Error(`Unknown Run handle ${handle.ref}`);
    const adapter = this.fromSnapshot(provider, row.workflow_id);
    return { adapter, inner: { ref: handle.ref.slice(split + 1) } };
  }
  async start(spec: RunSpec): Promise<RunHandle> {
    const request = this.requestFor(spec);
    const snapshot = this.registry.freeze(this.db, spec.workflowId);
    const decision = routeProviders(snapshot, request.role, snapshot.routing ?? this.registry.config.routing ?? DEFAULT_ROUTING);
    if (!decision.selected) throw Object.assign(new Error(`No eligible Provider: ${decision.reason}`),
      { errorClass: 'tool_failure', noSideEffects: true });
    const selected = decision.selected;
    const adapter = this.fromSnapshot(selected.id, spec.workflowId);
    const handle = await adapter.start(request);
    const project = this.unit.projectDirectory;
    const directory = join(this.unit.runRoot, spec.runId);
    selectProviderWithManifest(this.db, undefined, spec.workflowId, spec.runId, selected.id, decision.reason,
      directory, project);
    return { ref: `${selected.id}|${handle.ref}` };
  }
  observe(handle: RunHandle): Observation { const { adapter, inner } = this.adapter(handle); return adapter.observe(inner); }
  cancel(handle: RunHandle): Promise<'confirmed' | 'not_confirmed'> {
    const { adapter, inner } = this.adapter(handle); return adapter.cancel(inner);
  }
  collect(handle: RunHandle): RunResult { const { adapter, inner } = this.adapter(handle); return adapter.collect(inner); }
}
