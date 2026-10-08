// 【项目沉淀】通用工具（Harness 的构建期回读）
// 适用素体：无关
// 工具链　：Unity 2022.3；NDMF（Modular Avatar 等插件在这里展开）；VRChat SDK3 Avatars
// 可复用性：★★★ 换个单子直接能用
// 用途　　：编辑期看不到构建期才生成的菜单与参数（SOP 60：实测 24/108 → 92/177），所以菜单、参数、层权重一律在
//           NDMF 处理过的克隆上数：克隆 → 完全解包 → AvatarProcessor.ProcessAvatar → 读描述符 → 销毁克隆并清 NDMF 临时资产。
//           menu.dump 的指标都在这里算，菜单、两次构建阶段共用。
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using nadena.dev.modular_avatar.core;
using nadena.dev.ndmf;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;
using VRC.SDKBase;
using VRC.SDK3.Dynamics.Constraint.Components;

namespace AVH.Harness
{
    /// <summary>Read immutable source declarations in an avatar context. Names alone never imply a sync edge.</summary>
    public sealed class SourceShapeAudit
    {
        sealed class Key { public string path, name; public float initial; }
        sealed class Sync { public Key source, target; public AnimationCurve remap; }
        sealed class Change { public string host; public HashSet<string> sourceAncestors; public Key target; public float value, threshold; public bool inverted, delete, menuControlled; public int constant; public bool[] mask; public Func<Dictionary<string,float>,bool> active, rawActive; }
        sealed class Geometry { public string path; public Vector3[] vertices; public int[][] indices; public MeshTopology[] topology; public List<Change> changes = new List<Change>(); public Dictionary<string, (int failures, int unknown)> measurements = new Dictionary<string, (int, int)>(); }
        readonly List<Key> keys = new List<Key>();
        readonly List<Sync> syncs = new List<Sync>();
        readonly List<Change> changes = new List<Change>();
        readonly List<Geometry> geometry = new List<Geometry>();
        readonly Dictionary<Key,List<Change>> scalarRules = new Dictionary<Key,List<Change>>();
        readonly Dictionary<string, Key> index = new Dictionary<string, Key>();
        readonly HashSet<string> unsupportedWriters = new HashSet<string>();
        int unresolved;
        readonly Dictionary<string,float> defaults;
        sealed class SourceMesh
        {
            public Vector3[] vertices;
            public int[][] indices;
            public MeshTopology[] topology;
            public string[] names;
            public Dictionary<string,List<Vector3[]>> deletionFrames = new Dictionary<string,List<Vector3[]>>();
        }
        sealed class SourceRenderer { public SourceMesh mesh; public float[] weights; }
        sealed class SourcePrefab
        {
            public string hash;
            public Dictionary<string,SourceRenderer> renderers = new Dictionary<string,SourceRenderer>();
            public List<EditorCurveBinding> writers = new List<EditorCurveBinding>();
        }
        static readonly Dictionary<string,SourcePrefab> baselines = new Dictionary<string,SourcePrefab>();
        // This must run before a build can mutate shared source assets. The baseline contains no Unity objects.
        public static void CaptureSources(Dictionary<string,object> plan, Dictionary<string,object> record)
        {
            if(!AvatarConfig.Grouped(plan))return;
            var paths=record.List("outfits").Cast<Dictionary<string,object>>().Select(r=>r.Str("prefab")).Append(plan.Str("body_prefab")).Where(p=>p!=null).Distinct().ToList();
            var sources=paths.ToDictionary(p=>p,p=>AssetDatabase.LoadAssetAtPath<GameObject>(p));
            SourceMenuAudit.CaptureSources(sources);
            var deleted=new HashSet<string>(sources.Values.Where(s=>s!=null).SelectMany(s=>s.GetComponentsInChildren<ModularAvatarShapeChanger>(true))
                .SelectMany(c=>c.Shapes).Where(s=>s.ChangeType==ShapeChangeType.Delete).Select(s=>s.ShapeName));
            var meshes=new Dictionary<Mesh,SourceMesh>();
            foreach(var path in paths)
            {
                var hash=AssetDatabase.AssetPathToGUID(path)+":"+AssetDatabase.GetAssetDependencyHash(path);
                if(baselines.TryGetValue(path,out var existing)&&existing.hash==hash)continue;
                var source=sources[path];if(source==null)continue;
                var baseline=new SourcePrefab {hash=hash};
                foreach(var controller in source.GetComponent<VRCAvatarDescriptor>()==null?Enumerable.Empty<AnimatorController>():AvatarAudit.Layers(source.GetComponent<VRCAvatarDescriptor>()).Select(x=>x.controller).Distinct())
                    baseline.writers.AddRange(controller.animationClips.SelectMany(AnimationUtility.GetCurveBindings));
                foreach(var merge in source.GetComponentsInChildren<ModularAvatarMergeAnimator>(true).Where(m=>m.animator!=null))
                {
                    var root=merge.relativePathRoot?.Get(merge)?.transform??merge.transform;
                    var prefix=AnimationUtility.CalculateTransformPath(root,source.transform);
                    foreach(var binding in merge.animator.animationClips.SelectMany(AnimationUtility.GetCurveBindings))
                    {var copy=binding;copy.path=merge.pathMode==MergeAnimatorPathMode.Absolute?"/"+binding.path:prefix+(prefix.Length==0||binding.path.Length==0?"":"/")+binding.path;baseline.writers.Add(copy);}
                }
                foreach(var renderer in source.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(r=>r.sharedMesh!=null))
                {
                    var mesh=renderer.sharedMesh;
                    if(!meshes.TryGetValue(mesh,out var snapshot))
                    {
                        snapshot=new SourceMesh {vertices=mesh.vertices,indices=Enumerable.Range(0,mesh.subMeshCount).Select(sm=>mesh.GetIndices(sm)).ToArray(),
                            topology=Enumerable.Range(0,mesh.subMeshCount).Select(mesh.GetTopology).ToArray(),names=Enumerable.Range(0,mesh.blendShapeCount).Select(mesh.GetBlendShapeName).ToArray()};
                        foreach(var name in deleted.Where(n=>Array.IndexOf(snapshot.names,n)>=0))
                        {
                            var frames=new List<Vector3[]>();var shape=mesh.GetBlendShapeIndex(name);
                            for(var f=0;f<mesh.GetBlendShapeFrameCount(shape);f++){var delta=new Vector3[mesh.vertexCount];mesh.GetBlendShapeFrameVertices(shape,f,delta,null,null);frames.Add(delta);}
                            snapshot.deletionFrames[name]=frames;
                        }
                        meshes[mesh]=snapshot;
                    }
                    baseline.renderers[AnimationUtility.CalculateTransformPath(renderer.transform,source.transform)]=new SourceRenderer {mesh=snapshot,
                        weights=Enumerable.Range(0,mesh.blendShapeCount).Select(renderer.GetBlendShapeWeight).ToArray()};
                }
                baselines[path]=baseline;
            }
        }
        sealed class Cached { public string stamp; public SourceShapeAudit audit; }
        static readonly ConditionalWeakTable<GameObject, Cached> cache = new ConditionalWeakTable<GameObject, Cached>();
        public static SourceShapeAudit For(GameObject avatar, Dictionary<string, object> plan, Dictionary<string, object> record)
        {
            var stamp=Hash128.Compute(Avh.Json(plan)+Avh.Json(record)).ToString();var entry=cache.GetValue(avatar,_=>new Cached());
            if(entry.stamp!=stamp) {entry.audit=new SourceShapeAudit(avatar,plan,record);entry.stamp=stamp;}return entry.audit;
        }
        static string Id(string path, string name) => path + "\n" + name;
        SourceShapeAudit(GameObject avatar, Dictionary<string, object> plan, Dictionary<string, object> record)
        {
            defaults = AvatarConfig.Defaults(plan);
            var body = AssetDatabase.LoadAssetAtPath<GameObject>(plan.Str("body_prefab"));
            if (body == null) { unresolved++; return; }
            var context = (GameObject)PrefabUtility.InstantiatePrefab(body);
            context.SetActive(false);
            var rows = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
            var paths = new Dictionary<Transform, string>();
            var originals = new Dictionary<SkinnedMeshRenderer, SourceRenderer>();
            var owners = new Dictionary<Transform,List<Dictionary<string,object>>>();
            var authoredWriters = new List<(EditorCurveBinding binding,string sourcePath)>();
            var shapeHosts = new List<Transform>();
            var sourceDefaults = (body.GetComponent<VRCAvatarDescriptor>()?.expressionParameters?.parameters ?? new VRCExpressionParameters.Parameter[0])
                .GroupBy(p=>p.name).ToDictionary(g=>g.Key,g=>g.First().defaultValue);
            bool MenuCondition(Transform host, out string parameter, out float target, out bool selected)
            {
                ModularAvatarMenuItem item=null;
                for(var t=host;t!=null&&t!=context.transform;t=t.parent){item=t.GetComponent<ModularAvatarMenuItem>();if(item!=null)break;}
                var control=item?.Control;
                parameter=control?.parameter?.name;target=control?.value??0;selected=true;
                if(control==null||string.IsNullOrWhiteSpace(parameter)&&control.type!=VRCExpressionsMenu.Control.ControlType.Toggle&&control.type!=VRCExpressionsMenu.Control.ControlType.Button)return false;
                if(item.automaticValue)
                {
                    // Shared automatic allocation needs the allocator's full namespace/rename graph.
                    // Never certify it using a guessed value; single-item allocation is unambiguous.
                    var name=parameter;
                    var same=context.GetComponentsInChildren<ModularAvatarMenuItem>(true).Count(i=>!string.IsNullOrWhiteSpace(name)&&i.Control?.parameter?.name==name);
                    if(same>1){unresolved++;return false;}
                    target=1;
                    if(!string.IsNullOrWhiteSpace(name)&&sourceDefaults.TryGetValue(name,out var declaredDefault))
                    {
                        if(item.isDefault&&Math.Abs(declaredDefault)>.00001f)target=(int)declaredDefault;
                        else if(!item.isDefault&&(body.GetComponent<VRCAvatarDescriptor>()?.expressionParameters?.parameters??new VRCExpressionParameters.Parameter[0])
                            .Any(p=>p.name==name&&p.valueType==VRCExpressionParameters.ValueType.Int)&&(int)declaredDefault==1)target=2;
                    }
                }
                selected=!string.IsNullOrWhiteSpace(parameter)&&sourceDefaults.TryGetValue(parameter,out var initial)
                    ?Math.Abs(initial-target)<.005f:item.isDefault;
                return true;
            }
            Func<Dictionary<string,float>,bool> Predicate(Transform host, bool includeMenu=true)
            {
                var owner = host.GetComponentsInParent<Transform>(true).FirstOrDefault(t=>owners.ContainsKey(t));
                // Unity's destroyed-object equality must never alter an immutable source predicate.
                var hasOwner = owner != null;
                var ownerRows = owner == null ? new List<Dictionary<string,object>>() : owners[owner];
                var chain = new List<(bool initial, List<string> switches)>();
                for(var t=host;t!=null&&t!=context.transform;t=t.parent)
                {
                    if(t==owner) continue;
                    var parameters = new List<string>();
                    if(owner!=null)
                    {
                        var relative=AnimationUtility.CalculateTransformPath(t,owner);
                        foreach(var s in AvatarConfig.Switches(plan)) foreach(Dictionary<string,object> target in s.List("targets"))
                        {
                            if(!ownerRows.Any(r=>r.Str("instance")==target.Str("instance")))continue;
                            var instance=plan.Obj("avatar_config").List("instances").Cast<Dictionary<string,object>>().Single(i=>i.Str("id")==target.Str("instance"));
                            var component=instance.List("components").Cast<Dictionary<string,object>>().Single(c=>c.Str("id")==target.Str("component"));
                            if(component.List("objects").Any(p=>p.ToString()==relative)) parameters.Add(s.Obj("parameter").Str("name"));
                        }
                    }
                    chain.Add((t.gameObject.activeSelf&&!t.CompareTag("EditorOnly"),parameters));
                }
                var hasMenu=MenuCondition(host,out var menuParameter,out var menuValue,out var menuDefault);
                return values => (!includeMenu || !hasMenu || (!string.IsNullOrWhiteSpace(menuParameter)&&values.TryGetValue(menuParameter,out var selection)?Math.Abs(selection-menuValue)<.005f:menuDefault))
                    && (!hasOwner || ownerRows.Any(r=>AvatarConfig.Groups(plan).Any(g=>g.List("members").Cast<Dictionary<string,object>>()
                    .Any(m=>m.Str("id")==r.Str("id")&&AvatarConfig.Selected(g,m,values)))))
                    && chain.All(c=>c.switches.Count==0?c.initial:c.switches.All(p=>values.TryGetValue(p,out var value)?value!=0:defaults.TryGetValue(p,out var initial)&&initial!=0));
            }
            string Resolve(string path)
            {
                var actual = AvatarAudit.Locate(avatar.transform, path);
                if (actual != null) return AnimationUtility.CalculateTransformPath(actual, avatar.transform);
                var candidates = rows.Select(r => r.Obj("built_paths")?.Str(path)).Where(p => p != null).Distinct().ToList();
                actual = candidates.Count == 1 ? AvatarAudit.Locate(avatar.transform, candidates[0]) : null;
                return actual != null ? AnimationUtility.CalculateTransformPath(actual, avatar.transform) : path;
            }
            void Map(GameObject source, GameObject instance, string prefix)
            {
                var sourcePath=AssetDatabase.GetAssetPath(source);
                if(!baselines.TryGetValue(sourcePath,out var baseline)||baseline.hash!=AssetDatabase.AssetPathToGUID(sourcePath)+":"+AssetDatabase.GetAssetDependencyHash(sourcePath))
                {unresolved++;return;}
                foreach(var binding in baseline.writers)
                {var copy=binding;var sourceBindingPath=binding.path.StartsWith("/")?binding.path.Substring(1):prefix+(prefix.Length==0||binding.path.Length==0?"":"/")+binding.path;copy.path=Resolve(sourceBindingPath);authoredWriters.Add((copy,sourceBindingPath));}
                foreach (var t in instance.GetComponentsInChildren<Transform>(true))
                {
                    var relative = AnimationUtility.CalculateTransformPath(t, instance.transform);
                    paths[t] = Resolve(prefix + (prefix.Length == 0 || relative.Length == 0 ? "" : "/") + relative);
                    var renderer = t.GetComponent<SkinnedMeshRenderer>();
                    if (renderer != null && baseline.renderers.TryGetValue(relative,out var original)) originals[renderer] = original;
                }
            }
            Key Get(SkinnedMeshRenderer renderer, string name, bool required = true)
            {
                if (renderer == null || !paths.TryGetValue(renderer.transform, out var path) || !originals.TryGetValue(renderer, out var original)
                    || string.IsNullOrWhiteSpace(name) || Array.IndexOf(original.mesh.names,name) < 0)
                { if (required) unresolved++; return null; }
                var id = Id(path, name);
                if (!index.TryGetValue(id, out var key))
                {
                    key = new Key { path = path, name = name, initial = original.weights[Array.IndexOf(original.mesh.names,name)] };
                    index[id] = key; keys.Add(key);
                }
                return key;
            }
            try
            {
                Map(body, context, "");
                foreach (var row in rows.GroupBy(r => r.Str("object")).Select(g => g.First()))
                {
                    var source = AssetDatabase.LoadAssetAtPath<GameObject>(row.Str("prefab"));
                    if (source == null) { unresolved++; continue; }
                    var instance = (GameObject)PrefabUtility.InstantiatePrefab(source);
                    var segments = row.Str("object").Split('/'); var parent = context.transform;
                    foreach (var segment in segments.Take(segments.Length - 1))
                    { var child = parent.Find(segment); if (child == null) { child = new GameObject(segment).transform; child.SetParent(parent,false); } parent = child; }
                    instance.name = segments.Last(); instance.transform.SetParent(parent, false);
                    Map(source, instance, row.Str("object"));
                    owners[instance.transform] = rows.Where(r=>r.Str("object")==row.Str("object")).ToList();
                    foreach (var r in instance.GetComponentsInChildren<SkinnedMeshRenderer>(true))
                        if (originals.TryGetValue(r, out var original)) foreach(var name in original.mesh.names) Get(r,name);
                }
                foreach (var component in context.GetComponentsInChildren<ModularAvatarBlendshapeSync>(true))
                    foreach (var binding in component.Bindings)
                    {
                        var source = Get(binding.ReferenceMesh?.Get(component)?.GetComponent<SkinnedMeshRenderer>(), binding.Blendshape);
                        var target = Get(component.GetComponent<SkinnedMeshRenderer>(), string.IsNullOrWhiteSpace(binding.LocalBlendshape) ? binding.Blendshape : binding.LocalBlendshape);
                        if (source != null && target != null) syncs.Add(new Sync { source = source, target = target, remap = binding.RemapCurveIsValid ? binding.RemapCurve : null });
                    }
                foreach (var component in context.GetComponentsInChildren<ModularAvatarShapeChanger>(true))
                    foreach (var shape in component.Shapes)
                    {
                        var renderer = shape.Object?.Get(component)?.GetComponent<SkinnedMeshRenderer>();
                        var target = Get(renderer, shape.ShapeName);
                        if (target == null || !paths.TryGetValue(component.transform, out var host)) { unresolved++; continue; }
                        var ancestors=new HashSet<string>();for(var t=component.transform;t!=null&&t!=context.transform;t=t.parent)ancestors.Add(AnimationUtility.CalculateTransformPath(t,context.transform));
                        shapeHosts.Add(component.transform);
                        var change = new Change { host = host, sourceAncestors=ancestors, target = target, value = shape.Value, threshold = component.Threshold, inverted = component.Inverted, delete = shape.ChangeType == ShapeChangeType.Delete,
                            menuControlled = MenuCondition(component.transform,out _,out _,out _), active = Predicate(component.transform), rawActive=Predicate(component.transform,false) };
                        changes.Add(change);
                        if (!change.delete) continue;
                        var mesh = originals[renderer].mesh; var mask = new bool[mesh.vertices.Length];
                        if(!mesh.deletionFrames.TryGetValue(shape.ShapeName,out var frames)){unresolved++;continue;}
                        foreach(var delta in frames) for (var v = 0; v < delta.Length; v++) mask[v] |= delta[v].sqrMagnitude > change.threshold * change.threshold;
                        change.mask = mask;
                        var group = geometry.SingleOrDefault(g => g.path == target.path);
                        if (group == null) { group = new Geometry { path = target.path, vertices=mesh.vertices,
                            indices=mesh.indices, topology=mesh.topology }; geometry.Add(group); }
                        group.changes.Add(change);
                    }
                foreach(var writer in authoredWriters)
                {
                    var binding=writer.binding;
                    if(binding.type==typeof(SkinnedMeshRenderer)&&binding.propertyName.StartsWith("blendShape.")&&index.ContainsKey(Id(binding.path,binding.propertyName.Substring(11))))unresolved++;
                    if(binding.type==typeof(GameObject)&&binding.propertyName=="m_IsActive"&&changes.Any(c=>c.sourceAncestors.Contains(writer.sourcePath)))
                    {
                        var modeled=owners.Keys.Any(t=>AnimationUtility.CalculateTransformPath(t,context.transform)==writer.sourcePath)||AvatarConfig.Switches(plan).Any(s=>s.List("targets").Cast<Dictionary<string,object>>().Any(target=>
                            rows.Where(r=>r.Str("instance")==target.Str("instance")).Any(row=>plan.Obj("avatar_config").List("instances").Cast<Dictionary<string,object>>().Single(i=>i.Str("id")==target.Str("instance"))
                                .List("components").Cast<Dictionary<string,object>>().Single(c=>c.Str("id")==target.Str("component")).List("objects").Any(p=>row.Str("object")+"/"+p==writer.sourcePath))));
                        if(!modeled)unresolved++;
                    }
                }
                foreach(var toggle in context.GetComponentsInChildren<ModularAvatarObjectToggle>(true))foreach(var target in toggle.Objects)
                {var controlled=target.Object?.Get(toggle)?.transform;if(controlled!=null&&controlled!=context.transform&&shapeHosts.Any(h=>h==controlled||h.IsChildOf(controlled)))unresolved++;}
                // Classify the immutable predicates across their entire configured domain. A dynamic rule
                // that is temporarily off survives MA pruning; a permanently off rule does not.
                var domain = MenuGroupAudit.Cells(plan);
                foreach (var change in changes)
                {
                    var states = domain.Select(v => change.active(v) ^ change.inverted).Distinct().ToList();
                    change.constant = !domain.Any(change.rawActive) ? (change.inverted ? 1 : 0)
                        : !change.menuControlled && states.Count == 1 ? (states[0] ? 1 : 0) : -1;
                }
                foreach (var group in geometry)
                {
                    var retained = new List<Change>();
                    foreach (var sameKey in changes.Where(c => c.target.path == group.path).GroupBy(c => c.target.name))
                    {
                        var rules = sameKey.Where(c => c.constant != 0).ToList();
                        var lastAlwaysOn = rules.FindLastIndex(c => c.constant == 1);
                        if (lastAlwaysOn > 0) rules = rules.Skip(lastAlwaysOn).ToList();
                        var filters = rules.Where(c => c.delete).ToList();
                        if (filters.Count > 0)
                        {
                            var combined = new bool[filters[0].mask.Length];
                            foreach (var filter in filters) for (var v = 0; v < combined.Length; v++) combined[v] |= filter.mask[v];
                            foreach (var filter in filters) filter.mask = combined;
                        }
                        retained.AddRange(rules);
                    }
                    group.changes = retained;
                }
                foreach(var change in changes.Where(c=>!c.delete&&c.constant!=0))
                {
                    var pending=new Queue<Key>();var visited=new HashSet<Key>();pending.Enqueue(change.target);
                    while(pending.Count>0)
                    {
                        var key=pending.Dequeue();if(!visited.Add(key))continue;
                        if(!scalarRules.TryGetValue(key,out var rules))scalarRules[key]=rules=new List<Change>();rules.Add(change);
                        foreach(var sync in syncs.Where(s=>s.source==key))pending.Enqueue(sync.target);
                    }
                }
                foreach(var key in scalarRules.Keys.ToList())
                {var rules=scalarRules[key];var lastAlwaysOn=rules.FindLastIndex(c=>c.constant==1);if(lastAlwaysOn>0)scalarRules[key]=rules.Skip(lastAlwaysOn).ToList();}
                foreach (var controller in AvatarAudit.Layers(avatar.GetComponent<VRCAvatarDescriptor>()).Select(x => x.controller).Distinct())
                    foreach (var binding in controller.animationClips.SelectMany(AnimationUtility.GetCurveBindings))
                        if (binding.type == typeof(SkinnedMeshRenderer) && binding.propertyName.StartsWith("blendShape."))
                        {
                            var id = Id(binding.path, binding.propertyName.Substring(11));
                            if (index.ContainsKey(id) && !changes.Any(c => Id(c.target.path, c.target.name) == id) && !syncs.Any(s => Id(s.target.path, s.target.name) == id)) unsupportedWriters.Add(id);
                        }
            }
            finally { UnityEngine.Object.DestroyImmediate(context); }
        }
        static float Remap(AnimationCurve curve, float value)
        {
            if (curve == null || curve.length < 2) return value;
            var keys = curve.keys; var i = 0;
            while (i < keys.Length - 2 && value > keys[i + 1].time) i++;
            return keys[i].value + (value - keys[i].time) * (keys[i + 1].value - keys[i].value) / (keys[i + 1].time - keys[i].time);
        }
        static string Vertex(Vector3 p) => p.x.ToString("R", System.Globalization.CultureInfo.InvariantCulture) + "," + p.y.ToString("R", System.Globalization.CultureInfo.InvariantCulture) + "," + p.z.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
        static string Triangle(int submesh, Vector3 a, Vector3 b, Vector3 c) => submesh + ":" + string.Join(";", new[] { Vertex(a), Vertex(b), Vertex(c) }.OrderBy(x => x, StringComparer.Ordinal));
        static string MeshFingerprint(Mesh mesh, Transform[] bones)
        {
            using(var stream=new System.IO.MemoryStream()) using(var writer=new System.IO.BinaryWriter(stream))
            {
                writer.Write(mesh.vertexCount);writer.Write(mesh.subMeshCount);writer.Write(bones.Length);
                foreach(var p in mesh.vertices) {writer.Write(p.x);writer.Write(p.y);writer.Write(p.z);}
                for(var sm=0;sm<mesh.subMeshCount;sm++) {var indices=mesh.GetIndices(sm);writer.Write((int)mesh.GetTopology(sm));writer.Write(indices.Length);foreach(var index in indices)writer.Write(index);}
                using(var counts=mesh.GetBonesPerVertex()) {writer.Write(counts.Length);foreach(var count in counts)writer.Write(count);}
                using(var weights=mesh.GetAllBoneWeights()) {writer.Write(weights.Length);foreach(var weight in weights) {writer.Write(weight.boneIndex);writer.Write(weight.weight);}}
                foreach(var bone in bones)writer.Write(bone==null?0:bone.GetInstanceID());writer.Flush();
                using(var hash=System.Security.Cryptography.SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream.ToArray()));
            }
        }
        public (int failures, int unknown, int pairs, float delta) Check(GameObject avatar, Func<string, bool> visible, Func<string, string, float?> weight, Func<Transform, Vector3> scale, List<string> notes, Dictionary<string,float> values=null, bool animated=true)
        {
            values = values ?? defaults;
            unsupportedWriters.Clear();
            foreach(var controller in AvatarAudit.Layers(avatar.GetComponent<VRCAvatarDescriptor>()).Select(x=>x.controller).Distinct())
                foreach(var binding in controller.animationClips.SelectMany(AnimationUtility.GetCurveBindings))
                    if(binding.type==typeof(SkinnedMeshRenderer)&&binding.propertyName.StartsWith("blendShape."))
                    { var id=Id(binding.path,binding.propertyName.Substring(11));if(index.ContainsKey(id)&&!changes.Any(c=>Id(c.target.path,c.target.name)==id)&&!syncs.Any(s=>Id(s.target.path,s.target.name)==id))unsupportedWriters.Add(id); }
            var failures = 0; var unknown = unresolved + unsupportedWriters.Count; var pairs = 0; var max = 0f;
            Dictionary<string,float> Initial(bool applySourceInitialSets)
            {
                var seed=keys.ToDictionary(k=>k,k=>k.initial);
                if(applySourceInitialSets)foreach(var entry in scalarRules)
                {var active=entry.Value.LastOrDefault(c=>c.active(defaults)^c.inverted);if(active!=null)seed[entry.Key]=active.value;}
                var result=new Dictionary<string,float>();
                float Resolve(Key key,HashSet<Key> visiting)
                {
                    var id=Id(key.path,key.name);if(result.TryGetValue(id,out var value))return value;
                    if(!visiting.Add(key)){unknown++;return seed[key];}
                    var incoming=syncs.Where(s=>s.target==key).ToList();if(incoming.Count>1)unknown++;
                    value=incoming.Count==1?Remap(incoming[0].remap,Resolve(incoming[0].source,visiting)):seed[key];
                    visiting.Remove(key);result[id]=value;return value;
                }
                foreach(var key in keys)Resolve(key,new HashSet<Key>());return result;
            }
            var original=Initial(false);var serialized=Initial(true);var expected=animated?original:serialized;
            if(animated)foreach(var entry in scalarRules)
            {
                var id=Id(entry.Key.path,entry.Key.name);
                // Constant reactions without animated writers are applied before BlendshapeSync's initial
                // remap. Dynamic reaction clips instead forward raw Set values at runtime.
                if(entry.Value.Last().constant==1){expected[id]=serialized[id];continue;}
                var active=entry.Value.LastOrDefault(c=>c.active(values)^c.inverted);if(active!=null)expected[id]=active.value;
            }
            foreach (var key in keys)
            {
                var id = Id(key.path, key.name); if (unsupportedWriters.Contains(id)) continue;
                var actual = weight(key.path, key.name);
                if (!actual.HasValue) { unknown++; continue; }
                pairs++; var delta = Math.Abs(actual.Value - expected[id]); max = Math.Max(max, delta);
                if (float.IsNaN(delta) || delta > .001f) { failures++; if (notes.Count < 40) notes.Add("来源形态状态不符：" + key.path + "." + key.name + " actual=" + actual + " expected=" + expected[id]); }
            }
            foreach (var group in geometry)
            {
                var renderer = AvatarAudit.Locate(avatar.transform, group.path)?.GetComponent<SkinnedMeshRenderer>(); var mesh = renderer?.sharedMesh;
                if (mesh == null || mesh.subMeshCount != group.indices.Length) { unknown++; continue; }
                // Include actual content: an in-place vertex/index/weight edit must invalidate a prior pass.
                var boneVector = renderer.bones.Select(b => {
                    for (var t = b; t != null; t = t.parent) { var s = scale(t); if (float.IsNaN(s.x) || float.IsNaN(s.y) || float.IsNaN(s.z)) return "1"; }
                    return b == null ? "?" : "0"; }).ToArray();
                var signature = MeshFingerprint(mesh,renderer.bones)
                    + ":" + string.Join("", changes.Select(c => (c.active(values) ^ c.inverted) ? "1" : "0")) + ":" + string.Join("",boneVector);
                if (group.measurements.TryGetValue(signature, out var prior)) { failures += prior.failures; unknown += prior.unknown; continue; }
                var wanted = new Dictionary<string, int>(); var observed = new Dictionary<string, int>(); var vertices = group.vertices;
                var effective = group.changes.Where(c=>c.active(values)^c.inverted).GroupBy(c=>c.target.name).Select(g=>g.Last()).Where(c=>c.delete).ToList();
                void Add(Dictionary<string, int> counts, string id) { counts.TryGetValue(id, out var n); counts[id] = n + 1; }
                var complete = true;
                for (var sm = 0; sm < group.indices.Length; sm++)
                {
                    if (group.topology[sm] != MeshTopology.Triangles || mesh.GetTopology(sm) != MeshTopology.Triangles) { complete = false; break; }
                    var triangles = group.indices[sm];
                    for (var i = 0; i < triangles.Length; i += 3)
                    {
                        var deleted = effective.Any(c => c.mask[triangles[i]] || c.mask[triangles[i + 1]] || c.mask[triangles[i + 2]]);
                        if (!deleted) Add(wanted, Triangle(sm, vertices[triangles[i]], vertices[triangles[i + 1]], vertices[triangles[i + 2]]));
                    }
                }
                var actualVertices = mesh.vertices; var hidden = new bool[mesh.vertexCount]; var bones = renderer.bones;
                using (var counts = mesh.GetBonesPerVertex()) using (var weights = mesh.GetAllBoneWeights())
                {
                    var offset = 0;
                    for (var v = 0; v < counts.Length; v++) for (var j = 0; j < counts[v]; j++)
                    {
                        var boneWeight = weights[offset++]; if (boneWeight.weight <= 0) continue;
                        if (boneWeight.boneIndex >= bones.Length || bones[boneWeight.boneIndex] == null) { complete = false; continue; }
                        for (var bone = bones[boneWeight.boneIndex]; bone != null; bone = bone.parent)
                        { var s = scale(bone); if (float.IsNaN(s.x) || float.IsNaN(s.y) || float.IsNaN(s.z)) hidden[v] = true; }
                    }
                }
                for (var sm = 0; sm < mesh.subMeshCount; sm++)
                {
                    var triangles = mesh.GetIndices(sm);
                    for (var i = 0; i < triangles.Length; i += 3)
                        if (!hidden[triangles[i]] && !hidden[triangles[i + 1]] && !hidden[triangles[i + 2]]) Add(observed, Triangle(sm, actualVertices[triangles[i]], actualVertices[triangles[i + 1]], actualVertices[triangles[i + 2]]));
                }
                if (!complete) { unknown++; group.measurements[signature] = (0,1); continue; }
                if (wanted.Count != observed.Count || wanted.Any(p => !observed.TryGetValue(p.Key, out var n) || n != p.Value))
                { failures++; group.measurements[signature] = (1,0); if (notes.Count < 40) notes.Add("来源 Delete primitive 集合不符：" + group.path
                    + " expected=" + wanted.Values.Sum() + " actual=" + observed.Values.Sum() + " missing=" + string.Join(" | ",wanted.Keys.Where(k => !observed.ContainsKey(k)).Take(1))
                    + " extra=" + string.Join(" | ",observed.Keys.Where(k => !wanted.ContainsKey(k)).Take(1))); }
                else group.measurements[signature] = (0,0);
            }
            if (unknown > 0 && notes.Count < 40) notes.Add("形态来源/映射/写者尚未完整读回：" + unknown);
            return (failures, unknown, pairs, max);
        }
        public static float? ReadWeight(GameObject avatar, string path, string name)
        { var r = AvatarAudit.Locate(avatar.transform, path)?.GetComponent<SkinnedMeshRenderer>(); var index = r?.sharedMesh?.GetBlendShapeIndex(name) ?? -1; return index >= 0 ? (float?)r.GetBlendShapeWeight(index) : null; }
        public bool ObservesBinding(GameObject avatar, EditorCurveBinding binding)
        {
            if(binding.type==typeof(SkinnedMeshRenderer)&&binding.propertyName.StartsWith("blendShape."))
                return index.ContainsKey(Id(binding.path,binding.propertyName.Substring(11)));
            if(!(binding.type==typeof(Transform)&&binding.propertyName.StartsWith("m_LocalScale.")
                ||binding.type==typeof(VRCScaleConstraint)&&binding.propertyName=="IsActive"))return false;
            return geometry.Any(g=>{
                var renderer=AvatarAudit.Locate(avatar.transform,g.path)?.GetComponent<SkinnedMeshRenderer>();
                return renderer!=null&&renderer.bones.Any(b=>{
                    for(var t=b;t!=null;t=t.parent)if(AnimationUtility.CalculateTransformPath(t,avatar.transform)==binding.path)return true;
                    return false;
                });
            });
        }
        public static Vector3 EffectiveScale(Transform transform, Vector3 scale, Func<VRCScaleConstraint,bool> active)
        {
            foreach (var constraint in transform.GetComponents<VRCScaleConstraint>())
                if (active(constraint) && constraint.GlobalWeight == 1 && constraint.Locked && constraint.Sources.Count == 1
                    && constraint.Sources[0].SourceTransform == transform && float.IsNaN(constraint.Sources[0].Weight))
                    return new Vector3(float.NaN,float.NaN,float.NaN);
            return scale;
        }
        public static Vector3 ReadScale(Transform transform) => EffectiveScale(transform,transform.localScale,c=>c.IsActive);
    }
    /// <summary>Frozen author menu declarations plus the approved tree, independently of generated menu records.</summary>
    public static class SourceMenuAudit
    {
        sealed class Node { public string asset; public List<Control> controls=new List<Control>(); }
        sealed class Control { public string name,parameter,origin; public string[] subParameters; public int type; public float value; public bool automatic,automaticParameter,isDefault,unknownMapping,allocationKnown; public Node child; }
        sealed class Declaration { public string name; public int type; public float value; public bool hasDefault; }
        sealed class Installer { public string target,origin; public Node contents; }
        sealed class Source { public string hash; public Node root; public List<Installer> installers=new List<Installer>(); public List<Control> items=new List<Control>(); public List<Declaration> parameters=new List<Declaration>(); public List<ParameterConfig> remappings=new List<ParameterConfig>(); public int unknown; public List<string> reasons=new List<string>(); }
        sealed class Entry { public string[] path; public Control control; public bool approved; }
        static readonly Dictionary<string,Source> sources=new Dictionary<string,Source>();
        static string Identity(UnityEngine.Object asset)=>asset!=null&&AssetDatabase.TryGetGUIDAndLocalFileIdentifier(asset,out string guid,out long localId)?guid+":"+localId:null;
        static Control Copy(VRCExpressionsMenu.Control c,string label=null,bool automatic=false)=>new Control {name=label??c.name,type=(int)c.type,
            parameter=c.parameter?.name??"",subParameters=(c.subParameters??new VRCExpressionsMenu.Control.Parameter[0]).Select(p=>p.name??"").ToArray(),value=c.value,automatic=automatic};
        public static void CaptureSources(Dictionary<string,GameObject> prefabs)
        {
            foreach(var pair in prefabs)
            {
                if(pair.Value==null)continue;
                var hash=AssetDatabase.AssetPathToGUID(pair.Key)+":"+AssetDatabase.GetAssetDependencyHash(pair.Key);
                if(sources.TryGetValue(pair.Key,out var old)&&old.hash==hash)continue;
                var source=new Source {hash=hash};var assets=new Dictionary<VRCExpressionsMenu,Node>();var visiting=new HashSet<GameObject>();
                Node Asset(VRCExpressionsMenu menu)
                {
                    if(menu==null)return null;if(assets.TryGetValue(menu,out var cached))return cached;
                    var node=new Node {asset=Identity(menu)};assets[menu]=node;
                    foreach(var c in menu.controls) {var control=Copy(c);if(c.type==VRCExpressionsMenu.Control.ControlType.SubMenu)control.child=Asset(c.subMenu);node.controls.Add(control);}
                    return node;
                }
                bool Included(Component c)=>!c.GetComponentsInParent<Transform>(true).Any(t=>t.CompareTag("EditorOnly"));
                var itemControls=new Dictionary<ModularAvatarMenuItem,Control>();
                foreach(var item in pair.Value.GetComponentsInChildren<ModularAvatarMenuItem>(true).Where(Included))
                {
                    if(item.Control==null)continue;
                    var c=Copy(item.Control,string.IsNullOrEmpty(item.label)?item.gameObject.name:item.label,item.automaticValue);
                    c.origin=pair.Key+":"+AnimationUtility.CalculateTransformPath(item.transform,pair.Value.transform);
                    c.isDefault=item.isDefault;
                    c.automaticParameter=string.IsNullOrWhiteSpace(c.parameter)
                        &&(item.Control.type==VRCExpressionsMenu.Control.ControlType.Toggle||item.Control.type==VRCExpressionsMenu.Control.ControlType.Button)
                        &&item.GetComponentsInChildren<ReactiveComponent>(true).Any(r=>r.transform==item.transform||r.GetComponentInParent<ModularAvatarMenuItem>()==item);
                    // Identity mappings are proven by the frozen namespace declarations, never by the built control.
                    // Private/generated names and nonidentity/prefix remaps need an independent rename graph.
                    c.unknownMapping=item.GetComponentsInParent<ModularAvatarParameters>(true).SelectMany(p=>p.parameters)
                        .Any(p=>(p.isPrefix?c.parameter.StartsWith(p.nameOrPrefix??""):p.nameOrPrefix==c.parameter)
                            &&(p.internalParameter||!string.IsNullOrWhiteSpace(p.remapTo)&&p.remapTo!=p.nameOrPrefix));
                    var subCount=item.Control.type==VRCExpressionsMenu.Control.ControlType.RadialPuppet?1:
                        item.Control.type==VRCExpressionsMenu.Control.ControlType.TwoAxisPuppet?2:item.Control.type==VRCExpressionsMenu.Control.ControlType.FourAxisPuppet?4:0;
                    c.subParameters=c.subParameters.Take(subCount).ToArray();itemControls[item]=c;source.items.Add(c);
                }
                foreach(var p in pair.Value.GetComponent<VRCAvatarDescriptor>()?.expressionParameters?.parameters??new VRCExpressionParameters.Parameter[0])
                    source.parameters.Add(new Declaration {name=p.name,type=(int)p.valueType,value=p.defaultValue,hasDefault=true});
                foreach(var p in pair.Value.GetComponentsInChildren<ModularAvatarParameters>(true).Where(Included).SelectMany(p=>p.parameters))
                {
                    if(p.internalParameter||!string.IsNullOrWhiteSpace(p.remapTo)&&p.remapTo!=p.nameOrPrefix)source.remappings.Add(p);
                    if(p.syncType!=ParameterSyncType.NotSynced&&!p.isPrefix&&!p.internalParameter&&
                        (string.IsNullOrWhiteSpace(p.remapTo)||p.remapTo==p.nameOrPrefix))
                        source.parameters.Add(new Declaration {name=p.nameOrPrefix,type=p.syncType==ParameterSyncType.Bool?(int)VRCExpressionParameters.ValueType.Bool:
                            p.syncType==ParameterSyncType.Int?(int)VRCExpressionParameters.ValueType.Int:(int)VRCExpressionParameters.ValueType.Float,value=p.defaultValue,hasDefault=p.HasDefaultValue});
                }
                Node Children(GameObject root)
                {
                    var node=new Node();foreach(Transform t in root.transform)
                    {var part=ComponentNode(t.gameObject);if(part!=null)node.controls.AddRange(part.controls);}return node;
                }
                Node ComponentNode(GameObject go)
                {
                    if(go.GetComponentsInParent<Transform>(true).Any(t=>t.CompareTag("EditorOnly")))return null;
                    if(!visiting.Add(go)){source.unknown++;source.reasons.Add("cyclic component source: "+go.name);return null;}
                    try
                    {
                        if(go.GetComponents<Component>().Count(c=>c!=null&&c is nadena.dev.modular_avatar.core.menu.MenuSource)>1)
                        {source.unknown++;source.reasons.Add("ambiguous menu sources: "+go.name);return null;}
                        var item=go.GetComponent<ModularAvatarMenuItem>();
                        if(item!=null&&item.Control!=null)
                        {
                            var node=new Node();var c=itemControls[item];
                            if(item.Control.type==VRCExpressionsMenu.Control.ControlType.SubMenu)
                                c.child=item.MenuSource==SubmenuSource.MenuAsset?Asset(item.Control.subMenu):Children(item.menuSource_otherObjectChildren!=null?item.menuSource_otherObjectChildren:go);
                            node.controls.Add(c);return node;
                        }
                        var group=go.GetComponent<ModularAvatarMenuGroup>();
                        if(group!=null)return Children(group.targetObject!=null?group.targetObject:go);
                        // MA keeps this MenuSource type internal; its public installer field defines the
                        // same contents-at-reference rule as Visit(NodeContext). No plugin execution is inferred.
                        var target=go.GetComponents<Component>().FirstOrDefault(c=>c!=null&&c.GetType().FullName=="nadena.dev.modular_avatar.core.ModularAvatarMenuInstallTarget");
                        if(target!=null)
                        {
                            var field=target.GetType().GetField("installer");
                            if(field==null){source.unknown++;source.reasons.Add("unrecognized install target: "+go.name);return null;}
                            var installer=field.GetValue(target) as ModularAvatarMenuInstaller;
                            if(installer==null)return new Node();
                            return ComponentNode(installer.gameObject)??Asset(installer.menuToAppend)??new Node();
                        }
                        var unsupported=go.GetComponents<Component>().Where(c=>c!=null&&c is nadena.dev.modular_avatar.core.menu.MenuSource).ToList();
                        if(unsupported.Count>0){source.unknown++;source.reasons.Add("menu source: "+go.name+"/"+string.Join(",",unsupported.Select(c=>c.GetType().Name)));}
                        return null;
                    }
                    finally {visiting.Remove(go);}
                }
                source.root=Asset(pair.Value.GetComponent<VRCAvatarDescriptor>()?.expressionsMenu);
                var redirected=new HashSet<ModularAvatarMenuInstaller>(pair.Value.GetComponentsInChildren<Component>(true)
                    .Where(c=>c!=null&&c.GetType().FullName=="nadena.dev.modular_avatar.core.ModularAvatarMenuInstallTarget"&&Included(c))
                    .Select(c=>c.GetType().GetField("installer")?.GetValue(c) as ModularAvatarMenuInstaller).Where(i=>i!=null));
                foreach(var installer in pair.Value.GetComponentsInChildren<ModularAvatarMenuInstaller>(true).Where(i=>Included(i)&&!redirected.Contains(i)))
                    source.installers.Add(new Installer {target=Identity(installer.installTargetMenu),contents=ComponentNode(installer.gameObject)??Asset(installer.menuToAppend),origin=pair.Key+":"+AnimationUtility.CalculateTransformPath(installer.transform,pair.Value.transform)});
                sources[pair.Key]=source;
            }
        }
        static string Path(string[] path)=>Avh.Json(path);
        static string[] Append(string[] path,string name)=>path.Concat(new[]{name??""}).ToArray();
        static List<Entry> Expected(Dictionary<string,object> plan,Dictionary<string,object> record,List<string> notes,out int unknown)
        {
            var result=new List<Entry>();var locations=new Dictionary<string,List<string[]>>();var pending=new List<Installer>();var selected=new List<Source>();var unresolved=0;
            void Expand(Node node,string[] path,HashSet<Node> stack)
            {
                if(node==null){unresolved++;return;}
                if(node.asset!=null) {if(!locations.TryGetValue(node.asset,out var found))locations[node.asset]=found=new List<string[]>();if(!found.Any(p=>Path(p)==Path(path)))found.Add(path);}
                if(!stack.Add(node))return;
                foreach(var c in node.controls) {var entry=new Entry {path=Append(path,c.name),control=c};result.Add(entry);if(c.type==(int)VRCExpressionsMenu.Control.ControlType.SubMenu)Expand(c.child,entry.path,stack);}
                stack.Remove(node);
            }
            void SourceAt(string prefab,bool body)
            {
                if(prefab==null||!sources.TryGetValue(prefab,out var source)||source.hash!=AssetDatabase.AssetPathToGUID(prefab)+":"+AssetDatabase.GetAssetDependencyHash(prefab)) {unresolved++;return;}
                selected.Add(source);unresolved+=source.unknown;if(source.unknown>0)notes.Add("来源菜单 unknown 宿主："+prefab+" "+string.Join(";",source.reasons));
                if(body&&source.root!=null)Expand(source.root,new string[0],new HashSet<Node>());pending.AddRange(source.installers.Where(i=>i.contents!=null&&i.contents.controls.Count>0));
            }
            SourceAt(plan.Str("body_prefab"),true);
            foreach(var rows in record.List("outfits").Cast<Dictionary<string,object>>().GroupBy(r=>r.Str("object")??r.Str("id")))SourceAt(rows.First().Str("prefab"),false);
            bool progress;
            do
            {
                progress=false;
                foreach(var installer in pending.ToList())
                {
                    var destinations=installer.target==null?new List<string[]> {new string[0]}:locations.TryGetValue(installer.target,out var paths)?paths:null;
                    if(destinations==null)continue;
                    foreach(var path in destinations.ToList())Expand(installer.contents,path,new HashSet<Node>());
                    pending.Remove(installer);progress=true;
                }
            }while(progress);
            unresolved+=pending.Count;
            foreach(var installer in pending)notes.Add("来源菜单安装目标不可达："+installer.origin+" target="+installer.target);
            // Reproduce MA's allocation from frozen inputs, including non-menu items reserving values.
            // This is independent of MenuDump, generated menu records and the mutable built parameter asset.
            var allocations=new Dictionary<Control,float>();var allocationUnknown=new HashSet<Control>();
            foreach(var group in selected.SelectMany(s=>s.items).GroupBy(c=>c.parameter))
            {
                var items=group.ToList();var declarations=selected.SelectMany(s=>s.parameters).Where(p=>p.name==group.Key).ToList();
                var defaults=declarations.Where(p=>p.hasDefault).Select(p=>p.value).Distinct().ToList();
                if(string.IsNullOrWhiteSpace(group.Key)||items.Any(c=>c.unknownMapping||c.automaticParameter)
                    ||selected.SelectMany(s=>s.remappings).Any(p=>p.isPrefix||p.nameOrPrefix==group.Key||p.remapTo==group.Key)
                    ||declarations.Select(p=>p.type).Distinct().Count()>1||defaults.Count>1)
                {foreach(var c in items)allocationUnknown.Add(c);continue;}
                int? defaultValue=defaults.Count==1&&!Mathf.Approximately(0,defaults[0])?(int?)defaults[0]:null;
                if(!defaultValue.HasValue)
                {
                    var explicitDefault=items.FirstOrDefault(c=>c.isDefault&&!c.automatic);
                    if(explicitDefault!=null)defaultValue=(int)explicitDefault.value;
                    if(items.Count==1&&items[0].isDefault&&items[0].automatic)defaultValue=1;
                }
                var used=new HashSet<int>(items.Where(c=>!c.automatic).Select(c=>(int)c.value));if(defaultValue.HasValue)used.Add(defaultValue.Value);
                if(!defaultValue.HasValue)for(var i=0;i<256;i++)if(used.Add(i)){defaultValue=i;break;}
                var next=1;
                foreach(var c in items.Where(c=>c.automatic))
                {
                    float value;
                    if(c.isDefault) {if(!defaultValue.HasValue){allocationUnknown.Add(c);continue;}value=defaultValue.Value;}
                    else if(declarations.Count>0&&declarations[0].type!=(int)VRCExpressionParameters.ValueType.Int)value=1;
                    else {while(used.Contains(next)&&next<256)next++;if(next>=256){allocationUnknown.Add(c);continue;}value=next;used.Add(next);}
                    if(allocations.TryGetValue(c,out var previous)&&!Mathf.Approximately(previous,value))allocationUnknown.Add(c);
                    allocations[c]=value;
                }
            }
            foreach(var entry in result)
            {
                var c=entry.control;
                // An unparameterized folder never writes a value; an authored Auto flag is inert here.
                if(c.type==(int)VRCExpressionsMenu.Control.ControlType.SubMenu&&string.IsNullOrEmpty(c.parameter))continue;
                if(c.automaticParameter||c.unknownMapping||c.automatic&&(!allocations.ContainsKey(c)||allocationUnknown.Contains(c)))
                {unresolved++;notes.Add("来源菜单自动分配 unknown："+c.origin+" parameter="+c.parameter);continue;}
                if(c.automatic)entry.control=new Control {name=c.name,parameter=c.parameter,origin=c.origin,subParameters=c.subParameters,type=c.type,
                    value=allocations[c],automatic=true,isDefault=c.isDefault,allocationKnown=true};
            }
            void Add(string[] path,string label,int type,Dictionary<string,object> parameter=null,float value=0)
            {
                result.Add(new Entry {path=Append(path,label),approved=true,control=new Control {name=label,type=type,value=value,parameter=type==(int)VRCExpressionsMenu.Control.ControlType.RadialPuppet?"":parameter?.Str("name")??"",
                    subParameters=type==(int)VRCExpressionsMenu.Control.ControlType.RadialPuppet?new[]{parameter.Str("name")}:new string[0]}});
            }
            void Tree(List<object> nodes,string[] path)
            {
                foreach(Dictionary<string,object> node in nodes)
                {
                    if(node.Str("group")!=null)
                    {
                        var group=AvatarConfig.Groups(plan).Single(g=>g.Str("id")==node.Str("group"));
                        if(group.Str("activation")=="exclusive"&&group.Obj("parameter").Str("type")=="Float")Add(path,group.Str("label"),(int)VRCExpressionsMenu.Control.ControlType.RadialPuppet,group.Obj("parameter"));
                        else {Add(path,group.Str("label"),(int)VRCExpressionsMenu.Control.ControlType.SubMenu);foreach(Dictionary<string,object> member in group.List("members"))
                            Add(Append(path,group.Str("label")),member.Str("label"),(int)VRCExpressionsMenu.Control.ControlType.Toggle,(group.Str("activation")=="exclusive"?group:member).Obj("parameter"),AvatarConfig.Value(group,member));}
                    }
                    else if(node.Str("shared_switch")!=null) {var s=AvatarConfig.Switches(plan).Single(x=>x.Str("id")==node.Str("shared_switch"));Add(path,s.Str("label"),(int)VRCExpressionsMenu.Control.ControlType.Toggle,s.Obj("parameter"),1);}
                    else {Add(path,node.Str("label"),(int)VRCExpressionsMenu.Control.ControlType.SubMenu);Tree(node.List("children"),Append(path,node.Str("label")));}
                }
            }
            Add(new string[0],"造型",(int)VRCExpressionsMenu.Control.ControlType.SubMenu);Tree(plan.Obj("menu").List("tree"),new[]{"造型"});
            unknown=unresolved;return result;
        }
        public static int Failures(GameObject avatar,Dictionary<string,object> plan,Dictionary<string,object> record,List<string> notes)
        {
            if(!AvatarConfig.Grouped(plan))return 0;
            var expected=Expected(plan,record,notes,out var unknown);var actual=new List<Entry>();
            void Walk(VRCExpressionsMenu menu,string[] path,HashSet<VRCExpressionsMenu> stack)
            {
                if(menu==null){unknown++;return;}if(!stack.Add(menu))return;
                foreach(var c in menu.controls)
                {
                    var next=Append(path,c.name);
                    // Only proven overflow links may disappear from the semantic path. Names, grouping,
                    // parameters and all vendor entries otherwise have no authorized difference.
                    var pagination=c.type==VRCExpressionsMenu.Control.ControlType.SubMenu&&(c.name=="More"||c.name=="更多")
                        &&menu.controls.Count==8&&ReferenceEquals(c,menu.controls.Last())&&string.IsNullOrEmpty(c.parameter?.name)
                        &&(c.subParameters?.Length??0)==0&&c.subMenu!=null&&!expected.Any(e=>Path(e.path)==Path(next))
                        &&expected.Count(e=>e.path.Length==path.Length+1&&Path(e.path.Take(path.Length).ToArray())==Path(path))>8;
                    if(!pagination)actual.Add(new Entry {path=next,control=Copy(c)});
                    if(c.type==VRCExpressionsMenu.Control.ControlType.SubMenu)Walk(c.subMenu,pagination?path:next,stack);
                }
                stack.Remove(menu);
            }
            Walk(avatar.GetComponent<VRCAvatarDescriptor>()?.expressionsMenu,new string[0],new HashSet<VRCExpressionsMenu>());
            var actualReadback=actual.ToList();
            bool Match(Entry e,Entry a)=>Path(e.path)==Path(a.path)&&e.control.type==a.control.type
                &&e.control.parameter==a.control.parameter
                &&(e.control.type==(int)VRCExpressionsMenu.Control.ControlType.SubMenu&&string.IsNullOrEmpty(e.control.parameter)
                    ||(e.control.automatic?e.control.value==a.control.value:Math.Abs(e.control.value-a.control.value)<.0001f))
                &&e.control.subParameters.SequenceEqual(a.control.subParameters);
            var failures=unknown;
            foreach(var entry in expected) {var found=actual.FindIndex(a=>Match(entry,a));if(found>=0)actual.RemoveAt(found);else {failures++;if(notes.Count<40)notes.Add("来源/批准菜单入口缺失或布局不符："+Path(entry.path)
                +" expected="+Avh.Json(new object[]{entry.control.type,entry.control.parameter,entry.control.value,entry.control.subParameters})
                +" actual="+Avh.Json(actual.Where(a=>Path(a.path)==Path(entry.path)).Select(a=>(object)new object[]{a.control.type,a.control.parameter,a.control.value,a.control.subParameters}).ToList()));}}
            failures+=actual.Count;if(unknown>0)notes.Add("来源菜单清单 unknown："+unknown);if(actual.Count>0)notes.Add("未获准的菜单树差异："+string.Join(";",actual.Take(8).Select(e=>Path(e.path))));
            object Row(Entry e)=>new Dictionary<string,object> { ["path"]=e.path,["type"]=e.control.type,["parameter"]=e.control.parameter,["value"]=e.control.value,
                ["sub_parameters"]=e.control.subParameters,["automatic_value"]=e.control.automatic,["automatic_parameter"]=e.control.automaticParameter,
                ["allocation_source"]=e.control.origin,["allocation_status"]=e.control.type==(int)VRCExpressionsMenu.Control.ControlType.SubMenu&&string.IsNullOrEmpty(e.control.parameter)?"unused":
                    e.control.automaticParameter||e.control.unknownMapping||e.control.automatic&&!e.control.allocationKnown?"unknown":e.control.automatic?"proven":"literal",
                ["parameter_mapping"]=e.control.automaticParameter||e.control.unknownMapping?null:new[]{e.control.parameter,e.control.parameter} };
            Avh.WriteJson(System.IO.Path.Combine(Avh.RunDir,"observations","menu-tree-readback.json"),new Dictionary<string,object> {
                ["schema"]="menu-tree-readback/0.1",["source_entries"]=expected.Where(e=>!e.approved).Select(Row).ToList(),
                ["approved_entries"]=expected.Where(e=>e.approved).Select(Row).ToList(),["actual_entries"]=actualReadback.Select(Row).ToList(),
                ["allowed_differences"]=new[]{"proven eight-control overflow pagination","independently resolved MA allocation with exact parameter and value","unused unparameterized submenu value"},
                ["unknown"]=unknown,["failures"]=failures });
            return failures;
        }
    }
    /// <summary>Expectations originate in the accepted configuration, never the compiler's controls list.</summary>
    public static class BusinessMotionAudit
    {
        public static int Unknown(GameObject avatar, Dictionary<string,object> plan, Dictionary<string,object> record, List<string> notes)
        {
            if(!AvatarConfig.Grouped(plan))return 0;
            var paths=new HashSet<string>();var ancestors=new HashSet<string>();
            foreach(Dictionary<string,object> row in record.List("outfits"))foreach(var entry in row.List("installed_parts"))
            {
                var path=entry.ToString();if(AvatarAudit.Locate(avatar.transform,path)==null)path=row.Obj("built_paths")?.Str(path)??path;
                paths.Add(path);for(var t=AvatarAudit.Locate(avatar.transform,path);t!=null;t=t.parent)
                {ancestors.Add(AnimationUtility.CalculateTransformPath(t,avatar.transform));if(t==avatar.transform)break;}
            }
            var shapes=SourceShapeAudit.For(avatar,plan,record);
            bool Business(EditorCurveBinding b)=>b.type==typeof(GameObject)&&b.propertyName=="m_IsActive"&&ancestors.Contains(b.path)
                ||typeof(Renderer).IsAssignableFrom(b.type)&&paths.Contains(b.path)&&(b.propertyName=="m_Enabled"||b.propertyName.StartsWith("m_Materials."))
                ||shapes.ObservesBinding(avatar,b);
            var layers=AvatarAudit.Layers(avatar.GetComponent<VRCAvatarDescriptor>()).SelectMany(x=>x.controller.layers).ToList();
            var needed=new HashSet<string>(MenuGroups.Parameters(plan).Select(p=>p.Str("name")));
            IEnumerable<EditorCurveBinding> Bindings(Motion m)=>AvatarAudit.Clips(m).SelectMany(c=>AnimationUtility.GetCurveBindings(c).Concat(AnimationUtility.GetObjectReferenceCurveBindings(c)));
            bool Relevant(Motion m)=>Bindings(m).Any(b=>Business(b)||b.type==typeof(Animator)&&needed.Contains(b.propertyName));
            // Entry-event Driver writes are not executed by either certification engine. Trace destination
            // dependencies backwards, including Copy sources and state-machine entry conditions.
            IEnumerable<VRCAvatarParameterDriver> Drivers(AnimatorStateMachine machine) =>
                machine.behaviours.OfType<VRCAvatarParameterDriver>()
                .Concat(AvatarAudit.States(machine).SelectMany(s=>s.behaviours.OfType<VRCAvatarParameterDriver>()))
                .Concat(machine.stateMachines.SelectMany(s=>Drivers(s.stateMachine))).Distinct();
            bool changed;
            do
            {
                changed=false;
                foreach(var layer in layers)
                {
                    var states=AvatarAudit.States(layer.stateMachine).ToList();var drivers=Drivers(layer.stateMachine).ToList();
                    if(!states.Any(s=>Relevant(s.motion))&&!drivers.Any(d=>d.parameters.Any(p=>needed.Contains(p.name))))continue;
                    foreach(var name in states.SelectMany(s=>s.transitions.SelectMany(t=>t.conditions).Select(c=>c.parameter))
                        .Concat(MachineConditions(layer.stateMachine))
                        .Concat(states.Where(s=>s.timeParameterActive).Select(s=>s.timeParameter))
                        .Concat(states.Where(s=>s.speedParameterActive).Select(s=>s.speedParameter))
                        .Concat(states.Where(s=>s.mirrorParameterActive).Select(s=>s.mirrorParameter))
                        .Concat(states.Where(s=>s.cycleOffsetParameterActive).Select(s=>s.cycleOffsetParameter))
                        .Concat(drivers.SelectMany(d=>d.parameters).Where(p=>needed.Contains(p.name)&&p.type==VRC_AvatarParameterDriver.ChangeType.Copy).Select(p=>p.source))
                        .Concat(states.SelectMany(s=>Trees(s.motion)).SelectMany(t=>new[]{t.blendParameter,t.blendParameterY}.Concat(t.children.Select(c=>c.directBlendParameter)))))
                        if(!string.IsNullOrEmpty(name))changed|=needed.Add(name);
                }
            }while(changed);
            var unknown=layers.SelectMany(l=>AvatarAudit.States(l.stateMachine)).SelectMany(s=>Trees(s.motion)).Distinct()
                .Where(t=>t.blendType!=BlendTreeType.Direct&&t.blendType!=BlendTreeType.Simple1D&&Relevant(t)).ToList();
            if(unknown.Count>0)notes.Add("业务状态依赖未支持的混合树，无法认证："+string.Join(", ",unknown.Select(t=>t.name)));
            var unknownDrivers=layers.SelectMany(l=>Drivers(l.stateMachine).Where(d=>d.parameters.Any(p=>needed.Contains(p.name)))
                .Select(d=>l.name+":"+string.Join(",",d.parameters.Where(p=>needed.Contains(p.name)).Select(p=>p.name)))).ToList();
            if(unknownDrivers.Count>0)notes.Add("业务状态依赖未执行的 ParameterDriver，unknown 并阻断："+string.Join(";",unknownDrivers));
            return unknown.Count+unknownDrivers.Count;
        }
        static IEnumerable<BlendTree> Trees(Motion motion)
        {
            if(!(motion is BlendTree tree))yield break;yield return tree;
            foreach(var child in tree.children)foreach(var inner in Trees(child.motion))yield return inner;
        }
        static IEnumerable<string> MachineConditions(AnimatorStateMachine machine)
        {
            foreach(var transition in machine.entryTransitions)foreach(var condition in transition.conditions)yield return condition.parameter;
            foreach(var transition in machine.anyStateTransitions)foreach(var condition in transition.conditions)yield return condition.parameter;
            foreach(var child in machine.stateMachines)
            {
                foreach(var transition in machine.GetStateMachineTransitions(child.stateMachine))foreach(var condition in transition.conditions)yield return condition.parameter;
                foreach(var parameter in MachineConditions(child.stateMachine))yield return parameter;
            }
        }
    }
    public static class MenuGroupAudit
    {
        public sealed class NativePose : IDisposable
        {
            public GameObject Avatar { get; }
            PlayableGraph graph;
            public NativePose(GameObject built,Dictionary<string,float> values)
            {
                Avatar=UnityEngine.Object.Instantiate(built);Avatar.name=built.name;
                try
                {
                    var animator=Avatar.GetComponent<Animator>();if(animator==null)animator=Avatar.AddComponent<Animator>();animator.runtimeAnimatorController=null;animator.cullingMode=AnimatorCullingMode.AlwaysAnimate;
                    graph=PlayableGraph.Create("AVH Native Photo State");var fx=AvatarAudit.Layers(Avatar.GetComponent<VRCAvatarDescriptor>()).Single(l=>l.type==VRCAvatarDescriptor.AnimLayerType.FX).controller;
                    var playable=AnimatorControllerPlayable.Create(graph,fx);var output=AnimationPlayableOutput.Create(graph,"FX",animator);output.SetSourcePlayable(playable);
                    var types=fx.parameters.ToDictionary(p=>p.name,p=>p.type);
                    foreach(var value in values)
                    { if(!types.TryGetValue(value.Key,out var type))throw new Exception("Native pose parameter missing: "+value.Key);
                      if(type==AnimatorControllerParameterType.Bool)playable.SetBool(value.Key,value.Value!=0);else if(type==AnimatorControllerParameterType.Int)playable.SetInteger(value.Key,Mathf.RoundToInt(value.Value));else playable.SetFloat(value.Key,value.Value); }
                    graph.SetTimeUpdateMode(DirectorUpdateMode.Manual);graph.Play();for(var frame=0;frame<16;frame++)graph.Evaluate(1f/60);
                }
                catch {Dispose();throw;}
            }
            public void Dispose() {if(graph.IsValid())graph.Destroy();if(Avatar!=null)UnityEngine.Object.DestroyImmediate(Avatar);}
        }
        public static List<Dictionary<string, float>> Cells(Dictionary<string, object> plan)
        {
            var cells = new List<Dictionary<string, float>> { AvatarConfig.Defaults(plan) };
            foreach (var g in AvatarConfig.Groups(plan))
            {
                if (g.Str("activation") == "exclusive")
                {
                    var values = g.List("members").Cast<Dictionary<string, object>>().Select(m => AvatarConfig.Value(g, m)).ToArray();
                    var parameter = g.Obj("parameter").Str("name");
                    cells = cells.SelectMany(c => values.Select(v => new Dictionary<string, float>(c) { [parameter] = v })).ToList();
                }
                if (g.Str("activation") == "independent") foreach (Dictionary<string, object> m in g.List("members"))
                {
                    var name = m.Obj("parameter").Str("name");
                    cells = cells.SelectMany(c => new[] { new Dictionary<string, float>(c) { [name] = 0 }, new Dictionary<string, float>(c) { [name] = 1 } }).ToList();
                }
            }
            foreach (var s in AvatarConfig.Switches(plan))
            {
                var name = s.Obj("parameter").Str("name");
                cells = cells.SelectMany(c => new[] { new Dictionary<string, float>(c) { [name] = 0 }, new Dictionary<string, float>(c) { [name] = 1 } }).ToList();
            }
            return cells;
        }
        public static List<Dictionary<string, float>> Samples(Dictionary<string, object> plan)
        {
            var samples = new List<Dictionary<string, float>> { AvatarConfig.Defaults(plan) };
            foreach (var g in AvatarConfig.Groups(plan))
            {
                if (g.Str("activation") == "exclusive")
                {
                    var members = g.List("members").Cast<Dictionary<string, object>>().ToList();
                    var values = members.Select(m => AvatarConfig.Value(g, m)).ToList();
                    if (g.Obj("parameter").Str("type") == "Float")
                    {
                        values.AddRange(new[] { 0f, 1f });
                        for (var i = 1; i < members.Count; i++) values.AddRange(new[] { AvatarConfig.Boundary(i,members.Count) - .00001f, AvatarConfig.Boundary(i,members.Count), AvatarConfig.Boundary(i,members.Count) + .00001f });
                        values.AddRange(values.ToArray().Select(v => Mathf.Round(v * 127) / 127));
                    }
                    foreach (var v in values.Distinct()) samples.Add(new Dictionary<string, float>(samples[0]) { [g.Obj("parameter").Str("name")] = v });
                }
                if (g.Str("activation") == "independent") foreach (Dictionary<string, object> m in g.List("members"))
                    foreach (var v in new[] { 0f, 1f }) samples.Add(new Dictionary<string, float>(samples[0]) { [m.Obj("parameter").Str("name")] = v });
            }
            foreach (var s in AvatarConfig.Switches(plan)) foreach (var v in new[] { 0f, 1f })
            {
                var state = new Dictionary<string, float>(samples[0]) { [s.Obj("parameter").Str("name")] = v }; samples.Add(state);
                foreach (var g in AvatarConfig.Groups(plan).Where(g => g.Str("activation") == "exclusive"))
                    foreach (Dictionary<string, object> m in g.List("members"))
                        samples.Add(new Dictionary<string, float>(state) { [g.Obj("parameter").Str("name")] = AvatarConfig.Value(g, m) });
            }
            foreach (var color in MaterialAxes.Groups(plan))
            {
                var owners = AvatarConfig.InstanceGroups(plan).Where(g => g.List("members").Cast<Dictionary<string, object>>().Any(m =>
                    color.List("bindings").Cast<Dictionary<string, object>>().Any(b => b.Str("instance") == m.Str("instance")))).ToList();
                foreach (Dictionary<string, object> shade in color.List("members")) foreach (var owner in owners)
                    foreach (Dictionary<string, object> shape in owner.List("members"))
                    {
                        var state = new Dictionary<string, float>(samples[0]) { [color.Obj("parameter").Str("name")] = AvatarConfig.Value(color, shade) };
                        if (owner.Str("activation") != "fixed") state[(owner.Str("activation") == "exclusive" ? owner : shape).Obj("parameter").Str("name")] = AvatarConfig.Value(owner, shape);
                        samples.Add(state);
                    }
            }
            return samples;
        }
        static string Path(GameObject avatar, Dictionary<string, object> row, string source)
        {
            if (AvatarAudit.Locate(avatar.transform, source) != null) return source;
            var path = row.Obj("built_paths")?.Str(source);
            return path != null && AvatarAudit.Locate(avatar.transform, path) != null ? path : null;
        }
        public static int SceneAssertions(GameObject avatar, Dictionary<string, object> plan, Dictionary<string, object> record, List<string> notes)
        {
            // A stage observer can run in a fresh Unity process. Capture immutable source snapshots from the
            // persisted plan/record before constructing the audit; never use the assembled scene as the baseline.
            if (AvatarConfig.Grouped(plan)) SourceShapeAudit.CaptureSources(plan, record);
            bool Visible(string p) { var t = AvatarAudit.Locate(avatar.transform, p); return t != null && t.gameObject.activeInHierarchy
                && (t.GetComponent<Renderer>() == null || t.GetComponent<Renderer>().enabled) && !t.GetComponentsInParent<Transform>(true).Any(x => x.CompareTag("EditorOnly")); }
            Material Material(string p, int s) => AvatarAudit.Locate(avatar.transform, p)?.GetComponent<Renderer>()?.sharedMaterials.ElementAtOrDefault(s);
            return AssertState(avatar, plan, record, AvatarConfig.Defaults(plan), Visible, Material, notes, animated:false);
        }
        public static int AssertState(GameObject avatar, Dictionary<string, object> plan, Dictionary<string, object> record,
            Dictionary<string, float> values, Func<string, bool> visible, Func<string, int, Material> material, List<string> notes,
            Func<string, string, float?> weight = null, Func<Transform, Vector3> scale = null, bool animated=true)
        {
            var failures = 0;
            var rows = record.List("outfits").Cast<Dictionary<string, object>>().ToList();
            var expected = new Dictionary<string, bool>();
            var mappings = new Dictionary<Transform, string>();
            var materialExpected = new Dictionary<(string, int), Material>();
            foreach (var group in AvatarConfig.InstanceGroups(plan)) foreach (Dictionary<string, object> member in group.List("members"))
            {
                var specification = plan.List("outfits").Cast<Dictionary<string, object>>().Single(o => o.Str("id") == member.Str("id"));
                var row = rows.SingleOrDefault(o => o.Str("id") == member.Str("id"));
                if (row == null || row.Str("prefab") != specification.Str("prefab") || row.Str("instance") != member.Str("instance") || row.Str("variant") != member.Str("variant"))
                { failures++; if (notes.Count < 40) notes.Add("缺少成员来源绑定：" + member.Str("id")); continue; }
                var on = AvatarConfig.Selected(group, member, values);
                var sourcePrefab = AssetDatabase.LoadAssetAtPath<GameObject>(specification.Str("prefab"));
                if (sourcePrefab == null || row.Str("source_guid") != AssetDatabase.AssetPathToGUID(specification.Str("prefab"))
                    || row.Str("source_hash") != AssetDatabase.GetAssetDependencyHash(specification.Str("prefab")).ToString())
                { failures++; if (notes.Count < 40) notes.Add("成员源身份已变或缺失：" + member.Str("id")); continue; }
                var sourceParts = OutfitStage.InstalledParts(sourcePrefab).ToList();
                var parts = sourceParts.ToDictionary(t => row.Str("object") + (t == sourcePrefab.transform ? "" : "/" + AnimationUtility.CalculateTransformPath(t, sourcePrefab.transform)),
                    t => (object)(t.GetComponentsInParent<Transform>(true).TakeWhile(p => p != sourcePrefab.transform).All(p => p.gameObject.activeSelf && !p.CompareTag("EditorOnly"))
                        && (t.GetComponent<Renderer>() == null || t.GetComponent<Renderer>().enabled)));
                if (!parts.Keys.OrderBy(p => p).SequenceEqual(row.List("installed_parts").Select(p => p.ToString()).OrderBy(p => p)))
                { failures++; if (notes.Count < 40) notes.Add("独立源可视集合与装配记录不符：" + member.Str("id")); }
                if (parts == null || parts.Count == 0) { failures++; continue; }
                foreach (var part in parts)
                {
                    var required = on && Equals(part.Value, true);
                    foreach (var s in AvatarConfig.Switches(plan)) foreach (Dictionary<string, object> target in s.List("targets"))
                        if (target.Str("instance") == member.Str("instance"))
                        {
                            var instance = plan.Obj("avatar_config").List("instances").Cast<Dictionary<string, object>>().Single(i => i.Str("id") == target.Str("instance"));
                            var component = instance.List("components").Cast<Dictionary<string, object>>().Single(c => c.Str("id") == target.Str("component"));
                            foreach (var relative in component.List("objects"))
                            {
                                var path = row.Str("object") + "/" + relative;
                                if (part.Key == path || part.Key.StartsWith(path + "/")) required &= values[s.Obj("parameter").Str("name")] > .5f;
                            }
                        }
                    var actual = Path(avatar, row, part.Key);
                    if (actual == null) { failures++; if (notes.Count < 40) notes.Add("可视件构建映射缺失：" + part.Key); continue; }
                    var mapped = AvatarAudit.Locate(avatar.transform, actual);
                    if (mappings.TryGetValue(mapped, out var previousSource) && previousSource != part.Key)
                    { failures++; if (notes.Count < 40) notes.Add("两个源可视件解析到同一构建对象：" + part.Key); continue; }
                    mappings[mapped] = part.Key;
                    expected[actual] = (expected.TryGetValue(actual, out var previous) && previous) || required;
                }
                if (on) foreach (Dictionary<string, object> preset in VariantResolver.Materials(sourcePrefab,
                    sourcePrefab, sourcePrefab.transform))
                {
                    var relative = preset.Str("renderer");
                    preset["renderer"] = row.Str("object") + (string.IsNullOrEmpty(relative) ? "" : "/" + relative);
                    var actual = Path(avatar, row, preset.Str("renderer"));
                    if (actual == null) { failures++; continue; }
                    for (var slot = 0; slot < preset.List("materials").Count; slot++)
                        if (!MaterialAxes.Owns(plan, row, preset.Str("renderer"), slot)) materialExpected[(actual, slot)] = MenuGroups.PresetMaterialObject(row, preset, slot, actualBinding: false);
                }
            }
            // Independent material axes apply to hidden instances too, so switching visibility preserves color.
            foreach (var group in MaterialAxes.Groups(plan))
            {
                try
                {
                    var member = group.List("members").Cast<Dictionary<string, object>>().Single(m => AvatarConfig.Selected(group, m, values));
                    foreach (var slot in MaterialAxes.Slots(group, record))
                    {
                        var actual = Path(avatar, slot.Row, slot.Path);
                        if (actual == null) { failures++; continue; }
                        materialExpected[(actual, slot.Index)] = MaterialAxes.Expected(plan, member, slot.Binding.Str("id"));
                    }
                }
                catch (Exception e) { failures++; if (notes.Count < 40) notes.Add("Material axis unknown: " + e.Message); }
            }
            foreach (var (path, on) in expected) if (visible(path) != on)
            { failures++; if (notes.Count < 40) notes.Add("业务可视态不符：" + path + " 应为 " + on); }
            foreach (var (key, asset) in materialExpected) if (Avh.Json(VariantResolver.Identity(material(key.Item1, key.Item2))) != Avh.Json(VariantResolver.Identity(asset)))
            { failures++; if (notes.Count < 40) notes.Add("材质预设不符：" + key.Item1 + ":" + key.Item2); }
            var shapes = SourceShapeAudit.For(avatar, plan, record).Check(avatar, visible,
                weight ?? ((p,n) => SourceShapeAudit.ReadWeight(avatar,p,n)), scale ?? SourceShapeAudit.ReadScale, notes, values, animated);
            failures += shapes.failures + shapes.unknown;
            return failures;
        }
        public static Dictionary<string, object> Metrics(GameObject avatar, List<string> notes)
        {
            var plan = Avh.Plan(); var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
            var unsupported = BusinessMotionAudit.Unknown(avatar,plan,record,notes);
            var menu = Avh.ReadJsonFile(Avh.Abs(MenuStage.RecordPath));
            var descriptor = avatar.GetComponent<VRCAvatarDescriptor>();
            var parameters = descriptor.expressionParameters?.parameters ?? new VRCExpressionParameters.Parameter[0];
            var menus = new List<VRCExpressionsMenu>();
            void Collect(VRCExpressionsMenu m) { if (m == null || menus.Contains(m)) return; menus.Add(m); foreach (var c in m.controls.Where(c => c.type == VRCExpressionsMenu.Control.ControlType.SubMenu)) Collect(c.subMenu); }
            Collect(descriptor.expressionsMenu);
            var controllers = AvatarAudit.Layers(descriptor).Select(x => x.controller).Distinct().ToList();
            // Verify final property ownership after all build plugins, independently of compiler diagnostics.
            var propertyFailures = 0;
            var actualOwners = new Dictionary<string, HashSet<string>>();
            foreach (var controller in controllers) for (var i = 0; i < controller.layers.Length; i++)
                foreach (var clip in AvatarAudit.States(controller.layers[i].stateMachine).SelectMany(s => AvatarAudit.Clips(s.motion)).Distinct())
                    foreach (var b in AnimationUtility.GetCurveBindings(clip).Concat(AnimationUtility.GetObjectReferenceCurveBindings(clip)))
                    {
                        var key = b.path + "|" + MenuGroups.PropertyType(b.type) + "|" + b.propertyName;
                        if (!actualOwners.TryGetValue(key, out var writers)) actualOwners[key] = writers = new HashSet<string>();
                        writers.Add(controller.name + "/" + i + ":" + controller.layers[i].name + ":weight=" + controller.layers[i].defaultWeight);
                    }
            foreach (Dictionary<string, object> binding in menu.List("bindings"))
            {
                var row = record.List("outfits").Cast<Dictionary<string, object>>().FirstOrDefault(r => binding.Str("path") == r.Str("object") || binding.Str("path").StartsWith(r.Str("object") + "/"));
                var path = row == null ? null : Path(avatar, row, binding.Str("path"));
                // Empty source roots can be optimized away; every surviving visual property is still audited.
                if (path == null && row != null && binding.Str("path") == row.Str("object") && row.List("bone_proxy_visuals").Count > 0) continue;
                var key = path + "|" + MenuGroups.PropertyType(binding.Str("type")) + "|" + binding.Str("property");
                if (path == null || !actualOwners.TryGetValue(key, out var writers) || writers.Count != 1)
                { propertyFailures++; if (notes.Count < 40) notes.Add("构建属性所有者缺失/不唯一：" + key + "；源=" + binding.Str("path")
                    + "；实际子属性=" + string.Join(";", actualOwners.Where(p => p.Key.StartsWith(path + "/") || p.Key.StartsWith(path + "|")).Take(20).Select(p => p.Key + "=" + string.Join(",", p.Value)))); }
            }
            var parameterFailures = 0; var reachable = 0;
            var defaults = AvatarConfig.Defaults(plan);
            foreach (var spec in MenuGroups.Parameters(plan))
            {
                var name = spec.Str("name"); var p = parameters.SingleOrDefault(x => x.name == name);
                if (p == null || p.valueType.ToString() != spec.Str("type") || p.saved != AvatarConfig.On(spec, "saved") || p.networkSynced != AvatarConfig.On(spec, "synced")
                    || Math.Abs(p.defaultValue - defaults[name]) > .0001f) parameterFailures++;
                var declarations = controllers.SelectMany(c => c.parameters).Where(x => x.name == name).ToList();
                if (declarations.Count == 0 || declarations.Any(x => x.type.ToString() != spec.Str("type")
                    || Math.Abs((x.type == AnimatorControllerParameterType.Float ? x.defaultFloat : x.type == AnimatorControllerParameterType.Int ? x.defaultInt : x.defaultBool ? 1 : 0) - defaults[name]) > .0001f)) parameterFailures++;
                var actualControls = menus.SelectMany(m => m.controls).Where(c => c.parameter?.name == name || (c.subParameters ?? new VRCExpressionsMenu.Control.Parameter[0]).Any(s => s.name == name)).ToList();
                if (actualControls.Count == 0 || !controllers.SelectMany(c => c.layers).Any(l => AvatarAudit.States(l.stateMachine).Any(s => s.timeParameter == name
                    || s.transitions.SelectMany(t => t.conditions).Any(c => c.parameter == name)) || l.stateMachine.anyStateTransitions.SelectMany(t => t.conditions).Any(c => c.parameter == name))) reachable++;
                if (spec.Str("type") == "Float" && !actualControls.Any(c => c.type == VRCExpressionsMenu.Control.ControlType.RadialPuppet
                    && c.subParameters?.Length == 1 && c.subParameters[0].name == name)) reachable++;
                if (spec.Str("type") == "Bool" && !actualControls.Any(c => c.type == VRCExpressionsMenu.Control.ControlType.Toggle
                    && c.parameter?.name == name && Math.Abs(c.value - 1) < .0001f)) reachable++;
                var intGroup = AvatarConfig.Groups(plan).FirstOrDefault(g => g.Obj("parameter")?.Str("name") == name && spec.Str("type") == "Int");
                if (intGroup != null) foreach (Dictionary<string, object> m in intGroup.List("members"))
                    if (!actualControls.Any(c => c.type == VRCExpressionsMenu.Control.ControlType.Toggle && c.value == AvatarConfig.Value(intGroup, m))) reachable++;
            }
            var sim = new AnimatorSim(avatar); var initial = sim.Evaluate(defaults);
            var defaultFailures = AssertState(avatar, plan, record, defaults, initial.Visible, initial.MaterialAt, notes, initial.WeightAt, initial.Scale);
            // The saved prefab's actual values must agree too; do not let Animator defaults conceal a bad initial object state.
            bool SceneVisible(string path) { var t = AvatarAudit.Locate(avatar.transform, path); return t != null && t.gameObject.activeInHierarchy && (t.GetComponent<Renderer>() == null || t.GetComponent<Renderer>().enabled) && !t.GetComponentsInParent<Transform>(true).Any(p => p.CompareTag("EditorOnly")); }
            defaultFailures += AssertState(avatar, plan, record, defaults, SceneVisible, (p, s) => AvatarAudit.Locate(avatar.transform, p)?.GetComponent<Renderer>()?.sharedMaterials.ElementAtOrDefault(s), notes, animated:false);
            var failures = 0; var samples = Samples(plan);
            foreach (var values in samples) { var state = sim.Evaluate(values); var count = AssertState(avatar, plan, record, values, state.Visible, state.MaterialAt, notes, state.WeightAt, state.Scale); failures += count;
                if (count > 0 && notes.Count < 40) notes.Add("失败参数向量：" + Avh.Json(values)); }
            var looping = controllers.SelectMany(c => c.layers).SelectMany(l => AvatarAudit.States(l.stateMachine))
                .Where(s => s.timeParameterActive && defaults.ContainsKey(s.timeParameter)).Count(s => !(s.motion is AnimationClip c) || c.length <= 0 || AnimationUtility.GetAnimationClipSettings(c).loopTime);
            var identity = menu.Str("configuration_hash") == MenuGroups.ConfigHash(plan) && Avh.Json(record.Obj("avatar_config")) == Avh.Json(plan.Obj("avatar_config"));
            var treeFailures=SourceMenuAudit.Failures(avatar,plan,record,notes);
            return new Dictionary<string, object> { ["group_defaults_match"] = defaultFailures == 0 && unsupported == 0, ["group_members_reachable"] = reachable == 0 && failures == 0 && looping == 0 && unsupported == 0,
                ["menu_parameter_contract"] = parameterFailures == 0, ["menu_parameter_limits"] = parameters.Length <= 8192 && parameters.Where(p => p.networkSynced).Sum(p => VRCExpressionParameters.TypeCost(p.valueType)) <= 256,
                ["menu_coverage_complete"] = identity && reachable == 0 && failures == 0 && propertyFailures == 0 && unsupported == 0 && treeFailures == 0,
                ["menu_tree_matches"] = treeFailures == 0, ["menu_tree_failures"] = treeFailures,
                ["property_owners_resolved"] = propertyFailures == 0, ["property_owner_failures"] = propertyFailures,
                ["synced_parameter_bits"] = parameters.Where(p => p.networkSynced).Sum(p => VRCExpressionParameters.TypeCost(p.valueType)),
                ["expression_parameter_count"] = parameters.Length, ["group_state_assertion_failures"] = failures, ["group_sample_count"] = samples.Count,
                ["unsupported_business_motion_count"] = unsupported };
        }
        public static int Assertions(GameObject avatar, List<string> notes, bool all = false)
        {
            var plan = Avh.Plan(); var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
            var failures = Metrics(avatar, notes).Where(p => p.Value is bool b && !b).Count();
            var sim = new AnimatorSim(avatar);
            foreach (var values in all ? Cells(plan) : Samples(plan))
            { var state = sim.Evaluate(values); failures += AssertState(avatar, plan, record, values, state.Visible, state.MaterialAt, notes, state.WeightAt, state.Scale); }
            foreach (var s in AvatarConfig.Switches(plan))
            {
                var values = AvatarConfig.Defaults(plan); values[s.Obj("parameter").Str("name")] = 0;
                var events = Samples(plan).Select(v => v.Where(p => p.Key != s.Obj("parameter").Str("name")).ToDictionary(p => p.Key, p => p.Value)).ToList();
                foreach (var e in events)
                {
                    foreach (var p in e) values[p.Key] = p.Value;
                    var state = sim.Walk(new[] { new Dictionary<string, float> { [s.Obj("parameter").Str("name")] = 0 }, e });
                    failures += AssertState(avatar, plan, record, values, state.Visible, state.MaterialAt, notes, state.WeightAt, state.Scale);
                }
            }
            return failures;
        }
        public static int RuntimeAssertions(GameObject built, List<string> notes, out int steps)
        {
            var plan = Avh.Plan(); var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
            var clone = UnityEngine.Object.Instantiate(built); clone.name = built.name;
            var graph = PlayableGraph.Create("AVH Group Readback"); steps = 0;
            try
            {
                var animator = clone.GetComponent<Animator>(); if (animator == null) animator = clone.AddComponent<Animator>();
                animator.runtimeAnimatorController = null; animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
                var controller = AvatarAudit.Layers(clone.GetComponent<VRCAvatarDescriptor>()).Single(x => x.type == VRCAvatarDescriptor.AnimLayerType.FX).controller;
                var playable = AnimatorControllerPlayable.Create(graph, controller);
                var output = AnimationPlayableOutput.Create(graph, "FX", animator); output.SetSourcePlayable(playable);
                graph.SetTimeUpdateMode(DirectorUpdateMode.Manual); graph.Play();
                var values = AvatarConfig.Defaults(plan); var events = new List<Dictionary<string, float>> { new Dictionary<string, float>(values) };
                // Incremental events preserve unspecified channels; defaults are reset only explicitly.
                foreach (var g in AvatarConfig.Groups(plan))
                {
                    if (g.Str("activation") == "exclusive")
                    {
                        var name = g.Obj("parameter").Str("name");
                        foreach (var value in Samples(plan).Select(p => p[name]).Distinct()) events.Add(new Dictionary<string, float> { [name] = value });
                        events.Add(new Dictionary<string, float> { [name] = AvatarConfig.Defaults(plan)[name] });
                    }
                    if (g.Str("activation") == "independent") foreach (Dictionary<string, object> m in g.List("members"))
                        foreach (var value in new[] { 0f, 1f, 0f, AvatarConfig.Defaults(plan)[m.Obj("parameter").Str("name")] })
                            events.Add(new Dictionary<string, float> { [m.Obj("parameter").Str("name")] = value });
                }
                foreach (var s in AvatarConfig.Switches(plan))
                {
                    events.Add(new Dictionary<string, float> { [s.Obj("parameter").Str("name")] = 0 });
                    foreach (var g in AvatarConfig.Groups(plan).Where(g => g.Str("activation") == "exclusive")) foreach (Dictionary<string, object> m in g.List("members"))
                        events.Add(new Dictionary<string, float> { [g.Obj("parameter").Str("name")] = AvatarConfig.Value(g, m) });
                }
                // Keep each color parameter untouched while cycling all of its instance owners and returning.
                foreach (var color in MaterialAxes.Groups(plan)) foreach (Dictionary<string, object> shade in color.List("members"))
                {
                    events.Add(new Dictionary<string, float> { [color.Obj("parameter").Str("name")] = AvatarConfig.Value(color, shade) });
                    foreach (var owner in AvatarConfig.InstanceGroups(plan).Where(g => g.Str("activation") != "fixed" && g.List("members").Cast<Dictionary<string, object>>().Any(m =>
                        color.List("bindings").Cast<Dictionary<string, object>>().Any(b => b.Str("instance") == m.Str("instance")))))
                    {
                        foreach (Dictionary<string, object> shape in owner.List("members")) events.Add(new Dictionary<string, float> {
                            [(owner.Str("activation") == "exclusive" ? owner : shape).Obj("parameter").Str("name")] = AvatarConfig.Value(owner, shape) });
                        var name = owner.Str("activation") == "exclusive" ? owner.Obj("parameter").Str("name") : null;
                        if (name != null) events.Add(new Dictionary<string, float> { [name] = AvatarConfig.Defaults(plan)[name] });
                    }
                }
                events.Add(AvatarConfig.Defaults(plan));
                var failures = 0;
                var specs = MenuGroups.Parameters(plan).ToDictionary(p => p.Str("name"));
                var materialEvents = new List<object>();
                foreach (var e in events)
                {
                    foreach (var p in e)
                    {
                        values[p.Key] = p.Value;
                        if (specs[p.Key].Str("type") == "Float") playable.SetFloat(p.Key, p.Value);
                        else if (specs[p.Key].Str("type") == "Int") playable.SetInteger(p.Key, (int)p.Value);
                        else playable.SetBool(p.Key, p.Value > .5f);
                    }
                    graph.Evaluate(1f / 30); graph.Evaluate(1f / 30);
                    foreach (var expected in values)
                    {
                        var actual = specs[expected.Key].Str("type") == "Float" ? playable.GetFloat(expected.Key)
                            : specs[expected.Key].Str("type") == "Int" ? playable.GetInteger(expected.Key) : playable.GetBool(expected.Key) ? 1 : 0;
                        if (Math.Abs(actual - expected.Value) > .00001f) { failures++; notes.Add("参数增量事件被改写：" + expected.Key); }
                    }
                    bool Visible(string p) { var t = AvatarAudit.Locate(clone.transform, p); return t != null && t.gameObject.activeInHierarchy && (t.GetComponent<Renderer>() == null || t.GetComponent<Renderer>().enabled) && !t.GetComponentsInParent<Transform>(true).Any(x => x.CompareTag("EditorOnly")); }
                    Material Material(string p, int slot) => AvatarAudit.Locate(clone.transform, p)?.GetComponent<Renderer>()?.sharedMaterials.ElementAtOrDefault(slot);
                    failures += AssertState(clone, plan, record, values, Visible, Material, notes); steps++;
                    if (MaterialAxes.Groups(plan).Any())
                    {
                        var slots = new List<object>();
                        foreach (var axis in MaterialAxes.Groups(plan))
                        {
                            var selected = axis.List("members").Cast<Dictionary<string, object>>().Single(m => AvatarConfig.Selected(axis, m, values));
                            foreach (var slot in MaterialAxes.Slots(axis, record))
                            {
                                var path = Path(clone, slot.Row, slot.Path);
                                slots.Add(new Dictionary<string, object> { ["group"] = axis.Str("id"), ["member"] = selected.Str("id"), ["binding"] = slot.Binding.Str("id"),
                                    ["renderer"] = path, ["slot"] = slot.Index, ["expected"] = VariantResolver.Identity(MaterialAxes.Expected(plan, selected, slot.Binding.Str("id"))),
                                    ["actual"] = VariantResolver.Identity(path == null ? null : Material(path, slot.Index)), ["visible"] = path != null && Visible(path) });
                            }
                        }
                        materialEvents.Add(new Dictionary<string, object> { ["event"] = e.ToDictionary(p => p.Key, p => (object)p.Value),
                            ["values"] = values.ToDictionary(p => p.Key, p => (object)p.Value), ["slots"] = slots });
                    }
                }
                if (materialEvents.Count > 0) Avh.WriteJson(System.IO.Path.Combine(Avh.RunDir, "observations", "material-axis-native-readback.json"), new Dictionary<string, object> {
                    ["schema"] = "material-axis-native-readback/0.1", ["configuration_hash"] = MenuGroups.ConfigHash(plan), ["failures"] = failures,
                    ["method"] = "AnimatorControllerPlayable incremental events, manual clock", ["events"] = materialEvents });
                notes.Add("Unity AnimatorControllerPlayable 手动时钟读回 " + steps + " 事件（不等于 VRChat 客户端）");
                return failures;
            }
            finally { if (graph.IsValid()) graph.Destroy(); UnityEngine.Object.DestroyImmediate(clone); }
        }
        public static void Regression()
        {
            SourceShapeAudit.CaptureSources(Avh.Plan(),Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)));
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(BuildStage.BuiltPrefab) ?? throw new Exception("缺少构建产物");
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                var notes = new List<string>(); var failures = Assertions(avatar, notes, true);
                var runtimeFailures = RuntimeAssertions(avatar, notes, out var runtimeSteps);
                var count = Cells(Avh.Plan()).Count;
                var sim = new AnimatorSim(avatar); var keyDelta = 0f; var keyPairs = 0; var keyUnknown = 0;
                var photos = new List<object>(); var photoFailures = 0;
                var plan = Avh.Plan(); var record = Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
                var samples = Samples(plan);
                var representatives = samples.Where(values => AvatarConfig.Groups(plan).All(g => g.Str("activation") != "exclusive"
                    || g.List("members").Cast<Dictionary<string, object>>().Any(m => Math.Abs(AvatarConfig.Value(g, m) - values[g.Obj("parameter").Str("name")]) < .00001f))).ToList();
                for (var i = 0; i < representatives.Count; i++)
                {
                    var values = representatives[i]; var snapshot = sim.Evaluate(values);
                    var measure = SourceShapeAudit.For(avatar, plan, record).Check(avatar, snapshot.Visible, snapshot.WeightAt, snapshot.Scale, notes, values);
                    keyDelta = Math.Max(keyDelta, measure.delta); keyPairs += measure.pairs; keyUnknown += measure.unknown;
                    photoFailures += AssertState(avatar, plan, record, values, snapshot.Visible, snapshot.MaterialAt, notes, snapshot.WeightAt, snapshot.Scale);
                    try
                    {
                        using(var pose=new NativePose(avatar,values))
                        {
                        photoFailures += AssertState(pose.Avatar,plan,record,values,p=>{var t=AvatarAudit.Locate(pose.Avatar.transform,p);return t!=null&&t.gameObject.activeInHierarchy&&(t.GetComponent<Renderer>()==null||t.GetComponent<Renderer>().enabled);},
                            (p,s)=>AvatarAudit.Locate(pose.Avatar.transform,p)?.GetComponent<Renderer>()?.sharedMaterials.ElementAtOrDefault(s),notes);
                        var photo = Portrait.Front(pose.Avatar, System.IO.Path.Combine(Avh.RunDir, "photos", "group_" + i + ".png"));
                        photo["avatar_state"] = values.ToDictionary(p => p.Key, p => (object)p.Value); photo["configuration_hash"] = MenuGroups.ConfigHash(plan);
                        Avh.WriteJson(System.IO.Path.Combine(Avh.RunDir, "photos", "group_" + i + ".json"), photo); photos.Add(photo);
                        }
                    }
                    finally { sim.Restore(); }
                }
                var coverage = new Dictionary<string, object> { ["schema"] = "coverage/0.2", ["configuration_hash"] = MenuGroups.ConfigHash(Avh.Plan()),
                    ["static_states"] = count, ["business_assertion_failures"] = failures, ["runtime_events"] = runtimeSteps, ["runtime_assertion_failures"] = runtimeFailures,
                    ["runtime_method"] = "Unity AnimatorControllerPlayable, manually advanced clock", ["photos"] = photos,
                    ["material_axes"] = MaterialAxes.Groups(plan).Select(g => (object)g.Str("id")).ToList(),
                    ["source_shape_value_delta_max"] = keyPairs > 0 && keyUnknown == 0 ? (object)Math.Round(keyDelta,3) : null,
                    ["source_shape_pair_count"] = keyPairs, ["source_shape_unknown_count"] = keyUnknown,
                    ["source_shape_state_complete"] = keyUnknown == 0 && failures == 0 && runtimeFailures == 0,
                    ["not_ran"] = new List<object> { "client saved/synced", "PhysBone", "VRChat Parameter Driver" } };
                Avh.WriteJson(Avh.Abs(RegressionStage.CoveragePath), coverage);
                Avh.WriteJson(System.IO.Path.Combine(Avh.RunDir, "coverage.json"), coverage);
                Avh.Observation("avatar.observe", new Dictionary<string, object> { ["t1_missing_required_states"] = failures, ["group_state_assertion_failures"] = failures,
                    ["group_state_assertions"] = failures == 0 && runtimeFailures == 0, ["shared_state_preserved"] = runtimeFailures == 0,
                    ["menu_coverage_complete"] = failures == 0 && runtimeFailures == 0 && runtimeSteps > 0 && count > 0,
                    ["missing_real_sequences"] = runtimeFailures, ["outfit_photo_named_minus_worn"] = photoFailures, ["fixed_outfit_state_failures"] = OutfitMeasure.FixedFailures(avatar, Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath)), Avh.Plan(), notes) }, notes);
                Avh.Observation("avatar.verify", new Dictionary<string, object> { ["coverage_record_present"] = true, ["source_shape_value_delta_max"] = keyPairs > 0 && keyUnknown == 0 ? (object)Math.Round(keyDelta, 3) : null,
                    ["source_shape_pair_count"] = keyPairs, ["source_shape_unknown_count"] = keyUnknown, ["source_shape_state_complete"] = keyUnknown == 0 && failures == 0 && runtimeFailures == 0, ["source_shape_applicability"] = keyUnknown > 0 ? "unknown" : keyPairs == 0 ? "no source shape declarations" : "measured source defaults, sync, Set and Delete primitives",
                    ["key_follow_geometry_p95_mm"] = null, ["perception_declaration_unresolved"] = 0 }, notes);
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }
    }
    public static class AvatarAudit
    {
        /// <summary>Run body on an NDMF-processed clone of the prefab; the clone and NDMF's temporary assets are always removed.</summary>
        public static T OnBaked<T>(string prefabPath, Func<GameObject, T> body)
        {
            var record=Avh.ReadJsonFile(Avh.Abs(OutfitStage.RecordPath));
            if(record!=null)SourceShapeAudit.CaptureSources(Avh.Plan(),record);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath) ?? throw new Exception($"加载不了 {prefabPath}");
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            var clone = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                PrefabUtility.UnpackPrefabInstance(clone, PrefabUnpackMode.Completely, InteractionMode.AutomatedAction);
                AvatarProcessor.ProcessAvatar(clone);
                if (AvatarConfig.Grouped(Avh.Plan())) MenuGroups.FinalizeReadableProperties(clone);
                return body(clone);
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(clone);
                AvatarProcessor.CleanTemporaryAssets();
            }
        }

        /// <summary>
        /// A recorded object path on a built avatar. AAO flattens intermediate objects it can drop: `_Outfit/Outfit_a` becomes
        /// a root child named `_Outfit$Outfit_a$9` (and rewrites the animations to match), so a path that no longer exists is
        /// looked up under that naming before being called missing.
        /// </summary>
        public static Transform Locate(Transform root, string path)
        {
            if (path == null) return null;
            var found = root;
            foreach (var segment in path.Split('/').Where(s => s.Length > 0))
            {
                var children = found.Cast<Transform>().Where(t => t.name == segment).ToList();
                if (children.Count != 1) { found = null; break; }
                found = children[0];
            }
            if (found != null) return found;
            var flat = System.Text.RegularExpressions.Regex.Escape(path.Replace('/', '$'));
            var pattern = new System.Text.RegularExpressions.Regex("^" + flat + @"(\$\d+)?$");
            var matches = root.GetComponentsInChildren<Transform>(true).Where(t => pattern.IsMatch(t.name)).ToList();
            return matches.Count == 1 ? matches[0] : null;
        }

        /// <summary>
        /// menu.dump on a baked avatar. ours: the parameters this order's menu drives; sources: the objects that occupy the
        /// same position (every outfit root and the body's own clothes), at most one of which may be on by default.
        /// </summary>
        public static Dictionary<string, object> MenuDump(GameObject baked, ICollection<string> ours, ICollection<string> sources, List<string> notes)
        {
            var descriptor = baked.GetComponent<VRCAvatarDescriptor>();
            var metrics = new Dictionary<string, object>();
            var menus = new List<VRCExpressionsMenu>();
            Collect(descriptor.expressionsMenu, menus);
            metrics["max_controls_per_menu"] = menus.Count == 0 ? 0 : menus.Max(m => m.controls.Count);
            var crowded = menus.Where(m => m.controls.Count > 8).Select(m => m.name).ToList();
            if (crowded.Count > 0) notes.Add("控件超过 8 个的菜单：" + string.Join(", ", crowded));

            var parameters = descriptor.expressionParameters != null ? descriptor.expressionParameters.parameters ?? new VRCExpressionParameters.Parameter[0]
                : new VRCExpressionParameters.Parameter[0];
            metrics["param_bits"] = parameters.Where(p => p.networkSynced).Sum(p => VRCExpressionParameters.TypeCost(p.valueType));
            var menuParams = new HashSet<string>(menus.SelectMany(m => m.controls).SelectMany(c =>
                new[] { c.parameter?.name }.Concat(c.subParameters?.Select(s => s?.name) ?? Enumerable.Empty<string>())).Where(n => !string.IsNullOrEmpty(n)));
            var controllers = Layers(descriptor).Select(l => l.controller).Where(c => c != null).Distinct().ToList();
            var layerParams = new HashSet<string>(controllers.SelectMany(c => c.parameters.Select(p => p.name)));
            var orphans = parameters.Where(p => !string.IsNullOrEmpty(p.name) && !menuParams.Contains(p.name) && !layerParams.Contains(p.name)).Select(p => p.name).ToList();
            metrics["params_without_menu_or_layer"] = orphans.Count;
            if (orphans.Count > 0) notes.Add("既不在菜单也不在动画层里的参数：" + string.Join(", ", orphans.Take(10)));

            metrics["unresolved_layer_controls"] = UnresolvedLayers(descriptor, notes);
            metrics["parameter_driver_multiowner_params"] = ParameterDriverMultiOwners(controllers, notes);
            metrics["clip_curve_binding_mismatches"] = BindingMismatches(baked, controllers, ours, notes);
            var menuRecord = Avh.ReadJsonFile(Avh.Abs(MenuStage.RecordPath));
            if (AvatarConfig.Grouped(Avh.Plan()))
            {
                foreach (var pair in MenuGroupAudit.Metrics(baked, notes)) metrics[pair.Key] = pair.Value;
                metrics["max_default_active_sources_per_position"] = 1;
                metrics["selector_owned_expected"] = 0; metrics["selector_owned_binding_count"] = 0; metrics["selector_owned_binding_missing"] = 0;
                metrics["motion_time_looping_clips"] = controllers.SelectMany(c => c.animationClips).Distinct().Count(c => AnimationUtility.GetAnimationClipSettings(c).loopTime && c.name.StartsWith("AVH"));
                metrics["motion_time_zero_length_clips"] = 0; metrics["motion_time_duplicate_control_samples"] = 0;
                metrics["min_menu_asset_bytes"] = null;
                return metrics;
            }
            var selectorExpected = menuRecord?.List("selector_owned_paths").Count ?? 0;
            var selectorParameter = menuRecord?.Str("resolved_parameter");
            var motionTime = MotionTimeAudit(controllers, menuRecord, ours, notes);
            metrics["motion_time_looping_clips"] = motionTime.looping;
            metrics["motion_time_zero_length_clips"] = motionTime.zeroLength;
            metrics["motion_time_duplicate_control_samples"] = motionTime.duplicates;
            var selectorBindings = SelectorBindings(baked, controllers, selectorParameter);
            metrics["selector_owned_expected"] = selectorExpected;
            metrics["selector_owned_binding_count"] = selectorBindings;
            metrics["selector_owned_binding_missing"] = Math.Max(0, selectorExpected - selectorBindings);
            if (selectorBindings < selectorExpected)
                notes.Add($"衣装轮盘应控制 {selectorExpected} 个根/BoneProxy 可视件，构建后只有 {selectorBindings} 条可解析显隐绑定");
            var active = sources.Select(path => Locate(baked.transform, path)).Where(t => t != null && t.gameObject.activeSelf && t.gameObject.tag != "EditorOnly").ToList();
            metrics["max_default_active_sources_per_position"] = active.Count;
            if (active.Count > 1) notes.Add("默认同时开着：" + string.Join(", ", active.Select(t => t.name)));
            metrics["min_menu_asset_bytes"] = null;  // 路线 A 不落菜单资产，菜单由 MA 在构建时生成
            var ourControls = menus.SelectMany(m => m.controls).Count(c => c.parameter != null && ours.Contains(c.parameter.name));
            var ourLayers = controllers.SelectMany(c => c.layers).Count(l => Driven(l, ours));
            notes.Add($"构建后：菜单 {menus.Count} 个，参数 {parameters.Length} 个（{metrics["param_bits"]} 位）；本单控件 {ourControls} 个，本单参数驱动的层 {ourLayers} 个");
            if (ourControls == 0) notes.Add("构建后的菜单里找不到本单参数的控件");
            return metrics;
        }

        static int SelectorBindings(GameObject baked, List<AnimatorController> controllers, string parameter)
        {
            if (string.IsNullOrEmpty(parameter)) return 0;
            return controllers.SelectMany(controller => controller.layers).Where(layer => Driven(layer, new[] { parameter }))
                .SelectMany(layer => States(layer.stateMachine)).SelectMany(state => Clips(state.motion)).Distinct()
                .SelectMany(clip => AnimationUtility.GetCurveBindings(clip))
                .Where(binding => binding.propertyName == "m_IsActive" && Locate(baked.transform, binding.path) != null)
                .Select(binding => binding.path).Distinct().Count();
        }

        static (int looping, int zeroLength, int duplicates) MotionTimeAudit(List<AnimatorController> controllers,
            Dictionary<string, object> menu, ICollection<string> ours, List<string> notes)
        {
            var looping = 0; var zeroLength = 0; var duplicates = 0;
            var controls = menu?.List("controls").Cast<Dictionary<string, object>>().ToList() ?? new List<Dictionary<string, object>>();
            foreach (var controller in controllers)
                foreach (var layer in controller.layers)
                    foreach (var state in States(layer.stateMachine).Where(s => s.timeParameterActive && ours.Contains(s.timeParameter)))
                    {
                        if (!(state.motion is AnimationClip clip) || clip.length <= 0)
                        {
                            zeroLength++; notes.Add($"Motion Time 状态 {controller.name}/{layer.name}/{state.name} 没有非零长度 clip"); continue;
                        }
                        if (AnimationUtility.GetAnimationClipSettings(clip).loopTime)
                        {
                            looping++; notes.Add($"Motion Time clip {clip.name} 开启循环，参数 1.0 会回绕首档");
                        }
                        var values = controls.Where(c => c.Str("control") == "RadialChoice" && c.Str("parameter") == state.timeParameter)
                            .Select(c => Convert.ToSingle(c["value"])).Distinct().OrderBy(value => value).ToList();
                        var seen = new Dictionary<string, float>();
                        foreach (var value in values)
                        {
                            var sampleTime = Mathf.Clamp01(value) * clip.length;
                            var signature = string.Join(";", AnimationUtility.GetCurveBindings(clip).OrderBy(b => b.path).ThenBy(b => b.propertyName)
                                .Select(binding => $"{binding.path}|{binding.type.FullName}|{binding.propertyName}={AnimationUtility.GetEditorCurve(clip, binding).Evaluate(sampleTime):R}"));
                            if (seen.TryGetValue(signature, out var previous))
                            {
                                duplicates++; notes.Add($"Motion Time {state.timeParameter} 的菜单档 {previous:R} 与 {value:R} 采样结果完全相同");
                            }
                            else seen[signature] = value;
                        }
                    }
            return (looping, zeroLength, duplicates);
        }

        /// <summary>
        /// Parameter Driver writes are event ordered, unlike animation curves. Multiple states inside one layer are one
        /// state-machine owner; two layers/controllers writing the same destination are unstable when their entry order changes.
        /// </summary>
        static int ParameterDriverMultiOwners(List<AnimatorController> controllers, List<string> notes)
        {
            var owners = new Dictionary<string, HashSet<string>>();
            foreach (var controller in controllers)
                foreach (var layer in controller.layers)
                    foreach (var state in States(layer.stateMachine))
                        foreach (var driver in state.behaviours.OfType<VRCAvatarParameterDriver>())
                            foreach (var change in driver.parameters)
                            {
                                // In the SDK data model `name` is the destination for Set/Add/Random and Copy; Copy's `source`
                                // is only the input parameter.
                                var destination = change.name;
                                if (string.IsNullOrEmpty(destination)) continue;
                                if (!owners.TryGetValue(destination, out var found)) owners[destination] = found = new HashSet<string>();
                                found.Add($"{controller.name}/{layer.name}");
                            }
            var conflicts = owners.Where(entry => entry.Value.Count > 1).ToList();
            foreach (var conflict in conflicts.Take(8))
                notes.Add($"参数 {conflict.Key} 被多个 Driver 层写入：{string.Join("、", conflict.Value)}；结果取决于状态进入顺序");
            return conflicts.Count;
        }

        static void Collect(VRCExpressionsMenu menu, List<VRCExpressionsMenu> found)
        {
            if (menu == null || found.Contains(menu)) return;
            found.Add(menu);
            foreach (var control in menu.controls)
                if (control.type == VRCExpressionsMenu.Control.ControlType.SubMenu) Collect(control.subMenu, found);
        }

        public static IEnumerable<(VRCAvatarDescriptor.AnimLayerType type, AnimatorController controller)> Layers(VRCAvatarDescriptor descriptor) =>
            descriptor.baseAnimationLayers.Concat(descriptor.specialAnimationLayers)
                .Where(l => !l.isDefault && l.animatorController is AnimatorController).Select(l => (l.type, (AnimatorController)l.animatorController));

        /// <summary>SOP 60：层默认权重为 0、又没有任何 Layer Control 把它抬起来的层，开关在菜单上但游戏里没反应。</summary>
        static int UnresolvedLayers(VRCAvatarDescriptor descriptor, List<string> notes)
        {
            var raised = new HashSet<(VRC_AnimatorLayerControl.BlendableLayer, int)>();
            foreach (var (_, controller) in Layers(descriptor))
                foreach (var behaviour in controller.layers.SelectMany(l => States(l.stateMachine)).SelectMany(s => s.behaviours))
                    if (behaviour is VRC_AnimatorLayerControl control && control.goalWeight > 0) raised.Add((control.playable, control.layer));
            var count = 0;
            foreach (var (type, controller) in Layers(descriptor))
            {
                if (!Enum.TryParse<VRC_AnimatorLayerControl.BlendableLayer>(type.ToString(), out var playable)) continue;
                for (var i = 1; i < controller.layers.Length; i++)
                {
                    if (controller.layers[i].defaultWeight > 0 || raised.Contains((playable, i))) continue;
                    if (!States(controller.layers[i].stateMachine).Any(s => s.motion != null)) continue;  // 空层没有东西要播
                    count++;
                    if (count <= 5) notes.Add($"{type} 层 {controller.layers[i].name} 默认权重 0 且无人抬权");
                }
            }
            return count;
        }

        /// <summary>Curves in the layers our parameters drive whose target path does not exist on the baked avatar.</summary>
        static int BindingMismatches(GameObject baked, List<AnimatorController> controllers, ICollection<string> ours, List<string> notes)
        {
            var count = 0;
            foreach (var controller in controllers)
                foreach (var layer in controller.layers)
                {
                    if (!Driven(layer, ours)) continue;
                    var states = States(layer.stateMachine).ToList();
                    foreach (var clip in states.SelectMany(s => Clips(s.motion)).Distinct())
                        foreach (var binding in AnimationUtility.GetCurveBindings(clip).Concat(AnimationUtility.GetObjectReferenceCurveBindings(clip)))
                        {
                            if (binding.path.Length == 0 || baked.transform.Find(binding.path) != null) continue;
                            count++;
                            if (count <= 5) notes.Add($"{layer.name}/{clip.name}：路径 {binding.path} 不存在");
                        }
                }
            return count;
        }

        /// <summary>
        /// SOP 60「死锁格」：遍历本单参数的全部取值，用构建后控制器里真实的层（入口转移、退出转移、状态上的 m_IsActive 曲线）
        /// 静态求出每一格哪些来源开着，数「这个位置一件都没开」的格。素体自带、标了 EditorOnly 的来源构建时就没了，永远算关。
        /// domains：参数名 → 取值集合。
        /// </summary>
        public static int Deadlocks(GameObject baked, Dictionary<string, float[]> domains, ICollection<string> sources, List<string> notes)
        {
            var descriptor = baked.GetComponent<VRCAvatarDescriptor>();
            var controllers = Layers(descriptor).Select(l => l.controller).Distinct().ToList();
            var names = domains.Keys.ToList();
            var cells = new List<Dictionary<string, float>> { new Dictionary<string, float>() };
            foreach (var name in names)
                cells = cells.SelectMany(cell => domains[name].Select(v => new Dictionary<string, float>(cell) { [name] = v })).ToList();
            var deadlocks = 0;
            var located = sources.Select(path => Locate(baked.transform, path)).Where(t => t != null).Distinct().ToList();
            if (located.Count < sources.Count) notes.Add($"构建后找不到的来源 {sources.Count - located.Count} 个（按 AAO 的 $ 命名也没找到）");
            // The question is per declared position ("is nothing on here?"). A record that declares nothing at all —
            // the vendor-menu preserve route / empty selector, whose menu.json carries empty parameters/controls/
            // conflicts — leaves this question empty: one empty combination over an empty source list is not a
            // deadlock. Both halves are required: a record that declares sources but no parameter domain still has
            // objects this audit must account for, and an empty `active` set counts every cell, so it keeps failing.
            if (domains.Count == 0 && sources.Count == 0) { notes.Add("没有声明任何需要审计的部位与来源；死锁格不适用，计 0"); return 0; }
            foreach (var cell in cells)
            {
                var active = located.ToDictionary(t => t, t => t.gameObject.activeSelf && t.gameObject.tag != "EditorOnly");
                foreach (var controller in controllers)
                {
                    var defaults = controller.parameters.ToDictionary(p => p.name, p => p.type == AnimatorControllerParameterType.Bool ? (p.defaultBool ? 1f : 0f)
                        : p.type == AnimatorControllerParameterType.Int ? p.defaultInt : p.defaultFloat);
                    foreach (var (k, v) in cell) defaults[k] = v;
                    foreach (var layer in controller.layers.Where(l => Driven(l, names)))
                    {
                        var state = Settle(layer.stateMachine, defaults);
                        if (!(state?.motion is AnimationClip clip)) continue;
                        var sampleTime = state.timeParameterActive && !string.IsNullOrEmpty(state.timeParameter)
                            ? Math.Max(0, Math.Min(1, defaults.TryGetValue(state.timeParameter, out var time) ? time : 0)) * clip.length : 0;
                        foreach (var binding in AnimationUtility.GetCurveBindings(clip))
                        {
                            if (binding.propertyName != "m_IsActive") continue;
                            var target = binding.path.Length == 0 ? baked.transform : baked.transform.Find(binding.path);
                            if (target == null || !active.ContainsKey(target) || target.gameObject.tag == "EditorOnly") continue;
                            active[target] = AnimationUtility.GetEditorCurve(clip, binding).Evaluate(sampleTime) > 0.5f;
                        }
                    }
                }
                if (active.Values.Any(on => on)) continue;
                deadlocks++;
                if (deadlocks <= 5) notes.Add("死锁格：" + string.Join(", ", cell.Select(kv => $"{kv.Key}={kv.Value}")));
            }
            notes.Add($"遍历 {cells.Count} 格，死锁 {deadlocks} 格");
            return deadlocks;
        }

        /// <summary>The state a layer rests in for fixed parameter values: entry transitions, then any-state and exit transitions.</summary>
        static AnimatorState Settle(AnimatorStateMachine machine, Dictionary<string, float> values)
        {
            bool Holds(AnimatorTransitionBase t) => t.conditions.All(c =>
            {
                var v = values.TryGetValue(c.parameter, out var x) ? x : 0f;
                switch (c.mode)
                {
                    case AnimatorConditionMode.If: return v != 0;
                    case AnimatorConditionMode.IfNot: return v == 0;
                    case AnimatorConditionMode.Greater: return v > c.threshold;
                    case AnimatorConditionMode.Less: return v < c.threshold;
                    case AnimatorConditionMode.Equals: return Math.Abs(v - c.threshold) < 1e-4;
                    case AnimatorConditionMode.NotEqual: return Math.Abs(v - c.threshold) >= 1e-4;
                    default: return false;
                }
            });
            AnimatorState Enter() => machine.entryTransitions.FirstOrDefault(Holds)?.destinationState ?? machine.defaultState;
            var state = Enter();
            for (var step = 0; step < 16 && state != null; step++)
            {
                var any = machine.anyStateTransitions.FirstOrDefault(t => Holds(t) && t.destinationState != null && t.destinationState != state);
                if (any != null) { state = any.destinationState; continue; }
                var next = state.transitions.FirstOrDefault(t => t.conditions.Length > 0 && Holds(t));
                if (next == null) break;
                var target = next.isExit ? Enter() : next.destinationState;
                if (target == null || target == state) break;
                state = target;
            }
            return state;
        }

        /// <summary>A layer whose transitions or blend trees read one of the given parameters.</summary>
        static bool Driven(AnimatorControllerLayer layer, ICollection<string> parameters)
        {
            var states = States(layer.stateMachine).ToList();
            return layer.stateMachine.anyStateTransitions.Concat(states.SelectMany(s => s.transitions))
                       .Concat(layer.stateMachine.entryTransitions.Cast<AnimatorTransitionBase>())
                       .Any(t => t.conditions.Any(c => parameters.Contains(c.parameter)))
                   || states.Any(s => Trees(s.motion).Any(tree => parameters.Contains(tree.blendParameter) || parameters.Contains(tree.blendParameterY)
                       || tree.children.Any(child => parameters.Contains(child.directBlendParameter)))
                       || (s.timeParameterActive && parameters.Contains(s.timeParameter))
                       || (s.speedParameterActive && parameters.Contains(s.speedParameter))
                       || (s.mirrorParameterActive && parameters.Contains(s.mirrorParameter))
                       || (s.cycleOffsetParameterActive && parameters.Contains(s.cycleOffsetParameter)));
        }

        static IEnumerable<BlendTree> Trees(Motion motion)
        {
            if (!(motion is BlendTree tree)) yield break;
            yield return tree;
            foreach (var child in tree.children)
                foreach (var inner in Trees(child.motion)) yield return inner;
        }

        public static IEnumerable<AnimatorState> States(AnimatorStateMachine machine) =>
            machine.states.Select(s => s.state).Concat(machine.stateMachines.SelectMany(m => States(m.stateMachine)));

        public static IEnumerable<AnimationClip> Clips(Motion motion)
        {
            if (motion is AnimationClip clip) yield return clip;
            else if (motion is BlendTree tree)
                foreach (var child in tree.children)
                    foreach (var inner in Clips(child.motion)) yield return inner;
        }
    }
}
