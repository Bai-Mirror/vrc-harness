// FP2 (`D-139` ①): render confirmation of "visible body piercing".
//
// The fit probe's ray criterion (`AvatarAudit.VisiblePiercing`) decides from geometry alone: a body vertex is a
// "visible pierce" when some garment's surface sits inside it and no garment covers it. FP1 measured that this is
// necessary but not sufficient: rays cannot see non-closed surfaces (hair cards, single-sided leaves), so a vertex
// can pass while the pixel is occupied by a garment, and a pixel can hold a NEARER body surface (the forehead in
// front of a hairline vertex), so "the body is at this pixel" does not mean "this vertex is visible".
//
// This file does the picture check. For every state it renders, from a fixed set of views (framing from bone
// height, the same specs OV1/FP1 use), a pair of RENDERER-INDEX images:
//   (a) every renderer on   -> which renderer is the frontmost surface at each pixel;
//   (b) body renderers off  -> what shows there once the body is not in the way;
// plus a depth image of (a) so "the frontmost surface is the body" can be narrowed to "the frontmost surface is
// THIS body vertex". A candidate counts only when, in at least one view:
//   frontmost is a body renderer  AND  its depth equals the candidate vertex's own depth (within a tolerance)
//   AND  with the body off the frontmost surface there is exactly the garment the ray criterion attributes it to.
// Occluded candidates (the pixel belongs to a garment) and candidates exposed only against the background (with the
// body off the pixel is background, or a different garment) do not count.
//
// GI1 (`D-143`) generalizes the same three conditions from "the body" to "the layer the candidate vertex belongs
// to": a candidate whose `Candidate.Layer` is set is a vertex of an INNER garment, the pixel's frontmost surface
// must be that inner garment, and (b) is rendered with that inner garment switched off — so the confirmation reads
// "the outer garment shows where the inner one was". The body is then not involved at all, and `bodyPaths` may be
// null. Only the layer a candidate names is switched off, one comparison pass per distinct layer; the fit stage's
// own use is unchanged (it leaves `Layer` empty).
//
// The index images go into linear ARGBFloat render targets: `_Color` is a Vector in the shader, so index values are
// written and read with no colour-space conversion, and 32-bit floats avoid 8-bit rounding at the edges.
using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;
using Object = UnityEngine.Object;

namespace AvatarAudit
{
    /// <summary>Render-confirmed "visible body piercing" (`D-139` ①, FP2).</summary>
    public static class FitRenderConfirm
    {
        public const string IdShaderName = "Hidden/AvatarAudit/FlatColor";
        public const string DepthShaderName = "Hidden/AvatarAudit/ViewDepth";
        /// <summary>How far (mm, along the view direction) the frontmost surface at a pixel may be from the
        /// candidate vertex and still be read as "this vertex is that frontmost layer". Recorded in the result and
        /// the report: it is the one number that decides who owns a pixel.</summary>
        public const float DefaultDepthToleranceMm = 2.0f;
        public const int DefaultFrameHeight = 900;
        const float BeautyMaxHeight = 640f;      // the reviewable screenshot is written downscaled
        const int MarkSize = 3;                  // half-size of the marker box drawn on the marked/screenshot images
        /// <summary>How many per-view comparison images are kept. The reading still covers every layer; the
        /// caller orders its candidates closest-first, so the kept pictures are the relevant ones.</summary>
        const int MaxEvidenceCutImages = 12;

        public sealed class Options
        {
            public bool Enabled;
            public int Height = DefaultFrameHeight;
            public float DepthToleranceMm = DefaultDepthToleranceMm;
            public int PitchDeg = 25;
            public string[] Views = AllViews();

            public static string[] AllViews()
            {
                return new[] { "front", "back", "left", "right", "front_up", "back_up" };
            }

            /// <summary>Read the request's `render_confirm` block. Absent = disabled, and the probe then writes
            /// `valid=false` so the stage reads null instead of quietly falling back to the ray count.</summary>
            public static Options FromRequest(JsonObject block)
            {
                var options = new Options();
                if (block == null) return options;
                options.Enabled = AuditJson.Bool(block, "enabled", true);
                options.Height = AuditJson.Int(block, "height", DefaultFrameHeight);
                if (options.Height < 64) options.Height = 64;
                if (options.Height > 2048) options.Height = 2048;
                options.DepthToleranceMm = (float)AuditJson.Num(block, "depth_tolerance_mm", DefaultDepthToleranceMm);
                if (options.DepthToleranceMm <= 0f) options.DepthToleranceMm = DefaultDepthToleranceMm;
                options.PitchDeg = AuditJson.Int(block, "pitch_deg", 25);
                string views = AuditJson.Str(block, "views");
                if (!string.IsNullOrEmpty(views))
                {
                    var list = new List<string>();
                    foreach (string raw in views.Split(','))
                    {
                        string name = raw.Trim();
                        if (name.Length == 0) continue;
                        if (Array.IndexOf(AllViews(), name) < 0) throw new Exception("未知的渲图视角：" + name);
                        if (!list.Contains(name)) list.Add(name);
                    }
                    if (list.Count > 0) options.Views = list.ToArray();
                }
                return options;
            }
        }

        /// <summary>One ray-criterion candidate: a body vertex the ray criterion says pokes out of
        /// <see cref="Garment"/>. <see cref="Position"/> is the vertex's world position when it was measured.</summary>
        public sealed class Candidate
        {
            public int Vertex;
            public string Region = "";
            public string Garment = "";
            /// <summary>
            /// The renderer the candidate vertex belongs to, when it is not the body. Empty means the body
            /// (`bodyPaths`): the pixel's frontmost layer must be a body renderer, and the comparison image is
            /// rendered with the body switched off. Set means a garment layer (GI1, `D-143`): the pixel's
            /// frontmost layer must be THIS renderer, and the comparison image is rendered with this renderer —
            /// and only it — switched off, so "what shows once the inner layer is gone" is the outer garment.
            /// </summary>
            public string Layer = "";
            public Vector3 Position;
            public float DepthMm;
        }

        public sealed class ViewSpec
        {
            public string Name;
            public float Yaw;
            public float Pitch;
        }

        public sealed class Result
        {
            public bool Valid;
            public string Reason;
            public int ViewCount;
            public int Candidates;
            public int Confirmed;
            public float DepthToleranceMm;
            public int FrameHeight;
            public int RejectedNotBody, RejectedDepth, RejectedGarment, OutsideFrame, MissingLayer;
            public double Milliseconds;
            public int RayVertices;
            public readonly List<string> ViewNames = new List<string>();
            public readonly Dictionary<string, int> PerGarment = new Dictionary<string, int>(StringComparer.Ordinal);
            public readonly List<JsonObject> CandidateRows = new List<JsonObject>();
            public readonly List<JsonObject> ViewRows = new List<JsonObject>();
            public readonly List<JsonObject> RendererRows = new List<JsonObject>();
            public readonly List<string> Files = new List<string>();
            public readonly List<string> Notes = new List<string>();

            /// <summary>The probe's `visible_piercing.render` block. `valid=false` -> the stage reads null.</summary>
            public JsonObject Block()
            {
                var o = new JsonObject();
                o.Set("schema", "fit-render-piercing/0.1");
                o.Set("valid", Valid);
                if (!Valid) o.Set("reason", Reason);
                o.Set("views", Valid ? (object)ViewCount : null);
                o.Set("view_names", Strings(ViewNames));
                o.Set("depth_tolerance_mm", DepthToleranceMm);
                o.Set("frame_height", FrameHeight);
                o.Set("candidates", Candidates);
                o.Set("ray_vertices", RayVertices);
                // The criterion reading: how many ray candidates survived the picture check.
                o.Set("vertices", Valid ? (object)Confirmed : null);
                o.Set("outside_frame", OutsideFrame);
                o.Set("rejected_not_body", RejectedNotBody);
                o.Set("rejected_depth", RejectedDepth);
                o.Set("rejected_garment", RejectedGarment);
                o.Set("missing_layer", MissingLayer);
                o.Set("per_garment", PerGarmentRows());
                o.Set("confirmed", CandidateRows);
                o.Set("views_detail", ViewRows);
                o.Set("renderers", RendererRows);
                o.Set("images", Strings(Files));
                o.Set("timings_ms", new Dictionary<string, object> { ["total"] = Math.Round(Milliseconds, 1) });
                o.Set("view_codes", "out=不在画面内；bg=该像素什么都没有（背景）；other=该像素最前面不是素体；"
                    + "deep=素体在最前面但不是这个顶点（深度不符）；miss=素体与深度都对，但关掉素体后那里不是它穿出的那件；"
                    + "hit=该视角确认");
                o.Set("notes", Strings(Notes));
                return o;
            }

            internal static List<object> Strings(List<string> items)
            {
                var list = new List<object>();
                for (int i = 0; i < items.Count; i++) list.Add(items[i]);
                return list;
            }

            List<object> PerGarmentRows()
            {
                var keys = new List<string>(PerGarment.Keys);
                keys.Sort(StringComparer.Ordinal);
                var rows = new List<object>();
                foreach (string key in keys)
                {
                    var row = new JsonObject();
                    row.Set("path", key);
                    row.Set("vertices", PerGarment[key]);
                    rows.Add(row);
                }
                return rows;
            }
        }

        /// <summary>Render and classify. <paramref name="outDir"/> null (or empty) skips the evidence images —
        /// the fixture uses that; the probe always writes them. <paramref name="bodyPaths"/> may be null when
        /// every candidate names its own <see cref="Candidate.Layer"/>: then no pixel is required to be body
        /// skin and the comparison pass switches off that candidate's layer instead.</summary>
        public static Result Run(GameObject avatar, Options options, List<Candidate> candidates,
            List<string> bodyPaths, string outDir, string stateId)
        {
            var result = new Result
            {
                DepthToleranceMm = options.DepthToleranceMm,
                FrameHeight = options.Height,
                Candidates = candidates != null ? candidates.Count : 0,
            };
            var clock = System.Diagnostics.Stopwatch.StartNew();
            if (avatar == null) { result.Reason = "没有头像对象"; return result; }
            var needsBody = false;
            if (candidates != null)
                for (int i = 0; i < candidates.Count; i++)
                    if (string.IsNullOrEmpty(candidates[i].Layer)) { needsBody = true; break; }
            if (needsBody && (bodyPaths == null || bodyPaths.Count == 0))
            {
                result.Reason = "素体渲染器路径为空（body_paths），无法判断「该像素是素体皮肤」";
                return result;
            }
            if (options.Views == null || options.Views.Length == 0) { result.Reason = "没有配置任何渲图视角"; return result; }

            Shader idShader = FindShader(IdShaderName);
            Shader depthShader = FindShader(DepthShaderName);
            if (idShader == null || depthShader == null)
            {
                result.Reason = "找不到渲图着色器（" + IdShaderName + " / " + DepthShaderName
                    + "）；部署要把这两个 .shader 与 .cs 一起放进 Assets/Editor/AvatarAudit/";
                return result;
            }

            // ── renderer table: index 0 is the background, renderers are numbered from 1 ──
            var renderers = new List<Renderer>();
            foreach (Renderer r in avatar.GetComponentsInChildren<Renderer>(true))
            {
                if (!(r is SkinnedMeshRenderer) && !(r is MeshRenderer)) continue;
                if (r.sharedMaterials == null || r.sharedMaterials.Length == 0) continue;
                renderers.Add(r);
            }
            renderers.Sort((a, b) => string.CompareOrdinal(PathOf(avatar, a), PathOf(avatar, b)));
            if (renderers.Count == 0) { result.Reason = "头像下没有可渲染的网格"; return result; }

            var lengths = new int[renderers.Count];
            var originalMaterials = new Material[renderers.Count][];
            var originalEnabled = new bool[renderers.Count];
            var paths = new string[renderers.Count];
            var bodyIds = new HashSet<int>();
            var idMaterials = new Material[renderers.Count + 1];
            var bodyPathSet = new HashSet<string>(StringComparer.Ordinal);
            if (bodyPaths != null) for (int i = 0; i < bodyPaths.Count; i++) if (!string.IsNullOrEmpty(bodyPaths[i])) bodyPathSet.Add(bodyPaths[i]);
            for (int i = 0; i < renderers.Count; i++)
            {
                int id = i + 1;
                paths[i] = PathOf(avatar, renderers[i]);
                lengths[i] = Mathf.Max(1, renderers[i].sharedMaterials != null ? renderers[i].sharedMaterials.Length : 1);
                originalMaterials[i] = renderers[i].sharedMaterials;
                originalEnabled[i] = renderers[i].enabled;
                Material material = new Material(idShader) { hideFlags = HideFlags.HideAndDontSave, name = "AvhFitId" + id };
                material.SetVector("_Color", new Vector4(id, 0f, 0f, 1f));
                idMaterials[id] = material;
                var row = new JsonObject();
                row.Set("index", id);
                row.Set("path", paths[i]);
                row.Set("body", bodyPathSet.Contains(paths[i]));
                result.RendererRows.Add(row);
                if (bodyPathSet.Contains(paths[i])) bodyIds.Add(id);
            }
            if (needsBody && bodyIds.Count == 0)
            {
                result.Reason = "body_paths 一个都没有匹配到当前头像的渲染器：" + string.Join(",", bodyPaths.ToArray());
                return result;
            }

            // ── per-candidate owner and comparison pass ───────────────────────────────────────────
            // A candidate with `Layer` set is a garment layer (GI1): its own renderer must own the pixel, and
            // the comparison image is rendered with that one renderer switched off. Every distinct layer gets
            // its own comparison image; body candidates share the "body off" image.
            int count = result.Candidates;
            // Paths remain the public reference format, but a path can name multiple same-named sibling
            // renderers. Keep the complete ID set so a candidate is never silently assigned to the first one.
            var ownerIds = new HashSet<int>[count];
            var cutIndex = new int[count];
            var cutKeys = new List<string>();
            var pathIndex = new Dictionary<string, List<int>>(StringComparer.Ordinal);
            for (int i = 0; i < paths.Length; i++)
            {
                if (!pathIndex.TryGetValue(paths[i], out var ids)) pathIndex[paths[i]] = ids = new List<int>();
                ids.Add(i + 1);
            }
            for (int i = 0; i < count; i++)
            {
                string layer = candidates[i].Layer ?? "";
                ownerIds[i] = null;   // null: any body renderer owns the pixel
                if (layer.Length > 0)
                    ownerIds[i] = pathIndex.TryGetValue(layer, out var ids) ? new HashSet<int>(ids) : new HashSet<int>();
                int key = cutKeys.IndexOf(layer);
                if (key < 0) { cutKeys.Add(layer); key = cutKeys.Count - 1; }
                cutIndex[i] = key;
            }
            var cutHides = new HashSet<int>[cutKeys.Count];
            for (int k = 0; k < cutKeys.Count; k++)
            {
                cutHides[k] = new HashSet<int>();
                if (cutKeys[k].Length == 0) { foreach (int id in bodyIds) cutHides[k].Add(id); }
                else if (pathIndex.TryGetValue(cutKeys[k], out var hideIds)) foreach (int id in hideIds) cutHides[k].Add(id);
            }

            var depthMaterial = new Material(depthShader) { hideFlags = HideFlags.HideAndDontSave, name = "AvhFitDepth" };
            var lights = new List<GameObject>();
            var outside = new List<Renderer>();
            var outsideEnabled = new List<bool>();
            var skinnedForced = new List<SkinnedMeshRenderer>();
            var skinnedUpdateWhenOffscreen = new List<bool>();
            int width = Mathf.RoundToInt(options.Height * 0.62f);
            int pixels = width * options.Height;
            RenderTexture idRt = null, depthRt = null, beautyRt = null;
            Texture2D floatRead = null, byteRead = null;
            var cameraObject = new GameObject("~AvhFitRenderCamera") { hideFlags = HideFlags.HideAndDontSave };
            var ambient = (RenderSettings.ambientMode, RenderSettings.ambientLight, RenderSettings.ambientIntensity, RenderSettings.skybox);
            try
            {
                float footY, bodyHeight;
                Frame(avatar, out footY, out bodyHeight);
                result.Notes.Add("取景按骨骼高度：foot_y=" + AuditUtil.F(footY) + "、h=" + AuditUtil.F(bodyHeight)
                    + "，视角中心 y=foot_y+h*0.47、正交半高=h*0.60（同 OV1/FP1/Portrait 规格）");

                // Renderers outside the avatar would write their own colours into the index image.
                foreach (Renderer r in Object.FindObjectsOfType<Renderer>())
                {
                    if (r == null || r.transform.IsChildOf(avatar.transform)) continue;
                    outside.Add(r);
                    outsideEnabled.Add(r.enabled);
                    r.enabled = false;
                }
                // A skinned mesh with stale bounds can be culled; the confirmation compares geometry, so force them
                // on for the duration (restored below).
                foreach (Renderer r in renderers)
                {
                    var smr = r as SkinnedMeshRenderer;
                    if (smr == null) continue;
                    skinnedForced.Add(smr);
                    skinnedUpdateWhenOffscreen.Add(smr.updateWhenOffscreen);
                    smr.updateWhenOffscreen = true;
                }

                var camera = cameraObject.AddComponent<Camera>();
                camera.enabled = false;                  // manual Render() only; an enabled camera would become the game camera
                camera.orthographic = true;
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = Color.black;    // index 0 = background
                camera.nearClipPlane = 0.01f;
                camera.farClipPlane = 20f;
                camera.allowHDR = false;
                camera.allowMSAA = false;
                camera.useOcclusionCulling = false;
                camera.stereoTargetEye = StereoTargetEyeMask.None;
                camera.cullingMask = ~0;

                idRt = new RenderTexture(width, options.Height, 24, RenderTextureFormat.ARGBFloat, RenderTextureReadWrite.Linear);
                depthRt = new RenderTexture(width, options.Height, 24, RenderTextureFormat.ARGBFloat, RenderTextureReadWrite.Linear);
                beautyRt = new RenderTexture(width, options.Height, 24, RenderTextureFormat.ARGB32);
                floatRead = new Texture2D(width, options.Height, TextureFormat.RGBAFloat, false, true);
                byteRead = new Texture2D(width, options.Height, TextureFormat.RGBA32, false);

                var idBuffer = new Color[pixels];
                var depthBuffer = new Color[pixels];
                // One reusable comparison buffer: with dozens of distinct layers, holding one image per layer
                // would cost hundreds of megabytes, and only the current layer's pixels are ever read.
                var cutBuffer = new Color[pixels];

                var codes = new List<string>[count];
                var confirmedViews = new List<string>[count];
                // GI1 (`D-143`): the pixels a candidate was confirmed at, encoded as view * framePixels + pixel, so
                // the caller can say how much of the picture a layer actually occupies -- evidence, not a filter.
                var hitPixels = new List<int>[count];
                var frames = new int[count];
                var bodyFront = new int[count];
                var depthOk = new int[count];
                var minDelta = new float[count];
                for (int i = 0; i < count; i++) { codes[i] = new List<string>(); confirmedViews[i] = new List<string>(); hitPixels[i] = new List<int>(); minDelta[i] = float.MaxValue; }

                // Studio light + flat ambient, only for the reviewable screenshot (the index/depth passes are unlit).
                RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
                RenderSettings.ambientLight = new Color(0.42f, 0.42f, 0.46f);
                RenderSettings.ambientIntensity = 1f;
                RenderSettings.skybox = null;
                lights.Add(Light(new Vector3(28f, 205f, 0f), 1.05f, new Color(1f, 0.98f, 0.95f)));
                lights.Add(Light(new Vector3(12f, 25f, 0f), 0.42f, new Color(0.85f, 0.90f, 1.00f)));

                string imageDir = null;
                if (!string.IsNullOrEmpty(outDir))
                {
                    imageDir = Path.Combine(outDir, "render");
                    Directory.CreateDirectory(imageDir);
                    string prefix = "render_" + AuditUtil.SafeFileName(stateId) + "_";
                    foreach (string stale in Directory.GetFiles(imageDir, prefix + "*.png")) File.Delete(stale);
                }

                // ── view loop ────────────────────────────────────────────────────────────────
                // MUTATION HOOK (fixture "single-view"): narrowing this bound to 1 keeps only the front view.
                for (int vi = 0; vi < options.Views.Length; vi++)
                {
                    ViewSpec spec = Spec(options.Views[vi], options.PitchDeg);
                    Vector3 dir = Quaternion.Euler(-spec.Pitch, spec.Yaw, 0f) * Vector3.forward;
                    var target = new Vector3(avatar.transform.position.x, footY + bodyHeight * 0.47f, avatar.transform.position.z);
                    camera.transform.position = target + dir * 5f;
                    camera.transform.rotation = Quaternion.LookRotation(-dir, Vector3.up);
                    camera.orthographicSize = bodyHeight * 0.60f;
                    result.ViewNames.Add(spec.Name);
                    result.ViewCount++;

                    RenderId(camera, renderers, lengths, idMaterials, idRt, idBuffer, floatRead, null);
                    try
                    {
                        InstallMaterials(renderers, lengths, i => depthMaterial);
                        ReadInto(camera, depthRt, floatRead, depthBuffer);
                    }
                    finally { RestoreMaterials(renderers, originalMaterials); }

                    int inFrame = 0, confirmed = 0;
                    var fileCuts = new List<string>();
                    var cutPathsKept = new List<string>();
                    for (int k = 0; k < cutKeys.Count; k++)
                    {
                        RenderId(camera, renderers, lengths, idMaterials, idRt, cutBuffer, floatRead, cutHides[k]);
                        for (int ci = 0; ci < count; ci++)
                        {
                            if (cutIndex[ci] != k) continue;
                            Candidate candidate = candidates[ci];
                            int x, y;
                            float eyeDepth;
                            if (!Project(camera, candidate.Position, width, options.Height, out x, out y, out eyeDepth))
                            {
                                codes[ci].Add(spec.Name + ":out");
                                continue;
                            }
                            inFrame++;
                            frames[ci]++;
                            int pixel = y * width + x;
                            int idFull = Mathf.RoundToInt(idBuffer[pixel].r);
                            int idCut = Mathf.RoundToInt(cutBuffer[pixel].r);
                            float frontDepth = depthBuffer[pixel].r;

                            // (1) the candidate's own layer owns the pixel: a body renderer for a body candidate,
                            // or exactly the named garment layer for a garment candidate.
                            bool bodyFrontmost = ownerIds[ci] == null ? bodyIds.Contains(idFull) : ownerIds[ci].Contains(idFull);
                            // (2) depth check: that frontmost surface is THIS vertex, within the tolerance --
                            // otherwise a nearer surface of the same layer (the forehead over a hairline vertex,
                            // or a nearer fold of the same skirt) impersonates it.
                            bool depthMatched = bodyFrontmost && frontDepth > 0f
                                && Math.Abs(frontDepth - eyeDepth) * 1000f <= options.DepthToleranceMm;
                            // (3) with the layer off, what shows at that pixel is the part it pierced through.
                            string cutPath = null;
                            bool garmentVisible = idCut != 0 && pathById(paths, idCut, out cutPath)
                                && string.Equals(cutPath, candidate.Garment, StringComparison.Ordinal);
                            if (bodyFrontmost) bodyFront[ci]++;
                            if (bodyFrontmost)
                            {
                                float delta = Math.Abs(frontDepth - eyeDepth) * 1000f;
                                if (delta < minDelta[ci]) minDelta[ci] = delta;
                            }
                            if (depthMatched) depthOk[ci]++;

                            if (depthMatched && garmentVisible)
                            {
                                confirmed++;
                                confirmedViews[ci].Add(spec.Name);
                                hitPixels[ci].Add((result.ViewCount - 1) * pixels + pixel);
                                codes[ci].Add(spec.Name + ":hit");
                            }
                            else if (!bodyFrontmost) codes[ci].Add(spec.Name + (idFull == 0 ? ":bg" : ":other"));
                            else if (!depthMatched) codes[ci].Add(spec.Name + ":deep");
                            else codes[ci].Add(spec.Name + ":miss");
                        }
                        // Evidence images are bounded: the reading covers every layer, the pictures cover the
                        // first ones (the caller orders its pairs closest-first, so these are the relevant ones).
                        if (imageDir != null && fileCuts.Count < MaxEvidenceCutImages)
                        {
                            fileCuts.Add(WriteIndexPng(imageDir, stateId, spec.Name,
                                cutKeys[k].Length == 0 ? "nobody" : "cut" + (k + 1), cutBuffer, width, options.Height));
                            cutPathsKept.Add(cutKeys[k]);
                        }
                    }

                    string fileId = null, fileMarked = null, fileBeauty = null;
                    if (imageDir != null)
                    {
                        fileId = WriteIndexPng(imageDir, stateId, spec.Name, "id", idBuffer, width, options.Height);
                        fileMarked = WriteIndexPng(imageDir, stateId, spec.Name, "marked", idBuffer, width, options.Height,
                            Marks(candidates, confirmedViews, camera, width, options.Height, 1));
                        result.Files.Add(fileId); result.Files.AddRange(fileCuts); result.Files.Add(fileMarked);
                    }

                    // (d) reviewable screenshot at the same camera, original materials and studio light
                    try
                    {
                        Color32[] present = ReadBytes(camera, beautyRt, byteRead);
                        if (present != null && imageDir != null)
                        {
                            fileBeauty = WriteBeautyPng(imageDir, stateId, spec.Name, present, width, options.Height,
                                Marks(candidates, confirmedViews, camera, width, options.Height, 1));
                            result.Files.Add(fileBeauty);
                        }
                    }
                    catch (Exception e) { Debug.LogWarning("[FitRenderConfirm] 定妆图失败：" + e.Message); }

                    var viewRow = new JsonObject();
                    viewRow.Set("view", spec.Name);
                    viewRow.Set("yaw", spec.Yaw);
                    viewRow.Set("pitch", spec.Pitch);
                    viewRow.Set("ortho_size", Math.Round(camera.orthographicSize, 4));
                    viewRow.Set("center_y", Math.Round(target.y, 4));
                    viewRow.Set("candidates_in_frame", inFrame);
                    viewRow.Set("confirmed", confirmed);
                    viewRow.Set("file_id", fileId);
                    viewRow.Set("file_cut", Result.Strings(fileCuts));
                    viewRow.Set("cut_paths", Result.Strings(cutPathsKept));
                    viewRow.Set("file_marked", fileMarked);
                    viewRow.Set("file_beauty", fileBeauty);
                    result.ViewRows.Add(viewRow);
                }

                // ── aggregate ────────────────────────────────────────────────────────────────
                for (int ci = 0; ci < count; ci++)
                {
                    Candidate candidate = candidates[ci];
                    bool hit = confirmedViews[ci].Count > 0;
                    var pairKey = candidate.Layer == null || candidate.Layer.Length == 0
                        ? candidate.Garment : candidate.Layer + " ↔ " + candidate.Garment;
                    if (hit)
                    {
                        result.Confirmed++;
                        result.PerGarment[pairKey] = (result.PerGarment.ContainsKey(pairKey)
                            ? result.PerGarment[pairKey] : 0) + 1;
                    }
                    else if (ownerIds[ci] != null && ownerIds[ci].Count == 0) result.MissingLayer++;
                    else if (frames[ci] == 0) result.OutsideFrame++;
                    else if (bodyFront[ci] == 0) result.RejectedNotBody++;
                    else if (depthOk[ci] == 0) result.RejectedDepth++;
                    else result.RejectedGarment++;

                    var row = new JsonObject();
                    row.Set("vertex", candidate.Vertex);
                    row.Set("layer", candidate.Layer ?? "");
                    row.Set("garment", candidate.Garment);
                    row.Set("region", candidate.Region);
                    row.Set("depth_mm", Math.Round(candidate.DepthMm, 3));
                    row.Set("confirmed", hit);
                    row.Set("views", Result.Strings(confirmedViews[ci]));
                    var pixelRow = new List<object>();
                    foreach (int hitPixel in hitPixels[ci]) pixelRow.Add(hitPixel);
                    row.Set("pixels", pixelRow);
                    row.Set("codes", Result.Strings(codes[ci]));
                    // Diagnostic: the closest this vertex ever came to being the frontmost body layer (mm), over the
                    // views where the body owned the pixel. Says how far a rejected candidate was from the tolerance.
                    row.Set("min_body_depth_delta_mm", minDelta[ci] == float.MaxValue
                        ? (object)null : Math.Round(minDelta[ci], 3));
                    result.CandidateRows.Add(row);
                }

                result.Valid = true;
                result.Notes.Add("渲图确认：候选 " + result.Candidates + "，确认 " + result.Confirmed
                    + "；深度容差 " + AuditUtil.F(options.DepthToleranceMm) + " mm；视角 "
                    + string.Join(",", result.ViewNames.ToArray()) + "；帧高 " + options.Height + "px");
            }
            catch (Exception error)
            {
                result.Valid = false;
                result.Reason = "渲图确认抛异常：" + error.Message;
                Debug.LogWarning("[FitRenderConfirm] " + error);
            }
            finally
            {
                try { RestoreMaterials(renderers, originalMaterials); } catch { }
                for (int i = 0; i < renderers.Count; i++) if (renderers[i] != null) renderers[i].enabled = originalEnabled[i];
                for (int i = 0; i < outside.Count; i++) if (outside[i] != null) outside[i].enabled = outsideEnabled[i];
                for (int i = 0; i < skinnedForced.Count; i++)
                    if (skinnedForced[i] != null) skinnedForced[i].updateWhenOffscreen = skinnedUpdateWhenOffscreen[i];
                foreach (GameObject light in lights) if (light != null) Object.DestroyImmediate(light);
                (RenderSettings.ambientMode, RenderSettings.ambientLight, RenderSettings.ambientIntensity, RenderSettings.skybox) = ambient;
                if (cameraObject != null) Object.DestroyImmediate(cameraObject);
                foreach (Material material in idMaterials) if (material != null) Object.DestroyImmediate(material);
                if (depthMaterial != null) Object.DestroyImmediate(depthMaterial);
                if (idRt != null) { idRt.Release(); Object.DestroyImmediate(idRt); }
                if (depthRt != null) { depthRt.Release(); Object.DestroyImmediate(depthRt); }
                if (beautyRt != null) { beautyRt.Release(); Object.DestroyImmediate(beautyRt); }
                if (floatRead != null) Object.DestroyImmediate(floatRead);
                if (byteRead != null) Object.DestroyImmediate(byteRead);
                clock.Stop();
                result.Milliseconds = clock.Elapsed.TotalMilliseconds;
            }
            return result;
        }

        static bool pathById(string[] paths, int id, out string path)
        {
            path = null;
            if (id < 1 || id > paths.Length) return false;
            path = paths[id - 1];
            return true;
        }

        // ── materials ────────────────────────────────────────────────────────────────────────

        static void InstallMaterials(List<Renderer> renderers, int[] lengths, Func<int, Material> pick)
        {
            for (int i = 0; i < renderers.Count; i++)
            {
                Material material = pick(i);
                var array = new Material[lengths[i]];
                for (int q = 0; q < lengths[i]; q++) array[q] = material;
                renderers[i].sharedMaterials = array;
            }
        }

        static void RestoreMaterials(List<Renderer> renderers, Material[][] saved)
        {
            for (int i = 0; i < renderers.Count; i++)
            {
                if (renderers[i] == null || saved[i] == null) continue;
                renderers[i].sharedMaterials = saved[i];
            }
        }

        /// <summary>One index pass: install the per-renderer id materials, switch off the renderers named in
        /// <paramref name="hide"/> (the body for a body candidate, one inner layer for a garment candidate; null
        /// means nothing is hidden), read the index image, then put the scene back exactly as it was.</summary>
        static void RenderId(Camera camera, List<Renderer> renderers, int[] lengths, Material[] idMaterials,
            RenderTexture rt, Color[] destination, Texture2D floatRead, HashSet<int> hide)
        {
            var savedEnabled = new bool[renderers.Count];
            var savedMaterials = new Material[renderers.Count][];
            try
            {
                for (int i = 0; i < renderers.Count; i++)
                {
                    savedEnabled[i] = renderers[i].enabled;
                    savedMaterials[i] = renderers[i].sharedMaterials;
                }
                InstallMaterials(renderers, lengths, i => idMaterials[i + 1]);
                if (hide != null)
                    for (int i = 0; i < renderers.Count; i++) if (hide.Contains(i + 1)) renderers[i].enabled = false;
                ReadInto(camera, rt, floatRead, destination);
            }
            finally
            {
                for (int i = 0; i < renderers.Count; i++)
                {
                    if (renderers[i] == null) continue;
                    if (savedMaterials[i] != null) renderers[i].sharedMaterials = savedMaterials[i];
                    renderers[i].enabled = savedEnabled[i];
                }
            }
        }

        // ── rendering helpers ────────────────────────────────────────────────────────────────

        static void ReadInto(Camera camera, RenderTexture rt, Texture2D read, Color[] destination)
        {
            camera.targetTexture = rt;
            camera.Render();
            var previous = RenderTexture.active;
            RenderTexture.active = rt;
            read.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0, false);
            read.Apply(false, false);
            RenderTexture.active = previous;
            camera.targetTexture = null;
            read.GetPixelData<Color>(0).CopyTo(destination);
        }

        static Color32[] ReadBytes(Camera camera, RenderTexture rt, Texture2D read)
        {
            camera.targetTexture = rt;
            camera.Render();
            var previous = RenderTexture.active;
            RenderTexture.active = rt;
            read.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0, false);
            read.Apply(false, false);
            RenderTexture.active = previous;
            camera.targetTexture = null;
            return read.GetPixelData<Color32>(0).ToArray();
        }

        static bool Project(Camera camera, Vector3 world, int width, int height, out int x, out int y, out float eyeDepth)
        {
            Vector3 view = Quaternion.Inverse(camera.transform.rotation) * (world - camera.transform.position);
            float halfH = camera.orthographicSize;
            float halfW = halfH * ((float)width / height);
            float fx = (view.x / halfW * 0.5f + 0.5f) * width;
            float fy = (view.y / halfH * 0.5f + 0.5f) * height;
            eyeDepth = view.z;
            if (eyeDepth <= 0f || fx < 0f || fy < 0f || fx >= width || fy >= height)
            {
                x = 0; y = 0;
                return false;
            }
            x = (int)fx;
            y = (int)fy;
            return true;
        }

        static ViewSpec Spec(string name, int pitchDeg)
        {
            switch (name)
            {
                case "front": return new ViewSpec { Name = "front", Yaw = 0f, Pitch = 0f };
                case "back": return new ViewSpec { Name = "back", Yaw = 180f, Pitch = 0f };
                case "left": return new ViewSpec { Name = "left", Yaw = -90f, Pitch = 0f };
                case "right": return new ViewSpec { Name = "right", Yaw = 90f, Pitch = 0f };
                case "front_up": return new ViewSpec { Name = "front_up", Yaw = 0f, Pitch = pitchDeg };
                case "back_up": return new ViewSpec { Name = "back_up", Yaw = 180f, Pitch = pitchDeg };
                default: throw new Exception("未知的渲图视角：" + name);
            }
        }

        /// <summary>Framing from the humanoid rig, the same numbers OV1/FP1/Portrait use; falls back to the
        /// avatar's bounds when the rig is not humanoid (the synthetic fixture).</summary>
        static void Frame(GameObject avatar, out float footY, out float height)
        {
            var animator = avatar.GetComponent<Animator>();
            Transform head = animator != null && animator.isHuman ? animator.GetBoneTransform(HumanBodyBones.Head) : null;
            Transform foot = animator != null && animator.isHuman ? animator.GetBoneTransform(HumanBodyBones.LeftFoot) : null;
            if (head != null && foot != null)
            {
                footY = foot.position.y;
                height = Mathf.Max(0.2f, (head.position.y - foot.position.y) / 0.87f);
                return;
            }
            var bounds = new Bounds();
            bool first = true;
            foreach (Renderer r in avatar.GetComponentsInChildren<Renderer>(true))
            {
                if (r == null || !r.enabled) continue;
                if (first) { bounds = r.bounds; first = false; } else bounds.Encapsulate(r.bounds);
            }
            if (first) bounds = new Bounds(avatar.transform.position, Vector3.one * 0.2f);
            footY = bounds.min.y;
            height = Mathf.Max(0.2f, bounds.size.y);
        }

        static GameObject Light(Vector3 euler, float intensity, Color color)
        {
            var go = new GameObject("~AvhFitRenderLight") { hideFlags = HideFlags.HideAndDontSave };
            go.transform.rotation = Quaternion.Euler(euler);
            var light = go.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = intensity;
            light.color = color;
            light.shadows = LightShadows.None;
            return go;
        }

        static string PathOf(GameObject root, Renderer r)
        {
            return AuditUtil.RelPath(root.transform, r.transform);
        }

        static Shader FindShader(string name)
        {
            try
            {
                Shader shader = Shader.Find(name);
                if (shader != null) return shader;
            }
            catch { }
            return null;
        }

        // ── evidence images ──────────────────────────────────────────────────────────────────

        /// <summary>Pixel marks to draw: one box per candidate at its projected pixel -- green when the candidate is
        /// confirmed in some view (so "where in the picture was it confirmed" is readable), orange otherwise.</summary>
        static List<int[]> Marks(List<Candidate> candidates, List<string>[] confirmedViews, Camera camera,
            int width, int height, int scale)
        {
            var marks = new List<int[]>();
            if (candidates == null) return marks;
            for (int i = 0; i < candidates.Count; i++)
            {
                int x, y;
                float depth;
                if (!Project(camera, candidates[i].Position, width, height, out x, out y, out depth)) continue;
                bool hit = confirmedViews[i] != null && confirmedViews[i].Count > 0;
                marks.Add(new[] { x / scale, y / scale, hit ? 0 : 1 });
            }
            return marks;
        }

        static string WriteIndexPng(string dir, string stateId, string view, string kind, Color[] pixels,
            int width, int height, List<int[]> marks = null)
        {
            var bytes = new Color32[width * height];
            for (int i = 0; i < bytes.Length; i++)
            {
                int id = Mathf.RoundToInt(pixels[i].r);
                bytes[i] = new Color32((byte)(id & 0xFF), (byte)((id >> 8) & 0xFF), (byte)((id >> 16) & 0xFF), 255);
            }
            DrawMarks(bytes, width, height, marks);
            string name = "render_" + AuditUtil.SafeFileName(stateId) + "_" + view + "_" + kind + ".png";
            WritePng(Path.Combine(dir, name), bytes, width, height);
            return name;
        }

        static string WriteBeautyPng(string dir, string stateId, string view, Color32[] pixels, int width, int height,
            List<int[]> marks)
        {
            int factor = Mathf.Max(1, Mathf.CeilToInt(height / BeautyMaxHeight));
            int dw = Mathf.Max(1, width / factor), dh = Mathf.Max(1, height / factor);
            var bytes = new Color32[dw * dh];
            for (int y = 0; y < dh; y++)
                for (int x = 0; x < dw; x++)
                {
                    int sx = Mathf.Min(width - 1, x * factor), sy = Mathf.Min(height - 1, y * factor);
                    bytes[y * dw + x] = pixels[sy * width + sx];
                }
            var scaled = new List<int[]>();
            if (marks != null)
                foreach (int[] mark in marks) scaled.Add(new[] { mark[0] / factor, mark[1] / factor, mark[2] });
            DrawMarks(bytes, dw, dh, scaled);
            string name = "render_" + AuditUtil.SafeFileName(stateId) + "_" + view + "_shot.png";
            WritePng(Path.Combine(dir, name), bytes, dw, dh);
            return name;
        }

        static void DrawMarks(Color32[] pixels, int width, int height, List<int[]> marks)
        {
            if (marks == null) return;
            foreach (int[] mark in marks)
            {
                Color32 color = mark[2] == 0 ? new Color32(0, 255, 0, 255) : new Color32(255, 128, 0, 255);
                for (int dy = -MarkSize; dy <= MarkSize; dy++)
                    for (int dx = -MarkSize; dx <= MarkSize; dx++)
                    {
                        if (Math.Abs(dx) != MarkSize && Math.Abs(dy) != MarkSize) continue;   // box outline only
                        int x = mark[0] + dx, y = mark[1] + dy;
                        if (x < 0 || y < 0 || x >= width || y >= height) continue;
                        pixels[y * width + x] = color;
                    }
            }
        }

        static void WritePng(string path, Color32[] pixels, int width, int height)
        {
            var texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
            try
            {
                texture.SetPixels32(pixels);
                texture.Apply(false, false);
                File.WriteAllBytes(path, texture.EncodeToPNG());
            }
            finally { Object.DestroyImmediate(texture); }
        }
    }
}
