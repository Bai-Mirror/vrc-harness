using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
    // Private sources and the explicit test configuration are provided outside the repository.
    public static class RealMenuGroupsIntegration
    {
        public static void Shapes()
        {
            try
            {
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(Avh.ReadJsonFile(Avh.Abs("real-plan.json"))));
                var avatar=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/_Harness/RealBuilt/Avatar.prefab"));
                var record=Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));var audit=SourceShapeAudit.For(avatar,Avh.Plan(),record);
                var sim=new AnimatorSim(avatar);var results=new List<object>();
                foreach(var values in MenuGroupAudit.Samples(Avh.Plan()))
                { var state=sim.Evaluate(values);var notes=new List<string>();var measured=audit.Check(avatar,state.Visible,state.WeightAt,state.Scale,notes,values);
                  results.Add(new Dictionary<string,object>{{"values",values},{"failures",measured.failures},{"unknown",measured.unknown},{"pairs",measured.pairs},{"delta",measured.delta},{"notes",notes}}); }
                Avh.WriteJson(Avh.Abs("shape-readback.json"),new Dictionary<string,object>{{"states",results}});UnityEngine.Object.DestroyImmediate(avatar);EditorApplication.Exit(0);
            }
            catch(Exception e){Debug.LogException(e);EditorApplication.Exit(1);}
        }
        public static void Cold()
        {
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(Avh.ReadJsonFile(Avh.Abs("real-plan.json"))));
            ColdImportStage.Run();
        }
        public static void Regression()
        {
            try
            {
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(Avh.ReadJsonFile(Avh.Abs("real-plan.json"))));
                var request = Avh.Abs("real-final-request.json");
                Avh.WriteJson(request, new Dictionary<string, object> { ["input"] = OptimizeStage.AvatarPath, ["output"] = BuildStage.OutDir,
                    ["name"] = "Avatar", ["report"] = Avh.Abs("real-final-report.json"), ["allowErrors"] = false });
                int code;
                SourceShapeAudit.CaptureSources(Avh.Plan(),Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)));
                try { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = MenuGroups.FinalizeReadableProperties; code = AvatarBuild.BuildArtifact.BuildOnce(request); }
                finally { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = null; }
                if (code != 0) throw new Exception("Final full preprocessing failed");
                BuildStage.Verify(BuildStage.BuiltPrefab); RegressionStage.Produce(); EditorApplication.Exit(0);
            }
            catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
        }
        public static void ProbeKeys()
        {
            try
            {
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(Avh.ReadJsonFile(Avh.Abs("real-plan.json"))));
                var plan=Avh.Plan();var body=AssetDatabase.LoadAssetAtPath<GameObject>(plan.Str("body_prefab"));
                var avatar=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(BuildStage.BuiltPrefab));
                var snapshot=new AnimatorSim(avatar).Evaluate(AvatarConfig.Defaults(plan));snapshot.Apply(avatar);
                var failures=new List<object>();
                foreach(Dictionary<string,object> row in Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)).List("outfits"))
                {
                    var source=AssetDatabase.LoadAssetAtPath<GameObject>(row.Str("prefab"));
                    foreach(var renderer in source.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(r=>r.sharedMesh!=null))
                    {
                        var relative=AnimationUtility.CalculateTransformPath(renderer.transform,source.transform);var path=row.Str("object")+"/"+relative;
                        var actual=(AvatarAudit.Locate(avatar.transform,path)??AvatarAudit.Locate(avatar.transform,row.Obj("built_paths")?.Str(path)))?.GetComponent<SkinnedMeshRenderer>();
                        if(actual?.sharedMesh==null){failures.Add(new Dictionary<string,object>{{"member",row.Str("id")},{"renderer",relative},{"reason","missing renderer"},{"source_keys",renderer.sharedMesh.blendShapeCount}});continue;}
                        for(var i=0;i<renderer.sharedMesh.blendShapeCount;i++)
                        {
                            var name=renderer.sharedMesh.GetBlendShapeName(i);var bodies=body.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(b=>b.sharedMesh!=null&&b.sharedMesh.GetBlendShapeIndex(name)>=0).ToList();
                            if(bodies.Count==0)continue;
                            if(bodies.Count!=1)
                            {
                                failures.Add(new Dictionary<string,object>{{"member",row.Str("id")},{"renderer",relative},{"key",name},{"body_matches",bodies.Count},
                                    {"body_paths",bodies.Select(b=>{var p=AnimationUtility.CalculateTransformPath(b.transform,body.transform);var a=AvatarAudit.Locate(avatar.transform,p)?.GetComponent<SkinnedMeshRenderer>();
                                        return(object)new Dictionary<string,object>{{"path",p},{"visible",snapshot.Visible(p)},{"actual_index",a==null||a.sharedMesh==null?-1:a.sharedMesh.GetBlendShapeIndex(name)}};}).ToList()}});continue;
                            }
                            var bodyPath=bodies.Count==1?AnimationUtility.CalculateTransformPath(bodies[0].transform,body.transform):"";
                            var targetBody=AvatarAudit.Locate(avatar.transform,bodyPath)?.GetComponent<SkinnedMeshRenderer>();
                            if(bodies.Count!=1||actual.sharedMesh.GetBlendShapeIndex(name)<0||targetBody?.sharedMesh?.GetBlendShapeIndex(name)<0||targetBody==null)
                                failures.Add(new Dictionary<string,object>{{"member",row.Str("id")},{"renderer",relative},{"key",name},{"body_matches",bodies.Count},{"actual_index",actual.sharedMesh.GetBlendShapeIndex(name)},{"body_path",bodyPath},{"body_index",targetBody?.sharedMesh?.GetBlendShapeIndex(name)}});
                        }
                    }
                }
                var missingShaders=new List<object>();
                foreach(var prefab in plan.List("outfits").Cast<Dictionary<string,object>>().Select(r=>AssetDatabase.LoadAssetAtPath<GameObject>(r.Str("prefab"))).Append(body).Append(avatar))
                    foreach(var material in prefab.GetComponentsInChildren<Renderer>(true).SelectMany(r=>r.sharedMaterials).Where(m=>m!=null).Distinct())
                        if(material.shader==null||material.shader.name=="Hidden/InternalErrorShader") missingShaders.Add(new Dictionary<string,object>{{"prefab",AssetDatabase.GetAssetPath(prefab)},{"material",AssetDatabase.GetAssetPath(material)}});
                Avh.WriteJson(Avh.Abs("key-probe.json"),new Dictionary<string,object>{{"unknown",failures},{"missing_shaders",missingShaders}});UnityEngine.Object.DestroyImmediate(avatar);EditorApplication.Exit(0);
            }
            catch(Exception e){Debug.LogException(e);EditorApplication.Exit(1);}
        }
        public static void Audit()
        {
            try
            {
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(Avh.ReadJsonFile(Avh.Abs("real-plan.json"))));
                var built = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/_Harness/RealBuilt/Avatar.prefab"));
                try
                {
                    var notes = new List<string>(); var adapters = new List<object>();
                    foreach (var c in AvatarAudit.Layers(built.GetComponent<VRC.SDK3.Avatars.Components.VRCAvatarDescriptor>()).Select(x => x.controller).Distinct())
                        foreach (var l in c.layers.Where(l => l.name.Contains("DelayDisable"))) foreach (var s in AvatarAudit.States(l.stateMachine))
                            adapters.Add(new Dictionary<string, object> { ["layer"] = l.name, ["wd"] = s.writeDefaultValues, ["motion"] = s.motion?.GetType().FullName,
                                ["blend"] = s.motion is UnityEditor.Animations.BlendTree d ? d.blendType.ToString() : "",
                                ["children"] = s.motion is UnityEditor.Animations.BlendTree direct ? direct.children.Select(child => (object)new Dictionary<string, object> {
                                    ["parameter"] = child.directBlendParameter, ["default"] = c.parameters.Where(p => p.name == child.directBlendParameter).Select(p => (object)p.defaultFloat).ToList(),
                                    ["motion"] = child.motion?.GetType().FullName, ["blend"] = child.motion is UnityEditor.Animations.BlendTree t ? t.blendType.ToString() : "",
                                    ["proxy"] = child.motion is UnityEditor.Animations.BlendTree b ? b.blendParameter : "",
                                    ["parts"] = child.motion is UnityEditor.Animations.BlendTree buffer ? buffer.children.Select(part => (object)new Dictionary<string, object> {
                                        ["threshold"] = part.threshold, ["motion"] = part.motion?.name,
                                        ["bindings"] = part.motion is AnimationClip clip ? AnimationUtility.GetCurveBindings(clip).Select(ecb => (object)(ecb.path + "|" + ecb.propertyName + ":" + string.Join(",", AnimationUtility.GetEditorCurve(clip, ecb).keys.Select(k => k.time + "/" + k.value)))).ToList() : new List<object>() }).ToList() : new List<object>() }).ToList() : new List<object>() });
                    Avh.WriteJson(Avh.Abs("real-audit.json"), new Dictionary<string, object> { ["metrics"] = MenuGroupAudit.Metrics(built, notes), ["adapters"] = adapters, ["notes"] = notes.Cast<object>().ToList() });
                }
                finally { UnityEngine.Object.DestroyImmediate(built); }
                EditorApplication.Exit(0);
            }
            catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
        }
        public static void Run() => RunCore(true);
        public static void NativeReadback() => RunCore(false);
        static void RunCore(bool all)
        {
            var output = Avh.Abs(Avh.Env("AVH_MENU_GROUPS_RESULT", "real-result.json"));
            try
            {
                var raw = Avh.ReadJsonFile(Avh.Abs("real-plan.json")); Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(raw));
                var plan = Avh.Plan(); var notes = new List<string>();
                var assembled = OutfitStage.Assemble(AssetDatabase.LoadAssetAtPath<GameObject>(plan.Str("body_prefab")), plan, out var hidden, out var rows);
                var record = new Dictionary<string, object> { ["schema"] = "outfit/0.4", ["avatar_config"] = plan.Obj("avatar_config"), ["outfits"] = rows,
                    ["body_prefab"] = plan.Str("body_prefab"), ["hidden_body_parts"] = hidden };
                OutfitStage.EnsureFolder(OutfitStage.Dir); Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), record);
                if (!OutfitMeasure.GroupDefaults(assembled, record, plan, notes)) throw new Exception("Initial defaults: " + string.Join(";", notes));
                if (MaterialAxes.Groups(plan).Any())
                {
                    MaterialAxes.Produce(plan, record);
                    MaterialAxes.Apply(assembled, plan, record, AvatarConfig.Defaults(plan));
                }
                MenuGroups.Compile(assembled, plan, record);
                PrefabUtility.SaveAsPrefabAsset(assembled, MenuStage.AvatarPath); UnityEngine.Object.DestroyImmediate(assembled);
                OptimizeStage.CreatePreservedOutput(AssetDatabase.LoadAssetAtPath<GameObject>(MenuStage.AvatarPath));
                var request = Avh.Abs("real-build-request.json");
                Avh.WriteJson(request, new Dictionary<string, object> { ["input"] = MenuStage.AvatarPath, ["output"] = "Assets/_Harness/RealBuilt",
                    ["name"] = "Avatar", ["report"] = Avh.Abs("real-build-report.json"), ["allowErrors"] = false });
                int code;
                try { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = MenuGroups.FinalizeReadableProperties; code = AvatarBuild.BuildArtifact.BuildOnce(request); }
                finally { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = null; }
                if (code != 0) throw new Exception("Complete preprocessing failed; inspect real-build-report.json");
                var built = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>("Assets/_Harness/RealBuilt/Avatar.prefab"));
                try
                {
                    var metrics = MenuGroupAudit.Metrics(built, notes);
                    var failures = MenuGroupAudit.Assertions(built, notes, all);
                    var runtime = MenuGroupAudit.RuntimeAssertions(built, notes, out var steps);
                    Avh.WriteJson(output, new Dictionary<string, object> { ["ok"] = failures == 0 && runtime == 0, ["metrics"] = metrics,
                        ["coverage_scope"] = all ? "full static and native" : "representative static and native",
                        ["static_states"] = all ? MenuGroupAudit.Cells(plan).Count : MenuGroupAudit.Samples(plan).Count, ["runtime_events"] = steps, ["assertion_failures"] = failures,
                        ["runtime_failures"] = runtime, ["rows"] = rows, ["notes"] = notes.Cast<object>().ToList() });
                    EditorApplication.Exit(failures == 0 && runtime == 0 ? 0 : 1);
                }
                finally { UnityEngine.Object.DestroyImmediate(built); }
            }
            catch (Exception e) { Avh.WriteJson(output, new Dictionary<string, object> { ["ok"] = false, ["error"] = e.ToString() }); Debug.LogException(e); EditorApplication.Exit(1); }
        }
        public static void Probe()
        {
            try
            {
                var raw = Avh.ReadJsonFile(Avh.Abs("real-plan.json"));
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(raw)); var plan = Avh.Plan();
                var body = AssetDatabase.LoadAssetAtPath<GameObject>(plan.Str("body_prefab"));
                var rows = new List<object>();
                foreach (Dictionary<string, object> member in plan.List("outfits"))
                {
                    var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(member.Str("prefab"));
                    if (prefab == null) throw new Exception("Missing source " + member.Str("id"));
                    var clone = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                    try
                    {
                        rows.Add(new Dictionary<string, object> { ["id"] = member.Str("id"), ["kind"] = OutfitStage.Classify(clone),
                            ["transforms"] = clone.GetComponentsInChildren<Transform>(true).Select(t => (object)new Dictionary<string, object> {
                                ["path"] = AnimationUtility.CalculateTransformPath(t, clone.transform), ["position"] = t.position.ToString("R"),
                                ["rotation"] = t.eulerAngles.ToString("R"), ["components"] = t.GetComponents<Component>().Where(c => c != null).Select(c => (object)c.GetType().FullName).ToList() }).ToList(),
                            ["renderers"] = clone.GetComponentsInChildren<SkinnedMeshRenderer>(true).Select(r => (object)new Dictionary<string, object> {
                                ["path"] = AnimationUtility.CalculateTransformPath(r.transform, clone.transform), ["root_bone"] = r.rootBone?.name,
                                ["bones"] = r.bones.Select(b => (object)b?.name).ToList() }).ToList() });
                    }
                    finally { UnityEngine.Object.DestroyImmediate(clone); }
                }
                Avh.WriteJson(Avh.Abs("real-probe.json"), new Dictionary<string, object> { ["members"] = rows,
                    ["body_bones"] = body.GetComponentsInChildren<Transform>(true).Select(t => (object)AnimationUtility.CalculateTransformPath(t, body.transform)).ToList() });
                EditorApplication.Exit(0);
            }
            catch (Exception e) { Debug.LogException(e); EditorApplication.Exit(1); }
        }
    }
}
