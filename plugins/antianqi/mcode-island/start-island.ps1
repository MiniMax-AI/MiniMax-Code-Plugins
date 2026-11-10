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

# 新进程启动 widget。
# 用 ProcessStartInfo + CreateNoWindow = $true 是关键：-WindowStyle Hidden 只会设 SW_HIDE 样式，
# 控制台窗口其实还存在，偶尔会冒进任务栏被误关。CreateNoWindow 走 Win32 CREATE_NO_WINDOW，
# 从根上就不生成控制台窗口，任务栏/Alt-Tab 都不会看到。
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'powershell.exe'
$psi.Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -File `"$widget`""
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)

# 写 PID（先写，后面 status / stop 都靠这个）
Set-Content -Path $pidFile -Value $proc.Id -Encoding ASCII

# 等待 widget 就绪（最多 8 秒）。
# 这里原来用 Process.MainWindowHandle != 0 判定就绪，但这个无边框 / always-on-top
# / 透明的 WPF 窗口对 Win32 的 MainWindow 启发式不友好，句柄常年为 0 —— 于是每次
# 启动都误报 "等待中"，哪怕 widget 1 秒后就绪。误报本身无害，但它跟"卡住了"
# 长得很像，排查时很容易把人带偏。widget 会在进入消息循环前先写一行
# "starting Application.Run"，那才是可靠信号。
$widgetLog   = Join-Path $configDir 'widget.log'
$widgetReady = 'starting Application.Run'
# 只认本次启动之后新增的日志行：widget.log 是 append-only 的，重启前的旧行
# 不能用来判定本次是否就绪，否则刚 stop 就 start 时会读到上一轮的标记。
$logLenBefore = 0
if (Test-Path -LiteralPath $widgetLog) {
  try { $logLenBefore = (Get-Item -LiteralPath $widgetLog).Length } catch { $logLenBefore = 0 }
}

$ok = $false
for ($i = 0; $i -lt 16; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    if ((Get-Process -Id $proc.Id -ErrorAction Stop).HasExited) { break }
  } catch { break }

  if (-not (Test-Path -LiteralPath $widgetLog)) { continue }
  try {
    $fi = Get-Item -LiteralPath $widgetLog
    if ($fi.Length -le $logLenBefore) { continue }
    $fs = [System.IO.File]::Open($fi.FullName, 'Open', 'Read', 'ReadWrite')
    try {
      [void]$fs.Seek($logLenBefore, 'Begin')
      $added = (New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)).ReadToEnd()
    } finally { $fs.Dispose() }
    if ($added.IndexOf($widgetReady, [System.StringComparison]::Ordinal) -ge 0) { $ok = $true; break }
  } catch {}
}

# 顺带拉起 detector。start-detect-island.ps1 自身是幂等的（先看 detect.pid，
# 再核对那个 PID 的命令行是否仍指向 mcode-status-detect.ps1），所以 detector
# 已经在跑时这里不会重复起。
# 为什么必须放在这里：2026-10-06 14:37:42 detector 因未捕获的终止性错误死掉，
# 只留了一行 "detector stopped"，widget 却活着，于是 status.json 冻结、pill 看着
# 像卡死，整整 ~23 小时。用户能想到的恢复动作就是"重启灵动岛"，如果这条路带不起
# detector，重启等于没做。detector 挂了不影响 widget，所以失败只警告不抛出。
$detectStarter = Join-Path $PSScriptRoot 'start-detect-island.ps1'
if (Test-Path $detectStarter) {
  try {
    $detOut = & $detectStarter 2>&1
    Write-Output ("detector: " + (($detOut | Out-String).Trim()))
  } catch {
    Write-Output ("detector start failed (widget is up anyway): " + $_.Exception.Message)
  }
}

if ($ok) {
  Write-Output ("mcode-island 已启动 (PID " + $proc.Id + "，已就绪)")
} else {
  Write-Output ("mcode-island 已启动 (PID " + $proc.Id + "，等待中...)")
}
