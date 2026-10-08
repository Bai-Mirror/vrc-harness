// SDK-declared blink controls and source-derived contact coverage. No AI-selected vertex pairs.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEngine;
using UnityEditor;
namespace AVH.Harness
{
    public static class FaceEyes
    {
        // Independent Unity implementation: measured imported source triangles,
        // actual eye bone bindings, projected area and ray/triangle visibility.
        public sealed class ExposureProfile
        {
            sealed class Region { public string side; public Vector3 center; public int[][] samples, skin; public double[] areas; public double open; }
            readonly Vector3[] source; readonly Vector3 forward,right,up; readonly Matrix4x4 world;
            readonly List<Region> regions=new List<Region>(); readonly Dictionary<string,object> recipe;
            public ExposureProfile(SkinnedMeshRenderer renderer, Dictionary<string,object> frozen, Dictionary<string,object> nativeSourceMesh=null)
            {
                recipe=frozen;world=renderer.transform.localToWorldMatrix;source=renderer.sharedMesh.vertices.Select(world.MultiplyPoint3x4).ToArray();
                forward=renderer.transform.root.forward;right=renderer.transform.root.right;up=renderer.transform.root.up;
                var specs=frozen.List("regions").Cast<Dictionary<string,object>>().ToArray();var mesh=renderer.sharedMesh;var weights=mesh.boneWeights;
                var boneIds=specs.Select(s=>Array.FindIndex(renderer.bones,b=>b!=null&&b.name==s.Str("bone"))).ToArray();
                if(boneIds.Any(i=>i<0))throw new InvalidOperationException("Source eye bone binding is missing");
                Func<int,int,float> share=(v,b)=>{var w=weights[v];var total=w.weight0+w.weight1+w.weight2+w.weight3;var value=(w.boneIndex0==b?w.weight0:0)+(w.boneIndex1==b?w.weight1:0)+(w.boneIndex2==b?w.weight2:0)+(w.boneIndex3==b?w.weight3:0);return total>0?value/total:0;};
                // Native surfaces were selected from evaluated source motion.
                // Imported influence remapping must not silently reselect them.
                var motion=nativeSourceMesh==null?boneIds.ToDictionary(b=>b,b=>BoneMotion(renderer,renderer.bones[b])):null;
                var peak=nativeSourceMesh==null?boneIds.ToDictionary(b=>b,b=>Enumerable.Range(0,source.Length).Max(v=>share(v,b))):null;
                Func<int,int,bool> weighted=(v,b)=>share(v,b)>0&&share(v,b)>=peak[b]*.5f&&motion[b][v]>1e-7f;
                for(var eye=0;eye<specs.Length;eye++)
                {
                    if(nativeSourceMesh!=null)
                    {
                        var mapped=new Region{side=specs[eye].Str("side"),center=renderer.bones[boneIds[eye]].position,
                            samples=NativeFaces(renderer,nativeSourceMesh,specs[eye],"samplePolygons"),skin=NativeFaces(renderer,nativeSourceMesh,specs[eye],"occluderPolygons")};
                        mapped.areas=mapped.samples.Select(f=>Area(source,f)).ToArray();mapped.open=Exposure(source,mapped);
                        if(mapped.open<.05)throw new InvalidOperationException("Unity mapped source eye open control is not visible");regions.Add(mapped);continue;
                    }
                    var islands=new List<(double area,double front,int material,int[][] faces)>();
                    for(var sub=0;sub<mesh.subMeshCount;sub++)
                    {
                        var flat=mesh.GetTriangles(sub);var faces=Enumerable.Range(0,flat.Length/3).Select(i=>new[]{flat[i*3],flat[i*3+1],flat[i*3+2]}).Where(f=>f.All(v=>weighted(v,boneIds[eye]))).ToArray();
                        var uses=new Dictionary<int,List<int>>();for(var i=0;i<faces.Length;i++)foreach(var v in faces[i]){if(!uses.TryGetValue(v,out var list))uses[v]=list=new List<int>();list.Add(i);}
                        var remaining=new HashSet<int>(Enumerable.Range(0,faces.Length));
                        while(remaining.Count>0){var queue=new List<int>{remaining.Min()};remaining.Remove(queue[0]);for(var j=0;j<queue.Count;j++)foreach(var v in faces[queue[j]])foreach(var other in uses[v])if(remaining.Remove(other))queue.Add(other);
                            var selected=queue.Select(i=>faces[i]).ToArray();var vertices=selected.SelectMany(f=>f).Distinct().ToArray();
                            islands.Add((selected.Sum(f=>Area(source,f)),vertices.Average(v=>(double)Vector3.Dot(source[v],forward)),sub,selected));}
                    }
                    if(islands.Count==0)throw new InvalidOperationException("No independently measurable Unity eye surface");
                    var max=islands.Max(i=>i.area);var chosen=islands.Where(i=>i.area>=max*.99).OrderByDescending(i=>i.front).First();var all=mesh.GetTriangles(chosen.material);
                    var region=new Region{side=specs[eye].Str("side"),center=renderer.bones[boneIds[eye]].position,samples=chosen.faces,
                        skin=Enumerable.Range(0,all.Length/3).Select(i=>new[]{all[3*i],all[3*i+1],all[3*i+2]}).Where(f=>!f.Any(v=>boneIds.Any(b=>weighted(v,b)))).ToArray()};
                    region.areas=region.samples.Select(f=>Area(source,f)).ToArray();region.open=Exposure(source,region);
                    if(region.open<.05)throw new InvalidOperationException("Unity eye open control is not visible");regions.Add(region);
                }
                if(regions.Count==2){var blink=mesh.GetBlendShapeIndex(frozen.Str("blinkKey"));if(blink<0)throw new InvalidOperationException("Observed SDK blink is missing");var delta=new Vector3[source.Length];var scratch=new Vector3[source.Length];mesh.GetBlendShapeFrameVertices(blink,0,delta,scratch,scratch);var closed=source.Select((p,i)=>p+world.MultiplyVector(delta[i])).ToArray();if(regions.Any(r=>Exposure(closed,r)>=r.open*.5))throw new InvalidOperationException("Unity source blink does not occlude its open control");}
            }
            static float[] BoneMotion(SkinnedMeshRenderer renderer,Transform bone)
            {
                var saved=bone.localRotation;var baseline=Pose(renderer,-1,0);var result=new float[baseline.Length];
                try { foreach(var axis in new[]{Vector3.right,Vector3.up,Vector3.forward}) {bone.localRotation=saved*Quaternion.AngleAxis(.12f*Mathf.Rad2Deg,axis);var current=Pose(renderer,-1,0);if(current.Length!=result.Length)throw new InvalidOperationException("Eye motion vertex correspondence changed");for(var i=0;i<result.Length;i++)result[i]=Math.Max(result[i],(current[i]-baseline[i]).magnitude);} }
                finally {bone.localRotation=saved;}
                return result;
            }
            static float UvTolerance(SkinnedMeshRenderer renderer,int material)
            {
                var materials=renderer.sharedMaterials;
                if(material<0||material>=materials.Length||materials[material]==null)return 1e-6f;
                var mat=materials[material];var size=mat.GetTexturePropertyNames().Select(n=>mat.GetTexture(n)).Where(t=>t!=null).Select(t=>Math.Max(t.width,t.height)).DefaultIfEmpty(0).Max();
                // No texture evidence means no precision-based relaxation.
                return size>0?.25f/size:1e-6f;
            }
            static int[][] NativeFaces(SkinnedMeshRenderer renderer,Dictionary<string,object> catalog,Dictionary<string,object> region,string field)
            {
                // Unity can merge/reassign skin influences while importing the
                // same FBX. Bind the frozen authored surface by actual imported
                // position AND UV corners instead of selecting a new eye island.
                const float tolerance=1e-6f;var mesh=renderer.sharedMesh;var vertices=mesh.vertices;var uv=mesh.uv;var material=Convert.ToInt32(region["material"]);var uvTolerance=UvTolerance(renderer,material);
                if(uv.Length!=vertices.Length)throw new InvalidOperationException("Native eye surface lacks imported UV identity");
                var points=catalog.List("vertices").Select(v=>((System.Collections.IEnumerable)v).Cast<object>().Select(Convert.ToSingle).ToArray()).ToArray();
                var polygons=catalog.List("polygons").Cast<Dictionary<string,object>>().ToArray();var wanted=new HashSet<int>(region.List(field).Select(Convert.ToInt32));
                var grid=new Dictionary<(int,int,int),List<(int polygon,int corner,Vector3 position,Vector2 uv)>>();
                Func<Vector3,(int,int,int)> cell=p=>((int)Math.Floor(p.x/tolerance),(int)Math.Floor(p.y/tolerance),(int)Math.Floor(p.z/tolerance));
                foreach(var id in wanted)if(id<0||id>=polygons.Length||Convert.ToInt32(polygons[id]["material"])!=material)throw new InvalidOperationException("Native source eye polygon identity changed");
                // Include competing authored faces, even outside the eye region.
                // Adjacent faces sharing a corner are resolved by all three
                // corners and polygon topology, never by nearest UV alone.
                foreach(var id in Enumerable.Range(0,polygons.Length).Where(i=>Convert.ToInt32(polygons[i]["material"])==material)){
                    var poly=polygons[id];var ids=poly.List("vertices").Select(Convert.ToInt32).ToArray();var layers=poly.Obj("uv");if(layers==null||layers.Count==0)throw new InvalidOperationException("Native source eye UV identity missing");var corners=((System.Collections.IEnumerable)layers.First().Value).Cast<object>().Select(v=>((System.Collections.IEnumerable)v).Cast<object>().Select(Convert.ToSingle).ToArray()).ToArray();
                    if(corners.Length!=ids.Length)throw new InvalidOperationException("Native eye corner count differs");for(var c=0;c<ids.Length;c++){var p=points[ids[c]];var position=new Vector3(-p[0],p[1],p[2]);var key=cell(position);if(!grid.TryGetValue(key,out var list))grid[key]=list=new List<(int,int,Vector3,Vector2)>();list.Add((id,c,position,new Vector2(corners[c][0],corners[c][1])));}}
                var memberships=new List<(int polygon,int corner,double distance)>[vertices.Length];for(var v=0;v<vertices.Length;v++){var key=cell(vertices[v]);var matches=new List<(int,int,double)>();for(var x=-1;x<=1;x++)for(var y=-1;y<=1;y++)for(var z=-1;z<=1;z++)if(grid.TryGetValue((key.Item1+x,key.Item2+y,key.Item3+z),out var corners))foreach(var corner in corners){var distance=(uv[v]-corner.uv).magnitude;var positionDistance=(vertices[v]-corner.position).magnitude;if(positionDistance<=tolerance&&distance<=uvTolerance)matches.Add((corner.polygon,corner.corner,Math.Sqrt(Math.Pow(distance/uvTolerance,2)+Math.Pow(positionDistance/tolerance,2))));}memberships[v]=matches;}
                var flat=mesh.GetTriangles(material);var options=new Dictionary<int,List<CornerTriangle>>();
                for(var i=0;i<flat.Length;i+=3)
                    foreach(var a in memberships[flat[i]])foreach(var b in memberships[flat[i+1]].Where(c=>c.polygon==a.polygon&&c.corner!=a.corner))foreach(var c in memberships[flat[i+2]].Where(c=>c.polygon==a.polygon&&c.corner!=a.corner&&c.corner!=b.corner)) {
                        var corners=new[]{a.corner,b.corner,c.corner};var count=polygons[a.polygon].List("vertices").Count;
                        var turn=Enumerable.Range(0,3).Sum(j=>(corners[(j+1)%3]-corners[j]+count)%count);
                        // Native Blender -> Unity handedness reverses winding.
                        if(turn!=2*count)continue;
                        if(!options.TryGetValue(a.polygon,out var list))options[a.polygon]=list=new List<CornerTriangle>();
                        list.Add(new CornerTriangle{triangle=i/3,corners=corners,score=a.distance*a.distance+b.distance*b.distance+c.distance*c.distance});
                    }
                var bundles=new Dictionary<int,List<SurfaceBundle>>();
                foreach(var pair in options) {
                    var poly=polygons[pair.Key];var ids=poly.List("vertices").Select(Convert.ToInt32).ToArray();var count=ids.Length;
                    var layer=poly.Obj("uv").First().Value;var corners=((System.Collections.IEnumerable)layer).Cast<object>().Select(v=>((System.Collections.IEnumerable)v).Cast<object>().Select(Convert.ToSingle).ToArray()).ToArray();
                    // Source import can omit a zero-area triangle at an EXACT
                    // zero-length authored edge. A virtual corner triangle
                    // accounts for that edge in topology only; it never adds
                    // an eye ray or permits a nonzero source edge to disappear.
                    var virtualId=-1;
                    for(var a=0;a<count;a++)for(var b=a+1;b<count;b++)for(var c=b+1;c<count;c++) {
                        var cs=new[]{a,b,c};var collapsed=false;
                        for(var x=0;x<3;x++)for(var y=x+1;y<3;y++){var u=cs[x];var v=cs[y];if((v-u==1||u==0&&v==count-1)&&points[ids[u]].SequenceEqual(points[ids[v]])&&new Vector2(corners[u][0]-corners[v][0],corners[u][1]-corners[v][1]).magnitude<=uvTolerance)collapsed=true;}
                        if(collapsed)pair.Value.Add(new CornerTriangle{triangle=virtualId--,corners=new[]{c,b,a},score=0});
                    }
                    var found=PolygonBundles(pair.Value,count);if(found.Count>0)bundles[pair.Key]=found;
                }
                var owners=PartitionSurfaces(bundles,wanted);
                var measured=new HashSet<int>(owners.Values);if(!wanted.IsSubsetOf(measured))throw new InvalidOperationException("Native eye source position/UV surface coverage is incomplete (polygon topology)");
                return owners.Where(p=>wanted.Contains(p.Value)).OrderBy(p=>p.Key).Select(p=>new[]{flat[p.Key*3],flat[p.Key*3+1],flat[p.Key*3+2]}).ToArray();
            }
            sealed class CornerTriangle { public int triangle;public int[] corners;public double score; }
            sealed class SurfaceBundle { public HashSet<int> triangles;public double score; }
            static List<SurfaceBundle> PolygonBundles(List<CornerTriangle> options,int count)
            {
                var result=new Dictionary<string,SurfaceBundle>();var chosen=new List<CornerTriangle>();var used=new HashSet<int>();var edges=new Dictionary<(int,int),int>();
                bool Boundary((int,int) e)=>e.Item2-e.Item1==1||e==(0,count-1);
                void Search(int start) {
                    if(chosen.Count==count-2) {
                        if(Enumerable.Range(0,count).Any(c=>!edges.TryGetValue((Math.Min(c,(c+1)%count),Math.Max(c,(c+1)%count)),out var n)||n!=1)||edges.Any(e=>e.Value!=(Boundary(e.Key)?1:2)))return;
                        var triangles=new HashSet<int>(used.Where(t=>t>=0));var key=string.Join(",",triangles.OrderBy(t=>t));var score=chosen.Sum(t=>t.score);
                        if(!result.TryGetValue(key,out var prior)||score<prior.score)result[key]=new SurfaceBundle{triangles=triangles,score=score};return;
                    }
                    for(var i=start;i<options.Count;i++) {
                        var option=options[i];if(!used.Add(option.triangle))continue;var added=new List<(int,int)>();var fits=true;
                        for(var j=0;j<3;j++){var a=option.corners[j];var b=option.corners[(j+1)%3];var edge=(Math.Min(a,b),Math.Max(a,b));var n=edges.TryGetValue(edge,out var old)?old+1:1;edges[edge]=n;added.Add(edge);if(n>(Boundary(edge)?1:2))fits=false;}
                        if(fits){chosen.Add(option);Search(i+1);chosen.RemoveAt(chosen.Count-1);}
                        foreach(var edge in added){if(--edges[edge]==0)edges.Remove(edge);}used.Remove(option.triangle);
                    }
                }
                Search(0);return result.Values.ToList();
            }
            static Dictionary<int,int> PartitionSurfaces(Dictionary<int,List<SurfaceBundle>> bundles,HashSet<int> wanted)
            {
                var uses=new Dictionary<int,HashSet<int>>();foreach(var pair in bundles)foreach(var bundle in pair.Value)foreach(var triangle in bundle.triangles){if(!uses.TryGetValue(triangle,out var ids))uses[triangle]=ids=new HashSet<int>();ids.Add(pair.Key);}
                var remaining=new HashSet<int>(bundles.Keys);var result=new Dictionary<int,int>();
                while(remaining.Count>0) {
                    var first=remaining.First();remaining.Remove(first);var component=new List<int>{first};
                    for(var i=0;i<component.Count;i++)foreach(var bundle in bundles[component[i]])foreach(var triangle in bundle.triangles)foreach(var other in uses[triangle])if(remaining.Remove(other))component.Add(other);
                    var required=new HashSet<int>(component.SelectMany(p=>bundles[p]).SelectMany(b=>b.triangles));var order=component.OrderBy(p=>bundles[p].Count).ToArray();
                    var used=new HashSet<int>();var chosen=new Dictionary<int,SurfaceBundle>();Dictionary<int,SurfaceBundle> best=null;double bestScore=double.PositiveInfinity,nextScore=double.PositiveInfinity;
                    void Search(int at,double score) {
                        if(score>nextScore)return;
                        if(at==order.Length){if(!used.SetEquals(required))return;if(score<bestScore){nextScore=bestScore;bestScore=score;best=new Dictionary<int,SurfaceBundle>(chosen);}else nextScore=Math.Min(nextScore,score);return;}
                        var polygon=order[at];foreach(var bundle in bundles[polygon].OrderBy(b=>b.score)){if(bundle.triangles.Overlaps(used))continue;used.UnionWith(bundle.triangles);chosen[polygon]=bundle;Search(at+1,score+bundle.score);used.ExceptWith(bundle.triangles);chosen.Remove(polygon);}
                    }
                    Search(0,0);
                    if(component.Any(wanted.Contains)&&(best==null||Math.Sqrt(nextScore)<=2*Math.Sqrt(bestScore)+1e-7))throw new InvalidOperationException("Native eye source UV correspondence is ambiguous or incomplete (polygon topology)");
                    if(best!=null)foreach(var pair in best)foreach(var triangle in pair.Value.triangles)result[triangle]=pair.Key;
                }
                return result;
            }
            double Area(Vector3[] points,int[] f)=>Math.Abs(Vector3.Dot(Vector3.Cross(points[f[1]]-points[f[0]],points[f[2]]-points[f[0]]),forward))*.5;
            double Exposure(Vector3[] points,Region region)
            {
                const double cell=.005;var grid=new Dictionary<(int,int),List<int[]>>();
                foreach(var face in region.skin){var xs=face.Select(i=>(double)Vector3.Dot(points[i],right)).ToArray();var ys=face.Select(i=>(double)Vector3.Dot(points[i],up)).ToArray();
                    for(var x=(int)Math.Floor(xs.Min()/cell);x<=Math.Floor(xs.Max()/cell);x++)for(var y=(int)Math.Floor(ys.Min()/cell);y<=Math.Floor(ys.Max()/cell);y++){if(!grid.TryGetValue((x,y),out var list))grid[(x,y)]=list=new List<int[]>();list.Add(face);}}
                double visible=0,total=region.areas.Sum();for(var sample=0;sample<region.samples.Length;sample++){
                    var f=region.samples[sample];var origin=(points[f[0]]+points[f[1]]+points[f[2]])/3+forward*1e-7f;var blocked=false;
                    if(grid.TryGetValue(((int)Math.Floor(Vector3.Dot(origin,right)/cell),(int)Math.Floor(Vector3.Dot(origin,up)/cell)),out var faces))foreach(var face in faces){
                        var a=points[face[0]];var e1=points[face[1]]-a;var e2=points[face[2]]-a;var p=Vector3.Cross(forward,e2);var det=(double)Vector3.Dot(e1,p);if(Math.Abs(det)<1e-14)continue;
                        var t=origin-a;var u=Vector3.Dot(t,p)/det;if(u<0||u>1)continue;var q=Vector3.Cross(t,e1);var v=Vector3.Dot(forward,q)/det;if(v<0||u+v>1)continue;var distance=Vector3.Dot(e2,q)/det;if(distance>=0&&distance<=1){blocked=true;break;}}
                    if(!blocked)visible+=region.areas[sample];}if(total<=1e-12)throw new InvalidOperationException("Degenerate eye sampling surface");return visible/total;
            }
            public Vector3[] Compensate(string name,Vector3[] basis,Vector3[] delta)
            {
                var eligible=recipe.List("expressionKeys").Contains(name)&&!recipe.List("mouthKeys").Contains(name);var endpoint=source.Select((p,i)=>p+world.MultiplyVector(delta[i])).ToArray();
                var coefficients=regions.Select(r=>eligible?Math.Max(0,Math.Min(1,1-Exposure(endpoint,r)/r.open)):0).ToArray();var result=new Vector3[delta.Length];
                var inner=Convert.ToDouble(recipe["maskInnerMeters"]);var outer=Convert.ToDouble(recipe["maskOuterMeters"]);
                for(var i=0;i<delta.Length;i++){double factor=0;for(var e=0;e<regions.Count;e++){var offset=source[i]-regions[e].center;var distance=(offset-forward*Vector3.Dot(offset,forward)).magnitude;var t=Math.Max(0,Math.Min(1,(distance-inner)/(outer-inner)));factor+=coefficients[e]*(1-t*t*(3-2*t));}
                    result[i]=delta[i]-(basis[i]-world.inverse.MultiplyPoint3x4(source[i]))*(float)factor;}return result;
            }
            public Dictionary<string,object> Verify(SkinnedMeshRenderer original,SkinnedMeshRenderer candidate)
            {
                if(regions.Count!=2)return Unsupported("No observed source eye surface profile");var readings=new List<object>();var passed=true;var mesh=original.sharedMesh;var basis=candidate.sharedMesh.vertices.Select(candidate.transform.TransformPoint).ToArray();
                foreach(var value in recipe.List("expressionKeys")){var name=Convert.ToString(value);if(recipe.List("mouthKeys").Contains(name))continue;var key=mesh.GetBlendShapeIndex(name);var other=candidate.sharedMesh.GetBlendShapeIndex(name);if(key<0||other<0)throw new InvalidOperationException("Eye expression identity changed");
                    var old=new Vector3[source.Length];var current=new Vector3[source.Length];var scratch=new Vector3[source.Length];mesh.GetBlendShapeFrameVertices(key,0,old,scratch,scratch);candidate.sharedMesh.GetBlendShapeFrameVertices(other,0,current,scratch,scratch);
                    foreach(var region in regions){var full=Exposure(source.Select((p,i)=>p+world.MultiplyVector(old[i])).ToArray(),region);if(full>=region.open-1e-9&&name!=recipe.Str("blinkKey"))continue;
                        foreach(var weight in new[]{0f,.5f,.6f,.7f,.8f,.9f,1f}){var before=Exposure(source.Select((p,i)=>p+world.MultiplyVector(old[i])*weight).ToArray(),region);var after=Exposure(basis.Select((p,i)=>p+candidate.transform.TransformVector(current[i])*weight).ToArray(),region);var ok=weight!=1||after-before<=.001+1e-9;passed&=ok;readings.Add(D("side",region.side,"key",name,"weight",weight,"originalExposure",before,"candidateExposure",after,"withinReferenceIncrease",ok));}}}
                return D("schema","face-eye-exposure/0.1","status",passed?"technical_controls_passed":"needs_visual_review","complete",true,"withinReferenceIncrease",passed,"readings",readings,"fullWeightReferenceIncrease",.001,"productionAccepted",false,"limitations",new[]{"Fixed imported source triangles and source-area weighted centroid rays; transparent texture alpha is not sampled","Intermediate states and final appearance require user review"});
            }
        }
        static Dictionary<string,object> D(params object[] values) { var d=new Dictionary<string,object>();for(var i=0;i<values.Length;i+=2)d[(string)values[i]]=values[i+1];return d; }
        static object Member(object o,string name) { if(o==null)return null;var t=o.GetType();return t.GetField(name,BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance)?.GetValue(o)??t.GetProperty(name,BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance)?.GetValue(o); }
        static string PathOf(Transform t,Transform root)=>AnimationUtility.CalculateTransformPath(t,root);
        static object Vec(Vector3 v)=>new object[]{v.x,v.y,v.z};
        static Dictionary<string,object> Unsupported(string reason)=>D("schema","face-eye-observation/0.1","status","unsupported","reason",reason,"complete",false);
        static Vector3[] Pose(SkinnedMeshRenderer renderer,int blink,float amount)
        {
            var mesh=renderer.sharedMesh;var weights=Enumerable.Range(0,mesh.blendShapeCount).Select(renderer.GetBlendShapeWeight).ToArray();var baked=new Mesh();
            try { for(var i=0;i<weights.Length;i++)renderer.SetBlendShapeWeight(i,i==blink?amount:0);renderer.BakeMesh(baked,true);return baked.vertices.Select(renderer.transform.TransformPoint).ToArray(); }
            finally { for(var i=0;i<weights.Length;i++)renderer.SetBlendShapeWeight(i,weights[i]);UnityEngine.Object.DestroyImmediate(baked); }
        }
        public static Dictionary<string,object> Observe(GameObject avatar,SkinnedMeshRenderer renderer,string meshSha256)
        {
            if(!renderer.sharedMesh.isReadable)return Unsupported("Source mesh is not readable; use managed source preparation before eye observation");
            var candidates=avatar.GetComponentsInChildren<Component>(true).Where(c=>c!=null&&c.GetType().FullName=="VRC.SDK3.Avatars.Components.VRCAvatarDescriptor")
                .Where(c=>(Member(Member(c,"customEyeLookSettings"),"eyelidsSkinnedMesh") as UnityEngine.Object)==renderer).ToArray();
            if(candidates.Length!=1)return Unsupported("No unique SDK eyelid descriptor targets this renderer; obtain actual control/pose evidence");
            var descriptor=candidates[0];var eye=Member(descriptor,"customEyeLookSettings");
            if(!Convert.ToBoolean(Member(descriptor,"enableEyeLook")))return Unsupported("SDK eye controls are disabled; obtain another actual bound blink/pose control");
            if(Convert.ToString(Member(eye,"eyelidType"))!="Blendshapes")return Unsupported("SDK eyelids use another control mode; this mesh-contact observer does not implement bone-driven lids");
            var indices=Member(eye,"eyelidsBlendshapes") as int[];var mesh=renderer.sharedMesh;
            if(indices==null||indices.Length<1||indices[0]<0||indices[0]>=mesh.blendShapeCount)return Unsupported("SDK Blink slot 0 has no valid shape binding");
            var blink=indices[0];if(mesh.GetBlendShapeFrameCount(blink)!=1||Math.Abs(mesh.GetBlendShapeFrameWeight(blink,0)-100)>.0001)return Unsupported("Blink interpolation is not executable as a single 100-percent frame");
            var left=Member(eye,"leftEye") as Transform;var right=Member(eye,"rightEye") as Transform;var centerSource="descriptor";
            if(left==null||right==null) { var animator=avatar.GetComponent<Animator>();if(animator!=null&&animator.isHuman){left=animator.GetBoneTransform(HumanBodyBones.LeftEye);right=animator.GetBoneTransform(HumanBodyBones.RightEye);centerSource="humanoid-avatar";} }
            if(left==null||right==null||left==right)return Unsupported("Eye centers are absent from both descriptor and actual humanoid bindings; request eye-control pose preview/observation");
            if(!left.IsChildOf(avatar.transform)||!right.IsChildOf(avatar.transform))return Unsupported("Eye centers are not owned by this source avatar");
            var distance=(left.position-right.position).magnitude;if(!float.IsFinite(distance)||distance<=.000001)return Unsupported("Eye center separation is degenerate");
            var open=Pose(renderer,blink,0);var closed=Pose(renderer,blink,100);if(open.Length!=closed.Length)return Unsupported("Blink vertex correspondence changed");
            // Frozen versioned ratios adapt to source scale. They are derived before the candidate,
            // never relaxed after observing a failed candidate. All qualifying source contacts are kept.
            var radius=distance*.45f;var closedLimit=distance*.01f;var openLimit=distance*.02f;var motionLimit=distance*.001f;var regions=new List<object>();
            foreach(var side in new[]{("left",left),("right",right)})
            {
                var vertices=Enumerable.Range(0,open.Length).Where(i=>(open[i]-side.Item2.position).magnitude<=radius).ToArray();var cells=new Dictionary<(long,long,long),List<int>>();
                (long,long,long) Cell(Vector3 v)=>((long)Math.Floor(v.x/closedLimit),(long)Math.Floor(v.y/closedLimit),(long)Math.Floor(v.z/closedLimit));
                foreach(var i in vertices){var cell=Cell(closed[i]);if(!cells.TryGetValue(cell,out var list))cells[cell]=list=new List<int>();list.Add(i);}
                var pairs=new List<object>();var matched=new HashSet<int>();var moving=vertices.Count(i=>(open[i]-closed[i]).magnitude>=motionLimit);
                foreach(var i in vertices)
                {var cell=Cell(closed[i]);for(var x=-1;x<=1;x++)for(var y=-1;y<=1;y++)for(var z=-1;z<=1;z++)if(cells.TryGetValue((cell.Item1+x,cell.Item2+y,cell.Item3+z),out var ids))foreach(var j in ids)
                    if(j>i&&(closed[i]-closed[j]).magnitude<=closedLimit&&(open[i]-open[j]).magnitude>=openLimit&&((open[i]-closed[i]).magnitude>=motionLimit||(open[j]-closed[j]).magnitude>=motionLimit)){pairs.Add(new object[]{i,j});matched.Add(i);matched.Add(j);}}
                if(pairs.Count==0){var failed=Unsupported("SDK Blink lacks a source closed/open contact control in the "+side.Item1+" eye region; inspect the actual source poses");failed["controlEvidence"]=D("side",side.Item1,"center",Vec(side.Item2.position),"regionVertices",vertices.Length,"movingVertices",moving,"closestSourceVertexMeters",open.Min(v=>(v-side.Item2.position).magnitude),"maxBlinkDisplacementMeters",Enumerable.Range(0,open.Length).Max(i=>(open[i]-closed[i]).magnitude),"sourcePoseBounds",D("min",Vec(open.Aggregate(Vector3.Min)),"max",Vec(open.Aggregate(Vector3.Max))));return failed;}
                regions.Add(D("side",side.Item1,"eyePath",PathOf(side.Item2,avatar.transform),"eyeWorldMatrix",Enumerable.Range(0,16).Select(i=>(object)side.Item2.localToWorldMatrix[i]).ToList(),"center",Vec(side.Item2.position),"pairs",pairs,
                    "coverage",D("regionVertices",vertices.Length,"movingVertices",moving,"contactVertices",matched.Count,"sourceContactPairs",pairs.Count,"unmeasuredMovingVertices",vertices.Count(i=>(open[i]-closed[i]).magnitude>=motionLimit&&!matched.Contains(i)))));
            }
            return D("schema","face-eye-observation/0.1","status","source_controls_verified","complete",true,"method","sdk-blink-source-contact/1","meshSha256",meshSha256,
                "descriptorPath",PathOf(descriptor.transform,avatar.transform),"centerSource",centerSource,"controlActive",Member(descriptor,"enableEyeLook"),"blinkKey",mesh.GetBlendShapeName(blink),"blinkSourceIndex",blink,
                "parameters",D("eyeDistanceMeters",distance,"regionRadiusMeters",radius,"closedMaxGapMeters",closedLimit,"openMinGapMeters",openLimit,"minimumMotionMeters",motionLimit,"halfGapMinRatio",.25,"halfGapMaxRatio",.75),"regions",regions,
                "limitations",new[]{"Measures every source-derived lid contact pair within SDK-centered regions, not all surrounding skin vertices","Does not establish eyeball occlusion, intersections, or aesthetic acceptance","No vertex indices or favorable pairs can be supplied by an AI design input"});
        }
        public static Dictionary<string,object> Verify(GameObject original,SkinnedMeshRenderer source,GameObject candidate,SkinnedMeshRenderer actual,string meshSha256)
        {
            var observed=Observe(original,source,meshSha256);if(observed.Str("status")!="source_controls_verified")return observed;
            var key=observed.Str("blinkKey");var index=actual.sharedMesh.GetBlendShapeIndex(key);if(index<0)return D("status","failed","complete",false,"reason","Candidate lost the actual SDK Blink key");
            var descriptors=candidate.GetComponentsInChildren<Component>(true).Where(c=>c!=null&&c.GetType().FullName=="VRC.SDK3.Avatars.Components.VRCAvatarDescriptor")
                .Where(c=>(Member(Member(c,"customEyeLookSettings"),"eyelidsSkinnedMesh") as UnityEngine.Object)==actual).ToArray();
            if(descriptors.Length!=1||!Convert.ToBoolean(Member(descriptors[0],"enableEyeLook"))||Convert.ToString(Member(Member(descriptors[0],"customEyeLookSettings"),"eyelidType"))!="Blendshapes")return D("status","failed","complete",false,"reason","Candidate lost the active SDK Blink binding");
            var binding=Member(Member(descriptors[0],"customEyeLookSettings"),"eyelidsBlendshapes") as int[];
            if(binding==null||binding.Length==0||binding[0]!=index)return D("status","failed","complete",false,"reason","Candidate SDK Blink no longer points to the preserved source control");
            var open=Pose(actual,index,0);var half=Pose(actual,index,50);var closed=Pose(actual,index,100);var parameters=observed.Obj("parameters");var closeLimit=Convert.ToDouble(parameters["closedMaxGapMeters"]);var openLimit=Convert.ToDouble(parameters["openMinGapMeters"]);var minimum=Convert.ToDouble(parameters["halfGapMinRatio"]);var maximum=Convert.ToDouble(parameters["halfGapMaxRatio"]);var readings=new List<object>();var passed=true;
            foreach(var region in observed.List("regions").Cast<Dictionary<string,object>>())
            {
                var measurements=new List<object>();foreach(var pair in region.List("pairs"))
                {var ids=((System.Collections.IEnumerable)pair).Cast<object>().Select(v=>Convert.ToInt32(v)).ToArray();var a=ids[0];var b=ids[1];if(a>=open.Length||b>=open.Length){passed=false;continue;}var zero=(open[a]-open[b]).magnitude;var mid=(half[a]-half[b]).magnitude;var full=(closed[a]-closed[b]).magnitude;var ok=float.IsFinite(zero)&&float.IsFinite(mid)&&float.IsFinite(full)&&zero>=openLimit&&full<=closeLimit&&mid>=zero*minimum&&mid<=zero*maximum;passed&=ok;measurements.Add(D("vertices",new[]{a,b},"openGapMeters",zero,"halfGapMeters",mid,"closedGapMeters",full,"passed",ok));}
                readings.Add(D("side",region.Str("side"),"coverage",region["coverage"],"measurements",measurements));
            }
            return D("schema","face-eye-verification/0.1","status",passed?"technical_controls_passed":"failed","complete",passed,"source",observed,"regions",readings,"limitations",observed["limitations"]);
        }
    }
}
