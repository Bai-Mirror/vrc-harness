// Source-bound corner correspondence and candidate expansion into the observed Unity layout.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.IO;
using UnityEngine;
namespace AVH.Harness
{
    public static class FaceMapping
    {
        static void Check(bool ok,string why){if(!ok)throw new InvalidOperationException(why);}
        static double N(object v){var n=Convert.ToDouble(v);Check(double.IsFinite(n),"Non-finite face mapping number");return n;}
        static object[] A(object v)=>((IEnumerable)v).Cast<object>().ToArray();
        static int Index(object v){var n=N(v);Check(n>=0&&n<=int.MaxValue&&n==Math.Floor(n),"Invalid mapping index");return (int)n;}
        static Vector3 V(object v){var a=A(v);Check(a.Length>=3,"Mapping vector missing");return new Vector3((float)N(a[0]),(float)N(a[1]),(float)N(a[2]));}
        public static Vector3[] ReadVectors(object value)
        {
            if(!(value is Dictionary<string,object> reference))return A(value).Select(V).ToArray();
            var file=reference.Str("file");Check(file!=null&&file.StartsWith("Assets/_Harness/Face/",StringComparison.Ordinal)&&!file.Contains('\\'),"Blender frame binary must be project-owned");var path=Path.GetFullPath(Avh.Abs(file));var root=Path.GetFullPath(Avh.Abs("Assets/_Harness/Face/")).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;Check(path.StartsWith(root,StringComparison.OrdinalIgnoreCase)&&File.Exists(path),"Blender frame binary escapes managed root");
            Avh.AssertManagedPath(path);
            var count=Index(reference["count"]);Check(reference.Str("encoding")=="float32-le"&&new FileInfo(path).Length==(long)count*12&&FaceStage.FileHash(file)==reference.Str("sha256"),"Blender frame binary facts changed");var vectors=new Vector3[count];using(var reader=new BinaryReader(File.OpenRead(path)))for(var i=0;i<count;i++){var x=reader.ReadSingle();var y=reader.ReadSingle();var z=reader.ReadSingle();Check(float.IsFinite(x)&&float.IsFinite(y)&&float.IsFinite(z),"Non-finite Blender frame binary");vectors[i]=new Vector3(x,y,z);}return vectors;
        }
        static bool Near(Vector3 a,Vector3 b,float tolerance)=>(a-b).magnitude<=tolerance;
        static Dictionary<string,object> D(params object[] a){var d=new Dictionary<string,object>();for(var i=0;i<a.Length;i+=2)d[(string)a[i]]=a[i+1];return d;}
        static object Vectors(Vector3[] a)=>a.Select(v=>(object)new object[]{v.x,v.y,v.z}).ToList();
        static string VHash(Vector3[] values){using(var stream=new MemoryStream()){using(var writer=new BinaryWriter(stream,System.Text.Encoding.UTF8,true))foreach(var v in values){writer.Write(v.x);writer.Write(v.y);writer.Write(v.z);}return FaceStage.Hash(stream.ToArray());}}
        static object FrameVectors(Vector3[] values,bool binary)
        {
            if(!binary)return Vectors(values);byte[] bytes;using(var stream=new MemoryStream()){using(var writer=new BinaryWriter(stream,System.Text.Encoding.UTF8,true))foreach(var v in values){writer.Write(v.x);writer.Write(v.y);writer.Write(v.z);}bytes=stream.ToArray();}
            var hash=FaceStage.Hash(bytes);var path="_harness/face/source-evidence/"+hash+".bin";Directory.CreateDirectory(Path.GetDirectoryName(Avh.Abs(path)));if(File.Exists(Avh.Abs(path)))Check(FaceStage.FileHash(path)==hash,"Frozen source frame binary changed");else File.WriteAllBytes(Avh.Abs(path),bytes);
            return D("file",path,"sha256",hash,"encoding","float32-le","count",values.Length);
        }
        public static List<object> Frames(Mesh mesh)
        {
            var binary=(long)mesh.vertexCount*Enumerable.Range(0,mesh.blendShapeCount).Sum(mesh.GetBlendShapeFrameCount)>200000;var result=new List<object>();for(var i=0;i<mesh.blendShapeCount;i++){var frames=new List<object>();for(var f=0;f<mesh.GetBlendShapeFrameCount(i);f++){var v=new Vector3[mesh.vertexCount];var n=new Vector3[v.Length];var t=new Vector3[v.Length];mesh.GetBlendShapeFrameVertices(i,f,v,n,t);frames.Add(D("weight",mesh.GetBlendShapeFrameWeight(i,f),"vertices",FrameVectors(v,binary),"normals",FrameVectors(n,binary),"tangents",FrameVectors(t,binary),"verticesSha256",VHash(v),"normalsSha256",VHash(n),"tangentsSha256",VHash(t)));}result.Add(D("name",mesh.GetBlendShapeName(i),"frames",frames));}return result;
        }
        static Matrix4x4 Coordinate(Dictionary<string,object> mapping)
        {
            var rows=A(mapping["coordinateMatrix"]);Check(rows.Length==3,"Mapping matrix must be 3x4");var matrix=Matrix4x4.identity;var axes=new HashSet<int>();var scales=new List<float>();
            for(var r=0;r<3;r++){var row=A(rows[r]);Check(row.Length==4&&Math.Abs(N(row[3]))<1e-12,"Source mapping translation must be zero");var nonzero=0;for(var c=0;c<3;c++){matrix[r,c]=(float)N(row[c]);if(Math.Abs(matrix[r,c])>1e-12){nonzero++;Check(axes.Add(c),"Source mapping axes are not a permutation");scales.Add(Math.Abs(matrix[r,c]));}}Check(nonzero==1,"Source mapping must use signed orthogonal axes");}
            Check(scales.Min()>0&&scales.Max()-scales.Min()<1e-9,"Source mapping scale must be uniform positive");return matrix;
        }
        static double RawMeterError(Vector3 actual,Vector3 endpoint,Vector3 basis,double[][] matrix,Matrix4x4 world)
        {
            // Preserve the frozen matrix precision when reporting native FBX/import residuals.
            // Unity float arithmetic remains the authority for applied mesh geometry.
            var x=(double)endpoint.x-basis.x;var y=(double)endpoint.y-basis.y;var z=(double)endpoint.z-basis.z;
            var rx=actual.x-(matrix[0][0]*x+matrix[0][1]*y+matrix[0][2]*z);var ry=actual.y-(matrix[1][0]*x+matrix[1][1]*y+matrix[1][2]*z);var rz=actual.z-(matrix[2][0]*x+matrix[2][1]*y+matrix[2][2]*z);
            var wx=world[0,0]*rx+world[0,1]*ry+world[0,2]*rz;var wy=world[1,0]*rx+world[1,1]*ry+world[1,2]*rz;var wz=world[2,0]*rx+world[2,1]*ry+world[2,2]*rz;return Math.Sqrt(wx*wx+wy*wy+wz*wz);
        }
        static object[] SourceCornerNormals(Dictionary<string,object> blender,Dictionary<string,object> mapping,Vector3[] basis)
        {
            var raw=blender.Obj("fbxNormalEvidence");if(raw==null)return A(blender["cornerNormals"]);
            Check(raw.Str("schema")=="face-fbx-normal-evidence/0.1"&&raw.Str("sourceSha256")==mapping.Str("sourceSha256")&&!string.IsNullOrEmpty(raw.Str("geometryId")),"Raw FBX normal evidence targets another source");
            Check(raw.Str("normalSpace")=="blender-source-mesh-local","Raw FBX normal coordinate space is not independently bound");
            Check(new[]{"ByPolygonVertex","ByVertice","ByControlPoint","ByPolygon","AllSame"}.Contains(raw.Str("mapping"))&&new[]{"Direct","IndexToDirect"}.Contains(raw.Str("reference")),"Unsupported raw FBX normal mapping/reference");
            var rows=A(raw["geometryToBlenderLocal"]);Check(rows.Length==3,"Raw FBX normal geometry transform missing");for(var r=0;r<3;r++){var row=A(rows[r]);Check(row.Length==4,"Raw FBX normal geometry transform invalid");for(var c=0;c<4;c++)Check(N(row[c])==(r==c?1:0),"Raw FBX normal geometry transform has not been measured");}
            var vertices=A(raw["vertices"]).Select(V).ToArray();Check(vertices.Length==basis.Length&&vertices.SequenceEqual(basis),"Raw FBX normal source control point identity differs");
            var polygons=blender.List("polygons").Cast<Dictionary<string,object>>().ToArray();var native=A(raw["polygonVertexIndices"]);var normals=A(raw["cornerNormals"]);Check(native.Length==polygons.Length&&normals.Length==polygons.Length,"Raw FBX normal polygon coverage differs");
            for(var p=0;p<polygons.Length;p++){var indices=A(polygons[p]["vertices"]).Select(Index).ToArray();Check(indices.SequenceEqual(A(native[p]).Select(Index))&&A(normals[p]).Length==indices.Length,"Raw FBX normal polygon/corner identities differ");foreach(var normal in A(normals[p]))V(normal);}
            return normals;
        }
        public static void VerifyImportedSource(Mesh source,Dictionary<string,object> authority,Dictionary<string,object> evidence,Dictionary<string,object> target,Dictionary<string,object> catalog,string meshId,string observationSha,string[] boneNames,Matrix4x4 world)
        {
            Check(authority.Str("schema")=="face-unity-imported-source/0.1"&&evidence.Str("schema")=="face-blender-source-evidence/0.1","Unsupported imported Unity source authority");
            Check(authority.Str("targetId")==target.Str("targetId")&&authority.Str("meshSha256")==target.Str("meshSha256")&&Avh.Json(authority.Obj("sourceModel"))==Avh.Json(target.Obj("mesh")),"Imported source authority targets another source mesh");
            Check(authority.Obj("observation").Str("file")==FaceStage.ObservationPath&&authority.Obj("observation").Str("sha256")==observationSha&&Avh.Json(authority.Obj("unityFrameEvidence"))==Avh.Json(target.Obj("frameEvidence")),"Imported source authority uses another observation/frame revision");
            Check(evidence.Obj("source").Str("sha256")==authority.Obj("effectiveSource").Str("sha256")&&evidence.Str("catalogSha256")==catalog.Str("catalogSha256"),"Effective source evidence/catalog drift");
            Check(catalog.List("meshes").Cast<Dictionary<string,object>>().Count(m=>m.Str("meshId")==meshId)==1,"Effective catalog mesh is absent or ambiguous");var blender=evidence.List("meshes").Cast<Dictionary<string,object>>().SingleOrDefault(m=>m.Str("meshId")==meshId);Check(blender!=null,"Effective source mesh is absent or ambiguous");
            var matrix=Coordinate(authority);var basis=A(blender["vertices"]).Select(V).ToArray();var actual=source.vertices;Check(basis.Length==actual.Length,"Effective source must preserve the exact imported Unity vertex layout");
            for(var i=0;i<actual.Length;i++)Check(world.MultiplyVector(actual[i]-matrix.MultiplyPoint3x4(basis[i])).magnitude<=1e-6,"Effective source basis differs from actual Unity source");
            var nativeWeights=blender.List("weights").Cast<Dictionary<string,object>>().ToArray();var weights=Weights(source);Check(nativeWeights.Length==actual.Length&&boneNames.Distinct().Count()==boneNames.Length,"Effective source bone/control identities differ");
            for(var i=0;i<actual.Length;i++){var normalized=nativeWeights[i].Where(w=>boneNames.Contains(w.Key)&&N(w.Value)>0).ToDictionary(w=>w.Key,w=>N(w.Value));var sum=normalized.Values.Sum();Check(normalized.Count==weights[i].Count,"Effective source bone influence coverage differs");foreach(var weight in weights[i])Check(weight.Key<boneNames.Length&&normalized.ContainsKey(boneNames[weight.Key])&&Math.Abs(weight.Value-normalized[boneNames[weight.Key]]/sum)<=1e-6,"Effective source bone influence differs");}
            var keys=blender.List("keys").Cast<Dictionary<string,object>>().ToArray();Check(keys.Length==source.blendShapeCount+1,"Effective source shape count differs");
            for(var k=0;k<source.blendShapeCount;k++)
            {
                var name=source.GetBlendShapeName(k);var key=keys[k+1];Check(key.Str("name")==name&&source.GetBlendShapeFrameCount(k)==1&&Math.Abs(source.GetBlendShapeFrameWeight(k,0)-100)<.0001,"Effective source shape order/frame differs");var endpoint=ReadVectors(key["coordinates"]);Check(endpoint.Length==actual.Length,"Effective source shape vertex coverage differs");var delta=new Vector3[actual.Length];var scratch=new Vector3[actual.Length];source.GetBlendShapeFrameVertices(k,0,delta,scratch,scratch);
                for(var i=0;i<delta.Length;i++)Check(world.MultiplyVector(delta[i]-matrix.MultiplyVector(endpoint[i]-basis[i])).magnitude<=1e-6,"Effective source shape differs from actual Unity frame");
            }
            var uvChannels=authority.Obj("uvChannels");Check(uvChannels!=null,"Effective source UV channel identities missing");var uvs=new List<Vector4>[8];for(var c=0;c<8;c++){uvs[c]=new List<Vector4>();source.GetUVs(c,uvs[c]);Check((uvs[c].Count==0)==!uvChannels.ContainsKey(c.ToString()),"Effective source UV channel coverage differs");}
            var polygons=blender.List("polygons").Cast<Dictionary<string,object>>().ToArray();var offset=0;var reverse=matrix.determinant<0;
            for(var sub=0;sub<source.subMeshCount;sub++)
            {
                Check(source.GetTopology(sub)==MeshTopology.Triangles,"Effective source requires observed Unity triangle topology");var indices=source.GetIndices(sub);
                for(var tri=0;tri<indices.Length;tri+=3)
                {
                    Check(offset<polygons.Length,"Effective source is missing original Unity triangles");var polygon=polygons[offset++];var ids=A(polygon["vertices"]).Select(Index).ToArray();var expected=new[]{indices[tri],indices[tri+(reverse?2:1)],indices[tri+(reverse?1:2)]};Check(Index(polygon["material"])==sub&&ids.SequenceEqual(expected),"Effective source triangle/material/winding differs");
                    foreach(var channel in uvChannels){var ci=Index(int.Parse(channel.Key));Check(ci<8&&uvs[ci].Count==actual.Length,"Effective source UV source is incomplete");var layer=polygon.Obj("uv");Check(layer.ContainsKey(channel.Value as string),"Effective source UV layer identity differs");var corners=A(layer[channel.Value as string]);Check(corners.Length==3,"Effective source UV corner coverage differs");for(var j=0;j<3;j++){var uv=A(corners[j]);Check(uv.Length==2&&Math.Abs(N(uv[0])-uvs[ci][ids[j]].x)<=1e-6&&Math.Abs(N(uv[1])-uvs[ci][ids[j]].y)<=1e-6,"Effective source Unity UV corner differs");}}
                }
            }
            Check(offset==polygons.Length,"Effective source has undeclared triangles");
            // Original Unity N/T and every original frame stay bound by target/frame hashes.
            // Blender custom-normal storage is a measured decoder representation; this
            // authority does not assert that its quantized normals equal native FBX normals.
        }
        public static void VerifySource(Mesh source,Dictionary<string,object> mapping,Dictionary<string,object> evidence,Dictionary<string,object> target,Dictionary<string,object> catalog,string observationSha,string blenderEvidenceSha,string[] boneNames,Matrix4x4 sourceWorld)
        {
            Check(mapping.Str("schema")=="face-source-mapping/0.1"&&evidence.Str("schema")=="face-blender-source-evidence/0.1","Unsupported source mapping evidence");
            Check(mapping.Str("observationSha256")==observationSha&&mapping.Str("targetId")==target.Str("targetId")&&mapping.Str("sourceSha256")==target.Obj("mesh").Str("sha256"),"Source mapping targets another observed source");
            Check(mapping.Obj("blenderEvidence").Str("sha256")==blenderEvidenceSha&&evidence.Obj("source").Str("sha256")==mapping.Str("sourceSha256")&&evidence.Str("catalogSha256")==catalog.Str("catalogSha256"),"Source mapping Blender evidence drift");
            Check(Avh.Json(mapping.Obj("unityFrameEvidence"))==Avh.Json(target.Obj("frameEvidence")),"Source mapping uses another Unity frame evidence");
            var blender=evidence.List("meshes").Cast<Dictionary<string,object>>().SingleOrDefault(m=>m.Str("meshId")==mapping.Str("meshId"));Check(blender!=null,"Mapped Blender mesh evidence absent");
            var map=A(mapping["unityToBlenderVertex"]).Select(Index).ToArray();var basis=A(blender["vertices"]).Select(V).ToArray();var sourceBasis=source.vertices;Check(map.Length==source.vertexCount&&map.All(i=>i<basis.Length),"Complete source vertex expansion required");var matrix=Coordinate(mapping);var normalMatrix=matrix.inverse.transpose;
            const float tolerance=1e-6f;for(var i=0;i<map.Length;i++)Check(sourceWorld.MultiplyVector(sourceBasis[i]-matrix.MultiplyPoint3x4(basis[map[i]])).magnitude<=tolerance,"Source mapping basis mismatch");
            var weights=Weights(source);var blenderWeights=blender.List("weights").Cast<Dictionary<string,object>>().ToArray();var bones=blender.List("bones").Cast<Dictionary<string,object>>().Select(b=>b.Str("name")).ToArray();Check(boneNames.Distinct().Count()==boneNames.Length&&boneNames.All(bones.Contains),"Source bone identities are ambiguous or absent");
            for(var i=0;i<map.Length;i++){var bw=blenderWeights[map[i]].Where(w=>bones.Contains(w.Key)&&N(w.Value)>0).ToDictionary(w=>w.Key,w=>N(w.Value));var total=bw.Values.Sum();Check(weights[i].Count==bw.Count,"Source bone influence coverage differs");foreach(var w in weights[i])Check(w.Key<boneNames.Length&&bw.ContainsKey(boneNames[w.Key])&&Math.Abs(w.Value-bw[boneNames[w.Key]]/total)<1e-6,"Source mapped bone weight differs");}
            var keys=blender.List("keys").Cast<Dictionary<string,object>>().ToArray();
            var semantics=mapping.Obj("frameSemantics");Dictionary<string,Dictionary<string,object>> coordinated=null;var rawResidual=0d;
            var preciseMatrix=A(mapping["coordinateMatrix"]).Select(row=>A(row).Select(N).ToArray()).ToArray();
            if(semantics!=null)
            {
                Check(semantics.Str("schema")=="face-imported-key-semantics/0.1"&&semantics.Str("method")=="unity-observed-controlpoint-frames/1","Unsupported imported source frame semantics");
                Check(Avh.Json(semantics.Obj("unityFrameEvidence"))==Avh.Json(target.Obj("frameEvidence")),"Imported source semantics use another Unity observation");
                Check(Index(semantics["coordinatedControlPoints"])==basis.Length&&map.Distinct().Count()==basis.Length,"Imported source control points are not completely observed");
                var frames=semantics.List("coordinatedKeys").Cast<Dictionary<string,object>>().ToArray();Check(frames.Length==source.blendShapeCount&&frames.Select(f=>f.Str("name")).Distinct().Count()==frames.Length&&frames.Select(f=>f.Str("sourceKeyId")).Distinct().Count()==frames.Length,"Imported source key coverage differs");coordinated=frames.ToDictionary(f=>f.Str("name"));
            }
            for(var k=0;k<source.blendShapeCount;k++)
            {
                var name=source.GetBlendShapeName(k);var key=keys.SingleOrDefault(v=>v.Str("name")==name);Check(key!=null&&source.GetBlendShapeFrameCount(k)==1&&Math.Abs(source.GetBlendShapeFrameWeight(k,0)-100)<.0001,"Mapped source frame identity differs");var native=ReadVectors(key["coordinates"]);Check(native.Length==basis.Length,"Blender frame vertex count differs");var coordinates=native;
                if(coordinated!=null){Check(coordinated.TryGetValue(name,out var frame)&&frame.Str("sourceKeyId")==key.Str("id"),"Imported source frame identity changed");coordinates=ReadVectors(frame["coordinates"]);Check(coordinates.Length==basis.Length,"Imported source frame control point count differs");}
                var delta=new Vector3[source.vertexCount];var scratch=new Vector3[delta.Length];source.GetBlendShapeFrameVertices(k,0,delta,scratch,scratch);
                var observedControls=coordinated==null?null:new Dictionary<int,Vector3>();
                for(var i=0;i<delta.Length;i++)
                {
                    if(observedControls!=null){if(observedControls.TryGetValue(map[i],out var prior))Check(sourceWorld.MultiplyVector(delta[i]-prior).magnitude<=tolerance,"Imported source has incompatible split control point frames");else observedControls[map[i]]=delta[i];}
                    rawResidual=Math.Max(rawResidual,RawMeterError(delta[i],native[map[i]],basis[map[i]],preciseMatrix,sourceWorld));
                    Check(sourceWorld.MultiplyVector(delta[i]-matrix.MultiplyVector(coordinates[map[i]]-basis[map[i]])).magnitude<=tolerance,"Source mapping shape frame mismatch");
                }
            }
            if(semantics!=null)Check(Math.Abs(N(semantics["rawNativeMaxResidualMeters"])-rawResidual)<=1e-8,"Imported source native residual differs from independent observation");
            var polygons=blender.List("polygons").Cast<Dictionary<string,object>>().ToArray();var sourceNormals=SourceCornerNormals(blender,mapping,basis);var triangles=mapping.List("triangleCorners").Cast<Dictionary<string,object>>().ToArray();var seen=new HashSet<string>();var coverage=new Dictionary<int,List<int[]>>();var uvChannels=mapping.Obj("uvChannels");var normal=source.normals;var reverse=mapping.Str("winding")=="reverse";Check(reverse||mapping.Str("winding")=="same","Mapping winding required");
            var submeshIndices=Enumerable.Range(0,source.subMeshCount).Select(source.GetIndices).ToArray();var uvs=new List<Vector4>[8];for(var c=0;c<8;c++){uvs[c]=new List<Vector4>();source.GetUVs(c,uvs[c]);Check((uvs[c].Count==0)==!uvChannels.ContainsKey(c.ToString()),"Source UV channel mapping incomplete");}
            foreach(var item in triangles){var sub=Index(item["submesh"]);var tri=Index(item["triangle"]);var polygon=Index(item["polygon"]);Check(sub<source.subMeshCount&&polygon<polygons.Length&&seen.Add(sub+":"+tri),"Invalid or duplicate source corner mapping");var indices=submeshIndices[sub];Check(source.GetTopology(sub)==MeshTopology.Triangles&&tri*3+2<indices.Length,"Source corner triangle absent");var p=polygons[polygon];Check(Index(p["material"])==sub,"Source corner material differs");var corners=A(item["corners"]).Select(Index).ToArray();var control=A(p["vertices"]).Select(Index).ToArray();Check(corners.Length==3&&corners.Distinct().Count()==3&&corners.All(c=>c<control.Length),"Source polygon corners invalid");var turn=Enumerable.Range(0,3).Sum(j=>(corners[(j+1)%3]-corners[j]+control.Length)%control.Length);Check(turn==(reverse?2:1)*control.Length,"Source polygon winding differs");if(!coverage.ContainsKey(polygon))coverage[polygon]=new List<int[]>();coverage[polygon].Add(corners);
                for(var j=0;j<3;j++){var si=indices[tri*3+j];var corner=corners[j];Check(map[si]==control[corner],"Source triangle control point mismatch");var cornerNormals=A(sourceNormals[polygon]);Check(Near(normal[si],normalMatrix.MultiplyVector(V(cornerNormals[corner])).normalized,1e-4f),"Source corner normal seam differs");foreach(var channel in uvChannels){var ci=Index(int.Parse(channel.Key));Check(ci<8,"Source UV channel invalid");var actual=uvs[ci];var expected=A(p.Obj("uv")[channel.Value as string]);var v=A(expected[corner]);Check(actual.Count==source.vertexCount&&Math.Abs(actual[si].x-N(v[0]))<1e-6&&Math.Abs(actual[si].y-N(v[1]))<1e-6,"Source corner UV seam differs");}}
            }
            Check(seen.Count==Enumerable.Range(0,source.subMeshCount).Sum(s=>source.GetIndices(s).Length/3),"Source mapping misses rendered triangles");
            for(var p=0;p<polygons.Length;p++){var count=A(polygons[p]["vertices"]).Length;Check(coverage.ContainsKey(p)&&coverage[p].Count==count-2,"Source polygon tessellation coverage differs");var edges=new Dictionary<(int,int),int>();foreach(var triangle in coverage[p])for(var j=0;j<3;j++){var a=triangle[j];var b=triangle[(j+1)%3];var edge=a<b?(a,b):(b,a);edges[edge]=edges.TryGetValue(edge,out var n)?n+1:1;}for(var c=0;c<count;c++){var next=(c+1)%count;var e=c<next?(c,next):(next,c);Check(edges.TryGetValue(e,out var n)&&n==1,"Source polygon boundary coverage differs");edges.Remove(e);}Check(edges.Values.All(n=>n==2),"Source polygon internal-edge coverage differs");}
        }
        static Dictionary<int,float>[] Weights(Mesh mesh){var counts=mesh.GetBonesPerVertex();var weights=mesh.GetAllBoneWeights();try{var result=new Dictionary<int,float>[mesh.vertexCount];var offset=0;for(var i=0;i<result.Length;i++){result[i]=new Dictionary<int,float>();for(var j=0;j<counts[i];j++){var w=weights[offset++];Check(!result[i].ContainsKey(w.boneIndex),"Duplicate bone influence");result[i][w.boneIndex]=w.weight;}}return result;}finally{counts.Dispose();weights.Dispose();}}
        static bool SameWeights(Dictionary<int,float> a,Dictionary<int,float> b)=>a.Count==b.Count&&a.All(v=>b.ContainsKey(v.Key)&&Math.Abs(v.Value-b[v.Key])<1e-6);
        // Correspondence is measured between two imports by the same Unity importer.
        // Reordering here is a readback view of actual values, never importer simulation.
        public static Mesh CompareImports(Mesh source, Mesh actual, Vector3[] expected, Matrix4x4 world,
            float tolerance, out int[] map, out Dictionary<string,object> evidence)
        {
            Check(source.vertexCount==actual.vertexCount&&source.subMeshCount==actual.subMeshCount,"Native import vertex/material count changed");
            var count=source.vertexCount;var positions=actual.vertices;var before=source.vertices;
            var oldWeights=Weights(source);var newWeights=Weights(actual);
            var uvOld=new List<Vector4>[8];var uvNew=new List<Vector4>[8];
            for(var c=0;c<8;c++){uvOld[c]=new List<Vector4>();uvNew[c]=new List<Vector4>();source.GetUVs(c,uvOld[c]);actual.GetUVs(c,uvNew[c]);Check(uvOld[c].Count==uvNew[c].Count,"Native import UV coverage changed");}
            var oldSubs=Enumerable.Range(0,count).Select(i=>new HashSet<int>()).ToArray();var newSubs=Enumerable.Range(0,count).Select(i=>new HashSet<int>()).ToArray();
            for(var s=0;s<source.subMeshCount;s++){Check(source.GetTopology(s)==actual.GetTopology(s)&&source.GetIndices(s).Length==actual.GetIndices(s).Length,"Native import submesh coverage changed");foreach(var i in source.GetIndices(s))oldSubs[i].Add(s);foreach(var i in actual.GetIndices(s))newSubs[i].Add(s);}
            bool Fits(int a,int b){if(world.MultiplyVector(expected[a]-positions[b]).magnitude>tolerance||!oldSubs[a].SetEquals(newSubs[b])||!SameWeights(oldWeights[a],newWeights[b]))return false;for(var c=0;c<8;c++)if(uvOld[c].Count>0&&(uvOld[c][a]-uvNew[c][b]).magnitude>1e-6)return false;return true;}
            var mapping=Enumerable.Repeat(-1,count).ToArray();var used=new HashSet<int>();
            for(var i=0;i<count;i++)if(Fits(i,i)){mapping[i]=i;used.Add(i);}
            for(var i=0;i<count;i++)if(mapping[i]<0){var choices=Enumerable.Range(0,count).Where(j=>!used.Contains(j)&&Fits(i,j)).OrderBy(j=>(expected[i]-positions[j]).sqrMagnitude).ThenBy(j=>j).ToArray();Check(choices.Length>0,"Native import has no position/UV/weight/submesh correspondence at vertex "+i);mapping[i]=choices[0];used.Add(mapping[i]);}
            var inverse=new int[count];for(var i=0;i<count;i++)inverse[mapping[i]]=i;
            var result=UnityEngine.Object.Instantiate(actual);result.ClearBlendShapes();result.vertices=mapping.Select(i=>positions[i]).ToArray();
            if(actual.normals.Length>0)result.normals=mapping.Select(i=>actual.normals[i]).ToArray();if(actual.tangents.Length>0)result.tangents=mapping.Select(i=>actual.tangents[i]).ToArray();if(actual.colors.Length>0)result.colors=mapping.Select(i=>actual.colors[i]).ToArray();
            for(var c=0;c<8;c++)if(uvNew[c].Count>0)result.SetUVs(c,mapping.Select(i=>uvNew[c][i]).ToList());
            // Equality of every influence was checked above; copy the equivalent old-order buffers.
            var counts=source.GetBonesPerVertex();var weights=source.GetAllBoneWeights();try{result.SetBoneWeights(counts,weights);}finally{counts.Dispose();weights.Dispose();}
            Dictionary<(int,int),int> Boundary(int[] indices){var edges=new Dictionary<(int,int),int>();for(var i=0;i<indices.Length;i+=3)for(var j=0;j<3;j++){var a=indices[i+j];var b=indices[i+(j+1)%3];var edge=a<b?(a,b):(b,a);edges[edge]=(edges.TryGetValue(edge,out var v)?v:0)+(a<b?1:-1);}return edges.Where(e=>e.Value!=0).ToDictionary(e=>e.Key,e=>e.Value);}
            var changedIndices=0;for(var s=0;s<actual.subMeshCount;s++){
                Check(actual.GetTopology(s)==MeshTopology.Triangles,"Native triangulation coverage is unavailable");
                var indices=actual.GetIndices(s).Select(i=>inverse[i]).ToArray();var original=source.GetIndices(s);changedIndices+=original.Zip(indices,(a,b)=>a==b?0:1).Sum();
                var oldBoundary=Boundary(original);var newBoundary=Boundary(indices);Check(oldBoundary.Count==newBoundary.Count&&oldBoundary.All(e=>newBoundary.TryGetValue(e.Key,out var v)&&v==e.Value),"Native import changes oriented surface boundary/winding");
                result.SetIndices(indices,actual.GetTopology(s),s);
            }
            Check(source.blendShapeCount==actual.blendShapeCount,"Native import key count changed");
            for(var k=0;k<actual.blendShapeCount;k++){
                Check(source.GetBlendShapeName(k)==actual.GetBlendShapeName(k)&&source.GetBlendShapeFrameCount(k)==actual.GetBlendShapeFrameCount(k),"Native import key order/name/frame count changed");
                for(var f=0;f<actual.GetBlendShapeFrameCount(k);f++){Check(source.GetBlendShapeFrameWeight(k,f)==actual.GetBlendShapeFrameWeight(k,f),"Native import frame weight changed");var v=new Vector3[count];var n=new Vector3[count];var t=new Vector3[count];actual.GetBlendShapeFrameVertices(k,f,v,n,t);result.AddBlendShapeFrame(actual.GetBlendShapeName(k),actual.GetBlendShapeFrameWeight(k,f),mapping.Select(i=>v[i]).ToArray(),mapping.Select(i=>n[i]).ToArray(),mapping.Select(i=>t[i]).ToArray());}
            }
            var max=Enumerable.Range(0,count).Max(i=>(double)world.MultiplyVector(expected[i]-positions[mapping[i]]).magnitude);
            var unaffected=Enumerable.Range(0,count).Where(i=>world.MultiplyVector(expected[i]-before[i]).magnitude<=1e-9).ToArray();
            evidence=D("vertices",count,"reorderedVertices",Enumerable.Range(0,count).Count(i=>mapping[i]!=i),"changedTriangleIndices",changedIndices,"maxPositionErrorMeters",max,
                "unaffectedVertices",unaffected.Length,"maxUnaffectedErrorMeters",unaffected.Length==0?0:unaffected.Max(i=>(double)world.MultiplyVector(before[i]-positions[mapping[i]]).magnitude),"uvAndWeightsTolerance",1e-6);
            result.RecalculateBounds();map=mapping;return result;
        }
        public static Mesh ExpandCandidate(Mesh source,Mesh actual,Vector3[] basis,Dictionary<string,Vector3[]> expectedFrames,float localTolerance)
        {
            // Match actual rendered corners, not vertex indices or a producer-written mapping pass.
            var sourceWeights=Weights(source);var actualWeights=Weights(actual);var uvSource=new List<Vector4>[8];var uvActual=new List<Vector4>[8];for(var c=0;c<8;c++){uvSource[c]=new List<Vector4>();uvActual[c]=new List<Vector4>();source.GetUVs(c,uvSource[c]);actual.GetUVs(c,uvActual[c]);Check((uvSource[c].Count==0)==(uvActual[c].Count==0),"Candidate UV channel coverage changed");}
            var positions=actual.vertices;var frames=new Dictionary<string,Vector3[]>();var frameNormals=new Dictionary<string,Vector3[]>();var frameTangents=new Dictionary<string,Vector3[]>();foreach(var key in expectedFrames){var index=actual.GetBlendShapeIndex(key.Key);Check(index>=0&&actual.GetBlendShapeFrameCount(index)==1&&Math.Abs(actual.GetBlendShapeFrameWeight(index,0)-100)<.0001,"Candidate runtime frame changed");var delta=new Vector3[actual.vertexCount];var normals=new Vector3[delta.Length];var tangents=new Vector3[delta.Length];actual.GetBlendShapeFrameVertices(index,0,delta,normals,tangents);frames[key.Key]=delta;frameNormals[key.Key]=normals;frameTangents[key.Key]=tangents;}
            Check(actual.blendShapeCount==expectedFrames.Count,"Candidate has undeclared runtime shape frames");
            Check(actual.normals.Length==actual.vertexCount&&((actual.tangents.Length==0)==(source.tangents.Length==0)),"Candidate normal/tangent coverage changed");
            bool Fits(int si,int ai){if(!Near(basis[si],positions[ai],localTolerance)||!SameWeights(sourceWeights[si],actualWeights[ai]))return false;for(var c=0;c<8;c++)if(uvSource[c].Count>0&&(uvSource[c][si]-uvActual[c][ai]).sqrMagnitude>1e-12)return false;foreach(var key in expectedFrames)if(!Near(key.Value[si],frames[key.Key][ai],localTolerance))return false;return true;}
            var vertexMap=Enumerable.Repeat(-1,source.vertexCount).ToArray();Check(source.subMeshCount==actual.subMeshCount,"Candidate material coverage differs");
            Check(localTolerance>0&&float.IsFinite(localTolerance),"Invalid local correspondence tolerance");
            (long,long,long) Cell(Vector3 p)=>((long)Math.Floor(p.x/localTolerance),(long)Math.Floor(p.y/localTolerance),(long)Math.Floor(p.z/localTolerance));var cells=new Dictionary<(long,long,long),List<int>>();for(var i=0;i<positions.Length;i++){var cell=Cell(positions[i]);if(!cells.ContainsKey(cell))cells[cell]=new List<int>();cells[cell].Add(i);}
            for(var sub=0;sub<source.subMeshCount;sub++)
            {
                Check(source.GetTopology(sub)==MeshTopology.Triangles&&actual.GetTopology(sub)==MeshTopology.Triangles,"Only rendered triangle mapping is implemented");var original=source.GetIndices(sub);var candidate=actual.GetIndices(sub);Check(original.Length==candidate.Length,"Candidate triangle coverage changed");var used=new bool[candidate.Length/3];var incident=new Dictionary<int,List<int>>();for(var t=0;t<candidate.Length;t++) {var id=candidate[t];if(!incident.ContainsKey(id))incident[id]=new List<int>();if(!incident[id].Contains(t/3))incident[id].Add(t/3);}
                for(var t=0;t<original.Length;t+=3)
                {
                    var nearby=new HashSet<int>();var cell=Cell(basis[original[t]]);for(var x=-1;x<=1;x++)for(var y=-1;y<=1;y++)for(var z=-1;z<=1;z++)if(cells.TryGetValue((cell.Item1+x,cell.Item2+y,cell.Item3+z),out var vertices))foreach(var id in vertices)if(Fits(original[t],id)&&incident.TryGetValue(id,out var faces))foreach(var face in faces)nearby.Add(face);
                    var match=-1;var turn=-1;foreach(var c in nearby)if(!used[c])for(var r=0;r<3;r++)if(Enumerable.Range(0,3).All(j=>Fits(original[t+j],candidate[c*3+(j+r)%3]))){Check(match<0,"Ambiguous actual candidate triangle correspondence");match=c;turn=r;}
                    Check(match>=0,"Actual candidate has no corresponding source face corner");used[match]=true;
                    for(var j=0;j<3;j++){var si=original[t+j];var ai=candidate[match*3+(j+turn)%3];if(vertexMap[si]>=0&&vertexMap[si]!=ai){var prior=vertexMap[si];Check(Near(actual.normals[prior],actual.normals[ai],1e-5f)&&((actual.tangents.Length==0)||((actual.tangents[prior]-actual.tangents[ai]).sqrMagnitude<1e-10)),"Candidate introduces an incompatible normal/tangent seam");foreach(var key in expectedFrames)Check(Near(frameNormals[key.Key][prior],frameNormals[key.Key][ai],1e-5f)&&Near(frameTangents[key.Key][prior],frameTangents[key.Key][ai],1e-5f),"Candidate introduces an incompatible shape-frame normal/tangent seam");}else vertexMap[si]=ai;}
                }
            }
            Check(vertexMap.All(i=>i>=0),"Source contains unobserved loose vertices requiring separate correspondence");
            var result=UnityEngine.Object.Instantiate(source);result.ClearBlendShapes();result.vertices=vertexMap.Select(i=>positions[i]).ToArray();if(actual.normals.Length>0)result.normals=vertexMap.Select(i=>actual.normals[i]).ToArray();if(actual.tangents.Length>0)result.tangents=vertexMap.Select(i=>actual.tangents[i]).ToArray();foreach(var key in expectedFrames){var index=actual.GetBlendShapeIndex(key.Key);var v=new Vector3[actual.vertexCount];var n=new Vector3[v.Length];var tangent=new Vector3[v.Length];actual.GetBlendShapeFrameVertices(index,0,v,n,tangent);result.AddBlendShapeFrame(key.Key,100,vertexMap.Select(i=>v[i]).ToArray(),vertexMap.Select(i=>n[i]).ToArray(),vertexMap.Select(i=>tangent[i]).ToArray());}result.RecalculateBounds();return result;
        }
    }
}
