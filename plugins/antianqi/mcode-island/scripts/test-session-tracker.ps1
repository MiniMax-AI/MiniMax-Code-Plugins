# Behavioral tests for the multi-session tracker.
#
# Emits TAP-ish lines the node suite parses:
#   ok N - <name>
#   not ok N - <name>: <reason>
#
# The tracker lives in a lib that expects the detector's scope
# ($sessionsRoot, $configDir, the state constants, Get-LastJsonLine,
# Test-IsAskUser, the store lock). This harness assembles that scope
# against a FIXTURE session tree, so the assertions run against the real
# functions -- not a re-implementation of them.

$ErrorActionPreference = 'Stop'

# The plugin root comes from this script's own location, not from
# $env:USERPROFILE. CI checks the repo out to D:\a\<repo>\<repo>, so a
# path built from the user profile does not exist there -- the suite
# then dies before its first check and reports "0 passed", which reads
# like "nothing to test" rather than "the harness is broken".
$pluginRoot = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) ('sess-fixture-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$sessionsRoot = Join-Path $fixture 'sessions'
$configDir = Join-Path $fixture 'config'
$dayDir = Join-Path (Join-Path (Join-Path $sessionsRoot '2026') '10') '23'
New-Item -ItemType Directory -Path $dayDir -Force | Out-Null
New-Item -ItemType Directory -Path $configDir -Force | Out-Null

# The store lib resolves its lock file under %APPDATA%. Point it at the
# fixture: the test must not touch the real store, and the ubuntu CI job
# has no APPDATA at all (Join-Path $null throws there).
$env:APPDATA = Join-Path $fixture 'appdata'
New-Item -ItemType Directory -Path $env:APPDATA -Force | Out-Null

# --- the scope the lib expects -------------------------------------------
$S_USER = 'user'; $S_ASSISTANT = 'assistant'; $S_TOOLRESULT = 'toolResult'
$S_TOOLCALL = 'toolCall'; $FNAME_LEDGER = 'ledger.jsonl'; $FNAME_MESSAGES = 'messages.jsonl'
$S_THINKING = 'thinking'
function Log-Line($msg) { }
function Test-IsAskUser($name) { return ([string]$name) -eq 'AskUserQuestion' }

# The detector's tail reader and ask_user test, verbatim.
$detect = [System.IO.File]::ReadAllText((Join-Path $pluginRoot 'mcode-status-detect.ps1'))
function Extract-Function([string]$src, [string]$name) {
    $m = [regex]::Match($src, "(?ms)^function\s+$([regex]::Escape($name))\s*\(.*?^}")
    if (-not $m.Success) { throw "function $name not found" }
    return $m.Value
}
Invoke-Expression (Extract-Function $detect 'Get-LastJsonLine')
Invoke-Expression (Extract-Function $detect 'Get-ToolKey')
Invoke-Expression (Extract-Function $detect 'Test-IsAskUser')

# The store lib (the lock) and the tracker lib.
. (Join-Path (Join-Path $pluginRoot 'scripts') (Join-Path 'lib' 'Status-Store.ps1'))
. (Join-Path (Join-Path $pluginRoot 'scripts') (Join-Path 'lib' 'Session-Tracker.ps1'))

# --- assertions ----------------------------------------------------------
$script:pass = 0; $script:fail = 0; $script:n = 0
function Check([string]$name, [bool]$cond, [string]$why = '') {
    $script:n++
    if ($cond) { $script:pass++; Write-Output "ok $script:n - $name" }
    else { $script:fail++; Write-Output "not ok $script:n - ${name}: $why" }
}

# Make a session directory with the given message lines, and return its path.
function New-Session([string]$id, [string[]]$lines, [int]$ageMinutes = 0) {
    $b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($id)).TrimEnd('=')
    $dirName = ('01-00-00-000-session_' + $b64)
    $dir = Join-Path $dayDir $dirName
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $f = Join-Path $dir 'messages.jsonl'
    [System.IO.File]::WriteAllText($f, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    if ($ageMinutes -gt 0) {
        [System.IO.File]::SetLastWriteTime($f, (Get-Date).AddMinutes(-1 * $ageMinutes))
    }
    return $f
}
function Line-User([string]$text, [string]$extra = '') {
    $t = $text -replace '\\', '\\'
    $t = $t -replace "`r`n", '\n'
    $t = $t -replace "`n", '\n'
    $t = $t -replace '"', '\"'
    return '{"message":{"role":"user","content":[{"type":"text","text":"' + $t + '"}],"timestamp":1}}'
}
function Line-Assistant([string]$text) {
    $t = $text -replace "`r`n", '\n'
    $t = $t -replace "`n", '\n'
    $t = $t -replace '"', '\"'
    return '{"message":{"role":"assistant","content":[{"type":"text","text":"' + $t + '"}],"timestamp":2}}'
}
function Line-ToolCall([string]$tool) {
    return '{"message":{"role":"assistant","content":[{"type":"toolCall","name":"' + $tool + '","arguments":{}}],"timestamp":3}}'
}
function Line-ToolResult {
    return '{"message":{"role":"toolResult","content":[{"type":"text","text":"ok"}],"timestamp":4}}'
}

# --- 1. 状态机 -----------------------------------------------------------
$fTool = New-Session 'sess-running' @((Line-ToolCall 'Bash'))
$fDone = New-Session 'sess-waiting' @((Line-Assistant '我先去做点别的'))
$fAsk = New-Session 'sess-asking' @((Line-ToolCall 'ask_user'))
$fUser = New-Session 'sess-userjust' @((Line-User '帮我看下这个'))

Check 'toolCall 结尾 = 运行中' ((Get-SessionPhase (Get-LastJsonLine $fTool)) -eq 'running') (Get-SessionPhase (Get-LastJsonLine $fTool))
Check 'assistant 文本结尾 = 待回复' ((Get-SessionPhase (Get-LastJsonLine $fDone)) -eq 'waiting') (Get-SessionPhase (Get-LastJsonLine $fDone))
Check 'ask_user 结尾 = 待回复' ((Get-SessionPhase (Get-LastJsonLine $fAsk)) -eq 'waiting') (Get-SessionPhase (Get-LastJsonLine $fAsk))
Check 'user 刚说完 = 运行中' ((Get-SessionPhase (Get-LastJsonLine $fUser)) -eq 'running') (Get-SessionPhase (Get-LastJsonLine $fUser))

# --- 2. 标题提取 ---------------------------------------------------------
$reminder = "<system-reminder>`n<agent-context>xxx</agent-context>`n</system-reminder>`n帮我把 PR 看一下"
$fTitle = New-Session 'sess-title' @((Line-User $reminder))
Check '标题剥掉 system-reminder 后是用户提问' ((Get-SessionTitle $fTitle) -eq '帮我把 PR 看一下') ("得到: " + (Get-SessionTitle $fTitle))

$fCompact = New-Session 'sess-compact' @('{"message":{"role":"compactionSummary","content":[]}}', (Line-Assistant '我来实现选项 ②'))
Check '被压缩的会话退回 assistant 首句' ((Get-SessionTitle $fCompact) -like '我来实现选项*') ("得到: " + (Get-SessionTitle $fCompact))

# --- 3. 入列规则:旧的 session 不进列表 -----------------------------------
$oldDir = New-Session 'sess-old' @((Line-ToolCall 'Bash')) 60   # 60 分钟前
[System.IO.File]::SetLastWriteTime($oldDir, (Get-Date).AddMinutes(-60))
$script:trackedSessions = [ordered]@{}
$script:dismissedSessions = @{}
$script:sessionTitleCache = @{}
Update-SessionTracker
Check '很久没动的 session 不进列表' (-not $script:trackedSessions.Contains('sess-old')) ("列表里有: " + (($script:trackedSessions.Keys) -join ','))

# 新的 session 要进列表
$fNew = New-Session 'sess-new' @((Line-ToolCall 'Bash'))
Update-SessionTracker
Check '刚动过的 session 进列表' ($script:trackedSessions.Contains('sess-new')) ("列表: " + (($script:trackedSessions.Keys) -join ','))

# --- 4. 状态从运行中变成待回复 -------------------------------------------
$fNew2 = New-Session 'sess-flip' @((Line-ToolCall 'Bash'))
Update-SessionTracker
$before = $script:trackedSessions['sess-flip'].Phase
[System.IO.File]::WriteAllText($fNew2, ((Line-Assistant '做完了') + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Update-SessionTracker
$after = $script:trackedSessions['sess-flip'].Phase
Check '运行中 -> 待回复 的状态转换' (($before -eq 'running') -and ($after -eq 'waiting')) ("$before -> $after")

# --- 5. 消除:ack.signal ----------------------------------------------------
[System.IO.File]::WriteAllText((Join-Path $configDir 'ack.signal'), 'sess-flip', (New-Object System.Text.UTF8Encoding($false)))
Update-SessionTracker
Check 'ack.signal 里的 session 被消掉' (-not $script:trackedSessions.Contains('sess-flip')) ("列表: " + (($script:trackedSessions.Keys) -join ','))
Check '消除被记进 dismissed' ($script:dismissedSessions.Contains('sess-flip')) ($script:dismissedSessions | ConvertTo-Json -Compress)
Check 'ack.signal 本身被消费掉' (-not (Test-Path (Join-Path $configDir 'ack.signal'))) '文件还在'

# --- 6. 持久化 -------------------------------------------------------------
Write-SessionsFile -Force
$saved = Get-Content (Join-Path $configDir 'sessions.json') -Raw | ConvertFrom-Json
Check 'sessions.json 写出了列表' (@($saved.sessions).Count -gt 0) ("数量: " + @($saved.sessions).Count)
Check 'sessions.json 记下了 dismissed' ($null -ne $saved.dismissed.'sess-flip') ($saved.dismissed | ConvertTo-Json -Compress)

# 重启模拟：清空内存，从文件恢复
$script:trackedSessions = [ordered]@{}
$script:dismissedSessions = @{}
Restore-SessionTracker
Check '重启后列表从 sessions.json 恢复' ($script:trackedSessions.Contains('sess-new')) ("恢复后: " + (($script:trackedSessions.Keys) -join ','))
Check '重启后 dismissed 也恢复' ($script:dismissedSessions.Contains('sess-flip')) ($script:dismissedSessions | ConvertTo-Json -Compress)

# --- 7. cycle:被消掉的 session 跑完一轮又回来 -------------------------------
$fCycle = New-Session 'sess-cycle' @((Line-ToolCall 'Bash'))
Update-SessionTracker
Check '新 cycle 的 session 进列表' ($script:trackedSessions.Contains('sess-cycle')) '没进来'
[System.IO.File]::WriteAllText((Join-Path $configDir 'ack.signal'), 'sess-cycle', (New-Object System.Text.UTF8Encoding($false)))
Update-SessionTracker
Check '被消掉后不在列表里' (-not $script:trackedSessions.Contains('sess-cycle')) '还在'
# agent 说完了 -> waiting
[System.IO.File]::WriteAllText($fCycle, ((Line-Assistant '好了') + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Update-SessionTracker
# agent 又开始 -> running，cycle +1，dismissed 失效
[System.IO.File]::WriteAllText($fCycle, ((Line-ToolCall 'Bash') + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Update-SessionTracker
Check '新一轮开始后 session 重新进列表' ($script:trackedSessions.Contains('sess-cycle')) '没回来'
Check '新一轮清掉了 dismissed 记录' (-not $script:dismissedSessions.Contains('sess-cycle')) ($script:dismissedSessions | ConvertTo-Json -Compress)

Write-Output "1..$script:n"
Write-Output "# pass $script:n  fail $script:fail"
if ($script:fail -gt 0) { exit 1 }
exit 0
