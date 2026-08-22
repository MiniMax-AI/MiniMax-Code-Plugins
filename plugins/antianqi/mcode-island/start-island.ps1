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

# 防止重复启动
if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
    Write-Output ("已在运行（PID $oldPid）")
    exit 0
  } else {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}

# 新进程启动 widget
$args = @('-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$widget`"")
$proc = Start-Process powershell.exe -ArgumentList $args -PassThru

# 写 PID（先写，后面 status / stop 都靠这个）
Set-Content -Path $pidFile -Value $proc.Id -Encoding ASCII

# 等待 widget 起来（最多 8 秒）
$ok = $false
for ($i = 0; $i -lt 16; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $p = Get-Process -Id $proc.Id -ErrorAction Stop
    if ($p.HasExited) { break }
    $log = Join-Path $configDir 'widget.log'
    if ((Test-Path $log) -and ((Get-Item $log).Length -gt 0)) {
      $content = Get-Content $log -Tail 5 -ErrorAction SilentlyContinue
      if ($content -match 'about to ShowDialog') { $ok = $true; break }
    }
  } catch {}
}

if ($ok) {
  Write-Output "mcode-island 已启动 (PID $($proc.Id)，已就绪)"
} else {
  Write-Output "mcode-island 已启动 (PID $($proc.Id)，等待中...)"
}
