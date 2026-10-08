import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { harnessRoot } from '../provenance.ts';

/** Runs `avh <args>` for the TUI: the interface starts and configures the service through the CLI, never in-process. */
export function runCli(args: string[], home: string, cliPath = join(harnessRoot, 'bin', 'avh.js')): Promise<{ status: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, AVH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (data: string) => { output += data; });
    child.stderr.setEncoding('utf8').on('data', (data: string) => { output += data; });
    child.on('close', status => resolve({ status, output: output.trim() }));
    child.on('error', error => resolve({ status: null, output: String(error) }));
  });
}
