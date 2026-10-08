// Synthetic structures exercise the production observe -> recipe -> assemble -> reload path.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEngine;
using VRC.SDK3.Avatars.Components;

namespace AVH.Harness
{
    public static class AssemblyLoopIntegration
    {
        static int assertions;
        static Dictionary<string, object> D(params object[] values) { var result = new Dictionary<string, object>(); for (var i = 0; i < values.Length; i += 2) result[(string)values[i]] = values[i + 1]; return result; }
        static List<object> L(params object[] values) => values.ToList();
        static void Require(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }
        static void Refuses(Action action, string message, string expected = null)
        {
            try { action(); }
            catch (Exception error) { if (expected != null && !error.Message.Contains(expected)) throw new Exception(message + ": unrelated refusal", error); assertions++; return; }
            throw new Exception(message);
        }
        static GameObject Child(GameObject parent, string name) { var result = new GameObject(name); result.transform.SetParent(parent.transform, false); return result; }
        static string Save(GameObject value, string name) { var path = "Assets/Authorized/" + name + ".prefab"; PrefabUtility.SaveAsPrefabAsset(value, path); UnityEngine.Object.DestroyImmediate(value); return path; }
        static void Skin(GameObject root, params Transform[] bones)
        {
            var mesh = new Mesh { vertices = new[] { Vector3.zero, Vector3.up, Vector3.right }, triangles = new[] { 0, 1, 2 },
                bindposes = bones.Select(bone => bone.worldToLocalMatrix * root.transform.localToWorldMatrix).ToArray(),
                boneWeights = Enumerable.Range(0, 3).Select(index => new BoneWeight { boneIndex0 = index % bones.Length, weight0 = 1 }).ToArray() };
            AssetDatabase.CreateAsset(mesh, "Assets/Authorized/" + root.name + ".asset");
            var renderer = Child(root, "Visual").AddComponent<SkinnedMeshRenderer>(); renderer.sharedMesh = mesh; renderer.bones = bones; renderer.rootBone = bones[0];
        }
        static GameObject Human()
        {
            var root = new GameObject("UnseenBase"); var bones = new List<HumanBone>(); var skeleton = new List<SkeletonBone>();
            skeleton.Add(new SkeletonBone { name = root.name, rotation = Quaternion.identity, scale = Vector3.one });
            var rig = Child(root, "Articulation"); skeleton.Add(new SkeletonBone { name = rig.name, rotation = Quaternion.identity, scale = Vector3.one });
            Transform Add(string human, Transform parent, Vector3 position)
            {
                var bone = Child(parent.gameObject, "Body_" + human).transform; bone.localPosition = position;
                bones.Add(new HumanBone { boneName = bone.name, humanName = human, limit = new HumanLimit { useDefaultValues = true } });
                skeleton.Add(new SkeletonBone { name = bone.name, position = position, rotation = Quaternion.identity, scale = Vector3.one }); return bone;
            }
            var hips = Add("Hips", rig.transform, new Vector3(0, 1, 0)); var spine = Add("Spine", hips, new Vector3(0, .2f, 0));
            var chest = Add("Chest", spine, new Vector3(0, .2f, 0)); var neck = Add("Neck", chest, new Vector3(0, .2f, 0)); Add("Head", neck, new Vector3(0, .15f, 0));
            foreach (var side in new[] { "Left", "Right" })
            {
                var sign = side == "Left" ? -1 : 1;
                var leg = Add(side + "UpperLeg", hips, new Vector3(sign * .1f, -.1f, 0)); var knee = Add(side + "LowerLeg", leg, new Vector3(0, -.4f, 0)); Add(side + "Foot", knee, new Vector3(0, -.4f, .05f));
                var arm = Add(side + "UpperArm", chest, new Vector3(sign * .2f, .1f, 0)); var elbow = Add(side + "LowerArm", arm, new Vector3(sign * .3f, 0, 0)); Add(side + "Hand", elbow, new Vector3(sign * .25f, 0, 0));
            }
            var humanAvatar = AvatarBuilder.BuildHumanAvatar(root, new HumanDescription { human = bones.ToArray(), skeleton = skeleton.ToArray(),
                upperArmTwist = .5f, lowerArmTwist = .5f, upperLegTwist = .5f, lowerLegTwist = .5f, armStretch = .05f, legStretch = .05f });
            Require(humanAvatar.isValid && humanAvatar.isHuman, "invalid synthetic humanoid");
            AssetDatabase.CreateAsset(humanAvatar, "Assets/Authorized/Human.asset"); root.AddComponent<Animator>().avatar = humanAvatar;
            Child(root, "BodyRig"); Child(root.transform.Find("BodyRig").gameObject, "Socket");
            root.AddComponent<VRCAvatarDescriptor>(); return root;
        }
        static Dictionary<string, object> Observation() => Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations/clothing.install.json"));
        static Dictionary<string, object> Metric() => Observation().Obj("metrics");
        public static void Run()
        {
            var result = D("ok", false);
            try
            {
                AssetDatabase.DeleteAsset("Assets/Authorized"); AssetDatabase.DeleteAsset("Assets/_Harness");
                OutfitStage.EnsureFolder("Assets/Authorized"); OutfitStage.EnsureFolder(OutfitStage.Dir);
                var body = Human();
                var rig = body.transform.Find("Articulation").gameObject; Child(rig, "JointZ");
                Child(body, "SocketLeft").transform.localPosition = new Vector3(1, 2, 3);
                Child(body, "SocketRight").transform.localPosition = new Vector3(-1, 2, 3);
                var bodyPath = Save(body, "base");
                var garment = new GameObject("VendorSkin"); var mergeRoot = Child(garment, "SourceRig"); var sourceJoint = Child(mergeRoot, "JointZ");
                var merge = mergeRoot.AddComponent<ModularAvatarMergeArmature>(); merge.mergeTarget.referencePath = "Articulation";
                Skin(garment, sourceJoint.transform); var skinPath = Save(garment, "skin");
                var plain = new GameObject("LayeredSkin"); var envelope = Child(plain, "Envelope"); var clothRig = Child(envelope, "ClothRig");
                var hips = Child(clothRig, "Body_Hips"); var spine = Child(hips, "Body_Spine"); var chest = Child(spine, "Body_Chest");
                // Same name as a bone that exists one level deeper on this avatar: MergeArmature's own mapping
                // refuses both this bone and any mapping below it, so no mapping may be demanded of it.
                var tiered = Child(chest, "JointZ");
                Skin(plain, chest.transform, tiered.transform); var plainPath = Save(plain, "plain");
                // A merge whose prefix leaves one used bone outside the walk while the body does hold its name at
                // the mapped level: this is the shape that must still fail rather than pass on level alone.
                var prefixSkin = new GameObject("PrefixSkin"); var prefixRig = Child(prefixSkin, "SourceRig");
                var prefixMerge = prefixRig.AddComponent<ModularAvatarMergeArmature>();
                prefixMerge.mergeTarget.referencePath = "Articulation"; prefixMerge.prefix = "Wear_";
                var wearHips = Child(prefixRig, "Wear_Body_Hips"); var bareSpine = Child(wearHips, "Body_Spine");
                Skin(prefixSkin, wearHips.transform, bareSpine.transform); var prefixPath = Save(prefixSkin, "prefix");
                var material = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(material, "Assets/Authorized/Observed.mat");
                var rigid = new GameObject("SplitRigid"); var a = GameObject.CreatePrimitive(PrimitiveType.Cube); a.name = "WingA"; a.transform.SetParent(rigid.transform, false);
                var b = GameObject.CreatePrimitive(PrimitiveType.Sphere); b.name = "WingB"; b.transform.SetParent(rigid.transform, false);
                a.GetComponent<Renderer>().sharedMaterial = material;
                var rigidPath = Save(rigid, "rigid");
                var proxyProp = new GameObject("VendorProp"); Child(proxyProp, "Socket");
                var moving = Child(proxyProp, "MovingPart"); var proxyVisual = GameObject.CreatePrimitive(PrimitiveType.Cube);
                proxyVisual.name = "Visual"; proxyVisual.transform.SetParent(moving.transform, false);
                var proxy = moving.AddComponent<ModularAvatarBoneProxy>(); proxy.boneReference = HumanBodyBones.LastBone;
                proxy.subPath = "VendorProp/Socket"; proxy.attachmentMode = BoneProxyAttachmentMode.AsChildKeepWorldPose;
                var humanoidMount = Child(proxyProp, "HumanoidMount");
                var humanoidProxy = humanoidMount.AddComponent<ModularAvatarBoneProxy>(); humanoidProxy.boneReference = HumanBodyBones.Head;
                humanoidProxy.subPath = null; humanoidProxy.attachmentMode = BoneProxyAttachmentMode.AsChildKeepWorldPose;
                var proxyPath = Save(proxyProp, "VendorProp");
                var collisionProp = new GameObject("CollisionProp"); Child(collisionProp, "Socket");
                var validBody = Child(collisionProp, "ValidBody").AddComponent<ModularAvatarBoneProxy>();
                validBody.boneReference = HumanBodyBones.LastBone; validBody.subPath = "BodyRig/Socket";
                var invalidBody = Child(collisionProp, "InvalidBody").AddComponent<ModularAvatarBoneProxy>();
                invalidBody.boneReference = HumanBodyBones.LastBone; invalidBody.subPath = "NonexistentBody/Socket";
                var collisionPath = Save(collisionProp, "CollisionProp");
                File.WriteAllText(Avh.Abs("Assets/Authorized/only-model.obj"), "o RawModel\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
                AssetDatabase.ImportAsset("Assets/Authorized/only-model.obj", ImportAssetOptions.ForceSynchronousImport);
                var plan = D("schema", "plan/0.3", "body_prefab", bodyPath, "body", "base",
                    "avatar_config", D("schema", "avatar-config/0.1", "instances", L(
                        D("id", "vendor", "item", "skin", "kind", "outfit", "prefab", skinPath, "compatibility", "pending_assembly"),
                        D("id", "plain", "item", "plain", "kind", "accessory", "prefab", plainPath, "compatibility", "pending_assembly"),
                        D("id", "rigid", "item", "rigid", "kind", "accessory", "prefab", rigidPath, "compatibility", "pending_assembly"),
                        D("id", "proxy", "item", "proxy", "kind", "accessory", "prefab", proxyPath, "compatibility", "pending_assembly"),
                        D("id", "raw", "item", "raw", "kind", "accessory", "prefab", "Assets/Authorized/only-model.obj", "compatibility", "pending_assembly")),
                        "groups", L(D("id", "attachments", "activation", "fixed", "members", L(D("id", "merged", "instance", "vendor"), D("id", "recipe_skin", "instance", "plain"), D("id", "split", "instance", "rigid"), D("id", "proxy_mount", "instance", "proxy"))),
                            D("id", "models", "activation", "exclusive", "default", "model_second", "parameter", D("name", "Model", "type", "Int", "synced", false),
                                "members", L(D("id", "model", "instance", "raw"), D("id", "model_second", "instance", "raw")))), "shared_switches", L()),
                    "obligations", L(D("input", "base", "role", "body", "action", "use", "target", bodyPath, "due_stage", "outfit"),
                        D("input", "plain", "role", "other", "action", "use", "target", plainPath, "due_stage", "outfit"),
                        D("input", "skin", "role", "outfit", "action", "use", "target", skinPath, "due_stage", "outfit"),
                        D("input", "rigid", "role", "other", "action", "use", "target", rigidPath, "due_stage", "outfit"),
                        D("input", "proxy", "role", "other", "action", "use", "target", proxyPath, "due_stage", "outfit"),
                        D("input", "raw", "role", "other", "action", "use", "target", "Assets/Authorized/only-model.obj", "due_stage", "outfit")));
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
                Environment.SetEnvironmentVariable("AVH_MANIFEST", Avh.Json(D("assets", L(D("item", "base"), D("item", "skin"), D("item", "plain"), D("item", "rigid"), D("item", "proxy"), D("item", "raw")))));
                Avh.WriteJson(Avh.Abs("_harness/setup/import.json"), D("packages", L(D("item", "base", "roots", L("Assets/Authorized")))));
                Avh.WriteJson(Avh.Abs("_harness/setup/baseline.json"), D("body_prefab", bodyPath));
                AssetDatabase.SaveAssets();
                var original = AssetDatabase.LoadAssetAtPath<GameObject>(bodyPath);
                LocalOperations.Observe(original, plan);
                var text = File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath)); var observation = Avh.ParseJson(text) as Dictionary<string, object>;
                Require(observation.Str("phase") == "source_preview", "setup did not observe raw sources before assembly");
                Require(observation.List("sources").Cast<Dictionary<string, object>>().Any(s => s.Str("asset") == "Assets/Authorized/only-model.obj" && s.Str("form") == "Model"), "model without prefab disappeared from source observation");
                Require(AssetDatabase.LoadAssetAtPath<GameObject>(rigidPath).GetComponentsInChildren<ModularAvatarBoneProxy>(true).Length == 0, "observation modified the source");
                Require(AssetDatabase.LoadAssetAtPath<GameObject>(plainPath).GetComponentsInChildren<ModularAvatarMergeArmature>(true).Length == 0, "plain source already had MA");
                Require(AssetDatabase.LoadAssetAtPath<GameObject>(proxyPath).GetComponentInChildren<ModularAvatarBoneProxy>(true).subPath == "VendorProp/Socket",
                    "source vendor subPath was modified during observation");
                Require(observation.List("objects").Cast<Dictionary<string, object>>().Any(o => o.Str("path") == "_Outfit/Outfit_model_second"), "raw second preview disappeared");
                Refuses(OutfitStage.Produce, "rigid unknown installation silently passed without a recipe");
                var mounts = L(D("source", "WingA", "path", "SocketLeft", "pose", "relative", "position", L(.1, .2, .3), "rotation", L(0, 20, 0)),
                    D("source", "WingB", "path", "SocketRight", "pose", "preserve"));
                var op = D("id", "split_mount", "kind", "assembly", "path", "_Outfit/Outfit_split", "mode", "mount", "mounts", mounts);
                var modelOp = D("id", "model_mount", "kind", "assembly", "path", "_Outfit/Outfit_model", "mode", "mount",
                    "mounts", L(D("source", "", "path", "SocketRight", "pose", "preserve")));
                var secondModelOp = D("id", "model_second_mount", "kind", "assembly", "path", "_Outfit/Outfit_model_second", "mode", "mount", "mounts", modelOp["mounts"]);
                var plainOp = D("id", "plain_merge", "kind", "assembly", "path", "_Outfit/Outfit_recipe_skin", "mode", "merge");
                var secondPath = "_Outfit/Outfit_model_second";
                var rendererPath = observation.List("objects").Cast<Dictionary<string, object>>().First(o => (o.Str("path") == secondPath || o.Str("path").StartsWith(secondPath + "/")) && o.List("renderers").Count > 0).Str("path");
                var move = D("id", "second_move", "kind", "transform", "path", secondPath, "position", L(.4, .5, .6));
                var state = D("id", "second_state", "kind", "object_state", "path", secondPath, "active", true,
                    "rationale", "fixture: the second model instance stays visible in the delivered default state");
                var tint = D("id", "second_material", "kind", "material", "path", rendererPath, "renderer_index", 0, "slot", 0,
                    "source_material", "Assets/Authorized/Observed.mat", "properties", D("_Color", D("type", "color", "value", L(.2, .3, .4, 1))));
                var attach = D("id", "second_attach", "kind", "attach", "path", secondPath, "prefab", rigidPath, "scale", L(.5, .5, .5));
                var input = D("schema", "local-operations/0.1", "observation_sha256", LocalOperations.Digest(text), "operations", L(op, modelOp, secondModelOp, plainOp, move, state, tint, attach));
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                OutfitStage.Produce();
                // The fixture's garment carries a bone that shares its name with an avatar bone one level deeper:
                // MergeArmature never merges it, so the production observer must not report it at all. A flat name
                // set over the whole body subtree reports it, which is the defect this fixture pins.
                Require(!Observation().List("notes").Any(note => note.ToString().Contains("蒙皮骨未按真实层级映射")),
                    "a same-named bone at another level was reported as unmapped");
                Require(Equals(Metric()["local_operations_valid"], true), "independent reload rejected valid mounts");
                Require(Convert.ToInt32(Metric()["assembly_compatibility_failures"]) == 0,
                    "valid actual mapping and multi-mount pose failed: " + Avh.Json(Metric()) + " notes=" + string.Join(";", Observation().List("notes")));
                Require(Convert.ToInt32(Metric()["unmet_obligations"]) == 0, "own installation instance did not satisfy other");
                var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
                var members = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
                var first = members.Single(r => r.Str("id") == "model"); var second = members.Single(r => r.Str("id") == "model_second");
                Require(first.Str("object") == second.Str("object") && Equals(second["default"], true), "D-107 default second must share first physical instance");
                var receipt = Avh.ReadJsonFile(Avh.Abs(LocalOperations.OutputPath));
                Require(receipt.Obj("logical_objects").Str(secondPath) == second.Str("object"), "receipt lacks explicit logical to physical mapping");
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath);
                var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                try
                {
                    var proxyRow = members.Single(r => r.Str("id") == "proxy_mount");
                    var proxyRoot = avatar.transform.Find(proxyRow.Str("object"));
                    var proxyComponent = proxyRoot.GetComponentsInChildren<ModularAvatarBoneProxy>(true).Single(p => p.boneReference == HumanBodyBones.LastBone);
                    var expectedSocket = proxyRoot.Find("Socket");
                    Require(expectedSocket != null && proxyComponent.subPath == proxyRow.Str("object") + "/Socket"
                        && proxyComponent.attachmentMode == BoneProxyAttachmentMode.AsChildKeepWorldPose
                        && OutfitMeasure.ResolveProxy(avatar, proxyComponent) == expectedSocket,
                        "absolute LastBone subPath was not rebased to the installed outfit");
                    var humanoidComponent = proxyRoot.GetComponentsInChildren<ModularAvatarBoneProxy>(true).Single(p => p.boneReference == HumanBodyBones.Head);
                    Require(string.IsNullOrWhiteSpace(humanoidComponent.subPath)
                        && OutfitMeasure.ResolveProxy(avatar, humanoidComponent) == avatar.GetComponent<Animator>().GetBoneTransform(HumanBodyBones.Head),
                        "empty subPath did not resolve through the humanoid bone reference");
                    var ancestorCase = new GameObject("AncestorProxy"); ancestorCase.transform.SetParent(proxyRoot, false);
                    var ancestorProxy = ancestorCase.AddComponent<ModularAvatarBoneProxy>(); ancestorProxy.target = avatar.transform;
                    ancestorProxy.attachmentMode = BoneProxyAttachmentMode.AsChildKeepWorldPose;
                    Require(OutfitMeasure.AssemblyFailures(avatar, proxyRoot.gameObject, proxyRow, new List<string>()) == 0,
                        "a legal ancestor target was rejected as a proxy cycle");
                    UnityEngine.Object.DestroyImmediate(ancestorCase);
                    var broken = new GameObject("BrokenProxy"); broken.transform.SetParent(proxyRoot, false);
                    var brokenComponent = broken.AddComponent<ModularAvatarBoneProxy>(); brokenComponent.subPath = "OtherVendor/MissingSocket";
                    Require(OutfitMeasure.AssemblyFailures(avatar, proxyRoot.gameObject, proxyRow, new List<string>()) > 0,
                        "an unresolved absolute subPath passed compatibility");
                    UnityEngine.Object.DestroyImmediate(broken);
                    var cycleRoot = new GameObject("ProxyCycles"); cycleRoot.transform.SetParent(avatar.transform.Find("_Outfit"), false);
                    var selfCase = Child(cycleRoot, "SelfCase"); var selfProxy = selfCase.AddComponent<ModularAvatarBoneProxy>(); selfProxy.target = selfCase.transform;
                    var descendantCase = Child(cycleRoot, "DescendantCase"); var descendantTarget = Child(descendantCase, "Target");
                    var descendantProxy = descendantCase.AddComponent<ModularAvatarBoneProxy>(); descendantProxy.target = descendantTarget.transform;
                    var cycleA = Child(cycleRoot, "CycleA"); var cycleB = Child(cycleRoot, "CycleB");
                    var cycleProxyA = cycleA.AddComponent<ModularAvatarBoneProxy>(); cycleProxyA.target = cycleB.transform;
                    var cycleProxyB = cycleB.AddComponent<ModularAvatarBoneProxy>(); cycleProxyB.target = cycleA.transform;
                    var cycleNotes = new List<string>();
                    Require(OutfitMeasure.AssemblyFailures(avatar, cycleRoot, D("id", "proxy_cycles", "mounts", L()), cycleNotes) >= 3,
                        "self, descendant, or mutually recursive proxy targets passed compatibility: " + string.Join(";", cycleNotes));
                    UnityEngine.Object.DestroyImmediate(cycleRoot);
                    // Two separate outfit roots can still form one MA reparent cycle; measuring either
                    // root must attribute its own member of the global cycle.
                    var crossA = new GameObject("CrossOutfitA"); crossA.transform.SetParent(avatar.transform.Find("_Outfit"), false);
                    var crossB = new GameObject("CrossOutfitB"); crossB.transform.SetParent(avatar.transform.Find("_Outfit"), false);
                    var crossProxyA = crossA.AddComponent<ModularAvatarBoneProxy>(); crossProxyA.target = crossB.transform;
                    var crossProxyB = crossB.AddComponent<ModularAvatarBoneProxy>(); crossProxyB.target = crossA.transform;
                    Require(OutfitMeasure.AssemblyFailures(avatar, crossA, D("id", "cross_a", "mounts", L()), new List<string>()) == 1
                        && OutfitMeasure.AssemblyFailures(avatar, crossB, D("id", "cross_b", "mounts", L()), new List<string>()) == 1,
                        "cross-outfit proxy cycle was not attributed to both outfit instances");
                    UnityEngine.Object.DestroyImmediate(crossA); UnityEngine.Object.DestroyImmediate(crossB);
                    // MA processes parent-to-child proxies using prepass targets. Replacing each proxy's
                    // original parent with its target yields a legal A->C, B->avatar, C->B chain.
                    var nested = new GameObject("NestedProxyOutfit"); nested.transform.SetParent(avatar.transform.Find("_Outfit"), false);
                    var nestedA = Child(nested, "NestedA"); var nestedB = Child(nestedA, "NestedB"); var nestedC = Child(nested, "NestedC");
                    var nestedProxyA = nestedA.AddComponent<ModularAvatarBoneProxy>(); nestedProxyA.target = nestedC.transform;
                    var nestedProxyB = nestedB.AddComponent<ModularAvatarBoneProxy>(); nestedProxyB.target = avatar.transform;
                    var nestedProxyC = nestedC.AddComponent<ModularAvatarBoneProxy>(); nestedProxyC.target = nestedB.transform;
                    Require(OutfitMeasure.AssemblyFailures(avatar, nested, D("id", "nested_proxy", "mounts", L()), new List<string>()) == 0,
                        "a legal nested proxy reparent order was reported as a cycle");
                    UnityEngine.Object.DestroyImmediate(nested);
                    // Re-run the real assembly path with a body target whose name collides with the
                    // outfit suffix. Only the source prefab root proves that a path belongs to the
                    // outfit; a valid body reference stays absolute and an unrelated path stays broken.
                    var probePlan = D("schema", "plan/0.2", "body_prefab", bodyPath, "body", "base", "default_outfit", "collision",
                        "outfits", L(D("id", "collision", "item", "collision", "kind", "accessory", "prefab", collisionPath, "compatibility", "pending_assembly")));
                    var probeAvatar = OutfitStage.Assemble(original, probePlan, out _, out _);
                    try
                    {
                        var collisionRoot = probeAvatar.transform.Find("_Outfit/Outfit_collision").gameObject;
                        var bodySocket = probeAvatar.transform.Find("BodyRig/Socket");
                        var validBodyProxy = collisionRoot.transform.Find("ValidBody").GetComponent<ModularAvatarBoneProxy>();
                        var invalidBodyProxy = collisionRoot.transform.Find("InvalidBody").GetComponent<ModularAvatarBoneProxy>();
                        Require(validBodyProxy.subPath == "BodyRig/Socket" && OutfitMeasure.ResolveProxy(probeAvatar, validBodyProxy) == bodySocket,
                            "a valid avatar-root target was rewritten to an outfit suffix");
                        Require(invalidBodyProxy.subPath == "NonexistentBody/Socket" && OutfitMeasure.ResolveProxy(probeAvatar, invalidBodyProxy) == null,
                            "an unresolved path sharing an outfit suffix was rewritten");
                        var collisionNotes = new List<string>();
                        Require(OutfitMeasure.AssemblyFailures(probeAvatar, collisionRoot, D("id", "collision", "mounts", L()), collisionNotes) == 1,
                            "an unresolved colliding-suffix path passed compatibility: " + string.Join(";", collisionNotes));
                    }
                    finally { UnityEngine.Object.DestroyImmediate(probeAvatar); }
                    var shared = avatar.transform.Find(second.Str("object"));
                    Require(shared.gameObject.activeSelf && avatar.transform.Find(secondPath) == null && Vector3.Distance(shared.localPosition, new Vector3(.4f, .5f, .6f)) < .00001f && shared.Find("_Local_second_attach") != null, "second member operation failed after save/reload");
                    var renderer = avatar.transform.Find(first.Str("object") + rendererPath.Substring(secondPath.Length)).GetComponent<Renderer>();
                    Require(Vector4.Distance(renderer.sharedMaterial.GetColor("_Color"), new Vector4(.2f, .3f, .4f, 1)) < .00001f, "second member material failed after reload");
                    var plainRow = members.Single(r => r.Str("id") == "recipe_skin"); var plainRoot = avatar.transform.Find(plainRow.Str("object")).gameObject;
                    var generated = plainRoot.GetComponentsInChildren<ModularAvatarMergeArmature>(true).Single();
                    var plainRenderer = plainRoot.GetComponentInChildren<SkinnedMeshRenderer>(true);
                    Require(plainRow.Str("assembly_observation_sha256") == LocalOperations.Digest(text) && generated.mergeTargetObject == avatar.transform.Find("Articulation").gameObject,
                        "merge recipe lost observation identity or actual target after reload");
                    var mapBone = typeof(ModularAvatarMergeArmature).GetMethod("MapBone", BindingFlags.Instance | BindingFlags.NonPublic);
                    Transform Mapped(Transform bone) => mapBone.Invoke(generated, new object[] { bone }) as Transform;
                    var bodyChest = avatar.GetComponent<Animator>().GetBoneTransform(HumanBodyBones.Chest);
                    var usedBone = plainRenderer.bones.Single(b => Mapped(b) == bodyChest);
                    Require(Mapped(usedBone) == bodyChest && OutfitMeasure.AssemblyFailures(avatar, plainRoot, plainRow, new List<string>()) == 0,
                        "no-MA layered skin did not map its actual used bone after reload");
                    // The fixture's other bone shares its name with an avatar bone one level deeper. MergeArmature
                    // maps neither it nor anything below an unmatched level, so it must stay unmapped and must not
                    // be counted as a failure; without this the level rule above could be vacuously satisfied.
                    var tieredBone = plainRenderer.bones.Single(b => b.parent == usedBone);
                    Require(Mapped(tieredBone) == null && OutfitMeasure.AssemblyFailures(avatar, plainRoot, plainRow, new List<string>()) == 0,
                        "a same-named bone at another level was required to map");
                    var probe = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                    try
                    {
                        var prefixRoot = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(prefixPath), probe.transform);
                        var prefixNotes = new List<string>();
                        Require(OutfitMeasure.AssemblyFailures(probe, prefixRoot, D("id", "prefix", "mounts", L()), prefixNotes) == 1
                            && prefixNotes.Any(note => note.Contains("蒙皮骨未按真实层级映射")),
                            "an unmapped bone whose body level does hold its name stopped failing: " + string.Join(";", prefixNotes));
                    }
                    finally { UnityEngine.Object.DestroyImmediate(probe); }
                    Require(LocalOperations.Verify(avatar, original, plan, new List<string>()), "independent reload could not resolve logical second member");
                    shared.localPosition += Vector3.right;
                    Require(!LocalOperations.Verify(avatar, original, plan, new List<string>()), "tampered shared second member passed verification");
                    shared.localPosition = new Vector3(.4f, .5f, .6f);
                    var row = record.List("outfits").Cast<Dictionary<string, object>>().Single(r => r.Str("id") == "split");
                    var root = avatar.transform.Find(row.Str("object")).gameObject;
                    root.SetActive(false);
                    root.transform.Find("WingA").position += Vector3.right;
                    Require(OutfitMeasure.AssemblyFailures(avatar, root, row, new List<string>()) > 0, "default-off wrong pose passed actual compatibility");
                    Require(!LocalOperations.Verify(avatar, original, plan, new List<string>()), "changed rigid pose passed independent reload");
                    root.tag = "EditorOnly";
                    Require(OutfitMeasure.UnmetObligations(avatar, record, plan).Any(o => o.Str("input") == "rigid"), "excluded installation falsely discharged use");
                    var skinRow = record.List("outfits").Cast<Dictionary<string, object>>().Single(r => r.Str("id") == "merged");
                    var skin = avatar.transform.Find(skinRow.Str("object")).gameObject;
                    skin.transform.Find("SourceRig/JointZ").name = "UnmappedDifferentSkeleton";
                    Require(OutfitMeasure.AssemblyFailures(avatar, skin, skinRow, new List<string>()) > 0, "unmappable skin passed component-only checking");
                    PrefabUtility.SaveAsPrefabAsset(avatar, OutfitStage.AvatarPath);
                }
                finally { UnityEngine.Object.DestroyImmediate(avatar); }
                OutfitMeasure.Write(OutfitStage.AvatarPath, OutfitStage.RecordPath);
                Require(Convert.ToInt32(Metric()["assembly_compatibility_failures"]) > 0, "production observer accepted failed installation");
                OutfitStage.Produce();
                Require(Convert.ToInt32(Metric()["assembly_compatibility_failures"]) == 0, "technical rework did not restore valid assembly");
                foreach (var operation in new[] { move, state, tint })
                {
                    var duplicate = new Dictionary<string, object>(operation); duplicate["id"] = "duplicate_" + operation.Str("kind");
                    duplicate["path"] = operation.Str("path").Replace(secondPath, "_Outfit/Outfit_model");
                    input.List("operations").Add(duplicate); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                    Refuses(OutfitStage.Produce, "shared physical target accepted duplicate " + operation.Str("kind"), "重复"); input.List("operations").Remove(duplicate);
                }
                input["observation_sha256"] = new string('0', 64); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(OutfitStage.Produce, "stale observation accepted for assembly");
                input["observation_sha256"] = LocalOperations.Digest(text);
                ((Dictionary<string, object>)mounts[1])["source"] = "WingA"; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(OutfitStage.Produce, "duplicate multi-mount source accepted");
                ((Dictionary<string, object>)mounts[1])["source"] = "WingB";
                ((Dictionary<string, object>)mounts[1])["path"] = "InventedSocket"; Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(OutfitStage.Produce, "unobserved mount accepted");
                ((Dictionary<string, object>)mounts[1])["path"] = "SocketRight";
                op["mode"] = "merge"; op.Remove("mounts"); Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), input);
                Refuses(OutfitStage.Produce, "rigid source accepted as a skinned merge");
                result["ok"] = true;
            }
            catch (Exception error) { result["error"] = error.ToString(); }
            result["assertions"] = assertions;
            File.WriteAllText(Avh.Abs("result.json"), Avh.Json(result));
            EditorApplication.Exit(0);
        }
    }
}
