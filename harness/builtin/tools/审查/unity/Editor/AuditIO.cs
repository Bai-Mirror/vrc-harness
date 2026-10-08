// 【项目沉淀】
// 适用素体：无关（Unity 编辑器通用工具，不依赖任何素体 / 服装 / 插件版本）。
// 用途：VRChat 头像视觉审查工具（T1 状态驱动 / T3 环绕渲图）的公共层——
//   1) 手写 JSON 解析与序列化（Unity 的 JsonUtility 表达不了「任意键名的字典」：
//      请求里的 params 是 {参数名: 数值}，输出里的形态键表也是同样的形状）；
//   2) status.json 状态文件（running / done / error），出错信息落盘而不只是打 Console；
//   3) 按名字在场景里解析头像（面捕安装器会克隆出多个同名根，只认 activeInHierarchy 的那个）；
//   4) GestureManager / VRChat SDK 的反射桥（找 GM 的「按名设参数」API 与接管入口）；
//   5) 菜单入口 Tools/AvatarAudit/Run Request + EditorApplication.update 状态机泵（不阻塞主线程）；
//   6) 审查期间隔离工程自带的编辑器回调（老探针会在 Play 里写参数、退出时写工程文件），
//      摘除保持到退出 Play 回到编辑模式之后再挂回（AuditCallbackIsolation，T1/T2/T3 通用）。
//
// 为什么全部走反射而不直接引用 GM / VRC SDK 类型：
//   这工具要复制进 7 个不同工程做审查，工程之间插件版本、是否装了 GM、SDK 版本都可能不同。
//   直接引用会让「某个工程没装 GM」变成编译失败，连不相关的工程都跑不了；反射失败只是降级，
//   并把「没接管」这件事写进输出，审查结论跟着降级，而不是整个工具不可用。
//
// 为什么手写 JSON 而不是 JsonUtility：
//   JsonUtility 只能反序列化到固定字段的 [Serializable] 类，遇到 {任意参数名: 值} 这种字典
//   就直接丢数据。请求格式是给 AI 填的，键名不可预知，所以必须自己解析。

using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace AvatarAudit
{
    #region JSON

    /// <summary>
    /// 有序 JSON 对象。用 List 保存键序（不用 Dictionary 的枚举顺序），
    /// 这样同一份快照两次序列化的字节完全相同——T1 的确定性自检要拿它做逐字段比对。
    /// </summary>
    public sealed class JsonObject
    {
        private readonly List<string> _order = new List<string>();
        private readonly Dictionary<string, object> _map = new Dictionary<string, object>();

        public JsonObject Set(string key, object value)
        {
            if (!_map.ContainsKey(key)) _order.Add(key);
            _map[key] = value;
            return this;
        }

        public bool Has(string key) { return _map.ContainsKey(key); }

        public object Get(string key)
        {
            object v;
            return _map.TryGetValue(key, out v) ? v : null;
        }

        public int Count { get { return _order.Count; } }

        public IEnumerable<string> Keys { get { return _order; } }

        public IEnumerable<KeyValuePair<string, object>> Items
        {
            get
            {
                for (int i = 0; i < _order.Count; i++)
                    yield return new KeyValuePair<string, object>(_order[i], _map[_order[i]]);
            }
        }
    }

    /// <summary>极简 JSON 解析 / 序列化。仅支持标准 JSON 值；不引第三方库。</summary>
    public static class AuditJson
    {
        // ---------- 序列化 ----------

        public static string Serialize(object value, bool pretty = true)
        {
            var sb = new StringBuilder(8192);
            WriteValue(sb, value, pretty, 0);
            return sb.ToString();
        }

        public static void WriteFile(string path, object value)
        {
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            File.WriteAllText(path, Serialize(value, true), new UTF8Encoding(false));
        }

        private static void WriteValue(StringBuilder sb, object v, bool pretty, int indent)
        {
            if (v == null) { sb.Append("null"); return; }

            var jo = v as JsonObject;
            if (jo != null) { WriteObject(sb, jo, pretty, indent); return; }

            if (v is string) { WriteString(sb, (string)v); return; }
            if (v is bool) { sb.Append(((bool)v) ? "true" : "false"); return; }
            if (v is float) { WriteNumber(sb, (float)v); return; }
            if (v is double) { WriteNumber(sb, (double)v); return; }
            if (v is int) { sb.Append(((int)v).ToString(CultureInfo.InvariantCulture)); return; }
            if (v is long) { sb.Append(((long)v).ToString(CultureInfo.InvariantCulture)); return; }

            var dict = v as IDictionary;
            if (dict != null)
            {
                var o = new JsonObject();
                foreach (DictionaryEntry e in dict) o.Set(Convert.ToString(e.Key, CultureInfo.InvariantCulture), e.Value);
                WriteObject(sb, o, pretty, indent);
                return;
            }

            var en = v as IEnumerable;
            if (en != null) { WriteArray(sb, en, pretty, indent); return; }

            WriteString(sb, Convert.ToString(v, CultureInfo.InvariantCulture));
        }

        private static void WriteNumber(StringBuilder sb, double d)
        {
            // 手工格式：6 位小数足够表达形态键权重（0..100）、世界坐标（米）、比例（0..1）；
            // 而且能把 1.0 写成 "1"、0.30000001 写成 "0.3"，输出给人/AI 看时可读。
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
            sb.Append(d.ToString("0.######", CultureInfo.InvariantCulture));
        }

        private static void WriteObject(StringBuilder sb, JsonObject o, bool pretty, int indent)
        {
            if (o.Count == 0) { sb.Append("{}"); return; }
            sb.Append('{');
            bool first = true;
            foreach (var kv in o.Items)
            {
                if (!first) sb.Append(',');
                if (pretty) sb.Append('\n').Append(Indent(indent + 1));
                first = false;
                WriteString(sb, kv.Key);
                sb.Append(pretty ? ": " : ":");
                WriteValue(sb, kv.Value, pretty, indent + 1);
            }
            if (pretty) sb.Append('\n').Append(Indent(indent));
            sb.Append('}');
        }

        private static void WriteArray(StringBuilder sb, IEnumerable en, bool pretty, int indent)
        {
            var items = new List<object>();
            foreach (var e in en) items.Add(e);

            if (items.Count == 0) { sb.Append("[]"); return; }

            // 纯标量数组写成一行（相机坐标、掩码统计这类数字串），含对象/子数组的才展开
            bool inline = true;
            foreach (var e in items)
            {
                if (e is JsonObject || e is IDictionary || (e is IEnumerable && !(e is string))) { inline = false; break; }
            }

            sb.Append('[');
            for (int i = 0; i < items.Count; i++)
            {
                if (i > 0) sb.Append(inline ? ", " : ",");
                if (!inline && pretty) sb.Append('\n').Append(Indent(indent + 1));
                WriteValue(sb, items[i], pretty, indent + 1);
            }
            if (!inline && pretty) sb.Append('\n').Append(Indent(indent));
            sb.Append(']');
        }

        private static string Indent(int n) { return new string(' ', n * 2); }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        // ---------- 解析 ----------

        public static object Parse(string text)
        {
            if (text == null) throw new FormatException("JSON 文本为 null");
            int i = 0;
            var v = ParseValue(text, ref i);
            SkipWs(text, ref i);
            if (i < text.Length) throw new FormatException("JSON 解析：位置 " + i + " 之后还有多余字符");
            return v;
        }

        private static object ParseValue(string s, ref int i)
        {
            SkipWs(s, ref i);
            if (i >= s.Length) throw new FormatException("JSON 解析：在位置 " + i + " 意外结束");
            char c = s[i];
            switch (c)
            {
                case '{': return ParseObject(s, ref i);
                case '[': return ParseArray(s, ref i);
                case '"': return ParseString(s, ref i);
                case 't':
                    Expect(s, ref i, "true"); return true;
                case 'f':
                    Expect(s, ref i, "false"); return false;
                case 'n':
                    Expect(s, ref i, "null"); return null;
                default:
                    return ParseNumber(s, ref i);
            }
        }

        private static JsonObject ParseObject(string s, ref int i)
        {
            var o = new JsonObject();
            i++; // '{'
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return o; }
            while (true)
            {
                SkipWs(s, ref i);
                if (i >= s.Length || s[i] != '"') throw new FormatException("JSON 解析：位置 " + i + " 期望键名字符串");
                string key = ParseString(s, ref i);
                SkipWs(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("JSON 解析：位置 " + i + " 期望 ':'");
                i++;
                o.Set(key, ParseValue(s, ref i));
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("JSON 解析：对象未闭合");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return o; }
                throw new FormatException("JSON 解析：位置 " + i + " 期望 ',' 或 '}'");
            }
        }

        private static List<object> ParseArray(string s, ref int i)
        {
            var list = new List<object>();
            i++; // '['
            SkipWs(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return list; }
            while (true)
            {
                list.Add(ParseValue(s, ref i));
                SkipWs(s, ref i);
                if (i >= s.Length) throw new FormatException("JSON 解析：数组未闭合");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return list; }
                throw new FormatException("JSON 解析：位置 " + i + " 期望 ',' 或 ']'");
            }
        }

        private static string ParseString(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++; // '"'
            while (true)
            {
                if (i >= s.Length) throw new FormatException("JSON 解析：字符串未闭合");
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) throw new FormatException("JSON 解析：转义未结束");
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("JSON 解析：\\u 转义不完整");
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        i += 4;
                        break;
                    default: throw new FormatException("JSON 解析：未知转义 \\" + e);
                }
            }
        }

        private static double ParseNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length)
            {
                char c = s[i];
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') i++;
                else break;
            }
            if (start == i) throw new FormatException("JSON 解析：位置 " + i + " 不是合法值");
            return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        private static void Expect(string s, ref int i, string word)
        {
            if (i + word.Length > s.Length || string.CompareOrdinal(s, i, word, 0, word.Length) != 0)
                throw new FormatException("JSON 解析：位置 " + i + " 期望 " + word);
            i += word.Length;
        }

        private static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
        }

        // ---------- 取值助手（缺键/类型不符一律回退到默认值，不让审查流程因为一个可选字段炸掉） ----------

        public static string Str(JsonObject o, string key, string def = null)
        {
            if (o == null) return def;
            var v = o.Get(key);
            if (v == null) return def;
            var s = v as string;
            return s ?? Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        public static double Num(JsonObject o, string key, double def)
        {
            if (o == null) return def;
            var v = o.Get(key);
            if (v == null) return def;
            if (v is double) return (double)v;
            if (v is bool) return ((bool)v) ? 1 : 0;
            double d;
            if (double.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
            return def;
        }

        public static int Int(JsonObject o, string key, int def)
        {
            if (o == null) return def;
            var v = o.Get(key);
            if (v == null) return def;
            return (int)Math.Round(Num(o, key, def));
        }

        public static bool Bool(JsonObject o, string key, bool def)
        {
            if (o == null) return def;
            var v = o.Get(key);
            if (v == null) return def;
            if (v is bool) return (bool)v;
            if (v is double) return Math.Abs((double)v) > 1e-9;
            bool b;
            if (bool.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), out b)) return b;
            return def;
        }

        public static JsonObject Obj(JsonObject o, string key) { return o == null ? null : o.Get(key) as JsonObject; }

        public static List<object> Arr(JsonObject o, string key)
        {
            if (o == null) return new List<object>();
            var v = o.Get(key) as List<object>;
            return v ?? new List<object>();
        }
    }

    #endregion

    #region 通用小工具

    public static class AuditUtil
    {
        /// <summary>相对头像根的层级路径；根上的渲染器用 "."。</summary>
        public static string RelPath(Transform root, Transform t)
        {
            if (t == null) return null;
            var names = new List<string>();
            var cur = t;
            while (cur != null && cur != root)
            {
                names.Add(cur.name);
                cur = cur.parent;
            }
            if (cur == null) return "<不在头像下>" + t.name;
            if (names.Count == 0) return ".";
            names.Reverse();
            return string.Join("/", names.ToArray());
        }

        /// <summary>从场景根算起的完整路径，用于报「同名多个根」时给人定位。</summary>
        public static string ScenePath(Transform t)
        {
            if (t == null) return "<null>";
            var names = new List<string>();
            var cur = t;
            while (cur != null)
            {
                names.Add(cur.name);
                cur = cur.parent;
            }
            names.Reverse();
            return string.Join("/", names.ToArray());
        }

        public static string SafeFileName(string s)
        {
            if (string.IsNullOrEmpty(s)) return "unnamed";
            var invalid = Path.GetInvalidFileNameChars();
            var sb = new StringBuilder(s.Length);
            foreach (var c in s)
            {
                bool bad = false;
                for (int i = 0; i < invalid.Length; i++) if (invalid[i] == c) { bad = true; break; }
                sb.Append(bad || c == '|' ? '_' : c);
            }
            return sb.ToString();
        }

        /// <summary>数字转字符串，给 message / 日志用，避免 "0.30000001" 这种噪音。</summary>
        public static string F(double d) { return d.ToString("0.####", CultureInfo.InvariantCulture); }

        public static float ToFloat(object v)
        {
            if (v == null) return 0f;
            if (v is double) return (float)(double)v;
            if (v is bool) return ((bool)v) ? 1f : 0f;
            if (v is float) return (float)v;
            float f;
            if (float.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), NumberStyles.Float, CultureInfo.InvariantCulture, out f)) return f;
            return 0f;
        }

        /// <summary>反射调用会把真实异常包在 TargetInvocationException 里，取出来再报。</summary>
        public static Exception Unwrap(Exception e)
        {
            var tie = e as TargetInvocationException;
            return tie != null && tie.InnerException != null ? tie.InnerException : e;
        }
    }

    #endregion

    #region 工具版本戳（T-13）

    /// <summary>
    /// T-13 版本戳：把「部署进工程的审查源码 hash」与 <c>Assets/AvatarAudit/VERSION</c> 里 sync_audit.py 写的
    /// hash 对齐，不一致就拒跑。为什么要在运行期自己算 hash：C# 编译产物里没有源文件路径，只有部署目录
    /// 里躺着的那份源码可以证明「现在跑的这个 asmdef 是哪套源编出来的」。
    ///
    /// 算法与 sync_audit.py 的 <c>source_hash()</c> 逐字节一致：取 <c>Assets/AvatarAudit/</c> 下所有文件
    /// （排除 VERSION / *.meta / .DS_Store / __pycache__），按相对 posix 路径 Ordinal 排序，
    /// 依次喂 <c>路径\0字节\0</c>。部署目录的相对路径（Editor/... / Runtime/...）与源树 <c>审查/unity/</c> 相同。
    /// </summary>
    public static class AuditToolVersion
    {
        public const string DeployRel = "Assets/AvatarAudit";

        /// <summary>确定性 sha256：入参是 (相对 posix 路径, 文件字节)，内部按路径 Ordinal 排序。</summary>
        public static string HashEntries(IEnumerable<KeyValuePair<string, byte[]>> entries)
        {
            var list = new List<KeyValuePair<string, byte[]>>();
            foreach (var kv in entries) list.Add(kv);
            list.Sort(delegate (KeyValuePair<string, byte[]> a, KeyValuePair<string, byte[]> b)
            {
                return string.CompareOrdinal(a.Key, b.Key);
            });

            using (var sha = SHA256.Create())
            {
                var nul = new byte[] { 0 };
                foreach (var kv in list)
                {
                    var pathBytes = Encoding.UTF8.GetBytes(NormalizeRel(kv.Key));
                    sha.TransformBlock(pathBytes, 0, pathBytes.Length, null, 0);
                    sha.TransformBlock(nul, 0, 1, null, 0);
                    var body = kv.Value ?? new byte[0];
                    if (body.Length > 0) sha.TransformBlock(body, 0, body.Length, null, 0);
                    sha.TransformBlock(nul, 0, 1, null, 0);
                }
                sha.TransformFinalBlock(new byte[0], 0, 0);
                return ToHex(sha.Hash);
            }
        }

        /// <summary>算部署到工程的审查源码树 hash；目录不存在或读失败返回 null。</summary>
        public static string ComputeDeployHash(string projectRoot, out int fileCount, out string note)
        {
            fileCount = 0;
            note = null;
            var root = Path.Combine(projectRoot ?? "", DeployRel.Replace('/', Path.DirectorySeparatorChar));
            if (string.IsNullOrEmpty(projectRoot) || !Directory.Exists(root))
            {
                note = "找不到部署目录 " + DeployRel;
                return null;
            }

            var rels = new List<string>();
            try
            {
                foreach (var f in Directory.GetFiles(root, "*", SearchOption.AllDirectories))
                {
                    var rel = f.Substring(root.Length).TrimStart(Path.DirectorySeparatorChar, '/').Replace('\\', '/');
                    var name = Path.GetFileName(rel);
                    if (name == "VERSION" || name == ".DS_Store") continue;
                    if (name.EndsWith(".meta", StringComparison.Ordinal)) continue;
                    if (rel.IndexOf("__pycache__", StringComparison.Ordinal) >= 0) continue;
                    rels.Add(rel);
                }
                rels.Sort(StringComparer.Ordinal);

                var entries = new List<KeyValuePair<string, byte[]>>();
                for (int i = 0; i < rels.Count; i++)
                {
                    var abs = Path.Combine(root, rels[i].Replace('/', Path.DirectorySeparatorChar));
                    entries.Add(new KeyValuePair<string, byte[]>(rels[i], File.ReadAllBytes(abs)));
                }
                fileCount = entries.Count;
                return HashEntries(entries);
            }
            catch (Exception e)
            {
                note = "算部署树 hash 失败：" + e.Message;
                return null;
            }
        }

        /// <summary>读 <c>Assets/AvatarAudit/VERSION</c> 的 hash / time / files 三个字段（缺文件返回 null）。</summary>
        public static JsonObject ReadVersionFile(string projectRoot)
        {
            var p = Path.Combine(projectRoot ?? "", DeployRel.Replace('/', Path.DirectorySeparatorChar), "VERSION");
            if (string.IsNullOrEmpty(projectRoot) || !File.Exists(p)) return null;
            var o = new JsonObject();
            try
            {
                foreach (var line in File.ReadAllLines(p))
                {
                    int c = line.IndexOf(':');
                    if (c <= 0) continue;
                    var k = line.Substring(0, c).Trim();
                    var v = line.Substring(c + 1).Trim();
                    if (k == "hash") o.Set("hash", v);
                    else if (k == "time") o.Set("time", v);
                    else if (k == "files") { int n; if (int.TryParse(v, out n)) o.Set("files", n); }
                    else if (k == "source") o.Set("source", v);
                }
            }
            catch (Exception e)
            {
                o.Set("read_error", e.Message);
            }
            return o;
        }

        /// <summary>编译时间：本工具所在程序集 dll 的最后写入时间（UTC ISO8601）；取不到写 null。</summary>
        public static string CompileTimeUtc(Type toolType)
        {
            try
            {
                if (toolType == null) return null;
                var loc = toolType.Assembly.Location;
                if (string.IsNullOrEmpty(loc) || !File.Exists(loc)) return null;
                return File.GetLastWriteTimeUtc(loc).ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
            }
            catch { return null; }
        }

        /// <summary>
        /// 组装写进 states.json.tool_version 的对象。match 只在「算出的源 hash == VERSION.hash」时为 true；
        /// 目录/VERSION 缺失都算不匹配（拒跑），除非调用方显式 version_check=false 并接受标注。
        /// </summary>
        public static JsonObject Describe(string projectRoot, Type toolType, bool check)
        {
            var o = new JsonObject();
            int files = 0;
            string note;
            var computed = ComputeDeployHash(projectRoot, out files, out note);
            var vf = ReadVersionFile(projectRoot);
            var vHash = vf == null ? null : AuditJson.Str(vf, "hash", null);
            var vTime = vf == null ? null : AuditJson.Str(vf, "time", null);

            o.Set("source_hash", computed);
            o.Set("deployed_files", files);
            o.Set("compile_time_utc", CompileTimeUtc(toolType));
            o.Set("version_file", DeployRel + "/VERSION");
            o.Set("version_file_hash", vHash);
            o.Set("version_file_time_utc", vTime);
            o.Set("version_check", check);
            bool match = computed != null && vHash != null && string.Equals(computed, vHash, StringComparison.OrdinalIgnoreCase);
            o.Set("match", match);
            if (!string.IsNullOrEmpty(note)) o.Set("note", note);
            return o;
        }

        private static string NormalizeRel(string rel)
        {
            return (rel ?? "").Replace('\\', '/');
        }

        private static string ToHex(byte[] b)
        {
            if (b == null) return null;
            var sb = new StringBuilder(b.Length * 2);
            for (int i = 0; i < b.Length; i++) sb.Append(b[i].ToString("x2", CultureInfo.InvariantCulture));
            return sb.ToString();
        }
    }

    #endregion

    #region status.json

    public sealed class AuditStatus
    {
        private readonly string _statusPath;
        private readonly string _logPath;
        private readonly string _tool;

        public AuditStatus(string outDir, string tool)
        {
            _tool = tool;
            _statusPath = Path.Combine(outDir, "status.json");
            _logPath = Path.Combine(outDir, "audit.log");
        }

        public string StatusPath { get { return _statusPath; } }

        public void Running(string progress, string message) { Write("running", progress, message); }
        public void Done(string progress, string message) { Write("done", progress, message); }
        public void Error(string message) { Write("error", null, message); }
        /// <summary>T-13：批次级中止（哨兵未过 / 状态回读断言不一致）。与 error 分开，残留数据仍可读。</summary>
        public void Aborted(string message) { Write("aborted", null, message); }

        private void Write(string state, string progress, string message)
        {
            // 写盘失败也不能反过来把审查流程打断：状态文件只是给外部轮询用的，吞掉异常并打 Console。
            try
            {
                var o = new JsonObject();
                o.Set("state", state);
                o.Set("progress", progress ?? "");
                o.Set("message", message);
                o.Set("tool", _tool);
                o.Set("time", DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
                AuditJson.WriteFile(_statusPath, o);
            }
            catch (Exception e)
            {
                Debug.LogError("[AvatarAudit] 写 status.json 失败: " + e.Message);
            }
        }

        public void Log(string message)
        {
            var line = "[" + DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + "] " + message;
            Debug.Log("[AvatarAudit] " + message);
            try
            {
                var dir = Path.GetDirectoryName(_logPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.AppendAllText(_logPath, line + "\n", new UTF8Encoding(false));
            }
            catch { /* 日志写不进去不影响主流程 */ }
        }
    }

    #endregion

    #region 上下文与工具接口

    public sealed class AuditContext
    {
        public JsonObject Request;
        public string OutDir;
        public string Tool;
        public AuditStatus Status;
        public GameObject Avatar;
        public Animator Animator;
        public double DeadlineRealtime;
        public readonly List<string> Warnings = new List<string>();

        /// <summary>
        /// T-13：批次级中止原因。非空时由 AuditRunner.Pump 把 status.json 写成 <c>aborted</c>（不是 done/error），
        /// 已写完的 state_*.json / states.json 仍保留，供 T-14 判「这批为什么作废」。
        /// </summary>
        public string AbortReason;

        /// <summary>记下第一个中止原因（后续不再覆盖），工具据此把整批标 aborted。</summary>
        public void Abort(string reason)
        {
            if (string.IsNullOrEmpty(AbortReason)) AbortReason = reason;
        }

        public string S(string key, string def = null) { return AuditJson.Str(Request, key, def); }
        public double N(string key, double def) { return AuditJson.Num(Request, key, def); }
        public int I(string key, int def) { return AuditJson.Int(Request, key, def); }
        public bool B(string key, bool def) { return AuditJson.Bool(Request, key, def); }
        public JsonObject O(string key) { return AuditJson.Obj(Request, key); }
        public List<object> A(string key) { return AuditJson.Arr(Request, key); }

        public bool TimedOut { get { return Time.realtimeSinceStartup > DeadlineRealtime; } }

        public void Warn(string message)
        {
            Warnings.Add(message);
            Status.Log("WARN " + message);
        }

        public string OutPath(string fileName) { return Path.Combine(OutDir, fileName); }
    }

    public interface IAuditTool
    {
        string ToolId { get; }
        bool RequiresPlayMode { get; }
        int DefaultTimeoutSeconds { get; }
        /// <summary>初始化。抛异常 = 整个运行是 error。</summary>
        void Begin(AuditContext ctx);
        /// <summary>推进一小步；返回 true 表示全部完成。每帧由 EditorApplication.update 调用。</summary>
        bool Tick();
        /// <summary>无论正常结束、异常还是超时都会调用一次（幂等，负责恢复临时改动）。</summary>
        void Cleanup();
    }

    #endregion

    #region 头像解析

    public static class AuditAvatar
    {
        /// <summary>
        /// 按名字找场景里的头像根。
        /// 判据（为什么这么判）：面捕安装器（FaceTrackingFramework 等）会把头像克隆成第二个根，
        /// 两个根同名同结构，随便挑一个会把「另一个根上的问题」漏掉或报错位，所以：
        ///   - 先去重（子孙同名不算独立候选）；
        ///   - 只接受 activeInHierarchy 的候选；
        ///   - 0 个候选 → 报错并列出所有同名对象路径；≥2 个候选都活跃 → 报错并列出路径，
        ///     让调用者自己去关掉一个，而不是我们猜。
        /// </summary>
        public static GameObject Resolve(string name)
        {
            if (string.IsNullOrEmpty(name)) throw new Exception("请求缺少 avatar 字段");

            var all = Resources.FindObjectsOfTypeAll<Transform>();
            var matches = new List<Transform>();
            foreach (var t in all)
            {
                if (t == null) continue;
                var go = t.gameObject;
                if (go == null) continue;
                if (!string.Equals(go.name, name, StringComparison.Ordinal)) continue;
                if (EditorUtility.IsPersistent(go)) continue;   // 预制体资产，不是场景对象
                if (!go.scene.IsValid()) continue;              // 不在任何场景里
                matches.Add(t);
            }

            // 去掉「祖先已经命中同名」的子孙，避免把一个根算成两个候选
            var roots = new List<Transform>();
            foreach (var m in matches)
            {
                bool descendantOfOther = false;
                foreach (var o in matches)
                {
                    if (o == m) continue;
                    if (m.IsChildOf(o)) { descendantOfOther = true; break; }
                }
                if (!descendantOfOther) roots.Add(m);
            }

            var active = new List<Transform>();
            foreach (var r in roots) if (r.gameObject.activeInHierarchy) active.Add(r);

            if (active.Count == 1) return active[0].gameObject;

            var lines = new List<string>();
            foreach (var r in roots)
                lines.Add("  " + AuditUtil.ScenePath(r) + (r.gameObject.activeInHierarchy ? "   [active]" : "   [inactive]"));
            var listed = string.Join("\n", lines.ToArray());

            if (roots.Count == 0) throw new Exception("场景里找不到名为 '" + name + "' 的对象");
            if (active.Count == 0)
                throw new Exception("找到 " + roots.Count + " 个名为 '" + name + "' 的对象，但没有一个 activeInHierarchy：\n" + listed);
            throw new Exception("找到 " + active.Count + " 个名为 '" + name + "' 且都 activeInHierarchy 的对象，无法判定审哪一个（面捕安装器克隆的嫌疑）：\n" + listed);
        }

        /// <summary>头像上的 VRC_AvatarDescriptor（VRChat SDK，反射取，SDK 不在时返回 null）。</summary>
        public static Component FindDescriptor(GameObject avatar)
        {
            var t = GmgBridge.FindType("VRC.SDK3.Avatars.Components.VRCAvatarDescriptor");
            if (t != null)
            {
                var c = avatar.GetComponent(t);
                if (c != null) return c;
            }
            var b = GmgBridge.FindType("VRC.SDKBase.VRC_AvatarDescriptor");
            if (b != null) return avatar.GetComponent(b);
            return null;
        }
    }

    #endregion

    #region GestureManager 反射桥

    /// <summary>
    /// GestureManager 3.9.9 的反射桥。命中点（工程里任一 GM 包的源码位置一致）：
    ///   - BlackStartX.GestureManager.GestureManager
    ///       Scripts/Runtime/GestureManager.cs:13  ControlledAvatars（static Dictionary&lt;GameObject, ModuleBase&gt;）
    ///       Scripts/Runtime/GestureManager.cs:67  SetModule(ModuleBase)
    ///   - BlackStartX.GestureManager.Data.ModuleBase
    ///       Scripts/Runtime/Data/ModuleBase.cs:26  readonly GameObject Avatar
    ///       Scripts/Runtime/Data/ModuleBase.cs:34  Settings（ModuleSettings）
    ///       Scripts/Runtime/Data/ModuleBase.cs:148 Connect(ModuleSettings)（内部登记到 ControlledAvatars）
    ///   - BlackStartX.GestureManager.Editor.Modules.Vrc3.ModuleVrc3
    ///       Scripts/Editor/Modules/Vrc3/ModuleVrc3.cs:1045 GetParam(string) → Vrc3Param
    ///       Scripts/Editor/Modules/Vrc3/ModuleVrc3.cs:1004 InitParams(VRCExpressionParameters)
    ///   - BlackStartX.GestureManager.Editor.Modules.Vrc3.Params.Vrc3Param
    ///       Scripts/Editor/Modules/Vrc3/Params/Vrc3Param.cs:42  Set(ModuleVrc3, float, object)
    ///       Scripts/Editor/Modules/Vrc3/Params/Vrc3Param.cs:106 InternalSet(float, object) → 写各层 Playable
    ///   - BlackStartX.GestureManager.Editor.Modules.ModuleHelper
    ///       Scripts/Editor/Modules/ModuleHelper.cs:20 GetModuleFor(VRC_AvatarDescriptor) → ModuleVrc3
    /// </summary>
    public static class GmgBridge
    {
        private static bool _init;
        private static Type _managerType, _moduleBaseType, _moduleVrc3Type, _paramType, _helperType;

        /// <summary>本工具在 Play 模式下临时创建的 GestureManager 物体（非 null = 是我们建的）。</summary>
        private static GameObject _auditCreatedGo;

        public static string InitNote { get; private set; }

        private static readonly Dictionary<string, Type> _typeCache = new Dictionary<string, Type>();
        private static readonly Dictionary<Type, MethodInfo> _getParamMethods = new Dictionary<Type, MethodInfo>();
        private static readonly Dictionary<Type, MethodInfo> _setParamMethods = new Dictionary<Type, MethodInfo>();
        private static readonly Dictionary<Type, FieldInfo> _paramTypeFields = new Dictionary<Type, FieldInfo>();
        private static readonly Dictionary<Type, MethodInfo> _floatValueMethods = new Dictionary<Type, MethodInfo>();

        /// <summary>
        /// 按全名在当前 AppDomain 里找类型。逐个程序集 GetType（而不是 GetTypes）——
        /// GetTypes 会强制加载所有类型、在有坏依赖的程序集上抛 ReflectionTypeLoadException，
        /// 而且慢得多；GetType(name, false) 找不到只返回 null。
        /// </summary>
        public static Type FindType(string fullName)
        {
            Type cached;
            if (_typeCache.TryGetValue(fullName, out cached)) return cached;

            Type found = null;
            var assemblies = AppDomain.CurrentDomain.GetAssemblies();
            for (int i = 0; i < assemblies.Length; i++)
            {
                try
                {
                    var t = assemblies[i].GetType(fullName, false);
                    if (t != null) { found = t; break; }
                }
                catch { /* 某些程序集 GetType 会抛，跳过 */ }
            }
            _typeCache[fullName] = found;
            return found;
        }

        public static bool EnsureInit()
        {
            if (_init) return true;
            _managerType = FindType("BlackStartX.GestureManager.GestureManager");
            _moduleBaseType = FindType("BlackStartX.GestureManager.Data.ModuleBase");
            _moduleVrc3Type = FindType("BlackStartX.GestureManager.Editor.Modules.Vrc3.ModuleVrc3");
            _paramType = FindType("BlackStartX.GestureManager.Editor.Modules.Vrc3.Params.Vrc3Param");
            _helperType = FindType("BlackStartX.GestureManager.Editor.Modules.ModuleHelper");
            _init = true;

            if (_managerType == null) { InitNote = "找不到 BlackStartX.GestureManager.GestureManager 类型（GM 未安装？）"; return false; }
            if (_moduleVrc3Type == null) { InitNote = "找不到 ModuleVrc3（GM 版本不符？）"; return false; }
            if (_paramType == null) { InitNote = "找不到 Vrc3Param（GM 版本不符？）"; return false; }
            InitNote = null;
            return true;
        }

        public static bool Available { get { return EnsureInit(); } }

        /// <summary>当前这个 GestureManager 是否由本工具临时创建（T1 输出里的 gm_created_by_audit；T1 收尾据此销毁）。</summary>
        public static bool CreatedByAudit { get { return _auditCreatedGo != null; } }

        // ---- GestureManager 组件与受控头像表 ----

        public static IDictionary ControlledAvatars()
        {
            if (!EnsureInit()) return null;
            var f = _managerType.GetField("ControlledAvatars", BindingFlags.Public | BindingFlags.Static | BindingFlags.NonPublic);
            return f == null ? null : f.GetValue(null) as IDictionary;
        }

        public static bool IsControlled(GameObject avatar)
        {
            var d = ControlledAvatars();
            return d != null && avatar != null && d.Contains(avatar);
        }

        public static object GetControlledModule(GameObject avatar)
        {
            var d = ControlledAvatars();
            if (d == null || avatar == null || !d.Contains(avatar)) return null;
            return d[avatar];
        }

        /// <summary>场景里第一个可用的 GestureManager 组件（排除预制体资产）。</summary>
        public static Component FindManager()
        {
            if (!EnsureInit()) return null;
            UnityEngine.Object[] objs;
            try { objs = Resources.FindObjectsOfTypeAll(_managerType); }
            catch { return null; }

            Component fallback = null;
            foreach (var o in objs)
            {
                var c = o as Component;
                if (c == null) continue;
                if (EditorUtility.IsPersistent(c)) continue;
                if (!c.gameObject.scene.IsValid()) continue;
                var b = c as Behaviour;
                bool usable = b == null || (b.enabled && c.gameObject.activeInHierarchy);
                if (usable) return c;
                if (fallback == null) fallback = c;
            }
            return fallback;
        }

        /// <summary>
        /// 场景里没有 GestureManager 组件时，Play 模式下临时建一个（编辑模式返回 null，保持原退路）。
        ///
        /// 出处（GestureManager 3.9.9，本工程 Packages/vrchat.blackstartx.gesture-manager/）：
        ///   - 菜单 Tools/Gesture Manager Emulator → GestureManagerEditor.AddNewEmulator
        ///       Scripts/Editor/GestureManagerEditor.cs:43-49 加载并 InstantiatePrefab
        ///       Packages/vrchat.blackstartx.gesture-manager/GestureManager.prefab（:46-55）。
        ///       该 prefab 只含一个名为 GestureManager 的 GameObject + GestureManager 组件，
        ///       组件上把 settings 各字段序列化好（GestureManager.prefab 内 cullingDistance=5、
        ///       initialPose=0、simulateCulling=0 等），没有别的组件或字段。
        ///   - 若 prefab 找不到，GM 自己退化为 CreateAndPing：
        ///       Scripts/Editor/GestureManagerEditor.cs:63-68  new GameObject("GestureManager").AddComponent&lt;GestureManager&gt;()
        ///   本方法照这条兜底路径建，但改名 __AvatarAudit_GM 并置 hideFlags=DontSave，避免污染场景/存档。
        ///
        /// 为什么 AddComponent 后不需要等 Awake/OnEnable/Start：
        ///   Scripts/Runtime/GestureManager.cs 全文没有 Awake/OnEnable/Start，唯一生命周期钩子是
        ///   OnDisable（:23，只在销毁/禁用时 UnlinkModule）。AddComponent 返回时组件已 enabled、物体已 active，
        ///   可直接 SetModule；真正的初始化在 SetModule → ModuleBase.Connect（ModuleBase.cs:148-154）→
        ///   ModuleVrc3.InitForAvatar（ModuleVrc3.cs:181-311）里同步完成（末尾 graph.Play()/Evaluate(0f)），
        ///   不依赖协程或帧。settings 来自 prefab 序列化字段，运行时 new 出来是 null，用 EnsureSettings 补默认实例。
        /// </summary>
        public static Component CreateAuditManager()
        {
            if (!Application.isPlaying) return null; // 编辑模式不建，保持原退路
            if (!EnsureInit()) return null;
            if (_auditCreatedGo != null) return _auditCreatedGo.GetComponent(_managerType);

            var go = new GameObject("__AvatarAudit_GM");
            go.hideFlags = HideFlags.DontSave;
            var comp = go.AddComponent(_managerType);
            if (comp == null) { UnityEngine.Object.DestroyImmediate(go); return null; }
            var b = comp as Behaviour;
            if (b != null) b.enabled = true; // AddComponent 默认 enabled；显式写，防将来 GM 默认改为 disabled
            EnsureSettings(comp);
            _auditCreatedGo = go;
            return comp;
        }

        /// <summary>
        /// 销毁本次审查自己创建的临时 GestureManager（场景里原本就有的组件不动）。幂等。
        /// </summary>
        public static bool DestroyAuditManager()
        {
            if (_auditCreatedGo == null) return false;
            var go = _auditCreatedGo;
            _auditCreatedGo = null;
            if (Application.isPlaying) UnityEngine.Object.Destroy(go);
            else UnityEngine.Object.DestroyImmediate(go);
            return true;
        }

        /// <summary>
        /// 让 GM 接管这个头像。GM 正常路径是「在 Play 模式下把 GestureManager 的 Inspector 打开，
        /// CreateInspectorGUI → TryInitialize → SetModule」；自动化场景下没人开 Inspector，
        /// 所以我们直接照它的内部路径调用 ModuleHelper.GetModuleFor + GestureManager.SetModule。
        /// 不接管就退回直接写 Animator，但那时 VRC_AvatarParameterDriver / LayerControl 都不会被模拟，
        /// 结论必须降级（调用方要在输出里写明 driver=animator）。
        /// </summary>
        public static object EnsureControlled(GameObject avatar, out string note)
        {
            note = null;
            if (!EnsureInit()) { note = InitNote; return null; }

            var existing = GetControlledModule(avatar);
            if (existing != null) { note = "already_controlled"; return existing; }

            var manager = FindManager();
            if (manager == null && Application.isPlaying) manager = CreateAuditManager();
            if (manager == null) { note = "场景里没有可用的 GestureManager 组件"; return null; }
            bool createdByAudit = CreatedByAudit;
            EnsureSettings(manager);

            var module = CreateModule(avatar);
            if (module == null) { note = WithCreatedFlag(createdByAudit, "无法创建 ModuleVrc3（头像上找不到 VRC_AvatarDescriptor？）"); return null; }

            var mi = FindSetModule();
            if (mi == null) { note = WithCreatedFlag(createdByAudit, "GestureManager.SetModule 方法名/签名与预期不符"); return null; }
            try { mi.Invoke(manager, new object[] { module }); }
            catch (Exception e) { note = WithCreatedFlag(createdByAudit, "调用 GestureManager.SetModule 抛异常：" + AuditUtil.Unwrap(e).Message); return null; }

            existing = GetControlledModule(avatar);
            bool disabled = (manager is Behaviour) && !((Behaviour)manager).enabled;
            note = existing != null
                ? WithCreatedFlag(createdByAudit, disabled
                    ? "took_over；但 GestureManager 组件是 disabled 的，它的每帧逻辑（clone 同步 / OSC / 剔除）不会跑；参数仍会经 PlayableGraph 生效"
                    : "took_over")
                : WithCreatedFlag(createdByAudit, "SetModule 调用了，但 ControlledAvatars 里仍没有该头像");
            return existing;
        }

        /// <summary>把「本次临时建了 GM」写进输出 note 的前缀（调用方也会在 states.json 里写布尔字段）。</summary>
        private static string WithCreatedFlag(bool createdByAudit, string note)
        {
            return createdByAudit ? "gm_created_by_audit=true；" + note : note;
        }

        private static MethodInfo FindSetModule()
        {
            // 按参数类型精确取，避免 GetMethod(name) 在将来出现重载时抛 AmbiguousMatchException
            var flags = BindingFlags.Instance | BindingFlags.Public;
            if (_moduleBaseType != null)
            {
                var typed = _managerType.GetMethod("SetModule", flags, null, new[] { _moduleBaseType }, null);
                if (typed != null) return typed;
            }
            return _managerType.GetMethod("SetModule", flags);
        }

        private static void EnsureSettings(Component manager)
        {
            // settings 是序列化字段，正常来自 GestureManager.prefab（settings 各子字段都在 prefab 里）。
            // 但若 GM 组件是运行时 new GameObject 加出来的，settings 会是 null，后面 Module.Connect(null)
            // 会让 Settings.simulateCulling 这类访问 NPE——这里补一个默认实例兜底。
            var f = _managerType.GetField("settings", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (f == null) return;
            if (f.GetValue(manager) != null) return;
            try { f.SetValue(manager, Activator.CreateInstance(f.FieldType)); }
            catch { /* 补不上就算了，后面接管失败会写进 note */ }
        }

        private static object CreateModule(GameObject avatar)
        {
            var descriptor = AuditAvatar.FindDescriptor(avatar);
            if (descriptor == null) return null;
            if (_helperType == null) return null;
            // 有的 GM 版本有两个重载 GetModuleFor(GameObject) / GetModuleFor(描述符)（工程G工程实测），
            // 按名字 GetMethod 会 AmbiguousMatchException —— 按参数类型挑：先描述符版，再 GameObject 版。
            MethodInfo byDesc = null, byGo = null;
            foreach (var m in _helperType.GetMethods(BindingFlags.Static | BindingFlags.Public))
            {
                if (m.Name != "GetModuleFor") continue;
                var ps = m.GetParameters();
                if (ps.Length != 1) continue;
                if (ps[0].ParameterType.IsInstanceOfType(descriptor)) byDesc = m;
                else if (ps[0].ParameterType == typeof(GameObject)) byGo = m;
            }
            try
            {
                if (byDesc != null) return byDesc.Invoke(null, new object[] { descriptor });
                if (byGo != null) return byGo.Invoke(null, new object[] { avatar });
                return null;
            }
            catch { return null; }
        }

        // ---- 参数读写 ----

        public static object GetParam(object module, string name)
        {
            if (module == null) return null;
            var mt = module.GetType();
            MethodInfo mi;
            if (!_getParamMethods.TryGetValue(mt, out mi))
            {
                mi = mt.GetMethod("GetParam", new[] { typeof(string) });
                _getParamMethods[mt] = mi;
            }
            if (mi == null) return null;
            try { return mi.Invoke(module, new object[] { name }); }
            catch { return null; }
        }

        /// <summary>Vrc3Param.Type（AnimatorControllerParameterType）。取不到返回 null。</summary>
        public static string ParamTypeName(object param)
        {
            if (param == null) return null;
            var pt = param.GetType();
            FieldInfo f;
            if (!_paramTypeFields.TryGetValue(pt, out f))
            {
                f = pt.GetField("Type", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                _paramTypeFields[pt] = f;
            }
            if (f == null) return null;
            var v = f.GetValue(param);
            return v == null ? null : v.ToString();
        }

        /// <summary>
        /// 调用 Vrc3Param.Set(ModuleVrc3, float, object)。
        /// 为什么找 Set 而不是 InternalSet：Set 会额外触发 _onChange（GM 用它模拟
        /// LayerControl / ParameterDriver 的联动）和 OSC 广播（ModuleVrc3.cs:284-295 注册的处理器），
        /// InternalSet 只写 Playable，联动不生效。
        /// 为什么缓存 MethodInfo：一次审查要设 300 参数 × 若干状态 × 两遍，
        /// GetMethods() 每次都分配整个方法表，实测轨迹上是明显的 GC 来源。
        /// </summary>
        public static bool SetParam(object module, object param, float value, out string error)
        {
            error = null;
            if (module == null || param == null) { error = "module/param 为空"; return false; }
            var pt = param.GetType();
            MethodInfo target;
            if (!_setParamMethods.TryGetValue(pt, out target))
            {
                target = null;
                var methods = pt.GetMethods(BindingFlags.Instance | BindingFlags.Public);
                foreach (var m in methods)
                {
                    if (m.Name != "Set") continue;
                    var ps = m.GetParameters();
                    if (ps.Length != 3) continue;
                    if (ps[1].ParameterType != typeof(float)) continue;
                    if (ps[2].ParameterType != typeof(object)) continue;
                    target = m;
                    break;
                }
                _setParamMethods[pt] = target;
            }
            if (target == null) { error = "没有找到 Set(module, float, object) 重载"; return false; }
            try
            {
                target.Invoke(param, new object[] { module, value, null });
                return true;
            }
            catch (Exception e) { error = AuditUtil.Unwrap(e).Message; return false; }
        }

        public static float GetParamValue(object module, object param)
        {
            if (param == null) return 0f;
            var pt = param.GetType();
            MethodInfo mi;
            if (!_floatValueMethods.TryGetValue(pt, out mi))
            {
                mi = pt.GetMethod("FloatValue", Type.EmptyTypes);
                _floatValueMethods[pt] = mi;
            }
            if (mi == null) return 0f;
            try
            {
                var v = mi.Invoke(param, null);
                return v == null ? 0f : Convert.ToSingle(v, CultureInfo.InvariantCulture);
            }
            catch { return 0f; }
        }

        /// <summary>GM Params 字典里的全部参数名（含 GM 内建的 VRChat 参数与各层控制器参数）。</summary>
        public static List<string> AllParamNames(object module)
        {
            var list = new List<string>();
            if (module == null) return list;
            var f = module.GetType().GetField("Params", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (f == null) return list;
            var dict = f.GetValue(module) as IDictionary;
            if (dict == null) return list;
            foreach (var k in dict.Keys) if (k is string) list.Add((string)k);
            return list;
        }

        public static bool SetPose(object module, string bone, bool on)
        {
            // ModuleVrc3.cs:105-106 internal readonly Vrc3Param PoseT / PoseIK
            if (module == null) return false;
            var f = module.GetType().GetField(bone, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (f == null) return false;
            var p = f.GetValue(module);
            if (p == null) return false;
            string err;
            return SetParam(module, p, on ? 1f : 0f, out err);
        }

        // ---- GM 的 simulate culling 开关 ----
        // ModuleSettings.simulateCulling（Scripts/Runtime/Modules/ModuleSettings.cs:20）默认 0（关）。
        // 一旦为开，GM 会按「编辑器相机到头像的距离 > cullingDistance」把全部 renderer.enabled 置 false
        // （ModuleVrc3.cs:975 SetAvatarCulled），快照会变成「整个头像不可见」。所以审查期间临时关掉，
        // 结束时恢复原值。

        public static bool TryGetSimulateCulling(object module, out bool value)
        {
            value = false;
            var f = SettingsField(module);
            if (f == null) return false;
            var so = f.GetValue(module);
            if (so == null) return false;
            var sf = so.GetType().GetField("simulateCulling", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (sf == null) return false;
            value = (bool)sf.GetValue(so);
            return true;
        }

        public static bool TrySetSimulateCulling(object module, bool value)
        {
            var f = SettingsField(module);
            if (f == null) return false;
            var so = f.GetValue(module);
            if (so == null) return false;
            var sf = so.GetType().GetField("simulateCulling", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (sf == null) return false;
            sf.SetValue(so, value);
            return true;
        }

        private static FieldInfo SettingsField(object module)
        {
            if (module == null) return null;
            return module.GetType().GetField("Settings", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        }
    }

    #endregion

    #region 工程侧编辑器回调隔离

    /// <summary>
    /// 审查期间把「工程自带」的编辑器回调从 EditorApplication.update / playModeStateChanged 上摘下来。
    ///
    /// 为什么需要：客户工程里的老探针（如 AvatarGen.RuntimeProbe / EarPlayProbe）用 [InitializeOnLoad]
    /// 在进 Play 时自动 armed，每帧 SetFloat 写参数、退出 Play 时写 Assets/ 下的 markdown。它们和审查
    /// 无关，却会污染参数状态、改写工程文件。按「程序集 + 命名空间」隔离比逐个点名可靠：新装进来的
    /// 探针也一并摘掉。
    ///
    /// 摘哪些：方法所在程序集名以 "Assembly-CSharp" 开头（工程自己的 Editor / Runtime 程序集），
    /// 且声明类型不在 AvatarAudit 命名空间（本工具也部署在 Assets/Editor/AvatarAudit，编译进
    /// Assembly-CSharp-Editor，不能把自己摘掉）。
    ///
    /// 为什么摘了不马上挂回去：playModeStateChanged 上的探针正是在 ExitingPlayMode / EnteredEditMode
    /// 时写工程文件。Cleanup 通常发生在还在 Play 时，若那时挂回，退出 Play 照样触发。所以摘除保持到
    /// 「退出 Play 回到编辑模式（EnteredEditMode）」之后再挂回：本类订阅一次 playModeStateChanged，
    /// 收到 EnteredEditMode 时恢复并退订自己。时序另见 审查/docs/state-driver-isolation.md（原 README §3.0.2）。
    /// </summary>
    public static class AuditCallbackIsolation
    {
        private static readonly List<IsolatedHandler> _isolated = new List<IsolatedHandler>();
        private static readonly List<string> _isolatedNames = new List<string>();
        private static bool _installed;
        private static bool _hooked;
        private static bool _probeDisarmed;
        private static string _probeTypeName;
        private static string _reportPath;
        private static string _installedAt;
        private static string _restoredAt;

        private sealed class IsolatedHandler
        {
            public string Kind;          // "update" / "playModeStateChanged"
            public Delegate Handler;
        }

        public static bool Installed { get { return _installed; } }

        /// <summary>请求开始处调用（T1/T2/T3 通用）。幂等。</summary>
        public static void Install(AuditContext ctx)
        {
            if (_installed) return;
            _installed = true;
            _isolated.Clear();
            _isolatedNames.Clear();
            _probeDisarmed = false;
            _probeTypeName = null;
            _restoredAt = null;
            _installedAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            if (ctx != null) _reportPath = Path.Combine(ctx.OutDir, "isolated_callbacks.json");

            try { IsolateUpdate(); }
            catch (Exception e) { Warn(ctx, "隔离 EditorApplication.update 失败：" + AuditUtil.Unwrap(e).Message); }

            try { IsolatePlayModeChanged(); }
            catch (Exception e) { Warn(ctx, "隔离 playModeStateChanged 失败：" + AuditUtil.Unwrap(e).Message); }

            try { DisarmRuntimeProbe(); }
            catch (Exception e) { Warn(ctx, "冻结 AvatarGen.RuntimeProbe._armed 失败：" + AuditUtil.Unwrap(e).Message); }

            if (!_hooked)
            {
                EditorApplication.playModeStateChanged += OnPlayModeChanged;
                _hooked = true;
            }

            var msg = "回调隔离：摘除 " + _isolated.Count + " 个工程侧编辑器回调";
            if (_isolatedNames.Count > 0) msg += "（" + string.Join(", ", _isolatedNames.ToArray()) + "）";
            if (_probeDisarmed) msg += "；已把 " + _probeTypeName + "._armed 置 false";
            msg += "。保持到退出 Play 回到编辑模式后再挂回。";
            if (ctx != null) ctx.Status.Log(msg); else Debug.Log("[AvatarAudit] " + msg);
            WriteReport();
        }

        // ---------------------------------------------------------------- 摘除

        private static void IsolateUpdate()
        {
            var f = typeof(EditorApplication).GetField("update", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (f == null) return;
            var current = f.GetValue(null) as Delegate;
            if (current == null) return;

            var keep = new List<Delegate>();
            var list = current.GetInvocationList();
            for (int i = 0; i < list.Length; i++)
            {
                if (ShouldIsolate(list[i])) Record("update", list[i]);
                else keep.Add(list[i]);
            }
            if (keep.Count == list.Length) return;

            Delegate rebuilt = null;
            for (int i = 0; i < keep.Count; i++) rebuilt = Delegate.Combine(rebuilt, keep[i]);
            f.SetValue(null, rebuilt);
        }

        /// <summary>
        /// playModeStateChanged 是事件（自定义 add/remove），真正存委托的是静态字段
        /// m_PlayModeStateChangedEvent（EventWithPerformanceTracker&lt;Action&lt;PlayModeStateChange&gt;&gt;）。
        /// 调 remove_/add_ 访问器最稳，不直接改内部结构；先反射把当前订阅者读出来。
        /// </summary>
        private static void IsolatePlayModeChanged()
        {
            var evtField = typeof(EditorApplication).GetField("m_PlayModeStateChangedEvent", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (evtField == null) return;
            var handlers = ExtractDelegates(evtField.GetValue(null));
            if (handlers.Count == 0) return;

            var remove = typeof(EditorApplication).GetMethod("remove_playModeStateChanged", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (remove == null) return;

            for (int i = 0; i < handlers.Count; i++)
            {
                if (!ShouldIsolate(handlers[i])) continue;
                remove.Invoke(null, new object[] { handlers[i] });
                Record("playModeStateChanged", handlers[i]);
            }
        }

        private static void DisarmRuntimeProbe()
        {
            var assemblies = AppDomain.CurrentDomain.GetAssemblies();
            for (int i = 0; i < assemblies.Length; i++)
            {
                Type t;
                try { t = assemblies[i].GetType("AvatarGen.RuntimeProbe", false); }
                catch { continue; }
                if (t == null) continue;
                _probeTypeName = t.FullName;
                var f = t.GetField("_armed", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                if (f == null || f.FieldType != typeof(bool)) return;
                f.SetValue(null, false);
                _probeDisarmed = true;
                return;
            }
        }

        private static void Record(string kind, Delegate handler)
        {
            _isolated.Add(new IsolatedHandler { Kind = kind, Handler = handler });
            _isolatedNames.Add(Describe(handler));
        }

        // ---------------------------------------------------------------- 判定与读取

        private static bool ShouldIsolate(Delegate d)
        {
            if (d == null || d.Method == null) return false;
            var dt = d.Method.DeclaringType;
            if (dt == null) return false;

            var asmName = dt.Assembly.GetName().Name;
            if (string.IsNullOrEmpty(asmName) || !asmName.StartsWith("Assembly-CSharp", StringComparison.Ordinal)) return false;

            var outer = dt;
            while (outer.IsNested && outer.DeclaringType != null) outer = outer.DeclaringType;
            var ns = outer.Namespace ?? "";
            if (ns == "AvatarAudit" || ns.StartsWith("AvatarAudit.", StringComparison.Ordinal)) return false;
            return true;
        }

        private static List<Delegate> ExtractDelegates(object wrapper)
        {
            var result = new List<Delegate>();
            if (wrapper == null) return result;

            var dwh = GetFieldValue(wrapper, "m_Delegate");
            var entry = GetFieldValue(dwh, "m_DelegateOrList");
            var reference = GetFieldValue(entry, "Reference");
            if (reference == null) return result;

            var arr = reference as Array;
            if (arr != null)
            {
                for (int i = 0; i < arr.Length; i++)
                {
                    var d = GetFieldValue(arr.GetValue(i), "Reference") as Delegate;
                    if (d != null) result.Add(d);
                }
            }
            else
            {
                var d = reference as Delegate;
                if (d != null) result.Add(d);
            }
            return result;
        }

        private static object GetFieldValue(object obj, string field)
        {
            if (obj == null) return null;
            var f = obj.GetType().GetField(field, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            return f == null ? null : f.GetValue(obj);
        }

        private static string Describe(Delegate d)
        {
            if (d == null || d.Method == null) return "?";
            var dt = d.Method.DeclaringType;
            return (dt == null ? "?" : dt.FullName) + "." + d.Method.Name;
        }

        // ---------------------------------------------------------------- 恢复（退出 Play 之后）

        /// <summary>
        /// runner 收尾时调用。**在 Play 模式里故意不恢复**：此刻挂回的话，退出 Play 时老探针照样触发，
        /// 所以要等 OnPlayModeChanged 收到 EnteredEditMode 再挂回。若本来就在编辑模式（T3 允许编辑模式跑），
        /// 不存在「下一次退出 Play」，立即恢复。
        /// </summary>
        public static void Cleanup()
        {
            if (!_installed) return;
            if (EditorApplication.isPlaying) return;
            if (_hooked)
            {
                EditorApplication.playModeStateChanged -= OnPlayModeChanged;
                _hooked = false;
            }
            Restore();
        }

        private static void OnPlayModeChanged(PlayModeStateChange change)
        {
            if (change != PlayModeStateChange.EnteredEditMode) return;
            EditorApplication.playModeStateChanged -= OnPlayModeChanged;
            _hooked = false;
            // 不在事件分发过程中改订阅表，推迟到下一次 delayCall。
            EditorApplication.delayCall += Restore;
        }

        private static void Restore()
        {
            if (!_installed) return;
            var add = typeof(EditorApplication).GetMethod("add_playModeStateChanged", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            for (int i = 0; i < _isolated.Count; i++)
            {
                var h = _isolated[i];
                try
                {
                    if (h.Kind == "update")
                    {
                        var f = typeof(EditorApplication).GetField("update", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
                        if (f != null) f.SetValue(null, Delegate.Combine(f.GetValue(null) as Delegate, h.Handler));
                    }
                    else if (h.Kind == "playModeStateChanged" && add != null)
                    {
                        add.Invoke(null, new object[] { h.Handler });
                    }
                }
                catch (Exception e)
                {
                    Debug.LogError("[AvatarAudit] 恢复回调 " + Describe(h.Handler) + " 失败：" + e.Message);
                }
            }

            var count = _isolated.Count;
            _isolated.Clear();
            _installed = false;
            _restoredAt = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
            WriteReport();
            Debug.Log("[AvatarAudit] 回调隔离已解除：挂回 " + count + " 个工程侧编辑器回调");
        }

        // ---------------------------------------------------------------- 输出

        private static void WriteReport()
        {
            if (string.IsNullOrEmpty(_reportPath)) return;
            try
            {
                var o = new JsonObject();
                o.Set("installed_at", _installedAt);
                o.Set("isolated_callbacks", _isolatedNames.Cast<object>().ToList());
                o.Set("runtime_probe_disarmed", _probeDisarmed ? _probeTypeName : null);
                o.Set("restored_at", _restoredAt);
                o.Set("note", "摘除保持到退出 Play 回到编辑模式（EnteredEditMode）之后才挂回，以防退出 Play 时老探针写工程文件。");
                AuditJson.WriteFile(_reportPath, o);
            }
            catch (Exception e) { Debug.LogError("[AvatarAudit] 写 isolated_callbacks.json 失败：" + e.Message); }
        }

        private static void Warn(AuditContext ctx, string message)
        {
            if (ctx != null) ctx.Warn(message); else Debug.LogWarning("[AvatarAudit] " + message);
        }
    }

    #endregion

    #region 菜单入口 + 多帧状态机泵

    /// <summary>
    /// 统一入口：读 &lt;工程&gt;/Library/AvatarAudit/request.json → 按 tool 分派 → 每帧 Tick。
    /// Library/ 不进版本库也不会被 Unity 导入，所以请求文件放那里最干净。
    /// </summary>
    [InitializeOnLoad]
    public static class AuditRunner
    {
        private const string RequestRelPath = "Library/AvatarAudit/request.json";
        private const string PendingKey = "AvatarAudit.PendingRequestJson";

        private static IAuditTool _tool;
        private static AuditContext _ctx;

        static AuditRunner()
        {
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            EditorApplication.delayCall += TryResumePending;
        }

        public static string ProjectRoot
        {
            get
            {
                var parent = Directory.GetParent(Application.dataPath);
                return parent == null ? Application.dataPath : parent.FullName;
            }
        }

        public static string RequestPath { get { return Path.Combine(ProjectRoot, RequestRelPath); } }

        [MenuItem("Tools/AvatarAudit/Run Request", false, 100)]
        public static void RunRequestFromMenu()
        {
            if (_tool != null)
            {
                Debug.LogWarning("[AvatarAudit] 已有一个审查任务在跑，忽略本次请求。可先执行 Tools/AvatarAudit/Abort Current Run。");
                return;
            }
            if (EditorApplication.isCompiling || EditorApplication.isUpdating)
            {
                Debug.LogError("[AvatarAudit] 编辑器正在编译/导入，稍后再试。");
                return;
            }

            string text;
            try { text = File.ReadAllText(RequestPath, Encoding.UTF8); }
            catch (Exception e)
            {
                Debug.LogError("[AvatarAudit] 读不到请求文件 " + RequestPath + " ：" + e.Message);
                return;
            }
            StartFromJson(text);
        }

        [MenuItem("Tools/AvatarAudit/Abort Current Run", false, 101)]
        public static void AbortFromMenu()
        {
            if (_tool == null) return;
            _ctx.Status.Error("被手动中止（Tools/AvatarAudit/Abort Current Run）");
            Stop(true);
        }

        public static bool IsRunning { get { return _tool != null; } }

        private static void StartFromJson(string json)
        {
            JsonObject req;
            try { req = AuditJson.Parse(json) as JsonObject; }
            catch (Exception e) { Debug.LogError("[AvatarAudit] 请求 JSON 解析失败：" + e.Message); return; }
            if (req == null) { Debug.LogError("[AvatarAudit] 请求 JSON 顶层必须是对象"); return; }

            var toolId = AuditJson.Str(req, "tool", "state");
            IAuditTool tool;
            if (toolId == "state") tool = new AuditStateDriver();
            else if (toolId == "turntable") tool = new AuditTurntable();
            else if (toolId == "fit") tool = new AuditFitProbe();
            else if (toolId == "menu") tool = AuditMenuDump.Create();
            else if (toolId == "sequence") tool = new AuditSequence(req);
            else { Debug.LogError("[AvatarAudit] 未知 tool: " + toolId + "（支持 state / turntable / fit / menu / sequence）"); return; }

            var outDir = AuditJson.Str(req, "out", null);
            if (string.IsNullOrEmpty(outDir))
            {
                Debug.LogError("[AvatarAudit] 请求缺少 out（输出目录绝对路径），无法写 status.json。");
                return;
            }
            try { Directory.CreateDirectory(outDir); }
            catch (Exception e) { Debug.LogError("[AvatarAudit] 建输出目录失败 " + outDir + " ：" + e.Message); return; }

            var ctx = new AuditContext();
            ctx.Request = req;
            ctx.OutDir = outDir;
            ctx.Tool = toolId;
            ctx.Status = new AuditStatus(outDir, toolId);
            ctx.DeadlineRealtime = Time.realtimeSinceStartup + AuditJson.Num(req, "timeout_seconds", tool.DefaultTimeoutSeconds);

            if (tool.RequiresPlayMode && !EditorApplication.isPlaying)
            {
                if (AuditJson.Bool(req, "auto_play", false))
                {
                    // 跨域重载后静态字段会丢，用 SessionState 把请求存起来，进 Play 后再起。
                    SessionState.SetString(PendingKey, json);
                    ctx.Status.Running(null, "正在进入 Play 模式，进入后自动开始");
                    ctx.Status.Log("auto_play=true，调用 EditorApplication.EnterPlaymode()");
                    EditorApplication.EnterPlaymode();
                    return;
                }
                ctx.Status.Error("tool=state 必须在 Play 模式下运行：请先进入 Play 模式，再执行菜单 Tools/AvatarAudit/Run Request（或在请求里加 \"auto_play\": true）");
                return;
            }

            Begin(tool, ctx);
        }

        private static void Begin(IAuditTool tool, AuditContext ctx)
        {
            _tool = tool;
            _ctx = ctx;
            try
            {
                // 请求开始处先隔离工程侧编辑器回调（T1/T2/T3 通用）。
                // 恢复不在这里做，而是等退出 Play 回到编辑模式之后（见 AuditCallbackIsolation 注释）。
                AuditCallbackIsolation.Install(ctx);
                tool.Begin(ctx);
            }
            catch (Exception e)
            {
                var real = AuditUtil.Unwrap(e);
                ctx.Status.Error("初始化失败：" + real.Message);
                ctx.Status.Log("初始化失败\n" + real.ToString());
                Stop(true);
                return;
            }
            EditorApplication.update -= Pump;
            EditorApplication.update += Pump;
            ctx.Status.Running("0/?", "开始运行 " + tool.ToolId);
        }

        private static void Pump()
        {
            if (_tool == null) { EditorApplication.update -= Pump; return; }
            try
            {
                if (_ctx.TimedOut) throw new TimeoutException("运行超时（可用请求字段 timeout_seconds 放宽）");
                if (_tool.RequiresPlayMode && !EditorApplication.isPlaying) throw new Exception("Play 模式已退出，任务中断");

                if (_tool.Tick())
                {
                    // T-13：哨兵未过 / 回读断言不一致 → 整批 aborted（不是 done，也不是 error）：
                    // 工具本身没崩，是「这批数据不可信」，state_*.json / states.json 仍保留。
                    if (!string.IsNullOrEmpty(_ctx.AbortReason))
                    {
                        _ctx.Status.Aborted("aborted：" + _ctx.AbortReason);
                        _ctx.Status.Log("批次 aborted：" + _ctx.AbortReason);
                    }
                    else
                    {
                        _ctx.Status.Done("100%", "完成");
                    }
                    Stop(true);
                }
            }
            catch (Exception e)
            {
                var real = AuditUtil.Unwrap(e);
                _ctx.Status.Error("运行失败：" + real.Message);
                _ctx.Status.Log("运行失败\n" + real.ToString());
                Stop(true);
            }
        }

        /// <summary>收尾。runCleanup=false 用于「还没 Begin 就失败」的情形。</summary>
        private static void Stop(bool runCleanup)
        {
            var tool = _tool;
            var ctx = _ctx;
            _tool = null;
            _ctx = null;
            EditorApplication.update -= Pump;

            if (tool != null && runCleanup)
            {
                try { tool.Cleanup(); }
                catch (Exception e)
                {
                    var real = AuditUtil.Unwrap(e);
                    if (ctx != null)
                    {
                        ctx.Status.Error("清理临时改动时出错（可能有 layer/enabled 没恢复）：" + real.Message);
                        ctx.Status.Log("Cleanup 失败\n" + real.ToString());
                    }
                    Debug.LogError("[AvatarAudit] Cleanup 失败: " + real);
                }
            }

            // 回调隔离：Play 模式下保持摘除到 EnteredEditMode（onPlayModeChanged 里恢复）；编辑模式立即恢复。
            try { AuditCallbackIsolation.Cleanup(); }
            catch (Exception e) { Debug.LogError("[AvatarAudit] 解除回调隔离失败: " + AuditUtil.Unwrap(e)); }
        }

        private static void OnPlayModeChanged(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.EnteredPlayMode) TryResumePending();
            else if (change == PlayModeStateChange.ExitingPlayMode && _tool != null && _tool.RequiresPlayMode)
            {
                _ctx.Status.Error("Play 模式在任务完成前退出");
                Stop(true);
            }
        }

        private static void TryResumePending()
        {
            if (_tool != null) return;
            string json = SessionState.GetString(PendingKey, null);
            if (string.IsNullOrEmpty(json)) return;
            if (!EditorApplication.isPlaying) return;
            SessionState.EraseString(PendingKey);
            StartFromJson(json);
        }
    }

    #endregion
}
