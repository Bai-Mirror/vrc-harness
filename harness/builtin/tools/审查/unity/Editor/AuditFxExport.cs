// 【项目沉淀】
// 适用素体：无关（Unity 编辑器构建期截获工具）。
// 用途：T-12 pass B —— Optimizing 阶段、AAO 之后的 `AfterPlugin("com.anatawa12.avatar-optimizer")`
//   导出最终 FX 控制器（层名/序号/WD/状态/条件/曲线绑定 + ObjectReference 源路径）→ fx_final.json。
//
// 为什么在 AAO 之后导：03 Q2 —— MA 的写者图只到「MA 分析」为止，AAO 会做 MergeSkinnedMesh（键改名）、
//   EntryExitToBlendTree（层形态变化）、WriteDefaults 修正；只有 AAO 结束后的虚拟控制器才是「最终 FX」。
//   `AnimatorServicesContext` 在 befor-plugin 阶段拿到的是 AAO 提交后的 VirtualAnimatorController。
//
// 定位口径（03 §3 F1/F2/F3）：层名大量重复，不能只按层名定位；本导出把「层 + 状态 + (path,type,property)
//   曲线绑定」全部落盘，并额外给一份扁平 curve_bindings，供 T-14/T-16 按曲线绑定反查。

using System;
using System.Collections.Generic;
using System.Globalization;
using nadena.dev.ndmf;
using nadena.dev.ndmf.animator;
using UnityEditor;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using Object = UnityEngine.Object;

namespace AvatarAudit
{
    internal static class AuditFxExport
    {
        public static void Export(BuildContext context)
        {
            if (!AuditBuildCapture.GateOpen) return;
            AuditBuildCapture.MarkPhase("fx_export", context.AvatarRootObject == null ? null : context.AvatarRootObject.name);

            var doc = new JsonObject();
            doc.Set("tool", AuditBuildCapture.ToolName);
            doc.Set("tool_version", AuditBuildCapture.ToolVersion(typeof(AuditBuildPlugin)));
            doc.Set("phase", "fx_final");
            doc.Set("avatar_root", context.AvatarRootObject == null ? null : context.AvatarRootObject.name);

            VirtualAnimatorController fx = null;
            try
            {
                var asc = context.Extension<AnimatorServicesContext>();
                fx = asc.ControllerContext.Controllers[VRCAvatarDescriptor.AnimLayerType.FX];
            }
            catch (Exception e)
            {
                doc.Set("available", false);
                doc.Set("reason_code", "fx_export_failed");
                doc.Set("reason", "取 AnimatorServicesContext/FX 控制器失败：" + e.Message);
                AuditBuildCapture.Write("fx_final.json", doc);
                AuditBuildCapture.Error("pass B 取 FX 失败：" + e.Message);
                return;
            }

            if (fx == null)
            {
                doc.Set("available", false);
                doc.Set("reason_code", "fx_export_failed");
                doc.Set("reason", "虚拟控制器里没有 FX（AnimLayerType.FX 键）");
                AuditBuildCapture.Write("fx_final.json", doc);
                return;
            }

            doc.Set("available", true);
            doc.Set("controller", "FX");
            doc.Set("controller_name", fx.Name);

            var parameters = new List<object>();
            try
            {
                foreach (var kv in fx.Parameters)
                {
                    var p = kv.Value;
                    var pn = new JsonObject();
                    pn.Set("name", kv.Key);
                    pn.Set("type", p == null ? null : p.type.ToString());
                    if (p != null)
                    {
                        pn.Set("default_float", (double)p.defaultFloat);
                        pn.Set("default_int", (double)p.defaultInt);
                        pn.Set("default_bool", p.defaultBool);
                    }
                    parameters.Add(pn);
                }
            }
            catch (Exception e) { AuditBuildCapture.Note("枚举参数失败：" + e.Message); }
            doc.Set("parameters", parameters);
            doc.Set("parameter_count", parameters.Count);

            var layers = new List<object>();
            var flatBindings = new List<object>();
            int index = 0;
            try
            {
                foreach (var layer in fx.Layers)
                {
                    layers.Add(ExportLayer(layer, index, flatBindings));
                    index++;
                }
            }
            catch (Exception e)
            {
                AuditBuildCapture.Error("枚举 FX 层失败：" + e.Message);
            }
            doc.Set("layers", layers);
            doc.Set("layer_count", layers.Count);
            doc.Set("curve_bindings", flatBindings);
            doc.Set("curve_binding_count", flatBindings.Count);

            // 验收辅助：直接列出可定位的层名（层名会重复，这里只是给人/grep 一个入口）。
            var layerNames = new List<object>();
            foreach (var l in layers)
            {
                var lo = l as JsonObject;
                if (lo != null) layerNames.Add(lo.Get("name"));
            }
            doc.Set("layer_names", layerNames);

            AuditBuildCapture.Write("fx_final.json", doc);
            AuditBuildCapture.FxWritten = true;
            AuditBuildCapture.Note("fx_final.json: " + layers.Count + " 层 / " + flatBindings.Count + " 条曲线绑定");
        }

        private static JsonObject ExportLayer(VirtualLayer layer, int index, List<object> flatBindings)
        {
            var ln = new JsonObject();
            ln.Set("index", index);
            ln.Set("virtual_layer_index", layer.VirtualLayerIndex);
            ln.Set("name", layer.Name);
            ln.Set("weight", (double)layer.DefaultWeight);
            ln.Set("blending", layer.BlendingMode.ToString());
            ln.Set("ik_pass", layer.IKPass);
            ln.Set("synced_layer_index", layer.SyncedLayerIndex);
            ln.Set("avatar_mask", layer.AvatarMask == null ? null : layer.AvatarMask.Name);

            var states = new List<object>();
            var machines = new List<object>();
            Walk(layer.Name, layer.StateMachine, "", states, machines, flatBindings);
            ln.Set("states", states);
            ln.Set("state_machines", machines);
            ln.Set("state_count", states.Count);
            return ln;
        }

        private static void Walk(string layerName, VirtualStateMachine sm, string parentPath,
            List<object> states, List<object> machines, List<object> flatBindings)
        {
            if (sm == null) return;
            var machinePath = string.IsNullOrEmpty(parentPath) ? sm.Name : parentPath + "/" + sm.Name;

            var mn = new JsonObject();
            mn.Set("path", machinePath);
            mn.Set("name", sm.Name);
            mn.Set("default_state", sm.DefaultState == null ? null : sm.DefaultState.Name);
            machines.Add(mn);

            foreach (var child in sm.States)
            {
                if (child.State == null) continue;
                states.Add(ExportState(layerName, machinePath, child.State, flatBindings));
            }
            foreach (var sub in sm.StateMachines)
            {
                Walk(layerName, sub.StateMachine, machinePath, states, machines, flatBindings);
            }
        }

        private static JsonObject ExportState(string layerName, string machinePath, VirtualState state, List<object> flatBindings)
        {
            var sn = new JsonObject();
            sn.Set("name", state.Name);
            sn.Set("machine", machinePath);
            sn.Set("write_defaults", state.WriteDefaultValues);
            sn.Set("speed", (double)state.Speed);
            sn.Set("tag", state.Tag);
            sn.Set("motion", MotionRef(state.Motion));

            var clip = state.Motion as VirtualClip;
            if (clip != null)
            {
                sn.Set("clip", clip.Name);
                var curves = ExportCurves(layerName, state.Name, clip, flatBindings);
                sn.Set("curves", curves);
                sn.Set("curve_count", curves.Count);
            }

            var transitions = new List<object>();
            foreach (var t in state.Transitions) transitions.Add(ExportTransition(t));
            sn.Set("transitions", transitions);
            return sn;
        }

        private static string MotionRef(VirtualMotion motion)
        {
            if (motion == null) return null;
            var clip = motion as VirtualClip;
            if (clip != null) return "clip:" + clip.Name;
            var tree = motion as VirtualBlendTree;
            if (tree != null) return "blendtree:" + tree.Name;
            return motion.GetType().Name + ":" + motion.Name;
        }

        private static List<object> ExportCurves(string layerName, string stateName, VirtualClip clip, List<object> flatBindings)
        {
            var curves = new List<object>();
            try
            {
                foreach (var binding in clip.GetFloatCurveBindings())
                {
                    var curve = clip.GetFloatCurve(binding);
                    var keys = new List<object>();
                    bool constant = true;
                    double constValue = 0d;
                    if (curve != null && curve.keys != null && curve.keys.Length > 0)
                    {
                        constValue = curve.keys[0].value;
                        foreach (var k in curve.keys)
                        {
                            keys.Add(new JsonObject().Set("t", (double)k.time).Set("v", (double)k.value));
                            if (Mathf.Abs(k.value - (float)constValue) > 1e-6f) constant = false;
                        }
                    }
                    var cn = new JsonObject();
                    cn.Set("path", binding.path);
                    cn.Set("type", binding.type == null ? null : binding.type.Name);
                    cn.Set("property", binding.propertyName);
                    cn.Set("kind", "float");
                    cn.Set("constant", constant);
                    if (constant) cn.Set("value", constValue);
                    cn.Set("keys", keys);
                    curves.Add(cn);
                    flatBindings.Add(BindingRow(layerName, stateName, binding.path,
                        binding.type == null ? null : binding.type.Name, binding.propertyName, "float", constant, constValue));
                }

                foreach (var binding in clip.GetObjectCurveBindings())
                {
                    var curve = clip.GetObjectCurve(binding);
                    var values = new List<object>();
                    if (curve != null)
                    {
                        foreach (var k in curve)
                        {
                            values.Add(new JsonObject()
                                .Set("t", (double)k.time)
                                .Set("value", ObjectPath(k.value))
                                .Set("asset_path", AssetPath(k.value))
                                .Set("name", k.value == null ? null : k.value.name));
                        }
                    }
                    var cn = new JsonObject();
                    cn.Set("path", binding.path);
                    cn.Set("type", binding.type == null ? null : binding.type.Name);
                    cn.Set("property", binding.propertyName);
                    cn.Set("kind", "object");
                    cn.Set("values", values);
                    curves.Add(cn);
                    flatBindings.Add(BindingRow(layerName, stateName, binding.path,
                        binding.type == null ? null : binding.type.Name, binding.propertyName, "object", null, null));
                }
            }
            catch (Exception e)
            {
                AuditBuildCapture.Note("导出 clip " + clip.Name + " 曲线失败：" + e.Message);
            }
            return curves;
        }

        private static JsonObject BindingRow(string layer, string state, string path, string type, string property,
            string kind, bool? constant, double? value)
        {
            var o = new JsonObject();
            o.Set("layer", layer);
            o.Set("state", state);
            o.Set("path", path);
            o.Set("type", type);
            o.Set("property", property);
            o.Set("kind", kind);
            if (constant.HasValue) o.Set("constant", constant.Value);
            if (value.HasValue) o.Set("value", value.Value);
            return o;
        }

        private static JsonObject ExportTransition(VirtualTransitionBase t)
        {
            var tn = new JsonObject();
            tn.Set("name", t.Name);
            tn.Set("is_exit", t.IsExit);
            tn.Set("mute", t.Mute);
            tn.Set("solo", t.Solo);
            tn.Set("destination_state", t.DestinationState == null ? null : t.DestinationState.Name);
            tn.Set("destination_state_machine", t.DestinationStateMachine == null ? null : t.DestinationStateMachine.Name);

            var conds = new List<object>();
            foreach (var c in t.Conditions)
            {
                var cn = new JsonObject();
                cn.Set("parameter", c.parameter);
                cn.Set("mode", c.mode.ToString());
                cn.Set("threshold", (double)c.threshold);
                conds.Add(cn);
            }
            tn.Set("conditions", conds);

            var st = t as VirtualStateTransition;
            if (st != null)
            {
                tn.Set("duration", (double)st.Duration);
                tn.Set("has_fixed_duration", st.HasFixedDuration);
                tn.Set("ordered_interruption", st.OrderedInterruption);
                if (st.ExitTime.HasValue)
                {
                    tn.Set("has_exit_time", true);
                    tn.Set("exit_time", (double)st.ExitTime.Value);
                }
                else tn.Set("has_exit_time", false);
            }
            return tn;
        }

        private static string ObjectPath(Object o)
        {
            if (o == null) return null;
            try
            {
                var reference = ObjectRegistry.GetReference(o);
                if (reference != null && !string.IsNullOrEmpty(reference.Path)) return reference.Path;
            }
            catch { }
            return AssetPath(o) ?? o.name;
        }

        private static string AssetPath(Object o)
        {
            if (o == null) return null;
            try
            {
                var p = AssetDatabase.GetAssetPath(o);
                return string.IsNullOrEmpty(p) ? null : p;
            }
            catch { return null; }
        }
    }
}
