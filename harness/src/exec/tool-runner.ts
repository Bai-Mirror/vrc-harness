import { join } from 'node:path';
import type { Observation, RunHandle, RunResult, RunSpec } from '../runtime/interfaces.ts';
import { hostPlatform } from '../host-platform.ts';
import { createRunExecutor, type UnitExecutor, type UnitExecutorConfig } from './executor.ts';

/**
 * A deterministic stage step (a knowledge-layer tool, not a model) run as a supervised Run unit: same write
 * boundary, out-of-bounds scan, cancellation and recovery as a Provider. Network is disabled unless the frozen
 * trusted capability explicitly enables it. It runs in the Run
 * directory; the project is reached through `{project}` in its argv or `$AVH_PROJECT_DIR`.
 */
export interface ToolRequest extends RunSpec { argv: string[]; env: Record<string, string> }
export class ToolRunner {
  readonly executor: UnitExecutor;
  readonly unit: Omit<UnitExecutorConfig, 'commandFor' | 'writableByRunner'>;
  private readonly requests = new Map<string, ToolRequest>();
  constructor(unit: Omit<UnitExecutorConfig, 'commandFor' | 'writableByRunner'>, network = false) {
    this.unit = unit;
    // A preventing sandbox is required: a tool never falls back to scan-only detection. The Runtime's own bwrap comes
    // first, so what a tool sees inside its writable directories is only what is there.
    this.executor = createRunExecutor({ ...unit,
      writableByRunner: { tool: [] }, sandboxByRunner: { tool: 'outer' }, requireSandboxByRunner: { tool: true },
      preferBwrapByRunner: { tool: true },
      networkByRunner: { tool: network },
      commandFor: (spec, directory) => {
        const request = this.requests.get(spec.runId);
        if (!request) throw new Error(`Missing tool request for Run ${spec.runId}`);
        hostPlatform.writePrivate(join(directory, 'tool-request.json'), JSON.stringify({ argv: request.argv,
          allowedWrites: request.allowedWrites ?? [], startedAt: new Date().toISOString() }), { flag: 'wx' });
        // cwd is the Run directory as for Providers: a sandbox may treat cwd as writable, the project must not be.
        return { runner: 'tool', argv: request.argv, cwd: directory, env: request.env, requireStableHead: true };
      } });
  }
  async start(request: ToolRequest): Promise<RunHandle> {
    this.requests.set(request.runId, request);
    try { return await this.executor.start(request); }
    finally { this.requests.delete(request.runId); }
  }
  observe(handle: RunHandle): Observation { return this.executor.observe(handle); }
  cancel(handle: RunHandle): Promise<'confirmed' | 'not_confirmed'> { return this.executor.cancel(handle); }
  collect(handle: RunHandle): RunResult {
    const result = this.executor.collect(handle);
    return result.exitStatus === 0 ? result : { ...result, errorClass: result.errorClass ?? 'tool_failure',
      errorMessage: result.errorMessage ?? `tool exited ${result.exitStatus}` };
  }
}
