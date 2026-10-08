import { spawn, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { commandFor, hostPlatform } from '../host-platform.ts';
import { claudeUsesSavedCredential, withoutClaudeVariables } from '../providers/claude.ts';

/**
 * The Claude part of first run and settings on Windows, served by the GUI host (it runs in the person's session, as
 * the dependency installs do). Claude Code signs in there with a credential saved for Harness (providers/claude.ts):
 * the person gets a long-lived token from `claude setup-token` and pastes it into a masked field.
 */
export interface ClaudeLoginStatus {
  /** Whether Claude Runs on this computer need a saved token or API key (Windows); elsewhere the person's own login. */
  required: boolean;
  /** Whether the `claude` command is found, so the setup-token window can start it. */
  installed: boolean;
}
export function claudeLoginStatus(platform: NodeJS.Platform = process.platform): ClaudeLoginStatus {
  return { required: claudeUsesSavedCredential(platform), installed: hostPlatform.resolveExecutable('claude') !== 'claude' };
}

/**
 * How `claude setup-token` is started in a console window of its own. `start` gives the window its console: the GUI
 * host of the desktop app has none that anyone can see, and a child would share it. `cmd /k` keeps the window open
 * after Claude has printed the token, so the person can copy it; they close it themselves. With /s, the inner cmd
 * strips only the outer pair of quotes, so a program path with spaces, parentheses or an @ (npm's @anthropic-ai)
 * survives. The outer cmd sees that path unquoted, so a path with a character it would act on (& | < > ^ %, or a
 * quote, which no Windows path has) is refused. No ANTHROPIC_* or CLAUDE* variable of the GUI host's reaches it: a key
 * in the person's environment would change what Claude does.
 */
export function setupTokenLaunch(claude: string[], env: NodeJS.ProcessEnv = process.env):
  { file: string; args: string[]; options: SpawnOptions } {
  if (!claude.length || claude.some(part => /["%&|<>^\r\n]/.test(part)))
    throw new Error(`Claude Code 的路径里有命令行窗口无法安全传递的字符（" % & | < > ^）：${claude.join(' ')}`);
  const line = [...claude.map(part => `"${part}"`), 'setup-token'].join(' ');
  return { file: env.ComSpec || 'cmd.exe',
    args: ['/d', '/c', 'start', '"Claude Code setup-token"', 'cmd.exe', '/d', '/s', '/k', `"${line}"`],
    options: { cwd: env.USERPROFILE || homedir(), env: withoutClaudeVariables(env), detached: true, stdio: 'ignore',
      windowsHide: false, windowsVerbatimArguments: true } };
}

/** Opens the window; resolves once it started, rejects in words when it could not. */
export async function openSetupTokenWindow(platform: NodeJS.Platform = process.platform,
  start: typeof spawn = spawn): Promise<{ opened: true }> {
  if (!claudeUsesSavedCredential(platform)) throw new Error('这台电脑上的 Claude Code 使用你自己的登录，不需要长期令牌');
  if (!claudeLoginStatus(platform).installed)
    throw new Error('没有找到 Claude Code：先安装（npm install -g @anthropic-ai/claude-code），再打开登录窗口');
  const launch = setupTokenLaunch(commandFor('claude'));
  const child = start(launch.file, launch.args, launch.options);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', error => reject(new Error(`没能打开命令行窗口：${error.message}`)));
  });
  child.unref();
  return { opened: true };
}
