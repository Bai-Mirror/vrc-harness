using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using AVH.Harness;
using UnityEditor;
using UnityEngine;

public static class UnityPathIdentityIntegration
{
    static void Check(bool value, string reason) { if (!value) throw new Exception(reason); }
    static void Refuses(Action action)
    { try { action(); } catch (InvalidOperationException) { return; } throw new Exception("Foreign binding accepted"); }
    public static void SourceRun()
    {
        try
        {
            const string relative = "Assets/Source/identity.dat";
            var resolve = typeof(Avh).GetMethod("PhysicalDirectory", BindingFlags.NonPublic | BindingFlags.Static);
            var physical = (string)resolve.Invoke(null, new object[] { Avh.IdentityAbs(relative) });
            var source = new Dictionary<string, object> { ["path"] = physical, ["sha256"] = FaceStage.FileHash(relative) };
            Check(FaceStage.SourceMatches(source, relative), "Same physical source spelling was rejected");
            source["path"] = physical.ToUpperInvariant();
            Check(FaceStage.SourceMatches(source, relative), "Windows source case was rejected");
            source["path"] = Avh.Abs("Assets/Source/../Source/identity.dat");
            Check(FaceStage.SourceMatches(source, relative), "Owned alias with normalized segments was rejected");
            source["path"] = Avh.IdentityAbs("Assets/Source/copy.dat");
            Check(!FaceStage.SourceMatches(source, relative), "Different file with identical SHA was accepted");
            source["path"] = physical; source["sha256"] = new string('0', 64);
            Check(!FaceStage.SourceMatches(source, relative), "Different SHA was accepted");
            source["sha256"] = FaceStage.FileHash(relative);
            var original = File.ReadAllBytes(Avh.Abs(relative));
            try { File.AppendAllText(Avh.Abs(relative), "changed"); Check(!FaceStage.SourceMatches(source, relative), "Changed file bytes were accepted"); }
            finally { File.WriteAllBytes(Avh.Abs(relative), original); }
            source["path"] = Avh.Abs("_harness/Linked/identity.dat");
            Refuses(() => FaceStage.SourceMatches(source, relative));
            source["path"] = Avh.Env("AVH_PROBE_OUTSIDE");
            Check(!FaceStage.SourceMatches(source, relative), "Outside link reaching the same file was accepted");
            source["path"] = "Assets/Source/identity.dat";
            Check(!FaceStage.SourceMatches(source, relative), "Nonabsolute catalog authority was accepted");
            Avh.WriteJson(Avh.Env("AVH_PROBE_OUTPUT"), new Dictionary<string, object> { ["ok"] = true, ["checks"] = 9 });
            EditorApplication.Exit(0);
        }
        catch (Exception error)
        {
            Avh.WriteJson(Avh.Env("AVH_PROBE_OUTPUT"), new Dictionary<string, object> { ["ok"] = false, ["error"] = error.Message });
            Debug.LogError(error); EditorApplication.Exit(1);
        }
    }
    public static void Run()
    {
        try
        {
            var physical = Avh.Env("AVH_PHYSICAL_PROJECT_DIR");
            Check(Avh.ProjectIdentityDir == physical, "Owned alias must retain the Runtime identity spelling");
            Avh.AssertManagedPath(Avh.Abs("Assets/Editor/AvhCommon.cs"));
            var resolve = typeof(Avh).GetMethod("PhysicalDirectory", BindingFlags.NonPublic | BindingFlags.Static);
            var resolved = (string)resolve.Invoke(null, new object[] { physical });
            var nonce = Avh.Env("AVH_UNITY_ALIAS_NONCE");
            Environment.SetEnvironmentVariable("AVH_UNITY_ALIAS_NONCE", "foreign-nonce");
            Refuses(() => { var ignored = Avh.ProjectIdentityDir; });
            Environment.SetEnvironmentVariable("AVH_UNITY_ALIAS_NONCE", nonce);
            Environment.SetEnvironmentVariable("AVH_PHYSICAL_PROJECT_DIR", Path.GetDirectoryName(physical));
            Refuses(() => { var ignored = Avh.ProjectIdentityDir; });
            Environment.SetEnvironmentVariable("AVH_PHYSICAL_PROJECT_DIR", physical);
            Avh.WriteJson(Avh.Env("AVH_PROBE_OUTPUT"), new Dictionary<string, object> {
                ["ok"] = true, ["checks"] = 4,
                ["physicalSpellingDiffers"] = !string.Equals(resolved, physical, StringComparison.OrdinalIgnoreCase)
            });
            EditorApplication.Exit(0);
        }
        catch (Exception error) { Debug.LogError(error); EditorApplication.Exit(1); }
    }
}
