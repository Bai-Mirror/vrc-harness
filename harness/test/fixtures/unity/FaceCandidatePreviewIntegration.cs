// Synthetic Unity keys test actual combination rendering; this fixture does not claim Blender compensation qualification.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
    public static class FaceCandidatePreviewIntegration
    {
        static Dictionary<string,object> D(params object[] pairs){var result=new Dictionary<string,object>();for(var i=0;i<pairs.Length;i+=2)result[(string)pairs[i]]=pairs[i+1];return result;}
        static Dictionary<string,object> Ref(string path)=>D("file",path,"sha256",FaceStage.FileHash(path));
        public static void Prepare()=>Avh.Stage("fixture.candidates",PrepareSource);
        public static void PrepareSource()
        {
            var model=GameObject.CreatePrimitive(PrimitiveType.Sphere);model.name="SyntheticCombinationModel";
            var mesh=UnityEngine.Object.Instantiate(model.GetComponent<MeshFilter>().sharedMesh);mesh.name="SyntheticShapeMesh";
            var delta=mesh.vertices.Select(v=>new Vector3(v.x*.6f,0,0)).ToArray();mesh.AddBlendShapeFrame("Width",100,delta,null,null);
            var bone=new GameObject("SyntheticBone");bone.transform.SetParent(model.transform,false);
            mesh.boneWeights=mesh.vertices.Select(v=>new BoneWeight{boneIndex0=0,weight0=1}).ToArray();mesh.bindposes=new[]{Matrix4x4.identity};
            AssetDatabase.CreateAsset(mesh,"Assets/Source/face.asset");UnityEngine.Object.DestroyImmediate(model.GetComponent<MeshRenderer>());UnityEngine.Object.DestroyImmediate(model.GetComponent<MeshFilter>());
            var renderer=model.AddComponent<SkinnedMeshRenderer>();renderer.sharedMesh=mesh;renderer.localBounds=mesh.bounds;renderer.updateWhenOffscreen=true;
            renderer.bones=new[]{bone.transform};renderer.rootBone=bone.transform;
            var material=new Material(Shader.Find("Standard"));material.color=new Color(.65f,.4f,.3f);AssetDatabase.CreateAsset(material,"Assets/Source/skin.mat");renderer.sharedMaterial=material;
            PrefabUtility.SaveAsPrefabAsset(model,"Assets/Source/avatar.prefab");UnityEngine.Object.DestroyImmediate(model);AssetDatabase.SaveAssets();
            var observed=FaceStage.ObserveSource("Assets/Source/avatar.prefab");Avh.WriteJson(Avh.Abs(FaceStage.ObservationPath),observed);
            var target=observed.List("targets").Cast<Dictionary<string,object>>().Single();var observedHash=FaceStage.FileHash(FaceStage.ObservationPath);
            var request=D("schema","face-request/0.2","observationSha256",observedHash,"targetId",target.Str("targetId"),"candidates",new object[]{D("id","slim","values",D("Width",-.4)),D("id","wide","values",D("Width",.7))});
            Avh.WriteJson(Avh.Abs("_harness/face/request.json"),request);Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/catalog.json"),D("schema","synthetic-render-catalog","notCompensationEvidence",true));
            var candidates=new List<object>();
            foreach(var item in new[]{D("id","slim","weightsUnityPercent",D("Width",-40)),D("id","wide","weightsUnityPercent",D("Width",70))})
            {
                var directory="Assets/_Harness/Face/CandidateSets/synthetic-set/"+item.Str("id");
                Avh.WriteJson(Avh.Abs(directory+"/design.json"),D("schema","synthetic-render-design","notCompensationEvidence",true));
                Avh.WriteJson(Avh.Abs(directory+"/validation.json"),D("schema","synthetic-render-validation","qualified",false));
                item["design"]=Ref(directory+"/design.json");item["validation"]=Ref(directory+"/validation.json");candidates.Add(item);
            }
            var tools=new Dictionary<string,object>();foreach(var name in new[]{"FacePreviewStage.cs","FaceStage.cs","FaceGeometry.cs","FaceEyes.cs","FaceMapping.cs","AvhCommon.cs"})tools[name]=FaceStage.FileHash("Assets/_HarnessTools/Editor/"+name);
            var editor=EditorApplication.applicationPath;
            var collection=D("schema","face-candidate-set/0.1","id","synthetic-set","productionAccepted",false,"requestSha256",FaceStage.FileHash("_harness/face/request.json"),"observationSha256",observedHash,"sourcePrefab","Assets/Source/avatar.prefab","targetId",target.Str("targetId"),"binary",D("path",editor,"sha256",FaceStage.Hash(File.ReadAllBytes(editor)),"version","Synthetic Unity rendering fixture; no Blender validation"),"tools",tools,"blenderCatalog",Ref("Assets/_Harness/Face/catalog.json"),"candidates",candidates);
            Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/CandidateSets/synthetic-set/candidate-set.json"),collection);Avh.WriteJson(Avh.Abs("_harness/face/candidates.json"),collection);
            Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/preview-input.json"),D("schema","face-preview-input/0.1","observationSha256",observedHash,"collectionSha256",FaceStage.FileHash("_harness/face/candidates.json"),"sourcePrefab","Assets/Source/avatar.prefab","targetId",target.Str("targetId"),"candidates",candidates.Cast<Dictionary<string,object>>().Select(c=>(object)D("id",c.Str("id"),"weightsUnityPercent",c.Obj("weightsUnityPercent"))).ToList()));
        }
        public static void Run()
        {
            try
            {
                PrepareSource();var before=Directory.GetFiles(Avh.Abs("Assets/Source"),"*",SearchOption.AllDirectories).ToDictionary(p=>p,p=>FaceStage.Hash(File.ReadAllBytes(p)));
                FacePreviewStage.WriteCandidatePreview();foreach(var pair in before)if(FaceStage.Hash(File.ReadAllBytes(pair.Key))!=pair.Value)throw new Exception("Rendering changed source: "+pair.Key);
                var manifest=Avh.ReadJsonFile(Avh.Abs("_harness/face/candidate-preview/manifest.json"));var images=manifest.List("images").Cast<Dictionary<string,object>>().ToArray();
                if(images.Length!=6||images.Where(i=>i.Str("version")=="after"&&i.Str("view")=="front").Select(i=>i.Str("sha256")).Distinct().Count()!=2)throw new Exception("Actual candidate combination images were not distinct");
                Avh.WriteJson(Avh.Abs("result.json"),D("ok",true,"realImages",6,"actualCombinations",2,"sourceUnchanged",true,"compensationQualified",false));EditorApplication.Exit(0);
            }
            catch(Exception error){Avh.WriteJson(Avh.Abs("result.json"),D("ok",false,"error",error.ToString()));EditorApplication.Exit(1);}
        }
    }
}

