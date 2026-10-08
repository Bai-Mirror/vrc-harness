import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { constants } from 'node:os';
import { bwrapArgs, codexSandboxArgs, runIsolationArgs } from './sandbox.ts';
import { hostPlatform } from '../host-platform.ts';
import { avhHome } from '../config.ts';
import { resolveSecretEnv } from '../providers/secrets.ts';

const file = process.argv[2];
const config = JSON.parse(readFileSync(file, 'utf8'));
const stdout = openSync(join(config.runDirectory, 'stdout.log'), 'a', 0o600);
const stderr = openSync(join(config.runDirectory, 'stderr.log'), 'a', 0o600);
const isolation = config.stateIsolation;
const windows = process.platform === 'win32';
let executable, args, setupError;
if (windows) {
  // Windows: every command runs in a job of its own through the helper, so a timeout ends the whole tree; `lowil`
  // adds the restricted Low integrity token (the write boundary). Labels were set before this wrapper started.
  if (!config.helperExecutable) setupError = new Error('Windows Run lacks the avh-win helper');
  else if (config.sandbox === 'bwrap' || config.sandbox === 'codex') setupError = new Error(`${config.sandbox} sandbox is not available on Windows`);
  executable = config.helperExecutable;
  args = ['sandbox', ...(config.sandbox === 'lowil' ? ['--low'] : []), '--', ...config.argv];
} else {
  // Masks describe host endpoints, so the host's own values win over anything the Run's environment redirects. A Run
  // declared without network also gets its own network namespace, which closes abstract sockets as well.
  const argv = config.sandbox === 'bwrap'
    ? bwrapArgs(config.writable, config.argv, isolation, config.readonlyGitPaths || [],
      [...(config.network === false ? ['--unshare-net'] : []),
        ...runIsolationArgs(config.harnessHome || avhHome(), [config.projectDirectory, config.cwd, config.argv[0]],
          { ...config.env, ...process.env })])
    : config.sandbox === 'codex'
      ? codexSandboxArgs(config.runDirectory, config.writable, config.argv,
        config.sandboxProfile, config.network, true) : config.argv;
  executable = config.sandbox === 'bwrap' ? 'bwrap' : config.sandbox === 'codex'
    ? (config.sandboxExecutable || 'codex') : argv[0];
  args = config.sandbox === 'scan' || config.sandbox === 'self' || config.sandbox === 'inner-bwrap'
    ? argv.slice(1) : argv;
}
const stdin = config.stdinFile ? openSync(config.stdinFile, 'r') : 'ignore';
let finished = false;
let timedOut = false;
function finish(code, signal) {
  if (finished) return;
  finished = true;
  closeSync(stdout); closeSync(stderr);
  const target = join(config.runDirectory, 'exit.json');
  const temporary = `${target}.${process.pid}.tmp`;
  const cancelled = existsSync(join(config.runDirectory, 'cancel-requested'));
  hostPlatform.writePrivate(temporary, JSON.stringify({ exitStatus: code, timedOut,
    exit: { code, ...(signal ? { signal } : {}), timedOut, cancelled } }));
  renameSync(temporary, target);
  process.exitCode = code;
}
try {
  if (setupError) throw setupError;
  const env = { ...process.env, ...config.env };
  delete env.CLAUDECODE;
  // command.json names Provider credentials without their values; they are read from the private configuration only
  // now, outside the sandbox, and exist from here on only in the command's environment.
  Object.assign(env, resolveSecretEnv(config.harnessHome || avhHome(), config.secretEnv));
  if (config.sandbox !== 'scan') {
    // Sandboxed Runs get a private temp dir inside their writable Run directory; /tmp stays read-only.
    const privateTmp = join(config.runDirectory, 'tmp');
    hostPlatform.mkdirPrivate(privateTmp);
    env.TMPDIR = privateTmp;
    // Windows programs read TEMP and TMP; the user's own temp directory is not writable at Low integrity anyway.
    if (windows) { env.TEMP = privateTmp; env.TMP = privateTmp; }
  }
  const child = spawn(executable, args, { cwd: config.cwd, env, detached: true, windowsHide: true,
    stdio: [stdin, stdout, stderr] });
  if (config.timeoutMs && config.timeoutMs > 0) {
    const timer = setTimeout(() => {
      timedOut = true;
      // The helper holds the command's job; ending the helper ends every process in it.
      if (windows) { try { child.kill(); } catch { /* already exited */ } return; }
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }, 5000).unref();
    }, config.timeoutMs);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  }
  child.once('error', error => {
    writeFileSync(stderr, `${String(error)}\n`);
    finish(127);
  });
  child.once('close', (code, signal) => finish(code ?? (signal ? 128 + (constants.signals[signal] ?? 15) : 1), signal));
} catch (error) {
  writeFileSync(stderr, `${String(error)}\n`);
  finish(127);
}
