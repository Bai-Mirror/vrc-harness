// Counterexample fixture for the "visible piercing" criterion (FP1 / D-139 ①). The regression criterion reads
// `fit_pierced_vertices`, which used to be the per-garment `pierced` sum: that counts one body vertex once per
// garment, so a vertex covered by an outer coat still counted because it poked out of the inner shirt, and one
// garment's lining + shell counted twice. The new criterion counts, per state, the body vertices that are outside
// EVERY garment that covers them, deduplicated by vertex, with the per-garment raw sum kept only as a diagnostic.
//
// The fixture runs the real criterion the probe calls (`AvatarAudit.VisiblePiercing.Compute`) and the real state
// aggregate the fit stage writes (`AVH.Harness.HarnessFitStage.AggregateStates`), in the same assemblies the
// product uses. Geometry cases are described by the per-vertex ray outcomes the probe produces (front face hit
// inward = pierced, back face hit outward = covered / gap >= 0); those outcomes are unchanged by this work and
// are what RG1/FW1 measured.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;
using AvatarAudit;

namespace AVH.Harness
{
    public static class VisiblePiercingIntegration
    {
        static int assertions;

        static void Require(bool ok, string message)
        {
            assertions++;
            if (!ok) throw new Exception("assertion " + assertions + ": " + message);
        }

        /// <summary>A garment's per-vertex result for one body vertex. <paramref name="piercedDepth"/> &lt; 0 means
        /// "this garment does not pierce the vertex".</summary>
        static VisiblePiercing.Layer Layer(string path, bool measured, float piercedDepth, float gap)
        {
            return new VisiblePiercing.Layer
            {
                path = path,
                piercingValid = measured,
                pierced = new[] { piercedDepth >= 0f },
                depth = new[] { piercedDepth < 0f ? 0f : piercedDepth },
                gap = new[] { gap },
            };
        }

        static VisiblePiercing.Result One(bool[] excluded, params VisiblePiercing.Layer[] layers)
        {
            return VisiblePiercing.Compute(1, excluded, new List<VisiblePiercing.Layer>(layers), 15f);
        }

        /// <summary>The per-vertex `render.confirmed` rows the probe writes, for one garment × body part group
        /// (`D-146` ①). The stage needs them to decide which groups reach the noise gate.</summary>
        static List<object> ConfirmedRows(string garment, string region, int count)
        {
            var rows = new List<object>();
            for (int i = 0; i < count; i++)
                rows.Add(new Dictionary<string, object>
                {
                    ["vertex"] = i,
                    ["layer"] = "",
                    ["garment"] = garment,
                    ["region"] = region,
                    ["depth_mm"] = 1.5d,
                    ["confirmed"] = true,
                    ["views"] = new List<object> { "front" },
                    ["pixels"] = new List<object> { i },
                    ["codes"] = new List<object> { "front:hit" },
                    ["min_body_depth_delta_mm"] = 0.1d,
                });
            return rows;
        }

        static Dictionary<string, object> Geo(int? visibleVertices, int? saturated, double? maxDepth, int raw,
            bool valid = true, bool withBlock = true, int garmentRaw = 0, int? renderVertices = null)
        {
            var garments = new List<object>();
            if (garmentRaw > 0)
                garments.Add(new Dictionary<string, object>
                {
                    ["path"] = "G",
                    ["total"] = new Dictionary<string, object> { ["pierced"] = garmentRaw, ["max_depth_mm"] = maxDepth },
                });
            var geo = new Dictionary<string, object>
            {
                ["garments"] = garments,
                ["feet"] = new List<object>(),
                ["warnings"] = new List<object>(),
            };
            if (!withBlock) return geo;
            // FP2: the criterion now reads the picture check, so a state is only "measured" when the render block is
            // there and valid. The ray reading stays available as the candidate filter.
            var block = new Dictionary<string, object>
            {
                ["valid"] = valid,
                ["vertices"] = visibleVertices,
                ["raw_vertices"] = raw,
                ["max_depth_mm"] = maxDepth,
                ["saturated_vertices"] = saturated,
                ["no_data_vertices"] = 0,
            };
            if (renderVertices != null)
                block["render"] = new Dictionary<string, object>
                {
                    ["valid"] = true,
                    ["vertices"] = renderVertices,
                    ["views"] = 6,
                    ["depth_tolerance_mm"] = 2d,
                    // D-146 ①: the criterion groups the picture check's confirmed vertices by garment × body
                    // part and only counts groups that reach the noise gate, so the geo block must carry the
                    // per-vertex rows too. One group here: `renderVertices` vertices on garment G / Chest.
                    ["confirmed"] = ConfirmedRows("G", "Chest", renderVertices.Value),
                    ["per_garment"] = new List<object>
                    {
                        new Dictionary<string, object> { ["path"] = "G", ["vertices"] = renderVertices },
                    },
                };
            geo["visible_piercing"] = block;
            return geo;
        }

        public static void Run()
        {
            bool ok = false;
            string error = null;
            try
            {
                // ① A single-layer top the body pokes through: counted, attributed to that top.
                var top = One(null, Layer("Top", true, 3f, -1f));
                Require(top.valid, "a state with a measured garment is measurable");
                Require(top.vertices == 1, "a body vertex poking out of a single-layer top counts once");
                Require(top.perGarment[0] == 1, "the visible pierce is attributed to the top");
                Require(Math.Abs(top.maxDepthMm - 3f) < 0.001f, "the visible depth is the measured depth");

                // ② The body is outside the inner shirt but inside the outer coat: the coat hides it, so it is NOT a
                // visible pierce even though the shirt's per-garment count says "pierced".
                var shirt = Layer("Shirt", true, 5f, -1f);
                var coat = Layer("Coat", true, -1f, 2f);
                var hidden = VisiblePiercing.Compute(1, null, new List<VisiblePiercing.Layer> { shirt, coat }, 15f);
                Require(hidden.vertices == 0, "a vertex outside the shirt but inside the coat is not a visible pierce");

                // ③ ONE garment with a lining and a shell, the body between the two layers: same garment pierces and
                // covers the vertex, so it is not visible.
                var lined = One(null, Layer("Coat_Lined", true, 4f, 1.5f));
                Require(lined.vertices == 0, "a vertex between the lining and the shell of one garment is not visible");
                Require(lined.noDataVertices == 0, "a measured garment is not counted as no_data");

                // ④ The same configuration with the outer coat off: the same vertex is now a visible pierce. The
                // state set is measured state by state, so the coat-off state still catches it.
                var coatOff = VisiblePiercing.Compute(1, null, new List<VisiblePiercing.Layer> { shirt }, 15f);
                Require(coatOff.vertices == 1, "with the coat off the same vertex is a visible pierce");

                // Dedup: one vertex poked through two garments counts once, and the attribution goes to the surface
                // nearest the vertex (the outer layer), not to both.
                var through = VisiblePiercing.Compute(1, null,
                    new List<VisiblePiercing.Layer> { Layer("Shirt", true, 8f, -1f), Layer("Coat", true, 2f, -1f) }, 15f);
                Require(through.vertices == 1, "one vertex pierced through two garments still counts once");
                Require(through.perGarment[1] == 1 && through.perGarment[0] == 0,
                    "the attribution goes to the nearest pierced surface (the outer layer)");

                // no_data (scope mapping failed) never hides a pierce, and its own measured hits are not dropped as 0.
                var unmeasuredCoat = VisiblePiercing.Compute(1, null,
                    new List<VisiblePiercing.Layer> { Layer("Shirt", true, 5f, -1f), Layer("Unmeasured_Coat", false, -1f, 2f) }, 15f);
                Require(unmeasuredCoat.vertices == 1, "an unmeasured garment must not hide a pierce it cannot certify");
                var unmeasuredPiercer = VisiblePiercing.Compute(1, null,
                    new List<VisiblePiercing.Layer> { Layer("Top", true, -1f, -1f), Layer("Stockings", false, 6f, -1f) }, 15f);
                Require(unmeasuredPiercer.vertices == 1, "a hit measured by a no_data garment still counts as a pierce");
                Require(unmeasuredPiercer.noDataVertices == 1, "the conservative choice is visible in the reading");

                // A depth that reaches the ray budget is reported as saturated (the FW1 observation).
                var saturated = One(null, Layer("Top", true, 15.2f, -1f));
                Require(saturated.saturated == 1, "a depth at the ray budget is reported as saturated");
                var shallow = One(null, Layer("Top", true, 5f, -1f));
                Require(shallow.saturated == 0, "a bounded depth is not reported as saturated");

                // Evidence gate: no measured garment at all is "not measured", never "clean".
                Require(!VisiblePiercing.Compute(1, null, new List<VisiblePiercing.Layer>(), 15f).valid,
                    "a state with no garment reading has no usable metric");
                Require(!VisiblePiercing.Compute(1, null,
                        new List<VisiblePiercing.Layer> { Layer("Stockings", false, 3f, -1f) }, 15f).valid,
                    "a state measured only by no_data garments has no usable metric");

                // ⑤ State set: (a) coat on + coat off are aggregated state by state, and the raw per-garment sum is
                // kept separate from the criterion; (b) a missing state or an invalid block makes the metric null.
                // FP2: the criterion reads the picture check (`render.vertices`), the ray count stays a diagnostic.
                // D-146 ①: the confirmed vertices are grouped by garment × body part and only a group that reaches
                // the noise gate (8) counts, so the visible state carries 8 confirmed vertices against 1 ray.
                var states = new List<Dictionary<string, object>>
                {
                    Geo(0, 0, 0d, 30, garmentRaw: 30, renderVertices: 0),   // coat on: nothing visible, raw sum still 30
                    Geo(1, 1, 12.5d, 30, garmentRaw: 30, renderVertices: 8), // coat off: one visible pierce, 8 confirmed vertices
                };
                var fit = HarnessFitStage.AggregateStates(states);
                Require(fit.Complete, "a complete state set is reported as complete");
                Require(fit.StatesRead == 2, "every state's evidence is read");
                Require(fit.Pierced == 8, "the criterion reads the render-confirmed count");
                Require(fit.PiercedRay == 1, "the ray criterion stays a separate reading");
                Require(fit.Raw == 60, "the per-garment raw sum stays a separate diagnostic");
                Require(fit.MaxDepth != null && Math.Abs(fit.MaxDepth.Value - 12.5d) < 0.001d,
                    "the visible max depth is reported");

                var missing = HarnessFitStage.AggregateStates(new List<Dictionary<string, object>>
                {
                    Geo(0, 0, 0d, 0, renderVertices: 0), null,
                });
                Require(!missing.Complete, "a missing state makes the reading incomplete");
                Require(missing.StatesRead == 1, "the states that did report are counted");
                Require(missing.Pierced == null, "a missing state leaves the pierce metric null, not zero");
                Require(missing.PiercedRay == null, "a missing state leaves the ray reading null too, not zero");
                Require(missing.MaxDepth == null && missing.Saturated == null && missing.Raw == null,
                    "the other measurements are null too, not zero");
                Require(missing.Footwear == null && missing.BelowSole == null,
                    "the footwear measurements are null too, not zero");

                // FP2: a valid ray block without a completed picture check is "not measured", never the ray count.
                var noRender = HarnessFitStage.AggregateStates(new List<Dictionary<string, object>>
                {
                    Geo(3, 0, 4d, 0),
                });
                Require(!noRender.Complete, "a state without the picture check makes the reading incomplete");
                Require(noRender.Pierced == null, "a missing picture check leaves the criterion null, not the ray count");
                Require(noRender.PiercedRay == null, "an incomplete run leaves the ray reading null too");

                var invalid = HarnessFitStage.AggregateStates(new List<Dictionary<string, object>>
                {
                    Geo(0, 0, 0d, 0, renderVertices: 0), Geo(null, null, null, 0, valid: false),
                });
                Require(!invalid.Complete, "an invalid visible-piercing block makes the reading incomplete");
                Require(invalid.Pierced == null, "an invalid block leaves the pierce metric null, not zero");

                var absent = HarnessFitStage.AggregateStates(new List<Dictionary<string, object>>
                {
                    Geo(0, 0, 0d, 0, withBlock: false),
                });
                Require(!absent.Complete && absent.Pierced == null,
                    "a state without the visible-piercing block leaves the pierce metric null");

                // ⑥ FX1: publish through the REAL production path. The Node test reads the very file this writes
                // with the Runtime's own `parseObservation`, so the list-valued readings (per-garment counts, the
                // per-(garment × body part) rows, body paths) must sit in the observation's own `details` field,
                // never in `metrics` — an array in `metrics` is what made the frozen version's real workflow fail
                // `regression_pre` with `check regression_fit_probe_pre: error`.
                var project = Environment.GetEnvironmentVariable("AVH_PROJECT_DIR");
                var publishDir = Path.Combine(string.IsNullOrEmpty(project) ? Directory.GetCurrentDirectory() : project,
                    "_fit-observation");
                Directory.CreateDirectory(publishDir);
                Avh.WriteJson(Path.Combine(publishDir, "geo_state_000.json"), states[0]);
                Avh.WriteJson(Path.Combine(publishDir, "geo_state_001.json"), states[1]);
                HarnessFitStage.Publish(publishDir, new List<Dictionary<string, float>>
                {
                    new Dictionary<string, float> { ["Outfit"] = 1f },
                    new Dictionary<string, float> { ["Outfit"] = 0f },
                });
                Require(File.Exists(Path.Combine(Avh.RunDir, "observations", "avatar.fit.json")),
                    "⑥ the fit stage writes its observation through the production path");

                ok = true;
            }
            catch (Exception exception)
            {
                error = exception.ToString();
                Debug.LogException(exception);
            }
            Write(ok, error);
            EditorApplication.Exit(ok ? 0 : 1);
        }

        static void Write(bool ok, string error)
        {
            var project = Environment.GetEnvironmentVariable("AVH_PROJECT_DIR");
            var path = Path.Combine(string.IsNullOrEmpty(project) ? Directory.GetCurrentDirectory() : project, "result.json");
            var json = new StringBuilder();
            json.Append("{\"ok\":").Append(ok ? "true" : "false").Append(",\"assertions\":").Append(assertions);
            if (error != null)
                json.Append(",\"error\":\"").Append(error.Replace("\\", "\\\\").Replace("\"", "\\\"")
                    .Replace("\r", string.Empty).Replace("\n", "\\n")).Append('"');
            json.Append('}');
            File.WriteAllText(path, json.ToString());
        }
    }
}
