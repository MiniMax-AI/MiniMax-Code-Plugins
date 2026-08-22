# 停掉 detector
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$pidFile = Join-Path $env:APPDATA 'mcode-island\detect.pid'
if (!(Test-Path $pidFile)) { Write-Output 'NOT RUNNING'; exit 0 }

$targetPid = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [int]
if ($targetPid -and $targetPid -gt 0) {
  $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($p -and -not $p.HasExited) {
    Stop-Process -Id $targetPid -Force
    Write-Output ("stopped PID " + $targetPid)
  } else {
    Write-Output ("NOT RUNNING (stale pid " + $targetPid + ")")
  }
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
