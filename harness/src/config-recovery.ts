import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';

/**
 * A configuration that no longer loads must not strand the person: interfaces show why and offer the newest backup
 * that loads, or a fresh first run. The broken file is always kept beside the configuration, never deleted.
 */
const configPath = (home: string): string => join(home, 'config', 'harness.yaml');
const backupDir = (home: string): string => join(home, 'config', 'backups');

/** Why the configuration does not load, or undefined when it loads or does not exist yet. */
export function configProblem(home: string): string | undefined {
  if (!existsSync(configPath(home))) return undefined;
  try { loadConfig(home); return undefined; } catch (error) { return (error as Error).message; }
}
/** Backups written before each configuration change, newest first. */
export function configBackups(home: string): string[] {
  try { return readdirSync(backupDir(home)).filter(name => name.startsWith('harness.yaml.')).sort().reverse(); }
  catch { return []; }
}
/** Moves the configuration aside and returns where it went. */
export function setAsideConfig(home: string): string {
  const aside = `${configPath(home)}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(configPath(home), aside);
  return aside;
}
/** Puts back the newest backup that loads; without one, leaves the broken configuration exactly as it was. */
export function restoreNewestLoadableBackup(home: string): { restored: string; keptAs: string } {
  const aside = setAsideConfig(home);
  for (const name of configBackups(home)) {
    copyFileSync(join(backupDir(home), name), configPath(home));
    if (!configProblem(home)) return { restored: name, keptAs: aside };
  }
  rmSync(configPath(home), { force: true });
  renameSync(aside, configPath(home));
  throw new Error('没有一份备份能正常加载；当前配置保持原样');
}
