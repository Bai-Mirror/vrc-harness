// Real same-path importer integration. Faults are injected at Unity's import boundary.
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness {
 public class NativeImportFault : AssetPostprocessor {
  public static float BindposeOffset;public static bool UvDrift,DefaultDrift;
  void OnPostprocessModel(GameObject go){
   if(assetPath!="Assets/Source/source.fbx"||(!UvDrift&&!DefaultDrift&&BindposeOffset==0))return;
   var receipt=Avh.ReadJsonFile(Avh.Abs("Assets/_Harness/Face/Candidates/test/candidate.json"));
   if(FaceStage.FileHash(assetPath)!=receipt.Obj("outputs").Obj("fbx").Str("sha256"))return;
   foreach(var r in go.GetComponentsInChildren<SkinnedMeshRenderer>(true)){
    if(r.sharedMesh.blendShapeCount==0)continue;if(DefaultDrift&&r.name=="Other")r.SetBlendShapeWeight(0,0);
    if(BindposeOffset!=0){var bind=r.sharedMesh.bindposes;bind[0].m03+=BindposeOffset;r.sharedMesh.bindposes=bind;}
    if(UvDrift){var uv=r.sharedMesh.uv;uv[0]+=Vector2.one*.1f;r.sharedMesh.uv=uv;}
   }
  }
 }
 public static class FaceNativeIntegration {
  static int checks;
  static void AdditiveChecks(){
   var root=new GameObject("AdditiveControls");var vertices=new List<Vector3>();var triangles=new List<int>();var weights=new List<BoneWeight>();var inner=new List<(int vertex,int eye,float sign)>();
   var bones=new[]{"Head","LeftEye","RightEye"}.Select((name,i)=>{var go=new GameObject(name);go.transform.SetParent(root.transform,false);go.transform.position=new Vector3(i==1?-.03f:i==2?.03f:0,0,0);return go.transform;}).ToArray();
   for(var eye=1;eye<=2;eye++){var x=eye==1?-.03f:.03f;foreach(var part in new[]{(-.012f,-.003f,.001f,0),(.003f,.012f,.001f,0),(-.005f,.005f,0f,eye)}){
    var at=vertices.Count;vertices.AddRange(new[]{new Vector3(x-.007f,part.Item1,part.Item3),new Vector3(x+.007f,part.Item1,part.Item3),new Vector3(x+.007f,part.Item2,part.Item3),new Vector3(x-.007f,part.Item2,part.Item3)});triangles.AddRange(new[]{at,at+1,at+2,at,at+2,at+3});weights.AddRange(Enumerable.Repeat(new BoneWeight{boneIndex0=part.Item4,weight0=part.Item4==0?1:.4f,boneIndex1=0,weight1=part.Item4==0?0:.6f},4));if(part.Item4==0){if(part.Item1<0){inner.Add((at+2,eye,-1));inner.Add((at+3,eye,-1));}else{inner.Add((at,eye,1));inner.Add((at+1,eye,1));}}}}
   var mesh=new Mesh();mesh.vertices=vertices.ToArray();mesh.triangles=triangles.ToArray();mesh.boneWeights=weights.ToArray();mesh.bindposes=bones.Select(b=>b.worldToLocalMatrix).ToArray();
   var shift=new Vector3[vertices.Count];var blink=new Vector3[vertices.Count];var wink=new Vector3[vertices.Count];foreach(var p in inner){shift[p.vertex].y=p.sign*.002f;blink[p.vertex].y=-p.sign*.003f;if(p.eye==1)wink[p.vertex]=blink[p.vertex];}
   mesh.AddBlendShapeFrame("Blink",100,blink,null,null);mesh.AddBlendShapeFrame("Wink",100,wink,null,null);mesh.AddBlendShapeFrame("Mouth",100,new Vector3[vertices.Count],null,null);
   var renderer=root.AddComponent<SkinnedMeshRenderer>();renderer.sharedMesh=mesh;renderer.bones=bones;renderer.rootBone=bones[0];
   var recipe=Avh.ParseJson("{\"regions\":[{\"side\":\"left\",\"bone\":\"LeftEye\"},{\"side\":\"right\",\"bone\":\"RightEye\"}],\"expressionKeys\":[\"Blink\",\"Wink\",\"Mouth\"],\"mouthKeys\":[\"Mouth\"],\"blinkKey\":\"Blink\",\"maskInnerMeters\":0.026,\"maskOuterMeters\":0.034}") as Dictionary<string,object>;
   var profile=new FaceEyes.ExposureProfile(renderer,recipe);var basis=vertices.Select((v,i)=>v+shift[i]).ToArray();var delta=profile.Compensate("Blink",basis,blink);var unilateral=profile.Compensate("Wink",basis,wink);
   Require(inner.All(p=>Math.Abs(delta[p.vertex].y+p.sign*.005f)<1e-6),"Additive source visibility did not compensate both closed eyes");Require(inner.Where(p=>p.eye==2).All(p=>unilateral[p.vertex]==Vector3.zero),"Wink compensated the other eye");Require(profile.Compensate("Mouth",basis,blink).SequenceEqual(blink),"Check-only mouth delta changed");
   var candidateRoot=new GameObject("AdditiveCandidate");var actual=candidateRoot.AddComponent<SkinnedMeshRenderer>();var changed=UnityEngine.Object.Instantiate(mesh);changed.vertices=basis;changed.ClearBlendShapes();changed.AddBlendShapeFrame("Blink",100,delta,null,null);changed.AddBlendShapeFrame("Wink",100,unilateral,null,null);changed.AddBlendShapeFrame("Mouth",100,new Vector3[vertices.Count],null,null);actual.sharedMesh=changed;
   Require(profile.Verify(renderer,actual).Str("status")=="technical_controls_passed","Actual additive eye exposure readback failed");changed.ClearBlendShapes();changed.AddBlendShapeFrame("Blink",100,blink,null,null);changed.AddBlendShapeFrame("Wink",100,wink,null,null);changed.AddBlendShapeFrame("Mouth",100,new Vector3[vertices.Count],null,null);Require(profile.Verify(renderer,actual).Str("status")=="needs_visual_review","Uncompensated eye leakage was accepted");
   // Importers may merge eye influences into Head. Frozen source position/UV
   // identities must still select the actual eye card, not a decorative island.
   var imported=UnityEngine.Object.Instantiate(mesh);imported.uv=vertices.Select(v=>new Vector2((v.x+.05f)/.1f,(v.y+.02f)/.04f)).ToArray();imported.boneWeights=vertices.Select(v=>new BoneWeight{boneIndex0=0,weight0=1}).ToArray();
   var holder=new GameObject("ImportedEyeControls");var mappedRenderer=holder.AddComponent<SkinnedMeshRenderer>();mappedRenderer.sharedMesh=imported;mappedRenderer.bones=bones;mappedRenderer.rootBone=bones[0];
   var polygons=new List<object>();for(var f=0;f<triangles.Count;f+=3){var ids=triangles.Skip(f).Take(3).Reverse().ToArray();var corners=ids.Select(i=>(object)new object[]{imported.uv[i].x,imported.uv[i].y}).ToList();var layers=new Dictionary<string,object>{{"UVMap",corners}};polygons.Add(new Dictionary<string,object>{{"vertices",ids.Select(i=>(object)i).ToList()},{"material",0},{"uv",layers}});}
   var sourceMesh=new Dictionary<string,object>{{"vertices",vertices.Select(v=>(object)new object[]{-v.x,v.y,v.z}).ToList()},{"polygons",polygons}};
   var specs=recipe.List("regions").Cast<Dictionary<string,object>>().ToArray();for(var eye=0;eye<specs.Length;eye++){var bone=eye+1;specs[eye]["material"]=0;specs[eye]["samplePolygons"]=Enumerable.Range(0,triangles.Count/3).Where(f=>triangles.Skip(f*3).Take(3).All(v=>weights[v].boneIndex0==bone)).Select(i=>(object)i).ToList();specs[eye]["occluderPolygons"]=Enumerable.Range(0,triangles.Count/3).Where(f=>triangles.Skip(f*3).Take(3).All(v=>weights[v].boneIndex0==0)).Select(i=>(object)i).ToList();}
   var mappedProfile=new FaceEyes.ExposureProfile(mappedRenderer,recipe,sourceMesh);Require(mappedProfile.Compensate("Blink",basis,blink).SequenceEqual(delta),"Frozen native source eye surfaces changed additive compensation");
   Refuses(()=>{new FaceEyes.ExposureProfile(mappedRenderer,recipe);},"No independently measurable Unity eye surface");
   var material=new Material(Shader.Find("Standard"));var texture=new Texture2D(2048,2048,TextureFormat.R8,false);material.mainTexture=texture;mappedRenderer.sharedMaterials=new[]{material};
   var sourceUv=imported.uv;var nearUv=(Vector2[])sourceUv.Clone();nearUv[0]+=new Vector2(-.0000025034f,-.00002282858f);imported.uv=nearUv;
   var subtexel=new FaceEyes.ExposureProfile(mappedRenderer,recipe,sourceMesh);Require(subtexel.Compensate("Blink",basis,blink).SequenceEqual(delta),"Quarter-texel UV source correspondence rejected the measured 2.2966e-5 import seam");
   var larger=new Texture2D(8192,8192,TextureFormat.R8,false);material.SetTexture("_DetailAlbedoMap",larger);var largestUv=(Vector2[])sourceUv.Clone();largestUv[0]+=Vector2.right*.00005f;imported.uv=largestUv;Refuses(()=>{new FaceEyes.ExposureProfile(mappedRenderer,recipe,sourceMesh);},"surface coverage is incomplete");material.SetTexture("_DetailAlbedoMap",null);UnityEngine.Object.DestroyImmediate(larger);imported.uv=nearUv;
   // The exact same production profile rejects the positive fixture when
   // texture evidence is removed: the strict fallback remains executable.
   mappedRenderer.sharedMaterials=new Material[0];Refuses(()=>{new FaceEyes.ExposureProfile(mappedRenderer,recipe,sourceMesh);},"surface coverage is incomplete");mappedRenderer.sharedMaterials=new[]{material};
   var farUv=(Vector2[])sourceUv.Clone();farUv[0]+=Vector2.right*(.25f/2048*1.05f);imported.uv=farUv;Refuses(()=>{new FaceEyes.ExposureProfile(mappedRenderer,recipe,sourceMesh);},"surface coverage is incomplete");imported.uv=sourceUv;
   // A second face with identical corner identity is not resolved by picking
   // the first polygon, including when the competitor is outside the region.
   polygons.Add(polygons[0]);Refuses(()=>{new FaceEyes.ExposureProfile(mappedRenderer,recipe,sourceMesh);},"correspondence is ambiguous");polygons.RemoveAt(polygons.Count-1);
   var savedTriangles=imported.triangles;var wrongTriangles=(int[])savedTriangles.Clone();wrongTriangles[2]=4;imported.triangles=wrongTriangles;Refuses(()=>{new FaceEyes.ExposureProfile(mappedRenderer,recipe,sourceMesh);},"surface coverage is incomplete");imported.triangles=savedTriangles;
   var changedUv=imported.uv;changedUv[0]+=Vector2.one*.001f;imported.uv=changedUv;Refuses(()=>{new FaceEyes.ExposureProfile(mappedRenderer,recipe,sourceMesh);},"surface coverage is incomplete");
   // A real imported triangle can represent a source quad whose EXACT
   // zero-length edge vanished. Keep the authored boundary via a virtual
   // zero-area triangle, without inventing an eye ray or tolerating a
   // nonzero edge disappearing from source topology.
   var appended=new[]{new Vector3(-.1f,-.1f,0),new Vector3(-.09f,-.1f,0),new Vector3(-.09f,-.09f,0)};var expanded=new Mesh();expanded.vertices=vertices.Concat(appended).ToArray();expanded.triangles=triangles.Concat(new[]{24,26,25}).ToArray();expanded.uv=sourceUv.Concat(new[]{Vector2.zero,Vector2.right,Vector2.one}).ToArray();expanded.bindposes=mesh.bindposes;expanded.boneWeights=Enumerable.Repeat(new BoneWeight{boneIndex0=0,weight0=1},27).ToArray();expanded.AddBlendShapeFrame("Blink",100,blink.Concat(new Vector3[3]).ToArray(),null,null);expanded.AddBlendShapeFrame("Wink",100,wink.Concat(new Vector3[3]).ToArray(),null,null);expanded.AddBlendShapeFrame("Mouth",100,new Vector3[27],null,null);
   var sourcePoints=sourceMesh.List("vertices");foreach(var v in appended.Concat(new[]{appended[2]}))sourcePoints.Add(new object[]{-v.x,v.y,v.z});
   var quad=polygons.Count;polygons.Add(new Dictionary<string,object>{{"vertices",new object[]{24,25,26,27}.ToList()},{"material",0},{"uv",new Dictionary<string,object>{{"UVMap",new object[]{new object[]{0,0},new object[]{1,0},new object[]{1,1},new object[]{1,1.00002f}}.ToList()}}}});foreach(var spec in specs)spec.List("occluderPolygons").Add(quad);mappedRenderer.sharedMesh=expanded;
   var collapsed=new FaceEyes.ExposureProfile(mappedRenderer,recipe,sourceMesh);Require(collapsed.Compensate("Blink",basis.Concat(appended).ToArray(),blink.Concat(new Vector3[3]).ToArray()).Take(24).SequenceEqual(delta),"Exact source zero edge changed measured eye compensation");sourcePoints[27]=new object[]{-appended[2].x,appended[2].y+.0000001f,appended[2].z};Refuses(()=>{new FaceEyes.ExposureProfile(mappedRenderer,recipe,sourceMesh);},"surface coverage is incomplete");mappedRenderer.sharedMesh=imported;UnityEngine.Object.DestroyImmediate(expanded);
   UnityEngine.Object.DestroyImmediate(texture);UnityEngine.Object.DestroyImmediate(material);
   UnityEngine.Object.DestroyImmediate(holder);UnityEngine.Object.DestroyImmediate(imported);
   UnityEngine.Object.DestroyImmediate(root);UnityEngine.Object.DestroyImmediate(candidateRoot);UnityEngine.Object.DestroyImmediate(mesh);UnityEngine.Object.DestroyImmediate(changed);
  }
  static void Require(bool ok,string why){if(!ok)throw new Exception(why);checks++;}
  static void Refuses(Action action,string expected){try{action();}catch(Exception e){Require(e.Message.Contains(expected),"Wrong refusal: "+e);return;}throw new Exception("Expected refusal: "+expected);}
  public static void RunUvChecks(){try{AdditiveChecks();Avh.WriteJson(Avh.Abs("uv-result.json"),new Dictionary<string,object>{{"ok",true},{"checks",checks}});EditorApplication.Exit(0);}catch(Exception e){Avh.WriteJson(Avh.Abs("uv-result.json"),new Dictionary<string,object>{{"ok",false},{"checks",checks},{"error",e.ToString()}});EditorApplication.Exit(1);}}
  public static void Seed(){try{
   var path="Assets/Source/source.fbx";var importer=(ModelImporter)AssetImporter.GetAtPath(path);importer.isReadable=true;importer.importAnimation=false;importer.importBlendShapeNormals=ModelImporterNormals.None;importer.SaveAndReimport();
   var go=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(path));go.GetComponentsInChildren<SkinnedMeshRenderer>(true).Single(r=>r.name=="Face").SetBlendShapeWeight(0,30);PrefabUtility.SaveAsPrefabAsset(go,"Assets/Source/avatar.prefab");UnityEngine.Object.DestroyImmediate(go);
   Avh.WriteJson(Avh.Abs(FaceStage.ObservationPath),FaceStage.ObserveSource("Assets/Source/avatar.prefab"));EditorApplication.Exit(0);
  }catch(Exception e){Debug.LogException(e);EditorApplication.Exit(1);}}
  public static void Run(){try{
   AdditiveChecks();
   var observation=Avh.ReadJsonFile(Avh.Abs(FaceStage.ObservationPath));var target=observation.List("targets").Cast<Dictionary<string,object>>().Single(t=>t.Str("rendererPath").EndsWith("Face",StringComparison.Ordinal));
   var catalog=Avh.ReadJsonFile(Avh.Abs("Assets/_Harness/Face/catalog.json"));var keys=catalog.List("meshes").Cast<Dictionary<string,object>>().Single(m=>m.Str("objectName")=="Face").List("keys").Cast<Dictionary<string,object>>().Skip(1);
   var input=new Dictionary<string,object>{{"schema","face-unity-design/0.1"},{"route","native-fbx/1"},{"mode","design"},{"observationSha256",FaceStage.FileHash(FaceStage.ObservationPath)},{"targetId",target.Str("targetId")},{"keyMap",keys.ToDictionary(k=>k.Str("name"),k=>(object)k.Str("id"))}};
   foreach(var row in new[]{new[]{"blenderCatalog","Assets/_Harness/Face/catalog.json"},new[]{"blenderDesign","Assets/_Harness/Face/design-input.json"},new[]{"candidateReceipt","Assets/_Harness/Face/Candidates/test/candidate.json"},new[]{"blenderVerification","Assets/_Harness/Face/readback.json"}})input[row[0]]=new Dictionary<string,object>{{"file",row[1]},{"sha256",FaceStage.FileHash(row[1])}};
   Avh.WriteJson(Avh.Abs(FaceStage.InputPath),input);var source=FaceStage.FileHash("Assets/Source/source.fbx");var meta=FaceStage.FileHash("Assets/Source/source.fbx.meta");
   var output=FaceStage.ApplyManaged();Require(FaceStage.VerifyOutput(output,new List<string>()),"Independent native output failed");
   Require(Math.Abs(AssetDatabase.LoadAssetAtPath<GameObject>(output).GetComponentsInChildren<SkinnedMeshRenderer>(true).Single(r=>r.name=="Other").GetBlendShapeWeight(0)-65)<1e-4,"Non-target inherited FBX default disappeared");
   var attachmentBefore=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Source/avatar.prefab"));
   var attachmentAfter=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(output));
   try{
    var face=attachmentAfter.GetComponentsInChildren<SkinnedMeshRenderer>(true).Single(r=>r.name=="Face");
    var other=attachmentAfter.GetComponentsInChildren<SkinnedMeshRenderer>(true).Single(r=>r.name=="Other");
    var attachment=UnityEngine.Object.Instantiate(face.sharedMesh);var points=attachment.vertices;var indices=attachment.triangles;var normal=Vector3.Cross(points[indices[1]]-points[indices[0]],points[indices[2]]-points[indices[0]]).normalized;
    attachment.vertices=points.Select(v=>v+normal*.0002f).ToArray();other.sharedMesh=attachment;for(var i=0;i<attachment.blendShapeCount;i++)other.SetBlendShapeWeight(i,0);
    var report=FaceStage.InspectHeadAttachments(attachmentBefore,attachmentAfter,target,face.sharedMesh.vertices);
    Require(Convert.ToInt32(report["changedFaceVertices"])>0,"Head recheck did not observe actual changed face vertices");
    var rows=report.List("renderers").Cast<Dictionary<string,object>>().ToArray();Require(rows.Length>0&&rows.Any(row=>Convert.ToDouble(row["minimumAfterMm"])<.5),"Head recheck omitted real nearby attachment triangle distances");
    Require(Equals(report["productionAccepted"],false),"Attachment proximity claimed appearance acceptance");UnityEngine.Object.DestroyImmediate(attachment);
   }finally{UnityEngine.Object.DestroyImmediate(attachmentBefore);UnityEngine.Object.DestroyImmediate(attachmentAfter);}
   var candidatePath="Assets/_Harness/Face/Candidates/test/candidate.fbx";var copiedImporter=(ModelImporter)AssetImporter.GetAtPath(candidatePath);Require(copiedImporter.importBlendShapeNormals==ModelImporterNormals.None,"Candidate lost actual source blend-shape normal settings");
   var candidateMeta=File.ReadAllText(Avh.Abs(candidatePath+".meta"));var candidateGuid=AssetDatabase.AssetPathToGUID(candidatePath);var sourceGuid=AssetDatabase.AssetPathToGUID("Assets/Source/source.fbx");Require(candidateGuid!=sourceGuid&&candidateMeta.Replace("guid: "+candidateGuid,"guid: "+sourceGuid)==File.ReadAllText(Avh.Abs("Assets/Source/source.fbx.meta")),"Candidate did not copy complete metadata while retaining its own GUID");
   var verification=Avh.ReadJsonFile(Avh.Abs("Assets/_Harness/Face/readback.json"));var saved=File.ReadAllBytes(Avh.Abs("Assets/_Harness/Face/readback.json"));verification.Obj("compensation").List("quality").RemoveAt(0);Avh.WriteJson(Avh.Abs("Assets/_Harness/Face/readback.json"),verification);input.Obj("blenderVerification")["sha256"]=FaceStage.FileHash("Assets/_Harness/Face/readback.json");Avh.WriteJson(Avh.Abs(FaceStage.InputPath),input);
   Refuses(()=>FaceStage.ApplyManaged(),"state coverage is incomplete");File.WriteAllBytes(Avh.Abs("Assets/_Harness/Face/readback.json"),saved);input.Obj("blenderVerification")["sha256"]=FaceStage.FileHash("Assets/_Harness/Face/readback.json");Avh.WriteJson(Avh.Abs(FaceStage.InputPath),input);
   var mesh=AssetDatabase.LoadAssetAtPath<GameObject>(output).GetComponentsInChildren<SkinnedMeshRenderer>(true).Single(r=>r.name=="Face").sharedMesh;Require(AssetDatabase.GetAssetPath(mesh).EndsWith("/candidate.fbx")&&!File.Exists(Path.Combine(Path.GetDirectoryName(Avh.Abs(output)),"FaceMesh.asset")),"Output still creates a detached mesh asset");Require(mesh.blendShapeCount==2&&mesh.GetBlendShapeName(0)=="Contour","Native key slots were removed/reordered");Require(AssetDatabase.LoadAssetAtPath<GameObject>(output).GetComponentsInChildren<SkinnedMeshRenderer>(true).Single(r=>r.sharedMesh==mesh).GetBlendShapeWeight(0)==0,"Baked source default was applied twice");
   NativeImportFault.DefaultDrift=true;Refuses(()=>FaceStage.ApplyManaged(),"non-target default shape weights");NativeImportFault.DefaultDrift=false;
   NativeImportFault.UvDrift=true;Refuses(()=>FaceStage.ApplyManaged(),"correspondence");NativeImportFault.UvDrift=false;
   NativeImportFault.BindposeOffset=.02f;Refuses(()=>FaceStage.ApplyManaged(),"skinning effect");NativeImportFault.BindposeOffset=0;
   Require(source==FaceStage.FileHash("Assets/Source/source.fbx")&&meta==FaceStage.FileHash("Assets/Source/source.fbx.meta"),"Failed import did not restore source and metadata");Require(!File.Exists(Avh.Abs("_harness/face/native-import-pending.json")),"Completed transaction remained pending");
   var vertices=mesh.vertices;vertices[0]+=Vector3.one*.01f;mesh.vertices=vertices;EditorUtility.SetDirty(mesh);AssetDatabase.SaveAssets();Require(!FaceStage.VerifyOutput(output,new List<string>()),"Changed generated mesh accepted");
   Avh.WriteJson(Avh.Abs("native-result.json"),new Dictionary<string,object>{{"ok",true},{"checks",checks},{"productionAccepted",false}});EditorApplication.Exit(0);
  }catch(Exception e){Avh.WriteJson(Avh.Abs("native-result.json"),new Dictionary<string,object>{{"ok",false},{"checks",checks},{"error",e.ToString()}});Debug.LogException(e);EditorApplication.Exit(1);}}
 }
}
