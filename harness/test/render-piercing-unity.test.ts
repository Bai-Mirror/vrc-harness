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
 * FP2 (`D-139` ①): `fit_pierced_vertices` counts only body piercing that holds up IN THE PICTURE. FP1's ray
 * criterion left 41 candidates on avatar A of which the renders showed only 4 with the body actually at the pixel;
 * the other 37 had a garment there (rays cannot see non-closed surfaces such as hair cards), and the 4 that were
 * body-owned sat on the hairline where skin shows anyway. This test runs the real render confirmation
 * (`AvatarAudit.FitRenderConfirm.Run`, real renderer-index and depth passes) and the real stage aggregate
 * (`AVH.Harness.HarnessFitStage.AggregateStates`), then mutates the changed production code in the same project:
 * every mutant must make the fixture fail.
 *
 * The editor runs WITHOUT `-nographics` — the whole point of this fixture is a real GPU render; `-nographics`
 * would leave the render targets empty and every case would "pass" for the wrong reason.
 *
 * D-146 ① adds the noise gate: the stage groups the picture-confirmed vertices by garment × body part and only a
 * group that reaches `t.visible_interpenetration_min_vertices` counts toward `fit_pierced_vertices`; smaller groups
 * are evidence (`fit_pierced_vertices_below_gate` / the observation's `details.fit_pierced_groups`). Two mutants
 * below must each break that; FX1 additionally publishes the real observation and has the Runtime parse it.
 */
test('the fit criterion counts only body piercing that the rendered picture confirms',
  { skip: !process.env.AVH_LOCAL_UNITY_EDITOR || !process.env.AVH_LOCAL_UNITY_BASELINE, timeout: 3_600_000 }, t => {
    const root = mkdtempSync(join(tmpdir(), 'avh-render-piercing-'));
    t.after(() => removeTemp(root));
    console.log('Render-piercing evidence: ' + root);
    for (const dir of ['Packages', 'ProjectSettings']) mkdirSync(join(root, dir), { recursive: true });
    execFileSync('python3', ['-c', 'import sys,shutil;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)',
      join(process.env.AVH_LOCAL_UNITY_BASELINE!, 'Packages'), join(root, 'Packages')]);
    writeFileSync(join(root, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 2022.3.22f1\n');
    execFileSync('python3', ['-c', 'import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from setup import install_tools;install_tools(Path(sys.argv[2]),{})', tools, root],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe' });
    copyFileSync(fileURLToPath(new URL('./fixtures/unity/RenderPiercingIntegration.cs', import.meta.url)),
      join(root, 'Assets/_HarnessTools/Editor/RenderPiercingIntegration.cs'));
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
          return execUnityEditor(process.env.AVH_LOCAL_UNITY_EDITOR!, ['-batchmode', '-projectPath', root,
            '-executeMethod', 'AVH.Harness.RenderPiercingIntegration.Run', '-logFile', join(root, log)],
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
    assert.equal(result.assertions, 33);

    // FX1: the editor published its observation through the real production path. The Runtime's own parser must
    // accept the file: every metric is a number, a boolean or null, and the list-valued readings live in `details`.
    // Before FX1 three arrays sat in `metrics`, and a real workflow failed `regression_pre` with
    // `check regression_fit_probe_pre: error`.
    const observationPath = join(unityFixtureRunDir(root), 'observations', 'avatar.fit.json');
    const observation = parseObservation(readFileSync(observationPath, 'utf8'));
    assert.ok(Object.values(observation.metrics).every(value => value === null || typeof value === 'number' || typeof value === 'boolean'),
      'every published metric must be a number, a boolean or null');
    assert.deepEqual(observation.details?.fit_body_paths, ['Body']);
    const groups = observation.details?.fit_pierced_groups as Array<Record<string, unknown>> | undefined;
    assert.ok(Array.isArray(groups) && groups.some(group => group.garment === 'Top' && group.region === 'Chest'
      && group.vertices === 8 && group.counted === true),
      'the noise-gated per-(garment × body part) rows are published as evidence in details');
    assert.ok(Array.isArray(observation.details?.fit_pierced_confirmed_garments)
      && (observation.details!.fit_pierced_confirmed_garments as unknown[]).length > 0,
      'the per-garment confirmed rows are published as evidence in details');
    for (const name of ['fit_body_paths', 'fit_pierced_groups', 'fit_pierced_confirmed_garments'])
      assert.equal(name in observation.metrics, false, `${name} must not be a metric`);

    // Mutants rewrite the changed production code in the isolated project, then re-run the same fixture.
    const confirm = join(root, 'Assets/_HarnessTools/AvatarAudit/Editor/FitRenderConfirm.cs');
    const stage = join(root, 'Assets/_HarnessTools/Editor/HarnessFitStage.cs');
    const mutations: Array<[string, string, string, string, RegExp]> = [
      // "With the body off, that pixel is the garment it pierced" is dropped: any visible surface counts.
      ['garment-identity-dropped', confirm,
        '                            bool garmentVisible = idCut != 0 && pathById(paths, idCut, out cutPath)\n'
        + '                                && string.Equals(cutPath, candidate.Garment, StringComparison.Ordinal);',
        '                            bool garmentVisible = idCut != 0;',
        /different garment showing where the pierced one should be/],
      // The depth check is dropped: a nearer body surface in the same pixel counts for the vertex behind it.
      ['depth-check-dropped', confirm,
        '                            bool depthMatched = bodyFrontmost && frontDepth > 0f\n'
        + '                                && Math.Abs(frontDepth - eyeDepth) * 1000f <= options.DepthToleranceMm;',
        '                            bool depthMatched = bodyFrontmost;',
        /nearer body surface in the same pixel/],
      // Only the first view is rendered. Two assertions catch that: the plain "every configured view is rendered"
      // one (which fires first), and case ④, the pierce that only the side view can see.
      ['single-view', confirm,
        '                for (int vi = 0; vi < options.Views.Length; vi++)',
        '                for (int vi = 0; vi < 1; vi++)',
        /every configured view is rendered|only visible from the side/],
      // The criterion silently falls back to the ray count instead of the confirmed count.
      ['ray-count-as-criterion', stage,
        '                fit.Pierced = pierced; fit.PiercedRay = piercedRay;',
        '                fit.Pierced = piercedRay; fit.PiercedRay = piercedRay;',
        /criterion reads the render-confirmed count/],
      // D-146 ①: the noise gate must be applied per (garment × body part) group. Dropping it counts the
      // below-gate group too (case ⑧ reads 1, case ⑨ reads 10).
      ['gate-dropped', stage,
        '                if (group.Vertices >= gate) pierced += group.Vertices; else belowGate += group.Vertices;',
        '                pierced += group.Vertices;',
        /noise gate/],
      // Gating on the whole-run total instead of per group: on case ⑨ (8 + 2 = 10) the 2-vertex group passes.
      ['gate-by-total', stage,
        '                if (group.Vertices >= gate) pierced += group.Vertices; else belowGate += group.Vertices;',
        '                if (totalConfirmed >= gate) pierced += group.Vertices; else belowGate += group.Vertices;',
        /noise gate/],
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
    const dirty = '            metrics["fit_body_paths"] = fit.BodyPaths;\n' + clean;
    const stageSource = readFileSync(stage, 'utf8');
    assert.ok(stageSource.includes(clean), `FX1: production text not found in ${stage}`);
    writeFileSync(stage, stageSource.replace(clean, dirty));
    try {
      unity('detail-array-inside-metrics.log');
      assert.throws(() => parseObservation(readFileSync(observationPath, 'utf8')),
        /fit_body_paths 应为数值、真假值或 null/, 'an array detail inside metrics must be rejected');
    } finally { writeFileSync(stage, stageSource); }
  });
