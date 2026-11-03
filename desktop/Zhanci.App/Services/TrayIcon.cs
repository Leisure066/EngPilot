using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace Zhanci.Services;

public sealed class TrayIcon : IDisposable
{
    private readonly NotifyIcon _notifyIcon;

    public TrayIcon(Action show, Action openLogs, Action exit)
    {
        Icon icon;
        try
        {
            icon = Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? string.Empty)
                   ?? SystemIcons.Application;
        }
        catch
        {
            icon = SystemIcons.Application;
        }

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开 EngPilot", null, (_, _) => show());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("打开日志目录", null, (_, _) => openLogs());
        menu.Items.Add("退出", null, (_, _) => exit());

        _notifyIcon = new NotifyIcon
        {
            Icon = icon,
            Text = "EngPilot · CET-6 单词实验室",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _notifyIcon.DoubleClick += (_, _) => show();
    }

    public void ShowBalloon(string title, string text)
    {
        try
        {
            _notifyIcon.BalloonTipTitle = title;
            _notifyIcon.BalloonTipText = text;
            _notifyIcon.ShowBalloonTip(2500);
        }
        catch
        {
            // Notifications are best effort.
        }
    }

    public void Dispose()
    {
        try
        {
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
        }
        catch
        {
            // Ignore teardown races.
        }
    }
}