# mcode 灵动岛 - 把当前前台窗口 pin 为点击目标
# 在 mcode 终端里直接运行：mcode-island pin
# 效果：把当前前台窗口（也就是 mcode 这个 tab）的 HWND 记下来
#       之后点 pill，会稳稳切回这里

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PinW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@ -ErrorAction SilentlyContinue

$hwnd = [PinW]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output "FAIL: 当前没有前台窗口"
  exit 1
}
$ownerPid = 0
[PinW]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid) | Out-Null
$proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Output "FAIL: 前台窗口进程已退出"
  exit 1
}

$configDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
$callerFile = Join-Path $configDir 'caller.json'

$myPid = [int](Get-Process -Id $PID).Id
$mySession = (Get-Process -Id $myPid).SessionId
$payload = [PSCustomObject]@{
  callerPid    = $myPid
  callerSession = $mySession
  targetPid    = $proc.Id
  targetHwnd   = [int64]$hwnd
  targetTitle  = $proc.MainWindowTitle
  targetExe    = $proc.ProcessName
  source       = 'cli-pin'
  ts           = (Get-Date).ToString('o')
} | ConvertTo-Json -Compress

$tmpFile = "$callerFile.tmp"
[System.IO.File]::WriteAllText($tmpFile, $payload, [System.Text.Encoding]::UTF8)
Move-Item -Path $tmpFile -Destination $callerFile -Force

Write-Output ("OK: pin'd " + $proc.ProcessName + " (PID=" + $proc.Id + ", hwnd=" + $hwnd + ")")
Write-Output ("     title: " + $proc.MainWindowTitle)
Write-Output "     之后点 pill 就切回这个窗口"
