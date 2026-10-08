using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
namespace AVH.Harness
{
 public static class MenuSelectorIntegration
 {
  static int assertions;
  static void Require(bool ok,string message){assertions++;if(!ok)throw new Exception(message);}
  static Transform Child(string name,Transform parent){var t=new GameObject(name).transform;t.SetParent(parent,false);return t;}
  public static void Run(){try{
   var avatar=new GameObject("Avatar");var outfit=Child("Outfit",avatar.transform);var other=Child("Other",avatar.transform);
   var hat=Child("Hat",outfit);hat.gameObject.SetActive(false);
   var knife=Child("Knife",outfit);knife.gameObject.tag="EditorOnly";
   var excluded=Child("Excluded",outfit);excluded.gameObject.tag="EditorOnly";Child("Nested",excluded);
   var entry=new Dictionary<string,object>{["object"]="Outfit",["bone_proxy_visuals"]=new List<object>{"Outfit/Hat","Outfit/Knife","Outfit/Excluded/Nested"},["default"]=true};
   var entries=new List<Dictionary<string,object>>{entry,new Dictionary<string,object>{["object"]="Other",["bone_proxy_visuals"]=new List<object>(),["default"]=false}};
   var roots=new List<Transform>{outfit,other};
   var selected=MenuStage.SelectorTargets(avatar,entries,roots);
   Require(selected.Count==3,"Excluded visual survived selector ownership");
   Require(selected.Any(x=>x.target==hat),"Inactive retained visual lost selector ownership");
   var menu=Child("Menu",avatar.transform).gameObject;
   var method=typeof(MenuStage).GetMethod("InstallSelectorController",BindingFlags.NonPublic|BindingFlags.Static);
   var controller=(AnimatorController)method.Invoke(null,new object[]{avatar,menu,entries,entry,roots,"Fixture/Outfit",true});
   var clip=(AnimationClip)controller.layers[0].stateMachine.defaultState.motion;
   var bindings=AnimationUtility.GetCurveBindings(clip);
   Require(bindings.Select(b=>b.path).OrderBy(x=>x).SequenceEqual(new[]{"Other","Outfit","Outfit/Hat"}),"Production clip contains excluded or missing targets");
   Require(bindings.All(b=>b.propertyName=="m_IsActive"),"Unexpected selector property");
   Require(AnimationUtility.GetEditorCurve(clip,bindings.First(b=>b.path=="Outfit/Hat")).Evaluate(0.25f)==1,"Inactive visual not enabled in its own slot");
   Require(AnimationUtility.GetEditorCurve(clip,bindings.First(b=>b.path=="Outfit/Hat")).Evaluate(0.75f)==0,"Retained visual leaked to another outfit");
   entry["bone_proxy_visuals"]=new List<object>{"Missing"};bool refused=false;try{MenuStage.SelectorTargets(avatar,entries,roots);}catch{refused=true;}Require(refused,"Missing path silently accepted");
   entry["bone_proxy_visuals"]=new List<object>();outfit.gameObject.tag="EditorOnly";refused=false;try{MenuStage.SelectorTargets(avatar,entries,roots);}catch{refused=true;}Require(refused,"Excluded whole outfit offered by selector");
   Avh.WriteJson(Avh.Abs("result.json"),new Dictionary<string,object>{["ok"]=true,["assertions"]=assertions});EditorApplication.Exit(0);
  }catch(Exception e){Avh.WriteJson(Avh.Abs("result.json"),new Dictionary<string,object>{["ok"]=false,["error"]=e.ToString(),["assertions"]=assertions});Debug.LogException(e);EditorApplication.Exit(1);}}
 }
}
