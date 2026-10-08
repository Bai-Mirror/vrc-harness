// Counterexample fixture for the shared "which mesh is the body" criterion (task F12, order D-110). The test copies
// this file into the shipped AvatarAudit/Editor folder, so it runs in the same assembly as the internal criterion it
// exercises and against a synthetic hierarchy: no name below comes from a real avatar, and none of them is one of
// the two names the criterion used to compare against.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace AvatarAudit
{
    public static class BodyPickNamesIntegration
    {
        static int assertions;

        static void Require(bool ok, string message)
        {
            assertions++;
            if (!ok) throw new Exception("assertion " + assertions + ": " + message);
        }

        static Transform Child(string name, Transform parent)
        {
            var transform = new GameObject(name).transform;
            transform.SetParent(parent, false);
            return transform;
        }

        static string RegionOf(Transform bone)
        {
            if (bone == null) return "Other";
            switch (bone.name)
            {
                case "Hips": return "Hips";
                case "Chest": return "Chest";
                case "LeftFoot": return "LeftFoot";
                case "Head": return "Head";
                default: return "Other";
            }
        }

        /// <summary>A skinned mesh where every vertex is fully weighted to the bone `boneAt` returns.</summary>
        static SkinnedMeshRenderer Make(string name, Transform parent, Transform[] bones, int vertexCount, Func<int, int> boneAt)
        {
            var gameObject = new GameObject(name);
            gameObject.transform.SetParent(parent, false);
            var mesh = new Mesh();
            var vertices = new Vector3[vertexCount];
            var weights = new BoneWeight[vertexCount];
            for (int i = 0; i < vertexCount; i++)
            {
                vertices[i] = new Vector3(i * 0.01f, 0f, 0f);
                weights[i] = new BoneWeight { boneIndex0 = boneAt(i), weight0 = 1f };
            }
            mesh.vertices = vertices;
            mesh.boneWeights = weights;
            var bindposes = new Matrix4x4[bones.Length];
            for (int i = 0; i < bones.Length; i++) bindposes[i] = Matrix4x4.identity;
            mesh.bindposes = bindposes;
            var renderer = gameObject.AddComponent<SkinnedMeshRenderer>();
            renderer.bones = bones;
            renderer.sharedMesh = mesh;
            renderer.enabled = true;
            return renderer;
        }

        public static void Run()
        {
            bool ok = false;
            string error = null;
            try
            {
                // ── The name rule must follow the family root, not an enumeration of one development set's names.
                Require(AuditBodyPick.IsKnownBodyName("Body"), "the bare root is a body name");
                Require(AuditBodyPick.IsKnownBodyName("Body_base"), "the base suffix keeps the root");
                Require(AuditBodyPick.IsKnownBodyName("body_b"), "case does not matter");
                Require(AuditBodyPick.IsKnownBodyName("Body_base_2"), "a doubled suffix keeps the root");
                Require(AuditBodyPick.IsKnownBodyName("body.001"), "a dotted numeric suffix keeps the root");
                Require(AuditBodyPick.IsKnownBodyName("Body-b12"), "a dash and a b-number keeps the root");
                Require(AuditBodyPick.IsKnownBodyName("  Body_b  "), "surrounding space is trimmed");

                // A part whose name merely starts with the root is not the body: a prefix rule would swallow every
                // garment and accessory that happens to be named after the body part it covers.
                Require(!AuditBodyPick.IsKnownBodyName("BodyStocking_Mesh"), "a body-texture garment is not the body");
                Require(!AuditBodyPick.IsKnownBodyName("BodySuit"), "a word that starts with the root is not the root");
                Require(!AuditBodyPick.IsKnownBodyName("Hair_Long"), "an unrelated part is not the body");
                Require(!AuditBodyPick.IsKnownBodyName(""), "an empty name is not a body");
                Require(!AuditBodyPick.IsKnownBodyName(null), "a null name is not a body");

                // ── The same rule through the real entry point. `Body_base_2` carries the name of no development-set
                // asset; when the name tier compared literals it missed this body and the geometry tier picked the
                // garment with more vertices instead.
                var avatar = new GameObject("SyntheticAvatar");
                var hips = Child("Hips", avatar.transform);
                var chest = Child("Chest", avatar.transform);
                var foot = Child("LeftFoot", avatar.transform);
                var head = Child("Head", avatar.transform);
                var bodyBones = new[] { hips, chest, foot, head };
                var headOnly = new[] { head };

                var body = Make("Body_base_2", avatar.transform, bodyBones, 4, i => i < 2 ? i : 2);
                var garment = Make("Outfit_Long", avatar.transform, bodyBones, 40, i => i % 3);
                var faceNamedBody = Make("Body", avatar.transform, headOnly, 8, i => 0);

                var picked = AuditBodyPick.FindBodySmr(new List<SkinnedMeshRenderer> { faceNamedBody, garment, body }, RegionOf);
                Require(picked == body, "the body wins on its name, not on the garment's vertex count");
                picked = AuditBodyPick.FindBodySmr(new List<SkinnedMeshRenderer> { faceNamedBody, body }, RegionOf);
                Require(picked == body, "a face mesh named like the body must fail the weight gate, not win on vertices");

                // A body whose name the family-root rule does not normalise is not lost: the geometric fallback still
                // finds it by its bones. This is the boundary of the name rule, asserted as an outcome rather than as
                // a fixed answer for such a name, so extending the normalisation later does not break this check.
                var vendorNamed = Make("Body (1)", avatar.transform, bodyBones, 4, i => i);
                picked = AuditBodyPick.FindBodySmr(new List<SkinnedMeshRenderer> { faceNamedBody, vendorNamed }, RegionOf);
                Require(picked == vendorNamed, "a name the root rule does not normalise still reaches the geometric fallback");

                // ── D1: the geometric tier must ask the same skinning question the name tier asks. A garment whose
                // skeleton table lists every bone (Unity fills `bones` with the whole armature) but whose vertices are
                // all weighted to the torso is exactly the 48022-vertex skirt the probe used to take as the body.
                var torsoOnlyLoose = Make("Loose_Dress", avatar.transform, bodyBones, 400, i => i % 2);
                Require(AuditBodyPick.FindBodySmr(new List<SkinnedMeshRenderer> { torsoOnlyLoose }, RegionOf) == null,
                    "the geometric fallback must fail a mesh whose weights never reach the foot");

                // ── D1: nothing the Harness assembled under `_Outfit` is the base body, however body-like it looks.
                var outfitRoot = Child("_Outfit", avatar.transform);
                var assemblyGarment = Make("Dress_Skirt", outfitRoot, bodyBones, 400, i => i % 4);
                Require(AuditBodyPick.FindBodySmr(new List<SkinnedMeshRenderer> { assemblyGarment }, RegionOf) == null,
                    "an assembly-layer garment is never the body, even when it passes the weight gate");
                Require(AuditBodyPick.IsInAssemblyLayer(assemblyGarment.transform), "a renderer under _Outfit is in the assembly layer");
                var flattened = Child("_Outfit$Outfit_snowflake$Coat$31", avatar.transform);
                Require(AuditBodyPick.IsInAssemblyLayer(flattened), "the optimizer's flattened name still counts as the assembly layer");
                Require(!AuditBodyPick.IsInAssemblyLayer(Child("_OutfitExtra", avatar.transform)),
                    "a name that merely starts with the layer text is not the layer");

                // ── D1: identity from the body prefab decides the body, and the base body may be several meshes.
                var prefabLike = new GameObject("PrefabLike");
                var prefabBody = Make("Body", prefabLike.transform, bodyBones, 2, i => 0);
                var prefabBase = Make("Body_base_2", prefabLike.transform, bodyBones, 2, i => 0);
                Make("Hair_Long", prefabLike.transform, bodyBones, 2, i => 0);
                Make("Body_Stocking_x", prefabLike.transform, bodyBones, 2, i => 0);
                var identity = AuditBodyPick.BodyMeshNames(prefabLike);
                Require(identity.Count == 2 && identity.Contains("Body") && identity.Contains("Body_base_2"),
                    "the body prefab identity collects exactly the body-family renderers");
                var parts = AuditBodyPick.SelectBodyParts(
                    new List<SkinnedMeshRenderer> { faceNamedBody, body, torsoOnlyLoose }, identity);
                Require(parts.Count == 2 && parts.Contains(faceNamedBody) && parts.Contains(body),
                    "when the base body is split, every named part is the body and the assembly/other meshes are not");
                Require(AuditBodyPick.PrimaryBodyPart(parts, RegionOf) == body,
                    "the reported single body_path is the part that carries the torso, not the face");

                ok = true;
            }
            catch (Exception exception)
            {
                error = exception.ToString();
                Debug.LogException(exception);
            }
            Write(ok, error);
            EditorApplication.Exit(ok ? 0 : 1);
        }

        static void Write(bool ok, string error)
        {
            var project = Environment.GetEnvironmentVariable("AVH_PROJECT_DIR");
            var path = Path.Combine(string.IsNullOrEmpty(project) ? Directory.GetCurrentDirectory() : project, "result.json");
            var json = new StringBuilder();
            json.Append("{\"ok\":").Append(ok ? "true" : "false").Append(",\"assertions\":").Append(assertions);
            if (error != null)
                json.Append(",\"error\":\"").Append(error.Replace("\\", "\\\\").Replace("\"", "\\\"")
                    .Replace("\r", string.Empty).Replace("\n", "\\n")).Append('"');
            json.Append('}');
            File.WriteAllText(path, json.ToString());
        }
    }
}
