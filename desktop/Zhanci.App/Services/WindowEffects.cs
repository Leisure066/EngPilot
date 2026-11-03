using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Zhanci.Services;

/// <summary>Win32/DWM helpers for the frameless window (rounded corners, dark mode, maximised bounds).</summary>
public static class WindowEffects
{
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmwaSystemBackdropType = 38;

    private const int DwmwcpRound = 2;
    private const int DwmsbtMainWindow = 2; // Mica
    private const int DwmsbtTransientWindow = 3; // Acrylic

    private const int WmGetMinMaxInfo = 0x0024;
    private const uint MonitorDefaultToNearest = 0x00000002;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor;
        public Rect Work;
        public int Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MinMaxInfo
    {
        public Point Reserved;
        public Point MaxSize;
        public Point MaxPosition;
        public Point MinTrackSize;
        public Point MaxTrackSize;
    }

    public static void ApplyRoundedCorners(IntPtr hwnd)
    {
        var preference = DwmwcpRound;
        TrySet(hwnd, DwmwaWindowCornerPreference, preference);
    }

    public static void ApplyDarkMode(IntPtr hwnd, bool dark)
    {
        var value = dark ? 1 : 0;
        TrySet(hwnd, DwmwaUseImmersiveDarkMode, value);
    }

    /// <summary>Attempts Mica. Returns false when the OS or composition does not support it.</summary>
    public static bool TryEnableMica(IntPtr hwnd)
    {
        var value = DwmsbtMainWindow;
        try
        {
            return DwmSetWindowAttribute(hwnd, DwmwaSystemBackdropType, ref value, sizeof(int)) == 0;
        }
        catch
        {
            return false;
        }
    }

    public static bool TryEnableAcrylic(IntPtr hwnd)
    {
        var value = DwmsbtTransientWindow;
        try
        {
            return DwmSetWindowAttribute(hwnd, DwmwaSystemBackdropType, ref value, sizeof(int)) == 0;
        }
        catch
        {
            return false;
        }
    }

    private static void TrySet(IntPtr hwnd, int attribute, int value)
    {
        try { DwmSetWindowAttribute(hwnd, attribute, ref value, sizeof(int)); }
        catch { /* older Windows builds simply ignore it */ }
    }

    /// <summary>True when the window message is WM_GETMINMAXINFO and the bounds were rewritten.</summary>
    public static bool TryHandleMaximisedBounds(IntPtr hwnd, int message, IntPtr lParam, out IntPtr result)
    {
        result = IntPtr.Zero;
        if (message != WmGetMinMaxInfo) return false;

        try
        {
            var info = Marshal.PtrToStructure<MinMaxInfo>(lParam);
            var monitor = MonitorFromWindow(hwnd, MonitorDefaultToNearest);
            var monitorInfo = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
            if (monitor != IntPtr.Zero && GetMonitorInfo(monitor, ref monitorInfo))
            {
                var work = monitorInfo.Work;
                var bounds = monitorInfo.Monitor;
                info.MaxPosition.X = work.Left - bounds.Left;
                info.MaxPosition.Y = work.Top - bounds.Top;
                info.MaxSize.X = work.Right - work.Left;
                info.MaxSize.Y = work.Bottom - work.Top;
                Marshal.StructureToPtr(info, lParam, true);
            }
        }
        catch
        {
            return false;
        }

        return true;
    }

    public static bool IsSystemDark()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int value && value == 0;
        }
        catch
        {
            return false;
        }
    }
}