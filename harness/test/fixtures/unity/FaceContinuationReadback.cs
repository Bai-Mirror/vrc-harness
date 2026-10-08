using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
    public static class FaceContinuationReadback
    {
        public static void Run() => Avh.Stage("continuation.readback", () => {
            Debug.Log("[CONTINUATION] entered " + DateTime.UtcNow.ToString("O"));
            FaceStage.ApplyManaged(); Debug.Log("[CONTINUATION] apply-complete " + DateTime.UtcNow.ToString("O")); AssetDatabase.SaveAssets(); AssetDatabase.Refresh();
            var source = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Source/avatar.prefab").GetComponentsInChildren<SkinnedMeshRenderer>(true).Single();
            var output = FaceStage.ValidatedOutput("Assets/Source/avatar.prefab");
            var actual = AssetDatabase.LoadAssetAtPath<GameObject>(output).GetComponentsInChildren<SkinnedMeshRenderer>(true).Single();
            var delta = new Vector3[source.sharedMesh.vertexCount];
            source.sharedMesh.GetBlendShapeFrameVertices(source.sharedMesh.GetBlendShapeIndex("ContourWidth"), 0, delta, null, null);
            var expectedWeight = float.Parse(Environment.GetEnvironmentVariable("AVH_EXPECTED_CONTOUR"), System.Globalization.CultureInfo.InvariantCulture);
            var expected = source.sharedMesh.vertices.Select((v,i)=>v+delta[i]*expectedWeight).ToArray();
            var measured = actual.sharedMesh.vertices;
            if (expected.Length != measured.Length || expected.Where((v,i)=>(v-measured[i]).magnitude>1e-6f).Any()) throw new Exception("Parent production prefab does not contain accepted contour values");
            var denominator=delta.Sum(v=>(double)v.sqrMagnitude);
            if(denominator<=0)throw new Exception("Fixture contour has no measurable displacement");
            var measuredWeight=delta.Select((v,i)=>(double)Vector3.Dot(measured[i]-source.sharedMesh.vertices[i],v)).Sum()/denominator;
            if (Math.Abs(actual.GetBlendShapeWeight(actual.sharedMesh.GetBlendShapeIndex("RuntimeA"))-25)>1e-3) throw new Exception("Protected expression default changed");
            Debug.Log("[CONTINUATION] readback-complete " + DateTime.UtcNow.ToString("O"));
            Avh.WriteJson(Avh.Abs("_harness/face/continuation-readback.json"), new Dictionary<string,object> {
                {"schema","observation/0.1"}, {"metrics",new Dictionary<string,object>{{"vertices_match",true}}},
                {"weight",measuredWeight}, {"output",output}, {"faceInputHash",Avh.ReadJsonFile(Avh.Abs(FaceStage.RecordPath)).Str("faceInputHash")},
                {"notes",new object[]{"Actual Unity source-frame and output vertex comparison; protected RuntimeA default retained"}}
            });
        });
    }
}
