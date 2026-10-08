using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AVH.Harness
{
    /// <summary>Material selectors own measured slots independently of instance activation.</summary>
    public static class MaterialAxes
    {
        public const string Dir = RecolorStage.Dir + "/AxisPresets";
        public const string RecordPath = Dir + "/presets.json";
        public sealed class Slot
        {
            public Dictionary<string, object> Binding, Row;
            public string Path;
            public Type Type;
            public int Index;
        }
        public static IEnumerable<Dictionary<string, object>> Groups(Dictionary<string, object> plan) =>
            AvatarConfig.Groups(plan).Where(AvatarConfig.MaterialGroup);
        public static IEnumerable<Dictionary<string, object>> Presets(Dictionary<string, object> plan) =>
            plan.Obj("avatar_config").List("material_presets").Cast<Dictionary<string, object>>();
        public static bool Owns(Dictionary<string, object> plan, Dictionary<string, object> row, string path, int slot) =>
            Groups(plan).SelectMany(g => g.List("bindings").Cast<Dictionary<string, object>>()).Any(b =>
                b.Str("instance") == row.Str("instance") && FullPath(row, b) == path && Convert.ToInt32(b["slot"]) == slot);
        static string FullPath(Dictionary<string, object> row, Dictionary<string, object> binding) =>
            row.Str("object") + (binding.Str("renderer") == "" ? "" : "/" + binding.Str("renderer"));
        public static List<Slot> Slots(Dictionary<string, object> group, Dictionary<string, object> record)
        {
            var result = new List<Slot>();
            foreach (Dictionary<string, object> binding in group.List("bindings"))
            {
                var rows = record.List("outfits").Cast<Dictionary<string, object>>().Where(r => r.Str("instance") == binding.Str("instance")).ToList();
                if (rows.Count == 0) throw new Exception("Material axis instance has no assembly evidence: " + binding.Str("instance"));
                foreach (var row in rows)
                {
                    var source = AssetDatabase.LoadAssetAtPath<GameObject>(row.Str("prefab")) ?? throw new Exception("Material axis source prefab missing");
                    var transform = binding.Str("renderer") == "" ? source.transform : source.transform.Find(binding.Str("renderer"));
                    var renderers = transform == null ? new Renderer[0] : transform.GetComponents<Renderer>();
                    var index = Convert.ToInt32(binding["slot"]);
                    var expected = AssetDatabase.LoadAssetAtPath<Material>(binding.Str("source_material"));
                    if (renderers.Length != 1 || expected == null || index < 0 || index >= renderers[0].sharedMaterials.Length || renderers[0].sharedMaterials[index] != expected
                        || (renderers[0].GetType() != typeof(SkinnedMeshRenderer) && renderers[0].GetType() != typeof(MeshRenderer)))
                        throw new Exception("Material axis slot is unproven: " + row.Str("id") + "/" + binding.Str("renderer") + ":" + index);
                    var path = FullPath(row, binding);
                    if (!row.List("installed_parts").Contains(path)) throw new Exception("Material axis renderer is not assembled: " + path);
                    if (!result.Any(s => s.Path == path && s.Index == index)) result.Add(new Slot { Binding = binding, Row = row, Path = path, Type = renderers[0].GetType(), Index = index });
                }
            }
            return result;
        }
        static string PathFor(Dictionary<string, object> preset) => preset.Obj("adjustment") == null ? preset.Str("material") : Dir + "/" + preset.Str("id") + ".mat";
        static Material Source(Dictionary<string, object> preset) => AssetDatabase.LoadAssetAtPath<Material>(preset.Str("material")) ?? throw new Exception("Material preset source missing: " + preset.Str("id"));
        static float Number(Dictionary<string, object> spec, string key, float fallback) => spec.ContainsKey(key) ? Convert.ToSingle(spec[key]) : fallback;
        static void Adjust(Material material, Dictionary<string, object> adjustment)
        {
            if (adjustment == null) return;
            var hue = Number(adjustment, "hue_shift", 0) / 360; var saturation = Number(adjustment, "saturation", 1); var value = Number(adjustment, "value", 1);
            if (material.HasProperty("_MainTexHSVG"))
            { var v = material.GetVector("_MainTexHSVG"); material.SetVector("_MainTexHSVG", new Vector4(v.x + hue, v.y * saturation, v.z * value, v.w)); }
            else if (material.HasProperty("_Color"))
            { var c = material.GetColor("_Color"); Color.RGBToHSV(c, out var h, out var s, out var v); var result = Color.HSVToRGB(Mathf.Repeat(h + hue, 1), s * saturation, v * value); result.a = c.a; material.SetColor("_Color", result); }
            else throw new Exception("Material preset cannot reproduce relative HSV: " + material.name);
        }
        public static void Produce(Dictionary<string, object> plan, Dictionary<string, object> record)
        {
            var groups = Groups(plan).ToList(); if (groups.Count == 0) return;
            foreach (var group in groups) Slots(group, record);
            OutfitStage.EnsureFolder(Dir);
            var proof = new List<object>();
            foreach (var preset in Presets(plan))
            {
                var source = Source(preset); var path = PathFor(preset);
                if (preset.Obj("adjustment") != null)
                { var copy = new Material(source) { name = "Preset_" + preset.Str("id") }; Adjust(copy, preset.Obj("adjustment")); AssetDatabase.DeleteAsset(path); AssetDatabase.CreateAsset(copy, path); }
                AssetDatabase.SaveAssets();
                proof.Add(new Dictionary<string, object> { ["id"] = preset.Str("id"), ["source"] = VariantResolver.Identity(source),
                    ["source_hash"] = AssetDatabase.GetAssetDependencyHash(preset.Str("material")).ToString(), ["material"] = VariantResolver.Identity(AssetDatabase.LoadAssetAtPath<Material>(path)),
                    ["material_hash"] = AssetDatabase.GetAssetDependencyHash(path).ToString(), ["adjustment"] = preset.Obj("adjustment") });
            }
            Avh.WriteJson(Avh.Abs(RecordPath), new Dictionary<string, object> { ["schema"] = "material-presets/0.1", ["configuration_hash"] = MenuGroups.ConfigHash(plan), ["presets"] = proof });
        }
        public static Material Expected(Dictionary<string, object> plan, Dictionary<string, object> member, string binding)
        {
            var preset = Presets(plan).Single(p => p.Str("id") == member.Obj("materials").Str(binding));
            var proof = Avh.ReadJsonFile(Avh.Abs(RecordPath)) ?? throw new Exception("Material axis lacks recolor proof");
            var row = proof.List("presets").Cast<Dictionary<string, object>>().Single(p => p.Str("id") == preset.Str("id"));
            var source = Source(preset); var material = AssetDatabase.LoadAssetAtPath<Material>(PathFor(preset));
            if (proof.Str("configuration_hash") != MenuGroups.ConfigHash(plan) || material == null
                || Avh.Json(row.Obj("source")) != Avh.Json(VariantResolver.Identity(source))
                || row.Str("source_hash") != AssetDatabase.GetAssetDependencyHash(preset.Str("material")).ToString()
                || Avh.Json(row.Obj("material")) != Avh.Json(VariantResolver.Identity(material))
                || row.Str("material_hash") != AssetDatabase.GetAssetDependencyHash(PathFor(preset)).ToString()
                || Avh.Json(row.Obj("adjustment")) != Avh.Json(preset.Obj("adjustment"))) throw new Exception("Material preset identity changed: " + preset.Str("id"));
            var expected = new Material(source);
            try
            {
                Adjust(expected, preset.Obj("adjustment"));
                if (!SameProperties(material, expected)) throw new Exception("Material preset does not reproduce its source recipe: " + preset.Str("id"));
            }
            finally { UnityEngine.Object.DestroyImmediate(expected); }
            return material;
        }
        static bool SameProperties(Material actual, Material expected)
        {
            if (actual.shader != expected.shader || actual.renderQueue != expected.renderQueue || actual.enableInstancing != expected.enableInstancing
                || !actual.shaderKeywords.OrderBy(k => k).SequenceEqual(expected.shaderKeywords.OrderBy(k => k))) return false;
            if (actual.shader == null) return false;
            for (var i = 0; i < ShaderUtil.GetPropertyCount(actual.shader); i++)
            {
                var name = ShaderUtil.GetPropertyName(actual.shader, i);
                switch (ShaderUtil.GetPropertyType(actual.shader, i))
                {
                    case ShaderUtil.ShaderPropertyType.Color: if (actual.GetColor(name) != expected.GetColor(name)) return false; break;
                    case ShaderUtil.ShaderPropertyType.Vector: if (actual.GetVector(name) != expected.GetVector(name)) return false; break;
                    case ShaderUtil.ShaderPropertyType.TexEnv:
                        if (actual.GetTexture(name) != expected.GetTexture(name) || actual.GetTextureOffset(name) != expected.GetTextureOffset(name)
                            || actual.GetTextureScale(name) != expected.GetTextureScale(name)) return false; break;
                    default: if (actual.GetFloat(name) != expected.GetFloat(name)) return false; break;
                }
            }
            return true;
        }
        public static void Apply(GameObject avatar, Dictionary<string, object> plan, Dictionary<string, object> record, Dictionary<string, float> values)
        {
            foreach (var group in Groups(plan))
            {
                var member = group.List("members").Cast<Dictionary<string, object>>().Single(m => AvatarConfig.Selected(group, m, values));
                foreach (var slot in Slots(group, record))
                {
                    var renderer = avatar.transform.Find(slot.Path)?.GetComponent<Renderer>() ?? throw new Exception("Material axis assembled renderer missing: " + slot.Path);
                    var materials = renderer.sharedMaterials; if (slot.Index >= materials.Length) throw new Exception("Material axis assembled slot missing");
                    materials[slot.Index] = Expected(plan, member, slot.Binding.Str("id")); renderer.sharedMaterials = materials;
                }
            }
        }
    }
}
