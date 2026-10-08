import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostPlatform } from '../host-platform.ts';

/**
 * Provider credentials (API keys, long-lived tokens) live one per file in AVH_HOME/config/secrets: the configuration
 * directory no Run can read (bwrap masks it on Linux; on Windows it carries a no-read-up label for Low processes). They
 * are never written to harness.yaml, Run records, logs or exported archives. A Run receives a credential only as an
 * environment variable that the unit wrapper sets when it starts the command: CommandSpec.secretEnv names the secret,
 * never its value, so command.json holds the name alone.
 */
const SECRET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretId(id: string): boolean { return SECRET_ID.test(id); }
export function secretPath(home: string, id: string): string {
  if (!SECRET_ID.test(id)) throw new Error(`无效的凭据名：${id}`);
  return join(home, 'config', 'secrets', id);
}
export function readSecret(home: string, id: string): string | undefined {
  try { return readFileSync(secretPath(home, id), 'utf8').trim() || undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export function hasSecret(home: string, id: string): boolean { return readSecret(home, id) !== undefined; }
export function writeSecret(home: string, id: string, value: string): void {
  const text = value.trim();
  if (!text || /[\r\n\0]/.test(text)) throw new Error('凭据不能为空，也不能包含换行');
  if (text.length > 16_384) throw new Error('凭据过长');
  const path = secretPath(home, id);
  hostPlatform.mkdirPrivate(join(home, 'config', 'secrets'));
  const next = `${path}.${process.pid}.next`;
  hostPlatform.writePrivate(next, text);
  renameSync(next, path);
}
export function clearSecret(home: string, id: string): boolean {
  const path = secretPath(home, id);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * The local API's credential methods (secret.status/set/clear in api/server.ts) for a caller that has no Runtime to ask
 * yet: the GUI's first run, before a configuration exists. Same files, same rules: nothing is ever read back.
 */
export function secretMethod(home: string, method: string, params: Record<string, unknown>): unknown {
  const id = (value: unknown): string => { if (typeof value !== 'string' || !value) throw new Error('缺少凭据名'); return value; };
  if (method === 'secret.status')
    return Object.fromEntries((Array.isArray(params.ids) ? params.ids : []).map(item => [id(item), hasSecret(home, id(item))]));
  if (method === 'secret.set') {
    if (typeof params.value !== 'string') throw new Error('缺少凭据内容');
    writeSecret(home, id(params.id), params.value);
    return { ok: true };
  }
  if (method === 'secret.clear') return { cleared: clearSecret(home, id(params.id)) };
  throw new Error(`未知的凭据方法：${method}`);
}

/** Environment variables a command asks for by secret name; refuses bad names before anything is stored or started. */
export function checkSecretEnv(home: string, secretEnv: Record<string, string> | undefined): void {
  for (const [name, id] of Object.entries(secretEnv ?? {})) {
    if (!ENV_NAME.test(name)) throw new Error(`无效的环境变量名：${name}`);
    if (!hasSecret(home, id)) throw new Error(`缺少凭据 ${id}：请在设置里填写后再试`);
  }
}
/** The values for a command's environment, read at the moment it starts (the unit wrapper). */
export function resolveSecretEnv(home: string, secretEnv: Record<string, string> | undefined): Record<string, string> {
  checkSecretEnv(home, secretEnv);
  return Object.fromEntries(Object.entries(secretEnv ?? {}).map(([name, id]) => [name, readSecret(home, id)!]));
}

export const REDACTED_SECRET = '[凭据已隐去]';
const REDACT_MAX_BYTES = 64 * 1024 * 1024;
/**
 * A command that holds a credential can print it: an agent's shell tool inherits the variable, and a model may echo it.
 * After the Run, every occurrence in the files it left for the record (logs, transcripts) is replaced, so the value never
 * reaches the state database, a report or an exported archive through them. Returns the files that were changed.
 */
export function redactSecretValues(home: string, secretEnv: Record<string, string> | undefined, files: string[]): string[] {
  const values = [...new Set(Object.values(secretEnv ?? {}).map(id => { try { return readSecret(home, id); } catch { return undefined; } })
    .filter((value): value is string => !!value && value.length >= 8))].map(value => Buffer.from(value));
  if (!values.length) return [];
  const changed: string[] = [];
  for (const file of files) {
    let data: Buffer;
    try { const info = statSync(file); if (!info.isFile() || info.size > REDACT_MAX_BYTES) continue; data = readFileSync(file); }
    catch { continue; }
    if (!values.some(value => data.includes(value))) continue;
    let text = data;
    for (const value of values) {
      const parts: Buffer[] = [];
      let from = 0;
      for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, from)) {
        parts.push(text.subarray(from, at), Buffer.from(REDACTED_SECRET));
        from = at + value.length;
      }
      parts.push(text.subarray(from));
      text = Buffer.concat(parts);
    }
    const next = `${file}.${process.pid}.redacted`;
    writeFileSync(next, text, { mode: 0o600 });
    renameSync(next, file);
    changed.push(file);
  }
  return changed;
}
