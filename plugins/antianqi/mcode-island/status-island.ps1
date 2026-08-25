# 看 widget 状态
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$pidFile = Join-Path $env:APPDATA 'mcode-island\widget.pid'
if (!(Test-Path $pidFile)) {
  Write-Output 'NOT RUNNING (no pid file)'
  exit 0
}

$widgetPid = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [int]
if (-not $widgetPid -or $widgetPid -le 0) {
  Write-Output 'NOT RUNNING (invalid pid)'
  exit 0
}

$proc = Get-Process -Id $widgetPid -ErrorAction SilentlyContinue
if ($proc -and -not $proc.HasExited) {
  Write-Output ("RUNNING  PID=" + $proc.Id + "  Session=" + $proc.SessionId + "  StartTime=" + $proc.StartTime.ToString('HH:mm:ss'))
  $logFile = Join-Path $env:APPDATA 'mcode-island\island.log'
  if (Test-Path $logFile) {
    Write-Output '--- recent log ---'
    Get-Content $logFile -Tail 5 -Encoding UTF8
  }
} else {
  Write-Output ("NOT RUNNING (stale pid $widgetPid)")
}
