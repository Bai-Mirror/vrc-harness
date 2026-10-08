// Fixture for SOP 60's deadlock audit. It asks the production question through the same two calls
// BuildStage.Verify makes — BuildStage.DeadlockInputs(menu) then AvatarAudit.Deadlocks(built, ...) — over the
// menu records the routes actually write, so the preserve route's empty record is measured on the real path.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Avatars.Components;

namespace AVH.Harness
{
    public static class DeadlockAuditIntegration
    {
        const string Dir = "Assets/Fixture";
        const string OutfitPath = "_Outfit/OutfitA";
        const string Parameter = "AVH/Outfit";
        const string AvatarPrefab = Dir + "/DeadlockAvatar.prefab";
        static int assertions;
        static Dictionary<string, object> D(params object[] pairs) { var d = new Dictionary<string, object>(); for (var i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1]; return d; }
        static List<object> L(params object[] values) => values.ToList();
        static void Check(bool ok, string message) { assertions++; if (!ok) throw new Exception(message); }

        /// <summary>
        /// One outfit root that starts off, plus the only layer that can turn it on. The parameter therefore has a
        /// genuine deadlock cell (0) and a genuine live cell (1) — the audit must read the animation data, not just
        /// count combinations.
        /// </summary>
        static GameObject BuildAvatar()
        {
            var off = new AnimationClip { name = "DeadlockOff" };
            var on = new AnimationClip { name = "DeadlockOn" };
            AnimationUtility.SetEditorCurve(on, EditorCurveBinding.FloatCurve(OutfitPath, typeof(GameObject), "m_IsActive"),
                AnimationCurve.Constant(0, 1, 1));
            AssetDatabase.CreateAsset(off, Dir + "/DeadlockOff.anim");
            AssetDatabase.CreateAsset(on, Dir + "/DeadlockOn.anim");
            var controller = AnimatorController.CreateAnimatorControllerAtPath(Dir + "/Deadlock.controller");
            controller.AddParameter(Parameter, AnimatorControllerParameterType.Float);
            var layer = controller.layers[0];
            layer.name = "AVH Outfit";
            layer.defaultWeight = 1;
            var offState = layer.stateMachine.AddState("Off");
            offState.motion = off;
            offState.writeDefaultValues = false;
            var onState = layer.stateMachine.AddState("On");
            onState.motion = on;
            onState.writeDefaultValues = false;
            layer.stateMachine.defaultState = offState;
            var toOn = offState.AddTransition(onState);
            toOn.hasExitTime = false;
            toOn.duration = 0;
            toOn.AddCondition(AnimatorConditionMode.Greater, 0.5f, Parameter);
            controller.layers = new[] { layer };

            var avatar = new GameObject("DeadlockAvatar");
            var descriptor = avatar.AddComponent<VRCAvatarDescriptor>();
            descriptor.customizeAnimationLayers = true;
            descriptor.baseAnimationLayers = new[] { new VRCAvatarDescriptor.CustomAnimLayer {
                type = VRCAvatarDescriptor.AnimLayerType.FX, isDefault = false, animatorController = controller } };
            var root = new GameObject("_Outfit");
            root.transform.SetParent(avatar.transform, false);
            var outfit = new GameObject("OutfitA");
            outfit.transform.SetParent(root.transform, false);
            outfit.SetActive(false);
            return avatar;
        }

        /// <summary>The menu record shape MenuStage.Preserve writes: no declared parameter, no control, no conflict.</summary>
        static Dictionary<string, object> PreserveRecord() => D("schema", "menu/0.4", "route", "preserve",
            "source_prefab", RecolorStage.AvatarPath, "parameters", new List<object>(), "controls", new List<object>(),
            "conflicts", new List<object>(), "selector_owned_paths", new List<object>(), "overlap", new List<object>());

        /// <summary>A declared position with one source, exactly as the assemble route records it.</summary>
        static Dictionary<string, object> PositionRecord(string source) => D("schema", "menu/0.4", "route", "B",
            "parameters", L(Parameter),
            "controls", L(D("parameter", Parameter, "value", 1f, "control", "RadialChoice")),
            "conflicts", L(D("position", "全身服装", "sources", L(source))));

        static GameObject Instance()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            return (GameObject)PrefabUtility.InstantiatePrefab(AssetDatabase.LoadAssetAtPath<GameObject>(AvatarPrefab));
        }

        /// <summary>Write the record where production reads it, then run the production derivation and audit.</summary>
        static (int count, List<string> notes) Audit(Dictionary<string, object> record)
        {
            Avh.WriteJson(Avh.Abs(MenuStage.RecordPath), record);
            var menu = Avh.ReadJsonFile(Avh.Abs(MenuStage.RecordPath));
            var inputs = BuildStage.DeadlockInputs(menu);
            var avatar = Instance();
            try
            {
                var notes = new List<string>();
                return (AvatarAudit.Deadlocks(avatar, inputs.domains, inputs.sources, notes), notes);
            }
            finally { UnityEngine.Object.DestroyImmediate(avatar); }
        }

        static void Scenario()
        {
            OutfitStage.EnsureFolder(Dir);
            var avatar = BuildAvatar();
            PrefabUtility.SaveAsPrefabAsset(avatar, AvatarPrefab);
            UnityEngine.Object.DestroyImmediate(avatar);
            AssetDatabase.SaveAssets();

            var preserve = Audit(PreserveRecord());
            Check(preserve.count == 0, "preserve route (no declared position) was counted as a deadlock: " + preserve.count
                + " / " + string.Join("; ", preserve.notes));
            Check(preserve.notes.Any(note => note.Contains("不适用")), "preserve route carried no not-applicable reading: "
                + string.Join("; ", preserve.notes));
            var deadlock = Audit(PositionRecord(OutfitPath));
            Check(deadlock.count == 1, "a declared position with one real deadlock cell must still count exactly 1, got "
                + deadlock.count + " / " + string.Join("; ", deadlock.notes));
            Check(deadlock.notes.Any(note => note.Contains("遍历 2 格，死锁 1 格")), "the audit did not traverse the parameter domain: "
                + string.Join("; ", deadlock.notes));

            var missing = Audit(PositionRecord("_Outfit/Missing"));
            Check(missing.count > 0, "a declared position whose source cannot be located must stay a failure, got "
                + missing.count + " / " + string.Join("; ", missing.notes));
            Check(missing.notes.Any(note => note.Contains("找不到的来源")), "the unlocatable source was not reported: "
                + string.Join("; ", missing.notes));

            var noSources = Audit(D("schema", "menu/0.4", "route", "B", "parameters", L(Parameter),
                "controls", new List<object>(), "conflicts", new List<object>()));
            Check(noSources.count > 0, "declared parameters with no sources must not be silenced, got " + noSources.count);

            // The short-circuit needs both halves empty: a record that declares sources but no parameter domain still has
            // objects to account for, and none of them being locatable is a failure, not an empty question.
            var sourcesOnly = Audit(D("schema", "menu/0.4", "route", "B", "parameters", new List<object>(),
                "controls", new List<object>(), "conflicts", L(D("position", "全身服装", "sources", L("_Outfit/Missing")))));
            Check(sourcesOnly.count > 0, "declared sources with no parameter domain must still be audited, got " + sourcesOnly.count);
        }

        public static void Run()
        {
            try { Scenario(); Avh.WriteJson(Avh.Abs("result.json"), D("ok", true, "assertions", assertions)); EditorApplication.Exit(0); }
            catch (Exception e) { Avh.WriteJson(Avh.Abs("result.json"), D("ok", false, "assertions", assertions, "error", e.ToString())); Debug.LogException(e); EditorApplication.Exit(1); }
        }
    }
}
