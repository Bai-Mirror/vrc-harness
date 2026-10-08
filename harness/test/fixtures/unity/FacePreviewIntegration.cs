// Actual Unity render fixture. This synthetic sphere tests evidence transport, not character quality.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
    public static class FacePreviewIntegration
    {
        static void Require(bool ok, string reason) { if (!ok) throw new Exception(reason); }
        public static void Run()
        {
            try
            {
                var model = GameObject.CreatePrimitive(PrimitiveType.Sphere); model.name = "SyntheticPreviewModel";
                var material = new Material(Shader.Find("Standard")); material.color = new Color(.65f, .4f, .3f);
                AssetDatabase.CreateAsset(material, "Assets/Source/skin.mat"); model.GetComponent<Renderer>().sharedMaterial = material;
                PrefabUtility.SaveAsPrefabAsset(model, "Assets/Source/avatar.prefab"); UnityEngine.Object.DestroyImmediate(model); AssetDatabase.SaveAssets();
                var observation = FaceStage.ObserveSource("Assets/Source/avatar.prefab"); Avh.WriteJson(Avh.Abs(FaceStage.ObservationPath), observation);
                Avh.WriteJson(Avh.Abs(FaceStage.InputPath), new Dictionary<string, object> { ["schema"] = "face-unity-design/0.1", ["mode"] = "preserve", ["observationSha256"] = FaceStage.FileHash(FaceStage.ObservationPath) });
                FaceStage.ApplyManaged();
                var before = Directory.GetFiles(Avh.Abs("Assets/Source"), "*", SearchOption.AllDirectories).ToDictionary(p => p, p => FaceStage.Hash(File.ReadAllBytes(p)));
                FacePreviewStage.WritePreview();
                foreach (var pair in before) Require(FaceStage.Hash(File.ReadAllBytes(pair.Key)) == pair.Value, "Render changed source asset: " + pair.Key);
                var manifest = Avh.ReadJsonFile(Avh.Abs("_harness/face/preview/manifest.json")); Require(manifest.List("images").Count == 4, "Actual render did not produce four images");
                Require(Equals(manifest["productionAccepted"], false), "Render invented acceptance");
                Avh.WriteJson(Avh.Abs("result.json"), new Dictionary<string, object> { ["ok"] = true, ["mode"] = "preserve", ["realImages"] = 4, ["sourceUnchanged"] = true, ["productionAccepted"] = false });
                EditorApplication.Exit(0);
            }
            catch (Exception e) { Avh.WriteJson(Avh.Abs("result.json"), new Dictionary<string, object> { ["ok"] = false, ["error"] = e.ToString() }); EditorApplication.Exit(1); }
        }
    }
}
