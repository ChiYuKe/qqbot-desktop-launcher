$ErrorActionPreference = 'Stop'

# 隐藏控制台窗口，双击运行时不再出现黑框
try {
    Add-Type -Namespace Native -Name ConsoleUtil -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
    $hWnd = [Native.ConsoleUtil]::GetConsoleWindow()
    if ($hWnd -ne [System.IntPtr]::Zero) {
        [void][Native.ConsoleUtil]::ShowWindow($hWnd, 0)  # SW_HIDE
    }
} catch {
    # 隐藏失败时忽略，继续正常启动
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $root 'admin\desktop')
npm run desktop
