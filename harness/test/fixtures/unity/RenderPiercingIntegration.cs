// Counterexample fixture for the render-confirmed piercing criterion (FP2 / D-139 ①). The fit criterion
// `fit_pierced_vertices` no longer counts what the ray criterion says is a visible pierce; it counts the ray
// candidates that survive a PICTURE check: in at least one fixed view the body must be the frontmost surface at the
// projected pixel, at THIS vertex's depth, and with the body switched off the surface showing there must be exactly
// the garment the ray criterion attributes the pierce to.
//
// The cases below are real scenes rendered by the real `AvatarAudit.FitRenderConfirm.Run` (renderer-index passes,
// a depth pass, the same camera framing the product uses), so they exercise the actual code path rather than a
// restatement of it. Each case is small and flat-faced so the pixel/depth expectations are exact.
//
// Geometry convention: "front" is the +Z camera (the product's yaw 0), "right" is +X, "left" is -X, "back" is -Z.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;
using AvatarAudit;
using Object = UnityEngine.Object;

namespace AVH.Harness
{
    public static class RenderPiercingIntegration
    {
        static int assertions;
        static GameObject root;
        static Mesh fixtureMesh;

        static void Require(bool ok, string message)
        {
            assertions++;
            if (!ok) throw new Exception("assertion " + assertions + ": " + message);
        }

        // ── scene helpers ───────────────────────────────────────────────────────────────────

        static void NewRoot()
        {
            Cleanup();
            root = new GameObject("Avatar");
        }

        static void Cleanup()
        {
            if (root != null) Object.DestroyImmediate(root);
            root = null;
            if (fixtureMesh != null) Object.DestroyImmediate(fixtureMesh);
            fixtureMesh = null;
        }

        static GameObject Cube(string name, Vector3 center, Vector3 size)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = name;
            var collider = go.GetComponent<Collider>();
            if (collider != null) Object.DestroyImmediate(collider);
            go.transform.SetParent(root.transform, false);
            go.transform.localPosition = center;
            go.transform.localScale = size;
            return go;
        }

        static FitRenderConfirm.Candidate Candidate(Vector3 position, string garment)
        {
            return new FitRenderConfirm.Candidate
            {
                Vertex = 0, Region = "Chest", Garment = garment, Position = position, DepthMm = 1.5f,
            };
        }

        /// <summary>One `render.confirmed` row, as the probe writes it: which garment and body part a
        /// picture-confirmed vertex belongs to, at which views and pixels (`D-146` ① grouping).</summary>
        static Dictionary<string, object> Row(string garment, string region, int vertex)
        {
            return new Dictionary<string, object>
            {
                ["vertex"] = vertex,
                ["layer"] = "",
                ["garment"] = garment,
                ["region"] = region,
                ["depth_mm"] = 1.5d,
                ["confirmed"] = true,
                ["views"] = new List<object> { "front" },
                ["pixels"] = new List<object> { vertex },
                ["codes"] = new List<object> { "front:hit" },
                ["min_body_depth_delta_mm"] = 0.1d,
            };
        }

        static FitRenderConfirm.Result Check(List<FitRenderConfirm.Candidate> candidates, string[] bodyPaths,
            string views = null, string outDir = null, float tolerance = FitRenderConfirm.DefaultDepthToleranceMm)
        {
            var options = new FitRenderConfirm.Options
            {
                Enabled = true,
                Height = 240,
                DepthToleranceMm = tolerance,
                Views = views == null ? FitRenderConfirm.Options.AllViews() : views.Split(','),
            };
            return FitRenderConfirm.Run(root, options, candidates, new List<string>(bodyPaths), outDir, "fixture");
        }

        /// <summary>Every per-view code of the first candidate, e.g. "front:hit,back:out" — a failure message then
        /// says what the picture check actually read.</summary>
        static string Codes(FitRenderConfirm.Result result)
        {
            if (result.CandidateRows.Count == 0) return "<no rows>";
            var codes = result.CandidateRows[0].Get("codes") as List<object>;
            if (codes == null) return "<no codes>";
            var text = new List<string>();
            foreach (var code in codes) text.Add(Convert.ToString(code));
            return string.Join(",", text.ToArray());
        }

        static string ConfirmedViews(FitRenderConfirm.Result result)
        {
            if (result.CandidateRows.Count == 0) return "<no rows>";
            var views = result.CandidateRows[0].Get("views") as List<object>;
            if (views == null) return "<no views>";
            var text = new List<string>();
            foreach (var view in views) text.Add(Convert.ToString(view));
            return string.Join(",", text.ToArray());
        }

        // ── aggregate helpers ───────────────────────────────────────────────────────────────

        static Dictionary<string, object> Geo(int? ray, int? confirmed, int? views, bool withRender = true,
            bool renderValid = true, string garment = "G", List<object> rows = null)
        {
            var block = new Dictionary<string, object>
            {
                ["valid"] = true,
                ["vertices"] = ray,
                ["raw_vertices"] = 0,
                ["max_depth_mm"] = 5d,
                ["saturated_vertices"] = 0,
                ["no_data_vertices"] = 0,
            };
            if (withRender)
            {
                // D-146 ①: the stage groups the picture check's confirmed vertices by garment × body part, so a
                // geo block stands in for the probe's `render.confirmed` rows as well as its count. `rows` lets a
                // case name several groups; the default is one group of `confirmed` vertices.
                var confirmedRows = rows ?? new List<object>();
                if (rows == null)
                    for (int i = 0; i < (confirmed ?? 0); i++) confirmedRows.Add(Row(garment, "Chest", i));
                block["render"] = new Dictionary<string, object>
                {
                    ["valid"] = renderValid,
                    ["vertices"] = renderValid ? confirmed : null,
                    ["views"] = renderValid ? views : null,
                    ["depth_tolerance_mm"] = 2d,
                    ["confirmed"] = confirmedRows,
                    ["per_garment"] = new List<object>
                    {
                        new Dictionary<string, object> { ["path"] = garment, ["vertices"] = confirmed ?? 0 },
                    },
                };
                // The probe's ray reading is per garment inside the visible-piercing block; the picture check's own
                // per-garment rows sit in `render.per_garment`. The aggregate reads both.
                block["garments"] = new List<object>
                {
                    new Dictionary<string, object> { ["path"] = garment, ["scope"] = "measured", ["vertices"] = ray },
                };
            }
            return new Dictionary<string, object>
            {
                ["garments"] = new List<object>
                {
                    new Dictionary<string, object>
                    {
                        ["path"] = garment,
                        ["total"] = new Dictionary<string, object> { ["pierced"] = 0, ["max_depth_mm"] = 5d },
                    },
                },
                ["feet"] = new List<object>(),
                ["warnings"] = new List<object>(),
                ["body_paths"] = new List<object> { "Body" },
                ["body_mesh_count"] = 1,
                ["visible_piercing"] = block,
            };
        }

        public static void Run()
        {
            bool ok = false;
            string error = null;
            try
            {
                // ① A body poking out of a single-layer top: the body's front face is in front of the top and the
                // top is what shows once the body is hidden -> confirmed from the front view.
                NewRoot();
                Cube("Body", Vector3.zero, new Vector3(0.2f, 0.2f, 0.2f));
                Cube("Top", new Vector3(0, 0, 0.05f), new Vector3(0.16f, 0.16f, 0.02f));
                var single = Check(new List<FitRenderConfirm.Candidate> { Candidate(new Vector3(0, 0, 0.1f), "Top") },
                    new[] { "Body" }, outDir: Path.Combine(Project(), "_render-check"));
                Require(single.Valid, "① the picture check completes: " + single.Reason);
                Require(single.Confirmed == 1,
                    "① a body poking out of a single-layer top is confirmed from the front view (codes " + Codes(single) + ")");
                Require(ConfirmedViews(single).Contains("front"), "① the front view is the confirming view");
                Require(single.ViewCount == 6, "① every configured view is rendered (read " + single.ViewCount + ")");
                Require(single.Files.Count >= 3, "① the renderer-index images are written for review");
                Require(File.Exists(Path.Combine(Project(), "_render-check", "render", "render_fixture_front_id.png")),
                    "① the front view's index image exists");

                // ⑥ A nearer body surface in the same pixel must not impersonate the vertex behind it: the back-face
                // vertex projects to a pixel the front face owns, and with the body off the back plate shows there.
                // This runs second on purpose: the depth check is load-bearing in most views (from the far side the
                // body's far surface owns the pixel while the pierced garment shows behind it), so every other case
                // would also catch the depth mutant. Running the impostor case here attributes that kill to it.
                NewRoot();
                Cube("Body", Vector3.zero, new Vector3(0.2f, 0.2f, 0.2f));
                Cube("Back_Plate", new Vector3(0, 0, -0.15f), new Vector3(0.16f, 0.16f, 0.02f));
                var impostor = Check(new List<FitRenderConfirm.Candidate> { Candidate(new Vector3(0, 0, -0.1f), "Back_Plate") },
                    new[] { "Body" }, views: "front");
                Require(impostor.Valid && impostor.Confirmed == 0,
                    "⑥ a nearer body surface in the same pixel does not confirm the vertex behind it (codes "
                    + Codes(impostor) + ")");

                // ② The body is under a coat: the coat owns the pixel, so nothing is visible. One view only, so this
                // case isolates "the pixel belongs to a garment" from the depth rule.
                NewRoot();
                Cube("Body", Vector3.zero, new Vector3(0.2f, 0.2f, 0.2f));
                Cube("Coat", new Vector3(0, 0, 0.15f), new Vector3(0.2f, 0.2f, 0.02f));
                var covered = Check(new List<FitRenderConfirm.Candidate> { Candidate(new Vector3(0, 0, 0.1f), "Coat") },
                    new[] { "Body" }, views: "front");
                Require(covered.Valid && covered.Confirmed == 0,
                    "② a body under a coat is not a visible pierce (codes " + Codes(covered) + ")");

                // ③ The body edge is only exposed against the background: with the body off that pixel is empty, so
                // "what shows there is the garment it pierced" is false even though the body owns the pixel.
                NewRoot();
                Cube("Body", Vector3.zero, new Vector3(0.2f, 0.2f, 0.2f));
                Cube("Side_Top", new Vector3(-0.25f, 0, 0), new Vector3(0.02f, 0.1f, 0.1f));
                var background = Check(new List<FitRenderConfirm.Candidate> { Candidate(new Vector3(0, 0, 0.1f), "Side_Top") },
                    new[] { "Body" });
                Require(background.Valid && background.Confirmed == 0,
                    "③ a body edge exposed against the background is not a visible pierce (codes " + Codes(background) + ")");

                // ④ A pierce only visible from the side: the garment is a plate perpendicular to X, so only the
                // right-hand view can see the body poking through it.
                NewRoot();
                Cube("Body", Vector3.zero, new Vector3(0.2f, 0.2f, 0.2f));
                Cube("Sleeve", new Vector3(0.05f, 0, 0), new Vector3(0.02f, 0.16f, 0.16f));
                var side = Check(new List<FitRenderConfirm.Candidate> { Candidate(new Vector3(0.1f, 0, 0), "Sleeve") },
                    new[] { "Body" });
                Require(side.Valid && side.Confirmed == 1,
                    "④ a pierce only visible from the side is confirmed by the side view (codes " + Codes(side) + ")");
                // The rule this case owns: the side view sees it, the front view does not. (That a far-side view must
                // NOT confirm it either is the depth rule, checked by case ⑥; without the depth check this case also
                // confirms from the left, which is what the mutant run showed.)
                var sideViews = ConfirmedViews(side).Split(',');
                Require(Array.IndexOf(sideViews, "right") >= 0 && Array.IndexOf(sideViews, "front") < 0,
                    "④ the confirming views include the right-hand view and not the front (read " + ConfirmedViews(side) + ")");

                // ⑤ With the body off, a DIFFERENT garment shows where the pierced one should be: not a pierce of
                // the attributed garment, so it does not count.
                NewRoot();
                Cube("Body", Vector3.zero, new Vector3(0.2f, 0.2f, 0.2f));
                Cube("Inner", new Vector3(0, 0, 0.04f), new Vector3(0.16f, 0.16f, 0.02f));
                Cube("Outer", new Vector3(0, 0, 0.07f), new Vector3(0.14f, 0.14f, 0.02f));
                var wrongGarment = Check(new List<FitRenderConfirm.Candidate> { Candidate(new Vector3(0, 0, 0.1f), "Inner") },
                    new[] { "Body" });
                Require(wrongGarment.Valid && wrongGarment.Confirmed == 0,
                    "⑤ a different garment showing where the pierced one should be does not count (codes "
                    + Codes(wrongGarment) + ")");

                // ⑦ A skinned mesh must be confirmed where its BONES put it. If the id/depth passes rendered it in
                // bind pose (a broken skinning path), the pixel would hold a different surface and the depth check
                // would reject it.
                NewRoot();
                var bone = new GameObject("Bone");
                bone.transform.SetParent(root.transform, false);
                bone.transform.localPosition = new Vector3(0.04f, 0f, 0f);
                bone.transform.localScale = Vector3.one * 0.08f;
                var skinned = new GameObject("Body_Skinned");
                skinned.transform.SetParent(root.transform, false);
                var smr = skinned.AddComponent<SkinnedMeshRenderer>();
                var template = GameObject.CreatePrimitive(PrimitiveType.Cube);
                // Clone the primitive's mesh: the bind poses live on the mesh, and the built-in cube is shared.
                fixtureMesh = Object.Instantiate(template.GetComponent<MeshFilter>().sharedMesh);
                fixtureMesh.name = "FixtureSkinnedCube";
                fixtureMesh.bindposes = new[] { Matrix4x4.identity };
                smr.sharedMesh = fixtureMesh;
                smr.sharedMaterial = template.GetComponent<MeshRenderer>().sharedMaterial;
                Object.DestroyImmediate(template);
                smr.bones = new[] { bone.transform };
                smr.rootBone = bone.transform;
                Cube("Plate", new Vector3(0.05f, 0, 0), new Vector3(0.02f, 0.3f, 0.3f));
                var skinnedResult = Check(
                    new List<FitRenderConfirm.Candidate> { Candidate(new Vector3(0.08f, 0f, 0f), "Plate") },
                    new[] { "Body_Skinned" });
                Require(skinnedResult.Valid && skinnedResult.Confirmed == 1,
                    "⑦ a skinned mesh is confirmed where its bones put it, not at its bind pose (codes "
                    + Codes(skinnedResult) + ")");
                Cleanup();

                // ⑧ The stage aggregate reads the picture check, keeps the ray count as a diagnostic, and reports
                // "not measured" (null) when the picture check did not run.
                var one = HarnessFitStage.AggregateStates(new List<Dictionary<string, object>> { Geo(2, 1, 6) });
                Require(one.Complete, "⑧ a state with a completed picture check is complete");
                Require(one.Pierced == 0,
                    "⑧ the criterion reads the render-confirmed count; one vertex is below the noise gate so it reads 0");
                Require(one.PiercedBelowGate == 1, "⑧ the below-gate vertex is kept as evidence");
                Require(one.PiercedRay == 2, "⑧ the ray criterion stays a separate reading");
                Require(one.Views == 6, "⑧ the number of views used is reported");
                Require(one.ConfirmedGarments.Count == 1, "⑧ the per-garment confirmed counts are reported");
                var entry = one.ConfirmedGarments[0] as Dictionary<string, object>;
                Require(entry != null && Convert.ToInt32(entry["vertices"]) == 1 && Convert.ToInt32(entry["ray_vertices"]) == 2,
                    "⑧ the per-garment row carries both the confirmed and the ray count");

                // ⑨ `D-146` ①: the noise gate is applied per (garment × body part) group. One group of 8 confirmed
                // vertices counts; a second group (a collar seam, say) with 2 does not — it is evidence only. The
                // ray reading is 3, on purpose: a criterion that fell back to it, or that gated on the total (10),
                // would not read 8.
                var gatedRows = new List<object>();
                for (int i = 0; i < 8; i++) gatedRows.Add(Row("Top", "Chest", i));
                for (int i = 0; i < 2; i++) gatedRows.Add(Row("Hood", "Neck", 100 + i));
                var gated = HarnessFitStage.AggregateStates(new List<Dictionary<string, object>>
                {
                    Geo(3, 10, 6, rows: gatedRows),
                });
                Require(gated.Complete, "⑨ a state with grouped picture-check rows is complete");
                Require(gated.Pierced == 8,
                    "⑨ only the group that reaches the noise gate counts toward the criterion (read " + gated.Pierced + ")");
                Require(gated.PiercedBelowGate == 2,
                    "⑨ a group below the noise gate is kept as evidence, not counted (read " + gated.PiercedBelowGate + ")");
                Require(gated.PiercedRay == 3, "⑨ the ray criterion stays a separate reading");
                Require(gated.PiercedGroups.Count == 2, "⑨ every group is reported with its garment and body part");
                var hood = gated.PiercedGroups[0] as Dictionary<string, object>;
                var top = gated.PiercedGroups[1] as Dictionary<string, object>;
                Require(hood != null && Convert.ToString(hood["garment"]) == "Hood" && Convert.ToString(hood["region"]) == "Neck"
                    && Convert.ToInt32(hood["vertices"]) == 2 && !Convert.ToBoolean(hood["counted"])
                    && (hood["views"] as List<object>).Count == 1 && (hood["pixels"] as List<object>).Count == 2,
                    "⑨ a below-gate group carries its garment, body part, confirmed count, views and pixels");
                Require(top != null && Convert.ToString(top["garment"]) == "Top" && Convert.ToInt32(top["vertices"]) == 8
                    && Convert.ToBoolean(top["counted"]),
                    "⑨ a group that reaches the noise gate is marked as counted");

                var noRender = HarnessFitStage.AggregateStates(new List<Dictionary<string, object>>
                {
                    Geo(2, null, null, withRender: false),
                });
                Require(!noRender.Complete, "⑧ a state without the picture check is incomplete");
                Require(noRender.Pierced == null, "⑧ a missing picture check leaves the criterion null, not zero");
                Require(noRender.PiercedRay == null, "⑧ an incomplete run leaves the ray reading null too");

                var invalidRender = HarnessFitStage.AggregateStates(new List<Dictionary<string, object>>
                {
                    Geo(2, null, null, renderValid: false),
                });
                Require(!invalidRender.Complete && invalidRender.Pierced == null,
                    "⑧ an invalid picture check leaves the criterion null, not zero");

                var missingState = HarnessFitStage.AggregateStates(new List<Dictionary<string, object>>
                {
                    Geo(2, 1, 6), null,
                });
                Require(!missingState.Complete && missingState.Pierced == null && missingState.PiercedRay == null,
                    "⑧ a missing state leaves every measurement null, not zero");

                // ⑩ FX1: publish through the REAL production path. The Node test reads the very file this writes
                // with the Runtime's own `parseObservation`, so every list-valued reading — per-garment counts,
                // per-(garment × body part) rows, body paths — must sit in the observation's own `details` field:
                // `metrics` accepts only numbers, booleans and null, and an array there made the frozen version's
                // real workflow fail `regression_pre` with `check regression_fit_probe_pre: error`.
                var publishDir = Path.Combine(Project(), "_fit-observation");
                Directory.CreateDirectory(publishDir);
                Avh.WriteJson(Path.Combine(publishDir, "geo_state_000.json"), Geo(3, 10, 6, rows: gatedRows));
                Avh.WriteJson(Path.Combine(publishDir, "geo_state_001.json"), Geo(2, 1, 6));
                HarnessFitStage.Publish(publishDir, new List<Dictionary<string, float>>
                {
                    new Dictionary<string, float> { ["Outfit"] = 1f },
                    new Dictionary<string, float> { ["Outfit"] = 0f },
                });
                Require(File.Exists(Path.Combine(Avh.RunDir, "observations", "avatar.fit.json")),
                    "⑩ the fit stage writes its observation through the production path");

                ok = true;
            }
            catch (Exception exception)
            {
                error = exception.ToString();
                Debug.LogException(exception);
            }
            finally { Cleanup(); }
            Write(ok, error);
            EditorApplication.Exit(ok ? 0 : 1);
        }

        static string Project()
        {
            var project = Environment.GetEnvironmentVariable("AVH_PROJECT_DIR");
            return string.IsNullOrEmpty(project) ? Directory.GetCurrentDirectory() : project;
        }

        static void Write(bool ok, string error)
        {
            var json = new StringBuilder();
            json.Append("{\"ok\":").Append(ok ? "true" : "false").Append(",\"assertions\":").Append(assertions);
            if (error != null)
                json.Append(",\"error\":\"").Append(error.Replace("\\", "\\\\").Replace("\"", "\\\"")
                    .Replace("\r", string.Empty).Replace("\n", "\\n").Replace("\t", " ")).Append('"');
            json.Append('}');
            File.WriteAllText(Path.Combine(Project(), "result.json"), json.ToString());
        }
    }
}
