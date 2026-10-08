import { commandFor, hostPlatform } from '../host-platform.ts';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { Observation, RunHandle, RunSpec } from '../runtime/interfaces.ts';
import { createRunExecutor, type UnitExecutor, type CommandSpec, type UnitExecutorConfig } from '../exec/executor.ts';
import { bwrapWritablePaths, writablePaths } from '../exec/sandbox.ts';
import type { MaskedDir } from '../exec/write-boundary.ts';
import { avhHome } from '../config.ts';
import { claudeRunDirectories, claudeRunEnvironment, claudeSecretEnv, claudeUsesSavedCredential, gitBashPath } from './claude.ts';
import { parseProviderOutput } from './parse.ts';
import { probeProvider, unsupportedAdapter } from './registry.ts';
import { PI_AGENT_DIR, PI_SESSION_DIR, piBaseUrl, piCommand, piModel, piSecret, piSessionFiles, piUpstream, piPrompt, piTools } from './pi.ts';
import { redactSecretValues } from './secrets.ts';
import { sandboxOwner, type ProviderAdapter, type ProviderConfig, type ProviderProbe, type ProviderRequest, type ProviderResult } from './types.ts';
import { imageBytes } from '../image-inputs.ts';

/** Keep the credential and endpoint fixed; image tasks use the same service's declared visual model. */
export function providerForInput(config: ProviderConfig, request: ProviderRequest): ProviderConfig {
  if (request.toolProfile === 'coordination' && config.adapter === 'pi-cli') {
    if (config.allowedTools?.length && !config.allowedTools.includes('write')) throw new Error('此 AI 连接未允许写入协调结果');
    config = { ...config, allowedTools: ['write'] };
  }
  if (!request.inputImages?.length) return config;
  if (config.adapter === 'codex-cli') return config;
  if (config.adapter !== 'pi-cli') throw new Error('当前 AI 连接尚未接通图片传递，不能把图片任务作为纯文字执行');
  const model = config.imageModel ?? piUpstream(config).model;
  if (!model) throw new Error('当前 AI 连接没有声明可处理参考图的模型');
  return { ...config, model };
}

/** Tools a research Run may use when its Provider lists none; writes stay confined by the outer sandbox. */
export const RESEARCH_DEFAULT_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit'];

/** What a command depends on besides its Provider and request; tests set the platform to build the other one's command. */
export interface ProviderCommandHost {
  platform?: NodeJS.Platform;
  /** AVH_HOME, where Provider credentials are saved. */
  home?: string;
  /** Git Bash for a Windows Claude Run; found on this computer when not given, left out when there is none. */
  gitBash?: string;
}

export function providerCommand(config: ProviderConfig, request: ProviderRequest,
  project: string, runDirectory: string, host: ProviderCommandHost = {}): CommandSpec {
  config = providerForInput(config, request);
  if ((request.inputImages?.length ?? 0) > 8) throw new Error('一次最多使用 8 张参考图');
  for (const image of request.inputImages ?? []) {
    if (!hostPlatform.within(project, image.path) || imageBytes(image.path).sha256 !== image.sha256)
      throw new Error('参考图内容已改变或不在项目内');
  }
  const platform = host.platform ?? process.platform;
  if (config.adapter === 'agy-reviewer' && request.role !== 'reviewer')
    throw new Error('agy is Reviewer only');
  if (config.adapter === 'claude-cli' && config.settingsSources?.length)
    throw new Error('Claude settings sources are managed by Harness');
  if ((config.adapter === 'legacy-dsh-task' || config.adapter === 'agy-reviewer') && !config.toolRoot)
    throw new Error('Legacy Provider requires toolRoot');
  if (config.adapter === 'pi-cli') piUpstream(config);
  const readOnlyLegacy = config.adapter === 'legacy-dsh-task' && request.allowedWrites?.length === 0;
  if (readOnlyLegacy && config.engine === 'codex')
    throw new Error('Read-only legacy-dsh-task cannot use codex engine: dsh_task.js grants the workspace write access outside its root');
  // Windows starts what an npm .cmd shim would run (node and the package's script); elsewhere the name as configured.
  const program = process.platform === 'win32' ? commandFor(config.executable) : [config.executable];
  const promptFile = join(runDirectory, 'task.txt');
  hostPlatform.writePrivate(promptFile, config.adapter === 'pi-cli' ? piPrompt(config, request.prompt, platform === 'win32') : request.prompt, { flag: 'wx' });
  const resultFile = join(runDirectory, 'provider-result.json');
  let argv: string[];
  let stdinFile: string | undefined;
  let env: Record<string, string> | undefined;
  let secretEnv: Record<string, string> | undefined;
  if (config.adapter === 'codex-cli') {
    const writable = writablePaths(project, runDirectory,
      config.writable ?? [], request.allowedWrites);
    const protectedPaths = [...(config.stateDirs ?? []), ...(process.env.CODEX_HOME ? [process.env.CODEX_HOME] : [])]
      .flatMap(state => [state, join(dirname(state), 'AGENTS.md')]);
    for (const state of protectedPaths)
      if (writable.some(root => hostPlatform.within(root, state)))
        throw new Error(`Codex protected path falls within model writable root: ${state}`);
    argv = [...program, 'exec', '--skip-git-repo-check', '--json', '-o', join(runDirectory, 'last-message.txt'),
      // Session files stay on: the quota gate reads rate limits from them (registry.ts latestQuota). They are written
      // by the CLI process, not by model commands, whose writable roots exclude the state directory.
      '-s', 'workspace-write', '--ignore-user-config', '-c', 'features.memories=false', '-C', runDirectory,
      ...writable.flatMap(path => ['--add-dir', path]),
      ...(config.model ? ['-m', config.model] : []),
      ...(request.inputImages ?? []).flatMap(image => ['--image', image.path]),
      ...(config.effort ?? config.reasoningEffort ? ['-c', `model_reasoning_effort=${config.effort ?? config.reasoningEffort}`] : []), '-'];
    stdinFile = promptFile;
  } else if (config.adapter === 'pi-cli') {
    const command = piCommand(config, runDirectory, promptFile, program);
    command.argv.push(...(request.inputImages ?? []).map(image => `@${image.path}`));
    return { ...command, timeoutMs: config.timeoutMs,
      requireStableHead: request.allowedWrites !== undefined, runner: config.id };
  } else if (config.adapter === 'claude-cli') {
    const homeInstruction = config.stateDirs?.[0] && join(dirname(config.stateDirs[0]), 'CLAUDE.md');
    if (homeInstruction && bwrapWritablePaths(project, runDirectory,
      config.writable ?? [], request.allowedWrites).some(root => hostPlatform.within(root, homeInstruction)))
      throw new Error('Claude home instruction file falls within model writable root');
    // User settings are no longer loaded, so an unconfigured research Provider would get no tool at all. Default to
    // file tools: the outer bwrap sandbox, not this list, confines writes to the Run directory.
    const configured = config.allowedTools?.length ? config.allowedTools
      : request.role === 'research' ? RESEARCH_DEFAULT_TOOLS : [];
    const allowedTools = [...new Set([...configured, ...(request.role === 'research' ? ['Edit'] : [])])];
    // Windows (claude.ts): the Run's own configuration directory, a HOME for Git Bash and a saved credential by name.
    // Its settings file lives in that directory and spells out what --safe-mode already turns off.
    const saved = claudeUsesSavedCredential(platform);
    const directories = claudeRunDirectories(runDirectory);
    const settingsFile = saved ? directories.settings : join(runDirectory, 'claude-settings.json');
    if (saved) {
      hostPlatform.mkdirPrivate(directories.config); hostPlatform.mkdirPrivate(directories.home);
      env = claudeRunEnvironment(runDirectory, host.gitBash ?? gitBashPath());
      secretEnv = claudeSecretEnv(host.home ?? avhHome());
    }
    hostPlatform.writePrivate(settingsFile, JSON.stringify(saved
      ? { permissions: { allow: allowedTools }, disableAllHooks: true, autoMemoryEnabled: false }
      : { permissions: { allow: allowedTools } }), { flag: 'wx' });
    argv = [...program, '-p', '--output-format', 'stream-json', '--verbose',
      '--safe-mode', '--no-session-persistence', '--setting-sources', '', '--settings', settingsFile,
      ...(config.model ? ['--model', config.model] : []),
      ...(config.permissionMode ? ['--permission-mode', config.permissionMode] : []),
      // A Windows command line ends at 32,767 characters and a stage prompt may be longer: there Claude reads it
      // from stdin, as Codex does everywhere.
      ...(saved ? [] : [request.prompt]),
      ...(allowedTools.length ? ['--allowedTools', allowedTools.join(',')] : [])];
    if (saved) stdinFile = promptFile;
  } else {
    argv = config.adapter === 'legacy-dsh-task' ? [config.executable,
      join(config.toolRoot!, '通用工具', 'dsh_task.js'), '--task-file', promptFile,
      '--cwd', readOnlyLegacy ? runDirectory : project, '--json', resultFile, '--no-record', '--no-journal',
      ...(readOnlyLegacy ? ['--engine', 'dsh'] : config.engine ? ['--engine', config.engine] : [])] : [config.executable,
      join(config.toolRoot!, '通用工具', 'agy_panel.py'), '--task', promptFile,
      '--out', resultFile, ...(config.reviewMode ? [`--${config.reviewMode}`] : [])];
  }
  return { argv, cwd: config.adapter === 'legacy-dsh-task' && request.allowedWrites?.length !== 0 ? project : runDirectory,
    stdinFile, timeoutMs: config.timeoutMs,
    requireStableHead: request.allowedWrites !== undefined || config.adapter === 'legacy-dsh-task',
    runner: config.id, ...(env ? { env } : {}), ...(secretEnv ? { secretEnv } : {}) };
}

function instructionFiles(config: ProviderConfig, runDirectory: string, ownConfiguration = false): Array<{ path: string; sha256: string }> {
  const state = config.stateDirs?.[0];
  const home = state ? dirname(state) : undefined;
  // A Claude Run with its own configuration directory never sees the person's ~/.claude or ~/CLAUDE.md.
  const paths = config.adapter === 'claude-cli' && ownConfiguration
    ? [join(claudeRunDirectories(runDirectory).config, 'CLAUDE.md'), join(runDirectory, 'CLAUDE.md')]
    : config.adapter === 'claude-cli'
    ? [...(home ? [join(home, 'CLAUDE.md')] : []), ...(state ? [join(state, 'CLAUDE.md')] : []), join(runDirectory, 'CLAUDE.md')]
    : config.adapter === 'codex-cli'
      ? [...(home ? [join(home, 'AGENTS.md')] : []), ...(state ? [join(state, 'AGENTS.md')] : []),
        ...(process.env.CODEX_HOME ? [join(process.env.CODEX_HOME, 'AGENTS.md')] : []), join(runDirectory, 'AGENTS.md')]
      : [];
  return [...new Set(paths)].filter(path => existsSync(path) && lstatSync(path).isFile()).map(path => ({ path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
}

/** The configured state directory, or ~/.claude when it appeared only after the configuration was read. */
function claudeStateDir(config: ProviderConfig): string | undefined {
  if (config.stateDirs?.[0]) return config.stateDirs[0];
  const fallback = join(homedir(), '.claude');
  return existsSync(fallback) ? realpathSync(fallback) : undefined;
}
function claudeIsolation(config: ProviderConfig, runDirectory: string): MaskedDir {
  const directory = claudeStateDir(config);
  if (!directory) throw new Error('Claude state directory is required for isolated runs');
  const guardDirectory = join(runDirectory, 'claude-guard');
  hostPlatform.mkdirPrivate(join(guardDirectory, 'projects'));
  for (const name of ['settings.json', 'CLAUDE.md']) {
    const path = join(guardDirectory, name);
    if (!existsSync(path)) hostPlatform.writePrivate(path, '', { flag: 'wx' });
  }
  const file = (name: string) => join(directory, name);
  const regular = (path: string) => existsSync(path) && lstatSync(path).isFile();
  return { path: directory,
    readonlyRebinds: ['projects', 'settings.json', 'CLAUDE.md'].map(name => ({
      source: join(guardDirectory, name), target: file(name) })).concat(
      [file('.config.json')].filter(regular).map(path => ({ source: path, target: path }))),
    writableFiles: [file('.credentials.json')].filter(regular) };
}

/** Each adapter runs through WP4's persistent Run unit and keeps raw CLI output in its Run directory. */
export class ManagedProvider implements ProviderAdapter {
  readonly supportsResume = false;
  readonly executor: UnitExecutor;
  readonly config: ProviderConfig;
  readonly unit: Omit<UnitExecutorConfig, 'commandFor' | 'writableByRunner'>;
  readonly probeTtlMs: number;
  private readonly requests = new Map<string, ProviderRequest>();
  /** AVH_HOME: where the credentials a Run is given by name are saved. */
  private readonly home: string;
  constructor(config: ProviderConfig, unit: Omit<UnitExecutorConfig, 'commandFor' | 'writableByRunner'>,
    probeTtlMs = 60_000) {
    // Claude always runs inside Harness's sandbox (bwrap on Linux, the Low integrity token on Windows), never only its own.
    const savedCredential = config.adapter === 'claude-cli' && claudeUsesSavedCredential();
    if (config.adapter === 'claude-cli' && sandboxOwner(config) !== 'outer')
      throw new Error(savedCredential ? 'Claude CLI requires the outer Low integrity sandbox' : 'Claude CLI requires an outer bwrap sandbox');
    // pi has no sandbox of its own: the Runtime's (bwrap, or the Low integrity token on Windows) is its only boundary.
    if (config.adapter === 'pi-cli' && sandboxOwner(config) !== 'outer') throw new Error('pi requires the outer sandbox');
    if (config.adapter === 'pi-cli') piUpstream(config);
    const unsupported = unsupportedAdapter(config.adapter);
    if (unsupported) throw new Error(unsupported);
    this.config = config; this.unit = unit; this.probeTtlMs = probeTtlMs;
    const home = this.home = resolve(unit.harnessHome ?? avhHome());
    // Linux masks the person's ~/.claude; Windows gives each Run a configuration directory of its own (claude.ts).
    const isolation = config.adapter === 'claude-cli' && !savedCredential
      ? claudeIsolation(config, unit.runRoot) : undefined;
    this.executor = createRunExecutor({ ...unit,
      writableByRunner: { [config.id]: config.writable ?? [] },
      ...(isolation ? { maskedDirsByRunner: { [config.id]: [isolation] } } : {}),
      sandboxByRunner: { [config.id]: sandboxOwner(config) },
      requireSandboxByRunner: { [config.id]: config.adapter === 'claude-cli' || config.adapter === 'pi-cli' ||
        config.adapter === 'codex-cli' && sandboxOwner(config) === 'outer' },
      networkByRunner: { [config.id]: config.network ?? true },
      commandFor: (spec, directory) => {
        const request = this.requests.get(spec.runId);
        if (!request) throw new Error(`Missing Provider request for Run ${spec.runId}`);
        const effective = providerForInput(config, request);
        const command = providerCommand(config, request, unit.projectDirectory, directory, { home });
        const stateIsolation = isolation ? claudeIsolation(config, directory) : undefined;
        if (stateIsolation) command.maskedDirs = [stateIsolation];
        const own = savedCredential ? claudeRunDirectories(directory) : undefined;
        hostPlatform.writePrivate(join(directory, 'provider-request.json'), JSON.stringify({ ...request,
          provider: config.id, startedAt: new Date().toISOString(),
          requestedModel: effective.adapter === 'pi-cli' ? piModel(effective) : effective.model ?? null,
          ...(request.inputImages?.length ? { modelSelection: 'image input; same upstream and credential; declared capability' } : {}),
          settingsSource: own ? own.settings : config.adapter === 'claude-cli' ? join(directory, 'claude-settings.json') :
            config.adapter === 'codex-cli' ? 'CLI defaults with --ignore-user-config; features.memories=false' :
            config.adapter === 'pi-cli' ? `${join(directory, PI_AGENT_DIR)} (PI_CODING_AGENT_DIR for this Run; ~/.pi is not read)` : 'provider default',
          statePolicy: stateIsolation ? { directory: stateIsolation.path,
            writableFiles: stateIsolation.writableFiles,
            readonlyFiles: stateIsolation.readonlyRebinds.filter(item => item.source === item.target).map(item => item.source),
            protectedPaths: ['projects', 'settings.json', 'CLAUDE.md'],
            sessionLog: join(directory, 'stdout.log') } : own ? { configDirectory: own.config, home: own.home,
              // Names only: the unit wrapper reads the value when it starts the command.
              credential: command.secretEnv, personalConfiguration: 'not used (~/.claude and ~/.claude.json)',
              sessionLog: join(directory, 'stdout.log') } : config.adapter === 'pi-cli' ? { writableRoots: config.writable ?? [],
              configDirectory: join(directory, PI_AGENT_DIR), sessionDirectory: join(directory, PI_SESSION_DIR),
              upstream: config.upstream, model: piModel(effective), endpoint: piBaseUrl(config) ?? `pi built-in ${piUpstream(config).provider}`,
              tools: piTools(effective), retryPolicy: 'pi-agent-session/2-retries; SDK retries disabled; no whole-Run replay',
              // Names only: the value reaches the command's environment when it starts, never this record.
              credential: { variable: Object.keys(command.secretEnv ?? {})[0], secret: piSecret(config) } }
            : { writableRoots: config.writable ?? [], stateDirectoriesWritableByModel: false },
          automaticMemory: own ? 'disabled (--safe-mode; autoMemoryEnabled=false)' : config.adapter === 'claude-cli' ? 'disabled (--safe-mode)' :
            config.adapter === 'codex-cli' ? 'disabled (features.memories=false)' :
            config.adapter === 'pi-cli' ? 'none (pi keeps no memory; --no-context-files --no-extensions --no-skills --no-prompt-templates)' : 'unknown',
          ...(own ? { hooks: 'disabled (--safe-mode; disableAllHooks=true)' } : {}),
          instructionFiles: instructionFiles(config, directory, savedCredential),
        }), { flag: 'wx' });
        return command;
      } });
  }
  discover(): ProviderConfig { return { ...this.config }; }
  async probe(): Promise<ProviderProbe> { return probeProvider(this.config, this.probeTtlMs, undefined, this.home); }
  async start(request: ProviderRequest): Promise<RunHandle> {
    this.requests.set(request.runId, request);
    try { return await this.executor.start(request); }
    finally { this.requests.delete(request.runId); }
  }
  observe(handle: RunHandle): Observation { return this.executor.observe(handle); }
  cancel(handle: RunHandle): Promise<'confirmed' | 'not_confirmed'> { return this.executor.cancel(handle); }
  collect(handle: RunHandle): ProviderResult {
    const result = this.executor.collect(handle);
    const runId = this.executor.runIdOf(handle);
    const directory = join(this.unit.runRoot, runId);
    const saved = JSON.parse(readFileSync(join(directory, 'provider-request.json'), 'utf8')) as
      ProviderRequest & { startedAt: string; requestedModel?: string | null };
    // A credential the command held may have been printed (pi's shell tool inherits it); it leaves the logs before they are read.
    const { secretEnv } = JSON.parse(readFileSync(join(directory, 'command.json'), 'utf8')) as { secretEnv?: Record<string, string> };
    if (secretEnv) redactSecretValues(this.unit.harnessHome ?? hostPlatform.dataHome(), secretEnv, [join(directory, 'stdout.log'),
      join(directory, 'stderr.log'), ...piSessionFiles(directory)]);
    const raw = readFileSync(join(directory, 'stdout.log'), 'utf8');
    const stderr = readFileSync(join(directory, 'stderr.log'), 'utf8');
    let structured: string | undefined;
    try { structured = readFileSync(join(directory, 'provider-result.json'), 'utf8'); } catch { /* protocol parser handles missing output */ }
    const parsed = parseProviderOutput(this.config.adapter, raw, stderr, result.exitStatus,
      saved, this.config.id, saved.startedAt, new Date().toISOString(), structured,
      (result as typeof result & { timedOut?: boolean }).timedOut);
    parsed.requestedModel = saved.requestedModel === undefined
      ? this.config.adapter === 'pi-cli' ? piModel(this.config) : this.config.model ?? null : saved.requestedModel;
    parsed.outOfBoundsPaths = result.outOfBoundsPaths;
    parsed.scanEvidence = result.scanEvidence;
    parsed.externalChanges = result.externalChanges;
    parsed.artifacts = this.config.adapter === 'codex-cli' ? [join(directory, 'last-message.txt')] :
      this.config.adapter === 'pi-cli' ? piSessionFiles(directory) :
      structured ? [join(directory, 'provider-result.json')] : [];
    return parsed;
  }
}
