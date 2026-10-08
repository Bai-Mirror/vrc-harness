using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;

namespace AVH.Harness
{
    public static class VendorMissingMaterialIntegration
    {
        static int assertions;
        static readonly string MissingGuid = new string('d', 32);
        static readonly string MissingMeshGuid = new string('e', 32);
        static readonly string MissingTextureGuid = new string('f', 32);
        const string Folder = "Assets/VendorFixture";
        const string UnlocatedFolder = "Assets/UnlocatedFixture";
        const string UnlocatedPath = UnlocatedFolder+"/UnlocatedBody.prefab";
        // F44f counterexamples. They live outside Assets/VendorFixture because the check run rewrites them:
        // the vendor-source hash assertion covers that folder only, and no byte of a vendor file may move.
        const string MigratedFolder = "Assets/MigratedFixture";
        static readonly string MigratedPath = MigratedFolder+"/MigratedBody.prefab";
        static readonly string LaterDanglingPath = MigratedFolder+"/LaterDanglingBody.prefab";
        const string AnimationFolder = "Assets/VendorAnimationFixture";
        static readonly string AnimationControllerPath = AnimationFolder+"/Vendor.controller";
        static readonly string AnimationBodyPath = AnimationFolder+"/Body.prefab";
        static readonly string AnimationMissingGuid = new string('1', 32);
        static Dictionary<string, object> D(params object[] v) { var r = new Dictionary<string, object>(); for (var i=0;i<v.Length;i+=2) r[(string)v[i]]=v[i+1]; return r; }
        static List<object> L(params object[] v) => v.ToList();
        static void Require(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }
        static string Save(GameObject value, string name)
        {
            var path=Folder+"/"+name+".prefab";
            PrefabUtility.SaveAsPrefabAsset(value,path); UnityEngine.Object.DestroyImmediate(value); return path;
        }
        static string SaveIn(GameObject value, string folder, string name)
        {
            var path=folder+"/"+name+".prefab";
            PrefabUtility.SaveAsPrefabAsset(value,path); UnityEngine.Object.DestroyImmediate(value); return path;
        }
        /// <summary>
        /// The vendor shader package's own import-time migration: unrelated bytes of an already imported
        /// file rewritten while every reference stays where the vendor put it. Idempotent, because every
        /// check run observes the same file.
        /// </summary>
        static void MigrateAfterImport(string path)
        {
            var text=File.ReadAllText(Avh.Abs(path));
            if(text.Contains("m_Scale: {x: 1.5"))return;
            var migrated=text.Replace("m_Scale: {x: 1, y: 1}","m_Scale: {x: 1.5, y: 1}");
            if(migrated==text)throw new Exception("fixture did not find a texture scale to migrate");
            File.WriteAllText(Avh.Abs(path),migrated);AssetDatabase.ImportAsset(path,ImportAssetOptions.ForceSynchronousImport);
        }
        /// <summary>
        /// A dangling texture reference the imported archive member never carried: it can only have
        /// appeared after the import. Idempotent across check runs.
        /// </summary>
        static void IntroduceDanglingTexture(string path)
        {
            var text=File.ReadAllText(Avh.Abs(path));
            if(text.Contains(MissingTextureGuid))return;
            var rewritten=Regex.Replace(text,@"m_Texture: \{[^}]*\}","m_Texture: {fileID: 2800000, guid: "+MissingTextureGuid+", type: 3}");
            if(rewritten==text)throw new Exception("fixture did not find a texture reference to replace");
            File.WriteAllText(Avh.Abs(path),rewritten);AssetDatabase.ImportAsset(path,ImportAssetOptions.ForceSynchronousImport);
        }
        static GameObject Mesh(string name, Material material, params Material[] slots)
        {
            var root=GameObject.CreatePrimitive(PrimitiveType.Cube); root.name=name;
            UnityEngine.Object.DestroyImmediate(root.GetComponent<Collider>());
            root.GetComponent<Renderer>().sharedMaterials=slots.Length==0 ? new[]{material}:slots; return root;
        }
        static void Dangling(string path)
        {
            var text=File.ReadAllText(Avh.Abs(path));
            // Replace a real serialized null reference with an unavailable asset identity before import.
            text=text.Replace("- {fileID: 0}", "- {fileID: 2100000, guid: "+MissingGuid+", type: 2}");
            File.WriteAllText(Avh.Abs(path),text); AssetDatabase.ImportAsset(path,ImportAssetOptions.ForceSynchronousImport);
        }
        static void Prepare()
        {
            EditorSettings.serializationMode=SerializationMode.ForceText;
            OutfitStage.EnsureFolder(Folder);
            var material=new Material(Shader.Find("Unlit/Color")); material.color=Color.green;
            AssetDatabase.CreateAsset(material,Folder+"/valid.mat");
            var textureMaterial = new Material(Shader.Find("Unlit/Texture"));
            textureMaterial.SetTexture("_MainTex", Texture2D.whiteTexture);
            var texturePath = Folder+"/MissingTexture.mat";
            AssetDatabase.CreateAsset(textureMaterial, texturePath); AssetDatabase.SaveAssets();
            var textureText = Regex.Replace(File.ReadAllText(Avh.Abs(texturePath)), @"m_Texture: \{[^}]*\}",
                "m_Texture: {fileID: 2800000, guid: "+new string('f',32)+", type: 3}");
            File.WriteAllText(Avh.Abs(texturePath),textureText); AssetDatabase.ImportAsset(texturePath,ImportAssetOptions.ForceSynchronousImport);
            Save(Mesh("VendorTextureBody",textureMaterial),"TextureBody");
            // F44f counterexample 1: the same dangling texture in a material the check run will rewrite
            // after the archive was built, the way lilToon's own migration rewrote the real avatar's.
            OutfitStage.EnsureFolder(MigratedFolder);
            if(!AssetDatabase.CopyAsset(texturePath,MigratedFolder+"/MigratedTexture.mat"))throw new Exception("fixture could not copy the dangling texture material");
            var copiedMaterial=AssetDatabase.LoadAssetAtPath<Material>(MigratedFolder+"/MigratedTexture.mat");
            if(copiedMaterial==null)throw new Exception("fixture could not load the copied dangling texture material");
            SaveIn(Mesh("MigratedBody",copiedMaterial),MigratedFolder,"MigratedBody");
            // F44f counterexample 2: a material whose imported original carries a texture that resolves,
            // so the check run can point it at a dangling GUID the original never named.
            var laterMaterial=new Material(Shader.Find("Unlit/Texture"));
            laterMaterial.SetTexture("_MainTex",Texture2D.whiteTexture);
            AssetDatabase.CreateAsset(laterMaterial,MigratedFolder+"/LaterDanglingTexture.mat");AssetDatabase.SaveAssets();
            SaveIn(Mesh("LaterDanglingBody",laterMaterial),MigratedFolder,"LaterDanglingBody");
            var shaderMaterial = new Material(Shader.Find("Unlit/Color"));
            var shaderPath=Folder+"/MissingShader.mat";AssetDatabase.CreateAsset(shaderMaterial,shaderPath);AssetDatabase.SaveAssets();
            File.WriteAllText(Avh.Abs(shaderPath),Regex.Replace(File.ReadAllText(Avh.Abs(shaderPath)),@"m_Shader: \{[^}]*\}",
                "m_Shader: {fileID: 4800000, guid: "+new string('c',32)+", type: 3}"));
            AssetDatabase.ImportAsset(shaderPath,ImportAssetOptions.ForceSynchronousImport);
            Save(Mesh("VendorShaderBody",AssetDatabase.LoadAssetAtPath<Material>(shaderPath)),"ShaderBody");
            var menu=ScriptableObject.CreateInstance<VRCExpressionsMenu>();
            menu.controls.Add(new VRCExpressionsMenu.Control { name="First",type=VRCExpressionsMenu.Control.ControlType.TwoAxisPuppet });
            menu.controls.Add(new VRCExpressionsMenu.Control { name="Second",type=VRCExpressionsMenu.Control.ControlType.Button,icon=Texture2D.whiteTexture });
            var menuPath=Folder+"/MissingMenu.asset";AssetDatabase.CreateAsset(menu,menuPath);
            using(var serialized=new SerializedObject(menu)) {
                var labels=serialized.FindProperty("controls").GetArrayElementAtIndex(0).FindPropertyRelative("labels");labels.arraySize=2;
                for(var label=0;label<2;label++)labels.GetArrayElementAtIndex(label).FindPropertyRelative("icon").objectReferenceValue=null;
                serialized.ApplyModifiedPropertiesWithoutUndo();
            }
            AssetDatabase.SaveAssets();var iconIndex=0;
            File.WriteAllText(Avh.Abs(menuPath),Regex.Replace(File.ReadAllText(Avh.Abs(menuPath)),@"(?m)^    icon: \{[^}]*\}",match=>
                iconIndex++==1?"    icon: {fileID: 2800000, guid: "+new string('a',32)+", type: 3}":match.Value));
            if(iconIndex!=2)throw new Exception("menu fixture did not find both control icon properties");
            AssetDatabase.ImportAsset(menuPath,ImportAssetOptions.ForceSynchronousImport);
            var menuBody=Mesh("MenuBody",textureMaterial);
            var descriptor=menuBody.AddComponent<VRCAvatarDescriptor>();descriptor.customExpressions=true;
            descriptor.expressionsMenu=AssetDatabase.LoadAssetAtPath<VRCExpressionsMenu>(menuPath);Save(menuBody,"MenuBody");

            var plain=Mesh("PlainBody",material); Save(plain,"PlainBody");
            // A clean prefab whose default-empty GameObject icon the check run then omits from the YAML. It lives
            // outside the vendor fixture folder: no registered source stands behind it, and the check run must not
            // change a single byte of the files the vendor-source hash assertion covers.
            OutfitStage.EnsureFolder(UnlocatedFolder);
            var unlocated=Mesh("UnlocatedBody",material);
            PrefabUtility.SaveAsPrefabAsset(unlocated,UnlocatedPath);UnityEngine.Object.DestroyImmediate(unlocated);
            var body=Mesh("BodyWithMissingOverlay",material,material,null);
            // Gradient leaves are intentionally unsupported by the thin-variant structural inspector.
            // Authorized repair verification must still retain strict Unity override checks for this source.
            // Co-located renderer components must be verified individually without material binding ambiguity.
            var gradientRenderer = body.AddComponent<LineRenderer>();gradientRenderer.sharedMaterial=material;
            gradientRenderer.enabled=false;
            var legalPath=Save(Mesh("IntentionalNull",material,material,null),"LegalNull");
            var legal=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(legalPath),body.transform); legal.transform.localPosition=new Vector3(4,0,0);
            var variant = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(Folder+"/PlainBody.prefab"));
            variant.name = "VariantOverlay"; variant.GetComponent<Renderer>().sharedMaterials = new[] { material, (Material)null };
            var variantPath = Save(variant, "VariantMissing");
            var variantText = File.ReadAllText(Avh.Abs(variantPath));
            // Unity omits an override for a new null array element. Insert a real missing identity explicitly.
            AssetDatabase.TryGetGUIDAndLocalFileIdentifier(AssetDatabase.LoadAssetAtPath<GameObject>(Folder+"/PlainBody.prefab").GetComponent<Renderer>(), out string rendererGuid, out long rendererId);
            var missingOverride = "    - target: {fileID: "+rendererId+", guid: "+rendererGuid+", type: 3}\n"
                + "      propertyPath: m_Materials.Array.data[1]\n      value: \n"
                + "      objectReference: {fileID: 2100000, guid: "+MissingGuid+", type: 2}\n";
            variantText = variantText.Replace("    m_RemovedComponents:", missingOverride+"    m_RemovedComponents:");
            if (!variantText.Contains("guid: "+MissingGuid)) throw new Exception("fixture did not serialize a true missing GUID override");
            File.WriteAllText(Avh.Abs(variantPath), variantText); AssetDatabase.ImportAsset(variantPath, ImportAssetOptions.ForceSynchronousImport);
            var bodyPath=Save(body,"BodyMissing");
            // Only the body's second material is missing; the sibling remains an intentional null.
            var bodyText=File.ReadAllText(Avh.Abs(bodyPath));
            var at=bodyText.IndexOf("- {fileID: 0}",StringComparison.Ordinal);
            bodyText=bodyText.Substring(0,at)+bodyText.Substring(at).ReplaceFirst("- {fileID: 0}","- {fileID: 2100000, guid: "+MissingGuid+", type: 2}");
            File.WriteAllText(Avh.Abs(bodyPath),bodyText); AssetDatabase.ImportAsset(bodyPath,ImportAssetOptions.ForceSynchronousImport);
            var clothes=Mesh("GarmentOverlay",material,material,null); clothes.AddComponent<ModularAvatarMergeArmature>();
            var garmentPath=Save(clothes,"GarmentMissing");
            AssetDatabase.CopyAsset(garmentPath,Folder+"/GarmentNull.prefab");Dangling(garmentPath);
            var leafPath=Save(Mesh("NestedLeaf",material,material,null),"NestedLeaf"); Dangling(leafPath);
            var nested=new GameObject("NestedBody"); PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(leafPath),nested.transform); Save(nested,"NestedBody");
            var repeated=new GameObject("RepeatedBody");
            foreach(var name in new[]{"ExplicitNull","ActualMissing"}){
                var child=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(leafPath),repeated.transform);child.name=name;
            }
            var repeatedPath=Save(repeated,"RepeatedBody");
            AssetDatabase.TryGetGUIDAndLocalFileIdentifier(AssetDatabase.LoadAssetAtPath<GameObject>(leafPath).GetComponent<Renderer>(),out string leafGuid,out long leafRenderer);
            var repeatedText=File.ReadAllText(Avh.Abs(repeatedPath));
            repeatedText=Regex.Replace(repeatedText,@"(?m)^--- !u!1001 &[^\n]+\n(?<body>[\s\S]*?)(?=\n--- !u!|\z)",match=>{
                if(!match.Value.Contains("value: ExplicitNull"))return match.Value;
                var clear="    - target: {fileID: "+leafRenderer+", guid: "+leafGuid+", type: 3}\n"
                    +"      propertyPath: m_Materials.Array.data[1]\n      value: \n      objectReference: {fileID: 0}\n";
                return match.Value.Replace("    m_RemovedComponents:",clear+"    m_RemovedComponents:");
            });
            File.WriteAllText(Avh.Abs(repeatedPath),repeatedText);AssetDatabase.ImportAsset(repeatedPath,ImportAssetOptions.ForceSynchronousImport);
            var ownPath=Save(Mesh("OwnSubmesh",material,null,material),"OwnMissing"); Dangling(ownPath);
            var middlePath=Save(Mesh("MiddleGap",material,material,null,material,null),"MiddleMissing"); Dangling(middlePath);
            var multiplePath=Save(Mesh("MultipleTail",material,material,material,null,null),"MultipleTail");Dangling(multiplePath);
            var multipleOwn=Mesh("MultiSubmeshOwn",material,material,material,null,null);
            var multiMesh=UnityEngine.Object.Instantiate(multipleOwn.GetComponent<MeshFilter>().sharedMesh);
            var triangles=multiMesh.triangles;multiMesh.subMeshCount=3;
            for(var submesh=0;submesh<3;submesh++)multiMesh.SetTriangles(triangles,submesh);
            AssetDatabase.CreateAsset(multiMesh,Folder+"/ThreeSubmeshes.asset");multipleOwn.GetComponent<MeshFilter>().sharedMesh=multiMesh;
            var multiOwnPath=Save(multipleOwn,"MultiSubmeshOwn");Dangling(multiOwnPath);
            // Other effective dependencies must also be checked by Observe.
            var meshPath=Save(Mesh("MissingMesh",material),"MeshMissing");
            var meshText=File.ReadAllText(Avh.Abs(meshPath));
            meshText=Regex.Replace(meshText,@"m_Mesh: \{[^}]+\}","m_Mesh: {fileID: 4300000, guid: "+MissingMeshGuid+", type: 2}");
            File.WriteAllText(Avh.Abs(meshPath),meshText); AssetDatabase.ImportAsset(meshPath,ImportAssetOptions.ForceSynchronousImport);
            var unknownPath=Save(Mesh("UnknownMeshAndMaterial",material,(Material)null),"UnknownMeshAndMaterial");Dangling(unknownPath);
            var unknownText=Regex.Replace(File.ReadAllText(Avh.Abs(unknownPath)),@"m_Mesh: \{[^}]+\}","m_Mesh: {fileID: 4300000, guid: "+MissingMeshGuid+", type: 2}");
            File.WriteAllText(Avh.Abs(unknownPath),unknownText);AssetDatabase.ImportAsset(unknownPath,ImportAssetOptions.ForceSynchronousImport);
            AssetDatabase.SaveAssets();
        }

        /// <summary>
        /// Fixture scenes for the vendor-controller exception. The controller deliberately contains one
        /// absent motion GUID and one motion whose GUID exists but whose fileID is wrong; only the former
        /// may be a reminder. The real Unity harness checks both identities through the production observer.
        /// </summary>
        static void PrepareAnimation()
        {
            EditorSettings.serializationMode=SerializationMode.ForceText;
            AssetDatabase.DeleteAsset(AnimationFolder); OutfitStage.EnsureFolder(AnimationFolder);
            var clip=new AnimationClip(); AssetDatabase.CreateAsset(clip,AnimationFolder+"/Existing.anim");
            var controller=new AnimatorController(); AssetDatabase.CreateAsset(controller,AnimationControllerPath);
            controller.AddLayer("Base");
            var machine=controller.layers[0].stateMachine;
            machine.AddState("Idle"); machine.AddState("ExistingFileIdWrong");
            EditorUtility.SetDirty(controller); AssetDatabase.SaveAssets();
            var text=File.ReadAllText(Avh.Abs(AnimationControllerPath));
            var clipGuid=AssetDatabase.AssetPathToGUID(AnimationFolder+"/Existing.anim");
            text=new Regex(@"(?ms)(m_Name: Idle.*?m_Motion: )\{[^}]*\}").Replace(text, "$1{fileID: 7400000, guid: "+AnimationMissingGuid+", type: 2}", 1);
            text=new Regex(@"(?ms)(m_Name: ExistingFileIdWrong.*?m_Motion: )\{[^}]*\}").Replace(text, "$1{fileID: 7400001, guid: "+clipGuid+", type: 2}", 1);
            File.WriteAllText(Avh.Abs(AnimationControllerPath),text); AssetDatabase.ImportAsset(AnimationControllerPath,ImportAssetOptions.ForceSynchronousImport);
            var body=new GameObject("VendorAnimationBody"); body.AddComponent<Animator>().runtimeAnimatorController=AssetDatabase.LoadAssetAtPath<RuntimeAnimatorController>(AnimationControllerPath);
            SaveIn(body,AnimationFolder,"Body"); AssetDatabase.SaveAssets();
        }

        static void CheckAnimation()
        {
            ObserveUnmodified(AnimationBodyPath);
            var dependency=Dependencies(); var metrics=dependency.Obj("metrics");
            Require(Convert.ToInt32(metrics["vendor_missing_animation_references"])==1,"vendor missing motion must be a reminder: "+Avh.Json(dependency));
            Require(Convert.ToInt32(metrics["broken_guid_refs"])==1,"existing-asset wrong fileID must remain blocking: "+Avh.Json(dependency));
            Require(dependency.List("notes").Any(note=>note.ToString().Contains("Vendor.controller")&&note.ToString().Contains("Idle")&&note.ToString().Contains(AnimationMissingGuid)),
                "animation reminder must identify controller, state and GUID: "+Avh.Json(dependency));
        }
        static Dictionary<string, object> Plan(string body, string garment=null)
        {
            var outfits=garment==null ? L():L(D("id","garment","item","synthetic","kind","outfit","prefab",garment));
            return D("schema","plan/0.2","body","synthetic","body_prefab",body,"default_outfit",garment==null?null:"garment","outfits",outfits);
        }
        static Dictionary<string, object> Dependencies() => Avh.ReadJsonFile(Path.Combine(Avh.RunDir,"observations","avatar.dependencies.json"));
        static int Broken() => Convert.ToInt32(Dependencies().Obj("metrics")["broken_guid_refs"]);
        static void ObserveUnmodified(string path)
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            var go=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            try { EffectiveReferences.WriteObservation(go); }
            finally { UnityEngine.Object.DestroyImmediate(go); }
        }
        static Dictionary<string,object> Render(string path,string label)
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene,NewSceneMode.Single);
            var prefab=AssetDatabase.LoadAssetAtPath<GameObject>(path);
            var go=(GameObject)PrefabUtility.InstantiatePrefab(prefab);
            var cameraObject=new GameObject("ReadbackCamera"); var camera=cameraObject.AddComponent<Camera>();
            camera.transform.position=new Vector3(0,0,-3);camera.clearFlags=CameraClearFlags.SolidColor;camera.backgroundColor=Color.black;
            var target=new RenderTexture(96,96,24);var image=new Texture2D(96,96,TextureFormat.RGB24,false);
            try
            {
                camera.targetTexture=target;camera.Render();RenderTexture.active=target;image.ReadPixels(new Rect(0,0,96,96),0,0);image.Apply();
                var pixels=image.GetPixels();var magenta=pixels.Count(c=>c.r>.7f&&c.b>.7f&&c.g<.3f);var green=pixels.Count(c=>c.g>.7f&&c.r<.3f&&c.b<.3f);
                Directory.CreateDirectory(Path.Combine(Avh.RunDir,"visual"));File.WriteAllBytes(Path.Combine(Avh.RunDir,"visual",label+".png"),image.EncodeToPNG());
                var renderer=go.GetComponentsInChildren<Renderer>(true).First(r=>r.name!="IntentionalNull");
                var result=D("label",label,"magenta_pixels",magenta,"green_pixels",green,"slot_count",renderer.sharedMaterials.Length,"null_slots",renderer.sharedMaterials.Count(m=>m==null),"graphics_device",SystemInfo.graphicsDeviceType.ToString());
                Debug.Log("F44 measured display "+label+": "+Avh.Json(result)); return result;
            }
            finally { RenderTexture.active=null;camera.targetTexture=null;target.Release();UnityEngine.Object.DestroyImmediate(image);UnityEngine.Object.DestroyImmediate(target);UnityEngine.Object.DestroyImmediate(cameraObject);UnityEngine.Object.DestroyImmediate(go); }
        }
        /// <summary>
        /// A pointer the source text does locate and the project does not have: a renderer's m_Mesh naming an
        /// absent GUID. The value reads null, but the source names the object, so this is a broken link and must
        /// not be reported as an unlocated default field. Deliberately not a material slot: the slot-skip mutation
        /// is diagnosed by its own assertion, and this counterexample has to stay attributable to rule 2.
        /// </summary>
        static void LocatedDanglingGuid()
        {
            ObserveUnmodified(Folder+"/MeshMissing.prefab");
            var notes=Dependencies().List("notes").Select(note=>note.ToString()).ToList();
            Require(Broken()>0,"a located dangling GUID must stay blocking instead of becoming an unlocated default field: "+Avh.Json(Dependencies()));
            Require(notes.Any(note=>note.Contains("有效依赖缺失")&&note.Contains(MissingMeshGuid)),
                "the blocking note must name the located dangling GUID: "+Avh.Json(Dependencies()));
        }
        /// <summary>
        /// Unity can lose the object behind a reference while still holding its instance identity: the value reads
        /// null and the instance ID stays nonzero. No source text locates the property, yet this is a lost object
        /// rather than a default-empty field, so it must keep blocking. The reference is a MeshFilter's mesh, not a
        /// material slot, so the slot-skip mutation stays diagnosed by its own assertion.
        /// </summary>
        static void LostInstanceIdentity()
        {
            var host=new GameObject("LostReferenceBody");
            var filter=host.AddComponent<MeshFilter>();
            var mesh=new Mesh{name="LostReferenceMesh"};
            filter.sharedMesh=mesh;
            UnityEngine.Object.DestroyImmediate(mesh);
            var property=new SerializedObject(filter).FindProperty("m_Mesh");
            var instance=property.objectReferenceInstanceIDValue;
            Debug.Log("F44 lost reference: instanceID="+instance+" null_value="+(property.objectReferenceValue==null));
            try
            {
                EffectiveReferences.WriteObservation(host);
                Require(instance!=0,"fixture must hold an instance identity for a lost object: "+instance);
                var notes=Dependencies().List("notes").Select(note=>note.ToString()).ToList();
                Require(notes.Any(note=>note.Contains("有效依赖缺失")&&note.Contains("fileID "+instance)),
                    "a lost object Unity still identifies must stay blocking: "+Avh.Json(Dependencies()));
                Require(Convert.ToInt32(Dependencies().Obj("metrics")["unlocated_null_refs"])==0,
                    "a lost object must not be counted as an unlocated default field: "+Avh.Json(Dependencies()));
            }
            finally { UnityEngine.Object.DestroyImmediate(host); }
        }
        /// <summary>
        /// The shape most of a real avatar's null references have: a default-empty field Unity never wrote into the
        /// source text — vendor FBX-derived prefabs omit m_Icon on their GameObjects — so nothing locates it, the
        /// value is null and Unity holds no instance identity. It is an observation, never a broken link.
        /// </summary>
        static void UnlocatedDefaultField()
        {
            var path=UnlocatedPath;
            // Idempotent: every check run observes the same missing field, so only the first one rewrites the file.
            var text=File.ReadAllText(Avh.Abs(path));
            var omitted=Regex.Replace(text,@"(?m)^  m_Icon: \{fileID: 0\}\r?\n","");
            if(omitted==text&&text.Contains("m_Icon"))throw new Exception("fixture did not serialize a default m_Icon field to omit");
            if(omitted!=text){File.WriteAllText(Avh.Abs(path),omitted);AssetDatabase.ImportAsset(path,ImportAssetOptions.ForceSynchronousImport);}
            ObserveUnmodified(path);
            var metrics=Dependencies().Obj("metrics");
            var notes=Dependencies().List("notes").Select(note=>note.ToString()).ToList();
            Require(Broken()==0,"a default-empty field no source locates must not be a broken link: "+Avh.Json(Dependencies()));
            Require(Convert.ToInt32(metrics["unlocated_null_refs"])>=1,"an unlocated default field must be counted: "+Avh.Json(Dependencies()));
            Require(notes.Any(note=>note.Contains("GameObject / m_Icon")),
                "unlocated references must be reported as an object-type/path group: "+Avh.Json(Dependencies()));
        }
        static void Check()
        {
            var visual=L();
            Require(VariantResolver.Inspect(AssetDatabase.LoadAssetAtPath<GameObject>(Folder+"/BodyMissing.prefab")).Unsupported.Count>0,
                "fixture must exercise renderer state outside the thin-variant signature");
            // What the unlocated rule must NOT swallow, and what it must swallow, in the order that keeps each
            // failure attributable to one rule.
            LocatedDanglingGuid();
            LostInstanceIdentity();
            UnlocatedDefaultField();
            foreach(var kind in new[]{"body","garment","nested","variant"})
            {
                var source=Folder+"/"+(kind=="body"?"BodyMissing":kind=="garment"?"GarmentMissing":kind=="variant"?"VariantMissing":"NestedBody")+".prefab";
                ObserveUnmodified(source);
                Require(Broken()>0,"Observe skipped real missing material slots before trimming: "+kind);
                var plan=Plan(kind=="garment"?Folder+"/PlainBody.prefab":source,kind=="garment"?source:null);
                Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(plan));
                Avh.WriteJson(Avh.Abs("_harness/setup/baseline.json"),D("body_prefab",plan.Str("body_prefab")));
                if(kind=="body") visual.Add(Render(source,"before"));
                OutfitStage.Produce();
                var record=Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
                var trims=record.List("vendor_missing_material_slots").Cast<Dictionary<string,object>>().ToList();
                Require(trims.Count==1,"whole-avatar trim missing or changed intentional null: "+kind);
                var trim=trims.Single();
                Require(Convert.ToInt32(trim["original_slot_count"])==2&&Convert.ToInt32(trim["final_slot_count"])==1,"trim counts incorrect: "+kind);
                Require(trim.List("removed_slots").Select(Convert.ToInt32).SequenceEqual(new[]{1})&&trim.List("removed_guids").Single().ToString()==MissingGuid,"receipt did not record the exact removed slot/GUID: "+kind);
                OutfitMeasure.WriteAvatar(OutfitStage.AvatarPath,OutfitStage.RecordPath);
                Require(Broken()==0,"persistent effective instances still have missing dependencies: "+kind+" "+Avh.Json(Dependencies()));
                Require(Convert.ToInt32(Dependencies().Obj("metrics")["material_slots_checked"])>0,"Observe did not check material slots");
                if (kind != "garment")
                {
                    OutfitMeasure.Write(OutfitStage.AvatarPath, OutfitStage.RecordPath);
                    var clothing = Avh.ReadJsonFile(Path.Combine(Avh.RunDir,"observations","clothing.install.json"));
                    Require(Equals(clothing.Obj("metrics")["authorized_local_variant_valid"],true),"authorized material repair failed the existing assembly check: "+kind+" "+Avh.Json(clothing));
                }
                File.Copy(Avh.Abs(OutfitStage.RecordPath),Avh.Abs(kind+"-record.json"),true);
                File.Copy(Path.Combine(Avh.RunDir,"observations","avatar.dependencies.json"),Avh.Abs(kind+"-observation.json"),true);
                if(kind=="body")
                {
                    visual.Add(Render(OutfitStage.AvatarPath,"after"));
                    var drift = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath));
                    drift.layer = 17; PrefabUtility.SaveAsPrefabAsset(drift,OutfitStage.AvatarPath);UnityEngine.Object.DestroyImmediate(drift);
                    OutfitMeasure.Write(OutfitStage.AvatarPath,OutfitStage.RecordPath);
                    var rejected = Avh.ReadJsonFile(Path.Combine(Avh.RunDir,"observations","clothing.install.json"));
                    Require(Equals(rejected.Obj("metrics")["authorized_local_variant_valid"],false),"material repair must not authorize unrelated serialized drift");
                }
            }
            var groupedPlan=D("schema","plan/0.3","body_prefab",Folder+"/PlainBody.prefab",
                "avatar_config",D("schema","avatar-config/0.1","instances",L(D("id","shared","kind","outfit","item","synthetic",
                    "variants",L(D("id","missing","prefab",Folder+"/GarmentMissing.prefab"),D("id","null","prefab",Folder+"/GarmentNull.prefab")))),
                    "groups",L(D("id","clothes","activation","exclusive","selector","discrete","parameter",D("name","AVH/Clothes","type","Int"),
                        "default","null","members",L(D("id","missing","instance","shared","variant","missing"),D("id","null","instance","shared","variant","null")))),"shared_switches",L()));
            Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(groupedPlan));OutfitStage.Produce();
            var groupedRecord=Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
            var groupedRows=groupedRecord.List("outfits").Cast<Dictionary<string,object>>().ToList();
            Require(groupedRows.Select(r=>r.Str("object")).Distinct().Count()==2,"repaired tail and explicit null have different structures and must not share a physical instance");
            Require(groupedRecord.List("vendor_missing_material_slots").Count==1,"grouped receipts must contain only the actual removed tail");
            OutfitMeasure.WriteAvatar(OutfitStage.AvatarPath,OutfitStage.RecordPath);
            Require(Broken()==0,"grouped variants still contain missing references");
            Require(Equals(Avh.ReadJsonFile(Path.Combine(Avh.RunDir,"observations","avatar.observe.json")).Obj("metrics")["group_defaults_match"],true),"grouped defaults must preserve the intentional null variant");
            var repeatedSource=Folder+"/RepeatedBody.prefab";ObserveUnmodified(repeatedSource);
            Require(Broken()==1,"same-source nested overrides must distinguish intentional null from missing GUID: "+Avh.Json(Dependencies()));
            Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(Plan(repeatedSource)));OutfitStage.Produce();
            var repeatedReceipt=(Dictionary<string,object>)Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)).List("vendor_missing_material_slots").Single();
            Require(repeatedReceipt.Str("renderer_path")=="ActualMissing","a sibling instance override must not trim an intentional null");
            OutfitMeasure.WriteAvatar(OutfitStage.AvatarPath,OutfitStage.RecordPath);Require(Broken()==0,"same-source nested output still has missing references: "+Avh.Json(Dependencies()));
            Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(Plan(Folder+"/MultipleTail.prefab")));OutfitStage.Produce();
            var multipleReceipt=(Dictionary<string,object>)Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)).List("vendor_missing_material_slots").Single();
            Require(Convert.ToInt32(multipleReceipt["original_slot_count"])==4 && Convert.ToInt32(multipleReceipt["final_slot_count"])==2
                && multipleReceipt.List("removed_slots").Select(Convert.ToInt32).SequenceEqual(new[]{2,3}),"multiple trailing missing slots must preserve preceding valid overlay");
            OutfitMeasure.WriteAvatar(OutfitStage.AvatarPath,OutfitStage.RecordPath);Require(Broken()==0,"multiple tail repair still contains dangling references");
            Debug.Log("F44 slot basis: MultipleTail mesh submeshes=1, missing slots 2/3 trimmed; MultiSubmeshOwn mesh submeshes=3, slot 2 belongs to a submesh and requires a decision");
            foreach(var own in new[]{"OwnMissing","MiddleMissing","MultiSubmeshOwn","UnknownMeshAndMaterial"})
            {
                Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(Plan(Folder+"/"+own+".prefab")));
                var refused=false;
                try { OutfitStage.Produce(); }
                catch(Exception error){refused=error.Message.Contains("需决定替换成哪个已有材质或接受缺失");}
                Require(refused,"unsafe material slot did not request a decision: "+own);
            }
            ObserveUnmodified(Folder+"/MeshMissing.prefab");Require(Broken()>0,"Observe missed a non-material dependency");
            var textureBody = Folder+"/TextureBody.prefab";
            ObserveUnmodified(textureBody);
            Require(Broken()==0 && Convert.ToInt32(Dependencies().Obj("metrics")["vendor_missing_material_references"])==1,
                "a vendor material missing texture the imported original carries must only remind");
            Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(Plan(textureBody))); OutfitStage.Produce();
            var textureRecord=Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
            Require(textureRecord.List("vendor_missing_material_references").Count==1,"delivery reminder missing from actual material observation");
            OutfitMeasure.WriteAvatar(OutfitStage.AvatarPath,OutfitStage.RecordPath);
            Require(Broken()==0 && Convert.ToInt32(Dependencies().Obj("metrics")["vendor_missing_material_references"])==1,
                "persisted vendor material internal missing reference must only remind");
            File.Copy(Avh.Abs(OutfitStage.RecordPath),Avh.Abs("texture-record.json"),true);
            File.Copy(Path.Combine(Avh.RunDir,"observations","avatar.dependencies.json"),Avh.Abs("texture-observation.json"),true);
            // F44f counterexample 1: unrelated bytes rewritten after the import — the shape the vendor's own
            // shader-package migration produces — while the imported archive member still names the same
            // missing GUID. The proof is the reference's provenance, so this stays a reminder.
            MigrateAfterImport(MigratedFolder+"/MigratedTexture.mat");
            ObserveUnmodified(MigratedPath);
            Require(Broken()==0 && Convert.ToInt32(Dependencies().Obj("metrics")["vendor_missing_material_references"])==1,
                "a rewritten vendor material the imported original still names must only remind: "+Avh.Json(Dependencies()));
            // F44f counterexample 2: a dangling texture GUID the imported archive member never carried. It
            // appeared after the import, so it is not the vendor's and must keep blocking.
            IntroduceDanglingTexture(MigratedFolder+"/LaterDanglingTexture.mat");
            ObserveUnmodified(LaterDanglingPath);
            Require(Broken()>0,"a dangling texture GUID the imported original never carried must block: "+Avh.Json(Dependencies()));
            Require(Convert.ToInt32(Dependencies().Obj("metrics")["vendor_missing_material_references"])==0,
                "a reference that appeared after the import must not become a reminder: "+Avh.Json(Dependencies()));
            AssetDatabase.CopyAsset(Folder+"/MissingTexture.mat","Assets/_Harness/Outfit/GeneratedMissing.mat");
            var generated = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(textureBody));
            generated.GetComponent<Renderer>().sharedMaterial=AssetDatabase.LoadAssetAtPath<Material>("Assets/_Harness/Outfit/GeneratedMissing.mat");
            PrefabUtility.SaveAsPrefabAsset(generated,OutfitStage.AvatarPath);UnityEngine.Object.DestroyImmediate(generated);
            OutfitMeasure.WriteAvatar(OutfitStage.AvatarPath,OutfitStage.RecordPath);
            Require(Broken()>0,"generated material internal missing reference must block");
            ObserveUnmodified(Folder+"/ShaderBody.prefab");
            Require(Broken()==1 && Convert.ToInt32(Dependencies().Obj("metrics")["vendor_missing_material_references"])==0,
                "vendor missing shader must block instead of using the texture exemption: "+Avh.Json(Dependencies()));
            File.Copy(Path.Combine(Avh.RunDir,"observations","avatar.dependencies.json"),Avh.Abs("shader-observation.json"),true);
            Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(Plan(Folder+"/MenuBody.prefab")));OutfitStage.Produce();
            OutfitMeasure.WriteAvatar(OutfitStage.AvatarPath,OutfitStage.RecordPath);
            Require(Broken()==1 && Dependencies().List("notes").Any(note=>note.ToString().Contains("controls.Array.data[1].icon")),
                "full nested menu path must expose the actual second-control missing icon: "+Avh.Json(Dependencies()));
            File.Copy(Path.Combine(Avh.RunDir,"observations","avatar.dependencies.json"),Avh.Abs("menu-observation.json"),true);
            visual.Add(Render(Folder+"/OwnMissing.prefab","own-submesh"));
            PerfCheck();
            File.WriteAllText(Avh.Abs("visual-result.json"),Avh.Json(D("samples",visual)));
        }
        /// <summary>
        /// A performance regression, on the shape that made a real avatar's Observe run for half an hour:
        /// one source document reached by many references. Six dangling icons point into one menu asset, so
        /// resolving them must reuse the per-file document index and the parsed document. Rescanning or
        /// reparsing per reference still produces the same answer, which is why only a bound on the work
        /// catches it — the counts must stay proportional to the sources, not to the references.
        /// </summary>
        static void PerfCheck()
        {
            const string dir="Assets/PerfFixture";
            OutfitStage.EnsureFolder(dir);
            foreach(var stale in new[]{dir+"/PerfMenu.asset",dir+"/PerfBody.prefab"})AssetDatabase.DeleteAsset(stale);
            var menu=ScriptableObject.CreateInstance<VRCExpressionsMenu>();
            for(var i=0;i<6;i++)menu.controls.Add(new VRCExpressionsMenu.Control{name="Perf"+i,type=VRCExpressionsMenu.Control.ControlType.Button,icon=Texture2D.whiteTexture});
            var menuPath=dir+"/PerfMenu.asset";AssetDatabase.CreateAsset(menu,menuPath);AssetDatabase.SaveAssets();
            var dangling=new string('b',32);
            var rewritten=Regex.Replace(File.ReadAllText(Avh.Abs(menuPath)),@"(?m)^    icon: \{[^}]*\}","    icon: {fileID: 2800000, guid: "+dangling+", type: 3}");
            if(Regex.Matches(rewritten,"guid: "+dangling).Count!=6)throw new Exception("perf fixture did not serialize six dangling icon references");
            File.WriteAllText(Avh.Abs(menuPath),rewritten);AssetDatabase.ImportAsset(menuPath,ImportAssetOptions.ForceSynchronousImport);
            var body=new GameObject("PerfBody");
            var descriptor=body.AddComponent<VRCAvatarDescriptor>();descriptor.customExpressions=true;
            descriptor.expressionsMenu=AssetDatabase.LoadAssetAtPath<VRCExpressionsMenu>(menuPath);
            var bodyPath=dir+"/PerfBody.prefab";PrefabUtility.SaveAsPrefabAsset(body,bodyPath);UnityEngine.Object.DestroyImmediate(body);
            OutfitPerf.Reset();
            ObserveUnmodified(bodyPath);
            var cost=EffectiveReferences.PerformanceCounters();
            var directCalls=Convert.ToInt64(cost["direct_calls"]);var rootParses=Convert.ToInt64(cost["direct_root_parses"]);
            var indexBuilds=Convert.ToInt64(cost["document_index_builds"]);var sourceTexts=Math.Max(1L,Convert.ToInt64(cost["source_texts"]));
            Require(directCalls>=4&&rootParses*4<=directCalls&&indexBuilds<=sourceTexts,
                "one traversal must index a source file and parse a document once, not once per reference: "+Avh.Json(cost));
            // A mesh keeps its vertex and index buffers as arrays of bytes. They cannot hold an object
            // reference, so entering them is pure cost: the traversal must visit far fewer properties
            // than the buffers have elements.
            var vertexCount=20000;
            var perfMesh=new Mesh{name="PerfMesh"};var positions=new Vector3[vertexCount];
            for(var i=0;i<vertexCount;i++)positions[i]=new Vector3(i%97,i%89,i%83);
            perfMesh.vertices=positions;var indices=new int[(vertexCount/3)*3];
            for(var i=0;i<indices.Length;i++)indices[i]=i;perfMesh.triangles=indices;
            AssetDatabase.DeleteAsset(dir+"/PerfMesh.asset");AssetDatabase.CreateAsset(perfMesh,dir+"/PerfMesh.asset");
            AssetDatabase.DeleteAsset(dir+"/PerfMeshBody.prefab");
            var meshBody=Mesh("PerfMeshBody",AssetDatabase.LoadAssetAtPath<Material>(Folder+"/valid.mat"));
            meshBody.GetComponent<MeshFilter>().sharedMesh=perfMesh;
            var meshBodyPath=dir+"/PerfMeshBody.prefab";PrefabUtility.SaveAsPrefabAsset(meshBody,meshBodyPath);UnityEngine.Object.DestroyImmediate(meshBody);
            OutfitPerf.Reset();
            ObserveUnmodified(meshBodyPath);
            var meshCost=EffectiveReferences.PerformanceCounters();
            var traversed=Convert.ToInt64(meshCost["traversed_leaves"]);var skipped=Convert.ToInt64(meshCost["skipped_array_elements"]);
            Require(skipped>0&&traversed<skipped,
                "a primitive array must not be entered: "+Avh.Json(meshCost));
        }
        public static void Run()
        {
            var result=D("ok",false);
            try { var mode=Avh.Env("AVH_VENDOR_FIXTURE_MODE"); if(mode=="prepare")Prepare();else if(mode=="prepare-animation")PrepareAnimation();else if(mode=="check-animation")CheckAnimation();else Check();result["ok"]=true; }
            catch(Exception error){result["error"]=error.ToString();}
            result["assertions"]=assertions;File.WriteAllText(Avh.Abs("result.json"),Avh.Json(result));EditorApplication.Exit(0);
        }
        static string ReplaceFirst(this string source,string oldValue,string newValue)
        {var index=source.IndexOf(oldValue,StringComparison.Ordinal);return index<0?source:source.Substring(0,index)+newValue+source.Substring(index+oldValue.Length);}
    }
}
