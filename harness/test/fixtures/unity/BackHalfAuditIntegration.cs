// Fixture for the back-half stage-tool fixes: the regression real-sequence metric, the performance texture audit
// (plugin data textures and textures with no TextureImporter), and the empty-applicability readings (no main
// texture, no eye bone). It calls the production entry points the stages call, so each fix is measured on the
// real path instead of on a re-implementation.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Avatars.Components;

namespace AVH.Harness
{
    public static class BackHalfAuditIntegration
    {
        const string Dir = "Assets/Fixture";
        const string DataShader = Dir + "/DataAudit.shader";
        const string OutfitPath = "_Outfit/OutfitA";
        static int assertions;
        static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (var i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1]; return d; }
        static List<object> L(params object[] values) => values.ToList();
        static void Check(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }

        // ---------------------------------------------------------------- defect 7: real sequence drift

        /// <summary>A toggle layer that only exists in one direction: walking out and back cannot return to the default.</summary>
        static AnimatorSim ToggleSim(bool symmetric)
        {
            var on = new AnimationClip { name = "ProbeOn" };
            var off = new AnimationClip { name = "ProbeOff" };
            AnimationUtility.SetEditorCurve(on, EditorCurveBinding.FloatCurve(OutfitPath, typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1, 1));
            AnimationUtility.SetEditorCurve(off, EditorCurveBinding.FloatCurve(OutfitPath, typeof(GameObject), "m_IsActive"), AnimationCurve.Constant(0, 1, 0));
            AssetDatabase.CreateAsset(on, Dir + (symmetric ? "/SymOn.anim" : "/OneWayOn.anim"));
            AssetDatabase.CreateAsset(off, Dir + (symmetric ? "/SymOff.anim" : "/OneWayOff.anim"));
            var controller = AnimatorController.CreateAnimatorControllerAtPath(Dir + (symmetric ? "/Sym.controller" : "/OneWay.controller"));
            controller.AddParameter("Probe", AnimatorControllerParameterType.Bool);
            var layer = controller.layers[0];
            layer.name = "Vendor Toggle";
            layer.defaultWeight = 1;
            var offState = layer.stateMachine.AddState("Off"); offState.motion = off; offState.writeDefaultValues = false;
            var onState = layer.stateMachine.AddState("On"); onState.motion = on; onState.writeDefaultValues = false;
            layer.stateMachine.defaultState = offState;
            var toOn = offState.AddTransition(onState); toOn.hasExitTime = false; toOn.duration = 0;
            toOn.AddCondition(AnimatorConditionMode.If, 0, "Probe");
            if (symmetric)
            {
                var toOff = onState.AddTransition(offState); toOff.hasExitTime = false; toOff.duration = 0;
                toOff.AddCondition(AnimatorConditionMode.IfNot, 0, "Probe");
            }
            controller.layers = new[] { layer };

            var avatar = new GameObject(symmetric ? "SymAvatar" : "OneWayAvatar");
            var descriptor = avatar.AddComponent<VRCAvatarDescriptor>();
            descriptor.customizeAnimationLayers = true;
            descriptor.baseAnimationLayers = new[] { new VRCAvatarDescriptor.CustomAnimLayer {
                type = VRCAvatarDescriptor.AnimLayerType.FX, isDefault = false, animatorController = controller } };
            // A freshly created descriptor leaves specialAnimationLayers null; the production layer reader concatenates it.
            descriptor.specialAnimationLayers = new VRCAvatarDescriptor.CustomAnimLayer[0];
            var root = new GameObject("_Outfit"); root.transform.SetParent(avatar.transform, false);
            var outfit = new GameObject("OutfitA"); outfit.transform.SetParent(root.transform, false);
            outfit.SetActive(false);
            return new AnimatorSim(avatar);
        }

        static void SequenceDrift()
        {
            var oneWay = ToggleSim(symmetric: false);
            var drift = new List<string>();
            var notes = new List<string>();
            var (missing, total) = RegressionStage.MissingRealSequences(oneWay, new Dictionary<string, float[]>(), new List<string> { "Probe" }, drift, notes);
            Check(total == 1, "one toggle should produce one sequence, got " + total);
            Check(drift.Count == 1, "a one-directional toggle must drift, drift=" + drift.Count + " / " + string.Join("; ", notes));
            Check(missing == 1, "a sequence that walks but ends in a different state must count as a failure, got " + missing);

            var symmetric = ToggleSim(symmetric: true);
            var cleanDrift = new List<string>();
            var (clean, _) = RegressionStage.MissingRealSequences(symmetric, new Dictionary<string, float[]>(), new List<string> { "Probe" }, cleanDrift, new List<string>());
            Check(clean == 0 && cleanDrift.Count == 0, "a symmetric toggle must round-trip without drift, got " + clean + " / " + cleanDrift.Count);
        }

        // ---------------------------------------------------------------- defect 3 / 9a: texture audit

        static void WriteShader()
        {
            OutfitStage.EnsureFolder(Dir);
            File.WriteAllText(Avh.Abs(DataShader), @"Shader ""Fixture/DataAudit""
{
    Properties
    {
        _MainTex (""Main"", 2D) = ""white"" {}
        _Main2Tex (""Main2"", 2D) = ""white"" {}
        _AuxTex (""Aux"", 2D) = ""white"" {}
        _AuxTex2 (""Aux2"", 2D) = ""white"" {}
        _AuxTex3 (""Aux3"", 2D) = ""white"" {}
        _SPS_Bake (""Bake"", 2D) = ""white"" {}
    }
    SubShader
    {
        Tags { ""RenderType""=""Opaque"" }
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include ""UnityCG.cginc""
            struct appdata { float4 vertex : POSITION; };
            struct v2f { float4 pos : SV_POSITION; };
            v2f vert (appdata v) { v2f o; o.pos = UnityObjectToClipPos(v.vertex); return o; }
            fixed4 frag (v2f i) : SV_Target { return fixed4(1,1,1,1); }
            ENDCG
        }
    }
}
");
            AssetDatabase.Refresh();
            AssetDatabase.ImportAsset(DataShader);
        }

        static Texture2D Png(string name, int size, Color32 colour, TextureImporterCompression compression, int maxSize)
        {
            var texture = new Texture2D(size, size, TextureFormat.RGBA32, false, true);
            texture.SetPixels32(Enumerable.Repeat(colour, size * size).ToArray());
            texture.Apply();
            var path = Dir + "/" + name + ".png";
            File.WriteAllBytes(Avh.Abs(path), texture.EncodeToPNG());
            UnityEngine.Object.DestroyImmediate(texture);
            AssetDatabase.Refresh();
            AssetDatabase.ImportAsset(path);
            var importer = (TextureImporter)AssetImporter.GetAtPath(path);
            importer.maxTextureSize = maxSize;
            importer.textureCompression = compression;
            importer.mipmapEnabled = true;
            importer.streamingMipmaps = true;
            importer.SaveAndReimport();
            return AssetDatabase.LoadAssetAtPath<Texture2D>(path);
        }

        /// <summary>A Texture2D saved as an .asset: it has an asset path but no TextureImporter, like a plugin's baked data.</summary>
        static Texture2D Baked(string name, int width, int height, Color32 colour, TextureFormat format)
        {
            var texture = new Texture2D(width, height, format, false, true);
            texture.SetPixels32(Enumerable.Repeat(colour, width * height).ToArray());
            texture.Apply();
            AssetDatabase.CreateAsset(texture, Dir + "/" + name + ".asset");
            return AssetDatabase.LoadAssetAtPath<Texture2D>(Dir + "/" + name + ".asset");
        }

        static GameObject Avatar(string name, Material material)
        {
            var avatar = new GameObject(name);
            var descriptor = avatar.AddComponent<VRCAvatarDescriptor>();
            descriptor.baseAnimationLayers = new VRCAvatarDescriptor.CustomAnimLayer[0];
            descriptor.specialAnimationLayers = new VRCAvatarDescriptor.CustomAnimLayer[0];
            avatar.AddComponent<Animator>();
            var mesh = new Mesh { vertices = new[] { Vector3.zero, Vector3.right, Vector3.up }, triangles = new[] { 0, 1, 2 } };
            AssetDatabase.CreateAsset(mesh, Dir + "/" + name + ".asset");
            var child = new GameObject("Surface");
            child.transform.SetParent(avatar.transform, false);
            child.AddComponent<MeshFilter>().sharedMesh = mesh;
            child.AddComponent<MeshRenderer>().sharedMaterial = material;
            return avatar;
        }

        static void TextureAudit()
        {
            WriteShader();
            var shader = Shader.Find("Fixture/DataAudit");
            Check(shader != null, "fixture shader did not compile");
            // Aux art whose real size exceeds the aux tier: it must still be reported.
            var over = Png("T_aux_over", 2048, new Color32(200, 100, 50, 255), TextureImporterCompression.Compressed, 4096);
            // Ordinary uncompressed aux art with a compliant import limit: it must still be reported as uncompressed.
            var uncompressed = Png("T_aux_uncompressed", 256, new Color32(50, 100, 200, 255), TextureImporterCompression.Uncompressed, 1024);
            // A compliant small import-backed main texture.
            var main = Png("T_main", 256, new Color32(10, 10, 10, 255), TextureImporterCompression.Compressed, 2048);
            // A plugin's data texture and an ordinary visual texture, both without a TextureImporter.
            var data = Baked("T_sps_data", 8192, 4, new Color32(1, 2, 3, 4), TextureFormat.RGBA32);
            var small = Baked("T_aux_small", 512, 512, new Color32(9, 9, 9, 255), TextureFormat.RGBA32);
            // A main texture without a TextureImporter: its pixels are the honest effective size.
            var bakedMain = Baked("T_main_baked", 1024, 1024, new Color32(20, 20, 20, 255), TextureFormat.RGBA32);

            var material = new Material(shader) { name = "AuditMaterial" };
            material.SetTexture("_MainTex", main);
            material.SetTexture("_Main2Tex", bakedMain);
            material.SetTexture("_AuxTex", over);
            material.SetTexture("_AuxTex2", uncompressed);
            material.SetTexture("_AuxTex3", small);
            material.SetTexture("_SPS_Bake", data);
            var avatar = Avatar("AuditAvatar", material);
            var now = Perf.Measure(avatar);
            var roles = now.List("textures").Cast<Dictionary<string, object>>().ToDictionary(t => t.Str("path"), t => t.Str("role"));
            string RoleOf(Texture texture)
            {
                var path = AssetDatabase.GetAssetPath(texture);
                return roles.TryGetValue(path, out var role) ? role : "<not listed>";
            }
            Check(RoleOf(data) == OptimizeStage.DataRole, "the SPS bake texture must be identified as data, got " + RoleOf(data));
            Check(RoleOf(small) == "aux", "the no-importer visual texture must stay aux art, got " + RoleOf(small));

            var notes = new List<string>();
            var audit = PerformanceStage.TextureAudit(now, now, notes);
            Check(Convert.ToInt32(audit["texture_tier_audit_failures"]) == 1,
                "only the oversized aux art may fail the tier audit, got " + audit["texture_tier_audit_failures"]
                + " / " + string.Join("; ", notes));
            Check(Convert.ToInt32(audit["uncompressed_texture_count"]) == 3,
                "the three ordinary RGBA32 art textures must count as uncompressed, got " + audit["uncompressed_texture_count"]
                + " / " + string.Join("; ", notes));
            var uncompressedNote = notes.FirstOrDefault(note => note.StartsWith("未压缩")) ?? "";
            Check(!uncompressedNote.Contains("T_sps_data"),
                "the plugin data texture must not be reported as uncompressed art: " + uncompressedNote);
            Check(uncompressedNote.Contains("T_aux_uncompressed") && uncompressedNote.Contains("T_aux_small"),
                "ordinary uncompressed art must still be reported: " + uncompressedNote);
            Check(Convert.ToInt32(audit["textures_without_mipstreaming"]) == 0,
                "no texture in the fixture is missing mip streaming, got " + audit["textures_without_mipstreaming"]);
            Check(Convert.ToInt32(audit["min_main_texture_max_size"]) == OptimizeStage.Main,
                "the compliant main texture must read as the 2048 red line, got " + audit["min_main_texture_max_size"]);
            Check(Convert.ToInt32(audit["textures_above_baseline"]) == 0,
                "no texture may exceed its own baseline, got " + audit["textures_above_baseline"]);
            Check(notes.Any(note => note.Contains("插件数据纹理")), "the data texture was not reported as excluded: " + string.Join("; ", notes));

            // A baseline written before the real-size fix records no max_size/source_size for the no-importer main
            // texture; reading it must still not call that texture "below the red line".
            var noImporter = new HashSet<string> { AssetDatabase.GetAssetPath(data), AssetDatabase.GetAssetPath(small), AssetDatabase.GetAssetPath(bakedMain) };
            var oldBaseline = new Dictionary<string, object> { ["textures"] = now.List("textures").Cast<Dictionary<string, object>>().Select(t =>
            {
                var copy = new Dictionary<string, object>(t);
                if (noImporter.Contains(t.Str("path"))) { copy["max_size"] = null; copy["source_size"] = null; }
                return (object)copy;
            }).ToList() };
            var mixedNotes = new List<string>();
            var mixed = PerformanceStage.TextureAudit(now, oldBaseline, mixedNotes);
            Check(Convert.ToInt32(mixed["min_main_texture_max_size"]) == OptimizeStage.Main,
                "an older baseline without recorded sizes must not read as a main texture below the red line, got "
                + mixed["min_main_texture_max_size"] + " / " + string.Join("; ", mixedNotes));
            Check(Convert.ToInt32(mixed["textures_above_baseline"]) == 0,
                "an older baseline must not make a texture look like it grew, got " + mixed["textures_above_baseline"]);

            // P2: only an explicit [] is a complete empty texture inventory. A missing array, a wrong type and a visual
            // entry with no usable size are "not measured": folding them into an empty list made "nothing grew" pass and,
            // with no main art, put a passing 2048 on a dimension nobody measured.
            var missingTextures = new Dictionary<string, object>(now);
            missingTextures.Remove("textures");
            Check(PerformanceStage.TextureAudit(now, missingTextures, new List<string>())["textures_above_baseline"] == null,
                "a pre baseline without a texture array must leave textures_above_baseline unmeasured");
            var wrongType = new Dictionary<string, object>(now) { ["textures"] = new Dictionary<string, object>() };
            Check(PerformanceStage.TextureAudit(now, wrongType, new List<string>())["textures_above_baseline"] == null,
                "a baseline whose textures is not an array must leave textures_above_baseline unmeasured");
            var nullTextures = new Dictionary<string, object>(now) { ["textures"] = null };
            Check(PerformanceStage.TextureAudit(now, nullTextures, new List<string>())["textures_above_baseline"] == null,
                "a null texture array must leave textures_above_baseline unmeasured");
            var emptyTextures = new Dictionary<string, object>(now) { ["textures"] = new List<object>() };
            Check(Convert.ToInt32(PerformanceStage.TextureAudit(now, emptyTextures, new List<string>())["textures_above_baseline"]) == 0,
                "an explicit empty texture array is a complete empty inventory and reads 0");
            var sizeless = new Dictionary<string, object> { ["textures"] = L(D("path", "old.png", "guid", "g", "role", "aux")) };
            var sizelessNotes = new List<string>();
            Check(PerformanceStage.TextureAudit(now, sizeless, sizelessNotes)["textures_above_baseline"] == null,
                "a baseline entry with no usable size must leave textures_above_baseline unmeasured instead of falling back to zero");
            Check(sizelessNotes.Any(note => note.Contains("no_data")), "the unusable baseline must be explained: " + string.Join("; ", sizelessNotes));
            // R11b: an entry with no role at all used to read as "nothing visual to size", so it certified the baseline
            // and was then dropped from the comparison — a dimension nobody measured read as "nothing grew". Only an
            // explicit data-only role may be skipped; a missing or unrecognized role stays unmeasured.
            var roleless = new Dictionary<string, object> { ["textures"] = L(D("path", "old.png", "guid", "g")) };
            var rolelessNotes = new List<string>();
            Check(PerformanceStage.TextureAudit(now, roleless, rolelessNotes)["textures_above_baseline"] == null,
                "a baseline entry whose role is missing must leave textures_above_baseline unmeasured instead of certifying it");
            Check(rolelessNotes.Any(note => note.Contains("no_data")),
                "the role-less baseline entry must be explained: " + string.Join("; ", rolelessNotes));
            // A size does not make a role-less entry classifiable: it would be accepted as a complete baseline and then
            // dropped from the `before` map, so the texture it describes is never compared against the built one.
            var rolelessWithSize = new Dictionary<string, object> { ["textures"] = L(D("path", "old.png", "guid", "g", "width", 4096, "height", 4096)) };
            Check(PerformanceStage.TextureAudit(now, rolelessWithSize, new List<string>())["textures_above_baseline"] == null,
                "a baseline entry whose role is missing must leave textures_above_baseline unmeasured even when it records a size");
            var unrecognizedRole = new Dictionary<string, object> { ["textures"] = L(D("path", "old.png", "guid", "g", "role", "mystery")) };
            Check(PerformanceStage.TextureAudit(now, unrecognizedRole, new List<string>())["textures_above_baseline"] == null,
                "a baseline entry whose role cannot be recognized must leave textures_above_baseline unmeasured");
            foreach (var unknown in new[] {
                D("role", "mystery"), D("role", "aux", "visual_role", "mystery"),
                D("role", OptimizeStage.DataRole, "visual_role", "mystery"), D("role", "mystery", "visual_role", "aux") })
            {
                unknown["path"] = "old.png"; unknown["guid"] = "g";
                unknown["width"] = 4096; unknown["height"] = 4096;
                var unknownNotes = new List<string>();
                Check(PerformanceStage.TextureAudit(now, D("textures", L(unknown)), unknownNotes)["textures_above_baseline"] == null,
                    "an unknown role with valid dimensions must leave textures_above_baseline unmeasured");
                Check(unknownNotes.Any(note => note.Contains("no_data")), "unknown role must explain no_data");
            }
            var dataOnlySizeless = new Dictionary<string, object> { ["textures"] = L(D("path", "old.png", "guid", "g", "role", OptimizeStage.DataRole, "visual_role", null)) };
            Check(Convert.ToInt32(PerformanceStage.TextureAudit(now, dataOnlySizeless, new List<string>())["textures_above_baseline"]) == 0,
                "an explicit data-only baseline entry has no visual size to compare and must not void the inventory");
            // Every other performance field present, only the texture array missing: the texture dimension still has to
            // stay unmeasured, otherwise a pre report that never counted textures certifies the size comparison.
            var perfOnly = new Dictionary<string, object> { ["bones"] = 10, ["blendshapes"] = 3, ["texture_megabytes"] = 12.5 };
            Check(PerformanceStage.TextureAudit(now, perfOnly, new List<string>())["textures_above_baseline"] == null,
                "a baseline that reports only other metrics must not certify the texture comparison");

            // P1: the same texture bound to a data property and to a visual property. Its data use must keep the import
            // plan off it, but it must NOT drop out of the art audit: reducing it to "data" hid an oversized aux texture
            // that nothing is allowed to resize.
            var shared = Png("T_mixed_use", 2048, new Color32(70, 70, 70, 255), TextureImporterCompression.Compressed, 4096);
            var mixedMaterial = new Material(shader) { name = "MixedUseMaterial" };
            mixedMaterial.SetTexture("_AuxTex", shared);
            mixedMaterial.SetTexture("_SPS_Bake", shared);
            var mixedAvatar = Avatar("MixedUseAvatar", mixedMaterial);
            var mixedNow = Perf.Measure(mixedAvatar);
            var mixedPath = AssetDatabase.GetAssetPath(shared);
            var mixedEntry = mixedNow.List("textures").Cast<Dictionary<string, object>>().Single(t => t.Str("path") == mixedPath);
            Check(mixedEntry.Str("role") == OptimizeStage.DataRole,
                "the mixed texture's data use must keep it out of the import plan, got role " + mixedEntry.Str("role"));
            Check(mixedEntry.Str("visual_role") == "aux",
                "the mixed texture must keep its visual role, got " + mixedEntry.Str("visual_role"));
            Check(Equals(mixedEntry["mixed_use"], true), "the mixed use must be reported as a conflict");
            var mixedUseNotes = new List<string>();
            var mixedUseAudit = PerformanceStage.TextureAudit(mixedNow, mixedNow, mixedUseNotes);
            Check(Convert.ToInt32(mixedUseAudit["texture_tier_audit_failures"]) == 1,
                "a data+aux texture must still be audited as art (2048 is over the aux tier), got "
                + mixedUseAudit["texture_tier_audit_failures"] + " / " + string.Join("; ", mixedUseNotes));
            Check(mixedUseNotes.Any(note => note.Contains("绑定冲突")),
                "the binding conflict must be reported: " + string.Join("; ", mixedUseNotes));
            var mixedDesign = D("textures", L(D("guid", AssetDatabase.AssetPathToGUID(mixedPath), "action", "downscale",
                "target_max_size", 128, "rationale", "fixture names the mixed-use texture by mistake")));
            var mixedPlan = OptimizeStage.TexturePlan(mixedAvatar, mixedDesign, out var mixedExcluded, out _);
            Check(mixedPlan.Count == 0, "a mixed-use texture must never enter the import plan, got " + mixedPlan.Count);
            var excludedMixed = mixedExcluded.Cast<Dictionary<string, object>>().Single(e => e.Str("path") == mixedPath);
            Check(Equals(excludedMixed["mixed_use"], true) && excludedMixed.Str("visual_role") == "aux",
                "the exclusion must record the visual use and the conflict: " + Avh.Json(excludedMixed));

            // The same conflict across two materials: material A uses the texture as art, material B as plugin data.
            var cross = Png("T_cross_use", 256, new Color32(30, 60, 90, 255), TextureImporterCompression.Uncompressed, 1024);
            var artMaterial = new Material(shader) { name = "CrossArt" };
            artMaterial.SetTexture("_MainTex", cross);
            var dataMaterial = new Material(shader) { name = "CrossData" };
            dataMaterial.SetTexture("_SPS_Bake", cross);
            var crossAvatar = Avatar("CrossUseAvatar", artMaterial);
            var secondSurface = new GameObject("SecondSurface");
            secondSurface.transform.SetParent(crossAvatar.transform, false);
            secondSurface.AddComponent<MeshFilter>().sharedMesh = AssetDatabase.LoadAssetAtPath<Mesh>(Dir + "/CrossUseAvatar.asset");
            secondSurface.AddComponent<MeshRenderer>().sharedMaterial = dataMaterial;
            var crossNow = Perf.Measure(crossAvatar);
            var crossPath = AssetDatabase.GetAssetPath(cross);
            var crossEntry = crossNow.List("textures").Cast<Dictionary<string, object>>().Single(t => t.Str("path") == crossPath);
            Check(crossEntry.Str("visual_role") == "main",
                "a texture another material uses as plugin data must keep its art role, got " + crossEntry.Str("visual_role"));
            var crossNotes = new List<string>();
            var crossAudit = PerformanceStage.TextureAudit(crossNow, crossNow, crossNotes);
            Check(Convert.ToInt32(crossAudit["uncompressed_texture_count"]) == 1,
                "a texture shared as plugin data by another material must still be audited as uncompressed art, got "
                + crossAudit["uncompressed_texture_count"] + " / " + string.Join("; ", crossNotes));
            var uncompressedCross = crossNotes.FirstOrDefault(note => note.StartsWith("未压缩")) ?? "";
            Check(uncompressedCross.Contains("T_cross_use"), "the cross-material art binding must be reported: " + uncompressedCross);
            UnityEngine.Object.DestroyImmediate(mixedAvatar);
            UnityEngine.Object.DestroyImmediate(crossAvatar);

            // The plan is what build_copy applies: a data texture must not enter it, even when the design names it by mistake.
            var mainPath = AssetDatabase.GetAssetPath(main);
            var overPath = AssetDatabase.GetAssetPath(over);
            var uncompressedPath = AssetDatabase.GetAssetPath(uncompressed);
            var dataPath = AssetDatabase.GetAssetPath(data);
            var design = D("textures", L(
                D("guid", AssetDatabase.AssetPathToGUID(mainPath), "action", "keep", "rationale", "fixture"),
                D("guid", AssetDatabase.AssetPathToGUID(overPath), "action", "downscale", "target_max_size", 1024, "rationale", "fixture"),
                D("guid", AssetDatabase.AssetPathToGUID(uncompressedPath), "action", "keep", "rationale", "fixture"),
                D("guid", AssetDatabase.AssetPathToGUID(dataPath), "action", "downscale", "target_max_size", 512, "rationale", "fixture names the data texture by mistake")));
            var plan = OptimizeStage.TexturePlan(avatar, design, out var excluded, out _);
            var planned = plan.Cast<Dictionary<string, object>>().Select(e => e.Str("path")).ToList();
            Check(!planned.Contains(dataPath), "a data texture must never enter the import plan: " + string.Join(", ", planned));
            Check(planned.Count == 3, "the plan must still cover the three import-backed art textures, got " + planned.Count);
            Check(excluded.Cast<Dictionary<string, object>>().Any(e => e.Str("path") == dataPath),
                "the excluded data texture must be recorded in the optimize record");

            // D3: the design's universe is the built avatar's inventory (build_pre/perf.json, which the goal names),
            // while this validator reads the menu-layer prefab being optimized. A design entry for a texture this
            // avatar does not use cannot be applied here — it must be recorded as not applied instead of rejected,
            // because the model cannot derive the menu-layer set from the input the goal points it at.
            var strayGuid = "ffffffffffffffffffffffffffffffff";
            var withStray = D("textures", design.List("textures").Concat(new object[] {
                D("guid", strayGuid, "path", "Assets/Vendor/ScreenRT.renderTexture", "action", "downscale",
                  "target_max_size", 512, "rationale", "fixture: a texture only the built avatar binds") }).ToList());
            var strayPlan = OptimizeStage.TexturePlan(avatar, withStray, out _, out var notApplied);
            Check(strayPlan.Count == 3, "a design entry outside the menu-layer universe must not change the plan, got " + strayPlan.Count);
            var stray = notApplied.Cast<Dictionary<string, object>>().SingleOrDefault(e => e.Str("guid") == strayGuid);
            Check(stray != null, "a design entry this avatar does not use must be recorded as not applied: " + Avh.Json(notApplied));
            Check(stray.Str("path") == "Assets/Vendor/ScreenRT.renderTexture",
                "the not-applied record must name the design entry's path, got " + stray.Str("path"));
            // The check stays as strict as its own universe: a design that omits a texture this avatar *does* use is
            // still an error, so tolerating unknown GUIDs did not turn the coverage requirement into a no-op.
            var omitted = D("textures", L(D("guid", AssetDatabase.AssetPathToGUID(mainPath), "action", "keep", "rationale", "fixture")));
            var omittedThrew = false;
            try { OptimizeStage.TexturePlan(avatar, omitted, out _, out _); } catch (Exception) { omittedThrew = true; }
            Check(omittedThrew, "a design that omits a texture this avatar uses must still be rejected");

            // 9a: a complete inventory with no main art is an empty applicability set, not a missing measurement.
            var noMainMaterial = new Material(shader) { name = "NoMainMaterial" };
            noMainMaterial.SetTexture("_AuxTex", small);
            noMainMaterial.SetTexture("_AuxTex2", uncompressed);
            var noMain = Avatar("NoMainAvatar", noMainMaterial);
            var noMainNow = Perf.Measure(noMain);
            var noMainNotes = new List<string>();
            var noMainAudit = PerformanceStage.TextureAudit(noMainNow, noMainNow, noMainNotes);
            Check(Convert.ToInt32(noMainAudit["min_main_texture_max_size"]) == OptimizeStage.Main,
                "a complete inventory with no main texture is not below the red line, got " + noMainAudit["min_main_texture_max_size"]);
            // The normalization is about an empty applicability set, not about a missing baseline: without a texture
            // array the size comparison stays unmeasured even though this inventory has no main art.
            var noMainNoTextures = new Dictionary<string, object>(noMainNow);
            noMainNoTextures.Remove("textures");
            var noMainMissingBaseline = PerformanceStage.TextureAudit(noMainNow, noMainNoTextures, new List<string>());
            Check(noMainMissingBaseline["textures_above_baseline"] == null
                && Convert.ToInt32(noMainMissingBaseline["min_main_texture_max_size"]) == OptimizeStage.Main,
                "no main art plus a baseline without textures must still leave the size comparison unmeasured, got "
                + noMainMissingBaseline["textures_above_baseline"]);
            UnityEngine.Object.DestroyImmediate(noMain);

            // D4: a main texture with no pre-build reading, whose own .meta already says maxTextureSize 128 and which
            // no plan entry ever named. The old fallback compared it against the source image's 256 pixels and read
            // the vendor's own setting as "the harness lowered this main below the red line". These come after the
            // no-main normalization above on purpose: the `no-main-null` mutant must be caught by that case, not here.
            var vendorMain = Png("T_vendor_main", 256, new Color32(11, 22, 33, 255), TextureImporterCompression.Compressed, 128);
            var vendorMaterial = new Material(shader) { name = "VendorMainMaterial" };
            vendorMaterial.SetTexture("_MainTex", vendorMain);
            var vendorAvatar = Avatar("VendorMainAvatar", vendorMaterial);
            var vendorNow = Perf.Measure(vendorAvatar);
            var vendorPath = AssetDatabase.GetAssetPath(vendorMain);
            var emptyBaseline = D("textures", L());
            var vendorNotes = new List<string>();
            var vendorAudit = PerformanceStage.TextureAudit(vendorNow, emptyBaseline, vendorNotes);
            Check(Convert.ToInt32(vendorAudit["min_main_texture_max_size"]) == OptimizeStage.Main,
                "a vendor main texture no plan entry touched must not read as below the 2048 red line, got "
                + vendorAudit["min_main_texture_max_size"] + " / " + string.Join("; ", vendorNotes));
            Check(vendorNotes.Any(note => note.Contains("厂商原样")),
                "the vendor's own import setting must be explained in the notes: " + string.Join("; ", vendorNotes));
            // The same texture, this time written by this run: the applied plan's rollback is the "before", and a main
            // lowered below min(2048, that) is still a failure. Tolerating the vendor's setting must not tolerate ours.
            var editedPlan = D("texture_changes", L(D("path", vendorPath, "guid", AssetDatabase.AssetPathToGUID(vendorPath),
                "role", "main", "action", "downscale", "target_max_size", 128,
                "rollback", D("max_texture_size", 256, "standalone_overridden", false, "standalone_max_texture_size", 2048))));
            var editedNotes = new List<string>();
            var editedAudit = PerformanceStage.TextureAudit(vendorNow, emptyBaseline, editedNotes, editedPlan);
            Check(Convert.ToInt32(editedAudit["min_main_texture_max_size"]) == 128,
                "a main texture this run itself lowered below the red line must still be caught, got "
                + editedAudit["min_main_texture_max_size"] + " / " + string.Join("; ", editedNotes));
            // A plan entry the copy listed but left byte-identical is not an edit: nothing about that texture is ours.
            var unchangedPlan = D("texture_changes", L(D("path", vendorPath, "guid", AssetDatabase.AssetPathToGUID(vendorPath),
                "role", "main", "action", "keep", "target_max_size", 256, "unchanged", true,
                "rollback", D("max_texture_size", 256))));
            Check(Convert.ToInt32(PerformanceStage.TextureAudit(vendorNow, emptyBaseline, new List<string>(), unchangedPlan)["min_main_texture_max_size"]) == OptimizeStage.Main,
                "an import plan entry the run left unchanged is not an edit by the harness");
            // The scoping is the same for the other three metrics: with a pre inventory that lists nothing and no plan
            // entry, the vendor's oversized aux art is carried over, not a tier failure this run caused; the moment the
            // applied plan writes that texture's import settings it is judged again.
            var scopedNotes = new List<string>();
            var scoped = PerformanceStage.TextureAudit(now, emptyBaseline, scopedNotes);
            Check(Convert.ToInt32(scoped["texture_tier_audit_failures"]) == 0,
                "an aux texture no plan entry wrote must not be a tier failure this run caused, got "
                + scoped["texture_tier_audit_failures"] + " / " + string.Join("; ", scopedNotes));
            Check(Convert.ToInt32(scoped["textures_carried_over_from_vendor"]) > 0,
                "the carried-over vendor textures must still be counted, got " + scoped["textures_carried_over_from_vendor"]);
            var auxEdit = D("texture_changes", L(D("path", overPath, "guid", AssetDatabase.AssetPathToGUID(overPath),
                "role", "aux", "action", "downscale", "target_max_size", 1024, "rollback", D("max_texture_size", 4096))));
            Check(Convert.ToInt32(PerformanceStage.TextureAudit(now, emptyBaseline, new List<string>(), auxEdit)["texture_tier_audit_failures"]) == 1,
                "an aux texture this run itself wrote above its tier must still be a tier failure");
            UnityEngine.Object.DestroyImmediate(vendorAvatar);

            // The SDK's own total still charges the data texture; the audit's exclusion must not touch it. Checked last
            // so a reading that depends on the SDK's own accounting cannot hide the audit readings above.
            var withoutData = new Material(shader) { name = "AuditMaterialNoData" };
            withoutData.SetTexture("_MainTex", main);
            withoutData.SetTexture("_Main2Tex", bakedMain);
            withoutData.SetTexture("_AuxTex", over);
            withoutData.SetTexture("_AuxTex2", uncompressed);
            withoutData.SetTexture("_AuxTex3", small);
            var bare = Avatar("AuditAvatarNoData", withoutData);
            var total = Convert.ToDouble(now["texture_megabytes"]);
            var totalWithout = Convert.ToDouble(Perf.Measure(bare)["texture_megabytes"]);
            Check(total > totalWithout, "the SDK texture total must still include the data texture: " + total + " vs " + totalWithout);
            UnityEngine.Object.DestroyImmediate(avatar);
            UnityEngine.Object.DestroyImmediate(bare);
        }

        // ---------------------------------------------------------------- defect 9b: eye height with no eye bone

        static GameObject Human()
        {
            var root = new GameObject("EyeAvatar");
            var bones = new List<HumanBone>();
            var skeleton = new List<SkeletonBone>();
            skeleton.Add(new SkeletonBone { name = root.name, position = Vector3.zero, rotation = Quaternion.identity, scale = Vector3.one });
            Func<string, string, Transform, Vector3, Transform> add = (name, human, parent, pos) =>
            {
                var bone = new GameObject(name).transform;
                bone.SetParent(parent, false);
                bone.localPosition = pos;
                bones.Add(new HumanBone { boneName = name, humanName = human, limit = new HumanLimit { useDefaultValues = true } });
                skeleton.Add(new SkeletonBone { name = name, position = pos, rotation = Quaternion.identity, scale = Vector3.one });
                return bone;
            };
            var hips = add("Hips", "Hips", root.transform, new Vector3(0, 1, 0));
            var spine = add("Spine", "Spine", hips, new Vector3(0, 0.2f, 0));
            var chest = add("Chest", "Chest", spine, new Vector3(0, 0.2f, 0));
            var neck = add("Neck", "Neck", chest, new Vector3(0, 0.2f, 0));
            add("Head", "Head", neck, new Vector3(0, 0.15f, 0));
            foreach (var side in new[] { "Left", "Right" })
            {
                var sign = side == "Left" ? -1 : 1;
                var leg = add(side + "UpperLeg", side + "UpperLeg", hips, new Vector3(sign * 0.1f, -0.1f, 0));
                var knee = add(side + "LowerLeg", side + "LowerLeg", leg, new Vector3(0, -0.4f, 0));
                add(side + "Foot", side + "Foot", knee, new Vector3(0, -0.4f, 0.05f));
                var arm = add(side + "UpperArm", side + "UpperArm", chest, new Vector3(sign * 0.2f, 0.1f, 0));
                var elbow = add(side + "LowerArm", side + "LowerArm", arm, new Vector3(sign * 0.3f, 0, 0));
                add(side + "Hand", side + "Hand", elbow, new Vector3(sign * 0.25f, 0, 0));
            }
            var human = AvatarBuilder.BuildHumanAvatar(root, new HumanDescription { human = bones.ToArray(), skeleton = skeleton.ToArray(),
                upperArmTwist = 0.5f, lowerArmTwist = 0.5f, upperLegTwist = 0.5f, lowerLegTwist = 0.5f, armStretch = 0.05f, legStretch = 0.05f, feetSpacing = 0 });
            if (!human.isValid || !human.isHuman) throw new Exception("invalid fixture humanoid");
            AssetDatabase.CreateAsset(human, Dir + "/EyeAvatar.asset");
            root.AddComponent<VRCAvatarDescriptor>();
            root.AddComponent<Animator>().avatar = human;
            return root;
        }

        static void EyeHeight()
        {
            OutfitStage.EnsureFolder(Dir);
            var root = Human();
            try
            {
                var reading = Measure.Instance(root);
                Check(Equals(reading["animator_is_human"], true) && reading["eye_l_y"] == null,
                    "the fixture humanoid must be human without an eye bone: " + Avh.Json(reading));
                var withBone = new Dictionary<string, object>(reading);
                var sameNoBone = Measure.Observe(root, new Dictionary<string, object>(reading), new List<string>());
                Check(Equals(sameNoBone["eye_l_y_delta"], 0d),
                    "both sides reporting no eye bone is no measurable change, got " + sameNoBone["eye_l_y_delta"]);
                Check(Measure.Observe(root, null, new List<string>())["eye_l_y_delta"] == null, "a missing baseline must stay unmeasured");
                Check(Measure.Observe(root, new Dictionary<string, object>(), new List<string>())["eye_l_y_delta"] == null, "a baseline without the key must stay unmeasured");
                withBone["eye_l_y"] = 1.5d;
                Check(Measure.Observe(root, withBone, new List<string>())["eye_l_y_delta"] == null, "only one side missing the bone must stay unmeasured");
            }
            finally { UnityEngine.Object.DestroyImmediate(root); }
        }

        // ---------------------------------------------------------------- D2: the pinned AAO overrides

        /// <summary>
        /// AAO's automatic MergeBone pass reparents every merged child and renames it `&lt;parent&gt;$&lt;child&gt;$&lt;n&gt;`
        /// (MergeBoneProcessor.cs:139); that is what removed the fixed outfits' object paths from the built avatar, so the
        /// stage pins the pass off. The assertion reads the component's serialized state after the stage's own call.
        /// </summary>
        static void AaoPins()
        {
            const string typeName = "Anatawa12.AvatarOptimizer.TraceAndOptimize";
            var type = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(typeName)).FirstOrDefault(t => t != null);
            Check(type != null, "AAO's TraceAndOptimize is not in this fixture project, so the pin cannot be asserted");
            var avatar = new GameObject("PinnedAvatar");
            try
            {
                OptimizeStage.ApplyAaoSettings(avatar);
                var so = new SerializedObject(avatar.GetComponent(type));
                bool Flag(string name) { var property = so.FindProperty(name); Check(property != null, "AAO has no setting " + name); return property.boolValue; }
                Check(Flag("debugOptions.noConfigureLeafMergeBone") && Flag("debugOptions.noConfigureMiddleMergeBone"),
                    "the automatic MergeBone pass must be pinned off for this avatar: it renames every merged child to "
                    + "`<parent>$<child>$<n>`, which is what removed the fixed outfits' object paths from the built avatar");
                Check(!Flag("mergeSkinnedMesh") && !Flag("allowShuffleMaterialSlots") && !Flag("optimizeTexture"),
                    "the existing AAO pins must stay: merged skinned meshes, shuffled material slots and atlas optimization are off");
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }

        public static void Run()
        {
            try
            {
                OutfitStage.EnsureFolder(Dir);
                AssetDatabase.SaveAssets();
                SequenceDrift();
                AaoPins();
                TextureAudit();
                EyeHeight();
                Avh.WriteJson(Avh.Abs("result.json"), D("ok", true, "assertions", assertions));
                EditorApplication.Exit(0);
            }
            catch (Exception e)
            {
                Avh.WriteJson(Avh.Abs("result.json"), D("ok", false, "assertions", assertions, "error", e.ToString()));
                Debug.LogException(e);
                EditorApplication.Exit(1);
            }
        }
    }
}
