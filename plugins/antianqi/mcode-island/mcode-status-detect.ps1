# mcode-status-detect.ps1 - 后台守护进程
# 监听 mcode session log，实时推断 agent 状态，写到 status.json
# 让 widget 不依赖 agent 主动调 notify-island.ps1 也能跟着动
#
# 信号源（每 1s 检查一次）：
#   1. mcode 主进程（PID 从 .mcode-active/<pid>.json 取）是否还活
#   2. .minimax/v2/sessions/<date>/*/messages.jsonl 最后一条 message
#   3. status.json 当前的 source（detector / agent 主动推）
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
  [switch]$Once
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
$R_NO_CURRENT    = _s (0x6E,0x6F,0x20,0x63,0x75,0x72,0x72,0x65,0x6E,0x74,0x20,0x73,0x74,0x61,0x74,0x75,0x73)  # no current status
$R_OWN_CHANGED   = _s (0x6F,0x77,0x6E,0x20,0x73,0x74,0x61,0x74,0x65,0x20,0x63,0x68,0x61,0x6E,0x67,0x65,0x64)  # own state changed
$R_OWN_MSG       = _s (0x6F,0x77,0x6E,0x20,0x6D,0x65,0x73,0x73,0x61,0x67,0x65,0x20,0x63,0x68,0x61,0x6E,0x67,0x65,0x64)  # own message changed
$R_TAKEOVER      = _s (0x74,0x61,0x6B,0x65,0x6F,0x76,0x65,0x72,0x20,0x74,0x6F,0x20,0x73,0x65,0x74,0x74,0x6C,0x65)  # takeover to settle

$configDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
$statusFile = Join-Path $configDir 'status.json'
$logFile    = Join-Path $configDir 'island.log'
$pidFile    = Join-Path $configDir 'detect.pid'

$mcodeActiveDir = 'C:\Users\Administrator\.minimax-code\.mcode-active'
$sessionsRoot   = 'C:\Users\Administrator\.minimax\v2\sessions'

# 全局状态
$script:lastDetectedState = ''
$script:lastMsgsSnapshot  = @{ mtime = '' }

function Log-Line($msg) {
  $ts = (Get-Date).ToString('HH:mm:ss')
  $line = "[$ts] [detect] $msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  if (-not $Once) { Write-Output $line }
}

function Get-McodePid {
  if (!(Test-Path $mcodeActiveDir)) { return $null }
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

function Get-LatestMessagesFile {
  if (!(Test-Path $sessionsRoot)) { return $null }
  Get-ChildItem -Path $sessionsRoot -Recurse -Filter 'messages.jsonl' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

function Read-LastMessage($file) {
  try {
    $st = Get-Item $file -ErrorAction Stop
    if ($script:lastMsgsSnapshot.mtime -eq $st.LastWriteTime.ToString($FMT_O_FULL)) { return $null }
    $script:lastMsgsSnapshot.mtime = $st.LastWriteTime.ToString($FMT_O_FULL)
    # Use FileStream with FileShare.ReadWrite so we never block mcode's writer.
    # Read backwards from end of file to find the last newline, then read forward.
    $fs = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      $len = $fs.Length
      if ($len -eq 0) { return $null }
      # Read up to last 64KB (single message is rarely > 64KB)
      $lookback = [Math]::Min($len, 65536)
      $fs.Seek(-$lookback, [System.IO.SeekOrigin]::End) | Out-Null
      $buf = New-Object byte[] $lookback
      $fs.Read($buf, 0, $lookback) | Out-Null
      $text = [System.Text.Encoding]::UTF8.GetString($buf)
      # Find last non-empty line
      $parts = $text -split "`n"
      for ($i = $parts.Length - 1; $i -ge 0; $i--) {
        $line = $parts[$i].TrimEnd("`r")
        if ($line -and $line.Length -gt 10) {
          return ($line | ConvertFrom-Json)
        }
      }
      return $null
    } finally {
      $fs.Close()
    }
  } catch {
    return $null
  }
}

function Infer-State($msg) {
  if (-not $msg -or -not $msg.message) { return $null }
  $m = $msg.message
  $role = [string]$m.role

  if ($role -eq $S_USER) { return @{ state=$S_IDLE;     message=$MSG_USER_WAIT } }

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
      return @{ state=$S_WORKING;  message="$tool : $argsJson" }
    }
    if ($hasThink -and -not $hasText) {
      return @{ state=$S_THINKING; message='' }
    }
    if ($hasText) {
      return @{ state=$S_IDLE; message=$MSG_AGENT_DONE }
    }
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
  Log-Line "detector started (PID $PID)"
}

try {
  while ($true) {
    $now = Get-Date
    $inferred = $null
    $latestFile = $null

    # 1) mcode 进程健康：每次都查（不靠 messages.jsonl 缓存）
    $mcodePid = Get-McodePid
    if (-not $mcodePid) {
      $inferred = @{ state=$S_ERROR; message=$MSG_MCODE_EXIT }
    } else {
      # 2) 读 messages.jsonl 推断
      $latestFile = Get-LatestMessagesFile
      if ($latestFile) {
        $msg = Read-LastMessage $latestFile.FullName
        if ($msg) {
          $inferred = Infer-State $msg
        }
      }
    }

    # 60s 无活动 → idle 兜底（但仅在推断状态不是 idle/error 时）
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
  $STOPPED_MSG = _s (0x64,0x65,0x74,0x65,0x63,0x74,0x6F,0x72,0x20,0x73,0x74,0x6F,0x70,0x70,0x65,0x64,0x20,0x5B,0x6E,0x6F,0x2D,0x72,0x75,0x6E,0x5D)
  Log-Line $STOPPED_MSG
}
