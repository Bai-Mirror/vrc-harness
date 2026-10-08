// 【项目沉淀】通用工具（Harness 的 Unity 端公共部分）
// 适用素体：无关
// 工具链　：Unity 2022.3 批处理（-executeMethod），由 Harness 的 Unity 步骤调用
// 可复用性：★★★ 换个单子直接能用
// 用途　　：路径（AVH_PROJECT_DIR / AVH_RUN_DIR）、最小 JSON 写出、观测结果 observation/0.1、阶段统一的异常与退出码。
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace AVH.Harness
{
    public static class Avh
    {
        public static string ProjectDir => Environment.GetEnvironmentVariable("AVH_PROJECT_DIR") ?? Directory.GetCurrentDirectory();
        public static string RunDir => Environment.GetEnvironmentVariable("AVH_RUN_DIR") ?? Path.Combine(ProjectDir, "_harness", "manual-run");
        public static string Env(string name, string fallback = null) => Environment.GetEnvironmentVariable(name) ?? fallback;

        /// <summary>Project-relative path to an absolute one; the Unity project may be a build copy of the task project.</summary>
        public static string Abs(string relative) => Path.Combine(ProjectDir, relative.Replace('/', Path.DirectorySeparatorChar));
        public static string IdentityAbs(string relative) => Path.Combine(ProjectIdentityDir, relative.Replace('/', Path.DirectorySeparatorChar));

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint size, uint flags);
        [DllImport("kernel32.dll", ExactSpelling = true)]
        static extern bool CloseHandle(IntPtr handle);
        static string NormalPath(string value) => Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        static string PhysicalDirectory(string path)
        {
            var handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
            if (handle == new IntPtr(-1)) throw new InvalidOperationException("Runtime project alias target cannot be read");
            try
            {
                var value = new StringBuilder(32768); var size = GetFinalPathNameByHandleW(handle, value, (uint)value.Capacity, 0);
                if (size == 0 || size >= value.Capacity) throw new InvalidOperationException("Runtime project alias target cannot be resolved");
                var result = value.ToString();
                if (result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) result = @"\\" + result.Substring(8);
                else if (result.StartsWith(@"\\?\", StringComparison.Ordinal)) result = result.Substring(4);
                return NormalPath(result);
            }
            finally { CloseHandle(handle); }
        }
        public static string ProjectIdentityDir
        {
            get
            {
                var root = NormalPath(ProjectDir); var physical = Env("AVH_PHYSICAL_PROJECT_DIR");
                if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) == 0)
                {
                    if (physical != null && !string.Equals(root, NormalPath(physical), StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("Runtime physical project binding mismatch");
                    return root;
                }
                var nonce = Env("AVH_UNITY_ALIAS_NONCE");
                if (Application.platform != RuntimePlatform.WindowsEditor || string.IsNullOrEmpty(physical) || string.IsNullOrEmpty(nonce) || Path.GetFileName(root) != "p")
                    throw new InvalidOperationException("Unowned project root link refused");
                var marker = Path.Combine(Path.GetDirectoryName(root), "owner.json");
                if ((File.GetAttributes(marker) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Linked Runtime alias ownership refused");
                var owner = ReadJsonFile(marker);
                // Windows app virtualization may retain a different spelling in Node's realpath.
                // Resolve both handles; the Runtime spelling remains the source/evidence identity.
                if (owner.Str("schema") != "unity-project-alias/0.1" || owner.Str("nonce") != nonce ||
                    !string.Equals(NormalPath(owner.Str("project")), NormalPath(physical), StringComparison.OrdinalIgnoreCase) ||
                    !string.Equals(PhysicalDirectory(root), PhysicalDirectory(physical), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Runtime project alias ownership or target changed");
                return NormalPath(physical);
            }
        }
        /// <summary>Only the verified Runtime root may be a junction. Every descendant link is still refused.</summary>
        public static void AssertManagedPath(string absolute)
        {
            var root = NormalPath(ProjectDir); var value = Path.GetFullPath(absolute);
            if (!value.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Managed path escapes project");
            var identity = ProjectIdentityDir;
            for (var parent = new DirectoryInfo(Path.GetDirectoryName(value)); parent != null; parent = parent.Parent)
            {
                if (string.Equals(NormalPath(parent.FullName), root, StringComparison.OrdinalIgnoreCase)) break;
                if (IsLinked(parent.FullName)) throw new InvalidOperationException("Linked managed directory refused");
            }
            if (IsLinked(value)) throw new InvalidOperationException("Linked managed file refused");
        }
        static bool IsLinked(string path)
        {
            try { return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
        }

        /// <summary>Compare a catalog source with its managed file, including redirected Windows spellings.</summary>
        public static bool SameProjectFile(string observedAbsolute, string relative)
        {
            var expected = Path.GetFullPath(Abs(relative));
            AssertManagedPath(expected);
            var identityRoot = ProjectIdentityDir; // Verify Runtime ownership before resolving any alias.
            var windows = Application.platform == RuntimePlatform.WindowsEditor;
            var comparison = windows ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (string.IsNullOrEmpty(observedAbsolute) || !Path.IsPathRooted(observedAbsolute)) return false;
            var observed = Path.GetFullPath(observedAbsolute);
            var roots = new[] { NormalPath(ProjectDir), NormalPath(identityRoot), windows ? PhysicalDirectory(identityRoot) : NormalPath(identityRoot) };
            var root = roots.Where(r => observed.StartsWith(r + Path.DirectorySeparatorChar, comparison)).OrderByDescending(r => r.Length).FirstOrDefault();
            if (root == null || !File.Exists(observed) || !File.Exists(expected)) return false;
            // Only the already verified project root can be an alias. A descendant
            // or outside link must not gain authority just because it reaches the same bytes.
            for (var path = observed; !string.Equals(NormalPath(path), root, comparison); path = Path.GetDirectoryName(path))
                if (IsLinked(path)) throw new InvalidOperationException("Linked catalog source refused");
            return string.Equals(windows ? PhysicalDirectory(observed) : observed,
                windows ? PhysicalDirectory(expected) : expected, comparison);
        }

        public static void Log(string message) => Debug.Log($"[AVH] {message}");

        /// <summary>
        /// Run a stage body; any exception is logged with its stack and the editor exits non-zero so the Runtime
        /// records a failed Unity step instead of a silent success.
        /// </summary>
        public static void Stage(string name, Action body, bool save = true)
        {
            try
            {
                Log($"{name}: start");
                body();
                if (save) AssetDatabase.SaveAssets();
                Log($"{name}: done");
                EditorApplication.Exit(0);
            }
            catch (Exception error)
            {
                Debug.LogError($"[AVH] {name} failed: {error}");
                EditorApplication.Exit(1);
            }
        }

        public static void WriteJson(string path, object value)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, Json(value) + "\n", new UTF8Encoding(false));
        }

        /// <summary>observation/0.1 for the Runtime; null metrics mean "not measured" and never pass a rule.
        /// <paramref name="details"/> carries structured evidence the Runtime's parser does not read as a metric
        /// (the metric map accepts only numbers, booleans and null), so lists of paths/rows belong there.</summary>
        public static void Observation(string observer, Dictionary<string, object> metrics, List<string> notes = null,
            Dictionary<string, object> details = null)
        {
            var path = Path.Combine(RunDir, "observations", observer + ".json");
            var body = new Dictionary<string, object> { ["schema"] = "observation/0.1", ["metrics"] = metrics,
                ["notes"] = (object)(notes ?? new List<string>()) };
            if (details != null) body["details"] = details;
            WriteJson(path, body);
            Log($"observation {observer}: {Json(metrics)}");
        }

        public static string Json(object value)
        {
            var sb = new StringBuilder();
            Write(sb, value);
            return sb.ToString();
        }
        static void Write(StringBuilder sb, object value)
        {
            switch (value)
            {
                case null: sb.Append("null"); break;
                case string s: WriteString(sb, s); break;
                case bool b: sb.Append(b ? "true" : "false"); break;
                case float f: sb.Append(float.IsFinite(f) ? f.ToString("R", CultureInfo.InvariantCulture) : "null"); break;
                case double d: sb.Append(double.IsFinite(d) ? d.ToString("R", CultureInfo.InvariantCulture) : "null"); break;
                case int or long or short or byte or uint or ulong: sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture)); break;
                case IDictionary dict:
                    sb.Append('{');
                    var first = true;
                    foreach (DictionaryEntry entry in dict)
                    {
                        if (!first) sb.Append(',');
                        first = false;
                        WriteString(sb, Convert.ToString(entry.Key, CultureInfo.InvariantCulture));
                        sb.Append(':');
                        Write(sb, entry.Value);
                    }
                    sb.Append('}');
                    break;
                case IEnumerable list:
                    sb.Append('[');
                    var firstItem = true;
                    foreach (var item in list)
                    {
                        if (!firstItem) sb.Append(',');
                        firstItem = false;
                        Write(sb, item);
                    }
                    sb.Append(']');
                    break;
                default: WriteString(sb, value.ToString()); break;
            }
        }
        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        /// <summary>Tiny reader for the flat JSON files the Python side writes (strings, numbers, bools, arrays, objects).</summary>
        public static object ParseJson(string text)
        {
            var index = 0;
            var value = ParseValue(text, ref index);
            return value;
        }
        static void SkipWs(string t, ref int i) { while (i < t.Length && char.IsWhiteSpace(t[i])) i++; }
        static object ParseValue(string t, ref int i)
        {
            SkipWs(t, ref i);
            if (i >= t.Length) throw new FormatException("JSON 提前结束");
            var c = t[i];
            if (c == '{')
            {
                var dict = new Dictionary<string, object>();
                i++; SkipWs(t, ref i);
                if (t[i] == '}') { i++; return dict; }
                while (true)
                {
                    SkipWs(t, ref i);
                    var key = (string)ParseValue(t, ref i);
                    SkipWs(t, ref i);
                    if (t[i] != ':') throw new FormatException("缺少冒号");
                    i++;
                    dict[key] = ParseValue(t, ref i);
                    SkipWs(t, ref i);
                    if (t[i] == ',') { i++; continue; }
                    if (t[i] == '}') { i++; return dict; }
                    throw new FormatException("对象未闭合");
                }
            }
            if (c == '[')
            {
                var list = new List<object>();
                i++; SkipWs(t, ref i);
                if (t[i] == ']') { i++; return list; }
                while (true)
                {
                    list.Add(ParseValue(t, ref i));
                    SkipWs(t, ref i);
                    if (t[i] == ',') { i++; continue; }
                    if (t[i] == ']') { i++; return list; }
                    throw new FormatException("数组未闭合");
                }
            }
            if (c == '"')
            {
                var sb = new StringBuilder();
                i++;
                while (t[i] != '"')
                {
                    if (t[i] == '\\')
                    {
                        i++;
                        var e = t[i];
                        if (e == 'n') sb.Append('\n');
                        else if (e == 't') sb.Append('\t');
                        else if (e == 'r') sb.Append('\r');
                        else if (e == 'u') { sb.Append((char)Convert.ToInt32(t.Substring(i + 1, 4), 16)); i += 4; }
                        else sb.Append(e);
                        i++;
                    }
                    else sb.Append(t[i++]);
                }
                i++;
                return sb.ToString();
            }
            if (c == 't' && t.Length - i >= 4 && string.CompareOrdinal(t, i, "true", 0, 4) == 0) { i += 4; return true; }
            if (c == 'f' && t.Length - i >= 5 && string.CompareOrdinal(t, i, "false", 0, 5) == 0) { i += 5; return false; }
            if (c == 'n' && t.Length - i >= 4 && string.CompareOrdinal(t, i, "null", 0, 4) == 0) { i += 4; return null; }
            var start = i;
            while (i < t.Length && "+-0123456789.eE".IndexOf(t[i]) >= 0) i++;
            return double.Parse(t.Substring(start, i - start), CultureInfo.InvariantCulture);
        }

        public static Dictionary<string, object> ReadJsonFile(string path) =>
            File.Exists(path) ? ParseJson(File.ReadAllText(path)) as Dictionary<string, object> : null;

        public static string Str(this Dictionary<string, object> dict, string key) =>
            dict != null && dict.TryGetValue(key, out var v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : null;
        public static List<object> List(this Dictionary<string, object> dict, string key) =>
            dict != null && dict.TryGetValue(key, out var v) ? v as List<object> ?? new List<object>() : new List<object>();
        public static Dictionary<string, object> Obj(this Dictionary<string, object> dict, string key) =>
            dict != null && dict.TryGetValue(key, out var v) ? v as Dictionary<string, object> : null;

        /// <summary>The plan the Workflow is running (AVH_PLAN), or the plan file when run by hand.</summary>
        public static Dictionary<string, object> Plan()
        {
            var env = Env("AVH_PLAN");
            if (!string.IsNullOrEmpty(env) && env != "{}") return AvatarConfig.Project(ParseJson(env) as Dictionary<string, object>);
            return new Dictionary<string, object>();
        }
    }

    /// <summary>One source of business identity for every production and observation stage.</summary>
    public static class AvatarConfig
    {
        public static bool Grouped(Dictionary<string, object> plan) => plan?.Str("schema") == "plan/0.3";
        public static List<Dictionary<string, object>> Groups(Dictionary<string, object> plan) =>
            plan.Obj("avatar_config").List("groups").Cast<Dictionary<string, object>>().ToList();
        public static List<Dictionary<string, object>> Switches(Dictionary<string, object> plan) =>
            plan.Obj("avatar_config").List("shared_switches").Cast<Dictionary<string, object>>().ToList();
        public static bool MaterialGroup(Dictionary<string, object> group) => group.Str("kind") == "material";
        public static IEnumerable<Dictionary<string, object>> InstanceGroups(Dictionary<string, object> plan) => Groups(plan).Where(g => !MaterialGroup(g));
        public static bool On(Dictionary<string, object> value, string key) => value.Str(key) == "True";
        static readonly Dictionary<int, float[]> boundaryValues = new Dictionary<int, float[]>();
        public static float Boundary(int index, int count)
        {
            if (!boundaryValues.TryGetValue(count, out var values))
            {
                values = new float[count + 1];
                for (var i = 0; i <= count; i++) values[i] = (float)((double)i / count);
                boundaryValues[count] = values;
            }
            // Stored IEEE single values avoid Mono's extended intermediate division precision.
            return values[index];
        }
        public static float Value(Dictionary<string, object> group, Dictionary<string, object> member)
        {
            var members = group.List("members").Cast<Dictionary<string, object>>().ToList();
            if (group.Str("activation") == "independent") return 1;
            if (group.Obj("parameter").Str("type") == "Int")
            {
                var ordered = members.OrderBy(m => m.Str("id") == group.Str("default") ? 0 : 1).ToList();
                return ordered.FindIndex(m => m.Str("id") == member.Str("id"));
            }
            var index = members.FindIndex(m => m.Str("id") == member.Str("id"));
            var middle = (index + .5f) / members.Count;
            if (!On(group.Obj("parameter"), "synced")) return middle;
            // [0,1] contains 128 network codes. Endpoints also belong to their first/last slots.
            var code = Mathf.Clamp(Mathf.RoundToInt(middle * 127), 0, 127);
            while (code > 0 && Boundary(code,127) >= Boundary(index+1,members.Count) && index < members.Count - 1) code--;
            while (code < 127 && Boundary(code,127) < Boundary(index,members.Count)) code++;
            return Boundary(code,127);
        }
        public static Dictionary<string, float> Defaults(Dictionary<string, object> plan)
        {
            var values = new Dictionary<string, float>();
            foreach (var group in Groups(plan))
            {
                var members = group.List("members").Cast<Dictionary<string, object>>().ToList();
                if (group.Str("activation") == "exclusive")
                    values.Add(group.Obj("parameter").Str("name"), Value(group, members.Single(m => m.Str("id") == group.Str("default"))));
                if (group.Str("activation") == "independent")
                    foreach (var m in members) values.Add(m.Obj("parameter").Str("name"), On(m, "default") ? 1 : 0);
            }
            foreach (var s in Switches(plan)) values.Add(s.Obj("parameter").Str("name"), On(s, "default") ? 1 : 0);
            return values;
        }
        public static bool Selected(Dictionary<string, object> group, Dictionary<string, object> member, Dictionary<string, float> values)
        {
            if (group.Str("activation") == "fixed") return true;
            if (group.Str("activation") == "independent") return values[member.Obj("parameter").Str("name")] > .5f;
            var value = values[group.Obj("parameter").Str("name")];
            if (group.Obj("parameter").Str("type") == "Int") return Math.Abs(value - Value(group, member)) < .001f;
            var members = group.List("members").Cast<Dictionary<string, object>>().ToList();
            // Compare the serialized single-precision boundaries directly. Multiplying a rounded
            // boundary back by N can round below its slot and disagrees with Unity's stepped keys.
            var index = Enumerable.Range(1, members.Count - 1).Count(i => value >= Boundary(i,members.Count));
            return members[index].Str("id") == member.Str("id");
        }
        public static Dictionary<string, object> Project(Dictionary<string, object> plan)
        {
            if (!Grouped(plan)) return plan;
            var instances = plan.Obj("avatar_config").List("instances").Cast<Dictionary<string, object>>().ToDictionary(i => i.Str("id"));
            var rows = new List<object>();
            foreach (var group in InstanceGroups(plan)) foreach (Dictionary<string, object> m in group.List("members"))
            {
                var instance = instances[m.Str("instance")];
                var row = new Dictionary<string, object>(instance);
                row["id"] = m.Str("id"); row["instance"] = instance.Str("id"); row["variant"] = m.Str("variant");
                row["group"] = group.Str("id"); row["label"] = m.Str("label"); row["activation"] = group.Str("activation");
                row["default"] = group.Str("activation") == "fixed" || (group.Str("activation") == "exclusive"
                    ? m.Str("id") == group.Str("default") : On(m, "default"));
                row["prefab"] = instance.List("variants").Cast<Dictionary<string, object>>()
                    .FirstOrDefault(v => v.Str("id") == m.Str("variant"))?.Str("prefab") ?? instance.Str("prefab");
                rows.Add(row);
            }
            plan["outfits"] = rows;
            return plan;
        }
    }
}
