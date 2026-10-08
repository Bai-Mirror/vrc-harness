// 【项目沉淀】通用工具（Harness 的同机位出图）
// 适用素体：人形素体
// 工具链　：Unity 2022.3 批处理（不能带 -nographics）
// 可复用性：★★★ 换个单子直接能用
// 用途　　：固定布光、按骨骼量身高取景的正交正面全身照，另写一份机位规格（数值取 4 位小数）。
//           候选比较只认规格完全相同的图（SOP 40 步骤 4）；取景只依赖骨骼，所以改色前后、换装前后规格一致。
//           布光沿用 AvatarPortrait 的影棚参数（主光 + 背侧补光 + 平光环境），不用工程自带的灯。
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEngine;
using UnityEngine.Rendering;

namespace AVH.Harness
{
    public static class Portrait
    {
        static readonly Color Background = new Color(0.235f, 0.235f, 0.255f);

        /// <summary>Render a front full-body shot to pngPath and return the camera spec that produced it.</summary>
        public static Dictionary<string, object> Front(GameObject avatar, string pngPath, int height = 1500)
        {
            var animator = avatar.GetComponent<Animator>();
            var head = animator != null && animator.isHuman ? animator.GetBoneTransform(HumanBodyBones.Head) : null;
            var foot = animator != null && animator.isHuman ? animator.GetBoneTransform(HumanBodyBones.LeftFoot) : null;
            if (head == null || foot == null) throw new Exception("出图要人形骨骼（Head / LeftFoot）");
            var h = Mathf.Max(0.2f, (head.position.y - foot.position.y) / 0.87f);
            var forward = avatar.transform.forward; forward.y = 0; forward = forward.sqrMagnitude < 1e-4f ? Vector3.forward : forward.normalized;
            var target = new Vector3(avatar.transform.position.x, foot.position.y + h * 0.47f, avatar.transform.position.z);
            var ortho = h * 0.60f;
            var width = Mathf.RoundToInt(height * 0.62f);

            var lights = new List<GameObject>();
            var ambient = (RenderSettings.ambientMode, RenderSettings.ambientLight, RenderSettings.ambientIntensity, RenderSettings.skybox);
            RenderSettings.ambientMode = AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.42f, 0.42f, 0.46f);
            RenderSettings.ambientIntensity = 1f;
            RenderSettings.skybox = null;
            lights.Add(Light(new Vector3(28f, 205f, 0f), 1.05f, new Color(1f, 0.98f, 0.95f)));
            lights.Add(Light(new Vector3(12f, 25f, 0f), 0.42f, new Color(0.85f, 0.90f, 1.00f)));
            var cameraObject = new GameObject("~AvhPortraitCamera") { hideFlags = HideFlags.HideAndDontSave };
            var rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32) { antiAliasing = 4 };
            try
            {
                var camera = cameraObject.AddComponent<Camera>();
                camera.orthographic = true;
                camera.orthographicSize = ortho;
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = Background;
                camera.nearClipPlane = 0.01f;
                camera.farClipPlane = 20f;
                camera.transform.position = target + forward * 5f;
                camera.transform.rotation = Quaternion.LookRotation(-forward, Vector3.up);
                camera.targetTexture = rt;
                camera.Render();
                var previous = RenderTexture.active;
                RenderTexture.active = rt;
                var texture = new Texture2D(width, height, TextureFormat.RGB24, false);
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply();
                RenderTexture.active = previous;
                Directory.CreateDirectory(Path.GetDirectoryName(pngPath)!);
                File.WriteAllBytes(pngPath, texture.EncodeToPNG());
                UnityEngine.Object.DestroyImmediate(texture);
                camera.targetTexture = null;
                return new Dictionary<string, object>
                {
                    ["schema"] = "camera-spec/0.1", ["projection"] = "orthographic", ["width"] = width, ["height"] = height,
                    ["ortho_size"] = Round(ortho), ["position"] = Vec(camera.transform.position), ["rotation"] = Vec(camera.transform.eulerAngles),
                    ["background"] = Vec(new Vector3(Background.r, Background.g, Background.b)), ["lights"] = "studio-2key-flat-ambient",
                };
            }
            finally
            {
                rt.Release();
                UnityEngine.Object.DestroyImmediate(rt);
                UnityEngine.Object.DestroyImmediate(cameraObject);
                foreach (var light in lights) UnityEngine.Object.DestroyImmediate(light);
                (RenderSettings.ambientMode, RenderSettings.ambientLight, RenderSettings.ambientIntensity, RenderSettings.skybox) = ambient;
            }
        }

        static GameObject Light(Vector3 euler, float intensity, Color color)
        {
            var go = new GameObject("~AvhPortraitLight") { hideFlags = HideFlags.HideAndDontSave };
            go.transform.rotation = Quaternion.Euler(euler);
            var light = go.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = intensity;
            light.color = color;
            light.shadows = LightShadows.None;
            return go;
        }

        static double Round(float value) => Math.Round(value, 4);
        static List<object> Vec(Vector3 v) => new List<object> { Round(v.x), Round(v.y), Round(v.z) };
    }
}
