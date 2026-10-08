using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
 public static class RecolorIntegration
 {
  static int assertions;
  static void Require(bool ok,string message){assertions++;if(!ok)throw new Exception(message);}
  static void Refuses(Action action,string message){bool refused=false;try{action();}catch{refused=true;}Require(refused,message);}
  static GameObject Human(){
   var root=new GameObject("Avatar");var bones=new List<HumanBone>();var skeleton=new List<SkeletonBone>();
   skeleton.Add(new SkeletonBone{name=root.name,position=Vector3.zero,rotation=Quaternion.identity,scale=Vector3.one});
   Func<string,string,Transform,Vector3,Transform> add=(name,human,parent,pos)=>{var b=new GameObject(name).transform;b.SetParent(parent,false);b.localPosition=pos;bones.Add(new HumanBone{boneName=name,humanName=human,limit=new HumanLimit{useDefaultValues=true}});skeleton.Add(new SkeletonBone{name=name,position=pos,rotation=Quaternion.identity,scale=Vector3.one});return b;};
   var hips=add("Hips","Hips",root.transform,new Vector3(0,1,0));var spine=add("Spine","Spine",hips,new Vector3(0,0.2f,0));var chest=add("Chest","Chest",spine,new Vector3(0,0.2f,0));var neck=add("Neck","Neck",chest,new Vector3(0,0.2f,0));add("Head","Head",neck,new Vector3(0,0.15f,0));
   foreach(var side in new[]{"Left","Right"}){float sign=side=="Left"?-1:1;var leg=add(side+"UpperLeg",side+"UpperLeg",hips,new Vector3(sign*0.1f,-0.1f,0));var knee=add(side+"LowerLeg",side+"LowerLeg",leg,new Vector3(0,-0.4f,0));add(side+"Foot",side+"Foot",knee,new Vector3(0,-0.4f,0.05f));var arm=add(side+"UpperArm",side+"UpperArm",chest,new Vector3(sign*0.2f,0.1f,0));var elbow=add(side+"LowerArm",side+"LowerArm",arm,new Vector3(sign*0.3f,0,0));add(side+"Hand",side+"Hand",elbow,new Vector3(sign*0.25f,0,0));}
   var human=AvatarBuilder.BuildHumanAvatar(root,new HumanDescription{human=bones.ToArray(),skeleton=skeleton.ToArray(),upperArmTwist=0.5f,lowerArmTwist=0.5f,upperLegTwist=0.5f,lowerLegTwist=0.5f,armStretch=0.05f,legStretch=0.05f,feetSpacing=0});
   if(!human.isValid||!human.isHuman)throw new Exception("Invalid fixture humanoid");AssetDatabase.CreateAsset(human,"Assets/Authorized/FixtureAvatar.asset");root.AddComponent<Animator>().avatar=human;return root;
  }
  public static void Run(){try{
   OutfitStage.EnsureFolder("Assets/Authorized");OutfitStage.EnsureFolder("Assets/_Harness/Outfit");OutfitStage.EnsureFolder(RecolorStage.Dir);
   var texture=new Texture2D(2,2);texture.SetPixels(new[]{Color.white,Color.white,Color.white,Color.white});texture.Apply();
   File.WriteAllBytes(Avh.Abs("Assets/Authorized/MainColor2nd_Eye.png"),texture.EncodeToPNG());
   AssetDatabase.Refresh();var iris=AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Authorized/MainColor2nd_Eye.png");
   var face=new Material(Shader.Find("Fixture/Iris")){name="Face"};
   face.SetFloat("_UseMain2ndTex",1);face.SetTexture("_Main2ndTex",iris);face.SetColor("_Color2nd",Color.blue);
   var skin=new Color(0.8f,0.6f,0.4f,1);face.SetColor("_Color",skin);face.SetVector("_MainTexHSVG",new Vector4(0,1,1,1));
   AssetDatabase.CreateAsset(face,"Assets/Authorized/Face.mat");
   var broken=new Material(Shader.Find("Unlit/Color")){name="Broken"};broken.SetColor("_Color",Color.green);broken.shader=Shader.Find("Hidden/InternalErrorShader");
   AssetDatabase.CreateAsset(broken,"Assets/Authorized/Broken.mat");
   var avatar=Human();var part=GameObject.CreatePrimitive(PrimitiveType.Cube);part.name="Face";part.transform.SetParent(avatar.transform,false);part.GetComponent<Renderer>().sharedMaterial=face;
   var other=GameObject.CreatePrimitive(PrimitiveType.Cube);other.name="BrokenPart";other.transform.SetParent(avatar.transform,false);other.GetComponent<Renderer>().sharedMaterial=broken;
   PrefabUtility.SaveAsPrefabAsset(avatar,OutfitStage.AvatarPath);UnityEngine.Object.DestroyImmediate(avatar);AssetDatabase.SaveAssets();
   var faceBefore=File.ReadAllBytes(Avh.Abs("Assets/Authorized/Face.mat"));var parentBefore=File.ReadAllBytes(Avh.Abs(OutfitStage.AvatarPath));
   Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath),new Dictionary<string,object>{["outfits"]=new List<object>()});
   var adjustment=new Dictionary<string,object>{["part"]="eye",["hue_shift"]=120,["saturation"]=1,["value"]=1};
   var recipe=new Dictionary<string,object>{["targets"]=new List<object>{adjustment},["chosen"]="A",["reason"]="fixture",["tiers"]=new List<object>{new Dictionary<string,object>{["id"]="A",["label"]="fixture",["adjustments"]=new List<object>{adjustment}}}};
   Avh.WriteJson(Avh.Abs(RecolorStage.RecipePath),recipe);
   var requestPath=Avh.Abs(RecolorStage.Dir+"/dependencies.json");
   Avh.WriteJson(requestPath,new Dictionary<string,object>{["schema"]="material-dependencies/0.1",["packages"]=new List<object>(),["missing_shader_replacement"]="Unlit/Color"});
   var receipt=new Dictionary<string,object>{["schema"]="material-dependency-receipt/0.1",["request_sha256"]=LocalOperations.Digest(File.ReadAllText(requestPath)),["packages"]=new List<object>()};
   Avh.WriteJson(Avh.Abs(RecolorStage.Dir+"/dependency-receipt.json"),receipt);
   RecolorStage.Produce();
   var output=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath));
   var actual=output.transform.Find("Face").GetComponent<Renderer>().sharedMaterial;
   Require(Vector4.Distance(actual.GetColor("_Color2nd"),Color.red)<0.001f,"Actual eye target did not reach the iris layer");
   Require(Vector4.Distance(actual.GetColor("_Color"),skin)<0.001f,"Eye adjustment changed face skin");
   Require(Vector4.Distance(actual.GetVector("_MainTexHSVG"),new Vector4(0,1,1,1))<0.001f,"Eye adjustment changed whole-face HSVG");
   Require(output.transform.Find("BrokenPart").GetComponent<Renderer>().sharedMaterial.shader.name=="Unlit/Color","Missing shader was not repaired in derived output");
   Require(Convert.ToBase64String(File.ReadAllBytes(Avh.Abs("Assets/Authorized/Face.mat")))==Convert.ToBase64String(faceBefore),"Original face material changed");
   Require(Convert.ToBase64String(File.ReadAllBytes(Avh.Abs(OutfitStage.AvatarPath)))==Convert.ToBase64String(parentBefore),"Accepted predecessor prefab changed");
   UnityEngine.Object.DestroyImmediate(output);
   receipt["request_sha256"]="forged";Avh.WriteJson(Avh.Abs(RecolorStage.Dir+"/dependency-receipt.json"),receipt);
   Refuses(()=>RecolorStage.Produce(),"Forged dependency receipt was accepted");
   receipt["request_sha256"]=LocalOperations.Digest(File.ReadAllText(requestPath));Avh.WriteJson(Avh.Abs(RecolorStage.Dir+"/dependency-receipt.json"),receipt);
   face.SetFloat("_UseMain2ndTex",0);EditorUtility.SetDirty(face);AssetDatabase.SaveAssets();RecolorStage.Produce();
   Require(Avh.ReadJsonFile(Avh.Abs(RecolorStage.LedgerPath)).List("unmapped").Contains("eye"),"Disabled iris layer falsely fulfilled eye requirement");
   File.Copy(Avh.Abs("Assets/Authorized/MainColor2nd_Eye.png"),Avh.Abs("Assets/Authorized/Makeup.png"));AssetDatabase.Refresh();face.SetFloat("_UseMain2ndTex",1);face.SetTexture("_Main2ndTex",AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Authorized/Makeup.png"));EditorUtility.SetDirty(face);AssetDatabase.SaveAssets();RecolorStage.Produce();
   Require(Avh.ReadJsonFile(Avh.Abs(RecolorStage.LedgerPath)).List("unmapped").Contains("eye"),"Unidentified makeup layer falsely fulfilled eye requirement");
   face.SetFloat("_UseMain2ndTex",0);face.SetTexture("_Main2ndTex",iris);EditorUtility.SetDirty(face);AssetDatabase.SaveAssets();
   Func<string,string> hash=p=>{using(var sha=System.Security.Cryptography.SHA256.Create())return BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(p))).Replace("-","").ToLowerInvariant();};
   var sourcePath=Avh.Abs("Assets/Authorized/Face.mat");var sourceBefore=File.ReadAllBytes(sourcePath);
   var proposal=new Dictionary<string,object>{["material_guid"]=RecolorStage.Guid(face),["texture_guid"]=RecolorStage.Guid(iris),["source_sha256"]=hash(sourcePath),["expected_enabled"]=0,["enable"]=true};
   Action writeProposal=()=>{Avh.WriteJson(requestPath,new Dictionary<string,object>{["schema"]="material-dependencies/0.1",["packages"]=new List<object>(),["iris_layers"]=new List<object>{proposal},["missing_shader_replacement"]="Unlit/Color"});receipt["request_sha256"]=hash(requestPath);Avh.WriteJson(Avh.Abs(RecolorStage.Dir+"/dependency-receipt.json"),receipt);};
   Environment.SetEnvironmentVariable("AVH_PLAN","{\"recolor\":{\"targets\":[{\"part\":\"eye\"}]}}");writeProposal();RecolorStage.Produce();
   output=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath));actual=output.transform.Find("Face").GetComponent<Renderer>().sharedMaterial;
   Require(actual.GetFloat("_UseMain2ndTex")==1&&Vector4.Distance(actual.GetColor("_Color2nd"),Color.red)<0.001f,"Explicit disabled iris proposal was not applied in derived output");UnityEngine.Object.DestroyImmediate(output);
   Require(Convert.ToBase64String(File.ReadAllBytes(sourcePath))==Convert.ToBase64String(sourceBefore),"Enabling derived iris changed the original material");
   proposal["source_sha256"]="forged";writeProposal();Refuses(()=>RecolorStage.Produce(),"Forged iris source hash was accepted");proposal["source_sha256"]=hash(sourcePath);
   proposal["expected_enabled"]=1;writeProposal();Refuses(()=>RecolorStage.Produce(),"Stale iris switch observation was accepted");proposal["expected_enabled"]=0;
   proposal["texture_guid"]=RecolorStage.Guid(AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Authorized/Makeup.png"));writeProposal();Refuses(()=>RecolorStage.Produce(),"Unrelated makeup mask was accepted as iris evidence");proposal["texture_guid"]=RecolorStage.Guid(iris);
   var outside=new Material(face);AssetDatabase.CreateAsset(outside,"Assets/Authorized/Outside.mat");AssetDatabase.SaveAssets();proposal["material_guid"]=RecolorStage.Guid(outside);proposal["source_sha256"]=hash(Avh.Abs("Assets/Authorized/Outside.mat"));writeProposal();Refuses(()=>RecolorStage.Produce(),"An unreferenced material broadened the eye construction scope");proposal["material_guid"]=RecolorStage.Guid(face);proposal["source_sha256"]=hash(sourcePath);
   Environment.SetEnvironmentVariable("AVH_PLAN","{}");writeProposal();Refuses(()=>RecolorStage.Produce(),"Missing eye authorization was accepted");
   // 按层改色的绑定路径：像素那一侧由工具写好并自证，这里验的是「产物被绑到实际用了原图的槽位」。
   // 此前夹具从不写 layer-apply.json，所以这条路径没有任何覆盖。
   Avh.WriteJson(requestPath,new Dictionary<string,object>{["schema"]="material-dependencies/0.1",["packages"]=new List<object>(),["missing_shader_replacement"]="Unlit/Color"});
   receipt["request_sha256"]=hash(requestPath);receipt["packages"]=new List<object>();Avh.WriteJson(Avh.Abs(RecolorStage.Dir+"/dependency-receipt.json"),receipt);
   var lashSource=new Texture2D(2,2);lashSource.SetPixels(new[]{Color.white,Color.white,Color.white,Color.white});lashSource.Apply();
   File.WriteAllBytes(Avh.Abs("Assets/Authorized/Lash.png"),lashSource.EncodeToPNG());
   OutfitStage.EnsureFolder(RecolorStage.Dir);
   var lashProduct=new Texture2D(2,2);lashProduct.SetPixels(new[]{new Color(0.36f,0.36f,0.4f,1f),new Color(0.36f,0.36f,0.4f,1f),new Color(0.36f,0.36f,0.4f,1f),new Color(0.36f,0.36f,0.4f,1f)});lashProduct.Apply();
   File.WriteAllBytes(Avh.Abs(RecolorStage.Dir+"/lash.png"),lashProduct.EncodeToPNG());
   AssetDatabase.Refresh();
   var lashMaterial=new Material(Shader.Find("Fixture/Iris")){name="Lash"};
   lashMaterial.SetTexture("_MainTex",AssetDatabase.LoadAssetAtPath<Texture2D>("Assets/Authorized/Lash.png"));
   AssetDatabase.CreateAsset(lashMaterial,"Assets/Authorized/Lash.mat");AssetDatabase.SaveAssets();
   var lashAvatar=Human();var lashPart=GameObject.CreatePrimitive(PrimitiveType.Cube);lashPart.name="Lash";lashPart.transform.SetParent(lashAvatar.transform,false);
   lashPart.GetComponent<Renderer>().sharedMaterial=lashMaterial;
   PrefabUtility.SaveAsPrefabAsset(lashAvatar,OutfitStage.AvatarPath);UnityEngine.Object.DestroyImmediate(lashAvatar);AssetDatabase.SaveAssets();
   var lashBytes=File.ReadAllBytes(Avh.Abs("Assets/Authorized/Lash.mat"));
   Avh.WriteJson(Avh.Abs(RecolorStage.LayerApplyPath),new Dictionary<string,object>{["schema"]="layered-source-apply/0.1",
     ["operations"]=new List<object>{new Dictionary<string,object>{["requirement_id"]="lash",["textureAsset"]="Assets/Authorized/Lash.png",
       ["outputAsset"]=RecolorStage.Dir+"/lash.png",["outputSha256"]=hash(Avh.Abs(RecolorStage.Dir+"/lash.png")),
       ["color"]="#5B5B66",["semantics"]="flat",["maskPixels"]=4}}});
   RecolorStage.Produce();
   var bound=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath));
   var boundMaterial=bound.transform.Find("Lash").GetComponent<Renderer>().sharedMaterial;
   Require(boundMaterial.GetTexture("_MainTex")==AssetDatabase.LoadAssetAtPath<Texture2D>(RecolorStage.Dir+"/lash.png"),
     "The layered product was not bound to the slot that read the original texture");
   Require(boundMaterial!=lashMaterial,"The original material was rewritten instead of copied");
   Require(Convert.ToBase64String(File.ReadAllBytes(Avh.Abs("Assets/Authorized/Lash.mat")))==Convert.ToBase64String(lashBytes),
     "Binding a layered product changed the source material");
   var boundLedger=Avh.ReadJsonFile(Avh.Abs(RecolorStage.LedgerPath));var recorded=false;
   foreach(var row in boundLedger.List("rows").Cast<Dictionary<string,object>>())if(row.Str("part")=="layer:lash")recorded=true;
   Require(recorded,"The binding was not recorded in the ledger, so nothing can check it independently");
   UnityEngine.Object.DestroyImmediate(bound);
   File.Delete(Avh.Abs(RecolorStage.LayerApplyPath));
   var archive=Avh.Abs("Assets/Authorized/Materials.zip");var anchor=Avh.Abs("Assets/Authorized/Body.zip");File.WriteAllText(archive,"fixture archive");File.WriteAllText(anchor,"fixture anchor");
   Environment.SetEnvironmentVariable("AVH_ASSET_SEARCH_ROOTS_JSON","["+"\""+Avh.Abs("Assets/Authorized").Replace("\\","/")+"\""+"]");
   var pkg=new Dictionary<string,object>{["archive"]=archive,["anchor"]=anchor,["sha256"]=LocalOperations.Digest("fixture archive")};
   Avh.WriteJson(requestPath,new Dictionary<string,object>{["schema"]="material-dependencies/0.1",["packages"]=new List<object>{pkg},["missing_shader_replacement"]="Unlit/Color"});
   var recovered=RecolorStage.Dir+"/Dependencies/test.png";OutfitStage.EnsureFolder(RecolorStage.Dir+"/Dependencies");File.Copy(Avh.Abs("Assets/Authorized/Makeup.png"),Avh.Abs(recovered));AssetDatabase.Refresh();

   var asset=new Dictionary<string,object>{["path"]=recovered,["sha256"]=hash(Avh.Abs(recovered)),["meta_sha256"]=hash(Avh.Abs(recovered+".meta"))};
   var evidenced=new Dictionary<string,object>(pkg){["assets"]=new List<object>{asset}};
   receipt["request_sha256"]=hash(requestPath);receipt["packages"]=new List<object>{evidenced};Avh.WriteJson(Avh.Abs(RecolorStage.Dir+"/dependency-receipt.json"),receipt);RecolorStage.Produce();
   var savedBytes=File.ReadAllBytes(Avh.Abs(recovered));File.AppendAllText(Avh.Abs(recovered),"drift");Refuses(()=>RecolorStage.Produce(),"Changed derived source bytes were accepted");File.WriteAllBytes(Avh.Abs(recovered),savedBytes);
   var savedMeta=File.ReadAllBytes(Avh.Abs(recovered+".meta"));File.AppendAllText(Avh.Abs(recovered+".meta"),"\nuserData: changed\n");Refuses(()=>RecolorStage.Produce(),"Changed GUID/import metadata were accepted");File.WriteAllBytes(Avh.Abs(recovered+".meta"),savedMeta);
   Environment.SetEnvironmentVariable("AVH_ASSET_SEARCH_ROOTS_JSON","[]");Refuses(()=>RecolorStage.Produce(),"Revoked current source consent was accepted");
   Avh.WriteJson(Avh.Abs("result.json"),new Dictionary<string,object>{["ok"]=true,["assertions"]=assertions});EditorApplication.Exit(0);
  }catch(Exception error){Avh.WriteJson(Avh.Abs("result.json"),new Dictionary<string,object>{["ok"]=false,["error"]=error.ToString(),["assertions"]=assertions});EditorApplication.Exit(1);}}
 }
}
