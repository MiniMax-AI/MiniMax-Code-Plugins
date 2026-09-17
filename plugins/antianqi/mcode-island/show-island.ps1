# mcode 灵动岛 - 把隐藏的 widget 重新叫出来
# 用法：mcode-island show

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 看 widget 在不在
$pidFile = Join-Path $env:APPDATA 'mcode-island\widget.pid'
$widgetPid = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [int]
if (-not $widgetPid -or $widgetPid -le 0) {
  Write-Output 'NOT RUNNING: widget 没在跑，先 mcode-island start'
  exit 0
}
$proc = Get-Process -Id $widgetPid -ErrorAction SilentlyContinue
if (-not $proc -or $proc.HasExited) {
  Write-Output "NOT RUNNING: PID $widgetPid 是死的，先 mcode-island start"
  exit 0
}

# 创建 show 信号（widget 每 400ms 轮询，看到这个就 Show()）
$configDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
$signalFile = Join-Path $configDir 'show.signal'

try {
  [System.IO.File]::WriteAllText($signalFile, (Get-Date).ToString('o'), [System.Text.Encoding]::ASCII)
  Write-Output "OK: signal sent (widget PID $widgetPid should show up within 1s)"
} catch {
  Write-Output "FAIL: $($_.Exception.Message)"
  exit 1
}
