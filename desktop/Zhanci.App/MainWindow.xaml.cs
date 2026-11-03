using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Zhanci.Services;

namespace Zhanci;

public partial class MainWindow : Window
{
    private readonly BackendHost _backend = new();
    private TrayIcon? _tray;
    private HwndSource? _hwndSource;
    private bool _closing;
    private bool _starting;
    private bool _webViewReady;
    private bool _loadedOnce;

    public MainWindow()
    {
        InitializeComponent();
        SourceInitialized += OnSourceInitialized;
        Loaded += OnLoaded;
        Closing += OnClosing;
        StateChanged += OnStateChanged;
    }

    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        _hwndSource = HwndSource.FromHwnd(hwnd);
        _hwndSource?.AddHook(WndProc);

        WindowEffects.ApplyRoundedCorners(hwnd);
        WindowEffects.ApplyDarkMode(hwnd, false);
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (_loadedOnce) return;
        _loadedOnce = true;

        CenterOnScreen();

        _tray = new TrayIcon(
            show: () =>
            {
                Show();
                if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
                Activate();
            },
            openLogs: () => OpenFolder(AppPaths.LogDirectory),
            exit: Close);

        // A GUI launched from a background job can inherit a minimised start
        // state; make sure the window is visible and focused either way.
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();

        await StartAsync();
    }

    private void CenterOnScreen()
    {
        var area = SystemParameters.WorkArea;
        var width = ActualWidth > 0 ? ActualWidth : Width;
        var height = ActualHeight > 0 ? ActualHeight : Height;

        var left = area.Left + Math.Max(0, (area.Width - width) / 2);
        var top = area.Top + Math.Max(0, (area.Height - height) / 2);

        // Never place the window outside the visible work area. The work area
        // can report odd values under mixed-DPI setups, so clamp against the
        // physical screen origin as a last resort.
        var maxLeft = Math.Max(0, area.Right - width);
        var maxTop = Math.Max(0, area.Bottom - height);
        Left = Math.Min(Math.Max(left, 0), maxLeft);
        Top = Math.Min(Math.Max(top, 0), maxTop);
    }

    private async Task StartAsync()
    {
        if (_starting) return;
        _starting = true;
        ShowLoading("正在启动词库…");

        try
        {
            await _backend.StartAsync();
            ShowLoading("正在加载界面…");
            await EnsureWebViewAsync();
            WebView.CoreWebView2.Navigate(_backend.BaseUrl + "/");
        }
        catch (Exception ex)
        {
            AppPaths.Log("Startup failed: " + ex);
            ShowError("界面没有加载出来", DescribeStartupError(ex));
        }
        finally
        {
            _starting = false;
        }
    }

    private async Task EnsureWebViewAsync()
    {
        if (_webViewReady) return;

        var environment = await CoreWebView2Environment.CreateAsync(null, AppPaths.WebViewDataDirectory);
        await WebView.EnsureCoreWebView2Async(environment);

        var core = WebView.CoreWebView2;
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = true;

        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            OpenExternal(args.Uri);
        };
        core.NavigationCompleted += OnNavigationCompleted;

        WebView.DefaultBackgroundColor = System.Drawing.Color.FromArgb(245, 246, 251);
        _webViewReady = true;
    }

    private async void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            LoadingOverlay.Visibility = Visibility.Collapsed;
            ErrorOverlay.Visibility = Visibility.Collapsed;

            // WebView2 can restore a stale scroll offset between runs; a fresh
            // launch should always start at the top of the page.
            try
            {
                await Task.Delay(120);
                await WebView.CoreWebView2.ExecuteScriptAsync("window.scrollTo(0, 0);");
            }
            catch (Exception ex)
            {
                AppPaths.Log("Scroll reset failed: " + ex.Message);
            }

            return;
        }

        ShowError("界面没有加载出来", "WebView2 导航失败：" + e.WebErrorStatus);
    }

    private void ShowLoading(string text)
    {
        LoadingText.Text = text;
        LoadingOverlay.Visibility = Visibility.Visible;
        ErrorOverlay.Visibility = Visibility.Collapsed;
    }

    private void ShowError(string title, string detail)
    {
        ErrorTitle.Text = title;
        ErrorDetail.Text = detail;
        LoadingOverlay.Visibility = Visibility.Collapsed;
        ErrorOverlay.Visibility = Visibility.Visible;
    }

    /// <summary>Turns the raw HRESULT into something a user can act on.</summary>
    private static string DescribeStartupError(Exception ex)
    {
        if (ex is COMException com && (uint)com.HResult == 0x8000FFFF)
        {
            return "WebView2 初始化失败（0x8000FFFF）。常见原因是数据目录不可写、被另一个实例占用，或运行环境缺少 WebView2 Runtime。\n"
                + $"程序目录：{AppPaths.AppRoot}\n"
                + $"数据目录：{AppPaths.WebViewDataDirectory}\n"
                + "程序会自动改用程序目录下的 .userdata；若仍失败，把环境变量 ENGPILOT_HOME 指向一个可写目录后启动。";
        }

        return ex.Message;
    }

    private async void Retry_Click(object sender, RoutedEventArgs e)
    {
        ErrorOverlay.Visibility = Visibility.Collapsed;
        try
        {
            await _backend.StopAsync();
        }
        catch (Exception ex)
        {
            AppPaths.Log("Stop during retry failed: " + ex.Message);
        }

        if (_webViewReady && WebView.CoreWebView2 is not null)
        {
            await StartAsync();
        }
        else
        {
            await StartAsync();
        }
    }

    private void OpenLogs_Click(object sender, RoutedEventArgs e) => OpenFolder(AppPaths.LogDirectory);

    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void Maximize_Click(object sender, RoutedEventArgs e) =>
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private void OnStateChanged(object? sender, EventArgs e)
    {
        if (MaximizeButton is null) return;
        MaximizeButton.Content = WindowState == WindowState.Maximized ? "\uE923" : "\uE922";
        MaximizeButton.ToolTip = WindowState == WindowState.Maximized ? "还原" : "最大化";
    }

    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_closing) return;
        _closing = true;

        try
        {
            _tray?.Dispose();
            _tray = null;
            _hwndSource?.RemoveHook(WndProc);
            _backend.DisposeAsync().AsTask().Wait(4000);
        }
        catch (Exception ex)
        {
            AppPaths.Log("Shutdown failed: " + ex.Message);
        }
    }

    private static void OpenFolder(string path)
    {
        try
        {
            Directory.CreateDirectory(path);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppPaths.Log("Open folder failed: " + ex.Message);
        }
    }

    private static void OpenExternal(string? uri)
    {
        if (string.IsNullOrWhiteSpace(uri)) return;
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return;
        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return;

        try
        {
            Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppPaths.Log("Open external failed: " + ex.Message);
        }
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (WindowEffects.TryHandleMaximisedBounds(hwnd, msg, lParam, out _))
        {
            handled = true;
        }

        return IntPtr.Zero;
    }
}