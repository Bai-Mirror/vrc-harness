// Counterexample fixture for the fit-stage pierce aggregate (task RG1 / D1). The probe marks a garment whose
// coverage scope it had to cancel as no_data (total.pierced = null); the stage must not sum that null as a zero,
// because "0" would read as "this garment does not clip" for a garment nobody measured.
// It lives in the same folder as HarnessFitStage so it runs in that assembly and calls the real entry point.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace AVH.Harness
{
    public static class FitScopeAggregateIntegration
    {
        static int assertions;

        static void Require(bool ok, string message)
        {
            assertions++;
            if (!ok) throw new Exception("assertion " + assertions + ": " + message);
        }

        static Dictionary<string, object> Garment(object pierced, object maxDepth)
        {
            var total = new Dictionary<string, object>();
            if (pierced != null) total["pierced"] = pierced;
            total["max_depth_mm"] = maxDepth;
            return new Dictionary<string, object> { ["path"] = "g", ["total"] = total };
        }

        public static void Run()
        {
            bool ok = false;
            string error = null;
            try
            {
                // Both measured: the counts add up and the deepest measured vertex wins.
                var both = HarnessFitStage.AggregateGarments(new List<Dictionary<string, object>>
                {
                    Garment(5, 3.0), Garment(7, 2.0),
                });
                Require(both.pierced == 12, "measured garments are summed");
                Require(both.maxDepth == 3.0, "the deepest measured vertex is reported");
                Require(both.noData == 0, "measured garments do not count as no_data");

                // A no_data garment (null pierced) contributes nothing and is counted separately. Summing it as 0
                // was the old behaviour: the null was coerced to 0 and the criterion read a clean garment.
                var mixed = HarnessFitStage.AggregateGarments(new List<Dictionary<string, object>>
                {
                    Garment(5, 3.0), Garment(null, null), Garment(7, 9.0),
                });
                Require(mixed.pierced == 12, "a no_data garment does not change the pierce total");
                Require(mixed.noData == 1, "a no_data garment is reported as unmeasured");
                Require(mixed.maxDepth == 9.0, "a no_data garment's depth is not treated as a measured one");

                // A garment whose totals were never written is unmeasured, not clean.
                var missing = HarnessFitStage.AggregateGarments(new List<Dictionary<string, object>>
                {
                    new Dictionary<string, object> { ["path"] = "g" },
                    new Dictionary<string, object> { ["path"] = "g", ["total"] = new Dictionary<string, object>() },
                });
                Require(missing.pierced == 0, "missing totals contribute no pierce count");
                Require(missing.noData == 2, "missing totals are unmeasured");

                // No states at all stays a zero/zero reading rather than throwing.
                var none = HarnessFitStage.AggregateGarments(new List<Dictionary<string, object>>());
                Require(none.pierced == 0 && none.noData == 0 && none.maxDepth == 0d, "an empty state set aggregates to zero");

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
