# 停掉 detector（校验 PID + cmdline 防误杀）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$pidFile = Join-Path $env:APPDATA 'mcode-island\detect.pid'
$detectScript = 'mcode-status-detect.ps1'   # cmdline 匹配
if (!(Test-Path $pidFile)) { Write-Output 'NOT RUNNING'; exit 0 }

$targetPid = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [int]
if ($targetPid -and $targetPid -gt 0) {
  $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($p -and -not $p.HasExited) {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue).CommandLine
    if ($cmd -and $cmd.IndexOf($detectScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Stop-Process -Id $targetPid -Force
      Write-Output ("stopped PID " + $targetPid)
    } else {
      Write-Output ("REFUSED: PID " + $targetPid + " is alive but not the detector (PID reuse suspected). Refusing to kill.")
    }
  } else {
    Write-Output ("NOT RUNNING (stale pid " + $targetPid + ")")
  }
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
