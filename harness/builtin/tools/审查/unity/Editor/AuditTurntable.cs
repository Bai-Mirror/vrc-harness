// 【项目沉淀】
// 适用素体：无关（只读场景 + 临时相机/RT，改的 enabled 与 sharedMaterials 都在 finally 里恢复）。
// 用途：T3 环绕渲图 + 透明排序检测（第二版：按子网格候选 + 透光率模型）。
//   1) 对每个目标骨骼，按「方位 × 仰角」绕拍，Camera.Render() 到 RenderTexture 再读回存 PNG，
//      每张的相机位置/朝向/FOV 写进 shots.json（与第一版一致）；
//   2) 对半透明候选做数值化的排序检测。候选单位从「整个渲染器」改成 (渲染器 R, 子网格序号 k)：
//      只取 sharedMaterials[k].renderQueue > transparent_queue_min（默认 2501）的槽。
//      为什么：第一版以渲染器为单位，掩码是整个渲染器的轮廓，其中大部分是不透明子网格（头发本体），
//      不透明物体挡住后面的东西本来就应该看不见，于是「消失率」被抬到 0.97，全是误报（见任务 I）。
//   3) 每个候选、每个视角渲 M / C0 / C1 / B / A 五张：
//      M  = 只让 R 可见，第 k 槽 = FlatColor 纯白，其余槽 = Invisible，背景黑 → 非黑像素 = 掩码；
//      C0 = 只让 R 可见，第 k 槽 = 原材质，其余槽 = Invisible，背景纯黑；
//      C1 = 同上，背景纯白 → 每像素透光率 t = clamp((C1 - C0) 三通道平均, 0, 1)；
//      B  = 全场景正常，只有第 k 槽 = Invisible，背景 = 请求 bg；
//      A  = 全场景正常，背景 = 请求 bg（就是环绕图那一张）。
//   4) 判定只在「掩码内 && t >= t_min(0.15)」的像素里做：
//      behind  = B 与 bg 的色差 > ε（第 k 槽后面确实有东西）；
//      vanished= behind && |A - (C0 + t·bg)| < ε（A 看起来就像后面是背景）
//                       && |A - (C0 + t·B)| > ε（和正确混合结果明显不同）；
//      消失率 = vanished / behind（behind < min_behind_px 记 null）；
//      model_error_p50 = median(|A - (C0 + t·B)|)（t >= t_min 且不 vanished）——用来发现线性模型不适用的
//      着色器（Refraction / GrabPass / 加色类）。
//   5) flagged 的记录再做一次 ID 渲染：给除 R 以外的每个可见渲染器分配唯一颜色（FlatColor），
//      在 B 条件（R 关掉）渲一张 ID 图，统计 vanished 像素里各渲染器的占比，输出前 3 名 vanished_owners。
//
// 为什么用「|A − (C0 + t·bg)| < ε」而不是「A 接近背景色」：
//   当第 k 槽正确地叠在有内容的背景上时 A ≈ C0 + t·B；只有当后面的东西被顶掉、A 退化成
//   「第 k 槽 + 背景」时才会 ≈ C0 + t·bg。两个条件同时成立才判 vanished，避免「槽本身就是黑的 /
//   背景恰好同色」这类单条件误判。
//
// 为什么每步都 try/finally 恢复 enabled / sharedMaterials / camera：
//   这些都是场景对象 / 相机上的持久属性；漏恢复会让后续视角、后续候选、甚至整个工程审查全部出错，
//   而且 T3 允许在编辑模式跑，出错不恢复就等于改了工程文件。
//
// 为什么不调 EditorSceneManager.MarkSceneDirty / 不保存场景：
//   本工具只读；临时改动在 finally 还原。详见 审查/docs/selfcheck-restore.md「临时改动 → 恢复」对照表。

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AvatarAudit
{
    public sealed class AuditTurntable : IAuditTool
    {
        public string ToolId { get { return "turntable"; } }
        public bool RequiresPlayMode { get { return false; } }
        public int DefaultTimeoutSeconds { get { return 3600; } }

        private sealed class TargetSpec
        {
            public string Bone;
            public float Radius;
            public string FileBase;
            public Transform Transform;
        }

        private sealed class ShotJob
        {
            public TargetSpec Target;
            public int Az;
            public int El;
        }

        /// <summary>候选 = (渲染器, 子网格槽)。第一版是整个渲染器，误报来源见文件头。</summary>
        private sealed class Candidate
        {
            public Renderer Renderer;
            public string Path;
            public int Submesh;
            public string MaterialName;
            public int RenderQueue;
            public List<string> MaterialNames = new List<string>();
            public List<int> Queues = new List<int>();
            public string SlotNote;
        }

        /// <summary>固定桶中位数：1024 桶覆盖 [0,1]，避免每帧排序几十万个 float。</summary>
        private sealed class Histogram
        {
            private const int Bins = 1024;
            private readonly int[] _h = new int[Bins];
            private int _n;

            public void Add(float v)
            {
                int b = (int)(Mathf.Clamp01(v) * (Bins - 1) + 0.5f);
                _h[b]++; _n++;
            }

            public bool HasData { get { return _n > 0; } }

            public double P50()
            {
                if (_n == 0) return 0.0;
                int half = _n / 2, c = 0;
                for (int i = 0; i < Bins; i++)
                {
                    c += _h[i];
                    if (c >= half) return (double)i / (Bins - 1);
                }
                return 1.0;
            }
        }

        private static readonly Color32 Black = new Color32(0, 0, 0, 255);

        private AuditContext _ctx;
        private GameObject _avatar;
        private Animator _anim;

        private int _size = 1024;
        private Color _bg = new Color(0f, 1f, 0f, 1f);
        private float _fov = 30f;
        private bool _transparency = true;
        private float _vanishThreshold = 0.05f;
        private float _colorEps = 0.03f;             // 每通道 0.03（0–1 空间）
        private float _epsByte;                      // 0.03*255，直接和 Color32 的字节差比
        private float _tMin = 0.15f;                 // 只统计透光率 >= 此值的像素
        private int _transparentQueueMin = 2501;     // 透明槽分界
        private int _maskLayer = 31;                 // 仅保留在输出里说明；第二版改用 enabled 隔离
        private object _gmModule;
        private bool _gmCullingWasOn;
        private int _saveFlaggedLimit = 60;
        private int _minMaskPixels = 200;
        private int _minBehindPixels = 100;

        private GameObject _camGo;
        private Camera _cam;
        private RenderTexture _rt;
        private RenderTexture _idRt;
        private Texture2D _readTex;
        private Texture2D _saveTex;
        private int _originalMask;

        private Color32[] _pixA;
        private Color32[] _pixB;
        private Color32[] _pixC0;
        private Color32[] _pixC1;
        private Color32[] _pixM;
        private Color32[] _pixId;
        private byte[] _vanFlags;

        private Shader _flatShader;
        private Material _flatWhiteMat;
        private Material _invisibleMat;
        private Material[] _idMats;

        private Renderer[] _allRenderers = new Renderer[0];
        private bool[] _enabledSnapshot = new bool[0];
        private Dictionary<Renderer, int> _rendererIndex = new Dictionary<Renderer, int>();
        private int _isoDepth;

        // 任务 U：渲图前的渲染器过滤（only_renderers / hide_renderers），按 GameObject 名或路径子串匹配。
        private readonly List<string> _onlyRenderers = new List<string>();
        private readonly List<string> _hideRenderers = new List<string>();
        private bool _viewFilterApplied;
        private readonly List<Renderer> _viewFilterRenderers = new List<Renderer>();
        private readonly List<bool> _viewFilterOriginalEnabled = new List<bool>();
        private readonly List<object> _viewFilterLog = new List<object>();

        private readonly List<TargetSpec> _targets = new List<TargetSpec>();
        private readonly List<ShotJob> _jobs = new List<ShotJob>();
        private readonly List<Candidate> _candidates = new List<Candidate>();
        private readonly List<object> _shotRecords = new List<object>();
        private readonly List<object> _transparencyRecords = new List<object>();
        private readonly List<object> _savedImages = new List<object>();

        private int _jobIndex;
        private int _recordIndex;
        private int _flaggedCount;
        private bool _finished;

        // ------------------------------------------------------------------ Begin

        public void Begin(AuditContext ctx)
        {
            _ctx = ctx;
            var avatarName = ctx.S("avatar");
            _avatar = AuditAvatar.Resolve(avatarName);
            ctx.Avatar = _avatar;
            _anim = _avatar.GetComponent<Animator>();
            ctx.Animator = _anim;

            // GM 的 simulate culling 如果开着，它会按「场景相机到头像的距离」把全部 renderer.enabled 置 false，
            // 渲出来会是一片空。T1 跑完会把该开关恢复成原值，所以 T3 必须自己也关一次。
            _gmModule = GmgBridge.GetControlledModule(_avatar);
            if (_gmModule != null)
            {
                bool on;
                if (GmgBridge.TryGetSimulateCulling(_gmModule, out on) && on
                    && GmgBridge.TrySetSimulateCulling(_gmModule, false))
                {
                    _gmCullingWasOn = true;
                    ctx.Warn("GM 的 simulateCulling 原本是开的，T3 期间临时关闭（结束恢复）。");
                }
            }

            _size = Mathf.Clamp(ctx.I("size", 1024), 64, 4096);
            _bg = ParseColor(ctx.A("bg"), new Color(0f, 1f, 0f, 1f));
            _fov = Mathf.Clamp((float)ctx.N("fov", 30), 1f, 170f);
            _transparency = ctx.B("transparency_check", true);
            _vanishThreshold = Mathf.Clamp01((float)ctx.N("vanish_threshold", 0.05));
            _colorEps = Mathf.Clamp((float)ctx.N("color_epsilon", 0.03), 0.001f, 0.5f);
            _epsByte = _colorEps * 255f;
            _tMin = Mathf.Clamp01((float)ctx.N("t_min", 0.15));
            _transparentQueueMin = Mathf.Clamp(ctx.I("transparent_queue_min", 2501), 0, 5000);
            _maskLayer = Mathf.Clamp(ctx.I("mask_layer", 31), 0, 31);
            _saveFlaggedLimit = Mathf.Max(0, ctx.I("save_flagged_limit", 60));
            _minMaskPixels = Mathf.Max(1, ctx.I("min_mask_px", 200));
            _minBehindPixels = Mathf.Max(1, ctx.I("min_behind_px", 100));
            // 任务 U：只渲/隐藏指定渲染器（按 GameObject 名或路径子串匹配；两个列表都作用在「渲染前」的可见集合上）。
            ParseStringList(ctx.A("only_renderers"), _onlyRenderers);
            ParseStringList(ctx.A("hide_renderers"), _hideRenderers);

            BuildTargets(ctx);
            BuildJobs(ctx);
            BuildCamera();
            PrepareTransparency();
            ApplyViewFilter();          // 任务 U：必须在 CollectCandidates 之前，隐藏的渲染器不进透明候选
            CollectCandidates();

            if (_jobs.Count == 0) throw new Exception("没有可拍的视角（targets 全部解析失败？检查骨骼名是否正确）");
            ctx.Status.Log("T3 起始：头像=" + _avatar.name + "，目标 " + _targets.Count + " 个，视角 " + _jobs.Count
                + " 个，分辨率 " + _size + "，(渲染器,子网格) 半透明候选 " + _candidates.Count + " 个（queue>"
                + _transparentQueueMin + "），透明检测=" + _transparency);
        }

        private static Color ParseColor(List<object> arr, Color def)
        {
            if (arr == null || arr.Count < 3) return def;
            return new Color(
                Mathf.Clamp01(AuditUtil.ToFloat(arr[0])),
                Mathf.Clamp01(AuditUtil.ToFloat(arr[1])),
                Mathf.Clamp01(AuditUtil.ToFloat(arr[2])),
                1f);
        }

        private void BuildTargets(AuditContext ctx)
        {
            var arr = ctx.A("targets");
            if (arr.Count == 0)
            {
                AddTarget("Head", 0.45f);
                AddTarget("Chest", 0.8f);
                AddTarget("LeftFoot", 0.4f);
                AddTarget("RightFoot", 0.4f);
            }
            else
            {
                foreach (var item in arr)
                {
                    var o = item as JsonObject;
                    if (o == null) continue;
                    var bone = AuditJson.Str(o, "bone", null);
                    if (string.IsNullOrEmpty(bone)) continue;
                    AddTarget(bone, (float)AuditJson.Num(o, "radius", 0.45));
                }
            }

            // 同名骨骼出现两次时文件名会互相覆盖，补 _t<序号>
            var counts = new Dictionary<string, int>();
            foreach (var t in _targets) counts[t.Bone] = (counts.ContainsKey(t.Bone) ? counts[t.Bone] : 0) + 1;
            for (int i = 0; i < _targets.Count; i++)
            {
                var t = _targets[i];
                t.FileBase = AuditUtil.SafeFileName(t.Bone) + (counts[t.Bone] > 1 ? "_t" + i : "");
            }
        }

        private void AddTarget(string bone, float radius)
        {
            var t = ResolveBone(bone);
            if (t == null)
            {
                _ctx.Warn("目标骨骼 '" + bone + "' 解析不到（名字要能对上 HumanBodyBones 枚举），该目标已跳过");
                return;
            }
            var spec = new TargetSpec();
            spec.Bone = bone;
            spec.Radius = radius > 0.01f ? radius : 0.45f;
            spec.Transform = t;
            _targets.Add(spec);
        }

        private Transform ResolveBone(string name)
        {
            if (_anim != null)
            {
                HumanBodyBones hb;
                bool ok;
                try { ok = Enum.TryParse<HumanBodyBones>(name, true, out hb); }
                catch { ok = false; hb = HumanBodyBones.Hips; }
                if (ok)
                {
                    var t = _anim.GetBoneTransform(hb);
                    if (t != null) return t;
                }
            }
            // 退路：按名字在头像层级里找（非人形 / 自定义骨骼名）
            var all = _avatar.GetComponentsInChildren<Transform>(true);
            foreach (var t in all) if (string.Equals(t.name, name, StringComparison.Ordinal)) return t;
            return null;
        }

        private void BuildJobs(AuditContext ctx)
        {
            int azCount = Mathf.Clamp(ctx.I("azimuths", 8), 1, 72);
            var azSet = new List<int>();
            for (int i = 0; i < azCount; i++)
            {
                int az = Mathf.RoundToInt(i * 360f / azCount);
                if (!azSet.Contains(az)) azSet.Add(az);
            }

            var elArr = ctx.A("elevations");
            var elSet = new List<int>();
            if (elArr.Count == 0) elSet.AddRange(new[] { -20, 0, 35 });
            else foreach (var v in elArr) elSet.Add(Mathf.Clamp(Mathf.RoundToInt(AuditUtil.ToFloat(v)), -89, 89));

            foreach (var t in _targets)
                foreach (var el in elSet)
                    foreach (var az in azSet)
                    {
                        var job = new ShotJob();
                        job.Target = t;
                        job.Az = az;
                        job.El = el;
                        _jobs.Add(job);
                    }
        }

        private void BuildCamera()
        {
            _camGo = new GameObject("AvatarAudit_Camera");
            _camGo.hideFlags = HideFlags.HideAndDontSave;
            _cam = _camGo.AddComponent<Camera>();
            _cam.enabled = false;                       // 只手动 Render；enabled=true 会被 GM 认成主相机
            _cam.clearFlags = CameraClearFlags.SolidColor;
            _cam.backgroundColor = _bg;
            _cam.fieldOfView = _fov;
            _cam.nearClipPlane = 0.01f;
            _cam.farClipPlane = 1000f;
            _cam.allowHDR = false;
            _cam.allowMSAA = false;
            _cam.useOcclusionCulling = false;           // 固定行为，避免场景烘焙的遮挡剔除让两张图不一致
            _cam.stereoTargetEye = StereoTargetEyeMask.None;

            _originalMask = ResolveCullingMask(_ctx);
            _cam.cullingMask = _originalMask;

            _rt = new RenderTexture(_size, _size, 24, RenderTextureFormat.ARGB32);
            _rt.antiAliasing = 1;                       // MSAA 会把边缘混色，干扰逐像素比较
            _rt.name = "AvatarAudit_RT";
            _rt.Create();
            _cam.targetTexture = _rt;

            // ID 图单独用 Linear RT：不经过 sRGB 编码，SetVector 写入的字节读回来就是原值，
            // 解码渲染器身份时不必猜项目是 Gamma 还是 Linear 色彩空间。
            _idRt = new RenderTexture(_size, _size, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.Linear);
            _idRt.antiAliasing = 1;
            _idRt.name = "AvatarAudit_IdRT";
            _idRt.Create();

            _readTex = new Texture2D(_size, _size, TextureFormat.RGBA32, false);
            _readTex.name = "AvatarAudit_Read";
            int n = _size * _size;
            _pixA = new Color32[n];
            _pixB = new Color32[n];
            _pixC0 = new Color32[n];
            _pixC1 = new Color32[n];
            _pixM = new Color32[n];
            _pixId = new Color32[n];
            _vanFlags = new byte[n];
        }

        /// <summary>
        /// 用场景里主相机的 cullingMask 当「全部渲」的口径；没有相机时退回「除内置 UI 层外全部」。
        /// 请求里给了 culling_mask 就用它（头像被放在非默认层、或场景相机裁掉了某些层时需要）。
        /// </summary>
        private int ResolveCullingMask(AuditContext ctx)
        {
            if (ctx.Request.Has("culling_mask"))
            {
                int m = ctx.I("culling_mask", ~0);
                ctx.Status.Log("使用请求指定的 culling_mask=" + m);
                return m;
            }
            var cams = Camera.allCameras;
            foreach (var c in cams)
            {
                if (c == null || c == _cam) continue;
                if (!c.isActiveAndEnabled || c.targetDisplay != 0) continue;
                return c.cullingMask;
            }
            _ctx.Warn("场景里没有可用的主相机，T3 的 cullingMask 退回到「除内置 UI 层(5)外全部」");
            return ~(1 << 5);
        }

        private static Shader FindShader(string name)
        {
            try { return Shader.Find(name); }
            catch { return null; }
        }

        private Material CreateMat(Shader shader, string matName)
        {
            var m = new Material(shader);
            m.name = matName;
            m.hideFlags = HideFlags.HideAndDontSave;
            return m;
        }

        private void PrepareTransparency()
        {
            if (!_transparency) return;

            _flatShader = FindShader("Hidden/AvatarAudit/FlatColor");
            var invisShader = FindShader("Hidden/AvatarAudit/Invisible");
            if (_flatShader == null || invisShader == null)
            {
                _transparency = false;
                _ctx.Warn("找不到 AvatarAudit 的 FlatColor / Invisible 着色器，透明检测已关闭。"
                    + "部署时要把 AvatarAuditFlat.shader 与 AvatarAuditInvisible.shader 和 .cs 一起放进 "
                    + "Assets/Editor/AvatarAudit/（Shader.Find 在编辑器里按名字查找）。");
                return;
            }

            _flatWhiteMat = CreateMat(_flatShader, "AvatarAudit_FlatWhite");
            _flatWhiteMat.SetVector("_Color", new Vector4(1f, 1f, 1f, 1f));
            _invisibleMat = CreateMat(invisShader, "AvatarAudit_Invisible");

            BuildAllRenderers();
        }

        /// <summary>
        /// 缓存当前场景里全部 active 渲染器：M/C0/C1 要「只让 R 可见」，靠逐个 enabled 开关实现
        /// （不再用 layer + cullingMask，避免同层物体混入掩码，也避免动 layer 这个持久属性）。
        /// 同时给每个渲染器分配一个唯一 ID 颜色，供 flagged 记录的 vanished_owners 一次渲出。
        /// </summary>
        private void BuildAllRenderers()
        {
            var all = Resources.FindObjectsOfTypeAll<Renderer>();
            var list = new List<Renderer>();
            foreach (var rr in all)
            {
                if (rr == null) continue;
                var go = rr.gameObject;
                if (go == null) continue;
                if (EditorUtility.IsPersistent(go)) continue;   // 预制体资产
                if (!go.scene.IsValid()) continue;              // 不在任何场景里
                if (!go.activeInHierarchy) continue;
                list.Add(rr);
            }
            list.Sort((a, b) => string.CompareOrdinal(AuditUtil.ScenePath(a.transform), AuditUtil.ScenePath(b.transform)));
            _allRenderers = list.ToArray();
            _enabledSnapshot = new bool[_allRenderers.Length];
            _idMats = new Material[_allRenderers.Length];
            _rendererIndex = new Dictionary<Renderer, int>(_allRenderers.Length);
            for (int i = 0; i < _allRenderers.Length; i++)
            {
                _rendererIndex[_allRenderers[i]] = i;
                int v = i + 1;   // 0 留给背景黑，渲染器从 1 起编号
                var mat = CreateMat(_flatShader, "AvatarAudit_Id" + i);
                mat.SetVector("_Color", new Vector4(
                    (v & 0xFF) / 255f, ((v >> 8) & 0xFF) / 255f, ((v >> 16) & 0xFF) / 255f, 1f));
                _idMats[i] = mat;
            }
        }

        private static Mesh GetMesh(Renderer r)
        {
            var smr = r as SkinnedMeshRenderer;
            if (smr != null) return smr.sharedMesh;
            var mf = r.GetComponent<MeshFilter>();
            if (mf != null) return mf.sharedMesh;
            return null;
        }

        // ------------------------------------------------------------------ 任务 U：渲图渲染器过滤

        /// <summary>把请求数组解析成字符串列表；元素可以是字符串，也可以是 {name|path|renderer} 对象。</summary>
        private static void ParseStringList(List<object> arr, List<string> dest)
        {
            dest.Clear();
            if (arr == null) return;
            for (int i = 0; i < arr.Count; i++)
            {
                string s = arr[i] as string;
                if (s == null)
                {
                    var o = arr[i] as JsonObject;
                    if (o != null)
                    {
                        s = AuditJson.Str(o, "name", null);
                        if (string.IsNullOrEmpty(s)) s = AuditJson.Str(o, "path", null);
                        if (string.IsNullOrEmpty(s)) s = AuditJson.Str(o, "renderer", null);
                    }
                }
                if (string.IsNullOrEmpty(s)) continue;
                s = s.Trim();
                if (s.Length > 0 && !dest.Contains(s)) dest.Add(s);
            }
        }

        /// <summary>
        /// 任务 U：按 only_renderers / hide_renderers 设置渲染器的 enabled（在 CollectCandidates 之前调）。
        /// 语义：only 非空 → 只有匹配它的才显示；hide 非空 → 再把这批隐藏。
        /// 匹配按 GameObject 名 / 相对头像的层级路径 / 场景完整路径做**子串**匹配（不区分大小写）。
        /// 原始 enabled 存在 _viewFilterOriginalEnabled，Cleanup 里 RestoreViewFilter 还原。
        /// </summary>
        private void ApplyViewFilter()
        {
            if (_onlyRenderers.Count == 0 && _hideRenderers.Count == 0) return;

            var list = new List<Renderer>();
            var seen = new HashSet<Renderer>();
            foreach (var rr in Resources.FindObjectsOfTypeAll<Renderer>())
            {
                if (rr == null) continue;
                var go = rr.gameObject;
                if (go == null || EditorUtility.IsPersistent(go) || !go.scene.IsValid()) continue;
                if (seen.Add(rr)) list.Add(rr);
            }
            var avatarRenderers = _avatar.GetComponentsInChildren<Renderer>(true);
            for (int i = 0; i < avatarRenderers.Length; i++)
            {
                var rr = avatarRenderers[i];
                if (rr != null && seen.Add(rr)) list.Add(rr);
            }
            list.Sort((a, b) => string.CompareOrdinal(AuditUtil.ScenePath(a.transform), AuditUtil.ScenePath(b.transform)));

            var onlyMatched = new HashSet<string>(StringComparer.Ordinal);
            var hideMatched = new HashSet<string>(StringComparer.Ordinal);
            int kept = 0, hidden = 0;
            for (int i = 0; i < list.Count; i++)
            {
                var rr = list[i];
                _viewFilterRenderers.Add(rr);
                _viewFilterOriginalEnabled.Add(rr.enabled);

                bool keep = rr.enabled;
                if (_onlyRenderers.Count > 0) keep = MatchesAny(rr, _onlyRenderers, onlyMatched);
                if (keep && _hideRenderers.Count > 0 && MatchesAny(rr, _hideRenderers, hideMatched)) keep = false;

                rr.enabled = keep;
                if (keep) kept++; else hidden++;
            }
            _viewFilterApplied = true;

            for (int i = 0; i < _onlyRenderers.Count; i++)
                if (!onlyMatched.Contains(_onlyRenderers[i]))
                    _ctx.Warn("only_renderers 里的 '" + _onlyRenderers[i] + "' 没匹配到任何渲染器（按 GameObject 名或路径子串）。");
            for (int i = 0; i < _hideRenderers.Count; i++)
                if (!hideMatched.Contains(_hideRenderers[i]))
                    _ctx.Warn("hide_renderers 里的 '" + _hideRenderers[i] + "' 没匹配到任何渲染器（按 GameObject 名或路径子串）。");

            var log = new JsonObject();
            log.Set("only_renderers", _onlyRenderers.Cast<object>().ToList());
            log.Set("hide_renderers", _hideRenderers.Cast<object>().ToList());
            log.Set("only_matched", onlyMatched.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList());
            log.Set("hide_matched", hideMatched.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList());
            log.Set("visible_after", kept);
            log.Set("hidden_after", hidden);
            _viewFilterLog.Add(log);
            _ctx.Status.Log("T3 渲染器过滤：only=[" + string.Join(",", _onlyRenderers.ToArray())
                + "] hide=[" + string.Join(",", _hideRenderers.ToArray()) + "] → 可见 " + kept + " / 隐藏 " + hidden);
        }

        private bool MatchesAny(Renderer r, List<string> pats, HashSet<string> matched)
        {
            string name = r.gameObject != null ? r.gameObject.name : null;
            string rel = AuditUtil.RelPath(_avatar.transform, r.transform);
            string scene = AuditUtil.ScenePath(r.transform);
            for (int i = 0; i < pats.Count; i++)
            {
                string p = pats[i];
                if (ContainsIgnoreCase(name, p) || ContainsIgnoreCase(rel, p) || ContainsIgnoreCase(scene, p))
                {
                    matched.Add(p);
                    return true;
                }
            }
            return false;
        }

        private static bool ContainsIgnoreCase(string s, string sub)
        {
            if (string.IsNullOrEmpty(s) || string.IsNullOrEmpty(sub)) return false;
            return s.IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        /// <summary>还原 ApplyViewFilter 改过的 enabled（幂等）。</summary>
        private void RestoreViewFilter()
        {
            if (!_viewFilterApplied) return;
            for (int i = 0; i < _viewFilterRenderers.Count; i++)
            {
                var rr = _viewFilterRenderers[i];
                if (rr != null) rr.enabled = _viewFilterOriginalEnabled[i];
            }
            _viewFilterRenderers.Clear();
            _viewFilterOriginalEnabled.Clear();
            _viewFilterApplied = false;
        }

        /// <summary>
        /// 逐 (渲染器, 子网格槽) 收集候选：槽的 renderQueue > transparent_queue_min。
        /// Unity 的材质→子网格映射（写进 SlotNote，供输出核对）：
        ///   子网格 i 使用 mats[min(i, mats.Length-1)]；
        ///   所以 mats.Length > subMeshCount 时多出的材质槽根本不会被渲染（记警告并跳过）；
        ///   mats.Length < subMeshCount 时最后一个材质槽覆盖它之后的全部子网格。
        /// </summary>
        private void CollectCandidates()
        {
            var list = new List<Candidate>();
            var renderers = _avatar.GetComponentsInChildren<Renderer>(true);
            foreach (var r in renderers)
            {
                if (r == null) continue;
                if (!r.gameObject.activeInHierarchy || !r.enabled) continue;
                Material[] mats;
                try { mats = r.sharedMaterials; } catch { continue; }
                if (mats == null) continue;

                var mesh = GetMesh(r);
                int subCount = mesh != null ? Mathf.Max(1, mesh.subMeshCount) : Mathf.Max(1, mats.Length);
                int usedSlots = Mathf.Min(mats.Length, subCount);
                string path = AuditUtil.RelPath(_avatar.transform, r.transform);

                if (mats.Length > subCount)
                    _ctx.Warn("渲染器 " + path + " 的材质数组有 " + mats.Length + " 槽，但网格只有 " + subCount
                        + " 个子网格：第 " + subCount + " 槽及以后不会被渲染，已忽略（Unity 规则）。");
                if (mats.Length < subCount)
                    _ctx.Warn("渲染器 " + path + " 的材质只有 " + mats.Length + " 槽，但网格有 " + subCount
                        + " 个子网格：最后一个材质槽（#" + (mats.Length - 1) + "）会覆盖第 " + (mats.Length - 1)
                        + ".." + (subCount - 1) + " 个子网格，掩码与判定把它们合并计。");

                bool layerCulled = (_originalMask & (1 << r.gameObject.layer)) == 0;
                if (layerCulled)
                    _ctx.Warn("渲染器 " + path + " 所在 layer(" + r.gameObject.layer
                        + ") 不在 culling_mask 内，A/B 不会包含它，该渲染器的检测结果不可信。");

                var names = new List<string>();
                var queues = new List<int>();
                foreach (var m in mats)
                {
                    if (m == null) { names.Add(null); queues.Add(-1); continue; }
                    names.Add(m.name);
                    queues.Add(m.renderQueue);
                }

                for (int k = 0; k < mats.Length; k++)
                {
                    var m = mats[k];
                    if (m == null) continue;
                    if (k >= usedSlots) continue;                       // 多余材质槽，不参与渲染
                    if (m.renderQueue <= _transparentQueueMin) continue;

                    var c = new Candidate();
                    c.Renderer = r;
                    c.Path = path;
                    c.Submesh = k;
                    c.MaterialName = m.name;
                    c.RenderQueue = m.renderQueue;
                    c.MaterialNames = names;
                    c.Queues = queues;
                    if (k == mats.Length - 1 && mats.Length < subCount)
                        c.SlotNote = "最后一个材质槽覆盖子网格 " + k + ".." + (subCount - 1) + "，掩码为它们的并集";
                    list.Add(c);
                }
            }
            _candidates.AddRange(list.OrderBy(x => x.Path, StringComparer.Ordinal).ThenBy(x => x.Submesh));
        }

        // ------------------------------------------------------------------ Tick

        public bool Tick()
        {
            if (_finished) return true;
            if (_jobIndex >= _jobs.Count)
            {
                Finish();
                _finished = true;
                return true;
            }

            var job = _jobs[_jobIndex];
            ProcessShot(job);
            _jobIndex++;
            _ctx.Status.Running(_jobIndex + "/" + _jobs.Count,
                "渲 " + job.Target.Bone + " az" + job.Az + " el" + job.El);
            return false;
        }

        private void ProcessShot(ShotJob job)
        {
            var targetPos = job.Target.Transform.position;
            var basis = _avatar.transform;

            // 方位角从角色正前方起算（正前方 = avatar.transform.forward），这样同一套视角在不同工程间可比
            float azRad = job.Az * Mathf.Deg2Rad;
            float elRad = job.El * Mathf.Deg2Rad;
            Vector3 dir = basis.forward * (Mathf.Cos(elRad) * Mathf.Cos(azRad))
                        + basis.right * (Mathf.Cos(elRad) * Mathf.Sin(azRad))
                        + basis.up * (Mathf.Sin(elRad));
            dir.Normalize();

            var camPos = targetPos + dir * job.Target.Radius;
            _cam.transform.position = camPos;
            _cam.transform.LookAt(targetPos, basis.up);
            _cam.fieldOfView = _fov;
            _cam.cullingMask = _originalMask;

            string fileName = job.Target.FileBase + "_az" + job.Az + "_el" + job.El + ".png";
            _cam.backgroundColor = _bg;
            RenderToBuffer(_pixA, _rt);
            SavePng(_ctx.OutPath(fileName), _pixA);

            var rec = new JsonObject();
            rec.Set("bone", job.Target.Bone);
            rec.Set("file", fileName);
            rec.Set("az", job.Az);
            rec.Set("el", job.El);
            rec.Set("radius", (double)job.Target.Radius);
            rec.Set("fov", (double)_fov);
            rec.Set("size", _size);
            rec.Set("target_world", Vec(targetPos));
            rec.Set("cam_position", Vec(camPos));
            var e = _cam.transform.rotation.eulerAngles;
            rec.Set("cam_rotation_euler", new List<object> { (double)e.x, (double)e.y, (double)e.z });
            _shotRecords.Add(rec);

            if (!_transparency || _candidates.Count == 0) return;

            foreach (var cand in _candidates)
                ProcessCandidate(job, cand, fileName);
        }

        /// <summary>把第 k 槽换成 slotMat，其余槽换成 othersMat（othersMat 为 null 时保留原材质）。</summary>
        private static Material[] BuildSlots(Material[] orig, int k, Material slotMat, Material othersMat)
        {
            var arr = new Material[orig.Length];
            for (int i = 0; i < orig.Length; i++)
                arr[i] = (i == k) ? slotMat : (othersMat != null ? othersMat : orig[i]);
            return arr;
        }

        /// <summary>只让 keep 可见：其余场景渲染器 enabled=false；相机 cullingMask 放到全开。</summary>
        private void EnterIsolation(Renderer keep)
        {
            for (int i = 0; i < _allRenderers.Length; i++)
            {
                var rr = _allRenderers[i];
                if (rr == null) continue;
                _enabledSnapshot[i] = rr.enabled;
                rr.enabled = (rr == keep);
            }
            _isoDepth++;
            _cam.cullingMask = ~0;
        }

        /// <summary>恢复 EnterIsolation 前全部的 enabled 与相机 cullingMask。幂等，可重复调用。</summary>
        private void ExitIsolation()
        {
            if (_isoDepth <= 0) return;
            _isoDepth--;
            for (int i = 0; i < _allRenderers.Length; i++)
            {
                var rr = _allRenderers[i];
                if (rr != null) rr.enabled = _enabledSnapshot[i];
            }
            _cam.cullingMask = _originalMask;
        }

        private void ProcessCandidate(ShotJob job, Candidate cand, string shotFile)
        {
            var r = cand.Renderer;
            if (r == null) return;

            Material[] origMats;
            try { origMats = r.sharedMaterials; } catch { return; }
            if (origMats == null || cand.Submesh < 0 || cand.Submesh >= origMats.Length) return;

            int maskPx = 0, behind = 0, vanished = 0;
            bool haveMask = false;
            var tHist = new Histogram();
            var errHist = new Histogram();

            try
            {
                // ---- M / C0 / C1：只让 R 可见 ----
                EnterIsolation(r);
                try
                {
                    r.sharedMaterials = BuildSlots(origMats, cand.Submesh, _flatWhiteMat, _invisibleMat);
                    _cam.backgroundColor = Color.black;
                    RenderToBuffer(_pixM, _rt);
                    maskPx = CountMaskPixels(_pixM);

                    if (maskPx >= _minMaskPixels)
                    {
                        r.sharedMaterials = BuildSlots(origMats, cand.Submesh, origMats[cand.Submesh], _invisibleMat);
                        _cam.backgroundColor = Color.black;
                        RenderToBuffer(_pixC0, _rt);
                        _cam.backgroundColor = Color.white;
                        RenderToBuffer(_pixC1, _rt);
                        haveMask = true;
                    }
                }
                finally
                {
                    ExitIsolation();
                    r.sharedMaterials = origMats;
                    _cam.backgroundColor = _bg;
                }

                // ---- B：全场景正常，只有第 k 槽隐形 ----
                if (haveMask)
                {
                    r.sharedMaterials = BuildSlots(origMats, cand.Submesh, _invisibleMat, null);
                    try
                    {
                        _cam.backgroundColor = _bg;
                        RenderToBuffer(_pixB, _rt);
                    }
                    finally
                    {
                        r.sharedMaterials = origMats;
                        _cam.backgroundColor = _bg;
                    }

                    // ---- 逐像素：只在「掩码内 && t >= t_min」统计 ----
                    Array.Clear(_vanFlags, 0, _vanFlags.Length);
                    int n = _pixA.Length;
                    for (int i = 0; i < n; i++)
                    {
                        if (!Differs(_pixM[i], Black)) continue;
                        float t = Transmittance(_pixC0[i], _pixC1[i]);
                        tHist.Add(t);
                        if (t < _tMin) continue;

                        float ar = _pixA[i].r / 255f, ag = _pixA[i].g / 255f, ab = _pixA[i].b / 255f;
                        float c0r = _pixC0[i].r / 255f, c0g = _pixC0[i].g / 255f, c0b = _pixC0[i].b / 255f;
                        float br = _pixB[i].r / 255f, bgc = _pixB[i].g / 255f, bbc = _pixB[i].b / 255f;

                        // 正确混合的期望颜色 / 「后面退化成背景」的期望颜色
                        float er = c0r + t * br, eg = c0g + t * bgc, eb = c0b + t * bbc;
                        float vr = c0r + t * _bg.r, vg = c0g + t * _bg.g, vb = c0b + t * _bg.b;
                        float dVanish = MaxDiff(ar, ag, ab, vr, vg, vb);
                        float dModel = MaxDiff(ar, ag, ab, er, eg, eb);

                        bool isBehind = Differs(_pixB[i], _bg);
                        if (isBehind) behind++;

                        if (isBehind && dVanish < _colorEps && dModel > _colorEps)
                        {
                            vanished++;
                            _vanFlags[i] = 1;
                        }
                        else
                        {
                            // model_error 覆盖全部 t>=t_min 且不 vanished 的掩码像素（含 behind=false 的）
                            errHist.Add(dModel);
                        }
                    }
                }
            }
            finally
            {
                try { r.sharedMaterials = origMats; } catch { }
                ExitIsolation();
                _cam.backgroundColor = _bg;
                _cam.cullingMask = _originalMask;
            }

            float? ratio = (haveMask && behind >= _minBehindPixels) ? (float)vanished / behind : (float?)null;
            bool flagged = ratio.HasValue && ratio.Value >= _vanishThreshold;
            List<object> owners = flagged ? ComputeVanishedOwners(cand) : null;
            EmitRecord(job, cand, shotFile, maskPx, haveMask, behind, vanished, ratio, tHist, errHist, owners);
        }

        private void EmitRecord(ShotJob job, Candidate cand, string shotFile, int maskPx, bool haveMask,
            int behind, int vanished, float? ratio, Histogram tHist, Histogram errHist, List<object> owners)
        {
            _recordIndex++;
            int idx = _recordIndex;
            bool flagged = ratio.HasValue && ratio.Value >= _vanishThreshold;

            var rec = new JsonObject();
            rec.Set("target", job.Target.Bone);
            rec.Set("az", job.Az);
            rec.Set("el", job.El);
            rec.Set("shot_file", shotFile);
            rec.Set("renderer_path", cand.Path);
            rec.Set("submesh", cand.Submesh);
            rec.Set("material", cand.MaterialName);
            rec.Set("render_queue", cand.RenderQueue);
            rec.Set("material_names", cand.MaterialNames.Cast<object>().ToList());
            rec.Set("render_queues", cand.Queues.Select(q => (object)q).ToList());
            rec.Set("mask_px", maskPx);
            rec.Set("behind_px", haveMask ? behind : 0);
            rec.Set("vanished_px", haveMask ? vanished : 0);
            rec.Set("t_p50", tHist != null && tHist.HasData ? (object)tHist.P50() : null);
            rec.Set("model_error_p50", errHist != null && errHist.HasData ? (object)errHist.P50() : null);
            rec.Set("vanish_ratio", ratio.HasValue ? (object)(double)ratio.Value : null);
            rec.Set("flagged", flagged);
            rec.Set("skipped", !haveMask);
            rec.Set("vanished_owners", owners);
            if (!haveMask)
                rec.Set("skip_reason", maskPx < _minMaskPixels
                    ? "掩码像素 " + maskPx + " < " + _minMaskPixels + "，第 " + cand.Submesh + " 槽在这个视角太小/被挡住"
                    : "未取到掩码");
            _transparencyRecords.Add(rec);

            if (!flagged) return;
            _flaggedCount++;

            string a = "tr_" + idx + "_A.png", b = "tr_" + idx + "_B.png";
            string c0 = "tr_" + idx + "_C0.png", c1 = "tr_" + idx + "_C1.png", m = "tr_" + idx + "_M.png";
            var files = new JsonObject();
            files.Set("target", job.Target.Bone);
            files.Set("az", job.Az);
            files.Set("el", job.El);
            files.Set("renderer_path", cand.Path);
            files.Set("submesh", cand.Submesh);
            files.Set("material", cand.MaterialName);
            files.Set("vanish_ratio", ratio.HasValue ? (object)(double)ratio.Value : null);

            if (_flaggedCount <= _saveFlaggedLimit)
            {
                SavePng(_ctx.OutPath(a), _pixA);
                SavePng(_ctx.OutPath(b), _pixB);
                SavePng(_ctx.OutPath(c0), _pixC0);
                SavePng(_ctx.OutPath(c1), _pixC1);
                SavePng(_ctx.OutPath(m), _pixM);
                files.Set("A", a);
                files.Set("B", b);
                files.Set("C0", c0);
                files.Set("C1", c1);
                files.Set("M", m);
                files.Set("C", c0);            // 兼容第一版字段：C 即「只有 R」那张
            }
            else
            {
                files.Set("A", null);
                files.Set("B", null);
                files.Set("C0", null);
                files.Set("C1", null);
                files.Set("M", null);
                files.Set("C", null);
                files.Set("note", "超过 save_flagged_limit=" + _saveFlaggedLimit + "，本条只留数值不留图");
            }
            _savedImages.Add(files);
        }

        /// <summary>
        /// ID 渲染：R 关掉，其余可见渲染器各给一个唯一颜色，一次渲出 ID 图；
        /// 在 vanished 像素上统计各渲染器占比，返回前 3 名 {renderer_path, share}。
        /// 解码失败（背景 / 被 R 自己的其它槽挡住的部分）不计入分母。
        /// </summary>
        private List<object> ComputeVanishedOwners(Candidate cand)
        {
            if (_idMats == null || _idMats.Length == 0) return null;

            var renderers = new List<Renderer>();
            var idxs = new List<int>();
            for (int i = 0; i < _allRenderers.Length; i++)
            {
                var rr = _allRenderers[i];
                if (rr == null || rr == cand.Renderer) continue;
                if (!rr.enabled || !rr.gameObject.activeInHierarchy) continue;
                if ((_originalMask & (1 << rr.gameObject.layer)) == 0) continue;
                renderers.Add(rr);
                idxs.Add(i);
            }
            if (renderers.Count == 0) return null;

            var saved = new List<Material[]>(renderers.Count);
            bool rWasEnabled = cand.Renderer.enabled;
            try
            {
                cand.Renderer.enabled = false;
                for (int j = 0; j < renderers.Count; j++)
                {
                    var rr = renderers[j];
                    Material[] cur = null;
                    try { cur = rr.sharedMaterials; } catch { }
                    saved.Add(cur);
                    var idMat = _idMats[idxs[j]];
                    int len = (cur != null && cur.Length > 0) ? cur.Length : 1;
                    var arr = new Material[len];
                    for (int q = 0; q < len; q++) arr[q] = idMat;
                    rr.sharedMaterials = arr;
                }
                _cam.backgroundColor = Color.black;
                _cam.cullingMask = _originalMask;
                RenderToBuffer(_pixId, _idRt);
            }
            finally
            {
                for (int j = 0; j < renderers.Count; j++)
                {
                    try { if (saved[j] != null) renderers[j].sharedMaterials = saved[j]; } catch { }
                }
                cand.Renderer.enabled = rWasEnabled;
                _cam.backgroundColor = _bg;
                _cam.cullingMask = _originalMask;
            }

            var counts = new Dictionary<int, int>();
            int total = 0;
            for (int i = 0; i < _vanFlags.Length; i++)
            {
                if (_vanFlags[i] == 0) continue;
                int ai = DecodeId(_pixId[i]);
                if (ai < 0) continue;
                total++;
                counts[ai] = (counts.ContainsKey(ai) ? counts[ai] : 0) + 1;
            }
            if (total == 0) return null;

            var outList = new List<object>();
            foreach (var kv in counts.OrderByDescending(x => x.Value).ThenBy(x => x.Key).Take(3))
            {
                var o = new JsonObject();
                o.Set("renderer_path", AuditUtil.RelPath(_avatar.transform, _allRenderers[kv.Key].transform));
                o.Set("share", Math.Round((double)kv.Value / total, 4));
                outList.Add(o);
            }
            return outList;
        }

        /// <summary>ID 颜色 = 渲染器序号 + 1（写进 RGB）；精确命中优先，边缘混色退化为最近邻。</summary>
        private int DecodeId(Color32 c)
        {
            if (c.r == 0 && c.g == 0 && c.b == 0) return -1;
            int v = c.r | (c.g << 8) | (c.b << 16);
            if (v >= 1 && v <= _allRenderers.Length) return v - 1;

            int best = -1, bestD = int.MaxValue;
            for (int i = 0; i < _allRenderers.Length; i++)
            {
                int vv = i + 1;
                int dr = c.r - (vv & 0xFF);
                int dg = c.g - ((vv >> 8) & 0xFF);
                int db = c.b - ((vv >> 16) & 0xFF);
                int d = dr * dr + dg * dg + db * db;
                if (d < bestD) { bestD = d; best = i; }
            }
            return best;
        }

        private bool Differs(Color32 a, Color32 b)
        {
            // 每通道 0.03（0–1 空间）→ 字节差阈值 7.65，不用取整，避免 0.03 被放大成 0.035
            return Mathf.Abs(a.r - b.r) > _epsByte
                || Mathf.Abs(a.g - b.g) > _epsByte
                || Mathf.Abs(a.b - b.b) > _epsByte;
        }

        private static float Transmittance(Color32 c0, Color32 c1)
        {
            float dr = (c1.r - c0.r) / 255f;
            float dg = (c1.g - c0.g) / 255f;
            float db = (c1.b - c0.b) / 255f;
            return Mathf.Clamp01((dr + dg + db) / 3f);
        }

        private static float MaxDiff(float ar, float ag, float ab, float br, float bg, float bb)
        {
            return Mathf.Max(Mathf.Abs(ar - br), Mathf.Max(Mathf.Abs(ag - bg), Mathf.Abs(ab - bb)));
        }

        private int CountMaskPixels(Color32[] pix)
        {
            int c = 0;
            for (int i = 0; i < pix.Length; i++) if (Differs(pix[i], Black)) c++;
            return c;
        }

        private void RenderToBuffer(Color32[] dest, RenderTexture rt)
        {
            _cam.targetTexture = rt;
            _cam.Render();

            var prev = RenderTexture.active;
            RenderTexture.active = rt;
            _readTex.ReadPixels(new Rect(0, 0, _size, _size), 0, 0, false);
            _readTex.Apply(false, false);
            RenderTexture.active = prev;

            // 用 GetPixelData 直接拷进复用缓冲：1024² 每张 4 MB，一次审查要渲几百张，
            // GetPixels32() 每次都新分配一个数组，GC 压力明显。
            _readTex.GetPixelData<Color32>(0).CopyTo(dest);
        }

        private void SavePng(string path, Color32[] pix)
        {
            try
            {
                if (_saveTex == null) _saveTex = new Texture2D(_size, _size, TextureFormat.RGBA32, false);
                _saveTex.SetPixels32(pix);
                _saveTex.Apply(false, false);
                var bytes = _saveTex.EncodeToPNG();
                File.WriteAllBytes(path, bytes);
            }
            catch (Exception e)
            {
                _ctx.Warn("写 PNG 失败 " + path + " ：" + e.Message);
            }
        }

        private static List<object> Vec(Vector3 v)
        {
            return new List<object> { (double)v.x, (double)v.y, (double)v.z };
        }

        // ------------------------------------------------------------------ 收尾

        private void Finish()
        {
            var shots = new JsonObject();
            shots.Set("tool", "turntable");
            shots.Set("avatar", _avatar.name);
            shots.Set("out", _ctx.OutDir);
            shots.Set("size", _size);
            shots.Set("bg", new List<object> { (double)_bg.r, (double)_bg.g, (double)_bg.b });
            shots.Set("fov", (double)_fov);
            shots.Set("culling_mask", _originalMask);
            var tl = new List<object>();
            foreach (var t in _targets)
            {
                var o = new JsonObject();
                o.Set("bone", t.Bone);
                o.Set("radius", (double)t.Radius);
                o.Set("file_base", t.FileBase);
                o.Set("world", Vec(t.Transform.position));
                tl.Add(o);
            }
            shots.Set("targets", tl);
            shots.Set("shot_count", _shotRecords.Count);
            shots.Set("shots", _shotRecords);
            // 任务 U：渲染器过滤（only_renderers / hide_renderers）实际匹配与可见数，便于事后核对。
            if (_viewFilterLog.Count > 0) shots.Set("view_filter", _viewFilterLog[0]);
            shots.Set("warnings", _ctx.Warnings.Cast<object>().ToList());
            AuditJson.WriteFile(_ctx.OutPath("shots.json"), shots);

            var tr = new JsonObject();
            tr.Set("tool", "turntable.transparency");
            tr.Set("avatar", _avatar.name);
            tr.Set("model", "per-pixel dot: t=avg(C1-C0); E=C0+t*B; vanished = |A-(C0+t*bg)|<eps && |A-E|>eps");
            tr.Set("vanish_threshold", (double)_vanishThreshold);
            tr.Set("color_epsilon", (double)_colorEps);
            tr.Set("t_min", (double)_tMin);
            tr.Set("transparent_queue_min", _transparentQueueMin);
            tr.Set("mask_layer", _maskLayer);
            tr.Set("mask_layer_used", false);
            tr.Set("min_mask_px", _minMaskPixels);
            tr.Set("min_behind_px", _minBehindPixels);
            tr.Set("color_space", QualitySettings.activeColorSpace.ToString());
            var cl = new List<object>();
            foreach (var c in _candidates)
            {
                var o = new JsonObject();
                o.Set("path", c.Path);
                o.Set("submesh", c.Submesh);
                o.Set("material", c.MaterialName);
                o.Set("render_queue", c.RenderQueue);
                o.Set("material_names", c.MaterialNames.Cast<object>().ToList());
                o.Set("render_queues", c.Queues.Select(q => (object)q).ToList());
                if (!string.IsNullOrEmpty(c.SlotNote)) o.Set("slot_note", c.SlotNote);
                cl.Add(o);
            }
            tr.Set("candidates", cl);
            tr.Set("candidate_count", _candidates.Count);
            tr.Set("record_count", _transparencyRecords.Count);
            tr.Set("flagged_count", _flaggedCount);
            tr.Set("records", _transparencyRecords);
            tr.Set("flagged_images", _savedImages);
            tr.Set("warnings", _ctx.Warnings.Cast<object>().ToList());
            AuditJson.WriteFile(_ctx.OutPath("transparency.json"), tr);

            _ctx.Status.Log("T3 完成：渲图 " + _shotRecords.Count + " 张，(渲染器,子网格)候选 " + _candidates.Count
                + " 个，透明检测 " + _transparencyRecords.Count + " 条，flagged " + _flaggedCount
                + " 条，存图 " + _savedImages.Count + " 组");
        }

        public void Cleanup()
        {
            // 恢复 T3 临时关掉的 GM 剔除开关（T1 结束时还会再恢复一次它自己那份）
            if (_gmModule != null && _gmCullingWasOn)
            {
                if (GmgBridge.TrySetSimulateCulling(_gmModule, true) && _ctx != null)
                    _ctx.Status.Log("T3 结束，已恢复 GM simulateCulling=true");
                _gmCullingWasOn = false;
            }

            // 极端情况下（异常被上层吞掉）再兜底恢复一次 enabled / materials / 相机。
            ExitIsolation();
            // 任务 U：把 only_renderers / hide_renderers 改过的 enabled 还原成进入 T3 前的原值。
            RestoreViewFilter();

            // 相机 / RT / 临时材质 / 临时纹理都是本工具 new 出来的，销毁掉；场景持久数据一个不动。
            _cam = null;
            if (_camGo != null) { SafeDestroy(_camGo); _camGo = null; }
            if (_rt != null)
            {
                try { _rt.Release(); } catch { }
                SafeDestroy(_rt);
                _rt = null;
            }
            if (_idRt != null)
            {
                try { _idRt.Release(); } catch { }
                SafeDestroy(_idRt);
                _idRt = null;
            }
            if (_readTex != null) { SafeDestroy(_readTex); _readTex = null; }
            if (_saveTex != null) { SafeDestroy(_saveTex); _saveTex = null; }
            if (_flatWhiteMat != null) { SafeDestroy(_flatWhiteMat); _flatWhiteMat = null; }
            if (_invisibleMat != null) { SafeDestroy(_invisibleMat); _invisibleMat = null; }
            if (_idMats != null)
            {
                for (int i = 0; i < _idMats.Length; i++) { if (_idMats[i] != null) SafeDestroy(_idMats[i]); }
                _idMats = null;
            }
            RenderTexture.active = null;
        }

        private static void SafeDestroy(UnityEngine.Object o)
        {
            if (o == null) return;
            try { UnityEngine.Object.DestroyImmediate(o); }
            catch (Exception e) { Debug.LogWarning("[AvatarAudit] 销毁临时对象失败: " + e.Message); }
        }
    }
}
