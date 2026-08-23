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

function Log-Line($msg) {
  $ts = (Get-Date).ToString('HH:mm:ss')
  $line = "[$ts] [detect] $msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  if (-not $Once) { Write-Output $line }
}

function Get-McodePid {
  if (-not (Test-Path $mcodeActiveDir)) { return $null }
  $candidates = Get-ChildItem -Path $mcodeActiveDir -Filter '*.json' -ErrorAction SilentlyContinue
  foreach ($f in $candidates) {
    try {
      $j = Get-Content $f.FullName -Raw | ConvertFrom-Json
      $targetPid = [int]$j.pid
      $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
      if ($proc -and -not $proc.HasExited) { return $targetPid }
    } catch {}
  }
  return $null
}

function Get-LatestSessionFile {
  if (-not $sessionsRoot -or -not (Test-Path $sessionsRoot)) { return $null }
  $all = Get-ChildItem -Path $sessionsRoot -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.PSIsContainer -eq $false -and ($_.Name -eq $FNAME_LEDGER -or $_.Name -eq $FNAME_MESSAGES) }
  if (-not $all) { return $null }
  # mcode v0.2.x writes messages.jsonl live; ledger.jsonl is best-effort and may
  # be left behind by an old session. Always pick whichever file is most
  # recently touched, otherwise a stale ledger would dominate and the
  # 60s-idle fallback would fire against ancient timestamps.
  $ledger = $all | Where-Object { $_.Name -eq $FNAME_LEDGER } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $msgs   = $all | Where-Object { $_.Name -eq $FNAME_MESSAGES } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($ledger -and $msgs) {
    if ($ledger.LastWriteTime -ge $msgs.LastWriteTime) { return $ledger }
    return $msgs
  }
  if ($ledger) { return $ledger }
  if ($msgs) { return $msgs }
  return $null
}

function Read-LastMessage($file) {
  try {
    $st = Get-Item $file -ErrorAction Stop
    $mtime = $st.LastWriteTime.ToString($FMT_O_FULL)
    if ($script:lastMsgsSnapshot.mtime -eq $mtime) {
      # mtime 没变：返回上次推断结果（保持 idle 兜底可达）
      return $script:lastMsgsSnapshot.lastInferred
    }
    $script:lastMsgsSnapshot.mtime = $mtime
    $fs = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
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
    $hasTool   = @($m.content | Where-Object { $_.type -eq $S_TOOLCALL  }) | Select-Object -First 1
    $hasThink  = @($m.content | Where-Object { $_.type -eq $S_THINK_BLK }) | Select-Object -First 1
    $hasText   = @($m.content | Where-Object { $_.type -eq $S_TEXT      }) | Select-Object -First 1

    if ($hasTool) {
      $tool  = $hasTool.name
      $args  = $hasTool.arguments
      if ($args) {
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
  $payload = [PSCustomObject]@{
    state    = $state
    message  = $message
    progress = -1
    ts       = (Get-Date).ToString($FMT_O)
    source   = $S_DETECTOR
  } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($tmp, $payload, [System.Text.Encoding]::UTF8)
  Move-Item -Path $tmp -Destination $statusFile -Force
}

function Read-StatusObj {
  if (!(Test-Path $statusFile)) { return $null }
  try { return (Get-Content $statusFile -Raw | ConvertFrom-Json) } catch { return $null }
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

    # 1) mcode 进程健康：每次都查
    $mcodePid = Get-McodePid
    if (-not $mcodePid) {
      $inferred = @{ state=$S_ERROR; message=$MSG_MCODE_EXIT }
    } else {
      # 2) 读 session log 推断
      $latestFile = Get-LatestSessionFile
      if ($latestFile) {
        $msg = Read-LastMessage $latestFile.FullName
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
        $age = ($now - $latestFile.LastWriteTime).TotalSeconds
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
