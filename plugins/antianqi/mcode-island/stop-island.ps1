# 停掉 widget
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$pidFile = Join-Path $env:APPDATA 'mcode-island\widget.pid'
if (!(Test-Path $pidFile)) {
  Write-Output 'NOT RUNNING'
  exit 0
}

$widgetPid = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [int]
if ($widgetPid -and $widgetPid -gt 0) {
  $proc = Get-Process -Id $widgetPid -ErrorAction SilentlyContinue
  if ($proc -and !$proc.HasExited) {
    Stop-Process -Id $widgetPid -Force
    Write-Output "stopped PID $widgetPid"
  } else {
    Write-Output "NOT RUNNING (stale pid $widgetPid)"
  }
} else {
  Write-Output 'NOT RUNNING'
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
