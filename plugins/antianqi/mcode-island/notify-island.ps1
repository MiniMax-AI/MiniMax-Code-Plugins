# mcode 灵动岛 - 状态推送 + 调用方追踪
# 用法：
#   notify-island.ps1 -State working -Message "..."
#
# 副作用：
#   1. 写 status.json（widget 轮询）
#   2. 写 caller.json（widget 点击切回时用）—— 记录调用方进程链和窗口句柄

param(
  [ValidateSet('idle','thinking','working','waiting','done','error')]
  [string]$State = 'idle',
  [string]$Message = '',
  [int]$Progress = -1,
  [int]$Step = -1,
  [int]$Total = -1,
  [string]$Detail = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

# status.json 的跨进程协议（round-21 review hetaoBackend #1）。
#
# 这个文件和 detector 守护进程是两个独立进程，都会写 status.json。之前
# 两边完全没有互斥：detector 读了一次 status.json，hook 写了一次，
# detector 再把基于旧读写回的 payload 盖上去 —— hook 推的
# step/total/detail 要么被混进一份陈旧 payload，要么直接丢失。两边还
# 共用同一个 "status.json.tmp" 暂存路径，一个进程可能把另一个进程写到
# 一半的文件 rename 成正式文件。
#
# 共享的 store 库给两边同一把跨进程锁、同一份快照、同一个暂存文件。
. "$PSScriptRoot/scripts/lib/Status-Store.ps1"

$configDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
# status.json 的路径由 store 库统一解析（Get-StatusFilePath），这里不再
# 维护第二份，避免两个来源对不上。
$callerFile = Join-Path $configDir 'caller.json'

# 找当前 console 关联的窗口（这是 Windows Terminal 里那个具体 tab 的 HWND）
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ConsoleWin {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint dwProcessId);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@ -ErrorAction SilentlyContinue

function Get-CallerFocusInfo {
  # 1) 直接拿自己的 console window
  $hwnd = [ConsoleWin]::GetConsoleWindow()
  if ($hwnd -ne [IntPtr]::Zero) {
    $ownerPid = 0
    [ConsoleWin]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid) | Out-Null
    return @{
      targetHwnd  = [int64]$hwnd
      targetPid   = [int]$ownerPid
      targetExe   = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName
      targetTitle = ''
      source      = 'console-window'
    }
  }

  # 2) 临时附到父进程的 console（notify-island 自己是 NonInteractive 启动时）
  $parentProc = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -ErrorAction SilentlyContinue
  if ($parentProc -and $parentProc.ParentProcessId -and $parentProc.ParentProcessId -gt 0) {
    # 沿链向上找有 console 的祖先
    $current = [int]$parentProc.ParentProcessId
    $visited = @()
    for ($i = 0; $i -lt 6; $i++) {
      if ($visited -contains $current) { break }
      $visited += $current
      $attached = [ConsoleWin]::AttachConsole([uint32]$current)
      if ($attached) {
        $hwnd = [ConsoleWin]::GetConsoleWindow()
        [ConsoleWin]::FreeConsole() | Out-Null
        if ($hwnd -ne [IntPtr]::Zero) {
          $ownerPid = 0
          [ConsoleWin]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid) | Out-Null
          return @{
            targetHwnd  = [int64]$hwnd
            targetPid   = [int]$ownerPid
            targetExe   = (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue).ProcessName
            targetTitle = ''
            source      = 'attached-console'
          }
        }
      }
      $gp = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
      if (-not $gp -or -not $gp.ParentProcessId) { break }
      $current = [int]$gp.ParentProcessId
    }
  }

  # 3) fallback: 进程链里第一个有主窗口的祖先
  $current = $PID
  $visited = @()
  for ($i = 0; $i -lt 6; $i++) {
    if ($visited -contains $current) { return $null }
    $visited += $current
    $proc = Get-Process -Id $current -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    if ([int64]$proc.MainWindowHandle -ne 0) {
      return @{
        targetHwnd  = [int64]$proc.MainWindowHandle
        targetPid   = $proc.Id
        targetExe   = $proc.ProcessName
        targetTitle = $proc.MainWindowTitle
        source      = 'parent-chain'
      }
    }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
    if (-not $parent -or -not $parent.ParentProcessId -or $parent.ParentProcessId -eq 0) { return $null }
    $current = [int]$parent.ParentProcessId
  }
  return $null
}

$ts = (Get-Date).ToString('o')

# 写 status.json（widget 轮询用）
# 加 source='agent' 让 detector 识别这是 agent 主动推的，保留不被 working/thinking/done
# 覆盖（detector 推 idle/error 兜底仍然可以接管，符合 takeover 语义）。
# ts 和 version 由 store 统一盖章，所以这里不写。
$payload = [PSCustomObject]@{
  state    = $State
  message  = $Message
  progress = $Progress
  step     = $Step
  total    = $Total
  detail   = $Detail
  source   = 'agent'
}

# 写 caller.json（widget 点击切回用）
$myPid = $PID
$focusInfo = Get-CallerFocusInfo
$callerData = [PSCustomObject]@{
  callerPid   = $myPid
  callerSession = (Get-Process -Id $myPid).SessionId
  targetPid   = if ($focusInfo) { $focusInfo.targetPid } else { 0 }
  targetHwnd  = if ($focusInfo) { $focusInfo.targetHwnd } else { 0 }
  targetTitle = if ($focusInfo) { $focusInfo.targetTitle } else { '' }
  targetExe   = if ($focusInfo) { $focusInfo.targetExe } else { '' }
  source      = if ($focusInfo) { $focusInfo.source } else { 'none' }
  ts          = $ts
}

# 原子写
#
# 两个文件都在同一把跨进程锁里写。caller.json 只有一个归属方（agent 侧），
# 但两个 hook 进程可能同时跑，所以它的暂存路径之前和 status.json 一样是
# 共用的 —— 一个 hook 会把另一个写到一半的文件 rename 到位。现在锁把
# 两个写入方串起来了，固定暂存名也就安全了（不会攒出一堆孤儿文件）。
$tmpCaller = "$callerFile.tmp"
try {
  $lock = Enter-StatusLock
  try {
    $prev = Read-StatusSnapshot
    Write-StatusSnapshot -Payload $payload -Previous $prev
    [System.IO.File]::WriteAllText($tmpCaller, ($callerData | ConvertTo-Json -Compress), [System.Text.Encoding]::UTF8)
    Move-Item -Path $tmpCaller -Destination $callerFile -Force
  } finally {
    Exit-StatusLock $lock
  }
  Write-Output "OK: $State - $Message"
  if ($focusInfo) {
    Write-Output ("  (caller via " + $focusInfo.source + ": " + $focusInfo.targetExe + " PID=" + $focusInfo.targetPid + " hwnd=" + $focusInfo.targetHwnd + ")")
  }
} catch {
  Write-Output "FAIL: $($_.Exception.Message)"
  exit 1
}
