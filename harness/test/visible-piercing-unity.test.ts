import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseObservation } from '../src/workflow/observe.ts';
import { removeTemp } from './fixtures/platform.ts';
import { execUnityEditor, unityFixtureRunDir } from './fixtures/unity-slot.ts';

const tools = fileURLToPath(new URL('../builtin/tools/harness/', import.meta.url));

/** This file drives the editor synchronously, so its backoff between launch attempts has to block too. */
const sleepSync = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * FP1 (D-139 ①): the regression metric `fit_pierced_vertices` counts VISIBLE body piercing — per state, a body
 * vertex counts once when it pokes out of at least one garment and no garment covers it. The old reading added the
 * per-garment `pierced` counts, so an outer coat that covered the vertex did not stop the inner shirt from counting
 * it, and one garment's lining + shell counted twice. This test runs the real criterion and the real fit-stage
 * aggregate, then mutates the changed production code in the same project: every mutant must make the fixture fail.
 */
test('the fit metric counts visible body piercing per state, deduplicated by vertex',
  { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 3_600_000 }, t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-visible-piercing-'));
    t.after(() => removeTemp(root));
    console.log('Visible-piercing evidence: ' + root);
    for (const dir of ['Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
    execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',
      join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
    writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
    execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/VisiblePiercingIntegration.cs', import.meta.url)),
      join(root, 'Assets/_HarnessTools/Editor/VisiblePiercingIntegration.cs'));
    const resultPath = join(root, 'result.json');
    /**
     * The account's licence client is a singleton: another editor holding it makes a launch exit 199 before
     * `-executeMethod` runs. Retry that instead of reading it as a verdict, and drop the previous result first so a
     * launch that never ran the fixture cannot leave a stale verdict behind.
     */
    const unity = (log: string) => {
      rmSync(resultPath, { force: true });
      for (let attempt = 1; ; attempt++) {
        try {
          return execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-nographics', '-projectPath', root,
            '-executeMethod', 'AVH.Harness.VisiblePiercingIntegration.Run', '-logFile', join(root, log)],
            { env: { ...process.env, AVH_PROJECT_DIR: root }, timeout: 3_000_000, windowsHide: true, stdio: 'pipe' });
        } catch (error) {
          if ((error as { status?: number }).status !== 199 || attempt >= 12) throw error;
          console.log(`[unity] ${log}: exit 199 (another editor holds the account's licence client), retry ${attempt}/12 in 20s`);
          sleepSync(20_000);
        }
      }
    };
    try {
      unity('unity.log');
    } catch (error) {
      const log = join(root, 'unity.log');
      assert.fail(String(error) + '\n' + (existsSync(log)
        ? readFileSync(log, 'utf8').match(/.*(?:error CS|Exception|Aborting batchmode).*/g)?.slice(-10).join('\n') ?? '' : 'no log'));
    }
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.assertions, 36);

    // FX1: the editor published its observation through the real production path. The Runtime's own parser must
    // accept the file: every metric is a number, a boolean or null, and the list-valued readings live in `details`.
    // Before FX1 three arrays sat in `metrics`, and a real workflow failed `regression_pre` with
    // `check regression_fit_probe_pre: error`.
    const observationPath = join(unityFixtureRunDir(root), 'observations', 'avatar.fit.json');
    const observation = parseObservation(readFileSync(observationPath, 'utf8'));
    assert.ok(Object.values(observation.metrics).every(value => value === null || typeof value === 'number' || typeof value === 'boolean'),
      'every published metric must be a number, a boolean or null');
    assert.ok(Array.isArray(observation.details?.fit_body_paths),
      'the body paths are published as evidence in details');
    assert.ok(Array.isArray(observation.details?.fit_pierced_groups)
      && (observation.details!.fit_pierced_groups as unknown[]).length === 1,
      'the per-(garment × body part) rows are published as evidence in details');
    assert.ok(Array.isArray(observation.details?.fit_pierced_confirmed_garments),
      'the per-garment confirmed rows are published as evidence in details');
    for (const name of ['fit_body_paths', 'fit_pierced_groups', 'fit_pierced_confirmed_garments'])
      assert.equal(name in observation.metrics, false, `${name} must not be a metric`);

    // Mutants rewrite the changed production code in the isolated project, then re-run the same fixture.
    const probe = join(root, 'Assets/_HarnessTools/AvatarAudit/Editor/AuditFitProbe.cs');
    const stage = join(root, 'Assets/_HarnessTools/Editor/HarnessFitStage.cs');
    const mutations: Array<[string, string, string, string, RegExp]> = [
      // The old "add up each garment" reading: a vertex poked through two garments counted twice.
      ['per-garment-sum', probe,
        '                if (covered || best < 0) continue;\n                result.vertices++;',
        '                if (covered || best < 0) continue;\n'
        + '                for (int lj = 0; lj < all.Count; lj++)\n'
        + '                    if (all[lj] != null && all[lj].pierced != null && i < all[lj].pierced.Length && all[lj].pierced[i]) result.vertices++;',
        /still counts once/],
      // An outer coat no longer hides the inner shirt's pierce.
      ['cover-exclusion-dropped', probe,
        '                    if (layer.piercingValid && layer.gap != null && i < layer.gap.Length && layer.gap[i] >= 0f)',
        '                    if (false)',
        /not a visible pierce/],
      // A garment whose scope mapping failed is treated as if it measured nothing.
      ['no-data-treated-as-zero', probe,
        '                    if (!layer.pierced[i]) continue;',
        '                    if (!layer.piercingValid || !layer.pierced[i]) continue;',
        /no_data garment still counts as a pierce/],
      // An incomplete state set is read as a zero instead of "not measured".
      ['incomplete-read-as-zero', stage,
        '            if (fit.Complete)\n            {\n                fit.Pierced = pierced; fit.PiercedRay = piercedRay;',
        '            if (true)\n            {\n                fit.Pierced = pierced; fit.PiercedRay = piercedRay;',
        /null, not zero/],
    ];
    for (const [name, file, from, to, message] of mutations) {
      const source = readFileSync(file, 'utf8');
      assert.ok(source.includes(from), `${name}: production text not found in ${file}`);
      writeFileSync(file, source.replace(from, to));
      try {
        assert.throws(() => unity(name + '.log'), name);
        if (!existsSync(resultPath)) assert.fail(`${name}: the editor wrote no result.json, so the fixture never ran`);
        const failed = JSON.parse(readFileSync(resultPath, 'utf8'));
        assert.equal(failed.ok, false, name);
        assert.match(failed.error, message, name);
      } finally { writeFileSync(file, source); }
    }

    // FX1 mutation: put an array detail back into `metrics` and the Runtime's own parser must reject the very
    // observation the production path wrote. The editor still exits 0 — the fixture does not parse its own output —
    // so the kill has to come from `parseObservation` here, exactly as the frozen version's real workflow failed.
    const clean = '            Avh.Observation("avatar.fit", metrics, fit.Notes, details);';
    const dirty = '            metrics["fit_pierced_groups"] = fit.PiercedGroups;\n' + clean;
    const stageSource = readFileSync(stage, 'utf8');
    assert.ok(stageSource.includes(clean), `FX1: production text not found in ${stage}`);
    writeFileSync(stage, stageSource.replace(clean, dirty));
    try {
      unity('detail-array-inside-metrics.log');
      assert.throws(() => parseObservation(readFileSync(observationPath, 'utf8')),
        /fit_pierced_groups 应为数值、真假值或 null/, 'an array detail inside metrics must be rejected');
    } finally { writeFileSync(stage, stageSource); }
  });
