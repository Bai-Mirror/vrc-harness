// Independent deterministic world-meter expression transfer and source-relative damage checks.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
namespace AVH.Harness
{
    public static class FaceGeometry
    {
        static double Number(Dictionary<string, object> d, string key) { var value = d[key]; if (!(value is double || value is float || value is int || value is long)) throw new InvalidOperationException("Numeric face geometry parameter required"); var n = Convert.ToDouble(value); if (!double.IsFinite(n)) throw new InvalidOperationException("Non-finite face geometry parameter"); return n; }
        static void Need(bool ok, string message) { if (!ok) throw new InvalidOperationException(message); }
        sealed class Node { public int id, axis; public Node left, right; }
        public sealed class Transfer
        {
            readonly Vector3[] p, q; readonly Node tree; readonly int neighbors; readonly double power, tolerance; readonly List<int> controls = new List<int>();
            public Transfer(Vector3[] source, Vector3[] target, Dictionary<string, object> recipe)
            {
                Need(recipe.Str("schema") == "face-compensation/0.1" && recipe.Str("method") == "idw-endpoint-transfer" && recipe.Str("version") == "1", "Unsupported face compensation algorithm");
                p = source; q = target; Need(p.Length == q.Length && p.Length > 0, "Transfer control point count differs");
                var count = Number(recipe, "neighbors"); Need(count >= 1 && count <= 32 && count == Math.Floor(count), "Invalid nearest control count"); neighbors = (int)count;
                power = Number(recipe, "power"); Need(power == 1 || power == 2, "Unsupported IDW power"); tolerance = Number(recipe, "pointToleranceMeters"); Need(tolerance > 0 && tolerance <= 0.0001, "Invalid point tolerance");
                // A spatial grid coalesces identical UV-split control vertices without quadratic scans.
                var cells = new Dictionary<(long,long,long), List<int>>();
                for (var i = 0; i < p.Length; i++)
                {
                    var cell = Cell(p[i]); var same = new List<int>();
                    for (var x = -1; x <= 1; x++) for (var y = -1; y <= 1; y++) for (var z = -1; z <= 1; z++)
                        if (cells.TryGetValue((cell.Item1+x,cell.Item2+y,cell.Item3+z), out var ids)) foreach (var j in ids) if ((p[j]-p[i]).magnitude <= tolerance) same.Add(j);
                    if (same.Count > 0) { foreach (var j in same) Need(((q[i]-p[i])-(q[j]-p[j])).magnitude <= tolerance, "Coincident controls have contradictory design displacements"); continue; }
                    controls.Add(i); if (!cells.TryGetValue(cell, out var list)) cells[cell] = list = new List<int>(); list.Add(i);
                }
                tree = Build(controls.ToArray(), 0);
            }
            (long,long,long) Cell(Vector3 v) => ((long)Math.Floor(v.x/tolerance),(long)Math.Floor(v.y/tolerance),(long)Math.Floor(v.z/tolerance));
            Node Build(int[] ids, int depth)
            {
                if (ids.Length == 0) return null; var axis = depth % 3; Array.Sort(ids, (a,b) => { var c=p[a][axis].CompareTo(p[b][axis]); return c != 0 ? c : a.CompareTo(b); }); var mid=ids.Length/2;
                return new Node { id=ids[mid], axis=axis, left=Build(ids.Take(mid).ToArray(),depth+1), right=Build(ids.Skip(mid+1).ToArray(),depth+1) };
            }
            void Nearest(Node node, Vector3 point, List<(double distance,int id)> found)
            {
                if (node == null) return; var delta=p[node.id]-point; var distance=(double)delta.x*delta.x+(double)delta.y*delta.y+(double)delta.z*delta.z;
                found.Add((distance,node.id)); found.Sort((a,b)=> { var c=a.distance.CompareTo(b.distance); return c!=0?c:a.id.CompareTo(b.id); }); if (found.Count>neighbors) found.RemoveAt(found.Count-1);
                var offset=(double)point[node.axis]-p[node.id][node.axis]; var near=offset<0?node.left:node.right; var far=offset<0?node.right:node.left; Nearest(near,point,found);
                if (found.Count<neighbors || offset*offset<=found[found.Count-1].distance) Nearest(far,point,found);
            }
            public Vector3 Map(Vector3 point)
            {
                var nearest=new List<(double distance,int id)>(); Nearest(tree,point,nearest); var close=nearest.Where(n=>n.distance<=tolerance*tolerance).OrderBy(n=>n.id).ToArray();
                if (close.Length>0) return point+q[close[0].id]-p[close[0].id];
                double total=0,x=0,y=0,z=0; foreach(var n in nearest) { var weight=1/Math.Pow(Math.Sqrt(n.distance),power); var d=q[n.id]-p[n.id];total+=weight;x+=weight*d.x;y+=weight*d.y;z+=weight*d.z; }
                return point+new Vector3((float)(x/total),(float)(y/total),(float)(z/total));
            }
        }
        public static Vector3[] Compensate(Vector3[] source, Vector3[] target, Vector3[] delta, Matrix4x4 world, Dictionary<string, object> recipe, out double halfError, Transfer preparedTransfer = null)
        {
            Need(source.Length==target.Length && delta.Length==source.Length,"Expression vertex count differs");
            Need(float.IsFinite(world.determinant) && world.determinant != 0,"Singular/non-finite source transform cannot define world-meter compensation");
            var p=source.Select(world.MultiplyPoint3x4).ToArray();var q=target.Select(world.MultiplyPoint3x4).ToArray();var transfer=preparedTransfer??new Transfer(p,q,recipe);var inverse=world.inverse;var result=new Vector3[p.Length];halfError=0;
            for(var i=0;i<p.Length;i++) { var e=world.MultiplyVector(delta[i]);var endpoint=transfer.Map(p[i]+e);result[i]=inverse.MultiplyPoint3x4(endpoint)-target[i];halfError=Math.Max(halfError,(q[i]+(endpoint-q[i])*.5f-transfer.Map(p[i]+e*.5f)).magnitude); }
            var limit=Number(recipe,"halfErrorToleranceMeters"); Need(limit>0 && limit<=.01,"Invalid half-state tolerance"); Need(halfError<=limit,"Compensated half-state exceeds frozen transfer error tolerance");return result;
        }
        public static double ActualHalfError(Vector3[] source, Vector3[] actualBasis, Vector3[] oldDelta, Vector3[] actualDelta, Matrix4x4 world, Transfer transfer)
        { Need(source.Length==actualBasis.Length&&source.Length==oldDelta.Length&&source.Length==actualDelta.Length,"Actual half-state vertex count differs"); double error=0;for(var i=0;i<source.Length;i++)error=Math.Max(error,(world.MultiplyPoint3x4(actualBasis[i]+actualDelta[i]*.5f)-transfer.Map(world.MultiplyPoint3x4(source[i]+oldDelta[i]*.5f))).magnitude);return error; }
        public static Dictionary<string, object> Quality(Vector3[] source, Vector3[] target, int[] triangles, Dictionary<string, object> limits)
        {
            Need(source.Length==target.Length && triangles.Length%3==0,"Quality topology differs");
            var areaLimit=Number(limits,"minimumTriangleAreaMetersSquared");Need(areaLimit>0 && areaLimit<=.001,"Invalid triangle area tolerance");
            var minArea=Number(limits,"minAreaRatio");var maxArea=Number(limits,"maxAreaRatio");var minEdge=Number(limits,"minEdgeRatio");var maxEdge=Number(limits,"maxEdgeRatio");var normalLimit=Number(limits,"minNormalDot");var creaseLimit=Number(limits,"maxDihedralIncreaseDegrees");
            Need(minArea>0&&minArea<=1&&maxArea>=1&&maxArea<=100&&minEdge>0&&minEdge<=1&&maxEdge>=1&&maxEdge<=100&&normalLimit>=0&&normalLimit<=1&&creaseLimit>=0&&creaseLimit<=180,"Invalid frozen quality thresholds");
            var before=new List<Vector3>();var after=new List<Vector3>();var edges=new Dictionary<(int,int),List<int>>();var baseline=0;var degenerates=0;var flips=0;var areaFailures=0;var edgeFailures=0;var creaseFailures=0;double maxCrease=0;
            for(var f=0;f<triangles.Length/3;f++)
            {
                var a=triangles[f*3];var b=triangles[f*3+1];var c=triangles[f*3+2];Need(new[]{a,b,c}.All(i=>i>=0&&i<source.Length),"Invalid triangle vertex");
                var old=Vector3.Cross(source[b]-source[a],source[c]-source[a]);var next=Vector3.Cross(target[b]-target[a],target[c]-target[a]);before.Add(old.normalized);after.Add(next.normalized);var oldArea=old.magnitude*.5;var newArea=next.magnitude*.5;
                if(oldArea<areaLimit)baseline++;else {if(newArea<areaLimit)degenerates++;var ratio=newArea/oldArea;if(ratio<minArea||ratio>maxArea)areaFailures++;if(newArea>=areaLimit&&Vector3.Dot(old.normalized,next.normalized)<normalLimit)flips++;}
                foreach(var pair in new[]{(a,b),(b,c),(c,a)}) {var key=(Math.Min(pair.Item1,pair.Item2),Math.Max(pair.Item1,pair.Item2));if(!edges.TryGetValue(key,out var uses))edges[key]=uses=new List<int>();uses.Add(f);}
            }
            foreach(var edge in edges) {var a=edge.Key.Item1;var b=edge.Key.Item2;var old=(source[a]-source[b]).magnitude;var next=(target[a]-target[b]).magnitude;var absolute=limits.ContainsKey("nearDegenerateEdgeMeters")?Number(limits,"nearDegenerateEdgeMeters"):0;if(old<=absolute){if(next>absolute)edgeFailures++;}else if(old>Math.Sqrt(areaLimit)){var ratio=next/old;if(ratio<minEdge||ratio>maxEdge)edgeFailures++;}
                if(edge.Value.Count==2) {var aFace=edge.Value[0];var bFace=edge.Value[1];if(before[aFace]!=Vector3.zero&&before[bFace]!=Vector3.zero&&after[aFace]!=Vector3.zero&&after[bFace]!=Vector3.zero){var increase=Vector3.Angle(after[aFace],after[bFace])-Vector3.Angle(before[aFace],before[bFace]);maxCrease=Math.Max(maxCrease,increase);if(increase>creaseLimit)creaseFailures++;}}
            }
            return new Dictionary<string,object>{{"baselineDegenerateTriangles",baseline},{"newDegenerateTriangles",degenerates},{"flippedTriangles",flips},{"areaRatioFailures",areaFailures},{"edgeRatioFailures",edgeFailures},{"dihedralFailures",creaseFailures},{"maxDihedralIncreaseDegrees",maxCrease},{"passed",degenerates==0&&flips==0&&areaFailures==0&&edgeFailures==0&&creaseFailures==0}};
        }
    }
}
