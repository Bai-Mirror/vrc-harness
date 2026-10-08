// Managed face candidate consumer. Source facts and output readback are Unity observations,
// never producer receipts or AI-written pass flags. No arbitrary host code is accepted.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Security.Cryptography;
using UnityEditor;
using UnityEngine;

namespace AVH.Harness
{
    public static class FaceStage
    {
        public const string ObservationPath = "_harness/face/observation.json";
        public const string InputPath = "Assets/_Harness/Face/design.json";
        public const string RecordPath = "_harness/face/output.json";
        const double Tolerance = 0.00002;
        static Dictionary<string, object> D(params object[] pairs)
        { var d = new Dictionary<string, object>(); for (var i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1]; return d; }
        public static string Hash(byte[] bytes) { using (var h = SHA256.Create()) return string.Concat(h.ComputeHash(bytes).Select(b => b.ToString("x2"))); }
        public static string FileHash(string relative) => Hash(File.ReadAllBytes(Avh.Abs(relative)));
        public static bool SourceMatches(Dictionary<string, object> source, string relative)
            => Avh.SameProjectFile(source.Str("path"), relative) && source.Str("sha256") == FileHash(relative);
        static string HashJson(object value) => Hash(System.Text.Encoding.UTF8.GetBytes(Avh.Json(value)));
        static void Check(bool ok, string message) { if (!ok) throw new InvalidOperationException(message); }
        static string PathOf(Transform t, Transform root) => t == null ? null : t == root ? "" : AnimationUtility.CalculateTransformPath(t, root);
        static List<object> V(IEnumerable<Vector3> values) => values.Select(v => (object)new object[] { v.x, v.y, v.z }).ToList();
        static List<object> Q(IEnumerable<Vector4> values) => values.Select(v => (object)new object[] { v.x, v.y, v.z, v.w }).ToList();
        static object Matrix(Matrix4x4 m) => Enumerable.Range(0, 16).Select(i => (object)m[i]).ToList();
        static string VHash(Vector3[] values)
        { using (var stream = new MemoryStream()) { using (var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, true)) foreach (var v in values) { writer.Write(v.x); writer.Write(v.y); writer.Write(v.z); } return Hash(stream.ToArray()); } }
        static double N(object n) { Check(n is float || n is double || n is int || n is long, "Numeric input required"); var v = Convert.ToDouble(n); Check(double.IsFinite(v), "Non-finite numeric input"); return v; }
        // Some authored Unity components use infinity as an unbounded setting.
        // Preserve its sign in hierarchy facts; geometry/input N remains finite.
        static object SerializedFloat(double value) {
            Check(!double.IsNaN(value), "NaN serialized prefab property");
            return double.IsInfinity(value) ? (object)D("serializedInfinity", value > 0 ? "positive" : "negative") : value;
        }
        static int I(object n) { var v = N(n); Check(v >= 0 && v <= int.MaxValue && v == Math.Floor(v), "Invalid integer input"); return (int)v; }
        static List<string> Strings(Dictionary<string, object> d, string key)
        { Check(d.TryGetValue(key, out object value) && value is IEnumerable && !(value is string), "String array required: " + key); return ((IEnumerable)value).Cast<object>().Select(x => x as string ?? throw new InvalidOperationException("String array required")).ToList(); }
        static Dictionary<string, object> Optional(Dictionary<string, object> d, string key)
        { if (!d.ContainsKey(key)) return new Dictionary<string, object>(); Check(d[key] is Dictionary<string, object>, "Object required: " + key); return (Dictionary<string, object>)d[key]; }
        static string SafePath(string value, string prefix = "Assets/")
        {
            Check(!string.IsNullOrEmpty(value) && value.StartsWith(prefix, StringComparison.Ordinal) && !value.Contains('\\'), "Input must be a managed project-relative path");
            var absolute = Path.GetFullPath(Avh.Abs(value));
            Check(absolute.StartsWith(Path.GetFullPath(Avh.Abs(prefix)).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "Path escapes managed root");
            Check(File.Exists(absolute), "Managed input does not exist");
            // A project-relative string is not permission to follow a link outside the project.
            Avh.AssertManagedPath(absolute);
            return value;
        }
        static void Folder(string path)
        { if (AssetDatabase.IsValidFolder(path)) return; var parent = Path.GetDirectoryName(path).Replace('\\', '/'); Folder(parent); AssetDatabase.CreateFolder(parent, Path.GetFileName(path)); }
        static Dictionary<string, object> FileIdentity(string path) => D("path", path, "sha256", FileHash(path), "metaSha256", File.Exists(Avh.Abs(path + ".meta")) ? FileHash(path + ".meta") : null);
        static Dictionary<string, object> AssetIdentity(UnityEngine.Object asset)
        {
            var path = AssetDatabase.GetAssetPath(asset); Check(!string.IsNullOrEmpty(path), "Persistent source asset required");
            AssetDatabase.TryGetGUIDAndLocalFileIdentifier(asset, out string guid, out long local);
            var d = FileIdentity(path); d["guid"] = guid; d["localId"] = local.ToString(System.Globalization.CultureInfo.InvariantCulture); d["dependencyHash"] = AssetDatabase.GetAssetDependencyHash(path).ToString(); return d;
        }
        public static Dictionary<string, object> MeshSnapshot(Mesh mesh)
        {
            Check(mesh != null, "Source mesh missing");
            if (!mesh.isReadable) return D("readable", false, "name", mesh.name, "vertexCount", mesh.vertexCount, "subMeshCount", mesh.subMeshCount,
                "keys", Enumerable.Range(0, mesh.blendShapeCount).Select(i => (object)D("name", mesh.GetBlendShapeName(i), "frames", Enumerable.Range(0, mesh.GetBlendShapeFrameCount(i)).Select(f => (object)D("weight", mesh.GetBlendShapeFrameWeight(i, f), "verticesSha256", null, "normalsSha256", null, "tangentsSha256", null)).ToList())).ToList());
            var keys = new List<object>();
            for (var i = 0; i < mesh.blendShapeCount; i++)
            {
                var frames = new List<object>();
                for (var f = 0; f < mesh.GetBlendShapeFrameCount(i); f++)
                { var v = new Vector3[mesh.vertexCount]; var n = new Vector3[v.Length]; var t = new Vector3[v.Length]; mesh.GetBlendShapeFrameVertices(i, f, v, n, t); frames.Add(D("weight", mesh.GetBlendShapeFrameWeight(i, f), "verticesSha256", VHash(v), "normalsSha256", VHash(n), "tangentsSha256", VHash(t), "affectedVertices", v.Count(d => d != Vector3.zero))); }
                keys.Add(D("name", mesh.GetBlendShapeName(i), "frames", frames));
            }
            var uv = new List<object>(); for (var i = 0; i < 8; i++) { var channel = new List<Vector4>(); mesh.GetUVs(i, channel); uv.Add(Q(channel)); }
            var sub = new List<object>(); for (var i = 0; i < mesh.subMeshCount; i++) sub.Add(D("topology", mesh.GetTopology(i).ToString(), "indices", mesh.GetIndices(i).Select(x => (object)x).ToList()));
            var perVertex = mesh.GetBonesPerVertex(); var all = mesh.GetAllBoneWeights();
            object weights;
            try { weights = D("counts", perVertex.Select(x => (object)(int)x).ToList(), "values", all.Select(x => (object)D("bone", x.boneIndex, "weight", x.weight)).ToList()); }
            finally { perVertex.Dispose(); all.Dispose(); }
            return D("readable", true, "name", mesh.name, "vertices", V(mesh.vertices), "normals", V(mesh.normals), "tangents", Q(mesh.tangents), "uv", uv,
                "colors", mesh.colors.Select(c => (object)new object[] { c.r, c.g, c.b, c.a }).ToList(), "submeshes", sub,
                "weights", weights, "bindposes", mesh.bindposes.Select(Matrix).ToList(), "keys", keys);
        }
        static object Member(object o, string name)
        { if (o == null) return null; var t = o.GetType(); return t.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(o) ?? t.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)?.GetValue(o); }
        static void SetMember(object o, string name, object value)
        { var t = o.GetType(); var f = t.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance); if (f != null) f.SetValue(o, value); else { var p = t.GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance); Check(p != null && p.CanWrite, "Observed writer cannot be remapped"); p.SetValue(o, value); } }
        static string RendererPath(object reference, Transform root)
        { if (reference is Component c) return PathOf(c.transform, root); if (reference is GameObject g) return PathOf(g.transform, root); return null; }
        static readonly Dictionary<Type,bool> RoleMethodChecks=new Dictionary<Type,bool>();
        static readonly Dictionary<string,string> RoleSourceHashes=new Dictionary<string,string>();
        static string RoleHash(string path){if(!RoleSourceHashes.TryGetValue(path,out var hash)){hash=FileHash(path);RoleSourceHashes[path]=hash;}return hash;}
        static bool NoManagedShapeCalls(Type type)
        {
            if(RoleMethodChecks.TryGetValue(type,out var cached))return cached;
            var codes=typeof(OpCodes).GetFields(BindingFlags.Public|BindingFlags.Static).Where(f=>f.FieldType==typeof(OpCode)).Select(f=>(OpCode)f.GetValue(null)).ToDictionary(c=>(ushort)c.Value);
            for(var t=type;t!=null&&t!=typeof(MonoBehaviour);t=t.BaseType)foreach(var method in t.GetMethods(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.Static|BindingFlags.DeclaredOnly).Cast<MethodBase>().Concat(t.GetConstructors(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.Static|BindingFlags.DeclaredOnly)))
            {
                var bytes=method.GetMethodBody()?.GetILAsByteArray();if(bytes==null)continue;
                for(var i=0;i<bytes.Length;)
                {
                    ushort op=bytes[i++];if(op==0xfe)op=(ushort)(0xfe00|bytes[i++]);if(!codes.TryGetValue(op,out var code))return false;
                    if(code.OperandType==OperandType.InlineMethod)
                    {
                        try{var member=method.Module.ResolveMethod(BitConverter.ToInt32(bytes,i),t.GetGenericArguments(),method is MethodInfo info?info.GetGenericArguments():Type.EmptyTypes);var owner=member.DeclaringType;
                            if((owner==typeof(SkinnedMeshRenderer)&&(member.Name=="SetBlendShapeWeight"||member.Name=="set_sharedMesh"))||owner==typeof(Mesh)&&(member.Name.StartsWith("Set")||member.Name.StartsWith("set_")||member.Name=="AddBlendShapeFrame"||member.Name=="ClearBlendShapes"))return false;
                        }catch{return false;}
                    }
                    switch(code.OperandType){case OperandType.InlineNone:break;case OperandType.ShortInlineBrTarget:case OperandType.ShortInlineI:case OperandType.ShortInlineVar:i++;break;case OperandType.InlineVar:i+=2;break;case OperandType.InlineI8:case OperandType.InlineR:i+=8;break;case OperandType.InlineSwitch:var n=BitConverter.ToInt32(bytes,i);i+=4+n*4;break;default:i+=4;break;}
                }
            }
            RoleMethodChecks[type]=true;return true;
        }
        static Dictionary<string,object> IndirectRole(Component c,Transform root)
        {
            var type=c.GetType();var name=type.FullName;string file=null;string role=null;string[] evidencePaths=null;
            if(name=="nadena.dev.modular_avatar.core.ModularAvatarConvertConstraints") {file="Packages/nadena.dev.modular-avatar/Runtime/ModularAvatarConvertConstraints.cs";role="constraint-conversion";evidencePaths=new[]{file,"Packages/nadena.dev.modular-avatar/Runtime/AvatarTagComponent.cs","Packages/nadena.dev.modular-avatar/Editor/OptimizationPasses/ConstraintConverterPass.cs"};}
            else if(name=="VRC.SDK3.Avatars.Components.VRCRaycast"){file="Packages/com.vrchat.avatars/Runtime/VRCSDK/Plugins/VRCSDK3A.dll";role="raycast-animator-parameters";evidencePaths=new[]{file,"Packages/nadena.dev.ndmf/Editor/VRChat/ParameterIntrospection/VRChatProviders/VRCRaycastParameterProvider.cs"};}
            else if(name=="VRC.SDK3.Dynamics.Contact.Components.VRCContactReceiver"||name=="VRC.SDK3.Dynamics.Contact.Components.VRCContactSender"){file="Packages/com.vrchat.base/Runtime/VRCSDK/Plugins/VRC.SDK3.Dynamics.Contact.dll";role=name.EndsWith("Receiver")?"contact-animator-parameter":"contact-signal-sender";evidencePaths=name.EndsWith("Receiver")?new[]{file,"Packages/nadena.dev.ndmf/Editor/VRChat/ParameterIntrospection/VRChatProviders/ContactParameterProvider.cs"}:new[]{file};}
            else if(name=="VRC.SDK3.Avatars.Components.VRCHeadChop"){file="Packages/com.vrchat.avatars/Runtime/VRCSDK/Plugins/VRCSDK3A.dll";role="first-person-bone-scale";evidencePaths=new[]{file};}
            else if(name=="VRC.SDK3.Dynamics.Constraint.Components.VRCParentConstraint"||name=="VRC.SDK3.Dynamics.Constraint.Components.VRCRotationConstraint"){file="Packages/com.vrchat.base/Runtime/VRCSDK/Plugins/VRC.SDK3.Dynamics.Constraint.dll";role=name.EndsWith("ParentConstraint")?"parent-transform-constraint":"rotation-transform-constraint";evidencePaths=new[]{file,"Packages/com.vrchat.base/Runtime/VRCSDK/Plugins/VRC.Dynamics.dll"};}
            if(file==null||!(c is MonoBehaviour behaviour))return null;
            var script=MonoScript.FromMonoBehaviour(behaviour);if(script==null||script.GetClass()!=type||AssetDatabase.GetAssetPath(script)!=file)return null;
            if(file.EndsWith(".dll")){var loaded=type.Assembly.Location;if(string.IsNullOrEmpty(loaded)||!File.Exists(loaded)||RoleHash(loaded)!=RoleHash(file))return null;}
            var transforms=role=="first-person-bone-scale"||role.EndsWith("-transform-constraint",StringComparison.Ordinal);
            if(transforms)for(var t=type;t!=null&&t!=typeof(MonoBehaviour);t=t.BaseType)
            {
                var expected=evidencePaths.SingleOrDefault(p=>Path.GetFileNameWithoutExtension(p)==t.Assembly.GetName().Name);
                if(expected==null||!File.Exists(Avh.Abs(expected))||!File.Exists(t.Assembly.Location)||RoleHash(t.Assembly.Location)!=RoleHash(expected))return null;
            }
            if(!NoManagedShapeCalls(type))return null;
            // A same-named replacement with renderer/mesh write capability is not this profile.
            for(var t=type;t!=null&&t!=typeof(MonoBehaviour);t=t.BaseType)foreach(var field in t.GetFields(BindingFlags.Public|BindingFlags.NonPublic|BindingFlags.Instance|BindingFlags.DeclaredOnly))if(typeof(SkinnedMeshRenderer).IsAssignableFrom(field.FieldType)||typeof(Mesh).IsAssignableFrom(field.FieldType))return null;
            var sources=evidencePaths.Where(p=>File.Exists(Avh.Abs(p))).Select(p=>(object)D("path",p,"sha256",RoleHash(p))).ToList();if(sources.Count==0)return null;
            if(transforms)
            {
                var bindings=new List<object>();var properties=new SerializedObject(c).GetIterator();
                while(properties.Next(true))if(properties.propertyType==SerializedPropertyType.ObjectReference&&properties.objectReferenceValue is Transform bone)bindings.Add(D("property",properties.propertyPath,"transform",PathOf(bone,root)));
                var targetTransform=Member(c,"TargetTransform") as Transform;
                return D("schema","face-component-role/0.1","profile","installed-sdk-indirect/1","type",name,"component",PathOf(c.transform,root),"role",role,"script",file,"assembly",type.Assembly.GetName().Name,"evidence",sources,
                    "directShapeWrite",false,"managedShapeCallScan","no direct Unity mesh/shape setter in declared type and base method/constructor bodies; external call graph and client execution are not measured",
                    "authority","https://creators.vrchat.com/"+(role=="first-person-bone-scale"?"avatars/avatar-components/vrc-headchop/":"common-components/constraints/"),
                    "transformBindings",bindings,"effectiveConstraintTarget",role=="first-person-bone-scale"?null:PathOf(targetTransform??c.transform,root),
                    "clientExecutionMeasured",false,"limitations","Component settings, bone bindings and transforms are preserved. Bone pose/scale and first-person visibility affect the rendered result; static shape validation does not verify VRChat client execution or accept appearance");
            }
            return D("schema","face-component-role/0.1","profile","installed-sdk-indirect/1","type",name,"component",PathOf(c.transform,root),"role",role,"script",file,"assembly",type.Assembly.GetName().Name,"evidence",sources,"directShapeWrite",false,"managedShapeCallScan","no direct Unity mesh/shape setter in declared type and base method/constructor bodies; external call graph and client execution are not measured","authority",role=="constraint-conversion"?"installed constraint conversion pass":"https://creators.vrchat.com/"+(role.StartsWith("contact")?"common-components/contacts/":"avatars/avatar-components/raycast/"),
                "parameter",Member(c,"parameter")??Member(c,"Parameter"),"clientExecutionMeasured",false,"limitations",role=="constraint-conversion"?"Constraint conversion and bone poses are preserved; client-time pose coverage is not established":"Signals/parameters are preserved; actual reachable controller blend bindings remain protected; VRChat client execution is not measured");
        }
        static List<object> Writers(GameObject avatar, SkinnedMeshRenderer renderer, out List<string> unknown,out List<object> componentRoles)
        {
            componentRoles=new List<object>();
            var controllers=new Dictionary<string,string[]>();
            var result = new List<object>(); unknown = new List<string>();
            var path = PathOf(renderer.transform, avatar.transform); var keys = Enumerable.Range(0, renderer.sharedMesh.blendShapeCount).Select(renderer.sharedMesh.GetBlendShapeName).ToArray();
            foreach (var c in avatar.GetComponentsInChildren<Component>(true))
            {
                if (c == null) { unknown.Add("Missing component"); continue; }
                var name = c.GetType().FullName;
                if (name == "VRC.SDK3.Avatars.Components.VRCAvatarDescriptor")
                {
                    if ((Member(c, "VisemeSkinnedMesh") as UnityEngine.Object) == renderer && Member(c, "VisemeBlendShapes") is IEnumerable visemes)
                        foreach (var key in visemes.Cast<object>().OfType<string>().Where(keys.Contains)) result.Add(D("kind", "descriptor-viseme", "component", PathOf(c.transform, avatar.transform), "key", key));
                    var mouth = Member(c, "MouthOpenBlendShapeName") as string;
                    if ((Member(c, "VisemeSkinnedMesh") as UnityEngine.Object) == renderer && keys.Contains(mouth)) result.Add(D("kind", "descriptor-jaw-flap", "component", PathOf(c.transform, avatar.transform), "key", mouth));
                    var eye = Member(c, "customEyeLookSettings");
                    if ((Member(eye, "eyelidsSkinnedMesh") as UnityEngine.Object) == renderer && Member(eye, "eyelidsBlendshapes") is IEnumerable lids)
                        foreach (var index in lids.Cast<object>().Select(x => Convert.ToInt32(x)).Where(x => x >= 0 && x < keys.Length)) result.Add(D("kind", "descriptor-eyelid-index", "component", PathOf(c.transform, avatar.transform), "key", keys[index], "index", index));
                }
                if (name == "nadena.dev.modular_avatar.core.ModularAvatarShapeChanger" && Member(c, "Shapes") is IEnumerable shapes)
                    foreach (var shape in shapes)
                    {
                        var reference = Member(shape, "Object"); var method = reference?.GetType().GetMethods().FirstOrDefault(m => m.Name == "Get" && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.IsAssignableFrom(c.GetType()));
                        var resolved = method?.Invoke(reference, new object[] { c }); var key = Member(shape, "ShapeName") as string;
                        if (reference != null && resolved == null) unknown.Add(name + ": unresolved shape target");
                        if (RendererPath(resolved, avatar.transform) == path && keys.Contains(key)) result.Add(D("kind", "modular-avatar-shape", "component", PathOf(c.transform, avatar.transform), "key", key, "mode", Convert.ToString(Member(shape, "ChangeType")), "value", Member(shape, "Value")));
                    }
                // Controllers reachable from the actual source components, not every imported clip.
                var serialized = new SerializedObject(c); var p = serialized.GetIterator();
                while (p.Next(true))
                {
                    if (p.propertyType != SerializedPropertyType.ObjectReference || !(p.objectReferenceValue is RuntimeAnimatorController controller)) continue;
                    RuntimeAnimatorController effective=controller;while(effective is AnimatorOverrideController overridden)effective=overridden.runtimeAnimatorController;
                    if(effective is UnityEditor.Animations.AnimatorController ac)controllers[AssetDatabase.GetAssetPath(controller)]=ac.parameters.Select(v=>v.name).ToArray();
                    Transform root = avatar.transform;
                    if (c is Animator animator) root = animator.transform;
                    else if (name == "nadena.dev.modular_avatar.core.ModularAvatarMergeAnimator")
                    {
                        if (Convert.ToString(Member(c, "pathMode")) == "Absolute") root = avatar.transform;
                        else { var relative = Member(c, "relativePathRoot"); var get = relative?.GetType().GetMethods().FirstOrDefault(m => m.Name == "Get" && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.IsAssignableFrom(c.GetType())); root = (get?.Invoke(relative, new object[] { c }) as GameObject)?.transform ?? c.transform; }
                    }
                    else if (name != "VRC.SDK3.Avatars.Components.VRCAvatarDescriptor") unknown.Add(name + ": controller root not resolved");
                    foreach (var clip in controller.animationClips.Distinct()) foreach (var binding in AnimationUtility.GetCurveBindings(clip))
                    {
                        if (binding.type != typeof(SkinnedMeshRenderer) || !binding.propertyName.StartsWith("blendShape.", StringComparison.Ordinal)) continue;
                        var target = binding.path == "" ? root : root.Find(binding.path); var key = binding.propertyName.Substring(11);
                        if (target != renderer.transform || !keys.Contains(key)) continue;
                        var curve = AnimationUtility.GetEditorCurve(clip, binding);
                        result.Add(D("kind", "animation", "component", PathOf(c.transform, avatar.transform), "key", key, "controller", AssetDatabase.GetAssetPath(controller), "clip", AssetDatabase.GetAssetPath(clip), "binding", binding.path,
                            "samples", curve == null ? null : curve.keys.Select(k => (object)D("time", k.time, "value", k.value, "inTangent", k.inTangent, "outTangent", k.outTangent)).ToList()));
                    }
                }
                var knownNoShapeWrite = new[] { "VRC.Core.PipelineManager", "nadena.dev.modular_avatar.core.ModularAvatarMergeArmature", "nadena.dev.modular_avatar.core.ModularAvatarBoneProxy", "nadena.dev.modular_avatar.core.ModularAvatarMenuInstaller", "nadena.dev.modular_avatar.core.ModularAvatarMenuItem", "nadena.dev.modular_avatar.core.ModularAvatarMenuGroup", "nadena.dev.modular_avatar.core.ModularAvatarParameters", "nadena.dev.modular_avatar.core.ModularAvatarMeshSettings", "nadena.dev.modular_avatar.core.ModularAvatarWorldFixedObject", "nadena.dev.modular_avatar.core.ModularAvatarVisibleHeadAccessory", "VRC.SDK3.Dynamics.PhysBone.Components.VRCPhysBone", "VRC.SDK3.Dynamics.PhysBone.Components.VRCPhysBoneCollider" };
                var indirect=IndirectRole(c,avatar.transform);if(indirect!=null)componentRoles.Add(indirect);
                if (c is MonoBehaviour && name != "VRC.SDK3.Avatars.Components.VRCAvatarDescriptor" && name != "nadena.dev.modular_avatar.core.ModularAvatarShapeChanger" && name != "nadena.dev.modular_avatar.core.ModularAvatarMergeAnimator" && !knownNoShapeWrite.Contains(name)&&indirect==null) unknown.Add(name + ": not evaluated as a shape writer");
            }
            foreach(var role in componentRoles.Cast<Dictionary<string,object>>())
            {
                var parameter=role.Str("parameter");role["controllerLinks"]=controllers.Where(v=>!string.IsNullOrEmpty(parameter)&&v.Value.Any(n=>n==parameter||role.Str("role")=="raycast-animator-parameters"&&n.StartsWith(parameter+"_",StringComparison.Ordinal)))
                    .Select(v=>(object)D("controller",v.Key,"parameters",v.Value.Where(n=>n==parameter||n.StartsWith(parameter+"_",StringComparison.Ordinal)).ToArray(),"protectedKeys",result.Cast<Dictionary<string,object>>().Where(w=>w.Str("kind")=="animation"&&w.Str("controller")==v.Key).Select(w=>w.Str("key")).Distinct().OrderBy(k=>k).ToArray(),"method","conservative reachable clip bindings; no claim of client-time state transition coverage")).ToList();
            }
            unknown = unknown.Distinct().OrderBy(x => x).ToList(); return result;
        }
        static Dictionary<string, object> Target(GameObject avatar, SkinnedMeshRenderer renderer)
        {
            var snapshot = MeshSnapshot(renderer.sharedMesh); List<string> unknown;List<object> componentRoles; var writers = Writers(avatar, renderer, out unknown,out componentRoles);
            var d = D("rendererPath", PathOf(renderer.transform, avatar.transform), "rendererIndex", Array.IndexOf(renderer.GetComponents<SkinnedMeshRenderer>(), renderer),
                "mesh", AssetIdentity(renderer.sharedMesh), "meshSnapshot", snapshot, "meshSha256", HashJson(snapshot),
                "worldMatrix", Matrix(renderer.transform.localToWorldMatrix), "bones", renderer.bones.Select(b => (object)PathOf(b, avatar.transform)).ToList(), "rootBone", PathOf(renderer.rootBone, avatar.transform),
                "materials", renderer.sharedMaterials.Select(m => (object)(m == null ? null : AssetIdentity(m))).ToList(),
                "defaultWeights", Enumerable.Range(0, renderer.sharedMesh.blendShapeCount).ToDictionary(i => renderer.sharedMesh.GetBlendShapeName(i), i => (object)renderer.GetBlendShapeWeight(i)),
                "writers", writers, "protectedKeys", writers.Cast<Dictionary<string, object>>().Select(w => w.Str("key")).Distinct().OrderBy(x => x).ToList(), "unmeasuredWriters", unknown);
            d["eyeObservation"] = FaceEyes.Observe(avatar, renderer, d.Str("meshSha256"));
            d["componentRoles"]=componentRoles;
            if(renderer.sharedMesh.isReadable)
            {
                var importer=AssetImporter.GetAtPath(AssetDatabase.GetAssetPath(renderer.sharedMesh)) as ModelImporter;
                var facts=D("schema","face-unity-frame-evidence/0.1","meshSha256",d.Str("meshSha256"),"sourceModel",d["mesh"],"rendererPath",d["rendererPath"],"rendererIndex",d["rendererIndex"],
                    "frames",FaceMapping.Frames(renderer.sharedMesh),"bones",renderer.bones.Select((b,i)=>(object)D("index",i,"name",b.name,"path",PathOf(b,avatar.transform),"parent",PathOf(b.parent,avatar.transform),"meshLocalPosition",V(new[]{renderer.transform.InverseTransformPoint(b.position)})[0])).ToList(),
                    "importer",importer==null?null:D("globalScale",importer.globalScale,"useFileScale",importer.useFileScale,"fileScale",importer.fileScale,"bakeAxisConversion",importer.bakeAxisConversion,"importNormals",importer.importNormals.ToString(),"importBlendShapeNormals",importer.importBlendShapeNormals.ToString(),"optimizeMeshVertices",importer.optimizeMeshVertices,"optimizeMeshPolygons",importer.optimizeMeshPolygons,
                        "skinWeights",importer.skinWeights.ToString(),"maxBonesPerVertex",importer.maxBonesPerVertex,"minBoneWeight",importer.minBoneWeight));
                var text=Avh.Json(facts);var hash=Hash(System.Text.Encoding.UTF8.GetBytes(text));var path="_harness/face/source-evidence/"+hash+".json";Directory.CreateDirectory(Path.GetDirectoryName(Avh.Abs(path)));
                if(File.Exists(Avh.Abs(path)))Check(FileHash(path)==hash,"Frozen source frame evidence changed");else File.WriteAllText(Avh.Abs(path),text,new System.Text.UTF8Encoding(false));
                d["frameEvidence"]=D("file",path,"sha256",hash);
            }
            d["targetId"] = HashJson(d); return d;
        }
        public static Dictionary<string, object> ObserveSource(string prefabPath)
        {
            RoleSourceHashes.Clear();RoleMethodChecks.Clear();
            SafePath(prefabPath); var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath); Check(prefab != null, "Source prefab does not load");
            var dependencies = AssetDatabase.GetDependencies(prefabPath, true).Where(p => p.StartsWith("Assets/", StringComparison.Ordinal) && File.Exists(Avh.Abs(p))).OrderBy(p => p).Select(p => (object)FileIdentity(p)).ToList();
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try { return D("schema", "face-unity-observation/0.1", "sourcePrefab", AssetIdentity(prefab), "dependencies", dependencies, "targets", instance.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(r => r.sharedMesh != null).Select(r => (object)Target(instance, r)).ToList()); }
            finally { UnityEngine.Object.DestroyImmediate(instance); }
        }
        public static void PrepareSource() => Avh.Stage("face.prepare-source", () => PrepareReadableSource(Avh.Plan()));
        public static void PrepareReadableSource(Dictionary<string, object> plan)
        {
            if (Optional(plan,"face").Str("mode") != "design") return;
            Check(!string.IsNullOrEmpty(Avh.Env("AVH_PROJECT_DIR")) && Path.GetFullPath(Avh.Abs("Assets")) == Path.GetFullPath(Application.dataPath), "Source preparation requires an explicit Runtime work-project binding");
            var sourcePath=SafePath(plan.Str("body_prefab"));var source=AssetDatabase.LoadAssetAtPath<GameObject>(sourcePath);Check(source!=null,"Body source does not load");
            var records=new List<object>();
            foreach(var path in source.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(r=>r.sharedMesh!=null).Select(r=>AssetDatabase.GetAssetPath(r.sharedMesh)).Where(p=>p.EndsWith(".fbx",StringComparison.OrdinalIgnoreCase)).Distinct().OrderBy(p=>p))
            {
                SafePath(path);var before=FileIdentity(path);var importer=AssetImporter.GetAtPath(path) as ModelImporter;Check(importer!=null,"Source FBX has no model importer");
                if(!importer.isReadable){importer.isReadable=true;importer.SaveAndReimport();}
                Check(FileHash(path)==before.Str("sha256"),"Source preparation changed original FBX bytes");records.Add(D("sourceBefore",before,"sourceAfter",FileIdentity(path),"readable",true));
            }
            Avh.WriteJson(Avh.Abs("_harness/face/preparation.json"),D("schema","face-preparation/0.1","sourcePrefab",sourcePath,"models",records,"scope","Runtime isolated work project; source model bytes preserved"));
        }
        public static void Observe() => Avh.Stage("face.observe", () => Avh.WriteJson(Avh.Abs(ObservationPath), ObserveSource(Avh.Plan().Str("body_prefab"))), false);
        static Dictionary<string, object> FrozenFile(Dictionary<string, object> input, string field)
        { var reference = input.Obj(field); var path = SafePath(reference.Str("file"), "Assets/_Harness/Face/"); Check(FileHash(path) == reference.Str("sha256"), "Changed frozen " + field); return Avh.ReadJsonFile(Avh.Abs(path)); }
        sealed class Prepared : IDisposable
        { public Dictionary<string, object> input, source, target, catalog, design, receipt; public string sourcePath, candidatePath, outputPath; public GameObject prefab; public SkinnedMeshRenderer renderer; public Mesh candidate; public Dictionary<string, string> map; public List<string> bake; public Vector3[] expected; public List<object> quality;
            public void Dispose(){if(candidate!=null&&string.IsNullOrEmpty(AssetDatabase.GetAssetPath(candidate))){UnityEngine.Object.DestroyImmediate(candidate);candidate=null;}}
        }
        static Prepared Prepare()
        {
            var input = Avh.ReadJsonFile(Avh.Abs(SafePath(InputPath, "Assets/_Harness/Face/"))); Check(input.Str("schema") == "face-unity-design/0.1", "Unsupported Unity face design");
            CheckRuntimeInput(input);
            Check(!input.ContainsKey("mode") || input.Str("mode") == "design", "Unsupported face design mode");
            Check(FileHash(ObservationPath) == input.Str("observationSha256"), "Stale Unity face observation");
            var observation = Avh.ReadJsonFile(Avh.Abs(ObservationPath)); var sourcePath = observation.Obj("sourcePrefab").Str("path");
            // Observed floats and reloaded JSON doubles can serialize equivalent
            // scientific notation differently. Normalize the fresh facts through
            // the same JSON reader; source hashes and all values remain exact.
            var current = ObserveSource(sourcePath); Check(Avh.Json(Avh.ParseJson(Avh.Json(current))) == Avh.Json(observation), "Source prefab, mesh, metadata, materials, bones or writers changed");
            var target = current.List("targets").Cast<Dictionary<string, object>>().SingleOrDefault(t => t.Str("targetId") == input.Str("targetId")); Check(target != null, "Unknown exact target identity");
            var catalog = FrozenFile(input, "blenderCatalog"); var design = FrozenFile(input, "blenderDesign"); var receipt = FrozenFile(input, "candidateReceipt");
            Check(catalog.Str("schema") == "face-catalog/0.1" && design.Str("schema") == "face-design/0.1" && receipt.Str("schema") == "face-candidate/0.1", "Unsupported Blender contract");
            Check(receipt.Str("designFileSha256") == input.Obj("blenderDesign").Str("sha256") && receipt.Str("revisionId") == design.Str("revisionId"), "Candidate targets another design revision");
            Check(design.Obj("units").Str("weights") == "blender-relative" && design.Obj("units").Str("geometry") == "meters", "Weight or geometry units mismatch");
            Check(design.Obj("source").Str("sha256") == catalog.Obj("source").Str("sha256") && receipt.Obj("source").Str("sha256") == catalog.Obj("source").Str("sha256") && design.Obj("source").Str("catalogSha256") == catalog.Str("catalogSha256"), "Blender source/catalog mismatch");
            var sourceModel = target.Obj("mesh").Str("path"); Check(sourceModel.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase), "Initial face consumer requires an observed FBX source");
            Dictionary<string,object> authority=null;Dictionary<string,object> effectiveEvidence=null;
            if(input.ContainsKey("sourceAuthority"))
            {
                authority=FrozenFile(input,"sourceAuthority");Check(authority.Str("schema")=="face-unity-imported-source/0.1"&&Avh.Json(authority.Obj("sourceModel"))==Avh.Json(target.Obj("mesh")),"Effective Blender source is not bound to the observed original Unity model");
                Check(Avh.Json(design.Obj("recipe").Obj("sourceAuthority"))==Avh.Json(input.Obj("sourceAuthority")),"Design source authority differs from its frozen consumer input");
                var effective=authority.Obj("effectiveSource");var effectivePath=SafePath(effective.Str("file"),"Assets/_Harness/Face/");Check(effectivePath.EndsWith(".blend",StringComparison.OrdinalIgnoreCase)&&FileHash(effectivePath)==effective.Str("sha256"),"Effective Blender source changed");
                Check(SourceMatches(catalog.Obj("source"),effectivePath)&&catalog.Obj("source").Str("sha256")==effective.Str("sha256"),"Effective catalog refers to another generated source");
                var originalCatalog=FrozenFile(authority,"originalBlenderCatalog");var originalEvidence=FrozenFile(authority,"originalBlenderEvidence");
                Check(SourceMatches(originalCatalog.Obj("source"),sourceModel)&&originalEvidence.Obj("source").Str("sha256")==FileHash(sourceModel)&&originalEvidence.Str("catalogSha256")==originalCatalog.Str("catalogSha256"),"Effective authority lost its immutable original FBX/Blender observations");
                effectiveEvidence=FrozenFile(authority,"effectiveEvidence");
            }
            else {Check(design.Obj("recipe").Obj("sourceAuthority")==null,"Design authority has no frozen consumer authority");Check(SourceMatches(catalog.Obj("source"),sourceModel), "Blender source is not the observed Unity source model");}
            var meshCatalog = catalog.List("meshes").Cast<Dictionary<string, object>>().SingleOrDefault(m => m.Str("meshId") == design.Obj("source").Str("meshId")); Check(meshCatalog != null, "Missing exact Blender source mesh");
            var candidateReference = receipt.Obj("outputs").Obj("fbx"); Check(candidateReference.Str("file") == "candidate.fbx", "Candidate filename must be fixed");
            var candidatePath = SafePath(Path.GetDirectoryName(input.Obj("candidateReceipt").Str("file")).Replace('\\', '/') + "/candidate.fbx", "Assets/_Harness/Face/Candidates/");
            Check(FileHash(candidatePath) == candidateReference.Str("sha256"), "Candidate FBX bytes changed");
            var native = input.Str("route") == "native-fbx/1";
            Check(!native || design.Str("route")=="native-fbx/1" && receipt.Str("route")=="native-fbx/1" && !input.ContainsKey("sourceAuthority") && !input.ContainsKey("sourceMapping"), "Native route cannot consume reconstructed source authority");
            var meshes = native ? new Mesh[0] : AssetDatabase.LoadAllAssetsAtPath(candidatePath).OfType<Mesh>().ToArray(); Check(native || meshes.Length == 1, "Candidate must contain one unambiguous mesh");
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(sourcePath); var transform = target.Str("rendererPath") == "" ? prefab.transform : prefab.transform.Find(target.Str("rendererPath"));
            var renderer = transform.GetComponents<SkinnedMeshRenderer>()[I(target["rendererIndex"])]; var mesh = renderer.sharedMesh;
            Check(mesh.isReadable && (native || meshes[0].isReadable), "Design source/candidate must be prepared as readable managed assets");
            if(!native) {
            var candidateModel = AssetDatabase.LoadAssetAtPath<GameObject>(candidatePath); var candidateRenderers = candidateModel.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(r => r.sharedMesh == meshes[0]).ToArray();
            Check(candidateRenderers.Length == 1, "Candidate mesh must have one explicit skin binding");
            Check(renderer.bones.Select(b => b == null ? null : b.name).SequenceEqual(candidateRenderers[0].bones.Select(b => b == null ? null : b.name)), "Candidate bone names/order differ from target binding");
            Check(renderer.sharedMaterials.Length == meshes[0].subMeshCount, "Candidate material slots do not match the target");
            }
            var map = input.Obj("keyMap").ToDictionary(k => k.Key, k => k.Value as string); var catalogKeys = meshCatalog.List("keys").Cast<Dictionary<string, object>>().ToArray();
            Check(map.Count == mesh.blendShapeCount && map.Values.Distinct().Count() == map.Count, "Complete one-to-one key mapping required");
            for (var i = 0; i < mesh.blendShapeCount; i++)
            {
                var name = mesh.GetBlendShapeName(i); Check(map.ContainsKey(name), "Unmapped Unity key");
                var key = catalogKeys.SingleOrDefault(k => k.Str("id") == map[name]); Check(key != null && key.Str("name") == name, "Key identity/name mismatch");
                Check(mesh.GetBlendShapeFrameCount(i) == 1 && Math.Abs(mesh.GetBlendShapeFrameWeight(i, 0) - 100) < .0001, "Multiframe or nonstandard frame weights observed but not executable in this slice");
            }
            var bakeIds = Strings(design, "bake"); var preserveIds = Strings(design, "preserve");
            Check(bakeIds.Count > 0 && bakeIds.Count + preserveIds.Count == map.Count && bakeIds.Concat(preserveIds).Distinct().Count() == map.Count && bakeIds.Concat(preserveIds).All(map.Values.Contains), "Complete bake/preserve partition required");
            Check(design.Obj("values").Keys.OrderBy(k=>k).SequenceEqual(bakeIds.OrderBy(k=>k)), "Design values must match the selected bake keys exactly");
            Check(Optional(design, "rangeOverrides").Keys.All(bakeIds.Contains), "Range override targets an unselected source key");
            var baked = map.Where(k => bakeIds.Contains(k.Value)).Select(k => k.Key).ToList();
            Check(!Strings(target, "protectedKeys").Intersect(baked).Any(), "A descriptor, animation or plugin writer owns a selected bake key");
            var expected = mesh.vertices; var values = design.Obj("values");
            foreach (var name in baked)
            {
                var id = map[name]; var key = catalogKeys.Single(k => k.Str("id") == id); Check(values.ContainsKey(id), "Missing design weight"); var amount = N(values[id]);
                var minimum = N(key["sliderMin"]); var maximum = N(key["sliderMax"]);
                if (Optional(design, "rangeOverrides").ContainsKey(id))
                {
                    var range = design.Obj("rangeOverrides").Obj(id); Check(N(range["originalMin"]) == minimum && N(range["originalMax"]) == maximum, "Range override does not bind observed source limits");
                    Check(N(range["newMin"]) <= minimum && N(range["newMax"]) >= maximum, "Range override must explicitly contain the original range"); minimum = N(range["newMin"]); maximum = N(range["newMax"]);
                    Check(Optional(design.Obj("recipe"), "compensation").Str("method") == "regional-additive", "Range expansion needs independent compensation and quality checks");
                }
                Check(amount >= minimum && amount <= maximum, "Design weight exceeds frozen source bounds");
                if (input.ContainsKey("weightsUnityPercent")) Check(input.Obj("weightsUnityPercent").ContainsKey(name) && Math.Abs(N(input.Obj("weightsUnityPercent")[name]) - amount * 100) < .0001, "Explicit Unity/Blender weight units differ");
                var v = new Vector3[mesh.vertexCount]; var n = new Vector3[v.Length]; var t = new Vector3[v.Length]; mesh.GetBlendShapeFrameVertices(mesh.GetBlendShapeIndex(name), 0, v, n, t);
                for (var i = 0; i < expected.Length; i++) expected[i] += v[i] * (float)amount;
            }
            Dictionary<string,object> nativeEvidence=null;
            var candidateMesh=native ? NativeImport(sourcePath,sourceModel,candidatePath,target,expected,out nativeEvidence) : meshes[0];
            if(native){prefab=AssetDatabase.LoadAssetAtPath<GameObject>(sourcePath);renderer=Find(prefab,target);mesh=renderer.sharedMesh;}
            Check(design.Obj("recipe").Obj("sourceCorrespondence")==null||input.ContainsKey("sourceMapping"),"Design source correspondence has no frozen consumer mapping");
            if(input.ContainsKey("sourceMapping")||authority!=null)
            {
                Dictionary<string,object> correspondence=null;Dictionary<string,object> blenderEvidence=null;
                if(authority==null){correspondence=FrozenFile(input,"sourceMapping");blenderEvidence=FrozenFile(correspondence,"blenderEvidence");Check(correspondence.Str("meshId")==meshCatalog.Str("meshId"),"Source mapping targets another Blender mesh");}
                else Check(!input.ContainsKey("sourceMapping"),"Imported source authority cannot masquerade as native Blender corner mapping");
                var sourceRefs=design.Obj("recipe").Obj("sourceCorrespondence");
                if(correspondence?.Obj("frameSemantics")!=null)Check(sourceRefs!=null,"Imported frame design lacks its Runtime source correspondence");
                if(sourceRefs!=null)
                {
                    Check(sourceRefs.Str("schema")=="face-source-correspondence/0.1"&&Path.GetFullPath(sourceRefs.Str("projectRoot"))==Path.GetFullPath(Avh.ProjectIdentityDir),"Design source correspondence targets another work project");
                    Check(Avh.Json(sourceRefs.Obj("sourceMapping"))==Avh.Json(input.Obj("sourceMapping"))&&Avh.Json(sourceRefs.Obj("blenderCatalog"))==Avh.Json(input.Obj("blenderCatalog")),"Design source correspondence differs from frozen consumer inputs");
                    Check(sourceRefs.Obj("observation").Str("file")==ObservationPath&&sourceRefs.Obj("observation").Str("sha256")==FileHash(ObservationPath),"Design source correspondence uses another observed source");
                }
                var frameRef=target.Obj("frameEvidence");Check(frameRef!=null&&FileHash(SafePath(frameRef.Str("file"),"_harness/face/source-evidence/"))==frameRef.Str("sha256"),"Frozen Unity frame evidence changed");
                if(authority==null)FaceMapping.VerifySource(mesh,correspondence,blenderEvidence,target,catalog,FileHash(ObservationPath),correspondence.Obj("blenderEvidence").Str("sha256"),renderer.bones.Select(b=>b.name).ToArray(),renderer.transform.localToWorldMatrix);
                else FaceMapping.VerifyImportedSource(mesh,authority,effectiveEvidence,target,catalog,meshCatalog.Str("meshId"),FileHash(ObservationPath),renderer.bones.Select(b=>b.name).ToArray(),renderer.transform.localToWorldMatrix);
                var intended=new Dictionary<string,Vector3[]>();var world=renderer.transform.localToWorldMatrix;var compensation=Optional(design.Obj("recipe"),"compensation");var transfer=compensation.Count>0?new FaceGeometry.Transfer(mesh.vertices.Select(world.MultiplyPoint3x4).ToArray(),expected.Select(world.MultiplyPoint3x4).ToArray(),compensation):null;
                for(var k=0;k<mesh.blendShapeCount;k++){var name=mesh.GetBlendShapeName(k);if(baked.Contains(name))continue;var delta=new Vector3[mesh.vertexCount];var scratch=new Vector3[delta.Length];mesh.GetBlendShapeFrameVertices(k,0,delta,scratch,scratch);double half;intended[name]=compensation.Count>0?FaceGeometry.Compensate(mesh.vertices,expected,delta,world,compensation,out half,transfer):delta;}
                var localTolerance=(float)(N(design.Obj("acceptance")["positionToleranceMeters"])/Math.Max(world.GetColumn(0).magnitude,Math.Max(world.GetColumn(1).magnitude,world.GetColumn(2).magnitude)));
                candidateMesh=FaceMapping.ExpandCandidate(mesh,candidateMesh,expected,intended,localTolerance);
            }
            List<object> quality;try{quality=CheckCandidate(mesh,candidateMesh,expected,baked,design,renderer.transform.localToWorldMatrix,renderer,native?meshCatalog:null);}catch{if(string.IsNullOrEmpty(AssetDatabase.GetAssetPath(candidateMesh)))UnityEngine.Object.DestroyImmediate(candidateMesh);throw;}
            if(native && design.Obj("recipe").Obj("compensation").Obj("quality").Str("findingPolicy")=="user-visual-review")
            {
                // The separate Blender readback covers exact disputed intersections;
                // Unity independently checks imported deltas and smoothness above.
                var verification=FrozenFile(input,"blenderVerification");
                Check(verification.Str("schema")=="face-verification/0.1"&&verification.Str("revisionId")==design.Str("revisionId")&&verification.Str("candidateFbxSha256")==FileHash(candidatePath),"Independent Blender quality targets another candidate");
                var readings=verification.Obj("compensation").List("quality").Cast<Dictionary<string,object>>().ToArray();
                var names=meshCatalog.List("keys").Cast<Dictionary<string,object>>().Skip(1).Select(k=>k.Str("name")).ToArray();
                Check(readings.Length==1+names.Length*2&&readings.All(r=>Equals(r["complete"],true)&&r["passed"] is bool)&&readings.Count(r=>r.Str("state")=="basis"&&!r.ContainsKey("weight"))==1&&names.All(name=>new[]{.5,1.0}.All(weight=>readings.Count(r=>r.Str("state")==name&&r.ContainsKey("weight")&&N(r["weight"])==weight)==1)),"Independent Blender quality state coverage is incomplete");
                quality.AddRange(readings.Select(r=>(object)new Dictionary<string,object>(r){{"observer","independent-blender-readback"}}));
            }
            if(nativeEvidence!=null)quality.Add(nativeEvidence);
            var outputPath = "Assets/_Harness/Face/Generated/" + HashJson(D("input", input, "observation", FileHash(ObservationPath))).Substring(0, 20) + "/Avatar.prefab";
            return new Prepared { input = input, source = current, target = target, catalog = catalog, design = design, receipt = receipt, sourcePath = sourcePath, candidatePath = candidatePath, outputPath = outputPath, prefab = prefab, renderer = renderer, candidate = candidateMesh, map = map, bake = baked, expected = expected, quality = quality };
        }
        // The old source stays authoritative for previews and recovery. The comparison
        // transaction imports the full new FBX at the identical path/GUID/settings,
        // reads actual Unity facts, and restores the old file in a finally block.
        // The preview prefab references the complete candidate FBX directly. After
        // user acceptance the managed delivery transaction replaces the original
        // FBX bytes while retaining its metadata; no Mesh.asset is generated.
        static GameObject NativeInstance(string path, List<Mesh> owned)
        {
            var go=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(path));
            PrefabUtility.UnpackPrefabInstance(go,PrefabUnpackMode.Completely,InteractionMode.AutomatedAction);
            foreach(var r in go.GetComponentsInChildren<SkinnedMeshRenderer>(true))if(r.sharedMesh!=null){var mesh=UnityEngine.Object.Instantiate(r.sharedMesh);mesh.name=r.sharedMesh.name;r.sharedMesh=mesh;owned.Add(mesh);}
            foreach(var a in go.GetComponentsInChildren<Animator>(true))a.enabled=false;
            foreach(var b in go.GetComponentsInChildren<MonoBehaviour>(true))if(b!=null)b.enabled=false;
            return go;
        }
        static object NativeReferences(GameObject go)
        {
            return go.GetComponentsInChildren<Transform>(true).Select(t=>(object)D("path",PathOf(t,go.transform),"components",t.GetComponents<Component>().Select(c=>{
                if(c==null)return (object)D("missingScript",true);var refs=new List<object>();var it=new SerializedObject(c).GetIterator();
                while(it.Next(true))if(it.propertyType==SerializedPropertyType.ObjectReference && !it.propertyPath.StartsWith("m_Prefab") && it.propertyPath!="m_CorrespondingSourceObject" && !(c is SkinnedMeshRenderer&&it.propertyPath=="m_Mesh")){
                    var value=it.objectReferenceValue;object identity=null;
                    if(value is Component child&&(child.transform==go.transform||child.transform.IsChildOf(go.transform)))identity=D("path",PathOf(child.transform,go.transform),"type",child.GetType().FullName,"index",Array.IndexOf(child.GetComponents(child.GetType()),child));
                    else if(value is GameObject item&&(item.transform==go.transform||item.transform.IsChildOf(go.transform)))identity=D("path",PathOf(item.transform,go.transform));
                    else if(value!=null&&AssetDatabase.TryGetGUIDAndLocalFileIdentifier(value,out string guid,out long id))identity=D("guid",guid,"localId",id);
                    refs.Add(D("property",it.propertyPath,"value",identity,"missing",value==null&&it.objectReferenceInstanceIDValue!=0));
                }
                return (object)D("type",c.GetType().FullName,"references",refs);
            }).ToList())).ToList();
        }
        static void NativeTransforms(GameObject before,GameObject after)
        {
            var old=before.GetComponentsInChildren<Transform>(true);var current=after.GetComponentsInChildren<Transform>(true);
            Check(old.Select(t=>PathOf(t,before.transform)).SequenceEqual(current.Select(t=>PathOf(t,after.transform))),"Native FBX transform hierarchy/name/order changed");
            for(var i=0;i<old.Length;i++){
                Check(old[i].gameObject.activeSelf==current[i].gameObject.activeSelf&&old[i].gameObject.layer==current[i].gameObject.layer&&old[i].gameObject.tag==current[i].gameObject.tag,"Native FBX object visibility/layer/tag changed: "+old[i].name);
                Check((old[i].localPosition-current[i].localPosition).magnitude<=1e-5&&(old[i].position-current[i].position).magnitude<=1e-5,"Native FBX local position changed: "+old[i].name);
                var qa=old[i].localRotation;var qb=current[i].localRotation;var dot=(double)qa.x*qb.x+(double)qa.y*qb.y+(double)qa.z*qb.z+(double)qa.w*qb.w;var na=(double)qa.x*qa.x+(double)qa.y*qa.y+(double)qa.z*qa.z+(double)qa.w*qa.w;var nb=(double)qb.x*qb.x+(double)qb.y*qb.y+(double)qb.z*qb.z+(double)qb.w*qb.w;
                Check(2*Math.Acos(Math.Min(1,Math.Abs(dot)/Math.Sqrt(na*nb)))<=1e-4,"Native FBX local rotation changed: "+old[i].name);
                Check((old[i].localScale-current[i].localScale).magnitude<=1e-4,"Native FBX local scale changed: "+old[i].name);
            }
        }
        static string[] NativeSdk(GameObject go)
        {
            var descriptor=go.GetComponentsInChildren<Component>(true).SingleOrDefault(c=>c!=null&&c.GetType().FullName=="VRC.SDK3.Avatars.Components.VRCAvatarDescriptor");
            if(descriptor==null)return null;
            Type Locate(string name)=>AppDomain.CurrentDomain.GetAssemblies().Select(a=>a.GetType(name)).FirstOrDefault(t=>t!=null);
            var stats=Locate("VRC.SDKBase.Validation.Performance.Stats.AvatarPerformanceStats");Check(stats!=null,"SDK performance validation unavailable");stats.GetMethod("Initialize",BindingFlags.Static|BindingFlags.Public).Invoke(null,null);
            var panelType=Locate("VRC.SDK3A.Editor.VRCSdkControlPanel")??Locate("VRC.SDKBase.Editor.VRCSdkControlPanel")??AppDomain.CurrentDomain.GetAssemblies().SelectMany(a=>{try{return a.GetTypes();}catch{return new Type[0];}}).FirstOrDefault(t=>t.Name=="VRCSdkControlPanel");
            var builderType=Locate("VRC.SDK3A.Editor.VRCSdkControlPanelAvatarBuilder");Check(panelType!=null&&builderType!=null,"Installed SDK avatar check unavailable");var panel=ScriptableObject.CreateInstance(panelType);
            try{
                panelType.GetMethod("ResetIssues").Invoke(panel,null);var builder=Activator.CreateInstance(builderType);builderType.GetField("_builder",BindingFlags.Instance|BindingFlags.NonPublic).SetValue(builder,panel);
                builderType.GetMethod("OnGUIAvatarCheck",BindingFlags.Instance|BindingFlags.NonPublic).Invoke(builder,new object[]{descriptor});
                var method=panelType.GetMethod("GetGuiErrorsOrIssuesForItem");var errors=new List<string>();foreach(var owner in new UnityEngine.Object[]{descriptor,panel})foreach(var issue in (IEnumerable)method.Invoke(panel,new object[]{owner}))errors.Add(Convert.ToString(Member(issue,"issueText")));
                return errors.OrderBy(v=>v,StringComparer.Ordinal).ToArray();
            }finally{UnityEngine.Object.DestroyImmediate(panel);}
        }
        static Vector3[] NativeBake(SkinnedMeshRenderer renderer)
        {
            var mesh=new Mesh();var values=Enumerable.Range(0,renderer.sharedMesh.blendShapeCount).Select(renderer.GetBlendShapeWeight).ToArray();
            try{for(var i=0;i<values.Length;i++)renderer.SetBlendShapeWeight(i,0);renderer.BakeMesh(mesh,false);
                // BakeMesh(false) excludes renderer scale; preserve its world orientation/translation.
                var world=renderer.transform.localToWorldMatrix;for(var c=0;c<3;c++){var column=world.GetColumn(c);var length=column.magnitude;Check(length>0,"Degenerate skinning scale");world.SetColumn(c,column/length);}return mesh.vertices.Select(world.MultiplyPoint3x4).ToArray();
            }finally{for(var i=0;i<values.Length;i++)renderer.SetBlendShapeWeight(i,values[i]);UnityEngine.Object.DestroyImmediate(mesh);}
        }
        static Mesh NativeImport(string prefabPath,string modelPath,string candidatePath,Dictionary<string,object> target,Vector3[] expected,out Dictionary<string,object> evidence)
        {
            const float geometryTolerance=1e-5f,skinTolerance=2e-5f;
            var owned=new List<Mesh>();GameObject before=null,after=null,oldModel=null,newModel=null;Mesh result=null;var model=Avh.Abs(modelPath);var meta=Avh.Abs(modelPath+".meta");
            var original=File.ReadAllBytes(model);var metadata=File.ReadAllBytes(meta);var candidate=File.ReadAllBytes(Avh.Abs(candidatePath));
            // Compact storage identity keeps Mono file I/O inside the Runtime's
            // project alias budget. Full hashes remain in the checked receipt.
            var directory="_harness/face/native-import/"+HashJson(D("source",Hash(original),"candidate",Hash(candidate),"poseRecipe","rest-pose-v1")).Substring(0,32);Directory.CreateDirectory(Avh.Abs(directory));
            var backup=directory+"/original.fbx";if(File.Exists(Avh.Abs(backup)))Check(FileHash(backup)==Hash(original),"Native import recovery backup changed");else File.WriteAllBytes(Avh.Abs(backup),original);
            var backupMeta=backup+".meta";if(File.Exists(Avh.Abs(backupMeta)))Check(FileHash(backupMeta)==Hash(metadata),"Native importer backup changed");else File.WriteAllBytes(Avh.Abs(backupMeta),metadata);
            var pending="_harness/face/native-import-pending.json";Check(!File.Exists(Avh.Abs(pending)),"Interrupted native import needs recovery before continuing");
            var prefabBytes=FileHash(prefabPath);var metaSha=Hash(metadata);var importer=EditorJsonUtility.ToJson(AssetImporter.GetAtPath(modelPath));
            Avh.WriteJson(Avh.Abs(directory+"/importer-before.json"),D("schema","face-native-importer/1","metadataSha256",metaSha,"importerJson",importer));
            try{
                before=NativeInstance(prefabPath,owned);oldModel=UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(modelPath));var oldRefs=NativeReferences(before);var oldSdk=NativeSdk(before);
                Func<GameObject,object> avatars=go=>go.GetComponentsInChildren<Animator>(true).Select(a=>(object)D("path",PathOf(a.transform,go.transform),"present",a.avatar!=null,"valid",a.avatar!=null&&a.avatar.isValid,"human",a.avatar!=null&&a.avatar.isHuman)).ToList();var oldAvatars=avatars(before);
                Avh.WriteJson(Avh.Abs(pending),D("schema","face-native-import-transaction/0.1","modelPath",modelPath,"backup",backup,"originalSha256",Hash(original),"candidateSha256",Hash(candidate),"metaSha256",metaSha));
                var next=Avh.Abs(directory+"/next.fbx");File.WriteAllBytes(next,candidate);File.Replace(next,model,null);AssetDatabase.ImportAsset(modelPath,ImportAssetOptions.ForceUpdate|ImportAssetOptions.ForceSynchronousImport);
                var candidateMetaSha=FileHash(modelPath+".meta");var candidateImporter=EditorJsonUtility.ToJson(AssetImporter.GetAtPath(modelPath));
                File.WriteAllBytes(Avh.Abs(directory+"/candidate-import.fbx.meta"),File.ReadAllBytes(meta));
                Avh.WriteJson(Avh.Abs(directory+"/importer-candidate.json"),D("schema","face-native-importer/1","metadataSha256",candidateMetaSha,"importerJson",candidateImporter,"metadataEqual",candidateMetaSha==metaSha,"settingsEqual",candidateImporter==importer));
                Check(candidateMetaSha==metaSha&&candidateImporter==importer,"Same-path native import changed importer metadata/settings");
                after=NativeInstance(prefabPath,owned);newModel=UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(modelPath));NativeTransforms(oldModel,newModel);NativeTransforms(before,after);Close(oldRefs,NativeReferences(after),"Native prefab/descriptor/PhysBone references");
                var newSdk=NativeSdk(after);Check((oldSdk==null)==(newSdk==null),"SDK descriptor availability changed");Check(newSdk==null||newSdk.GroupBy(v=>v).All(g=>g.Count()<=oldSdk.Count(v=>v==g.Key)),"Native FBX adds SDK avatar validation errors");
                Close(oldAvatars,avatars(after),"Native Humanoid Avatar validity");
                var oldRs=before.GetComponentsInChildren<SkinnedMeshRenderer>(true);var newRs=after.GetComponentsInChildren<SkinnedMeshRenderer>(true);Check(oldRs.Length==newRs.Length,"Native renderer inventory changed");var targetBefore=Find(before,target);var maps=new List<int[]>();var readings=new List<object>();
                for(var r=0;r<oldRs.Length;r++){
                    var a=oldRs[r];var b=newRs[r];Check(PathOf(a.transform,before.transform)==PathOf(b.transform,after.transform),"Native renderer path/order changed");Check(a.bones.Select(t=>PathOf(t,before.transform)).SequenceEqual(b.bones.Select(t=>PathOf(t,after.transform)))&&PathOf(a.rootBone,before.transform)==PathOf(b.rootBone,after.transform),"Native bones/root binding changed");
                    Check(a.sharedMesh!=null&&b.sharedMesh!=null,"Native renderer has missing mesh");Check(a.enabled==b.enabled,"Native renderer visibility changed");var wanted=a==targetBefore?expected:a.sharedMesh.vertices;
                    // Target design defaults are baked to zero and verified against the
                    // frozen design by the consumer; unrelated renderer defaults stay equal.
                    if(a!=targetBefore)Check(a.sharedMesh.blendShapeCount==b.sharedMesh.blendShapeCount&&Enumerable.Range(0,a.sharedMesh.blendShapeCount).All(k=>Math.Abs(a.GetBlendShapeWeight(k)-b.GetBlendShapeWeight(k))<=1e-6),"Native non-target default shape weights changed");
                    var ordered=FaceMapping.CompareImports(a.sharedMesh,b.sharedMesh,wanted,a.transform.localToWorldMatrix,geometryTolerance,out var map,out var reading);maps.Add(map);reading["renderer"]=PathOf(a.transform,before.transform);reading["unityVertexCorrespondence"]=map.Select(i=>(object)i).ToList();
                    reading["sourceMeshSha256"]=HashJson(MeshSnapshot(a.sharedMesh));reading["importedMeshSha256"]=HashJson(MeshSnapshot(b.sharedMesh));
                    reading["keyNames"]=Enumerable.Range(0,a.sharedMesh.blendShapeCount).Select(a.sharedMesh.GetBlendShapeName).ToArray();readings.Add(reading);
                    if(a==targetBefore){result=ordered;var planned=UnityEngine.Object.Instantiate(a.sharedMesh);planned.vertices=expected;owned.Add(planned);a.sharedMesh=planned;}
                    else{owned.Add(ordered);for(var k=0;k<a.sharedMesh.blendShapeCount;k++)for(var f=0;f<a.sharedMesh.GetBlendShapeFrameCount(k);f++){var av=new Vector3[a.sharedMesh.vertexCount];var bv=new Vector3[av.Length];var an=new Vector3[av.Length];var at=new Vector3[av.Length];var bn=new Vector3[av.Length];var bt=new Vector3[av.Length];a.sharedMesh.GetBlendShapeFrameVertices(k,f,av,an,at);ordered.GetBlendShapeFrameVertices(k,f,bv,bn,bt);Check(av.Zip(bv,(v,w)=>a.transform.TransformVector(v-w).magnitude).Max()<=geometryTolerance&&an.Zip(bn,(v,w)=>(v-w).magnitude).Max()<=1e-4&&at.Zip(bt,(v,w)=>(v-w).magnitude).Max()<=1e-4,"Non-target expression/frame normal/tangent changed");}}
                }
                var oldTransforms=before.GetComponentsInChildren<Transform>(true);var newTransforms=after.GetComponentsInChildren<Transform>(true);
                var oldRotations=oldTransforms.Select(t=>t.localRotation).ToArray();var newRotations=newTransforms.Select(t=>t.localRotation).ToArray();
                var oldPositions=oldTransforms.Select(t=>t.localPosition).ToArray();var newPositions=newTransforms.Select(t=>t.localPosition).ToArray();var oldScales=oldTransforms.Select(t=>t.localScale).ToArray();var newScales=newTransforms.Select(t=>t.localScale).ToArray();
                var oldRest=oldModel.GetComponentsInChildren<Transform>(true).ToDictionary(t=>PathOf(t,oldModel.transform));var newRest=newModel.GetComponentsInChildren<Transform>(true).ToDictionary(t=>PathOf(t,newModel.transform));
                Check(targetBefore.bones.All(t=>t!=null&&oldRest.ContainsKey(PathOf(t,before.transform))&&newRest.ContainsKey(PathOf(t,before.transform))),"Source FBX rest pose does not cover every target bone");
                var bones=new HashSet<Transform>(oldRs.SelectMany(r=>r.bones).Where(t=>t!=null));var poses=new List<object>();
                var offsets=new[]{Vector3.zero,Vector3.zero,new Vector3(15,0,0),new Vector3(0,-20,0),new Vector3(0,0,10)};
                for(var pose=0;pose<offsets.Length;pose++){
                    var axis=offsets[pose];
                    for(var i=0;i<oldTransforms.Length;i++){
                        var path=PathOf(oldTransforms[i],before.transform);var offset=bones.Contains(oldTransforms[i])?Quaternion.Euler(axis*(i%2==0?1:-1)):Quaternion.identity;
                        oldTransforms[i].localPosition=oldPositions[i];newTransforms[i].localPosition=newPositions[i];oldTransforms[i].localScale=oldScales[i];newTransforms[i].localScale=newScales[i];oldTransforms[i].localRotation=oldRotations[i]*offset;newTransforms[i].localRotation=newRotations[i]*offset;
                        // Use the two actual imported model rest transforms, not inverse
                        // bind matrices manufactured into poses that would cancel a defect.
                        if(pose==0&&oldRest.TryGetValue(path,out var a)&&newRest.TryGetValue(path,out var b)){
                            oldTransforms[i].localPosition=a.localPosition;oldTransforms[i].localRotation=a.localRotation;oldTransforms[i].localScale=a.localScale;
                            newTransforms[i].localPosition=b.localPosition;newTransforms[i].localRotation=b.localRotation;newTransforms[i].localScale=b.localScale;
                        }
                    }
                    var maximum=0d;for(var r=0;r<oldRs.Length;r++){var a=NativeBake(oldRs[r]);var b=NativeBake(newRs[r]);for(var i=0;i<a.Length;i++)maximum=Math.Max(maximum,(a[i]-b[maps[r][i]]).magnitude);}
                    var targetIndex=Array.IndexOf(oldRs,targetBefore);var plannedMesh=targetBefore.sharedMesh;targetBefore.sharedMesh=result;double delivery=0;
                    try{var output=NativeBake(targetBefore);var imported=NativeBake(newRs[targetIndex]);for(var i=0;i<output.Length;i++)delivery=Math.Max(delivery,(output[i]-imported[maps[targetIndex][i]]).magnitude);}finally{targetBefore.sharedMesh=plannedMesh;}
                    Check(delivery<=skinTolerance,"Generated original-rig skinning differs from imported candidate: "+delivery);
                    poses.Add(D("pose",pose==0?"source-fbx-rest":pose==1?"prefab-default":"alternating-bones","maxGeneratedSkinningErrorMeters",delivery,"allBoneAlternatingEulerDegrees",new object[]{axis.x,axis.y,axis.z},"maxSkinnedVertexErrorMeters",maximum));Check(maximum<=skinTolerance,"Native FBX skinning effect exceeds 0.02 mm in pose "+axis+": "+maximum);
                }
                evidence=D("schema","face-native-import-comparison/0.1","route","native-fbx/1","unityVersion",Application.unityVersion,"sourceSha256",Hash(original),"candidateSha256",Hash(candidate),"metaSha256",metaSha,
                    "geometryToleranceMeters",geometryTolerance,"skinningToleranceMeters",skinTolerance,"thresholdBasis","20 micrometers absorbs measured FBX round-trip noise while remaining below 0.1 mm facial changes; visible defects still require quality, eye and appearance gates",
                    "renderers",readings,"poses",poses,"sourceAvatars",oldAvatars,"importedAvatars",avatars(after),"sdkExecuted",newSdk!=null,"sdkBeforeErrors",oldSdk,"sdkAfterErrors",newSdk,"productionAccepted",false);
                var evidencePath=directory+"/comparison.json";
                if(File.Exists(Avh.Abs(evidencePath)))Check(Avh.Json(Avh.ReadJsonFile(Avh.Abs(evidencePath)))==Avh.Json(Avh.ParseJson(Avh.Json(evidence))),"Independent native import comparison differs from frozen evidence");else Avh.WriteJson(Avh.Abs(evidencePath),evidence);Check(result!=null,"Native target was not compared");return result;
            }catch{if(result!=null)UnityEngine.Object.DestroyImmediate(result);throw;}
            finally{
                var restore=Avh.Abs(directory+"/restore.fbx");File.WriteAllBytes(restore,original);File.Replace(restore,model,null);
                if(FileHash(modelPath+".meta")!=metaSha)File.WriteAllBytes(meta,metadata);
                AssetDatabase.ImportAsset(modelPath,ImportAssetOptions.ForceUpdate|ImportAssetOptions.ForceSynchronousImport);
                Avh.WriteJson(Avh.Abs(directory+"/importer-restored.json"),D("schema","face-native-importer/1","metadataSha256",FileHash(modelPath+".meta"),"importerJson",EditorJsonUtility.ToJson(AssetImporter.GetAtPath(modelPath))));
                Check(FileHash(modelPath)==Hash(original)&&FileHash(modelPath+".meta")==metaSha&&FileHash(prefabPath)==prefabBytes,"Native comparison failed to restore its source baseline");
                if(File.Exists(Avh.Abs(pending)))File.Delete(Avh.Abs(pending));
                foreach(var go in new[]{before,after,oldModel,newModel})if(go!=null)UnityEngine.Object.DestroyImmediate(go);foreach(var mesh in owned)if(mesh!=null)UnityEngine.Object.DestroyImmediate(mesh);
            }
        }

        static void Close(object a, object b, string label)
        {
            if (a is IDictionary da && b is IDictionary db) { Check(da.Count == db.Count, label + " field count differs"); foreach (DictionaryEntry e in da) { Check(db.Contains(e.Key), label + " missing field"); Close(e.Value, db[e.Key], label + "/" + e.Key); } return; }
            if (a is IEnumerable ea && b is IEnumerable eb && !(a is string) && !(b is string)) { var aa = ea.Cast<object>().ToArray(); var bb = eb.Cast<object>().ToArray(); Check(aa.Length == bb.Length, label + " array length differs"); for (var i = 0; i < aa.Length; i++) Close(aa[i], bb[i], label + "/" + i); return; }
            if (a is float || a is double || a is int || a is long) { Check(b != null && Math.Abs(N(a) - N(b)) <= Tolerance, label + " numeric mismatch"); return; }
            Check(Equals(a, b), label + " value mismatch");
        }
        static List<object> CheckCandidate(Mesh source, Mesh candidate, Vector3[] expected, List<string> baked, Dictionary<string, object> design, Matrix4x4 world, SkinnedMeshRenderer renderer = null, Dictionary<string,object> nativeSourceMesh=null)
        {
            var a = MeshSnapshot(source); var b = MeshSnapshot(candidate);
            var native=design.Str("route")=="native-fbx/1";
            if(!native)Close(a["submeshes"], b["submeshes"], "Topology/index order"); Close(a["uv"], b["uv"], "UV channels");
            Close(a["weights"], b["weights"], "Bone weights/order"); if(!native)Close(a["bindposes"], b["bindposes"], "Bindposes"); Close(a["colors"], b["colors"], "Vertex colors");
            Close(V(expected), b["vertices"], "Baked basis");
            var required = Enumerable.Range(0, source.blendShapeCount).Select(source.GetBlendShapeName).Where(k => native || !baked.Contains(k)).ToArray();
            Check(required.SequenceEqual(Enumerable.Range(0, candidate.blendShapeCount).Select(candidate.GetBlendShapeName)), "Runtime keys removed, renamed or reordered");
            var compensation = Optional(design.Obj("recipe"), "compensation"); var quality = new List<object>(); var vertices = source.vertices; var basis = candidate.vertices;
            var additive=compensation.Str("method")=="regional-additive" ? new FaceEyes.ExposureProfile(renderer,compensation,nativeSourceMesh) : null;
            var transfer = compensation.Count > 0 && additive==null ? new FaceGeometry.Transfer(vertices.Select(world.MultiplyPoint3x4).ToArray(), expected.Select(world.MultiplyPoint3x4).ToArray(), compensation) : null;
            var positionTolerance = N(design.Obj("acceptance")["positionToleranceMeters"]); var deltaTolerance = N(design.Obj("acceptance")["deltaToleranceMeters"]);
            Check(positionTolerance > 0 && positionTolerance <= .0001 && deltaTolerance > 0 && deltaTolerance <= .0001, "Invalid frozen geometry tolerance");
            for (var i = 0; i < expected.Length; i++) Check((world.MultiplyVector(expected[i] - basis[i])).magnitude <= positionTolerance, "Baked basis exceeds frozen meter tolerance");
            var retriangulated=native&&!source.triangles.SequenceEqual(candidate.triangles);
            if (compensation.Count > 0) { quality.Add(QualityState("basis", vertices, basis, source.triangles, world, compensation));
                if(retriangulated)quality.Add(QualityState("basis:imported-triangulation",vertices,basis,candidate.triangles,world,compensation)); }
            foreach (var name in required)
            {
                var si = source.GetBlendShapeIndex(name); var ci = candidate.GetBlendShapeIndex(name); Check(candidate.GetBlendShapeFrameCount(ci) == 1, "Candidate frame count changed");
                var sv = new Vector3[source.vertexCount]; var cv = new Vector3[candidate.vertexCount]; var sn = new Vector3[sv.Length]; var st = new Vector3[sv.Length]; var cn = new Vector3[cv.Length]; var ct = new Vector3[cv.Length];
                source.GetBlendShapeFrameVertices(si, 0, sv, sn, st); candidate.GetBlendShapeFrameVertices(ci, 0, cv, cn, ct);
                double half = 0; var intended = additive!=null ? additive.Compensate(name,expected,sv) : compensation.Count > 0 ? FaceGeometry.Compensate(vertices, expected, sv, world, compensation, out half, transfer) : sv;
                for (var i = 0; i < intended.Length; i++) Check(world.MultiplyVector(intended[i] - cv[i]).magnitude <= deltaTolerance, compensation.Count > 0 ? "Independent compensated runtime delta differs" : "Runtime relative delta differs");
                Close(source.GetBlendShapeFrameWeight(si, 0), candidate.GetBlendShapeFrameWeight(ci, 0), "Runtime frame weight");
                if (compensation.Count > 0)
                {
                    if(additive==null){half = FaceGeometry.ActualHalfError(vertices,basis,sv,cv,world,transfer); Check(half <= N(compensation["halfErrorToleranceMeters"]), "Actual FBX half-state exceeds frozen transfer error tolerance");}
                    else {for(var i=0;i<basis.Length;i++)half=Math.Max(half,world.MultiplyVector(basis[i]+cv[i]*.5f-expected[i]-intended[i]*.5f).magnitude);Check(half<=N(compensation["vertexToleranceMeters"]),"Actual additive half-state differs from source formula");}
                    foreach (var amount in new[] { .5f, 1f })
                    {
                        var before = vertices.Select((v,i) => v + sv[i] * amount).ToArray(); var after = basis.Select((v,i) => v + cv[i] * amount).ToArray();
                        var reading = QualityState(name + (amount == .5f ? ":half" : ":full"), before, after, source.triangles, world, compensation); reading["halfTransferErrorMeters"] = half; quality.Add(reading);
                        if(retriangulated)quality.Add(QualityState(name+":imported-triangulation:"+amount,before,after,candidate.triangles,world,compensation));
                    }
                }
            }
            return quality;
        }
        static Dictionary<string, object> QualityState(string state, Vector3[] source, Vector3[] actual, int[] triangles, Matrix4x4 world, Dictionary<string, object> recipe)
        {
            var reading = FaceGeometry.Quality(source.Select(world.MultiplyPoint3x4).ToArray(), actual.Select(world.MultiplyPoint3x4).ToArray(), triangles, recipe.Obj("quality"));
            if(recipe.Obj("quality").Str("findingPolicy")!="user-visual-review")Check(Equals(reading["passed"], true), "Independent face damage/smoothness check failed in state " + state);
            reading["complete"]=true;reading["needsUserReview"]=!Equals(reading["passed"],true);reading["state"] = state; return reading;
        }
        static SkinnedMeshRenderer Find(GameObject avatar, Dictionary<string, object> target)
        { var p = target.Str("rendererPath"); var t = p == "" ? avatar.transform : avatar.transform.Find(p); Check(t != null, "Output target disappeared"); var rs = t.GetComponents<SkinnedMeshRenderer>(); var i = I(target["rendererIndex"]); Check(i < rs.Length, "Output target renderer disappeared"); return rs[i]; }
        static void IndexedBindings(GameObject source, GameObject output, SkinnedMeshRenderer original, SkinnedMeshRenderer changed, Mesh newMesh, bool verifyAndRestore)
        {
            foreach (var descriptor in source.GetComponentsInChildren<Component>(true).Where(c => c != null && c.GetType().FullName == "VRC.SDK3.Avatars.Components.VRCAvatarDescriptor"))
            {
                var eye = Member(descriptor, "customEyeLookSettings"); if ((Member(eye, "eyelidsSkinnedMesh") as UnityEngine.Object) != original) continue;
                var indices = Member(eye, "eyelidsBlendshapes") as int[]; if (indices == null) continue;
                var path = PathOf(descriptor.transform, source.transform); var transform = path == "" ? output.transform : output.transform.Find(path); Check(transform != null, "Descriptor target disappeared");
                var actual = transform.GetComponent(descriptor.GetType()); Check(actual != null, "Descriptor component disappeared"); var outputEye = Member(actual, "customEyeLookSettings");
                Check((Member(outputEye, "eyelidsSkinnedMesh") as UnityEngine.Object) == changed, "Descriptor eyelid target changed");
                var mapped = indices.Select(i => i < 0 ? i : newMesh.GetBlendShapeIndex(original.sharedMesh.GetBlendShapeName(i))).ToArray();
                for (var i = 0; i < indices.Length; i++) Check(indices[i] < 0 || mapped[i] >= 0, "Runtime indexed eyelid key disappeared");
                if (verifyAndRestore) { Close(mapped.Select(x => (object)x).ToList(), (Member(outputEye, "eyelidsBlendshapes") as int[])?.Select(x => (object)x).ToList(), "Remapped descriptor eyelid indices"); SetMember(outputEye, "eyelidsBlendshapes", indices.ToArray()); }
                else SetMember(outputEye, "eyelidsBlendshapes", mapped);
                SetMember(actual, "customEyeLookSettings", outputEye);
            }
        }
        public static string ApplyManaged()
        {
            var initial = Avh.ReadJsonFile(Avh.Abs(SafePath(InputPath, "Assets/_Harness/Face/")));
            CheckRuntimeInput(initial);
            if (initial.Str("mode") == "preserve")
            {
                var source = PreservedSource(initial);
                Avh.WriteJson(Avh.Abs(RecordPath), D("schema", "face-unity-output/0.1", "mode", "preserve", "faceInputHash", initial.ContainsKey("faceInputHash") ? initial.Str("faceInputHash") : "", "inputSha256", FileHash(InputPath), "observationSha256", FileHash(ObservationPath), "sourcePrefab", source, "avatar", source, "status", "source_preserved", "productionAccepted", false));
                return source;
            }
            PrepareReadableCandidate(initial);
            using(var p = Prepare()) { Check(!File.Exists(Avh.Abs(p.outputPath)), "Generated output already exists; accepted or previous variants are never overwritten");
            var directory = Path.GetDirectoryName(p.outputPath).Replace('\\', '/'); Check(!Directory.Exists(Avh.Abs(directory)), "Generated output directory already exists"); Folder(directory);
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(p.prefab);
            try
            {
                var target = Find(instance, p.target);
                // Runtime only dispatches native FBX; historical evidence keeps its readback path.
                var model=AssetDatabase.LoadAssetAtPath<GameObject>(p.candidatePath);
                var meshes=model.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(r=>r.sharedMesh!=null&&(p.input.Str("route")!="native-fbx/1"||r.sharedMesh.name==p.renderer.sharedMesh.name)).ToArray();
                Check(meshes.Length==1,"Candidate FBX has no unique original face mesh");var mesh=meshes[0].sharedMesh;
                Check(meshes[0].bones.Select(b=>b.name).SequenceEqual(p.renderer.bones.Select(b=>b.name)),"Direct FBX bone indices changed");
                IndexedBindings(p.prefab, instance, p.renderer, target, mesh, false); target.sharedMesh = mesh; target.localBounds = mesh.bounds;
                target.sharedMaterials=p.renderer.sharedMaterials;
                for (var i = 0; i < mesh.blendShapeCount; i++) target.SetBlendShapeWeight(i, p.input.Str("route")=="native-fbx/1"&&p.bake.Contains(mesh.GetBlendShapeName(i))?0:p.renderer.GetBlendShapeWeight(p.renderer.sharedMesh.GetBlendShapeIndex(mesh.GetBlendShapeName(i))));
                PrefabUtility.SaveAsPrefabAsset(instance, p.outputPath); AssetDatabase.SaveAssets();
            }
            finally { UnityEngine.Object.DestroyImmediate(instance); }
            p.Dispose();
            var notes = new List<string>(); Check(VerifyOutput(p.outputPath, notes), "Independent output readback failed: " + string.Join(";", notes));
            Avh.WriteJson(Avh.Abs(RecordPath), D("schema", "face-unity-output/0.1", "mode", "design", "faceInputHash", initial.ContainsKey("faceInputHash") ? initial.Str("faceInputHash") : "", "inputSha256", FileHash(InputPath), "observationSha256", FileHash(ObservationPath), "sourcePrefab", p.sourcePath, "avatar", p.outputPath, "targetId", p.input.Str("targetId"), "candidateModel", FileIdentity(p.candidatePath), "deliveryMode", "native-fbx-reference", "status", "awaiting_user_acceptance", "productionAccepted", false));
            return p.outputPath;
            }
        }
        public static bool VerifyOutput(string avatarPath, List<string> notes)=>VerifyOutput(avatarPath,notes,null);
        static bool VerifyOutput(string avatarPath,List<string> notes,Prepared measured)
        {
            GameObject instance = null;Prepared prepared=null;
            try
            {
                var initial = Avh.ReadJsonFile(Avh.Abs(SafePath(InputPath, "Assets/_Harness/Face/")));
                if (initial.Str("mode") == "preserve") { Check(avatarPath == PreservedSource(initial), "Preserve output is not the frozen source"); return true; }
                var p = measured??Prepare();if(measured==null)prepared=p; Check(avatarPath == p.outputPath, "Output is not bound to this frozen revision"); SafePath(avatarPath, "Assets/_Harness/Face/");
                var loaded = AssetDatabase.LoadAssetAtPath<GameObject>(avatarPath); Check(loaded != null, "Output prefab does not load"); instance = (GameObject)PrefabUtility.InstantiatePrefab(loaded); var target = Find(instance, p.target);
                Check(AssetDatabase.GetAssetPath(target.sharedMesh)==p.candidatePath,"Output mesh must reference the complete candidate FBX directly");
                int[] actualMap;Dictionary<string,object> importedReading;
                Mesh ordered;
                if(p.input.Str("route")=="native-fbx/1")ordered=FaceMapping.CompareImports(p.renderer.sharedMesh,target.sharedMesh,p.expected,p.renderer.transform.localToWorldMatrix,.0001f,out actualMap,out importedReading);
                else {
                    var intended=new Dictionary<string,Vector3[]>();for(var k=0;k<p.candidate.blendShapeCount;k++){var d=new Vector3[p.candidate.vertexCount];var n=new Vector3[d.Length];var t=new Vector3[d.Length];p.candidate.GetBlendShapeFrameVertices(k,0,d,n,t);intended[p.candidate.GetBlendShapeName(k)]=d;}
                    ordered=FaceMapping.ExpandCandidate(p.renderer.sharedMesh,target.sharedMesh,p.expected,intended,(float)N(p.design.Obj("acceptance")["positionToleranceMeters"]));
                }
                try {var candidate=MeshSnapshot(p.candidate);var actual=MeshSnapshot(ordered);candidate["name"]=p.renderer.sharedMesh.name;actual["name"]=p.renderer.sharedMesh.name;Check(HashJson(candidate)==HashJson(actual),"Actual generated mesh differs from independently measured candidate facts");}
                finally{UnityEngine.Object.DestroyImmediate(ordered);}
                Close(V(new[] { target.localBounds.center, target.localBounds.extents }), V(new[] { p.candidate.bounds.center, p.candidate.bounds.extents }), "Generated face bounds");
                Close(target.bones.Select(b => (object)PathOf(b, instance.transform)).ToList(), p.target["bones"], "Original bone binding"); Check(PathOf(target.rootBone, instance.transform) == p.target.Str("rootBone"), "Root bone changed");
                Close(target.sharedMaterials.Select(m => (object)(m == null ? null : AssetIdentity(m))).ToList(), p.target["materials"], "Original materials");
                for (var i = 0; i < target.sharedMesh.blendShapeCount; i++) Check(Math.Abs(target.GetBlendShapeWeight(i) - (p.input.Str("route")=="native-fbx/1"&&p.bake.Contains(target.sharedMesh.GetBlendShapeName(i))?0:p.renderer.GetBlendShapeWeight(p.renderer.sharedMesh.GetBlendShapeIndex(target.sharedMesh.GetBlendShapeName(i))))) < .001, "Runtime default weight changed");
                // Revert only the authorized face binding in a temporary instance, then compare all
                // remaining serialized prefab facts to the source. No output receipt is consulted.
                IndexedBindings(p.prefab, instance, p.renderer, target, target.sharedMesh, true); target.sharedMesh = p.renderer.sharedMesh; target.localBounds = p.renderer.localBounds; for (var i = 0; i < target.sharedMesh.blendShapeCount; i++) target.SetBlendShapeWeight(i, p.renderer.GetBlendShapeWeight(i));
                Close(Hierarchy(instance), Hierarchy(p.prefab), "Unauthorised prefab override"); return true;
            }
            catch (Exception e) { notes.Add(e.Message); return false; }
            finally { if (instance != null) UnityEngine.Object.DestroyImmediate(instance);prepared?.Dispose(); }
        }
        static object Hierarchy(GameObject avatar)
        {
            var objects = new List<object>();
            foreach (var t in avatar.GetComponentsInChildren<Transform>(true))
            {
                var components = new List<object>();
                foreach (var c in t.GetComponents<Component>())
                {
                    if (c == null) { components.Add(null); continue; } var values = new Dictionary<string, object>(); var so = new SerializedObject(c); var p = so.GetIterator(); var enter = true;
                    while (p.Next(enter))
                    {
                        enter = p.propertyType == SerializedPropertyType.Generic;
                        if (p.propertyPath == "m_GameObject" || p.propertyPath == "m_ObjectHideFlags" || p.propertyPath.StartsWith("m_Prefab") || p.propertyPath == "m_CorrespondingSourceObject" || p.propertyPath == "m_RootOrder" || p.propertyPath.StartsWith("m_LocalEulerAnglesHint")) continue;
                        if (p.propertyType == SerializedPropertyType.ObjectReference)
                        {
                            var o = p.objectReferenceValue;
                            if (o is Component r && (r.transform == avatar.transform || r.transform.IsChildOf(avatar.transform))) values[p.propertyPath] = D("path", PathOf(r.transform, avatar.transform), "type", r.GetType().FullName, "index", Array.IndexOf(r.GetComponents(r.GetType()), r));
                            else if (o is GameObject g && (g.transform == avatar.transform || g.transform.IsChildOf(avatar.transform))) values[p.propertyPath] = D("path", PathOf(g.transform, avatar.transform));
                            else if (o != null && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out string guid, out long id)) values[p.propertyPath] = D("guid", guid, "id", id);
                            else values[p.propertyPath] = null;
                        }
                        else if (p.propertyType != SerializedPropertyType.Generic)
                        {
                            switch (p.propertyType)
                            {
                                case SerializedPropertyType.String: values[p.propertyPath] = p.stringValue; break;
                                case SerializedPropertyType.Integer: values[p.propertyPath] = p.longValue; break;
                                case SerializedPropertyType.Boolean: values[p.propertyPath] = p.boolValue; break;
                                case SerializedPropertyType.Float: values[p.propertyPath] = SerializedFloat(p.doubleValue); break;
                                case SerializedPropertyType.Enum: case SerializedPropertyType.ArraySize: case SerializedPropertyType.LayerMask: values[p.propertyPath] = p.intValue; break;
                                case SerializedPropertyType.Vector2: values[p.propertyPath] = new object[] { p.vector2Value.x, p.vector2Value.y }; break;
                                case SerializedPropertyType.Vector3: values[p.propertyPath] = V(new[] { p.vector3Value }); break;
                                case SerializedPropertyType.Vector4: values[p.propertyPath] = Q(new[] { p.vector4Value }); break;
                                case SerializedPropertyType.Quaternion: values[p.propertyPath] = Q(new[] { new Vector4(p.quaternionValue.x, p.quaternionValue.y, p.quaternionValue.z, p.quaternionValue.w) }); break;
                                case SerializedPropertyType.Color: values[p.propertyPath] = Q(new[] { (Vector4)p.colorValue }); break;
                                case SerializedPropertyType.Bounds: values[p.propertyPath] = V(new[] { p.boundsValue.center, p.boundsValue.extents }); break;
                                case SerializedPropertyType.Rect: var r = p.rectValue; values[p.propertyPath] = new object[] { r.x, r.y, r.width, r.height }; break;
                                case SerializedPropertyType.AnimationCurve: values[p.propertyPath] = p.animationCurveValue.keys.Select(k => (object)new object[] { k.time, k.value, k.inTangent, k.outTangent }).ToList(); break;
                                case SerializedPropertyType.Gradient:
                                    var gradient = p.gradientValue;
                                    values[p.propertyPath] = D("mode", (int)gradient.mode, "colorSpace", (int)gradient.colorSpace,
                                        "colors", gradient.colorKeys.Select(k => (object)new object[] { k.time, k.color.r, k.color.g, k.color.b, k.color.a }).ToList(),
                                        "alphas", gradient.alphaKeys.Select(k => (object)new object[] { k.time, k.alpha }).ToList()); break;
                                default: throw new InvalidOperationException("Unmeasured serialized prefab property " + p.propertyPath + " (" + p.propertyType + ")");
                            }
                        }
                    }
                    components.Add(D("type", c.GetType().FullName, "values", values));
                }
                objects.Add(D("path", PathOf(t, avatar.transform), "active", t.gameObject.activeSelf, "layer", t.gameObject.layer, "tag", t.gameObject.tag, "components", components));
            }
            return objects;
        }
        public static void Apply() => Avh.Stage("face.apply", () => { ApplyManaged(); WriteMeasurement(); });
        public static void Measure() => Avh.Stage("face.measure", WriteMeasurement, false);
        public static string ValidatedOutput(string originalPrefab)
        {
            if (!File.Exists(Avh.Abs(RecordPath))) return originalPrefab;
            var record = CheckedRecord(originalPrefab);
            var notes = new List<string>(); Check(VerifyOutput(record.Str("avatar"), notes), "Face output failed independent verification: " + string.Join(";", notes));
            return record.Str("avatar");
        }
        static Dictionary<string,object> CheckedRecord(string originalPrefab)
        {
            var record=Avh.ReadJsonFile(Avh.Abs(RecordPath));
            Check(record.Str("schema") == "face-unity-output/0.1" && record.Str("sourcePrefab") == originalPrefab, "Face output is bound to another source");
            Check(record.Str("inputSha256") == FileHash(InputPath) && record.Str("observationSha256") == FileHash(ObservationPath), "Face output input/observation revision changed");
            var input = Avh.ReadJsonFile(Avh.Abs(InputPath)); var mode = input.Str("mode") == "preserve" ? "preserve" : "design";
            Check(record.Str("mode") == mode, "Face output mode differs from its frozen input");
            if(mode=="design") {var model=record.Obj("candidateModel");Check(model!=null,"Face output has no frozen candidate import identity");SafePath(model.Str("path"),"Assets/_Harness/Face/Candidates/");Check(Avh.Json(FileIdentity(model.Str("path")))==Avh.Json(model),"Candidate model or importer metadata changed after application");}
            return record;
        }
        static void PrepareReadableCandidate(Dictionary<string,object> input)
        {
            // The new candidate is generated inside its own allocated directory. Metadata can be
            // prepared once before output verification; accepted candidate imports are immutable.
            var receipt=FrozenFile(input,"candidateReceipt");Check(receipt.Obj("outputs").Obj("fbx").Str("file")=="candidate.fbx","Candidate filename must be fixed");
            var path=SafePath(Path.GetDirectoryName(input.Obj("candidateReceipt").Str("file")).Replace('\\','/')+"/candidate.fbx","Assets/_Harness/Face/Candidates/");
            Check(FileHash(path)==receipt.Obj("outputs").Obj("fbx").Str("sha256"),"Changed candidate FBX bytes");
            var importer=AssetImporter.GetAtPath(path) as ModelImporter;if(importer==null){AssetDatabase.ImportAsset(path,ImportAssetOptions.ForceSynchronousImport);importer=AssetImporter.GetAtPath(path) as ModelImporter;}Check(importer!=null,"Candidate model importer missing");
            if(File.Exists(Avh.Abs(RecordPath)))
            {
                var existing=Avh.ReadJsonFile(Avh.Abs(RecordPath));
                if(existing.Obj("candidateModel")?.Str("path")==path){Check(Avh.Json(existing.Obj("candidateModel"))==Avh.Json(FileIdentity(path))&&importer.isReadable,"Existing output importer is immutable");return;}
            }
            if(input.Str("route")=="native-fbx/1")
            {
                var observed=Avh.ReadJsonFile(Avh.Abs(ObservationPath));var target=observed.List("targets").Cast<Dictionary<string,object>>().Single(t=>t.Str("targetId")==input.Str("targetId"));
                var source=AssetImporter.GetAtPath(target.Obj("mesh").Str("path")) as ModelImporter;Check(source!=null,"Source model importer is unavailable");
                // ModelImporter JSON overwrite omits settings such as blend-shape
                // normals and material remaps. Copy actual metadata while keeping
                // the candidate GUID; otherwise the preview may split new vertices.
                var metadata=System.Text.Encoding.UTF8.GetString(File.ReadAllBytes(Avh.Abs(target.Obj("mesh").Str("path")+".meta")));
                var guid=AssetDatabase.AssetPathToGUID(path);Check(guid.Length==32,"Candidate import identity is missing");
                var matches=System.Text.RegularExpressions.Regex.Matches(metadata,@"(?m)^guid: ([a-f0-9]{32})\r?$");Check(matches.Count==1,"Source importer GUID is ambiguous");
                var span=matches[0].Groups[1];metadata=metadata.Remove(span.Index,span.Length).Insert(span.Index,guid);
                var bytes=System.Text.Encoding.UTF8.GetBytes(metadata);
                if(!File.ReadAllBytes(Avh.Abs(path+".meta")).SequenceEqual(bytes)){
                    File.WriteAllBytes(Avh.Abs(path+".meta"),bytes);AssetDatabase.ImportAsset(path,ImportAssetOptions.ForceUpdate|ImportAssetOptions.ForceSynchronousImport);
                    importer=AssetImporter.GetAtPath(path) as ModelImporter;Check(importer!=null,"Copied candidate importer did not load");
                }
            }
            if(!importer.isReadable)
            {
                if(File.Exists(Avh.Abs(RecordPath))) {var previous=Avh.ReadJsonFile(Avh.Abs(RecordPath));Check(previous.Obj("candidateModel")?.Str("path")!=path,"Existing output owns this candidate importer; metadata is immutable");}
                importer.isReadable=true;importer.SaveAndReimport();
            }
        }
        static void CheckRuntimeInput(Dictionary<string, object> input)
        {
            var expected = Environment.GetEnvironmentVariable("AVH_FACE_INPUT_HASH");
            if (!string.IsNullOrEmpty(expected)) Check(input.ContainsKey("faceInputHash") && input.Str("faceInputHash") == expected, "Face input differs from frozen Runtime input");
        }
        static string PreservedSource(Dictionary<string, object> input)
        {
            CheckRuntimeInput(input);
            Check(input.Str("schema") == "face-unity-design/0.1" && input.Str("mode") == "preserve", "Invalid preserve contract");
            Check(input.Str("observationSha256") == FileHash(ObservationPath), "Stale preserve source observation");
            var observed = Avh.ReadJsonFile(Avh.Abs(ObservationPath)); var path = observed.Obj("sourcePrefab").Str("path");
            // Name the first differing field. Comparing whole documents by value is right, but reporting only
            // that something changed leaves a person unable to act: on a real project every recorded file
            // hash still matched on disk, so the difference was somewhere in the structure and could not be
            // found from outside. A path makes the next run diagnosable.
            var difference = FirstJsonDifference(observed, ObserveSource(path), "");
            Check(difference == null, "Preserve source or dependency changed: " + difference); return path;
        }

        /// <summary>The first path at which two JSON-shaped values differ, or null when they are equal.</summary>
        static string FirstJsonDifference(object left, object right, string at)
        {
            if (left is Dictionary<string, object> a)
            {
                if (!(right is Dictionary<string, object> b)) return $"{at} is no longer an object";
                foreach (var key in a.Keys.Union(b.Keys).OrderBy(k => k, StringComparer.Ordinal))
                {
                    var hasA = a.TryGetValue(key, out var va); var hasB = b.TryGetValue(key, out var vb);
                    if (!hasA) return $"{at}.{key} appeared";
                    if (!hasB) return $"{at}.{key} disappeared";
                    var inner = FirstJsonDifference(va, vb, $"{at}.{key}");
                    if (inner != null) return inner;
                }
                return null;
            }
            if (left is System.Collections.IList la)
            {
                if (!(right is System.Collections.IList lb)) return $"{at} is no longer a list";
                if (la.Count != lb.Count) return $"{at} count {la.Count} became {lb.Count}";
                for (var i = 0; i < la.Count; i++)
                {
                    var inner = FirstJsonDifference(la[i], lb[i], $"{at}[{i}]");
                    if (inner != null) return inner;
                }
                return null;
            }
            // Numbers compare by value, not by text. A measured component can be carried as float on one
            // side and double on the other, and the serializer prints those differently (0.37877363 against
            // 0.37877362999999997), so a text comparison reports a change where the value is identical. That
            // happened on a real project and blocked this stage on an untouched source.
            if (IsNumber(left) && IsNumber(right))
            {
                var x = Convert.ToDouble(left); var y = Convert.ToDouble(right);
                var scale = Math.Max(Math.Abs(x), Math.Abs(y));
                // The absolute floor matters as much as the relative term: near zero the relative term
                // vanishes and two representations of one measurement would look different again.
                if (x == y || Math.Abs(x - y) <= scale * NumberTolerance + NumberFloor) return null;
                return $"{at} {Shorten(Avh.Json(left))} became {Shorten(Avh.Json(right))}";
            }
            var leftText = Avh.Json(left); var rightText = Avh.Json(right);
            return leftText == rightText ? null : $"{at} {Shorten(leftText)} became {Shorten(rightText)}";
        }

        /// <summary>
        /// Relative tolerance for comparing measured numbers. Float carries about seven significant decimal
        /// digits, so anything at or below this is the same measurement seen through a different type.
        /// </summary>
        const double NumberTolerance = 1e-6;

        /// <summary>Absolute floor, so a value at or near zero is still compared with some slack.</summary>
        const double NumberFloor = 1e-9;

        static bool IsNumber(object value) => value is float or double or int or long or short or byte or uint or ulong or sbyte or ushort;

        static string Shorten(string text) => text.Length <= 60 ? text : text.Substring(0, 57) + "...";

        sealed class HeadSurface
        {
            public sealed class Triangle { public Vector3 a,b,c; public Bounds bounds; public Vector3 center; }
            sealed class Node { public Bounds bounds; public Node left,right; public Triangle[] leaf; }
            readonly Node tree;
            static Node Build(Triangle[] triangles)
            {
                if(triangles.Length==0)return null;var bounds=triangles[0].bounds;foreach(var t in triangles)bounds.Encapsulate(t.bounds);
                var node=new Node{bounds=bounds};if(triangles.Length<=12){node.leaf=triangles;return node;}
                var size=bounds.size;var axis=size.x>=size.y&&size.x>=size.z?0:size.y>=size.z?1:2;
                Array.Sort(triangles,(a,b)=>a.center[axis].CompareTo(b.center[axis]));var half=triangles.Length/2;
                node.left=Build(triangles.Take(half).ToArray());node.right=Build(triangles.Skip(half).ToArray());return node;
            }
            public HeadSurface(Vector3[] vertices,int[] indices)
            {
                var rows=new List<Triangle>();for(var i=0;i<indices.Length;i+=3){var a=vertices[indices[i]];var b=vertices[indices[i+1]];var c=vertices[indices[i+2]];var bounds=new Bounds(a,Vector3.zero);bounds.Encapsulate(b);bounds.Encapsulate(c);rows.Add(new Triangle{a=a,b=b,c=c,bounds=bounds,center=(a+b+c)/3});}tree=Build(rows.ToArray());
            }
            static Vector3 Segment(Vector3 p,Vector3 a,Vector3 b){var d=b-a;return a+d*(d.sqrMagnitude==0?0:Mathf.Clamp01(Vector3.Dot(p-a,d)/d.sqrMagnitude));}
            static float Distance(Vector3 p,Triangle t)
            {
                var ab=t.b-t.a;var ac=t.c-t.a;var normal=Vector3.Cross(ab,ac);var n=normal.sqrMagnitude;
                if(n>1e-20f){var q=p-normal*(Vector3.Dot(p-t.a,normal)/n);var v=q-t.a;var aa=Vector3.Dot(ab,ab);var bb=Vector3.Dot(ab,ac);var cc=Vector3.Dot(ac,ac);var av=Vector3.Dot(ab,v);var cv=Vector3.Dot(ac,v);var den=aa*cc-bb*bb;
                    if(den>1e-20f){var u=(cc*av-bb*cv)/den;var w=(aa*cv-bb*av)/den;if(u>=0&&w>=0&&u+w<=1)return(p-q).sqrMagnitude;}}
                return Mathf.Min((p-Segment(p,t.a,t.b)).sqrMagnitude,Mathf.Min((p-Segment(p,t.b,t.c)).sqrMagnitude,(p-Segment(p,t.c,t.a)).sqrMagnitude));
            }
            static void Nearest(Node node,Vector3 point,ref float squared)
            {
                if(node==null||(point-node.bounds.ClosestPoint(point)).sqrMagnitude>squared)return;
                if(node.leaf!=null){foreach(var t in node.leaf)squared=Mathf.Min(squared,Distance(point,t));return;}
                Nearest(node.left,point,ref squared);Nearest(node.right,point,ref squared);
            }
            public float Nearest(Vector3 point,float limit){var squared=limit*limit;Nearest(tree,point,ref squared);return Mathf.Sqrt(squared);}
        }
        static Mesh HeadMesh(Renderer renderer)
        {
            var skinned=renderer as SkinnedMeshRenderer;if(skinned!=null){var result=new Mesh();skinned.BakeMesh(result,false);return result;}
            var filter=renderer.GetComponent<MeshFilter>();return filter!=null&&filter.sharedMesh!=null?UnityEngine.Object.Instantiate(filter.sharedMesh):null;
        }
        static Vector3[] HeadWorld(Renderer renderer,Mesh mesh)
        {
            var world=renderer.transform.localToWorldMatrix;
            if(renderer is SkinnedMeshRenderer)for(var c=0;c<3;c++){var column=world.GetColumn(c);var length=column.magnitude;Check(length>0,"Degenerate attachment skinning scale");world.SetColumn(c,column/length);}
            return mesh.vertices.Select(world.MultiplyPoint3x4).ToArray();
        }
        // Actual triangle distances, using all meshes near the changed face; no name guesses.
        // Findings are advisory. They cannot accept appearance or block a user's geometry choice.
        public static Dictionary<string,object> InspectHeadAttachments(GameObject before,GameObject after,Dictionary<string,object> target,Vector3[] expected,Mesh measuredCandidate=null)
        {
            var oldFace=Find(before,target);var newFace=Find(after,target);int[] map;Dictionary<string,object> reading;
            Mesh ordered;
            if(oldFace.sharedMesh.blendShapeCount==newFace.sharedMesh.blendShapeCount)
                ordered=FaceMapping.CompareImports(oldFace.sharedMesh,newFace.sharedMesh,expected,oldFace.transform.localToWorldMatrix,.0001f,out map,out reading);
            else {
                Check(measuredCandidate!=null,"Attachment readback needs independently measured baked frames");
                var frames=new Dictionary<string,Vector3[]>();for(var k=0;k<measuredCandidate.blendShapeCount;k++){var delta=new Vector3[measuredCandidate.vertexCount];var scratch=new Vector3[delta.Length];measuredCandidate.GetBlendShapeFrameVertices(k,0,delta,scratch,scratch);frames[measuredCandidate.GetBlendShapeName(k)]=delta;}
                ordered=FaceMapping.ExpandCandidate(oldFace.sharedMesh,newFace.sharedMesh,expected,frames,.000001f);
            }
            var originalMesh=newFace.sharedMesh;newFace.sharedMesh=ordered;
            var oldMesh=HeadMesh(oldFace);var newMesh=HeadMesh(newFace);
            try{
                var a=HeadWorld(oldFace,oldMesh);var b=HeadWorld(newFace,newMesh);
                var changed=Enumerable.Range(0,a.Length).Where(i=>(a[i]-b[i]).sqrMagnitude>1e-12f).ToArray();var rows=new List<object>();
                foreach(var renderer in after.GetComponentsInChildren<Renderer>(true).Where(r=>r!=newFace)){
                    var mesh=HeadMesh(renderer);if(mesh==null)continue;
                    try{var vertices=HeadWorld(renderer,mesh);if(vertices.Length==0||mesh.triangles.Length==0)continue;var bounds=new Bounds(vertices[0],Vector3.zero);foreach(var v in vertices)bounds.Encapsulate(v);bounds.Expand(.02f);
                        var nearby=changed.Where(i=>bounds.Contains(a[i])||bounds.Contains(b[i])).ToArray();if(nearby.Length==0)continue;
                        var surface=new HeadSurface(vertices,mesh.triangles);var oldCount=0;var newCount=0;var introduced=0;var minBefore=.01f;var minAfter=.01f;
                        foreach(var i in nearby){var old=surface.Nearest(a[i],.01f);var current=surface.Nearest(b[i],.01f);minBefore=Mathf.Min(minBefore,old);minAfter=Mathf.Min(minAfter,current);if(old<=.0005f)oldCount++;if(current<=.0005f)newCount++;if(old>.0005f&&current<=.0005f)introduced++;}
                        rows.Add(D("renderer",PathOf(renderer.transform,after.transform),"enabled",renderer.enabled&&renderer.gameObject.activeInHierarchy,"verticesChecked",nearby.Length,"beforeWithinHalfMm",oldCount,"afterWithinHalfMm",newCount,"newNearContacts",introduced,"minimumBeforeMm",minBefore*1000,"minimumAfterMm",minAfter*1000));
                    }finally{UnityEngine.Object.DestroyImmediate(mesh);}
                }
                return D("schema","face-head-attachments/0.1","inputSha256",FileHash(InputPath),"pose","prefab-defaults","changedFaceVertices",changed.Length,"renderers",rows,"productionAccepted",false,
                    "limitations",new[]{"检查所有靠近变化脸部的实际蒙皮及静态网格，包含头发和饰品；0.5毫米为邻近提示，不代表穿插或可见缺陷。","仅默认姿势；透明材质、遮挡、动态骨骼和客户端动画状态仍需看图或客户端验收。"});
            }finally{newFace.sharedMesh=originalMesh;UnityEngine.Object.DestroyImmediate(ordered);UnityEngine.Object.DestroyImmediate(oldMesh);UnityEngine.Object.DestroyImmediate(newMesh);}
        }
        static Dictionary<string,object> ReadHeadAttachments(string avatarPath,Prepared p)
        {
            GameObject before=null,after=null;try{before=(GameObject)PrefabUtility.InstantiatePrefab(p.prefab);after=(GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(avatarPath));return InspectHeadAttachments(before,after,p.target,p.expected,p.candidate);}
            finally{if(before!=null)UnityEngine.Object.DestroyImmediate(before);if(after!=null)UnityEngine.Object.DestroyImmediate(after);}
        }
        public static void WriteMeasurement()
        {
            var record = Avh.ReadJsonFile(Avh.Abs(RecordPath)); var notes = new List<string>(); var valid = false;
            if (record.Str("mode") == "preserve")
            {
                try{valid=ValidatedOutput(record.Str("sourcePrefab"))==record.Str("avatar");}catch(Exception e){notes.Add(e.Message);}
                Avh.Observation("face.apply", D("face_source_preserved_valid", valid, "face_design_applied", false, "face_geometry_valid", null, "face_runtime_bindings_valid", null, "face_eye_region_valid", null, "face_visual_valid", null, "face_fully_qualified", false), notes); return;
            }
            var attachmentsMeasured=false;var writersMeasured=false;var compensated=false;object eyesValid=null;object exposureMeasured=null;object damageMeasured=null;object damageValid=null;
            try
            {
                CheckedRecord(record.Str("sourcePrefab"));using(var p=Prepare())
                {
                valid=VerifyOutput(record.Str("avatar"),notes,p);writersMeasured=Strings(p.target,"unmeasuredWriters").Count==0;compensated=Optional(p.design.Obj("recipe"),"compensation").Count>0;
                damageMeasured=valid&&compensated;damageValid=valid&&compensated&&p.quality.Where(v=>((Dictionary<string,object>)v).ContainsKey("passed")).All(v=>Equals(((Dictionary<string,object>)v)["passed"],true));
                Avh.WriteJson(Avh.Abs("_harness/face/quality.json"),D("schema","face-unity-quality/0.1","inputSha256",FileHash(InputPath),"compensated",compensated,"states",p.quality,"limitations",new[]{"Source-relative checks do not establish eyeball occlusion or visual acceptance"}));
                if(valid){Avh.WriteJson(Avh.Abs("_harness/face/head-attachments.json"),ReadHeadAttachments(record.Str("avatar"),p));attachmentsMeasured=true;var eyes=ReadEyes(record.Str("avatar"),p);
                if(eyes.Str("schema")=="face-eye-exposure/0.1")exposureMeasured=Equals(eyes["complete"],true);
                if(eyes.Str("status")=="technical_controls_passed")eyesValid=true;else if(eyes.Str("status")=="failed"||eyes.Str("status")=="needs_visual_review")eyesValid=false;
                Avh.WriteJson(Avh.Abs("_harness/face/eyes.json"),D("schema","face-unity-eyes/0.1","inputSha256",FileHash(InputPath),"observationSha256",FileHash(ObservationPath),"avatar",record.Str("avatar"),"verification",eyes));
                if(eyesValid==null)notes.Add(eyes.Str("reason"));
                }
                }
            }catch(Exception e){eyesValid=false;notes.Add(e.Message);}
            notes.Add("Native eye exposure is independently sampled at 0/50/60/70/80/90/100 percent on fixed source surfaces. The historical reference increase is advisory; actual images and user acceptance remain required. Historical contact-only evidence is not an exposure measurement.");
            Avh.Observation("face.apply", D("face_source_preserved_valid", false, "face_design_applied", valid, "face_geometry_valid", valid, "face_runtime_bindings_valid", valid && writersMeasured ? (object)true : null, "face_expression_compensation_valid", valid && compensated ? (object)true : null, "face_damage_smoothness_valid", damageValid, "face_damage_smoothness_measured",damageMeasured,"face_eye_region_valid", eyesValid, "face_eye_exposure_measured",exposureMeasured, "face_head_attachments_measured", attachmentsMeasured, "face_visual_valid", null, "face_fully_qualified", false), notes);
        }
        public static Dictionary<string,object> ReadEyes(string avatarPath)
        {
            using(var p=Prepare())return ReadEyes(avatarPath,p);
        }
        static Dictionary<string,object> ReadEyes(string avatarPath,Prepared p)
        {
            // Always load both sides anew. Pose sampling changes temporary instances only;
            // no frozen receipt or producer-reported pass is used as measurement evidence.
            Check(avatarPath==p.outputPath,"Eye candidate is not the frozen revision");GameObject source=null,candidate=null;
            try
            {
                source=(GameObject)PrefabUtility.InstantiatePrefab(p.prefab);var loaded=AssetDatabase.LoadAssetAtPath<GameObject>(avatarPath);Check(loaded!=null,"Eye candidate does not load");candidate=(GameObject)PrefabUtility.InstantiatePrefab(loaded);
                var recipe=Optional(p.design.Obj("recipe"),"compensation");
                if(recipe.Str("method")=="regional-additive")return new FaceEyes.ExposureProfile(Find(source,p.target),recipe,p.input.Str("route")=="native-fbx/1"?p.catalog.List("meshes").Cast<Dictionary<string,object>>().Single(m=>m.Str("meshId")==p.design.Obj("source").Str("meshId")):null).Verify(Find(source,p.target),Find(candidate,p.target));
                return FaceEyes.Verify(source,Find(source,p.target),candidate,Find(candidate,p.target),p.target.Str("meshSha256"));
            }
            finally{if(source!=null)UnityEngine.Object.DestroyImmediate(source);if(candidate!=null)UnityEngine.Object.DestroyImmediate(candidate);}
        }
    }
}
