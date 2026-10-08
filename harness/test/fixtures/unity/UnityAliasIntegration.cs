// Actual shipping consumers, executed by WindowsUnityLauncher against an isolated SDK project.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using AVH.Harness;
using UnityEditor;
using UnityEngine;

public static class UnityAliasIntegration
{
    static readonly List<string> Passed = new List<string>();
    static void Check(bool ok, string name) { if (!ok) throw new Exception(name); Passed.Add(name); }
    static void Refuses(Action action, string name)
    { try { action(); } catch (Exception) { Passed.Add(name); return; } throw new Exception("Accepted " + name); }
    static object Invoke(Type type, string method, params object[] args)
    { return type.GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, args); }
    public static void Run()
    {
        try
        {
            Check(Avh.ProjectDir != Avh.ProjectIdentityDir, "actual short execution path differs from physical authority");
            Check(Avh.ProjectIdentityDir == Environment.GetEnvironmentVariable("AVH_PROBE_EXPECTED_PROJECT"), "Runtime overrides forged step physical binding");
            var nonce = Avh.Env("AVH_UNITY_ALIAS_NONCE");
            Check(nonce != "forged-provider-nonce", "Runtime overrides forged step nonce");
            Environment.SetEnvironmentVariable("AVH_UNITY_ALIAS_NONCE", "wrong");
            Refuses(() => { var x = Avh.ProjectIdentityDir; }, "changed alias nonce refused");
            Environment.SetEnvironmentVariable("AVH_UNITY_ALIAS_NONCE", nonce);
            var physical = Avh.ProjectIdentityDir;
            Environment.SetEnvironmentVariable("AVH_PHYSICAL_PROJECT_DIR", Path.GetDirectoryName(physical));
            Refuses(() => { var x = Avh.ProjectIdentityDir; }, "changed alias target binding refused");
            Environment.SetEnvironmentVariable("AVH_PHYSICAL_PROJECT_DIR", physical);

            const string folder = "Assets/_Harness/Face/AliasFixture";
            Directory.CreateDirectory(Avh.Abs(folder)); AssetDatabase.Refresh();
            const string prefabPath = folder + "/Avatar.prefab";
            if (AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath) == null)
            {
                var root = new GameObject("Avatar"); var bone = new GameObject("Head"); bone.transform.SetParent(root.transform);
                var body = new GameObject("Body"); body.transform.SetParent(root.transform);
                var mesh = new Mesh { name = "Face" }; mesh.vertices = new[] { Vector3.zero, Vector3.right * .1f, Vector3.up * .1f };
                mesh.triangles = new[] { 0, 1, 2 }; mesh.uv = new[] { Vector2.zero, Vector2.right, Vector2.up };
                mesh.boneWeights = Enumerable.Repeat(new BoneWeight { boneIndex0 = 0, weight0 = 1 }, 3).ToArray();
                mesh.bindposes = new[] { Matrix4x4.identity }; mesh.RecalculateNormals();
                mesh.AddBlendShapeFrame("ActualKey", 100, new[] { Vector3.zero, Vector3.zero, Vector3.forward * .01f }, new Vector3[3], new Vector3[3]);
                AssetDatabase.CreateAsset(mesh, folder + "/Face.asset");
                var material = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(material, folder + "/Skin.mat");
                var renderer = body.AddComponent<SkinnedMeshRenderer>(); renderer.sharedMesh = mesh; renderer.bones = new[] { bone.transform };
                renderer.rootBone = bone.transform; renderer.sharedMaterial = material;
                PrefabUtility.SaveAsPrefabAsset(root, prefabPath); UnityEngine.Object.DestroyImmediate(root); AssetDatabase.SaveAssets();
            }
            var observation = FaceStage.ObserveSource(prefabPath);
            Check(observation.List("targets").Count == 1, "FaceStage observes actual skinned prefab through owned root");
            var priorPath = Avh.Abs(folder + "/prior-observation.json");
            if (File.Exists(priorPath)) Check(Avh.Json(Avh.ReadJsonFile(priorPath)) == Avh.Json(observation), "new alias preserves source observation identity");
            else Avh.WriteJson(priorPath, observation);
            Avh.WriteJson(Avh.Abs(FaceStage.ObservationPath), observation);
            Avh.WriteJson(Avh.Abs(FaceStage.InputPath), new Dictionary<string, object> { ["schema"] = "face-unity-design/0.1", ["mode"] = "preserve",
                ["observationSha256"] = FaceStage.FileHash(FaceStage.ObservationPath) });
            Check(FaceStage.ApplyManaged() == prefabPath, "actual face preserve consumer keeps observed prefab");
            FaceStage.WriteMeasurement();
            Check(FaceStage.VerifyOutput(prefabPath, new List<string>()), "actual face output independently reads back through alias");
            Check(FaceStage.ValidatedOutput(prefabPath) == prefabPath, "downstream consumes independently checked face output");
            var record = Avh.ReadJsonFile(Avh.Abs(FaceStage.RecordPath)); var recordText = Avh.Json(record);
            record["observationSha256"] = "changed"; Avh.WriteJson(Avh.Abs(FaceStage.RecordPath), record);
            Refuses(() => FaceStage.ValidatedOutput(prefabPath), "downstream refuses changed source revision through alias");
            File.WriteAllText(Avh.Abs(FaceStage.RecordPath), recordText);

            var bytes = new byte[12]; Buffer.BlockCopy(new[] { 1f, 2f, 3f }, 0, bytes, 0, 12);
            const string binary = folder + "/frame.bin"; File.WriteAllBytes(Avh.Abs(binary), bytes);
            var reference = new Dictionary<string, object> { ["file"] = binary, ["sha256"] = FaceStage.Hash(bytes), ["encoding"] = "float32-le", ["count"] = 1 };
            Check(FaceMapping.ReadVectors(reference)[0] == new Vector3(1, 2, 3), "FaceMapping reads independently hashed managed frame");
            var texture = Avh.Env("AVH_PROBE_TEXTURE");
            Check((string)Invoke(typeof(FacePreviewStage), "SourceHash", texture) == Avh.Env("AVH_PROBE_TEXTURE_SHA"), "FacePreview source reads real long-path texture");
            Check(Avh.IdentityAbs(texture) == Path.Combine(physical, texture.Replace('/', Path.DirectorySeparatorChar)), "catalog physical source identity retained");

            var linked = Avh.Env("AVH_PROBE_LINKED_PATH");
            // The host installs this private negative fixture after initial AssetDatabase import.
            File.WriteAllText(Path.Combine(Avh.RunDir, "negative-ready"), "ready");
            for (var attempt = 0; attempt < 600 && !File.Exists(Avh.Abs(linked)); attempt++) System.Threading.Thread.Sleep(50);
            Check(File.Exists(Avh.Abs(linked)), "host supplied actual descendant junction negative fixture");
            Refuses(() => Avh.AssertManagedPath(Avh.Abs(linked)), "descendant directory junction refused");
            Refuses(() => Invoke(typeof(FacePreviewStage), "Safe", linked), "preview refuses descendant junction");
            Refuses(() => FaceStage.ObserveSource(linked), "face source refuses descendant junction");
            reference["file"] = linked;
            Refuses(() => FaceMapping.ReadVectors(reference), "frame consumer refuses descendant junction");
            Avh.WriteJson(Avh.Env("AVH_PROBE_OUTPUT"), new Dictionary<string, object> { ["passed"] = Passed, ["assertions"] = Passed.Count,
                ["sourceObservationSha256"] = FaceStage.Hash(System.Text.Encoding.UTF8.GetBytes(Avh.Json(observation))), ["sdkAssembly"] = typeof(VRC.SDK3.Avatars.Components.VRCAvatarDescriptor).Assembly.GetName().Name });
            EditorApplication.Exit(0);
        }
        catch (Exception error) { Debug.LogError(error); EditorApplication.Exit(1); }
    }
}
