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
# The tracker reads content blocks by type now, exactly like the
# detector's Infer-State does. Without these two the text/thinking blocks
# are never recognised -- and the state comes out wrong.
$S_TEXT = 'text'; $S_THINK_BLK = 'thinking'
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

# 脱敏的替身：真实的 Protect-SecretText 在 scripts/lib/Protect-Text.ps1 里，
# 由 detector 在 dot-source tracker 之前加载。测试里先装一个只认一种形状
# 的假货，好断言"标题和预览都过了脱敏"。
function Protect-SecretText {
  param([string]$Text)
  if (-not $Text) { return $Text }
  return ($Text -replace 'sk-[A-Za-z0-9]{6,}', 'sk-***')
}

# 读日志的计数器：审核第 1 条要断言"过期的会话的日志一次都没被读"。
# tracker 调 Get-LastJsonLine 是运行期解析，所以这里重新定义一遍就会生效。
$script:readFiles = New-Object System.Collections.Generic.List[string]
$script:realGetLastJsonLine = ${function:Get-LastJsonLine}
function Get-LastJsonLine($file) {
  $script:readFiles.Add([string]$file)
  return (& $script:realGetLastJsonLine $file)
}

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
# ledger 事件格式：{kind, phase, action, ...}
#
# 真实环境里大多数 session 没有 ledger.jsonl（417 个里只有 1 个），但
# detector 的 Infer-State 有这个分支，列表也得跟着有 —— 不然同一个会话
# 在两边的状态会不一样。
function Line-LedgerToolResult {
    return '{"kind":"toolResult","toolName":"bash","ts":1234}'
}
function Line-LedgerToolCall {
    return '{"kind":"toolCall","toolName":"bash","action":"doing it","ts":1234}'
}
# A tool that failed. The detector reports these as `error`, so the list
# has to be able to say it too.
function Line-ToolResultFailed {
    return '{"message":{"role":"toolResult","isError":true,"content":[{"type":"text","text":"boom"}],"timestamp":4}}'
}
# An assistant message with only a thinking block: it is thinking, not
# done and not working.
function Line-ThinkingOnly {
    return '{"message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}],"timestamp":4}}'
}
# 系统注入的消息：后台任务完成通知、系统提醒这些，是以 user 角色塞进
# 会话日志的，但它们不是"有人在说话"。
function Line-SystemNoise {
    return '{"message":{"role":"user","content":[{"type":"text","text":"<background-task-finished> noise from the system"}],"timestamp":4}}'
}
function Line-ToolResult {
    return '{"message":{"role":"toolResult","content":[{"type":"text","text":"ok"}],"timestamp":4}}'
}
# A toolResult that names its tool. The real log puts the tool name on
# message.toolName, not in the content array -- and a toolResult is what
# the last line usually is once a tool has run.
function Line-ToolResultNamed([string]$tool) {
    return '{"message":{"role":"toolResult","toolName":"' + $tool + '","content":[{"type":"text","text":"ok"}],"timestamp":4}}'
}

# --- 1. 状态机 -----------------------------------------------------------
$fTool = New-Session 'sess-running' @((Line-ToolCall 'Bash'))
$fDone = New-Session 'sess-waiting' @((Line-Assistant '我先去做点别的'))
$fAsk = New-Session 'sess-asking' @((Line-ToolCall 'ask_user'))
$fUser = New-Session 'sess-userjust' @((Line-User '帮我看下这个'))

# 这些状态词表和 pill（detector 的 Infer-State）是同一套：同一个会话在
# 两个地方不能一个说"等用户"、一个说"运行中"。
#
#   toolCall 结尾        -> working  （在跑）
#   assistant 纯文本结尾 -> idle     （说完了，等你）
#   ask_user 结尾        -> waiting  （在等审批）
#   user 刚说完          -> idle     （球在你那边，agent 马上要动）
#   toolResult 成功      -> done     （工具跑完了）
#   toolResult 失败      -> error
#   assistant 只有 thinking -> thinking（在想）
Check 'toolCall 结尾 = 运行中' ((Get-SessionState (Get-LastJsonLine $fTool)) -eq 'working') (Get-SessionState (Get-LastJsonLine $fTool))
Check 'assistant 文本结尾 = 待回复' ((Get-SessionState (Get-LastJsonLine $fDone)) -eq 'idle') (Get-SessionState (Get-LastJsonLine $fDone))
Check 'ask_user 结尾 = 等待审批' ((Get-SessionState (Get-LastJsonLine $fAsk)) -eq 'waiting') (Get-SessionState (Get-LastJsonLine $fAsk))
Check 'user 刚说完 = 待回复' ((Get-SessionState (Get-LastJsonLine $fUser)) -eq 'idle') (Get-SessionState (Get-LastJsonLine $fUser))

# 工具跑完 / 炸了 / 只想不动手。
#
# 工具跑完（成不成都一样）仍然是"运行中"：agent 还在这一轮里，只是刚跑完
# 一个工具。pill 会闪一下"已完成 + Read"，那是瞬时反馈；列表说的是会话
# 级的状态，说"已完成"会被读成"这个会话做完了"。
$fRes = New-Session 'sess-toolresult' @((Line-ToolResult))
$fResErr = New-Session 'sess-toolerror' @((Line-ToolResultFailed))
$fThink = New-Session 'sess-thinking' @((Line-ThinkingOnly))
Check 'toolResult 结尾 = 运行中(这一轮还没完)' ((Get-SessionState (Get-LastJsonLine $fRes)) -eq 'working') (Get-SessionState (Get-LastJsonLine $fRes))
Check '工具失败也是运行中(agent 会接着处理)' ((Get-SessionState (Get-LastJsonLine $fResErr)) -eq 'working') (Get-SessionState (Get-LastJsonLine $fResErr))

# ledger 事件格式走的是另一个分支，规则一样：工具跑完了，这一轮还没完。
$fLedgerRes = New-Session 'sess-ledger-result' @((Line-LedgerToolResult))
$fLedgerCall = New-Session 'sess-ledger-call' @((Line-LedgerToolCall))
Check 'ledger 的 toolResult 也是运行中' ((Get-SessionState (Get-LastJsonLine $fLedgerRes)) -eq 'working') (Get-SessionState (Get-LastJsonLine $fLedgerRes))
Check 'ledger 的 toolCall 是运行中' ((Get-SessionState (Get-LastJsonLine $fLedgerCall)) -eq 'working') (Get-SessionState (Get-LastJsonLine $fLedgerCall))
Check 'assistant 只想不动手 = 思考中' ((Get-SessionState (Get-LastJsonLine $fThink)) -eq 'thinking') (Get-SessionState (Get-LastJsonLine $fThink))

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
Check '运行中 -> 待回复 的状态转换' (($before -eq 'working') -and ($after -eq 'idle')) ("$before -> $after")

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

# --- 8. 摘要与时间戳:列表的第二行和右侧那一列 ---------------------------
#
# 布局参考小红书的展开态之后，列表的一行有两行字和一个时间戳：
# 第一行是首条提问，第二行是"最后说了什么"，右边是最后活动时间。
#
# 这三条断言盯的就是那条数据链：
#   preview   = 最后一条消息的正文（agent 或用户说的）
#   lastTool  = 最后一条消息恰好是 toolCall 时的工具名
#   lastAtMs  = 最后一次活动时间（日志 mtime）
#
# 少任何一条，第二行就会空着，或者时间戳变成"进列表的时间"（那是很久
# 以前，排序和显示都不对）。

$fPrev = New-Session 'sess-preview' @((Line-Assistant '我改完了，你看一下'))
Update-SessionTracker
$ePrev = $script:trackedSessions['sess-preview']
Check 'assistant 的正文进 preview' ($ePrev.Preview -eq '我改完了，你看一下') ("得到: '" + $ePrev.Preview + "'")
Check '最后活动时间有值' ($ePrev.LastAtMs -gt 0) ("得到: " + $ePrev.LastAtMs)
Check '最后活动时间接近现在' ([math]::Abs(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$ePrev.LastAtMs)) -lt 60000) ("得到: " + $ePrev.LastAtMs)

# toolCall 结尾：没有正文，preview 空，但工具名要留着给 widget 兜底。
$fToolPrev = New-Session 'sess-toolpreview' @((Line-ToolCall 'Bash'))
Update-SessionTracker
$eToolPrev = $script:trackedSessions['sess-toolpreview']
Check 'toolCall 结尾时 preview 为空' ([string]::IsNullOrEmpty($eToolPrev.Preview)) ("得到: '" + $eToolPrev.Preview + "'")
Check 'toolCall 结尾时工具名被记下来' ($eToolPrev.LastTool -eq 'Bash') ("得到: '" + $eToolPrev.LastTool + "'")

# toolResult 结尾：正文是工具输出（代码、日志），不当摘要。
$fResPrev = New-Session 'sess-resultpreview' @((Line-ToolResult))
Update-SessionTracker
$eResPrev = $script:trackedSessions['sess-resultpreview']
Check 'toolResult 的正文不进 preview' ([string]::IsNullOrEmpty($eResPrev.Preview)) ("得到: '" + $eResPrev.Preview + "'")

# toolResult 带 toolName：工具名在 message.toolName 上，不在 content 里。
# agent 跑完工具后最后一条往往就是 toolResult，这时 preview 是空的，
# 工具名是唯一能让第二行不空的东西。
$fResNamed = New-Session 'sess-resultnamed' @((Line-ToolResultNamed 'Bash'))
Update-SessionTracker
$eResNamed = $script:trackedSessions['sess-resultnamed']
Check 'toolResult 的工具名被记下来' ($eResNamed.LastTool -eq 'Bash') ("得到: '" + $eResNamed.LastTool + "'")
Check 'toolResult 的正文仍然不进 preview' ([string]::IsNullOrEmpty($eResNamed.Preview)) ("得到: '" + $eResNamed.Preview + "'")

# 换了最后一条消息，preview 必须跟着换（不是只在新 session 时取一次）。
[System.IO.File]::WriteAllText($fPrev, ((Line-Assistant '改完了' ) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Update-SessionTracker
Check '最后一条消息变了 preview 跟着变' ($script:trackedSessions['sess-preview'].Preview -eq '改完了') ("得到: '" + $script:trackedSessions['sess-preview'].Preview + "'")

# 落盘：三个字段都得在文件里，widget 只读这个文件。
Write-SessionsFile -Force
$saved2 = Get-Content (Join-Path $configDir 'sessions.json') -Raw | ConvertFrom-Json
$row2 = @($saved2.sessions | Where-Object { $_.id -eq 'sess-preview' })[0]
Check 'sessions.json 里有一行' ($null -ne $row2) '没有 sess-preview 这一行'
Check 'sessions.json 带 preview' ($null -ne $row2 -and $row2.preview -eq '改完了') ("得到: '" + $row2.preview + "'")
Check 'sessions.json 带 lastTool' ($null -ne $row2 -and $null -ne $row2.lastTool) ("得到: '" + $row2.lastTool + "'")
Check 'sessions.json 带 lastAtMs' ($null -ne $row2 -and [int64]$row2.lastAtMs -gt 0) ("得到: " + $row2.lastAtMs)

# 重启恢复：detector 重启到下一次刷新之间，widget 读的就是这个文件，
# 第二行不能白屏。
$script:trackedSessions = [ordered]@{}
Restore-SessionTracker
$eRestored = $script:trackedSessions['sess-preview']
Check '重启后 preview 恢复了' ($eRestored.Preview -eq '改完了') ("得到: '" + $eRestored.Preview + "'")
Check '重启后 lastAtMs 恢复了' ([int64]$eRestored.LastAtMs -gt 0) ("得到: " + $eRestored.LastAtMs)

# 系统注入的消息不能当摘要。
#
# 系统把后台任务完成通知这些以 user 角色塞进日志。它们不是人话，拿来当
# 摘要，列表第二行就会显示 "<background-task-finished> Local backend..."。
$fNoise = New-Session 'sess-noise' @((Line-SystemNoise))
$noiseMsg = Get-LastJsonLine $fNoise
Check '系统注入的消息不进 preview' ([string]::IsNullOrEmpty((Get-SessionPreview $noiseMsg))) ("得到: '" + (Get-SessionPreview $noiseMsg) + "'")
Check '标题也不取系统注入的那条' (-not ((Get-SessionTitle $fNoise) -match 'background-task')) ("得到: '" + (Get-SessionTitle $fNoise) + "'")

# 审核要求：上架版不能借用 MiniMax Code 自己的程序（设一个环境变量让它以
# node 模式启动）当 node 用，也不能读它自己的 SQLite。所以那条链路整个不存在
# 了 —— 标题只有首条用户提问这一个来源。
$trackerSrc = [System.IO.File]::ReadAllText((Join-Path (Join-Path $PSScriptRoot 'lib') 'Session-Tracker.ps1'))
Check 'tracker 不使用那个 node 环境变量' (-not ($trackerSrc -match '\$env:ELECTRON_RUN_AS_NODE')) '源码里又用了它'
Check 'tracker 不读运行时的 sqlite' (-not ($trackerSrc -match '(?i)runtime-state\.sqlite|runtime_titles|Runtime-Titles')) '源码里又出现了运行时的 sqlite'
Check 'Runtime-Titles.ps1 已经不在仓库里' (-not (Test-Path (Join-Path (Join-Path $PSScriptRoot 'lib') 'Runtime-Titles.ps1'))) 'Runtime-Titles.ps1 还在'

# 标题历史。
#
# 终端 tab 上的名字是 mcode 在**某个时刻**设的，而会话标题会随着对话
# 推进变。widget 靠这些名字认出"哪个 tab 是这个会话"，所以历史里必须有
# 它：至少要有首条用户消息那一个。
$fHist = New-Session 'sess-hist' @((Line-User '首条提问是另外一句话'))
Update-SessionTracker
Write-SessionsFile -Force
$histJson = Get-Content (Join-Path $configDir 'sessions.json') -Raw | ConvertFrom-Json
$histRow = @($histJson.sessions | Where-Object { $_.id -eq 'sess-hist' })[0]
Check 'sessions.json 记下了标题历史' (@($histRow.titles).Count -ge 1) ("得到: " + (@($histRow.titles) -join ' | '))
Check '标题历史里有首条用户消息' (@($histRow.titles) -contains '首条提问是另外一句话') ("得到: " + (@($histRow.titles) -join ' | '))

# Phase 没变但内容变了，也要落盘。
#
# agent 连着跑两个工具时 Phase 一直是 running，摘要和最后活动时间却在变。
# 只看 Phase 变没变来决定写不写盘，磁盘上的 sessions.json 就会一直停在
# 旧值：列表第二行空着、右侧的时间戳不动。内存里是对的，落到文件上丢了。
$fSame = New-Session 'sess-samephase' @((Line-ToolCall 'Bash'))
Update-SessionTracker
Write-SessionsFile -Force
$beforeSame = Get-Content (Join-Path $configDir 'sessions.json') -Raw | ConvertFrom-Json
$rowBefore = @($beforeSame.sessions | Where-Object { $_.id -eq 'sess-samephase' })[0]
Check '同 Phase 的 session 带上了工具名' ($rowBefore.lastTool -eq 'Bash') ("得到: '" + $rowBefore.lastTool + "'")

# 换一个工具名。Phase 仍然是 running（toolCall -> toolCall）。
[System.IO.File]::WriteAllText($fSame, ((Line-ToolCall 'Read') + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Update-SessionTracker
Write-SessionsFile   # 故意不加 -Force: 该由 dirty 标志决定写不写
$afterSame = Get-Content (Join-Path $configDir 'sessions.json') -Raw | ConvertFrom-Json
$rowAfter = @($afterSame.sessions | Where-Object { $_.id -eq 'sess-samephase' })[0]
Check 'Phase 没变但工具名变了也要落盘' ($rowAfter.lastTool -eq 'Read') ("得到: '" + $rowAfter.lastTool + "'")

# --- 9. 会话标题：只有首条用户提问一个来源 ---------------------------------
#
# 审核要求：上架版不能借用 MiniMax Code 自己的程序（ELECTRON_RUN_AS_NODE=1）
# 当 node 用，也不能读它自己的 SQLite。所以标题只有首条提问这一个来源。
$fTitled = New-Session 'sess-titled' @((Line-User '首条提问是另外一句话'))
Check '显示用首条提问' ((Get-SessionDisplayTitle $fTitled) -eq '首条提问是另外一句话') ("得到: '" + (Get-SessionDisplayTitle $fTitled) + "'")

# --- 10. 标题和预览：先截断、先脱敏，再写盘和显示 --------------------------
#
# 审核第 4 条。标题和预览都是"会话里说过的话"，里面可能有 token。写进
# sessions.json 的是它们，画在屏幕上的也是它们。
$fSecret = New-Session 'sess-secret' @((Line-User '我的 key 是 sk-abcdef123456 谢谢'))
$secretTitle = (Get-SessionTitle $fSecret)
Check '标题里的密钥被脱敏' ($secretTitle -notmatch 'sk-abcdef123456') ("得到: '" + $secretTitle + "'")
Check '标题仍然可读' ($secretTitle -match '我的 key') ("得到: '" + $secretTitle + "'")

$longLine = 'x' * 400
$fLong = New-Session 'sess-long' @((Line-User $longLine))
Check '标题被截断到 40 字以内' ((Get-SessionTitle $fLong).Length -le 41) ("得到 " + (Get-SessionTitle $fLong).Length + " 字")

$previewMsg = Get-LastJsonLine (New-Session 'sess-prev' @((Line-User ('预览里也有 sk-abcdef123456 和 ' + ('y' * 300)))))
$preview = (Get-SessionPreview $previewMsg)
Check '预览里的密钥被脱敏' ($preview -notmatch 'sk-abcdef123456') ("得到: '" + $preview + "'")
Check '预览被截断' ($preview.Length -le 121) ("得到 " + $preview.Length + " 字")

# 写盘的那一份也必须已经是脱敏 + 截断过的
$fDisk = New-Session 'sess-disk' @((Line-User '写盘测试 sk-abcdef123456'))
Update-SessionTracker
Write-SessionsFile -Force
$diskJson = Get-Content (Join-Path $configDir 'sessions.json') -Raw | ConvertFrom-Json
$diskRow = @($diskJson.sessions | Where-Object { $_.id -eq 'sess-disk' })[0]
if ($diskRow) {
  Check 'sessions.json 里的标题是脱敏过的' ([string]$diskRow.title -notmatch 'sk-abcdef123456') ("得到: '" + $diskRow.title + "'")
  Check 'sessions.json 里的预览也是脱敏过的' ([string]$diskRow.preview -notmatch 'sk-abcdef123456') ("得到: '" + $diskRow.preview + "'")
} else {
  Check 'sessions.json 里有这一条' $false '磁盘上找不到 sess-disk'
}

# --- 11. 过期会话的日志一次都不该被读 --------------------------------------
#
# 审核第 1 条。之前是先读日志再判过期：本机 400 多个历史会话的日志每秒
# 被读一遍，读完再丢掉。
$script:readFiles.Clear()
$fOld = New-Session 'sess-ancient' @((Line-User '很久以前的会话')) 30
Update-SessionTracker
$oldLog = Join-Path (Split-Path -Parent $fOld) 'messages.jsonl'
Check '过期会话的日志没有被读' (-not ($script:readFiles -contains $oldLog)) ("读了: " + ($script:readFiles -join ', '))
Check '过期会话也不进列表' (-not $script:trackedSessions.Contains('sess-ancient')) '过期会话进了列表'

# --- 12. 列表要能清理 ---------------------------------------------------
#
# 审核第 5 条。列表是"现在还活着的会话"，不是历史记录：太久没动的会话
# 要从列表和 sessions.json 里一起消失。
$fPrune = New-Session 'sess-prune' @((Line-User '待清理的会话'))
Update-SessionTracker
Check '刚动过的会话在列表里' ($script:trackedSessions.Contains('sess-prune')) '刚动过的会话不在列表里'
# 把它的日志改成很久以前：下次更新就该被清掉
$pruneLog = Join-Path (Split-Path -Parent $fPrune) 'messages.jsonl'
[System.IO.File]::SetLastWriteTime($pruneLog, (Get-Date).AddHours(-2))
Update-SessionTracker
Check '很久没动的会话被清出列表' (-not $script:trackedSessions.Contains('sess-prune')) '过期会话还在列表里'
Write-SessionsFile -Force
$pruneJson = Get-Content (Join-Path $configDir 'sessions.json') -Raw | ConvertFrom-Json
Check '被清掉的会话也不在 sessions.json 里' (-not (@($pruneJson.sessions | Where-Object { $_.id -eq 'sess-prune' }).Count)) 'sessions.json 里还有它'
# --- 10. 停了的会话不该一直显示"运行中" -----------------------------------
#
# agent 跑完一个工具之后，它的最后一条消息永远是 toolCall 或 toolResult
# —— 消息类型说它"在跑"。而日志不再变之后，更新循环第一行就跳过了，
# 状态冻结在最后一个值：一个停了快一小时的会话会一直显示"运行中"。
#
# 所以"在跑"必须有一份活性支撑：超过窗口没动，就不是"在跑"，是"停了"。
$fStale = New-Session 'sess-stale' @((Line-ToolCall 'Bash'))
Update-SessionTracker
Check '刚动过的 toolCall 会话是运行中' ($script:trackedSessions['sess-stale'].Phase -eq 'working') ("得到: " + $script:trackedSessions['sess-stale'].Phase)

# 停 10 分钟：文件 mtime 变了，先重读一次（消息没变，状态也没变）
[System.IO.File]::SetLastWriteTimeUtc($fStale, [DateTime]::UtcNow.AddMinutes(-10))
Update-SessionTracker
# 第二轮：mtime 不会再变了，这一轮走的是"没变就跳过"那条路
Update-SessionTracker
Check '停了 10 分钟的会话不再显示运行中' ($script:trackedSessions['sess-stale'].Phase -ne 'working') ("得到: " + $script:trackedSessions['sess-stale'].Phase)
Check '停了以后标成已停止' ($script:trackedSessions['sess-stale'].Phase -eq 'stopped') ("得到: " + $script:trackedSessions['sess-stale'].Phase)

# "待回复"不看活性：球在用户那边，用户半小时不回也是待回复。
$fWaitStale = New-Session 'sess-waitstale' @((Line-Assistant '说完了，等你'))
Update-SessionTracker
[System.IO.File]::SetLastWriteTimeUtc($fWaitStale, [DateTime]::UtcNow.AddMinutes(-10))
Update-SessionTracker
Update-SessionTracker
Check '停了 10 分钟的待回复会话仍然是待回复' ($script:trackedSessions['sess-waitstale'].Phase -eq 'idle') ("得到: " + $script:trackedSessions['sess-waitstale'].Phase)

# thinking 也是"在跑"：agent 正在想。停住了一样要降级成"已停止"。
#
# 这条盯的是 ACTIVE_STATES 是不是完整 —— 只写 working 的话，一个卡在
# 思考里的会话会永远显示"思考中"，和当初那个"停了还显示运行中"是同
# 一类毛病。
$fThinkStale = New-Session 'sess-thinkstale' @((Line-ThinkingOnly))
Update-SessionTracker
Check '刚动过的 thinking 会话是思考中' ($script:trackedSessions['sess-thinkstale'].Phase -eq 'thinking') ("得到: " + $script:trackedSessions['sess-thinkstale'].Phase)
[System.IO.File]::SetLastWriteTimeUtc($fThinkStale, [DateTime]::UtcNow.AddMinutes(-10))
Update-SessionTracker
Update-SessionTracker
Check '停了 10 分钟的思考中会话降级成已停止' ($script:trackedSessions['sess-thinkstale'].Phase -eq 'stopped') ("得到: " + $script:trackedSessions['sess-thinkstale'].Phase)

# "已停止"和"待回复"一样，是一轮的终点。之后又变成"运行中"，说明
# 新一轮开始了 —— 被点掉的约束失效，cycle +1。
$fStopCycle = New-Session 'sess-stopcycle' @((Line-ToolCall 'Bash'))
Update-SessionTracker
[System.IO.File]::SetLastWriteTimeUtc($fStopCycle, [DateTime]::UtcNow.AddMinutes(-10))
Update-SessionTracker
Update-SessionTracker
Check '停了以后是已停止' ($script:trackedSessions['sess-stopcycle'].Phase -eq 'stopped') ("得到: " + $script:trackedSessions['sess-stopcycle'].Phase)
$cycleBefore = $script:trackedSessions['sess-stopcycle'].Cycle
[System.IO.File]::WriteAllText($fStopCycle, ((Line-ToolCall 'Bash') + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Update-SessionTracker
Check '停了以后又跑起来算新一轮' ($script:trackedSessions['sess-stopcycle'].Cycle -eq ($cycleBefore + 1)) ("得到: " + $script:trackedSessions['sess-stopcycle'].Cycle + ", 之前 " + $cycleBefore)

Write-Output "1..$script:n"
Write-Output "# pass $script:n  fail $script:fail"
if ($script:fail -gt 0) { exit 1 }
exit 0
