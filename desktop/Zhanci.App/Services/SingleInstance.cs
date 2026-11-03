using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Zhanci.Services;

public static class SingleInstance
{
    public const string MutexName = @"Local\EngPilot.Desktop.SingleInstance";

    private const int SwRestore = 9;

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    /// <summary>Brings the already running instance to the foreground, if any.</summary>
    public static bool ActivateRunningInstance()
    {
        var current = Process.GetCurrentProcess();
        foreach (var process in Process.GetProcessesByName(current.ProcessName))
        {
            using (process)
            {
                if (process.Id == current.Id) continue;

                process.Refresh();
                var handle = process.MainWindowHandle;
                if (handle == IntPtr.Zero) continue;

                if (IsIconic(handle)) ShowWindow(handle, SwRestore);
                SetForegroundWindow(handle);
                return true;
            }
        }

        return false;
    }
}