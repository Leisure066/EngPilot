using System.Diagnostics;
using System.IO;

namespace Zhanci.Services;

/// <summary>Filesystem and runtime locations used by the desktop shell.</summary>
public static class AppPaths
{
    public static string AppRoot { get; }
    public static string UserDataDirectory { get; }
    public static string LogDirectory { get; }
    public static string WebViewDataDirectory { get; }
    public static string DataDirectory { get; }
    public static string NodeExecutable { get; }

    static AppPaths()
    {
        AppRoot = FindAppRoot();
        // ENGPILOT_HOME is the documented variable; ZHANCI_HOME is the old
        // name and still honoured so existing shortcuts keep working.
        var customHome = Environment.GetEnvironmentVariable("ENGPILOT_HOME")
                         ?? Environment.GetEnvironmentVariable("ZHANCI_HOME");
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        if (!string.IsNullOrWhiteSpace(customHome))
        {
            UserDataDirectory = Path.GetFullPath(customHome);
        }
        else if (!string.IsNullOrWhiteSpace(localAppData)
                 && IsWritable(Path.Combine(localAppData, "EngPilot")))
        {
            UserDataDirectory = Path.Combine(localAppData, "EngPilot");
        }
        else
        {
            // GetFolderPath can come back empty under service/AppContainer
            // tokens, and the folder can exist yet stay unwritable under
            // restricted sandboxes. WebView2 refuses to start in either case
            // (0x8000FFFF), so fall back to a folder next to the app.
            UserDataDirectory = Path.Combine(AppRoot, ".userdata");
        }
        LogDirectory = Path.Combine(UserDataDirectory, "logs");
        WebViewDataDirectory = Path.Combine(UserDataDirectory, "WebView2");
        DataDirectory = Directory.Exists(Path.Combine(AppRoot, "data"))
            ? Path.Combine(AppRoot, "data")
            : Path.Combine(UserDataDirectory, "data");
        NodeExecutable = FindNode();
    }

    /// <summary>
    /// True when <paramref name="directory"/> can be created and written to.
    /// WebView2 needs a writable user-data folder; if the probe fails we must
    /// pick a different location *before* the browser is created.
    /// </summary>
    private static bool IsWritable(string directory)
    {
        try
        {
            Directory.CreateDirectory(directory);
            var probe = Path.Combine(directory, ".write-probe");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
            return true;
        }
        catch
        {
            return false;
        }
    }

    public static void EnsureDirectories()
    {
        foreach (var dir in new[] { UserDataDirectory, LogDirectory, WebViewDataDirectory, DataDirectory })
        {
            try { Directory.CreateDirectory(dir); } catch { /* best effort */ }
        }
    }

    public static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(LogDirectory);
            var line = $"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff}] {message}{Environment.NewLine}";
            File.AppendAllText(Path.Combine(LogDirectory, "engpilot.log"), line);
        }
        catch { /* logging must never take the app down */ }
    }

    private static string FindAppRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; depth < 8 && current is not null; depth++, current = current.Parent)
        {
            var root = current.FullName;
            var hasServer = File.Exists(Path.Combine(root, "server.js")) ||
                            File.Exists(Path.Combine(root, "server", "app.js"));
            if (hasServer && Directory.Exists(Path.Combine(root, "public")))
            {
                return root;
            }
        }

        return AppContext.BaseDirectory;
    }

    private static string FindNode()
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "node.exe");
        if (File.Exists(bundled)) return bundled;

        try
        {
            var start = new ProcessStartInfo("where.exe", "node")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var process = Process.Start(start);
            if (process is not null)
            {
                var output = process.StandardOutput.ReadToEnd();
                process.WaitForExit(3000);
                var first = output
                    .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(line => line.Trim())
                    .FirstOrDefault(line => line.EndsWith("node.exe", StringComparison.OrdinalIgnoreCase));
                if (!string.IsNullOrWhiteSpace(first) && File.Exists(first)) return first;
            }
        }
        catch (Exception ex)
        {
            Log("Node lookup failed: " + ex.Message);
        }

        return "node";
    }
}