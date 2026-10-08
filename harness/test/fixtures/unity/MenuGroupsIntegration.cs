using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;
using VRC.SDKBase;
namespace AVH.Harness
{
    public static class MenuGroupsIntegration
    {
        static int assertions;
        static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (int i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1]; return d; }
        static List<object> L(params object[] values) => values.ToList();
        static void Check(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }
        static void NetworkRepresentatives()
        {
            for (var n = 1; n <= 128; n++)
            {
                var members = Enumerable.Range(0, n).Select(i => (object)D("id", "v" + i)).ToList();
                var group = D("id", "boundary", "activation", "exclusive", "members", members, "parameter", Parameter("Boundary", "Float"));
                foreach (Dictionary<string, object> member in members)
                {
                    var value = AvatarConfig.Value(group, member);
                    var synced = Mathf.RoundToInt(value * 127) / 127f;
                    Check(AvatarConfig.Selected(group, member, new Dictionary<string, float>{{"Boundary", synced}}), "Synced Float representative left slot N=" + n + " member=" + member.Str("id")
                        + " value=" + value.ToString("R") + " synced=" + synced.ToString("R") + " actual=" + string.Join(",", members.Cast<Dictionary<string, object>>().Where(m => AvatarConfig.Selected(group,m,new Dictionary<string,float>{{"Boundary",synced}})).Select(m=>m.Str("id"))));
                }
            }
        }
        static void SourceShapesAndLiveLog()
        {
            OutfitStage.EnsureFolder("Assets/Fixture");
            var mesh=new Mesh {vertices=new[]{Vector3.zero,Vector3.right,Vector3.up},triangles=new[]{0,1,2}};
            mesh.AddBlendShapeFrame("Fit",100,new[]{Vector3.up,Vector3.up,Vector3.up},new Vector3[3],new Vector3[3]);
            mesh.AddBlendShapeFrame("Local",100,new[]{Vector3.right,Vector3.right,Vector3.right},new Vector3[3],new Vector3[3]);
            mesh.AddBlendShapeFrame("AuthorDefault",100,new[]{Vector3.forward,Vector3.forward,Vector3.forward},new Vector3[3],new Vector3[3]);
            AssetDatabase.CreateAsset(mesh,"Assets/Fixture/KeyMesh.asset");
            var sourceBody=new GameObject("SourceBody");sourceBody.AddComponent<VRCAvatarDescriptor>();
            foreach(var name in new[]{"UpperSection","LowerSection"}) Child(name,sourceBody.transform).AddComponent<SkinnedMeshRenderer>().sharedMesh=mesh;
            sourceBody.transform.Find("LowerSection").GetComponent<SkinnedMeshRenderer>().SetBlendShapeWeight(0,30);
            PrefabUtility.SaveAsPrefabAsset(sourceBody,"Assets/Fixture/KeyBody.prefab");UnityEngine.Object.DestroyImmediate(sourceBody);
            var sourceOutfit=new GameObject("SourceOutfit");var geometry=Child("Geometry",sourceOutfit.transform);geometry.AddComponent<SkinnedMeshRenderer>().sharedMesh=mesh;
            var sync=geometry.AddComponent<ModularAvatarBlendshapeSync>();
            sync.Bindings.Add(new BlendshapeBinding {ReferenceMesh=new AvatarObjectReference {referencePath="UpperSection"},Blendshape="Fit",LocalBlendshape=" "});
            sync.Bindings.Add(new BlendshapeBinding {ReferenceMesh=new AvatarObjectReference {referencePath="UpperSection"},Blendshape="Fit",LocalBlendshape="Local",RemapCurveIsValid=true,RemapCurve=AnimationCurve.Linear(0,10,100,60)});
            geometry.GetComponent<SkinnedMeshRenderer>().SetBlendShapeWeight(2,35);
            PrefabUtility.SaveAsPrefabAsset(sourceOutfit,"Assets/Fixture/KeyOutfit.prefab");UnityEngine.Object.DestroyImmediate(sourceOutfit);
            var avatar=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Fixture/KeyBody.prefab"));
            var item=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Fixture/KeyOutfit.prefab"));
            item.name="KeyRoot";item.transform.SetParent(Child("_Outfit",avatar.transform).transform,false);
            item.transform.Find("Geometry").GetComponent<SkinnedMeshRenderer>().SetBlendShapeWeight(1,10);
            var plan=D("schema","plan/0.3","body_prefab","Assets/Fixture/KeyBody.prefab",
                "avatar_config",D("schema","avatar-config/0.1","instances",L(D("id","key","prefab","Assets/Fixture/KeyOutfit.prefab")),"groups",L(D("id","fixed","activation","fixed","members",L(D("id","key","instance","key")))),"shared_switches",L()));
            Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(plan));
            var row=D("id","key","instance","key","prefab","Assets/Fixture/KeyOutfit.prefab","object","_Outfit/KeyRoot");
            var record=D("outfits",L(row));SourceShapeAudit.CaptureSources(plan,record);var audit=SourceShapeAudit.For(avatar,plan,record);
            var snapshot=new AnimatorSim(avatar).Evaluate(new Dictionary<string,float>());
            var measured=audit.Check(avatar,snapshot.Visible,snapshot.WeightAt,snapshot.Scale,new List<string>());
            Check(measured.pairs==4&&measured.unknown==0&&measured.failures==0,"Unrelated same-name body mesh, remap or author defaults were guessed");
            var follower=item.transform.Find("Geometry").GetComponent<SkinnedMeshRenderer>();follower.SetBlendShapeWeight(0,30);
            snapshot=new AnimatorSim(avatar).Evaluate(new Dictionary<string,float>());
            measured=audit.Check(avatar,snapshot.Visible,snapshot.WeightAt,snapshot.Scale,new List<string>());
            Check(measured.delta==30&&measured.failures>0,"Broken declared follower escaped");follower.SetBlendShapeWeight(0,0);follower.SetBlendShapeWeight(1,0);
            snapshot=new AnimatorSim(avatar).Evaluate(new Dictionary<string,float>());
            measured=audit.Check(avatar,snapshot.Visible,snapshot.WeightAt,snapshot.Scale,new List<string>());
            Check(measured.failures>0,"Missing remap escaped");follower.SetBlendShapeWeight(1,10);follower.SetBlendShapeWeight(2,0);
            snapshot=new AnimatorSim(avatar).Evaluate(new Dictionary<string,float>());
            measured=audit.Check(avatar,snapshot.Visible,snapshot.WeightAt,snapshot.Scale,new List<string>());
            Check(measured.failures>0,"Author nonzero default was cleared");follower.sharedMesh=null;
            snapshot=new AnimatorSim(avatar).Evaluate(new Dictionary<string,float>());
            measured=audit.Check(avatar,snapshot.Visible,snapshot.WeightAt,snapshot.Scale,new List<string>());
            Check(measured.unknown==3,"Missing declared consumer fabricated zero");UnityEngine.Object.DestroyImmediate(avatar);
            var path=Path.Combine(Avh.RunDir,"shared-live.log");Directory.CreateDirectory(Avh.RunDir);
            using(var writer=new FileStream(path,FileMode.Create,FileAccess.Write,FileShare.ReadWrite))
            {var bytes=System.Text.Encoding.UTF8.GetBytes("error CS1000 fixture\n");writer.Write(bytes,0,bytes.Length);writer.Flush();Check(ColdImportStage.ReadLiveLog(path).Single().Contains("CS1000"),"Active Unity log was not read with shared access");}
        }
        static Dictionary<string, object> Parameter(string name, string type) => D("name", name, "type", type, "saved", true, "synced", true);
        static void IndependentSourceOwners()
        {
            var mesh=new Mesh {vertices=new[]{Vector3.zero,Vector3.right,Vector3.up,Vector3.forward,Vector3.right+Vector3.forward,Vector3.up+Vector3.forward},triangles=new[]{0,1,2,3,4,5},
                bindposes=new[]{Matrix4x4.identity},boneWeights=Enumerable.Range(0,6).Select(_=>new BoneWeight {boneIndex0=0,weight0=1}).ToArray()};
            mesh.AddBlendShapeFrame("ZoneA",100,Enumerable.Range(0,6).Select(i=>i<3?Vector3.up:Vector3.zero).ToArray(),new Vector3[6],new Vector3[6]);
            mesh.AddBlendShapeFrame("ZoneB",100,Enumerable.Range(0,6).Select(i=>i>=3?Vector3.right:Vector3.zero).ToArray(),new Vector3[6],new Vector3[6]);
            foreach(var name in new[]{"FitA","FitB"})mesh.AddBlendShapeFrame(name,100,Enumerable.Repeat(Vector3.forward*.01f,6).ToArray(),new Vector3[6],new Vector3[6]);
            AssetDatabase.CreateAsset(mesh,"Assets/Fixture/OwnedMesh.asset");
            var body=new GameObject("OwnedBody");var descriptor=body.AddComponent<VRCAvatarDescriptor>();var bone=Child("Anchor",body.transform).transform;
            var renderer=Child("Surface",body.transform).AddComponent<SkinnedMeshRenderer>();renderer.sharedMesh=mesh;renderer.bones=new[]{bone};renderer.rootBone=bone;
            PrefabUtility.SaveAsPrefabAsset(body,"Assets/Fixture/OwnedBody.prefab");
            var members=new List<object>();var rows=new List<object>();var controller=AnimatorController.CreateAnimatorControllerAtPath("Assets/Fixture/Owned.controller");
            foreach(var name in new[]{"A","B"})
            {
                var source=new GameObject("Effect"+name);var nested=Child("Nested",source.transform);
                foreach(var delete in new[]{false,true}) Child(delete?"Erase":"Fit",nested.transform).AddComponent<ModularAvatarShapeChanger>().Shapes.Add(
                    new ChangedShape {Object=new AvatarObjectReference {referencePath="Surface"},ShapeName=(delete?"Zone":"Fit")+name,ChangeType=delete?ShapeChangeType.Delete:ShapeChangeType.Set,Value=name=="A"?35:65});
                var path="Assets/Fixture/Owned"+name+".prefab";PrefabUtility.SaveAsPrefabAsset(source,path);UnityEngine.Object.DestroyImmediate(source);
                var item=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(path));item.name=name;item.transform.SetParent(body.transform,false);item.SetActive(false);
                members.Add(D("id",name,"instance",name,"default",false,"parameter",Parameter("Owner"+name,"Bool")));
                rows.Add(D("id",name,"instance",name,"prefab",path,"object",name));
                controller.AddParameter("Owner"+name,AnimatorControllerParameterType.Bool);controller.AddLayer(name);var layers=controller.layers;layers.Last().defaultWeight=1;controller.layers=layers;
                var machine=controller.layers.Last().stateMachine;var states=new List<AnimatorState>();
                for(var v=0;v<2;v++) {var clip=new AnimationClip {name="Owner"+name+v};AnimationUtility.SetEditorCurve(clip,EditorCurveBinding.FloatCurve(name,typeof(GameObject),"m_IsActive"),AnimationCurve.Constant(0,1,v));
                    AssetDatabase.CreateAsset(clip,"Assets/Fixture/Owner"+name+v+".anim");var state=machine.AddState(clip.name);state.motion=clip;state.writeDefaultValues=false;states.Add(state);}
                machine.defaultState=states[0];var on=states[0].AddTransition(states[1]);on.hasExitTime=false;on.duration=0;on.AddCondition(AnimatorConditionMode.If,0,"Owner"+name);
                var off=states[1].AddTransition(states[0]);off.hasExitTime=false;off.duration=0;off.AddCondition(AnimatorConditionMode.IfNot,0,"Owner"+name);
            }
            descriptor.customizeAnimationLayers=true;descriptor.baseAnimationLayers=new[]{new VRCAvatarDescriptor.CustomAnimLayer {type=VRCAvatarDescriptor.AnimLayerType.FX,isDefault=false,animatorController=controller}};
            var plan=D("schema","plan/0.3","body_prefab","Assets/Fixture/OwnedBody.prefab","avatar_config",D("schema","avatar-config/0.1","instances",new[]{"A","B"}.Select(n=>(object)D("id",n,"prefab","Assets/Fixture/Owned"+n+".prefab")).ToList(),
                "groups",L(D("id","owners","activation","independent","members",members)),"shared_switches",L()));
            var record=D("outfits",rows);Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(plan));
            SourceShapeAudit.CaptureSources(plan,record);
            PrefabUtility.SaveAsPrefabAsset(body,"Assets/Fixture/OwnedAvatar.prefab");UnityEngine.Object.DestroyImmediate(body);AssetDatabase.SaveAssets();
            AvatarAudit.OnBaked("Assets/Fixture/OwnedAvatar.prefab",built=>{
                var actualMesh=built.transform.Find("Surface").GetComponent<SkinnedMeshRenderer>().sharedMesh;
                var vertices=actualMesh.vertices;var damaged=(Vector3[])vertices.Clone();damaged[actualMesh.GetIndices(0)[0]]+=Vector3.left;
                var sourceMesh=AssetDatabase.LoadAssetAtPath<GameObject>(plan.Str("body_prefab")).transform.Find("Surface").GetComponent<SkinnedMeshRenderer>().sharedMesh;
                var sourceVertices=sourceMesh.vertices;var damagedSource=(Vector3[])sourceVertices.Clone();
                var corresponding=Array.FindIndex(sourceVertices,p=>p==vertices[actualMesh.GetIndices(0)[0]]);
                Check(corresponding>=0,"Fixture geometry correspondence missing");damagedSource[corresponding]+=Vector3.left;
                var off=new Dictionary<string,float>{{"OwnerA",0},{"OwnerB",0}};var initial=new AnimatorSim(built).Evaluate(off);
                try
                {
                    actualMesh.vertices=damaged;
                    // Exercise a contaminated live source too; a postbuild read must not redefine truth.
                    sourceMesh.vertices=damagedSource;
                    var diagnostics=new List<string>();var read=SourceShapeAudit.For(built,plan,record).Check(built,initial.Visible,initial.WeightAt,initial.Scale,diagnostics,off);
                    Check(read.failures>0,"Pre-audit source alias contaminated geometry baseline: "+read+" visible="+initial.Visible("Surface")+" "+string.Join(";",diagnostics));
                    record["unrelated_revision"]=1;
                    Check(SourceShapeAudit.For(built,plan,record).Check(built,initial.Visible,initial.WeightAt,initial.Scale,new List<string>(),off).failures>0,"Record revision absorbed aliased source mutation");
                }
                finally {actualMesh.vertices=vertices;sourceMesh.vertices=sourceVertices;record.Remove("unrelated_revision");}
                var audit=SourceShapeAudit.For(built,plan,record);var sim=new AnimatorSim(built);
                foreach(var a in new[]{0,1})foreach(var b in new[]{0,1})
                {
                    var values=new Dictionary<string,float>{{"OwnerA",a},{"OwnerB",b}};var state=sim.Evaluate(values);var notes=new List<string>();
                    var result=audit.Check(built,state.Visible,state.WeightAt,state.Scale,notes,values);
                    Check(result.failures==0&&result.unknown==0,"Destroyed source owner changed selection: "+string.Join(";",notes));
                    using(var pose=new MenuGroupAudit.NativePose(built,values))
                    {var native=SourceShapeAudit.For(pose.Avatar,plan,record);var read=native.Check(pose.Avatar,p=>AvatarAudit.Locate(pose.Avatar.transform,p)?.gameObject.activeInHierarchy==true,
                        (p,n)=>SourceShapeAudit.ReadWeight(pose.Avatar,p,n),SourceShapeAudit.ReadScale,new List<string>(),values);
                        Check(read.failures==0&&read.unknown==0,"Native independent owner effects failed");}
                }
                var active=new Dictionary<string,float>{{"OwnerA",1},{"OwnerB",0}};var selected=sim.Evaluate(active);
                Check(audit.Check(built,selected.Visible,(p,n)=>0,selected.Scale,new List<string>(),active).failures>0,"Missing selected effect escaped");
                return true;
            });
        }
        static void UnsupportedSourceDeclarations()
        {
            foreach(var mode in new[]{"scalar","activation","toggle","allocation","containerActivation","containerToggle"})
            {
                var body=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Fixture/OwnedBody.prefab"));
                var outfit=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Fixture/OwnedA.prefab"));outfit.name="A";outfit.transform.SetParent(body.transform,false);
                if(mode=="scalar"||mode=="activation"||mode=="containerActivation")
                {
                    var controller=AnimatorController.CreateAnimatorControllerAtPath("Assets/Fixture/Unsupported"+mode+".controller");var clip=new AnimationClip {name="AuthorOverride"};
                    AnimationUtility.SetEditorCurve(clip,EditorCurveBinding.FloatCurve(mode=="scalar"?"Surface":mode=="containerActivation"?"_Assembly":"A/Nested",mode=="scalar"?typeof(SkinnedMeshRenderer):typeof(GameObject),mode=="scalar"?"blendShape.ZoneA":"m_IsActive"),AnimationCurve.Constant(0,1,1));
                    AssetDatabase.CreateAsset(clip,"Assets/Fixture/Unsupported"+mode+".anim");controller.layers[0].stateMachine.AddState("Authored").motion=clip;
                    var descriptor=body.GetComponent<VRCAvatarDescriptor>();descriptor.customizeAnimationLayers=true;descriptor.baseAnimationLayers=new[]{new VRCAvatarDescriptor.CustomAnimLayer {type=VRCAvatarDescriptor.AnimLayerType.FX,isDefault=false,animatorController=controller}};
                }
                var bodyPath="Assets/Fixture/Unsupported"+mode+"Body.prefab";
                if(mode=="containerToggle")
                {
                    var gate=Child("Gate",body.transform);gate.AddComponent<ModularAvatarMenuItem>().Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.Toggle,value=1,parameter=new VRCExpressionsMenu.Control.Parameter {name="SourceGate"}};
                    gate.AddComponent<ModularAvatarObjectToggle>().Objects.Add(new ToggledObject {Object=new AvatarObjectReference {referencePath="_Assembly"},Active=false});
                }
                // Source declarations must include external references in an avatar context, but outfits
                // are instantiated separately by the oracle, just as they are in production assembly.
                outfit.transform.SetParent(null,false);PrefabUtility.SaveAsPrefabAsset(body,bodyPath);
                if(mode=="toggle")outfit.AddComponent<ModularAvatarObjectToggle>().Objects.Add(new ToggledObject {Object=new AvatarObjectReference {referencePath="A/Nested"},Active=true});
                if(mode=="allocation")
                {
                    var item=outfit.transform.Find("Nested").gameObject.AddComponent<ModularAvatarMenuItem>();item.Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.Toggle,parameter=new VRCExpressionsMenu.Control.Parameter {name="SharedVendor"}};item.automaticValue=true;
                    var explicitItem=Child("Reserved",outfit.transform).AddComponent<ModularAvatarMenuItem>();explicitItem.Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.Toggle,value=1,parameter=new VRCExpressionsMenu.Control.Parameter {name="SharedVendor"}};explicitItem.automaticValue=false;
                }
                var outfitPath="Assets/Fixture/Unsupported"+mode+"Outfit.prefab";PrefabUtility.SaveAsPrefabAsset(outfit,outfitPath);
                var objectPath=mode.StartsWith("container")?"_Assembly/A":"A";
                outfit.transform.SetParent(mode.StartsWith("container")?Child("_Assembly",body.transform).transform:body.transform,false);
                var plan=D("schema","plan/0.3","body_prefab",bodyPath,"avatar_config",D("schema","avatar-config/0.1","instances",L(D("id","A","prefab",outfitPath)),
                    "groups",L(D("id","fixed","activation","fixed","members",L(D("id","A","instance","A")))),"shared_switches",L()));
                var record=D("outfits",L(D("id","A","instance","A","prefab",outfitPath,"object",objectPath)));AssetDatabase.SaveAssets();SourceShapeAudit.CaptureSources(plan,record);
                var audit=SourceShapeAudit.For(body,plan,record);var state=new AnimatorSim(body).Evaluate(new Dictionary<string,float>());
                Check(audit.Check(body,state.Visible,state.WeightAt,state.Scale,new List<string>()).unknown>0,"Unmodeled author declaration certified: "+mode);
                UnityEngine.Object.DestroyImmediate(body);
            }
        }
        static void SourceShapeConsumers(bool reversed=false, bool constantLast=false)
        {
            foreach(var asset in new[]{"ConsumerMesh.asset","ConsumerBody.prefab","Consumers.prefab","Consumers.controller","ConsumerAvatar.prefab","ConsumerSet0.anim","ConsumerSet1.anim","ConsumerDelete0.anim","ConsumerDelete1.anim","ConsumerFine0.anim","ConsumerFine1.anim","ConsumerLocalSet0.anim","ConsumerLocalSet1.anim","ConsumerVendorGate0.anim","ConsumerVendorGate1.anim"}) AssetDatabase.DeleteAsset("Assets/Fixture/"+asset);
            var mesh=new Mesh {vertices=new[]{Vector3.zero,Vector3.right,Vector3.up,Vector3.forward,Vector3.right+Vector3.forward,Vector3.up+Vector3.forward},triangles=new[]{0,1,2,3,4,5},
                bindposes=new[]{Matrix4x4.identity},boneWeights=Enumerable.Range(0,6).Select(_=>new BoneWeight {boneIndex0=0,weight0=1}).ToArray()};
            mesh.AddBlendShapeFrame("Fit",100,new[]{Vector3.up*.05f,Vector3.up*.05f,Vector3.up*.05f,Vector3.up*.005f,Vector3.up*.005f,Vector3.up*.005f},new Vector3[6],new Vector3[6]);
            AssetDatabase.CreateAsset(mesh,"Assets/Fixture/ConsumerMesh.asset");
            var body=new GameObject("ConsumerBody");body.AddComponent<VRCAvatarDescriptor>();var bone=Child("Bone",body.transform).transform;
            var renderer=Child("Target",body.transform).AddComponent<SkinnedMeshRenderer>();renderer.sharedMesh=mesh;renderer.bones=new[]{bone};renderer.rootBone=bone;renderer.SetBlendShapeWeight(0,20);
            PrefabUtility.SaveAsPrefabAsset(body,"Assets/Fixture/ConsumerBody.prefab");UnityEngine.Object.DestroyImmediate(body);
            var source=new GameObject("Consumers");
            foreach(var name in new[]{"SetHost","DeleteHost"})
            {
                var host=Child(name,source.transform);var changer=host.AddComponent<ModularAvatarShapeChanger>();
                changer.Shapes.Add(new ChangedShape {Object=new AvatarObjectReference {referencePath="Target"},ShapeName="Fit",ChangeType=name=="SetHost"?ShapeChangeType.Set:ShapeChangeType.Delete,Value=80});
                if(name=="DeleteHost") changer.Threshold=.1f;
                host.SetActive(false);
            }
            var dormant=Child("FineHost",source.transform);dormant.SetActive(false);
            var fine=dormant.AddComponent<ModularAvatarShapeChanger>();fine.Threshold=.01f;
            fine.Shapes.Add(new ChangedShape {Object=new AvatarObjectReference {referencePath="Target"},ShapeName="Fit",ChangeType=ShapeChangeType.Delete});
            var permanent=Child("PermanentOff",source.transform);permanent.SetActive(false);
            var excluded=permanent.AddComponent<ModularAvatarShapeChanger>();excluded.Threshold=.001f;
            excluded.Shapes.Add(new ChangedShape {Object=new AvatarObjectReference {referencePath="Target"},ShapeName="Fit",ChangeType=ShapeChangeType.Delete});
            var disabledMenu=Child("DisabledMenuHost",source.transform);disabledMenu.SetActive(false);
            var disabledItem=disabledMenu.AddComponent<ModularAvatarMenuItem>();disabledItem.Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.Toggle,value=1};disabledItem.automaticValue=true;disabledItem.isDefault=true;
            var disabledChanger=disabledMenu.AddComponent<ModularAvatarShapeChanger>();disabledChanger.Threshold=.001f;
            disabledChanger.Shapes.Add(new ChangedShape {Object=new AvatarObjectReference {referencePath="Target"},ShapeName="Fit",ChangeType=ShapeChangeType.Delete});
            if(reversed)source.transform.Find("SetHost").SetSiblingIndex(1);
            var follower=Child("Follower",source.transform).AddComponent<SkinnedMeshRenderer>();follower.sharedMesh=mesh;follower.SetBlendShapeWeight(0,20);
            var localBone=Child("LocalBone",source.transform).transform;follower.bones=new[]{localBone};follower.rootBone=localBone;
            follower.gameObject.AddComponent<ModularAvatarBlendshapeSync>().Bindings.Add(new BlendshapeBinding {ReferenceMesh=new AvatarObjectReference {referencePath="Target"},Blendshape="Fit",RemapCurveIsValid=true,RemapCurve=AnimationCurve.Linear(0,0,100,200)});
            var second=Child("RecursiveFollower",source.transform).AddComponent<SkinnedMeshRenderer>();second.sharedMesh=mesh;second.bones=new[]{localBone};second.rootBone=localBone;
            second.gameObject.AddComponent<ModularAvatarBlendshapeSync>().Bindings.Add(new BlendshapeBinding {ReferenceMesh=new AvatarObjectReference {referencePath="_Outfit/Consumers/Follower"},Blendshape="Fit",RemapCurveIsValid=true,RemapCurve=AnimationCurve.Linear(0,0,100,50)});
            var localHost=Child("LocalSetHost",source.transform);localHost.SetActive(false);
            localHost.AddComponent<ModularAvatarShapeChanger>().Shapes.Add(new ChangedShape {Object=new AvatarObjectReference {referencePath="_Outfit/Consumers/Follower"},ShapeName="Fit",ChangeType=ShapeChangeType.Set,Value=60});
            Child("VendorGateMarker",source.transform).SetActive(false);
            var gated=Child("VisibleMenuHost",source.transform);
            gated.AddComponent<ModularAvatarMenuItem>().Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.Toggle,value=1,parameter=new VRCExpressionsMenu.Control.Parameter {name="VendorGate"}};
            gated.GetComponent<ModularAvatarMenuItem>().automaticValue=false;
            gated.AddComponent<ModularAvatarShapeChanger>().Shapes.Add(new ChangedShape {Object=new AvatarObjectReference {referencePath="_Outfit/Consumers/Follower"},ShapeName="Fit",ChangeType=ShapeChangeType.Set,Value=55});
            var autoOff=Child("VisibleAutomaticMenuHost",source.transform);
            var automatic=autoOff.AddComponent<ModularAvatarMenuItem>();automatic.Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.Toggle,value=1};automatic.automaticValue=true;automatic.isDefault=false;
            autoOff.AddComponent<ModularAvatarShapeChanger>().Shapes.Add(new ChangedShape {Object=new AvatarObjectReference {referencePath="Target"},ShapeName="Fit",ChangeType=ShapeChangeType.Set,Value=26});
            if(constantLast) Child("ConstantLastSetter",source.transform).AddComponent<ModularAvatarShapeChanger>().Shapes.Add(
                new ChangedShape {Object=new AvatarObjectReference {referencePath="Target"},ShapeName="Fit",ChangeType=ShapeChangeType.Set,Value=35});
            PrefabUtility.SaveAsPrefabAsset(source,"Assets/Fixture/Consumers.prefab");UnityEngine.Object.DestroyImmediate(source);
            var avatar=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Fixture/ConsumerBody.prefab"));
            var item=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Fixture/Consumers.prefab"));item.name="Consumers";item.transform.SetParent(Child("_Outfit",avatar.transform).transform,false);
            var controller=AnimatorController.CreateAnimatorControllerAtPath("Assets/Fixture/Consumers.controller");
            foreach(var parameter in new[]{"Set","Delete","Fine","LocalSet","VendorGate"})
            {
                controller.AddParameter(parameter,AnimatorControllerParameterType.Bool);controller.AddLayer(parameter);var layers=controller.layers;layers.Last().defaultWeight=1;controller.layers=layers;
                var machine=controller.layers.Last().stateMachine;var states=new List<AnimatorState>();
                for(var v=0;v<2;v++) {var clip=new AnimationClip {name=parameter+v};AnimationUtility.SetEditorCurve(clip,EditorCurveBinding.FloatCurve("_Outfit/Consumers/"+(parameter=="VendorGate"?"VendorGateMarker":parameter+"Host"),typeof(GameObject),"m_IsActive"),AnimationCurve.Constant(0,1,v));
                    AssetDatabase.CreateAsset(clip,"Assets/Fixture/Consumer"+parameter+v+".anim");var state=machine.AddState(clip.name);state.motion=clip;state.writeDefaultValues=false;states.Add(state);}
                machine.defaultState=states[0];var on=states[0].AddTransition(states[1]);on.duration=0;on.hasExitTime=false;on.AddCondition(AnimatorConditionMode.If,0,parameter);
                var off=states[1].AddTransition(states[0]);off.duration=0;off.hasExitTime=false;off.AddCondition(AnimatorConditionMode.IfNot,0,parameter);
            }
            var descriptor=avatar.GetComponent<VRCAvatarDescriptor>();descriptor.customizeAnimationLayers=true;descriptor.baseAnimationLayers=new[]{new VRCAvatarDescriptor.CustomAnimLayer {type=VRCAvatarDescriptor.AnimLayerType.FX,isDefault=false,animatorController=controller}};
            var plan=D("schema","plan/0.3","body_prefab","Assets/Fixture/ConsumerBody.prefab","avatar_config",D("schema","avatar-config/0.1",
                "instances",L(D("id","consumer","components",new[]{"Set","Delete","Fine","LocalSet","VendorGate"}.Select(n=>(object)D("id",n,"objects",L(n=="VendorGate"?"VendorGateMarker":n+"Host"))).ToList())),
                "groups",L(D("id","fixed","activation","fixed","members",L(D("id","consumer","instance","consumer")))),
                "shared_switches",new[]{"Set","Delete","Fine","LocalSet","VendorGate"}.Select(name=>(object)D("id",name,"default",false,"parameter",D("name",name,"type","Bool","saved",false,"synced",false),"targets",L(D("instance","consumer","component",name)))).ToList()));
            Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(plan));var record=D("outfits",L(D("id","consumer","instance","consumer","prefab","Assets/Fixture/Consumers.prefab","object","_Outfit/Consumers")));
            SourceShapeAudit.CaptureSources(plan,record);
            PrefabUtility.SaveAsPrefabAsset(avatar,"Assets/Fixture/ConsumerAvatar.prefab");UnityEngine.Object.DestroyImmediate(avatar);AssetDatabase.SaveAssets();
            AvatarAudit.OnBaked("Assets/Fixture/ConsumerAvatar.prefab",built=>{
                var sim=new AnimatorSim(built);var audit=SourceShapeAudit.For(built,plan,record);
                var events=new[]{new Dictionary<string,float>{{"Set",0},{"Delete",0},{"Fine",0},{"LocalSet",0}},new Dictionary<string,float>{{"Set",1},{"Delete",0},{"Fine",0},{"LocalSet",0}},
                    new Dictionary<string,float>{{"Set",1},{"Delete",0},{"Fine",0},{"LocalSet",1}},new Dictionary<string,float>{{"Set",1},{"Delete",1},{"Fine",0},{"LocalSet",0}},
                    new Dictionary<string,float>{{"Set",0},{"Delete",0},{"Fine",0},{"LocalSet",0},{"VendorGate",1}},
                    new Dictionary<string,float>{{"Set",0},{"Delete",0},{"Fine",0},{"LocalSet",0},{"VendorGate",0}}};
                foreach(var values in events)
                {var state=sim.Walk(new[]{values});var notes=new List<string>();var measured=audit.Check(built,state.Visible,state.WeightAt,state.Scale,notes,values);
                    Check(measured.failures==0&&measured.unknown==0,"Source Set/Delete/restore or follower semantics failed: "+string.Join(";",notes));
                    if(values["Delete"]==1&&!reversed&&!constantLast) Check(audit.Check(built,state.Visible,state.WeightAt,_=>Vector3.one,new List<string>(),values).failures>0,"Omitted Delete geometry escaped");
                    if(values["Delete"]==0) try {state.Apply(built);bool Visible(string path) {var t=AvatarAudit.Locate(built.transform,path);return t!=null&&t.gameObject.activeInHierarchy;}
                        var applied=audit.Check(built,Visible,(p,n)=>SourceShapeAudit.ReadWeight(built,p,n),SourceShapeAudit.ReadScale,new List<string>(),values);
                        Check(applied.failures==0&&applied.unknown==0,"Applied photo state lost Set/Delete geometry");}
                    finally {sim.Restore();}}
                foreach(var values in events) using(var pose=new MenuGroupAudit.NativePose(built,values))
                {bool Visible(string path) {var t=AvatarAudit.Locate(pose.Avatar.transform,path);return t!=null&&t.gameObject.activeInHierarchy;}
                    var readback=SourceShapeAudit.For(pose.Avatar,plan,record).Check(pose.Avatar,Visible,(p,n)=>SourceShapeAudit.ReadWeight(pose.Avatar,p,n),SourceShapeAudit.ReadScale,new List<string>(),values);
                    Check(readback.failures==0&&readback.unknown==0,"Native photo pose lost source effects");
                    pose.Avatar.transform.Find("Target").GetComponent<SkinnedMeshRenderer>().SetBlendShapeWeight(0,0);
                    Check(SourceShapeAudit.For(pose.Avatar,plan,record).Check(pose.Avatar,Visible,(p,n)=>SourceShapeAudit.ReadWeight(pose.Avatar,p,n),SourceShapeAudit.ReadScale,new List<string>(),values).failures>0,"Mutated native photo pose was certified");}
                var clone=UnityEngine.Object.Instantiate(built);var graph=UnityEngine.Playables.PlayableGraph.Create("Source Consumers");
                try
                {
                    var animator=clone.GetComponent<Animator>();if(animator==null)animator=clone.AddComponent<Animator>();animator.runtimeAnimatorController=null;animator.cullingMode=AnimatorCullingMode.AlwaysAnimate;
                    var fx=AvatarAudit.Layers(clone.GetComponent<VRCAvatarDescriptor>()).Single(l=>l.type==VRCAvatarDescriptor.AnimLayerType.FX).controller;
                    var playable=UnityEngine.Animations.AnimatorControllerPlayable.Create(graph,fx);var output=UnityEngine.Animations.AnimationPlayableOutput.Create(graph,"FX",animator);output.SetSourcePlayable(playable);
                    graph.SetTimeUpdateMode(UnityEngine.Playables.DirectorUpdateMode.Manual);graph.Play();var native=SourceShapeAudit.For(clone,plan,record);
                    foreach(var values in events)
                    {
                        foreach(var value in values)
                        {
                            var type=fx.parameters.Single(p=>p.name==value.Key).type;
                            if(type==AnimatorControllerParameterType.Bool)playable.SetBool(value.Key,value.Value!=0);
                            else if(type==AnimatorControllerParameterType.Int)playable.SetInteger(value.Key,(int)value.Value);
                            else playable.SetFloat(value.Key,value.Value);
                        }
                        for(var frame=0;frame<16;frame++) graph.Evaluate(1f/60);
                        bool Visible(string path) {var t=AvatarAudit.Locate(clone.transform,path);return t!=null&&t.gameObject.activeInHierarchy;}
                        var notes=new List<string>();var measured=native.Check(clone,Visible,(p,n)=>SourceShapeAudit.ReadWeight(clone,p,n),SourceShapeAudit.ReadScale,notes,values);
                        Check(measured.failures==0&&measured.unknown==0,"Native Set/Delete/restore failed: "+string.Join(";",notes));
                    }
                }
                finally {if(graph.IsValid())graph.Destroy();UnityEngine.Object.DestroyImmediate(clone);}
                var baseline=sim.Evaluate(new Dictionary<string,float>{{"Set",0},{"Delete",0}});var target=built.transform.Find("Target").GetComponent<SkinnedMeshRenderer>();var edited=target.sharedMesh;
                var saved=edited.vertices;var altered=(Vector3[])saved.Clone();altered[edited.GetIndices(0)[0]]+=Vector3.right;
                try {edited.vertices=altered;Check(audit.Check(built,baseline.Visible,baseline.WeightAt,baseline.Scale,new List<string>(),new Dictionary<string,float>{{"Set",0},{"Delete",0}}).failures>0,"In-place geometry edit reused a cached pass");}
                finally {edited.vertices=saved;}
                var indices=edited.GetIndices(0);var changedIndices=(int[])indices.Clone();changedIndices[0]=indices[3];
                try {edited.SetIndices(changedIndices,MeshTopology.Triangles,0);Check(audit.Check(built,baseline.Visible,baseline.WeightAt,baseline.Scale,new List<string>(),new Dictionary<string,float>{{"Set",0},{"Delete",0}}).failures>0,"Same-size index edit reused a cached pass");}
                finally {edited.SetIndices(indices,MeshTopology.Triangles,0);}
                if(!constantLast)
                {
                    var deletionValues=new Dictionary<string,float>{{"Set",0},{"Delete",1},{"Fine",0},{"LocalSet",0}};var deleting=sim.Evaluate(deletionValues);
                    var nanBone=Array.FindIndex(target.bones,b=>{for(var t=b;t!=null;t=t.parent)if(float.IsNaN(deleting.Scale(t).x))return true;return false;});
                    Check(nanBone>=0,"Dynamic deletion had no NaN bone");
                    using(var countsView=edited.GetBonesPerVertex())using(var weightsView=edited.GetAllBoneWeights())
                    using(var counts=new Unity.Collections.NativeArray<byte>(countsView,Unity.Collections.Allocator.Temp))
                    using(var weights=new Unity.Collections.NativeArray<BoneWeight1>(weightsView,Unity.Collections.Allocator.Temp))
                    using(var changedWeights=new Unity.Collections.NativeArray<BoneWeight1>(weights,Unity.Collections.Allocator.Temp))
                    {
                        var offset=counts.Take(3).Sum(n=>(int)n);var first=changedWeights[offset];first.boneIndex=nanBone;
                        var writableWeights=changedWeights;writableWeights[offset]=first;
                        try {edited.SetBoneWeights(counts,changedWeights);Check(audit.Check(built,deleting.Visible,deleting.WeightAt,deleting.Scale,new List<string>(),deletionValues).failures>0,"Same-size bone weight edit reused a cached pass");}
                        finally {edited.SetBoneWeights(counts,weights);}
                    }
                }
                var sourceRow=(Dictionary<string,object>)record.List("outfits")[0];var sourcePath=sourceRow["prefab"];
                try {sourceRow["prefab"]="Assets/Fixture/MissingSource.prefab";Check(SourceShapeAudit.For(built,plan,record).Check(built,baseline.Visible,baseline.WeightAt,baseline.Scale,new List<string>()).unknown>0,"Changed record reused source provenance");}
                finally {sourceRow["prefab"]=sourcePath;}
                var host=AvatarAudit.Locate(built.transform,"_Outfit/Consumers/SetHost");if(host!=null)UnityEngine.Object.DestroyImmediate(host.gameObject);
                target.SetBlendShapeWeight(0,20);AvatarAudit.Locate(built.transform,"_Outfit/Consumers/Follower").GetComponent<SkinnedMeshRenderer>().SetBlendShapeWeight(0,20);
                Check(audit.Check(built,p=>AvatarAudit.Locate(built.transform,p)?.gameObject.activeInHierarchy==true,(p,n)=>SourceShapeAudit.ReadWeight(built,p,n),SourceShapeAudit.ReadScale,new List<string>(),new Dictionary<string,float>{{"Set",1},{"Delete",0}}).failures>0,"Missing host and effect changed the oracle to OFF");
                ((Dictionary<string,object>)plan.Obj("avatar_config").List("shared_switches")[0])["default"]=true;
                Check(SourceShapeAudit.For(built,plan,record).Check(built,p=>AvatarAudit.Locate(built.transform,p)?.gameObject.activeInHierarchy==true,(p,n)=>SourceShapeAudit.ReadWeight(built,p,n),SourceShapeAudit.ReadScale,new List<string>()).failures>0,"Changed plan reused stale shape expectations");
                return true;
            });
        }
        static void ReadableAdapter(GameObject baked)
        {
            var fx = AvatarAudit.Layers(baked.GetComponent<VRCAvatarDescriptor>()).Single(x => x.type == VRCAvatarDescriptor.AnimLayerType.FX).controller;
            var groupClips = fx.animationClips.Where(c => c.name.Contains("hair_")).ToList();
            var source = groupClips.First();
            var bindings = AnimationUtility.GetCurveBindings(source).Where(b => b.type == typeof(GameObject) && b.propertyName == "m_IsActive").ToList();
            fx.AddParameter("__ModularAvatarInternal/One", AnimatorControllerParameterType.Float);
            var declaration = fx.parameters; declaration.Single(p => p.name == "__ModularAvatarInternal/One").defaultFloat = 1; fx.parameters = declaration;
            fx.AddLayer("Fixture DelayDisable"); var layers = fx.layers; var layer = layers[layers.Length-1]; layer.defaultWeight = 1;
            var state = layer.stateMachine.AddState("Delay"); state.writeDefaultValues = true; layer.stateMachine.defaultState = state; fx.layers = layers;
            var direct = new BlendTree {name="Derived delay",blendType=BlendTreeType.Direct}; state.motion = direct;
            var nullMotion = new AnimationClip {name="NullMotion"};
            var children = new List<ChildMotion>();
            foreach (var binding in bindings)
            {
                var proxy = "__MA/ActiveSelfProxy/Fixture/" + children.Count;
                fx.AddParameter(proxy,AnimatorControllerParameterType.Float);
                foreach (var clip in groupClips) AnimationUtility.SetEditorCurve(clip,EditorCurveBinding.FloatCurve("",typeof(Animator),proxy),AnimationUtility.GetEditorCurve(clip,binding));
                var on = new AnimationClip {name="On"};AnimationUtility.SetEditorCurve(on,binding,AnimationCurve.Constant(0,0,1));
                var buffer = new BlendTree {name="Buffer",blendType=BlendTreeType.Simple1D,blendParameter=proxy,useAutomaticThresholds=false};
                buffer.children = new[] {new ChildMotion{motion=nullMotion,threshold=0,timeScale=1},new ChildMotion{motion=nullMotion,threshold=.01f,timeScale=1},new ChildMotion{motion=on,threshold=1,timeScale=1}};
                children.Add(new ChildMotion{motion=buffer,directBlendParameter="__ModularAvatarInternal/One",timeScale=1});
            }
            direct.children=children.ToArray();
            Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["property_owners_resolved"],false),"ON-only adapter duplicate was not detected");
            var checkedBinding = bindings[0];
            var checkedProxy = EditorCurveBinding.FloatCurve("", typeof(Animator), ((BlendTree)direct.children[0].motion).blendParameter);
            var originalCurve = AnimationUtility.GetEditorCurve(source, checkedBinding);
            var originalProxy = AnimationUtility.GetEditorCurve(source, checkedProxy);
            AnimationUtility.SetEditorCurve(source, checkedBinding, AnimationCurve.Constant(0, 0, .5f));
            AnimationUtility.SetEditorCurve(source, checkedProxy, AnimationCurve.Constant(0, 0, .5f));
            var rejected = false;
            try { MenuGroups.FinalizeReadableProperties(baked); }
            catch (Exception error) { rejected = error.Message.Contains("完整二值曲线"); }
            Check(rejected && direct.children.Length == children.Count, "Nonbinary owner was normalized or partial changes escaped");
            AnimationUtility.SetEditorCurve(source, checkedBinding, originalCurve);
            AnimationUtility.SetEditorCurve(source, checkedProxy, null);
            rejected = false;
            try { MenuGroups.FinalizeReadableProperties(baked); }
            catch (Exception error) { rejected = error.Message.Contains("可读代理与完整业务曲线不同"); }
            Check(rejected && direct.children.Length == children.Count, "Missing proxy coverage was accepted");
            AnimationUtility.SetEditorCurve(source, checkedProxy, originalProxy);
            MenuGroups.FinalizeReadableProperties(baked);
            Check(direct.children.Length==0,"Redundant outputs survived normalization");
            Check(MenuGroupAudit.Assertions(baked,new List<string>())==0,"Complete ON/OFF changed after adapter normalization");
            Check(MenuGroupAudit.RuntimeAssertions(baked,new List<string>(),out _)==0,"Native ON/OFF changed after adapter normalization");
            MenuGroups.FinalizeReadableProperties(baked);Check(direct.children.Length==0,"Normalization was not idempotent");
        }
        static void UnsupportedMotions(GameObject baked, Dictionary<string,object> record)
        {
            var fx=AvatarAudit.Layers(baked.GetComponent<VRCAvatarDescriptor>()).Single(x=>x.type==VRCAvatarDescriptor.AnimLayerType.FX).controller;
            var layers=fx.layers;var parameters=fx.parameters;
            Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_coverage_complete"],true),"Unsupported motion probe started from an invalid baseline");
            // NDMF may lower both selector forms to trees; use surviving owned activation bindings.
            var ownedAncestors=new HashSet<string>();
            foreach(Dictionary<string,object> row in record.List("outfits"))foreach(var part in row.List("installed_parts"))
                for(var t=AvatarAudit.Locate(baked.transform,part.ToString())??AvatarAudit.Locate(baked.transform,row.Obj("built_paths")?.Str(part.ToString()));t!=null;t=t.parent)
                    ownedAncestors.Add(AnimationUtility.CalculateTransformPath(t,baked.transform));
            var dependencyMachine=fx.layers.Select(l=>l.stateMachine).First(m=>m.defaultState!=null&&AvatarAudit.Clips(m.defaultState.motion).Any(c=>
                AnimationUtility.GetCurveBindings(c).Any(b=>b.type==typeof(GameObject)&&b.propertyName=="m_IsActive"&&ownedAncestors.Contains(b.path))));
            var conditional=dependencyMachine.AddAnyStateTransition(dependencyMachine.defaultState);conditional.hasExitTime=false;conditional.duration=0;conditional.AddCondition(AnimatorConditionMode.Less,-1,"AuditDependency");
            var indirectClip=new AnimationClip {name="ConditionalParameterOnly"};AnimationUtility.SetEditorCurve(indirectClip,EditorCurveBinding.FloatCurve("",typeof(Animator),"AuditDependency"),AnimationCurve.Constant(0,1,0));
            var indirectTree=new BlendTree {name="ParameterOnly2D",blendType=BlendTreeType.FreeformCartesian2D,blendParameter="AuditX",blendParameterY="AuditY",children=new[]{new ChildMotion {motion=indirectClip,timeScale=1,position=Vector2.zero}}};
            try
            {
                foreach(var name in new[]{"AuditDependency","AuditX","AuditY"})fx.AddParameter(name,AnimatorControllerParameterType.Float);
                fx.AddLayer("Condition writer");var copy=fx.layers;copy.Last().defaultWeight=1;fx.layers=copy;copy.Last().stateMachine.AddState("2D").motion=indirectTree;
                var measured=MenuGroupAudit.Metrics(baked,new List<string>());
                Check(Equals(measured["menu_coverage_complete"],false)&&Equals(measured["property_owners_resolved"],true)
                    &&Equals(measured["group_state_assertion_failures"],0)&&Equals(measured["menu_parameter_contract"],true),"Unsupported parameter-only tree certified coverage: "+Avh.Json(measured));
            }
            finally {dependencyMachine.RemoveAnyStateTransition(conditional);fx.layers=layers;fx.parameters=parameters;UnityEngine.Object.DestroyImmediate(indirectTree);UnityEngine.Object.DestroyImmediate(indirectClip);}
            var harmless=new AnimationClip {name="UnrelatedGesture"};
            AnimationUtility.SetEditorCurve(harmless,EditorCurveBinding.FloatCurve("UnrelatedGesture",typeof(Transform),"m_LocalRotation.x"),AnimationCurve.Constant(0,1,0));
            var proxy=new AnimationClip {name="IndirectBusinessWriter"};
            AnimationUtility.SetEditorCurve(proxy,EditorCurveBinding.FloatCurve("",typeof(Animator),"AVH/Clothes"),AnimationCurve.Constant(0,1,0));
            var business=fx.animationClips.First(c=>AnimationUtility.GetCurveBindings(c).Any(b=>b.type==typeof(GameObject)&&b.propertyName=="m_IsActive"));
            var inner=new BlendTree {name="VendorCartesian",blendType=BlendTreeType.FreeformCartesian2D,blendParameter="ProbeX",blendParameterY="ProbeY",
                children=new[]{new ChildMotion {motion=harmless,position=Vector2.zero},new ChildMotion {motion=business,position=Vector2.one}}};
            var outer=new BlendTree {name="NestedVendorTree",blendType=BlendTreeType.Simple1D,blendParameter="ProbeX",children=new[]{new ChildMotion {motion=inner,threshold=0}}};
            try
            {
                fx.AddParameter("ProbeX",AnimatorControllerParameterType.Float);fx.AddParameter("ProbeY",AnimatorControllerParameterType.Float);
                fx.AddLayer("Vendor unrelated label");var copy=fx.layers;copy.Last().defaultWeight=1;fx.layers=copy;copy.Last().stateMachine.AddState("Nested").motion=outer;
                Check(BusinessMotionAudit.Unknown(baked,Avh.Plan(),record,new List<string>())>0,"Nested non-first business child escaped");
                Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_coverage_complete"],false),"Unsupported tree certified coverage");
                inner.children=new[]{new ChildMotion {motion=harmless,position=Vector2.zero}};
                Check(BusinessMotionAudit.Unknown(baked,Avh.Plan(),record,new List<string>())==0,"Unrelated gesture tree blocked business audit");
                inner.children=new[]{new ChildMotion {motion=harmless,position=Vector2.zero},new ChildMotion {motion=proxy,position=Vector2.one}};
                Check(BusinessMotionAudit.Unknown(baked,Avh.Plan(),record,new List<string>())>0,"Unsupported parameter writer escaped");
                AnimationUtility.SetEditorCurve(proxy,EditorCurveBinding.FloatCurve("",typeof(Animator),"AVH/Clothes"),null);
                AnimationUtility.SetEditorCurve(proxy,EditorCurveBinding.FloatCurve("",typeof(Animator),"NestedGate"),AnimationCurve.Constant(0,1,1));
                fx.AddParameter("NestedGate",AnimatorControllerParameterType.Float);
                var nested=copy.Last().stateMachine.AddStateMachine("NestedConditionalEntry");var nestedState=nested.AddState("Business");nestedState.motion=business;
                nested.AddEntryTransition(nestedState).AddCondition(AnimatorConditionMode.Greater,0,"NestedGate");
                Check(BusinessMotionAudit.Unknown(baked,Avh.Plan(),record,new List<string>())>0,"Nested entry dependency writer escaped");
                Check(BusinessMotionAudit.Unknown(baked,D("schema","plan/0.2"),record,new List<string>())==0,"Legacy path changed");
            }
            finally {fx.layers=layers;fx.parameters=parameters;UnityEngine.Object.DestroyImmediate(outer);UnityEngine.Object.DestroyImmediate(inner);UnityEngine.Object.DestroyImmediate(proxy);UnityEngine.Object.DestroyImmediate(harmless);}
        }
        static void DriverDependencies(GameObject baked, Dictionary<string, object> record)
        {
            var fx=AvatarAudit.Layers(baked.GetComponent<VRCAvatarDescriptor>()).Single(x=>x.type==VRCAvatarDescriptor.AnimLayerType.FX).controller;
            var layers=fx.layers;var parameters=fx.parameters;
            var clip=new AnimationClip {name="IndirectSharedWriter"};
            AnimationUtility.SetEditorCurve(clip,EditorCurveBinding.FloatCurve("",typeof(Animator),"AVH/Trim"),AnimationCurve.Constant(0,1,0));
            try
            {
                fx.AddParameter("IntermediateGate",AnimatorControllerParameterType.Float);fx.AddParameter("UnrelatedEvent",AnimatorControllerParameterType.Float);
                fx.AddLayer("Indirect consumer");var copy=fx.layers;copy.Last().defaultWeight=1;fx.layers=copy;
                var machine=copy.Last().stateMachine;var idle=machine.AddState("Idle");var writes=machine.AddState("ResetShared");writes.motion=clip;machine.defaultState=idle;
                var condition=machine.AddAnyStateTransition(writes);condition.AddCondition(AnimatorConditionMode.Greater,0,"IntermediateGate");
                fx.AddLayer("Single event owner");copy=fx.layers;copy.Last().defaultWeight=1;fx.layers=copy;
                var driver=copy.Last().stateMachine.AddState("Entry").AddStateMachineBehaviour<VRCAvatarParameterDriver>();
                driver.parameters.Add(new VRC_AvatarParameterDriver.Parameter {name="UnrelatedEvent",type=VRC_AvatarParameterDriver.ChangeType.Set,value=1});
                Check(BusinessMotionAudit.Unknown(baked,Avh.Plan(),record,new List<string>())==0,"Unrelated single Driver blocked group audit");
                driver.parameters[0].name="IntermediateGate";
                var notes=new List<string>();var metrics=MenuGroupAudit.Metrics(baked,notes);
                Check(Equals(metrics["menu_coverage_complete"],false)&&Equals(metrics["property_owners_resolved"],true)
                    &&notes.Any(n=>n.Contains("ParameterDriver")&&n.Contains("IntermediateGate")),"Single-layer Driver through intermediate parameter escaped certification");
                // Copy adds another edge backwards; the original event remains relevant through it.
                AnimationUtility.SetEditorCurve(clip,EditorCurveBinding.FloatCurve("",typeof(Animator),"AVH/Trim"),null);
                driver.parameters.Add(new VRC_AvatarParameterDriver.Parameter {name="AVH/Trim",source="IntermediateGate",type=VRC_AvatarParameterDriver.ChangeType.Copy});
                Check(BusinessMotionAudit.Unknown(baked,Avh.Plan(),record,new List<string>())>0,"Driver Copy dependency escaped");
            }
            finally {fx.layers=layers;fx.parameters=parameters;UnityEngine.Object.DestroyImmediate(clip);}
        }
        static void Mutations(GameObject baked, Dictionary<string, object> record)
        {
            UnsupportedMotions(baked,record);
            DriverDependencies(baked,record);
            MenuTreeMutations(baked,record);
            var descriptor = baked.GetComponent<VRCAvatarDescriptor>();
            var p = descriptor.expressionParameters.parameters.Single(x => x.name == "AVH/Clothes");
            p.saved = false;
            try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["menu_parameter_contract"], false), "Saved mutation escaped"); }
            finally { p.saved = true; }
            p.networkSynced = false;
            try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["menu_parameter_contract"], false), "Synced mutation escaped"); }
            finally { p.networkSynced = true; }
            var original = descriptor.expressionParameters.parameters;
            descriptor.expressionParameters.parameters = original.Concat(Enumerable.Range(0, 257).Select(i => new VRCExpressionParameters.Parameter { name = "Vendor" + i, networkSynced = true, valueType = VRCExpressionParameters.ValueType.Bool })).ToArray();
            try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["menu_parameter_limits"], false), "Vendor budget mutation escaped"); }
            finally { descriptor.expressionParameters.parameters = original; }
            var fx = AvatarAudit.Layers(descriptor).Single(x => x.type == VRCAvatarDescriptor.AnimLayerType.FX).controller;
            var clips = fx.animationClips.Where(c => c.name.Contains("clothes_")).ToList();
            var clip = clips.First(); var settings = AnimationUtility.GetAnimationClipSettings(clip); var savedLoop = settings.loopTime;
            if (p.valueType == VRCExpressionParameters.ValueType.Float)
            {
                settings.loopTime = true; AnimationUtility.SetAnimationClipSettings(clip, settings);
                try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["group_members_reachable"], false), "Loop mutation escaped"); }
                finally { settings.loopTime = savedLoop; AnimationUtility.SetAnimationClipSettings(clip, settings); }
            }
            foreach (var c in clips)
            {
                // Int states for other physical outfits need no material assertion on an invisible thin instance.
                if (p.valueType == VRCExpressionParameters.ValueType.Int && int.Parse(c.name.Split('_')[1]) > 2) continue;
                var binding = AnimationUtility.GetObjectReferenceCurveBindings(c).First(b => b.path.EndsWith("/Visual") && b.propertyName.EndsWith("[0]"));
                var keys = AnimationUtility.GetObjectReferenceCurve(c, binding); var changed = keys.ToArray();
                if (changed.Length > 2) changed[1].value = changed[2].value;
                else for (var i = 0; i < changed.Length; i++) changed[i].value = AssetDatabase.LoadAssetAtPath<Material>(keys[0].value == AssetDatabase.LoadAssetAtPath<Material>("Assets/Fixture/M1.mat") ? "Assets/Fixture/M2.mat" : "Assets/Fixture/M1.mat");
                Check(changed.Where((k, i) => k.value != keys[i].value).Any(), "Material mutation did not change a value");
                AnimationUtility.SetObjectReferenceCurve(c, binding, changed);
                try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["group_members_reachable"], false), "Distinct material member mutation escaped"); }
                finally { AnimationUtility.SetObjectReferenceCurve(c, binding, keys); }
            }
            var hairClip = fx.animationClips.Single(c => c.name.Contains("hair_"));
            var nondefault = AnimationUtility.GetCurveBindings(hairClip).First(b => b.path.EndsWith("/Visual7"));
            var savedCurve = AnimationUtility.GetEditorCurve(hairClip, nondefault);
            AnimationUtility.SetEditorCurve(hairClip, nondefault, null);
            try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["group_members_reachable"], false), "Nondefault relocated hair mutation escaped"); }
            finally { AnimationUtility.SetEditorCurve(hairClip, nondefault, savedCurve); }
            var missing = new Dictionary<string, object>(record); missing["outfits"] = record.List("outfits").Skip(1).ToList();
            var menu = Avh.ReadJsonFile(Avh.Abs(MenuStage.RecordPath)); var missingMenu = new Dictionary<string, object>(menu);
            missingMenu["controls"] = menu.List("controls").Where(c => ((Dictionary<string, object>)c).Str("member") != "m0").ToList();
            Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), missing); Avh.WriteJson(Avh.Abs(MenuStage.RecordPath), missingMenu);
            try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["menu_coverage_complete"], false), "Generator and record omission escaped independent config"); }
            finally { Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), record); Avh.WriteJson(Avh.Abs(MenuStage.RecordPath), menu); }
            var vector = AvatarConfig.Defaults(Avh.Plan()); vector["AVH/Clothes"] = 0; vector["AVH/Hair"] = 0;
            var wrongDefault = new AnimatorSim(baked).Evaluate(vector); wrongDefault.Apply(baked);
            try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["group_defaults_match"], false), "Global default mutation escaped per-group defaults"); }
            finally { new AnimatorSim(baked).Evaluate(AvatarConfig.Defaults(Avh.Plan())).Apply(baked); }
            var property = AnimationUtility.GetCurveBindings(hairClip).First();
            var duplicate = fx.layers[0].stateMachine; var layers = fx.layers;
            fx.AddLayer("Mutant second owner"); var updated = fx.layers; var last = updated[updated.Length - 1]; last.defaultWeight = 1;
            var state = last.stateMachine.AddState("Duplicate"); state.motion = hairClip; state.writeDefaultValues = false; last.stateMachine.defaultState = state; fx.layers = updated;
            try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["property_owners_resolved"], false), "Second property owner escaped"); }
            finally { fx.layers = layers; }
            var bindingReset = EditorCurveBinding.FloatCurve("", typeof(Animator), "AVH/Trim");
            AnimationUtility.SetEditorCurve(clip, bindingReset, AnimationCurve.Constant(0, 1, 1));
            try { Check(MenuGroupAudit.Assertions(baked, new List<string>()) > 0, "Shared reset mutation escaped incremental walk"); }
            finally { AnimationUtility.SetEditorCurve(clip, bindingReset, null); }
        }
        static void MenuTreeMutations(GameObject baked,Dictionary<string,object> record)
        {
            var root=baked.GetComponent<VRCAvatarDescriptor>().expressionsMenu;
            var vendor=root.controls.Single(c=>c.name=="Author Tools");var index=root.controls.IndexOf(vendor);
            root.controls.Remove(vendor);
            Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_coverage_complete"],false),"Deleted vendor submenu escaped independent inventory");root.controls.Insert(index,vendor);
            var supplied=root.controls.Single(c=>c.subMenu!=null&&c.subMenu.controls.Any(x=>x.name=="Forwarded")).subMenu;var forwarded=supplied.controls.Single(c=>c.name=="Forwarded");
            supplied.controls.Remove(forwarded);
            Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_coverage_complete"],false),"Deleted redirected vendor entry escaped independent inventory");supplied.controls.Add(forwarded);
            var style=root.controls.Single(c=>c.name=="造型").subMenu;
            var hair=style.controls.Single(c=>c.name=="Hair");var name=hair.name;
            hair.name="Misnamed";
            Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_coverage_complete"],false),"Renamed approved entry passed with its parameter intact");hair.name=name;
            style.controls.Remove(hair);vendor.subMenu.controls.Add(hair);
            Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_coverage_complete"],false),"Misgrouped approved entry passed with its parameter intact");
            vendor.subMenu.controls.Remove(hair);style.controls.Add(hair);
            Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_tree_matches"],true),"Restored menu tree did not recover");
        }
        static GameObject Child(string name, Transform parent) { var go = new GameObject(name); go.transform.SetParent(parent, false); return go; }
        static void AutomaticMenuMutations(GameObject baked)
        {
            var menu=baked.GetComponent<VRCAvatarDescriptor>().expressionsMenu.controls.Single(c=>c.name=="Supplier panel").subMenu;
            var toggle=menu.controls.Single(c=>c.name=="Lamp");
            Check(toggle.parameter.name=="SupplierLamp"&&toggle.value==1,"Frozen automatic Bool allocation did not match the build");
            var value=toggle.value;toggle.value=0;
            try { Check(MenuGroupAudit.Assertions(baked,new List<string>())>0,"Automatic Bool zero value escaped final assertions"); }
            finally {toggle.value=value;}
            toggle.value=value-.00001f;
            try {Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_tree_matches"],false),"Automatic allocation used a wildcard numeric tolerance");}
            finally {toggle.value=value;}
            var parameter=toggle.parameter.name;
            foreach(var invalid in new[]{"","DetailSwitch"})
            {
                toggle.parameter.name=invalid;
                try {Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_tree_matches"],false),"Automatic parameter corruption escaped final metrics");}
                finally {toggle.parameter.name=parameter;}
            }
            Check(menu.controls.Single(c=>c.name=="First").value==1&&menu.controls.Single(c=>c.name=="Next").value==3,
                "Automatic Int allocation ignored the reserved default");
            var next=menu.controls.Single(c=>c.name=="Next");var allocated=next.value;next.value=2;
            try {Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_tree_matches"],false),"Automatic Int reserved value escaped final metrics");}
            finally {next.value=allocated;}
            Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_tree_matches"],true),"Restored automatic allocation did not recover");
            var proof=Avh.ReadJsonFile(Path.Combine(Avh.RunDir,"observations","menu-tree-readback.json"));
            var row=proof.List("source_entries").Cast<Dictionary<string,object>>().Single(r=>r.List("path").Last().ToString()=="Lamp");
            Check(Convert.ToSingle(row["value"])==1&&row.List("parameter_mapping").SequenceEqual(new object[]{"SupplierLamp","SupplierLamp"}),"Frozen allocation proof is absent");
            Avh.WriteJson(Avh.Abs("auto-proven-readback.json"),proof);
        }
        static void SingleInteger(bool unresolvedName=false)
        {
            UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene,UnityEditor.SceneManagement.NewSceneMode.Single);
            AssetDatabase.DeleteAsset("Assets/_Harness");AssetDatabase.DeleteAsset("Assets/Fixture");OutfitStage.EnsureFolder("Assets/Fixture");
            var body=RecolorMaterialIntegration.Human();var descriptor=body.AddComponent<VRCAvatarDescriptor>();descriptor.customExpressions=true;
            descriptor.expressionParameters=ScriptableObject.CreateInstance<VRCExpressionParameters>();descriptor.expressionParameters.parameters=new[]{
                new VRCExpressionParameters.Parameter {name="SupplierLamp",valueType=VRCExpressionParameters.ValueType.Bool},
                new VRCExpressionParameters.Parameter {name="SupplierChoice",valueType=VRCExpressionParameters.ValueType.Int,defaultValue=2}};
            descriptor.expressionsMenu=ScriptableObject.CreateInstance<VRCExpressionsMenu>();
            var panel=Child("Supplier panel",body.transform);panel.AddComponent<ModularAvatarMenuInstaller>();
            var folder=panel.AddComponent<ModularAvatarMenuItem>();folder.Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.SubMenu};folder.MenuSource=SubmenuSource.Children;
            folder.automaticValue=true; // This folder's unused value must not hide its children's exact allocations.
            foreach(var name in new[]{"Lamp","First","Next"})
            {
                var item=Child(name,panel.transform).AddComponent<ModularAvatarMenuItem>();item.automaticValue=true;
                item.Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.Toggle,value=42,
                    parameter=new VRCExpressionsMenu.Control.Parameter {name=name=="Lamp"?"SupplierLamp":"SupplierChoice"}};
                if(unresolvedName&&name=="Lamp") {item.Control.parameter.name="";item.gameObject.AddComponent<ModularAvatarObjectToggle>();}
            }
            AssetDatabase.CreateAsset(descriptor.expressionParameters,"Assets/Fixture/OneParams.asset");AssetDatabase.CreateAsset(descriptor.expressionsMenu,"Assets/Fixture/OneMenu.asset");
            PrefabUtility.SaveAsPrefabAsset(body,"Assets/Fixture/OneBody.prefab");UnityEngine.Object.DestroyImmediate(body);
            var source=new GameObject("OneSource");var visual=GameObject.CreatePrimitive(PrimitiveType.Cube);visual.name="Detail";visual.transform.SetParent(source.transform,false);
            visual.AddComponent<ModularAvatarBoneProxy>().boneReference=HumanBodyBones.Head;
            PrefabUtility.SaveAsPrefabAsset(source,"Assets/Fixture/OneItem.prefab");UnityEngine.Object.DestroyImmediate(source);
            var plan=D("schema","plan/0.3","body_prefab","Assets/Fixture/OneBody.prefab","avatar_config",D("schema","avatar-config/0.1",
                "instances",L(D("id","only","prefab","Assets/Fixture/OneItem.prefab","components",L(D("id","detail","objects",L("Detail"))))),
                "groups",L(D("id","singleton","label","Single choice","activation","exclusive","selector","discrete","parameter",Parameter("OnlyChoice","Int"),"default","one",
                    "members",L(D("id","one","instance","only","label","Only member")))),
                "shared_switches",L(D("id","detail","label","Detail switch","default",true,"parameter",Parameter("DetailSwitch","Bool"),"targets",L(D("instance","only","component","detail"))))),
                "menu",D("mode","assemble","vendor_policy","preserve_and_merge","tree",L(D("id","nested","label","Nested","children",L(D("group","singleton"),D("shared_switch","detail"))))));
            // Multiple approved entrances share one memory channel; overflow pagination changes no semantic path.
            var entrances=((Dictionary<string,object>)plan.Obj("menu").List("tree")[0]).List("children");
            for(var i=0;i<8;i++)entrances.Add(D("shared_switch","detail"));
            Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(plan));plan=Avh.Plan();
            var avatar=OutfitStage.Assemble(AssetDatabase.LoadAssetAtPath<GameObject>(plan.Str("body_prefab")),plan,out var hidden,out var rows);
            var record=D("avatar_config",plan.Obj("avatar_config"),"outfits",rows,"hidden_body_parts",hidden);OutfitStage.EnsureFolder(OutfitStage.Dir);Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath),record);
            var controller=MenuGroups.Compile(avatar,plan,record);
            Check(controller.layers.SelectMany(l=>AvatarAudit.States(l.stateMachine)).All(s=>!s.timeParameterActive),"Single Int used Motion Time instead of constant states");
            Check(controller.animationClips.SelectMany(AnimationUtility.GetCurveBindings).All(b=>controller.animationClips.Where(c=>AnimationUtility.GetCurveBindings(c).Contains(b))
                .All(c=>AnimationUtility.GetEditorCurve(c,b).keys.Select(k=>k.value).Distinct().Count()==1)),"Single Int clips are not constant");
            PrefabUtility.SaveAsPrefabAsset(avatar,MenuStage.AvatarPath);UnityEngine.Object.DestroyImmediate(avatar);
            AvatarAudit.OnBaked(MenuStage.AvatarPath,baked=>
            {
                if(unresolvedName)
                {
                    var lamp=baked.GetComponent<VRCAvatarDescriptor>().expressionsMenu.controls.Single(c=>c.name=="Supplier panel").subMenu.controls.Single(c=>c.name=="Lamp");
                    var allocatedName=lamp.parameter.name;
                    Check(!string.IsNullOrEmpty(allocatedName),"The generated parameter fixture did not actually allocate a name");
                    foreach(var invalid in new[]{"","DetailSwitch"})
                    {
                        lamp.parameter.name=invalid;
                        try {Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_tree_matches"],false),"Generated automatic parameter corruption escaped final metrics");}
                        finally {lamp.parameter.name=allocatedName;}
                    }
                    Check(Equals(MenuGroupAudit.Metrics(baked,new List<string>())["menu_coverage_complete"],false),"Unproven generated parameter escaped final metrics");
                    Check(MenuGroupAudit.Assertions(baked,new List<string>())>0,"Unproven generated parameter escaped final assertions");
                    var proof=Avh.ReadJsonFile(Path.Combine(Avh.RunDir,"observations","menu-tree-readback.json"));
                    Check(Convert.ToInt32(proof["unknown"])>0,"Unproven generated parameter was not reported unknown");
                    Check(proof.List("source_entries").Cast<Dictionary<string,object>>().Single(r=>r.List("path").Last().ToString()=="Lamp").Str("allocation_status")=="unknown",
                        "Unproven allocation published an identity mapping");
                    return 0;
                }
                AutomaticMenuMutations(baked);
                var notes=new List<string>();Check(MenuGroupAudit.Metrics(baked,notes).Where(p=>p.Value is bool).All(p=>Equals(p.Value,true)),"Single Int build contract failed: "+string.Join(";",notes));
                Check(MenuGroupAudit.RuntimeAssertions(baked,notes,out var steps)==0&&steps>0,"Single Int native readback failed: "+string.Join(";",notes));
                foreach(var on in new[]{false,true,false,true})
                {
                    var values=AvatarConfig.Defaults(plan);values["DetailSwitch"]=on?1:0;
                    using(var pose=new MenuGroupAudit.NativePose(baked,values))
                        Check(MenuGroupAudit.AssertState(pose.Avatar,plan,record,values,p=>AvatarAudit.Locate(pose.Avatar.transform,p)?.gameObject.activeInHierarchy==true,
                            (p,s)=>AvatarAudit.Locate(pose.Avatar.transform,p)?.GetComponent<Renderer>()?.sharedMaterials.ElementAtOrDefault(s),notes)==0,"Single Int native conditional state failed");
                }
                return 0;
            });
        }
        static void Scenario(bool integer)
        {
            UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Single);
            AssetDatabase.DeleteAsset("Assets/_Harness"); AssetDatabase.DeleteAsset("Assets/Fixture"); AssetDatabase.DeleteAsset("Assets/Authorized");
            OutfitStage.EnsureFolder("Assets/Fixture"); OutfitStage.EnsureFolder("Assets/Authorized");
            var body = RecolorMaterialIntegration.Human();
            var descriptor = body.AddComponent<VRCAvatarDescriptor>(); descriptor.ViewPosition = new Vector3(0, 1.6f, 0); descriptor.customExpressions = true;
            descriptor.expressionParameters = ScriptableObject.CreateInstance<VRCExpressionParameters>(); descriptor.expressionParameters.parameters = new VRCExpressionParameters.Parameter[0];
            descriptor.expressionsMenu = ScriptableObject.CreateInstance<VRCExpressionsMenu>();
            AssetDatabase.CreateAsset(descriptor.expressionParameters, "Assets/Fixture/Params.asset"); AssetDatabase.CreateAsset(descriptor.expressionsMenu, "Assets/Fixture/Menu.asset");
            var vendorMenu=ScriptableObject.CreateInstance<VRCExpressionsMenu>();vendorMenu.controls.Add(new VRCExpressionsMenu.Control {name="Inspect",type=VRCExpressionsMenu.Control.ControlType.Button});
            AssetDatabase.CreateAsset(vendorMenu,"Assets/Fixture/AuthorMenu.asset");descriptor.expressionsMenu.controls.Add(new VRCExpressionsMenu.Control {name="Author Tools",type=VRCExpressionsMenu.Control.ControlType.SubMenu,subMenu=vendorMenu});
            EditorUtility.SetDirty(descriptor.expressionsMenu);
            // Explicit adoption preserves a public vendor Bool and its complete ON/OFF consumer.
            var vendor = AnimatorController.CreateAnimatorControllerAtPath("Assets/Fixture/Vendor.controller");
            vendor.AddParameter("AVH/Acc/m9", AnimatorControllerParameterType.Bool);
            descriptor.expressionParameters.parameters = new[] { new VRCExpressionParameters.Parameter { name = "AVH/Acc/m9", valueType = VRCExpressionParameters.ValueType.Bool, defaultValue = 0, saved = true, networkSynced = true } };
            descriptor.customizeAnimationLayers = true;
            descriptor.baseAnimationLayers = new[] { new VRCAvatarDescriptor.CustomAnimLayer { type = VRCAvatarDescriptor.AnimLayerType.FX, isDefault = false, animatorController = vendor } };
            var vendorStates = new List<AnimatorState>();
            for (var v = 0; v < 2; v++)
            {
                var c = new AnimationClip { name = "Vendor_" + v };
                foreach (var path in new[] { "_Outfit/Outfit_m9", "_Outfit/Outfit_m9/Visual9" })
                    AnimationUtility.SetEditorCurve(c, EditorCurveBinding.FloatCurve(path, typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1, v));
                AssetDatabase.CreateAsset(c, "Assets/Fixture/Vendor" + v + ".anim");
                var s = vendor.layers[0].stateMachine.AddState(c.name); s.motion = c; s.writeDefaultValues = false; vendorStates.Add(s);
            }
            vendor.layers[0].stateMachine.defaultState = vendorStates[0];
            var turnOn = vendorStates[0].AddTransition(vendorStates[1]); turnOn.hasExitTime = false; turnOn.duration = 0; turnOn.AddCondition(AnimatorConditionMode.If, 0, "AVH/Acc/m9");
            var turnOff = vendorStates[1].AddTransition(vendorStates[0]); turnOff.hasExitTime = false; turnOff.duration = 0; turnOff.AddCondition(AnimatorConditionMode.IfNot, 0, "AVH/Acc/m9");
            EditorUtility.SetDirty(descriptor.expressionParameters); EditorUtility.SetDirty(vendor); AssetDatabase.SaveAssets();
            var materials = Enumerable.Range(0, 3).Select(i => { var m = new Material(Shader.Find("Standard")); m.color = i == 0 ? Color.black : i == 1 ? Color.magenta : Color.white; AssetDatabase.CreateAsset(m, "Assets/Fixture/M" + i + ".mat"); return m; }).ToArray();
            PrefabUtility.SaveAsPrefabAsset(body, "Assets/Fixture/Body.prefab"); UnityEngine.Object.DestroyImmediate(body);
            var instances = new List<object>(); var clothes = new List<object>(); var hair = new List<object>(); var accessories = new List<object>();
            for (var i = 0; i < 16; i++)
            {
                var source = new GameObject("Item");
                if(i==5)
                {
                    source.AddComponent<ModularAvatarMenuInstaller>();var folder=source.AddComponent<ModularAvatarMenuItem>();
                    folder.Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.SubMenu};folder.MenuSource=SubmenuSource.Children;
                    var entry=Child("Author entry",source.transform).AddComponent<ModularAvatarMenuItem>();entry.Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.Button};entry.enabled=false;
                    var excluded=Child("Preview entry",source.transform);excluded.tag="EditorOnly";excluded.AddComponent<ModularAvatarMenuItem>().Control=new VRCExpressionsMenu.Control {type=VRCExpressionsMenu.Control.ControlType.Button};
                    var supplied=ScriptableObject.CreateInstance<VRCExpressionsMenu>();supplied.controls.Add(new VRCExpressionsMenu.Control {name="Forwarded",type=VRCExpressionsMenu.Control.ControlType.Button});
                    AssetDatabase.CreateAsset(supplied,"Assets/Fixture/SuppliedMenu.asset");
                    var supplier=Child("Detached supplier",source.transform).AddComponent<ModularAvatarMenuInstaller>();supplier.menuToAppend=supplied;
                    var targetType=typeof(ModularAvatarMenuInstaller).Assembly.GetType("nadena.dev.modular_avatar.core.ModularAvatarMenuInstallTarget");
                    var redirect=Child("Inline reference",source.transform).AddComponent(targetType);targetType.GetField("installer").SetValue(redirect,supplier);
                }
                var visual = GameObject.CreatePrimitive(PrimitiveType.Cube); visual.name = i < 3 ? "Visual" : i == 3 || i == 4 ? "VisualAlternate" : "Visual" + i; visual.transform.SetParent(source.transform, false);
                visual.GetComponent<Renderer>().sharedMaterial = materials[i < 3 ? i : 0]; visual.AddComponent<ModularAvatarBoneProxy>().boneReference = HumanBodyBones.Head;
                var trim = GameObject.CreatePrimitive(PrimitiveType.Cube); trim.name = "Trim"; trim.transform.SetParent(source.transform, false); trim.GetComponent<Renderer>().sharedMaterial = materials[0];
                var path = "Assets/Fixture/P" + i + ".prefab"; PrefabUtility.SaveAsPrefabAsset(source, path); UnityEngine.Object.DestroyImmediate(source);
                var id = "m" + i; var inst = i < 3 ? "colors" : i == 3 || i == 4 ? "alternate" : "i" + i;
                if (i == 0 || i >= 3 && i != 4)
                {
                    var variants = i == 0 ? L(D("id", "v0", "prefab", "Assets/Fixture/P0.prefab"), D("id", "v1", "prefab", "Assets/Fixture/P1.prefab"), D("id", "v2", "prefab", "Assets/Fixture/P2.prefab"))
                        : i == 3 ? L(D("id", "v3", "prefab", "Assets/Fixture/P3.prefab"), D("id", "v4", "prefab", "Assets/Fixture/P4.prefab")) : L();
                    instances.Add(D("id", inst, "kind", i < 7 ? "outfit" : i < 9 ? "hair" : "accessory", "item", "input" + i, "prefab", path,
                        "variants", variants, "components", i == 0 ? L(D("id", "trim", "objects", L("Visual"))) : L()));
                }
                if (i == 3) inst = "alternate";
                var member = D("id", id, "instance", inst, "label", "Same label");
                if (i < 5) member["variant"] = "v" + i;
                if (i < 7) clothes.Add(member); else if (i < 9) hair.Add(member); else { member["default"] = i == 10; member["parameter"] = Parameter("AVH/Acc/" + id, "Bool"); if (i == 9) member.Obj("parameter")["adopt"] = true; accessories.Add(member); }
            }
            var plan = D("schema", "plan/0.3", "body_prefab", "Assets/Fixture/Body.prefab", "face", D("mode", "preserve"),
                "avatar_config", D("schema", "avatar-config/0.1", "instances", instances, "groups", L(
                    D("id", "clothes", "label", "Clothes", "activation", "exclusive", "selector", integer ? "discrete" : "radial", "parameter", Parameter("AVH/Clothes", integer ? "Int" : "Float"), "default", "m2", "members", clothes),
                    D("id", "hair", "label", "Hair", "activation", "exclusive", "selector", "radial", "parameter", Parameter("AVH/Hair", "Float"), "default", "m8", "members", hair),
                    D("id", "accessories", "label", "Accessories", "activation", "independent", "members", accessories)),
                    "shared_switches", L(D("id", "trim", "label", "Trim", "default", true, "parameter", Parameter("AVH/Trim", "Bool"), "targets", L(D("instance", "colors", "component", "trim"))))),
                "menu", D("mode", "assemble", "vendor_policy", "preserve_and_merge", "tree", L(D("group", "clothes"), D("group", "hair"), D("group", "accessories"), D("shared_switch", "trim"))));
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan)); plan = Avh.Plan();
            var assembled = OutfitStage.Assemble(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Fixture/Body.prefab"), plan, out var hidden, out var rows);
            var record = D("schema", "outfit/0.4", "avatar_config", plan.Obj("avatar_config"), "outfits", rows, "body_prefab", plan.Str("body_prefab"), "hidden_body_parts", hidden);
            Check(rows.Count == 16, "Semantic member lost");
            var s0 = VariantResolver.Structure(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Fixture/P0.prefab")).Split('\n');
            var s1 = VariantResolver.Structure(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Fixture/P1.prefab")).Split('\n');
            Check(rows.Cast<Dictionary<string, object>>().Select(r => r.Str("object")).Distinct().Count() == 13,
                "Verified material variants were not thin: " + string.Join(";", s0.Zip(s1, (a, b) => a == b ? null : a + " <> " + b).Where(x => x != null).Take(8)));
            OutfitStage.EnsureFolder(OutfitStage.Dir); Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), record);
            Check(OutfitMeasure.GroupDefaults(assembled, record, plan, new List<string>()), "Assembly default vector disagrees");
            PrefabUtility.SaveAsPrefabAsset(assembled, OutfitStage.AvatarPath); UnityEngine.Object.DestroyImmediate(assembled);
            OutfitStage.EnsureFolder(RecolorStage.Dir);
            var adjustments = L(D("part", "outfit:m1", "hue_shift", 30, "saturation", 1, "value", 1),
                D("part", "outfit:m2", "hue_shift", 0, "saturation", 1, "value", .8), D("part", "hair", "hue_shift", 0, "saturation", 1, "value", 1));
            plan["recolor"] = D("targets", adjustments, "candidates", 1); Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
            Avh.WriteJson(Avh.Abs(RecolorStage.RecipePath), D("schema", "recolor-recipe/0.2", "targets", adjustments,
                "tiers", L(D("id", "A", "label", "Source", "adjustments", adjustments)), "chosen", "A", "reason", "Integration fixture"));
            RecolorStage.Produce();
            RecolorStage.MaterialTargetReadback();
            var relativeReadback = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations", "material-selection-readback.json"));
            Check(relativeReadback.List("relative_bindings").Count == 8, "Relative member and installed hair readback incomplete");
            var ledger = Avh.ReadJsonFile(Avh.Abs(RecolorStage.LedgerPath));
            Check(ledger.List("rows").Cast<Dictionary<string, object>>().Any(r => r.Str("member") == "m1"), "Thin member recolor scope lost");
            Check(ledger.List("rows").Cast<Dictionary<string, object>>().Count(r => r.Str("part") == "hair") == 4, "Installed hair group omitted from recolor");
            foreach (var file in Directory.GetFiles(Path.Combine(Avh.RunDir, "candidates"), "*.json"))
                Check(Avh.ReadJsonFile(file).Obj("avatar_state")?.Count == AvatarConfig.Defaults(plan).Count, "Candidate omitted full avatar state");
            var materialTargets = L(D("requirement_id", "pink", "outfit", "m1", "material", "Assets/Fixture/M1.mat"),
                D("requirement_id", "white", "outfit", "m2", "material", "Assets/Fixture/M2.mat"));
            plan["recolor"] = D("targets", materialTargets, "candidates", 1); Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
            Avh.WriteJson(Avh.Abs(RecolorStage.RecipePath), D("schema", "recolor-recipe/0.2", "targets", L(), "materialOps", materialTargets,
                "tiers", L(D("id", "A", "label", "Preset", "adjustments", L())), "chosen", "A", "reason", "Separate thin member presets"));
            RecolorStage.Produce(); RecolorStage.MaterialTargetReadback();
            var readbackPath = Path.Combine(Avh.RunDir, "observations", "material-selection-readback.json");
            var readback = Avh.ReadJsonFile(readbackPath);
            Check(readback.List("bindings").Cast<Dictionary<string, object>>().All(b => b.Str("expected_guid") == b.Str("actual_guid")), "Thin material presets did not independently reload");
            var presetClip = AssetDatabase.LoadAssetAtPath<AnimationClip>(RecolorStage.PresetPath("m1"));
            var presetBinding = AnimationUtility.GetObjectReferenceCurveBindings(presetClip).First();
            var presetKeys = AnimationUtility.GetObjectReferenceCurve(presetClip, presetBinding);
            AnimationUtility.SetObjectReferenceCurve(presetClip, presetBinding, new[] { new ObjectReferenceKeyframe {time=0,value=materials[0]} });
            RecolorStage.MaterialTargetReadback();
            Check(Avh.ReadJsonFile(readbackPath).List("bindings").Cast<Dictionary<string, object>>().Any(b => b.Str("expected_guid") != b.Str("actual_guid")), "Persistent preset mutation trusted ledger");
            AnimationUtility.SetObjectReferenceCurve(presetClip, presetBinding, presetKeys); AssetDatabase.SaveAssets();
            RecolorStage.MaterialTargetReadback();
            assembled = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath));
            var adoptedSpec = AvatarConfig.Groups(plan).Single(g => g.Str("id") == "accessories").List("members").Cast<Dictionary<string, object>>().First().Obj("parameter");
            adoptedSpec["adopt"] = false;
            try { MenuGroups.Compile(assembled, plan, record); Check(false, "Unapproved parameter collision was adopted"); }
            catch (Exception e) { Check(e.Message.Contains("参数") && !e.Message.Contains("Unapproved"), "Unexpected collision rejection: " + e.Message); }
            finally { adoptedSpec["adopt"] = true; }
            var sourceParameter = assembled.GetComponent<VRCAvatarDescriptor>().expressionParameters.parameters.Single(p => p.name == "AVH/Acc/m9");
            sourceParameter.saved = false;
            try { MenuGroups.Compile(assembled, plan, record); Check(false, "Adoption with incompatible persistence escaped"); }
            catch (Exception e) { Check(e.Message.Contains("合同") && !e.Message.Contains("escaped"), "Unexpected adoption rejection: " + e.Message); }
            finally { sourceParameter.saved = true; }
            var compiled = MenuGroups.Compile(assembled, plan, record);
            Debug.Log("Group clip durations: " + string.Join(";", compiled.animationClips.Select(c => c.name + ":" + c.length.ToString("R"))));
            PrefabUtility.SaveAsPrefabAsset(assembled, MenuStage.AvatarPath); UnityEngine.Object.DestroyImmediate(assembled);
            var sourceAvatar = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(MenuStage.AvatarPath));
            try { Check(Equals(MenuGroupAudit.Metrics(sourceAvatar, new List<string>())["menu_coverage_complete"], false), "Source menu was accepted as built evidence"); }
            finally { UnityEngine.Object.DestroyImmediate(sourceAvatar); }
            AvatarAudit.OnBaked(MenuStage.AvatarPath, baked =>
            {
                var notes = new List<string>(); var metrics = MenuGroupAudit.Metrics(baked, notes);
                Check(metrics.Where(p => p.Value is bool).All(p => Equals(p.Value, true)), "Built contracts: " + Avh.Json(metrics) + " " + string.Join(";", notes));
                Check(MenuGroupAudit.Cells(plan).Count == 3584, "Logical coverage differs");
                Check(MenuGroupAudit.Assertions(baked, notes, true) == 0, "Full coverage: " + string.Join(";", notes));
                Check(MenuGroupAudit.RuntimeAssertions(baked, notes, out var runtimeSteps) == 0, "Native Animator readback: " + string.Join(";", notes));
                Check(runtimeSteps > 50, "Native Animator did not visit all members and switch events");
                ReadableAdapter(baked);
                var sim = new AnimatorSim(baked);
                foreach (var state in MenuGroupAudit.Samples(plan))
                {
                    var snap = sim.Evaluate(state);
                    Check(MenuGroupAudit.AssertState(baked, plan, record, state, snap.Visible, snap.MaterialAt, notes) == 0, "Per-member readback: " + string.Join(";", notes));
                }
                // Same missing member in compiler record and controls must still fail against the accepted config.
                var omitted = new Dictionary<string, object>(record); omitted["outfits"] = rows.Skip(1).ToList();
                var defaults = AvatarConfig.Defaults(plan); var snapshot = sim.Evaluate(defaults);
                Check(MenuGroupAudit.AssertState(baked, plan, omitted, defaults, snapshot.Visible, snapshot.MaterialAt, notes) > 0, "Independent observer trusted omitted record");
                Mutations(baked, record);
                return 0;
            });
        }
        public static void Run()
        {
            try { NetworkRepresentatives(); SourceShapesAndLiveLog(); IndependentSourceOwners(); UnsupportedSourceDeclarations(); SourceShapeConsumers(); SourceShapeConsumers(true); SourceShapeConsumers(false,true); Scenario(false); Scenario(true); SingleInteger(); SingleInteger(true); Avh.WriteJson(Avh.Abs(Avh.Env("AVH_MENU_GROUPS_RESULT", "result.json")), D("ok", true, "assertions", assertions)); EditorApplication.Exit(0); }
            catch (Exception e) { Avh.WriteJson(Avh.Abs(Avh.Env("AVH_MENU_GROUPS_RESULT", "result.json")), D("ok", false, "error", e.ToString(), "assertions", assertions)); Debug.LogException(e); EditorApplication.Exit(1); }
        }
        public static void RunAutomaticAllocation()
        {
            try {SingleInteger();SingleInteger(true);Avh.WriteJson(Avh.Abs(Avh.Env("AVH_MENU_GROUPS_RESULT","result.json")),D("ok",true,"assertions",assertions));EditorApplication.Exit(0);}
            catch(Exception e) {Avh.WriteJson(Avh.Abs(Avh.Env("AVH_MENU_GROUPS_RESULT","result.json")),D("ok",false,"error",e.ToString(),"assertions",assertions));Debug.LogException(e);EditorApplication.Exit(1);}
        }
        public static void RunUnprovenAllocation()
        {
            try {SingleInteger(true);Avh.WriteJson(Avh.Abs(Avh.Env("AVH_MENU_GROUPS_RESULT","result.json")),D("ok",true,"assertions",assertions));EditorApplication.Exit(0);}
            catch(Exception e) {Avh.WriteJson(Avh.Abs(Avh.Env("AVH_MENU_GROUPS_RESULT","result.json")),D("ok",false,"error",e.ToString(),"assertions",assertions));Debug.LogException(e);EditorApplication.Exit(1);}
        }
    }
}
