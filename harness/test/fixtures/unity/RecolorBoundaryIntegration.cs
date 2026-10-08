using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
namespace AVH.Harness
{
    public static class RecolorBoundaryIntegration
    {
        static int assertions;
        static void Require(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }
        public static void Run()
        {
            try
            {
                var root = new GameObject("Fixture");
                var particle = new GameObject("TriggerParticle"); particle.transform.SetParent(root.transform, false);
                particle.AddComponent<ParticleSystem>(); var renderer = particle.GetComponent<ParticleSystemRenderer>();
                renderer.sharedMaterials = new Material[] { null }; renderer.enabled = false;
                Require(!Measure.EmptySlots(root).Any(), "Disabled nonvisual particle was counted as a visible empty slot");
                renderer.enabled = true;
                Require(Measure.EmptySlots(root).Count() == 1, "Enabled particle empty slot disappeared"); renderer.enabled = false;
                OutfitStage.EnsureFolder("Assets/Authorized");
                var controller = AnimatorController.CreateAnimatorControllerAtPath("Assets/Authorized/fixture.controller");
                var clip = new AnimationClip(); AssetDatabase.CreateAsset(clip, "Assets/Authorized/enable.anim");
                AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("TriggerParticle", typeof(ParticleSystemRenderer), "m_Enabled"), AnimationCurve.Constant(0, 1, 1));
                controller.layers[0].stateMachine.AddState("Enable").motion = clip;
                root.AddComponent<Animator>().runtimeAnimatorController = controller;
                Require(Measure.EmptySlots(root).Count() == 1, "Animated particle renderer enable writer was ignored");
                UnityEngine.Object.DestroyImmediate(root.GetComponent<Animator>());
                var merge = root.AddComponent<nadena.dev.modular_avatar.core.ModularAvatarMergeAnimator>(); merge.animator = controller;
                Require(Measure.EmptySlots(root).Count() == 1, "Modular Avatar enable writer was ignored"); UnityEngine.Object.DestroyImmediate(merge);
                var descriptor = root.AddComponent<VRC.SDK3.Avatars.Components.VRCAvatarDescriptor>();
                descriptor.baseAnimationLayers = new[] { new VRC.SDK3.Avatars.Components.VRCAvatarDescriptor.CustomAnimLayer { animatorController = controller, isDefault = false } };
                Require(Measure.EmptySlots(root).Count() == 1, "Descriptor enable writer was ignored"); UnityEngine.Object.DestroyImmediate(descriptor);
                AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("TriggerParticle", typeof(ParticleSystemRenderer), "m_Enabled"), null);
                AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("TriggerParticle", typeof(BoxCollider), "m_Enabled"), AnimationCurve.Constant(0, 1, 1));
                root.AddComponent<Animator>().runtimeAnimatorController = controller;
                Require(!Measure.EmptySlots(root).Any(), "Collider trigger enable curve was mistaken for a renderer enable writer");
                UnityEngine.Object.DestroyImmediate(root.GetComponent<Animator>());
                UnityEngine.Object.DestroyImmediate(particle);
                var ordinary = GameObject.CreatePrimitive(PrimitiveType.Cube); ordinary.transform.SetParent(root.transform, false);
                ordinary.GetComponent<Renderer>().sharedMaterials = new Material[] { null }; ordinary.GetComponent<Renderer>().enabled = false;
                Require(Measure.EmptySlots(root).Count() == 1, "Ordinary disabled mesh escaped material coverage");
                ordinary.SetActive(false); Require(Measure.EmptySlots(root).Count() == 1, "Inactive ordinary mesh escaped material coverage");
                UnityEngine.Object.DestroyImmediate(root);

                var body = new GameObject("Body"); var part = GameObject.CreatePrimitive(PrimitiveType.Cube); part.transform.SetParent(body.transform, false);
                var material = new Material(Shader.Find("Standard")); AssetDatabase.CreateAsset(material, "Assets/Authorized/body.mat"); part.GetComponent<Renderer>().sharedMaterial = material;
                var original = PrefabUtility.SaveAsPrefabAsset(body, "Assets/Authorized/body.prefab"); UnityEngine.Object.DestroyImmediate(body);
                var sourceBytes = File.ReadAllBytes(Avh.Abs("Assets/Authorized/body.prefab"));
                var plan = new Dictionary<string, object> { ["body_prefab"] = "Assets/Authorized/body.prefab", ["outfits"] = new List<object>() };
                Environment.SetEnvironmentVariable("AVH_PLAN", Avh.Json(plan));
                Avh.WriteJson(Avh.Abs("_harness/setup/baseline.json"), new Dictionary<string, object> { ["body_prefab"] = "Assets/Authorized/body.prefab" });
                Avh.WriteJson(Avh.Abs("_harness/setup/import.json"), new Dictionary<string, object> { ["packages"] = new List<object>() });
                LocalOperations.Observe(original, plan);
                var observation = File.ReadAllText(Avh.Abs(LocalOperations.ObservationPath));
                Avh.WriteJson(Avh.Abs(LocalOperations.InputPath), new Dictionary<string, object> { ["schema"] = "local-operations/0.1", ["observation_sha256"] = LocalOperations.Digest(observation), ["operations"] = new List<object>() });
                OutfitStage.Produce();
                Require(File.Exists(Avh.Abs(LocalOperations.OutputPath + ".meta")), "Production receipt left its metadata to a downstream stage");
                var guid = AssetDatabase.AssetPathToGUID(LocalOperations.OutputPath); Require(!string.IsNullOrEmpty(guid), "Receipt metadata is not imported");
                AssetDatabase.Refresh(); Require(AssetDatabase.AssetPathToGUID(LocalOperations.OutputPath) == guid, "Downstream import changed receipt identity");
                Require(sourceBytes.SequenceEqual(File.ReadAllBytes(Avh.Abs("Assets/Authorized/body.prefab"))), "Production wrote the source prefab");
                Avh.WriteJson(Avh.Abs("result.json"), new Dictionary<string, object> { ["ok"] = true, ["assertions"] = assertions }); EditorApplication.Exit(0);
            }
            catch (Exception e) { Avh.WriteJson(Avh.Abs("result.json"), new Dictionary<string, object> { ["ok"] = false, ["assertions"] = assertions, ["error"] = e.ToString() }); Debug.LogException(e); EditorApplication.Exit(1); }
        }
    }
}
