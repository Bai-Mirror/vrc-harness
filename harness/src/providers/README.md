# CLI Providers

`ProviderRegistry` loads a JSON config via `loadRegistryConfig(path)`. Its `providers` array
contains IDs, adapter names, executable paths, allowed roles, optional model IDs, tool roots,
settings sources and writable paths. The caller supplies the config path and all project,
repository and Run directories. No account paths or model IDs are built into the adapters.

At Workflow initialization, pass the registry to `SchedulerConfig.providerRegistry` and use
`ProviderRouter` as the Scheduler executor. The first `tick()` freezes the probed registry in
`provider_snapshot`; the router reads that row for every dispatch. By default the router
uses the Task goal for an executor request; callers may supply `requestFor(spec)` with a
full prompt and role. Existing Workflows retain their snapshot after
configuration changes. Probe cache entries expire after `probeTtlMs`, and `invalidate(id)`
forces a new probe after a CLI or auth change. Unknown quota stays null. Routing uses the
frozen timezone, work windows, quota threshold and Provider roles. A DSH balance check
with nonzero or unknown result excludes that Provider.

All five adapters implement `discover / probe / start / observe / cancel / collect`.
`supportsResume` is false. agy accepts only reviewer requests. Codex reads its task from
stdin; Claude uses a Run-local `--settings` file with no hooks, empty `--setting-sources`,
`--safe-mode`, and `--no-session-persistence`. Research runs include `Edit` in their allowed tools.
The legacy DSH adapter uses `--no-record --no-journal`; the executor checks writes outside
the project and rejects a moved HEAD. CLI output is stored in each Run directory. A zero CLI
exit only advances the Scheduler to independent verification.

Codex event token counts are measured values from the CLI stream. Claude's
`total_cost_usd` is a client estimate. Missing usage or quota remains unknown.
`sessionRoot` is optional for Codex quota history; when omitted, quota remains unknown.
The registry does not copy authentication tokens; on Windows it only checks whether a Claude credential is saved.

Claude runs require bwrap. Its state directory is covered by tmpfs. Existing
`.credentials.json` is rebound as one writable file for token refresh, while an
existing `.config.json` is rebound read-only. `projects/`, `settings.json`, and
`CLAUDE.md` are covered by read-only Run-local guards; stream-json events are
kept in the Run's `stdout.log`. If bwrap cannot be proven, the Run fails before
launch instead of falling back to a scan. Codex keeps its state directory outside
both `--add-dir` and executor writable roots, uses `--ignore-user-config` with
`features.memories=false`, and keeps stream-json events in the Run. Session files
stay enabled because the quota gate reads rate limits from them; the CLI process
writes them, never model commands. `provider-request.json` records settings,
state mounts, memory status, and discovered instruction file hashes.

On Windows (`claude.ts`) Claude cannot keep the person's login behind a mask: integrity labels cannot express it,
and a copy of a rotating OAuth login would break the original. Each Run instead runs at Low integrity with its own
`CLAUDE_CONFIG_DIR` (`<Run>/claude-config`, which also holds the Run's `settings.json` with hooks and automatic memory
off) and a `HOME` for Git Bash in the Run directory, and signs in with a credential saved for Harness: the long-lived
token from `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`) or an Anthropic API key (`ANTHROPIC_API_KEY`), passed by
name through `CommandSpec.secretEnv`. The prompt goes through stdin, because a Windows command line is limited to
32,767 characters. The probe asks only `claude --version` and whether a credential is saved; no ANTHROPIC_* or CLAUDE*
variable of the Runtime reaches a Run or a probe.

`self` Providers use the CLI's own sandbox; `outer` Providers probe Codex sandbox first,
bwrap second, then a Git scan fallback. Both outer probes require a successful allowed write and a blocked
outside write. The Git scan includes committed paths outside the project, so an outside
commit cannot hide a change by returning the worktree to clean status. Ignored files and
paths outside the configured repository remain outside fallback scan coverage.
`UnitExecutorConfig.codexSandboxExecutable` and optional `codexSandboxProfile` select the
local Codex sandbox CLI and a named permission profile when that CLI requires one.

`pi-cli` (`pi.ts`) runs the pi coding agent CLI against DeepSeek or Zhipu GLM with the person's own API key. It
requires the outer sandbox. Each Run gets its own pi configuration and session directories inside the Run directory
(`PI_CODING_AGENT_DIR`, `--session-dir`), no context files, extensions or skills, and `PI_OFFLINE=1`; the prompt goes to
stdin and the key arrives through `CommandSpec.secretEnv` as `DEEPSEEK_API_KEY` or `ZAI_API_KEY`. GLM mainland points
pi's `zai` provider at open.bigmodel.cn in a Run-local `models.json`. `pi --mode json` exits 0 when the service refused a
request, so `parsePiEvents` reads the last assistant message: an `error` or `aborted` stop reason fails the Run, classified
from the service's HTTP status and wording as `auth`, `rate_limit`, `network` or `tool_failure`. After the Run,
`ManagedProvider.collect` replaces any printed credential in the logs and session files before parsing them. The probe
reports `pi --version` and whether the key is stored; quota stays unknown. `test/providers/pi.test.ts` runs the real CLI
when `AVH_PI_CLI` names it, against no key and against a stand-in service on 127.0.0.1.

`AVH_PROVIDER_IT=1` enables real CLI integration tests. They must run only in temporary
repositories and should be invoked once per Provider with a minimal task.
