import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { hostPlatform, type HostPlatform } from '../host-platform.ts';
import { hasSecret } from './secrets.ts';

/**
 * Claude Code on Windows (D4 in docs/windows-handoff.md). On Linux a Claude Run uses the person's own login: bwrap masks
 * ~/.claude except its credentials file. Integrity labels cannot express that mask, and copying the login is no answer
 * either: OAuth refresh tokens rotate, so a copy would break the person's own sign-in. On Windows each Run therefore gets
 * a configuration directory of its own inside its Run directory (CLAUDE_CONFIG_DIR, writable at Low integrity like the
 * rest of the Run), and signs in with a credential the person saved for Harness: a long-lived token from
 * `claude setup-token`, or an Anthropic API key. Claude never reads or writes ~/.claude or ~/.claude.json there.
 */
export const CLAUDE_CREDENTIALS = [
  { id: 'claude-oauth-token', env: 'CLAUDE_CODE_OAUTH_TOKEN' },
  { id: 'claude-api-key', env: 'ANTHROPIC_API_KEY' },
] as const;

/** Whether Claude Runs on this platform sign in with a credential saved in Harness instead of the person's login. */
export function claudeUsesSavedCredential(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}
/** Whether the person saved a Claude credential for Harness. */
export function claudeCredentialSaved(home: string): boolean {
  return CLAUDE_CREDENTIALS.some(credential => hasSecret(home, credential.id));
}
/**
 * The credential a Run is given, by name (CommandSpec.secretEnv): the long-lived token when it is saved, else the API
 * key. Exactly one, so Claude cannot pick between two. With neither saved it names the token, and the executor refuses
 * to start the Run with that name before anything is recorded.
 */
export function claudeSecretEnv(home: string): Record<string, string> {
  const credential = CLAUDE_CREDENTIALS.find(item => hasSecret(home, item.id)) ?? CLAUDE_CREDENTIALS[0];
  return { [credential.env]: credential.id };
}

/** Where a Windows Claude Run keeps its state: all of it inside the Run directory. */
export function claudeRunDirectories(runDirectory: string): { config: string; home: string; settings: string } {
  const config = join(runDirectory, 'claude-config');
  return { config, home: join(runDirectory, 'home'), settings: join(config, 'settings.json') };
}

/**
 * Git Bash, through which Claude Code on Windows runs its Bash tool: beside the Git Harness itself uses (AVH_TOOL_GIT,
 * then PATH; `<Git>\cmd\git.exe` and `<Git>\mingw64\bin\git.exe` both lead to `<Git>\bin\bash.exe`), else Git for
 * Windows' install folders. The `bash.exe` on PATH is usually WSL's, never the one wanted here.
 */
export function gitBashPath(host: HostPlatform = hostPlatform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const git = host.toolCommand('git');
  const beside = isAbsolute(git) ? [join(dirname(git), '..', 'bin', 'bash.exe'), join(dirname(git), '..', '..', 'bin', 'bash.exe')] : [];
  const installed = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]
    .filter((root): root is string => !!root).map(root => join(root, 'Git', 'bin', 'bash.exe'));
  return [...beside, ...installed].find(path => existsSync(path));
}

/**
 * The variables a Windows Claude Run is started with, on top of the Run environment (which inherits no ANTHROPIC_* or
 * CLAUDE* variable, see windowsRunEnvironment): its own configuration directory, and for Git Bash a HOME in the Run
 * directory. The Run's temp directory is set by the unit wrapper for every sandboxed Run.
 */
export function claudeRunEnvironment(runDirectory: string, bash: string | undefined): Record<string, string> {
  const directories = claudeRunDirectories(runDirectory);
  return { CLAUDE_CONFIG_DIR: directories.config, HOME: directories.home, ...(bash ? { CLAUDE_CODE_GIT_BASH_PATH: bash } : {}) };
}

/** Names of the variables Claude Code and the Anthropic SDK read (and a Claude Code session sets for its children). */
export const CLAUDE_VARIABLE = /^(ANTHROPIC|CLAUDE)/i;
/** An environment without any of those variables: what a Claude process Harness starts may inherit. */
export function withoutClaudeVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CLAUDE_VARIABLE.test(name)));
}
