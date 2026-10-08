// Synthetic assembly fixture; LocalOperations and Avh are the actual frozen production tools.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
#if !AVH_FULL_LOCAL_IT
    public static class FaceStage
    {
        public static string ValidatedOutput(string source) => source;
        // This fixture tests local operations only; the full SDK fixture exercises actual face preparation.
        public static void PrepareReadableSource(Dictionary<string, object> plan) { }
    }
    public static class VariantResolver
    {
        public static Dictionary<string, object> Identity(UnityEngine.Object asset) => throw new NotSupportedException("No grouped presets in this isolated fixture");
        public static Material Material(object reference) => throw new NotSupportedException("No grouped presets in this isolated fixture");
    }
    // LocalOperations consumes the assembly it rebuilds through these helpers, which live in OutfitStage.cs
    // and are not compiled into this isolated fixture.
    public static class EffectiveReferences
    {
        public static List<object> TrimMissingTailMaterials(GameObject avatar) => new List<object>();
    }
    public static class OutfitStage
    {
        public const string RecordPath = "Assets/_Harness/Outfit/outfit.json";
        public static Dictionary<string, object> ShrinkKeyDecision(GameObject outfit, Dictionary<string, object> specification, bool localReview = false, List<object> records = null) => new Dictionary<string, object>();
        public static void RefreshMaterialPresets(GameObject avatar, List<object> records) { }
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
            // Raw observation and later assembly preserve imported assets; local edits use derived copies.
            return avatar;
        }
    }
#endif
    public static class LocalOperationsIntegration
    {
        static int assertions;
        static void Require(bool ok, string message) { if (!ok) throw new Exception(message); assertions++; }
        static void Refuses(Action body, string message) { try { body(); } catch { assertions++; return; } throw new Exception(message); }
        public static void Run()
        {
            try
            {
                OutfitStage.EnsureFolder("Assets/Authorized"); OutfitStage.EnsureFolder("Assets/Unapproved"); OutfitStage.EnsureFolder("Assets/_Harness/Outfit");
                var shader = Shader.Find("Standard") ?? Shader.Find("Hidden/InternalErrorShader");
                var material = new Material(shader); AssetDatabase.CreateAsset(material, "Assets/Authorized/source.mat");
                var texture = new Texture2D(2, 2); File.WriteAllBytes(Avh.Abs("Assets/Authorized/paint.png"), texture.EncodeToPNG()); UnityEngine.Object.DestroyImmediate(texture);
                AssetDatabase.ImportAsset("Assets/Authorized/paint.png");
                var body = new GameObject("Fixture"); var part = GameObject.CreatePrimitive(PrimitiveType.Cube); part.name = "ArbitraryPart"; part.transform.SetParent(body.transform, false);
                var alternate = new Material(Shader.Find("Unlit/Color")) { name = "Alternate" };
                AssetDatabase.CreateAsset(alternate, "Assets/Authorized/alternate.mat");
                // Consumed by the body prefab and rewritten by assembly; never a source of any operation.
                var assemblyOwned = new Material(shader) { name = "AssemblyOwned" };
                AssetDatabase.CreateAsset(assemblyOwned, "Assets/Authorized/assembly.mat");
                AssetDatabase.CreateAsset(new Material(material), "Assets/Unapproved/source.mat");
                part.GetComponent<Renderer>().sharedMaterials = new[] { material, null, alternate, assemblyOwned };
                var optional = new GameObject("OptionalPart"); optional.transform.SetParent(body.transform, false);
#if AVH_FULL_LOCAL_IT
                // The four mount-point structures this reading has to separate (D-110): only a proxy that names
                // neither serialized field is unmounted. MA derives `target` from boneReference/subPath
                // (ModularAvatarBoneProxy.cs:182-208), so in batch mode it is null for the configured ones too.
                var mounts = new GameObject("MountProbe"); mounts.transform.SetParent(body.transform, false);
                var boneRefOnly = new GameObject("BoneRefOnly"); boneRefOnly.transform.SetParent(mounts.transform, false);
                boneRefOnly.AddComponent<nadena.dev.modular_avatar.core.ModularAvatarBoneProxy>().boneReference = HumanBodyBones.Head;
                var subPathOnly = new GameObject("SubPathOnly"); subPathOnly.transform.SetParent(mounts.transform, false);
                subPathOnly.AddComponent<nadena.dev.modular_avatar.core.ModularAvatarBoneProxy>().subPath = "MissingTarget";
                // Assigning `target` goes through MA's static mapping, which records the serialized pair; it needs
                // an avatar root and an animator or it silently does nothing, so the assertion below checks it took.
                var targetSet = new GameObject("TargetSet"); targetSet.transform.SetParent(mounts.transform, false);
                targetSet.AddComponent<VRC.SDK3.Avatars.Components.VRCAvatarDescriptor>();
                targetSet.AddComponent<Animator>();
                var anchored = new GameObject("Anchored"); anchored.transform.SetParent(targetSet.transform, false);
                targetSet.AddComponent<nadena.dev.modular_avatar.core.ModularAvatarBoneProxy>().target = anchored.transform;
                // OptionalPart keeps a proxy with no mount point: the inactive/included and EditorOnly readings
                // below still need a subject, and `subPath` is deliberately left empty.
                optional.AddComponent<nadena.dev.modular_avatar.core.ModularAvatarBoneProxy>();
                var writerHost = new GameObject("FootWriter"); writerHost.transform.SetParent(body.transform, false);
                var writer = writerHost.AddComponent<nadena.dev.modular_avatar.core.ModularAvatarShapeChanger>();
                writer.Shapes = new List<nadena.dev.modular_avatar.core.ChangedShape> {
                    new nadena.dev.modular_avatar.core.ChangedShape { ShapeName = "FootHeel", ChangeType = nadena.dev.modular_avatar.core.ShapeChangeType.Set, Value = 100 },
                    new nadena.dev.modular_avatar.core.ChangedShape { ShapeName = "BodyShrink", ChangeType = nadena.dev.modular_avatar.core.ShapeChangeType.Set, Value = 100 }
                };
#endif
                PrefabUtility.SaveAsPrefabAsset(body, "Assets/Authorized/body.prefab"); UnityEngine.Object.DestroyImmediate(body);
                var addon = GameObject.CreatePrimitive(PrimitiveType.Cube); PrefabUtility.SaveAsPrefabAsset(addon, "Assets/Authorized/addon.prefab");
                PrefabUtility.SaveAsPrefabAsset(addon, "Assets/Unapproved/addon.prefab"); UnityEngine.Object.DestroyImmediate(addon);
                AssetDatabase.SaveAssets();
                var original = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Authorized/body.prefab");
                var plan = new Dictionary<string, object> { ["body_prefab"] = "Assets/Authorized/body.prefab", ["outfits"] = new List<object>() };
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
                Environment.SetEnvironmentVariable("AVH_MANIFEST", "{\"assets\":[{\"item\":\"A\"}]}");
                Avh.WriteJson(Avh.Abs("_harness/setup/import.json"), new Dictionary<string, object> { ["packages"] = new List<object> { new Dictionary<string, object> { ["item"] = "A", ["roots"] = new List<object> { "Assets/Authorized" } } } });
                LocalOperations.Observe(original, plan);
                var observation = File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath));
                var observed = Avh.ParseJson(observation) as Dictionary<string, object>;
                // The observation's own assembly rewrote a material it consumed, so the baseline split is
                // asserted further down, after Apply has consumed the input: the production symptom of getting
                // that split wrong is Apply itself throwing on the stage's own write, and a counterexample has
                // to fail on that path rather than on an artifact assertion that runs before it.
                var input = Avh.ParseJson("{\"schema\":\"local-operations/0.1\",\"observation_sha256\":\"" + LocalOperations.Digest(observation) + "\",\"operations\":[" +
                    "{\"id\":\"paint\",\"kind\":\"material\",\"path\":\"ArbitraryPart\",\"renderer_index\":0,\"slot\":0,\"source_material\":\"Assets/Authorized/source.mat\",\"properties\":{\"_Color\":{\"type\":\"color\",\"value\":[0.2,0.4,0.6,1]},\"_MainTex\":{\"type\":\"texture\",\"value\":\"Assets/Authorized/paint.png\"}}}," +
                    "{\"id\":\"position\",\"kind\":\"transform\",\"path\":\"ArbitraryPart\",\"position\":[0.1,0.2,0.3]}," +
                    "{\"id\":\"addon\",\"kind\":\"attach\",\"path\":\"ArbitraryPart\",\"prefab\":\"Assets/Authorized/addon.prefab\",\"scale\":[0.1,0.1,0.1]}," +
                    "{\"id\":\"optional\",\"kind\":\"object_state\",\"path\":\"OptionalPart\",\"active\":false,\"exclude_from_build\":true,\"rationale\":\"fixture: this optional part is not part of the delivered avatar\"}," +
                    "{\"id\":\"fill\",\"kind\":\"material\",\"path\":\"ArbitraryPart\",\"renderer_index\":0,\"slot\":1,\"source_material\":\"Assets/Authorized/source.mat\",\"properties\":{\"_Color\":{\"type\":\"color\",\"value\":[1,1,1,1]}}}," +
                    "{\"id\":\"replace\",\"kind\":\"material\",\"path\":\"ArbitraryPart\",\"renderer_index\":0,\"slot\":2,\"source_material\":\"Assets/Authorized/source.mat\",\"properties\":{\"_Color\":{\"type\":\"color\",\"value\":[1,1,1,1]}}}]}") as Dictionary<string, object>;
#if AVH_FULL_LOCAL_IT
                input.List("operations").Add(new Dictionary<string, object> { ["id"] = "foot_policy", ["kind"] = "foot_writer", ["path"] = "FootWriter", ["component_index"] = 1,
                    ["remove_shapes"] = new List<object> { "FootHeel" }, ["rationale"] = "Preserve default geometry while removing the observed conditional foot writer; visual fitting remains pending." });
                Require(Equals(OutfitStage.ShrinkKeyDecision(original, new Dictionary<string, object>())["review_required"], true), "Source foot risk was not reported");
#endif
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                var sourceBytes = File.ReadAllBytes(Avh.Abs("Assets/Authorized/source.mat"));
#if !AVH_FULL_LOCAL_IT
                // Production order: Observe runs inside the setup stage, whose body then returns, and that is
                // where Avh.Stage persists the assembly's pending writes. The outfit stage assembles again and
                // only afterwards consumes the operation input. Reproduce that stage boundary here, or the
                // fixture would hash in-memory state on both sides and never reproduce what production sees.
                AssetDatabase.SaveAssets();
                var assemblyBytes = File.ReadAllBytes(Avh.Abs("Assets/Authorized/assembly.mat"));
                var stageAssembly = OutfitStage.Assemble(original, plan, out _, out _);
                UnityEngine.Object.DestroyImmediate(stageAssembly);
                AssetDatabase.SaveAssets();
                Require(assemblyBytes.SequenceEqual(File.ReadAllBytes(Avh.Abs("Assets/Authorized/assembly.mat"))), "Assembling the same source twice changed the material the assembly owns");
#endif
                var instance = (GameObject)PrefabUtility.InstantiatePrefab(original); LocalOperations.Apply(instance);
                PrefabUtility.SaveAsPrefabAsset(instance, "Assets/_Harness/Outfit/Avatar.prefab"); UnityEngine.Object.DestroyImmediate(instance); AssetDatabase.SaveAssets();
                // Apply above is the real call path and has now consumed the operation input without throwing,
                // which is the production symptom this fixture exists to catch. Only then check the artifact
                // split that makes it work: the assembly-rewritten material stays in the observed set but must
                // not be part of the read-only baseline a later operation is checked against.
                Require(observed.Obj("asset_hashes").ContainsKey("Assets/Authorized/assembly.mat"), "Assembly-rewritten material left the observed set");
#if !AVH_FULL_LOCAL_IT
                Require(observed.List("asset_derived").Count == 0 && observed.Str("phase") == "source_preview", "Source observation ran assembly or excluded source hashes");
#endif
                var final = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/_Harness/Outfit/Avatar.prefab"); var loaded = (GameObject)PrefabUtility.InstantiatePrefab(final);
                var notes = new List<string>();
                Require(LocalOperations.Verify(loaded, original, plan, notes), "Independent reload failed: " + string.Join(";", notes));
                Require(loaded.transform.Find("ArbitraryPart").localPosition == new Vector3(.1f,.2f,.3f), "Transform did not change");
                Require(loaded.transform.Find("ArbitraryPart/_Local_addon") != null, "Attachment did not persist");
                var painted = loaded.transform.Find("ArbitraryPart").GetComponent<Renderer>().sharedMaterial;
                Require(AssetDatabase.GetAssetPath(painted).StartsWith("Assets/_Harness/Outfit/Local_"), "Material did not use a generated copy");
                Require(Math.Abs(painted.GetColor("_Color").g - .4f) < .00001f, "Color did not persist");
                Require(AssetDatabase.GetAssetPath(painted.GetTexture("_MainTex")) == "Assets/Authorized/paint.png", "Texture did not persist");
                Require(sourceBytes.SequenceEqual(File.ReadAllBytes(Avh.Abs("Assets/Authorized/source.mat"))), "Original material changed");
                var assigned = loaded.transform.Find("ArbitraryPart").GetComponent<Renderer>().sharedMaterials;
                Require(assigned[1] != null && assigned[1].shader == material.shader, "Empty observed slot did not receive the copied material");
                Require(assigned[2].shader == material.shader && assigned[2].shader != alternate.shader, "Observed replacement shader did not persist");
                Require(original.transform.Find("ArbitraryPart").GetComponent<Renderer>().sharedMaterials[1] == null, "Original empty material slot changed");
#if AVH_FULL_LOCAL_IT
                var retained = loaded.transform.Find("FootWriter").GetComponent<nadena.dev.modular_avatar.core.ModularAvatarShapeChanger>();
                Require(retained.Shapes.Count == 1 && retained.Shapes[0].ShapeName == "BodyShrink", "Foot policy changed unrelated shape writers");
                Require(Equals(OutfitStage.ShrinkKeyDecision(loaded, new Dictionary<string, object>())["review_required"], false), "Actual removed foot writer still required an approval");
                Require(original.transform.Find("FootWriter").GetComponent<nadena.dev.modular_avatar.core.ModularAvatarShapeChanger>().Shapes.Count == 2, "Original shape writer changed");
                retained.Shapes.Add(new nadena.dev.modular_avatar.core.ChangedShape { ShapeName = "FootHeel" });
                Require(!LocalOperations.Verify(loaded, original, plan, new List<string>()), "Removed writer reappeared without failing readback");
                retained.Shapes.RemoveAt(retained.Shapes.Count - 1);
#endif
                Require(!loaded.transform.Find("OptionalPart").gameObject.activeSelf && loaded.transform.Find("OptionalPart").CompareTag("EditorOnly"), "Object state did not persist");
                loaded.transform.Find("OptionalPart").gameObject.SetActive(true);
                Require(!LocalOperations.Verify(loaded, original, plan, new List<string>()), "Changed active state passed reload");
                loaded.transform.Find("OptionalPart").gameObject.SetActive(false);
                loaded.transform.Find("OptionalPart").tag = "Untagged";
                Require(!LocalOperations.Verify(loaded, original, plan, new List<string>()), "Missing build exclusion passed reload");
#if AVH_FULL_LOCAL_IT
                // A proxy with no mount point is reported on its own reading rather than as a missing bone:
                // counting it as one both misnames the reading and lets a prop block the assembly stage
                // (see OutfitStage.UnmountedBoneProxies, which says so). OptionalPart is deliberately left
                // inactive, so an object that is inactive but included still has to be seen at all; the three
                // configured structures beside it must not be reported, or a correctly mounted prop blocks
                // the stage again. First check that assigning `target` actually recorded a mount point.
                // Read the mount point off the reloaded instance, never off the source objects: the scene body was
                // destroyed as soon as it was saved, so touching its components throws MissingReferenceException.
                var loadedTargetSet = loaded.transform.Find("MountProbe/TargetSet");
                var loadedTargetProxy = loadedTargetSet == null ? null : loadedTargetSet.GetComponent<nadena.dev.modular_avatar.core.ModularAvatarBoneProxy>();
                Require(loadedTargetProxy != null && loadedTargetProxy.subPath == "Anchored",
                    "Assigning a BoneProxy target recorded no mount point; the target structure would test nothing");
                var mountReading = OutfitMeasure.UnmountedBoneProxies(loaded);
                Require(mountReading.Count == 1 && mountReading[0] == "BoneProxy:OptionalPart",
                    "Mount-point reading mixed configured and unconfigured proxies: " + string.Join(",", mountReading));
#endif
                loaded.transform.Find("OptionalPart").tag = "EditorOnly";
#if AVH_FULL_LOCAL_IT
                // The tag, not the reading, is what excludes a mount point: the only unconfigured proxy left
                // is OptionalPart, and tagging it EditorOnly must drop it from the report.
                Require(OutfitMeasure.UnmountedBoneProxies(loaded).Count == 0, "Build-excluded proxy must not be reported as an unmounted mount point");
#endif
#if AVH_FULL_LOCAL_IT
                var policyPlan = new Dictionary<string, object> { ["body_prefab"] = "Assets/Authorized/body.prefab", ["outfits"] = new List<object> {
                    new Dictionary<string, object> { ["id"] = "policy_fixture" },
                    new Dictionary<string, object> { ["id"] = "mount_probe" } } };
                var policyRecord = new Dictionary<string, object> { ["body_prefab"] = "Assets/Authorized/body.prefab", ["outfits"] = new List<object> {
                    new Dictionary<string, object> { ["id"] = "policy_fixture", ["object"] = "FootWriter", ["shrinkkey"] = new Dictionary<string, object> { ["review_required"] = true, ["review_ok"] = true } },
                    new Dictionary<string, object> { ["id"] = "mount_probe", ["object"] = "MountProbe" } } };
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(policyPlan)); Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), policyRecord);
                OutfitMeasure.Write("Assets/Authorized/body.prefab", OutfitStage.RecordPath);
                var sourcePolicy = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations/clothing.install.json")).Obj("metrics");
                Require(Convert.ToInt32(sourcePolicy["unreviewed_shrinkkey_writers"]) == 1, "Observer trusted a fabricated writer approval instead of actual components and plan");
                // The metric the process check reads, not the helper: a configured mount point must not reach it.
                Require(Convert.ToInt32(sourcePolicy["unmounted_bone_proxies"]) == 0,
                    "Observer reported a configured mount point as unmounted: " + sourcePolicy["unmounted_bone_proxies"]);
                OutfitMeasure.Write(OutfitStage.AvatarPath, OutfitStage.RecordPath);
                var actualPolicy = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations/clothing.install.json")).Obj("metrics");
                Require(Convert.ToInt32(actualPolicy["unreviewed_shrinkkey_writers"]) == 0, "Observer did not recompute the actual removed foot writer");
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
                Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), new Dictionary<string, object> { ["schema"] = "outfit/0.3", ["body_prefab"] = "Assets/Authorized/body.prefab", ["mode"] = "preserve", ["outfits"] = new List<object>() });
                OutfitMeasure.Write(OutfitStage.AvatarPath, OutfitStage.RecordPath);
                var measured = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations/clothing.install.json")).Obj("metrics");
                Require(Equals(measured["local_operations_valid"], true) && Equals(measured["authorized_local_variant_valid"], true), "Actual outfit observer did not verify authorized local modifications");
                Require(Equals(measured["preserved_outfit_unmodified"], false), "Modified output falsely claimed to be an unmodified source");
                OptimizeStage.CreatePreservedOutput(final);
                var downstream = AssetDatabase.LoadAssetAtPath<GameObject>(OptimizeStage.AvatarPath);
                Require(downstream != null && AssetDatabase.GetAssetPath(PrefabUtility.GetCorrespondingObjectFromSource(downstream)) == "Assets/_Harness/Outfit/Avatar.prefab", "Existing downstream consumer did not bind the modified source version");
                var downstreamInstance = (GameObject)PrefabUtility.InstantiatePrefab(downstream);
                Require(LocalOperations.Verify(downstreamInstance, original, plan, new List<string>()), "Downstream output lost operation results");
                UnityEngine.Object.DestroyImmediate(downstreamInstance);
                loaded = (GameObject)PrefabUtility.InstantiatePrefab(final);
#endif
                loaded.transform.Find("ArbitraryPart").localPosition = Vector3.zero;
                Require(!LocalOperations.Verify(loaded, original, plan, new List<string>()), "Changed operation result passed");
                loaded.transform.Find("ArbitraryPart").localPosition = new Vector3(.1f,.2f,.3f);
                loaded.transform.Find("ArbitraryPart").GetComponent<Collider>().enabled = false;
                Require(!LocalOperations.Verify(loaded, original, plan, new List<string>()), "Unrelated component override passed");
                var ops = input.List("operations"); var attach = ops[2] as Dictionary<string, object>; attach["prefab"] = "Assets/Unapproved/addon.prefab";
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Unapproved attachment passed");
                attach["prefab"] = "Assets/Authorized/addon.prefab"; input["observation_sha256"] = new string('0', 64);
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Stale observation passed");
                input["observation_sha256"] = LocalOperations.Digest(observation); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                var materialOp = ops[0] as Dictionary<string, object>;
#if AVH_FULL_LOCAL_IT
                var footOp = ops[6] as Dictionary<string, object>;
                footOp["remove_shapes"] = new List<object> { "BodyShrink" }; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Non-foot writer removal passed");
                footOp["remove_shapes"] = new List<object> { "FootHeel" }; footOp["approved"] = true; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "AI-written approval field passed");
                footOp.Remove("approved");
#endif
                materialOp["source_material"] = "Assets/Unapproved/source.mat"; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Unobserved material source passed");
                materialOp["source_material"] = "Assets/Authorized/source.mat";
                materialOp["renderer_index"] = .5; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Fractional renderer index passed");
                materialOp["renderer_index"] = 0;
                ops.Add(new Dictionary<string, object>(materialOp) { ["id"] = "duplicate" }); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Duplicate material-slot writer passed");
                ops.RemoveAt(ops.Count - 1); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                var state = ops[3] as Dictionary<string, object>;
                state["active"] = "false"; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "String active state passed");
                state["active"] = false; state["exclude_from_build"] = false; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Upstream build exclusion could be withdrawn");
                state["exclude_from_build"] = true; state["path"] = ""; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Avatar root state passed");
                state["path"] = "OptionalPart";
                ops.Add(new Dictionary<string, object>(state) { ["id"] = "other_state" }); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Duplicate object state passed");
                ops.RemoveAt(ops.Count - 1);
                Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/design.json"), new Dictionary<string, object> { ["targetId"] = "fixture" });
                Avh.WriteJson(Avh.Abs("_harness/face/observation.json"), new Dictionary<string, object> { ["targets"] = new List<object> { new Dictionary<string, object> { ["targetId"] = "fixture", ["rendererPath"] = "OptionalPart" } } });
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Selected face target could be excluded");
                File.Delete(Avh.Abs("Assets/_Harness/Face/design.json")); File.Delete(Avh.Abs("_harness/face/observation.json"));
                var changedPlan = new Dictionary<string, object>(plan) { ["notes"] = "new plan revision" }; Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(changedPlan));
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Old plan input passed after revision");
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
                material.SetColor("_Color", Color.red); EditorUtility.SetDirty(material); AssetDatabase.SaveAssets();
                Require(!sourceBytes.SequenceEqual(File.ReadAllBytes(Avh.Abs("Assets/Authorized/source.mat"))), "Drift fixture did not change the source bytes");
                Refuses(() => LocalOperations.Apply((GameObject)PrefabUtility.InstantiatePrefab(original)), "Source drift passed");
#if AVH_FULL_LOCAL_IT
                var layeredPlan = new Dictionary<string, object> { ["body_prefab"] = "Assets/Authorized/body.prefab", ["outfits"] = new List<object> {
                    new Dictionary<string, object> { ["id"] = "layer", ["prefab"] = "Assets/Authorized/body.prefab", ["activation"] = "fixed" } } };
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(layeredPlan)); LocalOperations.Observe(original, layeredPlan);
                var layeredObservation = File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath));
                var layeredInput = new Dictionary<string, object> { ["schema"] = "local-operations/0.1", ["observation_sha256"] = LocalOperations.Digest(layeredObservation), ["operations"] = new List<object> {
                    new Dictionary<string, object> { ["id"] = "layer_optional", ["kind"] = "object_state", ["path"] = "_Outfit/Outfit_layer/OptionalPart", ["exclude_from_build"] = true, ["rationale"] = "fixture: the layered optional part is excluded from the build" } } };
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), layeredInput);
                var layered = OutfitStage.Assemble(original, layeredPlan, out _, out var layeredRecords); LocalOperations.Apply(layered, records: layeredRecords);
                Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), new Dictionary<string, object> { ["body_prefab"] = "Assets/Authorized/body.prefab", ["outfits"] = layeredRecords });
                PrefabUtility.SaveAsPrefabAsset(layered, OutfitStage.AvatarPath); UnityEngine.Object.DestroyImmediate(layered);
                var layeredPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath); var layeredReload = (GameObject)PrefabUtility.InstantiatePrefab(layeredPrefab);
                Require(AssetDatabase.GetAssetPath(PrefabUtility.GetCorrespondingObjectFromOriginalSource(layeredReload.transform.Find("_Outfit").gameObject)) == OutfitStage.AvatarPath, "Actual saved group did not reproduce the generated origin");
                var layeredNotes = new List<string>(); Require(LocalOperations.Verify(layeredReload, original, layeredPlan, layeredNotes), "Actual layered assembly reload rejected generated group: " + string.Join(";", layeredNotes));
                var outfitRoot = layeredReload.transform.Find("_Outfit/Outfit_layer").gameObject;
                var review = new Dictionary<string, object> { ["id"] = "writer_review", ["kind"] = "shrinkkey_review", ["path"] = "_Outfit/Outfit_layer",
                    ["writers"] = OutfitStage.ShrinkKeyDecision(outfitRoot, new Dictionary<string, object>()).List("shapes"),
                    ["rationale"] = "Retain observed source ownership and hierarchy order; no shape conflict; appearance remains pending.",
                    ["scenarios"] = new Dictionary<string, object> { ["shoe_on_sock_on"] = "Vendor foot posture with covering parts on; verify visually.",
                        ["shoe_off_sock_on"] = "Sock-owned posture expected; verify visually.", ["barefoot"] = "Neutral with all covering writers off; verify visually." } };
                layeredInput.List("operations").Add(review); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), layeredInput);
                LocalOperations.Apply(layeredReload, false);
                // The real independent measurement must consume the technical plan supplement, never a receipt flag.
                Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), new Dictionary<string, object> { ["body_prefab"] = "Assets/Authorized/body.prefab",
                    ["outfits"] = layeredRecords });
                OutfitMeasure.Write(OutfitStage.AvatarPath, OutfitStage.RecordPath);
                var measurement = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations/clothing.install.json"));
                Require(Convert.ToInt32(measurement.Obj("metrics")["unreviewed_shrinkkey_writers"]) == 0, "Independent outfit measurement ignored the local plan revision");
                layeredReload = (GameObject)PrefabUtility.InstantiatePrefab(layeredPrefab); outfitRoot = layeredReload.transform.Find("_Outfit/Outfit_layer").gameObject;
                var reviewed = OutfitStage.ShrinkKeyDecision(outfitRoot, new Dictionary<string, object>(), true).Obj("review");
                Require(reviewed.Str("status") == "runtime_verified" && reviewed.Str("visual_scenarios") == "pending_regression", "Technical review invented appearance acceptance");
                review["status"] = "approved"; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), layeredInput);
                Refuses(() => LocalOperations.Apply(layeredReload, false), "AI-written approval flag passed"); review.Remove("status");
                review["writers"] = new List<object>(); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), layeredInput);
                Refuses(() => OutfitMeasure.Write(OutfitStage.AvatarPath, OutfitStage.RecordPath), "Missing actual writers passed independent measurement");
                layeredReload = (GameObject)PrefabUtility.InstantiatePrefab(layeredPrefab); outfitRoot = layeredReload.transform.Find("_Outfit/Outfit_layer").gameObject;
                review["writers"] = OutfitStage.ShrinkKeyDecision(outfitRoot, new Dictionary<string, object>()).List("shapes");
                var expectations = review.Obj("scenarios"); expectations.Remove("barefoot"); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), layeredInput);
                Refuses(() => LocalOperations.Apply(layeredReload, false), "Missing barefoot expectation passed"); expectations["barefoot"] = "Neutral expected; unmeasured.";
                layeredInput.List("operations").Add(new Dictionary<string, object>(review) { ["id"] = "duplicate_review" }); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), layeredInput);
                Refuses(() => LocalOperations.Apply(layeredReload, false), "Duplicate review passed"); layeredInput.List("operations").RemoveAt(layeredInput.List("operations").Count - 1);
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), layeredInput);
                var actualWriter = outfitRoot.transform.Find("FootWriter").GetComponent<nadena.dev.modular_avatar.core.ModularAvatarShapeChanger>();
                actualWriter.Shapes[0].ShapeName = "OtherFoot";
                Refuses(() => OutfitStage.ShrinkKeyDecision(outfitRoot, new Dictionary<string, object>(), true), "Actual writer drift passed review");
                actualWriter.Shapes[0].ShapeName = "FootHeel";
                var competingHost = new GameObject("CompetingWriter"); competingHost.transform.SetParent(outfitRoot.transform, false);
                var competing = competingHost.AddComponent<nadena.dev.modular_avatar.core.ModularAvatarShapeChanger>();
                competing.Shapes = new List<nadena.dev.modular_avatar.core.ChangedShape> { new nadena.dev.modular_avatar.core.ChangedShape {
                    ShapeName = "FootHeel", ChangeType = nadena.dev.modular_avatar.core.ShapeChangeType.Set, Value = 50 } };
                review["writers"] = OutfitStage.ShrinkKeyDecision(outfitRoot, new Dictionary<string, object>()).List("shapes"); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), layeredInput);
                Refuses(() => OutfitStage.ShrinkKeyDecision(outfitRoot, new Dictionary<string, object>(), true), "Conflicting multiwriter values passed automatic review");
                UnityEngine.Object.DestroyImmediate(competingHost);
                UnityEngine.Object.DestroyImmediate(layeredReload);
#endif
                Avh.WriteJson(Avh.Abs("result.json"), new Dictionary<string, object> { ["ok"] = true, ["assertions"] = assertions });
                EditorApplication.Exit(0);
            }
            catch (Exception error) { Avh.WriteJson(Avh.Abs("result.json"), new Dictionary<string, object> { ["ok"] = false, ["error"] = error.ToString(), ["assertions"] = assertions }); EditorApplication.Exit(1); }
        }
    }
}
