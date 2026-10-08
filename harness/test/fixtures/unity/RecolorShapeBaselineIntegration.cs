using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEngine;
using VRC.SDK3.Avatars.Components;

namespace AVH.Harness
{
    /// Exercises the production boundary in two editor invocations: outfit writes the persisted layer first,
    /// then recolor observes it in a fresh process where SourceShapeAudit's static cache starts empty.
    public static class RecolorShapeBaselineIntegration
    {
        static Dictionary<string, object> D(params object[] pairs)
        {
            var result = new Dictionary<string, object>();
            for (var i = 0; i < pairs.Length; i += 2) result[(string)pairs[i]] = pairs[i + 1];
            return result;
        }
        static List<object> L(params object[] values) => values.ToList();
        static Material Material(string name) { var value = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(value, "Assets/Authorized/" + name + ".mat"); return value; }
        static GameObject Child(GameObject parent, string name) { var value = new GameObject(name); value.transform.SetParent(parent.transform, false); return value; }

        public static void Prepare()
        {
            try
            {
                UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Single);
                foreach (var path in new[] { "Assets/Authorized", "Assets/_Harness" }) if (AssetDatabase.IsValidFolder(path)) AssetDatabase.DeleteAsset(path);
                OutfitStage.EnsureFolder("Assets/Authorized"); OutfitStage.EnsureFolder(OutfitStage.Dir); OutfitStage.EnsureFolder(RecolorStage.Dir);
                var body = RecolorMaterialIntegration.Human(); body.AddComponent<VRCAvatarDescriptor>(); Child(body, "Dock");
                var bone = body.GetComponent<Animator>().GetBoneTransform(HumanBodyBones.Hips);
                var mesh = new Mesh { vertices = new[] { Vector3.zero, Vector3.up, Vector3.right }, triangles = new[] { 0, 1, 2 },
                    bindposes = new[] { bone.worldToLocalMatrix * body.transform.localToWorldMatrix },
                    boneWeights = Enumerable.Range(0, 3).Select(_ => new BoneWeight { boneIndex0 = 0, weight0 = 1 }).ToArray() };
                mesh.AddBlendShapeFrame("High_heel", 100, new[] { Vector3.forward, Vector3.forward, Vector3.forward }, new Vector3[3], new Vector3[3]);
                AssetDatabase.CreateAsset(mesh, "Assets/Authorized/BodyMesh.asset");
                var surface = Child(body, "Body_Base").AddComponent<SkinnedMeshRenderer>(); surface.sharedMesh = mesh; surface.bones = new[] { bone }; surface.rootBone = bone; surface.sharedMaterial = Material("Body");
                var bodyPath = "Assets/Authorized/Body.prefab"; PrefabUtility.SaveAsPrefabAsset(body, bodyPath); UnityEngine.Object.DestroyImmediate(body);

                var shoes = new GameObject("Shoes"); var shoe = GameObject.CreatePrimitive(PrimitiveType.Cube); shoe.name = "Shoe"; shoe.transform.SetParent(shoes.transform, false); shoe.GetComponent<Renderer>().sharedMaterial = AssetDatabase.LoadAssetAtPath<Material>("Assets/Authorized/Body.mat");
                var changer = shoes.AddComponent<ModularAvatarShapeChanger>(); changer.Shapes.Add(new ChangedShape { Object = new AvatarObjectReference { referencePath = "Body_Base" }, ShapeName = "High_heel", ChangeType = ShapeChangeType.Set, Value = 100 });
                var shoesPath = "Assets/Authorized/Shoes.prefab"; PrefabUtility.SaveAsPrefabAsset(shoes, shoesPath); UnityEngine.Object.DestroyImmediate(shoes);
                var plan = D("schema", "plan/0.3", "body_prefab", bodyPath, "body", "body", "menu", D("mode", "assemble", "vendor_policy", "preserve_and_merge", "tree", L()),
                    "recolor", D("targets", L(), "candidates", 1), "avatar_config", D("schema", "avatar-config/0.1", "instances", L(D("id", "shoes", "item", "shoes", "kind", "outfit", "prefab", shoesPath, "variants", L(D("id", "default", "prefab", shoesPath)))),
                        "groups", L(D("id", "style", "label", "Style", "activation", "exclusive", "default", "shoes", "parameter", D("name", "Selection", "type", "Int", "synced", false, "saved", true), "members", L(D("id", "shoes", "label", "Shoes", "instance", "shoes", "variant", "default")))), "shared_switches", L()),
                    "obligations", L(D("input", "body", "role", "body", "action", "use", "target", bodyPath, "due_stage", "outfit"), D("input", "shoes", "role", "outfit", "action", "use", "target", shoesPath, "due_stage", "outfit")));
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan)); Environment.SetEnvironmentVariable("AVH_MANIFEST", Avh.Json(D("assets", L(D("item", "body"), D("item", "shoes"))))); Avh.WriteJson(Avh.Abs("shape-plan.json"), plan);
                Avh.WriteJson(Avh.Abs("_harness/setup/import.json"), D("packages", L(D("item", "body", "roots", L("Assets/Authorized")), D("item", "shoes", "roots", L("Assets/Authorized")))));
                Avh.WriteJson(Avh.Abs("_harness/setup/baseline.json"), D("body_prefab", bodyPath)); AssetDatabase.SaveAssets();
                LocalOperations.Observe(AssetDatabase.LoadAssetAtPath<GameObject>(bodyPath), plan);
                var observation = File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath));
                var input = D("schema", "local-operations/0.1", "observation_sha256", LocalOperations.Digest(observation), "operations", L(D("id", "mount", "kind", "assembly", "path", "_Outfit/Outfit_shoes", "mode", "mount", "mounts", L(D("source", "", "path", "Dock", "pose", "preserve")))));
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input); OutfitStage.Produce();
                var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)); var row = record.List("outfits").Cast<Dictionary<string, object>>().Single();
                input.List("operations").Add(D("id", "shape_review", "kind", "shrinkkey_review", "path", row.Str("object"), "writers", row.Obj("shrinkkey").List("shapes"), "rationale", "The shoe source owns the measured High_heel Set writer.", "scenarios", D("shoe_on_sock_on", "source default", "shoe_off_sock_on", "source default", "barefoot", "source default")));
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input); OutfitStage.Produce();
                // This fixture tests independent readback, not MA's build-time shape application.
                // Persist the declared shoe-on default while keeping the immutable body source at zero.
                var assembled = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath));
                try
                {
                    var shape = assembled.transform.Find("Body_Base").GetComponent<SkinnedMeshRenderer>();
                    shape.SetBlendShapeWeight(shape.sharedMesh.GetBlendShapeIndex("High_heel"), 100);
                    PrefabUtility.SaveAsPrefabAsset(assembled, OutfitStage.AvatarPath);
                }
                finally { UnityEngine.Object.DestroyImmediate(assembled); }
                AssetDatabase.SaveAssets();
                Avh.WriteJson(Avh.Abs(RecolorStage.RecipePath), D("targets", L(), "chosen", "A", "reason", "fixture", "tiers", L(D("id", "A", "adjustments", L()))));
                Avh.WriteJson(Avh.Abs("result.json"), D("ok", true)); EditorApplication.Exit(0);
            }
            catch (Exception error) { Avh.WriteJson(Avh.Abs("result.json"), D("ok", false, "error", error.ToString())); EditorApplication.Exit(1); }
        }

        public static void Observe()
        {
            try
            {
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(Avh.ReadJsonFile(Avh.Abs("shape-plan.json"))));
                RecolorStage.Produce();
                var observation = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations", "avatar.observe.json"));
                Avh.WriteJson(Avh.Abs("result.json"), D("ok", true, "group_defaults_match", observation.Obj("metrics")["group_defaults_match"], "notes", observation.List("notes")));
                EditorApplication.Exit(0);
            }
            catch (Exception error) { Avh.WriteJson(Avh.Abs("result.json"), D("ok", false, "error", error.ToString())); EditorApplication.Exit(1); }
        }
    }
}
