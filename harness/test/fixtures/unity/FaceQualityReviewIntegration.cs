// Synthetic numerical groups exercise the shipped renderer; these images are not character acceptance evidence.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
namespace AVH.Harness {
 public static class FaceQualityReviewIntegration {
  static Dictionary<string,object> D(params object[] values){var d=new Dictionary<string,object>();for(var i=0;i<values.Length;i+=2)d[(string)values[i]]=values[i+1];return d;}
  public static void Run(){try{
   var scene=EditorSceneManager.NewPreviewScene();var sphere=GameObject.CreatePrimitive(PrimitiveType.Sphere);SceneManager.MoveGameObjectToScene(sphere,scene);
   var mesh=UnityEngine.Object.Instantiate(sphere.GetComponent<MeshFilter>().sharedMesh);UnityEngine.Object.DestroyImmediate(sphere.GetComponent<MeshFilter>());UnityEngine.Object.DestroyImmediate(sphere.GetComponent<MeshRenderer>());
   mesh.boneWeights=Enumerable.Range(0,mesh.vertexCount).Select(_=>new BoneWeight{boneIndex0=0,weight0=1}).ToArray();mesh.bindposes=new[]{Matrix4x4.identity};
   var skin=sphere.AddComponent<SkinnedMeshRenderer>();skin.sharedMesh=mesh;skin.bones=new[]{sphere.transform};skin.rootBone=sphere.transform;skin.sharedMaterial=new Material(Shader.Find("Standard"));
   var changed=UnityEngine.Object.Instantiate(sphere);SceneManager.MoveGameObjectToScene(changed,scene);changed.GetComponent<SkinnedMeshRenderer>().sharedMaterial.color=new Color(.6f,.4f,.3f);
   var cameraObject=new GameObject("Camera");SceneManager.MoveGameObjectToScene(cameraObject,scene);var camera=cameraObject.AddComponent<Camera>();camera.scene=scene;camera.orthographic=true;camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=new Color(.1f,.1f,.1f);camera.nearClipPlane=.001f;camera.farClipPlane=20;
   RenderSettings.ambientLight=Color.white;RenderSettings.ambientMode=UnityEngine.Rendering.AmbientMode.Flat;
   var lampObject=new GameObject("Key light");SceneManager.MoveGameObjectToScene(lampObject,scene);var lamp=lampObject.AddComponent<Light>();lamp.type=LightType.Directional;lamp.intensity=1;lampObject.transform.rotation=Quaternion.Euler(25,-30,0);
   var rawPath="Assets/_Harness/Face/verification.json";var designPath="Assets/_Harness/Face/review-design.json";
   var group=D("region","face-center","kind","edge distortion","baseline","new","rawCount",2,"uniqueCount",1,"maximumChangeMeters",.0001,"maximumFootprintMeters",.001);
   Avh.WriteJson(Avh.Abs(rawPath),D("compensation",D("quality",new object[]{D("state","basis","findings",new object[]{D("kind","edge distortion"),D("kind","edge distortion")},"reviewGroups",new object[]{group})})));
   Avh.WriteJson(Avh.Abs(designPath),D("recipe",D("compensation",D("regions",new object[0]))));
   var input=D("blenderVerification",D("file",rawPath,"sha256",FaceStage.FileHash(rawPath)),"blenderDesign",D("file",designPath));
   var directory="_harness/face/preview/quality-fixture";Directory.CreateDirectory(Avh.Abs(directory));
   var target=D("rendererPath","","rendererIndex",0);var method=typeof(FacePreviewStage).GetMethod("QualityReview",BindingFlags.NonPublic|BindingFlags.Static);
   var review=(Dictionary<string,object>)method.Invoke(null,new object[]{sphere,changed,target,input,camera,directory,3f});
   if(Convert.ToInt32(review["rawFindingCount"])!=2||Convert.ToInt32(review["uniqueFindingCount"])!=1||review.List("images").Count!=4||review.List("groups").Count!=1)throw new Exception("Representative render lost the actual grouped records");
   Avh.WriteJson(Avh.Abs("quality-result.json"),review);EditorSceneManager.ClosePreviewScene(scene);EditorApplication.Exit(0);
  }catch(Exception e){Avh.WriteJson(Avh.Abs("quality-error.json"),D("error",e.ToString()));EditorApplication.Exit(1);}}
 }
}
