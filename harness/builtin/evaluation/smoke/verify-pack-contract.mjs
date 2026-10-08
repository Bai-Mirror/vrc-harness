// Checks one aspect of a managed pack's contract. Invoked as
//   node verify-pack-contract.mjs <packRoot> <layout|process-definitions|capability-commands|thresholds>
// and prints the same {result, failures} JSON line the smoke checker uses.
//
// These are structural checks of what the pack declares, not business evaluation: a pack that names a tool it does not
// ship, or a capability manifest whose command is missing, must fail before the pack is ever run on a project. The
// model family of every case stays "deterministic" for that reason -- labelling structural checks as model coverage
// would make D5's family denominator lie.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.argv[2], aspect = process.argv[3];
const failures = [];
const processRoot = join(root, 'knowledge', 'process');
const manifests = suffix => { try { return readdirSync(processRoot).filter(name => name.endsWith(suffix)); } catch { return []; } };
const read = name => readFileSync(join(processRoot, name), 'utf8');
/** Every `{toolRoot}/...` reference in a manifest, which the Runtime resolves under the pack's tools directory. */
const toolReferences = value => [...value.matchAll(/\{toolRoot\}\/([^"',\]}\s]+)/g)].map(match => match[1]);
const TOOL_EXECUTABLES = new Set(['python3', 'node', 'bash', 'sh']);

/** The interpreter the pack's own commands name. Probed inside whatever sandbox this checker runs in, so a shim
 * that works in a terminal but not under the check's Low integrity token falls through to the real install. */
function pythonCommand() {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return 'python3';
}

function requireTools(name, value) {
  for (const reference of toolReferences(value))
    if (!existsSync(join(root, 'tools', reference))) failures.push(`${name}: missing tool ${reference}`);
}
function requireNonEmptyManifests(suffix, what) {
  const files = manifests(suffix);
  if (!files.length) failures.push(`no ${what}`);
  return files;
}

if (aspect === 'layout') {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8')); } catch { failures.push('pack.json unreadable'); }
  if (manifest?.schema !== 'harness-managed-pack/0.1') failures.push('pack schema');
  if (typeof manifest?.id !== 'string' || !manifest.id) failures.push('pack id');
  if (typeof manifest?.version !== 'string' || !manifest.version) failures.push('pack version');
  if (!existsSync(join(root, 'tools'))) failures.push('tools/');
  requireNonEmptyManifests('.process.yaml', 'process definition');
  requireNonEmptyManifests('.capabilities.yaml', 'capability manifest');
} else if (aspect === 'process-definitions') {
  for (const name of requireNonEmptyManifests('.process.yaml', 'process definition')) {
    const value = read(name);
    if (!/^\s*schema:\s*\S+/m.test(value)) failures.push(`${name}: no schema`);
    if (!/^\s*stages:\s*$/m.test(value)) failures.push(`${name}: no stages`);
    if (!/^\s*-\s*id:\s*\S+/m.test(value)) failures.push(`${name}: no stage entries`);
    requireTools(name, value);
  }
} else if (aspect === 'capability-commands') {
  for (const name of requireNonEmptyManifests('.capabilities.yaml', 'capability manifest')) {
    const value = read(name);
    if (!/^\s*schema:\s*capabilities\//m.test(value)) failures.push(`${name}: no capabilities schema`);
    requireTools(name, value);
    // A capability command runs in the check sandbox: its executable is a fixed, audited set.
    for (const line of value.split('\n')) {
      const command = /^\s*command:\s*\[([^\]]*)\]/.exec(line);
      if (!command) continue;
      const executable = command[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
      if (executable && !TOOL_EXECUTABLES.has(executable)) failures.push(`${name}: executable not allowed: ${executable}`);
    }
  }
} else if (aspect === 'thresholds') {
  const path = join(processRoot, 'thresholds.yaml');
  if (!existsSync(path)) failures.push('thresholds.yaml');
  else {
    const value = readFileSync(path, 'utf8');
    if (!/^\s*schema:\s*thresholds\//m.test(value)) failures.push('thresholds schema');
    if (!/^\s*version:\s*\S+/m.test(value)) failures.push('thresholds version');
  }
} else if (aspect === 'recolor-targets') {
  // The recolor observer is a command of its own and re-runs the recipe over the stored plan, so it cannot lean
  // on the plan gate having run. A target that is not an object has no form and cannot be measured: the observer
  // must refuse it in words — the same refusal the gate and the recipe entry point give — rather than die with a
  // traceback and no observation. Measured, not read from the source: the pack's own observer is executed.
  const observer = join(root, 'tools', 'harness', 'observe_recolor.py');
  if (!existsSync(observer)) failures.push('tools/harness/observe_recolor.py');
  else {
    const project = mkdtempSync(join(tmpdir(), 'avh-pack-recolor-'));
    try {
      const out = join(project, 'observation.json');
      const refused = spawnSync(pythonCommand(), [observer, '--out', out], { encoding: 'utf8', windowsHide: true,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', AVH_PROJECT_DIR: project, AVH_RUN_DIR: project,
          AVH_TOOL_ROOT: join(root, 'tools'), AVH_PLAN: JSON.stringify({ recolor: { targets: [null], candidates: 3 } }) } });
      if (refused.status === 0) failures.push('the recolor observer accepted a non-object target');
      if (!/每个配色目标都必须是对象/.test(refused.stderr || '')) failures.push('the recolor observer did not name the shape it refused');
      if (/Traceback/.test(refused.stderr || '')) failures.push('the recolor observer crashed instead of refusing');
      if (existsSync(out)) failures.push('a refused plan left an observation behind');
    } finally { rmSync(project, { recursive: true, force: true }); }
  }
} else {
  failures.push(`unknown aspect ${String(aspect)}`);
}

process.stdout.write(JSON.stringify({ result: failures.length ? 'fail' : 'pass', failures }) + '\n');
process.exitCode = failures.length ? 1 : 0;
