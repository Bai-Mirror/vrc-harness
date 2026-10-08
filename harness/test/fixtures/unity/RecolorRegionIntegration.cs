using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
 /// <summary>
 /// A real editor, a real skinned mesh and real textures. Two UV islands weighted to two bones on a small sheet,
 /// plus a large sheet whose importer caps it at half its file size, on which two triangles are critical: one
 /// whose edge function changes sign between float32 and float64, and one with zero area. This is the only place
 /// where the masks come from Unity's own imported UVs and skin weights rather than from a fixture's idea of them.
 /// </summary>
 public static class RecolorRegionIntegration
 {
  static int assertions;
  static void Require(bool ok,string message){assertions++;if(!ok)throw new Exception(message);}
  static void Refuses(Action action,string pattern){try{action();}catch(Exception e){Require(e.Message.Contains(pattern),e.Message);return;}throw new Exception("Expected refusal: "+pattern);}
  static Material Mat(string path,Texture texture){OutfitStage.EnsureFolder(Path.GetDirectoryName(path).Replace('\\','/'));var mat=new Material(Shader.Find("Standard"));mat.SetTexture("_MainTex",texture);AssetDatabase.CreateAsset(mat,path);return mat;}

  static Dictionary<string,object> recipe;
  static Mesh mesh;
  static Texture2D eyes;
  static Material eyesMaterial;
  static Material bigMaterial;
  static Material shadeMaterial;
  static Material gradMaterial;
  static string importedFbxPath;
  static string importedFbxRendererPath;
  static bool transformOverrideApplied;
  // The critical triangle, found by searching for a pixel whose verdict differs between float32 and float64
  // edge arithmetic at 4096 square: float32 gives the first edge function exactly 0 (inside), float64 gives
  // -8.08e-14 (outside). Its float64 footprint is 1225 pixels.
  static readonly Vector2[] Critical = { new Vector2(0.4486248195171356f,0.48762163519859314f),
   new Vector2(0.4557804465293884f,0.48601654171943665f), new Vector2(0.4540664255619049f,0.5068144202232361f) };
  static readonly int CriticalPixels = 1225;
  static readonly int CriticalX = 1854, CriticalY = 1993;      // GetPixel32 coordinates: y from the bottom
  static readonly Vector2 Degenerate = new Vector2(0.2f,0.2f);
  static readonly int DegenerateX0 = 818, DegenerateX1 = 819, DegenerateY0 = 818, DegenerateY1 = 819;

  static Dictionary<string,object> Region(string renderer,string id,string[] bones,string color)=>new Dictionary<string,object>{
   ["requirement_id"]=id,
   ["region"]=new Dictionary<string,object>{["renderer"]=renderer,["submesh"]=0,["bones"]=bones.Cast<object>().ToList()},
   ["color"]=color,["semantics"]="flat"};
  /// <summary>The other promise: the author's light and shade survive as a shading of the target colour. Its
  /// declared expression is target x (pixel's brightest channel / target's brightest channel), so the product
  /// is neither the target nor the original — a flat fixture cannot tell those two apart (R6b 第 1 项).</summary>
  static Dictionary<string,object> ShadeRegion(string renderer,string id,string[] bones,string color){
   var region=Region(renderer,id,bones,color);region["semantics"]="shade";return region;}
  static void SetRegions(params Dictionary<string,object>[] ops){
   recipe["regionOps"]=ops.Cast<object>().ToList();
   Avh.WriteJson(Avh.Abs(RecolorStage.RecipePath),recipe);
   var plan=new Dictionary<string,object>{["recolor"]=new Dictionary<string,object>{
    ["candidates"]=1,["targets"]=ops.Cast<object>().ToList()}};
   Avh.WriteJson(Avh.Abs("fixture-plan.json"),plan);
   Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(plan));}

  /// <summary>Fourteen vertices: two islands, one triangle whose float32 and float64 verdicts differ, and one
  /// triangle with zero area that would otherwise fill its whole bounding box.</summary>
  static Mesh RegionMesh(){
   var created=new Mesh{name="RegionBody"};
   var left=new[]{(0.125f,0.625f),(0.375f,0.625f),(0.375f,0.875f),(0.125f,0.875f)};
   var right=left.Select(corner=>(corner.Item1+0.5f,corner.Item2)).ToArray();
   var corners=left.Concat(right)
     .Concat(Critical.Select(corner=>(corner.x,corner.y)))
     .Concat(new[]{Degenerate,Degenerate,Degenerate}.Select(corner=>(corner.x,corner.y))).ToArray();
   created.vertices=corners.Select(corner=>new Vector3(corner.Item1,corner.Item2,0)).ToArray();
   created.uv=corners.Select(corner=>new Vector2(corner.Item1,corner.Item2)).ToArray();
   created.triangles=new[]{0,1,2,0,2,3,4,5,6,4,6,7,8,9,10,11,12,13};
   var weights=new BoneWeight[corners.Length];
   for(var vertex=0;vertex<weights.Length;vertex++)weights[vertex]=new BoneWeight{boneIndex0=vertex<4?0:vertex<8?1:2,weight0=1f};
   created.boneWeights=weights;
   created.bindposes=new[]{Matrix4x4.identity,Matrix4x4.identity,Matrix4x4.identity};
   created.RecalculateBounds();
   AssetDatabase.CreateAsset(created,"Assets/Authorized/RegionBody.asset");
   return created;
  }

  /// <summary>Two islands on **the same** UV area, one bone each: what a mirrored pair of parts looks like.
  /// The two regions cannot be told apart on the texture, so the stage has to refuse rather than paint both.</summary>
  static Mesh MirrorMesh(){
   var created=new Mesh{name="MirrorBody"};
   var islandUv=new[]{(0.125f,0.625f),(0.375f,0.625f),(0.375f,0.875f),(0.125f,0.875f)};
   created.vertices=islandUv.Concat(islandUv).Select(corner=>new Vector3(corner.Item1,corner.Item2,0)).ToArray();
   created.uv=islandUv.Concat(islandUv).Select(corner=>new Vector2(corner.Item1,corner.Item2)).ToArray();
   created.triangles=new[]{0,1,2,0,2,3,4,5,6,4,6,7};
   var weights=new BoneWeight[8];
   for(var vertex=0;vertex<8;vertex++)weights[vertex]=new BoneWeight{boneIndex0=vertex<4?0:1,weight0=1f};
   created.boneWeights=weights;
   created.bindposes=new[]{Matrix4x4.identity,Matrix4x4.identity,Matrix4x4.identity};
   created.RecalculateBounds();
   AssetDatabase.CreateAsset(created,"Assets/Authorized/MirrorBody.asset");
   return created;
  }

  static Mesh OneIslandMesh(string path){
   var created=new Mesh{name="OneIsland"};
   var islandUv=new[]{(0.125f,0.625f),(0.375f,0.625f),(0.375f,0.875f),(0.125f,0.875f)};
   created.vertices=islandUv.Select(corner=>new Vector3(corner.Item1,corner.Item2,0)).ToArray();
   created.uv=islandUv.Select(corner=>new Vector2(corner.Item1,corner.Item2)).ToArray();
   created.triangles=new[]{0,1,2,0,2,3};
   var weights=new BoneWeight[4];
   for(var vertex=0;vertex<4;vertex++)weights[vertex]=new BoneWeight{boneIndex0=0,weight0=1f};
   created.boneWeights=weights;
   created.bindposes=new[]{Matrix4x4.identity,Matrix4x4.identity,Matrix4x4.identity};
   created.RecalculateBounds();
   AssetDatabase.CreateAsset(created,path);
   return created;
  }

  /// <summary>Change a renderer in the prefab the stage actually reads: it instantiates the outfit layer fresh on
  /// every run, so a change made to an in-scene object would never be seen.</summary>
  static void Patch(string path,Action<SkinnedMeshRenderer> change){
   var root=PrefabUtility.LoadPrefabContents(OutfitStage.AvatarPath);
   try{
    change(root.transform.Find(path).GetComponent<SkinnedMeshRenderer>());
    PrefabUtility.SaveAsPrefabAsset(root,OutfitStage.AvatarPath);
   }finally{PrefabUtility.UnloadPrefabContents(root);}
  }

  /// <summary>A sheet whose islands carry four known shades, so a shaded product is compared against values
  /// worked out by hand instead of against a second copy of the expression under test.</summary>
  static readonly (int x,int y,Color32 color)[] Gradient={
   (1,5,new Color32(10,20,200,255)),(2,5,new Color32(60,80,150,255)),
   (1,6,new Color32(110,140,100,255)),(2,6,new Color32(160,200,50,255))};

  static Texture2D GradSheet(string asset){
   var sheet=new Texture2D(8,8,TextureFormat.RGBA32,false);
   var pixels=new Color32[64];
   for(var index=0;index<pixels.Length;index++)pixels[index]=new Color32(10,20,200,255);
   foreach(var (x,y,color) in Gradient){pixels[y*8+x]=color;pixels[y*8+x+4]=color;}
   sheet.SetPixels32(pixels);sheet.Apply();
   OutfitStage.EnsureFolder("Assets/Authorized");
   File.WriteAllBytes(Avh.Abs(asset),sheet.EncodeToPNG());
   UnityEngine.Object.DestroyImmediate(sheet);
   AssetDatabase.ImportAsset(asset);
   return AssetDatabase.LoadAssetAtPath<Texture2D>(asset);
  }

  /// <summary>Asserts one pixel the region covers carries exactly this colour: the shade values are literals
  /// worked out from the stated expression, which is the only way the fixture itself can be wrong about them.</summary>
  static void RequirePixel(Color32[] product,Texture2D mask,int x,int y,Color32 expected,string what){
   var index=y*mask.width+x;
   if(mask.GetPixels32()[index].r==0){Require(false,what+" does not cover ("+x+","+y+")");return;}
   var pixel=product[index];
   Require(pixel.r==expected.r&&pixel.g==expected.g&&pixel.b==expected.b,
    what+": ("+x+","+y+") should be ("+expected.r+","+expected.g+","+expected.b+"), got ("+pixel.r+","+pixel.g+","+pixel.b+")");
  }

  static Texture2D Sheet(string asset,int size,bool paintIslands){
   var sheet=new Texture2D(size,size,TextureFormat.RGBA32,false);
   var pixels=new Color32[size*size];
   for(var index=0;index<pixels.Length;index++)pixels[index]=new Color32(10,20,200,255);
   if(paintIslands)
   {
    // The painted part of the small sheet is the two islands, so "nothing outside the region moved" is a real
    // reading. Unity's pixel rows are numbered from the bottom, and the islands sit at v 0.625–0.875, rows 5,6.
    foreach(var x in new[]{1,2})foreach(var y in new[]{5,6}){pixels[y*8+x]=new Color32(200,180,160,255);pixels[y*8+x+4]=new Color32(200,180,160,255);}
   }
   sheet.SetPixels32(pixels);sheet.Apply();
   OutfitStage.EnsureFolder("Assets/Authorized");
   File.WriteAllBytes(Avh.Abs(asset),sheet.EncodeToPNG());
   UnityEngine.Object.DestroyImmediate(sheet);
   AssetDatabase.ImportAsset(asset);
   return AssetDatabase.LoadAssetAtPath<Texture2D>(asset);
  }

  /// <summary>A sheet whose file is 4096 square while its importer caps it at 2048. The mask has to be derived
  /// from the file, and the product then has to inherit the cap.</summary>
  static Texture2D BigSheet(){
   const int size=4096;
   var imported=Sheet("Assets/Authorized/big.png",size,false);
   var importer=(TextureImporter)AssetImporter.GetAtPath("Assets/Authorized/big.png");
   importer.maxTextureSize=2048;importer.SaveAndReimport();
   imported=AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Authorized/big.png");
   Require(imported.width==2048&&imported.height==2048,"the fixture's big sheet must import at 2048, got "+imported.width+"x"+imported.height);
   var file=new Texture2D(2,2,TextureFormat.RGBA32,false);
   var decoded=ImageConversion.LoadImage(file,File.ReadAllBytes(Avh.Abs("Assets/Authorized/big.png")));
   Require(decoded&&file.width==size&&file.height==size,"the fixture's big sheet must be 4096 on disk, got "+(decoded?file.width:0));
   UnityEngine.Object.DestroyImmediate(file);
   return imported;
  }

  static Texture2D Load(string path){
   var texture=new Texture2D(2,2,TextureFormat.RGBA32,false);
   if(!ImageConversion.LoadImage(texture,File.ReadAllBytes(Avh.Abs(path))))throw new Exception("Cannot decode "+path);
   return texture;
  }

  static void AddRealFbx(GameObject group,Transform avatarRoot,Transform[] bones){
   var source=Directory.GetFiles(Avh.Abs("Packages"),"*.fbx",SearchOption.AllDirectories)
    .FirstOrDefault(path=>Path.GetFileName(path).Contains("Tutorial_Robot_Avatar_Dynamics_Demo_v1"))
    ?? Directory.GetFiles(Avh.Abs("Packages"),"*.fbx",SearchOption.AllDirectories).FirstOrDefault();
   if(string.IsNullOrEmpty(source))throw new Exception("The baseline must provide a real FBX model");
   importedFbxPath="Assets/Authorized/ImportedModel.fbx";
   File.Copy(source,Avh.Abs(importedFbxPath),true);
   AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
   var model=AssetDatabase.LoadAssetAtPath<GameObject>(importedFbxPath);
   if(model==null)throw new Exception("The copied FBX did not import as a model");
   var instance=(GameObject)PrefabUtility.InstantiatePrefab(model);
   instance.name="ImportedModel";instance.transform.SetParent(group.transform,false);
   var renderer=instance.GetComponentsInChildren<SkinnedMeshRenderer>(true).FirstOrDefault(candidate=>candidate.sharedMesh!=null);
   if(renderer==null)throw new Exception("The real FBX must inherit a readable SkinnedMeshRenderer");
   renderer.sharedMesh=mesh;renderer.bones=bones;renderer.rootBone=bones[0];renderer.sharedMaterials=new[]{eyesMaterial};
   importedFbxRendererPath=Probe.HierarchyPath(avatarRoot,renderer.transform);
  }

  /// <summary>The stage renders candidates, and a portrait needs a humanoid rig: Head and LeftFoot must resolve.</summary>
  static GameObject Human(){
   var root=new GameObject("Avatar");var bones=new List<HumanBone>();var skeleton=new List<SkeletonBone>();
   skeleton.Add(new SkeletonBone{name=root.name,position=Vector3.zero,rotation=Quaternion.identity,scale=Vector3.one});
   Func<string,string,Transform,Vector3,Transform> add=(name,human,parent,pos)=>{var b=new GameObject(name).transform;b.SetParent(parent,false);b.localPosition=pos;
    bones.Add(new HumanBone{boneName=name,humanName=human,limit=new HumanLimit{useDefaultValues=true}});
    skeleton.Add(new SkeletonBone{name=name,position=pos,rotation=Quaternion.identity,scale=Vector3.one});return b;};
   var hips=add("Hips","Hips",root.transform,new Vector3(0,1,0));var spine=add("Spine","Spine",hips,new Vector3(0,0.2f,0));
   var chest=add("Chest","Chest",spine,new Vector3(0,0.2f,0));var neck=add("Neck","Neck",chest,new Vector3(0,0.2f,0));add("Head","Head",neck,new Vector3(0,0.15f,0));
   foreach(var side in new[]{"Left","Right"}){float sign=side=="Left"?-1:1;var leg=add(side+"UpperLeg",side+"UpperLeg",hips,new Vector3(sign*0.1f,-0.1f,0));
    var knee=add(side+"LowerLeg",side+"LowerLeg",leg,new Vector3(0,-0.4f,0));add(side+"Foot",side+"Foot",knee,new Vector3(0,-0.4f,0.05f));
    var arm=add(side+"UpperArm",side+"UpperArm",chest,new Vector3(sign*0.2f,0.1f,0));var elbow=add(side+"LowerArm",side+"LowerArm",arm,new Vector3(sign*0.3f,0,0));
    add(side+"Hand",side+"Hand",elbow,new Vector3(sign*0.25f,0,0));}
   var human=AvatarBuilder.BuildHumanAvatar(root,new HumanDescription{human=bones.ToArray(),skeleton=skeleton.ToArray(),upperArmTwist=0.5f,lowerArmTwist=0.5f,
    upperLegTwist=0.5f,lowerLegTwist=0.5f,armStretch=0.05f,legStretch=0.05f,feetSpacing=0});
   if(!human.isValid||!human.isHuman)throw new Exception("Invalid fixture humanoid");
   AssetDatabase.CreateAsset(human,"Assets/Authorized/FixtureAvatar.asset");root.AddComponent<Animator>().avatar=human;return root;}

  static Dictionary<string,object> Group(string renderer){
   var record=Avh.ReadJsonFile(Avh.Abs(RecolorStage.RegionApplyPath));
   return record.List("groups").Cast<Dictionary<string,object>>().First(group=>group.Str("renderer")==renderer);
  }

  static void FinishDamage(string kind,Action mutate){
   try{
    mutate();AssetDatabase.SaveAssets();AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
    RecolorStage.MaterialTargetReadback();
    Avh.WriteJson(Avh.Abs("damage-result.json"),new Dictionary<string,object>{{"ok",true},{"variant",kind},{"transformOverride",transformOverrideApplied}});
    EditorApplication.Exit(0);
   }catch(Exception e){
    Avh.WriteJson(Avh.Abs("damage-result.json"),new Dictionary<string,object>{{"ok",false},{"variant",kind},{"error",e.ToString()}});
    Debug.LogException(e);EditorApplication.Exit(1);
   }
  }

  // Start from the passing output variant, then retarget its material slot override to the same object's
  // Transform. Unity serializes the exact m_Materials.Array.data[0] target, so this is the malformed identity
  // that a YAML-only fallback used to accept.
  public static void DamageTransform(){FinishDamage("transform",()=>{
   var passing=AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath);
   var passingRenderer=passing.transform.Find(FirstRegionRenderer()).GetComponent<Renderer>();
   var source=AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath);
   var instance=(GameObject)PrefabUtility.InstantiatePrefab(source);
   var renderer=instance.transform.Find(FirstRegionRenderer()).GetComponent<Renderer>();
   var passingMaterial=passingRenderer.sharedMaterials[0];
   if(passingMaterial==null)throw new Exception("The passing variant has no produced material");
   renderer.sharedMaterials=new[]{passingMaterial};
   PrefabUtility.RecordPrefabInstancePropertyModifications(renderer);
   var modifications=PrefabUtility.GetPropertyModifications(instance) ?? Array.Empty<PropertyModification>();
   var material=modifications.FirstOrDefault(modification=>modification.propertyPath=="m_Materials.Array.data[0]");
   if(material==null)throw new Exception("The passing material override was not serialized");
   material.target=renderer.transform;
   PrefabUtility.SetPropertyModifications(instance,modifications);
   transformOverrideApplied=material.target==renderer.transform;
   Require(transformOverrideApplied,"The damage must target the renderer's own Transform");
   var variant="Assets/Authorized/TransformOverride.prefab";
   PrefabUtility.SaveAsPrefabAssetAndConnect(instance,variant,InteractionMode.AutomatedAction);
   UnityEngine.Object.DestroyImmediate(instance);
   AssetDatabase.DeleteAsset(RecolorStage.AvatarPath);AssetDatabase.CopyAsset(variant,RecolorStage.AvatarPath);
  });}

  static string FirstRegionRenderer(){
   var plan=Avh.ReadJsonFile(Avh.Abs("fixture-plan.json"));
   var recolor=(Dictionary<string,object>)plan["recolor"];
   var target=(Dictionary<string,object>)recolor.List("targets")[0];
   return ((Dictionary<string,object>)target["region"]).Str("renderer");
  }

  // Add a real Renderer to the final prefab and give it the produced material. It has no region ledger row, so
  // the complete actual surface set must differ from the declaration and the formal gate must refuse it.
  public static void DamageExtraSurface(){FinishDamage("extra-surface",()=>{
   var root=PrefabUtility.LoadPrefabContents(RecolorStage.AvatarPath);
   try{
    var body=root.transform.Find(FirstRegionRenderer()).GetComponent<SkinnedMeshRenderer>();
    var extra=new GameObject("UnledgeredSurface");extra.transform.SetParent(root.transform.Find("_Outfit"),false);
    var renderer=extra.AddComponent<SkinnedMeshRenderer>();renderer.sharedMesh=body.sharedMesh;renderer.bones=body.bones;
    renderer.rootBone=body.rootBone;
    var output=AssetDatabase.LoadAssetAtPath<Texture2D>(Group(FirstRegionRenderer()).Str("outputAsset"));
    var material=AssetDatabase.FindAssets("t:Material",new[]{RecolorStage.MaterialDir}).Select(guid=>AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(guid)))
      .FirstOrDefault(candidate=>candidate!=null&&candidate.GetTexture("_MainTex")==output);
    if(material==null)throw new Exception("The extra-surface damage could not find the produced material");
    renderer.sharedMaterials=new[]{material};
    PrefabUtility.SaveAsPrefabAsset(root,RecolorStage.AvatarPath);
   }finally{PrefabUtility.UnloadPrefabContents(root);}
  });}

  // A renderable ParticleSystemRenderer uses a produced region texture without a ledger entry. The final
  // Unity readback must enumerate it and the published observer must refuse the complete output set.
  public static void DamageParticleSurface(){FinishDamage("particle-surface",()=>{
   var root=PrefabUtility.LoadPrefabContents(RecolorStage.AvatarPath);
   try{
    var extra=new GameObject("UnledgeredParticle");extra.transform.SetParent(root.transform.Find("_Outfit"),false);
    var particle=extra.AddComponent<ParticleSystem>();var settings=particle.main;settings.maxParticles=1;settings.startLifetime=10;settings.startSize=1;
    var renderer=extra.GetComponent<ParticleSystemRenderer>();
    var output=AssetDatabase.LoadAssetAtPath<Texture2D>(Group(FirstRegionRenderer()).Str("outputAsset"));
    var material=AssetDatabase.FindAssets("t:Material",new[]{RecolorStage.MaterialDir}).Select(guid=>AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(guid)))
      .FirstOrDefault(candidate=>candidate!=null&&candidate.GetTexture("_MainTex")==output);
    if(material==null)throw new Exception("The particle damage could not find the produced material");
    renderer.sharedMaterial=material;renderer.renderMode=ParticleSystemRenderMode.Billboard;
    PrefabUtility.SaveAsPrefabAsset(root,RecolorStage.AvatarPath);
   }finally{PrefabUtility.UnloadPrefabContents(root);}
  });}

  public static void Run(){try{
   UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene,UnityEditor.SceneManagement.NewSceneMode.Single);
   foreach(var path in new[]{"Assets/Authorized","Assets/_Harness/Outfit",RecolorStage.Dir})if(AssetDatabase.IsValidFolder(path))AssetDatabase.DeleteAsset(path);
   OutfitStage.EnsureFolder("Assets/Authorized");OutfitStage.EnsureFolder("Assets/_Harness/Outfit");OutfitStage.EnsureFolder(RecolorStage.Dir);
   eyes=Sheet("Assets/Authorized/eyes.png",8,true);
   eyesMaterial=Mat("Assets/Authorized/eyes.mat",eyes);
   bigMaterial=Mat("Assets/Authorized/big.mat",BigSheet());
   // Two more surfaces on their own sheets, both shaded rather than flat: one of a single author colour, one a
   // gradient. A fixture that only ever asked for a flat region never exercised the other promise at all.
   shadeMaterial=Mat("Assets/Authorized/shade.mat",Sheet("Assets/Authorized/shade.png",8,true));
   gradMaterial=Mat("Assets/Authorized/grad.mat",GradSheet("Assets/Authorized/grad.png"));
   var avatar=Human();
   var group=new GameObject(OutfitStage.Group);group.transform.SetParent(avatar.transform,false);
   var body=new GameObject("Body");body.transform.SetParent(group.transform,false);
   var eyeLeft=new GameObject("eye.L");eyeLeft.transform.SetParent(body.transform,false);
   var eyeRight=new GameObject("eye.R");eyeRight.transform.SetParent(body.transform,false);
   var eyeCritical=new GameObject("eye.C");eyeCritical.transform.SetParent(body.transform,false);
   var bones=new[]{eyeLeft.transform,eyeRight.transform,eyeCritical.transform};
   mesh=RegionMesh();
   var skin=body.AddComponent<SkinnedMeshRenderer>();
   skin.sharedMesh=mesh;skin.bones=bones;skin.rootBone=body.transform;skin.sharedMaterials=new[]{eyesMaterial};
   var big=new GameObject("Big");big.transform.SetParent(group.transform,false);
   var bigSkin=big.AddComponent<SkinnedMeshRenderer>();
   bigSkin.sharedMesh=mesh;bigSkin.bones=bones;bigSkin.rootBone=big.transform;bigSkin.sharedMaterials=new[]{bigMaterial};
   foreach(var pair in new[]{(name:"Shade",material:shadeMaterial),(name:"Grad",material:gradMaterial)}){
    var holder=new GameObject(pair.name);holder.transform.SetParent(group.transform,false);
    var holderSkin=holder.AddComponent<SkinnedMeshRenderer>();
    holderSkin.sharedMesh=mesh;holderSkin.bones=bones;holderSkin.rootBone=holder.transform;
    holderSkin.sharedMaterials=new[]{pair.material};
   }
   AddRealFbx(group,avatar.transform,bones);
   PrefabUtility.SaveAsPrefabAsset(avatar,OutfitStage.AvatarPath);UnityEngine.Object.DestroyImmediate(avatar);
   Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath),new Dictionary<string,object>{["group"]=OutfitStage.Group,["outfits"]=new List<object>()});
   AssetDatabase.Refresh();AssetDatabase.SaveAssets();
   var sourceBytes=File.ReadAllBytes(Avh.Abs("Assets/Authorized/eyes.png"));
   var materialBytes=File.ReadAllBytes(Avh.Abs("Assets/Authorized/eyes.mat"));
   recipe=new Dictionary<string,object>{["targets"]=new List<object>(),["chosen"]="A",["reason"]="fixture",
    ["tiers"]=new List<object>{new Dictionary<string,object>{["id"]="A",["adjustments"]=new List<object>()}}};

   // What has to refuse first, so the last run of the stage is the good one and the observer reads a good project.
   // Two regions on the same bone, a bone that is not on this mesh, a submesh that is not there, a renderer that
   // is not there, and two renderers on one source texture. None of them may quietly produce a shared mask or
   // settle the conflict by order.
   SetRegions(Region("_Outfit/Body","a",new[]{"eye.L"},"#3E6FD9"),Region("_Outfit/Body","b",new[]{"eye.L"},"#C8A24A"));
   Refuses(()=>RecolorStage.Produce(),"没有覆盖任何像素");
   SetRegions(Region("_Outfit/Body","a",new[]{"eye.LEFT"},"#3E6FD9"),Region("_Outfit/Body","b",new[]{"eye.R"},"#C8A24A"));
   Refuses(()=>RecolorStage.Produce(),"骨骼不在这个网格的骨骼里");
   SetRegions(new Dictionary<string,object>{["requirement_id"]="a",["region"]=new Dictionary<string,object>{
     ["renderer"]="_Outfit/Body",["submesh"]=4,["bones"]=new List<object>{"eye.L"}},["color"]="#3E6FD9",["semantics"]="flat"});
   Refuses(()=>RecolorStage.Produce(),"子网格超范围");
   SetRegions(new Dictionary<string,object>{["requirement_id"]="a",["region"]=new Dictionary<string,object>{
     ["renderer"]="_Outfit/Missing",["submesh"]=0,["bones"]=new List<object>{"eye.L"}},["color"]="#3E6FD9",["semantics"]="flat"});
   Refuses(()=>RecolorStage.Produce(),"找不到渲染器");
   // Two renderers on one source texture: the cross-renderer form of the same hazard. Each group's binding set
   // is every slot that reads its texture, so each one contains the other's surface, and the region was derived
   // from one mesh's triangles only. Refused as a combination, not settled by order (R6 第 5 项).
   Patch("_Outfit/Big",renderer=>renderer.sharedMaterials=new[]{eyesMaterial});
   SetRegions(Region("_Outfit/Body","a",new[]{"eye.L"},"#3E6FD9"),Region("_Outfit/Big","b",new[]{"eye.R"},"#C8A24A"));
   Refuses(()=>RecolorStage.Produce(),"还被别的表面用着");
   Patch("_Outfit/Big",renderer=>renderer.sharedMaterials=new[]{bigMaterial});

   // Two different bones whose triangles sit on the same UV area: the footprints are identical, so neither region
   // has a pixel of its own. This is the "mirrored part" shape and it is a different branch from "no pixels at
   // all" above — the regions are full, they simply cannot be told apart.
   Patch("_Outfit/Body",renderer=>renderer.sharedMesh=MirrorMesh());
   SetRegions(Region("_Outfit/Body","a",new[]{"eye.L"},"#3E6FD9"),Region("_Outfit/Body","b",new[]{"eye.R"},"#C8A24A"));
   Refuses(()=>RecolorStage.Produce(),"排他像素为 0");
   Patch("_Outfit/Body",renderer=>renderer.sharedMesh=mesh);

   // A mesh with Read/Write turned off: the region cannot be derived at all, so the stage must refuse rather than
   // hand back an empty mask that reads as "this eye has no pixels".
   var unreadable=OneIslandMesh("Assets/Authorized/Unreadable.asset");
   unreadable.UploadMeshData(true);
   EditorUtility.SetDirty(unreadable);AssetDatabase.SaveAssets();
   Require(!unreadable.isReadable,"the fixture must be able to make a mesh unreadable");
   Patch("_Outfit/Body",renderer=>renderer.sharedMesh=unreadable);
   SetRegions(Region("_Outfit/Body","a",new[]{"eye.L"},"#3E6FD9"));
   Refuses(()=>RecolorStage.Produce(),"网格不可读");
   Patch("_Outfit/Body",renderer=>renderer.sharedMesh=mesh);

   // A second material slot on the same renderer that reads the same texture: it is another surface, and the
   // region was derived from submesh 0's triangles only. Binding there would dye pixels nobody computed.
   mesh.subMeshCount=2;mesh.SetTriangles(new int[0],1);
   Patch("_Outfit/Body",renderer=>renderer.sharedMaterials=new[]{eyesMaterial,eyesMaterial});
   SetRegions(Region("_Outfit/Body","a",new[]{"eye.L"},"#3E6FD9"));
   Refuses(()=>RecolorStage.Produce(),"还被别的表面用着");
   mesh.subMeshCount=1;
   Patch("_Outfit/Body",renderer=>renderer.sharedMaterials=new[]{eyesMaterial});

   // Body exists only for the preflight damage cases; remove it from the accepted outfit before the real FBX
   // region is produced so it does not remain a second surface on that source texture.
   var accepted=PrefabUtility.LoadPrefabContents(OutfitStage.AvatarPath);
   try{
    UnityEngine.Object.DestroyImmediate(accepted.transform.Find("_Outfit/Body").GetComponent<SkinnedMeshRenderer>());
    PrefabUtility.SaveAsPrefabAsset(accepted,OutfitStage.AvatarPath);
   }finally{PrefabUtility.UnloadPrefabContents(accepted);}

   // The order's own shape: two irises on a small sheet, and the eye sheet that is larger than its import cap.
   // The shaded pair is the other promise on two different author colours: one uniform, one a gradient. Only a
   // real editor decides whether the stage's own output is the shading the declaration talks about (R6b 第 1 项).
   SetRegions(Region(importedFbxRendererPath,"eye_left",new[]{"eye.L"},"#3E6FD9"),
     Region(importedFbxRendererPath,"eye_right",new[]{"eye.R"},"#C8A24A"),
     Region("_Outfit/Big","eye_big",new[]{"eye.L"},"#3E6FD9"),
     Region("_Outfit/Big","eye_edge",new[]{"eye.C"},"#7A2E8C"),
     ShadeRegion("_Outfit/Shade","shade_left",new[]{"eye.L"},"#3E6FD9"),
     ShadeRegion("_Outfit/Shade","shade_right",new[]{"eye.R"},"#C8A24A"),
     ShadeRegion("_Outfit/Grad","grad_left",new[]{"eye.L"},"#3E6FD9"),
     ShadeRegion("_Outfit/Grad","grad_right",new[]{"eye.R"},"#C8A24A"));
   RecolorStage.Produce();
   // Exercise the shipped independent Unity reload/readback path, not only the fixture's own API checks.
   RecolorStage.MaterialTargetReadback();

   var record=Avh.ReadJsonFile(Avh.Abs(RecolorStage.RegionApplyPath));
   Require(record.Str("schema")==RecolorStage.RegionSchema,"Region apply record missing or wrong schema");
   var groups=record.List("groups").Cast<Dictionary<string,object>>().ToList();
   Require(groups.Count==4,"Four renderers with different textures are four groups, got "+groups.Count);
   var bodyGroup=Group(importedFbxRendererPath);
   var bigGroup=Group("_Outfit/Big");
   Require(bodyGroup.List("operations").Count==2&&bigGroup.List("operations").Count==2,"Both surfaces carry both of their regions");
   Require(Convert.ToInt32(bodyGroup["ambiguousPixels"])==0&&Convert.ToInt32(bodyGroup["conflictingTriangles"])==0,
     "Disjoint islands must report no ambiguity and no conflict");
   Require(Convert.ToInt32(bodyGroup["conflictPixels"])==0,"No conflicting triangle covers a pixel here");
   Require(bodyGroup.List("operations").Cast<Dictionary<string,object>>().All(op=>op.Str("renderer")==importedFbxRendererPath
     &&Convert.ToInt32(op["submesh"])==0),"each operation has to declare the surface it paints on, not only the group");
   var bodyOperations=bodyGroup.List("operations").Cast<Dictionary<string,object>>().ToList();
   var outputPath=bodyGroup.Str("outputAsset");
   Require(File.Exists(Avh.Abs(outputPath)),"The recoloured sheet was not written");
   var meshPath=bodyGroup.Str("meshAsset");
   Require(File.Exists(Avh.Abs(meshPath)),"The mesh datum the observer needs was not written");
   var datum=Avh.ReadJsonFile(Avh.Abs(meshPath));
   Require(datum.Str("schema")=="mesh-region-datum/0.1","Mesh datum schema");
   Require(datum.List("bones").Select(bone=>bone.ToString()).Contains("eye.C"),"The datum must carry every bone name");

   // The masks are the islands, and they are the pixels each region alone may paint.
   var leftMask=Load(bodyOperations[0].Str("maskAsset"));var rightMask=Load(bodyOperations[1].Str("maskAsset"));
   var leftPixels=leftMask.GetPixels32();var rightPixels=rightMask.GetPixels32();
   Require(leftPixels.Select((pixel,index)=>pixel.r>0&&rightPixels[index].r>0).Count(both=>both)==0,
     "The two region masks must not share a pixel");
   Require(leftPixels.Count(pixel=>pixel.r>0)==4,"The left island is four pixels, got "+leftPixels.Count(pixel=>pixel.r>0));
   Require(rightPixels.Count(pixel=>pixel.r>0)==4,"The right island is four pixels, got "+rightPixels.Count(pixel=>pixel.r>0));

   // The product: each region carries its own colour and nothing else on the sheet moved.
   var after=Load(outputPath).GetPixels32();
   var before=Load("Assets/Authorized/eyes.png").GetPixels32();
   var leftTarget=new Color32(0x3E,0x6F,0xD9,255);var rightTarget=new Color32(0xC8,0xA2,0x4A,255);
   var leftCount=0;var rightCount=0;var outside=0;
   for(var index=0;index<after.Length;index++){
    var insideLeft=leftPixels[index].r>0;var insideRight=rightPixels[index].r>0;
    if(insideLeft){if(after[index].r==leftTarget.r&&after[index].g==leftTarget.g&&after[index].b==leftTarget.b)leftCount++;}
    else if(insideRight){if(after[index].r==rightTarget.r&&after[index].g==rightTarget.g&&after[index].b==rightTarget.b)rightCount++;}
    else if(after[index].r!=before[index].r||after[index].g!=before[index].g||after[index].b!=before[index].b)outside++;
   }
   Require(leftCount==4,"The left iris must carry its own colour exactly, got "+leftCount);
   Require(rightCount==4,"The right iris must carry its own colour exactly, got "+rightCount);
   Require(outside==0,"Nothing outside the two regions may move, "+outside+" pixels did");
   var alphaMoved=0;for(var index=0;index<after.Length;index++)if(after[index].a!=before[index].a)alphaMoved++;
   Require(alphaMoved==0,"Alpha moved on "+alphaMoved+" pixels");

   // The shaded surfaces, against values worked out from the declared expression rather than from the code that
   // evaluates it. Uniform author colour (200,180,160) shaded to #3E6FD9 is (57,102,200) — a rescaled copy of
   // the author's own colour is (184,166,147), which is what a formula that scales the original would accept.
   var shadeGroup=Group("_Outfit/Shade");var gradGroup=Group("_Outfit/Grad");
   Require(shadeGroup.List("operations").Count==2&&gradGroup.List("operations").Count==2,"Both shaded surfaces carry both of their regions");
   var shadeOps=shadeGroup.List("operations").Cast<Dictionary<string,object>>().ToList();
   var gradOps=gradGroup.List("operations").Cast<Dictionary<string,object>>().ToList();
   var shadeMaskLeft=Load(shadeOps[0].Str("maskAsset"));var shadeMaskRight=Load(shadeOps[1].Str("maskAsset"));
   var shadeSheet=Load(shadeGroup.Str("outputAsset")).GetPixels32();
   var shadeOriginal=Load("Assets/Authorized/shade.png").GetPixels32();
   RequirePixel(shadeSheet,shadeMaskLeft,1,5,new Color32(57,102,200,255),"the left shade region");
   RequirePixel(shadeSheet,shadeMaskRight,5,5,new Color32(200,162,74,255),"the right shade region");
   var shadeOutside=0;
   for(var index=0;index<shadeSheet.Length;index++)
    if(shadeMaskLeft.GetPixels32()[index].r==0&&shadeMaskRight.GetPixels32()[index].r==0
      &&(shadeSheet[index].r!=shadeOriginal[index].r||shadeSheet[index].g!=shadeOriginal[index].g||shadeSheet[index].b!=shadeOriginal[index].b))shadeOutside++;
   Require(shadeOutside==0,"Nothing outside the shaded regions may move, "+shadeOutside+" pixels did");
   // The gradient, pixel by pixel: the author's brightness decides how much of the target each pixel gets, so
   // every pixel of one region is a different colour and none of them is the flat target.
   var gradMaskLeft=Load(gradOps[0].Str("maskAsset"));var gradMaskRight=Load(gradOps[1].Str("maskAsset"));
   var gradSheet=Load(gradGroup.Str("outputAsset")).GetPixels32();
   RequirePixel(gradSheet,gradMaskLeft,1,5,new Color32(57,102,200,255),"the gradient's brightest pixel");
   RequirePixel(gradSheet,gradMaskLeft,2,5,new Color32(43,77,150,255),"the gradient's second pixel");
   RequirePixel(gradSheet,gradMaskLeft,1,6,new Color32(40,72,140,255),"the gradient's third pixel");
   RequirePixel(gradSheet,gradMaskLeft,2,6,new Color32(57,102,200,255),"the gradient's fourth pixel");
   RequirePixel(gradSheet,gradMaskRight,5,5,new Color32(200,162,74,255),"the right gradient's brightest pixel");
   RequirePixel(gradSheet,gradMaskRight,6,5,new Color32(150,122,56,255),"the right gradient's second pixel");
   RequirePixel(gradSheet,gradMaskRight,5,6,new Color32(140,113,52,255),"the right gradient's third pixel");
   RequirePixel(gradSheet,gradMaskRight,6,6,new Color32(200,162,74,255),"the right gradient's fourth pixel");

   // The binding: the material the renderer uses reads the produced sheet, not the ledger's word for it.
   var output=AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath);
   var bound=output.transform.Find(importedFbxRendererPath).GetComponent<SkinnedMeshRenderer>().sharedMaterials[0];
   Require(bound!=null&&bound.GetTexture("_MainTex")!=null&&AssetDatabase.GetAssetPath(bound.GetTexture("_MainTex"))==outputPath,
    "The renderer's material does not read the produced sheet");
   var bigBound=output.transform.Find("_Outfit/Big").GetComponent<SkinnedMeshRenderer>().sharedMaterials[0];
   Require(bigBound!=null&&AssetDatabase.GetAssetPath(bigBound.GetTexture("_MainTex"))==bigGroup.Str("outputAsset"),
    "The second surface's material does not read its own produced sheet");
   var shadeBound=output.transform.Find("_Outfit/Shade").GetComponent<SkinnedMeshRenderer>().sharedMaterials[0];
   Require(shadeBound!=null&&AssetDatabase.GetAssetPath(shadeBound.GetTexture("_MainTex"))==shadeGroup.Str("outputAsset"),
    "The shaded surface's material does not read its own produced sheet");
   Require(sourceBytes.SequenceEqual(File.ReadAllBytes(Avh.Abs("Assets/Authorized/eyes.png"))),"The vendor sheet was modified");
   Require(!bound.GetTexture("_MainTex").Equals(eyesMaterial.GetTexture("_MainTex")),"The vendor material itself was rebound");
   Require(File.ReadAllBytes(Avh.Abs("Assets/Authorized/eyes.mat")).SequenceEqual(materialBytes),"Vendor material modified");
   UnityEngine.Object.DestroyImmediate(output);

   // The ledger: one row per requirement, all on the one slot each texture is on. One row for the first
   // requirement left the others unbound as far as an independent reader was concerned, and F21 has to keep
   // counting deduplicated slots so the extra rows do not inflate it.
   var ledger=Avh.ReadJsonFile(Avh.Abs(RecolorStage.LedgerPath));
   var rows=ledger.List("rows").Cast<Dictionary<string,object>>().Where(row=>row.Str("part").StartsWith("region:")).ToList();
   var ledgerParts=rows.Select(row=>row.Str("part")).Distinct().OrderBy(part=>part).ToList();
   Require(ledgerParts.SequenceEqual(new[]{"region:eye_big","region:eye_edge","region:eye_left","region:eye_right",
     "region:grad_left","region:grad_right","region:shade_left","region:shade_right"}),
     "one ledger row per region requirement, got "+string.Join(",",ledgerParts));
   Require(rows.Count(row=>row.Str("part")=="region:eye_left")==1&&rows.Count(row=>row.Str("part")=="region:eye_edge")==1,
     "each requirement owns exactly one row on its surface's slot");
   Require(rows.Select(row=>row.Str("renderer")+"#"+row.Str("slot")).Distinct().Count()==4,
     "F21 counts deduplicated slots: eight requirements on four slots are still four slots");

   // What the saved variant actually says, read back from the asset with Unity's own API and with the raw
   // override identities. The observer has to reach the same renderer paths from the file alone, and it has no
   // other way to tell an override on another renderer from the one the plan named (R6b 第 2 项).
   var variantText=File.ReadAllText(Avh.Abs(RecolorStage.AvatarPath));
   var identity=new System.Text.RegularExpressions.Regex(@"- target: \{fileID: (-?\d+), guid: ([0-9a-f]{32})");
   var modificationTargets=new List<object>();
   foreach(System.Text.RegularExpressions.Match match in identity.Matches(variantText))
    modificationTargets.Add(match.Groups[1].Value+" "+match.Groups[2].Value);
   var shown=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath));
   var readback=new List<object>();
   foreach(var renderer in shown.GetComponentsInChildren<Renderer>(true))
    for(var slot=0;slot<renderer.sharedMaterials.Length;slot++)
     readback.Add(new Dictionary<string,object>{["renderer"]=Probe.HierarchyPath(shown.transform,renderer.transform),
      ["slot"]=slot,["material_guid"]=renderer.sharedMaterials[slot]!=null?RecolorStage.Guid(renderer.sharedMaterials[slot]):null});
   UnityEngine.Object.DestroyImmediate(shown);

   // The file size is the importer's business and the pixel count is the file's. A 4096 sheet capped at 2048 by
   // its importer must still be masked and produced at 4096, and the product then inherits the cap (R6 第 1 项).
   Require(Convert.ToInt32(bigGroup["width"])==4096&&Convert.ToInt32(bigGroup["height"])==4096,
     "the mask must be derived at the file's own size, got "+bigGroup["width"]+"x"+bigGroup["height"]);
   var bigOperations=bigGroup.List("operations").Cast<Dictionary<string,object>>().ToList();
   var edgeMask=Load(bigOperations[1].Str("maskAsset"));
   Require(edgeMask.width==4096&&edgeMask.height==4096,"the mask PNG must be 4096 on disk, got "+edgeMask.width);
   var edgePixels=edgeMask.GetPixels32();
   var edgeCount=edgePixels.Count(pixel=>pixel.r>0);
   // One triangle, and the two rules that decide it: the edge function is evaluated in float64 (float32 would
   // include one more pixel), and a triangle with zero area covers nothing (without the rule the degenerate one
   // would fill its four-pixel bounding box).
   Require(edgeCount==CriticalPixels,"the critical triangle covers "+CriticalPixels+" pixels, got "+edgeCount);
   Require(!(edgePixels[CriticalY*4096+CriticalX].r>0),
     "the pixel whose edge function only float64 puts outside must not be in the mask");
   var degenerate=0;
   for(var y=DegenerateY0;y<=DegenerateY1;y++)for(var x=DegenerateX0;x<=DegenerateX1;x++)if(edgePixels[y*4096+x].r>0)degenerate++;
   Require(degenerate==0,"a triangle with zero area covers no pixel, "+degenerate+" were covered");
   var bigMask=Load(bigOperations[0].Str("maskAsset"));
   Require(bigMask.GetPixels32().Count(pixel=>pixel.r>0)==1024*1024,
     "the big island covers 1024x1024 pixels at 4096");
   UnityEngine.Object.DestroyImmediate(edgeMask);UnityEngine.Object.DestroyImmediate(bigMask);
   var bigImporter=(TextureImporter)AssetImporter.GetAtPath(bigGroup.Str("outputAsset"));
   Require(bigImporter!=null&&bigImporter.maxTextureSize==2048,
     "the product must inherit the original's import settings, got "+(bigImporter==null?0:bigImporter.maxTextureSize));

   // Rerunning the same recipe must produce the same bytes, or a rerun is a different product.
   var saved=File.ReadAllBytes(Avh.Abs(RecolorStage.AvatarPath));var savedSheet=File.ReadAllBytes(Avh.Abs(outputPath));
   RecolorStage.Produce();
   Require(saved.SequenceEqual(File.ReadAllBytes(Avh.Abs(RecolorStage.AvatarPath))),"Rerun changed the variant bytes");
   Require(savedSheet.SequenceEqual(File.ReadAllBytes(Avh.Abs(outputPath))),"Rerun changed the recoloured sheet");

   Avh.WriteJson(Avh.Abs("result.json"),new Dictionary<string,object>{["ok"]=true,["assertions"]=assertions,
     ["modificationTargets"]=modificationTargets,["bindingReadback"]=readback});
   EditorApplication.Exit(0);
  }catch(Exception e){Avh.WriteJson(Avh.Abs("result.json"),new Dictionary<string,object>{["ok"]=false,["assertions"]=assertions,["error"]=e.ToString()});Debug.LogException(e);EditorApplication.Exit(1);}}
 }
}
