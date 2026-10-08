// Production local revision -> recolor -> menu -> persisted full SDK output -> native switching.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;

namespace AVH.Harness
{
    public static class SharedMembersIntegration
    {
        static int assertions;
        static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (int i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1]; return d; }
        static List<object> L(params object[] values) => values.ToList();
        static void Check(bool value, string message) { assertions++; if (!value) throw new Exception(message); }
        static void Refuses(Action action, string fragment)
        {
            try { action(); } catch (Exception error) { Check(error.Message.Contains(fragment), "unrelated refusal: " + error); return; }
            throw new Exception("expected refusal: " + fragment);
        }
        static GameObject Child(GameObject parent, string name) { var go = new GameObject(name); go.transform.SetParent(parent.transform, false); return go; }
        static Material Material(string name, Color color) { var mat = new Material(Shader.Find("Standard")) { color = color }; AssetDatabase.CreateAsset(mat, "Assets/Authorized/" + name + ".mat"); return mat; }
        const string BuiltPath = "Assets/_Harness/SharedBuilt/Avatar.prefab";
        static Dictionary<string, object> Metric() => Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations/clothing.install.json")).Obj("metrics");
        static Dictionary<string, object> AvatarMetric() => Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations/avatar.observe.json")).Obj("metrics");
        static void MutateSavedAvatar(Action<GameObject> mutate)
        {
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath));
            try { mutate(avatar); PrefabUtility.SaveAsPrefabAsset(avatar, OutfitStage.AvatarPath); }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
            AssetDatabase.SaveAssets(); AssetDatabase.Refresh();
        }
        static void ExpectObservedDefaults(string snapshot, bool expected, string message)
        {
            OutfitMeasure.WriteAvatar(OutfitStage.AvatarPath, OutfitStage.RecordPath);
            Avh.WriteJson(Avh.Abs("shared-observations/avatar.observe." + snapshot + ".json"),
                Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations/avatar.observe.json")));
            Check(Equals(AvatarMetric()["group_defaults_match"], expected), message);
        }
        static IEnumerable<VRCExpressionsMenu.Control> Controls(VRCExpressionsMenu menu)
        {
            foreach (var control in menu.controls)
            {
                yield return control;
                if (control.subMenu != null) foreach (var child in Controls(control.subMenu)) yield return child;
            }
        }
        static void NativeRoundtrip(Dictionary<string, object> expected)
        {
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(BuiltPath));
            var graph = PlayableGraph.Create("Shared logical member roundtrip");
            try
            {
                var animator = avatar.GetComponent<Animator>(); animator.runtimeAnimatorController = null; animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
                var fx = AvatarAudit.Layers(avatar.GetComponent<VRCAvatarDescriptor>()).Single(layer => layer.type == VRCAvatarDescriptor.AnimLayerType.FX).controller;
                var playable = AnimatorControllerPlayable.Create(graph, fx);
                var output = AnimationPlayableOutput.Create(graph, "FX", animator); output.SetSourcePlayable(playable);
                graph.SetTimeUpdateMode(DirectorUpdateMode.Manual); graph.Play();
                var renderer = avatar.GetComponentsInChildren<MeshRenderer>(true).Single();
                var group = AvatarConfig.Groups(expected.Obj("plan")).Single();
                var members = group.List("members").Cast<Dictionary<string, object>>().ToList();
                var first = (int)AvatarConfig.Value(group, members.Single(member => member.Str("id") == "first"));
                var second = (int)AvatarConfig.Value(group, members.Single(member => member.Str("id") == "second"));
                var controls = Controls(avatar.GetComponent<VRCAvatarDescriptor>().expressionsMenu).Where(control => control.parameter?.name == "Selection").ToList();
                Check(controls.Count == 2 && controls.Any(control => control.name == "Primary" && control.value == first)
                    && controls.Any(control => control.name == "Alternate" && control.value == second), "built menu lost logical member entries or selector values");
                foreach (var value in new[] { second, first, second, first, second })
                {
                    playable.SetInteger("Selection", value);
                    for (var frame = 0; frame < 20; frame++) graph.Evaluate(1f / 60);
                    var wanted = AssetDatabase.LoadAssetAtPath<Material>(expected.Str(value == second ? "local" : "primary"));
                    Check(renderer.sharedMaterial == wanted, "local revision lost during native menu switch " + value + ": " + AssetDatabase.GetAssetPath(renderer.sharedMaterial));
                    var wantedColor = value == second ? new Color(.2f, .7f, .3f, 1) : new Color(.8f, .1f, .2f, 1);
                    Check(Vector4.Distance(renderer.sharedMaterial.color, wantedColor) < .00001f, "material properties drifted during switching");
                }
            }
            finally { if (graph.IsValid()) graph.Destroy(); UnityEngine.Object.DestroyImmediate(avatar); }
        }
        public static void Reload()
        {
            var result = D("ok", false);
            try
            {
                var expected = Avh.ReadJsonFile(Avh.Abs("shared-expected.json"));
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(expected.Obj("plan")));
                NativeRoundtrip(expected); result["ok"] = true;
            }
            catch (Exception error) { result["error"] = error.ToString(); }
            result["assertions"] = assertions; Avh.WriteJson(Avh.Abs("result.json"), result); EditorApplication.Exit(0);
        }
        public static void Run()
        {
            var result = D("ok", false);
            try
            {
                AssetDatabase.DeleteAsset("Assets/Authorized"); AssetDatabase.DeleteAsset("Assets/_Harness");
                OutfitStage.EnsureFolder("Assets/Authorized"); OutfitStage.EnsureFolder(OutfitStage.Dir);
                var primary = Material("Primary", new Color(.8f, .1f, .2f, 1)); var alternate = Material("Alternate", new Color(.1f, .2f, .8f, 1));
                var body = RecolorMaterialIntegration.Human(); body.AddComponent<VRCAvatarDescriptor>(); Child(body, "Dock");
                var bone = body.GetComponent<Animator>().GetBoneTransform(HumanBodyBones.Hips);
                var mesh = new Mesh { vertices = new[] { Vector3.zero, Vector3.up, Vector3.right }, triangles = new[] { 0, 1, 2 },
                    bindposes = new[] { bone.worldToLocalMatrix * body.transform.localToWorldMatrix },
                    boneWeights = Enumerable.Range(0, 3).Select(_ => new BoneWeight { boneIndex0 = 0, weight0 = 1 }).ToArray() };
                mesh.AddBlendShapeFrame("ToeArc", 100, Enumerable.Repeat(Vector3.forward * .01f, 3).ToArray(), new Vector3[3], new Vector3[3]);
                AssetDatabase.CreateAsset(mesh, "Assets/Authorized/Surface.asset");
                var surface = Child(body, "BodySurface").AddComponent<SkinnedMeshRenderer>(); surface.sharedMesh = mesh; surface.bones = new[] { bone }; surface.rootBone = bone; surface.sharedMaterial = primary;
                var bodyPath = "Assets/Authorized/Body.prefab"; PrefabUtility.SaveAsPrefabAsset(body, bodyPath); UnityEngine.Object.DestroyImmediate(body);
                var source = new GameObject("GenericWidget"); var visual = GameObject.CreatePrimitive(PrimitiveType.Cube); visual.name = "Piece"; visual.transform.SetParent(source.transform, false); visual.GetComponent<Renderer>().sharedMaterial = primary;
                var writer = Child(Child(source, "Nested"), "Writer").AddComponent<ModularAvatarShapeChanger>();
                writer.Shapes.Add(new ChangedShape { Object = new AvatarObjectReference { referencePath = "BodySurface" }, ShapeName = "ToeArc", ChangeType = ShapeChangeType.Set, Value = 20 });
                var firstPath = "Assets/Authorized/PrimaryWidget.prefab"; PrefabUtility.SaveAsPrefabAsset(source, firstPath);
                visual.GetComponent<Renderer>().sharedMaterial = alternate;
                var alternatePath = "Assets/Authorized/AlternateWidget.prefab"; PrefabUtility.SaveAsPrefabAsset(source, alternatePath); UnityEngine.Object.DestroyImmediate(source);
                var plan = D("schema", "plan/0.3", "body_prefab", bodyPath, "body", "body", "menu", D("mode", "assemble", "vendor_policy", "preserve_and_merge", "tree", L(D("group", "style"))),
                    "recolor", D("targets", L()), "avatar_config", D("schema", "avatar-config/0.1", "instances", L(D("id", "widget", "item", "widget", "kind", "accessory", "prefab", firstPath,
                        "variants", L(D("id", "primary", "prefab", firstPath), D("id", "alternate", "prefab", alternatePath)))),
                        "groups", L(D("id", "style", "label", "Style", "activation", "exclusive", "default", "second", "parameter", D("name", "Selection", "type", "Int", "synced", false, "saved", true),
                            "members", L(D("id", "first", "label", "Primary", "instance", "widget", "variant", "primary"), D("id", "second", "label", "Alternate", "instance", "widget", "variant", "alternate")))), "shared_switches", L()),
                    "obligations", L(D("input", "body", "role", "body", "action", "use", "target", bodyPath, "due_stage", "outfit"), D("input", "widget", "role", "other", "action", "use", "target", firstPath, "due_stage", "outfit")));
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan)); Environment.SetEnvironmentVariable("AVH_MANIFEST", Avh.Json(D("assets", L(D("item", "body"), D("item", "widget")))));
                Avh.WriteJson(Avh.Abs("_harness/setup/import.json"), D("packages", L(D("item", "body", "roots", L("Assets/Authorized")))));
                Avh.WriteJson(Avh.Abs("_harness/setup/baseline.json"), D("body_prefab", bodyPath)); AssetDatabase.SaveAssets();
                var original = AssetDatabase.LoadAssetAtPath<GameObject>(bodyPath); LocalOperations.Observe(original, plan);
                var observation = File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath));
                var mounts = L(D("source", "", "path", "Dock", "pose", "preserve"));
                var input = D("schema", "local-operations/0.1", "observation_sha256", LocalOperations.Digest(observation), "operations", L(
                    D("id", "first_mount", "kind", "assembly", "path", "_Outfit/Outfit_first", "mode", "mount", "mounts", mounts),
                    D("id", "second_mount", "kind", "assembly", "path", "_Outfit/Outfit_second", "mode", "mount", "mounts", mounts),
                    D("id", "second_tint", "kind", "material", "path", "_Outfit/Outfit_second/Piece", "renderer_index", 0, "slot", 0, "source_material", "Assets/Authorized/Alternate.mat",
                        "properties", D("_Color", D("type", "color", "value", L(.2, .7, .3, 1))))));
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input); OutfitStage.Produce();
                Check(Convert.ToInt32(Metric()["unreviewed_shrinkkey_writers"]) == 2, "missing shared writer evidence was silently waived");
                var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)); var rows = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
                Check(rows[0].Str("object") == rows[1].Str("object"), "equivalent variants lost physical sharing");
                var review = D("id", "second_review", "kind", "shrinkkey_review", "path", "_Outfit/Outfit_second", "writers", rows[1].Obj("shrinkkey").List("shapes"),
                    "rationale", "Retain measured nested writer order and ToeArc ownership; no Set/Delete conflict; appearance unmeasured.",
                    "scenarios", D("shoe_on_sock_on", "Observed covered posture expected", "shoe_off_sock_on", "Observed sock posture expected", "barefoot", "Source posture expected; verify visually"));
                input.List("operations").Add(review); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input); OutfitStage.Produce();
                Check(Convert.ToInt32(Metric()["unreviewed_shrinkkey_writers"]) == 0, "single shared writer review did not cover equivalent members");
                Check(Equals(Metric()["local_operations_valid"], true), "independent reconstruction rejected shared revisions");
                Check(Equals(Metric()["group_defaults_match"], true), "effective local member defaults failed");
                record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)); rows = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
                Check(rows.All(row => row.Obj("shrinkkey").Obj("review").Str("physical_object") == row.Str("object") && row.Obj("shrinkkey").Obj("review").Str("logical_member") == "_Outfit/Outfit_" + row.Str("id")), "review erased logical identity");
                var redundant = new Dictionary<string, object>(review) { ["id"] = "first_review", ["path"] = "_Outfit/Outfit_first" };
                input.List("operations").Add(redundant); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input); OutfitStage.Produce();
                Check(Convert.ToInt32(Metric()["unreviewed_shrinkkey_writers"]) == 0, "consistent alias evidence was rejected");
                redundant["rationale"] = "Contradictory judgment"; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input); Refuses(OutfitStage.Produce, "证据矛盾");
                input.List("operations").Remove(redundant); review["writers"] = L(); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input); Refuses(OutfitStage.Produce, "真实宿主");
                review["writers"] = rows[1].Obj("shrinkkey").List("shapes"); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input); OutfitStage.Produce();
                record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)); rows = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
                // Re-load the persisted assembly through the independent outfit observer. This is the
                // same read-only work the production capability runs as its second Unity step.
                OutfitMeasure.WriteAvatar(OutfitStage.AvatarPath, OutfitStage.RecordPath);
                ExpectObservedDefaults("positive", true, "independent outfit observer did not verify grouped defaults");
                // Exercise the actual Observe readback, including the no-local-input path where
                // GroupDefaults must derive source material slots rather than skip them.
                var physicalObject = rows[1].Str("object");
                var operationsPath = Avh.Abs(LocalOperations.InputPath);
                var savedOperations = File.ReadAllBytes(operationsPath);
                var sourceOnlyInput = Avh.ReadJsonFile(operationsPath);
                sourceOnlyInput["operations"] = sourceOnlyInput.List("operations").Cast<Dictionary<string, object>>()
                    .Where(operation => operation.Str("kind") != "material").Cast<object>().ToList();
                Avh.WriteJson(operationsPath, sourceOnlyInput); OutfitStage.Produce();
                var sourceOnlyOperations = File.ReadAllBytes(operationsPath);
                File.Delete(operationsPath);
                MutateSavedAvatar(avatar => avatar.transform.Find(physicalObject).gameObject.SetActive(false));
                ExpectObservedDefaults("wrong-visibility", false, "observer accepted a persisted default visibility error");
                File.WriteAllBytes(operationsPath, sourceOnlyOperations); OutfitStage.Produce(); File.Delete(operationsPath);
                MutateSavedAvatar(avatar =>
                {
                    var renderer = avatar.transform.Find(physicalObject + "/Piece").GetComponent<Renderer>();
                    renderer.sharedMaterials = new[] { primary };
                });
                ExpectObservedDefaults("wrong-source-material", false, "observer skipped a wrong source material");
                File.WriteAllBytes(operationsPath, savedOperations); OutfitStage.Produce();

                MutateSavedAvatar(avatar =>
                {
                    var renderer = avatar.transform.Find(physicalObject + "/Piece").GetComponent<Renderer>();
                    renderer.sharedMaterials = new[] { primary };
                });
                ExpectObservedDefaults("wrong-local-material", false, "observer accepted a wrong local material");
                OutfitStage.Produce();
                record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
                var secondRow = record.List("outfits").Cast<Dictionary<string, object>>().Single(row => row.Str("id") == "second");
                secondRow["material_presets"] = L(); Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), record);
                ExpectObservedDefaults("empty-presets", false, "observer accepted empty material presets");
                OutfitStage.Produce();
                record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
                secondRow = record.List("outfits").Cast<Dictionary<string, object>>().Single(row => row.Str("id") == "second");
                var preset = secondRow.List("material_presets").Cast<Dictionary<string, object>>().Single();
                preset.List("materials")[0] = "Assets/Authorized/Primary.mat";
                Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), record);
                ExpectObservedDefaults("tampered-presets", false, "observer accepted tampered material presets");
                OutfitStage.Produce();
                var receipt = Avh.ReadJsonFile(Avh.Abs(LocalOperations.OutputPath));
                var localPath = receipt.List("operations").Cast<Dictionary<string, object>>().Single(op => op.Str("id") == "second_tint").Str("material");
                var expected = D("local", localPath, "primary", "Assets/Authorized/Primary.mat", "plan", plan);
                OutfitStage.EnsureFolder(RecolorStage.Dir); Avh.WriteJson(Avh.Abs(RecolorStage.RecipePath), D("targets", L(), "materialOps", L(), "tiers", L(D("id", "identity", "hue_shift", 0, "saturation", 1, "value", 1)), "chosen", "identity"));
                RecolorStage.Produce();
                var selectionGroup = AvatarConfig.Groups(plan).Single();
                var selectionMembers = selectionGroup.List("members").Cast<Dictionary<string, object>>().ToList();
                var firstValue = AvatarConfig.Value(selectionGroup, selectionMembers.Single(member => member.Str("id") == "first"));
                var secondValue = AvatarConfig.Value(selectionGroup, selectionMembers.Single(member => member.Str("id") == "second"));
                var recolored = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath));
                try
                {
                    RecolorStage.SetGroupState(recolored, rows, new Dictionary<string, float> { ["Selection"] = firstValue });
                    Check(AssetDatabase.GetAssetPath(recolored.GetComponentsInChildren<MeshRenderer>(true).Single().sharedMaterial) == expected.Str("primary"), "unmodified variant material identity was lost");
                    RecolorStage.SetGroupState(recolored, rows, new Dictionary<string, float> { ["Selection"] = secondValue });
                    Check(AssetDatabase.GetAssetPath(recolored.GetComponentsInChildren<MeshRenderer>(true).Single().sharedMaterial) == localPath, "local revision lost after recolor switch and return");
                }
                finally { UnityEngine.Object.DestroyImmediate(recolored); }
                MenuStage.Produce();
                var request = Avh.Abs("shared-build.json"); Avh.WriteJson(request, D("input", MenuStage.AvatarPath, "output", "Assets/_Harness/SharedBuilt", "name", "Avatar", "report", Avh.Abs("shared-build-report.json"), "allowErrors", false));
                int code;
                try { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = MenuGroups.FinalizeReadableProperties; code = AvatarBuild.BuildArtifact.BuildOnce(request); }
                finally { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = null; }
                Check(code == 0, "full SDK shared member build failed"); AssetDatabase.SaveAssets();
                Avh.WriteJson(Avh.Abs("shared-expected.json"), expected); NativeRoundtrip(expected);
                result["ok"] = true;
            }
            catch (Exception error) { result["error"] = error.ToString(); }
            result["assertions"] = assertions; Avh.WriteJson(Avh.Abs("result.json"), result); EditorApplication.Exit(0);
        }
    }
}
