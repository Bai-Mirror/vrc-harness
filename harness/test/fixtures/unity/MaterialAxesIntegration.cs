using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;

namespace AVH.Harness
{
    public static class MaterialAxesIntegration
    {
        static int assertions;
        static Dictionary<string, object> D(params object[] p) { var d = new Dictionary<string, object>(); for (var i = 0; i < p.Length; i += 2) d[(string)p[i]] = p[i + 1]; return d; }
        static List<object> L(params object[] p) => p.ToList();
        static void Check(bool value, string message) { assertions++; if (!value) throw new Exception(message); }
        static Dictionary<string, object> Parameter(string name, string type) => D("name", name, "type", type, "saved", true, "synced", true);
        static Material Material(string id, Color color)
        {
            var material = new Material(Shader.Find("Standard")) { color = color };
            AssetDatabase.CreateAsset(material, "Assets/Authorized/" + id + ".mat"); return material;
        }
        static void Fixture(string type, bool full = true, bool regression = true)
        {
            UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Single);
            AssetDatabase.DeleteAsset("Assets/_Harness"); AssetDatabase.DeleteAsset("Assets/Authorized"); OutfitStage.EnsureFolder("Assets/Authorized");
            var original = Material("original", Color.white); var trim = Material("trim", Color.green);
            var warm = Material("warm", new Color(1, .6f, .2f)); var mixed = Material("mixed", Color.white);
            var texture = new Texture2D(2, 2); texture.SetPixels(new[] {Color.magenta, Color.magenta, Color.yellow, Color.yellow}); texture.Apply();
            AssetDatabase.CreateAsset(texture, "Assets/Authorized/gradient.asset"); mixed.mainTexture = texture;
            var body = RecolorMaterialIntegration.Human(); var descriptor = body.AddComponent<VRCAvatarDescriptor>(); descriptor.customExpressions = true;
            descriptor.expressionParameters = ScriptableObject.CreateInstance<VRCExpressionParameters>(); descriptor.expressionParameters.parameters = new VRCExpressionParameters.Parameter[0];
            descriptor.expressionsMenu = ScriptableObject.CreateInstance<VRCExpressionsMenu>();
            AssetDatabase.CreateAsset(descriptor.expressionParameters, "Assets/Authorized/params.asset"); AssetDatabase.CreateAsset(descriptor.expressionsMenu, "Assets/Authorized/menu.asset");
            PrefabUtility.SaveAsPrefabAsset(body, "Assets/Authorized/body.prefab"); UnityEngine.Object.DestroyImmediate(body);
            var instances = L(); var bindings = L(); var members = L();
            foreach (var id in new[] {"short", "long"})
            {
                var root = new GameObject("Source_" + id); var parent = root.transform;
                if (id == "long") { var nested = new GameObject("Nested"); nested.transform.SetParent(parent, false); parent = nested.transform; }
                var visual = GameObject.CreatePrimitive(PrimitiveType.Cube); UnityEngine.Object.DestroyImmediate(visual.GetComponent<Collider>()); visual.name = id == "short" ? "Surface" : "Strands"; visual.transform.SetParent(parent, false);
                visual.GetComponent<Renderer>().sharedMaterials = id == "short" ? new[] {original, trim} : new[] {trim, original};
                var prefab = "Assets/Authorized/" + id + ".prefab"; PrefabUtility.SaveAsPrefabAsset(root, prefab); UnityEngine.Object.DestroyImmediate(root);
                instances.Add(D("id", id, "kind", "hair", "item", "fixture", "prefab", prefab,
                    "mount", D("path", "Hips/Spine/Chest/Neck/Head", "pose", "relative", "position", L(0, 0, 0), "rotation", L(0, 0, 0)))); members.Add(D("id", id, "instance", id, "label", id));
                bindings.Add(D("id", id, "instance", id, "renderer", id == "short" ? "Surface" : "Nested/Strands", "slot", id == "short" ? 0 : 1, "source_material", "Assets/Authorized/original.mat"));
            }
            var colors = D("id", "shade", "kind", "material", "label", "Shade", "activation", "exclusive", "selector", type == "Float" ? "radial" : "discrete",
                "parameter", Parameter("Shade", type), "default", "warm", "bindings", bindings,
                "members", new[] {"steel", "warm", "mixed"}.Select(id => (object)D("id", id, "label", id, "materials", D("short", id, "long", id))).ToList());
            var shape = D("id", "shape", "label", "Shape", "activation", "exclusive", "selector", "radial", "parameter", Parameter("Shape", "Float"), "default", "long", "members", members);
            var plan = D("schema", "plan/0.3", "body_prefab", "Assets/Authorized/body.prefab", "avatar_config", D("schema", "avatar-config/0.1", "instances", instances,
                "groups", L(shape, colors), "shared_switches", L(), "material_presets", L(
                    D("id", "steel", "material", "Assets/Authorized/original.mat", "adjustment", D("value", .65)),
                    D("id", "warm", "material", "Assets/Authorized/warm.mat"), D("id", "mixed", "material", "Assets/Authorized/mixed.mat"))),
                "menu", D("mode", "assemble", "vendor_policy", "preserve_and_merge", "tree", L(D("group", "shade"), D("group", "shape"))),
                "recolor", D("targets", L(), "candidates", 1));
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan)); plan = Avh.Plan(); Avh.WriteJson(Avh.Abs("axis-plan.json"), plan);
            var avatar = OutfitStage.Assemble(AssetDatabase.LoadAssetAtPath<GameObject>(plan.Str("body_prefab")), plan, out var hidden, out var rows);
            var record = D("schema", "outfit/0.4", "avatar_config", plan.Obj("avatar_config"), "outfits", rows, "body_prefab", plan.Str("body_prefab"), "hidden_body_parts", hidden);
            OutfitStage.EnsureFolder(OutfitStage.Dir); Avh.WriteJson(Avh.Abs(OutfitStage.RecordPath), record);
            Check(rows.Count == 2 && OutfitMeasure.GroupDefaults(avatar, record, plan, new List<string>()), "Material members leaked into physical activation projection");
            PrefabUtility.SaveAsPrefabAsset(avatar, OutfitStage.AvatarPath); UnityEngine.Object.DestroyImmediate(avatar);
            OutfitStage.EnsureFolder(RecolorStage.Dir);
            // The recipe is the recipe tool's artifact. The fixture consumes the one the test staged from
            // `recolor.py` instead of inventing its own: a hand-written recipe is how a plan shape no gate
            // accepts reached this step, and it left the observer's rerun unequal (决定记录 D-116).
            var staged = Avh.Abs("axis-recipe.json");
            if (!File.Exists(staged)) throw new Exception("axis-recipe.json is missing: the fixture consumes the recipe tool's output, not one of its own");
            File.Copy(staged, Avh.Abs(RecolorStage.RecipePath), true);
            RecolorStage.Produce(); RecolorStage.MaterialTargetReadback();
            var recolored = AssetDatabase.LoadAssetAtPath<GameObject>(RecolorStage.AvatarPath); avatar = (GameObject)PrefabUtility.InstantiatePrefab(recolored);
            Check(MenuGroupAudit.SceneAssertions(avatar, plan, record, new List<string>()) == 0, "Recolor defaults failed");
            // A Renderer binding and a MeshRenderer binding address the same material property.
            var foreign = AnimatorController.CreateAnimatorControllerAtPath("Assets/Authorized/foreign.controller");
            var foreignClip = new AnimationClip(); var foreignSlot = MaterialAxes.Slots(colors, record).First();
            AnimationUtility.SetObjectReferenceCurve(foreignClip, EditorCurveBinding.PPtrCurve(foreignSlot.Path, typeof(Renderer), $"m_Materials.Array.data[{foreignSlot.Index}]"), new[] {new ObjectReferenceKeyframe {time = 0, value = original}});
            AssetDatabase.CreateAsset(foreignClip, "Assets/Authorized/foreign.anim"); foreign.layers[0].stateMachine.AddState("Supplier").motion = foreignClip;
            var merge = avatar.AddComponent<nadena.dev.modular_avatar.core.ModularAvatarMergeAnimator>(); merge.animator = foreign; merge.pathMode = nadena.dev.modular_avatar.core.MergeAnimatorPathMode.Absolute;
            var refused = false;
            try { MenuGroups.Compile(avatar, plan, record); } catch (Exception e) { refused = e.Message.Contains("厂商属性写者"); }
            finally { UnityEngine.Object.DestroyImmediate(merge); }
            Check(refused, "Renderer base-type alias bypassed the compiler's material owner");
            var controller = MenuGroups.Compile(avatar, plan, record);
            var colorPaths = MaterialAxes.Slots(colors, record).Select(s => s.Path).ToHashSet();
            Check(controller.layers.Where(l => l.name.Contains("shape")).SelectMany(l => AvatarAudit.States(l.stateMachine)).SelectMany(s => AvatarAudit.Clips(s.motion))
                .SelectMany(AnimationUtility.GetObjectReferenceCurveBindings).All(b => !colorPaths.Contains(b.path)), "Visibility compiler still owns color slots");
            PrefabUtility.SaveAsPrefabAsset(avatar, MenuStage.AvatarPath); UnityEngine.Object.DestroyImmediate(avatar);
            AvatarAudit.OnBaked(MenuStage.AvatarPath, baked => { Read(baked); Mutate(baked, plan, record); return true; });
            if (!full) return;
            OptimizeStage.CreatePreservedOutput(AssetDatabase.LoadAssetAtPath<GameObject>(MenuStage.AvatarPath));
            var request = Avh.Abs("axis-request.json"); Avh.WriteJson(request, D("input", OptimizeStage.AvatarPath, "output", BuildStage.OutDir, "name", "Avatar", "report", Avh.Abs("axis-build-report.json"), "allowErrors", false));
            SourceShapeAudit.CaptureSources(plan, record);
            try { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = MenuGroups.FinalizeReadableProperties; Check(AvatarBuild.BuildArtifact.BuildOnce(request) == 0, "Full SDK build failed"); }
            finally { AvatarBuild.BuildArtifact.DerivedAvatarFinalizer = null; }
            var built = UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(BuildStage.BuiltPrefab));
            try { Read(built); } finally { UnityEngine.Object.DestroyImmediate(built); }
            if (!regression) return;
            RegressionStage.Produce();
            var coverage = Avh.ReadJsonFile(Avh.Abs(RegressionStage.CoveragePath));
            Check(Convert.ToInt32(coverage["business_assertion_failures"]) == 0 && Convert.ToInt32(coverage["runtime_assertion_failures"]) == 0, "Production regression failed");
            Avh.WriteJson(Avh.Abs("axis-coverage-" + type + ".json"), coverage);
        }
        static void Read(GameObject built)
        {
            var notes = new List<string>(); var metrics = MenuGroupAudit.Metrics(built, notes);
            Check(metrics.Where(p => p.Value is bool).All(p => Equals(p.Value, true)), "Final material axis metrics: " + Avh.Json(metrics) + " " + string.Join(";", notes));
            Check(MenuGroupAudit.Assertions(built, notes, true) == 0, "Six combinations: " + string.Join(";", notes));
            Check(MenuGroupAudit.Cells(Avh.Plan()).Count == 6, "Missing hair x color cross product");
            Check(MenuGroupAudit.RuntimeAssertions(built, notes, out var events) == 0 && events >= 20, "Native incremental color memory: " + string.Join(";", notes));
            var readback = Avh.ReadJsonFile(Path.Combine(Avh.RunDir, "observations", "material-axis-native-readback.json"));
            var combinations = new HashSet<string>();
            foreach (Dictionary<string, object> e in readback.List("events"))
            {
                var values = e.Obj("values").ToDictionary(p => p.Key, p => Convert.ToSingle(p.Value));
                var shape = AvatarConfig.Groups(Avh.Plan()).Single(g => g.Str("id") == "shape");
                var chosen = shape.List("members").Cast<Dictionary<string, object>>().Single(m => AvatarConfig.Selected(shape, m, values)).Str("id");
                foreach (Dictionary<string, object> slot in e.List("slots"))
                {
                    Check(Avh.Json(slot.Obj("expected")) == Avh.Json(slot.Obj("actual")), "Native slot identity differs from independent preset");
                    combinations.Add(chosen + ":" + slot.Str("member"));
                }
            }
            Check(combinations.Count == 6, "Native event walk omitted a hair/color combination");
        }
        static void Mutate(GameObject baked, Dictionary<string, object> plan, Dictionary<string, object> record)
        {
            var fx = AvatarAudit.Layers(baked.GetComponent<VRCAvatarDescriptor>()).Single(l => l.type == VRCAvatarDescriptor.AnimLayerType.FX).controller;
            var colorLayer = fx.layers.Single(l => l.name.Contains("AVH Group shade")); var clip = AvatarAudit.States(colorLayer.stateMachine).SelectMany(s => AvatarAudit.Clips(s.motion)).First();
            var binding = AnimationUtility.GetObjectReferenceCurveBindings(clip).First(); var keys = AnimationUtility.GetObjectReferenceCurve(clip, binding);
            AnimationUtility.SetObjectReferenceCurve(clip, binding, keys.Select(k => new ObjectReferenceKeyframe {time = k.time, value = AssetDatabase.LoadAssetAtPath<Material>("Assets/Authorized/trim.mat")}).ToArray());
            try { Check(MenuGroupAudit.Assertions(baked, new List<string>()) > 0, "Wrong color curve escaped independent source audit"); }
            finally { AnimationUtility.SetObjectReferenceCurve(clip, binding, keys); }
            var visual = AvatarAudit.Locate(baked.transform, binding.path).GetComponent<Renderer>(); var values = visual.sharedMaterials; var saved = values[binding.propertyName.Contains("[0]") ? 0 : 1];
            var index = binding.propertyName.Contains("[0]") ? 0 : 1; values[index] = AssetDatabase.LoadAssetAtPath<Material>("Assets/Authorized/trim.mat"); visual.sharedMaterials = values;
            try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["group_defaults_match"], false), "Bad saved default hidden by controller"); }
            finally { values[index] = saved; visual.sharedMaterials = values; }
            var shapeLayer = fx.layers.Single(l => l.name.Contains("AVH Group shape")); var shapeClip = AvatarAudit.States(shapeLayer.stateMachine).SelectMany(s => AvatarAudit.Clips(s.motion)).First();
            AnimationUtility.SetObjectReferenceCurve(shapeClip, binding, keys);
            try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["property_owners_resolved"], false), "Competing visibility writer escaped"); }
            finally { AnimationUtility.SetObjectReferenceCurve(shapeClip, binding, null); }
            var alias = EditorCurveBinding.PPtrCurve(binding.path, typeof(Renderer), binding.propertyName);
            AnimationUtility.SetObjectReferenceCurve(shapeClip, alias, keys);
            try { Check(Equals(MenuGroupAudit.Metrics(baked, new List<string>())["property_owners_resolved"], false), "Renderer base-type alias bypassed final ownership audit"); }
            finally { AnimationUtility.SetObjectReferenceCurve(shapeClip, alias, null); }
            var color = MaterialAxes.Groups(plan).Single(); var b = (Dictionary<string, object>)color.List("bindings")[0]; var source = b["source_material"]; var environment = Environment.GetEnvironmentVariable("AVH_PLAN"); b["source_material"] = "Assets/Authorized/trim.mat";
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
            try { Check(MenuGroupAudit.Assertions(baked, new List<string>()) > 0, "Unobserved source slot escaped"); }
            finally { b["source_material"] = source; Environment.SetEnvironmentVariable("AVH_PLAN", environment); }
            Check(MenuGroupAudit.Assertions(baked, new List<string>()) == 0, "Restored axis failed");
        }
        // ---- Independent numeric expectations for the shared adjustment -------------------------
        // `Produce` generates every preset and `Expected` audits it with the same `Adjust`, so a systematic
        // error in that algorithm is invisible to the audit. These expectations are computed here from the
        // standard RGB/HSV formulas (written out rather than reusing Color.RGBToHSV) and cover hue,
        // saturation, value, alpha and texture preservation for both supported properties.
        static void ProbeShader() => File.WriteAllText(Avh.Abs("Assets/Authorized/AxisProbe.shader"),
            "Shader \"AVH/AxisProbe\" { Properties { _MainTex(\"Main\",2D)=\"white\"{} _Color(\"Color\",Color)=(1,1,1,1) _MainTexHSVG(\"HSV\",Vector)=(0,1,1,1) } SubShader { Pass {} } }");

        static void RgbToHsv(Color color, out float h, out float s, out float v)
        {
            var max = Mathf.Max(Mathf.Max(color.r, color.g), color.b);
            var min = Mathf.Min(Mathf.Min(color.r, color.g), color.b);
            var delta = max - min; v = max; s = max <= 0f ? 0f : delta / max;
            if (delta <= 0f) { h = 0f; return; }
            if (max == color.r) h = ((color.g - color.b) / delta) % 6f;
            else if (max == color.g) h = (color.b - color.r) / delta + 2f;
            else h = (color.r - color.g) / delta + 4f;
            h /= 6f; if (h < 0f) h += 1f;
        }
        static Color HsvToRgb(float h, float s, float v)
        {
            h = Mathf.Repeat(h, 1f); var sector = Mathf.Floor(h * 6f); var f = h * 6f - sector;
            var p = v * (1f - s); var q = v * (1f - f * s); var t = v * (1f - (1f - f) * s);
            switch ((int)sector % 6)
            {
                case 0: return new Color(v, t, p);
                case 1: return new Color(q, v, p);
                case 2: return new Color(p, v, t);
                case 3: return new Color(p, q, v);
                case 4: return new Color(t, p, v);
                default: return new Color(v, p, q);
            }
        }
        static Color ExpectedRgb(Color color, float hueShift, float saturation, float value)
        {
            RgbToHsv(color, out var h, out var s, out var v);
            var result = HsvToRgb(Mathf.Repeat(h + hueShift / 360f, 1f), s * saturation, v * value); result.a = color.a;
            return result;
        }
        static void Close(float actual, float expected, float tolerance, string what)
        {
            if (Mathf.Abs(actual - expected) > tolerance) throw new Exception("independent expectation failed for " + what + ": expected " + expected + ", got " + actual);
        }
        static void NumbersFixture()
        {
            AssetDatabase.DeleteAsset("Assets/Authorized"); OutfitStage.EnsureFolder("Assets/Authorized");
            ProbeShader(); AssetDatabase.ImportAsset("Assets/Authorized/AxisProbe.shader", ImportAssetOptions.ForceUpdate);
            var shader = AssetDatabase.LoadAssetAtPath<Shader>("Assets/Authorized/AxisProbe.shader") ?? throw new Exception("probe shader did not import");
            var texture = new Texture2D(2, 2); texture.SetPixels(new[] {Color.magenta, Color.magenta, Color.yellow, Color.yellow}); texture.Apply();
            AssetDatabase.CreateAsset(texture, "Assets/Authorized/probe.asset");
            var sourceColor = new Color(.2f, .4f, .9f, .35f); var sourceHsvg = new Vector4(.1f, 1.2f, .8f, .6f);
            var hsvgSource = new Material(shader) {name = "Probe"};
            hsvgSource.SetColor("_Color", sourceColor); hsvgSource.SetVector("_MainTexHSVG", sourceHsvg);
            hsvgSource.SetTexture("_MainTex", texture); hsvgSource.SetTextureScale("_MainTex", new Vector2(2f, 3f)); hsvgSource.SetTextureOffset("_MainTex", new Vector2(.25f, .5f));
            AssetDatabase.CreateAsset(hsvgSource, "Assets/Authorized/hsvg.mat");
            var plainSource = new Material(Shader.Find("Standard")) {name = "Plain"};
            plainSource.SetColor("_Color", sourceColor);
            plainSource.SetTexture("_MainTex", texture); plainSource.SetTextureScale("_MainTex", new Vector2(2f, 3f));
            AssetDatabase.CreateAsset(plainSource, "Assets/Authorized/plain.mat");
            var root = new GameObject("Probe_Source"); var visual = GameObject.CreatePrimitive(PrimitiveType.Cube);
            UnityEngine.Object.DestroyImmediate(visual.GetComponent<Collider>());
            visual.name = "Surface"; visual.transform.SetParent(root.transform, false);
            visual.GetComponent<Renderer>().sharedMaterials = new[] {hsvgSource, plainSource};
            var prefab = "Assets/Authorized/probe.prefab"; PrefabUtility.SaveAsPrefabAsset(root, prefab); UnityEngine.Object.DestroyImmediate(root);
            var record = D("outfits", L(D("id", "probe", "instance", "probe", "object", "_Items/Probe", "prefab", prefab,
                "installed_parts", L("_Items/Probe/Surface"))));
            var config = D("schema", "avatar-config/0.1",
                "instances", L(D("id", "probe", "kind", "hair", "item", "probe", "prefab", prefab)),
                "material_presets", L(
                    D("id", "hsvg", "material", "Assets/Authorized/hsvg.mat", "adjustment", D("hue_shift", 30, "saturation", 1.5f, "value", .8f)),
                    D("id", "plain", "material", "Assets/Authorized/plain.mat", "adjustment", D("hue_shift", -45, "saturation", .6f, "value", 1.25f)),
                    D("id", "wrap", "material", "Assets/Authorized/plain.mat", "adjustment", D("hue_shift", -180, "saturation", 1f, "value", 1f))),
                "groups", L(D("id", "shade", "kind", "material", "activation", "exclusive", "bindings", L(
                        D("id", "hsvgSlot", "instance", "probe", "renderer", "Surface", "slot", 0, "source_material", "Assets/Authorized/hsvg.mat"),
                        D("id", "plainSlot", "instance", "probe", "renderer", "Surface", "slot", 1, "source_material", "Assets/Authorized/plain.mat")),
                    "members", L(
                        D("id", "m1", "label", "m1", "materials", D("hsvgSlot", "hsvg", "plainSlot", "plain")),
                        D("id", "m2", "label", "m2", "materials", D("hsvgSlot", "hsvg", "plainSlot", "wrap"))))));
            var plan = D("avatar_config", config);
            MaterialAxes.Produce(plan, record);
            var hsvg = AssetDatabase.LoadAssetAtPath<Material>(MaterialAxes.Dir + "/hsvg.mat") ?? throw new Exception("hsvg preset was not produced");
            var plain = AssetDatabase.LoadAssetAtPath<Material>(MaterialAxes.Dir + "/plain.mat") ?? throw new Exception("plain preset was not produced");
            var wrap = AssetDatabase.LoadAssetAtPath<Material>(MaterialAxes.Dir + "/wrap.mat") ?? throw new Exception("wrap preset was not produced");
            var expectedHsvg = new Vector4(sourceHsvg.x + 30f / 360f, sourceHsvg.y * 1.5f, sourceHsvg.z * .8f, sourceHsvg.w);
            var actualHsvg = hsvg.GetVector("_MainTexHSVG");
            Close(actualHsvg.x, expectedHsvg.x, .0005f, "hue on _MainTexHSVG"); Close(actualHsvg.y, expectedHsvg.y, .0005f, "saturation on _MainTexHSVG");
            Close(actualHsvg.z, expectedHsvg.z, .0005f, "value on _MainTexHSVG"); Close(actualHsvg.w, expectedHsvg.w, .0005f, "gamma on _MainTexHSVG");
            var actualColor = hsvg.GetColor("_Color");
            Close(actualColor.r, sourceColor.r, .0005f, "r of _Color on the HSVG branch"); Close(actualColor.g, sourceColor.g, .0005f, "g of _Color on the HSVG branch");
            Close(actualColor.b, sourceColor.b, .0005f, "b of _Color on the HSVG branch"); Close(actualColor.a, sourceColor.a, .0005f, "alpha on the HSVG branch");
            Check(hsvg.GetTexture("_MainTex") == texture && hsvg.GetTextureScale("_MainTex") == new Vector2(2f, 3f)
                && hsvg.GetTextureOffset("_MainTex") == new Vector2(.25f, .5f), "the HSVG branch must leave the texture, its scale and its offset untouched");
            var plainExpected = ExpectedRgb(sourceColor, -45f, .6f, 1.25f); var plainActual = plain.GetColor("_Color");
            Close(plainActual.r, plainExpected.r, .002f, "r of _Color"); Close(plainActual.g, plainExpected.g, .002f, "g of _Color");
            Close(plainActual.b, plainExpected.b, .002f, "b of _Color"); Close(plainActual.a, sourceColor.a, .0005f, "alpha of _Color");
            var wrapExpected = ExpectedRgb(sourceColor, -180f, 1f, 1f); var wrapActual = wrap.GetColor("_Color");
            Close(wrapActual.r, wrapExpected.r, .002f, "r of the wrapped hue"); Close(wrapActual.g, wrapExpected.g, .002f, "g of the wrapped hue");
            Close(wrapActual.b, wrapExpected.b, .002f, "b of the wrapped hue");
            Check(plain.GetTexture("_MainTex") == texture && plain.GetTextureScale("_MainTex") == new Vector2(2f, 3f), "the _Color branch must leave the texture and its scale untouched");
            // Discriminating power: the same comparison rejects a swapped saturation/value pair, which is the
            // shape of the mutation the mutation run patches into the shared `Adjust`.
            var rejected = false;
            try { Close(actualHsvg.y, expectedHsvg.z, .0005f, "swapped saturation"); } catch (Exception) { rejected = true; }
            Check(rejected, "a swapped saturation/value pair must not pass the independent expectation");
        }
        public static void Numbers()
        {
            try { NumbersFixture(); Avh.WriteJson(Avh.Abs("axis-numbers-result.json"), D("ok", true, "assertions", assertions)); EditorApplication.Exit(0); }
            catch (Exception e) { Avh.WriteJson(Avh.Abs("axis-numbers-result.json"), D("ok", false, "assertions", assertions, "error", e.ToString())); Debug.LogException(e); EditorApplication.Exit(1); }
        }
        public static void Run()
        {
            try { Fixture("Float"); Fixture("Int"); Avh.WriteJson(Avh.Abs("axis-result.json"), D("ok", true, "assertions", assertions)); EditorApplication.Exit(0); }
            catch (Exception e) { Avh.WriteJson(Avh.Abs("axis-result.json"), D("ok", false, "assertions", assertions, "error", e.ToString())); Debug.LogException(e); EditorApplication.Exit(1); }
        }
        public static void RunQuick()
        {
            try { Fixture("Float", false); Avh.WriteJson(Avh.Abs("axis-result.json"), D("ok", true, "assertions", assertions)); EditorApplication.Exit(0); }
            catch (Exception e) { Avh.WriteJson(Avh.Abs("axis-result.json"), D("ok", false, "assertions", assertions, "error", e.ToString())); Debug.LogException(e); EditorApplication.Exit(1); }
        }
        // A Null graphics device can certify SDK/material/Animator behavior, but cannot certify rendered regression.
        public static void NativeBuild()
        {
            try
            {
                Fixture("Float", true, false); Fixture("Int", true, false);
                Avh.WriteJson(Avh.Abs("axis-result.json"), D("ok", true, "assertions", assertions, "rendered_regression", false)); EditorApplication.Exit(0);
            }
            catch (Exception e) { Avh.WriteJson(Avh.Abs("axis-result.json"), D("ok", false, "assertions", assertions, "error", e.ToString())); Debug.LogException(e); EditorApplication.Exit(1); }
        }
        public static void Cold()
        {
            Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(Avh.ReadJsonFile(Avh.Abs("axis-plan.json")))); ColdImportStage.Run();
        }
    }
}
