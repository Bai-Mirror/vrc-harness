// Two-session save-boundary fixture. LocalOperations and Avh are the actual frozen production tools.
//
// The production shape is two Unity processes: setup runs LocalOperations.Observe() inside its stage, the
// stage body returns, Avh.Stage persists the assembly's pending writes and the editor exits; a later stage
// then assembles again and consumes the observation through LocalOperations.Apply(). A single-process
// fixture cannot see the boundary between "observation recorded" and "writes persisted", so this one runs
// as two separate launches against the same project and reports which hash component moved.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
#if !AVH_FULL_LOCAL_IT
    public static class FaceStage
    {
        public static string ValidatedOutput(string source) => source;
        public static void PrepareReadableSource(Dictionary<string, object> plan) { }
    }
    public static class VariantResolver
    {
        public static Dictionary<string, object> Identity(UnityEngine.Object asset) => throw new NotSupportedException("No grouped presets in this isolated fixture");
        public static Material Material(object reference) => throw new NotSupportedException("No grouped presets in this isolated fixture");
    }
    // LocalOperations consumes the assembly it rebuilds through two helpers that live in OutfitStage.cs, which
    // this isolated fixture does not compile. Their stubs carry the production signatures so the frozen
    // consumer stays compilable; the boundary this fixture measures is the observation digest, not the
    // material presets those helpers refresh.
    public static class EffectiveReferences
    {
        public static List<object> TrimMissingTailMaterials(GameObject avatar) => new List<object>();
    }
    public static class OutfitStage
    {
        public const string RecordPath = "Assets/_Harness/Outfit/outfit.json";
        public static Dictionary<string, object> ShrinkKeyDecision(GameObject outfit, Dictionary<string, object> specification, bool localReview = false, List<object> records = null) => new Dictionary<string, object>();
        public static void RefreshMaterialPresets(GameObject avatar, List<object> records) { }
        // LocalOperations.Verify rebuilds the expected assembly and now also runs the shape-key follow pass.
        public static Dictionary<string, object> SyncBodyShapeKeys(GameObject avatar, string bodyPath) => new Dictionary<string, object>();
        public static void EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            var parent = Path.GetDirectoryName(path).Replace('\\', '/'); EnsureFolder(parent); AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
        }
        public static GameObject Assemble(GameObject body, Dictionary<string, object> plan, out List<object> hidden, out List<object> records)
        {
            hidden = new List<object>(); records = new List<object>();
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(body);
            // The source preview no longer runs assembly or mutates imported materials.
            return avatar;
        }
    }
#endif
    public static class SaveBoundaryIntegration
    {
        const string Owned = "Assets/Authorized/assembly.mat";
        static int assertions;
        static void Require(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }
        static string FileHash(string relative)
        {
            var path = Avh.Abs(relative); if (!File.Exists(path)) return "absent";
            using var stream = File.OpenRead(path); using var sha = SHA256.Create();
            return string.Concat(sha.ComputeHash(stream).Select(b => b.ToString("x2")));
        }
        static string Composite(string relative) => LocalOperations.Digest(
            AssetDatabase.GetAssetDependencyHash(relative) + ":" + FileHash(relative) + ":" + FileHash(relative + ".meta"));

        static Dictionary<string, object> Plan()
        {
            var plan = new Dictionary<string, object> { ["body_prefab"] = "Assets/Authorized/body.prefab", ["outfits"] = new List<object>() };
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
            return plan;
        }
        public static void Run()
        {
            var phase = Environment.GetEnvironmentVariable("AVH_SAVE_BOUNDARY_PHASE") ?? "a";
            var result = new Dictionary<string, object> { ["phase"] = phase };
            try
            {
                if (phase == "a") SessionA(result); else SessionB(result);
                result["ok"] = true;
            }
            catch (Exception error) { result["ok"] = false; result["error"] = error.ToString(); }
            result["assertions"] = assertions;
            Avh.WriteJson(Avh.Abs($"result-{phase}.json"), result);
            EditorApplication.Exit((bool)result["ok"] ? 0 : 1);
        }

        // Session A stands in for setup: build the project, observe, and let the stage persist the assembly's
        // writes exactly as Avh.Stage does (SaveAssets after the body returns).
        static void SessionA(Dictionary<string, object> result)
        {
            OutfitStage.EnsureFolder("Assets/Authorized"); OutfitStage.EnsureFolder("Assets/_Harness/Outfit");
            var shader = Shader.Find("Standard") ?? Shader.Find("Hidden/InternalErrorShader");
            var body = new GameObject("Fixture");
            var part = GameObject.CreatePrimitive(PrimitiveType.Cube); part.name = "ArbitraryPart"; part.transform.SetParent(body.transform, false);
            var source = new Material(shader) { name = "Source" }; AssetDatabase.CreateAsset(source, "Assets/Authorized/source.mat");
            var owned = new Material(shader) { name = "AssemblyOwned" }; AssetDatabase.CreateAsset(owned, Owned);
            part.GetComponent<Renderer>().sharedMaterials = new[] { source, owned };
            PrefabUtility.SaveAsPrefabAsset(body, "Assets/Authorized/body.prefab"); UnityEngine.Object.DestroyImmediate(body);
            AssetDatabase.SaveAssets();
            var plan = Plan();
            Environment.SetEnvironmentVariable("AVH_MANIFEST", "{\"assets\":[{\"item\":\"A\"}]}");
            Avh.WriteJson(Avh.Abs("_harness/setup/import.json"), new Dictionary<string, object> { ["packages"] = new List<object> { new Dictionary<string, object> { ["item"] = "A", ["roots"] = new List<object> { "Assets/Authorized" } } } });
            LocalOperations.Observe(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Authorized/body.prefab"), plan);
            var observation = Avh.ParseJson(File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath))) as Dictionary<string, object>;
            // Recorded, not asserted: the production symptom belongs to the consuming session, so session A
            // must finish either way and let session B's Apply() be what fails.
            result["derived"] = observation.List("asset_derived").Contains(Owned);
            // Capture the components the observation was computed from, before the stage boundary persists
            // anything. Comparing these against a later session attributes a mismatch to that boundary or to a
            // component that genuinely moved between the two sessions.
            var atObserve = new Dictionary<string, object>
            {
                ["composite"] = Composite(Owned), ["file"] = FileHash(Owned), ["meta"] = FileHash(Owned + ".meta"),
                ["dependency"] = AssetDatabase.GetAssetDependencyHash(Owned).ToString()
            };
            // The stage body has now returned in production, which is where Avh.Stage persists pending writes.
            AssetDatabase.SaveAssets();
            // Bind a valid operation input to the observation this session produced, so session B can consume it.
            var input = new Dictionary<string, object>
            {
                ["schema"] = "local-operations/0.1",
                ["observation_sha256"] = LocalOperations.Digest(File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath))),
                ["operations"] = new List<object>()
            };
            Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
            // Publish what the observation was computed from, so session B can say which one moved.
            Avh.WriteJson(Avh.Abs("save-boundary-a.json"), new Dictionary<string, object>
            {
                ["recorded"] = observation.Obj("asset_hashes").Str(Owned),
                ["composite"] = atObserve["composite"], ["file"] = atObserve["file"], ["meta"] = atObserve["meta"],
                ["dependency"] = atObserve["dependency"]
            });
        }

        // Session B stands in for the consuming stage: a fresh editor opens the same project, assembles again,
        // and consumes the input without re-observing. Apply() must not reject the assembly's own write.
        static void SessionB(Dictionary<string, object> result)
        {
            var plan = Plan();
            var recorded = Avh.ReadJsonFile(Avh.Abs("save-boundary-a.json")) ?? throw new Exception("session A left no component record");
            var now = new Dictionary<string, object>
            {
                ["composite"] = Composite(Owned), ["file"] = FileHash(Owned), ["meta"] = FileHash(Owned + ".meta"),
                ["dependency"] = AssetDatabase.GetAssetDependencyHash(Owned).ToString()
            };
            // Diagnostic first: report component by component whether the recorded baseline still describes
            // this session's disk, so a failure names the component instead of only quoting the guard.
            result["diag"] = new Dictionary<string, object>
            {
                ["recordedComposite"] = recorded.Str("composite"), ["currentComposite"] = now.Str("composite"),
                ["compositeEqual"] = recorded.Str("composite") == now.Str("composite"),
                ["fileEqual"] = recorded.Str("file") == now.Str("file"),
                ["metaEqual"] = recorded.Str("meta") == now.Str("meta"),
                ["dependencyEqual"] = recorded.Str("dependency") == now.Str("dependency")
            };
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Authorized/body.prefab"));
            UnityEngine.Object.DestroyImmediate(OutfitStage.Assemble(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Authorized/body.prefab"), plan, out _, out _));
            LocalOperations.Apply(instance);
            UnityEngine.Object.DestroyImmediate(instance);
            Require(true, "session B consumed the observation");
        }
    }
}
