# ---------------------------------------------------------------------------
# 多 session 跟踪（v0.5.0）
#
# 灵动岛以前只显示一个 session：Get-LatestSessionFile 扫全部 *.jsonl 取最近被
# 改的那一个。所以 pill 今天的语义是"谁最后动了日志就显示谁"，不是"你关心的
# 那个会话"——后台会话跑一下就能把前台的 pill 抢走。
#
# 这里维护一份有生命周期的 session 列表：
#
#   检测到活动   -> 运行中
#   agent 停了   -> 待回复（最后一条不是 toolCall / toolResult / thinking）
#   用户点掉     -> 从列表里消除
#
# 判定"它停了"用的是最后一条消息的类型，不是时间超时：agent 跑一个 40 秒的
# 工具时日志可能 40 秒没写，但它没停；用超时判定会把"正在跑长工具"误判成
# "待回复"，而且窗口多长都不对。
#
# 列表写在 sessions.json，不是 status.json：status.json 是 agent 侧
# （notify-island.ps1）和 detector 两侧都在写的文件，agent 侧是整份覆盖，
# 把列表塞进去会被下一次工具调用整份抹掉。sessions.json 只有 detector 写。
# ---------------------------------------------------------------------------

# 被跟踪的 session：id -> 条目
$script:trackedSessions = [ordered]@{}
# 标题缓存：日志路径 -> 标题（首条提问只读一次）
$script:sessionTitleCache = @{}
# 被用户点掉的：id -> 被点掉时的 cycle
$script:dismissedSessions = @{}
# 有没有变过。没变就不写盘——sessions.json 和 status.json 用同一把锁，
# 每秒无脑写一次会把 hook 的状态推送堵在门外。
$script:sessionsDirty = $false
# 目录枚举缓存
$script:lastGroupsScan = [DateTime]::MinValue
$script:lastGroups = @{}

# 启动补录窗口：detector 重启时，把这段时间内还有动静的 session 收进来。
# 运行期间完全靠状态机，不看时间。
$script:SEED_WINDOW_MS = 30 * 60 * 1000

# 活动窗口：日志刚被写过，session 才算"有活动"。
#
# 这个窗口只决定"能不能进列表"，不决定进列表之后显示什么：
# 进列表之后状态只看最后一条消息。为什么分开：
#
#   - "有活动"必须看 mtime。一个几周前卡在 toolCall 上的老对话，最后
#     一条仍然是 toolCall，消息类型说它"在跑"，它其实早就不动了。只看
#     消息类型会把全部历史会话一次性收进列表（实测 80+ 条）。
#   - "在跑还是在等你"必须看消息。agent 跑一个 40 秒的工具时日志可能
#     40 秒没写，但它没停；用 mtime 判定状态会把"正在跑长工具"误判成
#     "待回复"，而且窗口多长都不对。
#
# 60 秒足够覆盖 detector 的一次卡顿（它每秒轮询一次）。
$script:ACTIVE_WINDOW_MS = 60 * 1000

function Get-SessionIdFromDir($dir) {
  $name = [System.IO.Path]::GetFileName($dir)
  $i = $name.IndexOf('session_')
  if ($i -lt 0) { return $name }
  $b64 = $name.Substring($i + 8)
  try {
    $pad = (4 - ($b64.Length % 4)) % 4
    return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64 + ('=' * $pad)))
  } catch {
    return $name
  }
}

# 一次目录枚举，按 session 分组。
#
# 目录形态：<sessionsRoot>/<Y>/<M>/<D>/<HH-mm-ss-fff>-session_<base64(id)>/
# 每个目录里可能有 ledger.jsonl（首选）和 messages.jsonl（fallback）。
#
# 同一个 session 里两个文件都存在时，取最近被改的那个——和
# Get-LatestSessionFile 的理由一致：一个陈旧的 ledger 会盖掉活的
# messages，导致 60s 空闲兜底打在很久以前的时间戳上。
function Get-SessionLogGroups($root) {
  $groups = @{}
  if (-not $root -or !(Test-Path -LiteralPath $root)) { return $groups }
  foreach ($dir in [System.IO.Directory]::EnumerateDirectories($root, '*session_*', 'AllDirectories')) {
    $log = $null
    $mtime = [DateTime]::MinValue
    foreach ($name in @($FNAME_LEDGER, $FNAME_MESSAGES)) {
      $p = Join-Path $dir $name
      if (!(Test-Path -LiteralPath $p)) { continue }
      try { $t = [System.IO.File]::GetLastWriteTimeUtc($p) } catch { continue }
      if ($t -gt $mtime) { $mtime = $t; $log = $p }
    }
    if (-not $log) { continue }
    $id = Get-SessionIdFromDir $dir
    $groups[$id] = @{ Id = $id; Dir = $dir; Log = $log; MTime = $mtime }
  }
  return $groups
}

# 读日志开头，找第一条 user 消息（标题来源）。
#
# 不是"第一行"：压缩过的会话（session compaction）第一行是
# role=compactionSummary 或 role=custom，不是 user 消息。所以要往下扫。
#
# user 消息的正文前面挂着一整块 <system-reminder>（agent-context 注入），
# 把它剥掉，剩下的才是用户真正说的第一句话。
function Get-SessionTitle($file) {
  if (-not $file) { return '' }
  if ($script:sessionTitleCache.ContainsKey($file)) { return $script:sessionTitleCache[$file] }
  $title = ''
  try {
    $fs = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      # 开头 64 KB。user 消息带一张 base64 截图时能到几百 KB，读太多会把
      # 内存吃穿；扫不到就当没有标题，不影响其余功能。
      $cap = 64 * 1024
      $len = [Math]::Min($cap, $fs.Length)
      $buf = New-Object byte[] $len
      $read = 0
      while ($read -lt $len) {
        $n = $fs.Read($buf, $read, $len - $read)
        if ($n -le 0) { break }
        $read += $n
      }
      $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
      $assistantFallback = ''
      foreach ($raw in ($text -split "`n")) {
        $line = $raw.TrimEnd("`r")
        if (-not $line -or $line.Length -le 10) { continue }
        $msg = $null
        try { $msg = $line | ConvertFrom-Json } catch { continue }
        $m = $msg.message
        if (-not $m) { continue }
        $role = [string]$m.role
        $t = ''
        foreach ($c in @($m.content)) {
          if ($c.type -eq 'text' -and $c.text) { $t = [string]$c.text; break }
        }
        if (-not $t) { continue }
        # 剥掉注入块，剩下的才是用户说的话
        $t = $t -replace '(?s)<system-reminder>.*?</system-reminder>', ''
        $t = ($t -replace '\s+', ' ').Trim()
        if (-not $t) { continue }
        if ($role -eq $S_USER) { $title = $t; break }
        # 兜底：被压缩过的会话（compaction）里，原始提问已经被
        # compactionSummary 替换掉了，真实标题取不回来。agent 的第一句
        # 话至少能说明这个会话在干什么。
        if (-not $assistantFallback -and $role -eq $S_ASSISTANT) { $assistantFallback = $t }
      }
      if (-not $title) { $title = $assistantFallback }
    } finally {
      $fs.Close()
    }
  } catch {
    $title = ''
  }
  if ($title.Length -gt 40) { $title = $title.Substring(0, 40) + '…' }
  $script:sessionTitleCache[$file] = $title
  return $title
}

# 这个 session 现在是"运行中"还是"待回复"。
#
#   running  agent 还在干：toolCall / toolResult / thinking / 用户刚说完
#   waiting  agent 停了，在等用户：它说完了，或者它在提问（ask_user）
#
# ask_user 归到 waiting：球在用户这边，agent 在等答案。
function Get-SessionPhase($msg) {
  if (-not $msg) { return 'running' }
  $m = $msg.message
  if (-not $m) {
    # ledger 事件格式：{kind, phase, action, ...}
    $kind = [string]$msg.kind
    if ($kind -eq $S_TOOLRESULT) { return 'running' }
    if ($kind -eq 'toolCall' -or $kind -eq $S_TOOLCALL) {
      if (Test-IsAskUser ([string]$msg.toolName)) { return 'waiting' }
      return 'running'
    }
    return 'running'
  }
  $role = [string]$m.role
  if ($role -eq $S_USER) { return 'running' }      # 用户刚说完，agent 要动
  if ($role -eq $S_TOOLRESULT) { return 'running' }
  if ($role -eq $S_ASSISTANT) {
    foreach ($c in @($m.content)) {
      if ($c.type -eq $S_TOOLCALL) {
        if (Test-IsAskUser ([string]$c.name)) { return 'waiting' }
        return 'running'
      }
    }
    return 'waiting'                              # assistant 纯文本 = 说完了
  }
  return 'running'
}

# 消掉一个 session（用户点了）。
# 记下被点掉时的 cycle：同一个 cycle 内不会再冒出来；agent 跑完一轮再
# 开始（waiting -> running）算新的一轮，那时它可以重新进来。
function Remove-TrackedSession($id) {
  $entry = $script:trackedSessions[$id]
  if ($entry) {
    # 记下消掉时它是什么状态：只有"它跑完一轮又开始了"才该重新出现。
    # 消掉的时候正在跑 -> 继续跑的过程中不该冒出来。
    $script:dismissedSessions[$id] = @{ Cycle = $entry.Cycle; Phase = $entry.Phase }
    $script:trackedSessions.Remove($id)
    $script:sessionsDirty = $true
    return $true
  }
  return $false
}

# 消费用户点掉的信号。
#
# 复用插件里已有的 show.signal 模式：widget 建一个文件，detector 看到就
# 处理。ack.signal 里写要消掉的 session id。
function Read-AckSignal {
  $ackFile = Join-Path $configDir 'ack.signal'
  if (!(Test-Path -LiteralPath $ackFile)) { return $null }
  $id = $null
  try { $id = (Get-Content -LiteralPath $ackFile -Raw -Encoding UTF8) } catch { $id = $null }
  try { Remove-Item -LiteralPath $ackFile -Force -ErrorAction SilentlyContinue } catch {}
  if ($id) { return $id.Trim() }
  return $null
}

# 每轮更新一次 session 列表。
function Update-SessionTracker {
  # 用户点掉的先消化掉
  $acked = Read-AckSignal
  if ($acked) {
    if (Remove-TrackedSession $acked) { Log-Line "session ack: $acked" }
  }

  $groups = Get-SessionLogGroups $sessionsRoot
  $now = [DateTime]::UtcNow

  foreach ($id in @($groups.Keys)) {
    $g = $groups[$id]
    $entry = $script:trackedSessions[$id]
    if ($entry -and $entry.MTime -eq $g.MTime) { continue }   # 没变就不用重读

    $msg = Get-LastJsonLine $g.Log
    if (-not $msg) { continue }
    $phase = Get-SessionPhase $msg

    if (-not $entry) {
      # 新 session：只有"刚动过"才进列表。
      #
      # 活动与否看日志 mtime，不看最后一条消息的类型——一个几周前卡在
      # toolCall 上的老对话，最后一条仍然是 toolCall，消息类型说它
      # "在跑"，它其实早就不动了。
      $ageMs = ($now - $g.MTime).TotalMilliseconds
      if ($ageMs -gt $script:ACTIVE_WINDOW_MS) { continue }

      $cycle = 1
      if ($script:dismissedSessions.ContainsKey($id)) {
        $d = $script:dismissedSessions[$id]
        # 被点掉过。上次看到它是"待回复"，现在又"运行中" -> 它跑完了一轮
        # 又开始，是新的一轮，可以重新进来。
        if ($d.Phase -eq 'waiting' -and $phase -eq 'running') {
          $cycle = $d.Cycle + 1
          $script:dismissedSessions.Remove($id)
          $script:sessionsDirty = $true
        } else {
          # 还没到新一轮：只更新它现在的状态，等它"待回复 -> 运行中"的那
          # 一次转换时再放回来。
          $d.Phase = $phase
          continue
        }
      }
      $script:trackedSessions[$id] = @{
        Id = $id
        Title = (Get-SessionTitle $g.Log)
        Phase = $phase
        Cycle = $cycle
        MTime = $g.MTime
        SinceMs = [int64]([DateTimeOffset]::new($g.MTime).ToUnixTimeMilliseconds())
        Dir = $g.Dir
      }
      $script:sessionsDirty = $true
      Log-Line "session tracked: $id ($phase)"
      continue
    }

    # 已跟踪的：状态变了就更新
    if ($entry.Phase -eq 'waiting' -and $phase -eq 'running') {
      # 一轮结束了，agent 又开始 -> 新的一轮，之前被点掉的约束失效
      $entry.Cycle = $entry.Cycle + 1
      if ($script:dismissedSessions.ContainsKey($id)) {
        $script:dismissedSessions.Remove($id)
      }
      $script:sessionsDirty = $true
      Log-Line "session restarted: $id (cycle $($entry.Cycle))"
    }
    if ($entry.Phase -ne $phase) { $script:sessionsDirty = $true }
    $entry.Phase = $phase
    $entry.MTime = $g.MTime
    if (-not $entry.Title) { $entry.Title = (Get-SessionTitle $g.Log) }
  }
}

# 写 sessions.json。
#
# 只有 detector 写这个文件，所以不存在 agent 侧整份覆盖把它抹掉的问题。
# 但它和 status.json 在同一个目录、同一台机器上，用同一把锁写，免得两个
# 进程同时动这个目录。
function Write-SessionsFile {
  param([switch]$Force)
  if (-not $Force -and -not $script:sessionsDirty) { return }
  $items = @()
  foreach ($id in @($script:trackedSessions.Keys)) {
    $e = $script:trackedSessions[$id]
    $items += [PSCustomObject]@{
      id = $e.Id
      title = $e.Title
      phase = $e.Phase
      sinceMs = $e.SinceMs
      cycle = $e.Cycle
    }
  }
  $payload = [PSCustomObject]@{
    sessions = $items
    dismissed = $script:dismissedSessions
    ts = (Get-Date).ToString('o')
  }
  $lock = Enter-StatusLock
  try {
    $file = Join-Path $configDir 'sessions.json'
    $json = $payload | ConvertTo-Json -Compress -Depth 6
    $tmp = "$file.tmp"
    [System.IO.File]::WriteAllText($tmp, $json, [System.Text.Encoding]::UTF8)
    Move-Item -Path $tmp -Destination $file -Force
    $script:sessionsDirty = $false
  } catch {
    Log-Line "SESSIONS WRITE FAIL: $($_.Exception.Message)"
  } finally {
    Exit-StatusLock $lock
  }
}

# detector 启动时把列表读回来（detector 重启不能把用户的"待回复"清零）。
function Restore-SessionTracker {
  $file = Join-Path $configDir 'sessions.json'
  if (!(Test-Path -LiteralPath $file)) { return }
  try {
    $j = [System.IO.File]::ReadAllText($file) | ConvertFrom-Json
    foreach ($s in @($j.sessions)) {
      if (-not $s.id) { continue }
      $script:trackedSessions[$s.id] = @{
        Id = $s.id
        Title = [string]$s.title
        Phase = [string]$s.phase
        Cycle = $(if ($s.cycle) { [int]$s.cycle } else { 1 })
        MTime = [DateTime]::MinValue
        SinceMs = [int64]$s.sinceMs
        Dir = ''
      }
    }
    if ($j.dismissed) {
      foreach ($p in $j.dismissed.PSObject.Properties) {
        $v = $p.Value
        # 老格式是一个整数（cycle）。当成"消掉时正在跑"，于是它要等
        # 跑完一轮又开始才回来。
        if ($v -is [int] -or $v -is [long] -or $v -is [double]) {
          $v = @{ Cycle = [int]$v; Phase = 'running' }
        }
        $script:dismissedSessions[$p.Name] = $v
      }
    }
    Log-Line ("sessions restored: " + $script:trackedSessions.Count)
  } catch {
    Log-Line "SESSIONS RESTORE FAIL: $($_.Exception.Message)"
  }
}

# 启动补录：把最近还在动的 session 收进来。
#
# 只在 detector 启动时跑一次。运行期完全靠状态机。
#
# 为什么需要它：detector 经常重启（per-tick guard、autostart、崩溃）。如果
# 只靠"看到它从 running 变成 waiting"这个转换，那么一个在 detector 重启
# 之前刚说完话的 session 就永远等不到那次转换，用户永远看不到它的"待回复"。
# 这个窗口是唯一一处还看时间的地方——30 分钟不算"很久没用"，而且运行期
# 不再依赖它。
function Seed-SessionTracker {
  $groups = Get-SessionLogGroups $sessionsRoot
  $now = [DateTime]::UtcNow
  $activeCut = $now.AddMilliseconds(-1 * $script:ACTIVE_WINDOW_MS)
  $seedCut = $now.AddMilliseconds(-1 * $script:SEED_WINDOW_MS)
  foreach ($id in @($groups.Keys)) {
    $g = $groups[$id]
    # trackedSessions 是 [ordered]@{}（OrderedDictionary），它没有
    # ContainsKey，只有 Contains。写成 ContainsKey 会在这里抛
    # "OrderedDictionary 不包含名为 ContainsKey 的方法"，把整个补录
    # 堵掉 —— 症状是列表只剩恢复回来的那几条。
    if ($script:trackedSessions.Contains($id)) { continue }
    if ($script:dismissedSessions.ContainsKey($id)) { continue }

    $msg = Get-LastJsonLine $g.Log
    if (-not $msg) { continue }
    $phase = Get-SessionPhase $msg

    # 两种补录：
    #   - 刚动过（60 秒内）：它此刻真的在跑
    #   - 说完在等你（30 分钟内，且最后一条是 agent 收尾）：detector
    #     重启前它刚说完，那次"从运行中变成待回复"的转换我们没看见，
    #     不补录的话这个"待回复"就永远等不到了
    $isActive = ($g.MTime -ge $activeCut)
    $isFinishedWaiting = ($g.MTime -ge $seedCut) -and ($phase -eq 'waiting')
    if (-not $isActive -and -not $isFinishedWaiting) { continue }

    $script:trackedSessions[$id] = @{
      Id = $id
      Title = (Get-SessionTitle $g.Log)
      Phase = $phase
      Cycle = 1
      MTime = $g.MTime
      SinceMs = [int64]([DateTimeOffset]::new($g.MTime).ToUnixTimeMilliseconds())
      Dir = $g.Dir
    }
    $script:sessionsDirty = $true
    Log-Line "session seeded: $id ($phase)"
  }
}
