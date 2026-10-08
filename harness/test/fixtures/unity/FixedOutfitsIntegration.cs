using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;
namespace AVH.Harness
{
    public static class FixedOutfitsIntegration
    {
        static int assertions;
        static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (int i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i+1]; return d; }
        static void Check(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }
        static int Metric(string observer, string name) => Convert.ToInt32(Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations", observer + ".json")).Obj("metrics")[name]);
        static void Default(string prefab, int fixedCount, int exclusiveCount, string phase)
        {
            var output = AssetDatabase.LoadAssetAtPath<GameObject>(prefab);
            var roots = output.transform.Find(OutfitStage.Group);
            Check(roots != null && roots.childCount == fixedCount + exclusiveCount, phase + " lost a mounted root");
            for (int i = 0; i < fixedCount + exclusiveCount; i++)
                Check(roots.GetChild(i).gameObject.activeSelf == (i < fixedCount || i == fixedCount), phase + " activation mismatch " + i);
        }
        static void VariantDuplicateSiblings()
        {
            UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Single);
            if (AssetDatabase.IsValidFolder("Assets/VariantDuplicate")) AssetDatabase.DeleteAsset("Assets/VariantDuplicate");
            OutfitStage.EnsureFolder("Assets/VariantDuplicate");
            var body = RecolorMaterialIntegration.Human(); body.AddComponent<VRCAvatarDescriptor>();
            PrefabUtility.SaveAsPrefabAsset(body, "Assets/VariantDuplicate/Body.prefab"); UnityEngine.Object.DestroyImmediate(body);
            var material = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(material, "Assets/VariantDuplicate/Phone.mat");
            var mesh = new Mesh { vertices = new[] { Vector3.zero, Vector3.right, Vector3.up }, triangles = new[] { 0, 1, 2 }, bindposes = new[] { Matrix4x4.identity },
                boneWeights = new[] { new BoneWeight { boneIndex0 = 0, weight0 = 1 }, new BoneWeight { boneIndex0 = 0, weight0 = 1 }, new BoneWeight { boneIndex0 = 0, weight0 = 1 } } };
            AssetDatabase.CreateAsset(mesh, "Assets/VariantDuplicate/PhoneMesh.asset");
            var source = new GameObject("DuplicatePhones");
            var renderedPhone = new GameObject("Phone"); renderedPhone.transform.SetParent(source.transform, false);
            renderedPhone.AddComponent<SkinnedMeshRenderer>().sharedMesh = mesh; renderedPhone.GetComponent<SkinnedMeshRenderer>().sharedMaterial = material;
            renderedPhone.AddComponent<ModularAvatarBoneProxy>().boneReference = HumanBodyBones.Head;
            var menuPhone = new GameObject("Phone"); menuPhone.transform.SetParent(source.transform, false); menuPhone.AddComponent<ModularAvatarMenuItem>();
            PrefabUtility.SaveAsPrefabAsset(source, "Assets/VariantDuplicate/Outfit.prefab"); UnityEngine.Object.DestroyImmediate(source);
            var plan = D("body_prefab", "Assets/VariantDuplicate/Body.prefab", "outfits", new List<object> { D("id", "duplicate", "item", "duplicate-input",
                "prefab", "Assets/VariantDuplicate/Outfit.prefab", "label", "Duplicate siblings", "activation", "exclusive") }, "default_outfit", "duplicate", "face", D("mode", "preserve"), "menu", D("mode", "preserve"));
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
            var assembled = OutfitStage.Assemble(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/VariantDuplicate/Body.prefab"), plan, out _, out var records);
            try
            {
                var preset = ((Dictionary<string, object>)records.Single()).List("material_presets").Cast<Dictionary<string, object>>().Single();
                var target = assembled.GetComponentsInChildren<SkinnedMeshRenderer>(true).Single(renderer => renderer.name == "Phone");
                Check(preset.Str("renderer") == "_Outfit/Outfit_duplicate/Phone", "Duplicate renderer changed the public material path");
                Check(preset.List("renderer_sibling_indices").Count > 0, "Duplicate renderer lost its structural material identity");
                Check(VariantResolver.MaterialTarget(assembled.transform, preset) == target.transform, "Duplicate renderer mapped to its menu sibling");
                Check(target.sharedMaterial == material, "Duplicate renderer lost its source material during assembly");
            }
            finally { UnityEngine.Object.DestroyImmediate(assembled); }
        }
        static void UniqueSiblingMaterialFallback()
        {
            var material = AssetDatabase.LoadAssetAtPath<Material>("Assets/VariantDuplicate/Phone.mat");
            var mesh = AssetDatabase.LoadAssetAtPath<Mesh>("Assets/VariantDuplicate/PhoneMesh.asset");
            var source = new GameObject("UniqueNames");
            var spacer = new GameObject("Spacer"); spacer.transform.SetParent(source.transform, false);
            foreach (var name in new[] { "Lens", "OtherLens" })
            {
                var visual = new GameObject(name); visual.transform.SetParent(source.transform, false);
                var renderer = visual.AddComponent<SkinnedMeshRenderer>(); renderer.sharedMesh = mesh; renderer.sharedMaterial = material;
                visual.AddComponent<ModularAvatarBoneProxy>().boneReference = HumanBodyBones.Head;
            }
            PrefabUtility.SaveAsPrefabAsset(source, "Assets/VariantDuplicate/UniqueOutfit.prefab"); UnityEngine.Object.DestroyImmediate(source);
            var plan = D("body_prefab", "Assets/VariantDuplicate/Body.prefab", "outfits", new List<object> { D("id", "unique", "item", "unique-input",
                "prefab", "Assets/VariantDuplicate/UniqueOutfit.prefab", "label", "Unique siblings", "activation", "exclusive") }, "default_outfit", "unique");
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
            var assembled = OutfitStage.Assemble(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/VariantDuplicate/Body.prefab"), plan, out _, out var records);
            try
            {
                // Exercise the persisted JSON array, not just the writer's in-memory integer list.
                var record = (Dictionary<string, object>)Avh.ParseJson(Avh.Json(D("outfits", records)));
                var rows = record.List("outfits"); var row = (Dictionary<string, object>)rows.Single();
                var root = assembled.transform.Find(row.Str("object"));
                var target = root.Find("Lens").GetComponent<SkinnedMeshRenderer>();
                var other = root.Find("OtherLens").GetComponent<SkinnedMeshRenderer>();
                var presets = row.List("material_presets");
                var preset = presets.Cast<Dictionary<string, object>>().Single(p => p.Str("renderer").EndsWith("/Lens"));
                Check(Convert.ToInt32(preset.List("renderer_sibling_indices").Last()) == 1, "Unique-name fixture did not record the original sibling index");
                UnityEngine.Object.DestroyImmediate(root.Find("Spacer").gameObject);
                // Lens's old index now points to OtherLens (same Renderer type, different path), while
                // OtherLens's old index is out of bounds. Both must use their original name lookup.
                target.sharedMaterial = null; other.sharedMaterial = null;
                try { VariantResolver.ApplyMaterials(assembled, presets); }
                catch (Exception e) { throw new Exception("Unique-name material fallback failed after sibling deletion", e); }
                Check(target.sharedMaterial == material && other.sharedMaterial == material, "Unique-name material fallback applied to the wrong renderer");
                Check(VariantResolver.MaterialTarget(assembled.transform, preset) == target.transform, "Unique-name Locate fallback did not recover the renderer");
                Check(VariantResolver.MaterialTarget(assembled.transform, preset, useFind: true) == assembled.transform.Find(preset.Str("renderer")), "Unique-name check did not preserve Find fallback");
                preset.List("materials").Add(VariantResolver.Identity(null));
                OutfitStage.RefreshMaterialPresets(assembled, rows);
                Check(preset.List("materials").Count == 1, "Unique-name fallback lost the tail-removal material refresh");
            }
            finally { UnityEngine.Object.DestroyImmediate(assembled); }
        }
        static void VariantMaterialScenarios()
        {
            // Human() writes its humanoid asset here before the original scenarios prepare this folder.
            OutfitStage.EnsureFolder("Assets/Authorized");
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            try { VariantDuplicateSiblings(); UniqueSiblingMaterialFallback(); }
            finally
            {
                UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Single);
                if (AssetDatabase.IsValidFolder("Assets/VariantDuplicate")) AssetDatabase.DeleteAsset("Assets/VariantDuplicate");
                AssetDatabase.DeleteAsset("Assets/Authorized/FixtureAvatar.asset");
                AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            }
        }
        static void Scenario(int fixedCount, int exclusiveCount)
        {
            UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Single);
            foreach (var path in new[] { "Assets/Authorized", "Assets/_Harness", "Assets/_BuildArtifacts" }) if (AssetDatabase.IsValidFolder(path)) AssetDatabase.DeleteAsset(path);
            OutfitStage.EnsureFolder("Assets/Authorized");
            var body = RecolorMaterialIntegration.Human();
            var descriptor = body.AddComponent<VRCAvatarDescriptor>(); descriptor.ViewPosition = new Vector3(0, 1.7f, 0);
            descriptor.customExpressions = true;
            descriptor.expressionsMenu = ScriptableObject.CreateInstance<VRCExpressionsMenu>();
            descriptor.expressionsMenu.controls.Add(new VRCExpressionsMenu.Control { name = "Vendor", type = VRCExpressionsMenu.Control.ControlType.Toggle, parameter = new VRCExpressionsMenu.Control.Parameter { name = "VendorFlag" }, value = 1 });
            AssetDatabase.CreateAsset(descriptor.expressionsMenu, "Assets/Authorized/Vendor.asset");
            descriptor.expressionParameters = ScriptableObject.CreateInstance<VRCExpressionParameters>();
            descriptor.expressionParameters.parameters = new[] { new VRCExpressionParameters.Parameter { name = "VendorFlag", valueType = VRCExpressionParameters.ValueType.Bool } };
            AssetDatabase.CreateAsset(descriptor.expressionParameters, "Assets/Authorized/Parameters.asset");
            if (fixedCount > 0)
            {
                var controller = AnimatorController.CreateAnimatorControllerAtPath("Assets/Authorized/Vendor.controller"); controller.AddParameter("VendorFlag", AnimatorControllerParameterType.Bool);
                var on = new AnimationClip(); var off = new AnimationClip();
                AnimationUtility.SetEditorCurve(on, EditorCurveBinding.FloatCurve("_Outfit/Outfit_p0/Visual0", typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1, 1));
                AnimationUtility.SetEditorCurve(off, EditorCurveBinding.FloatCurve("_Outfit/Outfit_p0/Visual0", typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1, 0));
                AssetDatabase.CreateAsset(on, "Assets/Authorized/Visible.anim"); AssetDatabase.CreateAsset(off, "Assets/Authorized/Hidden.anim");
                var visible = controller.layers[0].stateMachine.AddState("Visible"); visible.motion = on; visible.writeDefaultValues = false;
                var hidden = controller.layers[0].stateMachine.AddState("Hidden"); hidden.motion = off; hidden.writeDefaultValues = false;
                controller.layers[0].stateMachine.defaultState = visible;
                var hide = visible.AddTransition(hidden); hide.hasExitTime = false; hide.duration = 0; hide.AddCondition(AnimatorConditionMode.If, 0, "VendorFlag");
                var show = hidden.AddTransition(visible); show.hasExitTime = false; show.duration = 0; show.AddCondition(AnimatorConditionMode.IfNot, 0, "VendorFlag");
                descriptor.customizeAnimationLayers = true;
                descriptor.baseAnimationLayers = new[] { new VRCAvatarDescriptor.CustomAnimLayer {
                    type = VRCAvatarDescriptor.AnimLayerType.FX, isDefault = false, animatorController = controller } };
            }
            var mat = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(mat, "Assets/Authorized/fixture.mat");
            var mesh = GameObject.CreatePrimitive(PrimitiveType.Cube); mesh.name = "Hair"; mesh.transform.SetParent(body.transform, false); mesh.GetComponent<Renderer>().sharedMaterial = mat;
            PrefabUtility.SaveAsPrefabAsset(body, "Assets/Authorized/Body.prefab"); UnityEngine.Object.DestroyImmediate(body);
            var specs = new List<object>();
            for (int i = 0; i < fixedCount + exclusiveCount; i++)
            {
                var root = new GameObject("Part" + i);
                var armature = new GameObject("Armature"); armature.transform.SetParent(root.transform, false); armature.AddComponent<ModularAvatarMergeArmature>();
                var visual = GameObject.CreatePrimitive(PrimitiveType.Cube); visual.name = "Visual" + i; visual.transform.SetParent(root.transform, false); visual.GetComponent<Renderer>().sharedMaterial = mat;
                if (i == 0 && fixedCount > 0) visual.AddComponent<ModularAvatarBoneProxy>().boneReference = HumanBodyBones.Head;
                var path = "Assets/Authorized/Part" + i + ".prefab"; PrefabUtility.SaveAsPrefabAsset(root, path); UnityEngine.Object.DestroyImmediate(root);
                specs.Add(D("id", "p" + i, "item", "input" + i, "prefab", path, "label", "P" + i, "activation", i < fixedCount ? "fixed" : "exclusive"));
            }
            var plan = D("body_prefab", "Assets/Authorized/Body.prefab", "outfits", specs, "face", D("mode", "preserve"), "menu", D("mode", exclusiveCount == 0 ? "preserve" : "assemble"));
            if (exclusiveCount > 0) plan["default_outfit"] = "p" + fixedCount;
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
            Avh.WriteJson(Avh.Abs("_harness/setup/baseline.json"), D("body_prefab", "Assets/Authorized/Body.prefab"));
            OutfitStage.Produce(); Default(OutfitStage.AvatarPath, fixedCount, exclusiveCount, "outfit");
            Check(Metric("clothing.install", "fixed_outfit_state_failures") == 0, "Outfit readback failed");
            var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)); var records = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
            Check(records.Count(OutfitStage.Fixed) == fixedCount, "Activation record lost fixed membership");
            if (fixedCount > 0)
            {
                var collisionBody = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Authorized/Body.prefab"));
                var foreign = GameObject.CreatePrimitive(PrimitiveType.Cube); foreign.name = "Visual0";
                foreign.transform.SetParent(collisionBody.GetComponent<Animator>().GetBoneTransform(HumanBodyBones.Head), false);
                var collisionAsset = PrefabUtility.SaveAsPrefabAsset(collisionBody, "Assets/Authorized/CollisionBody.prefab"); UnityEngine.Object.DestroyImmediate(collisionBody);
                var assembled = OutfitStage.Assemble(collisionAsset, plan, out _, out var collisionRecords);
                var first = (Dictionary<string, object>)collisionRecords[0];
                Check(first.Obj("fixed_built_paths").Str(first.Str("object") + "/Visual0") == null, "Ambiguous BoneProxy alias could certify a foreign visual");
                UnityEngine.Object.DestroyImmediate(assembled);
            }
            OutfitStage.EnsureFolder(RecolorStage.Dir);
            var adjustment = D("part", "hair", "hue_shift", 10, "saturation", 1, "value", 1);
            Avh.WriteJson(Avh.Abs(RecolorStage.RecipePath), D("targets", new List<object>{adjustment}, "chosen", "A", "reason", "fixture", "tiers", new List<object>{D("id", "A", "adjustments", new List<object>{adjustment}), D("id", "B", "adjustments", new List<object>{adjustment})}));
            RecolorStage.Produce(); Default(RecolorStage.AvatarPath, fixedCount, exclusiveCount, "recolor");
            Check(Metric("avatar.observe", "fixed_outfit_state_failures") == 0, "Recolor readback failed");
            var candidateCount = Directory.GetFiles(Path.Combine(Avh.RunDir, "candidates"), "*.png").Length;
            Check(candidateCount == 2 * Math.Max(1, exclusiveCount), "Fixed entries produced mutually exclusive candidate shots");
            // Test every candidate state with the same production helper used immediately before rendering.
            var probe = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath));
            foreach (var selected in records.Where(o => !OutfitStage.Fixed(o)))
            {
                RecolorStage.SetOutfitState(probe, records, selected.Str("id"));
                Check(OutfitMeasure.FixedFailures(probe, record, plan, new List<string>()) == 0, "Candidate disabled a fixed root");
                Check(records.Where(o => !OutfitStage.Fixed(o)).Count(o => probe.transform.Find(o.Str("object")).gameObject.activeSelf) == 1, "Candidate exclusivity lost");
            }
            if (fixedCount > 0)
            {
                probe.transform.Find(records[0].Str("object")).gameObject.SetActive(false);
                Check(OutfitMeasure.FixedFailures(probe, record, plan, new List<string>()) > 0, "Inactive fixed root passed");
                UnityEngine.Object.DestroyImmediate(probe.transform.Find(records[0].Str("object")).gameObject);
                Check(OutfitMeasure.FixedFailures(probe, record, plan, new List<string>()) > 0, "Missing fixed root passed");
                var omitted = D("outfits", records.Skip(1).Cast<object>().ToList());
                Check(OutfitMeasure.FixedFailures(probe, omitted, plan, new List<string>()) > 0, "Omitted record passed");
            }
            UnityEngine.Object.DestroyImmediate(probe);
            OutfitStage.EnsureFolder(MenuStage.Dir);
            Avh.WriteJson(Avh.Abs(MenuStage.DesignPath), D("schema", "menu-design/0.1", "selector", D("type", "radial"), "component_groups", new List<object>()));
            MenuStage.Produce();
            var menu = Avh.ReadJsonFile(Avh.Abs(MenuStage.RecordPath));
            Check(menu.List("controls").Count == exclusiveCount, "Selector includes fixed entries");
            Check(menu.List("selector_owned_paths").Count == exclusiveCount, "Selector owns fixed roots");
            // The same full preprocessing chain as BuildStage.Run, in this disposable project.
            var request = Avh.Abs("build-request.json");
            Avh.WriteJson(request, D("input", MenuStage.AvatarPath, "output", BuildStage.OutDir, "name", "Avatar", "report", Avh.Abs("build-report.json"), "allowErrors", false));
            Check(AvatarBuild.BuildArtifact.BuildOnce(request) == 0, "Full build failed; see build-report.json");
            BuildStage.Verify(BuildStage.BuiltPrefab);
            Check(Metric("avatar.observe", "fixed_outfit_state_failures") == 0, "Built default lost fixed parts");
            RegressionStage.Produce();
            Check(Metric("avatar.observe", "fixed_outfit_state_failures") == 0, "Regression disabled fixed parts");
            Check(Metric("avatar.observe", "outfit_photo_named_minus_worn") == 0, "Regression fixed/exclusive named state disagrees");
            var baked = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(BuildStage.BuiltPrefab));
            var notes = new List<string>(); Check(ColdImportStage.MenuAssertions(baked, notes) == 0, "Cold assertions: " + string.Join(";", notes));
            if (exclusiveCount == 0) Check(baked.GetComponent<VRCAvatarDescriptor>().expressionsMenu.controls.Any(c => c.name == "Vendor"), "Vendor menu lost");
            if (fixedCount > 0)
            {
                var vendorState = new AnimatorSim(baked).Evaluate(new Dictionary<string, float> { ["VendorFlag"] = 1 });
                var visualPath = records[0].Obj("fixed_built_paths").Str(records[0].Str("object") + "/Visual0");
                Check(!vendorState.Visible(visualPath) && OutfitMeasure.FixedFailures(baked, record, plan, new List<string>(), vendorState.Visible, includeVisuals: false) == 0,
                    "Vendor toggle must hide its child while retaining installed fixed membership");
                var root = AvatarAudit.Locate(baked.transform, records[1].Str("object")); root.gameObject.SetActive(false);
                Check(!new AnimatorSim(baked).Evaluate(new Dictionary<string, float>()).Visible(records[1].Str("object")), "Unanimated fixed root unexpectedly restored");
                Check(ColdImportStage.MenuAssertions(baked, new List<string>()) > 0, "Cold assertions accepted disabled fixed root");
                var missing = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(BuildStage.BuiltPrefab));
                UnityEngine.Object.DestroyImmediate(AvatarAudit.Locate(missing.transform, visualPath).gameObject);
                Check(AvatarAudit.Locate(missing.transform, visualPath) == null, "Deleted relocated visual remains");
                Check(ColdImportStage.MenuAssertions(missing, new List<string>()) > 0, "Cold assertions accepted missing fixed part after reparenting");
                UnityEngine.Object.DestroyImmediate(missing);
            }
            UnityEngine.Object.DestroyImmediate(baked);
            foreach (var folder in new[] { "candidates", "photos" }) if (Directory.Exists(Path.Combine(Avh.RunDir, folder))) Directory.Delete(Path.Combine(Avh.RunDir, folder), true);
        }
        public static void Run()
        {
            try { VariantMaterialScenarios(); Scenario(4, 0); Scenario(0, 4); Scenario(4, 2); Avh.WriteJson(Avh.Abs("result.json"), D("ok", true, "assertions", assertions)); EditorApplication.Exit(0); }
            catch (Exception e) { Avh.WriteJson(Avh.Abs("result.json"), D("ok", false, "assertions", assertions, "error", e.ToString())); Debug.LogException(e); EditorApplication.Exit(1); }
        }
    }
}
