using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
    public static class RecolorSameSlotIntegration
    {
        static int assertions;
        static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (int i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i+1]; return d; }
        static void Check(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }
        static Texture2D Texture(string path, Color color) { var texture = new Texture2D(2, 2); texture.SetPixels(new[]{color,color,color,color}); texture.Apply(); File.WriteAllBytes(Avh.Abs(path), texture.EncodeToPNG()); UnityEngine.Object.DestroyImmediate(texture); AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceSynchronousImport); return AssetDatabase.LoadAssetAtPath<Texture2D>(path); }
        static Renderer Mesh(Transform parent, string name, Material material) { var obj = GameObject.CreatePrimitive(PrimitiveType.Cube); obj.name = name; obj.transform.SetParent(parent, false); obj.GetComponent<Renderer>().sharedMaterial = material; return obj.GetComponent<Renderer>(); }
        public static void Run()
        {
            try
            {
                UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Single);
                foreach (var p in new[]{"Assets/Authorized", "Assets/_Harness"}) if (AssetDatabase.IsValidFolder(p)) AssetDatabase.DeleteAsset(p);
                OutfitStage.EnsureFolder("Assets/Authorized"); OutfitStage.EnsureFolder(RecolorStage.Dir); OutfitStage.EnsureFolder(OutfitStage.Dir);
                File.WriteAllText(Avh.Abs("Assets/Authorized/Fixture.shader"), "Shader \"AVH/FixtureEye\" { Properties { _MainTex(\"Main\",2D)=\"white\"{} _Color(\"Color\",Color)=(1,1,1,1) _Color2nd(\"Iris\",Color)=(1,0,0,1) _UseMain2ndTex(\"Enabled\",Float)=1 _Main2ndTex(\"Mask\",2D)=\"white\"{} _MainTexHSVG(\"HSV\",Vector)=(0,1,1,1) } SubShader { Pass {} } }");
                AssetDatabase.ImportAsset("Assets/Authorized/Fixture.shader", ImportAssetOptions.ForceSynchronousImport);
                var original = Texture("Assets/Authorized/base.png", Color.white); var replacement = Texture("Assets/Authorized/lashes.png", Color.black); var mask = Texture("Assets/Authorized/eye-mask.png", Color.white);
                var eye = new Material(Shader.Find("AVH/FixtureEye")); eye.SetTexture("_MainTex", original); eye.SetTexture("_Main2ndTex", mask); eye.SetFloat("_UseMain2ndTex", 1); eye.SetColor("_Color2nd", Color.red); AssetDatabase.CreateAsset(eye, "Assets/Authorized/Eye.mat");
                OutfitStage.EnsureFolder("Assets/Authorized/Bag"); var bag = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(bag,"Assets/Authorized/Bag/Original.mat"); var pink = new Material(bag); pink.color=Color.magenta; AssetDatabase.CreateAsset(pink,"Assets/Authorized/Bag/Pink.mat");
                var body = RecolorMaterialIntegration.Human(); Mesh(body.transform,"Face",eye);
                // The same source in another renderer must receive its own copy, too.
                Mesh(body.transform,"FaceOther",eye);
                var group = new GameObject(OutfitStage.Group); group.transform.SetParent(body.transform,false); var clothing = new GameObject("Outfit_bag"); clothing.transform.SetParent(group.transform,false); Mesh(clothing.transform,"Bag",bag);
                PrefabUtility.SaveAsPrefabAsset(body,OutfitStage.AvatarPath); UnityEngine.Object.DestroyImmediate(body);
                Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath),D("group",OutfitStage.Group,"outfits",new List<object>()));
                var adjustment=D("part","eye","hue_shift",120,"saturation",1,"value",1);
                var selection=D("requirement_id","pink","outfit","bag","material","Assets/Authorized/Bag/Pink.mat");
                var plan=D("recolor",D("targets",new List<object>{adjustment,selection},"candidates",3));
                Avh.WriteJson(Avh.Abs("fixture-plan.json"),plan); Environment.SetEnvironmentVariable("AVH_PLAN",Avh.Json(plan));
                Avh.WriteJson(Avh.Abs(RecolorStage.RecipePath),D("targets",new List<object>{adjustment},"materialOps",new List<object>{selection},"chosen","A","reason","fixture","tiers",new List<object>{D("id","A","adjustments",new List<object>{adjustment}),D("id","B","adjustments",new List<object>{D("part","eye","hue_shift",240,"saturation",1,"value",1)})}));
                Avh.WriteJson(Avh.Abs(RecolorStage.LayerApplyPath),D("operations",new List<object>{D("requirement_id","lashes","textureAsset","Assets/Authorized/base.png","outputAsset","Assets/Authorized/lashes.png")}));
                AssetDatabase.SaveAssets(); var originalBytes=File.ReadAllBytes(Avh.Abs("Assets/Authorized/Eye.mat"));
                RecolorStage.Produce(); RecolorStage.MaterialTargetReadback();
                var output=AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath); var final=output.transform.Find("Face").GetComponent<Renderer>().sharedMaterial; var other=output.transform.Find("FaceOther").GetComponent<Renderer>().sharedMaterial;
                Check(Vector4.Distance(final.GetColor("_Color2nd"),Color.green)<0.001f,"Final slot lost second-layer eye adjustment");
                Check(final.GetTexture("_MainTex")==replacement,"Final slot lost lash texture");
                Check(final.GetTexture("_Main2ndTex")==mask,"Iris mask changed");
                Check(final!=other&&other.GetTexture("_MainTex")==replacement&&Vector4.Distance(other.GetColor("_Color2nd"),Color.green)<0.001f,"Copies leaked across renderers");
                Check(output.transform.Find("_Outfit/Outfit_bag/Bag").GetComponent<Renderer>().sharedMaterial==pink,"Independent vendor material selection lost");
                var rows=Avh.ReadJsonFile(Avh.Abs(RecolorStage.LedgerPath)).List("rows").Cast<Dictionary<string,object>>().Where(r=>r.Str("renderer")=="Face").ToList();
                Check(rows.Count==2&&rows.Select(r=>r.Str("material_guid")).Distinct().Count()==1,"Same-slot ledger names different copies");
                Check(rows.All(r=>r.Str("original_guid")==RecolorStage.Guid(eye)),"Original provenance lost");
                Check(Directory.GetFiles(Avh.Abs(RecolorStage.MaterialDir),"*.mat").Length==2,"Orphan same-slot material survived");
                Check(originalBytes.SequenceEqual(File.ReadAllBytes(Avh.Abs("Assets/Authorized/Eye.mat"))),"Source modified");
                var saved=File.ReadAllBytes(Avh.Abs(RecolorStage.AvatarPath)); RecolorStage.Produce();
                Check(saved.SequenceEqual(File.ReadAllBytes(Avh.Abs(RecolorStage.AvatarPath))),"Rerun compounded same-slot edits"); RecolorStage.MaterialTargetReadback();
                Avh.WriteJson(Avh.Abs("result.json"),D("ok",true,"assertions",assertions)); EditorApplication.Exit(0);
            }
            catch(Exception e){Avh.WriteJson(Avh.Abs("result.json"),D("ok",false,"assertions",assertions,"error",e.ToString()));Debug.LogException(e);EditorApplication.Exit(1);}
        }
    }
}
