import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor } from './fixtures/unity-slot.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));
const integration = fileURLToPath(new URL('./fixtures/unity/ColdProbeAssembliesIntegration.cs', import.meta.url));

/**
 * The delivered-project check asks for a DLL for every asmdef the project carries. One that lives where Unity never
 * imports it can never produce one, so the expectation has to read the project the way the asset database does:
 * a folder whose name ends with `~` (a package's `Samples~` / `source~` tree) or starts with `.` is not imported.
 */
function definition(root: string, name: string, folder: string): void {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, `${name}.asmdef`), JSON.stringify({ name, references: [] }, null, 2) + '\n');
  writeFileSync(join(root, folder, `${name}.cs`), `public static class ${name.replace(/\W/g, '_')}Marker { }\n`);
}

test('the cold-import probe asks for no assembly from a folder Unity never imports',
  { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE
      ? 'Set Unity editor and isolated SDK baseline' : false, timeout: 1_800_000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-cold-assemblies-'));
  t.after(() => removeTemp(root));
  console.log('Cold-probe assembly evidence: ' + root);
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true });
  writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',
    join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')], { stdio: 'pipe' });
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
  definition(root, 'Fixture.Kept', 'Assets/Scripts');
  definition(root, 'Fixture.Sample', 'Packages/vendor.pack/Samples~/Extras');
  definition(root, 'Fixture.Dotted', 'Assets/.hidden');
  writeFileSync(join(root, 'Packages/vendor.pack/package.json'), '{"name":"vendor.pack","version":"1.0.0"}\n');
  mkdirSync(join(root, 'Assets/Editor'), { recursive: true });
  writeFileSync(join(root, 'Assets/Editor/ColdProbeAssembliesIntegration.cs'), readFileSync(integration, 'utf8'));

  const probe = join(root, 'Assets/_HarnessTools/Editor/ColdImportStage.cs');
  const call = (log: string) => {
    try {
      execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root,
        '-executeMethod', 'AVH.Harness.ColdProbeAssembliesIntegration.Run', '-logFile', join(root, log)],
        { env: { ...process.env, AVH_PROJECT_DIR: root }, timeout: 900_000, windowsHide: true, stdio: 'pipe' });
    } catch (error) {
      const tail = readFileSync(join(root, log), 'utf8').match(/.*(?:error CS|Exception|failed).*/g)?.slice(-10).join('\n') ?? '';
      assert.fail(String(error) + '\n' + tail);
    }
    return JSON.parse(readFileSync(join(root, 'cold-assemblies-result.json'), 'utf8')) as
      { ok: boolean; expected: number; missing: string[]; error?: string };
  };

  const fixed = call('unity-fixed.log');
  assert.equal(fixed.ok, true, fixed.error);
  assert.ok(fixed.expected > 0, 'the project has assemblies to compile');
  assert.ok(!fixed.missing.includes('Fixture.Kept'), `a definition Unity compiles is expected and has its DLL: ${fixed.missing}`);
  assert.deepEqual(fixed.missing.filter(name => name.startsWith('Fixture.')), [],
    'no assembly may be expected from a folder Unity never imports');

  // Mutation: restore the scan that walks into the ignored folders, and the probe demands DLLs that cannot exist.
  const source = readFileSync(probe, 'utf8');
  const mutant = source.replace('if (UnityIgnored(path)) continue;', '// mutation: keep definitions Unity never imports')
    .replace('!UnityIgnored(p) && ', '');
  assert.notEqual(mutant, source, 'the mutation really removes the ignored-folder rule');
  writeFileSync(probe, mutant);
  const broken = call('unity-mutant.log');
  assert.equal(broken.ok, true, broken.error);
  assert.ok(broken.missing.includes('Fixture.Sample') && broken.missing.includes('Fixture.Dotted'),
    `mutation: without the rule the probe asks for DLLs that cannot exist (${broken.missing})`);
});
