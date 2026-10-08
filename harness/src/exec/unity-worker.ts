import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { UnityConfig } from '../config.ts';
import { hostPlatform } from '../host-platform.ts';
import { runUnitySteps, type UnityStep } from './unity-steps.ts';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {
  config: UnityConfig; steps: UnityStep[]; project: string; runDir: string;
};
const journal = join(input.runDir, 'unity-steps.json');
const waiting = join(input.runDir, 'unity-waiting.json');
try {
  // While a step waits for the batch slot, say so in the Run directory. The journal is only written once every step has
  // finished, so without this a Run that is waiting looks the same as one that is working, and the wait is unbounded
  // from the outside — a person (or the interface) could not tell which of the two it is looking at.
  const evidence = await runUnitySteps(input.config, input.steps, input.project, input.runDir,
    (index, wait) => hostPlatform.writePrivate(waiting, JSON.stringify({
      schema: 'unity-waiting/0.1', index, wait, since: new Date().toISOString(),
      reason: 'Unity 批处理槽位被占用；等它释放后重试',
    })));
  rmSync(waiting, { force: true });
  const temporary = `${journal}.${process.pid}.tmp`;
  hostPlatform.writePrivate(temporary, JSON.stringify({ status: 'finished', evidence }));
  renameSync(temporary, journal);
  process.exitCode = evidence.some(item => item.exitCode !== 0 || item.timedOut) ? 1 : 0;
} catch (error) {
  rmSync(waiting, { force: true });
  // The parent records a launch failure after the unit has exited and is confirmed stopped;
  // the reason goes to the unit's stderr log so the failure is diagnosable.
  process.stderr.write(`unity-worker: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
