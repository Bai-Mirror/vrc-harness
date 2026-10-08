// Synthetic FBX fixture only. Actual production tools perform observation, mathematics and rendering.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
    public static class FaceCandidateFbxSeed
    {
        public static void Run()
        {
            try
            {
                const string path="Assets/Source/source.fbx";
                AssetDatabase.ImportAsset(path,ImportAssetOptions.ForceSynchronousImport);var importer=(ModelImporter)AssetImporter.GetAtPath(path);
                importer.isReadable=true;importer.importAnimation=false;importer.meshCompression=ModelImporterMeshCompression.Off;
                importer.optimizeMeshVertices=false;importer.optimizeMeshPolygons=false;importer.SaveAndReimport();
                var model=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(path));model.name="SyntheticFbxAvatar";
                var renderer=model.GetComponentsInChildren<SkinnedMeshRenderer>(true).Single();
                var actualKeys=renderer.sharedMesh.blendShapeCount;
                var material=new Material(Shader.Find("Standard"));material.color=new Color(.65f,.4f,.3f);AssetDatabase.CreateAsset(material,"Assets/Source/skin.mat");renderer.sharedMaterial=material;
                PrefabUtility.SaveAsPrefabAsset(model,"Assets/Source/avatar.prefab");UnityEngine.Object.DestroyImmediate(model);AssetDatabase.SaveAssets();
                var observed=FaceStage.ObserveSource("Assets/Source/avatar.prefab");Avh.WriteJson(Avh.Abs(FaceStage.ObservationPath),observed);
                var target=observed.List("targets").Cast<Dictionary<string,object>>().Single();
                var key=target.Obj("meshSnapshot").List("keys").Cast<Dictionary<string,object>>().Single(k=>k.Str("name").EndsWith("ContourWidth",StringComparison.Ordinal)).Str("name");
                Avh.WriteJson(Avh.Abs("_harness/face/request.json"),new Dictionary<string,object>{["schema"]="face-request/0.2",["observationSha256"]=FaceStage.FileHash(FaceStage.ObservationPath),["targetId"]=target.Str("targetId"),
                    ["candidates"]=new object[]{new Dictionary<string,object>{["id"]="slim",["values"]=new Dictionary<string,object>{[key]=.25}},new Dictionary<string,object>{["id"]="wide",["values"]=new Dictionary<string,object>{[key]=.7}}}});
                Avh.WriteJson(Avh.Abs("seed-result.json"),new Dictionary<string,object>{["synthetic"]=true,["realImportedFbx"]=true,["actualKeys"]=actualKeys,["compensationQualified"]=false});EditorApplication.Exit(0);
            }
            catch(Exception error){Avh.WriteJson(Avh.Abs("seed-result.json"),new Dictionary<string,object>{["error"]=error.ToString()});EditorApplication.Exit(1);}
        }
    }
}
