# mcode-status-detect.ps1 - 后台守护进程 (v0.2.1)
# 监听 mcode session log，实时推断 agent 状态，写到 status.json
# 让 widget 不依赖 agent 主动调 notify-island.ps1 也能跟着动
#
# 路径解析（顺序）：
#   1. 用户显式 -Root 覆盖
#   2. 桌面端数据目录 $env:MINIMAX_DATA_DIR（没有则用 <userprofile>/.minimax）
#   3. <userprofile>
#
# session log（顺序）：
#   1. <dataDir>/v2/sessions/<date>/*/ledger.jsonl（首选，mcode v2 事件流）
#   2. <dataDir>/v2/sessions/<date>/*/messages.jsonl（fallback）
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
# 字符串常量
#   以前这里用 _s (byte[]) 构造，理由是"PS 5.1 在 -eq / state= 后面会把短的
#   ASCII 字面量当成 cmdlet 参数"。实测下来这些常量都是先赋给变量、后面
#   只拿变量去比较，字面量从不直接出现在 -eq 后面，所以明文写法在 PS 5.1
#   下解析 0 错误、行为一致（Windows PowerShell 5.1 实跑 -Once 验证过）。
#   字节数组只会让常量对阅读者不可见，已全部改回明文。

param(
  [switch]$Once,
  [string]$Root = ''    # override: the directory that holds .minimax/v2/sessions
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


# role names
$S_USER       = 'user'
$S_ASSISTANT  = 'assistant'
$S_TOOLRESULT = 'toolResult'
$S_COMPACTION = 'compactionSummary'
# state values
$S_IDLE     = 'idle'
$S_THINKING = 'thinking'
$S_WORKING  = 'working'
$S_WAITING  = 'waiting'
$S_DONE     = 'done'
$S_ERROR    = 'error'
# content type discriminators
$S_TOOLCALL  = 'toolCall'
$S_TEXT      = 'text'
$S_THINK_BLK = 'thinking'
# source tag
$S_DETECTOR  = 'detector'
# messages (UTF-8 encoded Chinese)
$MSG_USER_WAIT  = '等用户'              # 等用户
$MSG_AGENT_DONE = 'agent 刚回复，等用户'  # agent 刚回复，等用户
$MSG_COMPACT    = 'session 压缩'  # session 压缩
$MSG_IDLE_FMT   = '已静默 {0}s'  # 已静默 {0}s
$DOTS            = '...'                                                # ...
$FMT_O           = 'o'                                                           # 'o' (ISO 8601 timestamp)
$FMT_O_FULL      = 'O'                                                           # 'O' (ISO 8601 full)
# log reason tags
$R_NO_CURRENT    = 'no current status'
$R_OWN_CHANGED   = 'own state changed'
$R_OWN_MSG       = 'own message changed'
$R_TAKEOVER      = 'takeover to settle'
# session log file names (优先 ledger)
$FNAME_LEDGER    = 'ledger.jsonl'   # ledger.jsonl
$FNAME_MESSAGES  = 'messages.jsonl'  # messages.jsonl
# tool action verbs (ASCII — matches the mcode CLI TUI descriptor table HL)
# Mirrors @minimax-ai/code launcher-GHPADSKI.js HL[] so the pill shows the same
# present-tense verb ("Running") while the tool is in flight and the same
# past-tense verb ("Ran") once it returns, instead of a generic tool name.
$TOOL_ACTIONS = @{
  'bash'        = @{ running='Running';     done='Ran';          fail='Command failed' }
  'shell'       = @{ running='Running';     done='Ran';          fail='Command failed' }
  'edit'        = @{ running='Editing';     done='Edited';       fail='Edit failed' }
  'write'       = @{ running='Writing';     done='Wrote';        fail='Write failed' }
  'read'        = @{ running='Reading';     done='Read';         fail='Read failed' }
  'grep'        = @{ running='Searching';   done='Searched';     fail='Search failed' }
  'search'      = @{ running='Searching';   done='Searched';     fail='Search failed' }
  'glob'        = @{ running='Listing';     done='Listed';       fail='List failed' }
  'list'        = @{ running='Listing';     done='Listed';       fail='List failed' }
  'task'        = @{ running='Delegating';  done='Delegated';    fail='Delegation failed' }
  'web_search'  = @{ running='Web searching'; done='Web searched'; fail='Web search failed' }
  'web_fetch'   = @{ running='Fetching';     done='Fetched';      fail='Fetch failed' }
  'todowrite'   = @{ running='Planning';    done='Planned';      fail='Plan update failed' }
  'task_output' = @{ running='Reading task'; done='Read task';    fail='Task read failed' }
  'task_append' = @{ running='Steering task'; done='Steered task'; fail='Task steer failed' }
  'task_query'  = @{ running='Checking tasks'; done='Checked tasks'; fail='Task check failed' }
  'ask_user'    = @{ running='Asking';      done='Asked';        fail='Question failed' }
  'request_feature_enable' = @{ running='Requesting access'; done='Access requested'; fail='Access request failed' }
}
# Tool family — the pill tints its dot by family instead of by state, so a
# read looks different from a write at a glance. Mirrors the `family` field
# of the mcode CLI TUI descriptor table (launcher-GHPADSKI.js HL[]).
# Unknown tools get no family (null) and fall back to the state color.
$TOOL_FAMILIES = @{
  'bash' = 'shell';  'shell' = 'shell'
  'read' = 'read'
  'edit' = 'write';  'write' = 'write'
  'grep' = 'search'; 'search' = 'search'; 'glob' = 'search'; 'list' = 'search'
  'task' = 'task'; 'task_output' = 'task'; 'task_append' = 'task'
  # ask_user is deliberately absent: it maps to the `waiting` state (see
  # Infer-State), and a waiting pill should wear the state color, not a family
  # tint. Giving it 'task' would paint the "come back, I'm blocked" signal in
  # the same cyan as an in-flight delegation.
  'web_search' = 'web'; 'web_fetch' = 'web'
  'todowrite' = 'plan'
  'request_feature_enable' = 'plan'
}
# default for tools not in the table (kept lowercase so it reads like a name)
$TOOL_FALLBACK_RUNNING = 'Using'   # Using
$TOOL_FALLBACK_DONE    = 'Used'         # Used
# v2 sessions relative to user profile
$V2_SESSIONS_REL = '.minimax\v2\sessions'  # .minimax\v2\sessions

$configDir = Join-Path $env:APPDATA 'mcode-island'
if (!(Test-Path $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
# status.json 的路径由 store 库统一解析（Get-StatusFilePath），这里不再
# 维护第二份，避免两个来源对不上。
$logFile    = Join-Path $configDir 'island.log'
$pidFile    = Join-Path $configDir 'detect.pid'
$cfgFile    = Join-Path $configDir 'config.json'

# 5h 用量 API：每 60s 调一次 minimax /v1/coding_plan/remains，写进 status.json 的 usage5h 字段
#
# 这是一个**可选**能力。真正干活的代码（URL、请求头、token 解析、刷新逻辑）
# 全部在 scripts/lib/Get-5hUsage.ps1 里，detector 这里只判断"这个 lib 在不在"。
#
# lib 不在时（MiniMax Marketplace 的上架包就不携带它），整条 5h 链路直接关闭：
# 不读任何 token、不发任何网络请求、status.json 里也没有 usage5h 字段。
$script:plan5hAvailable = $false
if (Test-Path "$PSScriptRoot/scripts/lib/Get-5hUsage.ps1") {
  . "$PSScriptRoot/scripts/lib/Get-5hUsage.ps1"
  $script:plan5hAvailable = $true
  Resolve-PlanToken
}
# Shared redaction helper (round-20). The detector is the SECOND producer
# of tool text -- it re-derives messages from mcode's session log rather
# than from a hook event, so it needs the same redaction the hook path
# applies. Wiring only the hook left the raw command in island.log.
. "$PSScriptRoot/scripts/lib/Protect-Text.ps1"
# 运行时落盘的套餐用量(零凭据:只读本地文件,自己不联网)
. "$PSScriptRoot/scripts/lib/Plan-Usage.ps1"
# Cross-process status.json protocol (round-21 review #1).
#
# The detector and the agent hooks are two independent processes that
# both write status.json. They had no mutual exclusion: the detector
# read the file, a hook wrote it, and the detector then overwrote the
# hook's write with a payload built from the older read. This lib holds
# the lock, the single snapshot read and the atomic replace, so both
# sides follow one protocol.
. "$PSScriptRoot/scripts/lib/Status-Store.ps1"
# 多 session 跟踪（v0.5.0）。
#
# 以前 pill 只显示一个 session：Get-LatestSessionFile 取最近被改的那个日志，
# 所以"谁最后动了日志就显示谁"，后台会话能把前台的 pill 抢走。这个 lib
# 维护一份有生命周期的 session 列表（运行中 / 待回复 / 点掉消除），写到
# sessions.json —— 不是 status.json，因为那个文件 agent 侧会整份覆盖。
#
# $script: 在 dot-source 之后就是本脚本的作用域，所以 lib 里的状态变量和
# 这里的状态变量是同一份。
. "$PSScriptRoot/scripts/lib/Session-Tracker.ps1"
$script:plan5hLastCallAt = [DateTime]::MinValue
$script:plan5hRemainingPct = $null  # 0..100，剩余百分比（不再是已用！）
$script:plan5hResetMs = $null       # 距下次刷新的毫秒数

# Todo 进度缓存（widget 进度条用）：completed / (total - cancelled) * 100
$script:plan5hTodoData = $null      # @{ percent; currentTodo; completed; total }
$script:plan5hTodoCacheMtime = [DateTime]::MinValue
$script:plan5hLastWrittenTodoPct = $null  # 上次写到 status.json 的 todoProgress（用来检测变化）

# 解析 MiniMax Code 的数据根目录
#
# 投放目标是桌面端（MiniMax Code app），所以优先按桌面端的数据目录找：
#   会话流固定在 <dataDir>/v2/sessions，根目录取 <dataDir> 的父目录。
#   MINIMAX_DATA_DIR 是官方支持的数据目录覆盖环境变量。
#
# 之前这里只认 MiniMax Code CLI 的安装目录，而且是从 CLI 的 node 进程
# cmdline 里反查出来的。桌面端用户没有装 CLI，于是这个函数返回 null，
# detector 直接 exit 2 —— 状态检测在桌面端根本跑不起来。
function Find-McodeRoot {
  # 1) 用户显式 -Root 覆盖
  if ($script:optRoot -and (Test-Path $script:optRoot)) { return $script:optRoot }

  # 2) 桌面端数据目录
  foreach ($dataDir in Get-DataDirs) {
    if (Test-Path (Join-Path $dataDir 'v2\sessions')) {
      $parent = Split-Path -Parent $dataDir
      if ($parent) { return $parent }
    }
  }

  # 3) 兜底：用户主目录
  if ($env:USERPROFILE) { return $env:USERPROFILE }

  return $null
}

# 桌面端的数据目录候选（按优先级）
function Get-DataDirs {
  $dirs = @()
  if ($env:MINIMAX_DATA_DIR) { $dirs += $env:MINIMAX_DATA_DIR }
  if ($env:USERPROFILE) { $dirs += (Join-Path $env:USERPROFILE '.minimax') }
  return $dirs
}

# sessions 根目录（桌面端优先）
function Get-SessionsRoot($mcodeRoot) {
  # 1) 桌面端：<dataDir>/v2/sessions
  foreach ($dataDir in Get-DataDirs) {
    $candidate = Join-Path $dataDir 'v2\sessions'
    if (Test-Path $candidate) { return $candidate }
  }

  # 2) <userprofile>/.minimax/v2/sessions
  if ($env:USERPROFILE) {
    $candidate = Join-Path $env:USERPROFILE $V2_SESSIONS_REL
    if (Test-Path $candidate) { return $candidate }
  }

  # 3) 兜底：根目录的上一级里找 .minimax/v2/sessions
  if ($mcodeRoot) {
    $parent = Split-Path -Parent $mcodeRoot
    $candidate = Join-Path $parent (Join-Path '.minimax' (Join-Path 'v2' 'sessions'))
    if (Test-Path $candidate) { return $candidate }
  }

  return $null
}

$script:optRoot = $Root
$mcodeRoot = Find-McodeRoot
$sessionsRoot   = Get-SessionsRoot $mcodeRoot
if (-not $sessionsRoot) {
  Write-Error "Cannot find the MiniMax Code session store (~/.minimax/v2/sessions). Set MINIMAX_DATA_DIR or pass -Root."
  exit 2
}

# 全局状态
$script:lastDetectedState = ''
$script:lastMsgsSnapshot  = @{ path = ''; mtime = ''; lastInferred = $null }

# 5s 缓存：最新 session log 路径
# 避免每秒调 Get-LatestSessionFile（每次都涉及 Get-ChildItem
# 之类的 cmdlet，PS 5.1 hidden window 下会累积 Runspace 线程，9 小时后
# 池子被占满 → poll 不再前进 → widget 卡死）。
$CACHE_TTL = [TimeSpan]::FromSeconds(5)
$script:lastLatestFile   = $null
$script:lastLatestFileAt = [DateTime]::MinValue

# island.log 上限（round-20）
#
# island.log 一直是裸 Add-Content，从 2026-08-22 起没有任何截断，
# 38 天累积到 18MB。日志内容包含从 session log 推断出来的工具参数，
# 所以"无上限保留"同时是磁盘问题也是留存问题。这里给一个硬上限：
# 超过阈值时只保留最后 $logKeepLines 行。
#
# 阈值检查不每次调用都做：Add-Content 是 O(1) 追加，先用计数器累计到
# 1/4 阈值才 stat 一次文件，避免在 400ms 轮询路径上反复摸磁盘。
$script:logMaxBytes   = 1MB
$script:logKeepLines  = 300
$script:logPending    = 0

function Log-Line($msg) {
  $ts = (Get-Date).ToString('HH:mm:ss')
  $line = "[$ts] [detect] $msg"
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  $script:logPending += $line.Length + 2
  if ($script:logPending -ge [int]($script:logMaxBytes / 4)) {
    $script:logPending = 0
    try {
      $fi = Get-Item -LiteralPath $logFile -ErrorAction Stop
      if ($fi.Length -gt $script:logMaxBytes) {
        $keep = @(Get-Content -LiteralPath $logFile -Tail $script:logKeepLines -Encoding UTF8)
        [System.IO.File]::WriteAllLines(
          $logFile, $keep, (New-Object System.Text.UTF8Encoding($false)))
      }
    } catch {
      # 截断失败不能拖垮检测循环；下一轮阈值到了会再试一次。
    }
  }
  if (-not $Once) { Write-Output $line }
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

# Reads the last COMPLETE json line of a session log.
#
# The old implementation read a fixed 64 KB tail window and parsed the
# fragments backwards. One session-log line can be far bigger than that: an
# agent that reads a screenshot writes the base64 image into a single line
# (200 KB - 560 KB in the wild), and a big file read is just as fat. The
# window then held nothing but a fragment of that line, ConvertFrom-Json
# threw on it, and the catch-all returned the previously cached inference --
# which belonged to an earlier file, often an earlier conversation. The pill
# then showed the previous task's state for the whole new conversation.
#
# So the window grows until a line actually parses. Reading one fat line is
# cheap (a few hundred KB, once per change); reporting another session's
# state is not.
function Get-LastJsonLine($file) {
  $fi = [System.IO.FileInfo]::new($file)
  $len = $fi.Length
  if ($len -le 0) { return $null }
  # A single line is never allowed to pull more than 8 MB into memory.
  $cap = [Math]::Min($len, 8MB)
  $window = [Math]::Min($len, 65536)
  while ($window -le $cap) {
    $fs = $null
    try {
      $fs = [System.IO.File]::Open($fi.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      [void]$fs.Seek(-$window, [System.IO.SeekOrigin]::End)
      $buf = New-Object byte[] $window
      [void]$fs.Read($buf, 0, $window)
    } catch {
      return $null
    } finally {
      if ($fs) { $fs.Close() }
    }
    $text = [System.Text.Encoding]::UTF8.GetString($buf)
    $parts = $text -split "`n"
    # Walk backwards. Index 0 is the fragment the window cut into, so it is
    # only trustworthy when the whole file is inside the window.
    for ($i = $parts.Length - 1; $i -ge 1; $i--) {
      $line = $parts[$i].TrimEnd("`r")
      if (-not $line -or $line.Length -le 10) { continue }
      try { return ($line | ConvertFrom-Json) } catch { continue }
    }
    if ($window -ge $len) {
      # The whole file is here: the first fragment is a complete line too.
      $line = $parts[0].TrimEnd("`r")
      if ($line.Length -gt 10) {
        try { return ($line | ConvertFrom-Json) } catch { return $null }
      }
    }
    $next = $window * 2
    if ($next -gt $cap) { $next = $cap }
    if ($next -eq $window) { break }
    $window = $next
  }
  return $null
}

function Read-LastMessage($file) {
  if (-not $file) { return $null }
  try {
    $fi = [System.IO.FileInfo]::new($file)
    $mtime = $fi.LastWriteTime.ToString($FMT_O_FULL)
    # The cache is keyed on path AND mtime. Keying it on the mtime alone
    # let a session switch return the previous file's message, because two
    # files touched in the same tick share an mtime.
    if ($script:lastMsgsSnapshot.path -eq $file -and $script:lastMsgsSnapshot.mtime -eq $mtime) {
      # mtime 没变：返回上次推断结果（保持 idle 兜底可达）
      return $script:lastMsgsSnapshot.lastInferred
    }
    $msg = Get-LastJsonLine $file
    $script:lastMsgsSnapshot.path = $file
    $script:lastMsgsSnapshot.mtime = $mtime
    $script:lastMsgsSnapshot.lastInferred = $msg
    return $msg
  } catch {
    # A file we cannot read right now (locked, mid-write) must not make us
    # report another session's state. Returning $null leaves the current
    # status untouched, which is the honest answer: "no new information".
    return $null
  }
}

# Normalize a tool name to the key shape used by $TOOL_ACTIONS
# (mcode's own Wt(): trim, lowercase, '-' -> '_'). Untrusted agent-supplied
# strings, so guard the length: a 4KB "tool name" must not become a map key.
function Get-ToolKey($name) {
  if (-not $name) { return '' }
  $n = ([string]$name).Trim().ToLowerInvariant().Replace('-', '_')
  if ($n.Length -gt 64) { $n = $n.Substring(0, 64) }
  return $n
}

# Resolve the action verb for a tool in a given phase.
#   phase: 'running' | 'done' | 'fail'
# Returns '' for an unknown tool so callers can fall back to the raw name.
function Get-ToolVerb($name, $phase) {
  $key = Get-ToolKey $name
  if (-not $key) { return '' }
  $entry = $TOOL_ACTIONS[$key]
  if (-not $entry) { return '' }
  switch ($phase) {
    'running' { return [string]$entry.running }
    'done'    { return [string]$entry.done }
    'fail'    { return [string]$entry.fail }
  }
  return ''
}

# Verb for an unknown tool: "Using <name>" / "Used <name>", so the pill
# never falls back to a bare identifier with no signal about the phase.
function Get-ToolVerbFallback($name, $phase) {
  $key = Get-ToolKey $name
  if (-not $key) { return '' }
  if ($phase -eq 'running') { return "$TOOL_FALLBACK_RUNNING $key" }
  return "$TOOL_FALLBACK_DONE $key"
}

function Get-ToolFamily($name) {
  $key = Get-ToolKey $name
  if (-not $key) { return $null }
  $fam = $TOOL_FAMILIES[$key]
  if ($fam) { return [string]$fam }
  return $null
}

# Human-readable one-liner for a tool's arguments (round-20 #6).
#
# The running-state message used to be built as
#   "$verb " + (ConvertTo-Json $args -Compress)  truncated to 60 chars
# which put this on an always-on-top, one-line pill:
#
#   Running {"command":"$ErrorActionPreference=\u0027Continue\u0027\n...
#
# Escaped quotes, a JSON key, and a truncation that can land mid-token.
# `skill` is not in $TOOL_ACTIONS or $TOOL_FAMILIES, so it always took
# that path -- one of the most frequent tools on screen was also the
# least readable.
#
# Contract: return the single most informative field for the tool, or ''
# when there is nothing worth showing. Callers render the verb alone in
# that case. Raw JSON is never returned -- there is no fallback to it.
#
# Unknown tools get a generic sweep of the common field names before
# giving up, because the tool taxonomy is hand-maintained and does not
# cover every tool mcode ships.
# NB: the second parameter must NOT be called `$args`. That name is a
# reserved automatic variable in PowerShell, and binding a parameter to
# it yields the unbound-argument Object[] rather than the object passed in
# -- verified: `function T($n, $args) { $args.command }` called with
# `[PSCustomObject]@{command='npm test'}` returns an empty string, because
# the parameter arrives as Object[]. Symptom is a summary that is empty for
# every single tool, which looks like "no data" rather than "bad binding".
function Format-ToolArgs($name, $toolArgs) {
  if (-not $toolArgs) { return '' }
  $key  = ([string]$name).ToLowerInvariant()
  $raw  = ''
  switch ($key) {
    'bash'          { $raw = [string]$toolArgs.command }
    'shell'         { $raw = [string]$toolArgs.command }
    'read'          { $raw = [string]$toolArgs.file_path }
    'write'         { $raw = [string]$toolArgs.file_path }
    'edit'          { $raw = [string]$toolArgs.file_path }
    'notebookedit'  { $raw = [string]$toolArgs.notebook_path }
    'grep'          { $raw = [string]$toolArgs.pattern }
    'glob'          { $raw = [string]$toolArgs.pattern }
    'list'          { $raw = [string]$toolArgs.path }
    'search'        { $raw = [string]$toolArgs.query }
    'web_search'    { $raw = [string]$toolArgs.query }
    'web_fetch'     { $raw = [string]$toolArgs.url }
    'skill'         { $raw = [string]$toolArgs.name }
    'task'          { $raw = [string]$toolArgs.description }
    'task_output'   { $raw = [string]$toolArgs.task_id }
    'task_append'   { $raw = [string]$toolArgs.task_id }
    'task_query'    { $raw = [string]$toolArgs.task_id }
    default {
      foreach ($f in 'name','command','file_path','path','pattern','query','url','description','task_id') {
        if ($toolArgs.PSObject.Properties[$f]) {
          $v = [string]$toolArgs.$f
          if (-not [string]::IsNullOrWhiteSpace($v)) { $raw = $v; break }
        }
      }
    }
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { return '' }

  # The pill is a single line, and an agent command is usually a short
  # script rather than one line. Prefer the first line that actually
  # EXECUTES something over the first line that merely sets the stage.
  #
  # `$ErrorActionPreference='Continue'` is the opening line of most agent
  # commands and says nothing about what is being worked on; reading it
  # off a status pill is indistinguishable from the pill being stuck. The
  # first real command below it -- `npm test`, `Get-ChildItem` -- is the
  # line the user actually wants.
  $fallback = ''
  $first = ''
  foreach ($ln in ($raw -split "`r?`n")) {
    $t = $ln.Trim()
    if ($t -eq '') { continue }
    if ($fallback -eq '') { $fallback = $t }
    if ($t.StartsWith('#')) { continue }   # comment
    if ($t.StartsWith('$')) { continue }   # variable assignment / preference set
    $first = $t
    break
  }
  # Every line was boilerplate. Showing the assignment beats showing nothing.
  if ($first -eq '') { $first = $fallback }
  if ([string]::IsNullOrWhiteSpace($first)) { return '' }

  # Same redaction the hook path applies, so a credential in a command
  # cannot reach the pill or island.log through this route either.
  $first = Protect-SecretText $first
  $first = ($first -replace '\s+', ' ').Trim()
  if ($first.Length -gt 60) { $first = $first.Substring(0, 57) + $DOTS }
  return $first
}

# ask_user is the one tool whose "in flight" state means the agent is BLOCKED,
# not busy. When the questionnaire pops, nothing progresses until the user
# comes back and answers. Reporting it as `working` tells the user "leave it
# alone, it's making progress", which is the opposite of the truth -- so it
# maps to `waiting` (the same state the permission hook uses) with a question
# count, because "Asking 2 questions" is exactly the "come back" signal.
#
# Returns $null for every other tool, so the caller can fall through to the
# normal verb lookup.
function Test-IsAskUser($name) {
  return ((Get-ToolKey $name) -eq 'ask_user')
}

function Get-AskQuestionCount($toolArgs) {
  # Parameter is deliberately NOT named $args: that is a PowerShell automatic
  # variable, and shadowing it makes every read inside the function return the
  # function's own argument list instead of the caller's value. It silently
  # produced a count of 0 for every input, which degraded the message to a
  # bare "Asking".
  if (-not $toolArgs) { return 0 }
  try {
    $a = $toolArgs
    if ($a -is [string]) { $a = $a | ConvertFrom-Json -ErrorAction Stop }
    $qs = $a.PSObject.Properties['questions']
    if (-not $qs -or $null -eq $qs.Value) { return 0 }
    return @($qs.Value).Count
  } catch { return 0 }
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
      $tv = [string]$msg.toolName
      if ($msg.isError -eq $true) {
        $verb = Get-ToolVerb $tv 'fail'
        if (-not $verb) { $verb = Get-ToolVerbFallback $tv 'fail' }
        return @{ state=$S_ERROR; message=$verb; family=$null }
      }
      $verb = Get-ToolVerb $tv 'done'
      if (-not $verb) { $verb = Get-ToolVerbFallback $tv 'done' }
      return @{ state=$S_DONE; message=$verb; family=(Get-ToolFamily $tv) }
    }
    if ($kind -eq 'toolCall' -or $kind -eq $S_TOOLCALL) {
      $tv = [string]$msg.toolName
      if (Test-IsAskUser $tv) {
        $n = Get-AskQuestionCount $msg.arguments
        if ($n -gt 0) { return @{ state=$S_WAITING; message="Asking $n question$(if ($n -gt 1) { 's' })"; family=$null } }
        return @{ state=$S_WAITING; message='Asking'; family=$null }
      }
      $verb = Get-ToolVerb $tv 'running'
      if (-not $verb) { $verb = Get-ToolVerbFallback $tv 'running' }
      $detail = [string]$msg.action
      if ($detail) { return @{ state=$S_WORKING; message="$verb $detail"; family=(Get-ToolFamily $tv) } }
      return @{ state=$S_WORKING; message=$verb; family=(Get-ToolFamily $tv) }
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
      if (Test-IsAskUser $tool) {
        $n = Get-AskQuestionCount $args
        if ($n -gt 0) { return @{ state=$S_WAITING; message="Asking $n question$(if ($n -gt 1) { 's' })"; family=$null } }
        return @{ state=$S_WAITING; message='Asking'; family=$null }
      }
      $verb  = Get-ToolVerb $tool 'running'
      if (-not $verb) { $verb = Get-ToolVerbFallback $tool 'running' }
      # Readable summary, never raw JSON (round-20 #6). When there is
      # nothing worth showing the pill wears the bare verb, which reads
      # fine -- "Using" beats "Using {\"name\":\"...\"}".
      $summary = Format-ToolArgs $tool $args
      if ($summary) {
        return @{ state=$S_WORKING; message="$verb $summary"; family=(Get-ToolFamily $tool) }
      }
      return @{ state=$S_WORKING; message=$verb; family=(Get-ToolFamily $tool) }
    }
    if ($hasThink -and -not $hasText) { return @{ state=$S_THINKING; message='' } }
    if ($hasText) { return @{ state=$S_IDLE; message=$MSG_AGENT_DONE } }
    return @{ state=$S_IDLE; message='' }
  }

  if ($role -eq $S_TOOLRESULT) {
    $tool  = $m.toolName
    $isErr = $m.isError -eq $true
    if ($isErr) {
      $verb = Get-ToolVerb $tool 'fail'
      if (-not $verb) { $verb = Get-ToolVerbFallback $tool 'fail' }
      return @{ state=$S_ERROR; message=$verb; family=$null }
    }
    $verb = Get-ToolVerb $tool 'done'
    if (-not $verb) { $verb = Get-ToolVerbFallback $tool 'done' }
    return @{ state=$S_DONE; message=$verb; family=(Get-ToolFamily $tool) }
  }

  if ($role -eq $S_COMPACTION) { return @{ state=$S_IDLE; message=$MSG_COMPACT } }

  return $null
}

# Writes status.json.
#
# Two write semantics, and they must not be confused (round-20 #5, #7):
#
#   - state inference (default): the detector inferred a new state from
#     the session log and is asserting it. The sub-step counters are
#     reset: they belong to whatever the hook pushed last and have no
#     relationship to this message. `source` becomes `detector`, which
#     is the arbitration token that lets the detector rewrite this
#     state later.
#
#   - metadata refresh (-MetadataRefresh): the 60s 5h-usage refresh and
#     the todo-progress refresh. They restate the current state and
#     refresh numbers; they do not claim the state. So state, message,
#     family, the sub-step counters and `source` all come from the
#     snapshot taken in this same call.
#
# Both run under one exclusive lock and take exactly ONE snapshot
# (round-21 review hetaoBackend #1). The previous version read the
# file twice -- once here for the sub-step fields and once at the call
# site for the state -- and then wrote the result back over the whole
# file, so a hook write landing between the two reads was either mixed
# into a stale payload or lost outright.
function Write-Status($state, $message, $family, [switch]$MetadataRefresh) {
  $lock = Enter-StatusLock
  try {
    Write-StatusUnderLock $state $message $family -MetadataRefresh:$MetadataRefresh
  } finally {
    Exit-StatusLock $lock
  }
}

# The body of Write-Status, for callers that already hold the lock.
# Splitting it out is what lets the arbitration path read the snapshot
# and act on it without taking the lock twice: the lock is not
# re-entrant, because a nested take would deadlock against itself.
function Write-StatusUnderLock($state, $message, $family, [switch]$MetadataRefresh) {
  # usage5h：0..100 表示"剩余"百分比（不是已用！）；null = 未知/未拉到
  # usage5hResetMs：距下次刷新的毫秒数；null = 未知
  # todoProgress：0..100 完成百分比（cancelled 不计）；null = 无 todo 列表
  # family：工具家族（shell/read/write/search/task/web/plan）；null = 无状态色可用
  $usageField  = if ($null -ne $script:plan5hRemainingPct) { [int]$script:plan5hRemainingPct } else { $null }
  $resetField  = if ($null -ne $script:plan5hResetMs)     { [int]$script:plan5hResetMs }     else { $null }
  $todoPct     = if ($null -ne $script:plan5hTodoData)    { [int]$script:plan5hTodoData.percent } else { $null }
  $todoCnt     = if ($null -ne $script:plan5hTodoData)    { ("{0}/{1}" -f $script:plan5hTodoData.completed, $script:plan5hTodoData.total) } else { $null }

  # The one snapshot. Every field below is derived from it, so the
  # payload is always a single coherent generation.
  $prev = Read-StatusSnapshot

  $curState = $state
  $curMsg   = $message
  $famField = if ($family) { [string]$family } else { $null }

  if ($MetadataRefresh) {
    $curState = if ($prev) { [string]$prev.state } else { $S_IDLE }
    $curMsg   = if ($prev) { [string]$prev.message } else { '' }
    # A null family must stay null, not become an empty string: the
    # widget asks "is there a family to tint with", and "[string]$null"
    # would answer with a string that means the same thing to it but
    # changes the on-disk shape of the payload.
    $famField = if ($prev -and $prev.PSObject.Properties['family'] -and $null -ne $prev.family) { [string]$prev.family } else { $null }
  }

  # step / total / detail 是 agent（hook）推的 sub-step 状态，不是 detector
  # 推的。detector 重写整个 payload 时，这里怎么处理取决于"为什么写"。
  #
  # 两种写入语义完全不同（round-20 #5）：
  #
  #   - 元数据刷新（-MetadataRefresh）：每 60s 刷 5h 用量、每次刷 todo 进度。
  #     这两次的 state/message 是从当前 status.json 读回来原样再写回去的，
  #     不代表"agent 进入了新的一步"，所以必须把已有的 sub-step 合并回来，
  #     否则正常使用中的进度会被静默清零（round-19 #2）。
  #
  #   - 状态推断（默认）：detector 从 session log 推出一个新状态并写入。
  #     这条消息的语义是"agent 现在在干这个"，它和上一条 hook 推的
  #     sub-step 没有任何承接关系。无条件合并会让 pill 一直挂着上一步的
  #     计数：实测里 agent 早已换工具、甚至这一轮都结束了，pill 还卡在
  #     "step 1/1" 显示一条早就跑完的 curl 命令，而且没有任何后续写入会
  #     把它清掉。所以状态推断一律重置。
  $stepField   = -1
  $totalField  = -1
  $detailField = ''
  # `source` is the arbitration token, not a label (round-20 #7). The
  # detector's settle logic reads `source == detector` as "this state is
  # mine to rewrite". A metadata refresh restates the current state and
  # refreshed numbers -- it does not claim the state -- so stamping
  # `detector` on it silently hands write authority back to the detector.
  #
  # Observed consequence: a tool fails, the detector infers `error`, the
  # PostToolUse hook pushes the same `error` (source=agent), then the 60s
  # 5h-usage refresh stamps `detector` over it. From then on the detector
  # owns the state and re-derives `error` from the same stale failed
  # toolResult on every poll, clobbering the Stop hook's `done`. The pill
  # sat on "Command failed" until the 60s no-event fallback finally
  # dropped it to idle.
  $sourceField = $S_DETECTOR
  if ($MetadataRefresh -and $prev) {
    if ($prev.PSObject.Properties['step'])   { $stepField   = [int]$prev.step }
    if ($prev.PSObject.Properties['total'])  { $totalField  = [int]$prev.total }
    if ($prev.PSObject.Properties['detail'] -and $null -ne $prev.detail) { $detailField = [string]$prev.detail }
    if ($prev.PSObject.Properties['source'] -and $prev.source) { $sourceField = [string]$prev.source }
  }
  $payload = [PSCustomObject]@{
    state          = $curState
    message        = $curMsg
    family         = $famField
    progress       = -1
    usage5h        = $usageField
    usage5hResetMs = $resetField
    todoProgress   = $todoPct
    todosCount     = $todoCnt
    step           = $stepField
    total          = $totalField
    detail         = $detailField
    source         = $sourceField
  }
  # `ts` and the monotonic `version` are stamped by the store, from the
  # same snapshot this payload was built from.
  Write-StatusSnapshot -Payload $payload -Previous $prev
}

# 5h 用量的取值与刷新都在 scripts/lib/Get-5hUsage.ps1 里（lib 不在时整条
# 链路关闭，detector 这边不碰 token、不联网）。
# 字段名契约：fixture 用 model_name / current_interval_remaining_percent /
# remains_time（与 lib 的实现一致）。如果实现字段回归，CI step 4 会因为
# Get-5hUsage 返 null 而 fail。

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

# status.json is read through the store lib now (Read-StatusSnapshot),
# which resolves the same path but shares the locking protocol with the
# writers. The local Read-StatusObj is gone: it read the file without
# the lock, which is what let a caller act on a snapshot that another
# process had already replaced.

# === 主循环 ===
if (-not $Once) {
  Set-Content -Path $pidFile -Value $PID -Encoding ASCII
  Log-Line "detector started (PID $PID) mcodeRoot=$mcodeRoot"
}

# 多 session 列表的恢复与补录。
#
# detector 经常重启（per-tick guard、autostart、崩溃）。如果列表只在内存里，
# 重启就把用户手上那些"待回复"清零了 —— 那个信号恰好是最不能丢的。
# 所以列表存在 sessions.json，启动时读回来。
#
# 补录是唯一一处还看时间的地方：把最近 30 分钟内还有动静的 session 收进来。
# 运行期完全靠状态机，不看时间。
try {
  Restore-SessionTracker
  Seed-SessionTracker
  Write-SessionsFile -Force
} catch {
  Log-Line "SESSIONS INIT FAIL: $($_.Exception.Message)"
}

try {
  while ($true) {
   # --- per-tick guard -------------------------------------------------------
   # This loop had no catch: any terminating error (malformed status.json, a
   # WMI/CIM hiccup, a locked file, a bad cast in the todo parser) escaped the
   # loop, fired the finally block, logged "detector stopped" and exited the
   # process. The widget kept running, so the pill just froze on the last
   # status.json with no visible cause -- status.json silently stopped
   # changing while widget.log kept logging TOPMOST re-raises. Log the real
   # message and retry on the next tick instead of dying.
   # Indentation is intentionally flat here so the diff stays reviewable.
   try {
    $now = Get-Date
    $inferred = $null
    $latestFile = $null

    # 0) 多 session 列表：状态机 + 写盘
    #
    # 放在最前面：它决定"哪些 session 有活动"。主线状态推断读的是"最近
    # 被改的那个日志"，两者不是一回事——后台会话在跑时，主线应该还是你
    # 前台那个会话的状态。
    try {
      Update-SessionTracker
      Write-SessionsFile
    } catch {
      Log-Line "SESSIONS UPDATE FAIL: $($_.Exception.Message)"
    }

    # 1) 最新 session log：5s 缓存（避免每秒 EnumerateFiles 几千个 .jsonl）
    #
    #    之前这里先查 mcode 进程（读的是 CLI 专属的活动会话目录），
    #    查不到就直接判 "mcode 已退出" 并且完全不读 session log。桌面端
    #    没有那个目录，于是状态检测在桌面端永远显示 error。
    #    现在直接以会话流为准；应用真的不在了，由下面"60s 无活动 → idle"
    #    的兜底逻辑收尾。
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

    # 3) 60s 无活动 → idle 兜底（每次循环都跑，不再被 mtime 缓存屏蔽）
    #    `waiting` 豁免：ask_user 弹出来之后，agent 就是在等用户，全程不会有
    #    新消息写入 session log。如果不豁免，60s 后它会被降级成"已静默 60s"
    #    灰点——而"该回来了"这个信号恰好在用户离开最久的时候最需要保留。
    if ($inferred -and $latestFile) {
      $curState = [string]$inferred.state
      $isSettled = ($curState -eq $S_IDLE) -or ($curState -eq $S_ERROR) -or ($curState -eq $S_WAITING)
      if (-not $isSettled) {
        $age = ($now - [System.IO.File]::GetLastWriteTime($latestFile)).TotalSeconds
        if ($age -gt 60) {
          $inferred = @{ state=$S_IDLE; message=($MSG_IDLE_FMT -f [int]$age) }
        }
      }
    }

    if ($inferred) {
      $newState  = [string]$inferred.state
      $newMsg    = [string]$inferred.message
      $logLine   = $null

      # The arbitration read and the write it authorises are ONE
      # critical section (round-21 review hetaoBackend #1). Reading the
      # current status outside the lock left a window in which a hook
      # push was judged against a stale snapshot and then overwritten by
      # the write that stale snapshot had authorised.
      $lock = Enter-StatusLock
      try {
        $cur = Read-StatusSnapshot
        $curSource = if ($cur) { [string]$cur.source } else { '' }
        $curState  = if ($cur) { [string]$cur.state  } else { '' }

        $isOwn = ($curSource -eq $S_DETECTOR)
        $stateChanged = ($curState -ne $newState)
        # waiting 加入 settle 集合：ask_user 触发时，pre-tool-use hook 会先推一条
        # `working`，detector 随后才从 session log 推出 `waiting`。如果 waiting
        # 不算 settle，detector 永远抢不回这条 status.json，pill 会一直卡在
        # "执行中"——正好毁掉这个状态存在的意义。
        $isSettleNew  = ($newState -eq $S_IDLE) -or ($newState -eq $S_ERROR) -or ($newState -eq $S_WAITING)

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
          Write-StatusUnderLock $newState $newMsg $inferred.family
          if ($script:lastDetectedState -ne $newState) {
            $script:lastDetectedState = $newState
            $logLine = "$newState :: $newMsg ($reason)"
          }
        }
      } finally {
        Exit-StatusLock $lock
      }
      # Appended outside the critical section: the log write must not
      # hold the lock that the other writer is waiting for.
      if ($logLine) { Log-Line $logLine }
    }

    # 4) 5h 用量：每 60s 刷一次，刷新后若数字变化就写 status.json（让 widget 看到）
    $prevPct  = $script:plan5hRemainingPct
    $prevMs   = $script:plan5hResetMs
    # 优先读运行时落盘的用量(零凭据:只读本地文件,自己不联网)
    Get-PlanUsage | Out-Null
    # 读不到才回落到自实现查询(需要凭据;上架包不发布那个模块,这一行会被剥掉)
    if (-not $script:plan5hFromRuntime -and $script:plan5hAvailable) { Refresh-5hUsage }
    $curPct   = $script:plan5hRemainingPct
    $curMs    = $script:plan5hResetMs
    $usageChanged = ($prevPct -ne $curPct) -or ($prevMs -ne $curMs) -and ($null -ne $curPct)
    if ($usageChanged) {
      # Metadata refresh: restate the current state and refresh the
      # numbers. The snapshot it restates is read INSIDE Write-Status,
      # under the same lock as the write, so a hook push landing here
      # is either fully seen or fully missed -- never half. The old code
      # read the file here, read it again inside Write-Status, and wrote
      # the result back over the whole file, so a hook write landing
      # between the two reads was clobbered with stale values
      # (round-21 review hetaoBackend #1).
      Write-Status -MetadataRefresh
      Log-Line ("5h usage refreshed: remaining=" + $curPct + "% resetMs=" + $curMs)
    }

    # 5) Todo 进度：每次都查（带 mtime 缓存），变化时写 status.json
    $prevTodoPct  = $script:plan5hLastWrittenTodoPct
    $curTodoData  = Get-TodoProgress
    $curTodoPct   = if ($null -ne $curTodoData) { $curTodoData.percent } else { $null }
    $todoChanged  = ($prevTodoPct -ne $curTodoPct)
    if ($todoChanged) {
      Write-Status -MetadataRefresh
      $script:plan5hLastWrittenTodoPct = $curTodoPct
      if ($null -ne $curTodoData) {
        Log-Line ("todo refreshed: " + $curTodoData.completed + "/" + $curTodoData.total + " = " + $curTodoPct + "%")
      } else {
        Log-Line "todo refreshed: (none)"
      }
    }

    if ($Once) { break }
    Start-Sleep -Milliseconds 1000
   } catch {
    # Log the exception type too: "loop error" alone would not tell us whether
    # this is a JSON parse, a WMI failure or an IO lock. Truncate so a runaway
    # error cannot flood island.log every tick.
    $msg = $_.Exception.GetType().Name + ': ' + $_.Exception.Message
    if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) + '...' }
    Log-Line ('loop error (retrying): ' + $msg)
    if ($Once) { break }
    Start-Sleep -Milliseconds 1000
   }
  }
} finally {
  if (-not $Once -and (Test-Path $pidFile)) {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }
  $STOPPED_MSG = 'detector stopped'
  Log-Line $STOPPED_MSG
}
