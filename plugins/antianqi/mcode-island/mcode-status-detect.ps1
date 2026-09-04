# mcode-status-detect.ps1 - 后台守护进程 (v0.2.1)
# 监听 mcode session log，实时推断 agent 状态，写到 status.json
# 让 widget 不依赖 agent 主动调 notify-island.ps1 也能跟着动
#
# 路径解析（顺序）：
#   1. 从 mcode node 进程 cmdline 提取 <userprofile>/.minimax-code
#   2. 探测 $env:USERPROFILE/.minimax-code
#   3. 探测 $env:USERPROFILE/AppData/Roaming/minimax-code/.minimax-code
#   4. 探测 <cwd>/.minimax-code
#
# session log（顺序）：
#   1. <root>/.minimax/v2/sessions/<date>/*/ledger.jsonl（首选，mcode v2 事件流）
#   2. <root>/.minimax/v2/sessions/<date>/*/messages.jsonl（fallback）
#
# 状态映射：
#   role=user                  → idle     (等用户)
#   role=assistant + toolCall  → working  "<tool>: <args>"
#   role=assistant + thinking  → thinking
#   role=assistant + text      → idle     (刚说完，等用户)
#   role=toolResult + !isError → done     "<tool> 完成"
#   role=toolResult + isError  → error    "<tool> 失败"
#   mcode 进程不在              → error    "mcode 已退出"
#   60s 无新事件                → idle     兜底
#
# 优先级：
#   agent 主动推的状态（status.json 中 source != detector）保留
#   detector 推的 idle / error 可以覆盖 agent 推的（兜底）
#   detector 推的 working/thinking/done 不覆盖 agent 推的
#
# PS 5.1 parser quirk:
#   短 ASCII 字符串字面量在 -eq / state= 后会被解析为 cmdlet 参数
#   所以所有 ASCII 字符串都用 _s (byte[]) helper 构造

param(
  [switch]$Once,
  [string]$Root = ''    # override: <root>/.minimax-code and <root>/.minimax/v2/...
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

# 防御性隐藏控制台窗口：start-detect 用 CreateNoWindow 启的进程理论上没有控制台，
# 但偶尔有边界场景会冒出空窗口被用户误关。这里 SW_HIDE 一下兜底。
$hideSig = @'
using System;
using System.Runtime.InteropServices;
public class DetectHide {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
'@
if (-not ('DetectHide' -as [type])) { Add-Type $hideSig -ErrorAction SilentlyContinue }
$hwnd = [DetectHide]::GetConsoleWindow()
if ($hwnd -ne [IntPtr]::Zero) {
  [void][DetectHide]::ShowWindow($hwnd, 0)
}

function _s { param([byte[]]$b) [System.Text.Encoding]::UTF8.GetString($b) }

# role names
$S_USER       = _s (0x75,0x73,0x65,0x72)
$S_ASSISTANT  = _s (0x61,0x73,0x73,0x69,0x73,0x74,0x61,0x6E,0x74)
$S_TOOLRESULT = _s (0x74,0x6F,0x6F,0x6C,0x52,0x65,0x73,0x75,0x6C,0x74)
$S_COMPACTION = _s (0x63,0x6F,0x6D,0x70,0x61,0x63,0x74,0x69,0x6F,0x6E,0x53,0x75,0x6D,0x6D,0x61,0x72,0x79)
# state values
$S_IDLE     = _s (0x69,0x64,0x6C,0x65)
$S_THINKING = _s (0x74,0x68,0x69,0x6E,0x6B,0x69,0x6E,0x67)
$S_WORKING  = _s (0x77,0x6F,0x72,0x6B,0x69,0x6E,0x67)
$S_DONE     = _s (0x64,0x6F,0x6E,0x65)
$S_ERROR    = _s (0x65,0x72,0x72,0x6F,0x72)
# content type discriminators
$S_TOOLCALL  = _s (0x74,0x6F,0x6F,0x6C,0x43,0x61,0x6C,0x6C)
$S_TEXT      = _s (0x74,0x65,0x78,0x74)
$S_THINK_BLK = _s (0x74,0x68,0x69,0x6E,0x6B,0x69,0x6E,0x67)
# source tag
$S_DETECTOR  = _s (0x64,0x65,0x74,0x65,0x63,0x74,0x6F,0x72)
# messages (UTF-8 encoded Chinese)
$MSG_USER_WAIT  = _s (0xE7,0xAD,0x89,0xE7,0x94,0xA8,0xE6,0x88,0xB7)              # 等用户
$MSG_AGENT_DONE = _s (0x61,0x67,0x65,0x6E,0x74,0x20,0xE5,0x88,0x9A,0xE5,0x9B,0x9E,0xE5,0xA4,0x8D,0xEF,0xBC,0x8C,0xE7,0xAD,0x89,0xE7,0x94,0xA8,0xE6,0x88,0xB7)  # agent 刚回复，等用户
$MSG_FAIL       = _s (0xE5,0xA4,0xB1,0xE8,0xB4,0xA5)                              # 失败
$MSG_OK         = _s (0xE5,0xAE,0x8C,0xE6,0x88,0x90)                              # 完成
$MSG_COMPACT    = _s (0x73,0x65,0x73,0x73,0x69,0x6F,0x6E,0x20,0xE5,0x8E,0x8B,0xE7,0xBC,0xA9)  # session 压缩
$MSG_MCODE_EXIT = _s (0x6D,0x63,0x6F,0x64,0x65,0x20,0xE8,0xBF,0x9B,0xE7,0xA8,0x8B,0xE5,0xB7,0xB2,0xE9,0x80,0x80,0xE5,0x87,0xBA)  # mcode 进程已退出
$MSG_IDLE_FMT   = _s (0xE5,0xB7,0xB2,0xE9,0x9D,0x99,0xE9,0x9C,0xA8,0x20,0x7B,0x30,0x7D,0x73)  # 已静默 {0}s
$DOTS            = _s (0x2E,0x2E,0x2E)                                                # ...
$FMT_O           = _s (0x6F)                                                           # 'o' (ISO 8601 timestamp)
$FMT_O_FULL      = _s (0x4F)                                                           # 'O' (ISO 8601 full)
# log reason tags
$R_NO_CURRENT    = _s (0x6E,0x6F,0x20,0x63,0x75,0x72,0x72,0x65,0x6E,0x74,0x20,0x73,0x74,0x61,0x74,0x75,0x73)
$R_OWN_CHANGED   = _s (0x6F,0x77,0x6E,0x20,0x73,0x74,0x61,0x74,0x65,0x20,0x63,0x68,0x61,0x6E,0x67,0x65,0x64)
$R_OWN_MSG       = _s (0x6F,0x77,0x6E,0x20,0x6D,0x65,0x73,0x73,0x61,0x67,0x65,0x20,0x63,0x68,0x61,0x6E,0x67,0x65,0x64)
$R_TAKEOVER      = _s (0x74,0x61,0x6B,0x65,0x6F,0x76,0x65,0x72,0x20,0x74,0x6F,0x20,0x73,0x65,0x74,0x74,0x6C,0x65)
# session log file names (优先 ledger)
$FNAME_LEDGER    = _s (0x6C,0x65,0x64,0x67,0x65,0x72,0x2E,0x6A,0x73,0x6F,0x6E,0x6C)   # ledger.jsonl
$FNAME_MESSAGES  = _s (0x6D,0x65,0x73,0x73,0x61,0x67,0x65,0x73,0x2E,0x6A,0x73,0x6F,0x6E,0x6C)  # messages.jsonl
# mcode node cli.js path fragment for cmdline match
$CLI_FRAGMENT    = _s (0x40,0x6D,0x69,0x6E,0x69,0x6D,0x61,0x78,0x2D,0x61,0x69,0x2F,0x63,0x6F,0x64,0x65,0x2F,0x63,0x6C,0x69,0x2E,0x6A,0x73)  # @minimax-ai/code/cli.js
# .mcode-active directory name
$ACTIVE_DIR      = _s (0x2E,0x6D,0x63,0x6F,0x64,0x65,0x2D,0x61,0x63,0x74,0x69,0x76,0x65)  # .mcode-active
# .minimax-code directory name (parent of .mcode-active)
$MINIMAX_CODE    = _s (0x2E,0x6D,0x69,0x6E,0x69,0x6D,0x61,0x78,0x2D,0x63,0x6F,0x64,0x65)  # .minimax-code
# v2 sessions relative to user profile
$V2_SESSIONS_REL = _s (0x2E,0x6D,0x69,0x6E,0x69,0x6D,0x61,0x78,0x5C,0x76,0x32,0x5C,0x73,0x65,0x73,0x73,0x69,0x6F,0x6E,0x73)  # .minimax\v2\sessions

$configDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
$statusFile = Join-Path $configDir 'status.json'
$logFile    = Join-Path $configDir 'island.log'
$pidFile    = Join-Path $configDir 'detect.pid'
$cfgFile    = Join-Path $configDir 'config.json'

# 5h 用量 API：每 60s 调一次 minimax /v1/coding_plan/remains，写进 status.json 的 usage5h 字段
# token 来源：env MINIMAX_OAUTH_TOKEN 优先；fallback 到 config.json 的 planApiToken
$PLAN_API_HOST = _s (0x68,0x74,0x74,0x70,0x73,0x3A,0x2F,0x2F,0x61,0x70,0x69,0x2E,0x6D,0x69,0x6E,0x69,0x6D,0x61,0x78,0x69,0x2E,0x63,0x6F,0x6D)
$PLAN_API_PATH = _s (0x2F,0x76,0x31,0x2F,0x63,0x6F,0x64,0x69,0x6E,0x67,0x5F,0x70,0x6C,0x61,0x6E,0x2F,0x72,0x65,0x6D,0x61,0x69,0x6E,0x73)  # /v1/coding_plan/remains
$PLAN_API_TTL  = [TimeSpan]::FromSeconds(60)
$script:plan5hToken = $null
if ($env:MINIMAX_OAUTH_TOKEN) { $script:plan5hToken = $env:MINIMAX_OAUTH_TOKEN }
elseif ($env:MINIMAX_API_KEY) { $script:plan5hToken = $env:MINIMAX_API_KEY }
elseif (Test-Path $cfgFile) {
  try {
    $cfg = [System.IO.File]::ReadAllText($cfgFile) | ConvertFrom-Json
    if ($cfg.PSObject.Properties['planApiToken'] -and $cfg.planApiToken) {
      $script:plan5hToken = [string]$cfg.planApiToken
    }
  } catch {}
}
$script:plan5hLastCallAt = [DateTime]::MinValue
$script:plan5hRemainingPct = $null  # 0..100，剩余百分比（不再是已用！）
$script:plan5hResetMs = $null       # 距下次刷新的毫秒数

# Todo 进度缓存（widget 进度条用）：completed / (total - cancelled) * 100
$script:plan5hTodoData = $null      # @{ percent; currentTodo; completed; total }
$script:plan5hTodoCacheMtime = [DateTime]::MinValue
$script:plan5hLastWrittenTodoPct = $null  # 上次写到 status.json 的 todoProgress（用来检测变化）

# 解析 mcode 安装根目录（<userprofile>/.minimax-code）
function Find-McodeRoot {
  # 1) 用户显式 -Root 覆盖
  if ($script:optRoot -and (Test-Path $script:optRoot)) { return $script:optRoot }

  # 2) 从 mcode node 进程 cmdline 提取
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($CLI_FRAGMENT) }
  foreach ($p in $procs) {
    try {
      $m = [regex]::Match($p.CommandLine, '([A-Za-z]:\\[^"'']*?)\.minimax-code\\')
      if ($m.Success) {
        $root = $m.Groups[1].Value + $MINIMAX_CODE
        if (Test-Path $root) { return $root }
      }
    } catch {}
  }

  # 3) 探测 $env:USERPROFILE/.minimax-code
  if ($env:USERPROFILE) {
    $candidate = Join-Path $env:USERPROFILE $MINIMAX_CODE
    if (Test-Path $candidate) { return $candidate }
  }

  # 4) 探测 $env:USERPROFILE/AppData/Roaming/minimax-code/.minimax-code
  if ($env:APPDATA) {
    $candidate = Join-Path (Join-Path $env:APPDATA 'minimax-code') $MINIMAX_CODE
    if (Test-Path $candidate) { return $candidate }
  }

  # 5) 探测 <cwd>/.minimax-code
  try {
    $cwd = (Get-Location).Path
    $candidate = Join-Path $cwd $MINIMAX_CODE
    if (Test-Path $candidate) { return $candidate }
  } catch {}

  return $null
}

# sessions 根目录（优先 mcode 安装目录上一级，再 fallback userprofile）
function Get-SessionsRoot($mcodeRoot) {
  if ($mcodeRoot) {
    # .minimax-code 和 .minimax 平级，都在 <userprofile> 下
    $parent = Split-Path -Parent $mcodeRoot
    $candidate = Join-Path $parent (Join-Path '.minimax' (Join-Path 'v2' 'sessions'))
    if (Test-Path $candidate) { return $candidate }
  }
  if ($env:USERPROFILE) {
    $candidate = Join-Path $env:USERPROFILE $V2_SESSIONS_REL
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

$script:optRoot = $Root
$mcodeRoot = Find-McodeRoot
if (-not $mcodeRoot) {
  Write-Error "Cannot find mcode install root (.minimax-code). Pass -Root or ensure mcode is running."
  exit 2
}
$mcodeActiveDir = Join-Path $mcodeRoot $ACTIVE_DIR
$sessionsRoot   = Get-SessionsRoot $mcodeRoot
if (-not (Test-Path $mcodeActiveDir)) {
  Write-Warning ".mcode-active not found at $mcodeActiveDir — mcode not running or different layout"
}

# 全局状态
$script:lastDetectedState = ''
$script:lastMsgsSnapshot  = @{ mtime = ''; lastInferred = $null }

# 5s 缓存：mcode 进程 PID + 最新 session log 路径
# 避免每秒调 Get-McodePid / Get-LatestSessionFile（每次都涉及 Get-ChildItem
# 之类的 cmdlet，PS 5.1 hidden window 下会累积 Runspace 线程，9 小时后
# 池子被占满 → poll 不再前进 → widget 卡死）。
$CACHE_TTL = [TimeSpan]::FromSeconds(5)
$script:lastMcodePid     = $null
$script:lastMcodePidAt   = [DateTime]::MinValue
$script:lastLatestFile   = $null
$script:lastLatestFileAt = [DateTime]::MinValue

function Log-Line($msg) {
  $ts = (Get-Date).ToString('HH:mm:ss')
  $line = "[$ts] [detect] $msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  if (-not $Once) { Write-Output $line }
}

function Get-McodePid {
  if (-not (Test-Path $mcodeActiveDir)) { return $null }
  # Use [System.IO.Directory]::EnumerateFiles instead of Get-ChildItem + foreach
  # to avoid the PS 5.1 pipeline-thread leak that built up over multi-hour
  # runs and eventually stalled the detector. See: ~30k leaked threads
  # observed after 9h of polling.
  $bestPid = $null
  $bestMtime = [DateTime]::MinValue
  foreach ($f in [System.IO.Directory]::EnumerateFiles($mcodeActiveDir, '*.json')) {
    try {
      $raw = [System.IO.File]::ReadAllText($f)
      $j = $raw | ConvertFrom-Json
      $targetPid = [int]$j.pid
      $proc = [System.Diagnostics.Process]::GetProcessById($targetPid)
      if ($proc -and -not $proc.HasExited) {
        # .mcode-active dir is tiny (one or two .json files); prefer the most
        # recently started one if multiple happen to exist.
        $mtime = [System.IO.File]::GetLastWriteTime($f)
        if ($mtime -gt $bestMtime) {
          $bestMtime = $mtime
          $bestPid = $targetPid
        }
      }
    } catch {}
  }
  return $bestPid
}

function Get-LatestSessionFile {
  if (-not $sessionsRoot -or -not (Test-Path $sessionsRoot)) { return $null }
  # Replace Get-ChildItem -Recurse | Where-Object | Sort-Object | Select-Object
  # (a 4-stage pipeline) with a single .NET enumeration + manual mtime scan.
  # Same reason as Get-McodePid: avoid the PS 5.1 pipeline-thread leak.
  $best = $null
  $bestMtime = [DateTime]::MinValue
  $bestIsLedger = $false
  foreach ($f in [System.IO.Directory]::EnumerateFiles($sessionsRoot, '*.jsonl', 'AllDirectories')) {
    $name = [System.IO.Path]::GetFileName($f)
    $isLedger = ($name -eq $FNAME_LEDGER)
    $isMsgs   = ($name -eq $FNAME_MESSAGES)
    if (-not $isLedger -and -not $isMsgs) { continue }
    try {
      $mtime = [System.IO.File]::GetLastWriteTime($f)
    } catch {
      continue
    }
    # mcode v0.2.x writes messages.jsonl live; ledger.jsonl is best-effort
    # and may be left behind by an old session. Always pick whichever file
    # is most recently touched, otherwise a stale ledger would dominate
    # and the 60s-idle fallback would fire against ancient timestamps.
    if ($mtime -gt $bestMtime) {
      $bestMtime = $mtime
      $best = $f
      $bestIsLedger = $isLedger
    }
  }
  return $best
}

function Read-LastMessage($file) {
  if (-not $file) { return $null }
  try {
    $fi = [System.IO.FileInfo]::new($file)
    $mtime = $fi.LastWriteTime.ToString($FMT_O_FULL)
    if ($script:lastMsgsSnapshot.mtime -eq $mtime) {
      # mtime 没变：返回上次推断结果（保持 idle 兜底可达）
      return $script:lastMsgsSnapshot.lastInferred
    }
    $script:lastMsgsSnapshot.mtime = $mtime
    $fs = [System.IO.File]::Open($fi.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $len = $fs.Length
      if ($len -eq 0) { return $null }
      $lookback = [Math]::Min($len, 65536)
      $fs.Seek(-$lookback, [System.IO.SeekOrigin]::End) | Out-Null
      $buf = New-Object byte[] $lookback
      $fs.Read($buf, 0, $lookback) | Out-Null
      $text = [System.Text.Encoding]::UTF8.GetString($buf)
      $parts = $text -split "`n"
      for ($i = $parts.Length - 1; $i -ge 0; $i--) {
        $line = $parts[$i].TrimEnd("`r")
        if ($line -and $line.Length -gt 10) {
          # ConvertFrom-Json is gated by the mtime cache above, so this
          # pipeline only fires when the file actually grew. Acceptable.
          $msg = ($line | ConvertFrom-Json)
          $script:lastMsgsSnapshot.lastInferred = $msg
          return $msg
        }
      }
      return $null
    } finally {
      $fs.Close()
    }
  } catch {
    return $script:lastMsgsSnapshot.lastInferred
  }
}

function Infer-State($msg) {
  if (-not $msg) { return $null }
  # ledger.jsonl 事件格式：{kind, phase, action, ...}
  # messages.jsonl 消息格式：{message: {role, content, ...}, ...}
  $m = $msg.message
  if (-not $m) {
    # ledger 事件：用 kind/phase 推断
    $kind = [string]$msg.kind
    $phase = [string]$msg.phase
    if ($kind -eq $S_TOOLRESULT) {
      if ($msg.isError -eq $true) { return @{ state=$S_ERROR; message="$($msg.toolName) $MSG_FAIL" } }
      return @{ state=$S_DONE; message="$($msg.toolName) $MSG_OK" }
    }
    if ($kind -eq 'toolCall' -or $kind -eq $S_TOOLCALL) {
      return @{ state=$S_WORKING; message="$($msg.toolName) : $($msg.action)" }
    }
    if ($kind -eq $S_ASSISTANT -and $phase -eq $S_THINKING) {
      return @{ state=$S_THINKING; message='' }
    }
    return $null
  }

  $role = [string]$m.role
  if ($role -eq $S_USER) { return @{ state=$S_IDLE; message=$MSG_USER_WAIT } }

  if ($role -eq $S_ASSISTANT) {
    # Use .Where({}) method on the collection instead of | Where-Object ...
    # | Select-Object pipelines: each pipeline is a thread-pool hop on
    # PS 5.1 and the completed tasks accumulate over hours-long runs.
    $hasTool  = $null
    $hasThink = $null
    $hasText  = $null
    if ($m.content) {
      foreach ($c in @($m.content)) {
        if     ($hasTool  -eq $null -and $c.type -eq $S_TOOLCALL)  { $hasTool  = $c }
        elseif ($hasThink -eq $null -and $c.type -eq $S_THINK_BLK) { $hasThink = $c }
        elseif ($hasText  -eq $null -and $c.type -eq $S_TEXT)      { $hasText  = $c }
        if ($hasTool) { break }   # toolCall wins; we can stop scanning
      }
    }

    if ($hasTool) {
      $tool  = $hasTool.name
      $args  = $hasTool.arguments
      if ($args) {
        # ConvertTo-Json is a single .NET call; keep it (no pipeline leak).
        $argsJson = $args | ConvertTo-Json -Compress -Depth 2 -WarningAction SilentlyContinue
        if ($argsJson.Length -gt 60) { $argsJson = $argsJson.Substring(0, 57) + $DOTS }
      } else { $argsJson = '' }
      return @{ state=$S_WORKING; message="$tool : $argsJson" }
    }
    if ($hasThink -and -not $hasText) { return @{ state=$S_THINKING; message='' } }
    if ($hasText) { return @{ state=$S_IDLE; message=$MSG_AGENT_DONE } }
    return @{ state=$S_IDLE; message='' }
  }

  if ($role -eq $S_TOOLRESULT) {
    $tool  = $m.toolName
    $isErr = $m.isError -eq $true
    if ($isErr) { return @{ state=$S_ERROR; message="$tool $MSG_FAIL" } }
    return @{ state=$S_DONE; message="$tool $MSG_OK" }
  }

  if ($role -eq $S_COMPACTION) { return @{ state=$S_IDLE; message=$MSG_COMPACT } }

  return $null
}

function Write-Status($state, $message) {
  $tmp = "$statusFile.tmp"
  # usage5h：0..100 表示"剩余"百分比（不是已用！）；null = 未知/未拉到
  # usage5hResetMs：距下次刷新的毫秒数；null = 未知
  # todoProgress：0..100 完成百分比（cancelled 不计）；null = 无 todo 列表
  $usageField  = if ($null -ne $script:plan5hRemainingPct) { [int]$script:plan5hRemainingPct } else { $null }
  $resetField  = if ($null -ne $script:plan5hResetMs)     { [int]$script:plan5hResetMs }     else { $null }
  $todoPct     = if ($null -ne $script:plan5hTodoData)    { [int]$script:plan5hTodoData.percent } else { $null }
  $todoCnt     = if ($null -ne $script:plan5hTodoData)    { ("{0}/{1}" -f $script:plan5hTodoData.completed, $script:plan5hTodoData.total) } else { $null }
  $payload = [PSCustomObject]@{
    state          = $state
    message        = $message
    progress       = -1
    usage5h        = $usageField
    usage5hResetMs = $resetField
    todoProgress   = $todoPct
    todosCount     = $todoCnt
    ts             = (Get-Date).ToString($FMT_O)
    source         = $S_DETECTOR
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($tmp, $payload, [System.Text.Encoding]::UTF8)
  Move-Item -Path $tmp -Destination $statusFile -Force
}

# 5h 用量：调 minimax /v1/coding_plan/remains，返回 general model 的 {remainingPct, resetMs}
# 无 token / 网络错 / 解析错 → 返回 $null
function Get-5hUsage {
  if (-not $script:plan5hToken) { return $null }
  try {
    # PowerShell 5.1 在某些 Windows 上默认 TLS 1.0；强制 1.2 避免握手失败
    if ([System.Net.ServicePointManager]::SecurityProtocol -notmatch 'Tls12') {
      [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    }
    $url = $PLAN_API_HOST + $PLAN_API_PATH
    $headers = @{
      'Authorization' = "Bearer $($script:plan5hToken)"
      'MM-API-Source' = _s (0x4D,0x69,0x6E,0x69,0x6D,0x61,0x78,0x2D,0x4D,0x43,0x50)  # Minimax-MCP
    }
    $resp = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 8 -Method Get -ErrorAction Stop
    if (-not $resp -or -not $resp.model_remains) { return $null }
    foreach ($m in @($resp.model_remains)) {
      if ($m.model_name -eq 'general') {
        $remPct = [int]$m.current_interval_remaining_percent
        if ($remPct -lt 0)   { $remPct = 0 }
        if ($remPct -gt 100) { $remPct = 100 }
        $resetMs = [int]$m.remains_time
        if ($resetMs -lt 0)  { $resetMs = 0 }
        return @{ remainingPct = $remPct; resetMs = $resetMs }
      }
    }
    return $null
  } catch {
    Log-Line ("5h usage fetch failed: " + $_.Exception.Message)
    return $null
  }
}

# 在主循环里每 60s 调一次（用 TTL 守门，单线程安全）
function Refresh-5hUsage {
  $now = Get-Date
  if (($now - $script:plan5hLastCallAt) -lt $PLAN_API_TTL) { return }
  $script:plan5hLastCallAt = $now
  $data = Get-5hUsage
  if ($null -eq $data) {
    $script:plan5hRemainingPct = $null
    $script:plan5hResetMs = $null
  } else {
    $script:plan5hRemainingPct = [int]$data.remainingPct
    $script:plan5hResetMs = [int]$data.resetMs
  }
}

# 读最新一次 todowrite 的 todos，计算完成百分比
# 缓存：mtime 不变就复用上次结果（典型场景：mcode 跑 1 分钟才动一次 todo）
function Get-TodoProgress {
  $latest = $script:lastLatestFile
  if (-not $latest -or -not (Test-Path $latest)) { return $null }

  $mtime = [System.IO.File]::GetLastWriteTimeUtc($latest)
  if ($mtime -eq $script:plan5hTodoCacheMtime -and $null -ne $script:plan5hTodoData) {
    return $script:plan5hTodoData
  }
  $script:plan5hTodoCacheMtime = $mtime

  try {
    # 从末尾向前找最近的 toolName=todowrite 且 role=toolResult 的行
    $lines = [System.IO.File]::ReadAllLines($latest, [System.Text.Encoding]::UTF8)
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      $line = $lines[$i]
      if ($line.IndexOf('"toolName":"todowrite"', [System.StringComparison]::Ordinal) -lt 0) { continue }
      if ($line.IndexOf('"role":"toolResult"', [System.StringComparison]::Ordinal) -lt 0) { continue }
      $j = $line | ConvertFrom-Json -ErrorAction SilentlyContinue
      if (-not $j -or -not $j.message -or -not $j.message.details -or -not $j.message.details.todos) { continue }
      $todos = @($j.message.details.todos)
      $total = $todos.Count
      $done = 0; $cancelled = 0
      foreach ($t in $todos) {
        if ($t.status -eq 'completed')  { $done++ }
        if ($t.status -eq 'cancelled')  { $cancelled++ }
      }
      $effective = $total - $cancelled
      if ($effective -le 0) {
        $script:plan5hTodoData = $null
        return $null
      }
      $percent = [int][Math]::Floor(($done * 100) / $effective)
      $script:plan5hTodoData = @{
        percent   = $percent
        completed = $done
        total     = $total
      }
      return $script:plan5hTodoData
    }
    # 走完没找到 = 没 todowrite 调用过
    $script:plan5hTodoData = $null
    return $null
  } catch {
    return $null
  }
}

function Read-StatusObj {
  if (!(Test-Path $statusFile)) { return $null }
  try { return ([System.IO.File]::ReadAllText($statusFile) | ConvertFrom-Json) } catch { return $null }
}

# === 主循环 ===
if (-not $Once) {
  Set-Content -Path $pidFile -Value $PID -Encoding ASCII
  Log-Line "detector started (PID $PID) mcodeRoot=$mcodeRoot"
}

try {
  while ($true) {
    $now = Get-Date
    $inferred = $null
    $latestFile = $null

    # 1) mcode 进程健康：5s 缓存（避免每秒 Get-ChildItem + Get-Process）
    if (($now - $script:lastMcodePidAt) -lt $CACHE_TTL) {
      $mcodePid = $script:lastMcodePid
    } else {
      $mcodePid = Get-McodePid
      $script:lastMcodePid = $mcodePid
      $script:lastMcodePidAt = $now
    }
    if (-not $mcodePid) {
      $inferred = @{ state=$S_ERROR; message=$MSG_MCODE_EXIT }
    } else {
      # 2) 最新 session log：5s 缓存（避免每秒 EnumerateFiles 几千个 .jsonl）
      if (($now - $script:lastLatestFileAt) -lt $CACHE_TTL) {
        $latestFile = $script:lastLatestFile
      } else {
        $latestFile = Get-LatestSessionFile
        $script:lastLatestFile = $latestFile
        $script:lastLatestFileAt = $now
      }
      if ($latestFile) {
        $msg = Read-LastMessage $latestFile
        if ($msg) {
          $inferred = Infer-State $msg
        }
      }
    }

    # 3) 60s 无活动 → idle 兜底（每次循环都跑，不再被 mtime 缓存屏蔽）
    if ($inferred -and $latestFile) {
      $curState = [string]$inferred.state
      $isSettled = ($curState -eq $S_IDLE) -or ($curState -eq $S_ERROR)
      if (-not $isSettled) {
        $age = ($now - [System.IO.File]::GetLastWriteTime($latestFile)).TotalSeconds
        if ($age -gt 60) {
          $inferred = @{ state=$S_IDLE; message=($MSG_IDLE_FMT -f [int]$age) }
        }
      }
    }

    if ($inferred) {
      $cur = Read-StatusObj
      $curSource = if ($cur) { [string]$cur.source } else { '' }
      $curState  = if ($cur) { [string]$cur.state  } else { '' }
      $newState  = [string]$inferred.state
      $newMsg    = [string]$inferred.message

      $isOwn = ($curSource -eq $S_DETECTOR)
      $stateChanged = ($curState -ne $newState)
      $isSettleNew  = ($newState -eq $S_IDLE) -or ($newState -eq $S_ERROR)

      $shouldWrite = $false
      $reason = ''

      if (-not $cur) {
        $shouldWrite = $true
        $reason = $R_NO_CURRENT
      } elseif ($isOwn -and $stateChanged) {
        $shouldWrite = $true
        $reason = $R_OWN_CHANGED
      } elseif ($isOwn -and ($cur.message -ne $newMsg) -and $newMsg) {
        $shouldWrite = $true
        $reason = $R_OWN_MSG
      } elseif (-not $isOwn -and $isSettleNew) {
        $shouldWrite = $true
        $reason = $R_TAKEOVER
      }

      if ($shouldWrite) {
        Write-Status $inferred.state $inferred.message
        if ($script:lastDetectedState -ne $newState) {
          Log-Line "$newState :: $newMsg ($reason)"
          $script:lastDetectedState = $newState
        }
      }
    }

    # 4) 5h 用量：每 60s 刷一次，刷新后若数字变化就写 status.json（让 widget 看到）
    $prevPct  = $script:plan5hRemainingPct
    $prevMs   = $script:plan5hResetMs
    Refresh-5hUsage
    $curPct   = $script:plan5hRemainingPct
    $curMs    = $script:plan5hResetMs
    $usageChanged = ($prevPct -ne $curPct) -or ($prevMs -ne $curMs) -and ($null -ne $curPct)
    if ($usageChanged) {
      $curForUsage = Read-StatusObj
      $sForU = if ($curForUsage) { [string]$curForUsage.state } else { $S_IDLE }
      $mForU = if ($curForUsage) { [string]$curForUsage.message } else { '' }
      Write-Status $sForU $mForU
      Log-Line ("5h usage refreshed: remaining=" + $curPct + "% resetMs=" + $curMs)
    }

    # 5) Todo 进度：每次都查（带 mtime 缓存），变化时写 status.json
    $prevTodoPct  = $script:plan5hLastWrittenTodoPct
    $curTodoData  = Get-TodoProgress
    $curTodoPct   = if ($null -ne $curTodoData) { $curTodoData.percent } else { $null }
    $todoChanged  = ($prevTodoPct -ne $curTodoPct)
    if ($todoChanged) {
      $curForTodo = Read-StatusObj
      $sForT = if ($curForTodo) { [string]$curForTodo.state } else { $S_IDLE }
      $mForT = if ($curForTodo) { [string]$curForTodo.message } else { '' }
      Write-Status $sForT $mForT
      $script:plan5hLastWrittenTodoPct = $curTodoPct
      if ($null -ne $curTodoData) {
        Log-Line ("todo refreshed: " + $curTodoData.completed + "/" + $curTodoData.total + " = " + $curTodoPct + "%")
      } else {
        Log-Line "todo refreshed: (none)"
      }
    }

    if ($Once) { break }
    Start-Sleep -Milliseconds 1000
  }
} finally {
  if (-not $Once -and (Test-Path $pidFile)) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  $STOPPED_MSG = _s (0x64,0x65,0x74,0x65,0x63,0x74,0x6F,0x72,0x20,0x73,0x74,0x6F,0x70,0x70,0x65,0x64)
  Log-Line $STOPPED_MSG
}
