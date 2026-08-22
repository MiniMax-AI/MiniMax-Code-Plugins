# 启动 detector 守护进程（独立进程跑 mcode-status-detect.ps1）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$configDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
$pidFile = Join-Path $configDir 'detect.pid'
$detectScript = Join-Path $PSScriptRoot 'mcode-status-detect.ps1'

# 防重复：校验已有 PID 是否真在跑 detector
function Test-IsDetectorProcess($proc, $detectPath) {
  if (-not $proc -or $proc.HasExited) { return $false }
  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
  if (-not $cmd) { return $false }
  return $cmd.IndexOf($detectPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

if (Test-Path $pidFile) {
  $old = (Get-Content $pidFile -ErrorAction SilentlyContinue) -as [int]
  if ($old -and $old -gt 0) {
    $existing = Get-Process -Id $old -ErrorAction SilentlyContinue
    if ($existing -and (Test-IsDetectorProcess $existing $detectScript)) {
      Write-Output ("detector already running (PID " + $old + ")")
      exit 0
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
}

$args = @('-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$detectScript`"")
$proc = Start-Process powershell.exe -ArgumentList $args -PassThru
Set-Content -Path $pidFile -Value $proc.Id -Encoding ASCII
Write-Output ("detector started (PID " + $proc.Id + ")")
