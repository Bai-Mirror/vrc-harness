using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
 public static class RecolorMaterialIntegration
 {
  static int assertions;
  static void Require(bool ok,string message){assertions++;if(!ok)throw new Exception(message);}
  static void Refuses(Action action,string pattern){try{action();}catch(Exception e){Require(e.Message.Contains(pattern),e.ToString());return;}throw new Exception("Expected refusal: "+pattern);}
  static Material Mat(string path){OutfitStage.EnsureFolder(Path.GetDirectoryName(path).Replace('\\','/'));var mat=new Material(Shader.Find("Standard"));AssetDatabase.CreateAsset(mat,path);return mat;}
  static Renderer Mesh(Transform parent,string name,params Material[] materials){var go=GameObject.CreatePrimitive(PrimitiveType.Cube);go.name=name;go.transform.SetParent(parent,false);go.GetComponent<Renderer>().sharedMaterials=materials;return go.GetComponent<Renderer>();}
  static Dictionary<string,object> Target(string id,string outfit,string path)=>new Dictionary<string,object>{["requirement_id"]=id,["outfit"]=outfit,["material"]=path};
  static Dictionary<string,object> recipe;
  public static void Tamper(){try{
   var output=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath));
   var renderer=output.transform.Find("_Outfit/Outfit_winter/BagA").GetComponent<Renderer>();
   var materials=renderer.sharedMaterials;materials[0]=AssetDatabase.LoadAssetAtPath<Material>("Assets/Authorized/Vendor/Bag/Original.mat");renderer.sharedMaterials=materials;
   PrefabUtility.SaveAsPrefabAsset(output,RecolorStage.AvatarPath);UnityEngine.Object.DestroyImmediate(output);AssetDatabase.SaveAssets();RecolorStage.MaterialTargetReadback();EditorApplication.Exit(0);
  }catch(Exception e){Debug.LogException(e);EditorApplication.Exit(1);}}
  static void SetTargets(params Dictionary<string,object>[] targets){recipe["materialOps"]=targets.Cast<object>().ToList();Avh.WriteJson(Avh.Abs(RecolorStage.RecipePath),recipe);Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(new Dictionary<string,object>{["recolor"]=new Dictionary<string,object>{["targets"]=targets.Cast<object>().ToList(),["candidates"]=1}}));}
  public static GameObject Human(){
   var root=new GameObject("Avatar");var bones=new List<HumanBone>();var skeleton=new List<SkeletonBone>();
   skeleton.Add(new SkeletonBone{name=root.name,position=Vector3.zero,rotation=Quaternion.identity,scale=Vector3.one});
   Func<string,string,Transform,Vector3,Transform> add=(name,human,parent,pos)=>{var b=new GameObject(name).transform;b.SetParent(parent,false);b.localPosition=pos;bones.Add(new HumanBone{boneName=name,humanName=human,limit=new HumanLimit{useDefaultValues=true}});skeleton.Add(new SkeletonBone{name=name,position=pos,rotation=Quaternion.identity,scale=Vector3.one});return b;};
   var hips=add("Hips","Hips",root.transform,new Vector3(0,1,0));var spine=add("Spine","Spine",hips,new Vector3(0,0.2f,0));var chest=add("Chest","Chest",spine,new Vector3(0,0.2f,0));var neck=add("Neck","Neck",chest,new Vector3(0,0.2f,0));add("Head","Head",neck,new Vector3(0,0.15f,0));
   foreach(var side in new[]{"Left","Right"}){float sign=side=="Left"?-1:1;var leg=add(side+"UpperLeg",side+"UpperLeg",hips,new Vector3(sign*0.1f,-0.1f,0));var knee=add(side+"LowerLeg",side+"LowerLeg",leg,new Vector3(0,-0.4f,0));add(side+"Foot",side+"Foot",knee,new Vector3(0,-0.4f,0.05f));var arm=add(side+"UpperArm",side+"UpperArm",chest,new Vector3(sign*0.2f,0.1f,0));var elbow=add(side+"LowerArm",side+"LowerArm",arm,new Vector3(sign*0.3f,0,0));add(side+"Hand",side+"Hand",elbow,new Vector3(sign*0.25f,0,0));}
   var human=AvatarBuilder.BuildHumanAvatar(root,new HumanDescription{human=bones.ToArray(),skeleton=skeleton.ToArray(),upperArmTwist=0.5f,lowerArmTwist=0.5f,upperLegTwist=0.5f,lowerLegTwist=0.5f,armStretch=0.05f,legStretch=0.05f,feetSpacing=0});
   if(!human.isValid||!human.isHuman)throw new Exception("Invalid fixture humanoid");AssetDatabase.CreateAsset(human,"Assets/Authorized/FixtureAvatar.asset");root.AddComponent<Animator>().avatar=human;return root;
  }

  public static void Run(){try{
   UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene,UnityEditor.SceneManagement.NewSceneMode.Single);
   foreach(var path in new[]{"Assets/Authorized","Assets/_Harness/Outfit",RecolorStage.Dir})if(AssetDatabase.IsValidFolder(path))AssetDatabase.DeleteAsset(path);
   OutfitStage.EnsureFolder("Assets/Authorized");OutfitStage.EnsureFolder("Assets/_Harness/Outfit");OutfitStage.EnsureFolder(RecolorStage.Dir);
   var bag=Mat("Assets/Authorized/Vendor/Bag/Original.mat");var pink=Mat("Assets/Authorized/Vendor/Bag/Pink.mat");
   var other=Mat("Assets/Authorized/Other/Bag/Original.mat");var child=Mat("Assets/Authorized/Vendor/Bag/Child/Original.mat");
   var fur=Mat("Assets/Authorized/Vendor/Fur/Original.mat");var absent=Mat("Assets/Authorized/Vendor/Unused/Target.mat");
   var clothing=new GameObject("Clothing");Mesh(clothing.transform,"BagA",bag,pink,null);Mesh(clothing.transform,"BagB",bag);Mesh(clothing.transform,"Other",other);Mesh(clothing.transform,"Child",child);Mesh(clothing.transform,"Fur",fur);
   var particle=new GameObject("Particle");particle.transform.SetParent(clothing.transform,false);particle.AddComponent<ParticleSystem>();particle.GetComponent<ParticleSystemRenderer>().sharedMaterial=bag;
   var shared=PrefabUtility.SaveAsPrefabAsset(clothing,"Assets/Authorized/Base.prefab");UnityEngine.Object.DestroyImmediate(clothing);
   var variant=(GameObject)PrefabUtility.InstantiatePrefab(shared);variant.transform.Find("Fur").GetComponent<Renderer>().sharedMaterial=fur;
   var thin=PrefabUtility.SaveAsPrefabAsset(variant,"Assets/Authorized/Thin.prefab");UnityEngine.Object.DestroyImmediate(variant);
   Require(PrefabUtility.GetPrefabAssetType(thin)==PrefabAssetType.Variant,"Fixture is not a thin variant");
   var avatar=Human();var group=new GameObject(OutfitStage.Group);group.transform.SetParent(avatar.transform,false);
   var outfit=(GameObject)PrefabUtility.InstantiatePrefab(thin,group.transform);outfit.name="Outfit_winter";
   var second=(GameObject)PrefabUtility.InstantiatePrefab(thin,group.transform);second.name="Outfit_other";
   var controller=UnityEditor.Animations.AnimatorController.CreateAnimatorControllerAtPath("Assets/Authorized/Noop.controller");
   var clip=new AnimationClip();AssetDatabase.CreateAsset(clip,"Assets/Authorized/Noop.anim");
   AnimationUtility.SetObjectReferenceCurve(clip,EditorCurveBinding.PPtrCurve("_Outfit/Outfit_winter/BagA",typeof(MeshRenderer),"m_Materials.Array.data[1]"),new[]{new ObjectReferenceKeyframe{time=0,value=pink}});
   controller.layers[0].stateMachine.AddState("Noop").motion=clip;
   var merge=avatar.AddComponent<nadena.dev.modular_avatar.core.ModularAvatarMergeAnimator>();merge.animator=controller;merge.pathMode=nadena.dev.modular_avatar.core.MergeAnimatorPathMode.Absolute;
   PrefabUtility.SaveAsPrefabAsset(avatar,OutfitStage.AvatarPath);UnityEngine.Object.DestroyImmediate(avatar);
   Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath),new Dictionary<string,object>{["group"]=OutfitStage.Group,["outfits"]=new List<object>()});AssetDatabase.Refresh();AssetDatabase.SaveAssets();
   var sourceBytes=File.ReadAllBytes(Avh.Abs("Assets/Authorized/Vendor/Bag/Pink.mat"));var outfitBytes=File.ReadAllBytes(Avh.Abs(OutfitStage.AvatarPath));
   recipe=new Dictionary<string,object>{["targets"]=new List<object>(),["chosen"]="A",["reason"]="fixture",["tiers"]=new List<object>{new Dictionary<string,object>{["id"]="A",["adjustments"]=new List<object>()}}};
   SetTargets(Target("bag_pink","winter",AssetDatabase.GetAssetPath(pink)));RecolorStage.Produce();RecolorStage.MaterialTargetReadback();
   var output=AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath);
   var root=output.transform.Find("_Outfit/Outfit_winter");
   Require(root.Find("BagA").GetComponent<Renderer>().sharedMaterials.Take(2).All(m=>m==pink),"Not all same-directory slots replaced");
   Require(root.Find("BagB").GetComponent<Renderer>().sharedMaterial==pink,"Second renderer was omitted");
   Require(root.Find("BagA").GetComponent<Renderer>().sharedMaterials[2]==null,"Empty slot was rewritten");
   Require(root.Find("Other").GetComponent<Renderer>().sharedMaterial==other,"Leaf directory matched another full path");
   Require(root.Find("Child").GetComponent<Renderer>().sharedMaterial==child,"Directory containment replaced a child directory");
   Require(root.Find("Fur").GetComponent<Renderer>().sharedMaterial==fur,"Fur changed with bag selection");
   Require(root.Find("Particle").GetComponent<Renderer>().sharedMaterial==bag,"Particle renderer changed");
   Require(output.transform.Find("_Outfit/Outfit_other/BagB").GetComponent<Renderer>().sharedMaterial==bag,"Other outfit changed");
   var rows=Avh.ReadJsonFile(Avh.Abs(RecolorStage.LedgerPath)).List("rows").Cast<Dictionary<string,object>>().ToList();
   Require(rows.Count==3&&rows.All(r=>r.Str("requirement_id")=="bag_pink"&&r.Str("outfit")=="winter"&&r.Str("material_guid")==RecolorStage.Guid(pink)),"Material ledger lost target identity");
   Require(Convert.ToInt32(Avh.ReadJsonFile(Path.Combine(Avh.RunDir,"observations/menu.dump.json")).Obj("metrics")["stale_material_curves"])==0,"A curve selecting the unchanged requested material was treated as stale");
   Require(sourceBytes.SequenceEqual(File.ReadAllBytes(Avh.Abs("Assets/Authorized/Vendor/Bag/Pink.mat"))),"Vendor material modified");
   Require(outfitBytes.SequenceEqual(File.ReadAllBytes(Avh.Abs(OutfitStage.AvatarPath))),"Accepted outfit layer modified");
   var saved=File.ReadAllBytes(Avh.Abs(RecolorStage.AvatarPath));RecolorStage.Produce();RecolorStage.MaterialTargetReadback();
   Require(saved.SequenceEqual(File.ReadAllBytes(Avh.Abs(RecolorStage.AvatarPath))),"Rerun changed output bytes");
   var negative=Environment.GetEnvironmentVariable("AVH_MATERIAL_NEGATIVE");
   if(negative!="skip"){
    SetTargets(Target("zero","winter",AssetDatabase.GetAssetPath(absent)));Refuses(()=>RecolorStage.Produce(),"命中 0 槽");
    SetTargets(Target("missing","missing",AssetDatabase.GetAssetPath(pink)));Refuses(()=>RecolorStage.Produce(),"找不到服装");
    SetTargets(Target("first","winter",AssetDatabase.GetAssetPath(pink)),Target("second","winter",AssetDatabase.GetAssetPath(bag)));Refuses(()=>RecolorStage.Produce(),"材质槽写入冲突");
    Require(saved.SequenceEqual(File.ReadAllBytes(Avh.Abs(RecolorStage.AvatarPath))),"Conflict replaced accepted output");
    var relative=new Dictionary<string,object>{["part"]="outfit:winter",["hue_shift"]=0,["saturation"]=1,["value"]=1};recipe["targets"]=new List<object>{relative};SetTargets(Target("bag_pink","winter",AssetDatabase.GetAssetPath(pink)));Refuses(()=>RecolorStage.Produce(),"材质槽写入冲突");
    recipe["targets"]=new List<object>();
    var texture=new Texture2D(2,2);File.WriteAllBytes(Avh.Abs("Assets/Authorized/base.png"),texture.EncodeToPNG());AssetDatabase.Refresh();bag.SetTexture("_MainTex",AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Authorized/base.png"));EditorUtility.SetDirty(bag);AssetDatabase.SaveAssets();
    Avh.WriteJson(Avh.Abs(RecolorStage.LayerApplyPath),new Dictionary<string,object>{["operations"]=new List<object>{new Dictionary<string,object>{["requirement_id"]="layer_bag",["textureAsset"]="Assets/Authorized/base.png"}}});Refuses(()=>RecolorStage.Produce(),"材质槽写入冲突");File.Delete(Avh.Abs(RecolorStage.LayerApplyPath));
    SetTargets(Target("bag_pink","winter",AssetDatabase.GetAssetPath(pink)));RecolorStage.Produce();RecolorStage.MaterialTargetReadback();
   }
   Avh.WriteJson(Avh.Abs("result.json"),new Dictionary<string,object>{["ok"]=true,["assertions"]=assertions});EditorApplication.Exit(0);
  }catch(Exception e){Avh.WriteJson(Avh.Abs("result.json"),new Dictionary<string,object>{["ok"]=false,["assertions"]=assertions,["error"]=e.ToString()});Debug.LogException(e);EditorApplication.Exit(1);}}
 }
}
