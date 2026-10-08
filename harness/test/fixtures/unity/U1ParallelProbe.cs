using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace AVH.Harness
{
    /// Reports that the step's own code ran, at which integrity level, and can hold the editor open so another editor
    /// can be started while this one is still running. Used by test/exec/unity-parallel.test.ts: the marker proves the
    /// method really executed, and the integrity level proves the step's Windows Low boundary was in force.
    public static class U1ParallelProbe
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetCurrentProcess();
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);

        private const uint TokenQuery = 0x0008;
        private const int TokenIntegrityLevel = 25;

        private static string Integrity()
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), TokenQuery, out token)) return "unknown";
            int length;
            GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out length);
            if (length <= 0) return "unknown";
            IntPtr buffer = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, length, out length)) return "unknown";
                int rid = Marshal.ReadInt32(Marshal.ReadIntPtr(buffer), 8);
                if (rid == 0x1000) return "low";
                if (rid == 0x2000) return "medium";
                if (rid == 0x3000) return "high";
                return "rid:0x" + rid.ToString("x");
            }
            catch (Exception error) { return "error:" + error.GetType().Name; }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        public static void Run()
        {
            string output = Environment.GetEnvironmentVariable("AVH_U1_OUT");
            if (string.IsNullOrEmpty(output)) throw new InvalidOperationException("AVH_U1_OUT is required");
            string label = Environment.GetEnvironmentVariable("AVH_U1_LABEL") ?? "step";
            int holdMs = 0;
            int.TryParse(Environment.GetEnvironmentVariable("AVH_U1_HOLD_MS") ?? "0", out holdMs);
            string me = label + " integrity=" + Integrity() + " pid=" + System.Diagnostics.Process.GetCurrentProcess().Id;
            // Epoch milliseconds on both sides: the test proves two editors really overlapped from the editors' own
            // clocks, not from how long the test process happened to wait.
            File.WriteAllText(output + ".ready", me + " start=" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (holdMs > 0) Thread.Sleep(holdMs);
            File.WriteAllText(output + ".done", me + " end=" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (Application.isBatchMode) EditorApplication.Exit(0);
        }
    }
}
