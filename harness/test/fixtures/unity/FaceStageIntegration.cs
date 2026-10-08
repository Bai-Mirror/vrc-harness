// Actual imported FBX fixtures; the production FaceStage performs every check.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
#if AVH_FULL_FACE_IT
using VRC.SDK3.Avatars.Components;
using nadena.dev.modular_avatar.core;
#endif
namespace AVH.Harness
{
    public static class FaceStageIntegration
    {
        public static void RemovedInfinityRun() {
            try {
                var flags = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static;
                var source = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Source/avatar.prefab");
                var facts = typeof(FaceStage).GetMethod("Hierarchy", flags).Invoke(null, new object[] { source });
                try { typeof(FaceStage).GetMethod("Close", flags).Invoke(null, new object[] { facts, facts, "Unchanged authored infinity" }); }
                catch (System.Reflection.TargetInvocationException e) {
                    if (e.InnerException.Message.Contains("Non-finite numeric input")) {
                        Avh.WriteJson(Avh.Abs("infinity-removal.json"), new Dictionary<string,object>{{"oldConsumerRejectedUnchangedSource",true}}); EditorApplication.Exit(0); return;
                    }
                    throw;
                }
                throw new Exception("Removing authored infinity measurement did not reject unchanged source");
            } catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
        }
        public static void RemovedGradientRun() {
            try {
                var source = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Source/avatar.prefab");
                try { typeof(FaceStage).GetMethod("Hierarchy", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static).Invoke(null, new object[] { source }); }
                catch (System.Reflection.TargetInvocationException e) {
                    if (e.InnerException.Message.Contains("Unmeasured serialized prefab property") && e.InnerException.Message.Contains("Gradient")) {
                        Avh.WriteJson(Avh.Abs("gradient-removal.json"), new Dictionary<string,object>{{"oldConsumerRejectedUnchangedSource",true}}); EditorApplication.Exit(0); return;
                    }
                    throw;
                }
                throw new Exception("Removing gradient measurement did not reject the unchanged real particle prefab");
            } catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
        }
        static int assertions;
        static void Require(bool ok, string message) { if (!ok) throw new Exception(message); assertions++; }
        static void Refuses(Action body, string message, string reason = null) { try { body(); } catch (Exception e) { if (reason != null && !e.Message.Contains(reason)) throw new Exception("Refused for the wrong reason: " + e.Message); assertions++; return; } throw new Exception(message); }
        static void Import(string path)
        { AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport); var importer = (ModelImporter)AssetImporter.GetAtPath(path); importer.isReadable = false; importer.importAnimation = false; importer.meshCompression = ModelImporterMeshCompression.Off; importer.optimizeMeshVertices = false; importer.optimizeMeshPolygons = false; importer.SaveAndReimport(); }
        static void WriteInput(Dictionary<string, object> input) => Avh.WriteJson(Avh.Abs(FaceStage.InputPath), input);
        static void CornerChecks()
        {
            var source=new Mesh();source.vertices=new[]{new Vector3(0,0,0),new Vector3(1,0,0),new Vector3(1,1,0),new Vector3(0,1,0)};source.triangles=new[]{0,1,2,0,2,3};source.normals=Enumerable.Repeat(Vector3.forward,4).ToArray();source.uv=new[]{Vector2.zero,Vector2.right,Vector2.one,Vector2.up};
            source.bindposes=new[]{Matrix4x4.identity};source.boneWeights=Enumerable.Repeat(new BoneWeight{boneIndex0=0,weight0=1},4).ToArray();
            var expected=new Dictionary<string,Vector3[]>{{"ObservedRuntime",Enumerable.Repeat(new Vector3(0,0,.1f),4).ToArray()}};source.AddBlendShapeFrame("ObservedRuntime",100,expected["ObservedRuntime"],null,null);
            var actual=new Mesh();var order=new[]{2,3,0,1,2,0};actual.vertices=order.Select(i=>source.vertices[i]).ToArray();actual.triangles=new[]{5,3,4,2,0,1};actual.normals=Enumerable.Repeat(Vector3.forward,6).ToArray();actual.uv=order.Select(i=>source.uv[i]).ToArray();actual.AddBlendShapeFrame("ObservedRuntime",100,order.Select(i=>expected["ObservedRuntime"][i]).ToArray(),null,null);
            actual.bindposes=new[]{Matrix4x4.identity};actual.boneWeights=Enumerable.Repeat(new BoneWeight{boneIndex0=0,weight0=1},6).ToArray();
            var mapped=FaceMapping.ExpandCandidate(source,actual,source.vertices,expected,1e-6f);Require(mapped.vertexCount==4&&mapped.triangles.SequenceEqual(source.triangles)&&mapped.uv.SequenceEqual(source.uv),"Real Unity split/reordered corners did not produce the source layout");UnityEngine.Object.DestroyImmediate(mapped);
            var uv=actual.uv;var originalUV=(Vector2[])uv.Clone();uv[0]+=Vector2.one*.01f;actual.uv=uv;Refuses(()=>FaceMapping.ExpandCandidate(source,actual,source.vertices,expected,1e-6f),"Wrong actual UV seam accepted","corresponding source face");actual.uv=originalUV;
            var triangles=actual.triangles;actual.triangles=new[]{5,4,3,2,0,1};Refuses(()=>FaceMapping.ExpandCandidate(source,actual,source.vertices,expected,1e-6f),"Flipped actual corner winding accepted","corresponding source face");actual.triangles=triangles;
            var normals=actual.normals;normals[0]=Vector3.right;actual.normals=normals;Refuses(()=>FaceMapping.ExpandCandidate(source,actual,source.vertices,expected,1e-6f),"Incompatible split normal was merged","normal/tangent seam");actual.normals=Enumerable.Repeat(Vector3.forward,6).ToArray();
            actual.ClearBlendShapes();actual.AddBlendShapeFrame("ObservedRuntime",100,new Vector3[6],null,null);Refuses(()=>FaceMapping.ExpandCandidate(source,actual,source.vertices,expected,1e-6f),"Wrong actual runtime endpoint accepted","corresponding source face");
            UnityEngine.Object.DestroyImmediate(source);UnityEngine.Object.DestroyImmediate(actual);
        }
        static void BinaryFrameChecks()
        {
            var mesh=new Mesh();mesh.vertices=new Vector3[1001];var delta=Enumerable.Repeat(new Vector3(.01f,.02f,.03f),1001).ToArray();for(var i=0;i<201;i++)mesh.AddBlendShapeFrame("FrozenFrame"+i,100,delta,null,null);
            var facts=FaceMapping.Frames(mesh);var frame=((Dictionary<string,object>)facts[0]).List("frames").Cast<Dictionary<string,object>>().Single();var reference=frame.Obj("vertices");Require(reference.Str("encoding")=="float32-le"&&Convert.ToInt32(reference["count"])==1001&&FaceStage.FileHash(reference.Str("file"))==frame.Str("verticesSha256"),"Large actual Unity frames did not produce frozen float32 evidence");
            var bytes=File.ReadAllBytes(Avh.Abs(reference.Str("file")));var changed=(byte[])bytes.Clone();changed[0]^=1;File.WriteAllBytes(Avh.Abs(reference.Str("file")),changed);Refuses(()=>FaceMapping.Frames(mesh),"Changed immutable binary frame was overwritten or accepted","binary changed");File.WriteAllBytes(Avh.Abs(reference.Str("file")),bytes);UnityEngine.Object.DestroyImmediate(mesh);
            Directory.CreateDirectory(Avh.Abs("Assets/_Harness/Face"));var binary="Assets/_Harness/Face/readback-test.bin";File.WriteAllBytes(Avh.Abs(binary),bytes);var blenderReference=new Dictionary<string,object>{["file"]=binary,["sha256"]=FaceStage.FileHash(binary),["encoding"]="float32-le",["count"]=1001};Require(FaceMapping.ReadVectors(blenderReference).SequenceEqual(delta),"Actual Blender-compatible binary reader changed coordinates");File.WriteAllBytes(Avh.Abs(binary),changed);Refuses(()=>FaceMapping.ReadVectors(blenderReference),"Changed Blender private coordinates accepted","binary facts changed");
        }
        static void TransferChecks()
        {
            var recipe = Avh.ParseJson("{\"schema\":\"face-compensation/0.1\",\"method\":\"idw-endpoint-transfer\",\"version\":\"1\",\"neighbors\":2,\"power\":1,\"pointToleranceMeters\":1e-8,\"halfErrorToleranceMeters\":1e-5,\"quality\":{\"minimumTriangleAreaMetersSquared\":1e-12,\"minAreaRatio\":0.05,\"maxAreaRatio\":20,\"minEdgeRatio\":0.2,\"maxEdgeRatio\":5,\"minNormalDot\":0,\"maxDihedralIncreaseDegrees\":25}}") as Dictionary<string, object>;
            var p = new[] { new Vector3(-.03f,0,-.003f), new Vector3(-.03f,0,.003f), new Vector3(0,0,.003f), new Vector3(0,0,-.003f), new Vector3(.03f,0,.003f), new Vector3(.03f,0,-.003f) };
            var q = p.Select(v => v + new Vector3(0,0,v.z > 0 ? .001f : -.001f)).ToArray(); var delta = new Vector3[p.Length]; delta[0].z = .003f; delta[1].z = -.003f;
            var changed = FaceGeometry.Compensate(p,q,delta,Matrix4x4.identity,recipe,out var half);
            Require(Math.Abs(changed[0].z - .004f) < .000001f && Math.Abs(changed[1].z + .004f) < .000001f, "IDW endpoint transfer did not compensate closed-eye endpoints for a changed basis");
            Require(half <= .00001, "Independent half-state transfer check failed");
            var triangles = new[] { 0,1,2,0,2,3,3,2,4,3,4,5 }; var quality = recipe.Obj("quality");
            Require(Equals(FaceGeometry.Quality(p,q,triangles,quality)["passed"], true), "Ordinary changed geometry failed source-relative quality");
            var closed = p.Select((v,i)=>v+delta[i]).ToArray(); var compensated = q.Select((v,i)=>v+changed[i]).ToArray(); var reading = FaceGeometry.Quality(closed,compensated,triangles,quality);
            Require(Equals(reading["passed"], true) && Convert.ToInt32(reading["baselineDegenerateTriangles"]) > 0, "Existing closed-state degeneracy was mislabeled a new defect");
            var collapse = new Vector3[p.Length]; Require(!Equals(FaceGeometry.Quality(p,collapse,triangles,quality)["passed"], true), "New broken/collapsed geometry passed");
            var flip = p.Select(v=>new Vector3(-v.x,v.y,v.z)).ToArray(); Require(Convert.ToInt32(FaceGeometry.Quality(p,flip,triangles,quality)["flippedTriangles"]) > 0, "Flipped surface passed");
            var crease = p.ToArray(); crease[2].y = .02f; Require(Convert.ToInt32(FaceGeometry.Quality(p,crease,triangles,quality)["dihedralFailures"]) > 0, "New crease was not measured");
            var duplicate = p.ToArray(); duplicate[1] = duplicate[0]; Refuses(() => new FaceGeometry.Transfer(duplicate,q,recipe), "Contradictory coincident controls passed", "contradictory");
        }
        public static void Run()
        {
            try
            {
                TransferChecks();
                CornerChecks();
                BinaryFrameChecks();
                Mesh sourceMesh;
                if (Environment.GetEnvironmentVariable("AVH_FACE_REUSE_SETUP") == "1") sourceMesh = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Source/avatar.prefab").GetComponentsInChildren<SkinnedMeshRenderer>(true).Single().sharedMesh;
                else
                {
                Import("Assets/Source/source.fbx"); Import("Assets/_Harness/Face/Candidates/revision-1/candidate.fbx");
                var model = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Source/source.fbx"); var avatar = (GameObject)PrefabUtility.InstantiatePrefab(model); avatar.name = "FixtureAvatar";
                var face = avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true).Single(); sourceMesh = face.sharedMesh; face.SetBlendShapeWeight(sourceMesh.GetBlendShapeIndex("RuntimeA"), 25);
                var particleObject = new GameObject("UnchangedParticles"); particleObject.transform.SetParent(avatar.transform, false);
                particleObject.AddComponent<FixedJoint>();
                var particle = particleObject.AddComponent<ParticleSystem>(); var particleMain = particle.main;
                var gradient = new Gradient { mode = GradientMode.Fixed, colorSpace = ColorSpace.Linear };
                gradient.SetKeys(new[] { new GradientColorKey(new Color(2, .3f, .4f, .8f), .2f), new GradientColorKey(Color.blue, .9f) }, new[] { new GradientAlphaKey(.2f, .1f), new GradientAlphaKey(.8f, .9f) });
                particleMain.startColor = new ParticleSystem.MinMaxGradient(gradient);
                var clip = new AnimationClip(); var facePath = AnimationUtility.CalculateTransformPath(face.transform, avatar.transform);
                AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve(facePath, typeof(SkinnedMeshRenderer), "blendShape.RuntimeA"), AnimationCurve.Linear(0, 0, 1, 100));
                AssetDatabase.CreateAsset(clip, "Assets/Source/runtime.anim"); var controller = AnimatorController.CreateAnimatorControllerAtPath("Assets/Source/runtime.controller"); controller.AddMotion(clip);
                controller.AddParameter("AvatarTouch",AnimatorControllerParameterType.Bool);
                var animator = avatar.GetComponent<Animator>(); if (animator == null) animator = avatar.AddComponent<Animator>(); animator.runtimeAnimatorController = controller;
#if AVH_FULL_FACE_IT
                var descriptor = avatar.AddComponent<VRCAvatarDescriptor>(); descriptor.VisemeSkinnedMesh = face; descriptor.VisemeBlendShapes = new[] { "RuntimeB" };
                descriptor.MouthOpenBlendShapeName = "RuntimeA";
                descriptor.enableEyeLook=true;descriptor.customEyeLookSettings.eyelidType=VRCAvatarDescriptor.EyelidType.Blendshapes;
                descriptor.customEyeLookSettings.eyelidsSkinnedMesh = face; descriptor.customEyeLookSettings.eyelidsBlendshapes = new[] { sourceMesh.GetBlendShapeIndex("RuntimeB"),-1,-1 };
                var leftEye=new GameObject("ObservedLeftEye").transform;leftEye.SetParent(avatar.transform,false);leftEye.position=new Vector3(-.03f,0,0);
                var rightEye=new GameObject("ObservedRightEye").transform;rightEye.SetParent(avatar.transform,false);rightEye.position=new Vector3(.03f,0,0);
                descriptor.customEyeLookSettings.leftEye=leftEye;descriptor.customEyeLookSettings.rightEye=rightEye;
                var changer = avatar.AddComponent<ModularAvatarShapeChanger>(); changer.Shapes.Add(new ChangedShape { Object = new AvatarObjectReference { referencePath = facePath }, ShapeName = "RuntimeB", Value = 25, ChangeType = ShapeChangeType.Set });
                avatar.AddComponent<ModularAvatarConvertConstraints>();
                foreach(var typeName in new[]{"VRC.SDK3.Dynamics.Contact.Components.VRCContactReceiver","VRC.SDK3.Dynamics.Contact.Components.VRCContactSender","VRC.SDK3.Avatars.Components.VRCRaycast","VRC.SDK3.Avatars.Components.VRCHeadChop","VRC.SDK3.Dynamics.Constraint.Components.VRCParentConstraint","VRC.SDK3.Dynamics.Constraint.Components.VRCRotationConstraint"})
                {
                    var componentType=AppDomain.CurrentDomain.GetAssemblies().Select(a=>a.GetType(typeName)).FirstOrDefault(t=>t!=null);if(componentType==null)throw new Exception("Actual installed SDK fixture lacks "+typeName);var component=avatar.AddComponent(componentType);
                    var field=componentType.GetField("parameter");if(field!=null)field.SetValue(component,"AvatarTouch");
                }
#endif
                // Real FBX transforms contain small floats whose float/double
                // JSON round-trip notation differs; the formal Apply must still
                // accept unchanged source facts and reject actual source drift.
                avatar.transform.position = new Vector3(.00001f, 0, 0);
                PrefabUtility.SaveAsPrefabAsset(avatar, "Assets/Source/avatar.prefab"); UnityEngine.Object.DestroyImmediate(avatar); AssetDatabase.SaveAssets();
                }
                if (Environment.GetEnvironmentVariable("AVH_FACE_SEED_SETUP") == "1")
                {
                    Avh.WriteJson(Avh.Abs("_harness/intake/inventory.json"), Avh.ParseJson("{\"body_key\":\"fixture\",\"items\":[{\"item\":\"Fixture\",\"role\":\"body\"}]}"));
                    Avh.WriteJson(Avh.Abs("_harness/setup/import.json"), Avh.ParseJson("{\"packages\":[{\"item\":\"Fixture\",\"roots\":[\"Assets/Source\"]}]}"));
                    Avh.WriteJson(Avh.Abs("setup-seed.json"),new Dictionary<string,object> { ["sourceReadable"] = sourceMesh.isReadable,["sourceBytes"] = FaceStage.FileHash("Assets/Source/source.fbx") });EditorApplication.Exit(0);return;
                }
                var preparePlan = new Dictionary<string,object> { ["body_prefab"]="Assets/Source/avatar.prefab",["face"]=new Dictionary<string,object> { ["mode"]="preserve" } };
                var originalReadable=((ModelImporter)AssetImporter.GetAtPath("Assets/Source/source.fbx")).isReadable;FaceStage.PrepareReadableSource(preparePlan); Require(((ModelImporter)AssetImporter.GetAtPath("Assets/Source/source.fbx")).isReadable==originalReadable,"Preserve changed the source importer unnecessarily");
#if AVH_FULL_FACE_IT
                if(Environment.GetEnvironmentVariable("AVH_FACE_REUSE_SETUP")=="1")
                {
                    var seed=Avh.ReadJsonFile(Avh.Abs("setup-seed.json")); Require(Equals(seed["sourceReadable"],false) && sourceMesh.isReadable && File.Exists(Avh.Abs("_harness/setup/baseline.json")),"Formal SetupStage did not prepare the unreadable source before observation");
                    var objects=Avh.ReadJsonFile(Avh.Abs(LocalOperations.ObservationPath)); var path="Assets/Source/source.fbx";var guard=LocalOperations.Digest(AssetDatabase.GetAssetDependencyHash(path)+":"+FaceStage.FileHash(path)+":"+FaceStage.FileHash(path+".meta"));Require(objects.Obj("asset_hashes").Str(path)==guard,"Formal setup object observation did not freeze the prepared source metadata");
                }
#endif
                preparePlan.Obj("face")["mode"]="design";var sourceBytes=FaceStage.FileHash("Assets/Source/source.fbx");FaceStage.PrepareReadableSource(preparePlan);sourceMesh=AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Source/avatar.prefab").GetComponentsInChildren<SkinnedMeshRenderer>(true).Single().sharedMesh;
                Require(sourceMesh.isReadable && sourceBytes==FaceStage.FileHash("Assets/Source/source.fbx"),"Managed preparation failed or changed source model bytes");
                Require(sourceMesh.blendShapeCount == 3 && sourceMesh.subMeshCount == 2 && sourceMesh.boneWeights.Length > 0 && sourceMesh.uv.Length > 0, "Source fixture did not import its keys/UV/material/bones");
                var observation = FaceStage.ObserveSource("Assets/Source/avatar.prefab"); Avh.WriteJson(Avh.Abs(FaceStage.ObservationPath), observation);
                var target = observation.List("targets").Cast<Dictionary<string, object>>().Single(); var writers = target.List("writers").Cast<Dictionary<string, object>>().ToArray();
                Require(writers.Any(w => w.Str("kind") == "animation" && w.Str("key") == "RuntimeA"), "Actual controller writer not observed");
#if AVH_FULL_FACE_IT
                Require(writers.Any(w => w.Str("kind") == "descriptor-viseme" && w.Str("key") == "RuntimeB"), "Descriptor viseme not observed");
                Require(writers.Any(w => w.Str("kind") == "descriptor-eyelid-index" && w.Str("key") == "RuntimeB"), "Descriptor eyelid not observed");
                Require(writers.Any(w => w.Str("kind") == "descriptor-jaw-flap" && w.Str("key") == "RuntimeA"), "Descriptor jaw flap not observed");
                Require(writers.Any(w => w.Str("kind") == "modular-avatar-shape" && w.Str("key") == "RuntimeB"), "MA shape writer not observed");
                Require(target.Obj("eyeObservation").Str("status")=="source_controls_verified","Actual SDK Blink source controls were not observed: "+Avh.Json(target.Obj("eyeObservation")));
                Require(target.Obj("eyeObservation").List("regions").Count==2,"Both actual eye regions were not frozen");
                var roles=target.List("componentRoles").Cast<Dictionary<string,object>>().ToArray();Require(roles.Select(r=>r.Str("role")).Distinct().Count()==7,"Actual SDK/MA component provenance/behaviour was not classified: "+Avh.Json(target["unmeasuredWriters"]));
                var contact=roles.Single(r=>r.Str("role")=="contact-animator-parameter");Require(contact.List("controllerLinks").Cast<Dictionary<string,object>>().Any(l=>((System.Collections.IEnumerable)l["protectedKeys"]).Cast<object>().Contains("RuntimeA")),"Contact parameter failed to retain actual controller blend binding protection");
#endif
                var catalog = Avh.ReadJsonFile(Avh.Abs("Assets/_Harness/Face/catalog.json")); var keys = catalog.List("meshes").Cast<Dictionary<string, object>>().Single().List("keys").Cast<Dictionary<string, object>>().Skip(1).ToArray();
                // Exercise the source identity comparison through the complete
                // frozen Prepare -> Apply -> independent VerifyOutput path.
                if (Application.platform == RuntimePlatform.WindowsEditor)
                {
                    catalog.Obj("source")["path"] = catalog.Obj("source").Str("path").ToUpperInvariant();
                    Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/catalog.json"), catalog);
                }
                var map = keys.ToDictionary(k => k.Str("name"), k => (object)k.Str("id"));
                var input = new Dictionary<string, object> { ["schema"] = "face-unity-design/0.1", ["observationSha256"] = FaceStage.FileHash(FaceStage.ObservationPath), ["targetId"] = target.Str("targetId"), ["keyMap"] = map };
                foreach (var pair in new[] { new[] { "blenderCatalog", "Assets/_Harness/Face/catalog.json" }, new[] { "blenderDesign", "Assets/_Harness/Face/blender-design.json" }, new[] { "candidateReceipt", "Assets/_Harness/Face/Candidates/revision-1/candidate.json" } })
                    input[pair[0]] = new Dictionary<string, object> { ["file"] = pair[1], ["sha256"] = FaceStage.FileHash(pair[1]) };
                input["sourceMapping"]=new Dictionary<string,object>{["file"]="Assets/_Harness/Face/source-mapping.json",["sha256"]=FaceStage.FileHash("Assets/_Harness/Face/source-mapping.json")};
                WriteInput(input); var rawSource = FaceStage.FileHash("Assets/Source/source.fbx");
                var mapping=Avh.ReadJsonFile(Avh.Abs("Assets/_Harness/Face/source-mapping.json"));var originalMapping=File.ReadAllBytes(Avh.Abs("Assets/_Harness/Face/source-mapping.json"));mapping["observationSha256"]=new string('0',64);Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/source-mapping.json"),mapping);input.Obj("sourceMapping")["sha256"]=FaceStage.FileHash("Assets/_Harness/Face/source-mapping.json");WriteInput(input);
                Refuses(()=>FaceStage.ApplyManaged(),"Rehashed mapping to a different source observation accepted","another observed source");File.WriteAllBytes(Avh.Abs("Assets/_Harness/Face/source-mapping.json"),originalMapping);input.Obj("sourceMapping")["sha256"]=FaceStage.FileHash("Assets/_Harness/Face/source-mapping.json");WriteInput(input);
                var output = FaceStage.ApplyManaged(); var notes = new List<string>(); Require(FaceStage.VerifyOutput(output, notes), "Independent positive readback failed: " + string.Join(";", notes));
                var final = AssetDatabase.LoadAssetAtPath<GameObject>(output); var finalFace = final.GetComponentsInChildren<SkinnedMeshRenderer>(true).Single();
                // Real output reload must preserve every gradient fact; these changes
                // are unrelated to the authorized face mesh replacement.
                var edited = (GameObject)PrefabUtility.InstantiatePrefab(final);
                try {
                    var particles = edited.GetComponentInChildren<ParticleSystem>(true); var main = particles.main; var original = main.startColor;
                    Action<Action<Gradient>> rejectsGradient = change => {
                        var changed = new Gradient { mode = original.gradient.mode, colorSpace = original.gradient.colorSpace };
                        changed.SetKeys(original.gradient.colorKeys, original.gradient.alphaKeys); change(changed);
                        main.startColor = new ParticleSystem.MinMaxGradient(changed); PrefabUtility.SaveAsPrefabAsset(edited, output); AssetDatabase.SaveAssets();
                        var reasons = new List<string>(); Require(!FaceStage.VerifyOutput(output, reasons) && reasons.Any(n => n.Contains("Unauthorised prefab override")), "Changed particle gradient passed actual output readback");
                        main.startColor = original; PrefabUtility.SaveAsPrefabAsset(edited, output); AssetDatabase.SaveAssets();
                    };
                    rejectsGradient(g => { var keys = g.colorKeys; keys[0].color.r += .1f; g.colorKeys = keys; });
                    rejectsGradient(g => { var keys = g.colorKeys; keys[0].time += .05f; g.colorKeys = keys; });
                    rejectsGradient(g => { var keys = g.alphaKeys; keys[0].alpha += .1f; g.alphaKeys = keys; });
                    rejectsGradient(g => { var keys = g.alphaKeys; keys[0].time += .05f; g.alphaKeys = keys; });
                    rejectsGradient(g => g.mode = GradientMode.Blend);
                    rejectsGradient(g => g.colorSpace = ColorSpace.Gamma);
                } finally { UnityEngine.Object.DestroyImmediate(edited); }
                Require(FaceStage.VerifyOutput(output, new List<string>()), "Restored particle gradient failed actual output readback");
                var limits = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(output));
                try {
                    var setting = limits.GetComponentInChildren<FixedJoint>(true);
                    foreach (var altered in new[] { float.NegativeInfinity, float.MaxValue, float.NaN }) {
                        setting.breakForce = altered; PrefabUtility.SaveAsPrefabAsset(limits, output); AssetDatabase.SaveAssets();
                        Require(!FaceStage.VerifyOutput(output, new List<string>()), "Changed infinity sign, finite bound or NaN passed actual output readback");
                    }
                    setting.breakForce = float.PositiveInfinity; PrefabUtility.SaveAsPrefabAsset(limits, output); AssetDatabase.SaveAssets();
                    Require(FaceStage.VerifyOutput(output, new List<string>()), "Restored authored infinity failed actual output readback");
                } finally { UnityEngine.Object.DestroyImmediate(limits); }
                Require(finalFace.sharedMesh.blendShapeCount == 2 && finalFace.sharedMesh.GetBlendShapeIndex("RuntimeA") >= 0 && finalFace.sharedMesh.GetBlendShapeIndex("RuntimeB") >= 0, "Runtime key retention failed");
                Require(Math.Abs(finalFace.GetBlendShapeWeight(finalFace.sharedMesh.GetBlendShapeIndex("RuntimeA")) - 25) < .001, "Unity prefab default was incorrectly replaced by FBX zero default");
                Require(rawSource == FaceStage.FileHash("Assets/Source/source.fbx"), "Source FBX mutated");
                Require(FaceStage.ValidatedOutput("Assets/Source/avatar.prefab") == output, "Downstream did not consume independently validated face output");
                Require(((ModelImporter)AssetImporter.GetAtPath("Assets/_Harness/Face/Candidates/revision-1/candidate.fbx")).isReadable, "Apply did not prepare its new candidate importer");
                var record = Avh.ReadJsonFile(Avh.Abs(FaceStage.RecordPath)); record["inputSha256"] = new string('0', 64); Avh.WriteJson(Avh.Abs(FaceStage.RecordPath), record);
                Refuses(() => FaceStage.ValidatedOutput("Assets/Source/avatar.prefab"), "Changed face record binding passed"); record["inputSha256"] = FaceStage.FileHash(FaceStage.InputPath); Avh.WriteJson(Avh.Abs(FaceStage.RecordPath), record);
                var candidateMeta=Avh.Abs("Assets/_Harness/Face/Candidates/revision-1/candidate.fbx.meta");var meta=File.ReadAllBytes(candidateMeta);File.AppendAllText(candidateMeta,"\n# independent metadata drift fixture\n");Refuses(()=>FaceStage.ValidatedOutput("Assets/Source/avatar.prefab"),"Candidate import metadata drift passed","metadata changed");File.WriteAllBytes(candidateMeta,meta);
#if AVH_FULL_FACE_IT
                Require(final.GetComponent<VRCAvatarDescriptor>().customEyeLookSettings.eyelidsBlendshapes[0] == finalFace.sharedMesh.GetBlendShapeIndex("RuntimeB"), "Numeric eyelid binding did not follow preserved key identity");
#endif
                FaceStage.WriteMeasurement(); var metrics = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations/face.apply.json")).Obj("metrics");
                Require(Equals(metrics["face_geometry_valid"], true) && Equals(metrics["face_fully_qualified"], false), "Numeric qualification falsely implied visual acceptance");
#if AVH_FULL_FACE_IT
                Require(Equals(metrics["face_eye_region_valid"],true),"Independent SDK eye contact readback failed: "+Avh.Json(Avh.ReadJsonFile(Avh.Abs("_harness/face/eyes.json"))));
                var sourceAvatar=AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Source/avatar.prefab");var eyeSource=(GameObject)PrefabUtility.InstantiatePrefab(sourceAvatar);var eyeCandidate=(GameObject)PrefabUtility.InstantiatePrefab(final);
                try
                {
                    var eyeRenderer=eyeSource.GetComponentsInChildren<SkinnedMeshRenderer>(true).Single();var eyeActual=eyeCandidate.GetComponentsInChildren<SkinnedMeshRenderer>(true).Single();var eyeDescriptor=eyeSource.GetComponent<VRCAvatarDescriptor>();var blink=eyeDescriptor.customEyeLookSettings.eyelidsBlendshapes[0];
                    Require(FaceEyes.Verify(eyeSource,eyeRenderer,eyeCandidate,eyeActual,target.Str("meshSha256")).Str("status")=="technical_controls_passed","Independent eye positive failed");
                    eyeDescriptor.customEyeLookSettings.eyelidsBlendshapes[0]=eyeRenderer.sharedMesh.GetBlendShapeIndex("RuntimeA");
                    Require(FaceEyes.Observe(eyeSource,eyeRenderer,target.Str("meshSha256")).Str("status")=="unsupported","One-sided source closed control falsely measured both eyes");eyeDescriptor.customEyeLookSettings.eyelidsBlendshapes[0]=blink;
                    var center=eyeDescriptor.customEyeLookSettings.rightEye;eyeDescriptor.customEyeLookSettings.rightEye=null;
                    Require(FaceEyes.Observe(eyeSource,eyeRenderer,target.Str("meshSha256")).Str("status")=="unsupported","Missing actual center silently guessed an eye region");eyeDescriptor.customEyeLookSettings.rightEye=center;
                    var candidateDescriptor=eyeCandidate.GetComponent<VRCAvatarDescriptor>();var candidateBlink=candidateDescriptor.customEyeLookSettings.eyelidsBlendshapes[0];candidateDescriptor.customEyeLookSettings.eyelidsBlendshapes[0]=eyeActual.sharedMesh.GetBlendShapeIndex("RuntimeA");
                    Require(FaceEyes.Verify(eyeSource,eyeRenderer,eyeCandidate,eyeActual,target.Str("meshSha256")).Str("status")=="failed","Wrong actual SDK Blink binding falsely passed geometry-only proof");candidateDescriptor.customEyeLookSettings.eyelidsBlendshapes[0]=candidateBlink;
                    var collapsed=UnityEngine.Object.Instantiate(eyeActual.sharedMesh);var originalMesh=eyeActual.sharedMesh;var closeDelta=new Vector3[collapsed.vertexCount];var scratchClose=new Vector3[collapsed.vertexCount];collapsed.GetBlendShapeFrameVertices(candidateBlink,0,closeDelta,scratchClose,scratchClose);collapsed.vertices=collapsed.vertices.Select((v,i)=>v+closeDelta[i]).ToArray();eyeActual.sharedMesh=collapsed;
                    Require(FaceEyes.Verify(eyeSource,eyeRenderer,eyeCandidate,eyeActual,target.Str("meshSha256")).Str("status")=="failed","Closed-only target bypassed the independent open negative control");eyeActual.sharedMesh=originalMesh;UnityEngine.Object.DestroyImmediate(collapsed);
                    var altered=UnityEngine.Object.Instantiate(eyeActual.sharedMesh);var saved=eyeActual.sharedMesh;altered.ClearBlendShapes();var zeros=new Vector3[altered.vertexCount];
                    for(var i=0;i<saved.blendShapeCount;i++)altered.AddBlendShapeFrame(saved.GetBlendShapeName(i),100,zeros,null,null);eyeActual.sharedMesh=altered;
                    Require(FaceEyes.Verify(eyeSource,eyeRenderer,eyeCandidate,eyeActual,target.Str("meshSha256")).Str("status")=="failed","Missing real closed deformation falsely passed frozen source contacts");eyeActual.sharedMesh=saved;UnityEngine.Object.DestroyImmediate(altered);
                    Require(Math.Abs(eyeRenderer.GetBlendShapeWeight(eyeRenderer.sharedMesh.GetBlendShapeIndex("RuntimeA"))-25)<.001,"Eye probe mutated original runtime defaults");
                }
                finally{UnityEngine.Object.DestroyImmediate(eyeSource);UnityEngine.Object.DestroyImmediate(eyeCandidate);}
#else
                Require(metrics["face_eye_region_valid"]==null,"Source without actual eye bindings falsely qualified");
#endif
                Require(Equals(metrics["face_expression_compensation_valid"], true) && Equals(metrics["face_damage_smoothness_valid"], true), "Real compensated FBX was not independently verified");
                Require(Equals(metrics["face_head_attachments_measured"],true),"Baked design must reach the actual head attachment readback");
                var originalDelta = new Vector3[sourceMesh.vertexCount]; var changedDelta = new Vector3[sourceMesh.vertexCount]; var scratch = new Vector3[sourceMesh.vertexCount]; sourceMesh.GetBlendShapeFrameVertices(sourceMesh.GetBlendShapeIndex("RuntimeA"), 0, originalDelta, scratch, scratch); finalFace.sharedMesh.GetBlendShapeFrameVertices(finalFace.sharedMesh.GetBlendShapeIndex("RuntimeA"), 0, changedDelta, scratch, scratch);
                var sourceRenderer = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Source/avatar.prefab").GetComponentsInChildren<SkinnedMeshRenderer>(true).Single();
                Require(originalDelta.Where((v,i)=>sourceRenderer.transform.localToWorldMatrix.MultiplyVector(v-changedDelta[i]).magnitude > .0001).Any(), "FBX claimed compensation while merely preserving the old runtime delta");
#if AVH_FULL_FACE_IT
                OutfitStage.EnsureFolder(OutfitStage.Dir);
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath),new Dictionary<string,object> { ["schema"]="local-operations/0.1",["observation_sha256"]=FaceStage.FileHash(LocalOperations.ObservationPath),["operations"]=new List<object>() });
                var body=AssetDatabase.LoadAssetAtPath<GameObject>(FaceStage.ValidatedOutput("Assets/Source/avatar.prefab"));var dressed=OutfitStage.Assemble(body,Avh.Plan(),out var hidden,out var entries);LocalOperations.Apply(dressed);PrefabUtility.SaveAsPrefabAsset(dressed,OutfitStage.AvatarPath);UnityEngine.Object.DestroyImmediate(dressed);AssetDatabase.SaveAssets();
                Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath),new Dictionary<string,object> { ["schema"]="outfit/0.3",["body_prefab"]=output,["avatar_prefab"]=OutfitStage.AvatarPath,["mode"]="preserve",["outfits"]=entries,["hidden_body_parts"]=hidden });OutfitMeasure.Write(OutfitStage.AvatarPath,OutfitStage.RecordPath);
                var clothing=Avh.ReadJsonFile(Path.Combine(Avh.RunDir,"observations/clothing.install.json")).Obj("metrics");Require(Equals(clothing["local_operations_valid"],true),"Existing outfit measurement rejected the legitimate face source revision");
                var outfitAvatar=AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath);var loaded=(GameObject)PrefabUtility.InstantiatePrefab(outfitAvatar);Require(LocalOperations.Verify(loaded,body,Avh.Plan(),new List<string>()),"Actual downstream reload lost the independently verified face variant");UnityEngine.Object.DestroyImmediate(loaded);
                OptimizeStage.CreatePreservedOutput(outfitAvatar);var optimized=AssetDatabase.LoadAssetAtPath<GameObject>(OptimizeStage.AvatarPath);Require(optimized.GetComponentsInChildren<SkinnedMeshRenderer>(true).Single().sharedMesh==finalFace.sharedMesh,"Existing optimize consumer lost the actual compensated face mesh");
#endif
                Refuses(() => FaceStage.ApplyManaged(), "Existing accepted or generated variant overwritten");
                var meshPath = AssetDatabase.GetAssetPath(finalFace.sharedMesh); var mesh = finalFace.sharedMesh; var vertices = mesh.vertices; vertices[0] += Vector3.one * .01f; mesh.vertices = vertices; EditorUtility.SetDirty(mesh); AssetDatabase.SaveAssets();
                Require(!FaceStage.VerifyOutput(output, new List<string>()), "Mutated output mesh passed even without a trusted receipt");
                input["observationSha256"] = new string('0', 64); WriteInput(input); Require(!FaceStage.VerifyOutput(output, new List<string>()), "Stale observation passed");
                input["observationSha256"] = FaceStage.FileHash(FaceStage.ObservationPath); input["targetId"] = new string('0', 64); WriteInput(input); Refuses(() => FaceStage.ApplyManaged(), "Unknown renderer identity passed", "Unknown exact target identity");
                input["targetId"] = target.Str("targetId"); WriteInput(input);
                var design = Avh.ReadJsonFile(Avh.Abs("Assets/_Harness/Face/blender-design.json")); design.Obj("units")["weights"] = "unity-percent"; Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/blender-design.json"), design); input.Obj("blenderDesign")["sha256"] = FaceStage.FileHash("Assets/_Harness/Face/blender-design.json"); WriteInput(input);
                var receipt = Avh.ReadJsonFile(Avh.Abs("Assets/_Harness/Face/Candidates/revision-1/candidate.json")); receipt["designFileSha256"] = input.Obj("blenderDesign").Str("sha256"); Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/Candidates/revision-1/candidate.json"), receipt); input.Obj("candidateReceipt")["sha256"] = FaceStage.FileHash("Assets/_Harness/Face/Candidates/revision-1/candidate.json"); WriteInput(input);
                Refuses(() => FaceStage.ApplyManaged(), "Wrong weight units passed", "Weight or geometry units mismatch");
                design.Obj("units")["weights"] = "blender-relative"; design["bake"] = new List<object> { map["RuntimeA"] }; design["preserve"] = new List<object> { map["ContourWidth"], map["RuntimeB"] }; design["values"] = new Dictionary<string, object> { [(string)map["RuntimeA"]] = .5 };
                Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/blender-design.json"), design); input.Obj("blenderDesign")["sha256"] = FaceStage.FileHash("Assets/_Harness/Face/blender-design.json"); receipt["designFileSha256"] = input.Obj("blenderDesign").Str("sha256"); Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/Candidates/revision-1/candidate.json"), receipt); input.Obj("candidateReceipt")["sha256"] = FaceStage.FileHash("Assets/_Harness/Face/Candidates/revision-1/candidate.json"); WriteInput(input);
                Refuses(() => FaceStage.ApplyManaged(), "Actual animation-owned runtime key was baked", "writer owns");
                var multiframe = UnityEngine.Object.Instantiate(sourceMesh); var key = multiframe.GetBlendShapeName(0); var delta = new Vector3[multiframe.vertexCount]; var zero = new Vector3[delta.Length]; multiframe.GetBlendShapeFrameVertices(0, 0, delta, zero, zero); multiframe.ClearBlendShapes(); multiframe.AddBlendShapeFrame(key, 50, delta, null, null); multiframe.AddBlendShapeFrame(key, 100, delta, null, null);
                var snapshot = FaceStage.MeshSnapshot(multiframe); Require(snapshot.List("keys").Cast<Dictionary<string, object>>().First().List("frames").Count == 2, "Multiframe source was silently flattened"); UnityEngine.Object.DestroyImmediate(multiframe);
                var preserve = new Dictionary<string, object> { ["schema"] = "face-unity-design/0.1", ["mode"] = "preserve", ["observationSha256"] = FaceStage.FileHash(FaceStage.ObservationPath) }; WriteInput(preserve);
                Require(FaceStage.ApplyManaged() == "Assets/Source/avatar.prefab" && FaceStage.ValidatedOutput("Assets/Source/avatar.prefab") == "Assets/Source/avatar.prefab", "Preserve branch did not retain its source");
                FaceStage.WriteMeasurement(); var kept = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations/face.apply.json")).Obj("metrics");
                Require(Equals(kept["face_source_preserved_valid"], true) && Equals(kept["face_design_applied"], false) && kept["face_geometry_valid"] == null, "Preserve branch falsely claimed face design");
                var importer = (ModelImporter)AssetImporter.GetAtPath("Assets/Source/source.fbx"); importer.isReadable = false; importer.SaveAndReimport(); observation = FaceStage.ObserveSource("Assets/Source/avatar.prefab"); Avh.WriteJson(Avh.Abs(FaceStage.ObservationPath), observation); preserve["observationSha256"] = FaceStage.FileHash(FaceStage.ObservationPath); WriteInput(preserve);
                Require(FaceStage.ApplyManaged() == "Assets/Source/avatar.prefab", "Unreadable mesh blocked ordinary preserve");
                var empty = new GameObject("NoFaceShapes"); PrefabUtility.SaveAsPrefabAsset(empty, "Assets/Source/empty.prefab"); UnityEngine.Object.DestroyImmediate(empty); AssetDatabase.SaveAssets(); observation = FaceStage.ObserveSource("Assets/Source/empty.prefab"); Avh.WriteJson(Avh.Abs(FaceStage.ObservationPath), observation); preserve["observationSha256"] = FaceStage.FileHash(FaceStage.ObservationPath); WriteInput(preserve);
                Require(FaceStage.ApplyManaged() == "Assets/Source/empty.prefab", "No-face source blocked preserve");
                Avh.WriteJson(Avh.Abs("result.json"), new Dictionary<string, object> { ["ok"] = true, ["assertions"] = assertions }); EditorApplication.Exit(0);
            }
            catch (Exception e) { try { Avh.WriteJson(Avh.Abs("current-observation.json"), FaceStage.ObserveSource("Assets/Source/avatar.prefab")); } catch { } Avh.WriteJson(Avh.Abs("result.json"), new Dictionary<string, object> { ["ok"] = false, ["assertions"] = assertions, ["error"] = e.ToString() }); EditorApplication.Exit(1); }
        }
    }
}
