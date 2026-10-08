using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Avatars.Components;

namespace AVH.Harness
{
    public static class KeyFollowGeometryIntegration
    {
        const string Dir = "Assets/Fixture";
        static int assertions;
        static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (var i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1]; return d; }
        static List<object> L(params object[] values) => values.ToList();
        static void Check(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }

        sealed class PieceSpec
        {
            public string Name;
            public Dictionary<string, Vector3> Deltas;
            public Dictionary<string, float> Weights;
            public bool Triangles = true;
        }

        static Mesh Plane(string name, float half, float y, Dictionary<string, Vector3> deltas, bool withTriangles)
        {
            var mesh = new Mesh { name = name };
            mesh.vertices = new[] {
                new Vector3(-half, y, -half), new Vector3(half, y, -half),
                new Vector3(-half, y, half), new Vector3(half, y, half),
            };
            if (withTriangles) mesh.triangles = new[] { 0, 1, 2, 2, 1, 3 };
            foreach (var entry in deltas)
                mesh.AddBlendShapeFrame(entry.Key, 100f, Enumerable.Repeat(entry.Value, 4).ToArray(), null, null);
            mesh.boneWeights = Enumerable.Range(0, 4).Select(_ => new BoneWeight { boneIndex0 = 0, weight0 = 1f }).ToArray();
            mesh.bindposes = new[] { Matrix4x4.identity };
            AssetDatabase.CreateAsset(mesh, Dir + "/" + name + ".asset");
            return AssetDatabase.LoadAssetAtPath<Mesh>(Dir + "/" + name + ".asset");
        }

        static SkinnedMeshRenderer Skinned(GameObject owner, string name, Mesh mesh, Transform bone, Dictionary<string, float> weights)
        {
            var go = new GameObject(name);
            go.transform.SetParent(owner.transform, false);
            var smr = go.AddComponent<SkinnedMeshRenderer>();
            smr.sharedMesh = mesh; smr.bones = new[] { bone }; smr.rootBone = bone;
            foreach (var entry in weights)
            {
                var index = mesh.GetBlendShapeIndex(entry.Key);
                if (index >= 0) smr.SetBlendShapeWeight(index, entry.Value);
            }
            return smr;
        }

        static SkinnedMeshRenderer BodySkinned(GameObject owner, string name, Mesh mesh, Transform torso, Transform foot,
            Dictionary<string, float> weights, bool bindFoot = true)
        {
            var go = new GameObject(name);
            go.transform.SetParent(owner.transform, false);
            var smr = go.AddComponent<SkinnedMeshRenderer>();
            smr.sharedMesh = mesh; smr.rootBone = torso;
            if (bindFoot)
            {
                smr.bones = new[] { torso, foot };
                mesh.bindposes = new[] {
                    torso.worldToLocalMatrix * smr.transform.localToWorldMatrix,
                    foot.worldToLocalMatrix * smr.transform.localToWorldMatrix,
                };
                mesh.boneWeights = new[] {
                    new BoneWeight { boneIndex0 = 0, weight0 = 1f }, new BoneWeight { boneIndex0 = 0, weight0 = 1f },
                    new BoneWeight { boneIndex0 = 1, weight0 = 1f }, new BoneWeight { boneIndex0 = 1, weight0 = 1f },
                };
            }
            else
            {
                smr.bones = new[] { torso };
                mesh.bindposes = new[] { torso.worldToLocalMatrix * smr.transform.localToWorldMatrix };
                mesh.boneWeights = Enumerable.Repeat(new BoneWeight { boneIndex0 = 0, weight0 = 1f }, 4).ToArray();
            }
            foreach (var entry in weights)
            {
                var index = mesh.GetBlendShapeIndex(entry.Key);
                if (index >= 0) smr.SetBlendShapeWeight(index, entry.Value);
            }
            return smr;
        }

        static (double? value, object geometry, List<string> notes, List<string> notRan, List<string> ran) ProduceCase(
            string name, Dictionary<string, Vector3> bodyDeltas, Dictionary<string, float> bodyWeights,
            List<PieceSpec> pieces, bool bodyTriangles = true, bool bodyFootBinding = true)
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            OutfitStage.EnsureFolder(Dir);
            if (AssetDatabase.IsValidFolder("Assets/Authorized")) AssetDatabase.DeleteAsset("Assets/Authorized");
            OutfitStage.EnsureFolder("Assets/Authorized");
            var root = RecolorMaterialIntegration.Human();
            var descriptor = root.AddComponent<VRCAvatarDescriptor>();
            descriptor.customizeAnimationLayers = true;
            descriptor.baseAnimationLayers = new VRCAvatarDescriptor.CustomAnimLayer[0];
            descriptor.specialAnimationLayers = new VRCAvatarDescriptor.CustomAnimLayer[0];
            var bone = new GameObject("SkinBone").transform;
            bone.SetParent(root.transform, false);
            var torso = root.GetComponentsInChildren<Transform>(true).First(t => t.name == "Chest");
            var foot = root.GetComponentsInChildren<Transform>(true).First(t => t.name == "LeftFoot");
            var body = BodySkinned(root, "Body", Plane("Body_" + name, 0.25f, 0f, bodyDeltas, bodyTriangles), torso, foot, bodyWeights, bodyFootBinding);
            var outfitRoot = new GameObject(OutfitStage.Group);
            outfitRoot.transform.SetParent(root.transform, false);
            var records = new List<object>();
            var index = 0;
            foreach (var spec in pieces)
            {
                var part = new GameObject(spec.Name);
                part.transform.SetParent(outfitRoot.transform, false);
                var piece = Skinned(part, "Piece" + index, Plane("Piece_" + name + "_" + spec.Name, 0.02f, 0.05f, spec.Deltas, spec.Triangles), bone, spec.Weights);
                foreach (var key in bodyDeltas.Keys) Check(piece.sharedMesh.GetBlendShapeIndex(key) >= 0, name + ": piece missing " + key);
                records.Add(D("id", "p" + index, "object", OutfitStage.Group + "/" + spec.Name,
                    "label", spec.Name, "activation", "exclusive", "default", index == 0));
                index++;
            }
            Check(body.sharedMesh.blendShapeCount == bodyDeltas.Count, name + ": body key count mismatch");
            if (!bodyFootBinding)
            {
                Check(global::AvatarAudit.AuditPartInventory.FindBodyForRegression(root, new[] { body }) == null,
                    name + ": the unmodified shared recognizer must genuinely reject the torso-only candidate");
                // D1: the harness's body identity selects the base body the weight gate rejects. This is the
                // shape a build with the optimizer's name flattening pinned off has: the plan's body prefab is
                // the only thing that still says which mesh is the body.
                Check(global::AvatarAudit.AuditPartInventory.FindBodyForRegression(root, new[] { body },
                        new List<string> { "Body" }) == body,
                    name + ": the harness body identity must select the base body the weight gate rejects");
                Check(global::AvatarAudit.AuditPartInventory.BodyIdentity("Assets/No/Such/Body.prefab").Count == 0,
                    name + ": a body prefab that is not an asset in this project must yield no identity");
            }
            OutfitStage.EnsureFolder(BuildStage.OutDir);
            PrefabUtility.SaveAsPrefabAsset(root, BuildStage.BuiltPrefab);
            Avh.WriteJson(Avh.Abs(MenuStage.RecordPath), D("parameters", new List<object>(), "controls", new List<object>(), "conflicts", new List<object>()));
            Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), D("outfits", records));
            RegressionStage.Produce();
            var observation = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations", "avatar.verify.json"));
            Check(observation != null, name + ": missing avatar.verify");
            var metrics = observation.Obj("metrics");
            var coverage = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "coverage.json"));
            Check(coverage != null, name + ": missing coverage");
            Check(coverage.List("t1").Cast<Dictionary<string, object>>().Any(state => state.List("worn").Count > 0),
                name + ": production regression must observe visible clothing");
            if (name != "within-threshold" && name != "body-unknown")
                Check(observation.List("notes").Any(note => note.ToString().Contains("现场恢复状态=True")),
                    name + ": production geometry measurement did not record scene restoration");
            UnityEngine.Object.DestroyImmediate(root);
            var valueMetric = metrics["key_follow_value_delta_max"] == null ? (double?)null : Convert.ToDouble(metrics["key_follow_value_delta_max"]);
            return (valueMetric, metrics["key_follow_geometry_p95_mm"],
                observation.List("notes").Select(x => x.ToString()).ToList(),
                coverage.List("not_ran").Select(x => x.ToString()).ToList(),
                coverage.List("ran").Select(x => x.ToString()).ToList());
        }

        public static void Run()
        {
            try
            {
                var failureCase = Environment.GetEnvironmentVariable("AVH_KEY_FOLLOW_FAILURE_CASE");
                if (!string.IsNullOrEmpty(failureCase))
                {
                    var reading = ProduceCase(failureCase,
                        new Dictionary<string, Vector3> { ["FailureKey"] = new Vector3(0f, -0.03f, 0f) },
                        new Dictionary<string, float> { ["FailureKey"] = 80f },
                        new List<PieceSpec> { new PieceSpec { Name = "FailureGarment", Deltas = new Dictionary<string, Vector3> {
                            ["FailureKey"] = new Vector3(0f, -0.03f, 0f) }, Weights = new Dictionary<string, float> {
                            ["FailureKey"] = 20f } } });
                    Check(reading.value.HasValue && reading.value.Value > 5 && reading.geometry == null,
                        failureCase + ": failed endpoint/BVH must preserve null geometry: " + reading.geometry);
                    Check(reading.notes.Any(note => note.Contains("几何量距失败")), failureCase + ": missing failure explanation");
                    Check(reading.notRan.Any(note => note.Contains("几何量距")), failureCase + ": geometry coverage must be unmeasured");
                    Check(!reading.ran.Any(note => note.Contains("几何 p95")), failureCase + ": geometry must not be claimed as measured");
                    Avh.WriteJson(Avh.Abs("result.json"), D("ok", true, "assertions", assertions, "cases", L(
                        D("id", failureCase, "value_delta", reading.value, "geometry_p95_mm", reading.geometry))));
                    EditorApplication.Exit(0);
                    return;
                }
                var noDriver = ProduceCase("no-driver",
                    new Dictionary<string, Vector3> { ["ChestVolume"] = new Vector3(0f, -0.03f, 0f) },
                    new Dictionary<string, float> { ["ChestVolume"] = 100f },
                    new List<PieceSpec> { new PieceSpec { Name = "NoDriver", Deltas = new Dictionary<string, Vector3> { ["ChestVolume"] = new Vector3(0f, -0.03f, 0f) }, Weights = new Dictionary<string, float> { ["ChestVolume"] = 0f } } });
                Check(noDriver.value.HasValue && noDriver.value.Value > 5 && noDriver.geometry != null && Convert.ToDouble(noDriver.geometry) >= 1.0,
                    "an undriven garment key must remain a measured geometric violation: value=" + noDriver.value + ", geometry=" + noDriver.geometry + ", type=" + (noDriver.geometry == null ? "null" : noDriver.geometry.GetType().FullName));
                Check(noDriver.notes.Any(note => note.Contains("几何量距")), "no-driver geometry was not recorded");

                var bodySelection = ProduceCase("body-selection",
                    new Dictionary<string, Vector3> { ["OnlyBodyKey"] = new Vector3(0f, -0.03f, 0f) },
                    new Dictionary<string, float> { ["OnlyBodyKey"] = 100f },
                    new List<PieceSpec> {
                        new PieceSpec { Name = "ClothWithExtraA", Deltas = new Dictionary<string, Vector3> {
                            ["OnlyBodyKey"] = new Vector3(0f, -0.03f, 0f), ["ClothExtraA"] = Vector3.zero },
                            Weights = new Dictionary<string, float> { ["OnlyBodyKey"] = 0f, ["ClothExtraA"] = 100f } },
                        new PieceSpec { Name = "ClothWithExtraB", Deltas = new Dictionary<string, Vector3> {
                            ["OnlyBodyKey"] = new Vector3(0f, -0.03f, 0f), ["ClothExtraB"] = Vector3.zero },
                            Weights = new Dictionary<string, float> { ["OnlyBodyKey"] = 0f, ["ClothExtraB"] = 100f } },
                    });
                Check(bodySelection.value.HasValue && bodySelection.value.Value > 5 && bodySelection.geometry != null && Convert.ToDouble(bodySelection.geometry) >= 1.0,
                    "the shared body selector must exclude every clothing root: " + bodySelection.value);

                var multi = ProduceCase("multi",
                    new Dictionary<string, Vector3> {
                        ["BenignKey"] = new Vector3(0f, -0.0005f, 0f),
                        ["HarmfulKey"] = new Vector3(0f, -0.03f, 0f),
                        ["SameKey"] = new Vector3(0f, -0.002f, 0f),
                    },
                    new Dictionary<string, float> { ["BenignKey"] = 100f, ["HarmfulKey"] = 80f, ["SameKey"] = 50f },
                    new List<PieceSpec> {
                        new PieceSpec { Name = "BenignOutfit", Deltas = new Dictionary<string, Vector3> {
                            ["BenignKey"] = new Vector3(0f, -0.0005f, 0f), ["HarmfulKey"] = new Vector3(0f, -0.03f, 0f), ["SameKey"] = new Vector3(0f, -0.002f, 0f) },
                            Weights = new Dictionary<string, float> { ["BenignKey"] = 0f, ["HarmfulKey"] = 80f, ["SameKey"] = 50f } },
                        new PieceSpec { Name = "HarmfulOutfit", Deltas = new Dictionary<string, Vector3> {
                            ["BenignKey"] = new Vector3(0f, -0.0005f, 0f), ["HarmfulKey"] = new Vector3(0f, -0.03f, 0f), ["SameKey"] = new Vector3(0f, -0.002f, 0f) },
                            Weights = new Dictionary<string, float> { ["BenignKey"] = 0f, ["HarmfulKey"] = 20f, ["SameKey"] = 50f } },
                    });
                Check(multi.value.HasValue && multi.value.Value > 95 && multi.geometry != null && Convert.ToDouble(multi.geometry) >= 1.0,
                    "the harmful non-maximum pair across multiple outfits must determine the worst geometry: " + multi.geometry);
                Check(multi.notes.Count(note => note.Contains("几何量距")) >= 2, "all over-threshold pairs were not measured");

                var mixed = ProduceCase("mixed-failure",
                    new Dictionary<string, Vector3> {
                        ["GoodKey"] = new Vector3(0f, -0.03f, 0f), ["BadKey"] = new Vector3(0f, -0.03f, 0f),
                    },
                    new Dictionary<string, float> { ["GoodKey"] = 100f, ["BadKey"] = 100f },
                    new List<PieceSpec> {
                        new PieceSpec { Name = "Measured", Deltas = new Dictionary<string, Vector3> {
                            ["GoodKey"] = new Vector3(0f, -0.03f, 0f), ["BadKey"] = new Vector3(0f, -0.03f, 0f) },
                            Weights = new Dictionary<string, float> { ["GoodKey"] = 0f, ["BadKey"] = 0f } },
                        new PieceSpec { Name = "Unmeasurable", Deltas = new Dictionary<string, Vector3> {
                            ["GoodKey"] = new Vector3(0f, -0.03f, 0f), ["BadKey"] = new Vector3(0f, -0.03f, 0f) },
                            Weights = new Dictionary<string, float> { ["GoodKey"] = 0f, ["BadKey"] = 0f }, Triangles = false },
                    });
                Check(mixed.value.HasValue && mixed.value.Value > 5 && mixed.geometry != null && Convert.ToDouble(mixed.geometry) >= 1.0,
                    "a measured violation must remain when another pair is unavailable: " + mixed.geometry);
                Check(mixed.notRan.Any(note => note.Contains("几何量距")),
                    "coverage must list the failed pair even when a measured violation remains");

                var geometricPass = ProduceCase("geometric-pass",
                    new Dictionary<string, Vector3> { ["TinyKey"] = new Vector3(0f, -0.0005f, 0f) },
                    new Dictionary<string, float> { ["TinyKey"] = 100f },
                    new List<PieceSpec> { new PieceSpec { Name = "TinyMismatch", Deltas = new Dictionary<string, Vector3> {
                        ["TinyKey"] = new Vector3(0f, -0.0005f, 0f) }, Weights = new Dictionary<string, float> { ["TinyKey"] = 0f } } });
                Check(geometricPass.value.HasValue && geometricPass.value.Value > 5 && geometricPass.geometry != null && Convert.ToDouble(geometricPass.geometry) < 1.0,
                    "a value mismatch with sub-millimetre geometry must be measured as a direct pass: " + geometricPass.geometry);

                var broken = ProduceCase("endpoint-failure",
                    new Dictionary<string, Vector3> { ["BrokenKey"] = new Vector3(0f, -0.03f, 0f) },
                    new Dictionary<string, float> { ["BrokenKey"] = 100f },
                    new List<PieceSpec> { new PieceSpec { Name = "Broken", Deltas = new Dictionary<string, Vector3> { ["BrokenKey"] = new Vector3(0f, -0.03f, 0f) }, Weights = new Dictionary<string, float> { ["BrokenKey"] = 0f } } },
                    bodyTriangles: false);
                Check(broken.value.HasValue && broken.value.Value > 5 && broken.geometry == null, "failed body endpoint bake must stay no_data: " + broken.geometry);
                Check(broken.notes.Any(note => note.Contains("几何量距失败")), "endpoint failure was not reported");
                Check(broken.notRan.Any(note => note.Contains("几何量距")), "endpoint failure must mark geometry coverage as not measured");

                var unknownBody = ProduceCase("body-unknown",
                    new Dictionary<string, Vector3> { ["UnknownBodyKey"] = new Vector3(0f, -0.03f, 0f) },
                    new Dictionary<string, float> { ["UnknownBodyKey"] = 100f },
                    new List<PieceSpec> { new PieceSpec { Name = "VisibleGarment", Deltas = new Dictionary<string, Vector3> {
                        ["UnknownBodyKey"] = new Vector3(0f, -0.03f, 0f) }, Weights = new Dictionary<string, float> {
                        ["UnknownBodyKey"] = 0f } } }, bodyFootBinding: false);
                Check(!unknownBody.value.HasValue && unknownBody.geometry == null,
                    "an unknown body with visible clothing must preserve null/null metrics: value=" + unknownBody.value + ", geometry=" + unknownBody.geometry);
                Check(unknownBody.notRan.Any(note => note.Contains("几何量距")), "unknown body must mark geometry coverage as not measured");

                var pieceBroken = ProduceCase("piece-failure",
                    new Dictionary<string, Vector3> { ["PieceKey"] = new Vector3(0f, -0.03f, 0f) },
                    new Dictionary<string, float> { ["PieceKey"] = 100f },
                    new List<PieceSpec> { new PieceSpec { Name = "NoTriangles", Deltas = new Dictionary<string, Vector3> { ["PieceKey"] = new Vector3(0f, -0.03f, 0f) }, Weights = new Dictionary<string, float> { ["PieceKey"] = 0f }, Triangles = false } });
                Check(pieceBroken.value.HasValue && pieceBroken.value.Value > 5 && pieceBroken.geometry == null, "failed garment bake must stay no_data: " + pieceBroken.geometry);

                var within = ProduceCase("within-threshold",
                    new Dictionary<string, Vector3> { ["SmallKey"] = new Vector3(0f, -0.03f, 0f) },
                    new Dictionary<string, float> { ["SmallKey"] = 50f },
                    new List<PieceSpec> { new PieceSpec { Name = "Within", Deltas = new Dictionary<string, Vector3> { ["SmallKey"] = new Vector3(0f, -0.03f, 0f) }, Weights = new Dictionary<string, float> { ["SmallKey"] = 47f } } });
                Check(within.value.HasValue && within.value.Value <= 5 && within.geometry == null, "a value difference within threshold must pass without geometry: " + within.value);

                var resultCases = L(
                    D("id", "no-driver", "value_delta", noDriver.value, "geometry_p95_mm", noDriver.geometry),
                    D("id", "body-selection", "value_delta", bodySelection.value, "geometry_p95_mm", bodySelection.geometry),
                    D("id", "body-unknown", "value_delta", unknownBody.value, "geometry_p95_mm", unknownBody.geometry),
                    D("id", "multi", "value_delta", multi.value, "geometry_p95_mm", multi.geometry),
                    D("id", "mixed-failure", "value_delta", mixed.value, "geometry_p95_mm", mixed.geometry),
                    D("id", "geometric-pass", "value_delta", geometricPass.value, "geometry_p95_mm", geometricPass.geometry),
                    D("id", "endpoint-failure", "value_delta", broken.value, "geometry_p95_mm", broken.geometry),
                    D("id", "piece-failure", "value_delta", pieceBroken.value, "geometry_p95_mm", pieceBroken.geometry),
                    D("id", "within-threshold", "value_delta", within.value, "geometry_p95_mm", within.geometry));
                Avh.WriteJson(Avh.Abs("result.json"), D("ok", true, "assertions", assertions, "cases", resultCases));
                EditorApplication.Exit(0);
            }
            catch (Exception e)
            {
                Avh.WriteJson(Avh.Abs("result.json"), D("ok", false, "assertions", assertions, "error", e.ToString()));
                Debug.LogException(e); EditorApplication.Exit(1);
            }
        }
    }
}
