// Synthetic assembly fixture for D-138: the visible-part inventory, the cross-part overlap distance, the
// vendor group evidence and the recorded-closure deduction. OutfitStage, LocalOperations and
// OutfitVisibility are the actual frozen production tools; only the avatar is synthetic.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using nadena.dev.modular_avatar.core;
using UnityEditor;
using UnityEngine;
namespace AVH.Harness
{
    public static class OutfitVisibilityIntegration
    {
        static int assertions;
        static void Require(bool ok, string message) { if (!ok) throw new Exception(message); assertions++; }
        static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (var i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1]; return d; }
        static Dictionary<string, object> Json(string relative) => Avh.ReadJsonFile(Avh.Abs(relative));
        static Dictionary<string, object> Observations(string observer) => Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations", observer + ".json"));
        static Dictionary<string, object> Metrics(string observer) => Observations(observer).Obj("metrics");
        static double Number(Dictionary<string, object> metrics, string key)
        {
            Require(metrics.ContainsKey(key) && metrics[key] != null, "缺少指标 " + key);
            return Convert.ToDouble(metrics[key]);
        }
        static void Close(double actual, double expected, string message) => Require(Math.Abs(actual - expected) < 0.001, message + " 实际 " + actual.ToString("0.####") + " 期望 " + expected.ToString("0.####"));

        const string Body = "Assets/Authorized/Body.prefab";
        const string BodyVariant = "Assets/Authorized/BodyVariant.prefab";

        /// <summary>A fixture cube: the unit primitive scaled to `size`, centred on `center`.</summary>
        static Renderer Cube(Transform parent, string name, Vector3 center, float size, Material material)
        {
            var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
            cube.name = name; cube.transform.SetParent(parent, false);
            cube.transform.localPosition = center; cube.transform.localScale = Vector3.one * size;
            var renderer = cube.GetComponent<Renderer>(); renderer.sharedMaterial = material;
            return renderer;
        }

        static string OutfitPrefab(string id, Material material, bool nested, params (string name, Vector3 center, float size)[] parts)
        {
            var root = new GameObject("Fixture" + id);
            var armature = new GameObject("Armature"); armature.transform.SetParent(root.transform, false);
            armature.AddComponent<ModularAvatarMergeArmature>();
            // Some vendor prefabs keep their geometry under the merge armature instead of at the root, so the
            // fixture puts one outfit's parts there: paths, sources and the recorded-closure deduction all have
            // to work below the outfit root, not only one level down.
            var parent = nested ? armature.transform : root.transform;
            foreach (var part in parts) Cube(parent, part.name, part.center, part.size, material);
            var path = "Assets/Authorized/Part_" + id + ".prefab";
            PrefabUtility.SaveAsPrefabAsset(root, path); UnityEngine.Object.DestroyImmediate(root);
            return path;
        }

        // ── GI1 (`D-143`): dense sheets whose layer order and picture reading can be reasoned about exactly ──
        // One grid cell is 10 mm. The outer sheet sits at z = 0 and the inner one 0.5 mm behind it, so every
        // vertex is inside the 1 mm reach the layer census uses; a rectangle of the inner sheet raised to 0.5 mm
        // in FRONT of the outer one is the poke. 0.1 mm is the outside threshold, so 0.5 mm is clearly outside.
        const int Nu = 24, Nv = 18;
        const float SheetW = 0.24f, SheetH = 0.18f;
        const float Behind = -0.0005f, InFront = 0.0005f, Flap = 0.0035f, Lined = -0.002f, LiningMm = -0.0012f;
        /// <summary>The thin crossing of case ⑧: outside the 0.1 mm band, well under the poke-depth threshold.</summary>
        const float ThinPoke = 0.0002f;
        /// <summary>GI2 case ⑪: a small poke whose deepest sample sits on the instrument's range (1 mm). The
        /// reading must mark it as a lower bound ("at least"), and an `accept` of it must be blocked because the
        /// depth was never measured inside the guard.</summary>
        const float CeilingPoke = 0.000995f;
        /// <summary>The lined case's inner sheet, 0.6 mm above the lining and 0.6 mm below the shell.</summary>
        const float Between = -0.0006f;
        const float XRight = 0.45f, XLeft = -0.45f;
        /// <summary>The body part the fixture measured for ① and ⑦'s inner sheets, read out of the baseline
        /// reading so an acknowledgement names a part the measurement really found (the fixture never guesses one).</summary>
        static string PokePartA, PokePartG;

        /// <summary>A mesh assembled from flat grids facing +Z. Winding is (a,b,c)+(b,d,c), so
        /// cross(b-a, c-a) is +Z: that is the front face for a camera looking down -Z, and at the same time
        /// the "outside" the layer census reads.</summary>
        sealed class Sheets
        {
            readonly List<Vector3> vertices = new List<Vector3>();
            readonly List<int> triangles = new List<int>();
            readonly List<Vector3> normals = new List<Vector3>();

            /// <summary>One grid; `depth(u,v)` (metres) moves a vertex along +Z, `omit(i,j)` drops a cell.</summary>
            public void Grid(Vector3 centre, float width, float height, Func<float, float, float> depth, Func<int, int, bool> omit = null,
                int nu = Nu, int nv = Nv)
            {
                var first = vertices.Count;
                for (var j = 0; j <= nv; j++)
                    for (var i = 0; i <= nu; i++)
                    {
                        var u = (float)i / nu;
                        var v = (float)j / nv;
                        vertices.Add(centre + new Vector3((u - 0.5f) * width, (v - 0.5f) * height, depth == null ? 0f : depth(u, v)));
                        normals.Add(Vector3.forward);
                    }
                for (var j = 0; j < nv; j++)
                    for (var i = 0; i < nu; i++)
                    {
                        if (omit != null && omit(i, j)) continue;
                        var a = first + j * (nu + 1) + i; var b = a + 1; var c = a + nu + 1; var d = c + 1;
                        triangles.Add(a); triangles.Add(b); triangles.Add(c);
                        triangles.Add(b); triangles.Add(d); triangles.Add(c);
                    }
            }

            public Renderer Build(Transform parent, string name, Material material)
            {
                var mesh = new Mesh { name = name + "Mesh" };
                mesh.SetVertices(vertices); mesh.SetNormals(normals); mesh.SetTriangles(triangles, 0);
                mesh.RecalculateBounds();
                // A mesh created at run time is not serialized into a prefab — it comes back null and the renderer
                // would have no geometry at all. It has to be an asset for the saved prefab to reference it.
                var path = "Assets/Authorized/" + name + "Mesh.asset";
                if (AssetDatabase.LoadAssetAtPath<Mesh>(path) != null) AssetDatabase.DeleteAsset(path);
                AssetDatabase.CreateAsset(mesh, path);
                var go = new GameObject(name); go.transform.SetParent(parent, false);
                go.AddComponent<MeshFilter>().sharedMesh = mesh;
                var renderer = go.AddComponent<MeshRenderer>(); renderer.sharedMaterial = material;
                return renderer;
            }
        }

        static Vector2 Cell(float u, float v) => new Vector2(Mathf.Round(u * Nu), Mathf.Round(v * Nv));

        /// <summary>
        /// D-143: three ears on one head. Two are plain meshes hanging under the head bone, so only the parent
        /// chain can place them; the third is a skinned mesh hanging off the avatar root, where no parent chain
        /// reaches a humanoid bone — its part can only come from the bone that carries its skin weight.
        /// The second body prefab carries the same parts — that is what keeps the vendor grouping evidence the
        /// difference of one part — but has no rig of its own, so its ears hang off a chain of same-named bones.
        /// </summary>
        static void Ears(GameObject body, Material material, bool rigged = true)
        {
            var head = body.transform.Find("Hips/Spine/Chest/Neck/Head");
            if (rigged) Require(head != null, "夹具的人形骨架里找不到 Head 骨");
            else if (head == null)
            {
                // The second body prefab has no rig of its own, but its parts have to keep the same paths: the
                // vendor grouping evidence is the difference between the two prefabs, so a path that only one of
                // them uses would be reported as another difference.
                var chain = body.transform;
                foreach (var name in new[] { "Hips", "Spine", "Chest", "Neck", "Head" })
                {
                    var child = new GameObject(name).transform;
                    child.SetParent(chain, false);
                    chain = child;
                }
                head = chain;
            }
            var bone = rigged ? head : body.transform;
            Cube(head, "Ear_A", new Vector3(0.06f, 0.02f, 0f), 0.03f, material);
            Cube(head, "Ear_B", new Vector3(-0.06f, 0.02f, 0f), 0.03f, material);
            var earMesh = new Mesh { name = "EarSkinnedMesh" };
            earMesh.vertices = new[] { Vector3.zero, new Vector3(0.01f, 0f, 0f), new Vector3(0f, 0.01f, 0f) };
            earMesh.triangles = new[] { 0, 1, 2 };
            earMesh.boneWeights = new[] { new BoneWeight { boneIndex0 = 0, weight0 = 1f },
                new BoneWeight { boneIndex0 = 0, weight0 = 1f }, new BoneWeight { boneIndex0 = 0, weight0 = 1f } };
            earMesh.bindposes = new[] { Matrix4x4.identity };
            // Asset, not prefab-embedded: a run-time mesh inside a prefab comes back without readable weights.
            const string earPath = "Assets/Authorized/EarSkinnedMesh.asset";
            if (AssetDatabase.LoadAssetAtPath<Mesh>(earPath) != null) AssetDatabase.DeleteAsset(earPath);
            AssetDatabase.CreateAsset(earMesh, earPath);
            var ear = new GameObject("Ear_Skinned"); ear.transform.SetParent(body.transform, false);
            var earRenderer = ear.AddComponent<SkinnedMeshRenderer>();
            earRenderer.sharedMesh = earMesh; earRenderer.bones = new[] { bone }; earRenderer.rootBone = bone;
            earRenderer.sharedMaterial = material;
        }

        /// <summary>Inner sheet: 0.5 mm behind the outer one everywhere except a rectangle of vertices that is
        /// 0.5 mm in front of it — the poke the picture check has to confirm.</summary>
        static Func<float, float, float> Poke(int i0, int i1, int j0, int j1) => (u, v) =>
        {
            var cell = Cell(u, v);
            return cell.x >= i0 && cell.x <= i1 && cell.y >= j0 && cell.y <= j1 ? InFront : Behind;
        };

        /// <summary>GI2: a small rectangle of the inner sheet raised to the instrument's range. The reading must
        /// say "at least" for it, and no `accept` may wave it through.</summary>
        static Func<float, float, float> Ceiling(int i0, int i1, int j0, int j1) => (u, v) =>
        {
            var cell = Cell(u, v);
            return cell.x >= i0 && cell.x <= i1 && cell.y >= j0 && cell.y <= j1 ? CeilingPoke : Behind;
        };

        static Func<int, int, bool> Cells(int i0, int i1, int j0, int j1) => (i, j) => i >= i0 && i <= i1 && j >= j0 && j <= j1;

        /// <summary>
        /// The GI1 fixture: garments shaped so the layer census and the rendered picture can disagree.
        ///   ① an inner skirt poking through the coat in front of the camera      -> a visible interpenetration
        ///   ② the same shape with no poke at all                                 -> never proposed
        ///   ③ a belt worn OUTSIDE the coat (an outer-layer design)               -> never proposed
        ///   ④ a seam where one cell of the inner layer pokes out                 -> proposed, below the minimum
        ///   ⑤ a poke inside an opening of the coat: what shows is a lining       -> proposed, never confirmed
        ///   ⑥ a poke shadowed by a nearer surface of its OWN layer               -> proposed, never confirmed
        ///   ⑦ the outer garment is a shell plus a lining, the inner runs between -> confirmed, counted
        ///   ⑧ the inner layer pokes out by a film (0.2 mm)                       -> confirmed, below the depth gate
        ///   ⑨ a strand of the plan's hair source pokes through a coat            -> confirmed, a reference only
        ///   ⑩ a broad, deep poke crossing only the vertex guard                  -> out of bounds
        ///   ⑪ a small poke whose deepest sample sits on the instrument's range   -> depth_at_least, accept blocked
        /// </summary>
        static string InterpenetrationPrefab(Material material)
        {
            var root = new GameObject("FixturePokes");
            var armature = new GameObject("Armature"); armature.transform.SetParent(root.transform, false);
            armature.AddComponent<ModularAvatarMergeArmature>();
            var parent = root.transform;
            Renderer Flat(string name, float x, float y, float z, float w, float h)
            {
                var sheets = new Sheets();
                sheets.Grid(new Vector3(x, y, z), w, h, null);
                return sheets.Build(parent, name, material);
            }
            Renderer Inner(string name, float x, float y, Func<float, float, float> depth)
            {
                var sheets = new Sheets();
                sheets.Grid(new Vector3(x, y, 0f), SheetW, SheetH, depth);
                return sheets.Build(parent, name, material);
            }

            // ①
            Flat("CoatA", XRight, 1.72f, 0f, SheetW, SheetH);
            Inner("SkirtA", XRight, 1.72f, Poke(7, 17, 4, 14));
            // ②
            Flat("CoatB", XLeft, 1.45f, 0f, SheetW, SheetH);
            Inner("SkirtB", XLeft, 1.45f, (u, v) => Behind);
            // ③ a belt worn outside the coat: every one of its vertices is on the outer side.
            Flat("CoatC", XRight, 1.18f, 0f, SheetW, SheetH);
            Flat("BeltC", XRight, 1.18f, InFront, SheetW, SheetH * 0.25f);
            // ④ one cell of the inner layer pokes out, and it is visible — but it is one cell.
            Flat("CoatD", XLeft, 0.91f, 0f, SheetW, SheetH);
            Inner("SkirtD", XLeft, 0.91f, Poke(12, 13, 9, 10));
            // ⑤ the poke goes through the coat, but once the inner layer is off a THIRD garment shows at those
            // pixels — not the coat it pierced, so this is not a visible interpenetration of these two.
            Flat("CoatE", XRight, 0.64f, 0f, SheetW, SheetH);
            Flat("VeilE", XRight, 0.64f, 0.00025f, 0.07f, 0.07f);
            Inner("SkirtE", XRight, 0.64f, Poke(10, 14, 7, 11));
            // ⑥ the poke is shadowed by a nearer surface of the SAME layer: the pixel belongs to the layer, but
            // not to this vertex, so only the depth check can reject it. The coat below is solid, so "with the
            // layer off the coat shows" holds and the depth check is the only thing keeping it out.
            Flat("CoatF", XLeft, 1.99f, 0f, SheetW, SheetH);
            var skirtF = new Sheets();
            skirtF.Grid(new Vector3(XLeft, 1.99f, 0f), SheetW, SheetH, (u, v) => Behind, Cells(10, 13, 7, 10));
            // The patch and the flap are coarse grids: a patch with as many vertices as the whole sheet would
            // make the inner layer's near-band vertices exactly half inside and half outside, and the majority
            // rule would then have nothing to say about the pair at all.
            skirtF.Grid(new Vector3(XLeft, 1.99f, InFront), 0.04f, 0.04f, null, null, 6, 6);
            skirtF.Grid(new Vector3(XLeft, 1.99f, Flap), 0.06f, 0.06f, null, null, 6, 6);
            skirtF.Build(parent, "SkirtF", material);
            // ⑦ the outer garment is two layers — a shell and a lining — and the inner one runs between them,
            // poking through the shell. Against the nearest face alone it reads as sitting OUTSIDE the outer
            // garment, which is the geometry the whole layer rule has to survive.
            var coatG = new Sheets();
            coatG.Grid(new Vector3(XLeft, 0.37f, 0f), SheetW, SheetH, null);
            coatG.Grid(new Vector3(XLeft, 0.37f, LiningMm), 0.08f, 0.04f, null);
            coatG.Build(parent, "CoatG", material);
            var skirtG = new Sheets();
            skirtG.Grid(new Vector3(XLeft, 0.37f, Between), 0.08f, 0.04f, null, null, 48, 24);
            skirtG.Grid(new Vector3(XLeft, 0.37f, InFront), 0.02f, 0.02f, null, null, 6, 6);
            skirtG.Build(parent, "SkirtG", material);
            // ⑧ an inner layer that pokes out by a film (0.2 mm) rather than a real poke: the picture confirms the
            // vertices, and the reading hands the depth over as evidence for the executor's decision.
            Flat("CoatH", XRight, 0.10f, 0f, SheetW, SheetH);
            Inner("SkirtH", XRight, 0.10f, (u, v) => Poke(9, 15, 6, 12)(u, v) > 0f ? ThinPoke : Behind);
            // ⑩ a broad, deep poke: a dense inner sheet (48x24) whose middle pokes through a coarse outer one (6x6).
            // The poke is a minority of the INNER sheet, so the layer census still resolves it as the inner layer,
            // while the number of confirmed vertices crosses the vertex guard — no `accept` may wave it through.
            var coatK = new Sheets();
            coatK.Grid(new Vector3(XRight, -0.17f, 0f), SheetW, SheetH, null, null, 6, 6);
            coatK.Build(parent, "CoatK", material);
            var skirtK = new Sheets();
            skirtK.Grid(new Vector3(XRight, -0.17f, 0f), SheetW, SheetH,
                (u, v) => u > 0.20f && u < 0.75f && v > 0.20f && v < 0.72f ? InFront : Behind, null, 48, 24);
            skirtK.Build(parent, "SkirtK", material);
            // ⑪ a SMALL poke whose deepest sample sits on the instrument's range (1 mm): a 5x5 vertex patch, well
            // under the vertex guard. Its depth was never measured inside the 2 mm guard, so the reading must mark
            // it as a lower bound and refuse an `accept`.
            Flat("CoatL", XLeft, -0.17f, 0f, SheetW, SheetH);
            Inner("SkirtL", XLeft, -0.17f, Ceiling(9, 13, 6, 10));

            var path = "Assets/Authorized/Part_pokes.prefab";
            PrefabUtility.SaveAsPrefabAsset(root, path); UnityEngine.Object.DestroyImmediate(root);
            return path;
        }

        /// <summary>
        /// The ordered hairstyle case: a strand of the plan's hair source pokes through a coat. The orderer's
        /// criterion is that hair crossing a garment is not a defect, so the pair is only listed as a reference —
        /// the fixture marks the source the way the plan does (an intake role), never by the object's name.
        /// </summary>
        static string InterpenetrationHairPrefab(Material material)
        {
            var root = new GameObject("FixtureHair");
            var armature = new GameObject("Armature"); armature.transform.SetParent(root.transform, false);
            armature.AddComponent<ModularAvatarMergeArmature>();
            var parent = root.transform;
            Renderer Flat(string name, float x, float y)
            {
                var sheets = new Sheets();
                sheets.Grid(new Vector3(x, y, 0f), SheetW, SheetH, null);
                return sheets.Build(parent, name, material);
            }
            Renderer Inner(string name, float x, float y, Func<float, float, float> depth)
            {
                var sheets = new Sheets();
                sheets.Grid(new Vector3(x, y, 0f), SheetW, SheetH, depth);
                return sheets.Build(parent, name, material);
            }
            Flat("CoatI", XLeft, 0.10f);
            Inner("HairI", XLeft, 0.10f, Poke(8, 16, 5, 13));
            var path = "Assets/Authorized/Part_hair.prefab";
            PrefabUtility.SaveAsPrefabAsset(root, path); UnityEngine.Object.DestroyImmediate(root);
            return path;
        }

        static void Build()
        {
            UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Single);
            foreach (var path in new[] { "Assets/Authorized", "Assets/_Harness/Outfit" }) if (AssetDatabase.IsValidFolder(path)) AssetDatabase.DeleteAsset(path);
            OutfitStage.EnsureFolder("Assets/Authorized"); OutfitStage.EnsureFolder("Assets/_Harness/Outfit");
            var material = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(material, "Assets/Authorized/fixture.mat");

            // The body: one base-body mesh (identity from the plan's body prefab) plus two body-owned garments.
            // A second body prefab of the same package carries only one of them, which is the vendor's own
            // grouping evidence the inventory has to read out of the difference.
            var body = RecolorMaterialIntegration.Human();
            Cube(body.transform, "Body_base", new Vector3(2f, 0f, 0f), 0.30f, material);   // 素体皮肤：只列不计数
            Cube(body.transform, "Pocket", new Vector3(0f, 3f, 0f), 0.10f, material);      // 素体自带衣物
            Cube(body.transform, "Collar", new Vector3(3f, 3f, 0f), 0.10f, material);
            // D-143: two pairs of ears on one head. The body part is read from the rig, never from a name, so
            // everything hanging under the head bone has to land in the same part of the summary.
            Ears(body, material);
            PrefabUtility.SaveAsPrefabAsset(body, Body); UnityEngine.Object.DestroyImmediate(body);
            // The second body prefab only needs the identity and the shared part; it is never assembled.
            var variant = new GameObject("AvatarVariant");
            Cube(variant.transform, "Body_base", new Vector3(2f, 0f, 0f), 0.30f, material);
            Cube(variant.transform, "Collar", new Vector3(3f, 3f, 0f), 0.10f, material);
            // The ears are on both body prefabs, so the vendor grouping evidence (the difference between them)
            // is still exactly the part only one of them carries.
            Ears(variant, material, rigged: false);
            PrefabUtility.SaveAsPrefabAsset(variant, BodyVariant); UnityEngine.Object.DestroyImmediate(variant);

            // The vendor's own switch grouping: one clip that toggles two objects together.
            var clip = new AnimationClip();
            AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("Pocket", typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1, 0));
            AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("Collar", typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1, 0));
            AssetDatabase.CreateAsset(clip, "Assets/Authorized/GroupSwitch.anim");

            var origins = new Dictionary<string, Vector3>
            { ["variant"] = Vector3.zero, ["stack_a"] = new Vector3(1f, 0f, 0f), ["stack_b"] = new Vector3(1f, 0f, 0f),
              ["nested"] = new Vector3(0f, 1f, 0f), ["tight"] = new Vector3(1f, 1f, 0f), ["skinfitted"] = new Vector3(2f, 0f, 0f),
              ["pocket_cover"] = new Vector3(0f, 3f, 0f) };
            var specs = new List<object>();
            void Fixed(string id, string prefab) => specs.Add(D("id", id, "item", "input" + id, "prefab", prefab, "label", id, "activation", "fixed"));
            // One vendor FBX carrying two size variants and its defect-test mesh: three coincident surfaces.
            Fixed("variant", OutfitPrefab("variant", material, false,
                ("Part_default", origins["variant"], 0.20f), ("Part_small", origins["variant"], 0.20f), ("ClippingWarning_test", origins["variant"], 0.20f)));
            // Two different outfits woven at the same radius on one leg, both nested under their armature.
            Fixed("stack_a", OutfitPrefab("stack_a", material, true, ("Layer", origins["stack_a"], 0.20f)));
            Fixed("stack_b", OutfitPrefab("stack_b", material, true, ("Layer", origins["stack_b"], 0.20f)));
            // A legitimate lining: 2 mm inside the shell, so no band contact at any epsilon below that.
            Fixed("nested", OutfitPrefab("nested", material, false,
                ("Outer", origins["nested"], 0.30f), ("Inner", origins["nested"], 0.296f)));
            // A tight but honest fit at 0.5 mm: below the 1 mm band that would swallow normal clothing.
            Fixed("tight", OutfitPrefab("tight", material, false,
                ("ShellOuter", origins["tight"], 0.30f), ("ShellInner", origins["tight"], 0.299f)));
            // A garment lying exactly on the body skin: the pair exists geometrically but the body is not a layer.
            Fixed("skinfitted", OutfitPrefab("skinfitted", material, false, ("SkinShell", origins["skinfitted"], 0.30f)));
            // A body-owned garment covered by an outfit part: body-owned parts do count against the outfit.
            Fixed("pocket_cover", OutfitPrefab("pocket_cover", material, false, ("Cover", origins["pocket_cover"], 0.10f)));
            // D-143: six pairs the layer census and the picture check have to disagree about.
            Fixed("pokes", InterpenetrationPrefab(material));
            // D-143 ③: the plan's own hairstyle source. The role is declared in the intake inventory, the way the
            // plan names it for A — not inferred from the object or asset names.
            Fixed("hair", InterpenetrationHairPrefab(material));

            var plan = D("body_prefab", Body, "outfits", specs, "face", D("mode", "preserve"), "menu", D("mode", "preserve"));
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
            Environment.SetEnvironmentVariable("AVH_MANIFEST", "{\"assets\":[{\"item\":\"A\"}]}");
            Avh.WriteJson(Avh.Abs("_harness/setup/baseline.json"), D("body_prefab", Body));
            Avh.WriteJson(Avh.Abs("_harness/setup/import.json"), D("packages", new List<object> { D("item", "A", "roots", new List<object> { "Assets/Authorized" }) }));
            Avh.WriteJson(Avh.Abs("_harness/intake/inventory.json"), D("schema", "inventory/0.1", "items", new List<object>
            {
                D("item", "inputhair", "role", "hair"), D("item", "inputpokes", "role", "outfit"),
            }));
            AssetDatabase.SaveAssets();
        }

        static void Observe()
        {
            var body = AssetDatabase.LoadAssetAtPath<GameObject>(Body);
            LocalOperations.Observe(body, Avh.Plan());
        }

        static void Operations((string id, string path, bool rationale)[] closures, List<object> userReview = null,
            List<object> decisions = null)
        {
            var file = Avh.Abs(LocalOperations.InputPath);
            if (closures.Length == 0 && userReview == null && decisions == null) { if (File.Exists(file)) File.Delete(file); return; }
            var observation = File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath));
            var operations = new List<object>();
            foreach (var closure in closures)
            {
                var operation = D("id", closure.id, "kind", "object_state", "path", closure.path, "active", false, "exclude_from_build", true);
                if (closure.rationale) operation["rationale"] = "夹具：这一件与同位置的另一件几何重合，保留客户点名的那一件";
                operations.Add(operation);
            }
            var document = D("schema", "local-operations/0.1", "observation_sha256", LocalOperations.Digest(observation), "operations", operations);
            if (userReview != null) document["user_review"] = userReview;
            if (decisions != null) document["interpenetration_decisions"] = decisions;
            Avh.WriteJson(file, document);
        }

        /// <summary>One `interpenetration_decisions` entry the way the executor writes it (`D-143` ③).</summary>
        static Dictionary<string, object> Decision(string layer, string outer, string decision,
            string criterion = null, string evidence = null, string rationale = null, string review = null)
        {
            var row = D("objects", new List<object> { layer, outer }, "decision", decision);
            if (criterion != null) row["criterion"] = criterion;
            if (evidence != null) row["evidence"] = evidence;
            if (rationale != null) row["rationale"] = rationale;
            if (review != null) row["review"] = review;
            return row;
        }

        /// <summary>`D-148`: one numbered trade-off with executable options, the way the executor writes it.
        /// `recommended` is typed loosely so a refusal case can submit a list where one id belongs.</summary>
        static Dictionary<string, object> TradeOff(string id, string question, string detail, List<object> options,
            object recommended, object current) =>
            D("id", id, "question", question, "detail", detail, "options", options,
                "recommended", recommended, "current", current);

        /// <summary>One option of a numbered trade-off: a label and the recoverable operations it stands for.</summary>
        static Dictionary<string, object> TradeOption(string id, string label, params object[] operations) =>
            D("id", id, "label", label, "operations", new List<object>(operations));

        /// <summary>A recoverable `object_state` the way an option carries it.</summary>
        static Dictionary<string, object> Recovery(string path, bool active, string rationale) =>
            D("kind", "object_state", "path", path, "active", active, "rationale", rationale);

        /// <summary>Writes a recipe that differs only in its user_review and requires the stage to refuse it.</summary>
        static void RefusesReview(string label, object review)
        {
            var observation = File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath));
            var document = D("schema", "local-operations/0.1", "observation_sha256", LocalOperations.Digest(observation), "operations", new List<object>());
            document["user_review"] = review;
            Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), document);
            var refused = false;
            try { OutfitStage.Produce(); }
            catch (Exception error) { refused = error.Message.Contains("user_review"); }
            Require(refused, label + " 应被拒");
        }

        static List<object> Pairs(Dictionary<string, object> document) => document.List("pairs");
        static List<string> Paths(Dictionary<string, object> document) => document.List("renderers").Select(row => ((Dictionary<string, object>)row).Str("path")).ToList();
        static Dictionary<string, object> Row(Dictionary<string, object> document, string list, Func<Dictionary<string, object>, bool> match) =>
            document.List(list).Cast<Dictionary<string, object>>().SingleOrDefault(row => match(row));

        static void ScenarioBaseline()
        {
            Observe();
            Operations(new (string, string, bool)[0]);
            OutfitStage.Produce();
            var metrics = Metrics("clothing.install");
            Close(Number(metrics, "visible_overlap_pairs"), 5, "两两重合的可见部件对数不对");
            Close(Number(metrics, "visible_overlap_stacks"), 3, "同位叠放的连通分量数不对");
            Close(Number(metrics, "visible_overlap_max_cm2"), 2400, "最大互接触面积不对");
            Require(Equals(metrics["visible_overlap_measured"], true), "量距应标记为已量");

            var document = Json(OutfitVisibility.Path);
            Require(document.Str("schema") == "outfit-visibility/0.1", "schema 不对");
            Close(Convert.ToDouble(document["epsilon_mm"]), 0.1, "dokument epsilon 不对");
            Close(Convert.ToDouble(document["min_contact_cm2"]), 1.0, "document 阈值不对");
            var paths = Paths(document);
            // 14 parts of the D-138 fixture + 21 sheets of the D-143/GI2 poke fixture + 2 of the hair source
            // + 3 ears on the head.
            Require(paths.Count == 40, "可见渲染器应恰好列出 40 个，实际 " + paths.Count);
            Require(paths.Contains("Body_base") && paths.Contains("Pocket") && paths.Contains("Collar"), "素体件必须在可见清单里");
            var garment = Row(document, "renderers", row => row.Str("path") == "_Outfit/Outfit_variant/Part_default");
            Require(garment != null && garment.Str("source") == "outfit:variant" && garment.Str("part") == "Outfit_variant/Part_default", "服装件的来源或部件路径不对");
            Require(Convert.ToInt32(garment["vertices"]) == 24 && Convert.ToInt32(garment["triangles"]) == 12, "顶点/三角面读数不对");
            var owned = Row(document, "renderers", row => row.Str("path") == "Pocket");
            Require(owned != null && owned.Str("source") == "body" && owned.Str("part") == "Pocket", "素体自带衣物的来源不对");
            Require(Equals(owned["visible"], true), "清单里的件应标为可见");

            var pairs = Pairs(document).Cast<Dictionary<string, object>>().ToList();
            Require(pairs.Count == 5, "document 里应列 5 对，实际 " + pairs.Count);
            var contacts = pairs.Select(row => Convert.ToDouble(row["contact_cm2"])).ToList();
            Require(contacts.SequenceEqual(contacts.OrderByDescending(value => value)), "pairs 必须按面积降序");
            Require(pairs.All(row => Convert.ToDouble(row["contact_cm2"]) >= 0.01), "pairs 只列 ≥0.01 cm² 的对");
            Require(pairs.Any(row => row.Str("a").Contains("Part_default") && row.Str("b").Contains("Part_small")), "同件尺寸版本必须成对");
            var woven = pairs.Single(row => row.Str("a").Contains("Outfit_stack_a") || row.Str("b").Contains("Outfit_stack_a"));
            Require(Equals(woven["same_source"], false), "跨服装的一对必须标为不同来源");
            Require(pairs.All(row => !row.Str("a").Contains("SkinShell") && !row.Str("b").Contains("SkinShell")), "素体皮肤不得参与重叠计数");
            Require(pairs.All(row => !row.Str("a").Contains("Inner") && !row.Str("b").Contains("Inner")), "2 mm／0.5 mm 的合理上下层不得计入");
            var stacks = document.List("stacks").Cast<Dictionary<string, object>>().ToList();
            Require(stacks.Count == 3, "堆数不对");
            Require(stacks.Any(stack => stack.List("members").Count == 3), "同件三副本应合成一个堆");

            var sets = document.List("body_sets").Cast<Dictionary<string, object>>().ToList();
            var difference = sets.SingleOrDefault(row => row.Str("evidence") == "prefab_difference");
            Require(difference != null && difference.List("members").Count == 1 && difference.List("members")[0].ToString() == "Pocket",
                "素体预制体差集应给出成组的 Pocket");
            var vendor = sets.SingleOrDefault(row => row.Str("evidence") == "vendor_clip");
            Require(vendor != null && vendor.List("members").Select(x => x.ToString()).OrderBy(x => x, StringComparer.Ordinal).SequenceEqual(new[] { "Collar", "Pocket" }),
                "厂商开关动画应给出成组的 Collar/Pocket");
            Require(document.List("hidden_by_decision").Count == 0, "没有局部操作时不应有记录在案的关闭");
            Close(Number(metrics, "fixed_outfit_state_failures"), 0, "基线装配的固定件不该失败");

            // D-143 ①: every visible renderer carries a body part, and the parts are grouped by part and source.
            var ears = new[] { "Hips/Spine/Chest/Neck/Head/Ear_A", "Hips/Spine/Chest/Neck/Head/Ear_B", "Ear_Skinned" };
            foreach (var ear in ears)
            {
                var row = Row(document, "renderers", candidate => candidate.Str("path") == ear);
                Require(row != null && row.Str("body_part") == "头", ear + " 应归到「头」，实际 " + (row == null ? "缺失" : row.Str("body_part")));
            }
            var head = document.List("body_parts").Cast<Dictionary<string, object>>().SingleOrDefault(section => section.Str("part") == "头");
            Require(head != null, "按身体部位的摘要里应有「头」一节");
            var headPaths = head.List("by_source").Cast<Dictionary<string, object>>()
                .SelectMany(group => group.List("paths").Select(path => path.ToString())).ToList();
            Require(ears.All(ear => headPaths.Contains(ear)), "三件耳饰都应在「头」这一节里，实际 " + string.Join(",", headPaths));
            Require(document.List("body_parts").Cast<Dictionary<string, object>>().All(section => section.List("by_source").Count > 0
                && section.List("by_source").Cast<Dictionary<string, object>>().All(group => !string.IsNullOrEmpty(group.Str("source")) && group.List("paths").Count > 0)),
                "按身体部位的每一节都要按来源列出件");
            // D-149: the role a source has in the order has to be readable from the by-body-part evidence, not
            // guessed from an asset name — that is what decides whether an accessory set yields to the clothing.
            var bySource = document.List("body_parts").Cast<Dictionary<string, object>>()
                .SelectMany(section => section.List("by_source").Cast<Dictionary<string, object>>()).ToList();
            Require(bySource.All(group => !string.IsNullOrEmpty(group.Str("role"))),
                "按身体部位的每个来源都要写出它在订单里的角色（D-149）");
            var pokesGroups = bySource.Where(group => group.Str("source") == "outfit:pokes").ToList();
            Require(pokesGroups.Count > 0 && pokesGroups.All(group => group.Str("role") == "outfit"),
                "角色的口径应是方案/清点里声明的，而不是名字：outfit:pokes 的每组都应读作 outfit，实际 "
                + string.Join("/", pokesGroups.Select(group => group.Str("role"))));

            // D-143 ②: the geometry proposes pairs, the picture confirms them. D-143 ③: every confirmed pair above
            // the noise gate is evidence the executor has to decide on — with no recipe, none of them is decided,
            // so all of them count.
            var pokes = document.Obj("visible_interpenetration");
            Require(pokes != null && Equals(pokes["valid"], true), "衣物互穿的读数应是有效的");
            var rows = pokes.List("pairs").Cast<Dictionary<string, object>>().ToList();
            var candidates = rows.Where(row => Convert.ToInt32(row["confirmed"]) >= OutfitVisibility.MinVisibleInterpenetrationVertices).ToList();
            Require(candidates.Count == 6, "①⑦⑧⑨⑩⑪ 六对应达到最小量，实际 " + candidates.Count);
            Require(Convert.ToInt32(pokes["counted_pairs"]) == 6 && Convert.ToInt32(pokes["undecided_pairs"]) == 6
                && Convert.ToInt32(pokes["out_of_bounds_accepted_pairs"]) == 0 && Convert.ToInt32(pokes["ask_user_pairs"]) == 0,
                "没有决定时 6 对都应按未决定计入阻断，实际 " + pokes["counted_pairs"]);
            Require(Convert.ToInt32(metrics["visible_interpenetration_pairs"]) == 6
                && Convert.ToInt32(metrics["visible_interpenetration_undecided"]) == 6
                && Convert.ToInt32(metrics["visible_interpenetration_out_of_bounds_accepted"]) == 0
                && Convert.ToInt32(metrics["visible_interpenetration_ask_user"]) == 0, "阻断计数应是未决定的 6 对");
            Require(rows.All(row => Convert.ToString(row["decision"]) == "none" && !Equals(row["decision_valid"], true)),
                "没有配方时每一对的决定都应是 none");
            var poking = rows.SingleOrDefault(row => row.Str("layer") != null && row.Str("layer").Contains("SkirtA"));
            Require(poking != null && Equals(poking["counted"], true), "①里层裙子顶出外套应被计入");
            Require(poking.Str("outer").Contains("CoatA"), "①的外层应是外套，实际 " + poking.Str("outer"));
            Require(Convert.ToInt32(poking["confirmed"]) >= OutfitVisibility.MinVisibleInterpenetrationVertices,
                "①的确认顶点数应达到最小量，实际 " + poking["confirmed"]);
            // D-143 ③'s evidence: parts, sources, roles, the visible pixels and the depth distribution.
            Require(!string.IsNullOrEmpty(poking.Str("body_part")) && !string.IsNullOrEmpty(poking.Str("outer_part")),
                "①那一行应带上两件各自量到的身体部位");
            Require(poking.Str("layer_source") == "outfit:pokes" && poking.Str("layer_role") == "outfit",
                "①的来源与订单角色应是量出来的（" + poking.Str("layer_source") + "/" + poking.Str("layer_role") + "）");
            Require(Convert.ToInt32(poking["visible_pixels"]) > 0, "①应给出渲图里看得见的像素量");
            Require(Convert.ToDouble(poking["depth_max_mm"]) > 0, "①应给出穿出深度分布");
            PokePartA = poking.Str("body_part");
            // ② and ③ are never even proposed: no poke at all, and a layer worn outside the other one.
            Require(rows.All(row => !row.Str("layer").Contains("SkirtB")), "②里层完全被盖住不该成为候选");
            Require(rows.All(row => !row.Str("layer").Contains("BeltC")), "③系在外面的腰带不该被当成穿出");
            Require(rows.All(row => !row.Str("outer").Contains("BeltC")), "③外套也不该反过来被判成里层");
            // ④ is proposed and visible, but one cell is below the noise gate; ⑤ and ⑥ are proposed and rejected
            // by the picture, so the minimum is not what keeps them out.
            var seam = rows.SingleOrDefault(row => row.Str("layer").Contains("SkirtD"));
            Require(seam != null && Convert.ToInt32(seam["confirmed"]) > 0
                && Convert.ToInt32(seam["confirmed"]) < OutfitVisibility.MinVisibleInterpenetrationVertices
                && !Equals(seam["counted"], true), "④缝线处应被提出、看得见、但低于最小量，不该要决定");
            var opening = rows.SingleOrDefault(row => row.Str("layer").Contains("SkirtE"));
            Require(opening != null && Convert.ToInt32(opening["candidates"]) > 0 && Convert.ToInt32(opening["confirmed"]) == 0,
                "⑤关掉里层后露出的是别的件，不该确认");
            var shadowed = rows.SingleOrDefault(row => row.Str("layer").Contains("SkirtF"));
            Require(shadowed != null && Convert.ToInt32(shadowed["candidates"]) > 0 && Convert.ToInt32(shadowed["confirmed"]) == 0,
                "⑥同一件的更近表面占着像素，深度不符，不该确认");
            // ⑦ the inner layer sits between the outer garment's shell and its lining: the nearest face is the
            // lining, so only the "is more of that garment in front of me" test makes it the inner layer at all.
            var lined = rows.SingleOrDefault(row => row.Str("layer").Contains("SkirtG"));
            Require(lined != null && Equals(lined["counted"], true) && lined.Str("outer").Contains("CoatG"),
                "⑦夹在外套外壳与里衬之间的里层顶出外壳，应被计入并要一个决定");
            PokePartG = lined.Str("body_part");
            Require(Convert.ToInt32(metrics["visible_interpenetration_candidate_pairs"]) >= 6,
                "至少应有 6 对进入渲图确认，实际 " + metrics["visible_interpenetration_candidate_pairs"]);
            // ⑧ is a film-thin crossing and ⑨ involves the order's hairstyle: both are EVIDENCE now — they still
            // need a decision, and the reading hands over the depth and the role instead of filtering them out.
            var thin = rows.SingleOrDefault(row => row.Str("layer").Contains("SkirtH"));
            Require(thin != null && Convert.ToInt32(thin["confirmed"]) >= OutfitVisibility.MinVisibleInterpenetrationVertices
                && Equals(thin["counted"], true) && !Equals(thin["out_of_bounds"], true),
                "⑧薄相交仍要一个决定，且不该越护栏，实际 " + (thin == null ? "缺失" : thin["out_of_bounds"]));
            Require(Convert.ToDouble(thin["depth_max_mm"]) > 0
                && Convert.ToDouble(thin["depth_max_mm"]) < OutfitVisibility.GuardVisibleInterpenetrationDepthMm,
                "⑧的穿出深度应远低于护栏，实际 " + thin["depth_max_mm"]);
            var hair = rows.SingleOrDefault(row => row.Str("layer").Contains("HairI") || row.Str("outer").Contains("HairI"));
            Require(hair != null && (hair.Str("layer_role") == "hair" || hair.Str("outer_role") == "hair"),
                "⑨应把发型来源的角色作为证据给出，实际 " + (hair == null ? "缺失" : hair.Str("layer_role") + "/" + hair.Str("outer_role")));
            Require(Equals(hair["counted"], true) && !Equals(hair["out_of_bounds"], true), "⑨也仍要一个决定，且不越护栏");
            // ⑩ is a broad, deep poke: it must cross the guard bound, so no `accept` may wave it through.
            var broad = rows.SingleOrDefault(row => row.Str("layer").Contains("SkirtK"));
            Require(broad != null && Equals(broad["out_of_bounds"], true) && Equals(broad["counted"], true),
                "⑩成片穿出应越护栏并仍要一个决定，实际 " + (broad == null ? "缺失" : broad["out_of_bounds"]));
            Require(Convert.ToInt32(broad["confirmed"]) > OutfitVisibility.GuardVisibleInterpenetrationVertices,
                "⑩的确认顶点数应超过护栏，实际 " + broad["confirmed"]);
            // ⑪ is GI2's depth-gate case: small (well under the vertex guard) but its deepest sample sits on the
            // instrument's range, so the reading must hand over a lower bound ("at least") and mark it out of
            // bounds — an `accept` may not claim a depth that was never measured inside the guard.
            var ceiling = rows.SingleOrDefault(row => row.Str("layer").Contains("SkirtL"));
            Require(ceiling != null && Convert.ToInt32(ceiling["confirmed"]) < OutfitVisibility.GuardVisibleInterpenetrationVertices
                && Equals(ceiling["depth_at_least"], true) && Equals(ceiling["out_of_bounds"], true),
                "⑪深度只到量程上界时必须标成下界并越护栏，实际 " + (ceiling == null ? "缺失" : ceiling["depth_at_least"] + "/" + ceiling["out_of_bounds"]));
            Require(Convert.ToDouble(ceiling["depth_max_mm"]) >= OutfitVisibility.PokeReachMm - 0.01
                && Convert.ToDouble(ceiling["depth_max_mm"]) < OutfitVisibility.PokeReachMm,
                "⑪的最深读数应贴着量程上界而不是当作测量值，实际 " + ceiling["depth_max_mm"]);
            var installNotes = Observations("clothing.install").List("notes").Select(note => note.ToString()).ToList();
            Require(installNotes.Any(note => note.Contains("至少") && note.Contains("SkirtL")),
                "量到上界的那一对在注记里必须写「至少」");
            Require(Convert.ToInt32(metrics["visible_interpenetration_max"]) == candidates.Max(row => Convert.ToInt32(row["confirmed"])),
                "最大确认量应是各确认对里最大的确认顶点数");
        }

        /// <summary>Same-named sibling renderers keep the public path format but must both be measured.</summary>
        static void ScenarioDuplicatePaths()
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            var parent = new GameObject("DuplicateParent");
            parent.transform.SetParent(avatar.transform, false);
            var material = AssetDatabase.LoadAssetAtPath<Material>("Assets/Authorized/fixture.mat");
            Cube(parent.transform, "DuplicateRenderer", new Vector3(0f, 4f, 0f), 0.04f, material);
            Cube(parent.transform, "DuplicateRenderer", new Vector3(0f, 4f, 0f), 0.04f, material);
            try
            {
                PrefabUtility.SaveAsPrefabAsset(avatar, OutfitStage.AvatarPath);
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }

            try
            {
                // Read the persisted artifact through the clothing.install observer without exiting the editor.
                OutfitMeasure.Write(OutfitStage.AvatarPath, OutfitStage.RecordPath);
                var metrics = Metrics("clothing.install");
                Require(Equals(metrics["visible_overlap_measured"], true), "重名渲染器不应让可见性读数变成 no_data");
                Require(Equals(metrics["visible_interpenetration_measured"], true), "重名渲染器不应让互穿读数变成 no_data");
                foreach (var key in new[] { "visible_overlap_pairs", "visible_overlap_stacks", "visible_overlap_max_cm2",
                    "visible_interpenetration_pairs", "visible_interpenetration_max", "visible_interpenetration_undecided" })
                    Number(metrics, key);
                var duplicatePath = "DuplicateParent/DuplicateRenderer";
                var rows = Json(OutfitVisibility.Path).List("renderers").Cast<Dictionary<string, object>>()
                    .Where(row => row.Str("path") == duplicatePath).ToList();
                Require(rows.Count == 2 && rows.All(row => Equals(row["visible"], true)),
                    "同一路径下的两个渲染器必须都出现在可见清单里，实际 " + rows.Count);
            }
            finally
            {
                var saved = AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath);
                var cleaned = (GameObject)PrefabUtility.InstantiatePrefab(saved);
                var duplicate = cleaned.transform.Find("DuplicateParent");
                if (duplicate != null) UnityEngine.Object.DestroyImmediate(duplicate.gameObject);
                PrefabUtility.SaveAsPrefabAsset(cleaned, OutfitStage.AvatarPath);
                UnityEngine.Object.DestroyImmediate(cleaned);
            }
        }

        /// <summary>
        /// `D-143` ③, the orderer's direction: the executor decides every confirmed pair — `close` (with the
        /// closure the recipe really carries), `accept` (naming the criterion, inside both guard bounds) or
        /// `ask_user` (kept for the user). The Runtime only counts the pairs no decision settles, and the
        /// out-of-bounds pairs that were accepted anyway.
        /// </summary>
        static void ScenarioInterpenetrationDecisions()
        {
            Observe();
            // `D-148`: the pair kept for the user names a numbered trade-off; its options live there and nowhere
            // else. `current` is A (keep both), which is what this recipe really does.
            var review = new List<object>
            {
                TradeOff("T1", "⑦这一处互穿要不要保留订单点名的里层裙？",
                    "确认顶点数达到最小量，两件都是订单点名来源；保留就是保持现状，关掉会改变默认外观。",
                    new List<object>
                    {
                        TradeOption("A", "两件都保留（保持现状）"),
                        TradeOption("B", "关掉里层裙", Recovery("_Outfit/Outfit_pokes/SkirtG", false,
                            "夹具：按这条方案把订单没点名的那件关掉")),
                    }, "A", "A"),
            };
            Operations(new[] { ("interpenetration_inner_dress", "_Outfit/Outfit_pokes/SkirtA", true) },
                review, new List<object>
                {
                    Decision("_Outfit/Outfit_pokes/SkirtA", "_Outfit/Outfit_pokes/CoatA", "close",
                        rationale: "①从外套里成片穿出，按同一部位/内层规则关掉里层那件（可恢复）"),
                    Decision("_Outfit/Outfit_pokes/SkirtG", "_Outfit/Outfit_pokes/CoatG", "ask_user",
                        rationale: "⑦是订单点名要露出的里层，保留它并把这一处交用户定", review: "T1"),
                    Decision("_Outfit/Outfit_pokes/SkirtH", "_Outfit/Outfit_pokes/CoatH", "accept",
                        criterion: "按正常观看距离看不出来（薄薄一层）", evidence: "depth_max 远低于护栏"),
                    Decision("_Outfit/Outfit_hair/HairI", "_Outfit/Outfit_hair/CoatI", "accept",
                        criterion: "头发与外套的相交默认不管", evidence: "outer_role=hair"),
                    Decision("_Outfit/Outfit_pokes/SkirtK", "_Outfit/Outfit_pokes/CoatK", "accept",
                        criterion: "订单点名的件优先保留", evidence: "confirmed 超过护栏"),
                    Decision("_Outfit/Outfit_pokes/SkirtL", "_Outfit/Outfit_pokes/CoatL", "accept",
                        criterion: "按正常观看距离看不出来", evidence: "确认点数不高"),
                });
            OutfitStage.Produce();
            var metrics = Metrics("clothing.install");
            // Five decisions settle their pairs; the broad ⑩ is out of bounds by vertex count and the GI2 ⑪ by a
            // depth that never measured inside the guard, so neither accept may take effect.
            Close(Number(metrics, "visible_interpenetration_pairs"), 2, "越界却被 accept 的两对必须阻断，实际 " + metrics["visible_interpenetration_pairs"]);
            Close(Number(metrics, "visible_interpenetration_undecided"), 0, "每一对都写了决定");
            Close(Number(metrics, "visible_interpenetration_out_of_bounds_accepted"), 2, "⑩⑪应记为越界却被接受");
            Close(Number(metrics, "visible_interpenetration_ask_user"), 1, "⑦应记为交给用户");
            var pokes = Json(OutfitVisibility.Path).Obj("visible_interpenetration");
            Require(Convert.ToInt32(pokes["counted_pairs"]) == 2 && Convert.ToInt32(pokes["out_of_bounds_accepted_pairs"]) == 2
                && Convert.ToInt32(pokes["ask_user_pairs"]) == 1, "文档里的三个计数应分别是 2/2/1");
            var kept = Paths(Json(OutfitVisibility.Path));
            Require(!kept.Contains("_Outfit/Outfit_pokes/SkirtA") && kept.Contains("_Outfit/Outfit_pokes/CoatA"),
                "close 的决定必须真的有那条关闭：①被关掉、外层还在");
            Require(kept.Contains("_Outfit/Outfit_pokes/SkirtG"), "ask_user 的那件必须保留在可见清单里");
            var hiddenRows = Json(OutfitVisibility.Path).List("hidden_by_decision").Cast<Dictionary<string, object>>().ToList();
            Require(hiddenRows.Any(row => row.Str("path") == "_Outfit/Outfit_pokes/SkirtA"),
                "这条关闭应带理由进记录，实际 " + hiddenRows.Count + " 条：" + string.Join("、", hiddenRows.Select(row => row.Str("path"))));
            // Closing ① removes its pair from the reading, so the decisions rows are the pairs that remain.
            var decisionRows = pokes.List("decisions").Cast<Dictionary<string, object>>().ToList();
            Require(decisionRows.Count == 5 && decisionRows.All(row => !row.Str("layer").Contains("SkirtA")),
                "被关掉的那一对不该再出现在要决定的对里，实际 " + decisionRows.Count);
            var userRow = decisionRows.Single(row => row.Str("layer").Contains("SkirtG"));
            Require(Equals(userRow["decision_valid"], true) && Convert.ToString(userRow["decision"]) == "ask_user",
                "⑦的 ask_user 决定应生效且不计入阻断");
            var hairRow = decisionRows.Single(row => row.Str("layer").Contains("HairI"));
            Require(Equals(hairRow["decision_valid"], true) && Convert.ToString(hairRow["outer_role"]) == "hair",
                "⑨的 accept 应按「头发默认不管」生效，且证据里带着发型角色");
            var broadRow = decisionRows.Single(row => row.Str("layer").Contains("SkirtK"));
            Require(Equals(broadRow["counted"], true) && !Equals(broadRow["decision_valid"], true)
                && Convert.ToString(broadRow["decision_note"]).Contains("越界"), "⑩的 accept 应因越界而不生效");
            // The GI2 case: the depth never measured inside the guard, so the reading is a lower bound and the
            // accept must not take effect — the note has to say why.
            var ceilingRow = decisionRows.Single(row => row.Str("layer").Contains("SkirtL"));
            Require(Equals(ceilingRow["counted"], true) && !Equals(ceilingRow["decision_valid"], true)
                && Convert.ToString(ceilingRow["decision_note"]).Contains("至少"), "⑪的 accept 应因深度只到量程上界而不生效");
            // The receipt carries the decisions verbatim: the delivery note reads them to show the trade-offs.
            var receipt = Json(LocalOperations.OutputPath);
            var echoed = receipt.List("interpenetration_decisions").Cast<Dictionary<string, object>>().ToList();
            Require(echoed.Count == 6 && echoed.Any(row => Convert.ToString(row["decision"]) == "ask_user"),
                "六条决定必须原样进回执（交付说明的「需要你确认的取舍」读的就是它）");
            Operations(new (string, string, bool)[0]);
        }

        /// <summary>
        /// A decision that does not fit the measurement settles nothing: a `close` without the closure, an `accept`
        /// without the criterion it followed, an `ask_user` without a reason. Those pairs — and every pair left
        /// without a decision — stay in the blocking counter, and the reading says which condition failed.
        /// </summary>
        static void ScenarioInterpenetrationInvalidDecisions()
        {
            Observe();
            // The ask_user still has to name its trade-off: what this scenario tests is the missing reason, not a
            // missing number, so the number points at a valid item whose current option matches this empty recipe.
            var review = new List<object>
            {
                TradeOff("T1", "⑧这一对要不要保留？", "夹具：ask_user 但没有写理由。",
                    new List<object>
                    {
                        TradeOption("A", "两件都保留（保持现状）"),
                        TradeOption("B", "关掉里层", Recovery("_Outfit/Outfit_pokes/SkirtH", false,
                            "夹具：按这条方案关掉里层")),
                    }, "A", "A"),
            };
            Operations(new (string, string, bool)[0], review, new List<object>
            {
                Decision("_Outfit/Outfit_pokes/SkirtA", "_Outfit/Outfit_pokes/CoatA", "close",
                    rationale: "夹具：写了 close 却没有这条关闭"),
                Decision("_Outfit/Outfit_pokes/SkirtG", "_Outfit/Outfit_pokes/CoatG", "accept",
                    evidence: "夹具：accept 但没写准则"),
                Decision("_Outfit/Outfit_pokes/SkirtH", "_Outfit/Outfit_pokes/CoatH", "ask_user", review: "T1"),
            });
            OutfitStage.Produce();
            var metrics = Metrics("clothing.install");
            Close(Number(metrics, "visible_interpenetration_pairs"), 6, "三条无效决定加三对没有决定，六对都该阻断");
            Close(Number(metrics, "visible_interpenetration_undecided"), 6, "无效决定按未决定计入");
            Close(Number(metrics, "visible_interpenetration_ask_user"), 0, "无效的 ask_user 不算交给用户");
            var pokes = Json(OutfitVisibility.Path).Obj("visible_interpenetration");
            var decisions = pokes.List("decisions").Cast<Dictionary<string, object>>().ToList();
            Require(Convert.ToString(decisions.Single(row => row.Str("layer").Contains("SkirtA"))["decision_note"]).Contains("没有关掉"),
                "close 没有对应关闭时应说明");
            Require(Convert.ToString(decisions.Single(row => row.Str("layer").Contains("SkirtG"))["decision_note"]).Contains("准则"),
                "accept 没写准则时应说明");
            Require(Convert.ToString(decisions.Single(row => row.Str("layer").Contains("SkirtH"))["decision_note"]).Contains("为什么留给用户"),
                "ask_user 没写理由时应说明");
            Operations(new (string, string, bool)[0]);
        }


        /// <summary>
        /// GI2: the dependency observation describes the assembled artifact, so it is written before any other
        /// measurement touches the instance. The render confirmation installs its own id/depth materials on the
        /// renderers while it runs; a walk taken after it reported broken GUID references the artifact never had
        /// (GI1 measured 4 on A against 0 with the order right). The fixture makes both halves observable: a
        /// synthetic material with a missing GUID shows that the walk reads whatever a measurement left
        /// installed, and a before/after control shows that the visibility measurement changes the reading.
        /// </summary>
        static void ScenarioDependencyOrder()
        {
            Observe();
            Operations(new (string, string, bool)[0]);
            OutfitStage.Produce();
            // The product's order: walk first. It must read the artifact, not the measurement's temporary state.
            OutfitMeasure.WriteAvatar(OutfitStage.AvatarPath, OutfitStage.RecordPath);
            Close(Number(Metrics("avatar.dependencies"), "broken_guid_refs"), 0, "依赖观察应读到干净的装配产物（0 条断链）");

            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath);
            var record = Json(OutfitStage.RecordPath);
            var avatar = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            var dangling = DanglingMaterial("Assets/Authorized/gi2_dangling.mat");
            try
            {
                // Control 1: the walk is sensitive to what a measurement leaves installed. The synthetic
                // missing-GUID material is installed exactly the way the render confirmation installs its id
                // materials, and it must show up in the reading.
                var saved = new Dictionary<Renderer, Material[]>();
                foreach (var renderer in avatar.GetComponentsInChildren<Renderer>(true))
                {
                    if (!(renderer is MeshRenderer) && !(renderer is SkinnedMeshRenderer)) continue;
                    saved[renderer] = renderer.sharedMaterials;
                    renderer.sharedMaterials = new[] { dangling };
                }
                EffectiveReferences.WriteObservation(avatar);
                var measurementState = Convert.ToDouble(Number(Metrics("avatar.dependencies"), "broken_guid_refs"));
                foreach (var pair in saved) pair.Key.sharedMaterials = pair.Value;
                Require(measurementState > 0, "量测期装上的缺失 GUID 材质必须出现在走查里，实际 " + measurementState);

                // Control 2: the order itself. Walk, run the visibility measurement (which installs its own
                // temporary materials), walk again. On this synthetic artifact the measurement restores every
                // material, so both walks read the same (0): the exact stale handle A produced is not reproducible
                // here. The order invariant itself is pinned by the source-level mutation test in
                // test/outfit-visible-overlaps.test.ts; this control is kept as the reading that says so.
                EffectiveReferences.WriteObservation(avatar);
                var before = Convert.ToDouble(Number(Metrics("avatar.dependencies"), "broken_guid_refs"));
                OutfitVisibility.Measure(avatar, record.Str("body_prefab"), null, new List<string>(), new List<Dictionary<string, object>>());
                EffectiveReferences.WriteObservation(avatar);
                var after = Convert.ToDouble(Number(Metrics("avatar.dependencies"), "broken_guid_refs"));
                Avh.Log("GI2 dependency order: before=" + before + " after=" + after);
                Require(after <= before, "visibility measurement must not add references the artifact never had（先 " + before + " 后 " + after + "）");
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }

        /// <summary>A material asset whose shader reference is a GUID nothing resolves: the synthetic
        /// "missing GUID" material the order fixture installs like a measurement's own temporary material.</summary>
        static Material DanglingMaterial(string path)
        {
            var material = new Material(Shader.Find("Standard"));
            AssetDatabase.CreateAsset(material, path);
            AssetDatabase.SaveAssets();
            var guid = new string('c', 32);
            var text = File.ReadAllText(Avh.Abs(path));
            File.WriteAllText(Avh.Abs(path), System.Text.RegularExpressions.Regex.Replace(text, @"m_Shader: \{[^}]*\}",
                "m_Shader: {fileID: 4800000, guid: " + guid + ", type: 3}"));
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
            return AssetDatabase.LoadAssetAtPath<Material>(path);
        }

        static void ScenarioClosures()
        {
            Observe();
            Operations(new[]
            {
                ("stocking_variant_small", "_Outfit/Outfit_variant/Part_small", true),
                ("stocking_vendor_test", "_Outfit/Outfit_variant/ClippingWarning_test", true),
                // The closure names the container, not the renderer: a recorded closure covers what hangs below it.
                ("woven_second", "_Outfit/Outfit_stack_b/Armature", true),
                ("body_owned_cover", "_Outfit/Outfit_pocket_cover/Cover", true),
            });
            OutfitStage.Produce();
            var metrics = Metrics("clothing.install");
            Close(Number(metrics, "visible_overlap_pairs"), 0, "记录在案的关闭后不该再有同位叠放");
            Close(Number(metrics, "visible_overlap_stacks"), 0, "记录在案的关闭后不该再有堆");
            Close(Number(metrics, "visible_overlap_max_cm2"), 0, "记录在案的关闭后最大互接触应为 0");
            Close(Number(metrics, "fixed_outfit_state_failures"), 0, "记录在案的关闭不得让固定件判据误判");

            var document = Json(OutfitVisibility.Path);
            var paths = Paths(document);
            foreach (var closed in new[] { "_Outfit/Outfit_variant/Part_small", "_Outfit/Outfit_variant/ClippingWarning_test", "_Outfit/Outfit_stack_b/Armature/Layer", "_Outfit/Outfit_pocket_cover/Cover" })
                Require(!paths.Contains(closed), "被关掉的件不该还在可见清单里：" + closed);
            Require(paths.Contains("_Outfit/Outfit_variant/Part_default"), "保留的那一件应仍在可见清单里");
            Require(paths.Contains("Pocket"), "素体自带衣物未关闭，应仍可见");
            var hidden = document.List("hidden_by_decision").Cast<Dictionary<string, object>>().ToList();
            Require(hidden.Count == 4, "应按件列出 4 条记录在案的关闭，实际 " + hidden.Count);
            Require(hidden.All(row => !string.IsNullOrEmpty(row.Str("operation")) && !string.IsNullOrEmpty(row.Str("rationale"))),
                "每条关闭都要带操作 id 与理由");

            var record = Json(OutfitStage.RecordPath);
            var variant = record.List("outfits").Cast<Dictionary<string, object>>().Single(row => row.Str("id") == "variant");
            Require(variant.List("fixed_visuals").Count == 1 && variant.List("fixed_visuals")[0].ToString() == "_Outfit/Outfit_variant/Part_default",
                "应显示集合必须扣除记录在案的件");
            Require(variant.List("hidden_by_decision").Count == 2, "装配记录里该服装应单列被扣除的件");
            var emptied = record.List("outfits").Cast<Dictionary<string, object>>().Single(row => row.Str("id") == "stack_b");
            Require(emptied.List("fixed_visuals").Count == 0 && emptied.List("hidden_by_decision").Count == 1, "整件被关闭时该服装的应显示集合应为空");

            // Negative control: a fixed part that disappears without any record must still fail, so the
            // deduction cannot be mistaken for relaxing the fixed check itself.
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(OutfitStage.AvatarPath);
            var tampered = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            AvatarAudit.Locate(tampered.transform, "_Outfit/Outfit_tight/ShellInner").gameObject.SetActive(false);
            PrefabUtility.SaveAsPrefabAsset(tampered, OutfitStage.AvatarPath);
            UnityEngine.Object.DestroyImmediate(tampered);
            OutfitMeasure.Write(OutfitStage.AvatarPath, OutfitStage.RecordPath);
            Require(Number(Metrics("clothing.install"), "fixed_outfit_state_failures") > 0, "没有记录就消失的固定件必须照样失败");
        }

        static void ScenarioRefusal()
        {
            Observe();
            Operations(new[] { ("unjustified", "_Outfit/Outfit_variant/Part_small", false) });
            var refused = false;
            try { OutfitStage.Produce(); }
            catch (Exception error) { refused = error.Message.Contains("rationale"); }
            Require(refused, "没有 rationale 的关闭必须被拒");
            Operations(new (string, string, bool)[0]);
        }

        /// <summary>
        /// The user-review list the executor raises for trade-offs that change what the customer asked for: it is
        /// typed, recorded verbatim in the receipt next to the deducted closures, and takes part in no check.
        /// </summary>
        static void ScenarioUserReview()
        {
            Observe();
            // `D-148` minimal: every trade-off handed to the user is one numbered item with 2–4 executable
            // options, exactly one recommendation and the option this recipe really used. Both items here are
            // "keep what is there now", so the recipe's four closures stay the only writes it applies.
            var review = new List<object>
            {
                TradeOff("T1", "腿部同半径的白色层要不要都留？", "同一段腿上有四层，客户点名的是黑色连体袜。",
                    new List<object>
                    {
                        TradeOption("A", "保持现状，四层都留"),
                        TradeOption("B", "关掉另外三层", Recovery("_Outfit/Outfit_pokes/SkirtG", false,
                            "夹具：按这条方案把同部位的另外三层关掉")),
                    }, "A", "A"),
                TradeOff("T2", "素体自带的便服要不要留？", "它们与外购外套在同一位置都可见。",
                    new List<object>
                    {
                        TradeOption("A", "保持现状，两层都留"),
                        TradeOption("B", "关掉素体自带便服", Recovery("_Outfit/Outfit_pokes/SkirtH", false,
                            "夹具：按这条方案关掉素体自带的那一组")),
                    }, "B", "A"),
            };
            Operations(new[] { ("review_variant", "_Outfit/Outfit_variant/Part_small", true),
                ("review_vendor_test", "_Outfit/Outfit_variant/ClippingWarning_test", true),
                ("review_stack", "_Outfit/Outfit_stack_b/Armature", true),
                ("review_cover", "_Outfit/Outfit_pocket_cover/Cover", true) }, review);
            OutfitStage.Produce();

            var receipt = Json(LocalOperations.OutputPath);
            var echoed = receipt.List("user_review").Cast<Dictionary<string, object>>().ToList();
            Require(echoed.Count == 2, "user_review 必须原样写进回执，实际 " + echoed.Count + " 条");
            var wanted = (Dictionary<string, object>)review[0];
            Require(Avh.Json(echoed[0]) == Avh.Json(wanted),
                "回执里的 user_review 应与输入逐字段相同（编号、方案、推荐、当前都要在）");
            Require(echoed[0].Str("id") == "T1" && echoed[1].Str("id") == "T2"
                && echoed[0].Str("recommended") == "A" && echoed[1].Str("recommended") == "B"
                && echoed.All(row => row.Str("current") == "A"),
                "编号、推荐与当前方案必须原样进回执");
            var hidden = receipt.List("hidden_by_decision").Cast<Dictionary<string, object>>().ToList();
            Require(hidden.Count == 4 && hidden.All(row => !string.IsNullOrEmpty(row.Str("rationale")) && !string.IsNullOrEmpty(row.Str("operation"))),
                "回执必须列出被扣除的件、操作 id 与理由，实际 " + hidden.Count + " 条");
            var metrics = Metrics("clothing.install");
            Close(Number(metrics, "fixed_outfit_state_failures"), 0, "写了 user_review 不该改变固定件判据");
            Close(Number(metrics, "visible_overlap_pairs"), 0, "写了 user_review 不该改变可见重叠计数");

            // `D-148` ②: the Runtime refuses a trade-off the delivery note could not render or execute. Each case
            // below is one rule; `RefusesReview` only accepts a refusal that names user_review.
            RefusesReview("user_review 不是数组", "这是一段散文");
            RefusesReview("缺少编号", D("question", "q", "detail", "d", "options",
                new List<object> { TradeOption("A", "留"), TradeOption("B", "不留") }, "recommended", "A", "current", "A"));
            RefusesReview("编号重复", new List<object> { Shape("T1"), Shape("T1") });
            RefusesReview("方案只有 1 个", new List<object> { TradeOff("T1", "q", "d",
                new List<object> { TradeOption("A", "留") }, "A", "A") });
            RefusesReview("方案超过 4 个", new List<object> { TradeOff("T1", "q", "d",
                new List<object> { TradeOption("A", "1"), TradeOption("B", "2"), TradeOption("C", "3"),
                    TradeOption("D", "4"), TradeOption("E", "5") }, "A", "A") });
            RefusesReview("方案编号重复", new List<object> { TradeOff("T1", "q", "d",
                new List<object> { TradeOption("A", "留"), TradeOption("A", "不留") }, "A", "A") });
            RefusesReview("推荐不止一个", new List<object> { TradeOff("T1", "q", "d",
                new List<object> { TradeOption("A", "留"), TradeOption("B", "不留") }, new List<object> { "A", "B" }, "A") });
            RefusesReview("推荐不在方案里", new List<object> { TradeOff("T1", "q", "d",
                new List<object> { TradeOption("A", "留"), TradeOption("B", "不留") }, "C", "A") });
            RefusesReview("当前方案不在方案里", new List<object> { TradeOff("T1", "q", "d",
                new List<object> { TradeOption("A", "留"), TradeOption("B", "不留") }, "A", "C") });
            RefusesReview("方案引用的对象不在观察内", new List<object> { TradeOff("T1", "q", "d",
                new List<object> { TradeOption("A", "留"), TradeOption("B", "关掉", Recovery("Nope/Missing", false, "夹具")) }, "A", "A") });
            RefusesReview("方案里用了不可恢复的操作", new List<object> { TradeOff("T1", "q", "d",
                new List<object> { TradeOption("A", "留"), TradeOption("B", "排除出构建", D("kind", "object_state",
                    "path", "_Outfit/Outfit_pokes/SkirtG", "active", false, "exclude_from_build", true, "rationale", "夹具")) }, "A", "A") });
            RefusesReview("当前方案与配方实际生效的操作不符", new List<object> { TradeOff("T1", "q", "d",
                new List<object> { TradeOption("A", "留"), TradeOption("B", "关掉", Recovery("_Outfit/Outfit_pokes/SkirtG", false, "夹具")) }, "A", "B") });
            RefusesReview("多出未定义字段", new List<object> { Shape("T1"), D("answer", "a") });
            RefusesDecisions("interpenetration_decisions 不是数组", "一段散文");
            RefusesDecisions("objects 不是两件", new List<object> { D("objects", new List<object> { "A" }, "decision", "accept", "criterion", "c") });
            RefusesDecisions("objects 是同一件", new List<object> { D("objects", new List<object> { "A", "A" }, "decision", "close", "rationale", "r") });
            RefusesDecisions("decision 不在三选一里", new List<object> { D("objects", new List<object> { "A", "B" }, "decision", "ignore") });
            RefusesDecisions("多出未定义字段", new List<object> { D("objects", new List<object> { "A", "B" }, "decision", "close", "rationale", "r", "note", "n") });
            // `D-148` ①: a pair kept for the user carries its options in exactly one place, so an ask_user without
            // a number (or with one nothing defines) is refused rather than silently losing its choices.
            RefusesDecisions("ask_user 没写编号", new List<object> { Decision("A", "B", "ask_user", rationale: "r") });
            RefusesDecisions("ask_user 的编号不存在", new List<object> { Decision("A", "B", "ask_user", rationale: "r", review: "T9") });
        }

        /// <summary>A well-formed trade-off with nothing to say, used where only the surrounding shape is under test.</summary>
        static Dictionary<string, object> Shape(string id) => TradeOff(id, "q", "d",
            new List<object> { TradeOption("A", "留"), TradeOption("B", "不留") }, "A", "A");

        /// <summary>Writes a recipe that differs only in its decisions and requires the stage to refuse it.</summary>
        static void RefusesDecisions(string label, object decisions)
        {
            var observation = File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath));
            var document = D("schema", "local-operations/0.1", "observation_sha256", LocalOperations.Digest(observation), "operations", new List<object>());
            document["interpenetration_decisions"] = decisions;
            Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), document);
            var refused = false;
            try { OutfitStage.Produce(); }
            catch (Exception error) { refused = error.Message.Contains("interpenetration_decisions"); }
            Require(refused, label + " 应被拒");
        }

        public static void Run()
        {
            try
            {
                Build();
                ScenarioBaseline();
                ScenarioDuplicatePaths();
                ScenarioInterpenetrationDecisions();
                ScenarioInterpenetrationInvalidDecisions();
                ScenarioDependencyOrder();
                ScenarioClosures();
                ScenarioUserReview();
                ScenarioRefusal();
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
