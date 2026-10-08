import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor } from './fixtures/unity-slot.ts';
const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));

/** This file drives the editor synchronously, so its backoff between launch attempts has to block too. */
const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

test('the back-half stage tools audit plugin data textures, count sequence drift and read empty applicability sets',
  { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 1800000 }, t => {
  const root = mkdtempSync(join(tmpdir(), 'avh-back-half-audit-'));
  t.after(() => { if (!process.env.AVH_BACK_HALF_KEEP_PROJECT) removeTemp(root); });
  console.log('Back-half audit evidence: ' + root);
  for (const dir of ['Assets/Editor', 'Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
  execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',
    join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
  writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
  execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
  copyFileSync(fileURLToPath(new URL('./fixtures/unity/BackHalfAuditIntegration.cs', import.meta.url)), join(root, 'Assets/Editor/BackHalfAuditIntegration.cs'));
  const resultPath = join(root, 'result.json');
  /**
   * One editor launch. The account's licence client is a singleton, so another editor holding it makes a launch exit
   * 199 before `-executeMethod` runs and before anything is logged; retry that instead of reading it as a verdict.
   * The previous result is removed first, so a launch that never ran the fixture cannot leave a stale verdict behind:
   * reading the last run's `{"ok":true}` made a licence failure look like a mutant that had not been caught.
   */
  const unity = (log: string) => {
    rmSync(resultPath, { force: true });
    for (let attempt = 1; ; attempt++) {
      try {
        return execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root,
          '-executeMethod', 'AVH.Harness.BackHalfAuditIntegration.Run', '-logFile', join(root, log)],
          { env: { ...process.env, AVH_PROJECT_DIR: root, AVH_PLAN: '{}' }, timeout: 1200000, windowsHide: true, stdio: 'pipe' });
      } catch (error) {
        if ((error as { status?: number }).status !== 199 || attempt >= 8) throw error;
        console.log(`[unity] ${log}: exit 199 (another editor holds the account's licence client), retry ${attempt}/8 in 30s`);
        sleepSync(30_000);
      }
    }
  };
  try { unity('unity.log'); } catch (error) {
    assert.fail(String(error) + '\n' + readFileSync(join(root, 'unity.log'), 'utf8').match(/.*(?:error CS|Exception|failed).*/g)?.slice(-10).join('\n'));
  }
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.ok, true, result.error);

  // The mutants compile the changed production code in the same isolated project.
  const editor = (name: string) => join(root, 'Assets/_HarnessTools/Editor', name);
  const mutations: Array<[string, string, string, string, RegExp]> = [
    ['sequence-drift-dropped', 'RegressionStage.cs', 'return (missing + drift.Count, sequences.Count);', 'return (missing, sequences.Count);',
      /must count as a failure/],
    ['data-role-dropped', 'OptimizeStage.cs', 'public static bool DataBound(string property) => DataProperty.IsMatch(property);', 'public static bool DataBound(string property) => false;',
      /must be identified as data/],
    ['mixed-use-dropped', 'OptimizeStage.cs', 'if (DataBound(property)) { use.Data = true; continue; }', 'if (DataBound(property)) { use.Data = true; use.Visual = null; continue; }',
      /must keep its visual role/],
    ['mixed-use-planned', 'OptimizeStage.cs', 'if (use.Data)', 'if (use.Data && use.Visual == null)',
      /must never enter the import plan/],
    ['real-size-dropped', 'Perf.cs', 'var maxSize = importer == null ? realSize :', 'var maxSize = importer == null ? int.MaxValue :',
      /only the oversized aux art may fail the tier audit/],
    ['no-main-null', 'PerformanceStage.cs', 'var mainFloor = mains.Count == 0 ? OptimizeStage.Main :', 'var mainFloor = mains.Count == 0 ? (int?)null :',
      /no main texture is not below the red line/],
    ['baseline-presence-dropped', 'PerformanceStage.cs', '["textures_above_baseline"] = baseline == null ? (int?)null : above,', '["textures_above_baseline"] = pre == null ? (int?)null : above,',
      /must leave textures_above_baseline unmeasured/],
    ['baseline-zero-size', 'PerformanceStage.cs', 'if (max == null || source == null) return null;', 'if (max == null || source == null) return 0;',
      /must leave textures_above_baseline unmeasured instead of falling back to zero/],
    ['baseline-role-missing-exempt', 'PerformanceStage.cs', 'var usable = DataOnly(entry) || (VisualRole(entry) != null && EffectiveSize(entry) != null);', 'var usable = VisualRole(entry) == null || EffectiveSize(entry) != null;',
      /whose role is missing must leave textures_above_baseline unmeasured/],
    ['baseline-unknown-role-accepted', 'PerformanceStage.cs', 'role == "main" || role == "aux" || role == "cube";', 'role != null && role != OptimizeStage.DataRole;',
      /unknown role with valid dimensions must leave textures_above_baseline unmeasured/],
    ['no-eye-bone-null', 'SetupStage.cs', 'result["eye_l_y_delta"] = NoEyeBone(baseline) && NoEyeBone(result) ?', 'result["eye_l_y_delta"] = false ?',
      /both sides reporting no eye bone is no measurable change/],
    // A design entry outside the menu-layer universe: recording it as not applied is the fix; treating every design
    // entry as applied silently drops the record the optimize stage writes back.
    ['design-universe-dropped', 'OptimizeStage.cs', 'var applied = new HashSet<string>(entries.Cast<Dictionary<string, object>>().Select(e => e.Str("guid")));',
      'var applied = new HashSet<string>(decisions.Select(d => d.Str("guid")));',
      /must be recorded as not applied/],
    // AAO's automatic MergeBone pass is what renames merged children to `<parent>$<child>$<n>`; dropping the two pins
    // puts the fixed outfits' object paths back in the hands of AAO.
    ['aao-mergebone-unpinned', 'OptimizeStage.cs',
      '("debugOptions.noConfigureLeafMergeBone", true), ("debugOptions.noConfigureMiddleMergeBone", true),',
      '', /must be pinned off for this avatar/],
    // A texture neither the pre inventory nor the applied plan names is not this run's doing: judging it is exactly the
    // reading that called a vendor `maxTextureSize: 128` main and a vendor 2048 aux map harness violations.
    ['vendor-limit-blamed', 'PerformanceStage.cs', 'var judged = audited.Where(Answerable).ToList();', 'var judged = audited;',
      /must not read as below the 2048 red line/],
    // Tolerating what this run did not write must not tolerate what it did: an edit the applied plan recorded is still
    // judged against the limit the texture had before it.
    ['own-edit-exempted', 'PerformanceStage.cs',
      '                if (edited.ContainsKey(t.Str("guid") ?? "") || edited.ContainsKey(t.Str("path") ?? "")) return true;',
      '                if (edited.ContainsKey(t.Str("guid") ?? "") || edited.ContainsKey(t.Str("path") ?? "")) return false;',
      /must still be caught/],
  ];
  for (const [name, file, from, to, message] of mutations) {
    const path = editor(file);
    const source = readFileSync(path, 'utf8');
    assert.ok(source.includes(from), `${name}: production text not found in ${file}`);
    let mutant = source.replace(from, to);
    if (name === 'real-size-dropped') {
      const sourceSize = '["source_size"] = importer != null ? SourceSize(importer) : realSize,';
      assert.ok(mutant.includes(sourceSize), `${name}: source_size text not found`);
      mutant = mutant.replace(sourceSize, '["source_size"] = importer != null ? SourceSize(importer) : int.MaxValue,');
    }
    writeFileSync(path, mutant);
    try {
      assert.throws(() => unity(name + '.log'), name);
      if (!existsSync(resultPath)) assert.fail(`${name}: the editor wrote no result.json, so the fixture never ran`);
      const failed = JSON.parse(readFileSync(resultPath, 'utf8'));
      assert.equal(failed.ok, false, name);
      assert.match(failed.error, message, name);
    } finally { writeFileSync(path, source); }
  }
});
