using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;

namespace Zhanci.Services;

/// <summary>
/// Owns the local Node process that serves the word lab UI and the v1 JSON API.
/// </summary>
public sealed class BackendHost : IAsyncDisposable
{
    private const string RelativeServerPath = @"server\app.js";

    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private Process? _process;
    private ProcessJob? _job;
    private readonly StringBuilder _recentOutput = new();

    public int Port { get; private set; }
    public string BaseUrl => $"http://127.0.0.1:{Port}";

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        var serverJs = Path.Combine(AppPaths.AppRoot, RelativeServerPath);
        if (!File.Exists(serverJs))
        {
            throw new FileNotFoundException(
                $"找不到 server\\app.js。应用目录：{AppPaths.AppRoot}", serverJs);
        }

        lock (_recentOutput) { _recentOutput.Clear(); }

        Port = FindFreePort();
        AppPaths.Log($"Starting backend on port {Port}: {AppPaths.NodeExecutable} {serverJs}");

        var startInfo = new ProcessStartInfo
        {
            FileName = AppPaths.NodeExecutable,
            Arguments = $"\"{serverJs}\"",
            WorkingDirectory = AppPaths.AppRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        startInfo.Environment["PORT"] = Port.ToString();

        _process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("无法启动本地词库服务（Node 进程创建失败）。");

        // Make the Node process die with us even if the shell is force-killed.
        _job?.Dispose();
        _job = ProcessJob.Create();
        if (_job is null || !_job.Attach(_process))
        {
            AppPaths.Log("Backend is not job-bound; a force-kill may orphan node.exe.");
        }

        _process.OutputDataReceived += (_, args) => Capture(args.Data);
        _process.ErrorDataReceived += (_, args) => Capture(args.Data);
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();

        await WaitForHealthyAsync(cancellationToken).ConfigureAwait(false);
        AppPaths.Log($"Backend is healthy at {BaseUrl}");
    }

    private void Capture(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        lock (_recentOutput)
        {
            _recentOutput.AppendLine(line);
            if (_recentOutput.Length > 8000) _recentOutput.Remove(0, _recentOutput.Length - 6000);
        }

        AppPaths.Log("[node] " + line);
    }

    private async Task WaitForHealthyAsync(CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow.AddSeconds(25);
        Exception? last = null;

        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_process is { HasExited: true })
            {
                throw new InvalidOperationException(
                    "本地词库服务启动后立即退出。\n\n" + TailOfOutput());
            }

            try
            {
                using var response = await _http.GetAsync($"{BaseUrl}/api/v1/health", cancellationToken)
                    .ConfigureAwait(false);
                if (response.IsSuccessStatusCode) return;
            }
            catch (Exception ex)
            {
                last = ex;
            }

            await Task.Delay(250, cancellationToken).ConfigureAwait(false);
        }

        throw new TimeoutException(
            "本地词库服务在 25 秒内没有就绪。\n\n" +
            (last?.Message ?? "没有收到健康检查响应。") + "\n\n" + TailOfOutput());
    }

    private string TailOfOutput()
    {
        lock (_recentOutput)
        {
            return _recentOutput.Length == 0
                ? "（服务没有输出任何内容）"
                : "服务输出：\n" + _recentOutput.ToString().Trim();
        }
    }

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    /// <summary>Stops the Node process but keeps the host reusable for a retry.</summary>
    public async ValueTask StopAsync()
    {
        if (_process is null) return;

        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
                await _process.WaitForExitAsync(new CancellationTokenSource(3000).Token)
                    .ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            AppPaths.Log("Failed to stop backend: " + ex.Message);
        }
        finally
        {
            _process.Dispose();
            _process = null;
            _job?.Dispose();
            _job = null;
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
        _http.Dispose();
    }
}