// 【测试夹具】冷导入探针的程序集期望：Unity 从不导入的目录（`Samples~`、点开头）里的定义不得被要求产出 DLL。
// 走真实入口 ColdImportStage.ExpectedAssemblies()，它是 delivery_cold_import_dll 判据的唯一决定函数。
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace AVH.Harness
{
    public static class ColdProbeAssembliesIntegration
    {
        public static void Run()
        {
            var path = Avh.Abs("cold-assemblies-result.json");
            try
            {
                (int expected, List<string> missing) = ColdImportStage.ExpectedAssemblies();
                Avh.WriteJson(path, new Dictionary<string, object>
                {
                    ["ok"] = true,
                    ["expected"] = expected,
                    ["missing"] = missing,
                });
                EditorApplication.Exit(0);
            }
            catch (Exception error)
            {
                Avh.WriteJson(path, new Dictionary<string, object> { ["ok"] = false, ["error"] = error.ToString() });
                Debug.LogException(error);
                EditorApplication.Exit(1);
            }
        }
    }
}
