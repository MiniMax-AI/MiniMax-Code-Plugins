# mcode 灵动岛 - 启动器
# 用法：双击这个脚本，或命令行执行
# 效果：在新进程中以 STA 模式启动 widget，自身立即退出，不留黑窗
# 副作用：把 widget 的 PID 写到 %APPDATA%\mcode-island\widget.pid（status/stop 用）

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$configDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }

$widget = Join-Path $PSScriptRoot 'mcode-island.ps1'
$pidFile = Join-Path $configDir 'widget.pid'

# 防止重复启动：先校验已有 PID 是否真的在跑 widget（不是 PID 复用）
function Test-IsWidgetProcess($proc, $widgetPath) {
  if (-not $proc -or $proc.HasExited) { return $false }
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
  if (-not $cmd) { return $false }
  # CommandLine contains the widget script path (case-insensitive)
  return $cmd.IndexOf($widgetPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($old) {
    $existing = Get-Process -Id ([int]$old) -ErrorAction SilentlyContinue
    if ($existing -and (Test-IsWidgetProcess $existing $widget)) {
      Write-Output ("已在运行（PID " + $old + "）")
      exit 0
    }
    # Stale PID file (process dead or PID reused) — clear and continue
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}

# 新进程启动 widget
$args = @('-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$widget`"")
$proc = Start-Process powershell.exe -ArgumentList $args -PassThru

# 写 PID（先写，后面 status / stop 都靠这个）
Set-Content -Path $pidFile -Value $proc.Id -Encoding ASCII

# 等待 widget 起来（最多 8 秒），用 .ps1 已加载 WPF 窗口作为 readiness 信号
$widgetWindowClass = 'HwndWrapper[DefaultDomain*'  # WPF 窗口类名前缀
$ok = $false
for ($i = 0; $i -lt 16; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $p = Get-Process -Id $proc.Id -ErrorAction Stop
    if ($p.HasExited) { break }
    # WPF widget 启动后会创建主窗口；MainWindowHandle 非 0 即就绪
    if ($p.MainWindowHandle -ne 0) { $ok = $true; break }
  } catch {}
}

if ($ok) {
  Write-Output ("mcode-island 已启动 (PID " + $proc.Id + "，已就绪)")
} else {
  Write-Output ("mcode-island 已启动 (PID " + $proc.Id + "，等待中...)")
}
