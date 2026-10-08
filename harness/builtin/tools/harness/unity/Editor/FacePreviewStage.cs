// Actual source/candidate rendering. The shared camera protocol is derived from loaded model bounds.
// Preview instances and their scene are disposable; source assets and the candidate are never saved.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace AVH.Harness
{
    public static class FacePreviewStage
    {
        const string Manifest = "_harness/face/preview/manifest.json";
        const int Size = 768;
        static Dictionary<string, object> D(params object[] pairs)
        { var result = new Dictionary<string, object>(); for (var i = 0; i < pairs.Length; i += 2) result[(string)pairs[i]] = pairs[i + 1]; return result; }
        static void Check(bool value, string reason) { if (!value) throw new InvalidOperationException(reason); }
        static string Safe(string path)
        {
            Check(!string.IsNullOrEmpty(path) && !path.Contains('\\') && !path.Contains(':') && path.Split('/').All(p => p.Length > 0 && p != "." && p != ".."), "Invalid project-relative preview path");
            var absolute = Path.GetFullPath(Avh.Abs(path));
            Check(absolute.StartsWith(Path.GetFullPath(Avh.ProjectDir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "Preview path escapes project");
            Avh.AssertManagedPath(absolute);
            return path;
        }
        static Dictionary<string, object> Identity(string path) => D("path", Safe(path), "sha256", SourceHash(path));
        static string SourceHash(string path)
        {
            path=Safe(path);var info=new FileInfo(Avh.Abs(path));Check(info.Exists&&info.Length<=2L*1024*1024*1024,"Preview source dependency too large or missing");var length=info.Length;var changed=info.LastWriteTimeUtc;
            string hash;using(var source=File.OpenRead(Avh.Abs(path)))using(var sha=SHA256.Create())hash=BitConverter.ToString(sha.ComputeHash(source)).Replace("-","").ToLowerInvariant();
            info.Refresh();Check(info.Length==length&&info.LastWriteTimeUtc==changed,"Source dependency changed while hashing");return hash;
        }
        static List<object> SourceAuthorityReferences(Dictionary<string,object> holder,Dictionary<string,object> observation,string targetId)
        {
            Check(!(holder.ContainsKey("sourceAuthority")&&holder.ContainsKey("sourceMapping")),"Source authority and mapping cannot coexist");var refs=new Dictionary<string,object>();if(!holder.ContainsKey("sourceAuthority"))return new List<object>();
            Action<Dictionary<string,object>,string> add=(reference,prefix)=>{var path=reference.Str("file");Check(path.StartsWith(prefix,StringComparison.Ordinal),"Invalid source authority dependency scope");var identity=Identity(path);Check(identity.Str("sha256")==reference.Str("sha256"),"Source authority dependency changed");if(refs.TryGetValue(path,out var prior))Check(((Dictionary<string,object>)prior).Str("sha256")==identity.Str("sha256"),"Source dependency revision conflict");refs[path]=identity;};
            var authorityRef=holder.Obj("sourceAuthority");add(authorityRef,"Assets/_Harness/Face/Catalogs/");var authority=Avh.ReadJsonFile(Avh.Abs(authorityRef.Str("file")));var target=observation.List("targets").Cast<Dictionary<string,object>>().Single(t=>t.Str("targetId")==targetId);
            Check(authority.Str("schema")=="face-unity-imported-source/0.1"&&authority.ContainsKey("productionAccepted")&&authority["productionAccepted"] is bool accepted&&!accepted&&authority.Str("targetId")==targetId&&authority.Str("meshSha256")==target.Str("meshSha256")&&Avh.Json(authority.Obj("sourceModel"))==Avh.Json(target.Obj("mesh")),"Source authority targets another observed mesh");
            Check(authority.Obj("observation").Str("file")==FaceStage.ObservationPath&&authority.Obj("observation").Str("sha256")==SourceHash(FaceStage.ObservationPath)&&Avh.Json(authority.Obj("unityFrameEvidence"))==Avh.Json(target.Obj("frameEvidence")),"Source authority uses another observation/frame revision");
            add(authority.Obj("observation"),"_harness/face/");add(authority.Obj("unityFrameEvidence"),"_harness/face/source-evidence/");
            foreach(var key in new[]{"effectiveSource","effectiveEvidence","originalBlenderCatalog","originalBlenderEvidence"})add(authority.Obj(key),"Assets/_Harness/Face/Catalogs/");
            var model=authority.Obj("sourceModel");Check(model.Str("path").StartsWith("Assets/",StringComparison.Ordinal),"Source model outside Assets");add(D("file",model.Str("path"),"sha256",model.Str("sha256")),"Assets/");add(D("file",model.Str("path")+".meta","sha256",model.Str("metaSha256")),"Assets/");
            Action<object,string> binary=(value,prefix)=>{if(value is List<object>)return;var reference=value as Dictionary<string,object>;Check(reference!=null&&reference.Keys.OrderBy(k=>k,StringComparer.Ordinal).SequenceEqual(new[]{"count","encoding","file","sha256"})&&reference.Str("encoding")=="float32-le"&&reference.Str("file").EndsWith(".bin",StringComparison.Ordinal),"Invalid source frame binary reference");var count=Convert.ToInt64(reference["count"]);Check(count>=0&&Convert.ToDouble(reference["count"])==count&&new FileInfo(Avh.Abs(Safe(reference.Str("file")))).Length==count*12,"Source frame binary length changed");add(reference,prefix);};
            foreach(var key in new[]{"effectiveEvidence","originalBlenderEvidence"}){var evidence=Avh.ReadJsonFile(Avh.Abs(authority.Obj(key).Str("file")));Check(evidence.Str("schema")=="face-blender-source-evidence/0.1","Unsupported effective source geometry evidence");foreach(var mesh in evidence.List("meshes").Cast<Dictionary<string,object>>())foreach(var shape in mesh.List("keys").Cast<Dictionary<string,object>>())foreach(var field in new[]{"coordinates","cornerNormals","vertexNormals"})if(shape.ContainsKey(field))binary(shape[field],"Assets/_Harness/Face/Catalogs/");}
            var frames=Avh.ReadJsonFile(Avh.Abs(authority.Obj("unityFrameEvidence").Str("file")));Check(frames.Str("schema")=="face-unity-frame-evidence/0.1","Unsupported Unity frame evidence");foreach(var shape in frames.List("frames").Cast<Dictionary<string,object>>())foreach(var frame in shape.List("frames").Cast<Dictionary<string,object>>())foreach(var key in new[]{"vertices","normals","tangents"})binary(frame[key],"_harness/face/source-evidence/");
            return refs.Values.ToList();
        }
        static List<object> Dependencies(string source, string candidate)
        {
            var paths = AssetDatabase.GetDependencies(new[] { source, candidate }, true).Where(p => p.StartsWith("Assets/", StringComparison.Ordinal) && File.Exists(Avh.Abs(p))).ToList();
            paths.AddRange(paths.Where(p => File.Exists(Avh.Abs(p + ".meta"))).Select(p => p + ".meta").ToArray());
            return paths.Distinct().OrderBy(p => p, StringComparer.Ordinal).Select(p => (object)Identity(p)).ToList();
        }
        static GameObject Instance(string path, Scene scene)
        {
            Check(path.StartsWith("Assets/", StringComparison.Ordinal) && path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase), "Preview requires an actual project prefab");
            Safe(path); var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path); Check(prefab != null, "Preview prefab failed to load");
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab, scene); instance.hideFlags = HideFlags.HideAndDontSave;
            instance.transform.position = Vector3.zero; instance.transform.rotation = Quaternion.identity;
            foreach (var animator in instance.GetComponentsInChildren<Animator>(true)) animator.enabled = false;
            foreach (var component in instance.GetComponentsInChildren<MonoBehaviour>(true)) if (component != null) component.enabled = false;
            foreach (var renderer in instance.GetComponentsInChildren<SkinnedMeshRenderer>(true)) renderer.updateWhenOffscreen = true;
            return instance;
        }
        static SkinnedMeshRenderer TargetRenderer(GameObject instance, Dictionary<string, object> target)
        {
            var path=target.Str("rendererPath");var transform=path==""?instance.transform:instance.transform.Find(path);
            Check(transform!=null,"Observed preview target disappeared");var list=transform.GetComponents<SkinnedMeshRenderer>();var index=Convert.ToInt32(target["rendererIndex"]);
            Check(index>=0&&index<list.Length&&list[index].sharedMesh!=null,"Observed preview mesh missing");return list[index];
        }
        static int[] AffectedVertices(GameObject instance, Dictionary<string,object> target, Dictionary<string,object>[] candidates)
        {
            var mesh=TargetRenderer(instance,target).sharedMesh;var affected=new HashSet<int>();var deltas=new Vector3[mesh.vertexCount];
            foreach(var key in candidates.SelectMany(c=>c.Obj("weightsUnityPercent").Keys).Distinct())
            {
                var index=mesh.GetBlendShapeIndex(key);Check(index>=0,"Unknown candidate key");
                for(var frame=0;frame<mesh.GetBlendShapeFrameCount(index);frame++)
                {
                    mesh.GetBlendShapeFrameVertices(index,frame,deltas,null,null);
                    for(var vertex=0;vertex<deltas.Length;vertex++)if(deltas[vertex].sqrMagnitude>0)affected.Add(vertex);
                }
            }
            Check(affected.Count>0,"Candidate keys have no measured geometric effect");return affected.OrderBy(v=>v).ToArray();
        }
        static Bounds BoundsOf(GameObject instance, Dictionary<string, object> target, int[] affected=null)
        {
            Renderer[] renderers;
            if (target != null)
            {
                var renderer=TargetRenderer(instance,target);var transform=renderer.transform;
                // Bake current prefab defaults on the temporary instance for actual deformed bounds.
                // Explicit scale mode preserves mesh-space vertices before TransformPoint, including FBX import scale.
                var baked = new Mesh(); try { renderer.BakeMesh(baked,true); var b = baked.bounds;
                    if(affected!=null)
                    {
                        var vertices=baked.vertices;Check(vertices.Length==renderer.sharedMesh.vertexCount,"Actual skinning readback unavailable");
                        var measured=new Bounds(transform.TransformPoint(vertices[affected[0]]),Vector3.zero);
                        foreach(var index in affected)measured.Encapsulate(transform.TransformPoint(vertices[index]));return measured;
                    }
                    var corners = new[] { new Vector3(-1,-1,-1),new Vector3(-1,-1,1),new Vector3(-1,1,-1),new Vector3(-1,1,1),new Vector3(1,-1,-1),new Vector3(1,-1,1),new Vector3(1,1,-1),new Vector3(1,1,1) };
                    var points = corners.Select(c => transform.TransformPoint(b.center + Vector3.Scale(b.extents, c))).ToArray(); var bounds = new Bounds(points[0], Vector3.zero); foreach (var p in points) bounds.Encapsulate(p); return bounds;
                } finally { UnityEngine.Object.DestroyImmediate(baked); }
            }
            renderers = instance.GetComponentsInChildren<Renderer>().Where(r => r.enabled).ToArray(); Check(renderers.Length > 0, "Prefab has no visible model");
            var result = renderers[0].bounds; foreach (var r in renderers) result.Encapsulate(r.bounds); return result;
        }
        static Light Lamp(Scene scene, string name, Vector3 angles, float strength)
        {
            var gameObject = new GameObject(name); SceneManager.MoveGameObjectToScene(gameObject, scene); var light = gameObject.AddComponent<Light>();
            light.type = LightType.Directional; light.color = Color.white; light.intensity = strength; light.shadows = LightShadows.None; gameObject.transform.rotation = Quaternion.Euler(angles); return light;
        }
        static Dictionary<string, object> Image(Camera camera, string directory, string version, string view)
        {
            var path = Safe(directory + "/" + version + "-" + view + ".png"); var target = new RenderTexture(Size, Size, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            var texture = new Texture2D(Size, Size, TextureFormat.RGB24, false); var previous = RenderTexture.active;
            var frozen=new List<(SkinnedMeshRenderer source,GameObject holder,Mesh mesh)>();
            var poseBytes=new MemoryStream();var writer=new BinaryWriter(poseBytes);
            try
            {
                // Camera.Render can reuse a previous skinning cache. Render a
                // fresh BakeMesh for every state and bind its actual vertices.
                foreach(var renderer in Resources.FindObjectsOfTypeAll<SkinnedMeshRenderer>().Where(r=>r.gameObject.scene==camera.scene&&r.gameObject.activeInHierarchy&&r.enabled))
                {
                    var mesh=new Mesh();renderer.BakeMesh(mesh,false);Check(mesh.vertexCount==renderer.sharedMesh.vertexCount,"Preview skinning vertex count changed");
                    foreach(var p in mesh.vertices){writer.Write(p.x);writer.Write(p.y);writer.Write(p.z);}
                    var holder=new GameObject("Frozen preview pose");holder.transform.SetParent(renderer.transform,false);holder.AddComponent<MeshFilter>().sharedMesh=mesh;holder.AddComponent<MeshRenderer>().sharedMaterials=renderer.sharedMaterials;
                    frozen.Add((renderer,holder,mesh));renderer.enabled=false;
                }
                Check(target.Create(), "Render target unavailable (a graphics-capable Unity session is required)"); camera.targetTexture = target; camera.Render(); RenderTexture.active = target;
                texture.ReadPixels(new Rect(0, 0, Size, Size), 0, 0); texture.Apply();
                var pixels = texture.GetPixels32(); var baseline = pixels[0]; var different = pixels.Count(p => p.r != baseline.r || p.g != baseline.g || p.b != baseline.b);
                Check(different >= 32, "Preview rendered no discernible model; background is not evidence");
                var bytes = texture.EncodeToPNG(); Check(bytes != null && bytes.Length > 100 && bytes.Length <= 4 * 1024 * 1024, "PNG render failed or exceeds transport limit");
                File.WriteAllBytes(Avh.Abs(path), bytes);
                return D("id", version + "-" + view, "version", version, "view", view, "path", path, "sha256", FaceStage.Hash(bytes), "width", Size, "height", Size,"poseSha256",FaceStage.Hash(poseBytes.ToArray()));
            }
            finally { foreach(var item in frozen){item.source.enabled=true;UnityEngine.Object.DestroyImmediate(item.holder);UnityEngine.Object.DestroyImmediate(item.mesh);}writer.Dispose();poseBytes.Dispose();camera.targetTexture = null; RenderTexture.active = previous; target.Release(); UnityEngine.Object.DestroyImmediate(target); UnityEngine.Object.DestroyImmediate(texture); }
        }
        public static void Render() => Avh.Stage("face.preview", WritePreview, false);
        public static void RenderCandidates() => Avh.Stage("face.candidates", WriteCandidatePreview, false);
        static Dictionary<string,object> QualityReview(GameObject original,GameObject changed,Dictionary<string,object> target,
            Dictionary<string,object> input,Camera camera,string directory,float distance)
        {
            var reference=input.Obj("blenderVerification");if(reference==null)return null;
            Check(SourceHash(reference.Str("file"))==reference.Str("sha256"),"Quality review verification changed");
            var verification=Avh.ReadJsonFile(Avh.Abs(reference.Str("file")));var compensation=verification.Obj("compensation");
            if(compensation==null)return null;
            var readings=compensation.List("quality").Cast<Dictionary<string,object>>().ToArray();var rows=new List<object>();var representatives=new Dictionary<string,Dictionary<string,object>>();var raw=0;var unique=0;
            foreach(var reading in readings){
                raw+=reading.List("findings").Count;
                Check(reading.ContainsKey("reviewGroups"),"Quality findings require state/region/type review groups");
                foreach(var value in reading.List("reviewGroups").Cast<Dictionary<string,object>>()){
                    var row=new Dictionary<string,object>(value);row["state"]=reading.Str("state");row["weight"]=reading.ContainsKey("weight")?reading["weight"]:null;
                    unique+=Convert.ToInt32(row["uniqueCount"]);var key=row.Str("region")+"|"+row.Str("kind")+"|"+row.Str("baseline");row["representativeId"]=key;rows.Add(row);
                    if(!representatives.TryGetValue(key,out var previous)||Convert.ToDouble(row["maximumChangeMeters"])>Convert.ToDouble(previous["maximumChangeMeters"]))representatives[key]=row;
                }
            }
            Check(rows.Cast<Dictionary<string,object>>().Sum(r=>Convert.ToInt32(r["rawCount"]))==raw,"Quality review lost raw findings");
            var before=TargetRenderer(original,target);var after=TargetRenderer(changed,target);
            foreach(var renderer in new[]{before,after})for(var k=0;k<renderer.sharedMesh.blendShapeCount;k++)renderer.SetBlendShapeWeight(k,0);
            var bounds=BoundsOf(original,target);
            var design=Avh.ReadJsonFile(Avh.Abs(input.Obj("blenderDesign").Str("file")));var regions=design.Obj("recipe").Obj("compensation").List("regions").Cast<Dictionary<string,object>>().ToArray();
            var views=new List<object>();var overview=new List<object>();var serial=0;
            foreach(var item in representatives.OrderBy(x=>x.Key,StringComparer.Ordinal)){
                var row=item.Value;var state=row.Str("state");var weight=row["weight"]==null?0f:Convert.ToSingle(row["weight"])*100f;
                foreach(var renderer in new[]{before,after}){for(var k=0;k<renderer.sharedMesh.blendShapeCount;k++)renderer.SetBlendShapeWeight(k,0);if(state!="basis"){var key=renderer.sharedMesh.GetBlendShapeIndex(state);Check(key>=0,"Quality review state missing from actual candidate");renderer.SetBlendShapeWeight(key,weight);}}
                var focus=bounds.center;var ortho=Mathf.Max(bounds.extents.x,bounds.extents.y)*.65f;var region=row.Str("region");
                var eye=regions.SingleOrDefault(r=>region==r.Str("side")+"-eye");
                if(eye!=null){focus=before.bones.Single(b=>b.name==eye.Str("bone")).position;ortho=Mathf.Max(bounds.extents.x*.35f,.01f);}
                else if(region=="lower-face")focus-=Vector3.up*bounds.extents.y*.4f;
                else if(region=="upper-face")focus+=Vector3.up*bounds.extents.y*.4f;
                camera.orthographicSize=Mathf.Max(ortho,.005f);var ids=new List<object>();var prefix="quality-"+(serial++);
                foreach(var view in new[]{"front","side"}){camera.transform.position=focus+(view=="front"?Vector3.forward:Vector3.right)*distance;camera.transform.LookAt(focus,Vector3.up);
                    foreach(var version in new[]{"before","after"}){original.SetActive(version=="before");changed.SetActive(version=="after");var image=Image(camera,directory,version,prefix+"-"+view);image["id"]=prefix+"-"+version+"-"+view;image["representativeId"]=item.Key;image["state"]=state;image["weight"]=row["weight"];views.Add(image);ids.Add(image["id"]);}}
                var members=rows.Cast<Dictionary<string,object>>().Where(r=>r.Str("representativeId")==item.Key).ToArray();
                overview.Add(D("id",item.Key,"region",region,"kind",row["kind"],"baseline",row["baseline"],"stateCount",members.Length,"rawCount",members.Sum(r=>Convert.ToInt32(r["rawCount"])),"uniqueCount",members.Sum(r=>Convert.ToInt32(r["uniqueCount"])),
                    "maximumChangeMm",members.Max(r=>Convert.ToDouble(r["maximumChangeMeters"]))*1000,"maximumFootprintMm",members.Max(r=>Convert.ToDouble(r["maximumFootprintMeters"]))*1000,
                    "estimatedChangePixels",members.Max(r=>Convert.ToDouble(r["maximumChangeMeters"]))*Size/(2*camera.orthographicSize),"representativeState",state,"representativeWeight",row["weight"],"imageIds",ids,"orthographicSize",camera.orthographicSize));
            }
            return D("schema","face-quality-review/0.1","productionAccepted",false,"verification",Identity(reference.Str("file")),"rawFindingCount",raw,"uniqueFindingCount",unique,"stateCount",readings.Length,
                "groups",overview,"states",rows,"images",views,"limitations",new[]{"位移像素估计按区域特写的正交相机比例计算，不代表可见破损像素。","原版对照按同一键、权重及机位生成；特写取每组最大位移的代表状态，并非每个状态逐图核对。","表面遮挡、全像素纹理 alpha 和全部 shader 尚未测量；是否可见由用户看图判断。"});
        }
        public static void WriteCandidatePreview()
        {
            const string collectionPath = "_harness/face/candidates.json", inputPath = "Assets/_Harness/Face/preview-input.json", manifestPath = "_harness/face/candidate-preview/manifest.json";
            var collection = Avh.ReadJsonFile(Avh.Abs(Safe(collectionPath))); var input = Avh.ReadJsonFile(Avh.Abs(Safe(inputPath)));
            var collectionHash = FaceStage.FileHash(collectionPath); var observedHash = FaceStage.FileHash(FaceStage.ObservationPath);
            Check(collection.Str("schema") == "face-candidate-set/0.1" && input.Str("schema") == "face-preview-input/0.1", "Unsupported candidate collection or preview input");
            Check(input.Str("collectionSha256") == collectionHash && collection.Str("observationSha256") == observedHash && input.Str("observationSha256") == observedHash, "Candidate collection revision changed");
            Check(FaceStage.FileHash("_harness/face/request.json") == collection.Str("requestSha256"), "Candidate request changed");
            var source = input.Str("sourcePrefab"); Check(collection.Str("sourcePrefab") == source && collection.Str("targetId") == input.Str("targetId"), "Preview target differs from collection");
            Check(FaceStage.FileHash(Safe("Assets/_Harness/Face/CandidateSets/" + collection.Str("id") + "/candidate-set.json")) == collectionHash, "Immutable candidate set differs from runtime pointer");
            var observation = Avh.ReadJsonFile(Avh.Abs(Safe(FaceStage.ObservationPath)));
            // Compare the producer's exact native-number serialization. Re-serialising parsed doubles changes
            // float exponent spellings and would reject unchanged real mesh observations.
            Check(FaceStage.Hash(System.Text.Encoding.UTF8.GetBytes(Avh.Json(FaceStage.ObserveSource(source)) + "\n")) == observedHash, "Actual source observation changed");
            var target = observation.List("targets").Cast<Dictionary<string, object>>().Single(t => t.Str("targetId") == input.Str("targetId"));
            var candidates = collection.List("candidates").Cast<Dictionary<string, object>>().ToArray();
            Check(candidates.Length >= 2 && candidates.Length <= 5 && candidates.Select(c => c.Str("id")).Distinct().Count() == candidates.Length, "Two to five unique actual candidates required");
            Check(Avh.Json(input.List("candidates")) == Avh.Json(candidates.Select(c => (object)D("id", c.Str("id"), "weightsUnityPercent", c.Obj("weightsUnityPercent"))).ToList()), "Preview combinations differ from frozen collection");
            var bindings = D("collection", Identity(collectionPath), "input", Identity(inputPath), "observation", Identity(FaceStage.ObservationPath), "source", Identity(source), "request", Identity("_harness/face/request.json"));
            var catalog = collection.Obj("blenderCatalog");var catalogPath=catalog.Str("file");
            Check((catalogPath=="Assets/_Harness/Face/catalog.json"||System.Text.RegularExpressions.Regex.IsMatch(catalogPath,@"^Assets/_Harness/Face/Catalogs/[a-f0-9]{64}/catalog\.json$"))&&FaceStage.FileHash(Safe(catalogPath))==catalog.Str("sha256"),"Frozen candidate catalog changed");
            var references = new List<object> { Identity(catalog.Str("file")) };references.AddRange(SourceAuthorityReferences(collection,observation,input.Str("targetId")));var mathematicallyValidated=true;
            if(collection.ContainsKey("sourceMapping"))
            {
                var mapping=collection.Obj("sourceMapping");Check(mapping.Str("file").StartsWith("Assets/_Harness/Face/Catalogs/",StringComparison.Ordinal)&&FaceStage.FileHash(Safe(mapping.Str("file")))==mapping.Str("sha256"),"Frozen candidate source mapping changed");
                references.Add(Identity(mapping.Str("file")));
            }
            foreach (var candidate in candidates) foreach (var key in new[] { "design", "validation" })
            {
                var reference = candidate.Obj(key); Check(reference.Str("file").StartsWith("Assets/_Harness/Face/CandidateSets/", StringComparison.Ordinal), "Candidate evidence is outside immutable set");
                Check(FaceStage.FileHash(Safe(reference.Str("file"))) == reference.Str("sha256"), "Candidate evidence changed"); references.Add(Identity(reference.Str("file")));
            }
            foreach(var candidate in candidates)
            {
                var design=Avh.ReadJsonFile(Avh.Abs(candidate.Obj("design").Str("file")));var validation=Avh.ReadJsonFile(Avh.Abs(candidate.Obj("validation").Str("file")));
                mathematicallyValidated=mathematicallyValidated&&design.Str("schema")=="face-design/0.1"&&!string.IsNullOrWhiteSpace(design.Str("revisionId"))&&
                    validation.Str("schema")=="face-candidate-validation/0.1"&&(collection.Str("route")=="native-fbx/1" ? validation.Str("status")=="shape_combination_validated" && validation.Str("route")=="native-fbx/1" && design.Str("route")=="native-fbx/1" : validation.Str("status")=="mathematical_candidate_validated")&&validation.Str("revisionId")==design.Str("revisionId")&&
                    validation.Str("designFileSha256")==candidate.Obj("design").Str("sha256")&&validation.ContainsKey("productionAccepted")&&validation["productionAccepted"] is bool accepted&&!accepted;
            }
            references=references.Cast<Dictionary<string,object>>().GroupBy(reference=>reference.Str("path"),StringComparer.Ordinal).Select(group=>(object)group.First()).ToList();
            foreach (var pair in collection.Obj("tools").Where(p => p.Key.EndsWith(".cs", StringComparison.Ordinal)))
                Check(FaceStage.FileHash(Safe("Assets/_HarnessTools/Editor/" + pair.Key)) == Convert.ToString(pair.Value), "Installed candidate preview tool changed");
            var dependencies = Dependencies(source, source); var scene = EditorSceneManager.NewPreviewScene(); var instances = new List<GameObject>();
            var lighting = RenderSettings.ambientMode; var ambient = RenderSettings.ambientLight; var fog = RenderSettings.fog;
            try
            {
                var original = Instance(source, scene); instances.Add(original); var affected=AffectedVertices(original,target,candidates);var bounds = BoundsOf(original, target,affected);
                foreach (var candidate in candidates)
                {
                    Check(!string.IsNullOrWhiteSpace(candidate.Str("id")) && candidate.Str("id").Length <= 128, "Invalid candidate identity");
                    var instance = Instance(source, scene); instances.Add(instance);
                    var path = target.Str("rendererPath"); var transform = path == "" ? instance.transform : instance.transform.Find(path);
                    Check(transform != null, "Exact candidate renderer missing"); var renderer = transform.GetComponents<SkinnedMeshRenderer>()[Convert.ToInt32(target["rendererIndex"])];
                    var weights = candidate.Obj("weightsUnityPercent"); Check(weights.Count > 0, "Empty candidate combination");
                    foreach (var weight in weights)
                    {
                        var index = renderer.sharedMesh.GetBlendShapeIndex(weight.Key); var value = Convert.ToSingle(weight.Value);
                        Check(index >= 0 && float.IsFinite(value), "Candidate names an unknown key or nonfinite weight");
                        Check(!target.List("protectedKeys").Contains(weight.Key), "Candidate changes a runtime-owned expression key");
                        renderer.SetBlendShapeWeight(index, value); Check(Math.Abs(renderer.GetBlendShapeWeight(index) - value) < .0001f, "Candidate weight was not applied");
                    }
                    bounds.Encapsulate(BoundsOf(instance, target,affected));
                }
                Check(bounds.size.sqrMagnitude > .000001f && float.IsFinite(bounds.size.sqrMagnitude), "Candidate model bounds unavailable");
                var center = bounds.center; var ortho = Mathf.Max(bounds.extents.x, bounds.extents.y, bounds.extents.z) * 1.2f; var distance = Mathf.Max(bounds.size.magnitude * 2, 1f);
                var cameraObject = new GameObject("Candidate preview camera"); SceneManager.MoveGameObjectToScene(cameraObject, scene); var camera = cameraObject.AddComponent<Camera>();
                camera.scene = scene; camera.orthographic = true; camera.orthographicSize = ortho; camera.aspect = 1; camera.enabled = false;
                camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.08f, .09f, .12f, 1); camera.nearClipPlane = .001f; camera.farClipPlane = distance * 4; camera.allowHDR = false; camera.allowMSAA = false;
                Lamp(scene, "Key", new Vector3(25,-30,0), 1); Lamp(scene, "Fill", new Vector3(15,150,0), .6f);
                RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat; RenderSettings.ambientLight = new Color(.35f,.35f,.35f); RenderSettings.fog = false;
                var directory = Safe("_harness/face/candidate-preview/" + collectionHash.Substring(0,20) + "-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Avh.Abs(directory));
                var images = new List<object>(); var frozenCandidates = new List<object>();
                foreach (var view in new[] { "front", "side" })
                {
                    camera.transform.position = center + (view == "front" ? Vector3.forward : Vector3.right) * distance; camera.transform.LookAt(center, Vector3.up);
                    foreach (var instance in instances) instance.SetActive(false); original.SetActive(true); images.Add(Image(camera,directory,"before",view));
                    for (var index=0;index<candidates.Length;index++)
                    {
                        foreach (var instance in instances) instance.SetActive(false); instances[index+1].SetActive(true);
                        var image = Image(camera,directory,"candidate-"+index,view); image["version"]="after"; image["candidateId"]=candidates[index].Str("id"); images.Add(image);
                    }
                }
                for (var index=0;index<candidates.Length;index++) frozenCandidates.Add(D("id",candidates[index].Str("id"),"revisionSha256",collectionHash,"imageIds",new object[]{"candidate-"+index+"-front","candidate-"+index+"-side"}));
                Check(FaceStage.FileHash(collectionPath)==collectionHash && FaceStage.FileHash(FaceStage.ObservationPath)==observedHash && Avh.Json(dependencies)==Avh.Json(Dependencies(source,source)),"Source or collection changed while rendering");
                foreach(var value in bindings.Values.Cast<Dictionary<string,object>>().Concat(references.Cast<Dictionary<string,object>>())) Check(SourceHash(value.Str("path"))==value.Str("sha256"),"Frozen candidate input changed while rendering");
                var protocol = D("camera","orthographic","pose","prefab-defaults","views",new object[]{"front","side"},"center",new object[]{center.x,center.y,center.z},"orthographicSize",ortho,"distance",distance,"background",new object[]{.08,.09,.12,1},"lighting","white-key-1-fill-0.6-ambient-0.35","rootPose","translation-and-rotation-normalised","focus","actual-affected-vertices","affectedVertexCount",affected.Length);
                Avh.WriteJson(Avh.Abs(Safe(manifestPath)),D("schema","face-candidate-preview/0.1","productionAccepted",false,"bindings",bindings,"dependencies",dependencies,"references",references,"protocol",protocol,"images",images,"candidates",frozenCandidates));
                Avh.Observation("face.candidates",D("face_candidates_valid",mathematicallyValidated,"face_candidate_preview_integrity",true,"face_visual_accepted",false,"candidateCount",candidates.Length),new List<string>{"Preview manifest SHA256: "+FaceStage.FileHash(manifestPath),"Actual source blendshape combinations rendered on temporary instances. Mathematical candidate validation is separate from rendering. No source mesh editing, FBX baking, selection or final appearance acceptance."});
            }
            finally { RenderSettings.ambientMode=lighting;RenderSettings.ambientLight=ambient;RenderSettings.fog=fog;foreach(var instance in instances) if(instance!=null) UnityEngine.Object.DestroyImmediate(instance);EditorSceneManager.ClosePreviewScene(scene); }
        }
        public static void WritePreview()
        {
            var record = Avh.ReadJsonFile(Avh.Abs(Safe(FaceStage.RecordPath))); var source = record.Str("sourcePrefab");
            var candidate = FaceStage.ValidatedOutput(source); Check(candidate == record.Str("avatar"), "Preview candidate does not match output binding");
            var outputHash = FaceStage.FileHash(FaceStage.RecordPath); var observation = Avh.ReadJsonFile(Avh.Abs(Safe(FaceStage.ObservationPath)));
            Dictionary<string, object> target = null;
            if (record.Str("mode") == "design") target = observation.List("targets").Cast<Dictionary<string, object>>().Single(t => t.Str("targetId") == record.Str("targetId"));
            var dependencies = Dependencies(source, candidate); var bindings = D("input", Identity(FaceStage.InputPath), "output", Identity(FaceStage.RecordPath), "observation", Identity(FaceStage.ObservationPath), "source", Identity(source), "candidate", Identity(candidate));
            var input=Avh.ReadJsonFile(Avh.Abs(Safe(FaceStage.InputPath)));var references=SourceAuthorityReferences(input,observation,record.Str("targetId"));
            var scene = EditorSceneManager.NewPreviewScene(); GameObject original = null, changed = null;
            var lighting = RenderSettings.ambientMode; var ambient = RenderSettings.ambientLight; var fog = RenderSettings.fog;
            try
            {
                original = Instance(source, scene); changed = Instance(candidate, scene);
                var affected=target!=null&&input.Obj("weightsUnityPercent")!=null ? AffectedVertices(original,target,new[]{D("weightsUnityPercent",input.Obj("weightsUnityPercent"))}) : null;
                var bounds = BoundsOf(original, target,affected); bounds.Encapsulate(BoundsOf(changed, target,affected));
                Check(bounds.size.sqrMagnitude > .000001f && float.IsFinite(bounds.size.sqrMagnitude), "Model bounds unavailable");
                var center = bounds.center; var ortho = Mathf.Max(bounds.extents.x, bounds.extents.y, bounds.extents.z) * 1.2f;
                var distance = Mathf.Max(bounds.size.magnitude * 2, 1f); var gameObject = new GameObject("Preview camera"); SceneManager.MoveGameObjectToScene(gameObject, scene);
                var camera = gameObject.AddComponent<Camera>(); camera.scene = scene; camera.orthographic = true; camera.orthographicSize = ortho; camera.aspect = 1;
                camera.clearFlags = CameraClearFlags.SolidColor; camera.backgroundColor = new Color(.08f, .09f, .12f, 1); camera.nearClipPlane = .001f; camera.farClipPlane = distance * 4;
                camera.allowHDR = false; camera.allowMSAA = false; camera.enabled = false;
                Lamp(scene, "Key", new Vector3(25, -30, 0), 1); Lamp(scene, "Fill", new Vector3(15, 150, 0), .6f);
                RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat; RenderSettings.ambientLight = new Color(.35f, .35f, .35f); RenderSettings.fog = false;
                var directory = Safe("_harness/face/preview/" + outputHash.Substring(0, 20) + "-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Avh.Abs(directory));
                var images = new List<object>();
                foreach (var view in new[] { "front", "side" })
                {
                    camera.transform.position = center + (view == "front" ? Vector3.forward : Vector3.right) * distance; camera.transform.LookAt(center, Vector3.up);
                    original.SetActive(true); changed.SetActive(false); images.Add(Image(camera, directory, "before", view));
                    original.SetActive(false); changed.SetActive(true); images.Add(Image(camera, directory, "after", view));
                }
                if(target!=null&&input.Str("route")=="native-fbx/1")
                {
                    var design=Avh.ReadJsonFile(Avh.Abs(input.Obj("blenderDesign").Str("file")));var recipe=design.Obj("recipe").Obj("compensation");
                    if(recipe.Str("method")=="regional-additive"&&recipe.List("regions").Count==2)
                    {
                        var before=TargetRenderer(original,target);var after=TargetRenderer(changed,target);var blink=recipe.Str("blinkKey");
                        var centers=recipe.List("regions").Cast<Dictionary<string,object>>().Select(r=>before.bones.Single(b=>b.name==r.Str("bone")).position).ToArray();
                        var eyeCenter=(centers[0]+centers[1])*.5f;camera.orthographicSize=(centers[0]-centers[1]).magnitude*.8f;
                        camera.transform.position=eyeCenter+Vector3.forward*distance;camera.transform.LookAt(eyeCenter,Vector3.up);
                        foreach(var item in new[]{("eyes-half",50f),("eyes-full",100f)})
                        {
                            foreach(var renderer in new[]{before,after}){for(var k=0;k<renderer.sharedMesh.blendShapeCount;k++)renderer.SetBlendShapeWeight(k,0);var index=renderer.sharedMesh.GetBlendShapeIndex(blink);Check(index>=0,"Observed blink missing from close-up");renderer.SetBlendShapeWeight(index,item.Item2);}
                            original.SetActive(true);changed.SetActive(false);images.Add(Image(camera,directory,"before",item.Item1));
                            original.SetActive(false);changed.SetActive(true);images.Add(Image(camera,directory,"after",item.Item1));
                        }
                        foreach(var version in new[]{"before","after"})Check(images.Cast<Dictionary<string,object>>().Single(i=>i.Str("id")==version+"-eyes-half").Str("poseSha256")!=images.Cast<Dictionary<string,object>>().Single(i=>i.Str("id")==version+"-eyes-full").Str("poseSha256"),"Eye close-ups reused an unchanged skinning pose");
                        camera.orthographicSize=ortho;
                    }
                }
                Dictionary<string,object> qualityReview=null;
                if(target!=null&&input.Str("route")=="native-fbx/1"){
                    var review=QualityReview(original,changed,target,input,camera,directory,distance);
                    if(review!=null){var path=Safe(directory+"/quality-review.json");Avh.WriteJson(Avh.Abs(path),review);qualityReview=Identity(path);}
                }
                // Rendering must not rewrite any source, candidate, material, design or observation file.
                Check(FaceStage.FileHash(FaceStage.RecordPath) == outputHash && Avh.Json(Dependencies(source, candidate)) == Avh.Json(dependencies), "Source or candidate changed while rendering");
                Check(Avh.Json(bindings) == Avh.Json(D("input", Identity(FaceStage.InputPath), "output", Identity(FaceStage.RecordPath), "observation", Identity(FaceStage.ObservationPath), "source", Identity(source), "candidate", Identity(candidate))), "Face inputs changed while rendering");
                foreach(var value in references.Cast<Dictionary<string,object>>())Check(SourceHash(value.Str("path"))==value.Str("sha256"),"Actual source authority changed during final preview");
                var protocol = D("camera", "orthographic", "pose", "prefab-defaults", "views", new object[] { "front", "side" }, "center", new object[] { center.x, center.y, center.z }, "orthographicSize", ortho,
                    "distance", distance, "background", new object[] { .08, .09, .12, 1 }, "lighting", "white-key-1-fill-0.6-ambient-0.35", "rootPose", "translation-and-rotation-normalised", "focus", target == null ? "visible-model-bounds" : "observed-target-bounds");
                var manifest=D("schema", "face-preview/0.1", "productionAccepted", false, "bindings", bindings, "dependencies", dependencies,"references",references, "protocol", protocol, "images", images);
                if(qualityReview!=null)manifest["qualityReview"]=qualityReview;
                Avh.WriteJson(Avh.Abs(Safe(Manifest)),manifest);
                Avh.Observation("face.preview", D("face_preview_rendered", true, "face_visual_accepted", false), new List<string> { "Preview manifest SHA256: "+FaceStage.FileHash(Manifest),"Real loaded source and candidate rendered with the same camera, lighting, pose and background. A preview is not aesthetic acceptance." });
            }
            finally
            {
                RenderSettings.ambientMode = lighting; RenderSettings.ambientLight = ambient; RenderSettings.fog = fog;
                if (original != null) UnityEngine.Object.DestroyImmediate(original); if (changed != null) UnityEngine.Object.DestroyImmediate(changed); EditorSceneManager.ClosePreviewScene(scene);
            }
        }
    }
}
