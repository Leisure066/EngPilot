using System.Threading;
using System.Windows;
using Zhanci.Services;

namespace Zhanci;

public partial class App : System.Windows.Application
{
    private Mutex? _instanceMutex;
    private bool _ownsMutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        AppPaths.EnsureDirectories();

        _instanceMutex = new Mutex(initiallyOwned: true, SingleInstance.MutexName, out var createdNew);
        _ownsMutex = createdNew;

        if (!createdNew)
        {
            SingleInstance.ActivateRunningInstance();
            Shutdown();
            return;
        }

        DispatcherUnhandledException += (_, args) =>
        {
            AppPaths.Log("Unhandled UI exception: " + args.Exception);
            System.Windows.MessageBox.Show(
                "EngPilot 遇到了一个未处理的错误：\n\n" + args.Exception.Message,
                "EngPilot",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            args.Handled = true;
        };

        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
            AppPaths.Log("Unhandled domain exception: " + args.ExceptionObject);

        base.OnStartup(e);

        var window = new MainWindow();
        MainWindow = window;
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        if (_ownsMutex)
        {
            try { _instanceMutex?.ReleaseMutex(); } catch { /* already released */ }
        }

        _instanceMutex?.Dispose();
        base.OnExit(e);
    }
}