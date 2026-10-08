/**
 * 【项目沉淀】通用工具
 * 适用素体：无关
 * 相关素材：工程场景 + AvatarAudit 数据
 * 工具链　：Unity 2022.3.22f1 / VRChat SDK 3.10.4
 * 可复用性：★★ 审查工具链的一环
 * 用途　　：批处理入口：无界面跑部件盘点（含 key_follow）并导出 inventory.json，只读不存场景。
 */
// 批处理入口：无界面跑部件盘点（含 key_follow）。
// 用法：Unity -batchmode -projectPath <工程> -executeMethod AvatarAudit.AuditBatch.ExportInventory
//             -auditScene Assets/xxx.unity -auditOut /abs/inventory.json -logFile <log> -quit
// 只读：打开场景、导出、退出；不保存场景。退出码 0 成功，1 失败（原因写进日志 [AuditBatch] 行）。
using System;
using UnityEditor;
using UnityEditor.SceneManagement;

namespace AvatarAudit
{
    public static class AuditBatch
    {
        public static void ExportInventory()
        {
            int code = 0;
            try
            {
                string scene = Arg("-auditScene");
                string outPath = Arg("-auditOut");
                if (string.IsNullOrEmpty(scene) || string.IsNullOrEmpty(outPath))
                    throw new ArgumentException("需要 -auditScene 与 -auditOut");
                EditorSceneManager.OpenScene(scene, OpenSceneMode.Single);
                string written = AuditPartInventory.Export(outPath);
                UnityEngine.Debug.Log("[AuditBatch] ok scene=" + scene + " out=" + written);
            }
            catch (Exception e)
            {
                code = 1;
                UnityEngine.Debug.LogError("[AuditBatch] fail: " + e);
            }
            EditorApplication.Exit(code);
        }

        static string Arg(string name)
        {
            var a = Environment.GetCommandLineArgs();
            for (int i = 0; i < a.Length - 1; i++)
                if (a[i] == name) return a[i + 1];
            return null;
        }
    }
}
