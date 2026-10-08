// D-139 ② synthetic assembly fixture. The body meshes carry shape keys, the shoes' MA Shape Changer sets the
// body's foot and waist keys at build time, one stocking carries the same-name keys with no driver of its own,
// and a second garment already has its own BlendshapeSync. OutfitStage, LocalOperations and the full NDMF
// build chain are the actual frozen production tools; only the avatar is synthetic. The fixture reads the
// values back off the built avatar, because an assembly artifact that merely contains a component proves
// nothing about the delivered value.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Avatars.Components;

namespace AVH.Harness
{
    public static class BlendshapeSyncIntegration
    {
        const string Body = "Assets/Authorized/Body.prefab";
        const string Key = "Foot_highheels";
        const string Waist = "Waist_slim";
        const string Still = "Hutomomo_big";

        static int assertions;
        static void Require(bool ok, string message) { if (!ok) throw new Exception(message); assertions++; }
        static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (var i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1]; return d; }
        static Dictionary<string, object> Json(string relative) => Avh.ReadJsonFile(Avh.Abs(relative));
        static Dictionary<string, object> Metrics(string observer) => Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations", observer + ".json")).Obj("metrics");

        /// <summary>A flat skinned strip whose blend shapes exist by name; the geometry is irrelevant here.</summary>
        static Mesh ShapeMesh(string assetPath, params string[] keys)
        {
            var mesh = new Mesh { name = Path.GetFileNameWithoutExtension(assetPath) };
            const int count = 8;
            var vertices = new Vector3[count];
            var delta = new Vector3[count];
            for (var i = 0; i < count; i++) { vertices[i] = new Vector3(i * 0.01f, 0f, 0f); delta[i] = new Vector3(0f, 0.001f * (i + 1), 0f); }
            mesh.vertices = vertices;
            mesh.triangles = new[] { 0, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7, 0 };
            foreach (var key in keys) mesh.AddBlendShapeFrame(key, 100f, delta, delta, delta);
            AssetDatabase.CreateAsset(mesh, assetPath);
            return AssetDatabase.LoadAssetAtPath<Mesh>(assetPath);
        }

        /// <summary>An SMR with one bone of its own, so the fixture never borrows a transform from another prefab.</summary>
        static SkinnedMeshRenderer Skin(GameObject parent, string name, Mesh mesh, Material material)
        {
            var holder = new GameObject(name); holder.transform.SetParent(parent.transform, false);
            return SkinOn(holder, mesh, material);
        }

        /// <summary>The same renderer placed on the outfit root itself — a shape common for single-mesh
        /// garments, and the path the per-outfit receipt filter has to accept.</summary>
        static SkinnedMeshRenderer SkinOn(GameObject holder, Mesh mesh, Material material)
        {
            var bone = new GameObject("Bone_" + holder.name); bone.transform.SetParent(holder.transform, false);
            mesh.bindposes = new[] { Matrix4x4.identity };
            var smr = holder.AddComponent<SkinnedMeshRenderer>();
            smr.sharedMesh = mesh; smr.bones = new[] { bone.transform }; smr.rootBone = bone.transform; smr.sharedMaterial = material;
            return smr;
        }

        static AvatarObjectReference BodyPath() => new AvatarObjectReference { referencePath = "Body_base" };

        static string Outfit(string id, Material material, Action<GameObject> build)
        {
            var root = new GameObject("Fixture" + id);
            var armature = new GameObject("Armature"); armature.transform.SetParent(root.transform, false);
            armature.AddComponent<ModularAvatarMergeArmature>();
            build(root);
            var path = "Assets/Authorized/Part_" + id + ".prefab";
            PrefabUtility.SaveAsPrefabAsset(root, path); UnityEngine.Object.DestroyImmediate(root);
            return path;
        }

        static void Build()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            foreach (var path in new[] { "Assets/Authorized", "Assets/_Harness/Outfit" }) if (AssetDatabase.IsValidFolder(path)) AssetDatabase.DeleteAsset(path);
            OutfitStage.EnsureFolder("Assets/Authorized"); OutfitStage.EnsureFolder("Assets/_Harness/Outfit");
            var material = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(material, "Assets/Authorized/fixture.mat");
            // Body_base carries the keys the shoes write; Body is a second body mesh of the same identity that
            // does not carry the foot key, which is what a wrong reference would silently bind to.
            var bodyMesh = ShapeMesh("Assets/Authorized/BodyShape.asset", Key, Waist, Still);
            var headMesh = ShapeMesh("Assets/Authorized/HeadShape.asset", "Breast_big");
            var stockingMesh = ShapeMesh("Assets/Authorized/StockingShape.asset", Key, Waist, Still);
            var drivenMesh = ShapeMesh("Assets/Authorized/DrivenShape.asset", Key);

            var body = RecolorMaterialIntegration.Human();
            body.AddComponent<VRCAvatarDescriptor>();
            Skin(body, "Body_base", bodyMesh, material);
            Skin(body, "Body", headMesh, material);
            PrefabUtility.SaveAsPrefabAsset(body, Body); UnityEngine.Object.DestroyImmediate(body);

            var shoes = Outfit("shoes", material, root =>
            {
                var rig = new GameObject("Rig"); rig.transform.SetParent(root.transform, false);
                var changer = rig.AddComponent<ModularAvatarShapeChanger>();
                changer.Shapes = new List<ChangedShape>
                {
                    new ChangedShape { Object = BodyPath(), ShapeName = Key, ChangeType = ShapeChangeType.Set, Value = 100f },
                    new ChangedShape { Object = BodyPath(), ShapeName = Waist, ChangeType = ShapeChangeType.Set, Value = 100f },
                };
                var shoe = GameObject.CreatePrimitive(PrimitiveType.Cube); shoe.name = "Shoe";
                shoe.transform.SetParent(root.transform, false); shoe.GetComponent<Renderer>().sharedMaterial = material;
            });
            // The stocking's renderer sits on the outfit root: the receipt filter has to accept that path too.
            var stocking = Outfit("stocking", material, root => SkinOn(root, stockingMesh, material));
            var driven = Outfit("driven", material, root =>
            {
                var smr = Skin(root, "DrivenMesh", drivenMesh, material);
                var sync = smr.gameObject.AddComponent<ModularAvatarBlendshapeSync>();
                sync.Bindings = new List<BlendshapeBinding> { new BlendshapeBinding { ReferenceMesh = BodyPath(), Blendshape = Key, LocalBlendshape = "" } };
            });

            var specs = new List<object>
            {
                D("id", "shoes", "item", "input_shoes", "prefab", shoes, "label", "shoes", "activation", "fixed"),
                D("id", "stocking", "item", "input_stocking", "prefab", stocking, "label", "stocking", "activation", "fixed"),
                D("id", "driven", "item", "input_driven", "prefab", driven, "label", "driven", "activation", "fixed"),
            };
            var plan = D("body_prefab", Body, "outfits", specs, "face", D("mode", "preserve"), "menu", D("mode", "preserve"));
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
            Environment.SetEnvironmentVariable("AVH_MANIFEST", "{\"assets\":[{\"item\":\"A\"}]}");
            Avh.WriteJson(Avh.Abs("_harness/setup/baseline.json"), D("body_prefab", Body));
            Avh.WriteJson(Avh.Abs("_harness/setup/import.json"), D("packages", new List<object> { D("item", "A", "roots", new List<object> { "Assets/Authorized" }) }));
            AssetDatabase.SaveAssets();
        }

        /// <summary>An empty-but-valid operation recipe, so the consuming stage writes its receipt too.</summary>
        static void Operations()
        {
            var observation = File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath));
            Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), D("schema", "local-operations/0.1",
                "observation_sha256", LocalOperations.Digest(observation), "operations", new List<object>()));
        }

        static List<Dictionary<string, object>> Added(Dictionary<string, object> record) =>
            record.List("blendshape_sync_added").Cast<Dictionary<string, object>>().ToList();

        static void ScenarioAssembly()
        {
            LocalOperations.Observe(AssetDatabase.LoadAssetAtPath<GameObject>(Body), Avh.Plan());
            Operations();
            OutfitStage.Produce();

            var record = Json(OutfitStage.RecordPath);
            var added = Added(record);
            var listing = string.Join(" | ", added.Select(row => row.Str("renderer") + ":" + row.Str("key") + "->" + row.Str("reference_mesh")));
            // The duplicate check comes first: with a duplicate added, this is the failure the reader needs,
            // not the count that follows from it.
            Require(!added.Any(row => row.Str("renderer").Contains("Outfit_driven")), "已经有自己 BlendshapeSync 的件不该重复补：" + listing);
            Require(added.Count == 2, "装配应补 2 条形态键同步（连体袜的脚型键与腰键），实际 " + added.Count + "：" + listing);
            foreach (var row in added)
            {
                Require(row.Str("renderer") == "_Outfit/Outfit_stocking", "补同步的件不对：" + row.Str("renderer"));
                Require(row.Str("reference_mesh") == "Body_base", "跟随的网格不对：" + row.Str("reference_mesh") + "（要跟随写着这个键的那块素体网格）");
                Require(!string.IsNullOrWhiteSpace(row.Str("reason")), "每条补同步都要写明为什么补");
            }
            Require(added.Select(row => row.Str("key")).OrderBy(key => key, StringComparer.Ordinal).SequenceEqual(new[] { Key, Waist }),
                "补的键不对：" + listing);
            Require(!added.Any(row => row.Str("key") == Still), "没人写、恒为 0 的键不该补同步：" + listing);

            // The per-outfit record must carry the same rows. A renderer that *is* the outfit root falls out of
            // a prefix-only filter, which would leave the reload's declared-versus-measured check nothing to
            // compare — this is the case the stocking (whose renderer sits on the root) exists to cover.
            var stockingRecord = record.List("outfits").Cast<Dictionary<string, object>>().Single(row => row.Str("id") == "stocking");
            Require(stockingRecord.Obj("blendshape_sync").List("added").Count == 2,
                "这一套的装配记录里应写着它补的 2 条同步，实际 " + stockingRecord.Obj("blendshape_sync").List("added").Count);

            var assembled = AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath);
            var stocking = AvatarAudit.Locate(assembled.transform, "_Outfit/Outfit_stocking");
            var driven = AvatarAudit.Locate(assembled.transform, "_Outfit/Outfit_driven/DrivenMesh");
            var stockingSync = stocking.GetComponents<ModularAvatarBlendshapeSync>().Single();
            var drivenSync = driven.GetComponents<ModularAvatarBlendshapeSync>().Single();
            Require(stockingSync.Bindings.Count == 2, "连体袜上应恰好 2 条绑定，实际 " + stockingSync.Bindings.Count);
            Require(stockingSync.Bindings.All(binding => binding.ReferenceMesh.Get(stockingSync)?.name == "Body_base"),
                "绑定必须指向素体网格 Body_base");
            Require(drivenSync.Bindings.Count == 1, "自带同步的件不该被追加绑定，实际 " + drivenSync.Bindings.Count);

            // Two added by assembly (the stocking) plus the one the driven garment already carried: the
            // reading is what the assembled artifact follows, not what this stage added.
            Require(Convert.ToInt32(Metrics("clothing.install")["blendshape_sync_followed_keys"]) == 3, "装配读数里的跟随键数不对");
            Require(Convert.ToInt32(Metrics("clothing.install")["blendshape_sync_missing_keys"]) == 0, "补出来的绑定不该有无效键");
            // The independent reload rebuilds the assembly and must accept the artifact the assembly wrote,
            // added components included; otherwise the pass would make the outfit stage fail its own check.
            Require(Equals(Metrics("clothing.install")["local_operations_valid"], true), "独立重载必须接受带补同步的装配产物");

            var receipt = Json(LocalOperations.OutputPath);
            Require(receipt != null && receipt.List("blendshape_sync_added").Count == 2, "装配回执里应列出补的 2 条同步");
        }

        static bool InAssembly(Transform target)
        {
            for (var node = target; node != null; node = node.parent)
            {
                if (node.name == OutfitStage.Group || node.name.StartsWith(OutfitStage.Group + "$", StringComparison.Ordinal)) return true;
            }
            return false;
        }

        static float Value(SkinnedMeshRenderer smr, string key)
        {
            if (smr?.sharedMesh == null) return float.NaN;
            var index = smr.sharedMesh.GetBlendShapeIndex(key);
            return index >= 0 ? smr.GetBlendShapeWeight(index) : float.NaN;
        }

        static void ScenarioBuild()
        {
            var request = Avh.Abs("bs1-build-request.json");
            Avh.WriteJson(request, D("input", OutfitStage.AvatarPath, "output", BuildStage.OutDir, "name", "Avatar",
                "report", Avh.Abs("bs1-build-report.json"), "allowErrors", false));
            var code = AvatarBuild.BuildArtifact.BuildOnce(request);
            Require(code == 0, "完整构建失败，见 bs1-build-report.json：" + (Json("bs1-build-report.json") ?? new Dictionary<string, object>()).Str("status"));
            var built = (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(BuildStage.BuiltPrefab));
            try
            {
                var smrs = built.GetComponentsInChildren<SkinnedMeshRenderer>(true).Where(smr => smr.sharedMesh != null).ToList();
                var listing = string.Join(" | ", smrs.Select(smr => Probe.HierarchyPath(built.transform, smr.transform) + "{keys=" + smr.sharedMesh.blendShapeCount + ",foot=" + Value(smr, Key) + "}"));
                var bodyBase = smrs.SingleOrDefault(smr => !InAssembly(smr.transform) && smr.sharedMesh.GetBlendShapeIndex(Key) >= 0);
                Require(bodyBase != null, "构建产物里找不到带脚型键的素体网格：" + listing);
                var stocking = smrs.SingleOrDefault(smr => InAssembly(smr.transform)
                    && smr.sharedMesh.GetBlendShapeIndex(Key) >= 0 && smr.sharedMesh.GetBlendShapeIndex(Still) >= 0);
                var driven = smrs.SingleOrDefault(smr => InAssembly(smr.transform)
                    && smr.sharedMesh.GetBlendShapeIndex(Key) >= 0 && smr.sharedMesh.GetBlendShapeIndex(Still) < 0);
                Require(stocking != null && driven != null, "构建产物里找不到两件被测衣物：" + listing);
                var body = Value(bodyBase, Key);
                Require(Math.Abs(body - 100f) < 0.01f, "鞋子的 Shape Changer 应把素体脚型键设成 100，构建后读到 " + body + "：" + listing);
                Require(Math.Abs(Value(stocking, Key) - body) < 0.01f,
                    "构建后连体袜的 Foot_highheels=" + Value(stocking, Key) + " 必须等于素体的 " + body + "：" + listing);
                Require(Math.Abs(Value(stocking, Waist) - Value(bodyBase, Waist)) < 0.01f,
                    "构建后连体袜的 Waist_slim=" + Value(stocking, Waist) + " 必须等于素体的 " + Value(bodyBase, Waist));
                Require(Math.Abs(Value(driven, Key) - body) < 0.01f,
                    "自带 BlendshapeSync 的那件构建后应跟随素体到 " + body + "，实际 " + Value(driven, Key));
                Require(Math.Abs(Value(stocking, Still)) < 0.01f && Math.Abs(Value(bodyBase, Still)) < 0.01f,
                    "没人写的键不该被同步出非零值：" + listing);
            }
            finally { UnityEngine.Object.DestroyImmediate(built); }
        }

        public static void Run()
        {
            try
            {
                Build();
                ScenarioAssembly();
                ScenarioBuild();
                Avh.WriteJson(Avh.Abs("result.json"), D("ok", true, "assertions", assertions));
                EditorApplication.Exit(0);
            }
            catch (Exception error)
            {
                Avh.WriteJson(Avh.Abs("result.json"), D("ok", false, "assertions", assertions, "error", error.ToString()));
                Debug.LogException(error);
                EditorApplication.Exit(1);
            }
        }
    }
}
